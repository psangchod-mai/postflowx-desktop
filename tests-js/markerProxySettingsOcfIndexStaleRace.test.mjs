// markerProxySettings.js _wire()'s "+ Add OCF Folder" / "↻ Rebuild Index"
// stale-race (linkedom).
// Run: node tests-js/markerProxySettingsOcfIndexStaleRace.test.mjs
//
// Both buttons' click handlers await an async window.PFX_OCF_INDEX call and
// then write the same indexStatus.textContent / rootsList DOM (directly, and
// via the shared _refreshRootsList() helper). Neither handler guarded against
// the OTHER handler's overlapping click: before the fix, clicking "Rebuild
// Index" then quickly "Add OCF Folder" (whose scan resolves first) could have
// its indexStatus overwritten again when the slower rebuild call finally
// resolved, showing a stale count with no indication to the user.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML(
  '<!doctype html><html><body>' +
  '<button id="pfxOcfAddRootBtn"></button>' +
  '<button id="pfxOcfRebuildIndexBtn"></button>' +
  '<div id="pfxOcfRootsList"></div>' +
  '<div id="pfxOcfIndexStatus"></div>' +
  '</body></html>'
);
globalThis.window = window;
globalThis.document = document;

const lsStore = new Map();
window.localStorage = globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
};

// Fake index: each call is left pending until the test explicitly resolves
// it, so resolution order is fully test-controlled.
const pendingScan = [];
const pendingRebuild = [];
window.PFX_OCF_INDEX = {
  getRoots: () => [],
  scanNewRoot: () => new Promise((resolve) => { pendingScan.push(resolve); }),
  rebuildIndex: () => new Promise((resolve) => { pendingRebuild.push(resolve); }),
  removeRoot: () => {},
};

// The module defers _wire() via setTimeout(_wire, 300) when readyState isn't
// 'loading' (linkedom's default document.readyState is undefined). Run it
// immediately instead of waiting on a real timer.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms) => { fn(); return 0; };

await import('../src/scripts/core/markerProxySettings.js');

globalThis.setTimeout = realSetTimeout;

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const addBtn = document.getElementById('pfxOcfAddRootBtn');
const rebuildBtn = document.getElementById('pfxOcfRebuildIndexBtn');
const indexStatus = document.getElementById('pfxOcfIndexStatus');

// Older click: "Rebuild Index" starts and suspends on its async round trip.
rebuildBtn.dispatchEvent(new window.Event('click'));
await flush();
// Newer click: "Add OCF Folder" starts before the rebuild has resolved.
addBtn.dispatchEvent(new window.Event('click'));
await flush();

ok(pendingScan.length === 1 && pendingRebuild.length === 1,
  'each overlapping click issued its own independent async call');

// The newer call (scan) resolves first — the live, user-intended result.
pendingScan[0]({ ok: true, count: 42 });
await flush();

ok(indexStatus.textContent === '42 files indexed',
  'indexStatus reflects the newer, faster scan succeeding');

// The older call (rebuild) resolves late — superseded by the scan before its
// continuation runs.
pendingRebuild[0]({ count: 7 });
await flush();

ok(indexStatus.textContent === '42 files indexed',
  'the stale, superseded rebuild must not clobber the live status with an older count');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
