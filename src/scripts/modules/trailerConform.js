/**
 * trailerConform.js — PostFlowX Trailer Conform Feature
 *
 * Mounts into #trlconfMount.
 *
 * Phase 1: Setup inputs → Resolve generates analysis proxies + WAV
 *           → Python audio/filename/duration matching → review table
 * Phase 2: Visual luma waveform + slate detection + speed-change detection
 *           + manual accept/reject UI
 * Phase 3: Build Resolve conform timeline → render review QT → export
 * Phase 4: OCF relink, EXR/DPX pull, AMF/FDL handoff (stubs for now)
 */

import {
  nativeConformAnalyze,
  nativeConformJobStatus,
  nativeConformBuildTimeline,
  nativeConformCancelJob,
  nativeConformExport,
  nativeConformPreflight,
  nativePickFolder,
  nativePickMediaFile,
  nativePickMediaFiles,
  nativeOpenOutputFolder,
  nativeProbeOcfFolder,
} from './native_helper_client.js';
import { parseEditText, framesToTc, tcToFrames } from './conform/edlParser.js';
import {
  filenameScore,
  durationScore,
  detectSpeedChange,
  detectSlateFrames,
  confidenceLabel,
  confidenceColor,
} from './conform/audioMatcher.js';

// ── State ─────────────────────────────────────────────────────────────────────

const _STATE = {
  phase: 'setup',          // setup | analyzing | review | building | done
  jobId: null,
  pollTimer: null,
  events: [],
  proxies: [],
  matches: [],             // [{eventIndex, event, candidates, accepted, acceptedSourceIndex, status}]
  outputDir: '',
  fps: 24,
  label: 'TrailerConform',
  analysisResult: null,
  buildResult: null,
  srcRoot: '',             // cached folder that successfully resolved dropped source filenames
};

// ── Output folder state (persists across conforms via IDB) ───────────────────

const _outputFolder = {
  kind:      'none',  // 'none' | 'native' | 'fsaa'
  path:      '',      // full filesystem path (native mode); '' for FSAA-only
  label:     '',      // display name: full path (native) or folder name (FSAA)
  permState: 'none',  // 'none' | 'ready' | 'lost' | 'error'
  _handle:   null,    // FileSystemDirectoryHandle (FSAA mode only)
};

function _getProjectSetupSettings() {
  try { return window.__pfxProjectSetup?.getSettings?.() || null; }
  catch { return null; }
}

async function _persistTrailerConformSettings() {
  const settings = _getProjectSetupSettings();
  if (!settings) return;
  if (!settings.trailerConform || typeof settings.trailerConform !== 'object') {
    settings.trailerConform = {};
  }
  settings.trailerConform.projectLabel = _STATE.label;
  settings.trailerConform.timelineFps = _STATE.fps;
  settings.trailerConform.outputFolderPath = _outputFolder.path;
  settings.trailerConform.outputFolderLabel = _outputFolder.path || _outputFolder.label || '';
  settings.trailerConform.outputFolderReady = _outputFolder.permState === 'ready';
  const proxySizeEl = _root?.querySelector('#trcProxySize');
  settings.trailerConform.proxySize = proxySizeEl?.value || settings.trailerConform.proxySize || '640x360';
  if (_STATE.srcRoot) settings.trailerConform.srcRoot = _STATE.srcRoot;
  try { await window.__pfxProjectSetup?.saveNow?.(); } catch {}
}

function _hydrateTrailerConformSettings() {
  const tc = _getProjectSetupSettings()?.trailerConform;
  if (tc && typeof tc.srcRoot === 'string' && tc.srcRoot) _STATE.srcRoot = tc.srcRoot;
}

const _OUT_IDB_DB     = 'postflowx_trc';
const _OUT_IDB_STORE  = 'trc_prefs';
const _OUT_IDB_KEY    = 'trc_output_folder_path';
const _OUT_IDB_HKEY   = 'trc_output_folder_handle'; // FileSystemDirectoryHandle (FSAA mode)

function _idbOpen() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(_OUT_IDB_DB, 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(_OUT_IDB_STORE)) db.createObjectStore(_OUT_IDB_STORE);
    };
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}
async function _idbGet(key) {
  try {
    const db = await _idbOpen();
    return new Promise((res, rej) => {
      const req = db.transaction(_OUT_IDB_STORE, 'readonly').objectStore(_OUT_IDB_STORE).get(key);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror   = e => rej(e.target.error);
    });
  } catch { return null; }
}
async function _idbSet(key, val) {
  try {
    const db = await _idbOpen();
    return new Promise((res, rej) => {
      const req = db.transaction(_OUT_IDB_STORE, 'readwrite').objectStore(_OUT_IDB_STORE).put(val, key);
      req.onsuccess = () => res();
      req.onerror   = e => rej(e.target.error);
    });
  } catch {}
}
async function _idbDel(key) {
  try {
    const db = await _idbOpen();
    return new Promise((res, rej) => {
      const req = db.transaction(_OUT_IDB_STORE, 'readwrite').objectStore(_OUT_IDB_STORE).delete(key);
      req.onsuccess = () => res();
      req.onerror   = e => rej(e.target.error);
    });
  } catch {}
}

// ── Mount / unmount ──────────────────────────────────────────────────────────

let _root = null;

export function mountTrailerConform() {
  const mount = document.getElementById('trlconfMount');
  if (!mount) return;
  const settings = _getProjectSetupSettings();
  const trcSettings = settings?.trailerConform || {};
  _STATE.fps = parseFloat(trcSettings.timelineFps) || _STATE.fps;
  _STATE.label = trcSettings.projectLabel || _STATE.label;
  _hydrateTrailerConformSettings();
  mount.innerHTML = '';
  _root = document.createElement('div');
  _root.className = 'trc-root';
  _root.innerHTML = _buildShell();
  mount.appendChild(_root);
  _wireShell();
  _renderPhase();
  // Restore saved output folder asynchronously; re-renders readiness when done
  _loadSavedOutputFolder();
}

function _buildShell() {
  return `
<div class="trc-header">
  <div class="trc-title">
    <svg class="trc-title-icon" viewBox="0 0 18 18" fill="none">
      <rect x="1" y="4" width="6" height="9" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/>
      <rect x="2" y="5.5" width="1.5" height="2" rx=".4" fill="currentColor" opacity=".7"/>
      <rect x="2" y="9" width="1.5" height="2" rx=".4" fill="currentColor" opacity=".7"/>
      <path d="M8.5 8.5h3.5M10.5 6.5l2.5 2-2.5 2" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
      <rect x="13" y="3" width="4" height="11" rx="1" stroke="currentColor" stroke-width="1.3" fill="none"/>
      <rect x="13.7" y="4.5" width="1.2" height="1.8" rx=".3" fill="currentColor" opacity=".7"/>
      <rect x="13.7" y="8" width="1.2" height="1.8" rx=".3" fill="currentColor" opacity=".7"/>
      <rect x="13.7" y="11.5" width="1.2" height="1.5" rx=".3" fill="currentColor" opacity=".7"/>
    </svg>
    Trailer Conform
  </div>
  <div class="trc-phase-strip" id="trcPhaseStrip"></div>
  <div class="trc-header-actions">
    <button class="trc-btn trc-btn--ghost trc-btn--sm" id="trcResetBtn" title="Start over">Reset</button>
  </div>
</div>
<div class="trc-body" id="trcBody"></div>
`;
}

// ── Phase rendering ───────────────────────────────────────────────────────────

const PHASES = ['setup', 'analyzing', 'review', 'building', 'done'];

function _renderPhase() {
  _renderPhaseStrip();
  const body = _root.querySelector('#trcBody');
  if (!body) return;
  switch (_STATE.phase) {
    case 'setup':     body.innerHTML = _htmlSetup();     _wireSetup();     break;
    case 'analyzing': body.innerHTML = _htmlAnalyzing(); _wireAnalyzing(); break;
    case 'review':    body.innerHTML = _htmlReview();    _wireReview();    break;
    case 'building':  body.innerHTML = _htmlBuilding();  _wireBuilding();  break;
    case 'done':      body.innerHTML = _htmlDone();      _wireDone();      break;
  }
}

function _renderPhaseStrip() {
  const strip = _root.querySelector('#trcPhaseStrip');
  if (!strip) return;
  const labels = ['Setup', 'Analyze', 'Review', 'Build', 'Done'];
  const phases = ['setup', 'analyzing', 'review', 'building', 'done'];
  const currentIdx = PHASES.indexOf(_STATE.phase);
  const parts = [];
  phases.forEach((p, i) => {
    const isActive = i === currentIdx;
    const isPast   = i < currentIdx;
    const stateCls = isActive ? ' trc-phase-step--active' : isPast ? ' trc-phase-step--done' : '';
    const ariaCur  = isActive ? ' aria-current="step"' : '';
    parts.push(`<div class="trc-phase-step${stateCls}" data-phase="${p}" data-step-idx="${i+1}"${ariaCur} role="listitem">
      <span class="trc-phase-circle" aria-hidden="true">${isPast
        ? '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,5.2 4.2,7.4 8,3"/></svg>'
        : (i+1)}</span>
      <span class="trc-phase-lbl">${labels[i]}</span>
    </div>`);
    if (i < phases.length - 1) {
      const conCls = i < currentIdx ? ' trc-phase-connector--done' : '';
      parts.push(`<div class="trc-phase-connector${conCls}" aria-hidden="true"></div>`);
    }
  });
  strip.setAttribute('role', 'list');
  strip.setAttribute('aria-label', 'Trailer Conform progress');
  strip.innerHTML = parts.join('');
}

// ── Phase 1: Setup ────────────────────────────────────────────────────────────

