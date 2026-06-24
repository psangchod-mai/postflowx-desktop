// pullJobModel.js — PostFlowX VFX Pull
// Canonical PullJob schema + factory that merges planner output with
// geometry, color plan, and output-package paths.
//
// This is the single source of truth for what gets sent to the companion's
// renderPullExr command and written into the pull report / frame map / QC JSON.

import { buildNamingContext } from '../../smart/smartExrNamingEngine.js';
import { buildExrJob }        from '../../smart/smartExrPullPlanner.js';
import { extractGeometry, GEOMETRY_BAKE }  from './geometryEngine.js';
import { buildColorPlan, PULL_MODE }        from './colorPlanEngine.js';
import { buildPackagePaths }               from './packagePaths.js';

export { PULL_MODE } from './colorPlanEngine.js';
export { GEOMETRY_BAKE } from './geometryEngine.js';

export const PLATE_VERSION_DEFAULT = 'v001';

export { buildPackagePaths } from './packagePaths.js';

// buildPullJob — primary factory; call once per matched event.
// Wraps the existing buildExrJob output and adds geometry + colorPlan blocks.
export function buildPullJob({
  event       = {},
  marker      = {},
  matchResult = {},
  config      = {},
  projectMeta = {},
}) {
  const pullMode = config.pullMode || PULL_MODE.OCF_NATIVE;
  const bakeGeometry = config.bakeGeometry !== false;

  // ── Base job from existing planner ──────────────────────────────────────────
  const naming = buildNamingContext({
    event, marker,
    plateType:      marker?.plateType || 'PL',
    existingPlates: config._existingPlates || [],
    usedNames:      config._usedNames || new Set(),
  });

  const base = buildExrJob({
    event, marker, matchResult, config, namingContext: naming, projectMeta,
  });

  // ── Geometry ────────────────────────────────────────────────────────────────
  const geometry = extractGeometry(event, {
    timelineResolution: projectMeta.timelineResolution || config.timelineResolution || '',
    outputResolution:   projectMeta.targetResolution   || config.targetResolution   || '',
  });
  if (geometry.hasGeometry && bakeGeometry) {
    geometry.bakeMode = GEOMETRY_BAKE.BAKED;
    // Propagate ffmpeg-compatible filter strings into the job for the companion.
    if (!base.reframe) base.reframe = {};
    if (geometry.ffmpegCrop)  base.reframe.crop  = geometry.ffmpegCrop;
    if (geometry.ffmpegScale) base.reframe.scale = geometry.ffmpegScale;
  } else if (geometry.hasGeometry) {
    geometry.bakeMode = GEOMETRY_BAKE.SIDECAR;
  }

  // ── Color plan ──────────────────────────────────────────────────────────────
  const colorPlan = buildColorPlan(
    {
      ...base,
      sourcePath: matchResult.matchedPath || base.sourcePath || '',
      event,
      ocf: matchResult.ocf || marker,
      metadata: {
        ...projectMeta,
        cameraModel: matchResult.ocf?.cameraModel || marker?.cameraModel || projectMeta.cameraModel || '',
        codec: matchResult.ocf?.codec || matchResult.ocf?.format || event.codec || '',
      },
    },
    pullMode,
    {
      timelineResolution: projectMeta.timelineResolution || '',
      targetResolution:   projectMeta.targetResolution   || '',
      ocioConfig:         config.ocioConfig              || '',
      showLut:            config.showLut                 || '',
      odtName:            config.odtName                 || '',
    }
  );

  // ── Package paths ────────────────────────────────────────────────────────────
  const outputBase = config.outputBasePath || projectMeta.outputFolder || '';
  const pkg = buildPackagePaths(outputBase, naming.plateName, naming.shotName);

  // Override outputDir to point at the exr/ subfolder
  base.outputDir = pkg.exr;

  return {
    ...base,
    // Override / extend
    jobType:    'render_pull_exr',
    pullMode,
    geometry,
    colorPlan,
    color: {
      ...(base.color || {}),
      idtName: colorPlan.idtName || base.color?.idtName || '',
      idtUrn: colorPlan.idtUrn || base.color?.idtUrn || null,
      cameraProfile: colorPlan.cameraProfile || '',
      cameraFamily: colorPlan.cameraFamily || '',
    },
    renderPlan: {
      ...(base.renderPlan || {}),
      bakeSpeed: config.retime?.mode === 'bake_to_timeline',
      bakeReframe: bakeGeometry,
      targetResolution: projectMeta.targetResolution || config.targetResolution || '',
      sourceFrameCount: base.expectedFrameCount || base.frameCount || 0,
      renderedFrameCount: base.expectedRenderedFrameCount || base.frameCount || 0,
    },
    package:    pkg,
    outputBase,
  };
}

