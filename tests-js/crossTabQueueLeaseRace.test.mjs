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
