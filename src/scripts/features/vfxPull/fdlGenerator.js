// fdlGenerator.js — PostFlowX FDL (Frame/Format Decision List) generator
// Builds per-shot FDL objects that tell downstream tools exactly what frames
// to pull, how to reformat them, and what color pipeline to use.
//
// Exports:
//   buildFDL(params)      → FDL object
//   buildFDLJson(fdl)     → JSON string (pretty-printed, 2-space indent)
//   buildFDLCsv(fdls)     → CSV string (array of FDL objects → single CSV)
//   buildFDLTxt(fdl)      → Human-readable block text

import { resolveIdtFromOCFMeta } from '../aceslook/services/ocfIdtResolver.js';

const FDL_SCHEMA = 'postflowx.vfxpull.fdl.v1';
const APP_VERSION = 'PostFlowX 2026.5.2';

// uuid-v4 without a dependency (crypto.randomUUID is in Electron renderer + Node 16+).
function _uuid() {
  try { return crypto.randomUUID(); } catch { /* fall through */ }
  // RFC4122-ish fallback (used only if crypto.randomUUID is unavailable)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0; const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── Internal helpers ───────────────────────────────────────────────────────────

/**
 * Parse a resolution string like "4608x3164" into { w, h }.
 * Returns null if unparseable.
 */
function _parseResolution(str) {
  if (!str) return null;
  const m = String(str).match(/^(\d+)[xX×](\d+)$/);
  if (!m) return null;
  return { w: parseInt(m[1], 10), h: parseInt(m[2], 10) };
}

/**
 * Compute a basic uniform scale from source resolution to reference resolution.
 * Uses the smaller of the two scale ratios so the image fits within the reference.
 * Returns a number rounded to 4 decimal places, or null if either resolution is unknown.
 */
function _computeBasicScale(sourceResStr, refResStr) {
  const src = _parseResolution(sourceResStr);
  const ref = _parseResolution(refResStr);
  if (!src || !ref) return null;
  const scaleW = ref.w / src.w;
  const scaleH = ref.h / src.h;
  return Math.round(Math.min(scaleW, scaleH) * 10000) / 10000;
}

/**
 * Escape a value for CSV output. Wraps in double-quotes if the value
 * contains commas, double-quotes, or newlines. Doubles any internal quotes.
 */
function _csvCell(val) {
  const s = val === null || val === undefined ? '' : String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Build an FDL object from pull-planner job, match result, and optional extras.
 *
 * @param {Object} params
 * @param {Object} params.job            - EXR job object from smartExrPullPlanner
 * @param {Object} params.matchResult    - Match result from smartOcfMatcher
 * @param {Object} [params.referenceInfo] - { path, tcIn, tcOut, width, height,
 *                                           reformat: { scale, crop, fit, notes } }
 * @param {string} [params.amfFileName]  - AMF filename
 * @param {string} [params.pullMode]     - 'ocf_native' | 'match_editorial' | 'review_proxy'
 * @param {Object} [params.projectMeta]  - { show, episode, reel, timelineName }
 * @returns {Object} FDL object matching schema postflowx.vfxpull.fdl.v1
 */
export function buildFDL({
  job = {},
  matchResult = {},
  referenceInfo = null,
  amfFileName = '',
  pullMode = 'match_editorial',
  projectMeta = {},
} = {}) {
  // ── Shot / plate names ────────────────────────────────────────────────────
  const shotName  = job.shotId || job.metadata?.shotName || '';
  const plateName = job.plateName || job.naming?.plateName || '';

  // ── Source ────────────────────────────────────────────────────────────────
  const sourceResolution = job.naming?.resolution
    || matchResult.resolution
    || '';

  const source = {
    path:        job.sourcePath || matchResult.matchedPath || '',
    clipName:    job.naming?.clipName
                 || matchResult.clipName
                 || matchResult.matchedClipName
                 || '',
    tcIn:        job.exportIn   || job.sourceIn  || '',
    tcOut:       job.exportOut  || job.sourceOut || '',
    fps:         String(job.fps || ''),
    resolution:  sourceResolution,
  };

  // ── Reference ─────────────────────────────────────────────────────────────
  const refResolution = referenceInfo
    ? (referenceInfo.width && referenceInfo.height
        ? `${referenceInfo.width}x${referenceInfo.height}`
        : referenceInfo.resolution || '')
    : '';

  const reference = referenceInfo ? {
    path:       referenceInfo.path || '',
    tcIn:       referenceInfo.tcIn  || '',
    tcOut:      referenceInfo.tcOut || '',
    resolution: refResolution,
  } : {
    path:       '',
    tcIn:       '',
    tcOut:      '',
    resolution: '',
  };

  // ── Frame range ───────────────────────────────────────────────────────────
  // Use the RENDERED frame count (what's actually on disk) — for a speed-baked
  // pull this differs from the source span (expectedFrameCount), so advertising
  // expectedFrameCount would give the FDL a range that doesn't match the plate.
  const frameStart     = job.frameStart ?? 1001;
  const expectedFrames = job.expectedRenderedFrameCount ?? job.expectedFrameCount ?? 1;
  const frameEnd       = frameStart + expectedFrames - 1;
  const handles        = job.handleFrames ?? 8;

  // ── Reformat ──────────────────────────────────────────────────────────────
  let reformatObj;
  if (referenceInfo?.reformat) {
    // Explicit reformat provided — use it verbatim. Accept both `crop` (the
    // legacy field name) and `cropBox` (the spec field — what
    // computeReformatParams returns). Storing under both so old + new FDL
    // consumers keep working.
    const rf = referenceInfo.reformat;
    const cropArr = rf.crop ?? rf.cropBox ?? null;
    reformatObj = {
      scale:   rf.scale ?? null,
      crop:    cropArr,
      cropBox: cropArr,
      fit:     rf.fit   ?? 'centerCrop',
      notes:   rf.notes ?? '',
    };
  } else {
    // Compute basic scale from resolutions if available
    const basicScale = _computeBasicScale(sourceResolution, refResolution);
    reformatObj = {
      scale: basicScale,
      crop:  null,
      fit:   'centerCrop',
      notes: basicScale !== null
        ? `Auto-computed scale from ${sourceResolution} → ${refResolution}`
        : '',
    };
  }

  // ── Pull ──────────────────────────────────────────────────────────────────
  const pull = {
    handles,
    frameStart,
    frameEnd,
    outputFormat:      job.exr ? 'EXR' : (job.outputFormat || 'EXR'),
    outputColorSpace:  job.color?.mode === 'aces'
                         ? 'ACES2065-1 AP0'
                         : (job.color?.outputColorSpace || 'ACES2065-1 AP0'),
    outputResolution:  job.color?.resolution || 'source',
    referenceReformat: reformatObj,
  };

  // ── Color ─────────────────────────────────────────────────────────────────
  const resolvedAmf = amfFileName
    || job.color?.amf
    || (plateName ? `${plateName}.amf` : '');

  const color = {
    amf:  resolvedAmf,
    mode: pullMode,
  };

  // ── QC ────────────────────────────────────────────────────────────────────
  const qc = {
    matchMethod: matchResult.matchMethod || matchResult.method || 'timecode',
    confidence:  matchResult.confidence  ?? 0,
    warnings:    Array.isArray(matchResult.warnings) ? [...matchResult.warnings] : [],
  };

  // ── Meta ──────────────────────────────────────────────────────────────────
  const meta = {
    generatedAt: new Date().toISOString(),
    appVersion:  APP_VERSION,
    show:        projectMeta.show     || '',
    episode:     projectMeta.episode  || '',
    reel:        projectMeta.reel     || job.metadata?.sourceReel || '',
  };

  return {
    schema:     FDL_SCHEMA,
    shotName,
    plateName,
    source,
    reference,
    pull,
    color,
    qc,
    meta,
  };
}

/**
 * Serialize an FDL object to a pretty-printed JSON string.
 *
 * @param {Object} fdl - FDL object from buildFDL()
 * @returns {string}
 */
export function buildFDLJson(fdl) {
  return JSON.stringify(fdl, null, 2);
}

/**
 * Serialize an array of FDL objects to a CSV string.
 * First row is the header; subsequent rows are data.
 *
 * @param {Object[]} fdls - Array of FDL objects from buildFDL()
 * @returns {string}
 */
export function buildFDLCsv(fdls) {
  if (!Array.isArray(fdls) || fdls.length === 0) return '';

  const HEADERS = [
    'schema',
    'shotName',
    'plateName',
    'sourcePath',
    'sourceClipName',
    'sourceTcIn',
    'sourceTcOut',
    'sourceFps',
    'sourceResolution',
    'refPath',
    'refTcIn',
    'refTcOut',
    'refResolution',
    'pullHandles',
    'pullFrameStart',
    'pullFrameEnd',
    'outputFormat',
    'outputColorSpace',
    'outputResolution',
    'reformatScale',
    'reformatCrop',
    'reformatFit',
    'reformatNotes',
    'colorAmf',
    'colorMode',
    'matchMethod',
    'confidence',
    'warnings',
    'generatedAt',
  ];

  const rows = fdls.map(fdl => {
    const rf = fdl.pull?.referenceReformat || {};
    const cropStr = Array.isArray(rf.crop) ? rf.crop.join(' ') : (rf.crop ?? '');
    const warnStr = Array.isArray(fdl.qc?.warnings)
      ? fdl.qc.warnings.join('; ')
      : '';

    return [
      fdl.schema                       ?? '',
      fdl.shotName                     ?? '',
      fdl.plateName                    ?? '',
      fdl.source?.path                 ?? '',
      fdl.source?.clipName             ?? '',
      fdl.source?.tcIn                 ?? '',
      fdl.source?.tcOut                ?? '',
      fdl.source?.fps                  ?? '',
      fdl.source?.resolution           ?? '',
      fdl.reference?.path              ?? '',
      fdl.reference?.tcIn              ?? '',
      fdl.reference?.tcOut             ?? '',
      fdl.reference?.resolution        ?? '',
      fdl.pull?.handles                ?? '',
      fdl.pull?.frameStart             ?? '',
      fdl.pull?.frameEnd               ?? '',
      fdl.pull?.outputFormat           ?? '',
      fdl.pull?.outputColorSpace       ?? '',
      fdl.pull?.outputResolution       ?? '',
      rf.scale                         ?? '',
      cropStr,
      rf.fit                           ?? '',
      rf.notes                         ?? '',
      fdl.color?.amf                   ?? '',
      fdl.color?.mode                  ?? '',
      fdl.qc?.matchMethod              ?? '',
      fdl.qc?.confidence               ?? '',
      warnStr,
      fdl.meta?.generatedAt            ?? '',
    ].map(_csvCell).join(',');
  });

  return [HEADERS.join(','), ...rows].join('\r\n');
}

/**
 * Serialize an FDL object to a human-readable text block.
 *
 * @param {Object} fdl - FDL object from buildFDL()
 * @returns {string}
 */
export function buildFDLTxt(fdl) {
  const lines = [];
  const p  = s => lines.push(s);
  const kv = (label, val) => p(`  ${label.padEnd(28)} ${val ?? ''}`);
  const nl = () => p('');

  p('='.repeat(72));
  p(`  PostFlowX FDL — Frame/Format Decision List`);
  p(`  Schema: ${fdl.schema ?? ''}`);
  p('='.repeat(72));
  nl();

  // Shot
  p('SHOT');
  p('-'.repeat(72));
  kv('Shot Name:',    fdl.shotName);
  kv('Plate Name:',   fdl.plateName);
  nl();

  // Source
  p('SOURCE');
  p('-'.repeat(72));
  kv('Path:',         fdl.source?.path);
  kv('Clip Name:',    fdl.source?.clipName);
  kv('TC In:',        fdl.source?.tcIn);
  kv('TC Out:',       fdl.source?.tcOut);
  kv('FPS:',          fdl.source?.fps);
  kv('Resolution:',   fdl.source?.resolution);
  nl();

  // Reference
  p('REFERENCE');
  p('-'.repeat(72));
  kv('Path:',         fdl.reference?.path || '(none)');
  kv('TC In:',        fdl.reference?.tcIn);
  kv('TC Out:',       fdl.reference?.tcOut);
  kv('Resolution:',   fdl.reference?.resolution);
  nl();

  // Pull
  p('PULL');
  p('-'.repeat(72));
  kv('Handles:',           fdl.pull?.handles);
  kv('Frame Start:',       fdl.pull?.frameStart);
  kv('Frame End:',         fdl.pull?.frameEnd);
  kv('Output Format:',     fdl.pull?.outputFormat);
  kv('Output Color Space:',fdl.pull?.outputColorSpace);
  kv('Output Resolution:', fdl.pull?.outputResolution);
  nl();

  // Reformat
  const rf = fdl.pull?.referenceReformat;
  if (rf) {
    p('REFERENCE REFORMAT');
    p('-'.repeat(72));
    kv('Scale:',    rf.scale !== null && rf.scale !== undefined ? rf.scale : '(auto)');
    kv('Crop:',     Array.isArray(rf.crop) ? rf.crop.join(', ') : (rf.crop || '(none)'));
    kv('Fit:',      rf.fit);
    kv('Notes:',    rf.notes);
    nl();
  }

  // Color
  p('COLOR');
  p('-'.repeat(72));
  kv('AMF File:',   fdl.color?.amf || '(none)');
  kv('Mode:',       fdl.color?.mode);
  nl();

  // QC
  p('QC / MATCH');
  p('-'.repeat(72));
  kv('Match Method:',  fdl.qc?.matchMethod);
  kv('Confidence:',    fdl.qc?.confidence !== undefined ? `${fdl.qc.confidence}%` : '');
  const warnings = fdl.qc?.warnings;
  if (Array.isArray(warnings) && warnings.length > 0) {
    kv('Warnings:',    warnings[0]);
    for (let i = 1; i < warnings.length; i++) {
      kv('', warnings[i]);
    }
  } else {
    kv('Warnings:',    '(none)');
  }
  nl();

  // Meta
  p('META');
  p('-'.repeat(72));
  kv('Generated At:',  fdl.meta?.generatedAt);
  kv('App Version:',   fdl.meta?.appVersion);
  kv('Show:',          fdl.meta?.show || '(not set)');
  kv('Episode:',       fdl.meta?.episode || '(not set)');
  kv('Reel:',          fdl.meta?.reel || '(not set)');
  nl();

  p('='.repeat(72));

  return lines.join('\n');
}

/**
 * generateASCFDLv2 — emit standards-compliant ASC FDL v2.0 JSON for pull
 * delivery (Netflix Footage Management Pulls Workstream / Baselight / Resolve
 * import), replacing the proprietary `postflowx.vfxpull.fdl.v1` schema. Keeps
 * the internal pull-plan model unchanged — this is serialization only.
 *
 * @param {Object} pullPlan  - { label|showName, width, height, shots|clips[] }
 * @param {Object} [ocfMeta] - optional OCF metadata; its resolved IDT label is
 *                             appended to the FDL label for traceability.
 * @returns {string} pretty-printed ASC FDL v2.0 JSON
 */
export function generateASCFDLv2(pullPlan = {}, ocfMeta = null) {
  const rows = pullPlan.shots || pullPlan.clips || [];

  const _dims = (shot, kind) => ({
    width:  shot[`${kind}Width`]  || shot.width  || shot.sourceWidth  || pullPlan.width  || 0,
    height: shot[`${kind}Height`] || shot.height || shot.sourceHeight || pullPlan.height || 0,
  });

  const canvases = rows.map((shot, i) => {
    const canvasId = shot.canvasId || `canvas_${i + 1}`;
    const dim = { width: shot.width || shot.sourceWidth || pullPlan.width || 0,
                  height: shot.height || shot.sourceHeight || pullPlan.height || 0 };
    if (!dim.width || !dim.height) {
      try { console.warn('[FDL v2.0] canvas has zero dimension:', shot.clipName || canvasId); } catch {}
    }
    return {
      id: canvasId,
      label: shot.reelName || shot.clipName || canvasId,
      width: dim.width, height: dim.height,
      imageContainer: {
        dimensions: dim,
        pixelAspectRatio: shot.par || 1.0,
        photometricCharacteristic: 'linear',
      },
      framing: {
        dimensions: _dims(shot, 'framing'),
        anchor: { x: shot.framingOffsetX || 0, y: shot.framingOffsetY || 0 },
      },
    };
  });

  const framingDecisions = rows.map((shot, i) => ({
    id: shot.fdId || `fd_${i + 1}`,
    label: shot.shotLabel || shot.clipName || `Shot ${i + 1}`,
    canvas: shot.canvasId || `canvas_${i + 1}`,
    framing: {
      dimensions: _dims(shot, 'framing'),
      anchor: { x: shot.framingOffsetX || 0, y: shot.framingOffsetY || 0 },
    },
  }));

  const idtLabel = ocfMeta ? ` [${resolveIdtFromOCFMeta(ocfMeta).colorSpaceLabel}]` : '';

  const fdl = {
    $schema: 'https://www.ascfdl.org/schema/v2.0/fdl.json',
    version: '2.0',
    uuid:    _uuid(),
    label:   (pullPlan.label || pullPlan.showName || 'VFX Pull') + idtLabel,
    default: canvases[0]?.id || 'canvas_1',
    canvases,
    framingDecisions,
  };

  return JSON.stringify(fdl, null, 2);
}
