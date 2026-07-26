// tests-js/visualQcStatus.test.mjs
// The Visual QC modal's progress strip is the only place its failures are
// reported.
//
// WHY THIS EXISTS
// There is no toast behind this strip and no dialog. When a scan or a PDF
// export throws, whatever lands in `.pfx-qc-progressTxt` is the entire message
// the user gets, and for a long time that was the exception's own `.message`:
//
//     setProgress(0, err?.message || String(err));
//
// which puts "ENOENT: no such file or directory, open /Vol/Show_A/A001.mov" or
// a bare "Failed to fetch" in front of a colourist. Both of those have a
// friendlyError rule — "That file or folder couldn't be found" / "PostFlowX
// couldn't reach the service it needed", each with a hint naming what to do —
// and neither was reached, because nothing routed the text through
// friendlyStatus. The rules existed; the two call sites did not use them.
//
// TWO THINGS HAD TO BE TRUE, NOT ONE
// friendlyStatus returns "message\nhint" for every rule that carries advice.
// `.pfx-qc-progressTxt` has exactly one CSS rule (`font-size:12px`), so
// `white-space` is `normal` and that break collapses — the hint would arrive
// welded to the end of the message. Routing through friendlyStatus without
// making the break renderable would have shipped a worse line than before, so
// this file checks both halves, and checks them against the real friendlyStatus
// output rather than a hand-written string that might not have a newline in it
// at all.
//
// The third half is the mirror: `onStatus` is a callback into the caller's own
// one-line status element, whose CSS this component does not own. That one gets
// the break flattened to a space instead.
//
// WHAT THIS CANNOT SEE
// - Whether `pre-line` actually renders as two lines. linkedom has no layout;
//   this asserts the property is set, not that a browser honoured it.
// - Whether the string that arrives has a friendlyError rule at all. This file
//   checks the routing only. Which exceptions the table recognises is pinned
//   separately, in friendlyErrorDomExceptions.test.mjs — that is where the
//   DOM's own errors ("NotAllowedError", tainted-canvas "SecurityError") were
//   given rules once this routing existed to carry them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { friendlyStatus } from '../src/scripts/core/friendlyError.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const read = (p) => readFileSync(ROOT + p, 'utf8');

const MODAL_PATH = 'src/scripts/components/visualQcModal/index.js';
const modal = read(MODAL_PATH);
const lines = modal.split('\n');

// ── The scan has to be finding something ─────────────────────────────────────

