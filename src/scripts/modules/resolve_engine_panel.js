'use strict';

/**
 * resolve_engine_panel.js — DaVinci Resolve Media Engine Panel
 *
 * Adds a collapsible panel inside the IMF → Settings tab (immediately after the
 * Smart Playback Engine panel, #smartEnginePanel) that surfaces DaVinci Resolve's
 * processing stack as live, colour-coded status rows.
 *
 * Renderer-side only. Live state comes from:
 *   - window.pfxPlatform.sendNativeCommand({ type: 'resolve.engineStatus' })  (primary; no companion HTTP needed)
 *   - resolveStatus() from smart_playback_engine.js                            (best-effort supplement)
 *   - window.pfxPlatform.companionStatus()                                     (Python companion health)
 * No new IPC channels — reuses pfx:native-command / pfx:smartMedia / pfx:companionStatus.
 *
 * Mounted from imf/imf_ui.js right after smart_engine_settings init().
 */

import { resolveStatus } from './smart_playback_engine.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const PANEL_ID      = 'pfxResolveEnginePanel';
const LIST_ID       = 'pfxResolveEngineList';
const REFRESH_ID    = 'pfxResolveEngineRefreshBtn';
const PILL_ID       = 'pfxResolveEnginePill';
const GPU_BADGE_ID  = 'pfxResolveGpuBadge';

const STATUS = {
  ready:   { color: '#2ecc71', label: 'ready'   },
  partial: { color: '#e67e22', label: 'partial' },
  idle:    { color: '#7f8c8d', label: 'idle'    },
  missing: { color: '#e74c3c', label: 'missing' },
  unknown: { color: '#7f8c8d', label: '—'       },
};

// ── Static engine descriptors ─────────────────────────────────────────────────
//
// These describe DaVinci Resolve's processing stack. Live fields (status,
// detail, version) are filled in at refresh time from actual system state.
// Ref: Blackmagic Design technical docs & DaVinci Resolve 20/21 release notes.

const RESOLVE_ENGINES = [
  {
    group:   'Core Processing',
    id:      'yrgb',
    label:   'YRGB 32-bit Float',
    doc:     'Patented DaVinci color science — wide gamut, HDR-ready',
    alwaysReady: true,    // present whenever Resolve is installed
  },
  {
    group:   'Core Processing',
    id:      'neural',
    label:   'DaVinci Neural Engine',
    doc:     'GPU deep-learning: facial recognition, Magic Mask, SuperScale, Speed Warp',
    requiresStudio: true,
    gpuDependent: true,
  },
  {
    group:   'Core Processing',
    id:      'fairlight',
    label:   'Fairlight Audio Engine',
    doc:     'Professional DAW integrated — VST/AU plugins, immersive audio',
    alwaysReady: true,
  },
  {
    group:   'GPU Acceleration',
    id:      'gpu_metal',
    label:   'Metal (Apple Silicon)',
    doc:     'Unified memory GPU — M-series optimised, OpenCL fallback on Intel',
    platformMac: true,
    gpuDependent: true,
  },
  {
    group:   'GPU Acceleration',
    id:      'gpu_cuda',
    label:   'CUDA / OpenCL (Win/Linux)',
    doc:     'NVIDIA CUDA or AMD/Intel OpenCL — multi-GPU supported in Studio',
    platformWin: true,
    gpuDependent: true,
  },
  {
    group:   'Connection',
    id:      'resolve_api',
    label:   'Resolve Scripting API',
    doc:     'Live connection to running Resolve — needed for still extraction & rendering',
    live: true,           // status set from resolveStatus() call
  },
  {
    group:   'Connection',
    id:      'companion',
    label:   'PFX Python Companion',
    doc:     'PostFlowX bridge process — required for Resolve IPC, OCF stills, RAW decode',
    live: true,
  },
  {
    group:   'Media & Delivery',
    id:      'imf',
    label:   'IMF / SMPTE ST 2067',
    doc:     'MXF + CPL + PKL packages — create and validate Netflix IMF deliveries',
    alwaysReady: true,
  },
  {
    group:   'Media & Delivery',
    id:      'hdr',
    label:   'HDR Grading (Dolby Vision / HDR10+)',
    doc:     'Full HDR pipeline including DoVi metadata embedding — Resolve Studio required',
    requiresStudio: true,
  },
  {
    group:   'Media & Delivery',
    id:      'optimised_media',
    label:   'Optimised Media / Proxy',
    doc:     'DNxHR (Win) · ProRes (Mac) · Uncompressed 10/16-bit — accelerated playback',
    alwaysReady: true,
  },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function _esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _q(id) { return document.getElementById(id); }

function _isMac() {
  return typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '');
}

