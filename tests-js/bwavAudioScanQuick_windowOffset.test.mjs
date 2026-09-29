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
  let quote = '';
  for (; i < SRC.length; i++) {
    const char = SRC[i];
    if (quote) {
      if (char === '\\') { i++; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '/' && SRC[i + 1] === '/') {
      i = SRC.indexOf('\n', i);
      if (i < 0) break;
      continue;
    }
    if (char === '/' && SRC[i + 1] === '*') {
      i = SRC.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    else if (char === '}') { depth--; if (depth === 0) break; }
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

// ── ADM content-label regression coverage ───────────────────────────────────
const supportedExtensions = SRC.match(/const SUPPORTED_ASSET_EXTENSIONS =[^;]+;/)?.[0];
assert.ok(supportedExtensions, 'supported-extension contract is present');
const { isSupportedAssetFile, classifyContentGroupLabels, extractStructuredTextContentGroups, registryLexiconEntries, buildSynonymSets } = new Function(
  `${extractFunction('normalizeLabel')}\n${supportedExtensions}\n${extractFunction('fileExtension')}\n${extractFunction('isSupportedAssetFile')}\n${extractFunction('extractContentGroupCandidates')}\n${extractFunction('extractJsonContentGroupCandidates')}\n${extractFunction('_yamlScalar')}\n${extractFunction('parseAtmosIrYaml')}\n${extractFunction('extractStructuredTextContentGroups')}\n${extractFunction('registryLexiconEntries')}\n${extractFunction('buildSynonymSets')}\n${extractFunction('classifyContentGroupLabels')}\nreturn { isSupportedAssetFile, classifyContentGroupLabels, extractStructuredTextContentGroups, registryLexiconEntries, buildSynonymSets };`
)();

const contentLabelSets = buildSynonymSets({ Dialogue: ['Dialogue'], Music: [], Effects: [], Narration: [] });

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

test('supported asset extensions include the documented Atmos contract and reject others', () => {
  for (const extension of ['mxf', 'wav', 'wave', 'rf64', 'bw64', 'pio', 'atmosir']) {
    assert.equal(isSupportedAssetFile({ name: `asset.${extension.toUpperCase()}` }), true, extension);
  }
  assert.equal(isSupportedAssetFile({ name: 'asset.mp3' }), false);
});

test('content-label outcomes require exact registry values and preserve known labels beside every unknown', () => {
  const rows = classifyContentGroupLabels([
    { rawLabel: 'Dialogue', source: 'ADM content group' },
    { rawLabel: 'Dialogue', source: 'ADM content group' },
    { rawLabel: 'DIALOGUE', source: 'ADM content group' },
    { rawLabel: 'Dia_logue', source: 'ADM content group' },
    { rawLabel: 'Dia logue', source: 'ADM content group' },
    { rawLabel: 'Dialogue ', source: 'ADM content group' },
    { rawLabel: 'Not in registry', source: 'ADM content group' },
    { rawLabel: 'Another unknown label', source: 'ADM content group' },
    { rawLabel: '', source: 'ADM content group' },
    { rawLabel: 'Atmos_Master_Content', source: 'ADM content group' }
  ], contentLabelSets);

  assert.deepEqual(rows.map(({ status, outcome, rawLabel }) => ({ status, outcome, rawLabel })), [
    { status: 'PASS', outcome: 'DUPLICATE', rawLabel: 'Dialogue' },
    { status: 'PASS', outcome: 'DUPLICATE', rawLabel: 'Dialogue' },
    { status: 'REJECT', outcome: 'UNKNOWN', rawLabel: 'DIALOGUE' },
    { status: 'REJECT', outcome: 'UNKNOWN', rawLabel: 'Dia_logue' },
    { status: 'REJECT', outcome: 'UNKNOWN', rawLabel: 'Dia logue' },
    { status: 'REJECT', outcome: 'UNKNOWN', rawLabel: 'Dialogue ' },
    { status: 'REJECT', outcome: 'UNKNOWN', rawLabel: 'Not in registry' },
    { status: 'REJECT', outcome: 'UNKNOWN', rawLabel: 'Another unknown label' },
    { status: 'REJECT', outcome: 'EMPTY', rawLabel: '' },
    { status: 'REJECT', outcome: 'UNLABELLED', rawLabel: 'Atmos_Master_Content' }
  ]);
});

test('structured PIO and AtmosIR text routes only explicit ADM audioContent structures into validation', () => {
  const json = extractStructuredTextContentGroups('{"audioContent":[{"audioContentName":"Dialogue"}]}');
  assert.deepEqual(json, { candidates: [{ rawLabel: 'Dialogue', source: 'ADM content group (JSON)' }], kind: 'json' });

  const yaml = extractStructuredTextContentGroups('audioContent:\n  - audioContentName: Dialogue\n');
  assert.equal(yaml.kind, 'yaml');
  assert.deepEqual(yaml.candidates, [{ rawLabel: 'Dialogue', source: 'ADM content group (JSON)' }]);

  assert.equal(extractStructuredTextContentGroups('{not json').kind, 'malformed-json');
  assert.equal(extractStructuredTextContentGroups('unsupported binary-looking text').kind, 'unrecognized');
});

test('structured XML retains the exact audioContent label text', () => {
  const priorDomParser = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString() {
      const group = { getAttribute: () => 'Dialogue ', getElementsByTagNameNS: () => [], getElementsByTagName: () => [] };
      return { querySelector: () => null, getElementsByTagNameNS: (_namespace, name) => name === 'audioContent' ? [group] : [], getElementsByTagName: () => [] };
    }
  };
  try {
    const xml = extractStructuredTextContentGroups('<audioFormatExtended/>');
    assert.equal(xml.kind, 'xml');
    assert.deepEqual(xml.candidates, [{ rawLabel: 'Dialogue ', source: 'ADM content group' }]);
  } finally {
    globalThis.DOMParser = priorDomParser;
  }
});

test('installed lexicon preserves registry strings exactly', () => {
  assert.deepEqual(registryLexiconEntries({ validAudioContentGroups: [{ groupName: 'Dialogue', labels: ['Dialogue', 'Dialogue '], validContentLabelSubGroups: [] }] }), [
    { group: 'Dialogue', subgroup: '', label: 'Dialogue' },
    { group: 'Dialogue', subgroup: '', label: 'Dialogue ' }
  ]);
});

test('untrusted labels are escaped before table rendering', () => {
  assert.match(SRC, /\$\{escapeHtml\(r\.rawLabel \|\| ""\)\}/);
});

test('zero-byte telemetry is generic and excludes the selected filename', () => {
  const zeroByteBranch = SRC.match(/if \(typeof file\.size === 'number' && file\.size === 0\) \{[\s\S]{0,500}/)?.[0];
  assert.ok(zeroByteBranch, 'zero-byte rejection branch exists');
  assert.match(zeroByteBranch, /bgLog\('Rejected zero-byte file', \{ reason: '0_bytes' \}\)/);
  assert.doesNotMatch(zeroByteBranch, /name\s*:/);
  assert.doesNotMatch(zeroByteBranch, /file\?\.name/);
});

test('the lexicon aria label uses the locale attribute pattern in every locale', () => {
  const html = readFileSync(join(ROOT, 'src/tools/bwav/app.html'), 'utf8');
  assert.match(html, /data-i18n-aria-label="lexicon\.ariaLabel"/);
  assert.match(SRC, /querySelectorAll\("\[data-i18n-aria-label\]"\)/);
  assert.equal((SRC.match(/"lexicon\.ariaLabel"/g) || []).length, 6);
});
