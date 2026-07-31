// scripts/core/workspaceAccess.js
// PostFlowX — one name per workspace, and plain words for being turned away.
//
// ── Four names for one workspace ─────────────────────────────────────────────
//
// A workspace is identified in the DOM by its `data-main` key. Before this
// file, four separate places turned that key into something a person reads,
// and they disagreed. For `prepmark`:
//
//   the tab in the toolbar    src/index.html                "PULLS PREP 2.1"
//   the card in the Toolbox   __PFX_TOOLBOX_MOVABLE_TABS    "PULLS PREP 2.0"
//   the no-access view        _gatedTabs                    (not listed)
//   the refusal toast         the raw data-main key         "prepmark"
//
// and for `platelink2`, which is permission-gated so a user can meet all four:
//
//   the tab in the toolbar    "PLATE LINK 2.0"
//   the card in the Toolbox   "PLATE LINK 2.0"
//   the no-access view        "Plate Link"
//   the refusal toast         "platelink2"
//
// So somebody without access clicks a card marked PLATE LINK 2.0, is told
// `Access denied — "platelink2" tab`, and if they reach it another way reads a
// panel about "Plate Link". Three names, one thing, none of them cross-
// referenced anywhere on screen. Someone who is not an engineer has no reason
// to believe those are the same workspace, and the likelier reading is that
// something else has gone wrong.
//
// It was worse than an inconsistency for the two names that ARE in the
// dictionary. "Plate Link" is translated in all six locales and "PLATE LINK
// 2.0" is in none of them, so in Thai the card said PLATE LINK 2.0 in English
// and the no-access panel said ลิงก์เพลต — the two halves of one event did not
// render in the same language. Same split for `bwav` ("BWAV Inspector" on the
// card, "BWav Tools" in the no-access view) and `preflight` ("Preflight
// Validator" / "Preflight"), and in each pair exactly one side is translated.
//
// WORKSPACE_NAMES below is the one table, and the name it carries is the one
// printed on the tab in the toolbar. That choice is deliberate: the toolbar is
// where a user learns what this workspace is called, it is the only name they
// see during normal work, and it is the same in every language today. Matching
// it means the refusal names the thing they were looking at. Translating one of
// the four surfaces and not the others is what produced the split above.
//
// The card keeps its own decoration (icon, accent colour, order) in ui.js; the
// name comes from here, and workspaceAccess.test.mjs fails the build if the
// table drifts from src/index.html or if ui.js grows a second copy of a name.
//
// ── Why a refusal needs more than "denied" ───────────────────────────────────
//
// Both refusals were dead ends. "Access denied" and "This workspace is not
// enabled for your account." say what already happened and nothing about what
// to do, which leaves clicking again as the only move the interface suggests.
// Access is granted per account by whoever set the account up, so that is the
// sentence worth saying, and it is the one neither message said.
//
// ── The pin that quietly did nothing ─────────────────────────────────────────
//
// The Workspace Tabs panel draws a locked workspace as a greyed card, and
// clicking the card refuses politely. Clicking the *pin* on that same card did
// not: it had no permission check at all, so it wrote `pinned: true` to
// localStorage, redrew the card in its pinned state, and the tab still never
// appeared in the toolbar, because the permission pass hides it. The setting
// persisted across restarts, so the pin stayed lit forever against a tab that
// was never going to show up. Nothing on screen contradicted it and nothing
// explained it. That is the worst shape a permission failure can take: the app
// agreeing with you and then not doing it.

import { translate } from './friendlyError.js';

// ── The one table ────────────────────────────────────────────────────────────
// Keyed by `data-main`, valued with the tab's own label from src/index.html,
// verbatim. Covers every workspace that can be pinned or permission-gated —
// the union of _gatedTabs and __PFX_TOOLBOX_MOVABLE_TABS in ui.js. `home`,
// `renderq` and `about` are neither, so they are deliberately absent.
export const WORKSPACE_NAMES = Object.freeze({
  aceslook:   'ACES LOOK',
  bwav:       'BWAV INSPECTOR',
  cutdiff2:   'CUT DIFF 2.0',
  imf:        'IMF VALIDATION',
  platelink2: 'PLATE LINK 2.0',
  preflight:  'PREFLIGHT',
  prepmark:   'PULLS PREP 2.1',
  reviews:    'VISUAL QC',
  trlconf:    'TRAILERS CONFORM',
});

// These are product names, so translate() is a pass-through for all six locales
// today and the call is here for the day one of them wants its own spelling.
// A key the table does not know falls back to the key itself: still poor, but
// it is what an admin would search for, and the test above makes it unreachable
// for any workspace ui.js actually gates.
export function workspaceName(key) {
  const k = String(key == null ? '' : key).trim();
  if (!k) return '';
  // hasOwn, not a plain lookup: `data-main` comes off the DOM, and a tab with
  // data-main="constructor" would otherwise find Object.prototype.constructor,
  // hand a *function* to translate(), and render "function Object() { … }" in a
  // toast. Not reachable from today's markup; one attribute away from being so.
  const label = Object.hasOwn(WORKSPACE_NAMES, k) ? WORKSPACE_NAMES[k] : '';
  return label ? translate(label) : k;
}

// ── Being turned away ────────────────────────────────────────────────────────

// Shown when someone opens, or tries to open, a workspace their account does
// not include. Two sentences: what happened, named the way the tab names it,
// and who can change it. No "denied", no error code, no raw key.
export function lockedWorkspaceNotice(state = {}) {
  const name = workspaceName(state.key);
  const opening = name
    ? `${translate('This workspace is not part of your account')}: “${name}”`
    : translate('This workspace is not part of your account');
  const next = translate('Ask whoever set up your PostFlowX account to add it. Nothing here is broken.');
  return { name, opening, next, text: `${opening}\n${next}` };
}

// Shown when someone pins a workspace they cannot open. Says the thing the
// silent version could not: pinning it would not help, because the tab still
// would not appear. The closing sentence is the same one as above — the remedy
// is the same, so the words are the same, and there is one translation to keep
// right instead of two that can drift apart.
export function lockedPinNotice(state = {}) {
  const name = workspaceName(state.key);
  const opening = name
    ? `${translate('Pinning this will not make the tab appear, because your account does not include this workspace')}: “${name}”`
    : translate('Pinning this will not make the tab appear, because your account does not include this workspace');
  const next = translate('Ask whoever set up your PostFlowX account to add it. Nothing here is broken.');
  return { name, opening, next, text: `${opening}\n${next}` };
}
