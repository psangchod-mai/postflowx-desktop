// ocfSettings.js OcfSettingsPanel._runDecodeTest() stale-race (linkedom).
// Run: node tests-js/ocfSettingsDecodeTestStaleRace.test.mjs
//
// _attachHandlers() only skips the click handler while `this._loading` is
// true, but `_runDecodeTest()` never sets `_loading` — it's only touched by
// the check-engines/init() paths. So a double-click on "Decode Test Frame"
// starts two overlapping calls, each awaiting ocfDecodeFrame() (an IPC round
// trip). Before the fix, whichever call's await resolved LAST unconditionally
// overwrote `this._testResult` and re-rendered, so a fast, correct result
// could be clobbered by a slower, stale one with no indication to the user.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
globalThis.window = window;
globalThis.document = document;

// Fake IPC bridge: each ocfDecodeFrame() call is left pending until the test
// explicitly resolves it, so resolution order is fully test-controlled.
const pending = [];
window.pfxCompanion = {
  send({ action, ...payload }) {
    if (action !== 'ocfDecodeFrame') return Promise.resolve({});
    return new Promise((resolve) => { pending.push({ payload, resolve }); });
  },
};

const { OcfSettingsPanel } = await import('../src/scripts/features/ocf_engine/ocfSettings.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const root = document.getElementById('root');
const panel = new OcfSettingsPanel(root);
panel._rows = [{ id: 'FFmpegFrameServer', status: 'ready', label: 'FFmpeg' }];

// Call A (older, e.g. a first click) starts and suspends on its IPC round trip.
const callA = panel._runDecodeTest();
await flush();
// Call B (newer, e.g. a fast second click before _loading would ever have
// blocked it) starts before A has resolved.
const callB = panel._runDecodeTest();
await flush();
ok(pending.length === 2, 'each overlapping decode-test issued its own independent IPC call');
const [reqA, reqB] = pending;

// B's IPC call resolves first — the live, user-intended result.
reqB.resolve({ ok: true, engine: 'FFmpegFrameServer' });
await flush();
await callB;

ok(panel._testResult?.ok === true, 'panel reflects B (the newer, faster call) succeeding');

// A's IPC call resolves late — superseded by B before A's continuation runs.
reqA.resolve({ ok: false, errors: ['stale simulated failure'] });
await flush();
await callA;

ok(panel._testResult?.ok === true,
  'the stale, superseded decode-test must not clobber the live result with an older one');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
