// scripts/core/friendlyAlert.js
// PostFlowX — the modal error dialog, in plain language and with its context
// intact.
//
// ── The bug this module exists to remove ─────────────────────────────────────
//
// Twelve places in the app answer a failure with a bare alert() carrying raw
// exception text. Two shapes, both wrong in their own way:
//
//   alert(`Rescan failed: ${e?.message || e}`)      // label, but jargon tail
//   alert(err?.message || String(err))              // jargon, and no label
//
// The first shows an editor a modal saying
//
//   Rescan failed: ENOENT: no such file or directory, open
//   '/Volumes/SHOW_01/reel3/A003C012.ari'
//
// which is answerable — "the drive isn't mounted" — but only by someone who
// knows what ENOENT is. The second is worse: it drops the label too, so the
// dialog is a naked "EACCES: permission denied" with nothing saying WHAT the
// user was doing when it happened. They pressed Export; a box appeared; it
// names neither the export nor a next step.
//
// ── Why this is not just friendlyText() ──────────────────────────────────────
//
// friendlyText() returns message and hint as two lines. That is the right
// shape for the error banner, which is a compact strip; it is not the right
// shape for an alert, which is a paragraph box and also has to carry the
// operation label that friendlyText knows nothing about. So this composes from
// the friendlyError() PARTS instead, one per paragraph separated by a blank
// line, rather than post-processing a string friendlyText already assembled.
//
// Both surfaces are solving the same underlying problem: the two most useful
// error rules in a post house end their message with a filesystem path, and on
// a volume whose name contains spaces — most of them — a space-joined hint is
// unreadable, because nothing shows where the path stops and the advice starts:
//
//   That file or folder couldn't be found:
//   /Volumes/SHOW DRIVE 01/reel3/A003C012.ari Check that it still exists and…
//
// An earlier version of this comment claimed the banner could not be fixed the
// same way because it renders through textContent with default white-space.
// That was wrong: .pfx-error-banner has carried `white-space: pre-wrap` since
// the banner was added, so the newline was always going to be honoured there.
//
// ── Testability ──────────────────────────────────────────────────────────────
//
// composeAlert() is pure and returns the string. friendlyAlert() composes,
// dispatches, and ALSO returns it — so a Node test can either check the pure
// function or inject a capture as globalThis.alert. The dispatch target is
// looked up at call time, never captured at import time, which is what makes
// that injection work.
// ─────────────────────────────────────────────────────────────────────────────

import { friendlyError, translate } from './friendlyError.js';

/**
 * composeAlert(err, label) → string. Pure.
 *
 * `label` names the operation in the user's terms ("Reviews CSV export failed")
 * and is the caller's job, not something to be parsed back out of a string the
 * caller just built. It is translated; so are the message and hint, inside
 * friendlyError. `raw` deliberately is not — it never reaches this text.
 *
 * Paragraphs are joined with a blank line, and any part that is empty is left
 * out rather than contributing a gap: an unlabelled call with no matching rule
 * must not produce a dialog that opens with two blank lines.
 */
export function composeAlert(err, label = '') {
  const f = friendlyError(err);
  const head = String(label == null ? '' : label).trim();

  const parts = [];
  if (head) parts.push(translate(head));
  if (f.message) parts.push(f.message);
  if (f.hint) parts.push(f.hint);

  return parts.join('\n\n');
}

/**
 * friendlyAlert(err, label) → the string it showed.
 *
 * Falls back to console.error when there is no alert to call. That branch is
 * not decoration: these are the app's loudest failures, and a context without
 * window.alert — an offscreen document, a blocked iframe — must not turn them
 * into silence. The try/catch is for the same reason; a dispatch that throws
 * has still produced the text, and the caller gets it back.
 */
export function friendlyAlert(err, label = '') {
  const text = composeAlert(err, label);
  try {
    const fn = typeof globalThis !== 'undefined' ? globalThis.alert : null;
    if (typeof fn === 'function') fn(text);
    else if (typeof console !== 'undefined') console.error('[PostFlowX]', text);
  } catch (_) {
    try { console.error('[PostFlowX]', text); } catch (_e) {}
  }
  return text;
}

// Expose globals for non-module / classic-script consumers, matching
// core/friendlyError.js.
if (typeof window !== 'undefined') {
  window.pfxFriendlyAlert = friendlyAlert;
  window.pfxComposeAlert = composeAlert;
}
