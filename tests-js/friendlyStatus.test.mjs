// ─────────────────────────────────────────────────────────────────────────────
// Panel status lines must not show raw exception text.
//
// errorBanner.js already closed the banner path: showError() humanizes at the
// display boundary, so nothing reaches the banner unrewritten. The panel status
// lines were never covered, and fifteen call sites across three files build
// their text as `Something failed: ${e?.message || e}` — which puts ENOENT,
// EACCES, EPERM, "TypeError: Cannot read properties of undefined" and bare HTTP
// codes in front of an editor who has no way to act on any of them.
//
// ── Why friendlyStatus and not friendlyText ──────────────────────────────────
//
// The obvious fix is to copy errorBanner's humanize() verbatim. It is wrong
// here. friendlyText() rewrites the WHOLE string, so
//
//   "Delete failed: EPERM: operation not permitted"
//     → "PostFlowX doesn't have permission to open that location. …"
//
// and "Delete failed" is gone. A banner can afford that — it has a title and an
// icon. A status line is one unlabelled row of text, and the prefix is the only
// thing on screen naming the operation. friendlyStatus holds the label back and
// rewrites only the tail, so the user learns both what broke and why.
//
// ── What is gated ────────────────────────────────────────────────────────────
//
// Shrink-only. Every file in src/ that pastes exception text into a status
// setter must route its status boundary through friendlyStatus, or be named in
// UNROUTED with a reason and counted against a hard bound. The bound is a
// literal so that raising it is an edit somebody has to justify in this file.
//
// ── What this cannot see ─────────────────────────────────────────────────────
//
//  - toast() and any other display surface. One raw-error toast site remains
//    (amf_convert.js) and is not covered by this gate.
//  - Whether a rewrite is any good. Presence of a rule is not quality of one.
//  - Status text assembled several statements before the setter call; the scan
//    is line-based, so `const m = 'X: ' + e.message; setStatus(m)` reads clean.
//    Those still get rewritten at the boundary — the scan just cannot count them.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

import { friendlyStatus, friendlyText } from '../src/scripts/core/friendlyError.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// A status setter call on the same line as an interpolated exception field.
const STATUS_CALL = /\b_?[sS]et[sS]tatus\s*\(/;
const RAW_ERR = /\b(?:e|err|ex|error|first)\s*\??\.\s*(?:message|code)\b/;
// The boundary itself must consult the rewriter.
const ROUTED = /\bfriendlyStatus\s*\(/;

// Files that show raw exception text and do NOT route it. Each entry is debt,
// not an exemption — the reason has to say why it is still here.
const UNROUTED = [
  // Six separate ad-hoc setStatus closures, two of which are the offenders, in
  // a file with 824 uncommitted lines of the user's in-flight work. Routing it
  // means touching all six or picking one arbitrarily; deferred deliberately
  // rather than half-done.
  'src/scripts/prep_mark.js',
];
const MAX_UNROUTED = 1;

/** Blank out comments so a doc comment illustrating the bug does not read as the bug. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, ''));
}

/** Every src/ JS file that pastes exception text into a status setter → site count. */
function scanRawStatusSites(root) {
  const found = new Map();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) { walk(abs); continue; }
      if (!name.endsWith('.js')) continue;
      const lines = stripComments(readFileSync(abs, 'utf8'));
      const n = lines.filter((l) => STATUS_CALL.test(l) && RAW_ERR.test(l)).length;
      if (n) found.set(relative(root, abs).split(sep).join('/'), n);
    }
  };
  walk(join(root, 'src'));
  return found;
}

/**
 * Body of a top-level function, header line through the first column-0 `}`.
 * Returning the whole file would make every assertion below pass on a file that
 * merely mentions friendlyStatus somewhere, which is the vacuous version of
 * this test.
 */
function functionBody(src, header) {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.startsWith(header));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i] === '}') return lines.slice(start, i + 1).join('\n');
  }
  return null;
}