function _isElectron() {
  return !!(window.__PFX_IS_ELECTRON && window.pfxPlatform);
}

// ── Build live state from IPC calls ──────────────────────────────────────────

// Monotonic token guarding _refresh() (Refresh-button click, tab re-open, and
// mount-time initial fetch can all overlap). Bumped at the start of every
// _refresh() call; a call whose token is no longer current after the
// _fetchLiveState() await bails out instead of overwriting newer UI state
// with stale engine/GPU status.
let _refreshSeq = 0;

async function _fetchLiveState() {
  const out = {
    resolveFound:     false,
    resolveRunning:   false,
    resolveConnected: false,
    resolveVersion:   '',
    resolveProject:   '',
    companionReady:   false,
    gpuBackend:       'unknown',   // 'metal' | 'cuda' | 'opencl' | 'unknown'
    isStudio:         false,
  };

  if (!_isElectron()) return out;

  // Primary: native resolve detect — works WITHOUT the Python HTTP companion.
  // sendNativeCommand returns the unwrapped result object and throws on error.
  // Shape: { ok, found, running, connected, apiAvailable, scriptingAvailable,
  //          version, currentProject, state }  (native_router._resolveDetect)
  try {
    const r = await window.pfxPlatform.sendNativeCommand({ type: 'resolve.engineStatus' }, 12000);
    out.resolveFound     = !!(r?.found);
    out.resolveRunning   = !!(r?.running);
    out.resolveConnected = !!(r?.connected || r?.apiAvailable);
    out.resolveVersion   = r?.version || '';
    out.resolveProject   = r?.currentProject || '';
    if (r?.scriptingAvailable || r?.apiAvailable) out.companionReady = true;
  } catch { /* native router unavailable — leave defaults */ }

  // Supplement: smartMedia.resolveStatus() (companion HTTP path; best-effort).
  try {
    const r = await resolveStatus();
    if (r) {
      out.resolveFound     = out.resolveFound     || !!(r.found || r.installed || r.available);
      out.resolveRunning   = out.resolveRunning   || !!r.running;
      out.resolveConnected = out.resolveConnected || !!(r.connected || r.apiAvailable);
      out.resolveVersion   = out.resolveVersion   || r.version || r.resolveVersion || '';
      out.resolveProject   = out.resolveProject   || r.currentProject || '';
    }
  } catch { /* companion HTTP unavailable — fine */ }

  // GPU backend heuristic (Resolve uses Metal on Apple Silicon, CUDA on Win default).
  out.gpuBackend = _isMac() ? 'metal' : 'cuda';

  // Python companion process health (independent of Resolve).
  try {
    const cs = await window.pfxPlatform.companionStatus?.();
    if (cs?.ready) out.companionReady = true;
  } catch { /* companionStatus not available on this build */ }

  // If Resolve scripting is reachable, the companion bridge is implicitly up.
  if (out.resolveConnected) out.companionReady = true;

  return out;
}

// ── Derive per-engine status from live state ──────────────────────────────────

