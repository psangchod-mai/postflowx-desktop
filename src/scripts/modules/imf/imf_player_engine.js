/**
 * imf_player_engine.js — Renderer-side IMF Direct Playback Engine.
 *
 * Consumes the MJPEG stream served by imf_direct_engine.js and renders
 * it to a <canvas> element. Also handles single-frame scrubbing via the
 * /imf/frame/{sessionId}/{frame} HTTP endpoint for frame-accurate seek.
 *
 * Public API:
 *   createIMFPlayer(canvas, opts)  → IMFPlayer instance
 *
 * IMFPlayer:
 *   .openPackage(path)             → { ok, packageId, package }
 *   .validatePackage(cplId?)       → { ok, validation }
 *   .selectCPL(cplId)             → void
 *   .startPlayback(opts?)          → { ok }
 *   .pause()                       → void
 *   .stop()                        → void
 *   .seek(frame)                   → void
 *   .stepForward()                 → void
 *   .stepBack()                    → void
 *   .setRate(rate)                 → void
 *   .dispose()                     → void
 *   .on(event, handler)            → void
 *   .off(event, handler)           → void
 *
 * Events:
 *   'frame'          { frame, totalFrames, tc }
 *   'state'          { state: 'playing'|'paused'|'stopped'|'ended'|'error' }
 *   'hud'            { engine, cplName, cplId, duration, tc, codec, audioLayout, status }
 *   'validation'     { validation }
 *   'error'          { code, message, fallback: 'proxy'|'resolve'|'external'|null }
 *   'packageLoaded'  { packageId, package }
 *
 * v1 limitations (surfaced as HUD chip):
 *   - Unencrypted packages only
 *   - One CPL at a time
 *   - OPL: read-only inspection
 *   - DV metadata: inspection only (no DV decode)
 */

const _pfx = () => window.pfxPlatform;

// ── IMFPlayer class ────────────────────────────────────────────────────────────

class IMFPlayer {
  constructor(canvas, opts = {}) {
    this._canvas      = canvas;
    this._ctx         = canvas.getContext('2d');
    this._opts        = opts;

    this._packageId   = null;
    this._packageData = null;
    this._cplId       = null;
    this._sessionId   = null;
    this._streamUrl   = null;
    this._frameUrl    = null;
    this._info        = null;       // { fps, totalFrames, codec, ... }

    this._state       = 'stopped';
    this._currentFrame= 0;
    this._rate        = 1;
    // Playback quality (C-RT1): full-res can't sustain real-time J2K decode on CPU
    // (see PostFlowX_CRT0_Audit.md), so the companion can decode at a reduced J2K
    // level (-lowres) during continuous play. 'auto'=half-res by default for smooth
    // playback; scrub/pause always render full-res. full|half|quarter|auto.
    this._quality     = opts.quality || 'auto';
    this._disposed    = false;

    this._streamReader  = null;
    this._streamAbort   = null;
    this._rafHandle     = null;
    this._lastRafTime   = 0;
    this._pendingFrames = [];       // queue of decoded ImageBitmaps
    this._scrubTimer    = null;

    this._handlers = new Map();
  }

  // ── Event emitter ────────────────────────────────────────────────────────

  on(event, fn) {
    if (!this._handlers.has(event)) this._handlers.set(event, new Set());
    this._handlers.get(event).add(fn);
  }

  off(event, fn) {
    this._handlers.get(event)?.delete(fn);
  }

  _emit(event, data) {
    for (const fn of (this._handlers.get(event) || [])) {
      try { fn(data); } catch {}
    }
  }

  // ── Package operations ────────────────────────────────────────────────────

  async openPackage(inputPath) {
    if (this._disposed) return { ok: false, error: 'disposed' };
    const r = await _pfx().imfEngine.openPackage(inputPath);
    if (!r.ok) return r;
    this._packageId   = r.packageId;
    this._packageData = r.package;

    // Auto-select the first (active) CPL
    const cpls = r.package.cpls || [];
    this._cplId = r.package.activeCplId || cpls[0]?.id || null;

    this._emit('packageLoaded', { packageId: r.packageId, package: r.package });
    return r;
  }

  selectCPL(cplId) {
    this._cplId = cplId;
  }