const SITES = scanRawStatusSites(ROOT);

// ── the rewriter ─────────────────────────────────────────────────────────────

test('a labelled error keeps its label and loses its jargon', () => {
  const before = 'Delete failed: EPERM: operation not permitted';
  const after = friendlyStatus(before);
  assert.notEqual(after, before, 'the raw EPERM text was left on screen');
  assert.ok(after.startsWith('Delete failed: '), `the operation label was dropped: ${JSON.stringify(after)}`);
  assert.equal(/EPERM/.test(after), false, `jargon survived the rewrite: ${JSON.stringify(after)}`);
});

test('friendlyStatus is not just friendlyText', () => {
  // The whole reason this function exists. If these two ever agree on a
  // labelled string, the prefix-preserving branch has stopped running and the
  // gate below is measuring nothing.
  const s = 'Relink failed: EACCES: permission denied';
  assert.notEqual(
    friendlyStatus(s),
    friendlyText(s),
    'friendlyStatus now behaves like friendlyText — the label is being discarded again',
  );
  assert.equal(friendlyText(s).startsWith('Relink failed'), false, 'friendlyText unexpectedly preserves the prefix');
});

test('every kind of raw exception the call sites produce gets rewritten', () => {
  // Harvested from the real call sites, not invented. Each is what the user
  // actually reads today.
  const cases = [
    'Rescan failed: ENOENT: no such file or directory, open /Volumes/OCF/A001.ari',
    'Relink OCF failed: EACCES: permission denied',
    'EXR export error: ENOSPC: no space left on device',
    'QT capture failed: Operation timed out after 30000ms',
    'Load failed: TypeError: Cannot read properties of undefined (reading \'cpl\')',
    'Review proxy error (sh010): Request failed with status 403 Forbidden',
  ];
  for (const s of cases) {
    const out = friendlyStatus(s);
    assert.notEqual(out, s, `left unrewritten: ${JSON.stringify(s)}`);
    assert.ok(out.startsWith(s.split(':')[0]), `label lost on: ${JSON.stringify(s)} → ${JSON.stringify(out)}`);
  }
});

test('a bare error code is rewritten whole, not left as a heading', () => {
  // The label group requires a phrase (two words) on purpose. Without that,
  // "ENOENT" would be read as the operation name and the jargon this exists to
  // remove would stay on screen as a heading.
  const out = friendlyStatus('ENOENT: no such file or directory, open /Volumes/X/a.mxf');
  assert.equal(out.startsWith('ENOENT'), false, `the error code was treated as an operation label: ${JSON.stringify(out)}`);
  assert.ok(/found/i.test(out), `not rewritten at all: ${JSON.stringify(out)}`);
});

test('progress and success lines pass through byte-identical', () => {
  // A detector that always fires reports "no problem" just as wrongly as one
  // that never does. These are real status strings from the two wired files.
  const untouched = [
    'Ready',
    'Proxy deleted.',
    'Relinked: plate_sh010_v002.ari',
    'Visual match: scanning 4/57…',
    'Visual match: reading reference frame…',
    'Parsing IMF package…',
    'Blocked: QC error',
    'Scan a VFX folder first.',
    '',
  ];
  for (const s of untouched) {
    assert.equal(friendlyStatus(s), s, `a good status line was mangled: ${JSON.stringify(s)}`);
  }
});

test('friendlyStatus survives whatever a caller hands it', () => {
  assert.equal(friendlyStatus(null), '');
  assert.equal(friendlyStatus(undefined), '');
  assert.equal(typeof friendlyStatus(new Error('EACCES: denied')), 'string');
  assert.equal(friendlyStatus('   '), '   ', 'whitespace-only is not an error and must not become a message');
});

// ── the scan has to work before what it reports means anything ───────────────

