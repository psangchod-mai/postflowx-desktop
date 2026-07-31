// scripts/modules/imf/imf_ui.js
// IMF Validation tab — UI logic
'use strict';

import { parseAssetMap, parsePKL, parseCPL, fmtDuration, fmtFrames } from './imf_parser.js';
import { computeCplResourceDiff } from './imf_timeline_diff.js';
import { mountMediaSearch } from '../../features/mediaSearch/mediaSearchBox.js';
import { validateStructure, validateSchema, verifySHA1, verifyHash, detectHashAlgorithm, SEV } from './imf_validator.js';
import { extractIabAdmLabelQC, inspectIabAdm, inspectIabAdmFromNames, extractAdmProgrammeTree, extractAdmProgrammeTreeFromCompanion } from './imf_iab_labels.js';
import { initIMFPlayer, playerLoadReel, playerSeekToFrame, playerGetState, playerStartProxyMode, playerStopProxyMode, playerSetCompanionThumb, playerGetCompanionThumbKey, playerClearCompanionThumb, playerSetDoviShots, playerToggleTrim, playerToggleHdr, playerSetPreviewMode, playerShowTestFrame, playerGetDecodeInputs, playerSetCompare, playerSetCompareFrame, playerGetCompareState, playerExportCompareStill, audStop } from './imf_player.js';
import { readAudioMXF, extractEmbeddedDoviXml } from './imf_mxf.js';
import { imfPickFolder, imfPickFolderCompanion, imfScanFolderCompanion, imfGenerateProxy, imfRestoreProxyOutput, imfGetCapabilities, imfPingCompanion, imfInspectImmersiveAudio, imfGetDoviMetafier, imfStartIabDecode, imfExtractWaveformPeaks, imfLookupProxy, imfDeleteProxy, setCompanionHttpToken, imfDetectMetafier, imfExtractDoviFromMxf, imfReadExtractedXml } from './imf_proxy.js';
import { parseDoviXml, annotateShots, validateDoviShots, exportDoviXml, buildUuidColorMap, pickSdrTrim, ffmpegTrimFilter, getTrimTargetLabel, isNeutralL8, fmtL8Value, DV_TRIM_TARGETS } from './imf_dovi_metafier.js';
import { analyzeDolbyVisionFromImfPackage, DOVI_STATUS, DOVI_SOURCE, doviStatusLabel, doviStatusSeverity } from './imf_dovi_extractor.js';
import { storeNamedHandle, loadNamedHandle, clearNamedHandle } from '../../core/projectFile.js';
import { friendlyStatus } from '../../core/friendlyError.js';
import { deleteProxyConfirm } from '../../core/confirmText.js';
import { runAllUgChecks } from './imf_ug_checks.js';
import { validateApp2E, parseDeliverySchema, validateAgainstSchema, APP2E_PRESET } from './imf_delivery_schema.js';
import { toCSV as buildReportCSV, toJSON as buildReportJSON } from './imfReport.js';

// ── State ─────────────────────────────────────────────────────────────────────
let _pkg      = null;   // active composition context
let _valResults = [];
let _extFiles = [];
let _extFileMap = new Map();
let _hashVerifying = false;
let _imfHashJobCtl = null;   // active P1-PROGRESS engine hash job controller (for cancel)
let _imfPackages = [];
let _cplEntries = [];
let _currentCplKey = '';
let _baseCplKey = '';
let _showBaseOverlay = false;
let _layerMuted = new Set();   // CPL keys whose comparison row is hidden in the stack
let _layerSolo  = new Set();   // when non-empty, only these inactive CPL rows show
let _imfActiveLeftTab = 'validation';
let _imfViewerMode = 'imf';
let _proxyViewerReady = false;
let _proxySessionRestoring = false;   // guard against concurrent restore attempts
let _lastProxyInfo = { proxyPath: '', fingerprint: '' };  // for Delete Proxy
let _proxyResumeDebugLastKey = '';
let _proxyDebug = {
  stage: 'IDLE',
  branch: 'NONE',
  bridge: 'UNKNOWN',
  sessionId: '',
  outputPath: '',
  probe: '',
  lastEvent: 'IDLE',
  events: [],
};
let _imfSourceDirHandle = null;
let _imfSourceFolderName = '';
let _imfSourceBackend = '';
let _imfSourceFolderPath = '';
let _imfSourcePackageId = '';
// Electron companion-mode decode paths — populated by _ensureElectronReelPaths()
let _imfElectronPackageHash    = '';
let _imfElectronMxfPaths       = new Map(); // trackFileId → reel object with mxfPath
let _imfElectronPrepPromise    = null;      // pending preparePackage promise
let _imfElectronCplPath        = '';        // absolute path to CPL XML (for IMF demuxer)
let _imfElectronAssetMapPaths  = [];        // all ASSETMAP.xml paths (base + supplemental)
let _imfAllPackageFolderPaths  = [];        // all sub-package folders found in drag-drop
let _labelQc = { loading: false, error: '', rows: [], stats: null, root: null, assetName: '', totalRows: 0 };
let _iabDecodeCaps = { loading: false, loaded: false, backend: '', ready: false, iabDecode: false, admDecode: false, admExtract: true, engineId: '', engineLabel: '', userMessage: '', blockers: [], notes: [], error: '', imfDemuxer: false, ffmpegPath: '' };
let _iabDecodeJob = { running: false, loaded: false, state: 'idle', pct: 0, cpl: '—', status: 'Ready to decode IAB', output: '—', jobId: '', artifactPath: '', error: '' };
let _iabWaveformJob = { running: false, jobId: '', artifactPath: '', wavUrl: '', peaks: null, admInfo: null };
let _iabWaveformAudioCtx  = null;  // AudioContext for IAB WAV playback
let _iabWaveformAudioNode = null;  // active AudioBufferSourceNode
let _doviMetafierShots = null;   // annotated shots from last DoVi extraction
let _dvMxfConfirmed    = false;  // true when DV confirmed via ffprobe MXF header (no per-shot data)
let _doviActiveShot   = -1;      // currently selected shot index in Metafier detail panel
// DoVi extraction result from imf_dovi_extractor.js — tracks status across all paths
let _doviExtractResult = null;   // DoviExtractResult | null
let _doviExtractPending = false; // guard against concurrent extraction calls
let _admTree          = null;    // ADM programme tree from extractAdmProgrammeTree
let _admTreeLoading   = false;

// Best Practice / Delivery Schema state
let _customDeliverySchema = null;  // parsed schema from loadDeliverySchema()
let _photonRunning        = false;
// Last raw Photon results (severity/code/message), cached so they can be merged
// into the unified verdict + report. Reset on package load.
let _photonLastResults    = null;

// Proxy audio meter (Web Audio API — real channel levels when proxy plays)
let _proxyAudioCtx    = null;
let _proxyAudioSrc    = null;
let _proxyAudioAnalysers = [];
let _proxyMeterRafId  = null;

// ── Waveform strip ────────────────────────────────────────────────────────────
let _audioCtx       = null;
let _analyser       = null;
let _wfAnimId       = null;
let _wfAudioMode    = '';   // last audioMode used to render track chips
let _wfPlayHandler  = null; // stored ref so _teardownWaveform can remove it
let _wfVideoEl      = null; // element that owns the _wfPlayHandler listener

// ── Audio preview (reel-table play buttons) ───────────────────────────────────
let _audioPreviewCtx  = null;   // AudioContext for audio preview
let _audioPreviewNode = null;   // active AudioBufferSourceNode
let _audioPreviewBtn  = null;   // <td> element currently in stop-state

let _imfProjectNameWireBound = false;
const _tlNav = { totalFrames:1, fps:24, zoom:1, pan:0, playheadAbs:0, reelRanges:[], bindingsReady:false, consumeClick:false };
let _tlOuterWidth = 0; // cached track width — updated only by ResizeObserver, never on every frame
let _tlResizeObserver = null;

// ── Color palette for timeline track segments ─────────────────────────────────
const TRACK_COLORS = [
  '#4f6fd6','#3a9d63','#5a8ac7','#4e8c6e','#6a7dc8',
  '#3d8c8c','#5577bb','#4a9e75','#6080c0','#3c8a78',
  '#5a90d0','#4aad80','#668ad0','#3d7a6a','#5588c8','#4a8c70',
];

const segmentColor = (index = 0) => TRACK_COLORS[Math.abs(index) % TRACK_COLORS.length];

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = (tag, cls, html = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};
const relPathOf = f => String((f && (f.__pfxRelPath || f.webkitRelativePath || f.relativePath || f.name)) || '');
const _imfSafeClone = (v) => {
  try { return structuredClone(v); } catch {}
  try { return JSON.parse(JSON.stringify(v)); } catch {}
  return null;
};
const _proxyDebugStorageKey = 'pfx_imf_proxy_debug';
const _proxyDebugTrim = (value = '', max = 96) => {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
};
const _proxyDebugShortPath = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return '—';
  const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : raw;
};
function _renderProxyDebug() {
  const stageEl = $('imfProxyDebugStage');
  const branchEl = $('imfProxyDebugBranch');
  const bridgeEl = $('imfProxyDebugBridge');
  const sessionEl = $('imfProxyDebugSession');
  const outputEl = $('imfProxyDebugOutput');
  const probeEl = $('imfProxyDebugProbe');
  const lastEl = $('imfProxyDebugLast');
  const logEl = $('imfProxyDebugLog');
  if (stageEl) stageEl.textContent = _proxyDebugTrim(_proxyDebug.stage || 'IDLE', 120);
  if (branchEl) branchEl.textContent = _proxyDebugTrim(_proxyDebug.branch || 'NONE', 120);
  if (bridgeEl) bridgeEl.textContent = `BRIDGE · ${_proxyDebugTrim(_proxyDebug.bridge || 'UNKNOWN', 40)}`;
  if (sessionEl) sessionEl.textContent = _proxyDebugTrim(_proxyDebug.sessionId || '—', 56);
  if (outputEl) outputEl.textContent = _proxyDebugShortPath(_proxyDebug.outputPath || '');
  if (probeEl) probeEl.textContent = _proxyDebugTrim(_proxyDebug.probe || '—', 72);
  if (lastEl) lastEl.textContent = _proxyDebugTrim(_proxyDebug.lastEvent || '—', 120);
  if (logEl) logEl.textContent = Array.isArray(_proxyDebug.events) && _proxyDebug.events.length ? _proxyDebug.events.join('\n') : 'No debug events yet.';
  try { window.__PFX_IMF_PROXY_DEBUG = _imfSafeClone(_proxyDebug) || _proxyDebug; } catch {}
}
function _saveProxyDebug() {
  try { localStorage.setItem(_proxyDebugStorageKey, JSON.stringify(_proxyDebug)); } catch {}
}
function _loadProxyDebug() {
  try {
    const raw = localStorage.getItem(_proxyDebugStorageKey);
    if (!raw) return;
    const parsed = JSON.parse(raw) || {};
    if (parsed && typeof parsed === 'object') _proxyDebug = { ..._proxyDebug, ...parsed, events: Array.isArray(parsed.events) ? parsed.events.slice(0, 12) : [] };
  } catch {}
  _renderProxyDebug();
}
function _proxyDebugMark(stage, detail = '', patch = {}) {
  try {
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    const entry = detail ? `${stamp} ${stage} :: ${detail}` : `${stamp} ${stage}`;
    _proxyDebug = {
      ..._proxyDebug,
      ...patch,
      stage: String(stage || _proxyDebug.stage || 'IDLE'),
      lastEvent: entry,
      events: [entry, ...(_proxyDebug.events || [])].slice(0, 12),
    };
    _saveProxyDebug();
    _renderProxyDebug();
  } catch {}
}
async function _proxyDebugFetchBridgeState(reason = '') {
  try {
    const bg = await chrome.runtime.sendMessage({ type: 'IMF_PROXY_DEBUG_GET' });
    const debug = bg?.debug || {};
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    const detail = reason || String(debug.lastEvent || '').trim() || 'bridge snapshot';
    const entry = `${stamp} BRIDGE :: ${detail} => ${String(debug.route || 'UNKNOWN').toUpperCase()}`;
    _proxyDebug = {
      ..._proxyDebug,
      bridge: String(debug.route || _proxyDebug.bridge || 'UNKNOWN').toUpperCase(),
      lastEvent: entry,
      events: [entry, ...(_proxyDebug.events || [])].slice(0, 12),
    };
    _saveProxyDebug();
    _renderProxyDebug();
  } catch (err) {
    _proxyDebugMark(_proxyDebug.stage || 'IDLE', `bridge fetch failed · ${err?.message || String(err)}`, { bridge: 'UNKNOWN' });
  }
}

const _imfProjectName = () => {
  try {
    return String(document.getElementById('projectNameGlobal')?.value || window.__MPS_PROJECT_NAME || '').trim();
  } catch {
    return '';
  }
};
const _imfProjectKey = (name = _imfProjectName()) => String(name || 'Project')
  .trim()
  .replace(/\s+/g, '_')
  .replace(/[^a-zA-Z0-9._-]/g, '_')
  .replace(/_+/g, '_')
  .replace(/^_+|_+$/g, '') || 'Project';
const _imfHandleKey = (name = _imfProjectName()) => `imf.folder.${_imfProjectKey(name)}`;
const _isIabResource = (cpl, res) => {
  if (!cpl || !res) return false;
  // Immersive sequences: IAB (ST 2067-201) or MGA (ST 2127).
  if (/iab|mga/i.test(String(res.seqType || ''))) return true;
  const descId = String(res.essenceDescriptorId || '');
  return Array.isArray(cpl.descriptors) &&
    cpl.descriptors.some(d => (d?.isImmersive ?? (d?.isIAB || d?.isMGA)) && String(d.id || '') === descId);
};
// Label the immersive carriage accurately (IAB vs MGA Atmos).
const _immersiveLabel = (cpl, res) => {
  const descId = String(res?.essenceDescriptorId || '');
  const d = Array.isArray(cpl?.descriptors) ? cpl.descriptors.find(x => String(x.id || '') === descId) : null;
  if (d?.isMGA || /mga/i.test(String(res?.seqType || ''))) return 'MGA Atmos (Immersive)';
  return 'IAB (Dolby Atmos)';
};
const _resourceKind = (cpl, res) => {
  if (!res) return 'Unknown';
  if (res.seqType === 'MainImageSequence' || String(res.seqType || '').includes('Image')) return 'Picture';
  if (_isIabResource(cpl, res)) return _immersiveLabel(cpl, res);
  return 'Audio';
};

function _defaultIabDecodeCaps(extra = {}) {
  return {
    loading: false,
    loaded: false,
    backend: '',
    ready: false,
    iabDecode: false,
    admDecode: false,
    admExtract: true,
    engineId: '',
    engineLabel: '',
    userMessage: '',
    blockers: [],
    notes: [],
    error: '',
    imfDemuxer: false,
    ffmpegPath: '',
    ...extra,
  };
}

function _normalizeIabDecodeCaps(raw = {}, backend = '') {
  return _defaultIabDecodeCaps({
    loaded: true,
    backend: backend || '',
    ready: !!raw.ready,
    iabDecode: !!raw.iabDecode,
    admDecode: !!raw.admDecode,
    admExtract: raw.admExtract !== false,
    engineId: String(raw.engineId || ''),
    engineLabel: String(raw.engineLabel || ''),
    userMessage: String(raw.userMessage || ''),
    blockers: Array.isArray(raw.blockers) ? raw.blockers.filter(Boolean).map(String) : [],
    notes: Array.isArray(raw.notes) ? raw.notes.filter(Boolean).map(String) : [],
    error: String(raw.error || ''),
    imfDemuxer: !!raw.imfDemuxer,
    ffmpegPath: String(raw.ffmpegPath || ''),
  });
}

function _updateProxyPanelNote() {
  const note = $('imfProxyNote');
  if (!note) return;
  const id = _iabDecodeCaps.engineId || '';
  if (id === 'resolve-engine') {
    note.textContent = 'Generate uses Resolve Engine to decode IAB / Dolby Atmos and render the proxy with correct color science. Ensure DaVinci Resolve Studio is running.';
  } else if (id === 'ffmpeg-immersive') {
    note.textContent = 'Generate transcodes the IMF package into a Rec.709 H.264 proxy and downmixes IAB / Dolby Atmos to stereo via ffmpeg.';
  } else {
    note.textContent = 'Click Generate to transcode the IMF package into a Rec.709 H.264 proxy and downmix IAB / Dolby Atmos audio to stereo.';
  }
  // Update Resolve Proxy button status indicator
  const resolveStatus = $('imfResolveStatus');
  if (resolveStatus) {
    if (id === 'resolve-engine' && _iabDecodeCaps.ready) {
      resolveStatus.textContent = '● Connected';
      resolveStatus.dataset.state = 'connected';
    } else {
      resolveStatus.textContent = '● —';
      resolveStatus.dataset.state = 'disconnected';
    }
  }
}

function _iabDecodeSummary() {
  if (_iabDecodeCaps.loading) return 'Checking decode engine…';
  if (_iabDecodeCaps.ready) {
    const id    = _iabDecodeCaps.engineId    || '';
    const label = _iabDecodeCaps.engineLabel || id || 'local engine';
    if (id === 'resolve-engine') return `Resolve Engine — IAB / Dolby Atmos`;
    if (id === 'ffmpeg-immersive') return `ffmpeg IAB decoder`;
    return `Ready via ${label}`;
  }
  return _iabDecodeCaps.userMessage || 'No IAB decoder available.';
}

function _iabDecodeDetail() {
  const bits = [];
  if (_iabDecodeCaps.error) bits.push(_iabDecodeCaps.error);
  if (_iabDecodeCaps.blockers?.length) bits.push(_iabDecodeCaps.blockers.join(' · '));
  if (_iabDecodeCaps.notes?.length) bits.push(_iabDecodeCaps.notes.join(' · '));
  return bits.filter(Boolean).join(' · ');
}

function _setIabDecodeState({ mode = 'idle', pct = 0, status = '', cpl = null, output = null, jobId = null, artifactPath = null, error = null } = {}) {
  _iabDecodeJob = {
    ..._iabDecodeJob,
    loaded: true,
    running: mode === 'running',
    state: mode,
    pct: Math.max(0, Math.min(100, pct || 0)),
    status: status || _iabDecodeJob.status,
    cpl: cpl == null ? _iabDecodeJob.cpl : (cpl || '—'),
    output: output == null ? _iabDecodeJob.output : (output || '—'),
    jobId: jobId == null ? _iabDecodeJob.jobId : String(jobId || ''),
    artifactPath: artifactPath == null ? _iabDecodeJob.artifactPath : String(artifactPath || ''),
    error: error == null ? _iabDecodeJob.error : String(error || ''),
  };
  const stateEl = $('imfIabPanelState');
  const pctEl = $('imfIabPanelPct');
  const barEl = $('imfIabPanelBar');
  const cplEl = $('imfIabPanelCpl');
  const statusEl = $('imfIabPanelStatus');
  const outputEl = $('imfIabPanelOutput');
  if (stateEl) {
    stateEl.textContent = mode === 'running' ? 'Running' : mode === 'done' ? 'Done' : mode === 'error' ? 'Error' : 'Idle';
    stateEl.dataset.state = mode;
  }
  if (pctEl) pctEl.textContent = `${Math.round(_iabDecodeJob.pct)}%`;
  if (barEl) barEl.style.width = `${_iabDecodeJob.pct}%`;
  if (cplEl) cplEl.textContent = _iabDecodeJob.cpl || '—';
  if (statusEl) statusEl.textContent = _iabDecodeJob.status || '—';
  if (outputEl) outputEl.textContent = _iabDecodeJob.output || '—';
}

function _resetIabDecodeUI() {
  _iabDecodeJob = { running: false, loaded: false, state: 'idle', pct: 0, cpl: '—', status: 'Ready to inspect IAB audio', output: '—', jobId: '', artifactPath: '', error: '' };
  _setIabDecodeState({ mode: 'idle', pct: 0, status: 'Ready to inspect IAB audio', cpl: '—', output: '—', jobId: '', artifactPath: '', error: '' });
  // Hide detail rows populated by _renderIabInspectionResult
  ['imfIabPanelTrack','imfIabPanelProgramme','imfIabPanelObjects','imfIabPanelGroups','imfIabPanelLabelQC','imfIabPanelAdmStats','imfIabPanelProfile','imfIabPanelNamedObjs','imfIabPanelRenderTargets'].forEach(id => {
    const e = $(id); if (!e) return;
    const row = e.closest?.('.imf-proxy-meta-row');
    if (row) row.style.display = 'none';
  });
  const exportBtn = $('imfIabExportAdmBtn');
  if (exportBtn) { exportBtn.style.display = 'none'; exportBtn._admXml = ''; exportBtn._admName = ''; }

  _stopIabWaveformPlayback();
  _iabWaveformJob = { running: false, jobId: '', artifactPath: '', wavUrl: '', peaks: null, admInfo: null };
  const waveformSection = $('imfIabWaveformSection');
  if (waveformSection) waveformSection.style.display = 'none';
  const decodeWaveformBtn = $('imfIabDecodeWaveformBtn');
  if (decodeWaveformBtn) { decodeWaveformBtn.style.display = 'none'; decodeWaveformBtn.disabled = false; decodeWaveformBtn.textContent = '▶ Decode & Waveform'; }
}

// ── ADM Programme Tree ────────────────────────────────────────────────────────

async function _refreshAdmTree() {
  if (!_pkg?.cpl?.hasIAB) { _admTree = null; _renderNetflixCompliance(); return; }
  const iabResources = Array.isArray(_pkg.cpl.iabResources) && _pkg.cpl.iabResources.length
    ? _pkg.cpl.iabResources
    : (_pkg.cpl.audioResources || []).filter(res => _isIabResource(_pkg.cpl, res));
  const firstIab = iabResources[0];
  const asset = firstIab ? getAssetMetaById(firstIab.trackFileId) : null;
  const file  = asset ? _pkg.resolveFile(asset) || _pkg.resolveFile(firstIab.trackFileId) : null;

  if (file && typeof file.slice === 'function') {
    _admTreeLoading = true;
    try {
      _admTree = await extractAdmProgrammeTree(file);
    } catch { _admTree = null; }
    _admTreeLoading = false;
  } else if (_imfSourceBackend === 'companion' && _imfSourcePackageId && _pkg.cpl?.id) {
    try {
      const info = await imfInspectImmersiveAudio(_imfSourcePackageId, _pkg.cpl.id);
      if (info) _admTree = extractAdmProgrammeTreeFromCompanion(info);
    } catch { _admTree = null; }
  }
  _renderNetflixCompliance();
  _renderAdmTreePanel();
}

function _renderAdmTreePanel() {
  const panel = $('imfAdmTreePanel');
  if (!panel) return;
  const tree = _admTree;
  if (!tree) { panel.style.display = 'none'; return; }
  panel.style.display = '';

  const bedHtml = tree.is51 || tree.is71 ? (() => {
    const chLabels = tree.bedChannels.length
      ? tree.bedChannels
      : (tree.is71 ? ['L','R','C','LFE','Ls','Rs','Lss','Rss'] : ['L','R','C','LFE','Ls','Rs']);
    return `<div class="imf-adm-bed">
      <span class="imf-adm-bed-label">${tree.is71 ? '7.1' : '5.1'} Bed</span>
      <div class="imf-adm-channels">${chLabels.map(ch => `<span class="imf-adm-ch">${ch}</span>`).join('')}</div>
    </div>`;
  })() : '';

  const atmosHtml = tree.isAtmos && tree.objectCount > 0
    ? `<div class="imf-adm-objects"><span class="imf-adm-obj-badge">${tree.objectCount} Atmos Object${tree.objectCount !== 1 ? 's' : ''}</span></div>`
    : '';

  const progHtml = tree.programmes.length
    ? `<div class="imf-adm-prog">${tree.programmes.map(p => `<span class="imf-adm-prog-name">${String(p).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</span>`).join('')}</div>`
    : '';

  panel.innerHTML = `
    <div class="imf-adm-tree-inner">
      ${progHtml}
      ${bedHtml}
      ${atmosHtml}
      ${!bedHtml && !atmosHtml ? '<span style="color:#555;font-size:10px">ADM structure loaded</span>' : ''}
    </div>`;
}

// ── Netflix Delivery Compliance ───────────────────────────────────────────────

function _buildNetflixCompliance() {
  const cpl = _pkg?.cpl;
  if (!cpl) return [];

  const checks = [];
  const ok   = (label, detail = '') => ({ label, state: 'pass', detail });
  const warn = (label, detail = '') => ({ label, state: 'warn', detail });
  const fail = (label, detail = '') => ({ label, state: 'fail', detail });

  const hasDV = !!(cpl.isDolbyVision || _doviMetafierShots?.length || _dvMxfConfirmed);

  // ── DV Profile (Netflix IMF requires Profile 8) ──────────────────────────
  if (hasDV) {
    const dvp = cpl.dvProfile ?? (cpl.descriptors || []).find(d => d.isDVision)?.dvProfile;
    if (dvp != null) {
      checks.push(dvp === 8 || dvp === '8'
        ? ok(`DV P${dvp}`, 'Profile 8 (IMF standard)')
        : warn(`DV P${dvp}`, 'Netflix IMF typically requires Profile 8'));
    } else {
      checks.push(warn('DV Profile', 'Profile not detected in descriptor'));
    }

    // ── L8 SDR 100-nit trim (target index 27) — full coverage check ──────
    if (_doviMetafierShots?.length) {
      const contentShots = _doviMetafierShots.filter(s => !s.isTransition);
      const _hasTarget27 = s => {
        const tps = s.trimPasses || [];
        const l8s = Array.isArray(s.l8) ? s.l8 : (s.l8 ? [s.l8] : []);
        return tps.some(tp => tp.target === 27 || tp.levels?.l8?.targetDisplayIndex === 27)
            || l8s.some(l => l.targetDisplayIndex === 27);
      };
      const withTrim27 = contentShots.filter(_hasTarget27);
      if (withTrim27.length === 0) {
        checks.push(fail('L8 SDR Trim', 'No SDR 100-nit trim (target 27) found in CM XML'));
      } else if (withTrim27.length < contentShots.length) {
        checks.push(warn(`L8 SDR Trim ${withTrim27.length}/${contentShots.length}`,
          `Target 27 missing on ${contentShots.length - withTrim27.length} content shot(s)`));
      } else {
        checks.push(ok(`L8 SDR Trim ✓`, `All ${contentShots.length} content shots have target 27`));
      }

      // ── Crushed blacks across content shots ──────────────────────────────
      const crushedCount = contentShots.filter(s => s.l1?.minPq != null && s.l1.minPq > 0 && s.l1.minPq < 64).length;
      if (crushedCount > 0) {
        checks.push(warn(`Crushed Blacks (${crushedCount})`,
          `${crushedCount} shot(s) with L1MinPq below broadcast black (64 PQ)`));
      }

      // ── L1 peak above canvas ─────────────────────────────────────────────
      const clippedCount = contentShots.filter(s =>
        s.l1?.maxNits != null && s.l6?.maxMasteringLuminance != null &&
        s.l1.maxNits > s.l6.maxMasteringLuminance * 1.01
      ).length;
      if (clippedCount > 0) {
        checks.push(fail(`L1 > Canvas (${clippedCount})`,
          `${clippedCount} shot(s) with L1 peak above mastering canvas`));
      }
    }

    // ── Black level ────────────────────────────────────────────────────────
    // Black level = 64 is Netflix standard; visible in CM XML export header
    // We can only check this if a CM XML was loaded — best-effort
  }

  // ── MaxCLL / MaxFALL ──────────────────────────────────────────────────────
  const _metaL6 = _doviMetafierShots?.find?.(s => s.l6)?.l6 || {};
  const descL6  = (cpl.descriptors || []).find(d => d.maxCLL != null || d.masteringMaxLum != null);
  const maxCLL  = _metaL6.maxContentLightLevel   ?? descL6?.maxCLL           ?? null;
  const maxFALL = _metaL6.maxFrameAverageLightLevel ?? descL6?.maxFALL        ?? null;
  const mastMax = _metaL6.maxMasteringLuminance   ?? descL6?.masteringMaxLum  ?? null;

  if (mastMax != null) {
    checks.push(mastMax <= 4000
      ? ok(`Mast. ${mastMax} nits`, 'Mastering display within typical range')
      : warn(`Mast. ${mastMax} nits`, 'Mastering display above 4000 nits'));
  }
  if (maxCLL != null) {
    checks.push(maxCLL <= 10000
      ? ok(`MaxCLL ${maxCLL}`, '≤10,000 nit limit')
      : fail(`MaxCLL ${maxCLL}`, 'Exceeds 10,000 nit ceiling'));
  }
  if (maxFALL != null) {
    checks.push(maxFALL <= 1300
      ? ok(`MaxFALL ${maxFALL}`, 'Within typical 1,300 nit guideline')
      : maxFALL <= 4000
        ? warn(`MaxFALL ${maxFALL}`, 'Above typical 1,300 nit guideline')
        : fail(`MaxFALL ${maxFALL}`, 'Very high MaxFALL'));
  }

  // ── IAB label QC ─────────────────────────────────────────────────────────
  if (cpl.hasIAB) {
    const counts = _labelCounts(_labelQc.rows);
    if (counts.total > 0) {
      checks.push(counts.reject === 0
        ? ok(`Labels OK`, `${counts.pass} pass · ${counts.warn} ignored`)
        : fail(`Labels ${counts.reject} ✗`, `${counts.reject} IAB label(s) need renaming`));
    }

    // ── ADM bed / object layout ───────────────────────────────────────────
    if (_admTree) {
      if (_admTree.is71) {
        checks.push(ok('7.1 Bed', _admTree.bedChannels.join(' · ')));
      } else if (_admTree.is51) {
        checks.push(ok('5.1 Bed', _admTree.bedChannels.join(' · ')));
      }
      if (_admTree.isAtmos && _admTree.objectCount > 0) {
        checks.push(ok(`${_admTree.objectCount} Obj`, 'Atmos objects present'));
      }
    }
  }

  // ── Transfer function ─────────────────────────────────────────────────────
  const isPq = /PQ|2084/i.test(cpl.transfer || '');
  const is2020 = /2020|BT\.2020/i.test(cpl.primaries || '');
  if (isPq && is2020) {
    checks.push(ok('PQ/BT.2020', 'HDR10-compatible master'));
  } else if (isPq) {
    checks.push(warn('PQ/non-2020', `Primaries: ${cpl.primaries || '?'}`));
  }

  return checks;
}

function _renderNetflixCompliance() {
  const panel = $('imfNetflixCheck');
  if (!panel) return;
  const checks = _buildNetflixCompliance();
  if (!checks.length) { panel.style.display = 'none'; return; }
  panel.style.display = '';
  const hasIssue = checks.some(c => c.state === 'fail');
  const hasWarn  = checks.some(c => c.state === 'warn');
  const overall  = hasIssue ? 'fail' : hasWarn ? 'warn' : 'pass';
  panel.innerHTML = `
    <div class="imf-nx-header">
      <span class="imf-nx-label">NETFLIX CHECK</span>
      <span class="imf-nx-overall imf-nx-overall-${overall}">${overall === 'pass' ? '✓ PASS' : overall === 'warn' ? '⚠ REVIEW' : '✗ ISSUES'}</span>
    </div>
    <div class="imf-nx-chips">
      ${checks.map(c => `<span class="imf-nx-chip imf-nx-chip-${c.state}" title="${String(c.detail).replace(/"/g,'&quot;')}">${c.label}</span>`).join('')}
    </div>`;
}

// ── Proxy audio meter (real channel levels via Web Audio API) ─────────────────

function _startProxyAudioMeter(videoEl) {
  if (_proxyAudioCtx || !videoEl) return;
  const meterEl = $('imfProxyAudioMeter');
  const canvasEl = $('imfSovAudio');
  try {
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(videoEl);  // throws InvalidStateError on re-attach
    src.connect(ctx.destination);
    const chCount = Math.min(6, videoEl.mozChannels || 2);
    const splitter = ctx.createChannelSplitter(chCount);
    src.connect(splitter);
    const analysers = [];
    for (let ch = 0; ch < chCount; ch++) {
      const an = ctx.createAnalyser();
      an.fftSize = 256;
      an.smoothingTimeConstant = 0.65;
      splitter.connect(an, ch, 0);
      analysers.push(an);
    }
    // All nodes created successfully — commit to state
    _proxyAudioCtx = ctx;
    _proxyAudioSrc = src;
    _proxyAudioAnalysers = analysers;
    if (meterEl) meterEl.style.display = 'flex';
    if (canvasEl) canvasEl.style.display = 'none';
    _tickProxyMeter();
  } catch {
    // createMediaElementSource throws on re-attach; meter unavailable — leave canvas visible
  }
}

function _stopProxyAudioMeter() {
  if (_proxyMeterRafId) { cancelAnimationFrame(_proxyMeterRafId); _proxyMeterRafId = null; }
  if (_proxyAudioCtx) { try { _proxyAudioCtx.close(); } catch {} _proxyAudioCtx = null; }
  _proxyAudioSrc = null;
  _proxyAudioAnalysers = [];
  _renderProxyAudioMeter([]);
  const meterEl = $('imfProxyAudioMeter');
  const canvasEl = $('imfSovAudio');
  if (meterEl) meterEl.style.display = 'none';
  if (canvasEl) canvasEl.style.display = '';
}

function _tickProxyMeter() {
  if (!_proxyAudioCtx) return;
  const buf = new Float32Array(128);
  const levels = _proxyAudioAnalysers.map(an => {
    an.getFloatTimeDomainData(buf);
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    return Math.sqrt(rms / buf.length);
  });
  _renderProxyAudioMeter(levels);
  _proxyMeterRafId = requestAnimationFrame(_tickProxyMeter);
}

const _METER_CH_LABELS = ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'];

function _renderProxyAudioMeter(levels) {
  const panel = $('imfProxyAudioMeter');
  if (!panel) return;
  if (!levels.length) { panel.innerHTML = ''; return; }
  panel.innerHTML = levels.map((lv, i) => {
    const pct = Math.min(100, Math.round(lv * 800));
    const cls = lv > 0.9 ? 'clip' : lv > 0.6 ? 'hot' : 'ok';
    return `<div class="imf-meter-ch">
      <div class="imf-meter-bar-wrap"><div class="imf-meter-bar imf-meter-${cls}" style="height:${pct}%"></div></div>
      <div class="imf-meter-label">${_METER_CH_LABELS[i] || i + 1}</div>
    </div>`;
  }).join('');
}

async function _refreshIabDecodeCaps() {
  if (!_pkg?.cpl?.hasIAB) {
    _iabDecodeCaps = _defaultIabDecodeCaps();
    _setIabDecodeState({ mode: 'idle', pct: 0, status: 'This CPL has no IAB / Dolby Atmos track.', cpl: _pkg?.cpl?.contentTitle || _pkg?.cpl?.annotation || _pkg?.cpl?.id || '—', output: '—' });
    _admTree = null;
    if (_pkg?.cpl) renderKPI();
    renderLabelQC();
    _refreshValidationResults();
    _renderNetflixCompliance();
    return;
  }
  _iabDecodeCaps = _defaultIabDecodeCaps({ loading: true });
  renderKPI();
  renderLabelQC();
  _refreshValidationResults();
  // Auto-extract ADM tree in background — no drag-drop required
  _refreshAdmTree().catch(() => {});
  try {
    const caps = await imfGetCapabilities();
    // Propagate the companion's HTTP token so all subsequent HTTP polls include it.
    if (caps?.httpToken) setCompanionHttpToken(caps.httpToken);
    // Also store in a well-known global for non-module callers (ui.js resolve_path).
    if (caps?.httpToken) try { window.__pfxCompanionHttpToken = caps.httpToken; } catch {}
    _iabDecodeCaps = _normalizeIabDecodeCaps(caps?.immersiveAudio || {}, caps?.backend || '');
    // Update the transcode panel note to reflect the active decode engine
    _updateProxyPanelNote();
  } catch (err) {
    _iabDecodeCaps = _defaultIabDecodeCaps({
      loaded: true,
      error: String(err?.message || err || 'Could not query local IAB decode capability'),
      userMessage: 'Could not query local IAB decode capability.',
      blockers: ['Native IMF companion did not respond with immersive-audio capability'],
      notes: ['Embedded ADM / AXML inspection still works inside PostFlowX'],
    });
  }
  renderKPI();
  renderLabelQC();
  _refreshValidationResults();
}


function setImfLeftTab(which = 'validation') {
  const PANELS = {
    validation:   'imfLtabValidation',
    labels:       'imfLtabLabels',
    reels:        'imfLtabReels',
    transcode:    'imfLtabTranscode',
    bestpractice: 'imfLtabBestPractice',
    settings:     'imfLtabSettings',
  };
  _imfActiveLeftTab = PANELS[which] ? which : 'validation';
  document.querySelectorAll('.imf-left-tab').forEach(t => {
    t.classList.toggle('imf-left-tab-active', t.dataset.ltab === _imfActiveLeftTab);
  });
  Object.entries(PANELS).forEach(([key, id]) => {
    const panel = $(id);
    if (panel) panel.style.display = key === _imfActiveLeftTab ? 'flex' : 'none';
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────
export function initIMFTab() {
  _loadProxyDebug();
  _proxyDebugMark('INIT', 'IMF tab boot');
  _proxyDebugFetchBridgeState('tab boot');
  wireDropZone();
  wireBrowseBtn();
  wireRelinkBtn();
  wireCompositionControls();
  wireHashBtn();
  wireExportBtn();
  wireClearBtn();
  wireLabelFilters();
  _wireValFilters();
  wireReelTabs();
  wirePkgAccordion();
  // PFXMAC Sprint 3 — media-library search box in the Assets panel (queries the
  // native SQLite DB the scanner populates). Self-contained + desktop-only.
  try { mountMediaSearch($('imfSecAssets')); } catch {}
  wireTimelineControls();
  wireViewerSwitch();
  wireProjectNameSync();
  registerProjectHooks();
  initIMFPlayer();
  // Companion-mode thumbnail refresh triggered by FULL scale button in player
  document.addEventListener('imf:companion-thumb-refresh', (e) => {
    if (!_pkg?.cpl) return;
    // Include previewMode in the cache key so a mode change always fetches a fresh thumb.
    const mode = String(e.detail?.previewMode || '');
    if (mode) {
      _companionThumbLastKey = '';  // bust duplicate guard for mode change
      _companionThumbMode = mode;   // remember for scroll handlers
    }
    _tryCompanionFrameThumb(_pkg.cpl, e.detail?.frame ?? -1, mode);
  });
  wireProxyQC();
  _wireIabMainTab();
  _wireDoviMetafierConfig();
  // Proactive Metafier detection — shows status without user clicking anything
  imfDetectMetafier(_loadMetafierPath() || undefined).then(info => {
    if (info?.found) {
      if (window.PFX_DEBUG_DOVI) console.log('[PFX DoVi] Metafier found:', info.path, info.version);
      // Pre-fill path if auto-detected
      const inp = document.getElementById('settingsMetafierPath');
      if (inp && !inp.value) { inp.value = info.path; _saveMetafierPath(info.path); }
      const inp2 = document.getElementById('imfDoviMetafierPathInput');
      if (inp2 && !inp2.value) inp2.value = info.path;
    } else {
      if (window.PFX_DEBUG_DOVI) console.log('[PFX DoVi] Metafier not found at standard paths');
    }
  }).catch(() => {});
  _resetIabDecodeUI();
  // Fallback: if no project state fires within 1.5 s, try restoring the proxy directly
  setTimeout(() => { if (!_proxyViewerReady) _tryRestoreProxySession(); }, 1500);

  // Register with Render Queue
  window.__rqExportHandlers = window.__rqExportHandlers || {};
  window.__rqExportHandlers['imf'] = async (fmt) => {
    if (fmt === 'report') await exportReport();
  };

  // Wire Settings page — IMF / Dolby Vision card
  _wireImfDoviSettings();
  _wireBestPracticeTab();
  _wireEngineStatus();
  // Smart Playback Engine settings panel + DaVinci Resolve Media Engine panel
  import('../smart_engine_settings.js').then((m) => {
    m.init();
    // Mount the Resolve Media Engine status panel directly below #smartEnginePanel.
    return import('../resolve_engine_panel.js').then((rp) => rp.mountResolveEnginePanel());
  }).catch((e) => {
    console.warn('[IMF] smart_engine_settings/resolve_engine_panel init failed:', e.message);
  });
  // NLE redesign wires
  _wireTopTabNav();
  _wireAssetTypeTabs();
  _wireScopeModeTabsRight();
  _wireMetaTabs();
  // Wire 📂 / + buttons in Packages panel using native Electron dialog + IPC file listing.
  // showDirectoryPicker is unreliable in Electron with webSecurity:true and no FSA permission
  // handler, so we bypass it entirely: pickFolder() opens the native dialog (no user-gesture
  // requirement), listFolder() recursively walks the folder via Node.js, then we create real
  // File objects and feed them to loadFromFileList (which uses the full JS parseCPL).
  const _pkgOpenBtn = document.getElementById('imfPkgOpenBtn');
  const _pkgAddBtn  = document.getElementById('imfPkgAddBtn');
  // Open an IMF package from a known folder path (no picker). Shared by the
  // Open/Add buttons and exposed as window.__pfxImfOpenPath for automation/testing.
  const _openImfFolderPath = async (folderPath) => {
    if (!folderPath) return { ok: false, reason: 'no_path' };
    const entries = await window.pfxPlatform?.imf?.listFolder?.(folderPath);
    if (!entries?.length) { setStatus('error', 'No files found in selected folder'); return { ok: false, reason: 'empty' }; }
    const folderName = String(folderPath).replace(/\\/g, '/').split('/').filter(Boolean).pop() || 'Package';
    const files = await Promise.all(entries.map(async ({ name, relativePath, absolutePath }) => {
      const isXml = /\.xml$/i.test(name);
      const text  = isXml ? (await window.pfxPlatform.readFile({ filePath: absolutePath }) || '') : '';
      const file  = new File([text], name, { type: isXml ? 'text/xml' : '' });
      try { Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true }); } catch {}
      try { Object.defineProperty(file, '__pfxRelPath',        { value: relativePath, configurable: true }); } catch {}
      // Stamp the real on-disk path. Synthetic File objects (non-XML essence is loaded
      // as an empty blob) have no native path via webUtils.getPathForFile, so without this
      // the Electron IMF demuxer / per-MXF decode can't resolve the MXF → no decoded pixels.
      try { Object.defineProperty(file, '__pfxNativePath',     { value: absolutePath, configurable: true }); } catch {}
      return file;
    }));
    await loadFromFileList(files, { sourceFolderName: folderName });
    return { ok: true, cpls: (_cplEntries || []).length };
  };
  try { window.__pfxImfOpenPath = _openImfFolderPath; } catch {}

  const _doImfPkgOpen = async () => {
    try {
      const folderPath = await window.pfxPlatform?.pickFolder?.({ title: 'Select IMF Package Folder' });
      if (!folderPath) return;
      await _openImfFolderPath(folderPath);
    } catch (err) {
      setStatus('error', 'Load failed: ' + err.message);
      showPanel('imfPanelMain');
      console.error('[IMF pkg open]', err);
    }
  };
  if (_pkgOpenBtn) _pkgOpenBtn.onclick = _doImfPkgOpen;
  if (_pkgAddBtn)  _pkgAddBtn.onclick  = _doImfPkgOpen;
  // Skip the drop-zone step — show the 3-col layout immediately
  showPanel('imfPanelMain');
}

function _wireImfDoviSettings() {
  // ── Proxy quality select ──────────────────────────────────────────────────
  const proxySel = document.getElementById('imfProxyQualitySelect');
  if (proxySel) {
    const stored = (() => { try { return localStorage.getItem('pfx_imf_proxy_quality') || 'turbo'; } catch { return 'turbo'; } })();
    proxySel.value = stored;
    proxySel.addEventListener('change', () => {
      try { localStorage.setItem('pfx_imf_proxy_quality', proxySel.value); } catch {}
    });
  }

  // ── Metafier path input ───────────────────────────────────────────────────
  const pathInp   = document.getElementById('settingsMetafierPath');
  const testBtn   = document.getElementById('settingsMetafierTest');
  const statusEl  = document.getElementById('settingsMetafierStatus');
  const cmdInp    = document.getElementById('settingsMetafierCmd');

  if (pathInp) pathInp.value = _loadMetafierPath();
  if (cmdInp) {
    try { cmdInp.value = localStorage.getItem('pfx_dovi_metafier_cmd') || ''; } catch {}
    cmdInp.addEventListener('change', () => {
      try { localStorage.setItem('pfx_dovi_metafier_cmd', cmdInp.value.trim()); } catch {}
    });
  }
  if (pathInp) {
    pathInp.addEventListener('change', () => _saveMetafierPath(pathInp.value.trim()));
  }
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      const p = pathInp?.value?.trim() || '';
      testBtn.disabled = true;
      if (statusEl) { statusEl.textContent = 'Testing…'; statusEl.style.display = ''; statusEl.style.color = ''; }
      try {
        const info = await imfDetectMetafier(p || undefined).catch(() => ({ found: false }));
        if (info?.found) {
          const msg = `✓ Found: ${info.version || info.path}`;
          if (statusEl) { statusEl.textContent = msg; statusEl.style.color = '#4caf80'; }
          if (pathInp && !p) pathInp.value = info.path;
          _saveMetafierPath(info.path || p);
        } else {
          if (statusEl) { statusEl.textContent = '✗ Metafier not found'; statusEl.style.color = '#f55'; }
        }
      } catch (e) {
        if (statusEl) { statusEl.textContent = `✗ ${e?.message}`; statusEl.style.color = '#f55'; }
      } finally {
        testBtn.disabled = false;
      }
    });
  }

  // ── Relink IMF Root for Native Helper ────────────────────────────────────
  const relinkBtn    = document.getElementById('settingsRelinkImfRoot');
  const relinkStatus = document.getElementById('settingsRelinkImfRootStatus');
  if (relinkBtn) {
    // Show current stored root if any
    const storedRoot = (() => { try { return localStorage.getItem('pfx_imf_native_root') || ''; } catch { return ''; } })();
    if (storedRoot && relinkStatus) relinkStatus.textContent = storedRoot;

    relinkBtn.addEventListener('click', async () => {
      relinkBtn.disabled = true;
      if (relinkStatus) relinkStatus.textContent = 'Opening folder picker…';
      try {
        // Use companion native folder picker
        const picked = await imfPickFolder().catch(() => null);
        const root = picked?.folder || picked?.folderPath || '';
        if (root) {
          try { localStorage.setItem('pfx_imf_native_root', root); } catch {}
          if (relinkStatus) relinkStatus.textContent = root;
          // Update module-level variable if currently viewing an IMF package
          if (!_imfSourceFolderPath && _imfSourceBackend === 'browser') {
            // Allow the extractor to use this for native helper calls
            window.__pfxImfNativeRoot = root;
          }
        } else {
          if (relinkStatus) relinkStatus.textContent = 'Cancelled.';
        }
      } catch (e) {
        if (relinkStatus) relinkStatus.textContent = `Error: ${e?.message}`;
      } finally {
        relinkBtn.disabled = false;
      }
    });
  }
}


// ── Decode Test Frame ──────────────────────────────────────────────────────────

function _refreshDecodeTestInputs() {
  const inputs = playerGetDecodeInputs();
  const cplEl  = document.getElementById('imfDecodeTestCplVal');
  const mapsEl = document.getElementById('imfDecodeTestMapsVal');
  if (cplEl)  cplEl.textContent  = inputs.cplPath  || _imfElectronCplPath || '—';
  if (mapsEl) {
    const maps = (inputs.assetMaps?.length ? inputs.assetMaps : _imfElectronAssetMapPaths);
    mapsEl.textContent = maps?.length ? maps.join('\n') : '—';
  }
}

async function _runDecodeTestFrame() {
  const btn       = document.getElementById('imfDecodeTestBtn');
  const statusEl  = document.getElementById('imfDecodeTestStatus');
  const logEl     = document.getElementById('imfDecodeTestLog');

  // Resolve inputs: prefer player state, fall back to ui module state
  const playerInputs = playerGetDecodeInputs();
  const cplPath  = playerInputs.cplPath  || _imfElectronCplPath  || '';
  const assetMaps = (playerInputs.assetMaps?.length ? playerInputs.assetMaps : _imfElectronAssetMapPaths) || [];

  // Show current inputs
  _refreshDecodeTestInputs();

  if (!cplPath) {
    _showDecodeTestResult({ ok: false, error: 'No CPL path — open an IMF package first in Electron companion mode', code: 'NO_CPL_PATH', log: [], errors: ['No CPL path available'] }, logEl, statusEl);
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Decoding…'; }
  if (statusEl) statusEl.textContent = 'Running ffmpeg -f imf …';
  if (logEl) logEl.style.display = 'none';

  try {
    const result = await window.pfxPlatform.imf.decodeTestFrame({
      cplPath,
      assetMaps,
      frameNumber: 0,
      scale: 'viewer',
    });

    _showDecodeTestResult(result, logEl, statusEl);

    if (result.ok && (result.imageUrl || result.imageDataUrl)) {
      await playerShowTestFrame(result, {
        backend: result.backend || 'ffmpeg-imf',
        codec:   result.codec   || 'J2K',
        outputPng: result.outputPng,
      });
    }
  } catch (e) {
    _showDecodeTestResult({ ok: false, error: e.message || String(e), code: 'IPC_ERROR', log: [], errors: [e.message] }, logEl, statusEl);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Decode Frame 0'; }
  }
}

function _showDecodeTestResult(result, logEl, statusEl) {
  if (statusEl) {
    if (result.ok) {
      statusEl.textContent = `OK · ${result.codec || 'J2K'} · ${result.outputPng ? result.outputPng.split('/').pop() : ''}`;
      statusEl.style.color = '#4caf80';
    } else {
      statusEl.textContent = `FAILED · ${result.code || result.error || 'decode failed'}`;
      statusEl.style.color = '#e55353';
    }
  }
  if (!logEl) return;
  logEl.style.display = 'block';

  const cplPath   = playerGetDecodeInputs().cplPath || _imfElectronCplPath || '—';
  const assetMaps = (playerGetDecodeInputs().assetMaps?.length
    ? playerGetDecodeInputs().assetMaps
    : _imfElectronAssetMapPaths) || [];

  const rows = [
    ['assetMaps', assetMaps.length ? assetMaps.join('\n  ') : '—'],
    ['cplPath',   cplPath],
    ['frameNumber', '0'],
    ['codec',     result.codec || '—'],
    ['command',   result.command || '—'],
    ['outputPng', result.outputPng || '—'],
    ['fileExists', String(result.fileExists ?? '—')],
  ];

  let html = `<div style="font-size:9px;font-family:monospace;border-top:1px solid rgba(255,255,255,.08);padding-top:6px;">`;
  html += `<div style="font-weight:bold;margin-bottom:4px;color:${result.ok ? '#4caf80' : '#e55353'};">[IMF Decode Test] ${result.ok ? '✓ PASS' : '✗ FAIL'}</div>`;
  for (const [k, v] of rows) {
    html += `<div><span style="color:rgba(255,255,255,.45);min-width:80px;display:inline-block;">${_esc(k)}:</span> <span style="color:rgba(255,255,255,.8);white-space:pre-wrap;word-break:break-all;">${_esc(v)}</span></div>`;
  }

  if (result.stderr) {
    html += `<div style="margin-top:6px;padding:6px;background:rgba(229,83,83,.12);border:1px solid rgba(229,83,83,.3);border-radius:3px;">`;
    html += `<div style="color:#e55353;font-weight:bold;margin-bottom:2px;">stderr:</div>`;
    html += `<div style="color:#f7a26a;white-space:pre-wrap;word-break:break-all;">${_esc(result.stderr)}</div>`;
    html += `</div>`;
  }

  if (Array.isArray(result.log) && result.log.length) {
    html += `<details style="margin-top:6px;"><summary style="cursor:pointer;color:rgba(255,255,255,.45);font-size:8px;">Full debug log (${result.log.length} lines)</summary>`;
    html += `<pre style="font-size:8px;color:rgba(255,255,255,.55);white-space:pre-wrap;word-break:break-all;margin:4px 0 0;">${_esc(result.log.join('\n'))}</pre></details>`;
  }

  html += `</div>`;
  logEl.innerHTML = html;
}

// ── Best Practice tab ─────────────────────────────────────────────────────────

function _wireBestPracticeTab() {
  // ── Decode Test Frame button ──────────────────────────────────────────────
  const decodeTestBtn = document.getElementById('imfDecodeTestBtn');
  if (decodeTestBtn) {
    decodeTestBtn.addEventListener('click', () => _runDecodeTestFrame());
  }

  // Update CPL/AssetMap display whenever the Best Practice tab is shown
  const bpTab = document.getElementById('imfTabBestPractice');
  if (bpTab) {
    bpTab.addEventListener('click', () => _refreshDecodeTestInputs());
  }

  // IMF UG checks
  const ugRunBtn = document.getElementById('imfUgRunBtn');
  if (ugRunBtn) {
    ugRunBtn.addEventListener('click', () => _runUgChecks());
  }

  // Delivery schema preset selector
  const presetSel = document.getElementById('imfDeliverySchemaPreset');
  const customRow = document.getElementById('imfDeliverySchemaCustomRow');
  if (presetSel) {
    presetSel.addEventListener('change', () => {
      if (customRow) customRow.style.display = presetSel.value === 'custom' ? 'flex' : 'none';
    });
  }

  // Load custom schema XML
  const loadBtn = document.getElementById('imfDeliverySchemaLoadBtn');
  if (loadBtn) {
    loadBtn.addEventListener('click', async () => {
      try {
        const path = typeof window.pfxPlatform?.pickFile === 'function'
          ? await window.pfxPlatform.pickFile({ filters: [{ name: 'XML', extensions: ['xml'] }] })
          : null;
        if (!path) return;
        const text = typeof window.pfxPlatform?.readFile === 'function'
          ? await window.pfxPlatform.readFile({ filePath: path, encoding: 'utf8' })
          : null;
        if (!text) return;
        const result = parseDeliverySchema(text);
        if (!result.ok) {
          _showDeliverySchemaResults([{ ruleId: 'parse', label: 'Schema Parse Error', section: '', status: 'fail', detail: result.error }]);
          return;
        }
        _customDeliverySchema = result.schema;
        const nameEl = document.getElementById('imfDeliverySchemaFileName');
        if (nameEl) nameEl.textContent = result.schema.label || path.split('/').pop();
      } catch (e) {
        console.warn('[IMF] schema load error:', e.message);
      }
    });
  }

  // Run delivery schema validation
  const schemaRunBtn = document.getElementById('imfDeliverySchemaRunBtn');
  if (schemaRunBtn) {
    schemaRunBtn.addEventListener('click', () => _runDeliverySchemaValidation());
  }

  // Photon run
  const photonRunBtn = document.getElementById('imfPhotonRunBtn');
  if (photonRunBtn) {
    photonRunBtn.addEventListener('click', () => _runPhoton());
  }

  // Plugfest test suite
  const plugfestRunBtn = document.getElementById('imfPlugfestRunBtn');
  if (plugfestRunBtn) {
    plugfestRunBtn.addEventListener('click', () => _runPlugfestSuite());
  }
}

function _runUgChecks() {
  const listEl = document.getElementById('imfUgChecklist');
  if (!listEl) return;

  if (!_pkg?.cpl) {
    listEl.innerHTML = '<div style="font-size:9px;color:rgba(255,255,255,.35);text-align:center;padding:12px 0;">Load an IMF package first</div>';
    return;
  }

  const results = runAllUgChecks({
    cpl:        _pkg.cpl,
    assetMap:   _pkg.assetMap,
    fileMap:    _pkg.fileMap,
    folderName: _imfSourceFolderName || '',
    mcaData:    _labelQc?.rows?.length > 0 ? _buildMcaDataFromRows(_labelQc.rows) : null,
  });

  listEl.innerHTML = results.map(r => _ugCheckRow(r)).join('');
}

function _buildMcaDataFromRows(rows) {
  const map = {};
  for (const row of rows) {
    if (!row.trackFileId) continue;
    map[row.trackFileId] = {
      hasMcaLabels:    !!row.mcaLabel,
      soundfieldGroupId: row.soundfieldGroupId || '',
      channelCount:    row.channelCount || 0,
      mcaChannelLabels: row.channelLabels || [],
    };
  }
  return map;
}

function _ugCheckRow({ id, label, status, detail }) {
  const colors = { pass: '#4caf80', warn: '#ffb74d', fail: '#f55', skip: 'rgba(255,255,255,.3)', info: '#7c9cff' };
  const icons  = { pass: '✓', warn: '⚠', fail: '✗', skip: '—', info: 'ℹ' };
  const color  = colors[status] || colors.skip;
  const icon   = icons[status]  || '—';
  return `<div style="display:flex;gap:8px;align-items:flex-start;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)">
    <span style="color:${color};font-size:11px;min-width:14px;flex-shrink:0;">${icon}</span>
    <div style="flex:1;min-width:0;">
      <div style="font-size:9px;font-weight:600;color:rgba(255,255,255,.8);">${_esc(label)}</div>
      ${detail ? `<div style="font-size:8px;color:rgba(255,255,255,.45);margin-top:1px;word-break:break-word;">${_esc(detail)}</div>` : ''}
    </div>
  </div>`;
}

function _runDeliverySchemaValidation() {
  const listEl = document.getElementById('imfDeliverySchemaResults');
  if (!listEl) return;

  if (!_pkg?.cpl) {
    listEl.innerHTML = '<div style="font-size:9px;color:rgba(255,255,255,.35);text-align:center;padding:8px 0;">Load an IMF package first</div>';
    return;
  }

  const presetSel = document.getElementById('imfDeliverySchemaPreset');
  const preset    = presetSel?.value || 'app2e';

  let schema;
  if (preset === 'custom') {
    if (!_customDeliverySchema) {
      listEl.innerHTML = '<div style="font-size:9px;color:#ffb74d;padding:8px 0;">Load a custom schema XML first</div>';
      return;
    }
    schema = _customDeliverySchema;
  } else {
    schema = APP2E_PRESET;
  }

  const results = validateAgainstSchema(_pkg, schema);
  _showDeliverySchemaResults(results);
}

function _showDeliverySchemaResults(results) {
  const listEl = document.getElementById('imfDeliverySchemaResults');
  if (!listEl) return;
  if (!results.length) {
    listEl.innerHTML = '<div style="font-size:9px;color:rgba(255,255,255,.35);padding:8px 0;">No rules to evaluate</div>';
    return;
  }
  listEl.innerHTML = results.map(r => {
    const colors = { pass: '#4caf80', warn: '#ffb74d', fail: '#f55', skip: 'rgba(255,255,255,.3)', info: '#7c9cff' };
    const icons  = { pass: '✓', warn: '⚠', fail: '✗', skip: '—', info: 'ℹ' };
    const color  = colors[r.status] || colors.skip;
    const icon   = icons[r.status]  || '—';
    const sectionStr = r.section ? ` <span style="color:rgba(255,255,255,.3)">[${_esc(r.section)}]</span>` : '';
    return `<div style="display:flex;gap:8px;align-items:flex-start;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05)">
      <span style="color:${color};font-size:11px;min-width:14px;flex-shrink:0;">${icon}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:9px;font-weight:600;color:rgba(255,255,255,.8);">${_esc(r.label)}${sectionStr}</div>
        ${r.detail ? `<div style="font-size:8px;color:rgba(255,255,255,.45);margin-top:1px;word-break:break-word;">${_esc(r.detail)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

async function _runPhoton() {
  if (_photonRunning) return;
  const resultsEl   = document.getElementById('imfPhotonResults');
  const statusChip  = document.getElementById('imfPhotonStatusChip');
  const runBtn      = document.getElementById('imfPhotonRunBtn');
  if (!resultsEl) return;

  const packagePath = _imfSourceFolderPath || (window.pfxPlatform?.isMacApp ? null : null);
  if (!packagePath) {
    resultsEl.innerHTML = '<div style="font-size:9px;color:#ffb74d;padding:8px 0;">Package path not available — load package via Desktop app file picker</div>';
    return;
  }

  if (!window.pfxPlatform?.imf?.runPhoton) {
    resultsEl.innerHTML = '<div style="font-size:9px;color:rgba(255,255,255,.35);padding:8px 0;">Photon IPC not available in this build</div>';
    return;
  }

  _photonRunning = true;
  if (runBtn) runBtn.disabled = true;
  if (statusChip) { statusChip.textContent = 'Running…'; statusChip.className = 'imf-engine-chip imf-engine-chip-partial'; }
  resultsEl.innerHTML = '<div style="font-size:9px;color:rgba(255,255,255,.45);padding:8px 0;">Running Photon validation — this may take up to 60 s…</div>';

  try {
    const res = await window.pfxPlatform.imf.runPhoton(packagePath);

    if (!res.ok) {
      if (statusChip) { statusChip.textContent = 'Error'; statusChip.className = 'imf-engine-chip imf-engine-chip-missing'; }
      resultsEl.innerHTML = `<div style="font-size:9px;color:#f55;padding:4px 0;">${_esc(res.error || res.summary)}</div>`;
      return;
    }

    // Cache for the unified verdict/report merge, then refresh.
    _photonLastResults = Array.isArray(res.results) ? res.results : [];
    try { _refreshValidationResults(); } catch {}

    const errors   = res.results.filter(r => r.severity === 'ERROR' || r.severity === 'FATAL').length;
    const warnings = res.results.filter(r => r.severity === 'WARNING').length;

    if (statusChip) {
      if (errors > 0) { statusChip.textContent = `${errors} error${errors > 1 ? 's' : ''}`; statusChip.className = 'imf-engine-chip imf-engine-chip-missing'; }
      else if (warnings > 0) { statusChip.textContent = `${warnings} warn`; statusChip.className = 'imf-engine-chip imf-engine-chip-partial'; }
      else { statusChip.textContent = 'Pass'; statusChip.className = 'imf-engine-chip imf-engine-chip-ready'; }
    }

    if (res.results.length === 0) {
      resultsEl.innerHTML = `<div style="font-size:9px;color:#4caf80;padding:4px 0;">✓ ${_esc(res.summary)}</div>`;
      return;
    }

    const sevColor = { ERROR: '#f55', FATAL: '#f55', WARNING: '#ffb74d', INFO: 'rgba(255,255,255,.5)', PASS: '#4caf80' };
    resultsEl.innerHTML = `<div style="font-size:9px;color:rgba(255,255,255,.5);margin-bottom:4px;">${_esc(res.summary)}</div>` +
      res.results.slice(0, 100).map(r => {
        const color = sevColor[r.severity] || 'rgba(255,255,255,.5)';
        const code  = r.code ? ` <span style="color:rgba(255,255,255,.3)">[${_esc(r.code)}]</span>` : '';
        return `<div style="display:flex;gap:6px;align-items:flex-start;padding:3px 0;border-bottom:1px solid rgba(255,255,255,.04)">
          <span style="color:${color};font-size:8px;min-width:52px;flex-shrink:0;font-weight:700">${_esc(r.severity)}</span>
          <span style="font-size:8px;color:rgba(255,255,255,.7);word-break:break-word;">${_esc(r.message)}${code}</span>
        </div>`;
      }).join('') +
      (res.results.length > 100 ? `<div style="font-size:8px;color:rgba(255,255,255,.3);margin-top:4px;">… ${res.results.length - 100} more results</div>` : '');
  } catch (e) {
    if (statusChip) { statusChip.textContent = 'Error'; statusChip.className = 'imf-engine-chip imf-engine-chip-missing'; }
    resultsEl.innerHTML = `<div style="font-size:9px;color:#f55;padding:4px 0;">IPC error: ${_esc(e.message)}</div>`;
  } finally {
    _photonRunning = false;
    if (runBtn) runBtn.disabled = false;
  }
}

// ── P1-PROGRESS: cancellable long-pass runner (progress + Cancel affordance) ──
// Drives the IMF Direct Engine's poll-based job API (startJob → jobProgress →
// cancelJob) exposed on window.pfxPlatform.imfEngine. It renders a small progress
// bar + Cancel button into `containerEl` and resolves with the job's terminal
// snapshot. Fully guarded + non-breaking: if the engine/job bridge is absent
// (older preload), it degrades to a single no-progress call where possible and
// otherwise returns a soft "unavailable" result without throwing.
//
// Usage:
//   const ctl = runImfEngineJob('validate', { packageId, cplId, hash:true },
//                               { container: document.getElementById('imfJobProgress') });
//   const snap = await ctl.done;           // terminal snapshot
//   ctl.cancel();                          // user hit Cancel
let _imfJobPollTimer = null;
function runImfEngineJob(kind, params = {}, { container, pollMs = 300, label } = {}) {
  const eng = (typeof window !== 'undefined') && window.pfxPlatform && window.pfxPlatform.imfEngine;
  let cancelled = false;
  let jobId = null;

  // Build (or reuse) the progress UI. Uses DOM APIs (no untrusted innerHTML).
  function ensureUI() {
    if (!container) return null;
    let bar = container.querySelector('.imf-job-progress');
    if (!bar) {
      bar = el('div', 'imf-job-progress');
      bar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;font-size:9px;';
      const track = el('div', 'imf-job-progress-track');
      track.style.cssText = 'flex:1;height:6px;border-radius:3px;background:rgba(255,255,255,.08);overflow:hidden;';
      const fill = el('div', 'imf-job-progress-fill');
      fill.style.cssText = 'height:100%;width:0%;background:#7c9cff;transition:width .15s linear;';
      track.appendChild(fill);
      const msg = el('span', 'imf-job-progress-msg');
      msg.style.cssText = 'min-width:120px;color:rgba(255,255,255,.6);';
      const btn = el('button', 'imf-job-cancel-btn');
      btn.type = 'button';
      btn.textContent = 'Cancel';
      btn.style.cssText = 'font-size:9px;padding:2px 8px;border-radius:4px;border:1px solid rgba(255,255,255,.2);background:transparent;color:rgba(255,255,255,.8);cursor:pointer;';
      btn.addEventListener('click', () => { api.cancel(); });
      bar.append(msg, track, btn);
      container.appendChild(bar);
    }
    return {
      fill: bar.querySelector('.imf-job-progress-fill'),
      msg:  bar.querySelector('.imf-job-progress-msg'),
      btn:  bar.querySelector('.imf-job-cancel-btn'),
      root: bar,
    };
  }
  function render(progress) {
    const ui = ensureUI();
    if (!ui) return;
    const pct = Math.round((progress?.fraction || 0) * 100);
    ui.fill.style.width = pct + '%';
    ui.msg.textContent = (progress?.message) || (label ? `${label}…` : `${progress?.stage || 'working'}…`);
  }
  function teardown() {
    if (_imfJobPollTimer) { clearInterval(_imfJobPollTimer); _imfJobPollTimer = null; }
    const ui = ensureUI();
    if (ui && ui.root && ui.root.parentNode) ui.root.parentNode.removeChild(ui.root);
  }

  const api = {
    jobId: null,
    cancel() {
      cancelled = true;
      if (jobId && eng && typeof eng.cancelJob === 'function') {
        try { eng.cancelJob(jobId); } catch {}
      }
    },
    done: null,
  };

  api.done = (async () => {
    if (!eng || typeof eng.startJob !== 'function' || typeof eng.jobProgress !== 'function') {
      // Bridge unavailable — soft fail (non-breaking on older preload builds).
      return { ok: false, unavailable: true, error: 'IMF engine job bridge unavailable' };
    }
    let started;
    try { started = await eng.startJob(kind, params); } catch (e) { return { ok: false, error: e.message }; }
    if (!started || !started.ok) return started || { ok: false, error: 'startJob failed' };
    jobId = started.jobId; api.jobId = jobId;
    if (cancelled) { try { eng.cancelJob(jobId); } catch {} }   // cancelled before start returned

    return await new Promise((resolve) => {
      if (_imfJobPollTimer) clearInterval(_imfJobPollTimer);
      _imfJobPollTimer = setInterval(async () => {
        let snap;
        try { snap = await eng.jobProgress(jobId); } catch { return; }
        if (!snap || !snap.ok) { teardown(); resolve({ ok: false, error: (snap && snap.error) || 'job lost' }); return; }
        render(snap.snapshot.progress);
        if (snap.snapshot.progress.done || snap.snapshot.state !== 'running') {
          teardown();
          resolve({ ok: true, snapshot: snap.snapshot });
        }
      }, Math.max(50, pollMs));
      if (_imfJobPollTimer.unref) _imfJobPollTimer.unref();
    });
  })();

  return api;
}
if (typeof window !== 'undefined') { window.__pfxRunImfEngineJob = runImfEngineJob; }

// ── Plugfest-style test suite ─────────────────────────────────────────────────
// Each test checks a structural aspect of the loaded package against known
// plugfest scenarios. Tests run in-process — no external tools required.

const PLUGFEST_TESTS = [
  {
    id: 'pf-base',
    label: 'Base IMP',
    description: 'Package is a valid base IMP with ASSETMAP, PKL, and at least one CPL',
    run(pkg) {
      if (!pkg?.assetMap) return { status: 'fail', detail: 'No ASSETMAP.xml found' };
      if (!pkg?.pkl)      return { status: 'fail', detail: 'No PKL found' };
      if (!pkg?.cpl)      return { status: 'fail', detail: 'No CPL found' };
      return { status: 'pass', detail: 'ASSETMAP + PKL + CPL present' };
    },
  },
  {
    id: 'pf-supplemental',
    label: 'Supplemental IMP',
    description: 'Detects supplemental IMP — CPL references a base CPL via AnnotationText or supplemental AssetMaps',
    run(pkg) {
      const isSupplemental = pkg?.cpl?.isSupplemental || pkg?.assetMap?.isSupplemental;
      if (isSupplemental) {
        return { status: 'pass', detail: 'Supplemental CPL or AssetMap detected' };
      }
      return { status: 'skip', detail: 'Not a supplemental IMP (base IMP)' };
    },
  },
  {
    id: 'pf-multicpl',
    label: 'Multi-CPL IMP',
    description: 'PKL references more than one CPL',
    run(pkg) {
      const cplCount = pkg?.pkl?.cplCount || 0;
      if (cplCount > 1) return { status: 'pass', detail: `PKL references ${cplCount} CPLs` };
      if (cplCount === 1) return { status: 'skip', detail: 'Single-CPL IMP' };
      return { status: 'warn', detail: 'Could not determine CPL count from PKL' };
    },
  },
  {
    id: 'pf-htj2k',
    label: 'HTJ2K IMP',
    description: 'Video essence uses High Throughput JPEG 2000 (Part 15 / HTJ2K)',
    run(pkg) {
      const ed = pkg?.cpl?.essenceDescriptorList;
      if (!ed) return { status: 'skip', detail: 'EssenceDescriptorList not available' };
      const videoDesc = Array.isArray(ed) ? ed.find(d => d.pictureCompression || d.codec) : null;
      if (!videoDesc) return { status: 'skip', detail: 'No video EssenceDescriptor in CPL' };
      const codec = (videoDesc.pictureCompression || videoDesc.codec || '').toLowerCase();
      const isHtj2k = codec.includes('htj2k') || codec.includes('ht-j2k') || codec.includes('jpeg2000ht') ||
                      codec.includes('0e060402.01010101') || codec.includes('part-15');
      if (isHtj2k) return { status: 'pass', detail: `HTJ2K codec: ${videoDesc.pictureCompression || videoDesc.codec}` };
      return { status: 'skip', detail: `Video codec is ${videoDesc.pictureCompression || videoDesc.codec || 'J2K (not HTJ2K)'}` };
    },
  },
  {
    id: 'pf-imsc',
    label: 'IMSC Subtitle IMP',
    description: 'CPL contains at least one IMSC subtitle track file',
    run(pkg) {
      const subs = pkg?.cpl?.subtitleResources || pkg?.cpl?.timedTextResources || [];
      if (subs.length === 0) return { status: 'skip', detail: 'No subtitle tracks' };
      const imscSubs = subs.filter(r => {
        const ns = r.namespace || r.imscNamespace || '';
        return ns.includes('imsc') || ns.includes('ttml#parameter') || ns.includes('ttml2');
      });
      if (imscSubs.length > 0) return { status: 'pass', detail: `${imscSubs.length} IMSC subtitle track(s)` };
      return { status: 'warn', detail: `${subs.length} subtitle track(s) but none identified as IMSC — check namespace` };
    },
  },
  {
    id: 'pf-iab',
    label: 'IAB/ADM IMP',
    description: 'CPL contains an Immersive Audio (IAB or ADM/ATMOS) audio track file',
    run(pkg) {
      const audio = pkg?.cpl?.audioResources || pkg?.cpl?.audioTrackFiles || [];
      const iabTrack = audio.find(a => {
        const label = (a.type || a.trackFileType || a.essenceType || '').toLowerCase();
        return label.includes('iab') || label.includes('atmos') || label.includes('adm');
      });
      if (iabTrack) return { status: 'pass', detail: `IAB/ADM track found: ${iabTrack.type || iabTrack.trackFileType || '?'}` };
      if (audio.length > 0) return { status: 'skip', detail: `${audio.length} audio track(s) — no IAB/ADM type detected` };
      return { status: 'skip', detail: 'No audio tracks' };
    },
  },
  {
    id: 'pf-missing-mxf',
    label: 'Missing MXF Detection',
    description: 'PKL/CPL references an MXF that is not present in ASSETMAP or file listing',
    run(pkg) {
      if (!pkg?.fileMap || !pkg?.pkl) return { status: 'skip', detail: 'fileMap or PKL not available' };
      const fileKeys = new Set(Object.keys(pkg.fileMap).map(k => k.toLowerCase()));
      const missing = [];
      for (const [id, asset] of Object.entries(pkg.pkl.assets || {})) {
        if (!asset.path) continue;
        const filename = asset.path.split('/').pop().toLowerCase();
        if (filename.endsWith('.mxf') && !fileKeys.has(filename)) {
          missing.push(filename);
        }
      }
      if (missing.length === 0) return { status: 'pass', detail: 'All PKL MXF references resolved' };
      return { status: 'fail', detail: `${missing.length} missing MXF file(s): ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}` };
    },
  },
  {
    id: 'pf-bad-hash',
    label: 'PKL Hash Integrity',
    description: 'SHA-1 hash verification for PKL asset list (uses pre-computed validation results)',
    run(pkg, valResults) {
      if (!valResults || valResults.length === 0) return { status: 'skip', detail: 'Run Hashes to verify (use Hashes button in toolbar)' };
      const hashFails = valResults.filter(r => r.type === 'hash' && r.severity === 'fail');
      if (hashFails.length === 0) return { status: 'pass', detail: 'All PKL hashes verified' };
      return { status: 'fail', detail: `${hashFails.length} hash mismatch(es) detected` };
    },
  },
  {
    id: 'pf-delivery-constraint',
    label: 'Delivery Constraint',
    description: 'App #2E CPL constraints: EditRate, ContentVersion, ApplicationIdentification, EssenceDescriptorList',
    run(pkg) {
      if (!pkg?.cpl) return { status: 'skip', detail: 'No CPL loaded' };
      const { cpl } = pkg;
      const issues = [];
      if (!cpl.contentVersionId && !(cpl.contentVersionList?.length > 0)) issues.push('No ContentVersionList');
      if (!cpl.applicationIdentification) issues.push('No ApplicationIdentification');
      if (!cpl.essenceDescriptorList) issues.push('No EssenceDescriptorList');
      if (issues.length === 0) return { status: 'pass', detail: 'CPL structural constraints satisfied' };
      return { status: 'fail', detail: issues.join(', ') };
    },
  },
];

function _runPlugfestSuite() {
  const listEl = document.getElementById('imfPlugfestList');
  if (!listEl) return;

  if (!_pkg) {
    listEl.innerHTML = '<div style="font-size:9px;color:rgba(255,255,255,.35);text-align:center;padding:8px 0;">Load an IMF package first</div>';
    return;
  }

  const results = PLUGFEST_TESTS.map(test => {
    try {
      const res = test.run(_pkg, _valResults);
      return { id: test.id, label: test.label, description: test.description, ...res };
    } catch (e) {
      return { id: test.id, label: test.label, description: test.description, status: 'skip', detail: `Error: ${e.message}` };
    }
  });

  const pass  = results.filter(r => r.status === 'pass').length;
  const fail  = results.filter(r => r.status === 'fail').length;
  const warn  = results.filter(r => r.status === 'warn').length;
  const skip  = results.filter(r => r.status === 'skip').length;

  const summary = `${pass} pass, ${fail} fail, ${warn} warn, ${skip} n/a`;
  listEl.innerHTML = `<div style="font-size:9px;color:rgba(255,255,255,.45);margin-bottom:4px;">${_esc(summary)}</div>` +
    results.map(r => _ugCheckRow(r)).join('');
}

// ── Engine Status (Settings tab) ──────────────────────────────────────────────

let _engineStatusSeq = 0;

function _wireEngineStatus() {
  const refreshBtn = document.getElementById('imfEngineRefreshBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => _loadEngineStatus());
  }
  // Auto-load when settings tab opens
  const settingsTab = document.getElementById('imfTabSettings');
  if (settingsTab) {
    settingsTab.addEventListener('click', () => {
      const listEl = document.getElementById('imfEngineStatusList');
      if (listEl && listEl.children.length === 1) _loadEngineStatus();
    });
  }
}

async function _loadEngineStatus() {
  const listEl = document.getElementById('imfEngineStatusList');
  if (!listEl) return;

  if (!window.pfxPlatform?.imf?.engineStatus) {
    listEl.innerHTML = '<div style="font-size:9px;color:rgba(255,255,255,.35);">Engine status IPC not available in this build</div>';
    return;
  }

  listEl.innerHTML = '<div style="font-size:9px;color:rgba(255,255,255,.35);">Checking engines…</div>';

  const seq = ++_engineStatusSeq;

  try {
    const { engines } = await window.pfxPlatform.imf.engineStatus();
    if (seq !== _engineStatusSeq) return; // superseded by a newer refresh
    if (!engines || engines.length === 0) {
      listEl.innerHTML = '<div style="font-size:9px;color:rgba(255,255,255,.35);">No engines reported</div>';
      return;
    }
    listEl.innerHTML = engines.map(e => {
      const chipCls = `imf-engine-chip imf-engine-chip-${e.status}`;
      const chipTxt = e.status === 'ready' ? 'Ready' : e.status === 'partial' ? 'Partial' : 'Missing';
      return `<div style="display:flex;gap:8px;align-items:flex-start;">
        <div style="flex:1;min-width:0;">
          <div style="font-size:9px;font-weight:600;color:rgba(255,255,255,.8);">${_esc(e.label)}</div>
          <div style="font-size:8px;color:rgba(255,255,255,.4);word-break:break-word;">${_esc(e.detail || '')}</div>
        </div>
        <span class="${chipCls}" style="flex-shrink:0;white-space:nowrap;">${chipTxt}</span>
      </div>`;
    }).join('');
  } catch (err) {
    if (seq !== _engineStatusSeq) return; // superseded by a newer refresh
    listEl.innerHTML = `<div style="font-size:9px;color:#f55;">Error: ${_esc(err.message)}</div>`;
  }
}

function _esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function wirePkgAccordion() {
  const btn  = document.getElementById('imfPkgToggle');
  const body = document.getElementById('imfKPI');
  if (!btn || !body) return;
  btn.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    body.style.display = open ? 'none' : '';
  });
}

function wireReelTabs() {
  document.querySelectorAll('.imf-left-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      setImfLeftTab(tab.dataset.ltab || 'validation');
    });
  });
}

function wireLabelFilters() {
  $('imfLabelFilterText')?.addEventListener('input', renderLabelQC);
  $('imfLabelFilterStatus')?.addEventListener('change', renderLabelQC);
  $('imfLabelFilterGroup')?.addEventListener('change', renderLabelQC);
}

function _labelCounts(rows) {
  const out = { total: 0, pass: 0, warn: 0, reject: 0, unmapped: 0 };
  if (!Array.isArray(rows)) return out;
  out.total = rows.length;
  for (const r of rows) {
    const s = String(r?.status || '').toUpperCase();
    if (s === 'PASS') out.pass++;
    else if (s === 'WARN') out.warn++;
    else if (s === 'REJECT') out.reject++;
    if (!r?.mapped) out.unmapped++;
  }
  return out;
}

function _resetLabelQC(extra = {}) {
  _labelQc = {
    loading: false,
    error: '',
    rows: [],
    stats: null,
    root: null,
    assetName: '',
    totalRows: 0,
    ...extra,
  };
  renderLabelQC();
}

function _labelResultsToValidation() {
  if (!_pkg?.cpl?.hasIAB) return [];
  if (_labelQc.loading) {
    return [{ sev: SEV.INFO, code: 'AUD003', msg: 'IAB label QC is reading embedded ADM (AXML)…', detail: '' }];
  }
  if (_labelQc.error) {
    return [{ sev: SEV.WARN, code: 'AUD003', msg: 'IAB label QC unavailable', detail: _labelQc.error }];
  }
  const counts = _labelCounts(_labelQc.rows);
  if (!counts.total) {
    return [{ sev: SEV.WARN, code: 'AUD003', msg: 'No mapped group labels extracted from IAB ADM', detail: 'Embedded ADM was not found or did not expose any label candidates.' }];
  }
  const results = [
    { sev: SEV.INFO, code: 'AUD003', msg: `IAB ADM label candidates extracted: ${counts.total}`, detail: _labelQc.assetName || '' },
  ];
  if (counts.reject > 0) {
    results.push({ sev: SEV.WARN, code: 'AUD004', msg: `${counts.reject} IAB group label(s) need renaming`, detail: 'Open the Labels tab to review REJECT rows and suggested fixes.' });
  } else {
    results.push({ sev: SEV.PASS, code: 'AUD004', msg: 'All actionable IAB group labels mapped to recognized groups', detail: `${counts.pass} pass · ${counts.warn} ignored technical/programme/channel labels` });
  }
  if (counts.warn > 0) {
    results.push({ sev: SEV.INFO, code: 'AUD005', msg: `${counts.warn} technical/programme label(s) were ignored by group-label QC`, detail: 'These are usually audioProgramme, audioPackFormat, or audioTrackFormat identifiers.' });
  }
  if (_iabDecodeCaps.loading) {
    results.push({
      sev: SEV.INFO,
      code: 'AUD006',
      msg: 'Checking local IAB decode engine…',
      detail: 'PostFlowX is querying the native companion for immersive-audio capability.',
    });
  } else if (_iabDecodeCaps.ready) {
    results.push({
      sev: SEV.PASS,
      code: 'AUD006',
      msg: `IAB audio decode ready via ${_iabDecodeCaps.engineLabel || _iabDecodeCaps.engineId || 'local engine'}`,
      detail: _iabDecodeDetail() || 'PCM decode / playback is available for the immersive-audio path.',
    });
  } else {
    results.push({
      sev: SEV.WARN,
      code: 'AUD006',
      msg: _iabDecodeSummary(),
      detail: _iabDecodeDetail() || 'Metadata/QC works, but actual PCM decode/playback still needs a dedicated immersive-audio engine beyond this ffmpeg path.',
    });
  }
  return results;
}

function _doviExtractionToValidation() {
  const cpl = _pkg?.cpl;
  if (!cpl) return [];
  const isPq = /PQ|2084/i.test(cpl.transfer || '');
  const expectDV = cpl.isDolbyVision || isPq;
  if (!expectDV && !_doviExtractResult) return [];

  const res = _doviExtractResult;
  const results = [];

  if (!res) {
    // Extraction not yet run
    if (expectDV) {
      results.push({ sev: SEV.INFO, code: 'HDR001',
        msg: 'Dolby Vision metadata scan not yet completed', detail: 'Reload the CPL to trigger extraction.' });
    }
    return results;
  }

  const sev = doviStatusSeverity(res, expectDV);
  const label = doviStatusLabel(res);

  switch (res.status) {
    case DOVI_STATUS.FOUND:
      results.push({ sev: SEV.PASS, code: 'HDR001',
        msg: `Dolby Vision metadata extracted (${res.shots.length} shots)`,
        detail: `Source: ${res.sourceType} · CM version: ${res.cmVersion || 'unknown'} · L1: ${res.hasLevel1} · L8/trim: ${res.hasLevel8}` });
      if (!res.hasLevel8) results.push({ sev: SEV.WARN, code: 'HDR002',
        msg: 'No L8 trim passes found in Dolby Vision metadata',
        detail: 'Netflix IMF delivery requires L8 SDR 100-nit trim passes (target display index 27).' });
      break;
    case DOVI_STATUS.CONFIRMED_NO_DATA:
      results.push({ sev: SEV.WARN, code: 'HDR001',
        msg: 'Dolby Vision detected in package — CM XML not extracted',
        detail: 'DolbyVisionSubDescriptor found in CPL but no CM XML could be read. A Metafier tool or Native Helper is required for per-shot trim data.' });
      break;
    case DOVI_STATUS.EXTRACTOR_REQUIRED:
      results.push({ sev: SEV.WARN, code: 'HDR001',
        msg: 'Dolby Vision likely embedded — Metafier / Native Helper required',
        detail: 'No CM XML sidecar found. The metadata is probably embedded in the picture MXF. Configure a Dolby Vision extractor in Settings to read per-shot trim data.' });
      break;
    case DOVI_STATUS.EXTRACT_FAILED:
      results.push({ sev: SEV.FAIL, code: 'HDR001',
        msg: 'Dolby Vision extraction failed',
        detail: (res.errors || []).join(' · ') || 'Check the debug log for details.' });
      break;
    case DOVI_STATUS.PARSE_FAILED:
      results.push({ sev: SEV.WARN, code: 'HDR001',
        msg: 'Dolby Vision XML found but failed to parse',
        detail: (res.errors || []).join(' · ') });
      break;
    case DOVI_STATUS.NOT_FOUND:
      results.push({ sev: expectDV ? SEV.WARN : SEV.INFO, code: 'HDR001',
        msg: isPq
          ? 'HDR PQ content — no Dolby Vision metadata detected'
          : 'No Dolby Vision metadata in this package',
        detail: 'All discovery paths were tried (companion, sidecar scan, embedded MXF). No CM XML found.' });
      break;
  }
  if (res.warnings?.length) {
    for (const w of res.warnings.slice(0, 2)) {
      results.push({ sev: SEV.INFO, code: 'HDR003', msg: w, detail: '' });
    }
  }
  return results;
}

// Map an IMF-UG check ({id,label,status,detail}) to a unified validation row.
// status→sev: pass→pass, warn→warn, fail→fail, skip→info. Coded with a UG prefix
// so _applyValFilter groups them and they participate in the overall verdict.
function _ugResultsToValidation() {
  if (!_pkg?.cpl) return [];
  let ugRaw;
  try {
    ugRaw = runAllUgChecks({
      cpl:        _pkg.cpl,
      assetMap:   _pkg.assetMap,
      fileMap:    _pkg.fileMap,
      folderName: _imfSourceFolderName || '',
      mcaData:    _labelQc?.rows?.length > 0 ? _buildMcaDataFromRows(_labelQc.rows) : null,
    });
  } catch (e) {
    return [{ sev: SEV.FAIL, code: 'UG000', msg: 'IMF-UG checks threw an error', detail: (e && e.message) || String(e) }];
  }
  const sevMap = { pass: SEV.PASS, warn: SEV.WARN, fail: SEV.FAIL, skip: SEV.INFO, info: SEV.INFO };
  // Escape at ingestion: these strings are CPL/label-derived and the validation
  // renderer writes msg/detail as raw innerHTML — harden the externally-sourced
  // engine rows without touching rows that use intentional markup.
  return (ugRaw || []).map(r => ({
    sev:    sevMap[r.status] || SEV.INFO,
    code:   `UG-${r.id || '?'}`,
    msg:    _esc(r.label || 'IMF-UG check'),
    detail: _esc(r.detail || ''),
  }));
}

// Map cached Photon results into unified validation rows. ERROR/FATAL→fail,
// WARNING→warn, PASS→pass, everything else→info. Only present after Photon runs.
function _photonResultsToValidation() {
  if (!Array.isArray(_photonLastResults) || !_photonLastResults.length) return [];
  const sevMap = { ERROR: SEV.FAIL, FATAL: SEV.FAIL, WARNING: SEV.WARN, PASS: SEV.PASS, INFO: SEV.INFO };
  // Escape at ingestion — r.message is raw stdout from the external Photon JAR
  // and the renderer writes it as raw innerHTML.
  return _photonLastResults.map((r, i) => ({
    sev:    sevMap[r.severity] || SEV.INFO,
    code:   `PHOTON-${r.code || (i + 1)}`,
    msg:    _esc(r.message || 'Photon result'),
    detail: _esc(r.severity || ''),
  }));
}

function _refreshValidationResults() {
  if (!_pkg) {
    _valResults = [];
    renderValidation();
    return;
  }
  // Each engine is wrapped so a throw in one never blanks the whole panel — a
  // failing engine surfaces as a single VAL000 fail row instead (a validator that
  // crashes on a malformed package is worse than one that reports the defect).
  const collect = (label, fn) => {
    try { const r = fn(); return Array.isArray(r) ? r : []; }
    catch (e) { return [{ sev: SEV.FAIL, code: 'VAL000', msg: `${label} failed: ${(e && e.message) || e}`, detail: '' }]; }
  };
  // Hash-verification rows are appended out-of-band by runHashVerification and
  // are NOT reproduced by the engines below — preserve them across a rebuild so
  // an async refresh (e.g. a Photon run completing) can't silently wipe the
  // operator's hash pass/fail results from the panel and exports.
  const hashRows = _valResults.filter(r => r && r.code === 'HASH');
  _valResults = [
    ...collect('Schema validation', () => validateSchema(_pkg.rawXml)),
    ...collect('Structural validation', () => validateStructure(_pkg.assetMap, _pkg.pkl, _pkg.cpl, _pkg.fileMap)),
    ...collect('Label QC', () => _labelResultsToValidation()),
    ...collect('Dolby Vision extraction', () => _doviExtractionToValidation()),
    ...collect('IMF-UG checks', () => _ugResultsToValidation()),
    ...collect('Photon', () => _photonResultsToValidation()),
    ...hashRows,
  ];
  renderValidation();
  try { _renderNetflixCompliance(); } catch {}
}

function renderLabelQC() {
  const summary = $('imfLabelSummary');
  const meta = $('imfLabelMeta');
  const tbody = $('imfLabelTableBody');
  const count = $('imfLabelCount');
  const badge = $('imfTabLabelsBadge');
  if (!summary || !meta || !tbody || !count) return;

  const query = String($('imfLabelFilterText')?.value || '').trim().toLowerCase();
  const status = String($('imfLabelFilterStatus')?.value || 'ALL');
  const group = String($('imfLabelFilterGroup')?.value || 'ALL');

  const baseRows = Array.isArray(_labelQc.rows) ? _labelQc.rows.filter((r) => {
    if (group === 'UNMAPPED' && r.mapped) return false;
    if (group !== 'ALL' && group !== 'UNMAPPED' && (r.mapped || '') !== group) return false;
    if (!query) return true;
    return String(r.rawLabel || '').toLowerCase().includes(query) ||
      String(r.mapped || '').toLowerCase().includes(query) ||
      String(r.source || '').toLowerCase().includes(query);
  }) : [];
  const shownRows = status === 'ALL' ? baseRows : baseRows.filter(r => String(r.status || '').toUpperCase() === status);
  const counts = _labelCounts(_labelQc.rows);

  count.textContent = `${shownRows.length} shown / ${counts.total}`;
  if (badge) {
    const badgeText = counts.reject ? `${counts.reject} reject` : counts.warn ? `${counts.warn} warn` : counts.total ? `${counts.total}` : '';
    badge.style.display = badgeText ? 'inline-flex' : 'none';
    badge.textContent = badgeText;
  }

  summary.innerHTML = `
    <span class="imf-label-pill">Total ${counts.total}</span>
    <span class="imf-label-pill imf-label-pill-pass">Pass ${counts.pass}</span>
    <span class="imf-label-pill imf-label-pill-warn">Warn ${counts.warn}</span>
    <span class="imf-label-pill imf-label-pill-reject">Reject ${counts.reject}</span>
  `;

  const metaBits = [];
  if (_labelQc.assetName) metaBits.push(`Source: ${_labelQc.assetName}`);
  if (_labelQc.root?.localName) metaBits.push(`ADM root: ${_labelQc.root.localName}`);
  if (_pkg?.cpl?.hasIAB) {
    metaBits.push(`Decode: ${_iabDecodeSummary()}`);
    const decodeDetail = _iabDecodeDetail();
    if (decodeDetail) metaBits.push(decodeDetail);
  }
  if (_labelQc.stats) {
    const s = _labelQc.stats;
    metaBits.push(`prog:${s.audioProgramme || 0} • cont:${s.audioContent || 0} • obj:${s.audioObject || 0} • pack:${s.audioPackFormat || 0} • uid:${s.audioTrackUID || 0} • track:${s.audioTrackFormat || 0}`);
  }
  meta.innerHTML = _labelQc.loading
    ? '<div>Reading embedded ADM (AXML) from IAB asset…</div>'
    : _labelQc.error
      ? `<div>${_esc(_labelQc.error)}</div>`
      : (metaBits.length ? metaBits.map(line => `<div>${_esc(line)}</div>`).join('') : '<div>No IAB label QC data for the current CPL.</div>');

  if (_labelQc.loading) {
    tbody.innerHTML = '<tr class="imf-label-empty"><td colspan="2">Reading embedded ADM (AXML) from IAB asset…</td></tr>';
    return;
  }
  if (_labelQc.error) {
    tbody.innerHTML = `<tr class="imf-label-empty"><td colspan="2">${_esc(_labelQc.error)}</td></tr>`;
    return;
  }
  if (!shownRows.length) {
    tbody.innerHTML = '<tr class="imf-label-empty"><td colspan="2">No label entries matched the current filters.</td></tr>';
    return;
  }

  tbody.innerHTML = shownRows.map((r) => {
    const cls = String(r.status || '').toLowerCase();
    const mapped = `${r.mapped || ''}${r.subgroup ? ` / ${r.subgroup}` : ''}`;
    const raw = String(r.rawLabel || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const mappedSafe = String(mapped || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const source = String(r.source || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const fix = String(r.fix || '').replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const isPass = cls === 'pass';

    // Mapped group chip — colored by group name
    const grpKey = (r.mapped || '').toLowerCase().replace(/\s+/g, '-');
    const chipLabel = mappedSafe || '<span style="opacity:.45">unmapped</span>';
    const chip = `<span class="imf-lbl-chip imf-lbl-chip-${grpKey || 'none'}">${chipLabel}</span>`;

    // Detail row: source + fix — shown for WARN / REJECT only
    const detail = !isPass && (source || fix) ? `
      <div class="imf-lbl-detail">
        ${source ? `<span class="imf-lbl-src">${source}</span>` : ''}
        ${fix    ? `<span class="imf-lbl-fix">${fix}</span>`    : ''}
      </div>` : '';

    return `
      <tr class="imf-lbl-row imf-lbl-row-${cls}">
        <td class="imf-lbl-st-cell">
          <span class="imf-lbl-dot imf-lbl-dot-${cls}" title="${r.status}"></span>
        </td>
        <td class="imf-lbl-body">
          <div class="imf-lbl-top">
            <span class="imf-lbl-name">${raw}</span>
            ${chip}
          </div>
          ${detail}
        </td>
      </tr>
    `;
  }).join('');
}

async function runIabLabelQC() {
  if (!_pkg?.cpl?.hasIAB) {
    _resetLabelQC({ error: 'Current CPL has no IAB track.' });
    _refreshValidationResults();
    return;
  }
  const runKey = _pkg.currentCplKey || _currentCplKey;
  const iabResources = Array.isArray(_pkg.cpl.iabResources) && _pkg.cpl.iabResources.length
    ? _pkg.cpl.iabResources
    : (_pkg.cpl.audioResources || []).filter(res => _isIabResource(_pkg.cpl, res));
  const firstIab = iabResources[0];
  const asset = firstIab ? getAssetMetaById(firstIab.trackFileId) : null;
  const file = asset ? _pkg.resolveFile(asset) || _pkg.resolveFile(firstIab.trackFileId) : null;

  if (!file || typeof file.slice !== 'function') {
    const assetName = _pkg.assetLabel(asset || firstIab?.trackFileId);
    // Companion fallback: ask native app for IAB metadata, run label rules locally
    if (_imfSourceBackend === 'companion' && _imfSourcePackageId && _pkg.cpl?.id) {
      _resetLabelQC({ loading: true, assetName });
      _refreshValidationResults();
      try {
        const info = await imfInspectImmersiveAudio(_imfSourcePackageId, _pkg.cpl.id);
        if ((_pkg?.currentCplKey || _currentCplKey) !== runKey) return;
        if (!info) throw new Error('Companion returned no IAB metadata');
        const qc = await inspectIabAdmFromNames({
          programmeNames:  info.programmeNames   || [],
          contentNames:    info.contentNames     || [],
          objectNames:     info.objectNames      || (info.objectSummary?.sampleNamedObjects || []),
          packNames:       info.packNames        || [],
          trackFormatNames: info.trackFormatNames || [],
        });
        if ((_pkg?.currentCplKey || _currentCplKey) !== runKey) return;
        _resetLabelQC({
          rows: qc.rows || [],
          stats: qc.admStats || null,
          root: qc.axmlRoot || null,
          assetName,
          totalRows: (qc.rows || []).length,
        });
      } catch (err) {
        if ((_pkg?.currentCplKey || _currentCplKey) !== runKey) return;
        _resetLabelQC({ error: String(err?.message || err || 'Companion label QC failed'), assetName });
      }
      _refreshValidationResults();
      return;
    }
    _resetLabelQC({ error: 'IAB label QC needs direct access to the IAB MXF. Load via browser folder or relink the package.' });
    _refreshValidationResults();
    return;
  }

  _resetLabelQC({ loading: true, assetName: _pkg.assetLabel(asset || firstIab.trackFileId) });
  _refreshValidationResults();
  try {
    const qc = await extractIabAdmLabelQC(file);
    if ((_pkg?.currentCplKey || _currentCplKey) !== runKey) return;
    _resetLabelQC({
      rows: qc.rows || [],
      stats: qc.admStats || null,
      root: qc.axmlRoot || null,
      assetName: _pkg.assetLabel(asset || firstIab.trackFileId),
      totalRows: (qc.rows || []).length,
    });
  } catch (err) {
    if ((_pkg?.currentCplKey || _currentCplKey) !== runKey) return;
    _resetLabelQC({ error: String(err?.message || err || 'IAB label QC failed'), assetName: _pkg.assetLabel(asset || firstIab.trackFileId) });
  }
  _refreshValidationResults();
}

function setViewerMode(mode = 'imf') {
  const safeMode = mode === 'proxy' && _proxyViewerReady ? 'proxy' : 'imf';
  _imfViewerMode = safeMode;

  const stage = $('imfViewerStage');
  const btnImf = $('imfViewImfBtn');
  const btnProxy = $('imfViewProxyBtn');
  const proxyVideo = $('imfProxyVideo');
  const doviPanel = $('imfDoviPanel');

  if (stage) stage.dataset.viewMode = safeMode;
  if (btnImf) btnImf.classList.toggle('imf-view-switch-btn-active', safeMode === 'imf');
  if (btnProxy) {
    btnProxy.disabled = !_proxyViewerReady;
    btnProxy.classList.toggle('imf-view-switch-btn-active', safeMode === 'proxy');
  }

  if (doviPanel) doviPanel.style.display = safeMode === 'proxy' && _proxyViewerReady ? 'flex' : 'none';

  if (proxyVideo && _proxyViewerReady) {
    if (safeMode === 'proxy') {
      const playAttempt = proxyVideo.play?.();
      if (playAttempt && typeof playAttempt.catch === 'function') playAttempt.catch(() => {});
      // Start real audio meter when proxy plays
      if (!_proxyAudioCtx) _startProxyAudioMeter(proxyVideo);
    } else {
      try { proxyVideo.pause?.(); } catch {}
      _stopProxyAudioMeter();
    }
  }
}

function setProxyViewerReady(ready) {
  _proxyViewerReady = !!ready;
  if (!ready && _imfViewerMode === 'proxy') _imfViewerMode = 'imf';
  setViewerMode(_imfViewerMode);
}

function wireViewerSwitch() {
  $('imfViewImfBtn')?.addEventListener('click', () => setViewerMode('imf'));
  $('imfViewProxyBtn')?.addEventListener('click', () => setViewerMode('proxy'));
  $('imfViewTrimBtn')?.addEventListener('click', () => playerToggleTrim());
  $('imfBtnHdrSdr')?.addEventListener('click', () => playerSetPreviewMode());
  setProxyViewerReady(false);
}

function wireProjectNameSync() {
  if (_imfProjectNameWireBound) return;
  _imfProjectNameWireBound = true;
  const nameInput = document.getElementById('projectNameGlobal');
  if (!nameInput) return;
  const sync = () => {
    if (!_imfSourceDirHandle) return;
    storeNamedHandle(_imfHandleKey(), _imfSourceDirHandle).catch(() => {});
  };
  nameInput.addEventListener('input', sync);
  nameInput.addEventListener('change', sync);
  nameInput.addEventListener('blur', sync);
}

function _serializeImfPackages() {
  if (!_imfPackages?.length) return [];
  return _imfPackages.map(pkg => {
    const baseEntry = Array.isArray(pkg.cpls) && pkg.cpls.length ? pkg.cpls[0] : null;
    const resolvedAssetIds = Array.from(new Set(
      pkg?.resolvedAssetIds?.length ? pkg.resolvedAssetIds : Object.entries(pkg?.pkl?.assets || {})
        .filter(([id, asset]) => {
          const resolve = baseEntry?.fmGet;
          const localMap = baseEntry?.fileMap;
          return !!(
            resolve?.(asset?.file, localMap) ||
            resolve?.(asset?.assetMapPath, localMap) ||
            resolve?.(id, localMap) ||
            resolve?.(asset?.file, _extFileMap) ||
            resolve?.(asset?.assetMapPath, _extFileMap) ||
            resolve?.(id, _extFileMap)
          );
        })
        .map(([id]) => id)
    ));

    return {
      root: pkg.root || '',
      packageName: pkg.packageName || '',
      assetMap: _imfSafeClone(pkg.assetMap) || null,
      pkl: _imfSafeClone(pkg.pkl) || null,
      resolvedAssetIds,
      cpls: Array.isArray(pkg.cpls) ? pkg.cpls.map(entry => ({
        key: entry.key,
        root: entry.root || pkg.root || '',
        packageName: entry.packageName || pkg.packageName || '',
        cpl: _imfSafeClone(entry.cpl) || null,
        isSupplemental: !!entry.isSupplemental,
        missingVideoRefs: Number(entry.missingVideoRefs || 0),
        missingAudioRefs: Number(entry.missingAudioRefs || 0),
        playableReels: Number(entry.playableReels || 0),
        shortLabel: entry.shortLabel || '',
      })) : [],
    };
  });
}

function _makeAssetIndexFromPackages(packages = []) {
  const assetIndex = new Map();
  packages.forEach(pkg => {
    const root = pkg?.root || '';
    const assets = pkg?.pkl?.assets || {};
    Object.entries(assets).forEach(([id, asset]) => {
      assetIndex.set(id, { ...(asset || {}), id, packageRoot: root });
    });
  });
  return assetIndex;
}

function _isVirtualFileHandle(file) {
  return !!file?.__pfxVirtual;
}

function _makeVirtualFile(name = '', size = 0) {
  return {
    name: String(name || '').trim() || 'asset',
    size: Number(size) || 0,
    __pfxVirtual: true,
  };
}

function _buildVirtualFileMap(packages = []) {
  const map = new Map();
  const put = (key, file) => {
    if (!key || !file) return;
    const safe = String(key).replace(/^\.\//, '').replace(/^\//, '');
    map.set(safe, file);
    map.set(safe.toLowerCase(), file);
  };

  packages.forEach(pkg => {
    const resolved = new Set(pkg?.resolvedAssetIds || []);
    Object.entries(pkg?.pkl?.assets || {}).forEach(([id, asset]) => {
      if (!resolved.has(id)) return;
      const virtual = _makeVirtualFile(asset?.file || asset?.assetMapPath || id, asset?.size || 0);
      put(id, virtual);
      put(asset?.file, virtual);
      put(asset?.assetMapPath, virtual);
    });
  });

  return map;
}

// ── CPL shape normalizer ──────────────────────────────────────────────────────
// The Node.js imf_package_index.js parseCPL returns a minimal shape that omits
// several fields expected by the renderer (audioResources, hasIAB, iabResources,
// pcmAudioResources, iabSequences, audioSequences, videoSequences, durationSec,
// appVersion, bitDepth, contentTitle, etc.).  Call this on any CPL that may have
// originated from the main-process path (e.g. via pfx:imf:loadPackage IPC).
function _normalizeCplShape(cpl) {
  if (!cpl) return;
  // Arrays that are iterated without guards throughout the UI
  if (!Array.isArray(cpl.audioResources))    cpl.audioResources    = [];
  if (!Array.isArray(cpl.iabResources))      cpl.iabResources      = [];
  if (!Array.isArray(cpl.pcmAudioResources)) cpl.pcmAudioResources = [];
  if (!Array.isArray(cpl.videoResources))    cpl.videoResources    = [];
  if (!Array.isArray(cpl.videoSequences))    cpl.videoSequences    = [];
  if (!Array.isArray(cpl.audioSequences))    cpl.audioSequences    = [];
  if (!Array.isArray(cpl.iabSequences))      cpl.iabSequences      = [];
  if (!Array.isArray(cpl.segments))          cpl.segments          = [];
  if (!Array.isArray(cpl.descriptors))       cpl.descriptors       = [];
  if (!Array.isArray(cpl.contentVersions))   cpl.contentVersions   = [];
  if (!Array.isArray(cpl.markers))           cpl.markers           = [];
  if (!Array.isArray(cpl.locales))           cpl.locales           = [];
  // Boolean flags
  if (cpl.hasIAB == null)        cpl.hasIAB        = cpl.iabResources.length > 0;
  if (cpl.isDolbyVision == null) cpl.isDolbyVision = false;
  // dvDescriptorIds: normalize to a Set
  if (!cpl.dvDescriptorIds || !cpl.dvDescriptorIds.has) {
    cpl.dvDescriptorIds = new Set(Array.isArray(cpl.dvDescriptorIds) ? cpl.dvDescriptorIds : []);
  }
  // Scalar fields that the renderer accesses
  if (cpl.durationSec == null)  cpl.durationSec  = cpl.totalFrames && cpl.editRate ? cpl.totalFrames / cpl.editRate : 0;
  if (!cpl.appVersion)          cpl.appVersion   = '–';
  if (!cpl.bitDepth)            cpl.bitDepth     = cpl.picDesc?.depth ? String(cpl.picDesc.depth) : '–';
  if (!cpl.contentTitle)        cpl.contentTitle = cpl.annotation || '';
  if (!cpl.contentKind)         cpl.contentKind  = '';
  if (cpl.resolution == null)   cpl.resolution   = cpl.picDesc ? { w: cpl.picDesc.w || '–', h: cpl.picDesc.h || '–' } : { w: '–', h: '–' };
  // transfer/primaries: Node.js parseCPL already provides these as string labels
  if (!cpl.transfer)  cpl.transfer  = '–';
  if (!cpl.primaries) cpl.primaries = '–';
  if (!cpl.codec)     cpl.codec     = '–';
}

function _restoreImfSnapshot(snapshot) {
  if (!snapshot?.packages?.length) {
    clearPackage();
    return false;
  }

  const packagesRaw = snapshot.packages.map(pkg => ({
    root: pkg.root || '',
    packageName: pkg.packageName || 'Package',
    assetMap: _imfSafeClone(pkg.assetMap) || { assets:{} },
    pkl: _imfSafeClone(pkg.pkl) || { assets:{} },
    resolvedAssetIds: Array.isArray(pkg.resolvedAssetIds) ? [...new Set(pkg.resolvedAssetIds)] : [],
    cpls: Array.isArray(pkg.cpls) ? pkg.cpls.map(cpl => {
      const cloned = _imfSafeClone(cpl.cpl) || null;
      if (cloned?.dvDescriptorIds && !cloned.dvDescriptorIds.has) {
        cloned.dvDescriptorIds = new Set(Array.isArray(cloned.dvDescriptorIds) ? cloned.dvDescriptorIds : []);
      }
      // Normalize fields that are absent in the Node.js parseCPL (imf_package_index.js) shape
      // but expected throughout imf_ui.js.  Crash sites: renderKPI, renderTimeline,
      // renderReelTable, renderAssetList, renderValidation.
      if (cloned) _normalizeCplShape(cloned);
      return { ...cpl, cpl: cloned };
    }) : [],
  }));

  const assetIndex = _makeAssetIndexFromPackages(packagesRaw);
  const snapshotFileMap = _buildVirtualFileMap(packagesRaw);
  const fmGet = (path, mapOverride = snapshotFileMap) => {
    if (!path || !mapOverride) return undefined;
    const raw = String(path);
    return mapOverride.get(raw) || mapOverride.get(raw.toLowerCase()) ||
      mapOverride.get(raw.replace(/^\.\//, '').replace(/^\//, '').replace(/\\/g, '/')) ||
      mapOverride.get(raw.replace(/^\.\//, '').replace(/^\//, '').replace(/\\/g, '/').toLowerCase());
  };
  const cplEntries = [];
  const packages = packagesRaw.map(pkg => {
    const entries = (pkg.cpls || []).map(entry => {
      const hydrated = {
        key: entry.key,
        root: entry.root || pkg.root || '',
        packageName: entry.packageName || pkg.packageName || 'Package',
        assetMap: pkg.assetMap,
        pkl: pkg.pkl,
        cpl: entry.cpl,
        fileMap: snapshotFileMap,
        fmGet,
        assetIndex,
        isSupplemental: !!entry.isSupplemental,
        missingVideoRefs: Number(entry.missingVideoRefs || 0),
        missingAudioRefs: Number(entry.missingAudioRefs || 0),
        playableReels: Number(entry.playableReels || 0),
        shortLabel: entry.shortLabel || (entry.cpl?.contentTitle || entry.cpl?.annotation || 'CPL'),
      };
      cplEntries.push(hydrated);
      return hydrated;
    });
    return { ...pkg, cpls: entries, fileMap: snapshotFileMap, fmGet, assetIndex };
  });

  _imfPackages = packages;
  _cplEntries = cplEntries;
  _extFiles = [];
  _extFileMap = new Map();
  _baseCplKey = cplEntries.some(e => e.key === snapshot.baseCplKey)
    ? snapshot.baseCplKey
    : ((cplEntries.find(e => !e.isSupplemental) || cplEntries[0])?.key || '');
  _currentCplKey = cplEntries.some(e => e.key === snapshot.currentCplKey)
    ? snapshot.currentCplKey
    : ((cplEntries.find(e => e.isSupplemental) || cplEntries[0])?.key || '');
  _showBaseOverlay = !!snapshot.showBaseOverlay;
  _imfSourceDirHandle = null;
  _imfSourceFolderName = snapshot?.source?.folderName || snapshot?.folderName || '';
  _imfSourceBackend = String(snapshot?.source?.backend || '').trim();
  _imfSourceFolderPath = String(snapshot?.source?.folderPath || '').trim();
  _imfSourcePackageId = String(snapshot?.source?.packageId || '').trim();
  if (_imfSourceBackend === 'companion' && (_imfSourceFolderPath || _imfSourcePackageId)) {
    try { localStorage.setItem('pfx_imf_source_session', JSON.stringify({ backend: _imfSourceBackend, folderPath: _imfSourceFolderPath, packageId: _imfSourcePackageId, savedAt: Date.now() })); } catch {}
  }

  showPanel('imfPanelMain');
  applyCompositionByKey(_currentCplKey);
  setImfLeftTab(snapshot.activeLeftTab || 'validation');
  setViewerMode('imf');
  if (_imfSourceBackend === 'companion') {
    setStatus('warn', `Loaded IMF via companion${_imfSourceFolderName ? ` · ${_imfSourceFolderName}` : ''} · use Proxy QC or Relink for direct reel browse`);
  } else {
    setStatus('warn', `Restored IMF snapshot${_imfSourceFolderName ? ` · ${_imfSourceFolderName}` : ''} · relink reels if needed`);
  }
  // Attempt proxy reconnect AFTER package state is fully restored
  _tryRestoreProxySession();
  return true;
}

function _buildImfProjectState() {
  if (!_cplEntries?.length) return null;
  return {
    schema: 'pfx_imf',
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    source: {
      folderName: _imfSourceFolderName || '',
      folderPath: _imfSourceFolderPath || '',
      packageId: _imfSourcePackageId || '',
      backend: _imfSourceBackend || (_imfSourceDirHandle ? 'browser' : ''),
      handleName: _imfSourceDirHandle ? _imfHandleKey() : '',
    },
    snapshot: {
      packages: _serializeImfPackages(),
      currentCplKey: _currentCplKey || '',
      baseCplKey: _baseCplKey || '',
      showBaseOverlay: !!_showBaseOverlay,
      activeLeftTab: _imfActiveLeftTab || 'validation',
    },
  };
}

async function _applySavedImfState(saved) {
  const payload = saved?.snapshot ? saved : (saved?.state ? saved.state : saved);
  if (!payload) {
    clearPackage();
    try { window.__PFX_IMF_STATE = null; } catch {}
    _tryRestoreProxySession();   // still try to reconnect an existing proxy
    return;
  }

  try { window.__PFX_IMF_STATE = payload; } catch {}
  if (payload?.snapshot) _restoreImfSnapshot({ ...payload.snapshot, source: payload.source || null });

  const handleName = String(payload?.source?.handleName || '').trim();
  if (handleName) {
    try {
      const dirHandle = await loadNamedHandle(handleName);
      if (!dirHandle) { _tryRestoreProxySession(); return; }
      const files = [];
      await _collectHandleDir(dirHandle, files, dirHandle.name);
      if (!files.length) { _tryRestoreProxySession(); return; }
      await loadFromFileList(files, {
        sourceHandle: dirHandle,
        sourceFolderName: dirHandle.name,
        restoreState: payload?.snapshot || null,
      });
      // loadFromFileList → _restoreImfSnapshot already calls _tryRestoreProxySession
      return;
    } catch (err) {
      console.warn('[IMF] restore from stored handle failed', err);
    }
  }

  try {
    const backend = String(payload?.source?.backend || '').trim();
    const folderPath = String(payload?.source?.folderPath || '').trim();
    if (backend === 'companion' && folderPath) {
      const scan = await imfScanFolderCompanion(folderPath);
      if (scan?.snapshot) {
        _restoreImfSnapshot({
          ...scan.snapshot,
          source: {
            ...(scan.snapshot.source || {}),
            folderName: scan.snapshot?.source?.folderName || '',
            folderPath,
            backend: 'companion',
            packageId: scan.packageId || '',
          },
        });
        try { window.__PFX_IMF_STATE = _buildImfProjectState(); } catch {}
      }
    }
  } catch (err) {
    console.warn('[IMF] restore from companion source failed', err);
  }
  _tryRestoreProxySession();
}

function registerProjectHooks() {
  try {
    window.PFX_exportIMFState = () => {
      const state = _buildImfProjectState();
      try { window.__PFX_IMF_STATE = state; } catch {}
      return state;
    };
    window.PFX_applyIMFState = (saved) => {
      _applySavedImfState(saved);
    };
    window.__imfTabActivated = () => {
      try {
        if (!_pkg && window.__PFX_IMF_STATE) {
          _applySavedImfState(window.__PFX_IMF_STATE);
        } else if (!_pkg) {
          // No package state — still try to restore a live proxy session
          _tryRestoreProxySession();
        }
      } catch {}
    };
  } catch {}
}


function wireCompositionControls() {
  const hdr = document.querySelector('.imf-tl-section-hdr');
  if (!hdr || document.getElementById('imfCplControls')) return;
  const box = el('div', 'imf-cpl-controls');
  box.id = 'imfCplControls';
  box.style.display = 'none';
  // No "CPL" label — the selected <option> already reads "CPL N · …", so a
  // separate label is redundant once the controls sit inline with the header.
  box.innerHTML = `
    <select id="imfCplSelect" class="imf-cpl-select" title="Composition Playlist"></select>
    <button id="imfBaseToggle" class="imf-action-btn imf-cpl-btn" type="button">Show Base</button>
  `;
  // Fold the CPL controls into the header's left control group, right after the
  // CPL Order selector and before the info badges (#imfTLInfo). Previously this
  // appended to the header itself, so — with the header's flex-wrap and the
  // right-aligned icons — it wrapped onto an orphaned second line. Inserting
  // into .imf-tl-hdr-left keeps it inline with the Storyboard/CPL-Order selectors.
  // insertBefore requires the reference node to be a direct child of the target,
  // so fall back to appending if the DOM isn't shaped as expected (guards the
  // rest of initIMFTab() from throwing and leaving package buttons unwired).
  const _tlInfoRef = document.getElementById('imfTLInfo');
  const _hdrLeft = _tlInfoRef?.parentNode || hdr.querySelector('.imf-tl-hdr-left') || hdr;
  if (_tlInfoRef && _tlInfoRef.parentNode === _hdrLeft) _hdrLeft.insertBefore(box, _tlInfoRef);
  else _hdrLeft.appendChild(box);
  const sel = $('imfCplSelect');
  const tog = $('imfBaseToggle');
  sel?.addEventListener('change', () => {
    if (!sel.value) return;
    _currentCplKey = sel.value;
    applyCompositionByKey(sel.value);
  });
  tog?.addEventListener('click', () => {
    _showBaseOverlay = !_showBaseOverlay;
    refreshCompositionControls();
    renderTimeline();
  });
}

function refreshCompositionControls() {
  const box = $('imfCplControls');
  const sel = $('imfCplSelect');
  const tog = $('imfBaseToggle');
  if (!box || !sel || !tog) return;
  const hasEntries = _cplEntries.length > 0;
  box.style.display = hasEntries ? 'inline-flex' : 'none';
  if (!hasEntries) return;
  const current = _currentCplKey || (_cplEntries[0]?.key || '');
  sel.innerHTML = _cplEntries.map((entry, idx) => {
    const kind = entry.isSupplemental ? 'supp' : 'base';
    const playable = `${entry.playableReels}/${entry.cpl.videoResources.length}`;
    const ordinal = _cplEntries.length > 1 ? `CPL ${idx + 1}` : 'CPL';
    return `<option value="${entry.key}" ${entry.key === current ? 'selected' : ''}>${ordinal} · ${entry.packageName} · ${entry.shortLabel} · ${kind} · ${playable}</option>`;
  }).join('');
  sel.disabled = _cplEntries.length <= 1;
  sel.title = _cplEntries.length > 1 ? 'Switch Composition Playlist' : 'Only one CPL discovered in current IMF selection';
  sel.style.opacity = _cplEntries.length > 1 ? '1' : '.78';
  const canOverlay = !!(_baseCplKey && current && _baseCplKey !== current);
  tog.style.display = canOverlay ? '' : 'none';
  tog.disabled = !canOverlay;
  tog.classList.toggle('imf-cpl-btn-active', !!_showBaseOverlay && canOverlay);
  tog.textContent = _showBaseOverlay && canOverlay ? 'Hide Base' : 'Show Base';
  tog.title = canOverlay ? `Toggle base CPL overlay (${_cplEntries.find(e => e.key === _baseCplKey)?.shortLabel || 'Base'})` : 'Base overlay unavailable';
}

function getAssetMetaById(id) {
  if (!_pkg || !id) return null;
  return _pkg.assetIndex?.get(id) || _pkg.globalAssets?.get(id) || _pkg.pkl?.assets?.[id] || null;
}

// ── Electron companion-mode MXF path resolution ───────────────────────────────

function _startElectronPackagePrep(folderPath) {
  if (!folderPath || typeof window.pfxPlatform?.imf?.preparePackage !== 'function') return;
  _imfElectronPackageHash   = '';
  _imfElectronMxfPaths      = new Map();
  _imfElectronCplPath       = '';
  _imfElectronAssetMapPaths = [];
  // For multi-package bundles (base + supplementals), prepare every discovered sub-folder
  // so the main-process package index can find CPLs across all packages.
  const foldersToPrep = _imfAllPackageFolderPaths.length > 0
    ? _imfAllPackageFolderPaths
    : [folderPath];
  _imfElectronPrepPromise = Promise.all(
    foldersToPrep.map(fp =>
      window.pfxPlatform.imf.preparePackage(fp)
        .then(r => { if (r?.ok && r.packageId && !_imfElectronPackageHash) _imfElectronPackageHash = r.packageId; })
        .catch(() => {})
    )
  );
}

async function _ensureElectronReelPaths(cplId) {
  if (!_imfSourceFolderPath) return;
  if (!_imfElectronPrepPromise) _startElectronPackagePrep(_imfSourceFolderPath);
  if (_imfElectronPrepPromise) await _imfElectronPrepPromise;
  if (!_imfElectronPackageHash || !cplId) return;

  // Reel list: per-reel mxfPath for the fallback per-MXF decode path
  if (typeof window.pfxPlatform?.imf?.reelList === 'function') {
    try {
      const result = await window.pfxPlatform.imf.reelList({ packageHash: _imfElectronPackageHash, cplId });
      if (result?.ok && Array.isArray(result.reels)) {
        for (const r of result.reels) {
          if (r.trackFileId && r.mxfPath) _imfElectronMxfPaths.set(r.trackFileId, r);
        }
      }
    } catch {}
  }

  // CPL info: absolute cplPath + all assetMapPaths for the IMF demuxer decode path
  if (typeof window.pfxPlatform?.imf?.cplInfo === 'function') {
    try {
      const info = await window.pfxPlatform.imf.cplInfo({ packageHash: _imfElectronPackageHash, cplId });
      if (info?.ok) {
        _imfElectronCplPath       = info.cplPath       || '';
        _imfElectronAssetMapPaths = info.assetMapPaths || [];
        console.log(`[IMF] cplPath=${_imfElectronCplPath}`);
        console.log(`[IMF] assetMapPaths=${JSON.stringify(_imfElectronAssetMapPaths)}`);
      }
    } catch {}
  }
}

async function applyCompositionByKey(key) {
  const entry = _cplEntries.find(e => e.key === key) || _cplEntries[0];
  if (!entry) return;
  _currentCplKey = entry.key;
  const resolveAssetFile = (assetOrId) => {
    const asset = typeof assetOrId === 'string' ? (getAssetMetaById(assetOrId) || {}) : (assetOrId || {});
    const id = typeof assetOrId === 'string' ? assetOrId : asset.id;
    return entry.fmGet?.(asset.file, entry.fileMap) || entry.fmGet?.(asset.assetMapPath, entry.fileMap) || entry.fmGet?.(id, entry.fileMap) ||
           entry.fmGet?.(asset.file, _extFileMap) || entry.fmGet?.(asset.assetMapPath, _extFileMap) || entry.fmGet?.(id, _extFileMap);
  };
  const assetLabel = (assetOrId) => {
    const asset = typeof assetOrId === 'string' ? (getAssetMetaById(assetOrId) || {}) : (assetOrId || {});
    const id = typeof assetOrId === 'string' ? assetOrId : asset.id;
    return asset.file || asset.assetMapPath || id || 'Unknown asset';
  };
  _pkg = {
    assetMap: entry.assetMap,
    pkl: entry.pkl,
    cpl: entry.cpl,
    rawXml: entry.rawXml || null,
    fileMap: entry.fileMap,
    extFileMap: _extFileMap,
    resolveFile: resolveAssetFile,
    assetLabel,
    assetIndex: entry.assetIndex,
    globalAssets: entry.assetIndex,
    bundlePackages: _imfPackages,
    cplEntries: _cplEntries,
    currentCplKey: entry.key,
    baseCplKey: _baseCplKey,
    packageName: entry.packageName,
    bundleLabel: _imfPackages.length > 1 ? `${_imfPackages.length} packages / ${_cplEntries.length} CPLs` : entry.packageName,
    // Stable identifier used as cache key by the Electron IMF frame provider
    packageHash: btoa((entry.cpl?.id || '') + (entry.packageName || '')).slice(0, 24).replace(/[+/=]/g, '_'),
  };
  _iabDecodeCaps = _defaultIabDecodeCaps({
    error: entry.cpl.hasIAB ? 'Checking local IAB decode capability…' : '',
  });
  _resetLabelQC({
    error: entry.cpl.hasIAB ? 'Waiting for IAB label QC…' : 'Current CPL has no IAB track.',
    assetName: '',
  });
  _refreshValidationResults();
  renderKPI();
  renderLabelQC();
  // Pre-fetch absolute MXF paths from Electron main process so path-only decode
  // has a populated _imfElectronMxfPaths map before renderTimeline auto-loads the reel.
  if (_imfSourceFolderPath && entry.cpl?.id && typeof window.pfxPlatform?.imf?.preparePackage === 'function') {
    await _ensureElectronReelPaths(entry.cpl.id).catch(() => {});
  }
  renderTimeline();
  renderReelTable(entry.cpl, new Map());
  renderAssetList(entry.cpl, new Map());
  updateRelinkBtn();
  refreshCompositionControls();
  showPanel('imfPanelMain');
  if (entry.cpl.hasIAB) {
    _refreshIabDecodeCaps();
    runIabLabelQC();
    _runIabDecode().catch(() => {});  // Browser-side ADM inspection — populates IAB panel
  }
  // Always try Metafier — DV sidecar XML may exist even without MXF descriptor flag.
  // Clear stale data from previous CPL first, then let _renderDoviMetafier() re-populate.
  _clearDoviMetafier();
  _tryLoadDoviMetafier().catch(() => {});
  const playable = entry.cpl.videoResources.filter(res => !!_getReelFile(res)).length;
  const statusBits = [`Loaded:  · ${playable}/${entry.cpl.videoResources.length} playable reel(s)`];
  if (_imfPackages.length > 1 || _cplEntries.length > 1) statusBits.push(`${_imfPackages.length} pkg / ${_cplEntries.length} CPL`);
  if (entry.isSupplemental) statusBits.push('supplemental');
  setStatus(playable ? 'ok' : 'warn', statusBits.join('  ·  '));

  // When no MXF files are directly accessible, initialise the player with CPL
  // metadata so the timeline is scrubable and the timecode display is functional
  // even without a proxy or direct file decode.
  if (playable === 0 && entry.cpl.totalFrames > 0) {
    const firstRes = entry.cpl.videoResources[0];
    const electronReel = firstRes ? _imfElectronMxfPaths.get(firstRes.trackFileId) : null;
    playerLoadReel(null, {
      reelNum: 1,
      totalFrames: firstRes ? firstRes.sourceDuration : entry.cpl.totalFrames,
      fps: entry.cpl.editRate,
      tcOffset: 0,
      codec: entry.cpl.codec || '–',
      resolution: `${entry.cpl.resolution.w}×${entry.cpl.resolution.h}`,
      transfer: entry.cpl.transfer || '–',
      primaries: entry.cpl.primaries || '–',
      mxfPath: electronReel?.mxfPath || '',
      entryPoint: electronReel?.entryPoint || 0,
      intrinsicDuration: electronReel?.intrinsicDuration || (firstRes ? firstRes.sourceDuration : 0),
      cplPath: _imfElectronCplPath || '',
      assetMaps: _imfElectronAssetMapPaths.length ? _imfElectronAssetMapPaths : [],
      cplId: entry.cpl.id || '',
      packageHash: _imfElectronPackageHash || _pkg.packageHash || '',
    });
  }

  // Companion mode: try to reconnect a previously-generated proxy and, if the
  // proxy isn't available, fall back to requesting a single-frame thumbnail from
  // the companion so the viewer shows at least a representative still image.
  if (_imfSourceBackend === 'companion' && !_proxyViewerReady) {
    // Small delay so the CPL state is fully committed before the restore runs.
    setTimeout(() => {
      if (!_proxyViewerReady && !_proxySessionRestoring) _tryRestoreProxySession();
    }, 600);
    // Independently try a companion frame thumbnail for the IMF viewer canvas.
    if (playable === 0) _tryCompanionFrameThumb(entry.cpl);
  }
}

// ── Companion frame thumbnail ─────────────────────────────────────────────────
// Fetches a JPEG preview frame from the companion and hands it to the player
// as a persistent background bitmap.  The player's own drawFrame() renders it,
// so the timecode overlay updates correctly while the image stays stable across
// scrubs (unlike a direct canvas.drawImage which gets overwritten immediately).

let _companionThumbInFlight = false;
let _companionThumbLastKey  = '';   // avoid duplicate requests for same reel+frame+mode
let _companionThumbMode     = '';   // last preview mode used for thumb fetch; scroll handlers read this

async function _tryCompanionFrameThumb(cpl, absFrame = -1, previewMode = '') {
  if (!_imfSourcePackageId || !cpl?.id) return;
  if (_companionThumbInFlight) return;
  const fps = cpl.editRate || 24;
  const targetFrame = absFrame >= 0
    ? absFrame
    : Math.round((cpl.totalFrames || 0) * 0.08) || 0;
  // Include previewMode in key so mode changes always fetch a fresh thumb
  const reqKey = `${_imfSourcePackageId}:${cpl.id}:${targetFrame}:${previewMode || 'sdr'}`;
  if (reqKey === _companionThumbLastKey) return;
  _companionThumbInFlight = true;
  try {
    const payload = {
      action: 'getImfFrameThumb',
      packageId: _imfSourcePackageId,
      cplId: cpl.id,
      frame: targetFrame,
      width: 854,
      height: 480,
    };
    // Pass previewMode so the companion can apply appropriate tone mapping
    if (previewMode && previewMode !== 'sdr') payload.previewMode = previewMode;
    const bridged = await chrome.runtime.sendMessage({
      type: 'IMF_COMPANION_CALL',
      payload,
      timeoutMs: 65000,  // allow up to 60s for slow J2K full-res fallback
    }).catch(() => null);
    const res    = (bridged?.ok && bridged.response) ? bridged.response : null;
    const dataUrl = res?.data?.dataUrl || res?.dataUrl || '';
    if (!dataUrl || !dataUrl.startsWith('data:image')) return;
    // MV3 CSP blocks fetch() on data: URLs — decode base64 via atob() instead
    const [hdr, b64] = dataUrl.split(',');
    const mime = (hdr.match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const raw  = atob(b64 || '');
    const u8   = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    const blob   = new Blob([u8], { type: mime });
    const bitmap = await createImageBitmap(blob);
    _companionThumbLastKey = reqKey;
    // Hand to the player — it sets S.frameBitmap and redraws
    playerSetCompanionThumb(bitmap, reqKey);
  } catch { /* best-effort — no preview is fine */ } finally {
    _companionThumbInFlight = false;
  }
}

// ── Multi-layer compare (Sprint 5 #3) ─────────────────────────────────────────
// The comparison layer = the single soloed inactive CPL (from #2). Exactly one
// soloed (and it's not the live CPL) → compare it against the live picture.
function _compareCplEntry() {
  if (_layerSolo.size !== 1) return null;
  const key = [..._layerSolo][0];
  if (key === _currentCplKey) return null;   // can't compare the live layer to itself
  return _cplEntries.find(e => e.key === key) || null;
}

let _compareThumbInFlight = false;
let _compareThumbLastKey  = '';

// Fetch the comparison CPL's frame (same companion path as the main viewer) and
// hand it to the player's compare overlay. Best-effort: failure just leaves the
// previous comparison frame (or none) — never disturbs the live picture.
async function _tryCompareFrameThumb(cpl, absFrame = -1, previewMode = '') {
  if (!_imfSourcePackageId || !cpl?.id) return;
  if (_compareThumbInFlight) return;
  const targetFrame = absFrame >= 0 ? absFrame : 0;
  const reqKey = `cmp:${_imfSourcePackageId}:${cpl.id}:${targetFrame}:${previewMode || 'sdr'}`;
  if (reqKey === _compareThumbLastKey) return;
  _compareThumbInFlight = true;
  try {
    const payload = { action: 'getImfFrameThumb', packageId: _imfSourcePackageId, cplId: cpl.id, frame: targetFrame, width: 854, height: 480 };
    if (previewMode && previewMode !== 'sdr') payload.previewMode = previewMode;
    const bridged = await chrome.runtime.sendMessage({ type: 'IMF_COMPANION_CALL', payload, timeoutMs: 65000 }).catch(() => null);
    const res     = (bridged?.ok && bridged.response) ? bridged.response : null;
    const dataUrl = res?.data?.dataUrl || res?.dataUrl || '';
    if (!dataUrl || !dataUrl.startsWith('data:image')) return;
    const [hdr, b64] = dataUrl.split(',');
    const mime = (hdr.match(/:(.*?);/) || [])[1] || 'image/jpeg';
    const raw  = atob(b64 || '');
    const u8   = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([u8], { type: mime }));
    _compareThumbLastKey = reqKey;
    playerSetCompareFrame(bitmap);
  } catch { /* best-effort */ } finally {
    _compareThumbInFlight = false;
  }
}

// Sync the player's compare overlay to the current solo/playhead state. Called
// from renderTimeline (solo change) and the seek handler (playhead move).
function _syncCompareOverlay(absFrame) {
  const cmp = _compareCplEntry();
  if (!cmp) {
    if (playerGetCompareState().enabled) playerSetCompare({ enabled: false });
    _compareThumbLastKey = '';
    return;
  }
  const role = cmp.shortLabel || (cmp.isSupplemental ? 'VF' : 'OV');
  playerSetCompare({ enabled: true, label: role });
  const frame = Number.isFinite(absFrame) ? absFrame : (_tlNav?.playheadAbs ?? 0);
  _tryCompareFrameThumb(cmp.cpl, frame, _companionThumbMode);
}

async function discoverImfPackages(files, globalFileMap) {
  const isAssetMap = rel => /(^|\/)(assetmap)(\.xml)?$/i.test(rel);
  const roots = [...new Set(files.map(relPathOf).filter(isAssetMap).map(rel => rel.split('/').slice(0, -1).join('/')))].sort();
  const effectiveRoots = roots.length ? roots : [''];
  const allPackages = [];
  const assetIndex = new Map();

  const makeLookup = (map) => (path, mapOverride = map) => {
    if (!path || !mapOverride) return undefined;
    const raw = String(path);
    return mapOverride.get(raw) || mapOverride.get(raw.toLowerCase()) ||
      mapOverride.get(raw.replace(/^\.\//, '').replace(/^\//, '').replace(/\\/g, '/')) ||
      mapOverride.get(raw.replace(/^\.\//, '').replace(/^\//, '').replace(/\\/g, '/').toLowerCase());
  };

  for (const root of effectiveRoots) {
    const localFiles = root
      ? files.filter(f => { const rel = relPathOf(f); return rel === root || rel.startsWith(root + '/'); })
      : files;
    if (!localFiles.length) continue;
    const localMap = buildRelinkFileMap(localFiles);
    const fmGet = (path, map = localMap) => {
      if (!path || !map) return undefined;
      const raw = String(path);
      const direct = map.get(raw) || map.get(raw.toLowerCase());
      if (direct) return direct;
      const norm = raw.replace(/^\.\//, '').replace(/^\//, '').replace(/\\/g, '/');
      const base = norm.split('/').pop() || '';
      const stem = base.replace(/\.[^.]+$/, '');
      return map.get(norm) || map.get(norm.toLowerCase()) || map.get(base) || map.get(base.toLowerCase()) || map.get(stem) || map.get(stem.toLowerCase()) ||
             globalFileMap.get(norm) || globalFileMap.get(norm.toLowerCase()) || globalFileMap.get(base) || globalFileMap.get(base.toLowerCase()) || globalFileMap.get(stem) || globalFileMap.get(stem.toLowerCase());
    };

    const amFile = localFiles.find(f => isAssetMap(relPathOf(f)));
    if (!amFile) continue;
    const assetMapXml = await amFile.text();
    const assetMap = parseAssetMap(assetMapXml);
    const pklEntry = Object.values(assetMap.assets).find(a => a.isPKL);
    let pklFile = pklEntry ? (fmGet(pklEntry.path) || fmGet(pklEntry.id)) : null;
    if (!pklFile) pklFile = localFiles.find(f => /(^|\/).*pkl.*\.xml$/i.test(relPathOf(f))) || localFiles.find(f => /(^|\/)(packinglist)(\.xml)?$/i.test(relPathOf(f)));
    if (!pklFile) continue;
    const pklXml = await pklFile.text();
    const pkl = parsePKL(pklXml);
    for (const [id, asset] of Object.entries(pkl.assets)) {
      const am = assetMap.assets[id];
      if (am?.path && !asset.assetMapPath) asset.assetMapPath = am.path;
      assetIndex.set(id, { ...asset, id, packageRoot: root });
    }

    const packageName = (root.split('/').pop() || pkl.annotation || assetMap.annotation || 'Package').trim();
    const cpls = [];
    for (const asset of Object.values(pkl.assets)) {
      if (!/xml/i.test(asset.type || '') && !/\.xml$/i.test(asset.file || asset.assetMapPath || '')) continue;
      const cplFile = fmGet(asset.file) || fmGet(asset.assetMapPath) || fmGet(asset.id);
      if (!cplFile) continue;
      const text = await cplFile.text();
      if (!text.includes('CompositionPlaylist')) continue;
      const cpl = parseCPL(text);
      const cplXml = text;
      const missingVideoRefs = cpl.videoResources.filter(r => !pkl.assets[r.trackFileId]).length;
      const missingAudioRefs = cpl.audioResources.filter(r => !pkl.assets[r.trackFileId]).length;
      const playableReels = cpl.videoResources.filter(r => !!(fmGet((pkl.assets[r.trackFileId] || {}).file) || fmGet((pkl.assets[r.trackFileId] || {}).assetMapPath) || fmGet(r.trackFileId))).length;
      const shortLabel = (cpl.contentTitle || cpl.annotation || cpl.id.slice(0, 8)).trim();
      cpls.push({
        key: `${root || '.'}::${cpl.id}`,
        root, packageName, assetMap, pkl, cpl, fileMap: globalFileMap, fmGet, assetIndex,
        rawXml: { cpl: cplXml, pkl: pklXml, assetMap: assetMapXml },
        isSupplemental: (missingVideoRefs + missingAudioRefs) > 0 || /supplement/i.test(packageName),
        missingVideoRefs, missingAudioRefs, playableReels, shortLabel,
      });
    }
    allPackages.push({ root, packageName, assetMap, pkl, cpls });
  }
  const cpls = allPackages.flatMap(p => p.cpls).sort((a, b) => a.root.localeCompare(b.root) || a.shortLabel.localeCompare(b.shortLabel));
  return { packages: allPackages, cpls, assetIndex };
}

// ── Drop zone wiring ──────────────────────────────────────────────────────────
function wireDropZone() {
  // Accept drops on the drop zone inner element AND the whole shell (for convenience)
  const shell = document.getElementById('main-imf');
  const dz    = $('imfDropZone');
  if (!shell) return;

  shell.addEventListener('dragover', e => {
    e.preventDefault();
    if (dz) dz.classList.add('imf-dz-hover');
  });
  shell.addEventListener('dragleave', e => {
    if (!shell.contains(e.relatedTarget)) {
      if (dz) dz.classList.remove('imf-dz-hover');
    }
  });
  shell.addEventListener('drop', async e => {
    e.preventDefault();
    if (dz) dz.classList.remove('imf-dz-hover');
    await loadFromDrop(e.dataTransfer.items);
  });
}

// ── Import status/error helpers for the empty-state card ─────────────────────
function _setImportStatus(msg) {
  const el = document.getElementById('imfImportStatus');
  if (el) el.textContent = msg || '';
}
function _setImportError(msg) {
  const el = document.getElementById('imfImportError');
  if (el) el.textContent = msg || '';
}
function _clearImportFeedback() { _setImportStatus(''); _setImportError(''); }

function wireBrowseBtn() {
  const btn = $('imfBrowseBtn');
  const inp = $('imfFolderInput');
  if (!btn) return;

  // Ensure correct type so no form submission occurs
  btn.type = 'button';

  // ── Helper: companion load (called AFTER the picker to avoid breaking the user gesture) ──
  const tryCompanionLoad = async () => {
    try {
      const picked = await imfPickFolderCompanion();
      if (!picked) return { handled: true };
      if (!picked?.snapshot) return { handled: false };
      _clearImportFeedback();
      setStatus('loading', 'Parsing IMF package…');
      showPanel('imfPanelLoading');
      _imfSourceDirHandle = null;
      _restoreImfSnapshot({
        ...picked.snapshot,
        source: {
          ...(picked.snapshot.source || {}),
          folderName: picked.snapshot?.source?.folderName || '',
          folderPath: picked.folderPath || picked.folder || '',
          backend: 'companion',
          packageId: picked.packageId || '',
        },
      });
      try { window.__PFX_IMF_STATE = _buildImfProjectState(); } catch {}
      try { window.MPS_markProjectDirty?.('imf'); } catch {}
      return { handled: true };
    } catch (e) {
      if (e?.code === 'CANCELLED') return { handled: true };
      if (!e?.code || (e.code !== 'host_unavailable' && e.code !== 'HOST_DISCONNECTED')) {
        console.warn('[IMF] companion package load failed', e);
      }
      return { handled: false };
    }
  };

  // ── File System Access API path ───────────────────────────────────────────
  // CRITICAL: showDirectoryPicker() MUST be called synchronously/first in the
  // click handler — any await before it breaks the user-gesture chain in Chrome.
  if (typeof window.showDirectoryPicker === 'function') {
    btn.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      _clearImportFeedback();

      if (window.PFX_DEBUG_IMF_IMPORT) console.log('[PFX IMF Import] Import button clicked — trying showDirectoryPicker');

      // Step 1: open picker IMMEDIATELY (user gesture is still live here)
      let dirHandle;
      try {
        _setImportStatus('Opening folder picker…');
        dirHandle = await window.showDirectoryPicker({ mode: 'read' });
        _setImportStatus('Scanning IMF package…');
      } catch (err) {
        if (err?.name === 'AbortError') {
          _setImportStatus('');
          return; // user cancelled — not an error
        }
        console.warn('[IMF] showDirectoryPicker failed, falling back to companion then webkitdirectory', err);
        _setImportError('Folder picker unavailable — trying companion…');
        // Step 1b: picker unavailable — try companion load instead
        const companion = await tryCompanionLoad();
        if (companion.handled) { _clearImportFeedback(); return; }
        // Step 1c: final fallback to webkitdirectory
        _setImportStatus('Using browser fallback…');
        if (inp) inp.click();
        return;
      }

      if (window.PFX_DEBUG_IMF_IMPORT) console.log('[PFX IMF Import] selected folder:', dirHandle.name);

      // Step 2: collect files
      const files = [];
      try {
        await _collectHandleDir(dirHandle, files, dirHandle.name);
      } catch (err2) {
        console.warn('[IMF] directory read error', err2);
        _setImportError('Cannot read folder. Try drag-and-drop.');
        if (inp) inp.click();
        return;
      }

      if (window.PFX_DEBUG_IMF_IMPORT) {
        const hasAM = files.some(f => /^ASSETMAP(\.xml)?$/i.test(f.name));
        console.log(`[PFX IMF Import] scanned ${files.length} files, ASSETMAP found=${hasAM}`);
      }

      if (!files.length) {
        _setImportError('Folder appears empty. Please select the root IMF package folder.');
        return;
      }

      // Step 3: validate and show confirm
      _setImportStatus('');
      _showImfConfirm(dirHandle.name, files, dirHandle);
    };
    // Wire webkitdirectory fallback input separately
    if (inp) {
      inp.onchange = async e => {
        if (e.target.files?.length) {
          _setImportStatus('Scanning…');
          await loadFromFileList(Array.from(e.target.files));
          _clearImportFeedback();
        }
        inp.value = '';
      };
    }
    return;
  }

  // ── Fallback: webkitdirectory (no File System Access API) ────────────────
  if (!inp) return;
  btn.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    _clearImportFeedback();
    // Try companion first (companion check is fine here since we're not calling showDirectoryPicker)
    const companion = await tryCompanionLoad();
    if (companion.handled) { _clearImportFeedback(); return; }
    inp.click();
  };
  inp.onchange = async e => {
    if (e.target.files?.length) {
      _setImportStatus('Scanning…');
      await loadFromFileList(Array.from(e.target.files));
      _clearImportFeedback();
    }
    inp.value = '';
  };
}

// Recursively collect File objects from a FileSystemDirectoryHandle
async function _collectHandleDir(dirHandle, files, relativePath) {
  for await (const [name, handle] of dirHandle.entries()) {
    const relPath = relativePath ? `${relativePath}/${name}` : name;
    if (handle.kind === 'file') {
      const f = await handle.getFile();
      try { Object.defineProperty(f, 'webkitRelativePath', { value: relPath, configurable: true }); } catch {}
      try { Object.defineProperty(f, '__pfxRelPath', { value: relPath, configurable: true }); } catch { f.__pfxRelPath = relPath; }
      files.push(f);
    } else if (handle.kind === 'directory') {
      await _collectHandleDir(handle, files, relPath);
    }
  }
}

function buildRelinkFileMap(files) {
  const map = new Map();
  const put = (key, file) => {
    if (!key) return;
    const k = String(key).replace(/^\.\//, '').replace(/^\//, '');
    map.set(k, file);
    map.set(k.toLowerCase(), file);
  };
  for (const f of files) {
    const rel = relPathOf(f);
    const base = String(f.name || '').trim();
    const stem = base.replace(/\.[^.]+$/, '');
    put(rel, f);
    put(base, f);
    put(stem, f);
    const relNoRoot = rel.split('/').slice(1).join('/');
    if (relNoRoot) put(relNoRoot, f);
    const uuidish = stem.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    if (uuidish) put(uuidish[0], f);
  }
  return map;
}

async function pickExternalFolderFiles() {
  if (typeof window.showDirectoryPicker === 'function') {
    const dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    const files = [];
    await _collectHandleDir(dirHandle, files, dirHandle.name);
    return files;
  }
  return await new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.webkitdirectory = true;
    inp.style.display = 'none';
    document.body.appendChild(inp);
    inp.onchange = () => { const out = Array.from(inp.files || []); inp.remove(); resolve(out); };
    inp.click();
  });
}

function updateRelinkBtn() {
  const btn = $('imfRelinkBtn');
  if (!btn) return;
  if (!_pkg?.cpl?.videoResources?.length) { btn.style.display = 'none'; return; }
  const missing = _pkg.cpl.videoResources.some(res => !_getReelFile(res));
  btn.style.display = missing ? '' : 'none';
  btn.textContent = _extFiles.length ? 'Relinked' : 'Relink';
  btn.title = _extFiles.length ? 'External IMF track folder linked' : 'Link external IMF track files';
}

function _refreshPkgViews() {
  if (!_pkg?.cpl) return;
  const colorMap = new Map();
  for (const r of _pkg.cpl.videoResources) {
    if (!colorMap.has(r.trackFileId)) {
      colorMap.set(r.trackFileId, _uuidToHex(r.trackFileId));
    }
  }
  renderKPI();
  renderValidation();
  renderTimeline();
  renderReelTable(_pkg.cpl, colorMap);
  renderAssetList(_pkg.cpl, colorMap);
  updateRelinkBtn();
}

// Show PostFlowX-styled folder confirmation modal
let _pendingImfFiles = null;
let _pendingImfHandle = null;
function _showImfConfirm(folderName, files, dirHandle = null) {
  _pendingImfFiles = files;
  _pendingImfHandle = dirHandle || null;
  const modal   = $('imfFolderConfirm');
  const title   = $('imfConfirmTitle');
  const desc    = $('imfConfirmDesc');
  const btnOK   = $('imfConfirmLoad');
  const btnCancel = $('imfConfirmCancel');
  if (!modal) { loadFromFileList(files, { sourceHandle: dirHandle, sourceFolderName: folderName }); return; }

  const mxf  = files.filter(f => f.name.toLowerCase().endsWith('.mxf')).length;
  const xml  = files.filter(f => f.name.toLowerCase().endsWith('.xml')).length;
  const total = files.length;

  if (title) title.textContent = folderName;
  if (desc) desc.innerHTML =
    `<strong>${total}</strong> file${total !== 1 ? 's' : ''} found ` +
    `<span class="pfx-confirm-pill">${xml} XML</span> ` +
    `<span class="pfx-confirm-pill">${mxf} MXF</span>` +
    `<br><span class="pfx-confirm-hint">All processing is local — no data leaves your machine.</span>`;

  modal.style.display = 'flex';
  btnOK?.focus();

  if (btnOK) btnOK.onclick = async () => {
    modal.style.display = 'none';
    if (_pendingImfFiles) {
      await loadFromFileList(_pendingImfFiles, { sourceHandle: _pendingImfHandle, sourceFolderName: folderName });
      _pendingImfFiles = null;
      _pendingImfHandle = null;
    }
  };
  if (btnCancel) btnCancel.onclick = () => {
    modal.style.display = 'none';
    _pendingImfFiles = null;
    _pendingImfHandle = null;
  };
  modal.onclick = e => {
    if (e.target === modal) {
      modal.style.display = 'none';
      _pendingImfFiles = null;
      _pendingImfHandle = null;
    }
  };
}

function wireRelinkBtn() {
  const btn = $('imfRelinkBtn');
  if (!btn) return;
  btn.onclick = async () => {
    if (!_pkg) return;
    try {
      const files = await pickExternalFolderFiles();
      if (!files?.length) return;
      _extFiles = files;
      _extFileMap = buildRelinkFileMap(files);
      _refreshPkgViews();
      if (_currentCplKey) applyCompositionByKey(_currentCplKey);
      const playable = _pkg?.cpl?.videoResources?.filter(res => !!_getReelFile(res)).length || 0;
      const total = _pkg?.cpl?.videoResources?.length || 0;
      setStatus(playable ? 'ok' : 'warn', `Loaded:  · ${playable}/${total} playable reel(s) · relinked`);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      console.error('[IMF] relink failed', err);
      setStatus('error', 'Relink failed: ' + (err?.message || err));
    }
  };
}

function wireHashBtn() {
  const btn = $('imfHashBtn');
  if (!btn) return;
  btn.onclick = runHashVerification;
}

function wireExportBtn() {
  const btn = $('imfExportBtn');
  if (!btn) return;
  btn.onclick = () => {
    if (typeof window.__rqAddJob === 'function') {
      const title = _pkg?.cpl?.contentTitle || 'IMF_Package';
      const stem  = title.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
      window.__rqAddJob('report', `IMF Report — ${stem}`, { fmt: 'report', stem, module: 'imf' });
      try { window.setMainTab('renderq'); } catch {}
    } else {
      exportReport();
    }
  };
}

function wireClearBtn() {
  const btn = $('imfClearBtn');
  if (!btn) return;
  btn.onclick = async () => {
    clearPackage();
    try{ await window.PFX_clearAllTabs?.(); }catch{}
  };
}

// ── Load from drag-drop items ─────────────────────────────────────────────────
async function loadFromDrop(items) {
  const files = [];
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      await collectDir(entry, files, entry.name);
    } else {
      const f = item.getAsFile();
      if (f) {
        try { Object.defineProperty(f, 'webkitRelativePath', { value: f.name, configurable: true }); } catch {}
        try { Object.defineProperty(f, '__pfxRelPath', { value: f.name, configurable: true }); } catch { f.__pfxRelPath = f.name; }
        files.push(f);
      }
    }
  }
  await loadFromFileList(files);
}

async function collectDir(dirEntry, files, relBase = '') {
  // readEntries may return batches of up to 100 — call until empty
  const reader = dirEntry.createReader();
  const entries = await new Promise(resolve => {
    const all = [];
    function readBatch() {
      reader.readEntries(batch => {
        if (!batch.length) return resolve(all);
        all.push(...batch);
        readBatch();
      });
    }
    readBatch();
  });
  for (const entry of entries) {
    const relPath = relBase ? relBase + '/' + entry.name : entry.name;
    if (entry.isFile) {
      const f = await new Promise(res => entry.file(res));
      try { Object.defineProperty(f, 'webkitRelativePath', { value: relPath, configurable: true }); } catch {}
      try { Object.defineProperty(f, '__pfxRelPath', { value: relPath, configurable: true }); } catch { f.__pfxRelPath = relPath; }
      files.push(f);
    } else if (entry.isDirectory) {
      await collectDir(entry, files, relPath);
    }
  }
}

// ── Core loader ───────────────────────────────────────────────────────────────
async function loadFromFileList(files, opts = {}) {
  const sourceHandle = opts?.sourceHandle || null;
  const sourceFolderName = String(opts?.sourceFolderName || sourceHandle?.name || '').trim();
  const restoreState = opts?.restoreState || null;
  setStatus('loading', 'Parsing IMF package…');
  _extFiles = [];
  _extFileMap = new Map();
  showPanel('imfPanelLoading');

  try {
    if (!Array.isArray(files) || !files.length) throw new Error('No files found in selected IMF package');
    // Build filename → File map across the entire selected folder tree.
    const fileMap = buildRelinkFileMap(files);

    const discovered = await discoverImfPackages(files, fileMap);
    _imfPackages = discovered.packages || [];
    _cplEntries = discovered.cpls || [];
    if (!_cplEntries.length) throw new Error('No CompositionPlaylist XML found in selected IMF package(s)');

    const defaultBase = _cplEntries.find(e => !e.isSupplemental) || _cplEntries[0];
    _baseCplKey = _cplEntries.some(e => e.key === restoreState?.baseCplKey)
      ? restoreState.baseCplKey
      : (defaultBase?.key || '');
    _currentCplKey = _cplEntries.some(e => e.key === restoreState?.currentCplKey)
      ? restoreState.currentCplKey
      : ((_cplEntries.find(e => e.isSupplemental) || defaultBase || _cplEntries[0])?.key || '');
    _showBaseOverlay = !!restoreState?.showBaseOverlay;
    _imfSourceDirHandle = sourceHandle || null;
    _imfSourceFolderName = sourceFolderName;
    _imfSourceBackend = sourceHandle ? 'browser' : '';
    _imfSourcePackageId = '';

    // In Electron, dragged/dropped File objects carry a native `.path` property.
    // Derive the package root folder from the ASSETMAP.xml native path so the
    // IMF demuxer path (ffmpeg -f imf -assetmaps ...) can be used even when the
    // user loaded files via drag-drop instead of the companion folder picker.
    _imfSourceFolderPath = '';
    _imfAllPackageFolderPaths = [];
    if (typeof window.pfxPlatform?.imf?.preparePackage === 'function') {
      const assetMapFiles = files.filter(f => /^assetmap(\.xml)?$/i.test(f.name));
      for (const am of assetMapFiles) {
        // Electron 42+ removed the non-standard file.path property; use getNativeFilePath instead.
        const nativePath = (typeof window.pfxPlatform?.getNativeFilePath === 'function' ? window.pfxPlatform.getNativeFilePath(am) : null)
                        || (typeof am.__pfxNativePath === 'string' && am.__pfxNativePath.length > 3 ? am.__pfxNativePath : '')
                        || (typeof am.path === 'string' && am.path.length > 3 ? am.path : '');
        if (!nativePath) continue;
        const sep = nativePath.includes('\\') ? '\\' : '/';
        const parts = nativePath.split(sep);
        parts.pop();
        const fp = parts.join(sep) || '/';
        if (fp && !_imfAllPackageFolderPaths.includes(fp)) _imfAllPackageFolderPaths.push(fp);
      }
      if (_imfAllPackageFolderPaths.length > 0) {
        _imfSourceFolderPath = _imfAllPackageFolderPaths[0];
        console.log(`[IMF] Electron native folders detected (${_imfAllPackageFolderPaths.length}): ${_imfAllPackageFolderPaths.join(', ')}`);
      }
    }

    // Rebind global asset index to every CPL entry so supplemental CPLs can resolve base assets.
    _cplEntries = _cplEntries.map(entry => ({ ...entry, fileMap, assetIndex: discovered.assetIndex }));
    _imfPackages = _imfPackages.map(pkg => ({
      ...pkg,
      cpls: (pkg.cpls || []).map(entry => _cplEntries.find(c => c.key === entry.key) || entry),
    }));

    if (_imfSourceDirHandle) storeNamedHandle(_imfHandleKey(), _imfSourceDirHandle).catch(() => {});

    showPanel('imfPanelMain');
    // Await composition apply so any render error is caught by this try/catch and
    // surfaced as an error state — otherwise an async throw leaves the UI frozen
    // on the "Parsing…" status with empty panels (looks like "nothing loaded").
    await applyCompositionByKey(_currentCplKey);
    setImfLeftTab(restoreState?.activeLeftTab || _imfActiveLeftTab || 'validation');
    try { window.__PFX_IMF_STATE = _buildImfProjectState(); } catch {}
    try { window.MPS_markProjectDirty?.('imf'); } catch {}
    if (restoreState) _tryRestoreProxySession();
  } catch (err) {
    setStatus('error', 'Load failed: ' + err.message);
    showPanel('imfPanelEmpty');
    console.error('[IMF]', err);
  }
}

// ── KPI panel ─────────────────────────────────────────────────────────────────
function renderKPI() {
  if (!_pkg) return; // guard: proxy-only flow and pre-load paths may call renderKPI before a package is set
  const { cpl, pkl, assetMap } = _pkg;
  const kpi = $('imfKPI');
  if (!kpi) return;

  const _audioRes = cpl.audioResources || [];
  const audioLabel = cpl.hasIAB
    ? `IAB (Dolby Atmos) · ${(cpl.iabResources?.length || _audioRes.length || 0)} resource(s)`
    : _audioRes.length ? `${_audioRes.length} track(s)` : 'None';

  const rows = [
    ['Package',      _pkg.bundleLabel || _pkg.packageName || '–'],
    ['CPL',          _cplEntries.length > 1 ? (_cplEntries.find(e => e.key === _currentCplKey)?.shortLabel || cpl.contentTitle || cpl.annotation || '–') : (cpl.contentTitle || cpl.annotation || '–')],
    ['Title',        cpl.contentTitle || cpl.annotation || '–'],
    ['Content Kind', cpl.contentKind  || '–'],
    ['App Version',  cpl.appVersion   || '–'],
    ['Codec',        cpl.codec        || '–'],
    ['Resolution',   `${cpl.resolution.w} × ${cpl.resolution.h}`],
    ['Bit Depth',    cpl.bitDepth !== '–' ? `${cpl.bitDepth}-bit` : '–'],
    ['Edit Rate',    `${cpl.editRate} fps`],
    ['Duration',     fmtFrames(cpl.totalFrames, cpl.editRate)],
    ['Transfer',     cpl.transfer],
    ['Primaries',    cpl.primaries],
    ['Dolby Vision', cpl.isDolbyVision
      ? (() => {
          const shots = _doviMetafierShots;
          if (!shots?.length) return '<span class="imf-badge-dv">DV</span> Yes';
          const warns = validateDoviShots(shots);
          const errs = warns.filter(w => w.severity === 'error').length;
          const badge = errs ? ' <span style="color:#f55;font-size:9px">✕</span>'
                      : warns.length ? ' <span style="color:#f7c26a;font-size:9px">⚠</span>'
                      : ' <span style="color:#4caf80;font-size:9px">✓</span>';
          return `<span class="imf-badge-dv">DV</span> ${shots.length} shots${badge}`;
        })()
      : 'No'],
    ['Audio',        audioLabel],
    ...(cpl.hasIAB ? [['IAB Resources', String(cpl.iabResources?.length || (cpl.audioResources || []).length || 0)]] : []),
    ...(cpl.hasIAB ? [['IAB Sequences', String(cpl.iabSequences?.length || 0)]] : []),
    ...(cpl.hasIAB ? [['IAB Decode', _iabDecodeCaps.loading ? 'Checking…' : (_iabDecodeCaps.ready ? `Ready · ${_iabDecodeCaps.engineLabel || _iabDecodeCaps.engineId || 'local engine'}` : 'Unavailable')]] : []),
    ['Video Segs',   `${cpl.videoResources.length}`],
    ['Issuer',       cpl.issuer || assetMap.issuer || '–'],
    ['Creator',      cpl.creator || assetMap.creator || '–'],
    ['Issue Date',   (cpl.issueDate || '').replace('T', ' ').slice(0,19)],
    ['CPL ID',       `<span class="imf-uuid">${cpl.id}</span>`],
    ['PKL ID',       `<span class="imf-uuid">${pkl.id}</span>`],
  ];

  kpi.innerHTML = rows.map(([k,v]) =>
    `<div class="imf-kpi-row"><span class="imf-kpi-key">${k}</span><span class="imf-kpi-val">${v}</span></div>`
  ).join('');

  // Inject Netflix compliance panel above KPI rows (or after, if already present)
  let nxPanel = $('imfNetflixCheck');
  if (!nxPanel) {
    nxPanel = document.createElement('div');
    nxPanel.id = 'imfNetflixCheck';
    nxPanel.className = 'imf-nx-panel';
    kpi.parentNode?.insertBefore(nxPanel, kpi);
  }

  // Inject ADM tree panel after IAB Audio section header (or above IAB section)
  let admPanel = $('imfAdmTreePanel');
  if (!admPanel) {
    admPanel = document.createElement('div');
    admPanel.id = 'imfAdmTreePanel';
    admPanel.className = 'imf-adm-tree-panel';
    admPanel.style.display = 'none';
    // Insert before the KPI grid so it shows in the left panel
    kpi.parentNode?.insertBefore(admPanel, kpi.nextSibling);
  }

  _renderNetflixCompliance();
  _renderAdmTreePanel();
}

// ── Validation panel ──────────────────────────────────────────────────────────
let _valFilterSev  = 'all';
let _valFilterText = '';

function _applyValFilter() {
  const list = $('imfValList');
  if (!list) return;
  const sev  = _valFilterSev;
  const txt  = (_valFilterText || '').toLowerCase().trim();

  const groups = [
    { prefix: 'SCHEMA', label: 'Schema / Namespace Conformance' },
    { prefix: 'AM',   label: 'Asset Map' },
    { prefix: 'PKL',  label: 'Packing List' },
    { prefix: 'CPL',  label: 'Composition Playlist' },
    { prefix: 'AUD',  label: 'Audio Intelligence' },
    { prefix: 'PIC',  label: 'Picture Quality' },
    { prefix: 'HDR',  label: 'HDR / Mastering Display' },
    { prefix: 'REEL', label: 'Inter-Reel Consistency' },
    { prefix: 'TC',   label: 'Timecode' },
    { prefix: 'APP',  label: 'Application / Delivery Logic' },
    { prefix: 'UG-',  label: 'IMF User Group Best Practice' },
    { prefix: 'PHOTON', label: 'Photon (Netflix/SMPTE)' },
    { prefix: 'HASH', label: 'Hash Verification' },
    { prefix: 'VAL',  label: 'Validation Engine Errors' },
  ];
  const icon = { pass:'✓', warn:'⚠', fail:'✗', info:'ℹ' };
  const sevWeight = { fail: 3, warn: 2, info: 1, pass: 0 };

  // Apply filter + search
  const filtered = _valResults.filter(r => {
    if (sev !== 'all' && r.sev !== sev) return false;
    if (txt) {
      const haystack = `${r.code} ${r.msg} ${r.detail || ''}`.toLowerCase();
      if (!haystack.includes(txt)) return false;
    }
    return true;
  });

  let html = '';
  for (const { prefix, label } of groups) {
    const rows = filtered.filter(r => r.code.startsWith(prefix));
    if (!rows.length) continue;

    const gc = { pass:0, warn:0, fail:0, info:0 };
    for (const r of rows) gc[r.sev] = (gc[r.sev] || 0) + 1;
    const highest = rows.reduce((m, r) => Math.max(m, sevWeight[r.sev] || 0), 0);
    const groupSev = highest >= 3 ? 'fail' : highest >= 2 ? 'warn' : highest >= 1 ? 'info' : 'pass';
    const defaultOpen = !!(txt || sev !== 'all');
    const badgeBits = [
      gc.fail ? `<span class="imf-val-gbadge sev-fail">${gc.fail}</span>` : '',
      gc.warn ? `<span class="imf-val-gbadge sev-warn">${gc.warn}</span>` : '',
      gc.info ? `<span class="imf-val-gbadge sev-info">${gc.info}</span>` : '',
      gc.pass ? `<span class="imf-val-gbadge sev-pass">${gc.pass}</span>` : '',
    ].filter(Boolean).join('');

    html += `<details class="imf-val-section sev-${groupSev}" ${defaultOpen ? 'open' : ''}>`;
    html += `
      <summary class="imf-val-group">
        <span class="imf-val-group-left">
          <span class="imf-val-caret">▾</span>
          <span class="imf-val-group-label">${label}</span>
        </span>
        <span class="imf-val-group-right">
          <span class="imf-val-group-count">${rows.length}</span>
          ${badgeBits}
        </span>
      </summary>`;
    html += `<div class="imf-val-section-body">`;
    html += rows.map(r => {
      const jump = r.ref
        ? `<button type="button" class="imf-val-jump" data-val-ref="${_esc(JSON.stringify(r.ref))}" title="Jump to this reel on the timeline">→ timeline</button>`
        : '';
      return `
      <div class="imf-val-row sev-${r.sev}">
        <span class="imf-val-icon">${icon[r.sev] || '·'}</span>
        <span class="imf-val-code">${r.code}</span>
        <span class="imf-val-msg">${r.msg}${r.detail ? `<br><span class="imf-val-detail">${r.detail}</span>` : ''}${jump}</span>
      </div>`;
    }).join('');
    html += `</div></details>`;
  }

  if (!html && (sev !== 'all' || txt)) {
    html = `<div class="imf-val-empty">No checks match the current filter.</div>`;
  }
  list.innerHTML = html;

  // Wire the "→ timeline" jump controls (delegated; rebuilt each render).
  list.querySelectorAll('.imf-val-jump').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      let ref = null;
      try { ref = JSON.parse(btn.dataset.valRef || 'null'); } catch {}
      _focusTimelineResource(ref);
    });
  });
}

function renderValidation() {
  const list = $('imfValList');
  if (!list) return;

  const counts = { pass:0, warn:0, fail:0, info:0 };
  for (const r of _valResults) counts[r.sev] = (counts[r.sev]||0)+1;

  // Summary chips (overall verdict + per-sev counts)
  const summary = $('imfValSummary');
  if (summary) {
    const overall = counts.fail > 0 ? 'FAIL' : counts.warn > 0 ? 'WARN' : 'PASS';
    const overallCls = { PASS:'chip-pass', WARN:'chip-warn', FAIL:'chip-fail' }[overall];
    const totalChecks = _valResults.length;
    summary.innerHTML =
      `<span class="imf-chip ${overallCls} chip-overall">${overall}</span>` +
      `<span class="imf-chip chip-info chip-total" title="${totalChecks} checks run">${totalChecks} checks</span>` +
      `<span class="imf-chip chip-pass" title="Passed checks">✓ ${counts.pass}</span>` +
      (counts.fail ? `<span class="imf-chip chip-fail" title="Failed checks">✗ ${counts.fail}</span>` : '') +
      (counts.warn ? `<span class="imf-chip chip-warn" title="Warnings">⚠ ${counts.warn}</span>` : '') +
      (counts.info ? `<span class="imf-chip chip-info" title="Info items">ℹ ${counts.info}</span>` : '');
  }

  _applyValFilter();

  // Show hash + export buttons once a package is loaded
  const hashBtn = $('imfHashBtn');
  if (hashBtn) hashBtn.style.display = (_pkg && Object.keys(_pkg.pkl?.assets || {}).length > 1) ? 'inline-flex' : 'none';
  const expBtn = $('imfExportBtn');
  if (expBtn) expBtn.style.display = 'inline-flex';
}

function _wireValFilters() {
  // Filter chips
  document.querySelectorAll('.imf-val-fchip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.imf-val-fchip').forEach(c => c.classList.remove('imf-val-fchip-active'));
      chip.classList.add('imf-val-fchip-active');
      _valFilterSev = chip.dataset.filter || 'all';
      _applyValFilter();
    });
  });
  // Search input
  const search = $('imfValSearch');
  if (search) {
    search.addEventListener('input', () => {
      _valFilterText = search.value;
      _applyValFilter();
    });
  }
}

// ── SHA-1 hash verification ───────────────────────────────────────────────────
// P1-PROGRESS caller: run the essence-hash pass through the IMF Direct Engine's
// poll-based job API (openPackage → startJob('validate',{hash:true}) → poll →
// cancel) via runImfEngineJob(). Returns true if the engine handled the pass and
// its results were merged into _valResults; false when the engine/bridge/package
// path is unavailable so the caller can fall back to legacy in-renderer hashing.
async function _runHashVerificationViaEngine() {
  const eng = (typeof window !== 'undefined') && window.pfxPlatform && window.pfxPlatform.imfEngine;
  if (!eng || typeof eng.openPackage !== 'function' ||
      typeof eng.startJob !== 'function' || typeof eng.jobProgress !== 'function') {
    return false;                                   // older/absent bridge
  }
  const folderPath = _imfSourceFolderPath;
  if (!folderPath) return false;                    // no real package path (browser drop)

  // Open (or re-open) the package in the direct engine to obtain a packageId.
  let opened;
  try { opened = await eng.openPackage(folderPath); } catch { return false; }
  if (!opened || !opened.ok || !opened.packageId) return false;
  const packageId = opened.packageId;
  const cplId = (_pkg && _pkg.cpl && _pkg.cpl.id) ||
                opened.package?.activeCplId ||
                opened.package?.cpls?.[0]?.id || '';

  const container = $('imfValList');
  const ctl = runImfEngineJob('validate', { packageId, cplId, hash: true },
    { container, label: 'Verifying essence checksums' });

  // Expose the active controller so a Stop/teardown path could cancel it, and
  // so the poll driver's Cancel button is reachable.
  _imfHashJobCtl = ctl;
  let res;
  try { res = await ctl.done; } finally { _imfHashJobCtl = null; }
  if (!res || res.unavailable) return false;        // bridge said "unavailable" → fall back
  if (!res.ok) {
    // Engine ran but the job errored/lost — surface it rather than silently
    // falling back to a slower path that would likely hit the same failure.
    const hashRows = _valResults.filter(r => r.code !== 'HASH');
    hashRows.push({ sev: SEV.WARN, code: 'HASH', msg: `Hash verification could not complete: ${res.error || 'engine error'}`, detail: '' });
    _valResults = hashRows;
    renderValidation();
    return true;
  }

  // User hit Cancel (poll driver resolved with a non-running terminal state and
  // no result) — leave existing rows untouched and report the cancellation.
  if (res.snapshot && res.snapshot.state === 'cancelled') {
    const hashRows = _valResults.filter(r => r.code !== 'HASH');
    hashRows.push({ sev: SEV.INFO, code: 'HASH', msg: 'Hash verification cancelled', detail: '' });
    _valResults = hashRows;
    renderValidation();
    return true;
  }

  const validation = res.snapshot && res.snapshot.result;
  const checks = Array.isArray(validation?.checksumResults) ? validation.checksumResults : [];
  const hashRows = _valResults.filter(r => r.code !== 'HASH');
  if (checks.length === 0) {
    // No <Hash> present in the PKL (or none to verify) — informative, not a fail.
    const why = validation?.checksumStatus === 'no_hashes_in_pkl'
      ? 'PKL contains no essence Hash values — nothing to verify.'
      : 'No essence checksums were verified.';
    hashRows.push({ sev: SEV.INFO, code: 'HASH', msg: 'Hash verification', detail: why });
  } else {
    for (const c of checks) {
      const ok = c.status === 'ok' ? true : c.status === 'mismatch' ? false : null;
      hashRows.push({
        sev:  ok === true ? SEV.PASS : ok === false ? SEV.FAIL : SEV.WARN,
        code: 'HASH',
        msg:  ok === true ? `SHA-1 OK: ${c.name}` : ok === false ? `SHA-1 MISMATCH: ${c.name}` : `SHA-1 could not be verified: ${c.name}`,
        detail: ok === false && c.expected ? `expected ${c.expected}` : (c.error || ''),
      });
    }
  }
  _valResults = hashRows;
  renderValidation();
  return true;
}

async function runHashVerification() {
  if (_hashVerifying || !_pkg) return;
  _hashVerifying = true;
  const btn = $('imfHashBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }

  // Prefer the IMF Direct Engine's cancellable, progress-reporting hash pass
  // (P1-PROGRESS) when the desktop bridge + a real package folder are present.
  // It streams each essence file in the main process (no in-renderer GB reads),
  // renders a progress bar + Cancel affordance, and returns per-asset SHA-1
  // results we map into HASH rows. Any unavailability/failure falls through to
  // the legacy in-renderer hashing below so behaviour never regresses.
  try {
    const engineOk = await _runHashVerificationViaEngine();
    if (engineOk) {
      if (btn) { btn.disabled = false; btn.textContent = 'Verify Hashes'; }
      _hashVerifying = false;
      return;
    }
  } catch { /* fall through to in-renderer hashing */ }

  const { pkl, resolveFile, assetLabel } = _pkg;
  const hashResults = [];

  for (const [id, asset] of Object.entries(pkl.assets)) {
    if (!asset.hash) continue;
    const fh = _pkg.resolveFile(asset) || _pkg.resolveFile(id);
    if (!fh) continue;

    const list = $('imfValList');
    if (list) {
      const row = el('div', 'imf-val-row sev-info');
      row.innerHTML = `<span class="imf-val-icon">⟳</span><span class="imf-val-code">HASH</span><span class="imf-val-msg">Verifying ${assetLabel(asset)} (${(fh.size/1e9).toFixed(2)} GB)…</span>`;
      list.prepend(row);
    }

    const algorithm = detectHashAlgorithm(asset.hash);
    const nativePath = (window.pfxPlatform?.getNativeFilePath?.(fh))
      || (typeof fh.__pfxNativePath === 'string' ? fh.__pfxNativePath : '')
      || (typeof fh.path === 'string' ? fh.path : '');
    const ok = await verifyHash(fh, asset.hash, { algorithm, nativePath }, pct => {
      if (btn) btn.textContent = `Verifying ${Math.round(pct*100)}%`;
    });

    hashResults.push({ file: assetLabel(asset), ok, hash: asset.hash, algorithm });
  }

  // Remove the "Verifying…" rows and add results
  const hashRows = _valResults.filter(r => r.code !== 'HASH');
  for (const { file, ok, algorithm } of hashResults) {
    const algoLabel = algorithm === 'sha1' ? 'SHA-1' : 'SHA-256';
    hashRows.push({
      sev:  ok === true ? SEV.PASS : ok === false ? SEV.FAIL : SEV.WARN,
      code: 'HASH',
      msg:  ok === true ? `${algoLabel} OK: ${file}` : ok === false ? `${algoLabel} MISMATCH: ${file}` : `${algoLabel} could not be verified: ${file}`,
      detail: ok == null ? 'File too large for in-memory hashing and no native hash path available.' : '',
    });
  }
  _valResults = hashRows;
  renderValidation();

  if (btn) { btn.disabled = false; btn.textContent = 'Verify Hashes'; }
  _hashVerifying = false;
}

function wireTimelineControls() {
  if (_tlNav.bindingsReady) return;
  _tlNav.bindingsReady = true;
  // Bind ruler as a scrub target so clicking/dragging on tick marks also seeks
  const _rulerEl = $('imfTLRuler');
  if (_rulerEl) _bindTimelineOuter(_rulerEl);
  // Reel navigation from transport buttons (dispatched by imf_player.js)
  document.addEventListener('imf:reel-nav', e => {
    _seekTimelineToReelBoundary((e.detail?.dir || 0) > 0 ? 1 : -1);
  });
  document.addEventListener('imf:player-frame', e => {
    const d = e.detail || {};
    _tlNav.playheadAbs = Math.max(0, d.absFrame || 0);
    _ensurePlayheadInView();
    updateTimelinePlayhead();
    // Update reel indicator badge  "R5/13 · 44:23"
    _updateReelIndicator(d);
  });
  // Seamless multi-reel auto-advance: when the player reaches the end of a reel
  // it dispatches imf:reel-end; we load the next reel (by absolute frame) and keep
  // playing. No matching range → it was the last reel, so playback simply stops.
  document.addEventListener('imf:reel-end', e => {
    const { tcOffset, totalFrames } = e.detail || {};
    const nextAbsFrame = (tcOffset || 0) + (totalFrames || 0);
    const nextRange = (_tlNav.reelRanges || []).find(r => r.absStart === nextAbsFrame);
    if (!nextRange || !_pkg?.cpl) return;   // last reel — stop playback
    const asset = _pkg.pkl.assets[nextRange.res.trackFileId] || {};
    const mxfFile = _getReelFile(nextRange.res);
    audStop();   // halt this reel's audio before the next reel's PCM loads
    playerLoadReel(mxfFile, {
      reelNum:           nextRange.index + 1,
      totalFrames:       nextRange.res.sourceDuration,
      fps:               _pkg.cpl.editRate,
      tcOffset:          nextRange.absStart,
      dropFrame:         !!_pkg.cpl.compositionTimecode?.dropFrame,
      color:             nextRange.color,
      filename:          _pkg.assetLabel(asset) || nextRange.res.trackFileId,
      codec:             _pkg.cpl.codec || '–',
      resolution:        `${_pkg.cpl.resolution.w}×${_pkg.cpl.resolution.h}`,
      transfer:          _pkg.cpl.transfer || '–',
      primaries:         _pkg.cpl.primaries || '–',
      initialFrame:      0,
      autoPlay:          true,   // ← keep playing
      entryPoint:        nextRange.res.entryPoint || 0,
      intrinsicDuration: nextRange.res.intrinsicDuration || nextRange.res.sourceDuration,
      trackFileId:       nextRange.res.trackFileId || '',
      cplId:             _pkg.cpl.id || '',
      packageHash:       _pkg.packageHash || '',
      mxfPath:           (mxfFile ? (window.pfxPlatform?.getNativeFilePath?.(mxfFile) || '') : '')
                         || _imfElectronMxfPaths.get(nextRange.res.trackFileId)?.mxfPath || '',
      cplPath:           _imfElectronCplPath || '',
      assetMaps:         _imfElectronAssetMapPaths.length ? _imfElectronAssetMapPaths : [],
    });
    _highlightReelRow(nextRange.index);
  });
  document.addEventListener('keydown', e => {
    if (!_pkg?.cpl) return;
    const pane = document.getElementById('main-imf');
    const tag = e.target?.tagName;
    if (!pane || pane.style.display === 'none' || tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
    if (e.key === '=' || e.key === '+') { e.preventDefault(); _setTimelineZoom(_tlNav.zoom * 1.25, _tlNav.playheadAbs); return; }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); _setTimelineZoom(_tlNav.zoom / 1.25, _tlNav.playheadAbs); return; }
    if ((e.key === 'z' || e.key === 'Z') && e.shiftKey) { e.preventDefault(); _fitTimelineZoom(); return; }
    if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); _seekTimelineToReelBoundary(-1); return; }
    if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); _seekTimelineToReelBoundary(1); return; }
  });
}
function _updateReelIndicator(playerState) {
  const el = $('imfReelIndicator');
  if (!el) return;
  const reels = _tlNav.reelRanges || [];
  const totalReels = reels.length || (_pkg?.cpl?.videoResources?.length || 0);
  const reelNum = playerState?.reelNum || 0;
  if (!reelNum || !totalReels) { el.textContent = ''; return; }
  // Reel duration from reelRanges
  const range = reels.find(r => r.index + 1 === reelNum);
  const dur = range ? (range.absEnd - range.absStart) : 0;
  const fps = _tlNav.fps || 24;
  const mins = dur > 0 ? Math.floor(dur / fps / 60) : 0;
  const secs = dur > 0 ? Math.floor((dur / fps) % 60) : 0;
  const durStr = dur > 0 ? ` · ${String(mins).padStart(2,'0')}:${String(secs).padStart(2,'0')}` : '';
  el.textContent = `R${reelNum}/${totalReels}${durStr}`;
}

function _timelineViewSpan() { return Math.max(1, Math.round(_tlNav.totalFrames / Math.max(1, _tlNav.zoom || 1))); }
function _timelineMaxPan() { return Math.max(0, _tlNav.totalFrames - _timelineViewSpan()); }
function _clampTimelinePan(v) { return Math.max(0, Math.min(v, _timelineMaxPan())); }
function _fitTimelineZoom() { _tlNav.zoom = 1; _tlNav.pan = 0; _applyTimelineViewport(); updateTimelinePlayhead(); _renderLiveRuler(); }
function _setTimelineZoom(nextZoom, anchorAbs = null) {
  const prevSpan = _timelineViewSpan();
  const anchor = anchorAbs == null ? (_tlNav.playheadAbs || 0) : anchorAbs;
  const rel = prevSpan > 0 ? (anchor - _tlNav.pan) / prevSpan : 0.5;
  _tlNav.zoom = Math.max(1, Math.min(64, nextZoom || 1));
  const nextSpan = _timelineViewSpan();
  _tlNav.pan = _clampTimelinePan(Math.round(anchor - rel * nextSpan));
  _applyTimelineViewport();
  updateTimelinePlayhead();
  _renderLiveRuler();
}
function _panTimelineFrames(delta) { _tlNav.pan = _clampTimelinePan((_tlNav.pan || 0) + delta); _applyTimelineViewport(); updateTimelinePlayhead(); _renderLiveRuler(); }

/** Zoom the timeline view to exactly fit a single reel, with 5% margin. */
function _zoomToReel(reelAbsStart, reelFrames) {
  if (!reelFrames || !_tlNav.totalFrames) return;
  const margin   = Math.round(reelFrames * 0.05);
  const viewSpan = reelFrames + margin * 2;
  _tlNav.zoom = Math.max(1, Math.min(64, Math.round(_tlNav.totalFrames / viewSpan)));
  _tlNav.pan  = _clampTimelinePan(reelAbsStart - margin);
  _applyTimelineViewport();
  updateTimelinePlayhead();
  _renderLiveRuler();
}
function _ensurePlayheadInView() {
  const span = _timelineViewSpan();
  if (_tlNav.playheadAbs < _tlNav.pan) _tlNav.pan = _clampTimelinePan(_tlNav.playheadAbs - Math.round(span * 0.08));
  else if (_tlNav.playheadAbs > (_tlNav.pan + span)) _tlNav.pan = _clampTimelinePan(_tlNav.playheadAbs - Math.round(span * 0.92));
  _applyTimelineViewport();
}
function _findReelAtAbsFrame(absFrame) {
  return _tlNav.reelRanges.find(r => absFrame >= r.absStart && absFrame < r.absEnd) || _tlNav.reelRanges[_tlNav.reelRanges.length - 1] || null;
}
function _highlightReelRow(index) {
  const tbody = document.getElementById('imfReelTbody');
  if (!tbody) return;
  tbody.querySelectorAll('tr').forEach((r, ri) => r.classList.toggle('imf-rt-selected', ri === index));
}
function _seekTimelineAbs(absFrame, opts = {}) {
  if (!_pkg?.cpl) return;
  const clampedAbs = Math.max(0, Math.min(absFrame | 0, Math.max(0, _tlNav.totalFrames - 1)));
  const range = _findReelAtAbsFrame(clampedAbs);
  if (!range) return;
  const localFrame = Math.max(0, Math.min(range.res.sourceDuration - 1, clampedAbs - range.absStart));
  showTrackDetail(range.res, _pkg.cpl.editRate, range.index + 1, range.absStart);
  switchLeftTab('reels');
  _highlightReelRow(range.index);
  const state = playerGetState();
  if (state.reelNum === range.index + 1 && state.totalFrames === range.res.sourceDuration) {
    playerSeekToFrame(localFrame, { pause: opts.pause !== false });
  } else {
    const asset = _pkg.pkl.assets[range.res.trackFileId] || {};
    const mxfFile = _getReelFile(range.res);
    playerLoadReel(mxfFile, {
      reelNum: range.index + 1,
      totalFrames: range.res.sourceDuration,
      fps: _pkg.cpl.editRate,
      tcOffset: range.absStart,
      color: range.color,
      filename: _pkg.assetLabel(asset) || range.res.trackFileId,
      codec: _pkg.cpl.codec || '–',
      resolution: `${_pkg.cpl.resolution.w}×${_pkg.cpl.resolution.h}`,
      transfer: _pkg.cpl.transfer || '–',
      primaries: _pkg.cpl.primaries || '–',
      initialFrame: localFrame,
      autoPlay: opts.autoPlay === true,
      entryPoint: range.res.entryPoint || 0,
      intrinsicDuration: range.res.intrinsicDuration || range.res.sourceDuration,
      trackFileId: range.res.trackFileId || '',
      cplId: _pkg.cpl.id || '',
      packageHash: _pkg.packageHash || '',
      mxfPath: (mxfFile ? (window.pfxPlatform?.getNativeFilePath?.(mxfFile) || (typeof mxfFile.__pfxNativePath === 'string' ? mxfFile.__pfxNativePath : '') || (typeof mxfFile.path === 'string' ? mxfFile.path : '')) : '') || _imfElectronMxfPaths.get(range.res.trackFileId)?.mxfPath || '',
      cplPath: _imfElectronCplPath || '',
      assetMaps: _imfElectronAssetMapPaths.length ? _imfElectronAssetMapPaths : [],
    });
    // Companion mode: refresh the preview thumbnail for the new reel/position
    if (!mxfFile && _imfSourceBackend === 'companion' && _pkg?.cpl) {
      setTimeout(() => _tryCompanionFrameThumb(_pkg.cpl, clampedAbs, _companionThumbMode), 80);
    }
  }
  _tlNav.playheadAbs = clampedAbs;
  // Keep the compare overlay (#3) in sync with the playhead, when active.
  if (playerGetCompareState().enabled) {
    setTimeout(() => _tryCompareFrameThumb(_compareCplEntry()?.cpl, clampedAbs, _companionThumbMode), 90);
  }
  _ensurePlayheadInView();
  updateTimelinePlayhead();
}
function _seekTimelineToReelBoundary(dir) {
  const reels = _tlNav.reelRanges || [];
  if (!reels.length) return;
  const currentAbs = _tlNav.playheadAbs || 0;
  let idx = reels.findIndex(r => currentAbs >= r.absStart && currentAbs < r.absEnd);
  if (idx < 0) idx = 0;
  idx = Math.max(0, Math.min(reels.length - 1, idx + (dir > 0 ? 1 : -1)));
  _seekTimelineAbs(reels[idx].absStart, { pause: true });
}
function _bindTimelineOuter(outerEl) {
  if (!outerEl || outerEl.dataset.tlBound === '1') return;
  outerEl.dataset.tlBound = '1';
  let _scrubbing = false;
  outerEl.addEventListener('pointerdown', e => {
    if (!_pkg?.cpl) return;
    _scrubbing = true;
    const rect = outerEl.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const abs = _tlNav.pan + Math.round((x / Math.max(1, rect.width)) * _timelineViewSpan());
    _tlNav.consumeClick = true;
    outerEl.setPointerCapture?.(e.pointerId);
    _seekTimelineAbs(abs, { pause: true });
    e.preventDefault();
  });
  outerEl.addEventListener('pointermove', e => {
    if (!_scrubbing || !_pkg?.cpl) return;
    const rect = outerEl.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const abs = _tlNav.pan + Math.round((x / Math.max(1, rect.width)) * _timelineViewSpan());
    // Lightweight scrub: update playhead + timecode without triggering heavy reel load
    const clampedAbs = Math.max(0, Math.min(abs | 0, Math.max(0, _tlNav.totalFrames - 1)));
    _tlNav.playheadAbs = clampedAbs;
    updateTimelinePlayhead();
    const range = _findReelAtAbsFrame(clampedAbs);
    if (range) {
      const localFrame = Math.max(0, Math.min(range.res.sourceDuration - 1, clampedAbs - range.absStart));
      playerSeekToFrame(localFrame, { pause: true });
    }
  });
  outerEl.addEventListener('pointerup', () => {
    _scrubbing = false;
    // Refresh companion thumbnail on scrub end — works whether files are locally
    // accessible or only reachable via the companion (loaded from network share etc.)
    if (_pkg?.cpl && _imfSourcePackageId) {
      const mxfFile = _getReelFile((_pkg.cpl.videoResources || [])[0]);
      if (!mxfFile) setTimeout(() => _tryCompanionFrameThumb(_pkg.cpl, _tlNav.playheadAbs, _companionThumbMode), 150);
    }
  });
  outerEl.addEventListener('pointercancel', () => { _scrubbing = false; });
  outerEl.addEventListener('click', e => { if (_tlNav.consumeClick) { _tlNav.consumeClick = false; e.stopPropagation(); e.preventDefault(); } }, true);
  outerEl.addEventListener('wheel', e => {
    if (!_pkg?.cpl) return;
    const rect = outerEl.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const anchor = _tlNav.pan + Math.round((x / Math.max(1, rect.width)) * _timelineViewSpan());
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault();
      _setTimelineZoom(_tlNav.zoom * (e.deltaY < 0 ? 1.2 : (1 / 1.2)), anchor);
      return;
    }
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const px = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      _panTimelineFrames(px * (_timelineViewSpan() / Math.max(200, rect.width)));
    }
  }, { passive: false });
}
function _ensureTimelineStructure() {
  const ruler = $('imfTLRuler');
  if (ruler && !ruler.querySelector('.imf-tl-ruler-inner')) {
    const inner = el('div', 'imf-tl-ruler-inner');
    Array.from(ruler.childNodes).forEach(n => inner.appendChild(n));
    inner.appendChild(el('div', 'imf-tl-playhead'));
    ruler.appendChild(inner);
  }
  document.querySelectorAll('.imf-tl-track').forEach(track => {
    let inner = track.querySelector('.imf-tl-track-inner');
    if (!inner) {
      inner = el('div', 'imf-tl-track-inner');
      Array.from(track.childNodes).forEach(n => inner.appendChild(n));
      inner.appendChild(el('div', 'imf-tl-playhead'));
      track.appendChild(inner);
    } else if (!inner.querySelector('.imf-tl-playhead')) {
      inner.appendChild(el('div', 'imf-tl-playhead'));
    }
    _bindTimelineOuter(track);
  });
}
function _measureTlOuterWidth() {
  // Prefer the ruler content area (always present, never rebuilt on re-render).
  // Fall back to the first visible track if the ruler isn't laid out yet.
  const rulerEl = $('imfTLRuler');
  const w = rulerEl?.getBoundingClientRect().width
         || document.querySelector('.imf-tl-track')?.getBoundingClientRect().width
         || 0;
  if (w > 10) _tlOuterWidth = w; // guard against 0 / tiny transient reads
}
function _attachTlResizeObserver() {
  // Observe the RULER, not a track: track elements are destroyed and recreated by
  // renderTimeline(), which silently orphans an observer bound to them (leaving
  // _tlOuterWidth stale/0 → resize bug). The ruler persists across re-renders.
  const stableEl = $('imfTLRuler');
  if (!stableEl || _tlResizeObserver) return;
  _tlResizeObserver = new ResizeObserver(() => {
    _tlOuterWidth = 0;            // invalidate cache
    _measureTlOuterWidth();
    _applyTimelineViewport();
    updateTimelinePlayhead();
  });
  _tlResizeObserver.observe(stableEl);
}
function _applyTimelineViewport() {
  // Use the stable cached outer width so playback-driven frame updates never
  // accidentally re-read getBoundingClientRect and pick up a transient reflow
  // width caused by the buffering overlay or other mid-paint layout shifts.
  if (_tlOuterWidth < 10) _measureTlOuterWidth();   // re-measure only on partial/empty reads
  _attachTlResizeObserver();                        // idempotent
  const outerWidth = Math.max(1, _tlOuterWidth || 1);
  const zoom = Math.max(1, _tlNav.zoom || 1);
  const innerWidth = Math.max(outerWidth, Math.round(outerWidth * zoom));
  const maxOffsetPx = Math.max(0, innerWidth - outerWidth);
  const span = _timelineViewSpan();
  const offsetPx = maxOffsetPx > 0 ? Math.round((_clampTimelinePan(_tlNav.pan || 0) / Math.max(1, _tlNav.totalFrames - span)) * maxOffsetPx) : 0;
  document.querySelectorAll('.imf-tl-ruler-inner, .imf-tl-track-inner').forEach(node => {
    node.style.width = `${innerWidth}px`;
    node.style.transform = `translateX(${-offsetPx}px)`;
  });
}
function updateTimelinePlayhead() {
  _ensureTimelineStructure();
  _applyTimelineViewport();
  const outerWidth = Math.max(1, _tlOuterWidth || 1);
  const span = _timelineViewSpan();
  const clamped = Math.max(_tlNav.pan, Math.min(_tlNav.playheadAbs, _tlNav.pan + span));
  const rel = (clamped - _tlNav.pan) / Math.max(1, span);
  const phVisible = (_tlNav.playheadAbs >= _tlNav.pan && _tlNav.playheadAbs <= _tlNav.pan + span);
  const phLeft    = `${Math.max(0, Math.min(outerWidth - 1, rel * outerWidth))}px`;
  document.querySelectorAll('.imf-tl-playhead').forEach(node => {
    node.style.left    = phLeft;
    node.style.display = phVisible ? '' : 'none';
  });

  // Playhead TC badge on the ruler playhead
  const rulerPh = $('imfTLRuler')?.querySelector('.imf-tl-playhead');
  if (rulerPh && phVisible) {
    let badge = rulerPh.querySelector('.imf-tl-ph-badge');
    if (!badge) { badge = el('div', 'imf-tl-ph-badge'); rulerPh.appendChild(badge); }
    const fps = _tlNav.fps || 24;
    const a   = _tlNav.playheadAbs;
    const h   = Math.floor(a / fps / 3600);
    const m   = Math.floor((a / fps % 3600) / 60);
    const s   = Math.floor(a / fps % 60);
    const f   = Math.floor(a % fps);
    const pad = (n, w=2) => String(n).padStart(w, '0');
    badge.textContent = `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
  }

  // Active reel glow — highlight whichever segment the playhead is inside
  const activeRange = _findReelAtAbsFrame(_tlNav.playheadAbs);
  document.querySelectorAll('#imfTLVideo .imf-tl-seg').forEach(seg => {
    const ri = parseInt(seg.dataset.reelIndex, 10);
    seg.classList.toggle('imf-tl-seg-playing', activeRange != null && ri === activeRange.index);
  });

  // Active DV shot — highlight the shot containing the playhead
  const dvShots = _doviMetafierShots;
  if (dvShots?.length) {
    const ph = _tlNav.playheadAbs;
    let activeShotIdx = -1;
    for (let i = 0; i < dvShots.length; i++) {
      if (ph >= dvShots[i].begin && ph <= dvShots[i].end) { activeShotIdx = i; break; }
    }
    document.querySelectorAll('#imfTLDoviShots .imf-tl-dv-shot-seg').forEach(seg => {
      seg.classList.toggle('imf-tl-dv-shot-active', parseInt(seg.dataset.shotIndex, 10) === activeShotIdx);
    });
    document.querySelectorAll('#imfTLDV .imf-tl-dv-shot-seg').forEach(seg => {
      seg.classList.toggle('imf-tl-dv-shot-active', parseInt(seg.dataset.shotIndex, 10) === activeShotIdx);
    });
  }
  const info = $('imfTLInfo');
  if (info && _pkg?.cpl) {
    const pkgBytes = Object.values(_pkg.pkl.assets).reduce((s, a) => s + (a.size || 0), 0);
    const pkgGB = pkgBytes > 0 ? `  ·  ${(pkgBytes/1e9).toFixed(2)} GB` : '';
    const zoomTxt = _tlNav.zoom > 1 ? `  ·  <strong>${_tlNav.zoom.toFixed(1)}x</strong>` : '';
    const _chip = (v, c='') => `<span class="imf-tl-chip ${c}">${v}</span>`;
    info.innerHTML = [
      _chip(`${_tlNav.reelRanges.length} reel${_tlNav.reelRanges.length!==1?'s':''}`, 'imf-tl-chip-reels'),
      _chip(`${_tlNav.totalFrames.toLocaleString()} fr`, 'imf-tl-chip-frames'),
      _chip(`${Math.floor((_pkg.cpl.durationSec||0)/60)}m ${Math.floor((_pkg.cpl.durationSec||0)%60)}s`, 'imf-tl-chip-dur'),
      _chip(`${_tlNav.fps} fps`, 'imf-tl-chip-fps'),
      pkgBytes > 0 ? _chip(`${(pkgBytes/1e9).toFixed(2)} GB`, 'imf-tl-chip-size') : '',
      _tlNav.zoom > 1 ? _chip(`${_tlNav.zoom.toFixed(1)}×`, 'imf-tl-chip-zoom') : '',
    ].filter(Boolean).join('');
  }
}
// ── Timeline ──────────────────────────────────────────────────────────────────
// Inject the multi-layer NLE timeline styles once (CHANGE 2).
function _injectNleStyle() {
  if (document.getElementById('pfx-nle-style')) return;
  const st = document.createElement('style');
  st.id = 'pfx-nle-style';
  st.textContent = `
  /* Active CPL role chip (on the static track label) + cross-CPL diff outline. */
  .imf-tl-active-dot { display:inline-block; width:6px; height:6px; border-radius:50%; background:#e50914; margin-right:3px; vertical-align:middle; }
  .imf-tl-label-role { font-size:8px; font-weight:700; letter-spacing:.04em; opacity:.75; }
  .imf-tl-seg-diff { outline:2px solid #f97316; outline-offset:-2px; }
  .imf-tl-seg-diff::after { content:'≠'; position:absolute; top:2px; right:4px; font-size:9px; font-weight:900; color:#f97316; pointer-events:none; }
  .imf-tl-seg { position:absolute; }
  /* Validation "jump to timeline" control + the flash it triggers on the reel. */
  .imf-val-jump { display:inline-block; margin-left:8px; padding:0 6px; font-size:8px; font-weight:700; line-height:15px; height:15px;
    color:#9ab4ff; background:rgba(124,106,247,.14); border:1px solid rgba(124,106,247,.4); border-radius:3px; cursor:pointer; vertical-align:middle; }
  .imf-val-jump:hover { background:rgba(124,106,247,.28); color:#cdd8ff; }
  .imf-tl-seg-focus-flash { outline:2px solid #7c6af7; outline-offset:-2px; animation:pfxSegFlash 1.4s ease-out; }
  @keyframes pfxSegFlash { 0%,20% { box-shadow:0 0 0 3px rgba(124,106,247,.6); } 100% { box-shadow:0 0 0 0 rgba(124,106,247,0); } }
  /* Multi-layer stack: VIDEO/AUDIO section headers. */
  .pfx-tl-section { color:#5a6072; font-size:9px; font-weight:800; letter-spacing:.14em; padding:5px 0 1px 6px; }
  /* Active (live) layer: red left-accent on the label + lifted text + LIVE pill,
     so the live composition reads at a glance among the stack. */
  .pfx-cpl-active .imf-tl-track-label { box-shadow:inset 3px 0 0 #e50914; }
  .pfx-cpl-active .imf-tl-track-id { color:#fff; font-weight:700; }
  .pfx-cpl-active .imf-tl-label-role { opacity:1; }
  .imf-tl-live-pill { margin-left:4px; font-size:7px; font-weight:900; letter-spacing:.06em; color:#fff; background:#e50914; border-radius:3px; padding:1px 3px; vertical-align:middle; }
  /* Inactive layers dim, but advertise they're clickable to go live (cursor + hover lift). */
  .pfx-cpl-inactive { cursor:pointer; }
  .pfx-cpl-inactive .imf-tl-seg { opacity:0.45; transition:opacity .12s ease; }
  .pfx-cpl-inactive .imf-tl-track-label { opacity:0.6; transition:opacity .12s ease; }
  .pfx-cpl-inactive:hover .imf-tl-seg { opacity:0.82; }
  .pfx-cpl-inactive:hover .imf-tl-track-label { opacity:0.95; }
  /* Per-layer solo/mute toggles, right-aligned in the track label. */
  .pfx-cpl-layer .imf-tl-track-label { display:flex; align-items:center; gap:3px; }
  .imf-tl-layer-ctrl { margin-left:auto; display:inline-flex; gap:2px; }
  .imf-tl-layer-btn { font-size:7px; font-weight:800; line-height:1; padding:1px 3px; border-radius:3px; border:1px solid rgba(255,255,255,.18); background:rgba(255,255,255,.06); color:#9aa3b2; cursor:pointer; }
  .imf-tl-layer-btn:hover { background:rgba(255,255,255,.14); color:#cfd6e4; }
  .imf-tl-layer-btn.on { background:#1a2740; border-color:#3b82f6; color:#93c5fd; }
  .imf-tl-muted-tag { position:absolute; left:6px; top:50%; transform:translateY(-50%); font-size:8px; font-weight:700; letter-spacing:.08em; color:#6b7280; text-transform:uppercase; pointer-events:none; }
  /* Compare-mode toggle (Split / Diff / Blend), shown while comparing. */
  .imf-tl-cmp-btn { font-size:8px; font-weight:800; line-height:1; padding:2px 4px; border-radius:3px; border:1px solid rgba(147,197,253,.25); background:rgba(147,197,253,.08); color:#9aa3b2; cursor:pointer; }
  .imf-tl-cmp-btn:hover { background:rgba(147,197,253,.18); color:#cfe0ff; }
  .imf-tl-cmp-btn.on { background:#1d4ed8; border-color:#60a5fa; color:#fff; }
  `;
  document.head.appendChild(st);
}

// ── Timeline ──────────────────────────────────────────────────────────────────
function renderTimeline() {
  const { cpl, fileMap, pkl, assetLabel } = _pkg;
  const tlVideo = $('imfTLVideo');
  const tlAudio = $('imfTLAudio');
  if (!tlVideo) return;

  const tlBody = document.querySelector('.imf-tl-body');
  let tlBase = $('imfTLBase');
  if (!tlBase && tlBody) {
    tlBase = document.createElement('div');
    tlBase.id = 'imfTLBase';
    tlBase.className = 'imf-tl-row';
    tlBase.style.display = 'none';
    // The base-overlay row must sit immediately above the video row. tlVideo is
    // not always a direct child of .imf-tl-body, so insert into tlVideo's actual
    // parent (insertBefore into tlBody throws NotFoundError when it isn't a child).
    const anchorParent = tlVideo.parentNode || tlBody;
    anchorParent.insertBefore(tlBase, tlVideo);
  }

  const baseEntry = (_showBaseOverlay && _baseCplKey && _baseCplKey !== _currentCplKey) ? _cplEntries.find(e => e.key === _baseCplKey) : null;
  const baseCpl = baseEntry?.cpl || null;

  // Active-vs-base diff (CHANGE 2, "active + Show Base" model): which reels differ
  // between the active CPL and the base overlay. Pure logic in imf_timeline_diff.js.
  _injectNleStyle();
  const _activeEntry = _cplEntries.find(e => e.key === _currentCplKey) || { key: _currentCplKey || 'active', cpl };
  // Diff across ALL loaded CPLs — the stack compares every layer by reel index.
  const _vDiff = computeCplResourceDiff(_cplEntries, 'video');
  const _aDiff = computeCplResourceDiff(_cplEntries, 'audio');
  const _roleOf = e => (e && e.isSupplemental ? 'VF' : 'OV');

  const totalFrames = cpl.totalFrames || 1;
  _tlNav.totalFrames = totalFrames;
  _tlNav.fps = cpl.editRate || 24;
  _tlNav.reelRanges = [];
  _tlNav.pan = _clampTimelinePan(_tlNav.pan || 0);
  // FIX 1: do NOT reset _tlOuterWidth / disconnect the observer here — it is now
  // bound to the persistent ruler, so it survives re-renders and stays valid.

  // FIX 2: scale every layer against the LONGEST loaded CPL so reels from all
  // CPLs line up on one ruler (a short supplemental must not fill 100%).
  const masterFrames = _cplEntries.length > 0
    ? Math.max(..._cplEntries.map(e => e.cpl?.totalFrames || 1), _tlNav.totalFrames || 1)
    : (_tlNav.totalFrames || 1);

  // Stamp the master frame count on the seek element so imf_player.js can switch to
  // absolute-position mode and keep the scrubber thumb aligned with the timeline playhead.
  const _seekStamp = document.getElementById('imfSeek');
  if (_seekStamp) _seekStamp.dataset.cplFrames = masterFrames;

  // Timeline header info — rendered as compact chips
  const tlInfo = $('imfTLInfo');
  if (tlInfo) {
    const mins = Math.floor((cpl.durationSec || 0) / 60);
    const secs = Math.floor((cpl.durationSec || 0) % 60);
    const reelCount = cpl.videoResources.length;
    const pkgBytes = Object.values(pkl.assets).reduce((s, a) => s + (a.size || 0), 0);
    const chip = (val, cls = '') => `<span class="imf-tl-chip ${cls}">${val}</span>`;
    tlInfo.innerHTML = [
      chip(`${reelCount} reel${reelCount !== 1 ? 's' : ''}`, 'imf-tl-chip-reels'),
      chip(`${cpl.totalFrames.toLocaleString()} fr`, 'imf-tl-chip-frames'),
      chip(`${mins}m ${secs}s`, 'imf-tl-chip-dur'),
      chip(`${cpl.editRate} fps`, 'imf-tl-chip-fps'),
      pkgBytes > 0 ? chip(`${(pkgBytes/1e9).toFixed(2)} GB`, 'imf-tl-chip-size') : '',
    ].filter(Boolean).join('');
  }

  // Color map keyed by TrackFileId (UUID) — same ID always gets the same color.
  const colorMap = new Map();
  for (const res of cpl.videoResources) {
    if (!colorMap.has(res.trackFileId)) {
      colorMap.set(res.trackFileId, _uuidToHex(res.trackFileId));
    }
  }

  if (tlBase) {
    tlBase.innerHTML = '';
    tlBase.style.display = baseCpl ? '' : 'none';
    if (baseCpl) {
      const baseLabel = el('div', 'imf-tl-label imf-tl-label-base');
      baseLabel.innerHTML = `BASE <span class="imf-tl-label-role">${_roleOf(baseEntry)}</span>`;
      const baseTrack = el('div', 'imf-tl-track imf-tl-track-base');
      let baseOffset = 0;
      baseCpl.videoResources.forEach((res, i) => {
        const pct = (res.sourceDuration / masterFrames * 100).toFixed(4);
        const leftPct = (baseOffset / masterFrames * 100).toFixed(4);
        const color = colorMap.get(res.trackFileId) || segmentColor(i);
        const diff = !!_vDiff.flags[baseEntry.key]?.[i];
        const seg = el('div', 'imf-tl-seg imf-tl-seg-base' + (diff ? ' imf-tl-seg-diff' : ''));
        seg.style.left = leftPct + '%';
        seg.style.width = pct + '%';
        seg.style.background = `linear-gradient(180deg, ${color}55 0%, ${color}33 100%)`;
        seg.style.borderLeft = '1px dashed rgba(255,255,255,0.10)';
        seg.style.borderRight = '1px dashed rgba(255,255,255,0.08)';
        seg.title = `Base CPL · Reel ${i + 1}\nFrames: ${res.sourceDuration.toLocaleString()}\nDuration: ${fmtDuration(res.sourceDuration / (baseCpl.editRate || _tlNav.fps || 24))}`;
        baseTrack.appendChild(seg);
        baseOffset += res.sourceDuration;
      });
      tlBase.appendChild(baseLabel);
      tlBase.appendChild(baseTrack);
    }
  }

  // ── VIDEO (active CPL, single row) + ≠ outlines vs the base overlay (CHANGE 2,
  // "active + Show Base" model). Scaled to masterFrames so the active row and the
  // base overlay line up on one ruler.
  // ── Multi-layer NLE stack (matches the reference): one row per CPL, grouped
  // VIDEO / AUDIO. V1/A1 = OV at the bottom; supplementals (VF1, VF2…) stack
  // upward; red dot on the active layer; ≠ outline on reels that differ across
  // CPLs; "N/M reels match" chip. Built as real .imf-tl-track wrappers so the
  // existing viewport/playhead machinery (_ensureTimelineStructure) drives them.
  const _ovFirst = [..._cplEntries.filter(e => !e.isSupplemental), ..._cplEntries.filter(e => e.isSupplemental)];
  const _layerOf = new Map();
  let _suppN = 0;
  _ovFirst.forEach((e, i) => _layerOf.set(e.key, { num: i + 1, role: e.isSupplemental ? `VF${++_suppN}` : 'OV' }));

  // Prune solo/mute state to currently-loaded CPLs (stale keys from unloaded
  // packages would otherwise hide nothing but linger).
  const _liveKeys = new Set(_cplEntries.map(e => e.key));
  [..._layerMuted].forEach(k => { if (!_liveKeys.has(k)) _layerMuted.delete(k); });
  [..._layerSolo].forEach(k => { if (!_liveKeys.has(k)) _layerSolo.delete(k); });

  const _tlBody = document.querySelector('.imf-tl-body');
  // Clear previously-built dynamic rows so re-renders don't accumulate.
  _tlBody?.querySelectorAll('.pfx-cpl-layer, .pfx-tl-section').forEach(n => n.remove());
  // The stack replaces the static single Video/Audio rows + the base overlay.
  const _staticV = $('imfTLTrackVideo'); if (_staticV) _staticV.style.display = 'none';
  const _staticA = $('imfTLTrackAudio'); if (_staticA) _staticA.style.display = 'none';
  if (tlBase) tlBase.style.display = 'none';

  // Header "N/M reels match" chip across all CPLs (only with >1 CPL).
  if (_cplEntries.length > 1 && tlInfo) {
    const allMatch = _vDiff.matchCount === _vDiff.maxReels;
    tlInfo.insertAdjacentHTML('beforeend',
      `<span class="imf-tl-chip" style="background:${allMatch ? '#16361f' : '#3a2410'};color:${allMatch ? '#22c55e' : '#f97316'};font-weight:700">${_vDiff.matchCount}/${_vDiff.maxReels} reels match</span>`);

    // Layer-stack depth chip: how many compositions are stacked (OV + VF supplements).
    const _nOV = _cplEntries.filter(e => !e.isSupplemental).length;
    const _nVF = _cplEntries.length - _nOV;
    tlInfo.insertAdjacentHTML('beforeend',
      `<span class="imf-tl-chip" style="background:#1a2740;color:#93c5fd;font-weight:700" title="Stacked compositions: ${_nOV} original (OV) + ${_nVF} supplemental (VF)">▤ ${_cplEntries.length}-layer stack</span>`);

    // "Show all" reset chip — appears only while some layer is soloed/muted.
    if (_layerSolo.size || _layerMuted.size) {
      const reset = el('span', 'imf-tl-chip');
      reset.style.cssText = 'background:#2a1320;color:#fca5a5;font-weight:700;cursor:pointer';
      reset.textContent = _layerSolo.size
        ? `⦿ ${_layerSolo.size} solo · show all`
        : `🔇 ${_layerMuted.size} muted · show all`;
      reset.title = 'Clear solo/mute — show every layer in the stack';
      reset.addEventListener('click', () => { _layerSolo.clear(); _layerMuted.clear(); renderTimeline(); });
      tlInfo.appendChild(reset);
    }

    // Compare controls (#3): solo exactly one layer → compare it vs the live
    // picture. Mode toggle (Split / Diff / Blend) shows only while comparing.
    const _cmpEntry = _compareCplEntry();
    if (_cmpEntry) {
      const cs = playerGetCompareState();
      const cmpRole = _cmpEntry.shortLabel || (_cmpEntry.isSupplemental ? 'VF' : 'OV');
      const ctrl = el('span', 'imf-tl-chip imf-tl-compare-ctrl');
      ctrl.style.cssText = 'background:#0f2030;color:#93c5fd;font-weight:700;display:inline-flex;gap:4px;align-items:center';
      ctrl.innerHTML = `<span title="Live composition compared against ${cmpRole}">◧ vs ${cmpRole}</span>`;
      [['split', 'SPLIT'], ['difference', 'DIFF'], ['blend', 'BLEND']].forEach(([m, lbl]) => {
        const b = el('button', 'imf-tl-cmp-btn' + (cs.mode === m ? ' on' : ''), lbl);
        b.title = `Compare mode: ${lbl}`;
        b.addEventListener('click', (e) => { e.stopPropagation(); playerSetCompare({ enabled: true, mode: m }); renderTimeline(); });
        ctrl.appendChild(b);
      });
      // Blend mode: opacity slider (split uses the on-canvas divider; diff has no
      // parameter). Adjusts live↔comparison mix without rebuilding the timeline.
      if (cs.mode === 'blend') {
        const slider = el('input', 'imf-tl-cmp-opacity');
        slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
        slider.value = String(Math.round((cs.opacity ?? 0.5) * 100));
        slider.title = `Blend: ${slider.value}% comparison`;
        slider.style.cssText = 'width:60px;vertical-align:middle;accent-color:#60a5fa;cursor:pointer';
        slider.addEventListener('click', (e) => e.stopPropagation());
        slider.addEventListener('input', (e) => {
          e.stopPropagation();
          playerSetCompare({ enabled: true, opacity: Number(slider.value) / 100 });
          slider.title = `Blend: ${slider.value}% comparison`;
        });
        ctrl.appendChild(slider);
      }
      // Export the current composited compare frame as a PNG (for QC sign-off).
      const dl = el('button', 'imf-tl-cmp-btn', '⬇PNG');
      dl.title = 'Export this compare frame as a PNG (live + comparison + Δ%)';
      dl.addEventListener('click', async (e) => {
        e.stopPropagation();
        const out = await playerExportCompareStill();
        if (!out) return;
        const m = out.meta;
        const safe  = String(m.compareLabel || 'cmp').replace(/[^\w.-]+/g, '');
        const dpart = m.changedPercent != null ? `_d${m.changedPercent}pct` : '';
        const fname = `IMF_compare_LIVEvs${safe}_${m.mode}_f${String(m.frame).padStart(6, '0')}${dpart}.png`;
        if (typeof window.__pfxSaveBlob === 'function') {
          await window.__pfxSaveBlob(fname, out.blob);
        } else {
          const url = URL.createObjectURL(out.blob);
          const a   = document.createElement('a');
          a.href = url; a.download = fname;
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
      });
      ctrl.appendChild(dl);
      tlInfo.appendChild(ctrl);
    }
  }
  // Enable/disable + fetch the comparison frame for the current playhead. Runs
  // unconditionally so compare is also torn down when CPLs drop below two.
  _syncCompareOverlay();

  // Build one CPL layer row by CLONING the real static row (#imfTLTrackVideo /
  // #imfTLTrackAudio). This guarantees the exact wrapper/label/segment nesting and
  // CSS the working row uses — we only swap the label text + segments.
  const _buildCplLayer = (entry, kind) => {
    const ecpl = entry.cpl; if (!ecpl) return null;
    const isActive = entry.key === _currentCplKey;
    const meta = _layerOf.get(entry.key) || { num: 1, role: '' };
    const idTxt = (kind === 'audio' ? 'A' : 'V') + meta.num;

    // Plain flex wrapper — NOT .imf-tl-track, so the engine won't move its content
    // into an absolute inner and collapse the row. Explicit heights (incl. a forced
    // !important on the segment lane) sidestep the height:auto!important cascade.
    const wrap = el('div', 'pfx-cpl-layer' + (isActive ? ' pfx-cpl-active' : ' pfx-cpl-inactive'));
    wrap.style.cssText = 'display:flex; align-items:stretch; gap:0; height:19px; margin:0 0 4px 0;';
    // Inactive rows switch the live composition on click — make the WHOLE row a
    // target (not just its segments) and say so on hover. A reel-seg click still
    // wins (it also seeks) via stopPropagation below.
    if (!isActive) {
      wrap.title = `${idTxt} · ${meta.role} — click to make this composition live`;
      const _switchKey = entry.key;
      wrap.addEventListener('click', () => { applyCompositionByKey(_switchKey).catch(() => {}); });
    }

    const label = el('div', 'imf-tl-track-label');
    label.innerHTML =
      `<span class="imf-tl-track-id">${isActive ? '<span class="imf-tl-active-dot"></span>' : ''}${idTxt}</span>` +
      `<span class="imf-tl-track-name imf-tl-label-role">${meta.role}</span>` +
      (isActive ? `<span class="imf-tl-live-pill">LIVE</span>` : '');

    // Solo / mute toggles — only on inactive (comparison) layers. The live layer
    // always renders (it drives the playhead/nav), so hiding can't break playback.
    if (!isActive) {
      const _k = entry.key;
      const ctrl = el('span', 'imf-tl-layer-ctrl');
      const mk = (txt, on, title, fn) => {
        const b = el('button', 'imf-tl-layer-btn' + (on ? ' on' : ''), txt);
        b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); renderTimeline(); });
        return b;
      };
      ctrl.appendChild(mk('S', _layerSolo.has(_k), 'Solo — show only soloed comparison layers',
        () => { if (_layerSolo.has(_k)) _layerSolo.delete(_k); else _layerSolo.add(_k); }));
      ctrl.appendChild(mk('M', _layerMuted.has(_k), 'Mute — hide this layer from the stack',
        () => { if (_layerMuted.has(_k)) _layerMuted.delete(_k); else _layerMuted.add(_k); }));
      label.appendChild(ctrl);
    }

    // The single .imf-tl-track is the segment lane (engine still pans/zooms it).
    const segArea = el('div', 'imf-tl-track');
    segArea.style.flex = '1';
    segArea.style.position = 'relative';
    segArea.style.background = 'rgba(255,255,255,.03)';
    segArea.style.borderRadius = '4px';
    segArea.style.setProperty('height', '19px', 'important');   // beat height:auto !important

    // Hidden by solo/mute: keep the label (with its toggles, so it can be brought
    // back) but collapse the segment lane to a thin hatched bar. Never hides the
    // live layer — _hidden is gated on !isActive.
    const _hidden = !isActive && (_layerSolo.size ? !_layerSolo.has(entry.key) : _layerMuted.has(entry.key));
    if (_hidden) {
      wrap.style.height = '13px';
      segArea.style.setProperty('height', '13px', 'important');
      segArea.style.background = 'repeating-linear-gradient(45deg, rgba(255,255,255,.05) 0 6px, transparent 6px 12px)';
      const tag = el('span', 'imf-tl-muted-tag', _layerSolo.size ? 'hidden' : 'muted');
      segArea.appendChild(tag);
      wrap.appendChild(label);
      wrap.appendChild(segArea);
      return wrap;
    }

    const resources = kind === 'audio' ? (ecpl.audioResources || []) : (ecpl.videoResources || []);
    const diffFlags = (kind === 'audio' ? _aDiff : _vDiff).flags[entry.key] || {};
    let off = 0;
    resources.forEach((res, i) => {
      const isIAB = kind === 'audio' && _isIabResource(ecpl, res);
      const color = _uuidToHex(res.trackFileId);
      const diff = !!diffFlags[i];
      const seg = el('div', 'imf-tl-seg' + (kind === 'audio' ? ' imf-tl-seg-audio' : '') + (diff ? ' imf-tl-seg-diff' : ''));
      seg.style.cssText =
        `position:absolute; top:0; bottom:0; left:${(off / masterFrames * 100).toFixed(4)}%;` +
        ` width:${Math.min(res.sourceDuration / masterFrames * 100, 100).toFixed(4)}%; border-radius:4px; overflow:hidden;`;
      if (kind === 'audio') {
        seg.style.background = isIAB
          ? 'linear-gradient(180deg, rgba(198,120,221,0.95) 0%, rgba(160,96,194,0.92) 100%)'
          : 'linear-gradient(180deg, rgba(70,211,105,.7), rgba(50,180,80,.6))';
      } else {
        seg.style.background = `linear-gradient(180deg, ${color} 0%, ${color}dd 55%, ${color}b8 100%)`;
      }
      const tcIn = fmtDuration(off / ecpl.editRate), tcOut = fmtDuration((off + res.sourceDuration) / ecpl.editRate);
      seg.title = [
        `${idTxt} · ${meta.role} · ${kind === 'audio' ? _resourceKind(ecpl, res) : 'Reel ' + (i + 1)}`,
        `TrackFile: ${(res.trackFileId || '').slice(0, 8)}…`,
        `Duration: ${fmtDuration(res.sourceDuration / ecpl.editRate)}`,
        `TC In: ${tcIn}  TC Out: ${tcOut}`,
        diff ? 'DIFFERS from another CPL' : '',
      ].filter(Boolean).join('\n');
      const rl = el('span', 'imf-tl-reel-label');
      rl.innerHTML = `<b class="imf-tl-reel-n">${kind === 'audio' ? (isIAB ? 'IAB' : 'PCM') : 'R' + (i + 1)}</b>`;
      seg.appendChild(rl);
      const myOff = off;
      if (isActive) {
        seg.dataset.reelIndex = i;
        if (kind !== 'audio') {
          seg.dataset.id = res.trackFileId;
          seg.dataset.absStart = off;
          _tlNav.reelRanges.push({ index: i, res, absStart: off, absEnd: off + res.sourceDuration, color });
        }
        seg.addEventListener('click', () => { showTrackDetail(res, ecpl.editRate, i + 1, myOff, ecpl); switchLeftTab('reels'); });
        if (kind !== 'audio') seg.addEventListener('dblclick', e => { e.stopPropagation(); _zoomToReel(myOff, res.sourceDuration); });
      } else {
        const myKey = entry.key;
        seg.addEventListener('click', (e) => { e.stopPropagation(); applyCompositionByKey(myKey).then(() => { try { _seekTimelineAbs(myOff); } catch {} }); });
      }
      segArea.appendChild(seg);
      off += res.sourceDuration || 0;
    });
    wrap.appendChild(label);
    wrap.appendChild(segArea);
    return wrap;
  };

  // VIDEO section (header + layers; render highest first so V1/OV lands at bottom).
  if (_tlBody && _staticV) {
    _tlBody.insertBefore(el('div', 'pfx-tl-section', 'VIDEO'), _staticV);
    _ovFirst.slice().reverse().forEach(entry => {
      const row = _buildCplLayer(entry, 'video');
      if (row) _tlBody.insertBefore(row, _staticV);
    });
  }
  // AUDIO section.
  if (_tlBody && _staticA) {
    _tlBody.insertBefore(el('div', 'pfx-tl-section', 'AUDIO'), _staticA);
    _ovFirst.slice().reverse().forEach(entry => {
      const row = _buildCplLayer(entry, 'audio');
      if (row) _tlBody.insertBefore(row, _staticA);
    });
  }

  // DV META + TRIM rows (above VIDEO — order: DV → TRIM → CUTS → VIDEO → IAB)
  _refreshDoviMetaRows();

  // DV CUTS row (shot-level cut detection from Metafier)
  _refreshDoviShotsTimeline({ updateViewport: false });

  // Wire row toggle filter chips (idempotent)
  _wireTimelineRowToggles();

  // Debug
  if (window.PFX_DEBUG_IMF_TIMELINE) {
    const hasDV = !!(cpl.isDolbyVision || _doviMetafierShots?.length || _dvMxfConfirmed);
    const hasIAB = !!cpl.hasIAB || cpl.audioResources?.length > 0;
    console.log('[PFX IMF Timeline] row order: dv, trim, cuts, video, iab');
    console.log(`[PFX IMF Timeline] DV: ${hasDV} | VIDEO items: ${cpl.videoResources?.length} | IAB: ${hasIAB}`);
    console.log(`[PFX IMF Timeline] CUTS markers: ${_doviMetafierShots?.length || 0}`);
  }

  // Live adaptive ruler (replaces static 8-tick render)
  _renderLiveRuler();
  // Wire hover timecode cursor (idempotent — safe to call on every render)
  _wireTimelineHover();

  // Reel table + asset list
  renderReelTable(cpl, colorMap);
  renderAssetList(cpl, colorMap);
  updateTimelinePlayhead();

  // Reflect the real decoder/renderer in the status bar (C-RT1e).
  try { _refreshImfStatusBar(cpl); } catch {}

  // Auto-load the first playable reel so the package starts in a ready-to-review state.
  const firstPlayableIndex = cpl.videoResources.findIndex(res =>
    !!_getReelFile(res) || !!_imfElectronMxfPaths.get(res.trackFileId)?.mxfPath
  );
  if (firstPlayableIndex >= 0) {
    const res = cpl.videoResources[firstPlayableIndex];
    const asset = getAssetMetaById(res.trackFileId) || {};
    const color = colorMap.get(res.trackFileId) || '#7c6af7';
    let frameOffset = 0;
    for (let i = 0; i < firstPlayableIndex; i++) frameOffset += cpl.videoResources[i].sourceDuration || 0;
    const tbody = document.getElementById('imfReelTbody');
    if (tbody) {
      tbody.querySelectorAll('tr').forEach((r, ri) => r.classList.toggle('imf-rt-selected', ri === firstPlayableIndex));
    }
    showTrackDetail(res, cpl.editRate, firstPlayableIndex + 1, frameOffset);
    _tlNav.playheadAbs = frameOffset;
    playerLoadReel(_getReelFile(res), {
      reelNum: firstPlayableIndex + 1,
      totalFrames: res.sourceDuration,
      fps: cpl.editRate,
      tcOffset: frameOffset,
      dropFrame: !!cpl.compositionTimecode?.dropFrame,
      color,
      filename: _pkg.assetLabel(asset) || res.trackFileId,
      codec: cpl.codec || '–',
      resolution: `${cpl.resolution.w}×${cpl.resolution.h}`,
      transfer: cpl.transfer || '–',
      primaries: cpl.primaries || '–',
      initialFrame: 0,
      entryPoint: res.entryPoint || 0,
      intrinsicDuration: res.intrinsicDuration || res.sourceDuration,
      trackFileId: res.trackFileId || '',
      cplId: cpl.id || '',
      packageHash: _pkg.packageHash || '',
      mxfPath: (() => { const rf = _getReelFile(res); return rf ? (window.pfxPlatform?.getNativeFilePath?.(rf) || (typeof rf.__pfxNativePath === 'string' ? rf.__pfxNativePath : '') || (typeof rf.path === 'string' ? rf.path : '')) : ''; })() || _imfElectronMxfPaths.get(res.trackFileId)?.mxfPath || '',
      cplPath: _imfElectronCplPath || '',
      assetMaps: _imfElectronAssetMapPaths.length ? _imfElectronAssetMapPaths : [],
    });
  } else if (_imfElectronCplPath && cpl.videoResources.length > 0) {
    // Companion / Electron mode: no browser File handles, but the main-process has the CPL path.
    // Use the IMF demuxer path directly — it handles all asset resolution internally.
    const res = cpl.videoResources[0];
    const asset = getAssetMetaById(res.trackFileId) || {};
    const color = colorMap.get(res.trackFileId) || '#7c6af7';
    const tbody = document.getElementById('imfReelTbody');
    if (tbody) tbody.querySelectorAll('tr').forEach((r, ri) => r.classList.toggle('imf-rt-selected', ri === 0));
    showTrackDetail(res, cpl.editRate, 1, 0);
    _tlNav.playheadAbs = 0;
    console.log(`[IMF] renderTimeline: no browser file handles — loading reel 1 via IMF demuxer. cplPath=${_imfElectronCplPath}`);
    playerLoadReel(null, {
      reelNum: 1,
      totalFrames: res.sourceDuration,
      fps: cpl.editRate,
      tcOffset: 0,
      dropFrame: !!cpl.compositionTimecode?.dropFrame,
      color,
      filename: _pkg.assetLabel(asset) || res.trackFileId,
      codec: cpl.codec || '–',
      resolution: `${cpl.resolution.w}×${cpl.resolution.h}`,
      transfer: cpl.transfer || '–',
      primaries: cpl.primaries || '–',
      initialFrame: 0,
      entryPoint: res.entryPoint || 0,
      intrinsicDuration: res.intrinsicDuration || res.sourceDuration,
      trackFileId: res.trackFileId || '',
      cplId: cpl.id || '',
      packageHash: _pkg.packageHash || '',
      mxfPath: _imfElectronMxfPaths.get(res.trackFileId)?.mxfPath || '',
      cplPath: _imfElectronCplPath,
      assetMaps: _imfElectronAssetMapPaths.length ? _imfElectronAssetMapPaths : [],
    });
  } else {
    playerLoadReel(null, { totalFrames: 0 });
  }

  // Update left-tab count badges
  const tabReels = $('imfTabReels');
  const assetCount = Object.keys(_pkg.pkl.assets).length;
  if (tabReels) tabReels.textContent = `Reels + Assets (${cpl.videoResources.length} / ${assetCount})`;
}

function switchLeftTab(which) {
  setImfLeftTab(which === 'assets' ? 'reels' : which);
}

// Jump from a resource-scoped validation finding to the offending reel on the
// timeline. Matches a timeline .imf-tl-seg by trackFileId (data-id) first, then
// reelIndex (data-reel-index), switches to the reels view, highlights it, and
// scrolls it into view. Returns the matched element (or null) so callers/tests
// can assert the resolution. Never throws.
function _focusTimelineResource(ref) {
  if (!ref) return null;
  try {
    let seg = null;
    if (ref.trackFileId) {
      seg = document.querySelector(`#imfTLVideo .imf-tl-seg[data-id="${(window.CSS && CSS.escape) ? CSS.escape(ref.trackFileId) : ref.trackFileId}"]`);
    }
    if (!seg && ref.reelIndex != null) {
      seg = document.querySelector(`#imfTLVideo .imf-tl-seg[data-reel-index="${ref.reelIndex}"]`);
    }
    switchLeftTab('reels');
    if (seg) {
      seg.classList.add('imf-tl-seg-focus-flash');
      setTimeout(() => { try { seg.classList.remove('imf-tl-seg-focus-flash'); } catch {} }, 1400);
      try { seg.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); } catch {}
    }
    return seg;
  } catch { return null; }
}

function _getReelFile(res) {
  if (!_pkg || !res) return null;
  const asset = _pkg.pkl?.assets?.[res.trackFileId] || {};
  const found = _pkg.resolveFile?.(asset) || _pkg.resolveFile?.(res.trackFileId) || null;
  return _isVirtualFileHandle(found) ? null : found;
}

function _stopAudioPreview() {
  if (_audioPreviewNode) {
    try { _audioPreviewNode.stop(); } catch {}
    _audioPreviewNode.disconnect();
    _audioPreviewNode = null;
  }
  if (_audioPreviewCtx) {
    _audioPreviewCtx.close().catch(() => {});
    _audioPreviewCtx = null;
  }
  if (_audioPreviewBtn) {
    _audioPreviewBtn.textContent = '▶';
    _audioPreviewBtn.title = 'Play audio preview (10 s)';
    _audioPreviewBtn.classList.remove('imf-rt-play-stop');
    _audioPreviewBtn = null;
  }
}

async function _playAudioPreview(res, btnEl, cpl = _pkg?.cpl) {
  if (_audioPreviewBtn === btnEl) { _stopAudioPreview(); return; }
  _stopAudioPreview();

  const file = _getReelFile(res);
  if (!file) return;

  const descById = new Map((cpl?.descriptors || []).map(d => [d.id, d]));
  const desc = descById.get(res.essenceDescriptorId) || {};

  btnEl.textContent = '…';
  btnEl.title = 'Extracting PCM…';

  try {
    const result = await readAudioMXF(file, {
      channels:   desc.channelCount   || 2,
      sampleRate: desc.audioSampleRate || 48000,
      quantBits:  desc.audioQuantBits  || 24,
      editRate:   cpl?.editRate        || 24,
    }, 10);

    if (!result || !result.pcmChannels.length || !result.pcmChannels[0].length) {
      btnEl.textContent = '✗';
      btnEl.title = 'No audio data found in MXF';
      setTimeout(() => { if (btnEl.textContent === '✗') { btnEl.textContent = '▶'; btnEl.title = 'Play audio preview (10 s)'; } }, 2500);
      return;
    }

    const { sampleRate, channels, pcmChannels } = result;
    const numSamples = pcmChannels[0].length;

    _audioPreviewCtx = new AudioContext({ sampleRate });
    const buffer = _audioPreviewCtx.createBuffer(channels, numSamples, sampleRate);
    for (let ch = 0; ch < channels; ch++) buffer.copyToChannel(pcmChannels[ch], ch);

    _audioPreviewNode = _audioPreviewCtx.createBufferSource();
    _audioPreviewNode.buffer = buffer;
    _audioPreviewNode.connect(_audioPreviewCtx.destination);
    _audioPreviewNode.onended = () => _stopAudioPreview();
    _audioPreviewNode.start();

    btnEl.textContent = '■';
    btnEl.title = 'Stop audio preview';
    btnEl.classList.add('imf-rt-play-stop');
    _audioPreviewBtn = btnEl;

  } catch (err) {
    console.error('[IMF] Audio preview error:', err);
    if (_audioPreviewCtx) { _audioPreviewCtx.close().catch(() => {}); _audioPreviewCtx = null; }
    _audioPreviewNode = null;
    _audioPreviewBtn = null;
    btnEl.textContent = '✗';
    btnEl.title = `Preview failed: ${err.message}`;
    setTimeout(() => { if (btnEl.textContent === '✗') { btnEl.textContent = '▶'; btnEl.title = 'Play audio preview (10 s)'; } }, 3000);
  }
}

function renderReelTable(cpl, colorMap) {
  const tbl = $('imfReelTable');
  if (!tbl || !_pkg) return;

  const { pkl, resolveFile, assetLabel } = _pkg;
  const fps = cpl.editRate || 24;
  const descById = new Map((cpl.descriptors || []).map(d => [d.id, d]));

  if (!cpl.videoResources.length) {
    tbl.innerHTML = '<div style="padding:10px 14px;color:#555;font-size:12px;">No video reels found in CPL</div>';
    return;
  }

  tbl.innerHTML = `
    <table class="imf-rt imf-rt-list">
      <tbody id="imfReelTbody"></tbody>
      <tbody id="imfAudioTbody"></tbody>
    </table>`;

  const tbody = document.getElementById('imfReelTbody');
  let frameOffset = 0;

  cpl.videoResources.forEach((res, i) => {
    const color   = colorMap.get(res.trackFileId) || segmentColor(i);
    const tcIn    = fmtDuration(frameOffset / fps);
    const tcOut   = fmtDuration((frameOffset + res.sourceDuration) / fps);
    const asset   = getAssetMetaById(res.trackFileId) || {};
    const sizeGB  = asset.size ? `${(asset.size / 1e9).toFixed(2)}G` : '–';
    const mxfFile = _getReelFile(res);
    // In Electron companion mode the IMF demuxer resolves assets — treat reel as "exists" if cplPath is known
    const exists  = !!mxfFile || !!_imfElectronMxfPaths.get(res.trackFileId)?.mxfPath || !!_imfElectronCplPath;
    const myOffset = frameOffset;
    frameOffset += res.sourceDuration;

    // Codec badge from descriptor
    const desc = descById.get(res.essenceDescriptorId);
    const codecBadge = (() => {
      if (!desc) return '<span class="imf-rt-codec imf-rt-codec-unk">?</span>';
      if (desc.isHTJ2K) return '<span class="imf-rt-codec imf-rt-codec-htj2k" title="High-Throughput JPEG 2000 (Part 15)">HTJ2K</span>';
      if (desc.isJ2K)   return '<span class="imf-rt-codec imf-rt-codec-j2k"   title="JPEG 2000">J2K</span>';
      if (desc.isRGBA)  return '<span class="imf-rt-codec imf-rt-codec-rgba"  title="RGBA uncompressed">RGBA</span>';
      if (desc.isCDCI)  return '<span class="imf-rt-codec imf-rt-codec-cdci"  title="Component Digital">CDCI</span>';
      return '<span class="imf-rt-codec imf-rt-codec-unk">MXF</span>';
    })();
    const dvBadge = desc?.isDVision ? ' <span class="imf-rt-codec imf-rt-codec-dv" title="Dolby Vision">DV</span>' : '';

    const _electronReelEntry = _imfElectronMxfPaths.get(res.trackFileId);
    const _electronFname = _electronReelEntry?.mxfPath ? _electronReelEntry.mxfPath.split('/').pop() : '';
    const fname = assetLabel(asset) || _electronFname || '';
    // Keep type prefix (VIDEO_/IAB_/etc) + first 8 chars of UUID — enough to identify without wrapping
    const fnameShort = fname
      ? (() => {
          const base = fname.replace(/\.mxf$/i, '');
          const m = base.match(/^([A-Z]+_)([0-9a-f]{8})/i);
          return m ? `${m[1]}${m[2]}…` : base.slice(0, 20);
        })()
      : '';
    const missingCls = exists ? '' : ' imf-rt-row-missing';

    const tr = document.createElement('tr');
    tr.className = `imf-rt-row imf-rt-clickable${missingCls}`;
    tr.title = `Reel ${i+1} · ${res.trackFileId}\n${tcIn} → ${tcOut}${exists ? '' : '\n⚠ MXF not found'}`;
    const fnameFull = fname ? fname.replace(/\.mxf$/i, '') : res.trackFileId.slice(0, 16) + '…';
    tr.innerHTML = `
      <td class="imf-rt-item-cell">
        <div class="imf-rt-item">
          <span class="imf-rt-dot" style="background:${color}; flex-shrink:0"></span>
          <span class="imf-asset-type imf-asset-type-video">VIDEO</span>
          <span class="imf-rt-item-body">
            <span class="imf-rt-item-name">${fnameFull}</span>
            <span class="imf-rt-item-tc">${tcIn} → ${tcOut}</span>
          </span>
          <span class="imf-rt-item-num">${i + 1}</span>
        </div>
      </td>`;

    tr.addEventListener('click', () => {
      tbody.querySelectorAll('tr').forEach(r => r.classList.remove('imf-rt-selected'));
      tr.classList.add('imf-rt-selected');
      showTrackDetail(res, fps, i + 1, myOffset);
      _seekTimelineAbs(myOffset, { pause: true });
    });

    tbody.appendChild(tr);
  });

  // Audio resource rows — one row per audio resource, with play button for PCM
  _stopAudioPreview();
  const audioTbody = document.getElementById('imfAudioTbody');
  if (audioTbody && (cpl.audioResources || []).length) {
    const hdrTr = document.createElement('tr');
    hdrTr.className = 'imf-rt-section-hdr';
    hdrTr.innerHTML = `<td colspan="1">Audio Resources (${(cpl.audioResources || []).length})</td>`;
    audioTbody.appendChild(hdrTr);

    let audioFrameOffset = 0;
    (cpl.audioResources || []).forEach((ar, i) => {
      const isIAB  = _isIabResource(cpl, ar);
      const adesc  = descById.get(ar.essenceDescriptorId);
      const chCount = adesc?.channelCount   || 0;
      const sr      = adesc?.audioSampleRate || 0;
      const bits    = adesc?.audioQuantBits  || 0;
      const tcIn    = fmtDuration(audioFrameOffset / fps);
      const tcOut   = fmtDuration((audioFrameOffset + ar.sourceDuration) / fps);
      const asset   = getAssetMetaById(ar.trackFileId) || {};
      const sizeGB  = asset.size ? `${(asset.size / 1e9).toFixed(2)}G` : '–';
      const audFile = _getReelFile(ar);
      const exists  = !!audFile;
      const myAudioOffset = audioFrameOffset;
      audioFrameOffset += ar.sourceDuration || 0;

      const codecBadge = isIAB
        ? '<span class="imf-rt-codec imf-rt-codec-iab" title="Immersive Audio Bitstream (Dolby Atmos)">IAB</span>'
        : `<span class="imf-rt-codec imf-rt-codec-pcm" title="PCM Audio">${chCount ? chCount + 'ch' : 'PCM'}</span>`;
      const srLabel = sr ? `<span class="imf-rt-audio-meta">&thinsp;${(sr/1000).toFixed(0)}k${bits ? `·${bits}b` : ''}</span>` : '';

      const canPlay = exists && !isIAB;
      const aFname = assetLabel(asset) || '';
      const aFnameShort = aFname
        ? (() => {
            const base = aFname.replace(/\.mxf$/i, '');
            const m = base.match(/^([A-Z]+_)([0-9a-f]{8})/i);
            return m ? `${m[1]}${m[2]}…` : base.slice(0, 20);
          })()
        : '';

      const tr = document.createElement('tr');
      tr.className = 'imf-rt-row imf-rt-clickable imf-rt-audio-res-row';
      tr.title = `Audio ${i+1} · ${ar.trackFileId}\n${tcIn} → ${tcOut}${exists ? '' : '\n⚠ MXF not found'}`;
      const aFnameFull  = aFname ? aFname.replace(/\.mxf$/i, '') : ar.trackFileId.slice(0, 16) + '…';
      const aBadgeCls   = isIAB ? 'imf-asset-type-iab' : 'imf-asset-type-audio';
      const aBadgeLbl   = isIAB ? 'IAB' : (chCount ? `${chCount}ch` : 'AUDIO');
      const aMeta       = [sr ? `${(sr/1000).toFixed(0)} kHz` : '', bits ? `${bits}-bit` : ''].filter(Boolean).join(' · ');
      tr.innerHTML = `
        <td class="imf-rt-item-cell">
          <div class="imf-rt-item">
            <span class="imf-rt-dot" style="background:#4a6a8a; flex-shrink:0"></span>
            ${canPlay ? '<button class="imf-rt-play-cell" title="Preview audio">&#9654;</button>' : ''}
            <span class="imf-asset-type ${aBadgeCls}">${aBadgeLbl}</span>
            <span class="imf-rt-item-body">
              <span class="imf-rt-item-name">${aFnameFull}</span>
              <span class="imf-rt-item-tc">${tcIn} → ${tcOut}${aMeta ? '  ·  ' + aMeta : ''}</span>
            </span>
            <span class="imf-rt-item-num">${i + 1}</span>
          </div>
        </td>`;

      tr.addEventListener('click', () => {
        audioTbody.querySelectorAll('tr.imf-rt-selected').forEach(r => r.classList.remove('imf-rt-selected'));
        tbody.querySelectorAll('tr').forEach(r => r.classList.remove('imf-rt-selected'));
        tr.classList.add('imf-rt-selected');
        showTrackDetail(ar, fps, i + 1, myAudioOffset, cpl);
      });

      if (canPlay) {
        const playCell = tr.querySelector('.imf-rt-play-cell');
        if (playCell) {
          playCell.addEventListener('click', (e) => {
            e.stopPropagation();
            _playAudioPreview(ar, playCell, cpl);
          });
        }
      }

      audioTbody.appendChild(tr);
    });
  }
}

// ── Adaptive ruler with live ticks ───────────────────────────────────────────
// Called on every zoom/pan change so the ruler always reflects the current view.

function _fmtRulerLabel(sec, intervalSec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (intervalSec >= 3600) return `${h}h`;
  if (intervalSec >= 60) return h > 0 ? `${h}:${String(m).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`;
  return h > 0
    ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
    : `${m}:${String(s).padStart(2,'0')}`;
}

function _renderLiveRuler() {
  const ruler = $('imfTLRuler');
  if (!ruler) return;

  const totalFrames = _tlNav.totalFrames || 1;
  const fps         = _tlNav.fps || 24;
  const zoom        = Math.max(1, _tlNav.zoom || 1);
  const span        = _timelineViewSpan();
  const pan         = _tlNav.pan || 0;
  const outerWidth  = Math.max(1, ruler.getBoundingClientRect().width || 1);
  const innerWidth  = Math.max(outerWidth, Math.round(outerWidth * zoom));

  // Pick tick interval based on visible duration (seconds)
  const visibleSec = span / fps;
  const INTERVALS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  // Aim for roughly 8–14 visible ticks; min-pixel gap = 60px
  const minTickFrames = (60 / outerWidth) * span;
  const minTickSec    = minTickFrames / fps;
  const tickIntervalSec = INTERVALS.find(t => t >= minTickSec) || INTERVALS[INTERVALS.length - 1];
  const tickIntervalFr  = tickIntervalSec * fps;

  // Range of frames currently visible (with 1 interval margin)
  const firstFr = Math.max(0, pan - tickIntervalFr);
  const lastFr  = Math.min(totalFrames, pan + span + tickIntervalFr);

  // Build tick list — regular interval ticks
  const ticks = [];
  const firstTick = Math.ceil(firstFr / tickIntervalFr) * tickIntervalFr;
  for (let f = firstTick; f <= lastFr; f += tickIntervalFr) {
    if (f < 0 || f > totalFrames) continue;
    ticks.push({ frame: Math.round(f), sec: f / fps, isReel: false });
  }
  // Reel boundary ticks (always shown regardless of interval)
  for (const range of (_tlNav.reelRanges || [])) {
    const f = range.absStart;
    if (f > 0 && f >= firstFr && f <= lastFr) {
      ticks.push({ frame: f, sec: f / fps, isReel: true, reelNum: range.index + 1 });
    }
  }

  // Ensure inner exists and preserve the playhead element
  let inner = ruler.querySelector('.imf-tl-ruler-inner');
  if (!inner) {
    inner = el('div', 'imf-tl-ruler-inner');
    inner.appendChild(el('div', 'imf-tl-playhead'));
    ruler.appendChild(inner);
  }
  const playhead = inner.querySelector('.imf-tl-playhead');
  inner.innerHTML = '';
  if (playhead) inner.appendChild(playhead);

  // Render ticks; deduplicate by pixel position (±1px)
  const usedPx = new Set();
  ticks.sort((a, b) => a.frame - b.frame).forEach(t => {
    const leftPx = Math.round((t.frame / totalFrames) * innerWidth);
    if (usedPx.has(leftPx) || usedPx.has(leftPx - 1) || usedPx.has(leftPx + 1)) return;
    usedPx.add(leftPx);
    const tick = el('div', t.isReel ? 'imf-tl-tick imf-tl-tick-reel' : 'imf-tl-tick');
    tick.style.left = `${leftPx}px`;
    tick.textContent = _fmtRulerLabel(t.sec, tickIntervalSec);
    if (t.isReel) tick.title = `Reel ${t.reelNum} start`;
    inner.appendChild(tick);
  });
}

// Legacy alias kept for call sites that pass (totalFrames, fps) — ignored now
function renderTCRuler(_totalFrames, _fps) { _renderLiveRuler(); }

// ── Hover timecode cursor ─────────────────────────────────────────────────────
// ── Timeline row toggle filter chips ─────────────────────────────────────────
// Maps data-row → DOM row id + default visibility (DV rows shown only when DV data exists)
const _TL_ROW_MAP = {
  dv:    { id: 'imfTLDV',        dvOnly: true  },
  trim:  { id: 'imfTLTrim',      dvOnly: true  },
  cuts:  { id: 'imfTLDoviShots', dvOnly: true  },
  video: { id: 'imfTLVideo',     dvOnly: false },
  iab:   { id: 'imfTLAudio',     dvOnly: false },
};
// Track which rows user has manually toggled
const _tlRowEnabled = { dv: true, trim: true, cuts: true, video: true, iab: true };

function _wireTimelineRowToggles() {
  const bar = document.getElementById('imfTLRowFilters');
  if (!bar || bar.dataset.wired) return;
  bar.dataset.wired = '1';

  bar.querySelectorAll('.imf-tl-rf').forEach(btn => {
    const rowKey = btn.dataset.row;
    const cfg = _TL_ROW_MAP[rowKey];
    if (!cfg) return;

    // All rows default ON — DV/TRIM/CUTS show empty state when no data
    btn.classList.add('imf-tl-rf-on');
    _tlRowEnabled[rowKey] = true;
    _applyRowVisibility(rowKey);

    btn.addEventListener('click', () => {
      _tlRowEnabled[rowKey] = !_tlRowEnabled[rowKey];
      btn.classList.toggle('imf-tl-rf-on', _tlRowEnabled[rowKey]);
      _applyRowVisibility(rowKey);
    });
  });
}

function _applyRowVisibility(rowKey) {
  const cfg = _TL_ROW_MAP[rowKey];
  if (!cfg) return;
  const el = document.getElementById(cfg.id);
  if (!el) return;
  // Rows that have no data (display:none set by _refreshDoviMetaRows etc.) stay hidden
  // even if toggle is on — the toggle only gates user-selected visibility.
  if (!_tlRowEnabled[rowKey]) {
    el.dataset.tfHidden = '1';
    el.style.display = 'none';
  } else {
    delete el.dataset.tfHidden;
    // Only show if the row has actual content (not display:none from data layer)
    if (el.dataset.tfNoData !== '1') el.style.display = '';
  }
}

// Called by _refreshDoviMetaRows to update chip accent (data indicator only — does NOT hide rows).
function _updateDvToggleVisibility(hasDV) {
  window._imfDvPresent = hasDV;
  const bar = document.getElementById('imfTLRowFilters');
  if (!bar) return;
  ['dv', 'trim', 'cuts'].forEach(key => {
    const btn = bar.querySelector(`[data-row="${key}"]`);
    if (btn) {
      btn.classList.toggle('imf-tl-rf-on', _tlRowEnabled[key]);
      btn.style.opacity = _tlRowEnabled[key] ? (hasDV ? '1' : '0.55') : '0.35';
      btn.title = hasDV ? `Toggle ${key.toUpperCase()} row` : `Toggle ${key.toUpperCase()} row (no ${key.toUpperCase()} data detected)`;
    }
  });
  // Show "Extract DoVi" button when DV metadata may be embedded and per-shot CM XML is missing.
  // Show for both EXTRACTOR_REQUIRED (no Metafier tried yet) and CONFIRMED_NO_DATA
  // (DV confirmed from CPL/binary scan but no XML extracted).
  const extractBtn = document.getElementById('imfDoviExtractBtn');
  if (extractBtn) {
    const hasPath = !!(_imfSourceFolderPath || (() => { try { return localStorage.getItem('pfx_imf_native_root') || ''; } catch { return ''; } })());
    const needsExtraction = hasPath && (
      _doviExtractResult?.status === DOVI_STATUS.EXTRACTOR_REQUIRED ||
      _doviExtractResult?.status === DOVI_STATUS.CONFIRMED_NO_DATA
    );
    extractBtn.style.display = needsExtraction ? '' : 'none';
  }
}

function _wireTimelineHover() {
  const tlBody = document.querySelector('.imf-tl-body');
  if (!tlBody || tlBody.dataset.hoverBound === '1') return;
  tlBody.dataset.hoverBound = '1';

  const hoverEl = document.createElement('div');
  hoverEl.id = 'imfTLHoverCursor';
  hoverEl.className = 'imf-tl-hover-cursor';
  hoverEl.style.display = 'none';
  tlBody.appendChild(hoverEl);

  const _updateHover = (e) => {
    if (!_pkg?.cpl) { hoverEl.style.display = 'none'; return; }
    const ruler = $('imfTLRuler');
    if (!ruler) return;
    const rect = ruler.getBoundingClientRect();
    const x   = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const abs = Math.min(
      _tlNav.totalFrames - 1,
      Math.max(0, _tlNav.pan + Math.round((x / Math.max(1, rect.width)) * _timelineViewSpan()))
    );
    const fps  = _tlNav.fps || 24;
    const sec  = abs / fps;
    const h    = Math.floor(sec / 3600);
    const m    = Math.floor((sec % 3600) / 60);
    const s    = Math.floor(sec % 60);
    const fr   = Math.floor(abs % fps);
    const tc   = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}:${String(fr).padStart(2,'0')}`;
    const range = _findReelAtAbsFrame(abs);
    const badge = range ? ` R${range.index + 1}` : '';
    hoverEl.textContent = `${tc}${badge}`;
    // Position tooltip just above cursor, clamped to body bounds
    const bodyRect = tlBody.getBoundingClientRect();
    const hx = Math.max(0, Math.min(e.clientX - bodyRect.left, bodyRect.width - 120));
    hoverEl.style.left = `${hx}px`;
    hoverEl.style.display = '';
  };

  tlBody.addEventListener('mousemove', _updateHover);
  tlBody.addEventListener('mouseleave', () => { hoverEl.style.display = 'none'; });
  tlBody.addEventListener('mousedown',  () => { hoverEl.style.display = 'none'; });
}

function renderAssetList(cpl, colorMap) {
  const list = $('imfAssetList');
  if (!list || !_pkg) return;

  const { pkl, resolveFile, assetLabel } = _pkg;
  const assetEntries = [];
  const countBadge = $('imfAssetCount');
  list.innerHTML = '';

  // Build set of IAB track file IDs from CPL audio resources
  const iabIds = new Set((cpl.iabResources || []).map(r => r.trackFileId));
  const audioIds = new Set((cpl.audioResources || []).map(r => r.trackFileId));
  const vidIds = new Set((cpl.videoResources || []).map(r => r.trackFileId));

  const seen = new Set();
  const pushAsset = (id, asset) => {
    const safeId = String(id || asset?.id || '').trim();
    if (!safeId || seen.has(safeId)) return;
    seen.add(safeId);
    assetEntries.push([safeId, { ...(asset || {}), id: safeId }]);
  };

  // 1. Always include every asset directly referenced by the active composition,
  // even if those files live in a different base/supplemental package.
  [...(cpl.videoResources || []), ...(cpl.audioResources || [])].forEach((res) => {
    const id = String(res?.trackFileId || '').trim();
    if (!id) return;
    pushAsset(id, getAssetMetaById(id) || pkl.assets?.[id] || {});
  });

  // 2. Include the active CPL / PKL / XML assets from the current package for context.
  Object.entries(pkl.assets || {}).forEach(([id, asset]) => {
    const label = String(asset?.file || asset?.assetMapPath || '').toLowerCase();
    if ((asset?.type && /xml/i.test(asset.type)) || label.endsWith('.xml')) {
      pushAsset(id, asset);
    }
  });

  // 3. If the package still has extra directly-related assets not yet included, append them.
  Object.entries(pkl.assets || {}).forEach(([id, asset]) => pushAsset(id, asset));

  if (countBadge) countBadge.textContent = `${assetEntries.length}`;

  if (!assetEntries.length) {
    list.innerHTML = '<div class="imf-asset-empty">No assets found in this package</div>';
    return;
  }

  assetEntries.sort((a, b) => {
    const [idA] = a;
    const [idB] = b;
    const rank = (id) => vidIds.has(id) ? 0 : iabIds.has(id) ? 1 : audioIds.has(id) ? 2 : 3;
    const r = rank(idA) - rank(idB);
    if (r) return r;
    return (assetLabel(a[1]) || idA).localeCompare(assetLabel(b[1]) || idB);
  });

  // MXF files (video/audio) are now shown inline in the reel table — only render XML package files here
  const xmlOnly = assetEntries.filter(([id, asset]) => {
    const label = String(asset?.file || '').toLowerCase();
    return asset?.type === 'text/xml' || label.endsWith('.xml');
  });
  if (!xmlOnly.length) {
    list.innerHTML = '';
    return;
  }
  // Replace assetEntries with xml-only for rendering below
  assetEntries.length = 0;
  xmlOnly.forEach(e => assetEntries.push(e));

  const descById = new Map((cpl.descriptors || []).map(d => [d.id, d]));

  for (const [id, asset] of assetEntries) {
    const fh     = resolveFile(asset) || resolveFile(id);
    const sizeStr = asset.size
      ? asset.size >= 1e9 ? `${(asset.size / 1e9).toFixed(2)} GB`
      : asset.size >= 1e6 ? `${(asset.size / 1e6).toFixed(1)} MB`
      : `${(asset.size / 1e3).toFixed(0)} KB`
      : '–';
    const isXML  = asset.type === 'text/xml' || asset.file?.toLowerCase().endsWith('.xml');
    const isIAB  = iabIds.has(id);
    const isVid  = vidIds.has(id);
    const isAud  = audioIds.has(id) && !isIAB;
    const color  = colorMap.get(id) || (isXML ? '#666' : isIAB ? '#c678dd' : '#888');
    const exists = !!(fh && !fh.__pfxVirtual);
    const virtual = !!(fh && fh.__pfxVirtual);
    const typeLabel = isXML ? (asset.file?.toLowerCase().includes('pkl') ? 'PKL' : asset.file?.toLowerCase().includes('assetmap') ? 'AM' : 'CPL') : isIAB ? 'IAB' : isVid ? 'VIDEO' : isAud ? 'AUDIO' : 'MXF';
    const iconChar  = isXML ? '📄' : isIAB ? '🔊' : isAud ? '🎵' : '🎬';

    // Descriptor-based metadata line
    const linkedRes = [...(cpl.videoResources || []), ...(cpl.audioResources || [])].find(r => String(r.trackFileId || '') === id);
    const desc = linkedRes ? descById.get(linkedRes.essenceDescriptorId) : null;
    let metaLine = '';
    if (desc && isVid) {
      const codecStr = desc.isHTJ2K ? 'HTJ2K' : desc.isJ2K ? 'J2K' : desc.isRGBA ? 'RGBA' : desc.isCDCI ? 'CDCI' : '';
      const parts = [
        `${desc.w}×${desc.h}`,
        desc.depth && desc.depth !== '–' ? `${desc.depth}-bit` : '',
        codecStr,
        desc.isDVision ? 'DV' : '',
        desc.frameLayout ? desc.frameLayout.slice(0,4) : '',
      ].filter(Boolean);
      metaLine = parts.join(' · ');
    } else if (desc && (isAud || isIAB)) {
      const parts = [
        desc.audioSampleRate ? `${(desc.audioSampleRate/1000).toFixed(0)} kHz` : '',
        desc.audioQuantBits  ? `${desc.audioQuantBits}-bit` : '',
        desc.channelCount    ? `${desc.channelCount}ch` : '',
      ].filter(Boolean);
      if (isIAB) parts.unshift('IAB / Dolby Atmos');
      metaLine = parts.join(' · ');
    } else if (isXML) {
      metaLine = asset.type || 'text/xml';
    }

    const statusStr = exists ? '<span class="imf-asset-ok">✓</span>'
      : virtual ? '<span class="imf-asset-virtual" title="Companion-loaded (virtual)">~</span>'
      : '<span class="imf-asset-miss">✗</span>';

    const row = el('div', `imf-asset-row${(exists || virtual) ? '' : ' imf-asset-missing'}`);
    row.innerHTML = `
      <span class="imf-asset-dot" style="background:${color}"></span>
      <span class="imf-asset-type imf-asset-type-${typeLabel.toLowerCase()}">${typeLabel}</span>
      <span class="imf-asset-info">
        <span class="imf-asset-name">${assetLabel(asset) || id.slice(0,8)+'…'}</span>
        ${metaLine ? `<span class="imf-asset-meta">${metaLine}</span>` : ''}
      </span>
      <span class="imf-asset-size">${sizeStr}</span>
      ${statusStr}
    `;

    // UUID copy on right-click or shift-click
    row.title = `${typeLabel} · ${assetLabel(asset) || id}${metaLine ? '\n' + metaLine : ''}\nShift+click to copy UUID`;
    row.addEventListener('click', (e) => {
      if (e.shiftKey) {
        e.preventDefault();
        navigator.clipboard?.writeText(id).catch(() => {});
        const orig = row.querySelector('.imf-asset-name')?.textContent;
        if (orig) {
          const nm = row.querySelector('.imf-asset-name');
          if (nm) { nm.textContent = 'UUID copied!'; setTimeout(() => { nm.textContent = orig; }, 1200); }
        }
        return;
      }
      if (!linkedRes) return;
      let offset = 0;
      const isPicture = cpl.videoResources.includes(linkedRes);
      const trackList = isPicture ? cpl.videoResources : cpl.audioResources;
      const trackIndex = trackList.indexOf(linkedRes);
      for (let i = 0; i < trackIndex; i++) offset += trackList[i].sourceDuration || 0;
      showTrackDetail(linkedRes, cpl.editRate, trackIndex + 1, offset, cpl);
      switchLeftTab('reels');
    });
    if (linkedRes) row.classList.add('imf-asset-linked');
    list.appendChild(row);
  }
}

function showTrackDetail(res, fps, reelNum, frameOffset, cpl = _pkg?.cpl) {
  const detail = $('imfTrackDetail');
  if (!detail) return;

  // ── SMPTE timecode helper: HH:MM:SS:FF ───────────────────────────────────
  const fmtSMPTE = (frames) => {
    const f  = Math.floor(frames % fps);
    const s  = Math.floor(frames / fps) % 60;
    const m  = Math.floor(frames / fps / 60) % 60;
    const h  = Math.floor(frames / fps / 3600);
    const p  = n => String(Math.floor(n)).padStart(2, '0');
    return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
  };

  const tcIn  = fmtSMPTE(frameOffset || 0);
  const tcOut = fmtSMPTE((frameOffset || 0) + res.sourceDuration);
  const kind  = _resourceKind(cpl, res);

  // Resolve descriptor for this resource
  const descById = new Map((cpl?.descriptors || []).map(d => [d.id, d]));
  const desc = descById.get(res.essenceDescriptorId);
  // Fallback DV descriptor: first DV-bearing descriptor in the CPL
  const dvDescFallback = (cpl?.descriptors || []).find(d => d.isDVision);

  // ── Descriptor-derived values ────────────────────────────────────────────
  const codecStr   = !desc ? '–' : desc.isHTJ2K ? 'HTJ2K' : desc.isJ2K ? 'J2K' : desc.isRGBA ? 'RGBA' : desc.isCDCI ? 'CDCI' : '–';
  const resStr     = desc?.w && desc?.h ? `${desc.w}×${desc.h}` : '';
  const depthStr   = desc?.depth && desc.depth !== '–' ? `${desc.depth}-bit` : '';
  const transferRaw = (desc?.tc && desc.tc !== '–') ? desc.tc : '';
  const primaries  = (desc?.cp && desc.cp !== '–') ? desc.cp : '';
  const scan       = desc?.frameLayout || (desc?.isPicture ? 'Progressive' : '');

  // Transfer color class: PQ=orange, HLG=green, SDR=muted
  const tcClass = /PQ|2084|HDR/i.test(transferRaw) ? 'imf-td-pq'
    : /HLG/i.test(transferRaw) ? 'imf-td-hlg'
    : transferRaw ? 'imf-td-sdr' : '';

  // File size
  const _asset  = getAssetMetaById(res.trackFileId) || {};
  const sizeStr = _asset.size
    ? _asset.size >= 1e9 ? `${(_asset.size / 1e9).toFixed(2)} GB`
    : _asset.size >= 1e6 ? `${(_asset.size / 1e6).toFixed(0)} MB`
    : `${(_asset.size / 1e3).toFixed(0)} KB` : '';

  const uuidShort = res.trackFileId ? res.trackFileId.slice(0, 8) + '…' + res.trackFileId.slice(-4) : '–';
  const dur = fmtDuration(res.sourceDuration / fps);

  // DV: descriptor OR CPL-level flag OR Metafier XML shots loaded
  const hasDV = !!(desc?.isDVision || cpl?.isDolbyVision || _doviMetafierShots?.length);
  // Source for DV values: per-reel desc → first DV desc → {}
  const dvSrc = (desc?.isDVision ? desc : dvDescFallback) || {};

  // Supplement mastering/MaxCLL from Metafier L6 when descriptor lacks it
  const _metaShot = _doviMetafierShots?.find?.(s => s.l6);
  const _metaL6   = _metaShot?.l6 || {};
  const dvMaxLum  = dvSrc.masteringMaxLum  ?? _metaL6.maxMasteringLuminance  ?? null;
  const dvMinLum  = dvSrc.masteringMinLum  ?? _metaL6.minMasteringLuminance  ?? null;
  const dvMaxCLL  = dvSrc.maxCLL           ?? _metaL6.maxContentLightLevel   ?? null;
  const dvMaxFALL = dvSrc.maxFALL          ?? _metaL6.maxFrameAverageLightLevel ?? null;

  // ── Helpers ───────────────────────────────────────────────────────────────
  const pill  = (t, cls='') => `<span class="imf-pro-pill ${cls}">${t}</span>`;
  const row4  = (a,b,c,d) => `
    <div class="imf-pro-row4">
      ${a ? `<div class="imf-pro-cell"><div class="imf-pro-k">${a[0]}</div><div class="imf-pro-v">${a[1]}</div></div>` : '<div class="imf-pro-cell"></div>'}
      ${b ? `<div class="imf-pro-cell"><div class="imf-pro-k">${b[0]}</div><div class="imf-pro-v">${b[1]}</div></div>` : '<div class="imf-pro-cell"></div>'}
      ${c ? `<div class="imf-pro-cell"><div class="imf-pro-k">${c[0]}</div><div class="imf-pro-v">${c[1]}</div></div>` : '<div class="imf-pro-cell"></div>'}
      ${d ? `<div class="imf-pro-cell"><div class="imf-pro-k">${d[0]}</div><div class="imf-pro-v">${d[1]}</div></div>` : '<div class="imf-pro-cell"></div>'}
    </div>`;

  // ── Essence rows — only non-empty values, flexible count ─────────────────
  const essenceItems = [
    resStr   ? ['Resolution', resStr]   : null,
    depthStr ? ['Bit Depth',  depthStr] : null,
    scan     ? ['Scan',       scan.replace('Progressive','Prog').replace('Interlaced','Intl')] : null,
    sizeStr  ? ['File Size',  sizeStr]  : null,
    (res.entryPoint || 0) !== 0 ? ['Entry Pt', String(res.entryPoint)] : null,
    (res.intrinsicDuration && res.intrinsicDuration !== res.sourceDuration)
      ? ['Intrinsic', `${(res.intrinsicDuration||0).toLocaleString()} fr`] : null,
  ].filter(Boolean);

  const essenceLabel = essenceItems.length ? '<span class="imf-pro-sec-lbl">Essence</span>' : '';
  const essenceRows  = essenceItems.length ? `
    <div class="imf-pro-essence-grid" style="grid-template-columns:repeat(${Math.min(essenceItems.length,4)},1fr)">
      ${essenceItems.map(([k,v]) => `<div class="imf-pro-cell"><div class="imf-pro-k">${k}</div><div class="imf-pro-v">${v}</div></div>`).join('')}
    </div>` : '';

  // ── Color science ─────────────────────────────────────────────────────────
  const colorRows = desc?.isPicture && (transferRaw || primaries) ? `
    <span class="imf-pro-sec-lbl">Color Science</span>
    <div class="imf-pro-color-row">
      ${transferRaw ? `<span class="imf-pro-transfer ${tcClass}">${transferRaw}</span>` : ''}
      ${primaries   ? `<span class="imf-pro-primaries">${primaries}</span>` : ''}
      ${scan        ? `<span class="imf-pro-primaries">${scan}</span>` : ''}
    </div>` : '';

  // ── Dolby Vision card ─────────────────────────────────────────────────────
  const dvSection = hasDV ? (() => {
    const dvp    = dvSrc.dvProfile || cpl?.dvProfile || '–';
    const dvl    = dvSrc.dvLevel   || cpl?.dvLevel   || '–';
    const trims  = dvSrc.dvTrimPasses != null ? dvSrc.dvTrimPasses : null;
    const maxLum = dvMaxLum;
    const minLum = dvMinLum;
    const maxCLL = dvMaxCLL;
    const maxFALL= dvMaxFALL;
    return `
    <div class="imf-pro-dv">
      <div class="imf-pro-dv-header">
        <span class="imf-pro-dv-logo">DOLBY VISION</span>
        <span class="imf-pro-dv-profile">Profile ${dvp}</span>
        <span class="imf-pro-dv-level">Level ${dvl}</span>
        ${trims != null ? `<span class="imf-pro-dv-trims">${trims} trim${trims !== 1 ? 's' : ''}</span>` : ''}
      </div>
      ${(maxLum != null || maxCLL != null) ? `
      <div class="imf-pro-dv-meta">
        ${maxLum != null ? `<div class="imf-pro-dv-row">
          <span class="imf-pro-dv-k">Mastering Display</span>
          <span class="imf-pro-dv-v">
            <span class="imf-pro-dv-nits">${maxLum}</span> cd/m² max
            ${minLum != null ? ` · <span class="imf-pro-dv-nits-lo">${minLum}</span> min` : ''}
          </span>
        </div>` : ''}
        ${maxCLL != null ? `<div class="imf-pro-dv-row">
          <span class="imf-pro-dv-k">MaxCLL / MaxFALL</span>
          <span class="imf-pro-dv-v">
            <span class="imf-pro-dv-nits">${maxCLL}</span> · <span class="imf-pro-dv-nits-lo">${maxFALL ?? '?'}</span> cd/m²
          </span>
        </div>` : ''}
      </div>` : ''}
    </div>`;
  })() : '';

  // ── Audio spec ────────────────────────────────────────────────────────────
  const audioRows = (!desc?.isPicture && !desc?.isIAB && desc) ? row4(
    desc.audioSampleRate ? ['Sample Rate', `${(desc.audioSampleRate/1000).toFixed(0)} kHz`] : null,
    desc.audioQuantBits  ? ['Bit Depth',   `${desc.audioQuantBits}-bit`] : null,
    desc.channelCount    ? ['Channels',    `${desc.channelCount} ch`]    : null,
    null,
  ) : '';

  // ── Warnings (repeat only — entry+intrinsic moved to ESSENCE grid) ─────────
  const warnings = (res.repeatCount || 1) > 1
    ? `<span class="imf-pro-warn imf-pro-warn-red">Repeat ×${res.repeatCount} ⚠</span>` : '';

  detail.innerHTML = `
    <div class="imf-pro-head">
      <div class="imf-pro-pills">
        ${pill(kind, 'imf-pro-pill-kind')}
        ${codecStr !== '–' ? pill(codecStr, 'imf-pro-pill-codec') : ''}
        ${resStr   ? pill(resStr,  'imf-pro-pill-res') : ''}
        ${hasDV    ? pill('Dolby Vision', 'imf-pro-pill-dv') : ''}
      </div>
      <button class="imf-pro-uuid imf-detail-copy" title="${res.trackFileId} — click to copy">${uuidShort} ⎘</button>
    </div>

    <div class="imf-pro-tc">
      <div class="imf-pro-tc-range">
        ${tcIn}<span class="imf-pro-tc-sep">→</span>${tcOut}
      </div>
      <div class="imf-pro-tc-meta">
        <span>${res.sourceDuration.toLocaleString()} fr</span>
        <span class="imf-pro-tc-dot">·</span>
        <span>${dur}</span>
        <span class="imf-pro-tc-dot">·</span>
        <span>${parseFloat(Number(res.editRate).toFixed(3))} fps</span>
        ${warnings}
      </div>
    </div>

    ${colorRows}
    ${essenceLabel}${essenceRows}
    ${audioRows}
    ${dvSection}
  `;

  // UUID click-to-copy
  detail.querySelector('.imf-detail-copy')?.addEventListener('click', (e) => {
    navigator.clipboard?.writeText(res.trackFileId).catch(() => {});
    const el = e.currentTarget;
    const orig = el.textContent;
    el.textContent = 'Copied!';
    setTimeout(() => { el.textContent = orig; }, 1200);
  });

  detail.style.display = 'block';
  if (_isIabResource(cpl, res)) {
    detail.dataset.iabToken = `${_pkg?.currentCplKey || _currentCplKey}:${res.trackFileId}`;
    _populateIabTrackDetail(detail, res, cpl);
  }
}

async function _populateIabTrackDetail(detail, res, cpl) {
  const token = `${_pkg?.currentCplKey || _currentCplKey}:${res.trackFileId}`;
  const decodeSummary = _iabDecodeSummary();
  const decodeDetail = _iabDecodeDetail();
  const decodeEngine = _iabDecodeCaps.engineLabel || _iabDecodeCaps.engineId || (_iabDecodeCaps.loading ? 'Checking…' : 'Unavailable');
  const appendRows = (html) => {
    if (!detail || detail.dataset.iabToken !== token) return;
    detail.insertAdjacentHTML('beforeend', html);
  };
  appendRows(`
    <div class="imf-detail-row"><b>IAB Decode</b> Inspecting embedded ADM…</div>
  `);

  const asset = getAssetMetaById(res.trackFileId) || {};
  const file = _pkg?.resolveFile(asset) || _pkg?.resolveFile(res.trackFileId);
  if (!file || typeof file.slice !== 'function') {
    if (_imfSourceBackend === 'companion' && _imfSourcePackageId && cpl?.id) {
      try {
        const info = await imfInspectImmersiveAudio(_imfSourcePackageId, cpl.id);
        if (!detail || detail.dataset.iabToken !== token) return;
        const obj = info?.objectSummary || {};
        detail.innerHTML = detail.innerHTML.replace('Inspecting embedded ADM…', 'Companion metadata');
        appendRows(`
          <div class="imf-detail-row"><b>Programme</b> ${(info?.programmeNames || []).join(', ') || '—'}</div>
          <div class="imf-detail-row"><b>Content Groups</b> ${(info?.contentNames || []).join(', ') || '—'}</div>
          <div class="imf-detail-row"><b>Object Count</b> ${obj.totalObjects || 0} total · ${obj.bedObjects || 0} bed · ${obj.numberedObjects || 0} numbered objects</div>
          <div class="imf-detail-row"><b>Named Objects</b> ${(obj.sampleNamedObjects || []).join(', ') || '—'}</div>
          <div class="imf-detail-row"><b>ADM Stats</b> prog:${info?.admStats?.audioProgramme || 0} · cont:${info?.admStats?.audioContent || 0} · obj:${info?.admStats?.audioObject || 0} · pack:${info?.admStats?.audioPackFormat || 0}</div>
          <div class="imf-detail-row"><b>Decode Engine</b> ${decodeEngine}</div>
          <div class="imf-detail-row"><b>Decode Status</b> ${decodeSummary}</div>
          <div class="imf-detail-row"><b>Decode Notes</b> ${decodeDetail || 'Metadata inspection came from the native companion.'}</div>
        `);
        return;
      } catch {}
    }
    if (detail && detail.dataset.iabToken === token) {
      detail.innerHTML = detail.innerHTML.replace('Inspecting embedded ADM…', 'Unavailable');
      appendRows(`
        <div class="imf-detail-row"><b>Decode Engine</b> ${decodeEngine}</div>
        <div class="imf-detail-row"><b>Decode Status</b> ${decodeSummary}</div>
        <div class="imf-detail-row"><b>Why</b> ${decodeDetail || 'Metadata can be read, but actual audio decode needs a dedicated immersive-audio engine.'}</div>
      `);
    }
    return;
  }

  try {
    const info = await inspectIabAdm(file);
    if (!detail || detail.dataset.iabToken !== token) return;
    const counts = info.counts || { pass: 0, warn: 0, reject: 0 };
    const obj = info.objectSummary || {};
    detail.innerHTML = detail.innerHTML.replace('Inspecting embedded ADM…', 'Unavailable in current build');
    appendRows(`
      <div class="imf-detail-row"><b>Programme</b> ${(info.programmeNames || []).join(', ') || '—'}</div>
      <div class="imf-detail-row"><b>Content Groups</b> ${(info.contentNames || []).join(', ') || '—'}</div>
      <div class="imf-detail-row"><b>Object Count</b> ${obj.totalObjects || 0} total · ${obj.bedObjects || 0} bed · ${obj.numberedObjects || 0} numbered objects</div>
      <div class="imf-detail-row"><b>Named Objects</b> ${(obj.sampleNamedObjects || []).join(', ') || '—'}</div>
      <div class="imf-detail-row"><b>Label QC</b> ${counts.pass || 0} pass · ${counts.warn || 0} warn · ${counts.reject || 0} reject</div>
      <div class="imf-detail-row"><b>ADM Stats</b> prog:${info.admStats?.audioProgramme || 0} · cont:${info.admStats?.audioContent || 0} · obj:${info.admStats?.audioObject || 0} · pack:${info.admStats?.audioPackFormat || 0}</div>
      <div class="imf-detail-row"><b>Decode Engine</b> ${decodeEngine}</div>
      <div class="imf-detail-row"><b>Decode Status</b> ${decodeSummary}</div>
      <div class="imf-detail-row"><b>Decode Notes</b> ${decodeDetail || 'Metadata inspection is available even though PCM decode is not.'}</div>
    `);
  } catch (err) {
    if (!detail || detail.dataset.iabToken !== token) return;
    detail.innerHTML = detail.innerHTML.replace('Inspecting embedded ADM…', 'Error');
    appendRows(`
      <div class="imf-detail-row"><b>Decode Status</b> Failed to inspect embedded ADM</div>
      <div class="imf-detail-row"><b>Decode Engine</b> ${decodeEngine}</div>
      <div class="imf-detail-row"><b>Error</b> ${String(err?.message || err || 'Unknown error')}</div>
    `);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function showPanel(id) {
  // Empty/loading are flex-column; main is grid
  const display = { imfPanelEmpty: 'flex', imfPanelLoading: 'flex', imfPanelMain: 'grid' };
  for (const p of Object.keys(display)) {
    const el = $(p);
    if (el) el.style.display = p === id ? display[p] : 'none';
  }
}

// Four call sites below say `'Load failed: ' + err.message`, which lands raw
// exception text in the IMF status line. Rewriting here covers all of them and
// whatever is added next; friendlyStatus keeps the "Load failed" half, so the
// line still names the operation instead of only describing the cause.
function setStatus(type, msg) {
  const s = $('imfStatus');
  if (!s) return;
  let out = msg;
  try { out = friendlyStatus(msg); }
  catch (_) { out = msg; }   // a rewrite failure must never swallow the status being reported
  s.textContent = out;
  s.className = 'imf-status imf-status-' + type;
}

async function exportReport() {
  if (!_pkg || !_valResults.length) return;
  const { cpl, pkl, assetMap } = _pkg;
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const sep = '─'.repeat(72);

  const counts = { pass:0, warn:0, fail:0, info:0 };
  for (const r of _valResults) counts[r.sev] = (counts[r.sev]||0)+1;
  const overall = counts.fail > 0 ? 'FAIL' : counts.warn > 0 ? 'WARN' : 'PASS';

  const audioDesc = cpl.hasIAB
    ? `IAB / Dolby Atmos (${(cpl.iabResources||[]).length || (cpl.audioResources||[]).length} resource(s))`
    : `PCM ${cpl.audioLayout || ''} (${(cpl.audioResources||[]).length} resource(s))`.trim();

  // Tolerate malformed/partial CPLs — a QC report must still emit for a broken
  // package rather than throw on a missing field.
  const resStr = (cpl.resolution && cpl.resolution.w != null && cpl.resolution.h != null)
    ? `${cpl.resolution.w} × ${cpl.resolution.h}` : '—';

  const hdrDesc = (() => {
    const pd = (Array.isArray(cpl.descriptors) ? cpl.descriptors : []).find(d => d && d.isPicture);
    const parts = [];
    if (pd?.masteringMaxLum != null) parts.push(`Mastering: ${pd.masteringMaxLum} cd/m²`);
    if (pd?.maxCLL != null)          parts.push(`MaxCLL: ${pd.maxCLL}`);
    if (pd?.maxFALL != null)         parts.push(`MaxFALL: ${pd.maxFALL}`);
    return parts.join(' · ') || '—';
  })();

  const groups = [
    { prefix: 'SCHEMA', label: 'Schema / Namespace Conformance' },
    { prefix: 'AM',   label: 'Asset Map' },
    { prefix: 'PKL',  label: 'Packing List' },
    { prefix: 'CPL',  label: 'Composition Playlist' },
    { prefix: 'AUD',  label: 'Audio Intelligence' },
    { prefix: 'PIC',  label: 'Picture Quality' },
    { prefix: 'HDR',  label: 'HDR / Mastering Display' },
    { prefix: 'REEL', label: 'Inter-Reel Consistency' },
    { prefix: 'TC',   label: 'Timecode' },
    { prefix: 'APP',  label: 'Application / Delivery Logic' },
    { prefix: 'UG-',  label: 'IMF User Group Best Practice' },
    { prefix: 'PHOTON', label: 'Photon (Netflix/SMPTE)' },
    { prefix: 'HASH', label: 'Hash Verification' },
    { prefix: 'VAL',  label: 'Validation Engine Errors' },
  ];

  const lines = [
    'IMF VALIDATION REPORT — PostFlowX',
    `Generated : ${now}`,
    `Overall   : ${overall}  (${counts.fail} Fail · ${counts.warn} Warn · ${counts.info} Info · ${counts.pass} Pass · ${_valResults.length} total)`,
    sep,
    'PACKAGE SUMMARY',
    sep,
    `Title       : ${cpl.contentTitle || cpl.annotation || '–'}`,
    `Content Kind: ${cpl.contentKind || '–'}`,
    `App Version : ${cpl.appVersion || '–'}`,
    `Codec       : ${cpl.codec || '–'}`,
    `Resolution  : ${resStr}`,
    `Bit Depth   : ${cpl.bitDepth !== '–' ? cpl.bitDepth + '-bit' : '–'}`,
    `Edit Rate   : ${cpl.editRate} fps`,
    `Duration    : ${fmtFrames(cpl.totalFrames, cpl.editRate)}`,
    `Transfer    : ${cpl.transfer}`,
    `Primaries   : ${cpl.primaries}`,
    `HDR Metadata: ${hdrDesc}`,
    `Dolby Vision: ${cpl.isDolbyVision ? `Yes (Profile ${cpl.dvProfile || '?'}, Level ${cpl.dvLevel || '?'})` : 'No'}`,
    `Audio       : ${audioDesc}`,
    `Video Reels : ${(cpl.videoResources || []).length}`,
    `TC Start    : ${cpl.compositionTimecode ? `${cpl.compositionTimecode.startAddress} @ ${cpl.compositionTimecode.rate} fps${cpl.compositionTimecode.dropFrame ? ' (DF)' : ''}` : '—'}`,
    `CPL ID      : ${cpl.id}`,
    `PKL ID      : ${pkl.id}`,
    sep,
    'VALIDATION RESULTS BY GROUP',
    sep,
  ];

  for (const { prefix, label } of groups) {
    const rows = _valResults.filter(r => r.code.startsWith(prefix));
    if (!rows.length) continue;
    const gc = { pass:0, warn:0, fail:0, info:0 };
    for (const r of rows) gc[r.sev] = (gc[r.sev]||0)+1;
    lines.push('');
    lines.push(`▶ ${label.toUpperCase()}  (${rows.length} checks · ${gc.fail||0} fail · ${gc.warn||0} warn · ${gc.pass||0} pass)`);
    lines.push('  ' + '─'.repeat(68));
    for (const r of rows) {
      const tag = { pass:'PASS', warn:'WARN', fail:'FAIL', info:'INFO' }[r.sev] || r.sev.toUpperCase();
      lines.push(`  [${tag}] ${r.code.padEnd(8)} ${r.msg}`);
      if (r.detail) lines.push(`           ${r.detail}`);
    }
  }

  lines.push('');
  lines.push(sep);
  lines.push(`OVERALL: ${overall}`);
  lines.push(`PostFlowX IMF Validation · ${counts.fail} Fail · ${counts.warn} Warn · ${counts.info} Info · ${counts.pass} Pass · ${_valResults.length} checks`);

  const baseName = `IMF_Report_${(cpl.contentTitle || 'package').replace(/[^a-z0-9]/gi, '_').slice(0,40)}_${now.slice(0,10)}`;
  const saveBlob = async (fname, blob) => {
    if (typeof window.__pfxSaveBlob === 'function') {
      await window.__pfxSaveBlob(fname, blob);
    } else {
      const url = URL.createObjectURL(blob);
      const a   = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  };

  await saveBlob(`${baseName}.txt`, new Blob([lines.join('\n')], { type: 'text/plain;charset=utf-8' }));

  // ── Structured (JSON) report for pipeline ingestion ─────────────────────────
  // Uses the shared, unit-tested imfReport.toJSON() serializer so the JSON artifact
  // carries the schemaVersion, the authoritative SMPTE reference per finding, and
  // any remediation/resourceRef — deterministically FAIL-sorted. The rich package
  // metadata (codec/resolution/HDR/DV/verdict) is passed through meta.package.
  const jsonStr = buildReportJSON(_valResults, {
    generatedAt: new Date().toISOString(),
    packageName: cpl.contentTitle || cpl.annotation || '',
    cplId: cpl.id || '',
    pklId: pkl.id || '',
    package: {
      title:      cpl.contentTitle || cpl.annotation || '',
      codec:      cpl.codec || '',
      resolution: resStr === '—' ? '' : resStr.replace(/\s/g, ''),
      editRate:   cpl.editRate ?? null,
      transfer:   cpl.transfer || '',
      primaries:  cpl.primaries || '',
      hdr:        hdrDesc === '—' ? '' : hdrDesc,
      dv:         cpl.isDolbyVision ? `Profile ${cpl.dvProfile || '?'}, Level ${cpl.dvLevel || '?'}` : '',
      overall,
      counts: { fail: counts.fail, warn: counts.warn, info: counts.info, pass: counts.pass },
    },
  });
  await saveBlob(`${baseName}.json`, new Blob([jsonStr], { type: 'application/json;charset=utf-8' }));

  // ── Spreadsheet-friendly (CSV) report ──────────────────────────────────────
  // Uses the shared, unit-tested imfReport.toCSV() serializer so the CSV carries
  // the authoritative SMPTE reference per finding (RFC 4180 quoting/CRLF). The
  // validator rows (_valResults: { code, sev, msg, detail }) are exactly the row
  // shape imfReport.normalizeRow() consumes. Guarded so a serializer error can't
  // block the already-written txt+json artifacts.
  try {
    const csv = buildReportCSV(_valResults, {
      generatedAt: new Date().toISOString(),
      packageName: cpl.contentTitle || cpl.annotation || '',
      cplId: cpl.id || '',
      pklId: pkl.id || '',
    });
    // Prepend a UTF-8 BOM so Excel opens the file with correct encoding.
    await saveBlob(`${baseName}.csv`, new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
  } catch (e) {
    console.warn('[imf] CSV report export failed:', e && e.message);
  }
}

function clearPackage() {
  const handleKey = _imfHandleKey();
  _pkg = null;
  _valResults = [];
  _photonLastResults = null;
  _iabDecodeCaps = _defaultIabDecodeCaps();
  _resetLabelQC();
  _extFiles = [];
  _extFileMap = new Map();
  _imfPackages = [];
  _cplEntries = [];
  _currentCplKey = '';
  _baseCplKey = '';
  _showBaseOverlay = false;
  _imfSourceDirHandle = null;
  _imfSourceFolderName = '';
  _imfSourceBackend = '';
  _imfSourceFolderPath = '';
  _imfSourcePackageId = '';
  _imfElectronPackageHash   = '';
  _imfElectronMxfPaths      = new Map();
  _imfElectronPrepPromise   = null;
  _imfElectronCplPath       = '';
  _imfElectronAssetMapPaths = [];
  _imfAllPackageFolderPaths = [];
  try { localStorage.removeItem('pfx_imf_source_session'); } catch {}
  refreshCompositionControls();
  showPanel('imfPanelMain');
  setStatus('idle', 'Ready');
  const expBtn = $('imfExportBtn');
  if (expBtn) expBtn.style.display = 'none';
  const inp = $('imfFolderInput');
  if (inp) inp.value = '';
  // Reset player to idle (player is always visible now)
  playerLoadReel(null, { totalFrames: 0 });
  _stopAudioPreview();
  _resetProxyUI();
  _resetIabDecodeUI();
  _clearDoviMetafier();
  _admTree = null;
  _stopProxyAudioMeter();
  const nxPanel = $('imfNetflixCheck');
  if (nxPanel) nxPanel.style.display = 'none';
  const admPanel = $('imfAdmTreePanel');
  if (admPanel) admPanel.style.display = 'none';
  setImfLeftTab('validation');
  clearNamedHandle(handleKey).catch(() => {});
  try { window.__PFX_IMF_STATE = null; } catch {}
}

// ── Proxy QC ──────────────────────────────────────────────────────────────────

function wireProxyQC() {
  const btn       = $('imfProxyBtn');
  const stopBtn   = $('imfProxyStopBtn');
  const deleteBtn = $('imfProxyDeleteBtn');

  if (btn)     btn.addEventListener('click', _runProxyQC);
  const resolveBtn = $('imfResolveProxyBtn');
  if (resolveBtn) resolveBtn.addEventListener('click', () => _runProxyQC({ forceResolve: true }));
  if (stopBtn) stopBtn.addEventListener('click', () => {
    playerStopProxyMode();
    _resetProxyUI();
    _proxySessionRestoring = false;
    try { localStorage.removeItem('pfx_proxy_session'); } catch {}
  });
  if (deleteBtn) deleteBtn.addEventListener('click', async () => {
    if (!_lastProxyInfo.proxyPath && !_lastProxyInfo.fingerprint) {
      setStatus('warn', 'No proxy path recorded — cannot delete.');
      return;
    }
    // Localised, and no longer claims a cache eviction is permanent: the proxy
    // is rebuilt by ▶ Generate on this same CPL. See core/confirmText.js.
    const confirmed = confirm(deleteProxyConfirm(_lastProxyInfo.proxyPath).text);
    if (!confirmed) return;
    deleteBtn.disabled = true;
    deleteBtn.textContent = '⏳ Deleting…';
    try {
      // Stop playback first
      playerStopProxyMode();
      _resetProxyUI();
      try { localStorage.removeItem('pfx_proxy_session'); } catch {}
      await imfDeleteProxy(_lastProxyInfo);
      _lastProxyInfo = { proxyPath: '', fingerprint: '' };
      setStatus('ok', 'Proxy deleted.');
    } catch (e) {
      setStatus('error', `Delete failed: ${e?.message || e}`);
      deleteBtn.disabled = false;
      deleteBtn.textContent = '🗑 Delete Proxy';
    }
  });

  // Export ADM XML button — data stored on the element by _renderIabInspectionResult
  const exportAdmBtn = $('imfIabExportAdmBtn');
  if (exportAdmBtn) exportAdmBtn.addEventListener('click', () => {
    const xml  = exportAdmBtn._admXml  || '';
    const name = exportAdmBtn._admName || 'IAB';
    if (!xml) return;
    const blob = new Blob([xml], { type: 'text/xml;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = name.replace(/\.[^.]+$/, '') + '_ADM.xml';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  const decodeWaveformBtn = $('imfIabDecodeWaveformBtn');
  if (decodeWaveformBtn) decodeWaveformBtn.addEventListener('click', () => _runIabCompanionDecode());

  const waveformPlayBtn = $('imfIabWaveformPlayBtn');
  if (waveformPlayBtn) waveformPlayBtn.addEventListener('click', () => _playIabWaveformPreview());

  const doviRescanBtn = $('imfDoviRescanBtn');
  if (doviRescanBtn) doviRescanBtn.addEventListener('click', () => {
    _tryLoadDoviMetafier().catch(() => {});
  });

  // ── "Extract DoVi" button in timeline header ─────────────────────────────
  const doviExtractBtn    = $('imfDoviExtractBtn');
  const doviExtractStatus = $('imfDoviExtractStatus');

  function _setDoviExtractStatus(state, msg) {
    if (!doviExtractStatus) return;
    doviExtractStatus.textContent = msg;
    doviExtractStatus.dataset.state = state;
    doviExtractStatus.style.display = msg ? '' : 'none';
  }

  if (doviExtractBtn) {
    doviExtractBtn.addEventListener('click', async () => {
      const folderPath = _imfSourceFolderPath ||
        (() => { try { return localStorage.getItem('pfx_imf_native_root') || ''; } catch { return ''; } })();
      if (!_pkg?.cpl) return;
      if (!folderPath) {
        _setDoviExtractStatus('error', 'No IMF root path — use Settings > Relink IMF Root');
        return;
      }
      doviExtractBtn.disabled = true;
      _setDoviExtractStatus('running', 'Detecting Metafier…');
      try {
        // Resolve Metafier path: stored path → auto-detect
        const storedPath = _loadMetafierPath();
        const metafierInfo = await imfDetectMetafier(storedPath || undefined).catch(() => ({ found: false }));
        if (!metafierInfo?.found) {
          _setDoviExtractStatus('error', 'Metafier not found — configure path in Settings > IMF / Dolby Vision');
          doviExtractBtn.disabled = false;
          return;
        }
        // Read stored command template (empty = use Metafier default)
        const cmdTemplate = (() => { try { return localStorage.getItem('pfx_dovi_metafier_cmd') || ''; } catch { return ''; } })();

        const vids = _pkg.cpl.videoResources || [];
        let extractedShots = 0;
        let reelsChecked = 0;
        const allShots = [];

        for (let ri = 0; ri < vids.length; ri++) {
          const res   = vids[ri];
          // Resolve asset path: check assetIndex first, fall back to PKL assets
          const asset = _pkg.assetIndex?.get?.(res.trackFileId) ||
                        _pkg.pkl?.assets?.[res.trackFileId] || {};
          const assetPath = String(asset.assetMapPath || asset.file || '').replace(/^\.\//, '');
          if (!assetPath) {
            console.warn(`[DoVi Extract] reel ${ri + 1}: no asset path for ${res.trackFileId}`);
            continue;
          }
          reelsChecked++;
          _setDoviExtractStatus('running', `Reel ${ri + 1} / ${vids.length} — ${assetPath.split('/').pop()}`);

          const exResult = await imfExtractDoviFromMxf({
            packageRootPath:  folderPath,
            mxfRelativePath:  assetPath,
            assetId:          res.trackFileId || '',
            reelId:           `R${ri + 1}`,
            metafierPath:     metafierInfo.path,
            commandTemplate:  cmdTemplate || undefined,
          }).catch(e => ({ ok: false, errorCode: 'EXTRACT_FAILED', message: String(e?.message || e) }));

          if (!exResult?.ok) {
            if (exResult?.errorCode === 'NO_DOVI_METADATA') {
              console.log(`[DoVi Extract] Reel ${ri + 1}: no embedded DV metadata`);
              continue;
            }
            _setDoviExtractStatus('error', `Reel ${ri + 1}: ${exResult?.message || 'Extraction failed'}`);
            // Continue to other reels unless Metafier itself is broken
            if (exResult?.errorCode === 'METAFIER_NOT_FOUND') break;
            continue;
          }

          // Handle truncated XML: companion returns xmlTruncated:true + outputXmlPath
          // when CM XML is > 512 KB. Fetch the full content via readExtractedXml.
          let xmlText = exResult.xmlText || '';
          if (!xmlText && exResult.xmlTruncated && exResult.outputXmlPath) {
            _setDoviExtractStatus('running', `Reel ${ri + 1}: reading large XML (${Math.round((exResult.xmlSizeBytes || 0) / 1024)} KB)…`);
            const readResult = await imfReadExtractedXml(exResult.outputXmlPath).catch(() => null);
            xmlText = readResult?.xmlText || '';
          }
          if (!xmlText) {
            console.log(`[DoVi Extract] Reel ${ri + 1}: empty XML from extractor`);
            continue;
          }

          try {
            const { shots } = parseDoviXml(xmlText);
            if (shots.length) {
              allShots.push(...shots);
              extractedShots += shots.length;
              _setDoviExtractStatus('running', `Reel ${ri + 1}: ${shots.length} shots found (total: ${extractedShots})`);
            }
          } catch (parseErr) {
            console.warn(`[DoVi Extract] Reel ${ri + 1} parse error:`, parseErr);
          }
        }

        if (allShots.length) {
          _setDoviExtractStatus('ok', `${allShots.length} shots from ${reelsChecked} reel${reelsChecked !== 1 ? 's' : ''}`);
          _renderDoviMetafier({ shots: allShots });
          // Update extraction result for validation
          _doviExtractResult = {
            status: DOVI_STATUS.FOUND, sourceType: DOVI_SOURCE.EMBEDDED_MXF,
            shots: annotateShots(allShots), sourcePath: folderPath,
            detectedBy: `metafier_${reelsChecked}_reels`, warnings: [], errors: [],
            hasLevel1: allShots.some(s => s.l1), hasLevel8: allShots.some(s => (Array.isArray(s.l8) ? s.l8.length : (s.l8 ? 1 : 0)) > 0),
            hasTrimPass: allShots.some(s => (s.trimPasses?.length ?? 0) > 0),
          };
          _refreshValidationResults();
          _updateDvToggleVisibility(true);
        } else {
          _setDoviExtractStatus('warn', reelsChecked ? 'No Dolby Vision metadata found in any reel' : 'No accessible video MXF files found');
          _doviExtractResult = { ...(  _doviExtractResult || {}), status: DOVI_STATUS.NOT_FOUND, warnings: ['Metafier ran but found no embedded DV metadata.'] };
        }
      } catch (e) {
        _setDoviExtractStatus('error', e?.message || 'Extraction error');
        console.error('[DoVi Extract] Unhandled error:', e);
      } finally {
        doviExtractBtn.disabled = false;
      }
    });
  }

  const doviPrevBtn = $('imfDoviPrevShot');
  const doviNextBtn = $('imfDoviNextShot');
  if (doviPrevBtn) doviPrevBtn.addEventListener('click', () => {
    if (_doviActiveShot > 0) _selectDoviShot(_doviActiveShot - 1);
  });
  if (doviNextBtn) doviNextBtn.addEventListener('click', () => {
    if (_doviMetafierShots && _doviActiveShot < _doviMetafierShots.length - 1)
      _selectDoviShot(_doviActiveShot + 1);
  });

  async function _doDoviExport() {
    if (!_doviMetafierShots?.length) {
      const btn = $('imfDoviExportTransportBtn');
      if (btn) {
        const orig = btn.textContent;
        btn.textContent = 'No Dolby Vision metadata loaded';
        btn.disabled = true;
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2500);
      }
      return;
    }
    const title = _pkg?.cpl?.contentTitle || _pkg?.cpl?.annotation || '';
    const xml   = exportDoviXml(_doviMetafierShots, { title });
    const blob  = new Blob([xml], { type: 'text/xml;charset=utf-8' });
    const fname = title ? `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}_DolbyVision_metadata.xml` : 'DolbyVision_metadata.xml';
    if (typeof window.__pfxSaveBlob === 'function') {
      await window.__pfxSaveBlob(fname, blob);
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = fname;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  const doviExportBtn = $('imfDoviExportBtn');
  if (doviExportBtn) doviExportBtn.addEventListener('click', _doDoviExport);

  const doviExportHdrBtn = $('imfDoviExportHeaderBtn');
  if (doviExportHdrBtn) doviExportHdrBtn.addEventListener('click', _doDoviExport);

  const doviExportTrspBtn = $('imfDoviExportTransportBtn');
  if (doviExportTrspBtn) doviExportTrspBtn.addEventListener('click', _doDoviExport);
}

function _resetProxyUI() {
  const proxyVideo = $('imfProxyVideo');
  const doviPanel  = $('imfDoviPanel');
  const progress   = $('imfProxyProgress');
  const btn        = $('imfProxyBtn');
  const stopBtn    = $('imfProxyStopBtn');
  const delBtn     = $('imfProxyDeleteBtn');
  if (delBtn) delBtn.style.display = 'none';

  playerStopProxyMode();
  _teardownWaveform();
  if (proxyVideo) {
    try { proxyVideo.pause?.(); } catch {}
    proxyVideo.currentTime = 0;
  }
  if (doviPanel)  doviPanel.style.display  = 'none';
  if (progress)   progress.style.display   = 'none';
  if (btn)        btn.style.display        = '';
  if (stopBtn)    stopBtn.style.display    = 'none';
  setProxyViewerReady(false);
  setViewerMode('imf');
  _setProxyTabState({ mode: 'idle', pct: 0, status: 'Ready to start Proxy QC', cpl: '—' });

  // Clear DoVi fields
  ['imfDoviTimecode','imfDoviProfile','imfDoviLevel',
   'imfDoviMaxCLL','imfDoviMaxFALL','imfDoviTrim'].forEach(id => {
    const e = $(id); if (e) e.textContent = '–';
  });
}

async function _runIabDecode() {
  const cpl = _pkg?.cpl;
  if (!cpl?.hasIAB) return;  // silent — caller should guard with hasIAB check

  const cplLabel = cpl.contentTitle || cpl.annotation || cpl.id || 'Current CPL';
  setImfLeftTab('transcode');

  // Find the first IAB resource in this CPL
  const iabRes = (cpl.audioResources || []).find(r => _isIabResource(cpl, r));
  if (!iabRes) return;

  // Resolve the browser-loaded file
  const asset = getAssetMetaById(iabRes.trackFileId) || {};
  const file  = _pkg?.resolveFile(asset) || _pkg?.resolveFile(iabRes.trackFileId);
  const assetName = String(asset.file || iabRes.trackFileId || '').split('/').pop() || 'IAB';

  if (!file || typeof file.slice !== 'function') {
    _setIabDecodeState({ mode: 'idle', status: 'IAB track not accessible — drag-and-drop the full package folder to inspect.', cpl: cplLabel, output: '—' });
    return;
  }

  _setIabDecodeState({ mode: 'running', pct: 20, status: 'Extracting embedded ADM…', cpl: cplLabel, output: assetName });

  try {
    const info = await inspectIabAdm(file);
    const counts = info?.counts || {};
    _setIabDecodeState({
      mode: 'done',
      pct: 100,
      cpl: cplLabel,
      status: `ADM extracted · ${counts.pass || 0} pass · ${counts.warn || 0} warn · ${counts.reject || 0} reject`,
      output: (info?.programmeNames || [])[0] || assetName,
    });
    _renderIabInspectionResult(info, assetName);
  } catch (err) {
    _setIabDecodeState({
      mode: 'error',
      pct: 0,
      status: String(err?.message || 'ADM extraction failed'),
      cpl: cplLabel,
      output: '—',
    });
  }
}

// ── Main IAB tab (PROFILE/BEDS/OBJECTS/GROUPS summary + Resolve-style track list) ──
// The redesigned IAB tab (#imfIabSum*, #imfIabTrackBody, #imfIabInspectBtn) was
// never wired to the companion inspect — so it stayed empty even though the
// backend returns the full ADM breakdown. Wire the Inspect button → companion
// inspect → populate the summary + a bed + Object 1..N track list (Resolve parity).
function _wireIabMainTab() {
  const btn = $('imfIabInspectBtn');
  if (!btn || btn._pfxWired) return;
  btn._pfxWired = true;
  btn.addEventListener('click', async () => {
    const dot = $('imfIabSumDot'); const lbl = $('imfIabSumStatusLbl');
    const status = (cls, text) => {
      if (dot) dot.className = `imf-iab-sum-dot imf-iab-sum-dot-${cls}`;
      if (lbl) lbl.textContent = text;
    };
    if (!_imfSourcePackageId || !_pkg?.cpl?.id) { status('err', 'Load an IMF package first'); return; }
    // If the CPL has no IAB track at all, this is a PCM/non-immersive package
    // (e.g. SOSYALCLIM = 5.1 + 2.0 PCM) — say so clearly instead of a blank tab.
    if (_pkg.cpl.hasIAB === false || (!_pkg.cpl.iabResources?.length && _pkg.cpl.hasIAB == null)) {
      _renderIabNoImmersive();
      status('idle', 'No IAB / immersive audio in this package');
      return;
    }
    status('running', 'Inspecting…');
    try {
      const info = await imfInspectImmersiveAudio(_imfSourcePackageId, _pkg.cpl.id);
      if (info?.error || info?.code === 'NO_IAB') { _renderIabNoImmersive(); status('idle', 'No IAB / immersive audio in this package'); return; }
      if (!info || (!info.admStats && !info.tracks)) { status('err', 'No IAB/ADM content found'); return; }
      _renderIabMainTab(info);
      const body = $('imfIabTrackBody');
      if (body) body.dataset.loaded = 'inspected';
      status('ok', 'Inspected');
    } catch (e) {
      console.warn('[IAB] inspect failed', e);
      // NO_IAB surfaces as a thrown error in some bridges — treat as the PCM case.
      if (/no.?iab|immersive/i.test(String(e?.message || e))) { _renderIabNoImmersive(); status('idle', 'No IAB / immersive audio in this package'); }
      else status('err', 'Inspect failed');
    }
  });
}

function _iabTrackNameFromIndex(i) {
  return i === 0 ? 'defaultBed' : `Object ${i}`;
}

function _iabLayoutChannels(layout = '') {
  if (/7\.1\.4|7\.1\.2|7\.1/i.test(layout)) return ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Lrs', 'Rrs'];
  if (/5\.1/i.test(layout)) return ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'];
  return ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Lrs', 'Rrs'];
}

function _iabTracksFromInfo(info = {}) {
  const obj = info.objectSummary || {};
  const stats = info.admStats || {};
  const layout = info.bedLayout || obj.bedLayout || '7.1.4';
  const sourceTracks = Array.isArray(info.tracks) ? info.tracks : [];
  if (sourceTracks.length) {
    let objectNumber = 0;
    return sourceTracks.map((t, i) => {
      const isBed = t.type === 'bed' || /bed/i.test(String(t.name || ''));
      if (!isBed) objectNumber += 1;
      return {
        type: isBed ? 'bed' : 'object',
        index: i + 1,
        lane: `A${i + 1}`,
        name: t.name || (isBed ? 'defaultBed' : `Object ${objectNumber}`),
        layout: t.layout || (isBed ? layout : '1.0'),
        channels: Number(t.channels || (isBed ? _iabLayoutChannels(layout).length : 1)),
        gain: t.gain ?? '0.0',
        render: isBed ? layout : 'Object',
        qc: t.qc || '✓',
      };
    });
  }

  const total = Number(obj.totalObjects || stats.audioObject || 0);
  const beds = Number(obj.bedObjects || (info.beds?.length ? info.beds.length : 1) || 1);
  const dynamic = Number(obj.dynamicObjects != null ? obj.dynamicObjects : Math.max(0, total - beds)) || 32;
  const rows = [];
  rows.push({
    type: 'bed',
    index: 1,
    lane: 'A1',
    name: 'defaultBed',
    layout,
    channels: _iabLayoutChannels(layout).length,
    gain: '0.0',
    render: layout,
    qc: '✓',
  });
  for (let i = 1; i <= dynamic; i += 1) {
    rows.push({
      type: 'object',
      index: i + 1,
      lane: `A${i + 1}`,
      name: _iabTrackNameFromIndex(i),
      layout: '1.0',
      channels: 1,
      gain: '0.0',
      render: 'Object',
      qc: '✓',
    });
  }
  return rows;
}

function _ensureIabMixerStrip() {
  const main = $('imfIabMain');
  const summary = main?.querySelector?.('.imf-iab-summary-bar');
  if (!main || !summary) return null;
  let strip = $('imfIabMixerStrip');
  if (!strip) {
    summary.insertAdjacentHTML('afterend', `
      <div id="imfIabMixerStrip" class="imf-iab-mixer-strip" aria-label="IAB immersive mixer">
        <div class="imf-iab-meter-bank" id="imfIabMeterBank"></div>
        <div class="imf-iab-control-room">
          <div class="imf-iab-meter-title">Control Room</div>
          <div class="imf-iab-cr-value" id="imfIabCrValue">TP -100</div>
          <div class="imf-iab-mini-meter"><span></span></div>
        </div>
        <div class="imf-iab-loudness-mini">
          <div class="imf-iab-meter-title">Loudness</div>
          <div class="imf-iab-loud-row"><span>M</span><b>--</b></div>
          <div class="imf-iab-loud-row"><span>Short</span><b>--</b></div>
          <div class="imf-iab-loud-row"><span>Range</span><b>--</b></div>
        </div>
      </div>`);
    strip = $('imfIabMixerStrip');
  }
  return strip;
}

function _renderIabRightPanel(info = {}, tracks = []) {
  const set = (id, html) => { const e = $(id); if (e) e.innerHTML = html || '—'; };
  const layout = info.bedLayout || info.objectSummary?.bedLayout || tracks.find(t => t.type === 'bed')?.layout || '7.1.4';
  const ch = _iabLayoutChannels(layout);
  set('imfIabChanMap', ch.map(c => `<span class="imf-iab-ch-chip">${_esc(c)}</span>`).join(''));
  const objectCount = tracks.filter(t => t.type === 'object').length;
  const targets = ['2.0', '5.1', '7.1', objectCount >= 8 ? '7.1.4' : '7.1.2', 'Binaural'];
  set('imfIabRenderTargets', targets.map((t, i) =>
    `<div class="imf-iab-rt-item"><span class="imf-iab-rt-name">${_esc(t)}</span><span class="imf-iab-rt-layout">${i < 3 ? 'bed fold' : 'object render'}</span></div>`
  ).join(''));
  const programmes = info.programmeNames || [];
  const groups = info.contentNames || [];
  const objects = tracks.filter(t => t.type === 'object').slice(0, 18);
  set('imfIabAdmTree', `
    <div class="imf-iab-adm-node"><b>Programme</b> ${_esc(programmes[0] || _pkg?.cpl?.contentTitle || 'IAB Programme')}</div>
    <div class="imf-iab-adm-node"><b>Content</b> ${_esc(groups.join(' · ') || 'Main')}</div>
    <div class="imf-iab-adm-node"><b>Bed</b> ${_esc(layout)} · ${ch.map(_esc).join(' ')}</div>
    ${objects.map(o => `<div class="imf-iab-adm-node imf-iab-adm-leaf">${_esc(o.lane)} · ${_esc(o.name)}</div>`).join('')}
  `);
}

function _renderIabImmersive(info = {}, { empty = false } = {}) {
  _ensureIabMixerStrip();
  const body = $('imfIabTrackBody');
  if (!body) return [];
  if (empty) {
    body.dataset.loaded = '';
    body.innerHTML = `<div class="imf-iab-empty-state">
      <div class="imf-iab-empty-icon">🎧</div>
      <div class="imf-iab-empty-msg">No IAB / Dolby Atmos track in this package.<br>The immersive timeline appears when an IAB CPL is loaded.</div>
    </div>`;
    return [];
  }
  const tracks = _iabTracksFromInfo(info);
  const cpl = _pkg?.cpl || {};
  const clipName = String(info.assetLabel || info.programmeNames?.[0] || cpl.contentTitle || cpl.annotation || 'IAB_immersive.wav');
  const bank = $('imfIabMeterBank');
  if (bank) {
    bank.innerHTML = tracks.slice(0, 24).map((t, i) => `
      <div class="imf-iab-meter-channel ${t.type === 'bed' ? 'is-bed' : 'is-object'}">
        <span class="imf-iab-meter-fill" style="height:${18 + ((i * 13) % 72)}%"></span>
        <span class="imf-iab-meter-label">${i + 1}</span>
      </div>`).join('');
  }
  body.dataset.loaded = 'true';
  body.innerHTML = tracks.map((t, i) => `
    <div class="imf-iab-track-row imf-iab-track-row-${t.type}">
      <div class="imf-iab-track-index">
        <span class="imf-iab-visibility">◉</span>
        <span class="imf-iab-lane-id">${_esc(t.lane)}</span>
      </div>
      <div class="imf-iab-track-control">
        <span class="imf-iab-track-name">${_esc(t.name)}</span>
        <span class="imf-iab-track-meta">${_esc(t.layout)} · ${_esc(String(t.channels))} ch</span>
        <span class="imf-iab-mini-btn">R</span><span class="imf-iab-mini-btn">S</span><span class="imf-iab-mini-btn">M</span>
      </div>
      <div class="imf-iab-lane">
        <div class="imf-iab-clip ${t.type === 'bed' ? 'is-bed' : 'is-object'}" style="--lane-delay:${i % 5}">
          <span>${_esc(clipName)}</span>
        </div>
      </div>
    </div>`).join('');
  _renderIabRightPanel(info, tracks);
  return tracks;
}

function _renderIabCurrentSkeleton() {
  if (!_pkg?.cpl) {
    _renderIabImmersive({}, { empty: true });
    return;
  }
  if (_pkg.cpl.hasIAB === false || (!_pkg.cpl.iabResources?.length && _pkg.cpl.hasIAB == null)) {
    _renderIabNoImmersive();
    return;
  }
  const layout = _admTree?.is71 ? '7.1.4' : _admTree?.is51 ? '5.1' : '7.1.4';
  _renderIabImmersive({
    bedLayout: layout,
    objectSummary: { totalObjects: (_admTree?.objectCount || 32) + 1, bedObjects: 1, dynamicObjects: _admTree?.objectCount || 32 },
    programmeNames: _admTree?.programmes || [_pkg.cpl.contentTitle || _pkg.cpl.annotation || 'IAB Programme'],
    contentNames: ['Main'],
    frameRate: _pkg.cpl.editRate || '24',
    sampleRate: '48 kHz',
  });
}

function _renderIabMainTab(info) {
  const set = (id, v) => { const e = $(id); if (e) e.textContent = (v == null || v === '') ? '—' : v; };
  const obj = info.objectSummary || {};
  const stats = info.admStats || {};
  const total = obj.totalObjects || stats.audioObject || 0;
  const beds  = obj.bedObjects || (info.beds ? info.beds.length : 0) || 0;
  const dyn   = (obj.dynamicObjects != null) ? obj.dynamicObjects : Math.max(0, total - beds);
  const layout = info.bedLayout || obj.bedLayout || '';
  const dolby = (info.programmeNames || []).some(n => /atmos|dolby/i.test(n));

  set('imfIabSumProfile', total ? `${dolby ? 'Dolby Atmos' : 'IAB'} · ${dyn} obj + ${beds} bed` : '—');
  set('imfIabSumBeds', beds ? (layout ? `${beds} · ${layout}` : String(beds)) : '—');
  set('imfIabSumObjects', dyn || '—');
  set('imfIabSumGroups', (info.contentNames || []).join(', ') || '—');
  set('imfIabSumFR', info.frameRate || info.immersiveAudio?.frameRate || '—');
  set('imfIabSumSR', info.sampleRate || info.immersiveAudio?.sampleRate || '—');

  _renderIabImmersive(info);
  const ex = $('imfIabExportAdmBtn2'); if (ex) ex.style.display = '';
  const dc = $('imfIabDecodeBtn');     if (dc) dc.style.display = '';
}

// No IAB/immersive track — report the package's actual (PCM) audio so the tab is
// informative instead of blankly empty (e.g. SOSYALCLIM = 5.1 + 2.0 PCM).
function _renderIabNoImmersive() {
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v == null ? '—' : v; };
  // Summarise PCM audio from the CPL's audio resources, if available.
  const audio = (_pkg?.cpl?.audioResources || _pkg?.cpl?.audio || []);
  const layouts = [];
  for (const a of audio) {
    const ch = a.channels || a.channelCount || a.soundfieldChannels;
    if (ch) layouts.push(ch === 6 ? '5.1' : ch === 8 ? '7.1' : ch === 2 ? '2.0' : `${ch}ch`);
  }
  const pcmDesc = layouts.length ? `PCM · ${[...new Set(layouts)].join(' + ')}` : 'PCM (non-immersive)';
  set('imfIabSumProfile', 'No IAB / immersive audio');
  set('imfIabSumBeds', '—'); set('imfIabSumObjects', '—'); set('imfIabSumGroups', '—');
  set('imfIabSumFR', '—'); set('imfIabSumSR', '—');
  const body = $('imfIabTrackBody');
  if (body) body.innerHTML = `<div class="imf-iab-empty-state">`
    + `<div class="imf-iab-empty-icon">🔊</div>`
    + `<div class="imf-iab-empty-msg">No IAB / Dolby Atmos track in this package.<br>`
    + `Audio is <b>${_esc(pcmDesc)}</b> — the IAB tab only applies to immersive audio.</div></div>`;
}

function _renderIabInspectionResult(info, assetLabel = '') {
  const setText = (id, text) => { const e = $(id); if (e) e.textContent = text || '—'; };
  const showRow = (id) => {
    const e = $(id); if (!e) return;
    const row = e.closest?.('.imf-proxy-meta-row');
    if (row) row.style.removeProperty('display');
  };

  const obj    = info?.objectSummary || {};
  const counts = info?.counts || {};
  const stats  = info?.admStats || {};

  setText('imfIabPanelTrack', assetLabel);
  showRow('imfIabPanelTrack');

  const programmes = (info?.programmeNames || []).join(', ');
  if (programmes) { setText('imfIabPanelProgramme', programmes); showRow('imfIabPanelProgramme'); }
  setText('imfIabPanelOutput', programmes || assetLabel);

  const totalObj = obj.totalObjects || stats.audioObject || 0;
  const bedObj   = obj.bedObjects   || 0;
  const numObj   = obj.numberedObjects || 0;
  const namedObj = obj.namedObjects || 0;
  const objLine  = `${totalObj} total · ${bedObj} bed · ${numObj} numbered · ${namedObj} named`;
  setText('imfIabPanelObjects', objLine);
  showRow('imfIabPanelObjects');

  const groups = (info?.contentNames || []).join(', ');
  if (groups) { setText('imfIabPanelGroups', groups); showRow('imfIabPanelGroups'); }

  setText('imfIabPanelLabelQC', `${counts.pass || 0} pass · ${counts.warn || 0} warn · ${counts.reject || 0} reject`);
  showRow('imfIabPanelLabelQC');

  setText('imfIabPanelAdmStats', `prog:${stats.audioProgramme||0} · cont:${stats.audioContent||0} · obj:${stats.audioObject||0} · pack:${stats.audioPackFormat||0}`);
  showRow('imfIabPanelAdmStats');

  // Atmos profile inference (based on object / bed count)
  // Dolby Atmos Mobile ≤ 9 objects, Home ≤ ~127, Theatre up to 128+
  const atmosProfile = (() => {
    if (!totalObj) return null;
    // Infer IAB version from content type via programme/object count heuristic
    const dbyIMF   = (info?.programmeNames || []).some(n => /atmos|dolby/i.test(n));
    const profHint = dbyIMF ? 'Dolby Atmos · ' : 'IAB · ';
    if (totalObj <= 9)  return profHint + `Mobile (≤9 objects) · ${bedObj} bed + ${totalObj - bedObj} dyn`;
    if (totalObj <= 16) return profHint + `Home Theatre (${totalObj} objects) · ${bedObj} bed + ${totalObj - bedObj} dyn`;
    return profHint + `Cinema / Full (${totalObj} objects) · ${bedObj} bed + ${totalObj - bedObj} dyn`;
  })();
  if (atmosProfile) { setText('imfIabPanelProfile', atmosProfile); showRow('imfIabPanelProfile'); }

  // Named objects list (up to 8 displayed)
  const namedList = (info?.objectNames || obj.sampleNamedObjects || [])
    .filter(n => !/^object\s+\d+$/i.test(n) && !/defaultbed/i.test(n))
    .slice(0, 8);
  if (namedList.length) {
    setText('imfIabPanelNamedObjs', namedList.join(' · '));
    showRow('imfIabPanelNamedObjs');
  }

  // Render target inference from bed/object counts
  const renderTargets = (() => {
    if (!totalObj) return null;
    const targets = [];
    if (totalObj >= 1)  targets.push('2.0');
    if (bedObj >= 1 || totalObj >= 4)  targets.push('5.1');
    if (bedObj >= 1 || totalObj >= 8)  targets.push('7.1');
    if (totalObj >= 10) targets.push('7.1.2');
    if (totalObj >= 12) targets.push('9.1.OH');
    return targets.length ? targets.join(' · ') : null;
  })();
  if (renderTargets) { setText('imfIabPanelRenderTargets', renderTargets); showRow('imfIabPanelRenderTargets'); }

  // Store ADM XML on the export button for the click handler
  const exportBtn = $('imfIabExportAdmBtn');
  if (exportBtn) {
    exportBtn.style.display = '';
    exportBtn._admXml  = info?.xmlText || '';
    exportBtn._admName = assetLabel;
  }

  // Show decode+waveform button only when companion backend is available
  const decodeBtn = $('imfIabDecodeWaveformBtn');
  if (decodeBtn) decodeBtn.style.display = _imfSourceBackend === 'companion' ? '' : 'none';
}

// ── IAB companion decode + waveform ───────────────────────────────────────────

async function _runIabCompanionDecode() {
  const cpl = _pkg?.cpl;
  if (!cpl?.hasIAB || _imfSourceBackend !== 'companion' || !_imfSourcePackageId) return;
  const cplId = cpl.id;
  if (!cplId) return;

  const decodeBtn = $('imfIabDecodeWaveformBtn');
  if (decodeBtn) { decodeBtn.disabled = true; decodeBtn.textContent = 'Decoding…'; }

  _iabWaveformJob = { running: true, jobId: '', artifactPath: '', wavUrl: '', peaks: null, admInfo: null };
  _setIabDecodeState({ mode: 'running', pct: 0, status: 'Starting IAB PCM decode…', cpl: cpl.contentTitle || cpl.id || '—' });

  try {
    const result = await imfStartIabDecode(
      { backend: 'companion', packageId: _imfSourcePackageId },
      { cplId },
      {
        onProgress: pct => _setIabDecodeState({ pct }),
        onStatus:   msg  => _setIabDecodeState({ status: msg }),
      },
    );

    const artifactPath = result?.artifactPath || '';
    if (!artifactPath) throw new Error('No WAV artifact path in decode result');

    // Derive WAV URL from progressUrl port
    const progressUrl = String(result?.progressUrl || '');
    const portMatch   = progressUrl.match(/127\.0\.0\.1:(\d+)/);
    const port        = portMatch ? portMatch[1] : null;
    const wavUrl      = port ? `http://127.0.0.1:${port}/wav/${result.jobId}` : '';

    _setIabDecodeState({ mode: 'running', pct: 100, status: 'Extracting waveform peaks…' });

    const peaks = await imfExtractWaveformPeaks(artifactPath, { pointsPerSec: 100 });
    if (!peaks) throw new Error('Waveform peaks extraction returned no data');

    // Collect ADM info (already loaded from browser-side inspection)
    const admInfo = { objectNames: (peaks.channels > 6 ? [] : []) };

    _iabWaveformJob = { running: false, jobId: result.jobId, artifactPath, wavUrl, peaks, admInfo };
    _setIabDecodeState({ mode: 'done', pct: 100, status: `Waveform ready · ${peaks.channels} ch · ${peaks.duration?.toFixed(1) ?? '?'}s` });

    _renderIabWaveform(peaks, admInfo);

  } catch (err) {
    _iabWaveformJob = { ..._iabWaveformJob, running: false };
    _setIabDecodeState({ mode: 'error', pct: 0, status: String(err?.message || 'IAB decode failed') });
    if (decodeBtn) { decodeBtn.disabled = false; decodeBtn.textContent = '▶ Decode & Waveform'; }
    return;
  }

  if (decodeBtn) { decodeBtn.disabled = false; decodeBtn.textContent = '↺ Re-decode'; }
}

function _iabChannelLabels(admInfo, n) {
  const bed51 = ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'];
  const bed71 = ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Lss', 'Rss'];
  const labels = n <= 6 ? bed51.slice(0, n) : [...bed71.slice(0, Math.min(n, 8))];
  const objs = admInfo?.objectNames ?? [];
  for (let i = labels.length; i < n; i++) {
    labels.push(objs[i - labels.length] || `Obj ${i - labels.length + 1}`);
  }
  return labels;
}

function _renderIabWaveform(peaks, admInfo) {
  const section  = $('imfIabWaveformSection');
  const canvas   = $('imfIabWaveformCanvas');
  const labelEl  = $('imfIabWaveformLabel');
  if (!section || !canvas || !peaks?.peaks) return;

  const n        = peaks.channels;
  const rowH     = 36;
  const chLabels = _iabChannelLabels(admInfo, n);

  canvas.width  = canvas.parentElement?.clientWidth || 520;
  canvas.height = n * rowH;
  canvas.style.height = `${n * rowH}px`;

  const ctx = canvas.getContext('2d');
  const W   = canvas.width;

  peaks.peaks.forEach((ch, i) => {
    const [mins, maxs] = ch;
    const y0    = i * rowH + 2;
    const midY  = y0 + rowH / 2 - 2;
    const ampH  = rowH / 2 - 4;
    const pts   = mins.length;
    const xStep = W / Math.max(1, pts);

    ctx.fillStyle = '#0d0d1a';
    ctx.fillRect(0, y0, W, rowH - 3);

    // Centre line
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, midY, W, 1);

    // Waveform bars — beds blue, objects teal
    ctx.fillStyle = i < 8 ? '#3a7bd5' : '#3dd598';
    for (let x = 0; x < pts; x++) {
      const px  = Math.round(x * xStep);
      const pw  = Math.max(1, Math.round(xStep));
      const top = midY + Math.round(mins[x] * ampH);
      const bot = midY + Math.round(maxs[x] * ampH);
      ctx.fillRect(px, top, pw, Math.max(1, bot - top));
    }

    // Channel label overlay
    ctx.fillStyle = 'rgba(13,13,26,0.72)';
    ctx.fillRect(0, y0, 28, rowH - 3);
    ctx.fillStyle = i < 8 ? '#6aa4f0' : '#5ee8ac';
    ctx.font = 'bold 8px "SF Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(chLabels[i] ?? `ch${i + 1}`, 3, midY);
  });

  if (labelEl) labelEl.textContent = `${n} ch · ${peaks.duration?.toFixed(1) ?? '?'} s · ${peaks.sampleRate ? (peaks.sampleRate / 1000).toFixed(1) + ' kHz' : ''}`;
  section.style.display = '';
}

function _stopIabWaveformPlayback() {
  if (_iabWaveformAudioNode) {
    try { _iabWaveformAudioNode.stop(); } catch {}
    _iabWaveformAudioNode.disconnect();
    _iabWaveformAudioNode = null;
  }
  if (_iabWaveformAudioCtx) {
    _iabWaveformAudioCtx.close().catch(() => {});
    _iabWaveformAudioCtx = null;
  }
  const btn = $('imfIabWaveformPlayBtn');
  if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); }
}

async function _playIabWaveformPreview() {
  const btn = $('imfIabWaveformPlayBtn');
  if (_iabWaveformAudioNode) { _stopIabWaveformPlayback(); return; }

  const wavUrl = _iabWaveformJob.wavUrl;
  if (!wavUrl) return;
  if (btn) { btn.textContent = '…'; btn.disabled = true; }
  try {
    const resp = await fetch(wavUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf  = await resp.arrayBuffer();
    _iabWaveformAudioCtx  = new AudioContext();
    const audioBuf        = await _iabWaveformAudioCtx.decodeAudioData(buf);
    _iabWaveformAudioNode = _iabWaveformAudioCtx.createBufferSource();
    _iabWaveformAudioNode.buffer = audioBuf;
    _iabWaveformAudioNode.connect(_iabWaveformAudioCtx.destination);
    _iabWaveformAudioNode.onended = () => _stopIabWaveformPlayback();
    _iabWaveformAudioNode.start(0);
    if (btn) { btn.textContent = '■'; btn.disabled = false; btn.classList.add('playing'); }
  } catch (err) {
    _stopIabWaveformPlayback();
    if (btn) { btn.textContent = '▶'; btn.disabled = false; }
    console.warn('[IMF] IAB waveform playback failed', err);
  }
}

function _setProxyStatus(text) {
  const el = $('imfProxyStatus'); if (el) el.textContent = text;
  const panel = $('imfProxyPanelStatus'); if (panel) panel.textContent = text || '—';
}

function _setProxyPct(pct) {
  const safePct = Math.max(0, Math.min(100, pct));
  const bar = $('imfProxyBar');
  if (bar) bar.style.width = `${safePct}%`;
  const panelBar = $('imfProxyPanelBar');
  if (panelBar) panelBar.style.width = `${safePct}%`;
  const label = $('imfProxyPanelPct');
  if (label) label.textContent = `${Math.round(safePct)}%`;
}

function _setProxyTabState({ mode = 'idle', pct = 0, status = '', cpl = null, proxyPath = '', fingerprint = '' } = {}) {
  const stateEl = $('imfProxyPanelState');
  const badge = $('imfTabTranscodeBadge');
  const cplEl = $('imfProxyPanelCpl');
  if (stateEl) stateEl.textContent = mode === 'running' ? 'Running' : mode === 'done' ? 'Done' : mode === 'error' ? 'Error' : 'Idle';
  if (stateEl) stateEl.dataset.state = mode;
  if (cpl != null && cplEl) cplEl.textContent = cpl || '—';
  if (badge) {
    badge.style.display = mode === 'running' ? '' : 'none';
    badge.textContent = mode === 'running' ? `${Math.round(Math.max(0, Math.min(100, pct)))}%` : 'LIVE';
  }
  _setProxyPct(pct);
  if (status) _setProxyStatus(status);

  // Show Delete Proxy button only when proxy is done
  const delBtn = $('imfProxyDeleteBtn');
  if (delBtn) {
    const isDone = mode === 'done';
    delBtn.style.display = isDone ? '' : 'none';
    if (isDone) {
      delBtn.disabled = false;
      delBtn.textContent = '🗑 Delete Proxy';
      // Store path info if provided; otherwise keep existing
      if (proxyPath) _lastProxyInfo.proxyPath = proxyPath;
      if (fingerprint) _lastProxyInfo.fingerprint = fingerprint;
    }
  }
}

// ── Dolby Vision Metafier ──────────────────────────────────────────────────────

/**
 * Deterministic hue (0–360) from a UUID string, so the same UUID
 * always maps to the same timeline color across shots.
 */
function _uuidToHue(uuid) {
  if (!uuid) return 210;
  let h = 0;
  for (let i = 0; i < uuid.length; i++) h = (Math.imul(31, h) + uuid.charCodeAt(i)) | 0;
  return ((h >>> 0) % 360);
}

/**
 * Deterministic 6-digit hex color from a UUID/trackFileId string.
 * Returns a hex so callers can safely append 2-digit alpha suffixes (e.g. `color + 'dd'`).
 */
function _uuidToHex(uuid, sat = 62, lit = 52) {
  const h = _uuidToHue(uuid);
  const s = sat / 100, l = lit / 100;
  const a = s * Math.min(l, 1 - l);
  const ch = n => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)))
      .toString(16).padStart(2, '0');
  };
  return `#${ch(0)}${ch(8)}${ch(4)}`;
}

/** CSS color token for a shot's timeline segment based on its UUID. */
function _shotTimelineColor(shot) {
  if (shot.transitionType === 'black') return null;   // use CSS class, not inline color
  return _uuidToHex(shot.uuid, shot.isTransition ? 30 : 65, shot.isTransition ? 28 : 42);
}

function _clearDoviMetafier() {
  _doviMetafierShots  = null;
  _dvMxfConfirmed     = false;
  _doviActiveShot     = -1;
  _doviExtractResult  = null;
  _doviExtractPending = false;
  try { playerSetDoviShots([]); } catch {}
  const panel = $('imfDoviMetafierPanel');
  if (panel) panel.style.display = 'none';
  const setText = (id) => { const e = $(`imfDovi${id}`); if (e) e.textContent = '—'; };
  setText('ShotCount'); setText('Canvas'); setText('Validation');
  const sl  = $('imfDoviShotList');   if (sl)  sl.innerHTML = '';
  const wn  = $('imfDoviWarnings');   if (wn)  { wn.innerHTML = ''; wn.style.display = 'none'; }
  const det = $('imfDoviShotDetail'); if (det) { det.innerHTML = ''; det.style.display = 'none'; }
  const nav = $('imfDoviNavRow');     if (nav) nav.style.display = 'none';
  const ex   = $('imfDoviExportBtn');        if (ex)  ex.style.display  = 'none';
  const exH  = $('imfDoviExportHeaderBtn'); if (exH) exH.style.display = 'none';
  const rs  = $('imfDoviRescanBtn');       if (rs)  rs.style.display  = 'none';
  const st  = $('imfDoviMetafierState'); if (st) st.textContent = 'No metadata';
  // Hide optional meta rows
  ['imfDoviXmlSource', 'imfDoviVersion'].forEach(id => {
    const e = $(id); if (!e) return;
    const row = e.closest?.('.imf-proxy-meta-row');
    if (row) row.style.display = 'none';
  });
  const lvlRow = $('imfDoviLevelRow');    if (lvlRow) lvlRow.style.display = 'none';
  const cvRow  = $('imfDoviCanvasRow');   if (cvRow)  cvRow.style.display  = 'none';
  const cvList = $('imfDoviCanvasList');  if (cvList) cvList.innerHTML = '';
  _refreshDoviShotsTimeline();
}

// ── DoVi extraction debug panel ──────────────────────────────────────────────

const _DOVI_METAFIER_KEY = 'pfx_dovi_metafier_path';

function _loadMetafierPath() {
  try { return localStorage.getItem(_DOVI_METAFIER_KEY) || ''; } catch { return ''; }
}
function _saveMetafierPath(p) {
  try { localStorage.setItem(_DOVI_METAFIER_KEY, String(p || '')); } catch {}
}

function _updateDoviExtractPanel() {
  const extractPanel = $('imfDoviExtractPanel');
  const cfgPanel     = $('imfDoviMetafierConfig');
  const res = _doviExtractResult;
  if (!res) {
    if (extractPanel) extractPanel.style.display = 'none';
    return;
  }
  if (extractPanel) extractPanel.style.display = '';

  // Source row
  const sourceEl = $('imfDoviExtractSource');
  if (sourceEl) {
    const srcLabels = { xml_sidecar: 'XML sidecar', embedded_video_mxf: 'Embedded Video MXF',
      cpl_descriptor: 'CPL EssenceDescriptor', companion_api: 'Companion API', none: '—' };
    sourceEl.textContent = srcLabels[res.sourceType] || res.sourceType || '—';
  }

  // Extractor row
  const toolEl = $('imfDoviExtractTool');
  if (toolEl) {
    const sev = { found: '✓ ', confirmed_no_data: '⚠ ', extractor_required: '⚠ ',
      not_found: '✗ ', extract_failed: '✗ ', parse_failed: '✗ ', scanning: '⟳ ' };
    toolEl.textContent = (sev[res.status] || '') + (res.detectedBy || doviStatusLabel(res) || '—');
  }

  // Levels row
  const levelsEl = $('imfDoviExtractLevels');
  if (levelsEl && res.shots?.length) {
    const l1c = res.shots.filter(s => s.l1).length;
    const l8c = res.shots.filter(s => (Array.isArray(s.l8) ? s.l8.length : (s.l8 ? 1 : 0)) || (s.trimPasses?.length ?? 0)).length;
    levelsEl.textContent = `L1: ${l1c} shots · L8: ${l8c} shots`;
  } else if (levelsEl) {
    levelsEl.textContent = res.shots?.length ? '—' : 'No shots';
  }

  // Cuts row
  const cutsEl = $('imfDoviExtractCuts');
  if (cutsEl) {
    const cuts = res.shots?.filter(s => s.isCut).length ?? 0;
    cutsEl.textContent = res.shots?.length ? `${cuts} cut${cuts !== 1 ? 's' : ''}` : '—';
  }

  // Debug log (warnings + errors from extractor)
  const logEl = $('imfDoviDebugLog');
  if (logEl) {
    const lines = [
      ...((res.warnings || []).map(w => `⚠ ${w}`)),
      ...((res.errors   || []).map(e => `✗ ${e}`)),
    ];
    if (res.detectedBy) lines.unshift(`✓ Detected via: ${res.detectedBy}`);
    if (res.sourcePath) lines.push(`→ ${res.sourcePath}`);
    logEl.textContent = lines.length ? lines.join('\n') : 'No warnings or errors.';
  }

  // Show Metafier config when extractor is required
  if (cfgPanel) {
    const needsCfg = res.status === DOVI_STATUS.EXTRACTOR_REQUIRED ||
                     res.status === DOVI_STATUS.CONFIRMED_NO_DATA;
    cfgPanel.style.display = needsCfg ? '' : 'none';
    if (needsCfg) {
      const inp = $('imfDoviMetafierPathInput');
      if (inp && !inp.value) inp.value = _loadMetafierPath();
    }
  }
}

function _wireDoviMetafierConfig() {
  const inp     = $('imfDoviMetafierPathInput');
  const testBtn = $('imfDoviMetafierTestBtn');
  const result  = $('imfDoviMetafierTestResult');
  if (!testBtn) return;

  // Pre-fill from storage
  if (inp) inp.value = _loadMetafierPath();

  testBtn.addEventListener('click', async () => {
    const path = inp?.value?.trim() || '';
    if (path) _saveMetafierPath(path);
    testBtn.disabled = true;
    if (result) { result.textContent = 'Testing…'; result.style.color = ''; }
    try {
      const info = await imfDetectMetafier(path || undefined).catch(() => ({ found: false }));
      if (result) {
        if (info?.found) {
          result.textContent = `✓ Found: ${info.version || 'version unknown'}`;
          result.style.color = '#4caf80';
          if (inp && !path) inp.value = info.path;
          _saveMetafierPath(info.path || path);
        } else {
          result.textContent = '✗ Metafier not found at this path';
          result.style.color = '#f55';
        }
      }
    } catch (e) {
      if (result) { result.textContent = `✗ ${e?.message}`; result.style.color = '#f55'; }
    } finally {
      testBtn.disabled = false;
    }
  });
}

// ── Waveform strip functions ──────────────────────────────────────────────────

function _audioModeLabel(mode) {
  const map = {
    stereo_2_0:   'Stereo 2.0',
    surround_5_1: 'Surround 5.1',
    surround_7_1: 'Surround 7.1',
    stereo_51:    '5.1 + 2.0',
    stereo_71:    '7.1 + 2.0',
    iab_5_1:      'Atmos → 5.1',
    iab_stereo:   'Atmos → 2.0',
    iab_direct:   'Atmos (direct)',
    stereo_proxy: 'Stereo',
    video_only:   'Video Only',
    resolve_dv:   'Dolby Vision (Resolve)',
    resolve_iab:  'Atmos via Resolve',
  };
  return map[mode] || mode || '—';
}

function _audioModeChipLabels(mode) {
  if (mode === 'stereo_71')    return ['7.1', '2.0'];
  if (mode === 'stereo_51')    return ['5.1', '2.0'];
  if (mode === 'surround_7_1') return ['7.1'];
  if (mode === 'iab_5_1')      return ['Atmos 5.1'];
  if (mode === 'surround_5_1') return ['5.1'];
  if (mode === 'stereo_2_0' || mode === 'stereo_proxy') return ['2.0'];
  if (mode === 'iab_stereo' || mode === 'iab_direct') return ['Atmos 2.0'];
  return [];
}

function _renderAudioTrackChips(audioMode) {
  const sel = $('imfWaveformTrackSel');
  if (!sel) return;
  sel.innerHTML = '';
  const chips = _audioModeChipLabels(audioMode);
  chips.forEach((label, i) => {
    const btn = document.createElement('button');
    btn.className = `imf-wf-chip${i === 0 ? ' imf-wf-chip-active' : ''}`;
    btn.textContent = label;
    btn.title = `Switch to track ${i + 1}: ${label}`;
    btn.addEventListener('click', () => {
      sel.querySelectorAll('.imf-wf-chip').forEach((c, ci) => {
        c.classList.toggle('imf-wf-chip-active', ci === i);
      });
      // Switch audio track via HTMLVideoElement.audioTracks API (Chrome)
      const videoEl = $('imfProxyVideo');
      if (videoEl?.audioTracks?.length) {
        for (let t = 0; t < videoEl.audioTracks.length; t++) {
          videoEl.audioTracks[t].enabled = (t === i);
        }
      }
    });
    sel.appendChild(btn);
  });
}

function _attachWaveform(videoEl, audioMode) {
  if (_wfAudioMode === audioMode && _audioCtx) return;  // already attached for this mode
  const tryInit = () => {
    _initWaveform(videoEl);
    // Set mode after init so _teardownWaveform (called inside _initWaveform) doesn't
    // reset it back to '' before we return, which would defeat the guard on the next call.
    if (_audioCtx) _wfAudioMode = audioMode;
    _renderAudioTrackChips(audioMode);
  };
  // If video already has data, init immediately; else wait for canplay
  if (videoEl.readyState >= 2) {
    tryInit();
  } else {
    videoEl.addEventListener('canplay', tryInit, { once: true });
    // Also try after a short delay as fallback (canplay can be unreliable)
    setTimeout(() => {
      if (!_audioCtx && videoEl.readyState >= 1) tryInit();
    }, 800);
  }
}

function _initWaveform(videoEl) {
  _teardownWaveform();
  if (!videoEl) return;
  try {
    _audioCtx = new AudioContext();
    // Chrome suspends AudioContext created without a user gesture; resume it.
    // If the resume promise rejects (e.g., policy), the analyser still
    // receives data once the user interacts with the player.
    _audioCtx.resume().catch(() => {});
    const src = _audioCtx.createMediaElementSource(videoEl);
    _analyser = _audioCtx.createAnalyser();
    _analyser.fftSize = 2048;
    src.connect(_analyser);
    _analyser.connect(_audioCtx.destination);
    // Also resume when the video element starts playing (user-gesture context).
    // Store the handler reference so _teardownWaveform can remove it — without this,
    // every _initWaveform call on a mode switch accumulates a new 'play' listener.
    _wfPlayHandler = () => { if (_audioCtx?.state === 'suspended') _audioCtx.resume().catch(() => {}); };
    videoEl.addEventListener('play', _wfPlayHandler, { once: false });
    _wfVideoEl = videoEl; // remember which element owns the listener
    const wrap = $('imfWaveformWrap');
    if (wrap) wrap.style.display = 'flex';
    _drawWaveformLoop();
  } catch (e) {
    console.warn('[IMF] Waveform init failed:', e);
    _teardownWaveform();
  }
}

function _drawWaveformLoop() {
  const canvas = $('imfWaveformStrip');
  if (!canvas || !_analyser) return;
  const dpr = window.devicePixelRatio || 1;
  const buf = new Uint8Array(_analyser.frequencyBinCount);

  const draw = () => {
    _wfAnimId = requestAnimationFrame(draw);
    if (!_analyser) return;
    _analyser.getByteTimeDomainData(buf);

    const rect = canvas.getBoundingClientRect();
    const W = rect.width  * dpr;
    const H = rect.height * dpr;
    if (!W || !H) return;  // element not laid out yet; wait for next frame
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width  = W;
      canvas.height = H;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#09090f';
    ctx.fillRect(0, 0, W, H);

    // Center baseline
    ctx.strokeStyle = 'rgba(255,255,255,.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.stroke();

    // Waveform — getByteTimeDomainData: 128=silence, 0=neg peak, 255=pos peak
    // Map so positive peaks → top (y→0) and negative peaks → bottom (y→H).
    ctx.strokeStyle = '#7c6af7';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const sliceW = W / buf.length;
    let x = 0;
    for (let i = 0; i < buf.length; i++) {
      const y = H / 2 - ((buf[i] - 128) / 128.0) * (H / 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      x += sliceW;
    }
    ctx.stroke();
  };
  draw();
}

function _teardownWaveform() {
  if (_wfAnimId) { cancelAnimationFrame(_wfAnimId); _wfAnimId = null; }
  if (_wfPlayHandler && _wfVideoEl) {
    try { _wfVideoEl.removeEventListener('play', _wfPlayHandler); } catch {}
    _wfPlayHandler = null;
    _wfVideoEl = null;
  }
  if (_audioCtx) { try { _audioCtx.close(); } catch {} _audioCtx = null; }
  _analyser = null;
  _wfAudioMode = '';
  const wrap = $('imfWaveformWrap');
  if (wrap) wrap.style.display = 'none';
  const sel = $('imfWaveformTrackSel');
  if (sel) sel.innerHTML = '';
}

/**
 * Rebuild the DV CUTS timeline row and refresh per-shot overlays on the TRIM row.
 * Called both from renderTimeline() and from _renderDoviMetafier() (async load).
 */
/**
 * Rebuild the DV META and TRIM timeline rows.
 * Safe to call any time — reads from _pkg.cpl and _doviMetafierShots.
 * Called from renderTimeline() and again from _renderDoviMetafier() once
 * Metafier shots arrive asynchronously.
 */

// ── Validation strip row ──────────────────────────────────────────────────────
// Shows per-reel pass/warn/fail status mapped from _valResults.
// Each video reel gets a colored segment: green=pass, amber=warn, red=fail.
function _renderValidationRow(cpl, totalFrames) {
  const row = document.getElementById('imfTLValidation');
  if (!row || !cpl || !_valResults.length) {
    if (row) row.style.display = 'none';
    return;
  }

  // Build a Set of UUIDs that have FAIL or WARN results.
  // PKL002/PKL003 results include the UUID in detail: "UUID: <id>"
  const failUUIDs = new Set();
  const warnUUIDs = new Set();
  const hasGlobalFail = _valResults.some(r => r.sev === 'fail' &&
    !['PKL002','PKL003'].includes(r.code));
  const hasGlobalWarn = _valResults.some(r => r.sev === 'warn' &&
    !['PKL002','PKL003'].includes(r.code));

  for (const r of _valResults) {
    if (r.code === 'PKL002' || r.code === 'PKL003') {
      // detail format: "UUID: <uuid>" or just a filename — also check msg
      const uuidMatch = (r.detail || r.msg || '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      if (uuidMatch) {
        const uuid = uuidMatch[1].toLowerCase();
        if (r.sev === 'fail') failUUIDs.add(uuid);
        else if (r.sev === 'warn') warnUUIDs.add(uuid);
      }
    }
  }

  row.innerHTML = '';
  row.style.display = '';
  row.classList.add('imf-tl-row-validation');

  const label = el('div', 'imf-tl-label imf-tl-label-val', 'VAL');
  const track = el('div', 'imf-tl-track imf-tl-track-validation');

  const fps = cpl.editRate || 24;
  let frameOffset = 0;

  for (let i = 0; i < cpl.videoResources.length; i++) {
    const res = cpl.videoResources[i];
    const pct     = (res.sourceDuration / Math.max(1, totalFrames) * 100).toFixed(4);
    const leftPct = (frameOffset / Math.max(1, totalFrames) * 100).toFixed(4);
    const uuid    = (res.trackFileId || '').toLowerCase();

    let sevCls = 'imf-tl-seg-val-pass';
    let sevLabel = 'PASS';
    if (failUUIDs.has(uuid) || hasGlobalFail) {
      sevCls = 'imf-tl-seg-val-fail'; sevLabel = 'FAIL';
    } else if (warnUUIDs.has(uuid) || hasGlobalWarn) {
      sevCls = 'imf-tl-seg-val-warn'; sevLabel = 'WARN';
    }

    const seg = el('div', `imf-tl-seg ${sevCls}`);
    seg.style.left  = leftPct + '%';
    seg.style.width = pct + '%';
    const tcIn  = fmtDuration(frameOffset / fps);
    const tcOut = fmtDuration((frameOffset + res.sourceDuration) / fps);
    seg.title = `Reel ${i + 1}  ·  ${sevLabel}\n${tcIn} → ${tcOut}`;
    seg.addEventListener('click', () => {
      switchLeftTab('validation');
    });
    track.appendChild(seg);
    frameOffset += res.sourceDuration;
  }

  row.appendChild(label);
  row.appendChild(track);
}

function _refreshDoviMetaRows() {
  const cpl = _pkg?.cpl;
  if (!cpl) return;
  const totalFrames = cpl.totalFrames || 1;
  // DV present if: (a) this CPL's descriptor has DV, (b) ANY CPL in the package has DV,
  // (c) Metafier shots loaded, or (d) MXF header confirmed DV via ffprobe
  const pkgHasDV  = _cplEntries?.some(e => e.cpl?.isDolbyVision) ||
                    _imfPackages?.some(p => p.hasDolbyVision);
  const hasDvData = cpl.isDolbyVision || pkgHasDV || !!_doviMetafierShots?.length || _dvMxfConfirmed;

  // Sync DV toggle chips (update chip accent but do NOT hide rows based on data detection)
  _updateDvToggleVisibility(hasDvData);

  // ── DV META row — always render when toggle is on; show absent state when no data ──
  const tlDV = $('imfTLDV');
  if (tlDV) {
    tlDV.innerHTML = '';
    // Rows render whenever toggle is enabled — empty state shown when no data
    tlDV.style.display = _tlRowEnabled.dv ? '' : 'none';
    {
      const dvProf  = cpl.dvProfile ? ` P${cpl.dvProfile}` : '';
      const dvLev   = cpl.dvLevel   ? ` L${cpl.dvLevel}`   : '';
      const dvLabel = el('div', 'imf-tl-label imf-tl-label-dv', `DV<span class="imf-tl-dv-badge">${dvProf}${dvLev}</span>`);
      const dvTrack = el('div', 'imf-tl-track');
      let dvOff = 0;

      if (!hasDvData) {
        // Empty-state: one absent block per reel + dim text
        cpl.videoResources.forEach((res, i) => {
          const seg = el('div', 'imf-tl-seg imf-tl-seg-dv-absent');
          seg.style.left  = (dvOff / totalFrames * 100).toFixed(4) + '%';
          seg.style.width = (res.sourceDuration / totalFrames * 100).toFixed(4) + '%';
          seg.title = `Reel ${i+1} — No DV data`;
          dvTrack.appendChild(seg);
          dvOff += res.sourceDuration;
        });
        // Show status-aware message instead of generic "No DV data"
        const _dvMsg = _doviExtractResult
          ? doviStatusLabel(_doviExtractResult)
          : (_doviExtractPending ? 'Scanning for Dolby Vision metadata…' : 'No DV data');
        const emptyNote = el('div', 'imf-tl-empty-note', _dvMsg);
        if (_doviExtractResult?.status === DOVI_STATUS.EXTRACTOR_REQUIRED) {
          emptyNote.style.color = 'rgba(245,160,40,.65)';
        } else if (_doviExtractResult?.status === DOVI_STATUS.EXTRACT_FAILED) {
          emptyNote.style.color = 'rgba(229,90,90,.65)';
        }
        dvTrack.appendChild(emptyNote);
      } else {
      cpl.videoResources.forEach((res, i) => {
        const pct     = (res.sourceDuration / totalFrames * 100).toFixed(4);
        const leftPct = (dvOff / totalFrames * 100).toFixed(4);
        const hasDV   = (cpl.dvDescriptorIds?.has(res.essenceDescriptorId) ?? cpl.isDolbyVision)
                        || !!_doviMetafierShots?.length;
        const seg = el('div', hasDV ? 'imf-tl-seg imf-tl-seg-dv' : 'imf-tl-seg imf-tl-seg-dv-absent');
        seg.style.left  = leftPct + '%';
        seg.style.width = pct + '%';
        const dvDesc    = cpl.descriptors?.find(d => d.id === res.essenceDescriptorId);
        const profileStr = dvDesc?.dvProfile ? `Profile ${dvDesc.dvProfile}` : (cpl.dvProfile ? `Profile ${cpl.dvProfile}` : 'Profile –');
        const levelStr   = dvDesc?.dvLevel   ? `Level ${dvDesc.dvLevel}`     : (cpl.dvLevel   ? `Level ${cpl.dvLevel}`   : 'Level –');
        seg.title = [`Reel ${i+1} — Dolby Vision`, hasDV ? `${profileStr}  ·  ${levelStr}` : 'No DV descriptor', `Frames: ${res.sourceDuration.toLocaleString()}`].join('\n');
        dvTrack.appendChild(seg);
        dvOff += res.sourceDuration;
      });
      // ── Clipster-style L1 luminance waveform ────────────────────────────────
      // Each shot is a bottom-anchored bar whose height = l1.maxNits / masteringPeak.
      // Color maps from cool blue (dark shots) → warm amber (peak shots).
      if (_doviMetafierShots?.length) {
        const { conflicts } = buildUuidColorMap(_doviMetafierShots);
        const conflictUuids = new Set(conflicts.map(c => c.uuid));
        const _metaL6ForDv = _doviMetafierShots.find(s => s.l6?.maxMasteringLuminance);
        const masteringPeak = _metaL6ForDv?.l6?.maxMasteringLuminance ||
          Math.max(1, ..._doviMetafierShots.map(s => s.l1?.maxNits || 0)) || 1000;
        // Shot boundary separators (thin vertical marks)
        for (let si = 1; si < _doviMetafierShots.length; si++) {
          const shot = _doviMetafierShots[si];
          const cutDiv = el('div', 'imf-tl-dv-shot-sep');
          cutDiv.style.left = (shot.begin / totalFrames * 100).toFixed(4) + '%';
          dvTrack.appendChild(cutDiv);
        }
        for (const shot of _doviMetafierShots) {
          const lp  = (shot.begin / totalFrames * 100).toFixed(4);
          const wp  = Math.max(0.08, ((shot.end - shot.begin + 1) / totalFrames * 100)).toFixed(4);
          const bad = shot.uuid && conflictUuids.has(shot.uuid);
          const maxNits  = shot.l1?.maxNits  ?? 0;
          const midNits  = shot.l1?.midNits  ?? 0;
          const isBlack  = shot.transitionType === 'black';
          const isFade   = shot.transitionType === 'fade' || shot.transitionType === 'dissolve';
          // Bar height: L1 MaxNits relative to mastering peak (min 4% so black frames are visible)
          const heightPct = isBlack ? 4 : Math.max(4, Math.min(100, (maxNits / masteringPeak) * 100));
          const midRatio  = Math.min(1, midNits / masteringPeak);
          // Hue: 215° (blue) → 40° (amber) as nits increase
          const hue   = Math.round(215 - (heightPct / 100) * 175);
          const sat   = isBlack ? 0 : Math.round(35 + (heightPct / 100) * 55);
          const light = isBlack ? 8 : Math.round(18 + (heightPct / 100) * 38);
          const bar = el('div', `imf-tl-dv-l1-bar${bad ? ' imf-tl-dv-l1-bar-conflict' : ''}${isFade ? ' imf-tl-dv-l1-bar-fade' : ''}`);
          bar.style.left   = lp + '%';
          bar.style.width  = wp + '%';
          bar.style.height = heightPct + '%';
          bar.style.background = isBlack
            ? 'rgba(20,20,30,.7)'
            : `linear-gradient(180deg, hsl(${hue},${sat}%,${Math.min(light+12,55)}%) 0%, hsl(${hue},${sat}%,${light}%) 100%)`;
          if (bad) bar.style.outline = '1px solid rgba(255,60,60,.8)';
          bar.dataset.shotIndex = shot.index;
          const nitsStr = maxNits > 0 ? `L1 max: ${Math.round(maxNits)} nit · avg: ${Math.round(midNits)} nit` : 'Black/fade';
          bar.title = [
            `Shot ${shot.index+1}  fr ${shot.begin}–${shot.end}`,
            `Duration: ${shot.durationFrames} fr`,
            nitsStr,
            shot.transitionType ? `Type: ${shot.transitionType}` : '',
            bad ? '⚠ UUID mismatch' : '',
          ].filter(Boolean).join('\n');
          bar.addEventListener('click', e => { e.stopPropagation(); _selectDoviShot(shot.index); });
          dvTrack.appendChild(bar);
        }
      }  // closes if (_doviMetafierShots?.length)
      }  // closes else (hasDvData)
      tlDV.appendChild(dvLabel);
      tlDV.appendChild(dvTrack);
    } // end outer block
  }

  // ── TRIM row ───────────────────────────────────────────────────────────────
  const hasTrims = cpl.isDolbyVision || _dvMxfConfirmed ||
    _doviMetafierShots?.some(s => (s.l8 && (Array.isArray(s.l8) ? s.l8.length : 1)) || s.trimPasses?.length);
  const tlTrim = $('imfTLTrim');
  if (tlTrim) {
    tlTrim.innerHTML = '';
    // Always visible when toggle on — show empty state when no trim data
    tlTrim.style.display = _tlRowEnabled.trim ? '' : 'none';
    {
      const trimCount = cpl.dvTrimPasses || 0;
      const trimLabel = el('div', 'imf-tl-label imf-tl-label-trim', trimCount > 0 ? `TRIM ${trimCount}` : 'TRIM');
      const trimTrack = el('div', 'imf-tl-track');
      if (!hasTrims) {
        let tOff2 = 0;
        cpl.videoResources.forEach((res, i) => {
          const seg = el('div', 'imf-tl-seg imf-tl-seg-trim-absent');
          seg.style.left  = (tOff2 / totalFrames * 100).toFixed(4) + '%';
          seg.style.width = (res.sourceDuration / totalFrames * 100).toFixed(4) + '%';
          seg.title = `Reel ${i+1} — No trim metadata`;
          trimTrack.appendChild(seg);
          tOff2 += res.sourceDuration;
        });
        const _trimMsg = _doviExtractResult?.status === DOVI_STATUS.EXTRACTOR_REQUIRED
          ? 'Extractor required for per-shot trim data'
          : _doviExtractResult?.status === DOVI_STATUS.CONFIRMED_NO_DATA
            ? 'DV confirmed — no CM XML trim data'
            : 'No trim metadata';
        trimTrack.appendChild(el('div', 'imf-tl-empty-note', _trimMsg));
      } else {
      let tOff = 0;
      cpl.videoResources.forEach((res, i) => {
        const pct = (res.sourceDuration / totalFrames * 100).toFixed(4);
        const lp  = (tOff / totalFrames * 100).toFixed(4);
        const dvd = cpl.descriptors?.find(d => d.id === res.essenceDescriptorId);
        const tp  = dvd?.dvTrimPasses ?? (trimCount > 0 ? trimCount : 0);
        const ht  = tp > 0 || !!_doviMetafierShots?.length;
        const seg = el('div', ht ? 'imf-tl-seg imf-tl-seg-trim' : 'imf-tl-seg imf-tl-seg-trim-absent');
        seg.style.left  = lp + '%';
        seg.style.width = pct + '%';
        seg.title = [`Reel ${i+1} — DV Trim`, ht ? `${tp} trim pass${tp!==1?'es':''}` : 'No trim passes', `Frames: ${res.sourceDuration.toLocaleString()}`].join('\n');
        trimTrack.appendChild(seg);
        tOff += res.sourceDuration;
      });
      // ── Clipster-style per-shot grade deviation bars ─────────────────────────
      // Each shot's SDR trim deviation from neutral is shown as a fill intensity:
      // neutral trim (gain=1, lift=0, sat=1) → transparent; heavy trim → opaque teal/amber.
      if (_doviMetafierShots?.length) {
        for (const shot of _doviMetafierShots) {
          const trim = pickSdrTrim(shot);
          const l8s  = Array.isArray(shot.l8) ? shot.l8 : (shot.l8 ? [shot.l8] : []);
          const tc   = l8s.length + (shot.trimPasses?.length ?? 0);
          const nv   = shot.l1?.maxNits != null ? Math.round(shot.l1.maxNits) : null;
          if (!tc && !trim) continue;
          // Compute deviation from neutral: 0 = neutral, 1 = max adjustment
          const gainDev = trim ? Math.abs((trim.gain || 1) - 1) : 0;
          const liftDev = trim ? Math.abs(trim.lift || 0) * 2 : 0;
          const satDev  = trim ? Math.abs((trim.sat  || 1) - 1) : 0;
          const gamDev  = trim ? Math.abs((trim.gamma|| 1) - 1) * 0.5 : 0;
          const totalDev = Math.min(1, gainDev + liftDev + satDev + gamDev);
          const hasTrim27 = trim?.targetIndex === 27;
          const seg = el('div', `imf-tl-shot-trim-overlay${hasTrim27 ? ' imf-tl-trim-t27' : ''}`);
          seg.style.left  = (shot.begin / totalFrames * 100).toFixed(4) + '%';
          seg.style.width = Math.max(0.08, ((shot.end - shot.begin + 1) / totalFrames * 100)).toFixed(4) + '%';
          // Color: teal for trim present + neutral, amber for heavy deviation
          const devHue = Math.round(160 - totalDev * 120); // 160 teal → 40 amber
          const devAlpha = tc > 0 ? Math.max(0.18, Math.min(0.85, 0.25 + totalDev * 0.6)) : 0.12;
          seg.style.background = `hsla(${devHue},70%,42%,${devAlpha.toFixed(2)})`;
          seg.style.borderTop = hasTrim27 ? '1px solid rgba(255,220,80,.5)' : '';
          const l8d = l8s.map(x => x.targetDisplayIndex != null ? `T${x.targetDisplayIndex}` : 'T?').join(' ');
          const trimStr = trim ? `Gain ${(trim.gain||1).toFixed(2)} · Lift ${(trim.lift||0).toFixed(3)} · Sat ${(trim.sat||1).toFixed(2)}` : 'No SDR trim';
          seg.title = [
            `Shot ${shot.index+1}  fr ${shot.begin}–${shot.end}`,
            tc > 0 ? `${tc} trim pass${tc!==1?'es':''} ${l8d}` : 'No trim passes',
            trimStr,
            nv != null ? `L1 max: ${nv} nit` : '',
          ].filter(Boolean).join('\n');
          seg.addEventListener('click', e => { e.stopPropagation(); _selectDoviShot(shot.index); });
          trimTrack.appendChild(seg);
        }
      }  // closes if (_doviMetafierShots?.length)

      // ── Grade-change cut markers — scaled by severity ────────────────────────
      if (_doviMetafierShots?.length > 1) {
        // Compact delta label: "G+8%" / "S−12%" / "L+0.05" — shows the biggest change
        const _shortDelta = (trim, prev) => {
          if (!trim || !prev) return '';
          const candidates = [
            { key: 'G', v: ((trim.gain||1) - (prev.gain||1)), pct: true },
            { key: 'S', v: ((trim.sat||1)  - (prev.sat||1)),  pct: true },
            { key: 'L', v: (trim.lift||0)  - (prev.lift||0),  pct: false },
            { key: 'γ', v: ((trim.gamma||1) - (prev.gamma||1)), pct: true },
          ].filter(c => Math.abs(c.v) > 0.005);
          if (!candidates.length) return '';
          const top = candidates.reduce((a, b) => Math.abs(a.v) >= Math.abs(b.v) ? a : b);
          const sign = top.v >= 0 ? '+' : '−';
          const val = top.pct
            ? `${Math.abs(top.v * 100).toFixed(0)}%`
            : Math.abs(top.v).toFixed(2);
          return `${top.key}${sign}${val}`;
        };

        let prevTrimKey = null;
        let prevTrim = null;
        for (let si = 0; si < _doviMetafierShots.length; si++) {
          const shot = _doviMetafierShots[si];
          const trim = pickSdrTrim(shot);
          const key = trim
            ? `${(trim.gain||1).toFixed(3)}|${(trim.lift||0).toFixed(3)}|${(trim.gamma||1).toFixed(3)}|${(trim.sat||1).toFixed(3)}`
            : null;
          if (si > 0 && key !== prevTrimKey && shot.begin > 0) {
            const gainΔ = trim && prevTrim ? Math.abs((trim.gain||1)  - (prevTrim.gain||1))       : 0;
            const liftΔ = trim && prevTrim ? Math.abs((trim.lift||0)  - (prevTrim.lift||0))  * 2  : 0;
            const satΔ  = trim && prevTrim ? Math.abs((trim.sat||1)   - (prevTrim.sat||1))        : 0;
            const gamΔ  = trim && prevTrim ? Math.abs((trim.gamma||1) - (prevTrim.gamma||1)) * 0.5: 0;
            const severity = Math.min(1, gainΔ + liftΔ + satΔ + gamΔ);
            // Three severity tiers
            const sev = severity < 0.12 ? 'subtle' : severity < 0.35 ? 'notable' : 'major';
            const cutHue = sev === 'subtle' ? 155 : sev === 'notable' ? 42 : 12;
            const cutEl = el('div', `imf-tl-trim-cut-pro imf-tl-trim-cut-${sev}`);
            cutEl.style.left = (shot.begin / totalFrames * 100).toFixed(4) + '%';
            cutEl.style.setProperty('--cut-hue', cutHue);
            cutEl.style.setProperty('--cut-alpha', (0.7 + severity * 0.3).toFixed(2));
            // Badge: compact label showing primary delta — always shown for notable/major
            const deltaStr = _shortDelta(trim, prevTrim);
            if (deltaStr) {
              const badge = el('span', `imf-tl-trim-cut-badge imf-tl-trim-cut-badge-${sev}`, deltaStr);
              cutEl.appendChild(badge);
            }
            const details = [];
            if (trim && prevTrim) {
              if (gainΔ > 0.01) details.push(`Gain ${(prevTrim.gain||1).toFixed(2)}→${(trim.gain||1).toFixed(2)}`);
              if (liftΔ > 0.01) details.push(`Lift ${(prevTrim.lift||0).toFixed(3)}→${(trim.lift||0).toFixed(3)}`);
              if (satΔ  > 0.01) details.push(`Sat  ${(prevTrim.sat||1).toFixed(2)}→${(trim.sat||1).toFixed(2)}`);
              if (gamΔ  > 0.01) details.push(`Gam  ${(prevTrim.gamma||1).toFixed(2)}→${(trim.gamma||1).toFixed(2)}`);
            }
            cutEl.title = [
              `Grade change @ fr ${shot.begin}  |  Shot ${si}→${si+1}`,
              details.join('  ·  ') || 'Grade change',
              sev === 'major' ? '⚠ Major adjustment' : '',
            ].filter(Boolean).join('\n');
            trimTrack.appendChild(cutEl);
          }
          prevTrimKey = key;
          prevTrim = trim;
        }
      }
      }  // closes else (hasTrims)
      tlTrim.appendChild(trimLabel);
      tlTrim.appendChild(trimTrack);
    } // end outer block
  }
}

function _refreshDoviShotsTimeline({ updateViewport = true } = {}) {
  const tlShots = $('imfTLDoviShots');
  if (!tlShots) return;

  tlShots.innerHTML = '';

  const shots = _doviMetafierShots;
  const cplForCuts = _pkg?.cpl;
  // Always show when toggle enabled — empty state when no shots
  tlShots.style.display = _tlRowEnabled.cuts ? '' : 'none';

  if (!shots?.length || !cplForCuts) {
    // Empty state: reel boundary tick marks + dim label
    const emptyLabel = el('div', 'imf-tl-label imf-tl-label-dv-cuts', 'CUTS');
    const emptyTrack = el('div', 'imf-tl-track');
    if (cplForCuts) {
      let cutsOff = 0;
      cplForCuts.videoResources.forEach((res, i) => {
        // One reel boundary tick per reel start
        const tickPct = (cutsOff / (cplForCuts.totalFrames || 1) * 100).toFixed(4);
        const tick = el('div', 'imf-tl-reel-tick-absent');
        tick.style.left = tickPct + '%';
        tick.title = `Reel ${i+1} boundary — No CUTS metadata`;
        emptyTrack.appendChild(tick);
        cutsOff += res.sourceDuration;
      });
    }
    const _cutsMsg = _doviExtractResult?.status === DOVI_STATUS.EXTRACTOR_REQUIRED
      ? 'Extractor required for shot/cut data'
      : _doviExtractResult?.status === DOVI_STATUS.CONFIRMED_NO_DATA
        ? 'DV confirmed — no CM XML shot data'
        : 'No cut metadata';
    emptyTrack.appendChild(el('div', 'imf-tl-empty-note', _cutsMsg));
    tlShots.appendChild(emptyLabel);
    tlShots.appendChild(emptyTrack);
    return;
  }

  const totalF = cplForCuts.totalFrames || 1;

  const { conflicts } = buildUuidColorMap(shots);
  const conflictUuids = new Set(conflicts.map(c => c.uuid));

  const shotCount = shots.length;
  const label = el('div', 'imf-tl-label imf-tl-label-dv-cuts', `DV<br><span class="imf-tl-dv-shot-count">${shotCount}</span>`);
  const track = el('div', 'imf-tl-track');

  for (const shot of shots) {
    const leftPct  = (shot.begin / totalF * 100).toFixed(4);
    const widthPct = Math.max(0.08, ((shot.end - shot.begin + 1) / totalF * 100)).toFixed(4);

    const isBadUuid = !!(shot.uuid && conflictUuids.has(shot.uuid));
    const isBlack   = shot.transitionType === 'black';
    const cls = `imf-tl-dv-shot-seg ${isBlack ? 'imf-tl-seg-dv-shot-black' : 'imf-tl-seg-dv-shot'}${isBadUuid ? ' imf-tl-seg-dv-shot-conflict' : ''}`;
    const seg = el('div', cls);
    seg.style.left  = leftPct + '%';
    seg.style.width = widthPct + '%';
    seg.dataset.shotIndex = shot.index;

    const uuidColor = _shotTimelineColor(shot);
    if (uuidColor) seg.style.background = uuidColor;
    if (isBadUuid) seg.style.outline = '1px solid rgba(255,60,60,.7)';

    // Gap cut marker: thin red line at left edge of shot when there's a frame gap before it
    if (shot.gapBefore > 0) {
      const gap = el('div', 'imf-tl-dovi-gap');
      gap.style.left = leftPct + '%';
      gap.title = `Gap: ${shot.gapBefore} frame${shot.gapBefore !== 1 ? 's' : ''} before shot ${shot.index + 1}`;
      track.appendChild(gap);
    }

    // Trim pass count from L8 entries + explicit TrimPass entries
    const l8s = Array.isArray(shot.l8) ? shot.l8 : (shot.l8 ? [shot.l8] : []);
    const trimCount = l8s.length + (shot.trimPasses?.length ?? 0);
    const nitsVal = shot.l1?.maxNits != null ? Math.round(shot.l1.maxNits) : null;
    const avgNits = shot.l1?.avgNits  != null ? Math.round(shot.l1.avgNits)  : null;

    // Meta label: shot number always first, then trim + nits — clipped by overflow:hidden
    seg.style.overflow = 'hidden';
    const metaParts = [`#${shot.index + 1}`];
    if (trimCount > 0) metaParts.push(`T${trimCount}`);
    if (nitsVal != null) metaParts.push(`${nitsVal}n`);
    const lbl = el('span', 'imf-tl-shot-meta-label');
    lbl.textContent = metaParts.join(' · ');
    seg.appendChild(lbl);

    // L1 nits bar — a colored vertical bar at the right edge of each shot
    // showing relative brightness (maxNits / 4000) at a glance
    if (nitsVal != null && !isBlack) {
      const barH = Math.max(2, Math.round(Math.min(1, nitsVal / 4000) * 100));
      const barR = Math.round(120 + 135 * Math.min(1, nitsVal / 3000));
      const barG = Math.round(80  +  80 * Math.min(1, nitsVal / 1000));
      const barB = Math.round(240 -  80 * Math.min(1, nitsVal / 4000));
      const bar  = el('div', 'imf-tl-dv-l1-bar');
      bar.style.cssText = `height:${barH}%;background:rgba(${barR},${barG},${barB},.75);`;
      seg.appendChild(bar);
    }

    // Top-border color coded by trim count — visible even at sub-pixel widths when zoomed
    if (!isBlack && !isBadUuid) {
      if (trimCount >= 3) {
        seg.style.borderTop = '2px solid rgba(255,160,20,.95)';
      } else if (trimCount >= 1) {
        seg.style.borderTop = '2px solid rgba(80,240,120,.90)';
      } else if (nitsVal != null) {
        const nPct = Math.min(1, nitsVal / 4000);
        const r = Math.round(80  + 160 * nPct);
        const g = Math.round(140 -  40 * nPct);
        const b = Math.round(255 -  80 * nPct);
        seg.style.borderTop = `2px solid rgba(${r},${g},${b},0.75)`;
      }
    }

    // Tooltip with L8 trim pass detail per display target
    const nitsLine = nitsVal != null ? ` · ${nitsVal} nit` : '';
    const uuidShort = shot.uuid ? shot.uuid.slice(0, 8) : '–';
    const l8Lines = l8s.map(l8 => {
      const disp = l8.targetDisplayIndex != null ? `Disp ${l8.targetDisplayIndex}` : 'Disp ?';
      const parts = [];
      if (l8.trimSlope      != null) parts.push(`slope ${l8.trimSlope}`);
      if (l8.trimOffset     != null) parts.push(`offset ${l8.trimOffset}`);
      if (l8.trimPower      != null) parts.push(`power ${l8.trimPower}`);
      if (l8.hueShift       != null) parts.push(`hue ${l8.hueShift}`);
      if (l8.saturationGain != null) parts.push(`sat ${l8.saturationGain}`);
      return `  ${disp}: ${parts.join('  ')}`;
    });
    const trimPassLines = (shot.trimPasses ?? []).map(tp => {
      const t = tp.target != null ? ` → ${tp.target} nit` : '';
      return `  TrimPass${t}`;
    });
    seg.title = [
      `DoVi Shot ${shot.index + 1}  frames ${shot.begin}–${shot.end}`,
      shot.transitionType ? `Type: ${shot.transitionType}` : 'Type: normal',
      `Duration: ${shot.durationFrames}f${nitsLine}`,
      ...(trimCount > 0 ? [`Trim passes: ${trimCount}`, ...l8Lines, ...trimPassLines] : []),
      shot.uuid ? `UUID: ${uuidShort}…` : 'UUID: –',
      shot.gapBefore > 0 ? `⚠ Gap before: ${shot.gapBefore}f` : '',
      isBadUuid ? '⚠ UUID / canvas mismatch' : '',
    ].filter(Boolean).join('\n');
    seg.addEventListener('click', (e) => { e.stopPropagation(); _selectDoviShot(shot.index); });
    track.appendChild(seg);
  }

  tlShots.appendChild(label);
  tlShots.appendChild(track);

  // ── Also refresh TRIM row per-shot overlays ─────────────────────────────
  // renderTimeline() runs before _doviMetafierShots is populated (async load),
  // so we update the TRIM row here whenever shot data becomes available.
  const tlTrim = $('imfTLTrim');
  if (tlTrim) {
    // If TRIM row was hidden (cpl.isDolbyVision was false at render time),
    // build a minimal shell and make it visible now that we have shot data.
    if (tlTrim.style.display === 'none') {
      tlTrim.style.display = '';
      const trimLabel = el('div', 'imf-tl-label imf-tl-label-trim', 'TRIM');
      const trimTrack = el('div', 'imf-tl-track');
      tlTrim.appendChild(trimLabel);
      tlTrim.appendChild(trimTrack);
    }
    const trimTrack = tlTrim.querySelector('.imf-tl-track');
    if (trimTrack) {
      // Remove stale per-shot overlays and rebuild from current shot data
      trimTrack.querySelectorAll('.imf-tl-shot-trim-overlay').forEach(e => e.remove());
      const totalF = _pkg.cpl.totalFrames || 1;
      for (const shot of shots) {
        const shotL8s = Array.isArray(shot.l8) ? shot.l8 : (shot.l8 ? [shot.l8] : []);
        const shotTrimCount = shotL8s.length + (shot.trimPasses?.length ?? 0);
        const sNitsVal = shot.l1?.maxNits != null ? Math.round(shot.l1.maxNits) : null;
        if (shotTrimCount === 0 && sNitsVal == null) continue;
        const sLeftPct  = (shot.begin / totalF * 100).toFixed(4);
        const sWidthPct = Math.max(0.08, ((shot.end - shot.begin + 1) / totalF * 100)).toFixed(4);
        const trimSeg = el('div', 'imf-tl-shot-trim-overlay');
        trimSeg.style.left  = sLeftPct + '%';
        trimSeg.style.width = sWidthPct + '%';
        if (shotTrimCount > 0) {
          const alpha = Math.min(0.35 + shotTrimCount * 0.18, 0.92);
          trimSeg.style.background = `rgba(78,200,140,${alpha.toFixed(2)})`;
        } else {
          const nPct = Math.min(1, (sNitsVal || 0) / 4000);
          trimSeg.style.background = `rgba(100,130,255,${(0.2 + nPct * 0.35).toFixed(2)})`;
        }
        const l8Disp = shotL8s.map(l8 => l8.targetDisplayIndex != null ? `Disp ${l8.targetDisplayIndex}` : 'Disp ?').join(', ');
        const trimTitle = shotTrimCount > 0
          ? `${shotTrimCount} trim pass${shotTrimCount !== 1 ? 'es' : ''}${l8Disp ? ` (${l8Disp})` : ''}`
          : 'No trim passes';
        trimSeg.title = [
          `Shot ${shot.index + 1}  frames ${shot.begin}–${shot.end}`,
          trimTitle,
          sNitsVal != null ? `L1 max: ${sNitsVal} nit` : '',
        ].filter(Boolean).join('\n');
        trimSeg.addEventListener('click', (e) => { e.stopPropagation(); _selectDoviShot(shot.index); });
        trimTrack.appendChild(trimSeg);
      }
    }
  }

  // Ensure zoom/pan structure is applied to the new track
  if (updateViewport) updateTimelinePlayhead();
}

/**
 * Scan the current IMF package for a Dolby Vision CM XML sidecar and populate
 * the Metafier panel — without requiring a proxy transcode first.
 *
 * Strategy:
 *   1. Companion mode: send `getDoviMetafier` with the folder path
 *   2. Browser File System Access: traverse the directory handle directly
 */
async function _tryLoadDoviMetafier() {
  if (_doviExtractPending) return;
  const cpl = _pkg?.cpl;
  if (!cpl) return;
  _doviExtractPending = true;
  try {
    const result = await analyzeDolbyVisionFromImfPackage({
      pkg:                  _pkg,
      imfSourceBackend:     _imfSourceBackend,
      imfSourceFolderPath:  _imfSourceFolderPath,
      imfSourceDirHandle:   _imfSourceDirHandle,
      currentCplKey:        _currentCplKey,
      cplEntries:           _cplEntries,
      getReelFile:          _getReelFile,
    });
    _doviExtractResult = result;

    if (result.status === DOVI_STATUS.FOUND && result.shots.length) {
      // Full per-shot data — feed into existing renderer
      _renderDoviMetafier({ shots: result.shots, xmlPath: result.sourcePath,
        fromMxfHeader: result.sourceType === DOVI_SOURCE.CPL_DESCRIPTOR });
      return;
    }
    if (result.status === DOVI_STATUS.CONFIRMED_NO_DATA) {
      // DV confirmed from MXF/CPL but no per-shot CM XML
      _renderDoviMetafier({ shots: [], fromMxfHeader: true,
        xmlPath: result.sourcePath, dvProfile: result.profile, dvLevel: result.level });
      return;
    }
    // All other states (EXTRACTOR_REQUIRED, NOT_FOUND, etc.) — clear and let
    // _refreshDoviMetaRows show the appropriate status message.
    _clearDoviMetafier();
    // Re-trigger the row render so status messages reflect the new result
    _refreshDoviMetaRows();
    _refreshDoviShotsTimeline();
    // Update toggle chip visibility and the "Extract DoVi" button
    const _hasDvHint = result.status === DOVI_STATUS.EXTRACTOR_REQUIRED ||
                       result.status === DOVI_STATUS.CONFIRMED_NO_DATA;
    _updateDvToggleVisibility(_hasDvHint);
    _updateDoviExtractPanel();
    _refreshValidationResults();
  } catch (e) {
    console.warn('[IMF] DoVi extractor error:', e);
    _doviExtractResult = { status: DOVI_STATUS.EXTRACT_FAILED, errors: [String(e?.message || e)],
      shots: [], warnings: [], sourceType: DOVI_SOURCE.NONE };
    _clearDoviMetafier();
    _refreshValidationResults();
  } finally {
    _doviExtractPending = false;
  }
}

function _renderDoviMetafier(doviData) {
  // Accept both full Metafier data (shots.length > 0) and MXF-header confirmation
  // (fromMxfHeader=true, shots=[]). Both cases enable the DV/TRIM timeline rows.
  const hasShots = doviData?.shots?.length > 0;
  const hasMxfDv = !!doviData?.fromMxfHeader;
  if (!hasShots && !hasMxfDv) { _clearDoviMetafier(); return; }

  const shots = hasShots ? annotateShots(doviData.shots) : [];
  // Store null for MXF-header-only case so _refreshDoviMetaRows hasDvData check uses _dvMxfConfirmed.
  _doviMetafierShots = hasShots ? shots : null;
  _dvMxfConfirmed    = hasMxfDv;  // set when ffprobe found DV but no per-shot Metafier data

  // Feed the per-shot 100-nit Rec.709 SDR trim to the player (preview trim).
  try {
    playerSetDoviShots(hasShots ? shots.map(s => ({
      begin:      s.begin,
      end:        s.end,
      sdrTrim:    pickSdrTrim(s),
      l1MaxNits:  s.l1?.maxNits   ?? null,   // per-shot peak for render worker tone mapping
      l6MaxNits:  s.l6?.maxMasteringLuminance ?? null,  // mastering display peak
    })) : []);
  } catch (e) { console.warn('[IMF] playerSetDoviShots failed', e); }

  const warnings = validateDoviShots(shots);
  const { conflicts } = buildUuidColorMap(shots);
  const conflictedUuids = new Set(conflicts.map(c => c.uuid));

  const errCount  = warnings.filter(w => w.severity === 'error').length;
  const warnCount = warnings.filter(w => w.severity === 'warn').length;

  // ── Panel visible ──
  const panel = $('imfDoviMetafierPanel'); if (panel) panel.style.display = '';

  // ── Update extraction debug panel from _doviExtractResult ──
  _updateDoviExtractPanel();

  // ── State badge ──
  const stateEl = $('imfDoviMetafierState');
  if (stateEl) {
    stateEl.textContent = errCount   ? `${errCount} error${errCount > 1 ? 's' : ''}`
                        : warnCount  ? `${warnCount} warning${warnCount > 1 ? 's' : ''}`
                        : 'Valid';
    stateEl.style.color = errCount ? '#f55' : warnCount ? '#f7c26a' : '#4caf80';
  }

  // ── Shot count ──
  const scEl = $('imfDoviShotCount');
  if (scEl) {
    const transCount = shots.filter(s => s.isTransition).length;
    scEl.textContent = transCount
      ? `${shots.length} (${transCount} transition${transCount > 1 ? 's' : ''})`
      : String(shots.length);
  }

  // ── Canvas (L6) — summary line + per-canvas cards ──
  const cvEl  = $('imfDoviCanvas');
  const cvRow = $('imfDoviCanvasRow');
  const cvList = $('imfDoviCanvasList');

  // Build unique canvas map: JSON(l6) → { l6, shots[], uuids[] }
  const canvasMap = new Map();
  for (const shot of shots) {
    if (!shot.l6) continue;
    const key = JSON.stringify(shot.l6);
    if (!canvasMap.has(key)) canvasMap.set(key, { l6: shot.l6, shots: [], uuids: new Set() });
    const entry = canvasMap.get(key);
    entry.shots.push(shot.index);
    if (shot.uuid) entry.uuids.add(shot.uuid);
  }

  if (cvEl) {
    if (canvasMap.size === 0) {
      cvEl.textContent = 'Not found';
    } else {
      const first = canvasMap.values().next().value.l6;
      const { maxMasteringLuminance: maxL, maxContentLightLevel: cll,
              maxFrameAverageLightLevel: fall } = first;
      const parts = [`${maxL ?? '?'} nit`];
      if (cll  != null) parts.push(`CLL ${cll}`);
      if (fall != null) parts.push(`FALL ${fall}`);
      if (canvasMap.size > 1) parts.push(`+${canvasMap.size - 1} more`);
      cvEl.textContent = parts.join(' · ');
    }
  }

  if (cvList && canvasMap.size > 0) {
    const { conflicts } = buildUuidColorMap(shots);
    const conflictUuids = new Set(conflicts.map(c => c.uuid));
    let cardIdx = 0;
    cvList.innerHTML = '';
    for (const [, { l6, shots: shotIdxs, uuids }] of canvasMap) {
      cardIdx++;
      const { maxMasteringLuminance: maxL, minMasteringLuminance: minL,
              maxContentLightLevel: cll, maxFrameAverageLightLevel: fall } = l6;
      const hasConflict = [...uuids].some(u => conflictUuids.has(u));
      const hue = _uuidToHue([...uuids][0] || String(cardIdx));
      const accentColor = `hsl(${hue},55%,48%)`;

      const card = document.createElement('div');
      card.className = `imf-dovi-canvas-card ${hasConflict ? 'imf-dovi-canvas-conflict' : 'imf-dovi-canvas-ok'}`;
      card.style.setProperty('--canvas-accent', accentColor);
      card.style.borderLeftColor = accentColor;

      const lumStr = `${maxL ?? '?'} nit` + (minL != null ? ` / ${minL} nit min` : '');
      const cllStr = cll  != null ? `MaxCLL: ${cll} nit` : '';
      const fallStr = fall != null ? `MaxFALL: ${fall} nit` : '';

      // UUID chips
      const uuidChips = [...uuids].map(u => {
        const bad  = conflictUuids.has(u);
        const cls  = bad ? 'imf-dovi-uuid-bad' : 'imf-dovi-uuid-ok';
        const hex  = _uuidToHex(u);
        return `<span class="imf-dovi-uuid ${cls}" title="${u}" style="border-left:2px solid ${hex}">${u.slice(0, 8)}…</span>`;
      }).join('');

      card.innerHTML = `
        <div class="imf-dovi-canvas-card-head">
          <span class="imf-dovi-canvas-card-title">Canvas ${cardIdx}${hasConflict ? ' ⚠' : ''}</span>
          <span class="imf-dovi-canvas-card-shots">${shotIdxs.length} shot${shotIdxs.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="imf-dovi-canvas-card-lum">${lumStr}</div>
        ${(cllStr || fallStr) ? `<div class="imf-dovi-canvas-card-sub">
          ${cllStr ? `<span>${cllStr}</span>` : ''}
          ${fallStr ? `<span>${fallStr}</span>` : ''}
        </div>` : ''}
        ${uuidChips ? `<div class="imf-dovi-canvas-card-uuids">${uuidChips}</div>` : ''}
      `;
      cvList.appendChild(card);
    }
    if (cvRow) cvRow.style.display = '';
  }

  // ── Source XML ──
  const srcEl = $('imfDoviXmlSource');
  if (srcEl && doviData.xmlPath) {
    const fname = doviData.xmlPath.replace(/\\/g, '/').split('/').pop() || doviData.xmlPath;
    srcEl.textContent = fname;
    srcEl.title = doviData.xmlPath;
    const row = srcEl.closest('.imf-proxy-meta-row');
    if (row) row.style.display = '';
  }

  // ── DoVi version ──
  const verEl = $('imfDoviVersion');
  if (verEl && doviData.version) {
    verEl.textContent = doviData.version;
    const row = verEl.closest('.imf-proxy-meta-row');
    if (row) row.style.display = '';
  }

  // ── Validation summary ──
  const valEl = $('imfDoviValidation');
  if (valEl) {
    if (!warnings.length) {
      valEl.textContent = `✓ ${shots.length} shots, no issues`;
      valEl.style.color = '#4caf80';
    } else if (!errCount) {
      valEl.textContent = `⚠ ${warnCount} warning${warnCount > 1 ? 's' : ''}`;
      valEl.style.color = '#f7c26a';
    } else {
      valEl.textContent = `✕ ${errCount} error${errCount > 1 ? 's' : ''}, ${warnCount} warning${warnCount > 1 ? 's' : ''}`;
      valEl.style.color = '#f55';
    }
  }

  // ── Content summary stats card ──
  const summaryEl = $('imfDoviContentSummary');
  if (summaryEl && shots.length > 0) {
    const contentShots = shots.filter(s => !s.isTransition);
    const peakNits = contentShots.reduce((mx, s) => Math.max(mx, s.l1?.maxNits ?? 0), 0);
    const canvasPeaks = new Set(contentShots.map(s => s.l6?.maxMasteringLuminance).filter(Boolean));
    const allTrimTargets = new Set();
    contentShots.forEach(s => {
      const l8s = Array.isArray(s.l8) ? s.l8 : (s.l8 ? [s.l8] : []);
      const tpL8s = (s.trimPasses || []).map(tp => tp.levels?.l8).filter(Boolean);
      [...l8s, ...tpL8s].forEach(l => { if (l.targetDisplayIndex != null) allTrimTargets.add(l.targetDisplayIndex); });
    });
    const trimChips = [...allTrimTargets].sort((a, b) => a - b).map(idx => {
      const entry = DV_TRIM_TARGETS.get(idx);
      const tier  = entry?.tier === 'sdr' ? '#4caf80' : '#f7c26a';
      const short = idx === 27 ? 'SDR 709' : entry ? `${entry.nits}nit` : `D${idx}`;
      return `<span style="font-size:8px;padding:1px 6px;border-radius:2px;background:rgba(255,255,255,.07);color:${tier};font-family:monospace;" title="${getTrimTargetLabel(idx)}">${short}</span>`;
    }).join(' ');
    const canvasStr = [...canvasPeaks].sort((a, b) => a - b).map(n => `${n} nit`).join(' / ');
    summaryEl.innerHTML = `
      <div class="imf-proxy-meta-row" style="display:flex;gap:16px;flex-wrap:wrap;padding:6px 0 2px;">
        <span><span class="imf-proxy-meta-label">Peak</span>&nbsp;<span class="imf-proxy-meta-val">${peakNits ? Math.round(peakNits) + ' nit' : '—'}</span></span>
        <span><span class="imf-proxy-meta-label">Canvas</span>&nbsp;<span class="imf-proxy-meta-val">${canvasStr || '—'}</span></span>
        <span><span class="imf-proxy-meta-label">Content shots</span>&nbsp;<span class="imf-proxy-meta-val">${contentShots.length}</span></span>
        <span style="display:flex;align-items:center;gap:4px;"><span class="imf-proxy-meta-label">Trim targets</span>&nbsp;${trimChips || '<span style="color:rgba(255,255,255,.3);font-size:9px">none</span>'}</span>
      </div>`;
    summaryEl.style.display = '';
  } else if (summaryEl) {
    summaryEl.style.display = 'none';
  }

  // ── Shot list table ──
  const slEl = $('imfDoviShotList');
  let activeRowIndex = -1;
  if (slEl) {
    const rows = shots.map((shot, i) => {
      const ttype = shot.transitionType;
      const badge = ttype === 'black'    ? '<span class="imf-dovi-badge imf-dovi-badge-black">black</span>'
                  : ttype === 'fade'     ? '<span class="imf-dovi-badge imf-dovi-badge-fade">fade</span>'
                  : ttype === 'dissolve' ? '<span class="imf-dovi-badge imf-dovi-badge-dissolve">dissolve</span>'
                  : shot.gapBefore > 0   ? '<span class="imf-dovi-badge imf-dovi-badge-cut">gap</span>'
                  : '';
      const maxNits = shot.l1?.maxNits != null ? `${Math.round(shot.l1.maxNits)} nit` : '—';
      const canvas  = shot.l6?.maxMasteringLuminance != null ? `${shot.l6.maxMasteringLuminance} nit` : '—';
      const uuidShort = shot.uuid ? shot.uuid.slice(0, 8) : '—';
      const uuidClass = shot.uuid
        ? (conflictedUuids.has(shot.uuid) ? 'imf-dovi-uuid-bad' : 'imf-dovi-uuid-ok')
        : 'imf-dovi-uuid-missing';
      // Warn icon if this shot has warnings
      const hasErr = warnings.some(w => w.shotIndex === i && w.severity === 'error');
      const hasWrn = warnings.some(w => w.shotIndex === i && w.severity === 'warn');
      const warnIcon = hasErr ? '<span class="imf-dovi-row-warn imf-dovi-row-err" title="Error">✕</span>'
                     : hasWrn ? '<span class="imf-dovi-row-warn" title="Warning">⚠</span>'
                     : '';
      // Trim targets column: chips for each L8 target index on this shot
      const shotL8s = Array.isArray(shot.l8) ? shot.l8 : (shot.l8 ? [shot.l8] : []);
      const tpL8s = (shot.trimPasses || []).map(tp => tp.levels?.l8).filter(Boolean);
      const shotTargets = [...new Set([...shotL8s, ...tpL8s]
        .map(l => l.targetDisplayIndex).filter(v => v != null))].sort((a, b) => a - b);
      const trimCell = shotTargets.length
        ? shotTargets.map(idx => {
            const entry = DV_TRIM_TARGETS.get(idx);
            const clr   = entry?.tier === 'sdr' ? '#4caf80' : '#f7c26a';
            const short = idx === 27 ? 'SDR' : entry ? `${entry.nits}` : `D${idx}`;
            return `<span style="font-size:7.5px;padding:0 3px;border-radius:2px;background:rgba(255,255,255,.07);color:${clr}" title="${getTrimTargetLabel(idx)}">${short}</span>`;
          }).join(' ')
        : '—';
      return `<tr class="imf-dovi-shot-row" data-index="${i}" data-begin="${shot.begin}" data-end="${shot.end}" title="Click to seek player to frame ${shot.begin}">
        <td class="imf-dovi-td-num">${i + 1}${warnIcon}</td>
        <td class="imf-dovi-td-range">${shot.begin}–${shot.end}</td>
        <td class="imf-dovi-td-dur">${shot.durationFrames}f</td>
        <td class="imf-dovi-td-type">${badge}</td>
        <td class="imf-dovi-td-l1">${maxNits}</td>
        <td class="imf-dovi-td-canvas">${canvas}</td>
        <td class="imf-dovi-td-trims">${trimCell}</td>
        <td class="imf-dovi-td-uuid"><span class="imf-dovi-uuid ${uuidClass}" title="${shot.uuid || ''}">${uuidShort}</span></td>
      </tr>`;
    });
    slEl.innerHTML = `<table class="imf-dovi-shot-table">
      <thead><tr>
        <th>#</th><th>Frames</th><th>Dur</th><th>Type</th>
        <th>L1 Max</th><th>Canvas</th><th>Trims</th><th>UUID</th>
      </tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;

    // ── Shot click: delegate to _selectDoviShot ──
    slEl.addEventListener('click', (e) => {
      const row = e.target.closest('tr.imf-dovi-shot-row');
      if (!row) return;
      const idx = parseInt(row.dataset.index, 10);
      if (_doviActiveShot === idx) { _clearDoviShotDetail(); return; }
      _selectDoviShot(idx);
    });
  }

  // ── Warnings list ──
  const wnEl = $('imfDoviWarnings');
  if (wnEl) {
    if (warnings.length) {
      wnEl.innerHTML = warnings.map(w => {
        const icon = w.severity === 'error' ? '✕' : '⚠';
        const cls  = w.severity === 'error' ? 'imf-dovi-warn-error' : 'imf-dovi-warn-warn';
        return `<div class="imf-dovi-warn-row ${cls}">${icon} ${w.message}</div>`;
      }).join('');
      wnEl.style.display = '';
    } else {
      wnEl.innerHTML = '';
      wnEl.style.display = 'none';
    }
  }

  // ── Level presence badges ──
  const lvlRow = $('imfDoviLevelRow');
  const lvlBadges = $('imfDoviLevelBadges');
  if (lvlBadges) {
    const LEVELS = [
      { key: 'l1',  label: 'L1' },
      { key: 'l3',  label: 'L3' },
      { key: 'l5',  label: 'L5' },
      { key: 'l6',  label: 'L6' },
      { key: 'l8',  label: 'L8' },
      { key: 'l9',  label: 'L9' },
      { key: 'l11', label: 'L11' },
    ];
    const present = LEVELS.filter(({ key }) =>
      shots.some(s => key === 'l8' ? (Array.isArray(s.l8) ? s.l8.length > 0 : !!s.l8)
                       : key === 'l2' ? (Array.isArray(s.l2) ? s.l2.length > 0 : !!s.l2)
                       : s[key] != null)
    );
    if (present.length) {
      lvlBadges.innerHTML = present.map(({ label }) =>
        `<span class="imf-dovi-lvl-badge">${label}</span>`
      ).join('');
      if (lvlRow) lvlRow.style.display = '';
    }
  }

  // ── Trim pass count ──
  const tpCount = shots.reduce((sum, s) => sum + (s.trimPasses?.length ?? 0), 0);
  if (tpCount && scEl && !scEl.textContent.includes('trim')) {
    scEl.textContent += ` · ${tpCount} trim pass${tpCount > 1 ? 'es' : ''}`;
  }

  // ── Rescan + Export buttons (panel + header) ──
  const rsBtn = $('imfDoviRescanBtn');        if (rsBtn)  rsBtn.style.display  = '';
  const exBtn  = $('imfDoviExportBtn');        if (exBtn)  exBtn.style.display  = '';
  const exHdr  = $('imfDoviExportHeaderBtn'); if (exHdr)  exHdr.style.display  = '';

  // Refresh KPI + all three DV timeline rows (META, TRIM, CUTS)
  renderKPI();
  _refreshDoviMetaRows();       // DV META + TRIM rows — needs Metafier shots now available
  _refreshDoviShotsTimeline();  // CUTS row
}

function _clearDoviShotDetail() {
  _doviActiveShot = -1;
  const det = $('imfDoviShotDetail');
  if (det) { det.innerHTML = ''; det.style.display = 'none'; }
  const nav = $('imfDoviNavRow'); if (nav) nav.style.display = 'none';
  // Deactivate all rows
  const sl = $('imfDoviShotList');
  if (sl) sl.querySelectorAll('.imf-dovi-shot-row-active').forEach(r => r.classList.remove('imf-dovi-shot-row-active'));
}

function _selectDoviShot(idx) {
  const shots = _doviMetafierShots;
  if (!shots?.length) return;
  if (idx < 0 || idx >= shots.length) return;

  _doviActiveShot = idx;
  const shot = shots[idx];

  // Seek player
  const fps = (_pkg?.cpl?.editRate) || 24;
  if (_imfViewerMode === 'proxy') {
    const proxyV = $('imfProxyVideo');
    if (proxyV) proxyV.currentTime = shot.begin / fps;
  } else {
    playerSeekToFrame(shot.begin, { pause: true });
  }

  // Update row highlight + scroll into view
  const sl = $('imfDoviShotList');
  if (sl) {
    sl.querySelectorAll('.imf-dovi-shot-row-active').forEach(r => r.classList.remove('imf-dovi-shot-row-active'));
    const row = sl.querySelector(`tr[data-index="${idx}"]`);
    if (row) {
      row.classList.add('imf-dovi-shot-row-active');
      row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // Gather warnings for this shot
  const warnings = validateDoviShots(shots);
  _renderDoviShotDetail(shot, warnings.filter(w => w.shotIndex === idx));

  // Update nav row
  const nav = $('imfDoviNavRow');
  const info = $('imfDoviNavInfo');
  if (nav) nav.style.display = '';
  if (info) info.textContent = `Shot ${idx + 1} / ${shots.length}`;

  const prevBtn = $('imfDoviPrevShot');
  const nextBtn = $('imfDoviNextShot');
  if (prevBtn) prevBtn.disabled = idx === 0;
  if (nextBtn) nextBtn.disabled = idx === shots.length - 1;
}

function _renderDoviShotDetail(shot, shotWarnings) {
  const det = $('imfDoviShotDetail');
  if (!det) return;

  const fmtPq = (pq, nits) => pq != null ? `${pq} PQ (${nits != null ? Math.round(nits) + ' nit' : '?'})` : '—';
  const fmtInt = v => v != null ? String(v) : '—';

  const sections = [];

  // L1
  if (shot.l1) {
    sections.push(`<div class="imf-dovi-det-section"><span class="imf-dovi-det-label">L1 — Frame Luminance</span>
      <div class="imf-dovi-det-grid">
        <span>Min</span><span>${fmtPq(shot.l1.minPq, shot.l1.minNits)}</span>
        <span>Mid (avg)</span><span>${fmtPq(shot.l1.midPq, shot.l1.midNits)}</span>
        <span>Max</span><span>${fmtPq(shot.l1.maxPq, shot.l1.maxNits)}</span>
      </div></div>`);
  }

  // L6 Canvas
  if (shot.l6) {
    const l6 = shot.l6;
    sections.push(`<div class="imf-dovi-det-section"><span class="imf-dovi-det-label">L6 — Mastering Display (Canvas)</span>
      <div class="imf-dovi-det-grid">
        <span>Max luminance</span><span>${fmtInt(l6.maxMasteringLuminance)} nit</span>
        <span>Min luminance</span><span>${fmtInt(l6.minMasteringLuminance)} nit</span>
        <span>MaxCLL</span><span>${fmtInt(l6.maxContentLightLevel)} nit</span>
        <span>MaxFALL</span><span>${fmtInt(l6.maxFrameAverageLightLevel)} nit</span>
      </div></div>`);
  }

  // L3
  if (shot.l3 && (shot.l3.minPqOffset != null || shot.l3.maxPqOffset != null)) {
    sections.push(`<div class="imf-dovi-det-section"><span class="imf-dovi-det-label">L3 — PQ Offsets</span>
      <div class="imf-dovi-det-grid">
        <span>Min offset</span><span>${fmtInt(shot.l3.minPqOffset)}</span>
        <span>Max offset</span><span>${fmtInt(shot.l3.maxPqOffset)}</span>
        <span>Avg offset</span><span>${fmtInt(shot.l3.avgPqOffset)}</span>
      </div></div>`);
  }

  // L5 active area
  if (shot.l5 && shot.l5.activeAreaX != null) {
    sections.push(`<div class="imf-dovi-det-section"><span class="imf-dovi-det-label">L5 — Active Area</span>
      <div class="imf-dovi-det-grid">
        <span>X / Y</span><span>${fmtInt(shot.l5.activeAreaX)} / ${fmtInt(shot.l5.activeAreaY)}</span>
        <span>W / H</span><span>${fmtInt(shot.l5.activeAreaW)} / ${fmtInt(shot.l5.activeAreaH)}</span>
      </div></div>`);
  }

  // L8 trim passes — with decoded fixed-point values and neutral detection
  const l8s = Array.isArray(shot.l8) ? shot.l8 : (shot.l8 ? [shot.l8] : []);
  for (const l8 of l8s) {
    const targetLabel = getTrimTargetLabel(l8.targetDisplayIndex);
    const neutral     = isNeutralL8(l8);
    const neutralBadge = neutral
      ? '<span style="font-size:8px;padding:1px 5px;border-radius:2px;background:rgba(255,255,255,.08);color:rgba(255,255,255,.35);font-family:monospace;margin-left:6px">NEUTRAL</span>'
      : '';
    const fv = k => fmtL8Value(k, l8[k]);
    sections.push(`<div class="imf-dovi-det-section">
      <span class="imf-dovi-det-label">L8 — Trim · ${targetLabel}${neutralBadge}</span>
      <div class="imf-dovi-det-grid">
        <span>Slope</span><span>${fv('trimSlope')} <span style="color:rgba(255,255,255,.3);font-size:8px">(raw ${fmtInt(l8.trimSlope)})</span></span>
        <span>Offset</span><span>${fv('trimOffset')} <span style="color:rgba(255,255,255,.3);font-size:8px">(raw ${fmtInt(l8.trimOffset)})</span></span>
        <span>Power</span><span>${fv('trimPower')} <span style="color:rgba(255,255,255,.3);font-size:8px">(raw ${fmtInt(l8.trimPower)})</span></span>
        <span>Sat gain</span><span>${fv('saturationGain')} <span style="color:rgba(255,255,255,.3);font-size:8px">(raw ${fmtInt(l8.saturationGain)})</span></span>
        <span>Chroma weight</span><span>${fv('chromaWeight')}</span>
        <span>Hue shift</span><span>${fv('hueShift')}</span>
      </div></div>`);
  }

  // Trim passes (structured trimPass nodes with nested L8)
  for (const tp of (shot.trimPasses ?? [])) {
    const l8 = tp.levels?.l8;
    if (l8) {
      const targetLabel = getTrimTargetLabel(tp.target ?? l8.targetDisplayIndex);
      const neutral     = isNeutralL8(l8);
      const neutralBadge = neutral
        ? '<span style="font-size:8px;padding:1px 5px;border-radius:2px;background:rgba(255,255,255,.08);color:rgba(255,255,255,.35);font-family:monospace;margin-left:6px">NEUTRAL</span>'
        : '';
      const fv = k => fmtL8Value(k, l8[k]);
      sections.push(`<div class="imf-dovi-det-section">
        <span class="imf-dovi-det-label">Trim Pass · ${targetLabel}${neutralBadge}</span>
        <div class="imf-dovi-det-grid">
          <span>Slope</span><span>${fv('trimSlope')}</span>
          <span>Offset</span><span>${fv('trimOffset')}</span>
          <span>Power</span><span>${fv('trimPower')}</span>
          <span>Sat gain</span><span>${fv('saturationGain')}</span>
        </div></div>`);
    } else {
      const target = tp.target != null ? ` Target ${tp.target} nit` : '';
      sections.push(`<div class="imf-dovi-det-section"><span class="imf-dovi-det-label">Trim Pass${target} — no L8 data</span></div>`);
    }
  }

  // L9 / L11
  if (shot.l9?.sourceColorPrimary) {
    sections.push(`<div class="imf-dovi-det-section"><span class="imf-dovi-det-label">L9 — Color Primary</span>
      <div class="imf-dovi-det-grid"><span>Primary</span><span>${shot.l9.sourceColorPrimary}</span></div></div>`);
  }
  if (shot.l11?.contentType) {
    sections.push(`<div class="imf-dovi-det-section"><span class="imf-dovi-det-label">L11 — Content Type</span>
      <div class="imf-dovi-det-grid">
        <span>Type</span><span>${shot.l11.contentType}</span>
        ${shot.l11.whitepointTemperature != null ? `<span>Whitepoint</span><span>${shot.l11.whitepointTemperature} K</span>` : ''}
      </div></div>`);
  }

  // UUID
  if (shot.uuid) {
    sections.push(`<div class="imf-dovi-det-section"><span class="imf-dovi-det-label">UUID</span>
      <div class="imf-dovi-det-grid"><span style="grid-column:1/-1;font-family:monospace;word-break:break-all;color:#888">${shot.uuid}</span></div></div>`);
  }

  // Per-shot warnings
  if (shotWarnings.length) {
    const wHtml = shotWarnings.map(w => {
      const cls = w.severity === 'error' ? 'imf-dovi-warn-error' : 'imf-dovi-warn-warn';
      return `<div class="imf-dovi-warn-row ${cls}">${w.severity === 'error' ? '✕' : '⚠'} ${w.message}</div>`;
    }).join('');
    sections.push(`<div class="imf-dovi-det-section">${wHtml}</div>`);
  }

  det.innerHTML = sections.length
    ? `<div class="imf-dovi-detail-header">Shot ${(shot.index ?? 0) + 1} · frames ${shot.begin}–${shot.end}</div>${sections.join('')}`
    : '<div style="color:#555;font-size:10px;padding:4px">No level data for this shot.</div>';
  det.style.display = '';
}

function _onDoviUpdate({ timecode, meta, isStatic }) {
  const tc = $('imfDoviTimecode'); if (tc) tc.textContent = timecode || '–';

  const profile = meta?.profile ?? meta?.dvProfile ?? null;
  const level   = meta?.level   ?? meta?.dvLevel   ?? null;
  const maxCLL  = meta?.maxCLL  ?? null;
  const maxFALL = meta?.maxFALL ?? null;
  const l8      = meta?.L8 ?? meta?.l8Trim ?? null;

  const set = (id, val) => { const e = $(id); if (e) e.textContent = val != null ? val : '–'; };
  set('imfDoviProfile', profile);
  set('imfDoviLevel',   level);
  set('imfDoviMaxCLL',  maxCLL  != null ? String(Math.round(maxCLL))  : null);
  set('imfDoviMaxFALL', maxFALL != null ? String(Math.round(maxFALL)) : null);
  set('imfDoviTrim',    l8);

  const staticTag = $('imfDoviStatic');
  if (staticTag) staticTag.style.display = isStatic ? '' : 'none';

  const panel = $('imfDoviPanel');
  if (panel) panel.style.display = _imfViewerMode === 'proxy' && _proxyViewerReady ? 'flex' : 'none';
}

function _proxySessionIdFromUrl(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw, window.location.href);
    const parts = String(parsed.pathname || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  } catch {
    return raw.split('/').pop()?.split('?')[0] || '';
  }
}

async function _probeProxyVideoUrl(url = '') {
  const target = String(url || '').trim();
  if (!target) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const probe = await fetch(target, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const ok = probe.status === 200 || probe.status === 206 || probe.status === 405;
    try { await probe.body?.cancel(); } catch {}
    return ok;
  } catch {
    return false;
  }
}


function _proxySessionScopeKey(payload = {}) {
  const backend = String(payload?.backend || _imfSourceBackend || '').trim() || 'unknown';
  const folderPath = String(payload?.folderPath || _imfSourceFolderPath || '').trim();
  const packageId = String(payload?.packageId || _imfSourcePackageId || '').trim();
  const cplKey = String(payload?.cplRelativePath || payload?.cplId || payload?.cplPath || '').trim();
  const base = folderPath || packageId;
  if (!base) return '';
  return `pfx_proxy_session::${backend}::${base}::${cplKey || 'active'}`;
}

function _readStoredProxySession() {
  // If source variables are not set yet (e.g. page reload before project state loads),
  // try bootstrapping them from the stored legacy session so restore can proceed
  // without waiting for a full project load cycle.
  if (!String(_imfSourceFolderPath || _imfSourcePackageId || '').trim()) {
    try {
      const legacyRaw = localStorage.getItem('pfx_proxy_session') || '';
      if (!legacyRaw) {
        _proxyDebugMark('RESTORE_WAIT', 'Skipping proxy restore until IMF source is ready', { branch: 'RESTORE_WAIT', probe: 'source pending' });
        return null;
      }
      const legacy = JSON.parse(legacyRaw);
      const f = String(legacy?.folderPath || '').trim();
      const p = String(legacy?.packageId || '').trim();
      const b = String(legacy?.backend || '').trim();
      if (!f && !p) {
        _proxyDebugMark('RESTORE_WAIT', 'Skipping proxy restore until IMF source is ready', { branch: 'RESTORE_WAIT', probe: 'source pending' });
        return null;
      }
      _proxyDebugMark('RESTORE_BOOT_SOURCE', 'Bootstrapping source vars from stored proxy session', { branch: 'RESTORE_BOOT_SOURCE', probe: f || p });
      if (!_imfSourceFolderPath && f) _imfSourceFolderPath = f;
      if (!_imfSourcePackageId && p) _imfSourcePackageId = p;
      if (!_imfSourceBackend && b) _imfSourceBackend = b;
    } catch {
      _proxyDebugMark('RESTORE_WAIT', 'Skipping proxy restore until IMF source is ready', { branch: 'RESTORE_WAIT', probe: 'source pending' });
      return null;
    }
  }
  const scopedKey = _proxySessionScopeKey();
  let raw = '';
  if (scopedKey) {
    try { raw = localStorage.getItem(scopedKey) || ''; } catch {}
  }
  if (!raw) {
    try {
      const legacyRaw = localStorage.getItem('pfx_proxy_session') || '';
      if (legacyRaw) {
        const legacy = JSON.parse(legacyRaw);
        const legacyFolder = String(legacy?.folderPath || '').trim();
        const legacyPackageId = String(legacy?.packageId || '').trim();
        const currentFolder = String(_imfSourceFolderPath || '').trim();
        const currentPackageId = String(_imfSourcePackageId || '').trim();
        const sameFolder = !!currentFolder && currentFolder === legacyFolder;
        const samePackage = !!currentPackageId && currentPackageId === legacyPackageId;
        if (sameFolder || samePackage) raw = legacyRaw;
        else _proxyDebugMark('RESTORE_SKIP', 'Ignoring stale proxy session from different IMF package', { branch: 'RESTORE_SKIP', probe: legacyFolder || legacyPackageId || 'legacy mismatch' });
      }
    } catch {}
  }
  return raw || null;
}

function _persistProxySessionSnapshot(payload = {}) {
  try {
    const merged = {
      ...payload,
      savedAt: Date.now(),
    };
    const scopedKey = _proxySessionScopeKey(merged);
    if (scopedKey) {
      let prev = {};
      const prevRaw = localStorage.getItem(scopedKey);
      if (prevRaw) {
        try { prev = JSON.parse(prevRaw) || {}; } catch {}
      }
      localStorage.setItem(scopedKey, JSON.stringify({ ...prev, ...merged }));
    }
    localStorage.setItem('pfx_proxy_session', JSON.stringify(merged));
    _proxyDebugMark('SESSION_SAVED', String(payload?.sessionId || payload?.videoUrl || 'snapshot'), {
      sessionId: String(payload?.sessionId || _proxyDebug.sessionId || '').trim(),
      outputPath: String(payload?.outputPath || _proxyDebug.outputPath || '').trim(),
      probe: scopedKey || 'legacy',
    });
  } catch {}
}

async function _resumeStoredProxyJob({ sessionId = '', port = 0, progressUrl = '', cplLabel = '', audioMode = '', audioMessage = '' } = {}) {
  _proxyDebugMark('RESUME_JOB', 'Attach running proxy job', { branch: 'RESUME_JOB', sessionId: String(sessionId || '').trim() });
  const safeSessionId = String(sessionId || '').trim();
  const safePort = Number(port || 0) || 0;
  if (!safeSessionId || !safePort) return null;
  const safeProgressUrl = String(progressUrl || '').trim() || `http://127.0.0.1:${safePort}/progress/${safeSessionId}`;
  const _pollDeadline = Date.now() + 30 * 60 * 1000;
  let _pollStartMs = Date.now();
  let _pollStartPct = -1;
  for (;;) {
    if (Date.now() > _pollDeadline) {
      _proxyDebugMark('RESUME_JOB_TIMEOUT', 'polling deadline exceeded', { branch: 'RESUME_JOB' });
      return null;
    }
    try {
      const r = await fetch(safeProgressUrl, { cache: 'no-store' });
      if (!r.ok) return null;
      const payload = await r.json();
      const pct = Math.max(0, Math.min(100, Number(payload?.pct || 0) || 0));
      // ETA calculation: track when meaningful progress started
      if (_pollStartPct < 0 && pct > 0) { _pollStartMs = Date.now(); _pollStartPct = pct; }
      const _etaStr = (() => {
        if (pct <= 0 || pct >= 99 || _pollStartPct < 0) return '';
        const elapsed = (Date.now() - _pollStartMs) / 1000;
        const pctDone = pct - _pollStartPct;
        if (pctDone <= 0 || elapsed < 10) return '';
        const remSec = Math.round((elapsed / pctDone) * (100 - pct));
        if (remSec < 60) return ` · ~${remSec}s left`;
        return ` · ~${Math.ceil(remSec / 60)}m left`;
      })();
      const resumeKey = `${String(payload?.state || '').trim()}::${pct}`;
      if (resumeKey !== _proxyResumeDebugLastKey) {
        _proxyResumeDebugLastKey = resumeKey;
        _proxyDebugMark('RESUME_JOB_POLL', `${String(payload?.state || 'running').trim()} · ${pct}%`, { branch: 'RESUME_JOB', probe: `${String(payload?.state || 'running').trim()} @ ${pct}%`, outputPath: String(payload?.outputPath || _proxyDebug.outputPath || '').trim() });
      }
      const state = String(payload?.state || '').trim();
      const nextAudioMode = String(payload?.audioMode || audioMode || '').trim();
      const nextAudioMessage = String(payload?.audioMessage || audioMessage || '').trim();
      const nextOutputPath = String(payload?.outputPath || '').trim();
      const nextProxyName = String(payload?.proxyName || '').trim();
      const nextStartTimecode = String(payload?.startTimecode || '').trim();
      if (payload?.error || state === 'failed') {
        _proxyDebugMark('RESUME_JOB_FAIL', String(payload?.error || payload?.message || 'proxy_failed').trim(), { branch: 'RESUME_JOB', outputPath: nextOutputPath });
        return {
          error: String(payload?.error || payload?.message || 'proxy_failed').trim(),
          audioMode: nextAudioMode,
          audioMessage: nextAudioMessage,
          outputPath: nextOutputPath,
          proxyName: nextProxyName,
          startTimecode: nextStartTimecode,
        };
      }
      if (payload?.done || state === 'done') {
        _proxyDebugMark('RESUME_JOB_DONE', 'progress endpoint reports done', { branch: 'RESUME_JOB', outputPath: nextOutputPath, probe: 'done' });
        return {
          done: true,
          sessionId: safeSessionId,
          videoUrl: `http://127.0.0.1:${safePort}/stream/${safeSessionId}`,
          doviUrl: `http://127.0.0.1:${safePort}/imf_dovi/${safeSessionId}`,
          audioMode: nextAudioMode,
          audioMessage: nextAudioMessage,
          outputPath: nextOutputPath,
          proxyName: nextProxyName,
          startTimecode: nextStartTimecode,
        };
      }
      _setProxyTabState({
        mode: 'running',
        pct,
        status: (String(payload?.message || `Transcoding… ${pct}%`).trim()) + _etaStr,
        cpl: cplLabel || '—',
      });
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (err) {
      _proxyDebugMark('RESUME_JOB_NULL', err?.message || 'progress probe failed', { branch: 'RESUME_JOB', probe: 'progress endpoint unavailable' });
      return null;
    }
  }
}

async function _refreshCompanionPackageFromSession(session) {
  const folderPath = String(session?.folderPath || _imfSourceFolderPath || '').trim();
  if (!folderPath) return null;
  try {
    const scan = await imfScanFolderCompanion(folderPath);
    if (!scan) return null;
    const wantedCplId = String(session?.cplId || '').trim();
    const wantedRelPath = String(session?.cplRelativePath || '').trim();
    const wantedLabel = String(session?.cplLabel || '').trim();
    const matched = Array.isArray(scan?.cpls)
      ? (scan.cpls.find(c => String(c?.cplId || '').trim() === wantedCplId)
        || scan.cpls.find(c => String(c?.relativePath || '').trim() === wantedRelPath)
        || scan.cpls.find(c => String(c?.name || '').trim() === wantedLabel)
        || null)
      : null;
    if (scan?.snapshot) {
      _restoreImfSnapshot({
        ...scan.snapshot,
        activeLeftTab: _imfActiveLeftTab || 'transcode',
        source: {
          ...(scan.snapshot.source || {}),
          folderName: scan.snapshot?.source?.folderName || '',
          folderPath,
          backend: 'companion',
          packageId: scan.packageId || '',
        },
      });
      try { window.__PFX_IMF_STATE = _buildImfProjectState(); } catch {}
    } else {
      _imfSourceBackend = 'companion';
      _imfSourceFolderPath = folderPath;
      _imfSourcePackageId = String(scan?.packageId || '').trim();
      try { localStorage.setItem('pfx_imf_source_session', JSON.stringify({ backend: 'companion', folderPath, packageId: _imfSourcePackageId, savedAt: Date.now() })); } catch {}
    }
    return {
      folderPath,
      packageId: String(scan?.packageId || _imfSourcePackageId || session?.packageId || '').trim(),
      cplId: String(matched?.cplId || wantedCplId || _pkg?.cpl?.id || '').trim(),
      cplRelativePath: String(matched?.relativePath || wantedRelPath || '').trim(),
      cplLabel: String(matched?.name || wantedLabel || '').trim(),
    };
  } catch (err) {
    console.warn('[IMF] companion refresh for stored proxy failed', err);
    return null;
  }
}

async function _rebuildStoredProxySession(session, { audioMode = '', audioMessage = '', cplLabel = '' } = {}) {
  const backend = String(session?.backend || _imfSourceBackend || '').trim();
  const activeCpl = _cplEntries.find(entry => entry?.key === _currentCplKey)?.cpl || _pkg?.cpl || null;
  let currentCplId = String(activeCpl?.id || session?.cplId || '').trim();
  let currentPackageId = String(_imfSourcePackageId || session?.packageId || '').trim();
  const folderPath = String(session?.folderPath || _imfSourceFolderPath || '').trim();
  const cplPath = String(session?.cplPath || '').trim();
  let currentCplLabel = String(cplLabel || session?.cplLabel || '').trim();
  let currentCplRelativePath = String(session?.cplRelativePath || '').trim();

  if (backend === 'companion' && folderPath) {
    const refreshed = await _refreshCompanionPackageFromSession({
      ...session,
      cplId: currentCplId,
      cplLabel: currentCplLabel,
      cplRelativePath: currentCplRelativePath,
    });
    if (refreshed) {
      currentPackageId = String(refreshed.packageId || currentPackageId || '').trim();
      currentCplId = String(refreshed.cplId || currentCplId || '').trim();
      currentCplLabel = String(refreshed.cplLabel || currentCplLabel || '').trim();
      currentCplRelativePath = String(refreshed.cplRelativePath || currentCplRelativePath || '').trim();
    }
  }

  if (backend === 'companion' && currentPackageId && currentCplId) {
    _setProxyTabState({ mode: 'running', pct: 0, status: 'Reconnecting proxy…', cpl: currentCplLabel || '—' });
    setImfLeftTab('transcode');
    return imfGenerateProxy(
      { backend: 'companion', packageId: currentPackageId, folderPath },
      { cplId: currentCplId, relativePath: currentCplRelativePath, name: currentCplLabel || '' },
      {
        onProgress: (pct) => { _setProxyTabState({ mode: 'running', pct, status: `Transcoding… ${pct}%`, cpl: currentCplLabel || '—' }); },
        onStatus: (txt) => { _setProxyTabState({ mode: 'running', pct: Number(($('imfProxyPanelPct')?.textContent || '0').replace(/[^\d.]/g, '')) || 0, status: txt, cpl: currentCplLabel || '—' }); },
      },
    );
  }

  if (folderPath && cplPath) {
    _setProxyTabState({ mode: 'running', pct: 0, status: 'Rebuilding proxy…', cpl: currentCplLabel || '—' });
    setImfLeftTab('transcode');
    return imfGenerateProxy(
      { backend: backend || 'legacy', folder: folderPath, folderPath },
      { path: cplPath, name: currentCplLabel || '' },
      {
        onProgress: (pct) => { _setProxyTabState({ mode: 'running', pct, status: `Transcoding… ${pct}%`, cpl: currentCplLabel || '—' }); },
        onStatus: (txt) => { _setProxyTabState({ mode: 'running', pct: Number(($('imfProxyPanelPct')?.textContent || '0').replace(/[^\d.]/g, '')) || 0, status: txt, cpl: currentCplLabel || '—' }); },
      },
    );
  }

  return null;
}

async function _tryRestoreProxySession() {
  if (_proxySessionRestoring || _proxyViewerReady) return;  // prevent concurrent/duplicate restores
  _proxyDebugMark('RESTORE_BOOT', 'Begin proxy restore attempt', { branch: 'RESTORE_BOOT', probe: 'starting' });
  _proxySessionRestoring = true;
  try {
    // ── Registry fast-path ─────────────────────────────────────────────────────
    // Try a content-addressable lookup BEFORE touching localStorage.  Works even
    // when (a) there is no stored session, (b) the session is stale/expired, or
    // (c) the package folder was moved.  Requires _pkg.cpl to be populated.
    if (_pkg?.cpl?.id && _imfSourceBackend === 'companion') {
      try {
        const _regCpl = _pkg.cpl;
        const _regVtf = (_regCpl.videoResources || []).map(r => r?.trackFileId).filter(Boolean);
        const _regAtf = (_regCpl.audioTracks   || []).map(t => t?.trackFileId).filter(Boolean);
        const _regTfIds = [...new Set([..._regVtf, ..._regAtf])];
        const _regHit = await imfLookupProxy(
          { backend: _imfSourceBackend, packageId: _imfSourcePackageId, folderPath: _imfSourceFolderPath },
          { cplId: _regCpl.id, trackFileIds: _regTfIds, totalFrames: _regCpl.totalFrames || 0, editRate: _regCpl.editRate || 0 },
        );
        if (_regHit?.found && _regHit?.proxyPath) {
          _proxyDebugMark('REGISTRY_HIT', 'Content-addressable proxy found', { fingerprint: _regHit.fingerprint, proxyPath: _regHit.proxyPath });
          _setProxyTabState({ mode: 'running', pct: 100, status: 'Restoring proxy from cache…', cpl: _regCpl.contentTitle || _regCpl.id || '—' });
          const _regRestored = await imfRestoreProxyOutput({
            outputPath: _regHit.proxyPath,
            folderPath: _imfSourceFolderPath || '',
            cplPath: '',
            audioMode: _regHit.audioMode || 'unknown',
            audioMessage: _regHit.audioMessage || '',
          });
          if (_regRestored?.videoUrl) {
            let _rv   = String(_regRestored.videoUrl || '').trim();
            let _rdv  = String(_regRestored.doviUrl  || '').trim();
            let _rsid = String(_regRestored.sessionId || '').trim();
            let _ram  = String(_regRestored.audioMode || _regHit.audioMode || 'unknown').trim();
            let _ramsg= String(_regRestored.audioMessage || _regHit.audioMessage || '').trim();
            let _rop  = String(_regRestored.outputPath || _regHit.proxyPath || '').trim();
            let _rpn  = String(_regRestored.proxyName  || _regHit.proxyName  || '').trim();
            let _rtc  = String(_regRestored.startTimecode || _regHit.startTimecode || '').trim();
            const _rfps = Number(_regHit.fps || _regCpl.editRate || 24) || 24;
            if (_regRestored.state === 'running' && _rsid) {
              try {
                const _rping = await imfPingCompanion();
                const _rport = Number(_rping?.port || 0) || 47125;
                _rv  = `http://127.0.0.1:${_rport}/stream/${_rsid}`;
                _rdv = `http://127.0.0.1:${_rport}/imf_dovi/${_rsid}`;
                const _rres = await _resumeStoredProxyJob({ sessionId: _rsid, port: _rport, audioMode: _ram, audioMessage: _ramsg });
                if (_rres?.videoUrl) {
                  _rv   = String(_rres.videoUrl        || _rv  ).trim();
                  _rdv  = String(_rres.doviUrl         || _rdv ).trim();
                  _ram  = String(_rres.audioMode       || _ram ).trim();
                  _ramsg= String(_rres.audioMessage    || _ramsg).trim();
                  _rop  = String(_rres.outputPath      || _rop ).trim();
                  _rpn  = String(_rres.proxyName       || _rpn ).trim();
                  _rtc  = String(_rres.startTimecode   || _rtc ).trim();
                  _rsid = String(_rres.sessionId       || _rsid).trim();
                }
              } catch {}
            }
            const _rpv = $('imfProxyVideo');
            if (_rpv) {
              if (_rdv) { try { const _d = await fetch(_rdv); if (_d.ok) _renderDoviMetafier(await _d.json()); } catch {} }
              _persistProxySessionSnapshot({
                backend: 'companion', packageId: _imfSourcePackageId || '',
                folderPath: _imfSourceFolderPath || '', cplId: _regCpl.id || '',
                cplPath: '', cplRelativePath: '',
                cplLabel: _regCpl.contentTitle || _regCpl.id || '',
                sessionId: _rsid, videoUrl: _rv, doviUrl: _rdv, fps: _rfps,
                audioMode: _ram, audioMessage: _ramsg, outputPath: _rop,
                proxyName: _rpn, startTimecode: _rtc,
              });
              await playerStartProxyMode(_rpv, _rv, _rdv, _rfps, _onDoviUpdate, { title: _rpn || _regCpl.contentTitle || 'Rec.709 Proxy', startTimecode: _rtc });
              if (_ram !== 'video_only') _attachWaveform(_rpv, _ram);
              const _rstop = $('imfProxyStopBtn'); if (_rstop) _rstop.style.display = '';
              const _rprog = $('imfProxyProgress'); if (_rprog) _rprog.style.display = 'none';
              setProxyViewerReady(true); setViewerMode('proxy');
              const _rlbl = _audioModeLabel(_ram);
              const _rstat = _ram === 'video_only' ? (_ramsg || 'Proxy QC active · video only') : (_ramsg || `Proxy QC active · ${_rlbl}`);
              _lastProxyInfo = { proxyPath: String(_rop || '').trim(), fingerprint: String(_regHit?.fingerprint || '').trim() };
              _setProxyTabState({ mode: 'done', pct: 100, status: _rstat, cpl: _rpn || _regCpl.contentTitle || '', proxyPath: String(_rop || '').trim(), fingerprint: String(_regHit?.fingerprint || '').trim() });
              setStatus('ok', _rstat); setImfLeftTab('transcode');
              _proxyDebugMark('REGISTRY_RESTORE_DONE', _rstat, { fingerprint: _regHit.fingerprint });
              return;  // ✓ registry fast-path succeeded
            }
          }
        }
      } catch (_regErr) {
        _proxyDebugMark('REGISTRY_MISS', 'Registry lookup failed or no hit', { error: String(_regErr?.message || _regErr) });
      }
    }
    // ── End registry fast-path ─────────────────────────────────────────────────

    const raw = _readStoredProxySession();
    if (!raw) return;

    let session;
    try { session = JSON.parse(raw); } catch { _proxyDebugMark('RESTORE_ABORT', 'Stored proxy session JSON invalid'); localStorage.removeItem('pfx_proxy_session'); return; }

    const currentFolder = String(_imfSourceFolderPath || '').trim();
    const currentPackageId = String(_imfSourcePackageId || '').trim();
    const sessionFolder = String(session?.folderPath || '').trim();
    const sessionPackageId = String(session?.packageId || '').trim();
    if ((currentFolder && sessionFolder && currentFolder !== sessionFolder) || (currentPackageId && sessionPackageId && currentPackageId !== sessionPackageId)) {
      _proxyDebugMark('RESTORE_ABORT', 'Stored proxy session belongs to a different IMF package', { branch: 'RESTORE_ABORT', probe: sessionFolder || sessionPackageId || 'mismatch' });
      return;
    }

    const backend = String(session?.backend || _imfSourceBackend || '').trim();
    const fps = Number(session?.fps || 24) || 24;
    let audioMode = String(session?.audioMode || '').trim();
    let audioMessage = String(session?.audioMessage || '').trim();
    const cplLabel = String(session?.cplLabel || '').trim();
    const savedAt = Number(session?.savedAt || 0) || 0;
    const folderPath = String(session?.folderPath || _imfSourceFolderPath || '').trim();
    let sessionId = String(session?.sessionId || _proxySessionIdFromUrl(session?.videoUrl) || '').trim();
    let restoreVideoUrl = String(session?.videoUrl || '').trim();
    let restoreDoviUrl = String(session?.doviUrl || '').trim();
    let outputPath = String(session?.outputPath || '').trim();
    let proxyName = String(session?.proxyName || '').trim();
    let startTimecode = String(session?.startTimecode || '').trim();

    if ((backend === 'companion' || _imfSourceBackend === 'companion') && folderPath) {
      const refreshed = await _refreshCompanionPackageFromSession(session);
      if (refreshed?.packageId) session.packageId = refreshed.packageId;
      if (refreshed?.cplId) session.cplId = refreshed.cplId;
      if (refreshed?.cplRelativePath) session.cplRelativePath = refreshed.cplRelativePath;
      if (refreshed?.cplLabel && !session.cplLabel) session.cplLabel = refreshed.cplLabel;
    }

    // Discard sessions older than 8 hours
    _proxyDebugMark('RESTORE_SESSION', 'Stored proxy session found', { sessionId, outputPath, probe: restoreVideoUrl ? 'videoUrl present' : (outputPath ? 'outputPath present' : 'session only') });
    if ((!restoreVideoUrl && !sessionId && !outputPath) || Date.now() - savedAt > 8 * 3600 * 1000) {
      _proxyDebugMark('RESTORE_ABORT', 'Stored proxy session missing stream/session/output or too old', { sessionId, outputPath });
      localStorage.removeItem('pfx_proxy_session');
      return;
    }

    // Refresh the companion HTTP endpoint after reload so stored /stream/<id>
    // URLs can be reached again even if the native host process restarted.
    let companionPort = 0;
    if ((backend === 'companion' || _imfSourceBackend === 'companion') && sessionId) {
      try {
        _proxyDebugMark('BRIDGE_PING', 'Refreshing companion endpoint after reload', { branch: 'RESUME_JOB', sessionId, outputPath });
        const ping = await imfPingCompanion();
        await _proxyDebugFetchBridgeState('after companion ping');
        companionPort = Number(ping?.port || 0) || 47125;
        restoreVideoUrl = `http://127.0.0.1:${companionPort}/stream/${sessionId}`;
        restoreDoviUrl = `http://127.0.0.1:${companionPort}/imf_dovi/${sessionId}`;
      } catch {}
    }

    let streamAlive = false;
    if ((backend === 'companion' || _imfSourceBackend === 'companion') && sessionId && companionPort) {
      _proxyDebugMark('RESUME_JOB', 'Attempt live job reattach', { branch: 'RESUME_JOB', sessionId, outputPath });
      const resumed = await _resumeStoredProxyJob({
        sessionId,
        port: companionPort,
        cplLabel,
        audioMode,
        audioMessage,
      });
      if (resumed?.videoUrl) {
        _proxyDebugMark('RESUME_JOB_OK', 'Live job returned stream URL', { branch: 'RESUME_JOB', sessionId: String(resumed.sessionId || sessionId || '').trim(), outputPath: String(resumed.outputPath || outputPath || '').trim() });
        sessionId = String(resumed.sessionId || sessionId || '').trim();
        restoreVideoUrl = String(resumed.videoUrl || restoreVideoUrl || '').trim();
        restoreDoviUrl = String(resumed.doviUrl || restoreDoviUrl || '').trim();
        audioMode = String(resumed.audioMode || audioMode || '').trim();
        audioMessage = String(resumed.audioMessage || audioMessage || '').trim();
        outputPath = String(resumed.outputPath || outputPath || '').trim();
        proxyName = String(resumed.proxyName || proxyName || '').trim();
        startTimecode = String(resumed.startTimecode || startTimecode || '').trim();
        streamAlive = await _probeProxyVideoUrl(restoreVideoUrl);
      }
    }
    if ((backend === 'companion' || _imfSourceBackend === 'companion') && outputPath) {
      try {
        _proxyDebugMark('RESTORE_CACHE', 'Attempt cached output restore', { branch: 'RESTORE_CACHE', sessionId, outputPath });
        _setProxyTabState({ mode: 'running', pct: 100, status: 'Restoring cached proxy…', cpl: cplLabel || '—' });
        const restored = await imfRestoreProxyOutput({
          outputPath,
          folderPath,
          cplPath: String(session?.cplPath || '').trim(),
          audioMode,
          audioMessage,
        });
        if (restored?.videoUrl) {
          _proxyDebugMark('RESTORE_CACHE_OK', 'Cached output reopened', { branch: 'RESTORE_CACHE', sessionId: String(restored.sessionId || sessionId || '').trim(), outputPath: String(restored.outputPath || outputPath || '').trim() });
          sessionId = String(restored.sessionId || '').trim() || sessionId;
          restoreVideoUrl = String(restored.videoUrl || '').trim() || restoreVideoUrl;
          restoreDoviUrl = String(restored.doviUrl || '').trim() || restoreDoviUrl;
          outputPath = String(restored.outputPath || outputPath || '').trim();
          proxyName = String(restored.proxyName || proxyName || '').trim();
          startTimecode = String(restored.startTimecode || startTimecode || '').trim();
          if (String(restored.state || '').trim() === 'running') {
            _proxyDebugMark('RESTORE_CACHE_RUNNING', 'Restored proxy job is still running', { branch: 'RESTORE_CACHE', sessionId, outputPath, probe: 'running' });
            const resumed = await _resumeStoredProxyJob({
              sessionId,
              port: companionPort || 47125,
              progressUrl: String(restored.progressUrl || '').trim(),
              cplLabel,
              audioMode,
              audioMessage,
            });
            if (resumed?.videoUrl) {
              sessionId = String(resumed.sessionId || sessionId || '').trim();
              restoreVideoUrl = String(resumed.videoUrl || restoreVideoUrl || '').trim();
              restoreDoviUrl = String(resumed.doviUrl || restoreDoviUrl || '').trim();
              outputPath = String(resumed.outputPath || outputPath || '').trim();
              proxyName = String(resumed.proxyName || proxyName || '').trim();
              startTimecode = String(resumed.startTimecode || startTimecode || '').trim();
              audioMode = String(resumed.audioMode || audioMode || '').trim();
              audioMessage = String(resumed.audioMessage || audioMessage || '').trim();
              streamAlive = await _probeProxyVideoUrl(restoreVideoUrl);
            }
          } else {
            streamAlive = await _probeProxyVideoUrl(restoreVideoUrl);
          }
        }
      } catch (err) {
        _proxyDebugMark('RESTORE_CACHE_FAIL', err?.message || String(err), { branch: 'RESTORE_CACHE', outputPath });
        console.warn('[IMF] cached proxy output restore failed', err);
      }
    }

    if (!streamAlive) streamAlive = await _probeProxyVideoUrl(restoreVideoUrl);
    _proxyDebugMark('STREAM_PROBE', streamAlive ? 'stream reachable' : 'stream not reachable', { probe: streamAlive ? 'alive' : 'dead', sessionId, outputPath });
    if (!streamAlive) {
      _proxyDebugMark('RESTORE_ABORT', 'Proxy stream dead on load — skipping auto-rebuild, showing reconnect prompt', { branch: 'RESTORE_ABORT', probe: 'dead' });
      _setProxyTabState({ mode: 'idle', pct: 0, status: 'Previous proxy session expired. Click "Generate Proxy" to rebuild.', cpl: cplLabel || '—' });
      _proxySessionRestoring = false;
      return;
    }

    // Stream is alive — reconnect
    const proxyV = $('imfProxyVideo');
    if (!proxyV) return;

    if (restoreDoviUrl) {
      try {
        const doviRes = await fetch(restoreDoviUrl);
        if (doviRes.ok) _renderDoviMetafier(await doviRes.json());
      } catch {}
    }

    _persistProxySessionSnapshot({
      ...session,
      backend: backend || session?.backend || '',
      packageId: _imfSourcePackageId || session?.packageId || '',
      folderPath: session?.folderPath || _imfSourceFolderPath || '',
      cplId: String(_pkg?.cpl?.id || session?.cplId || '').trim(),
      cplPath: session?.cplPath || '',
      cplRelativePath: session?.cplRelativePath || '',
      cplLabel: cplLabel || session?.cplLabel || '',
      sessionId: String(sessionId || _proxySessionIdFromUrl(restoreVideoUrl) || '').trim(),
      videoUrl: restoreVideoUrl,
      doviUrl: restoreDoviUrl,
      fps,
      audioMode: audioMode || session?.audioMode || 'unknown',
      audioMessage: audioMessage || session?.audioMessage || '',
      outputPath: String(outputPath || session?.outputPath || '').trim(),
      proxyName: String(proxyName || session?.proxyName || '').trim(),
      startTimecode: String(startTimecode || session?.startTimecode || '').trim(),
    });

    _proxyDebugMark('PLAYER_ATTACH', 'Attaching proxy player', { probe: restoreVideoUrl || 'no stream', sessionId: String(sessionId || '').trim(), outputPath: String(outputPath || '').trim() });
    await playerStartProxyMode(proxyV, restoreVideoUrl, restoreDoviUrl, fps, _onDoviUpdate, { title: proxyName || _pkg?.cpl?.contentTitle || cplLabel || 'Rec.709 Proxy', startTimecode });
    if (audioMode !== 'video_only') _attachWaveform(proxyV, audioMode);

    const stop      = $('imfProxyStopBtn');
    const delBtn    = $('imfProxyDeleteBtn');
    const prog      = $('imfProxyProgress');
    if (stop)   stop.style.display = '';
    if (prog)   prog.style.display = 'none';
    // Show Delete Proxy button and store path/fingerprint for it
    if (delBtn) {
      delBtn.style.display = '';
      delBtn.disabled = false;
      delBtn.textContent = '🗑 Delete Proxy';
    }
    _lastProxyInfo = {
      proxyPath: String(outputPath || '').trim(),
      fingerprint: String(_proxyDebug?.fingerprint || session?.fingerprint || '').trim(),
    };
    setProxyViewerReady(true);
    setViewerMode('proxy');
    const audioLabel = _audioModeLabel(audioMode);
    const status = audioMode === 'video_only'
      ? (audioMessage || 'Proxy QC active · video only')
      : (audioMessage || `Proxy QC active · ${audioLabel}`);
    _setProxyTabState({ mode: 'done', pct: 100, status, cpl: proxyName || cplLabel });
    setStatus('ok', status);
    setImfLeftTab('transcode');
    _proxyDebugMark('RESTORE_DONE', status, { branch: _proxyDebug.branch || 'DONE', probe: 'player attached' });
  } catch (e) {
    _proxyDebugMark('RESTORE_ERROR', e?.message || String(e), { branch: 'ERROR', probe: 'exception' });
    console.warn('[IMF] Could not restore proxy session:', e);
    localStorage.removeItem('pfx_proxy_session');
  } finally {
    _proxySessionRestoring = false;
  }
}

async function _runProxyQC(opts = {}) {
  const forceResolve = !!opts.forceResolve;
  const btn    = $('imfProxyBtn');
  const stop   = $('imfProxyStopBtn');
  const prog   = $('imfProxyProgress');
  const proxyV = $('imfProxyVideo');

  // Always clear any previous proxy session first so the viewer does not keep
  // showing a stale short proxy while a new full-CPL build finishes.
  playerStopProxyMode();
  if (proxyV) {
    try { proxyV.pause?.(); } catch {}
    try { proxyV.removeAttribute('src'); } catch {}
    try { proxyV.load?.(); } catch {}
    try { proxyV.currentTime = 0; } catch {}
  }

  if (btn)  btn.style.display  = 'none';
  if (prog) prog.style.display = '';
  if (forceResolve) {
    const resolveStatus = $('imfResolveStatus');
    if (resolveStatus) { resolveStatus.textContent = '● Rendering…'; resolveStatus.dataset.state = 'rendering'; }
  }
  _proxyDebugMark('NEW_PROXY_JOB', 'Manual Proxy QC start', { branch: 'NEW_PROXY_JOB', bridge: _proxyDebug.bridge || 'UNKNOWN', probe: 'manual start' });
  _setProxyTabState({ mode: 'running', pct: 0, status: 'Preparing loaded IMF package…', cpl: _pkg?.cpl?.contentTitle || _pkg?.cpl?.annotation || _pkg?.cpl?.id || 'Waiting for selection' });
  setImfLeftTab('transcode');

  try {
    // 1. Prefer the already loaded companion package. This keeps Generate one-click
    // after a package has been scanned and avoids reopening the folder picker.
    let picked = null;
    let cplChoice = null;
    if (_imfSourceBackend === 'companion' && _imfSourcePackageId && _pkg?.cpl?.id) {
      cplChoice = {
        cplId: String(_pkg.cpl.id || '').trim(),
        path: String(_pkg.cpl.absolutePath || _pkg.cpl.path || '').trim(),
        relativePath: String(_pkg.cpl.relativePath || '').trim(),
        contentTitle: String(_pkg.cpl.contentTitle || _pkg.cpl.annotation || _pkg.cpl.id || '').trim(),
        name: String(_pkg.cpl.name || _pkg.cpl.contentTitle || _pkg.cpl.id || 'CPL').trim(),
      };
      picked = {
        backend: 'companion',
        packageId: _imfSourcePackageId,
        folderPath: _imfSourceFolderPath,
        folder: _imfSourceFolderPath,
        cpls: [cplChoice],
      };
      _setProxyTabState({ mode: 'running', pct: 0, status: `CPL: ${cplChoice.contentTitle || cplChoice.name}`, cpl: cplChoice.contentTitle || cplChoice.name });
    } else {
      _setProxyTabState({ mode: 'running', pct: 0, status: 'Select IMF package folder…', cpl: 'Waiting for selection' });
      picked = await imfPickFolder();
      if (!picked) {
        _setProxyStatus('');
        if (btn) btn.style.display = '';
        if (prog) prog.style.display = 'none';
        _setProxyTabState({ mode: 'idle', pct: 0, status: 'Proxy QC cancelled', cpl: '—' });
        return;
      }
    }

    // Refresh the companion registration just before submit. The native host is
    // allowed to restart, which invalidates old packageId values kept in UI state.
    if (picked?.backend === 'companion' && (picked.folderPath || _imfSourceFolderPath)) {
      const refreshFolder = String(picked.folderPath || _imfSourceFolderPath || '').trim();
      try {
        _setProxyTabState({ mode: 'running', pct: 0, status: 'Refreshing IMF package registration…', cpl: cplChoice?.contentTitle || cplChoice?.name || '—' });
        const refreshed = await imfScanFolderCompanion(refreshFolder);
        if (refreshed?.packageId) {
          picked = { ...picked, ...refreshed, folderPath: refreshed.folderPath || refreshed.folder || refreshFolder, folder: refreshed.folder || refreshed.folderPath || refreshFolder };
          _imfSourceBackend = 'companion';
          _imfSourceFolderPath = String(picked.folderPath || picked.folder || refreshFolder).trim();
          _imfSourcePackageId = String(refreshed.packageId || '').trim();
          try { localStorage.setItem('pfx_imf_source_session', JSON.stringify({ backend: 'companion', folderPath: _imfSourceFolderPath, packageId: _imfSourcePackageId, savedAt: Date.now() })); } catch {}

          const selectedCplId = String(cplChoice?.cplId || _pkg?.cpl?.id || '').trim();
          const refreshedCpls = Array.isArray(refreshed.cpls) ? refreshed.cpls : [];
          const refreshedChoice = refreshedCpls.find(c => String(c.cplId || '').trim() === selectedCplId) || (refreshedCpls.length === 1 ? refreshedCpls[0] : null);
          if (refreshedChoice) cplChoice = { ...cplChoice, ...refreshedChoice };
        }
      } catch (refreshErr) {
        console.warn('[IMF] companion package refresh before proxy failed', refreshErr);
      }
    }

    // 2. CPL selection — auto-select if only one, else prompt
    if (!cplChoice && picked.cpls.length === 0) {
      throw new Error('No CPL.xml found in selected folder');
    } else if (!cplChoice && picked.cpls.length === 1) {
      cplChoice = picked.cpls[0];
      _setProxyTabState({ mode: 'running', pct: 0, status: `CPL: ${picked.cpls[0].contentTitle || picked.cpls[0].name}`, cpl: picked.cpls[0].contentTitle || picked.cpls[0].name });
    } else if (!cplChoice) {
      // Build a quick in-page picker
      const names = picked.cpls.map(c => c.name).join('\n• ');
      const choice = picked.cpls.find(c =>
        c.name === window.prompt(`Multiple CPLs found:\n• ${names}\n\nEnter CPL filename to use:`, picked.cpls[0].name)
      );
      if (!choice) {
        _setProxyStatus('');
        if (btn) btn.style.display = '';
        if (prog) prog.style.display = 'none';
        _setProxyTabState({ mode: 'idle', pct: 0, status: 'Proxy QC cancelled', cpl: '—' });
        return;
      }
      cplChoice = choice;
      _setProxyTabState({ mode: 'running', pct: 0, status: `CPL: ${choice.contentTitle || choice.name}`, cpl: choice.contentTitle || choice.name });
    }

    // 3. Eagerly populate source vars so the parallel IAB decode can reference the package
    //    before the proxy onStart callback fires (which sets the same vars later).
    if (!_imfSourceBackend && picked.backend)    _imfSourceBackend   = picked.backend;
    if (!_imfSourceFolderPath && (picked.folderPath || picked.folder))
      _imfSourceFolderPath = String(picked.folderPath || picked.folder || '').trim();
    if (!_imfSourcePackageId && picked.packageId) _imfSourcePackageId = picked.packageId;

    // Auto-trigger IAB decode in parallel — only when the loaded CPL has an IAB track.
    // If companion unavailable or no IAB, _runIabDecode() exits silently with idle state.
    if (_pkg?.cpl?.hasIAB) _runIabDecode().catch(() => {});

    // 4. Transcode
    const fps = _pkg?.cpl?.editRate || 24;
    const { sessionId, videoUrl, doviUrl, audioMode, audioMessage, immersiveAudio, outputPath, proxyName, startTimecode } = await imfGenerateProxy(picked, cplChoice, {
      onStart: (started) => {
        _proxyDebugMark('NEW_PROXY_SESSION', 'Proxy job accepted by companion/helper', {
          branch: 'NEW_PROXY_JOB',
          sessionId: String(started?.sessionId || '').trim(),
          outputPath: String(started?.outputPath || '').trim(),
          proxyName: String(started?.proxyName || cplChoice?.contentTitle || cplChoice?.name || '').trim(),
          startTimecode: String(started?.startTimecode || '').trim(),
        });
        _proxyDebugFetchBridgeState('after startProxyPlayback');
        _persistProxySessionSnapshot({
          backend: picked?.backend || _imfSourceBackend || '',
          packageId: picked?.packageId || _imfSourcePackageId || '',
          folderPath: picked?.folderPath || picked?.folder || _imfSourceFolderPath || '',
          cplId: cplChoice?.cplId || String(_pkg?.cpl?.id || '').trim(),
          cplPath: cplChoice?.path || '',
          cplRelativePath: cplChoice?.relativePath || '',
          cplLabel: cplChoice?.contentTitle || cplChoice?.name || '',
          sessionId: String(started?.sessionId || '').trim(),
          videoUrl: String(started?.videoUrl || '').trim(),
          doviUrl: String(started?.doviUrl || '').trim(),
          fps,
          audioMode: String(started?.audioMode || 'unknown').trim(),
          audioMessage: String(started?.audioMessage || '').trim(),
          outputPath: String(started?.outputPath || '').trim(),
          proxyName: String(started?.proxyName || cplChoice?.contentTitle || cplChoice?.name || '').trim(),
          startTimecode: String(started?.startTimecode || '').trim(),
        });
      },
      onProgress: (pct) => { _setProxyTabState({ mode: 'running', pct, status: `Transcoding… ${pct}%` }); },
      onStatus:   (txt) => { _setProxyTabState({ mode: 'running', pct: Number(($('imfProxyPanelPct')?.textContent || '0').replace(/[^\d.]/g, '')) || 0, status: txt }); },
      forceResolve,
      // Pass stored proxy quality preference so companion uses it
      proxyQuality: (() => { try { return localStorage.getItem('pfx_imf_proxy_quality') || ''; } catch { return ''; } })() || undefined,
    });

    if (immersiveAudio) {
      _iabDecodeCaps = _normalizeIabDecodeCaps(immersiveAudio, _iabDecodeCaps.backend || 'companion');
      renderKPI();
      renderLabelQC();
      _refreshValidationResults();
    }

    _setProxyTabState({ mode: 'done', pct: 100, status: 'Starting playback…' });

    // 4. Fetch DoVi structured data for Metafier (companion returns { shots, shotCount, … })
    if (doviUrl) {
      try {
        const doviRes = await fetch(doviUrl);
        if (doviRes.ok) _renderDoviMetafier(await doviRes.json());
      } catch (e) {
        console.warn('[IMF] Metafier: could not fetch DoVi data:', e);
      }
    }

    // 5. Hand off to player
    if (proxyV) await playerStartProxyMode(proxyV, videoUrl, doviUrl, fps, _onDoviUpdate, { title: proxyName || cplChoice?.contentTitle || cplChoice?.name || 'Rec.709 Proxy', startTimecode });

    // 6. Waveform strip
    if (proxyV && audioMode !== 'video_only') _attachWaveform(proxyV, audioMode);

    // Persist session so reload can reconnect
    _persistProxySessionSnapshot({
      backend: picked?.backend || _imfSourceBackend || '',
      packageId: picked?.packageId || _imfSourcePackageId || '',
      folderPath: picked?.folderPath || picked?.folder || _imfSourceFolderPath || '',
      cplId: cplChoice?.cplId || String(_pkg?.cpl?.id || '').trim(),
      cplPath: cplChoice?.path || '',
      cplRelativePath: cplChoice?.relativePath || '',
      cplLabel: cplChoice?.contentTitle || cplChoice?.name || '',
      sessionId: String(sessionId || _proxySessionIdFromUrl(videoUrl) || '').trim(),
      videoUrl, doviUrl, fps,
      audioMode: audioMode || 'unknown',
      audioMessage: audioMessage || '',
      outputPath: String(outputPath || '').trim(),
      proxyName: String(proxyName || cplChoice?.contentTitle || cplChoice?.name || '').trim(),
      startTimecode: String(startTimecode || '').trim(),
    });

    if (stop) stop.style.display = '';
    if (prog) prog.style.display = 'none';
    setProxyViewerReady(true);
    setViewerMode('proxy');
    const audioLabel = _audioModeLabel(audioMode);
    const finalProxyStatus = audioMode === 'video_only'
      ? (audioMessage || 'Proxy QC active · video only')
      : (audioMessage || `Proxy QC active · ${audioLabel}`);
    _lastProxyInfo = { proxyPath: String(outputPath || '').trim(), fingerprint: '' };
    _setProxyTabState({ mode: 'done', pct: 100, status: finalProxyStatus, cpl: proxyName || cplChoice?.contentTitle || cplChoice?.name || '—', proxyPath: String(outputPath || '').trim() });
    setStatus(audioMode === 'video_only' ? 'warn' : 'ok', finalProxyStatus);

  } catch (e) {
    const msg = String(e?.message || '');
    console.error('[IMF Proxy] Error:', msg);
    const hint = msg.includes('NO_VIDEO_MXF_FOUND') || msg.includes('Video MXFs not found')
                   ? 'Video MXF files not found — if this is a VF/supplemental package, make sure the OV package folder is also accessible on disk'
               : msg.includes('NO_VIDEO_IN_CPL')
                   ? 'CPL contains no video resources'
               : msg.includes('ffmpeg_missing')  ? 'ffmpeg not found on this machine'
               : msg.includes('host_unavailable') ? 'Native helper not available (Browser Mode only)'
               : msg.includes('host_timeout')     ? 'Helper timed out — try again'
               : msg.includes('Dolby Atmos / IAB audio is not decodable') ? 'Proxy audio decode failed: this ffmpeg build cannot decode Dolby Atmos / IAB'
               : `Proxy failed: ${msg.split('\n')[0].slice(0, 160)}`;
    _setProxyTabState({ mode: 'error', pct: 0, status: hint });
    if (btn) btn.style.display = '';
    setStatus('warn', hint);
    setImfLeftTab('transcode');
    setTimeout(() => {
      if (prog) prog.style.display = 'none';
    }, 6000);
  }
}

// ── Settings pre-fill on startup ──────────────────────────────────────────────
// Run after DOM is ready so Settings page inputs are populated even if the user
// goes to Settings before ever opening the IMF Validation tab.
if (typeof document !== 'undefined') {
  const _prefillSettings = () => {
    const mp = document.getElementById('settingsMetafierPath');
    if (mp) mp.value = _loadMetafierPath();
    const mc = document.getElementById('settingsMetafierCmd');
    if (mc) { try { mc.value = localStorage.getItem('pfx_dovi_metafier_cmd') || ''; } catch {} }
    const pq = document.getElementById('imfProxyQualitySelect');
    if (pq) { try { pq.value = localStorage.getItem('pfx_imf_proxy_quality') || 'turbo'; } catch {} }
    const rr = document.getElementById('settingsRelinkImfRootStatus');
    if (rr) { try { const r = localStorage.getItem('pfx_imf_native_root') || ''; if (r) rr.textContent = r; } catch {} }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _prefillSettings);
  } else {
    _prefillSettings();
  }
}

// ── NLE redesign: top tab nav ─────────────────────────────────────────────────
function _wireTopTabNav() {
  const nav = document.getElementById('imfTabNav');
  if (!nav) return;
  nav.addEventListener('click', e => {
    const btn = e.target.closest('.imf-nav-tab');
    if (!btn) return;
    nav.querySelectorAll('.imf-nav-tab').forEach(b => b.classList.remove('imf-nav-tab-active'));
    btn.classList.add('imf-nav-tab-active');
    const tab = btn.dataset.imftab;

    // IAB layout swap — swap player+scopes for IAB panels
    const iabMain   = document.getElementById('imfIabMain');
    const iabRight  = document.getElementById('imfIabRightPanel');
    const player    = document.getElementById('imfPlayer');
    const scopeWrap = document.getElementById('imfScopeRightWrap');
    const scopeTabs = document.querySelector('.imf-scope-mode-tabs');
    const rightMeta = document.querySelector('.imf-right-meta');
    const isIab = tab === 'iab';
    const panel = document.getElementById('imfPanelMain');
    if (panel) panel.classList.toggle('imf-iab-immersive-mode', isIab);
    if (iabMain)   iabMain.style.display   = isIab ? 'grid' : 'none';
    if (iabRight)  iabRight.style.display  = isIab ? 'flex' : 'none';
    if (player)    player.style.display    = isIab ? 'none' : '';
    if (scopeWrap) scopeWrap.style.display = isIab ? 'none' : '';
    if (scopeTabs) scopeTabs.style.display = isIab ? 'none' : '';
    if (rightMeta) rightMeta.style.display = isIab ? 'none' : '';

    const legacyLeft = document.getElementById('imfLegacyLeft');
    const newSections = ['imfSecPackages','imfSecCpls','imfSecAssets'];
    const useNew = (tab === 'playback' || tab === 'packages' || tab === 'iab');
    newSections.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.display = useNew ? '' : 'none';
    });
    if (legacyLeft) legacyLeft.style.display = useNew ? 'none' : '';
    if (!useNew) {
      const ltabBtn = document.querySelector(`[data-ltab="${tab}"]`);
      if (ltabBtn) ltabBtn.click();
    } else if (isIab) {
      _renderIabCurrentSkeleton();
      const inspectBtn = document.getElementById('imfIabInspectBtn');
      const body = document.getElementById('imfIabTrackBody');
      if (inspectBtn && _pkg?.cpl?.hasIAB && body?.dataset.loaded !== 'inspected') {
        setTimeout(() => inspectBtn.click(), 0);
      }
    }
  });
}

// ── NLE redesign: asset type tab filter ──────────────────────────────────────
function _wireAssetTypeTabs() {
  const tabs = document.getElementById('imfAssetTypeTabs');
  if (!tabs) return;
  tabs.addEventListener('click', e => {
    const btn = e.target.closest('.imf-asset-ttab');
    if (!btn) return;
    tabs.querySelectorAll('.imf-asset-ttab').forEach(b => b.classList.remove('imf-asset-ttab-active'));
    btn.classList.add('imf-asset-ttab-active');
    const atype = btn.dataset.atype;
    const tbody = document.getElementById('imfAssetTbody');
    if (!tbody) return;
    tbody.querySelectorAll('tr[data-atype]').forEach(row => {
      row.style.display = (atype === 'all' || row.dataset.atype === atype) ? '' : 'none';
    });
  });
}

// ── NLE redesign: scope mode tabs in right column ────────────────────────────
function _wireScopeModeTabsRight() {
  const wrap = document.getElementById('imfScopeRightWrap');
  if (!wrap) return;
  wrap.addEventListener('click', e => {
    const btn = e.target.closest('.imf-smt');
    if (!btn) return;
    wrap.querySelectorAll('.imf-smt').forEach(b => b.classList.remove('imf-smt-active'));
    btn.classList.add('imf-smt-active');
    // Map to existing scope stab
    const smt = btn.dataset.smt;
    const stab = document.querySelector(`.imf-stab[data-stab="${smt}"]`);
    if (stab) stab.click();
  });
}

// ── NLE redesign: metadata panel tabs ────────────────────────────────────────
function _wireMetaTabs() {
  const panel = document.getElementById('imfRightMeta');
  if (!panel) return;
  panel.addEventListener('click', e => {
    const btn = e.target.closest('.imf-meta-tab');
    if (!btn) return;
    panel.querySelectorAll('.imf-meta-tab').forEach(b => b.classList.remove('imf-meta-tab-active'));
    btn.classList.add('imf-meta-tab-active');
  });
}

// ── NLE redesign: move scope panel into right column slot ────────────────────
function _initScopeLayout() {
  const panel = document.getElementById('imfScopePanel');
  const slot  = document.getElementById('imfScopeRightSlot');
  if (panel && slot && !slot.contains(panel)) {
    slot.appendChild(panel);
  }
}

// ── NLE redesign: populate pkg header bar ────────────────────────────────────
export function _updatePkgHeaderBar(pkg) {
  if (!pkg) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
  set('imfPkgHdrName', pkg.name || pkg.packageId);
  set('imfPkgHdrPath', pkg.path);
  set('imfPkgHdrOpl',  pkg.opl);
  set('imfPkgHdrHash', pkg.hash ? pkg.hash.slice(0, 16) + '…' : '');
  set('imfPkgHdrSize', pkg.sizeStr);
  set('imfPkgHdrMod',  pkg.modifiedStr);
  set('imfPkgHdrRes',  pkg.resolution);
  set('imfPkgHdrFps',  pkg.fps);
  set('imfPkgHdrDur',  pkg.durationStr);
  const validChip = document.getElementById('imfPkgHdrValid');
  if (validChip) validChip.style.display = pkg.valid ? '' : 'none';
}

// ── NLE redesign: populate right metadata sidebar ────────────────────────────
export function _updateMetaSidebar(asset) {
  if (!asset) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
  set('imfMetaAssetId',    asset.id);
  set('imfMetaType',       asset.type);
  set('imfMetaDuration',   asset.durationStr);
  set('imfMetaEditRate',   asset.editRate);
  set('imfMetaFrameSize',  asset.frameSize);
  set('imfMetaAspect',     asset.aspect);
  set('imfMetaColorPrim',  asset.colorPrimaries);
  set('imfMetaTransfer',   asset.transfer);
  set('imfMetaMatrix',     asset.matrix);
  set('imfMetaRange',      asset.range);
  set('imfMetaBitDepth',   asset.bitDepth);
  set('imfMetaCodec',      asset.codec);
  set('imfMetaAudioLayout',asset.audioLayout);
  set('imfMetaAudioCh',    asset.audioChannels);
  set('imfMetaAudioSr',    asset.sampleRate);
  set('imfMetaAudioBd',    asset.audioBitDepth);
  set('imfMetaLoudness',   asset.loudness);
}

// ── NLE redesign: update viewer chips ────────────────────────────────────────
export function _updateViewerChips(info) {
  if (!info) return;
  const set = (id, val, show) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (val != null) el.textContent = val;
    if (show != null) el.style.display = show ? '' : 'none';
  };
  set('imfVchipRes',        info.resolution);
  set('imfVchipAspect',     info.aspect);
  set('imfVchipColor',      info.colorSpace);
  set('imfVchipEngine',     info.engine);
  set('imfVchipDv',         info.dvLabel,  !!info.dvLabel);
  set('imfVchipIab',        info.iabLabel, !!info.iabLabel);
  set('imfVchipAudio',      info.audio);
  set('imfVchipRange',      info.range);
  set('imfVchipColorSpace', info.transfer);
}

// ── NLE redesign: update status bar ──────────────────────────────────────────
// C-RT1e: the Decode HUD was hardcoded to "Hardware (VideoToolbox)" — wrong for
// J2K/HTJ2K IMF, which has NO GPU/VideoToolbox decode on Apple Silicon (CPU only).
// Derive the real decoder + renderer from the CPL codec so the HUD tells the truth.
function _refreshImfStatusBar(cpl) {
  if (!cpl) return;
  const codec = String(cpl.codec || '').toLowerCase();
  const pd    = cpl.picDesc || {};
  const isHT  = !!pd.isHTJ2K || /part\s*15|htj2k/.test(codec);
  const isJ2K = !!pd.isJ2K || isHT || /j(peg)?\s*2000|jpeg2000|\bj2k\b/.test(codec);
  const isVT  = /prores|h\.?264|\bavc\b|hevc|h\.?265/.test(codec);
  let decode, renderer = 'Direct (MJPEG)';
  if (isJ2K)      decode = isHT ? 'CPU · HTJ2K (OpenJPH / FFmpeg)' : 'CPU · J2K (FFmpeg)';
  else if (isVT) { decode = 'Hardware (VideoToolbox)'; renderer = 'AVFoundation'; }
  else            decode = cpl.codec || '—';
  _updateStatusBar({ renderer, decode, status: 'Idle' });
}

export function _updateStatusBar(state) {
  if (!state) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val || '—'; };
  set('imfSbRenderer', state.renderer);
  set('imfSbDecode',   state.decode);
  set('imfSbStatus',   state.status);
  const dot = document.getElementById('imfEngineStatusDot');
  const lbl = document.getElementById('imfEngineStatusLabel');
  if (dot) dot.className = 'imf-sb-dot ' + (state.connected ? 'imf-sb-dot-green' : 'imf-sb-dot-red');
  if (lbl) lbl.textContent = state.connected ? 'Connected' : 'Disconnected';
}
