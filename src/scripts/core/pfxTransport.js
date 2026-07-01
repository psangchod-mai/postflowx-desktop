// pfxTransport.js — the single shared media transport for every PostFlowX player.
//
// One self-rendered, mount-once component (scrub row above a button row) plus a
// thin per-player "adapter". Replaces the old observe-and-reorder unifyPlayerBars
// and the per-video resolveVideoTransport. The component owns markup, icons, the
// scrub bar, color states and the JKL rate-ramp state machine; adapters expose a
// tiny media interface over each player's existing engine.
//
// ANTI-FREEZE CONTRACT (a real regression we hit before): the component never
// observes its own DOM. It updates only from (a) the adapter's onChange events
// and (b) ONE requestAnimationFrame loop that exists *only while playing* and is
// cancelled when the tab goes inactive. Re-mounting is idempotent.
//
//   import { mountTransport, makeVideoAdapter } from '../core/pfxTransport.js';
//   const ctrl = mountTransport(makeVideoAdapter(videoEl, { name:'aceslook', host, items:{...} }));
'use strict';

import { framesToTC } from '../modules/utils_time.js';

// ── Inline SVG icons (currentColor; sized via CSS). Vectors lifted from the old
//    resolveTransportIcons.js so the look is identical. ─────────────────────────
const ICON = {
  jumpStart: '<svg viewBox="0 0 24 24"><rect x="5.4" y="5.5" width="2.2" height="13" rx="1"/><path d="M19 5.5v13L9 12z"/></svg>',
  jumpEnd:   '<svg viewBox="0 0 24 24"><path d="M5 5.5v13L15 12z"/><rect x="16.4" y="5.5" width="2.2" height="13" rx="1"/></svg>',
  playBack:  '<svg viewBox="0 0 24 24"><path d="M16 5.5v13L6 12z"/></svg>',
  stop:      '<svg viewBox="0 0 24 24"><rect x="6.5" y="6.5" width="11" height="11" rx="1.6"/></svg>',
  play:      '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5z"/></svg>',
  pause:     '<svg viewBox="0 0 24 24"><path d="M7.5 5h3v14h-3zM13.5 5h3v14h-3z"/></svg>',
  // Loop glyph — user-supplied rounded-rectangle loop icon, painted via a CSS
  // mask (.pfx-tx-glyph-loop in main.css) so it recolours with the button state.
  // Idle and active share the same artwork; "engaged" reads via colour (orange)
  // + the orange pill background on .pfx-tx-loop-on.
  loop:      '<i class="pfx-tx-glyph-loop" aria-hidden="true"></i>',
  loopOn:    '<i class="pfx-tx-glyph-loop" aria-hidden="true"></i>',
  chevL:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 4.5 8 12 15 19.5"/></svg>',
  chevR:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 4.5 16 12 9 19.5"/></svg>',
  dot:       '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4.6"/></svg>',
};

// Forward / reverse speed ladders for the JKL shuttle (½× → 1× → 2× → 4×).
const SPEEDS = [0.5, 1, 2, 4];
const FLASH_MS = 300;

const _registry = new Map();   // name -> controller

function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/**
 * Pure JKL rate-ramp ladder. Given the current signed rate and a direction
 * (+1 forward, -1 reverse), return the next signed rate. Starting (or changing
 * direction) plays at 1×; repeating in the same direction steps up the ladder.
 * Exported for unit testing.
 */
export function nextRampRate(signedRate, dir) {
  const d = dir < 0 ? -1 : 1;
  const sameDir = signedRate !== 0 && Math.sign(signedRate) === d;
  if (!sameDir) return d * 1;
  const i = SPEEDS.indexOf(Math.abs(signedRate));
  const next = SPEEDS[Math.min(SPEEDS.length - 1, (i < 0 ? 1 : i) + 1)];
  return d * next;
}

// ── Public registry helpers ──────────────────────────────────────────────────
export function getTransport(name) { return _registry.get(name) || null; }
export function listTransports() { return Array.from(_registry.values()); }
export function refreshTransport(name) { _registry.get(name)?.refresh(); }

/**
 * Build (or return the existing) transport for an adapter and mount it into
 * adapter.host. Idempotent.
 * @returns {object} controller { el, adapter, refresh, destroy, setActive, ...commands }
 */
