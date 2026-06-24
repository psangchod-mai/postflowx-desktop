/**
 * Tests for scripts/modules/filters_vfxRename.js and filters_common.js
 * Run: node --test tests/js/filters_vfxrename.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onlyVfxRename } from '../src/scripts/modules/filters_vfxRename.js';
import { tc, stemNoExt } from '../src/scripts/modules/filters_common.js';

// ── filters_common.js / tc() ─────────────────────────────────────────────────

test('tc: passthrough for valid HH:MM:SS:FF', () => {
  assert.equal(tc('01:23:45:12'), '01:23:45:12');
  assert.equal(tc('00:00:00:00'), '00:00:00:00');
});

test('tc: pads 3-part timecode HH:MM:SS → HH:MM:SS:00', () => {
  assert.equal(tc('01:23:45'), '01:23:45:00');
});

test('tc: converts rational seconds "A/Bs" to HH:MM:SS:FF at 24fps', () => {
  // A/Bs means A/B *seconds*; 48/1s = 48 seconds × 24fps = 1152 frames = 00:00:48:00
  assert.equal(tc('48/1s', 24), '00:00:48:00');
  // 1/24s = 1/24 second × 24fps = 1 frame → 00:00:00:01
  assert.equal(tc('1/24s', 24), '00:00:00:01');
  // 24/1s = 24 seconds × 24fps = 576 frames → 00:00:24:00
  assert.equal(tc('24/1s', 24), '00:00:24:00');
});

test('tc: zero denominator returns 00:00:00:00', () => {
  assert.equal(tc('24/0s', 24), '00:00:00:00');
});

test('tc: null/empty returns 00:00:00:00', () => {
  assert.equal(tc(null), '00:00:00:00');
  assert.equal(tc(''), '00:00:00:00');
  assert.equal(tc('garbage'), '00:00:00:00');
});

// ── filters_common.js / stemNoExt() ──────────────────────────────────────────

test('stemNoExt: strips single extension', () => {
  assert.equal(stemNoExt('A001C001.mov'), 'A001C001');
  assert.equal(stemNoExt('clip.mxf'), 'clip');
  assert.equal(stemNoExt('my.file.r3d'), 'my.file');
});

test('stemNoExt: no extension returns name unchanged', () => {
  assert.equal(stemNoExt('A001C001'), 'A001C001');
});

test('stemNoExt: empty/null returns empty string', () => {
  assert.equal(stemNoExt(''), '');
  assert.equal(stemNoExt(null), '');
});

// ── onlyVfxRename ─────────────────────────────────────────────────────────────

function makeEv(clipName, srcFile, reel = '', overrides = {}) {
  return {
    clipName,
    srcFile,
    reel,
    recIn:  '01:00:00:00',
    srcIn:  '01:00:00:00',
    srcOut: '01:00:01:00',
    recOut: '01:00:01:00',
    fps: 24,
    ...overrides,
  };
}

test('onlyVfxRename: null/empty returns empty', () => {
  assert.deepEqual(onlyVfxRename(null), []);
  assert.deepEqual(onlyVfxRename([]), []);
});

test('onlyVfxRename: keeps event where clipName differs from srcFile stem', () => {
  // srcFile stem = A001C001, clipName stem = ShotA → renamed
  const evs = [makeEv('ShotA', 'A001C001.mov')];
  const result = onlyVfxRename(evs);
  assert.equal(result.length, 1);
  assert.equal(result[0].vfxRename, true);
});

test('onlyVfxRename: removes event where clipName === srcFile stem (not renamed)', () => {
  const evs = [makeEv('A001C001', 'A001C001.mov')];
  const result = onlyVfxRename(evs);
  assert.equal(result.length, 0);
});

test('onlyVfxRename: uses reel when srcFile is empty', () => {
  // reel stem = A001C001, clipName = ShotA → renamed
  const evs = [makeEv('ShotA', '', 'A001C001')];
  const result = onlyVfxRename(evs);
  assert.equal(result.length, 1);
});

test('onlyVfxRename: removes event with no srcFile and no reel', () => {
  const evs = [makeEv('ShotA', '', '')];
  const result = onlyVfxRename(evs);
  assert.equal(result.length, 0);
});

test('onlyVfxRename: removes nested/compound/multicam clips', () => {
  const nested = [
    makeEv('ShotA', 'A001C001.mov', '', { clipName: 'Nested Sequence' }),
    makeEv('ShotB', 'B002C002.mov', '', { clipName: 'Compound Clip' }),
    makeEv('ShotC', 'C003C003.mov', '', { clipName: 'Multicam Clip' }),
  ];
  const result = onlyVfxRename(nested);
  assert.equal(result.length, 0);
});

test('onlyVfxRename: preserves non-nested renamed clips in mixed array', () => {
  const evs = [
    makeEv('ShotA',          'A001C001.mov'),  // renamed → kept
    makeEv('A001C001',       'A001C001.mov'),  // same stem → removed
    makeEv('Nested Sequence','B002C002.mov'),  // nested → removed
    makeEv('ShotD',          'D004C004.mov'),  // renamed → kept
  ];
  const result = onlyVfxRename(evs);
  assert.equal(result.length, 2);
});

test('onlyVfxRename: adds locatorVFX field', () => {
  const evs = [makeEv('ShotA', 'A001C001.mov')];
  const result = onlyVfxRename(evs);
  assert.ok(result[0].locatorVFX?.startsWith('LOC:'));
  assert.ok(result[0].locatorVFX?.includes('RED'));
});

test('onlyVfxRename: preserves original event fields', () => {
  const ev = makeEv('ShotA', 'A001C001.mov', 'A001C001', { fps: 25 });
  const result = onlyVfxRename([ev]);
  assert.equal(result[0].fps, 25);
  assert.equal(result[0].recIn, '01:00:00:00');
});

test('onlyVfxRename: assigns numeric id from index when missing', () => {
  const evs = [
    makeEv('ShotA', 'A001C001.mov'),
    makeEv('ShotB', 'B002C002.mov'),
  ];
  const result = onlyVfxRename(evs);
  assert.equal(typeof result[0].id, 'number');
  assert.equal(typeof result[1].id, 'number');
});
