// imf_timeline_diff.js — cross-CPL resource diff for the multi-layer NLE timeline.
//
// Pure + dependency-free (no DOM) so the compare logic that drives the timeline's
// ≠ outlines, diff strip, and "X/Y reels match" chip can be unit-tested headlessly.
//
// Each entry is { key, cpl } where cpl has { totalFrames, videoResources[],
// audioResources[] } and each resource has a `trackFileId`. Reels are compared by
// INDEX across all loaded CPLs (OV vs supplementals).
'use strict';

/**
 * @param {Array<{key:string, cpl:object}>} entries  loaded CPLs (any order)
 * @param {'video'|'audio'} kind  which resource list to compare
 * @returns {{
 *   maxReels:number, masterFrames:number, matchCount:number,
 *   flags: Object<string, Object<number, boolean>>,  // flags[key][reelIndex] = differs?
 *   strip: Array<'same'|'changed'|'gap'>,            // per reel index (across all CPLs)
 * }}
 */
export function computeCplResourceDiff(entries = [], kind = 'video') {
  const list = Array.isArray(entries) ? entries : [];
  const resOf = e => (kind === 'audio' ? (e?.cpl?.audioResources || []) : (e?.cpl?.videoResources || []));

  const maxReels     = Math.max(0, ...list.map(e => resOf(e).length));
  const masterFrames = Math.max(1, ...list.map(e => e?.cpl?.totalFrames || 1));

  const flags = {};
  const strip = [];
  list.forEach(e => { flags[e.key] = {}; });

  for (let i = 0; i < maxReels; i++) {
    const ids = list.map(e => resOf(e)[i]?.trackFileId || null);
    const present    = ids.filter(Boolean);
    const anyMissing = ids.some(id => id == null);
    const allSame    = present.length > 0 && present.every(id => id === present[0]);
    list.forEach((e, ei) => {
      // A reel "differs" when at least one other CPL has a different (non-null) id here.
      if (ids[ei] != null) flags[e.key][i] = ids.some((id, j) => j !== ei && id != null && id !== ids[ei]);
    });
    strip[i] = anyMissing ? 'gap' : (allSame ? 'same' : 'changed');
  }

  return { maxReels, masterFrames, matchCount: strip.filter(s => s === 'same').length, flags, strip };
}
