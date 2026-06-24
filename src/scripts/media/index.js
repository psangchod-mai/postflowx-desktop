// scripts/media/index.js
// Barrel export — tabs import from here, never from individual files directly.
export {
  openMedia,
  closeMedia,
  getMediaMetadata,
  getPreviewFrame,
  seekMedia,
  playMedia,
  pauseMedia,
  getMediaBackendStatus,
  getMediaCapabilities,
} from './mediaRuntime.js';

export { BACKEND, FORMAT, ERROR_CODE, DECODE_QUALITY, BACKEND_STATUS } from './mediaTypes.js';
export { classifyFile, backendLabel, requiresSdk, isDeferred, isBrawReady } from './mediaBackendRegistry.js';
export { normalizeDiagnostics, getStatusLabel } from './mediaDiagnostics.js';
export { isHelperReachable } from './mediaBridge.js';

// Phase 7: caching + playback
export { cacheGet, cachePut, cacheEvictSession, cacheStats } from './mediaFrameCache.js';
export { MediaPlaybackController } from './mediaPlaybackController.js';
