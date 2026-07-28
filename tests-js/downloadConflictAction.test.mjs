import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

// electron/ipc.js (and the native modules it optionally requires) does
// `require('electron')` at module-load time. Outside Electron that resolves
// to a plain path string, not an object, so we inject a fake module into
// Node's own require cache — same trick tests-js/storageGetOmitsMissingKeys
// and companionStartupRetry use for 'electron' / 'child_process' — before
// ipc.js is first required.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfx-ipc-test-'));
const downloadsDir = path.join(tmpDir, 'Downloads');
fs.mkdirSync(downloadsDir, { recursive: true });

const handlers = {};
const fakeIpcMain = {
  handle(channel, fn) { handlers[channel] = fn; },
  on(channel, fn) { handlers[channel] = fn; },
};

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    ipcMain: fakeIpcMain,
    dialog: {},
    shell: { showItemInFolder() {} },
    clipboard: {},
    app: {
      getPath: (name) => (name === 'downloads' ? downloadsDir : tmpDir),
      isPackaged: false,
      getVersion: () => '0.0.0-test',
    },
  },
};

const ipc = require('../electron/ipc.js');
const fakeWindow = { webContents: { downloadURL() {}, session: { webRequest: {} } } };
ipc.register(fakeWindow, tmpDir);

const download = handlers['pfx:download'];

function b64Of(text) {
  return `data:text/plain;base64,${Buffer.from(text).toString('base64')}`;
}

test('pfx:download uniquifies the filename on a silent-write collision (chrome default conflictAction)', async () => {
  const first = await download(null, { filename: 'note.txt', dataUrl: b64Of('one'), saveAs: false });
  assert.equal(first.ok, true);
  assert.equal(first.filePath, path.join(downloadsDir, 'note.txt'));
  assert.equal(fs.readFileSync(first.filePath, 'utf8'), 'one');

  const second = await download(null, { filename: 'note.txt', dataUrl: b64Of('two'), saveAs: false });
  assert.equal(second.ok, true);
  assert.notEqual(second.filePath, first.filePath, 'a colliding filename must not overwrite the first file');
  assert.equal(second.filePath, path.join(downloadsDir, 'note (1).txt'));
  assert.equal(fs.readFileSync(first.filePath, 'utf8'), 'one', 'the original file must survive untouched');
  assert.equal(fs.readFileSync(second.filePath, 'utf8'), 'two');
});

test('pfx:download honors an explicit conflictAction: "overwrite"', async () => {
  const path1 = path.join(downloadsDir, 'report.txt');
  const first = await download(null, { filename: 'report.txt', dataUrl: b64Of('v1'), saveAs: false });
  assert.equal(first.filePath, path1);

  const second = await download(null, {
    filename: 'report.txt',
    dataUrl: b64Of('v2'),
    saveAs: false,
    conflictAction: 'overwrite',
  });
  assert.equal(second.filePath, path1, 'overwrite must reuse the original path, not uniquify');
  assert.equal(fs.readFileSync(path1, 'utf8'), 'v2');
});
