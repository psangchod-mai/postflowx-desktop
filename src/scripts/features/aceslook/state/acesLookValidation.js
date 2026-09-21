// scripts/features/acesLook/state/acesLookValidation.js
// Validates ACES Look state. Returns { errors: string[], warnings: string[] }.
// Hard errors block export; warnings are informational.

import { REGISTRY, resolveInputTransform, resolveOutputTransform, ACES_DEFAULT_VERSION } from '../services/transformRegistry.js';

// EOTFs a parametric "custom display" ODT may declare.
const VALID_EOTFS = new Set(['PQ', 'HLG', 'gamma2.2', 'gamma2.4', 'sRGB']);
const VALID_DISPLAY_PRIMARIES = new Set(['Rec.709', 'P3-D65', 'Rec.2020', 'P3-DCI']);
// Known ACES 1.x look fixes that ACES 2.0 guidance says not to stack (the 2.0
// Output Transform already handles gamut/highlight rendering).
const LEGACY_LMT_PATTERNS = [
  /BlueLightArtifact/i,         // ACES 1.x blue-light / neon suppression LMT
  /ReferenceGamutCompress.*v1\.3/i, // standalone RGC carried into a 2.0 pipeline
  /Gamut.*Compress/i,
];

export function validate(state) {
  const errors   = [];
  const warnings = [];
  const acesVersion = state.acesVersion || ACES_DEFAULT_VERSION;

  // ── Hard errors ───────────────────────────────────────────────────────────

  if (!state.source) {
    errors.push('No source selected.');
  }

  // AUTO is acceptable when the clip carries OCF metadata — the IDT is then
  // auto-resolved from the camera format at build time (ocfIdtResolver).
  if (state.inputTransform === 'AUTO' && !state.ocfMeta) {
    errors.push('Input transform is unresolved (AUTO). Select a transform or confirm source detection.');
  }

  if (state.inputTransform !== 'AUTO' && state.inputTransform !== 'NONE_ALREADY_ACES') {
    const entry = REGISTRY.inputTransforms[state.inputTransform];
    if (!entry) errors.push(`Input transform "${state.inputTransform}" has no registry entry.`);
  }

  if (state.outputTransform && state.outputTransform !== 'NONE_RECIPE_ONLY') {
    const entry = REGISTRY.outputTransforms[state.outputTransform];
    if (!entry) errors.push(`Output transform "${state.outputTransform}" has no registry entry.`);
  }

  if (!state.clipId || !state.clipId.trim()) {
    errors.push('Clip ID is required for AMF export.');
  }

  if (state.cdlEnabled) {
    const { slope, offset, power, sat } = state.cdl;
    const validVec = v => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && isFinite(n));
    if (!validVec(slope))  errors.push('CDL Slope values are invalid.');
    if (!validVec(offset)) errors.push('CDL Offset values are invalid.');
    if (!validVec(power))  errors.push('CDL Power values are invalid.');
    if (typeof sat !== 'number' || !isFinite(sat)) errors.push('CDL Saturation value is invalid.');
    // Guard with validVec — these ran unconditionally before and threw on a
    // non-array CDL (e.g. a hand-edited .pfxpreset), crashing the render loop.
    if (validVec(slope) && slope.some(v => v < 0))  errors.push('CDL Slope must be ≥ 0.');
    if (validVec(power) && power.some(v => v <= 0)) errors.push('CDL Power must be > 0.');
    if (typeof sat === 'number' && sat < 0) errors.push('CDL Saturation must be ≥ 0.');
  }

  for (const item of (state.lookStack || [])) {
    if (!item.enabled) continue;
    if ((item.kind === 'clf' || item.kind === 'lut') && !item.file && !item.transformId) {
      errors.push(`Look item "${item.label}" is enabled but has no file path or transform ID.`);
    }
  }

  // ── Warnings ─────────────────────────────────────────────────────────────

  if (state.sourceClass === 'unknown') {
    warnings.push('Source classification is unknown. Verify input transform manually.');
  }

  if (state.sourceClass === 'qt_rec709' && state.mode !== 'sdr_qt_in_hdr_show') {
    warnings.push('Source appears to be SDR Rec.709 QT but mode is not "SDR QT in HDR Show".');
  }

  if (state.mode === 'sdr_qt_in_hdr_show' && state.sourceClass !== 'qt_rec709' && state.sourceClass !== 'unknown') {
    warnings.push('Mode is "SDR QT in HDR Show" but source does not appear to be Rec.709 QT.');
  }

  if (state.mode === 'sdr_qt_in_hdr_show' && !state.preserveSdr) {
    warnings.push('"Preserve SDR Appearance" is off in SDR QT in HDR Show mode — intent may not match.');
  }

  const hdrModes = ['hdr_vfx_pull', 'hdr_dailies', 'hdr_review'];
  if (hdrModes.includes(state.mode) && state.outputTransform === 'SDR_REC709') {
    warnings.push('SDR output selected in an HDR-oriented mode.');
  }

  // ── ACES 2.0-aware rules ───────────────────────────────────────────────────
  const isAces20 = String(acesVersion) === '2.0';
  const hasRealOdt = state.outputTransform && state.outputTransform !== 'NONE_RECIPE_ONLY';

  // 1) RGC vs ACES 2.0: the 2.0 Output Transform already maps gamut.
  if (state.rgcEnabled && isAces20 && hasRealOdt) {
    warnings.push('Reference Gamut Compression is enabled with an ACES 2.0 Output Transform. The 2.0 Output Transform already performs gamut mapping; standalone RGC is generally not recommended and may over-compress.');
  }

  // 2) Legacy 1.x look fixes in a 2.0 pipeline.
  if (isAces20) {
    for (const item of state.lookStack || []) {
      if (!item.enabled) continue;
      const id = String(item.transformId || '');
      if (LEGACY_LMT_PATTERNS.some((re) => re.test(id)) || item.legacy20NotRecommended) {
        warnings.push(`Look "${item.label}" is a legacy ACES 1.x fix; these aren't recommended in an ACES 2.0 pipeline and may over-compress usable ranges.`);
      }
    }
  }

  // 3) Version coherence: a transform that only resolves at the OTHER ACES version.
  const coherence = (key, resolver, kind) => {
    if (!key || key === 'AUTO' || key === 'NONE_ALREADY_ACES' || key === 'NONE_RECIPE_ONLY' || key === 'CUSTOM_FILE') return;
    const here  = resolver(key, { acesVersion });
    const other = resolver(key, { acesVersion: isAces20 ? '1.3' : '2.0' });
    if (here && here.transformId == null && other && other.transformId != null) {
      warnings.push(`${kind} "${here.label}" has no ACES ${acesVersion} transform ID (only ${isAces20 ? '1.3' : '2.0'}). Mixing ACES versions — verify downstream compatibility.`);
    }
  };
  coherence(state.inputTransform, resolveInputTransform, 'Input transform');
  coherence(state.outputTransform, resolveOutputTransform, 'Output transform');

  // 4) Parametric custom-display sanity (hard errors — a bad target is wrong).
  if (state.outputTransform === 'CUSTOM_DISPLAY') {
    const d = state.customDisplay || (REGISTRY.outputTransforms.CUSTOM_DISPLAY || {}).params || {};
    if (!(Number(d.peak_nits) > 0)) errors.push('Custom display: peak_nits must be > 0.');
    if (d.limiting_primaries && !VALID_DISPLAY_PRIMARIES.has(d.limiting_primaries)) {
      errors.push(`Custom display: unknown limiting primaries "${d.limiting_primaries}".`);
    }
    if (!VALID_EOTFS.has(d.eotf)) errors.push(`Custom display: EOTF must be one of PQ, HLG, gamma2.2, gamma2.4, sRGB (got "${d.eotf}").`);
  }

  return { errors, warnings };
}
