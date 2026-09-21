// pfxTransportMount.js — orchestrates the shared transport across every DOM
// player. Replaces the old observe-and-reorder unifyPlayerBars: instead of
// shuffling each player's buttons, it mounts ONE pfxTransport component per
// player and drives it through a DOM-delegating adapter (the player's existing
// scrub slider + action buttons + <video>). No edits to the giant feature
// modules are needed — we reuse the controls they already wire.
//
// Anti-freeze: mountAll() is fully idempotent and cheap (querySelector guards).
// The debounced observer only ever re-runs mountAll(); once a player is mounted
// its container carries data-pfx-tx-mounted and is skipped, so the observer's
// own DOM writes never cause more work.
'use strict';

import { mountTransport, getTransport } from './pfxTransport.js';

function qs(sel, root) { try { return (root || document).querySelector(sel); } catch { return null; } }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

function hide(el) {
  if (!el || el.dataset.pfxTxHidden === '1') return;
  el.dataset.pfxTxHidden = '1';
  el.style.setProperty('display', 'none', 'important');
}

// Detect "is playing" from a <video> or, lacking one, from the play button.
// NOTE: do NOT sniff the button title — labels like "Play / Pause" contain
// "pause" permanently and would make every player look perpetually playing.
function detectPlaying(video, playBtn) {
  if (video && !video.paused && !video.ended) return true;
  if (!playBtn) return false;
  const t = (playBtn.textContent || '').trim();
  if (t === '⏸' || t === '❚❚') return true;
  if (playBtn.getAttribute('aria-pressed') === 'true') return true;
  if (/\b(is-)?playing\b|\bis-active\b/.test(playBtn.className || '')) return true;
  return false;
}

/**
 * Build a DOM-delegating adapter for a configured player. Reads frame/duration
 * from the player's <video> when present (frame-accurate TC), otherwise from its
 * range slider. Playback / jump / item-nav delegate to the player's own buttons
 * so all existing sync/seek logic stays intact; reverse + ramp are layered on.
 */
