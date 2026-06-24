/**
 * nativeAVPlayer.js — Canvas-based ProRes player using PFXNativeMediaEngine.
 *
 * Frames are extracted from a persistent AVAsset session in the native engine
 * (~5ms/frame via session-cached AVAssetImageGenerator vs ~100ms for spawning
 * a new avf_bridge process each time). Falls back to the legacy avf_bridge
 * getStill path when the native engine binary is not present.
 *
 * API:
 *   const engine = new NativeAVPlayerEngine(canvas, opts)
 *   await engine.open(filePath)
 *   engine.play() / engine.pause()
 *   await engine.seekFrame(n)
 *   await engine.seekTime(sec)
 *   await engine.stepForward(n)
 *   await engine.stepBack(n)
 *   engine.close()
 *
 * opts:
 *   onTimeUpdate(frame, fps)  — fires after each rendered frame
 *   onStatus(label)           — human-readable status string
 *   onError(msg)              — called on unrecoverable errors
 *   onPlayEnd()               — called when play reaches EOF
 */

export class NativeAVPlayerEngine {
  constructor(canvas, opts = {}) {
    this._canvas      = canvas;
    this._ctx         = canvas.getContext('2d');
    this._opts        = opts;
    this._filePath    = null;
    this._info        = null;
    this._fps         = 24;
    this._totalFrames = 0;
    this._frame       = 0;
    this._playing     = false;
    this._rafId       = null;
    this._lastTick    = 0;
    this._busy        = false;
    // Native engine session — null means fall back to legacy avf_bridge getStill
    this._sessionId   = null;
    this._useNativeEngine = false;
  }

  get currentFrame()  { return this._frame; }
  get currentTime()   { return this._fps > 0 ? this._frame / this._fps : 0; }
  get duration()      { return this._fps > 0 ? this._totalFrames / this._fps : 0; }
  get fps()           { return this._fps; }
  get info()          { return this._info; }
  get isPlaying()     { return this._playing; }
  get decoder()       { return this._useNativeEngine ? 'PFXNativeEngine' : 'avf_bridge'; }

  async open(filePath) {
    this._filePath          = filePath;
    this._frame             = 0;
    this._playing           = false;
    this._sessionId         = null;
    this._useNativeEngine   = false;

    this._opts.onStatus?.('Opening media…');

    // Try native engine first (session-cached AVAsset, no spawn overhead)
    const ne = window.pfxPlatform?.nativeEngine;
    if (ne) {
      try {
        const session = await ne.open(filePath);
        this._sessionId       = session.sessionId;
        this._useNativeEngine = true;
        this._info            = session;
        this._fps             = parseFloat(session.fps)      || 24;
        this._totalFrames     = Math.max(1, session.frameCount || Math.round((session.duration || 0) * this._fps));
        this._opts.onStatus?.('HW Decode (AVFoundation)');

        // Trigger proxy creation for 4K+/ProRes/high-bitrate if needed
        if (session.needsProxy && session.sessionId) {
          ne.proxyCreate(session.sessionId, { width: 960 }).catch(() => {});
        }
        await this._renderFrame(0);
        return { ok: true, info: session, decoder: 'PFXNativeEngine', hwDecode: true };
      } catch (err) {
        console.warn('[NativeAVPlayer] native engine open failed, falling back:', err.message);
        this._sessionId       = null;
        this._useNativeEngine = false;
      }
    }

    // Legacy avf_bridge fallback
    this._opts.onStatus?.('Probing ProRes…');
    const info = await window.pfxPlatform.media.getInfo({ path: filePath });
    if (!info?.ok && info?.ok !== undefined) {
      throw new Error(info?.error || 'avf_bridge getInfo failed');
    }
    this._info        = info;
    this._fps         = parseFloat(info?.fps)      || 24;
    const dur         = parseFloat(info?.duration) || 0;
    this._totalFrames = Math.max(1, Math.round(this._fps * dur));

    this._opts.onStatus?.('Direct Playback');
    await this._renderFrame(0);
    return { ok: true, info, decoder: 'avf_bridge' };
  }

  play() {
    if (this._playing || !this._filePath) return;
    this._playing  = true;
    this._lastTick = performance.now();
    this._rafId    = requestAnimationFrame(this._tick.bind(this));
  }

  pause() {
    this._playing = false;
    if (this._rafId) { cancelAnimationFrame(this._rafId); this._rafId = null; }
  }

  async seekFrame(frame) {
    const f = Math.max(0, Math.min(Math.round(frame), this._totalFrames - 1));
    this._frame = f;
    await this._renderFrame(f);
  }

  async seekTime(seconds) {
    await this.seekFrame(Math.round(seconds * this._fps));
  }

  async stepForward(n = 1) {
    await this.seekFrame(this._frame + n);
  }

