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

const {
  deleteProjectConfirm, deleteMarkerConfirm, deleteProxyConfirm,
  resetSettingsConfirm, resetNoteTypesConfirm,
} = await import('../src/scripts/core/confirmText.js');

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const imfUiSrc = read('../src/scripts/modules/imf/imf_ui.js');
const indexHtmlSrc = read('../src/index.html');
const i18nSrc = read('../src/scripts/modules/i18n.js');
const projectSetupSrc = read('../src/scripts/modules/project_setup.js');

const uiSrc = readFileSync(
  fileURLToPath(new URL('../src/scripts/ui.js', import.meta.url)), 'utf8',
);
const prepMarkSrc = readFileSync(
  fileURLToPath(new URL('../src/scripts/prep_mark.js', import.meta.url)), 'utf8',
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

// ── The marker delete: the same shape, with the last line inverted ───────────
//
// deleteProjectConfirm warns that nothing brings the folder back. This one has
// the opposite job: the delete it guards is backed by a hundred-deep undo
// stack, and the old dialog — `Delete "SH010"?` — never said so. Everything
// below is about that promise being true, legible, and correct per platform.

// comboToDisplay reads navigator.platform. Node on a Mac reports "MacIntel"
// and on CI reports "Linux x86_64", so a test that just called the function
// would assert a different string depending on the machine it ran on. Both
// branches are pinned here instead.
function withPlatform(platform, body) {
  const prev = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { platform }, configurable: true, writable: true,
  });
  try { return body(); }
  finally {
    if (prev) Object.defineProperty(globalThis, 'navigator', prev);
    else delete globalThis.navigator;
  }
}

test('the marker dialog says what goes and that it comes back', () => {
  const { text } = withPlatform('MacIntel', () => deleteMarkerConfirm('SH010_bg'));
  assert.match(text, /note written on it/, 'the dialog no longer says the note goes too');
  assert.match(text, /bring it back with Undo/, 'the dialog no longer offers the undo');
});

test('the marker dialog does not warn that the delete is permanent', () => {
  // The specific regression: someone extends this module by copying the
  // project-delete body, and the marker dialog inherits "cannot be undone".
  // That is a false statement about a reversible action, and it costs exactly
  // what the bare "Delete X?" cost — a cancel, and a question to a colleague.
  const { text } = withPlatform('MacIntel', () => deleteMarkerConfirm('SH010_bg'));
  assert.doesNotMatch(text, /cannot be undone/, 'the marker dialog claims to be permanent');
  assert.doesNotMatch(text, /Save As/, 'the marker dialog offers a workaround it does not need');
});

