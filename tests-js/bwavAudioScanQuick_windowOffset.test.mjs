// tests-js/bwavAudioScanQuick_windowOffset.test.mjs
//
// runAudioScanQuick() in src/tools/bwav/app.js bounds scan time on large PCM
// files by sampling only a "start" window and, if the file is big enough, a
// physically disjoint "end" window near the tail -- skipping the middle
// entirely. The bug: a single `scannedFrames` counter incremented
// contiguously across both windows was reused both as "total frames sampled"
// (legitimate, feeds scannedSeconds) and as "absolute file position"
// (wrong) -- so a clip run or digital hit found in the "end" window was
// reported at a frame/timeSec as if it sat right after the "start" window,
// not near the real tail of the file. clipRuns/clipRunStart also survived
// the window boundary uninitialized, letting a run open at the tail of the
// "start" window splice onto the head of the "end" window into one bogus
// segment, despite the windows not being adjacent in the file.
//
// app.js is a plain browser script (no ES module exports, DOM-dependent code
// at top-level load), so it can't be imported directly into a Node test.
// runAudioScanQuick and its one dependency (dbfsFromAmp) are pure -- no DOM
// touched -- so this test extracts just those two function bodies by source
// line range and evaluates them via `new Function`, the same "run it the way
// the browser would, without pulling in what isn't needed" approach
// toastContract.test.mjs uses for a full DOM module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP_JS = join(ROOT, 'src/tools/bwav/app.js');
const SRC = readFileSync(APP_JS, 'utf8');

// Extracts a top-level `function name(...) { ... }` (or `async function`) by
// name via brace counting, so the slice tracks the function through edits
// instead of pinning to line numbers that shift as the fix changes line
// counts (needed for mutation-testing this fix via git stash).
function extractFunction(name) {
  const m = SRC.match(new RegExp(`^(?:async function|function)\\s+${name}\\s*\\(`, 'm'));
  assert.ok(m, `could not find function ${name} in ${APP_JS}`);
  const start = m.index;
  let depth = 0;
  let i = SRC.indexOf('{', start);
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) break; }
  }
  assert.ok(depth === 0 && i < SRC.length, `could not find matching close brace for ${name}`);
  return SRC.slice(start, i + 1);
}

function loadRunAudioScanQuick() {
  const dbfsFromAmpSrc = extractFunction('dbfsFromAmp');
  const channelLayoutGroupsSrc = extractFunction('channelLayoutGroups');
  const scanQuickSrc = extractFunction('runAudioScanQuick');

  // eslint-disable-next-line no-new-func
  return new Function(`${dbfsFromAmpSrc}\n${channelLayoutGroupsSrc}\n${scanQuickSrc}\nreturn runAudioScanQuick;`)();
}

const CH = 2, SR = 48000, BD = 16, BPS = 2, FRAME_SIZE = CH * BPS;
const MAX_BYTES = 40 * 1024 * 1024;
const HALF = Math.floor(MAX_BYTES / 2);

// Big enough to force two disjoint windows (start + end), per the same
// MAX_BYTES/half math runAudioScanQuick itself uses.
const DATA_SIZE = HALF * 2 + 1000; // divisible by FRAME_SIZE (4)

