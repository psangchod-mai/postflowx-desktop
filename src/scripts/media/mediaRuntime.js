// scripts/media/mediaRuntime.js
// Public API for the PostFlowX shared media runtime.
// All tabs call this module — never talk to the bridge or session store directly.
//
// Usage:
//   import { openMedia, getPreviewFrame, getMediaBackendStatus } from './media/mediaRuntime.js';

import { sendMediaCommand, getHelperCapabilities } from './mediaBridge.js';
import {
  createSession, getSession, updateSession, closeSession,
  generateSessionId, getSessionByPath,
} from './mediaSessionStore.js';
import { classifyFile } from './mediaBackendRegistry.js';
import { normalizeDiagnostics } from './mediaDiagnostics.js';
import { ERROR_CODE, DECODE_QUALITY } from './mediaTypes.js';
import { cacheGet, cachePut, cacheEvictSession } from './mediaFrameCache.js';

// ── openMedia ──────────────────────────────────────────────────────────────────
/**
 * Open a media file and return a session handle.
 * Runtime decides which backend to use — tabs never route backends themselves.
 *
 * @param {string} filePath
 * @param {Object} [options]
 * @param {boolean} [options.reuseSession=true]  - reuse existing session for same path
 * @param {string}  [options.quality]            - DECODE_QUALITY hint
 * @returns {Promise<MediaSession>}
 */
export async function openMedia(filePath, options = {}) {
  if (!filePath) throw _err(ERROR_CODE.BAD_REQUEST, 'filePath is required');

  // Reuse existing live session for the same path
  if (options.reuseSession !== false) {
    const existing = getSessionByPath(filePath);
    if (existing) return existing;
  }

  const { backend: preferredBackend } = classifyFile(filePath, options);

  // Ask companion to open the file (companion owns backend selection)
  const data = await sendMediaCommand('mediaOpenFile', {
    path:            filePath,
    preferredBackend,
    quality:         options.quality ?? DECODE_QUALITY.FULL,
  });

  const sessionId = data.sessionId ?? generateSessionId();
  const record = {
    sessionId,
    filePath,
    fileType:        data.fileType        ?? '',
    backend:         data.backend         ?? preferredBackend,
    capabilities:    data.capabilities    ?? {},
    metadata:        data.metadata        ?? {},
    cacheState:      'ready',
    lastError:       null,
    // Playback + decode capability flags from companion
    canPlay:         data.canPlay         ?? false,
    framesDecodable: data.framesDecodable ?? true,
    streamUrl:       data.streamUrl       ?? '',
    // Helper-side asset ID for thumbnail/frame commands
    _assetId:        data.assetId         ?? null,
  };
  createSession(sessionId, record);
  return getSession(sessionId);
}

// ── closeMedia ─────────────────────────────────────────────────────────────────
/**
 * Close a media session and free helper-side resources.
 * @param {string} sessionId
 */
export async function closeMedia(sessionId) {
  const s = getSession(sessionId);
  if (!s) return;
  try {
    await sendMediaCommand('mediaCloseFile', { sessionId, assetId: s._assetId });
  } catch { /* ignore — session may already be gone on helper */ }
  cacheEvictSession(sessionId);   // Phase 7: evict JS in-memory cache
  closeSession(sessionId);
}

// ── getMediaMetadata ───────────────────────────────────────────────────────────
/**
 * Return metadata for an open session.
 * Returns cached data if available; refreshes from helper on cache miss.
 * @param {string} sessionId
 * @returns {Promise<MediaMetadata>}
 */
export async function getMediaMetadata(sessionId) {
  const s = getSession(sessionId);
  if (!s) throw _err(ERROR_CODE.SESSION_NOT_FOUND, `No session: ${sessionId}`);
  if (s.metadata && Object.keys(s.metadata).length) return s.metadata;

  const data = await sendMediaCommand('mediaGetMetadata', {
    sessionId,
    assetId: s._assetId,
  });
  updateSession(sessionId, { metadata: data });
  return data;
}

