// smartRun.js refreshActionCache()'s stale-race (linkedom).
// Run: node tests-js/smartRunActionCacheStaleRace.test.mjs
//
// refreshActionCache() is triggered from many independent, uncoordinated
// sources (proxy-job completion, cross-tab SWI BroadcastChannel, cut-diff
// reactions, safe-fix actions, boot warm-up) that can overlap. Each call
// awaits window.PFX_SWI.getAll() and then does _cache.clear() + repopulate —
// before the fix, an earlier call reading a stale SWI snapshot could resolve
// AFTER a later call reading a fresher one, clobbering the fresher cache with
// stale next-action data (e.g. showing "Build Proxy" for a shot whose proxy
// already finished rendering).

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
globalThis.window = window;
globalThis.document = document;

// Each call is left pending until the test explicitly resolves it, so
// resolution order is fully test-controlled regardless of call order.
const pendingGetAll = [];
window.PFX_SWI = {
  getProjectId: () => 'proj1',
  getAll: () => new Promise((resolve) => { pendingGetAll.push(resolve); }),
};

// The module defers _init() via setTimeout(_init, 400) when readyState isn't
// 'loading' (linkedom's default document.readyState is undefined). Run it
// immediately instead of waiting on a real timer.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms) => { fn(); return 0; };

await import('../src/scripts/core/smartRun.js');

globalThis.setTimeout = realSetTimeout;

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const { refreshActionCache, getNextActionForMarkers } = window.PFX_SMART_RUN;

// The module warm-calls refreshActionCache() on init — drain that first call
// so it doesn't interfere with the two calls under test.
await flush();
ok(pendingGetAll.length === 1, 'module warm call issued its own getAll()');
pendingGetAll.shift()({ ok: true }); // resolve with no usable array; caught internally
await flush();

// Older call: starts and suspends on its async round trip, reading a
// snapshot where the shot still needs a proxy build.
const olderCall = refreshActionCache();
await flush();
ok(pendingGetAll.length === 1, 'older call issued its own independent getAll()');

// Newer call: starts before the older call has resolved, reading a fresher
// snapshot where the proxy has since finished and is ready for QC.
const newerCall = refreshActionCache();
await flush();
ok(pendingGetAll.length === 2, 'newer call issued its own independent getAll()');

// The newer call resolves first — the live, user-intended result.
pendingGetAll[1]([{ markerId: 'mk1', enabled: true, markerType: 'VFX', ocfStatus: 'linked', proxyStatus: 'ready', proxy: { outputPath: '/proxy/mk1.mov' }, qc: { qcStatus: 'pending' } }]);
await newerCall;

ok(getNextActionForMarkers([{ id: 'mk1' }]).includes('Compare QC'),
  'cache reflects the newer, faster snapshot (proxy ready, awaiting QC)');

// The older call resolves late — superseded by the newer call before its
// continuation runs.
pendingGetAll[0]([{ markerId: 'mk1', enabled: true, markerType: 'VFX', ocfStatus: 'linked', proxyStatus: 'missing' }]);
await olderCall;

ok(getNextActionForMarkers([{ id: 'mk1' }]).includes('Compare QC'),
  'the stale, superseded older snapshot must not clobber the live cache with a stale action');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
