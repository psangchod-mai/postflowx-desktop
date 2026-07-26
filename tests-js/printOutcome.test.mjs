// ─────────────────────────────────────────────────────────────────────────────
// The print dialog that was announced 300 ms before anyone tried to open it.
//
// saveNotice.test.mjs records half of this bug: the Visual QC PDF button said
//
//     "Ready. Use “Save as PDF” in the print dialog."
//
// unconditionally, including when the HTML fallback had been cancelled. That
// half was fixed by handing the caller the save cascade's real outcome.
//
// The other half stayed. `openPrintReportHtml` opened a window, scheduled
// `w.print()` for 300 ms later inside a try/catch that swallowed everything,
// and returned PRINTED immediately — before the print had been attempted. So
// the same sentence still appeared with no dialog behind it whenever:
//
//   · a pop-up blocker handed back a window object and then closed it;
//   · the user closed the tab inside those 300 ms;
//   · print() threw, or the host never gave that window one.
//
// Nothing looked at the window again after the delay, so none of the three was
// distinguishable from a successful print.
//
// ── Two halves ───────────────────────────────────────────────────────────────
//
// The first half drives core/printOutcome.js directly. tryAutoPrint takes an
// injectable clock, so the failure modes above are ordinary unit tests rather
// than 300 ms sleeps, and "did it wait before looking?" is observable instead
// of assumed.
//
// The second half is a source gate over the call site, on the same reasoning
// saveNotice.test.mjs gives: a module that returns honest outcomes is worth
// nothing if the caller goes back to hardcoding a success line, and no unit
// test of printOutcome.js can see that happen. The gate checks constructs —
// an awaited tryAutoPrint, no bare `return PRINTED`, no locally reintroduced
// constant — with a floor so it cannot pass by matching nothing.
//
// ── What this still cannot see ───────────────────────────────────────────────
//
//  - Whether anything was printed. Nothing in a browser can answer that.
//    PRINTED means the window was open, print() existed, we called it, and it
//    returned. That is the strongest available claim, and it is now checked.
//  - Whether the bytes of the HTML fallback landed on disk. No tier of the
//    cascade knows; that is why the SAVED sentence describes the handover
//    rather than a filesystem state, and there is a test below for that.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { SAVED, CANCELLED, UNAVAILABLE } = await import('../src/scripts/core/saveOutcome.js');
const { saveNotice, TONE_OK, TONE_QUIET, TONE_ERROR } = await import('../src/scripts/core/saveNotice.js');
const { PRINTED, OPENED, CLOSED, tryAutoPrint, printNotice } = await import(
  '../src/scripts/core/printOutcome.js'
);

// A window stand-in. `over` is a map of property *descriptors*, applied as-is,
// so a test can make any field hostile — including making `closed` throw on
// read, which a real cross-origin pop-up does and a plain value cannot express.
//
// It has to be descriptors and it has to be applied with defineProperties
// directly: an earlier version ran `over` through getOwnPropertyDescriptors
// first, which wrapped each descriptor in a second one and left `win.print`
// holding the object `{ value: fn }` instead of the function. Every test below
// still passed, because a non-function print is also OPENED and a truthy
// `closed` object is also CLOSED — right answers, none of them for the reason
// claimed. The mutation harness is what noticed. Hence the self-check below.
function fakeWindow(over = {}) {
  const calls = { focus: 0, print: 0 };
  const win = {
    closed: false,
    focus() { calls.focus++; },
    print() { calls.print++; },
  };
  Object.defineProperties(win, over);
  return { win, calls };
}

test('the fixture builds the window the tests think it does', () => {
  // Without this, a broken helper turns the whole file green and silent.
  const plain = fakeWindow().win;
  assert.equal(typeof plain.print, 'function');
  assert.equal(typeof plain.focus, 'function');
  assert.equal(plain.closed, false);

  const thrower = fakeWindow({ print: { value() { throw new Error('x'); } } }).win;
  assert.equal(typeof thrower.print, 'function', 'descriptor was double-wrapped');
  assert.throws(() => thrower.print());

  const gone = fakeWindow({ closed: { value: true } }).win;
  assert.equal(gone.closed, true, 'closed is not a boolean');

  const hostile = fakeWindow({ closed: { get() { throw new Error('x'); } } }).win;
  assert.throws(() => hostile.closed, 'reading closed did not throw');

  const noPrint = fakeWindow({ print: { value: undefined } }).win;
  assert.equal(noPrint.print, undefined, 'print is not actually absent');
});

