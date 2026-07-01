/**
 * scripts/core/playableMedia.js — Unified Playable Media Layer (PostFlowX)
 *
 * Single entry point for all local-file video playback.
 *
 * API:
 *   attachPlayableVideo(videoEl, file, opts)  — bind a File to a <video> with auto-proxy fallback
 *   ensurePlayableSource(file, opts)          — resolve the best URL for a File (no element needed)
 *   releasePlayableVideo(videoEl)             — tear down element state + release blob URL ref
 *
 * Internal behaviour:
 *   1. Blob URL lifecycle via mediaCache (ref-counted, eviction-safe).
 *   2. Cross-tab in-memory proxy cache is checked first — if another tab already proxied this
 *      file the stream URL is reused immediately with no re-upload.
 *   3. Direct playback is attempted first for non-MOV/MXF containers.
 *   4. loadVideoWithProxyFallback() from proResProxy handles the actual proxy logic:
 *      error event  → proxy immediately
 *      2 s probe    → proxy when Chrome shows no video frames (blind .mov)
 *   5. A monotonic load token on the element prevents stale callbacks from a previous load
 *      firing after releasePlayableVideo() or a subsequent attachPlayableVideo() call.
 *
 * Rules:
 *   - Original file is always the source of truth; proxy is playback-only.
 *   - Hidden analysis videos (VisualQC scan) must NOT call attachPlayableVideo — use
 *     ensurePlayableSource() instead so they never claim playback coordination.
 *   - Do not add a third backend path here.
 */

import { pfxAcquireObjectUrl, pfxReleaseObjectUrl } from './mediaCache.js';
import { sharedMediaOpen } from '../modules/native_helper_client.js';
import {
  getCachedProxyForFile,
  tryRestoreProxyForMeta,
  loadVideoWithProxyFallback,
} from '../modules/proResProxy.js';
import { selectEngine, ENGINE } from './playbackRouter.js';
import {
  NativeAVPlayerEngine,
  mountNativeCanvas,
  unmountNativeCanvas,
} from './nativeAVPlayer.js';
import { MPVPlayerEngine } from './mpvPlayer.js';

// ── Status labels (fed to the onStatus() callback) ────────────────────────────
export const PLAYABLE_STATUS = {
  preparing: 'Preparing playback…',
  direct:    'Playing original',
  proxy:     'Playing optimized proxy',
  proxying:  'Generating proxy…',
  native:    'Direct Playback',
};

// ── Element-state property keys (stored directly on the element) ──────────────
// Prefixed with _pfx to match existing proResProxy conventions.
const _K = {
  mode:    '_pfxPlayableMode',          // 'pending' | 'direct' | 'proxy' | 'restored-proxy'
  meta:    '_pfxPlayableOriginalMeta',  // { name, size, lastModified, type }
  session: '_pfxPlayableProxySession',  // proxy sessionId string
  blobUrl: '_pfxPlayableObjectUrl',     // the blob: URL we acquired (needs release)
  token:   '_pfxPlayableToken',         // monotonic counter — increment invalidates callbacks
};

// ── Capability probe element ──────────────────────────────────────────────────
let _probeEl = null;
function _getProbeEl() {
  if (_probeEl) return _probeEl;
  try { _probeEl = document.createElement('video'); } catch { _probeEl = null; }
  return _probeEl;
}

/**
 * Return true/false/'uncertain' indicating whether this file is likely to need
 * proxy transcoding before Chrome can play it.
 *
 *  true        — proxy almost certainly needed (MXF, BRAW, R3D)
 *  'uncertain' — QuickTime .mov; Chrome can read the container but may not decode
 *                the codec (ProRes, HEVC-Main10, etc.)
 *  false       — probably playable directly (MP4, WebM, …)
 */
