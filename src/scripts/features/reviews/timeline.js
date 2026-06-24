// PostFlowX – VFX Reviews Virtual Timeline UI

import { secondsToClock } from './store.js';

// ---- Color helpers (Resolve-style clip colors, subtle + consistent) ----
function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

function hslToRgb(h, s, l) {
  // h:0-360, s/l:0-100
  h = (Number(h) || 0) / 360;
  s = (Number(s) || 0) / 100;
  l = (Number(l) || 0) / 100;
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r, g, b;
  if (s === 0) {
    r = g = b = l; // achromatic
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function shotKey(name) {
  const n = String(name || '').trim();
  if (!n) return '';
  // strip extension
  let base = n.replace(/\.(mov|mp4|mxf|exr)$/i, '');
  // strip common version tokens
  base = base
    .replace(/[_-](v|ver)\d{1,4}$/i, '')
    .replace(/[_-](comp|temp|final|review|qc)\d{0,3}$/i, '')
    .replace(/[_-]\d{8,}$/i, '');
  return base;
}

function parseVersionNum(name) {
  const n = String(name || '').replace(/\.(mov|mp4|mxf|exr)$/i, '');
  const m = n.match(/(?:^|[._-])(v|ver|version)\s*0*(\d+)$/i);
  if (!m) return 0;
  const v = parseInt(m[2], 10);
  return Number.isFinite(v) ? v : 0;
}

function parseShotKeyName(name) {
  const n = String(name || '').replace(/\.(mov|mp4|mxf|exr)$/i, '');
  return n.replace(/(?:^|[._-])(v|ver|version)\s*0*\d+$/i, '');
}

const pad2 = (n) => String(Math.max(0, Number(n) || 0)).padStart(2, '0');

function segRgb(name, kind) {
  const key = shotKey(name) || String(name || '');
  const hue = hashHue(key);
  // V1 slightly darker, V2 slightly brighter
  const s = kind === 'v2' ? 72 : 62;
  const l = kind === 'v2' ? 42 : 36;
  return hslToRgb(hue, s, l).join(',');
}

// Timeline renders V1/V2 segments + playhead + time badge.
// Notes are created automatically when adding V2 overlays and are managed in the right panel.
// V1 Auto Cut markers are also rendered so users can review / adjust cut boundaries directly.
export function createTimeline({ store, onScrub, onAddOverlay, onSelectV1Cut }) {
  const root = document.createElement('div');
  root.className = 'pfx-reviews-timeline';

  const scroll = document.createElement('div');
  scroll.className = 'pfx-reviews-timelineScroll';

  const inner = document.createElement('div');
  inner.className = 'pfx-reviews-timelineInner';

  const v2Row = document.createElement('div');
  v2Row.className = 'pfx-reviews-segRow pfx-reviews-segRowV2';

  const v1Row = document.createElement('div');
  v1Row.className = 'pfx-reviews-segRow pfx-reviews-segRowV1';

  const cutLayer = document.createElement('div');
  cutLayer.className = 'pfx-reviews-cutLayer';

  const uncertainLayer = document.createElement('div');
  uncertainLayer.className = 'pfx-reviews-cutLayer pfx-reviews-cutLayer--uncertain';

  const playhead = document.createElement('div');
  playhead.className = 'pfx-reviews-playhead';

  const timeBadge = document.createElement('div');
  timeBadge.className = 'pfx-reviews-timeBadge';
  timeBadge.textContent = '00:00:00.000';

  inner.appendChild(v2Row);
  inner.appendChild(v1Row);
  inner.appendChild(cutLayer);
  inner.appendChild(uncertainLayer);
  inner.appendChild(playhead);
  inner.appendChild(timeBadge);

  scroll.appendChild(inner);
  root.appendChild(scroll);

  let dragging = false;
  let userScrollActive = false;
  let userScrollTimer = 0;
  let v1SegEls = [];
  let v2OverlayEls = new Map();
  let lastActiveEl = null;
  let lastActiveKey = '';
  let lastTimeBadgeText = '';

  try { playhead.style.willChange = 'transform'; } catch {}
  try { timeBadge.style.willChange = 'left'; } catch {}

  const pxPerSec = () => store.state.pxPerSec;
  const snapSec = (sec) => {
    const fps = Math.max(1, Number(store.state.fps) || 24);
    return Math.round((Number(sec) || 0) * fps) / fps;
  };

  const setInnerWidth = () => {
    const total = store.totalDurationSec();
    inner.style.width = `${Math.max(1, total * pxPerSec())}px`;
  };

  let dragOverlayId = null;
  let dragOverlayOffsetPx = 0;

  // Version menu (for V2 overlays)
  let verMenuEl = null;
  const closeVerMenu = () => {
    if (!verMenuEl) return;
    try { verMenuEl.remove(); } catch {}
    verMenuEl = null;
  };
  // Close on outside click / escape
  root.addEventListener('click', closeVerMenu);
  const onVerMenuKeydown = (e) => {
    if (e.key === 'Escape') closeVerMenu();
  };
  if (!window.__pfxVerMenuKeydownBound) {
    window.addEventListener('keydown', onVerMenuKeydown);
    window.__pfxVerMenuKeydownBound = true;
  }

  const openVerMenu = (clientX, clientY, ovl, versions) => {
    closeVerMenu();
    const menu = document.createElement('div');
    menu.className = 'pfx-reviews-verMenu';
    menu.style.left = `${Math.max(8, clientX)}px`;
    menu.style.top = `${Math.max(8, clientY)}px`;

    const head = document.createElement('div');
    head.className = 'pfx-reviews-verMenuHead';
    head.textContent = 'Switch Version';
    menu.appendChild(head);

    for (const c of versions) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'pfx-reviews-verMenuItem';
      const v = c.version || parseVersionNum(c.name);
      item.textContent = `v${pad2(v)}  ${c.name}`;
      if (c.id === ovl.clipId) item.classList.add('is-active');
      item.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        store.setOverlayClip(ovl.id, c.id);
        closeVerMenu();
      });
      menu.appendChild(item);
    }

    // prevent closing when clicking inside
    menu.addEventListener('click', (e) => e.stopPropagation());
    document.body.appendChild(menu);
    verMenuEl = menu;
  };

  const renderSegments = () => {
    v1Row.innerHTML = '';
    v2Row.innerHTML = '';
    v1SegEls = [];
    v2OverlayEls = new Map();
    lastActiveEl = null;
    lastActiveKey = '';

    // V1 sequential clips
    const segs = store.state.segments;
    for (const s of segs) {
      const seg = document.createElement('div');
      seg.className = 'pfx-reviews-seg is-v1';
      seg.style.width = `${Math.max(1, s.durationSec * pxPerSec())}px`;
      seg.style.setProperty('--segColor', segRgb(s.name, 'v1'));
      seg.dataset.index = String(s.index);

      const label = document.createElement('div');
      label.className = 'pfx-reviews-segLabel';
      label.textContent = String(s.baseName || s.name || '');
      label.title = (Number(s.subCount) || 1) > 1
        ? `${String(s.baseName || s.name || '')} · segment ${String((Number(s.subIndex) || 0) + 1).padStart(3, '0')}`
        : String(s.baseName || s.name || '');

      if ((Number(s.subCount) || 1) > 1) {
        seg.classList.add('has-segnum');
        const num = document.createElement('div');
        num.className = 'pfx-reviews-segNum';
        num.textContent = String((Number(s.subIndex) || 0) + 1).padStart(3, '0');
        num.title = `Segment ${String((Number(s.subIndex) || 0) + 1).padStart(3, '0')}`;
        seg.appendChild(num);
      }

      if (!s.canPlay) seg.classList.add('is-disabled');

      seg.appendChild(label);

      // Remove from V1 timeline ONLY (keep in Bin)
      // When V1 is auto-split into many sub-segments, show the remove button only
      // on the first sub-segment to avoid looking like we remove a single shot.
      if ((Number(s.subIndex) || 0) === 0) {
        const xBtn = document.createElement('button');
        xBtn.className = 'pfx-reviews-segX';
        xBtn.type = 'button';
        xBtn.textContent = '✕';
        xBtn.title = 'Remove from timeline (keep in Bin)';
        // IMPORTANT: the timeline scrubber uses pointer capture on the inner layer.
        // If we don't stop pointerdown here, inner will capture and the click won't reach this button.
        xBtn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        xBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          store.removeTimelineSegment(s.index);
        });
        seg.appendChild(xBtn);
      }

      seg.addEventListener('click', (e) => {
        e.preventDefault();
        const idx = Number(seg.dataset.index);
        const segObj = store.state.segments[idx];
        if (segObj) onScrub(segObj.globalStartSec);
      });

      v1Row.appendChild(seg);
      v1SegEls[s.index] = seg;
    }

    // V2 overlays (absolute)
    for (const o of store.state.overlays) {
      const seg = document.createElement('div');
      seg.className = 'pfx-reviews-seg is-v2';
      seg.style.left = `${Math.max(0, (Number(o.globalStartSec) || 0) * pxPerSec())}px`;
      seg.style.width = `${Math.max(1, (Number(o.durationSec) || 0) * pxPerSec())}px`;
      seg.style.setProperty('--segColor', segRgb(o.name, 'v2'));
      seg.dataset.ovlId = String(o.id);

      const label = document.createElement('div');
      label.className = 'pfx-reviews-segLabel';
      label.textContent = o.name;
      seg.appendChild(label);

      // Smart version switcher (if multiple versions exist in Bin)
      const key = o.shotKey || parseShotKeyName(o.name) || shotKey(o.name);
      const versions = store.getVersionsForShotKey ? store.getVersionsForShotKey(key) : [];
      if (versions && versions.length > 1) {
        seg.classList.add('has-ver');
        const vBtn = document.createElement('button');
        vBtn.type = 'button';
        vBtn.className = 'pfx-reviews-segVer';
        const v = o.version || parseVersionNum(o.name);
        const vLabel = `v${pad2(v)}`;
        vBtn.innerHTML = `<span class="pfx-reviews-segVerIcon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M7 7h10"/><path d="M13 3l4 4-4 4"/><path d="M17 17H7"/><path d="M11 13l-4 4 4 4"/></svg></span><span class="pfx-reviews-segVerText">${vLabel}</span>`;
        vBtn.title = 'Switch V2 version (click to cycle, right-click to choose)';
        vBtn.setAttribute('aria-label', `Switch V2 version: ${vLabel}`);
        vBtn.addEventListener('pointerdown', (e) => {
          e.preventDefault();
          e.stopPropagation();
        });
        vBtn.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          store.cycleOverlayVersion(o.id, e.shiftKey ? -1 : 1);
        });
        vBtn.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          openVerMenu(e.clientX, e.clientY, o, versions);
        });
        seg.appendChild(vBtn);
      }

      const xBtn = document.createElement('button');
      xBtn.className = 'pfx-reviews-segX';
      xBtn.type = 'button';
      xBtn.textContent = '✕';
      xBtn.title = 'Remove overlay';
      xBtn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      xBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        store.removeOverlay(o.id);
      });
      seg.appendChild(xBtn);

      if (!o.canPlay) seg.classList.add('is-disabled');

      seg.addEventListener('click', (e) => {
        e.preventDefault();
        onScrub(Number(o.globalStartSec) || 0);
      });

      // Drag to move (Resolve-style)
      seg.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        dragOverlayId = o.id;
        const rect = scroll.getBoundingClientRect();
        const x = e.clientX - rect.left + scroll.scrollLeft;
        const segLeft = (Number(o.globalStartSec) || 0) * pxPerSec();
        dragOverlayOffsetPx = Math.max(0, x - segLeft);
        seg.setPointerCapture(e.pointerId);
      });

      seg.addEventListener('pointermove', (e) => {
        if (!dragOverlayId || dragOverlayId !== o.id) return;
        const rect = scroll.getBoundingClientRect();
        const x = e.clientX - rect.left + scroll.scrollLeft;
        const startPx = Math.max(0, x - dragOverlayOffsetPx);
        const startSec = snapSec(startPx / pxPerSec());
        store.moveOverlay(o.id, startSec);
      });

      seg.addEventListener('pointerup', () => {
        if (dragOverlayId === o.id) dragOverlayId = null;
      });

      seg.addEventListener('pointercancel', () => {
        if (dragOverlayId === o.id) dragOverlayId = null;
      });

      v2Row.appendChild(seg);
      v2OverlayEls.set(String(o.id), seg);
    }

    renderCutMarkers();
  };

  const sameSelectedCut = (sel, cut) => {
    const fps = Math.max(1, Number(store.state.fps) || 24);
    return !!(sel && cut && String(sel.clipId || '') === String(cut.clipId || '') && Math.abs((Number(sel.timeSec) || 0) - (Number(cut.timeSec) || 0)) <= (0.75 / fps));
  };

  const cutLabel = (cut) => {
    const type = String(cut?.type || 'hard_cut').replace(/_/g, ' ');
    const conf = (cut?.confidence == null) ? '' : ` · ${Math.round(Math.max(0, Math.min(1, Number(cut.confidence) || 0)) * 100)}%`;
    const flag = cut?.uncertain ? ' · uncertain' : '';
    return `${type}${conf}${flag}`;
  };

  const renderCutMarkers = () => {
    cutLayer.innerHTML = '';
    uncertainLayer.innerHTML = '';
    const viewMode = String(store.state?.v1CutViewMode || 'all');
    const cuts = ((typeof store.getV1CutMarkers === 'function') ? store.getV1CutMarkers() : [])
      .filter((cut) => viewMode !== 'uncertain' || cut?.uncertain);
    const selected = store.state?.selectedV1Cut || null;
    const makeMarker = (cut) => {
      const marker = document.createElement('button');
      marker.type = 'button';
      marker.className = 'pfx-reviews-cutMarker';
      if (viewMode === 'uncertain') marker.classList.add('is-filtered-view');
      marker.dataset.clipId = String(cut.clipId || '');
      marker.dataset.cutTimeSec = String(Number(cut.timeSec) || 0);
      marker.dataset.cutType = String(cut.type || 'hard_cut');
      if (cut.uncertain) marker.classList.add('is-uncertain');
      if (sameSelectedCut(selected, cut)) marker.classList.add('is-selected');
      marker.classList.add(`is-${String(cut.type || 'hard_cut').replace(/[^a-z0-9_-]/gi, '-')}`);
      marker.style.left = `${Math.max(0, (Number(cut.globalTimeSec) || 0) * pxPerSec())}px`;
      marker.title = `${secondsToClock(cut.globalTimeSec || 0)} · ${cutLabel(cut)}${cut?.reason ? ` · ${String(cut.reason)}` : ''}`;
      marker.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      marker.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try { if (typeof onSelectV1Cut === 'function') onSelectV1Cut(cut); } catch {}
        try { onScrub(Number(cut.globalTimeSec) || 0); } catch {}
      });
      return marker;
    };
    for (const cut of cuts) {
      const marker = makeMarker(cut);
      if (cut?.uncertain) uncertainLayer.appendChild(marker);
      else cutLayer.appendChild(marker);
    }
  };

  const updatePlayhead = () => {
    const x = store.state.globalTimeSec * pxPerSec();
    try { playhead.style.transform = `translateX(${x}px)`; } catch { playhead.style.left = `${x}px`; }
    timeBadge.style.left = `${x}px`;
    const badgeText = secondsToClock(store.state.globalTimeSec);
    if (badgeText !== lastTimeBadgeText) {
      timeBadge.textContent = badgeText;
      lastTimeBadgeText = badgeText;
    }

    // Soft auto-follow (avoid fighting user scroll)
    if (!userScrollActive) {
      const margin = 80;
      const left = scroll.scrollLeft;
      const right = left + scroll.clientWidth;
      if (x < left + margin) {
        scroll.scrollLeft = Math.max(0, x - margin);
      } else if (x > right - margin) {
        scroll.scrollLeft = Math.max(0, x - scroll.clientWidth + margin);
      }
    }

    // highlight active (V2 priority) without scanning the whole DOM every frame
    let nextActiveEl = null;
    let nextKey = '';
    if (store.state.activeLayer === 'V2' && store.state.activeOverlayId) {
      nextKey = `v2:${String(store.state.activeOverlayId)}`;
      nextActiveEl = v2OverlayEls.get(String(store.state.activeOverlayId)) || null;
    } else {
      nextKey = `v1:${String(store.state.activeIndex)}`;
      nextActiveEl = v1SegEls[Number(store.state.activeIndex)] || null;
    }
    if (nextKey !== lastActiveKey) {
      if (lastActiveEl) lastActiveEl.classList.remove('is-active');
      if (nextActiveEl) nextActiveEl.classList.add('is-active');
      lastActiveEl = nextActiveEl;
      lastActiveKey = nextKey;
    }
  };

  const scrubFromClientX = (clientX) => {
    const rect = scroll.getBoundingClientRect();
    const x = clientX - rect.left + scroll.scrollLeft;
    const t = Math.max(0, x / pxPerSec());
    onScrub(t);
  };

  // Drop to add V2 overlays
  v2Row.addEventListener('dragover', (e) => {
    const clipId = e.dataTransfer?.getData('text/pfx-clip-id');
    if (!clipId) return;
    e.preventDefault();
  });

  v2Row.addEventListener('drop', async (e) => {
    const clipId = e.dataTransfer?.getData('text/pfx-clip-id');
    if (!clipId) return;
    e.preventDefault();
    const rect = scroll.getBoundingClientRect();
    const x = e.clientX - rect.left + scroll.scrollLeft;
    const t = snapSec(Math.max(0, x / pxPerSec()));
    if (typeof onAddOverlay === 'function') {
      await onAddOverlay(clipId, t);
    } else {
      store.addOverlay(clipId, t);
      onScrub(t);
    }
  });

  // Drop to append to V1 timeline (explicit edit)
  v1Row.addEventListener('dragover', (e) => {
    const clipId = e.dataTransfer?.getData('text/pfx-clip-id');
    if (!clipId) return;
    e.preventDefault();
  });

  v1Row.addEventListener('drop', (e) => {
    const clipId = e.dataTransfer?.getData('text/pfx-clip-id');
    if (!clipId) return;
    e.preventDefault();
    store.appendToTimeline(clipId);
    const last = store.state.segments[store.state.segments.length - 1];
    if (last) onScrub(last.globalStartSec);
  });

  inner.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // Don't scrub/capture when interacting with buttons/markers.
    const t = e.target;
    if (t && (t.closest?.('.pfx-reviews-segX') || t.closest?.('.pfx-reviews-timeBadge') || t.closest?.('.pfx-reviews-cutMarker'))) {
      return;
    }
    dragging = true;
    inner.setPointerCapture(e.pointerId);
    scrubFromClientX(e.clientX);
  });

  inner.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    scrubFromClientX(e.clientX);
  });

  inner.addEventListener('pointerup', () => {
    dragging = false;
  });

  scroll.addEventListener('scroll', () => {
    userScrollActive = true;
    clearTimeout(userScrollTimer);
    userScrollTimer = setTimeout(() => (userScrollActive = false), 500);
  }, { passive: true });

  const unsubscribe = store.subscribe((_, action) => {
    if (action === 'clips' || action === 'clips_added' || action === 'overlays' || action === 'cuts') {
      setInnerWidth();
      renderSegments();
      updatePlayhead();
    }
    // markers: intentionally ignored (notes panel owns this UX now)
    if (action === 'time' || action === 'active') {
      updatePlayhead();
    }
    if (action === 'zoom') {
      setInnerWidth();
      renderSegments();
      updatePlayhead();
    }
  });

  // Initial
  setInnerWidth();
  renderSegments();
  updatePlayhead();

  return {
    el: root,
    scrollEl: scroll,
    setZoom: (px) => {
      const MIN_PX = 0.01;
      const MAX_PX = 800;
      store.set({ pxPerSec: Math.max(MIN_PX, Math.min(MAX_PX, Number(px) || 80)) }, 'zoom');
    },
    jumpToTime: (t) => {
      const x = (Number(t) || 0) * pxPerSec();
      scroll.scrollLeft = Math.max(0, x - scroll.clientWidth / 2);
    },
    destroy: () => {
      unsubscribe();
      clearTimeout(userScrollTimer);
      try { root.removeEventListener('click', closeVerMenu); } catch {}
      try { window.removeEventListener('keydown', onVerMenuKeydown); } catch {}
      try { closeVerMenu(); } catch {}
    }
  };
}
