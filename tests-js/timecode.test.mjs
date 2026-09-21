// Foundational timecode math — NDF + SMPTE drop-frame. Run: node tests-js/timecode.test.mjs
import {
  tcToFrames, framesToTC, timecodeToFrames, framesToTimecode, getEffectiveDropFrame, isDropFrameCapable,
} from '../src/scripts/modules/utils_time.js';

let passed = 0, failed = 0;
function eq(got, want, label) {
  if (got === want) { passed++; console.log('PASS -', label); }
  else { failed++; console.error('FAIL -', label, `(got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
}

const df2997  = { general: { frameRate: 29.97, timecodeMode: 'auto' } };      // 29.97 drop-frame
const ndf2997 = { general: { frameRate: 29.97, timecodeMode: 'non-drop' } };  // 29.97 non-drop
const df5994  = { general: { frameRate: 59.94, timecodeMode: 'auto' } };

// ── settings helpers ──
eq(getEffectiveDropFrame(df2997), true, '29.97 auto → drop-frame');
eq(getEffectiveDropFrame(ndf2997), false, '29.97 non-drop → no drop-frame');
eq(getEffectiveDropFrame({ general: { frameRate: 24 } }), false, '24p is never drop-frame');
eq(isDropFrameCapable(59.94), true, '59.94 is DF-capable');

// ── NDF round-trips (integer base) ──
eq(tcToFrames('01:00:00:00', 24), 86400, '1h @24 = 86400 frames');
eq(framesToTC(86400, 24), '01:00:00:00', '86400 @24 → 01:00:00:00');
eq(tcToFrames('00:00:10:00', 25), 250, '10s @25 = 250 frames');
eq(framesToTC(250, 25), '00:00:10:00', '250 @25 → 00:00:10:00');

// ── Bare pair at fractional rates: the whole-frame (nominal) base ──
// Absolute values, not round-trips. The fuzz suite next door proves the pair is
// invertible, which a wrong-but-self-consistent base would satisfy too — floor
// 23.976 to 23 and every round-trip still closes. Only a known frame count can
// tell 24 from 23, so these are pinned to what timecode itself says: at 23.976 a
// timecode second holds 24 frame fields, so one hour is 86400 of them.
eq(tcToFrames('01:00:00:00', 23.976), 86400, '1h @23.976 = 86400 frames (24-frame base)');
eq(tcToFrames('00:00:01:00', 23.976), 24, '1s @23.976 = 24 frames, not 23');
eq(framesToTC(86400, 23.976), '01:00:00:00', '86400 @23.976 → 01:00:00:00 (was 01:00:03:14)');
eq(framesToTC(24, 23.976), '00:00:01:00', 'frame 24 @23.976 → 00:00:01:00');
eq(tcToFrames('01:00:00:00', 29.97), 108000, '1h @29.97 NDF = 108000 frames (30-frame base)');
eq(tcToFrames('01:00:00:00', 59.94), 216000, '1h @59.94 NDF = 216000 frames (60-frame base)');
// The span that motivated this: five seconds must measure 120 frames at 23.976,
// not 119. A pull one frame short is the field-visible form of the old bug.
eq(tcToFrames('01:00:05:00', 23.976) - tcToFrames('01:00:00:00', 23.976), 120,
   '5s @23.976 spans 120 frames, not 119');
// Fractional and integer forms of the same base must be interchangeable — the
// disagreement between them is what let the bug hide behind callers that rounded.
eq(tcToFrames('01:23:45:06', 23.976), tcToFrames('01:23:45:06', 24),
   '23.976 and 24 agree frame-for-frame');
eq(tcToFrames('01:23:45:06', 29.97), tcToFrames('01:23:45:06', 30),
   '29.97 NDF and 30 agree frame-for-frame');
// The bare pair must now agree with the settings-aware wrapper it sits under,
// which reached the right answer only by rounding fps before calling down.
eq(tcToFrames('01:00:00:00', 29.97), timecodeToFrames('01:00:00:00', ndf2997),
   'bare pair agrees with timecodeToFrames on 29.97 non-drop');
// An unusable rate must not produce Infinity in a timecode field.
eq(framesToTC(48, undefined), '00:00:02:00', 'an undefined rate falls back to 24, not NaN');
eq(tcToFrames('00:00:02:00', 0), 48, 'a zero rate falls back to 24 rather than collapsing');
// framesToTC clamps at zero. Untested until a mutation sweep removed the clamp and
// every suite still passed — a negative frame count then formats as "-1:59:59:19",
// which parses back as a positive time and would read as a real handle.
eq(framesToTC(-5, 24), '00:00:00:00', 'a negative frame count clamps to 00:00:00:00');

// ── 29.97 DROP-FRAME — SMPTE-known values ──
eq(timecodeToFrames('01:00:00;00', df2997), 107892, '1h @29.97DF = 107892 frames (SMPTE)');
eq(framesToTimecode(107892, df2997), '01:00:00;00', '107892 → 01:00:00;00');
eq(timecodeToFrames('00:10:00;00', df2997), 17982, '10min @29.97DF = 17982 (no drop at 10-min mark)');
eq(framesToTimecode(17982, df2997), '00:10:00;00', '17982 → 00:10:00;00');
// The classic drop: after 00:00:59;29 the next frame is 00:01:00;02 (frames ;00,;01 skipped)
eq(timecodeToFrames('00:01:00;02', df2997), 1800, '00:01:00;02 = frame 1800');
eq(framesToTimecode(1800, df2997), '00:01:00;02', 'frame 1800 → 00:01:00;02 (drop-frame skips ;00/;01)');
eq(framesToTimecode(1799, df2997), '00:00:59;29', 'frame 1799 → 00:00:59;29 (last before the drop)');
// Minute 10 (multiple of 10) does NOT drop
eq(framesToTimecode(17981, df2997), '00:09:59;29', 'frame 17981 → 00:09:59;29');

// ── 59.94 DROP-FRAME ──
eq(timecodeToFrames('01:00:00;00', df5994), 215784, '1h @59.94DF = 215784 frames (SMPTE)');
eq(framesToTimecode(215784, df5994), '01:00:00;00', '215784 → 01:00:00;00');

// ── DF round-trip sweep: every framesToTimecode→timecodeToFrames must be identity ──
{
  let bad = 0;
  for (const n of [0, 1, 1797, 1798, 1799, 1800, 1801, 3600, 17982, 53946, 107891, 107892, 200000]) {
    const rt = timecodeToFrames(framesToTimecode(n, df2997), df2997);
    if (rt !== n) { bad++; console.error(`   DF round-trip ${n} → ${framesToTimecode(n, df2997)} → ${rt}`); }
  }
  eq(bad, 0, '29.97DF round-trip identity across boundary frames');
}
// NDF (29.97 non-drop) round-trip — uses integer base 30
{
  let bad = 0;
  for (const n of [0, 1799, 1800, 17982, 107892]) {
    const rt = timecodeToFrames(framesToTimecode(n, ndf2997), ndf2997);
    if (rt !== n) bad++;
  }
  eq(bad, 0, '29.97 non-drop round-trip identity');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
