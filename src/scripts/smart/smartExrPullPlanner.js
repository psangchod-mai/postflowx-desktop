// smartExrPullPlanner.js — PostFlowX EXR pull job planner
// Converts matched timeline events → structured EXR export job objects.

import { buildNamingContext } from './smartExrNamingEngine.js';
import { extractGeometry, GEOMETRY_BAKE } from '../features/vfxPull/geometryEngine.js';
import { buildColorPlan, PULL_MODE }      from '../features/vfxPull/colorPlanEngine.js';
import { buildPackagePaths }              from '../features/vfxPull/packagePaths.js';
import { parseTransitionFrames }          from '../modules/pullRange.js';

export { PULL_MODE }        from '../features/vfxPull/colorPlanEngine.js';
export { GEOMETRY_BAKE }    from '../features/vfxPull/geometryEngine.js';

// Netflix VFX post production spec defaults:
//   - ACES 2065-1 (AP0 linear) color space
//   - 16 handle frames minimum (Netflix drama/features standard)
//   - 16-bit half float EXR (Netflix required)
//   - ZIP lossless compression (Netflix approved; PIZ also OK)
//   - Frame start 1001 (industry standard)
export const DEFAULT_CONFIG = {
  handleFrames: 16,           // Netflix: 16f minimum for drama/features
  frameStart: 1001,
  resolution: 'camera_native',
  exr: {
    bitDepth: 'half',         // Netflix: 16-bit half float required
    compression: 'zip',       // Netflix: ZIP or PIZ (lossless only)
    channels: 'rgb',
  },
  color: {
    mode: 'aces',             // Netflix: ACES 2065-1 required for VFX
    acesOutput: null,
    ocioConfig: null,
    amf: null,
  },
  retime: {
    mode: 'source_frames_only',
    speed: 1.0,
  },
  outputBasePath: '',
};

// SMPTE non-drop timecode labels frames on a WHOLE-frame base: 23.976 counts at
// 24, 29.97 NDF at 30. Multiplying by the fractional rate yields non-integer
// frame counts that break frame↔TC round-trips (see utils_time.timecodeToFrames).
// Round to the integer base. Drop-frame is treated as non-drop here (separators
// are normalised), matching the planner's existing behaviour.
function _tcBase(fps) { return Math.max(1, Math.round(Number(fps) || 24)); }

function tcToFrames(tc, fps = 24) {
  if (!tc) return NaN;
  const parts = String(tc).replace(/[;,]/g, ':').split(':');
  if (parts.length < 4) return NaN;
  const [h, m, s, f] = parts.map(Number);
  if ([h, m, s, f].some(isNaN)) return NaN;
  return ((h * 3600 + m * 60 + s) * _tcBase(fps)) + f;
}

function framesToTc(frames, fps = 24) {
  const base = _tcBase(fps);
  const h = Math.floor(frames / (3600 * base));
  frames -= h * 3600 * base;
  const m = Math.floor(frames / (60 * base));
  frames -= m * 60 * base;
  const s = Math.floor(frames / base);
  const f = Math.round(frames - s * base);
  return [h, m, s, f].map(n => String(n).padStart(2, '0')).join(':');
}

