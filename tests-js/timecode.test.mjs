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
