// scripts/media/mediaBackendRegistry.js
// Extension-side backend routing: classifies a file path → backend key.
// Routing is centralized here. Tabs never route backends themselves.

import { BACKEND, FORMAT } from './mediaTypes.js';

// Extension mapping: file extension → { format, preferredBackend, fallbackBackend }
const _EXT_MAP = {
  // Standard browser-decodable
  '.mp4':  { format: FORMAT.MP4,   backend: BACKEND.STANDARD_MEDIA,    fallback: null },
  '.m4v':  { format: FORMAT.MP4,   backend: BACKEND.STANDARD_MEDIA,    fallback: null },
  '.webm': { format: FORMAT.WEBM,  backend: BACKEND.STANDARD_MEDIA,    fallback: null },
  '.mkv':  { format: FORMAT.MKV,   backend: BACKEND.STANDARD_MEDIA,    fallback: null },

  // ProRes — try standard first; fall back to native if standard is insufficient
  '.mov':  { format: FORMAT.MOV,   backend: BACKEND.STANDARD_MEDIA,    fallback: BACKEND.PRORES_NATIVE },

  // Camera originals — require SDK backends
  '.braw': { format: FORMAT.BRAW,  backend: BACKEND.BRAW_SDK,          fallback: null },
  '.r3d':  { format: FORMAT.R3D,   backend: BACKEND.R3D_SDK,           fallback: null },
  '.mxf':  { format: FORMAT.MXF,   backend: BACKEND.STANDARD_MEDIA,    fallback: null },
  '.arx':  { format: FORMAT.ARX,   backend: BACKEND.ARRI_SDK,          fallback: BACKEND.ARRI_TOOL_BRIDGE },
  '.ari':  { format: FORMAT.ARI,   backend: BACKEND.ARRI_SDK,          fallback: BACKEND.ARRI_TOOL_BRIDGE },

  // ProRes RAW
  '.mov|prores_raw': { format: FORMAT.PRORES_RAW, backend: BACKEND.PRORES_RAW_NATIVE, fallback: null },
};

/**
 * Classify a file path and return the preferred backend + fallback.
 * @param {string} filePath
 * @param {Object} [hints]  - optional: { isProResRaw: bool, codec: string }
 * @returns {{ format: string, backend: string, fallback: string|null }}
 */
export function classifyFile(filePath, hints = {}) {
  const lower = String(filePath || '').toLowerCase();
  const ext   = lower.match(/\.[^.]+$/)?.[0] ?? '';

  // ProRes RAW detection (codec hint from metadata)
  if (ext === '.mov' && hints.codec?.toLowerCase?.().includes('prores_raw')) {
    return { format: FORMAT.PRORES_RAW, backend: BACKEND.PRORES_RAW_NATIVE, fallback: BACKEND.STANDARD_MEDIA };
  }

  const entry = _EXT_MAP[ext];
  if (!entry) {
    return { format: ext.slice(1) || 'unknown', backend: BACKEND.STANDARD_MEDIA, fallback: null };
  }
  return { ...entry };
}

/**
 * Returns true when a backend key requires an external SDK to be installed.
 * Note: BRAW_SDK is available when DaVinci Resolve is installed (Phase 3+).
 */
export function requiresSdk(backendKey) {
  return [BACKEND.BRAW_SDK, BACKEND.R3D_SDK, BACKEND.ARRI_SDK].includes(backendKey);
}

/**
 * Returns true when BRAW files should be routed to the native backend
 * (as opposed to falling back to standard_media for container metadata only).
 * @param {Object} diag  - result of getMediaBackendStatus()
 */
export function isBrawReady(diag) {
  return diag?.backends?.[BACKEND.BRAW_SDK]?.status === 'ready';
}

/**
 * Returns true when the backend is architecture-ready but deferred.
 */
export function isDeferred(backendKey) {
  return [BACKEND.ARRI_SDK, BACKEND.ARRI_TOOL_BRIDGE].includes(backendKey);
}

/**
 * Human-readable label for UI display.
 */
export function backendLabel(backendKey) {
  const labels = {
    [BACKEND.STANDARD_MEDIA]:    'Standard Media',
    [BACKEND.PRORES_NATIVE]:     'Apple ProRes',
    [BACKEND.PRORES_RAW_NATIVE]: 'ProRes RAW',
    [BACKEND.BRAW_SDK]:          'Blackmagic RAW',
    [BACKEND.R3D_SDK]:           'RED R3D',
    [BACKEND.ARRI_SDK]:          'ARRI SDK',
    [BACKEND.ARRI_TOOL_BRIDGE]:  'ARRI Bridge',
  };
  return labels[backendKey] ?? backendKey;
}
