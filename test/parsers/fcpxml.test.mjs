// FCPXML parser — contract + golden. Run: node --test test/parsers/fcpxml.test.mjs
import '../_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFCPXML } from '../../src/scripts/parsers/fcpxml.js';
import { assertParseResult, readFixture } from '../_contract.mjs';

test('fcpx_basic.fcpxml — 2 clips, 25fps', () => {
  const res = parseFCPXML(readFixture('fcpx_basic.fcpxml'));
  const evs = assertParseResult(res, { sourceType: 'fcpxml' });

  assert.equal(evs.length, 2, 'exactly 2 events');
  assert.equal(res.fps, 25, 'frameDuration 1/25s → 25 fps');
  assert.equal(res.projectName, 'FCPX BASIC');
  assert.equal(evs[0].clipName, 'shot_010', 'asset-clip name → clipName');
  assert.equal(evs[0].reel, 'A001C001', 'asset name → reel');
  assert.equal(evs[0].srcFile, 'A001C001.mov', 'media-rep src → srcFile');
  assert.equal(evs[0].srcIn, '01:00:00:00');
  assert.equal(evs[0].srcOut, '01:00:04:00');
  assert.equal(evs[0].recIn, '01:00:00:00', 'sequence tcStart offsets record TC');
  assert.equal(evs[1].srcIn, '00:33:20:00', 'asset start 50000/25s = 33:20');
  assert.equal(evs[1].recIn, '01:00:04:00', 'second clip record position');
});

test('mixed_rate.fcpxml — 24 + 30 clips resolve to correct seconds', () => {
  const res = parseFCPXML(readFixture('mixed_rate.fcpxml'));
  const evs = assertParseResult(res, { sourceType: 'fcpxml' });

  assert.equal(evs.length, 2);
  assert.equal(res.fps, 24, 'sequence format rate (clips normalized to it)');
  assert.equal(evs[0].srcIn, '01:00:00:00', '24fps clip');
  // 30fps asset start 54000/30 = 1800s = 00:30:00 — correct regardless of nominal rate
  assert.equal(evs[1].srcIn, '00:30:00:00', '30fps source time resolved to correct seconds');
  assert.equal(evs[1].recIn, '01:00:04:00', 'placed after the 24fps clip (96f = 4s)');
});
