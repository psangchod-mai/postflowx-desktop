// Event duration fallback chain. Run: node tests-js/eventDuration.test.mjs
import { parseTimecodeFrames, durationFramesFor, measuredDurationFrames } from '../src/scripts/modules/eventDuration.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(Object.is(got, want), `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// --- parseTimecodeFrames: whole-frame base, not the fractional rate ---------
eq(parseTimecodeFrames('00:00:05:00', 24), 120, '5s @24 → 120');
eq(parseTimecodeFrames('00:00:05:00', 23.976), 120, '5s @23.976 → 120, not 119.88');
eq(parseTimecodeFrames('00:00:05:00', 29.97), 150, '5s @29.97 NDF → 150, not 149.85');
eq(parseTimecodeFrames('00:00:05:00', 59.94), 300, '5s @59.94 → 300');
eq(parseTimecodeFrames('01:00:00:00', 23.976), 86400, '1h @23.976 → 86400 (integer)');
ok(Number.isInteger(parseTimecodeFrames('01:02:03:04', 23.976)), '23.976 result is an integer');

// --- parseTimecodeFrames: NaN, never 0, for anything unreadable ------------
// The whole point of the extraction. Each of these returned 0 from ui.js's
// private parser, and 0 is Number.isFinite — so every caller's validity check
// said yes.
for (const bad of [undefined, null, '', '   ', 'garbage', '01:00:00', '01:00',
                   '1:2', 'aa:bb:cc:dd', '00:00:05:', ':00:05:00', 86400, {}, []]) {
  ok(Number.isNaN(parseTimecodeFrames(bad, 24)), `${JSON.stringify(bad)} → NaN (not 0)`);
}

// --- parseTimecodeFrames: shapes that occur in real files ------------------
eq(parseTimecodeFrames('00:00:05;00', 29.97), 150, 'drop-frame ";" reads as a timecode');
eq(parseTimecodeFrames('00;00;05;00', 29.97), 150, 'all-semicolon DF reads as a timecode');
eq(parseTimecodeFrames('00:00:05:12.5', 24), 132, 'Resolve subframe suffix tolerated');
eq(parseTimecodeFrames('  01:00:00:00  ', 24), 86400, 'surrounding whitespace trimmed');
eq(parseTimecodeFrames('001:00:00:00', 24), 86400, 'three-digit hours (long-form reel TC)');

// --- durationFramesFor: explicit count wins --------------------------------
eq(durationFramesFor({ durationFrames: 96, srcIn: '01:00:00:00', srcOut: '01:00:99:99' }, 24), 96,
   'explicit durationFrames preferred over source span');
eq(durationFramesFor({ durationFrames: 95.6 }, 24), 96, 'fractional durationFrames rounded');
eq(durationFramesFor({ durationFrames: -5 }, 24), 0, 'negative durationFrames clamped to 0');

// --- durationFramesFor: source span ----------------------------------------
eq(durationFramesFor({ srcIn: '01:00:00:00', srcOut: '01:00:04:00' }, 24), 96, 'src span @24 → 96');
eq(durationFramesFor({ srcIn: '01:00:00:00', srcOut: '01:00:04:00' }, 23.976), 96,
   'src span @23.976 → 96 whole frames, not 95.904');

// --- durationFramesFor: the fallback that never ran ------------------------
// Every case below reported 0 before the extraction: the source branch's guard
// reduced to 0 >= 0, so the record branch underneath was unreachable.
eq(durationFramesFor({ srcIn: '', srcOut: '', recIn: '00:00:00:00', recOut: '00:00:04:00' }, 24), 96,
   'empty src TC → falls through to rec span (was 0)');
eq(durationFramesFor({ recIn: '00:00:00:00', recOut: '00:00:04:00' }, 24), 96,
   'src fields absent entirely → rec span (was 0)');
eq(durationFramesFor({ srcIn: 'n/a', srcOut: 'n/a', recIn: '00:00:00:00', recOut: '00:00:02:12' }, 24), 60,
   'malformed src TC → rec span (was 0)');
eq(durationFramesFor({ srcIn: '01:00:00', srcOut: '01:00:04', recIn: '00:00:00:00', recOut: '00:00:04:00' }, 24), 96,
   'three-part src TC → rec span (was 0)');
eq(durationFramesFor({ srcIn: '01:00:00;00', srcOut: '01:00:04;00', recIn: '00:00:00:00', recOut: '00:00:10:00' }, 29.97), 120,
   'drop-frame src TC now parses, so it wins over rec (was 0)');

// --- durationFramesFor: reversed spans skip to the next source -------------
eq(durationFramesFor({ srcIn: '01:00:04:00', srcOut: '01:00:00:00', recIn: '00:00:00:00', recOut: '00:00:04:00' }, 24), 96,
   'srcOut before srcIn → rec span');
eq(durationFramesFor({ srcIn: '01:00:04:00', srcOut: '01:00:00:00', recIn: '00:00:04:00', recOut: '00:00:00:00' }, 24), 0,
   'both spans reversed → 0');

// --- durationFramesFor: nothing readable → 0, never NaN --------------------
// A NaN here would poison the running record-timeline total for every event after it.
for (const ev of [null, undefined, {}, { srcIn: 'x' }, { recOut: 'y' }, { durationFrames: NaN }]) {
  const d = durationFramesFor(ev, 24);
  ok(d === 0, `${JSON.stringify(ev)} → 0 (got ${d})`);
}

// --- measuredDurationFrames: unknown and zero are different answers --------
// The Inspector prints "—" for the first and "00:00:00:00 / 0 fr" for the second.
for (const ev of [null, undefined, {}, { srcIn: 'x' }, { recOut: 'y' },
                  { srcIn: '01:00:04:00', srcOut: '01:00:00:00' }]) {
  ok(Number.isNaN(measuredDurationFrames(ev, 24)), `unreadable ${JSON.stringify(ev)} → NaN`);
}
eq(measuredDurationFrames({ durationFrames: 0 }, 24), 0, 'an explicit zero-length event → 0, not NaN');
eq(measuredDurationFrames({ srcIn: '01:00:00:00', srcOut: '01:00:00:00' }, 24), 0,
   'a genuinely empty source span → 0, not NaN');
eq(measuredDurationFrames({ srcIn: 'n/a', srcOut: 'n/a', recIn: '00:00:00:00', recOut: '00:00:02:12' }, 24), 60,
   'measured agrees with durationFramesFor when the event is readable');

// --- a whole timeline still totals correctly -------------------------------
{
  const events = [
    { srcIn: '01:00:00:00', srcOut: '01:00:04:00' },                        // 96
    { srcIn: '', srcOut: '', recIn: '00:00:04:00', recOut: '00:00:06:00' }, // 48 — was 0
    { durationFrames: 24 },                                                 // 24
  ];
  const total = events.reduce((n, e) => n + durationFramesFor(e, 23.976), 0);
  eq(total, 168, 'three-event timeline @23.976 totals 168 frames (was 120)');
  ok(Number.isInteger(total), 'total is a whole number of frames');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
