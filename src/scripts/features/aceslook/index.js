// scripts/features/acesLook/index.js
// ACES Look tab — al2 professional redesign.
// Mounts the full UI into #main-aceslook.

import {
  getState, subscribe, patch, resetState,
  setSource, setMode, setInputTransform, setOutputTransform,
  setWorkingLocation, setPrimaryControl,
  setCdlEnabled, setCdlValue,
  addLookItem, toggleLookItem, removeLookItem, reorderLookItems, updateLookItem,
  setClipId, setOcfMeta, setExportResult,
} from './state/acesLookStore.js';
import { validate }              from './state/acesLookValidation.js';
import { REGISTRY }              from './services/transformRegistry.js';
import { MODE_DEFAULTS, WORKING_LOCATIONS, EMPTY_CDL } from './state/acesLookDefaults.js';
import { detectSource }          from './services/sourceDetection.js';
import { listPresets, loadPreset, savePreset, deletePreset } from './services/presetService.js';
import { exportAmf, exportCdl, exportClf, exportSummary } from './services/exportService.js';
import { attachScrub, attachScrubGanged } from './utils/scrubInput.js';
import { showPresetSaveModal }   from './modals/PresetSaveModal.js';

// playableMedia is loaded lazily on first viewer use so its native-bridge
// sub-imports don't block initial module evaluation.
let _playableMediaMod = null;
async function _loadPlayableMedia() {
  if (!_playableMediaMod) _playableMediaMod = await import('../../core/playableMedia.js');
  return _playableMediaMod;
}

// ── Module-level state ────────────────────────────────────────────────────────
let _mounted          = false;
let _unsub            = null;
let _viewerSourceName = null;
let _viewerObjectUrl  = null;
let _viewerShowGraded = true;
let _histRafId        = null;
let _histLastMs       = 0;
let _proxyVideoEl     = null;
let _scopeMode        = 'histogram'; // 'histogram'|'waveform'|'parade'|'vectorscope'
let _scopeCollapsed   = false;
let _clipWarnVisible  = false;

// ── History / snapshots ───────────────────────────────────────────────────────
const _history   = [];  // [{ label, state, time }]
const _snapshots = [];  // [{ label, state, time, thumbUrl }]
const _versions  = [];  // [{ label, state, time }]
let _histDebounce = null;
let _historyWired  = false;
let _snapshotsWired = false;
let _presetListWired = false;

// Histogram sample canvas (off-screen)
const _HIST_SAMPLE_W = 160;
const _HIST_SAMPLE_H = 90;
const _HIST_FPS_MS   = 200;
let _histSampleCanvas = null;

// ── Proxy ETA helper ──────────────────────────────────────────────────────────
function _makeProxyEta() {
  let _t0 = 0;
  return {
    update(pct) {
      if (pct <= 0) return '';
      const now = Date.now();
      if (!_t0) { _t0 = now; return ''; }
      const elapsedSec = (now - _t0) / 1000;
      if (elapsedSec < 0.3) return '';
      const rate = pct / elapsedSec;
      if (!rate || !isFinite(rate)) return '';
      const remSec = Math.max(0, (100 - pct) / rate);
      if (remSec < 5) return '';
      if (remSec < 60) return `~${Math.ceil(remSec)}s left`;
      const m = Math.floor(remSec / 60);
      const s = Math.round(remSec % 60);
      return s > 0 ? `~${m}m ${s}s left` : `~${m}m left`;
    },
    reset() { _t0 = 0; },
  };
}

function _releaseProxyVideo() {
  if (_proxyVideoEl) {
    const el = _proxyVideoEl;
    _proxyVideoEl = null;
    _loadPlayableMedia().then(m => m.releasePlayableVideo(el)).catch(() => {});
  }
}

// ── File type regexps ─────────────────────────────────────────────────────────
const _VIDEO_EXT = /\.(mov|mp4|m4v|avi|webm)$/i;
const _IMAGE_EXT = /\.(exr|dpx|tiff?|png|jpg|jpeg|cin)$/i;
const _OCF_EXT   = /\.(mxf|braw|r3d|arx|ari)$/i;

// ── Mount / Unmount ───────────────────────────────────────────────────────────
export function mountAcesLook() {
  const root = document.getElementById('main-aceslook');
  if (!root) return;
  if (_mounted) return;

  const _p = window.PFX_PERMISSIONS;
  if (_p && !_p.canDoAction('open_aces_look')) {
    const sess   = _p.getSession?.();
    const status = sess?.status === 'pending'  ? 'pending'
                 : sess?.status === 'disabled' ? 'disabled' : 'denied';
    // key, not a spelled-out name: this call site said 'ACES Look' while the tab
    // it covers says ACES LOOK, which is the same drift core/workspaceAccess.js
    // was written to end. The panel looks the name up like everywhere else.
    window.pfxNoAccessView?.renderNoAccess(root, { status, key: 'aceslook' });
    return;
  }

  _buildShell(root);

  // Wire all interactive elements once
  _wireCollapsibles(root);
  _wireWorkflowMode(root);
  _wireTopBar(root);
  _wireInlineSourcePicker(root);
  _wireViewer(root);
  _wireScopesRail();
  _wireInspector(root);
  _wireLeftRail(root);
  _wireStatusRail(root);

  // Only lock _mounted after the shell and wires are fully set up.
  // If anything above throws, this stays false so the next tab-click retries.
  _mounted = true;

  const init = getState();
  _renderAll({ ...init, ...validate(init) });

  _unsub = subscribe(state => {
    const v = validate(state);
    _renderAll({ ...state, ...v });
  });
}

export function unmountAcesLook() {
  _unsub?.();
  _mounted = false;
  _historyWired   = false;
  _snapshotsWired = false;
  _presetListWired = false;
  _topBarWired = false;
  _viewerWired = false;
  if (_histRafId) { cancelAnimationFrame(_histRafId); _histRafId = null; }
  if (_viewerObjectUrl) { URL.revokeObjectURL(_viewerObjectUrl); _viewerObjectUrl = null; }
  _viewerSourceName = null;
}

// Project save/load bridge
window.PFX_exportAcesLookState = () => {
  try {
    const s = getState();
    return { ...s, source: null }; // File objects can't be JSON-serialized
  } catch { return null; }
};
window.PFX_applyAcesLookState = (s) => {
  try {
    if (s && typeof s === 'object') patch({ ...s, source: null }); // ensure source is null on restore
  } catch {}
};

