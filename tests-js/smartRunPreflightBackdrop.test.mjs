import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.join(__dirname, '../src/scripts/core/smartRun.js'),
  'utf8',
);

const FIXTURE = `
<div id="pfxSmartPreflightModal">
  <div class="pfx-preflight-inner"></div>
  <button id="pfxPreflightRunBtn"></button>
  <button id="pfxPreflightCancelBtn"></button>
  <button id="pfxPreflightExportBtn"></button>
  <button id="pfxPreflightResolveBtn"></button>
</div>
<button id="pfxSmartRunBtn">⚡ Smart Run</button>
<div id="pfxIssueInbox">
  <div id="pfxIssueInboxHdr"></div>
  <div id="pfxIssueInboxBody"></div>
  <span id="pfxIssueInboxToggle"></span>
</div>`;

class FakeBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}

// run() awaits window.PFX_SWI.getAll() before it ever reaches the modal —
// an empty VFX list is enough to produce a summary object without needing
// real marker data.
function makeContext() {
  const { window, document } = parseHTML(`<!doctype html><html><body>${FIXTURE}</body></html>`);
  window.PFX_SWI = { getProjectId: () => 'default', getAll: async () => [] };
  window.BroadcastChannel = FakeBroadcastChannel;

  const ctx = {
    console,
    window,
    document,
    CustomEvent: window.CustomEvent,
    setTimeout,
    clearTimeout,
    BroadcastChannel: FakeBroadcastChannel,
  };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('clicking the preflight modal backdrop resolves run() instead of hanging it forever', async () => {
  const ctx = makeContext();

  const runPromise = ctx.window.PFX_SMART_RUN.run();
  // Let buildPreflightSummary()/refreshActionCache() microtasks settle so the
  // modal is actually shown before the backdrop click.
  await flush();
  await flush();

  const modal = ctx.document.getElementById('pfxSmartPreflightModal');
  assert.equal(modal.style.display, 'flex', 'preflight modal never opened');

  // Simulate a backdrop click: dispatched directly on the modal (not a
  // descendant), so e.target === modal — the same check _showPreflightModal
  // uses to distinguish backdrop clicks from clicks on the dialog content.
  modal.dispatchEvent(new ctx.window.Event('click', { bubbles: true }));

  // On the pre-fix code this never resolves; race it against a timeout so a
  // regression fails the test instead of hanging the whole run forever.
  const timedOut = Symbol('timeout');
  const result = await Promise.race([
    runPromise.then(() => 'resolved'),
    new Promise((resolve) => setTimeout(() => resolve(timedOut), 500)),
  ]);
  assert.notEqual(result, timedOut, 'run() never resolved after a backdrop click — the pipeline is hung');

  assert.equal(modal.style.display, 'none', 'backdrop click did not close the modal');
  const btn = ctx.document.getElementById('pfxSmartRunBtn');
  assert.equal(btn.disabled, false, '_running guard was never reset — Smart Run button stays disabled forever');
  assert.equal(btn.textContent, '⚡ Smart Run', 'button label was never restored');
});
