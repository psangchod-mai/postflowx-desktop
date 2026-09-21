// pfxTransport rate-ramp ladder. Run: node tests-js/pfxTransport.test.mjs
import { nextRampRate } from '../src/scripts/core/pfxTransport.js';

let passed = 0, failed = 0;
function eq(got, want, l) {
  if (got === want) { passed++; console.log('PASS -', l); }
  else { failed++; console.error(`FAIL - ${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
}

// Forward: from stopped → 1×, then ramp 1→2→4 (cap 4).
eq(nextRampRate(0, 1), 1, 'stopped + L → 1× forward');
eq(nextRampRate(1, 1), 2, '1× + L → 2×');
eq(nextRampRate(2, 1), 4, '2× + L → 4×');
eq(nextRampRate(4, 1), 4, '4× + L → 4× (capped)');

// Reverse: from stopped → -1×, then ramp -1→-2→-4 (cap -4).
eq(nextRampRate(0, -1), -1, 'stopped + J-hold → -1× reverse');
eq(nextRampRate(-1, -1), -2, '-1× + J → -2×');
eq(nextRampRate(-2, -1), -4, '-2× + J → -4×');
eq(nextRampRate(-4, -1), -4, '-4× + J → -4× (capped)');

// Direction change resets to 1× in the requested direction.
eq(nextRampRate(2, -1), -1, 'playing 2× fwd + reverse intent → -1×');
eq(nextRampRate(-2, 1), 1, 'playing -2× rev + forward intent → 1×');

// ½× floor exists in the ladder but L-ramp never drops below 1×.
eq(nextRampRate(0.5, 1), 1, '½× + L → 1× (steps up the ladder)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
