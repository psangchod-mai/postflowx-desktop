// vfxPullSettings.js Browse-folder-picker stale-settings race (linkedom).
// Run: node tests-js/vfxPullSettingsBrowseStaleRace.test.mjs
//
// Clicking "Browse…" on the Export tab fires an async chrome.runtime.sendMessage
// round trip to the native folder picker. If the user closes the modal and
// reopens it (or hits Reset Defaults) before that picker resolves, _vs.settings
// is reassigned to a brand-new object — but the picker's callback had no way to
// know that, and used to write the (now-stale) chosen path straight into
// whatever _vs.settings currently pointed to, silently corrupting the fresh
// settings object with a folder the user never picked for this session. That
// corruption then persists to localStorage on the next Save/Close.

import { parseHTML } from 'linkedom';

const FIXTURE = `
<button id="pfxVfxSettingsBtn"></button>
<div id="pfxVfxSettingsModal" hidden>
  <div id="pfxVfxSettingsScrim"></div>
  <button id="pfxVfxSettingsClose"></button>
  <button class="pfx-vfxs-tab" data-tab="setup">Setup</button>
  <button class="pfx-vfxs-tab" data-tab="export">Export</button>
  <div id="pfxVfxSettingsBody"></div>
  <button id="pfxVfxSettingsCancel"></button>
  <button id="pfxVfxSettingsUpdate"></button>
  <button id="pfxVfxSettingsReset"></button>
</div>`;

const { window, document } = parseHTML(`<!doctype html><html><body>${FIXTURE}</body></html>`);
globalThis.window = window;
globalThis.document = document;

globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};

let pendingCb = null;
globalThis.chrome = {
  runtime: {
    lastError: undefined,
    sendMessage(msg, cb) { pendingCb = cb; },
  },
};

await import('../src/scripts/features/vfxPull/vfxPullSettings.js');
document.dispatchEvent(new window.Event('DOMContentLoaded', { bubbles: true, cancelable: true }));

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

const click = (el) => el.dispatchEvent(new window.Event('click', { bubbles: true }));

// Open the settings modal (first open → loads fresh defaults) and switch to
// the Export tab, which renders the Browse… button.
window._pfxVfxSettingsOpen();
click(document.querySelector('.pfx-vfxs-tab[data-tab="export"]'));

const pickBtn = document.getElementById('pfxVfxStPickFolder');
ok(!!pickBtn, 'Export tab rendered the Browse… button');

// User clicks Browse — the native picker call goes out and suspends.
click(pickBtn);
ok(typeof pendingCb === 'function', 'Browse click sent a native folder-picker call');

// Before the picker resolves, the user closes the modal (no unsaved edits
// yet, since the callback hasn't written anything) and reopens it — which
// reloads _vs.settings into a brand-new object.
window._pfxVfxSettingsClose();
window._pfxVfxSettingsOpen();

// The stale picker call now resolves with the folder the user picked for the
// PREVIOUS settings object.
pendingCb({ ok: true, response: { path: '/Volumes/Shared/STALE_PICK' } });

const after = window._pfxVfxSettingsGet();
ok(after.outputRootPath !== '/Volumes/Shared/STALE_PICK',
  'stale Browse result must not be written into the reloaded settings object');
ok(after.outputRootPath === '', 'reloaded settings kept their fresh default output path');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
