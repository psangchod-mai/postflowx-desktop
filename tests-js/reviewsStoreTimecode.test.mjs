// Reviews store timecode pair. Run: node tests-js/reviewsStoreTimecode.test.mjs
//
// srcTC is the source timecode stamped onto every review marker — the string a
// VFX vendor reads to find the frame. At any fractional rate it was being built
// from a frame count scaled by the playback rate, then formatted by dividing by
// that same rate, which left a fractional frame field in a user-visible string.
import { tcToFrames, framesToTc } from '../src/scripts/features/reviews/store.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(Object.is(got, want), `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

const RATES = [24, 23.976, 25, 29.97, 30, 50, 59.94];

// --- tcToFrames: whole-frame base, never the fractional rate ---------------
eq(tcToFrames('01:00:00:00', 24), 86400, '1h @24 → 86400');
eq(tcToFrames('01:00:00:00', 23.976), 86400, '1h @23.976 → 86400 (was 86313.59999999999)');
eq(tcToFrames('01:00:00:00', 29.97), 108000, '1h @29.97 NDF → 108000 (was 107892)');
eq(tcToFrames('01:00:00:00', 59.94), 216000, '1h @59.94 → 216000 (was 215784)');
eq(tcToFrames('00:00:05:00', 23.976), 120, '5s @23.976 → 120, not 119.88');

for (const fps of RATES) {
  ok(Number.isInteger(tcToFrames('01:02:03:04', fps)), `@${fps} parse yields an integer frame count`);
}

// --- tcToFrames: the 0 sentinel is this file's own convention, kept --------
// Unlike modules/eventDuration.js, nothing here distinguishes "unreadable" from
// "frame zero" — both callers pass a startTC that defaults to '00:00:00:00'.
for (const bad of [undefined, null, '', 'garbage', '1:00:00:00', '01:00:00', '01:00:00;00']) {
  eq(tcToFrames(bad, 24), 0, `${JSON.stringify(bad)} → 0 (strict two-digit colon form only)`);
}

// --- framesToTc: a frame field is a whole number ---------------------------
// pad2 does not round, so a fractional ff was stringified whole into the label.
for (const fps of RATES) {
  const tc = framesToTc(86553, fps);
  ok(/^\d{2}:\d{2}:\d{2}:\d{2}$/.test(tc), `@${fps} framesToTc emits HH:MM:SS:FF, got "${tc}"`);
}
eq(framesToTc(86400, 23.976), '01:00:00:00', '86400 @23.976 → 01:00:00:00');
eq(framesToTc(108000, 29.97), '01:00:00:00', '108000 @29.97 → 01:00:00:00');
eq(framesToTc(0, 23.976), '00:00:00:00', 'frame 0 formats clean');
eq(framesToTc(-5, 24), '00:00:00:00', 'negative frames clamp to zero');

// --- the pair round-trips ---------------------------------------------------
for (const fps of RATES) {
  for (const tc of ['00:00:00:00', '01:00:00:00', '10:20:30:15', '23:59:59:00']) {
    eq(framesToTc(tcToFrames(tc, fps), fps), tc, `@${fps} round-trip ${tc}`);
  }
}

// --- the actual marker computation (store.js:413, :1315, :1400) ------------
// startTC parsed to frames, plus elapsed media seconds at the REAL rate,
// formatted back. The two addends must land in the same frame space.
const segStartTC = (startTC, inSec, fps) => {
  const baseFrames = tcToFrames(startTC || '00:00:00:00', fps);
  const offFrames = Math.round(Math.max(0, Number(inSec) || 0) * fps);
  return framesToTc(baseFrames + offFrames, fps);
};

eq(segStartTC('01:00:00:00', 10, 24), '01:00:10:00', 'marker srcTC +10s @24');
eq(segStartTC('01:00:00:00', 10, 23.976), '01:00:10:00',
   'marker srcTC +10s @23.976 (was "01:00:09:23.616000000003282")');
eq(segStartTC('01:00:00:00', 10, 29.97), '01:00:10:00',
   'marker srcTC +10s @29.97 (was "01:00:10:0.3000000000041041")');
eq(segStartTC('01:00:00:00', 0, 23.976), '01:00:00:00', 'zero offset returns the clip start unchanged');

for (const fps of RATES) {
  for (const inSec of [0, 0.5, 1, 7.25, 60, 3599.5]) {
    const tc = segStartTC('01:00:00:00', inSec, fps);
    ok(/^\d{2}:\d{2}:\d{2}:\d{2}$/.test(tc), `@${fps} +${inSec}s → well-formed "${tc}"`);
  }
}

// A marker's frame field must be addressable — below the whole-frame base.
for (const fps of RATES) {
  const base = Math.round(fps);
  const ff = Number(segStartTC('01:00:00:00', 7.25, fps).split(':')[3]);
  ok(Number.isInteger(ff) && ff >= 0 && ff < base, `@${fps} frame field ${ff} is in [0,${base})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