function _htmlSetup() {
  const settings = _getProjectSetupSettings();
  return `
<div class="trc-setup trc-setup--v2">
  <div class="trc-setup-grid">
    <div class="trc-setup-col">
      <div class="trc-input-card" data-slot="edit">
        <div class="trc-input-card-head">
          <span class="trc-input-card-title">Edit File</span>
          <span class="trc-badge">EDL · FCP XML · OTIO</span>
        </div>
        <div class="trc-file-drop trc-file-drop--card" id="trcEditDrop" data-slot="edit" tabindex="0" role="button" aria-label="Drop edit file or click to choose">
          <span class="trc-file-drop-icon">
            <svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 17h14M11 3v10M7 9l4-4 4 4"/></svg>
          </span>
          <div class="trc-file-drop-body">
            <span class="trc-file-drop-primary" id="trcEditLabel">Drop EDL · XML · OTIO here</span>
            <span class="trc-file-drop-secondary" id="trcEditMeta">or click to browse</span>
          </div>
          <input type="file" id="trcEditFile" accept=".edl,.xml,.fcpxml,.otio,.json" hidden>
        </div>
      </div>
      <div class="trc-input-card" data-slot="ref">
        <div class="trc-input-card-head">
          <span class="trc-input-card-title">Reference QT</span>
          <span class="trc-badge trc-badge--yellow">Trailer master</span>
        </div>
        <div class="trc-file-drop trc-file-drop--card" id="trcRefDrop" data-slot="ref" tabindex="0" role="button" aria-label="Drop reference QuickTime or click to choose">
          <span class="trc-file-drop-icon">
            <svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="18" height="12" rx="2"/><path d="M9 9l6 3-6 3V9z" fill="currentColor" stroke="none"/></svg>
          </span>
          <div class="trc-file-drop-body">
            <span class="trc-file-drop-primary" id="trcRefLabel">Drop reference QuickTime here</span>
            <span class="trc-file-drop-secondary" id="trcRefMeta">or click to browse</span>
          </div>
          <input type="file" id="trcRefFile" accept=".mov,.mp4,.mxf" hidden>
        </div>
      </div>
    </div>
    <div class="trc-setup-col">
      <div class="trc-input-card" data-slot="src">
        <div class="trc-input-card-head">
          <span class="trc-input-card-title">Source Media</span>
          <span class="trc-badge">Folder or files</span>
        </div>
        <div class="trc-file-drop trc-file-drop--card trc-file-drop--multi" id="trcSrcDrop" data-slot="src" tabindex="0" role="button" aria-label="Drop source media or click to choose">
          <span class="trc-file-drop-icon">
            <svg width="20" height="20" viewBox="0 0 22 22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h16M3 11h12M3 15h8"/></svg>
          </span>
          <div class="trc-file-drop-body">
            <span class="trc-file-drop-primary" id="trcSrcLabel">Drop source QT / OCF files here</span>
            <span class="trc-file-drop-secondary" id="trcSrcMeta">or click to browse multiple</span>
          </div>
          <input type="file" id="trcSrcFile" accept=".mov,.mp4,.mxf,.r3d,.arx,.braw,.dng" multiple hidden>
        </div>
        <div class="trc-input-card-actions">
          <button class="trc-btn trc-btn--ghost trc-btn--xs" id="trcChooseSrcFilesBtn" title="Pick individual files via the companion">Choose Files…</button>
          <button class="trc-btn trc-btn--ghost trc-btn--xs" id="trcChooseSrcFolderBtn" title="Pick a whole folder via the companion">Choose Folder…</button>
          <button class="trc-btn trc-btn--ghost trc-btn--xs" id="trcResetSrcBtn" title="Clear all source media">Reset</button>
        </div>
        <div class="trc-src-summary trc-hidden" id="trcSrcSummary">
          <span class="trc-src-summary-count" id="trcSrcSummaryCount">0 files</span>
          <span class="trc-src-summary-size" id="trcSrcSummarySize"></span>
        </div>
        <div class="trc-src-list" id="trcSrcList"></div>
      </div>
    </div>
  </div>

  <div class="trc-setup-options">
    <div class="trc-opt-row">
      <label class="trc-opt-label" for="trcFpsSelect">Timeline FPS</label>
      <select class="trc-select" id="trcFpsSelect">
        <option value="23.976" ${String(_STATE.fps) === '23.976' ? 'selected' : ''}>23.976</option>
        <option value="24" ${String(_STATE.fps) === '24' ? 'selected' : ''}>24</option>
        <option value="25" ${String(_STATE.fps) === '25' ? 'selected' : ''}>25</option>
        <option value="29.97" ${String(_STATE.fps) === '29.97' ? 'selected' : ''}>29.97</option>
        <option value="30" ${String(_STATE.fps) === '30' ? 'selected' : ''}>30</option>
      </select>
    </div>
    <div class="trc-opt-row">
      <label class="trc-opt-label" for="trcLabelInput">Project label</label>
      <input type="text" class="trc-input" id="trcLabelInput" value="${_esc(_STATE.label)}" maxlength="40">
    </div>
    <div class="trc-opt-row">
      <label class="trc-opt-label" for="trcProxySize">Proxy size</label>
      <select class="trc-select" id="trcProxySize">
        <option value="640x360" ${(settings?.trailerConform?.proxySize || '640x360') === '640x360' ? 'selected' : ''}>640×360 (fast)</option>
        <option value="1280x720" ${(settings?.trailerConform?.proxySize || '') === '1280x720' ? 'selected' : ''}>1280×720</option>
        <option value="1920x1080" ${(settings?.trailerConform?.proxySize || '') === '1920x1080' ? 'selected' : ''}>1920×1080</option>
      </select>
    </div>
  </div>

  <div class="trc-output-card">
    <div class="trc-input-card-head">
      <span class="trc-input-card-title">Output Folder</span>
      <span class="trc-badge">Resolve output target</span>
    </div>
    <div class="trc-folder-sel" id="trcFolderSel">
      <div class="trc-folder-primary">
        <button class="trc-btn trc-btn--ghost trc-btn--sm" id="trcChooseFolderBtn">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <path d="M1 4h11v7H1V4zM1 4V2.5a1 1 0 011-1h3l1.5 1.5H12V4"/>
          </svg>
          Choose Folder…
        </button>
        <span class="trc-folder-label" id="trcFolderLabel">No folder selected</span>
      </div>
      <div class="trc-folder-actions">
        <button class="trc-btn trc-btn--ghost trc-btn--xs" id="trcOpenFolderBtn" disabled>Open Folder</button>
        <button class="trc-btn trc-btn--ghost trc-btn--xs" id="trcUseProjectBtn">Use Project Output</button>
        <button class="trc-btn trc-btn--ghost trc-btn--xs" id="trcResetFolderBtn">Reset</button>
      </div>
      <div class="trc-folder-status" id="trcFolderStatus"></div>
      <div class="trc-folder-reconnect trc-hidden" id="trcFolderReconnect">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="#f5c542" stroke-width="1.3">
          <circle cx="6" cy="6" r="5"/><path d="M6 4v2.5L7.5 8"/>
        </svg>
        <span>PFX needs permission to access this output folder again.</span>
        <button class="trc-btn trc-btn--ghost trc-btn--xs" id="trcReconnectBtn">Reconnect Folder</button>
      </div>
    </div>
  </div>

  <div class="trc-setup-foot trc-setup-foot--sticky">
    <div class="trc-readiness" id="trcReadiness" role="status" aria-live="polite"></div>
    <div class="trc-setup-foot-cta">
      <span class="trc-kbd-hint" id="trcCtaHint">⌘↵ to run</span>
      <button class="trc-btn trc-btn--primary" id="trcAnalyzeBtn" disabled title="Run conform analysis (⌘↵ / Ctrl+↵)">
        Analyze with Resolve →
      </button>
    </div>
  </div>
</div>`;
}

// Files selected by user
const _files = { edit: null, ref: null, src: [], srcFolder: null };

function _toPickedFile(file) {
  if (!file) return null;
  return {
    kind: 'file',
    name: file.name || '',
    path: file.path || '',
    size: typeof file.size === 'number' ? file.size : 0,
    file,
  };
}

function _toNativeFile(path, size = 0) {
  if (!path) return null;
  const clean = String(path).trim();
  if (!clean) return null;
  return {
    kind: 'file',
    name: clean.split(/[\\/]/).pop() || clean,
    path: clean,
    size: typeof size === 'number' ? size : 0,
    file: null,
  };
}

function _formatBytes(n) {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function _extOf(name) {
  const m = /\.([^.]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : '';
}

function _setSingleDropMeta(slotEl, file) {
  if (!slotEl) return;
  const label = slotEl.querySelector('[id$="Label"]');
  const meta  = slotEl.querySelector('[id$="Meta"]');
  if (!file) {
    slotEl.classList.remove('trc-file-drop--filled', 'trc-file-drop--needs-companion');
    if (meta) meta.textContent = 'or click to browse';
    return;
  }
  slotEl.classList.add('trc-file-drop--filled');
  slotEl.classList.toggle('trc-file-drop--needs-companion', !file.path);
  if (label) label.textContent = file.name;
  if (meta) {
    const parts = [];
    const ext = _extOf(file.name); if (ext) parts.push(ext.toUpperCase());
    const sz = _formatBytes(file.size); if (sz) parts.push(sz);
    parts.push(file.path ? 'native path ✓' : 'needs companion');
    meta.textContent = parts.join(' · ');
  }
}

function _toNativeFolder(path) {
  if (!path) return null;
  const clean = String(path).trim().replace(/[\\/]$/, '');
  if (!clean) return null;
  return {
    kind: 'folder',
    name: clean.split(/[\\/]/).pop() || clean,
    path: clean,
  };
}

function _wireSetup() {
  // File drop zones
  ['edit', 'ref', 'src'].forEach(slot => {
    const drop = _root.querySelector(`#trc${slot.charAt(0).toUpperCase()+slot.slice(1)}Drop`);
    const inp  = _root.querySelector(`#trc${slot.charAt(0).toUpperCase()+slot.slice(1)}File`);
    if (!drop || !inp) return;
    drop.addEventListener('click', async () => {
      if (slot === 'edit') {
        const picked = await _pickNativeEditFile();
        if (picked) return;
      } else if (slot === 'ref') {
        const picked = await _pickNativeReferenceFile();
        if (picked) return;
      } else if (slot === 'src') {
        const picked = await _pickNativeSourceFiles();
        if (picked) return;
      }
      inp.click();
    });
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('trc-file-drop--over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('trc-file-drop--over'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('trc-file-drop--over');
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) _handleFileDrop(slot, files);
    });
    inp.addEventListener('change', () => {
      const files = [...inp.files];
      if (files.length) _handleFileDrop(slot, files);
    });
  });

  _root.querySelector('#trcFpsSelect')?.addEventListener('change', async e => {
    _STATE.fps = parseFloat(e.target.value);
    await _persistTrailerConformSettings();
  });
  _root.querySelector('#trcLabelInput')?.addEventListener('input', async e => {
    _STATE.label = e.target.value || 'Conform';
    await _persistTrailerConformSettings();
  });
  _root.querySelector('#trcChooseFolderBtn')?.addEventListener('click', _pickOutputFolder);
  _root.querySelector('#trcOpenFolderBtn')?.addEventListener('click', _openOutputInFinder);
  _root.querySelector('#trcUseProjectBtn')?.addEventListener('click', _useProjectOutput);
  _root.querySelector('#trcResetFolderBtn')?.addEventListener('click', _resetOutputFolder);
  _root.querySelector('#trcReconnectBtn')?.addEventListener('click', _pickOutputFolder);
  _root.querySelector('#trcAnalyzeBtn')?.addEventListener('click', _startAnalysis);
  _root.querySelector('#trcProxySize')?.addEventListener('change', () => { void _persistTrailerConformSettings(); });
  _root.querySelector('#trcChooseSrcFilesBtn')?.addEventListener('click', () => { void _pickNativeSourceFiles(); });
  _root.querySelector('#trcChooseSrcFolderBtn')?.addEventListener('click', () => { void _pickNativeSourceFolder(); });
  _root.querySelector('#trcResetSrcBtn')?.addEventListener('click', () => {
    _files.src = [];
    _files.srcFolder = null;
    _renderSrcList();
    _checkReadiness();
  });
  // Keyboard support: Enter/Space on focused drop zones opens picker; Cmd/Ctrl+Enter runs analyze.
  ['edit', 'ref', 'src'].forEach(slot => {
    const drop = _root.querySelector(`#trc${slot.charAt(0).toUpperCase()+slot.slice(1)}Drop`);
    drop?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drop.click(); }
    });
  });
  _root.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.code === 'Enter') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const btn = _root.querySelector('#trcAnalyzeBtn');
      if (btn && !btn.disabled) btn.click();
    }
  });
  // Restore folder UI if already selected (populated by _loadSavedOutputFolder async)
  _refreshOutputFolderUI();
}