// Resolves immediately but still yields a turn, so "did it await first?" is a
// real question rather than one hidden by synchronous execution.
const instant = () => Promise.resolve();

// ── Half one: tryAutoPrint ───────────────────────────────────────────────────

test('a live window that prints cleanly is PRINTED', async () => {
  const { win, calls } = fakeWindow();
  assert.equal(await tryAutoPrint(win, { wait: instant }), PRINTED);
  assert.equal(calls.print, 1, 'print() was never called');
});

test('print() throwing is OPENED, not PRINTED', async () => {
  // The report is on screen; only the dialog failed. Telling the user to use a
  // dialog that did not open is the whole bug this module exists for.
  const { win } = fakeWindow({ print: { value() { throw new Error('blocked'); } } });
  assert.equal(await tryAutoPrint(win, { wait: instant }), OPENED);
});

test('a window with no print() is OPENED', async () => {
  const { win } = fakeWindow({ print: { value: undefined } });
  assert.equal(await tryAutoPrint(win, { wait: instant }), OPENED);
});

test('a window closed during the delay is CLOSED', async () => {
  // The pop-up blocker case: window.open returned an object, and by the time
  // the layout was ready the window was gone.
  const { win, calls } = fakeWindow({ closed: { value: true } });
  assert.equal(await tryAutoPrint(win, { wait: instant }), CLOSED);
  assert.equal(calls.print, 0, 'printed into a window that was already gone');
});

test('no window at all is CLOSED', async () => {
  // window.open() returns null when the pop-up never opened.
  assert.equal(await tryAutoPrint(null, { wait: instant }), CLOSED);
  assert.equal(await tryAutoPrint(undefined, { wait: instant }), CLOSED);
});

test('a window whose .closed throws is treated as CLOSED', async () => {
  // Reading across origins can throw. An unreadable window is one nothing can
  // be done with, so guessing it is alive would put the user back in front of
  // the sentence this module was written to stop.
  const { win } = fakeWindow({ closed: { get() { throw new Error('cross-origin'); } } });
  assert.equal(await tryAutoPrint(win, { wait: instant }), CLOSED);
});

test('focus() failing does not stop the print', async () => {
  // Browsers block focus() routinely and print perfectly well afterwards, so
  // it must not be allowed to decide the outcome.
  const { win, calls } = fakeWindow({ focus: { value() { throw new Error('denied'); } } });
  assert.equal(await tryAutoPrint(win, { wait: instant }), PRINTED);
  assert.equal(calls.print, 1);
});

test('a missing focus() does not stop the print either', async () => {
  const { win } = fakeWindow({ focus: { value: undefined } });
  await assert.doesNotReject(() => tryAutoPrint(win, { wait: instant }));
});

test('nothing is printed before the delay has elapsed', async () => {
  // The delay is why document.write()n layout is worth printing. The old code
  // had the delay and returned its answer before it — this asserts the answer
  // now comes after, by holding the clock open and checking print() has not
  // fired.
  let release;
  const held = new Promise((r) => { release = r; });
  const { win, calls } = fakeWindow();
  const pending = tryAutoPrint(win, { wait: () => held });
  await Promise.resolve();
  assert.equal(calls.print, 0, 'printed before the delay elapsed');
  release();
  assert.equal(await pending, PRINTED);
  assert.equal(calls.print, 1);
});

test('the clock is asked for the delay the caller specified', async () => {
  const seen = [];
  const { win } = fakeWindow();
  await tryAutoPrint(win, { wait: (ms) => { seen.push(ms); return Promise.resolve(); } });
  assert.deepEqual(seen, [300], 'default delay changed — the layout pause is load-bearing');
  await tryAutoPrint(win, { delayMs: 25, wait: (ms) => { seen.push(ms); return Promise.resolve(); } });
  assert.deepEqual(seen, [300, 25]);
});

