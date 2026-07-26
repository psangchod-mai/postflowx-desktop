// scripts/core/saveOutcome.js
// PostFlowX — how a "save this file" attempt ended, and how to recognise the
// user ending it themselves.
//
// The app writes text out (review notes as JSON/CSV, visual-QC reports) through
// a cascade of three routes, because no single one is reliable everywhere:
// chrome.downloads is the dependable path in the extension, showSaveFilePicker
// is the good path in a recent Chrome, and an anchor click works absolutely
// everywhere but cannot be steered — it drops the file in Downloads and tells
// nobody.
//
// ── The bug this module exists to remove ─────────────────────────────────────
//
// Every route used to answer with a boolean: did the file get written? That
// collapses two completely different answers into one. "The user pressed
// Cancel" and "this route is not available here" both came back as `false`, so
// cancelling the first Save dialog was read as a route failure. The cascade
// opened a SECOND dialog; cancel that one too and it fell through to the anchor
// and wrote the file to Downloads regardless. Cancel meant "ask me twice, then
// do it anyway" — the one thing a Cancel button must never mean.
//
// So: three outcomes rather than a boolean, and one runner that knows a cancel
// is terminal while an unavailable route is not.
//
// Dual-use: importable (ESM) for tests and for both build targets, and exposed
// on window for classic-script consumers. Zero imports, deliberately — it is
// loaded by Node tests where there is no window, and by the renderer where
// there is.
// ─────────────────────────────────────────────────────────────────────────────

/** The file was written (or handed to the browser to write). Stop. */
export const SAVED = 'saved';
/** The user declined the dialog. Stop — and do not save by another route. */
export const CANCELLED = 'cancelled';
/** This route cannot run here. Try the next one. */
export const UNAVAILABLE = 'unavailable';

// Cancel arrives in three different costumes depending on which route declined:
//
//  - showSaveFilePicker rejects with a DOMException named AbortError.
//  - chrome.downloads sets chrome.runtime.lastError to "USER_CANCELED" — real
//    Chrome's own spelling, one L, which is why the pattern accepts both.
//  - the Electron bridge answers the IPC with { canceled: true }, Electron's
//    own spelling from dialog.showSaveDialog.
//
// Deliberately NOT treated as a cancel: "The request is not allowed by the user
// agent or the platform in the current context". That is showSaveFilePicker
// refusing for want of a transient user activation — the route is unavailable,
// not declined. Reading it as a cancel would abandon an export the user did ask
// for, with no dialog and no error to explain it.
const CANCEL_TEXT = /\bUSER_CANCELL?ED\b|user cance(?:l|ll)ed|cance(?:l|ll)ed by the user|the user aborted/i;

/**
 * isUserCancel(err) → boolean. True when `err` means "the person said no".
 * Accepts an Error, a DOMException, a chrome.runtime.lastError, an IPC result
 * object, or a bare string.
 */
export function isUserCancel(err) {
  if (!err) return false;
  if (typeof err === 'object') {
    // Electron spells it with one L; be generous about the other.
    if (err.canceled === true || err.cancelled === true) return true;
    if (err.name === 'AbortError') return true;
  }
  const s = typeof err === 'string' ? err : String(err.message || err.error || '');
  return CANCEL_TEXT.test(s);
}

/**
 * runSaveCascade(tiers) → Promise<SAVED | CANCELLED | UNAVAILABLE>
 *
 * Runs each tier in order until one of them settles the matter. A tier is a
 * function returning one of the three outcomes (or a promise of one).
 *
 * The sequencing lives here, in one tested place, rather than being written out
 * again in every feature that saves a file — the tiers themselves genuinely
 * differ between callers, but the rule "a cancel ends it" does not, and that is
 * exactly the rule two separate copies had both got wrong.
 *
 * A tier that throws is treated as unavailable unless it threw a cancel, so a
 * route blowing up can never silently consume the user's export.
 */
export async function runSaveCascade(tiers) {
  for (const tier of tiers) {
    let outcome;
    try {
      outcome = await tier();
    } catch (err) {
      outcome = isUserCancel(err) ? CANCELLED : UNAVAILABLE;
    }
    if (outcome === SAVED || outcome === CANCELLED) return outcome;
  }
  return UNAVAILABLE;
}

// Expose globals for non-module / classic-script consumers.
if (typeof window !== 'undefined') {
  window.pfxSaveOutcome = { SAVED, CANCELLED, UNAVAILABLE };
  window.pfxIsUserCancel = isUserCancel;
  window.pfxRunSaveCascade = runSaveCascade;
}
