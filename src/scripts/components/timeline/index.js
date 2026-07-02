// scripts/app/components/timeline/index.js
// Compact multi-video-layer timeline strip (no audio) rendered on <canvas>.
// - No external CSS required (injects minimal styles).
// - Data-driven: call api.setData({ clips, selectedId, timeStart, timeEnd, trackCount }).
//
// clip shape:
//   { id: string, track: number (1-based), start: number (frames), end: number (frames),
//     label?: string, flags?: string[], status?: 'ok'|'fail'|null }
//
// Notes:
// - This is intentionally dependency-free and safe to load even if not used.
// - Rendering is optimized for hundreds of clips (canvas).

const STYLE_ID = 'mps-timeline-strip-style-v1';

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .mpsTimelineStrip {
      position: relative;
      border-radius: 14px;
      border: 1px solid rgba(255,255,255,0.14);
      background:
        linear-gradient(180deg, rgba(255,255,255,0.10), rgba(255,255,255,0.03)),
        rgba(16,18,24,0.55);
      backdrop-filter: blur(16px) saturate(155%);
      -webkit-backdrop-filter: blur(16px) saturate(155%);
      box-shadow: 0 10px 30px rgba(0,0,0,0.35);
      overflow: hidden;
    }
    .mpsTimelineStrip__header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      padding: 10px 14px 6px 14px;
      gap: 12px;
      user-select: none;
      -webkit-user-select: none;
    }
    .mpsTimelineStrip__title {
      font-weight: 650;
      letter-spacing: 0.2px;
      color: rgba(240,242,255,0.92);
      font-size: 13px;
      white-space: nowrap;
    }
    .mpsTimelineStrip__legend {
      color: rgba(200,205,220,0.78);
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      flex: 1;
      text-align: right;
    }
    .mpsTimelineStrip canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
    .mpsTimelineStrip__hint {
      position: absolute;
      right: 12px;
      bottom: 10px;
      color: rgba(200,205,220,0.60);
      font-size: 11px;
      user-select: none;
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
}

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0);
}

const PALETTES = [
  { fillA: 'rgba(150,90,255,0.95)', fillB: 'rgba(90,60,200,0.95)', stroke: 'rgba(255,255,255,0.22)', strokeHi: 'rgba(235,165,255,0.85)' }, // purple
  { fillA: 'rgba(80,210,160,0.90)', fillB: 'rgba(40,150,120,0.92)', stroke: 'rgba(255,255,255,0.18)', strokeHi: 'rgba(200,255,235,0.80)' }, // green
  { fillA: 'rgba(90,170,255,0.92)', fillB: 'rgba(55,105,220,0.94)', stroke: 'rgba(255,255,255,0.18)', strokeHi: 'rgba(210,240,255,0.85)' }, // blue
  { fillA: 'rgba(255,140,90,0.92)', fillB: 'rgba(205,80,70,0.94)', stroke: 'rgba(255,255,255,0.18)', strokeHi: 'rgba(255,225,205,0.85)' }, // orange/red
];

// Read DIFF colors from CSS vars so the timeline matches the rest of the UI.
function _hexToRgb(hex){
  if (!hex) return null;
  const h = String(hex).trim().replace('#','');
  if (h.length === 3){
    const r = parseInt(h[0]+h[0], 16);
    const g = parseInt(h[1]+h[1], 16);
    const b = parseInt(h[2]+h[2], 16);
    return { r, g, b };
  }
  if (h.length === 6){
    const r = parseInt(h.slice(0,2), 16);
    const g = parseInt(h.slice(2,4), 16);
    const b = parseInt(h.slice(4,6), 16);
    return { r, g, b };
  }
  return null;
}

