// PostFlowX – VFX Reviews Virtual Timeline Player
// Uses 2 <video> elements for smoother clip-to-clip playback.

export class ReviewPlayer {
  /**
   * @param {{videoA: HTMLVideoElement, videoB: HTMLVideoElement, store: any, onError?: (msg:string)=>void, onProResDetected?: (info:{clipId:string,name:string})=>void}} opts
   */
  constructor({ videoA, videoB, store, onError, onProResDetected }) {
    this.videoA = videoA;
    this.videoB = videoB;
    this.store = store;
    this.onError = onError || (() => {});
    this.onProResDetected = onProResDetected || null;

    this.active = videoA;
    this.standby = videoB;

    this._raf = 0;
    this._seeking = false;
    this._lastTick = 0;
    this._loadSeq = 0;
    this._switching = false;

    this._bindVideo(this.videoA);
    this._bindVideo(this.videoB);

    // Default setup
    for (const v of [this.videoA, this.videoB]) {
      v.preload = 'auto';
      v.playsInline = true;
      v.controls = false;
      v.muted = false;
      v.volume = 1;
      // Theme CSS may set videos to opacity:0 by default.
      // We will force the active viewer to opacity:1.
      v.style.opacity = '0';
    }

    this._applyVisibility();
  }

  /**
   * Replace a clip's source URL with a native streaming URL (e.g. localhost ProRes transcode).
   * Call this after receiving PRORES_STREAM_READY from the background service worker.
   * @param {string} clipId
   * @param {string} streamUrl  e.g. "http://localhost:8080/stream.mp4"
   */
  updateClipStream(clipId, streamUrl) {
    this.store.updateClip(clipId, { url: streamUrl, canPlay: true, codecHint: 'stream' });
  }

  destroy() {
    this._loadSeq++;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    try { this.active.pause(); } catch {}
    try { this.standby.pause(); } catch {}
    try { this._unbindVideo(this.videoA); } catch {}
    try { this._unbindVideo(this.videoB); } catch {}
    // Do not revoke URLs here: store owns them
  }

  _bindVideo(v) {
    const onError = () => {
      const err = v.error;
      const msg = err ? `Video error (code ${err.code})` : 'Video error';
      this.onError(msg);
    };
    const onSeeking = () => (this._seeking = true);
    const onSeeked = () => (this._seeking = false);
    v.addEventListener('error', onError);
    v.addEventListener('seeking', onSeeking);
    v.addEventListener('seeked', onSeeked);
    // Store bound handlers for cleanup
    if (!this._boundHandlers) this._boundHandlers = new WeakMap();
    this._boundHandlers.set(v, { onError, onSeeking, onSeeked });
  }

  _unbindVideo(v) {
    const h = this._boundHandlers && this._boundHandlers.get(v);
    if (!h) return;
    v.removeEventListener('error', h.onError);
    v.removeEventListener('seeking', h.onSeeking);
    v.removeEventListener('seeked', h.onSeeked);
    this._boundHandlers.delete(v);
  }

  _applyVisibility() {
    // Only show active video
    this.videoA.style.display = this.active === this.videoA ? 'block' : 'none';
    this.videoB.style.display = this.active === this.videoB ? 'block' : 'none';

    // Force visibility for active video (inline style wins over CSS)
    this.videoA.style.opacity = this.active === this.videoA ? '1' : '0';
    this.videoB.style.opacity = this.active === this.videoB ? '1' : '0';
  }

  _swapVideos() {
    const tmp = this.active;
    this.active = this.standby;
    this.standby = tmp;
    this._applyVisibility();
  }

  _sameSource(video, url) {
    const cur = String(video?.currentSrc || video?.src || '');
    const want = String(url || '');
    if (!cur || !want) return false;
    if (cur === want) return true;
    // Substring containment (not used above) falsely matches distinct clips
    // whenever one URL is a literal prefix of the other, e.g.
    // "...?clip=clip1" vs "...?clip=clip10". Resolve both to absolute URLs
    // and compare exactly instead.
    try {
      return new URL(cur, document.baseURI).href === new URL(want, document.baseURI).href;
    } catch {
      return false;
    }
  }

