// NativeAVPlayerEngine.seekFrame() concurrent-call race (linkedom).
// Run: node tests-js/nativeAVPlayerSeekFrameStaleRace.test.mjs
//
// seekFrame(frame) sets this._frame synchronously, then awaits _renderFrame(),
// which extracts and paints the frame and fires onTimeUpdate(frame, fps) once
// the extraction resolves. Dragging a scrub bar fires seekFrame() repeatedly
// before the previous call's frame extraction (real I/O) resolves. A second
// overlapping call is immediately dropped by the `_busy` guard (an
// intentional, pre-existing throttle — not something this fix changes), but
// this._frame is already overwritten to the newer target by then. Without a
// staleness guard, the earlier call's now-stale extraction can still resolve
// and paint frame 5 / report onTimeUpdate(5, ...) even though this._frame is
// already 10 — a real, user-visible wrong-frame bug where the displayed frame
// contradicts the playhead position. Once the stale call's busy lock clears, a
// fresh seekFrame() for the settled position (e.g. the drag-release seek) must
// still render and report correctly.

import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body><canvas id="c"></canvas></body></html>');
globalThis.window = window;
globalThis.document = document;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const extractCalls = []; // { frame, deferred }

window.pfxPlatform = {
  nativeEngine: {
    frameExtract(sessionId, frame) {
      const d = deferred();
      extractCalls.push({ frame, deferred: d });
      return d.promise;
    },
  },
};

const canvas = document.getElementById('c');
canvas.width = 100;
canvas.height = 100;
canvas.getContext = () => ({ drawImage() {} });

// linkedom's Image never fires onload/onerror on its own; resolve draws
// synchronously as "success" so _drawDataUrl() settles without the 4s watchdog.
class FakeImage {
  constructor() {
    this.naturalWidth = 1920;
    this.naturalHeight = 1080;
  }
  set src(v) { if (this.onload) this.onload(); }
}
globalThis.Image = FakeImage;

const { NativeAVPlayerEngine } = await import('../src/scripts/core/nativeAVPlayer.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

async function flush(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}

const timeUpdates = [];
const engine = new NativeAVPlayerEngine(canvas, { onTimeUpdate: (frame, fps) => timeUpdates.push({ frame, fps }) });
engine._filePath        = '/path/movie.mov';
engine._useNativeEngine = true;
engine._sessionId       = 'sess1';
engine._totalFrames     = 1000;
engine._fps             = 24;

// Scrub bar drags to frame 5, kicking off extraction, which suspends.
const promiseA = engine.seekFrame(5);
ok(engine._loadSeq === 1, 'seekFrame(5) bumped _loadSeq before its await');

// Before A resolves, the user drags further to frame 10 — dropped immediately
// by the pre-existing _busy guard (no new extraction call is made), but
// this._frame and _loadSeq are already updated to reflect it.
const promiseB = engine.seekFrame(10);
ok(engine._loadSeq === 2, 'seekFrame(10) bumped _loadSeq again while 5 was still in flight');
ok(engine._frame === 10, 'this._frame reflects the latest requested frame');
ok(extractCalls.length === 1, 'seekFrame(10) was busy-dropped and made no new extraction call');

// Resolve A's (frame 5) extraction late — it must be a no-op since 10 superseded it.
extractCalls[0].deferred.resolve({ imageDataUrl: 'data:image/png;base64,AAAA' });
await flush();

ok(timeUpdates.length === 0, 'stale seekFrame(5) must not have fired onTimeUpdate after 10 superseded it');
ok(engine._busy === false, 'the busy lock is released once the stale render finishes');

await promiseA;
await promiseB;

// Once the busy lock clears, a fresh seek for the settled position (e.g. the
// drag-release seek) must still render and report correctly.
const promiseC = engine.seekFrame(10);
ok(extractCalls.length === 2, 'the post-drag seekFrame(10) made its own extraction call');
extractCalls[1].deferred.resolve({ imageDataUrl: 'data:image/png;base64,BBBB' });
await flush();
await promiseC;

ok(timeUpdates.length === 1, 'the settled seekFrame(10) fired exactly one onTimeUpdate once it resolved');
ok(timeUpdates[0]?.frame === 10, 'the reported onTimeUpdate frame is 10, not the stale 5');

// Opening ProRes can overlap the first ResizeObserver repaint. The observer must
// stay out of the way until the backend session exists, so open() owns one clean
// first-frame render instead of seeing `_busy` and falling through to a proxy.
const firstFrame = deferred();
let openRaceEngine;
let legacyCalls = 0;
window.pfxPlatform = {
  nativeEngine: {
    async open() {
      queueMicrotask(() => openRaceEngine.repaint());
      return { sessionId: 'sess-open', fps: 24, frameCount: 120, duration: 5 };
    },
    async frameExtract(sessionId, frame) {
      await firstFrame.promise;
      return { imageDataUrl: `data:image/png;base64,OPEN${frame}` };
    },
  },
  media: {
    async getInfo() { legacyCalls++; return { ok: true, fps: 24, duration: 5 }; },
    async getStill() { legacyCalls++; return { ok: false, error: 'legacy path should not run' }; },
  },
};

openRaceEngine = new NativeAVPlayerEngine(canvas);
const openPromise = openRaceEngine.open('/path/prores.mov');
await flush();
ok(openRaceEngine._busy === true, 'open owns the first-frame render while the resize repaint is suppressed');
firstFrame.resolve();
const openResult = await openPromise;
ok(openResult.ok === true, 'open accepts its native first-frame paint');
ok(openRaceEngine.decoder === 'PFXNativeEngine', 'open keeps direct AVFoundation playback active');
ok(openRaceEngine._lastRenderedFrame === 0, 'the verified first frame is recorded as frame 0');
ok(legacyCalls === 0, 'successful native first-frame repaint does not fall through to another backend');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
