// colorPlanEngine.js — PostFlowX VFX Pull
// Plans the color pipeline for each shot from AMF sidecar, camera metadata,
// show OCIO config, and pull-mode selection.
//
// Color modes (pullMode):
//   'ocf_native'        → IDT only, output ACES2065-1, no display transform
//   'match_editorial'   → IDT + approved look/CDL/CLF, no ODT
//   'review_proxy'      → IDT + look + ODT (Rec709/P3/PQ), not for final plate
//
// Output shape (attached to PullJob as job.colorPlan):
//   {
//     pullMode,
//     workingSpace,
//     outputSpace,
//     applyIDT,      applyLook,  applyODT,
//     idtName,       odtName,
//     amfPath,       amfAppliedIDT, amfAppliedLook, amfAppliedODT,
//     ocioConfig,
//     luts: [],
//     warnings: [],
//     engineHint,    // 'resolve' | 'oiio' | 'ffmpeg_fallback'
//   }

import { resolveIdtUrn } from './amfVfxPullGenerator.js';

export const PULL_MODE = {
  OCF_NATIVE:      'ocf_native',
  MATCH_EDITORIAL: 'match_editorial',
  REVIEW_PROXY:    'review_proxy',
};

export const COLOR_SPACE = {
  ACES_AP0:    'ACES2065-1',
  ACEScg:      'ACEScg',
  SRGB:        'sRGB',
  REC709:      'Rec.709',
  REC2020:     'Rec.2020',
  P3_D65:      'P3-D65',
  ST2084:      'ST2084 (PQ)',
};

const CAMERA_PROFILE_RULES = [
  { family: 'ARRI', profile: 'ARRI LogC4', patterns: [/\balexa\s*35\b/i, /\blogc4\b/i, /\blog-c4\b/i] },
  { family: 'ARRI', profile: 'ARRI LogC3', patterns: [/\barriraw\b/i, /\barri\b/i, /\balexa\b/i, /\blogc3\b/i, /\blog-c\b/i, /\.(ari|arx)\b/i] },
  { family: 'RED', profile: 'RED IPP2 Log3G10', patterns: [/\bredcode\b/i, /\bred\s*wide\s*gamut\b/i, /\blog3g10\b/i, /\bipp2\b/i, /\bred\b/i, /\.r3d\b/i] },
  { family: 'Sony', profile: 'Sony S-Gamut3.Cine/S-Log3', patterns: [/\bvenice\b/i, /\bs-?log3\b/i, /\bsgamut3\b/i, /\bs-gamut3\b/i, /\bxocn\b/i] },
  { family: 'Canon', profile: 'Canon C-Log2/C-Gamut', patterns: [/\bc-?log2\b/i, /\bclog2\b/i, /\bcanon\b/i] },
  { family: 'Canon', profile: 'Canon C-Log3/C-Gamut', patterns: [/\bc-?log3\b/i, /\bclog3\b/i] },
  { family: 'Blackmagic', profile: 'Blackmagic Film Gen 5', patterns: [/\bbraw\b/i, /\bblackmagic\b/i, /\bbmd\b/i, /\bgen\s*5\b/i] },
  { family: 'Panasonic', profile: 'Panasonic V-Log/V-Gamut', patterns: [/\bpanasonic\b/i, /\bv-?log\b/i, /\bv-?gamut\b/i, /\bvaricam\b/i] },
  { family: 'ACES', profile: 'ACES2065-1', alreadyAces: true, patterns: [/\baces2065\b/i, /\baces\s*2065\b/i, /\bap0\b/i] },
  { family: 'Display', profile: 'Rec.709 (assume display-referred)', displayReferred: true, patterns: [/\brec\.?\s*709\b/i, /\bprores\b/i, /\bh\.?264\b/i, /\bh\.?265\b/i, /\.mov\b/i, /\.mp4\b/i] },
  { family: 'Film', profile: 'Cineon Log (log-to-lin)', patterns: [/\bcineon\b/i, /\.dpx\b/i] },
];

function _joinEvidence(parts) {
  return parts
    .filter(v => v != null && v !== '')
    .map(v => typeof v === 'object' ? JSON.stringify(v) : String(v))
    .join(' ');
}

export function inferCameraProfile(job = {}) {
  const evidence = _joinEvidence([
    job?.color?.idtName,
    job?.cameraProfile,
    job?.cameraModel,
    job?.source?.codec,
    job?.source?.camera,
    job?.source?.colorSpace,
    job?.source?.format,
    job?.metadata?.codec,
    job?.metadata?.cameraModel,
    job?.metadata?.camera,
    job?.metadata?.format,
    job?.metadata?.colorSpace,
    job?.metadata?.sourceReel,
    job?.ocf?.cameraModel,
    job?.ocf?.camera,
    job?.ocf?.format,
    job?.ocf?.codec,
    job?.ocf?.colorSpace,
    job?.event?.cameraModel,
    job?.event?.camera,
    job?.event?.codec,
    job?.event?.format,
    job?.event?.srcFile,
    job?.sourcePath,
  ]);

  for (const rule of CAMERA_PROFILE_RULES) {
    if (rule.patterns.some(rx => rx.test(evidence))) {
      return {
        cameraFamily: rule.family,
        cameraProfile: rule.profile,
        idtName: rule.profile,
        idtUrn: rule.alreadyAces ? null : resolveIdtUrn(rule.profile),
        alreadyAces: !!rule.alreadyAces,
        displayReferred: !!rule.displayReferred,
        evidence,
      };
    }
  }

  return {
    cameraFamily: '',
    cameraProfile: '',
    idtName: '',
    idtUrn: null,
    alreadyAces: false,
    displayReferred: false,
    evidence,
  };
}

