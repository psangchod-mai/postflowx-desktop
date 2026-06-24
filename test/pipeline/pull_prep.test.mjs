// Pipeline: parsed events → computePullRange → validatePullList.
// Run: node --test test/pipeline/pull_prep.test.mjs
import '../_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEDL } from '../../src/scripts/parsers/edl.js';
import { computePullRange } from '../../src/scripts/modules/pullRange.js';
import { validatePullList, ISSUE } from '../../src/scripts/modules/pullValidator.js';
import { tcToFrames } from '../../src/scripts/modules/utils_time.js';
import { readFixture } from '../_contract.mjs';

const HANDLES = { handleHead: 8, handleTail: 8 };

test('computePullRange — straight cut folds plain handles', () => {
  const { events } = parseEDL(readFixture('simple_24.edl'), 'simple_24.edl');
  const ev = events[0];
  const r = computePullRange(ev, HANDLES);
  assert.equal(r.srcInFrames, tcToFrames(ev.srcIn, 24), 'srcInFrames from srcIn');
  assert.equal(r.pullInFrames, r.srcInFrames - 8, 'pullIn = srcIn − handleHead (no transition)');
  assert.equal(r.pullOutFrames, r.srcOutFrames + 8, 'pullOut = srcOut + handleTail');
  assert.ok(Number.isFinite(r.pullInFrames) && r.pullOutFrames >= r.pullInFrames, 'finite, non-negative span');
  assert.match(r.pullInTc, /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/, 'pullInTc is a valid TC');
});

test('computePullRange — D025 dissolve folds transition into handles', () => {
  const { events } = parseEDL(readFixture('dissolve_df.edl'), 'dissolve_df.edl');
  const dissolve = events.find(e => e.transition === 'D025');
  assert.ok(dissolve, 'fixture has the D025 dissolve event');
  const r = computePullRange(dissolve, HANDLES);
  // handleHead/handleTail = base 8 + 25 transition frames
  assert.equal(r.handleHead, 8 + 25, 'transition adds 25 to head handle');
  assert.equal(r.handleTail, 8 + 25, 'transition adds 25 to tail handle');
  assert.equal(r.pullInFrames, r.srcInFrames - 33, 'pullIn shifts by the combined handle');
});

test('computePullRange — retime scales native source duration by 100/speedPercent', () => {
  // EDL-style representation: srcOut is the EDIT duration; SPEED gives the
  // percent. (OTIO pre-scales source range, so its srcOut is already native.)
  const ev = {
    reel: 'A050', srcIn: '01:00:00:00', srcOut: '01:00:04:00', // 96-frame edit @24
    recIn: '01:00:00:00', recOut: '01:00:04:00', fps: 24, speedFactor: 200,
  };
  const r = computePullRange(ev, HANDLES);
  const editDur = tcToFrames(ev.srcOut, 24) - tcToFrames(ev.srcIn, 24); // 96
  const nativeDur = r.srcOutFrames - r.srcInFrames;
  assert.equal(nativeDur, Math.round(editDur * (100 / 200)), '200% → half the native source (48f)');
});

test('validatePullList — clean EDL passes; counts non-disabled total', () => {
  const { events } = parseEDL(readFixture('simple_24.edl'), 'simple_24.edl');
  const res = validatePullList(events);
  assert.equal(res.ok, true, 'no ERROR-severity issues');
  assert.equal(res.counts.total, 3, 'total === non-disabled event count');
  assert.equal(res.counts.zeroDur, 0, 'no zero-duration shots');
});

test('validatePullList — DF_MISMATCH on drop-frame TC over a non-DF base', () => {
  // semicolon (drop-frame) TC on a 24fps clip → not drop-frame-capable.
  const ev = { reel: 'X001', srcIn: '01:00:00;00', srcOut: '01:00:04;00', fps: 24 };
  const res = validatePullList([ev]);
  const df = res.issues.find(x => x.code === 'DF_MISMATCH');
  assert.ok(df && df.severity === ISSUE.WARNING, 'DF_MISMATCH warning raised');
});

test('validatePullList — ZERO_DURATION is a blocking error', () => {
  const ev = { reel: 'X002', srcIn: '01:00:05:00', srcOut: '01:00:05:00', fps: 24 }; // out <= in
  const res = validatePullList([ev]);
  const zd = res.issues.find(x => x.code === 'ZERO_DURATION');
  assert.ok(zd && zd.severity === ISSUE.ERROR, 'ZERO_DURATION error raised');
  assert.equal(res.ok, false, 'ok === false when an ERROR exists');
});