// ── Shell ─────────────────────────────────────────────────────────────────────
function _buildShell(root) {
  document.getElementById('al2-load-placeholder')?.remove();
  const modeKeys = Object.keys(MODE_DEFAULTS);
  const inputKeys = Object.keys(REGISTRY.inputTransforms);
  const outputKeys = Object.keys(REGISTRY.outputTransforms);

  root.innerHTML = `
    <div class="al2-topbar">
      <div class="al2-mode-seg" id="al2-mode-seg">
        <button class="al2-mode-btn" data-mode="hdr_vfx_pull">VFX Pull</button>
        <button class="al2-mode-btn" data-mode="hdr_dailies">Look Dev</button>
        <button class="al2-mode-btn" data-mode="hdr_review">Review</button>
        <button class="al2-mode-btn" data-mode="sdr_qt_in_hdr_show">SDR QT</button>
      </div>
      <!-- ── Inline source picker (the red-box area) ── -->
      <div class="al2-src-picker" id="al2-src-picker">
        <input type="file" id="al2-src-file-input" accept="video/*,.mov,.mp4,.mxf,.r3d,.braw,.ari,.dpx,.exr" style="display:none">
        <div class="al2-src-drop" id="al2-src-drop">
          <span class="al2-src-drop-icon">▶</span>
          <span class="al2-src-drop-label" id="al2-src-drop-label">Drop video or click to load source</span>
          <span class="al2-src-drop-name" id="al2-src-drop-name" style="display:none"></span>
          <button class="al2-src-clear-btn" id="al2-src-clear-btn" style="display:none" title="Clear source">✕</button>
        </div>
      </div>
      <select id="al2-preset-sel" class="al2-select" style="width:124px;font-size:11px;" aria-label="Preset">
        <option value="">— presets —</option>
        ${listPresets().map(n => `<option value="${_esc(n)}">${_esc(n)}</option>`).join('')}
      </select>
      <button class="al2-btn al2-btn-xs" id="al2-preset-save-btn">Save</button>
      <button class="al2-btn al2-btn-xs al2-btn-danger" id="al2-preset-del-btn" style="display:none">Del</button>
      <button class="al2-btn al2-btn-xs" id="al2-reset-btn">Reset</button>
    </div>

    <div class="al2-status-rail" id="al2-status-rail">
      <div class="al2-step" id="al2-step-source"><span class="al2-step-dot"></span>Source</div>
      <div class="al2-step-connector"></div>
      <div class="al2-step" id="al2-step-input"><span class="al2-step-dot"></span>Input</div>
      <div class="al2-step-connector"></div>
      <div class="al2-step" id="al2-step-look"><span class="al2-step-dot"></span>Look</div>
      <div class="al2-step-connector"></div>
      <div class="al2-step" id="al2-step-view"><span class="al2-step-dot"></span>View</div>
      <div class="al2-step-connector"></div>
      <div class="al2-step" id="al2-step-export"><span class="al2-step-dot"></span>Export</div>
    </div>

    <div class="al2-workspace">

      <!-- ── LEFT RAIL ── -->
      <div class="al2-left-rail">
        <div class="al2-rail-sections">

        <div class="al2-rail-section open" id="al2-sec-source">
          <div class="al2-rail-section-header">SOURCE<span class="al2-rail-chevron">▸</span></div>
          <div class="al2-rail-section-body" id="al2-source-body">
            <div class="al2-drop-zone" id="al2-drop-zone" tabindex="0" role="button"
                 aria-label="Drop source file or click to browse">
              Drop file or click to browse
              <input type="file" id="al2-source-input"
                     accept=".exr,.dpx,.mov,.mp4,.mxf,.r3d,.arx,.ari,.braw" hidden>
            </div>
            <div id="al2-source-info" style="margin-top:6px;display:none">
              <div class="al2-src-name" id="al2-src-name"></div>
              <div class="al2-src-meta" id="al2-src-meta"></div>
            </div>
          </div>
        </div>

        <div class="al2-rail-section open" id="al2-sec-presets">
          <div class="al2-rail-section-header">PRESETS<span class="al2-rail-chevron">▸</span></div>
          <div class="al2-rail-section-body" id="al2-presets-body">
            <div class="al2-preset-list" id="al2-preset-list"></div>
            <button class="al2-btn al2-btn-xs al2-btn-accent" id="al2-preset-save-rail-btn"
                    style="width:100%;margin-top:4px">Save preset</button>
          </div>
        </div>

        <div class="al2-rail-section" id="al2-sec-snapshots">
          <div class="al2-rail-section-header">SNAPSHOTS<span class="al2-rail-chevron">▸</span></div>
          <div class="al2-rail-section-body" id="al2-snapshots-body">
            <div class="al2-snapshot-list" id="al2-snapshot-list">
              <div class="al2-empty">No snapshots yet.</div>
            </div>
            <button class="al2-btn al2-btn-xs" id="al2-snapshot-save-btn"
                    style="width:100%;margin-top:4px">+ Save snapshot</button>
          </div>
        </div>

        <div class="al2-rail-section" id="al2-sec-history">
          <div class="al2-rail-section-header">HISTORY<span class="al2-rail-chevron">▸</span></div>
          <div class="al2-rail-section-body" id="al2-history-body">
            <div class="al2-history-list" id="al2-history-list">
              <div class="al2-empty">No history yet.</div>
            </div>
          </div>
        </div>

        <div class="al2-rail-section" id="al2-sec-versions">
          <div class="al2-rail-section-header">VERSIONS<span class="al2-rail-chevron">▸</span></div>
          <div class="al2-rail-section-body" id="al2-versions-body">
            <div class="al2-version-list" id="al2-version-list">
              <div class="al2-empty">No saved versions.</div>
            </div>
            <button class="al2-btn al2-btn-xs" id="al2-version-save-btn"
                    style="width:100%;margin-top:4px">+ Save version</button>
          </div>
        </div>

      </div><!-- /.al2-rail-sections -->

      <!-- ── SCOPE (pinned bottom of left rail) ── -->
      <div class="al2-scope-rail" id="al2-scope-rail">
        <div class="al2-scope-rail-header">
          <span class="al2-scope-rail-title">SCOPE</span>
          <div class="al2-scope-mode-btns" id="al2-scope-mode-btns">
            <button class="al2-scope-mode-btn active" data-scope="histogram"   title="Histogram">H</button>
            <button class="al2-scope-mode-btn"        data-scope="waveform"    title="Waveform">W</button>
            <button class="al2-scope-mode-btn"        data-scope="parade"      title="RGB Parade">P</button>
            <button class="al2-scope-mode-btn"        data-scope="vectorscope" title="Vectorscope">V</button>
          </div>
          <span class="al2-scope-cs-tag" id="al2-scope-cs-tag">sRGB</span>
          <button class="al2-scope-collapse-btn" id="al2-scope-collapse" title="Collapse scope">▾</button>
        </div>
        <div class="al2-scope-canvas-wrap" id="al2-scope-canvas-wrap">
          <canvas id="al2-scope-canvas"></canvas>
        </div>
        <div class="al2-scope-stats" id="al2-scope-stats">
          <div class="al2-scope-stat"><span class="al2-scope-ch-r">R</span><span class="al2-scope-val" id="al2-sval-r">—</span></div>
          <div class="al2-scope-stat"><span class="al2-scope-ch-g">G</span><span class="al2-scope-val" id="al2-sval-g">—</span></div>
          <div class="al2-scope-stat"><span class="al2-scope-ch-b">B</span><span class="al2-scope-val" id="al2-sval-b">—</span></div>
          <div class="al2-scope-stat"><span class="al2-scope-ch-l">L</span><span class="al2-scope-val" id="al2-sval-l">—</span></div>
          <div class="al2-scope-clip-tag" id="al2-scope-clip-tag" style="display:none">CLIP</div>
        </div>
      </div>

    </div><!-- /.al2-left-rail -->

      <!-- ── VIEWER PANEL ── -->
      <div class="al2-viewer-panel">
        <div class="al2-viewer-toolbar">
          <button class="al2-vtool-btn active" id="al2-vt-graded">Graded</button>
          <button class="al2-vtool-btn" id="al2-vt-original">Original</button>
          <div class="al2-vtool-sep"></div>
          <button class="al2-vtool-btn" id="al2-vt-wipe">Wipe</button>
          <button class="al2-vtool-btn" id="al2-vt-split">Split</button>
          <div class="al2-vtool-spacer"></div>
          <button class="al2-vtool-btn" id="al2-vt-fit">Fit</button>
          <button class="al2-vtool-btn" id="al2-vt-100">100%</button>
          <div class="al2-vtool-sep"></div>
          <button class="al2-vtool-btn" id="al2-vt-clipwarn" title="Toggle clipping warning">⚠ Clip</button>
        </div>
        <div class="al2-viewer-wrap" id="al2-viewer-wrap">
          <div id="al2-viewer-inner"
               style="flex:1;width:100%;height:100%;display:flex;align-items:center;justify-content:center;">
            <span style="color:var(--al-text-muted);font-size:12px">Drag a source clip here to preview and grade it.</span>
          </div>
          <div class="al2-viewer-overlay-wrap" id="al2-viewer-overlay-wrap">
            <div class="al2-viewer-badge" id="al2-proxy-badge" style="display:none">PROXY</div>
            <div class="al2-viewer-tc" id="al2-tc-display" style="display:none"></div>
            <div class="al2-clip-warn-overlay" id="al2-clip-warn-overlay"></div>
          </div>
          <!-- Re-link overlay — shown when file is missing after restore -->
          <div class="al2-relink-overlay" id="al2-relink-overlay" style="display:none">
            <button class="al2-relink-dismiss" id="al2-relink-dismiss" title="Dismiss — work without source">✕</button>
            <div class="al2-relink-card">
              <div class="al2-relink-icon">⚠</div>
              <div class="al2-relink-title">Source file missing</div>
              <div class="al2-relink-name" id="al2-relink-name"></div>
              <div class="al2-relink-hint">Settings are preserved. Re-link the file to restore playback.</div>
              <button class="al2-relink-btn" id="al2-relink-btn">↺ Browse to Re-link</button>
            </div>
          </div>
        </div>
        <div class="al2-viewer-meta">
          <span class="al2-meta-name" id="al2-meta-name">No file loaded</span>
          <span class="al2-meta-sep">·</span>
          <span id="al2-meta-class" style="font-size:10.5px">—</span>
          <span class="al2-meta-sep">·</span>
          <span id="al2-meta-chain" style="font-size:10px;color:var(--al-text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
        </div>
      </div>

      <!-- ── INSPECTOR ── -->
      <div class="al2-inspector">

        <!-- Input -->
        <div class="al2-insp-section open" id="al2-insp-input">
          <div class="al2-insp-header">
            <span class="al2-insp-title">Input</span>
            <span class="al2-insp-chevron">▸</span>
          </div>
          <div class="al2-insp-body" id="al2-insp-input-body">
            <div class="al2-idt-row">
              <select class="al2-select" id="al2-idt-sel" aria-label="Input transform">
                ${Object.entries(REGISTRY.inputTransforms).map(([k, v]) =>
                  `<option value="${k}">${_esc(v.label)}</option>`
                ).join('')}
              </select>
              <div class="al2-conf-row" id="al2-idt-conf-row"></div>
              <div class="al2-note" id="al2-idt-note" style="display:none"></div>
            </div>
          </div>
        </div>

        <!-- Basic / Primary -->
        <div class="al2-insp-section open" id="al2-insp-basic">
          <div class="al2-insp-header">
            <span class="al2-insp-title">Basic</span>
            <span class="al2-insp-chevron">▸</span>
          </div>
          <div class="al2-insp-body" id="al2-insp-basic-body">
            <!-- Populated by _wireInspector -->
          </div>
        </div>

        <!-- CDL -->
        <div class="al2-insp-section" id="al2-insp-cdl">
          <div class="al2-insp-header">
            <span class="al2-insp-title">CDL</span>
            <span class="al2-insp-chevron">▸</span>
          </div>
          <div class="al2-insp-body" id="al2-insp-cdl-body">
            <!-- Populated by _wireInspector -->
          </div>
        </div>

        <!-- Look Stack -->
        <div class="al2-insp-section open" id="al2-insp-lookstack">
          <div class="al2-insp-header">
            <span class="al2-insp-title">Look Stack</span>
            <span class="al2-insp-chevron">▸</span>
          </div>
          <div class="al2-insp-body" id="al2-insp-ls-body">
            <!-- Populated by _renderLookStack -->
          </div>
        </div>

        <!-- View / Output -->
        <div class="al2-insp-section open" id="al2-insp-view">
          <div class="al2-insp-header">
            <span class="al2-insp-title">View / Output</span>
            <span class="al2-insp-chevron">▸</span>
          </div>
          <div class="al2-insp-body" id="al2-insp-view-body">
            <div class="al2-view-btns" id="al2-view-btns">
              <button class="al2-view-btn" data-odt="SDR_REC709">Rec.709 / SDR</button>
              <button class="al2-view-btn" data-odt="HDR_P3D65_PQ1000">P3-D65 1000 nit</button>
              <button class="al2-view-btn" data-odt="HDR_REC2100_PQ">Rec.2100 PQ</button>
              <button class="al2-view-btn" data-odt="NONE_RECIPE_ONLY">Recipe Only</button>
            </div>
            <div class="al2-out-select-row">
              <div class="al2-out-label">Working Space</div>
              <select class="al2-select" id="al2-working-sel" aria-label="Working space">
                ${WORKING_LOCATIONS.map(l =>
                  `<option value="${l}">${l}</option>`
                ).join('')}
              </select>
            </div>
            <div id="al2-preserve-sdr-row" style="display:none;margin-top:6px">
              <label style="display:flex;align-items:center;gap:6px;font-size:11px;cursor:pointer;color:var(--al-text-secondary)">
                <input type="checkbox" id="al2-preserve-sdr" style="accent-color:var(--al-accent)">
                Preserve SDR appearance
              </label>
            </div>
          </div>
        </div>

        <!-- Export -->
        <div class="al2-insp-section open" id="al2-insp-export">
          <div class="al2-insp-header">
            <span class="al2-insp-title">Export</span>
            <span class="al2-insp-chevron">▸</span>
          </div>
          <div class="al2-insp-body" id="al2-insp-export-body">
            <div class="al2-clip-row">
              <div class="al2-clip-label">Clip ID</div>
              <input type="text" class="al2-clip-input" id="al2-clip-id"
                     placeholder="e.g. A001C001">
            </div>
            <div class="al2-export-grid">
              <button class="al2-export-btn primary" id="al2-export-amf">Export AMF</button>
              <button class="al2-export-btn"         id="al2-export-cdl">Export CDL</button>
              <button class="al2-export-btn"         id="al2-export-clf">Export CLF</button>
              <button class="al2-export-btn"         id="al2-export-summary">Summary</button>
            </div>
            <div class="al2-export-result" id="al2-export-result"></div>
          </div>
        </div>

        <!-- Validation footer inside inspector -->
        <div class="al2-validation" id="al2-validation"></div>

      </div><!-- /.al2-inspector -->
    </div><!-- /.al2-workspace -->

  `;
}

// ── Collapsibles ──────────────────────────────────────────────────────────────
function _wireCollapsibles(root) {
  // Rail sections
  root.querySelectorAll('.al2-rail-section-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      hdr.closest('.al2-rail-section')?.classList.toggle('open');
    });
  });
  // Inspector sections (skip always-open)
  root.querySelectorAll('.al2-insp-section:not(.always-open) .al2-insp-header').forEach(hdr => {
    hdr.addEventListener('click', () => {
      hdr.closest('.al2-insp-section')?.classList.toggle('open');
    });
  });
}

// ── Workflow mode segmented control ───────────────────────────────────────────
function _wireWorkflowMode(root) {
  root.querySelectorAll('#al2-mode-seg .al2-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setMode(btn.dataset.mode);
    });
  });
}

// ── Top bar ───────────────────────────────────────────────────────────────────
let _topBarWired = false;
function _wireTopBar(root) {
  if (_topBarWired) return;
  _topBarWired = true;

  document.getElementById('al2-reset-btn')?.addEventListener('click', resetState);

  const presetSel = document.getElementById('al2-preset-sel');
  const delBtn    = document.getElementById('al2-preset-del-btn');

  presetSel?.addEventListener('change', e => {
    const name = e.target.value;
    if (delBtn) delBtn.style.display = name ? 'inline-flex' : 'none';
    if (!name) return;
    const p = window.PFX_PERMISSIONS;
    if (p && !p.canDoAction('load_aces_preset')) {
      e.target.value = '';
      if (delBtn) delBtn.style.display = 'none';
      window.pfxNoAccessView?.showDeniedToast('load_aces_preset');
      return;
    }
    const preset = loadPreset(name);
    if (!preset) return;
    const { savedAt, name: _n, ...fields } = preset;
    patch(fields);
  });

  delBtn?.addEventListener('click', () => {
    const name = presetSel?.value;
    if (!name || !confirm(`Delete preset "${name}"?`)) return;
    deletePreset(name);
    presetSel.querySelector(`option[value="${CSS.escape(name)}"]`)?.remove();
    presetSel.value = '';
    delBtn.style.display = 'none';
    _rebuildPresetList();
  });

  document.getElementById('al2-preset-save-btn')?.addEventListener('click', () => {
    const p = window.PFX_PERMISSIONS;
    if (p && !p.canDoAction('save_aces_preset')) {
      window.pfxNoAccessView?.showDeniedToast('save_aces_preset');
      return;
    }
    showPresetSaveModal(getState(), name => {
      // Update topbar dropdown
      if (presetSel) {
        let opt = presetSel.querySelector(`option[value="${CSS.escape(name)}"]`);
        if (!opt) {
          opt = document.createElement('option');
          opt.value = name;
          presetSel.appendChild(opt);
        }
        opt.textContent = name;
        presetSel.value = name;
        if (delBtn) delBtn.style.display = 'inline-flex';
      }
      _rebuildPresetList();
    });
  });
}

// ── Inline source picker (toolbar) ───────────────────────────────────────────
function _wireInlineSourcePicker(root) {
  const fileInput = document.getElementById('al2-src-file-input');
  const drop      = document.getElementById('al2-src-drop');
  const clearBtn  = document.getElementById('al2-src-clear-btn');

  if (!fileInput || !drop) return;

  // Click the zone → open file picker
  drop.addEventListener('click', e => {
    if (e.target === clearBtn) return;
    fileInput.click();
  });

  // File chosen via picker — relink if we already have saved settings, fresh import otherwise
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const s = getState();
    if (!(s.source instanceof File) && s.sourceName) {
      _relinkSourceFile(file); // restore File without overwriting saved settings
    } else {
      _handleSourceFile(file); // fresh import
    }
    fileInput.value = '';
  });

  // Drag-and-drop
  drop.addEventListener('dragover', e => {
    e.preventDefault();
    drop.classList.add('al2-src-drop--over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('al2-src-drop--over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('al2-src-drop--over');
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    const s = getState();
    if (!(s.source instanceof File) && s.sourceName) _relinkSourceFile(file);
    else _handleSourceFile(file);
  });

  // Clear — also wipe sourceName so re-link overlay disappears
  clearBtn.addEventListener('click', e => {
    e.stopPropagation();
    setSource(null);
    patch({ sourceClass: '', sourceName: '', exportResult: null });
  });
}