function _rgba(rgb, a){
  if (!rgb) return `rgba(255,255,255,${a})`;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${a})`;
}

function _readCssVar(name, fallback){
  try{
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }catch{ return fallback; }
}

function _buildDiffPalettes(){
  const mk = (hexFallback) => {
    const rgb = _hexToRgb(hexFallback);
    return {
      fillA: _rgba(rgb, 0.92),
      fillB: _rgba(rgb, 0.74),
      stroke: _rgba(rgb, 0.24),
      strokeHi: _rgba(rgb, 0.56),
    };
  };
  return {
    NEW: mk(_readCssVar('--diff-new', '#2be6a7')),
    EXTENDED: mk(_readCssVar('--diff-extended', '#5aa2ff')),
    CHANGED: mk(_readCssVar('--diff-changed', '#ffb84a')),
  };
}

function _clipDiffType(clip){
  const flags = Array.isArray(clip?.flags) ? clip.flags : [];
  for (const f of flags){
    const s = String(f || '').toUpperCase();
    if (s === 'NEW' || s === 'EXTENDED' || s === 'CHANGED') return s;
  }
  return null;
}

function pickPalette(key) {
  const k = String(key || '');
  const h = hashStr(k);
  const idx = h % PALETTES.length;
  return PALETTES[idx];
}

function tcFromFrames(frames, fps) {
  // frames are integer relative; show as mm:ss:ff for compactness
  const total = Math.max(0, Math.floor(frames));
  const ff = total % fps;
  const totalSeconds = Math.floor(total / fps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60) % 60;
  const hh = Math.floor(totalSeconds / 3600);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

export function createTimeline(rootEl, options = {}) {
  injectStyles();

  // `?? 24` only defaults null/undefined — fps:0 would slip through and make
  // tcFromFrames/niceStepFrames divide by zero (NaN/Infinity ruler). Guard >0.
  const fps = Number(options.fps) > 0 ? Number(options.fps) : 24;
  const onSelect = typeof options.onSelect === 'function' ? options.onSelect : () => {};
  const onHover = typeof options.onHover === 'function' ? options.onHover : () => {};
  const onViewChange = typeof options.onViewChange === 'function' ? options.onViewChange : () => {};

  const container = document.createElement('div');
  container.className = 'mpsTimelineStrip';
  container.style.height = (options.fill === true)
    ? '100%'
    : ((options.heightPx ?? 140) + 'px');

  const header = document.createElement('div');
  header.className = 'mpsTimelineStrip__header';

  const title = document.createElement('div');
  title.className = 'mpsTimelineStrip__title';
  title.textContent = options.title ?? 'Timeline (Video layers only)';

  const legend = document.createElement('div');
  legend.className = 'mpsTimelineStrip__legend';
  legend.textContent = options.legend ?? '⚡ Speed   ⤢ Transform   🎯 AdvFDL   🧷 Handles   ✅ Updated   ❌ Failed';

  header.appendChild(title);
  header.appendChild(legend);

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'Timeline');
  canvas.style.height = 'calc(100% - 34px)';

  const hint = document.createElement('div');
  hint.className = 'mpsTimelineStrip__hint';
  hint.textContent = options.hint ?? 'Shift+Wheel: pan • Ctrl+Wheel: zoom';

  container.appendChild(header);
  container.appendChild(canvas);
  container.appendChild(hint);
  rootEl.appendChild(container);

  const ctx = canvas.getContext('2d', { alpha: true });

  let state = {
    clips: [],
    selectedId: null,
    timeStart: 0,
    timeEnd: 1,
    trackCount: 1,
    zoom: 1.0,
    pan: 0.0, // normalized [0..1] left offset
    playheadFrame: typeof options.playheadFrame === 'number' ? options.playheadFrame : null,
    autoFollow: !!options.autoFollow,
  };

  // Fixed palettes for diff types
  const diffPals = _buildDiffPalettes();

  // For hit-testing
  let lastLayout = {
    clips: [], // {id, x0,x1,y0,y1}
    ruler: { x0: 0, x1: 0, y: 0 },
    tracks: { top: 0, bottom: 0, rowH: 0, gap: 0, labelW: 0 }
  };

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(rect.width * dpr));
    canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function computeViewRange() {
    const fullSpan = Math.max(1, state.timeEnd - state.timeStart);
    const viewSpan = fullSpan / clamp(state.zoom, 1, 50);
    const maxPan = fullSpan - viewSpan;
    const panFrames = clamp(state.pan * maxPan, 0, Math.max(0, maxPan));
    const viewStart = state.timeStart + panFrames;
    const viewEnd = viewStart + viewSpan;
    return { viewStart, viewEnd, fullSpan, viewSpan };
  }

  function draw() {
    resizeCanvas();
    const w = canvas.getBoundingClientRect().width;
    const h = canvas.getBoundingClientRect().height;

    ctx.clearRect(0, 0, w, h);

    // Background panel gradient (matches the dark glossy UI)
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, 'rgba(18,20,26,0.98)');
    bg.addColorStop(1, 'rgba(11,12,16,0.98)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // Layout
    const pad = 10;
    const labelW = 34;
    const rulerH = 22;
    const top = pad;
    const rulerY = top + 10;
    const tracksTop = top + rulerH + 8;
    const tracksBottom = h - pad;
    const trackCount = Math.max(1, Math.floor(state.trackCount || 1));
    const gap = 6;
    const rowH = Math.max(14, Math.floor((tracksBottom - tracksTop - gap * (trackCount - 1)) / trackCount));

    const x0 = pad + labelW + 8;
    const x1 = w - pad;

    lastLayout.ruler = { x0, x1, y: rulerY };
    lastLayout.tracks = { top: tracksTop, bottom: tracksBottom, rowH, gap, labelW };

    // Ruler line
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(210,215,235,0.28)';
    ctx.beginPath();
    ctx.moveTo(x0, rulerY);
    ctx.lineTo(x1, rulerY);
    ctx.stroke();

    const { viewStart, viewEnd, viewSpan } = computeViewRange();

    // ticks
    const approxTicks = 6;
    const step = viewSpan / approxTicks;
    const niceStep = niceStepFrames(step, fps);
    const firstTick = Math.floor(viewStart / niceStep) * niceStep;

    ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    ctx.fillStyle = 'rgba(200,205,220,0.75)';
    ctx.strokeStyle = 'rgba(210,215,235,0.28)';

    for (let t = firstTick; t <= viewEnd + niceStep; t += niceStep) {
      const nx = (t - viewStart) / (viewEnd - viewStart);
      const tx = x0 + nx * (x1 - x0);
      ctx.beginPath();
      ctx.moveTo(tx, rulerY - 6);
      ctx.lineTo(tx, rulerY + 8);
      ctx.stroke();
      ctx.fillText(tcFromFrames(t, fps), tx - 24, rulerY - 9);
    }

    // Track labels & separators + grid
    ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    for (let i = 0; i < trackCount; i++) {
      const y0 = tracksTop + i * (rowH + gap);
      const y1 = y0 + rowH;

      // row fill (alternate subtle shades)
      ctx.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.02)';
      roundedRectFill(ctx, x0, y0, x1 - x0, rowH, 10);

      // label Vn (top is highest track number)
      const trackNum = trackCount - i;
      ctx.fillStyle = 'rgba(200,205,220,0.70)';
      ctx.fillText(`V${trackNum}`, pad + 2, y0 + rowH * 0.72);

      // track outline
      ctx.strokeStyle = 'rgba(255,255,255,0.10)';
      roundedRectStroke(ctx, x0, y0, x1 - x0, rowH, 8);
    }

    // vertical grid lines (faint, behind clips)
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let t = firstTick; t <= viewEnd + niceStep; t += niceStep) {
      const nx = (t - viewStart) / (viewEnd - viewStart);
      const tx = x0 + nx * (x1 - x0);
      ctx.beginPath();
      ctx.moveTo(tx, tracksTop);
      ctx.lineTo(tx, tracksBottom);
      ctx.stroke();
    }

    // Clips
    lastLayout.clips = [];
    const byTrack = groupClipsByTrack(state.clips);

    for (let track = 1; track <= trackCount; track++) {
      const rowIndex = trackCount - track; // V1 bottom
      const yBase = tracksTop + rowIndex * (rowH + gap);
      const clipY0 = yBase + Math.max(2, Math.floor(rowH * 0.14));
      const clipY1 = yBase + rowH - Math.max(2, Math.floor(rowH * 0.12));
      const clipH = clipY1 - clipY0;

      const clips = byTrack.get(track) || [];
      for (const clip of clips) {
        const s = clip.start ?? 0;
        const e = clip.end ?? s + 1;
        const c0 = (s - viewStart) / (viewEnd - viewStart);
        const c1 = (e - viewStart) / (viewEnd - viewStart);
        const cx0 = x0 + clamp(c0, -0.2, 1.2) * (x1 - x0);
        const cx1 = x0 + clamp(c1, -0.2, 1.2) * (x1 - x0);
        if (cx1 < x0 || cx0 > x1) continue;

        const isDis = !!clip.disabled;
        const isSel = (!isDis) && (clip.id != null && clip.id === state.selectedId);

        // clip box (NLE-like colored blocks)
        const r = 10;
        const cw = Math.max(2, cx1 - cx0);

        const basePal = pickPalette(clip.label || String(clip.id || ''));
        const dt = _clipDiffType(clip);
        const pal0 = (dt && diffPals[dt]) ? diffPals[dt] : basePal;
        const pal = isDis
          ? { fillA: 'rgba(170,175,190,0.26)', fillB: 'rgba(120,125,140,0.22)', stroke: 'rgba(255,255,255,0.08)', strokeHi: 'rgba(255,120,120,0.20)' }
          : pal0;
        const grad = ctx.createLinearGradient(cx0, clipY0, cx0, clipY0 + clipH);
        grad.addColorStop(0, pal.fillA);
        grad.addColorStop(1, pal.fillB);

        ctx.save();
        if (isDis) ctx.globalAlpha = 0.22;
        ctx.shadowColor = isSel ? 'rgba(180,90,255,0.55)' : 'rgba(0,0,0,0.45)';
        ctx.shadowBlur = isSel ? 14 : 10;
        ctx.shadowOffsetY = 2;

        ctx.lineWidth = isSel ? 3 : 1.5;
        ctx.fillStyle = grad;
        ctx.strokeStyle = isSel ? pal.strokeHi : pal.stroke;
        roundedRectFillStroke(ctx, cx0, clipY0, cw, clipH, r);
        ctx.restore();

        // inner highlight (top gloss)
        // inner highlight (top gloss) — skip for disabled (visual-only)
        if (!isDis){
          ctx.save();
          ctx.globalAlpha = isSel ? 0.28 : 0.18;
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          roundedRectFill(ctx, cx0 + 1.2, clipY0 + 1.2, Math.max(0, cw - 2.4), Math.max(0, clipH * 0.42), r - 3);
          ctx.restore();
        }

        // label + flags (Resolve-style: hide labels on tiny clips; never label disabled)
        const showLabel = (!isDis) && (cw >= 70);
        if (showLabel){
          ctx.fillStyle = 'rgba(245,247,255,0.92)';
          ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
          const label = clip.label ?? String(clip.id ?? '');
          ctx.fillText(label, cx0 + 8, clipY0 + 14);
        }

        const flags = (!isDis) && Array.isArray(clip.flags) ? clip.flags.join(' ') : '';
        if (flags && cw >= 90) {
          ctx.fillStyle = isSel ? 'rgba(250,240,255,0.90)' : 'rgba(205,210,225,0.75)';
          ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
          ctx.fillText(flags, cx0 + 8, clipY0 + clipH - 6);
        }

        // status dot
        if (clip.status === 'ok' || clip.status === 'fail') {
          const dotR = 5;
          const dx = cx1 - 10;
          const dy = clipY0 + 10;
          ctx.beginPath();
          ctx.arc(dx, dy, dotR, 0, Math.PI * 2);
          ctx.fillStyle = clip.status === 'ok' ? 'rgba(90,210,150,0.95)' : 'rgba(255,95,95,0.95)';
          ctx.fill();
        }

        lastLayout.clips.push({ id: clip.id, disabled: !!clip.disabled, x0: cx0, x1: cx1, y0: clipY0, y1: clipY1 });
      }
    }

    // Playhead — prefer state.playheadFrame so setData() updates are live
    const _ph = typeof state.playheadFrame === 'number' ? state.playheadFrame
              : typeof options.playheadFrame === 'number' ? options.playheadFrame
              : null;
    if (_ph !== null) {
      const nx = (_ph - viewStart) / (viewEnd - viewStart);
      const px = x0 + nx * (x1 - x0);
      // Diamond head
      ctx.save();
      ctx.strokeStyle = 'rgba(255,80,80,0.92)';
      ctx.fillStyle  = 'rgba(255,80,80,0.92)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, top + 6);
      ctx.lineTo(px + 6, top);
      ctx.lineTo(px - 6, top);
      ctx.closePath();
      ctx.fill();
      // Stem
      ctx.beginPath();
      ctx.moveTo(px, top + 6);
      ctx.lineTo(px, tracksBottom);
      ctx.stroke();
      ctx.restore();
    }
  }

  function niceStepFrames(stepFrames, fps) {
    // Choose a tick step that looks reasonable (in frames)
    const candidatesSeconds = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    const stepSeconds = stepFrames / fps;
    let best = candidatesSeconds[0];
    for (const c of candidatesSeconds) {
      if (c >= stepSeconds) { best = c; break; }
      best = c;
    }
    return best * fps;
  }

  function roundedRectFill(ctx, x, y, w, h, r) {
    ctx.beginPath();
    roundedRectPath(ctx, x, y, w, h, r);
    ctx.fill();
  }

  function roundedRectFillStroke(ctx, x, y, w, h, r) {
    ctx.beginPath();
    roundedRectPath(ctx, x, y, w, h, r);
    ctx.fill();
    ctx.stroke();
  }

  function roundedRectStroke(ctx, x, y, w, h, r) {
    ctx.beginPath();
    roundedRectPath(ctx, x, y, w, h, r);
    ctx.stroke();
  }

  function roundedRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function groupClipsByTrack(clips) {
    const m = new Map();
    for (const c of clips || []) {
      const t = Math.max(1, Math.floor(c.track || 1));
      if (!m.has(t)) m.set(t, []);
      m.get(t).push(c);
    }
    // Sort by start frame for stable draw
    for (const [k, arr] of m.entries()) arr.sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
    return m;
  }

  function hitTest(x, y) {
    // Disabled clips are visual-only (Resolve style): no hover/selection.
    for (let i = lastLayout.clips.length - 1; i >= 0; i--) {
      const c = lastLayout.clips[i];
      if (c.disabled) continue;
      if (x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1) return c.id;
    }
    return null;
  }

  function onPointerMove(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const id = hitTest(x, y);
    canvas.style.cursor = id ? 'pointer' : 'default';
    onHover(id);
  }

  function onClick(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const id = hitTest(x, y);
    if (id != null) onSelect(id);
  }

  // Scrolls the view so `frame` stays within the middle 60% of the viewport.
  // No-op if user is dragging or the frame is already in the focus zone.
  function _followPlayhead(frame) {
    if (dragPan) return;
    const { viewStart, viewEnd, viewSpan, fullSpan } = computeViewRange();
    const margin = viewSpan * 0.20; // 20% margin on each side = 60% focus zone
    if (frame >= viewStart + margin && frame <= viewEnd - margin) return;
    // Center on playhead
    const maxPan = Math.max(0, fullSpan - viewSpan);
    if (maxPan <= 0) return;
    const targetStart = clamp(frame - viewSpan * 0.5, state.timeStart, state.timeStart + maxPan);
    state.pan = clamp((targetStart - state.timeStart) / maxPan, 0, 1);
    try{ onViewChange({ zoom: state.zoom, pan: state.pan }); }catch{}
  }

  const wheelZoomMode = (options.wheelZoom === 'always') ? 'always' : 'ctrl';

  function applyZoomAt(dir, x01){
    const { viewStart, viewEnd } = computeViewRange();
    const span = viewEnd - viewStart;
    const anchor = viewStart + clamp(x01, 0, 1) * span;

    const nextZoom = clamp(state.zoom * (dir > 0 ? 1.12 : 1/1.12), 1, 50);
    const fullSpan = Math.max(1, state.timeEnd - state.timeStart);
    const nextSpan = fullSpan / nextZoom;

    let nextStart = anchor - clamp(x01, 0, 1) * nextSpan;
    const maxStart = state.timeStart + Math.max(0, fullSpan - nextSpan);
    nextStart = clamp(nextStart, state.timeStart, maxStart);

    state.zoom = nextZoom;
    state.pan = (maxStart <= state.timeStart) ? 0 : ((nextStart - state.timeStart) / (maxStart - state.timeStart));
    draw();
    try{ onViewChange({ zoom: state.zoom, pan: state.pan }); }catch{}
  }

  function panByPx(dxPx){
    const { viewStart, viewEnd } = computeViewRange();
    const span = viewEnd - viewStart;
    const fullSpan = Math.max(1, state.timeEnd - state.timeStart);
    const maxShift = Math.max(0, fullSpan - span);
    if (maxShift <= 0) return;
    const df = (dxPx / Math.max(1, canvas.clientWidth)) * span;
    const nextStart = clamp(viewStart - df, state.timeStart, state.timeStart + maxShift);
    state.pan = (nextStart - state.timeStart) / maxShift;
    draw();
  }

  function onWheel(ev) {
    // Shift: pan  |  Ctrl (or always): zoom
    const isCtrl = ev.ctrlKey || ev.metaKey;
    const isShift = ev.shiftKey;
    const allowZoom = (wheelZoomMode === 'always') || isCtrl;

    if (!isShift && !allowZoom) return;
    ev.preventDefault();

    if (isShift) {
      const delta = (ev.deltaY || ev.deltaX || 0);
      panByPx(delta);
      return;
    }

    // Zoom around cursor
    const rect = canvas.getBoundingClientRect();
    const x01 = (rect.width > 0) ? ((ev.clientX - rect.left) / rect.width) : 0.5;
    const dir = (ev.deltaY > 0) ? -1 : 1;
    applyZoomAt(dir, x01);
  }

  // Drag empty space to pan (like NLE)
  let dragPan = null;
  function onPointerDown(ev){
    if (ev.button != null && ev.button !== 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const hit = hitTest(x, y);
    if (hit != null) return; // clip selection handled by click

    dragPan = { x0: ev.clientX };
    canvas.setPointerCapture?.(ev.pointerId);
    canvas.style.cursor = 'grabbing';
    ev.preventDefault();
  }
  function onPointerMovePan(ev){
    if (!dragPan) return;
    const dx = ev.clientX - dragPan.x0;
    dragPan.x0 = ev.clientX;
    panByPx(dx);
  }
  function onPointerUp(){
    dragPan = null;
    canvas.style.cursor = 'default';
  }

  function onMouseLeave() { canvas.style.cursor = 'default'; onHover(null); }
  canvas.addEventListener('mousemove', onPointerMove);
  canvas.addEventListener('mouseleave', onMouseLeave);
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMovePan);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  const ro = new ResizeObserver(() => draw());
  ro.observe(container);

  const api = {
    el: container,
    setData(next) {
      const prevPh = state.playheadFrame;
      state = {
        ...state,
        ...next,
        timeStart: Number.isFinite(next.timeStart) ? next.timeStart : state.timeStart,
        timeEnd: Number.isFinite(next.timeEnd) ? next.timeEnd : state.timeEnd,
        trackCount: Number.isFinite(next.trackCount) ? next.trackCount : state.trackCount,
      };
      // Sanity
      if (!(state.timeEnd > state.timeStart)) state.timeEnd = state.timeStart + 1;
      state.trackCount = Math.max(1, Math.floor(state.trackCount));
      // Auto-follow: scroll when playhead moves outside the focus zone
      if (state.autoFollow && typeof state.playheadFrame === 'number' && state.playheadFrame !== prevPh) {
        _followPlayhead(state.playheadFrame);
      }
      draw();
      try{ onViewChange({ zoom: state.zoom, pan: state.pan }); }catch{}
    },
    scrollToFrame(frame) {
      const { viewSpan, fullSpan } = computeViewRange();
      const maxPan = Math.max(0, fullSpan - viewSpan);
      const target = clamp(frame - viewSpan * 0.5, state.timeStart, state.timeStart + maxPan);
      state.pan = maxPan > 0 ? clamp((target - state.timeStart) / maxPan, 0, 1) : 0;
      draw();
      try{ onViewChange({ zoom: state.zoom, pan: state.pan }); }catch{}
    },
    setAutoFollow(enabled) {
      state.autoFollow = !!enabled;
      if (state.autoFollow && typeof state.playheadFrame === 'number') {
        _followPlayhead(state.playheadFrame);
        draw();
      }
    },
    getViewState() {
      return { zoom: state.zoom, pan: state.pan };
    },
    setViewState(next = {}) {
      const nz = Number.isFinite(Number(next.zoom)) ? Number(next.zoom) : state.zoom;
      const np = Number.isFinite(Number(next.pan)) ? Number(next.pan) : state.pan;
      state.zoom = clamp(nz, 1, 50);
      state.pan = clamp(np, 0, 1);
      draw();
      try{ onViewChange({ zoom: state.zoom, pan: state.pan }); }catch{}
    },
    destroy() {
      ro.disconnect();
      canvas.removeEventListener('mousemove', onPointerMove);
      canvas.removeEventListener('mouseleave', onMouseLeave);
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMovePan);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      container.remove();
    }
  };

  // initial paint
  api.setData({});

  return api;
}
