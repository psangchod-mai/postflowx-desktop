// ─────────────────────────────────────────────────────────────────────────────
// Does Cancel mean cancel?
//
// PostFlowX saves text (review notes, visual-QC reports) through a cascade of
// three routes: chrome.downloads, then showSaveFilePicker, then a bare anchor
// click. Each route used to answer with a boolean, which folded two different
// answers into one — "the user pressed Cancel" and "this route isn't available
// here" both arrived as `false`. So cancelling the Save dialog was read as a
// route failure: the app opened a second dialog, and if that was dismissed too
// it fell through to the anchor and wrote the file into Downloads anyway.
//
// Undoing that took a chain of four links, and the chain is only as good as its
// weakest one, so this file tests all four rather than just the pretty end:
//
//   1. electron/ipc.js       — say `canceled` in the IPC result at all
//   2. electron/preload.js   — translate it to Chrome's own "USER_CANCELED"
//   3. electron_shim.js      — keep runtime.lastError READABLE in the renderer
//   4. core/saveOutcome.js   — stop the cascade when a tier reports a cancel
//
// Link 3 is the one worth staring at. The shim merges the preload's chrome
// object with a spread, and a spread reads a getter once and copies the value.
// runtime.lastError was defined as a live getter and arrived in the renderer as
// a frozen `null`, which quietly made every `if (chrome.runtime.lastError)` in
// the app dead code. Fixing links 1, 2 and 4 without link 3 would have produced
// a completely convincing set of green tests and changed nothing on screen — so
// the test for it below executes the real shim instead of reading it.
//
// ── What this cannot see ─────────────────────────────────────────────────────
//
//  - Whether the OS dialog actually reports cancellation. That is Electron's
//    contract, taken on trust.
//  - The other save paths. pfxPlatform.saveFile has the same collapse and is
//    left alone here because it currently has no callers at all.
// ─────────────────────────────────────────────────────────────────────────────

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  SAVED, CANCELLED, UNAVAILABLE, isUserCancel, runSaveCascade,
} from '../src/scripts/core/saveOutcome.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Every file that owns one of the three-route cascades. Both had the bug; both
// must route through the one runner that fixes it.
const CASCADE_FILES = [
  'src/scripts/features/reviews/index.js',
  'src/scripts/components/visualQcModal/index.js',
];

