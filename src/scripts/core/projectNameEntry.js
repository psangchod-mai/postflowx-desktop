// scripts/core/projectNameEntry.js
// PostFlowX — the words around the one box where a person types a project name.
//
// ── What was there ───────────────────────────────────────────────────────────
//
// Save As was one line:
//
//   const nn = prompt("Save As - Project name", cur);
//   if (!nn) return;
//
// Four things are wrong with it and all four land on the same reader.
//
// *It is a developer's label.* "Save As - Project name" is a field name, not a
// question. It is also the last untranslated string on the project bar — the
// app can be running entirely in Thai and this dialog is in English.
//
// *Cancel and blank are the same event.* `!nn` is true for `null` (the reader
// pressed Cancel) and for `""` (the reader pressed OK with an empty box).
// Cancelling should do nothing silently, because the reader said no. Pressing
// OK on an empty box is a request that failed, and answering it with silence
// teaches people the button is broken.
//
// *The name is not trimmed.* A trailing space from a paste went straight into
// the name box and into every scope that mirrors it.
//
// *Nothing says what a project name is for.* It becomes a folder on disk, and
// core/projectFolderName.js rewrites the characters a folder name cannot hold.
// That rewrite is no longer a collision — iteration 155 fixed that — but it is
// still invisible: type "EP103 Reel 2" and the folder is "EP103_Reel_2", and
// the first time anyone finds out is when they go looking in Finder.
//
// ── Why the sentences live here ──────────────────────────────────────────────
//
// Same bargain core/confirmText.js and core/failureText.js made: a literal at a
// call site inside a 25,000-line DOM module is a literal no scanner reaches and
// no test can hold. Here they are `translate()` calls in a module that imports
// with no DOM, so tests-js/errorI18n.test.mjs can prove all six locales have
// them and this file's own test can prove the rules are right.

import { translate } from './friendlyError.js';

/**
 * What the Save As dialog asks.
 *
 * Two lines, because there are two things the reader needs and only one of
 * them is a question. The second line is the part that was missing: it says
 * the name becomes a folder and that spaces will not survive into it, so the
 * rewrite is something the reader was told about rather than something they
 * discover in Finder a week later.
 *
 * @returns {string} The prompt label, translated.
 */
export function saveAsPromptLabel() {
  return `${translate('Save a copy of this project under a new name')}\n${
    translate('Spaces and punctuation become underscores in the folder on disk.')}`;
}

/**
 * Whether a typed project name can be used, and what to say if it cannot.
 *
 * Deliberately not called for a cancelled dialog — see `isCancelled`. The only
 * thing that can be wrong with a name now that the folder rule accepts every
 * language is that there is no name, which includes a box holding nothing but
 * spaces.
 *
 * @param {string|null|undefined} typed Exactly what came back from the dialog.
 * @returns {string} A translated sentence to show, or '' if the name is fine.
 */
export function nameEntryProblem(typed) {
  const name = String(typed == null ? '' : typed).trim();
  if (!name) return translate('Type a name for the project before saving the copy.');
  return '';
}

/**
 * Whether the reader said no.
 *
 * `prompt()` returns `null` for Cancel and `''` for OK-on-an-empty-box, and the
 * old code collapsed both into `!nn`. Separating them is the whole point: one
 * is an answer and gets silence, the other is a failed request and gets a
 * sentence. Kept as a named function rather than an inline `=== null` so the
 * distinction is something a test can pin.
 *
 * @param {string|null|undefined} raw The raw dialog result.
 * @returns {boolean} True when the reader dismissed the dialog.
 */
export function isCancelled(raw) {
  return raw == null;
}

/**
 * The name to actually use, given what was typed.
 *
 * Trimming is not cosmetic here: the string is mirrored into every scope, put
 * in the name box, and handed to the folder rule, and a pasted trailing space
 * would otherwise make "EP103 " and "EP103" look like two projects in the
 * recents list while resolving to one folder.
 *
 * @param {string|null|undefined} typed
 * @returns {string}
 */
export function cleanProjectName(typed) {
  return String(typed == null ? '' : typed).replace(/\s+/g, ' ').trim();
}
