'use strict';

/**
 * smart_playback_engine.js — Renderer-side Smart Media Playback Engine client
 *
 * Wraps pfxPlatform.smartMedia (Electron) and the companion HTTP API
 * (Chrome extension) into a single, consistent interface.
 *
 * Usage:
 *   import * as SmartEngine from './smart_playback_engine.js';
 *   const classification = await SmartEngine.probe('/path/to/clip.mov');
 *   const frame = await SmartEngine.decodeFrame({ path: '/path/to/clip.mov', frameNumber: 48 });
 */

// ── Platform detection ────────────────────────────────────────────────────────

const IS_ELECTRON = !!(
  typeof window !== 'undefined' &&
  window.__PFX_IS_ELECTRON &&
  window.pfxPlatform?.smartMedia
);

// ── Chrome extension companion HTTP helper ────────────────────────────────────

async function _companionPost(endpoint, body) {
  const { getCompanionUrl, getCompanionToken } = await _companionConfig();
  const url = `${getCompanionUrl}${endpoint}`;
  const resp = await fetch(url, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-PFX-Token':  getCompanionToken,
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Companion HTTP ${resp.status} for ${endpoint}`);
  }
  return resp.json();
}

async function _companionConfig() {
  // Read fresh every call: the companion can mint a new token on restart, or
  // the user can repoint the URL in Settings, while this module stays loaded.
  const stored = (typeof pfxStorage !== 'undefined' && pfxStorage?.get)
    ? await pfxStorage.get(['companionUrl', 'companionToken'])
    : {};
  return {
    getCompanionUrl:   stored.companionUrl   || 'http://127.0.0.1:47125',
    getCompanionToken: stored.companionToken || '',
  };
}

// ── Unified dispatch ──────────────────────────────────────────────────────────

async function _call(electronMethod, companionEndpoint, payload = {}) {
  if (IS_ELECTRON) {
    return window.pfxPlatform.smartMedia[electronMethod](payload);
  }
  return _companionPost(companionEndpoint, payload);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Probe a media path and return full classification.
 * @param {string} filePath  - Absolute path to file or folder (IMF)
 * @param {object} [opts]    - { context?, timelineFps?, timecodeBase? }
 * @returns {Promise<ProbeResult>}
 */
export async function probe(filePath, opts = {}) {
  return _call('probe', '/api/media/probe', { path: filePath, ...opts });
}

/**
 * Ask the router which engine to use for a given media classification.
 * @param {object} classification  - Output of probe() or equivalent
 * @param {string} [userOverride]  - Force a specific engine
 * @returns {Promise<{ok, engine, fallbacks, reason}>}
 */
export async function selectEngine(classification, userOverride = null) {
  return _call('selectEngine', '/api/media/select-engine', {
    ...classification,
    userOverride,
  });
}

/**
 * Decode a single frame to an image file.
 * @param {object} args
 *   path, frameNumber, fps, scale?, outputFormat?, sequenceInfo?
 * @returns {Promise<{ok, imagePath, frameNumber, engine, command, stderr}>}
 */
export async function decodeFrame(args) {
  return _call('decodeFrame', '/api/media/decode-frame', args);
}

/**
 * Return status of all installed engines (AVFoundation, FFmpeg, MPV, IMF, etc.)
 * @returns {Promise<{ok, engines: EngineRow[]}>}
 */
export async function getEngineStatus() {
  if (IS_ELECTRON) {
    return window.pfxPlatform.smartMedia.status();
  }
  return _companionPost('/api/media/status', {});
}

/**
 * Return tail of all 4 structured log files (playback, imf, proxy, resolve).
 * @param {number} [lines=200]
 * @returns {Promise<{ok, logs: {playback, imf, proxy, resolve}}>}
 */
export async function showLogs(lines = 200) {
  return _call('showLogs', '/api/media/show-logs', { lines });
}

/**
 * Start async proxy transcoding. Poll companion session for progress.
 * @param {object} args  sourcePath, outputDir, sessionId, codec?, scale?, fps?
 * @returns {Promise<{ok, sessionId}>}
 */
export async function transcodeProxy(args) {
  return _call('transcodeProxy', '/api/media/transcode-proxy', args);
}

// ── IMF ───────────────────────────────────────────────────────────────────────

/**
 * Open and scan an IMF package folder.
 * @param {string} folderPath
 * @returns {Promise<{ok, folder, cplList, playableReels, warnings, errors}>}
 */
export async function imfOpen(folderPath) {
  return _call('imfOpen', '/api/imf/open', { folderPath });
}

/**
 * Probe a CPL via ffprobe -f imf.
 * @param {string} cplPath
 * @param {string[]} assetMapPaths
 * @returns {Promise}
 */
export async function imfProbeCpl(cplPath, assetMapPaths = []) {
  return _call('imfProbeCpl', '/api/imf/probe-cpl', { cplPath, assetMapPaths });
}

/**
 * Decode a test frame from an IMF CPL (3-tier fallback: ffmpeg-f-imf → MXF → ojph).
 * @param {object} args  cplPath, assetMapPaths, frameNumber?, scale?
 * @returns {Promise<{ok, imagePath, imageDataUrl?, engine, codec, …}>}
 */
export async function imfDecodeTestFrame(args) {
  return _call('imfDecodeTestFrame', '/api/imf/decode-test-frame', args);
}

// ── Resolve ───────────────────────────────────────────────────────────────────

/**
 * Check DaVinci Resolve availability via companion.
 * @returns {Promise<{ok, available, version}>}
 */
export async function resolveStatus() {
  if (IS_ELECTRON) {
    return window.pfxPlatform.smartMedia.resolveStatus();
  }
  return _companionPost('/api/resolve/status', {});
}

// ── Convenience: full probe + route ──────────────────────────────────────────

/**
 * Probe a file and immediately select the best engine.
 * Returns both classification and routing decision merged.
 * @param {string} filePath
 * @param {object} [opts]
 * @returns {Promise<ClassifyAndRouteResult>}
 */
export async function classifyAndRoute(filePath, opts = {}) {
  const probeResult = await probe(filePath, opts);
  if (!probeResult?.ok) {
    return {
      ok: false,
      probeResult,
      engine: null,
      fallbacks: [],
      reason: probeResult?.error || 'probe failed',
    };
  }
  const routing = await selectEngine(probeResult, opts.userOverride || null);
  return {
    ok: true,
    ...probeResult,
    engine:    routing.engine    || probeResult.recommendedEngine,
    fallbacks: routing.fallbacks || probeResult.fallbackEngines || [],
    reason:    routing.reason    || probeResult.routingReason   || '',
    routing,
  };
}

// ── Engine badge helpers ──────────────────────────────────────────────────────

const ENGINE_LABELS = {
  avfoundation: 'AVFoundation',
  mpv:          'MPV',
  ffmpeg:       'FFmpeg',
  imf:          'IMF',
  imagesequence:'Image Seq',
  resolve:      'Resolve',
  proxy:        'Proxy',
  browser:      'Browser',
};

const ENGINE_COLORS = {
  avfoundation: '#2ecc71',
  mpv:          '#3498db',
  ffmpeg:       '#e67e22',
  imf:          '#9b59b6',
  imagesequence:'#1abc9c',
  resolve:      '#e74c3c',
  proxy:        '#95a5a6',
  browser:      '#bdc3c7',
};

/**
 * Render an engine/codec/mode badge string for display in viewer overlays.
 * @param {object} state  { engine, codec, mode, status }
 * @returns {string}
 */
export function formatBadge({ engine = '', codec = '', mode = '', status = '' } = {}) {
  const label = ENGINE_LABELS[engine?.toLowerCase()] || engine || 'Unknown';
  const parts = [label];
  if (codec)  parts.push(codec);
  if (mode)   parts.push(mode);
  if (status && status !== 'ok') parts.push(status.toUpperCase());
  return parts.join(' · ');
}

/**
 * Return badge color for a given engine ID.
 * @param {string} engine
 * @returns {string}  CSS hex color
 */
export function engineColor(engine = '') {
  return ENGINE_COLORS[engine?.toLowerCase()] || '#7f8c8d';
}

/**
 * Build the full badge data object for a viewer.
 * @param {object} probeOrRoute  - Output of probe() or classifyAndRoute()
 * @param {string} [mode]        - 'Direct' | 'FrameServer' | 'Proxy' | 'Failed'
 * @returns {BadgeData}
 */
export function buildBadge(probeOrRoute, mode = '') {
  const engine  = probeOrRoute?.engine || probeOrRoute?.recommendedEngine || '';
  const codec   = probeOrRoute?.codec  || '';
  const status  = probeOrRoute?.ok ? '' : 'error';
  return {
    engine,
    engineLabel: ENGINE_LABELS[engine?.toLowerCase()] || engine,
    engineColor: engineColor(engine),
    codec,
    mode,
    status,
    text: formatBadge({ engine, codec, mode, status }),
    routingReason: probeOrRoute?.routingReason || probeOrRoute?.reason || '',
  };
}

// ── Failure action helpers ────────────────────────────────────────────────────

/**
 * Build the list of user actions for a playback failure.
 * Always returns at least one action per non-negotiable rule #10.
 * @param {object} failure  { engine, code, canProxy, canInstall, logsAvailable }
 * @returns {Action[]}
 */
export function buildFailureActions({ engine = '', code = '', canProxy = true, canInstall = false, logsAvailable = true } = {}) {
  const actions = [];

  actions.push({ id: 'retry',  label: 'Retry',      icon: '↻' });
  if (canProxy) {
    actions.push({ id: 'proxy', label: 'Generate Proxy', icon: '⬇' });
  }
  if (logsAvailable) {
    actions.push({ id: 'logs',  label: 'View Logs',  icon: '📋' });
  }
  if (canInstall || code === 'ENGINE_MISSING' || code === 'FFMPEG_MISSING') {
    actions.push({ id: 'repair', label: 'Install / Repair Engines', icon: '🔧' });
  }

  // Engine-specific fallback options
  const engineLower = engine?.toLowerCase();
  if (engineLower !== 'avfoundation') {
    actions.push({ id: 'avfoundation', label: 'Play with AVFoundation', icon: '▶' });
  }
  if (engineLower !== 'mpv') {
    actions.push({ id: 'mpv', label: 'Play with MPV', icon: '▶' });
  }
  if (engineLower !== 'ffmpeg') {
    actions.push({ id: 'ffmpeg', label: 'Decode with FFmpeg', icon: '▶' });
  }
  if (engineLower !== 'resolve') {
    actions.push({ id: 'resolve', label: 'Open with Resolve Engine', icon: '▶' });
  }

  return actions;
}
