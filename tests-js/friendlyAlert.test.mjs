// friendlyAlert — the modal error dialog, in plain language and with its label.
// Run: node tests-js/friendlyAlert.test.mjs
//
// Two halves. The first exercises the module. The second is a gate over the
// call sites it was written for, because a helper that nobody calls fixes
// nothing: the defect being removed here lives in the call sites, not in this
// file, and a test suite that only proves composeAlert() composes would stay
// green through a revert of every one of them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { composeAlert, friendlyAlert } from '../src/scripts/core/friendlyAlert.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ── The module ───────────────────────────────────────────────────────────────

test('the operation label survives, and leads', () => {
  // The whole point of the label: four of the converted sites used to show a
  // naked "EACCES: permission denied" with nothing saying what the user had
  // been doing. The label must be first, so it reads as a heading.
  const out = composeAlert(new Error('EACCES: permission denied'), 'Reviews CSV export failed');
  assert.ok(out.startsWith('Reviews CSV export failed'), `label must lead, got ${JSON.stringify(out)}`);
  assert.match(out, /permission/i, 'the translated message must still be there');
  assert.doesNotMatch(out, /EACCES/, 'the raw errno is for a support log, not a dialog');
});

test('a path and the advice that follows it do not share a line', () => {
  // This is the reason the module composes from parts instead of calling
  // friendlyText(). On a volume whose name contains spaces — which is most of
  // them in a post house — a space-joined hint is genuinely unreadable: you
  // cannot see where the path stops.
  const err = new Error("ENOENT: no such file or directory, open '/Volumes/SHOW DRIVE 01/a.ari'");
  const out = composeAlert(err, 'Rescan failed');

  const pathLine = out.split('\n').find((l) => l.includes('/Volumes/SHOW DRIVE 01/a.ari'));
  assert.ok(pathLine, `the path must survive somewhere, got ${JSON.stringify(out)}`);
  assert.equal(
    pathLine.trim(),
    '/Volumes/SHOW DRIVE 01/a.ari',
    'the path must be alone on its line — anything appended to it reads as part of the path',
  );
  assert.match(out, /drive is connected/i, 'and the hint must still be shown, just not glued on');
});

test('missing parts leave no blank paragraphs', () => {
  // A pass-through error has no hint. An unlabelled call has no label. Neither
  // may contribute an empty paragraph, or the dialog opens on whitespace.
  const noHint = composeAlert('Scan a VFX folder first.', 'Pull failed');
  assert.equal(noHint, 'Pull failed\n\nScan a VFX folder first.');

  const noLabel = composeAlert('Scan a VFX folder first.');
  assert.equal(noLabel, 'Scan a VFX folder first.');

  for (const s of [composeAlert(null), composeAlert(undefined, ''), composeAlert({}, '   ')]) {
    assert.doesNotMatch(s, /^\s|\n\s*\n\s*\n/, `no leading or doubled blank line, got ${JSON.stringify(s)}`);
    assert.ok(s.trim().length > 0, 'and never an empty dialog');
  }
});

test('friendlyAlert dispatches through globalThis.alert, looked up at call time', () => {
  // Looked up at call time, not captured at import: that is the only reason
  // this injection works, and the only reason the desktop and extension builds
  // can both hand it their own alert.
  const seen = [];
  const prev = globalThis.alert;
  globalThis.alert = (t) => seen.push(t);
  try {
    const returned = friendlyAlert(new Error('ENOSPC: no space left on device'), 'Export failed');
    assert.equal(seen.length, 1, 'exactly one dialog');
    assert.equal(seen[0], returned, 'and what it returns is what it showed');
    assert.match(seen[0], /^Export failed\n\n/);
    assert.match(seen[0], /disk is full/i);
  } finally {
    if (prev === undefined) delete globalThis.alert; else globalThis.alert = prev;
  }
});

test('with no alert available the text goes to the console, never nowhere', () => {
  const prevAlert = globalThis.alert;
  const prevErr = console.error;
  const logged = [];
  if (prevAlert !== undefined) delete globalThis.alert;
  console.error = (...a) => logged.push(a.join(' '));
  try {
    const returned = friendlyAlert(new Error('EACCES: denied'), 'Diagnostics failed');
    assert.equal(logged.length, 1, 'these are the app\'s loudest failures — silence is not an option');
    assert.match(logged[0], /Diagnostics failed/);
    assert.match(returned, /Diagnostics failed/);
  } finally {
    console.error = prevErr;
    if (prevAlert !== undefined) globalThis.alert = prevAlert;
  }
});

