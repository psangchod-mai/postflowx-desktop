/**
 * mpvPlayer.js — Renderer-side MPV engine controller.
 *
 * Implements the same open/play/pause/seek/step/close interface as NativeAVPlayerEngine.
 * Display is handled by mpv in its own floating window; the canvas receives a status label.
 *
 * Transport commands are forwarded to the main-process mpv_engine via pfx:media IPC.
 */

function _call(type, payload, timeoutMs = 5000) {
  return window.pfxPlatform.media._call(type, payload, timeoutMs);
}

function _drawLabel(canvas, label) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#0c0c14';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#6060a0';
  ctx.font = `${Math.round(canvas.height * 0.04)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, canvas.width / 2, canvas.height / 2);
}

export class MPVPlayerEngine {
  constructor(canvas, opts = {}) {
    this._canvas     = canvas;
    this._opts       = opts;
    this._sessionId  = null;
    this._filePath   = null;
    this._playing    = false;
    this._cachedTime = 0;
    this._cachedDur  = 0;
    this._fps        = Number(opts.fps) > 0 ? Number(opts.fps) : 24;
  }

  get currentFrame()  { return Math.round(this._cachedTime * this._fps); }
  get currentTime()   { return this._cachedTime; }
  get duration()      { return this._cachedDur; }
  get isPlaying()     { return this._playing; }
  get info()          { return null; }

  async open(filePath) {
    this._filePath = filePath;
    this._opts.onStatus?.('Opening MPV…');
    _drawLabel(this._canvas, 'Opening MPV player…');

    const r = await _call('media.mpv.open', { path: filePath }, 15000);
    this._sessionId = r?.sessionId;
    if (!r?.ok || !this._sessionId) throw new Error(r?.error || 'MPV open failed');

    // Fetch duration after open
    try {
      const d = await _call('media.mpv.getDuration', { sessionId: this._sessionId });
      this._cachedDur = d?.duration ?? 0;
    } catch {}

    this._opts.onStatus?.('Playing via MPV ↗');
    _drawLabel(this._canvas, '▶  Playing in MPV window  ↗');
    this._opts.onTimeUpdate?.(0, this._fps);
    return { ok: true };
  }

  async play() {
    if (!this._sessionId) return;
    await _call('media.mpv.play', { sessionId: this._sessionId });
    this._playing = true;
    this._opts.onStatus?.('Playing via MPV ↗');
  }

  async pause() {
    if (!this._sessionId) return;
    await _call('media.mpv.pause', { sessionId: this._sessionId });
    this._playing = false;
    this._opts.onStatus?.('Paused — MPV ↗');
  }

  async seekFrame(frame, fps) {
    if (!this._sessionId) return;
    const rate = fps > 0 ? fps : this._fps;
    const secs = rate > 0 ? frame / rate : 0;
    await this.seekTime(secs);
  }

  async seekTime(seconds) {
    if (!this._sessionId) return;
    await _call('media.mpv.seek', { sessionId: this._sessionId, position: seconds });
    this._cachedTime = seconds;
    _drawLabel(this._canvas, `▶  Playing in MPV window  ↗\n${seconds.toFixed(2)}s`);
    this._opts.onTimeUpdate?.(Math.round(seconds * this._fps), this._fps);
  }

  async stepForward(n = 1) {
    if (!this._sessionId) return;
    for (let i = 0; i < n; i++) {
      await _call('media.mpv.stepForward', { sessionId: this._sessionId });
    }
    try {
      const r = await _call('media.mpv.getTime', { sessionId: this._sessionId });
      this._cachedTime = r?.time ?? this._cachedTime;
    } catch {}
  }

  async stepBack(n = 1) {
    if (!this._sessionId) return;
    for (let i = 0; i < n; i++) {
      await _call('media.mpv.stepBack', { sessionId: this._sessionId });
    }
    try {
      const r = await _call('media.mpv.getTime', { sessionId: this._sessionId });
      this._cachedTime = r?.time ?? this._cachedTime;
    } catch {}
  }

  close() {
    if (this._sessionId) {
      _call('media.mpv.close', { sessionId: this._sessionId }).catch(() => {});
      this._sessionId = null;
    }
    this._playing  = false;
    this._filePath = null;
  }
}
