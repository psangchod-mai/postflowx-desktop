// proResProxy.js _getPingPort()'s stale-race (Node, no DOM needed).
// Run: node tests-js/proResProxyPingPortStaleRace.test.mjs
//
// _getPingPort() caches the companion's HTTP port in module-level
// _httpPortCached so concurrent callers (warmProxyCacheFromStorage() on page
// load, getProxyStreamUrl() per file, and the module's own
// chrome.storage.onChanged listener) only ping once. Two overlapping calls can
// each independently discover a port and write the shared cache when their
// await resolves — before the fix, whichever call's discovery round trip
// finishes LAST wins, even if it started first and found a stale answer (e.g.
// a companion process that has since been replaced by the one the newer call
// already confirmed on the well-known port).

globalThis.localStorage = {
  _store: new Map(),
  getItem(k) { return this._store.has(k) ? this._store.get(k) : null; },
  setItem(k, v) { this._store.set(k, String(v)); },
};
localStorage.setItem('pfx_media_root_path', '/media/project');

// Skip native-messaging token round trips entirely — not what this race is about.
globalThis.__pfxCompanionHttpToken = 'test-token';

// fetch mock: /ping requests to a given port are queued and resolved by the
// test in whatever order it chooses, fully controlling which call "finishes"
// first regardless of which call started first. Anything else (cache/list,
// cache/migrate) resolves immediately with ok:false so callers just return.
const pendingPing = new Map(); // port -> [resolve, ...]
function queuePing(port) {
  return new Promise((resolve) => {
    const arr = pendingPing.get(port) || [];
    arr.push(resolve);
    pendingPing.set(port, arr);
  });
}
function resolvePing(port, ok) {
  const arr = pendingPing.get(port);
  const resolve = arr.shift();
  resolve(ok);
}
globalThis.fetch = (url) => {
  const m = /127\.0\.0\.1:(\d+)\/ping/.exec(String(url));
  if (m) {
    const port = Number(m[1]);
    return queuePing(port).then((ok) => ({ ok }));
  }
  return Promise.resolve({ ok: false });
};

// Path 3 (native messaging) fallback for the older call, which fails its
// well-known-port probe and has to ask the background worker.
const pendingSendMessage = [];
globalThis.chrome = {
  runtime: {
    sendMessage(_msg, cb) { pendingSendMessage.push(cb); },
    lastError: undefined,
  },
};

const { warmProxyCacheFromStorage } = await import('../src/scripts/modules/proResProxy.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

// Older call: well-known port (47125) isn't up yet from its perspective —
// falls through to native messaging, which stays pending.
const callA = warmProxyCacheFromStorage();
await flush();
ok((pendingPing.get(47125) || []).length === 1, 'older call probed the well-known port');
resolvePing(47125, false);
await flush();
ok(pendingSendMessage.length === 1, 'older call fell through to native messaging after the probe failed');

// Newer call: starts after the older call has already suspended on native
// messaging. Its own well-known-port probe succeeds immediately.
const callB = warmProxyCacheFromStorage();
await flush();
ok((pendingPing.get(47125) || []).length === 1, 'newer call issued its own independent probe');
resolvePing(47125, true);
await callB;

// Older call's native-messaging round trip finally resolves — with a port
// that (per this scenario) used to be valid but has since been superseded.
// _httpAlive on that stale port still happens to succeed (e.g. the old
// process hadn't fully exited yet), so the only thing that should stop it
// from clobbering the shared cache is the sequence guard.
pendingSendMessage[0]({ port: 9050, token: 'stale-token' });
await flush();
ok((pendingPing.get(9050) || []).length === 1, 'older call is now verifying its stale native-messaging port');
resolvePing(9050, true);
await callA;

// A third caller reads whatever is now cached. TTL is fresh either way, so it
// takes the path-1 revalidation branch against whatever port is cached.
const thirdProbe = new Promise((resolve) => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = (url) => {
    const m = /127\.0\.0\.1:(\d+)\/ping/.exec(String(url));
    if (m) resolve(Number(m[1]));
    globalThis.fetch = origFetch;
    return origFetch(url);
  };
});
const callC = warmProxyCacheFromStorage();
const revalidatedPort = await thirdProbe;
resolvePing(revalidatedPort, true);
await callC;

ok(revalidatedPort === 47125,
  'the newer call\'s port (47125) must win the shared cache, not the older call\'s stale, later-resolving port (9050)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
