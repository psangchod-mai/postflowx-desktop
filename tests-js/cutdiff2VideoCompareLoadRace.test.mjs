// cutdiff2/index.js video-compare load race (linkedom).
// Run: node tests-js/cutdiff2VideoCompareLoadRace.test.mjs
//
// applySnapshot() restores a saved OLD/NEW proxy-video link by kicking off an
// async silent IndexedDB restore (_vcRestoreSilent). If the user then clicks
// the (legacy, hidden) browse button before that silent restore resolves, a
// SECOND async chain starts: the capture-phase auto-relink listener fires
// _vcRestoreFromIDB, and the click's own handler fires _vcBrowse — all three
// chains read the same saved file handle and race to call _vcLoad(). Without
// a generation guard, whichever getFile() promise happened to resolve LAST
// would win and stomp the on-screen filename/video — even if it was actually
// the OLDEST, most-stale request. _vcLoadGen ensures the highest-generation
// (most recent) caller always wins, regardless of physical resolution order.

import { parseHTML } from 'linkedom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(path.join(__dirname, 'fixtures', 'cd2_panel.html'), 'utf8');

const { window, document } = parseHTML(`<!doctype html><html><body>${FIXTURE}</body></html>`);
globalThis.window = window;
globalThis.document = document;

globalThis.URL.createObjectURL = (() => { let n = 0; return () => `blob:fake-${++n}`; })();
globalThis.URL.revokeObjectURL = () => {};
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

for (const id of ['cd2x-vc-vid-old', 'cd2x-vc-vid-new']) {
  const v = document.getElementById(id);
  v.load = () => {};
  v.play = () => Promise.resolve();
  v.pause = () => {};
}

// ── Fake IndexedDB backing a single pre-seeded 'old' handle ─────────────────
const resolvers = [];
const sharedHandle = {
  name: 'linked.mp4',
  async getFile() {
    return new Promise((resolve) => resolvers.push(resolve));
  },
};
const store = new Map([['old', sharedHandle]]);

function makeRequest() {
  const req = {};
  queueMicrotask(() => {
    try {
      const result = req.__run();
      req.result = result;
      req.onsuccess?.({ target: req });
    } catch (err) {
      req.error = err;
      req.onerror?.({ target: req });
    }
  });
  return req;
}

globalThis.indexedDB = {
  open(_name, _version) {
    const req = makeRequest();
    req.__run = () => {
      const db = {
        transaction(_storeName, _mode) {
          return {
            objectStore() {
              return {
                get(key) {
                  const r = makeRequest();
                  r.__run = () => store.get(key) || null;
                  return r;
                },
              };
            },
          };
        },
        close() {},
      };
      return db;
    };
    return req;
  },
};

const { createCutDiff2Feature } = await import('../src/scripts/features/cutdiff2/index.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

const flush = async (n = 15) => { for (let i = 0; i < n; i++) await Promise.resolve(); };
const click = (el) => el.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));

const feature = createCutDiff2Feature({});
feature.mount();

// Generation #1: applySnapshot() fires _vcRestoreSilent() (unawaited).
feature.applySnapshot({ v: 2, vcOldName: 'linked.mp4', vcNewName: '' });
await flush();

// Generation #2 + #3: one click fires the capture-phase auto-relink
// (_vcRestoreFromIDB) THEN the button's own handler (_vcBrowse), in that order.
click(document.getElementById('cd2x-vc-old-browse'));
await flush();

ok(resolvers.length === 3, `all three getFile() calls are in flight (got ${resolvers.length})`);

// Resolve in REVERSE generation order — the newest (highest-gen) caller's
// getFile() settles FIRST, proving the guard (not resolution order) wins.
resolvers[2](new File(['x'], 'browse-FRESH.mp4', { type: 'video/mp4' }));
await flush();
resolvers[1](new File(['x'], 'restoreFromIDB-STALE.mp4', { type: 'video/mp4' }));
await flush();
resolvers[0](new File(['x'], 'silent-OLDEST.mp4', { type: 'video/mp4' }));
await flush();

const nameEl = document.getElementById('cd2x-vc-old-name');
ok(nameEl.textContent === 'browse-FRESH.mp4',
  `highest-generation load wins regardless of resolution order (got "${nameEl.textContent}")`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
