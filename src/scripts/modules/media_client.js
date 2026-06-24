'use strict';

/**
 * media_client.js — Renderer-side wrapper for the PostFlowX Media Engine.
 *
 * Wraps window.pfxPlatform.media (Electron only) and exposes a clean,
 * ergonomic API for VFX Pull and other panels.
 *
 * In the Chrome extension, all calls reject with { ok: false, reason: 'not_electron' }.
 * Use isAvailable() to gate features before calling.
 */

// ─── Environment detection ────────────────────────────────────────────────────

const _isElectron = !!(typeof window !== 'undefined' && window.pfxPlatform?.isMacApp && window.pfxPlatform?.media);
const _api        = _isElectron ? window.pfxPlatform.media : null;

/** True when running in the Electron app with media engine available. */
function isAvailable() { return _isElectron; }

function _notAvailable(name) {
  const e = new Error(`media_client.${name}: not available (Chrome extension or media engine missing)`);
  e.code = 'NOT_AVAILABLE';
  return Promise.reject(e);
}

// ─── Player lifecycle ─────────────────────────────────────────────────────────

/**
 * Open a media file and return a player session.
 *
 * @param {object} opts
 * @param {string}  opts.path        Absolute file path
 * @param {string}  [opts.role]      "qtRef" (default) | "ocf"
 * @param {number}  [opts.startFrame]
 * @returns {Promise<{
 *   playerId: string,
 *   info: object,
 *   srcUrl: string|null,
 *   requiresTranscode: boolean
 * }>}
 *
 * When requiresTranscode is true (ProRes), srcUrl is null.
 * Use the Python HTTP streaming server for playback.
 * When false, use pfxPlatform.media.srcUrl(path) directly as <video src>.
 */
function openPlayer(opts = {}) {
  if (!_api) return _notAvailable('openPlayer');
  return _api.openPlayer(opts);
}

/** Close a player session, releasing cached assets. */
function closePlayer(playerId) {
  if (!_api) return _notAvailable('closePlayer');
  return _api.closePlayer({ playerId });
}

// ─── Transport controls ───────────────────────────────────────────────────────

/** Start playback. */
function play(playerId) {
  if (!_api) return _notAvailable('play');
  return _api.play({ playerId });
}

/** Pause playback. */
function pause(playerId) {
  if (!_api) return _notAvailable('pause');
  return _api.pause({ playerId });
}

/**
 * Seek to a position.
 * @param {string} playerId
 * @param {object} pos  { frame? } or { timecode? } or { seconds? }
 */
function seek(playerId, pos = {}) {
  if (!_api) return _notAvailable('seek');
  return _api.seek({ playerId, ...pos });
}

/**
 * Step one frame forward or backward.
 * @param {string} playerId
 * @param {number} [delta=1]  +1 forward, -1 backward
 */
function stepFrame(playerId, delta = 1) {
  if (!_api) return _notAvailable('stepFrame');
  return _api.stepFrame({ playerId, delta });
}

// ─── Media info ───────────────────────────────────────────────────────────────

/**
 * Get media info for a file (duration, codec, fps, dimensions, etc.).
 * @param {string} filePath  Absolute path
 * @returns {Promise<{
 *   ok: boolean, path: string, duration: number, fps: number,
 *   width: number, height: number, frameCount: number,
 *   codec: string, isProRes: boolean, hasAudio: boolean, hwDecode: boolean
 * }>}
 */
function getInfo(filePath) {
  if (!_api) return _notAvailable('getInfo');
  return _api.getInfo({ path: filePath });
}

// ─── Still extraction ─────────────────────────────────────────────────────────

