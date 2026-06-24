// EDL (CMX3600) parser — contract + golden. Run: node --test test/parsers/edl.test.mjs
import '../_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEDL } from '../../src/scripts/parsers/edl.js';
import { assertParseResult, readFixture, normalizeEvent } from '../_contract.mjs';

test('simple_24.edl — contract + golden', () => {
  const res = parseEDL(readFixture('simple_24.edl'), 'simple_24.edl');
  const evs = assertParseResult(res, { sourceType: 'edl' });

  // golden
  assert.equal(evs.length, 3, 'exactly 3 events');
  assert.equal(res.fps, 24, 'guessed 24 fps');
  assert.equal(evs[0].srcIn, '01:00:00:00', 'event[0].srcIn');
  assert.equal(evs[0].srcOut, '01:00:04:00', 'event[0].srcOut');
  // SOURCE FILE comment overrides reel with the file stem.
  assert.equal(evs[0].reel, 'A001_C001', 'SOURCE FILE → reel = file stem');
  assert.equal(evs[0].clipName, 'shot_010', 'FROM CLIP NAME → clipName');
  assert.equal(evs[0].srcFile, 'A001_C001.mov', 'SOURCE FILE → srcFile');
  assert.equal(evs[2].reel, 'A003_C001', 'event[2].reel from SOURCE FILE');
});

test('dissolve_df.edl — drop-frame + D025 dissolve', () => {
  const res = parseEDL(readFixture('dissolve_df.edl'), 'dissolve_df.edl');
  const evs = assertParseResult(res, { sourceType: 'edl' });

  assert.equal(evs.length, 2, 'exactly 2 events');
  assert.equal(res.fps, 30, 'DROP FRAME FCM → 30 fps');
  assert.equal(evs[1].transition, 'D025', 'dissolve transition captured as D025');
  // drop-frame TCs use ';'
  assert.match(evs[0].recIn, /;/, 'drop-frame TC uses semicolon');
});
