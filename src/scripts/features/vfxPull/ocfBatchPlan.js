// scripts/features/vfxPull/ocfBatchPlan.js
//
// Pure planner for the OCF preview "batch render" optimization (perf TODO).
// Today the 7-frame strip (HdlSt, In, 25/50/75%, Out, HdlEnd) issues SEVEN
// separate Resolve renders — each imports the clip, builds a timeline, renders,
// ffmpeg-extracts, cleans up (~150s worst case each). This planner collapses
// them into ONE: render the contiguous HdlSt→HdlEnd range a single time, then
// extract each of the 7 positions by its frame OFFSET within that one render.
//
// The companion needs a `resolveStillBatch` action to consume this plan; that's
// the live-wired half. This module is the verifiable frame math.

/**
 * @param {Array<{label:string, absF:number}>} positions  strip positions (absolute frames)
 * @returns {null | {
 *   renderStart:number, renderEnd:number, frameCount:number,
 *   picks: Array<{label:string, absF:number, offset:number}>
 * }}  null when there are no usable positions.
 */
export function planOcfBatchRender(positions) {
  const valid = (positions || []).filter(p => p && Number.isFinite(p.absF));
  if (!valid.length) return null;

  // Render can't start before frame 0 (handles may reach before the clip head).
  const minAbs = Math.min(...valid.map(p => Math.floor(p.absF)));
  const maxAbs = Math.max(...valid.map(p => Math.floor(p.absF)));
  const renderStart = Math.max(0, minAbs);
  const renderEnd   = Math.max(renderStart, maxAbs);
  const frameCount  = renderEnd - renderStart + 1;

  const picks = valid.map(p => {
    const f = Math.max(renderStart, Math.min(Math.floor(p.absF), renderEnd));
    return { label: p.label, absF: Math.floor(p.absF), offset: f - renderStart };
  });

  return { renderStart, renderEnd, frameCount, picks };
}

/**
 * How many Resolve renders the batch plan saves vs the per-frame approach.
 * @param {number} positionCount
 * @returns {number}  renders avoided (positionCount → 1)
 */
export function batchRenderSavings(positionCount) {
  const n = Math.max(0, Math.floor(Number(positionCount) || 0));
  return n > 1 ? n - 1 : 0;
}