function buildFakeFile(dataSize) {
  const buf = new Uint8Array(dataSize); // zero-filled: silence everywhere by default
  const startSize = Math.min(HALF, dataSize);
  const endSize = Math.min(HALF, dataSize - startSize);
  const endOff = dataSize - endSize;

  // Plant a 3-frame clipping burst (also trips the digital-hit heuristic on
  // its first frame, since prev[] is 0 going in) at window-local frame 1000
  // of the END window, on channel 0.
  const burstLocalFrame = 1000;
  const burstAbsByteOff = endOff + burstLocalFrame * FRAME_SIZE;
  const sampleVal = 32000; // 32000/32768 = 0.9766 > default 0.95 clip threshold
  for (let i = 0; i < 3; i++) {
    const pos = burstAbsByteOff + i * FRAME_SIZE;
    buf[pos] = sampleVal & 0xff;
    buf[pos + 1] = (sampleVal >> 8) & 0xff;
  }

  const file = {
    slice(off, end) {
      const bytes = buf.slice(off, end);
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
  };

  const windowFrameOffsetEnd = Math.round((endOff - 0) / FRAME_SIZE);
  const expectedFileFrame = windowFrameOffsetEnd + burstLocalFrame + 1;
  return { file, expectedFileFrame };
}

test('a clip/hit found in the disjoint "end" window is reported at its real file position, not the start-window-adjacent position', async () => {
  const runAudioScanQuick = loadRunAudioScanQuick();
  const { file, expectedFileFrame } = buildFakeFile(DATA_SIZE);

  const extracted = {
    fmtInfo: { audioFormat: 1, numChannels: CH, sampleRate: SR, bitsPerSample: BD },
    dataChunk: { offset: 0, size: DATA_SIZE },
  };

  const result = await runAudioScanQuick(file, extracted, {}, null);

  assert.equal(result.digitalHits.count, 1, 'expected exactly one digital hit from the planted burst');
  assert.equal(result.digitalHits.examples[0].frame, expectedFileFrame,
    `hit frame should be the burst's real file position (${expectedFileFrame}), not a start-window-adjacent position`);
  assert.equal(result.digitalHits.examples[0].timeSec, expectedFileFrame / SR);

  const seg = result.clipping.segmentsPerChannel[0][0];
  assert.ok(seg, 'expected a clip segment on channel 0');
  assert.equal(seg.startFrame, expectedFileFrame,
    `clip segment startFrame should be the burst's real file position (${expectedFileFrame}), not a start-window-adjacent position`);
  assert.equal(seg.frames, 3);

  // scannedSeconds must still reflect total frames actually sampled across
  // both windows (a different concept from file position) -- the fix must
  // not touch this.
  const expectedScannedFrames = Math.floor(HALF / FRAME_SIZE) * 2;
  assert.equal(result.scannedSeconds, expectedScannedFrames / SR);
});

test('a clip run open at the tail of the "start" window does not merge across the gap into the "end" window', async () => {
  const runAudioScanQuick = loadRunAudioScanQuick();
  const startFrames = Math.floor(HALF / FRAME_SIZE);
  const buf = new Uint8Array(DATA_SIZE);
  const sampleVal = 32000;

  // Clip the last 3 frames of the START window on channel 0.
  for (let i = startFrames - 3; i < startFrames; i++) {
    const pos = i * FRAME_SIZE;
    buf[pos] = sampleVal & 0xff;
    buf[pos + 1] = (sampleVal >> 8) & 0xff;
  }
  // Clip the first 3 frames of the END window on channel 0 too, so a buggy
  // implementation that never resets clipRuns across the window boundary
  // would splice these into one 6-frame run spanning the gap.
  const endOff = DATA_SIZE - Math.min(HALF, DATA_SIZE - startFrames * FRAME_SIZE);
  for (let i = 0; i < 3; i++) {
    const pos = endOff + i * FRAME_SIZE;
    buf[pos] = sampleVal & 0xff;
    buf[pos + 1] = (sampleVal >> 8) & 0xff;
  }

  const file = {
    slice(off, end) {
      const bytes = buf.slice(off, end);
      return { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
  };
  const extracted = {
    fmtInfo: { audioFormat: 1, numChannels: CH, sampleRate: SR, bitsPerSample: BD },
    dataChunk: { offset: 0, size: DATA_SIZE },
  };

  const result = await runAudioScanQuick(file, extracted, {}, null);
  const segs = result.clipping.segmentsPerChannel[0];
  assert.equal(segs.length, 2, 'the two disjoint 3-frame bursts must be reported as two separate segments, not merged into one');
  assert.equal(segs[0].frames, 3);
  assert.equal(segs[1].frames, 3);
});