test('the marker name is shown, and no folder path is invented for it', () => {
  // A marker is not a folder. The project dialog earns its PFX/<name>/ line;
  // repeating that shape here would point at something that does not exist.
  const { text, subject } = withPlatform('MacIntel', () => deleteMarkerConfirm('SH010_bg'));
  assert.equal(subject, 'SH010_bg');
  assert.match(text, /“SH010_bg”/);
  assert.doesNotMatch(text, /PFX\//, 'invented a folder path for a marker');
});

test('the marker dialog reads question, then name, then consequence, then undo', () => {
  const { text } = withPlatform('MacIntel', () => deleteMarkerConfirm('SH010_bg'));
  const order = ['Delete this marker?', '“SH010_bg”', 'note written on it', 'Undo'];
  let at = -1;
  for (const part of order) {
    const next = text.indexOf(part);
    assert.ok(next > at, `"${part}" is out of reading order in:\n${text}`);
    at = next;
  }
});

test('the undo shortcut is correct for the platform the app is running on', () => {
  // The Prep & Mark keydown handler answers to metaKey || ctrlKey, so the
  // action works everywhere — but the dialog naming the wrong key is worse
  // than naming none, because the reader tries it, nothing happens, and the
  // promise that the delete is reversible is the thing they stop believing.
  const mac = withPlatform('MacIntel', () => deleteMarkerConfirm('SH010_bg'));
  assert.equal(mac.combo, 'Cmd+Z');
  assert.match(mac.text, /Undo — Cmd\+Z/);

  const win = withPlatform('Win32', () => deleteMarkerConfirm('SH010_bg'));
  assert.equal(win.combo, 'Ctrl+Z');
  assert.match(win.text, /Undo — Ctrl\+Z/);
  assert.doesNotMatch(win.text, /Cmd/, 'a Windows build was told to press Cmd');
});

test('the marker sentences are translated but the shortcut is not', () => {
  // Same bargain as the project name and path: the prose is translated, the
  // literal key-cap is not. "Cmd+Z" is what is printed on the key.
  const seen = [];
  const { text, combo } = withPlatform('MacIntel', () =>
    withTranslator((s) => { seen.push(s); return `[${s}]`; },
      () => deleteMarkerConfirm('SH010_bg')));
  assert.deepEqual(seen, [
    'Delete this marker?',
    'This removes the marker and the note written on it.',
    'You can bring it back with Undo',
  ], 'a sentence was assembled without passing through translate()');
  assert.equal(combo, 'Cmd+Z', 'the shortcut went through the translator');
  assert.match(text, /Cmd\+Z/);
});

test('the marker dialog inherits the same name hardening as the project one', () => {
  // cleanName is shared, and this proves the marker path actually calls it
  // rather than interpolating sel.shotName raw — shot names are typed in a
  // spreadsheet and pasted in bulk, so multi-line values are routine.
  const pasted = withPlatform('MacIntel', () =>
    deleteMarkerConfirm('SH010\n\nAlready approved.'));
  assert.equal(pasted.subject, 'SH010 Already approved.');
  assert.equal(pasted.text.split('\n\n').length, 3, 'the name forged an extra block');

  const long = withPlatform('MacIntel', () => deleteMarkerConfirm('S'.repeat(800)));
  assert.ok(long.subject.length <= 80, `name was not clamped: ${long.subject.length}`);
  assert.match(long.text, /Undo/, 'the undo line was pushed out by the name');

  for (const v of [null, undefined, '   ']) {
    const { text } = withPlatform('MacIntel', () => deleteMarkerConfirm(v));
    assert.doesNotMatch(text, /null|undefined/, `${v} leaked into the dialog`);
    assert.doesNotMatch(text, /“”/, 'rendered an empty pair of quotes');
    assert.match(text, /Delete this marker\?/);
    assert.match(text, /Undo/);
  }
});

test('prep_mark.js builds the marker delete dialog from this module', () => {
  assert.match(prepMarkSrc, /deleteMarkerConfirm\(sel\.shotName \|\| sel\.id\)/,
    'prep_mark.js does not call deleteMarkerConfirm at the delete handler');
  assert.match(
    prepMarkSrc, /import \{ deleteMarkerConfirm \} from '\.\/core\/confirmText\.js'/,
    'prep_mark.js does not import the module it calls',
  );
  assert.doesNotMatch(
    prepMarkSrc, /confirm\(`Delete "\$\{sel\.shotName \|\| sel\.id\}"\?`\)/,
    'the old English-only marker template is still in prep_mark.js',
  );
});

test('ui.js builds the delete dialog from this module', () => {
  // A pure module nobody calls is worth nothing, and the specific way this
  // goes wrong is that the new module lands, the old template is left in place
  // "for now", and the localised text never reaches a user.
  assert.match(uiSrc, /deleteProjectConfirm/, 'ui.js does not call deleteProjectConfirm');
  // Name-tolerant: ui.js imports more than one confirm builder from this
  // module now, and which siblings share the line is not this test's business.
  assert.match(
    uiSrc, /import \{[^}]*\bdeleteProjectConfirm\b[^}]*\} from "\.\/core\/confirmText\.js"/,
    'ui.js does not import the module it calls',
  );
  assert.doesNotMatch(
    uiSrc, /This removes PFX\/\$\{name\}\//,
    'the old English-only delete template is still in ui.js',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// IMF ▸ Proxy QC — the delete that was safe all along and said otherwise.
//
// The project delete warns because it must. The marker delete reassures
// because it can. This third one had to *retract* a warning: it said "This
// cannot be undone." about a file the app rebuilds on demand from a
// content-addressable registry, which is the reason the operator with a full
// disk never clicks it. The tests below hold the retraction to a higher bar
// than the promise in 142, because a wrong reassurance about a delete is the
// one failure mode this whole module exists to prevent.
// ─────────────────────────────────────────────────────────────────────────────

test('the proxy dialog says what goes, what stays, and how to get it back', () => {
  const { text } = deleteProxyConfirm('/Users/x/.cache/postflowx/proxies/imf/a1.mp4');
  assert.match(text, /Delete the proxy video\?/);
  assert.match(text, /only deletes the preview video/);
  // The sentence that answers the question the operator is actually asking:
  // am I about to damage the master material I was sent.
  assert.match(text, /IMF package itself is not changed/);
  assert.match(text, /You can make it again/);
});

test('the proxy dialog does not claim the delete is permanent', () => {
  const { text } = deleteProxyConfirm('/tmp/p.mp4');
  // The exact regression this iteration exists to prevent, and the exact thing
  // a future copy-paste from deleteProjectConfirm would reintroduce.
  assert.doesNotMatch(text, /cannot be undone/i);
  assert.doesNotMatch(text, /permanent/i);
  assert.doesNotMatch(text, /\(unknown path\)/);
});

test('the proxy path keeps its filename when it is too long to show', () => {
  const long = `/Volumes/PROD_MEDIA_01/${'nested/'.repeat(20)}8f3caa21-proxy.mp4`;
  const { subject } = deleteProxyConfirm(long);
  // Clamping from the right would leave the reader a directory prefix they
  // already know and drop the one token that identifies the file.
  assert.match(subject, /8f3caa21-proxy\.mp4$/, 'the filename was truncated away');
  assert.ok(subject.startsWith('…'), 'a clamped path should show it was clamped');
  assert.ok(Array.from(subject).length <= 64, `path not clamped: ${Array.from(subject).length}`);
});

test('a short proxy path is shown whole, and a missing one is dropped', () => {
  const short = '/tmp/p.mp4';
  assert.equal(deleteProxyConfirm(short).subject, short);
  for (const empty of ['', '   ', null, undefined]) {
    const { subject, text } = deleteProxyConfirm(empty);
    assert.equal(subject, '');
    // Two blocks, not three, and no stray blank block where the path was.
    assert.doesNotMatch(text, /\n\n\n/);
    assert.match(text, /Delete the proxy video\?/);
    assert.match(text, /You can make it again/);
  }
});

test('a pasted newline in the proxy path cannot forge dialog lines', () => {
  const forged = '/tmp/a.mp4\n\nThis will erase your IMF package.';
  const { subject, text } = deleteProxyConfirm(forged);
  assert.doesNotMatch(subject, /\n/);
  assert.equal(text.split('\n\n').length, 3, 'the forged text opened a new block');
});

test('the rebuild hint names a button that exists and is not translated', () => {
  const { hint, button, text } = deleteProxyConfirm('/tmp/p.mp4');
  assert.equal(button, '▶ Generate');
  assert.match(text, /You can make it again whenever you need it — ▶ Generate/);

  // The button has to still be on screen, spelled this way.
  assert.match(
    indexHtmlSrc, /id="imfProxyBtn"[^>]*>&#9654; Generate<\/button>/,
    'the ▶ Generate button named by this dialog is gone or renamed in index.html',
  );

  // And it has to still be untranslated. i18n has a "Generate" key, but the
  // button's text node is "▶ Generate" and _candKeys folds only whitespace and
  // case — never the glyph. If someone adds the glyph form to the dictionary,
  // the button starts reading Thai while this dialog keeps saying "▶ Generate",
  // and the hint points at a button the reader can no longer find.
  assert.ok(
    !i18nSrc.includes('"▶ Generate":'),
    'i18n now translates "▶ Generate" — the dialog must translate it too, or stop naming it',
  );

  // The sentence is translated; the button name is deliberately outside it.
  assert.doesNotMatch(hint, /Generate/);
});

test('the proxy sentences are translated and the button name is not', () => {
  const offered = [];
  const { text } = withTranslator((s) => { offered.push(s); return `«${s}»`; },
    () => deleteProxyConfirm('/tmp/p.mp4'));
  assert.deepEqual(offered, [
    'Delete the proxy video?',
    'This only deletes the preview video PostFlowX made. The IMF package itself is not changed.',
    'You can make it again whenever you need it',
  ]);
  assert.match(text, /— ▶ Generate$/, 'the button name went through the translator');
});

test('imf_ui.js builds the proxy delete dialog from this module', () => {
  assert.match(
    imfUiSrc, /confirm\(deleteProxyConfirm\(_lastProxyInfo\.proxyPath\)\.text\)/,
    'imf_ui.js does not build its dialog from deleteProxyConfirm',
  );
  assert.match(
    imfUiSrc, /import \{ deleteProxyConfirm \} from '\.\.\/\.\.\/core\/confirmText\.js'/,
    'imf_ui.js does not import the module it calls',
  );
  assert.doesNotMatch(
    imfUiSrc, /Delete proxy file\?/,
    'the old English-only proxy template is still in imf_ui.js',
  );
});

test('the companion can only ever unlink an .mp4 — what the reassurance rests on', () => {
  // "The IMF package itself is not changed" is safe to print only because
  // _delete_proxy refuses to build a delete list from anything but a .mp4 path
  // plus that stem's own sidecars. IMF assets are .mxf and .xml. If that guard
  // is ever relaxed, this dialog becomes a lie about studio master material,
  // so the claim is pinned to the code that makes it true.
  const api = read('../companion/src/postflowx_companion/api.py');
  const body = api.slice(api.indexOf('def _delete_proxy'));
  const fn = body.slice(0, body.indexOf('\n    def ', 1));
  assert.match(fn, /p\.suffix\.lower\(\) == "\.mp4"/, 'the .mp4-only guard is gone');
  assert.match(fn, /for ext in \("\.json", "\.progress", "\.log"\)/, 'sidecar list changed');
  assert.ok(
    fn.split('paths_to_remove.append').length - 1 === 2,
    'a new path source was added to the proxy delete list',
  );
});

// ── Reset All Settings: the dialog that deleted its own undo ─────────────────

test('the reset dialog says what changes and, separately, what does not', () => {
  const { text } = resetSettingsConfirm();

  // Beat 1: which settings. "All project settings" is the whole panel, and a
  // reader who came in through one section needs to know the other eight go too.
  assert.match(text, /^Reset all project settings\?/);
  // Beat 2: the reassurance. This is the question the dialog was never
  // answering — "does this touch my footage?" — and the answer is no.
  assert.match(text, /Your footage and project files are not touched\./);
  // Beat 3: the way back, named by the section that provides it.
  assert.match(text, /Version History$/);
});

test('the dialog no longer claims the reset cannot be undone', () => {
  // It said "This cannot be undone." while itself emptying the restore ring —
  // true only because of a bug. The code fix below is what earns the removal.
  const { text } = resetSettingsConfirm();
  assert.doesNotMatch(text, /cannot be undone/i);
  assert.doesNotMatch(text, /permanent/i);
  // And it stops shouting. "ALL" in caps was the old template's only emphasis,
  // spent on the scope rather than on the consequence.
  assert.doesNotMatch(text, /\bALL\b/);
});

test('project_setup.js carries the history ring across the reset', () => {
  // The whole dialog rests on this. _pssDefaults() returns `_history: []`, so
  // a bare `_pssSettings = _pssDefaults()` destroys every Restore button
  // rendered directly above the reset button — and _pssMarkDirty() then
  // autosaves that away 30 s later, past any chance of a reload rescuing it.
  const body = projectSetupSrc.slice(projectSetupSrc.indexOf("#pfxSetupResetAll"));
  const handler = body.slice(0, body.indexOf('\n  }'));

  assert.match(handler, /_pssSettings\s*=\s*_pssDefaults\(\)/, 'the reset itself is gone');
  assert.match(
    handler, /const keptHistory\s*=[\s\S]*?_pssSettings\._history = keptHistory/,
    'the reset no longer preserves _history — the dialog is now promising an undo that is deleted',
  );
  // Saving first is what makes the *discarded* settings restorable, not just
  // the ones from before them. Without it the newest entry is up to 30 s stale.
  assert.match(
    handler, /await _pssSaveNow\(true\)[\s\S]*?_pssSettings = _pssDefaults\(\)/,
    'the current settings are no longer snapshotted before being replaced',
  );
});

test('project_setup.js builds its dialog from this module', () => {
  assert.match(
    projectSetupSrc, /confirm\(resetSettingsConfirm\(\)\.text\)/,
    'project_setup.js does not build its dialog from resetSettingsConfirm',
  );
  assert.match(
    projectSetupSrc, /import \{ resetSettingsConfirm \} from '\.\.\/core\/confirmText\.js'/,
    'project_setup.js does not import the module it calls',
  );
  assert.doesNotMatch(
    projectSetupSrc, /Reset ALL project settings to defaults\?/,
    'the old English-only reset template is still in project_setup.js',
  );
});

test('the section named in the hint exists, and is still shown in English', () => {
  // Same shape as the ▶ Generate check above: the hint points the reader at a
  // heading, so the heading has to be there and has to read the way the hint
  // spells it.
  assert.match(
    projectSetupSrc, /pfx-setup-group-head">Version History</,
    'the "Version History" heading this dialog points at is gone or renamed',
  );
  // Nothing in Project Setup is translated, so the heading reads English in
  // every locale and an English section name is accurate everywhere. If that
  // ever changes, the hint has to change with it or it points at a heading the
  // reader cannot find.
  for (const key of ['Version History', 'Restore', 'Danger Zone']) {
    assert.ok(
      !i18nSrc.includes(`"${key}":`),
      `i18n now translates "${key}" — the reset hint must be translated too, or stop naming the section`,
    );
  }
});

test('the reset sentences are translated and the section name is not', () => {
  const offered = [];
  const { text } = withTranslator((s) => { offered.push(s); return `«${s}»`; },
    () => resetSettingsConfirm());
  assert.deepEqual(offered, [
    'Reset all project settings?',
    'Every setting on this page goes back to its original value. Your footage and project files are not touched.',
    'Your current settings are saved first, so you can bring them back',
  ]);
  assert.match(text, /— Version History$/, 'the section name went through the translator');
});

// ── The dialog named one list and the handler reset two ──────────────────────

const NT_DEF = { add: ['a1', 'a2'], remove: ['r1'], change: ['c1', 'c2', 'c3'] };
const SOW_DEF = ['s1', 's2'];
const untouched = () => ({
  noteTypes: { add: ['a1', 'a2'], remove: ['r1'], change: ['c1', 'c2', 'c3'] },
  noteTypeDefaults: NT_DEF,
  presets: ['s1', 's2'],
  presetDefaults: SOW_DEF,
});

test('the dialog names both lists, not just the one on the button', () => {
  // The whole defect in one assertion. The old text was "Reset Note Types to
  // defaults?" while the handler also called PFX_setSowPresets, so a reader
  // answering the question they were asked lost a list they were not asked
  // about. Whatever this sentence becomes, it has to mention both.
  const { title } = resetNoteTypesConfirm(untouched());
  assert.match(title, /note types/i, 'the dialog stopped naming the note types');
  assert.match(title, /Scope of Work/i, 'the dialog is back to naming only one of the two lists');
});

test('with nothing of the user\'s own in either list, no warning is raised', () => {
  // Both lists ship full and usable, so most people who reach this button have
  // never edited either one. Warning them in the same words as the user with
  // forty custom entries is how a dialog teaches everyone to click through it.
  const { changed, text, count } = resetNoteTypesConfirm(untouched());
  assert.equal(changed, 0);
  assert.equal(count, '', 'a count of nothing was printed anyway');
  assert.doesNotMatch(text, /cannot be undone/i,
    'the no-op reset still threatens the reader with an irreversible action');
  assert.match(text, /nothing of yours is lost/i);
});

test('additions and deletions both count as changes to lose', () => {
  // A default the user deleted comes back on reset, exactly as an entry they
  // added disappears. Both are their work being reverted, so counting only
  // one direction would under-report the cost of the click.
  const added = resetNoteTypesConfirm({ ...untouched(), noteTypes: { ...NT_DEF, add: ['a1', 'a2', 'mine'] } });
  assert.equal(added.changed, 1, 'an added entry was not counted');

  const deleted = resetNoteTypesConfirm({ ...untouched(), noteTypes: { ...NT_DEF, add: ['a1'] } });
  assert.equal(deleted.changed, 1, 'a deleted default was not counted');

  // Renaming is a delete plus an add, and costs the user both.
  const renamed = resetNoteTypesConfirm({ ...untouched(), noteTypes: { ...NT_DEF, add: ['a1', 'renamed'] } });
  assert.equal(renamed.changed, 2);
});

test('changes are counted across every group and the presets alike', () => {
  // The Scope of Work presets are the list the old dialog forgot, so a count
  // that silently skipped them would reproduce the original defect one level
  // down — the dialog would name both lists and then under-count one of them.
  const all = resetNoteTypesConfirm({
    noteTypes: { add: ['a1', 'a2', 'x'], remove: ['r1', 'y'], change: ['c1', 'c2', 'c3', 'z'] },
    noteTypeDefaults: NT_DEF,
    presets: ['s1', 's2', 'w'],
    presetDefaults: SOW_DEF,
  });
  assert.equal(all.changed, 4);

  const sowOnly = resetNoteTypesConfirm({ ...untouched(), presets: ['s1', 's2', 'w'] });
  assert.equal(sowOnly.changed, 1, 'a preset the user added was not counted');
  assert.match(sowOnly.text, /: 1$/, 'the number never reached the dialog');
});

test('when there is something to lose the dialog says there is no way back', () => {
  // Iteration 144 deleted this sentence from Project Setup's reset because a
  // history ring made it false there. Here it is true: both setters write
  // straight to localStorage with no snapshot. The rule is the same rule —
  // the dialog matches the code — and it lands the opposite way.
  const { text, count, changed } = resetNoteTypesConfirm({ ...untouched(), presets: ['s1'] });
  assert.equal(changed, 1);
  assert.match(text, /cannot be undone/i, 'the one dialog here that really has no undo stopped saying so');
  assert.equal(count, 'Changes of your own that would be lost: 1');
  assert.match(text, /\n\nBoth lists[\s\S]*\nChanges of your own[^\n]*: 1$/,
    'the count is not on its own last line where it can be read at a glance');
});

test('a missing or malformed list is treated as no changes, not a crash', () => {
  // The dialog is built from live localStorage reads, and this is the one
  // place a throw would be worst: it fires between the click and the confirm,
  // so an exception here does not warn the user — it resets both lists with
  // no dialog at all.
  assert.equal(resetNoteTypesConfirm().changed, 0);
  assert.equal(resetNoteTypesConfirm({}).changed, 0);
  assert.equal(resetNoteTypesConfirm({ noteTypes: null, presets: 'nope' }).changed, 0);
  assert.match(resetNoteTypesConfirm().title, /Scope of Work/i);
});

test('the note-types reset sentences all reach the translator', () => {
  const safe = [];
  withTranslator((s) => { safe.push(s); return `«${s}»`; }, () => resetNoteTypesConfirm(untouched()));
  assert.deepEqual(safe, [
    'Reset note types and Scope of Work presets?',
    'Both lists on this card go back to their original entries. You have not changed either list, so nothing of yours is lost.',
  ]);

  const risky = [];
  withTranslator((s) => { risky.push(s); return `«${s}»`; },
    () => resetNoteTypesConfirm({ ...untouched(), presets: ['s1'] }));
  assert.deepEqual(risky, [
    'Reset note types and Scope of Work presets?',
    'Both lists on this card go back to their original entries, and neither list keeps a history — this cannot be undone.',
    'Changes of your own that would be lost',
  ]);
});

test('ui.js asks before resetting and resets exactly what it asked about', () => {
  const body = uiSrc.slice(uiSrc.indexOf("btnReset?.addEventListener"));
  const handler = body.slice(0, body.indexOf('\n  });'));

  assert.ok(!handler.includes("confirm('Reset Note Types to defaults?')"),
    'the old one-list dialog is still in the handler');
  assert.match(handler, /resetNoteTypesConfirm\(\{[\s\S]*?confirm\(ask\.text\)/,
    'the dialog is no longer built from the module');
  // The count is only honest if it is measured against the same defaults that
  // are about to be written. Reading them once and using that value for both
  // is what keeps the dialog and the reset describing one event.
  assert.match(handler, /PFX_setNoteTypesConfig\(ntDefaults\)/);
  assert.match(handler, /PFX_setSowPresets\(sowDefaults\)/);
  assert.match(uiSrc, /import \{[^}]*\bresetNoteTypesConfirm\b[^}]*\} from "\.\/core\/confirmText\.js"/,
    'ui.js does not import the builder it calls');
});

test('the Scope of Work defaults have exactly one definition', () => {
  // Three copies of this literal used to exist — the getter fallback, the
  // Reset button, and the new-project reset — so "the defaults" was whichever
  // copy you read. The reset dialog counts the user's list against them, and
  // a count measured against a stale copy is a number that looks precise and
  // is wrong.
  assert.equal(
    (uiSrc.match(/'Fix edges','Cleanup','Add element'/g) || []).length, 1,
    'the Scope of Work defaults are duplicated again',
  );
  assert.match(uiSrc, /function __pfxDefaultSowPresets\(\)/);
  for (const caller of [/return __pfxDefaultSowPresets\(\);/, /PFX_setSowPresets\(__pfxDefaultSowPresets\(\)\)/]) {
    assert.match(uiSrc, caller, 'a caller stopped using the shared defaults');
  }
});

test('the card readout counts both lists it can reset', () => {
  // The status line was "Add 21 · Remove 20 · Change 20" and never mentioned
  // the presets, so the list the dialog forgot was also the list the user had
  // no way to see change. Both builders of this line have to carry the count,
  // or the loss stays invisible on whichever screen uses the other one.
  const builders = uiSrc.match(/\$\{TT\('Add'\)\}[^`]*`/g) || [];
  assert.equal(builders.length, 2, 'a status-line builder appeared or vanished');
  for (const b of builders) {
    assert.match(b, /TT\('Scope of Work'\)/, 'a status line still ignores the Scope of Work presets');
  }
  // 'Scope of Work' is already a dictionary key, so the new count reads in the
  // reader's language for free — but only while that stays true.
  assert.ok(i18nSrc.includes('"Scope of Work":'),
    'the status label lost its translations and now reads English in six locales');
});
