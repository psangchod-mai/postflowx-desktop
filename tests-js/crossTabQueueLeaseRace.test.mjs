import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(
  path.join(__dirname, '../src/scripts/core/crossTabQueueLease.js'),
  'utf8',
);

// A minimal fake IndexedDB: just enough of open()/transaction()/objectStore()
// .get()/.put() to run crossTabQueueLease.js's lease store. Readwrite
// transactions on the same store are serialized via a shared promise chain,
// mirroring real IndexedDB's per-store transaction ordering — this is what
// lets the fix's single-transaction get+put close the TOCTOU race, and what
// lets the pre-fix two-transaction version (separate readonly get + readwrite
// put) fail to close it.
function createFakeIndexedDB() {
  const stores = new Map();
  let writeLock = Promise.resolve();

  function getStore(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  }

  function makeTransaction(storeName, mode) {
    const map = getStore(storeName);
    const tx = {};
    const ops = [];
    const objectStore = {
      get(key) {
        const req = {};
        ops.push(() => {
          try {
            req.result = map.get(key);
            req.onsuccess && req.onsuccess();
          } catch (e) {
            req.error = e;
            req.onerror && req.onerror();
          }
        });
        return req;
      },
      put(value, key) {
        const req = {};
        ops.push(() => {
          try {
            map.set(key, value);
            req.result = key;
            req.onsuccess && req.onsuccess();
          } catch (e) {
            req.error = e;
            req.onerror && req.onerror();
          }
        });
        return req;
      },
    };
    tx.objectStore = () => objectStore;

    const myTurn = mode === 'readwrite' ? writeLock : Promise.resolve();
    let release = () => {};
    if (mode === 'readwrite') {
      writeLock = new Promise((r) => { release = r; });
    }

    // Let the caller finish issuing get()/put() calls synchronously this
    // tick (attaching onsuccess/onerror) before we run anything.
    queueMicrotask(() => {
      myTurn.then(() => {
        // A drain loop, not forEach: get()'s onsuccess handler synchronously
        // calls put() (queuing another op) inside crossTabQueueLease.js's own
        // acquireLease/releaseLease — forEach's iteration bound is fixed at
        // call time and would silently skip that late-appended op.
        while (ops.length) ops.shift()();
        queueMicrotask(() => {
          tx.oncomplete && tx.oncomplete();
          release();
        });
      });
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
  };
}

function makeSessionStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v); },
  };
}

class FakeBroadcastChannel {
  constructor(name) { this.name = name; this.onmessage = null; }
  postMessage() {}
  close() {}
}

function makeTabContext(fakeIDB) {
  const ctx = {
    console,
    Date,
    Math,
    Promise,
    // Suppress the on-load auto-acquire timer and the heartbeat interval —
    // the test drives acquireLease() itself and doesn't need either running.
    setTimeout: () => {},
    clearTimeout: () => {},
    setInterval: () => {},
    clearInterval: () => {},
    sessionStorage: makeSessionStorage(),
    indexedDB: fakeIDB,
    BroadcastChannel: FakeBroadcastChannel,
    addEventListener: () => {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

test('acquireLease() is atomic across two tabs racing on startup — only one wins', async () => {
  const idb = createFakeIndexedDB();
  const tabA = makeTabContext(idb);
  const tabB = makeTabContext(idb);

  const [wonA, wonB] = await Promise.all([
    tabA.PFX_QUEUE_LEASE.acquireLease(),
    tabB.PFX_QUEUE_LEASE.acquireLease(),
  ]);

  assert.equal(
    [wonA, wonB].filter(Boolean).length,
    1,
    `exactly one racing tab must win leadership, got wonA=${wonA} wonB=${wonB}`,
  );
  assert.notEqual(
    tabA.PFX_QUEUE_LEASE.isLeader(),
    tabB.PFX_QUEUE_LEASE.isLeader(),
    'the two tabs must not both believe they are leader',
  );
});

// A fake IndexedDB that gives the test explicit, deterministic control over
// when each transaction actually runs (instead of racing on microtask
// timing like createFakeIndexedDB() above). Transactions are captured into a
// `pending` queue while paused; the test drives execution one at a time via
// runPendingAt(i), so it can interleave a stale heartbeat's read-then-write
// with a second tab's takeover write in a specific, reproducible order.
function createGatedFakeIndexedDB() {
  const map = new Map();
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
      put(value, key) {
        const req = {};
        ops.push(() => {
          map.set(key, value);
          req.result = key;
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
    getRaw() { return map.values().next().value; },
    patchRaw(patch) {
      const key = map.keys().next().value;
      map.set(key, { ...map.get(key), ...patch });
    },
  };
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function makeGatedTabContext(fakeIDB, onHeartbeat) {
  const ctx = {
    console,
    Date,
    Math,
    Promise,
    setTimeout: () => {},
    clearTimeout: () => {},
    setInterval: (cb) => { onHeartbeat(cb); return 1; },
    clearInterval: () => {},
    sessionStorage: makeSessionStorage(),
    indexedDB: fakeIDB,
    BroadcastChannel: FakeBroadcastChannel,
    addEventListener: () => {},
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  return ctx;
}

test('a stale heartbeat renewal must not clobber a takeover by another tab', async () => {
  const idb = createGatedFakeIndexedDB();
  let heartbeatCb = null;
  const tabA = makeGatedTabContext(idb, (cb) => { heartbeatCb = cb; });
  const tabB = makeTabContext(idb);

  // tabA becomes initial leader and starts its heartbeat (runs unpaused).
  const wonInitial = await tabA.PFX_QUEUE_LEASE.acquireLease();
  assert.equal(wonInitial, true);
  assert.ok(heartbeatCb, 'heartbeat callback must have been captured');

  // Simulate the lease having gone stale (e.g. A's tab was throttled/backgrounded)
  // so tabB's acquireLease() below is a legitimate takeover attempt, not a no-op.
  idb.patchRaw({ leaseUntil: 0 });

  // Now gate the store: A's stale heartbeat and B's takeover race concurrently.
  idb.pause();
  const heartbeatDone = heartbeatCb();
  const acquireBPromise = tabB.PFX_QUEUE_LEASE.acquireLease();
  await flush();

  // Drive the queued transactions in FIFO order, one step at a time. On the
  // old two-transaction heartbeat shape this reproduces: A's stale read,
  // B's atomic takeover write, then A's stale write clobbering B. On the
  // fixed single-transaction shape the 3rd step is a harmless no-op.
  await idb.runPendingAt(0); await flush();
  await idb.runPendingAt(0); await flush();
  idb.runPendingAt(0); await flush();

  const wonB = await acquireBPromise;
  await heartbeatDone;

  const finalLease = idb.getRaw();
  const currentOwnerIsB = finalLease?.queueLeaderTabId === tabB.PFX_QUEUE_LEASE.getTabId();
  const bBelievesItWon = wonB === true;

  assert.equal(
    bBelievesItWon,
    currentOwnerIsB,
    `split-brain: tabB believes it won=${bBelievesItWon} but store owner is B=${currentOwnerIsB}`,
  );
});