// Allowed file extensions per slot. The drop event ignores the <input>'s
// `accept` attribute, so we validate here and reject mismatches with a toast.
const _TRC_ALLOWED_EXTS = {
  edit: ['edl', 'xml', 'fcpxml', 'otio', 'otioz', 'json'],
  ref:  ['mov', 'mp4', 'mxf'],
  src:  ['mov', 'mp4', 'mxf', 'r3d', 'arx', 'braw', 'dng'],
};
const _TRC_SLOT_LABEL = { edit: 'Edit File', ref: 'Reference QT', src: 'Source Media' };
const _TRC_SLOT_EXPECTED = {
  edit: 'EDL · FCP XML · OTIO',
  ref:  'MOV · MP4 · MXF',
  src:  'MOV · MP4 · MXF · R3D · ARX · BRAW · DNG',
};

function _trcExtOf(name) {
  const m = /\.([^.]+)$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

// Split incoming files into (accepted, rejected) by extension for the slot.
// Returns { accepted: File[], rejected: { name, ext }[] }.
function _trcFilterFilesForSlot(slot, files) {
  const allowed = _TRC_ALLOWED_EXTS[slot] || [];
  const accepted = [];
  const rejected = [];
  for (const f of (files || [])) {
    if (!f) continue;
    const ext = _trcExtOf(f.name);
    if (!ext) { rejected.push({ name: f.name || '(unnamed)', ext: '' }); continue; }
    if (allowed.includes(ext)) accepted.push(f);
    else rejected.push({ name: f.name, ext });
  }
  return { accepted, rejected };
}

function _trcReportRejected(slot, rejected) {
  if (!rejected.length) return;
  const label    = _TRC_SLOT_LABEL[slot] || slot;
  const expected = _TRC_SLOT_EXPECTED[slot] || '';
  const first    = rejected[0];
  const more     = rejected.length > 1 ? ` (+${rejected.length - 1} more)` : '';
  const got      = first.ext ? `.${first.ext}` : 'unknown type';
  _toast(`${label} needs ${expected}. Got ${got} for "${first.name}"${more}.`, true);
}

function _handleFileDrop(slot, files) {
  // Reject wrong-extension files before they reach state. Without this, a .mov
  // dragged into the Edit File slot would be silently accepted because the
  // browser drop event bypasses the <input accept="..."> filter.
  const { accepted, rejected } = _trcFilterFilesForSlot(slot, files);
  _trcReportRejected(slot, rejected);
  if (!accepted.length) { _checkReadiness(); return; }

  if (slot === 'edit') {
    _files.edit = _toPickedFile(accepted[0]);
    _setSingleDropMeta(_root.querySelector('#trcEditDrop'), _files.edit);
  } else if (slot === 'ref') {
    _files.ref = _toPickedFile(accepted[0]);
    _setSingleDropMeta(_root.querySelector('#trcRefDrop'), _files.ref);
  } else {
    _files.srcFolder = null;
    _files.src = [..._files.src, ...accepted.map(_toPickedFile).filter(Boolean)];
    _renderSrcList();
  }
  _checkReadiness();
}

function _renderSrcList() {
  const list = _root.querySelector('#trcSrcList');
  if (!list) return;
  const drop = _root.querySelector('#trcSrcDrop');
  const summary = _root.querySelector('#trcSrcSummary');
  const summaryCount = _root.querySelector('#trcSrcSummaryCount');
  const summarySize = _root.querySelector('#trcSrcSummarySize');

  const totalCount = _files.src.length + (_files.srcFolder ? 1 : 0);
  const totalBytes = _files.src.reduce((a, f) => a + (f.size || 0), 0);
  const allHavePaths = (!_files.srcFolder || !!_files.srcFolder.path) &&
                       (_files.src.length === 0 || _files.src.every(f => !!f.path));

  if (drop) {
    drop.classList.toggle('trc-file-drop--filled', totalCount > 0);
    drop.classList.toggle('trc-file-drop--needs-companion', totalCount > 0 && !allHavePaths);
    const lbl = drop.querySelector('#trcSrcLabel');
    const meta = drop.querySelector('#trcSrcMeta');
    if (totalCount === 0) {
      if (lbl) lbl.textContent = 'Drop source QT / OCF files here';
      if (meta) meta.textContent = 'or click to browse multiple';
    } else if (_files.srcFolder) {
      if (lbl) lbl.textContent = `Folder: ${_files.srcFolder.name}`;
      if (meta) meta.textContent = `${_files.srcFolder.path ? 'native path ✓' : 'needs companion'}`;
    } else {
      if (lbl) lbl.textContent = `${_files.src.length} source file${_files.src.length === 1 ? '' : 's'}`;
      const parts = [];
      const sz = _formatBytes(totalBytes); if (sz) parts.push(sz + ' total');
      parts.push(allHavePaths ? 'native paths ✓' : 'needs companion');
      if (meta) meta.textContent = parts.join(' · ');
    }
  }

  if (summary) summary.classList.toggle('trc-hidden', totalCount === 0);
  if (summaryCount) summaryCount.textContent = _files.srcFolder
    ? `1 folder${_files.src.length ? ` + ${_files.src.length} file${_files.src.length===1?'':'s'}` : ''}`
    : `${_files.src.length} file${_files.src.length === 1 ? '' : 's'}`;
  if (summarySize) summarySize.textContent = _formatBytes(totalBytes);

  const folderHtml = _files.srcFolder ? `
    <div class="trc-src-item trc-src-item--folder">
      <span class="trc-src-ico">📁</span>
      <span class="trc-src-name">${_esc(_files.srcFolder.name)}</span>
      <span class="trc-src-tag">folder${_files.srcFolder.path ? '' : ' · needs path'}</span>
      <button class="trc-src-remove" data-kind="folder" title="Remove" aria-label="Remove folder">×</button>
    </div>
  ` : '';
  const fileHtml = _files.src.map((f, i) => {
    const ext = _extOf(f.name);
    const sz = _formatBytes(f.size);
    const needs = !f.path;
    return `<div class="trc-src-item${needs ? ' trc-src-item--needs' : ''}">
       <span class="trc-src-ico">${ext ? ext.toUpperCase().slice(0,4) : '•'}</span>
       <span class="trc-src-name" title="${_esc(f.name)}">${_esc(f.name)}</span>
       ${sz ? `<span class="trc-src-size">${sz}</span>` : ''}
       ${needs ? '<span class="trc-src-tag trc-src-tag--warn">needs path</span>' : ''}
       <button class="trc-src-remove" data-kind="file" data-idx="${i}" title="Remove" aria-label="Remove ${_esc(f.name)}">×</button>
     </div>`;
  }).join('');
  list.innerHTML = folderHtml + fileHtml;
  list.querySelectorAll('.trc-src-remove').forEach(btn => {
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (btn.dataset.kind === 'folder') {
        _files.srcFolder = null;
      } else {
        // Guard: a missing/non-numeric idx → parseInt NaN → splice(NaN,1) removes
        // index 0 (the wrong file). Only splice on a valid index.
        const idx = parseInt(btn.dataset.idx, 10);
        if (Number.isInteger(idx) && idx >= 0 && idx < _files.src.length) _files.src.splice(idx, 1);
      }
      _renderSrcList();
      _checkReadiness();
    });
  });
}

