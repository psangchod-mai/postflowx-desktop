// ─────────────────────────────────────────────────────────────────────────────
// The export that finished without saying anything.
//
// `runSaveCascade` answers with one of three outcomes — SAVED, CANCELLED,
// UNAVAILABLE — and every one of the seven call sites in the app threw that
// answer away. So two endings that could not be more different looked identical
// from the user's chair:
//
//   · you pressed Cancel in the Save dialog        → nothing happened, silence
//   · every route failed and no bytes were written → nothing happened, silence
//
// Clicking "Export CSV" and getting no file and no message is the least
// explainable thing an app can do to someone who is not going to open a console
// to find out why.
//
// One site was worse than silent. The Visual QC PDF button called
// `openPrintReportHtml()` — which returned a bare `true` whether the print
// window had opened, the HTML fallback had been saved, or the fallback had been
// cancelled — and then announced, unconditionally:
//
//     "Ready. Use “Save as PDF” in the print dialog."
//
// pointing at a dialog that in two of those three cases was not on screen.
//
// ── Two halves ───────────────────────────────────────────────────────────────
//
// The first half tests core/saveNotice.js as a module: the right tone and a
// real sentence for each outcome, an unknown outcome defaulting to a failure
// rather than to silence, and — deliberately — that SAVED does not claim the
// bytes reached the disk, because nothing in the cascade checked.
//
// The second half is a source gate over the call sites. A module that returns
// perfect sentences is worth nothing if a call site goes back to discarding the
// outcome, and no unit test of saveNotice.js can see that happen. The gate
// checks constructs, not literal spellings — enumerating forbidden wordings is
// guessing at the next mutation.
//
// ── What this cannot see ─────────────────────────────────────────────────────
//
//  - Whether the file actually landed. No tier can answer that:
//    chrome.downloads.download resolves an id when the download is *accepted*,
//    and the anchor tier is `downloadText(...); return SAVED;` with no callback
//    at all. That is precisely why the SAVED sentence describes the app's side
//    of the handover rather than a filesystem state.
//
// Two entries that used to be on this list have since been dealt with, and are
// recorded here rather than deleted because "we know we cannot see this" and
// "we checked" are different states and the difference is worth keeping:
//  - The print dialog. PRINTED meant `window.open` had succeeded, nothing more.
//    core/printOutcome.js now inspects the window after the layout delay and
//    tryAutoPrint's three endings are tested in printOutcome.test.mjs.
//  - The dictionary rows. The three sentences below shipped with none, so
//    `translate` fell back to English in six locales; they have rows now, and
//    errorI18n.test.mjs fails if a fourth sentence arrives without them.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { SAVED, CANCELLED, UNAVAILABLE } = await import(
  '../src/scripts/core/saveOutcome.js'
);
const { saveNotice, isDialogWorthy, TONE_OK, TONE_QUIET, TONE_ERROR } =
  await import('../src/scripts/core/saveNotice.js');

// ── Half one: the module ─────────────────────────────────────────────────────

test('every outcome produces a tone and a non-empty sentence', () => {
  for (const outcome of [SAVED, CANCELLED, UNAVAILABLE]) {
    const notice = saveNotice(outcome);
    assert.ok(notice, `no notice for ${outcome}`);
    assert.ok(
      [TONE_OK, TONE_QUIET, TONE_ERROR].includes(notice.tone),
      `unknown tone ${notice.tone} for ${outcome}`
    );
    assert.equal(typeof notice.text, 'string');
    assert.ok(notice.text.trim().length > 0, `empty text for ${outcome}`);
    // A sentence, not a fragment — the dictionary is keyed on whole sentences.
    assert.match(notice.text, /[.!?]$/, `not a sentence for ${outcome}`);
  }
});

test('the three outcomes are told apart, which was the whole point', () => {
  const texts = [SAVED, CANCELLED, UNAVAILABLE].map((o) => saveNotice(o).text);
  assert.equal(new Set(texts).size, 3, 'two outcomes share a sentence');
  const tones = [SAVED, CANCELLED, UNAVAILABLE].map((o) => saveNotice(o).tone);
  assert.equal(new Set(tones).size, 3, 'two outcomes share a tone');
});

test('SAVED is ok, CANCELLED is quiet, UNAVAILABLE is an error', () => {
  assert.equal(saveNotice(SAVED).tone, TONE_OK);
  assert.equal(saveNotice(CANCELLED).tone, TONE_QUIET);
  assert.equal(saveNotice(UNAVAILABLE).tone, TONE_ERROR);
});