test('the scan finds the call sites it is meant to guard', () => {
  assert.ok(SITES.size >= 3, `only ${SITES.size} file(s) matched — the walk or the pattern is broken, not the code`);
  const total = [...SITES.values()].reduce((a, b) => a + b, 0);
  assert.ok(total >= 15, `only ${total} raw-error status sites found; 15 were measured — the detector regressed`);
  assert.equal(SITES.get('src/scripts/features/vfxPull/vfxPullPanel.js'), 9);
  assert.equal(SITES.get('src/scripts/modules/imf/imf_ui.js'), 4);
});

test('the scan ignores an example written in a comment', () => {
  // friendlyError.js documents the bug it fixes by quoting a call site. Without
  // comment stripping the fixer itself would be reported as an offender.
  assert.equal(SITES.has('src/scripts/core/friendlyError.js'), false,
    'a doc comment is being counted as a call site — stripComments regressed');
});

test('the boundary extractor returns a boundary, not a file', () => {
  const src = readFileSync(join(ROOT, 'src/scripts/modules/imf/imf_ui.js'), 'utf8');
  const body = functionBody(src, 'function setStatus(');
  assert.ok(body, 'setStatus was not found in imf_ui.js — the extractor or the function name changed');
  assert.ok(body.includes('imf-status'), 'the extractor grabbed the wrong function');
  assert.ok(body.split('\n').length < 20, `the extractor ran past the function end (${body.split('\n').length} lines)`);
  assert.equal(functionBody(src, 'function thisDoesNotExist('), null, 'a missing function must return null, not the file');
});

// ── the gate ─────────────────────────────────────────────────────────────────

test('every status boundary that shows exception text routes through friendlyStatus', () => {
  const offenders = [];
  for (const [path] of SITES) {
    if (UNROUTED.includes(path)) continue;
    const src = readFileSync(join(ROOT, path), 'utf8');
    if (!ROUTED.test(src)) { offenders.push(`${path} — does not call friendlyStatus at all`); }
  }
  assert.deepEqual(
    offenders,
    [],
    `these files paste raw exception text into a status line with nothing rewriting it:\n  ${offenders.join('\n  ')}`,
  );
});

test('the two wired boundaries route at the boundary, not somewhere else in the file', () => {
  // Importing friendlyStatus and using it anywhere would satisfy the test
  // above. What matters is that the ONE function every call site funnels
  // through is the one that calls it.
  const boundaries = [
    ['src/scripts/features/vfxPull/vfxPullPanel.js', 'function _setStatus(', 'pmVfxPullStatus'],
    ['src/scripts/modules/imf/imf_ui.js', 'function setStatus(', 'imf-status'],
  ];
  for (const [path, header, marker] of boundaries) {
    const src = readFileSync(join(ROOT, path), 'utf8');
    const body = functionBody(src, header);
    assert.ok(body, `${path}: ${header}…) not found — was the boundary renamed?`);
    assert.ok(body.includes(marker), `${path}: extracted the wrong function`);
    assert.ok(ROUTED.test(body), `${path}: ${header}…) does not call friendlyStatus, so all its call sites are still raw`);
  }
});

test('the unrouted list does not outlive what it describes', () => {
  // An entry for a file that no longer shows raw exception text is a claim
  // about the code that stopped being true. Prune it rather than carrying it.
  for (const path of UNROUTED) {
    assert.ok(
      SITES.has(path),
      `${path} is listed as unrouted but has no raw-error status sites any more — remove the entry`,
    );
  }
});

test('the unrouted list is sorted, unique and only ever shrinks', () => {
  assert.deepEqual([...UNROUTED].sort(), UNROUTED, 'keep UNROUTED sorted so diffs read cleanly');
  assert.equal(new Set(UNROUTED).size, UNROUTED.length, 'duplicate entry in UNROUTED');
  assert.ok(
    UNROUTED.length <= MAX_UNROUTED,
    `${UNROUTED.length} unrouted file(s) vs a bound of ${MAX_UNROUTED}. This list is a debt register, not a ` +
    `parking lot — route the new file instead of raising the bound`,
  );
});