function _checkReadiness() {
  const editReady   = !!(_files.edit?.path);
  const refReady    = !!(_files.ref?.path);
  const sourceReady = (!!_files.srcFolder?.path) ||
                      (_files.src.length > 0 && _files.src.every(f => !!f?.path));
  const folderReady = _outputFolder.permState === 'ready' && !!_outputFolder.path;

  // Loosened presence gate: enable the button when all four inputs EXIST,
  // even if some lack native paths. _startAnalysis will auto-resolve missing
  // source paths and prompt the companion for edit/ref on click.
  const editPresent   = !!_files.edit;
  const refPresent    = !!_files.ref;
  const sourcePresent = !!_files.srcFolder || _files.src.length > 0;
  const folderPresent = _outputFolder.permState === 'ready' && !!_outputFolder.path;
  const present = editPresent && refPresent && sourcePresent && folderPresent;

  const btn = _root?.querySelector('#trcAnalyzeBtn');
  if (btn) btn.disabled = !present;
  const hint = _root?.querySelector('#trcCtaHint');
  if (hint) {
    if (!present) {
      const missing = [];
      if (!editPresent)   missing.push('edit file');
      if (!refPresent)    missing.push('reference QT');
      if (!sourcePresent) missing.push('source media');
      if (!folderPresent) missing.push('output folder');
      hint.textContent = `Need ${missing.join(', ')}`;
      hint.classList.add('trc-kbd-hint--muted');
    } else {
      const willResolve = !(editReady && refReady && sourceReady && folderReady);
      hint.textContent = willResolve ? 'Will auto-resolve missing paths · ⌘↵' : '⌘↵ to run';
      hint.classList.toggle('trc-kbd-hint--muted', false);
    }
  }

  const rd = _root?.querySelector('#trcReadiness');
  if (!rd) return;

  function _chip(state, label, hintText, slot) {
    return `<button type="button" class="trc-ready-chip trc-ready-chip--${state}" data-slot="${slot || ''}" title="${_esc(hintText || label)}">
      <span class="trc-ready-chip-ico" aria-hidden="true">${
        state === 'ok'   ? '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="2,5.2 4.2,7.4 8,3"/></svg>' :
        state === 'warn' ? '<svg viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="5" r="3.5"/><path d="M5 3.5v2M5 6.7v.4"/></svg>' :
                           '<span class="trc-ready-chip-dot"></span>'
      }</span>
      <span class="trc-ready-chip-lbl">${_esc(label)}</span>
    </button>`;
  }

  const editState  = editReady ? 'ok' : (editPresent ? 'warn' : 'idle');
  const refState   = refReady  ? 'ok' : (refPresent  ? 'warn' : 'idle');
  const srcState   = sourceReady ? 'ok' : (sourcePresent ? 'warn' : 'idle');
  const folderState = folderReady ? 'ok' : (folderPresent ? 'warn' : 'idle');

  rd.innerHTML = [
    _chip(editState,
      editReady ? `Edit · ${_files.edit.name}` : (editPresent ? 'Edit · needs path' : 'Edit file'),
      editState === 'ok' ? 'Native path resolved' : (editPresent ? 'Click to re-pick with the companion (gives Resolve the absolute path)' : 'Drop or click the Edit File card'),
      'edit'),
    _chip(refState,
      refReady ? `Ref · ${_files.ref.name}` : (refPresent ? 'Ref · needs path' : 'Reference QT'),
      refState === 'ok' ? 'Native path resolved' : (refPresent ? 'Click to re-pick with the companion' : 'Drop or click the Reference QT card'),
      'ref'),
    _chip(srcState,
      sourceReady
        ? (_files.srcFolder ? `Source · ${_files.srcFolder.name}` : `Source · ${_files.src.length} file${_files.src.length === 1 ? '' : 's'}`)
        : (sourcePresent ? `Source · ${_files.src.filter(f => !f.path).length} need paths` : 'Source media'),
      srcState === 'ok' ? 'Native paths resolved' : (sourcePresent ? 'Click to auto-resolve via the companion (scans ancestors of the output folder)' : 'Drop or click the Source Media card'),
      'src'),
    _chip(folderState,
      folderReady ? `Output · ${_outputFolder.path.split('/').slice(-2).join('/')}` : 'Output folder',
      folderState === 'ok' ? 'Output folder ready' : 'Pick an output folder via the companion',
      'output'),
  ].join('');

  rd.querySelectorAll('.trc-ready-chip').forEach(chip => {
    chip.addEventListener('click', async () => {
      const slot = chip.dataset.slot;
      if (slot === 'edit')   { void _pickNativeEditFile(); }
      else if (slot === 'ref')    { void _pickNativeReferenceFile(); }
      else if (slot === 'src')    {
        if (_files.src.length && _files.src.some(f => !f.path)) {
          if (await _autoResolveSourcePaths()) { _renderSrcList(); _checkReadiness(); }
          else { void _pickNativeSourceFiles(); }
        } else {
          void _pickNativeSourceFiles();
        }
      }
      else if (slot === 'output') { void _pickOutputFolder(); }
    });
  });
}

async function _pickNativeEditFile() {
  try {
    // Pass the slot's allowed extensions to the picker so .edl/.xml/.fcpxml/
    // .otio files aren't dimmed by the macOS file-type filter. Without this,
    // the companion's default video-only filter greys out edit files.
    const res = await nativePickMediaFile(
      'Select Trailer Conform Edit File (EDL / XML / FCPXML / OTIO)',
      { extensions: _TRC_ALLOWED_EXTS.edit },
    );
    const path = res?.result?.path || res?.result?.filePath || '';
    if (!path) return false;
    // Validate the returned path anyway — older companions may not honour the
    // extensions filter (e.g. tkinter fallback on non-macOS).
    const ext = _trcExtOf(path);
    if (!_TRC_ALLOWED_EXTS.edit.includes(ext)) {
      _trcReportRejected('edit', [{ name: path.split(/[\\/]/).pop() || path, ext }]);
      return false;
    }
    const size = res?.result?.size || 0;
    _files.edit = _toNativeFile(path, size);
    _setSingleDropMeta(_root.querySelector('#trcEditDrop'), _files.edit);
    _checkReadiness();
    return true;
  } catch (err) {
    _toast(`Native edit-file picker unavailable: ${err?.userMessage || err?.message || err}`, true);
    return false;
  }
}

async function _pickNativeReferenceFile() {
  try {
    const res = await nativePickMediaFile(
      'Select Trailer Reference QuickTime (MOV / MP4 / MXF)',
      { extensions: _TRC_ALLOWED_EXTS.ref },
    );
    const path = res?.result?.path || res?.result?.filePath || '';
    if (!path) return false;
    const ext = _trcExtOf(path);
    if (!_TRC_ALLOWED_EXTS.ref.includes(ext)) {
      _trcReportRejected('ref', [{ name: path.split(/[\\/]/).pop() || path, ext }]);
      return false;
    }
    const size = res?.result?.size || 0;
    _files.ref = _toNativeFile(path, size);
    _setSingleDropMeta(_root.querySelector('#trcRefDrop'), _files.ref);
    _checkReadiness();
    return true;
  } catch (err) {
    _toast(`Native reference-file picker unavailable: ${err?.userMessage || err?.message || err}`, true);
    return false;
  }
}

async function _pickNativeSourceFiles() {
  try {
    const res = await nativePickMediaFiles(
      'Select Source Media Files',
      { extensions: _TRC_ALLOWED_EXTS.src },
    );
    const paths = res?.result?.paths || res?.result?.filePaths || [];
    if (!paths.length) return false;
    // Filter by extension even though the picker should have already filtered —
    // tkinter on non-macOS doesn't always enforce the type list reliably.
    const okPaths = []; const bad = [];
    for (const p of paths) {
      const ext = _trcExtOf(p);
      if (_TRC_ALLOWED_EXTS.src.includes(ext)) okPaths.push(p);
      else bad.push({ name: p.split(/[\\/]/).pop() || p, ext });
    }
    if (bad.length) _trcReportRejected('src', bad);
    if (!okPaths.length) return false;
    _files.srcFolder = null;
    const existing = new Set(_files.src.map(f => f.path));
    const additions = okPaths
      .map(_toNativeFile)
      .filter(Boolean)
      .filter(file => !existing.has(file.path));
    _files.src = [..._files.src, ...additions];
    const lbl = _root.querySelector('#trcSrcLabel');
    if (lbl) lbl.textContent = `${_files.src.length} source file(s) selected`;
    _renderSrcList();
    _checkReadiness();
    return true;
  } catch (err) {
    _toast(`Native source picker unavailable. Use "Choose Folder…" or update the companion helper. ${err?.userMessage || err?.message || ''}`.trim(), true);
    return false;
  }
}

async function _pickNativeSourceFolder() {
  try {
    const res = await nativePickFolder('Select Source Media Folder');
    const path = res?.result?.path || res?.result?.folderPath || '';
    if (!path) return false;
    _files.src = [];
    _files.srcFolder = _toNativeFolder(path);
    const lbl = _root.querySelector('#trcSrcLabel');
    if (lbl) lbl.textContent = `Source folder: ${_files.srcFolder.name}`;
    _renderSrcList();
    _checkReadiness();
    return true;
  } catch (err) {
    _toast(`Native source-folder picker unavailable: ${err?.userMessage || err?.message || err}`, true);
    return false;
  }
}

async function _resolveMissingPaths() {
  // Walks each input slot; if a file is loaded but lacks a native path
  // (e.g. came from drag-and-drop), prompt the companion picker to
  // resolve a real filesystem path. Returns true if all paths are
  // resolved by the end, false if the user cancelled or the helper
  // failed for any slot.
  if (_files.edit && !_files.edit.path) {
    _toast(`Re-pick edit file (${_files.edit.name}) using the companion…`);
    const ok = await _pickNativeEditFile();
    if (!ok || !_files.edit?.path) {
      _toast('Edit file path not resolved. Use "Choose Files…" via the companion picker.', true);
      return false;
    }
  }
  if (_files.ref && !_files.ref.path) {
    _toast(`Re-pick reference QT (${_files.ref.name}) using the companion…`);
    const ok = await _pickNativeReferenceFile();
    if (!ok || !_files.ref?.path) {
      _toast('Reference QT path not resolved. Use "Choose Files…" via the companion picker.', true);
      return false;
    }
  }
  if (_files.srcFolder && !_files.srcFolder.path) {
    _toast('Re-pick source folder using the companion…');
    const ok = await _pickNativeSourceFolder();
    if (!ok || !_files.srcFolder?.path) {
      _toast('Source folder path not resolved. Use "Choose Folder…" via the companion picker.', true);
      return false;
    }
  } else if (_files.src.length && _files.src.some(f => !f.path)) {
    const ok = await _autoResolveSourcePaths();
    if (!ok) {
      // Fall back to companion picker only if auto-search couldn't find every file.
      _toast(`Re-pick ${_files.src.filter(f => !f.path).length} source file(s) using the companion…`);
      _files.src = _files.src.filter(f => !!f.path);
      const picked = await _pickNativeSourceFiles();
      if (!picked || _files.src.some(f => !f.path) || _files.src.length === 0) {
        _toast('Source media paths not resolved. Use "Choose Files…" via the companion picker.', true);
        return false;
      }
    }
  }
  return true;
}