function _renderInlineSourcePicker(state) {
  const label    = document.getElementById('al2-src-drop-label');
  const name     = document.getElementById('al2-src-drop-name');
  const clearBtn = document.getElementById('al2-src-clear-btn');
  const drop     = document.getElementById('al2-src-drop');
  if (!drop) return;

  const hasFile     = state.source instanceof File;
  const orphaned    = !hasFile && !!state.sourceName; // settings restored but File lost

  if (hasFile) {
    // File present — show name + clear button
    if (label)    label.style.display    = 'none';
    if (name)     { name.style.display   = ''; name.textContent = state.source.name; name.style.color = ''; }
    if (clearBtn) clearBtn.style.display = '';
    drop.classList.add('al2-src-drop--loaded');
    drop.classList.remove('al2-src-drop--relink');
    drop.title = 'Click to change source file';
  } else if (orphaned) {
    // Project loaded / refresh — file gone but we know its name
    if (label)    label.style.display    = 'none';
    if (name)     {
      name.style.display  = '';
      name.textContent    = `↺ Re-link: ${state.sourceName}`;
      name.style.color    = 'var(--al-warn)';
    }
    if (clearBtn) clearBtn.style.display = '';
    drop.classList.add('al2-src-drop--loaded', 'al2-src-drop--relink');
    drop.title = `File "${state.sourceName}" is missing. Click to re-link it.`;
  } else {
    // No file, no history
    if (label)    label.style.display    = '';
    if (name)     { name.style.display   = 'none'; name.style.color = ''; }
    if (clearBtn) clearBtn.style.display = 'none';
    drop.classList.remove('al2-src-drop--loaded', 'al2-src-drop--relink');
    drop.title = 'Drop a video file here or click to browse';
  }
}

// ── Left rail wiring ──────────────────────────────────────────────────────────
function _wireLeftRail(root) {
  // Source drop zone
  const dropZone  = document.getElementById('al2-drop-zone');
  const fileInput = document.getElementById('al2-source-input');

  if (dropZone && fileInput) {
    dropZone.addEventListener('click',   () => fileInput.click());
    dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.classList.add('over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('over');
      const file = e.dataTransfer?.files?.[0];
      if (file) _handleSourceFile(file);
    });
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) _handleSourceFile(file);
    });
  }

  // Rail preset save button
  document.getElementById('al2-preset-save-rail-btn')?.addEventListener('click', () => {
    const p = window.PFX_PERMISSIONS;
    if (p && !p.canDoAction('save_aces_preset')) {
      window.pfxNoAccessView?.showDeniedToast('save_aces_preset');
      return;
    }
    showPresetSaveModal(getState(), _rebuildPresetList);
  });

  // Snapshot save button
  document.getElementById('al2-snapshot-save-btn')?.addEventListener('click', () => {
    _saveSnapshot();
  });

  // Version save button
  document.getElementById('al2-version-save-btn')?.addEventListener('click', () => {
    _saveVersion();
  });

  _rebuildPresetList();
}

// Capture the file's absolute path (desktop only) so a later session can
// silently re-link it without a Browse dialog. No-op / '' in the browser build.
function _captureSourcePath(file) {
  let p = '';
  try { p = window.pfxPlatform?.getNativeFilePath?.(file) || ''; } catch { p = ''; }
  patch({ sourcePath: p });
}

function _handleSourceFile(file) {
  const { sourceClass, suggestedInputTransform } = detectSource(file);
  setSource(file);
  // sourceName survives serialization so the re-link prompt can show the filename after restore
  patch({ sourceClass, sourceName: file.name });
  _captureSourcePath(file);
  // OCF metadata for the AUTO-IDT path (filename-derived — see SourceDetectionCard).
  if (file?.name) {
    const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
    setOcfMeta({ colorSpace: '', codec: ext, cameraType: file.name, container: ext, source: 'filename' });
  }
  if (suggestedInputTransform !== 'AUTO') {
    setInputTransform(suggestedInputTransform);
  }
  if (!getState().clipId) {
    const stem = file.name.replace(/\.[^.]+$/, '');
    setClipId(stem);
  }
}

// Re-link: restore the File object without overwriting saved settings
function _relinkSourceFile(file) {
  setSource(file);
  patch({ sourceName: file.name });
  _captureSourcePath(file); // refresh the saved path (file may have moved)
}

function _rebuildPresetList() {
  const listEl = document.getElementById('al2-preset-list');
  if (!listEl) return;
  const names = listPresets();
  if (names.length === 0) {
    listEl.innerHTML = '<div class="al2-empty">No saved presets.</div>';
    return;
  }
  listEl.innerHTML = names.map(n => `
    <div class="al2-preset-item" data-name="${_esc(n)}">
      <span class="al2-preset-name">${_esc(n)}</span>
      <button class="al2-btn al2-btn-xs al2-btn-danger" data-del="${_esc(n)}"
              style="padding:1px 4px;font-size:9px" title="Delete">✕</button>
    </div>
  `).join('');

  listEl.querySelectorAll('.al2-preset-item').forEach(item => {
    item.addEventListener('click', e => {
      if (e.target.closest('[data-del]')) return; // handled below
      const name = item.dataset.name;
      const preset = loadPreset(name);
      if (!preset) return;
      const { savedAt, name: _n, ...fields } = preset;
      patch(fields);
      listEl.querySelectorAll('.al2-preset-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
    });
  });

  listEl.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const name = btn.dataset.del;
      if (!confirm(`Delete preset "${name}"?`)) return;
      deletePreset(name);
      _rebuildPresetList();
      // Also update topbar dropdown
      const sel = document.getElementById('al2-preset-sel');
      sel?.querySelector(`option[value="${CSS.escape(name)}"]`)?.remove();
    });
  });
}

function _saveSnapshot() {
  const state = getState();
  const time  = new Date();
  let thumbUrl = null;

  // Try to capture thumbnail from current video frame
  const video = _getViewerVideo();
  if (video && video.readyState >= 2) {
    try {
      const c = document.createElement('canvas');
      c.width  = 160;
      c.height = 90;
      c.getContext('2d').drawImage(video, 0, 0, 160, 90);
      thumbUrl = c.toDataURL('image/jpeg', 0.7);
    } catch {}
  }

  const label = `Snapshot ${_snapshots.length + 1}`;
  _snapshots.push({ label, state: { ...state }, time, thumbUrl });
  _renderSnapshotList();
}

function _saveVersion() {
  const state = getState();
  const time  = new Date();
  const label = `v${_versions.length + 1} — ${_timeLabel(time)}`;
  _versions.push({ label, state: { ...state }, time });
  _renderVersionList();
}

function _renderSnapshotList() {
  const listEl = document.getElementById('al2-snapshot-list');
  if (!listEl) return;
  if (_snapshots.length === 0) {
    listEl.innerHTML = '<div class="al2-empty">No snapshots yet.</div>';
    return;
  }
  listEl.innerHTML = _snapshots.slice().reverse().map((s, ri) => {
    const idx = _snapshots.length - 1 - ri;
    return `
      <div class="al2-snapshot-item" data-idx="${idx}">
        ${s.thumbUrl ? `<img class="al2-snapshot-thumb" src="${s.thumbUrl}" alt="">` : ''}
        <span class="al2-history-label">${_esc(s.label)}</span>
        <span class="al2-history-time">${_timeLabel(s.time)}</span>
      </div>
    `;
  }).join('');
  listEl.querySelectorAll('.al2-snapshot-item').forEach(item => {
    item.addEventListener('click', () => {
      const snap = _snapshots[Number(item.dataset.idx)];
      if (snap) patch({ ...snap.state, source: getState().source });
    });
  });
}

function _renderVersionList() {
  const listEl = document.getElementById('al2-version-list');
  if (!listEl) return;
  if (_versions.length === 0) {
    listEl.innerHTML = '<div class="al2-empty">No saved versions.</div>';
    return;
  }
  listEl.innerHTML = _versions.slice().reverse().map((v, ri) => {
    const idx = _versions.length - 1 - ri;
    return `
      <div class="al2-version-item" data-idx="${idx}">
        <span class="al2-history-label">${_esc(v.label)}</span>
        <span class="al2-history-time">${_timeLabel(v.time)}</span>
      </div>
    `;
  }).join('');
  listEl.querySelectorAll('.al2-version-item').forEach(item => {
    item.addEventListener('click', () => {
      const ver = _versions[Number(item.dataset.idx)];
      if (ver) patch({ ...ver.state, source: getState().source });
    });
  });
}

function _pushHistory(state) {
  const MAX = 20;
  const idt  = REGISTRY.inputTransforms[state.inputTransform];
  const label = idt ? idt.label : state.inputTransform;
  const time  = new Date();
  _history.push({ label, state: { ...state }, time });
  if (_history.length > MAX) _history.shift();
  _renderHistoryList();
}

function _renderHistoryList() {
  const listEl = document.getElementById('al2-history-list');
  if (!listEl) return;
  if (_history.length === 0) {
    listEl.innerHTML = '<div class="al2-empty">No history yet.</div>';
    return;
  }
  listEl.innerHTML = _history.slice().reverse().map((h, ri) => {
    const idx = _history.length - 1 - ri;
    return `
      <div class="al2-history-item" data-idx="${idx}">
        <span class="al2-history-label">${_esc(h.label)}</span>
        <span class="al2-history-time">${_timeLabel(h.time)}</span>
      </div>
    `;
  }).join('');
  listEl.querySelectorAll('.al2-history-item').forEach(item => {
    item.addEventListener('click', () => {
      const h = _history[Number(item.dataset.idx)];
      if (h) patch({ ...h.state, source: getState().source });
    });
  });
}

