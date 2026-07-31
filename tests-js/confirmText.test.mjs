// ─────────────────────────────────────────────────────────────────────────────
// The one dialog with no undo behind it, in a language you only half-read.
//
// PostFlowX ships in seven languages and has localised its *failures* since
// iteration 27: friendlyError builds every message through window.PFX_t, and
// errorI18n.test.mjs fails the build the moment a sentence would reach six
// locales in English. None of that machinery was ever pointed at the
// *confirmations*. All twenty-six confirm() calls in the renderer assembled an
// English template inline, including the most expensive one in the app:
//
//     Delete project "EP103"?
//
//     This removes PFX/EP103/ from your Project Folder. This cannot be undone.
//
// That is the project-bar Delete, and it deletes a folder off the disk. Two
// things were wrong with it at once. It was English-only, so a reader in
// Bangkok or Seoul was asked to parse the only warning they would ever get in
// a second language. And the warning itself was packed into the tail of a
// paragraph that opens with a path — so the two clauses that decide the
// answer, "everything inside it goes" and "nothing brings it back", are the
// last things read rather than the first.
//
// A misread failure message costs a search. A misread delete costs the folder.
//
// core/confirmText.js is where that wording lives now: the sentences are
// literals a scanner can find, they run through the same translate() shim, and
// the name and path — the two things that must NOT be translated, because they
// are what the user typed and where it sits on disk — are interpolated around
// them.
//
// ── What this file holds and what errorI18n.test.mjs holds ───────────────────
//
// The dictionary coverage is not repeated here. errorI18n.test.mjs already
// scans core/confirmText.js for translate() literals and fails if any of the
// six locales is missing one, copies the English, or carries a dead key. This
// file is the other half: that the text is *assembled* correctly, that a
// pasted project name cannot forge lines in a plain-text dialog, and that the
// ui.js call site did not keep its old template alongside the new module.
// ─────────────────────────────────────────────────────────────────────────────

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const { deleteProjectConfirm } = await import('../src/scripts/core/confirmText.js');

const uiSrc = readFileSync(
  fileURLToPath(new URL('../src/scripts/ui.js', import.meta.url)), 'utf8',
);

// translate() reads window.PFX_t at call time, so a test can install one and
// take it away again. Nothing else in this module touches the DOM.
function withTranslator(fn, body) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
  const prev = globalThis.window;
  globalThis.window = { PFX_t: fn };
  try { return body(); }
  finally {
    if (had) globalThis.window = prev; else delete globalThis.window;
  }
}

// ── The dialog says the things a delete dialog has to say ────────────────────

test('the consequence and the irreversibility are both stated', () => {
  // The regression this guards is a wording edit that trims the dialog back to
  // "Delete project X?" — which is what the CutDiff copy of this code still
  // says, and which tells the reader nothing they did not already know from
  // the button they just pressed.
  const { text } = deleteProjectConfirm('EP103_VFX');
  assert.match(text, /everything saved inside it/, 'the dialog no longer says what goes');
  assert.match(text, /cannot be undone/, 'the dialog no longer says it is permanent');
});