// normalisePullJob — takes an existing buildExrJob output (no geometry/colorPlan)
// and attaches the missing blocks. Used when rebuilding state from persisted jobs.
export function normalisePullJob(job, config = {}, projectMeta = {}) {
  if (job.geometry && job.colorPlan) return job;   // already normalised
  const event = job._eventRef || {};
  const geometry = extractGeometry(event, {
    timelineResolution: projectMeta.timelineResolution || '',
    outputResolution:   config.targetResolution        || '',
  });
  const colorPlan = buildColorPlan(job, config.pullMode || PULL_MODE.OCF_NATIVE, {
    ocioConfig: config.ocioConfig || '',
    showLut:    config.showLut    || '',
    odtName:    config.odtName    || '',
  });
  const pkg = buildPackagePaths(
    config.outputBasePath || projectMeta.outputFolder || '',
    job.plateName || job.shotId || '',
    job.shotId || job.naming?.shotName || ''
  );
  return { ...job, geometry, colorPlan, package: pkg, pullMode: config.pullMode || PULL_MODE.OCF_NATIVE };
}

// buildFrameMapCSV — generate frame map CSV text from a PullJob.
// Each row: timelineFrame, outputFrame, sourceFile, sourceFrame, sourceTC, speed, retimeType
export function buildFrameMapCSV(job) {
  const rows = ['timelineFrame,outputFrame,sourceFile,sourceFrame,sourceTC,speed,retimeType'];
  const retime   = job.retime   || {};
  const frameStart = job.frameStart ?? 1001;
  const fps      = job.fps ?? 24;
  const srcFile  = (job.sourcePath || '').split('/').pop() || '';
  const frameCount = job.expectedRenderedFrameCount || job.frameCount || 0;

  // Use explicit sourceFrameMap if the planner built one
  if (Array.isArray(retime.sourceFrameMap) && retime.sourceFrameMap.length) {
    retime.sourceFrameMap.forEach((entry, idx) => {
      rows.push([
        frameStart + idx,
        frameStart + idx,
        srcFile,
        entry.sourceFrame ?? '',
        entry.sourceTC    ?? '',
        entry.speed       ?? retime.speedPercent ?? 100,
        entry.retimeType  ?? 'normal',
      ].join(','));
    });
    return rows.join('\n');
  }

  // Derive from retime block
  let srcStart = 0;
  {
    const srcIn = job.exportIn || job.sourceIn || '00:00:00:00';
    const p = srcIn.replace(/[;,]/g, ':').split(':');
    if (p.length >= 4) {
      srcStart = (+p[0] * 3600 + +p[1] * 60 + +p[2]) * fps + +p[3];
    }
  }

  for (let i = 0; i < frameCount; i++) {
    const outFrame = frameStart + i;
    let srcFrame, speed, retimeType;

    if (retime.freeze) {
      srcFrame = Math.round(srcStart);
      speed = 0;
      retimeType = 'freeze';
    } else if (retime.reversed) {
      // Walk the SOURCE span backward at the retime stride. Using the source
      // span (expectedFrameCount) — not the baked output count — keeps reverse
      // in-bounds when combined with a speed change; identical to the old
      // stride-1 formula for pure reverse (factor 1, source span == frameCount).
      const f = retime.speed > 0 ? retime.speed : 1;
      const srcSpan = job.expectedFrameCount || frameCount;
      srcFrame = Math.round(srcStart + (srcSpan - 1) - i * f);
      speed = -(retime.speedPercent ?? 100);
      retimeType = 'reverse';
    } else if (retime.hasSpeedChange && retime.speed > 0) {
      srcFrame = Math.round(srcStart + i * retime.speed);
      speed = retime.speedPercent ?? 100;
      retimeType = retime.isDynamic ? 'dynamic' : 'constant';
    } else {
      srcFrame = Math.round(srcStart + i);
      speed = 100;
      retimeType = 'normal';
    }

    const secF = srcFrame / fps;
    const h = Math.floor(secF / 3600);
    const m = Math.floor((secF % 3600) / 60);
    const s = Math.floor(secF % 60);
    const f = Math.round((secF % 1) * fps);
    const tc = [h, m, s, f].map(n => String(n).padStart(2, '0')).join(':');

    rows.push([outFrame, outFrame, srcFile, srcFrame, tc, speed, retimeType].join(','));
  }
  return rows.join('\n');
}