function _timeLabel(d) {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  const s = String(d.getSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

// ── Inspector wiring ──────────────────────────────────────────────────────────
function _wireInspector(root) {
  _wireInputSection();
  _wireBasicSection();
  _wireCdlSection();
  _wireViewSection();
  _wireExportSection();
}

function _wireInputSection() {
  const idtSel = document.getElementById('al2-idt-sel');
  if (!idtSel) return;
  idtSel.addEventListener('change', e => setInputTransform(e.target.value));
}

const PRIMARY_CONTROLS = [
  { key: 'exposure',    label: 'Exposure',    min: -4,   max: 4,   step: 0.01,  decimals: 2, defaultVal: 0 },
  { key: 'contrast',    label: 'Contrast',    min: 0.1,  max: 2,   step: 0.005, decimals: 2, defaultVal: 1 },
  { key: 'saturation',  label: 'Saturation',  min: 0,    max: 2,   step: 0.005, decimals: 2, defaultVal: 1 },
  { key: 'temperature', label: 'Temp',        min: -100, max: 100, step: 0.5,   decimals: 0, defaultVal: 0 },
];

function _updateRangeTrack(range, c) {
  // Fill the track: bipolar controls fill from center; unipolar fill from left
  const val = parseFloat(range.value);
  const pct = (val - c.min) / (c.max - c.min) * 100;
  const isBipolar = c.defaultVal === 0 && c.min < 0;
  const accent = 'rgba(90,141,224,0.85)';
  const track  = 'rgba(255,255,255,0.08)';
  if (isBipolar) {
    const center = ((0 - c.min) / (c.max - c.min)) * 100;
    const lo = Math.min(pct, center), hi = Math.max(pct, center);
    range.style.background = `linear-gradient(to right,${track} ${lo}%,${accent} ${lo}%,${accent} ${hi}%,${track} ${hi}%)`;
  } else {
    range.style.background = `linear-gradient(to right,${accent} ${pct}%,${track} ${pct}%)`;
  }
}

function _wireBasicSection() {
  const body = document.getElementById('al2-insp-basic-body');
  if (!body) return;

  body.innerHTML = PRIMARY_CONTROLS.map(c => {
    const isBipolar = c.defaultVal === 0 && c.min < 0;
    const centerPct = isBipolar ? `left:${((0 - c.min) / (c.max - c.min) * 100).toFixed(1)}%` : '';
    return `
    <div class="al2-field-row" id="al2-row-${c.key}">
      <span class="al2-field-label" id="al2-pcl-${c.key}" title="Drag to adjust · Double-click value to reset">${c.label}</span>
      <div class="al2-field-track-wrap">
        <input type="range" class="al2-field-range al2-field-range--pro" id="al2-pcr-${c.key}"
               min="${c.min}" max="${c.max}" step="${c.step}" value="${c.defaultVal}">
        ${isBipolar ? `<span class="al2-field-center-mark" style="${centerPct}"></span>` : ''}
      </div>
      <input type="number" class="al2-field-num" id="al2-pcn-${c.key}"
             min="${c.min}" max="${c.max}" step="${c.step}"
             value="${c.defaultVal.toFixed(c.decimals)}">
      <button class="al2-field-reset" id="al2-rst-${c.key}" title="Reset to default">⌀</button>
    </div>`;
  }).join('');

  for (const c of PRIMARY_CONTROLS) {
    const label = document.getElementById(`al2-pcl-${c.key}`);
    const range = document.getElementById(`al2-pcr-${c.key}`);
    const num   = document.getElementById(`al2-pcn-${c.key}`);
    const rst   = document.getElementById(`al2-rst-${c.key}`);
    if (!label || !range || !num) continue;

    _updateRangeTrack(range, c);

    const commit = v => {
      const clamped = Math.min(c.max, Math.max(c.min, v));
      range.value = clamped;
      num.value   = clamped.toFixed(c.decimals);
      _updateRangeTrack(range, c);
      setPrimaryControl(c.key, clamped);
      // Dim reset button when at default
      if (rst) rst.style.opacity = Math.abs(clamped - c.defaultVal) < 0.001 ? '0' : '1';
    };

    range.addEventListener('input',  () => commit(parseFloat(range.value)));
    num.addEventListener('change',   () => commit(parseFloat(num.value) || c.defaultVal));
    num.addEventListener('dblclick', e => { e.preventDefault(); commit(c.defaultVal); });
    range.addEventListener('wheel', e => {
      e.preventDefault();
      commit((parseFloat(range.value) || 0) + (e.deltaY < 0 ? c.step : -c.step));
    }, { passive: false });
    rst?.addEventListener('click', () => commit(c.defaultVal));

    attachScrub(label, num, {
      step: c.step, min: c.min, max: c.max,
      decimals: c.decimals, defaultVal: c.defaultVal, onChange: commit,
    });
  }
}

const CDL_VEC_FIELDS = [
  { key: 'slope',  label: 'Slope',  defaultVal: 1, min: 0,    max: 4,  step: 0.001  },
  { key: 'offset', label: 'Offset', defaultVal: 0, min: -2,   max: 2,  step: 0.0005 },
  { key: 'power',  label: 'Power',  defaultVal: 1, min: 0.01, max: 4,  step: 0.001  },
];

function _wireCdlSection() {
  const body = document.getElementById('al2-insp-cdl-body');
  if (!body) return;

  body.innerHTML = `
    <div class="al2-cdl-toggle-row">
      <span style="font-size:11px;color:var(--al-text-secondary)">Enable CDL</span>
      <label class="al2-toggle">
        <input type="checkbox" id="al2-cdl-enabled">
        <span class="al2-toggle-slider"></span>
      </label>
    </div>
    <div id="al2-cdl-fields">
      <!-- Channel header -->
      <div class="al2-cdl-ch-header">
        <span class="al2-cdl-label" style="visibility:hidden">—</span>
        <span class="al2-cdl-ch-label al2-cdl-ch-r">R</span>
        <span class="al2-cdl-ch-label al2-cdl-ch-g">G</span>
        <span class="al2-cdl-ch-label al2-cdl-ch-b">B</span>
        <span class="al2-cdl-ch-rst-ph"></span>
      </div>
      ${CDL_VEC_FIELDS.map(f => `
        <div class="al2-cdl-row">
          <span class="al2-cdl-label" id="al2-cdl-lbl-${f.key}" title="Drag to adjust all channels">${f.label}</span>
          <input type="number" class="al2-cdl-num al2-cdl-ch-r" id="al2-cdl-${f.key}-0"
                 min="${f.min}" max="${f.max}" step="${f.step}" value="${f.defaultVal.toFixed(4)}">
          <input type="number" class="al2-cdl-num al2-cdl-ch-g" id="al2-cdl-${f.key}-1"
                 min="${f.min}" max="${f.max}" step="${f.step}" value="${f.defaultVal.toFixed(4)}">
          <input type="number" class="al2-cdl-num al2-cdl-ch-b" id="al2-cdl-${f.key}-2"
                 min="${f.min}" max="${f.max}" step="${f.step}" value="${f.defaultVal.toFixed(4)}">
          <button class="al2-cdl-rst" id="al2-cdl-rst-${f.key}" title="Reset ${f.label}">⌀</button>
        </div>
      `).join('')}
      <!-- Sat row with slider -->
      <div class="al2-cdl-sat-row">
        <span class="al2-cdl-label" id="al2-cdl-lbl-sat" title="Drag to adjust">Sat</span>
        <div class="al2-field-track-wrap" style="flex:1">
          <input type="range" class="al2-field-range al2-field-range--pro" id="al2-cdl-sat-range"
                 min="0" max="4" step="0.001" value="1">
        </div>
        <input type="number" class="al2-cdl-num" id="al2-cdl-sat"
               min="0" max="4" step="0.001" value="1.0000" style="width:58px">
        <button class="al2-cdl-rst" id="al2-cdl-rst-sat" title="Reset Sat">⌀</button>
      </div>
    </div>
  `;

  document.getElementById('al2-cdl-enabled')?.addEventListener('change', e => {
    setCdlEnabled(e.target.checked);
    document.getElementById('al2-cdl-fields')?.classList.toggle('al2-cdl-disabled', !e.target.checked);
  });

  for (const f of CDL_VEC_FIELDS) {
    const inputs = [0, 1, 2].map(i => document.getElementById(`al2-cdl-${f.key}-${i}`));
    const labelEl = document.getElementById(`al2-cdl-lbl-${f.key}`);

    const commitVec = vals => {
      inputs.forEach((el, i) => { if (el) el.value = vals[i].toFixed(4); });
      setCdlValue(f.key, vals);
    };

    inputs.forEach((el, i) => {
      if (!el) return;
      el.addEventListener('change', () => {
        const vals = inputs.map(inp => {
          const v = parseFloat(inp?.value);
          return isNaN(v) ? f.defaultVal : Math.min(f.max, Math.max(f.min, v));
        });
        commitVec(vals);
      });
      el.addEventListener('dblclick', e => {
        e.preventDefault();
        el.value = f.defaultVal.toFixed(4);
        const vals = inputs.map(inp => parseFloat(inp?.value) || f.defaultVal);
        setCdlValue(f.key, vals);
      });
    });

    if (labelEl) {
      attachScrubGanged(labelEl, inputs.filter(Boolean), {
        step:        f.step,
        min:         f.min,
        max:         f.max,
        decimals:    4,
        defaultVals: [f.defaultVal, f.defaultVal, f.defaultVal],
        onChange:    commitVec,
      });
    }
  }

  // Saturation — wire both range slider and number input
  const satInput = document.getElementById('al2-cdl-sat');
  const satRange = document.getElementById('al2-cdl-sat-range');
  const satLabel = document.getElementById('al2-cdl-lbl-sat');
  const satRst   = document.getElementById('al2-cdl-rst-sat');
  const satCfg   = { min: 0, max: 4, step: 0.001, decimals: 4, defaultVal: 1 };

  if (satInput) {
    const commitSat = v => {
      const clamped = Math.min(4, Math.max(0, v));
      satInput.value = clamped.toFixed(4);
      if (satRange) { satRange.value = clamped; _updateRangeTrack(satRange, satCfg); }
      if (satRst) satRst.style.opacity = Math.abs(clamped - 1) < 0.001 ? '0' : '1';
      setCdlValue('sat', clamped);
    };
    if (satRange) {
      _updateRangeTrack(satRange, satCfg);
      satRange.addEventListener('input', () => commitSat(parseFloat(satRange.value)));
    }
    satInput.addEventListener('change',  () => commitSat(parseFloat(satInput.value) || 1));
    satInput.addEventListener('dblclick', e => { e.preventDefault(); commitSat(1); });
    satRst?.addEventListener('click', () => commitSat(1));
    if (satLabel) {
      attachScrub(satLabel, satInput, {
        step: 0.001, min: 0, max: 4, decimals: 4, defaultVal: 1, onChange: commitSat,
      });
    }
  }

  // Per-row reset buttons for Slope/Offset/Power
  for (const f of CDL_VEC_FIELDS) {
    document.getElementById(`al2-cdl-rst-${f.key}`)?.addEventListener('click', () => {
      const inputs = [0, 1, 2].map(i => document.getElementById(`al2-cdl-${f.key}-${i}`));
      inputs.forEach(el => { if (el) el.value = f.defaultVal.toFixed(4); });
      setCdlValue(f.key, [f.defaultVal, f.defaultVal, f.defaultVal]);
    });
  }
}

function _wireViewSection() {
  // Output transform buttons
  document.querySelectorAll('#al2-view-btns .al2-view-btn').forEach(btn => {
    btn.addEventListener('click', () => setOutputTransform(btn.dataset.odt));
  });

  document.getElementById('al2-working-sel')?.addEventListener('change', e => {
    setWorkingLocation(e.target.value);
  });

  document.getElementById('al2-preserve-sdr')?.addEventListener('change', e => {
    patch({ preserveSdr: e.target.checked });
  });
}

function _wireExportSection() {
  document.getElementById('al2-clip-id')?.addEventListener('input', e => {
    setClipId(e.target.value);
  });

  const showResult = res => {
    const el = document.getElementById('al2-export-result');
    if (!el) return;
    if (res.ok) {
      el.className = 'al2-export-result ok';
      el.textContent = `Exported${res.warnings?.length ? ` (${res.warnings.length} warning${res.warnings.length > 1 ? 's' : ''})` : ''}`;
    } else {
      el.className = 'al2-export-result err';
      el.textContent = (res.errors || []).join('; ') || 'Export failed';
    }
    setTimeout(() => { el.className = 'al2-export-result'; }, 5000);
  };

  const _can = action => {
    const p = window.PFX_PERMISSIONS;
    return !p || p.canDoAction(action);
  };
  const _denied = action => {
    window.pfxPolicyApi?.logEvent({ event: 'export_denied', action, timestamp: new Date().toISOString() });
    window.pfxNoAccessView?.showDeniedToast(action);
  };

  document.getElementById('al2-export-amf')?.addEventListener('click', () => {
    if (!_can('export_amf')) { _denied('export_amf'); return; }
    showResult(exportAmf(getState()));
  });
  document.getElementById('al2-export-cdl')?.addEventListener('click', () => {
    if (!_can('export_cdl')) { _denied('export_cdl'); return; }
    showResult(exportCdl(getState()));
  });
  document.getElementById('al2-export-clf')?.addEventListener('click', () => {
    if (!_can('export_clf')) { _denied('export_clf'); return; }
    showResult(exportClf(getState()));
  });
  document.getElementById('al2-export-summary')?.addEventListener('click', () => {
    if (!_can('export_color_summary')) { _denied('export_color_summary'); return; }
    showResult(exportSummary(getState()));
  });
}

// ── Status rail wiring ────────────────────────────────────────────────────────
function _wireStatusRail(root) {
  // Steps are purely reactive — updated in _renderAll
}

// ── Viewer wiring ─────────────────────────────────────────────────────────────
let _viewerWired = false;
function _wireViewer(root) {
  if (_viewerWired) return;
  _viewerWired = true;

  const graded   = document.getElementById('al2-vt-graded');
  const original = document.getElementById('al2-vt-original');
  const wipe     = document.getElementById('al2-vt-wipe');
  const split    = document.getElementById('al2-vt-split');
  const clipWarn = document.getElementById('al2-vt-clipwarn');

  graded?.addEventListener('click', () => {
    _viewerShowGraded = true;
    graded.classList.add('active');
    original?.classList.remove('active');
    _applyViewerFilter(getState());
  });

  original?.addEventListener('click', () => {
    _viewerShowGraded = false;
    original.classList.add('active');
    graded?.classList.remove('active');
    _applyViewerFilter(getState());
  });

  wipe?.addEventListener('click', () => {
    wipe.classList.toggle('active');
    // Wipe is a visual affordance placeholder for now
  });

  split?.addEventListener('click', () => {
    split.classList.toggle('active');
  });

  document.getElementById('al2-vt-fit')?.addEventListener('click', () => {
    const video = _getViewerVideo();
    if (!video) return;
    video.style.width = '100%';
    video.style.height = '100%';
    video.style.objectFit = 'contain';
    video.style.maxWidth = '';
    video.style.maxHeight = '';
    const zoomEl = document.getElementById('al2-meta-zoom');
    if (zoomEl) zoomEl.textContent = 'Fit';
    document.getElementById('al2-vt-fit')?.classList.add('active');
    document.getElementById('al2-vt-100')?.classList.remove('active');
  });

  document.getElementById('al2-vt-100')?.addEventListener('click', () => {
    const video = _getViewerVideo();
    const wrap  = document.getElementById('al2-viewer-inner');
    if (!video || !wrap) return;
    // Clamp to container rather than overflowing — show at max native without overflow
    video.style.width = 'auto';
    video.style.height = 'auto';
    video.style.maxWidth = '100%';
    video.style.maxHeight = '100%';
    video.style.objectFit = 'none';
    const zoomEl = document.getElementById('al2-meta-zoom');
    if (zoomEl) zoomEl.textContent = '100%';
    document.getElementById('al2-vt-100')?.classList.add('active');
    document.getElementById('al2-vt-fit')?.classList.remove('active');
  });

  clipWarn?.addEventListener('click', () => {
    _clipWarnVisible = !_clipWarnVisible;
    clipWarn.classList.toggle('active', _clipWarnVisible);
    const overlay = document.getElementById('al2-clip-warn-overlay');
    if (overlay) overlay.classList.toggle('visible', _clipWarnVisible);
  });
}

function _getViewerVideo() {
  const wrap = document.getElementById('al2-viewer-inner');
  return wrap?.querySelector('video') || null;
}

// ── Scope rail wiring ─────────────────────────────────────────────────────────
function _wireScopesRail() {
  document.querySelectorAll('#al2-scope-mode-btns .al2-scope-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _scopeMode = btn.dataset.scope;
      document.querySelectorAll('#al2-scope-mode-btns .al2-scope-mode-btn').forEach(b =>
        b.classList.toggle('active', b === btn)
      );
      _updateScopeTag();
    });
  });

  document.getElementById('al2-scope-collapse')?.addEventListener('click', () => {
    _scopeCollapsed = !_scopeCollapsed;
    const rail = document.getElementById('al2-scope-rail');
    const btn  = document.getElementById('al2-scope-collapse');
    if (rail) rail.classList.toggle('collapsed', _scopeCollapsed);
    if (btn)  btn.textContent = _scopeCollapsed ? '▴' : '▾';
  });
}