test('the three print endings are distinct values', () => {
  // Two of them collapsing into one string would make every mapping below
  // pass while the caller could no longer tell the cases apart.
  assert.equal(new Set([PRINTED, OPENED, CLOSED]).size, 3);
  for (const v of [PRINTED, OPENED, CLOSED]) assert.equal(typeof v, 'string');
});

// ── Half one, continued: printNotice ─────────────────────────────────────────

test('every ending the button has produces a tone and a real sentence', () => {
  for (const outcome of [PRINTED, OPENED, CLOSED, SAVED, CANCELLED, UNAVAILABLE]) {
    const notice = printNotice(outcome);
    assert.ok(notice, `no notice for ${outcome}`);
    assert.ok([TONE_OK, TONE_QUIET, TONE_ERROR].includes(notice.tone), `unknown tone for ${outcome}`);
    assert.equal(typeof notice.text, 'string');
    assert.ok(notice.text.trim().length > 0, `empty text for ${outcome}`);
    assert.match(notice.text, /[.!?]$/, `not a sentence for ${outcome}`);
  }
});

test('only PRINTED points the user at a print dialog', () => {
  // The bug in one line. Any other ending naming the dialog is the regression.
  assert.match(printNotice(PRINTED).text, /print dialog/i);
  for (const outcome of [OPENED, CLOSED, SAVED, CANCELLED, UNAVAILABLE]) {
    assert.doesNotMatch(
      printNotice(outcome).text, /in the print dialog/i,
      `${outcome} still points at a dialog that is not on screen`,
    );
  }
});

test('OPENED says where the report is and what to do there', () => {
  // It is one keystroke from done and the report is visible — worth its own
  // sentence rather than being folded into a failure.
  const notice = printNotice(OPENED);
  assert.equal(notice.tone, TONE_OK, 'a visible report is not a failure');
  assert.match(notice.text, /window/i);
  assert.match(notice.text, /print/i);
});

test('the fallback save does not claim the file reached the disk', () => {
  // The site this replaced said "Report saved as HTML." The anchor tier of the
  // cascade is an a.click() with no callback of any kind, so nothing in the
  // app knows that. saveNotice.js already declined to make the claim; making
  // it here would have been the same bug one file over.
  const text = printNotice(SAVED).text;
  assert.doesNotMatch(text, /\bsaved\b/i, `still claims a disk write: ${text}`);
  // It must still tell the user there is a file and what to do with it.
  assert.match(text, /\bHTML\b/);
  assert.match(text, /\bPDF\b/);
});

test('outcomes that are not about printing are delegated, not restated', () => {
  // One wording per situation. Duplicating saveNotice's sentences here is how
  // the two would drift apart.
  for (const outcome of [CANCELLED, UNAVAILABLE]) {
    assert.deepEqual(printNotice(outcome), saveNotice(outcome), `${outcome} was reworded`);
  }
});

test('CLOSED ends on the failure advice, because nothing is on screen', () => {
  // The window is gone and no file was written. saveNotice's default branch —
  // try again, or choose a different folder — is the right thing to say, and
  // routing through it keeps one wording for one situation.
  const notice = printNotice(CLOSED);
  assert.equal(notice.tone, TONE_ERROR);
  assert.deepEqual(notice, saveNotice(CLOSED));
});

test('an unrecognised outcome fails loudly rather than silently', () => {
  // Silence is the one answer that must never be reachable by accident.
  const notice = printNotice('something-nobody-defined');
  assert.equal(notice.tone, TONE_ERROR);
  assert.ok(notice.text.trim().length > 0);
});

// ── Half two: the call site ──────────────────────────────────────────────────

const MODAL = 'src/scripts/components/visualQcModal/index.js';
const modalSrc = read(MODAL);

