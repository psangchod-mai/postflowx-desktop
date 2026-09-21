// Premiere (.prproj) parser — contract + golden. Exercises the gzip auto-detect
// path. Run: node --test test/parsers/prproj.test.mjs
import '../_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePRPROJ } from '../../src/scripts/parsers/prproj.js';
import { assertParseResult, readFixtureBuffer } from '../_contract.mjs';

function fixtureArrayBuffer(name) {
  const b = readFixtureBuffer(name);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

test('premiere_basic.prproj — gzip XML, 2 clips, one disabled', async () => {
  const res = await parsePRPROJ(fixtureArrayBuffer('premiere_basic.prproj'));
  // parsePRPROJ returns { events, fps, projectName } (no sourceType field)
  const evs = assertParseResult(res);

  assert.equal(evs.length, 2, 'exactly 2 events');
  assert.equal(res.fps, 24, '24 fps (default TimeBase)');
  assert.equal(res.projectName, 'PREMIERE BASIC');
  // event[0] — enabled
  assert.equal(evs[0].clipName, 'shot_010');
  assert.equal(evs[0].reel, 'A001', 'LoggingInfo TapeName → reel');
  assert.equal(evs[0].srcIn, '01:00:00:00', 'VideoStartTime + In ticks → source TC');
  assert.equal(evs[0].srcOut, '01:00:04:00');
  assert.ok(!evs[0].disabled, 'event[0] enabled');
  // event[1] — disabled
  assert.equal(evs[1].reel, 'A002');
  assert.equal(evs[1].disabled, true, 'Enabled=false → disabled');
});
