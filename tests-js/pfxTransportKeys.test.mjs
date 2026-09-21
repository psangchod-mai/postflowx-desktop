// pfxTransportKeys key→action mapping. Run: node tests-js/pfxTransportKeys.test.mjs
import { resolveKey } from '../src/scripts/core/pfxTransportKeys.js';

let passed = 0, failed = 0;
function eq(got, want, l) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { passed++; console.log('PASS -', l); }
  else { failed++; console.error(`FAIL - ${l} (got ${g}, want ${w})`); }
}

// Core transport keys.
eq(resolveKey('Space', {}), { a: 'togglePlay' }, 'Space → play/pause');
eq(resolveKey('Home', {}), { a: 'jumpStart' }, 'Home → jump start');
eq(resolveKey('End', {}), { a: 'jumpEnd' }, 'End → jump end');
eq(resolveKey('ArrowLeft', {}), { a: 'step', d: -1 }, 'Left → step back');
eq(resolveKey('ArrowRight', {}), { a: 'step', d: 1 }, 'Right → step forward');

// JKL.
eq(resolveKey('KeyK', {}), { a: 'stop' }, 'K → stop');
eq(resolveKey('KeyK', { repeat: true }), { a: 'noop' }, 'K auto-repeat → noop');
eq(resolveKey('KeyL', {}), { a: 'playForward' }, 'L → play forward');
eq(resolveKey('KeyL', { repeat: true }), { a: 'noop' }, 'L auto-repeat → noop (discrete ramp)');
eq(resolveKey('KeyJ', {}), { a: 'step', d: -1 }, 'J tap → one frame back');
eq(resolveKey('KeyJ', { repeat: true }), { a: 'reverseHold' }, 'J held (auto-repeat) → continuous reverse');

// K + J / K + L jog (kHeld).
eq(resolveKey('KeyL', { kHeld: true }), { a: 'step', d: 1 }, 'K+L → single-frame jog forward');
eq(resolveKey('KeyJ', { kHeld: true }), { a: 'step', d: -1 }, 'K+J → single-frame jog back');
eq(resolveKey('KeyJ', { kHeld: true, repeat: true }), { a: 'noop' }, 'K+J held → no continuous reverse');

// Shift + arrows = item nav; other shift combos ignored.
eq(resolveKey('ArrowLeft', { shift: true }), { a: 'prevItem' }, 'Shift+Left → previous item');
eq(resolveKey('ArrowRight', { shift: true }), { a: 'nextItem' }, 'Shift+Right → next item');
eq(resolveKey('Space', { shift: true }), null, 'Shift+Space → not ours');

// Unmapped keys.
eq(resolveKey('KeyM', {}), null, 'M → not a transport key');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