function _resolveEngineStatus(engine, live) {
  if (engine.live) {
    if (engine.id === 'resolve_api') {
      if (live.resolveConnected) return { ...STATUS.ready,  detail: live.resolveProject ? `Project: ${live.resolveProject}` : (live.resolveVersion || 'Connected') };
      if (live.resolveRunning)   return { ...STATUS.partial, detail: 'Running — scripting not enabled' };
      if (live.resolveFound)     return { ...STATUS.idle,    detail: 'Installed — not running' };
      return                            { ...STATUS.missing, detail: 'DaVinci Resolve not found' };
    }
    if (engine.id === 'companion') {
      return live.companionReady
        ? { ...STATUS.ready,   detail: 'PFX bridge active' }
        : { ...STATUS.missing, detail: 'Companion process not running' };
    }
  }

  if (engine.gpuDependent) {
    if (engine.id === 'gpu_metal' && !_isMac()) return null;    // hide on non-Mac
    if (engine.id === 'gpu_cuda'  && _isMac())  return null;    // hide on Mac
    return live.resolveFound
      ? { ...STATUS.ready,   detail: engine.id === 'gpu_metal' ? 'Metal + VideoToolbox' : live.gpuBackend === 'cuda' ? 'NVIDIA CUDA' : 'OpenCL' }
      : { ...STATUS.unknown, detail: 'Resolve not detected' };
  }

  if (engine.requiresStudio) {
    return live.resolveFound
      ? { ...STATUS.partial, detail: 'Resolve Studio required for full feature set' }
      : { ...STATUS.unknown, detail: 'Resolve not detected' };
  }

  if (engine.alwaysReady) {
    return live.resolveFound
      ? { ...STATUS.ready, detail: '' }
      : { ...STATUS.idle,  detail: 'Available once Resolve is installed' };
  }

  return { ...STATUS.unknown, detail: '' };
}

// ── Render ────────────────────────────────────────────────────────────────────

function _renderList(live) {
  const list = _q(LIST_ID);
  if (!list) return;

  // Group engines
  const groups = {};
  for (const engine of RESOLVE_ENGINES) {
    const st = _resolveEngineStatus(engine, live);
    if (st === null) continue;   // filtered out (wrong platform)
    if (!groups[engine.group]) groups[engine.group] = [];
    groups[engine.group].push({ engine, st });
  }

  let html = '';
  for (const [groupName, rows] of Object.entries(groups)) {
    html += `<div style="font-size:8px;text-transform:uppercase;letter-spacing:.08em;
      color:rgba(255,255,255,.3);margin:8px 0 3px;font-weight:600;">${_esc(groupName)}</div>`;
    for (const { engine, st } of rows) {
      const dot = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;
        background:${st.color};flex-shrink:0;margin-top:1px;"></span>`;
      const detail = st.detail
        ? `<span style="color:rgba(255,255,255,.35);font-size:8px;margin-left:4px;">${_esc(st.detail)}</span>`
        : '';
      const studio = engine.requiresStudio
        ? `<span style="font-size:7px;background:rgba(246,192,66,.18);color:#f6c042;
           border-radius:2px;padding:0 3px;margin-left:4px;">Studio</span>`
        : '';
      html += `
        <div style="display:flex;align-items:flex-start;gap:6px;font-size:9px;
          line-height:1.45;margin-bottom:2px;" title="${_esc(engine.doc)}">
          ${dot}
          <div style="flex:1;min-width:0;">
            <span style="color:rgba(255,255,255,.82);">${_esc(engine.label)}</span>
            ${studio}${detail}
          </div>
          <span style="font-size:8px;color:${st.color};flex-shrink:0;">${st.label}</span>
        </div>`;
    }
  }

  // Overall status pill
  const allReady   = Object.values(groups).flat().every(({ st }) => st.label === 'ready');
  const anyMissing = Object.values(groups).flat().some(({ st }) => st.label === 'missing');
  const pillColor  = allReady ? '#2ecc71' : anyMissing ? '#e74c3c' : '#e67e22';
  const pillLabel  = allReady ? 'All engines ready' : anyMissing ? 'Engine issue' : 'Partial';

  const pill = _q(PILL_ID);
  if (pill) {
    pill.textContent = pillLabel;
    pill.style.color = pillColor;
  }

  list.innerHTML = html;
}

function _renderLoading() {
  const list = _q(LIST_ID);
  if (list) {
    list.innerHTML = '<div style="font-size:9px;color:rgba(255,255,255,.3);">Probing engines…</div>';
  }
}

// ── Panel HTML ────────────────────────────────────────────────────────────────