// Walks candidate root folders (cached source root, then ancestors of the
// output folder, then the volume root) and probes each with the companion's
// recursive media scanner. For every path-less entry in _files.src, fills in
// the absolute path of the first filename match. Caches the winning root
// so subsequent runs are zero-click.
async function _autoResolveSourcePaths() {
  const missing = _files.src.filter(f => !f.path);
  if (!missing.length) return true;

  const missingNames = new Set(missing.map(f => (f.name || '').toLowerCase()).filter(Boolean));
  if (!missingNames.size) return false;

  const roots = [];
  const push = (p) => { if (p && !roots.includes(p)) roots.push(p); };

  push(_STATE.srcRoot);

  const out = (_outputFolder?.path || '').replace(/[\\/]+$/, '');
  if (out) {
    const parts = out.split('/').filter(Boolean);
    // Ancestors: parent, grandparent, great-grandparent (tightest first to
    // avoid scanning the entire drive when source media is nearby).
    for (let lvl = 1; lvl <= 3; lvl++) {
      if (parts.length - lvl > 0) push('/' + parts.slice(0, parts.length - lvl).join('/'));
    }
    // /Volumes/<drive> — broad last-resort fallback covering everything on the drive.
    if (parts[0] === 'Volumes' && parts[1]) push('/Volumes/' + parts[1]);
  }

  for (const root of roots) {
    let files;
    try {
      const res = await nativeProbeOcfFolder(root);
      files = res?.result || res?.files || [];
      if (!Array.isArray(files)) continue;
    } catch { continue; }
    if (!files.length) continue;

    const nameToPath = new Map();
    for (const f of files) {
      const nm = (f?.name || '').toLowerCase();
      if (nm && missingNames.has(nm) && !nameToPath.has(nm)) {
        nameToPath.set(nm, f.path || '');
      }
    }
    if (!nameToPath.size) continue;

    let matched = 0;
    for (const f of _files.src) {
      if (f.path) continue;
      const p = nameToPath.get((f.name || '').toLowerCase());
      if (p) { f.path = p; f.file = null; matched++; }
    }

    if (_files.src.every(f => !!f.path)) {
      _STATE.srcRoot = root;
      _toast(`Auto-resolved ${matched} source file(s) from ${root}`);
      try { await _persistTrailerConformSettings(); } catch {}
      return true;
    }
  }

  return _files.src.every(f => !!f.path);
}

async function _startAnalysis() {
  const hasSource = _files.src.length > 0 || !!_files.srcFolder;
  if (!_files.edit || !_files.ref || !hasSource || _outputFolder.permState !== 'ready') return;

  // Require a real filesystem path for Resolve jobs
  if (_outputFolder.kind === 'fsaa' && !_outputFolder.path) {
    _toast('Resolve needs a real folder path. Please reconnect using the PFX companion folder picker.', true);
    return;
  }

  // Pre-flight: confirm a cached successful manual Test Connection exists.
  // Resolve is fully manual now — we never trigger an auto-connect or detect
  // from here. The status comes from the most recent user-initiated Test
  // Connection in Project Setup → Resolve Engine.
  const status = (typeof window !== 'undefined' && window.PFX_RESOLVE_STATUS) || null;
  if (!status || status.state !== 'connected') {
    _toast(
      'Open DaVinci Resolve manually, then go to Project Setup → Resolve Engine and click Test Connection.',
      true,
    );
    return;
  }

  // Auto-resolve any missing native paths (e.g. dropped files) via the companion.
  const needsResolve =
    !_files.edit.path ||
    !_files.ref.path ||
    _files.src.some(f => !f.path) ||
    (_files.srcFolder && !_files.srcFolder.path);
  if (needsResolve) {
    const resolved = await _resolveMissingPaths();
    if (!resolved) return;
    _checkReadiness();
  }

  // Verify output folder still accessible before launching Resolve
  const folderOk = await _verifyFolderWritable(_outputFolder.path);
  if (!folderOk) {
    _setOutputLost();
    return;
  }

  // Read edit file text locally for client-side preview; pass path to companion
  let editText = '';
  try {
    if (_files.edit.file?.text) editText = await _files.edit.file.text();
  } catch { /* ok */ }

  // Parse locally for immediate event count
  const localEvents = editText
    ? parseEditText(editText, _files.edit.name.split('.').pop(), _STATE.fps)
    : [];

  // Build job output subfolder: <outputFolder>/trailer_conform/job_NNNN/
  const jobId   = `trc_${Date.now()}`;
  const jobNum  = String(await _nextJobNum()).padStart(4, '0');
  const jobDir  = `${_outputFolder.path}/trailer_conform/job_${jobNum}`;
  _STATE.outputDir = jobDir;

  // Build job
  const [pw, ph] = (_root.querySelector('#trcProxySize')?.value || '640x360').split('x').map(Number);
  const job = {
    jobId,
    editFile: _files.edit.path,
    editFormat: _files.edit.name.split('.').pop().toLowerCase(),
    referenceFile: _files.ref.path,
    sourceFiles: _files.src.map(f => f.path),
    sourceFolder: _files.srcFolder?.path || '',
    outputDir: jobDir,
    fps: _STATE.fps,
    proxyWidth: pw,
    proxyHeight: ph,
    label: _STATE.label,
    previewEvents: localEvents.slice(0, 5).map(e => ({ index: e.index, clipName: e.clipName })),
  };

  // Pre-flight: fail fast on misconfigured inputs (~100ms) instead of waiting
  // ~15 min through proxy rendering. Errors block the run; warnings show in a
  // toast but the user can still proceed.
  try {
    const pf = await nativeConformPreflight(job);
    const info = pf?.result;
    if (info && info.ok === false && Array.isArray(info.errors) && info.errors.length) {
      _toast(`Pre-flight failed: ${info.errors[0]}`, true);
      return;
    }
    if (info?.warnings?.length) {
      _toast(`Pre-flight: ${info.warnings[0]}`);
    }
    if (info?.editEventsCount > 0 && info?.sourceAfterPrefilter !== undefined) {
      const eta = Math.max(1, Math.round((info.estimatedProxySeconds || 0) / 60));
      _toast(`Pre-flight ok: ${info.editEventsCount} events, ${info.sourceAfterPrefilter}/${info.sourceFileCount} sources (~${eta} min proxy render)`);
    }
  } catch (e) {
    // Pre-flight is a nice-to-have — companion may be too old to support it.
    // Log and proceed.
    console.warn('[TRC] pre-flight skipped:', e?.message || e);
  }

  _STATE.events = localEvents;
  _STATE.phase = 'analyzing';
  _renderPhase();

  try {
    const res = await nativeConformAnalyze(job);
    if (res?.ok && res.result?.jobId) {
      _STATE.jobId = res.result.jobId;
      _startPolling();
    } else {
      _showAnalysisError(res?.error?.message || 'Failed to start analysis.');
    }
  } catch (e) {
    _showAnalysisError(String(e));
  }
}

// ── Phase 2: Analyzing ────────────────────────────────────────────────────────

function _htmlAnalyzing() {
  // Show the local parse count only when we actually parsed events client-side.
  // Drag-dropped edit files give us a File blob we can read; native-picker
  // files only have a path, so localEvents stays empty until the companion
  // sends back the real count. Showing "0" in that case was confusing — use
  // a placeholder dash instead.
  const eventCount = _STATE.events.length > 0 ? String(_STATE.events.length) : '—';
  return `
<div class="trc-analyzing">
  <div class="trc-analyze-header">
    <div class="trc-analyze-title">Analyzing with DaVinci Resolve…</div>
    <button class="trc-btn trc-btn--ghost trc-btn--sm" id="trcCancelAnalyzeBtn">Cancel</button>
  </div>
  <div class="trc-progress-wrap">
    <div class="trc-progress-bar"><div class="trc-progress-fill" id="trcProgressFill" style="width:0%"></div></div>
    <span class="trc-progress-pct" id="trcProgressPct">0%</span>
  </div>
  <div class="trc-progress-msg" id="trcProgressMsg">Starting…</div>
  <div class="trc-analyze-stats">
    <div class="trc-stat"><span class="trc-stat-n" id="trcStatEvents">${eventCount}</span><span class="trc-stat-l">Events</span></div>
    <div class="trc-stat"><span class="trc-stat-n" id="trcStatProxies">—</span><span class="trc-stat-l">Proxies</span></div>
    <div class="trc-stat"><span class="trc-stat-n" id="trcStatMatched">—</span><span class="trc-stat-l">Matched</span></div>
  </div>
  <div class="trc-analyze-log" id="trcAnalyzeLog"></div>
  <div class="trc-analyze-error trc-hidden" id="trcAnalyzeError"></div>
</div>`;
}

function _wireAnalyzing() {
  _root.querySelector('#trcCancelAnalyzeBtn')?.addEventListener('click', async () => {
    if (_STATE.jobId) await nativeConformCancelJob(_STATE.jobId).catch(() => {});
    _stopPolling();
    _STATE.phase = 'setup';
    _renderPhase();
  });
}

function _startPolling() {
  _stopPolling();
  _trcAnalyzePollFailStreak = 0;
  _STATE.pollTimer = setInterval(_pollJobStatus, 1500);
}

function _stopPolling() {
  if (_STATE.pollTimer) { clearInterval(_STATE.pollTimer); _STATE.pollTimer = null; }
}

