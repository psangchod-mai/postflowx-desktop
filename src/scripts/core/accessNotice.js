// scripts/core/accessNotice.js
// PostFlowX — the words on the locked-out screen.
//
// ── The full-screen version of a problem already fixed once ──────────────────
//
// core/workspaceAccess.js gave the *toast* a name and a next step: click a
// workspace your account does not include and PostFlowX now says which
// workspace it was and who can add it. But a toast is the small version of
// being turned away. The large version is auth/noAccessView.js, which replaces
// an entire tab pane with a lock icon and three lines of text, and those three
// lines had none of that work applied to them:
//
//   "Access Restricted"
//   "You don't have permission to access this feature with your current role."
//
// Two problems, and the second is the bigger one.
//
// First, it does not match. The toast that fired one click earlier said "This
// workspace is not part of your account: PLATE LINK 2.0". The panel says
// "Access Restricted" and mentions a "role". Same event, two vocabularies, and
// "role" is a word from the admin console — a colourist reading it has no way
// to know whether a role is something they have, something they lost, or
// something they were supposed to set up themselves. The heading here is now
// the same sentence the toast uses, so the two halves of one event read as one
// event.
//
// Second, and worse: every string in that panel was English. All of it —
// heading, body, the contact line, the pending hint. PostFlowX ships in seven
// languages, so a user in Bangkok working in Thai all day would hit a
// full-screen wall of English at the exact moment they most need to understand
// what happened. Not a mis-translation, not a fallback: the panel had no
// dictionary rows at all, because nothing scanned it. Adding this module to
// SCANNED in errorI18n.test.mjs is what makes that impossible to repeat.
//
// ── Why "pending" gets a button and the others do not ────────────────────────
//
// The pending state ended on "Already approved? Reload PostFlowX to refresh
// your session." — an instruction with no control next to it. Reloading an
// Electron app means knowing about ⌘R, which is precisely the knowledge a
// non-technical user does not have, and the sentence gave no hint that a
// keystroke was what it meant. So pending, and only pending, carries a real
// button: it is the one state the user can actually resolve from this screen.
// Denied and disabled cannot be fixed by reloading, so offering the button
// there would only invite a person to try the same thing repeatedly.
//
// ── Shape ────────────────────────────────────────────────────────────────────
//
// Everything here is a pure function of (status, workspace key, contact). No
// DOM, no window, no side effects — auth/noAccessView.js does the rendering and
// this file decides what it says, which is the only half worth unit-testing and
// the half that was silently wrong.

import { translate } from './friendlyError.js';
import { workspaceName, WORKSPACE_NAMES, lockedWorkspaceNotice } from './workspaceAccess.js';

// Where an access request actually goes. Overridable per call so a future
// deployment can point somewhere else without touching the copy.
export const ACCESS_CONTACT = 'sangchod@netflix.com';

// The three states auth/permissions.js can report. Anything else is treated as
// 'denied', which is the state that says the least and promises nothing.
export const ACCESS_STATUSES = Object.freeze(['pending', 'disabled', 'denied']);

export function accessStatus(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return ACCESS_STATUSES.includes(s) ? s : 'denied';
}

// Built per call rather than as a frozen table because every value is a
// translate() result, and translate() reads the live locale — a table built at
// import time would freeze whatever language the app started in and keep
// showing it after the user switches.
function _wording(status) {
  if (status === 'pending') {
    return {
      heading: translate('Your account is waiting to be approved'),
      body: translate('Someone has to approve it before this opens. You will get an email when that happens.'),
    };
  }
  if (status === 'disabled') {
    return {
      heading: translate('This account has been switched off'),
      body: translate('Ask whoever set up your PostFlowX account to switch it back on.'),
    };
  }
  // Word for word what lockedWorkspaceNotice() puts in the toast. Deliberate:
  // one event, one sentence, and one dictionary row to keep right.
  return {
    heading: translate('This workspace is not part of your account'),
    body: translate('Ask whoever set up your PostFlowX account to add it. Nothing here is broken.'),
  };
}

/**
 * Everything the no-access panel says, for one status and one workspace.
 *
 * @param {object} state
 * @param {string} [state.status]  'pending' | 'disabled' | 'denied' (anything else → denied)
 * @param {string} [state.key]     the workspace's `data-main` key, e.g. 'platelink2'
 * @param {string} [state.contact] override the access-request address
 * @returns {{status:string, name:string, heading:string, body:string,
 *            contactLabel:string, contact:string, hint:string, reloadLabel:string}}
 *          `hint` and `reloadLabel` are empty for every status but 'pending'.
 */
