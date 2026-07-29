// smart_engine_settings.js's shared decode-result panel stale-race (linkedom).
// Run: node tests-js/smartEngineSettingsDecodeResultStaleRace.test.mjs
//
// Decode Test Frame, IMF Decode Test and Generate Test Proxy each have their
// own button and their own async round trip (file/folder picker, then a
// backend call), but all three write their outcome into the same
// smartEngineDecodeResult/Label/Img elements. Nothing stopped a user from
// clicking Decode Test Frame, then clicking IMF Decode Test before the first
// call's backend round trip resolved — before the fix, whichever call's
// await resolved LAST won the shared panel, even if it started first and its
// answer is now stale (e.g. clobbering a just-finished IMF decode result with
// a slow, superseded Decode Test Frame result).

import { parseHTML } from 'linkedom';

const FIXTURE = `
<div id="smartEnginePanel">
  <button id="smartEngineDecodeTestBtn">Decode Test Frame</button>
  <button id="smartEngineImfDecodeBtn">IMF Decode Test</button>
  <button id="smartEngineProxyTestBtn">Generate Test Proxy</button>
  <div id="smartEngineDecodeResult" style="display:none;">
    <div id="smartEngineDecodeLabel"></div>
    <img id="smartEngineDecodeImg">
  </div>
</div>`;

const { window, document } = parseHTML(`<!doctype html><html><body>${FIXTURE}</body></html>`);
globalThis.window = window;
globalThis.document = document;
window.__PFX_IS_ELECTRON = true;

// The older call's decodeFrame() is left pending until the test explicitly
// resolves it, so resolution order is fully test-controlled regardless of
// which call started first.
let resolveDecodeFrame;
const pendingDecodeFrame = new Promise((resolve) => { resolveDecodeFrame = resolve; });

window.pfxPlatform = {
  pickFile:   async () => '/media/shot.mov',
  pickFolder: async () => '/media/imf_package',
  smartMedia: {
    decodeFrame: () => pendingDecodeFrame,
    imfOpen: async () => ({
      ok: true,
      playableReels: [{ cplPath: '/media/imf_package/cpl.xml' }],
      assetMaps: ['/media/imf_package/ASSETMAP.xml'],
    }),
    imfDecodeTestFrame: async () => ({ ok: true, imageDataUrl: 'data:image/png;base64,IMF', engine: 'imf-engine', codec: 'jpeg2000' }),
  },
};

const { init } = await import('../src/scripts/modules/smart_engine_settings.js');
init();

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const click = (el) => el.dispatchEvent(new window.Event('click', { bubbles: true }));
const labelEl = document.getElementById('smartEngineDecodeLabel');

// Older call: Decode Test Frame starts, its picker resolves immediately, and
// it suspends on the still-pending decodeFrame() backend call.
click(document.getElementById('smartEngineDecodeTestBtn'));
await flush();
ok(labelEl.textContent === '', 'older call has not written anything yet (still awaiting decodeFrame)');

// Newer call: IMF Decode Test starts after the older call is already
// suspended, and its own backend round trip resolves immediately.
click(document.getElementById('smartEngineImfDecodeBtn'));
await flush();
ok(labelEl.textContent.includes('IMF · Engine: imf-engine'),
  'the newer, faster IMF call wrote its result to the shared panel');

// The older call's decodeFrame() finally resolves late — superseded by the
// newer IMF call before its continuation ran.
resolveDecodeFrame({ ok: true, imageDataUrl: 'data:image/png;base64,STALE', engine: 'stale-engine' });
await flush();

ok(labelEl.textContent.includes('IMF · Engine: imf-engine'),
  'the stale, superseded older decode result must not clobber the shared panel');
ok(!labelEl.textContent.includes('stale-engine'),
  'the stale decode result text must not appear in the panel at all');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
