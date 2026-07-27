// src/tools/preflight/app/paneText.js
// The Preflight pane's own voice, in the seven languages it already speaks.
//
// WHY THIS EXISTS
// The pane ships roughly 148K of translated check text and fix guidance in
// seven languages — every check title, every severity, every "here is how to
// fix it" paragraph — and locale.js picks the right one. So a Thai producer
// opens Preflight, reads the whole delivery spec in Thai, presses Run, and gets:
//
//     Preflight failed: Failed to fetch
//
// Two separate problems in one line. The label is an English literal that no
// dictionary can see, and the tail is an exception's own text — "Failed to
// fetch", "NotReadableError", "The user aborted a request" — which is not a
// sentence anybody outside this codebase can act on, in any language.
//
// renderApp already had the answer. ui.js reads
// `state.config.ui.labels?.key || "English"` at nineteen sites, so the pattern
// was known and simply had not reached app.js, the controller. Exactly one of
// the nine alert() calls in app.js followed it. This module generalises that
// one call site so the other eight can too.
//
// THE TECHNICAL DETAIL IS NOT BEING THROWN AWAY
// Every raw-exception site in app.js already calls `console.error(e)` on the
// line above the alert. Taking the exception text out of the dialog does not
// lose it — it moves it to where a support engineer looks and away from where a
// producer looks. That is the whole trade, and it is only defensible because
// the console.error is there. If one is ever removed, put the detail back.
//
// AbortError IS NOT A FAILURE
// Two things in this pane open a folder picker — rescanFolderAndRun and
// onPickForReq — and both filter `e?.name === "AbortError"` before they reach
// the alert, because that is the user closing the picker. failureReason does
// NOT translate AbortError into a failure sentence; it falls through to the
// unknown one. That is deliberate and written down here so the next person can
// see the decision was made rather than missed: cancelling is not something to
// apologise for, and if a guard is ever dropped, a vague sentence is a smaller
// lie than a confident one about permissions.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// - No DOM, no imports from the pane. It takes a config object and an error and
//   returns a string, so tests-js can import it directly.
// - It reads the config LIVE on every call rather than closing over
//   `state.config.ui.labels`. app.js changes locale in place when the language
//   switcher fires; a captured `L` would keep serving the previous language
//   until the next full render.
// - It does not guess. An exception with no matching name and no matching
//   message gets a sentence that says something went wrong and where to look —
//   which is vague, but true. A specific wrong answer ("the disk is full" to
//   somebody with 4TB free) costs more than a vague right one.

/** Read one label out of the active locale's ui_strings, live. */
export function paneLabel(config, key, fallback) {
  const v = config?.ui?.labels?.[key];
  return typeof v === 'string' && v.trim() ? v : fallback;
}

/**
 * Read a label and substitute {named} placeholders.
 * Translators keep the placeholder and move it; a cell that drops one just
 * loses that number rather than throwing.
 */
export function paneText(config, key, fallback, vars) {
  const s = paneLabel(config, key, fallback);
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

// The failure modes this pane can actually produce. Every one of these is
// reachable from showDirectoryPicker, FileSystemFileHandle.getFile, fetch() on
// a config JSON, or reading a File — the four things the pane does that can
// fail. Ordered most specific first; `name` is checked before `message`,
// because a DOMException keeps the useful half of its identity in .name and
// loses it the moment the browser rewords the message.
const BY_NAME = {
  NotAllowedError: ['err_permission', 'PostFlowX was not allowed to read that folder. Grant access when the browser asks, then try again.'],
  SecurityError: ['err_permission', 'PostFlowX was not allowed to read that folder. Grant access when the browser asks, then try again.'],
  NotReadableError: ['err_unreadable', 'That file could not be read. It may be on a drive that has disconnected.'],
  NotFoundError: ['err_missing', 'That file or folder is no longer where it was. It may have been moved, renamed, or unmounted.'],
  QuotaExceededError: ['err_no_space', 'There is not enough space left to finish this.'],
  RangeError: ['err_too_large', 'That file is too large to open here.'],
};

const BY_MESSAGE = [
  [/failed to fetch|networkerror|load failed/i, 'err_offline', 'PostFlowX could not load the files it needed. Check the connection and try again.'],
  [/permission|not allowed|denied/i, 'err_permission', 'PostFlowX was not allowed to read that folder. Grant access when the browser asks, then try again.'],
  [/no such file|does not exist|ENOENT/i, 'err_missing', 'That file or folder is no longer where it was. It may have been moved, renamed, or unmounted.'],
  [/no space|disk full|ENOSPC/i, 'err_no_space', 'There is not enough space left to finish this.'],
  [/too large|out of memory|allocation/i, 'err_too_large', 'That file is too large to open here.'],
];

const UNKNOWN = ['err_unknown', 'Something went wrong. The technical detail is in the developer console.'];

/**
 * One translated sentence for why an operation failed. Never the exception's
 * own text — see the header.
 */
export function failureReason(config, err) {
  const name = err?.name || '';
  if (Object.prototype.hasOwnProperty.call(BY_NAME, name)) {
    const [key, fallback] = BY_NAME[name];
    return paneLabel(config, key, fallback);
  }
  const msg = String(err?.message || err || '');
  for (const [re, key, fallback] of BY_MESSAGE) {
    if (re.test(msg)) return paneLabel(config, key, fallback);
  }
  return paneLabel(config, UNKNOWN[0], UNKNOWN[1]);
}

/**
 * The whole dialog: which operation failed, then why, on its own line.
 *
 * alert() honours \n, unlike the one-line status strips elsewhere in
 * PostFlowX, so the two halves stay separate here rather than being welded
 * together with a colon.
 */
export function failureAlert(config, key, fallback, err) {
  return `${paneLabel(config, key, fallback)}\n\n${failureReason(config, err)}`;
}