test('floor: the file still looks like the file this checks', () => {
  const calls = lines.filter((l) => /\bsetProgress\s*\(/.test(l));
  assert.ok(calls.length >= 12, `only ${calls.length} setProgress calls — did the modal change shape?`);
  assert.match(modal, /import \{ friendlyStatus \} from '\.\.\/\.\.\/core\/friendlyError\.js'/,
    'friendlyStatus is no longer imported');
});

// ── No raw exception may reach the strip ─────────────────────────────────────

test('no setProgress call hands a raw exception to the user', () => {
  // Constructs, not literals: any way of getting at the throwable's own text.
  // `err` is the name every catch in this file uses; a rename would show up as
  // the floor test above failing first.
  const raw = lines
    .map((l, i) => ({ n: i + 1, l: l.trim() }))
    .filter(({ l }) => /\bsetProgress\s*\(/.test(l))
    .filter(({ l }) => /\berr\s*\??\.\s*message\b|\bString\s*\(\s*err\s*\)/.test(l))
    .filter(({ l }) => !/\bfriendlyStatus\s*\(/.test(l))
    .map(({ n, l }) => `${MODAL_PATH}:${n}  ${l}`);
  assert.deepEqual(raw, [], `a raw exception is being shown in the progress strip again:\n  ${raw.join('\n  ')}`);
});

test('both failing operations say which operation failed', () => {
  // The prefix is the difference between "The disk is full" — which disk, doing
  // what? — and "Exporting the PDF report failed: The disk is full". Two of
  // them, one per button.
  const found = [...modal.matchAll(/friendlyStatus\(`([^`]*?):\s*\$\{/g)].map((m) => m[1]);
  assert.equal(found.length, 2, `expected 2 prefixed friendlyStatus calls, found ${found.length}: ${found.join(' | ')}`);
  assert.ok(found.includes('Visual QC scan failed'), `the Run button lost its prefix: ${found.join(' | ')}`);
  assert.ok(found.includes('Exporting the PDF report failed'), `the Export button lost its prefix: ${found.join(' | ')}`);
});

test('the prefixes actually survive friendlyStatus', () => {
  // friendlyStatus only keeps a prefix that its own regex accepts: at most 40
  // characters before the colon, and containing a space. A prefix that fails
  // that test is not an error — it is silently dropped, taking the "which
  // operation" half of the message with it. The prefixes are read out of the
  // source, so renaming one to something too long fails here rather than in
  // front of a user.
  const prefixes = [...modal.matchAll(/friendlyStatus\(`([^`]*?):\s*\$\{/g)].map((m) => m[1]);
  assert.equal(prefixes.length, 2, 'floor: prefix extraction found nothing to check');
  for (const p of prefixes) {
    const out = friendlyStatus(`${p}: ENOSPC: no space left on device`);
    assert.ok(out.startsWith(`${p}: `), `friendlyStatus dropped the prefix "${p}" — it is too long or has no space in it`);
    assert.doesNotMatch(out, /ENOSPC/, `the tail after "${p}" was not rewritten`);
    assert.match(out, /disk is full/i, `expected the disk-full rule after "${p}", got: ${out}`);
  }
});

// ── The hint has to arrive on its own line ───────────────────────────────────

test('floor: friendlyStatus really does emit a newline', () => {
  // If it stopped doing this, the white-space assertion below would still pass
  // while protecting nothing.
  const out = friendlyStatus('Visual QC scan failed: ENOENT: no such file or directory, open /Vol/A/b.mov');
  assert.ok(out.includes('\n'), `expected a hint on its own line, got: ${JSON.stringify(out)}`);
});

test('the progress element preserves the line break', () => {
  // Either the stylesheet does it or the component does. Right now it is the
  // component: main.css's only rule for the class is `font-size:12px`, so the
  // default `normal` would collapse the break. Written as "either" so that
  // moving the rule into CSS later is a refactor, not a failure.
  const css = read('src/styles/main.css');
  const rule = css.match(/\.pfx-qc-progressTxt\s*\{([^}]*)\}/);
  const cssPreserves = !!rule && /white-space\s*:\s*(pre|pre-wrap|pre-line|break-spaces)\b/.test(rule[1]);
  const jsPreserves = /progTxt\.style\.whiteSpace\s*=\s*'(pre|pre-wrap|pre-line|break-spaces)'/.test(modal);
  assert.ok(
    cssPreserves || jsPreserves,
    'nothing makes .pfx-qc-progressTxt preserve newlines, so friendlyStatus hints will be welded onto the message',
  );
});

// ── The caller's mirror is one line and not ours to restyle ──────────────────

test('the mirror gets the break flattened, not raw', () => {
  // onStatus writes into an element in reviews/index.js whose CSS this
  // component does not own, so the break is turned into a space on the way out
  // rather than left to collapse into nothing.
  const call = lines.find((l) => /onStatus\s*\?\.\s*\(/.test(l));
  assert.ok(call, 'the onStatus mirror call is gone');
  assert.match(call, /\.replace\s*\(/, `the mirror still forwards the raw text: ${call.trim()}`);

  // And the replacement has to do the job: no newline left, and no two words
  // run together where one used to be.
  const expr = call.match(/\.replace\s*\((\/.*?\/[a-z]*)\s*,\s*(['"].*?['"])\s*\)/);
  assert.ok(expr, `could not read the replacement out of: ${call.trim()}`);
  const flatten = new Function('s', `return s.replace(${expr[1]}, ${expr[2]});`);
  const out = flatten(friendlyStatus('Visual QC scan failed: ENOSPC: no space left on device'));
  assert.doesNotMatch(out, /\n/, `a newline still reaches the caller's one-line strip: ${JSON.stringify(out)}`);
  assert.doesNotMatch(out, /[.!?][A-Z]/, `two sentences were run together: ${JSON.stringify(out)}`);
});
