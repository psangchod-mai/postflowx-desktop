// vfxPullPanel.js _scanOcfFolder()/_relinkOcfFromPath() concurrent-relink race (linkedom).
// Run: node tests-js/vfxPullOcfRelinkStaleRace.test.mjs
//
// _relinkOcfFromPath(folder) awaits nativeProbeOcfFolder(folder) (an IPC round-trip
// to the native companion) before writing _state.ocfFiles/_ocfProbeCache and
// re-rendering. Rapid drag-drop of a new OCF folder, a double-clicked Rescan
// button, or an overlapping folder-picker invocation can all kick off a second
// relink chain while the first one's probe is still in flight. If the earlier
// chain's probe resolves after the later one already settled (out-of-order IPC
// resolution), the stale chain would overwrite the newer scan's OCF index and
// status text with old data — a real, user-visible "my folder change didn't
// stick" bug.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML(
  '<!doctype html><html><body><div id="pmVfxPullStatus"></div></body></html>'
);
globalThis.window = window;
globalThis.document = document;
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};
globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: true, response: {} }) } };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const calls = []; // { folderPath, deferred }

window.pfxPlatform = {
  isMacApp: true,
  sendNativeCommand(msg) {
    const d = deferred();
    calls.push({ folderPath: msg?.payload?.folderPath, deferred: d });
    return d.promise;
  },
};

const mod = await import('../src/scripts/features/vfxPull/vfxPullPanel.js');
void mod; // module side effects install window._pmRelinkOcfFromPath

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const statusEl = document.getElementById('pmVfxPullStatus');

// User drags folder A onto the panel, kicking off a relink chain that suspends
// on the native probe.
const promiseA = window._pmRelinkOcfFromPath('/A');
await flush();
ok(calls.length === 1 && calls[0].folderPath === '/A', 'relink to /A sent its own native probe call');

// Before A's probe resolves, the user drags folder B instead — its own
// independent, concurrent relink chain.
const promiseB = window._pmRelinkOcfFromPath('/B');
await flush();
ok(calls.length === 2 && calls[1].folderPath === '/B', 'relink to /B sent its own independent native probe call while A was still in flight');

// B's probe resolves first (it's the current/intended folder).
calls[1].deferred.resolve({ files: [{ name: 'B1.mov', path: '/B/B1.mov' }, { name: 'B2.mov', path: '/B/B2.mov' }] });
await flush();
await promiseB;

ok(statusEl.textContent.includes('2 OCF files indexed'), 'the settled relink to /B reported its own file count');

// A's probe resolves late — simulating out-of-order IPC resolution. The stale
// chain must not overwrite B's already-settled state or status.
calls[0].deferred.resolve({ files: [{ name: 'A1.mov', path: '/A/A1.mov' }] });
await flush();
await promiseA;

ok(statusEl.textContent.includes('2 OCF files indexed'), 'status must still reflect the settled /B relink, not overwritten by the stale /A probe');
ok(!statusEl.textContent.includes('1 OCF files indexed'), 'the stale /A relink must not have won the race');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
