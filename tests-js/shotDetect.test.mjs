import { test } from 'node:test';
import assert from 'node:assert/strict';
import { histCorrelation, chooseThreshold, segmentShots } from '../src/scripts/modules/conform/shotDetect.js';

// ── histCorrelation ─────────────────────────────────────────────────────────
test('histCorrelation: identical histograms → 1', () => {
  const h = [1, 2, 3, 4, 5];
  assert.equal(histCorrelation(h, h), 1);
});
test('histCorrelation: anti-correlated → negative', () => {
  assert.ok(histCorrelation([1, 2, 3, 4], [4, 3, 2, 1]) < 0);
});
test('histCorrelation: flat histograms treated as correlated (no NaN)', () => {
  assert.equal(histCorrelation([2, 2, 2], [5, 5, 5]), 1);
});

// ── chooseThreshold ─────────────────────────────────────────────────────────
test('chooseThreshold: <30 samples → default 0.85', () => {
  assert.equal(chooseThreshold([0.1, 0.2, 0.3]), 0.85);
});
test('chooseThreshold: single-shot content (all high corr) → backs off to 0.5', () => {
  const corr = Array.from({ length: 100 }, () => 0.99);
  assert.equal(chooseThreshold(corr), 0.5);
});
test('chooseThreshold: real cuts present → threshold just above cut band, clamped', () => {
  // 96 high-corr frames + 4 low-corr cuts. bottom 1.5% of 100 = 1 → cut_band_max = lowest.
  const corr = [0.2, 0.25, 0.3, 0.35, ...Array.from({ length: 96 }, () => 0.9)];
  const t = chooseThreshold(corr);
  assert.ok(t >= 0.5 && t <= 0.97, `threshold ${t} in range`);
  assert.ok(t < 0.9, 'threshold below the non-cut cluster');
});

// ── segmentShots ────────────────────────────────────────────────────────────
test('segmentShots: empty correlations → no shots', () => {
  const { shots } = segmentShots([], 0);
  assert.deepEqual(shots, []);
});
test('segmentShots: one clear cut → two shots, explicit threshold', () => {
  // 40 frames total → 39 correlations. A cut at correlations[19] (frame 20 starts new shot).
  const corr = Array.from({ length: 39 }, (_, i) => (i === 19 ? 0.1 : 0.99));
  const { shots } = segmentShots(corr, 40, { threshold: 0.5, minShotFrames: 12 });
  assert.equal(shots.length, 2);
  assert.deepEqual(shots[0], { startFrame: 0, endFrame: 19 });
  assert.deepEqual(shots[1], { startFrame: 20, endFrame: 39 });
});
test('segmentShots: cut before minShotFrames is ignored (absorbed)', () => {
  // cut at correlations[3] (frame 4) but minShotFrames 12 → not enough → single shot.
  const corr = Array.from({ length: 39 }, (_, i) => (i === 3 ? 0.1 : 0.99));
  const { shots } = segmentShots(corr, 40, { threshold: 0.5, minShotFrames: 12 });
  assert.equal(shots.length, 1);
  assert.deepEqual(shots[0], { startFrame: 0, endFrame: 39 });
});
test('segmentShots: single-shot on long clip emits a warning', () => {
  const corr = Array.from({ length: 300 }, () => 0.99);
  const { shots, warnings } = segmentShots(corr, 301, { threshold: 0.5 });
  assert.equal(shots.length, 1);
  assert.ok(warnings.some(w => /missed cuts/i.test(w)));
});
test('segmentShots: very dense cuts emit a warning', () => {
  // A cut every 12 frames satisfies minShotFrames yet is flagged as dense.
  const corr = Array.from({ length: 240 }, (_, i) => ((i + 1) % 12 === 0 ? 0.1 : 0.99));
  const { shots, warnings } = segmentShots(corr, 241, { threshold: 0.5, minShotFrames: 12 });
  assert.ok(shots.length > 240 / 12 - 1);
  assert.ok(warnings.some(w => /dense/i.test(w)));
});
