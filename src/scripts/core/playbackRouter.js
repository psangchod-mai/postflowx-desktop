/**
 * playbackRouter.js — Pre-load codec probe and engine selection for local media.
 *
 * Desktop (Electron/macOS) only. ProRes files bypass Chromium <video> entirely.
 *
 * Engine preference order for ProRes:
 *   1. PFXNativeEngine  — persistent session, ~5ms/frame (preferred when binary present)
 *   2. NativeAVPlayerEngine — canvas + avf_bridge (~100ms/frame, legacy fallback)
 *   3. MPVPlayerEngine  — mpv subprocess fallback
 *
 * API:
 *   selectEngine(nativePath)           → Promise<{ engine, info, ffInfo, htmlVideoBlocked }>
 *   selectPlaybackEngine(mediaInfo)    → 'native-engine' | 'native-avfoundation' | 'chromium-video' | 'mpv' | 'proxy'
 *
 * engine values:
 *   'PFXNativeEngine'       — PFXNativeMediaEngine (session-cached AVAsset, HW decode)
 *   'NativeAVPlayerEngine'  — canvas + avf_bridge (ProRes legacy path)
 *   'MPVPlayerEngine'       — mpv subprocess (ProRes fallback)
 *   'ChromiumVideo'         — normal <video> path
 */

export const ENGINE = {
  NATIVE_ENGINE:  'PFXNativeEngine',
  NATIVE_AV:      'NativeAVPlayerEngine',
  MPV:            'MPVPlayerEngine',
  CHROMIUM_VIDEO: 'ChromiumVideo',
};

// ProRes codec identifiers returned by avf_bridge getInfo
const PRORES_CODECS = new Set(['apcn', 'apco', 'apcs', 'apch', 'ap4h', 'ap4x', 'apns', 'prores']);

// ProRes FourCC strings returned by ffprobe codec_tag_string
const PRORES_FOURCHARS = new Set(['apch', 'apcn', 'apcs', 'apco', 'ap4h', 'ap4x', 'apns']);

const PRORES_LABELS = {
  apch:   'Apple ProRes 422 HQ',
  apcn:   'Apple ProRes 422',
  apcs:   'Apple ProRes 422 LT',
  apco:   'Apple ProRes 422 Proxy',
  ap4h:   'Apple ProRes 4444',
  ap4x:   'Apple ProRes 4444 XQ',
  apns:   'Apple ProRes RAW',
  prores: 'Apple ProRes',
};

export function isProResCodec(codec) {
  return PRORES_CODECS.has((codec || '').toLowerCase());
}

export function proResDisplayName(codec) {
  return PRORES_LABELS[(codec || '').toLowerCase()] || 'Apple ProRes';
}

/**
 * Synchronous engine selector based on already-probed mediaInfo.
 * Returns a string key compatible with the routing layer.
 *
 * @param {object} mediaInfo  Object with codec_name, codec_tag_string, codec fields
 * @returns {'native-avfoundation'|'chromium-video'|'mpv'|'proxy'}
 */
export function selectPlaybackEngine(mediaInfo) {
  const codec_name = (mediaInfo?.codec_name || mediaInfo?.codec || '').toLowerCase();
  const tag        = (mediaInfo?.codec_tag_string || '').toLowerCase();

  const proRes = codec_name === 'prores'
    || PRORES_FOURCHARS.has(tag)
    || PRORES_CODECS.has(codec_name);

  if (!proRes) return 'chromium-video';
  if (!window.pfxPlatform?.isMacApp) return 'proxy';
  // Prefer persistent native engine (session-cached, HW decode) over one-shot avf_bridge
  if (window.pfxPlatform?.nativeEngine) return 'native-engine';
  if (window.pfxPlatform?.media?.getStill) return 'native-avfoundation';
  return 'mpv';
}

/**
 * Probe via ffprobe (primary — full codec_name + codec_tag_string).
 */