// In-flight guard so a slow companion response doesn't cause overlapping
// polls. setInterval keeps firing every 1.5s regardless of whether the
// previous request returned, so this guard skips re-entry while a request
// is outstanding. Companion-failure counter stops the poll loop after a
// run of failures so a crashed companion doesn't leave the UI spinning
// forever.
let _trcAnalyzePollInFlight = false;
let _trcAnalyzePollFailStreak = 0;
const _TRC_POLL_MAX_FAILS = 5;
async function _pollJobStatus() {
  if (!_STATE.jobId) return;
  if (_trcAnalyzePollInFlight) return;
  _trcAnalyzePollInFlight = true;
  let res;
  try {
    res = await nativeConformJobStatus(_STATE.jobId);
  } catch (err) {
    _trcAnalyzePollInFlight = false;
    _trcAnalyzePollFailStreak++;
    if (_trcAnalyzePollFailStreak >= _TRC_POLL_MAX_FAILS) {
      _showAnalysisError(`Lost connection to the companion after ${_TRC_POLL_MAX_FAILS} attempts. ${err?.message || ''}`.trim());
    }
    return;
  }
  _trcAnalyzePollInFlight = false;

  if (!res?.ok || !res.result) {
    _trcAnalyzePollFailStreak++;
    if (_trcAnalyzePollFailStreak >= _TRC_POLL_MAX_FAILS) {
      _showAnalysisError(`Companion returned no status after ${_TRC_POLL_MAX_FAILS} attempts. The job may have crashed.`);
    }
    return;
  }
  _trcAnalyzePollFailStreak = 0;
  const s = res.result;

  // Update progress UI
  const fill = _root.querySelector('#trcProgressFill');
  const pctEl = _root.querySelector('#trcProgressPct');
  const msgEl = _root.querySelector('#trcProgressMsg');
  if (fill)  fill.style.width = `${s.pct || 0}%`;
  if (pctEl) pctEl.textContent = `${s.pct || 0}%`;
  if (msgEl) msgEl.textContent = s.message || '';

  // Update stats
  if (s.events?.length) {
    _STATE.events = s.events;
    const el = _root.querySelector('#trcStatEvents');
    if (el) el.textContent = s.events.length;
  }
  if (s.proxies?.length) {
    const el = _root.querySelector('#trcStatProxies');
    if (el) el.textContent = s.proxies.length;
  }
  if (s.matches?.length) {
    _STATE.matches = s.matches;
    const el = _root.querySelector('#trcStatMatched');
    if (el) el.textContent = s.matches.filter(m => m.accepted).length;
  }
  // Append log line
  const log = _root.querySelector('#trcAnalyzeLog');
  if (log && s.message && (!log.lastChild || log.lastChild.textContent !== s.message)) {
    const line = document.createElement('div');
    line.className = 'trc-log-line';
    line.textContent = `[${s.step || ''}] ${s.message}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  if (s.done) {
    _stopPolling();
    if (s.result?.status === 'ok') {
      _STATE.analysisResult = s.result;
      if (s.result.matches?.length) _STATE.matches = s.result.matches;
      if (s.result.editEvents?.length) _STATE.events = s.result.editEvents;
      _STATE.phase = 'review';
      _renderPhase();
    } else {
      _showAnalysisError(s.result?.error?.message || 'Analysis failed.');
    }
  }
}

function _showAnalysisError(msg) {
  _stopPolling();
  const errEl = _root.querySelector('#trcAnalyzeError');
  if (errEl) { errEl.textContent = `Error: ${msg}`; errEl.classList.remove('trc-hidden'); }
  const fill = _root.querySelector('#trcProgressFill');
  if (fill) fill.classList.add('trc-progress-fill--err');
}

// ── Phase 3: Review ────────────────────────────────────────────────────────────

function _htmlReview() {
  const matches = _STATE.matches;
  const autoCount = matches.filter(m => m.accepted).length;
  const manualCount = matches.filter(m => !m.accepted && m.candidates?.length).length;
  const noMatchCount = matches.filter(m => !m.candidates?.length).length;

  return `
<div class="trc-review">
  <div class="trc-review-header">
    <div class="trc-review-summary">
      <span class="trc-summary-chip trc-summary-chip--ok">${autoCount} auto-matched</span>
      <span class="trc-summary-chip trc-summary-chip--warn">${manualCount} need review</span>
      ${noMatchCount ? `<span class="trc-summary-chip trc-summary-chip--err">${noMatchCount} no match</span>` : ''}
    </div>
    <div class="trc-review-controls">
      <button class="trc-btn trc-btn--ghost trc-btn--sm" id="trcAcceptAllBtn">Accept all auto</button>
      <button class="trc-btn trc-btn--ghost trc-btn--sm" id="trcRejectAllBtn">Reject all</button>
      <input type="text" class="trc-input trc-input--sm" id="trcMatchSearch" placeholder="Filter events…">
    </div>
  </div>

  <div class="trc-review-table-wrap">
    <table class="trc-table" id="trcMatchTable">
      <thead>
        <tr>
          <th class="trc-th-idx">#</th>
          <th class="trc-th-clip">Event / Reel</th>
          <th class="trc-th-dur">Dur</th>
          <th class="trc-th-match">Best Match</th>
          <th class="trc-th-conf">Confidence</th>
          <th class="trc-th-speed">Speed</th>
          <th class="trc-th-action">Action</th>
        </tr>
      </thead>
      <tbody id="trcMatchTbody">
        ${matches.map(_htmlMatchRow).join('')}
      </tbody>
    </table>
  </div>

  <div class="trc-review-foot">
    <div class="trc-accepted-count" id="trcAcceptedCount">${autoCount} accepted</div>
    <div class="trc-review-foot-actions">
      <label class="trc-foot-option" title="Render a review QuickTime with burn-in alongside the build (slower)">
        <input type="checkbox" id="trcRenderReviewChk">
        <span>Render review QT with burn-in</span>
      </label>
      <button class="trc-btn trc-btn--ghost" id="trcExportOnlyBtn">Export EDL/CSV only</button>
      <button class="trc-btn trc-btn--primary" id="trcBuildBtn">
        Build Resolve Timeline →
      </button>
    </div>
  </div>
</div>

<!-- Per-event candidate picker (hidden until expanded) -->
<div class="trc-candidate-panel trc-hidden" id="trcCandidatePanel">
  <div class="trc-candidate-head">
    <span id="trcCandidateTitle">Select match</span>
    <button class="trc-btn trc-btn--ghost trc-btn--sm" id="trcCandidateClose">×</button>
  </div>
  <div class="trc-candidate-list" id="trcCandidateList"></div>
</div>`;
}

function _htmlMatchRow(match) {
  const ev = match.event || {};
  const cands = match.candidates || [];
  const top = cands[0] || null;
  const conf = top?.confidence ?? 0;
  const cls = confidenceLabel(conf);
  const clr = confidenceColor(conf);
  const srcName = top ? (top.sourceFile || '').split(/[\\/]/).pop() : '—';
  const durFrames = ev.duration_frames || ev.durationFrames || 0;
  const dur = durFrames > 0 ? _formatDur(durFrames, _STATE.fps) : '—';
  const accepted = match.accepted;
  const speed = top ? detectSpeedChange(durFrames, top.sourceDurationFrames || 0, 0, _STATE.fps) : null;

  return `<tr class="trc-row${accepted?' trc-row--accepted':''}" data-event-idx="${match.eventIndex}">
    <td class="trc-td-idx">${match.eventIndex}</td>
    <td class="trc-td-clip">
      <div class="trc-clip-name">${_esc(ev.clip_name || ev.clipName || '')}</div>
      <div class="trc-clip-reel">${_esc(ev.reel || '')}</div>
    </td>
    <td class="trc-td-dur">${dur}</td>
    <td class="trc-td-match">
      <div class="trc-match-name" title="${_esc(top?.sourceFile || '')}">${_esc(srcName)}</div>
      ${top ? `<div class="trc-match-breakdown">
        fn:${(top.breakdown?.filename||0).toFixed(2)}
        dur:${(top.breakdown?.duration||0).toFixed(2)}
        aud:${(top.breakdown?.audio||0).toFixed(2)}
      </div>` : ''}
    </td>
    <td class="trc-td-conf">
      <div class="trc-conf-bar-wrap">
        <div class="trc-conf-bar" style="width:${Math.round(conf*100)}%;background:${clr}"></div>
      </div>
      <span class="trc-conf-val trc-conf-val--${cls}">${Math.round(conf*100)}%</span>
    </td>
    <td class="trc-td-speed">
      ${speed?.hasSpeedChange ? `<span class="trc-speed-badge">${speed.description}</span>` : ''}
    </td>
    <td class="trc-td-action">
      <button class="trc-action-btn trc-action-btn--${accepted?'reject':'accept'}" data-event-idx="${match.eventIndex}">
        ${accepted ? 'Reject' : 'Accept'}
      </button>
      ${cands.length > 1 ? `<button class="trc-action-btn trc-action-btn--pick" data-event-idx="${match.eventIndex}">Pick…</button>` : ''}
    </td>
  </tr>`;
}

function _wireReview() {
  _root.querySelector('#trcAcceptAllBtn')?.addEventListener('click', () => {
    _STATE.matches.forEach(m => { if (m.candidates?.length) m.accepted = true; });
    _refreshReviewTable();
    _updateAcceptedCount();
  });
  _root.querySelector('#trcRejectAllBtn')?.addEventListener('click', () => {
    _STATE.matches.forEach(m => { m.accepted = false; });
    _refreshReviewTable();
    _updateAcceptedCount();
  });
  _root.querySelector('#trcMatchSearch')?.addEventListener('input', e => {
    const q = e.target.value.toLowerCase();
    _root.querySelectorAll('.trc-row').forEach(row => {
      const txt = row.textContent.toLowerCase();
      row.style.display = txt.includes(q) ? '' : 'none';
    });
  });

  _root.querySelectorAll('.trc-action-btn--accept, .trc-action-btn--reject').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.eventIdx, 10);
      const match = _STATE.matches.find(m => m.eventIndex === idx);
      if (!match) return;
      match.accepted = !match.accepted;
      _refreshRowByIdx(idx);
      _updateAcceptedCount();
    });
  });

  _root.querySelectorAll('.trc-action-btn--pick').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.eventIdx, 10);
      _openCandidatePanel(idx);
    });
  });

  _root.querySelector('#trcCandidateClose')?.addEventListener('click', _closeCandidatePanel);
  _root.querySelector('#trcBuildBtn')?.addEventListener('click', _startBuild);
  _root.querySelector('#trcExportOnlyBtn')?.addEventListener('click', _exportOnly);
}

function _refreshReviewTable() {
  const tbody = _root.querySelector('#trcMatchTbody');
  if (tbody) tbody.innerHTML = _STATE.matches.map(_htmlMatchRow).join('');
  _wireReviewRows();
}

function _wireReviewRows() {
  _root.querySelectorAll('.trc-action-btn--accept, .trc-action-btn--reject').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.eventIdx, 10);
      const match = _STATE.matches.find(m => m.eventIndex === idx);
      if (!match) return;
      match.accepted = !match.accepted;
      _refreshRowByIdx(idx);
      _updateAcceptedCount();
    });
  });
  _root.querySelectorAll('.trc-action-btn--pick').forEach(btn => {
    btn.addEventListener('click', () => {
      _openCandidatePanel(parseInt(btn.dataset.eventIdx, 10));
    });
  });
}

function _refreshRowByIdx(idx) {
  const match = _STATE.matches.find(m => m.eventIndex === idx);
  if (!match) return;
  const row = _root.querySelector(`.trc-row[data-event-idx="${idx}"]`);
  if (!row) return;
  row.outerHTML = _htmlMatchRow(match);
  _wireReviewRows();
}

function _updateAcceptedCount() {
  const n = _STATE.matches.filter(m => m.accepted).length;
  const el = _root.querySelector('#trcAcceptedCount');
  if (el) el.textContent = `${n} accepted`;
}

function _openCandidatePanel(eventIdx) {
  const match = _STATE.matches.find(m => m.eventIndex === eventIdx);
  if (!match) return;
  const panel = _root.querySelector('#trcCandidatePanel');
  const title = _root.querySelector('#trcCandidateTitle');
  const list  = _root.querySelector('#trcCandidateList');
  if (!panel || !list) return;

  const ev = match.event || {};
  if (title) title.textContent = `Candidates for event ${eventIdx}: ${ev.clip_name || ev.clipName || ''}`;
  list.innerHTML = (match.candidates || []).map((c, i) => {
    const name = (c.sourceFile || '').split(/[\\/]/).pop();
    const conf = c.confidence ?? 0;
    const selected = match.acceptedSourceIndex === c.sourceIndex;
    return `<div class="trc-cand-item${selected?' trc-cand-item--selected':''}" data-src-idx="${c.sourceIndex}" data-event-idx="${eventIdx}">
      <div class="trc-cand-rank">${i+1}</div>
      <div class="trc-cand-info">
        <div class="trc-cand-name">${_esc(name)}</div>
        <div class="trc-cand-breakdown">
          Filename ${(c.breakdown?.filename||0).toFixed(2)} ·
          Duration ${(c.breakdown?.duration||0).toFixed(2)} ·
          Audio ${(c.breakdown?.audio||0).toFixed(2)}
        </div>
      </div>
      <div class="trc-cand-conf" style="color:${confidenceColor(conf)}">${Math.round(conf*100)}%</div>
      <button class="trc-btn trc-btn--sm${selected?' trc-btn--primary':' trc-btn--ghost'}" data-src-idx="${c.sourceIndex}" data-event-idx="${eventIdx}">
        ${selected ? 'Selected' : 'Select'}
      </button>
    </div>`;
  }).join('') || '<div class="trc-cand-empty">No candidates</div>';

  list.querySelectorAll('.trc-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const srcIdx = parseInt(btn.dataset.srcIdx, 10);
      const evIdx  = parseInt(btn.dataset.eventIdx, 10);
      const m = _STATE.matches.find(x => x.eventIndex === evIdx);
      if (!m) return;
      m.acceptedSourceIndex = srcIdx;
      m.accepted = true;
      const chosen = m.candidates.find(c => c.sourceIndex === srcIdx);
      if (chosen) m.acceptedSourceFile = chosen.sourceFile;
      _closeCandidatePanel();
      _refreshRowByIdx(evIdx);
      _updateAcceptedCount();
    });
  });

  panel.classList.remove('trc-hidden');
}

function _closeCandidatePanel() {
  _root.querySelector('#trcCandidatePanel')?.classList.add('trc-hidden');
}

async function _exportOnly() {
  const accepted = _getAcceptedMatchList();
  if (!accepted.length) { _toast('No accepted matches to export.', true); return; }
  try {
    const res = await nativeConformExport(
      accepted, _STATE.outputDir, _STATE.fps, _STATE.label,
      ['edl', 'fcpxml', 'otio', 'csv']
    );
    if (res?.ok) {
      _toast(`Exported to ${_STATE.outputDir}`);
    } else {
      _toast(res?.error?.message || 'Export failed.', true);
    }
  } catch (e) {
    _toast(String(e), true);
  }
}

async function _startBuild() {
  const accepted = _getAcceptedMatchList();
  if (!accepted.length) { _toast('Accept at least one match first.', true); return; }

  // Read the inline checkbox set during Review — no more blocking confirm().
  const renderReview = !!_root?.querySelector('#trcRenderReviewChk')?.checked;
  const job = {
    jobId: `trcbuild_${Date.now()}`,
    matchList: accepted,
    outputDir: _STATE.outputDir,
    fps: _STATE.fps,
    label: _STATE.label,
    renderReview,
    burnIn: renderReview,
    exportFormats: ['edl', 'fcpxml', 'otio', 'csv'],
  };

  _STATE.phase = 'building';
  _renderPhase();

  try {
    const res = await nativeConformBuildTimeline(job);
    if (res?.ok && res.result?.jobId) {
      _STATE.jobId = res.result.jobId;
      _startBuildPolling();
    } else {
      _showBuildError(res?.error?.message || 'Failed to start build.');
    }
  } catch (e) {
    _showBuildError(String(e));
  }
}

function _getAcceptedMatchList() {
  return _STATE.matches
    .filter(m => m.accepted)
    .map(m => {
      const top = m.candidates?.[0] || {};
      const srcFile = m.acceptedSourceFile || top.sourceFile || '';
      const srcIn   = m.acceptedSourceIn   || top.suggestedSourceIn || '00:00:00:00';
      // Compute srcOut from srcIn + event duration
      const durFrames = m.event?.duration_frames || m.event?.durationFrames || 0;
      const inFrames = tcToFrames(srcIn, _STATE.fps);
      const srcOut = framesToTc(inFrames + durFrames, _STATE.fps);
      return {
        eventIndex: m.eventIndex,
        event: m.event,
        acceptedSourceFile: srcFile,
        acceptedSourceIn:   srcIn,
        acceptedSourceOut:  srcOut,
        accepted: true,
        status: 'accepted',
      };
    });
}

// ── Phase 4: Building ──────────────────────────────────────────────────────────

function _htmlBuilding() {
  return `
<div class="trc-building">
  <div class="trc-building-title">Building Conform Timeline in DaVinci Resolve…</div>
  <div class="trc-progress-wrap">
    <div class="trc-progress-bar"><div class="trc-progress-fill" id="trcBuildFill" style="width:0%"></div></div>
    <span class="trc-progress-pct" id="trcBuildPct">0%</span>
  </div>
  <div class="trc-progress-msg" id="trcBuildMsg">Connecting to Resolve…</div>
  <div class="trc-analyze-log" id="trcBuildLog"></div>
  <div class="trc-analyze-error trc-hidden" id="trcBuildError"></div>
  <button class="trc-btn trc-btn--ghost trc-btn--sm" id="trcCancelBuildBtn" style="margin-top:12px">Cancel</button>
</div>`;
}

function _wireBuilding() {
  _root.querySelector('#trcCancelBuildBtn')?.addEventListener('click', async () => {
    if (_STATE.jobId) await nativeConformCancelJob(_STATE.jobId).catch(() => {});
    _stopPolling();
    _STATE.phase = 'review';
    _renderPhase();
  });
}

function _startBuildPolling() {
  _stopPolling();
  _trcBuildPollFailStreak = 0;
  _STATE.pollTimer = setInterval(_pollBuildStatus, 2000);
}

let _trcBuildPollInFlight = false;
let _trcBuildPollFailStreak = 0;
async function _pollBuildStatus() {
  if (!_STATE.jobId) return;
  if (_trcBuildPollInFlight) return;
  _trcBuildPollInFlight = true;
  let res;
  try { res = await nativeConformJobStatus(_STATE.jobId); }
  catch (err) {
    _trcBuildPollInFlight = false;
    _trcBuildPollFailStreak++;
    if (_trcBuildPollFailStreak >= _TRC_POLL_MAX_FAILS) {
      _showBuildError(`Lost connection to the companion after ${_TRC_POLL_MAX_FAILS} attempts. ${err?.message || ''}`.trim());
    }
    return;
  }
  _trcBuildPollInFlight = false;
  if (!res?.ok || !res.result) {
    _trcBuildPollFailStreak++;
    if (_trcBuildPollFailStreak >= _TRC_POLL_MAX_FAILS) {
      _showBuildError(`Companion returned no build status after ${_TRC_POLL_MAX_FAILS} attempts. The job may have crashed.`);
    }
    return;
  }
  _trcBuildPollFailStreak = 0;
  const s = res.result;

  const fill = _root.querySelector('#trcBuildFill');
  const pct  = _root.querySelector('#trcBuildPct');
  const msg  = _root.querySelector('#trcBuildMsg');
  if (fill) fill.style.width = `${s.pct || 0}%`;
  if (pct)  pct.textContent  = `${s.pct || 0}%`;
  if (msg)  msg.textContent  = s.message || '';

  const log = _root.querySelector('#trcBuildLog');
  if (log && s.message && (!log.lastChild || log.lastChild.textContent !== s.message)) {
    const line = document.createElement('div');
    line.className = 'trc-log-line';
    line.textContent = `[${s.step}] ${s.message}`;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }

  if (s.done) {
    _stopPolling();
    if (s.result?.status === 'ok') {
      _STATE.buildResult = s.result;
      _STATE.phase = 'done';
      _renderPhase();
    } else {
      _showBuildError(s.result?.error?.message || 'Build failed.');
    }
  }
}

function _showBuildError(msg) {
  _stopPolling();
  const errEl = _root.querySelector('#trcBuildError');
  if (errEl) { errEl.textContent = `Error: ${msg}`; errEl.classList.remove('trc-hidden'); }
}

// ── Phase 5: Done ─────────────────────────────────────────────────────────────

function _htmlDone() {
  const br = _STATE.buildResult || {};
  const exports = br.exports || {};
  const exportItems = Object.entries(exports).map(([fmt, path]) =>
    `<div class="trc-done-export">
      <span class="trc-done-fmt">${fmt.toUpperCase()}</span>
      <span class="trc-done-path">${path}</span>
    </div>`
  ).join('');

  return `
<div class="trc-done">
  <div class="trc-done-check">✓</div>
  <div class="trc-done-title">Conform Complete</div>
  <div class="trc-done-stats">
    <div class="trc-done-stat"><strong>${br.clipsPlaced || br.matchCount || '—'}</strong> clips placed</div>
    <div class="trc-done-stat"><strong>${br.timelineName || '—'}</strong> timeline in Resolve</div>
    ${br.reviewQt ? `<div class="trc-done-stat">Review QT: <strong>${br.reviewQt.split(/[\\/]/).pop()}</strong></div>` : ''}
  </div>
  ${exportItems ? `<div class="trc-done-exports"><div class="trc-done-exports-head">Exported files</div>${exportItems}</div>` : ''}
  <div class="trc-done-actions">
    <button class="trc-btn trc-btn--ghost" id="trcBackToReviewBtn">← Back to Review</button>
    <button class="trc-btn trc-btn--primary" id="trcNewConformBtn">New Conform</button>
  </div>
</div>`;
}

function _wireDone() {
  _root.querySelector('#trcBackToReviewBtn')?.addEventListener('click', () => {
    _STATE.phase = 'review';
    _renderPhase();
  });
  _root.querySelector('#trcNewConformBtn')?.addEventListener('click', _resetAll);
}

// ── Output folder management ──────────────────────────────────────────────────

async function _pickOutputFolder() {
  const btn = _root?.querySelector('#trcChooseFolderBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }

  try {
    // ── Path 1: Native helper (preferred for Resolve — returns real fs path) ──
    // Companion _pick_folder returns { folderPath } (not { path }).
    let nativePath = null;
    try {
      const res = await nativePickFolder('Select Conform Output Folder');
      // Accept both key shapes: folderPath (current companion) and path (fallback)
      nativePath = res?.result?.folderPath || res?.result?.path || null;
      if (!nativePath && res?.error?.code === 'CANCELLED') {
        return; // user clicked Cancel in native dialog — do nothing
      }
    } catch { /* companion not running — fall through to FSAA */ }

    if (nativePath) {
      await _setOutputReady({ kind: 'native', path: nativePath });
      return;
    }

    // ── Path 2: File System Access API fallback ──
    if (typeof window.showDirectoryPicker !== 'function') {
      _setOutputError('Folder picker unavailable. Make sure the PFX companion is running.');
      return;
    }

    let handle;
    try {
      handle = await window.showDirectoryPicker({
        id: 'pfx-trailer-conform-output',
        mode: 'readwrite',
        startIn: 'documents',
      });
    } catch (e) {
      if (e?.name === 'AbortError') return; // user cancelled — do nothing
      throw e;
    }

    // Verify / request readwrite permission on the chosen directory
    let perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      perm = await handle.requestPermission({ mode: 'readwrite' });
    }
    if (perm !== 'granted') {
      _setOutputError('Permission denied for selected folder.');
      return;
    }

    // Persist handle in IDB so we can restore it across page loads
    await _idbSet(_OUT_IDB_HKEY, handle);
    await _setOutputReady({ kind: 'fsaa', label: handle.name, handle });

  } catch (e) {
    _setOutputError(`Folder picker failed: ${e.message || e}`);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 13 13" fill="none" stroke="currentColor" stroke-width="1.3">
        <path d="M1 4h11v7H1V4zM1 4V2.5a1 1 0 011-1h3l1.5 1.5H12V4"/>
      </svg> Choose Folder…`;
    }
  }
}