function _needsProxyHint(file) {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();

  if (/\.(mxf|braw|r3d|ari|dpx)$/i.test(name)) return true;
  if (/application\/mxf/.test(type))            return true;

  if (/\.mov$/i.test(name) || /quicktime/.test(type)) {
    // canPlayType('video/quicktime') returns 'maybe' on Chrome — never 'probably'.
    // H.264 inside .mov is usually fine; ProRes is not. We can't distinguish without
    // decoding, so treat .mov as 'uncertain' and let the probe timer decide.
    return 'uncertain';
  }

  // Check canPlayType for remaining types — if '' (empty string) it's definitely unsupported.
  const probeEl = _getProbeEl();
  if (probeEl) {
    let mime = type;
    if (!mime) {
      if (/\.mp4$/i.test(name))  mime = 'video/mp4';
      else if (/\.webm$/i.test(name)) mime = 'video/webm';
      else if (/\.mkv$/i.test(name))  mime = 'video/x-matroska';
    }
    if (mime && probeEl.canPlayType(mime) === '') return true;
  }

  return false;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _teardownElement(el) {
  if (!el) return;
  const prev = el[_K.blobUrl];
  if (prev) {
    pfxReleaseObjectUrl(prev);
    el[_K.blobUrl] = null;
  }
  el[_K.mode]    = null;
  el[_K.meta]    = null;
  el[_K.session] = null;
  // Bumping the token cancels any in-flight status/mode callbacks from the previous load.
  el[_K.token] = (el[_K.token] || 0) + 1;
  // Cancel any tracked probe timers so they don't fire into stale state.
  if (el._pfxProbeTimers?.length) {
    el._pfxProbeTimers.forEach(id => clearTimeout(id));
    el._pfxProbeTimers = [];
  }
}

function _abortElement(el) {
  if (!el) return;
  try { el.pause(); } catch {}
  el.removeAttribute('src');
  try { el.load(); } catch {} // tells Chrome to release GPU/decoder resources
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attach a local File to a <video> element with seamless proxy fallback.
 *
 * On macOS desktop, .mov files are first probed for ProRes. If detected the file
 * is routed to NativeAVPlayerEngine (canvas + avf_bridge) instead of Chromium <video>.
 * opts.onNativeEngine({ engine, info, canvas }) is called when this path activates.
 *
 * For all other files: direct Chromium play is attempted first; if that fails, the
 * native host proxy path is triggered automatically.
 *
 * @param {HTMLVideoElement} videoEl
 * @param {File}             file      Original file — source of truth, never replaced.
 * @param {object}           [opts]
 *   onMode(mode, src)                 'direct' | 'proxy' | 'restored-proxy' | 'native'
 *   onStatus(label)                   Human-readable label (see PLAYABLE_STATUS)
 *   onProgress(pct: 0-100)            Proxy transcode progress
 *   onProxyFail(hint: string)         Called when both direct + proxy fail
 *   onNativeEngine({ engine, info, canvas })  Called when NativeAVPlayerEngine activates
 */
export function attachPlayableVideo(videoEl, file, opts = {}) {
  if (!videoEl || !file) return;

  const {
    onMode         = null,
    onStatus       = null,
    onProgress     = null,
    onProxyFail    = null,
    onNoOutputDir  = null,
    onNativeEngine = null,
  } = opts;

  // Invalidate any pending loadVideoWithProxyFallback probe timer / error listener
  // from the previous load BEFORE _abortElement fires an error event on the element.
  videoEl._pfxLoadToken = (videoEl._pfxLoadToken || 0) + 1;

  // 1. Release any previous media on this element (blob URL ref, canvas, native engine).
  releasePlayableVideo(videoEl);
  // Reset the native-fallback guard for this fresh load (prevents native↔Chromium loop).
  videoEl._pfxNativeAttempted = false;

  // 2. Grab a monotonic token; all async callbacks check this to detect staleness.
  const token = videoEl[_K.token];

  // 3. Stamp original file metadata onto the element (proxy never changes this).
  videoEl[_K.meta] = {
    name:         file.name,
    size:         file.size,
    lastModified: file.lastModified,
    type:         file.type,
  };
  videoEl[_K.mode] = 'pending';

  onStatus?.(PLAYABLE_STATUS.preparing);

  // 4. ProRes routing: on macOS desktop .mov files, probe the codec first.
  //    ProRes → NativeAVPlayerEngine (canvas). Non-ProRes → Chromium path.
  const nativePath = file._nativePath || null;
  const isMov      = /\.mov$/i.test(file.name || '');

  if (nativePath && isMov && window.pfxPlatform?.isMacApp) {
    selectEngine(nativePath).then(({ engine, info }) => {
      if (videoEl[_K.token] !== token) return; // stale — file changed during probe
      if (engine === ENGINE.NATIVE_AV) {
        _startNativeAVPath(videoEl, file, nativePath, info, token, {
          onMode, onStatus, onNativeEngine,
        });
      } else if (engine === ENGINE.MPV) {
        _startMPVPath(videoEl, file, nativePath, info, token, {
          onMode, onStatus, onNativeEngine, onProxyFail, onNoOutputDir,
          onProgress,
        });
      } else {
        _startChromiumPath(videoEl, file, nativePath, token, {
          onMode, onStatus, onProgress, onProxyFail, onNoOutputDir, onNativeEngine,
        });
      }
    }).catch(() => {
      if (videoEl[_K.token] !== token) return;
      _startChromiumPath(videoEl, file, nativePath, token, {
        onMode, onStatus, onProgress, onProxyFail, onNoOutputDir, onNativeEngine,
      });
    });
    return; // wait for codec probe; Chromium path starts only if ProRes not detected
  }

  _startChromiumPath(videoEl, file, nativePath, token, {
    onMode, onStatus, onProgress, onProxyFail, onNoOutputDir, onNativeEngine,
  });
}

// ── NativeAVPlayerEngine path ─────────────────────────────────────────────────

function _startNativeAVPath(videoEl, file, nativePath, info, token, { onMode, onStatus, onNativeEngine, onProxyFail, onNoOutputDir, onProgress }) {
  // Mark that the native AVFoundation engine has been tried for this load, so the
  // Chromium proxy-free fallback won't bounce back here and loop.
  videoEl._pfxNativeAttempted = true;
  // Hide the <video> element; the canvas overlay takes its place.
  videoEl.style.visibility = 'hidden';

  const canvas = mountNativeCanvas(videoEl);
  const engine = new NativeAVPlayerEngine(canvas, {
    onStatus:     (label) => { if (videoEl[_K.token] === token) onStatus?.(label); },
    onTimeUpdate: () => {},
    onError:      (msg) => console.error('[NativeAVPlayer]', msg),
  });

  videoEl._pfxNativeEngine = engine;
  videoEl[_K.mode] = 'native';

  engine.open(nativePath).then(() => {
    // Stale success: the file changed while open() was in flight (a previous
    // releasePlayableVideo may have run before the session existed). Close this
    // engine so its AVAsset session isn't orphaned — _pfxNativeEngine now points
    // at the new load's engine, so don't touch it.
    if (videoEl[_K.token] !== token) { try { engine.close(); } catch {} return; }
    onMode?.('native', nativePath);
    onStatus?.(PLAYABLE_STATUS.native);
    onNativeEngine?.({ engine, info, canvas });
  }).catch((err) => {
    console.error('[NativeAVPlayer] open failed:', err);
    if (videoEl[_K.token] !== token) return;
    // Engine failed — clean up native resources and fall back to Chromium path.
    videoEl.style.visibility = '';
    videoEl._pfxNativeEngine = null;
    videoEl[_K.mode] = 'pending';
    unmountNativeCanvas(videoEl);
    _startChromiumPath(videoEl, file, nativePath, token, {
      onMode, onStatus, onProgress, onProxyFail, onNoOutputDir, onNativeEngine,
    });
  });
}

// ── MPVPlayerEngine path ──────────────────────────────────────────────────────

function _startMPVPath(videoEl, file, nativePath, info, token, {
  onMode, onStatus, onNativeEngine, onProxyFail, onNoOutputDir, onProgress,
}) {
  videoEl.style.visibility = 'hidden';
  const canvas = mountNativeCanvas(videoEl);
  const engine = new MPVPlayerEngine(canvas, {
    onStatus:     (label) => { if (videoEl[_K.token] === token) onStatus?.(label); },
    onTimeUpdate: () => {},
    onError:      (msg) => console.error('[MPVPlayer]', msg),
  });

  videoEl._pfxNativeEngine = engine;
  videoEl[_K.mode] = 'native';

  engine.open(nativePath).then(() => {
    // Stale success — close so the mpv process/socket isn't left running in the
    // background (the new load owns _pfxNativeEngine now).
    if (videoEl[_K.token] !== token) { try { engine.close(); } catch {} return; }
    onMode?.('native', nativePath);
    onStatus?.('Playing via MPV ↗');
    onNativeEngine?.({ engine, info, canvas });
  }).catch((err) => {
    console.error('[MPVPlayer] open failed:', err.message);
    if (videoEl[_K.token] !== token) return;
    videoEl.style.visibility = '';
    videoEl._pfxNativeEngine = null;
    unmountNativeCanvas(videoEl);
    // MPV failed — offer proxy as last resort
    onProxyFail?.(
      `Direct ProRes playback failed (${err.message.includes('not found') ? 'mpv not installed' : err.message}). Create proxy fallback?`
    );
  });
}

// ── Chromium <video> path ─────────────────────────────────────────────────────

// Proxy-free fallback: give the <video> element a moment to decode the blob/stream
// (H.264/HEVC play directly). If it can't show a frame, hand off to the native
// AVFoundation engine — which decodes ALL QuickTime codecs (ProRes included) — instead
// of transcoding a proxy. Used on macOS desktop; browser/extension mode keeps the proxy.
function _probeThenNativeFallback(videoEl, file, nativePath, blobUrl, token, cbs) {
  const { onMode, onStatus, onNativeEngine, onProxyFail, onNoOutputDir, onProgress } = cbs;
  let settled = false;
  const cleanup = () => {
    clearTimeout(timer);
    videoEl.removeEventListener('loadedmetadata', onMeta);
    videoEl.removeEventListener('error', onErr);
  };
  const keepDirect = () => {
    if (settled || videoEl[_K.token] !== token) return;
    settled = true; cleanup();
    videoEl[_K.mode] = 'direct';
    onMode?.('direct', videoEl.currentSrc || blobUrl);
    onStatus?.(PLAYABLE_STATUS.direct);
  };
  const goNative = () => {
    if (settled || videoEl[_K.token] !== token) return;
    settled = true; cleanup();
    if (videoEl._pfxNativeAttempted) {            // native already failed — don't loop
      onProxyFail?.(`${file.name} — could not decode with the native player`);
      return;
    }
    _startNativeAVPath(videoEl, file, nativePath, null, token, {
      onMode, onStatus, onNativeEngine, onProxyFail, onNoOutputDir, onProgress,
    });
  };
  const onMeta = () => { (videoEl.videoWidth || 0) > 0 ? keepDirect() : goNative(); };
  const onErr  = () => goNative();
  videoEl.addEventListener('loadedmetadata', onMeta, { once: true });
  videoEl.addEventListener('error', onErr, { once: true });
  // Chromium often shows a black frame (videoWidth 0) without an error for codecs it
  // can't decode — probe after a short delay and route to native if no picture.
  const timer = setTimeout(() => { (videoEl.videoWidth || 0) > 0 ? keepDirect() : goNative(); }, 2500);
}

function _startChromiumPath(videoEl, file, nativePath, token, {
  onMode, onStatus, onProgress, onProxyFail, onNoOutputDir, onNativeEngine,
}) {
  // 4a. Shared media runtime fast path: for .mov files with a native OS path,
  //     try pfx-media:// streaming via media_engine (H.264/HEVC only).
  //     ProRes returns canPlay:false — we guard and skip video.src to prevent black screen.
  if (nativePath && /\.mov$/i.test(file.name || '')) {
    sharedMediaOpen(nativePath).then(resp => {
      const d = resp?.data || {};
      if (!d.canPlay) {
        const c = (d.codec || '').toLowerCase();
        const proResBlockSet = new Set(['apch','apcn','apcs','apco','ap4h','ap4x','apns','prores']);
        if (proResBlockSet.has(c)) {
          throw new Error(`ProRes is blocked from Chromium player (codec: ${c}). Use NativeAVFoundationPlayer or MPV.`);
        }
        return;
      }
      // Only apply stream URL if the element is still on this load token AND has not
      // already been committed to a source by the blob URL path below.
      if (d.streamUrl && videoEl[_K.token] === token && videoEl[_K.mode] === 'pending') {
        const httpToken = window.__pfxCompanionHttpToken || d.httpToken || '';
        const streamUrl = httpToken
          ? `${d.streamUrl}${d.streamUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(httpToken)}`
          : d.streamUrl;
        videoEl[_K.mode] = 'direct';
        if (/^https?:\/\//i.test(streamUrl)) videoEl.crossOrigin = 'anonymous';
        else {
          try { videoEl.removeAttribute('crossorigin'); } catch {}
          try { videoEl.crossOrigin = null; } catch {}
        }
        videoEl.src = streamUrl;
        videoEl.load();
        onMode?.('direct', streamUrl);
        onStatus?.(PLAYABLE_STATUS.direct);
      }
    }).catch((err) => {
      console.error('[PlaybackRouter] htmlVideoBlocked=true —', err.message);
    });
    // Fire-and-forget; blob URL path below runs in parallel as immediate fallback
  }

  // 4b. Cross-tab proxy reuse
  const cached = getCachedProxyForFile(file);
  if (cached?.url) {
    if (videoEl[_K.token] !== token) return;
    videoEl[_K.mode]    = 'restored-proxy';
    videoEl[_K.session] = cached.sessionId || '';
    videoEl.src = cached.url;
    videoEl.load();
    onMode?.('restored-proxy', cached.url);
    onStatus?.(PLAYABLE_STATUS.proxy);
    onProgress?.(100);
    return;
  }

  // 4c. Blob URL + proxy fallback
  const blobUrl = pfxAcquireObjectUrl(file);
  if (!blobUrl) {
    // No File blob — e.g. a Resolve/native-path reference carries a path but no
    // File data, so URL.createObjectURL can't run. Before giving up (black pane),
    // fall back to the pfx-media:// protocol, which serves the local file
    // directly from the Electron main process: range-streamable, path safely
    // percent-encoded (handles spaces like "/Volumes/Extreme SSD/…"), and
    // INDEPENDENT of the companion media engine — so a browser-playable codec
    // (H.264/HEVC .mov) still shows even when the media engine is "Limited".
    const directUrl = (nativePath && window.pfxPlatform?.media?.srcUrl)
      ? window.pfxPlatform.media.srcUrl(nativePath)
      : null;
    if (directUrl && videoEl[_K.token] === token && videoEl[_K.mode] === 'pending') {
      videoEl[_K.mode] = 'direct';
      try { videoEl.removeAttribute('crossorigin'); } catch {}
      try { videoEl.crossOrigin = null; } catch {}
      videoEl.src = directUrl;
      videoEl.load();
      onMode?.('direct', directUrl);
      onStatus?.(PLAYABLE_STATUS.direct);
      return;
    }
    onProxyFail?.(`${file.name} — could not create playback URL`);
    return;
  }
  videoEl[_K.blobUrl] = blobUrl;
  videoEl.src = blobUrl;
  videoEl.load();

  // Proxy-free on macOS desktop: any QuickTime the <video> can't decode (ProRes etc.)
  // falls back to the native AVFoundation engine, never a transcode. Browser/extension
  // mode (no native engine) keeps the proxy fallback.
  if (nativePath && /\.mov$/i.test(file.name || '') && window.pfxPlatform?.isMacApp) {
    _probeThenNativeFallback(videoEl, file, nativePath, blobUrl, token, {
      onMode, onStatus, onNativeEngine, onProxyFail, onNoOutputDir, onProgress,
    });
    return;
  }

  loadVideoWithProxyFallback(videoEl, file, blobUrl, {
    onProxying: () => {
      if (videoEl[_K.token] !== token) return;
      onStatus?.(PLAYABLE_STATUS.proxying);
    },
    onProgress: (pct) => {
      if (videoEl[_K.token] !== token) return;
      onProgress?.(pct);
    },
    onProxySuccess: (streamUrl) => {
      if (videoEl[_K.token] !== token) return;
      videoEl[_K.mode]    = 'proxy';
      videoEl[_K.session] = videoEl._pfxProxySessionId || '';
      onMode?.('proxy', streamUrl);
      onStatus?.(PLAYABLE_STATUS.proxy);
      onProgress?.(100);
    },
    onProxyFail: (hint) => {
      if (videoEl[_K.token] !== token) return;
      onProxyFail?.(hint);
    },
    onNoOutputDir: () => {
      if (videoEl[_K.token] !== token) return;
      onNoOutputDir?.();
    },
  });

  videoEl.addEventListener('loadedmetadata', () => {
    if (videoEl[_K.token] !== token) return;
    if (videoEl[_K.mode] !== 'pending') return;
    const isBlindMov = (videoEl.videoWidth || 0) === 0 &&
                       /\.mov$/i.test(file.name || '');
    if (isBlindMov) return;
    videoEl[_K.mode] = 'direct';
    onMode?.('direct', blobUrl);
    onStatus?.(PLAYABLE_STATUS.direct);
  }, { once: true });
}

/**
 * Resolve the best playable URL for a File without attaching it to a video element.
 *
 * For analysis surfaces (VisualQC scan, thumbnail extraction) that manage their own
 * temporary video elements — these must NOT go through attachPlayableVideo because
 * they should not claim exclusive playback arbitration.
 *
 * Lookup order:
 *   1. In-memory proxy cache (cross-tab, zero latency)
 *   2. Disk proxy restore via tryRestoreProxyForMeta (for .mov/.mxf on page reload)
 *   3. Blob URL from mediaCache (direct play attempt)
 *
 * The returned blob: URL (mode === 'direct') is ref-counted — the caller MUST call
 * pfxReleaseObjectUrl(src) when done to avoid leaking the reference.
 * HTTP proxy URLs (mode !== 'direct') do not need manual release.
 *
 * @param {File}   file
 * @param {object} [opts]
 *   forceProxy  — skip blob URL entirely, only try proxy restore
 * @returns {Promise<{src: string, mode: 'direct'|'proxy'|'restored-proxy', proxySessionId?: string, originalMeta: object}>}
 */
export async function ensurePlayableSource(file, opts = {}) {
  if (!file) return { src: '', mode: 'direct', originalMeta: null };

  const originalMeta = { name: file.name, size: file.size, lastModified: file.lastModified, type: file.type };

  // In-memory cache hit (cross-tab)
  const cached = getCachedProxyForFile(file);
  if (cached?.url) {
    return { src: cached.url, mode: 'restored-proxy', proxySessionId: cached.sessionId, originalMeta };
  }

  // For containers unlikely to play directly, try the disk proxy index first.
  const bias = _needsProxyHint(file);
  if (bias === true || bias === 'uncertain' || opts.forceProxy) {
    try {
      const restored = await tryRestoreProxyForMeta(file);
      if (restored?.url) {
        return { src: restored.url, mode: 'restored-proxy', proxySessionId: restored.sessionId, originalMeta };
      }
    } catch {}
    if (opts.forceProxy) {
      return { src: '', mode: 'direct', originalMeta };
    }
  }

  // Fall back to a blob URL — works for H.264/VP9/WebM; may fail for ProRes in analysis video.
  const blobUrl = pfxAcquireObjectUrl(file);
  return { src: blobUrl, mode: 'direct', originalMeta };
}

/**
 * Release all resources held by a video element previously set up with attachPlayableVideo.
 * Revokes the blob URL ref, bumps the load token (cancels in-flight callbacks), aborts
 * the media pipeline, and closes any active NativeAVPlayerEngine + canvas overlay.
 *
 * @param {HTMLVideoElement} videoEl
 */
export function releasePlayableVideo(videoEl) {
  if (!videoEl) return;
  // Close NativeAVPlayerEngine and remove its canvas overlay.
  const nativeEngine = videoEl._pfxNativeEngine;
  if (nativeEngine) {
    nativeEngine.close();
    videoEl._pfxNativeEngine = null;
  }
  unmountNativeCanvas(videoEl);
  videoEl.style.visibility = ''; // restore visibility hidden during native playback
  _teardownElement(videoEl);
  _abortElement(videoEl);
}

/**
 * Return the current playback mode for a video element, or null if not managed.
 * @param {HTMLVideoElement} videoEl
 * @returns {'pending'|'direct'|'proxy'|'restored-proxy'|null}
 */
export function getPlayableMode(videoEl) {
  return videoEl?.[_K.mode] ?? null;
}
