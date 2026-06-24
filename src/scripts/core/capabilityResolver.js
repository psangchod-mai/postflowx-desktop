/**
 * scripts/core/capabilityResolver.js — PostFlowX Playback Capability Resolver
 *
 * Determines the best playback path for a given File without side-effects.
 * Used by playableMedia.js and any surface that needs to know what a file
 * can do before committing to a playback strategy.
 *
 * Result shape:
 *   {
 *     sourceType:     'direct' | 'proxy' | 'native' | 'unavailable'
 *     directPlayable: boolean
 *     proxyAvailable: boolean
 *     nativeAvailable: boolean
 *     preferredMode:  'browser' | 'native'
 *     reason?:        string
 *   }
 *
 * Rules:
 *   1. Browser Mode is always the default preferred mode.
 *   2. Native path is only surfaced when the caller explicitly allows it
 *      (admin role or show_native_playback_settings feature flag).
 *   3. This function never pings the native host — nativeAvailable is always
 *      false from this resolver. Callers that need a live native check should
 *      use nativeAvailability.js (admin-only path).
 */

import { getCachedProxyForFile } from '../modules/proResProxy.js';

// ── Browser codec probe (one shared element) ─────────────────────────────────
const _probe = (() => { try { return document.createElement('video'); } catch { return null; } })();

/**
 * Synchronously determine if the browser is likely able to decode this file.
 * Returns:
 *   true        — browser can almost certainly play it
 *   'uncertain' — QuickTime container; may or may not decode depending on codec
 *   false       — browser cannot play (MXF, BRAW, R3D, etc.)
 */
function _browserCanPlay(file) {
  const name = String(file?.name || '').toLowerCase();
  const type = String(file?.type || '').toLowerCase();

  if (/\.(mxf|braw|r3d|ari|arx|dpx)$/i.test(name)) return false;
  if (/application\/mxf/.test(type))                return false;

  if (/\.mov$/i.test(name) || /quicktime/.test(type)) return 'uncertain';

  if (_probe) {
    let mime = type;
    if (!mime) {
      if (/\.mp4$/i.test(name))        mime = 'video/mp4';
      else if (/\.webm$/i.test(name))  mime = 'video/webm';
      else if (/\.mkv$/i.test(name))   mime = 'video/x-matroska';
    }
    if (mime && _probe.canPlayType(mime) === '') return false;
  }

  return true;
}

/**
 * Resolve the best playback capability for a given File.
 *
 * @param {File} file
 * @returns {{ sourceType, directPlayable, proxyAvailable, nativeAvailable, preferredMode, reason? }}
 */
export function resolvePlaybackCapability(file) {
  if (!file) {
    return { sourceType: 'unavailable', directPlayable: false, proxyAvailable: false, nativeAvailable: false, preferredMode: 'browser', reason: 'no file' };
  }

  const canPlay     = _browserCanPlay(file);
  const directPlay  = canPlay === true;
  const uncertain   = canPlay === 'uncertain';

  // Check in-memory proxy cache (cross-tab, zero latency)
  const cached = getCachedProxyForFile(file);
  const proxyAvail = !!(cached?.url);

  if (directPlay) {
    return { sourceType: 'direct', directPlayable: true, proxyAvailable: proxyAvail, nativeAvailable: false, preferredMode: 'browser' };
  }

  if (uncertain) {
    // .mov — TRY DIRECT FIRST. Most QuickTime deliverables are H.264/HEVC, which
    // Chromium plays natively; only genuinely undecodable codecs (ProRes etc.)
    // need a proxy, and loadVideoWithProxyFallback transcodes on demand if the
    // direct decode actually fails. Preferring a cached proxy here forced a
    // playable .mov through a needless "convert" path even though it plays
    // directly — so we keep direct as the source and merely SURFACE that a proxy
    // is available as a fallback.
    return { sourceType: 'direct', directPlayable: true, proxyAvailable: proxyAvail, nativeAvailable: false, preferredMode: 'browser', reason: 'quicktime-direct-first' };
  }

  // OCF / non-playable container
  if (proxyAvail) {
    return { sourceType: 'proxy', directPlayable: false, proxyAvailable: true, nativeAvailable: false, preferredMode: 'browser' };
  }

  // No proxy cached yet — native host may generate one if available, else show preparing state
  return { sourceType: 'unavailable', directPlayable: false, proxyAvailable: false, nativeAvailable: false, preferredMode: 'browser', reason: 'proxy-pending' };
}