  async validatePackage(cplId) {
    if (!this._packageId) return { ok: false, error: 'No package loaded' };
    const r = await _pfx().imfEngine.validatePackage(this._packageId, cplId || this._cplId);
    if (r.ok) this._emit('validation', { validation: r.validation });
    return r;
  }

  // ── Playback control ──────────────────────────────────────────────────────

  async startPlayback(opts = {}) {
    if (this._disposed) return { ok: false, error: 'disposed' };
    if (!this._packageId || !this._cplId) {
      return { ok: false, error: 'No package or CPL selected', code: 'NO_PACKAGE' };
    }

    // If already playing, stop first and restart.
    if (this._sessionId) await this._stopSession();

    const r = await _pfx().imfEngine.startPlayback(
      this._packageId, this._cplId,
      { startFrame: this._currentFrame, outputWidth: opts.outputWidth || 1920,
        quality: this._quality, ...opts }
    );
    if (!r.ok) {
      this._emitError(r.code || 'START_FAILED', r.error || 'Playback start failed');
      return r;
    }

    this._sessionId = r.sessionId;
    this._streamUrl = r.streamUrl;
    this._frameUrl  = r.frameUrl;
    this._info      = r.info;

    this._setState('playing');
    this._emitHUD();
    this._startMJPEGConsumer();
    this._startRAFLoop();

    return { ok: true };
  }

  pause() {
    if (this._state !== 'playing') return;
    this._stopRAFLoop();
    this._stopMJPEGConsumer();
    this._setState('paused');
    if (this._sessionId) {
      _pfx().imfEngine.controlPlayback(this._sessionId, 'pause');
    }
  }

  stop() {
    this._stopRAFLoop();
    this._stopMJPEGConsumer();
    this._clearPendingFrames();
    this._setState('stopped');
    this._currentFrame = 0;
    if (this._sessionId) {
      _pfx().imfEngine.stopPlayback(this._sessionId);
      this._sessionId = null;
    }
    this._clearCanvas();
  }

  seek(frame) {
    const clamped = Math.max(0, Math.min(frame, (this._info?.totalFrames || 1) - 1));
    this._currentFrame = clamped;

    const wasPlaying = this._state === 'playing';
    if (wasPlaying) {
      this._stopMJPEGConsumer();
      this._clearPendingFrames();
    }

    if (this._sessionId) {
      _pfx().imfEngine.controlPlayback(this._sessionId, 'seek', clamped);
    }

    // For scrubbing: fetch a single frame immediately for visual feedback.
    this._scrubFrame(clamped);

    if (wasPlaying) {
      this._startMJPEGConsumer();
    }

    this._emitFrame(clamped);
  }

  stepForward() {
    this.pause();
    const next = Math.min(this._currentFrame + 1, (this._info?.totalFrames || 1) - 1);
    this._currentFrame = next;
    if (this._sessionId) _pfx().imfEngine.controlPlayback(this._sessionId, 'stepForward');
    this._scrubFrame(next);
    this._emitFrame(next);
  }

  stepBack() {
    this.pause();
    const prev = Math.max(this._currentFrame - 1, 0);
    this._currentFrame = prev;
    if (this._sessionId) _pfx().imfEngine.controlPlayback(this._sessionId, 'stepBack');
    this._scrubFrame(prev);
    this._emitFrame(prev);
  }

  setRate(rate) {
    this._rate = rate;
    if (this._sessionId && this._state === 'playing') {
      _pfx().imfEngine.controlPlayback(this._sessionId, 'setRate', rate);
    }
  }

  // Playback quality / J2K decode level (C-RT1): 'full' | 'half' | 'quarter' | 'auto'.
  // Reduced levels let HD/UHD J2K sustain real-time on CPU. Applied live mid-play;
  // takes effect on the next stream (companion restarts ffmpeg with -lowres N).
  setQuality(q) {
    const allowed = new Set(['full', 'half', 'quarter', 'auto']);
    if (!allowed.has(q)) return;
    this._quality = q;
    if (this._sessionId && this._state === 'playing') {
      _pfx().imfEngine.controlPlayback(this._sessionId, 'quality', q);
    }
  }

  getQuality() { return this._quality; }

  async dispose() {
    this._disposed = true;
    this._stopRAFLoop();
    this._stopMJPEGConsumer();
    this._clearPendingFrames();
    if (this._sessionId) {
      await _pfx().imfEngine.stopPlayback(this._sessionId);
      this._sessionId = null;
    }
  }