export function mountTransport(adapter) {
  try {
    if (!adapter || !adapter.host) return null;
    const host = adapter.host;
    // Idempotent: the registry is the source of truth (a dataset flag is only a
    // hint and may not reflect in every environment).
    const existing = _registry.get(adapter.name);
    if (existing) {
      if (existing.el && existing.el.isConnected) return existing;
      // Stale: the previous host was removed (player re-rendered). Tear it down
      // first so its onChange listeners + reverse rAF don't leak.
      try { existing.destroy(); } catch {}
    }
    const ctrl = buildController(adapter);
    if (!ctrl) return null;
    host.dataset.pfxTx = '1';
    _registry.set(adapter.name, ctrl);
    return ctrl;
  } catch (e) {
    console.warn('[pfxTransport] mount failed:', e && e.message);
    return null;
  }
}

function buildController(adapter) {
  const root = document.createElement('div');
  root.className = 'pfx-tx';
  root.dataset.pfxTxName = adapter.name || '';
  root.innerHTML = `
    <div class="pfx-tx-scrub-row">
      <span class="pfx-tx-tc pfx-tx-tc-cur" aria-hidden="true">00:00:00:00</span>
      <div class="pfx-tx-scrub" role="slider" tabindex="0" aria-label="Timeline position"
           aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
        <div class="pfx-tx-scrub-track"></div>
        <div class="pfx-tx-scrub-fill"></div>
        <div class="pfx-tx-scrub-thumb"></div>
      </div>
      <span class="pfx-tx-tc pfx-tx-tc-dur" aria-hidden="true">00:00:00:00</span>
    </div>
    <div class="pfx-tx-btn-row">
      <span class="pfx-tx-navpod" aria-label="Item navigation">
        <button type="button" class="pfx-tx-btn pfx-tx-mini" data-act="prevItem" title="Previous item" aria-label="Previous item">${ICON.chevL}</button>
        <span class="pfx-tx-navpod-dot" data-act="currentItem" title="Jog — drag or scroll to scrub" aria-label="Jog / scrub" role="slider">${ICON.dot}</span>
        <button type="button" class="pfx-tx-btn pfx-tx-mini" data-act="nextItem" title="Next item" aria-label="Next item">${ICON.chevR}</button>
      </span>
      <button type="button" class="pfx-tx-btn pfx-tx-jstart" data-act="jumpStart" title="Jump to start" aria-label="Jump to start">${ICON.jumpStart}</button>
      <button type="button" class="pfx-tx-btn pfx-tx-back"   data-act="playBack"  title="Play backward (J)" aria-label="Play backward">${ICON.playBack}</button>
      <button type="button" class="pfx-tx-btn pfx-tx-stop"   data-act="stop"      title="Stop (K)" aria-label="Stop">${ICON.stop}</button>
      <button type="button" class="pfx-tx-btn pfx-tx-play"   data-act="playFwd"   title="Play forward (Space / L)" aria-label="Play forward">${ICON.play}</button>
      <button type="button" class="pfx-tx-btn pfx-tx-jend"   data-act="jumpEnd"   title="Jump to end" aria-label="Jump to end">${ICON.jumpEnd}</button>
      <button type="button" class="pfx-tx-btn pfx-tx-loop"   data-act="loop"      title="Loop" aria-label="Loop">${ICON.loop}</button>
    </div>`;
  adapter.host.appendChild(root);

  const $ = sel => root.querySelector(sel);
  const els = {
    root,
    scrub:    $('.pfx-tx-scrub'),
    fill:     $('.pfx-tx-scrub-fill'),
    thumb:    $('.pfx-tx-scrub-thumb'),
    tcCur:    $('.pfx-tx-tc-cur'),
    tcDur:    $('.pfx-tx-tc-dur'),
    btnRow:   $('.pfx-tx-btn-row'),
    play:     $('.pfx-tx-play'),
    back:     $('.pfx-tx-back'),
    loop:     $('.pfx-tx-loop'),
    navpod:   $('.pfx-tx-navpod'),
  };

  // Hide the loop button when the adapter can't loop (no video and no delegated
  // loop control) — otherwise it's a dead, never-active control. Adapters that
  // don't implement canLoop() (e.g. native <video> adapters) always loop.
  if (els.loop && typeof adapter.canLoop === 'function' && !adapter.canLoop()) {
    els.loop.style.display = 'none';
  }

  // Per-controller state. lastRate>0 forward, <0 reverse, 0 paused.
  const st = {
    active: true,
    lastRate: 0,
    raf: 0,
    scrubbing: false,
    scrubPending: null,   // coalesced target frame
    scrubRaf: 0,
    // cache last-written DOM values to avoid layout thrash
    w: { tcCur: '', tcDur: '', fillPct: -1, playing: null, dir: 0, loop: null, playIcon: '' },
    flashTimers: { jumpStart: 0, jumpEnd: 0 },
  };

  const fmtTc = (frame) => {
    try {
      if (typeof adapter.formatTc === 'function') return adapter.formatTc(frame);
      const fps = Math.max(1, Math.round(adapter.getFps() || 24));
      return framesToTC(frame, fps);
    } catch { return '00:00:00:00'; }
  };

  // ── Render (idempotent; only touches DOM when a value changed) ──────────────
  function refresh() {
    let dur = 0, cur = 0, playing = false;
    try {
      dur = Math.max(0, Math.round(adapter.getDuration() || 0));
      cur = clamp(Math.round(adapter.getFrame() || 0), 0, Math.max(0, dur - 1));
      playing = !!adapter.isPlaying();
    } catch {}

    const last = Math.max(0, dur - 1);
    const pct = last > 0 ? (cur / last) * 100 : 0;
    if (st.w.fillPct !== pct) {
      st.w.fillPct = pct;
      els.fill.style.width = pct + '%';
      els.thumb.style.left = pct + '%';
      els.scrub.setAttribute('aria-valuemax', String(last));
      els.scrub.setAttribute('aria-valuenow', String(cur));
    }
    const tcCur = fmtTc(cur);
    if (st.w.tcCur !== tcCur) { st.w.tcCur = tcCur; els.tcCur.textContent = tcCur; }
    const tcDur = fmtTc(last);
    if (st.w.tcDur !== tcDur) { st.w.tcDur = tcDur; els.tcDur.textContent = tcDur; }

    // Direction for color: reverse only counts while actually playing reverse.
    const dir = playing ? (st.lastRate < 0 ? -1 : 1) : 0;
    if (st.w.playing !== playing || st.w.dir !== dir) {
      st.w.playing = playing; st.w.dir = dir;
      els.play.classList.toggle('pfx-tx-playing', playing && dir > 0);
      els.back.classList.toggle('pfx-tx-active', playing && dir < 0);
      els.scrub.classList.toggle('is-playing', playing);
      // Keep the ▶ glyph unchanged while playing — the active state is signalled
      // by COLOR ONLY (green via .pfx-tx-playing), not by swapping to a pause icon.
      const wantIcon = 'play';
      if (st.w.playIcon !== wantIcon) { st.w.playIcon = wantIcon; els.play.innerHTML = ICON[wantIcon]; }
    }

    const loopOn = typeof adapter.loop === 'function' ? !!adapter.loop() : false;
    if (st.w.loop !== loopOn) {
      st.w.loop = loopOn;
      els.loop.classList.toggle('pfx-tx-loop-on', loopOn);
      // Swap the glyph too — colour alone was too subtle to read as "active".
      els.loop.innerHTML = loopOn ? ICON.loopOn : ICON.loop;
    }

    syncAvailability(dur);
  }

  let _wPlayable = null;
  function syncAvailability(dur) {
    const playable = (typeof adapter.canPlay === 'function' ? !!adapter.canPlay() : true) && dur > 0;
    if (_wPlayable === playable) return;
    _wPlayable = playable;
    root.classList.toggle('pfx-tx-no-play', !playable);
    [els.play, els.back, els.loop].forEach(b => {
      b.toggleAttribute('disabled', !playable);
    });
  }

  // ── Playback rAF: refresh UI only while playing. ────────────────────────────
  function startRaf() {
    if (st.raf || !st.active) return;
    const tick = () => {
      refresh();
      if (st.active && adapter.isPlaying()) st.raf = requestAnimationFrame(tick);
      else st.raf = 0;
    };
    st.raf = requestAnimationFrame(tick);
  }
  function stopRaf() { if (st.raf) { cancelAnimationFrame(st.raf); st.raf = 0; } }

  // ── Adapter change subscription. ────────────────────────────────────────────
  let _unsub = null;
  if (typeof adapter.onChange === 'function') {
    try {
      _unsub = adapter.onChange((evt) => {
        if (!st.active) return;
        refresh();
        if (adapter.isPlaying()) startRaf(); else stopRaf();
      });
    } catch {}
  }

  // ── Commands (also called by the global keyboard layer). ────────────────────
  function safe(fn) { try { fn(); } catch (e) { /* defensive */ } finally { refresh(); if (adapter.isPlaying()) startRaf(); } }

  function setRate(rate) { st.lastRate = rate; try { adapter.play(rate); } catch {} }

  const cmd = {
    togglePlayPause() {
      safe(() => {
        if (adapter.isPlaying()) { adapter.pause(); st.lastRate = 0; }
        else setRate(1);
      });
    },
    playForward() {  // ▶ button / L — ramp ½→1→2→4× on repeat
      safe(() => setRate(nextRampRate(adapter.isPlaying() ? st.lastRate : 0, +1)));
    },
    playBackward() {  // ◀ button — CONTINUOUS reverse playback (blue while active), toggles
      safe(() => {
        if (adapter.isPlaying() && st.lastRate < 0) { adapter.pause(); st.lastRate = 0; }
        else setRate(-1);
      });
    },
    stop() {  // ■ / K
      safe(() => { adapter.pause(); st.lastRate = 0; });
    },
    stepFrame(dir) {  // arrows / J-tap
      safe(() => {
        if (adapter.isPlaying()) { adapter.pause(); st.lastRate = 0; }
        const cur = Math.round(adapter.getFrame() || 0);
        adapter.seekToFrame(cur + (dir < 0 ? -1 : 1));
      });
    },
    jumpStart() {
      safe(() => { try { adapter.jumpStart(); } catch {} st.lastRate = 0; });
      flash('jumpStart');
    },
    jumpEnd() {
      safe(() => { try { adapter.jumpEnd(); } catch {} st.lastRate = 0; });
      flash('jumpEnd');
    },
    // Do NOT pause before calling items.prev/next: the player's nav handler owns
    // the canvas pipeline; pausing via adapter.pause() (which clicks the play
    // toggle) kills the pipeline and leaves the seeked frame unpainted.
    prevItem() { safe(() => { st.lastRate = 0; adapter.items?.prev?.(); }); },
    nextItem() { safe(() => { st.lastRate = 0; adapter.items?.next?.(); }); },
    toggleLoop() {
      safe(() => {
        if (typeof adapter.setLoop === 'function') {
          const cur = typeof adapter.loop === 'function' ? adapter.loop() : false;
          adapter.setLoop(!cur);
        }
      });
    },
  };

  // Hold-J continuous reverse: started on keydown-hold, ended on keyup.
  function reverseHoldStart() { if (!adapter.isPlaying() || st.lastRate >= 0) safe(() => setRate(-1)); }
  function reverseHoldEnd() { safe(() => { adapter.pause(); st.lastRate = 0; }); }

  function flash(which) {
    const btn = which === 'jumpStart' ? root.querySelector('.pfx-tx-jstart') : root.querySelector('.pfx-tx-jend');
    if (!btn) return;
    clearTimeout(st.flashTimers[which]);
    btn.classList.add('pfx-tx-flash');
    st.flashTimers[which] = setTimeout(() => btn.classList.remove('pfx-tx-flash'), FLASH_MS);
  }

  // ── Button row: one delegated click listener. ───────────────────────────────
  els.btnRow.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const act = b.dataset.act;
    if (b.hasAttribute('disabled')) return;
    switch (act) {
      case 'prevItem': cmd.prevItem(); break;
      case 'nextItem': cmd.nextItem(); break;
      case 'currentItem': break;                 // passive dot
      case 'jumpStart': cmd.jumpStart(); break;
      case 'jumpEnd': cmd.jumpEnd(); break;
      case 'playBack': cmd.playBackward(); break;   // ◀ click = continuous reverse playback (blue while active)
      case 'stop': cmd.stop(); break;
      case 'playFwd': cmd.togglePlayPause(); break;
      case 'loop': cmd.toggleLoop(); break;
    }
  });

  // ── Scrub: click-anywhere + drag, frame-accurate, coalesced. Never changes
  //    play/stop state. ─────────────────────────────────────────────────────
  function frameFromClientX(clientX) {
    const r = els.scrub.getBoundingClientRect();
    if (r.width <= 0) return 0;
    const frac = clamp((clientX - r.left) / r.width, 0, 1);
    const last = Math.max(0, Math.round(adapter.getDuration() || 0) - 1);
    return Math.round(frac * last);
  }
  function queueSeek(frame) {
    st.scrubPending = frame;
    if (st.scrubRaf) return;
    st.scrubRaf = requestAnimationFrame(() => {
      st.scrubRaf = 0;
      if (st.scrubPending == null) return;
      const f = st.scrubPending; st.scrubPending = null;
      try { adapter.seekToFrame(f); } catch {}
      refresh();
    });
  }
  els.scrub.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    if (root.classList.contains('pfx-tx-no-play') && (adapter.getDuration() || 0) <= 0) return;
    st.scrubbing = true;
    try { els.scrub.setPointerCapture(e.pointerId); } catch {}
    queueSeek(frameFromClientX(e.clientX));
    e.preventDefault();
  });
  els.scrub.addEventListener('pointermove', (e) => {
    if (!st.scrubbing) return;
    queueSeek(frameFromClientX(e.clientX));
  });
  const endScrub = (e) => {
    if (!st.scrubbing) return;
    st.scrubbing = false;
    try { els.scrub.releasePointerCapture(e.pointerId); } catch {}
  };
  els.scrub.addEventListener('pointerup', endScrub);
  els.scrub.addEventListener('pointercancel', endScrub);
  // Keyboard on focused scrub: arrows step a frame (does not bubble to global keys).
  els.scrub.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { cmd.stepFrame(-1); e.preventDefault(); e.stopPropagation(); }
    else if (e.key === 'ArrowRight') { cmd.stepFrame(1); e.preventDefault(); e.stopPropagation(); }
  });

  // ── Nav-pod JOG/SCRUB (per request — overrides the reference's click-only pod):
  //    the centre dot scrubs the playhead via pointer drag (mouse or trackpad),
  //    and the whole pod responds to the scroll wheel / two-finger trackpad scroll.
  //    The chevrons keep their click = prev/next item. Seeking never changes play
  //    state (same as the main scrub). ─────────────────────────────────────────
  const lastFrame = () => Math.max(0, Math.round(adapter.getDuration() || 0) - 1);
  const dot = els.navpod && els.navpod.querySelector('.pfx-tx-navpod-dot');
  if (dot) {
    let jogging = false, jogStartX = 0, jogStartF = 0;
    const jogFpp = () => Math.max(1, Math.round((adapter.getDuration() || 1) / 640)); // drag ~640px ≈ whole clip
    dot.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button !== 0) return;
      jogging = true; jogStartX = e.clientX; jogStartF = Math.round(adapter.getFrame() || 0);
      try { dot.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault(); e.stopPropagation();
    });
    dot.addEventListener('pointermove', (e) => {
      if (!jogging) return;
      queueSeek(clamp(jogStartF + Math.round((e.clientX - jogStartX) * jogFpp()), 0, lastFrame()));
    });
    const endJog = (e) => { if (!jogging) return; jogging = false; try { dot.releasePointerCapture(e.pointerId); } catch {} };
    dot.addEventListener('pointerup', endJog);
    dot.addEventListener('pointercancel', endJog);
  }
  if (els.navpod) {
    els.navpod.addEventListener('wheel', (e) => {
      const delta = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!delta) return;
      e.preventDefault();
      const step = Math.max(1, Math.round(Math.abs(delta) / 16)) * (delta > 0 ? 1 : -1);
      queueSeek(clamp(Math.round(adapter.getFrame() || 0) + step, 0, lastFrame()));
    }, { passive: false });
  }

  const controller = {
    el: root, adapter, refresh,
    cmd, reverseHoldStart, reverseHoldEnd,
    setActive(on) {
      st.active = !!on;
      if (!on) { stopRaf(); }
      else { refresh(); if (adapter.isPlaying()) startRaf(); }
    },
    destroy() {
      stopRaf();
      try { _unsub?.(); } catch {}
      try { root.remove(); } catch {}
      try { delete adapter.host.dataset.pfxTx; } catch {}
      if (_registry.get(adapter.name) === controller) _registry.delete(adapter.name);
    },
  };

  refresh();
  if (adapter.isPlaying()) startRaf();
  return controller;
}

