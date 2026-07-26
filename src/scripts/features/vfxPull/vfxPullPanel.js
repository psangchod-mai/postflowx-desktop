/**
 * vfxPullPanel.js
 * Main controller for the VFX Pull Mode card (#pmVfxPullCard) in the Pull Prep left sidebar.
 * PostFlowX — Chrome MV3 Extension, VFX post-production tooling.
 */

import { matchAllEvents, matchOcfToEvent, matchSummary, MATCH_STATUS, suggestReelAliases } from '../../smart/smartOcfMatcher.js';
import { validatePullList, ISSUE as PULL_ISSUE } from '../../modules/pullValidator.js';
import { buildAllExrJobs } from '../../smart/smartExrPullPlanner.js';
import { buildShotsCSV, buildJobsJSON, buildQCTextReport, buildNukeHandoffScript } from '../../smart/smartExrReportExporter.js';
import { buildPackagePaths } from './packagePaths.js';
import { buildFDL, buildFDLJson, buildFDLCsv, buildFDLTxt } from './fdlGenerator.js';
import { buildVfxPullAmf, resolveIdtUrn } from './amfVfxPullGenerator.js';
import { buildQcReportHtml, buildQcReportJson, computeQcBlocks, buildContactSheetHtml } from './vfxPullQcReport.js';
import { nativePickOcfFolder, nativeProbeOcfFolder, nativeProbeOcfFile, nativeOpenOutputFolder, nativePickFolder, nativePickMediaFile, nativeGrabThumbnailAtTimecode, nativeCopyExrDelivery, nativeRenderPullExrStart, nativeRenderPullExrStatus, nativeRenderPullExrCancel, nativeRenderReviewProxyStart, nativeAces2OutputTransforms, nativeQcExrSequence, nativeWritePullSidecars, nativeResolveStartBackground, nativeResolveProbeClips, nativeOcfExtractFrameToFile, nativeOcfExtractProxyMov, sharedMediaOpen, sharedMediaClose } from '../../modules/native_helper_client.js';
import { detectLetterboxPillarbox, computeReformatParams, estimateCDL, buildFrameFingerprint, findBestFrameOffset, compareFingerprints, pickVisualMatch } from './referenceMatchEngine.js';
import { tcToFrames as _tcToFrames, framesToTC as _framesToTC } from '../../modules/utils_time.js';
import { shotRiskScore } from './triageScore.js';
import { buildNukeScript } from './nukeScript.js';
import { buildAeScript } from './aeScript.js';
import { buildFrameMapJSON, buildFrameMapRows } from './pullJobModel.js';
import { buildIdtBadgeHtml } from './idtBadge.js';
import { mountMediaSearch } from '../mediaSearch/mediaSearchBox.js';
import { loadOcfFilesFromLibrary, libraryCount } from './dbLibrarySource.js';
import { decodeWithRetry, isTimeout, runDecodeChain } from '../../modules/mediaDecode.js';
import { createBridgeMonitor } from '../../modules/bridgeHealth.js';
import { nativeHelperPing } from '../../modules/native_helper_client.js';
import { friendlyStatus } from '../../core/friendlyError.js';

// ---------------------------------------------------------------------------
// Native companion helpers (direct chrome.runtime.sendMessage wrappers)
// ---------------------------------------------------------------------------

async function _sendCompanionAction(action, payload = {}, timeoutMs = 60000) {
  const req = { action, ...payload };
  const bridged = await chrome.runtime.sendMessage({ type: 'IMF_COMPANION_CALL', payload: req, timeoutMs });
  if (bridged?.ok && bridged.response) return bridged.response;
  const err = bridged?.error || {};
  const e = new Error(err.message || 'Companion error');
  e.code = err.code || '';
  throw e;
}

async function nativeOcfExtractFrame(filePath, timecode, opts = {}) {
  const payload = {
    filePath,
    timecode,
    // OCF free-run start TC + fps so the ffmpeg tier can seek RELATIVE to the
    // clip's own timecode (timecode − sourceStartTc) instead of absolute-from-zero.
    sourceStartTc: opts.sourceStartTc || '',
    fps: opts.fps || 0,
    width:  opts.width  || 640,
    height: opts.height || 360,
    format: opts.format || 'jpg',
  };
  if (opts.forceFfmpeg) payload.forceFfmpeg = true;
  return _sendCompanionAction('ocfExtractFrame', payload, 30000);
}

// Tier-1 dedicated Resolve Engine still — called by _pmGetOcfStillPreview.
async function _nativeOcfResolveStill(ocfPath, sourceTc, opts = {}) {
  const payload = {
    ocfPath,
    sourceTc,
    outputWidth:  opts.width  || 960,
    outputHeight: opts.height || 0,
    format: 'jpg',
  };
  if (opts.sourceFrame != null) payload.sourceFrame = opts.sourceFrame;
  return _sendCompanionAction('vfx.preview.resolveStill', {
    ...payload,
    // Must exceed the companion's worst-case render (render-queue fallback polls
    // up to ~120s + import/seek/settle); a shorter timeout aborts a WORKING
    // render and surfaces a misleading "needs Resolve".
  }, 150000);
}

// Batch Resolve strip — renders the HdlSt→HdlEnd range ONCE and extracts every
// position from it (the 7× perf fix). Returns { ok, frames:[{label, frame, dataUrl}] }.
// picks: [{label, sourceTc?|frame?}]. Long timeout: one range render of a clip.
async function _nativeOcfResolveStillBatch(ocfPath, picks, opts = {}) {
  return _sendCompanionAction('vfx.preview.resolveStillBatch', {
    ocfPath,
    outputWidth: opts.width || 480,
    // OCF's own start TC (matcher's clock) so the batch seek subtracts the same
    // base as the per-frame path instead of the possibly-different embedded Start TC.
    sourceStartTc: opts.sourceStartTc || '',
    picks: picks || [],
  }, 200000);
}
window._pmVfxResolveStillBatch = _nativeOcfResolveStillBatch;

// Direct Resolve still — bypasses the 3-tier cache and orchestration.
// Used by the diagnostic "Test Resolve Still" button so failures report the exact stage.
async function _nativeOcfExtractStillFrameDirect({ ocfPath, sourceTc, sourceFrame, outputWidth = 960,
    shotId = '', shotName = '', colorPreviewMode = 'rec709' } = {}) {
  return _sendCompanionAction('resolve.extractStillFrame', {
    ocfPath, sourceTc, sourceFrame, outputWidth,
    outputHeight: 0, format: 'jpg',
    shotId, shotName, colorPreviewMode,
  }, 120000);
}
window._pmVfxExtractStillDirect = _nativeOcfExtractStillFrameDirect;

// Capabilities check — cached per session. Returns {resolveExtractStillFrame, ffmpegFallback, ...} or null.
let _helperCapCache = null;
async function _checkHelperCapabilities() {
  if (_helperCapCache) return _helperCapCache;
  try {
    const res = await _sendCompanionAction('helper.capabilities', {}, 8000);
    _helperCapCache = (res?.data ?? res)?.capabilities || null;
  } catch (_) {
    // Older helper that doesn't support helper.capabilities — treat as outdated.
    _helperCapCache = { resolveExtractStillFrame: false, ffmpegFallback: false, resolveConnected: false };
  }
  return _helperCapCache;
}
window._pmCheckHelperCapabilities = _checkHelperCapabilities;

// Tier-2 dedicated AVFoundation / QuickLook still — called by _pmGetOcfStillPreview.
// Pass sourceTc + the OCF's free-run start TC so the companion can seek to the
// matched frame (relative to clip start) instead of returning the poster/slate.
async function _nativeOcfAvfStill(ocfPath, opts = {}) {
  return _sendCompanionAction('vfx.preview.avfStill', {
    ocfPath,
    sourceTc: opts.sourceTc || '',
    sourceStartTc: opts.sourceStartTc || '',
    fps: opts.fps || 0,
    outputWidth: opts.width || 640,
  }, 25000);
}

async function nativeOcfWriteFiles(outputDir, files) {
  return _sendCompanionAction('ocfWriteFiles', { outputDir, files }, 60000);
}

// ---------------------------------------------------------------------------
// Native response unwrap helpers
// ---------------------------------------------------------------------------

function _nativePayload(res) {
  return res?.result ?? res?.data ?? res?.files ?? res;
}

function _extractOcfFiles(res) {
  const payload = _nativePayload(res);
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.files)) return payload.files;
  return [];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const _LS_KEY = 'pfx.vfxPull.v1';

let _state = {
  ocfFolder: null,
  ocfFiles: [],
  matchResults: [],
  jobs: [],
  fdls: [],
  amfXmls: [],
  qcShots: [],
  manualLinks: {},            // { [eventKey]: { path, ocf, match, linkedAt } }
  resolveConnected:   false,  // true when Resolve is live during analysis
  resolveReconnected: false,  // true when OCF relink in Resolve succeeded
  selectedJobs: new Set(),    // indices of jobs selected for export; all selected by default
};

let _settings = {
  handles: 8,
  frameStart: 1001,
  plateFormat: 'exr_aces',
  pullMode: 'ocf_native',
  odtId: 'rec709_sdr',          // ACES 2.0 output transform for Review Proxy
  renderEngine: 'auto',
  matchMethods: ['timecode', 'reel', 'clipname', 'duration'],
  outputFolder: '',
  // Reel aliases: editorial reel name → camera reel (e.g. {"REEL_A":"A001"}).
  // Lets renamed reels match their camera originals. Persisted with settings.
  reelAliases: {},
  // ── Smart workflow settings (spec items 6, 8-10) ──
  // Target plate resolution. UHD by default — overridable via the panel.
  targetResolution: '3840x2160',
  // QT reference colour space (display-referred). Used for the preview frame
  // grab + AMF outputTransform tag. The EXR plate stays in ACES2065-1.
  qtReferenceColorSpace: 'Rec709',
  // OCF working / output colour space for the plate.
  ocfWorkingColorSpace: 'ACES2065-1',
  // Match mode for the QT-ref vs OCF colour comparison. 'preview' = report
  // CDL into AMF lookTransform applied="false". 'baked' = (future, opt-in)
  // applies CDL to a Rec709 preview export only.
  colorMatchMode: 'preview',
  // Bake speed/reframe into the EXR sequence by default — the user opts out
  // only when they explicitly want source frames + a separate sidecar map.
  bakeSpeed:   true,
  bakeReframe: true,
  // Sidecar generation toggles.
  generateAmf:         true,
  generateFdl:         true,
  generateNukeHandoff: true,
  // Export Mode: 'aces_plate' (default) | 'rec709_preview' | 'sidecar_only'.
  exportMode: 'aces_plate',
};

// OCF probe cache — avoids re-scanning an unchanged folder on every analysis
// run (e.g. when only handles or frameStart changed). Keyed by folder path;
// invalidated automatically when the folder path changes.
const _ocfProbeCache = { path: null, result: null };

// Read the current project's naming template chip values from localStorage.
// These are injected into buildAllExrJobs so that plate names follow the
// Netflix VFX plate naming spec: SHOW_EP_SCENE_SHOT_PLATEID_VERSION.
function _readProjectNaming() {
  const get = k => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const plateCode = get('pfx_sm_plate_code_val');
  const plateNum  = get('pfx_sm_plate_num_val');
  return {
    show:      get('pfx_sm_show_val').toUpperCase(),
    ep:        get('pfx_sm_sq_val'),
    scene:     get('pfx_sm_scene_val'),
    plateCode,
    plateNum,
    // Full plate ID only when both code and number are set (e.g. "BG01")
    plateId:   plateCode && plateNum ? `${plateCode.toUpperCase()}${String(plateNum).padStart(2, '0')}` : null,
    ver:       get('pfx_sm_ver_val'),
  };
}

// ---------------------------------------------------------------------------
// normalizeVfxPullRow — flatten matchAllEvents row + planner job into the
// shape every downstream sidecar generator (FDL / AMF / QC / CSV / Nuke)
// reads. matchAllEvents returns {event, match, ocf}; planner returns jobs
// with shotId/metadata/sourcePath. Without this shim, consumers read paths
// like matchResult.filePath that simply don't exist on the real object —
// leading to blank shotName/clipName fields in the package.
// ---------------------------------------------------------------------------
export function normalizeVfxPullRow(result, job) {
  const event = result?.event || {};
  const match = result?.match || {};
  const ocf   = result?.ocf   || {};

  return {
    event,
    match,
    ocf,
    shotName:
      job?.shotId ||
      job?.metadata?.shotName ||
      event.shotName ||
      event.reel ||
      event.clipName ||
      '',
    clipName: event.srcFile || event.clipName || ocf.name || '',
    sourcePath:
      match.matchedPath ||
      job?.sourcePath ||
      ocf.path ||
      '',
    tcIn:  event.srcIn || job?.sourceIn  || '',
    tcOut: event.srcOut || job?.sourceOut || '',
    recIn: event.recIn  || '',
    recOut: event.recOut || '',
    confidence: Number(match.confidence) || 0,
    status:     match.status || 'MISSING',
    warnings:   Array.isArray(match.warnings) ? match.warnings : [],
    cameraModel:
      ocf.cameraModel ||
      ocf.camera ||
      match.cameraModel ||
      '',
    sourceResolution: ocf.resolution || '',
    isOffline: !!event.isOffline,
  };
}

// ---------------------------------------------------------------------------
// _normalizeMatchRow — internal row normalizer for OCF relink functions.
// Converts a matchAllEvents row ({event, match, ocf}) + optional job into a
// flat shape for _rebuildVfxPullArtifactsFromMatches and _updateOcfSummary.
// Coexists with the exported normalizeVfxPullRow — do NOT replace either.
// ---------------------------------------------------------------------------
function _normalizeMatchRow(row, job = null) {
  const event  = row?.event  || {};
  const match  = row?.match  || {};
  const ocf    = row?.ocf    || {};
  const sourcePath = match.matchedPath || job?.sourcePath || ocf.path || '';
  return {
    event,
    match,
    ocf,
    sourcePath,
    sourceFileName: sourcePath ? sourcePath.split(/[\\/]/).pop() : '',
    status:     match.status     || 'MISSING',
    confidence: Number(match.confidence || 0),
    warnings:   Array.isArray(match.warnings) ? match.warnings : [],
    reasons:    Array.isArray(match.reasons)  ? match.reasons  : [],
    reel:       event.reel     || event.clipName || '',
    clipName:   event.clipName || event.srcFile  || event.reel || '',
    shotName:   job?.shotId || job?.shotName || event.shotName || event._pmShot || event.clipName || event.reel || '',
    srcIn:  event.srcIn  || '',
    srcOut: event.srcOut || '',
    recIn:  event.recIn  || '',
    recOut: event.recOut || '',
    manual: !!match._manualLink,
    locked: !!match._manualLink || !!match.ocfLinkLocked,
  };
}

// Build a stable key for an event, used to store/look up manual links.
function _eventKey(event) {
  return [
    event?.reel || event?.clipName || event?.srcFile || '',
    event?.srcIn || '',
    event?.recIn || '',
  ].join('|');
}

let _providers = { getEvents: null, getMarkers: null, getProjectMeta: null };
let _running = false;
let _wired = false;
let _activeDetailIdx = -1;
let _detailFrameCache = new Map(); // idx → { dataUrl, width, height }
let _verifyIdx = 0;
let _verifyMode = 'side';
let _verifyData = {}; // idx -> { qtRef, ocfRef, approved, score, updatedAt }

// VFX Pull Workspace 2.0 state
let _wsVerifyStatus  = {};  // idx → 'not_checked'|'decode_ok'|'match_ok'|'needs_review'|'failed'|'approved'
let _wsMatchScore    = {};  // idx → 0–100
let _wsScrubFrame    = {};  // idx → absolute frame number
let _wsContactSheet  = {};  // idx → { qt:[{pos,tc,dataUrl}…], ocf:[{pos,tc,dataUrl}…] }
let _wsNotes         = {};  // idx → string
let _wsVerifyResults = {};  // idx → { tcMatch,durationMatch,frameCountMatch,framingMatch,speedMatch,decodeOk }
let _wsSelectedIdx   = 0;
let _wsDetailTab     = 'verify';
let _wsViewerMode    = 'side';
let _wsWorkspaceWired = false;
let _wsTriageSort     = false;  // sort pull list worst-first by risk
let _wsTriageReview   = false;  // show only shots that need review/blocked
const _wsFrameCache  = new Map();
// Bounded frame-cache writer — base64 data-URLs are large (~150 KB each), so
// cap the cache and evict oldest-first (Map preserves insertion order). Without
// this the cache grew unbounded across scrubbing/contact-sheet builds.
const _WS_FRAME_CACHE_MAX = 160;
function _wsCachePut(key, dataUrl) {
  if (!key || !dataUrl) return;
  if (_wsFrameCache.has(key)) _wsFrameCache.delete(key); // re-insert as newest
  _wsFrameCache.set(key, dataUrl);
  while (_wsFrameCache.size > _WS_FRAME_CACHE_MAX) {
    const oldest = _wsFrameCache.keys().next().value;
    if (oldest === undefined) break;
    _wsFrameCache.delete(oldest);
  }
}
// Last successfully-decoded frame per media path — the final visual fallback so
// a transient decode failure shows the most recent good frame (dimmed) instead
// of a black/error pane.
const _wsLastGood = new Map();   // mediaPath → dataUrl
// Render the last-good frame for a path (dimmed + stale banner) when a decode
// fails, or a plain error when there is no cached good frame to fall back to.
function _wsRenderFallbackOrError(pane, label, path, msg) {
  if (!pane) return;
  const good = _wsLastGood.get(path);
  if (good) {
    pane.innerHTML =
      `<span class="pm-vfx-ws-vpane-label">${label}</span>` +
      `<img src="${good}" class="pm-vfx-ws-vpane-img pm-vfx-ws-vpane-stale" alt="${label} (last good frame)">` +
      `<div class="pm-vfx-ws-stale-banner">⚠ ${msg}</div>`;
  } else {
    pane.innerHTML = `<span class="pm-vfx-ws-vpane-label">${label}</span><div class="pm-vfx-ws-vpane-error">${msg}</div>`;
  }
}

// Monotonic token so only the latest viewer-frame request paints — kills the
// stale-frame race where an older async decode resolves after a newer one and
// overwrites the pane (the flicker/jank during rapid scrub + shot switching).
let _wsFrameReqToken = 0;
// Idle neighbour-frame prefetch handle (so a new load can cancel a pending one).
let _wsPrefetchIdle  = 0;
// Live QT Ref player sessions (Electron only)
let _wsPlayerSession = {};  // idx → { playerId, srcUrl, playing }

// ── Live player session lifecycle ──────────────────────────────────────────
// Single source of truth for closing companion/<video> player sessions, so a
// session is never leaked on shot switch, mode change, re-analyse or teardown
// (leaks cause A/V desync + companion resource exhaustion over a long grade).
function _wsCloseSession(idx) {
  const s = _wsPlayerSession[idx];
  if (!s) return;
  try {
    if (s.playerId && window.pfxPlatform?.media?.closePlayer) {
      window.pfxPlatform.media.closePlayer({ playerId: s.playerId }).catch(() => {});
    }
  } catch { /* best-effort */ }
  delete _wsPlayerSession[idx];
}
function _wsCloseAllSessions() {
  for (const idx of Object.keys(_wsPlayerSession)) _wsCloseSession(idx);
  _wsPlayerSession = {};
}

// ── Media-bridge health watchdog ───────────────────────────────────────────
// Tracks decode outcomes; when the companion/native bridge goes offline it
// shows a status badge and pings on an interval until it recovers, then reloads
// the current frame. Decode reporting is wired into the viewer load path.
let _bridgeProbeTimer = 0;
const _bridgeMonitor = createBridgeMonitor({
  degradeAt: 2,
  offlineAt: 3,
  onStateChange: (state) => _onBridgeState(state),
});

function _onBridgeState(state) {
  _renderBridgeBadge(state);
  if (state === 'offline') _startBridgeProbe();
  else _stopBridgeProbe();
}

function _renderBridgeBadge(state) {
  const el = document.getElementById('pmWsBridgeStatus');
  if (!el) return;
  if (state === 'offline')      { el.textContent = '⟳ Bridge reconnecting…'; el.className = 'pm-vfx-ws-bridge is-offline'; el.style.display = ''; }
  else if (state === 'degraded'){ el.textContent = '● Bridge unstable';      el.className = 'pm-vfx-ws-bridge is-degraded'; el.style.display = ''; }
  else                          { el.style.display = 'none'; }
}

function _startBridgeProbe() {
  if (_bridgeProbeTimer) return;
  _bridgeProbeTimer = setInterval(async () => {
    try {
      await decodeWithRetry(() => nativeHelperPing(), { timeoutMs: 4000, retries: 0, label: 'bridge ping' });
      // Ping succeeded — bridge is back. reset() flips state→online, which
      // stops the probe via _onBridgeState; then refresh the current frame.
      _bridgeMonitor.reset();
      if (_wsSelectedIdx != null) { try { _wsLoadViewerFrame(_wsSelectedIdx); } catch {} }
    } catch { /* still down — keep probing */ }
  }, 5000);
}

function _stopBridgeProbe() {
  if (_bridgeProbeTimer) { clearInterval(_bridgeProbeTimer); _bridgeProbeTimer = 0; }
}

// ---------------------------------------------------------------------------
// Public init
// ---------------------------------------------------------------------------

export function resetVfxPullCard() {
  // Clear all project-specific state — match results, jobs, OCF folder, manual
  // links. User-preference settings (handles, frameStart, pullMode, etc.) survive.
  _state.ocfFolder         = null;
  _state.ocfFiles          = [];
  _state.matchResults      = [];
  _state.jobs              = [];
  _state.fdls              = [];
  _state.amfXmls           = [];
  _state.qcShots           = [];
  _state.normalisedRows    = [];
  _state.manualLinks       = {};
  _state.resolveConnected  = false;
  _state.resolveReconnected = false;
  _settings.outputFolder   = '';
  _running = false;

  // Invalidate probe cache so the next project starts fresh.
  _ocfProbeCache.path   = null;
  _ocfProbeCache.result = null;

  // Clear localStorage so state doesn't leak into the next project on reload.
  try { localStorage.removeItem(_LS_KEY); } catch {}

  // Reset workspace 2.0 state
  _wsVerifyStatus  = {};
  _wsMatchScore    = {};
  _wsScrubFrame    = {};
  _wsContactSheet  = {};
  _wsNotes         = {};
  _wsVerifyResults = {};
  _wsSelectedIdx   = 0;
  _wsDetailTab     = 'verify';
  _wsFrameCache.clear();
  // Close any live player sessions before clearing state.
  _wsCloseAllSessions();
  _stopBridgeProbe();

  // Reset UI — clear path inputs, hide table/export sections, repaint status.
  try { _setInputValue('pmVfxOutputFolder', ''); } catch {}
  const tableWrap = document.getElementById('pmVfxPullTableWrap');
  if (tableWrap) tableWrap.style.display = 'none';
  const exportEl = document.getElementById('pmVfxPullExport');
  if (exportEl) exportEl.style.display = 'none';
  try { _renderShotTable(); } catch {}
  try { _updateOcfSummary(); } catch {}
  try { _updateWfDots(); } catch {}
  try { _renderVerifyStation(); } catch {}
  try { _wsRefreshWorkspace(); } catch (_e) {}
}

export function initVfxPullCard(getEvents, getMarkers, getProjectMeta) {
  _providers.getEvents = getEvents;
  _providers.getMarkers = getMarkers;
  _providers.getProjectMeta = getProjectMeta;

  _restoreState();
  _injectCSS();

  const card = document.getElementById('pmVfxPullCard');
  if (!card) return;

  card.innerHTML = _buildPanelHTML();
  card.style.display = '';

  // PFXMAC Sprint 3 — media-library search in the VFX Pull shot-list panel
  // (queries the native SQLite DB this workspace's OCF scans populate).
  try {
    mountMediaSearch(
      document.querySelector('#pmVfxWorkspace .pfx-vfx-ws-left'),
      (rec) => { _linkLibraryFileToSelectedShot(rec); },   // click result → link to selected shot
    );
  } catch {}

  _applySettingsToUI();
  _wireListeners();
  _updateWfDots();
  _renderVerifyStation();

  // Inject detail overlay once into document body so it can float over everything
  if (!document.getElementById('pmVfxPullDetailOverlay')) {
    const ov = document.createElement('div');
    ov.id = 'pmVfxPullDetailOverlay';
    ov.className = 'pm-vfx-detail-overlay';
    ov.style.display = 'none';
    document.body.appendChild(ov);
    ov.addEventListener('click', e => { if (e.target === ov) _closeShotDetail(); });
  }

  _injectVfxWorkspace();
}

// ---------------------------------------------------------------------------
// CSS injection
// ---------------------------------------------------------------------------

function _injectCSS() {
  if (document.getElementById('pmVfxPullStyle')) return;
  const style = document.createElement('style');
  style.id = 'pmVfxPullStyle';
  style.textContent = `
/* ---- VFX Pull Panel ---- */
.pm-vfx-pull-inner {
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pm-vfx-pull-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pm-vfx-pull-header .pm-sly-clabel {
  flex: 1;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: rgba(228,235,255,0.52);
  text-transform: uppercase;
}
.pm-vfx-pull-status {
  font-size: 11px;
  color: rgba(228,235,255,0.72);
  white-space: nowrap;
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* Workflow dots */
.pm-vfx-pull-wf {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: nowrap;
  overflow: hidden;
}
.pm-vfx-pull-wf-sep {
  color: rgba(228,235,255,0.28);
  font-size: 11px;
  flex-shrink: 0;
}
.pm-vfx-pull-wfdot {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 10px;
  background: rgba(255,255,255,0.06);
  color: rgba(228,235,255,0.38);
  border: 1px solid rgba(255,255,255,0.08);
  flex-shrink: 0;
  cursor: default;
  transition: background 0.2s, color 0.2s, border-color 0.2s;
}
.pm-vfx-pull-wfdot.is-done {
  background: rgba(10,163,86,0.18);
  color: #0AA356;
  border-color: rgba(10,163,86,0.35);
}
.pm-vfx-pull-wfdot.is-warn {
  background: rgba(255,185,74,0.16);
  color: #ffb94a;
  border-color: rgba(255,185,74,0.35);
}
/* Big action button */
.pm-vfx-pull-go-btn {
  width: 100%;
  height: 40px;
  border: none;
  border-radius: 7px;
  background: linear-gradient(135deg, #3b5fd6 0%, #638eff 100%);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: opacity 0.2s, transform 0.1s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
}
.pm-vfx-pull-go-btn:hover { opacity: 0.88; }
.pm-vfx-pull-go-btn:active { transform: scale(0.98); }
.pm-vfx-pull-go-btn:disabled { opacity: 0.4; cursor: not-allowed; filter: grayscale(55%); transform: none; }
/* Disabled buttons read unmistakably as inactive (not just dimmed). */
.pm-vfx-pull-exp-btn:disabled, .pfx-vfx-approve-btn:disabled, .pm-vfx-ocf-btn:disabled {
  opacity: 0.4; cursor: not-allowed; filter: grayscale(55%);
}
/* Progress */
.pm-vfx-pull-progress {
  border-radius: 4px;
  overflow: hidden;
  background: rgba(255,255,255,0.06);
  position: relative;
  height: 22px;
}
.pm-vfx-pull-prog-bar {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  background: linear-gradient(90deg, #3b5fd6, #638eff);
  transition: width 0.3s ease;
  border-radius: 4px;
}
.pm-vfx-pull-prog-label {
  position: relative;
  z-index: 1;
  font-size: 10px;
  font-weight: 600;
  color: rgba(228,235,255,0.88);
  line-height: 22px;
  text-align: center;
  letter-spacing: 0.03em;
}
/* Advanced settings */
.pm-vfx-pull-adv {
  background: rgba(10,16,28,0.6);
  border-radius: 6px;
  border: 1px solid rgba(255,255,255,0.08);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.pm-vfx-pull-adv-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pm-vfx-pull-adv-lbl {
  font-size: 10px;
  color: rgba(228,235,255,0.55);
  white-space: nowrap;
  width: 80px;
  flex-shrink: 0;
}
.pm-vfx-pull-sel,
.pm-vfx-pull-inp {
  flex: 1;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 4px;
  color: #e4ebff;
  font-size: 11px;
  padding: 4px 6px;
  outline: none;
  min-width: 0;
}
.pm-vfx-pull-sel:focus,
.pm-vfx-pull-inp:focus {
  border-color: #638eff;
  background: rgba(99,142,255,0.08);
}
/* Shot table */
.pm-vfx-pull-table-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pm-vfx-pull-table-hdr {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: rgba(228,235,255,0.52);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.pm-vfx-pull-sel-all-wrap {
  display: flex;
  align-items: center;
  cursor: pointer;
  flex-shrink: 0;
}
.pm-vfx-pull-sel-all-wrap input { cursor: pointer; margin: 0; }
.pm-vfx-pull-row-sel-wrap {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  cursor: pointer;
}
.pm-vfx-pull-row-sel-wrap input { cursor: pointer; margin: 0; }
.pm-vfx-pull-row--desel {
  opacity: 0.4;
}
.pm-vfx-pull-table-scroll {
  max-height: 200px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.pm-vfx-pull-table-scroll::-webkit-scrollbar { width: 4px; }
.pm-vfx-pull-table-scroll::-webkit-scrollbar-track { background: transparent; }
.pm-vfx-pull-table-scroll::-webkit-scrollbar-thumb { background: rgba(99,142,255,0.35); border-radius: 2px; }
.pm-vfx-pull-row {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 10px;
  margin-bottom: 3px;
  border-radius: 4px;
  background: rgba(255,255,255,0.03);
  border-left: 3px solid transparent;
  font-size: 11.5px;
  line-height: 1.45;
  color: #e4ebff;
  cursor: pointer;
  transition: background 0.15s;
}
.pm-vfx-pull-row:hover { background: rgba(255,255,255,0.07); }
.pm-vfx-pull-row--ready   { border-left-color: #0AA356; }
.pm-vfx-pull-row--review  { border-left-color: #ffb94a; }
.pm-vfx-pull-row--missing { border-left-color: #ff5d6d; }
.pm-vfx-pull-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.pm-vfx-pull-dot--ready   { background: #0AA356; }
.pm-vfx-pull-dot--review  { background: #ffb94a; }
.pm-vfx-pull-dot--missing { background: #ff5d6d; }
.pm-vfx-pull-shotname {
  flex: 1;
  font-weight: 600;
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pm-vfx-pull-clip {
  font-size: 10.5px;
  color: rgba(228,235,255,0.55);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 110px;
}
.pm-vfx-pull-conf {
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
}
.pm-vfx-pull-conf.is-ok    { color: #0AA356; }
.pm-vfx-pull-conf.is-warn  { color: #ffb94a; }
.pm-vfx-pull-conf.is-error { color: #ff5d6d; }
.pm-vfx-pull-badges {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
}
.pm-vfx-pull-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(99,142,255,0.18);
  color: #638eff;
  border: 1px solid rgba(99,142,255,0.3);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.pm-vfx-pull-badge--amf {
  background: rgba(10,163,86,0.16);
  color: #0AA356;
  border-color: rgba(10,163,86,0.3);
}
/* Spec-mandated badge variants — OCF / manual / colour / frame / speed /
   reframe / EXR status. Same pill geometry as the existing badges so they
   slot into the same flex row without disturbing layout. */
/* Calmer palette: status (ok/err/exr) keep their semantic colours; the
   "attribute present" flags collapse into two muted families — slate for MATCH
   info (color/frame) and amber for TIMING (speed/reframe) — so rows read as a
   couple of accents, not a rainbow. Uniform opacity per family. */
.pm-vfx-pull-badge--ok     { background: rgba(10,163,86,0.16); color: #0AA356; border-color: rgba(10,163,86,0.3); }
.pm-vfx-pull-badge--err    { background: rgba(255,93,109,0.16); color: #ff5d6d; border-color: rgba(255,93,109,0.3); }
.pm-vfx-pull-badge--manual { background: rgba(150,135,205,0.14); color: #b6a8e6; border-color: rgba(150,135,205,0.30); }
.pm-vfx-pull-badge--color  { background: rgba(124,142,176,0.14); color: #b3c0d8; border-color: rgba(124,142,176,0.30); }
.pm-vfx-pull-badge--auto   { background: rgba(10,163,86,0.16); color: #6be099; border-color: rgba(10,163,86,0.34); }
.pm-vfx-pull-badge--frame  { background: rgba(124,142,176,0.14); color: #b3c0d8; border-color: rgba(124,142,176,0.30); }
.pm-vfx-pull-badge--speed  { background: rgba(224,176,84,0.13); color: #e0b054; border-color: rgba(224,176,84,0.30); }
.pm-vfx-pull-badge--reframe{ background: rgba(224,176,84,0.13); color: #e0b054; border-color: rgba(224,176,84,0.30); }
.pm-vfx-pull-badge--exr    { background: rgba(10,163,86,0.20); color: #6be099; border-color: rgba(10,163,86,0.45); }
.pm-vfx-pull-badge--exr-run{ background: rgba(224,176,84,0.18); color: #e0b054; border-color: rgba(224,176,84,0.40); }

.pm-vfx-pull-chip-warn {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255,185,74,0.14);
  color: #ffb94a;
  border: 1px solid rgba(255,185,74,0.28);
}

/* Per-row Relink button. Sits at the right edge of the row; click is captured
   by the table's delegated handler before the row-detail open fires. */
.pm-vfx-pull-relink {
  margin-left: auto;
  height: 20px; padding: 0 8px;
  font-size: 10px; font-weight: 600; letter-spacing: .02em;
  cursor: pointer; flex-shrink: 0;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.12);
  border-radius: 4px;
  color: rgba(232,232,242,0.78);
  transition: background .12s, border-color .12s, color .12s;
}
.pm-vfx-pull-relink:hover {
  background: rgba(160,140,255,0.14);
  border-color: rgba(160,140,255,0.45);
  color: #c8b8ff;
}
.pm-vfx-pull-relink--clear {
  background: rgba(255,93,109,0.1);
  color: #ff5d6d;
  border-color: rgba(255,93,109,0.35);
}
.pm-vfx-pull-relink--clear:hover { background: rgba(255,93,109,0.2); }
/* Export section */
.pm-vfx-pull-export {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.pm-vfx-pull-exp-label {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: rgba(228,235,255,0.38);
  text-transform: uppercase;
}
.pm-vfx-pull-exp-btns {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.pm-vfx-pull-exp-btn {
  padding: 5px 10px;
  border-radius: 5px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(255,255,255,0.06);
  color: rgba(228,235,255,0.82);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}
.pm-vfx-pull-exp-btn:hover {
  background: rgba(255,255,255,0.1);
  border-color: rgba(255,255,255,0.2);
}
.pm-vfx-pull-exp-btn--primary {
  background: linear-gradient(135deg, #3b5fd6 0%, #638eff 100%);
  border-color: transparent;
  color: #fff;
  font-weight: 700;
}
.pm-vfx-pull-exp-btn--primary:hover { opacity: 0.88; }
/* ---- Shot Detail Overlay ---- */
.pm-vfx-detail-overlay {
  position: fixed;
  inset: 0;
  z-index: 9990;
  background: rgba(5,8,16,0.72);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
}
.pm-vfx-detail-panel {
  background: #0f1829;
  border: 1px solid rgba(99,142,255,0.22);
  border-radius: 10px;
  width: 580px;
  max-width: 96vw;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 24px 64px rgba(0,0,0,0.7);
}
.pm-vfx-detail-topbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: rgba(99,142,255,0.07);
  border-bottom: 1px solid rgba(255,255,255,0.08);
  flex-shrink: 0;
}
.pm-vfx-detail-topbar .pm-vfx-pull-dot {
  width: 10px;
  height: 10px;
  flex-shrink: 0;
}
.pm-vfx-detail-title {
  flex: 1;
  font-size: 13px;
  font-weight: 700;
  color: #e4ebff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pm-vfx-detail-close {
  width: 22px;
  height: 22px;
  border: none;
  background: rgba(255,255,255,0.08);
  color: rgba(228,235,255,0.7);
  border-radius: 50%;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.15s;
}
.pm-vfx-detail-close:hover { background: rgba(255,255,255,0.16); }
.pm-vfx-detail-body {
  overflow-y: auto;
  padding: 12px 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pm-vfx-detail-body::-webkit-scrollbar { width: 4px; }
.pm-vfx-detail-body::-webkit-scrollbar-thumb { background: rgba(99,142,255,0.35); border-radius: 2px; }
.pm-vfx-detail-clip-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.pm-vfx-detail-clip-name {
  flex: 1;
  font-weight: 600;
  color: #e4ebff;
  font-family: 'SF Mono', 'Fira Mono', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pm-vfx-detail-match-status {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 7px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  flex-shrink: 0;
}
.pm-vfx-detail-match-status.is-ok    { background: rgba(10,163,86,0.16); color: #0AA356; border: 1px solid rgba(10,163,86,0.3); }
.pm-vfx-detail-match-status.is-warn  { background: rgba(255,185,74,0.14); color: #ffb94a; border: 1px solid rgba(255,185,74,0.28); }
.pm-vfx-detail-match-status.is-error { background: rgba(255,93,109,0.14); color: #ff5d6d; border: 1px solid rgba(255,93,109,0.28); }
/* Frame + scores row */
.pm-vfx-detail-frames {
  display: flex;
  gap: 12px;
  align-items: flex-start;
}
.pm-vfx-detail-frame-slot {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex-shrink: 0;
}
.pm-vfx-detail-frame-label {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: rgba(228,235,255,0.38);
  text-transform: uppercase;
}
#pmVfxDetailFrameCanvas {
  border-radius: 5px;
  border: 1px solid rgba(255,255,255,0.1);
  background: #080d1a;
  display: block;
  width: 240px;
  height: 135px;
  object-fit: contain;
}
.pm-vfx-detail-frame-tc {
  font-size: 10px;
  font-family: 'SF Mono', 'Fira Mono', monospace;
  color: rgba(228,235,255,0.5);
  text-align: center;
}
.pm-vfx-detail-frame-loading {
  width: 240px;
  height: 135px;
  border-radius: 5px;
  border: 1px solid rgba(255,255,255,0.1);
  background: #080d1a;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  color: rgba(228,235,255,0.35);
}
.pm-vfx-detail-scores {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 14px;
}
.pm-vfx-detail-score-title {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: rgba(228,235,255,0.38);
  text-transform: uppercase;
  margin-bottom: 2px;
}
.pm-vfx-detail-score-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: rgba(228,235,255,0.7);
}
.pm-vfx-detail-score-row > span:first-child {
  width: 50px;
  flex-shrink: 0;
  color: rgba(228,235,255,0.45);
}
.pm-vfx-detail-bar-track {
  flex: 1;
  height: 5px;
  background: rgba(255,255,255,0.08);
  border-radius: 3px;
  overflow: hidden;
}
.pm-vfx-detail-bar {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s ease;
}
.pm-vfx-detail-bar.is-ok    { background: #0AA356; }
.pm-vfx-detail-bar.is-warn  { background: #ffb94a; }
.pm-vfx-detail-bar.is-error { background: #ff5d6d; }
.pm-vfx-detail-score-val {
  width: 32px;
  text-align: right;
  flex-shrink: 0;
  font-weight: 700;
}
.pm-vfx-detail-method-tag {
  font-size: 9px;
  font-family: 'SF Mono', 'Fira Mono', monospace;
  padding: 1px 6px;
  border-radius: 3px;
  background: rgba(255,255,255,0.07);
  color: rgba(228,235,255,0.6);
  border: 1px solid rgba(255,255,255,0.1);
}
/* KV sections */
.pm-vfx-detail-section {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.pm-vfx-detail-section-hdr {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: rgba(228,235,255,0.38);
  text-transform: uppercase;
  padding-bottom: 3px;
  border-bottom: 1px solid rgba(255,255,255,0.06);
}
.pm-vfx-detail-kv-grid {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 3px 10px;
  font-size: 11px;
}
.pm-vfx-detail-kv-grid > span:nth-child(odd) {
  color: rgba(228,235,255,0.45);
  white-space: nowrap;
}
.pm-vfx-detail-kv-grid > span:nth-child(even) {
  color: #e4ebff;
  font-family: 'SF Mono', 'Fira Mono', monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* CDL display */
.pm-vfx-detail-cdl-block {
  font-size: 10px;
  font-family: 'SF Mono', 'Fira Mono', monospace;
  background: rgba(10,16,28,0.7);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 5px;
  padding: 7px 10px;
  color: rgba(228,235,255,0.82);
  line-height: 1.6;
}
.pm-vfx-detail-cdl-warn {
  margin-top: 5px;
  font-size: 9px;
  font-style: italic;
  color: rgba(255,185,74,0.7);
}
/* Warnings */
.pm-vfx-detail-warns {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
/* Match method checkboxes */
.pm-vfx-pull-chk-group {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
}
.pm-vfx-pull-chk {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: rgba(228,235,255,0.72);
  cursor: pointer;
  user-select: none;
}
.pm-vfx-pull-chk input[type="checkbox"] {
  accent-color: #638eff;
  cursor: pointer;
  width: 12px;
  height: 12px;
}
.pm-vfx-pull-chk--ocr {
  color: rgba(228,235,255,0.55);
}
.pm-vfx-pull-chk-note {
  font-size: 9px;
  color: rgba(228,235,255,0.35);
  font-style: italic;
}
/* OCF relink toolbar */
.pm-vfx-ocf-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255,255,255,0.07);
  flex-shrink: 0;
}
.pm-vfx-ocf-btn {
  font-size: 10px;
  font-weight: 600;
  padding: 3px 9px;
  border-radius: 4px;
  border: 1px solid rgba(99,142,255,0.4);
  background: rgba(99,142,255,0.12);
  color: #a0b0ff;
  cursor: pointer;
  white-space: nowrap;
}
.pm-vfx-ocf-btn:hover { background: rgba(99,142,255,0.22); }
.pm-vfx-ocf-btn--secondary { border-color: rgba(255,255,255,0.2); background: rgba(255,255,255,0.06); color: #aaa; }
.pm-vfx-ocf-btn--secondary:hover { background: rgba(255,255,255,0.12); }
/* Accent tier — the secondary auto-link option (Library), distinct from the
   plain admin buttons (Change folder / Rescan) so the action hierarchy reads. */
.pm-vfx-ocf-btn--alt { border-color: rgba(99,142,255,0.35); background: rgba(99,142,255,0.10); color: #9fb2f0; }
.pm-vfx-ocf-btn--alt:hover { background: rgba(99,142,255,0.18); }
.pm-vfx-ocf-btn--danger { border-color: rgba(255,93,109,0.4); background: rgba(255,93,109,0.1); color: #ff5d6d; }
.pm-vfx-ocf-btn--danger:hover { background: rgba(255,93,109,0.2); }
/* Proactive export-readiness summary (shown above the export buttons). */
.pm-vfx-export-preflight { margin: 0 0 8px; padding: 7px 10px; border-radius: 5px; font-size: 10.5px; line-height: 1.5; border-left: 3px solid transparent; }
.pm-vfx-export-preflight.is-blocked { background: rgba(200,50,50,0.12); border-left-color: #cc4444; color: #f0a0a0; }
.pm-vfx-export-preflight.is-warn    { background: rgba(200,150,40,0.10); border-left-color: #d8a23c; color: #e6c98a; }
.pm-vfx-export-preflight.is-ready   { background: rgba(10,163,86,0.10); border-left-color: #0AA356; color: #8ed9ad; }
.pm-vfx-pf-hd   { font-weight: 700; }
.pm-vfx-pf-list { margin: 4px 0 0; padding-left: 18px; opacity: 0.92; }
.pm-vfx-pf-list li { margin: 1px 0; }
.pm-vfx-ocf-summary { font-size: 10px; color: #888; margin-left: 4px; }
/* Resolve live connection badge in panel header */
.pm-vfx-resolve-badge {
  font-size: 9px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(10,163,86,0.18);
  color: #0AA356;
  border: 1px solid rgba(10,163,86,0.3);
  letter-spacing: 0.04em;
  flex-shrink: 0;
  white-space: nowrap;
}
.pm-vfx-blocked-banner {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 8px 10px;
  margin: 0 0 6px;
  border-radius: 6px;
  background: rgba(200,50,50,0.14);
  border: 1px solid rgba(200,70,70,0.38);
  font-size: 10.5px;
  color: #f09090;
  line-height: 1.4;
}
.pm-vfx-warning-banner {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  padding: 8px 10px;
  margin: 0 0 6px;
  border-radius: 6px;
  background: rgba(200,150,40,0.12);
  border: 1px solid rgba(200,160,60,0.35);
  font-size: 10.5px;
  color: #e0c070;
  line-height: 1.4;
}
.pm-vfx-blocked-icon { flex-shrink: 0; }
.pm-vfx-blocked-msg  { flex: 1; }
.pm-vfx-blocked-close {
  flex-shrink: 0;
  background: none;
  border: none;
  cursor: pointer;
  color: inherit;
  opacity: 0.55;
  font-size: 11px;
  padding: 0;
  line-height: 1;
}
.pm-vfx-blocked-close:hover { opacity: 1; }

/* ---- VFX Pull Verification Station ---- */
.pm-vfx-verify-station {
  border: 1px solid rgba(99,142,255,0.24);
  background: linear-gradient(180deg, rgba(15,23,42,0.82), rgba(6,10,22,0.74));
  border-radius: 10px;
  padding: 8px;
  box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
}
.pm-vfx-verify-head { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:7px; }
.pm-vfx-verify-title { font-size:10px; font-weight:800; letter-spacing:.08em; color:#aebdff; text-transform:uppercase; }
.pm-vfx-verify-pill { font-size:9px; font-weight:800; padding:2px 7px; border-radius:999px; border:1px solid rgba(255,255,255,.1); color:rgba(228,235,255,.58); background:rgba(255,255,255,.04); }
.pm-vfx-verify-pill.is-ok { color:#4ddb92; border-color:rgba(77,219,146,.45); background:rgba(77,219,146,.12); }
.pm-vfx-verify-pill.is-warn { color:#ffca66; border-color:rgba(255,202,102,.42); background:rgba(255,202,102,.1); }
.pm-vfx-verify-pill.is-bad { color:#ff6b7a; border-color:rgba(255,107,122,.42); background:rgba(255,107,122,.1); }
.pm-vfx-verify-modes { display:flex; gap:4px; flex-wrap:wrap; margin-bottom:7px; }
.pm-vfx-verify-mode, .pm-vfx-verify-action { border:1px solid rgba(255,255,255,.10); background:rgba(255,255,255,.055); color:rgba(228,235,255,.72); border-radius:7px; font-size:9.5px; font-weight:700; padding:4px 7px; cursor:pointer; }
.pm-vfx-verify-mode:hover, .pm-vfx-verify-action:hover { background:rgba(99,142,255,.13); color:#eaf0ff; }
.pm-vfx-verify-mode.is-active { background:rgba(99,142,255,.22); color:#fff; border-color:rgba(99,142,255,.45); }
.pm-vfx-verify-viewer { position:relative; display:grid; grid-template-columns:1fr 1fr; min-height:116px; gap:6px; border-radius:8px; overflow:hidden; background:#050814; border:1px solid rgba(255,255,255,.08); padding:6px; }
.pm-vfx-verify-pane { position:relative; min-height:102px; background:rgba(0,0,0,.38); border-radius:6px; overflow:hidden; border:1px solid rgba(255,255,255,.07); display:flex; align-items:center; justify-content:center; }
.pm-vfx-verify-pane img { width:100%; height:100%; object-fit:contain; display:block; }
.pm-vfx-verify-pane-label { position:absolute; left:6px; top:5px; z-index:2; font-size:9px; font-weight:800; color:#fff; background:rgba(0,0,0,.58); border:1px solid rgba(255,255,255,.14); border-radius:4px; padding:2px 5px; }
.pm-vfx-verify-empty { font-size:10px; color:rgba(228,235,255,.38); text-align:center; padding:12px; line-height:1.35; }
.pm-vfx-verify-viewer.mode-overlay { display:block; }
.pm-vfx-verify-viewer.mode-overlay .pm-vfx-verify-pane { position:absolute; inset:6px; }
.pm-vfx-verify-viewer.mode-overlay .pm-vfx-verify-pane.qt { opacity:.55; mix-blend-mode:screen; }
.pm-vfx-verify-viewer.mode-overlay .pm-vfx-verify-pane.ocf { opacity:.68; }
.pm-vfx-verify-viewer.mode-wipe { display:block; }
.pm-vfx-verify-viewer.mode-wipe .pm-vfx-verify-pane { position:absolute; inset:6px; }
.pm-vfx-verify-viewer.mode-wipe .pm-vfx-verify-pane.qt { clip-path: inset(0 50% 0 0); z-index:2; border-right:2px solid #ffd166; }
.pm-vfx-verify-viewer.mode-wipe .pm-vfx-verify-pane.ocf { z-index:1; }
.pm-vfx-verify-viewer.mode-diff .pm-vfx-verify-pane img { filter:grayscale(1) contrast(1.8); }
.pm-vfx-verify-viewer.mode-diff .pm-vfx-verify-pane.qt { mix-blend-mode:difference; opacity:.82; }
.pm-vfx-verify-viewer.mode-blink .pm-vfx-verify-pane.qt { animation:pfxVfxBlink 1.1s steps(1,end) infinite; }
.pm-vfx-verify-viewer.mode-blink .pm-vfx-verify-pane.ocf { animation:pfxVfxBlinkB 1.1s steps(1,end) infinite; }
@keyframes pfxVfxBlink { 0%,49%{opacity:1} 50%,100%{opacity:0} }
@keyframes pfxVfxBlinkB { 0%,49%{opacity:0} 50%,100%{opacity:1} }
.pm-vfx-verify-actions { display:flex; gap:5px; flex-wrap:wrap; margin-top:7px; }
.pm-vfx-verify-action.primary { background:linear-gradient(135deg,#22c55e,#3b82f6); color:#fff; border-color:rgba(255,255,255,.18); }
.pm-vfx-verify-action.danger { background:rgba(255,93,109,.12); color:#ff8a96; border-color:rgba(255,93,109,.28); }
.pm-vfx-verify-score-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:5px; margin-top:7px; }
.pm-vfx-verify-score { border:1px solid rgba(255,255,255,.08); background:rgba(255,255,255,.035); border-radius:7px; padding:5px 6px; }
.pm-vfx-verify-score-k { display:block; font-size:8.5px; text-transform:uppercase; letter-spacing:.05em; color:rgba(228,235,255,.38); }
.pm-vfx-verify-score-v { display:block; margin-top:2px; font-size:12px; font-weight:900; color:#eaf0ff; }
.pm-vfx-verify-strip { display:grid; grid-template-columns:48px 1fr; gap:5px; align-items:center; margin-top:7px; font-size:9px; color:rgba(228,235,255,.52); }
.pm-vfx-verify-strip-label { font-weight:800; color:rgba(228,235,255,.55); }
.pm-vfx-verify-frames { display:flex; gap:4px; overflow:hidden; }
.pm-vfx-verify-frame { flex:1; min-width:0; border-radius:5px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.04); text-align:center; padding:3px 2px; font-size:8.5px; color:rgba(228,235,255,.62); aspect-ratio:16/9; min-height:32px; }

/* ── VFX Pull Workspace 2.0 ── */
#pmVfxWorkspace { display:none; }
#main-prepmark.pm-mode-vfxmarker .pm-sly-body { display:none !important; }
#main-prepmark.pm-mode-vfxmarker #pmVfxWorkspace { display:flex; flex:1 1 0; min-height:0; overflow:hidden; }
.pm-vfx-workspace { width:100%; height:100%; display:flex; flex-direction:row; background:#05080f; overflow:hidden; font-size:11px; color:#e4ebff; }

/* Left column */
.pm-vfx-ws-left { width:272px; min-width:200px; display:flex; flex-direction:column; border-right:1px solid rgba(255,255,255,.07); overflow:hidden; flex-shrink:0; }
.pm-vfx-ws-list-hdr { display:flex; align-items:center; justify-content:space-between; padding:7px 8px 5px; border-bottom:1px solid rgba(255,255,255,.06); flex-shrink:0; }
.pm-vfx-ws-list-title { font-size:9px; font-weight:800; letter-spacing:.07em; color:rgba(228,235,255,.45); text-transform:uppercase; }
.pm-vfx-ws-btn-xs { font-size:9px; padding:2px 7px; border-radius:4px; border:1px solid rgba(255,255,255,.13); background:rgba(255,255,255,.07); color:#e4ebff; cursor:pointer; white-space:nowrap; }
.pm-vfx-ws-btn-xs:hover { background:rgba(255,255,255,.13); }
.pm-vfx-ws-list-scroll { flex:1 1 0; overflow-y:auto; overflow-x:hidden; }
.pm-vfx-ws-list-empty { padding:14px 10px; color:rgba(228,235,255,.32); font-size:10px; text-align:center; }
.pm-vfx-ws-triage-bar { display:flex; align-items:center; gap:5px; padding:4px 8px; border-bottom:1px solid rgba(255,255,255,.05); flex-shrink:0; }
.pm-vfx-ws-triage-count { font-size:9px; font-weight:700; color:#E0B341; letter-spacing:.02em; }
.pm-vfx-ws-triage-count.is-clear { color:#0AA356; }
.pm-vfx-ws-triage-spacer { flex:1 1 auto; }
.pm-vfx-ws-triage-btn { font-size:8.5px; padding:2px 6px; border-radius:4px; border:1px solid rgba(255,255,255,.12); background:rgba(255,255,255,.05); color:rgba(228,235,255,.62); cursor:pointer; white-space:nowrap; }
.pm-vfx-ws-triage-btn:hover { background:rgba(255,255,255,.1); }
.pm-vfx-ws-triage-btn.is-active { background:rgba(90,167,255,.2); border-color:rgba(90,167,255,.5); color:#cfe2ff; }
.pm-vfx-ws-list-row.risk-review   { box-shadow:inset 2px 0 0 #E0B341; }
.pm-vfx-ws-list-row.risk-blocked  { box-shadow:inset 2px 0 0 #E5484D; }
.pm-vfx-ws-bridge { font-size:8.5px; font-weight:700; padding:1px 6px; border-radius:10px; letter-spacing:.02em; }
.pm-vfx-ws-bridge.is-offline { color:#E5484D; background:rgba(229,72,77,.14); border:1px solid rgba(229,72,77,.34); animation:pmWsBridgePulse 1.1s ease-in-out infinite; }
.pm-vfx-ws-bridge.is-degraded { color:#E0B341; background:rgba(224,179,65,.14); border:1px solid rgba(224,179,65,.32); }
@keyframes pmWsBridgePulse { 0%,100%{opacity:.55} 50%{opacity:1} }
.pm-vfx-ws-vpane-stale { filter:grayscale(.35) brightness(.82); }
.pm-vfx-ws-stale-banner { position:absolute; left:0; right:0; bottom:0; padding:3px 6px; font-size:9px; font-weight:700; color:#ffd9a0; background:rgba(120,70,0,.62); text-align:center; }
.pm-vfx-ws-list-row { display:grid; grid-template-columns:10px 1fr auto auto 12px 14px; align-items:center; gap:5px; padding:5px 8px; cursor:pointer; border-bottom:1px solid rgba(255,255,255,.04); transition:background .12s; content-visibility:auto; contain-intrinsic-size:auto 27px; }
.pm-vfx-ws-list-row:hover { background:rgba(255,255,255,.05); }
.pm-vfx-ws-list-row.is-active { background:rgba(10,163,86,.1); border-left:2px solid #0AA356; padding-left:6px; }
.pm-vfx-ws-row-dot { width:8px; height:8px; border-radius:50%; background:rgba(228,235,255,.2); flex-shrink:0; }
.pm-vfx-ws-row-name { font-size:10px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#e4ebff; }
.pm-vfx-ws-row-badge { font-size:8.5px; border-radius:3px; padding:1px 4px; white-space:nowrap; }
.pm-vfx-ws-row-score { font-size:9px; font-weight:700; white-space:nowrap; }
.pm-vfx-ws-row-ocf { font-size:10px; }
.pm-vfx-ws-row-approve { font-size:10px; color:rgba(228,235,255,.35); }
.pm-vfx-ws-row-approve.is-approved { color:#0AA356; }

/* status colours */
.ws-status--approved .pm-vfx-ws-row-dot, .ws-status--approved { background:rgba(10,163,86,.25); color:#0AA356; }
.ws-status--ok .pm-vfx-ws-row-dot, .ws-status--ok { background:rgba(10,163,86,.15); color:#6ee7b7; }
.ws-status--warn .pm-vfx-ws-row-dot, .ws-status--warn { background:rgba(255,185,74,.2); color:#ffb94a; }
.ws-status--error .pm-vfx-ws-row-dot, .ws-status--error { background:rgba(255,93,109,.2); color:#ff8a96; }
.ws-status--none .pm-vfx-ws-row-dot, .ws-status--none { background:rgba(228,235,255,.12); color:rgba(228,235,255,.4); }
.ws-score--safe { color:#0AA356; }
.ws-score--warn { color:#ffb94a; }
.ws-score--fail { color:#ff8a96; }
.ws-score--none { color:rgba(228,235,255,.35); }
.pm-vfx-ws-row-ocf.is-ok  { color:#0AA356; }
.pm-vfx-ws-row-ocf.is-missing { color:rgba(255,93,109,.7); }

/* Pull readiness panel */
.pm-vfx-ws-readiness { border-top:1px solid rgba(255,255,255,.07); padding:7px 8px 5px; flex-shrink:0; }
.pm-vfx-ws-readiness-row { display:flex; align-items:center; gap:7px; padding:2px 0; }
.pm-vfx-ws-ready-gate { font-size:8.5px; font-weight:800; padding:1px 5px; border-radius:3px; min-width:28px; text-align:center; background:rgba(255,255,255,.06); color:rgba(228,235,255,.38); border:1px solid rgba(255,255,255,.1); transition:background .18s, color .18s; }
.pm-vfx-ws-ready-gate.is-ok  { background:rgba(10,163,86,.18); color:#0AA356; border-color:rgba(10,163,86,.35); }
.pm-vfx-ws-ready-gate.is-warn { background:rgba(255,185,74,.12); color:#ffb94a; border-color:rgba(255,185,74,.25); }
.pm-vfx-ws-ready-label { font-size:9px; color:rgba(228,235,255,.45); }
.pm-vfx-ws-approved-count { margin-top:5px; font-size:9.5px; font-weight:700; color:rgba(228,235,255,.55); text-align:center; padding:3px 0; border-top:1px solid rgba(255,255,255,.05); }

/* Center column */
.pm-vfx-ws-center { flex:1 1 0; min-width:0; display:flex; flex-direction:column; border-right:1px solid rgba(255,255,255,.07); overflow:hidden; }
.pm-vfx-ws-viewer-hdr { display:flex; align-items:center; gap:6px; padding:5px 8px; border-bottom:1px solid rgba(255,255,255,.06); flex-shrink:0; flex-wrap:wrap; }
.pm-vfx-ws-modes { display:flex; gap:3px; flex-wrap:wrap; }
.pm-vfx-ws-mode { font-size:9px; padding:2px 7px; border-radius:4px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.05); color:rgba(228,235,255,.6); cursor:pointer; white-space:nowrap; }
.pm-vfx-ws-mode:hover { background:rgba(255,255,255,.1); color:#e4ebff; }
.pm-vfx-ws-mode.is-active { background:rgba(10,163,86,.18); color:#6ee7b7; border-color:rgba(10,163,86,.3); }
.pm-vfx-ws-shot-name { font-size:10px; font-weight:700; color:rgba(228,235,255,.7); margin-left:auto; }
.pm-vfx-ws-viewer { flex:1 1 0; min-height:0; position:relative; overflow:hidden; background:#02040a; }
.pm-vfx-ws-viewer-inner { width:100%; height:100%; display:flex; position:relative; overflow:hidden; }
/* mode variants */
.pm-vfx-ws-viewer-inner.mode-qt_ref .pm-vfx-ws-vpane.ocf,
.pm-vfx-ws-viewer-inner.mode-ocf   .pm-vfx-ws-vpane.qt { display:none; }
.pm-vfx-ws-viewer-inner.mode-qt_ref .pm-vfx-ws-vpane.qt,
.pm-vfx-ws-viewer-inner.mode-ocf   .pm-vfx-ws-vpane.ocf { flex:1; }
.pm-vfx-ws-viewer-inner.mode-side .pm-vfx-ws-vpane { flex:1; border-right:1px solid rgba(255,255,255,.12); }
.pm-vfx-ws-viewer-inner.mode-side .pm-vfx-ws-vpane:last-child { border-right:none; }
.pm-vfx-ws-viewer-inner.mode-wipe .pm-vfx-ws-vpane { position:absolute; inset:0; }
.pm-vfx-ws-viewer-inner.mode-wipe .pm-vfx-ws-vpane.qt { clip-path:inset(0 50% 0 0); }
.pm-vfx-ws-viewer-inner.mode-diff .pm-vfx-ws-vpane img { filter:grayscale(1) contrast(1.8); }
.pm-vfx-ws-viewer-inner.mode-diff .pm-vfx-ws-vpane.qt { mix-blend-mode:difference; opacity:.82; }
.pm-vfx-ws-viewer-inner.mode-blink .pm-vfx-ws-vpane.qt  { animation:pfxWsBlink  1.1s steps(1,end) infinite; }
.pm-vfx-ws-viewer-inner.mode-blink .pm-vfx-ws-vpane.ocf { animation:pfxWsBlinkB 1.1s steps(1,end) infinite; }
@keyframes pfxWsBlink  { 0%,49%{opacity:1} 50%,100%{opacity:0} }
@keyframes pfxWsBlinkB { 0%,49%{opacity:0} 50%,100%{opacity:1} }
.pm-vfx-ws-viewer-inner.mode-overlay .pm-vfx-ws-vpane.qt { opacity:.55; mix-blend-mode:screen; }
.pm-vfx-ws-vpane { flex:1; min-width:0; position:relative; display:flex; align-items:center; justify-content:center; overflow:hidden; }
.pm-vfx-ws-vpane-label { position:absolute; top:4px; left:5px; font-size:8.5px; font-weight:800; letter-spacing:.06em; color:rgba(228,235,255,.55); background:rgba(0,0,0,.5); padding:1px 5px; border-radius:3px; z-index:2; pointer-events:none; }
.pm-vfx-ws-vpane-empty, .pm-vfx-ws-vpane-error, .pm-vfx-ws-vpane-loading { font-size:10px; text-align:center; color:rgba(228,235,255,.3); padding:12px; line-height:1.5; }
.pm-vfx-ws-vpane-error { color:#ff8a96; }
.pm-vfx-ws-vpane-img { width:100%; height:100%; object-fit:contain; display:block; }

/* OCF scrub */
.pm-vfx-ws-scrub { border-top:1px solid rgba(255,255,255,.06); padding:5px 8px; flex-shrink:0; background:rgba(255,255,255,.02); }
.pm-vfx-ws-scrub-tc { display:flex; gap:8px; align-items:center; margin-bottom:4px; font-size:9px; color:rgba(228,235,255,.55); }
.pm-vfx-ws-tc-item { display:flex; align-items:center; gap:3px; }
.pm-vfx-ws-tc-label { font-size:8px; font-weight:700; letter-spacing:.05em; color:rgba(228,235,255,.32); text-transform:uppercase; }
.pm-vfx-ws-tc-sep { color:rgba(228,235,255,.2); }
.pm-vfx-ws-scrub-slider { width:100%; margin:2px 0; accent-color:#0AA356; height:3px; cursor:pointer; }
.pm-vfx-ws-scrub-nav { display:flex; gap:3px; align-items:center; margin-top:4px; }
.pm-vfx-ws-scrub-btn { font-size:9px; padding:2px 8px; border-radius:4px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.06); color:#e4ebff; cursor:pointer; }
.pm-vfx-ws-jump-btn { font-size:8.5px; padding:2px 6px; border-radius:4px; border:1px solid rgba(255,255,255,.09); background:rgba(10,163,86,.09); color:#6ee7b7; cursor:pointer; flex:1; }
.pm-vfx-ws-scrub-btn:hover, .pm-vfx-ws-jump-btn:hover { background:rgba(255,255,255,.12); color:#fff; }
.pm-vfx-ws-play-btn { font-size:11px; padding:2px 10px; border-radius:4px; border:1px solid rgba(10,163,86,.4); background:rgba(10,163,86,.15); color:#6ee7b7; cursor:pointer; min-width:28px; }
.pm-vfx-ws-play-btn.is-playing { background:rgba(10,163,86,.28); color:#a7f3d0; border-color:rgba(10,163,86,.7); }
.pm-vfx-ws-play-btn:hover { background:rgba(10,163,86,.3); color:#a7f3d0; }
.pm-vfx-ws-vpane video { width:100%; height:100%; object-fit:contain; background:#000; display:block; }

/* Hero contact sheet */
.pm-vfx-ws-sheet-hdr { font-size:8.5px; font-weight:800; letter-spacing:.07em; color:rgba(228,235,255,.35); text-transform:uppercase; padding:4px 8px 2px; border-top:1px solid rgba(255,255,255,.06); flex-shrink:0; }
.pm-vfx-ws-sheet { display:flex; flex-direction:column; gap:3px; padding:4px 8px 6px; flex-shrink:0; }
.pm-vfx-ws-sheet-row { display:flex; gap:3px; }
.pm-vfx-ws-sheet-cell { flex:1; display:flex; flex-direction:column; align-items:center; gap:1px; cursor:pointer; }
.pm-vfx-ws-sheet-cell:hover .pm-vfx-ws-sheet-thumb { border-color:rgba(10,163,86,.6); }
.pm-vfx-ws-sheet-thumb { width:100%; aspect-ratio:16/9; border-radius:3px; border:1px solid rgba(255,255,255,.1); background:rgba(255,255,255,.04); overflow:hidden; }
.pm-vfx-ws-sheet-thumb--empty { background:repeating-linear-gradient(45deg, rgba(255,255,255,.03) 0, rgba(255,255,255,.03) 2px, transparent 2px, transparent 6px); }
.pm-vfx-ws-sheet-pos { font-size:7.5px; color:rgba(228,235,255,.3); white-space:nowrap; text-overflow:ellipsis; overflow:hidden; max-width:100%; text-align:center; }

/* Right column */
.pm-vfx-ws-right { width:288px; min-width:220px; display:flex; flex-direction:column; overflow:hidden; flex-shrink:0; }
.pm-vfx-ws-tabs-hdr { display:flex; border-bottom:1px solid rgba(255,255,255,.07); flex-shrink:0; }
.pm-vfx-ws-tab { flex:1; font-size:9.5px; font-weight:700; padding:6px 4px; text-align:center; border:none; border-bottom:2px solid transparent; background:none; color:rgba(228,235,255,.42); cursor:pointer; transition:color .15s, border-color .15s; }
.pm-vfx-ws-tab:hover { color:#e4ebff; }
.pm-vfx-ws-tab.is-active { color:#6ee7b7; border-bottom-color:#0AA356; }
.pm-vfx-ws-tab-body { flex:1 1 0; overflow-y:auto; overflow-x:hidden; }
.pm-vfx-ws-tab-pane { display:none; padding:8px; }
.pm-vfx-ws-tab-pane.is-active { display:flex; flex-direction:column; gap:6px; }
.pm-vfx-ws-tab-empty { font-size:10px; color:rgba(228,235,255,.3); text-align:center; padding:16px 8px; }

/* Verify tab */
.pm-vfx-ws-verify-checks { display:flex; flex-direction:column; gap:2px; }
.pm-vfx-ws-check-row { display:grid; grid-template-columns:14px 1fr auto; align-items:center; gap:5px; padding:3px 5px; border-radius:4px; font-size:9.5px; }
.pm-vfx-ws-check-row.ws-check--ok    { background:rgba(10,163,86,.07); }
.pm-vfx-ws-check-row.ws-check--fail  { background:rgba(255,93,109,.07); }
.pm-vfx-ws-check-row.ws-check--none  { background:rgba(255,255,255,.03); }
.pm-vfx-ws-check-icon { font-weight:900; text-align:center; }
.ws-check--ok   .pm-vfx-ws-check-icon { color:#0AA356; }
.ws-check--fail .pm-vfx-ws-check-icon { color:#ff5d6d; }
.ws-check--none .pm-vfx-ws-check-icon { color:rgba(228,235,255,.3); }
.pm-vfx-ws-check-label { color:rgba(228,235,255,.7); }
.pm-vfx-ws-check-value { font-size:9px; color:rgba(228,235,255,.45); white-space:nowrap; text-overflow:ellipsis; overflow:hidden; max-width:80px; }
.pm-vfx-ws-score-row { display:flex; align-items:center; }
.pm-vfx-ws-score-badge { font-size:10px; font-weight:800; padding:3px 8px; border-radius:5px; background:rgba(255,255,255,.06); }
.pm-vfx-ws-score-badge.ws-score--safe { background:rgba(10,163,86,.18); color:#0AA356; }
.pm-vfx-ws-score-badge.ws-score--warn { background:rgba(255,185,74,.15); color:#ffb94a; }
.pm-vfx-ws-score-badge.ws-score--fail { background:rgba(255,93,109,.13); color:#ff8a96; }
.pm-vfx-ws-score-badge.ws-score--none { color:rgba(228,235,255,.4); }
.pm-vfx-ws-verify-actions { display:flex; gap:5px; flex-wrap:wrap; }
.pm-vfx-ws-lock-msg { font-size:9.5px; color:#ffb94a; background:rgba(255,185,74,.09); border:1px solid rgba(255,185,74,.2); border-radius:5px; padding:5px 7px; line-height:1.4; }

/* Action buttons */
.pm-vfx-ws-action-btn { font-size:10px; font-weight:700; padding:5px 10px; border-radius:5px; border:1px solid rgba(255,255,255,.15); background:rgba(255,255,255,.07); color:#e4ebff; cursor:pointer; transition:background .15s; white-space:nowrap; }
.pm-vfx-ws-action-btn:hover { background:rgba(255,255,255,.14); }
.pm-vfx-ws-action-btn.primary { background:linear-gradient(135deg,#22c55e,#3b82f6); border-color:rgba(255,255,255,.2); }
.pm-vfx-ws-action-btn.primary:hover { background:linear-gradient(135deg,#16a34a,#2563eb); }
.pm-vfx-ws-action-btn.is-approved { background:rgba(10,163,86,.2); color:#0AA356; border-color:rgba(10,163,86,.35); }
.pm-vfx-ws-action-btn.is-locked { opacity:.42; cursor:not-allowed; }

/* Conform + Export tabs */
.pm-vfx-ws-conform-section { margin-bottom:6px; }
.pm-vfx-ws-section-lbl { font-size:8.5px; font-weight:800; letter-spacing:.07em; color:rgba(228,235,255,.35); text-transform:uppercase; margin-bottom:3px; }
.pm-vfx-ws-kv-row { display:grid; grid-template-columns:80px 1fr; gap:4px; padding:2px 0; border-bottom:1px solid rgba(255,255,255,.04); font-size:9.5px; }
.pm-vfx-ws-kv-k { color:rgba(228,235,255,.42); }
.pm-vfx-ws-kv-v { color:#e4ebff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pm-vfx-ws-kv-v--path { color:rgba(228,235,255,.6); font-size:8.5px; }

/* Notes tab */
.pm-vfx-ws-notes-field { width:100%; min-height:100px; background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.1); border-radius:5px; color:#e4ebff; font-size:10px; padding:6px 8px; resize:vertical; font-family:inherit; }
.pm-vfx-ws-notes-field:focus { outline:none; border-color:rgba(10,163,86,.4); }

`;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Panel HTML
// ---------------------------------------------------------------------------

function _buildPanelHTML() {
  return `
<div class="pm-vfx-pull-inner">
  <div class="pm-vfx-pull-header">
    <span class="pm-sly-clabel">VFX PULL</span>
    <span class="pm-vfx-pull-status" id="pmVfxPullStatus">—</span>
    <span class="pm-vfx-resolve-badge" id="pmVfxResolveBadge" style="display:none;" title="Timeline events sourced from live DaVinci Resolve">Resolve ●</span>
    <button class="pm-sly-btn-xs" id="pmVfxPullAdvBtn">⚙ Settings</button>
  </div>

  <!-- Spec workflow: Timeline → QT Ref → OCF → Reconnect → Color → Frame → EXR → QC -->
  <div class="pm-vfx-pull-wf pm-vfx-pull-wf--v2" id="pmVfxPullWf" title="VFX pull workflow — each step lights up green as it completes. Hover a step for what to do.">
    <div class="pm-vfx-pull-wfdot" id="pmVfxWfTimeline" title="Step 1 of 8 — Load your edit (EDL / XML / FCPXML / OTIO) with VFX markers on the shots to pull.">Timeline</div>
    <div class="pm-vfx-pull-wf-sep">›</div>
    <div class="pm-vfx-pull-wfdot" id="pmVfxWfRef"      title="Step 2 of 8 — Load the Rec.709 QuickTime reference to match color against.">QT Ref</div>
    <div class="pm-vfx-pull-wf-sep">›</div>
    <div class="pm-vfx-pull-wfdot" id="pmVfxWfOcf"      title="Step 3 of 8 — Link your original camera files (OCF) folder, or use the media library.">OCF</div>
    <div class="pm-vfx-pull-wf-sep">›</div>
    <div class="pm-vfx-pull-wfdot" id="pmVfxWfMatch"    title="Step 4 of 8 — Smart-reconnect: match each shot to its camera clip by timecode.">Reconnect</div>
    <div class="pm-vfx-pull-wf-sep">›</div>
    <div class="pm-vfx-pull-wfdot" id="pmVfxWfColor"    title="Step 5 of 8 — Match the QT-Ref look to the OCF (CDL) for a reference grade.">Color</div>
    <div class="pm-vfx-pull-wf-sep">›</div>
    <div class="pm-vfx-pull-wfdot" id="pmVfxWfFrame"    title="Step 6 of 8 — Reframe / letterbox the plate to the delivery resolution.">Frame</div>
    <div class="pm-vfx-pull-wf-sep">›</div>
    <div class="pm-vfx-pull-wfdot" id="pmVfxWfExr"      title="Step 7 of 8 — Render the EXR plate sequence with handles.">EXR</div>
    <div class="pm-vfx-pull-wf-sep">›</div>
    <div class="pm-vfx-pull-wfdot" id="pmVfxWfQc"       title="Step 8 of 8 — Build the QC report + sidecars, ready to export.">QC</div>
  </div>

  <button class="pm-vfx-pull-go-btn" id="pmVfxPullGoBtn">
    ⚡ Analyze &amp; Build VFX Pull Package
  </button>

  <div class="pm-vfx-pull-progress" id="pmVfxPullProgress" style="display:none;">
    <div class="pm-vfx-pull-prog-bar" id="pmVfxPullProgBar" style="width:0%"></div>
    <div class="pm-vfx-pull-prog-label" id="pmVfxPullProgLabel">Scanning…</div>
  </div>


  <div class="pm-vfx-verify-station" id="pmVfxVerifyStation">
    <div class="pm-vfx-verify-head">
      <span class="pm-vfx-verify-title">VFX Pull Verification Station</span>
      <span class="pm-vfx-verify-pill" id="pmVfxVerifyReadyPill">Not checked</span>
    </div>
    <div class="pm-vfx-verify-modes" id="pmVfxVerifyModes">
      <button class="pm-vfx-verify-mode is-active" data-mode="side" type="button">Side by side</button>
      <button class="pm-vfx-verify-mode" data-mode="wipe" type="button">Wipe</button>
      <button class="pm-vfx-verify-mode" data-mode="diff" type="button">Difference</button>
      <button class="pm-vfx-verify-mode" data-mode="blink" type="button">Blink</button>
      <button class="pm-vfx-verify-mode" data-mode="overlay" type="button">Overlay</button>
    </div>
    <div class="pm-vfx-verify-viewer mode-side" id="pmVfxVerifyViewer">
      <div class="pm-vfx-verify-pane qt"><span class="pm-vfx-verify-pane-label">QT REF</span><div class="pm-vfx-verify-empty">Load QT Ref and click<br>Capture QT Frame</div></div>
      <div class="pm-vfx-verify-pane ocf"><span class="pm-vfx-verify-pane-label">OCF</span><div class="pm-vfx-verify-empty">Relink OCF and click<br>Extract OCF Frame</div></div>
    </div>
    <div class="pm-vfx-verify-actions">
      <button class="pm-vfx-verify-action" id="pmVfxCaptureQtBtn" type="button">Capture QT Frame</button>
      <button class="pm-vfx-verify-action" id="pmVfxExtractOcfBtn" type="button">Extract OCF Frame</button>
      <button class="pm-vfx-verify-action" id="pmVfxContactSheetBtn" type="button">7-frame check</button>
      <button class="pm-vfx-verify-action" id="pmVfxVisualRelinkBtn" type="button" title="Find the right OCF by image content when reel/TC matching failed">🔍 Find OCF by image</button>
      <button class="pm-vfx-verify-action primary" id="pmVfxApproveLinkBtn" type="button">Approve Link</button>
    </div>
    <div class="pm-vfx-verify-score-grid">
      <div class="pm-vfx-verify-score"><span class="pm-vfx-verify-score-k">Source</span><span class="pm-vfx-verify-score-v" id="pmVfxScoreSource">—</span></div>
      <div class="pm-vfx-verify-score"><span class="pm-vfx-verify-score-k">Framing</span><span class="pm-vfx-verify-score-v" id="pmVfxScoreFrame">—</span></div>
      <div class="pm-vfx-verify-score"><span class="pm-vfx-verify-score-k">Pull Ready</span><span class="pm-vfx-verify-score-v" id="pmVfxScoreReady">—</span></div>
    </div>
    <div class="pm-vfx-verify-strip">
      <span class="pm-vfx-verify-strip-label">QT Ref</span>
      <div class="pm-vfx-verify-frames" id="pmVfxQtStrip"><span class="pm-vfx-verify-frame">Handle</span><span class="pm-vfx-verify-frame">In</span><span class="pm-vfx-verify-frame">25%</span><span class="pm-vfx-verify-frame">50%</span><span class="pm-vfx-verify-frame">75%</span><span class="pm-vfx-verify-frame">Out</span><span class="pm-vfx-verify-frame">Tail</span></div>
      <span class="pm-vfx-verify-strip-label">OCF</span>
      <div class="pm-vfx-verify-frames" id="pmVfxOcfStrip"><span class="pm-vfx-verify-frame">pending</span><span class="pm-vfx-verify-frame">pending</span><span class="pm-vfx-verify-frame">pending</span><span class="pm-vfx-verify-frame">pending</span><span class="pm-vfx-verify-frame">pending</span><span class="pm-vfx-verify-frame">pending</span><span class="pm-vfx-verify-frame">pending</span></div>
    </div>
  </div>

  <div class="pm-vfx-pull-adv" id="pmVfxPullAdv" style="display:none;">
    <div class="pm-vfx-pull-adv-row">
      <label class="pm-vfx-pull-adv-lbl">Handles</label>
      <select id="pmVfxHandles" class="pm-vfx-pull-sel">
        <option value="8">8 fr</option>
        <option value="12">12 fr</option>
        <option value="16">16 fr (Netflix)</option>
        <option value="24">24 fr</option>
      </select>
    </div>
    <div class="pm-vfx-pull-adv-row">
      <label class="pm-vfx-pull-adv-lbl">Frame start</label>
      <input id="pmVfxFrameStart" class="pm-vfx-pull-inp" type="number" value="1001" min="0" max="99999">
    </div>
    <div class="pm-vfx-pull-adv-row">
      <label class="pm-vfx-pull-adv-lbl">Plate format</label>
      <select id="pmVfxPlateFormat" class="pm-vfx-pull-sel">
        <option value="exr_aces">EXR 16-bit half ACES2065-1</option>
        <option value="dpx_log">DPX 16-bit log</option>
        <option value="mov_proxy">MOV ProRes proxy</option>
      </select>
    </div>
    <div class="pm-vfx-pull-adv-row">
      <label class="pm-vfx-pull-adv-lbl">Pull mode</label>
      <select id="pmVfxPullMode" class="pm-vfx-pull-sel">
        <option value="ocf_native">OCF Native — IDT only, ACES2065-1</option>
        <option value="match_editorial">Match Editorial — IDT + approved look</option>
        <option value="review_proxy">Review Proxy — IDT + look + ODT baked</option>
      </select>
    </div>
    <!-- ACES 2.0 output transform — only meaningful for Review Proxy (ODT bake) -->
    <div class="pm-vfx-pull-adv-row" id="pmVfxOdtRow" style="display:none;">
      <label class="pm-vfx-pull-adv-lbl">ACES 2.0 ODT</label>
      <select id="pmVfxOdtTransform" class="pm-vfx-pull-sel">
        <option value="rec709_sdr">ACES 2.0 — SDR Rec.709 100 nits</option>
      </select>
      <button class="pm-sly-btn-xs" id="pmVfxRenderReviewBtn" title="Bake the ACES 2.0 output transform onto the rendered AP0 EXR plates and encode a Rec.709 review movie per shot.">Render Review</button>
    </div>
    <div class="pm-vfx-pull-adv-row">
      <label class="pm-vfx-pull-adv-lbl">Render engine</label>
      <select id="pmVfxRenderEngine" class="pm-vfx-pull-sel">
        <option value="auto">Auto (Resolve → OIIO → FFmpeg)</option>
        <option value="resolve">DaVinci Resolve</option>
        <option value="oiio">oiiotool (OCIO)</option>
        <option value="ffmpeg">FFmpeg</option>
      </select>
    </div>
    <div class="pm-vfx-pull-adv-row">
      <label class="pm-vfx-pull-adv-lbl">Output folder</label>
      <div style="display:flex;gap:4px;flex:1;min-width:0;">
        <input id="pmVfxOutputFolder" class="pm-vfx-pull-inp" type="text" placeholder="/path/to/VFX_PULL_PACKAGE" style="flex:1;min-width:0;">
        <button class="pm-sly-btn-xs" id="pmVfxOutputBrowseBtn">Browse</button>
        <button class="pm-sly-btn-xs" id="pmVfxOutputOpenBtn" title="Reveal in Finder/Explorer">Open</button>
      </div>
    </div>

    <!-- Spec #6: target plate resolution + colour-space disclosure -->
    <div class="pm-vfx-pull-adv-row">
      <label class="pm-vfx-pull-adv-lbl">Target resolution</label>
      <select id="pmVfxTargetRes" class="pm-vfx-pull-sel">
        <option value="3840x2160">UHD 3840×2160</option>
        <option value="4096x2160">DCI 4K 4096×2160</option>
        <option value="1920x1080">HD 1920×1080</option>
      </select>
    </div>
    <div class="pm-vfx-pull-adv-row">
      <label class="pm-vfx-pull-adv-lbl">QT ref colour</label>
      <span class="pm-vfx-pull-adv-static">Rec709 (display-referred)</span>
    </div>
    <div class="pm-vfx-pull-adv-row">
      <label class="pm-vfx-pull-adv-lbl">OCF working colour</label>
      <span class="pm-vfx-pull-adv-static">ACES2065-1 / AP0 scene-linear</span>
    </div>

    <!-- Spec #6: bake-into-EXR toggles -->
    <div class="pm-vfx-pull-adv-row">
      <label class="pm-vfx-pull-adv-lbl">Bake speed</label>
      <label class="pm-vfx-pull-chk pm-vfx-pull-chk--inline"><input id="pmVfxBakeSpeed" type="checkbox"> include speed change in EXR sequence</label>
    </div>
    <div class="pm-vfx-pull-adv-row">
      <label class="pm-vfx-pull-adv-lbl">Bake reframe</label>
      <label class="pm-vfx-pull-chk pm-vfx-pull-chk--inline"><input id="pmVfxBakeReframe" type="checkbox"> include UHD reformat in EXR sequence</label>
    </div>

    <!-- Spec #6: sidecar toggles + export mode -->
    <div class="pm-vfx-pull-adv-row">
      <label class="pm-vfx-pull-adv-lbl">Sidecars</label>
      <div class="pm-vfx-pull-chk-group pm-vfx-pull-chk-group--row">
        <label class="pm-vfx-pull-chk"><input id="pmVfxGenAmf"  type="checkbox"> AMF</label>
        <label class="pm-vfx-pull-chk"><input id="pmVfxGenFdl"  type="checkbox"> FDL</label>
        <label class="pm-vfx-pull-chk"><input id="pmVfxGenNuke" type="checkbox"> Nuke handoff</label>
      </div>
    </div>
    <div class="pm-vfx-pull-adv-row">
      <label class="pm-vfx-pull-adv-lbl">Export mode</label>
      <select id="pmVfxExportMode" class="pm-vfx-pull-sel">
        <option value="aces_plate">ACES EXR plate (default)</option>
        <option value="rec709_preview">Rec709 preview only</option>
        <option value="sidecar_only">Sidecars only (skip EXR)</option>
      </select>
    </div>
    <div class="pm-vfx-pull-adv-row" style="align-items:flex-start;">
      <label class="pm-vfx-pull-adv-lbl" style="padding-top:3px;">Match via</label>
      <div class="pm-vfx-pull-chk-group" id="pmVfxMatchMethods">
        <label class="pm-vfx-pull-chk"><input type="checkbox" value="timecode"> Timecode</label>
        <label class="pm-vfx-pull-chk"><input type="checkbox" value="reel"> Reel name</label>
        <label class="pm-vfx-pull-chk"><input type="checkbox" value="clipname"> Clip name</label>
        <label class="pm-vfx-pull-chk"><input type="checkbox" value="duration"> Duration</label>
        <label class="pm-vfx-pull-chk pm-vfx-pull-chk--ocr"><input type="checkbox" value="ocr_burnin"> OCR burn-in <span class="pm-vfx-pull-chk-note">(reads video frame)</span></label>
      </div>
    </div>
  </div>

  <div class="pm-vfx-ocf-toolbar" id="pmVfxOcfToolbar">
    <button class="pm-vfx-ocf-btn pm-vfx-ocf-btn--smart" id="pmVfxSmartLinkBtn" type="button" title="Find your camera files and link them to every shot automatically">⚡ Smart Link OCF</button>
    <button class="pm-vfx-ocf-btn pm-vfx-ocf-btn--alt" id="pmVfxLinkLibraryBtn" type="button" title="Link shots using your scanned media library (no folder pick). Filename/reel matches — scan a folder for timecode-exact matches.">📚 Link from Library</button>
    <button class="pm-vfx-ocf-btn pm-vfx-ocf-btn--secondary" id="pmVfxRelinkOcfBtn" type="button" title="Pick a different camera-files folder">Change folder…</button>
    <button class="pm-vfx-ocf-btn pm-vfx-ocf-btn--secondary" id="pmVfxRescanOcfBtn" type="button" title="Re-scan the current camera-files folder (use after adding or replacing files)">Rescan</button>
    <button class="pm-vfx-ocf-btn pm-vfx-ocf-btn--danger"    id="pmVfxClearOcfBtn"  type="button" title="Unlink all camera files and start over">Clear OCF</button>
    <span class="pm-vfx-ocf-summary" id="pmVfxOcfSummary"></span>
  </div>
  <div class="pm-vfx-ocf-friendly" id="pmVfxOcfFriendly" style="display:none;"></div>

  <div class="pm-vfx-pull-table-wrap" id="pmVfxPullTableWrap" style="display:none;">
    <div class="pm-vfx-pull-table-hdr">
      <label class="pm-vfx-pull-sel-all-wrap" title="Select / deselect all shots for export">
        <input type="checkbox" id="pmVfxSelAll" checked>
      </label>
      <span id="pmVfxTableSummary">—</span>
    </div>
    <div class="pm-vfx-pull-table-scroll" id="pmVfxPullTable"></div>
  </div>

  <div class="pm-vfx-pull-export" id="pmVfxPullExport" style="display:none;">
    <div class="pm-vfx-pull-exp-label">EXPORT</div>
    <div class="pm-vfx-export-preflight" id="pmVfxExportPreflight" style="display:none;"></div>
    <div class="pm-vfx-pull-exp-btns">
      <button class="pm-vfx-pull-exp-btn" id="pmVfxExpFdl" title="FDL — Frame Decision List. Reframe / crop / scale metadata for the comp (ASC-FDL JSON).">FDL</button>
      <button class="pm-vfx-pull-exp-btn" id="pmVfxExpAmf" title="AMF — Academy Color Metadata File. The ACES color recipe (IDT + look) for each plate.">AMF</button>
      <button class="pm-vfx-pull-exp-btn pm-vfx-pull-exp-btn--primary" id="pmVfxExpPackage" title="Export the full VFX pull package — plates, sidecars (FDL/AMF), frame maps, Nuke/AE scripts, and QC report.">⬇ Pull Package</button>
      <button class="pm-vfx-pull-exp-btn" id="pmVfxExpQc" title="QC Report — per-shot quality-control summary (match, color, frames) as JSON/HTML.">QC Report</button>
      <button class="pm-vfx-pull-exp-btn" id="pmVfxExpContactSheet" title="QC Sheet — per-shot QT-vs-OCF contact sheet, print to PDF.">QC Sheet</button>
      <button class="pm-vfx-pull-exp-btn" id="pmVfxExpNuke" title="Nuke — generate a Nuke read/conform script for the pulled plates.">Nuke</button>
    </div>
  </div>
</div>
`;
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function _wireListeners() {
  if (_wired) return;
  _wired = true;

  _on('pmVfxPullGoBtn', 'click', () => { if (!_running) _runAnalysis(); });

  _on('pmVfxPullAdvBtn', 'click', () => {
    const adv = document.getElementById('pmVfxPullAdv');
    if (!adv) return;
    adv.style.display = adv.style.display === 'none' ? '' : 'none';
  });

  // Browse = pick a writable output folder via the companion file picker.
  // nativeOpenOutputFolder is the WRONG helper for this — it reveals an
  // existing path in Finder/Explorer. Use nativePickFolder to actually pick.
  _on('pmVfxOutputBrowseBtn', 'click', async () => {
    try {
      const result = await nativePickFolder('Select VFX Pull output folder');
      const resultData = _nativePayload(result);
      const folderPath = resultData?.path || resultData?.folderPath;
      if (folderPath) {
        _settings.outputFolder = folderPath;
        const inp = document.getElementById('pmVfxOutputFolder');
        if (inp) inp.value = folderPath;
        _persistState();
      }
    } catch (e) {
      console.warn('[VfxPull] Browse output folder failed:', e);
    }
  });

  // Open = reveal the already-chosen folder. Separate button (#pmVfxOutputOpenBtn
  // in the HTML if present); keep nativeOpenOutputFolder for that path.
  _on('pmVfxOutputOpenBtn', 'click', async () => {
    if (!_settings.outputFolder) return;
    try { await nativeOpenOutputFolder(_settings.outputFolder); }
    catch (e) { console.warn('[VfxPull] Reveal output folder failed:', e); }
  });

  // Settings sync
  _onChange('pmVfxHandles', v => { _settings.handles = parseInt(v, 10); _persistState(); });
  _onChange('pmVfxFrameStart', v => { _settings.frameStart = parseInt(v, 10) || 1001; _persistState(); });
  _onChange('pmVfxPlateFormat', v => { _settings.plateFormat = v; _persistState(); });
  _onChange('pmVfxPullMode',      v => { _settings.pullMode      = v; _persistState(); _syncOdtRow(); });
  _onChange('pmVfxOdtTransform',  v => { _settings.odtId         = v; _persistState(); });
  _onChange('pmVfxRenderEngine',  v => { _settings.renderEngine  = v; _persistState(); });
  _onChange('pmVfxOutputFolder', v => { _settings.outputFolder = v; _persistState(); });

  // Spec #6 new settings — target resolution + bake toggles + sidecar
  // toggles + export mode. _onChange passes a boolean for checkboxes and
  // the string value for selects.
  _onChange('pmVfxTargetRes',  v => { _settings.targetResolution    = v;      _persistState(); });
  _onChange('pmVfxBakeSpeed',  v => { _settings.bakeSpeed           = !!v;    _persistState(); });
  _onChange('pmVfxBakeReframe',v => { _settings.bakeReframe         = !!v;    _persistState(); });
  _onChange('pmVfxGenAmf',     v => { _settings.generateAmf         = !!v;    _persistState(); });
  _onChange('pmVfxGenFdl',     v => { _settings.generateFdl         = !!v;    _persistState(); });
  _onChange('pmVfxGenNuke',    v => { _settings.generateNukeHandoff = !!v;    _persistState(); });
  _onChange('pmVfxExportMode', v => { _settings.exportMode          = v;      _persistState(); });

  // Match method checkboxes
  const matchMethodsEl = document.getElementById('pmVfxMatchMethods');
  if (matchMethodsEl) {
    matchMethodsEl.addEventListener('change', () => {
      _settings.matchMethods = Array.from(
        matchMethodsEl.querySelectorAll('input[type="checkbox"]:checked')
      ).map(cb => cb.value);
      _persistState();
    });
  }

  // ── ACES 2.0 ODT (Review Proxy) ─────────────────────────────────────────────
  _populateOdtTransforms();
  _syncOdtRow();
  _on('pmVfxRenderReviewBtn', 'click', () => { if (!_running) _runReviewProxies(_state.jobs); });

  // Export buttons

  const verifyModes = document.getElementById('pmVfxVerifyModes');
  if (verifyModes) {
    verifyModes.addEventListener('click', e => {
      const btn = e.target.closest('[data-mode]');
      if (!btn) return;
      _verifyMode = btn.dataset.mode || 'side';
      verifyModes.querySelectorAll('.pm-vfx-verify-mode').forEach(b => b.classList.toggle('is-active', b === btn));
      _renderVerifyStation();
    });
  }
  _on('pmVfxCaptureQtBtn', 'click', _captureQtRefFrame);
  _on('pmVfxExtractOcfBtn', 'click', _extractVerifyOcfFrame);
  _on('pmVfxContactSheetBtn', 'click', _runSevenFrameCheck);
  _on('pmVfxVisualRelinkBtn', 'click', () => {
    const { idx } = _currentVerifyRow();
    if (idx != null && idx >= 0) _visualRelinkShot(idx);
  });
  _on('pmVfxApproveLinkBtn', 'click', _approveCurrentLink);

  _on('pmVfxExpFdl', 'click', _exportFDL);
  _on('pmVfxExpAmf', 'click', _exportAMF);
  _on('pmVfxExpPackage', 'click', _exportPullPackage);
  _on('pmVfxExpQc', 'click', _exportQcReport);
  _on('pmVfxExpContactSheet', 'click', _exportContactSheet);
  _on('pmVfxExpNuke', 'click', _exportNuke);

  // OCF toolbar buttons
  _on('pmVfxSmartLinkBtn', 'click', () => { if (!_running) _smartLinkOcf(); });
  _on('pmVfxLinkLibraryBtn', 'click', () => { if (!_running) _linkFromLibrary(); });
  _on('pmVfxRelinkOcfBtn', 'click', () => _chooseAndRelinkOcf());
  _on('pmVfxRescanOcfBtn', 'click', async () => {
    if (!_state.ocfFolder) { _chooseAndRelinkOcf(); return; }
    _ocfProbeCache.result = null;
    try {
      await _scanOcfFolder(_state.ocfFolder);
      await _matchOcfToCurrentEvents();
      await _rebuildVfxPullArtifactsFromMatches();
      _persistState();
      _renderShotTable();
      _updateOcfSummary();
      _updateWfDots();
    } catch (e) {
      _setStatus(`Rescan failed: ${e?.message || e}`);
      console.error('[VfxPull] Rescan error:', e);
    }
  });
  _on('pmVfxClearOcfBtn', 'click', () => {
    _state.ocfFolder    = null;
    _state.ocfFromLibrary = false;
    _state.ocfFiles     = [];
    _state.matchResults = [];
    _state.normalisedRows = [];
    _state.jobs         = [];
    _state.fdls         = [];
    _state.amfXmls      = [];
    _state.qcShots      = [];
    _state.manualLinks  = {};
    _state.selectedJobs = new Set();
    _ocfProbeCache.path   = null;
    _ocfProbeCache.result = null;
    _persistState();
    _renderShotTable();
    _updateWfDots();
    _updateOcfSummary();
  });

  // Shot row click → detail flyout (event delegation on the scroll container).
  // Per-row action buttons intercept before the row-detail open fires.
  const tableEl = document.getElementById('pmVfxPullTable');
  if (tableEl) {
    tableEl.addEventListener('click', e => {
      const actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.preventDefault();
        e.stopPropagation();
        const idx = parseInt(actionBtn.dataset.idx, 10);
        if (!Number.isFinite(idx)) return;
        const action = actionBtn.dataset.action;
        if (action === 'manual-relink')     _manualRelinkShot(idx);
        if (action === 'clear-manual-link') _clearManualRelink(idx);
        // data-action="relink" is never emitted by the shot table HTML; dead branch removed.
        return;
      }
      // Don't open shot detail when clicking a checkbox or its label
      if (e.target.closest('.pm-vfx-pull-row-sel-wrap')) return;
      const rowEl = e.target.closest('[data-idx]');
      if (rowEl) { const idx = parseInt(rowEl.dataset.idx, 10); _selectVerifyShot(idx); _openShotDetail(idx); }
    });

    // Per-row selection checkboxes
    tableEl.addEventListener('change', e => {
      const cb = e.target.closest('.pm-vfx-pull-sel');
      if (!cb) return;
      const idx = parseInt(cb.dataset.sel, 10);
      if (!Number.isFinite(idx)) return;
      if (cb.checked) _state.selectedJobs.add(idx);
      else            _state.selectedJobs.delete(idx);
      _renderShotTable();
    });
  }

  // Select-all checkbox (lives in the header, outside the table scroll element)
  const selAllEl = document.getElementById('pmVfxSelAll');
  if (selAllEl) {
    selAllEl.addEventListener('change', () => {
      if (selAllEl.checked) {
        _state.selectedJobs = new Set(_state.jobs.map((_, i) => i));
      } else {
        _state.selectedJobs.clear();
      }
      _renderShotTable();
    });
  }
}

// ---------------------------------------------------------------------------
// Manual relink — opens nativePickMediaFile, re-scores via matchOcfToEvent,
// stamps _manualLink:true so the row badge + export log can flag it. Updates
// the matchResults / normalisedRows / jobs in place so downstream consumers
// (FDL/AMF/QC/CSV/export) immediately see the new path.
// ---------------------------------------------------------------------------
async function _manualRelinkRow(idx) {
  const result = _state.matchResults[idx];
  const job    = _state.jobs[idx];
  if (!result || !job) return;
  const event = result.event || {};

  let pickRes;
  try {
    pickRes = await nativePickMediaFile(
      `Pick OCF for ${job.shotId || event.shotName || event.clipName || 'shot'}`,
      // Source-camera + container formats. Conservative — matches the OCF
      // probe's SUPPORTED_SOURCE_EXTENSIONS on the companion side.
      { extensions: ['mov', 'mp4', 'mxf', 'r3d', 'ari', 'arx', 'braw', 'dng', 'crm', 'tif', 'tiff', 'dpx', 'exr'] },
    );
  } catch (e) {
    console.warn('[VfxPull] relink picker failed', e);
    _setStatus(`Relink failed: ${e?.message || e}`);
    return;
  }

  const path = pickRes?.result?.path || pickRes?.result?.filePath || '';
  if (!path) return;

  // Build a thin OCF descriptor that matchOcfToEvent understands. The real
  // probe carries duration/fps/reel/cameraModel; the manual pick only gives
  // us the path + filename, so we let the matcher score on the data it has
  // and rely on the user's intent (the click) as a strong override.
  const manualOcf = {
    name:  path.split('/').pop(),
    path,
    reel:  '',
    cameraModel: '',
    durationFrames: 0,
    fps:   event.fps || 24,
    _manualPick: true,
  };

  let scored;
  try {
    scored = matchOcfToEvent(manualOcf, event, { handleFrames: _settings.handles });
  } catch (e) {
    console.warn('[VfxPull] re-score failed', e);
    scored = null;
  }

  // Manual pick beats automatic matching by definition — force SAFE status
  // and a manual-link confidence floor of 100% so the row goes green.
  const newMatch = {
    status:        MATCH_STATUS?.SAFE || 'SAFE',
    confidence:    100,
    matchedPath:   path,
    reasons:       [...(scored?.match?.reasons || []), 'Manually selected by user'],
    warnings:      scored?.match?.warnings || [],
    cameraModel:   scored?.match?.cameraModel || manualOcf.cameraModel || '',
    _manualLink:   true,
  };

  // Update in-place so the next render reads the new data.
  result.match = newMatch;
  result.ocf   = manualOcf;
  job.sourcePath = path;
  if (job.metadata) {
    job.metadata.matchStatus     = newMatch.status;
    job.metadata.matchConfidence = newMatch.confidence;
    job.metadata.manualLink      = true;
  }
  // Persist so the manual relink survives re-match / reopen.
  if (!_state.manualLinks) _state.manualLinks = {};
  _state.manualLinks[_eventKey(event)] = {
    path, ocf: manualOcf, match: newMatch, linkedAt: new Date().toISOString(),
  };
  _state.normalisedRows = _state.matchResults.map((r, i) => normalizeVfxPullRow(r, _state.jobs[i]));
  _renderShotTable();
  _updateOcfSummary();
  _setStatus(`Relinked: ${manualOcf.name}`);
  _persistState();

  // Push the manually picked path back into Resolve so the media pool item
  // comes online immediately. Clears isOffline so the OFLN badge disappears
  // without requiring a full re-analysis.
  if (_state.resolveConnected && event._fromResolve) {
    try {
      await _sendCompanionAction('resolve.reconnectOcf', {
        matches: [{
          clipName:      job.shotId || event.clipName || '',
          srcIn:         event.srcIn || event.recIn || '',
          newPath:       path,
          mediaItemPath: event.sourcePath || '',
        }],
      }, 15000);
      event.isOffline = false;
      _state.normalisedRows = _state.matchResults.map((r, i) => normalizeVfxPullRow(r, _state.jobs[i]));
      _renderShotTable();
      _updateOcfSummary();
    } catch (e) {
      console.warn('[VfxPull] Resolve relink push failed:', e);
    }
  }
}

// ---------------------------------------------------------------------------
// Sprint 4: link a media-library search result (Sprint 3 search box) to the
// currently selected workspace shot. DB-powered MANUAL linking — complements
// the bulk "Link from Library". rec = SQLite row {path, filename, fps, …}.
// ---------------------------------------------------------------------------
function _matchResultIdxForShotKey(key) {
  if (!key) return -1;
  const rows = _state.matchResults || [];
  // recIn (most reliable) → reel+srcIn → shot name.
  if (key.recIn) {
    const i = rows.findIndex(r => (r.event?.recIn || '') === key.recIn);
    if (i >= 0) return i;
  }
  if (key.reel && key.srcIn) {
    const i = rows.findIndex(r => ((r.event?.reel || r.event?.clipName || '') === key.reel)
      && ((r.event?.srcIn || '') === key.srcIn));
    if (i >= 0) return i;
  }
  if (key.shotName) {
    const i = (_state.jobs || []).findIndex((j, n) =>
      String(j?.shotId || j?.shotName || rows[n]?.event?.shotName || '').trim() === key.shotName);
    if (i >= 0) return i;
  }
  return -1;
}

// Find the pull-list shot a library file belongs to, by filename then reel.
function _findShotIdxForOcfFile(rec) {
  const rows = _state.matchResults || [];
  const fn   = String(rec.filename || (rec.path || '').split('/').pop() || '').toLowerCase();
  const stem = fn.replace(/\.[^.]+$/, '');
  // 1. exact source-file / clip-name match
  let i = rows.findIndex(r => {
    const e  = r.event || {};
    const ef = String(e.srcFile || e.clipName || e.name || '').toLowerCase().replace(/\.[^.]+$/, '');
    return ef && (ef === stem);
  });
  if (i >= 0) return i;
  // 2. reel prefix (ARRI A001C001… / card A001…) — but ONLY when it's
  // unambiguous. A roll has many takes; force-linking the first match on a
  // multi-take roll would silently link the WRONG shot. Refuse if >1 candidate.
  const m = String(rec.filename || '').match(/^([A-Z][0-9]{3,4})/i);
  const reel = m ? m[1].toUpperCase() : '';
  if (reel) {
    const matches = [];
    rows.forEach((r, n) => {
      const e = r.event || {};
      if (String(e.reel || e.clipName || '').toUpperCase().startsWith(reel)) matches.push(n);
    });
    if (matches.length === 1) return matches[0];   // unambiguous only
  }
  return -1;
}

async function _linkLibraryFileToSelectedShot(rec) {
  if (!rec || !rec.path) return;
  // Prefer an explicitly selected shot; otherwise auto-find the shot this file
  // belongs to (by filename / reel) so a single click "just works".
  const key = (typeof window !== 'undefined' && window._pmGetSelectedVfxShotKey)
    ? window._pmGetSelectedVfxShotKey() : null;
  let idx = key ? _matchResultIdxForShotKey(key) : -1;
  if (idx < 0) idx = _findShotIdxForOcfFile(rec);
  if (idx < 0) {
    _showFriendly('info', `Couldn't find a shot matching "${rec.filename || 'that file'}". Click a shot in the list first, then click the file to force-link it.`);
    return;
  }

  const result = _state.matchResults[idx];
  const job    = _state.jobs[idx];
  if (!result || !job) return;
  const event  = result.event || {};

  const ocf = {
    name:           rec.filename || String(rec.path).split('/').pop(),
    path:           rec.path,
    reel:           '',
    cameraModel:    rec.codec || '',
    durationFrames: Number(rec.durationFrames) || 0,
    fps:            Number(rec.fps) || event.fps || 24,
    tcKnown:        false,            // library files carry no container timecode
    _manualPick:    true,
  };
  // User explicitly chose this file — force a SAFE/100% manual link.
  result.match = {
    status:      MATCH_STATUS?.SAFE || 'SAFE',
    confidence:  100,
    matchedPath: rec.path,
    reasons:     ['Manually linked from media library'],
    warnings:    [],
    cameraModel: ocf.cameraModel,
    _manualLink: true,
  };
  result.ocf     = ocf;
  job.sourcePath = rec.path;
  if (job.metadata) {
    job.metadata.matchStatus     = result.match.status;
    job.metadata.matchConfidence = 100;
    job.metadata.manualLink      = true;
  }
  // Persist as a manual link so it survives re-match / reopen (otherwise
  // _matchOcfToCurrentEvents or _restoreLibraryLinksIfNeeded wipes it).
  if (!_state.manualLinks) _state.manualLinks = {};
  _state.manualLinks[_eventKey(event)] = {
    path: rec.path, ocf, match: result.match, linkedAt: new Date().toISOString(),
  };
  _state.normalisedRows = _state.matchResults.map((r, i) => normalizeVfxPullRow(r, _state.jobs[i]));
  _renderShotTable();
  _updateOcfSummary();
  _persistState();
  try { window._pmRefreshVfxWorkspaceList?.(); } catch {}
  const shotLabel = job.shotId || job.shotName || event.shotName || event.reel || `shot ${idx + 1}`;
  _setStatus(`Linked ${ocf.name} → ${shotLabel}`);
  _showFriendly('ok', `✓ Linked ${ocf.name} → ${shotLabel} (manual). Shows MAN — confirm timecode before final pull.`);
}
window._pmLinkLibraryFileToSelectedShot = _linkLibraryFileToSelectedShot;

// ---------------------------------------------------------------------------
// Visual-fallback OCF relink — when reel/TC matching fails, find the right OCF
// by image content using the perceptual-fingerprint engine.
// ---------------------------------------------------------------------------
async function _visualRelinkShot(idx) {
  const result = _state.matchResults[idx];
  const job    = _state.jobs[idx];
  if (!result || !job) { _setStatus('No shot selected for visual relink'); return; }
  const event = result.event || {};
  const projectMeta = await _providers.getProjectMeta?.() || {};
  const refAssetId  = projectMeta.refVideoAssetId || _state.refAssetId || null;
  const candidates  = (_state.ocfFiles || []).filter(c => c && c.path);

  if (!refAssetId)        { _setStatus('Visual relink needs a QT reference loaded'); return; }
  if (!event.recIn)       { _setStatus('Shot has no editorial timecode to match against'); return; }
  if (!candidates.length) { _setStatus('No camera files to search. Link an OCF folder (Change folder…) or 📚 Link from Library first.'); return; }

  const CAP = 60;
  const pool = candidates.slice(0, CAP);
  const capped = candidates.length > CAP;

  // Reference fingerprint: the editorial frame this shot should contain.
  _setStatus('Visual match: reading reference frame…');
  let refFp = null;
  try {
    const rr  = await nativeGrabThumbnailAtTimecode(refAssetId, event.recIn, { width: _FP_W, height: _FP_H, format: 'jpg', mode: 'fast' });
    const url = rr?.dataUrl || rr?.result?.dataUrl || '';
    const img = url ? await _dataUrlToImageData(url, _FP_W, _FP_H) : null;
    if (img) refFp = buildFrameFingerprint(img.data, img.width, img.height);
  } catch { /* fall through */ }
  if (!refFp) { _setStatus('Visual relink: could not read the QT reference frame'); return; }

  // Score each candidate by the best of a couple of sample frames (handles TC
  // drift — the matching action may not sit exactly at srcIn).
  const scored = [];
  for (let n = 0; n < pool.length; n++) {
    const cand = pool[n];
    _setStatus(`Visual match: scanning ${n + 1}/${pool.length}…`);
    let best = 0, sess = null;
    try {
      const open = await sharedMediaOpen(cand.path);
      sess = open?.assetId || open?.sessionId || open?.result?.assetId || open?.result?.sessionId || null;
      if (sess) {
        const dur = Number(cand.durationFrames || 0);
        const f   = Math.round(Number(cand.fps || event.fps || 24));
        const samples = [event.srcIn || '00:00:00:00'];
        if (dur > 4) samples.push(_framesToTC(Math.floor(dur / 2), f));
        for (const tc of samples) {
          const gr  = await nativeGrabThumbnailAtTimecode(sess, tc, { width: _FP_W, height: _FP_H, format: 'jpg', mode: 'fast' });
          const url = gr?.dataUrl || gr?.result?.dataUrl || '';
          const img = url ? await _dataUrlToImageData(url, _FP_W, _FP_H) : null;
          if (img) best = Math.max(best, compareFingerprints(refFp, buildFrameFingerprint(img.data, img.width, img.height)).score);
        }
      }
    } catch { /* candidate unreadable — score 0 */ }
    finally { if (sess) { try { await sharedMediaClose(sess); } catch {} } }
    scored.push({ index: n, score: best, label: cand.name || cand.path.split('/').pop() });
  }

  const pick = pickVisualMatch(scored, { minScore: 60, minMargin: 8 });
  const capNote = capped ? ` · searched first ${CAP} of ${candidates.length}` : '';
  if (pick.confident && pick.best) {
    const cand = pool[pick.best.index];
    _applyVisualRelink(idx, cand, Math.round(pick.best.score));
    _setStatus(`Visual relink → ${cand.name || cand.path.split('/').pop()} (${Math.round(pick.best.score)}% image match)${capNote}`);
  } else {
    const top = pick.ranked.slice(0, 3).map(s => `${s.label} ${Math.round(s.score)}%`).join(', ') || '—';
    _setStatus(`Visual relink not confident — ${pick.reason} Top: ${top}${capNote}`);
  }
}

// Apply a visual match as an in-place relink (mirrors _manualRelinkRow).
function _applyVisualRelink(idx, cand, confidence) {
  const result = _state.matchResults[idx];
  const job    = _state.jobs[idx];
  if (!result || !job) return;
  const event = result.event || {};
  const ocf = {
    name: cand.name || (cand.path || '').split('/').pop(), path: cand.path,
    reel: cand.reel || '', cameraModel: cand.cameraModel || '',
    durationFrames: cand.durationFrames || 0, fps: cand.fps || event.fps || 24,
    _visualMatch: true,
  };
  let scored = null;
  try { scored = matchOcfToEvent(ocf, event, { handleFrames: _settings.handles }); } catch { /* score-less is fine */ }
  result.match = {
    status:      MATCH_STATUS?.SAFE || 'SAFE',
    confidence,
    matchedPath: cand.path,
    reasons:     [...(scored?.match?.reasons || []), `Matched by image content (${confidence}%)`],
    warnings:    scored?.match?.warnings || [],
    cameraModel: scored?.match?.cameraModel || cand.cameraModel || '',
    _visualLink: true,
  };
  result.ocf     = ocf;
  job.sourcePath = cand.path;
  if (job.metadata) {
    job.metadata.matchStatus     = result.match.status;
    job.metadata.matchConfidence = confidence;
    job.metadata.visualLink      = true;
  }
  // Persist so the visual relink survives re-match / reopen.
  if (!_state.manualLinks) _state.manualLinks = {};
  _state.manualLinks[_eventKey(event)] = {
    path: cand.path, ocf, match: result.match, linkedAt: new Date().toISOString(),
  };
  _state.normalisedRows = _state.matchResults.map((r, i) => normalizeVfxPullRow(r, _state.jobs[i]));
  _renderShotTable();
  _renderWorkspaceList();
  _updateOcfSummary();
  _persistState();
}

// ---------------------------------------------------------------------------
// Manual link state helpers
// ---------------------------------------------------------------------------

function _applyManualLinks() {
  const links = _state.manualLinks || {};
  _state.matchResults = _state.matchResults.map(row => {
    const key    = _eventKey(row.event);
    const manual = links[key];
    if (!manual?.path) return row;
    return {
      event: row.event,
      match: {
        ...(manual.match || {}),
        status:       'SAFE',
        confidence:   100,
        matchedPath:  manual.path,
        _manualLink:  true,
        ocfLinkLocked: true,
        reasons:  ['Manual OCF relink restored', ...((manual.match?.reasons)  || [])],
        warnings: (manual.match?.warnings) || [],
      },
      ocf: manual.ocf || row.ocf,
    };
  });
}

// ---------------------------------------------------------------------------
// Smart VFX Pull Setup modal → pull config bridge.
// The modal (vfxPullSettings.js) persists EXR bit-depth / compression and the
// project colorspace via window._pfxVfxSettingsGet(). Until this bridge existed
// nothing consumed those choices, so every pull silently wrote hard-coded
// 16-bit-half / ZIP / ACES2065-1 regardless of what the user picked. This maps
// the modal settings onto the {exr, color} config blocks buildAllExrJobs reads.
// ---------------------------------------------------------------------------
const _EXR_BITDEPTH_MAP = {
  '16-bit Half Float': 'half',
  '32-bit Float':      'float',
};
const _EXR_COLORSPACE_MAP = {
  'ACES Linear AP0 / ACES2065-1': 'ACES2065-1',
  'ACEScct':                      'ACEScct',
  'ACEScg':                       'ACEScg',
  'P3-D65 / PQ':                  'P3-D65',
  'P3-D65 / HLG':                 'P3-D65',
  'Rec.2020 / PQ':                'Rec.2020',
  'Rec.709':                      'Rec.709',
  'sRGB':                         'sRGB',
  'Log3G10 / RWG':                'Log3G10',
  'S-Log3 / S-Gamut3':            'S-Log3',
};

// Reads the Smart VFX Pull Setup modal settings (safe if the modal never
// opened — falls back to the historical hard-coded defaults).
function _readVfxOutputSettings() {
  let s = null;
  try { s = window._pfxVfxSettingsGet && window._pfxVfxSettingsGet(); } catch (e) {}
  s = s || {};
  return {
    format:           s.format || 'EXR',
    exr: {
      bitDepth:    _EXR_BITDEPTH_MAP[s.bitDepth] || 'half',
      compression: String(s.compression || 'ZIP').toLowerCase(),
      channels:    'rgb',
    },
    // outputColorSpace only changes review-proxy output (colorPlanEngine keeps
    // ocf_native / match_editorial plates in ACES2065-1 by design).
    outputColorSpace: _EXR_COLORSPACE_MAP[s.colorspace] || 'ACES2065-1',
  };
}

// ---------------------------------------------------------------------------
// Artifact rebuild — regenerates jobs, normalisedRows, fdls, amfXmls, qcShots
// from the current _state.matchResults without re-running the full analysis.
// Called after any manual relink or OCF folder change.
// ---------------------------------------------------------------------------

async function _rebuildVfxPullArtifactsFromMatches() {
  const projectMeta = await _providers.getProjectMeta?.() || {};
  const [_resWStr, _resHStr] = String(_settings.targetResolution || '3840x2160').split('x');
  const _projNaming = _readProjectNaming();
  const _vfxOut = _readVfxOutputSettings();
  const config = {
    outputBasePath:    _settings.outputFolder || '',
    handleFrames:      _settings.handles,
    frameStart:        _settings.frameStart || 1001,
    resolution:        _settings.targetResolution || '3840x2160',
    plateFormat:       _settings.plateFormat,
    matchMethods:      _settings.matchMethods,
    pullMode:          _settings.pullMode || 'ocf_native',
    bakeGeometry:      !!_settings.bakeReframe,
    exr:   _vfxOut.exr,
    color: { mode: 'aces', outputColorSpace: _vfxOut.outputColorSpace },
    retime: { mode: _settings.bakeSpeed ? 'bake_to_timeline' : 'source_frames_only' },
    reframe: {
      mode: _settings.bakeReframe ? 'baked' : 'none',
      targetWidth:  parseInt(_resWStr, 10) || 3840,
      targetHeight: parseInt(_resHStr, 10) || 2160,
    },
    // Naming template chip values — drives Netflix-spec SHOW_EP_SCENE_SHOT_PLATEID naming
    projectNaming:    _projNaming,
    defaultPlateType: _projNaming.plateCode || 'PL',
  };
  _state.jobs = await buildAllExrJobs(_state.matchResults, config, projectMeta);
  // Select only OCF-matched jobs by default; missing shots must be opted in manually.
  _state.selectedJobs = new Set(
    _state.jobs.map((j, i) => (j.sourcePath || j.status === 'ready' || j.status === 'review') ? i : null)
      .filter(i => i !== null)
  );

  _state.normalisedRows = _state.matchResults.map((r, i) => normalizeVfxPullRow(r, _state.jobs[i]));

  _state.fdls = _state.jobs.map((job, i) => {
    const row = _normalizeMatchRow(_state.matchResults[i], job);
    return buildFDL({ job, matchResult: row, pullMode: _settings.pullMode, projectMeta });
  });

  _state.amfXmls = _state.jobs.map((job, i) => {
    const row = _normalizeMatchRow(_state.matchResults[i], job);
    return buildVfxPullAmf({
      clipName:    row.clipName,
      shotName:    row.shotName,
      filePath:    row.sourcePath,
      tcIn:        job.sourceIn  || row.srcIn,
      tcOut:       job.sourceOut || row.srcOut,
      cameraModel: row.ocf?.cameraModel || job?.metadata?.cameraModel || projectMeta.cameraModel || '',
      cameraProfile: job?.colorPlan?.cameraProfile || job?.metadata?.cameraProfile || '',
      idtUrn:      job?.colorPlan?.idtUrn || job?.metadata?.idtUrn || '',
      mode:        _settings.pullMode,
      outputColorSpace: job?.colorPlan?.outputSpace || config?.color?.outputColorSpace || 'ACES2065-1',
      retime:      job?.retime || null,
      reframe:     job?.reframe || null,
      timeline:    { name: projectMeta.timelineName || '', recIn: row.recIn || job?.metadata?.recIn || '', recOut: row.recOut || job?.metadata?.recOut || '' },
      fps:         job?.fps || projectMeta.fps || null,
      frameStart:  job?.frameStart ?? null,
      targetResolution: job?.renderPlan?.targetResolution || _settings.targetResolution || '',
      extraWarnings: job?.colorPlan?.warnings || [],
    });
  });

  _state.qcShots = _state.jobs.map((job, i) => {
    const row = _normalizeMatchRow(_state.matchResults[i], job);
    return {
      plateName:    _plateName(i),
      shotName:     row.shotName,
      clipName:     row.clipName,
      filePath:     row.sourcePath,
      status:       row.status,
      confidence:   row.confidence,
      warnings:     row.warnings,
      reasons:      row.reasons,
      manual:       row.manual,
      tcIn:         job.sourceIn  || row.srcIn,
      tcOut:        job.sourceOut || row.srcOut,
      // Delivered (rendered) count — must match the export-path QC build so the
      // preview frame count equals what lands on disk. expectedFrameCount is the
      // un-baked SOURCE span and understates retimed/freeze plates.
      frameCount:   job.expectedRenderedFrameCount || job.frameCount || 0,
      reformatScale: job?.reframe?.scale ?? null,
      fdl:          _state.fdls[i]    || null,
      amf:          _state.amfXmls[i] || null,
    };
  });
}

// ---------------------------------------------------------------------------
// OCF relink workflow helpers
// ---------------------------------------------------------------------------

async function _scanOcfFolder(folder) {
  if (!folder) throw new Error('No OCF folder selected.');
  _state.ocfFromLibrary = false;   // a real folder scan carries authoritative timecode
  _setStatus('Scanning OCF folder…');
  const probeResult   = await nativeProbeOcfFolder(folder);
  _state.ocfFiles     = _extractOcfFiles(probeResult);
  _ocfProbeCache.path   = folder;
  _ocfProbeCache.result = probeResult;
  await _enrichOcfFromResolve();
  _setStatus(_state.ocfFiles.length
    ? `${_state.ocfFiles.length} OCF files indexed`
    : 'No OCF files found');
}

// Gap 2: for camera RAW whose container timecode/reel ffprobe couldn't read,
// ask DaVinci Resolve (when connected) for authoritative MediaPool metadata and
// merge it into the OCF index so the matcher can link by timecode/reel.
async function _enrichOcfFromResolve() {
  try {
    if (!window._pmVfxPullResolveConnected?.()) return;
    const need = (_state.ocfFiles || []).filter(f => f?.path && !f.tcKnown && !f.tcIn);
    if (!need.length) return;
    _setStatus('Reading camera metadata from Resolve…');
    const resp  = await nativeResolveProbeClips(need.map(f => f.path));
    const clips = _nativePayload(resp)?.clips || [];
    if (!clips.length) return;
    const byPath = new Map(clips.map(m => [m.path, m]));
    const byBase = new Map(clips.map(m => [String(m.name || '').toLowerCase(), m]));
    let enriched = 0;
    for (const f of _state.ocfFiles) {
      const m = byPath.get(f.path) || byBase.get(String(f.name || '').toLowerCase());
      if (!m) continue;
      if (m.tcIn)       { f.tcIn = m.tcIn; f.tcKnown = true; }
      if (m.tcOut)      f.tcOut = m.tcOut;
      if (m.fps)        f.fps = m.fps;
      if (m.frameCount) f.frameCount = m.frameCount;
      if (m.reel && !f.reel) f.reel = m.reel;
      if (m.camera)     f.camera = m.camera;
      f.metadataSource = 'resolve';
      enriched++;
    }
    if (enriched) _setStatus(`Resolve metadata applied to ${enriched} camera file${enriched === 1 ? '' : 's'}`);
  } catch (e) {
    console.warn('[VfxPull] Resolve OCF metadata enrich failed:', e);
  }
}

async function _matchOcfToCurrentEvents() {
  const events  = await _providers.getEvents?.() || [];
  const markers = await _providers.getMarkers?.() || [];
  const aleMap  = (typeof window !== 'undefined' && (window.__pmGetAleMap?.() || window._pmAleMap)) || null;
  _state.matchResults = matchAllEvents(events, _state.ocfFiles, {
    markers,
    aleMap,
    handleFrames: _settings.handles,
    reelAliases:  _settings.reelAliases || null,
    deduplicate:  true,
    ocrHints:     new Map(),
  });
  _applyManualLinks();

  // Pre-export validation: surface problems (zero-duration, unmatched OCF,
  // missing TC, over-long reels, DF/NDF mismatch) BEFORE the user exports/pulls.
  try {
    _state.validation = validatePullList(events, { matchResults: _state.matchResults });
    if (typeof window !== 'undefined') window.PFX_PULL_VALIDATION = _state.validation;
    const v = _state.validation;
    if (v.hasIssues) {
      const top = v.issues.slice(0, 3).map(x => x.message).join(' · ');
      const blocked = !v.ok ? ' — fix errors before export' : '';
      _setStatus(`⚠ Pre-export check: ${top}${v.issues.length > 3 ? ' …' : ''}${blocked}`);
    }
  } catch (e) {
    console.warn('[VfxPull] pre-export validation failed:', e);
  }

  // Reel-alias auto-suggest: propose links for renamed reels that didn't match.
  try {
    _state.aliasSuggestions = suggestReelAliases(events, _state.ocfFiles, {
      reelAliases: _settings.reelAliases, markers, aleMap,
    });
    if (typeof window !== 'undefined') window.__PFX_VFX_ALIAS_SUGGESTIONS = _state.aliasSuggestions;
    if (_state.aliasSuggestions.length) {
      const s = _state.aliasSuggestions.slice(0, 2).map(x => `${x.editorialReel}→${x.cameraReel}`).join(', ');
      _setStatus(`💡 Reel-alias suggestion: ${s}${_state.aliasSuggestions.length > 2 ? ' …' : ''} — apply to link renamed reels`);
    }
  } catch (e) {
    console.warn('[VfxPull] reel-alias suggest failed:', e);
  }
}

async function _chooseAndRelinkOcf() {
  const picked     = await nativePickOcfFolder();
  const pickedData = _nativePayload(picked);
  const folder     = pickedData?.path || pickedData?.folderPath;
  if (!folder) return;
  _state.ocfFolder = folder;
  try {
    await _scanOcfFolder(folder);
    await _matchOcfToCurrentEvents();
    await _rebuildVfxPullArtifactsFromMatches();
    _persistState();
    _renderShotTable();
    _renderVerifyStation();
    _updateOcfSummary();
    _updateWfDots();
    if (_state.jobs.length > 0) _showExport(true);
  } catch (e) {
    _setStatus(`Relink OCF failed: ${e?.message || e}`);
    console.error('[VfxPull] _chooseAndRelinkOcf error:', e);
  }
}
// Expose for cross-file call from prep_mark.js toolbar button
window._pmChooseAndRelinkOcf = _chooseAndRelinkOcf;

// Reel-alias control (editorial reel → camera reel, e.g. "REEL_A" → "A001").
// Persists with project settings and re-runs matching so renamed reels link.
// A future settings UI can build on these; usable programmatically today.
window.PFX_VFX_setReelAlias = async (editorialReel, cameraReel) => {
  const k = String(editorialReel || '').trim();
  if (!k) return false;
  _settings.reelAliases = _settings.reelAliases || {};
  if (cameraReel) _settings.reelAliases[k] = String(cameraReel).trim();
  else delete _settings.reelAliases[k];
  _persistState();
  if (_state.ocfFiles?.length) {
    try {
      await _matchOcfToCurrentEvents();
      await _rebuildVfxPullArtifactsFromMatches();
      _persistState();
      _renderShotTable?.();
      _renderVerifyStation?.();
      _updateOcfSummary?.();
      _updateWfDots?.();
    } catch (e) { console.warn('[VfxPull] re-match after alias change failed:', e); }
  }
  return true;
};
window.PFX_VFX_getReelAliases = () => ({ ...(_settings.reelAliases || {}) });

// Auto-suggested reel aliases (from the last match) + one-click apply.
window.PFX_VFX_getReelAliasSuggestions = () => [...(_state.aliasSuggestions || [])];
window.PFX_VFX_applyReelAliasSuggestions = async () => {
  const sugg = _state.aliasSuggestions || [];
  if (!sugg.length) return 0;
  _settings.reelAliases = _settings.reelAliases || {};
  for (const s of sugg) _settings.reelAliases[s.editorialReel] = s.cameraReel;
  _persistState();
  if (_state.ocfFiles?.length) {
    try {
      await _matchOcfToCurrentEvents();
      await _rebuildVfxPullArtifactsFromMatches();
      _persistState();
      _renderShotTable?.();
      _renderVerifyStation?.();
      _updateOcfSummary?.();
      _updateWfDots?.();
    } catch (e) { console.warn('[VfxPull] apply alias suggestions failed:', e); }
  }
  return sugg.length;
};

// Path-based relink: called by the OCF drop zone when Electron gives us
// the native FS path of the dropped folder (no dialog needed).
async function _relinkOcfFromPath(folderPath) {
  if (!folderPath) return _chooseAndRelinkOcf();
  _state.ocfFolder = folderPath;
  try {
    await _scanOcfFolder(folderPath);
    await _matchOcfToCurrentEvents();
    await _rebuildVfxPullArtifactsFromMatches();
    _persistState();
    _renderShotTable();
    _renderVerifyStation();
    _updateOcfSummary();
    _updateWfDots();
    if (_state.jobs.length > 0) _showExport(true);
  } catch (e) {
    _setStatus(`Relink OCF failed: ${e?.message || e}`);
    console.error('[VfxPull] _relinkOcfFromPath error:', e);
    throw e;
  }
}
window._pmRelinkOcfFromPath = _relinkOcfFromPath;

// ===========================================================================
// Smart Link OCF — one-click, non-technical guided linking.
//
// Flow for the user:
//   1. Click "⚡ Smart Link OCF"  → pick the camera-files folder once.
//   2. PostFlowX scans, matches every shot, and links the confident ones
//      automatically (SAFE tier = exact reel + timecode, or matching UMID).
//   3. Only the uncertain shots are shown — one at a time, full screen, with a
//      QT-reference vs camera-file comparison and big Yes / No buttons.
//
// No tables, no scores, no jargon, and DaVinci Resolve is NOT required —
// everything works from the probed folder alone.
// ===========================================================================

function _showFriendly(kind, text) {
  if (!text) return;
  // Inline banner in the settings toolbar (when that view is mounted)…
  const el = document.getElementById('pmVfxOcfFriendly');
  if (el) {
    el.style.display = '';
    el.className = `pm-vfx-ocf-friendly is-${kind}`;
    el.textContent = text;
  }
  // …plus an always-visible toast so it reads in the Workspace view too.
  _smartToast(kind, text);
  _setStatus(text);
}

// Lightweight top-center toast — visible regardless of which VFX Pull view is up.
let _swToastTimer = null;
function _smartToast(kind, text) {
  _ensureWizardCss();
  let t = document.getElementById('pmSwToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'pmSwToast';
    document.body.appendChild(t);
  }
  t.className = `pm-sw-toast is-${kind} show`;
  t.textContent = text;
  if (_swToastTimer) clearTimeout(_swToastTimer);
  // Errors linger; success/info auto-dismiss.
  _swToastTimer = setTimeout(() => { t.classList.remove('show'); }, kind === 'error' ? 9000 : 5500);
}

// Mark a shot as linked-and-confirmed using both approval stores so the shot
// table, the workspace verify gate, and the EXR gate all agree.
function _markShotApproved(idx, { auto = false } = {}) {
  _verifyData[idx] = { ...(_verifyData[idx] || {}), approved: true,
    approvedAt: new Date().toISOString(), autoApproved: auto };
  _wsVerifyStatus[idx] = 'approved';
}

// Sprint 4 (DB-powered linking): link shots directly against the scanned SQLite
// media library — no folder pick / re-scan. Library candidates carry no container
// timecode, so matches are filename/reel-based (flagged for TC confirmation).
async function _linkFromLibrary() {
  if (_running) return;
  try {
    const n = await libraryCount();
    if (n <= 0) {
      _showFriendly('info', 'Your media library is empty. Scan a folder once (Smart Link OCF) — scanned files are remembered for next time.');
      return;
    }
    _setStatus('Loading camera files from media library…');
    const lib = await loadOcfFilesFromLibrary();
    if (!lib.ok || !lib.files.length) {
      _showFriendly('error', lib.error || 'No camera files in the media library yet.');
      return;
    }
    _state.ocfFiles  = lib.files;
    _state.ocfFolder = '(media library)';
    _state.ocfFromLibrary = true;
    _setStatus('Matching shots against media library…');
    await _matchOcfToCurrentEvents();
    await _rebuildVfxPullArtifactsFromMatches();

    const results = _state.matchResults || [];
    let autoLinked = 0;
    const reviewQueue = [];
    results.forEach((r, i) => {
      const path = r?.match?.matchedPath || r?.ocf?.path || '';
      if (r?.match?.status === MATCH_STATUS.SAFE && path) { _markShotApproved(i, { auto: true }); autoLinked++; }
      else reviewQueue.push(i);
    });
    _persistState();
    _renderShotTable();
    _renderVerifyStation();
    _updateOcfSummary();
    _updateWfDots();
    if (_state.jobs.length > 0) _showExport(true);

    const total = results.length;
    _showFriendly('info', `📚 Linked ${autoLinked} of ${total} shot${total === 1 ? '' : 's'} from ${lib.files.length} library file${lib.files.length === 1 ? '' : 's'} by filename/reel. ${reviewQueue.length ? `${reviewQueue.length} need a quick look — confirm timecode, or scan the OCF folder for exact matches.` : 'Confirm timecode before final pull, or scan the OCF folder for exact matches.'}`);
    if (reviewQueue.length) _openSmartWizard(reviewQueue, autoLinked, total);
  } catch (e) {
    _showFriendly('error', `Link from Library couldn't finish: ${e?.message || e}`);
    console.error('[VfxPull] _linkFromLibrary error:', e);
  }
}
window._pmLinkFromLibrary = _linkFromLibrary;

async function _smartLinkOcf() {
  if (_running) return;
  try {
    // 1. Make sure we have an OCF folder with indexed files. Pick once if not.
    if (!_state.ocfFolder || !(_state.ocfFiles || []).length) {
      // Sprint 4 (DB-powered linking): before asking for a folder, try the
      // SQLite media library populated by earlier scans. Lets the user link
      // against previously-scanned camera files with no re-scan.
      try {
        if (await libraryCount() > 0) {
          _setStatus('Loading camera files from media library…');
          const lib = await loadOcfFilesFromLibrary();
          if (lib.ok && lib.files.length) {
            _state.ocfFiles = lib.files;
            _state.ocfFolder = _state.ocfFolder || '(media library)';
            _state.ocfFromLibrary = true;
            _showFriendly('info', `Using ${lib.files.length} camera file${lib.files.length === 1 ? '' : 's'} from your media library. (Scan a folder if you need timecode-exact matches.)`);
          }
        }
      } catch (e) { console.warn('[VfxPull] library seed failed:', e); }
    }
    if (!_state.ocfFolder || !(_state.ocfFiles || []).length) {
      _showFriendly('info', 'Choose the folder that holds your camera files (OCF)…');
      const picked     = await nativePickOcfFolder();
      const pickedData = _nativePayload(picked);
      const folder     = pickedData?.path || pickedData?.folderPath;
      if (!folder) {                       // user cancelled the picker
        const fr = document.getElementById('pmVfxOcfFriendly');
        if (fr) fr.style.display = 'none';
        return;
      }
      _state.ocfFolder = folder;
      await _scanOcfFolder(folder);
    }
    if (!(_state.ocfFiles || []).length) {
      _showFriendly('error', "No camera files found in that folder. Pick the folder that holds your OCF / camera originals (.mxf, .r3d, .ari, .mov…).");
      return;
    }

    // 2. Match every shot and build the downstream pull artifacts.
    _setStatus('Smart-linking camera files…');
    await _matchOcfToCurrentEvents();
    await _rebuildVfxPullArtifactsFromMatches();

    // 3. Auto-approve the confident (SAFE) matches; queue the rest for review.
    const results = _state.matchResults || [];
    let autoLinked = 0;
    const reviewQueue = [];
    results.forEach((r, i) => {
      const path = r?.match?.matchedPath || r?.ocf?.path || '';
      if (r?.match?.status === MATCH_STATUS.SAFE && path) {
        _markShotApproved(i, { auto: true });
        autoLinked++;
      } else {
        reviewQueue.push(i);   // REVIEW_NEEDED / NOT_RECOMMENDED / MISSING
      }
    });

    _persistState();
    _renderShotTable();
    _renderVerifyStation();
    _updateOcfSummary();
    _updateWfDots();
    if (_state.jobs.length > 0) _showExport(true);

    // 4. Plain-language result, then walk the user through the uncertain shots.
    const total = results.length;
    if (!reviewQueue.length) {
      _showFriendly('ok', `✓ All ${total} shot${total === 1 ? '' : 's'} linked automatically — you're ready to pull.`);
      return;
    }
    _showFriendly('info', `✓ ${autoLinked} of ${total} shots linked automatically. ${reviewQueue.length} need a quick look — opening them now…`);
    _openSmartWizard(reviewQueue, autoLinked, total);
  } catch (e) {
    _showFriendly('error', `Smart Link couldn't finish: ${e?.message || e}`);
    console.error('[VfxPull] _smartLinkOcf error:', e);
  }
}
window._pmSmartLinkOcf = _smartLinkOcf;

// ── Guided review wizard ─────────────────────────────────────────────────────

let _sw = { queue: [], pos: 0, autoLinked: 0, total: 0, el: null, busy: false, reqSeq: 0 };

function _ensureWizardCss() {
  if (document.getElementById('pmSwCss')) return;
  const s = document.createElement('style');
  s.id = 'pmSwCss';
  s.textContent = `
  .pm-vfx-ocf-btn--smart{background:#2172E3;color:#fff;border:none;font-weight:700;box-shadow:0 1px 0 rgba(255,255,255,.12) inset,0 2px 8px rgba(33,114,227,.35);}
  .pm-vfx-ocf-btn--smart:hover{filter:brightness(1.08);}
  .pm-vfx-ocf-friendly{margin:6px 0 2px;font-size:12px;font-weight:600;border-radius:7px;padding:7px 11px;line-height:1.4;}
  .pm-vfx-ocf-friendly.is-info{background:rgba(33,114,227,.12);color:#a8c4ff;border:1px solid rgba(33,114,227,.3);}
  .pm-vfx-ocf-friendly.is-ok{background:rgba(10,163,86,.16);color:#7fe3ac;border:1px solid rgba(10,163,86,.35);}
  .pm-vfx-ocf-friendly.is-error{background:rgba(232,90,90,.14);color:#ffb4b4;border:1px solid rgba(232,90,90,.35);}
  .pm-sw-ov{position:fixed;inset:0;z-index:9000;background:rgba(8,8,14,.86);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;font:13px -apple-system,system-ui,sans-serif;}
  .pm-sw-card{width:min(1040px,94vw);max-height:92vh;overflow:auto;background:#14141b;border:1px solid rgba(255,255,255,.08);border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.6);padding:22px 26px 26px;}
  .pm-sw-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;}
  .pm-sw-step{font-size:12px;font-weight:700;letter-spacing:.04em;color:rgba(228,235,255,.55);text-transform:uppercase;}
  .pm-sw-close{background:none;border:none;color:rgba(228,235,255,.5);font-size:22px;cursor:pointer;line-height:1;}
  .pm-sw-close:hover{color:#fff;}
  .pm-sw-prog{height:5px;border-radius:3px;background:rgba(255,255,255,.08);margin:8px 0 18px;overflow:hidden;}
  .pm-sw-prog-bar{height:100%;background:#2172E3;transition:width .25s ease;}
  .pm-sw-shot{font-size:21px;font-weight:800;color:#f2f5ff;margin:0 0 3px;}
  .pm-sw-q{font-size:14px;color:rgba(228,235,255,.75);margin:0 0 16px;}
  .pm-sw-q b{color:#fff;}
  .pm-sw-frames{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;}
  .pm-sw-pane{background:#0c0c12;border:1px solid rgba(255,255,255,.07);border-radius:11px;overflow:hidden;display:flex;flex-direction:column;}
  .pm-sw-pane-lbl{font-size:10.5px;font-weight:800;letter-spacing:.07em;text-transform:uppercase;color:rgba(228,235,255,.5);padding:8px 11px 6px;}
  .pm-sw-pane-img{width:100%;aspect-ratio:16/9;object-fit:cover;background:#000;display:block;}
  .pm-sw-pane-empty{aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;text-align:center;color:rgba(228,235,255,.4);font-size:12px;padding:12px;}
  .pm-sw-pane-meta{font-size:11px;color:rgba(228,235,255,.7);padding:7px 11px;border-top:1px solid rgba(255,255,255,.05);word-break:break-all;}
  .pm-sw-why{background:rgba(124,92,255,.1);border:1px solid rgba(124,92,255,.22);border-radius:9px;padding:9px 13px;font-size:12px;color:#cfc4ff;margin-bottom:18px;}
  .pm-sw-why .pm-sw-why-h{font-weight:700;color:#fff;}
  .pm-sw-actions{display:flex;gap:10px;flex-wrap:wrap;}
  .pm-sw-btn{flex:1;min-width:150px;border:none;border-radius:10px;padding:14px 16px;font-size:14px;font-weight:700;cursor:pointer;transition:filter .12s;}
  .pm-sw-btn:hover{filter:brightness(1.08);}
  .pm-sw-btn--yes{background:#2faa68;color:#fff;}
  .pm-sw-btn--no{background:#2a2a36;color:#e8eaf0;border:1px solid rgba(255,255,255,.12);}
  .pm-sw-btn--skip{background:transparent;color:rgba(228,235,255,.55);border:1px solid rgba(255,255,255,.1);flex:0 0 auto;min-width:110px;}
  .pm-sw-busy{opacity:.5;pointer-events:none;}
  .pm-sw-hint{font-size:11px;color:rgba(228,235,255,.45);margin-top:12px;text-align:center;}
  .pm-sw-toast{position:fixed;top:18px;left:50%;transform:translateX(-50%) translateY(-12px);z-index:9500;max-width:min(640px,90vw);padding:11px 18px;border-radius:10px;font:600 13px -apple-system,system-ui,sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;}
  .pm-sw-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}
  .pm-sw-toast.is-info{background:#2a2350;color:#d8cfff;border:1px solid rgba(124,92,255,.5);}
  .pm-sw-toast.is-ok{background:#13362a;color:#9ff0c4;border:1px solid rgba(10,163,86,.5);}
  .pm-sw-toast.is-error{background:#3a1d1d;color:#ffc2c2;border:1px solid rgba(232,90,90,.5);}
  `;
  document.head.appendChild(s);
}

function _openSmartWizard(queue, autoLinked, total) {
  if (!queue || !queue.length) return;
  _ensureWizardCss();
  _sw = { queue: queue.slice(), pos: 0, autoLinked, total, el: null, busy: false, reqSeq: 0 };

  const ov = document.createElement('div');
  ov.className = 'pm-sw-ov';
  ov.id = 'pmSwOverlay';
  ov.tabIndex = -1;
  ov.innerHTML = `
    <div class="pm-sw-card" role="dialog" aria-modal="true">
      <div class="pm-sw-top">
        <span class="pm-sw-step" id="pmSwStep"></span>
        <button class="pm-sw-close" id="pmSwClose" type="button" title="Close (auto-linked shots stay linked)">×</button>
      </div>
      <div class="pm-sw-prog"><div class="pm-sw-prog-bar" id="pmSwProg" style="width:0%"></div></div>
      <h3 class="pm-sw-shot" id="pmSwShot"></h3>
      <p class="pm-sw-q" id="pmSwQ"></p>
      <div class="pm-sw-frames">
        <div class="pm-sw-pane"><span class="pm-sw-pane-lbl">Editorial reference (QT)</span><div id="pmSwQt" class="pm-sw-pane-empty">Loading…</div><div class="pm-sw-pane-meta" id="pmSwQtMeta">—</div></div>
        <div class="pm-sw-pane"><span class="pm-sw-pane-lbl">Camera file we found (OCF)</span><div id="pmSwOcf" class="pm-sw-pane-empty">Loading…</div><div class="pm-sw-pane-meta" id="pmSwOcfMeta">—</div></div>
      </div>
      <div class="pm-sw-why" id="pmSwWhy"></div>
      <div class="pm-sw-actions" id="pmSwActions"></div>
      <div class="pm-sw-hint">High-confidence shots were already linked automatically. DaVinci Resolve is not required.</div>
    </div>`;
  document.body.appendChild(ov);
  _sw.el = ov;

  ov.querySelector('#pmSwClose').addEventListener('click', () => _swClose());
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') _swClose(); });
  try { ov.focus(); } catch {}
  _swRenderStep();
}

function _swClose() {
  if (_sw.el) { try { _sw.el.remove(); } catch {} }
  _sw.el = null;
  // Final tally for the toolbar.
  const results = _state.matchResults || [];
  const confirmed = results.filter((_, i) => _verifyData[i]?.approved).length;
  const total = results.length;
  if (confirmed >= total) _showFriendly('ok', `✓ All ${total} shots linked — you're ready to pull.`);
  else _showFriendly('info', `${confirmed} of ${total} shots linked. ${total - confirmed} still need a camera file — use “Change folder…” or link them in the shot list.`);
  _renderShotTable();
  _renderVerifyStation();
  _updateOcfSummary();
  _updateWfDots();
}

function _swCurrentIdx() { return _sw.queue[_sw.pos]; }

function _swAdvance() {
  _sw.pos++;
  if (_sw.pos >= _sw.queue.length) { _swClose(); return; }
  _swRenderStep();
}

// Plain-language explanation of why a shot needs a look.
function _swExplain(row) {
  const st = row?.match?.status;
  const reasons = (row?.match?.reasons || []).filter(Boolean).slice(0, 3);
  if (st === MATCH_STATUS.MISSING) {
    return { headline: 'No camera file found automatically.', detail: 'Pick the matching file yourself, or skip this shot for now.' };
  }
  const why = reasons.length ? reasons.join(' · ') : 'partial match';
  if (st === MATCH_STATUS.NOT_RECOMMENDED) {
    return { headline: 'Low-confidence guess — please check the two frames match.', detail: why };
  }
  return { headline: 'Likely match — please confirm the two frames are the same shot.', detail: why };
}

async function _swRenderStep() {
  const ov = _sw.el; if (!ov) return;
  const idx = _swCurrentIdx();
  const row = _normalizeMatchRow(_state.matchResults[idx], _state.jobs?.[idx]);
  const reqId = ++_sw.reqSeq;

  const shotName = row.shotName || row.clipName || `Shot ${idx + 1}`;
  ov.querySelector('#pmSwStep').textContent = `Shot ${_sw.pos + 1} of ${_sw.queue.length} to check`;
  ov.querySelector('#pmSwProg').style.width = `${Math.round((_sw.pos / _sw.queue.length) * 100)}%`;
  ov.querySelector('#pmSwShot').textContent = shotName;

  const { headline, detail } = _swExplain(row);
  ov.querySelector('#pmSwQ').innerHTML = `<b>${_swEsc(headline)}</b>`;
  ov.querySelector('#pmSwWhy').innerHTML = `<span class="pm-sw-why-h">Why this came up:</span> ${_swEsc(detail)}`;

  const hasOcf = !!row.sourcePath;

  // OCF preview frame: seek to the MIDDLE of the shot's source range, not srcIn.
  // srcIn frequently lands on the clip's slate/clapper at the head (the "OCF is
  // the wrong clip" report) — the midpoint shows the actual action that matches
  // the editorial reference.
  const _fps = Number(row.event?.fps || row.ocf?.fps || 24) || 24;
  const _in  = row.srcIn || row.tcIn || row.event?.srcIn || '00:00:00:00';
  const _out = row.srcOut || row.tcOut || row.event?.srcOut || '';
  let tc = _in;
  try {
    if (_out && _out.includes(':')) {
      const midF = Math.round((_tcToFrames(_in, _fps) + _tcToFrames(_out, _fps)) / 2);
      if (midF > 0) tc = _framesToTC(midF, _fps);
    }
  } catch {}

  const ocfName = hasOcf ? (row.sourceFileName || String(row.sourcePath).split('/').pop()) : '';
  ov.querySelector('#pmSwOcfMeta').textContent = hasOcf ? `${ocfName} · TC ${tc}` : 'No file linked yet';
  ov.querySelector('#pmSwQtMeta').textContent = `Reel ${row.reel || '—'} · TC ${tc}`;

  // Buttons depend on whether we have a candidate file.
  const actions = ov.querySelector('#pmSwActions');
  actions.innerHTML = hasOcf
    ? `<button class="pm-sw-btn pm-sw-btn--yes" id="pmSwYes" type="button">✓ Yes, link this</button>
       <button class="pm-sw-btn pm-sw-btn--no" id="pmSwNo" type="button">Pick a different file…</button>
       <button class="pm-sw-btn pm-sw-btn--skip" id="pmSwSkip" type="button">Skip</button>`
    : `<button class="pm-sw-btn pm-sw-btn--yes" id="pmSwNo" type="button">Pick the camera file…</button>
       <button class="pm-sw-btn pm-sw-btn--skip" id="pmSwSkip" type="button">Can't find it — skip</button>`;
  actions.querySelector('#pmSwYes')?.addEventListener('click', () => _swApprove());
  actions.querySelector('#pmSwNo')?.addEventListener('click', () => _swPickAnother());
  actions.querySelector('#pmSwSkip')?.addEventListener('click', () => _swAdvance());

  // Lazily extract the comparison frames (don't block the buttons). `tc` (the
  // shot midpoint) was computed above and is reused for the OCF preview seek.
  _swSetPane('#pmSwQt', 'Loading…');
  _swSetPane('#pmSwOcf', hasOcf ? 'Loading…' : 'No camera file linked yet.');

  // QT reference still (editorial source file).
  (async () => {
    try {
      let dataUrl = _verifyData[idx]?.qtRef || null;
      // Editorial QT reference = the loaded proxy/QT movie indexed by RECORD frame,
      // resolved the same way as the workspace strip. (Using event.sourcePath at the
      // source TC failed when the per-event source is the camera file or unavailable —
      // that's the "No editorial frame available." case.)
      if (!dataUrl && typeof window._pmGetQtRefStill === 'function') {
        dataUrl = await window._pmGetQtRefStill(row.event, { width: 480 });
      }
      // Last resort: the old per-event source path at the source TC.
      if (!dataUrl && row.event?.sourcePath && window.pfxPlatform?.media) {
        const r = await window.pfxPlatform.media.getStill({ path: row.event.sourcePath, timecode: tc, outputWidth: 480 });
        dataUrl = r?.dataUrl || r?.imageDataUrl || null;
      }
      if (reqId !== _sw.reqSeq) return;
      _swSetPaneImg('#pmSwQt', dataUrl, 'No editorial frame available.');
    } catch { if (reqId === _sw.reqSeq) _swSetPane('#pmSwQt', 'Could not load editorial frame.'); }
  })();

  // OCF candidate still.
  if (hasOcf) {
    (async () => {
      try {
        // Run one preview attempt. Library OCF (no container TC) previews a
        // representative mid-file frame; otherwise seek by the matched source TC.
        const doPreview = async () => {
          const ocfStartTc = (row.ocf?.tcKnown && row.ocf?.tcIn) ? row.ocf.tcIn : (row.ocf?.tcIn || '');
          let frameArg = {};
          if (!row.ocf?.tcKnown && window.pfxPlatform?.media?.getInfo) {
            try {
              const info = await window.pfxPlatform.media.getInfo({ path: row.sourcePath });
              const fc = Number(info?.frameCount ?? info?.data?.frameCount ?? 0) || 0;
              if (fc > 1) frameArg = { sourceFrame: Math.round(fc * 0.5) };
            } catch {}
          }
          return window._pmGetOcfStillPreview({
            ocfPath: row.sourcePath, sourceTc: tc, sourceStartTc: ocfStartTc,
            fps: row.ocf?.fps || 0, ...frameArg,
            width: 480, height: 270,
            resolveConnected: _state.resolveConnected || !!window._pmVfxPullResolveConnected?.(),
          });
        };

        let r = await doPreview();
        if (reqId !== _sw.reqSeq) return;

        // Smart auto-Resolve: sensor-RAW (ARRIRAW/X-OCN/R3D) needs Resolve. Rather
        // than dead-end, connect (launching Resolve in the background if needed)
        // and retry — then it decodes. First RAW shot warms the connection; every
        // shot after is fast (cached + warm engine).
        if (r?.requiresResolve && !r?.resolveAvailable && typeof window._pmEnsureResolveConnected === 'function') {
          _swSetPane('#pmSwOcf', 'Connecting to DaVinci Resolve…');
          const ok = await window._pmEnsureResolveConnected((m) => {
            if (reqId === _sw.reqSeq) _swSetPane('#pmSwOcf', m);
          }).catch(() => false);
          if (reqId !== _sw.reqSeq) return;
          if (ok) {
            _state.resolveConnected = true;
            _swSetPane('#pmSwOcf', 'Rendering frame via Resolve…');
            r = await doPreview();
            if (reqId !== _sw.reqSeq) return;
          } else {
            const err = window._pmResolveConnectLastError?.() || 'Resolve scripting API is unavailable.';
            _swSetPane('#pmSwOcf', `${_swRawLabel(row.sourcePath)} — Resolve opened, but PostFlowX cannot control it yet. ${err}`);
            return;
          }
        }

        const emptyMsg = (r?.requiresResolve && !r?.resolveAvailable)
          ? `${_swRawLabel(row.sourcePath)} — couldn't reach DaVinci Resolve. Open Resolve, then reopen this shot. The link is correct.`
          : (r?.error ? 'Could not preview this file.' : 'No frame returned.');
        _swSetPaneImg('#pmSwOcf', r?.dataUrl, emptyMsg);
      } catch { if (reqId === _sw.reqSeq) _swSetPane('#pmSwOcf', 'Could not preview this file.'); }
    })();
  }
}

function _swSetPane(sel, text) {
  const host = _sw.el?.querySelector(sel); if (!host) return;
  host.outerHTML = `<div id="${sel.slice(1)}" class="pm-sw-pane-empty">${_swEsc(text)}</div>`;
}
function _swSetPaneImg(sel, dataUrl, emptyText) {
  const host = _sw.el?.querySelector(sel); if (!host) return;
  host.outerHTML = dataUrl
    ? `<img id="${sel.slice(1)}" class="pm-sw-pane-img" src="${dataUrl}" alt="frame">`
    : `<div id="${sel.slice(1)}" class="pm-sw-pane-empty">${_swEsc(emptyText)}</div>`;
}
function _swEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
// Format label for the sensor-RAW "needs Resolve" message in the review wizard.
function _swRawLabel(p) {
  switch (String(p || '').toLowerCase().split('.').pop()) {
    case 'r3d':             return 'RED R3D RAW';
    case 'ari': case 'arx': return 'ARRIRAW';
    case 'braw':            return 'Blackmagic RAW';
    case 'crm':             return 'Canon Cinema RAW Light';
    case 'mxf':             return 'RAW MXF (ARRIRAW / X-OCN)';
    case 'dng':             return 'CinemaDNG RAW';
    default:                return 'Camera RAW';
  }
}

async function _swApprove() {
  const idx = _swCurrentIdx();
  _markShotApproved(idx);
  // Lock the candidate as a confirmed link so re-matching won't drop it.
  const row = _state.matchResults[idx];
  if (row?.match) { row.match.ocfLinkLocked = true; }
  _persistState();
  _swAdvance();
}

async function _swPickAnother() {
  if (_sw.busy) return;
  _sw.busy = true;
  const card = _sw.el?.querySelector('.pm-sw-card');
  card?.classList.add('pm-sw-busy');
  const idx = _swCurrentIdx();
  try {
    await _manualRelinkShot(idx);   // native picker + probe + persist (sets SAFE manual link)
    const row = _state.matchResults[idx];
    if (row?.match?.matchedPath) {
      // User chose a file — auto-confirm it and move on.
      _markShotApproved(idx);
      _persistState();
      _sw.busy = false; card?.classList.remove('pm-sw-busy');
      _swAdvance();
      return;
    }
  } catch (e) {
    console.warn('[VfxPull] wizard pick-another failed:', e);
  }
  _sw.busy = false;
  card?.classList.remove('pm-sw-busy');
  _swRenderStep();   // user cancelled the picker — stay on this shot
}

// Expose normalisedRows for VFX Pull workspace OCF state lookup (prep_mark.js)
window._pmGetVfxNormRows = () => _state.normalisedRows || [];
// Sprint 4: whether the current OCF link batch came from the media library
// (filename/reel, no container TC) vs a folder scan (timecode-exact).
window._pmIsOcfFromLibrary = () => !!_state.ocfFromLibrary;

// Session-scoped OCF still-frame cache: key = "ocfPath|tc|WxH[|ff]"
// Exposed on window so prep_mark.js can invalidate entries on Retry / Start Resolve.
const _ocfStillCache = new Map();
window._ocfStillCache = _ocfStillCache;

// Expose Resolve connection state so prep_mark.js can check it without importing _state.
// Reads window.PFX_RESOLVE_STATUS — the same global the top bar "Resolve: Connected" pill uses,
// set by project_setup.js via pfx:resolve-status events whenever Resolve engine is detected.
window._pmVfxPullResolveConnected = () => window.PFX_RESOLVE_STATUS?.state === 'connected';

// A still decoded by the Resolve Engine is direct proof Resolve is connected — flip
// the global status (and broadcast pfx:resolve-status) so the VERIFY panel and the
// top-bar pill show "Connected" even when the boot-time detection probe missed it.
function _pmMarkResolveConnected(decoder, extractor) {
  if (!(extractor === 'resolve' || decoder === 'Resolve Engine')) return;
  if (window.PFX_RESOLVE_STATUS?.state === 'connected') return;
  const status = {
    ...(window.PFX_RESOLVE_STATUS || {}),
    state: 'connected',
    label: 'Resolve: Connected',
    sub:   'Connected — decoding via Resolve Engine',
    at:    Date.now(),
  };
  try { window.PFX_RESOLVE_STATUS = status; } catch {}
  try { document.dispatchEvent(new CustomEvent('pfx:resolve-status', { detail: status })); } catch {}
}
window._pmMarkResolveConnected = _pmMarkResolveConnected;

// OCF still preview — 3-tier JS-orchestrated pipeline:
//   Tier 1: Resolve Engine (vfx.preview.resolveStill)
//   Tier 2: AVFoundation / QuickLook (vfx.preview.avfStill) — only when Resolve available but failed
//   Tier 3: FFmpeg (ocfExtractFrame, forceFfmpeg) — only when forceFfmpeg=true or Resolve+AVF failed
// resolveConnected: pass true when Resolve was confirmed connected during VFX Pull analysis.
//   When true, a companion-side "not running" response does NOT block fallback tiers — it is
//   treated as a transient extraction failure rather than proof that Resolve is unavailable.
// Returns { dataUrl, error, decoder, extractor, backend, requiresResolve, resolveAvailable, ocfPath, sourceTc }.
// Near-pure-black frame = a failed/blank decode (Resolve slate, render miss,
// offline media) — NOT a legitimately dark shot (which still keeps highlights).
// Lets us reject black OCF frames so they neither display nor cache as "ready".
async function _ocfFrameIsBlack(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string') return false;
  try {
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('img decode failed'));
      im.src = dataUrl;
    });
    const W = 48, H = 27;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const cx = c.getContext('2d', { willReadFrequently: true });
    if (!cx) return false;
    cx.drawImage(img, 0, 0, W, H);
    const d = cx.getImageData(0, 0, W, H).data;
    let sum = 0, max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l; if (l > max) max = l;
    }
    // Whole frame ~0 with no highlight anywhere → blank decode, not dark content.
    return (sum / (W * H)) < 3 && max < 18;
  } catch { return false; }   // can't tell → don't over-reject
}

// Returns the result if its frame is usable, else null so the caller falls
// through to the next decoder tier instead of caching/showing a black frame.
async function _ocfUsable(result) {
  if (result?.dataUrl && await _ocfFrameIsBlack(result.dataUrl)) {
    try { console.warn('[OCF Preview] rejected near-black frame from', result.decoder, result.ocfPath); } catch {}
    return null;
  }
  return result;
}

window._pmGetOcfStillPreview = async function({
  ocfPath, sourceTc, sourceStartTc = '', fps = 0, sourceFrame = null,
  timeout = 15000, width = 640, height = 360,
  forceFfmpeg = false, resolveConnected = false,
} = {}) {
  // sourceFrame lets callers seek by an absolute frame index inside the file —
  // used for library OCF (no container TC) where editorial-TC seeking is unmapped.
  const haveFrame = Number.isFinite(sourceFrame) && sourceFrame >= 0;
  if (!ocfPath || (!sourceTc && !haveFrame)) {
    const error = !ocfPath ? 'no ocfPath' : 'no sourceTc';
    return { dataUrl: null, error, decoder: 'Unsupported', extractor: 'none', backend: '',
             requiresResolve: false, resolveAvailable: true,
             ocfPath: ocfPath || '', sourceTc: sourceTc || '' };
  }

  const cacheKey = `${ocfPath}|${sourceTc}|${sourceStartTc}|${haveFrame ? 'f' + sourceFrame : ''}|${width}x${height}|${forceFfmpeg ? 'ff' : ''}`;
  if (_ocfStillCache.has(cacheKey)) return _ocfStillCache.get(cacheKey);

  const _save = (result) => {
    if (result.dataUrl) {
      if (_ocfStillCache.size >= 200) _ocfStillCache.delete(_ocfStillCache.keys().next().value);
      _ocfStillCache.set(cacheKey, result);
    }
    return result;
  };

  // Diagnostics: capture WHY preview failed so the UI shows a specific reason
  // instead of "Failed (unknown)". A black-frame rejection (Resolve produced a
  // frame but it's blank — usually Media Offline or a bad seek) is a very
  // different cause from a Resolve extraction failure (ok:false at some stage).
  let _blackFrom   = null;   // a tier produced a frame we rejected as near-black
  let _resolveFail = null;   // Resolve tier returned ok:false {stage,error}
  const _failInfo = () => {
    if (_blackFrom) return {
      error: `${_blackFrom} returned a black frame — Resolve could not decode/debayer this clip. Common causes: camera-RAW that Resolve's GPU/RAW decode can't read (verify the file plays in Resolve directly), the clip is Media Offline, or the seek landed out of range. Use "Test Resolve Still" to diagnose.`,
      stage: 'black_frame',
    };
    if (_resolveFail) return {
      error: _resolveFail.error || 'Resolve could not extract a preview frame.',
      stage: _resolveFail.stage || 'resolve_failed',
    };
    return null;
  };

  // ── Electron fast-path: native media engine (AVFoundation via avf_bridge) ──
  // media_engine.js handles the 3-tier logic natively; no companion round-trip.
  // When seeking by frame index (library OCF, no container TC) this is the only
  // tier that can fulfil the request — the TC tiers below need a timecode.
  if ((!forceFfmpeg || haveFrame) && window.pfxPlatform?.media) {
    try {
      const r = await window.pfxPlatform.media.getOcfStill({
        ocfPath, sourceTc, sourceStartTc, fps,
        ...(haveFrame ? { sourceFrame } : {}),
        outputWidth: width, colorPreviewMode: 'rec709',
      });
      const dataUrl = r?.dataUrl || r?.imageDataUrl || null;
      if (dataUrl) {
        const _r = await _ocfUsable({ dataUrl, error: null,
                       decoder: r.decoder || 'Native', extractor: r.extractor || 'native', backend: '',
                       requiresResolve: false, resolveAvailable: true, ocfPath, sourceTc });
        if (_r) { _pmMarkResolveConnected(r.decoder, r.extractor); return _save(_r); }
        _blackFrom = r.decoder || 'Native';
        // black/blank decode — fall through to the companion tiers
      }
    } catch (_) {}
    // Frame-based requests can still be fulfilled by Resolve for RAW MXF/R3D/etc.
    // If the native engine cannot decode them, continue into the Resolve tier
    // instead of stopping at "Unsupported".
    // Fall through to companion path if native engine failed.
  }

  // ── Tier 1: Resolve Engine ────────────────────────────────────────────────
  if (!forceFfmpeg) {
    let resolveData;
    try {
      const res = await _nativeOcfResolveStill(ocfPath, sourceTc, {
        width, height,
        ...(haveFrame ? { sourceFrame } : {}),
      });
      resolveData = res?.data ?? res ?? {};
    } catch (e) {
      // The companion CALL threw (timeout or transport error) — it did not return
      // a structured {ok:false, stage}. Preserve the REAL cause + a meaningful
      // stage so the UI stops reporting a generic "resolve_failed". A timed-out
      // call means Resolve is present but the render exceeded the budget, so keep
      // resolveAvailable=true (don't wrongly prompt "Start Resolve"); only a down
      // companion is genuinely unavailable.
      const msg           = e?.message || String(e);
      const companionDown = e?.code === 'COMPANION_UNAVAILABLE';
      const isTimeoutErr  = /tim(e|ed)\s?out/i.test(msg);
      resolveData = {
        ok: false,
        resolveAvailable: !companionDown,
        stage: companionDown ? 'companion_down' : isTimeoutErr ? 'render_timeout' : 'companion_error',
        error: companionDown
          ? 'Native companion is not running.'
          : isTimeoutErr
            ? 'Resolve render timed out — the clip is taking too long to debayer. Retry, or close other Resolve renders/jobs and try again.'
            : `Resolve preview call failed: ${msg}`,
      };
    }

    if (resolveData?.retryable && resolveData?.stage === 'black_frame') {
      await new Promise(r => setTimeout(r, 900));
      try {
        const res = await _nativeOcfResolveStill(ocfPath, sourceTc, {
          width, height,
          ...(haveFrame ? { sourceFrame } : {}),
        });
        resolveData = res?.data ?? res ?? {};
      } catch (_) {}
    }

    if (resolveData.ok && resolveData.dataUrl) {
      const _r = await _ocfUsable({ dataUrl: resolveData.dataUrl, error: null,
                     decoder: 'Resolve Engine', extractor: 'resolve', backend: '',
                     requiresResolve: false, resolveAvailable: true, ocfPath, sourceTc });
      if (_r) { _pmMarkResolveConnected('Resolve Engine', 'resolve'); return _save(_r); }
      _blackFrom = 'Resolve Engine';
      // Resolve returned a black/slate frame — fall through to AVF/FFmpeg rather
      // than caching black as "ready" (the cause of the black strip).
    } else if (resolveData && resolveData.ok === false) {
      _resolveFail = {
        stage: resolveData.stage,
        error: resolveData.error,
        resolveAvailable: resolveData.resolveAvailable !== false,
      };
    }
    // Resolve unavailable OR its extraction failed. Do NOT stop here — fall
    // through to AVFoundation (Tier 2) and FFmpeg (Tier 3), which decode
    // MXF / MOV / ProRes / many camera containers WITHOUT Resolve. Only if
    // every native decoder also fails do we report requiresResolve (Tier 3 end).
  }

  // ── Tier 2: AVFoundation / QuickLook (macOS only) ─────────────────────────
  if (!forceFfmpeg) {
    try {
      const res  = await _nativeOcfAvfStill(ocfPath, { width, sourceTc, sourceStartTc, fps });
      const data = res?.data ?? res ?? {};
      if (data.ok && data.dataUrl) {
        const _r = await _ocfUsable({ dataUrl: data.dataUrl, error: null,
                       decoder: 'AVFoundation', extractor: 'avf', backend: '',
                       requiresResolve: false, resolveAvailable: true, ocfPath, sourceTc });
        if (_r) return _save(_r);
        _blackFrom = _blackFrom || 'AVFoundation';
      }
    } catch (_) {}
  }

  // ── Tier 3: FFmpeg ────────────────────────────────────────────────────────
  // Only reached when forceFfmpeg=true (user clicked "Use FFmpeg Fallback")
  // or when Resolve ran but couldn't decode AND AVFoundation also failed.
  if (haveFrame && !sourceTc) {
    const _fi = _failInfo();
    return _save({ dataUrl: null,
                   error: _fi?.error || 'No decoder could extract a preview for this file.',
                   stage: _fi?.stage || 'unknown',
                   decoder: 'Unsupported', extractor: 'none', backend: '',
                   requiresResolve: !_blackFrom,
                   resolveAvailable: _resolveFail?.resolveAvailable ?? !!_blackFrom,
                   ocfPath, sourceTc });
  }

  try {
    const timeoutP = new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`OCF preview timed out after ${timeout}ms`)), timeout));
    const res  = await Promise.race([
      nativeOcfExtractFrame(ocfPath, sourceTc, { width, height, format: 'jpg', forceFfmpeg: true, sourceStartTc, fps }),
      timeoutP,
    ]);
    const data = res?.data ?? res ?? {};
    if (data.dataUrl) {
      const _r = await _ocfUsable({ dataUrl: data.dataUrl, error: null,
                     decoder: 'FFmpeg', extractor: 'ffmpeg', backend: '',
                     requiresResolve: false, resolveAvailable: true, ocfPath, sourceTc });
      if (_r) return _save(_r);
      _blackFrom = _blackFrom || 'FFmpeg';
      // black ffmpeg frame — treat as no usable decode (fall to the error return)
    }
    // ffmpeg failed — suppress stderr from the viewer; log to console only.
    console.warn('[OCF Preview] ffmpeg tier failed:', data.error);
    const _fi = _failInfo();
    return _save({ dataUrl: null,
                   error: _fi?.error || 'No decoder could extract a preview for this file.',
                   stage: _fi?.stage || 'unknown',
                   decoder: 'Unsupported', extractor: 'ffmpeg', backend: '',
                   // A black frame means Resolve IS available (it produced something) —
                   // don't prompt "Start Resolve"; show the decode-error diagnostics.
                   requiresResolve: !_blackFrom,
                   resolveAvailable: _resolveFail?.resolveAvailable ?? true,
                   ocfPath, sourceTc });
  } catch (e) {
    const _fi = _failInfo();
    return _save({ dataUrl: null, error: _fi?.error || e?.message || String(e),
                   stage: _fi?.stage || 'exception',
                   decoder: 'Unsupported', extractor: 'none', backend: '',
                   requiresResolve: !_blackFrom,
                   resolveAvailable: _resolveFail?.resolveAvailable ?? !!_blackFrom,
                   ocfPath, sourceTc });
  }
};

// ---------------------------------------------------------------------------
// Per-shot manual relink (new — adds manualLinks persistence)
// Coexists with the existing _manualRelinkRow — do NOT remove either.
// ---------------------------------------------------------------------------

async function _manualRelinkShot(idx) {
  const row   = _state.matchResults[idx];
  const event = row?.event;
  if (!event) return;

  const picked = await nativePickMediaFile(
    `Select OCF file for ${event.clipName || event.reel || `shot ${idx + 1}`}`,
    { extensions: ['mxf', 'mov', 'r3d', 'ari', 'arx', 'braw', 'dng', 'exr', 'dpx', 'tif', 'tiff'] }
  );
  const pickedData = _nativePayload(picked);
  const filePath   = pickedData?.path || pickedData?.filePath;
  if (!filePath) return;

  let ocf = { path: filePath, name: filePath.split(/[\\/]/).pop() };
  try {
    const probe = await _sendCompanionAction('ocfProbeFile', { filePath }, 30000);
    const probeData = _nativePayload(probe);
    if (probeData?.name) ocf = { ...probeData, path: filePath };
  } catch (e) {
    console.warn('[VfxPull] ocfProbeFile failed, using minimal descriptor:', e);
  }

  let scored = null;
  try {
    scored = matchOcfToEvent(ocf, event, { handleFrames: _settings.handles });
  } catch (e) { /* non-fatal */ }

  const manualMatch = {
    status:        'SAFE',
    confidence:    100,
    matchedPath:   filePath,
    reasons:       ['Manual OCF relink', ...(scored?.match?.reasons || scored?.reasons || [])],
    warnings:      (scored?.match?.confidence ?? scored?.confidence ?? 100) < 60
      ? ['Manual link — verify TC alignment', ...(scored?.match?.warnings || scored?.warnings || [])]
      : [...(scored?.match?.warnings || scored?.warnings || [])],
    _manualLink:   true,
    _manualScore:  scored?.match?.confidence ?? scored?.confidence ?? 0,
    ocfLinkLocked: true,
  };

  _state.matchResults[idx] = { event, match: manualMatch, ocf };

  if (!_state.manualLinks) _state.manualLinks = {};
  _state.manualLinks[_eventKey(event)] = {
    path:     filePath,
    ocf,
    match:    manualMatch,
    linkedAt: new Date().toISOString(),
  };

  await _rebuildVfxPullArtifactsFromMatches();
  _persistState();
  _renderShotTable();
  _updateOcfSummary();
  _updateWfDots();
}

async function _clearManualRelink(idx) {
  const row = _state.matchResults[idx];
  const key = _eventKey(row?.event);
  if (_state.manualLinks) delete _state.manualLinks[key];
  await _matchOcfToCurrentEvents();
  await _rebuildVfxPullArtifactsFromMatches();
  _persistState();
  _renderShotTable();
  _updateOcfSummary();
  _updateWfDots();
}

function _on(id, event, fn) {
  const el = document.getElementById(id);
  if (el) el.addEventListener(event, fn);
}

function _onChange(id, fn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('change', () => {
    // For checkboxes, hand back the boolean — el.value is the literal HTML
    // attribute (defaults to "on") and doesn't toggle with the user. For
    // every other input/select, pass el.value through unchanged.
    if (el.type === 'checkbox') fn(el.checked);
    else fn(el.value);
  });
}

// ---------------------------------------------------------------------------
// Core analysis flow
// ---------------------------------------------------------------------------

async function _runAnalysis() {
  _running = true;
  _setGoBtn(false);
  _showProgress(true);
  // Re-analysis rebuilds _state.jobs, so old idx-keyed player sessions would
  // point at the wrong (or gone) shot — close them all up front.
  _wsCloseAllSessions();

  try {
    // Step 1 — Check Resolve first (moved before OCF scan so we can skip the
    // folder pick entirely when Resolve already has all media paths on disk).
    _progress(5, 'Checking Resolve…');
    _state.resolveConnected   = false;
    _state.resolveReconnected = false;
    let _resolveTlData  = null;  // {fps, colorScience, timelineName, events, markers}
    let _validatedPaths = new Set(); // Resolve source paths confirmed present on disk

    try {
      const tlRes = await _sendCompanionAction('resolve.getTimeline', {}, 15000);
      // _sendCompanionAction returns the raw companion ResponseEnvelope
      // { status, data, error } — the timeline payload lives under .data.
      const tl = tlRes?.data ?? tlRes ?? {};
      if (tl?.events?.length) {
        _state.resolveConnected = true;
        _resolveTlData = tl;
        _progress(10, `Resolve: ${tl.timelineName || 'timeline'} · ${tl.events.length} clips…`);

        // Batch-stat every sourcePath Resolve reported. Non-fatal — worst case
        // we fall through to the normal folder scan.
        const pathsToCheck = [...new Set(
          tl.events.map(e => e.sourcePath).filter(Boolean)
        )];
        if (pathsToCheck.length > 0) {
          try {
            const vr = await _sendCompanionAction('resolve.validatePaths', { paths: pathsToCheck }, 10000);
            for (const { path, exists } of ((vr?.data ?? vr)?.results || [])) {
              if (exists) _validatedPaths.add(path);
            }
          } catch (_e) { /* non-fatal — fall through to folder scan */ }
        }
      }
    } catch (_e) {
      // Resolve offline or scripting unavailable — silent fallback.
      _state.resolveConnected = false;
    }

    // Step 2 — OCF folder scan.
    // Skipped entirely when every Resolve event has a validated on-disk path —
    // no folder picker, no drive-mount wait, no probe round-trip needed.
    const _resolveEvents    = _resolveTlData?.events || [];
    const _allResolveLinked = _state.resolveConnected
      && _resolveEvents.length > 0
      && _resolveEvents.every(e => e.sourcePath && _validatedPaths.has(e.sourcePath));

    if (_allResolveLinked) {
      _state.ocfFiles = [];
      _progress(20, `All ${_resolveEvents.length} clips linked via Resolve — skipping OCF scan`);
    } else {
      _progress(15, 'Scanning OCF folder…');
      if (!_state.ocfFolder) {
        const picked = await nativePickOcfFolder();
        const pickedData = _nativePayload(picked);
        const folderPath = pickedData?.path || pickedData?.folderPath;
        if (!folderPath) throw new Error('No OCF folder selected.');
        _state.ocfFolder = folderPath;
        // User just picked a folder — bust the cache so a fresh scan always runs
        // even if the path matches a previous session (contents may have changed).
        _ocfProbeCache.result = null;
      }
      // nativeProbeOcfFolder takes the bare folder path string. Passing
      // {folderPath: ...} double-wraps the payload — companion sees the action
      // body as {folderPath: {folderPath: "..."}} and fails the path check.
      // Skip re-scan when the folder path is unchanged (e.g. settings-only change).
      let probeResult;
      if (_ocfProbeCache.path === _state.ocfFolder && _ocfProbeCache.result) {
        probeResult = _ocfProbeCache.result;
        _progress(20, 'OCF folder unchanged — using cached scan…');
      } else {
        probeResult = await nativeProbeOcfFolder(_state.ocfFolder);
        _ocfProbeCache.path   = _state.ocfFolder;
        _ocfProbeCache.result = probeResult;
      }
      // Companion returns the probed file list under either `files` (legacy),
      // `result` (current envelope), or top-level array — accept all variants.
      _state.ocfFiles = _extractOcfFiles(probeResult);
      _persistState();
    }

    // Step 3 — Match events to OCF
    _progress(30, 'Matching events to OCF…');
    // Resolve events are preferred when available; they carry exact source TC,
    // reel names, speed ramps, and the original media path for reconnect.
    const events  = _resolveTlData?.events?.length
      ? _resolveTlData.events
      : (await _providers.getEvents?.() || []);
    const markers = [
      ...(_resolveTlData?.markers  || []),
      ...(await _providers.getMarkers?.() || []),
    ];

    // Optional: pre-compute OCR burn-in hints from reference video frames
    const ocrHints = new Map();
    if (_settings.matchMethods.includes('ocr_burnin') && events.length > 0) {
      const projectMeta0 = await _providers.getProjectMeta?.() || {};
      const refAssetId = projectMeta0.refVideoAssetId || null;
      if (refAssetId) {
        const ocrClient = _getOcrClient();
        const _OCR_CONCURRENCY = 4;
        for (let start = 0; start < events.length; start += _OCR_CONCURRENCY) {
          const end = Math.min(start + _OCR_CONCURRENCY, events.length);
          _progress(30 + Math.round((start / events.length) * 15), `OCR burn-in ${start + 1}–${end}/${events.length}…`);
          await Promise.all(
            Array.from({ length: end - start }, (_, k) => start + k).map(async (i) => {
              try {
                const frame = await nativeGrabThumbnailAtTimecode(refAssetId, events[i].srcIn, { width: 1280, height: 720, format: 'jpg', mode: 'fast' });
                if (frame?.dataUrl) {
                  const imgData = await _dataUrlToImageData(frame.dataUrl, 1280, 720);
                  if (imgData) {
                    const raw = await ocrClient.recognize(imgData, { psm: 7, whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_.-' });
                    const filename = _extractFilenameFromOcr(raw);
                    if (filename) ocrHints.set(i, filename);
                  }
                }
              } catch (_e) {}
            })
          );
        }
      }
    }

    // Pull the ALE map from Prep & Mark if it's already loaded — improves
    // the deduplicate pass in matchAllEvents.
    const aleMap = (typeof window !== 'undefined' && (window.__pmGetAleMap?.() || window._pmAleMap)) || null;
    _state.matchResults = matchAllEvents(events, _state.ocfFiles, {
      markers,
      aleMap,
      handleFrames: _settings.handles,
      reelAliases:  _settings.reelAliases || null,
      deduplicate: true,
      ocrHints,
    });

    // Resolve-first override: for events that came from Resolve with a validated
    // on-disk source path, replace the matcher's result with a direct link at
    // confidence=100. The matcher only saw the (possibly empty) ocfFiles list so
    // its score is unreliable for these clips — Resolve's own path is authoritative.
    if (_validatedPaths.size > 0) {
      _state.matchResults = _state.matchResults.map(r => {
        const sp = r.event?.sourcePath;
        if (!sp || !r.event?._fromResolve || !_validatedPaths.has(sp)) return r;
        return {
          ...r,
          match: {
            ...r.match,
            matchedPath: sp,
            confidence:  100,
            status:      'SAFE',
            method:      'resolve_direct',
            warnings:    [],
          },
          ocf: r.ocf?.path ? r.ocf : { path: sp, name: sp.split('/').pop() },
        };
      });
    }

    // Step 4 — Build EXR jobs
    _progress(60, 'Building EXR jobs…');
    // Merge providers + live Resolve project meta. Resolve values take
    // precedence for fps / colorScience / timelineName since they come from
    // the actual project settings rather than from an EDL parse.
    const _providerMeta = await _providers.getProjectMeta?.() || {};
    const projectMeta = {
      ..._providerMeta,
      ...(_resolveTlData ? {
        fps:          _resolveTlData.fps,
        timelineName: _resolveTlData.timelineName || _providerMeta.timelineName,
        projectName:  _resolveTlData.projectName  || _providerMeta.projectName,
        colorScience: _resolveTlData.colorScience,
        // Surface colorScience to AMF/FDL generators under the key they expect.
        resolveColorScience: _resolveTlData.colorScience,
      } : {}),
    };
    // Parse targetResolution once — used in both config.reframe and Step 4 FDL.
    const [_resWStr, _resHStr] = String(_settings.targetResolution || '3840x2160').split('x');
    const _resTargetW = parseInt(_resWStr, 10) || 3840;
    const _resTargetH = parseInt(_resHStr, 10) || 2160;
    // Spec-shape config: planner reads `handleFrames`, not `handles`. Pass
    // the full color/retime/reframe block so downstream stages (EXR export,
    // FDL referenceInfo, AMF lookTransform) have what they need.
    const _projNaming2 = _readProjectNaming();
    const _vfxOut2 = _readVfxOutputSettings();
    const config = {
      outputBasePath:   _settings.outputFolder || '',
      handleFrames:     _settings.handles,
      frameStart:       _settings.frameStart || 1001,
      resolution:       _settings.targetResolution || '3840x2160',
      plateFormat:      _settings.plateFormat,
      matchMethods:     _settings.matchMethods,
      pullMode:         _settings.pullMode || 'ocf_native',
      bakeGeometry:     !!_settings.bakeReframe,
      exr: _vfxOut2.exr,
      color: {
        mode:              'aces',
        outputColorSpace:  _vfxOut2.outputColorSpace,
        matchMode:         _settings.colorMatchMode || 'preview',
      },
      retime: {
        mode: _settings.bakeSpeed ? 'bake_to_timeline' : 'source_frames_only',
      },
      reframe: {
        mode:         _settings.bakeReframe ? 'baked' : 'none',
        targetWidth:  _resTargetW,
        targetHeight: _resTargetH,
      },
      // Naming template chip values — drives Netflix-spec SHOW_EP_SCENE_SHOT_PLATEID naming
      projectNaming:    _projNaming2,
      defaultPlateType: _projNaming2.plateCode || 'PL',
    };
    _state.jobs = await buildAllExrJobs(_state.matchResults, config, projectMeta);

    // Flatten the matchAllEvents shape ({event, match, ocf}) into the flat
    // {shotName, clipName, sourcePath, tcIn/Out, confidence, ...} that the
    // FDL/AMF/QC generators expect. matchAllEvents returns nested objects;
    // every downstream consumer was reading mismatched field paths
    // (matchResult.filePath, matchResult.clipName) that don't exist on the
    // real shape. Normalising here keeps the bug contained to one helper.
    const normalisedRows = _state.matchResults.map((r, i) =>
      normalizeVfxPullRow(r, _state.jobs[i])
    );

    // Step 4.5 — Resolve OCF reconnect (only when Resolve is live).
    // For each matched shot, sends the matched OCF path to Resolve so the
    // timeline clip is relinked from its placeholder/offline media to the real
    // camera original. Uses the event's sourcePath (the original Resolve media
    // path) as the lookup key so we find the right MediaPoolItem even when
    // multiple clips share the same clip name.
    if (_state.resolveConnected) {
      const reconnectPayload = normalisedRows
        .map((row, i) => {
          if (!row?.sourcePath) return null;
          const event = _state.matchResults[i]?.event || {};
          return {
            clipName:      row.clipName || row.shotName || '',
            srcIn:         row.tcIn || '',
            newPath:       row.sourcePath,
            // Original path in the Resolve media pool — present when events
            // came from resolve.getTimeline (event.sourcePath).
            mediaItemPath: event.sourcePath || '',
          };
        })
        .filter(Boolean);

      if (reconnectPayload.length > 0) {
        _progress(68, `Reconnecting ${reconnectPayload.length} clip(s) in Resolve…`);
        try {
          const rlRes = await _sendCompanionAction('resolve.reconnectOcf', {
            matches: reconnectPayload,
          }, 30000);
          _state.resolveReconnected = true;
          // Unwrap the companion ResponseEnvelope — { relinked, failed } live under .data.
          const rl = rlRes?.data ?? rlRes ?? {};
          const failed = rl.failed || [];
          if (failed.length > 0) {
            console.warn('[VfxPull] Resolve reconnect partial failure:', failed);
          } else {
            _setStatus(`Reconnected ${rl.relinked?.length || reconnectPayload.length} clip(s) in Resolve`);
          }
        } catch (e) {
          console.warn('[VfxPull] Resolve reconnect failed — continuing without relink:', e);
        }
      }
    }

    // Step 4.6 — Push VFX pull status markers back into Resolve.
    // Adds colour-coded markers (Green/Yellow/Red) to each shot's record-in
    // position so the editor can see pull status directly on the timeline.
    // Runs only when Resolve is live; failures are non-fatal.
    if (_state.resolveConnected) {
      const markerPayload = normalisedRows
        .map((row, i) => {
          const event = _state.matchResults[i]?.event || {};
          if (!event.recIn || !event._fromResolve) return null;
          return {
            recIn:      event.recIn,
            recOut:     event.recOut || '',
            status:     row.status || 'MISSING',
            confidence: row.confidence,
            shotName:   row.shotName || row.clipName || '',
          };
        })
        .filter(Boolean);
      if (markerPayload.length > 0) {
        try {
          await _sendCompanionAction('resolve.markVfxShots', { shots: markerPayload }, 15000);
        } catch (e) {
          console.warn('[VfxPull] Failed to push markers to Resolve:', e);
        }
      }
    }

    // Step 4.7 — QT-Ref vs OCF match (per shot). Single frame-grab drives
    // BOTH the colour CDL (spec #8) and the reframe (spec #9). Stores:
    //   • job.color.match → AMF lookTransform applied="false" (preview only).
    //   • job.reframe     → FDL pull.referenceReformat + spec "FR N%" badge.
    // Each shot's failure is isolated — analysis continues on partial data.
    const refAssetIdForMatch = projectMeta.refVideoAssetId || null;
    if (refAssetIdForMatch) _state.refAssetIdSeen = true;
    if (refAssetIdForMatch) {
      // Filter to only shots that have the required fields, then process in
      // batches of 3 concurrent frame-grabs so the companion isn't flooded.
      const _FRAME_MATCH_CONCURRENCY = 3;
      const fmIndices = _state.jobs
        .map((_, i) => i)
        .filter(i => {
          const row = normalisedRows[i];
          return row?.sourcePath && row?.event?.recIn && row?.event?.srcIn;
        });
      for (let start = 0; start < fmIndices.length; start += _FRAME_MATCH_CONCURRENCY) {
        const batch = fmIndices.slice(start, start + _FRAME_MATCH_CONCURRENCY);
        const batchEnd = Math.min(start + _FRAME_MATCH_CONCURRENCY, fmIndices.length);
        _progress(
          62 + Math.round((start / Math.max(1, fmIndices.length)) * 5),
          `Frame match ${start + 1}–${batchEnd}/${fmIndices.length}…`,
        );
        await Promise.all(batch.map(async (i) => {
          const job = _state.jobs[i];
          const row = normalisedRows[i];
          try {
            const { colorMatch, reframe, frameAlign } = await _matchFramesForShot({
              event:      row.event,
              sourcePath: row.sourcePath,
              refAssetId: refAssetIdForMatch,
              settings:   { ..._settings, fps: job?.fps || row.event?.fps, matchConfidence: row.confidence },
            });
            if (colorMatch) {
              job.color = job.color || {};
              job.color.match = colorMatch;
            }
            if (reframe) {
              // Merge instead of overwrite — buildAllExrJobs may have planted
              // a placeholder reframe (mode + targetWidth/Height) from the
              // config block. The per-shot match adds the dynamic fields.
              job.reframe = { ...(job.reframe || {}), ...reframe };
            }
            if (frameAlign) {
              // Frame-accurate OCF in-point drift + real visual match score.
              job.frameAlign = frameAlign;
              job.metadata = job.metadata || {};
              job.metadata.visualMatch = frameAlign.confidence;
              job.metadata.frameDrift  = frameAlign.offsetFrames;

              // Auto-apply the drift to the EXR pull window when the match is
              // confident and the shift is sane. Conservative gate; fully
              // recorded for audit; reversible via settings.applyFrameAlign.
              const off = frameAlign.offsetFrames;
              const qualifies = _settings.applyFrameAlign !== false &&
                off !== 0 &&
                frameAlign.confidence >= 80 &&
                Math.abs(off) <= (frameAlign.searchWindow || 8);
              if (qualifies && _applyFrameDriftToJob(job, off)) {
                frameAlign.applied = true;
                frameAlign.appliedOffsetFrames = off;
                job.metadata.frameAlignApplied = true;
              } else {
                frameAlign.applied = false;
              }
            }
          } catch (e) {
            // Individual shot failures should never break the analyse pipeline.
            console.warn(`[VfxPull] frame match failed for shot ${i}:`, e);
          }
        }));
      }
    }

    // Step 5 — Generate FDLs.
    // Per spec #9: build referenceInfo from the QT-ref + per-shot reframe so
    // the FDL pull.referenceReformat block carries the real scale/crop/fit
    // values (not just the basic resolution-derived placeholder). Width/height
    // come from settings.targetResolution (UHD 3840x2160 default).
    const refPathForFdl =
      projectMeta.refVideoPath || projectMeta.refMediaPath || '';
    _progress(70, 'Generating FDL…');
    _state.fdls = _state.jobs.map((job, i) => {
      const row = normalisedRows[i];
      const referenceInfo = {
        path:    refPathForFdl,
        tcIn:    row.recIn || '',
        tcOut:   row.recOut || '',
        width:   _resTargetW,
        height:  _resTargetH,
        reformat: job.reframe || null,
      };
      return buildFDL({
        job,
        matchResult: row,
        referenceInfo,
        amfFileName: `${_plateName(i)}.amf`,
        pullMode:    _settings.pullMode,
        projectMeta,
      });
    });

    // Step 6 — Generate AMFs.
    // For match_editorial / review_proxy: pass cdl + cdlApplied:false so the
    // generator emits <lookTransform applied="false"> with the SOP+Sat CDL
    // estimated from the QT-ref vs OCF frame pair. We never bake the CDL into
    // the ACES EXR plate — `appliedToExr` stays false in job.color.match.
    // For ocf_native the generator omits the look block automatically.
    _progress(80, 'Generating AMF…');
    _state.amfXmls = _state.jobs.map((job, i) => {
      const row = normalisedRows[i];
      const matchCdl = job?.color?.match?.cdl || null;
      const colorMatch = job?.color?.match || null;
      const built = buildVfxPullAmf({
        clipName:    row.clipName,
        shotName:    row.shotName,
        filePath:    row.sourcePath,
        tcIn:        row.tcIn,
        tcOut:       row.tcOut,
        cameraModel: row.cameraModel || job?.metadata?.cameraModel || projectMeta.cameraModel || '',
        cameraProfile: job?.colorPlan?.cameraProfile || job?.metadata?.cameraProfile || '',
        idtUrn:      job?.colorPlan?.idtUrn || job?.metadata?.idtUrn || '',
        mode:        _settings.pullMode,
        outputColorSpace: job?.colorPlan?.outputSpace || 'ACES2065-1',
        cdl:         matchCdl,
        colorMatch,
        retime:      job?.retime || null,
        reframe:     job?.reframe || null,
        timeline:    { name: projectMeta.timelineName || '', recIn: row.recIn || job?.metadata?.recIn || '', recOut: row.recOut || job?.metadata?.recOut || '' },
        fps:         job?.fps || projectMeta.fps || null,
        frameStart:  job?.frameStart ?? null,
        targetResolution: job?.renderPlan?.targetResolution || _settings.targetResolution || '',
        extraWarnings: [
          ...(job?.colorPlan?.warnings || []),
          ...(job?.frameAlign
            ? [`Frame-align: OCF in-point drift ${job.frameAlign.offsetFrames >= 0 ? '+' : ''}${job.frameAlign.offsetFrames}f vs editorial (visual match ${job.frameAlign.confidence}%). ${
                 job.frameAlign.applied
                   ? `APPLIED — pull window slid to frame-accurate src in ${job.frameAlign.alignedSrcIn}.`
                   : job.frameAlign.offsetFrames !== 0
                     ? `Recommended src in ${job.frameAlign.alignedSrcIn} (NOT applied — below confidence/policy gate; verify manually).`
                     : 'No drift — editorial in-point is frame-accurate.'}`,
               ...(job.frameAlign.warnings || [])]
            : []),
        ],
        // Spec: lookTransform applied="false" — the CDL is preview only and
        // is never baked into the ACES EXR plate. Pass cdlApplied:true only
        // when the source material already has the CDL embedded.
        cdlApplied:  false,
      });
      // buildVfxPullAmf returns { ok, xml, warnings }. Downstream code
      // (_exportAMF, package writer, badge check) expects a string XML body —
      // pull just the xml field so _downloadText doesn't end up writing
      // "[object Object]" as the .amf file content.
      return (built && typeof built === 'object') ? (built.xml || '') : String(built || '');
    });

    // Step 7 — QC data. Surface the spec's extended fields so the QC report
    // (HTML + JSON) and the export log can show: OCF match details, colour
    // match CDL confidence, frame match confidence, speed, reframe, output
    // resolution + expected/actual frames, ACES vs fallback decoder flag.
    _progress(90, 'Building QC data…');
    _state.qcShots = _state.jobs.map((job, i) => {
      const row = normalisedRows[i];
      const exr = (_state.exrResults || [])[i] || null;
      const expectedFrames = job.frameCount || job.expectedFrameCount || 0;
      const actualFrames   = exr?.frames?.length ?? null;
      return {
        plateName:    _plateName(i),
        shotName:     row.shotName,
        clipName:     row.clipName,
        filePath:     row.sourcePath,
        status:       row.status,
        confidence:   row.confidence,
        warnings:     row.warnings,
        tcIn:         row.tcIn,
        tcOut:        row.tcOut,
        recIn:        row.recIn,
        recOut:       row.recOut,
        cameraModel:  row.cameraModel,
        sourceResolution: row.sourceResolution,
        reformatScale: job?.reframe?.scale ?? null,
        fdl:          _state.fdls[i] || null,
        amf:          _state.amfXmls[i] || null,
        // Extended QC fields per spec.
        ocfMatch: {
          status:      row.status,
          confidence:  row.confidence,
          manualLink:  !!row.match?._manualLink,
          matchedPath: row.sourcePath,
        },
        qtRefFrame: {
          tc:      row.recIn || '',
          assetId: projectMeta.refVideoAssetId || '',
        },
        colorMatch: job?.color?.match || null,
        frameMatch: job?.reframe ? {
          mode:         job.reframe.mode || 'none',
          confidence:   job.reframe.confidence ?? null,
          targetWidth:  job.reframe.targetWidth  || null,
          targetHeight: job.reframe.targetHeight || null,
        } : null,
        retime:       job?.retime || null,
        speed:        job?.retime?.speed ?? 1,
        speedBaked:   !!(job?.retime?.mode === 'bake_to_timeline' && job?.retime?.hasSpeedChange),
        reframeBaked: !!(job?.reframe?.mode && job.reframe.mode !== 'none'),
        outputResolution: job?.reframe?.targetWidth && job?.reframe?.targetHeight
          ? `${job.reframe.targetWidth}x${job.reframe.targetHeight}`
          : (_settings.targetResolution || ''),
        frameCount:          expectedFrames,
        expectedFrameCount:  expectedFrames,
        actualFrameCount:    actualFrames,
        firstFrame:  job.frameStart || _settings.frameStart || 1001,
        lastFrame:   expectedFrames > 0 ? (job.frameStart || 1001) + expectedFrames - 1 : null,
        missingFrames: actualFrames != null && expectedFrames > 0
          ? Math.max(0, expectedFrames - actualFrames)
          : 0,
        exrExport: exr,
        // ACES vs fallback decoder: until the companion-side retime baker
        // ships (#10), the export path can't guarantee true ACES IDT — flag
        // as fallback so QC reviewers know to verify color accuracy. When
        // #10 is in and the companion populates job.result.acesPipeline=true,
        // this flips to 'aces' automatically.
        colorPipeline: exr?.acesPipeline ? 'aces' : 'fallback_ffmpeg',
        colorWarning:  exr?.acesPipeline ? null : 'ffmpeg fallback decoder used — verify color accuracy.',
      };
    });
    _state.normalisedRows = normalisedRows;

    // Compute spec block conditions so the export step / UI can refuse to
    // run when something fundamental is wrong. Stored on _state for the
    // export-package flow to read.
    _state.qcBlocks = computeQcBlocks({
      shots:    _state.qcShots,
      settings: _settings,
      providers: {
        hasEvents:    events.length > 0,
        hasReference: !!projectMeta.refVideoAssetId,
        hasOcfFolder: !!_state.ocfFolder,
      },
      acknowledgedNotRecommended: !!_state.ackNotRecommended,
      browserDownloadAllowed: true,
    });

    // Step 8 — EXR export (only when outputFolder is set + not sidecar-only,
    // AND no hard QC blocks are present). Runs shots serially through
    // _runExrExport → renderPullExrStart → poll → QC → writePullSidecars.
    const hardBlocks = (_state.qcBlocks || []).filter(b => b.severity === 'error');
    if (hardBlocks.length) {
      const first = hardBlocks[0];
      console.log('[VfxPull] Export blocked by QC:', hardBlocks.map(b => `${b.code}: ${b.message}`).join('; '));
      _setStatus(`Blocked: ${first.message || first.code || 'QC error'}`);
    } else if (_settings.outputFolder && _settings.exportMode !== 'sidecar_only') {
      _progress(95, 'Exporting EXR…');
      try {
        await _runExrExport(_state.jobs);
      } catch (e) {
        console.warn('[VfxPull] EXR export step failed:', e);
        _setStatus(`EXR export error: ${e?.message || e}`);
      }
    }

    _progress(100, 'Done');
    _setStatus(`${_state.jobs.length} shots ready`);
    _renderShotTable();
    _renderVerifyStation();
    _updateOcfSummary();
    _showExport(true);
    _updateWfDots(true);

  } catch (err) {
    console.error('[VfxPull] Analysis error:', err);
    _progress(null, `Error: ${err.message}`);
    _setStatus('Error');
  } finally {
    _running = false;
    _setGoBtn(true);
    _showProgress(false);
  }
}

// ---------------------------------------------------------------------------
// Progress helpers
// ---------------------------------------------------------------------------

function _progress(pct, label) {
  const bar = document.getElementById('pmVfxPullProgBar');
  const lbl = document.getElementById('pmVfxPullProgLabel');
  if (bar && pct !== null) bar.style.width = `${pct}%`;
  if (lbl) lbl.textContent = label || '';
}

function _showProgress(visible) {
  const el = document.getElementById('pmVfxPullProgress');
  if (el) el.style.display = visible ? '' : 'none';
}

function _setGoBtn(enabled) {
  const btn = document.getElementById('pmVfxPullGoBtn');
  if (btn) btn.disabled = !enabled;
}

// Nine call sites below build their status text as `Something failed: ${e?.message || e}`,
// which puts ENOENT / EACCES / "TypeError: …" in front of an editor who cannot act
// on it. Rewriting here rather than at each site means the tenth one written is
// covered too; friendlyStatus keeps the "Something failed" half so the line still
// says which operation broke.
function _setStatus(text) {
  const el = document.getElementById('pmVfxPullStatus');
  if (!el) return;
  let out = text;
  try { out = friendlyStatus(text); }
  catch (_) { out = text; }   // a rewrite failure must never swallow the status being reported
  el.textContent = out || '—';
}

function _showVfxBlockedBanner(errors) {
  let el = document.getElementById('pmVfxBlockedBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pmVfxBlockedBanner';
    el.className = 'pm-vfx-blocked-banner';
    const card = document.getElementById('pmVfxPullCard');
    if (card) card.prepend(el);
  }
  el.innerHTML = `<span class="pm-vfx-blocked-icon">⛔</span><span class="pm-vfx-blocked-msg">${errors.map(e => _escHtml(e)).join('<br>')}</span>
    <button class="pm-vfx-blocked-close" onclick="this.closest('#pmVfxBlockedBanner').remove()">✕</button>`;
  el.style.display = '';
}

function _showVfxWarningBanner(warnings) {
  let el = document.getElementById('pmVfxWarningBanner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pmVfxWarningBanner';
    el.className = 'pm-vfx-warning-banner';
    const card = document.getElementById('pmVfxPullCard');
    if (card) card.prepend(el);
  }
  el.innerHTML = `<span class="pm-vfx-blocked-icon">⚠</span><span class="pm-vfx-blocked-msg">${warnings.map(w => _escHtml(w)).join('<br>')}</span>
    <button class="pm-vfx-blocked-close" onclick="this.closest('#pmVfxWarningBanner').remove()">✕</button>`;
  el.style.display = '';
}

function _escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _showExport(visible) {
  const el = document.getElementById('pmVfxPullExport');
  if (el) el.style.display = visible ? '' : 'none';
  if (visible) { try { _renderExportPreflight(); } catch {} }
}

// Proactive export readiness summary — shows what (if anything) blocks the pull
// package BEFORE the user clicks, and disables the Pull Package button while
// blocked. Errors block; warnings inform but still allow export.
function _renderExportPreflight() {
  const box = document.getElementById('pmVfxExportPreflight');
  const btn = document.getElementById('pmVfxExpPackage');
  if (!box) return;
  const hardBlocks = (_state.qcBlocks || []).filter(b => b.severity === 'error');
  const valErrors  = (_state.validation && _state.validation.ok === false)
    ? (_state.validation.issues || []).filter(i => i.severity === 'error') : [];
  const warns = [
    ...((_state.qcBlocks || []).filter(b => b.severity === 'warn')),
    ...((_state.validation && _state.validation.issues || []).filter(i => i.severity === 'warn')),
  ];
  const errMsgs  = [...hardBlocks, ...valErrors].map(b => b.message || b.code).filter(Boolean);
  const warnMsgs = warns.map(b => b.message || b.code).filter(Boolean);

  if (btn) btn.disabled = errMsgs.length > 0;

  if (errMsgs.length) {
    box.style.display = '';
    box.className = 'pm-vfx-export-preflight is-blocked';
    box.innerHTML =
      `<div class="pm-vfx-pf-hd">⛔ Export blocked — fix ${errMsgs.length} issue${errMsgs.length > 1 ? 's' : ''}:</div>` +
      `<ul class="pm-vfx-pf-list">${errMsgs.slice(0, 4).map(m => `<li>${_escHtml(m)}</li>`).join('')}` +
      `${errMsgs.length > 4 ? `<li>…and ${errMsgs.length - 4} more</li>` : ''}</ul>`;
  } else if (warnMsgs.length) {
    box.style.display = '';
    box.className = 'pm-vfx-export-preflight is-warn';
    box.innerHTML =
      `<div class="pm-vfx-pf-hd">⚠ Ready to export — ${warnMsgs.length} warning${warnMsgs.length > 1 ? 's' : ''} to review:</div>` +
      `<ul class="pm-vfx-pf-list">${warnMsgs.slice(0, 3).map(m => `<li>${_escHtml(m)}</li>`).join('')}` +
      `${warnMsgs.length > 3 ? `<li>…and ${warnMsgs.length - 3} more</li>` : ''}</ul>`;
  } else {
    box.style.display = '';
    box.className = 'pm-vfx-export-preflight is-ready';
    box.innerHTML = `<div class="pm-vfx-pf-hd">✓ Ready to export — all checks passed.</div>`;
  }
}

// ---------------------------------------------------------------------------
// Shot table rendering
// ---------------------------------------------------------------------------

function _renderShotTable() {
  const wrap = document.getElementById('pmVfxPullTableWrap');
  const table = document.getElementById('pmVfxPullTable');
  const summEl = document.getElementById('pmVfxTableSummary');
  if (!wrap || !table) return;

  // Read from the flat normalised rows produced by normalizeVfxPullRow. The
  // raw _state.matchResults shape ({event, match, ocf}) doesn't have
  // .filePath / .clipName / .confidence at the top level, which was why the
  // OCF clip column rendered as "—" even on successful matches.
  const rowsData = _state.normalisedRows || [];

  let ready = 0, review = 0, missing = 0;
  const rows = _state.jobs.map((job, i) => {
    const row = rowsData[i] || {};
    const rowStatus = _resolveRowStatus(job, row);
    if (rowStatus === 'ready') ready++;
    else if (rowStatus === 'missing') missing++;
    else review++;

    const conf = Number(row.confidence) || 0;
    const confClass = conf >= 85 ? 'is-ok' : conf >= 60 ? 'is-warn' : 'is-error';
    const confLabel = `${Math.round(conf)}%`;

    const shotName  = row.shotName || row.clipName || `Shot ${i + 1}`;
    const shortShot = shotName.length > 18 ? shotName.slice(0, 17) + '…' : shotName;
    const ocfPath   = row.sourcePath || '';
    const ocfClip   = ocfPath ? ocfPath.split('/').pop() : '—';
    const shortClip = ocfClip.length > 14 ? ocfClip.slice(0, 13) + '…' : ocfClip;

    const statusLabel = rowStatus === 'ready' ? 'Ready' : rowStatus === 'review' ? 'Needs review' : 'Missing OCF';

    // ── Spec badge set ──
    // OCF linked / missing → controlled by rowStatus (the dot + border already
    // convey it; add a dedicated badge for screen readers + manual link cases).
    // colorMatch / reframe / retime come from the planner job; AMF/FDL from
    // generators; EXR from the queue state populated by _runExrExport.
    const exr        = (_state.exrResults || [])[i] || null;
    const colorMatch = job?.color?.match || null;
    const reframe    = job?.reframe      || null;
    const retime     = job?.retime       || null;
    const geometry   = job?.geometry     || null;
    const colorPlan  = job?.colorPlan    || null;

    const badges = [];

    // ── OCF link status ──
    if (row.isOffline) badges.push('<span class="pm-vfx-pull-badge pm-vfx-pull-badge--err" title="Clip offline in Resolve — use Relink to locate">OFLN</span>');
    if (rowStatus === 'ready') badges.push(
      row.match?.method === 'resolve_direct'
        ? '<span class="pm-vfx-pull-badge pm-vfx-pull-badge--ok" title="Linked via Resolve media pool">RLV</span>'
        : '<span class="pm-vfx-pull-badge pm-vfx-pull-badge--ok" title="OCF linked">OCF</span>'
    );
    if (rowStatus === 'missing') badges.push('<span class="pm-vfx-pull-badge pm-vfx-pull-badge--err" title="OCF missing">OCF?</span>');
    if (row.match?._manualLink)  badges.push('<span class="pm-vfx-pull-badge pm-vfx-pull-badge--manual" title="Manually linked">MAN</span>');

    // ── Color plan (IDT / engine) ──
    if (colorPlan) {
      const amfOk = !!colorPlan.amfPath;
      if (amfOk) badges.push(`<span class="pm-vfx-pull-badge pm-vfx-pull-badge--amf" title="AMF: ${_esc(colorPlan.amfPath.split('/').pop())}">AMF ${colorPlan.amfAppliedIDT ? 'APL' : 'OK'}</span>`);
      const idtBadgeHtml = buildIdtBadgeHtml(colorPlan);   // 🎬 = OCF auto-detected
      if (idtBadgeHtml) badges.push(idtBadgeHtml);
      const engMap = { resolve: 'RLV', oiio: 'OII', ffmpeg_fallback: 'FFM' };
      const engTag = engMap[colorPlan.engineHint];
      if (engTag) badges.push(`<span class="pm-vfx-pull-badge pm-vfx-pull-badge--frame" title="Render engine: ${colorPlan.engineHint}">${engTag}</span>`);
    } else if (colorMatch?.confidence != null) {
      const c = Math.round(colorMatch.confidence * 100);
      badges.push(`<span class="pm-vfx-pull-badge pm-vfx-pull-badge--color" title="Color match: ${c}%">CDL ${c}%</span>`);
    }

    // ── Geometry / reframe ──
    if (geometry?.hasGeometry) {
      const bakeLabel = geometry.bakeMode === 'baked' ? 'BAKED' : 'SDC';
      const resNote   = geometry.sourceResolution ? ` ${geometry.sourceResolution}` : '';
      badges.push(`<span class="pm-vfx-pull-badge pm-vfx-pull-badge--reframe" title="Geometry ${geometry.bakeMode}${resNote}">RFR ${bakeLabel}</span>`);
    } else if (reframe?.mode && reframe.mode !== 'none') {
      const c = reframe.confidence != null ? ` ${Math.round(reframe.confidence * 100)}%` : '';
      badges.push(`<span class="pm-vfx-pull-badge pm-vfx-pull-badge--reframe" title="Reframe baked${c}">RFR${c}</span>`);
    }

    // ── Speed / retime ──
    if (retime?.hasSpeedChange) {
      const tag = retime.isDynamic ? 'DYN' : `${Math.round((retime.speed ?? 1) * 100)}%`;
      const typeLabel = retime.freeze ? 'FRZ' : retime.reversed ? 'REV' : tag;
      badges.push(`<span class="pm-vfx-pull-badge pm-vfx-pull-badge--speed" title="Speed: ${retime.originalSummary || tag}">SPD ${typeLabel}</span>`);
    }

    // ── Sidecars ──
    if (_state.fdls[i])    badges.push('<span class="pm-vfx-pull-badge" title="FDL generated">FDL</span>');
    if (_state.amfXmls[i] && !colorPlan?.amfPath) badges.push('<span class="pm-vfx-pull-badge pm-vfx-pull-badge--amf" title="AMF generated">AMF</span>');

    // ── EXR render status (new pipeline status strings) ──
    if (exr) {
      if (exr.status === 'done') {
        const qcPass = exr.qc?.pass !== false;
        badges.push(qcPass
          ? `<span class="pm-vfx-pull-badge pm-vfx-pull-badge--exr" title="EXR done · QC pass">EXR ✓</span>`
          : `<span class="pm-vfx-pull-badge pm-vfx-pull-badge--exr" title="EXR done · QC warnings: ${_esc((exr.qc?.warnings || []).join(', '))}">EXR ⚠</span>`
        );
      } else if (exr.status === 'qc_fail') {
        const errs = (exr.qc?.errors || []).join('; ');
        badges.push(`<span class="pm-vfx-pull-badge pm-vfx-pull-badge--err" title="QC failed: ${_esc(errs)}">EXR QC✗</span>`);
      } else if (exr.status === 'rendering') {
        badges.push(`<span class="pm-vfx-pull-badge pm-vfx-pull-badge--exr-run" title="Rendering…">EXR ${exr.progress || 0}%</span>`);
      } else if (exr.status === 'rendered') {
        badges.push(`<span class="pm-vfx-pull-badge pm-vfx-pull-badge--exr-run" title="Rendered, running QC…">EXR QC…</span>`);
      } else if (exr.status === 'error') {
        badges.push(`<span class="pm-vfx-pull-badge pm-vfx-pull-badge--err" title="Render error: ${_esc(exr.error || '')}">EXR ✗</span>`);
      }
    }

    if (_verifyData[i]?.approved) badges.push('<span class="pm-vfx-pull-badge pm-vfx-pull-badge--ok" title="User approved QT Ref ↔ OCF link">APPROVED</span>');

    const warnings = row.warnings || [];
    const warnChips = warnings.slice(0, 2).map(w =>
      `<span class="pm-vfx-pull-chip-warn" title="${_esc(w)}">${_esc(w.slice(0, 12))}</span>`
    ).join('');

    // Per-row Relink button — routes through the new _manualRelinkShot which
    // probes the picked file and persists the link in _state.manualLinks.
    // data-action="relink" is kept as fallback alias (legacy click handler path).
    const isManual  = !!_state.matchResults[i]?.match?._manualLink;
    const relinkBtn = `<button class="pm-vfx-pull-relink" data-action="manual-relink" data-idx="${i}" type="button" title="Pick OCF file manually">Relink</button>`;
    const clearBtn  = isManual
      ? `<button class="pm-vfx-pull-relink pm-vfx-pull-relink--clear" data-action="clear-manual-link" data-idx="${i}" type="button" title="Clear manual OCF link">Clear</button>`
      : '';

    const isSelected = _state.selectedJobs.has(i);
    return `
<div class="pm-vfx-pull-row pm-vfx-pull-row--${rowStatus}${isSelected ? '' : ' pm-vfx-pull-row--desel'}" data-idx="${i}">
  <label class="pm-vfx-pull-row-sel-wrap" title="Include in export">
    <input type="checkbox" class="pm-vfx-pull-sel" data-sel="${i}" ${isSelected ? 'checked' : ''}>
  </label>
  <span class="pm-vfx-pull-dot pm-vfx-pull-dot--${rowStatus}" title="${statusLabel}"></span>
  <span class="pm-vfx-pull-shotname" title="${_esc(shotName)}">${_esc(shortShot)}</span>
  <span class="pm-vfx-pull-clip" title="${_esc(ocfPath)}">${_esc(shortClip)}</span>
  <span class="pm-vfx-pull-conf ${confClass}">${confLabel}</span>
  <span class="pm-vfx-pull-badges">${badges.join('')}</span>
  ${warnChips}
  ${relinkBtn}${clearBtn}
</div>`;
  });

  table.innerHTML = rows.join('');
  wrap.style.display = '';

  const total    = _state.jobs.length;
  const selCount = _state.selectedJobs.size;
  if (summEl) {
    const selNote = (selCount < total) ? ` · ${selCount} selected` : '';
    summEl.textContent = `${total} shot${total !== 1 ? 's' : ''} · ${ready} ready · ${review} review · ${missing} missing${selNote}`;
  }

  // Keep select-all checkbox in sync
  const selAllCb = document.getElementById('pmVfxSelAll');
  if (selAllCb) {
    selAllCb.checked       = selCount > 0 && selCount === total;
    selAllCb.indeterminate = selCount > 0 && selCount < total;
  }

  try { _wsRefreshWorkspace(); } catch (_e) {}
}

function _updateOcfSummary() {
  const el = document.getElementById('pmVfxOcfSummary');
  const toolbarEl = document.getElementById('pmOcfSummary');
  if (!_state.matchResults?.length) {
    if (el) el.textContent = '';
    if (toolbarEl) toolbarEl.textContent = 'OCF: not linked';
    return;
  }
  const rows = _state.matchResults.map((r, i) => _normalizeMatchRow(r, _state.jobs?.[i]));
  // Count a row as linked if it has a sourcePath AND status is SAFE or the
  // row was manually linked — mirrors the ocfLinked definition used by the
  // Settings verify tab so both panels show the same count.
  const linked  = rows.filter(r => (r.status === 'SAFE') || (r.sourcePath && r.match?._manualLink)).length;
  const review  = rows.filter(r => r.status === 'REVIEW_NEEDED' || r.status === 'NOT_RECOMMENDED').length;
  const missing = rows.filter(r => r.status === 'MISSING').length;
  const libSuffix = _state.ocfFromLibrary ? ' · 📚 library (confirm TC)' : '';
  const text = `${linked} linked / ${review} review / ${missing} missing${libSuffix}`;
  if (el) el.textContent = text;
  if (toolbarEl) toolbarEl.textContent = `OCF: ${text}`;
}

function _resolveRowStatus(job, mr) {
  if (job.status === 'missing_ocf') return 'missing';
  switch (mr.status) {
    case MATCH_STATUS.SAFE: return 'ready';
    case MATCH_STATUS.REVIEW_NEEDED: return 'review';
    case MATCH_STATUS.NOT_RECOMMENDED: return 'review';
    case MATCH_STATUS.MISSING: return 'missing';
    default: return 'review';
  }
}

// ---------------------------------------------------------------------------
// Workflow dot updates
// ---------------------------------------------------------------------------

function _updateWfDots(exported = false) {
  // Workflow strip lights up as each spec stage completes. The strip is:
  // Timeline → QT Ref → OCF → Reconnect → Color → Frame → EXR → QC.
  // We infer state from _state — no separate flags needed.
  const hasTimeline = (_state.matchResults || []).length > 0
    || (_state.jobs || []).length > 0;
  const hasRef      = !!(_state.refAssetIdSeen);
  const hasOcf      = !!_state.ocfFolder && (_state.ocfFiles || []).length > 0;
  const hasMatch    = (_state.matchResults || []).length > 0;
  // Reconnect dot: when Resolve is live require an actual relink; when Resolve
  // is not connected treat any successful OCF match as "reconnected" (manual
  // reconnect is the user's responsibility outside PostFlowX in that case).
  const hasReconnect = hasMatch && (_state.resolveConnected
    ? _state.resolveReconnected
    : true);
  const hasColor    = (_state.jobs || []).some(j => !!j?.colorPlan?.idtName || !!j?.color?.match);
  const hasFrame    = (_state.jobs || []).some(j =>
    (!!j?.geometry?.hasGeometry) ||
    (!!j?.reframe && j.reframe.mode && j.reframe.mode !== 'none')
  );
  const hasExr      = exported || (_state.exrResults || []).some(r =>
    r?.status === 'done' || r?.status === 'qc_fail' ||
    r?.status === 'qc_passed' || r?.status === 'qc_warning'  // back-compat
  );
  const hasQc       = (_state.exrResults || []).some(r => r?.qc != null)
    || (_state.qcShots || []).length > 0;

  const anyWarn = (_state.matchResults || []).some(mr => {
    const st = mr?.match?.status || mr?.status;
    return st === MATCH_STATUS.REVIEW_NEEDED
        || st === MATCH_STATUS.NOT_RECOMMENDED
        || st === MATCH_STATUS.MISSING;
  });

  _setWfDot('pmVfxWfTimeline', hasTimeline,  false);
  _setWfDot('pmVfxWfRef',      hasRef,       false);
  _setWfDot('pmVfxWfOcf',      hasOcf,       false);
  _setWfDot('pmVfxWfMatch',    hasReconnect, anyWarn);
  _setWfDot('pmVfxWfColor',    hasColor,    false);
  _setWfDot('pmVfxWfFrame',    hasFrame,    false);
  _setWfDot('pmVfxWfExr',      hasExr,      false);
  _setWfDot('pmVfxWfQc',       hasQc,       false);

  const resolveBadge = document.getElementById('pmVfxResolveBadge');
  if (resolveBadge) resolveBadge.style.display = _state.resolveConnected ? '' : 'none';

  // Back-compat: old dot IDs may still be present in legacy DOM (extension
  // reload mid-session) — light them up too so nothing looks broken.
  _setWfDot('pmVfxWfFdl',      (_state.fdls    || []).length > 0, false);
  _setWfDot('pmVfxWfAmf',      (_state.amfXmls || []).length > 0, false);
  _setWfDot('pmVfxWfExport',   exported, false);
}

function _setWfDot(id, done, warn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.toggle('is-done', done && !warn);
  el.classList.toggle('is-warn', done && warn);
}

// ---------------------------------------------------------------------------
// OCR burn-in helpers
// ---------------------------------------------------------------------------

let _ocrWorker = null;

function _getOcrClient() {
  if (_ocrWorker) return _ocrWorker;
  const url = chrome?.runtime?.getURL
    ? chrome.runtime.getURL('scripts/ocr_burnin_worker.js')
    : 'scripts/ocr_burnin_worker.js';
  const worker = new Worker(url);
  let seq = 0;
  const pending = new Map();
  worker.onmessage = ev => {
    const msg = ev.data || {};
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg); else p.reject(new Error(msg.error || 'OCR error'));
  };
  worker.onerror = () => { _ocrWorker = null; };
  _ocrWorker = {
    async recognize(imageData, opts = {}) {
      const id = `vfxpull_ocr_${Date.now()}_${++seq}`;
      const rgba = new Uint8Array(imageData.data);
      const p = new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej }));
      worker.postMessage(
        { id, type: 'recognize', image: { buffer: rgba.buffer, width: imageData.width, height: imageData.height },
          psm: opts.psm, whitelist: opts.whitelist },
        [rgba.buffer]
      );
      const res = await Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('OCR timeout')), 20000))]);
      return String(res.text || '').trim();
    }
  };
  return _ocrWorker;
}

async function _dataUrlToImageData(dataUrl, w, h) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      resolve(ctx.getImageData(0, 0, w, h));
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}

// Extract a camera filename from raw OCR text.
// OCR of burn-in often reads multi-line — we want the token that looks like
// a camera file name: e.g. A001L002_25030194 or A001C003_250301AB.mxf
function _extractFilenameFromOcr(raw) {
  if (!raw) return '';
  const tokens = raw.split(/[\s\r\n]+/).filter(Boolean);
  // Camera filename patterns: starts with letter(s), digits, underscore sequences
  const camPat = /^[A-Za-z]\d{3,4}[A-Za-z]\d{3,}/;
  for (const tok of tokens) {
    const clean = tok.replace(/[^A-Za-z0-9_\-\.]/g, '');
    if (camPat.test(clean) && clean.length >= 8) return clean.replace(/\.[a-z]{2,4}$/i, '');
  }
  // Fallback: longest alphanumeric+underscore token that looks like a filename
  const fallback = tokens
    .map(t => t.replace(/[^A-Za-z0-9_\-]/g, ''))
    .filter(t => t.length >= 8 && /[A-Za-z]/.test(t) && /\d/.test(t))
    .sort((a, b) => b.length - a.length)[0];
  return fallback || '';
}

// ---------------------------------------------------------------------------
// Shot detail flyout
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// VFX Pull Verification Station — QT Ref ↔ OCF still-frame compare
// ---------------------------------------------------------------------------
function _selectVerifyShot(idx) {
  if (!Number.isFinite(idx)) return;
  _verifyIdx = Math.max(0, idx);
  _renderVerifyStation();
}

function _currentVerifyRow() {
  const idx = Math.max(0, Math.min(_verifyIdx || 0, (_state.jobs || []).length - 1));
  return {
    idx,
    job: _state.jobs?.[idx] || null,
    row: _state.normalisedRows?.[idx] || null,
    match: _state.matchResults?.[idx] || null,
    data: _verifyData[idx] || {},
  };
}

function _statusClass(score, approved) {
  if (approved || score >= 90) return 'is-ok';
  if (score >= 70) return 'is-warn';
  return score > 0 ? 'is-bad' : '';
}

function _renderVerifyStation() {
  const viewer = document.getElementById('pmVfxVerifyViewer');
  if (!viewer) return;
  const { idx, job, row, data } = _currentVerifyRow();
  const conf = Number(row?.confidence || 0);
  const approved = !!data.approved;
  const score = approved ? Math.max(90, conf || 100) : conf;
  viewer.className = `pm-vfx-verify-viewer mode-${_verifyMode || 'side'}`;
  const qt = data.qtRef ? `<img src="${data.qtRef}" alt="QT reference still">` : `<div class="pm-vfx-verify-empty">QT Ref still not captured.<br>Seek QT Ref to the shot frame,<br>then click Capture QT Frame.</div>`;
  const ocf = data.ocfRef ? `<img src="${data.ocfRef}" alt="OCF still">` : `<div class="pm-vfx-verify-empty">OCF still not extracted.<br>Select a shot and click<br>Extract OCF Frame.</div>`;
  viewer.innerHTML = `
    <div class="pm-vfx-verify-pane qt"><span class="pm-vfx-verify-pane-label">QT REF</span>${qt}</div>
    <div class="pm-vfx-verify-pane ocf"><span class="pm-vfx-verify-pane-label">OCF</span>${ocf}</div>`;

  const pill = document.getElementById('pmVfxVerifyReadyPill');
  if (pill) {
    pill.className = `pm-vfx-verify-pill ${_statusClass(score, approved)}`;
    const name = row?.shotName || job?.shotId || `Shot ${idx + 1}`;
    pill.textContent = approved ? `Approved · ${name}` : score >= 90 ? `Safe to Pull · ${Math.round(score)}%` : score ? `Review · ${Math.round(score)}%` : 'Not checked';
  }
  const sourceEl = document.getElementById('pmVfxScoreSource');
  const frameEl = document.getElementById('pmVfxScoreFrame');
  const readyEl = document.getElementById('pmVfxScoreReady');
  if (sourceEl) sourceEl.textContent = score ? `${Math.round(score)}%` : '—';
  if (frameEl) frameEl.textContent = data.ocfRef && data.qtRef ? 'Compare' : 'Still needed';
  if (readyEl) readyEl.textContent = approved ? 'Approved' : score >= 90 ? 'Safe' : score >= 70 ? 'Review' : 'Locked';

  const ocfStrip = document.getElementById('pmVfxOcfStrip');
  if (ocfStrip) {
    const labels = ['Handle','In','25%','50%','75%','Out','Tail'];
    ocfStrip.innerHTML = labels.map((l, n) => `<span class="pm-vfx-verify-frame">${data.contactSheet ? '✓ ' : ''}${l}</span>`).join('');
  }
}

async function _captureQtRefFrame() {
  const { idx, row, job } = _currentVerifyRow();
  try {
    const qtPath = row?.event?.sourcePath || '';
    if (window.pfxPlatform?.media && qtPath) {
      // Electron: extract still from QT Ref file via AVFoundation at the source-in timecode.
      _setStatus('Extracting QT Ref frame…');
      const tc = job?.sourceIn || row?.tcIn || '00:00:00:00';
      const r = await window.pfxPlatform.media.getStill({ path: qtPath, timecode: tc, outputWidth: 480 });
      const dataUrl = r?.dataUrl || r?.imageDataUrl || null;
      if (!dataUrl) throw new Error('No frame returned from AVFoundation');
      _verifyData[idx] = { ...(_verifyData[idx] || {}), qtRef: dataUrl, updatedAt: new Date().toISOString() };
      _setStatus('QT Ref frame captured via AVFoundation');
    } else {
      // Chrome extension / fallback: draw from the visible <video> element.
      const video = document.querySelector('#pmSlyViewerSlot video, #main-prepmark video, video');
      if (!video || !video.videoWidth) throw new Error('QT Ref video is not ready');
      const canvas = document.createElement('canvas');
      const w = 480;
      const h = Math.max(1, Math.round(w * (video.videoHeight / video.videoWidth)));
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(video, 0, 0, w, h);
      _verifyData[idx] = { ...(_verifyData[idx] || {}), qtRef: canvas.toDataURL('image/jpeg', 0.82), updatedAt: new Date().toISOString() };
      _setStatus('QT Ref frame captured');
    }
  } catch (e) {
    _setStatus(`QT capture failed: ${e?.message || e}`);
  }
  _renderVerifyStation();
}

let _extractOcfBusy = false;
async function _extractVerifyOcfFrame() {
  if (_extractOcfBusy) return;
  _extractOcfBusy = true;
  const { idx, job, row } = _currentVerifyRow();
  const filePath = row?.sourcePath || job?.sourcePath || '';
  const tc = job?.sourceIn || row?.tcIn || row?.srcIn || '00:00:00:00';
  // OCF free-run start TC so the still seeks to the matched frame, not the slate.
  const ocfStartTc = row?.ocf?.tcIn || '';
  const ocfFps = row?.ocf?.fps || 0;
  if (!filePath) { _setStatus('No OCF path for selected shot'); _extractOcfBusy = false; return; }
  _setStatus('Extracting OCF still frame…');
  try {
    let dataUrl = null;
    if (window.pfxPlatform?.media) {
      const r = await window.pfxPlatform.media.getOcfStill({ ocfPath: filePath, sourceTc: tc, sourceStartTc: ocfStartTc, fps: ocfFps, outputWidth: 480 });
      dataUrl = r?.dataUrl || r?.imageDataUrl || null;
    } else {
      const result = await nativeOcfExtractFrame(filePath, tc, { width: 480, height: 270, format: 'jpg', sourceStartTc: ocfStartTc, fps: ocfFps });
      dataUrl = result?.data?.dataUrl || null;
    }
    if (!dataUrl) throw new Error('No frame returned');
    _verifyData[idx] = { ...(_verifyData[idx] || {}), ocfRef: dataUrl, updatedAt: new Date().toISOString() };
    _setStatus('OCF still extracted');
  } catch (e) {
    _setStatus(`OCF still failed: ${e?.message || e}`);
  }
  _extractOcfBusy = false;
  _renderVerifyStation();
}

async function _runSevenFrameCheck() {
  const { idx, job, row } = _currentVerifyRow();
  const filePath = row?.sourcePath || job?.sourcePath || '';
  const tcIn  = job?.sourceIn  || row?.tcIn  || row?.srcIn  || '00:00:00:00';
  const tcOut = job?.sourceOut || row?.tcOut || row?.srcOut || '00:00:00:00';
  const fps   = job?.fps || 24;

  if (!filePath) { _setStatus('No OCF path for this shot'); return; }

  const labels = ['Handle', 'In', '25%', '50%', '75%', 'Out', 'Tail'];
  const strip  = document.getElementById('pmVfxOcfStrip');
  if (strip) strip.innerHTML = labels.map(l =>
    `<span class="pm-vfx-verify-frame" style="background:rgba(255,255,255,.04)">${l}</span>`
  ).join('');

  _setStatus('Extracting 7-frame contact sheet…');

  const tcToFrames = (tc) => {
    const [h, m, s, f] = String(tc).split(/[:;]/).map(Number);
    return Math.round(((h * 3600 + m * 60 + s) * fps) + f);
  };
  const framesToTc = (n) => {
    const f = n % fps, s = Math.floor(n / fps);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sc = s % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sc).padStart(2,'0')}:${String(f).padStart(2,'0')}`;
  };

  const fIn   = tcToFrames(tcIn);
  const fOut  = tcToFrames(tcOut);
  const fSpan = Math.max(fOut - fIn, 1);
  const sampleFrames = [
    fIn  - 8,
    fIn,
    fIn  + Math.round(fSpan * 0.25),
    fIn  + Math.round(fSpan * 0.50),
    fIn  + Math.round(fSpan * 0.75),
    fOut,
    fOut + 8,
  ];

  const results = await Promise.allSettled(
    sampleFrames.map(async (f) => {
      const tc = framesToTc(Math.max(0, f));
      if (window.pfxPlatform?.media) {
        const r = await window.pfxPlatform.media.getOcfStill({ ocfPath: filePath, sourceTc: tc, outputWidth: 200 });
        return r?.dataUrl || r?.imageDataUrl || null;
      }
      const res = await nativeOcfExtractFrame(filePath, tc, { width: 200, height: 112, format: 'jpg' });
      return res?.data?.dataUrl || null;
    })
  );

  if (strip) {
    strip.innerHTML = labels.map((l, i) => {
      const r  = results[i];
      const du = r?.status === 'fulfilled' ? r.value : null;
      if (du) return `<span class="pm-vfx-verify-frame" style="background-image:url(${du});background-size:cover;background-position:center"></span>`;
      return `<span class="pm-vfx-verify-frame" style="color:rgba(255,80,80,.7)">✗ ${l}</span>`;
    }).join('');
  }

  const okCount = results.filter(r => r.status === 'fulfilled' && r.value).length;
  const conf = Math.round(Number(row?.confidence || 0));
  _verifyData[idx] = { ...(_verifyData[idx] || {}), contactSheet: true, score: conf, updatedAt: new Date().toISOString() };
  _setStatus(`7-frame check: ${okCount}/7 frames extracted · ${conf || 'manual'}% confidence`);
  _renderVerifyStation();
}

function _approveCurrentLink() {
  const { idx, row } = _currentVerifyRow();
  if (!row?.sourcePath) { _setStatus('Can’t approve — no camera file linked. Use Relink on this row, or run ⚡ Smart Link OCF to match all shots.'); return; }
  _verifyData[idx] = { ...(_verifyData[idx] || {}), approved: true, approvedAt: new Date().toISOString() };
  _setStatus('OCF link approved for EXR pull');
  _renderVerifyStation();
  _renderShotTable();
}

function _openShotDetail(idx) {
  if (idx < 0 || idx >= _state.jobs.length) return;
  _activeDetailIdx = idx;

  const ov = document.getElementById('pmVfxPullDetailOverlay');
  if (!ov) return;

  const job    = _state.jobs[idx] || {};
  const row    = (_state.normalisedRows || [])[idx] || {};
  const rawMr  = _state.matchResults[idx] || {};
  const event  = rawMr.event || {};
  const fdl    = _state.fdls[idx] || {};

  const shotName    = job.shotName || row.shotName || row.clipName || `Shot ${idx + 1}`;
  const clipName    = row.clipName || '—';
  const filePath    = row.sourcePath || '';
  const conf        = row.confidence || 0;
  const confClass   = conf >= 85 ? 'is-ok' : conf >= 60 ? 'is-warn' : 'is-error';
  const status      = _resolveRowStatus(job, row);
  const statusLabel = status === 'ready' ? 'Ready' : status === 'review' ? 'Needs review' : 'Missing OCF';

  const tcIn        = row.tcIn  || job.tcIn  || fdl?.sourceTcIn  || '—';
  const tcOut       = row.tcOut || job.tcOut || fdl?.sourceTcOut || '—';
  const recIn       = row.recIn  || event.recIn  || '—';
  const recOut      = row.recOut || event.recOut || '—';
  const frameCount  = job.frameCount || 0;
  const handles     = _settings.handles;
  const frameStart  = _settings.frameStart;
  const plateFormat = _settings.plateFormat || 'exr_aces';
  const pullMode    = _settings.pullMode || 'ocf_native';
  const cameraModel = row.cameraModel || event.cameraModel || '—';
  // Compute IDT URN directly from cameraModel — _state.amfXmls[idx] is a
  // string, not an object, so idtUrn cannot be read from it.
  const _computedUrn = resolveIdtUrn ? resolveIdtUrn(cameraModel) : null;
  const idtUrn      = (_computedUrn && _computedUrn !== 'urn:ampas:clf:idtUnknown') ? _computedUrn : '—';
  const idtShort    = idtUrn !== '—' ? idtUrn.split('.').slice(-3, -1).join('.') : '—';
  const matchMethod = rawMr.match?.method || rawMr.match?.matchMethod || row.match?.method || '—';
  const reformatNotes = job.reframe?.notes || job.reframe?.fit || fdl?.reformatNotes || '—';
  const colorSpace  = job.color?.outputColorSpace || fdl?.outputColorSpace || 'ACES2065-1';

  // Resolve-specific event data (only present when events came from live Resolve)
  const fromResolve  = !!event._fromResolve;
  const isOffline    = !!row.isOffline;
  const trackNum     = event._trackNum ?? null;
  const speedFactor  = event.speedFactor ?? null;
  const speedPct     = event.speedPercent ?? null;
  const isDynSpeed   = !!event.isDynamicSpeed;
  const hasTransform = !!event.transform;
  const isResolveDirect = row.match?.method === 'resolve_direct';

  const approvedBadge = _verifyData[idx]?.approved ? '<span class="pm-vfx-pull-badge pm-vfx-pull-badge--ok" title="User approved QT Ref ↔ OCF link">APPROVED</span>' : '';

    const warnings = row.warnings || [];
  const warnHtml = warnings.length
    ? `<div class="pm-vfx-detail-section">
        <div class="pm-vfx-detail-section-hdr">Warnings</div>
        <div class="pm-vfx-detail-warns">
          ${warnings.map(w => `<span class="pm-vfx-pull-chip-warn" title="${_esc(w)}">${_esc(w)}</span>`).join('')}
        </div>
      </div>`
    : '';

  const cdl = job?.color?.match?.cdl || fdl?.cdl || null;
  const cdlHtml = cdl
    ? `<div class="pm-vfx-detail-section">
        <div class="pm-vfx-detail-section-hdr">CDL Estimate</div>
        <div class="pm-vfx-detail-cdl-block">
S &nbsp;&nbsp;${cdl.slope  ? cdl.slope.map(v  => v.toFixed(4)).join('&nbsp;&nbsp;') : '1.0000&nbsp;&nbsp;1.0000&nbsp;&nbsp;1.0000'}<br>
O &nbsp;&nbsp;${cdl.offset ? cdl.offset.map(v => v.toFixed(4)).join('&nbsp;&nbsp;') : '0.0000&nbsp;&nbsp;0.0000&nbsp;&nbsp;0.0000'}<br>
P &nbsp;&nbsp;${cdl.power  ? cdl.power.map(v  => v.toFixed(4)).join('&nbsp;&nbsp;') : '1.0000&nbsp;&nbsp;1.0000&nbsp;&nbsp;1.0000'}<br>
Sat ${cdl.sat != null ? Number(cdl.sat).toFixed(4) : '1.0000'}
        </div>
        <div class="pm-vfx-detail-cdl-warn">&#9888; Reference preview match — not final DI grade</div>
      </div>`
    : '';

  // Resolve-specific section — only rendered when the event came from live Resolve.
  const resolveHtml = fromResolve ? `
    <div class="pm-vfx-detail-section">
      <div class="pm-vfx-detail-section-hdr">Resolve Source</div>
      <div class="pm-vfx-detail-kv-grid">
        ${isOffline ? '<span style="color:#ff5d6d;grid-column:1/-1;font-weight:600;">&#9888; Offline in Resolve — use Relink to locate</span>' : ''}
        ${isResolveDirect ? '<span style="color:#0AA356;grid-column:1/-1;">&#10003; Linked directly from Resolve media pool</span>' : ''}
        ${trackNum != null ? `<span>Track</span><span>V${trackNum}</span>` : ''}
        ${isDynSpeed
          ? '<span>Speed</span><span style="color:#ffb94a;">Dynamic ramp</span>'
          : speedFactor != null
            ? `<span>Speed</span><span>${Math.round(speedPct)}% (${speedFactor.toFixed(3)}×)</span>`
            : ''}
        ${hasTransform ? `<span>Transform</span><span style="color:#ffb94a;">Pan/zoom applied — check reframe</span>` : ''}
        <span>Rec In</span><span>${_esc(recIn)}</span>
        <span>Rec Out</span><span>${_esc(recOut)}</span>
        ${event.sourcePath ? `<span>Media</span><span title="${_esc(event.sourcePath)}">${_esc(event.sourcePath.split('/').pop())}</span>` : ''}
      </div>
    </div>` : '';

  ov.innerHTML = `
<div class="pm-vfx-detail-panel">
  <div class="pm-vfx-detail-topbar">
    <span class="pm-vfx-pull-dot pm-vfx-pull-dot--${status}"></span>
    <span class="pm-vfx-detail-title">${_esc(shotName)}</span>
    <button class="pm-vfx-detail-close" id="pmVfxDetailClose">&#215;</button>
  </div>
  <div class="pm-vfx-detail-body">

    <div class="pm-vfx-detail-clip-row">
      <span class="pm-vfx-detail-clip-name" title="${_esc(filePath)}">${_esc(clipName)}</span>
      <span class="pm-vfx-detail-match-status ${confClass}">${_esc(statusLabel)}</span>
    </div>

    <div class="pm-vfx-detail-frames">
      <div class="pm-vfx-detail-frame-slot">
        <div class="pm-vfx-detail-frame-label">OCF FRAME</div>
        <div class="pm-vfx-detail-frame-loading" id="pmVfxDetailFrameWrap">
          <span id="pmVfxDetailFrameMsg">Loading…</span>
        </div>
        <div class="pm-vfx-detail-frame-tc" id="pmVfxDetailFrameTc">${_esc(tcIn)}</div>
      </div>
      <div class="pm-vfx-detail-scores">
        <div class="pm-vfx-detail-score-title">MATCH</div>
        ${_scoreBar('Overall', conf, confClass)}
        <div class="pm-vfx-detail-score-row">
          <span>Method</span>
          <span class="pm-vfx-detail-method-tag">${_esc(matchMethod)}</span>
        </div>
        <div class="pm-vfx-detail-score-row">
          <span>Status</span>
          <span class="pm-vfx-detail-method-tag">${_esc(row.status || rawMr.match?.status || '—')}</span>
        </div>
      </div>
    </div>

    <div class="pm-vfx-detail-section">
      <div class="pm-vfx-detail-section-hdr">Pull Parameters</div>
      <div class="pm-vfx-detail-kv-grid">
        <span>Src In</span><span>${_esc(tcIn)}</span>
        <span>Src Out</span><span>${_esc(tcOut)}</span>
        ${recIn !== '—' ? `<span>Rec In</span><span>${_esc(recIn)}</span>` : ''}
        ${recOut !== '—' ? `<span>Rec Out</span><span>${_esc(recOut)}</span>` : ''}
        <span>Frames</span><span>${frameCount} fr (incl. ${handles}f handles/side)</span>
        <span>Start</span><span>${frameStart}</span>
        <span>Format</span><span>${_esc(plateFormat)}</span>
        <span>Color Space</span><span>${_esc(colorSpace)}</span>
        <span>Reformat</span><span>${_esc(reformatNotes)}</span>
      </div>
    </div>

    <div class="pm-vfx-detail-section">
      <div class="pm-vfx-detail-section-hdr">Camera / Color</div>
      <div class="pm-vfx-detail-kv-grid">
        <span>Camera</span><span>${_esc(cameraModel)}</span>
        <span>IDT</span><span>${_esc(idtShort)}${job.colorPlan?.idtAutoDetected ? ' · 🎬 Auto (OCF)' : ''}</span>
        <span>Pull Mode</span><span>${_esc(pullMode)}</span>
      </div>
    </div>

    ${resolveHtml}
    ${cdlHtml}
    ${warnHtml}

  </div>
</div>`;

  ov.style.display = 'flex';

  const _escKey = e => {
    if (e.key === 'Escape') { _closeShotDetail(); document.removeEventListener('keydown', _escKey); }
  };
  document.addEventListener('keydown', _escKey);

  const closeBtn = document.getElementById('pmVfxDetailClose');
  if (closeBtn) closeBtn.addEventListener('click', () => {
    document.removeEventListener('keydown', _escKey);
    _closeShotDetail();
  });

  _loadDetailFrame(idx, filePath, tcIn);
}

function _closeShotDetail() {
  _activeDetailIdx = -1;
  const ov = document.getElementById('pmVfxPullDetailOverlay');
  if (ov) { ov.style.display = 'none'; ov.innerHTML = ''; }
}

function _scoreBar(label, value, cls) {
  const pct = Math.max(0, Math.min(100, value));
  return `<div class="pm-vfx-detail-score-row">
    <span>${_esc(label)}</span>
    <div class="pm-vfx-detail-bar-track"><div class="pm-vfx-detail-bar ${cls}" style="width:${pct}%"></div></div>
    <span class="pm-vfx-detail-score-val">${Math.round(pct)}%</span>
  </div>`;
}

async function _loadDetailFrame(idx, filePath, tcIn) {
  if (!filePath) {
    const msgEl = document.getElementById('pmVfxDetailFrameMsg');
    if (msgEl) msgEl.textContent = 'No OCF path';
    return;
  }

  if (_detailFrameCache.has(idx)) {
    if (_activeDetailIdx === idx) _renderDetailFrame(_detailFrameCache.get(idx), idx);
    return;
  }

  try {
    const result = await nativeOcfExtractFrame(filePath, tcIn, { width: 480, height: 270, format: 'jpg' });
    if (!result?.data?.dataUrl) throw new Error('No frame data returned');
    const cached = { dataUrl: result.data.dataUrl, width: result.data.width || 480, height: result.data.height || 270 };
    _detailFrameCache.set(idx, cached);
    if (_activeDetailIdx === idx) _renderDetailFrame(cached, idx);
  } catch (err) {
    if (_activeDetailIdx !== idx) return;
    const wrap = document.getElementById('pmVfxDetailFrameWrap');
    if (wrap) {
      const msg = err.message?.toLowerCase().includes('companion') ? 'Companion offline' : 'Frame unavailable';
      wrap.innerHTML = `<span style="font-size:10px;color:rgba(228,235,255,0.35);">${msg}</span>`;
    }
  }
}

function _renderDetailFrame(cached, idx) {
  const wrap = document.getElementById('pmVfxDetailFrameWrap');
  if (!wrap) return;

  const img = document.createElement('img');
  img.src = cached.dataUrl;
  img.style.cssText = 'width:240px;height:135px;border-radius:5px;border:1px solid rgba(255,255,255,0.1);object-fit:contain;background:#080d1a;display:block;';
  img.alt = 'OCF frame';
  wrap.replaceWith(img);

  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 135;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 240, 135);
    try {
      const imageData = ctx.getImageData(0, 0, 240, 135);
      const lb = detectLetterboxPillarbox(imageData, 240, 135);
      if ((lb.hasLetterbox || lb.hasPillarbox) && _activeDetailIdx === idx) {
        const tcEl = document.getElementById('pmVfxDetailFrameTc');
        if (tcEl) {
          const note = [lb.hasLetterbox && 'letterbox', lb.hasPillarbox && 'pillarbox'].filter(Boolean).join('+');
          tcEl.textContent = (tcEl.textContent ? tcEl.textContent + ' · ' : '') + note;
        }
      }
    } catch (_e) {}
  };
}

// ---------------------------------------------------------------------------
// Export functions
// ---------------------------------------------------------------------------

function _exportFDL() {
  if (!_state.fdls.length) return;
  const csv = buildFDLCsv(_state.fdls);
  _downloadText('pull_list.fdl.csv', csv, 'text/csv');
  _state.fdls.forEach((fdl, i) => {
    const name = _plateName(i);
    const json = buildFDLJson(fdl);
    _downloadText(`${name}.fdl.json`, JSON.stringify(json, null, 2), 'application/json');
  });
  _setWfDot('pmVfxWfExport', true, false);
}

function _exportAMF() {
  if (!_state.amfXmls.length) return;
  _state.amfXmls.forEach((xml, i) => {
    const name = _plateName(i);
    _downloadText(`${name}.amf`, xml, 'application/xml');
  });
  _setWfDot('pmVfxWfExport', true, false);
}

async function _exportQcReport() {
  if (!_state.qcShots.length) return;
  const meta = await _providers.getProjectMeta?.() || {};
  const html = buildQcReportHtml(_state.qcShots, meta);
  const jsonStr = buildQcReportJson(_state.qcShots, meta);
  _downloadText('qc_report.html', html, 'text/html');
  _downloadText('qc_report.json', JSON.stringify(jsonStr, null, 2), 'application/json');
}

// Enrich each QC shot with hero frames + triage + handoff metadata, then emit
// the printable per-shot contact-sheet report (print-to-PDF in the browser).
async function _exportContactSheet() {
  if (!_state.qcShots.length) { _setStatus('Run analysis first'); return; }
  const meta = await _providers.getProjectMeta?.() || {};
  const enriched = _state.qcShots.map((shot, i) => {
    const job   = _state.jobs[i] || {};
    const sheet = _wsContactSheet[i] || {};
    const risk  = _computeShotRisk(i);
    const rf    = job.reframe || {};
    const rt    = job.retime  || {};
    const retimeStr = rt.freeze ? 'Freeze'
      : rt.isDynamic ? 'Dynamic ramp'
      : rt.reversed ? `Reverse ${Math.round(rt.speedPercent || 100)}%`
      : rt.hasSpeedChange ? `${Math.round(rt.speedPercent || (rt.speed || 1) * 100)}%`
      : 'Normal';
    return {
      ...shot,
      heroFrames:   { qt: sheet.qt || [], ocf: sheet.ocf || [] },
      risk,
      idt:          job.colorPlan?.idtName || job.color?.idtName || job.metadata?.idtName || '—',
      visualMatch:  job.metadata?.visualMatch ?? job.frameAlign?.confidence ?? null,
      colorConf:    job.color?.match?.confidence ?? null,
      drift:        job.frameAlign?.offsetFrames ?? null,
      driftApplied: !!job.frameAlign?.applied,
      reframe:      rf.mode && rf.mode !== 'none'
                      ? `${rf.targetWidth || ''}×${rf.targetHeight || ''} ${rf.fit || ''}`.trim()
                      : 'Editorial',
      retime:       retimeStr,
    };
  });
  const html = buildContactSheetHtml(enriched, meta);
  _downloadText('qc_contact_sheet.html', html, 'text/html');
  _setStatus('QC contact sheet exported — open in a browser and Print → Save as PDF');
}

// ---------------------------------------------------------------------------
// Per-shot QT-Ref vs OCF match — single frame-grab that drives BOTH the colour
// CDL (estimateCDL) and the reframe (detectLetterboxPillarbox + computeReformatParams).
// Returns { colorMatch, reframe } — either may be null if the inputs were
// insufficient. Stored on:
//   • job.color.match — feeds AMF lookTransform applied="false" (match_editorial / review_proxy)
//     and Nuke handoff OCIOCDLTransform disable=True (preview only). Never
//     bakes Rec709 into the ACES EXR plate.
//   • job.reframe — feeds FDL pull.referenceReformat + spec badge "FR N%".
// One frame-grab per shot for both ops — the most expensive part is the
// companion media decode, so combining halves the cost.
// ---------------------------------------------------------------------------
// estimateCDL samples a 5×5 grid of median-RGB patches and letterbox detection
// scans row luminance — both are robust at half-res, so decode 640×360 instead
// of 1280×720: ~4× fewer pixels to decode AND to loop over per shot.
const _MATCH_FRAME_W = 640;
const _MATCH_FRAME_H = 360;
const _TARGET_W      = 3840;
const _TARGET_H      = 2160;

// ── Frame-by-frame alignment (spec: "frame match frame by frame") ──────────
// Solves the integer frame drift between the editorial QT reference and the
// camera OCF using the perceptual-fingerprint engine in referenceMatchEngine.
// Small frames (fingerprints pool to 32×32 internally, so 320×180 is ample)
// keep the extra native decodes cheap. Tunable via _settings.frameAlign*.
const _FP_W          = 320;   // fingerprint decode width
const _FP_H          = 180;   // fingerprint decode height
const _ALIGN_LADDER  = 4;     // consecutive ref frames sampled from the cut-in
const _ALIGN_SEARCH  = 8;     // ± frames of OCF drift to search around srcIn

// Grab a single small frame at an absolute frame number and return its
// perceptual fingerprint (or null on any decode failure).
async function _grabFingerprintAt(assetId, frame, fps) {
  try {
    const tc  = _framesToTC(Math.max(0, Math.round(frame)), fps);
    const res = await nativeGrabThumbnailAtTimecode(
      assetId, tc, { width: _FP_W, height: _FP_H, format: 'jpg', mode: 'fast' },
    );
    const url = res?.dataUrl || res?.result?.dataUrl || '';
    if (!url) return null;
    const img = await _dataUrlToImageData(url, _FP_W, _FP_H);
    if (!img) return null;
    return buildFrameFingerprint(img.data, img.width, img.height);
  } catch {
    return null;
  }
}

// Solve the OCF in-point drift vs editorial by fingerprinting a short ladder
// of QT-ref frames and a wider OCF window, then sliding for the best visual
// match. Returns the integer drift (frames), a real visual match score, and
// the frame-accurate aligned source in-point.
async function _alignFramesForShot({ refAssetId, ocfSession, event, fps, ladder = _ALIGN_LADDER, searchWindow = _ALIGN_SEARCH }) {
  if (!refAssetId || !ocfSession || !event?.recIn || !event?.srcIn) return null;
  const f   = Number(fps) || 24;
  const recInF = _tcToFrames(event.recIn, f);
  const srcInF = _tcToFrames(event.srcIn, f);
  if (!Number.isFinite(recInF) || !Number.isFinite(srcInF)) return null;

  // Reference ladder: `ladder` consecutive frames from the editorial cut-in.
  const refFps = [];
  for (let k = 0; k < ladder; k++) {
    refFps.push(await _grabFingerprintAt(refAssetId, recInF + k, f));
  }
  // OCF window: ladder + 2·searchWindow consecutive frames, centred so that
  // index `searchWindow` corresponds to srcIn (zero-drift alignment).
  const ocfFps = [];
  const ocfStart = srcInF - searchWindow;
  for (let k = 0; k < ladder + 2 * searchWindow; k++) {
    ocfFps.push(await _grabFingerprintAt(ocfSession, ocfStart + k, f));
  }

  // Bail out gracefully if too many decodes failed to fingerprint.
  const refOk = refFps.filter(Boolean).length;
  const ocfOk = ocfFps.filter(Boolean).length;
  if (refOk < Math.ceil(ladder / 2) || ocfOk < ladder) {
    return { offsetFrames: 0, confidence: 0, alignedSrcIn: event.srcIn,
             srcInFrames: srcInF, ladder, searchWindow,
             warnings: ['Frame-align skipped — not enough decodable frames.'] };
  }

  // findBestFrameOffset pairs ref[ri] with ocf[ri+offset]. Zero drift sits at
  // offset = searchWindow (ocf[searchWindow] == srcIn), so drift = best − search.
  const { offsetFrames, confidence } =
    findBestFrameOffset(refFps, ocfFps, 2 * searchWindow);
  const drift        = offsetFrames - searchWindow;
  const alignedSrcInF = srcInF + drift;
  const warnings = [];
  if (Math.abs(drift) >= searchWindow) {
    warnings.push(`Frame-align hit the ±${searchWindow}f search edge — widen the window to confirm.`);
  }
  if (confidence < 55) {
    warnings.push('Low visual match — verify the OCF link manually before pulling.');
  }
  return {
    offsetFrames: drift,
    confidence:   Math.round(confidence),
    alignedSrcIn: _framesToTC(Math.max(0, alignedSrcInF), f),
    srcInFrames:  srcInF,
    ladder,
    searchWindow,
    warnings,
  };
}

// Apply a solved frame-align drift to a built pull job by sliding the entire
// source window by `offsetFrames` (duration + all frame counts unchanged — only
// the in/out anchors move). Returns true if applied. Caller must gate on
// confidence; this only does the mechanical, consistent shift.
function _applyFrameDriftToJob(job, offsetFrames) {
  if (!job || !offsetFrames) return false;
  // Dynamic retime ships an explicit per-frame source map that this slide would
  // not touch — skip to avoid map/render disagreement.
  if (Array.isArray(job.retime?.sourceFrameMap) && job.retime.sourceFrameMap.length) return false;
  const tcBase = Math.max(1, Math.round(Number(job.fps) || 24));
  const inF = _tcToFrames(job.exportIn || job.sourceIn || '00:00:00:00', tcBase);
  if (!Number.isFinite(inF) || inF + offsetFrames < 0) return false; // don't clamp (would change duration)
  const slide = (tc) => {
    const f = _tcToFrames(tc, tcBase);
    return Number.isFinite(f) ? _framesToTC(Math.max(0, f + offsetFrames), tcBase) : tc;
  };
  if (job.exportIn)  job.exportIn  = slide(job.exportIn);
  if (job.exportOut) job.exportOut = slide(job.exportOut);
  if (job.sourceIn)  job.sourceIn  = slide(job.sourceIn);
  if (job.sourceOut) job.sourceOut = slide(job.sourceOut);
  return true;
}

async function _matchFramesForShot({ event, sourcePath, refAssetId, settings }) {
  const out = { colorMatch: null, reframe: null, frameAlign: null };
  if (!refAssetId || !event?.recIn || !sourcePath || !event?.srcIn) return out;
  let ocfSession = null;
  try {
    // QT reference: frame at event.recIn (trailer/timeline position — that's
    // where the colour grade lives).
    const refRes = await nativeGrabThumbnailAtTimecode(
      refAssetId,
      event.recIn,
      { width: _MATCH_FRAME_W, height: _MATCH_FRAME_H, format: 'jpg', mode: 'fast' },
    );
    const refUrl = refRes?.dataUrl || refRes?.result?.dataUrl || '';
    if (!refUrl) return out;

    // OCF: open as a media session, frame at event.srcIn (source-clip position
    // — that's where the matching action sits in the unmodified rush).
    const openRes = await sharedMediaOpen(sourcePath);
    ocfSession = openRes?.assetId || openRes?.sessionId
              || openRes?.result?.assetId || openRes?.result?.sessionId
              || null;
    if (!ocfSession) return out;
    const ocfRes = await nativeGrabThumbnailAtTimecode(
      ocfSession,
      event.srcIn,
      { width: _MATCH_FRAME_W, height: _MATCH_FRAME_H, format: 'jpg', mode: 'fast' },
    );
    const ocfUrl = ocfRes?.dataUrl || ocfRes?.result?.dataUrl || '';
    if (!ocfUrl) return out;

    const refImg = await _dataUrlToImageData(refUrl, _MATCH_FRAME_W, _MATCH_FRAME_H);
    const ocfImg = await _dataUrlToImageData(ocfUrl, _MATCH_FRAME_W, _MATCH_FRAME_H);
    if (!refImg || !ocfImg) return out;

    // ── Colour match (spec #8) ─────────────────────────────────────────────
    try {
      const cdl = estimateCDL(
        refImg.data, ocfImg.data,
        refImg.width, refImg.height,
        ocfImg.width, ocfImg.height,
      );
      out.colorMatch = {
        source:        'qt_ref_rec709',
        workingSpace:  'ACEScct',
        cdl: {
          slope:      cdl.slope,
          offset:     cdl.offset,
          power:      cdl.power,
          // estimateCDL returns `sat`; downstream AMF generator reads `sat`,
          // FDL/Nuke may prefer the more verbose `saturation` — supply both.
          sat:        cdl.sat,
          saturation: cdl.sat,
        },
        confidence:   cdl.confidence,
        warnings:     cdl.warnings || [],
        appliedToExr: false,
      };
    } catch (e) {
      console.warn('[VfxPull] estimateCDL failed:', e);
    }

    // ── Reframe match (spec #9) ────────────────────────────────────────────
    // Detect letterbox/pillarbox on the OCF frame (active image area), then
    // compute scale/crop to fit the QT reference frame. Target resolution is
    // UHD by default — overridable via settings.targetResolution.
    try {
      const targetWH = String(settings?.targetResolution || '3840x2160').split('x').map(n => parseInt(n, 10));
      const targetWidth  = Number.isFinite(targetWH[0]) ? targetWH[0] : _TARGET_W;
      const targetHeight = Number.isFinite(targetWH[1]) ? targetWH[1] : _TARGET_H;

      const lb = detectLetterboxPillarbox(ocfImg.data, ocfImg.width, ocfImg.height);
      const rp = computeReformatParams(
        refImg.width, refImg.height,
        ocfImg.width, ocfImg.height,
        lb,
      );

      // Confidence heuristic: high when active area covers most of the OCF
      // frame and the scale change is moderate (avoids confidence on huge
      // up-rezes from low-res sources).
      const [_cx, _cy, cw, ch] = lb.activeCrop || [0, 0, ocfImg.width, ocfImg.height];
      const activePct = (cw * ch) / Math.max(1, ocfImg.width * ocfImg.height);
      const scaleSane = rp.scale > 0.25 && rp.scale < 8;
      const confidence = Math.round(Math.min(1, activePct * (scaleSane ? 1 : 0.5)) * 100) / 100;

      const reframeWarnings = [];
      if (!scaleSane) reframeWarnings.push(`Unusual scale ${rp.scale.toFixed(2)} — verify reformat manually.`);
      if (lb.hasLetterbox) reframeWarnings.push('Letterbox detected on OCF frame.');
      if (lb.hasPillarbox) reframeWarnings.push('Pillarbox detected on OCF frame.');

      out.reframe = {
        mode:         settings?.bakeReframe ? 'match_qt_ref_uhd' : 'none',
        targetWidth,
        targetHeight,
        fit:          rp.fit,
        scale:        rp.scale,
        cropBox:      rp.cropBox,
        notes:        rp.notes,
        // NLE transform merge — if the event came with a per-clip transform
        // from the editing app (Premiere/FCP/Resolve), preserve it alongside
        // the QT-derived reframe. Companion-side baker can choose to apply
        // either layer or both.
        position:     event.transform?.position || null,
        rotation:     event.transform?.rotation || 0,
        nleTransform: event.transform || null,
        reference: {
          colorSpace: 'Rec709',
          width:      refImg.width,
          height:     refImg.height,
          activeCrop: lb.activeCrop,
          recIn:      event.recIn || '',
          sourceIn:   event.srcIn || '',
        },
        confidence,
        warnings: reframeWarnings,
      };
    } catch (e) {
      console.warn('[VfxPull] reframe match failed:', e);
    }

    // ── Frame-by-frame alignment (spec #6) ─────────────────────────────────
    // Solve the integer OCF in-point drift vs editorial and produce a real
    // visual match score. Reuses the already-open ocfSession. Opt-out via
    // settings.frameAlign === false.
    //
    // Speed: this is ~24 small decodes/shot. When the OCF match is already
    // rock-solid (strong reel + TC), the source in-point is trusted and drift
    // is essentially impossible — so skip alignment above a confidence
    // threshold (default 95). settings.frameAlignAlways forces it on.
    const _alignMax  = Number(settings?.frameAlignMaxConfidence ?? 95);
    const _matchConf = Number(settings?.matchConfidence);
    const _alignNeeded = settings?.frameAlignAlways
      || !Number.isFinite(_matchConf) || _matchConf < _alignMax;
    if (settings?.frameAlign !== false && _alignNeeded) {
      try {
        out.frameAlign = await _alignFramesForShot({
          refAssetId,
          ocfSession,
          event,
          fps:          Number(settings?.fps) || Number(event?.fps) || 24,
          ladder:       Number(settings?.frameAlignLadder) || _ALIGN_LADDER,
          searchWindow: Number(settings?.frameAlignSearch) || _ALIGN_SEARCH,
        });
      } catch (e) {
        console.warn('[VfxPull] frame-align failed:', e);
      }
    }

    return out;
  } catch (e) {
    console.warn('[VfxPull] per-shot frame match failed:', e);
    return out;
  } finally {
    if (ocfSession) {
      try { await sharedMediaClose(ocfSession); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// EXR export — routes each planner job through the VFX render pipeline.
// Spec rules:
//   • Runs only when outputFolder is set AND exportMode !== 'sidecar_only'.
//   • EXR files land at <outputBase>/<plateName>/exr/ using job.outputPattern.
//   • Engine selected by job.colorPlan.engineHint (resolve → oiio → ffmpeg_fallback).
//   • Per-shot status streams back into _state.exrResults so row badges update live.
//   • After render: per-shot QC + sidecar write (frameMap, geometry, pullReport, QC).
// Returns the list of per-job result entries (one per planner job, same order).
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// ACES 2.0 Review Proxy — output transform picker + per-shot review movie.
// The ACES 2.0 ODT is baked onto the rendered AP0 EXR plates (display-referred
// Rec.709/P3 movie) — see api.py renderReviewProxyStart. Review-only, not a
// final VFX plate.
// ---------------------------------------------------------------------------

// Show the ODT row only for Review Proxy (the only mode that bakes an ODT).
function _syncOdtRow() {
  const row = document.getElementById('pmVfxOdtRow');
  if (row) row.style.display = (_settings.pullMode === 'review_proxy') ? '' : 'none';
  const sel = document.getElementById('pmVfxOdtTransform');
  if (sel && _settings.odtId) sel.value = _settings.odtId;
}

// Populate the ODT dropdown from the companion's available ACES 2.0 transforms.
async function _populateOdtTransforms() {
  const sel = document.getElementById('pmVfxOdtTransform');
  if (!sel) return;
  try {
    const res = await nativeAces2OutputTransforms();
    const list = res?.data?.transforms || res?.transforms || [];
    if (Array.isArray(list) && list.length) {
      sel.innerHTML = list.map(t => `<option value="${_esc(t.id)}">${_esc(t.label || t.id)}</option>`).join('');
      if (_settings.odtId && list.some(t => t.id === _settings.odtId)) {
        sel.value = _settings.odtId;
      } else {
        _settings.odtId = list[0].id;
      }
    }
  } catch (e) {
    console.warn('[VfxPull] ACES 2.0 ODT list unavailable:', e?.message || e);
  }
}

// Render a Rec.709 review movie per shot from its AP0 EXR plates, with the
// selected ACES 2.0 ODT baked. Reuses the EXR render-job status registry.
async function _runReviewProxies(jobs) {
  const results = _state.exrResults || [];
  const rendered = results.filter(r => r.outputDir && (r.status === 'done' || r.status === 'rendered'));
  if (!rendered.length) {
    _setStatus('No rendered EXR plates yet — run the pull first.');
    return;
  }
  const odtId = _settings.odtId || 'rec709_sdr';
  for (let i = 0; i < rendered.length; i++) {
    const r = rendered[i];
    _setStatus(`Review proxy ${r.plateName} (${i + 1}/${rendered.length})…`);
    try {
      const job = {
        exrDir:      r.outputDir,
        exrPattern:  `${r.plateName}.%04d.exr`,
        frameStart:  _settings.frameStart || 1001,
        fps:         _settings.fps || 24,
        codec:       'h264',
        shotId:      r.plateName,
        colorPlan:   { odtId, odtStandard: 'ACES 2.0' },
      };
      const startRes = await nativeRenderReviewProxyStart(job);
      const { jobId } = startRes?.data || startRes?.result || startRes || {};
      if (!jobId) throw new Error('no jobId');
      // poll (shared registry) — review encodes are fast
      const t0 = Date.now();
      while (Date.now() - t0 < 30 * 60 * 1000) {
        await new Promise(res => setTimeout(res, 1000));
        const stRes = await nativeRenderPullExrStatus(jobId);
        const st = stRes?.data || stRes?.result || stRes || {};
        if (st.state === 'done') { r.reviewMovie = st.result?.output || ''; break; }
        if (st.state === 'failed' || st.state === 'cancelled') throw new Error(st.error || st.state);
      }
    } catch (e) {
      console.warn('[VfxPull] Review proxy failed:', r.plateName, e?.message || e);
      _setStatus(`Review proxy error (${r.plateName}): ${e?.message || e}`);
    }
  }
  _setStatus(`Review proxies done (${rendered.length}) — ACES 2.0 ${odtId}`);
  _renderShotTable();
}

async function _runExrExport(jobs) {
  if (!jobs?.length) return [];
  if (!_settings.outputFolder) {
    console.info('[VfxPull] EXR export skipped — no output folder set.');
    return [];
  }
  if (_settings.exportMode === 'sidecar_only') {
    console.info('[VfxPull] EXR export skipped — exportMode is sidecar_only.');
    return [];
  }

  const outputBase = _settings.outputFolder.replace(/\/+$/, '');
  const frameStart = _settings.frameStart ?? 1001;

  // Augment each job with package paths + naming if not already set by the planner.
  // Engine override: if user selected a specific engine, force it onto the colorPlan.
  const engineOverride = _settings.renderEngine && _settings.renderEngine !== 'auto'
    ? _settings.renderEngine
    : null;

  const augmentedJobs = jobs.map((job, i) => {
    const plateName = job.plateName || _plateName(i);
    // If job already has a package block from buildExrJob/buildPullJob, keep it.
    // Otherwise derive a flat fallback so the old export path still works.
    const pkg = outputBase
      ? buildPackagePaths(outputBase, plateName, job.shotId || job.naming?.shotName || '')
      : (job.package || buildPackagePaths('', plateName, job.shotId || job.naming?.shotName || ''));
    return {
      ...job,
      plateName,
      package:       pkg,
      outputDir:     pkg.exr,
      outputBase,
      outputPattern: `${plateName}.%04d.exr`,
      frameStart:    job.frameStart ?? frameStart,
      // Merge engine override into colorPlan so companion routes correctly.
      colorPlan: engineOverride
        ? { ...(job.colorPlan || {}), engineHint: engineOverride }
        : (job.colorPlan || {}),
      sidecars: {
        ...(job.sidecars || {}),
        amfXml: typeof _state.amfXmls?.[i] === 'string'
          ? _state.amfXmls[i]
          : (_state.amfXmls?.[i]?.xml || ''),
        fdl: _state.fdls?.[i] || null,
        qtReference: {
          path:       _state.fdls?.[i]?.reference?.path || '',
          tcIn:       _state.fdls?.[i]?.reference?.tcIn || '',
          tcOut:      _state.fdls?.[i]?.reference?.tcOut || '',
          colorSpace: _settings.qtReferenceColorSpace || 'Rec709',
        },
      },
    };
  });

  // Auto-start Resolve in background_auto mode before dispatching render jobs
  const _reSettings  = window.__pfxProjectSetup?.getSettings?.()?.resolveEngine || {};
  const _reRawMode   = _reSettings.mode || _reSettings.engineMode || '';
  const _reIsAuto    = _reRawMode === 'background_auto' || _reRawMode === 'background' || _reRawMode === 'auto';
  if (_reIsAuto && !_state.resolveConnected) {
    _setStatus('Starting Resolve Engine…');
    try {
      const adv = _reSettings.advanced || {};
      await nativeResolveStartBackground({
        resolvePath: _reSettings.resolvePath || '',
        minimize: _reSettings.minimizeOnLaunch !== false,
        waitForReady: true,
        apiReadyTimeoutSeconds: adv.apiReadyTimeoutSeconds || _reSettings.timeoutSeconds || 60,
        timeoutSeconds:         adv.apiReadyTimeoutSeconds || _reSettings.timeoutSeconds || 60,
      });
      _state.resolveConnected = true;
    } catch (e) {
      console.warn('[VfxPull] Auto-start Resolve failed:', e?.message || String(e));
    }
  }

  // Initialize per-shot status tracking
  _state.exrResults = augmentedJobs.map(j => ({
    plateName: j.plateName,
    status:    'pending',
    progress:  0,
    outputDir: j.outputDir,
    frames:    null,
    error:     null,
    qc:        null,
  }));
  _renderShotTable();

  // Run shots serially — companion has one Resolve/FFmpeg process at a time.
  for (let i = 0; i < augmentedJobs.length; i++) {
    const job    = augmentedJobs[i];
    const result = _state.exrResults[i];

    result.status = 'rendering';
    _setStatus(`Rendering ${job.plateName} (${i + 1}/${augmentedJobs.length})…`);
    _renderShotTable();

    try {
      // ── Start render ────────────────────────────────────────────────────────
      const _startRes = await nativeRenderPullExrStart(job);
      const { jobId } = _startRes?.data || _startRes?.result || _startRes || {};
      if (!jobId) throw new Error('Companion did not return a jobId — render not started');

      // ── Poll until done (max 4h) ────────────────────────────────────────────
      const POLL_TIMEOUT_MS = 4 * 60 * 60 * 1000;
      const pollStart = Date.now();
      let done = false;
      while (!done) {
        await new Promise(r => setTimeout(r, 1500));
        if (Date.now() - pollStart > POLL_TIMEOUT_MS) {
          await nativeRenderPullExrCancel(jobId).catch(() => {});
          throw new Error('Render timed out after 4 hours');
        }
        const _stRes = await nativeRenderPullExrStatus(jobId);
        const st = _stRes?.data || _stRes?.result || _stRes || {};
        if (!st.state) throw new Error(`Invalid status response for job ${jobId}`);
        result.progress = st.progressPct ?? result.progress;
        _setStatus(`${job.plateName}: ${st.state} ${result.progress}%`);
        if (st.state === 'done') {
          result.frames  = st.result?.framesExported ?? null;
          result.status  = 'rendered';
          done = true;
        } else if (st.state === 'failed' || st.state === 'cancelled') {
          throw new Error(st.error || `Render ${st.state}`);
        }
      }

      // ── QC ─────────────────────────────────────────────────────────────────
      _setStatus(`QC ${job.plateName}…`);
      const _qcRes   = await nativeQcExrSequence(job);
      const qcResult = _qcRes?.data || _qcRes?.result || _qcRes || {};
      result.qc = qcResult;
      if (!qcResult.pass) {
        result.status = 'qc_fail';
        console.warn('[VfxPull] QC failed:', job.plateName, qcResult.errors);
      } else {
        result.status = 'done';
      }

      // ── Write sidecars (frame map, geometry JSON, pull report, QC JSON) ────
      _setStatus(`Writing sidecars for ${job.plateName}…`);
      await nativeWritePullSidecars(job, qcResult);

    } catch (err) {
      result.status = 'error';
      result.error  = err?.message || String(err);
      console.warn('[VfxPull] Shot export failed:', job.plateName, err);
    }

    _renderShotTable();
  }

  const doneCount  = _state.exrResults.filter(r => r.status === 'done').length;
  const errorCount = _state.exrResults.filter(r => r.status === 'error').length;
  const qcFail     = _state.exrResults.filter(r => r.status === 'qc_fail').length;
  _setStatus(`EXR export: ${doneCount} done, ${qcFail} QC fail, ${errorCount} errors`);

  // Review Proxy mode → auto-bake the ACES 2.0 ODT review movie from the AP0
  // plates we just rendered. (The "Render Review" button does the same on demand.)
  if (_settings.pullMode === 'review_proxy' && doneCount > 0) {
    try { await _runReviewProxies(jobs); }
    catch (e) { console.warn('[VfxPull] Auto review-proxy render failed:', e?.message || e); }
  }

  return _state.exrResults;
}

// ---------------------------------------------------------------------------
// Ref frame extraction — writes 3 representative JPEG frames per shot to ref/
// Uses nativeOcfExtractFrameToFile: companion extracts via ffmpeg and writes
// directly to disk in one round-trip (no base64 overhead).
// ---------------------------------------------------------------------------
async function _runRefExtraction(jobs) {
  if (!jobs?.length) return;
  const outputBase = (_settings.outputFolder || '').replace(/\/+$/, '');
  if (!outputBase) return;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    const row = _state.normalisedRows?.[i] || {};
    const srcPath = job.sourcePath || row.sourcePath || '';
    if (!srcPath) continue;

    const pkg      = job.package || buildPackagePaths(outputBase, job.plateName || _plateName(i), job.shotId || job.naming?.shotName || '');
    const shotName = job.shotId || job.naming?.shotName || _plateName(i);

    // Use the handle-extended pull range so the first/mid/last reference frames
    // represent the DELIVERED plate (which includes handles), not just the
    // editorial in/out.
    const tcIn  = job.exportIn  || job.sourceIn  || row.tcIn  || '00:00:00:00';
    const tcOut = job.exportOut || job.sourceOut || row.tcOut || tcIn;

    // HH:MM:SS:FF → fractional seconds
    const _tcToSec = tc => {
      const p = String(tc || '').split(':').map(Number);
      if (p.length === 4) return p[0] * 3600 + p[1] * 60 + p[2] + p[3] / (job.fps || 24);
      if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
      return 0;
    };
    const _secToFfmpeg = s => {
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${(s % 60).toFixed(3).padStart(6,'0')}`;
    };

    const secIn  = _tcToSec(tcIn);
    const secOut = _tcToSec(tcOut);
    const secMid = secIn + (secOut - secIn) / 2;

    const frames = [
      { label: 'first', tc: _secToFfmpeg(secIn) },
      { label: 'mid',   tc: _secToFfmpeg(secMid) },
      { label: 'last',  tc: _secToFfmpeg(Math.max(0, secOut - 0.042)) },
    ];

    for (const { label, tc } of frames) {
      const outPath = `${pkg.ref}/${shotName}_ref_${label}.jpg`;
      try {
        await nativeOcfExtractFrameToFile(srcPath, tc, outPath, { width: 720, height: 404, format: 'jpg' });
      } catch (e) {
        console.warn(`[VfxPull] Ref frame extract failed (${label}):`, e?.message || String(e));
      }
    }

    // Proxy MOV: transcode the full shot range to a small H.264 review MOV
    const movPath = pkg.reviewMov || `${pkg.ref}/${shotName}_ref.mov`;
    try {
      await nativeOcfExtractProxyMov(srcPath, tcIn, tcOut, movPath, {
        fps: job.fps || 24,
        width: 1920,
        height: 1080,
      });
    } catch (e) {
      console.warn('[VfxPull] Ref MOV extract failed:', e?.message || String(e));
    }
  }
}

async function _exportPullPackage() {
  if (!_state.jobs.length) return;

  // Gate: refuse to write the package when there are hard QC blocks (OCF missing,
  // unacknowledged NOT_RECOMMENDED, …) or validation ERRORs (zero/negative
  // duration, …). The analysis auto-run had this gate but the manual EXPORT
  // button bypassed it. Library "confirm TC" matches are WARNINGS and never block.
  const _hardBlocks = (_state.qcBlocks || []).filter(b => b.severity === 'error');
  const _valErrors  = (_state.validation && _state.validation.ok === false)
    ? (_state.validation.issues || []).filter(i => i.severity === 'error') : [];
  if (_hardBlocks.length || _valErrors.length) {
    const msgs = [..._hardBlocks, ..._valErrors].map(b => b.message || b.code).filter(Boolean);
    try { _showVfxBlockedBanner(msgs); } catch {}
    _setStatus(`Export blocked: ${msgs[0] || 'fix errors before export'}`);
    try { _showFriendly('error', `Can't export yet — fix ${msgs.length} issue${msgs.length > 1 ? 's' : ''} first: ${msgs.slice(0, 2).join(' · ')}`); } catch {}
    return;
  }

  const meta = await _providers.getProjectMeta?.() || {};
  const startedAt = Date.now();

  const csv = buildShotsCSV(_state.jobs, _state.matchResults);
  // Stamp the spec block conditions onto meta so they land in both the JSON
  // and the HTML reports.
  const qcMeta = { ...meta, blocks: _state.qcBlocks || [] };
  const qcHtml = buildQcReportHtml(_state.qcShots, qcMeta);
  const qcJson = buildQcReportJson(_state.qcShots, qcMeta);
  // Nuke handoff is built from the flat normalised rows + project meta so the
  // per-plate labels (TC range, manual-link flag, AMF/FDL filenames, etc.)
  // and the ACES Read / CDL / Reformat / Rec709 viewer blocks render correctly.
  const nukeScript = buildNukeHandoffScript(
    _state.jobs,
    _state.normalisedRows || [],
    meta,
  );
  const fdlCsv = buildFDLCsv(_state.fdls);

  // Build flat file list for native write or sidecar-only ZIP fallback.
  // EXR sequences are intentionally NOT included in this list — they're huge
  // and get written separately to 03_exr/<plateName>/ by the EXR export
  // queue (when wired). The ZIP fallback below is sidecar-only on purpose.
  const files = [
    { path: '00_reports/pull_report.csv', content: csv },
    { path: '00_reports/qc_report.html', content: qcHtml },
    { path: '00_reports/qc_report.json', content: qcJson },
    { path: '01_fdl/pull_list.fdl.csv', content: fdlCsv },
    { path: '05_nuke/nuke_handoff.py', content: nukeScript },
  ];

  _state.fdls.forEach((fdl, i) => {
    const name = _plateName(i);
    files.push({ path: `01_fdl/${name}.fdl.json`, content: buildFDLJson(fdl) });
  });

  _state.amfXmls.forEach((xml, i) => {
    const name = _plateName(i);
    files.push({ path: `02_amf/${name}.amf`, content: xml });
  });

  // Per-shot frame map (JSON) + After Effects handoff (.jsx). Same builders as
  // the per-shot delivery path, so the bundle's Nuke/AE retime + the JSON map
  // all agree. AE plate path points at this bundle's 03_exr/<plateName>/.
  _state.jobs.forEach((job, i) => {
    const name = _plateName(i);
    const row  = (_state.normalisedRows || [])[i] || {};
    const manifest = {
      shotName:   row.shotName || job.shotId || name,
      plateName:  name,
      frameStart: Number(job.frameStart ?? 1001),
      frameCount: job.frameCount || job.expectedRenderedFrameCount || 0,
      sourceClipName: row.clipName || '',
      colorInfo:  { exrColorSpace: job.colorPlan?.outputSpace || 'ACES2065-1' },
    };
    const aeJob = { ...job, plateName: name, package: { ...(job.package || {}), exr: `03_exr/${name}` } };
    files.push({ path: `05_nuke/${name}_frame_map.json`, content: JSON.stringify(buildFrameMapJSON(job, manifest), null, 2) });
    files.push({ path: `05_ae/${name}.jsx`, content: buildAeScript(aeJob, { manifest }) });
  });

  // 06_logs/export_log.json — what ran, when, with what settings, per-shot
  // outcome. Useful for forensics when QC flags an issue or a shot is missing
  // and the user needs to know what the pull pipeline decided at each step.
  const exportLog = {
    schemaVersion: 2,
    generatedAt:   new Date(startedAt).toISOString(),
    project: {
      name:         meta.projectName || '',
      cameraModel:  meta.cameraModel || '',
      refVideoAssetId: meta.refVideoAssetId || '',
    },
    settings: { ..._settings },
    // Block conditions snapshot — useful when a downstream pipeline rejects
    // the package and the operator needs to see exactly why PFX let it ship
    // (or why it was incomplete).
    blocks: _state.qcBlocks || [],
    counts: {
      shots:        _state.jobs.length,
      ocfMatched:   (_state.matchResults || []).filter(r => (r?.match?.status || '') === 'SAFE').length,
      ocfReview:    (_state.matchResults || []).filter(r => (r?.match?.status || '') === 'REVIEW_NEEDED').length,
      ocfMissing:   (_state.matchResults || []).filter(r => (r?.match?.status || 'MISSING') === 'MISSING').length,
      fdls:         _state.fdls.length,
      amfs:         _state.amfXmls.length,
    },
    shots: (_state.normalisedRows || []).map((row, i) => {
      const job = _state.jobs[i] || {};
      const exr = (_state.exrResults || [])[i] || null;
      return {
        index:        i,
        shotName:     row.shotName,
        clipName:     row.clipName,
        sourcePath:   row.sourcePath,
        status:       row.status,
        confidence:   row.confidence,
        warnings:     row.warnings,
        tcIn:         row.tcIn,
        tcOut:        row.tcOut,
        recIn:        row.recIn,
        recOut:       row.recOut,
        plateName:    _plateName(i),
        frameCount:   job.frameCount || 0,
        exrExport:    exr,                  // populated when queue ran
        colorMatch:   job?.color?.match || null,
        reframe:      job?.reframe || null,
        retime:       job?.retime || null,
      };
    }),
    pkgLayout: {
      reports:  '00_reports/',
      fdl:      '01_fdl/',
      amf:      '02_amf/',
      exr:      '03_exr/<plateName>/<plateName>.NNNN.exr',
      preview:  '04_preview/',
      nuke:     '05_nuke/',
      frameMap: '05_nuke/<plateName>_frame_map.json',
      ae:       '05_ae/<plateName>.jsx',
      logs:     '06_logs/',
    },
  };
  files.push({
    path: '06_logs/export_log.json',
    content: JSON.stringify(exportLog, null, 2),
  });

  // Attempt native write if outputFolder is set
  if (_settings.outputFolder) {
    try {
      await nativeOcfWriteFiles(_settings.outputFolder, files);
      _setStatus('Package written to disk');
      _setWfDot('pmVfxWfExport', true, false);
      return;
    } catch (e) {
      console.warn('[VfxPull] Native write failed, falling back to download:', e);
    }
  }

  // Sidecar-only fallback: try fflate ZIP if available, else download each
  // file individually. EXR sequences are NEVER in `files` here — they're
  // written to 03_exr/<plateName>/ by the EXR export queue when an output
  // folder is set. Without an output folder, EXR export is skipped entirely.
  if (typeof window.fflate !== 'undefined') {
    _downloadAsZip('VFX_PULL_PACKAGE', files);
  } else {
    files.forEach(f => {
      const filename = f.path.replace(/\//g, '_');
      _downloadText(filename, f.content);
    });
  }

  _setWfDot('pmVfxWfExport', true, false);
}

async function _exportNuke() {
  if (!_state.jobs.length) return;
  const meta = await _providers.getProjectMeta?.() || {};
  const script = buildNukeHandoffScript(
    _state.jobs,
    _state.normalisedRows || [],
    meta,
  );
  _downloadText('nuke_handoff.py', script, 'text/x-python');
}

function _sanitizeVfxExportName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_.-]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function _vfxExportFrameEnd(job) {
  const start = Number(job.frameStart ?? _settings.frameStart ?? 1001);
  const count = Number(job.expectedRenderedFrameCount || job.frameCount || 0);
  return start + Math.max(0, count - 1);
}

function _vfxResizeSidecar(job, opts) {
  const geometry = job.geometry || {};
  return {
    sourceResolution: geometry.sourceResolution || '',
    timelineResolution: geometry.timelineResolution || '',
    outputResolution: opts.outputResolution || _settings.targetResolution || '',
    scale: geometry.scale ?? job.reframe?.scale ?? 1,
    positionX: geometry.positionX ?? 0,
    positionY: geometry.positionY ?? 0,
    rotation: geometry.rotation ?? 0,
    crop: geometry.crop || job.reframe?.crop || null,
    pixelAspect: geometry.pixelAspect || 1,
    resizeMode: opts.framing || 'timeline',
  };
}

function _vfxColorManifest(job, amfPath, opts) {
  return {
    colorPipeline: opts.color || 'ACES2065-1 AP0 Linear + AMF',
    exrColorSpace: opts.color === 'acescg' ? 'ACEScg' : 'ACES2065-1 AP0 Linear',
    bitDepth: (job.exr?.bitDepth === 'float') ? '32-bit float' : '16-bit half float',
    channels: 'RGB',
    displayTransformBaked: opts.color === 'review_baked',
    amfPath: amfPath || '',
    engine: opts.renderEngine || _settings.renderEngine || 'resolve',
    warnings: job.colorPlan?.warnings || [],
  };
}

function _buildVfxFrameMapCSV(job, manifest) {
  const header = 'output_frame,output_filename,timeline_tc,timeline_frame,source_tc,source_frame,speed,retime_note';
  const rows = [header];
  const start = Math.round(Number(manifest.frameStart || job.frameStart || 1001));
  const count = Math.max(0, Math.round(Number(manifest.frameCount || job.expectedRenderedFrameCount || job.frameCount || 0)));
  const fps   = Number(job.fps || 24);
  const plate = manifest.plateName || job.plateName || 'plate';
  const note  = job.retime?.originalSummary || '';

  // Use the CANONICAL per-frame retime resolution so this CSV, the JSON frame map,
  // and the Nuke/AE handoffs all agree (was diverging on reverse/speed math, used
  // the un-handled source-in, and emitted a constant source_tc per row).
  const mapRows = buildFrameMapRows(job, { frameStart: start, count, fps });
  const _f2tc = (sf) => {
    const r = Math.round(fps || 24); let n = Math.max(0, Math.round(sf));
    const z = x => String(x).padStart(2, '0');
    return `${z(Math.floor(n / (r * 3600)))}:${z(Math.floor(n / (r * 60)) % 60)}:${z(Math.floor(n / r) % 60)}:${z(n % r)}`;
  };
  mapRows.forEach((m, i) => {
    const retimeNote = note || m.retimeType || 'normal';
    rows.push([
      m.outFrame,
      `${plate}.${String(m.outFrame).padStart(4, '0')}.exr`,
      manifest.timelineTcIn || '',
      i,
      _f2tc(m.srcFrame),          // per-frame source TC (was a constant column)
      m.srcFrame,
      m.speed,
      retimeNote,
    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  });
  return rows.join('\n');
}

// Thin wrapper — the node-graph builder lives in the pure (testable) module.
function _buildVfxNk(job, manifest, frameMapPath, amfPath, resizePath) {
  return buildNukeScript(job, { manifest, frameMapPath, amfPath, resizePath });
}

function _buildVfxQcText({ manifest, warnings = [], errors = [], result = 'WARN' }) {
  return [
    `Status: ${errors.length ? 'BLOCKED' : result}`,
    `Shot: ${manifest.shotName}`,
    `Plate: ${manifest.plateName}`,
    `OCF match status: ${manifest.ocfMatchStatus}`,
    `Output file naming status: ${manifest.namingStatus}`,
    `Frame completeness: pending render QC`,
    `First frame: ${manifest.frameStart}`,
    `Last frame: ${manifest.frameEnd}`,
    `Expected frame count: ${manifest.frameCount}`,
    `Resolution: ${manifest.outputResolution || 'timeline'}`,
    `EXR bit depth/channel check: 16-bit half float RGB requested`,
    `Color pipeline: ${manifest.colorInfo?.colorPipeline || ''}`,
    `AMF: ${manifest.amfPath ? 'found/generated' : 'fallback color_manifest.json'}`,
    `Speed change summary: ${manifest.speedInfo?.summary || 'normal speed'}`,
    `Resize summary: ${manifest.resizeInfo?.resizeMode || 'timeline framing'}`,
    `Warnings: ${warnings.length ? warnings.join('; ') : 'none'}`,
    `Errors: ${errors.length ? errors.join('; ') : 'none'}`,
    `Package result: ${errors.length ? 'blocked' : 'sidecars/render job prepared'}`,
  ].join('\n');
}

function _buildVfxPackageFiles(opts, exrResults = []) {
  const files = [];
  const summaryRows = [];
  const summary = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packageType: 'PostFlowX VFX Package',
    renderEngine: opts.renderEngine,
    fallbackPolicy: 'Resolve first; FFmpeg/OIIO only for simple shots with warning; manifest-only when render cannot be trusted.',
    shots: [],
  };

  _state.jobs.forEach((rawJob, i) => {
    const job = {
      ...rawJob,
      plateName: rawJob.plateName || _plateName(i),
      package: buildPackagePaths(opts.outputFolder, rawJob.plateName || _plateName(i), rawJob.shotId || rawJob.naming?.shotName || ''),
      frameStart: rawJob.frameStart ?? opts.frameStart,
    };
    const row = _state.normalisedRows?.[i] || _normalizeMatchRow(_state.matchResults[i], job);
    const shotName = _sanitizeVfxExportName(job.shotId || job.naming?.shotName || row.shotName);
    const plateName = _sanitizeVfxExportName(`${shotName}_${opts.plateId}_${opts.version}`);
    job.shotId = shotName;
    job.plateName = plateName;
    job.package = buildPackagePaths(opts.outputFolder, plateName, shotName);
    const frameEnd = _vfxExportFrameEnd(job);
    const amfXml = typeof _state.amfXmls?.[i] === 'string' ? _state.amfXmls[i] : (_state.amfXmls?.[i]?.xml || '');
    const amf = { xml: amfXml, warnings: [] };
    const resizeInfo = _vfxResizeSidecar(job, opts);
    const colorInfo = _vfxColorManifest(job, job.package.amfFile, opts);
    const warnings = [
      ...(row.warnings || []),
      ...(amf.warnings || []),
      ...((row.confidence || 0) < 95 ? ['OCF match score below 95. Review before delivery.'] : []),
      ...(!amf.xml ? ['AMF missing. PostFlowX created color_manifest.json fallback.'] : []),
      ...(job.retime?.hasSpeedChange ? ['Speed change detected. Resolve Engine required for trusted render.'] : []),
      ...(job.geometry?.hasGeometry ? ['Timeline resize/reframe detected.'] : []),
    ];
    const manifest = {
      shotName,
      plateName,
      plateId: opts.plateId,
      version: opts.version,
      frameStart: Number(job.frameStart ?? 1001),
      frameEnd,
      frameCount: Math.max(0, frameEnd - Number(job.frameStart ?? 1001) + 1),
      timelineTcIn: row.recIn || '',
      timelineTcOut: row.recOut || '',
      sourceTcIn: job.sourceIn || row.tcIn || '',
      sourceTcOut: job.sourceOut || row.tcOut || '',
      ocfPath: row.sourcePath || job.sourcePath || '',
      sourceClipName: row.clipName || '',
      ocfMatchStatus: row.status || '',
      matchConfidence: row.confidence || 0,
      namingStatus: 'safe',
      speedInfo: {
        hasSpeedChange: !!job.retime?.hasSpeedChange,
        type: job.retime?.isDynamic ? 'variable' : job.retime?.freeze ? 'freeze' : job.retime?.reversed ? 'reverse' : job.retime?.hasSpeedChange ? 'constant' : 'normal',
        summary: job.retime?.originalSummary || 'normal speed',
      },
      resizeInfo,
      colorInfo,
      amfPath: amf?.xml ? job.package.amfFile : '',
      exrSequencePath: `${job.package.exr}/${plateName}.%04d.exr`,
      nukeScriptPath: job.package.nukeScript,
      qcStatus: warnings.length ? 'WARN' : 'PASS',
    };

    const rel = p => p.replace(String(opts.outputFolder || '').replace(/\/+$/, '') + '/', '');
    files.push({ path: rel(job.package.manifestFile), content: JSON.stringify(manifest, null, 2) });
    files.push({ path: rel(job.package.frameMapFile), content: _buildVfxFrameMapCSV(job, manifest) });
    files.push({ path: rel(job.package.frameMapJsonFile), content: JSON.stringify(buildFrameMapJSON(job, manifest), null, 2) });
    files.push({ path: rel(job.package.resizeFile), content: JSON.stringify(resizeInfo, null, 2) });
    files.push({ path: rel(job.package.colorFile), content: JSON.stringify(colorInfo, null, 2) });
    files.push({ path: rel(job.package.qcFile), content: _buildVfxQcText({ manifest, warnings }) });
    files.push({ path: rel(job.package.nukeScript), content: _buildVfxNk(job, manifest, job.package.frameMapJsonFile, job.package.amfFile, job.package.resizeFile) });
    files.push({ path: rel(job.package.nukeReadme), content: `Keep this nuke folder with ../plates, ../amf, and ../metadata so relative plate links stay valid.\n` });
    files.push({ path: rel(job.package.aeScript), content: buildAeScript(job, { manifest }) });
    files.push({ path: rel(job.package.aeReadme), content: `After Effects handoff. In AE: File > Scripts > Run Script File > ${plateName}.jsx (or: afterfx -r ${plateName}.jsx).\nIt builds the per-shot comp (.aep) with FDL framing, frame-map retime, and AMF color.\nKeep this ae folder beside ../plates, ../amf, and ../metadata so relative plate links stay valid.\n` });
    if (amf?.xml) files.push({ path: rel(job.package.amfFile), content: amf.xml });

    summaryRows.push([
      shotName, plateName, manifest.frameStart, manifest.frameEnd,
      manifest.frameCount, manifest.ocfMatchStatus, manifest.matchConfidence,
      manifest.qcStatus, manifest.ocfPath,
    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
    summary.shots.push(manifest);
  });

  files.push({
    path: 'VFX_PACKAGE_manifest.csv',
    content: ['shotName,plateName,frameStart,frameEnd,frameCount,ocfStatus,matchConfidence,qcStatus,ocfPath', ...summaryRows].join('\n'),
  });
  files.push({ path: 'VFX_PACKAGE_summary.json', content: JSON.stringify(summary, null, 2) });
  return files;
}

function _applyVfxPackageNaming(opts) {
  _state.jobs = (_state.jobs || []).map((job, i) => {
    const row = _state.normalisedRows?.[i] || _normalizeMatchRow(_state.matchResults[i], job);
    const shotName = _sanitizeVfxExportName(job.shotId || job.naming?.shotName || row.shotName) || `SHOT_${String(i + 1).padStart(3, '0')}`;
    const plateName = _sanitizeVfxExportName(`${shotName}_${opts.plateId}_${opts.version}`);
    const pkg = buildPackagePaths(opts.outputFolder, plateName, shotName);
    return {
      ...job,
      shotId: shotName,
      plateName,
      package: pkg,
      outputDir: pkg.exr,
      outputBase: opts.outputFolder,
      outputPattern: `${plateName}.%04d.exr`,
      frameStart: job.frameStart ?? opts.frameStart,
      naming: {
        ...(job.naming || {}),
        shotName,
        plateName,
        plateType: opts.plateId.slice(0, 2),
        plateNum: opts.plateId.slice(2) || '01',
        version: opts.version.replace(/^v/i, ''),
        pattern: `${plateName}.%04d.exr`,
      },
      metadata: {
        ...(job.metadata || {}),
        shotName,
        plateName,
      },
    };
  });
}

function _validateVfxPackage(opts) {
  const errors = [];
  const warnings = [];

  const resolveSettings = window.__pfxProjectSetup?.getSettings?.()?.resolveEngine || {};
  const resolveRawMode  = resolveSettings.mode || resolveSettings.engineMode || '';
  const isAutoMode = resolveRawMode === 'background_auto' || resolveRawMode === 'background' || resolveRawMode === 'auto';

  if (!_state.jobs.length) errors.push('No VFX Pull shots found. Run VFX Pull analysis first.');
  if (!opts.outputFolder) errors.push('Output folder missing. Choose an output folder.');
  const rows = _state.normalisedRows || [];
  rows.forEach((row, i) => {
    const job = _state.jobs[i] || {};
    const rawName = job.shotId || job.naming?.shotName || row.shotName || '';
    const safeName = _sanitizeVfxExportName(rawName);
    if (!rawName) errors.push(`Shot ${i + 1}: Shot Name missing.`);
    if (rawName && rawName !== safeName) warnings.push(`${rawName} will export as ${safeName}.`);
    if (!row.sourcePath && !job.sourcePath) errors.push(`${safeName || `Shot ${i + 1}`}: OCF not linked. Click Relink OCF.`);
    if ((row.confidence || 0) < 95) warnings.push(`${safeName || `Shot ${i + 1}`}: OCF match score below 95. Review before delivery.`);
    if (job.retime?.hasSpeedChange) warnings.push(`${safeName}: Speed change detected. Resolve Engine required.`);
    if (job.geometry?.hasGeometry) warnings.push(`${safeName}: Timeline resize/reframe detected.`);
    if (job.retime?.isDynamic && !_state.resolveConnected && !isAutoMode)
      errors.push(`${safeName}: Variable retime requires Resolve Engine.`);
  });
  const complex = _state.jobs.some(job => job.retime?.hasSpeedChange || job.geometry?.hasGeometry);
  if (complex && !_state.resolveConnected && opts.renderEngine !== 'manifest' && !isAutoMode)
    errors.push('Resolve Engine required for speed changes or timeline resize/reframe.');
  if (opts.renderEngine === 'manifest') warnings.push('Manifest-only package selected. EXR plates will not be rendered.');
  return { errors, warnings };
}

async function _pickVfxOutputFolder() {
  let picked;
  try { picked = await nativePickFolder('Select VFX Package output folder'); }
  catch { picked = null; }
  const data = _nativePayload(picked);
  return data?.path || data?.folderPath || '';
}

function _showVfxPackageModal(defaults = {}) {
  return new Promise(resolve => {
    const old = document.getElementById('pmVfxPackageModal');
    if (old) old.remove();
    const overlay = document.createElement('div');
    overlay.id = 'pmVfxPackageModal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(5,8,18,.72);display:flex;align-items:center;justify-content:center;padding:18px;';
    overlay.innerHTML = `
      <div style="width:min(760px,96vw);max-height:92vh;overflow:auto;background:#111827;color:#e5ecff;border:1px solid rgba(142,166,255,.32);border-radius:8px;box-shadow:0 22px 80px rgba(0,0,0,.5);font:13px system-ui, sans-serif;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.10);">
          <strong style="font-size:16px;">VFX Package Export</strong>
          <button data-vfxpkg-close style="background:transparent;color:#cbd5ff;border:0;font-size:20px;cursor:pointer;">×</button>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:16px;">
          <label>Shots
            <select data-vfxpkg="scope" style="width:100%;margin-top:5px;"><option value="selected">Selected shots only</option><option value="all">All VFX marker shots</option><option value="filtered">Current filtered list</option></select>
          </label>
          <label>Render Engine
            <select data-vfxpkg="renderEngine" style="width:100%;margin-top:5px;"><option value="resolve">Resolve Engine - Recommended</option><option value="manifest">Manifest-only package</option></select>
          </label>
          <label>Output Resolution
            <select data-vfxpkg="outputResolution" style="width:100%;margin-top:5px;"><option value="timeline">Timeline Resolution</option><option value="source">Source Resolution</option><option value="3840x2160">Custom UHD 3840x2160</option></select>
          </label>
          <label>Framing
            <select data-vfxpkg="framing" style="width:100%;margin-top:5px;"><option value="timeline">Timeline Framing</option><option value="source">Source Full Frame</option><option value="both">Both</option></select>
          </label>
          <label>Color
            <select data-vfxpkg="color" style="width:100%;margin-top:5px;"><option value="aces2065">ACES2065-1 AP0 Linear + AMF</option><option value="acescg">ACEScg</option><option value="camera_log">Camera Log DPX / show-specific</option><option value="review_baked">Review Look Baked - review only</option></select>
          </label>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
            <label>Head Handles<input data-vfxpkg="head" type="number" min="0" value="${Number(defaults.handles ?? _settings.handles ?? 8)}" style="width:100%;margin-top:5px;"></label>
            <label>Tail Handles<input data-vfxpkg="tail" type="number" min="0" value="${Number(defaults.handles ?? _settings.handles ?? 8)}" style="width:100%;margin-top:5px;"></label>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
            <label>Frame Start<input data-vfxpkg="frameStart" type="number" min="0" value="${Number(defaults.frameStart ?? _settings.frameStart ?? 1001)}" style="width:100%;margin-top:5px;"></label>
            <label>Plate<input data-vfxpkg="plateId" value="PL01" style="width:100%;margin-top:5px;"></label>
            <label>Version<input data-vfxpkg="version" value="v001" style="width:100%;margin-top:5px;"></label>
          </div>
          <div style="grid-column:1/-1;display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end;">
            <label>Output Folder<input data-vfxpkg="outputFolder" value="${_esc(defaults.outputFolder || _settings.outputFolder || '')}" readonly style="width:100%;margin-top:5px;"></label>
            <button data-vfxpkg-pick style="height:32px;border-radius:7px;border:1px solid rgba(142,166,255,.45);background:#1f2a44;color:#eef3ff;cursor:pointer;">Choose</button>
          </div>
          <div style="grid-column:1/-1;display:flex;gap:12px;flex-wrap:wrap;color:#b8c4ee;">
            <label><input type="checkbox" data-vfxpkg-content="exr" checked> EXR Plates</label>
            <label><input type="checkbox" data-vfxpkg-content="amf" checked> AMF</label>
            <label><input type="checkbox" data-vfxpkg-content="nuke" checked> Nuke Scripts</label>
            <label><input type="checkbox" data-vfxpkg-content="manifest" checked> Manifest</label>
            <label><input type="checkbox" data-vfxpkg-content="qc" checked> QC Report</label>
            <label><input type="checkbox" data-vfxpkg-content="review"> Reference MOV</label>
            <label><input type="checkbox" data-vfxpkg-content="contact"> Contact Sheet</label>
          </div>
          <div style="grid-column:1/-1;display:flex;gap:16px;align-items:center;padding:8px 0 0;border-top:1px solid rgba(255,255,255,.08);color:#b8c4ee;font-size:12px;">
            <label title="By default a timestamped job subfolder is created inside the chosen output folder to keep each export isolated.">
              <input type="checkbox" data-vfxpkg-writedirectly>
              Write directly into selected folder (skip job subfolder)
            </label>
            <span id="pmVfxPkgJobIdPreview" style="color:#64748b;margin-left:auto;"></span>
          </div>
          <div data-vfxpkg-status style="grid-column:1/-1;min-height:36px;padding:9px 10px;border-radius:7px;background:rgba(255,255,255,.05);color:#cbd5ff;">Ready to validate.</div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid rgba(255,255,255,.10);">
          <button data-vfxpkg-validate style="height:34px;border-radius:7px;border:1px solid rgba(234,179,8,.55);background:rgba(234,179,8,.14);color:#fde68a;cursor:pointer;">Validate</button>
          <button data-vfxpkg-export style="height:34px;border-radius:7px;border:1px solid rgba(34,197,94,.55);background:rgba(34,197,94,.18);color:#bbf7d0;cursor:pointer;">Export VFX Package</button>
        </div>
      </div>`;
    // Pre-select "selected shots only" if the user has a partial selection
    const scopeEl = overlay.querySelector('[data-vfxpkg="scope"]');
    if (scopeEl && _state.selectedJobs.size > 0 && _state.selectedJobs.size < _state.jobs.length) {
      scopeEl.value = 'selected';
    }

    // Show job-id preview so user knows the subfolder name that will be created
    const _updateJobIdPreview = () => {
      const wdEl = overlay.querySelector('[data-vfxpkg-writedirectly]');
      const previewEl = overlay.querySelector('#pmVfxPkgJobIdPreview');
      if (!previewEl) return;
      if (wdEl?.checked) { previewEl.textContent = ''; return; }
      const firstJob = _state.jobs[0];
      const code = ((firstJob?.shotId || firstJob?.naming?.shotName || 'pfx').split('_')[0] || 'pfx').toUpperCase();
      const n = new Date();
      const ts = `${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}${String(n.getDate()).padStart(2,'0')}_${String(n.getHours()).padStart(2,'0')}${String(n.getMinutes()).padStart(2,'0')}${String(n.getSeconds()).padStart(2,'0')}`;
      previewEl.textContent = `Subfolder: ${code}_${ts}`;
    };
    _updateJobIdPreview();
    overlay.querySelector('[data-vfxpkg-writedirectly]')?.addEventListener('change', _updateJobIdPreview);

    const read = () => {
      const val = k => overlay.querySelector(`[data-vfxpkg="${k}"]`)?.value || '';
      const contentFlag = key => !!(overlay.querySelector(`[data-vfxpkg-content="${key}"]`)?.checked);
      return {
        scope: val('scope'),
        renderEngine: val('renderEngine'),
        outputResolution: val('outputResolution'),
        framing: val('framing'),
        color: val('color'),
        handles: Number(val('head') || 8),
        headHandles: Number(val('head') || 8),
        tailHandles: Number(val('tail') || 8),
        frameStart: Number(val('frameStart') || 1001),
        plateId: _sanitizeVfxExportName(val('plateId') || 'PL01') || 'PL01',
        version: _sanitizeVfxExportName(val('version') || 'v001') || 'v001',
        outputFolder: val('outputFolder'),
        writeDirectly: !!(overlay.querySelector('[data-vfxpkg-writedirectly]')?.checked),
        contentFlags: {
          exr:      contentFlag('exr'),
          amf:      contentFlag('amf'),
          nuke:     contentFlag('nuke'),
          manifest: contentFlag('manifest'),
          qc:       contentFlag('qc'),
          review:   contentFlag('review'),
          contact:  contentFlag('contact'),
        },
      };
    };
    const status = overlay.querySelector('[data-vfxpkg-status]');
    overlay.querySelector('[data-vfxpkg-close]')?.addEventListener('click', () => { overlay.remove(); resolve(null); });
    overlay.querySelector('[data-vfxpkg-pick]')?.addEventListener('click', async () => {
      const folder = await _pickVfxOutputFolder();
      if (folder) overlay.querySelector('[data-vfxpkg="outputFolder"]').value = folder;
    });
    overlay.querySelector('[data-vfxpkg-validate]')?.addEventListener('click', () => {
      const check = _validateVfxPackage(read());
      status.textContent = check.errors.length
        ? `Blocked: ${check.errors[0]}`
        : check.warnings.length
          ? `Warnings: ${check.warnings.slice(0, 3).join(' | ')}`
          : 'Ready. OCF linked, naming safe, and package sidecars can be created.';
      status.style.color = check.errors.length ? '#fecaca' : check.warnings.length ? '#fde68a' : '#bbf7d0';
    });
    overlay.querySelector('[data-vfxpkg-export]')?.addEventListener('click', () => {
      const opts = read();
      overlay.remove();
      resolve(opts);
    });
    document.body.appendChild(overlay);
  });
}

async function _exportVfxPackage(opts = {}) {
  if (!_state.jobs.length && !_running) await _runAnalysis();
  if (!opts.queued) {
    const modalOpts = await _showVfxPackageModal(opts);
    if (!modalOpts) return;
    opts = { ...opts, ...modalOpts };
  }
  const baseOutputFolder = opts.outputFolder || _settings.outputFolder || await _pickVfxOutputFolder();
  if (!baseOutputFolder) return;
  _settings.outputFolder = baseOutputFolder;
  _persistState();

  // ── Build job-scoped output subfolder ──────────────────────────────────────
  // Default: create an isolated timestamped subfolder so each export is clean.
  // User can opt out via "Write directly into selected folder".
  let jobOutputFolder = baseOutputFolder;
  if (!opts.writeDirectly) {
    const firstJob = _state.jobs[0];
    const code = ((firstJob?.shotId || firstJob?.naming?.shotName || 'pfx').split('_')[0] || 'pfx').toUpperCase();
    const n = new Date();
    const ts = `${n.getFullYear()}${String(n.getMonth()+1).padStart(2,'0')}${String(n.getDate()).padStart(2,'0')}_${String(n.getHours()).padStart(2,'0')}${String(n.getMinutes()).padStart(2,'0')}${String(n.getSeconds()).padStart(2,'0')}`;
    jobOutputFolder = `${baseOutputFolder}/${code}_${ts}`;
  }

  // ── Scope filtering ────────────────────────────────────────────────────────
  // 'selected' → only checked rows; 'filtered' → visible list; 'all' → everything
  const scope = opts.scope || 'all';
  let exportIndices;
  if (scope === 'selected' && _state.selectedJobs.size > 0) {
    exportIndices = [..._state.selectedJobs].sort((a, b) => a - b);
  } else {
    exportIndices = _state.jobs.map((_, i) => i);
  }

  if (window.PFX_DEBUG_VFX_PACKAGE) {
    console.log('[PFX VFX Package] active jobs total:', _state.jobs.length);
    console.log('[PFX VFX Package] scope:', scope);
    console.log('[PFX VFX Package] selected count:', _state.selectedJobs.size);
    console.log('[PFX VFX Package] exportIndices:', exportIndices);
    console.log('[PFX VFX Package] exportShots:', exportIndices.map(i =>
      _state.jobs[i]?.shotId || _state.jobs[i]?.naming?.shotName || `shot_${i}`).join(', '));
    console.log('[PFX VFX Package] jobOutputFolder:', jobOutputFolder);
  }

  const exportOpts = {
    outputFolder: jobOutputFolder,
    outputResolution: _settings.targetResolution || 'Timeline Resolution',
    framing: 'timeline',
    color: 'ACES2065-1 AP0 Linear + AMF',
    handles: _settings.handles || 8,
    frameStart: _settings.frameStart || 1001,
    plateId: 'PL01',
    version: 'v001',
    renderEngine: 'resolve',
    ...opts,
    outputFolder: jobOutputFolder, // always use job subfolder, not the modal value
  };

  // Validate against full job list first, then scope down
  const check = _validateVfxPackage(exportOpts);
  if (check.errors.length) {
    _setStatus(`Blocked: ${check.errors[0]}`);
    _showVfxBlockedBanner(check.errors);
    throw new Error(check.errors[0]);
  }
  if (check.warnings.length && !opts.queued) {
    _showVfxWarningBanner(check.warnings);
    if (!opts.skipWarningConfirm) {
      const ok = confirm(`VFX Package warnings:\n\n${check.warnings.join('\n')}\n\nContinue?`);
      if (!ok) return;
    }
  }

  // ── Temporarily narrow _state to exportIndices ─────────────────────────────
  // All export sub-functions read from _state. Swap in the filtered subset for
  // the duration of the export so they only process the selected shots.
  const _savedJobs           = _state.jobs;
  const _savedNormalisedRows = _state.normalisedRows;
  const _savedMatchResults   = _state.matchResults;
  const _savedOutputFolder   = _settings.outputFolder;

  _state.jobs           = exportIndices.map(i => _savedJobs[i]);
  _state.normalisedRows = exportIndices.map(i => (_savedNormalisedRows || [])[i]);
  _state.matchResults   = exportIndices.map(i => _savedMatchResults[i]);
  _settings.outputFolder = jobOutputFolder;

  try {
    _settings.renderEngine = 'resolve';
    _settings.pullMode     = 'ocf_native';
    _settings.exportMode   = 'aces_plate';
    _settings.bakeSpeed    = true;
    _settings.bakeReframe  = exportOpts.framing !== 'source';

    _applyVfxPackageNaming(exportOpts);

    window.__rqReportPhase?.('seeking');
    window.__rqReportStatus?.('Validating VFX Package');
    window.__rqLog?.(`VFX Package: exporting ${_state.jobs.length} shot${_state.jobs.length !== 1 ? 's' : ''}`);
    _setStatus(`VFX Package — ${_state.jobs.length} shot${_state.jobs.length !== 1 ? 's' : ''}…`);

    if (window.PFX_DEBUG_VFX_PACKAGE) {
      console.log('[PFX VFX Package] final shot list:', _state.jobs.map((j, i) => `#${i+1} ${j.shotId}`).join(', '));
    }

    if (exportOpts.renderEngine === 'manifest') {
      window.__rqLog?.('Manifest-only package selected; skipping EXR render');
      _setStatus('Creating manifest-only VFX Package…');
    } else {
      window.__rqReportPhase?.('encoding');
      window.__rqReportStatus?.('Rendering EXR plates through Resolve Engine');
      window.__rqLog?.('Rendering EXR plates');
      await _runExrExport(_state.jobs);

      // ── EXR completion check ───────────────────────────────────────────────
      const exrResults = _state.exrResults || [];
      const exrErrors  = exrResults.filter(r => r.status === 'error' || r.status === 'qc_fail');
      if (exrErrors.length) {
        const msg = exrErrors.map(r => `${r.plateName}: ${r.error || 'QC fail'}`).join('; ');
        console.warn('[VfxPull] EXR render failures:', msg);
        _showVfxWarningBanner([`EXR render errors (${exrErrors.length} shot${exrErrors.length > 1 ? 's' : ''}): ${msg}`]);
      }
      const exrMissing = exrResults.filter(r => !['done', 'rendered'].includes(r.status));
      if (exrMissing.length && exrMissing.length === exrResults.length) {
        _setStatus('EXR render produced no output — check Resolve Engine and OCF links.');
        window.__rqLog?.('BLOCKED: EXR render produced no output');
        return;
      }
    }

    window.__rqReportPhase?.('saving');
    window.__rqReportStatus?.('Extracting reference frames and proxy MOV');
    window.__rqLog?.('Extracting OCF reference frames');
    _setStatus('Extracting reference frames…');
    const wantReview = opts.contentFlags?.review !== false;
    if (wantReview) {
      await _runRefExtraction(_state.jobs);
    }

    window.__rqReportPhase?.('saving');
    window.__rqReportStatus?.('Writing AMF, Nuke, manifests, frame maps, and QC');
    const files = _buildVfxPackageFiles(exportOpts, _state.exrResults || []);
    await nativeOcfWriteFiles(jobOutputFolder, files);
    window.__rqLog?.(`Wrote ${files.length} VFX Package sidecar files to ${jobOutputFolder}`);
    window.__rqReportProgress?.(100);
    _setStatus(`VFX Package complete — ${_state.jobs.length} shot${_state.jobs.length !== 1 ? 's' : ''} in ${jobOutputFolder.split('/').pop()}`);
    try { await nativeOpenOutputFolder(jobOutputFolder); } catch {}

  } finally {
    // Always restore state even if export threw
    _state.jobs           = _savedJobs;
    _state.normalisedRows = _savedNormalisedRows;
    _state.matchResults   = _savedMatchResults;
    _settings.outputFolder = _savedOutputFolder;
  }
}

// ---------------------------------------------------------------------------
// ZIP helper (fflate-bridge)
// ---------------------------------------------------------------------------

function _downloadAsZip(folderName, files) {
  const zipData = {};
  const enc = new TextEncoder();
  files.forEach(f => {
    zipData[`${folderName}/${f.path}`] = enc.encode(f.content);
  });
  window.fflate.zip(zipData, (err, data) => {
    if (err) { console.error('[VfxPull] ZIP error:', err); return; }
    const blob = new Blob([data], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${folderName}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  });
}

// ---------------------------------------------------------------------------
// Download helper
// ---------------------------------------------------------------------------

function _downloadText(filename, content, mimeType = 'text/plain') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------

// ===========================================================================
// VFX PULL WORKSPACE 2.0
// Injected into #pmSimpleLayout as last child (sibling to .pm-sly-body).
// Visible only when #main-prepmark.pm-mode-vfxmarker is set.
// ===========================================================================

const _WS_POSITIONS  = ['Handle Start', 'Cut In', '25%', '50%', '75%', 'Cut Out', 'Handle End'];
const _WS_FRAME_KEYS = ['handleStart', 'cutIn', 'q25', 'q50', 'q75', 'cutOut', 'handleEnd'];

function _wsFrameForPos(posKey, job) {
  const tcIn    = job?.tcIn  || '';
  const tcOut   = job?.tcOut || '';
  const handles = _settings.handles || 8;
  const fps     = job?.fps || 24;

  const tcToFrames = tc => {
    if (!tc) return 0;
    const parts = String(tc).split(/[:;]/);
    if (parts.length < 4) return 0;
    const [h, m, s, f] = parts.map(Number);
    return ((h * 3600 + m * 60 + s) * fps) + f;
  };

  const inFrame  = tcToFrames(tcIn);
  const outFrame = tcToFrames(tcOut) || (inFrame + (job?.frameCount || fps));
  const dur      = Math.max(1, outFrame - inFrame);

  switch (posKey) {
    case 'handleStart': return Math.max(0, inFrame - handles);
    case 'cutIn':       return inFrame;
    case 'q25':         return inFrame + Math.floor(dur * 0.25);
    case 'q50':         return inFrame + Math.floor(dur * 0.5);
    case 'q75':         return inFrame + Math.floor(dur * 0.75);
    case 'cutOut':      return outFrame;
    case 'handleEnd':   return outFrame + handles;
    default:            return inFrame;
  }
}

function _wsFramesToTc(frames, fps = 24) {
  const f = Math.floor(frames % fps);
  const s = Math.floor(frames / fps) % 60;
  const m = Math.floor(frames / fps / 60) % 60;
  const h = Math.floor(frames / fps / 3600);
  return [h, m, s, f].map(n => String(n).padStart(2, '0')).join(':');
}

function _wsStatusLabel(status) {
  switch (status) {
    case 'approved':     return 'Approved';
    case 'match_ok':     return 'Match OK';
    case 'decode_ok':    return 'Decode OK';
    case 'needs_review': return 'Needs Review';
    case 'failed':       return 'Failed';
    default:             return 'Not Checked';
  }
}

function _wsStatusClass(status) {
  switch (status) {
    case 'approved':     return 'ws-status--approved';
    case 'match_ok':     return 'ws-status--ok';
    case 'decode_ok':    return 'ws-status--ok';
    case 'needs_review': return 'ws-status--warn';
    case 'failed':       return 'ws-status--error';
    default:             return 'ws-status--none';
  }
}

function _wsScoreClass(score) {
  if (score >= 90) return 'ws-score--safe';
  if (score >= 70) return 'ws-score--warn';
  return 'ws-score--fail';
}

function _wsPullReadinessLabel(score) {
  if (score >= 90) return 'Safe to Pull';
  if (score >= 70) return 'Needs Review';
  return 'Possible Wrong OCF';
}

// State-reading wrapper: gather a shot's signals and score them.
function _computeShotRisk(i) {
  const job = _state.jobs[i] || {};
  const row = (_state.normalisedRows || [])[i] || {};
  return shotRiskScore({
    ocfLinked:    !!(row.sourcePath && row.status === 'SAFE'),
    status:       _wsVerifyStatus[i] || 'not_checked',
    fileConf:     Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
    visual:       job.frameAlign?.confidence ?? job.metadata?.visualMatch ?? null,
    color:        job.color?.match?.confidence ?? null,
    reframe:      job.reframe?.confidence ?? null,
    drift:        Number(job.frameAlign?.offsetFrames || 0),
    driftApplied: !!job.frameAlign?.applied,
  });
}

// ---------------------------------------------------------------------------
// Inject workspace HTML into #pmSimpleLayout
// ---------------------------------------------------------------------------

function _injectVfxWorkspace() {
  if (document.getElementById('pmVfxWorkspace')) return;
  const layout = document.getElementById('pmSimpleLayout');
  if (!layout) return;

  const ws = document.createElement('div');
  ws.id = 'pmVfxWorkspace';
  ws.className = 'pm-vfx-workspace';
  ws.tabIndex = 0;  // needed to receive JKL keydown events
  ws.innerHTML = _buildWorkspaceHTML();
  layout.appendChild(ws);

  _wireWorkspaceListeners();
}

function _buildWorkspaceHTML() {
  const sheetCells = (rowKey) => _WS_POSITIONS.map((pos, i) =>
    `<div class="pm-vfx-ws-sheet-cell" data-sheet-row="${rowKey}" data-sheet-pos="${_WS_FRAME_KEYS[i]}" title="${pos}">` +
    `<div class="pm-vfx-ws-sheet-thumb pm-vfx-ws-sheet-thumb--empty"></div>` +
    `<span class="pm-vfx-ws-sheet-pos">${pos}</span></div>`
  ).join('');

  return `
<div class="pm-vfx-ws-left">
  <div class="pm-vfx-ws-list-hdr">
    <span class="pm-vfx-ws-list-title">PULL LIST</span>
    <button class="pm-vfx-ws-btn-xs" id="pmWsAutoVerifyAll" type="button">Auto Verify All</button>
  </div>
  <div class="pm-vfx-ws-triage-bar">
    <span class="pm-vfx-ws-triage-count" id="pmWsTriageCount" title="Shots flagged for review">—</span>
    <span class="pm-vfx-ws-bridge" id="pmWsBridgeStatus" style="display:none"></span>
    <span class="pm-vfx-ws-triage-spacer"></span>
    <button class="pm-vfx-ws-triage-btn" id="pmWsTriageReview" type="button" title="Show only shots needing review">⚠ Review</button>
    <button class="pm-vfx-ws-triage-btn" id="pmWsTriageSort" type="button" title="Sort worst-first by risk">Risk ↓</button>
  </div>
  <div class="pm-vfx-ws-list-scroll" id="pmWsList">
    <div class="pm-vfx-ws-list-empty">Run analysis first</div>
  </div>
  <div class="pm-vfx-ws-readiness" id="pmWsReadiness">
    <div class="pm-vfx-ws-readiness-row"><span class="pm-vfx-ws-ready-gate" id="pmWsGateOcf">OCF</span><span class="pm-vfx-ws-ready-label">OCF Linked</span></div>
    <div class="pm-vfx-ws-readiness-row"><span class="pm-vfx-ws-ready-gate" id="pmWsGateVerify">VER</span><span class="pm-vfx-ws-ready-label">Verified</span></div>
    <div class="pm-vfx-ws-readiness-row"><span class="pm-vfx-ws-ready-gate" id="pmWsGateAmf">AMF</span><span class="pm-vfx-ws-ready-label">AMF Ready</span></div>
    <div class="pm-vfx-ws-readiness-row"><span class="pm-vfx-ws-ready-gate" id="pmWsGateFdl">FDL</span><span class="pm-vfx-ws-ready-label">FDL Ready</span></div>
    <div class="pm-vfx-ws-readiness-row"><span class="pm-vfx-ws-ready-gate" id="pmWsGateExr">EXR</span><span class="pm-vfx-ws-ready-label">EXR Export</span></div>
    <div class="pm-vfx-ws-approved-count" id="pmWsApprovedCount">0/0 shots approved</div>
  </div>
</div>

<div class="pm-vfx-ws-center">
  <div class="pm-vfx-ws-viewer-hdr">
    <div class="pm-vfx-ws-modes" id="pmWsViewerModes">
      <button class="pm-vfx-ws-mode" data-ws-mode="qt_ref"  type="button">QT Ref</button>
      <button class="pm-vfx-ws-mode" data-ws-mode="ocf"     type="button">OCF</button>
      <button class="pm-vfx-ws-mode is-active" data-ws-mode="side" type="button">Side by Side</button>
      <button class="pm-vfx-ws-mode" data-ws-mode="wipe"    type="button">Wipe</button>
      <button class="pm-vfx-ws-mode" data-ws-mode="diff"    type="button">Difference</button>
      <button class="pm-vfx-ws-mode" data-ws-mode="blink"   type="button">Blink</button>
      <button class="pm-vfx-ws-mode" data-ws-mode="overlay" type="button">Overlay</button>
    </div>
    <span class="pm-vfx-ws-shot-name" id="pmWsShotName">—</span>
  </div>
  <div class="pm-vfx-ws-viewer" id="pmWsViewer">
    <div class="pm-vfx-ws-viewer-inner mode-side" id="pmWsViewerInner">
      <div class="pm-vfx-ws-vpane qt"><span class="pm-vfx-ws-vpane-label">QT REF</span><div class="pm-vfx-ws-vpane-empty">Select a shot to load<br>QT Reference frame</div></div>
      <div class="pm-vfx-ws-vpane ocf"><span class="pm-vfx-ws-vpane-label">OCF</span><div class="pm-vfx-ws-vpane-empty">Relink OCF to load<br>comparison frame</div></div>
    </div>
  </div>
  <div class="pm-vfx-ws-scrub" id="pmWsScrub">
    <div class="pm-vfx-ws-scrub-tc">
      <span class="pm-vfx-ws-tc-item"><span class="pm-vfx-ws-tc-label">SRC TC</span>&nbsp;<span id="pmWsTcSrc">—</span></span>
      <span class="pm-vfx-ws-tc-sep">|</span>
      <span class="pm-vfx-ws-tc-item"><span class="pm-vfx-ws-tc-label">REC TC</span>&nbsp;<span id="pmWsTcRec">—</span></span>
      <span class="pm-vfx-ws-tc-sep">|</span>
      <span class="pm-vfx-ws-tc-item"><span class="pm-vfx-ws-tc-label">FRAME</span>&nbsp;<span id="pmWsTcFrame">—</span></span>
    </div>
    <input class="pm-vfx-ws-scrub-slider" id="pmWsScrubSlider" type="range" min="0" max="1000" value="0" step="1">
    <div class="pm-vfx-ws-scrub-nav">
      <button class="pm-vfx-ws-scrub-btn" id="pmWsScrubPrev" type="button">◀ Prev</button>
      <button class="pm-vfx-ws-jump-btn" data-jump="handleStart" data-pfx-jump-extra="1" type="button">⊢</button>
      <button class="pm-vfx-ws-jump-btn" data-jump="cutIn"       data-pfx-jump-extra="1" type="button">In</button>
      <button class="pm-vfx-ws-play-btn" id="pmWsPlayBtn" type="button" title="Play/Pause (K)">▶</button>
      <button class="pm-vfx-ws-jump-btn" data-jump="q50"         data-pfx-jump-extra="1" type="button">Mid</button>
      <button class="pm-vfx-ws-jump-btn" data-jump="cutOut"      data-pfx-jump-extra="1" type="button">Out</button>
      <button class="pm-vfx-ws-jump-btn" data-jump="handleEnd"   data-pfx-jump-extra="1" type="button">⊣</button>
      <button class="pm-vfx-ws-scrub-btn" id="pmWsScrubNext" type="button">Next ▶</button>
    </div>
  </div>
  <div class="pm-vfx-ws-sheet-hdr">HERO FRAMES</div>
  <div class="pm-vfx-ws-sheet" id="pmWsSheet">
    <div class="pm-vfx-ws-sheet-row" id="pmWsSheetQt">${sheetCells('qt')}</div>
    <div class="pm-vfx-ws-sheet-row" id="pmWsSheetOcf">${sheetCells('ocf')}</div>
  </div>
</div>

<div class="pm-vfx-ws-right">
  <div class="pm-vfx-ws-tabs-hdr" id="pmWsTabsHdr">
    <button class="pm-vfx-ws-tab is-active" data-ws-tab="verify"  type="button">Verify</button>
    <button class="pm-vfx-ws-tab"           data-ws-tab="conform" type="button">Conform</button>
    <button class="pm-vfx-ws-tab"           data-ws-tab="export"  type="button">Export</button>
    <button class="pm-vfx-ws-tab"           data-ws-tab="notes"   type="button">Notes</button>
  </div>
  <div class="pm-vfx-ws-tab-body" id="pmWsTabBody">
    <div class="pm-vfx-ws-tab-pane is-active" data-ws-tab-pane="verify"  id="pmWsTabVerify"><div class="pm-vfx-ws-tab-empty">Select a shot to verify</div></div>
    <div class="pm-vfx-ws-tab-pane"           data-ws-tab-pane="conform" id="pmWsTabConform"><div class="pm-vfx-ws-tab-empty">Select a shot to view conform data</div></div>
    <div class="pm-vfx-ws-tab-pane"           data-ws-tab-pane="export"  id="pmWsTabExport"><div class="pm-vfx-ws-tab-empty">Select a shot to configure export</div></div>
    <div class="pm-vfx-ws-tab-pane"           data-ws-tab-pane="notes"   id="pmWsTabNotes"><div class="pm-vfx-ws-tab-empty">Select a shot to add notes</div></div>
  </div>
</div>
`;
}

// ---------------------------------------------------------------------------
// Shot selection
// ---------------------------------------------------------------------------

function _wsSelectShot(idx) {
  if (idx < 0 || idx >= _state.jobs.length) return;

  // Close live player on the outgoing shot to free resources.
  if (_wsSelectedIdx !== idx) _wsCloseSession(_wsSelectedIdx);

  _wsSelectedIdx = idx;

  document.querySelectorAll('.pm-vfx-ws-list-row').forEach(r => {
    r.classList.toggle('is-active', parseInt(r.dataset.wsIdx, 10) === idx);
  });

  const job  = _state.jobs[idx] || {};
  const row  = (_state.normalisedRows || [])[idx] || {};
  const name = job.shotName || row.shotName || row.clipName || `Shot ${idx + 1}`;
  const nameEl = document.getElementById('pmWsShotName');
  if (nameEl) nameEl.textContent = name;

  // Initialise scrub slider for this shot
  const fps      = job.fps || 24;
  const handles  = _settings.handles || 8;
  const tcToFrames = tc => {
    if (!tc) return 0;
    const p = String(tc).split(/[:;]/);
    if (p.length < 4) return 0;
    return ((+p[0] * 3600 + +p[1] * 60 + +p[2]) * fps) + +p[3];
  };
  const inFrame  = tcToFrames(row.tcIn || job.tcIn || '');
  const outFrame = tcToFrames(row.tcOut || job.tcOut || '') || (inFrame + (job.frameCount || fps));
  if (!_wsScrubFrame[idx]) _wsScrubFrame[idx] = inFrame;

  const slider = document.getElementById('pmWsScrubSlider');
  if (slider) {
    slider.min   = String(Math.max(0, inFrame - handles));
    slider.max   = String(outFrame + handles);
    slider.value = String(_wsScrubFrame[idx]);
  }

  _wsUpdateScrubTc(idx);
  _renderWorkspaceDetail(idx);
  _wsLoadViewerFrame(idx);
}

function _wsUpdateScrubTc(idx) {
  const job   = _state.jobs[idx] || {};
  const row   = (_state.normalisedRows || [])[idx] || {};
  const fps   = job.fps || 24;
  const frame = _wsScrubFrame[idx] || 0;

  const srcEl   = document.getElementById('pmWsTcSrc');
  const recEl   = document.getElementById('pmWsTcRec');
  const frameEl = document.getElementById('pmWsTcFrame');
  if (srcEl)   srcEl.textContent   = _wsFramesToTc(frame, fps);
  if (recEl)   recEl.textContent   = row.recIn || '—';
  if (frameEl) frameEl.textContent = String(frame);
}

async function _wsOpenQtPlayer(idx) {
  const row    = (_state.normalisedRows || [])[idx] || {};
  const qtPath = row?.event?.sourcePath || '';
  if (!qtPath || !window.pfxPlatform?.media) return null;

  const existing = _wsPlayerSession[idx];
  if (existing?.playerId) {
    // Reuse existing session if path hasn't changed; otherwise close it cleanly.
    if (existing._path === qtPath) return existing;
    _wsCloseSession(idx);
  }

  try {
    const r = await window.pfxPlatform.media.openPlayer({ path: qtPath, role: 'qtRef' });
    const session = {
      _path:             qtPath,
      playerId:          r.playerId,
      srcUrl:            r.srcUrl || window.pfxPlatform.media.srcUrl(qtPath),
      requiresTranscode: !!r.requiresTranscode,
      playing:           false,
    };
    _wsPlayerSession[idx] = session;
    return session;
  } catch (e) {
    console.warn('[VfxPull] openPlayer failed:', e.message);
    if (_wsSelectedIdx === idx) {
      const qtPane = document.querySelector('#pmWsViewerInner .pm-vfx-ws-vpane.qt');
      if (qtPane) {
        qtPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">QT REF</span>` +
          `<div class="pm-vfx-ws-vpane-error">QT player failed to open.<br>` +
          `<span style="font-size:9px;opacity:.7">${e.message}</span></div>`;
      }
    }
    return null;
  }
}

async function _wsLoadViewerFrame(idx) {
  if (idx < 0 || idx >= _state.jobs.length) return;
  // Stamp this request; a later call bumps the token, so any decode that
  // resolves after it must not paint (prevents stale-frame flicker).
  const myToken = ++_wsFrameReqToken;
  const _current = () => _wsSelectedIdx === idx && myToken === _wsFrameReqToken;
  const row   = (_state.normalisedRows || [])[idx] || {};
  const job   = _state.jobs[idx] || {};
  const path  = row.sourcePath || '';
  const fps   = job.fps || 24;
  const tc    = _wsFramesToTc(_wsScrubFrame[idx] || 0, fps);
  const inner = document.getElementById('pmWsViewerInner');
  if (!inner) return;

  const mode = _wsViewerMode;
  inner.className = `pm-vfx-ws-viewer-inner mode-${mode}`;

  const qtPane  = inner.querySelector('.pm-vfx-ws-vpane.qt');
  const ocfPane = inner.querySelector('.pm-vfx-ws-vpane.ocf');
  if (!qtPane || !ocfPane) return;

  const showOcf = mode !== 'qt_ref';
  const showQt  = mode !== 'ocf';

  // OCF pane
  if (showOcf && path) {
    const ckey = `${path}|${tc}|ocf`;
    if (_wsFrameCache.has(ckey)) {
      const cached = _wsFrameCache.get(ckey);
      _wsLastGood.set(path, cached);
      ocfPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">OCF</span><img src="${cached}" class="pm-vfx-ws-vpane-img" alt="OCF">`;
    } else {
      ocfPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">OCF</span><div class="pm-vfx-ws-vpane-loading">Loading…</div>`;
      try {
        // Fallback chain: companion (AVFoundation) → ffmpeg. Each step times out
        // and yields to the next, so one dead decoder can't black out the pane.
        const steps = [];
        if (window.pfxPlatform?.media) {
          steps.push(async () => {
            const r = await window.pfxPlatform.media.getOcfStill({ ocfPath: path, sourceTc: tc, outputWidth: 640 });
            return r?.dataUrl || r?.imageDataUrl || null;
          });
        }
        steps.push(async () => {
          const res = await nativeOcfExtractFrame(path, tc, { width: 640, height: 360, format: 'jpg', forceFfmpeg: true });
          return res?.data?.dataUrl || null;
        });
        const { value: dataUrl } = await runDecodeChain(steps, { timeoutMs: 8000, label: 'OCF still' });
        if (dataUrl) {
          _bridgeMonitor.reportSuccess();
          _wsCachePut(ckey, dataUrl);
          _wsLastGood.set(path, dataUrl);
          if (_current())
            ocfPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">OCF</span><img src="${dataUrl}" class="pm-vfx-ws-vpane-img" alt="OCF">`;
        } else if (_current()) {
          // No decoder produced a frame (but none errored) — show last-good if any.
          _wsRenderFallbackOrError(ocfPane, 'OCF', path, 'No frame returned at this timecode.');
        }
      } catch (e) {
        // Timeouts/companion errors feed the bridge watchdog; a plain
        // "this frame can't be decoded" is a per-frame issue, not a bridge drop.
        if (isTimeout(e) || (e.message || '').toLowerCase().includes('companion')) _bridgeMonitor.reportFailure();
        const msg = isTimeout(e) ? 'Decode timed out — showing last good frame.'
          : (e.message || '').toLowerCase().includes('companion') ? 'Companion offline — last good frame.'
          : 'Frame could not be decoded.';
        if (_current()) _wsRenderFallbackOrError(ocfPane, 'OCF', path, msg);
      }
    }
  } else if (!path) {
    ocfPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">OCF</span><div class="pm-vfx-ws-vpane-empty">No OCF linked</div>`;
  }

  // QT Ref pane
  if (showQt) {
    const qtPath = row?.event?.sourcePath || '';
    const vd = _verifyData[idx];
    if (window.pfxPlatform?.media && qtPath) {
      if (mode === 'qt_ref') {
        // Live video mode — open player session and render <video>
        let session = _wsPlayerSession[idx];
        if (!session) {
          qtPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">QT REF</span><div class="pm-vfx-ws-vpane-loading">Opening…</div>`;
          session = await _wsOpenQtPlayer(idx);
        }
        if (session?.srcUrl && !session.requiresTranscode && _wsSelectedIdx === idx) {
          // Reuse existing <video> if already rendered for this session
          const existingVideo = qtPane.querySelector('video');
          if (!existingVideo || existingVideo.dataset.playerId !== session.playerId) {
            qtPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">QT REF</span>` +
              `<video src="${session.srcUrl}" data-player-id="${session.playerId}" class="pm-vfx-ws-vpane-img" preload="auto" playsinline></video>`;
            const vid = qtPane.querySelector('video');
            if (vid) {
              // Seek to current scrub position
              const job2 = _state.jobs[idx] || {};
              const fps2 = job2.fps || 24;
              vid.currentTime = (_wsScrubFrame[idx] || 0) / fps2;
              // Sync scrubber and TC display on timeupdate
              vid.addEventListener('timeupdate', () => {
                if (_wsSelectedIdx !== idx) return;
                const f = Math.round(vid.currentTime * fps2);
                _wsScrubFrame[idx] = f;
                const slider = document.getElementById('pmWsScrubSlider');
                if (slider) slider.value = String(f);
                _wsUpdateScrubTc(idx);
              });
              vid.addEventListener('ended', () => {
                if (_wsPlayerSession[idx]) _wsPlayerSession[idx].playing = false;
                const btn = document.getElementById('pmWsPlayBtn');
                if (btn) { btn.textContent = '▶'; btn.classList.remove('is-playing'); }
              });
            }
          }
        } else if (session?.requiresTranscode && _wsSelectedIdx === idx) {
          // ProRes — still path for now, live playback via HTTP stream not yet wired
          const qtCkey = `${qtPath}|${tc}|qt`;
          if (_wsFrameCache.has(qtCkey)) {
            qtPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">QT REF</span><img src="${_wsFrameCache.get(qtCkey)}" class="pm-vfx-ws-vpane-img" alt="QT Ref">`;
          } else {
            qtPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">QT REF</span><div class="pm-vfx-ws-vpane-loading">Loading…</div>`;
            try {
              const r = await window.pfxPlatform.media.getStill({ path: qtPath, timecode: tc, outputWidth: 640 });
              const du = r?.dataUrl || r?.imageDataUrl || null;
              if (du) {
                _wsCachePut(qtCkey, du);
                if (_current())
                  qtPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">QT REF <span style="font-size:8px;opacity:.6">ProRes</span></span><img src="${du}" class="pm-vfx-ws-vpane-img" alt="QT Ref">`;
              }
            } catch (_) {
              if (_current())
                qtPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">QT REF</span><div class="pm-vfx-ws-vpane-empty">QT Ref frame unavailable</div>`;
            }
          }
        } else if (_current()) {
          qtPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">QT REF</span><div class="pm-vfx-ws-vpane-empty">QT Ref unavailable</div>`;
        }
      } else {
        // Still mode (split / ocf views) — fetch via AVFoundation getStill
        const qtCkey = `${qtPath}|${tc}|qt`;
        if (_wsFrameCache.has(qtCkey)) {
          const cached = _wsFrameCache.get(qtCkey);
          _wsLastGood.set(qtPath, cached);
          qtPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">QT REF</span><img src="${cached}" class="pm-vfx-ws-vpane-img" alt="QT Ref">`;
        } else {
          qtPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">QT REF</span><div class="pm-vfx-ws-vpane-loading">Loading…</div>`;
          try {
            const { value: du } = await runDecodeChain([
              async () => {
                const r = await window.pfxPlatform.media.getStill({ path: qtPath, timecode: tc, outputWidth: 640 });
                return r?.dataUrl || r?.imageDataUrl || null;
              },
              async () => {
                const res = await nativeOcfExtractFrame(qtPath, tc, { width: 640, height: 360, format: 'jpg', forceFfmpeg: true });
                return res?.data?.dataUrl || null;
              },
            ], { timeoutMs: 8000, label: 'QT still' });
            if (du) {
              _bridgeMonitor.reportSuccess();
              _wsCachePut(qtCkey, du);
              _wsLastGood.set(qtPath, du);
              if (_current())
                qtPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">QT REF</span><img src="${du}" class="pm-vfx-ws-vpane-img" alt="QT Ref">`;
            } else if (_current()) {
              _wsRenderFallbackOrError(qtPane, 'QT REF', qtPath, 'QT Ref frame unavailable');
            }
          } catch (e) {
            if (isTimeout(e) || (e.message || '').toLowerCase().includes('companion')) _bridgeMonitor.reportFailure();
            if (_current())
              _wsRenderFallbackOrError(qtPane, 'QT REF', qtPath, isTimeout(e) ? 'QT Ref decode timed out — last good frame.' : 'QT Ref frame unavailable.');
          }
        }
      }
    } else if (vd?.qtRef) {
      qtPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">QT REF</span><img src="${vd.qtRef}" class="pm-vfx-ws-vpane-img" alt="QT Ref">`;
    } else {
      qtPane.innerHTML = `<span class="pm-vfx-ws-vpane-label">QT REF</span><div class="pm-vfx-ws-vpane-empty">Capture QT Ref frame<br>in Pull Prep panel</div>`;
    }
  }

  // Warm neighbouring frames into the cache while idle so frame-stepping and
  // short scrubs paint instantly (cache hit, no decode). Tied to myToken so a
  // newer load cancels it.
  _wsScheduleNeighborPrefetch(idx, myToken);
}

// Schedule an idle prefetch of the frames adjacent to the current scrub point.
function _wsScheduleNeighborPrefetch(idx, token) {
  if (_wsViewerMode === 'qt_ref') return;   // live <video> — stills not used
  const ric = window.requestIdleCallback || (cb => setTimeout(() => cb({ timeRemaining: () => 8 }), 120));
  const cic = window.cancelIdleCallback || clearTimeout;
  if (_wsPrefetchIdle) { cic(_wsPrefetchIdle); _wsPrefetchIdle = 0; }
  _wsPrefetchIdle = ric(() => { _wsPrefetchIdle = 0; _wsRunNeighborPrefetch(idx, token); });
}

// Decode a small set of nearest neighbour frames (OCF + still QT) into the
// frame cache. Bails the instant a newer load supersedes this one, so it never
// competes with interactive decoding or floods the media bridge.
async function _wsRunNeighborPrefetch(idx, token) {
  const live = () => idx === _wsSelectedIdx && token === _wsFrameReqToken;
  if (!live()) return;
  const row     = (_state.normalisedRows || [])[idx] || {};
  const job     = _state.jobs[idx] || {};
  const fps     = job.fps || 24;
  const cur     = _wsScrubFrame[idx] || 0;
  const ocfPath = row.sourcePath || '';
  const qtPath  = row?.event?.sourcePath || '';
  const wantOcf = !!ocfPath;
  const wantQt  = _wsViewerMode !== 'ocf' && !!qtPath;   // QT is a still in these modes
  for (const off of [1, -1, 2, -2, 3, -3]) {
    const f = cur + off;
    if (f < 0) continue;
    const tc = _wsFramesToTc(f, fps);
    if (wantOcf) { if (!live()) return; await _wsWarmStill('ocf', ocfPath, tc); }
    if (wantQt)  { if (!live()) return; await _wsWarmStill('qt',  qtPath,  tc); }
  }
}

// Best-effort: decode one still into the cache if not already present.
async function _wsWarmStill(kind, mediaPath, tc) {
  if (!mediaPath || !tc) return;
  const ckey = `${mediaPath}|${tc}|${kind}`;
  if (_wsFrameCache.has(ckey)) return;
  try {
    let du = null;
    if (window.pfxPlatform?.media) {
      const r = kind === 'ocf'
        ? await window.pfxPlatform.media.getOcfStill({ ocfPath: mediaPath, sourceTc: tc, outputWidth: 640 })
        : await window.pfxPlatform.media.getStill({ path: mediaPath, timecode: tc, outputWidth: 640 });
      du = r?.dataUrl || r?.imageDataUrl || null;
    } else if (kind === 'ocf') {
      const res = await nativeOcfExtractFrame(mediaPath, tc, { width: 640, height: 360, format: 'jpg' });
      du = res?.data?.dataUrl || null;
    }
    if (du) _wsCachePut(ckey, du);
  } catch { /* prefetch is best-effort — ignore decode failures */ }
}

// ---------------------------------------------------------------------------
// Workspace list
// ---------------------------------------------------------------------------

function _renderWorkspaceList() {
  const listEl = document.getElementById('pmWsList');
  if (!listEl) return;

  const total = _state.jobs.length;
  if (!total) {
    listEl.innerHTML = '<div class="pm-vfx-ws-list-empty">Run analysis first</div>';
    _updatePullReadiness();
    _updateTriageHeader();
    return;
  }

  // Triage ordering: optionally filter to review/blocked only and/or sort
  // worst-first by risk. Rows keep their original job index in data-ws-idx, so
  // selection + single-row updates are unaffected by display order.
  let order = _state.jobs.map((_, i) => i);
  if (_wsTriageReview) order = order.filter(i => _computeShotRisk(i).level !== 'ok');
  if (_wsTriageSort) {
    order.sort((a, b) => {
      const ra = _computeShotRisk(a), rb = _computeShotRisk(b);
      const rank = { blocked: 0, review: 1, ok: 2 };
      if (rank[ra.level] !== rank[rb.level]) return rank[ra.level] - rank[rb.level];
      return ra.health - rb.health;   // within a level, lowest health first
    });
  }

  listEl.innerHTML = order.length
    ? order.map(i => _wsListRowMarkup(i)).join('')
    : '<div class="pm-vfx-ws-list-empty">No shots need review 🎉</div>';

  _updatePullReadiness();
  _updateTriageHeader();
}

// Refresh the "N need review" count + filter/sort button active states.
function _updateTriageHeader() {
  const needRev = _state.jobs.reduce((n, _, i) => n + (_computeShotRisk(i).level !== 'ok' ? 1 : 0), 0);
  const countEl = document.getElementById('pmWsTriageCount');
  if (countEl) {
    countEl.textContent = needRev ? `${needRev} need review` : 'all clear';
    countEl.classList.toggle('is-clear', needRev === 0);
  }
  const fBtn = document.getElementById('pmWsTriageReview');
  if (fBtn) fBtn.classList.toggle('is-active', _wsTriageReview);
  const sBtn = document.getElementById('pmWsTriageSort');
  if (sBtn) sBtn.classList.toggle('is-active', _wsTriageSort);
}

// Build the inner cells for one pull-list row (shared by full render and the
// single-row updater so the markup never drifts between the two paths).
function _wsListRowInner(i) {
  const job       = _state.jobs[i] || {};
  const row       = (_state.normalisedRows || [])[i] || {};
  const status    = _wsVerifyStatus[i] || 'not_checked';
  const score     = _wsMatchScore[i];
  const ocfLinked = !!(row.sourcePath && row.status === 'SAFE');
  const approved  = status === 'approved';
  const name      = job.shotName || row.shotName || row.clipName || `Shot ${i + 1}`;
  const scoreTxt  = score != null ? `${score}%` : '—';
  return `
  <span class="pm-vfx-ws-row-dot ${_wsStatusClass(status)}"></span>
  <span class="pm-vfx-ws-row-name" title="${_esc(name)}">${_esc(name)}</span>
  <span class="pm-vfx-ws-row-badge ${_wsStatusClass(status)}">${_wsStatusLabel(status)}</span>
  <span class="pm-vfx-ws-row-score ${score != null ? _wsScoreClass(score) : ''}">${scoreTxt}</span>
  <span class="pm-vfx-ws-row-ocf ${ocfLinked ? 'is-ok' : 'is-missing'}" title="${ocfLinked ? _esc((row.sourcePath || '').split('/').pop()) : 'No OCF'}">${ocfLinked ? '●' : '○'}</span>
  <span class="pm-vfx-ws-row-approve ${approved ? 'is-approved' : ''}">${approved ? '✓' : '—'}</span>`;
}

function _wsListRowMarkup(i) {
  const risk = _computeShotRisk(i);
  const tip = risk.reasons.length ? ` title="${_esc(risk.reasons.join(' · '))}"` : '';
  return `<div class="pm-vfx-ws-list-row risk-${risk.level}${_wsSelectedIdx === i ? ' is-active' : ''}" data-ws-idx="${i}"${tip}>${_wsListRowInner(i)}</div>`;
}

// Update only one row in place — avoids the O(N²) full rebuild when verifying
// shots one at a time (e.g. Auto Verify All). Falls back to a full render if
// the row element isn't present yet.
function _updateWorkspaceListRow(idx) {
  const listEl = document.getElementById('pmWsList');
  if (!listEl) return;
  const rowEl = listEl.querySelector(`.pm-vfx-ws-list-row[data-ws-idx="${idx}"]`);
  if (!rowEl) { _renderWorkspaceList(); return; }
  rowEl.innerHTML = _wsListRowInner(idx);
  rowEl.classList.toggle('is-active', _wsSelectedIdx === idx);
  // Refresh risk level (verify may have changed it) — class + reasons tooltip.
  const risk = _computeShotRisk(idx);
  rowEl.classList.remove('risk-ok', 'risk-review', 'risk-blocked');
  rowEl.classList.add(`risk-${risk.level}`);
  if (risk.reasons.length) rowEl.title = risk.reasons.join(' · '); else rowEl.removeAttribute('title');
  _updatePullReadiness();
  _updateTriageHeader();
}

function _updatePullReadiness() {
  const total    = _state.jobs.length;
  const approved = Object.values(_wsVerifyStatus).filter(s => s === 'approved').length;
  const ocfCount = (_state.normalisedRows || []).filter(r => r?.sourcePath).length;
  const fdlCount = (_state.fdls  || []).filter(Boolean).length;
  const amfCount = (_state.amfXmls || []).filter(Boolean).length;

  const setGate = (id, ok) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.toggle('is-ok',   ok);
    el.classList.toggle('is-warn', !ok && total > 0);
  };

  setGate('pmWsGateOcf',    total > 0 && ocfCount === total);
  setGate('pmWsGateVerify', approved > 0);
  setGate('pmWsGateAmf',    amfCount > 0);
  setGate('pmWsGateFdl',    fdlCount > 0);
  setGate('pmWsGateExr',    total > 0 && approved === total);

  const countEl = document.getElementById('pmWsApprovedCount');
  if (countEl) countEl.textContent = `${approved}/${total} shots approved`;
}

// ---------------------------------------------------------------------------
// Right panel tab rendering
// ---------------------------------------------------------------------------

function _renderWorkspaceDetail(idx) {
  if (idx < 0 || idx >= _state.jobs.length) return;

  const tab = _wsDetailTab;
  document.querySelectorAll('.pm-vfx-ws-tab-pane').forEach(p =>
    p.classList.toggle('is-active', p.dataset.wsTabPane === tab));
  document.querySelectorAll('[data-ws-tab]').forEach(t =>
    t.classList.toggle('is-active', t.dataset.wsTab === tab));

  switch (tab) {
    case 'verify':  _renderWsTabVerify(idx);  break;
    case 'conform': _renderWsTabConform(idx); break;
    case 'export':  _renderWsTabExport(idx);  break;
    case 'notes':   _renderWsTabNotes(idx);   break;
  }
}

function _renderWsTabVerify(idx) {
  const pane = document.getElementById('pmWsTabVerify');
  if (!pane) return;

  const job      = _state.jobs[idx] || {};
  const row      = (_state.normalisedRows || [])[idx] || {};
  const vr       = _wsVerifyResults[idx] || {};
  const status   = _wsVerifyStatus[idx] || 'not_checked';
  const score    = _wsMatchScore[idx];
  const approved = status === 'approved';

  const checkRow = (label, valueStr, ok) => {
    const cls  = ok === true ? 'ws-check--ok' : ok === false ? 'ws-check--fail' : 'ws-check--none';
    const icon = ok === true ? '✓'            : ok === false ? '✗'              : '—';
    return `<div class="pm-vfx-ws-check-row ${cls}">
  <span class="pm-vfx-ws-check-icon">${icon}</span>
  <span class="pm-vfx-ws-check-label">${label}</span>
  <span class="pm-vfx-ws-check-value" title="${_esc(valueStr)}">${_esc(valueStr)}</span>
</div>`;
  };

  const ocfFile  = row.sourcePath ? row.sourcePath.split('/').pop() : '';
  const scoreBadge = score != null
    ? `<span class="pm-vfx-ws-score-badge ${_wsScoreClass(score)}">${score}% — ${_wsPullReadinessLabel(score)}</span>`
    : '<span class="pm-vfx-ws-score-badge ws-score--none">Not scored yet</span>';

  pane.innerHTML = `
<div class="pm-vfx-ws-verify-checks">
  ${checkRow('OCF Linked',      ocfFile || 'No OCF path',                               !!row.sourcePath)}
  ${checkRow('Decode Status',   vr.decodeOk === true ? 'OK' : vr.decodeOk === false ? 'Failed' : 'Not tested', vr.decodeOk)}
  ${checkRow('Duration Match',  vr.durationMatch === true ? 'OK' : vr.durationMatch === false ? 'Mismatch' : '—', vr.durationMatch)}
  ${checkRow('Frame Count',     job.frameCount != null ? `${job.frameCount} fr` : '—',  vr.frameCountMatch)}
  ${checkRow('Timecode',        vr.tcMatch === true ? 'OK' : vr.tcMatch === false ? 'Does not match editorial' : '—', vr.tcMatch)}
  ${checkRow('Visual Match',    score != null ? `${score}%` : '—',                      score != null ? score >= 70 : undefined)}
  ${checkRow('Framing',         vr.framingMatch === true ? 'OK' : vr.framingMatch === false ? 'Mismatch detected' : '—', vr.framingMatch)}
  ${checkRow('Speed',           vr.speedMatch === true ? 'OK' : vr.speedMatch === false ? 'Speed mismatch detected' : '—', vr.speedMatch)}
</div>
<div class="pm-vfx-ws-score-row">${scoreBadge}</div>
<div class="pm-vfx-ws-verify-actions">
  <button class="pm-vfx-ws-action-btn" id="pmWsAutoVerifyBtn" type="button">⚡ Auto Verify</button>
  <button class="pm-vfx-ws-action-btn${approved ? ' is-approved' : ' primary'}" id="pmWsApproveLinkBtn" type="button">${approved ? '✓ Approved' : 'Approve Link'}</button>
</div>
${!approved ? '<div class="pm-vfx-ws-lock-msg">Approve this OCF before exporting EXR.</div>' : ''}
`;

  document.getElementById('pmWsAutoVerifyBtn')?.addEventListener('click',  () => _wsAutoVerify(idx));
  document.getElementById('pmWsApproveLinkBtn')?.addEventListener('click', () => _wsApproveLink(idx));
}

function _renderWsTabConform(idx) {
  const pane = document.getElementById('pmWsTabConform');
  if (!pane) return;

  const job = _state.jobs[idx] || {};
  const row = (_state.normalisedRows || [])[idx] || {};
  const fdl = _state.fdls[idx] || {};

  const tcIn   = row.tcIn   || job.tcIn   || fdl.sourceTcIn  || '—';
  const tcOut  = row.tcOut  || job.tcOut  || fdl.sourceTcOut || '—';
  const recIn  = row.recIn  || '—';
  const recOut = row.recOut || '—';
  const speed  = row.event?.speedPercent ? `${Math.round(row.event.speedPercent)}%` : '100%';
  const scale  = job.reframe?.scale  ? job.reframe.scale.toFixed(3) : '—';
  const posX   = job.reframe?.cropBox?.[0] != null ? String(job.reframe.cropBox[0]) : '—';
  const posY   = job.reframe?.cropBox?.[1] != null ? String(job.reframe.cropBox[1]) : '—';
  const fit    = job.reframe?.fit || fdl.reformatNotes || '—';
  const qtPath  = row.event?.sourcePath || '—';
  const ocfPath = row.sourcePath || '—';

  const kv = (k, v) => `<div class="pm-vfx-ws-kv-row"><span class="pm-vfx-ws-kv-k">${k}</span><span class="pm-vfx-ws-kv-v" title="${_esc(String(v))}">${_esc(String(v))}</span></div>`;

  pane.innerHTML = `
<div class="pm-vfx-ws-conform-section">
  <div class="pm-vfx-ws-section-lbl">PATHS</div>
  ${kv('QT Ref', qtPath)}
  ${kv('OCF', ocfPath)}
</div>
<div class="pm-vfx-ws-conform-section">
  <div class="pm-vfx-ws-section-lbl">TIMECODE</div>
  ${kv('Src In',  tcIn)}
  ${kv('Src Out', tcOut)}
  ${kv('Rec In',  recIn)}
  ${kv('Rec Out', recOut)}
  ${kv('Frames',  job.frameCount != null ? `${job.frameCount} fr (incl. ${_settings.handles || 8}f handles/side)` : '—')}
</div>
<div class="pm-vfx-ws-conform-section">
  <div class="pm-vfx-ws-section-lbl">REFORMAT</div>
  ${kv('Speed',    speed)}
  ${kv('Scale',    scale)}
  ${kv('Pos X',    posX)}
  ${kv('Pos Y',    posY)}
  ${kv('Fit',      fit)}
</div>
`;
}

function _renderWsTabExport(idx) {
  const pane = document.getElementById('pmWsTabExport');
  if (!pane) return;

  const job      = _state.jobs[idx] || {};
  const row      = (_state.normalisedRows || [])[idx] || {};
  const fdl      = _state.fdls[idx] || {};
  const status   = _wsVerifyStatus[idx] || 'not_checked';
  const score    = _wsMatchScore[idx];
  const approved = status === 'approved';
  const passesScore = score != null && score >= 90;
  const locked   = !approved && !passesScore;

  const plateName  = job.plateName || _plateName(idx);
  const start      = _settings.frameStart || 1001;
  const handles    = _settings.handles || 8;
  const frameRange = job.frameCount
    ? `${start} – ${start + job.frameCount - 1}`
    : '—';
  const outFolder  = _settings.outputFolder || '—';

  const kv = (k, v) => `<div class="pm-vfx-ws-kv-row"><span class="pm-vfx-ws-kv-k">${k}</span><span class="pm-vfx-ws-kv-v" title="${_esc(String(v))}">${_esc(String(v))}</span></div>`;

  pane.innerHTML = `
<div class="pm-vfx-ws-conform-section">
  <div class="pm-vfx-ws-section-lbl">OUTPUT NAMING</div>
  ${kv('Shot Name',   job.shotName || row.shotName || `Shot ${idx + 1}`)}
  ${kv('Plate Name',  plateName)}
  ${kv('Frame Range', frameRange)}
  ${kv('Start Frame', start)}
  ${kv('Handles',     `${handles} fr`)}
  ${kv('Color Space', 'ACES2065-1 (AP0 scene-linear)')}
</div>
<div class="pm-vfx-ws-conform-section">
  <div class="pm-vfx-ws-section-lbl">DESTINATION</div>
  ${kv('Output Folder', outFolder)}
  ${kv('AMF', _settings.generateAmf !== false ? 'Enabled' : 'Disabled')}
  ${kv('FDL', _settings.generateFdl !== false ? 'Enabled' : 'Disabled')}
</div>
${locked ? '<div class="pm-vfx-ws-lock-msg">EXR export is locked until verification passes.<br>Approve OCF link before exporting EXR.</div>' : ''}
<div style="display:flex;flex-direction:column;gap:5px;margin-top:4px;">
  <button class="pm-vfx-ws-action-btn${locked ? ' is-locked' : ' primary'}" id="pmWsExportExrBtn" type="button" ${locked ? 'disabled' : ''}>⬇ Export EXR (ACES2065-1)</button>
  <button class="pm-vfx-ws-action-btn" id="pmWsExportReportBtn" type="button">Save Verify Report</button>
</div>
`;

  if (!locked) document.getElementById('pmWsExportExrBtn')?.addEventListener('click',    () => _wsExportEXR(idx));
  document.getElementById('pmWsExportReportBtn')?.addEventListener('click', () => _wsExportOcfReport(idx));
}

function _renderWsTabNotes(idx) {
  const pane = document.getElementById('pmWsTabNotes');
  if (!pane) return;

  const notes = _wsNotes[idx] || '';
  pane.innerHTML = `
<textarea class="pm-vfx-ws-notes-field" id="pmWsNotesField" placeholder="Add notes for this shot…">${_esc(notes)}</textarea>
<button class="pm-vfx-ws-action-btn" id="pmWsNotesSaveBtn" type="button">Save Notes</button>
`;
  document.getElementById('pmWsNotesSaveBtn')?.addEventListener('click', () => {
    const field = document.getElementById('pmWsNotesField');
    _wsNotes[idx] = field?.value || '';
  });
}

// ---------------------------------------------------------------------------
// Auto Verify
// ---------------------------------------------------------------------------

async function _wsAutoVerify(idx) {
  const job  = _state.jobs[idx] || {};
  const row  = (_state.normalisedRows || [])[idx] || {};
  const path = row.sourcePath || '';

  _wsVerifyStatus[idx]  = 'not_checked';
  _wsMatchScore[idx]    = null;
  _wsVerifyResults[idx] = {};
  _updateWorkspaceListRow(idx);
  _renderWorkspaceDetail(idx);

  if (!path) {
    _wsVerifyStatus[idx] = 'failed';
    _updateWorkspaceListRow(idx);
    _renderWorkspaceDetail(idx);
    return;
  }

  const results = { decodeOk: null, tcMatch: null, durationMatch: null, frameCountMatch: null, framingMatch: null, speedMatch: null };

  // Timecode match from existing matcher results
  const rawMr = _state.matchResults[idx] || {};
  results.tcMatch = rawMr.match?.status === 'SAFE' || !!(rawMr.match?.reasons || []).some(r => /timecode/i.test(r));

  // Duration / frame count
  const ev  = rawMr.event || {};
  const fps = ev.fps || job.fps || 24;
  const tcToF = tc => {
    const p = String(tc || '').split(/[:;]/);
    if (p.length < 4) return 0;
    return ((+p[0] * 3600 + +p[1] * 60 + +p[2]) * fps) + +p[3];
  };
  const eventDur = (ev.srcIn && ev.srcOut) ? tcToF(ev.srcOut) - tcToF(ev.srcIn) : 0;
  const jobDur   = job.frameCount || 0;
  results.durationMatch   = (jobDur > 0 && eventDur > 0) ? Math.abs(eventDur - jobDur) <= 2 : null;
  results.frameCountMatch = results.durationMatch;

  // Speed match
  const sf = ev.speedFactor;
  results.speedMatch = sf != null ? Math.abs(sf - 1.0) < 0.01 : null;

  // OCF decode
  const tcIn = row.tcIn || '';
  try {
    const res = await nativeOcfExtractFrame(path, tcIn, { width: 640, height: 360, format: 'jpg' });
    if (res?.data?.dataUrl) {
      results.decodeOk = true;
      const ckey = `${path}|${tcIn}|ocf`;
      _wsCachePut(ckey, res.data.dataUrl);
      _wsVerifyStatus[idx] = 'decode_ok';
      if (_wsSelectedIdx === idx) _wsLoadViewerFrame(idx);

      // Luma comparison with QT Ref if available
      const vd = _verifyData[idx];
      if (vd?.qtRef) {
        try {
          const [qtImg, ocfImg] = await Promise.all([
            _dataUrlToImageData(vd.qtRef, 640, 360),
            _dataUrlToImageData(res.data.dataUrl, 640, 360),
          ]);
          if (qtImg && ocfImg) {
            const lumaScore = _wsCompareLuma(qtImg.data, ocfImg.data, qtImg.width, qtImg.height);
            _wsMatchScore[idx] = lumaScore;
            try {
              const lb = detectLetterboxPillarbox(ocfImg.data, ocfImg.width, ocfImg.height);
              results.framingMatch = !lb.hasLetterbox && !lb.hasPillarbox;
            } catch { results.framingMatch = null; }
            _wsVerifyStatus[idx] = lumaScore >= 90 ? 'match_ok' : lumaScore >= 70 ? 'needs_review' : 'failed';
          }
        } catch (e) { console.warn('[WsVerify] luma compare failed:', e); }
      }
    } else {
      results.decodeOk = false;
      _wsVerifyStatus[idx] = 'failed';
    }
  } catch (e) {
    results.decodeOk = false;
    _wsVerifyStatus[idx] = 'failed';
    console.warn('[WsVerify] OCF decode error:', e);
  }

  _wsVerifyResults[idx] = results;
  _updateWorkspaceListRow(idx);
  _renderWorkspaceDetail(idx);
}

async function _wsAutoVerifyAll() {
  for (let i = 0; i < _state.jobs.length; i++) {
    await _wsAutoVerify(i);
  }
}

// Subsampled luma RMSE → 0–100 match score
function _wsCompareLuma(aData, bData, w, h) {
  const len  = w * h;
  if (!len) return 0;
  const step = Math.max(1, Math.floor(len / 4096));
  let diff = 0, count = 0;
  const luma = (d, i4) => 0.2126 * d[i4] + 0.7152 * d[i4 + 1] + 0.0722 * d[i4 + 2];
  for (let i = 0; i < len; i += step) {
    diff += Math.abs(luma(aData, i * 4) - luma(bData, i * 4));
    count++;
  }
  return Math.round(Math.max(0, 100 - (diff / count / 2.55) * 1.5));
}

// ---------------------------------------------------------------------------
// Approve OCF link
// ---------------------------------------------------------------------------

function _wsApproveLink(idx) {
  const status = _wsVerifyStatus[idx] || 'not_checked';
  if ((status === 'not_checked' || status === 'failed') &&
      !confirm('This shot has not passed verification. Approve anyway?')) return;

  _wsVerifyStatus[idx] = 'approved';
  if (!_verifyData[idx]) _verifyData[idx] = {};
  _verifyData[idx].approved = true;

  _updateWorkspaceListRow(idx);
  _renderWorkspaceDetail(idx);
  _updatePullReadiness();
}

// ---------------------------------------------------------------------------
// EXR export with lock rule
// ---------------------------------------------------------------------------

async function _wsExportEXR(idx) {
  const row      = (_state.normalisedRows || [])[idx] || {};
  const status   = _wsVerifyStatus[idx] || 'not_checked';
  const score    = _wsMatchScore[idx];
  const approved = status === 'approved';
  const passesScore = score != null && score >= 90;

  if (!row.sourcePath) {
    alert('OCF path exists requirement not met.\nApprove OCF link before exporting EXR.');
    return;
  }
  if (!approved && !passesScore) {
    alert('EXR export is locked until verification passes.\nApprove this OCF before exporting EXR.');
    return;
  }
  if (typeof window.__vfxPullExportExr === 'function') {
    await window.__vfxPullExportExr();
  } else {
    alert('Export function unavailable. Use the Export button in the VFX Pull panel.');
  }
}

// ---------------------------------------------------------------------------
// Per-shot OCF verify report
// ---------------------------------------------------------------------------

function _wsExportOcfReport(idx) {
  const job    = _state.jobs[idx] || {};
  const row    = (_state.normalisedRows || [])[idx] || {};
  const vr     = _wsVerifyResults[idx] || {};
  const status = _wsVerifyStatus[idx] || 'not_checked';
  const score  = _wsMatchScore[idx];

  const report = {
    shotName:     job.shotName || row.shotName || `Shot ${idx + 1}`,
    qtRefPath:    row.event?.sourcePath || '',
    ocfPath:      row.sourcePath || '',
    sourceTc:     row.tcIn || '',
    recordTc:     row.recIn || '',
    frameRange:   { start: _settings.frameStart || 1001, count: job.frameCount || 0, handles: _settings.handles || 8 },
    decodeStatus: vr.decodeOk === true ? 'OK' : vr.decodeOk === false ? 'FAILED' : 'NOT_TESTED',
    matchScore:   score ?? null,
    approved:     status === 'approved',
    warnings:     row.warnings || [],
    tcMatch:      vr.tcMatch     ?? null,
    durationMatch: vr.durationMatch ?? null,
    framingMatch: vr.framingMatch  ?? null,
    speedMatch:   vr.speedMatch    ?? null,
    notes:        _wsNotes[idx] || '',
    timestamp:    new Date().toISOString(),
  };

  const name = _plateName(idx) || `shot_${String(idx + 1).padStart(3, '0')}`;
  _downloadText(`${name}_ocf_verify_report.json`, JSON.stringify(report, null, 2), 'application/json');
}

// ---------------------------------------------------------------------------
// Hero frame contact sheet (7 frames × 2 rows)
// ---------------------------------------------------------------------------

async function _wsBuildContactSheet(idx) {
  const job    = _state.jobs[idx] || {};
  const row    = (_state.normalisedRows || [])[idx] || {};
  const path   = row.sourcePath || '';
  const qtPath = row.event?.sourcePath || '';
  const fps    = job.fps || 24;
  const merged = { ...row, ...job };

  // Build frame-spec array once — shared by both rows.
  const specs = _WS_FRAME_KEYS.map((posKey, p) => {
    const frame = _wsFrameForPos(posKey, merged);
    const tc    = _wsFramesToTc(frame, fps);
    return { pos: posKey, label: _WS_POSITIONS[p], frame, tc, dataUrl: null };
  });

  const sheet = {
    qt:  specs.map(s => ({ ...s })),
    ocf: specs.map(s => ({ ...s })),
  };
  _wsContactSheet[idx] = sheet;
  _wsRenderContactSheet(idx); // render placeholders immediately

  const useNative = !!window.pfxPlatform?.media;

  // ── OCF row ──────────────────────────────────────────────────────────────
  if (path) {
    if (useNative) {
      // Parallel fetch via media engine (Resolve → AVF → FFmpeg per frame).
      await Promise.all(sheet.ocf.map(async (entry) => {
        const ckey = `${path}|${entry.tc}|ocf`;
        if (_wsFrameCache.has(ckey)) { entry.dataUrl = _wsFrameCache.get(ckey); return; }
        try {
          const r = await window.pfxPlatform.media.getOcfStill({ ocfPath: path, sourceTc: entry.tc, outputWidth: 320 });
          const du = r?.dataUrl || r?.imageDataUrl || null;
          if (du) { _wsCachePut(ckey, du); entry.dataUrl = du; }
        } catch {}
      }));
    } else {
      // Sequential companion path (Chrome extension).
      for (const entry of sheet.ocf) {
        const ckey = `${path}|${entry.tc}|ocf`;
        if (_wsFrameCache.has(ckey)) { entry.dataUrl = _wsFrameCache.get(ckey); continue; }
        try {
          const res = await nativeOcfExtractFrame(path, entry.tc, { width: 320, height: 180, format: 'jpg' });
          if (res?.data?.dataUrl) { _wsCachePut(ckey, res.data.dataUrl); entry.dataUrl = res.data.dataUrl; }
        } catch {}
      }
    }
  }

  // ── QT row ───────────────────────────────────────────────────────────────
  if (useNative && qtPath) {
    // Electron: batch-extract all 7 hero frames in one AVFoundation call.
    try {
      const r = await window.pfxPlatform.media.getHeroFrames({
        path:        qtPath,
        frames:      specs.map(s => ({ frame: s.frame, timecode: s.tc, label: s.label })),
        outputWidth: 320,
      });
      if (r?.frames) {
        r.frames.forEach((f, i) => {
          if (f?.ok && (f.dataUrl || f.imageDataUrl)) {
            const du = f.dataUrl || f.imageDataUrl;
            sheet.qt[i].dataUrl = du;
            _wsCachePut(`${qtPath}|${specs[i].tc}|qt`, du);
          }
        });
      }
    } catch (heroErr) {
      console.warn('[VfxPull] getHeroFrames failed for QT filmstrip:', heroErr?.message);
      // Mark all QT cells as failed so _wsRenderContactSheet shows ✗ instead of blank
      sheet.qt.forEach(cell => { cell.error = heroErr?.message || 'avf_bridge unavailable'; });
    }
  } else {
    // Fallback: use the previously-captured mid-frame still if available.
    const midIdx = _WS_FRAME_KEYS.indexOf('q50');
    if (midIdx >= 0 && _verifyData[idx]?.qtRef) {
      sheet.qt[midIdx].dataUrl = _verifyData[idx].qtRef;
    }
  }

  _wsRenderContactSheet(idx);
}

function _wsRenderContactSheet(idx) {
  const sheet = _wsContactSheet[idx];
  if (!sheet) return;

  const fillRow = (rowId, frames) => {
    const rowEl = document.getElementById(rowId);
    if (!rowEl) return;
    rowEl.querySelectorAll('.pm-vfx-ws-sheet-cell').forEach((cell, i) => {
      const entry = frames[i];
      const thumb = cell.querySelector('.pm-vfx-ws-sheet-thumb');
      if (!thumb) return;
      if (entry?.dataUrl) {
        thumb.innerHTML = `<img src="${entry.dataUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:3px;" alt="${_esc(entry.label)}">`;
        thumb.classList.remove('pm-vfx-ws-sheet-thumb--empty');
      } else if (entry?.error) {
        thumb.innerHTML = `<span style="font-size:10px;color:rgba(255,80,80,.7)" title="${_esc(entry.error)}">✗</span>`;
        thumb.classList.add('pm-vfx-ws-sheet-thumb--empty');
      } else {
        thumb.innerHTML = '';
        thumb.classList.add('pm-vfx-ws-sheet-thumb--empty');
      }
    });
  };

  fillRow('pmWsSheetQt',  sheet.qt);
  fillRow('pmWsSheetOcf', sheet.ocf);
}

// ---------------------------------------------------------------------------
// Wire workspace event listeners (once after HTML injection)
// ---------------------------------------------------------------------------

function _wireWorkspaceListeners() {
  if (_wsWorkspaceWired) return;
  _wsWorkspaceWired = true;

  // Safety net: never orphan companion player sessions on reload/close.
  try { window.addEventListener('pagehide', _wsCloseAllSessions); } catch {}

  const ws = document.getElementById('pmVfxWorkspace');
  if (!ws) return;

  ws.addEventListener('click', e => {
    // Shot list row
    const listRow = e.target.closest('.pm-vfx-ws-list-row');
    if (listRow) {
      const idx = parseInt(listRow.dataset.wsIdx, 10);
      if (Number.isFinite(idx)) _wsSelectShot(idx);
      return;
    }

    // Compare viewer mode buttons
    const modeBtn = e.target.closest('[data-ws-mode]');
    if (modeBtn && modeBtn.closest('#pmWsViewerModes')) {
      const prevMode = _wsViewerMode;
      _wsViewerMode = modeBtn.dataset.wsMode;
      // Leaving live-video mode: the <video> is about to be replaced by a still,
      // so close the companion player session it backed (otherwise it leaks).
      if (prevMode === 'qt_ref' && _wsViewerMode !== 'qt_ref') _wsCloseSession(_wsSelectedIdx);
      ws.querySelectorAll('[data-ws-mode]').forEach(b => b.classList.toggle('is-active', b === modeBtn));
      _wsLoadViewerFrame(_wsSelectedIdx);
      return;
    }

    // Right panel tabs
    const tabBtn = e.target.closest('[data-ws-tab]');
    if (tabBtn && tabBtn.closest('#pmWsTabsHdr')) {
      _wsDetailTab = tabBtn.dataset.wsTab;
      _renderWorkspaceDetail(_wsSelectedIdx);
      return;
    }

    // Contact sheet cell → load that position in the viewer
    const sheetCell = e.target.closest('[data-sheet-row]');
    if (sheetCell) {
      const posKey = sheetCell.dataset.sheetPos;
      const idx    = _wsSelectedIdx;
      const job    = _state.jobs[idx] || {};
      const row    = (_state.normalisedRows || [])[idx] || {};
      const frame  = _wsFrameForPos(posKey, { ...row, ...job });
      _wsScrubFrame[idx] = frame;
      const slider = document.getElementById('pmWsScrubSlider');
      if (slider) slider.value = String(frame);
      _wsUpdateScrubTc(idx);
      _wsLoadViewerFrame(idx);
      return;
    }

    // Jump buttons (Handle Start / Cut In / Mid / Cut Out / Handle End)
    const jumpBtn = e.target.closest('[data-jump]');
    if (jumpBtn) {
      const idx    = _wsSelectedIdx;
      const job    = _state.jobs[idx] || {};
      const row    = (_state.normalisedRows || [])[idx] || {};
      const frame  = _wsFrameForPos(jumpBtn.dataset.jump, { ...row, ...job });
      _wsScrubFrame[idx] = frame;
      const slider = document.getElementById('pmWsScrubSlider');
      if (slider) slider.value = String(frame);
      _wsUpdateScrubTc(idx);
      _wsLoadViewerFrame(idx);
      return;
    }

    // Prev / Next frame
    const scrubId = e.target.id;
    if (scrubId === 'pmWsScrubPrev' || scrubId === 'pmWsScrubNext') {
      const delta = scrubId === 'pmWsScrubPrev' ? -1 : 1;
      const idx   = _wsSelectedIdx;
      const slider = document.getElementById('pmWsScrubSlider');
      let frame = (_wsScrubFrame[idx] || 0) + delta;
      if (slider) frame = Math.max(parseInt(slider.min, 10), Math.min(parseInt(slider.max, 10), frame));
      _wsScrubFrame[idx] = frame;
      if (slider) slider.value = String(frame);
      _wsUpdateScrubTc(idx);
      _wsLoadViewerFrame(idx);
      return;
    }

    // Play/Pause button
    if (e.target.id === 'pmWsPlayBtn' || e.target.closest('#pmWsPlayBtn')) {
      const btn = document.getElementById('pmWsPlayBtn');
      const idx = _wsSelectedIdx;
      const session = _wsPlayerSession[idx];
      if (session?.playerId && window.pfxPlatform?.media) {
        if (session.playing) {
          window.pfxPlatform.media.pause({ playerId: session.playerId }).catch(() => {});
          session.playing = false;
          if (btn) { btn.textContent = '▶'; btn.classList.remove('is-playing'); }
        } else {
          window.pfxPlatform.media.play({ playerId: session.playerId }).catch(() => {});
          session.playing = true;
          if (btn) { btn.textContent = '⏸'; btn.classList.add('is-playing'); }
        }
      } else if (window.pfxPlatform?.media && _wsViewerMode === 'qt_ref') {
        // Open player then start playing
        _wsOpenQtPlayer(idx).then(s => {
          if (!s?.playerId) return;
          // Re-render viewer with video then play
          _wsLoadViewerFrame(idx).then(() => {
            window.pfxPlatform.media.play({ playerId: s.playerId }).catch(() => {});
            s.playing = true;
            if (btn) { btn.textContent = '⏸'; btn.classList.add('is-playing'); }
          });
        });
      }
      return;
    }

    // Auto Verify All button
    if (e.target.id === 'pmWsAutoVerifyAll') {
      _wsAutoVerifyAll();
      return;
    }

    // Triage: filter to review-only / sort worst-first by risk.
    if (e.target.id === 'pmWsTriageReview') {
      _wsTriageReview = !_wsTriageReview;
      _renderWorkspaceList();
      return;
    }
    if (e.target.id === 'pmWsTriageSort') {
      _wsTriageSort = !_wsTriageSort;
      _renderWorkspaceList();
      return;
    }
  });

  // Scrub slider drag — update TC display live; also seek live player.
  // `input` fires every pointer tick (~60+/s); coalesce the live seek to one
  // call per animation frame so a drag can't flood the media bridge.
  let _seekRaf = 0;
  ws.addEventListener('input', e => {
    if (e.target.id === 'pmWsScrubSlider') {
      const idx = _wsSelectedIdx;
      _wsScrubFrame[idx] = parseInt(e.target.value, 10);
      _wsUpdateScrubTc(idx);
      // Seek live video if player is open (throttled to rAF)
      const session = _wsPlayerSession[idx];
      if (session?.playerId && window.pfxPlatform?.media) {
        if (_seekRaf) return;
        _seekRaf = requestAnimationFrame(() => {
          _seekRaf = 0;
          const sess = _wsPlayerSession[_wsSelectedIdx];
          if (!sess?.playerId || !window.pfxPlatform?.media) return;
          const job = _state.jobs[_wsSelectedIdx] || {};
          const fps = job.fps || 24;
          window.pfxPlatform.media.seek({ playerId: sess.playerId, seconds: (_wsScrubFrame[_wsSelectedIdx] || 0) / fps }).catch(() => {});
        });
      }
    }
  });

  // Scrub slider release — load viewer frame (or seek live player)
  ws.addEventListener('change', e => {
    if (e.target.id === 'pmWsScrubSlider') {
      const idx = _wsSelectedIdx;
      const session = _wsPlayerSession[idx];
      if (!session?.playerId) {
        _wsLoadViewerFrame(idx);
      }
    }
  });

  // JKL keyboard shortcuts (scoped to workspace; J=rev, K=pause, L=fwd)
  ws.addEventListener('keydown', e => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
    const idx     = _wsSelectedIdx;
    const session = _wsPlayerSession[idx];
    const btn     = document.getElementById('pmWsPlayBtn');

    if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      if (session?.playerId && session.playing && window.pfxPlatform?.media) {
        window.pfxPlatform.media.pause({ playerId: session.playerId }).catch(() => {});
        session.playing = false;
        if (btn) { btn.textContent = '▶'; btn.classList.remove('is-playing'); }
      }
      return;
    }

    if (e.key === 'l' || e.key === 'L') {
      e.preventDefault();
      if (session?.playerId && window.pfxPlatform?.media) {
        if (!session.playing) {
          window.pfxPlatform.media.play({ playerId: session.playerId }).catch(() => {});
          session.playing = true;
          if (btn) { btn.textContent = '⏸'; btn.classList.add('is-playing'); }
        } else {
          window.pfxPlatform.media.stepFrame({ playerId: session.playerId, delta: 1 }).catch(() => {});
        }
      } else {
        // No active player — step frame via scrubber
        const job = _state.jobs[idx] || {};
        const slider = document.getElementById('pmWsScrubSlider');
        let frame = (_wsScrubFrame[idx] || 0) + 1;
        if (slider) frame = Math.min(parseInt(slider.max, 10), frame);
        _wsScrubFrame[idx] = frame;
        if (slider) slider.value = String(frame);
        _wsUpdateScrubTc(idx);
        _wsLoadViewerFrame(idx);
      }
      return;
    }

    if (e.key === 'j' || e.key === 'J') {
      e.preventDefault();
      if (session?.playerId && window.pfxPlatform?.media) {
        if (!session.playing) {
          window.pfxPlatform.media.stepFrame({ playerId: session.playerId, delta: -1 }).catch(() => {});
        } else {
          window.pfxPlatform.media.pause({ playerId: session.playerId }).catch(() => {});
          session.playing = false;
          if (btn) { btn.textContent = '▶'; btn.classList.remove('is-playing'); }
          window.pfxPlatform.media.stepFrame({ playerId: session.playerId, delta: -1 }).catch(() => {});
        }
      } else {
        // No active player — step frame via scrubber
        const job = _state.jobs[idx] || {};
        const slider = document.getElementById('pmWsScrubSlider');
        let frame = (_wsScrubFrame[idx] || 0) - 1;
        if (slider) frame = Math.max(parseInt(slider.min, 10), frame);
        _wsScrubFrame[idx] = frame;
        if (slider) slider.value = String(frame);
        _wsUpdateScrubTc(idx);
        _wsLoadViewerFrame(idx);
      }
      return;
    }
  });
}

// Called from _renderShotTable whenever shot data changes
function _wsRefreshWorkspace() {
  if (!document.getElementById('pmVfxWorkspace')) return;
  _renderWorkspaceList();
  // Auto-select first shot if nothing is selected yet
  if (_state.jobs.length > 0 && _wsSelectedIdx === 0) {
    _wsSelectShot(0);
  } else if (_wsSelectedIdx < _state.jobs.length) {
    _renderWorkspaceDetail(_wsSelectedIdx);
  }
}

function _persistState() {
  try {
    const data = {
      ocfFolder: _state.ocfFolder,
      outputFolder: _settings.outputFolder,
      settings: { ..._settings },
      manualLinks: _state.manualLinks || {},
      ocfFromLibrary: !!_state.ocfFromLibrary,   // Sprint 4: restore library-link batch on reopen
    };
    localStorage.setItem(_LS_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('[VfxPull] State persist failed:', e);
  }
}

function _restoreState() {
  _libRestoreDone = false;   // re-arm library-link restore for this project
  try {
    const raw = localStorage.getItem(_LS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.ocfFolder) _state.ocfFolder = data.ocfFolder;
    if (data.settings) Object.assign(_settings, data.settings);
    if (data.outputFolder) _settings.outputFolder = data.outputFolder;
    _state.manualLinks = data.manualLinks || {};
    _state.ocfFromLibrary = !!data.ocfFromLibrary;
  } catch (e) {
    console.warn('[VfxPull] State restore failed:', e);
  }
}

// Sprint 4: silently re-derive library-sourced OCF links when a project that was
// last linked from the media library is reopened. No wizard, no auto-approve —
// just repopulate the matches so the LIB badges + counts come back. Guarded so it
// never runs over a real folder scan or an already-matched session.
let _libRestoreDone = false;
async function _restoreLibraryLinksIfNeeded() {
  if (_libRestoreDone) return;
  if ((_state.matchResults || []).length) { _libRestoreDone = true; return; }
  const events = await _providers.getEvents?.() || [];
  if (!events.length) return;                    // events not ready yet — try again next open

  // Case A: a real OCF folder was scanned last session — re-scan + re-match so
  // the shot table isn't empty on reopen (matchResults aren't persisted). Uses a
  // path probe (no folder-picker dialog), guarded to run once per project.
  const folder = _state.ocfFolder;
  if (folder && folder !== '(media library)' && !_state.ocfFromLibrary) {
    try {
      await _scanOcfFolder(folder);
      if ((_state.ocfFiles || []).length) {
        await _matchOcfToCurrentEvents();          // re-applies persisted manual links
        await _rebuildVfxPullArtifactsFromMatches();
        _renderShotTable();
        _updateOcfSummary();
        try { window._pmRefreshVfxWorkspaceList?.(); } catch {}
        _libRestoreDone = true;
        return;
      }
    } catch (e) { console.warn('[VfxPull] folder re-scan restore failed:', e); }
    // fall through to library if the folder yielded nothing
  }

  // Case B: project was last linked from the media library.
  const wasLibrary = !!_state.ocfFromLibrary || folder === '(media library)';
  if (!wasLibrary) { _libRestoreDone = true; return; }
  let n = 0;
  try { n = await libraryCount(); } catch {}
  if (n <= 0) { _libRestoreDone = true; return; }
  try {
    const lib = await loadOcfFilesFromLibrary();
    if (!lib.ok || !lib.files.length) { _libRestoreDone = true; return; }
    _state.ocfFiles  = lib.files;
    _state.ocfFolder = '(media library)';
    _state.ocfFromLibrary = true;
    await _matchOcfToCurrentEvents();            // re-applies persisted manual links too
    await _rebuildVfxPullArtifactsFromMatches();
    _renderShotTable();
    _updateOcfSummary();
    try { window._pmRefreshVfxWorkspaceList?.(); } catch {}
    _libRestoreDone = true;
  } catch (e) {
    console.warn('[VfxPull] library link restore failed:', e);
  }
}
window._pmVfxRestoreLibraryLinks = _restoreLibraryLinksIfNeeded;

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function _applySettingsToUI() {
  _setSelectValue('pmVfxHandles', String(_settings.handles));
  _setInputValue('pmVfxFrameStart', String(_settings.frameStart));
  _setSelectValue('pmVfxPlateFormat', _settings.plateFormat);
  _setSelectValue('pmVfxPullMode',     _settings.pullMode);
  _setSelectValue('pmVfxRenderEngine', _settings.renderEngine || 'auto');
  _setInputValue('pmVfxOutputFolder', _settings.outputFolder);

  // Spec #6 widgets — initial sync from saved settings.
  _setSelectValue('pmVfxTargetRes',  _settings.targetResolution || '3840x2160');
  _setSelectValue('pmVfxExportMode', _settings.exportMode || 'aces_plate');
  _setCheckboxValue('pmVfxBakeSpeed',  !!_settings.bakeSpeed);
  _setCheckboxValue('pmVfxBakeReframe',!!_settings.bakeReframe);
  _setCheckboxValue('pmVfxGenAmf',     _settings.generateAmf !== false);
  _setCheckboxValue('pmVfxGenFdl',     _settings.generateFdl !== false);
  _setCheckboxValue('pmVfxGenNuke',    _settings.generateNukeHandoff !== false);

  const matchMethodsEl = document.getElementById('pmVfxMatchMethods');
  if (matchMethodsEl) {
    matchMethodsEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.checked = _settings.matchMethods.includes(cb.value);
    });
  }
}

function _setCheckboxValue(id, checked) {
  const el = document.getElementById(id);
  if (el) el.checked = !!checked;
}

function _setSelectValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function _setInputValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function _plateName(i) {
  const job = _state.jobs[i];
  const mr = _state.matchResults[i] || {};
  const raw = job?.plateName || job?.shotName || mr?.clipName || `plate_${String(i + 1).padStart(3, '0')}`;
  // Full sanitize (not just whitespace) — a clip name with '/' or ':' would
  // inject a path separator into the package layout, and unsanitized names can
  // collide silently. Fall back to a stable index name if sanitizing empties it.
  return _sanitizeVfxExportName(raw) || `plate_${String(i + 1).padStart(3, '0')}`;
}

function _esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// EXR Delivery Export — collects existing EXR sequences + AMF from linked OCF
// shots and copies them to a user-picked output directory.
// ---------------------------------------------------------------------------

function _collectExrDeliveryShots() {
  const shots = [];
  const seen = new Set();
  // Normalise ocfRoot so we can strip it as a prefix from matched paths.
  const ocfRoot = (_state.ocfFolder || '').replace(/\\/g, '/').replace(/\/+$/, '');

  for (let i = 0; i < _state.matchResults.length; i++) {
    const row = _state.normalisedRows?.[i] || {};
    const sourcePath = (
      row.sourcePath ||
      _state.matchResults[i]?.match?.matchedPath ||
      _state.matchResults[i]?.ocf?.path ||
      ''
    ).replace(/\\/g, '/');
    if (!sourcePath) continue;

    let shotName = '';
    let shotRoot = '';

    if (ocfRoot && sourcePath.startsWith(ocfRoot + '/')) {
      // Primary: strip the OCF root prefix; the first path component is the shot folder.
      const rel = sourcePath.slice(ocfRoot.length + 1);
      const slashIdx = rel.indexOf('/');
      if (slashIdx > 0) {
        shotName = rel.slice(0, slashIdx);
      } else {
        // File is directly in ocfRoot (flat structure) — use filename stem.
        shotName = rel.replace(/\.[^.]+$/, '');
      }
      shotRoot = `${ocfRoot}/${shotName}`;
    } else {
      // Fallback: infer shot root from path depth.
      //   QT/MOV/MXF  →  <shot_root>/QT_Files/<clip>              → 2 levels up
      //   EXR frame   →  <shot_root>/EXR_Files/<shot_name>/<frame> → 3 levels up
      const parts = sourcePath.split('/');
      const isExr = /\.exr$/i.test(parts[parts.length - 1] || '');
      const upLevels = isExr ? 3 : 2;
      if (parts.length < upLevels + 1) continue;
      const rootParts = parts.slice(0, parts.length - upLevels);
      shotRoot = rootParts.join('/');
      shotName = rootParts[rootParts.length - 1];
    }

    if (!shotName || seen.has(shotRoot)) continue;
    seen.add(shotRoot);

    shots.push({
      shotName,
      exrFolder: `${shotRoot}/EXR_Files/${shotName}`,
      amfPath:   `${shotRoot}/EXR_Files/Look_Files/${shotName}.amf`,
    });
  }
  return shots;
}

window.__vfxPullExportExr = async function() {
  const shots = _collectExrDeliveryShots();
  if (!shots.length) {
    alert('No linked EXR shots found.\nLink OCF sources in VFX Pull first, then export.');
    return;
  }

  let outputDir = _settings.outputFolder || '';
  if (!outputDir) {
    let picked;
    try { picked = await nativePickFolder('Select EXR export destination'); }
    catch { picked = null; }
    const pickedData = _nativePayload(picked);
    if (!pickedData?.path && !pickedData?.folderPath) return;
    outputDir = pickedData.path || pickedData.folderPath;
  }

  _setStatus(`Copying ${shots.length} EXR shot${shots.length !== 1 ? 's' : ''}…`);
  let res;
  try {
    res = await nativeCopyExrDelivery(shots, outputDir);
  } catch (err) {
    _setStatus('EXR copy failed');
    alert(`EXR export failed:\n${err?.message || err}`);
    return;
  }

  const resData = res?.data || res?.result || res || {};
  const failed = (resData?.results || []).filter(r => !r.ok);
  if (failed.length) {
    _setStatus(`EXR copy done — ${failed.length} error(s)`);
    alert(`EXR export finished with ${failed.length} error(s):\n${failed.map(r => `${r.shotName}: ${r.error}`).join('\n')}`);
  } else {
    const total = (resData?.results || []).length;
    _setStatus(`EXR export done — ${total} shot${total !== 1 ? 's' : ''}`);
    try { await nativeOpenOutputFolder(outputDir); } catch {}
  }
};

window.__vfxPullExportNuke = async function() {
  await _exportNuke();
};

window.__vfxPullExportVfxPackage = async function(opts = {}) {
  await _exportVfxPackage(opts);
};
