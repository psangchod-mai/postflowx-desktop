// Retime-compensated TC-Out matching — Pass 7 must compare against the
// retime-compensated out point, not the raw (timeline-duration-derived) srcOut.
// Run: node tests-js/smartOcfMatcher_retimeTcOut.test.mjs
import { matchOcfToEvent, MATCH_STATUS } from '../src/scripts/smart/smartOcfMatcher.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// 50%-speed retimed event: timeline-duration srcOut (01:00:02:00) is only half the
// native-source duration the OCF file actually covers (01:00:04:00). Pass 7's TC-Out
// bonus must use the retime-compensated out point to land in SAFE range.
//
// reel "A001" deliberately does NOT match the roll+clip camNameHit pattern (that
// would trip the `camNameHit && (tcExact || inRange) -> score = max(score, 85)`
// floor override right after Pass 7 and mask the bonus this test targets). Without
// the fix this scenario scores 75 (REVIEW_NEEDED); Pass 7's +8 bonus, applied only
// when the fix compares against the retime-compensated out point, pushes it to 83
// (SAFE).
{
  const event = { reel: 'A001', srcIn: '01:00:00:00', srcOut: '01:00:02:00', speed: 50, fps: 24 };
  const ocfFile = { reel: 'A001', tcIn: '01:00:00:00', tcOut: '01:00:04:00', name: 'clip1.mov' };

  const res = matchOcfToEvent(ocfFile, event);
  ok(res.status === MATCH_STATUS.SAFE, `retime-compensated TC-Out match yields SAFE (got ${res.status}, confidence ${res.confidence})`);
  ok(res.confidence === 83, `confidence reflects Pass 7 bonus exactly (got ${res.confidence})`);
}