  async stepBack(n = 1) {
    await this.seekFrame(this._frame - n);
  }

  close() {
    this.pause();
    // Release native engine session so AVAsset is freed on the Swift side
    if (this._sessionId && window.pfxPlatform?.nativeEngine) {
      window.pfxPlatform.nativeEngine.close(this._sessionId).catch(() => {});
    }
    this._filePath        = null;
    this._info            = null;
    this._frame           = 0;
    this._totalFrames     = 0;
    this._sessionId       = null;
    this._useNativeEngine = false;
  }

  // ── Internal ──────────────────────────────────────────────────────────────────

  async _tick(now) {
    if (!this._playing) return;

    const msPerFrame = 1000 / this._fps;
    if (now - this._lastTick >= msPerFrame) {
      this._lastTick = now;
      if (this._frame >= this._totalFrames - 1) {
        this.pause();
        this._opts.onPlayEnd?.();
        return;
      }
      this._frame++;
      await this._renderFrame(this._frame);
    }

    if (this._playing) {
      this._rafId = requestAnimationFrame(this._tick.bind(this));
    }
  }

  async _renderFrame(frame) {
    if (!this._filePath || this._busy) return;
    this._busy = true;
    try {
      let imageDataUrl;

      if (this._useNativeEngine && this._sessionId) {
        // Fast path: session-cached AVAssetImageGenerator, ~5ms vs ~100ms for spawn
        const r = await window.pfxPlatform.nativeEngine.frameExtract(
          this._sessionId, frame, this._canvas.width || 1280, 0.88
        );
        imageDataUrl = r?.imageDataUrl || r?.dataUrl;
      } else {
        // Legacy fallback: avf_bridge spawn per frame
        const r = await window.pfxPlatform.media.getStill({
          path:        this._filePath,
          frame,
          outputWidth: this._canvas.width || 1280,
        });
        imageDataUrl = r?.imageDataUrl;
      }

      if (imageDataUrl) {
        await this._drawDataUrl(imageDataUrl);
      }
      this._opts.onTimeUpdate?.(frame, this._fps);
    } catch (e) {
      // On native engine failure, try falling back to legacy
      if (this._useNativeEngine) {
        console.warn('[NativeAVPlayer] native engine frame extract failed, switching to avf_bridge:', e.message);
        this._useNativeEngine = false;
        this._sessionId       = null;
      } else {
        this._opts.onError?.(`Frame decode error: ${e.message}`);
      }
    } finally {
      this._busy = false;
    }
  }

  _drawDataUrl(dataUrl) {
    return new Promise((resolve) => {
      const img  = new Image();
      img.onload = () => {
        this._ctx.drawImage(img, 0, 0, this._canvas.width, this._canvas.height);
        resolve();
      };
      img.onerror = resolve;
      img.src     = dataUrl;
    });
  }
}

/**
 * Create and mount a canvas overlay on top of a <video> element.
 * Returns the canvas element.
 */
export function mountNativeCanvas(videoEl) {
  const existing = videoEl._pfxNativeCanvas;
  if (existing) return existing;

  const canvas = document.createElement('canvas');
  canvas.className = 'pfx-native-av-canvas';

  // Match the video element's layout position — cover the same area
  const style = canvas.style;
  style.position   = 'absolute';
  style.inset      = '0';
  style.width      = '100%';
  style.height     = '100%';
  style.objectFit  = 'contain';
  style.background = '#000';
  style.zIndex     = '2';

  // Insert after the video element so it overlays it
  if (videoEl.parentNode) {
    videoEl.parentNode.insertBefore(canvas, videoEl.nextSibling);
  }

  // Keep canvas bitmap dimensions in sync with its display size
  const ro = new ResizeObserver(([entry]) => {
    const { width, height } = entry.contentRect;
    if (width > 0 && height > 0) {
      canvas.width  = Math.round(width  * (window.devicePixelRatio || 1));
      canvas.height = Math.round(height * (window.devicePixelRatio || 1));
    }
  });
  ro.observe(canvas);
  canvas._pfxRO = ro;

  // Initial size
  const rect = videoEl.getBoundingClientRect();
  canvas.width  = Math.max(1280, Math.round(rect.width  * (window.devicePixelRatio || 1)));
  canvas.height = Math.max(720,  Math.round(rect.height * (window.devicePixelRatio || 1)));

  videoEl._pfxNativeCanvas = canvas;
  return canvas;
}

/**
 * Remove the native canvas and stop its ResizeObserver.
 */
export function unmountNativeCanvas(videoEl) {
  const canvas = videoEl?._pfxNativeCanvas;
  if (!canvas) return;
  canvas._pfxRO?.disconnect();
  canvas._pfxRO = null;
  canvas.parentNode?.removeChild(canvas);
  videoEl._pfxNativeCanvas = null;
}