async function _setOutputReady({ kind = 'native', path = '', label = '', handle = null } = {}) {
  _outputFolder.kind      = kind;
  _outputFolder.path      = path;
  _outputFolder._handle   = handle;
  // Display: prefer full path (native), fall back to folder name (FSAA)
  _outputFolder.label     = label || path || 'Selected folder';
  _outputFolder.permState = 'ready';
  if (path) await _idbSet(_OUT_IDB_KEY, path);
  if (path) await _idbDel(_OUT_IDB_HKEY);
  await _persistTrailerConformSettings();
  _refreshOutputFolderUI();
  _checkReadiness();
}

function _setOutputLost() {
  _outputFolder.permState = 'lost';
  void _persistTrailerConformSettings();
  _refreshOutputFolderUI();
  _checkReadiness();
}

function _setOutputError(msg) {
  _outputFolder.permState = 'error';
  void _persistTrailerConformSettings();
  _refreshOutputFolderUI(msg);
  _checkReadiness();
}

async function _resetOutputFolder() {
  _outputFolder.kind      = 'none';
  _outputFolder.path      = '';
  _outputFolder.label     = '';
  _outputFolder.permState = 'none';
  _outputFolder._handle   = null;
  await _idbDel(_OUT_IDB_KEY);
  await _idbDel(_OUT_IDB_HKEY);
  await _persistTrailerConformSettings();
  _refreshOutputFolderUI();
  _checkReadiness();
}