test('the name and the folder path both survive into the text', () => {
  // Two ways of naming the same folder, for two kinds of reader: the name they
  // typed, and the path they can go and look at in Finder before answering.
  // The old inline string had the path and it was its one good idea.
  const { text, subject } = deleteProjectConfirm('EP103_VFX');
  assert.equal(subject, 'EP103_VFX');
  assert.match(text, /“EP103_VFX”/);
  assert.match(text, /PFX\/EP103_VFX\//);
});

test('the question comes before the path, not after it', () => {
  // Reading order is the whole point of splitting the paragraph up. If a later
  // refactor reassembles it the other way round, the warning goes back to
  // being the tail of something that opens with a path.
  const { text } = deleteProjectConfirm('EP103_VFX');
  assert.ok(
    text.indexOf('Delete this project?') < text.indexOf('PFX/'),
    'the path is now shown before the question it belongs to',
  );
  assert.ok(
    text.indexOf('PFX/') < text.indexOf('cannot be undone'),
    'the consequence is no longer the last thing read',
  );
});

// ── A project name is user input, and this is a plain-text dialog ────────────

test('a pasted newline cannot forge extra lines in the dialog', () => {
  // There is no markup to escape in a confirm(), but there is layout: a name
  // carrying "\n\nThis is safe." would render as its own paragraph, in the
  // same voice as the sentences the app wrote. Whitespace is folded, so the
  // name stays one line no matter what was on the clipboard.
  const { text, subject } = deleteProjectConfirm('EP103\n\nThis is safe to delete.');
  assert.equal(subject, 'EP103 This is safe to delete.');
  // It may appear twice — once quoted, once inside the path — but never on a
  // line of its own, which is the shape that reads as the app talking.
  const forged = text.split('\n').filter((l) => l.trim() === 'This is safe to delete.');
  assert.deepEqual(forged, [], 'the pasted text was allowed to occupy a line of its own');
  assert.equal(text.split('\n\n').length, 3, 'the name broke the dialog into extra blocks');
});

test('a very long name cannot push the warning off the dialog', () => {
  // An 800-character name would scroll the two sentences that matter out of an
  // alert box that does not scroll. Clamped, with an ellipsis so the reader can
  // see it was clamped rather than think the name is wrong.
  const { subject, text } = deleteProjectConfirm('A'.repeat(800));
  assert.ok(subject.length <= 80, `name was not clamped: ${subject.length} chars`);
  assert.ok(subject.endsWith('…'), 'a clamped name should show that it was clamped');
  assert.match(text, /cannot be undone/, 'the warning was pushed out by the name');
});

test('clamping a name never cuts a character in half', () => {
  // The clamp counts code points, not UTF-16 units. A name of emoji or CJK
  // pairs sliced at unit 79 would end in a lone surrogate and render as “�” —
  // which, in the dialog where the reader is checking they recognise the
  // project, looks like the app already corrupted something.
  const { subject } = deleteProjectConfirm('🎬'.repeat(100));
  // /u throughout: without it, "🎬+" repeats only the trailing low surrogate.
  assert.match(subject, /^🎬+…$/u, `clamp broke a surrogate pair: ${JSON.stringify(subject)}`);
  // \p{Surrogate} under /u matches only *unpaired* halves — a well-formed
  // pair is one code point and is not in the category.
  assert.doesNotMatch(subject, /\p{Surrogate}/u, 'a lone surrogate survived the clamp');
  assert.equal(Array.from(subject).length, 80, 'the clamp is not counting code points');
});

test('an empty name drops the name block instead of rendering it empty', () => {
  // The call site guards against this, but a dialog reading “” over PFX//
  // would be worse than no dialog, and the sentences are written to stand
  // without it.
  const { text, subject } = deleteProjectConfirm('   ');
  assert.equal(subject, '');
  assert.doesNotMatch(text, /PFX\//, 'rendered a path with no project in it');
  assert.doesNotMatch(text, /“”/, 'rendered an empty pair of quotes');
  assert.match(text, /Delete this project\?/);
  assert.match(text, /cannot be undone/);
});

test('null and undefined are handled like an empty name, not stringified', () => {
  for (const v of [null, undefined]) {
    const { text } = deleteProjectConfirm(v);
    assert.doesNotMatch(text, /null|undefined/, `${v} leaked into the dialog`);
  }
});

// ── Localisation: the sentences go through the shim, the folder does not ─────

test('every sentence is offered to the translator', () => {
  const seen = [];
  const { text } = withTranslator((s) => { seen.push(s); return `[${s}]`; },
    () => deleteProjectConfirm('EP103_VFX'));
  assert.deepEqual(seen, [
    'Delete this project?',
    'This deletes the project folder and everything saved inside it.',
    'This cannot be undone — use Save As first if you might need a copy.',
  ], 'a sentence was assembled without passing through translate()');
  assert.match(text, /\[Delete this project\?\]/, 'the translation was discarded');
});

test('the project name and its path are never translated', () => {
  // A localised copy of either is a different folder. This is the one part of
  // the dialog that has to come back byte-identical in all seven languages.
  const { text } = withTranslator(() => 'ลบโปรเจกต์นี้หรือไม่?',
    () => deleteProjectConfirm('EP103_VFX'));
  assert.match(text, /“EP103_VFX”/);
  assert.match(text, /PFX\/EP103_VFX\//);
});

test('a translator that throws still yields a usable dialog', () => {
  // i18n.js installs PFX_t asynchronously; a delete pressed before it settles,
  // or a dictionary bug, must not turn the last warning before an irreversible
  // action into an exception at the call site.
  const { text } = withTranslator(() => { throw new Error('dict not ready'); },
    () => deleteProjectConfirm('EP103_VFX'));
  assert.match(text, /Delete this project\?/);
  assert.match(text, /cannot be undone/);
});

// ── The call site actually uses it ───────────────────────────────────────────

test('ui.js builds the delete dialog from this module', () => {
  // A pure module nobody calls is worth nothing, and the specific way this
  // goes wrong is that the new module lands, the old template is left in place
  // "for now", and the localised text never reaches a user.
  assert.match(uiSrc, /deleteProjectConfirm/, 'ui.js does not call deleteProjectConfirm');
  assert.match(
    uiSrc, /import \{ deleteProjectConfirm \} from "\.\/core\/confirmText\.js"/,
    'ui.js does not import the module it calls',
  );
  assert.doesNotMatch(
    uiSrc, /This removes PFX\/\$\{name\}\//,
    'the old English-only delete template is still in ui.js',
  );
});
