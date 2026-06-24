// ─────────────────────────────────────────────────────────────────────────────
// pullValidator.js — pre-export conform validation (pure, unit-testable).
//
// Surfaces problems BEFORE a pull/export so they're caught here instead of
// downstream by a vendor: zero-duration shots, unmatched camera originals,
// missing source timecode, over-long reel names (Avid truncates >32 chars on
// re-import), and drop-frame timecode on a non-drop-frame project.
// ─────────────────────────────────────────────────────────────────────────────

import { tcToFrames } from './utils_time.js';

export const ISSUE = { ERROR: 'error', WARNING: 'warning', INFO: 'info' };

// Avid reel/tape field limit — longer names silently truncate on re-import.
const REEL_MAX = 32;

function matchFor(matchResults, i, ev) {
  if (Array.isArray(matchResults)) return matchResults[i] || null;
  if (matchResults && typeof matchResults === 'object') return matchResults[i] || null;
  return ev && ev._match ? ev._match : null;
}

/**
 * Validate a pull list. Returns { ok, hasIssues, issues[], counts }.
 * `ok` is false only when there is at least one ERROR-severity issue.
 *
 * opts.matchResults: array (by index) or map (idx→result) of OCF match results
 *   (each { status, confidence }). When absent, OCF-match checks are skipped.
 */
export function validatePullList(events = [], opts = {}) {
  const matchResults = opts.matchResults || null;
  const issues = [];
  let zeroDur = 0, unmatched = 0, missingTc = 0, longReel = 0, dfMismatch = 0;
  let total = 0;
  const fpsSeen = new Set();

  events.forEach((ev, i) => {
    if (!ev || ev.disabled) return;
    total++;

    const fps = Number(ev.fps) || 24;
    fpsSeen.add(Math.round(fps * 1000) / 1000);
    const tcBase = Math.max(1, Math.round(fps));
    const inF  = tcToFrames(ev.srcIn || '00:00:00:00', tcBase);
    const outF = tcToFrames(ev.srcOut || ev.srcIn || '00:00:00:00', tcBase);
    if (outF <= inF) zeroDur++;

    if (matchResults) {
      const m = matchFor(matchResults, i, ev);
      const conf = m && m.confidence != null ? Number(m.confidence) : null;
      const missing = !m || m.status === 'MISSING' || (conf != null && conf < 28);
      if (missing) unmatched++;
    }

    if (!ev.srcIn || ev.srcIn === '00:00:00:00') missingTc++;
    if (String(ev.reel || '').length > REEL_MAX) longReel++;

    // Drop-frame TC (semicolon) on a project whose fps can't be drop-frame, or
    // whose EDL header declared NON-DROP → silent ~0.1% timing drift.
    const tcStr = String(ev.srcIn || '') + String(ev.srcOut || '');
    const hasSemicolon = tcStr.includes(';');
    const dfCapable = Math.abs(fps - 29.97) < 0.05 || Math.abs(fps - 59.94) < 0.05;
    if (hasSemicolon && (!dfCapable || ev._edlFcm === 'NON-DROP')) dfMismatch++;
  });

  if (zeroDur)    issues.push({ severity: ISSUE.ERROR,   code: 'ZERO_DURATION', count: zeroDur,    message: `${zeroDur} shot(s) have zero or negative duration` });
  if (unmatched)  issues.push({ severity: ISSUE.WARNING, code: 'UNMATCHED_OCF', count: unmatched,  message: `${unmatched} shot(s) have no confident camera-original match` });
  if (missingTc)  issues.push({ severity: ISSUE.WARNING, code: 'MISSING_TC',    count: missingTc,  message: `${missingTc} shot(s) have no source timecode` });
  if (longReel)   issues.push({ severity: ISSUE.WARNING, code: 'REEL_TOO_LONG', count: longReel,   message: `${longReel} reel name(s) exceed ${REEL_MAX} chars (Avid truncates on re-import)` });
  if (dfMismatch) issues.push({ severity: ISSUE.WARNING, code: 'DF_MISMATCH',   count: dfMismatch, message: `${dfMismatch} shot(s) use drop-frame timecode on a non-drop-frame project` });
  if (fpsSeen.size > 1) {
    const rates = [...fpsSeen].sort((a, b) => a - b).join(', ');
    issues.push({ severity: ISSUE.INFO, code: 'MIXED_FPS', count: fpsSeen.size, message: `Mixed frame rates in sequence (${rates} fps) — pulls and source timecode use each clip's own rate` });
  }

  return {
    ok: issues.every(x => x.severity !== ISSUE.ERROR),
    hasIssues: issues.length > 0,
    issues,
    counts: { total, zeroDur, unmatched, missingTc, longReel, dfMismatch },
  };
}