function makeDelegatingAdapter(cfg) {
  const B = cfg.btn || {};
  const btn = (k) => (B[k] ? qs(B[k]) : null);
  const video = () => {
    const candidates = [];
    for (const id of (cfg.video || [])) {
      const v = document.getElementById(id);
      if (v && v.tagName === 'VIDEO') candidates.push(v);
    }
    // A workspace may keep a dormant comparison <video> before the active
    // program monitor in its config (Pulls Prep does this with pmSlyCmpVideo
    // before pmVideo). Direct AVFoundation playback lives on the latter via
    // _pfxNativeEngine, so choosing the first DOM video made Stop/Pause target
    // the empty comparison element while the ProRes movie kept playing.
    return candidates.find(v => v._pfxNativeEngine)
      || candidates.find(v => v.currentSrc || v.src)
      || candidates[0]
      || null;
  };
  const slider = () => (cfg.slider ? qs(cfg.slider) : null);
  const nativeEngine = () => video()?._pfxNativeEngine || null;
  const getFps = () => num(nativeEngine()?.fps, num(cfg.fps && cfg.fps(), 24)) || 24;
  // Range-input value/max via IDL property, falling back to the attribute (some
  // players drive the slider by attribute; some DOM impls don't reflect IDL).
  const sliderVal = (s) => num(s.value !== '' && s.value != null ? s.value : s.getAttribute('value'), 0);
  const sliderMax = (s) => num(s.max !== '' && s.max != null ? s.max : s.getAttribute('max'), 0);

  let revRaf = 0, revLast = 0, revRate = 0;
  const subs = new Set();
  const emit = (reason) => subs.forEach(cb => { try { cb({ reason }); } catch {} });
  function stopReverse() { if (revRaf) { cancelAnimationFrame(revRaf); revRaf = 0; } revRate = 0; }

  const adapter = {
    name: cfg.name,
    host: null,                       // set by tryMount
    getFps,
    getFrame() {
      const v = video();
      const ne = nativeEngine();
      if (ne) return Math.max(0, Math.round(ne.currentFrame || 0));
      // Same readiness gate as getDuration() so frame + duration never mix
      // video-frames with slider-units (e.g. duration finite-but-0 at load).
      // FLOOR (not round): seekToFrame writes currentTime=(f+0.5)/fps, and
      // round(f+0.5) rounds UP to f+1 → the seek/read round-trip was off by one
      // (a one-frame step appeared to do nothing). floor((f+0.5)) === f.
      if (v && Number.isFinite(v.duration) && v.duration > 0) return Math.floor((v.currentTime || 0) * getFps() + 1e-6);
      const s = slider();
      return s ? Math.round(sliderVal(s)) : 0;
    },
    getDuration() {
      const v = video();
      const ne = nativeEngine();
      if (ne && Number.isFinite(ne.duration) && ne.duration > 0) return Math.round(ne.duration * (ne.fps || getFps()));
      if (v && Number.isFinite(v.duration) && v.duration > 0) return Math.round(v.duration * getFps()) + 1;
      const s = slider();
      return s ? Math.round(sliderMax(s)) + 1 : 0;
    },
    seekToFrame(absF) {
      const last = Math.max(0, adapter.getDuration() - 1);
      const f = clamp(Math.round(absF), 0, last);
      const v = video();
      const ne = nativeEngine();
      if (ne) {
        try { ne.seekFrame(f); } catch {}
      } else if (v && Number.isFinite(v.duration)) {
        try { v.currentTime = clamp((f + 0.5) / getFps(), 0, v.duration); } catch {}
      } else {
        const s = slider();
        if (s) {
          s.value = String(f);
          try { s.setAttribute('value', String(f)); } catch {}
          s.dispatchEvent(new Event('input', { bubbles: true }));
          s.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      emit('seek');
    },
    // Playing state is authoritative from the <video> when present (button
    // titles like "Play / Pause" must NOT be sniffed — see detectPlaying).
    isPlaying() {
      if (revRaf) return true;
      const ne = nativeEngine();
      if (ne) return !!ne.isPlaying;
      const v = video();
      if (v) return !v.paused && !v.ended;
      return detectPlaying(null, btn('play'));
    },
    play(rate) {
      if (rate < 0) {                  // continuous reverse via frame-stepping
        adapter.pause();
        stopReverse(); revRate = rate; revLast = 0;
        // Accumulate FRACTIONAL frames — at 1× a single animation frame is only
        // ~0.38 frames, which would Math.round to 0 and never move if we rounded
        // each tick independently.
        let acc = adapter.getFrame();
        const step = (ts) => {
          if (!revLast) revLast = ts;
          const dt = Math.min(0.1, (ts - revLast) / 1000); revLast = ts;
          acc += revRate * dt * getFps();           // revRate < 0 → moves backward
          if (acc <= 0) { adapter.seekToFrame(0); stopReverse(); emit('pause'); return; }
          adapter.seekToFrame(Math.round(acc));
          emit('time');
          revRaf = requestAnimationFrame(step);
        };
        revRaf = requestAnimationFrame(step);
        return;
      }
      stopReverse();
      const ne = nativeEngine();
      if (ne) {
        try { ne.play(); } catch {}
        emit('play');
        return;
      }
      // Start via the player's own toggle button so its canvas/sync loop runs.
      if (!adapter.isPlaying()) { btn('play')?.click(); }
      const v = video();
      if (v) { try { v.playbackRate = Math.max(0.0625, Math.abs(rate) || 1); } catch {} }
      emit('play');
    },
    pause() {
      stopReverse();
      const v = video();
      const ne = nativeEngine();
      if (ne) {
        try { ne.pause(); } catch {}
      } else if (v) {
        // IMPORTANT: do NOT call btn('play')?.click() when a <video> is present.
        // That button is a toggle — if called while paused it starts playback, and
        // even when called while playing it stops the AVFoundation canvas render
        // pipeline (same root cause as the jumpStart/jumpEnd fix).
        // v.pause() fires the player's own 'pause' event, which handles all cleanup
        // (_pmStopPlayRaf, _pmStopVideoFrameClock, button text, etc.) correctly.
        if (!v.paused) { try { v.pause(); } catch {} }
      } else {
        // Slider-only player (no <video>): fall back to the play-toggle button.
        if (adapter.isPlaying()) { btn('play')?.click(); }
      }
      emit('pause');
    },
    stop() { adapter.pause(); },
    // Jump to absolute clip edges by SEEKING (the per-player start/end buttons
    // act on the NLE timeline, not this viewer, so we don't use them).
    //
    // IMPORTANT: do NOT call adapter.pause() here. adapter.pause() calls
    // btn('play')?.click() which toggles the player's own play button and kills
    // the canvas render pipeline (same root cause as the items.prev/next fix).
    // Instead, pause the <video> element directly — the player's own 'pause' event
    // listener (e.g. _pmStopPlayRaf) will handle cleanup without killing the pipeline.
    jumpStart() {
      stopReverse();
      const v = video();
      if (v && !v.paused) { try { v.pause(); } catch {} }
      adapter.seekToFrame(0);
      emit('seek');
    },
    jumpEnd() {
      stopReverse();
      const v = video();
      if (v && !v.paused) { try { v.pause(); } catch {} }
      const out = adapter.outPoint?.();
      adapter.seekToFrame(out != null ? out : Math.max(0, adapter.getDuration() - 1));
      emit('seek');
    },
    items: {
      type: cfg.itemsType || 'cuts',
      // Delegate entirely to the player's own nav button. The player's internal
      // handler (_pmJumpToMarker etc.) owns the canvas pipeline and seek state;
      // calling adapter.pause() here would click the play-toggle and kill the
      // canvas render pipeline, leaving the seeked frame unpainted (black canvas).
      prev() { btn('prevItem')?.click(); },
      next() { btn('nextItem')?.click(); },
    },
    inPoint: () => null,
    outPoint: () => null,
    // Prefer a delegated loop button (the player owns its loop-seek logic); fall
    // back to the <video>'s native .loop when there's no button but a video.
    loop() {
      const b = btn('loop');
      if (b) return /\b(active|is-active|rti-active)\b/.test(b.className || '') || b.getAttribute('aria-pressed') === 'true';
      const v = video();
      return v ? !!v.loop : false;
    },
    setLoop(on) {
      const b = btn('loop');
      if (b) { b.click(); return; }
      const v = video();
      if (v) { try { v.loop = (on == null ? !v.loop : !!on); } catch {} }
    },
    // Whether a loop toggle is meaningful: either a delegated loop button or a
    // <video> to loop. Slider-only scrub navs have neither → the unified bar
    // hides its loop button rather than showing a dead control (see pfxTransport).
    canLoop() { return !!B.loop || ((cfg.video || []).length > 0); },
    canPlay() {
      if (typeof cfg.canPlay === 'function') return cfg.canPlay({ video: video(), btn });
      const ne = nativeEngine();
      if (ne) return Number.isFinite(ne.duration) && ne.duration > 0;
      const v = video();
      if (v) return Number.isFinite(v.duration) && v.duration > 0;
      const s = slider();
      return !!s && sliderMax(s) > 0;
    },
    onChange(cb) {
      subs.add(cb);
      const ac = new AbortController();
      const o = { signal: ac.signal };
      const v = video();
      if (v) {
        ['timeupdate', 'play', 'pause', 'seeked', 'loadedmetadata', 'durationchange', 'emptied', 'ended',
         'pfx-native-ready', 'pfx-native-timeupdate']
          .forEach(ev => v.addEventListener(ev, () => emit(ev), o));
      }
      const s = slider();
      if (s) { s.addEventListener('input', () => emit('time'), o); s.addEventListener('change', () => emit('time'), o); }
      // Button-driven jumps (no video event): refresh shortly after any click,
      // coalesced to a single pending timer so rapid clicks don't pile up.
      let clickT = 0;
      adapter.host?.parentElement?.addEventListener('click', () => {
        if (clickT) return;
        clickT = setTimeout(() => { clickT = 0; emit('time'); }, 30);
      }, o);
      return () => { subs.delete(cb); try { ac.abort(); } catch {} stopReverse(); };
    },
  };
  return adapter;
}

// ── Player configs. container is hidden (display:none) once the new bar mounts;
//    the underlying buttons keep working because we .click() them. ─────────────
const CONFIGS = [
  {
    name: 'imf',
    container: '.imf-transport-btns-v2',
    hideAlso: ['.imf-scrubber-wrap', '.imf-transport-tc', '.imf-transport-nudge', '.imf-transport-marks'],
    slider: '#imfSeek',
    video: [],
    itemsType: 'reels',
    btn: { play: '#imfBtnPlay', prevItem: '#imfBtnReelPrev', nextItem: '#imfBtnReelNext', prevFrame: '#imfBtnPrev', nextFrame: '#imfBtnNext', loop: '#imfTbLoop' },
  },
  {
    name: 'prepmark',
    container: '.pm-controls',
    slider: '#pmScrub',
    video: ['pmVideo'],
    itemsType: 'markers',
    btn: { play: '#pmPlayBtn', start: '#pmTlGoStartBtn', end: '#pmTlGoEndBtn', prevItem: '#pmPrevEventBtn', nextItem: '#pmNextEventBtn', prevFrame: '#pmPrevFrameBtn', nextFrame: '#pmNextFrameBtn' },
  },
  {
    name: 'vfx',
    container: '.pfx-vfx-plr-btns',
    // The player's own full-width scrubber row is redundant now that the unified
    // bar has its own scrub — hide it (it's the sole child of .pfx-vfx-plr-scrub-row).
    hideAlso: ['.pfx-vfx-plr-scrub-row'],
    video: ['pmVideo'],
    itemsType: 'cuts',
    btn: { play: '#pfxVfxPlrPlay', start: '#pfxVfxPlrGoStart', end: '#pfxVfxPlrGoEnd', prevItem: '#pfxVfxPlrPrevCut', nextItem: '#pfxVfxPlrNextCut', prevFrame: '#pfxVfxPlrPrevFrame', nextFrame: '#pfxVfxPlrNextFrame' },
  },
  {
    name: 'vfxws',
    container: '.pm-vfx-ws-scrub-nav',
    slider: '#pmWsScrubSlider',
    video: [],
    itemsType: 'shots',
    startJump: '#pmWsScrub [data-jump="handleStart"]',
    endJump: '#pmWsScrub [data-jump="handleEnd"]',
    btn: { play: '#pmWsPlayBtn', prevFrame: '#pmWsScrubPrev', nextFrame: '#pmWsScrubNext' },
    canPlay: ({ btn }) => { const b = btn('play'); return !!b && !b.disabled; },
  },
  {
    name: 'cutdiff2',
    container: '#main-cutdiff2 .cd-vcmp-transport5',
    // Cut Diff keeps its OWN full-width scrubber (#cd2x-vc-scrub) as the single
    // "long scrub bar"; the unified bar's own scrub row is hidden via CSS
    // (`data-pfx-tx-name="cutdiff2"`) so there's only one scrub. The leftover
    // rate-select + TC field row below the buttons is removed (per request).
    hideAlso: ['#main-cutdiff2 .cd-vcmp-rate', '#main-cutdiff2 .cd-vcmp-tcwrap'],
    slider: '#cd2x-vc-scrub',
    video: ['cd2x-vc-vid-new', 'cd2x-vc-vid-old'],
    itemsType: 'cuts',
    btn: { play: '#cd2x-vc-play', start: '#cd2x-vc-home', end: '#cd2x-vc-end', loop: '#cd2x-vc-loop', prevFrame: '#cd2x-vc-prev-f', nextFrame: '#cd2x-vc-next-f' },
  },
  {
    name: 'cutdiff',
    container: '#cutdiffVcmpProBar .cd-vcmp-transport5',
    video: ['cutdiffVcmpNewVid', 'cutdiffVcmpOldVid'],
    itemsType: 'cuts',
    btn: { play: '#cutdiffVcmpPlay', start: '#cutdiffVcmpHome', end: '#cutdiffVcmpEnd', loop: '#cutdiffVcmpLoop', prevFrame: '#cutdiffVcmpPrevF', nextFrame: '#cutdiffVcmpNextF' },
  },
  {
    name: 'sly',
    container: '.pm-sly-cmp-transport',
    video: ['pmSlyCmpVideo', 'pmVideo'],
    itemsType: 'markers',
    btn: { play: '#pmSlyCmpPlayBtn', start: '#pmSlyCmpJumpStart', end: '#pmSlyCmpJumpEnd', prevItem: '#pmSlyCmpPrevMk', nextItem: '#pmSlyCmpNextMk', loop: '#pmSlyCmpLoopBtn', prevFrame: '#pmSlyCmpStepBack', nextFrame: '#pmSlyCmpStepFwd' },
  },
];

function tryMount(cfg) {
  const container = qs(cfg.container);
  if (!container || container.dataset.pfxTxMounted === '1') return;
  const parent = container.parentElement;
  if (!parent) return;

  const host = document.createElement('div');
  host.className = 'pfx-tx-host';
  parent.insertBefore(host, container);

  const adapter = makeDelegatingAdapter(cfg);
  adapter.host = host;
  const ctrl = mountTransport(adapter);
  if (!ctrl) { host.remove(); return; }
  // If a still-connected controller was returned, its bar lives in a previous
  // host — the one we just created is empty, so remove it (avoid orphan divs).
  if (ctrl.el && ctrl.el.parentElement !== host) { try { host.remove(); } catch {} }

  container.dataset.pfxTxMounted = '1';
  hide(container);
  (cfg.hideAlso || []).forEach(sel => hide(qs(sel)));
}

let _t = 0, _mo = null;
function mountAll() { CONFIGS.forEach(tryMount); }

function init() {
  mountAll();
  try {
    _mo = new MutationObserver(() => { clearTimeout(_t); _t = setTimeout(mountAll, 150); });
    _mo.observe(document.body, { childList: true, subtree: true });
  } catch {}
  try { window.PfxTransportMount = { refresh: mountAll }; } catch {}
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

export { mountAll, makeDelegatingAdapter };
