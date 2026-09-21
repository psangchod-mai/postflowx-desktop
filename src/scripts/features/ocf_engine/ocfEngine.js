'use strict';
/**
 * OCF Playback Engine — main orchestration module.
 *
 * Handles: scan → probe → engine selection → decode → play → proxy pipeline.
 * All companion calls go through pfxCompanion (action-based).
 */

const OCF_ENGINE_VERSION = '3.0';

// ── IPC bridge ───────────────────────────────────────────────────────────────

async function _companion(action, payload = {}) {
  if (window.pfxPlatform?.sendNativeCommand) {
    return window.pfxPlatform.sendNativeCommand({ action, ...payload });
  }
  if (window.pfxCompanion?.send) {
    return window.pfxCompanion.send({ action, ...payload });
  }
  throw new Error('No companion bridge available');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan a path for OCF clips.
 * @param {string} path — file, folder, or camera card root
 * @returns {Promise<{ok, root, clips, warnings, errors}>}
 */
export async function ocfScan(path) {
  return _companion('ocfScan', { path });
}

/**
 * Full metadata probe for a single OCF clip.
 * @param {string} clipPath
 * @returns {Promise<OcfProbeResult>}
 */
export async function ocfProbe(clipPath) {
  return _companion('ocfEngineProbe', { clipPath });
}

/**
 * Select the best OCF engine for a probed clip.
 * @param {OcfProbeResult} probe
 * @param {string} [forceEngine]
 * @returns {Promise<{engine, fallbackEngines, reason, sdkStatus}>}
 */
export async function ocfSelectEngine(probe, forceEngine) {
  return _companion('ocfSelectEngine', { probe, forceEngine });
}

/**
 * Decode a single frame from an OCF clip.
 * @param {string} clipPath
 * @param {object} opts — { frameNumber, scale, engine, probe }
 * @returns {Promise<OcfDecodeResult>}
 */
export async function ocfDecodeFrame(clipPath, opts = {}) {
  return _companion('ocfDecodeFrame', {
    clipPath,
    frameNumber: opts.frameNumber ?? 0,
    scale:       opts.scale       ?? 960,
    engine:      opts.engine      ?? 'auto',
    probe:       opts.probe       ?? {},
  });
}

/**
 * Full scan → probe → engine-select pipeline for a single clip.
 * Returns everything needed to drive the OCF viewer.
 * @param {string} clipPath
 * @returns {Promise<OcfOpenResult>}
 */
export async function ocfOpen(clipPath) {
  const [probeResult, selectResult] = await Promise.all([
    ocfProbe(clipPath),
    _companion('ocfPlay', { clipPath }),
  ]);
  return {
    clipPath,
    probe:        probeResult,
    engine:       selectResult?.engine       ?? 'ProxyEngine',
    fallbacks:    selectResult?.fallbackEngines ?? [],
    playbackMode: selectResult?.playbackMode  ?? 'smart_proxy',
    colorBadge:   selectResult?.colorBadge    ?? { label: 'Unknown / Technical Preview', technical: true },
  };
}

/**
 * Start async proxy generation.
 * @param {string} clipPath
 * @param {object} opts — { scale, timecodeStart, outputDir }
 * @returns {Promise<{jobId}>}
 */
export async function ocfGenerateProxy(clipPath, opts = {}) {
  return _companion('ocfGenerateProxy', { clipPath, ...opts });
}

/**
 * Poll proxy job status.
 * @param {string} jobId
 * @returns {Promise<{state, pct, result}>}
 */
export async function ocfProxyJobStatus(jobId) {
  return _companion('ocfProxyJobStatus', { jobId });
}

/**
 * Get OCF engine status rows for Settings panel.
 * @returns {Promise<{rows}>}
 */
export async function ocfEngineStatus() {
  return _companion('ocfEngineStatus', {});
}

/**
 * Force-refresh SDK detection cache.
 * @returns {Promise<{rows}>}
 */
export async function ocfRefreshEngines() {
  return _companion('ocfRefreshEngines', {});
}

/**
 * Get recent OCF engine logs.
 * @param {number} [maxBytes=65536]
 * @returns {Promise<{logs}>}
 */
export async function ocfShowLogs(maxBytes = 65536) {
  return _companion('ocfShowLogs', { maxBytes });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export const ENGINE_LABELS = {
  NativeAVFoundationEngine: 'AVFoundation',
  BRAWSDKEngine:            'BRAW SDK',
  REDSDKEngine:             'RED SDK',
  ARRISDKEngine:            'ARRI SDK',
  CanonRawSDKEngine:        'Canon RAW SDK',
  MPVEngine:                'MPV',
  FFmpegFrameServer:        'FFmpeg',
  ResolveEngine:            'Resolve',
  ProxyEngine:              'Proxy',
};

export const PLAYBACK_MODE_LABELS = {
  direct:           'Direct Playback',
  frame_server:     'Frame Server Preview',
  resolve_assisted: 'Resolve Assisted Preview',
  smart_proxy:      'Smart Proxy',
};

export function engineLabel(engine) {
  return ENGINE_LABELS[engine] ?? engine ?? 'Unknown';
}

export function playbackModeLabel(mode) {
  return PLAYBACK_MODE_LABELS[mode] ?? mode ?? '';
}

/** Human-readable clip summary line (Camera • Format • Resolution • FPS) */
export function clipSummary(probe) {
  if (!probe) return '';
  const parts = [];
  if (probe.cameraFamily) parts.push(probe.cameraFamily);
  if (probe.format)       parts.push(probe.format);
  if (probe.width && probe.height) parts.push(`${probe.width}×${probe.height}`);
  if (probe.fps?.display) parts.push(`${probe.fps.display} fps`);
  return parts.join(' • ');
}
