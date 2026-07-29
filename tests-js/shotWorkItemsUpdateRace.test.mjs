import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.join(__dirname, '../src/scripts/core/shotWorkItems.js'),
  'utf8',
);

// A fake IndexedDB that gives the test explicit, deterministic control over
// when each transaction actually runs (mirrors createGatedFakeIndexedDB in
// tests-js/crossTabQueueLeaseRace.test.mjs). Transactions are captured into a
// `pending` queue while paused; the test drives them one at a time via
// runPendingAt(i), so it can interleave two update() calls' reads and writes
// in a specific, reproducible order. keyPath is 'shotWorkId', matching the
// real object store, so put() is called with just a value (no explicit key).
function createGatedFakeIndexedDB(initial) {
  const map = new Map();
  if (initial) map.set(initial.shotWorkId, initial);
  let paused = false;
  const pending = [];

  function run(tx, ops) {
    while (ops.length) ops.shift()();
    queueMicrotask(() => { tx.oncomplete && tx.oncomplete(); });
  }

  function makeTransaction(storeName, mode) {
    const tx = {};
    const ops = [];
    const objectStore = {
      get(key) {
        const req = {};
        ops.push(() => {
          req.result = map.get(key);
          req.onsuccess && req.onsuccess();
        });
        return req;
      },
      put(value) {
        const req = {};
        ops.push(() => {
          map.set(value.shotWorkId, value);
          req.result = value.shotWorkId;
          req.onsuccess && req.onsuccess();
        });
        return req;
      },
    };
    tx.objectStore = () => objectStore;

    queueMicrotask(() => {
      if (paused) {
        pending.push(() => run(tx, ops));
      } else {
        run(tx, ops);
      }
    });

    return tx;
  }

  return {
    open() {
      const req = {};
      queueMicrotask(() => {
        req.result = { transaction: makeTransaction };
        req.onsuccess && req.onsuccess();
      });
      return req;
    },
    pause() { paused = true; },
    runPendingAt(i) {
      const fn = pending[i];
      if (!fn) return false;
      pending.splice(i, 1);
      fn();
      return true;
    },
    getRaw(shotWorkId) { return map.get(shotWorkId); },
  };
}

class FakeBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeContext(fakeIDB) {
  const ctx = {
    console,
    Date,
    Math,
    Promise,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: () => {},
    indexedDB: fakeIDB,
    BroadcastChannel: FakeBroadcastChannel,
    window: null,
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

test('two concurrent update() calls on the same shotWorkId must not lose either patch', async () => {
  const idb = createGatedFakeIndexedDB({
    shotWorkId: 'swi-1',
    proxyProgress: 0,
    srcTcIn: '00:00:00:00',
    updatedAt: 't0',
  });
  const ctx = makeContext(idb);

  // Gate the store so both update() calls' reads land before either write —
  // reproducing a proxy-poll progress tick racing a cut-diff TC-range update
  // for the same shotWorkId.
  idb.pause();
  const updateAPromise = ctx.window.PFX_SWI.update('swi-1', { proxyProgress: 0.5 });
  const updateBPromise = ctx.window.PFX_SWI.update('swi-1', { srcTcIn: '00:00:01:00' });
  await flush();

  // Drive the two queued transactions to completion in FIFO order. On the old
  // two-transaction shape (separate readonly get() + readwrite put()) this
  // ordering lets both calls read the pre-write record before either put()
  // lands, so whichever write lands last clobbers the other's field. On the
  // fixed single-transaction shape, IndexedDB serializes the two readwrite
  // transactions on the same store, so the second call's get() only runs
  // after the first's put() has completed.
  await idb.runPendingAt(0); await flush();
  idb.runPendingAt(0); await flush();

  await updateAPromise;
  await updateBPromise;

  const final = idb.getRaw('swi-1');
  assert.equal(final.proxyProgress, 0.5, `progress patch must survive, got ${JSON.stringify(final)}`);
  assert.equal(final.srcTcIn, '00:00:01:00', `TC patch must survive, got ${JSON.stringify(final)}`);
});

test('update() returns null and leaves the store untouched for an unknown shotWorkId', async () => {
  const idb = createGatedFakeIndexedDB({ shotWorkId: 'swi-1', proxyProgress: 0 });
  const ctx = makeContext(idb);

  const result = await ctx.window.PFX_SWI.update('does-not-exist', { proxyProgress: 1 });

  assert.equal(result, null);
  assert.equal(idb.getRaw('does-not-exist'), undefined);
});
