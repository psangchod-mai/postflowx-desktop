// scripts/media/mediaDiagnostics.js
// Normalizes helper/backend status into a unified diagnostics model.
// All tabs use this — never parse helper responses directly in UI code.

import { BACKEND, BACKEND_STATUS } from './mediaTypes.js';
import { backendLabel } from './mediaBackendRegistry.js';

// Re-export for convenience
export { backendLabel };

/**
 * Normalize the raw companion getCapabilities response into a clean diagnostics object.
 * @param {Object} caps  - data field from companion getCapabilities response
 * @returns {MediaDiagnostics}
 */
export function normalizeDiagnostics(caps) {
  if (!caps || typeof caps !== 'object') {
    return _unavailable('No capabilities data');
  }

  const features     = caps.features ?? {};
  const helperVer    = caps.version ?? caps.companionVersion ?? 'unknown';
  const platform     = caps.platform ?? 'unknown';
  const ffmpegOk     = !!(features.thumbnailGrab);
  const ffprobeOk    = !!(features.sourceTimecode);

  // Per-backend status
  const backends = _buildBackendStatuses(caps, features, ffmpegOk, ffprobeOk);

  const _atLeast = (key) => [
    BACKEND_STATUS.READY, BACKEND_STATUS.METADATA_ONLY, BACKEND_STATUS.PREVIEW_ONLY,
  ].includes(backends[key]?.status);

  return {
    helperInstalled:       true,
    helperVersion:         helperVer,
    platform,
    backends,
    proResSupported:       _atLeast(BACKEND.STANDARD_MEDIA) || _atLeast(BACKEND.PRORES_NATIVE),
    proResRawSupported:    _atLeast(BACKEND.PRORES_RAW_NATIVE),
    proResRawDecodeReady:  backends[BACKEND.PRORES_RAW_NATIVE]?.status === BACKEND_STATUS.READY,
    brawSupported:         backends[BACKEND.BRAW_SDK]?.status === BACKEND_STATUS.READY,
    r3dSupported:          _atLeast(BACKEND.R3D_SDK),
    r3dFullDecodeReady:    backends[BACKEND.R3D_SDK]?.status === BACKEND_STATUS.READY,
    arriSupported:         _atLeast(BACKEND.ARRI_SDK) || _atLeast(BACKEND.ARRI_TOOL_BRIDGE),
    arriDecodeReady:       backends[BACKEND.ARRI_SDK]?.status === BACKEND_STATUS.READY,
    lastError:             null,
  };
}

function _buildBackendStatuses(caps, features, ffmpegOk, ffprobeOk) {
  const raw = caps.backends ?? {};

  const _entry = (key, status, decodeMode, sdkVersion, lastError) => ({
    backend:     key,
    label:       backendLabel(key),
    status,
    decodeMode,
    sdkVersion:  sdkVersion ?? null,
    lastError:   lastError ?? null,
  });

  return {
    [BACKEND.STANDARD_MEDIA]: _entry(
      BACKEND.STANDARD_MEDIA,
      (ffmpegOk && ffprobeOk) ? BACKEND_STATUS.READY
        : ffprobeOk            ? BACKEND_STATUS.METADATA_ONLY
        : ffmpegOk             ? BACKEND_STATUS.PREVIEW_ONLY
                               : BACKEND_STATUS.UNAVAILABLE,
      ffmpegOk ? 'full' : 'none',
    ),

    [BACKEND.PRORES_NATIVE]: _entry(
      BACKEND.PRORES_NATIVE,
      _backendStatus(raw[BACKEND.PRORES_NATIVE]),
      raw[BACKEND.PRORES_NATIVE]?.decodeMode ?? 'none',
      raw[BACKEND.PRORES_NATIVE]?.version,
      raw[BACKEND.PRORES_NATIVE]?.lastError,
    ),

    [BACKEND.PRORES_RAW_NATIVE]: _entry(
      BACKEND.PRORES_RAW_NATIVE,
      _backendStatus(raw[BACKEND.PRORES_RAW_NATIVE]),
      raw[BACKEND.PRORES_RAW_NATIVE]?.decodeMode ?? 'none',
      raw[BACKEND.PRORES_RAW_NATIVE]?.version,
    ),

    [BACKEND.BRAW_SDK]: _entry(
      BACKEND.BRAW_SDK,
      _backendStatus(raw[BACKEND.BRAW_SDK]),
      raw[BACKEND.BRAW_SDK]?.decodeMode ?? 'none',
      raw[BACKEND.BRAW_SDK]?.version,
      raw[BACKEND.BRAW_SDK]?.lastError,
    ),

    [BACKEND.R3D_SDK]: _entry(
      BACKEND.R3D_SDK,
      _backendStatus(raw[BACKEND.R3D_SDK]),
      raw[BACKEND.R3D_SDK]?.decodeMode ?? 'none',
      raw[BACKEND.R3D_SDK]?.version,
      raw[BACKEND.R3D_SDK]?.lastError,
    ),

    [BACKEND.ARRI_SDK]: _entry(
      BACKEND.ARRI_SDK,
      BACKEND_STATUS.UNAVAILABLE,  // deferred
      'none',
    ),
  };
}

function _backendStatus(raw) {
  if (!raw) return BACKEND_STATUS.NOT_INSTALLED;
  if (raw.status) return raw.status;
  if (raw.ready === true)  return BACKEND_STATUS.READY;
  if (raw.sdkMissing)      return BACKEND_STATUS.SDK_MISSING;
  return BACKEND_STATUS.UNAVAILABLE;
}

function _unavailable(reason) {
  const na = k => ({
    backend: k, label: backendLabel(k),
    status: BACKEND_STATUS.NOT_INSTALLED,
    decodeMode: 'none', sdkVersion: null, lastError: reason,
  });
  return {
    helperInstalled:       false,
    helperVersion:         'unknown',
    platform:              'unknown',
    backends: Object.fromEntries(
      Object.values(BACKEND).map(k => [k, na(k)])
    ),
    proResSupported:       false,
    proResRawSupported:    false,
    proResRawDecodeReady:  false,
    brawSupported:         false,
    r3dSupported:          false,
    r3dFullDecodeReady:    false,
    arriSupported:         false,
    arriDecodeReady:       false,
    lastError: reason,
  };
}

/**
 * Returns a user-facing status label for a specific backend.
 */
export function getStatusLabel(backendKey, diag) {
  const b = diag?.backends?.[backendKey];
  if (!b) return 'Not installed';
  switch (b.status) {
    case BACKEND_STATUS.READY:         return `${b.label} — Ready`;
    case BACKEND_STATUS.PREVIEW_ONLY:  return `${b.label} — Preview only`;
    case BACKEND_STATUS.METADATA_ONLY: return `${b.label} — Metadata only`;
    case BACKEND_STATUS.SDK_MISSING:   return `${b.label} — SDK missing`;
    case BACKEND_STATUS.UNAVAILABLE:   return `${b.label} — Unavailable`;
    case BACKEND_STATUS.NOT_INSTALLED: return `${b.label} — Not installed`;
    default: return `${b.label} — ${b.status}`;
  }
}
