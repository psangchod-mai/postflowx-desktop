// resolve_engine_panel.js _refresh() concurrent-refresh race (linkedom).
// Run: node tests-js/resolveEnginePanelRefreshStaleRace.test.mjs
//
// _refresh() awaits _fetchLiveState() (an IPC round-trip via
// window.pfxPlatform.sendNativeCommand({ type: 'resolve.engineStatus' })) before
// re-rendering the engine list / GPU badge. The Refresh button, the "IMF Settings
// tab re-opened" listener, and the panel's own mount-time initial fetch can all
// kick off overlapping _refresh() calls. If an earlier call's native probe
// resolves after a later call already settled (out-of-order IPC resolution), the
// stale call would overwrite the newer refresh's engine status/project name with
// old data — a real, user-visible "the panel shows the wrong project" bug.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML(
  '<!doctype html><html><body><div id="smartEnginePanel"></div></body></html>'
);
globalThis.window = window;
globalThis.document = document;

// smart_playback_engine.js computes IS_ELECTRON at module-eval time from
// window.pfxPlatform?.smartMedia. Deliberately omit smartMedia here so
// resolveStatus() falls through to _companionPost() -> fetch(); stub fetch to
// reject immediately so that best-effort supplement path resolves fast and
// deterministically (it's wrapped in try/catch in _fetchLiveState() regardless).
globalThis.fetch = async () => { throw new Error('no companion in test'); };

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const calls = []; // { deferred }

window.__PFX_IS_ELECTRON = true;
window.pfxPlatform = {
  isMacApp: true,
  sendNativeCommand(msg) {
    const d = deferred();
    calls.push({ type: msg?.type, deferred: d });
    return d.promise;
  },
  companionStatus: async () => ({ ready: false }),
};

const mod = await import('../src/scripts/modules/resolve_engine_panel.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// Mount triggers its own initial _refresh() — settle that one first so it
// doesn't interfere with the race being tested below.
mod.mountResolveEnginePanel();
await flush();
ok(calls.length === 1, 'mount kicked off its own initial native probe call');
calls[0].deferred.resolve({ found: true, running: true, connected: true, version: 'v16', currentProject: 'Baseline' });
await flush();

const list = document.getElementById('pfxResolveEngineList');
ok(list.innerHTML.includes('Baseline'), 'initial mount-time refresh rendered its own project name');

// Refresh button clicked twice in quick succession (or tab re-opened while a
// prior refresh is still in flight) — two overlapping _refresh() chains.
mod.refreshResolveEnginePanel();
await flush();
mod.refreshResolveEnginePanel();
await flush();
ok(calls.length === 3, 'each refresh call sent its own independent native probe call');

// The later refresh's probe resolves first (it's the current/intended state).
calls[2].deferred.resolve({ found: true, running: true, connected: true, version: 'v17', currentProject: 'NewerProject' });
await flush();

ok(list.innerHTML.includes('NewerProject'), 'the settled later refresh rendered its own project name');

// The earlier refresh's probe resolves late — simulating out-of-order IPC
// resolution. The stale chain must not overwrite the newer refresh's state.
calls[1].deferred.resolve({ found: true, running: true, connected: true, version: 'v16b', currentProject: 'StaleProject' });
await flush();

ok(list.innerHTML.includes('NewerProject'), 'list must still reflect the settled newer refresh, not overwritten by the stale probe');
ok(!list.innerHTML.includes('StaleProject'), 'the stale refresh must not have won the race');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
