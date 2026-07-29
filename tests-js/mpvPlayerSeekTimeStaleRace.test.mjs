// MPVPlayerEngine.seekTime() concurrent-call race (linkedom).
// Run: node tests-js/mpvPlayerSeekTimeStaleRace.test.mjs
//
// seekTime(seconds) awaits an IPC round-trip (`media.mpv.seek`) before writing
// this._cachedTime and firing onTimeUpdate. Dragging a scrub bar fires
// seekFrame()/seekTime() repeatedly; each call is its own independent IPC
// round-trip (unlike NativeAVPlayerEngine's seekFrame(), there is no `_busy`
// guard here), so nothing stops two calls from being in flight at once. If an
// earlier call's IPC round-trip resolves after a later one (out-of-order
// resolution, e.g. the main process replies in a different order than it
// received), the stale call would overwrite _cachedTime backwards and report
// onTimeUpdate for the earlier position even though the later seek already
// settled — a real, user-visible wrong-time bug.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
globalThis.window = window;
globalThis.document = document;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const calls = []; // { type, payload, deferred }

window.pfxPlatform = {
  media: {
    _call(type, payload) {
      const d = deferred();
      calls.push({ type, payload, deferred: d });
      return d.promise;
    },
  },
};

const canvas = document.getElementById('c');
canvas.width = 100;
canvas.height = 100;
canvas.getContext = () => ({ clearRect() {}, fillRect() {}, fillText() {} });

const { MPVPlayerEngine } = await import('../src/scripts/core/mpvPlayer.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const timeUpdates = [];
const engine = new MPVPlayerEngine(canvas, { fps: 24, onTimeUpdate: (frame, fps) => timeUpdates.push({ frame, fps }) });
engine._sessionId = 'sess1';

// Scrub drags to 1s, kicking off an IPC seek that suspends.
const promiseA = engine.seekTime(1);
ok(engine._loadSeq === 1, 'seekTime(1) bumped _loadSeq before its await');

// Before A's IPC round-trip resolves, the user drags further to 2s — its own
// independent, concurrent IPC call (no busy guard here).
const promiseB = engine.seekTime(2);
ok(engine._loadSeq === 2, 'seekTime(2) bumped _loadSeq again while 1s was still in flight');
ok(calls.length === 2, 'both seekTime calls made their own independent IPC call');

// Resolve B (the later seek) first, then A late — simulating out-of-order
// IPC resolution. A's stale write must be a no-op since B superseded it.
calls[1].deferred.resolve({ ok: true });
await flush();
await promiseB;

ok(timeUpdates.length === 1, 'the settled seekTime(2) fired its onTimeUpdate');
ok(timeUpdates[0]?.frame === 48, 'the reported frame is for 2s at 24fps (48), not stale');
ok(engine._cachedTime === 2, 'this._cachedTime reflects the settled 2s seek');

calls[0].deferred.resolve({ ok: true });
await flush();
await promiseA;

ok(timeUpdates.length === 1, 'the stale seekTime(1) must not have fired a second onTimeUpdate after 2s superseded it');
ok(engine._cachedTime === 2, 'this._cachedTime must still be 2s, not overwritten back to the stale 1s');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
