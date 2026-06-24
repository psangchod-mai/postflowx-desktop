// geometryEngine.js — PostFlowX VFX Pull
// Extracts timeline geometry from NLE events and computes reframe transforms.
//
// Output shape (attached to PullJob as job.geometry):
//   {
//     sourceResolution, timelineResolution, outputResolution,
//     scale, positionX, positionY, anchorX, anchorY, rotation,
//     cropL, cropR, cropT, cropB,
//     resizeMode, pixelAspect,
//     hasGeometry,          // any non-identity transform present
//     bakeMode,             // 'none' | 'baked' | 'sidecar'
//     matrix,               // 3x3 transform as flat [a,b,c,d,e,f,g,h,i]
//     ffmpegCrop,           // "crop=W:H:X:Y" string if crop non-zero
//     ffmpegScale,          // "scale=W:H" string for output
//     notes,
//   }

export const GEOMETRY_BAKE = {
  NONE:    'none',
  BAKED:   'baked',
  SIDECAR: 'sidecar',
};

export const RESIZE_MODE = {
  SCALE_TO_FIT:  'scale_to_fit',
  SCALE_TO_FILL: 'scale_to_fill',
  CROP:          'crop',
  STRETCH:       'stretch',
  NONE:          'none',
};

// Default values representing an identity transform.
const IDENTITY = {
  scale:     1.0,
  positionX: 0,
  positionY: 0,
  anchorX:   0.5,
  anchorY:   0.5,
  rotation:  0,
  cropL:     0,
  cropR:     0,
  cropT:     0,
  cropB:     0,
};

function _parseRes(val, fallbackW = 0, fallbackH = 0) {
  if (!val) return { w: fallbackW, h: fallbackH };
  if (typeof val === 'object' && val.width != null) return { w: +val.width, h: +val.height };
  const m = String(val).match(/^(\d+)[x×](\d+)$/i);
  if (m) return { w: +m[1], h: +m[2] };
  return { w: fallbackW, h: fallbackH };
}

