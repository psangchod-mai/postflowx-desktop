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
    this._lastRenderedFrame = -1;
    this._opening     = false;
    // Native engine session — null means fall back to legacy avf_bridge getStill
    this._sessionId   = null;
    this._useNativeEngine = false;
    // Bumped by seekFrame()/_tick() right before they request a frame render;
    // _renderFrame() checks it after the extraction await to detect that a
    // newer seek/tick superseded it, so a slow stale extraction can't paint
    // the wrong frame or fire onTimeUpdate with a frame number that
    // contradicts this._frame.
    this._loadSeq     = 0;
  }

  get currentFrame()  { return this._frame; }
  get currentTime()   { return this._fps > 0 ? this._frame / this._fps : 0; }
  get duration()      { return this._fps > 0 ? this._totalFrames / this._fps : 0; }
  get fps()           { return this._fps; }
  get info()          { return this._info; }
  get isPlaying()     { return this._playing; }
  get decoder()       { return this._useNativeEngine ? 'PFXNativeEngine' : 'avf_bridge'; }

  async open(filePath) {
    this._opening = true;
    try {
      this._filePath          = filePath;
      this._frame             = 0;
      this._playing           = false;
      this._sessionId         = null;
      this._useNativeEngine   = false;

      this._opts.onStatus?.('Opening media…');

      // Pulls Prep/Trailer reference playback can explicitly prefer the
      // one-shot AVFoundation bridge. It is slower than the session service but
      // has fewer moving parts and is the reliable path for direct ProRes on
      // machines where the persistent service is installed yet not responding.
      if (this._opts.preferBridge && window.pfxPlatform?.media?.getInfo) {
        try {
          return await this._openBridge(filePath);
        } catch (err) {
          console.warn('[NativeAVPlayer] direct AVFoundation bridge failed, trying session engine:', err.message);
        }
      }

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

          // Verify the first frame actually paints — if it can't, reject so the
          // caller can fall back to the legacy direct AVFoundation bridge instead of showing a
          // silent black canvas.
          if (!(await this._verifyFrame(0))) throw new Error('AVFoundation rendered no first frame');
          return { ok: true, info: session, decoder: this.decoder, hwDecode: this._useNativeEngine };
        } catch (err) {
          console.warn('[NativeAVPlayer] native engine open failed, falling back:', err.message);
          this._sessionId       = null;
          this._useNativeEngine = false;
        }
      }

      // Legacy avf_bridge fallback
      return await this._openBridge(filePath);
    } finally {
      this._opening = false;
    }
  }

  async _openBridge(filePath) {
      this._opts.onStatus?.('Probing ProRes…');
      const info = await window.pfxPlatform.media.getInfo({ path: filePath });
      // Throw on a null/failed probe (bridge returned nothing) or an explicit ok:false.
      // A plain info object with no `ok` field is still treated as success.
      if (!info || info.ok === false) {
        throw new Error(info?.error || 'avf_bridge getInfo failed');
      }
      this._info        = info;
      this._fps         = parseFloat(info?.fps)      || 24;
      const dur         = parseFloat(info?.duration) || 0;
      this._totalFrames = Math.max(1, Math.round(this._fps * dur));

      this._opts.onStatus?.('Direct Playback');
      if (!(await this._verifyFrame(0))) throw new Error('avf_bridge rendered no first frame');
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
    const seq = ++this._loadSeq;
    await this._renderFrame(f, seq);
  }

  // Re-paint the current frame (used after a canvas resize wipes the bitmap).
  repaint() {
    // ResizeObserver can fire while open() is verifying frame 0. Starting a
    // second render in that narrow window used to make open() see `_busy` and
    // treat the valid ProRes decode as a failure. Repaint is opportunistic, so
    // let the in-flight render finish instead of competing with it.
    if (this._filePath && !this._opening && !this._busy) this._renderFrame(this._frame);
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

  // Return a freshly decoded image for consumers that need an immutable still
  // (notably Annotate). Reading canvas.toDataURL() is layout-sensitive because
  // ResizeObserver clears the bitmap whenever the monitor resizes; decoding the
  // current frame through AVFoundation guarantees the modal receives the real
  // ProRes picture even if its opening layout repaints the player underneath.
  async captureCurrentFrameDataUrl(timeoutMs = 8000) {
    const frame = Math.max(0, Math.min(Math.round(this._frame), this._totalFrames - 1));
    return await this.captureFrameDataUrl(frame, timeoutMs);
  }

  // Decode an immutable still for an explicit media frame without moving the
  // monitor playhead. Pull Prep uses this for marker thumbnails, so reviewing a
  // shot never makes the Program Monitor jump to a background capture position.
  async captureFrameDataUrl(frame, timeoutMs = 8000) {
    if (!this._filePath) return null;
    const deadline = Date.now() + Math.max(250, Number(timeoutMs) || 8000);
    while (this._busy && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 16));
    }
    if (this._busy) throw new Error('AVFoundation frame capture timed out');
    const f = Math.max(0, Math.min(Math.round(Number(frame) || 0), this._totalFrames - 1));
    return await this._extractFrame(f);
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
    this._lastRenderedFrame = -1;
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
      const seq = ++this._loadSeq;
      await this._renderFrame(this._frame, seq);
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

  // open() must distinguish "another render is already painting frame 0" from
  // "the decoder produced no image". The canvas ResizeObserver can request a
  // repaint immediately after the engine is attached, before open() reaches its
  // own first-frame check. Wait for that one render, accept it when it painted
  // the requested frame, otherwise perform the explicit verification render.
  async _verifyFrame(frame, timeoutMs = 35000) {
    if (this._busy) {
      const deadline = Date.now() + timeoutMs;
      while (this._busy && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 16));
      }
      if (this._lastRenderedFrame === frame) return true;
    }
    const drawn = await this._renderFrame(frame);
    return drawn || this._lastRenderedFrame === frame;
  }

  // Render `frame` to the canvas. Returns true only if a pixel actually landed.
  // Self-heals: if the fast native-engine path yields nothing (or throws), it
  // drops to the avf_bridge spawn path and retries the SAME frame — previously a
  // failed fast-path frame was silently dropped, leaving the canvas black (and,
  // when paused, forever, since no later tick would repaint it).
  async _renderFrame(frame, seq) {
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

      // A newer seekFrame()/_tick() call bumped _loadSeq while we were awaiting
      // the frame extraction above — the user has already moved on to a
      // different frame, so painting/reporting this one now would contradict
      // this._frame and the caller that superseded us.
      if (seq !== undefined && seq !== this._loadSeq) return false;

      if (url) drawn = await this._drawDataUrl(url);
      if (drawn) this._lastRenderedFrame = frame;
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
        const iw = Number(img.naturalWidth || img.width || 0);
        const ih = Number(img.naturalHeight || img.height || 0);
        if (!(iw > 0 && ih > 0)) { finish(false); return; }
        // Canvas ignores CSS object-fit. Calculate a real contain rectangle so
        // 2.39:1, 1.85:1, 16:9, and portrait sources retain their native aspect
        // ratio inside the NLE monitor, with clean black letter/pillar boxing.
        const scale = Math.min(cw / iw, ch / ih);
        const dw = Math.max(1, Math.round(iw * scale));
        const dh = Math.max(1, Math.round(ih * scale));
        const dx = Math.round((cw - dw) / 2);
        const dy = Math.round((ch - dh) / 2);
        try {
          ctx.save?.();
          ctx.fillStyle = '#000';
          ctx.fillRect?.(0, 0, cw, ch);
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, dx, dy, dw, dh);
          ctx.restore?.();
          finish(true);
        }
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
