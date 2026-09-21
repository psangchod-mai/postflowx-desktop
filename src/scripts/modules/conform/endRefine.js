/**
 * endRefine.js — pure acceptance logic for independent source-OUT refinement.
 *
 * Ported from V1.4 conform_lib.refine_boundaries(): trailer conform historically
 * assumed srcOut = srcIn + originalSpan; V1.4 instead visually matches the shot's
 * LAST frame to find the true out-point. This module holds the two pure decisions
 * around that match so they can be unit-tested without a DOM/video — index.js
 * does the seeking/hashing and delegates the accept/reject call here.
 *
 * Design invariant: on any weak or implausible end match, callers fall back to
 * the span-derived out (prior behavior), so end refinement can only improve
 * frame accuracy, never regress it.
 */

// Below this end-match confidence (0..100) we don't trust the matched out frame.
export const END_MIN_CONFIDENCE = 55;

// The refined span must stay within this fraction (or absolute frame count,
// whichever is larger) of the source span — otherwise a mismatched end frame is
// dragging the out too far and we keep the span-derived value.
export const SPAN_TOLERANCE_FRAC   = 0.25;
export const SPAN_TOLERANCE_FRAMES = 12;

/**
 * Only normal-speed, forward, static-speed shots may have their OUT independently
 * moved. Retimed / reversed / dynamic-speed shots must preserve their exact
 * source span (record duration × speed defines the out).
 * @param {{reversed:boolean, dynamicSpeed:boolean, speedRatio:number}} metrics
 */
export function isRefinableSpeed(metrics) {
  return !metrics.reversed
    && !metrics.dynamicSpeed
    && metrics.speedRatio >= 0.92
    && metrics.speedRatio <= 1.08;
}

/**
 * Decide whether a visually-matched end frame should replace the span-derived out.
 * @param {{correctedSrcInF:number, matchedEndF:number, endConfidence:number, srcSpanF:number}} p
 * @returns {{srcOutF:number, refinedSpanF:number}|null} accepted out (exclusive) + span, or null to keep span.
 */
export function acceptRefinedEnd({ correctedSrcInF, matchedEndF, endConfidence, srcSpanF }) {
  if (!(srcSpanF > 1)) return null;                          // degenerate span
  if ((endConfidence ?? 0) < END_MIN_CONFIDENCE) return null; // weak end match
  if (matchedEndF <= correctedSrcInF) return null;            // end must follow start

  const refinedSpanF = matchedEndF - correctedSrcInF + 1;
  const tolerance = Math.max(SPAN_TOLERANCE_FRAMES, srcSpanF * SPAN_TOLERANCE_FRAC);
  if (Math.abs(refinedSpanF - srcSpanF) > tolerance) return null;

  return { srcOutF: matchedEndF + 1, refinedSpanF }; // srcOut is exclusive
}