// Pull one function out of a source file by name, brace-matched. A file-level
// grep is the vacuous version of this: `runSaveCascade` appearing *somewhere*
// in a 9,000-line module says nothing about whether the function every export
// button funnels through actually calls it.
function functionBody(src, name) {
  const start = src.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`));
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

// ── the three outcomes have to be three ──────────────────────────────────────

test('SAVED, CANCELLED and UNAVAILABLE are distinct', () => {
  // The whole fix is that these are not the same value. If two of them ever
  // collapse, every routing assertion below passes while doing nothing.
  assert.equal(new Set([SAVED, CANCELLED, UNAVAILABLE]).size, 3);
});

// ── the detector, probed in both directions ──────────────────────────────────

test('isUserCancel recognises every costume a cancel arrives in', () => {
  const abort = new Error('The user aborted a request.');
  abort.name = 'AbortError';

  for (const [label, err] of [
    ['showSaveFilePicker AbortError', abort],
    ['chrome lastError', { message: 'USER_CANCELED' }],
    ['chrome lastError, two Ls', { message: 'USER_CANCELLED' }],
    ['Electron IPC result', { ok: false, canceled: true }],
    ['the other spelling', { cancelled: true }],
    ['bare string', 'The user aborted a request.'],
    ['prose form', 'Download was canceled by the user'],
  ]) {
    assert.equal(isUserCancel(err), true, `not recognised as a cancel: ${label}`);
  }
});

test('isUserCancel does not fire on an ordinary failure', () => {
  // A detector that always fires reports "no problem" just as convincingly as
  // one that never does — and here a false positive is worse than the original
  // bug, because it would abandon an export the user did ask for.
  for (const [label, err] of [
    ['nothing at all', null],
    ['undefined', undefined],
    ['empty message', { message: '' }],
    ['missing file', { message: 'ENOENT: no such file or directory' }],
    ['disk full', new Error('ENOSPC: no space left on device')],
    ['a programming error', { name: 'TypeError', message: 'x is not a function' }],
    ['canceled:false', { ok: false, canceled: false }],
  ]) {
    assert.equal(isUserCancel(err), false, `wrongly treated as a cancel: ${label}`);
  }
});

test('a missing user gesture is NOT a cancel', () => {
  // showSaveFilePicker throws this when it has no transient activation. The
  // route is unusable, not declined, and the cascade must stay free to try the
  // next one. Reading it as a cancel would lose the file silently — no dialog,
  // no error, nothing saved. It is called out on its own because it is the one
  // string in this area that genuinely looks like a refusal and is not.
  const notAllowed = new Error(
    'The request is not allowed by the user agent or the platform in the current context.',
  );
  notAllowed.name = 'NotAllowedError';
  assert.equal(isUserCancel(notAllowed), false);
});

// ── the runner: the actual bug, tested by running it ─────────────────────────

test('a cancel in the first tier stops the cascade dead', () => {
  // This is the bug, in one assertion. Before the fix the cancel came back as
  // `false`, tier 2 opened a second dialog, and tier 3 wrote the file anyway.
  const ran = [];
  return runSaveCascade([
    () => { ran.push(1); return CANCELLED; },
    () => { ran.push(2); return SAVED; },
    () => { ran.push(3); return SAVED; },
  ]).then((outcome) => {
    assert.equal(outcome, CANCELLED);
    assert.deepEqual(ran, [1], 'a later tier ran after the user pressed Cancel');
  });
});

test('a cancel thrown rather than returned also stops it', async () => {
  const abort = new Error('cancelled');
  abort.name = 'AbortError';
  const ran = [];
  const outcome = await runSaveCascade([
    () => { ran.push(1); throw abort; },
    () => { ran.push(2); return SAVED; },
  ]);
  assert.equal(outcome, CANCELLED);
  assert.deepEqual(ran, [1]);
});

test('an unavailable route falls through to the next', async () => {
  const ran = [];
  const outcome = await runSaveCascade([
    () => { ran.push(1); return UNAVAILABLE; },
    () => { ran.push(2); return UNAVAILABLE; },
    () => { ran.push(3); return SAVED; },
  ]);
  assert.equal(outcome, SAVED);
  assert.deepEqual(ran, [1, 2, 3], 'the cascade stopped early on an unavailable route');
});

test('a tier that blows up is unavailable, not fatal', async () => {
  // A route throwing must never eat the export — the next one still gets a go.
  const outcome = await runSaveCascade([
    () => { throw new Error('ENOSPC: no space left on device'); },
    () => SAVED,
  ]);
  assert.equal(outcome, SAVED);
});

test('a saved first tier stops the cascade', async () => {
  const ran = [];
  await runSaveCascade([
    () => { ran.push(1); return SAVED; },
    () => { ran.push(2); return SAVED; },
  ]);
  assert.deepEqual(ran, [1]);
});

test('every route unavailable reports unavailable', async () => {
  assert.equal(await runSaveCascade([() => UNAVAILABLE, () => UNAVAILABLE]), UNAVAILABLE);
  assert.equal(await runSaveCascade([]), UNAVAILABLE);
});

test('tiers are awaited, not fired off', async () => {
  // Every real tier is async. A runner that forgot to await would see a Promise
  // — never equal to SAVED or CANCELLED — and run all three dialogs in a row.
  const ran = [];
  const outcome = await runSaveCascade([
    async () => { ran.push(1); return CANCELLED; },
    async () => { ran.push(2); return SAVED; },
  ]);
  assert.equal(outcome, CANCELLED);
  assert.deepEqual(ran, [1]);
});

// ── link 3: the shim, executed rather than read ──────────────────────────────

test('the renderer shim keeps runtime.lastError live', () => {
  // Runs the real IIFE against a fake window whose lastError is a getter, the
  // way preload.js defines it. Before the fix the spread in the shim flattened
  // that getter to its value at load time and the renderer read null forever,
  // no matter what the preload set.
  const src = read('src/scripts/electron_shim.js');

  let current = null;
  const runtime = { getURL: (p) => p, id: 'pfx' };
  Object.defineProperty(runtime, 'lastError', {
    get() { return current; },
    set(v) { current = v; },
    configurable: true,
    enumerable: true,
  });

  const fakeWindow = { __pfxChrome: { runtime, downloads: { download() {} } } };
  // eslint-disable-next-line no-new-func
  new Function('window', src)(fakeWindow);

  assert.ok(fakeWindow.chrome, 'the shim did not install window.chrome at all');
  assert.equal(fakeWindow.chrome.runtime.lastError, null, 'lastError should start clear');

  current = { message: 'USER_CANCELED' };
  assert.equal(
    fakeWindow.chrome.runtime.lastError?.message,
    'USER_CANCELED',
    'chrome.runtime.lastError is a frozen copy, so the renderer can never see a cancel',
  );

  current = null;
  assert.equal(fakeWindow.chrome.runtime.lastError, null, 'lastError did not clear again');

  // And the merge still has to do its ordinary job.
  assert.equal(typeof fakeWindow.chrome.downloads.download, 'function');
  assert.equal(typeof fakeWindow.chrome.runtime.getURL, 'function');
});

// ── links 1 and 2: the electron side of the chain ────────────────────────────

test('the save dialog reports cancellation distinguishably', () => {
  // Extract the pfx:download handler rather than grepping the file: `canceled`
  // appears in electron/ipc.js for unrelated dialogs, so a file-level match
  // would stay green with this exact bug still in place.
  const src = read('electron/ipc.js');
  const at = src.indexOf("ipcMain.handle('pfx:download'");
  assert.ok(at > 0, 'the pfx:download handler is gone — this test is stale');
  const handler = src.slice(at, at + 2500);

  const cancelReturn = handler.match(/if \(canceled \|\| !filePath\) return \{[^}]*\}/);
  assert.ok(cancelReturn, 'the cancel branch of showSaveDialog has moved or gone');
  assert.match(
    cancelReturn[0],
    /canceled:\s*true/,
    'a cancelled Save dialog returns the same bare {ok:false} as a failed write, so nothing '
    + 'downstream can tell the user saying no from the disk being full',
  );
});

test('the download shim speaks Chrome\'s cancel wording', () => {
  const src = read('electron/preload.js');
  const body = src.slice(src.indexOf('const downloads = {'));
  assert.ok(body.length > 100, 'the downloads shim is gone — this test is stale');
  const shim = body.slice(0, body.indexOf('\n};') + 3);

  assert.match(
    shim,
    /USER_CANCELED/,
    'the shim must report a cancel with Chrome\'s own spelling, or the same renderer code '
    + 'cannot recognise it in both build targets',
  );
  assert.match(shim, /r\?\.canceled/, 'the shim ignores the canceled flag the IPC now returns');
  assert.match(
    shim,
    /finally \{ _lastError = null; \}/,
    'lastError must be cleared after the callback, as in Chrome, or one cancel poisons the '
    + 'next unrelated download',
  );
});

// ── link 4: both cascades actually route through the runner ──────────────────

test('every save cascade routes through runSaveCascade', () => {
  for (const file of CASCADE_FILES) {
    const src = read(file);
    const body = functionBody(src, 'downloadOrSaveText');
    assert.ok(body, `${file}: downloadOrSaveText not found — renamed, or this gate is stale`);
    assert.ok(body.length > 200, `${file}: extracted a suspiciously small body (${body.length} chars)`);
    assert.match(
      body,
      /runSaveCascade\(/,
      `${file}: downloadOrSaveText sequences its own tiers again instead of using the one runner `
      + `that knows a cancel is terminal — this is exactly how both copies got it wrong`,
    );
  }
});

test('no cascade still treats a tier as a bare boolean', () => {
  // The old shape was `const ok = await tier(); if (ok) return;`. That reads
  // fine and is the bug. If it reappears the runner is being bypassed.
  for (const file of CASCADE_FILES) {
    const body = functionBody(read(file), 'downloadOrSaveText');
    assert.doesNotMatch(
      body,
      /if \(ok[A-Za-z]*\) return;/,
      `${file}: a tier result is being tested as a boolean again`,
    );
  }
});

test('every tier helper returns an outcome and nothing else', () => {
  // reviews/index.js keeps its two tier helpers as named functions feeding the
  // runner, so every one of their return paths has to carry an outcome. This
  // enumerates the returns rather than banning the literals `true`/`false`,
  // because the interesting regression is not written with a literal:
  // `return !!downloadId;` reads like a tidy tightening, sails past a
  // literal-only check, and hands the runner `true` — which is neither SAVED
  // nor CANCELLED, so a download that SUCCEEDED falls through and opens a
  // second dialog. That mutation survived the first version of this test.
  //
  // One exception, and only one: `return reject(err)` inside the nested
  // Promise executor is settling that promise, not reporting an outcome.
  const OUTCOME = /\b(?:SAVED|CANCELLED|UNAVAILABLE)\b/;
  const DELEGATES = /^return\s+(?:reject|resolve)\(/;

  const src = read('src/scripts/features/reviews/index.js');
  for (const name of ['downloadTextViaChromeDownloads', 'saveTextViaPicker']) {
    const body = functionBody(src, name);
    assert.ok(body, `reviews/index.js: ${name} not found — this gate is stale`);

    const returns = body.match(/return\s+[^;\n]+;/g) || [];
    assert.ok(returns.length >= 3, `reviews/index.js: ${name} has only ${returns.length} return paths — stale gate`);

    for (const r of returns) {
      if (DELEGATES.test(r)) continue;
      assert.match(
        r,
        OUTCOME,
        `reviews/index.js: ${name} has a return path carrying no outcome: ${JSON.stringify(r)}. `
        + `The runner compares against SAVED and CANCELLED by identity, so anything else — `
        + `including a truthy boolean — silently means "try the next route"`,
      );
    }
    assert.match(body, /CANCELLED/, `reviews/index.js: ${name} can never report a cancel`);
  }
});
