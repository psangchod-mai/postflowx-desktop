// tcToFrames must accept drop-frame "HH:MM:SS;FF" timecodes, not just NDF
// "HH:MM:SS:FF" — a DF EDL (edl.js) leaves the ';' separator in srcIn/srcOut/
// recIn/recOut, and cutdiff.js's own tcToFrames split only on ':', so a DF
// field like "01:00:00;15" produced 3 parts instead of 4 and silently
// returned 0 for every in/out point on that clip. Run:
// node tests-js/cutdiff_dropframe_tc.test.mjs
import { tcToFrames, computeCutDiff, DIFF_TYPES } from '../src/scripts/modules/cutdiff.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// Drop-frame separator must parse the same as its colon-separated equivalent.
{
  const df  = tcToFrames('01:00:00;15', 30);
  const ndf = tcToFrames('01:00:00:15', 30);
  ok(df === ndf && df === 108015, 'DF ";FF" parses identically to NDF ":FF"');
}

{
  const partial = tcToFrames('00:01:02;03', 24);
  ok(partial === (0 * 3600 + 1 * 60 + 2) * 24 + 3, 'DF separator on a non-hour field parses correctly');
}

{
  ok(tcToFrames('', 24) === 0, 'empty timecode still returns 0');
  ok(tcToFrames('garbage', 24) === 0, 'malformed timecode still returns 0');
}

// End-to-end: a DF-timecoded EDL must still classify as EXTENDED, not fall
// back to duration 0 for both sides and be misread as UNCHANGED.
{
  const ev = (clip, reel, srcIn, srcOut) => ({ clipName: clip, reel, srcIn, srcOut, fps: 30 });
  const d = computeCutDiff(
    [ev('A', 'R1', '01:00:00;00', '01:00:04;00')],   // 120f
    [ev('A', 'R1', '01:00:00;00', '01:00:06;00')],   // 180f (+60)
  );
  const type = d.find(x => x.clipName === 'A')?.diffType;
  ok(type === DIFF_TYPES.EXTENDED, 'DF-timecoded clip diffs as EXTENDED, not UNCHANGED');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
