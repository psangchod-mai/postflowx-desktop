import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeAdjacentMatches } from '../src/scripts/modules/conform/mergeMatches.js';

const mk = (o) => ({
  offlineStart: 0, offlineEnd: 0, masterKey: 'EP01', masterStart: 0, masterEnd: 0,
  confidence: 90, status: 'OK', ...o,
});

test('mergeMatches: fewer than 2 → unchanged copy', () => {
  assert.deepEqual(mergeAdjacentMatches([]), []);
  const one = [mk({})];
  assert.deepEqual(mergeAdjacentMatches(one), one);
});

test('mergeMatches: same master, adjacent offline + master → merged into one', () => {
  const a = mk({ offlineStart: 0,  offlineEnd: 23,  masterStart: 100, masterEnd: 123, confidence: 85 });
  const b = mk({ offlineStart: 24, offlineEnd: 47,  masterStart: 124, masterEnd: 147, confidence: 92 });
  const out = mergeAdjacentMatches([a, b]);
  assert.equal(out.length, 1);
  assert.equal(out[0].offlineStart, 0);
  assert.equal(out[0].offlineEnd, 47);
  assert.equal(out[0].masterStart, 100);
  assert.equal(out[0].masterEnd, 147);
  assert.equal(out[0].confidence, 92); // better of the two
  assert.equal(out[0].merged, true);
});

test('mergeMatches: different masters → not merged', () => {
  const a = mk({ offlineStart: 0,  offlineEnd: 23, masterKey: 'EP01', masterStart: 100, masterEnd: 123 });
  const b = mk({ offlineStart: 24, offlineEnd: 47, masterKey: 'EP02', masterStart: 124, masterEnd: 147 });
  assert.equal(mergeAdjacentMatches([a, b]).length, 2);
});

test('mergeMatches: NO_MATCH halves are never merged', () => {
  const a = mk({ offlineStart: 0,  offlineEnd: 23, masterStart: 100, masterEnd: 123, status: 'NO_MATCH', masterKey: null });
  const b = mk({ offlineStart: 24, offlineEnd: 47, masterStart: 124, masterEnd: 147 });
  assert.equal(mergeAdjacentMatches([a, b]).length, 2);
});

test('mergeMatches: master gap beyond tolerance → not merged', () => {
  const a = mk({ offlineStart: 0,  offlineEnd: 23, masterStart: 100, masterEnd: 123 });
  const b = mk({ offlineStart: 24, offlineEnd: 47, masterStart: 200, masterEnd: 223 }); // gap 77 > 24
  assert.equal(mergeAdjacentMatches([a, b]).length, 2);
});

test('mergeMatches: master runs backwards → not merged', () => {
  const a = mk({ offlineStart: 0,  offlineEnd: 23, masterStart: 200, masterEnd: 223 });
  const b = mk({ offlineStart: 24, offlineEnd: 47, masterStart: 100, masterEnd: 123 }); // backwards
  assert.equal(mergeAdjacentMatches([a, b]).length, 2);
});

test('mergeMatches: offline gap (non-adjacent) → not merged', () => {
  const a = mk({ offlineStart: 0,  offlineEnd: 23, masterStart: 100, masterEnd: 123 });
  const b = mk({ offlineStart: 40, offlineEnd: 60, masterStart: 124, masterEnd: 147 }); // gap in offline
  assert.equal(mergeAdjacentMatches([a, b]).length, 2);
});

test('mergeMatches: chains 3 adjacent halves into one', () => {
  const a = mk({ offlineStart: 0,  offlineEnd: 11, masterStart: 100, masterEnd: 111, confidence: 80 });
  const b = mk({ offlineStart: 12, offlineEnd: 23, masterStart: 112, masterEnd: 123, confidence: 88 });
  const c = mk({ offlineStart: 24, offlineEnd: 35, masterStart: 124, masterEnd: 135, confidence: 84 });
  const out = mergeAdjacentMatches([a, b, c]);
  assert.equal(out.length, 1);
  assert.equal(out[0].offlineEnd, 35);
  assert.equal(out[0].masterEnd, 135);
  assert.equal(out[0].confidence, 88);
});
