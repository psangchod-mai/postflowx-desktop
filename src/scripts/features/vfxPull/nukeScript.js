// nukeScript.js — per-shot Nuke (.nk) handoff builder for VFX Pull (pure).
//
// Emits a node graph a compositor can open directly:
//   Read (delivered EXR plate, correct frame range + colorspace)
//   → OCIOCDLTransform (the auto-match reference grade from the AMF, labelled)
//   → Reformat (editorial framing from the FDL, when not already baked)
//   → Retime / sticky (constant speed baked; dynamic/freeze point at frame map)
//   → metadata StickyNote (shot, TCs, match scores, drift, sidecar paths)
//   → disabled Write placeholder for the comp output.
//
// Pure string builder (no DOM / state) so it is unit-testable.
'use strict';

function _esc(s) { return String(s == null ? '' : s).replace(/"/g, '\\"'); }
function _triple(a, fallback = [1, 1, 1]) {
  const v = Array.isArray(a) && a.length === 3 ? a : fallback;
  return v.map(n => (Number.isFinite(Number(n)) ? Number(n) : 1)).join(' ');
}
// Map a fit mode to a Nuke Reformat `resize` value.
function _resizeMode(fit) {
  switch ((fit || '').toLowerCase()) {
    case 'centercrop': case 'fill': return 'fill';
    case 'stretch':    case 'distort': return 'distort';
    case 'none':       return 'none';
    default:           return 'fit';
  }
}

export function buildNukeScript(job = {}, opts = {}) {
  const manifest      = opts.manifest || {};
  const frameMapPath  = opts.frameMapPath || '';
  const amfPath       = opts.amfPath || '';
  const resizePath    = opts.resizePath || '';

  const plateName = job.plateName || manifest.plateName || 'plate';
  const platePath = `${job.package?.exr || 'plates'}/${plateName}.%04d.exr`;
  const first     = Math.round(Number(job.frameStart ?? manifest.frameStart ?? 1001));
  // Whole frames only — fractional-fps timelines can leave a non-integer count upstream.
  const count     = Math.max(1, Math.round(Number(job.expectedRenderedFrameCount || job.frameCount || manifest.frameCount || 1)));
  const last      = first + count - 1;
  const colorspace = manifest.colorInfo?.exrColorSpace || job.colorPlan?.outputSpace || 'ACES2065-1';

  const lines = [];
  lines.push('set cut_paste_input [stack 0]');
  lines.push('version 14.0 v1');

  // ── Read ──────────────────────────────────────────────────────────────────
  lines.push('Read {');
  lines.push(' inputs 0');
  lines.push(` file "${platePath}"`);
  lines.push(` first ${first}`);
  lines.push(` last ${last}`);
  lines.push(` origfirst ${first}`);
  lines.push(` origlast ${last}`);
  lines.push(` colorspace "${colorspace}"`);
  lines.push(` name Read_${plateName}`);
  lines.push('}');

  // ── CDL (auto-match reference grade from the AMF) ───────────────────────────
  const cdl = job.color?.match?.cdl;
  if (cdl && (Array.isArray(cdl.slope) || Array.isArray(cdl.offset))) {
    const conf = job.color?.match?.confidence;
    lines.push('OCIOCDLTransform {');
    lines.push(` slope {${_triple(cdl.slope)}}`);
    lines.push(` offset {${_triple(cdl.offset, [0, 0, 0])}}`);
    lines.push(` power {${_triple(cdl.power)}}`);
    lines.push(` saturation ${Number.isFinite(Number(cdl.sat ?? cdl.saturation)) ? Number(cdl.sat ?? cdl.saturation) : 1}`);
    lines.push(` label "AUTO-MATCH CDL${conf != null ? ` ${Math.round(conf)}%` : ''} — reference, not final grade (from ${_esc((amfPath || '').split('/').pop() || 'AMF')})"`);
    lines.push(` name PostFlowX_AutoMatch_CDL`);
    lines.push('}');
  }

  // ── Show look / LMT (OCIOFileTransform) ─────────────────────────────────────
  // Only when the color plan resolved that a look should be applied AND a show
  // LUT/CLF path exists. colorPlanEngine already suppresses applyLook when the
  // AMF marks the look baked, so this won't double-apply the editorial look.
  const showLut = (job.colorPlan?.luts || []).find(l => l && l.type === 'show_lut' && l.path);
  if (job.colorPlan?.applyLook && showLut) {
    lines.push('OCIOFileTransform {');
    lines.push(` file "${_esc(showLut.path)}"`);
    lines.push(' direction forward');
    lines.push(' interpolation linear');
    lines.push(` label "Show look / LMT (from AMF)\\n${_esc((showLut.path || '').split('/').pop())}"`);
    lines.push(' name PostFlowX_ShowLook');
    lines.push('}');
  }

  // ── Reframe (editorial framing from the FDL) ───────────────────────────────
  const reframe = job.reframe || {};
  const baked   = !!job.renderPlan?.bakeReframe;
  const tw = Number(reframe.targetWidth  || manifest.resizeInfo?.timelineResolution?.width);
  const th = Number(reframe.targetHeight || manifest.resizeInfo?.timelineResolution?.height);
  if (!baked && reframe.mode && reframe.mode !== 'none' && tw && th) {
    lines.push('Reformat {');
    lines.push(' type "to box"');
    lines.push(` box_width ${tw}`);
    lines.push(` box_height ${th}`);
    lines.push(` resize ${_resizeMode(reframe.fit)}`);
    lines.push(` label "editorial reframe (FDL${resizePath ? `: ${_esc(resizePath.split('/').pop())}` : ''})"`);
    lines.push(' name PostFlowX_Reframe');
    lines.push('}');
  } else if (baked && (reframe.mode && reframe.mode !== 'none')) {
    lines.push('StickyNote { label "Editorial framing already baked into plate" name Framing_Note }');
  }

  // ── Retime (from the frame map) ────────────────────────────────────────────
  // When the planner resolved an explicit output→source map (dynamic ramps via
  // buildDynamicSourceFrameMap), bake it into a real node so the .nk conforms on
  // open instead of asking the artist to do it by hand:
  //   • freeze  → FrameHold on the held frame
  //   • dynamic → TimeWarp whose `lookup` curve maps output frame → source frame
  // Source frames are emitted PLATE-LOCAL (first map entry → plate `first`) so the
  // curve is valid against the renumbered EXR sequence. No map → sticky fallback.
  const retime = job.retime || {};
  const fmap   = Array.isArray(retime.sourceFrameMap) && retime.sourceFrameMap.length
    ? retime.sourceFrameMap : null;
  const srcBase = fmap ? Math.round(Number(fmap[0].sourceFrame) || 0) : 0;
  const localSrc = sf => first + (Math.round(Number(sf) || 0) - srcBase);

  if (retime.freeze) {
    if (fmap) {
      lines.push('FrameHold {');
      lines.push(` first_frame ${localSrc(fmap[0].sourceFrame)}`);
      lines.push(` label "FREEZE — held source frame (from frame map)"`);
      lines.push(' name PostFlowX_Freeze');
      lines.push('}');
    } else {
      lines.push(`StickyNote { label "FREEZE retime — apply from frame map: ${_esc((frameMapPath || '').split('/').pop())}" name Retime_Note }`);
    }
  } else if (retime.isDynamic && fmap) {
    const keys = fmap.map((e, i) => `x${first + i} ${localSrc(e.sourceFrame)}`).join(' ');
    lines.push('TimeWarp {');
    lines.push(` lookup {{curve ${keys}}}`);
    lines.push(' filter none');   // every source frame is present in the plate; no interpolation
    lines.push(` label "DYNAMIC retime — conformed from frame map (${fmap.length} keys)"`);
    lines.push(' name PostFlowX_Retime_FrameMap');
    lines.push('}');
  } else if (retime.isDynamic) {
    lines.push(`StickyNote { label "DYNAMIC speed ramp — conform per frame map: ${_esc((frameMapPath || '').split('/').pop())}" name Retime_Note }`);
  } else if (retime.hasSpeedChange && Number.isFinite(Number(retime.speed)) && Number(retime.speed) > 0) {
    lines.push('Retime {');
    lines.push(` speed ${Number(retime.speed)}`);
    if (retime.reversed) lines.push(' reverse true');
    lines.push(` label "${Math.round(retime.speedPercent || Number(retime.speed) * 100)}% ${retime.reversed ? 'reverse ' : ''}retime"`);
    lines.push(' name PostFlowX_Retime');
    lines.push('}');
  } else if (retime.reversed) {
    lines.push('Retime { speed 1 reverse true label "reverse" name PostFlowX_Retime }');
  }

  // ── Metadata sticky ────────────────────────────────────────────────────────
  const fa = job.frameAlign;
  const note = [
    `Shot: ${manifest.shotName || job.shotId || ''}`,
    `Plate: ${plateName}`,
    `OCF: ${manifest.ocfPath || job.sourcePath || ''}`,
    `Source TC: ${manifest.sourceTcIn || job.exportIn || ''} - ${manifest.sourceTcOut || job.exportOut || ''}`,
    `Timeline TC: ${manifest.timelineTcIn || ''} - ${manifest.timelineTcOut || ''}`,
    `OCF match: ${job.metadata?.matchConfidence != null ? Math.round(job.metadata.matchConfidence) + '%' : '—'}`,
    `Visual match: ${job.metadata?.visualMatch != null ? Math.round(job.metadata.visualMatch) + '%' : '—'}`,
    `Frame-align drift: ${fa ? `${fa.offsetFrames >= 0 ? '+' : ''}${fa.offsetFrames}f ${fa.applied ? '(applied)' : '(not applied)'}` : 'n/a'}`,
    `Color match: ${job.color?.match?.confidence != null ? Math.round(job.color.match.confidence) + '%' : '—'}`,
    `Color pipeline: ${manifest.colorInfo?.colorPipeline || colorspace}`,
    `AMF: ${amfPath || 'color_manifest.json fallback'}`,
    `Frame map: ${frameMapPath || ''}`,
    'Generated by PostFlowX VFX Pull',
  ].join('\\n');
  lines.push(`StickyNote { label "${_esc(note)}" name PostFlowX_Metadata }`);

  // ── Disabled comp-output placeholder ───────────────────────────────────────
  lines.push('Write {');
  lines.push(` file "renders/${_esc(manifest.shotName || job.shotId || 'shot')}_comp_v001.####.exr"`);
  lines.push(' disable true');
  lines.push(' name Write_Disabled_Comp_Placeholder');
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}