// detectSpeedChange — extract every spec-required retime field from a
// timeline event. NLEs encode speed in several inconsistent ways; this
// helper consolidates them into one shape that the companion ffmpeg baker
// (and the spec badge / QC report) can read.
//
// Event field precedence:
//   • event.speedKeys        — array of {tc/frame, speed} keyframes → dynamic ramp
//   • event.freeze           — explicit freeze-frame flag (or {frame})
//   • event.speedReversed    — explicit reverse flag
//   • event.speedFactor      — numeric speed multiplier (1.0 = 100%)
//   • event.speedPercent     — same as factor but in percent (100 = 1.0)
//   • event.speed            — generic catch-all (treated as percent OR factor
//                              depending on magnitude — see below)
//
// Returns spec shape:
//   { hasSpeedChange, isDynamic, speed (factor), speedPercent,
//     speedKeys, reversed, freeze, sourceFrameMap, originalSummary }
export function detectSpeedChange(event = {}) {
  // ── Dynamic speed ramp (keyframes) ─────────────────────────────────────
  const keys = Array.isArray(event.speedKeys) ? event.speedKeys.slice() : [];
  const isDynamic = keys.length > 1;

  // ── Freeze frame ───────────────────────────────────────────────────────
  // Accept boolean or {frame} object. When freeze is true with no explicit
  // frame, fall back to the event's srcIn-anchored "first frame".
  const freezeRaw = event.freeze ?? event.isFreeze ?? null;
  let freeze = null;
  if (freezeRaw && typeof freezeRaw === 'object') {
    freeze = { frame: freezeRaw.frame ?? freezeRaw.sourceFrame ?? null };
  } else if (freezeRaw === true) {
    freeze = { frame: null };
  }

  // ── Reverse ────────────────────────────────────────────────────────────
  const reversed = !!(event.speedReversed || event.reverse || event.reversed);

  // ── Constant speed factor ──────────────────────────────────────────────
  // Try the canonical fields in order; default to 1.0 (no change). Anything
  // > 5 is interpreted as percent (e.g. "200" = 200%); smaller numbers are
  // already a factor (e.g. 2.0 = 200%).
  let factor = 1.0;
  let percent = 100;
  if (Number.isFinite(event.speedFactor)) {
    factor  = Number(event.speedFactor);
    percent = factor * 100;
  } else if (Number.isFinite(event.speedPercent)) {
    percent = Number(event.speedPercent);
    factor  = percent / 100;
  } else if (Number.isFinite(event.speed)) {
    const s = Number(event.speed);
    if (Math.abs(s) > 5) { percent = s;       factor = s / 100; }
    else                 { factor  = s;       percent = s * 100; }
  }

  const constantSpeedChange = !isDynamic && Math.abs(percent - 100) > 0.5;
  const hasSpeedChange = isDynamic || constantSpeedChange || !!freeze || reversed;

  // ── Build sourceFrameMap when needed ───────────────────────────────────
  // For dynamic ramps the companion baker needs an explicit mapping from
  // output frame index → source frame to render. We don't compute the full
  // map here (that's the ffmpeg baker's job in #10b) but we DO precompute
  // it for simple cases: constant speed and reverse. Dynamic ramps without
  // enough data flag a warning instead.
  let sourceFrameMap = null;
  if (!isDynamic && !freeze && constantSpeedChange) {
    // Constant speed — the map is implicit (1 output frame = 1/factor source
    // frames). The companion can use setpts=PTS/factor without an explicit
    // map. Leave null and surface the factor; companion will derive.
    sourceFrameMap = null;
  } else if (reversed && !constantSpeedChange) {
    // Pure reverse with no speed change — companion uses ffmpeg reverse filter.
    sourceFrameMap = null;
  }
  // Dynamic ramps: companion will read speedKeys and refuse if it can't
  // resolve the map. The QC report's DYNAMIC_RETIME_UNSUPPORTED block fires
  // when speedKeys is present AND settings.bakeSpeed is on.

  // Original summary string — display-friendly representation of what the
  // NLE recorded. Useful for the export log + Nuke handoff labels.
  const originalSummary =
    event.speedSummary
    || event.speedComment
    || (isDynamic ? 'Dynamic speed ramp (keyframes)' :
        freeze   ? 'Freeze frame' :
        reversed ? `Reversed${constantSpeedChange ? ` at ${Math.round(percent)}%` : ''}` :
        constantSpeedChange ? `${Math.round(percent)}%` :
        '100% (normal speed)');

  return {
    hasSpeedChange,
    isDynamic,
    speed:          factor,
    speedPercent:   percent,
    speedKeys:      keys,
    reversed,
    freeze,
    sourceFrameMap,
    originalSummary,
  };
}

/**
 * Build an explicit output→source frame map for a dynamic (keyframed) retime.
 *
 * Model (documented so downstream tools agree): `speedKeys` are
 * `[{ tc|frame, speed }]` positioned along the clip timeline; `speed` is a
 * playback-rate factor (values > 5 are read as a percent, e.g. 200 → 2.0).
 * Between keyframes the rate is linearly interpolated (the constant-accel ramp
 * convention used by Resolve/Premiere), and the source advance per output frame
 * is that instantaneous rate, integrated cumulatively (trapezoidal).
 *
 * Returns one entry per OUTPUT frame { sourceFrame, sourceTC, speed, retimeType },
 * matching the schema the frame-map CSV writers (JS + companion) already read,
 * or null when there isn't enough keyframe data to resolve a ramp.
 */
