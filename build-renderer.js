#!/usr/bin/env node
'use strict';

/**
 * build-renderer.js — Copies renderer source into dist/<target>/ and injects
 * the platform target token so the app knows whether it's running as the
 * desktop Electron app or the Chrome extension.
 *
 * Source layout:
 *   src/         → shared renderer source (index.html, scripts/, styles/, …)
 *   extension/   → Chrome extension-only files (manifest.json, background.js, …)
 *
 * Usage:
 *   node build-renderer.js --target desktop   (default)
 *   node build-renderer.js --target extension
 */

const fs   = require('fs');
const path = require('path');

const { resolveInherited } = require('./tools/authConfigInherit');

const ROOT = __dirname;
const SRC  = path.join(ROOT, 'src');
const EXT  = path.join(ROOT, 'extension');

// ── Parse args ────────────────────────────────────────────────────────────────

const args      = process.argv.slice(2);
const targetIdx = args.indexOf('--target');
const target    = targetIdx >= 0 ? args[targetIdx + 1] : 'desktop';

if (!['desktop', 'extension'].includes(target)) {
  console.error(`[build-renderer] Unknown target "${target}". Use --target desktop|extension`);
  process.exit(1);
}

const OUT = path.join(ROOT, 'dist', target);

// ── Build metadata ────────────────────────────────────────────────────────────

const pkg     = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version || '0.0.0';
const NOW     = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

