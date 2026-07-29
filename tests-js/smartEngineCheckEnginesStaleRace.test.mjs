// smart_engine_settings.js checkEngines() concurrent-check race (linkedom).
// Run: node tests-js/smartEngineCheckEnginesStaleRace.test.mjs
//
// checkEngines() awaits api.status() (an IPC round-trip via
// window.pfxPlatform.smartMedia.status()) before unconditionally overwriting
// #smartEngineStatusList's innerHTML with the fetched engine list. It's wired
// to two independent call sites: the Check Engines button's click listener,
// and the "IMF Settings tab re-opened" listener (auto-fires whenever the tab
// is clicked while the list still shows its initial "Check Engines" text). A
// double-click on Check Engines — or a click that lands while the
// Settings-tab-reopen auto-check is still in flight — kicks off two
// overlapping status() probes. If an earlier call's probe resolves after a
// later call already settled (out-of-order IPC resolution), the stale call
// would overwrite the newer check's engine list with old data — a real,
// user-visible "the panel shows the wrong engine status" bug.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML(
  '<!doctype html><html><body>' +
  '<button id="smartEngineCheckBtn">Check Engines</button>' +
  '<div id="smartEngineStatusList"></div>' +
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

window.__PFX_IS_ELECTRON = true;
window.pfxPlatform = {
  smartMedia: {
    status() {
      const d = deferred();
      calls.push(d);
      return d.promise;
    },
  },
};

const mod = await import('../src/scripts/modules/smart_engine_settings.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

mod.init();

const listEl = document.getElementById('smartEngineStatusList');
const checkBtn = document.getElementById('smartEngineCheckBtn');

// Check Engines button clicked twice in quick succession (or a click landing
// while the settings-tab-reopen auto-check is still in flight) — two
// overlapping checkEngines() chains.
checkBtn.dispatchEvent(new window.Event('click'));
await flush();
checkBtn.dispatchEvent(new window.Event('click'));
await flush();
ok(calls.length === 2, 'each check click sent its own independent status() probe call');

// The later check's probe resolves first (it's the current/intended state).
calls[1].resolve({ engines: [{ label: 'FFmpeg', status: 'ready', version: 'v6.1' }] });
await flush();

ok(listEl.innerHTML.includes('FFmpeg'), 'the settled later check rendered its own engine list');

// The earlier check's probe resolves late — simulating out-of-order IPC
// resolution. The stale chain must not overwrite the newer check's state.
calls[0].resolve({ engines: [{ label: 'StaleEngine', status: 'missing', version: 'old probe' }] });
await flush();

ok(listEl.innerHTML.includes('FFmpeg'), 'list must still reflect the settled newer check, not overwritten by the stale probe');
ok(!listEl.innerHTML.includes('StaleEngine'), 'the stale check must not have won the race');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
