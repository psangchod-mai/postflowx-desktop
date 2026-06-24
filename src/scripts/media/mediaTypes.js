// scripts/media/mediaTypes.js
// Shared constants and enums for the PostFlowX shared media runtime.
// All tabs and the mediaBridge import from here — never hardcode strings.

export const BACKEND = Object.freeze({
  STANDARD_MEDIA:      'standard_media',
  PRORES_NATIVE:       'prores_native',
  PRORES_RAW_NATIVE:   'prores_raw_native',
  BRAW_SDK:            'braw_sdk',
  R3D_SDK:             'r3d_sdk',
  ARRI_SDK:            'arri_sdk',
  ARRI_TOOL_BRIDGE:    'arri_tool_bridge',
});

export const FORMAT = Object.freeze({
  // Browser-decodable (standard_media backend)
  MP4:   'mp4',
  MOV:   'mov',
  WEBM:  'webm',
  MKV:   'mkv',
  // ProRes (prores_native or standard_media)
  PRORES: 'prores',
  // Camera originals
  BRAW:  'braw',
  R3D:   'r3d',
  MXF:   'mxf',
  ARX:   'arx',   // ARRIRAW
  ARI:   'ari',   // ARRIRAW variant
  // ProRes RAW
  PRORES_RAW: 'prores_raw',
});

export const ERROR_CODE = Object.freeze({
  HELPER_NOT_INSTALLED:   'helper_not_installed',
  BACKEND_NOT_AVAILABLE:  'backend_not_available',
  SDK_MISSING:            'sdk_missing',
  UNSUPPORTED_FORMAT:     'unsupported_format',
  FILE_OPEN_FAILED:       'file_open_failed',
  DECODE_FAILED:          'decode_failed',
  PERMISSION_DENIED:      'permission_denied',
  PLATFORM_NOT_SUPPORTED: 'platform_not_supported',
  SESSION_NOT_FOUND:      'session_not_found',
  BAD_REQUEST:            'bad_request',
  TIMEOUT:                'timeout',
});

export const BACKEND_STATUS = Object.freeze({
  READY:              'ready',
  UNAVAILABLE:        'unavailable',
  SDK_MISSING:        'sdk_missing',
  PREVIEW_ONLY:       'preview_only',
  METADATA_ONLY:      'metadata_only',
  NOT_INSTALLED:      'not_installed',
});

export const DECODE_QUALITY = Object.freeze({
  FULL:    'full',
  HALF:    'half',
  QUARTER: 'quarter',
});

// Extension-side message types sent to background.js
export const MSG_TYPE = Object.freeze({
  MEDIA_OPEN:           'MEDIA_OPEN',
  MEDIA_CLOSE:          'MEDIA_CLOSE',
  MEDIA_GET_METADATA:   'MEDIA_GET_METADATA',
  MEDIA_GET_FRAME:      'MEDIA_GET_FRAME',
  MEDIA_SEEK:           'MEDIA_SEEK',
  MEDIA_PLAY:           'MEDIA_PLAY',
  MEDIA_PAUSE:          'MEDIA_PAUSE',
  MEDIA_GET_STATUS:     'MEDIA_GET_STATUS',
  MEDIA_GET_CAPS:       'MEDIA_GET_CAPS',
});
