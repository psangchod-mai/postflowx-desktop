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
    // Let the canvas's ResizeObserver (mountNativeCanvas) find us so it can
    // repaint the current frame after a resize — resizing clears the bitmap, and
    // without a repaint the canvas goes black (e.g. when the pane lays out after
    // a project load). See repaint() + the ResizeObserver below.
    try { canvas._pfxEngine = this; } catch {}
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
        // Verify the first frame actually paints — if it can't, reject so the
        // caller can fall back to the Chromium/proxy path instead of showing a
        // silent black canvas.
        if (!(await this._renderFrame(0))) throw new Error('AVFoundation rendered no first frame');
        return { ok: true, info: session, decoder: this.decoder, hwDecode: this._useNativeEngine };
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
    if (!(await this._renderFrame(0))) throw new Error('avf_bridge rendered no first frame');
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

  // Re-paint the current frame (used after a canvas resize wipes the bitmap).
  repaint() { if (this._filePath) this._renderFrame(this._frame); }

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

  // Pull one frame's data URL from whichever decoder is active. Throws on a hard
  // decoder error; returns null when the decoder produced no image.
  async _extractFrame(frame) {
    const w = this._canvas.width || 1280;
    if (this._useNativeEngine && this._sessionId) {
      const r = await window.pfxPlatform.nativeEngine.frameExtract(this._sessionId, frame, w, 0.88);
      return r?.imageDataUrl || r?.dataUrl || null;
    }
    const r = await window.pfxPlatform.media.getStill({ path: this._filePath, frame, outputWidth: w });
    if (r && r.ok === false) throw new Error(r.error || 'avf_bridge getStill failed');
    return r?.imageDataUrl || r?.dataUrl || null;
  }

  // Render `frame` to the canvas. Returns true only if a pixel actually landed.
  // Self-heals: if the fast native-engine path yields nothing (or throws), it
  // drops to the avf_bridge spawn path and retries the SAME frame — previously a
  // failed fast-path frame was silently dropped, leaving the canvas black (and,
  // when paused, forever, since no later tick would repaint it).
  async _renderFrame(frame) {
    if (!this._filePath || this._busy) return false;
    this._busy = true;
    let drawn = false;
    try {
      let url = null;
      try {
        url = await this._extractFrame(frame);
      } catch (e) {
        if (!this._useNativeEngine) throw e;   // avf_bridge itself failed — bubble up
        console.warn('[NativeAVPlayer] native engine threw, switching to avf_bridge:', e.message);
        this._useNativeEngine = false; this._sessionId = null;
      }
      // Fast path produced no image → retry the same frame via avf_bridge.
      if (!url && this._useNativeEngine) {
        console.warn('[NativeAVPlayer] native engine returned no frame; retrying via avf_bridge, frame', frame);
        this._useNativeEngine = false; this._sessionId = null;
      }
      if (!url) url = await this._extractFrame(frame);

      if (url) drawn = await this._drawDataUrl(url);
      if (!drawn) this._opts.onError?.(`Frame ${frame}: decoder produced no renderable image`);
      this._opts.onTimeUpdate?.(frame, this._fps);
    } catch (e) {
      this._opts.onError?.(`Frame decode error: ${e.message}`);
    } finally {
      this._busy = false;
    }
    return drawn;
  }

  // Paint a data URL to the canvas. Resolves to true only on a successful draw.
  // Hardened so a bad/slow image can never deadlock playback: re-acquires a lost
  // 2D context, guards zero-size canvases, catches draw exceptions, and always
  // resolves (a watchdog timeout releases _busy even if the Image never fires).
  _drawDataUrl(dataUrl) {
    return new Promise((resolve) => {
      if (!this._ctx) { try { this._ctx = this._canvas.getContext('2d'); } catch {} }
      const ctx = this._ctx;
      if (!ctx) { resolve(false); return; }
      const img = new Image();
      let settled = false;
      const finish = (ok) => { if (settled) return; settled = true; clearTimeout(t); resolve(ok); };
      const t = setTimeout(() => finish(false), 4000);
      img.onload = () => {
        const cw = this._canvas.width, ch = this._canvas.height;
        if (!(cw > 0 && ch > 0)) { finish(false); return; }
        try { ctx.drawImage(img, 0, 0, cw, ch); finish(true); }
        catch { finish(false); }
      };
      img.onerror = () => finish(false);
      img.src = dataUrl;
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
      // Resizing clears the bitmap — repaint the current frame so the canvas
      // doesn't go black when the pane lays out (e.g. after a project load).
      canvas._pfxEngine?.repaint?.();
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
