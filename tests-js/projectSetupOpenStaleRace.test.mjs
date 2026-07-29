// project_setup.js openProjectSetup() stale-race (linkedom).
// Run: node tests-js/projectSetupOpenStaleRace.test.mjs
//
// openProjectSetup() unconditionally awaits _pssLoad() (an IndexedDB round
// trip) then unconditionally tears down any existing #pfxSetupOverlay and
// builds a fresh one from the just-loaded _pssSettings. The panel's own
// toggle button only flips _pssOpen = true at the very end of the function,
// so two rapid clicks (or a click racing the settings-changed reopen in
// _pssOnProjectChanged) can both start an open before either finishes. If
// the OLDER call's storage round trip happens to resolve LAST, it clobbers
// the newer call's already-open, already-wired panel with one built from
// stale settings data — a real, user-visible "my last click's settings
// vanished" bug.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = document;
globalThis.requestAnimationFrame = (fn) => { fn(); return 0; };
globalThis.cancelAnimationFrame = () => {};

// Fake IndexedDB: the real db object is cached after the first open() (which
// happens during this module's own background boot load), so races between
// concurrent openProjectSetup() calls play out in the per-call get() step,
// not in open(). Each get() is left pending until the test explicitly
// resolves it, so resolution order is fully test-controlled.
const gets = [];
function makeReq() {
  const req = {};
  return req;
}
const fakeDb = {
  transaction() {
    return {
      objectStore() {
        return {
          get(key) {
            const req = makeReq();
            gets.push({
              key,
              resolve(v) { req.result = v; req.onsuccess?.({ target: req }); },
            });
            return req;
          },
        };
      },
    };
  },
};
globalThis.indexedDB = {
  open() {
    const req = makeReq();
    queueMicrotask(() => { req.result = fakeDb; req.onsuccess?.({ target: req }); });
    return req;
  },
};

await import('../src/scripts/modules/project_setup.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const api = window.__pfxProjectSetup;

// Let the module's own background boot loads (initProjectSetup() and
// autoConnectResolveOnBoot()'s own conditional _pssLoad() both fire at
// import time) consume their get() slots; leave them pending, irrelevant here.
await flush();
const bootGets = gets.length;
ok(bootGets > 0, 'boot fired at least one IndexedDB get');

// Call A (older, e.g. a first click) starts and suspends on its storage read.
const openA = api.open('general');
await flush();
// Call B (newer, e.g. a fast second click before A's toggle flipped _pssOpen)
// starts before A has resolved.
const openB = api.open('general');
await flush();
ok(gets.length === bootGets + 2, 'each overlapping open issued its own independent storage read');
const [getA, getB] = gets.slice(bootGets);

// B's storage read resolves first — the live, user-intended state.
getB.resolve({ naming: { show: 'B_SHOW' } });
await flush();
await openB;

ok(document.querySelectorAll('#pfxSetupOverlay').length === 1, 'exactly one panel is mounted after B opens');
ok(api.getSettings()?.naming?.show === 'B_SHOW', 'panel reflects B (the newer, still-open call) settings');

// A's storage read resolves late — superseded by B before A ever touched the DOM.
getA.resolve({ naming: { show: 'A_SHOW' } });
await flush();
await openA;

ok(document.querySelectorAll('#pfxSetupOverlay').length === 1,
  'still exactly one panel after the stale call resolves — it must not append a second one');
ok(api.getSettings()?.naming?.show === 'B_SHOW',
  'the stale, superseded open must not clobber the live panel\'s settings with older data');
ok(api.isOpen() === true, 'panel remains open after the stale call resolves');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