export function accessNotice(state = {}) {
  const status = accessStatus(state.status);
  const { heading, body } = _wording(status);
  const contact = String(state.contact || '').trim() || ACCESS_CONTACT;
  const pending = status === 'pending';
  return {
    status,
    // Same table the tab strip and the Toolbox card read from, so the badge on
    // this panel is the name the user was just looking at.
    name: workspaceName(state.key),
    heading,
    body,
    contactLabel: translate('To ask for access, write to'),
    contact,
    hint: pending ? translate('Already approved? Reload PostFlowX to pick up the change.') : '',
    reloadLabel: pending ? translate('Reload PostFlowX') : '',
  };
}

// Every actionId that can reach the refusal toast, as the name of the thing the
// user just tried to do, in their language.
//
// This table used to live in auth/noAccessView.js with bare English values. It
// was invisible to errorI18n.test.mjs for a structural reason worth stating:
// the scanner only sees a string literal written straight into the translate
// call, and the view resolved the id to a label first, handing the notice a
// *variable* it could not read. So the toast came
// out half-translated — a Thai sentence with an English noun quoted inside it,
// which is a worse result than either language on its own. Written as literals
// here, all 22 are scanned, and the test refuses to let one ship untranslated.
//
// Built per call for the same reason _wording() is: translate() reads the live
// locale, so a table built at import time would freeze the boot language.
function _actionNames() {
  return {
    open_project:         translate('Open Project'),
    save_project:         translate('Save Project'),
    load_timeline:        translate('Load Timeline'),
    load_video:           translate('Load Video'),
    view_markers:         translate('View Markers'),
    add_marker:           translate('Add Marker'),
    edit_marker_meta:     translate('Edit Marker Metadata'),
    delete_marker:        translate('Delete Marker'),
    open_annotation:      translate('Open Annotation'),
    edit_annotation:      translate('Edit Annotation'),
    export_csv:           translate('Export CSV'),
    export_pdf:           translate('Export PDF'),
    export_xlsx:          translate('Export XLSX'),
    export_package:       translate('Export Package'),
    relink_all:           translate('Relink All'),
    export_amf:           translate('Export AMF'),
    export_cdl:           translate('Export CDL'),
    export_clf:           translate('Export CLF'),
    export_color_summary: translate('Export Summary'),
    save_aces_preset:     translate('Save Preset'),
    load_aces_preset:     translate('Load Preset'),
    open_aces_look:       translate('Open ACES Look'),
  };
}

/**
 * The translated name of a blocked action, or '' when there is nothing
 * nameable — never the raw id.
 *
 * The empty string is the deliberate answer for an unknown id. Action ids are
 * internal keys, and a toast reading `Your account cannot do this:
 * "edit_marker_meta"` teaches the user a word from the permissions schema and
 * then asks them to quote it at someone. The bare sentence is less information
 * and more help.
 *
 * @param {string} actionId
 * @returns {string}
 */
export function actionName(actionId) {
  const id = String(actionId == null ? '' : actionId).trim();
  if (!id) return '';
  const names = _actionNames();
  // hasOwn, not a plain lookup: actionId reaches here from call sites all over
  // the renderer, and `constructor` would otherwise resolve up the prototype
  // chain and put a function body in the toast.
  if (Object.hasOwn(names, id)) return names[id];
  // A workspace key is not an action, but openTab() hands one to the same
  // toast. Let the workspace table answer rather than showing 'platelink2'.
  if (Object.hasOwn(WORKSPACE_NAMES, id)) return workspaceName(id);
  return '';
}

/**
 * The three-second toast for an action — not a whole workspace — the account
 * cannot perform. Was "⊘ Permission denied: Export CSV", which is a security
 * log line rather than a sentence; the ⊘ and the word "denied" both read as an
 * accusation, and neither says whose account it is or that it can be changed.
 *
 * Given a workspace key rather than an action id, it answers with the workspace
 * sentence instead — word for word the one lockedWorkspaceNotice() already
 * produces for that event, because clicking a locked tab is that event.
 *
 * @param {object} state
 * @param {string} [state.id] the actionId (or workspace `data-main` key) that was blocked
 * @returns {{label:string, text:string}}
 */
export function deniedActionNotice(state = {}) {
  const id = String(state.id == null ? '' : state.id).trim();
  if (Object.hasOwn(WORKSPACE_NAMES, id)) {
    const w = lockedWorkspaceNotice({ key: id });
    return { label: w.name, text: w.text };
  }
  const label = actionName(id);
  const opening = translate('Your account cannot do this');
  return { label, text: label ? `${opening}: “${label}”` : opening };
}
