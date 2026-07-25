#!/usr/bin/env node
// tools/scan-failopen.mjs — "the gate must not fail open" regression gate.
//
// A test that SKIPS when something is missing looks identical, in CI output, to
// a test that PASSES. This project has been bitten twice:
//   • `build-verify` ran `python3 -m pytest` on a box with no pytest → the whole
//     250-test companion suite vanished and the gate still printed a pass.
//   • Four tests-js files did `catch (e) { console.log('SKIP…'); process.exit(0) }`
//     around a require() of the first-party imf_direct_engine — a syntax error
//     in the engine would have deleted 76 assertions silently.
// Both are the same defect: an absent check reported as a satisfied one.
//
// This gate fails the build when a test file swallows an error and then exits
// successfully, or when an npm script neutralises its own exit code.
//
// Genuinely-optional dependencies (an unbundled WASM asset, a jpeg2000-capable
// ffmpeg) are real skip conditions. Mark those explicitly:
//     // fail-open-ok: openjphjs is a build-time asset, absent in a fresh checkout
// An annotation on the catch line, or on either of the two lines above it, is
// honoured — the point is that the skip is a deliberate, reviewed decision and
// not an accident. Prefer node:test's `{ skip: reason }`, which still reports.
//
// Run: node tools/scan-failopen.mjs            (report)
//      node tools/scan-failopen.mjs --gate     (CI: exit 1 on any finding)
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TEST_DIRS = ['tests-js', 'test'].map(d => join(ROOT, d)).filter(existsSync);
const GATE = process.argv.includes('--gate');

const ANNOTATION = /fail-open-ok/;

// Does this catch block swallow the error and report success? `process.exit(0)`
// is unambiguous. A bare `return` only counts when the block also announces a
// skip — plenty of catch blocks legitimately return a fallback value, and
// flagging those would make the gate noise rather than signal.
//
// `annotation` is the text immediately preceding the catch (see catchBlocks); it
// is checked separately from `body` on purpose. Folding it into the body text
// would let one catch's code decide the next catch's verdict.
export function isFailOpenCatch(body, { annotation = '' } = {}) {
  const b = String(body || '');
  if (ANNOTATION.test(b) || ANNOTATION.test(String(annotation))) return false;
  if (/process\.exit\s*\(\s*0\s*\)/.test(b)) return true;
  return /\bSKIP\b/i.test(b) && /\breturn\b/.test(b);
}

// An npm script that discards its own failure — `|| true`, `; true`, `|| exit 0`.
// `|| exit 1` is the correct form and must not be flagged.
export function isFailOpenScript(cmd) {
  return /\|\|\s*(true|:)\b|;\s*true\s*$|\|\|\s*exit\s+0\b/.test(String(cmd || ''));
}

// Extract each `catch (…) { … }` as { line, body, annotation }, where
// `annotation` is the two source lines above the catch — enough for a
// `// fail-open-ok:` comment placed above the try or the catch. Brace matching
// is naive about braces inside strings/regex, but catch bodies in test files
// are small and this only decides *what text to inspect*, never severity.
export function catchBlocks(src) {
  const out = [];
  const re = /\bcatch\b\s*(?:\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1, i = re.lastIndex;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    const before = src.slice(0, m.index).split('\n');
    out.push({
      line: before.length,
      body: src.slice(m.index, i),
      annotation: before.slice(Math.max(0, before.length - 3)).join('\n'),
    });
  }
  return out;
}

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n); const s = statSync(p);
    if (s.isDirectory()) { if (n !== 'node_modules') walk(p, out); }
    else if (n.endsWith('.mjs') || n.endsWith('.js')) out.push(p);
  }
  return out;
}

// CLI entry — skipped when imported (e.g. by the gate's unit tests).
if (process.argv[1]?.endsWith('scan-failopen.mjs')) {
  const found = [];

  for (const dir of TEST_DIRS) {
    for (const f of walk(dir)) {
      const src = readFileSync(f, 'utf8');
      for (const { line, body, annotation } of catchBlocks(src)) {
        if (isFailOpenCatch(body, { annotation })) {
          found.push(`${relative(ROOT, f)}:${line}  catch swallows the error and exits/returns success`);
        }
      }
    }
  }

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
    if (isFailOpenScript(cmd)) found.push(`package.json  scripts.${name} discards its own exit code`);
  }

  for (const h of found) console.log('  ' + h);
  if (GATE) {
    if (found.length) {
      console.error(`\n✗ FAIL-OPEN GATE: ${found.length} check(s) can pass while not actually running.`);
      console.error('  Fail loudly (exit 1) for first-party breakage, or annotate a genuine');
      console.error('  optional dependency with `// fail-open-ok: <reason>`.');
      process.exit(1);
    }
    console.log('✓ Fail-open gate clean — no test or script reports success on a skipped check.');
  } else {
    console.log(`\n${found.length} fail-open site(s) found.`);
  }
}
