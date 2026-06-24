// scripts/media/mediaPlaybackController.js
// Extension-side playback controller for the shared media runtime.
// Provides frame-accurate playback, smooth scrubbing, and prefetch coordination.
//
// Usage (any tab):
//   import { MediaPlaybackController } from '../media/mediaPlaybackController.js';
//   const ctrl = new MediaPlaybackController(sessionId);
//   ctrl.play({ fps: 24, onFrame: (result) => { video.src = result.dataUrl; } });
//   ctrl.seekTo(100);
//   ctrl.pause();
//   ctrl.destroy();

import { getPreviewFrame, seekMedia } from './mediaRuntime.js';
import { sendMediaCommand } from './mediaBridge.js';
import { cacheGet, cachePut, cacheEvictSession } from './mediaFrameCache.js';

const DEFAULT_PREFETCH_AHEAD   = 6;
const DEFAULT_PREFETCH_OPTIONS = { quality: 'half', width: 1280, height: 720, format: 'jpg' };
const RAF_SLACK_MS             = 4;   // fire frame slightly early to avoid visual stutter

export class MediaPlaybackController {
  /**
   * @param {string} sessionId
   * @param {Object} [defaultFrameOptions]  - quality/width/height/format defaults
   */
  constructor(sessionId, defaultFrameOptions = {}) {
    this._sid      = sessionId;
    this._opts     = { ...DEFAULT_PREFETCH_OPTIONS, ...defaultFrameOptions };
    this._playing  = false;
    this._fps      = 24;
    this._frame    = 0;
    this._rafId    = null;
    this._lastTime = 0;   // DOMHighResTimeStamp of last frame render
    this._onFrame  = null;
    this._inflight = new Set();   // frame indices currently being fetched
    this._prefetchDir = +1;
    this._destroyed   = false;
  }

  // ── Playback ─────────────────────────────────────────────────────────────

  /**
   * Start forward playback at the given fps.
   * @param {Object} opts
   * @param {number}   opts.fps
   * @param {Function} opts.onFrame  - called with { dataUrl, frameIndex } each frame
   * @param {number}   [opts.startFrame]
   */
  play({ fps = 24, onFrame, startFrame } = {}) {
    if (this._destroyed) return;
    this._fps      = fps;
    this._onFrame  = onFrame;
    this._playing  = true;
    this._prefetchDir = +1;
    if (startFrame != null) this._frame = startFrame;

    this._kickPrefetch(this._frame);
    this._scheduleRaf();
  }

  pause() {
    this._playing = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  /**
   * Seek to a specific frame.
   * Tries cache first (instant), then fetches from companion.
   * Also cancels current prefetch and restarts from new position.
   * @param {number} frameIndex
   * @param {Function} [onResult]
   */
  async seekTo(frameIndex, onResult) {
    if (this._destroyed) return;
    const targetFrame = Math.max(0, Math.round(frameIndex));
    this._frame = targetFrame;
    this._cancelPrefetch();

    // Cache hit → instant
    const cached = cacheGet(this._sid, targetFrame,
      this._opts.quality, this._opts.width, this._opts.height, this._opts.format);
    if (cached) {
      onResult?.(cached);
      this._onFrame?.(cached);
      this._kickPrefetch(this._frame);
      return;
    }

    // Fetch from companion
    try {
      const result = await getPreviewFrame(this._sid, targetFrame, this._opts);
      if (result?.dataUrl) {
        cachePut(this._sid, targetFrame, result, this._opts);
        if (this._frame !== targetFrame) return; // superseded by a later seek
        onResult?.(result);
        this._onFrame?.(result);
        this._kickPrefetch(this._frame);
      }
    } catch (e) {
      console.warn('[MediaCtrl] seekTo failed:', e?.message || e);
    }
  }

  /** Step forward or backward by `delta` frames. */
  async stepFrame(delta = 1, onResult) {
    return this.seekTo(this._frame + delta, onResult);
  }

  get currentFrame() { return this._frame; }
  get isPlaying()    { return this._playing; }

  /** Release all resources. */
  destroy() {
    this._destroyed = true;
    this.pause();
    this._cancelPrefetch();
    // Do NOT evict the shared session cache here — the session may still be used
    // by other controller instances. cacheEvictSession is called by closeMedia().
  }

  // ── RAF loop ─────────────────────────────────────────────────────────────

  _scheduleRaf() {
    if (!this._playing || this._destroyed) return;
    this._rafId = requestAnimationFrame((ts) => this._rafTick(ts));
  }

  _rafTick(ts) {
    if (!this._playing || this._destroyed) return;
    const msPerFrame = 1000 / this._fps;

    if (ts - this._lastTime >= msPerFrame - RAF_SLACK_MS) {
      this._lastTime = ts;
      this._renderFrame(this._frame);
      this._frame++;
    }
    this._scheduleRaf();
  }

  _renderFrame(frameIndex) {
    // Cache hit → instant
    const cached = cacheGet(this._sid, frameIndex,
      this._opts.quality, this._opts.width, this._opts.height, this._opts.format);
    if (cached) {
      this._onFrame?.(cached);
      return;
    }
    // Cache miss during playback — fetch async (may stutter once, then prefetch catches up)
    this._fetchAsync(frameIndex);
  }

  async _fetchAsync(frameIndex) {
    if (this._inflight.has(frameIndex)) return;
    this._inflight.add(frameIndex);
    try {
      const result = await getPreviewFrame(this._sid, frameIndex, this._opts);
      if (result?.dataUrl) {
        cachePut(this._sid, frameIndex, result, this._opts);
        if (frameIndex === this._frame - 1) {
          // Still relevant — show it
          this._onFrame?.(result);
        }
      }
    } catch { /* ignore */ } finally {
      this._inflight.delete(frameIndex);
    }
  }

  // ── Prefetch ─────────────────────────────────────────────────────────────

  _kickPrefetch(fromFrame) {
    if (this._destroyed) return;
    // Tell companion to prefetch N frames ahead (best-effort, fire-and-forget)
    sendMediaCommand('mediaPrefetch', {
      sessionId:    this._sid,
      currentFrame: fromFrame,
      count:        DEFAULT_PREFETCH_AHEAD,
      direction:    this._prefetchDir,
      ...this._opts,
    }, 5000).catch(() => {/* companion may not support this yet */});
  }

  _cancelPrefetch() {
    this._inflight.clear();
    // Tell companion to cancel pending prefetch for this session
    sendMediaCommand('mediaPrefetch', {
      sessionId:    this._sid,
      currentFrame: this._frame,
      count:        0,   // count=0 signals cancel
    }, 3000).catch(() => {});
  }
}
