import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldSearchAllMasters,
  pickBestMaster,
  resolveMaster,
  isEpisodeLibraryEvent,
  WEAK_MATCH_CONFIDENCE,
} from '../src/scripts/modules/conform/multiMaster.js';

// ── shouldSearchAllMasters ──────────────────────────────────────────────────
test('shouldSearchAllMasters: no pinned result → true', () => {
  assert.equal(shouldSearchAllMasters(null), true);
});
test('shouldSearchAllMasters: strong pinned match → false', () => {
  assert.equal(shouldSearchAllMasters({ confidence: 90 }), false);
});
test('shouldSearchAllMasters: weak pinned match → true', () => {
  assert.equal(shouldSearchAllMasters({ confidence: WEAK_MATCH_CONFIDENCE - 1 }), true);
});

test('isEpisodeLibraryEvent: accepts episode editorial labels', () => {
  assert.equal(isEpisodeLibraryEvent({ reel: 'TNG2_204_LOCKED3_20250724_hires_proxy.mp4' }), true);
  assert.equal(isEpisodeLibraryEvent({ srcFile: 'TheBelieversSeason2_208_Final.mov' }), true);
});

test('isEpisodeLibraryEvent: skips leaders and graphics', () => {
  assert.equal(isEpisodeLibraryEvent({ reel: 'Universal Counting Leader - STEREO' }), false);
  assert.equal(isEpisodeLibraryEvent({ srcFile: 'INTRO_INSERT_16x9_2S13F.mov' }), false);
  assert.equal(isEpisodeLibraryEvent({ srcFile: 'OUTRO_MAIN_PRE_COMINGSOON_ONLYON_16x9.mov' }), false);
});

// ── pickBestMaster ──────────────────────────────────────────────────────────
test('pickBestMaster: empty → null', () => {
  assert.equal(pickBestMaster([]), null);
});
test('pickBestMaster: highest confidence wins', () => {
  const best = pickBestMaster([
    { masterKey: 'EP01', result: { confidence: 60, distance: 200 } },
    { masterKey: 'EP02', result: { confidence: 88, distance: 60 } },
    { masterKey: 'EP03', result: { confidence: 71, distance: 120 } },
  ]);
  assert.equal(best.masterKey, 'EP02');
});
test('pickBestMaster: ties broken by lower distance', () => {
  const best = pickBestMaster([
    { masterKey: 'EP01', result: { confidence: 80, distance: 150 } },
    { masterKey: 'EP02', result: { confidence: 80, distance: 90 } },
  ]);
  assert.equal(best.masterKey, 'EP02');
});
test('pickBestMaster: skips entries without a result', () => {
  const best = pickBestMaster([
    { masterKey: 'EP01', result: null },
    { masterKey: 'EP02', result: { confidence: 55, distance: 220 } },
  ]);
  assert.equal(best.masterKey, 'EP02');
});

// ── resolveMaster ───────────────────────────────────────────────────────────
test('resolveMaster: library must beat pinned by margin to override', () => {
  const pinned = { masterKey: 'EP01', result: { confidence: 70 } };
  const closeLib = { masterKey: 'EP02', result: { confidence: 73 } }; // +3 < margin 6
  assert.equal(resolveMaster(pinned, closeLib).masterKey, 'EP01');
  const clearLib = { masterKey: 'EP02', result: { confidence: 80 } }; // +10 ≥ margin
  assert.equal(resolveMaster(pinned, clearLib).masterKey, 'EP02');
});
test('resolveMaster: same master → keeps stronger result', () => {
  const pinned = { masterKey: 'EP01', result: { confidence: 70 } };
  const lib    = { masterKey: 'EP01', result: { confidence: 85 } };
  assert.equal(resolveMaster(pinned, lib).result.confidence, 85);
});
test('resolveMaster: no library best → keep pinned; no pinned → take library', () => {
  const pinned = { masterKey: 'EP01', result: { confidence: 70 } };
  assert.equal(resolveMaster(pinned, null), pinned);
  const lib = { masterKey: 'EP02', result: { confidence: 50 } };
  assert.equal(resolveMaster(null, lib), lib);
});
