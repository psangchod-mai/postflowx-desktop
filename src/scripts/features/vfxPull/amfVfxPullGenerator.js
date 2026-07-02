// amfVfxPullGenerator.js — PostFlowX standalone VFX Pull AMF generator
// Generates ACES Metadata File (AMF) XML per VFX shot.
//
// Standalone — does NOT import amfBuilder.js or ACES Look state.
// Works from simple shot params (clip name, TC, camera model, CDL, mode).
//
// Spec reference: aces-aswf/aces-amf (https://github.com/aces-aswf/aces-amf)
// Namespace:      urn:ampas:aces:amf:v2.0
// ACES version:   1.3
//
// Exports:
//   CAMERA_IDT_MAP          — camera model → IDT URN map
//   resolveIdtUrn(model)    → URN string or null
//   buildVfxPullAmf(params) → { ok, xml, warnings }

const AMF_NS      = 'urn:ampas:aces:amf:v2.0';
const ACES_VER    = '1.3';
const APP_DEFAULT = 'PostFlowX';

// Rec.709 ODT URN used for DAILIES output transform
const REC709_ODT_URN =
  'urn:ampas:aces:transformId:v2.0:ODT.Academy.Rec709_100nits_dim.a1.v1.5';

// ── Camera IDT map ─────────────────────────────────────────────────────────────
// Keys are canonical camera model strings.
// Values are ACES 2.0 IDT URNs, or null if the material is already ACES.

export const CAMERA_IDT_MAP = {
  'ARRI LogC3':         'urn:ampas:aces:transformId:v2.0:IDT.ARRI.ALEXA-LogC-EI800.a1.v2',
  'ARRI LogC4':         'urn:ampas:aces:transformId:v2.0:IDT.ARRI.ALEXA35-LogC-EI800.a1.v1',
  'ARRI ALEXA Mini LF': 'urn:ampas:aces:transformId:v2.0:IDT.ARRI.ALEXA-LogC-EI800.a1.v2',
  'ARRI ALEXA 35':      'urn:ampas:aces:transformId:v2.0:IDT.ARRI.ALEXA35-LogC-EI800.a1.v1',
  'ARRI ALEXA Mini':    'urn:ampas:aces:transformId:v2.0:IDT.ARRI.ALEXA-LogC-EI800.a1.v2',
  'RED IPP2 Log3G10':   'urn:ampas:aces:transformId:v2.0:IDT.RED.REDWideGamutRGB.a1.v1',
  'RED Log3G10':        'urn:ampas:aces:transformId:v2.0:IDT.RED.REDWideGamutRGB.a1.v1',
  'RED KOMODO 6K':      'urn:ampas:aces:transformId:v2.0:IDT.RED.REDWideGamutRGB.a1.v1',
  'RED V-RAPTOR':       'urn:ampas:aces:transformId:v2.0:IDT.RED.REDWideGamutRGB.a1.v1',
  'Sony S-Gamut3.Cine/S-Log3': 'urn:ampas:aces:transformId:v2.0:IDT.Sony.SLog3_SGamut3Cine.a1.v1',
  'Sony VENICE 2':      'urn:ampas:aces:transformId:v2.0:IDT.Sony.Venice_SGamut3Cine_SLog3.a1.v1',
  'Sony FX9':           'urn:ampas:aces:transformId:v2.0:IDT.Sony.SLog3_SGamut3Cine.a1.v1',
  'Canon C-Log2/C-Gamut': 'urn:ampas:aces:transformId:v2.0:IDT.Canon.CanonLog2_CGamut.a1.v1',
  'Canon C-Log3/C-Gamut': 'urn:ampas:aces:transformId:v2.0:IDT.Canon.CanonLog3_CGamut.a1.v1',
  'Canon EOS C70':      'urn:ampas:aces:transformId:v2.0:IDT.Canon.CanonLog3_CGamut.a1.v1',
  'Blackmagic Film Gen 5': 'urn:ampas:aces:transformId:v2.0:IDT.Blackmagic.BlackmagicFilmGen5.a1.v1',
  'Blackmagic BRAW':    'urn:ampas:aces:transformId:v2.0:IDT.Blackmagic.BlackmagicFilmGen5.a1.v1',
  'Panasonic V-Log/V-Gamut': 'urn:ampas:aces:transformId:v2.0:IDT.Panasonic.VLog_VGamut.a1.v1',
  'Generic LogC':       'urn:ampas:aces:transformId:v2.0:IDT.ARRI.ALEXA-LogC-EI800.a1.v2',
  'GENERIC':            null,   // Already ACES — no IDT needed
};

