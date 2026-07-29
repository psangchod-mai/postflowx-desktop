// OcfViewer.openClip() concurrent-call race (linkedom).
// Run: node tests-js/ocfViewerOpenClipStaleRace.test.mjs
//
// openClip(clipPath) writes several shared instance fields (this._probe,
// this._engine, this._clipPath, this._imageUrl, ...) across two await
// boundaries (ocfOpen() then ocfDecodeFrame()). If a second openClip() call
// arrives before the first's awaits resolve (e.g. the user clicks a second
// clip in the media bin before the first one finishes probing/decoding),
// the two calls' continuations can interleave and whichever resolves last
// wins the write — regardless of which clip was requested last — so the
// viewer can end up showing one clip's decoded frame with another clip's
// probe/engine/badge data, or a stale call can clobber the current clip's
// state after the fact. This test drives two overlapping openClip() calls
// with independently-controlled resolution order and asserts the final
// state matches whichever call was started *last*, with no stale writes
// from the superseded call.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
globalThis.window = window;
globalThis.document = document;
globalThis.CustomEvent = window.CustomEvent || window.Event;

const pending = new Map(); // clipPath -> { probe: {resolve}, play: {resolve}, decode: {resolve} }

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function ensureSlot(clipPath) {
  if (!pending.has(clipPath)) {
    pending.set(clipPath, { probe: deferred(), play: deferred(), decode: deferred() });
  }
  return pending.get(clipPath);
}

window.pfxCompanion = {
  send({ action, clipPath }) {
    const slot = ensureSlot(clipPath);
    if (action === 'ocfEngineProbe') return slot.probe.promise;
    if (action === 'ocfPlay') return slot.play.promise;
    if (action === 'ocfDecodeFrame') return slot.decode.promise;
    throw new Error('unexpected action: ' + action);
  },
};

const { OcfViewer } = await import('../src/scripts/features/ocf_engine/ocfViewer.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const root = document.getElementById('root');
const viewer = new OcfViewer(root);

// Start openClip('A'), which suspends inside ocfOpen() awaiting the probe/play companion calls.
const promiseA = viewer.openClip('clipA.mov');
ok(viewer._loadSeq === 1, 'openClip(A) bumped _loadSeq before its await');

// Before A resolves, the user clicks clip B — a second, overlapping openClip() call.
const promiseB = viewer.openClip('clipB.mov');
ok(viewer._loadSeq === 2, 'openClip(B) bumped _loadSeq again while A was still in flight');

// Resolve A's probe/play (first await) — A's continuation runs but must see it's now stale.
pending.get('clipA.mov').probe.resolve({ cameraFamily: 'A-cam', recommendedEngine: 'ProxyEngine' });
pending.get('clipA.mov').play.resolve({ engine: 'ProxyEngine', colorBadge: { label: 'A-badge' } });
await flush();

ok(viewer._clipPath == null, 'stale openClip(A) must not have written its probe/engine data after B superseded it');

// Now resolve B's probe/play and decode — B is the live call and should win.
pending.get('clipB.mov').probe.resolve({ cameraFamily: 'B-cam', recommendedEngine: 'ProxyEngine' });
pending.get('clipB.mov').play.resolve({ engine: 'ProxyEngine', colorBadge: { label: 'B-badge' } });
await flush();

ok(viewer._clipPath === 'clipB.mov', 'live openClip(B) wrote its clip path once its probe/play resolved');
ok(viewer._colorBadge?.label === 'B-badge', 'live openClip(B) wrote its own colorBadge, not a mix with A');

pending.get('clipB.mov').decode.resolve({ ok: true, imagePath: '/tmp/b-frame.png' });
await flush();

ok(viewer._imageUrl === 'pfx-file:///tmp/b-frame.png', 'live openClip(B) wrote its decoded frame');

// Finally, resolve A's (long-superseded) decode call late — it must still be a no-op.
pending.get('clipA.mov').decode.resolve({ ok: true, imagePath: '/tmp/a-frame.png' });
await flush();

ok(viewer._imageUrl === 'pfx-file:///tmp/b-frame.png',
  `stale openClip(A) decode must not clobber the live clip's image, got ${viewer._imageUrl}`);
ok(viewer._clipPath === 'clipB.mov', 'clipPath still reflects the live clip B after the stale decode resolved');

await Promise.all([promiseA, promiseB]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
