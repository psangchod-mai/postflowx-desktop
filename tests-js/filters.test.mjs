/**
 * Tests for scripts/modules/filters.js — event pipeline
 * Run: node --test tests/js/filters.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEvents,
  decomposeEvents,
  flattenTracks,
  filterCameraOriginal,
  filterValidTimecode,
  addExtraHandlesForFastClips,
  dedupeBySrcRange,
  runPipeline,
} from '../src/scripts/modules/filters.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeEv(recIn, recOut, overrides = {}) {
  return {
    clipName: 'CLIP',
    reel:     'REEL',
    srcFile:  '',
    srcIn:    recIn,
    srcOut:   recOut,
    recIn,
    recOut,
    fps:      24,
    disabled: false,
    sourceType: 'edl',
    ...overrides,
  };
}

// ── normalizeEvents ───────────────────────────────────────────────────────────

test('normalizeEvents: adds sequential ids when missing', () => {
  const evs = [{ clipName: 'A' }, { clipName: 'B' }];
  const result = normalizeEvents(evs);
  assert.equal(result[0].id, 0);
  assert.equal(result[1].id, 1);
});

test('normalizeEvents: preserves existing id', () => {
  const evs = [{ id: 42, clipName: 'X' }];
  const result = normalizeEvents(evs);
  assert.equal(result[0].id, 42);
});

test('normalizeEvents: null/empty returns empty', () => {
  assert.deepEqual(normalizeEvents(null), []);
  assert.deepEqual(normalizeEvents([]), []);
});

// ── filterValidTimecode ───────────────────────────────────────────────────────

test('filterValidTimecode: keeps events with valid non-zero timecodes', () => {
  const evs = [makeEv('01:00:00:00', '01:00:01:00')];
  assert.equal(filterValidTimecode(evs, 24).length, 1);
});

test('filterValidTimecode: removes events where srcIn=srcOut (zero duration)', () => {
  const evs = [makeEv('01:00:00:00', '01:00:00:00')];
  assert.equal(filterValidTimecode(evs, 24).length, 0);
});

test('filterValidTimecode: removes events where all TCs are 00:00:00:00', () => {
  const evs = [{
    srcIn: '00:00:00:00', srcOut: '00:00:00:00',
    recIn: '00:00:00:00', recOut: '00:00:00:00',
    fps: 24,
  }];
  assert.equal(filterValidTimecode(evs, 24).length, 0);
});

test('filterValidTimecode: removes events where recOut <= recIn', () => {
  const evs = [makeEv('01:00:05:00', '01:00:03:00')]; // out before in
  assert.equal(filterValidTimecode(evs, 24).length, 0);
});

test('filterValidTimecode: keeps valid, removes invalid from mixed array', () => {
  const evs = [
    makeEv('01:00:00:00', '01:00:01:00'),  // valid
    makeEv('01:00:00:00', '01:00:00:00'),  // zero-dur — removed
    makeEv('00:00:00:00', '00:00:01:00'),  // valid (non-zero rec)
  ];
  assert.equal(filterValidTimecode(evs, 24).length, 2);
});

// ── filterCameraOriginal ──────────────────────────────────────────────────────

test('filterCameraOriginal: keeps ARRI-style camera clips by srcFile', () => {
  const evs = [
    makeEv('01:00:00:00', '01:00:01:00', { srcFile: 'A001C001_251026_075200.mov' }),
  ];
  assert.equal(filterCameraOriginal(evs).length, 1);
});

test('filterCameraOriginal: keeps R3D by extension', () => {
  const evs = [
    makeEv('01:00:00:00', '01:00:01:00', { srcFile: 'A007C012.r3d' }),
  ];
  assert.equal(filterCameraOriginal(evs).length, 1);
});

test('filterCameraOriginal: keeps .braw by extension', () => {
  const evs = [
    makeEv('01:00:00:00', '01:00:01:00', { srcFile: 'clip.braw' }),
  ];
  assert.equal(filterCameraOriginal(evs).length, 1);
});

test('filterCameraOriginal: keeps camera-named .mxf', () => {
  // Plain clip.mxf has no camera pattern → filtered out.
  // An ARRI-named .mxf is detected by looksLikeCameraOCF().
  const plain = [makeEv('01:00:00:00', '01:00:01:00', { srcFile: 'clip.mxf', reel: '' })];
  assert.equal(filterCameraOriginal(plain).length, 0,
    'Generic clip.mxf must not be treated as OCF — requires camera naming pattern');

  const arri = [makeEv('01:00:00:00', '01:00:01:00', {
    srcFile: 'A001C001_251026_075200.mxf', reel: '',
  })];
  assert.equal(filterCameraOriginal(arri).length, 1,
    'ARRI-named .mxf should be treated as OCF');
});

test('filterCameraOriginal: filters out generic non-OCF clip', () => {
  const evs = [
    makeEv('01:00:00:00', '01:00:01:00', { srcFile: 'generic_title.mp4', reel: '' }),
  ];
  assert.equal(filterCameraOriginal(evs).length, 0);
});

test('filterCameraOriginal: checks reel when srcFile is empty', () => {
  const evs = [
    makeEv('01:00:00:00', '01:00:01:00', { srcFile: '', reel: 'A001C001_251026' }),
  ];
  assert.equal(filterCameraOriginal(evs).length, 1);
});

test('filterCameraOriginal: empty array returns empty', () => {
  assert.deepEqual(filterCameraOriginal([]), []);
});

// ── addExtraHandlesForFastClips ───────────────────────────────────────────────

test('addExtraHandlesForFastClips: no extra handles for 100% speed', () => {
  const evs = [makeEv('01:00:00:00', '01:00:01:00', { speedFactor: 100 })];
  const result = addExtraHandlesForFastClips(evs, { fps: 24 });
  assert.equal(result[0]._extraHandles, undefined);
});

test('addExtraHandlesForFastClips: adds handles for 200% speed', () => {
  const evs = [makeEv('01:00:00:00', '01:00:01:00', { speedFactor: 200 })];
  const result = addExtraHandlesForFastClips(evs, { fps: 24 });
  assert.ok(result[0]._extraHandles != null);
  assert.ok(result[0]._extraHandles.head >= 8);
  assert.ok(result[0]._extraHandles.tail >= 8);
});

test('addExtraHandlesForFastClips: handles capped at 48 frames', () => {
  const evs = [makeEv('01:00:00:00', '01:00:01:00', { speedFactor: 1000 })];
  const result = addExtraHandlesForFastClips(evs, { fps: 24 });
  assert.ok(result[0]._extraHandles.head <= 48);
  assert.ok(result[0]._extraHandles.tail <= 48);
});

test('addExtraHandlesForFastClips: no handles for 80% (slow) speed', () => {
  const evs = [makeEv('01:00:00:00', '01:00:01:00', { speedFactor: 80 })];
  const result = addExtraHandlesForFastClips(evs, { fps: 24 });
  assert.equal(result[0]._extraHandles, undefined);
});

// ── decomposeEvents ───────────────────────────────────────────────────────────

test('decomposeEvents: single-track events sorted by recIn', () => {
  const evs = [
    makeEv('01:00:10:00', '01:00:11:00'),
    makeEv('01:00:00:00', '01:00:01:00'),
    makeEv('01:00:05:00', '01:00:06:00'),
  ];
  const result = decomposeEvents(evs);
  assert.ok(result[0].recIn <= result[1].recIn);
  assert.ok(result[1].recIn <= result[2].recIn);
});

test('decomposeEvents: V2 track appended after V1', () => {
  const v1a = makeEv('01:00:00:00', '01:00:01:00', { trackIndex: 0 });
  const v1b = makeEv('01:00:01:00', '01:00:02:00', { trackIndex: 0 });
  const v2  = makeEv('01:00:00:00', '01:00:01:00', { trackIndex: 1 });
  const result = decomposeEvents([v1a, v1b, v2]);
  // V1 items come first, V2 appended at end
  const v1Items = result.filter(e => e._origTrackIndex === undefined);
  const v2Items = result.filter(e => e._origTrackIndex === 1);
  assert.equal(v1Items.length, 2);
  assert.equal(v2Items.length, 1);
  // V2 item should start after last V1 ends
  const lastV1Out = Math.max(...v1Items.map(e => e.recOut));
  assert.ok(v2Items[0].recIn >= lastV1Out || v2Items[0].recIn === '01:00:02:00');
});

test('decomposeEvents: empty array returns empty', () => {
  assert.deepEqual(decomposeEvents([]), []);
});

// ── dedupeBySrcRange ──────────────────────────────────────────────────────────

test('dedupeBySrcRange: removes exact duplicate src ranges', () => {
  const evs = [
    makeEv('01:00:00:00', '01:00:01:00', { srcIn: '10:00:00:00', srcOut: '10:00:01:00', reel: 'REEL1' }),
    makeEv('02:00:00:00', '02:00:01:00', { srcIn: '10:00:00:00', srcOut: '10:00:01:00', reel: 'REEL1' }),
  ];
  const result = dedupeBySrcRange(evs);
  assert.equal(result.length, 1);
});

test('dedupeBySrcRange: keeps different reels with same TC range', () => {
  const evs = [
    makeEv('01:00:00:00', '01:00:01:00', { srcIn: '10:00:00:00', srcOut: '10:00:01:00', reel: 'REEL1' }),
    makeEv('02:00:00:00', '02:00:01:00', { srcIn: '10:00:00:00', srcOut: '10:00:01:00', reel: 'REEL2' }),
  ];
  const result = dedupeBySrcRange(evs);
  assert.equal(result.length, 2);
});

// ── runPipeline ───────────────────────────────────────────────────────────────

test('runPipeline: empty events returns empty array', () => {
  assert.deepEqual(runPipeline([], {}), []);
});

test('runPipeline: always runs filterValidTimecode', () => {
  const evs = [
    makeEv('01:00:00:00', '01:00:01:00'),   // valid
    makeEv('00:00:00:00', '00:00:00:00'),   // all-zero → removed
  ];
  const result = runPipeline(evs, {});
  assert.equal(result.length, 1);
});

test('runPipeline: hideDisabled removes disabled events', () => {
  const evs = [
    makeEv('01:00:00:00', '01:00:01:00', { disabled: false }),
    makeEv('01:00:01:00', '01:00:02:00', { disabled: true }),
  ];
  const result = runPipeline(evs, { hideDisabled: true });
  assert.equal(result.length, 1);
});

test('runPipeline: result items have sequential ids', () => {
  const evs = [
    makeEv('01:00:00:00', '01:00:01:00'),
    makeEv('01:00:01:00', '01:00:02:00'),
  ];
  const result = runPipeline(evs, {});
  assert.equal(result[0].id, 0);
  assert.equal(result[1].id, 1);
});

test('runPipeline: conformOCF keeps only camera-original clips', () => {
  const evs = [
    makeEv('01:00:00:00', '01:00:01:00', { srcFile: 'A001C001_251026.mov', reel: 'A001C001' }),
    makeEv('01:00:01:00', '01:00:02:00', { srcFile: 'graphic_title.mp4',  reel: 'TITLE' }),
  ];
  const result = runPipeline(evs, { conformOCF: true });
  assert.equal(result.length, 1);
  assert.ok(result[0].clipName !== 'graphic_title');
});

test('runPipeline: decompose does not crash on single-track events', () => {
  const evs = [
    makeEv('01:00:00:00', '01:00:01:00'),
    makeEv('01:00:01:00', '01:00:02:00'),
  ];
  assert.doesNotThrow(() => runPipeline(evs, { decompose: true }));
});
