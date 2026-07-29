// imf_ui.js _loadEngineStatus() concurrent-refresh race (linkedom).
// Run: node tests-js/imfEngineStatusRefreshStaleRace.test.mjs
//
// _loadEngineStatus() awaits window.pfxPlatform.imf.engineStatus() (an IPC
// round-trip) before unconditionally overwriting #imfEngineStatusList's
// innerHTML with the fetched engine list. It's wired (via _wireEngineStatus(),
// called from initIMFTab()) to two independent call sites: the Refresh
// button's click listener, and the "IMF Settings tab re-opened" listener
// (fires whenever the tab is clicked while the list still shows its initial
// single placeholder row). A double-click on Refresh — or a Refresh click
// that lands while the Settings-tab-reopen auto-load is still in flight —
// kicks off two overlapping probes. If an earlier call's probe resolves
// after a later call already settled (out-of-order IPC resolution), the
// stale call would overwrite the newer refresh's engine list with old data —
// a real, user-visible "the panel shows the wrong engine status" bug.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML(
  '<!doctype html><html><body>' +
  '<div id="imfEngineStatusList"><div>placeholder</div></div>' +
  '<button id="imfEngineRefreshBtn"></button>' +
  '</body></html>'
);
globalThis.window = window;
globalThis.document = document;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const calls = []; // { deferred }

window.pfxPlatform = {
  imf: {
    engineStatus() {
      const d = deferred();
      calls.push(d);
      return d.promise;
    },
  },
};

const mod = await import('../src/scripts/modules/imf/imf_ui.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// initIMFTab() wires up _wireEngineStatus() (among many other things, all of
// which no-op gracefully against the minimal DOM/pfxPlatform stub above).
mod.initIMFTab();

const listEl = document.getElementById('imfEngineStatusList');
const refreshBtn = document.getElementById('imfEngineRefreshBtn');

// Refresh button clicked twice in quick succession (or a click landing while
// the settings-tab-reopen auto-load is still in flight) — two overlapping
// _loadEngineStatus() chains.
refreshBtn.dispatchEvent(new window.Event('click'));
await flush();
refreshBtn.dispatchEvent(new window.Event('click'));
await flush();
ok(calls.length === 2, 'each refresh click sent its own independent engineStatus() probe call');

// The later refresh's probe resolves first (it's the current/intended state).
calls[1].resolve({ engines: [{ label: 'FFmpeg', status: 'ready', detail: 'v6.1' }] });
await flush();

ok(listEl.innerHTML.includes('FFmpeg'), 'the settled later refresh rendered its own engine list');

// The earlier refresh's probe resolves late — simulating out-of-order IPC
// resolution. The stale chain must not overwrite the newer refresh's state.
calls[0].resolve({ engines: [{ label: 'StaleEngine', status: 'missing', detail: 'old probe' }] });
await flush();

ok(listEl.innerHTML.includes('FFmpeg'), 'list must still reflect the settled newer refresh, not overwritten by the stale probe');
ok(!listEl.innerHTML.includes('StaleEngine'), 'the stale refresh must not have won the race');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