function _updateScopeTag() {
  const tagMap = { histogram: 'RGB', waveform: 'Luma', parade: 'RGB Prd', vectorscope: 'YCbCr' };
  const tag = document.getElementById('al2-scope-cs-tag');
  if (tag) tag.textContent = tagMap[_scopeMode] || 'RGB';
}

// Called by histogram/waveform/parade after each frame — updates the stats row
let _scopeStats = { r: 0, g: 0, b: 0, l: 0, clip: false };
function _updateScopeStats(r255, g255, b255, l255, clip) {
  _scopeStats = { r: r255, g: g255, b: b255, l: l255, clip };
  const fmt = v => (v / 2.55).toFixed(0) + '%';
  const el = id => document.getElementById(id);
  const rEl = el('al2-sval-r'); if (rEl) rEl.textContent = fmt(r255);
  const gEl = el('al2-sval-g'); if (gEl) gEl.textContent = fmt(g255);
  const bEl = el('al2-sval-b'); if (bEl) bEl.textContent = fmt(b255);
  const lEl = el('al2-sval-l'); if (lEl) lEl.textContent = fmt(l255);
  const clipEl = el('al2-scope-clip-tag');
  if (clipEl) clipEl.style.display = clip ? '' : 'none';
}

// ── RenderAll ─────────────────────────────────────────────────────────────────
let _prevStateKey = '';
function _renderAll(state) {
  if (!document.getElementById('main-aceslook')) return;

  // Push to history (debounced)
  const stateKey = JSON.stringify({
    mode: state.mode,
    inputTransform: state.inputTransform,
    outputTransform: state.outputTransform,
    primaryControls: state.primaryControls,
    cdlEnabled: state.cdlEnabled,
  });
  if (stateKey !== _prevStateKey) {
    _prevStateKey = stateKey;
    clearTimeout(_histDebounce);
    _histDebounce = setTimeout(() => _pushHistory(state), 800);
  }

  _renderStatusRail(state);
  _renderWorkflowMode(state);
  _renderSourceSection(state);
  _renderInputSection(state);
  _renderBasicSection(state);
  _renderCdlSection(state);
  _renderLookStack(state);
  _renderViewSection(state);
  _renderExportSection(state);
  _renderValidation(state);
  _renderMetaStrip(state);
  _renderSmartHeaders(state);
  _renderLeftRailBadges(state);
  _renderInlineSourcePicker(state);
  _renderRelinkOverlay(state);
  _updateViewer(state);
}

// ── Re-link overlay ───────────────────────────────────────────────────────────

let _relinkWired    = false;
let _relinkDismissed = false; // user dismissed overlay for this session; re-show on next project load
let _autoRelinkTriedPath = null; // path we've already attempted this session (avoid re-try loops)
let _autoRelinkBusy      = false;

function _b64ToFile(b64, name, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name || 'source', type ? { type } : undefined);
}

function _guessMime(name) {
  const ext = (name || '').split('.').pop().toLowerCase();
  return ({ mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm' })[ext] || '';
}

// Desktop-only silent re-link: if the source went missing but we saved its
// absolute path, reopen it from disk (no Browse dialog) — provided it still
// exists. Falls through (leaving the manual overlay) if the file moved or the
// read fails. Browser builds have no readFile, so this never runs there.
async function _tryAutoRelink(sourcePath, sourceName) {
  if (_autoRelinkBusy) return;
  const pf = window.pfxPlatform;
  if (!pf || typeof pf.readFile !== 'function') return;
  _autoRelinkBusy = true;
  try {
    if (typeof pf.fileExists === 'function') {
      const exists = await pf.fileExists(sourcePath);
      if (!exists) return; // moved/deleted → manual re-link
    }
    const b64 = await pf.readFile({ filePath: sourcePath, encoding: 'base64' });
    if (!b64) return;
    // Only apply if still orphaned — the user may have re-linked manually meanwhile.
    if (getState().source instanceof File) return;
    _relinkSourceFile(_b64ToFile(b64, sourceName, _guessMime(sourceName || sourcePath)));
  } catch { /* leave the manual overlay up */ }
  finally { _autoRelinkBusy = false; }
}

function _wireRelinkOverlay() {
  if (_relinkWired) return;
  _relinkWired = true;
  document.getElementById('al2-relink-btn')?.addEventListener('click', () => {
    document.getElementById('al2-src-file-input')?.click();
  });
  document.getElementById('al2-relink-dismiss')?.addEventListener('click', () => {
    _relinkDismissed = true;
    const overlay = document.getElementById('al2-relink-overlay');
    if (overlay) overlay.style.display = 'none';
  });
}

function _renderRelinkOverlay(state) {
  const overlay  = document.getElementById('al2-relink-overlay');
  const nameEl   = document.getElementById('al2-relink-name');
  if (!overlay) return;

  _wireRelinkOverlay();

  const hasFile  = state.source instanceof File;
  const orphaned = !hasFile && !!state.sourceName;

  if (hasFile) {
    // File restored — reset flags so a later disappearance shows/retries again
    _relinkDismissed = false;
    _autoRelinkTriedPath = null;
    overlay.style.display = 'none';
  } else if (orphaned && !_relinkDismissed) {
    overlay.style.display = '';
    if (nameEl) nameEl.textContent = state.sourceName;
    document.getElementById('al2-sec-source')?.classList.add('open');
    // Desktop: try to reopen silently from the saved absolute path before the
    // user has to Browse. On success the next render hides this overlay; on
    // failure (file moved/deleted) the manual re-link button stays.
    if (state.sourcePath && _autoRelinkTriedPath !== state.sourcePath && window.pfxPlatform?.readFile) {
      _autoRelinkTriedPath = state.sourcePath;
      _tryAutoRelink(state.sourcePath, state.sourceName);
    }
  } else {
    overlay.style.display = 'none';
  }
}

// ── Smart section headers — add status dots and count badges ──────────────────

function _setHeaderDot(sectionId, cls, title) {
  const hdr = document.querySelector(`#${sectionId} .al2-insp-header`);
  if (!hdr) return;
  let dot = hdr.querySelector('.al2-hdr-dot');
  if (!dot) {
    dot = document.createElement('span');
    dot.className = 'al2-hdr-dot';
    const chevron = hdr.querySelector('.al2-insp-chevron');
    hdr.insertBefore(dot, chevron || null);
  }
  dot.className = `al2-hdr-dot${cls ? ' al2-hdr-dot--' + cls : ''}`;
  dot.title = title || '';
}

function _setHeaderBadge(sectionId, text) {
  const hdr = document.querySelector(`#${sectionId} .al2-insp-header`);
  if (!hdr) return;
  let badge = hdr.querySelector('.al2-hdr-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'al2-hdr-badge';
    const chevron = hdr.querySelector('.al2-insp-chevron');
    hdr.insertBefore(badge, chevron || null);
  }
  badge.textContent = text || '';
  badge.style.display = text ? '' : 'none';
}

function _cdlIsModified(state) {
  const cdl = state.cdl || {};
  const defSlope = [1, 1, 1], defOffset = [0, 0, 0], defPower = [1, 1, 1];
  if (!state.cdlEnabled) return false;
  const vecDiff = (a, def) => a && a.some((v, i) => Math.abs(v - def[i]) > 0.0001);
  return vecDiff(cdl.slope, defSlope) || vecDiff(cdl.offset, defOffset) ||
         vecDiff(cdl.power, defPower) || Math.abs((cdl.sat ?? 1) - 1) > 0.0001;
}

function _basicIsModified(state) {
  const pc = state.primaryControls || {};
  const defaults = { exposure: 0, contrast: 1, saturation: 1, temperature: 0 };
  return Object.entries(defaults).some(([k, v]) => Math.abs((pc[k] ?? v) - v) > 0.001);
}

function _renderSmartHeaders(state) {
  // INPUT section — warn dot when AUTO
  if (state.inputTransform === 'AUTO' && state.source instanceof File) {
    _setHeaderDot('al2-insp-input', 'warn', 'Input transform is AUTO — resolve before exporting');
  } else if (state.inputTransform && state.inputTransform !== 'AUTO') {
    _setHeaderDot('al2-insp-input', 'ready', 'Input transform resolved');
  } else {
    _setHeaderDot('al2-insp-input', '', '');
  }

  // BASIC section — accent dot when any value modified from default
  if (_basicIsModified(state)) {
    _setHeaderDot('al2-insp-basic', 'accent', 'Primary controls adjusted');
  } else {
    _setHeaderDot('al2-insp-basic', '', '');
  }

  // CDL section — accent dot when enabled & modified, or warn when enabled but identity
  if (state.cdlEnabled && _cdlIsModified(state)) {
    _setHeaderDot('al2-insp-cdl', 'accent', 'CDL active with modifications');
  } else if (state.cdlEnabled) {
    _setHeaderDot('al2-insp-cdl', 'muted', 'CDL enabled (identity values)');
  } else {
    _setHeaderDot('al2-insp-cdl', '', '');
  }

  // LOOK STACK — badge with count
  const stackCount = (state.lookStack || []).length;
  const enabledCount = (state.lookStack || []).filter(i => i.enabled).length;
  if (stackCount > 0) {
    _setHeaderBadge('al2-insp-lookstack', `${enabledCount}/${stackCount}`);
    _setHeaderDot('al2-insp-lookstack', enabledCount > 0 ? 'accent' : 'muted', `${enabledCount} of ${stackCount} items active`);
  } else {
    _setHeaderBadge('al2-insp-lookstack', '');
    _setHeaderDot('al2-insp-lookstack', '', '');
  }

  // EXPORT — error dot when validation errors block export
  const hasErrors = (state.errors || []).length > 0;
  if (hasErrors) {
    _setHeaderDot('al2-insp-export', 'warn', 'Resolve errors before exporting');
  } else if (state.source instanceof File && state.clipId) {
    _setHeaderDot('al2-insp-export', 'ready', 'Ready to export');
  } else {
    _setHeaderDot('al2-insp-export', '', '');
  }

  // Auto-expand CDL section if enabled
  const cdlSection = document.getElementById('al2-insp-cdl');
  if (cdlSection && state.cdlEnabled && !cdlSection.classList.contains('open')) {
    cdlSection.classList.add('open');
  }
}

// ── Left rail badges (count + smart visibility) ───────────────────────────────

function _renderLeftRailBadges(state) {
  // Show/dim sections that have no content and no source
  const hasSource = state.source instanceof File;
  ['al2-sec-presets', 'al2-sec-snapshots', 'al2-sec-history', 'al2-sec-versions'].forEach(id => {
    const sec = document.getElementById(id);
    if (!sec) return;
    sec.style.opacity = hasSource ? '' : '0.45';
    sec.style.pointerEvents = hasSource ? '' : 'none';
  });

  // Snapshot count badge in header
  _setRailHeaderBadge('al2-sec-snapshots', _snapshots.length || '');
  _setRailHeaderBadge('al2-sec-history',   _history.length || '');
  _setRailHeaderBadge('al2-sec-versions',  _versions.length || '');
  _setRailHeaderBadge('al2-sec-presets',   listPresets().length || '');
}

function _setRailHeaderBadge(sectionId, text) {
  const hdr = document.querySelector(`#${sectionId} .al2-rail-section-header`);
  if (!hdr) return;
  let badge = hdr.querySelector('.al2-rail-badge');
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'al2-rail-badge';
    const chevron = hdr.querySelector('.al2-rail-chevron');
    if (chevron) hdr.insertBefore(badge, chevron);
    else hdr.appendChild(badge);
  }
  badge.textContent = text || '';
  badge.style.display = text ? '' : 'none';
}

function _renderStatusRail(state) {
  const hasSource = state.source instanceof File;
  const hasInput  = state.inputTransform && state.inputTransform !== 'AUTO';
  const hasLook   = state.cdlEnabled || (state.lookStack || []).length > 0;
  const hasView   = state.outputTransform !== 'NONE_RECIPE_ONLY';
  const hasErrors = (state.errors || []).length > 0;

  _setStep('al2-step-source', hasSource ? 'ready' : '');
  _setStep('al2-step-input',  hasSource && hasInput ? 'ready' : hasSource ? 'warn' : '');
  _setStep('al2-step-look',   hasLook ? 'ready' : '');
  _setStep('al2-step-view',   hasView ? 'ready' : '');
  _setStep('al2-step-export', hasErrors ? 'error' : hasSource ? 'ready' : '');
}

function _setStep(id, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('ready', 'warn', 'error');
  if (cls) el.classList.add(cls);
}

function _renderWorkflowMode(state) {
  document.querySelectorAll('#al2-mode-seg .al2-mode-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === state.mode);
  });
}