test('SAVED does not claim a filesystem state nothing verified', () => {
  const text = saveNotice(SAVED).text.toLowerCase();
  // No tier in either cascade can prove the bytes landed, so the confirmation
  // must not say they did. It reports that the export finished, which is true.
  for (const claim of ['saved to disk', 'written to', 'saved to your']) {
    assert.ok(!text.includes(claim), `SAVED text claims "${claim}"`);
  }
});

test('the cancel sentence says nothing was saved', () => {
  const text = saveNotice(CANCELLED).text.toLowerCase();
  assert.ok(
    text.includes('cancel'),
    'the cancel sentence should name the cancel'
  );
});

test('the failure sentence tells the user what to do next', () => {
  const text = saveNotice(UNAVAILABLE).text.toLowerCase();
  assert.ok(
    /try again|different folder|another/.test(text),
    'the failure sentence offers no next step'
  );
});

test('an unrecognised outcome fails loudly rather than silently', () => {
  // Silence is the one answer that must not be reachable by accident, so
  // anything that is not SAVED or CANCELLED — including undefined, which is
  // exactly what a call site would pass if a cascade ever forgot to return —
  // has to come back as an error the user gets told about.
  for (const junk of [undefined, null, '', 'weird', 0, false, {}]) {
    const notice = saveNotice(junk);
    assert.equal(notice.tone, TONE_ERROR, `${String(junk)} was not an error`);
    assert.ok(notice.text.trim().length > 0);
    assert.equal(isDialogWorthy(notice), true);
  }
});

test('isDialogWorthy is true only for a real failure', () => {
  assert.equal(isDialogWorthy(saveNotice(UNAVAILABLE)), true);
  assert.equal(isDialogWorthy(saveNotice(SAVED)), false);
  assert.equal(isDialogWorthy(saveNotice(CANCELLED)), false);
  // Nobody needs a popup confirming that their own Cancel button worked.
  assert.equal(isDialogWorthy(null), false);
  assert.equal(isDialogWorthy(undefined), false);
  assert.equal(isDialogWorthy({}), false);
});

// ── Half two: the call sites ─────────────────────────────────────────────────

const REVIEWS = 'src/scripts/features/reviews/index.js';
const VISUAL_QC = 'src/scripts/components/visualQcModal/index.js';

test('both converted files import saveNotice', () => {
  for (const rel of [REVIEWS, VISUAL_QC]) {
    assert.match(
      read(rel),
      /import\s*\{[^}]*\bsaveNotice\b[^}]*\}\s*from\s*['"][^'"]*core\/saveNotice\.js['"]/,
      `${rel} does not import saveNotice`
    );
  }
});

