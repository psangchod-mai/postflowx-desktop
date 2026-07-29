// IMFPlayer.validatePackage() concurrent-call race (linkedom).
// Run: node tests-js/imfPlayerValidatePackageStaleRace.test.mjs
//
// validatePackage(cplId) emits a 'validation' event after a single await on
// imfEngine.validatePackage(), with no staleness guard. A rapid CPL switch
// (e.g. arrow-keying through a <select>, which fires 'change' per keystroke)
// can trigger overlapping validatePackage() calls. If the first call (for
// CPL A) resolves after the second (for CPL B), its late 'validation' event
// fires last and a listener would paint CPL A's validation result over the
// currently-selected CPL B — a real, user-visible wrong-badge bug. This test
// drives two overlapping validatePackage() calls with independently
// controlled resolution order and asserts only the live call's 'validation'
// event fires.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
globalThis.window = window;
globalThis.document = document;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const validateCalls = []; // { cplId, deferred }

window.pfxPlatform = {
  imfEngine: {
    validatePackage(packageId, cplId) {
      const d = deferred();
      validateCalls.push({ cplId, deferred: d });
      return d.promise;
    },
  },
};

const canvas = document.getElementById('c');
canvas.getContext = () => ({ clearRect() {}, drawImage() {} });

const { createIMFPlayer } = await import('../src/scripts/modules/imf/imf_player_engine.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const player = createIMFPlayer(canvas, {});
player._packageId = 'pkg1';

const validationEvents = [];
player.on('validation', (data) => validationEvents.push(data));

// User selects CPL A, kicking off validation, which suspends.
const promiseA = player.validatePackage('cplA');
ok(player._loadSeq === 1, 'validatePackage(A) bumped _loadSeq before its await');

// Before A resolves, the user arrow-keys to CPL B, re-triggering validation.
const promiseB = player.validatePackage('cplB');
ok(player._loadSeq === 2, 'validatePackage(B) bumped _loadSeq again while A was still in flight');

// Resolve A's validation late — it must be a no-op since B superseded it.
validateCalls[0].deferred.resolve({ ok: true, validation: { cplId: 'cplA', errors: [] } });
await flush();

ok(validationEvents.length === 0, 'stale validatePackage(A) must not have emitted a validation event after B superseded it');

// Now resolve B's validation — B is the live call and should emit.
validateCalls[1].deferred.resolve({ ok: true, validation: { cplId: 'cplB', errors: ['warn'] } });
await flush();

ok(validationEvents.length === 1, 'live validatePackage(B) emitted exactly one validation event once it resolved');
ok(validationEvents[0]?.validation?.cplId === 'cplB', 'the emitted validation event is for the live CPL B, not stale A');

await Promise.all([promiseA, promiseB]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