function _renderSourceSection(state) {
  const infoEl   = document.getElementById('al2-source-info');
  const nameEl   = document.getElementById('al2-src-name');
  const metaEl   = document.getElementById('al2-src-meta');
  const dropZone = document.getElementById('al2-drop-zone');

  const hasFile  = state.source instanceof File;
  const orphaned = !hasFile && !!state.sourceName;

  if (!hasFile && !orphaned) {
    // No file, no history
    if (infoEl)   infoEl.style.display   = 'none';
    if (dropZone) dropZone.style.display = '';
    return;
  }

  // Either has file OR is orphaned — show the info panel
  if (infoEl)   infoEl.style.display   = 'block';
  if (dropZone) dropZone.style.display = 'none';

  const displayName = hasFile ? state.source.name : state.sourceName;
  if (nameEl) {
    nameEl.textContent = displayName;
    nameEl.style.color = orphaned ? 'var(--al-warn)' : '';
  }

  if (metaEl) {
    if (orphaned) {
      metaEl.innerHTML = `
        <span class="al2-badge al2-badge-conf-medium">Missing file</span>
        <span style="font-size:10px;color:var(--al-warn);margin-left:2px;">↺ Click toolbar to re-link</span>
      `;
    } else {
      const { confidence } = detectSource(state.source);
      const confClass = confidence === 'high' ? 'al2-badge-conf-high'
                      : confidence === 'medium' ? 'al2-badge-conf-medium'
                      : 'al2-badge-conf-low';
      const confLabel = confidence === 'high' ? 'High' : confidence === 'medium' ? 'Med' : 'Low';
      metaEl.innerHTML = `
        <span class="al2-badge al2-badge-class">${_esc(state.sourceClass)}</span>
        <span class="al2-badge ${confClass}">${confLabel}</span>
      `;
    }
  }
}

function _renderInputSection(state) {
  const sel     = document.getElementById('al2-idt-sel');
  const confRow = document.getElementById('al2-idt-conf-row');
  const noteEl  = document.getElementById('al2-idt-note');

  if (sel && document.activeElement !== sel) {
    sel.value = state.inputTransform;
  }

  const entry = REGISTRY.inputTransforms[state.inputTransform] || {};

  if (confRow) {
    const { confidence } = state.source instanceof File ? detectSource(state.source) : { confidence: 'auto' };
    const isAuto = state.inputTransform === 'AUTO';
    confRow.innerHTML = isAuto
      ? `<span class="al2-badge al2-badge-conf-auto">Auto</span>`
      : `<span class="al2-badge al2-badge-class">${_esc(entry.label || state.inputTransform)}</span>`;
  }

  if (noteEl) {
    if (entry.note) {
      noteEl.textContent = entry.note;
      noteEl.style.display = '';
    } else {
      noteEl.style.display = 'none';
    }
  }

  // Warn if AUTO and errors mention it
  const inputBody = document.getElementById('al2-insp-input-body');
  if (inputBody) {
    inputBody.querySelectorAll('.al2-warn-banner').forEach(e => e.remove());
    if (state.inputTransform === 'AUTO' && state.source instanceof File) {
      const banner = document.createElement('div');
      banner.className = 'al2-warn-banner';
      banner.textContent = 'Input transform is AUTO — resolve before exporting.';
      inputBody.appendChild(banner);
    }
  }
}

function _renderBasicSection(state) {
  const pc = state.primaryControls || {};
  for (const c of PRIMARY_CONTROLS) {
    const range = document.getElementById(`al2-pcr-${c.key}`);
    const num   = document.getElementById(`al2-pcn-${c.key}`);
    const rst   = document.getElementById(`al2-rst-${c.key}`);
    if (!range || !num) continue;
    if (document.activeElement !== range && document.activeElement !== num) {
      const v = pc[c.key] ?? c.defaultVal;
      range.value = v;
      num.value   = Number(v).toFixed(c.decimals);
      _updateRangeTrack(range, c);
      if (rst) rst.style.opacity = Math.abs(v - c.defaultVal) < 0.001 ? '0' : '1';
    }
  }
}

function _renderCdlSection(state) {
  const toggle = document.getElementById('al2-cdl-enabled');
  const fields = document.getElementById('al2-cdl-fields');

  if (toggle && toggle.checked !== state.cdlEnabled) {
    toggle.checked = state.cdlEnabled;
  }
  if (fields) {
    fields.classList.toggle('al2-cdl-disabled', !state.cdlEnabled);
  }

  for (const f of CDL_VEC_FIELDS) {
    [0, 1, 2].forEach(i => {
      const el = document.getElementById(`al2-cdl-${f.key}-${i}`);
      if (el && document.activeElement !== el) {
        el.value = ((state.cdl || {})[f.key]?.[i] ?? f.defaultVal).toFixed(4);
      }
    });
  }

  const satEl    = document.getElementById('al2-cdl-sat');
  const satRange = document.getElementById('al2-cdl-sat-range');
  if (satEl && document.activeElement !== satEl) {
    const sv = (state.cdl || {}).sat ?? 1;
    satEl.value = sv.toFixed(4);
    if (satRange && document.activeElement !== satRange) {
      satRange.value = sv;
      _updateRangeTrack(satRange, { min: 0, max: 4, defaultVal: 1 });
    }
  }
}

function _renderLookStack(state) {
  const body = document.getElementById('al2-insp-ls-body');
  if (!body) return;

  if ((state.lookStack || []).length === 0) {
    body.innerHTML = `
      <div class="al2-ls-empty">No look items.</div>
      <div class="al2-ls-add-row">
        <button class="al2-ls-add-btn" id="al2-ls-add-cdl">+ CDL</button>
        <button class="al2-ls-add-btn" id="al2-ls-add-clf">+ CLF</button>
        <button class="al2-ls-add-btn" id="al2-ls-add-lut">+ LUT</button>
      </div>
    `;
  } else {
    body.innerHTML = (state.lookStack || []).map(item => `
      <div class="al2-ls-item ${item.enabled ? '' : 'al2-ls-item--disabled'}" data-id="${_esc(item.id)}">
        <span class="al2-ls-drag" title="Drag to reorder">⠿</span>
        <input type="checkbox" class="al2-ls-enable" data-id="${_esc(item.id)}"
               ${item.enabled ? 'checked' : ''}>
        <span class="al2-ls-kind al2-ls-kind-${item.kind}">${item.kind.toUpperCase()}</span>
        <span class="al2-ls-name" title="${_esc(item.label)}">${_esc(item.label)}</span>
        <button class="al2-ls-remove" data-id="${_esc(item.id)}" title="Remove">✕</button>
      </div>
    `).join('') + `
      <div class="al2-ls-add-row">
        <button class="al2-ls-add-btn" id="al2-ls-add-cdl">+ CDL</button>
        <button class="al2-ls-add-btn" id="al2-ls-add-clf">+ CLF</button>
        <button class="al2-ls-add-btn" id="al2-ls-add-lut">+ LUT</button>
      </div>
    `;
  }

  // Wire add buttons
  document.getElementById('al2-ls-add-cdl')?.addEventListener('click', () => addLookItem('cdl', 'CDL'));
  document.getElementById('al2-ls-add-clf')?.addEventListener('click', () => addLookItem('clf', 'CLF', { file: '' }));
  document.getElementById('al2-ls-add-lut')?.addEventListener('click', () => addLookItem('lut', 'LUT', { file: '' }));

  // Wire enable checkboxes
  body.querySelectorAll('.al2-ls-enable').forEach(el => {
    el.addEventListener('change', () => toggleLookItem(el.dataset.id));
  });

  // Wire remove buttons
  body.querySelectorAll('.al2-ls-remove').forEach(el => {
    el.addEventListener('click', () => removeLookItem(el.dataset.id));
  });

  // Wire drag-to-reorder
  let _dragId = null;
  body.querySelectorAll('.al2-ls-item').forEach(el => {
    el.setAttribute('draggable', 'true');

    el.addEventListener('dragstart', e => {
      _dragId = el.dataset.id;
      el.classList.add('al2-ls-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    el.addEventListener('dragend', () => {
      _dragId = null;
      body.querySelectorAll('.al2-ls-item').forEach(i =>
        i.classList.remove('al2-ls-dragging', 'al2-ls-drag-over')
      );
    });

    el.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (el.dataset.id !== _dragId) el.classList.add('al2-ls-drag-over');
    });

    el.addEventListener('dragleave', () => el.classList.remove('al2-ls-drag-over'));

    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('al2-ls-drag-over');
      if (!_dragId || _dragId === el.dataset.id) return;
      const items = [...body.querySelectorAll('.al2-ls-item')];
      const ids   = items.map(i => i.dataset.id);
      const from  = ids.indexOf(_dragId);
      const to    = ids.indexOf(el.dataset.id);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1);
      ids.splice(to, 0, _dragId);
      reorderLookItems(ids);
    });
  });
}

function _renderViewSection(state) {
  // Output transform buttons
  document.querySelectorAll('#al2-view-btns .al2-view-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.odt === state.outputTransform);
  });

  const workingSel = document.getElementById('al2-working-sel');
  if (workingSel && document.activeElement !== workingSel) {
    workingSel.value = state.workingLocation;
  }

  // Preserve SDR row
  const preserveRow = document.getElementById('al2-preserve-sdr-row');
  if (preserveRow) {
    preserveRow.style.display = state.mode === 'sdr_qt_in_hdr_show' ? '' : 'none';
  }

  const preserveChk = document.getElementById('al2-preserve-sdr');
  if (preserveChk && preserveChk.checked !== state.preserveSdr) {
    preserveChk.checked = state.preserveSdr;
  }
}

function _renderExportSection(state) {
  const clipInput = document.getElementById('al2-clip-id');
  if (clipInput && document.activeElement !== clipInput) {
    clipInput.value = state.clipId || '';
  }

  const hasErrors = (state.errors || []).length > 0;
  const amfBtn    = document.getElementById('al2-export-amf');
  const cdlBtn    = document.getElementById('al2-export-cdl');
  const clfBtn    = document.getElementById('al2-export-clf');

  if (amfBtn) amfBtn.disabled = hasErrors;
  if (cdlBtn) cdlBtn.disabled = hasErrors || !state.cdlEnabled;
  if (clfBtn) clfBtn.disabled = hasErrors;
}

function _renderValidation(state) {
  const el = document.getElementById('al2-validation');
  if (!el) return;

  const errors   = state.errors   || [];
  const warnings = state.warnings || [];

  if (errors.length === 0 && warnings.length === 0) {
    el.className = 'al2-validation';
    el.innerHTML = '';
    return;
  }

  el.className = 'al2-validation has-issues';
  el.innerHTML = [
    ...errors.map(e   => `<div class="al2-val-error"><span>✗</span><span>${_esc(e)}</span></div>`),
    ...warnings.map(w => `<div class="al2-val-warn"><span>⚠</span><span>${_esc(w)}</span></div>`),
  ].join('');
}

function _renderMetaStrip(state) {
  const nameEl  = document.getElementById('al2-meta-name');
  const classEl = document.getElementById('al2-meta-class');
  const chainEl = document.getElementById('al2-meta-chain');

  const _hasRealFile = state.source instanceof File;
  if (nameEl) nameEl.textContent = _hasRealFile ? state.source.name : (state.sourceName || 'No file loaded');

  if (classEl) {
    classEl.textContent = _hasRealFile ? state.sourceClass : '—';
  }

  if (chainEl && _hasRealFile) {
    const idt = REGISTRY.inputTransforms[state.inputTransform];
    const odt = REGISTRY.outputTransforms[state.outputTransform];
    const idtLabel = idt ? idt.label : state.inputTransform;
    const odtLabel = odt ? odt.label : (state.outputTransform === 'NONE_RECIPE_ONLY' ? 'Recipe Only' : state.outputTransform);
    chainEl.textContent = `${idtLabel} → ${state.workingLocation} → ${odtLabel}`;
  } else if (chainEl) {
    chainEl.textContent = '';
  }
}