// A call whose result is discarded — `await foo(...)` or `foo(...)` as a
// complete statement, with no assignment, no `.then`, and no `return`. Matching
// the shape rather than a wording means a call site cannot slip back by being
// rephrased.
function discardedCalls(src, fnName) {
  const out = [];
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf(`${fnName}(`);
    if (idx < 0) continue;
    const before = line.slice(0, idx).trimEnd();
    // Declarations of the function itself are not call sites.
    if (/\b(function|async function)\s*$/.test(before)) continue;
    // Consumed: assigned, returned, awaited-into-something, or chained.
    const consumed =
      /[=:]\s*(await\s*)?$/.test(before) ||
      /\breturn\s+(await\s*)?$/.test(before) ||
      /[(,[]\s*(await\s*)?$/.test(before);
    // A chain may continue on the following lines.
    const tail = lines.slice(i, i + 3).join('\n');
    const chained = /\)\s*[\r\n\s]*\.(then|catch|finally)\s*\(/.test(tail);
    if (!consumed && !chained) out.push(`${i + 1}: ${line.trim()}`);
  }
  return out;
}

test('no downloadOrSaveText call throws its outcome away', () => {
  for (const rel of [REVIEWS, VISUAL_QC]) {
    const bad = discardedCalls(read(rel), 'downloadOrSaveText');
    assert.deepEqual(bad, [], `${rel} discards a save outcome:\n${bad.join('\n')}`);
  }
});

test('no openPrintReportHtml call throws its outcome away', () => {
  const bad = discardedCalls(read(VISUAL_QC), 'openPrintReportHtml');
  assert.deepEqual(bad, [], `discarded print outcome:\n${bad.join('\n')}`);
});

test('every reviews export site reaches announceExport', () => {
  const src = read(REVIEWS);
  // Four buttons: the two menu items and the two panel buttons. If a fifth is
  // added, this number moves and whoever adds it has to look at this file.
  const calls = src.match(/(?<!function\s{1,4})\bannounceExport\s*\(/g) || [];
  assert.equal(calls.length, 4, `expected 4 announceExport calls, saw ${calls.length}`);
  // The panel has no status strip, so a failure has to be a dialog — and by the
  // same rule a cancel must not be one. That is what isDialogWorthy is for.
  assert.match(
    src,
    /function\s+announceExport[\s\S]{0,400}?isDialogWorthy\s*\(/,
    'announceExport no longer gates on isDialogWorthy'
  );
});

test('openPrintReportHtml reports which ending happened', () => {
  const src = read(VISUAL_QC);
  const body = src.slice(src.indexOf('async function openPrintReportHtml'));
  const fn = body.slice(0, body.indexOf('\n}\n') + 2);
  assert.ok(fn.length > 0 && fn.length < 4000, 'could not isolate the function');
  // A bare boolean cannot tell "printed" from "saved the fallback" from
  // "the fallback failed", which is how the caller ended up pointing at a
  // print dialog that had never opened.
  assert.ok(
    !/\breturn\s+(true|false)\s*;/.test(fn),
    'openPrintReportHtml is back to returning a bare boolean'
  );
  // The print ending is no longer decided here. `return PRINTED` used to sit in
  // this function, fired 300ms before the print was attempted; the decision now
  // belongs to tryAutoPrint, which looks at the window *after* the delay, and
  // whatever it answers is handed straight up.
  assert.match(
    fn,
    /const\s+how\s*=\s*await\s+tryAutoPrint\s*\(/,
    'the print attempt is not awaited — its answer cannot be the return value'
  );
  assert.match(fn, /\breturn\s+how\s*;/, 'tryAutoPrint’s answer is not returned');
  // A closed window is not an ending of its own here: it falls through to the
  // file, so the user gets something rather than a pointer at a missing window.
  assert.match(fn, /if\s*\(\s*how\s*!==\s*CLOSED\s*\)/, 'CLOSED no longer falls through to the file');
  assert.match(fn, /\breturn\s+await\s+downloadOrSaveText\s*\(/, 'the fallback outcome is not returned');
  assert.match(fn, /\breturn\s+UNAVAILABLE\s*;/, 'no failure return');
});

test('the "Save as PDF" line is not written at the call site', () => {
  // It used to be a literal in a setProgress() call that ran whatever had
  // happened. The sentence now has exactly one home — printOutcome.js's PRINTED
  // branch — so that "there is a print dialog on screen" is asserted in the one
  // place that knows whether there is.
  const vqc = read(VISUAL_QC).split('\n');
  const inlined = vqc
    .map((l, i) => `${i + 1}: ${l.trim()}`)
    .filter((_, i) => /Save as PDF/.test(vqc[i]) && /setProgress\s*\(/.test(vqc[i]));
  assert.deepEqual(inlined, [], `the "Save as PDF" line is hardcoded at a call site again:\n${inlined.join('\n')}`);

  // Comments first: printOutcome.js's header quotes the sentence to explain what
  // it is for, and a quotation in prose is not a string the user can be shown.
  const printSrc = read('src/scripts/core/printOutcome.js');
  const printCode = printSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.ok(printCode.length < printSrc.length, 'floor: comment stripping did nothing');
  const print = printCode.split('\n');
  const say = print
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /Save as PDF" in the print dialog|Save as PDF” in the print dialog/.test(l));
  assert.equal(say.length, 1, `expected 1 print-dialog sentence in printOutcome.js, saw ${say.length}`);
  // And it has to sit inside the branch that established the dialog was raised.
  const context = print.slice(Math.max(0, say[0].i - 3), say[0].i).join('\n');
  assert.match(
    context,
    /outcome\s*===\s*PRINTED/,
    'the "Save as PDF" sentence is no longer gated on PRINTED'
  );
});

test('the two surfaces stay different on purpose', () => {
  // visualQcModal has a progress line, so it reports a cancel there. reviews
  // has no status surface at all, so its only channel is a dialog — and it must
  // therefore stay quiet on cancel. If reviews ever grows an unconditional
  // alert on the export path, that asymmetry has been lost.
  const src = read(REVIEWS);
  assert.ok(
    !/\bfriendlyAlert\s*\(\s*saveNotice\s*\(/.test(src),
    'reviews alerts on every outcome, including cancel'
  );
  const vqc = read(VISUAL_QC);
  assert.match(
    vqc,
    /setProgress\s*\([^)]*saveNotice\s*\(/,
    'visualQcModal no longer routes outcomes through its progress line'
  );
});
