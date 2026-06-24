// OTIO parser — contract + golden. Run: node --test test/parsers/otio.test.mjs
import '../_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOTIO } from '../../src/scripts/parsers/otio.js';
import { assertParseResult, readFixture } from '../_contract.mjs';

test('resolve_basic.otio — 3 clips, media_reference, 24fps', () => {
  const res = parseOTIO(readFixture('resolve_basic.otio'));
  const evs = assertParseResult(res, { sourceType: 'otio' });

  assert.equal(evs.length, 3, 'exactly 3 events');
  assert.equal(res.fps, 24, '24 fps');
  assert.equal(res.projectName, 'RESOLVE BASIC');
  // event[0] — has media_reference
  assert.equal(evs[0].clipName, 'A001C001');
  assert.equal(evs[0].reel, 'A001C001');
  assert.equal(evs[0].srcFile, 'A001C001.mov', 'media_reference target_url → srcFile');
  assert.equal(evs[0].srcIn, '01:00:00:00');
  assert.equal(evs[0].srcOut, '01:00:04:00');
  assert.equal(evs[0].recIn, '01:00:00:00', 'global_start_time offsets record TC');
  // event[1] — sequential record position
  assert.equal(evs[1].srcIn, '00:00:10:00');
  assert.equal(evs[1].recIn, '01:00:04:00', 'record advances by previous clip duration');
});

test('resolve_retime.otio — LinearTimeWarp 2x + reverse', () => {
  const res = parseOTIO(readFixture('resolve_retime.otio'));
  const evs = assertParseResult(res, { sourceType: 'otio' });

  assert.equal(evs.length, 2);
  // 2x speed → source range scaled to 2× timeline duration; speedFactor 200%
  assert.equal(evs[0].speedFactor, 200, '2x → speedFactor 200');
  assert.equal(evs[0].srcOut, '00:00:04:00', '2x consumes 96 source frames for a 48-frame edit');
  // reverse encoded as negative speedFactor
  assert.equal(evs[1].speedFactor, -100, 'reverse → negative speedFactor');
});

test('resolve_compound.otio — nested Stack handled as one event', () => {
  const res = parseOTIO(readFixture('resolve_compound.otio'));
  const evs = assertParseResult(res, { sourceType: 'otio' });

  assert.equal(evs.length, 2, 'compound clip collapses to a single event (no crash, no flatten)');
  assert.equal(evs[1].clipName, 'COMPOUND_CLIP');
  assert.equal(evs[1].srcOut, '00:00:03:00', '72-frame compound duration');
});