// ── Viewer ────────────────────────────────────────────────────────────────────
function _updateViewer(state) {
  const wrap = document.getElementById('al2-viewer-inner');
  if (!wrap) return;

  const file = state.source instanceof File ? state.source : null;

  if (!file) {
    if (_viewerObjectUrl) { URL.revokeObjectURL(_viewerObjectUrl); _viewerObjectUrl = null; }
    _releaseProxyVideo();
    _viewerSourceName = null;
    _stopHistogram();
    wrap.style.cssText = 'flex:1;width:100%;height:100%;background:#000;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;';
    wrap.innerHTML = '<span style="color:var(--al-text-muted);font-size:12px">Drag a source clip here to preview and grade it.</span>';
    const emptyVideo = document.createElement('video');
    emptyVideo.style.cssText = 'display:none;';
    emptyVideo.setAttribute('aria-hidden', 'true');
    wrap.appendChild(emptyVideo);
    import('../../core/resolveVideoTransport.js')
      .then(m => m.attachResolveTransport(emptyVideo)).catch(() => {});
    return;
  }

  if (file.name === _viewerSourceName) {
    // Same file — just update filter
    _applyViewerFilter(state);
    return;
  }

  // New file
  if (_viewerObjectUrl) { URL.revokeObjectURL(_viewerObjectUrl); _viewerObjectUrl = null; }
  _releaseProxyVideo();
  _viewerSourceName = file.name;
  _stopHistogram();

  // Browser-native formats (mp4/m4v/webm/avi): direct load, no proxy needed.
  if (_VIDEO_EXT.test(file.name) && !/\.mov$/i.test(file.name)) {
    wrap.innerHTML   = '';
    wrap.style.cssText = 'flex:1;width:100%;height:100%;background:#000;display:block;overflow:hidden;position:relative;';
    const video = document.createElement('video');
    video.controls = true;
    video.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
    wrap.appendChild(video);
    // Resolve-style transport (replaces the native <video controls> bar).
    import('../../core/resolveVideoTransport.js')
      .then(m => m.attachResolveTransport(video)).catch(() => {});

    const _setVideoSrc = (src) => {
      video.src = src;
      _viewerObjectUrl = src.startsWith('blob:') ? src : null;
      video.load();
      _addTcOverlay(wrap, video);
      _startHistogram(video);
      _applyViewerFilter(state, video);
    };
    _setVideoSrc(URL.createObjectURL(file));

  } else if (_OCF_EXT.test(file.name) || /\.mov$/i.test(file.name)) {
    // .mov (may be ProRes/DNxHD) and all OCF formats go through the proxy path.
    // attachPlayableVideo handles blind-frame detection: H.264 .mov plays directly,
    // ProRes .mov triggers transparent proxy generation via the companion.
    wrap.style.cssText = 'flex:1;width:100%;height:100%;background:#0d0d12;display:flex;align-items:center;justify-content:center;overflow:hidden;position:relative;';
    wrap.innerHTML = '';

    // Progress overlay
    const overlay = document.createElement('div');
    overlay.id = 'al2-proxy-overlay';

    const nameDiv = document.createElement('div');
    nameDiv.style.cssText = 'font-size:13px;color:#8a8c90;font-weight:600;';
    nameDiv.textContent = file.name;

    const msgDiv = document.createElement('div');
    msgDiv.id = 'al2-proxy-msg';
    msgDiv.style.cssText = 'font-size:11px;color:#9a9cb8;';
    msgDiv.textContent = 'Preparing proxy…';

    const etaDiv = document.createElement('div');
    etaDiv.id = 'al2-proxy-eta';
    etaDiv.style.cssText = 'font-size:11px;font-weight:700;color:#f5c542;display:none;';

    const barWrap = document.createElement('div');
    barWrap.style.cssText = 'width:220px;height:4px;background:#1e1e2a;border-radius:2px;overflow:hidden;';
    const bar = document.createElement('div');
    bar.id = 'al2-proxy-bar';
    bar.className = 'al-proxy-shimmer';
    bar.style.cssText = 'height:100%;width:100%;border-radius:2px;';
    barWrap.appendChild(bar);

    const manualLabel = document.createElement('label');
    manualLabel.id = 'al2-proxy-manual-btn';
    manualLabel.style.cssText = 'display:none;align-items:center;gap:6px;padding:6px 14px;border-radius:6px;cursor:pointer;background:rgba(90,141,224,.12);border:1px solid rgba(90,141,224,.3);font-size:11px;font-weight:600;color:var(--al-accent);margin-top:6px;';
    manualLabel.innerHTML = `Load Proxy Manually<input type="file" accept="video/quicktime,video/mp4,.mov,.mp4,.m4v" style="display:none">`;
    const manualInput = manualLabel.querySelector('input');
    if (manualInput) {
      manualInput.onchange = e => {
        const proxy = e.target.files?.[0];
        if (proxy) _loadProxyVideo(wrap, proxy, getState());
      };
    }

    overlay.appendChild(nameDiv);
    overlay.appendChild(msgDiv);
    overlay.appendChild(barWrap);
    overlay.appendChild(etaDiv);
    overlay.appendChild(manualLabel);
    wrap.appendChild(overlay);

    const videoEl = document.createElement('video');
    videoEl.controls = true;
    videoEl.style.cssText = 'width:100%;height:100%;object-fit:contain;display:none;position:absolute;inset:0;z-index:1;';
    wrap.appendChild(videoEl);
    _proxyVideoEl = videoEl;
    // Resolve-style transport (replaces the native <video controls> bar).
    import('../../core/resolveVideoTransport.js')
      .then(m => m.attachResolveTransport(videoEl)).catch(() => {});

    const _getEl = id => wrap.querySelector(`#${id}`);
    const _eta   = _makeProxyEta();
    const _t0Elapsed  = Date.now();
    const _elapsedInt = setInterval(() => {
      const el = _getEl('al2-proxy-eta');
      if (!el || el.dataset.hasEta === 'true') return;
      const sec = Math.floor((Date.now() - _t0Elapsed) / 1000);
      if (sec < 4) return;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      el.textContent = m > 0 ? `${m}m ${s}s elapsed` : `${s}s elapsed`;
      el.style.display = 'block';
    }, 1000);

    // Show PROXY badge
    const proxyBadge = document.getElementById('al2-proxy-badge');

    _loadPlayableMedia().then(({ attachPlayableVideo, PLAYABLE_STATUS }) => {
      attachPlayableVideo(videoEl, file, {
        onStatus: (label) => {
          if (label === PLAYABLE_STATUS.direct || label === PLAYABLE_STATUS.proxy) {
            clearInterval(_elapsedInt);
            const ov = _getEl('al2-proxy-overlay');
            if (ov) ov.style.display = 'none';
            videoEl.style.display = 'block';
            if (proxyBadge) proxyBadge.style.display = label === PLAYABLE_STATUS.proxy ? '' : 'none';
            _addTcOverlay(wrap, videoEl);
            _startHistogram(videoEl);
            _applyViewerFilter(state, videoEl);
          } else if (label === PLAYABLE_STATUS.proxying) {
            const msg = _getEl('al2-proxy-msg');
            if (msg) msg.textContent = 'Generating proxy…';
          } else {
            const msg = _getEl('al2-proxy-msg');
            if (msg && label) msg.textContent = label;
          }
        },
        onProgress: (pct) => {
          const b = _getEl('al2-proxy-bar');
          if (!b || pct <= 0) return;
          b.className = '';
          b.style.cssText = 'height:100%;border-radius:2px;background:var(--al-accent);transition:width .3s;';
          b.style.width = `${Math.min(100, pct)}%`;
          const msg   = _getEl('al2-proxy-msg');
          const etaEl = _getEl('al2-proxy-eta');
          if (pct >= 100) {
            clearInterval(_elapsedInt);
            if (msg) msg.textContent = 'Finalizing…';
            if (etaEl) { etaEl.dataset.hasEta = ''; etaEl.textContent = ''; etaEl.style.display = 'none'; }
          } else {
            if (msg) msg.textContent = `Generating proxy…  ${Math.round(pct)}%`;
            const etaStr = _eta.update(pct);
            if (etaEl) {
              if (etaStr) {
                etaEl.dataset.hasEta = 'true';
                etaEl.textContent = `⏱ ${etaStr}`;
                etaEl.style.display = 'block';
              } else {
                etaEl.dataset.hasEta = '';
              }
            }
          }
        },
        onProxyFail: (hint) => {
          clearInterval(_elapsedInt);
          const b = _getEl('al2-proxy-bar');
          if (b) { b.className = ''; b.style.cssText = 'height:100%;width:100%;border-radius:2px;background:#6b2525;'; }
          const msg = _getEl('al2-proxy-msg');
          if (msg) {
            const reason = hint ? (hint.includes(' — ') ? hint.slice(hint.indexOf(' — ') + 3) : hint) : 'Proxy unavailable — load manually below.';
            const isNoHelper = /native helper|Browser Mode/i.test(reason);
            msg.textContent = isNoHelper ? 'Native helper not running — drag a proxy (.mov/.mp4) or click below.' : reason;
          }
          const btn = wrap.querySelector('#al2-proxy-manual-btn');
          if (btn) btn.style.display = 'inline-flex';
        },
        onNoOutputDir: () => {
          clearInterval(_elapsedInt);
          const msg = _getEl('al2-proxy-msg');
          if (msg) msg.textContent = 'Set Media Root in Settings to enable ProRes proxy.';
          const btn = wrap.querySelector('#al2-proxy-manual-btn');
          if (btn) btn.style.display = 'inline-flex';
        },
      });
    }).catch(() => {
      clearInterval(_elapsedInt);
      const msg = _getEl('al2-proxy-msg');
      if (msg) msg.textContent = 'Playback module unavailable.';
    });

    wrap.ondragover = e => e.preventDefault();
    wrap.ondrop     = e => {
      e.preventDefault();
      const proxy = e.dataTransfer?.files?.[0];
      if (proxy && _VIDEO_EXT.test(proxy.name)) _loadProxyVideo(wrap, proxy, getState());
    };

  } else if (_IMAGE_EXT.test(file.name)) {
    wrap.innerHTML = `
      <div style="text-align:center;padding:20px">
        <div style="font-size:12px;color:var(--al-text-secondary);margin-bottom:4px">${_esc(file.name)}</div>
        <div style="font-size:11px;color:var(--al-text-muted)">
          Native preview unavailable.<br>Source set — transforms reference this file.
        </div>
      </div>`;
  } else {
    wrap.innerHTML = `<span style="color:var(--al-text-muted);font-size:12px">${_esc(file.name)}</span>`;
  }
}

function _loadProxyVideo(wrap, proxyFile, state) {
  if (_viewerObjectUrl) { URL.revokeObjectURL(_viewerObjectUrl); }
  _viewerObjectUrl = URL.createObjectURL(proxyFile);
  _stopHistogram();
  wrap.ondragover = null;
  wrap.ondrop     = null;
  wrap.innerHTML  = '';
  wrap.style.cssText = 'flex:1;width:100%;height:100%;background:#000;display:block;overflow:hidden;position:relative;';

  const video = document.createElement('video');
  video.src      = _viewerObjectUrl;
  video.controls = true;
  video.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block;';
  wrap.appendChild(video);
  import('../../core/resolveVideoTransport.js')
    .then(m => m.attachResolveTransport(video)).catch(() => {});
  _addTcOverlay(wrap, video);

  const proxyBadge = document.getElementById('al2-proxy-badge');
  if (proxyBadge) {
    proxyBadge.style.display = '';
    proxyBadge.textContent   = `PROXY: ${proxyFile.name}`;
  }

  _startHistogram(video);
  _applyViewerFilter(state, video);
}

function _applyViewerFilter(state, videoEl) {
  const video = videoEl || _getViewerVideo();
  if (!video) return;
  if (_viewerShowGraded) {
    const pc = state.primaryControls || {};
    const brightness = Math.pow(2, pc.exposure    ?? 0);
    const contrast   = pc.contrast    ?? 1;
    const saturation = pc.saturation  ?? 1;
    const hueRotate  = (pc.temperature ?? 0) * -0.18;
    video.style.filter = `brightness(${brightness.toFixed(4)}) contrast(${contrast.toFixed(4)}) saturate(${saturation.toFixed(4)}) hue-rotate(${hueRotate.toFixed(2)}deg)`;
  } else {
    video.style.filter = 'none';
  }
}