test('the gate is reading the file it thinks it is', () => {
  // Floor. Every assertion below is an absence check or a single-construct
  // match, and all of them pass against an empty string.
  assert.ok(modalSrc.length > 20000, 'visualQcModal shrank unrecognisably');
  assert.match(modalSrc, /async function openPrintReportHtml\(/);
  assert.match(modalSrc, /setProgress\(/);
});

test('the print attempt is awaited and its answer is used', () => {
  assert.match(modalSrc, /\bconst\s+\w+\s*=\s*await\s+tryAutoPrint\(/,
    'the window is no longer inspected after the delay');
  assert.match(modalSrc, /\bprintNotice\(/, 'the caller no longer words the outcome in one place');
  assert.match(modalSrc, /from '\.\.\/\.\.\/core\/printOutcome\.js'/, 'the import went away');
});

test('the outcome constants are imported, not redeclared locally', () => {
  // A local `const PRINTED = 'printed'` is how this file diverges from the
  // module's definition of what the word means.
  assert.doesNotMatch(modalSrc, /\bconst\s+(?:PRINTED|OPENED|CLOSED)\s*=/,
    'a print outcome constant was declared locally again');
  assert.doesNotMatch(modalSrc, /\breturn\s+PRINTED\s*;/,
    'success is being returned without an attempt again');
});

// The handler that calls openPrintReportHtml, from the call to the catch that
// closes it. Scoping the next gate to this block matters: a hardcoded
// `setProgress(1, 'Done.')` elsewhere in the file is correct, because the scan
// it reports on really did finish. The defect is a fixed line at a site whose
// outcome is *not* fixed, and only this block qualifies.
function printHandlerBlock(src) {
  const start = src.indexOf('await openPrintReportHtml(');
  assert.notEqual(start, -1, 'the export-PDF handler no longer calls openPrintReportHtml');
  const end = src.indexOf('}catch(err){', start);
  assert.notEqual(end, -1, 'could not find the end of the export-PDF handler');
  return src.slice(start, end);
}

test('no success sentence is hardcoded where the outcome varies', () => {
  // Constructs, not spellings: a setProgress(1, '…literal…') here is the shape
  // of the bug regardless of what the literal says, because a literal cannot
  // be conditional on an outcome and cannot be translated.
  const block = printHandlerBlock(modalSrc);
  assert.ok(block.length > 80 && block.length < 2000, `handler block looks wrong: ${block.length} chars`);
  assert.match(block, /printNotice\(/, 'floor: the block being scanned is the one that words the outcome');
  const hardcoded = [...block.matchAll(/setProgress\(\s*[01]\s*,\s*['"`]/g)];
  assert.deepEqual(hardcoded.map((m) => m[0]), [],
    'a fixed progress line is back at a site whose outcome is not fixed');
});

test('the two sentences the old code got wrong are gone from the call site', () => {
  assert.doesNotMatch(modalSrc, /Report saved as HTML/, 'the unverified disk claim came back');
  assert.doesNotMatch(modalSrc, /Save as PDF/,
    'the print-dialog sentence is hardcoded here again instead of coming from printNotice');
});

test('printOutcome.js keeps no DOM assumptions of its own', () => {
  // It is imported by Node tests and by both build targets. The only window
  // reference allowed is the typeof-guarded global export block at the end,
  // matching saveOutcome.js and saveNotice.js next door.
  //
  // Comments are stripped first. The header explains the bug by naming
  // document.write(), and a scan that cannot tell prose from code would report
  // that as a DOM dependency — which is the gate crying wolf about its own
  // documentation. Safe here because the file has no string containing "//".
  const src = read('src/scripts/core/printOutcome.js');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /The gap this closes/, 'floor: comment stripping did nothing');
  const refs = [...code.matchAll(/\bdocument\b|\bwindow\./g)].map((m) => m[0]);
  assert.ok(refs.length > 0, 'floor: expected the guarded window globals block');
  assert.deepEqual(refs.filter((r) => r === 'document'), [], 'printOutcome.js touched document');
  assert.match(code, /typeof window !== 'undefined'/, 'the window globals are no longer guarded');
});