/**
 * Extract a single still frame from a QT Ref file (H.264/HEVC/MOV/ProRes).
 *
 * @param {object} opts
 * @param {string}  opts.path          Absolute file path
 * @param {number}  [opts.frame]       Frame number (0-based)
 * @param {string}  [opts.timecode]    "HH:MM:SS:FF" — takes priority over frame
 * @param {number}  [opts.outputWidth] Max width in pixels (default 960)
 * @param {number}  [opts.quality]     JPEG quality 0–1 (default 0.88)
 * @returns {Promise<{ ok: boolean, dataUrl: string, imageDataUrl: string, frame: number, decoder: string }>}
 */
function getStill(opts = {}) {
  if (!_api) return _notAvailable('getStill');
  return _api.getStill(opts);
}

/**
 * Extract still from an OCF file.
 * Tries: Resolve Engine → AVFoundation → FFmpeg (3-tier fallback).
 *
 * @param {object} opts
 * @param {string}  opts.ocfPath         Absolute OCF file path
 * @param {string}  [opts.sourceTc]      "HH:MM:SS:FF"
 * @param {number}  [opts.sourceFrame]   Fallback if no timecode
 * @param {number}  [opts.outputWidth]
 * @param {string}  [opts.colorPreviewMode]  "SDR" | "HDR" | "FULL" | "TRIM"
 * @returns {Promise<{
 *   ok: boolean, decoder: string, extractor: string,
 *   dataUrl: string, imageDataUrl: string
 * }>}
 */
function getOcfStill(opts = {}) {
  if (!_api) return _notAvailable('getOcfStill');
  return _api.getOcfStill(opts);
}

// ─── Hero frames ──────────────────────────────────────────────────────────────

/**
 * Extract 7 hero frames for a shot from a QT Ref file.
 * Points: handleStart, cutIn, 25%, 50%, 75%, cutOut, handleEnd.
 *
 * @param {object} opts
 * @param {string}   opts.path           Absolute file path
 * @param {string}   [opts.playerId]     Existing player session (skips re-open)
 * @param {Array}    [opts.frames]       Override frame specs (label + frame/timecode pairs)
 * @param {number}   [opts.outputWidth]
 * @returns {Promise<{
 *   ok: boolean,
 *   decoder: string,
 *   frames: Array<{ ok: boolean, label: string, frame: number, dataUrl: string, decoder: string }>
 * }>}
 */
function getHeroFrames(opts = {}) {
  if (!_api) return _notAvailable('getHeroFrames');
  return _api.getHeroFrames(opts);
}

// ─── Convenience helpers ──────────────────────────────────────────────────────

/**
 * Build a pfx-media:// URL for direct <video> playback (H.264/HEVC only).
 * Returns null in the Chrome extension or if path is empty.
 * For ProRes, use the HTTP streaming server instead.
 *
 * @param {string} filePath  Absolute path
 * @returns {string|null}
 */
function srcUrl(filePath) {
  if (!_api) return null;
  return _api.srcUrl(filePath);
}

/**
 * True if the file should use pfx-media:// directly (non-ProRes containers).
 * False means the caller should route through the HTTP streaming server.
 *
 * @param {object} info  Result from getInfo()
 */
function canStream(info) {
  if (!info) return false;
  return !info.isProRes;
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/**
 * Get media engine diagnostics.
 * @returns {Promise<{
 *   avfBridgeReady: boolean,
 *   resolveConnected: boolean,
 *   ffmpegAvailable: boolean,
 *   platform: string,
 *   avfBridgePath: string
 * }>}
 */
function diagnostics() {
  if (!_api) return _notAvailable('diagnostics');
  return _api.diagnostics();
}

// ─── Exports ──────────────────────────────────────────────────────────────────

const MediaClient = {
  isAvailable,
  openPlayer,
  closePlayer,
  play,
  pause,
  seek,
  stepFrame,
  getInfo,
  getStill,
  getOcfStill,
  getHeroFrames,
  srcUrl,
  canStream,
  diagnostics,
};

// Support both module.exports (background.js / Node) and window assignment (panel scripts).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MediaClient;
} else {
  window.MediaClient = MediaClient;
}
