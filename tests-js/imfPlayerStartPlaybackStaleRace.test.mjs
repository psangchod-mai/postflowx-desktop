// IMFPlayer.startPlayback() concurrent-call race (linkedom).
// Run: node tests-js/imfPlayerStartPlaybackStaleRace.test.mjs
//
// startPlayback(opts) writes several shared instance fields (this._sessionId,
// this._streamUrl, this._frameUrl, this._info) across two await boundaries
// (this._stopSession() then imfEngine.startPlayback()). If a second
// startPlayback() call arrives before the first's awaits resolve (e.g. the
// user rapidly switches CPLs and re-triggers play before the first session
// finishes starting), the two calls' continuations can interleave and
// whichever resolves last wins the write — regardless of which CPL was
// selected last — so the player can end up bound to a stale/wrong session.
// This test drives two overlapping startPlayback() calls with independently
// controlled resolution order and asserts the final state matches whichever
// call was started *last*, with no stale writes from the superseded call.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
globalThis.window = window;
globalThis.document = document;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const startCalls = []; // { cplId, deferred }
const stopCalls = [];  // { sessionId, deferred }

window.pfxPlatform = {
  imfEngine: {
    startPlayback(packageId, cplId, opts) {
      const d = deferred();
      startCalls.push({ cplId, deferred: d });
      return d.promise;
    },
    stopPlayback(sessionId) {
      const d = deferred();
      stopCalls.push({ sessionId, deferred: d });
      d.resolve({ ok: true });
      return d.promise;
    },
  },
};

const canvas = document.getElementById('c');
canvas.getContext = () => ({ clearRect() {}, drawImage() {} });

const { createIMFPlayer } = await import('../src/scripts/modules/imf/imf_player_engine.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const player = createIMFPlayer(canvas, {});
player._packageId = 'pkg1';
player._cplId = 'cplA';

// Start playback for CPL A, which suspends inside imfEngine.startPlayback().
const promiseA = player.startPlayback();
ok(player._loadSeq === 1, 'startPlayback(A) bumped _loadSeq before its await');

// Before A resolves, the user switches to CPL B and re-triggers play.
player._cplId = 'cplB';
const promiseB = player.startPlayback();
ok(player._loadSeq === 2, 'startPlayback(B) bumped _loadSeq again while A was still in flight');

// Resolve A's session start late — it must be a no-op since B superseded it.
startCalls[0].deferred.resolve({ ok: true, sessionId: 'sess-A', streamUrl: 'stream/A', frameUrl: 'frame/A', info: { fps: 24, totalFrames: 100 } });
await flush();

ok(player._sessionId == null, 'stale startPlayback(A) must not have written its session data after B superseded it');

// Now resolve B's session start — B is the live call and should win.
startCalls[1].deferred.resolve({ ok: true, sessionId: 'sess-B', streamUrl: 'stream/B', frameUrl: 'frame/B', info: { fps: 24, totalFrames: 200 } });
await flush();

ok(player._sessionId === 'sess-B', 'live startPlayback(B) wrote its session id once it resolved');
ok(player._streamUrl === 'stream/B', 'live startPlayback(B) wrote its own streamUrl, not a mix with A');
ok(player._state === 'playing', 'live startPlayback(B) transitioned to playing');

await Promise.all([promiseA, promiseB]);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
