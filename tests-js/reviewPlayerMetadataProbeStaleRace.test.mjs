// ReviewPlayer.ensureClipMetadata() vs a concurrent _switchToNextIfNeeded()
// race (linkedom). Run: node tests-js/reviewPlayerMetadataProbeStaleRace.test.mjs
//
// ensureClipMetadata() (a background best-effort duration/codec probe, called
// from relink/import flows) and _switchToNextIfNeeded() (auto-advance at a
// clip boundary) can both target the same shared `standby` video element with
// await this._loadVideo(...). Unlike _switchToNextIfNeeded()/loadAtGlobalTime(),
// which guard their post-await reads with the _loadSeq generation-token, prior
// to this fix ensureClipMetadata() did not — so if playback crossed a clip
// boundary while a metadata probe was still in flight, the probe would read
// this.standby.duration/videoWidth *after* auto-advance had repointed that
// same element to a totally different clip, and store that wrong data against
// the probed clip's id via store.updateClip(clipId, {...}).
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
  v.load = () => {};
  v.play = () => {};
  v.pause = () => {};
  return v;
}

function makeStore(segments, clips) {
  return {
    state: { activeIndex: 0, isPlaying: false, segments, clips },
    updateClipLog: [],
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
    setActiveIndex() {},
    setTime() {},
    updateClip(clipId, patch) { this.updateClipLog.push({ clipId, patch }); },
  };
}

const clips = [
  { id: 'c0', url: 'clip0.mp4', name: 'clip0', durationSec: 10 },
  { id: 'c1', url: 'clip1.mp4', name: 'clip1', durationSec: 10 },
  { id: 'cNew', url: 'newClip.mp4', name: 'newClip', durationSec: 0 },
];
const segments = [
  { clipId: 'c0', url: 'clip0.mp4', inSec: 0, durationSec: 10, canPlay: true, globalStartSec: 0, name: 'clip0' },
  { clipId: 'c1', url: 'clip1.mp4', inSec: 0, durationSec: 10, canPlay: true, globalStartSec: 10, name: 'clip1' },
];

const videoA = makeVideo();
const videoB = makeVideo();
const store = makeStore(segments, clips);
const player = new ReviewPlayer({ videoA, videoB, store });

// videoA (active) is playing clip0, 0.3s from its end — this will trigger the
// auto-advance path in _switchToNextIfNeeded() shortly.
videoA.src = 'clip0.mp4';
videoA.currentTime = 9.7;

// A relink/import flow starts a background metadata probe for a freshly
// imported clip. It reaches `await this._loadVideo(this.standby, ...)`
// (loading newClip.mp4 into videoB, the shared standby) and suspends there.
const probePromise = player.ensureClipMetadata('cNew');

ok(player._loadSeq === 1, 'ensureClipMetadata bumped _loadSeq before its await');
ok(videoB.src === 'newClip.mp4', 'metadata probe put newClip on the shared standby element');

// Before the probe's load resolves, playback crosses the clip0/clip1
// boundary — auto-advance also needs the shared standby element and
// repoints it to clip1.
const switchPromise = player._switchToNextIfNeeded();

ok(player._loadSeq === 2, '_switchToNextIfNeeded bumped _loadSeq again while the probe was still in flight');
ok(videoB.src === 'clip1.mp4', 'auto-advance overwrote the shared standby element with clip1');

// Resolve both in-flight _loadVideo() calls at once: dispatching on videoB
// fires every currently-attached (once:true) listener, in attachment order —
// the stale probe's listeners first, then the switch's.
Object.defineProperty(videoB, 'videoWidth', { value: 640, configurable: true });
Object.defineProperty(videoB, 'duration', { value: 7, configurable: true }); // clip1's duration, not newClip's
videoB.dispatchEvent(new Event('loadedmetadata'));
videoB.dispatchEvent(new Event('loadeddata'));

await Promise.all([probePromise, switchPromise]);

// The stale metadata probe must have bailed out via the _loadSeq guard once
// its load resolved stale, never calling updateClip('cNew', ...) with
// clip1's duration/codec data.
const cNewUpdates = store.updateClipLog.filter((e) => e.clipId === 'cNew');
ok(cNewUpdates.length === 0,
  `stale probe must not have written any metadata for cNew, got ${JSON.stringify(cNewUpdates)}`);