// ── getPreviewFrame ────────────────────────────────────────────────────────────
/**
 * Request a decoded preview frame as a data URL or temp-file path.
 * MVP: still-frame decode only.
 *
 * @param {string} sessionId
 * @param {number} frameIndex
 * @param {Object} [options]
 * @param {string} [options.quality]  - DECODE_QUALITY hint
 * @param {string} [options.format]   - 'jpg'|'png'
 * @param {number} [options.width]
 * @param {number} [options.height]
 * @returns {Promise<PreviewFrameResult>}
 */
export async function getPreviewFrame(sessionId, frameIndex, options = {}) {
  const s = getSession(sessionId);
  if (!s) throw _err(ERROR_CODE.SESSION_NOT_FOUND, `No session: ${sessionId}`);

  const quality = options.quality ?? DECODE_QUALITY.HALF;
  const width   = options.width   ?? 1280;
  const height  = options.height  ?? 720;
  const format  = options.format  ?? 'jpg';
  const fi      = Math.max(0, Math.round(frameIndex));

  // Phase 7: check JS in-memory cache first (fastest path — no IPC round-trip)
  const cached = cacheGet(sessionId, fi, quality, width, height, format);
  if (cached) return { ...cached, cacheHit: true };

  // Companion decode (checks disk LRU cache, then decodes if miss)
  const result = await sendMediaCommand('mediaGetFrame', {
    sessionId,
    assetId:    s._assetId,
    frameIndex: fi,
    quality,
    format,
    width,
    height,
  }, 60_000);

  // Populate JS cache with result
  if (result?.dataUrl) {
    cachePut(sessionId, fi, result, { quality, width, height, format });
  }
  return result;
}

// ── seekMedia ──────────────────────────────────────────────────────────────────
/**
 * Seek to a frame index (no decode — just position update).
 * @param {string} sessionId
 * @param {number} frameIndex
 */
export async function seekMedia(sessionId, frameIndex) {
  const s = getSession(sessionId);
  if (!s) throw _err(ERROR_CODE.SESSION_NOT_FOUND, `No session: ${sessionId}`);
  return sendMediaCommand('mediaSeekFrame', {
    sessionId,
    assetId:    s._assetId,
    frameIndex: Math.max(0, Math.round(frameIndex)),
  });
}

// ── playMedia / pauseMedia ─────────────────────────────────────────────────────
export async function playMedia(sessionId, options = {}) {
  const s = getSession(sessionId);
  if (!s) throw _err(ERROR_CODE.SESSION_NOT_FOUND, `No session: ${sessionId}`);
  return sendMediaCommand('mediaPlay', { sessionId, assetId: s._assetId, ...options });
}

export async function pauseMedia(sessionId) {
  const s = getSession(sessionId);
  if (!s) throw _err(ERROR_CODE.SESSION_NOT_FOUND, `No session: ${sessionId}`);
  return sendMediaCommand('mediaPause', { sessionId, assetId: s._assetId });
}

// ── getMediaBackendStatus ─────────────────────────────────────────────────────
/**
 * Get normalized diagnostics for all backends.
 * @returns {Promise<MediaDiagnostics>}
 */
export async function getMediaBackendStatus() {
  try {
    const caps = await getHelperCapabilities();
    return normalizeDiagnostics(caps);
  } catch (e) {
    return normalizeDiagnostics(null);
  }
}

// ── getMediaCapabilities ───────────────────────────────────────────────────────
/**
 * Return capabilities for a specific open session (cached from open).
 * @param {string} sessionId
 */
export function getMediaCapabilities(sessionId) {
  const s = getSession(sessionId);
  if (!s) return null;
  return s.capabilities ?? {};
}

// ── helpers ────────────────────────────────────────────────────────────────────
function _err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// Re-export types for convenience
export { BACKEND, FORMAT, ERROR_CODE, DECODE_QUALITY, BACKEND_STATUS } from './mediaTypes.js';
export { classifyFile, backendLabel } from './mediaBackendRegistry.js';
export { normalizeDiagnostics, getStatusLabel } from './mediaDiagnostics.js';
