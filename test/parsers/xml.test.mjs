// XMEML (Final Cut Pro 7 / Premiere .xml) parser — contract + golden.
// Run: node --test test/parsers/xml.test.mjs
//
// This parser had five call sites and no test file at all. It is also where the
// two-rate contract came from: alone among the parsers in this directory it used
// to report the TRUE playback rate as `fps`, so an NTSC sequence handed 23.976 to
// consumers that were doing timecode arithmetic. See the NTSC block below.
import '../_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseXMEML } from '../../src/scripts/parsers/xml.js';
import { tcToFrames } from '../../src/scripts/modules/utils_time.js';
import { assertParseResult, readFixture } from '../_contract.mjs';

test('xmeml_basic.xml — 2 clips, 25fps', () => {
  const res = parseXMEML(readFixture('xmeml_basic.xml'));
  const evs = assertParseResult(res, { sourceType: 'xml' });

  assert.equal(evs.length, 2, 'exactly 2 events');
  assert.equal(res.fps, 25, 'timebase 25, ntsc FALSE → 25');
  assert.equal(res.fpsExact, 25, 'no pulldown, so the two rates are the same number');
  assert.equal(res.projectName, 'XMEML BASIC');
  assert.equal(res.isNtsc, false);
  assert.equal(res.displayFormat, 'NDF');

  assert.equal(evs[0].clipName, 'shot_010');
  assert.equal(evs[0].reel, 'A001C001', 'file name stem → reel');
  assert.equal(evs[0].srcFile, 'A001C001.mov');
  // Source TC is the media's own start timecode plus the clipitem's <in> offset.
  assert.equal(evs[0].srcIn, '01:00:00:00', 'media starts 01:00:00:00, in 0');
  assert.equal(evs[0].srcOut, '01:00:04:00', '100 frames = 4s at 25');
  assert.equal(evs[1].srcIn, '01:00:10:00', 'same media start, in 250 = +10s');
  assert.equal(evs[1].srcOut, '01:00:14:00');
  // Record TC is the sequence start plus the clipitem's <start> offset.
  assert.equal(evs[0].recIn, '01:00:00:00', 'sequence tc frame 90000 = 01:00:00:00');
  assert.equal(evs[1].recIn, '01:00:04:00', 'clips are butt-joined on the timeline');
  assert.equal(evs[1].recOut, '01:00:08:00');
});

// ── The two-rate contract ───────────────────────────────────────────────────
// An NTSC XMEML states both rates: <timebase>24</timebase> is the whole-frame
// timecode base, and <ntsc>TRUE</ntsc> means the media actually plays at
// 24 * 1000/1001. This parser used to collapse them, returning the playback rate
// as `fps` — and the two consumers of that number wanted opposite things:
//
//   trlconf fed it to tcToFrames, so 01:00:00:00 conformed to 86313.686 frames
//     instead of 86400. A fractional frame count on a whole conform.
//   prep_mark fed it to the FrameClock, which needs the true rational rate —
//     and got it right ONLY here, because only here was `fps` the true rate.
//     Every other source reported the nominal base, matched no NTSC entry in
//     _pmFpsToRational, and ran the clock at 24/1: 0.1% fast, 3.6s of A/V drift
//     per hour.
//
// One number could not satisfy both. That is why `fpsExact` exists rather than
// xml.js simply being changed to match its siblings.
test('xmeml_ntsc.xml — reports the timecode base and the playback rate separately', () => {
  const res = parseXMEML(readFixture('xmeml_ntsc.xml'));
  const evs = assertParseResult(res, { sourceType: 'xml' });

  assert.equal(evs.length, 2);
  assert.equal(res.fps, 24, 'timebase 24 is the whole-frame base (was 23.976023976…)');
  assert.ok(Number.isInteger(res.fps), 'a timecode base is a count of frame fields, never fractional');
  assert.ok(Math.abs(res.fpsExact - 24000 / 1001) < 1e-9,
    `fpsExact is the true playback rate — got ${res.fpsExact}`);
  assert.notEqual(res.fps, res.fpsExact, 'on NTSC the two rates genuinely differ');
  assert.equal(res.isNtsc, true);
  assert.equal(res.timecodeBase, res.fps, 'timecodeBase is retained as an alias of fps');

  assert.equal(evs[0].recIn, '01:00:00:00', 'sequence tc frame 86400 = 01:00:00:00 at base 24');
  assert.equal(evs[0].recOut, '01:00:04:00', '96 frames = 4 timecode seconds');
  assert.equal(evs[1].recIn, '01:00:04:00');
  assert.equal(evs[1].srcIn, '01:00:10:00', 'media start + in 240 = +10 timecode seconds');
  assert.equal(evs[0].fps, res.fps, 'events are stamped with the same base the header reports');
});