// parseAmfApplied — extract applied flags from an in-memory AMF XML string or path hint.
// Full XML parsing happens in the companion; here we just read pre-parsed fields if available.
function _parseAmfApplied(amfData) {
  if (!amfData || typeof amfData !== 'object') {
    return { idtApplied: false, lookApplied: false, odtApplied: false };
  }
  return {
    idtApplied:  !!amfData.inputTransformApplied,
    lookApplied: !!amfData.lookTransformApplied,
    odtApplied:  !!amfData.outputTransformApplied,
  };
}

// buildColorPlan — main entry point.
export function buildColorPlan(job = {}, pullMode = PULL_MODE.OCF_NATIVE, projectConfig = {}) {
  const warnings = [];

  // ── AMF sidecar ─────────────────────────────────────────────────────────────
  const amfPath     = job.color?.amf || job._eventRef?._amfPath || '';
  const amfParsed   = job.color?._amfParsed || null;
  const {
    idtApplied:  amfAppliedIDT,
    lookApplied: amfAppliedLook,
    odtApplied:  amfAppliedODT,
  } = _parseAmfApplied(amfParsed);

  // ── IDT ─────────────────────────────────────────────────────────────────────
  // Do not apply IDT if AMF already marks it applied=true.
  const cameraProfile = inferCameraProfile(job);
  const idtName  = job.color?.idtName || cameraProfile.idtName || '';
  const idtUrn   = job.color?.idtUrn  || cameraProfile.idtUrn || resolveIdtUrn(idtName) || null;
  const applyIDT = !amfAppliedIDT && !cameraProfile.alreadyAces && !cameraProfile.displayReferred;

  if (!idtName && applyIDT) {
    warnings.push('IDT unknown — verify camera codec before export');
  }
  if (cameraProfile.displayReferred) {
    warnings.push(`${cameraProfile.cameraProfile} detected — treating as display-referred/proxy unless an OCF camera profile overrides it`);
  }
  if (amfAppliedIDT) {
    warnings.push('AMF: IDT already applied — will not re-apply');
  }

  // ── Look ────────────────────────────────────────────────────────────────────
  let applyLook = false;
  if (pullMode === PULL_MODE.MATCH_EDITORIAL) {
    applyLook = !amfAppliedLook;
    if (amfAppliedLook) {
      warnings.push('AMF: look already applied — will not re-apply');
    }
    if (!amfPath && !projectConfig.showLut) {
      warnings.push('No AMF or show LUT found — look stage will be skipped');
      applyLook = false;
    }
  }

  // ── ODT ─────────────────────────────────────────────────────────────────────
  const applyODT = pullMode === PULL_MODE.REVIEW_PROXY && !amfAppliedODT;
  const odtName  = pullMode === PULL_MODE.REVIEW_PROXY
    ? (projectConfig.odtName || 'Rec.709 100-nits')
    : '';

  if (pullMode === PULL_MODE.REVIEW_PROXY) {
    warnings.push('Review Proxy: ODT will be baked — do not use for VFX final plate');
  }

  // ── Output color space ──────────────────────────────────────────────────────
  let outputSpace = COLOR_SPACE.ACES_AP0;
  if (pullMode === PULL_MODE.REVIEW_PROXY) {
    outputSpace = projectConfig.outputColorSpace || COLOR_SPACE.REC709;
  }

  // ── Engine hint ─────────────────────────────────────────────────────────────
  // Resolve is the only engine that can properly decode camera RAW + apply
  // ACES IDT natively. OIIO handles existing EXR/DPX. FFmpeg is fallback.
  const ext = String(job.sourcePath || '').toLowerCase().split('.').pop();
  const isRaw = ['r3d', 'ari', 'arx', 'braw', 'mxf'].includes(ext);
  const isExr = ext === 'exr';

  let engineHint = 'ffmpeg_fallback';
  if (isRaw)  engineHint = 'resolve';
  else if (isExr && (applyIDT || applyLook || applyODT)) engineHint = 'oiio';
  else if (isExr) engineHint = 'oiio';

  // Collect LUTs referenced
  const luts = [];
  if (projectConfig.showLut) luts.push({ type: 'show_lut', path: projectConfig.showLut });
  if (projectConfig.cdlPath)  luts.push({ type: 'cdl',      path: projectConfig.cdlPath  });

  return {
    pullMode,
    workingSpace:  COLOR_SPACE.ACES_AP0,
    outputSpace,
    applyIDT,
    applyLook,
    applyODT,
    idtName,
    idtUrn,
    cameraFamily:  cameraProfile.cameraFamily,
    cameraProfile: cameraProfile.cameraProfile,
    alreadyAces:   cameraProfile.alreadyAces,
    displayReferred: cameraProfile.displayReferred,
    odtName,
    amfPath,
    amfAppliedIDT,
    amfAppliedLook,
    amfAppliedODT,
    ocioConfig: projectConfig.ocioConfig || '',
    luts,
    warnings,
    engineHint,
  };
}

// colorPlanSummary — human-readable one-liner for shot row badges and pull report.
export function colorPlanSummary(colorPlan) {
  if (!colorPlan) return '';
  const parts = [];
  if (colorPlan.idtName) parts.push(colorPlan.applyIDT ? `IDT: ${colorPlan.idtName}` : `IDT applied`);
  if (colorPlan.applyLook)  parts.push('look');
  if (colorPlan.applyODT)   parts.push(`ODT: ${colorPlan.odtName}`);
  if (!parts.length) parts.push('pass-through');
  return parts.join(' → ') + ` → ${colorPlan.outputSpace}`;
}