export function buildDynamicSourceFrameMap(speedKeys, { srcInFrames, outputFrameCount, fps }) {
  const base = Math.max(1, Math.round(Number(fps) || 24));
  const keys = (Array.isArray(speedKeys) ? speedKeys : [])
    .map(k => {
      const posF = Number.isFinite(k.frame) ? Number(k.frame)
                 : (k.tc != null ? tcToFrames(k.tc, base) : NaN);
      let s = Number(k.speed);
      if (!Number.isFinite(s) || s === 0) s = 1;
      return { posF, factor: Math.abs(s) > 5 ? s / 100 : s };
    })
    .filter(k => Number.isFinite(k.posF))
    .sort((a, b) => a.posF - b.posF);
  if (keys.length < 2 || !(outputFrameCount > 0)) return null;

  // Normalise keyframe positions so the first sits at output frame 0.
  const start = keys[0].posF;
  const norm  = keys.map(k => ({ pos: k.posF - start, factor: k.factor }));
  const last  = norm[norm.length - 1];
  const rateAt = (f) => {
    if (f <= norm[0].pos) return norm[0].factor;
    if (f >= last.pos)    return last.factor;
    for (let i = 1; i < norm.length; i++) {
      if (f <= norm[i].pos) {
        const a = norm[i - 1], b = norm[i];
        const t = (f - a.pos) / Math.max(1e-6, b.pos - a.pos);
        return a.factor + t * (b.factor - a.factor);
      }
    }
    return last.factor;
  };

  const map = [];
  let advance = 0;                       // cumulative source frames advanced
  for (let i = 0; i < outputFrameCount; i++) {
    const sourceFrame = Math.max(0, Math.round(srcInFrames + advance));
    const r = rateAt(i);
    map.push({
      sourceFrame,
      sourceTC:   framesToTc(sourceFrame, base),
      speed:      Math.round(r * 100),
      retimeType: 'dynamic',
    });
    advance += (r + rateAt(i + 1)) / 2;  // trapezoidal step to the next output frame
  }
  return map;
}