test('a downstream conform reaches whole frames on an NTSC sequence', () => {
  // The regression this contract exists to prevent, in the shape trlconf hits it:
  // take the reported rate straight to tcToFrames. With the playback rate that
  // returned 86313.68631368632 for the hour mark — 86.3 frames short, and
  // fractional, so every conform built on it was wrong twice over.
  const res = parseXMEML(readFixture('xmeml_ntsc.xml'));
  const frames = tcToFrames(res.events[0].recIn, res.fps);
  assert.equal(frames, 86400, '01:00:00:00 at base 24 (was 86313.68631368632)');
  assert.ok(Number.isInteger(frames), 'and it is a whole frame count');

  // The other half: real-time math must use fpsExact, or it is 0.1% off.
  const seconds = tcToFrames(res.events[0].recIn, res.fps) / res.fpsExact;
  assert.ok(Math.abs(seconds - 3603.6) < 0.01,
    `an hour of NTSC timecode is 3603.6 real seconds — got ${seconds}`);
});

test('every broadcast rate splits into a whole base and an exact rate', () => {
  const build = (timebase, ntsc) => `<?xml version="1.0"?><xmeml version="5"><sequence>
    <name>R</name><rate><timebase>${timebase}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>
    <timecode><rate><timebase>${timebase}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>
      <frame>${3600 * timebase}</frame><displayformat>NDF</displayformat></timecode>
    <media><video><track><clipitem><name>c1</name>
      <start>0</start><end>${timebase}</end><in>0</in><out>${timebase}</out>
      <rate><timebase>${timebase}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>
      <file><name>A001C001.mov</name><pathurl>file:///a.mov</pathurl>
        <timecode><frame>${3600 * timebase}</frame>
          <rate><timebase>${timebase}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>
        </timecode></file>
    </clipitem></track></video></media></sequence></xmeml>`;

  for (const [timebase, ntsc, label] of [[24, false, '24'], [24, true, '23.976'], [25, false, '25'],
                                         [30, true, '29.97'], [30, false, '30'], [60, true, '59.94']]) {
    const res = parseXMEML(build(timebase, ntsc));
    const expectExact = ntsc ? timebase * 1000 / 1001 : timebase;
    assert.equal(res.fps, timebase, `@${label} base is the timebase`);
    assert.ok(Number.isInteger(res.fps), `@${label} base stays whole`);
    assert.ok(Math.abs(res.fpsExact - expectExact) < 1e-9, `@${label} fpsExact = ${expectExact}`);
    assert.equal(Math.round(res.fpsExact), res.fps, `@${label} the two agree to the nearest frame`);
    assert.equal(res.events[0]?.recIn, '01:00:00:00', `@${label} one hour of timecode is one hour`);
    assert.equal(tcToFrames(res.events[0].recIn, res.fps), 3600 * timebase,
      `@${label} and a downstream conform gets a whole frame count`);
  }
});

test('an unparseable document returns the contract shape, not a throw', () => {
  const res = parseXMEML('not xml at all');
  assert.ok(Array.isArray(res.events) && res.events.length === 0, 'no events');
  assert.equal(res.fps, 24, 'fallback base');
  assert.equal(res.fpsExact, 24, 'fallback rate — both halves present even on the error path');
});