// ── Internal helpers ───────────────────────────────────────────────────────────

/** RFC 4122 v4 UUID using crypto.getRandomValues */
function _uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] & 0xff;
    return (c === 'x' ? (r & 0xf) : ((r & 0x3) | 0x8)).toString(16);
  });
}

/** XML special-character escaping */
function _esc(str) {
  return String(str ?? '')
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&apos;');
}

/** Basename of a file path (handles both / and \ separators) */
function _basename(filePath) {
  if (!filePath) return '';
  return String(filePath).replace(/[/\\]+$/, '').split(/[/\\]/).pop() || '';
}

/**
 * Format a CDL number array as space-separated string with 6 decimal places.
 * Accepts [r, g, b] arrays. Falls back gracefully for malformed input.
 */
function _cdlTriple(arr, fallback = '1.000000 1.000000 1.000000') {
  if (!Array.isArray(arr) || arr.length < 3) return fallback;
  return arr.slice(0, 3).map(v => Number(v).toFixed(6)).join(' ');
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Fuzzy-match a camera model string to an ACES IDT URN.
 *
 * Strategy:
 *   1. Exact match (case-insensitive) against CAMERA_IDT_MAP keys
 *   2. Partial match — map key is a substring of the input (or vice-versa)
 *      using lowercase comparison
 *   3. Returns null if no match found
 *
 * @param {string} cameraModel
 * @returns {string|null} IDT URN, or null if no IDT is needed / not found
 */
export function resolveIdtUrn(cameraModel) {
  if (!cameraModel) return null;

  const needle = String(cameraModel).toLowerCase().trim();
  const entries = Object.entries(CAMERA_IDT_MAP);

  // Pass 1: exact match (case-insensitive)
  for (const [key, urn] of entries) {
    if (key.toLowerCase() === needle) return urn;
  }

  // Pass 2: partial match — input contains the key or key contains the input.
  // Prefer longer key matches first to avoid short keys (e.g. "ARRI") over-matching.
  const sorted = [...entries].sort((a, b) => b[0].length - a[0].length);
  for (const [key, urn] of sorted) {
    if (key === 'GENERIC') continue;   // Skip GENERIC in partial pass
    const haystack = key.toLowerCase();
    if (needle.includes(haystack) || haystack.includes(needle)) return urn;
  }

  // Pass 3: production shorthand / metadata strings.
  if (/\b(alexa\s*35|logc4)\b/.test(needle)) return CAMERA_IDT_MAP['ARRI LogC4'];
  if (/\b(arri|alexa|arriraw|logc3|log-c)\b/.test(needle)) return CAMERA_IDT_MAP['ARRI LogC3'];
  if (/\b(red|r3d|redcode|ipp2|log3g10|redwidegamut)\b/.test(needle)) return CAMERA_IDT_MAP['RED IPP2 Log3G10'];
  if (/\b(venice|s-?log3|sgamut3|s-gamut3)\b/.test(needle)) return CAMERA_IDT_MAP['Sony S-Gamut3.Cine/S-Log3'];
  if (/\b(canon|c-?log2|clog2)\b/.test(needle)) return CAMERA_IDT_MAP['Canon C-Log2/C-Gamut'];
  if (/\b(c-?log3|clog3)\b/.test(needle)) return CAMERA_IDT_MAP['Canon C-Log3/C-Gamut'];
  if (/\b(braw|blackmagic|bmd|gen\s*5)\b/.test(needle)) return CAMERA_IDT_MAP['Blackmagic Film Gen 5'];
  if (/\b(panasonic|v-?log|v-?gamut|varicam)\b/.test(needle)) return CAMERA_IDT_MAP['Panasonic V-Log/V-Gamut'];
  if (/\b(aces2065|aces\s*2065|ap0|already\s*aces)\b/.test(needle)) return null;

  return null;
}

/**
 * Build an AMF XML string for a VFX pull.
 *
 * @param {Object} params
 * @param {string}  params.clipName     - OCF clip name
 * @param {string}  params.shotName     - VFX shot name
 * @param {string}  params.filePath     - OCF file path (basename used in XML)
 * @param {string}  params.tcIn         - Source TC in
 * @param {string}  params.tcOut        - Source TC out
 * @param {string}  [params.cameraModel]- Camera model string for IDT lookup
 * @param {string}  [params.idtUrn]     - Explicit IDT URN (overrides cameraModel)
 * @param {string}  [params.mode]       - 'ocf_native' | 'match_editorial' | 'review_proxy'
 *                                        Legacy: 'IDT_ONLY' | 'IDT_PLUS_MATCH_LOOK' |
 *                                        'DAILIES' | 'RECEIPT' — auto-normalized
 * @param {Object}  [params.cdl]        - { slope:[r,g,b], offset:[r,g,b],
 *                                          power:[r,g,b], sat:number }
 * @param {boolean} [params.cdlApplied] - Whether CDL has already been applied
 * @param {string}  [params.outputColorSpace] - Color space of the DELIVERED plate
 *                                        (e.g. 'ACES2065-1', 'Rec.709', or a
 *                                        camera log space). Drives the
 *                                        inputTransform applied flag: an ACES /
 *                                        display-space plate has the IDT baked in
 *                                        (applied="true"); a camera-log/raw plate
 *                                        does not (applied="false").
 * @param {string}  [params.appVersion] - App version string
 * @returns {{ ok: boolean, xml: string|null, warnings: string[] }}
 */
export function buildVfxPullAmf({
  clipName    = '',
  shotName    = '',
  filePath    = '',
  tcIn        = '',
  tcOut       = '',
  cameraModel = '',
  cameraProfile = '',
  idtUrn      = '',
  mode        = 'match_editorial',
  cdl         = null,
  cdlApplied  = false,
  outputColorSpace = 'ACES2065-1',
  colorMatch  = null,
  retime      = null,
  reframe     = null,
  timeline    = null,
  fps         = null,
  frameStart  = null,
  targetResolution = '',
  extraWarnings = [],
  appVersion  = '',
} = {}) {
  const warnings = [];

  // ── Validate/normalize mode ───────────────────────────────────────────────
  const LEGACY_MODE_MAP = {
    'IDT_ONLY':            'ocf_native',
    'IDT_PLUS_MATCH_LOOK': 'match_editorial',
    'DAILIES':             'review_proxy',
    'RECEIPT':             'ocf_native',
  };
  const VALID_MODES = ['ocf_native', 'match_editorial', 'review_proxy'];
  const normalizedMode = LEGACY_MODE_MAP[mode] || mode;
  const safeMode = VALID_MODES.includes(normalizedMode) ? normalizedMode : 'match_editorial';
  if (mode && !VALID_MODES.includes(normalizedMode) && !LEGACY_MODE_MAP[mode]) {
    warnings.push(`Unknown mode "${mode}" — defaulting to match_editorial.`);
  }

  // ── Resolve IDT URN ───────────────────────────────────────────────────────
  let resolvedIdtUrn = idtUrn || null;
  const cameraKey = cameraProfile || cameraModel;
  if (!resolvedIdtUrn && cameraKey) {
    resolvedIdtUrn = resolveIdtUrn(cameraKey);
    if (resolvedIdtUrn === undefined) resolvedIdtUrn = null;
  }
  const idtIsNull = resolvedIdtUrn === null;   // Means "already ACES"
  if (!resolvedIdtUrn && cameraKey && CAMERA_IDT_MAP['GENERIC'] !== undefined) {
    // Camera provided but no IDT found — warn
    if (!Object.keys(CAMERA_IDT_MAP).some(k => k.toLowerCase() === String(cameraKey).toLowerCase())) {
      warnings.push(`No IDT found for camera "${cameraKey}". Input transform will be omitted.`);
    }
  }
  for (const w of (Array.isArray(extraWarnings) ? extraWarnings : [])) warnings.push(w);

  // ── Input-transform "applied" contract ─────────────────────────────────────
  // The AMF accompanies the DELIVERED plate, so applied must describe whether the
  // IDT is already baked into THAT plate — which is decided by its color space:
  //   • ACES2065-1 / ACEScg / a display space (Rec.709 review proxy) → the IDT was
  //     applied during the pull render → applied="true".
  //   • Camera-native log/raw passthrough (e.g. DPX log) → IDT NOT applied; the
  //     compositor must apply it → applied="false".
  // This must NOT be hardcoded: colorPlanEngine reads applied to gate IDT re-apply
  // (applyIDT = !amfAppliedIDT), so a stale "false" on an ACES plate = double IDT.
  const _outCs = String(outputColorSpace || 'ACES2065-1').toLowerCase();
  // Camera-native color-space strings reliably carry a log/raw/cineon marker
  // (e.g. "ARRI LogC4", "REDLog3G10", "redcode raw"); no ACES or display space
  // does, so a substring test is safe and catches prefix-glued tokens.
  const _plateIsCameraNative =
    /(?:log|cineon|arriraw|x-?ocn|xocn|camera[\s-]?native|\braw\b)/.test(_outCs);
  const idtApplied     = !_plateIsCameraNative;
  const idtAppliedAttr = idtApplied ? 'true' : 'false';

  // ── Build XML ─────────────────────────────────────────────────────────────
  const now        = new Date().toISOString();
  const uuidInfo   = _uuid();
  const uuidPipe   = _uuid();
  const appLabel   = appVersion || APP_DEFAULT;
  const fileBase   = _basename(filePath);
  const hasCdl     = !!(cdl && (cdl.slope || cdl.offset || cdl.power || cdl.sat !== undefined));

  const lines = [];
  const p  = s => lines.push(s);

  p(`<?xml version="1.0" encoding="UTF-8"?>`);
  p(`<aces:acesMetadataFile version="2.0" xmlns:aces="${AMF_NS}">`);
  p(``);

  // ── amfInfo ───────────────────────────────────────────────────────────────
  p(`  <aces:amfInfo>`);
  p(`    <aces:uuid>urn:uuid:${uuidInfo}</aces:uuid>`);
  p(`    <aces:dateTime>`);
  p(`      <aces:creationDateTime>${_esc(now)}</aces:creationDateTime>`);
  p(`    </aces:dateTime>`);
  p(`    <aces:description>${_esc(`PostFlowX VFX Pull AMF - ${shotName || clipName}`)}</aces:description>`);
  p(`    <aces:systemVersion>${_esc(appLabel)}</aces:systemVersion>`);
  p(`  </aces:amfInfo>`);
  p(``);

  // ── clipId ────────────────────────────────────────────────────────────────
  p(`  <aces:clipId>`);
  if (clipName) {
    p(`    <aces:clipName>${_esc(clipName)}</aces:clipName>`);
  }
  if (fileBase) {
    p(`    <aces:file>${_esc(fileBase)}</aces:file>`);
  }
  if (shotName) {
    p(`    <aces:shotName>${_esc(shotName)}</aces:shotName>`);
  }
  if (timeline?.name || timeline?.timelineName) {
    p(`    <aces:clipName>${_esc(`Timeline: ${timeline.name || timeline.timelineName}`)}</aces:clipName>`);
  }
  if (tcIn) {
    p(`    <aces:sourceTimecodeIn>${_esc(tcIn)}</aces:sourceTimecodeIn>`);
  }
  if (tcOut) {
    p(`    <aces:sourceTimecodeOut>${_esc(tcOut)}</aces:sourceTimecodeOut>`);
  }
  if (timeline?.recIn) {
    p(`    <aces:sourceTimecodeIn>${_esc(`Record In: ${timeline.recIn}`)}</aces:sourceTimecodeIn>`);
  }
  if (timeline?.recOut) {
    p(`    <aces:sourceTimecodeOut>${_esc(`Record Out: ${timeline.recOut}`)}</aces:sourceTimecodeOut>`);
  }
  p(`  </aces:clipId>`);
  p(``);

  // ── pipeline ─────────────────────────────────────────────────────────────
  p(`  <aces:pipeline>`);
  p(`    <aces:pipelineInfo>`);
  p(`      <aces:uuid>urn:uuid:${uuidPipe}</aces:uuid>`);
  const modeLabel = { ocf_native: 'OCF Native (IDT only)', match_editorial: 'Match Editorial (IDT + look)', review_proxy: 'Review Proxy (IDT + look + ODT)' }[safeMode] || safeMode;
  p(`      <aces:description>${_esc(`VFX Pull - ${modeLabel}`)}</aces:description>`);
  p(`      <aces:systemVersion>`);
  p(`        <aces:majorVersion>${_esc(ACES_VER.split('.')[0])}</aces:majorVersion>`);
  p(`        <aces:minorVersion>${_esc(ACES_VER.split('.')[1] ?? '0')}</aces:minorVersion>`);
  p(`        <aces:patchVersion>0</aces:patchVersion>`);
  p(`      </aces:systemVersion>`);
  p(`    </aces:pipelineInfo>`);
  p(``);

  // ── Input Transform ───────────────────────────────────────────────────────
  // All modes emit an input transform block. applied reflects whether the IDT is
  // baked into the delivered plate (see "applied contract" above).
  p(`    <aces:inputTransform applied="${idtAppliedAttr}">`);

  if (resolvedIdtUrn) {
    p(`      <aces:transformId>${_esc(resolvedIdtUrn)}</aces:transformId>`);
  } else if (idtIsNull) {
    p(`      <!-- Source material is already in ACES2065-1. No IDT required. -->`);
  } else {
    p(`      <!-- IDT unknown for camera: ${_esc(cameraModel || 'unspecified')}. Verify manually. -->`);
    warnings.push('IDT URN could not be resolved. Verify input transform manually.');
  }

  if (safeMode === 'ocf_native') {
    p(`      <aces:description>${_esc(`VFX plate pull — IDT only. No output transform. Plate delivered in ${outputColorSpace || 'ACES2065-1'} (IDT ${idtApplied ? 'baked in' : 'NOT applied — compositor applies it'}).`)}</aces:description>`);
  } else if (cameraProfile || cameraModel) {
    p(`      <aces:description>${_esc(`Input profile: ${cameraProfile || cameraModel} — IDT ${idtApplied ? 'baked into delivered plate' : 'not applied (camera-native delivery)'}.`)}</aces:description>`);
  }

  p(`    </aces:inputTransform>`);
  p(``);

  // ── Look Transform (CDL) ──────────────────────────────────────────────────
  // Emitted for match_editorial and review_proxy when CDL is present.
  const emitLookBlock =
    hasCdl && (
      safeMode === 'match_editorial'
      || safeMode === 'review_proxy'
    );

  if (emitLookBlock) {
    const lookApplied = cdlApplied ? 'true' : 'false';
    p(`    <aces:lookTransform applied="${lookApplied}">`);

    if (safeMode === 'match_editorial') {
      p(`      <aces:description>${_esc('Reference preview match CDL. Label as PostFlowX auto match — not final DI grade.')}</aces:description>`);
    } else {
      p(`      <aces:description>${_esc('PostFlowX reference match CDL preview')}</aces:description>`);
    }

    // ASC CDL inline — SOP node
    p(`      <aces:ascCDL>`);
    p(`        <aces:SOPNode>`);
    p(`          <aces:Slope>${_esc(_cdlTriple(cdl.slope, '1.000000 1.000000 1.000000'))}</aces:Slope>`);
    p(`          <aces:Offset>${_esc(_cdlTriple(cdl.offset, '0.000000 0.000000 0.000000'))}</aces:Offset>`);
    p(`          <aces:Power>${_esc(_cdlTriple(cdl.power, '1.000000 1.000000 1.000000'))}</aces:Power>`);
    p(`        </aces:SOPNode>`);
    p(`        <aces:SatNode>`);
    p(`          <aces:Saturation>${_esc(Number(cdl.sat ?? 1.0).toFixed(6))}</aces:Saturation>`);
    p(`        </aces:SatNode>`);
    p(`      </aces:ascCDL>`);

    p(`    </aces:lookTransform>`);
    p(``);
  } else if (
    !hasCdl &&
    (safeMode === 'match_editorial' || safeMode === 'review_proxy')
  ) {
    warnings.push(`Mode is ${safeMode} but no CDL was provided. Look transform omitted.`);
  }

  // ── Output Transform ─────────────────────────────────────────────────────
  // VFX pull: no output transform for ocf_native / match_editorial.
  // review_proxy: add Rec.709 viewing ODT.
  if (safeMode === 'review_proxy') {
    p(`    <aces:outputTransform applied="false">`);
    p(`      <aces:description>${_esc('Rec.709 100-nit dim viewing transform (review proxy output)')}</aces:description>`);
    p(`      <aces:transformId>${_esc(REC709_ODT_URN)}</aces:transformId>`);
    p(`    </aces:outputTransform>`);
    p(``);
  }

  p(`  </aces:pipeline>`);

  // ── Notes ─────────────────────────────────────────────────────────────────
  if (fps || frameStart != null || targetResolution || timeline?.recIn || timeline?.recOut) {
    warnings.push(`Timeline: fps=${fps || 'unknown'}, frameStart=${frameStart ?? 'unknown'}, target=${targetResolution || 'source'}.`);
    if (timeline?.recIn || timeline?.recOut) warnings.push(`Record range: ${timeline.recIn || '?'} - ${timeline.recOut || '?'}.`);
  }
  if (colorMatch?.confidence != null) {
    warnings.push(`QT reference CDL confidence: ${Math.round(Number(colorMatch.confidence) || 0)}%; preview sidecar only, not baked into ACES EXR.`);
  }
  if (retime?.hasSpeedChange) {
    warnings.push(`Retime: ${retime.originalSummary || `${Math.round(retime.speedPercent || 100)}%`} (${retime.mode || 'source_frames_only'}).`);
  }
  if (reframe?.scale || reframe?.crop || reframe?.fit || reframe?.mode) {
    warnings.push(`Reframe: ${reframe.mode || reframe.fit || 'timeline'}${reframe.scale ? `, scale=${reframe.scale}` : ''}${reframe.crop ? `, crop=${reframe.crop}` : ''}.`);
  }
  if (warnings.length > 0) {
    p(``);
    p(`  <aces:notes>`);
    for (const w of warnings) {
      p(`    <aces:note>${_esc(w)}</aces:note>`);
    }
    p(`  </aces:notes>`);
  }

  p(``);
  p(`</aces:acesMetadataFile>`);

  return { ok: true, xml: lines.join('\n'), warnings };
}