// _frameMapRows — single source of truth for per-output-frame retime resolution.
// Returns [{ outFrame, srcFrame, srcExact, speed, retimeType }] in output order.
// Prefers the planner's explicit retime.sourceFrameMap (dynamic ramps resolved
// by buildDynamicSourceFrameMap); otherwise derives constant/reverse/freeze/normal
// the same way buildFrameMapCSV does, so the CSV and JSON never disagree.
function _frameMapRows(job, { frameStart, count, fps } = {}) {
  const retime = job.retime || {};
  const start  = Math.round(Number(frameStart ?? job.frameStart ?? 1001));
  // Frame counts must be whole frames. Fractional-fps timelines (e.g. 23.976)
  // can leave a non-integer count upstream; round defensively so emitted frame
  // numbers are always integers.
  const n      = Math.max(0, Math.round(Number(count ?? job.expectedRenderedFrameCount ?? job.frameCount ?? 0)));
  const f      = Number(fps ?? job.fps ?? 24);

  // Source start frame from the export/source in-point TC.
  let srcStart = 0;
  {
    const srcIn = job.exportIn || job.sourceIn || '00:00:00:00';
    const p = String(srcIn).replace(/[;,]/g, ':').split(':').map(Number);
    if (p.length >= 4 && !p.some(Number.isNaN)) srcStart = (p[0] * 3600 + p[1] * 60 + p[2]) * f + p[3];
  }

  const explicit = Array.isArray(retime.sourceFrameMap) && retime.sourceFrameMap.length
    ? retime.sourceFrameMap : null;

  const rows = [];
  for (let i = 0; i < n; i++) {
    const outFrame = start + i;
    if (explicit) {
      const e = explicit[Math.min(i, explicit.length - 1)] || {};
      const srcFrame = Math.round(Number(e.sourceFrame ?? srcStart));
      rows.push({
        outFrame,
        srcFrame,
        srcExact:  Number(e.sourceFrameExact ?? e.sourceFrame ?? srcFrame),
        speed:     Number(e.speed ?? retime.speedPercent ?? 100),
        retimeType: e.retimeType || (retime.isDynamic ? 'dynamic' : 'constant'),
      });
      continue;
    }
    let srcFrame = srcStart + i, speed = retime.speedPercent ?? 100, retimeType = 'normal';
    if (retime.freeze) {
      srcFrame = Math.round(srcStart); speed = 0; retimeType = 'freeze';
    } else if (retime.reversed) {
      const srcSpan = job.expectedFrameCount || n;
      const factor  = retime.speed > 0 ? retime.speed : 1;
      srcFrame = Math.round(srcStart + (srcSpan - 1) - i * factor);
      speed = -(retime.speedPercent ?? 100); retimeType = 'reverse';
    } else if (retime.hasSpeedChange && retime.speed > 0) {
      srcFrame = Math.round(srcStart + i * retime.speed);
      speed = retime.speedPercent ?? 100; retimeType = retime.isDynamic ? 'dynamic' : 'constant';
    } else {
      srcFrame = Math.round(srcStart + i);
    }
    rows.push({ outFrame, srcFrame, srcExact: srcFrame, speed, retimeType });
  }
  return rows;
}