// ════════════════════════════════════════════════════════════════════════════
//  Reusable adapters
// ════════════════════════════════════════════════════════════════════════════

/**
 * Adapter for a native <video>. Forward playback uses video.playbackRate;
 * reverse / sub-1× use a shared rAF loop stepping currentTime, because HTML5
 * <video> cannot play backward.
 */
export function makeVideoAdapter(video, opts = {}) {
  const name = opts.name || 'video';
  const host = opts.host;
  const getFps = typeof opts.fps === 'function' ? opts.fps : () => num(opts.fps, 24);
  const frameOffset = typeof opts.frameOffset === 'function' ? opts.frameOffset : () => num(opts.frameOffset, 0);
  // FLOOR (not round): pairs with the +0.5-frame seek bias in f2s so the
  // seek↔read round-trip is exact (round(f+0.5) rounds up → off-by-one).
  const s2f = opts.secondsToFrame || ((t) => Math.floor(num(t) * getFps() + 1e-6));
  const f2s = opts.frameToSeconds || ((f) => (num(f) + 0.5) / getFps());   // +0.5 frame bias
  const items = opts.items || { type: 'cuts', prev() {}, next() {} };
  const inPoint = opts.inPoint || (() => null);
  const outPoint = opts.outPoint || (() => null);

  let revRaf = 0, revRate = 0, revLast = 0;
  const subs = new Set();
  const emit = (reason) => { subs.forEach(cb => { try { cb({ reason }); } catch {} }); };

  function stopReverse() { if (revRaf) { cancelAnimationFrame(revRaf); revRaf = 0; } revRate = 0; }
  function reverseLoop(rate) {
    stopReverse();
    revRate = rate;                       // negative
    revLast = 0;
    try { video.pause(); } catch {}
    const step = (ts) => {
      if (!revLast) revLast = ts;
      const dt = Math.min(0.1, (ts - revLast) / 1000); revLast = ts;
      const nt = (video.currentTime || 0) + revRate * dt;   // revRate<0 → backwards
      if (nt <= 0) { try { video.currentTime = 0; } catch {} stopReverse(); emit('pause'); return; }
      try { video.currentTime = nt; } catch {}
      emit('time');
      revRaf = requestAnimationFrame(step);
    };
    revRaf = requestAnimationFrame(step);
  }

  const adapter = {
    name, host,
    getFps,
    getFrame: () => s2f(video.currentTime || 0) + frameOffset(),
    getDuration: () => {
      const d = video.duration;
      return Number.isFinite(d) && d > 0 ? s2f(d) + 1 : 0;
    },
    seekToFrame(absF) {
      const last = Math.max(0, adapter.getDuration() - 1);
      const f = clamp(Math.round(absF) - frameOffset(), 0, last);
      try { video.currentTime = Math.max(0, f2s(f)); } catch {}
    },
    isPlaying: () => (!!revRaf) || (!video.paused && !video.ended),
    play(rate) {
      if (rate < 0) { reverseLoop(rate); return; }
      stopReverse();
      try { video.playbackRate = Math.max(0.0625, Math.abs(rate) || 1); } catch {}
      try { video.play(); } catch {}
    },
    pause() { stopReverse(); try { video.pause(); } catch {} },
    stop() { adapter.pause(); },
    jumpStart() { adapter.pause(); adapter.seekToFrame(0); },
    jumpEnd() {
      adapter.pause();
      const out = outPoint();
      adapter.seekToFrame(out != null ? out : Math.max(0, adapter.getDuration() - 1));
    },
    items, inPoint, outPoint,
    loop: () => !!video.loop,
    setLoop: (on) => { try { video.loop = !!on; } catch {} },
    canPlay: opts.canPlay || (() => Number.isFinite(video.duration) && video.duration > 0),
    formatTc: opts.formatTc,
    onChange(cb) {
      subs.add(cb);
      const ac = new AbortController();
      const o = { signal: ac.signal };
      const on = (ev, reason) => video.addEventListener(ev, () => emit(reason), o);
      on('timeupdate', 'time'); on('play', 'play'); on('pause', 'pause');
      on('seeked', 'seek'); on('loadedmetadata', 'load'); on('durationchange', 'load');
      on('emptied', 'load'); on('ended', 'pause');
      return () => { subs.delete(cb); try { ac.abort(); } catch {} stopReverse(); };
    },
  };
  return adapter;
}

