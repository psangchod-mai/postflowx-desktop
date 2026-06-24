#!/usr/bin/env node
// watch.js — PostFlowX auto-rebuild watcher
//
// Modes:
//   node watch.js            → watch src/ → rebuild renderer only (fast, ~2s)
//   node watch.js --app      → watch src/ + electron/ → rebuild renderer + repackage .app
//   node watch.js --ext      → watch src/ → rebuild Chrome extension
//
// Usage:
//   npm run watch            → renderer watch (use with npm run dev in separate terminal)
//   npm run watch:app        → full .app rebuild on every change (slow ~30–60s)
//   npm run watch:ext        → extension watch

'use strict';

const fs    = require('fs');
const path  = require('path');
const { execSync, spawn } = require('child_process');

const ROOT   = __dirname;
const ARGS   = process.argv.slice(2);
const MODE   = ARGS.includes('--app') ? 'app'
             : ARGS.includes('--ext') ? 'ext'
             : 'renderer';

// ── Colors ───────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
};

function log(color, tag, msg) {
  const time = new Date().toLocaleTimeString('en-GB');
  console.log(`${C.dim}${time}${C.reset} ${color}[${tag}]${C.reset} ${msg}`);
}

// ── Watch targets ─────────────────────────────────────────────────────────────
const WATCH_DIRS = MODE === 'ext'
  ? ['src', 'extension']
  : MODE === 'app'
  ? ['src', 'electron']
  : ['src'];

// ── Build commands ────────────────────────────────────────────────────────────
function buildRenderer() {
  log(C.cyan, 'BUILD', 'Building renderer…');
  try {
    execSync('node build-renderer.js --target desktop', { cwd: ROOT, stdio: 'inherit' });
    log(C.green, 'DONE', 'Renderer built ✓');
    return true;
  } catch (e) {
    log(C.red, 'ERROR', 'Renderer build failed');
    return false;
  }
}

function buildExtension() {
  log(C.cyan, 'BUILD', 'Building extension…');
  try {
    execSync('node build-renderer.js --target extension', { cwd: ROOT, stdio: 'inherit' });
    log(C.green, 'DONE', 'Extension built ✓  →  dist/extension/');
    return true;
  } catch (e) {
    log(C.red, 'ERROR', 'Extension build failed');
    return false;
  }
}

function buildApp() {
  log(C.yellow, 'PACKAGE', 'Packaging .app (this takes ~30–60s)…');
  try {
    execSync(
      'CSC_IDENTITY_AUTO_DISCOVERY=false electron-builder --mac dir -c.mac.identity=null -c.mac.notarize=false',
      { cwd: ROOT, stdio: 'inherit' }
    );
    log(C.green, 'DONE', '.app packaged ✓  →  dist/mac-arm64/PostFlowX.app');
    return true;
  } catch (e) {
    log(C.red, 'ERROR', '.app packaging failed');
    return false;
  }
}

// ── Debounced rebuild ─────────────────────────────────────────────────────────
let _timer   = null;
let _pending = new Set();
let _building = false;

function scheduleRebuild(filePath) {
  _pending.add(filePath);
  clearTimeout(_timer);
  _timer = setTimeout(runBuild, 400);
}

async function runBuild() {
  if (_building) { _timer = setTimeout(runBuild, 500); return; }
  _building = true;

  const files = [..._pending];
  _pending.clear();

  const isElectronChange = files.some(f => f.includes(`${path.sep}electron${path.sep}`));
  const shortNames = files.slice(0, 3).map(f => path.relative(ROOT, f)).join(', ');
  const suffix = files.length > 3 ? ` +${files.length - 3} more` : '';
  log(C.cyan, 'CHANGE', `${shortNames}${suffix}`);

  if (MODE === 'ext') {
    buildExtension();
  } else if (MODE === 'app') {
    const ok = buildRenderer();
    if (ok) buildApp();
    if (isElectronChange) {
      log(C.yellow, 'NOTE', 'electron/ changed — restart the app to pick up main-process changes');
    }
  } else {
    // renderer mode
    buildRenderer();
    if (isElectronChange) {
      log(C.yellow, 'NOTE', 'electron/ changed — restart Electron to pick up main-process changes');
    } else {
      log(C.dim, 'TIP', 'Press Cmd+R in the app window to reload (or use npm run dev)');
    }
  }

  _building = false;
}

// ── Recursive watcher (Node built-in, no deps) ────────────────────────────────
const IGNORE = new Set(['.git', 'node_modules', 'dist', '__pycache__', '.DS_Store']);

function watchDir(dir) {
  const abs = path.resolve(ROOT, dir);
  if (!fs.existsSync(abs)) {
    log(C.red, 'WARN', `Watch dir not found: ${dir}`);
    return;
  }

  fs.watch(abs, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const parts = filename.split(path.sep);
    if (parts.some(p => IGNORE.has(p))) return;
    if (/\.(swp|swo|tmp|log)$/.test(filename)) return;
    scheduleRebuild(path.join(abs, filename));
  });

  log(C.dim, 'WATCH', `Watching ${dir}/`);
}

// ── Initial build + start watching ───────────────────────────────────────────
console.log(`\n${C.bold}PostFlowX watch${C.reset} — mode: ${C.cyan}${MODE}${C.reset}\n`);

if (MODE === 'ext') {
  buildExtension();
} else {
  buildRenderer();
}

WATCH_DIRS.forEach(watchDir);

log(C.green, 'READY', `Watching for changes… (Ctrl+C to stop)\n`);

process.on('SIGINT', () => {
  console.log('\nStopped.');
  process.exit(0);
});