// ── Clean output dir ──────────────────────────────────────────────────────────

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// ── Copy helpers ──────────────────────────────────────────────────────────────

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const child of fs.readdirSync(src)) {
      if (child === '.DS_Store' || child === '__pycache__' || child === 'node_modules') continue;
      copyRecursive(path.join(src, child), path.join(dest, child));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

// ── Shared renderer items (from src/) ────────────────────────────────────────

const SHARED_ITEMS = ['scripts', 'styles', 'lib', 'rules', 'sandbox', 'tools'];

for (const item of SHARED_ITEMS) {
  const src = path.join(SRC, item);
  if (!fs.existsSync(src)) { console.warn(`[build-renderer] skip missing: src/${item}`); continue; }
  copyRecursive(src, path.join(OUT, item));
}

// ── Bundled assets (must live inside the asar so relative 'assets/...' paths resolve) ──
// index.html / components reference assets via relative paths (icons, svg, json, ai
// tf.min.js, fonts, imf sandbox) — NOT getURL — so they 404 at boot unless bundled
// into the renderer tree. Copy ALL of assets/ EXCEPT the large native-only dirs
// (ffmpeg ~31M, ocr ~25M) which the renderer loads via getURL/worker ORIGIN from
// extraResources (Resources/assets), so they don't belong in the asar.
const ASSET_SKIP_DIRS = new Set(['ffmpeg', 'ocr']);
const assetsRoot = path.join(ROOT, 'assets');
if (fs.existsSync(assetsRoot)) {
  for (const entry of fs.readdirSync(assetsRoot, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    if (entry.isDirectory() && ASSET_SKIP_DIRS.has(entry.name)) continue;
    copyRecursive(path.join(assetsRoot, entry.name), path.join(OUT, 'assets', entry.name));
  }
} else {
  console.warn('[build-renderer] skip missing: assets/');
}

// ── Extension-only items (from extension/) ───────────────────────────────────

const EXTENSION_ITEMS = [
  'manifest.json',
  'background.js',
  'offscreen.html',
  'offscreen.js',
  'clean_feed.html',
  'clean_feed.js',
  'clean_feed_cutdiff.html',
  'clean_feed_cutdiff.js',
];

if (target === 'extension') {
  for (const item of EXTENSION_ITEMS) {
    const src = path.join(EXT, item);
    if (!fs.existsSync(src)) { console.warn(`[build-renderer] skip missing: extension/${item}`); continue; }
    copyRecursive(src, path.join(OUT, item));
  }
}

// ── Patch index.html — inject platform token ──────────────────────────────────

let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

const inject = [
  '<script>',
  `window.__PFX_TARGET__        = "${target}";`,
  `window.__PFX_BUILD_TIME__    = "${NOW}";`,
  `window.__PFX_BUILD_VERSION__ = "${VERSION}";`,
  '</script>',
].join('\n');

if (!html.includes('__PFX_TARGET__')) {
  html = html.replace('</head>', `${inject}\n</head>`);
} else {
  // Re-inject with current values (previous build was already patched)
  html = html.replace(
    /<script>\s*window\.__PFX_TARGET__[\s\S]*?<\/script>/,
    inject,
  );
}

// Fix asset paths for the bundled layout. In dev the page is src/index.html (repo
// root is one level up, so '../assets/…' is correct); in the build it's
// dist/desktop/index.html with assets as a sibling, so '../assets/' would resolve
// to dist/assets (404). Rewrite to the sibling 'assets/'.
html = html.replace(/(["'(])\.\.\/assets\//g, '$1assets/');

fs.writeFileSync(path.join(OUT, 'index.html'), html);

// ── Desktop: generate electron/generated/authConfig.generated.json ────────────
// Reads GOOGLE_DESKTOP_CLIENT_ID (or POSTFLOWX_GOOGLE_DESKTOP_CLIENT_ID) from
// the build environment and writes it into a file that electron-builder packages
// alongside electron/ipc.js.  This is the only way to get a build-time secret
// into the packaged Electron main process — process.env is the BUILD env, not
// the runtime env for a signed .app bundle.
//
// The generated file is git-ignored (electron/generated/).  It is regenerated
// on every `node build-renderer.js --target desktop` run.
// If no env var is set, values are INHERITED from whatever the last build baked
// in, then from electron/authConfig.local.json — they are not blanked. Writing ''
// here does not produce an unconfigured build, it erases a working one. See
// tools/authConfigInherit.js for what that cost. Only a value no source has ever
// supplied is written empty, and the app then shows a clear "not configured" UI.

/** Read a JSON file, or null if it is missing or unparseable. */
function tryReadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

if (target === 'desktop') {
  const generatedDir = path.join(ROOT, 'electron', 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });

  // Write .gitignore once so credentials are never accidentally committed.
  const gitignorePath = path.join(generatedDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '# Auto-generated — never commit credentials\n*\n!.gitignore\n');
  }

  // Both values below are written straight over authConfig.json, which ships as
  // Resources/authConfig.json — the only auth config the packaged main process
  // reads. Resolving them to '' when their env var is absent does not produce an
  // unconfigured build, it produces a build that erases a working one. That is
  // exactly how a package once shipped with postflowxAuthApiUrl:"" and told
  // every user "PostFlowX access policy service is not configured for this
  // build." after a plain `npm run build:renderer`. See tools/authConfigInherit.js.
  //
  // devAuthBypass below deliberately does NOT inherit — see that file.
  const priorResources = tryReadJson(path.join(ROOT, 'authConfig.json'));
  const localDevConfig = tryReadJson(path.join(ROOT, 'electron', 'authConfig.local.json'));

  const clientIdResolved = resolveInherited([
    { source: 'env:GOOGLE_DESKTOP_CLIENT_ID',           value: process.env.GOOGLE_DESKTOP_CLIENT_ID },
    { source: 'env:POSTFLOWX_GOOGLE_DESKTOP_CLIENT_ID', value: process.env.POSTFLOWX_GOOGLE_DESKTOP_CLIENT_ID },
    { source: 'authConfig.json',                        value: priorResources?.googleDesktopClientId },
    { source: 'electron/authConfig.local.json',         value: localDevConfig?.googleDesktopClientId },
  ]);
  const clientId = clientIdResolved.value;

  const apiUrlResolved = resolveInherited([
    { source: 'env:POSTFLOWX_AUTH_API_URL',     value: process.env.POSTFLOWX_AUTH_API_URL },
    { source: 'authConfig.json',                value: priorResources?.postflowxAuthApiUrl },
    { source: 'electron/authConfig.local.json', value: localDevConfig?.postflowxAuthApiUrl },
  ]);
  const apiUrl = apiUrlResolved.value;

  const configured = clientId.endsWith('.apps.googleusercontent.com');

  // Write baked-in config (inside asar, for fallback reads in main process).
  const bundledCfg = {
    googleDesktopClientId: clientId,
    postflowxAuthApiUrl:   apiUrl,
    generatedAt:           NOW,
    buildVersion:          VERSION,
  };
  fs.writeFileSync(
    path.join(generatedDir, 'authConfig.generated.json'),
    JSON.stringify(bundledCfg, null, 2) + '\n',
  );

  // Also write top-level authConfig.json — packaged via extraResources into
  // <app>/Contents/Resources/authConfig.json (readable as process.resourcesPath/authConfig.json).
  // This file is outside the asar so it can be replaced post-build without repacking.
  // In production CI: set GOOGLE_DESKTOP_CLIENT_ID before running build:mac.
  const resourcesCfg = {
    googleDesktopClientId: clientId,
    postflowxAuthApiUrl:   apiUrl,
    devAuthBypass:         false,
    generatedAt:           NOW,
    buildVersion:          VERSION,
  };
  fs.writeFileSync(
    path.join(ROOT, 'authConfig.json'),
    JSON.stringify(resourcesCfg, null, 2) + '\n',
  );

  if (configured) {
    const preview = clientId.slice(0, 8) + '...' + clientId.slice(-28);
    console.log(`[build-renderer] ✓ auth config: GOOGLE_DESKTOP_CLIENT_ID set (${preview})`);
  } else {
    console.warn('[build-renderer] ⚠  auth config: GOOGLE_DESKTOP_CLIENT_ID not set — Google login will be disabled in this build');
    console.warn('[build-renderer]    Set env var before building:');
    console.warn('[build-renderer]      GOOGLE_DESKTOP_CLIENT_ID="xxxx.apps.googleusercontent.com" node build-renderer.js --target desktop');
  }

  // Say out loud where the access-policy URL came from. When it is empty the
  // packaged app cannot check anyone's access at all, and the only symptom is a
  // red line on the login card — so the build must not report that as success.
  if (apiUrl) {
    console.log(`[build-renderer] ✓ access policy service: configured (source: ${apiUrlResolved.source})`);
  } else {
    console.warn('[build-renderer] ⚠  access policy service: NOT configured — every sign-in in this build will fail with');
    console.warn('[build-renderer]      "PostFlowX access policy service is not configured for this build."');
    console.warn('[build-renderer]    Set POSTFLOWX_AUTH_API_URL, or put postflowxAuthApiUrl in electron/authConfig.local.json.');
  }
}

// ── Done ──────────────────────────────────────────────────────────────────────

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1;
  }
  return n;
}

console.log(`[build-renderer] ✓ ${target} → dist/${target}/  (${countFiles(OUT)} files, v${VERSION}, ${NOW})`);
