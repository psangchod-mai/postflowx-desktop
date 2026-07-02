// ─────────────────────────────────────────────────────────────────────────────
// pullRange.js — canonical conform pull-range math (pure, unit-testable).
//
// The single source of truth for "what source frames does this event actually
// need pulled", accounting for:
//   • per-event frame rate (timecode base derived from the event's own fps),
//   • constant-speed retime (slow-mo / overcrank) → the native source window is
//     longer/shorter than the timeline segment suggests,
//   • dissolves / wipes → the transition region must be covered by the pull,
//   • configurable head/tail handles.
//
// No DOM, no globals — TC conversion is delegated to utils_time so there is one
// implementation of timecode math in the app.
// ─────────────────────────────────────────────────────────────────────────────

import { tcToFrames, framesToTC } from './utils_time.js';

/**
 * Normalize a raw speed value to a percentage (100 = normal speed).
 * EDLs store a percent (e.g. 150 for 150%); some sources store a ratio
 * (1.5 or 0.5). Heuristic: |v| <= 10 is treated as a ratio (×100), otherwise
 * it is already a percent. Mirrors the app's existing speedFactor handling.
 */
export function normalizeSpeedPercent(raw) {
  const v = Number(raw);
  if (!Number.isFinite(v) || v === 0) return 100;
  // Use the MAGNITUDE: a reverse retime (e.g. -50% or ratio -1.5) carries the
  // same source-frame span as its forward counterpart; direction is handled
  // separately. Previously negatives fell through to 100% and under-pulled.
  const mag = Math.abs(v);
  const pct = mag <= 10 ? mag * 100 : mag;
  return pct > 0 ? pct : 100;
}

/**
 * Read an event's speed as a percent, or null when no speed field is present.
 * Accepts speedPercent / speedFactor / speed — the EDL parser sets
 * speed/speedFactor (NOT speedPercent), which is why the matcher's old
 * `event.speedPercent` check never fired for EDL imports.
 */
export function readSpeedPercent(event = {}) {
  for (const k of ['speedPercent', 'speedFactor', 'speed']) {
    const raw = event[k];
    if (raw != null && Number.isFinite(Number(raw))) return normalizeSpeedPercent(raw);
  }
  return null;
}

/** True when the event carries a multi-keyframe (dynamic) retime. */
export function isDynamicRetime(event = {}) {
  return Array.isArray(event.speedKeys) && event.speedKeys.length > 1;
}

/**
 * Source timecode displayed at a given timeline (record) frame, for a clip
 * played 1:1. The source TC is formatted at the clip's OWN frame rate so a
 * 30p clip in a 24p timeline shows correct 0–29 frame digits.
 *
 * Regression-safe: when sourceFps === timelineFps this is algebraically
 * identical to the legacy single-fps formula
 * `framesToTC(recordFrame + (srcInF - recInF), fps)`.
 */
export function sourceTcAtRecord({ srcIn, recIn, recordFrame, sourceFps, timelineFps } = {}) {
  const sFps = Math.max(1, Math.round(Number(sourceFps) || Number(timelineFps) || 24));
  const tFps = Math.max(1, Math.round(Number(timelineFps) || sFps));
  const srcInF = tcToFrames(srcIn || '00:00:00:00', sFps);
  const recInF = tcToFrames(recIn || '00:00:00:00', tFps);
  const f = srcInF + (Number(recordFrame) || 0) - recInF;
  return framesToTC(Math.max(0, f), sFps);
}

/** Frames in a dissolve/wipe transition token ("D025"→25, "W012"→12, "C"/""→0). */
export function parseTransitionFrames(transition) {
  const m = /^([DW])\s*0*(\d+)$/i.exec(String(transition || '').trim());
  return m ? (parseInt(m[2], 10) || 0) : 0;
}

/**
 * Compute the effective source pull range for an event.
 *
 * opts:
 *   fps                          fallback frame rate if the event has none
 *   handleHead, handleTail       extra handle frames (default 0)
 *   includeTransitionInHandles   add the transition duration to handles (default true)
 *
 * Returns frame counts and timecodes for:
 *   srcIn/srcOut    — effective source range with retime applied, BEFORE handles
 *   pullIn/pullOut  — final pull range INCLUDING handles + transition coverage
 */
export function computePullRange(event = {}, opts = {}) {
  const notes = [];
  const fps = Number(event.fps) || Number(opts.fps) || 24;
  // Timecode base = whole frames per second (23.976→24, 29.97→30, 25→25).
  const tcBase = Math.max(1, Math.round(fps));

  const srcInF  = tcToFrames(event.srcIn || '00:00:00:00', tcBase);
  const rawOutF = tcToFrames(event.srcOut || event.srcIn || '00:00:00:00', tcBase);

  // 1. Retime (constant speed): the native source window differs from the
  //    timeline segment. Anchor on srcIn; recompute the source out.
  let effOutF = Math.max(srcInF, rawOutF);
  const dynamic = isDynamicRetime(event);
  const speedPercent = readSpeedPercent(event);
  if (speedPercent != null && !dynamic && Math.abs(speedPercent - 100) > 0.5) {
    const timelineDur = effOutF - srcInF;
    const nativeDur = Math.max(0, Math.round(timelineDur * (100 / speedPercent)));
    effOutF = srcInF + nativeDur;
    notes.push(`retime ${speedPercent}% → source ${timelineDur}f → ${nativeDur}f`);
  } else if (dynamic) {
    notes.push('dynamic retime — source range is an estimate; verify handles');
  }

  // 2. Transition handles: the dissolve/wipe region must be pulled.
  const transitionFrames = parseTransitionFrames(event.transition);
  const transHandle = (opts.includeTransitionInHandles !== false) ? transitionFrames : 0;
  if (transHandle) notes.push(`transition ${event.transition} → +${transHandle}f handles`);

  // 3. Configurable handles (transition coverage folded in).
  const handleHead = Math.max(0, Number(opts.handleHead) || 0) + transHandle;
  const handleTail = Math.max(0, Number(opts.handleTail) || 0) + transHandle;

  const pullInF  = Math.max(0, srcInF - handleHead);
  const pullOutF = effOutF + handleTail;

  return {
    fps, tcBase,
    speedPercent: speedPercent == null ? 100 : speedPercent,
    dynamicRetime: dynamic,
    transitionFrames,
    srcInFrames: srcInF,
    srcOutFrames: effOutF,
    srcInTc: framesToTC(srcInF, tcBase),
    srcOutTc: framesToTC(effOutF, tcBase),
    handleHead, handleTail,
    pullInFrames: pullInF,
    pullOutFrames: pullOutF,
    pullInTc: framesToTC(pullInF, tcBase),
    pullOutTc: framesToTC(pullOutF, tcBase),
    durationFrames: pullOutF - pullInF,
    notes,
  };
}
