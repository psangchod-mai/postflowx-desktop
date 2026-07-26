// scripts/core/saveNotice.js
// PostFlowX — what to tell the user once a save cascade has finished.
//
// ── The gap this closes ──────────────────────────────────────────────────────
//
// runSaveCascade answers with one of three outcomes, and all seven call sites
// in the app threw that answer away. Two very different endings therefore
// looked identical from the user's chair: the export they cancelled on
// purpose, and the export where every route failed and no file was written.
// Both were followed by silence. Clicking "Export CSV" and getting nothing —
// no file, no message — is the single least explainable thing an app can do.
//
// One site was worse than silent. The Visual QC PDF button ran
// `openPrintReportHtml()` and then announced
//
//     "Ready. Use “Save as PDF” in the print dialog."
//
// unconditionally — including when the popup had been blocked and the HTML
// fallback had failed or been cancelled. It pointed at a dialog that was not
// on screen.
//
// ── Why SAVED does not say "Saved to disk" ───────────────────────────────────
//
// Because no tier can prove it. `chrome.downloads.download` resolves an id
// when the download is *accepted*, not when the bytes land; the anchor tier is
// `a.click()` followed by `return SAVED` with no callback of any kind. So the
// confirmation here describes the app's side of the handover — the export
// finished — rather than asserting a filesystem state nothing in the chain
// checked. Replacing one unverified success claim with another would have
// missed the point of the fix.
//
// ── Why there is no show() helper ────────────────────────────────────────────
//
// The two surfaces that consume this genuinely differ, and not by accident.
// A modal progress line should report a cancel ("Export cancelled…") because
// the line is already on screen and the user is looking at it. A dialog should
// not: interrupting someone with a popup to tell them their own Cancel worked
// is noise. That is what `isDialogWorthy` encodes, and it is the reason each
// call site branches on tone rather than handing this module a callback.
//
// No DOM, and no import of i18n beyond the guarded shim, so the module is
// importable in Node tests and in both build targets.
// ─────────────────────────────────────────────────────────────────────────────

import { SAVED, CANCELLED } from './saveOutcome.js';
import { translate } from './friendlyError.js';

/** Nothing went wrong. Confirm it where there is room; never in a dialog. */
export const TONE_OK = 'ok';
/** The user ended it themselves. Worth a status line, never worth a popup. */
export const TONE_QUIET = 'quiet';
/** No route worked. The user must be told, on whatever surface exists. */
export const TONE_ERROR = 'error';

/**
 * saveNotice(outcome) → { tone, text }
 *
 * `text` is always a complete sentence, translated as a whole rather than
 * assembled from fragments — the dictionary is keyed on sentences, and gluing
 * clauses together produces word order that is wrong in most of the seven
 * languages the app ships.
 */
export function saveNotice(outcome) {
  if (outcome === SAVED) {
    return { tone: TONE_OK, text: translate('Export finished.') };
  }
  if (outcome === CANCELLED) {
    return { tone: TONE_QUIET, text: translate('Export cancelled. Nothing was saved.') };
  }
  // Anything that is not SAVED or CANCELLED means the cascade ran out of
  // routes. Defaulting rather than matching UNAVAILABLE exactly is deliberate:
  // an unrecognised outcome is a failure the user still needs to hear about,
  // and silence is the one answer that must never be reachable by accident.
  return {
    tone: TONE_ERROR,
    text: translate("The file couldn't be saved. Try again, or choose a different folder."),
  };
}

/**
 * isDialogWorthy(notice) → boolean. True only for a real failure.
 *
 * Used by surfaces whose only way to speak is a modal. Success and cancel are
 * both fine outcomes; neither earns an interruption.
 */
export function isDialogWorthy(notice) {
  return !!notice && notice.tone === TONE_ERROR;
}

// Expose globals for non-module / classic-script consumers, matching
// saveOutcome.js next door.
if (typeof window !== 'undefined') {
  window.pfxSaveNotice = saveNotice;
  window.pfxIsDialogWorthy = isDialogWorthy;
}