function _refreshOutputFolderUI(errorMsg = '') {
  const labelEl     = _root?.querySelector('#trcFolderLabel');
  const statusEl    = _root?.querySelector('#trcFolderStatus');
  const reconnectEl = _root?.querySelector('#trcFolderReconnect');
  const openBtn     = _root?.querySelector('#trcOpenFolderBtn');
  if (!labelEl) return;

  const { path, label, permState } = _outputFolder;

  if (permState === 'none') {
    labelEl.textContent = 'No folder selected';
    labelEl.className = 'trc-folder-label';
    if (statusEl) { statusEl.textContent = 'Choose where PFX should save trailer conform results.'; statusEl.className = 'trc-folder-status'; }
    reconnectEl?.classList.add('trc-hidden');
    if (openBtn) openBtn.disabled = true;
    return;
  }

  if (permState === 'ready') {
    labelEl.textContent = path || `${label} (browser-only)`;
    labelEl.title = path || label;
    labelEl.className = 'trc-folder-label trc-folder-label--ready';
    const isNative = _outputFolder.kind === 'native';
    const statusText = isNative
      ? 'Ready'
      : `Ready in browser only. Use the native helper picker for Resolve jobs.`;
    if (statusEl) { statusEl.textContent = statusText; statusEl.className = `trc-folder-status trc-folder-status--${isNative ? 'ready' : 'warn'}`; }
    reconnectEl?.classList.add('trc-hidden');
    if (openBtn) openBtn.disabled = !isNative; // can only Open in Finder with a real path
    return;
  }

  if (permState === 'lost') {
    labelEl.textContent = label || path;
    labelEl.className = 'trc-folder-label trc-folder-label--warn';
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'trc-folder-status'; }
    reconnectEl?.classList.remove('trc-hidden');
    if (openBtn) openBtn.disabled = true;
    return;
  }

  if (permState === 'error') {
    labelEl.textContent = 'Folder error';
    labelEl.className = 'trc-folder-label trc-folder-label--err';
    if (statusEl) { statusEl.textContent = errorMsg || 'Output folder is not writable. Choose another folder.'; statusEl.className = 'trc-folder-status trc-folder-status--err'; }
    reconnectEl?.classList.add('trc-hidden');
    if (openBtn) openBtn.disabled = true;
  }
}

async function _loadSavedOutputFolder() {
  // Try native path first (preferred — works with Resolve)
  const savedPath = await _idbGet(_OUT_IDB_KEY);
  if (savedPath) {
    _outputFolder.kind      = 'native';
    _outputFolder.path      = savedPath;
    _outputFolder.label     = savedPath;
    _outputFolder.permState = 'ready';
    _refreshOutputFolderUI();
    _checkReadiness();
    return;
  }

  const projectSettings = _getProjectSetupSettings();
  const projectSavedPath = projectSettings?.trailerConform?.outputFolderPath || '';
  if (projectSavedPath) {
    _outputFolder.kind      = 'native';
    _outputFolder.path      = projectSavedPath;
    _outputFolder.label     = projectSavedPath;
    // Trust the saved readiness flag. If the previous session ended with the
    // folder not-ready (lost mount, permission revoked, drive unplugged), don't
    // silently mark it as ready on restore — the user needs to reconfirm.
    _outputFolder.permState =
      projectSettings?.trailerConform?.outputFolderReady ? 'ready' : 'lost';
    _refreshOutputFolderUI();
    _checkReadiness();
    return;
  }

  // Try FSAA handle — re-verify permission before marking ready
  const handle = await _idbGet(_OUT_IDB_HKEY);
  if (handle && typeof handle.queryPermission === 'function') {
    try {
      const perm = await handle.queryPermission({ mode: 'readwrite' });
      if (perm === 'granted') {
        _outputFolder.kind      = 'fsaa';
        _outputFolder.path      = '';
        _outputFolder._handle   = handle;
        _outputFolder.label     = handle.name || 'Saved folder';
        _outputFolder.permState = 'ready';
      } else {
        // Permission not auto-granted — mark as lost so reconnect banner shows
        _outputFolder.kind      = 'fsaa';
        _outputFolder.label     = handle.name || 'Saved folder';
        _outputFolder._handle   = handle;
        _outputFolder.permState = 'lost';
      }
    } catch {
      _outputFolder.permState = 'lost';
    }
    _refreshOutputFolderUI();
    _checkReadiness();
  }
}

async function _verifyFolderWritable(path) {
  // Optimistic check — companion will surface a clear error if path is gone or unwritable.
  // A full stat would require a separate companion action; for now trust the stored path
  // and let the conform job fail fast with a clear error if the folder is gone.
  return !!path;
}

function _openOutputInFinder() {
  if (_outputFolder.path) nativeOpenOutputFolder(_outputFolder.path).catch(() => {});
}

async function _useProjectOutput() {
  // Pick a sensible default: ~/Documents/PostFlowX/TrailerConform
  // Open native picker pre-populated to suggest the project default folder.
  const btn = _root?.querySelector('#trcUseProjectBtn');
  if (btn) btn.disabled = true;
  try {
    const res = await nativePickFolder('Select Project Output Folder');
    const p = res?.result?.folderPath || res?.result?.path || null;
    if (res?.ok && p) await _setOutputReady({ kind: 'native', path: p });
  } catch {}
  finally { if (btn) btn.disabled = false; }
}

let _jobCounter = 0;
async function _nextJobNum() {
  const saved = await _idbGet('trc_job_counter') || 0;
  const next = saved + 1;
  await _idbSet('trc_job_counter', next);
  _jobCounter = next;
  return next;
}

// ── Shell wiring ──────────────────────────────────────────────────────────────

function _wireShell() {
  _root.querySelector('#trcResetBtn')?.addEventListener('click', () => {
    if (_STATE.phase !== 'setup' && !confirm('Reset conform session? All unsaved progress will be lost.')) return;
    _resetAll();
  });
}

function _resetAll() {
  _stopPolling();
  Object.assign(_STATE, {
    phase: 'setup', jobId: null, pollTimer: null,
    events: [], proxies: [], matches: [], outputDir: '',
    analysisResult: null, buildResult: null,
    // Clear the cached source-search root too — without this it leaks across
    // sessions and can point auto-resolve at the wrong folder when the user
    // switches projects.
    srcRoot: '',
  });
  _files.edit = null;
  _files.ref  = null;
  _files.src  = [];
  _files.srcFolder = null;
  // Output folder is intentionally preserved across conforms (project-level setting)
  _renderPhase();
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function _formatDur(frames, fps) {
  const secs = frames / Math.max(1, fps);
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  const f = Math.round(frames % Math.max(1, Math.round(fps)));
  return `${m}:${String(s).padStart(2,'0')}+${f}`;
}

function _esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _toast(msg, isErr = false) {
  const t = document.createElement('div');
  t.className = 'pfx-setup-toast' + (isErr ? ' pfx-setup-toast--err' : '');
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => t.classList.add('pfx-setup-toast--visible'));
  setTimeout(() => { t.classList.remove('pfx-setup-toast--visible'); setTimeout(() => t.remove(), 300); }, 2800);
}

// ── Auto-mount ────────────────────────────────────────────────────────────────

document.addEventListener('pfx:tab-activated', e => {
  if (e.detail?.tab === 'trlconf') mountTrailerConform();
});

// Mount immediately if tab is already active
if (document.querySelector('.tab[data-main="trlconf"].active')) {
  mountTrailerConform();
}