// buildFrameMapJSON — frame-map sidecar in the documented PostFlowX schema
// (mirrors VFX_4C/framemap_schema.json). Consumed by the Nuke (.nk) and AE
// (.jsx) handoff generators so all three artifacts conform identically.
// Source frames are emitted in PLATE-LOCAL numbering (first output frame reads
// the first delivered plate frame), so the maps are valid against the renumbered
// EXR sequence regardless of the absolute camera timecode.
export function buildFrameMapJSON(job = {}, manifest = {}) {
  const fps        = Number(job.fps ?? 24);
  const frameStart = Math.round(Number(manifest.frameStart ?? job.frameStart ?? 1001));
  const count      = Math.max(0, Math.round(Number(manifest.frameCount ?? job.expectedRenderedFrameCount ?? job.frameCount ?? 0)));
  const retime     = job.retime || {};
  const rows       = _frameMapRows(job, { frameStart, count, fps });

  // Normalise to plate-local source numbering off the first output frame.
  const srcBase = rows.length ? rows[0].srcFrame : 0;
  const local   = sf => frameStart + (sf - srcBase);

  const frame_map = rows.map(r => ({
    out_frame:        r.outFrame,
    src_frame:        local(r.srcFrame),
    src_frame_exact:  Number((frameStart + (r.srcExact - srcBase)).toFixed(3)),
    speed_percent:    r.speed,
    retime_type:      r.retimeType,
  }));

  return {
    $schema: 'https://postflowx/framemap-1.0.json',
    title:   'PostFlowX Frame Map',
    version: '1.0.0',
    shot: {
      clip_id:          manifest.sourceClipName || job.clipId || '',
      shot_name:        manifest.shotName || job.shotId || '',
      plate_name:       manifest.plateName || job.plateName || '',
      pull_mode:        retime.hasSpeedChange ? 'B' : 'A',
      has_speed_change: !!retime.hasSpeedChange,
      retime_type:      retime.isDynamic ? 'dynamic' : retime.freeze ? 'freeze' : retime.reversed ? 'reverse' : retime.hasSpeedChange ? 'constant' : 'normal',
      timeline_fps:     fps,
      output_range:     { first_frame: frameStart, last_frame: frameStart + Math.max(0, count - 1) },
      frame_map,
      // Nuke: paste as a TimeWarp `lookup` curve (output frame → source frame).
      nuke_retime: {
        node_type:     retime.freeze ? 'FrameHold' : 'TimeWarp',
        filter:        retime.isDynamic ? 'optical_flow' : 'none',
        output_frames: frame_map.map(e => e.out_frame),
        source_frames: frame_map.map(e => e.src_frame),
        note:          'Output frame → source plate frame. FrameHold for freeze; TimeWarp lookup otherwise.',
      },
      // After Effects: Time Remap keyframes in seconds (relative to layer in-point).
      ae_time_remap: {
        layer_in_point: 0.0,
        keyframes_seconds: frame_map.map((e, i) => ({
          time_sec: Number((i / fps).toFixed(4)),
          src_sec:  Number(((e.src_frame_exact - frameStart) / fps).toFixed(4)),
        })),
        note: 'Apply as Time Remap keyframes; linear between keys (ramps already resolved per-frame).',
      },
    },
  };
}

// buildPullReport — full JSON pull report for one job.
export function buildPullReport(job, qcResult = null) {
  return {
    schemaVersion: '2.0',
    generatedBy:   'PostFlowX',
    shotName:       job.shotId     || '',
    plateName:      job.plateName  || '',
    ocfPath:        job.sourcePath || '',
    sourceIn:       job.exportIn   || '',
    sourceOut:      job.exportOut  || '',
    fps:            job.fps        || 24,
    handles:        job.handleFrames ?? 8,
    expectedFrames: job.expectedRenderedFrameCount || job.frameCount || 0,
    frameStart:     job.frameStart  ?? 1001,
    pullMode:       job.pullMode    || '',
    retime: {
      hasSpeedChange: job.retime?.hasSpeedChange || false,
      speed:          job.retime?.speedPercent   || 100,
      type:           job.retime?.isDynamic ? 'dynamic'
                    : job.retime?.freeze    ? 'freeze'
                    : job.retime?.reversed  ? 'reverse'
                    : 'normal',
      originalSummary: job.retime?.originalSummary || '',
    },
    geometry: {
      hasGeometry: job.geometry?.hasGeometry || false,
      bakeMode:    job.geometry?.bakeMode    || 'none',
      resizeMode:  job.geometry?.resizeMode  || 'scale_to_fit',
      notes:       job.geometry?.notes       || [],
    },
    colorPlan: {
      pullMode:    job.colorPlan?.pullMode    || '',
      idtName:     job.colorPlan?.idtName     || '',
      applyIDT:    job.colorPlan?.applyIDT    ?? true,
      applyLook:   job.colorPlan?.applyLook   || false,
      applyODT:    job.colorPlan?.applyODT    || false,
      outputSpace: job.colorPlan?.outputSpace || 'ACES2065-1',
      amfPath:     job.colorPlan?.amfPath     || '',
      engineHint:  job.colorPlan?.engineHint  || '',
      warnings:    job.colorPlan?.warnings    || [],
    },
    output: {
      folder:    job.package?.root      || job.outputDir || '',
      exrFolder: job.package?.exr       || '',
      pattern:   job.outputPattern      || '',
      amf:       job.package?.amfFile   || '',
      frameMap:  job.package?.frameMapFile || '',
      geometry:  job.package?.geometryFile || '',
    },
    matchConfidence: job.metadata?.matchConfidence || 0,
    matchStatus:     job.metadata?.matchStatus     || '',
    qc:              qcResult || null,
  };
}
