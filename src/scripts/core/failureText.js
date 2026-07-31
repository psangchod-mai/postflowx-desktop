// scripts/core/failureText.js
// PostFlowX — turning a project-file result code into a sentence.
//
// ── The gap this closes ──────────────────────────────────────────────────────
//
// core/projectFile.js reports every failure as a short machine code on the
// result object: `{ ok:false, reason:'no_permission' }`. Twenty-four distinct
// codes, and nothing on the object is written for a person to read. That is
// the right design for a module boundary and the wrong thing to put on screen.
//
// It ends up on screen anyway. The save handler in ui.js does
//
//   const msg = String(r?.error || r?.reason || "Save failed");
//   setProjectSaveStatus(`Save failed: ${msg}`, "error");
//   showError(msg);
//
// and none of the save-path failures carry an `error` field, so `r.reason` is
// what falls through. A colourist who has restarted their Mac since granting
// folder access — the single most common way this app breaks, because the
// File System Access handle does not survive it — presses Cmd+S and reads:
//
//   Save failed: no_permission
//
// in the status pill, and `no_permission` again in the banner underneath. In
// English, in all seven languages. It names no cause a person can act on, and
// the one thing that fixes it in four seconds — re-pick the Project Folder
// from the gear icon — appears nowhere. The realistic outcome is that they
// keep pressing Cmd+S, believe the work is saved because the app is at least
// *responding*, and lose the session.
//
// ── Load says the wrong thing, which is worse than saying nothing ────────────
//
// Three of the four load call sites ignore `reason` entirely and print
// "Project not found in Project Folder." for every failure. When the cause is
// a lapsed permission or an unset folder, that sentence is false, and it is
// false in the direction that frightens people: it tells an editor their
// project is gone when the file is sitting on disk, untouched, one dialog
// away. Someone who believes it starts rebuilding the day's work.
//
// ── Why a table and not a `switch` at each call site ─────────────────────────
//
// Delete already has the switch — five `else if`s on `r.reason`, written in
// English at the call site, covering four of the six codes delete can return.
// That is the shape this module exists to replace: it cannot be translated (a
// literal at a call site is a literal no scanner reaches), it cannot be
// tested (the call site is a click handler inside a 25,000-line DOM module),
// and it drifts the moment projectFile.js adds a code — which is how
// `bad_name` and `delete_failed` came to fall through to "Delete failed."
//
// Here the mapping is data, the sentences are literals a scanner can find, and
// the whole thing is importable by a test with no DOM. Same bargain
// core/confirmText.js made for the confirmations.
//
// ── The fallback is the part that matters ────────────────────────────────────
//
// An unknown code must never reach the reader as itself. Codes get added to
// projectFile.js by whoever is writing the feature, not by whoever is thinking
// about the seven languages, so the default path is the one that will actually
// run in a year. It resolves to a sentence about the operation — "The project
// could not be saved" — which is vague but true, translated, and never
// `templates_dir_failed`.

import { translate } from './friendlyError.js';

/**
 * Operations a project-file result can come back from. The same cause needs a
 * different sentence depending on which button was pressed: no Project Folder
 * blocks a save because there is nowhere to put the file, and blocks a load
 * because there is nowhere to look.
 */
export const PROJECT_OPS = Object.freeze(['save', 'load', 'delete']);

/**
 * Every `reason` string core/projectFile.js can return, grouped by what the
 * reader has to do about it. Grouping is the point: `pfx_dir_failed` and
 * `tabs_dir_failed` are different lines of code and the same bad afternoon.
 *
 * Codes not listed here fall to 'unknown' by design — see the header.
 */
const CAUSE_BY_REASON = Object.freeze({
  no_dir: 'no_folder',

  no_permission: 'no_access',

  not_found: 'missing',
  missing_tab_file: 'missing',
  template_not_found: 'missing',
  no_templates: 'missing',
  empty: 'missing',

  bad_name: 'bad_name',
  dest_exists: 'name_taken',

  bad_tab: 'unsupported',
  no_api: 'unsupported',
  no_native: 'unsupported',
  unsupported: 'unsupported',
  not_supported: 'unsupported',

  write_failed: 'disk_failed',
  create_failed: 'disk_failed',
  delete_failed: 'disk_failed',
  delete_src_failed: 'disk_failed',
  apply_failed: 'disk_failed',
  pfx_dir_failed: 'disk_failed',
  tabs_dir_failed: 'disk_failed',
  templates_dir_failed: 'disk_failed',

  throttled: 'busy',
  cancel: 'cancelled',
  no_account_permission: 'not_allowed',
});