async function _probeFfprobe(nativePath) {
  if (!window.pfxPlatform?.media?.ffprobeInfo) return null;
  try {
    const info = await window.pfxPlatform.media.ffprobeInfo({ path: nativePath });
    return (info?.ok !== false) ? info : null;
  } catch {
    return null;
  }
}

/**
 * Probe via avf_bridge (secondary — additional metadata, fps, duration).
 */
async function _probeInfo(nativePath) {
  if (!window.pfxPlatform?.media?.getInfo) return null;
  try {
    const info = await window.pfxPlatform.media.getInfo({ path: nativePath });
    return (info?.ok !== false) ? info : null;
  } catch {
    return null;
  }
}

/**
 * Determine which playback engine to use for the given file.
 *
 * Probe order: ffprobe (codec_name + codec_tag_string) → avf_bridge (codec FourCC).
 * All six required debug fields are logged unconditionally.
 *
 * @param {string} nativePath  Absolute filesystem path (desktop only)
 * @returns {Promise<{ engine: string, info: object|null, ffInfo: object|null, htmlVideoBlocked: boolean }>}
 */
export async function selectEngine(nativePath) {
  if (!nativePath || !window.pfxPlatform?.isMacApp) {
    return { engine: ENGINE.CHROMIUM_VIDEO, info: null, ffInfo: null, htmlVideoBlocked: false };
  }

  console.log(`[PlaybackRouter] file=${nativePath}`);

  // Primary probe: ffprobe
  const ffInfo           = await _probeFfprobe(nativePath);
  const codec_name       = (ffInfo?.codec_name       || '').toLowerCase();
  const codec_tag_string = (ffInfo?.codec_tag_string || '').toLowerCase();
  const container        = ffInfo?.container || nativePath.split('.').pop().toLowerCase();

  // Secondary probe: avf_bridge (better fps/duration; also catches ProRes not in PATH ffprobe)
  const avfInfo  = await _probeInfo(nativePath);
  const avfCodec = (avfInfo?.codec || '').toLowerCase();

  console.log(`[PlaybackRouter] container=${container}`);
  console.log(`[PlaybackRouter] codec_name=${codec_name || avfCodec || 'unknown'}`);
  console.log(`[PlaybackRouter] codec_tag_string=${codec_tag_string || 'unknown'}`);

  const isProRes = codec_name === 'prores'
    || PRORES_FOURCHARS.has(codec_tag_string)
    || PRORES_CODECS.has(codec_name)
    || PRORES_CODECS.has(avfCodec);

  if (isProRes) {
    const info = avfInfo || { codec: codec_name || codec_tag_string, fps: ffInfo?.fps };
    // Prefer persistent native engine (session-cached AVAsset, HW decode, ~5ms/frame)
    if (window.pfxPlatform?.nativeEngine) {
      const engine = ENGINE.NATIVE_ENGINE;
      console.log(`[PlaybackRouter] selectedEngine=${engine}`);
      console.log(`[PlaybackRouter] htmlVideoBlocked=true`);
      return { engine, info, ffInfo, htmlVideoBlocked: true };
    }
    if (window.pfxPlatform?.media?.getStill) {
      const engine = ENGINE.NATIVE_AV;
      console.log(`[PlaybackRouter] selectedEngine=${engine}`);
      console.log(`[PlaybackRouter] htmlVideoBlocked=true`);
      return { engine, info, ffInfo, htmlVideoBlocked: true };
    }
    // Neither available — fall to MPV
    const engine = ENGINE.MPV;
    console.log(`[PlaybackRouter] selectedEngine=${engine}`);
    console.log(`[PlaybackRouter] htmlVideoBlocked=true`);
    return { engine, info, ffInfo, htmlVideoBlocked: true };
  }

  console.log(`[PlaybackRouter] selectedEngine=${ENGINE.CHROMIUM_VIDEO}`);
  console.log(`[PlaybackRouter] htmlVideoBlocked=false`);
  const info = avfInfo || { codec: codec_name, fps: ffInfo?.fps };
  return { engine: ENGINE.CHROMIUM_VIDEO, info, ffInfo, htmlVideoBlocked: false };
}
