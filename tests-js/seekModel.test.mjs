// Frame-accurate seek/step parity model (C2). Run: node tests-js/seekModel.test.mjs
// seekModel is CommonJS (used by electron/native engines); imported via interop.
import seekModel from '../electron/native/seekModel.js';
const { tcToFrame, frameToSeconds, secondsToFrame, normalizeToFrame, toEngineSeek, stepFrame, planStill } = seekModel;

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
function near(got, want, eps, l) { ok(Math.abs(got - want) < eps, `${l} (got ${got}, want≈${want})`); }

// ── tcToFrame (nominal-rate, 23.976 → base 24) ──
eq(tcToFrame('00:00:01:00', 24), 24, '1s @24 = 24f');
eq(tcToFrame('01:00:00:00', 24), 86400, '1h @24');
eq(tcToFrame('00:00:01:00', 23.976), 24, '23.976 uses nominal 24 base');
eq(tcToFrame('00:00:00:12', 24), 12, 'frames component');
eq(tcToFrame('bad', 24), 0, 'unparseable → 0');

// ── frameToSeconds = mid-frame (frame+0.5)/fps ──
near(frameToSeconds(0, 24), 0.5 / 24, 1e-9, 'frame 0 → mid of frame 0');
near(frameToSeconds(48, 24), 48.5 / 24, 1e-9, 'frame 48 @24');
// round-trip: the seconds for frame N must land back on frame N
for (const fps of [24, 23.976, 25, 29.97, 30, 59.94]) {
  let bad = 0;
  for (const n of [0, 1, 23, 24, 100, 1001, 86399]) {
    if (secondsToFrame(frameToSeconds(n, fps), fps) !== n) bad++;
  }
  eq(bad, 0, `mid-frame round-trips for all sample frames @${fps}`);
}

// ── normalizeToFrame: frame > timecode > seconds ──
eq(normalizeToFrame({ frame: 42 }, 24), 42, 'explicit frame wins');
eq(normalizeToFrame({ timecode: '00:00:02:00' }, 24), 48, 'timecode → frame');
eq(normalizeToFrame({ timecode: '01:00:02:00' }, 24, '01:00:00:00'), 48, 'timecode RELATIVE to startTc');
eq(normalizeToFrame({ seconds: 2 }, 24), 48, 'seconds → frame');
eq(normalizeToFrame({}, 24), 0, 'empty → 0');
eq(normalizeToFrame({ frame: -5 }, 24), 0, 'negative frame clamped');

// ── toEngineSeek: mpv=seconds(mid-frame), avf=frame ──
const mpv = toEngineSeek(48, 24, 'mpv');
eq(mpv.kind, 'seconds', 'mpv seek is seconds-based');
near(mpv.seconds, 48.5 / 24, 1e-9, 'mpv seconds = mid-frame');
eq(mpv.command[0], 'seek', 'mpv command verb');
eq(mpv.command[2], 'absolute', 'mpv absolute seek');
ok(secondsToFrame(mpv.seconds, 24) === 48, 'mpv seconds lands on frame 48 (frame-accurate)');
const avf = toEngineSeek(48, 24, 'avf');
eq(avf.kind, 'frame', 'avf seek is frame-native');
eq(avf.frame, 48, 'avf frame passthrough');
eq(toEngineSeek(7, 24, 'native').frame, 7, 'native engine → frame');

// ── stepFrame ──
eq(stepFrame(10, 1), 11, 'step +1');
eq(stepFrame(10, -1), 9, 'step -1');
eq(stepFrame(0, -1), 0, 'step below 0 clamped');
eq(stepFrame(100, -250), 0, 'large back-step clamped to 0');

// ── planStill: thumbnail parity (avf=frame-native, mpv→ffmpeg mid-frame) ──
const avfStill = planStill({ engine: 'avf', frame: 48 }, 24);
eq(avfStill.extractor, 'avf', 'avf engine → avf extractor');
eq(avfStill.frame, 48, 'avf still frame');
ok(avfStill.seconds === undefined, 'avf still has no seconds (frame-native)');
const mpvStill = planStill({ engine: 'mpv', frame: 48 }, 24);
eq(mpvStill.extractor, 'ffmpeg', 'mpv engine → ffmpeg fallback (no native still)');
near(mpvStill.seconds, 48.5 / 24, 1e-9, 'mpv still seeks mid-frame time');
ok(secondsToFrame(mpvStill.seconds, 24) === 48, 'mpv still time lands on the same frame the seek would');
eq(planStill({ engine: 'mpv', timecode: '01:00:02:00' }, 24, '01:00:00:00').frame, 48, 'planStill normalizes TC relative to startTc');
eq(planStill({ frame: 9 }, 24).extractor, 'ffmpeg', 'unknown engine → ffmpeg fallback');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
