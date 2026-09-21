/**
 * multiMaster.js — cross-master library search cores (V1.4 conform_lib port).
 *
 * V1.4 (conform.py search_library) searches EVERY indexed master for each
 * offline shot and keeps the single best hit. Trailer Conform historically
 * pinned each clip to one master by episode number (_buildReelMap). Trailers
 * pull from many episodes and clip names don't always carry a usable episode
 * number, so a shot can be mis-pinned or unpinned.
 *
 * These pure helpers decide (a) when the per-episode match is too weak to trust
 * and a whole-library search is warranted, and (b) which master won that search.
 */

// Below this per-episode confidence (0..100) we don't trust the pinned master and
// fall back to searching all masters (mirrors trlconf's own 68 wide-search gate).
export const WEAK_MATCH_CONFIDENCE = 68;

/**
 * Cross-master fallback is useful only for editorial events that identify an
 * episode source. Generic leaders, cards, and intro/outro graphics do not live
 * in the episode masters; sweeping every 40+ minute master for them can turn a
 * short conform into an hour-long run without producing a usable correction.
 */
export function isEpisodeLibraryEvent(event) {
  const label = [event?.reel, event?.srcFile, event?.clipName, event?.name]
    .filter(Boolean)
    .join(' ');
  return /(?:TNG2|TheBelieversSeason2)[_\s-]*20[1-9](?:\D|$)/i.test(label);
}

/**
 * Should we run a whole-library search for this event?
 * @param {{confidence?:number}|null} primaryResult per-episode match, or null if unpinned
 * @param {number} [minConfidence=WEAK_MATCH_CONFIDENCE]
 */
export function shouldSearchAllMasters(primaryResult, minConfidence = WEAK_MATCH_CONFIDENCE) {
  if (!primaryResult) return true;                     // no pinned master at all
  return (primaryResult.confidence ?? 0) < minConfidence;
}

/**
 * Pick the best result across masters. Each entry pairs a master identity with
 * its search result. Highest confidence wins; ties broken by lower distance.
 * @param {{masterKey:string, masterName?:string, result:{confidence?:number, distance?:number}}[]} candidates
 * @returns {{masterKey:string, masterName?:string, result:object}|null}
 */
export function pickBestMaster(candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  let best = null;
  for (const c of candidates) {
    if (!c || !c.result) continue;
    if (best === null) { best = c; continue; }
    const cc = c.result.confidence ?? 0;
    const bc = best.result.confidence ?? 0;
    if (cc > bc) { best = c; continue; }
    if (cc === bc && (c.result.distance ?? Infinity) < (best.result.distance ?? Infinity)) best = c;
  }
  return best;
}

/**
 * Given the pinned-master result and a whole-library best, return whichever is
 * stronger — but only replace the pinned master if the library beat it by a
 * meaningful margin, to avoid flapping between near-equal masters.
 * @param {{masterKey:string, result:{confidence?:number}}|null} pinned
 * @param {{masterKey:string, result:{confidence?:number}}|null} libraryBest
 * @param {number} [margin=6] confidence points the library must win by to override
 */
export function resolveMaster(pinned, libraryBest, margin = 6) {
  if (!libraryBest) return pinned;
  if (!pinned) return libraryBest;
  if (libraryBest.masterKey === pinned.masterKey) {
    // same master won — keep the better result of the two
    return (libraryBest.result.confidence ?? 0) > (pinned.result.confidence ?? 0) ? libraryBest : pinned;
  }
  return ((libraryBest.result.confidence ?? 0) - (pinned.result.confidence ?? 0) >= margin)
    ? libraryBest
    : pinned;
}
