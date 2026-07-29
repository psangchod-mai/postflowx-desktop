// Reviews Bin import: shared fileInput target race (src/scripts/features/reviews/index.js).
// Run: node tests-js/reviewsFileInputTargetStaleRace.test.mjs
//
// __pfxOpenMediaPickerForBin('shots'|'ref') used to stash its target bin in a
// single shared `importTarget` variable, then fall back to fileInput.click()
// to open a native OS file dialog. That dialog resolves asynchronously
// (arbitrary user think-time), and `importTarget` was also written by the
// unrelated ref-video picker (__pfxOpenRefPicker) when *it* opens its own
// dialog. If a user opened the Shots ("Add Clips") dialog, then before
// picking any files also invoked the Ref video picker, `importTarget` got
// clobbered to 'ref' — so when the user went back and finished the original
// Shots dialog, fileInput's 'change' handler read the now-stale 'ref' value
// and silently added the files to the wrong bin (with a mislabeled status
// toast to match). The fix captures the fileInput-specific target in its own
// `_fileInputTarget` variable that only __pfxOpenMediaPickerForBin writes.
//
// This test extracts the real `importTarget`/`_fileInputTarget` declarations,
// __pfxOpenMediaPickerForBin, and the fileInput 'change' handler bodies out of
// the 10k-line monolithic module via source-slicing, since mounting the whole
// reviews tab is not required to exercise this closure logic.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'src/scripts/features/reviews/index.js'), 'utf8');

function extractBlock(src, startMarker, endMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `could not find start marker: ${startMarker}`);
  const end = src.indexOf(endMarker, start);
  assert.ok(end >= 0, `could not find end marker: ${endMarker}`);
  return src.slice(start, end + endMarker.length);
}

function extractUpTo(src, startMarker, stopMarker) {
  const start = src.indexOf(startMarker);
  assert.ok(start >= 0, `could not find start marker: ${startMarker}`);
  const stop = src.indexOf(stopMarker, start);
  assert.ok(stop >= 0, `could not find stop marker: ${stopMarker}`);
  return src.slice(start, stop);
}

const pickerBlock = extractUpTo(
  SRC,
  "let importTarget = 'shots';",
  "  const openImport = (target) => {"
);

const changeHandlerBody = extractBlock(
  SRC,
  "fileInput.addEventListener('change', async () => {",
  "  });"
).replace("fileInput.addEventListener('change', async () => {", '').replace(/\n {2}\}\);\s*$/, '');

// Minimal fake EventTarget so fileInput.addEventListener/dispatchEvent work.
function makeFakeInput() {
  const listeners = {};
  return {
    files: [],
    value: '',
    addEventListener(type, fn) { listeners[type] = fn; },
    dispatchEvent(type) { return listeners[type]?.(); },
    click() {},
  };
}

function buildHarness({ window, fileInput, store, __pfxSaveAutosaveNow, player, loadSourceClip, onDropFiles }) {
  const status = { textContent: '' };
  const __pfxIsVideoFile = () => true;
  const __pfxGetCurrentTimelineCutModel = () => null;
  const __pfxApplyTimelineAsV1Reference = async () => {};

  const factory = new Function(
    'window', 'fileInput', 'store', '__pfxSaveAutosaveNow', 'player', 'loadSourceClip',
    'onDropFiles', 'status', '__pfxIsVideoFile', '__pfxGetCurrentTimelineCutModel', '__pfxApplyTimelineAsV1Reference',
    `
    ${pickerBlock}
    fileInput.addEventListener('change', async () => {
      ${changeHandlerBody}
    });
    return { __pfxOpenMediaPickerForBin, getImportTarget: () => importTarget, setImportTarget: (v) => { importTarget = v; } };
    `
  );
  return factory(window, fileInput, store, __pfxSaveAutosaveNow, player, loadSourceClip, onDropFiles, status, __pfxIsVideoFile, __pfxGetCurrentTimelineCutModel, __pfxApplyTimelineAsV1Reference, status);
}

test('fileInput change handler uses the target bin captured at open-time, not a shared variable clobbered by another picker', async () => {
  const fileInput = makeFakeInput();
  const addedClips = [];
  const store = {
    state: { clips: [] },
    async addClips(files, opts) {
      const bin = opts.bin;
      addedClips.push({ files, bin });
      return [];
    },
  };
  const window = { showOpenFilePicker: undefined }; // force native <input> fallback path
  const player = { ensureClipMetadata: async () => {} };

  const harness = buildHarness({
    window, fileInput, store,
    __pfxSaveAutosaveNow: async () => {},
    player,
    loadSourceClip: () => {},
    onDropFiles: async () => {},
  });

  // 1) User opens the Shots ("Add Clips") dialog — captures targetBin='shots'.
  const openShots = harness.__pfxOpenMediaPickerForBin('shots');

  // 2) Before the OS dialog resolves, an unrelated ref-video picker click also
  //    fires and clobbers the shared `importTarget` (mirrors __pfxOpenRefPicker
  //    line: `if (kind === 'video') importTarget = 'ref';`).
  harness.setImportTarget('ref');
  await openShots;

  // 3) The user finally finishes the original Shots dialog.
  fileInput.files = ['clipA.mp4'];
  fileInput.dispatchEvent('change');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();

  assert.equal(addedClips.length, 1, 'exactly one addClips call happened');
  assert.equal(addedClips[0].bin, 'shots',
    `fileInput must add to the bin selected when its OWN dialog was opened (got "${addedClips[0].bin}")`);
});

console.log('reviewsFileInputTargetStaleRace: run via node --test');
