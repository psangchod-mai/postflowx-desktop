// scripts/core/printOutcome.js
// PostFlowX — how "print this report" actually ended, and what to say about it.
//
// ── The gap this closes ──────────────────────────────────────────────────────
//
// saveNotice.js records that the Visual QC PDF button used to announce
//
//     "Ready. Use “Save as PDF” in the print dialog."
//
// unconditionally, and that the fix was to hand the caller the real outcome.
// That fixed the *fallback* half — a cancelled or failed HTML save no longer
// claims a dialog. The print half kept its original shape: open a window,
// schedule `w.print()` 300 ms later inside a try/catch that swallows
// everything, and return PRINTED immediately — before the print had been
// attempted at all. So every way the attempt can fail stayed invisible:
//
//   - a pop-up blocker hands back a real window object and then closes it;
//   - the user closes the tab inside those 300 ms;
//   - print() throws, or the host never gave the window one.
//
// In all three the app still said "use the print dialog", and there was no
// dialog. Which is the same sentence, pointing at the same absent thing, that
// saveNotice.js was written to stop the app from saying.
//
// ── Why three endings and not two ────────────────────────────────────────────
//
// "The window is open and holding your report, but we could not raise the
// print dialog for you" is a genuinely different ending from "the window is
// gone". The first is one keystroke from done and the user can see the report
// in front of them; the second needs a file written instead. Collapsing them
// into a boolean is what forces a caller to guess, and guessing is how the
// unconditional sentence got there in the first place.
//
// PRINTED is still not proof that anything was printed — nothing in a browser
// can promise that. It is the strongest claim available: the window was still
// open, print() existed, we called it, and it returned without throwing. That
// is enough to point at a dialog. It was not enough before, because none of it
// had been checked.
//
// No DOM of its own — `win` is whatever window.open() handed back, and every
// property is read defensively — so this module is importable in Node tests
// and in both build targets.
// ─────────────────────────────────────────────────────────────────────────────

import { SAVED } from './saveOutcome.js';
import { saveNotice, TONE_OK } from './saveNotice.js';
import { translate } from './friendlyError.js';

/** print() was called on a live window and returned. Point at the dialog. */
export const PRINTED = 'printed';
/** The report is on screen, but the dialog could not be raised for the user. */
export const OPENED = 'opened';
/** The window went away before it could print. Nothing is on screen. */
export const CLOSED = 'closed';

/** Default wait — extracted so tests can drive the clock instead of sleeping. */
const realWait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * tryAutoPrint(win, opts) → Promise<PRINTED | OPENED | CLOSED>
 *
 * The delay is not decoration: a window written to with document.write() needs
 * a turn of the event loop before its layout is worth printing, which is why
 * the original code had one. What it did not have was anything that looked at
 * the window again afterwards.
 *
 * focus() failing is not an outcome. It is blocked routinely by browsers that
 * will still print perfectly well, so it is attempted and ignored — only
 * print() itself decides between PRINTED and OPENED.
 */
export async function tryAutoPrint(win, { delayMs = 300, wait = realWait } = {}) {
  await wait(delayMs);
  // `closed` on a cross-origin-ish popup can itself throw; treat an
  // unreadable window as gone, because there is nothing we can do with it.
  let gone;
  try { gone = !win || win.closed; } catch { gone = true; }
  if (gone) return CLOSED;

  try { win.focus(); } catch { /* routinely blocked; irrelevant to printing */ }

  if (typeof win.print !== 'function') return OPENED;
  try {
    win.print();
  } catch {
    return OPENED;
  }
  return PRINTED;
}

/**
 * printNotice(outcome) → { tone, text }
 *
 * Every ending the "Export PDF" button has, answered in one place. The save
 * outcomes are delegated rather than restated: a print that fell back to a
 * file save ends the same way any other export does, and duplicating those
 * three sentences here is how they would drift apart.
 *
 * Sentences are translated whole, for the reason saveNotice.js gives — the
 * dictionary is keyed on sentences and assembling clauses produces word order
 * that is wrong in most of the six languages.
 */
export function printNotice(outcome) {
  if (outcome === PRINTED) {
    return { tone: TONE_OK, text: translate('Ready. Use “Save as PDF” in the print dialog.') };
  }
  if (outcome === OPENED) {
    return {
      tone: TONE_OK,
      text: translate('The report opened in a new window. Use Print there, then choose “Save as PDF”.'),
    };
  }
  if (outcome === SAVED) {
    // Deliberately not "Report saved as HTML". No tier of the cascade can prove
    // the bytes landed — the anchor tier is an a.click() with no callback of any
    // kind — and saveNotice.js already declined to make that claim for exactly
    // this reason. Saying the export finished, and what to do with the file, is
    // everything the user needs and all the app actually knows.
    return { tone: TONE_OK, text: translate('Report exported as an HTML file. Open it and print it to PDF.') };
  }
  // CLOSED lands here too, and that is correct: the window is gone and no file
  // was written, so the user is looking at nothing. saveNotice's failure
  // sentence — try again, or choose a different folder — is the right advice,
  // and routing it through there keeps one wording for one situation.
  return saveNotice(outcome);
}

// Expose globals for non-module / classic-script consumers, matching
// saveOutcome.js and saveNotice.js next door.
if (typeof window !== 'undefined') {
  window.pfxPrintOutcome = { PRINTED, OPENED, CLOSED };
  window.pfxTryAutoPrint = tryAutoPrint;
  window.pfxPrintNotice = printNotice;
}