  _setCurrentTimeSafe(video, startTime = 0) {
    if (!video) return;
    const dur = Number(video.duration);
    const end = Number.isFinite(dur) && dur > 0 ? Math.max(0, dur - 0.001) : Infinity;
    const t = Math.max(0, Math.min(Number(startTime) || 0, end));
    try { video.currentTime = t; } catch {}
  }

  async _loadVideo(video, url, startTime = 0) {
    return new Promise((resolve) => {
      let gotData = false;
      let gotSeek = false;
      const wantSeek = (Number(startTime) || 0) > 0;
      let settled = false;

      const done = (ok) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (ok) {
          try { video.style.opacity = '1'; } catch {}
        }
        resolve(ok);
      };

      // Safety net: if loadedmetadata or seeked never fires (video detached mid-seek,
      // browser-internal skip, network stall with no error event), the promise would
      // hang forever — _loadSeq only guards code *after* the await, so a hung
      // _loadVideo permanently suspends loadAtGlobalTime and freezes the player.
      const _loadTimeout = setTimeout(() => done(false), 8000);

      const cleanup = () => {
        clearTimeout(_loadTimeout);
        try { video.removeEventListener('loadedmetadata', onMeta); } catch {}
        try { video.removeEventListener('loadeddata', onData); } catch {}
        try { video.removeEventListener('seeked', onSeeked); } catch {}
        try { video.removeEventListener('error', onErr); } catch {}
      };

      const maybeDone = () => {
        if (!gotData) return;
        if (wantSeek && !gotSeek) return;
        done(true);
      };

      const onMeta = () => {
        try {
          // Pause -> seek helps ensure a frame is available when we show it.
          try { video.pause(); } catch {}
          this._setCurrentTimeSafe(video, startTime);
          if (!wantSeek) gotSeek = true;
        } catch {
          gotSeek = true;
        }
        maybeDone();
      };

      const onSeeked = () => {
        gotSeek = true;
        maybeDone();
      };

      const onData = () => {
        // First frame is available.
        gotData = true;
        maybeDone();
      };

      const onErr = () => done(false);

      try { video.addEventListener('loadedmetadata', onMeta, { once: true }); } catch {}
      try { video.addEventListener('loadeddata', onData, { once: true }); } catch {}
      try { video.addEventListener('seeked', onSeeked, { once: true }); } catch {}
      try { video.addEventListener('error', onErr, { once: true }); } catch {}

      // Hide while switching sources to avoid flash.
      try { video.style.opacity = '0'; } catch {}
      try { video.src = url; } catch {}
      try { video.load(); } catch { done(false); }
    });
  }

  /**
   * Probe duration + codec support.
   * Accepts either a V1 segment index (number) or a clipId (string).
   */
  async ensureClipMetadata(indexOrClipId) {
    let clipId = null;
    let url = '';
    let name = '';
    let prevDur = 0;

    let codecHint = '';
    if (typeof indexOrClipId === 'number') {
      const seg = this.store.state.segments[indexOrClipId];
      if (!seg) return;
      clipId = seg.clipId;
      url = seg.url;
      // For split V1 segments, seg.durationSec is a sub-range. We want the *source clip*
      // duration for metadata probing.
      const c = this.store.state.clips.find(x => x.id === seg.clipId) || null;
      name = c?.name || seg.baseName || seg.name;
      prevDur = Number(c?.durationSec || 0) || 0;
      codecHint = c?.codecHint || '';
    } else {
      const c = this.store.state.clips.find(x => x.id === String(indexOrClipId));
      if (!c) return;
      clipId = c.id;
      url = c.url;
      name = c.name;
      prevDur = Number(c.durationSec || 0) || 0;
      codecHint = c.codecHint || '';
    }

    // Probe with standby video to read duration. A concurrent playback-driven
    // load (_switchToNextIfNeeded / loadAtGlobalTime) may repoint this same
    // standby element mid-await — _loadSeq lets us detect that and bail
    // instead of reading/storing the other clip's duration/codec data.
    const seq = ++this._loadSeq;
    const ok = await this._loadVideo(this.standby, url, 0);
    if (seq !== this._loadSeq) return;
    // videoWidth === 0 after successful load means audio played but video codec failed
    // (classic ProRes on Chrome: MOV container demuxes fine, ProRes video black/silent).
    // Skip this check for already-proxied clips (codecHint set by _applyTranscoded).
    const likelyProRes = /\.mov$/i.test(String(name || ''));
    const alreadyProxied = codecHint === 'prores_proxied' || codecHint === 'stream';
    const videoBlind = ok && (this.standby.videoWidth || 0) === 0 && likelyProRes && !alreadyProxied;
    if (!ok || videoBlind) {
      this.store.updateClip(clipId, { canPlay: false, durationSec: 0, codecHint: likelyProRes ? 'prores' : 'unsupported' });
      this.onError(likelyProRes ? `PRORES:${name}` : `Unsupported codec: ${name} (H.264 only)`);
      if (likelyProRes) this.onProResDetected?.({ clipId, name });
      return;
    }
    const dur = Number(this.standby.duration || 0) || 0;
    if (dur > 0 && Math.abs(dur - prevDur) > 0.01) {
      this.store.updateClip(clipId, { durationSec: dur, canPlay: true });
    }
  }

  async loadAtGlobalTime(globalTimeSec, { autoplay = false } = {}) {
    const { index, localTimeSec } = this.store.globalToSegment(globalTimeSec);
    const seg = this.store.state.segments[index];
    if (!seg || !seg.canPlay) return;

    const inSec = Math.max(0, Number(seg.inSec) || 0);
    const startTime = inSec + Math.max(0, Number(localTimeSec) || 0);
    const seq = ++this._loadSeq;

    // Fast path: same media file already loaded.
    if (this._sameSource(this.active, seg.url) && (this.active.readyState || 0) >= 1) {
      this.seekActive(localTimeSec, globalTimeSec, { indexOverride: index, segOverride: seg });
      try { this.preloadNext(index); } catch {}
      if (autoplay) await this.play();
      else if (!this.store.state.isPlaying) this.pause();
      return;
    }

    const standbyReady = this._sameSource(this.standby, seg.url)
      && (this.standby.readyState || 0) >= 2
      && Math.abs((Number(this.standby.currentTime) || 0) - startTime) <= 0.10;

    let ok = true;
    if (standbyReady) {
      this._setCurrentTimeSafe(this.standby, startTime);
    } else {
      ok = await this._loadVideo(this.standby, seg.url, startTime);
    }

    if (seq !== this._loadSeq) return;
    const _likelyProRes = /\.mov$/i.test(String(seg.name || ''));
    const _videoBlind = ok && (this.standby.videoWidth || 0) === 0 && _likelyProRes;
    if (!ok || _videoBlind) {
      this.store.updateClip(seg.clipId, { canPlay: false, codecHint: _likelyProRes ? 'prores' : 'unsupported' });
      this.onError(_likelyProRes ? `PRORES:${seg.name}` : `Unsupported codec: ${seg.name} (H.264 only)`);
      if (_likelyProRes) this.onProResDetected?.({ clipId: seg.clipId, name: seg.name });
      return;
    }

    const dur = Number(this.standby.duration || 0) || 0;
    if (dur > 0) {
      this.store.updateClip(seg.clipId, { durationSec: dur, canPlay: true });
    }

    // Keep the current frame visible until the target clip is ready, then swap.
    try { this.active.pause(); } catch {}
    this._swapVideos();
    this.store.setActiveIndex(index);
    const segLocal = Math.max(0, (Number(this.active.currentTime) || 0) - inSec);
    this.store.setTime(seg.globalStartSec + segLocal, 'time');

    try { this.preloadNext(index); } catch {}

    if (autoplay) {
      await this.play();
    } else {
      this.pause();
    }
  }

  /** Seek inside currently loaded active clip without reloading src. */
  seekActive(localTimeSec, globalTimeSec, { indexOverride = null, segOverride = null } = {}) {
    const idx = Number.isFinite(Number(indexOverride)) ? Number(indexOverride) : this.store.state.activeIndex;
    const seg = segOverride || this.store.state.segments[idx];
    try {
      const inSec = Math.max(0, Number(seg?.inSec) || 0);
      const segEnd = inSec + Math.max(0, Number(seg?.durationSec) || 0);
      const t0 = inSec + Math.max(0, Number(localTimeSec) || 0);
      const t = Math.max(0, Math.min(t0, Math.max(0, segEnd - 0.001)));
      this._setCurrentTimeSafe(this.active, t);
      if (idx !== this.store.state.activeIndex) this.store.setActiveIndex(idx);
    } catch {}
    this.store.setTime(globalTimeSec, 'time');
  }

  getActiveSrc() {
    return this.active?.src || '';
  }

  async preloadNext(activeIndex) {
    const nextIndex = activeIndex + 1;
    const seg = this.store.state.segments[nextIndex];
    if (!seg || !seg.canPlay) return;
    const inSec = Math.max(0, Number(seg.inSec) || 0);
    const ready = this._sameSource(this.standby, seg.url)
      && (this.standby.readyState || 0) >= 2
      && Math.abs((Number(this.standby.currentTime) || 0) - inSec) <= 0.10;
    if (ready) return;
    await this._loadVideo(this.standby, seg.url, inSec);
  }

  _startTickLoop() {
    if (this._raf) return;
    this._lastTick = 0;
    this._tick();
  }

  async play() {
    if (!this.store.state.segments.length) return;
    // Claim exclusive playback (permission check + cross-tab arbitration)
    if (window.PFX_MEDIA_COORD) {
      if (!window.PFX_MEDIA_COORD.claimPlayback()) return; // denied
    }
    try {
      // Reset any leftover J/L shuttle rate so normal play resumes at 1×.
      try { this.active.playbackRate = 1; } catch {}
      if (this.active.paused || this.active.ended) {
        const p = this.active.play();
        if (p && typeof p.catch === 'function') {
          await p.catch(() => {});
        }
      }
      if (!this.store.state.isPlaying) this.store.set({ isPlaying: true }, 'play');
      this._startTickLoop();
    } catch (e) {
      this.onError('Cannot autoplay (browser policy). Click Play.');
    }
  }

  pause() {
    window.PFX_MEDIA_COORD?.releasePlayback?.();
    try { this.active.pause(); } catch {}
    if (this.store.state.isPlaying) this.store.set({ isPlaying: false }, 'play');
    cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  toggle() {
    if (this.store.state.isPlaying) this.pause();
    else this.play();
  }

  async stepFrames(deltaFrames) {
    const fps = Math.max(1, Number(this.store.state.fps) || 24);
    const dt = (Number(deltaFrames) || 0) / fps;
    const total = Math.max(0, Number(this.store.totalDurationSec?.() || 0));
    const maxT = Math.max(0, total - (1 / fps));
    const t = Math.max(0, Math.min((Number(this.store.state.globalTimeSec) || 0) + dt, maxT));
    const { index, localTimeSec } = this.store.globalToSegment(t);
    const seg = this.store.state.segments[index];
    if (seg && this._sameSource(this.active, seg.url) && (this.active.readyState || 0) >= 1) {
      this.seekActive(localTimeSec, t, { indexOverride: index, segOverride: seg });
      return;
    }
    await this.loadAtGlobalTime(t, { autoplay: this.store.state.isPlaying });
  }

  async prevClip() {
    const i = Math.max(0, this.store.state.activeIndex - 1);
    const seg = this.store.state.segments[i];
    if (!seg) return;
    await this.loadAtGlobalTime(seg.globalStartSec, { autoplay: this.store.state.isPlaying });
  }

  async nextClip() {
    const i = Math.min(this.store.state.segments.length - 1, this.store.state.activeIndex + 1);
    const seg = this.store.state.segments[i];
    if (!seg) return;
    await this.loadAtGlobalTime(seg.globalStartSec, { autoplay: this.store.state.isPlaying });
  }

  async _switchToNextIfNeeded() {
    if (this._switching) return;

    const curIndex = this.store.state.activeIndex;
    const seg = this.store.state.segments[curIndex];
    if (!seg) return;

    // For split V1 segments, we treat the segment end as (inSec + durationSec).
    const inSec = Math.max(0, Number(seg.inSec) || 0);
    const segEnd = inSec + Math.max(0, Number(seg.durationSec) || 0);
    const curTime = Number(this.active.currentTime) || 0;
    const remaining = segEnd - curTime;
    // When close to end, switch to next clip seamlessly.
    if (remaining > 0.35) return;

    const nextIndex = curIndex + 1;
    const nextSeg = this.store.state.segments[nextIndex];
    if (!nextSeg) {
      // End of playlist
      this.pause();
      this.store.setTime(seg.globalEndSec, 'time');
      return;
    }

    if (!nextSeg.canPlay) {
      this.pause();
      return;
    }

    const nextIn = Math.max(0, Number(nextSeg.inSec) || 0);

    // Split segments from the SAME source clip should never reload or swap videos.
    if (this._sameSource(this.active, nextSeg.url)) {
      this.store.setActiveIndex(nextIndex);
      const nextGlobal = nextSeg.globalStartSec + Math.max(0, curTime - nextIn);
      this.store.setTime(nextGlobal, 'time');
      try { this.preloadNext(nextIndex); } catch {}
      return;
    }

    this._switching = true;
    try {
      const needReload = !this._sameSource(this.standby, nextSeg.url)
        || (this.standby.readyState || 0) < 2
        || Math.abs((Number(this.standby.currentTime) || 0) - nextIn) > 0.25;
      if (needReload) {
        // A concurrent manual seek (loadAtGlobalTime) may load a different URL
        // into this same standby element while we await here — _loadSeq lets us
        // detect that and bail instead of swapping in the wrong clip.
        const seq = ++this._loadSeq;
        const ok = await this._loadVideo(this.standby, nextSeg.url, nextIn);
        if (seq !== this._loadSeq) return;
        if (!ok) {
          this.store.updateClip(nextSeg.clipId, { canPlay: false });
          this.pause();
          return;
        }
      }

      // Swap: make standby active.
      const wasPlaying = this.store.state.isPlaying;
      try { this.active.pause(); } catch {}
      this._swapVideos();
      this.store.setActiveIndex(nextIndex);
      this._setCurrentTimeSafe(this.active, nextIn);
      this.store.setTime(nextSeg.globalStartSec, 'time');

      if (wasPlaying) {
        try {
          this.active.playbackRate = 1;
          const p = this.active.play();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch {}
      }

      // Preload following
      try { this.preloadNext(nextIndex); } catch {}
    } finally {
      this._switching = false;
    }
  }

  _tick(ts) {
    this._raf = requestAnimationFrame((t) => this._tick(t));
    const now = ts || performance.now();
    if (now - this._lastTick < 16) return; // ~60fps UI updates
    this._lastTick = now;

    const seg = this.store.state.segments[this.store.state.activeIndex];
    if (!seg) return;

    // Keep store time updated (only if not scrubbing)
    if (!this._seeking) {
      const inSec = Math.max(0, Number(seg.inSec) || 0);
      const global = seg.globalStartSec + Math.max(0, (Number(this.active.currentTime) || 0) - inSec);
      if (Math.abs(global - (Number(this.store.state.globalTimeSec) || 0)) > 0.0005) {
        this.store.setTime(global, 'time');
      }
    }

    // Auto-switch at boundary
    if (this.store.state.isPlaying) {
      void this._switchToNextIfNeeded();
    }
  }
}
