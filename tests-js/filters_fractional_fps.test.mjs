// tests-js/filters_fractional_fps.test.mjs
//
// filters.js's tcToFrames/framesToTC used the raw event fps directly as the
// frame-counting divisor instead of rounding it to its nominal whole-frame
// base first (the convention every sibling timecode module — cutdiff.js,
// eventDuration.js, edl_export.js, utils_time.js — already follows via
// nominalBase()). AAF imports attach a raw fractional EditRate to each event
// (e.g. 24000/1001 = 23.976023976023976... for NTSC), and that value reached
// filters.js untouched.
//
// Concretely, at fps=23.976023976023976: framesToTC(30, fps) computed
// `30 % 23.976023976023976 = 6.023976023976024`, producing the malformed
// timecode "00:00:01:6.023976023976024" instead of "00:00:01:06". Any
// downstream comparison against a well-formed literal timecode for the same
// frame (e.g. mergeOverlap matching a computed recOut against the next
// clip's literal recIn) then fails to line up, because tcToFrames() can't
// parse the malformed field (its \d+ group doesn't match a decimal) and
// falls back to 0 instead of the real frame count.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onlyVfxMarker, mergeOverlap } from '../src/scripts/modules/filters.js';

const AAF_NTSC_FPS = 24000 / 1001; // 23.976023976023976...

// framesToTC() isn't exported directly; onlyVfxMarker() exercises it via a
// marker's `inFrames` offset, which is exactly the AAF/FCPXML marker path.
test('onlyVfxMarker: a fractional AAF fps still produces a well-formed 2-digit frame field', () => {
  const evs = [{
    clipName: 'A', reel: 'REEL', srcFile: '', sourceType: 'aaf',
    fps: AAF_NTSC_FPS, disabled: false,
    recIn: '00:00:00:00', recOut: '00:00:02:00',
    srcIn: '01:00:00:00', srcOut: '01:00:02:00',
    _markers: [{ name: 'VFX', color: 'Red', inFrames: 30 }],
  }];
  const out = onlyVfxMarker(evs, { color: 'All', fps: AAF_NTSC_FPS });
  assert.equal(out.length, 1);
  assert.equal(out[0].recIn, '00:00:01:06');
});

test('mergeOverlap: a framesToTC-computed boundary still matches the literal recIn at a fractional fps', () => {
  // Get the real framesToTC(30, fps) output via the same marker code path
  // exercised above, so this test uses the module's actual computed TC
  // rather than a literal string that would trivially match itself.
  const marker = onlyVfxMarker([{
    clipName: 'A', reel: 'REEL', srcFile: '', sourceType: 'aaf',
    fps: AAF_NTSC_FPS, disabled: false,
    recIn: '00:00:00:00', recOut: '00:00:02:00',
    srcIn: '01:00:00:00', srcOut: '01:00:02:00',
    _markers: [{ name: 'VFX', color: 'Red', inFrames: 30 }],
  }], { color: 'All', fps: AAF_NTSC_FPS });
  const computedTC = marker[0].recIn;

  const evs = [
    {
      clipName: 'A', reel: 'REEL', srcFile: '', sourceType: 'aaf',
      fps: AAF_NTSC_FPS, disabled: false,
      recIn: '00:00:00:00', recOut: computedTC,
      srcIn: '01:00:00:00', srcOut: computedTC,
    },
    {
      clipName: 'A', reel: 'REEL', srcFile: '', sourceType: 'aaf',
      fps: AAF_NTSC_FPS, disabled: false,
      recIn: '00:00:01:06', recOut: '00:00:02:00',
      srcIn: '00:00:01:06', srcOut: '00:00:02:00',
    },
  ];
  const merged = mergeOverlap(evs);
  assert.equal(merged.length, 1, 'a computed recOut boundary must merge with the literal same-frame recIn');
});
