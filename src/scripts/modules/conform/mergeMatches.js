/**
 * mergeMatches.js — repair over-split shots (V1.4 conform_lib port).
 *
 * Ported from V1.4 conform.py `merge_adjacent_matches()`. Shot detection
 * sometimes over-splits one real shot into two halves (camera flash, fast pan,
 * mid-shot lighting change). When it does, both halves usually match the SAME
 * master at consecutive timecodes — so we use the match results to repair the
 * detector's mistakes.
 *
 * Pure/testable: operates on an ordered array of match objects, returns a new
 * merged array. Only meaningful for the CV-detected-shots path (#1); authored
 * EDL/XML events are never merged (their cuts are intentional).
 */

/**
 * @typedef {Object} ConformMatch
 * @property {number} offlineStart inclusive offline frame
 * @property {number} offlineEnd   inclusive offline frame
 * @property {string|null} masterKey identity of the matched master (name/path); null = NO_MATCH
 * @property {number} masterStart inclusive master frame
 * @property {number} masterEnd   inclusive master frame
 * @property {number} confidence  0..100 (higher = better)
 * @property {string} status      'OK' | 'REVIEW' | 'NO_MATCH' (or trlconf SAFE/REVIEW/FAIL)
 */

const NO_MATCH_STATUSES = new Set(['NO_MATCH', 'FAIL', 'UNMATCH']);

/**
 * Merge consecutive matches that came from the same master at adjacent TCs.
 * @param {ConformMatch[]} matches ordered by offline position
 * @param {object} [opts]
 * @param {number} [opts.gapTolerance=24] max master-frame gap to still merge (1s @ 24fps)
 * @returns {ConformMatch[]}
 */
export function mergeAdjacentMatches(matches, opts = {}) {
  const gapTolerance = opts.gapTolerance ?? 24;
  if (!Array.isArray(matches) || matches.length < 2) return matches ? matches.slice() : [];

  const merged = [matches[0]];
  for (let i = 1; i < matches.length; i++) {
    const nxt = matches[i];
    const prev = merged[merged.length - 1];

    const sameMaster = prev.masterKey != null
      && nxt.masterKey != null
      && prev.masterKey === nxt.masterKey
      && !NO_MATCH_STATUSES.has(prev.status)
      && !NO_MATCH_STATUSES.has(nxt.status);

    const offlineAdjacent = (nxt.offlineStart - prev.offlineEnd) <= 1;
    const masterAdjacent  = Math.abs(nxt.masterStart - prev.masterEnd) <= gapTolerance;
    // Master TCs must go forward — don't merge two unrelated shots that happen to
    // match nearby parts of the same episode in reverse.
    const masterForward   = nxt.masterStart >= prev.masterEnd - gapTolerance;

    if (sameMaster && offlineAdjacent && masterAdjacent && masterForward) {
      const bestConfidence = Math.max(prev.confidence ?? 0, nxt.confidence ?? 0);
      const bestHalf = (prev.confidence ?? 0) >= (nxt.confidence ?? 0) ? prev : nxt;
      merged[merged.length - 1] = {
        ...prev,
        offlineStart: prev.offlineStart,
        offlineEnd:   nxt.offlineEnd,
        masterStart:  prev.masterStart,
        masterEnd:    nxt.masterEnd,
        confidence:   bestConfidence,        // take the better half's confidence
        distance:     bestHalf.distance ?? prev.distance ?? nxt.distance,
        visualDistance: bestHalf.visualDistance ?? prev.visualDistance ?? nxt.visualDistance,
        visualStatus: bestHalf.visualStatus ?? bestHalf.status,
        status:       bestHalf.status,
        merged:       true,
      };
    } else {
      merged.push(nxt);
    }
  }
  return merged;
}