  // ── State helpers ─────────────────────────────────────────────────────────

  get state()        { return this._state; }
  get currentFrame() { return this._currentFrame; }
  get totalFrames()  { return this._info?.totalFrames || 0; }
  get fps()          { return this._info?.fps || 24; }
  get packageId()    { return this._packageId; }
  get packageData()  { return this._packageData; }

  _setState(s) {
    this._state = s;
    this._emit('state', { state: s });
  }

  _emitFrame(frame) {
    const tc = _framesToTC(frame, this._info?.fps || 24);
    this._emit('frame', { frame, totalFrames: this._info?.totalFrames || 0, tc });
  }

  _emitHUD() {
    if (!this._info) return;
    const cpl = (this._packageData?.cpls || []).find(c => c.id === this._cplId);
    const fps  = this._info.fps || 24;
    const totalSec = (this._info.totalFrames || 0) / fps;
    const audioSeqs = cpl?.audioSequences || [];
    const audioLayout = audioSeqs.length > 0
      ? audioSeqs.map(s => s.seqType.replace('Sequence', '').trim()).join(', ')
      : '—';

    let status = 'IMF Direct';
    if (cpl?.picDesc?.isHTJ2K) status += ' · HTJ2K';
    if (cpl?.isSupplemental)   status += ' · Supplemental CPL';

    const limitations = [];
    if (cpl?.picDesc?.isHTJ2K) limitations.push('HTJ2K decode via FFmpeg');
    limitations.push('v1: unencrypted · single CPL · OPL read-only');

    this._emit('hud', {
      engine:      'IMF Direct',
      cplName:     cpl?.cplPath ? cpl.cplPath.split('/').pop() : this._cplId,
      cplId:       this._cplId,
      duration:    _secToTC(totalSec, fps),
      tc:          _framesToTC(this._currentFrame, fps),
      codec:       this._info.codec || '–',
      resolution:  this._info.resolution ? `${this._info.resolution.w}×${this._info.resolution.h}` : '–',
      transfer:    this._info.transfer || '–',
      audioLayout,
      status,
      limitations,
    });
  }

  _emitError(code, message) {
    let fallback = null;
    if (code === 'NO_FFMPEG' || code === 'NO_IMF_DEMUX') fallback = 'proxy';
    else if (code === 'UNSUPPORTED_CODEC')               fallback = 'resolve';
    else if (code === 'ENCRYPTED')                       fallback = 'external';

    this._emit('error', { code, message, fallback });
    this._setState('error');
  }

  // ── MJPEG consumer ────────────────────────────────────────────────────────

  _startMJPEGConsumer() {
    if (this._streamAbort) { try { this._streamAbort.abort(); } catch {} }
    this._streamAbort = new AbortController();
    const signal = this._streamAbort.signal;
    const url = this._streamUrl;
    if (!url) return;

    (async () => {
      let buf = new Uint8Array(0);
      try {
        const res = await fetch(url, { signal, cache: 'no-store' });
        const reader = res.body.getReader();

        while (!this._disposed && this._state === 'playing') {
          let chunk;
          try {
            const { done, value } = await reader.read();
            if (done || this._disposed) break;
            chunk = value;
          } catch (e) {
            if (e.name !== 'AbortError') {
              console.warn('[IMFPlayer] MJPEG stream error:', e.message);
            }
            break;
          }

          // Append and scan for complete JPEGs.
          buf = _concat(buf, chunk);

          let start = 0;
          while (true) {
            const soi = _findBytes(buf, start, 0xFF, 0xD8);
            if (soi < 0) { buf = buf.slice(Math.max(0, start - 1)); break; }
            const eoi = _findBytes(buf, soi + 2, 0xFF, 0xD9);
            if (eoi < 0) { buf = buf.slice(soi); break; }

            const jpegBytes = buf.slice(soi, eoi + 2);
            const blob = new Blob([jpegBytes], { type: 'image/jpeg' });
            createImageBitmap(blob).then((bm) => {
              if (this._disposed) { bm.close(); return; }
              if (this._pendingFrames.length >= 60) {
                const old = this._pendingFrames.shift();
                old.close();
              }
              this._pendingFrames.push(bm);
            }).catch(() => {});

            start = eoi + 2;
          }
        }
        try { reader.cancel(); } catch {}
      } catch (e) {
        if (e.name !== 'AbortError' && !this._disposed) {
          console.warn('[IMFPlayer] stream fetch failed:', e.message);
        }
      }
    })();
  }