export const FAILURE_CAUSES = Object.freeze([
  'no_folder', 'no_access', 'missing', 'bad_name', 'name_taken',
  'unsupported', 'disk_failed', 'busy', 'cancelled', 'not_allowed', 'unknown',
]);

/**
 * Two causes must not raise a banner at all.
 *
 * 'cancelled' is the user closing a folder picker — an answer, not a failure,
 * and an app that scolds you for saying no teaches you to distrust its errors.
 *
 * 'not_allowed' is the account permission gate, which fires its own toast
 * through window.PFX_GUARD before returning. Iteration 151 fixed exactly this
 * double-report for one caller by special-casing the code in ui.js; carrying
 * the fact on the notice instead means the next caller inherits it.
 */
const SILENT = Object.freeze(['cancelled', 'not_allowed']);

/**
 * @param {string|undefined|null} reason
 * @returns {string} one of FAILURE_CAUSES
 */
export function failureCause(reason) {
  const key = String(reason == null ? '' : reason).trim();
  // Own-property check: a result object built from user data could carry
  // `reason: 'constructor'`, and an inherited hit would return a function.
  return Object.hasOwn(CAUSE_BY_REASON, key) ? CAUSE_BY_REASON[key] : 'unknown';
}

function titleFor(cause, op) {
  switch (cause) {
    case 'no_folder':
      return op === 'save'
        ? translate('PostFlowX has nowhere to save this project yet')
        : translate('PostFlowX does not know where your projects are kept');
    case 'no_access':
      return translate('PostFlowX cannot open your Project Folder');
    case 'missing':
      return translate('There is no project by that name in your Project Folder');
    case 'bad_name':
      return translate('That project name cannot be used');
    case 'name_taken':
      return translate('A project with that name already exists');
    case 'unsupported':
      return translate('This version of PostFlowX cannot do that');
    case 'disk_failed':
      return translate('PostFlowX could not finish that change on disk');
    case 'busy':
      return translate('PostFlowX is still finishing the last save');
    case 'not_allowed':
      return translate('Your account cannot change this project');
    case 'cancelled':
      return translate('Nothing was changed');
    default:
      // The fallback the header is about. Vague and true beats precise and
      // unreadable, and it is the branch an unrecognised future code takes.
      if (op === 'load') return translate('The project could not be opened');
      if (op === 'delete') return translate('The project could not be deleted');
      return translate('The project could not be saved');
  }
}

function hintFor(cause) {
  switch (cause) {
    case 'no_folder':
      return translate('Open the gear icon and pick a Project Folder first.');
    case 'no_access':
      // The whole reason this module exists. Access is lost on restart, on an
      // unplugged drive, and on a folder that moved; the remedy is the same
      // four seconds in every case, and nothing on screen used to say it.
      return translate('Open the gear icon and pick your Project Folder again to restore access.');
    case 'missing':
      return translate('Check the name, or use Load to open a project.json file directly.');
    case 'bad_name':
      return translate('Try a shorter name using letters, numbers, spaces and dashes.');
    case 'name_taken':
      return translate('Pick a different name, or delete the old project first.');
    case 'unsupported':
      return translate('This needs the desktop app — the browser extension cannot reach your Project Folder.');
    case 'disk_failed':
      return translate('Check there is free space and that the folder is still connected.');
    case 'busy':
      return translate('Wait a moment and try again.');
    case 'not_allowed':
      // Word for word the sentence the guard toast uses, so the two surfaces
      // read as one event rather than two opinions.
      return translate('Ask whoever set up your PostFlowX account if you need to make changes.');
    case 'cancelled':
      return '';
    default:
      return translate('Try again — if it keeps happening, restart PostFlowX.');
  }
}

