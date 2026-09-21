// fpsMatch.js — nominal frame-rate comparison (pure, unit-testable).
//
// 23.976 (=24000/1001), 29.97 (=30000/1001) and 59.94 (=60000/1001) are NTSC
// pulldowns of 24/30/60 — the SAME nominal family, sharing a timecode base. A
// frame-rate "mismatch" must be judged on the NOMINAL (rounded) rate, not the
// raw playback value, or 24 vs 23.976 spuriously trips a mismatch prompt.
'use strict';

/** Nominal integer rate: 23.976→24, 29.97→30, 59.94→60, 24→24, 25→25, … */
export function nominalFps(fps) {
  const n = Number(fps);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * True only when two rates differ at the NOMINAL level (e.g. 24 vs 25, 24 vs 30).
 * 24 vs 23.976, 30 vs 29.97, 60 vs 59.94 → false (same family, no prompt).
 */
export function isFpsMismatch(importFps, projFps) {
  const a = nominalFps(importFps);
  const b = nominalFps(projFps);
  if (!a || !b) return false; // unknown rate → don't prompt
  return a !== b;
}