// Build one EXR job from a matched event.
export function buildExrJob({
  event = {},
  marker = {},
  matchResult = {},
  config = {},
  namingContext = null,
  projectMeta = {},
}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  cfg.exr = { ...DEFAULT_CONFIG.exr, ...(config.exr || {}) };
  cfg.color = { ...DEFAULT_CONFIG.color, ...(config.color || {}) };
  cfg.retime = { ...DEFAULT_CONFIG.retime, ...(config.retime || {}) };

  const fps = Number(event.fps || cfg.fps || 24);
  const baseHandles = Number(cfg.handleFrames ?? 8);
  // A dissolve/wipe overlaps neighbouring clips — its frames must be inside the
  // pull or compositors have to re-pull by hand. Extend handles by the transition
  // duration (both sides, since the event may be the incoming or outgoing clip).
  const transitionFrames = parseTransitionFrames(event.transition);
  const handles = baseHandles + transitionFrames;

  const srcInFrames  = tcToFrames(event.srcIn, fps);
  const srcOutFrames = tcToFrames(event.srcOut || event.srcIn, fps);
  const safeSrcIn  = Number.isFinite(srcInFrames)  ? srcInFrames  : 0;
  const safeSrcOut = Number.isFinite(srcOutFrames) ? srcOutFrames : safeSrcIn + (event.durationFrames || 24);
  const exportInFrames  = Math.max(0, safeSrcIn - handles);
  const exportOutFrames = safeSrcOut + handles;
  const expectedFrameCount = Math.max(1, exportOutFrames - exportInFrames + 1);

  const retimeInfo = detectSpeedChange(event);
  const retimeMode = retimeInfo.hasSpeedChange
    ? (cfg.retime.mode || 'source_frames_only')
    : 'source_frames_only';

  // When baking speed into the EXR sequence, the rendered frame count
  // changes: 200% speed → half the frames; 50% → double. Pure reverse keeps
  // the count; dynamic ramps need the companion to resolve at render time.
  // Freeze: the single source frame to HOLD is the editorial freeze frame
  // (= srcIn), NOT the handle-extended in-point. Carry it explicitly (absolute
  // source frame) so the frame map holds the right frame — it was defaulting to
  // exportIn (= srcIn − handles), i.e. `handles` frames too early.
  if (retimeInfo.freeze) {
    const ff = retimeInfo.freeze.frame;
    retimeInfo.freezeSourceFrame = (ff != null && Number.isFinite(Number(ff))) ? Number(ff) : safeSrcIn;
  }

  let bakedFrameCount = expectedFrameCount;
  if (retimeMode === 'bake_to_timeline' && retimeInfo.hasSpeedChange) {
    if (retimeInfo.freeze) {
      // (audit E1) A freeze holds ONE source frame for the full TIMELINE
      // duration, so the source span (expectedFrameCount) — which collapses
      // toward a single frame + handles — can't define the rendered length.
      // Derive the baked count from the clip's timeline duration + handles on
      // both sides, so the sequence is as long as the freeze occupies in the
      // cut. Prefer event.durationFrames; fall back to recOut−recIn, then to
      // expectedFrameCount when no timeline duration is known (no regression).
      const recInF  = tcToFrames(event.recIn,  fps);
      const recOutF = tcToFrames(event.recOut, fps);
      const recordSpan = (Number.isFinite(recInF) && Number.isFinite(recOutF) && recOutF > recInF)
        ? (recOutF - recInF) : NaN;
      const timelineDur = (Number.isFinite(Number(event.durationFrames)) && Number(event.durationFrames) > 0)
        ? Number(event.durationFrames) : recordSpan;
      bakedFrameCount = (Number.isFinite(timelineDur) && timelineDur > 0)
        ? Math.round(timelineDur) + 2 * handles
        : expectedFrameCount;
    } else if (retimeInfo.isDynamic) {
      bakedFrameCount = expectedFrameCount; // companion resolves from sourceFrameMap
    } else if (Number.isFinite(retimeInfo.speed) && retimeInfo.speed > 0) {
      bakedFrameCount = Math.max(1, Math.round(expectedFrameCount / retimeInfo.speed));
    }
  }

  // Resolve dynamic speed ramps into an explicit output→source frame map so the
  // frame-map sidecar (Nuke/Resolve conform contract) is correct and engines
  // that read it can bake frame-accurately. Anchored on the handled in-point.
  if (retimeInfo.isDynamic && !retimeInfo.sourceFrameMap) {
    const dynMap = buildDynamicSourceFrameMap(retimeInfo.speedKeys, {
      srcInFrames:      exportInFrames,
      outputFrameCount: bakedFrameCount,
      fps,
    });
    if (dynMap) retimeInfo.sourceFrameMap = dynMap;
  }

  const naming = namingContext || buildNamingContext({
    event,
    marker,
    plateType: marker?.plateType || 'PL',
  });

  // ── Package paths ── exr/ metadata/ review/ nuke/ ─────────────────────────
  const pkg = buildPackagePaths(cfg.outputBasePath || '', naming.plateName, naming.shotName);

  // ── Geometry ──────────────────────────────────────────────────────────────
  const geometry = extractGeometry(event, {
    timelineResolution: projectMeta.timelineResolution || cfg.timelineResolution || '',
    outputResolution:   projectMeta.targetResolution   || cfg.targetResolution   || '',
  });
  if (geometry.hasGeometry && cfg.bakeGeometry !== false) {
    geometry.bakeMode = GEOMETRY_BAKE.BAKED;
  }

  // ── Color plan ─────────────────────────────────────────────────────────────
  const pullMode  = cfg.pullMode || PULL_MODE.OCF_NATIVE;
  const colorPlan = buildColorPlan(
    {
      sourcePath: matchResult.matchedPath || '',
      color: cfg.color,
      event,
      ocf: marker,
      metadata: {
        ...projectMeta,
        cameraModel: marker?.cameraModel || marker?.camera || projectMeta.cameraModel || '',
        codec: marker?.codec || marker?.format || event.codec || '',
        sourceReel: event.reel || marker?.reel || '',
      },
    },
    pullMode,
    {
      ocioConfig:       cfg.ocioConfig || '',
      showLut:          cfg.showLut   || '',
      odtName:          cfg.odtName   || '',
      // Project colorspace from the Smart VFX Pull Setup modal — colorPlanEngine
      // only applies it to review-proxy output (plates stay ACES2065-1).
      outputColorSpace: cfg.color?.outputColorSpace || '',
    }
  );

  // Reframe block — populated from geometry for companion vf chain
  const reframe = {};
  const targetWidth  = Number(cfg.reframe?.targetWidth)  || null;
  const targetHeight = Number(cfg.reframe?.targetHeight) || null;
  if (geometry.hasGeometry && geometry.bakeMode === 'baked') {
    if (geometry.ffmpegCrop)  reframe.crop  = geometry.ffmpegCrop;
    if (geometry.ffmpegScale) reframe.scale = geometry.ffmpegScale;
  }
  if (targetWidth && targetHeight) {
    reframe.targetWidth  = targetWidth;
    reframe.targetHeight = targetHeight;
    reframe.mode = cfg.reframe?.mode || (geometry.bakeMode === 'baked' ? 'baked' : 'sidecar');
  }

  return {
    jobType: 'render_pull_exr',
    pullMode,
    shotId: naming.shotName,
    eventNumber: String(event.eventNumber || event._pmEventIdx || '001').padStart(3, '0'),
    sourcePath: matchResult.matchedPath || '',
    sourceIn: event.srcIn || '',
    sourceOut: event.srcOut || event.srcIn || '',
    exportIn: framesToTc(exportInFrames, fps),
    exportOut: framesToTc(exportOutFrames, fps),
    fps,
    handleFrames: handles,
    frameStart: cfg.frameStart,
    // Original (un-baked) source-range frame count, preserved for FDL/QC.
    expectedFrameCount,
    // Rendered frame count after speed bake — what the EXR sequence on
    // disk will actually contain. Equal to expectedFrameCount when no
    // speed bake or when bake mode is 'source_frames_only'.
    expectedRenderedFrameCount: bakedFrameCount,
    frameCount: bakedFrameCount,
    outputDir: pkg.exr,
    outputBase: cfg.outputBasePath || '',
    outputPattern: naming.pattern,
    plateName: naming.plateName,
    naming,
    package: pkg,
    exr: { ...cfg.exr },
    color: {
      ...cfg.color,
      amf: event._amfPath || cfg.color.amf || null,
      idtName: colorPlan.idtName || cfg.color.idtName || '',
      idtUrn: colorPlan.idtUrn || cfg.color.idtUrn || null,
      cameraProfile: colorPlan.cameraProfile || '',
      cameraFamily: colorPlan.cameraFamily || '',
    },
    colorPlan,
    geometry,
    reframe: Object.keys(reframe).length ? reframe : null,
    // Full retime block per spec. Companion ffmpeg baker reads:
    //   • mode             — 'bake_to_timeline' triggers speed/reverse/freeze
    //   • hasSpeedChange   — short-circuit when false
    //   • isDynamic        — bail with manual-review error if no map
    //   • speed            — factor for setpts=PTS/factor
    //   • speedPercent     — display only
    //   • speedKeys        — when dynamic, resolve the per-output-frame map
    //   • reversed         — apply ffmpeg `reverse` filter
    //   • freeze           — repeat a single source frame
    //   • sourceFrameMap   — explicit output→source map when present
    //   • originalSummary  — for export log + Nuke handoff labels
    retime: {
      mode:            retimeMode,
      hasSpeedChange:  retimeInfo.hasSpeedChange,
      isDynamic:       retimeInfo.isDynamic,
      speed:           retimeInfo.speed,
      speedPercent:    retimeInfo.speedPercent,
      speedKeys:       retimeInfo.speedKeys,
      reversed:        retimeInfo.reversed,
      freeze:          retimeInfo.freeze,
      freezeSourceFrame: retimeInfo.freezeSourceFrame,
      sourceFrameMap:  retimeInfo.sourceFrameMap,
      originalSummary: retimeInfo.originalSummary,
    },
    renderPlan: {
      bakeSpeed:     retimeMode === 'bake_to_timeline',
      bakeReframe:   cfg.bakeGeometry !== false && cfg.reframe?.mode !== 'none',
      targetWidth,
      targetHeight,
      targetResolution: targetWidth && targetHeight ? `${targetWidth}x${targetHeight}` : (cfg.resolution || ''),
      sourceFrameCount: expectedFrameCount,
      renderedFrameCount: bakedFrameCount,
      frameMapPolicy: retimeInfo.sourceFrameMap ? 'explicit' : (retimeInfo.hasSpeedChange ? 'derived' : 'linear'),
    },
    metadata: {
      timelineName: projectMeta.timelineName || '',
      projectName: projectMeta.projectName || '',
      recIn: event.recIn || '',
      recOut: event.recOut || '',
      targetResolution: targetWidth && targetHeight ? `${targetWidth}x${targetHeight}` : (cfg.resolution || ''),
      timelineResolution: projectMeta.timelineResolution || cfg.timelineResolution || '',
      sourceReel: event.reel || '',
      cameraModel: marker?.cameraModel || marker?.camera || projectMeta.cameraModel || '',
      cameraProfile: colorPlan.cameraProfile || '',
      idtName: colorPlan.idtName || '',
      idtUrn: colorPlan.idtUrn || null,
      shotName: naming.shotName,
      plateName: naming.plateName,
      vendor: projectMeta.vendor || '',
      notes: marker?.note || event.note || '',
      matchConfidence: matchResult.confidence ?? 0,
      matchStatus: matchResult.status || 'MISSING',
    },
    status: matchResult.matchedPath ? 'ready' : 'missing_ocf',
    _eventRef: event,
    _markerRef: marker,
  };
}