/**
 * Adapter for a dual-video player (Cut Diff 2.0, SLY). Reads from the
 * authoritative video; delegates seek/play to the feature's dual-aware hooks so
 * sync offsets are preserved. Reverse drives only the primary; the secondary
 * follows via the feature's existing sync.
 */
export function makeDualVideoAdapter(opts = {}) {
  // opts: name, host, getFrame, getDuration, getFps, seekToFrame, isPlaying,
  //       playForward(rate), pause, items, inPoint, outPoint, loop, setLoop,
  //       subscribe(cb)->unsub, formatTc, primaryVideo (for reverse loop)
  const primary = opts.primaryVideo || null;
  let revRaf = 0, revLast = 0, revRate = 0;
  const subs = new Set();
  const emit = (reason) => subs.forEach(cb => { try { cb({ reason }); } catch {} });

  function stopReverse() { if (revRaf) { cancelAnimationFrame(revRaf); revRaf = 0; } revRate = 0; }
  function reverseLoop(rate) {
    if (!primary) return;
    stopReverse(); revRate = rate; revLast = 0;
    try { opts.pause?.(); } catch {}
    const step = (ts) => {
      if (!revLast) revLast = ts;
      const dt = Math.min(0.1, (ts - revLast) / 1000); revLast = ts;
      const cur = Math.round(opts.getFrame() || 0);
      const fps = Math.max(1, opts.getFps() || 24);
      const nf = cur + Math.round(revRate * dt * fps);
      if (nf <= 0) { opts.seekToFrame?.(0); stopReverse(); emit('pause'); return; }
      opts.seekToFrame?.(nf);
      emit('time');
      revRaf = requestAnimationFrame(step);
    };
    revRaf = requestAnimationFrame(step);
  }

  const adapter = {
    name: opts.name, host: opts.host,
    getFps: opts.getFps,
    getFrame: opts.getFrame,
    getDuration: opts.getDuration,
    seekToFrame: opts.seekToFrame,
    isPlaying: () => (!!revRaf) || !!opts.isPlaying?.(),
    play(rate) {
      if (rate < 0) { reverseLoop(rate); return; }
      stopReverse();
      opts.playForward?.(Math.abs(rate) || 1);
    },
    pause() { stopReverse(); opts.pause?.(); },
    stop() { adapter.pause(); },
    jumpStart() { adapter.pause(); adapter.seekToFrame(0); },
    jumpEnd() {
      adapter.pause();
      const out = opts.outPoint?.();
      adapter.seekToFrame(out != null ? out : Math.max(0, (opts.getDuration?.() || 1) - 1));
    },
    items: opts.items || { type: 'cuts', prev() {}, next() {} },
    inPoint: opts.inPoint || (() => null),
    outPoint: opts.outPoint || (() => null),
    loop: opts.loop, setLoop: opts.setLoop,
    canPlay: opts.canPlay || (() => (opts.getDuration?.() || 0) > 0),
    formatTc: opts.formatTc,
    onChange(cb) {
      subs.add(cb);
      const unsub = opts.subscribe?.(() => emit('time')) || (() => {});
      return () => { subs.delete(cb); try { unsub(); } catch {} stopReverse(); };
    },
  };
  return adapter;
}

// Exposed for the keyboard layer / debugging.
try { window.PfxTransport = { mount: mountTransport, get: getTransport, list: listTransports, refresh: refreshTransport }; } catch {}
