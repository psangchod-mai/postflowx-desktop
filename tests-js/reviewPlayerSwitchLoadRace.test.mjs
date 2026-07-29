// ReviewPlayer._switchToNextIfNeeded() vs a concurrent loadAtGlobalTime() race
// (linkedom). Run: node tests-js/reviewPlayerSwitchLoadRace.test.mjs
//
// Both _switchToNextIfNeeded() (auto-advance at a clip boundary) and
// loadAtGlobalTime() (manual seek) can target the same shared `standby`
// video element with await this._loadVideo(...). If a manual seek fires
// while an auto-advance load is still in flight, the auto-advance load's
// stale resolution must be detected and discarded via the _loadSeq
// generation-token guard — otherwise it clobbers the manual seek's own
// activeIndex/video assignment with a stale one.
import { parseHTML } from 'linkedom';

const { window, document } = parseHTML('<!doctype html><html><body></body></html>');
Object.defineProperty(document, 'baseURI', { value: 'https://cdn.example.com/app/', configurable: true });
globalThis.window = window;
globalThis.document = document;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent || window.Event;
globalThis.requestAnimationFrame = () => 0;
globalThis.cancelAnimationFrame = () => {};

const { ReviewPlayer } = await import('../src/scripts/features/reviews/player.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

function makeVideo() {
  const v = document.createElement('video');
  // linkedom's <video> has no HTMLMediaElement behavior — stub just enough
  // for _loadVideo()/pause() to run without throwing.
  v.load = () => {};
  v.play = () => {};
  v.pause = () => {};
  return v;
}

function makeStore(segments) {
  return {
    state: { activeIndex: 0, isPlaying: false, segments },
    activeIndexLog: [],
    globalToSegment(t) {
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const start = seg.globalStartSec;
        const end = start + seg.durationSec;
        if (t >= start && t < end) return { index: i, localTimeSec: t - start };
      }
      const last = segments.length - 1;
      return { index: last, localTimeSec: 0 };
    },
    setActiveIndex(i) { this.activeIndexLog.push(i); this.state.activeIndex = i; },
    setTime(_t, _src) {},
    updateClip(_clipId, _patch) {},
  };
}

const segments = [
  { clipId: 'c0', url: 'clip0.mp4', inSec: 0, durationSec: 10, canPlay: true, globalStartSec: 0, name: 'clip0' },
  { clipId: 'c1', url: 'clip1.mp4', inSec: 0, durationSec: 10, canPlay: true, globalStartSec: 10, name: 'clip1' },
  { clipId: 'c2', url: 'clip2.mp4', inSec: 0, durationSec: 10, canPlay: true, globalStartSec: 20, name: 'clip2' },
];

const videoA = makeVideo();
const videoB = makeVideo();
const store = makeStore(segments);
const player = new ReviewPlayer({ videoA, videoB, store });

// videoA (active) is playing clip0, 0.3s from its end — this triggers the
// auto-advance path in _switchToNextIfNeeded().
videoA.src = 'clip0.mp4';
videoA.currentTime = 9.7;

// Kick off the auto-advance switch. It reaches `await this._loadVideo(this.standby, ...)`
// (loading clip1 into videoB) and suspends there — nothing has resolved yet.
const switchPromise = player._switchToNextIfNeeded();

ok(player._loadSeq === 1, '_switchToNextIfNeeded bumped _loadSeq before its await');
ok(videoB.src === 'clip1.mp4', 'auto-advance load put clip1 on the shared standby element');

// While that's in flight, simulate a user manually seeking to clip2 — this
// also targets the shared standby element (videoB), overwriting its src
// and attaching a second set of one-shot listeners before the first load
// has resolved.
const seekPromise = player.loadAtGlobalTime(20);

ok(player._loadSeq === 2, 'loadAtGlobalTime bumped _loadSeq again while the switch was still in flight');
ok(videoB.src === 'clip2.mp4', 'manual seek overwrote the shared standby element with clip2');

// Resolve both in-flight _loadVideo() calls at once: dispatching on videoB
// fires every currently-attached (once:true) listener, in attachment order —
// the stale switch listeners first, then the seek's.
videoB.dispatchEvent(new Event('loadedmetadata'));
videoB.dispatchEvent(new Event('loadeddata'));

await Promise.all([switchPromise, seekPromise]);

// The auto-advance switch must have bailed out via the _loadSeq guard once
// its load resolved stale, never calling setActiveIndex(1) for clip1. Only
// the manual seek's own setActiveIndex(2) call should have landed.
ok(store.activeIndexLog.length === 1,
  `exactly one setActiveIndex call should have landed, got [${store.activeIndexLog.join(', ')}]`);
ok(store.state.activeIndex === 2,
  `final activeIndex must reflect the manual seek to clip2, got ${store.state.activeIndex}`);
ok(player._switching === false, '_switching flag must be reset after the stale switch bails out');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
