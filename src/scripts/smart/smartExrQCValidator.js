// smartExrQCValidator.js — PostFlowX EXR output QC validator

export const SEVERITY = { INFO: 'INFO', WARNING: 'WARNING', ERROR: 'ERROR' };

function issue(severity, code, message, detail = '') {
  return { severity, code, message, detail };
}

// Validate a single exported EXR job result.
// job: the planned job (from smartExrPullPlanner)
// result: the native helper result JSON
export function validateExrResult(job = {}, result = {}) {
  const issues = [];

  if (result.status === 'failed' || result.status === 'error') {
    issues.push(issue(SEVERITY.ERROR, 'EXPORT_FAILED', 'Export failed', result.errors?.join(', ') || result.error || 'Unknown error'));
    return { passed: false, issues };
  }
  if (!result.status) {
    issues.push(issue(SEVERITY.ERROR, 'NO_RESULT', 'No result received from Native Helper'));
    return { passed: false, issues };
  }

  const exp  = Number(job.expectedRenderedFrameCount || job.frameCount || job.expectedFrameCount || 0);
  const got  = Number(result.framesExported || 0);
  const fs   = Number.isFinite(Number(job.frameStart)) ? Number(job.frameStart) : 1001;
  const rfs  = Number(result.firstFrame);
  const rls  = Number(result.lastFrame);
  const missing = Array.isArray(result.missingFrames) ? result.missingFrames : [];

  // Frame count
  if (exp > 0 && got !== exp) {
    issues.push(issue(
      got < exp ? SEVERITY.ERROR : SEVERITY.WARNING,
      'FRAME_COUNT_MISMATCH',
      `Expected ${exp} frames, got ${got}`,
      `Delta: ${Math.abs(exp - got)} frames`,
    ));
  }

  // Empty export with NO expected count: helper reported success but produced 0
  // frames. (When exp > 0, FRAME_COUNT_MISMATCH above already covers got === 0,
  // so gating on exp <= 0 avoids a redundant double-error on the same condition.)
  if (got === 0 && exp <= 0) {
    issues.push(issue(SEVERITY.ERROR, 'NO_FRAMES', 'Export reported success but produced 0 frames'));
  }

  // Missing frames
  if (missing.length) {
    issues.push(issue(SEVERITY.ERROR, 'MISSING_FRAMES',
      `${missing.length} missing frame${missing.length > 1 ? 's' : ''}`,
      missing.slice(0, 10).join(', ') + (missing.length > 10 ? '…' : ''),
    ));
  }

  // Frame start
  if (Number.isFinite(rfs) && rfs !== fs) {
    issues.push(issue(SEVERITY.WARNING, 'FRAME_START_MISMATCH',
      `Expected first frame ${fs}, got ${rfs}`, ''));
  }

  // Resolution
  if (result.metadata?.resolution && job._eventRef?.expectedResolution) {
    if (result.metadata.resolution !== job._eventRef.expectedResolution) {
      issues.push(issue(SEVERITY.WARNING, 'RESOLUTION_MISMATCH',
        `Resolution ${result.metadata.resolution} differs from expected ${job._eventRef.expectedResolution}`));
    }
  }

  // FPS
  const resFps = Number(result.metadata?.fps);
  if (Number.isFinite(resFps) && Math.abs(resFps - Number(job.fps)) > 0.1) {
    issues.push(issue(SEVERITY.WARNING, 'FPS_MISMATCH',
      `FPS ${resFps} differs from expected ${job.fps}`));
  }

  // Color metadata
  if (job.color?.mode === 'aces' && !result.metadata?.colorSpace) {
    issues.push(issue(SEVERITY.WARNING, 'COLOR_METADATA_MISSING',
      'ACES mode selected but no color metadata in output'));
  }
  if (job.color?.mode === 'aces' && !job.color.amf && !job.color.ocioConfig) {
    issues.push(issue(SEVERITY.WARNING, 'AMF_MISSING',
      'ACES mode without AMF or OCIO config — output may not be compliant'));
  }

  // File size check (0-byte EXR)
  if (got > 0 && result.totalSizeBytes === 0) {
    issues.push(issue(SEVERITY.ERROR, 'ZERO_SIZE', 'Exported files report 0 bytes'));
  }

  // Partial export
  if (result.status === 'partial') {
    issues.push(issue(SEVERITY.WARNING, 'PARTIAL_EXPORT', 'Export completed partially', result.warnings?.join(', ') || ''));
  }

  // Naming
  if (result.outputPattern && job.outputPattern && result.outputPattern !== job.outputPattern) {
    issues.push(issue(SEVERITY.WARNING, 'NAMING_MISMATCH', 'Output pattern differs from planned pattern'));
  }

  // Retime flag
  if (job.retime?.hasSpeedChange && !result.metadata?.retimed) {
    issues.push(issue(SEVERITY.INFO, 'RETIME_UNCONFIRMED',
      'Speed change detected but retime flag not set in output metadata'));
  }

  // Forward result warnings/errors
  for (const w of (result.warnings || [])) {
    issues.push(issue(SEVERITY.WARNING, 'HELPER_WARNING', w));
  }
  for (const e of (result.errors || [])) {
    issues.push(issue(SEVERITY.ERROR, 'HELPER_ERROR', e));
  }

  const hasErrors = issues.some(i => i.severity === SEVERITY.ERROR);
  const hasWarnings = issues.some(i => i.severity === SEVERITY.WARNING);
  const qcStatus = hasErrors ? 'QC_FAILED' : hasWarnings ? 'QC_WARNING' : 'QC_PASSED';

  if (!issues.length) {
    issues.push(issue(SEVERITY.INFO, 'QC_OK', `${got} frames exported — all checks passed`));
  }

  return { passed: !hasErrors, qcStatus, issues, framesExported: got, firstFrame: rfs, lastFrame: rls };
}

// Validate a batch of job+result pairs.
export function validateAll(pairs = []) {
  return pairs.map(({ job, result }) => ({
    shotId: job.shotId,
    plateName: job.plateName,
    ...validateExrResult(job, result),
  }));
}

// Aggregate QC summary counts.
export function qcSummary(validations = []) {
  let passed = 0, warned = 0, failed = 0, total = validations.length;
  for (const v of validations) {
    if (v.qcStatus === 'QC_PASSED') passed++;
    else if (v.qcStatus === 'QC_WARNING') warned++;
    else failed++;
  }
  return { total, passed, warned, failed };
}
