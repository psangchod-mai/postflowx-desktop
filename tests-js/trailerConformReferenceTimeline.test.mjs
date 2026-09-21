import test from 'node:test';
import assert from 'node:assert/strict';

import { referenceBaseFrames } from '../src/scripts/modules/conform/referenceTimeline.js';

function tcToFrames(tc, fps = 24) {
  const [hh, mm, ss, ff] = String(tc).split(':').map(Number);
  return ((hh * 3600 + mm * 60 + ss) * fps) + ff;
}

test('XMEML relative record frames map sequence start to reference second zero', () => {
  const events = [{
    recIn: '00:59:56:00',
    _recInFrames: 0,
    _seqBaseFrames: 86304,
  }];
  assert.equal(referenceBaseFrames(events, 24, tcToFrames), 0);
  assert.equal((events[0]._recInFrames - referenceBaseFrames(events, 24, tcToFrames)) / 24, 0);
});

test('absolute parser frames retain their declared sequence base', () => {
  const events = [{
    recIn: '01:00:00:00',
    _recInFrames: 86400,
    _seqBaseFrames: 86400,
  }];
  assert.equal(referenceBaseFrames(events, 24, tcToFrames), 86400);
});

test('events without private frame fields use the declared or earliest absolute TC', () => {
  assert.equal(referenceBaseFrames([
    { recIn: '01:00:00:00', _seqBaseFrames: 86400 },
  ], 24, tcToFrames), 86400);

  assert.equal(referenceBaseFrames([
    { recIn: '01:00:05:00' },
    { recIn: '01:00:10:00' },
  ], 24, tcToFrames), 86520);
});