function _buildPanelHTML() {
  return `
  <!-- ── DaVinci Resolve Media Engine ── -->
  <div class="imf-proxy-panel" id="${PANEL_ID}">
    <div class="imf-proxy-panel-head" style="display:flex;align-items:center;gap:8px;">
      <div class="imf-proxy-panel-title">DaVinci Resolve Media Engine</div>
      <span id="${PILL_ID}" style="font-size:8px;color:rgba(255,255,255,.35);"></span>
      <button id="${REFRESH_ID}" class="imf-action-btn imf-btn-ghost"
        style="font-size:9px;padding:2px 8px;margin-left:auto;" type="button">Refresh</button>
    </div>
    <div class="imf-proxy-panel-body" style="padding:6px 10px 10px;">
      <div id="${LIST_ID}" style="display:flex;flex-direction:column;">
        <div style="font-size:9px;color:rgba(255,255,255,.3);">Loading…</div>
      </div>

      <!-- GPU backend badge -->
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid rgba(255,255,255,.07);">
        <div style="font-size:8px;text-transform:uppercase;letter-spacing:.08em;
          color:rgba(255,255,255,.3);margin-bottom:4px;font-weight:600;">Processing Stack</div>
        <div id="${GPU_BADGE_ID}" style="font-size:8.5px;color:rgba(255,255,255,.5);
          font-family:monospace;line-height:1.6;">
          32-bit float YRGB · Neural Engine (GPU) · Fairlight DSP · AVFoundation
        </div>
      </div>

      <!-- Docs link row -->
      <div style="margin-top:8px;font-size:8px;color:rgba(255,255,255,.25);">
        DaVinci Resolve 20/21 · Blackmagic Design ·
        <a href="#" id="pfxResolveDmgrLink"
          style="color:rgba(255,255,255,.35);text-decoration:underline;">
          Open in Resolve
        </a>
      </div>
    </div>
  </div>`;
}

// ── Mount ─────────────────────────────────────────────────────────────────────

async function _refresh() {
  const seq = ++_refreshSeq;
  _renderLoading();
  const live = await _fetchLiveState();
  if (seq !== _refreshSeq) return; // superseded by a newer refresh
  _renderList(live);

  // Update GPU badge
  const badge = _q(GPU_BADGE_ID);
  if (badge) {
    const gpuStr = _isMac()
      ? 'Metal · VideoToolbox · ANE (Neural Engine)'
      : (live.gpuBackend === 'cuda' ? 'NVIDIA CUDA · OpenCL fallback' : 'OpenCL · CUDA optional');
    badge.textContent =
      `32-bit float YRGB · ${gpuStr} · Fairlight DSP · ffprobe`;
  }
}

/**
 * Mount the DaVinci Resolve Media Engine panel.
 *
 * Injects panel HTML immediately after the Smart Playback Engine panel,
 * wires the Refresh button, and triggers an initial status fetch.
 *
 * Safe to call multiple times — idempotent.
 */
export function mountResolveEnginePanel() {
  if (_q(PANEL_ID)) return;   // already mounted

  // Find anchor: insert after smartEnginePanel
  const anchor = _q('smartEnginePanel');
  if (!anchor?.parentNode) {
    console.warn('[ResolveEnginePanel] anchor (smartEnginePanel) not found — skipping mount');
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.innerHTML = _buildPanelHTML();
  anchor.parentNode.insertBefore(wrapper.firstElementChild, anchor.nextSibling);

  // Wire refresh button
  const btn = _q(REFRESH_ID);
  if (btn) btn.addEventListener('click', _refresh);

  // Wire "Open in Resolve" link
  const link = _q('pfxResolveDmgrLink');
  if (link) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      try {
        window.pfxPlatform?.openExternal('resolve://');
      } catch {}
    });
  }

  // Re-probe whenever the IMF Settings ltab is opened (mirrors smart_engine_settings).
  document.getElementById('imfTabSettings')?.addEventListener('click', () => {
    if (_q(PANEL_ID)) _refresh();
  });

  // Initial fetch
  _refresh();
}

/**
 * Trigger a manual refresh (e.g. when the Settings ltab becomes visible).
 */
export function refreshResolveEnginePanel() {
  if (_q(PANEL_ID)) _refresh();
}
