import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.join(__dirname, '../src/scripts/core/proxyJobPoller.js'),
  'utf8',
);

// A deferred promise so the test can control exactly when an `await` inside
// the poller's tick resolves, and run cancelWatch() while the tick is
// suspended there — mirroring a real cancelWatch() call landing mid-await.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function makeContext({ swiUpdateCalls, dispatchedEvents, getJobStatusImpl }) {
  const timers = { tick: null };
  const ctx = {
    console,
    Date,
    Math,
    Promise,
    CustomEvent: class CustomEvent { constructor(type, opts) { this.type = type; this.detail = opts?.detail; } },
    setInterval: (cb) => { timers.tick = cb; return 1; },
    clearInterval: () => { timers.tick = null; },
    window: null,
  };
  ctx.window = {
    PFX_RENDER_WORKER: {
      getJobStatus: getJobStatusImpl,
      probe: async () => ({ ok: false, error: 'no probe in test' }),
    },
    PFX_SWI: {
      getById: async () => ({ shotName: 's', sourceClipName: 'c', proxy: {} }),
      update: async (id, patch) => { swiUpdateCalls.push({ id, patch }); },
    },
    dispatchEvent: (evt) => { dispatchedEvents.push(evt); },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, timers };
}

test('a cancelWatch() landing mid-await must suppress the in-flight tick\'s SWI commit', async () => {
  const swiUpdateCalls = [];
  const dispatchedEvents = [];
  const statusGate = deferred();

  const { ctx, timers } = makeContext({
    swiUpdateCalls,
    dispatchedEvents,
    getJobStatusImpl: async () => statusGate.promise,
  });

  ctx.window.PFX_JOB_POLLER.watchJob('job-1', 'swi-1', '/tmp/out.mov');
  assert.ok(timers.tick, 'watchJob must register a setInterval tick');

  // Fire one tick; it suspends on `await getJobStatus()` since statusGate is
  // still pending.
  const tickPromise = timers.tick();

  // While the tick is suspended mid-await, cancel the watcher — simulating
  // a user action (e.g. closing the shot, retrying the render) that calls
  // the public cancelWatch() API synchronously.
  ctx.window.PFX_JOB_POLLER.cancelWatch('job-1');
  assert.deepEqual(Array.from(ctx.window.PFX_JOB_POLLER.getActiveWatchers()), [], 'watcher must be removed immediately');

  // Now let the suspended tick's status fetch resolve to 'done'.
  statusGate.resolve({ status: 'done', outputPath: '/tmp/out.mov' });
  await tickPromise;

  assert.equal(
    swiUpdateCalls.length,
    0,
    `a cancelled tick must not write SWI state, got ${JSON.stringify(swiUpdateCalls)}`,
  );
  assert.equal(
    dispatchedEvents.length,
    0,
    'a cancelled tick must not dispatch pfx_proxy_committed',
  );
});

test('an uncancelled tick still commits normally on done', async () => {
  const swiUpdateCalls = [];
  const dispatchedEvents = [];
  const statusGate = deferred();

  const { ctx, timers } = makeContext({
    swiUpdateCalls,
    dispatchedEvents,
    getJobStatusImpl: async () => statusGate.promise,
  });

  ctx.window.PFX_JOB_POLLER.watchJob('job-2', 'swi-2', '/tmp/out2.mov');
  const tickPromise = timers.tick();
  statusGate.resolve({ status: 'done', outputPath: '/tmp/out2.mov' });
  await tickPromise;

  assert.equal(swiUpdateCalls.length, 1, 'a non-cancelled done tick must commit exactly one SWI update');
  assert.equal(dispatchedEvents.length, 1, 'a non-cancelled done tick must dispatch pfx_proxy_committed');
  assert.deepEqual(Array.from(ctx.window.PFX_JOB_POLLER.getActiveWatchers()), []);
});