  _stopMJPEGConsumer() {
    if (this._streamAbort) {
      try { this._streamAbort.abort(); } catch {}
      this._streamAbort = null;
    }
  }

  // ── RAF render loop ───────────────────────────────────────────────────────

  _startRAFLoop() {
    if (this._rafHandle) return;
    const loop = (ts) => {
      if (this._disposed || this._state !== 'playing') {
        this._rafHandle = null;
        return;
      }
      this._rafHandle = requestAnimationFrame(loop);

      const frameMs  = 1000 / (this.fps * (this._rate || 1));
      const elapsed  = ts - this._lastRafTime;
      if (elapsed < frameMs * 0.85) return;

      const bm = this._pendingFrames.shift();
      if (!bm) return;

      this._ctx.drawImage(bm, 0, 0, this._canvas.width, this._canvas.height);
      bm.close();
      this._lastRafTime = ts;
      this._currentFrame++;
      this._emitFrame(this._currentFrame);
      this._emitHUD();
    };
    this._rafHandle = requestAnimationFrame(loop);
  }

  _stopRAFLoop() {
    if (this._rafHandle) {
      cancelAnimationFrame(this._rafHandle);
      this._rafHandle = null;
    }
  }

  _clearPendingFrames() {
    for (const bm of this._pendingFrames) { try { bm.close(); } catch {} }
    this._pendingFrames = [];
  }

  // ── Single-frame scrub ────────────────────────────────────────────────────

  _scrubFrame(frame) {
    clearTimeout(this._scrubTimer);
    if (!this._packageId || !this._cplId) return;

    this._scrubTimer = setTimeout(async () => {
      try {
        const url = this._frameUrl
          ? `${this._frameUrl}/${frame}`
          : null;

        let jpegBuf;
        if (url && this._sessionId) {
          const res = await fetch(url, { cache: 'no-store' });
          if (res.ok) {
            const ab = await res.arrayBuffer();
            jpegBuf = new Uint8Array(ab);
          }
        }

        if (!jpegBuf) {
          // Fallback: IPC single-frame extraction
          const r = await _pfx().imfEngine.getFrame(this._packageId, this._cplId, frame);
          if (!r.ok || !r.imageDataUrl) return;
          const img = new Image();
          img.onload = () => {
            this._ctx.drawImage(img, 0, 0, this._canvas.width, this._canvas.height);
          };
          img.src = r.imageDataUrl;
          return;
        }

        const blob = new Blob([jpegBuf], { type: 'image/jpeg' });
        const bm   = await createImageBitmap(blob);
        this._ctx.drawImage(bm, 0, 0, this._canvas.width, this._canvas.height);
        bm.close();
      } catch (e) {
        console.warn('[IMFPlayer] scrub frame failed:', e.message);
      }
    }, 30); // 30ms debounce for scrubber drag
  }

  async _stopSession() {
    this._stopRAFLoop();
    this._stopMJPEGConsumer();
    this._clearPendingFrames();
    if (this._sessionId) {
      await _pfx().imfEngine.stopPlayback(this._sessionId);
      this._sessionId = null;
    }
  }

  _clearCanvas() {
    this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height);
  }
}

// ── Factory ────────────────────────────────────────────────────────────────────

export function createIMFPlayer(canvas, opts) {
  return new IMFPlayer(canvas, opts);
}

// ── Timecode utilities ─────────────────────────────────────────────────────────

function _framesToTC(frame, fps) {
  const totalSec = frame / fps;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const f = Math.floor(frame % fps);
  return `${_z(h)}:${_z(m)}:${_z(s)}:${_z(f)}`;
}

function _secToTC(totalSec, fps) {
  return _framesToTC(Math.floor(totalSec * fps), fps);
}

function _z(n) { return String(n).padStart(2, '0'); }

// ── Byte helpers ───────────────────────────────────────────────────────────────

function _concat(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function _findBytes(buf, from, b0, b1) {
  for (let i = from; i < buf.length - 1; i++) {
    if (buf[i] === b0 && buf[i + 1] === b1) return i;
  }
  return -1;
}
