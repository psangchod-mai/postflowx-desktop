// Nominal frame-rate mismatch. Run: node tests-js/fpsMatch.test.mjs
import { isFpsMismatch, nominalFps } from '../src/scripts/modules/fpsMatch.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// The reported bug: 24 imported vs 23.976 project must NOT prompt.
ok(isFpsMismatch(24, 23.976) === false, '24 vs 23.976 → no mismatch (NTSC family)');
ok(isFpsMismatch(23.976, 24) === false, '23.976 vs 24 → no mismatch (symmetric)');

// Same family across the NTSC pairs.
ok(isFpsMismatch(30, 29.97) === false, '30 vs 29.97 → no mismatch');
ok(isFpsMismatch(60, 59.94) === false, '60 vs 59.94 → no mismatch');
ok(isFpsMismatch(23.976, 23.976) === false, 'identical → no mismatch');
ok(isFpsMismatch(25, 25) === false, '25 vs 25 → no mismatch');

// Genuine nominal differences DO prompt.
ok(isFpsMismatch(24, 25) === true, '24 vs 25 → mismatch');
ok(isFpsMismatch(23.976, 29.97) === true, '24-family vs 30-family → mismatch');
ok(isFpsMismatch(25, 30) === true, '25 vs 30 → mismatch');
ok(isFpsMismatch(24, 48) === true, '24 vs 48 → mismatch');

// Unknown/zero rates never prompt (don't block import on missing data).
ok(isFpsMismatch(0, 24) === false, 'unknown import fps → no prompt');
ok(isFpsMismatch(24, 0) === false, 'no project fps → no prompt');
ok(isFpsMismatch(NaN, 24) === false, 'NaN → no prompt');

// nominalFps mapping.
ok(nominalFps(23.976) === 24 && nominalFps(29.97) === 30 && nominalFps(59.94) === 60, 'NTSC → nominal integer');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