// ── Timecode overlay ──────────────────────────────────────────────────────────
function _framesToTC(totalFrames, fps) {
  const f  = totalFrames % fps;
  const s  = Math.floor(totalFrames / fps) % 60;
  const m  = Math.floor(totalFrames / (fps * 60)) % 60;
  const h  = Math.floor(totalFrames / (fps * 3600));
  const p2 = n => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}:${p2(f)}`;
}

function _addTcOverlay(wrap, videoEl, fps = 24) {
  // Use the dedicated TC div in overlay-wrap if available
  const tcEl = document.getElementById('al2-tc-display');
  if (tcEl) {
    tcEl.style.display = '';
    tcEl.textContent   = '00:00:00:00';
    videoEl.addEventListener('timeupdate', () => {
      const frames = Math.round(videoEl.currentTime * fps);
      tcEl.textContent = _framesToTC(frames, fps);
    });
    return;
  }
  // Fallback: create inline
  wrap.querySelector('.al-tc-display')?.remove();
  const tc = document.createElement('div');
  tc.className = 'al-tc-display';
  tc.textContent = '00:00:00:00';
  wrap.appendChild(tc);
  videoEl.addEventListener('timeupdate', () => {
    const frames = Math.round(videoEl.currentTime * fps);
    tc.textContent = _framesToTC(frames, fps);
  });
}

// ── Histogram / Scopes ────────────────────────────────────────────────────────
function _startHistogram(videoEl) {
  if (!_histSampleCanvas) {
    _histSampleCanvas = document.createElement('canvas');
    _histSampleCanvas.width  = _HIST_SAMPLE_W;
    _histSampleCanvas.height = _HIST_SAMPLE_H;
  }
  _histRafId = requestAnimationFrame(function tick(ts) {
    if (!document.getElementById('al2-scope-canvas')) return; // canvas removed — stop loop
    if (document.hidden) { _histRafId = requestAnimationFrame(tick); return; } // tab hidden — idle
    if (ts - _histLastMs < _HIST_FPS_MS) { _histRafId = requestAnimationFrame(tick); return; } // throttle
    _histLastMs = ts;
    if (!_scopeCollapsed) {
      if (_scopeMode === 'waveform')      _drawWaveform(videoEl, 'al2-scope-canvas');
      else if (_scopeMode === 'parade')   _drawParade(videoEl, 'al2-scope-canvas');
      else if (_scopeMode === 'vectorscope') _drawVectorscope(videoEl, 'al2-scope-canvas');
      else                                _drawHistogram(videoEl, 'al2-scope-canvas');
    }
    _histRafId = requestAnimationFrame(tick); // reschedule AFTER work, not before
  });
}

function _stopHistogram() {
  if (_histRafId) { cancelAnimationFrame(_histRafId); _histRafId = null; }
  const c = document.getElementById('al2-scope-canvas');
  if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
}

function _sampleVideo(videoEl) {
  if (!_histSampleCanvas) {
    _histSampleCanvas = document.createElement('canvas');
    _histSampleCanvas.width  = _HIST_SAMPLE_W;
    _histSampleCanvas.height = _HIST_SAMPLE_H;
  }
  const sCtx = _histSampleCanvas.getContext('2d', { willReadFrequently: true });
  try {
    sCtx.drawImage(videoEl, 0, 0, _HIST_SAMPLE_W, _HIST_SAMPLE_H);
  } catch { return null; }
  return sCtx.getImageData(0, 0, _HIST_SAMPLE_W, _HIST_SAMPLE_H).data;
}

function _getCanvas(id) {
  const canvas = document.getElementById(id);
  if (!canvas) return null;
  const displayW = canvas.offsetWidth  || 248;
  const displayH = canvas.offsetHeight || 112;
  if (canvas.width  !== displayW) canvas.width  = displayW;
  if (canvas.height !== displayH) canvas.height = displayH;
  return canvas;
}

function _drawHistogram(videoEl, canvasId = 'al2-scope-canvas') {
  const canvas = _getCanvas(canvasId);
  if (!canvas || !videoEl || videoEl.readyState < 2) return;
  const W = canvas.width;
  const H = canvas.height;

  const imgData = _sampleVideo(videoEl);
  if (!imgData) return;

  const bins = 256;
  const r = new Uint32Array(bins);
  const g = new Uint32Array(bins);
  const b = new Uint32Array(bins);
  let rSum = 0, gSum = 0, bSum = 0, pixCount = 0;

  for (let i = 0; i < imgData.length; i += 4) {
    r[imgData[i]]++;
    g[imgData[i + 1]]++;
    b[imgData[i + 2]]++;
    rSum += imgData[i]; gSum += imgData[i+1]; bSum += imgData[i+2];
    pixCount++;
  }

  // Compute average values for stats
  const n = pixCount || 1;
  const rAvg = rSum / n, gAvg = gSum / n, bAvg = bSum / n;
  const lAvg = 0.2126 * rAvg + 0.7152 * gAvg + 0.0722 * bAvg;
  const clip = r[255] > 0 || g[255] > 0 || b[255] > 0;
  _updateScopeStats(rAvg, gAvg, bAvg, lAvg, clip);

  const peak = Math.max(...r, ...g, ...b) || 1;
  const ctx  = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // Graticule lines at 25% / 50% / 75%
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth   = 1;
  for (const pct of [0.25, 0.5, 0.75]) {
    const x = Math.round(pct * W) - 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }

  const channels = [
    { data: r, color: 'rgba(220,70,70,0.65)'  },
    { data: g, color: 'rgba(70,190,100,0.65)' },
    { data: b, color: 'rgba(80,140,220,0.65)' },
  ];

  for (const ch of channels) {
    ctx.beginPath();
    for (let i = 0; i < bins; i++) {
      const x = (i / (bins - 1)) * W;
      const y = H - (ch.data[i] / peak) * (H - 2);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.lineTo(W, H);
    ctx.lineTo(0, H);
    ctx.closePath();
    ctx.fillStyle = ch.color;
    ctx.fill();
  }

  // Clip indicator: red band at right edge if any channel at 255
  if (clip) {
    ctx.fillStyle = 'rgba(255,50,50,0.35)';
    ctx.fillRect(W - 3, 0, 3, H);
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth   = 1;
  ctx.beginPath();
  ctx.moveTo(0, H - 0.5);
  ctx.lineTo(W, H - 0.5);
  ctx.stroke();
}

function _drawWaveform(videoEl, canvasId = 'al2-scope-canvas') {
  const canvas = _getCanvas(canvasId);
  if (!canvas || !videoEl || videoEl.readyState < 2) return;
  const W = canvas.width;
  const H = canvas.height;

  const imgData = _sampleVideo(videoEl);
  if (!imgData) return;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // Compute luma stats for stats row
  let lSum = 0, lMin = 255, lMax = 0, pixCount = 0;
  let rSum = 0, gSum = 0, bSum = 0;
  for (let i = 0; i < imgData.length; i += 4) {
    const l = 0.2126 * imgData[i] + 0.7152 * imgData[i+1] + 0.0722 * imgData[i+2];
    lSum += l; rSum += imgData[i]; gSum += imgData[i+1]; bSum += imgData[i+2];
    if (l < lMin) lMin = l;
    if (l > lMax) lMax = l;
    pixCount++;
  }
  const n = pixCount || 1;
  _updateScopeStats(rSum/n, gSum/n, bSum/n, lSum/n, lMax >= 254);

  // Graticule lines at 10%, 40%, 70%, 90%
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth   = 1;
  for (const pct of [0.1, 0.4, 0.7, 0.9]) {
    const y = Math.round(H - pct * (H - 1)) - 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  // 0% / 100% solid
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  for (const pct of [0, 1]) {
    const y = Math.round(H - pct * (H - 1)) - 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // Use putImageData — one draw call instead of 15k fillRect calls
  const out = ctx.createImageData(W, H);
  const d   = out.data;
  const CHANNELS = [
    { off: 0, r: 220, g: 70,  b: 70  },
    { off: 1, r: 70,  g: 190, b: 100 },
    { off: 2, r: 80,  g: 140, b: 220 },
  ];
  for (const ch of CHANNELS) {
    for (let x = 0; x < _HIST_SAMPLE_W; x++) {
      for (let y = 0; y < _HIST_SAMPLE_H; y++) {
        const val  = imgData[(y * _HIST_SAMPLE_W + x) * 4 + ch.off] / 255;
        const px   = Math.round(x * W / _HIST_SAMPLE_W);
        const py   = Math.round(H - val * (H - 1));
        const idx  = (py * W + px) * 4;
        d[idx]     = Math.min(255, d[idx]     + ch.r);
        d[idx + 1] = Math.min(255, d[idx + 1] + ch.g);
        d[idx + 2] = Math.min(255, d[idx + 2] + ch.b);
        d[idx + 3] = Math.min(255, d[idx + 3] + 160);
      }
    }
  }
  ctx.putImageData(out, 0, 0);

  // Pct labels on graticule (right edge)
  ctx.font      = '7px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.28)';
  ctx.textAlign = 'right';
  for (const pct of [0.1, 0.4, 0.7, 0.9]) {
    const y = Math.round(H - pct * (H - 1));
    ctx.fillText(Math.round(pct * 100) + '%', W - 2, y - 1);
  }
  ctx.textAlign = 'left';
}

function _drawParade(videoEl, canvasId = 'al2-scope-canvas') {
  const canvas = _getCanvas(canvasId);
  if (!canvas || !videoEl || videoEl.readyState < 2) return;
  const W  = canvas.width;
  const H  = canvas.height;
  const cW = Math.floor(W / 3);

  const imgData = _sampleVideo(videoEl);
  if (!imgData) return;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  // Compute per-channel peak for stats
  let rPeak = 0, gPeak = 0, bPeak = 0, rSum = 0, gSum = 0, bSum = 0, n = 0;
  for (let i = 0; i < imgData.length; i += 4) {
    if (imgData[i]   > rPeak) rPeak = imgData[i];
    if (imgData[i+1] > gPeak) gPeak = imgData[i+1];
    if (imgData[i+2] > bPeak) bPeak = imgData[i+2];
    rSum += imgData[i]; gSum += imgData[i+1]; bSum += imgData[i+2];
    n++;
  }
  n = n || 1;
  const lAvg = 0.2126 * rSum/n + 0.7152 * gSum/n + 0.0722 * bSum/n;
  _updateScopeStats(rSum/n, gSum/n, bSum/n, lAvg, rPeak >= 254 || gPeak >= 254 || bPeak >= 254);

  // Graticule lines at 10%, 50%, 90% inside each column
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth   = 1;
  for (const pct of [0.1, 0.5, 0.9]) {
    const y = Math.round(H - pct * (H - 1)) - 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }

  // Channel dividers
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.beginPath(); ctx.moveTo(cW,   0); ctx.lineTo(cW,   H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cW*2, 0); ctx.lineTo(cW*2, H); ctx.stroke();

  // putImageData — single draw call for all channels
  const out = ctx.createImageData(W, H);
  const d   = out.data;
  const PARADE_CH = [
    { off: 0, r: 220, g: 70,  b: 70,  xBase: 0    },
    { off: 1, r: 70,  g: 190, b: 100, xBase: cW   },
    { off: 2, r: 80,  g: 140, b: 220, xBase: cW*2 },
  ];
  for (const ch of PARADE_CH) {
    for (let x = 0; x < _HIST_SAMPLE_W; x++) {
      for (let y = 0; y < _HIST_SAMPLE_H; y++) {
        const val  = imgData[(y * _HIST_SAMPLE_W + x) * 4 + ch.off] / 255;
        const px   = ch.xBase + Math.round(x * cW / _HIST_SAMPLE_W);
        const py   = Math.round(H - val * (H - 1));
        if (px < 0 || px >= W || py < 0 || py >= H) continue;
        const idx  = (py * W + px) * 4;
        d[idx]     = Math.min(255, d[idx]     + ch.r);
        d[idx + 1] = Math.min(255, d[idx + 1] + ch.g);
        d[idx + 2] = Math.min(255, d[idx + 2] + ch.b);
        d[idx + 3] = Math.min(255, d[idx + 3] + 160);
      }
    }
  }
  ctx.putImageData(out, 0, 0);

  // Channel labels (R / G / B) at bottom of each column
  ctx.font      = '7px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(220,80,80,0.55)';  ctx.fillText('R', cW * 0.5, H - 2);
  ctx.fillStyle = 'rgba(80,190,100,0.55)'; ctx.fillText('G', cW * 1.5, H - 2);
  ctx.fillStyle = 'rgba(80,150,220,0.55)'; ctx.fillText('B', cW * 2.5, H - 2);
  ctx.textAlign = 'left';
}

const _VS_MARKERS = [
  { Cb: -0.1146, Cr:  0.5,    label: 'R',  color: '#e05050' },
  { Cb: -0.3854, Cr: -0.4542, label: 'G',  color: '#50c050' },
  { Cb:  0.5,    Cr: -0.0458, label: 'B',  color: '#5080e0' },
  { Cb:  0.1146, Cr: -0.5,    label: 'Cy', color: '#50c0c0' },
  { Cb:  0.3854, Cr:  0.4542, label: 'Mg', color: '#c050c0' },
  { Cb: -0.5,    Cr:  0.0458, label: 'Ye', color: '#c0c050' },
];

function _drawVectorscope(videoEl, canvasId = 'al2-scope-canvas') {
  const canvas = _getCanvas(canvasId);
  if (!canvas || !videoEl || videoEl.readyState < 2) return;
  const W = canvas.width;
  const H = canvas.height;

  const imgData = _sampleVideo(videoEl);
  if (!imgData) return;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const cx     = W / 2;
  const cy     = H / 2;
  const radius = Math.min(W, H) / 2 - 6;

  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth   = 1;
  ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.beginPath(); ctx.arc(cx, cy, radius * 0.75, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.beginPath(); ctx.moveTo(cx, 0);  ctx.lineTo(cx, H); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, cy);  ctx.lineTo(W, cy); ctx.stroke();

  const scale75 = radius * 0.75 / 0.5;
  for (const m of _VS_MARKERS) {
    const mx = cx + m.Cb * scale75;
    const my = cy - m.Cr * scale75;
    ctx.fillStyle = m.color;
    ctx.beginPath(); ctx.arc(mx, my, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle   = 'rgba(255,255,255,0.4)';
    ctx.font        = '8px monospace';
    ctx.fillText(m.label, mx + 4, my + 3);
  }

  const scale    = radius / 0.5;
  const imageData = ctx.createImageData(W, H);
  const out       = imageData.data;
  let rSum = 0, gSum = 0, bSum = 0, satSum = 0, n = 0;
  for (let i = 0; i < imgData.length; i += 4) {
    const r = imgData[i]     / 255;
    const g = imgData[i + 1] / 255;
    const b = imgData[i + 2] / 255;
    rSum += imgData[i]; gSum += imgData[i+1]; bSum += imgData[i+2]; n++;
    const Cb = -0.1146 * r - 0.3854 * g + 0.5    * b;
    const Cr =  0.5    * r - 0.4542 * g - 0.0458 * b;
    satSum += Math.sqrt(Cb * Cb + Cr * Cr);
    const px = Math.round(cx + Cb * scale);
    const py = Math.round(cy - Cr * scale);
    if (px < 0 || px >= W || py < 0 || py >= H) continue;
    const oi = (py * W + px) * 4;
    out[oi]     = Math.min(255, out[oi]     + 80);
    out[oi + 1] = Math.min(255, out[oi + 1] + 80);
    out[oi + 2] = Math.min(255, out[oi + 2] + 80);
    out[oi + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  // Stats: saturation % (0–100) instead of L for vectorscope
  n = n || 1;
  const lAvg = 0.2126 * rSum/n + 0.7152 * gSum/n + 0.0722 * bSum/n;
  _updateScopeStats(rSum/n, gSum/n, bSum/n, lAvg, false);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
