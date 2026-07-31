// scripts/core/confirmText.js
// PostFlowX — the wording for the dialogs that stop someone mid-click.
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
import { comboToDisplay } from './shortcuts.js';

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

// ── The opposite problem: a dialog that frightens people out of a safe edit ───
//
// Not every confirm() is guarding a folder. The marker Delete in Prep & Mark
// asked `Delete "SH010"?` and stopped there — English-only like the rest, but
// with a second fault the project delete did not have: it withheld good news.
// That delete is backed by a hundred-deep undo stack. _pmSlySnapshot() runs on
// the line after the confirm, two Undo buttons sit on screen, Cmd+Z is bound,
// and a voice command reaches the same function.
//
// A bare "Delete X?" is the least useful thing a dialog can say. It repeats the
// button that was just pressed and adds no fact, so the reader has to supply
// the missing one themselves — and the assumption a non-technical user makes in
// a room full of other people's footage is that delete means gone. The cautious
// ones cancel and go and ask someone. That is a real cost, paid every time, for
// an edit that was always safe.
//
// So this dialog carries the same three beats as the one above with the last
// one inverted: what you are deleting, what goes with it, and how to undo it.
//
// ── Why the shortcut is not part of the translated sentence ──────────────────
//
// "Cmd+Z" is wrong on the Windows and Linux extension builds, where the same
// keydown handler answers to Ctrl. Baking the glyph into the sentence would
// need two dictionary keys per language for one idea, and would put a
// platform-specific string behind a translator's judgement. Instead the
// sentence stays platform-neutral and the combo is appended as its own token —
// rendered by comboToDisplay, the function the shortcuts UI already uses, so
// this dialog cannot drift from the rest of the app's key hints.
//
// It renders MOD+KeyZ, which is the combo hard-coded in the Prep & Mark keydown
// handler, NOT whatever the user may have remapped in the shortcuts editor —
// that editor does not reach this handler. Promising the configured combo here
// would be the more impressive-looking lie.

/**
 * Text for the marker "Delete" confirmation in Prep & Mark.
 *
 * The counterpart to deleteProjectConfirm: same shape, but the last line tells
 * the reader the action is reversible instead of warning them that it is not.
 *
 * @param {string} name  Marker's shot name, or its id when it has no name yet.
 * @returns {{title:string, detail:string, hint:string, combo:string, subject:string, text:string}}
 */
export function deleteMarkerConfirm(name) {
  const subject = cleanName(name);

  const title = translate('Delete this marker?');
  const detail = translate('This removes the marker and the note written on it.');
  // No full stop: the combo is appended after it, and a shortcut reads as part
  // of the sentence rather than a footnote to it.
  const hint = translate('You can bring it back with Undo');
  const combo = comboToDisplay('MOD+KeyZ');

  const blocks = [title];
  if (subject) blocks.push(`“${subject}”`);
  blocks.push(`${detail}\n${hint} — ${combo}`);

  return { title, detail, hint, combo, subject, text: blocks.join('\n\n') };
}