function _num(v, def = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

// isIdentity — true when all transform components are at their neutral values.
function _isIdentity(g) {
  return (
    Math.abs(g.scale - 1.0)   < 0.0001 &&
    Math.abs(g.positionX)      < 0.5   &&
    Math.abs(g.positionY)      < 0.5   &&
    Math.abs(g.rotation)       < 0.001 &&
    Math.abs(g.cropL)          < 0.5   &&
    Math.abs(g.cropR)          < 0.5   &&
    Math.abs(g.cropT)          < 0.5   &&
    Math.abs(g.cropB)          < 0.5
  );
}

// buildMatrix — flat 3×3 affine matrix [a b c / d e f / 0 0 1]
// encoding scale + rotation + translation relative to frame centre.
function _buildMatrix(scale, rotDeg, tx, ty, anchorX, anchorY, srcW, srcH) {
  const rad   = (rotDeg || 0) * Math.PI / 180;
  const cos   = Math.cos(rad);
  const sin   = Math.sin(rad);
  const s     = scale || 1;
  const cx    = (anchorX ?? 0.5) * srcW;
  const cy    = (anchorY ?? 0.5) * srcH;

  // Rotate-scale around anchor point, then translate.
  const a = s * cos;
  const b = -s * sin;
  const c = tx + cx - a * cx - b * cy;
  const d = s * sin;
  const e = s * cos;
  const f = ty + cy - d * cx - e * cy;
  return [a, b, c, d, e, f, 0, 0, 1];
}

// extractGeometry — derive geometry block from a timeline event.
// Handles Resolve, FCPXML, Premiere, OTIO event shapes.
export function extractGeometry(event = {}, projectConfig = {}) {
  const tfm   = event.transform    || event.geometry   || {};
  const crop  = event.crop         || tfm.crop         || {};
  const resize = event.resize      || tfm.resize       || {};

  // Source / timeline / output resolutions
  const srcRes  = _parseRes(event.sourceResolution   || tfm.sourceResolution   || event.mediaResolution, 0, 0);
  const tlRes   = _parseRes(event.timelineResolution  || tfm.timelineResolution || projectConfig.timelineResolution, 0, 0);
  const outRes  = _parseRes(event.outputResolution    || tfm.outputResolution   || projectConfig.outputResolution || projectConfig.targetResolution, 0, 0);

  // Transform values — try multiple NLE field name conventions
  const scale    = _num(tfm.scale     ?? tfm.zoomX    ?? tfm.zoom     ?? event.scale,    1.0);
  const posX     = _num(tfm.positionX ?? tfm.offsetX  ?? tfm.panX     ?? event.positionX, 0);
  const posY     = _num(tfm.positionY ?? tfm.offsetY  ?? tfm.panY     ?? event.positionY, 0);
  const anchorX  = _num(tfm.anchorX   ?? tfm.pivotX,  0.5);
  const anchorY  = _num(tfm.anchorY   ?? tfm.pivotY,  0.5);
  const rotation = _num(tfm.rotation  ?? tfm.rotate   ?? event.rotation, 0);
  const pixelAR  = _num(event.pixelAspect ?? tfm.pixelAspect ?? 1, 1);

  // Crop — normalised pixels; field names vary across NLEs
  const cropL = _num(crop.left   ?? crop.l ?? crop.cropLeft   ?? 0);
  const cropR = _num(crop.right  ?? crop.r ?? crop.cropRight  ?? 0);
  const cropT = _num(crop.top    ?? crop.t ?? crop.cropTop    ?? 0);
  const cropB = _num(crop.bottom ?? crop.b ?? crop.cropBottom ?? 0);

  const resizeModeRaw = String(
    resize.mode   || resize.resizeMode  ||
    event.resizeMode || event.fitMode   || 'scale_to_fit'
  ).toLowerCase();

  let resizeMode = RESIZE_MODE.SCALE_TO_FIT;
  if      (/fill|scale_to_fill/.test(resizeModeRaw)) resizeMode = RESIZE_MODE.SCALE_TO_FILL;
  else if (/crop/.test(resizeModeRaw))                resizeMode = RESIZE_MODE.CROP;
  else if (/stretch|distort/.test(resizeModeRaw))     resizeMode = RESIZE_MODE.STRETCH;
  else if (/none|original|native/.test(resizeModeRaw)) resizeMode = RESIZE_MODE.NONE;

  const g = { scale, positionX: posX, positionY: posY, anchorX, anchorY, rotation, cropL, cropR, cropT, cropB };
  const hasGeometry = !_isIdentity(g) || resizeMode !== RESIZE_MODE.SCALE_TO_FIT || pixelAR !== 1;

  // Build ffmpeg crop/scale strings for the companion vf chain
  let ffmpegCrop  = '';
  let ffmpegScale = '';

  if (srcRes.w && srcRes.h) {
    const cropW = Math.max(1, srcRes.w - cropL - cropR);
    const cropH = Math.max(1, srcRes.h - cropT - cropB);
    if (cropL || cropR || cropT || cropB) {
      ffmpegCrop = `crop=${cropW}:${cropH}:${cropL}:${cropT}`;
    }
  }

  const targetW = outRes.w || tlRes.w;
  const targetH = outRes.h || tlRes.h;
  if (targetW && targetH) {
    ffmpegScale = `scale=${targetW}:${targetH}`;
  }

  // 3×3 matrix for geometry JSON sidecar
  const matrix = srcRes.w && srcRes.h
    ? _buildMatrix(scale, rotation, posX, posY, anchorX, anchorY, srcRes.w, srcRes.h)
    : null;

  const notes = [];
  if (resizeMode !== RESIZE_MODE.NONE && resizeMode !== RESIZE_MODE.SCALE_TO_FIT) {
    notes.push(`Resize mode: ${resizeMode}`);
  }
  if (Math.abs(rotation) > 0.001) notes.push(`Rotation: ${rotation.toFixed(2)}°`);
  if (Math.abs(scale - 1) > 0.001) notes.push(`Scale: ${(scale * 100).toFixed(1)}%`);
  if (cropL || cropR || cropT || cropB) notes.push(`Crop: L${cropL} R${cropR} T${cropT} B${cropB}`);

  return {
    sourceResolution:   srcRes.w ? `${srcRes.w}x${srcRes.h}` : '',
    timelineResolution: tlRes.w  ? `${tlRes.w}x${tlRes.h}`   : '',
    outputResolution:   outRes.w ? `${outRes.w}x${outRes.h}` : '',
    scale,
    positionX: posX,
    positionY: posY,
    anchorX,
    anchorY,
    rotation,
    cropL,
    cropR,
    cropT,
    cropB,
    resizeMode,
    pixelAspect: pixelAR,
    hasGeometry,
    bakeMode: GEOMETRY_BAKE.NONE,  // caller sets this after build-plan decision
    matrix,
    ffmpegCrop,
    ffmpegScale,
    notes,
  };
}

// buildGeometrySidecar — object written to geometry.json
export function buildGeometrySidecar(job) {
  const g = job?.geometry || {};
  return {
    shotName:           job?.shotId     || '',
    plateName:          job?.plateName  || '',
    sourceResolution:   g.sourceResolution   || '',
    timelineResolution: g.timelineResolution  || '',
    outputResolution:   g.outputResolution    || '',
    scale:              g.scale   ?? 1,
    positionX:          g.positionX ?? 0,
    positionY:          g.positionY ?? 0,
    rotation:           g.rotation  ?? 0,
    cropL:              g.cropL ?? 0,
    cropR:              g.cropR ?? 0,
    cropT:              g.cropT ?? 0,
    cropB:              g.cropB ?? 0,
    resizeMode:         g.resizeMode   || 'scale_to_fit',
    pixelAspect:        g.pixelAspect  ?? 1,
    bakeMode:           g.bakeMode     || 'none',
    matrix:             g.matrix       || null,
    notes:              g.notes        || [],
  };
}
