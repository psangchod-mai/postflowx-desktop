// resolveVideoTransport.js — now a thin SHIM over the shared pfxTransport
// component. Kept so existing call sites (ACES Look, Plate Link) keep working
// unchanged; they automatically get the unified transport (scrub row + JKL +
// nav pod + color states) instead of the old bespoke `.pfx-rvt` bar.
//
//   import { attachResolveTransport } from '../../core/resolveVideoTransport.js';
//   attachResolveTransport(videoEl, { onPreviousItem, onNextItem });
'use strict';

import { mountTransport, makeVideoAdapter, getTransport } from './pfxTransport.js';

let _seq = 0;

export function attachResolveTransport(video, options = {}) {
  try {
    if (!video || video.nodeName !== 'VIDEO') return null;
    const host = video.parentElement;
    if (!host) return null;
    // The bar is positioned absolutely at the bottom of the player area, so the
    // host must be a positioning context (else the bar shrink-wraps + floats).
    try { if (getComputedStyle(host).position === 'static') host.style.position = 'relative'; } catch {}
    if (video.dataset.rvt === '1' && video.__pfxTxName) {
      return getTransport(video.__pfxTxName)?.destroy?.bind(getTransport(video.__pfxTxName)) || null;
    }
    video.dataset.rvt = '1';
    video.controls = false;

    const name = options.name || `rvt${++_seq}`;
    video.__pfxTxName = name;

    // Bar wrapper appended to the player area (below the video).
    const wrap = document.createElement('div');
    wrap.className = 'pfx-tx-host pfx-tx-host-video';
    host.appendChild(wrap);

    const hasPrev = typeof options.onPreviousItem === 'function';
    const hasNext = typeof options.onNextItem === 'function';

    const adapter = makeVideoAdapter(video, {
      name,
      host: wrap,
      fps: () => Number(document.body?.dataset?.fps) || Number(options.fps) || 24,
      items: {
        type: options.itemsType || 'cuts',
        prev() { if (hasPrev) options.onPreviousItem(video, wrap); },
        next() { if (hasNext) options.onNextItem(video, wrap); },
      },
    });

    const ctrl = mountTransport(adapter);
    if (!ctrl) { try { wrap.remove(); video.controls = true; delete video.dataset.rvt; } catch {} return null; }

    return () => {
      try { ctrl.destroy(); video.controls = true; delete video.dataset.rvt; delete video.__pfxTxName; } catch {}
    };
  } catch (e) {
    try { if (video) video.controls = true; } catch {}
    console.warn('[RVT shim] attach failed, native controls kept:', (e && e.message) || e);
    return null;
  }
}
