// ALE parser — contract + golden. Run: node --test test/parsers/ale.test.mjs
import '../_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseALE } from '../../src/scripts/parsers/ale.js';
import { assertParseResult, readFixture } from '../_contract.mjs';

test('ale_day.ale — Heading/Column/Data with tape column', () => {
  const res = parseALE(readFixture('ale_day.ale'), 'ale_day.ale');
  const evs = assertParseResult(res, { sourceType: 'ale' });

  assert.equal(evs.length, 2, 'exactly 2 events');
  assert.equal(res.fps, 24, 'FPS heading → 24');
  assert.equal(res.projectName, 'ale_day');
  assert.equal(evs[0].clipName, 'shot_010');
  assert.equal(evs[0].reel, 'A001', 'Tape column → reel');
  assert.equal(evs[0].srcFile, 'A001C001.mov');
  assert.equal(evs[0].srcIn, '01:00:00:00');
  assert.equal(evs[0].srcOut, '01:00:04:00');
  assert.equal(evs[1].reel, 'A002');
});
