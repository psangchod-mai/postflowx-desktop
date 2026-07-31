// scripts/core/confirmText.js
// PostFlowX — the wording for the dialogs that cannot be taken back.
//
// ── The gap this closes ──────────────────────────────────────────────────────
//
// PostFlowX ships in seven languages, and since iteration 27 its *failures*
// have been localised: friendlyError builds every message through window.PFX_t
// and errorI18n.test.mjs fails the build if a sentence reaches six locales in
// English. Nothing does that job for the *confirmations*. All twenty-six
// confirm() calls in the renderer assemble an English template inline at the
// call site, so the one dialog in the app where a wrong click costs a whole
// project folder on disk is a dialog a reader in Bangkok or Seoul is asked to
// parse in a second language, under time pressure, with no undo behind it.
//
// That is the wrong place to be economical. Someone who half-understands
// "This removes PFX/EP103/ from your Project Folder. This cannot be undone."
// and clicks OK does not get an error they can look up — they get silence and
// a missing folder.
//
// ── Why the sentences live here and not at the call site ─────────────────────
//
// The i18n dictionary is keyed on whole English strings, so a template like
//   `Delete project "${name}"? This removes PFX/${name}/ …`
// has no key: the project name is baked into the middle of it. Splitting the
// fixed sentences away from the interpolated name is what makes translation
// possible at all, and a sentence can only be translated if it is a literal
// somewhere a scanner can find it. Here is that somewhere — the same bargain
// friendlyError's RULES table makes, and the reason errorI18n.test.mjs can
// hold this file to the same coverage rule as the rest.
//
// The name and the path are deliberately NOT translated. They are what the
// user typed and where it sits on disk; a localised copy of either would be
// a different folder.
//
// ── Why the path is still shown ──────────────────────────────────────────────
//
// The old inline string named `PFX/<name>/` and that was its one good idea:
// it is the difference between "some project" and "that folder, the one I can
// go and look at in Finder before I answer". Losing it in the name of shorter
// copy would have made the dialog friendlier and less useful. It stays, on its
// own line, where a non-reader of English can still recognise it.

import { translate } from './friendlyError.js';

// A project name is user-typed and can be pasted from anywhere. Newlines would
// let it forge extra lines in a plain-text dialog, and an unbounded name would
// push the consequence sentences off the bottom of the alert — the two lines
// that are the entire point of showing it. Both are folded here rather than at
// the call site so every future caller inherits the fix.
const NAME_MAX = 80;

function cleanName(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  // Counted in code points, not UTF-16 units. Half the audience for this
  // dialog types in Thai, Japanese, Korean or Chinese, and slicing a string
  // mid-surrogate leaves a lone half that renders as “�” — a corrupt-looking
  // name in the one dialog where the reader is checking they recognise it.
  const cp = Array.from(s);
  return cp.length > NAME_MAX ? `${cp.slice(0, NAME_MAX - 1).join('')}…` : s;
}

/**
 * Text for the "Delete Project" confirmation in the project bar.
 *
 * Returns the parts as well as the assembled `text` so a future non-modal
 * dialog can lay them out itself instead of re-splitting a blob on "\n\n".
 *
 * @param {string} name  Project name as typed by the user.
 * @returns {{title:string, detail:string, hint:string, subject:string, text:string}}
 */
export function deleteProjectConfirm(name) {
  const subject = cleanName(name);

  const title = translate('Delete this project?');
  const detail = translate('This deletes the project folder and everything saved inside it.');
  const hint = translate('This cannot be undone — use Save As first if you might need a copy.');

  // The quoted name and the path are one block: two ways of saying which
  // folder, for two kinds of reader. With no name to show, the block is
  // dropped rather than rendered empty — the sentences below it are written
  // so they still stand on their own.
  const blocks = [title];
  if (subject) blocks.push(`“${subject}”\nPFX/${subject}/`);
  blocks.push(`${detail}\n${hint}`);

  return { title, detail, hint, subject, text: blocks.join('\n\n') };
}
