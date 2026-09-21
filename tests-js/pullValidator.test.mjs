// Pre-export validation tests. Run: node tests-js/pullValidator.test.mjs
import { validatePullList, ISSUE } from '../src/scripts/modules/pullValidator.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
const has = (r, code) => r.issues.some(x => x.code === code);
const issue = (r, code) => r.issues.find(x => x.code === code);

// Clean list → no issues, ok
{
  const events = [
    { reel: 'A001', srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 },
    { reel: 'A002', srcIn: '01:00:10:00', srcOut: '01:00:12:00', fps: 24 },
  ];
  const r = validatePullList(events);
  ok(r.ok && !r.hasIssues, 'clean list → ok, no issues');
  ok(r.counts.total === 2, 'counts total events');
}

// Zero / negative duration → ERROR, ok=false
{
  const r = validatePullList([{ reel: 'A001', srcIn: '01:00:04:00', srcOut: '01:00:04:00', fps: 24 }]);
  ok(has(r, 'ZERO_DURATION'), 'zero-duration flagged');
  ok(issue(r, 'ZERO_DURATION').severity === ISSUE.ERROR, 'zero-duration is an ERROR');
  ok(r.ok === false, 'ERROR makes ok=false (block export)');
}

// Unmatched OCF (via matchResults) → WARNING
{
  const events = [
    { reel: 'A001', srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 },
    { reel: 'A002', srcIn: '01:00:10:00', srcOut: '01:00:12:00', fps: 24 },
  ];
  const matchResults = [{ status: 'SAFE', confidence: 95 }, { status: 'MISSING', confidence: 0 }];
  const r = validatePullList(events, { matchResults });
  ok(has(r, 'UNMATCHED_OCF') && issue(r, 'UNMATCHED_OCF').count === 1, '1 unmatched OCF flagged');
  ok(r.ok === true, 'unmatched is a WARNING, not blocking');
}

// Missing source TC
{
  const r = validatePullList([{ reel: 'A001', srcIn: '00:00:00:00', srcOut: '00:00:00:00', fps: 24 }]);
  ok(has(r, 'MISSING_TC'), 'missing TC flagged');
}

// Reel name too long (Avid 32-char limit)
{
  const longReel = 'A001_VERY_LONG_REEL_NAME_THAT_EXCEEDS_THIRTYTWO_CHARS';
  const r = validatePullList([{ reel: longReel, srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 }]);
  ok(has(r, 'REEL_TOO_LONG'), 'over-long reel flagged');
}

// Drop-frame TC on a 24p (non-DF) project
{
  const r = validatePullList([{ reel: 'A001', srcIn: '01:00:00;00', srcOut: '01:00:04;00', fps: 24, _edlFcm: 'NON-DROP' }]);
  ok(has(r, 'DF_MISMATCH'), 'drop-frame TC on non-DF project flagged');
}
// 29.97 DF project with DF TC → NOT flagged (legitimate)
{
  const r = validatePullList([{ reel: 'A001', srcIn: '01:00:00;00', srcOut: '01:00:04;00', fps: 29.97 }]);
  ok(!has(r, 'DF_MISMATCH'), '29.97 DF project with DF TC is legitimate (not flagged)');
}

// Mixed frame rates → INFO (non-blocking awareness)
{
  const events = [
    { reel: 'A001', srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 },
    { reel: 'B001', srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 30 },
  ];
  const r = validatePullList(events);
  ok(has(r, 'MIXED_FPS'), 'mixed 24/30 fps flagged');
  ok(issue(r, 'MIXED_FPS').severity === ISSUE.INFO && r.ok, 'mixed fps is INFO, non-blocking');
}
// Single frame rate → not flagged
{
  const r = validatePullList([
    { reel: 'A001', srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 },
    { reel: 'B001', srcIn: '01:00:00:00', srcOut: '01:00:04:00', fps: 24 },
  ]);
  ok(!has(r, 'MIXED_FPS'), 'uniform fps not flagged');
}

// disabled events are skipped
{
  const r = validatePullList([{ reel: 'A001', srcIn: '01:00:04:00', srcOut: '01:00:04:00', fps: 24, disabled: true }]);
  ok(!r.hasIssues && r.counts.total === 0, 'disabled events are skipped');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