test('an alert that throws still returns the text', () => {
  const prev = globalThis.alert;
  const prevErr = console.error;
  globalThis.alert = () => { throw new Error('blocked by the embedder'); };
  console.error = () => {};
  try {
    const out = friendlyAlert(new Error('ETIMEDOUT'), 'Pull failed');
    assert.match(out, /^Pull failed\n\n/);
  } finally {
    console.error = prevErr;
    if (prev === undefined) delete globalThis.alert; else globalThis.alert = prev;
  }
});

// ── The call sites ───────────────────────────────────────────────────────────

// Every file converted in this pass, and how many friendlyAlert calls it should
// carry. The counts are here so that deleting a call site is a test failure and
// not a quiet regression — the same reason the save-cascade gate counts returns.
const CONVERTED = [
  ['src/scripts/features/vfxPull/vfxPullPanel.js', 1],
  // 4 from this pass, plus the one inside announceExport() — the reviews panel
  // has no status strip, so a failed export has nowhere to speak but a dialog.
  ['src/scripts/features/reviews/index.js', 5],
  ['src/scripts/modules/smart_engine_settings.js', 1],
  ['src/scripts/modules/imf/imf_package_ui.js', 1],
];

// What a raw-exception alert looks like, on the line it is written on. All
// seven originals were one-liners of one of these two shapes:
//   alert(`Proxy error: ${err.message}`)
//   alert(err?.message || String(err))
// Deliberately narrow. It must not fire on the plain-English alerts that stay
// in these files ("Decode Test Frame requires the PostFlowX Desktop app."),
// nor on vfxPullPanel's per-shot failure summary, which interpolates r.error
// for each of N shots and is not one exception to translate.
const RAW_IN_ALERT = /\.message\b|String\(\s*(?:err|e)\s*\)/;

test('no converted file still shows a user raw exception text in a dialog', () => {
  for (const [file, expected] of CONVERTED) {
    const src = read(file);

    assert.match(
      src,
      /import\s*\{[^}]*\bfriendlyAlert\b[^}]*\}\s*from\s*'[^']*core\/friendlyAlert\.js'/,
      `${file}: converted but does not import friendlyAlert`,
    );

    const calls = src.match(/\bfriendlyAlert\(/g) || [];
    assert.equal(
      calls.length, expected,
      `${file}: expected ${expected} friendlyAlert call(s), found ${calls.length} — `
      + 'if a site was legitimately added or removed, update this table',
    );

    const offenders = src
      .split('\n')
      .map((line, i) => [i + 1, line])
      .filter(([, line]) => /(?<!friendly)\balert\(/.test(line) && RAW_IN_ALERT.test(line));

    assert.deepEqual(
      offenders, [],
      `${file}: a dialog still carries raw exception text:\n`
      + offenders.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n')
      + '\nUse friendlyAlert(err, \'<what the user was doing> failed\') instead.',
    );
  }
});

test('every label passed at a call site names an operation, not an error class', () => {
  // A label is what the user was doing, so it has to read as a phrase. A
  // one-word label ("Error", "Failed") puts the dialog straight back where it
  // started: a box that says something broke and not what.
  let checked = 0;
  for (const [file] of CONVERTED) {
    const src = read(file);
    for (const m of src.matchAll(/\bfriendlyAlert\(\s*[^,)]+,\s*(['"])([^'"]*)\1/g)) {
      const label = m[2];
      checked++;
      assert.ok(
        /\s/.test(label.trim()) && label.trim().length >= 8,
        `${file}: label ${JSON.stringify(label)} is not an operation phrase`,
      );
      assert.match(label, /fail/i, `${file}: label ${JSON.stringify(label)} should say what failed`);
    }
  }
  assert.equal(checked, 7, `expected 7 labelled call sites across the converted files, saw ${checked}`);
});

test('friendlyError still exports the translate shim friendlyAlert depends on', () => {
  // friendlyAlert localises the label with friendlyError's own guarded shim
  // rather than a second copy. If that export is ever tidied away, the label
  // silently stops being translated while everything else keeps working —
  // exactly the kind of regression nothing else here would catch.
  const src = read('src/scripts/core/friendlyError.js');
  assert.match(src, /export\s*\{\s*_t\s+as\s+translate\s*\}/, 'friendlyError must export translate');
});