// A project name is user-typed and can be pasted from anywhere. Same folding
// and the same code-point-safe clamp as core/confirmText.js, for the same
// reason: this string goes into a status pill and an alert, and a name with a
// newline in it can forge a second line that looks like it came from the app.
const NAME_MAX = 60;

function cleanName(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const cp = Array.from(s);
  return cp.length > NAME_MAX ? `${cp.slice(0, NAME_MAX - 1).join('')}…` : s;
}

/**
 * Explain a failed core/projectFile.js result.
 *
 * Returns the parts as well as the assembled `text`, so a caller with two
 * places to put words — the save-status pill takes one line, the banner takes
 * three — can use the title alone without re-splitting a blob on "\n".
 *
 * @param {{reason?:string, error?:string}|null|undefined} result
 * @param {'save'|'load'|'delete'} op
 * @param {string} [name] Project name as typed by the user, if there is one.
 * @returns {{cause:string, title:string, hint:string, subject:string, silent:boolean, text:string}}
 */
export function projectFailure(result, op, name) {
  const operation = PROJECT_OPS.includes(op) ? op : 'save';
  const cause = failureCause(result && result.reason);
  const subject = cleanName(name);

  const title = titleFor(cause, operation);
  const hint = hintFor(cause);

  const blocks = [title];
  // The name earns its line only where the reader is being asked something
  // about that specific project. On a permission failure it is noise: the
  // folder is unreachable for every project, and naming one implies the
  // others are fine.
  if (subject && (cause === 'missing' || cause === 'name_taken')) blocks.push(`“${subject}”`);
  if (hint) blocks.push(hint);

  return {
    cause,
    title,
    hint,
    subject,
    silent: SILENT.includes(cause),
    text: blocks.join('\n'),
  };
}

/**
 * The one place a failed load is not the end of the story: the Project
 * Manager's Open falls through to the file picker instead of stopping. The
 * old wording — "Could not load "X" — opening file picker." — carried that
 * promise in the same breath as the (wrong) diagnosis. Splitting the two lets
 * `projectFailure` say what actually happened while this keeps the promise,
 * so the reader is not surprised by a dialog they did not ask for.
 *
 * @returns {string} A translated sentence to append under `projectFailure().text`.
 */
export function pickerFallbackNote() {
  return translate('PostFlowX will open the file picker so you can find the project yourself.');
}

/**
 * The success half of the same pill. `Loaded ${name}` was built inline at seven
 * call sites, in English, in all seven languages — the last raw string on the
 * project bar and the only thing the bar says when everything goes right.
 *
 * The name is substituted rather than concatenated. "Opened" plus a name is a
 * sentence in English word order and nothing at all in Korean or Japanese; a
 * `{name}` slot lets each locale put the project where its grammar wants it.
 * The wording moves from "Loaded" to "Opened" to match the button that was
 * pressed — the app has Open buttons, not Load buttons, everywhere the reader
 * can see.
 *
 * @param {string} [name] Project name as typed by the user, if there is one.
 * @returns {string} A translated sentence for the status pill.
 */
export function openedNotice(name) {
  const subject = cleanName(name);
  if (!subject) return translate('Project opened');
  return translate('Opened “{name}”').replace('{name}', subject);
}

/**
 * Which project name the box should be showing once an attempt has settled.
 *
 * Every load path in ui.js writes the wanted name into the box *before* it
 * tries, because that is what makes the click feel instant. None of them put
 * it back when the try fails, so a failed Open leaves the bar reading
 * "EP103_Reel2" while the app is still holding whatever was open before — or,
 * at launch, holding nothing at all. The pill says it failed and the box says
 * it worked, and the box is the one people believe.
 *
 * The rule is one line, but it has to be the same line at four call sites, so
 * it lives here where a test can hold it rather than being re-typed at each.
 *
 * @param {string} previous The name in the box before the attempt started.
 * @param {string} attempted The name the attempt was for.
 * @param {boolean} ok Whether the attempt succeeded.
 * @returns {string} The name to leave in the box; '' means show nothing.
 */
export function settledProjectName(previous, attempted, ok) {
  const want = String(attempted == null ? '' : attempted).trim();
  const had = String(previous == null ? '' : previous).trim();
  return (ok && want) ? want : had;
}