// Build all EXR jobs from a list of match results.
export function buildAllExrJobs(matchResults = [], config = {}, projectMeta = {}) {
  const usedNames = new Set();
  const existingPlatesByShot = {};
  const projectNaming   = config.projectNaming   || {};
  const defaultPlateType = config.defaultPlateType || 'PL';

  return matchResults.map((r, i) => {
    let   event  = r.event || {};
    const marker = r.match?.matchedPath ? (r.ocf || {}) : {};

    // When no PostFlowX PM shot name is set, derive from the matched OCF filename.
    // Camera originals are named SHOTNAME_ROLLCODE.ext; stripping the roll suffix
    // (e.g. _A001C001) gives the authoritative shot name even when the Resolve clip
    // name was imported with a different convention.
    if (!event._pmShot && r.match?.matchedPath) {
      const ocfFile = (r.ocf?.name || r.match.matchedPath.split('/').pop()).replace(/\.[^.]+$/, '');
      // Skip pure camera-roll names (A001C001 …) — they carry no shot identity.
      const isPureCamRoll = /^[A-Z]\d{3}[A-Z]/i.test(ocfFile) && !/[_]/.test(ocfFile.slice(0, 7));
      if (!isPureCamRoll) {
        const stripped = ocfFile.replace(/_[A-Z]\d{3}[A-Z]\d{3,}[^_]*$/i, '');
        if (stripped && stripped.length > 3) {
          event = { ...event, _pmShot: stripped };
        }
      }
    }

    const shotKey = event._pmShot || event.reel || event.clipName || `shot_${i}`;

    if (!existingPlatesByShot[shotKey]) existingPlatesByShot[shotKey] = [];

    // Prefer per-event plate ID injected by VFX Pull panel; fall back to
    // global config type (from naming template plate chip) so the user's chosen
    // plate type (BG, FG, PL …) is reflected instead of always defaulting to PL.
    const plateId   = event._pfxPlateId   || null;
    const plateType = event._pfxPlateType || defaultPlateType;

    const namingCtx = buildNamingContext({
      event, marker,
      plateId,
      plateType,
      existingPlates: existingPlatesByShot[shotKey],
      projectNaming,
      usedNames,
    });
    existingPlatesByShot[shotKey].push(namingCtx.plateName);

    return buildExrJob({
      event,
      marker,
      matchResult: r.match || {},
      config,
      namingContext: namingCtx,
      projectMeta,
    });
  });
}
