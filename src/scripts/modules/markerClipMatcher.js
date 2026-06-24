// markerClipMatcher.js — Match VFX shot markers to timeline clips by record TC.
//
// matchMarkersToTimelineClips(markers, clips, fps, options?)
//   markers: array of { id, recIn, recOut?, tcIn?, tcOut?, shotName?, ... }
//   clips:   array from buildClipsFromEvents() or equivalent
//   fps:     timeline frame rate (number)
//   options: { preferTrack?: number }  — 0 = prefer V1 (default)
//
// Returns Map<markerId, MatchResult>
//   MatchResult: { markerId, matchStatus, confidence,
//                  matchedClipId, matchedTrack, matchedClipName, matchedSourceFile,
//                  sourceIn, sourceOut, candidates, warning }
//
// matchStatus: 'matched' | 'multi_match' | 'orphan' | 'conflict'
// confidence:  100 (exact, single clip) | 80 (overlap only) | 50 (multi_match) | 0 (orphan)

function _tcf(tc, fps) {
  if (!tc || !fps) return 0;
  const parts = String(tc).split(/[:;]/);
  if (parts.length < 4) return 0;
  const [h, m, s, f] = parts.map(Number);
  return ((h * 3600 + m * 60 + s) * Math.round(fps) + f) | 0;
}

/**
 * Build a flat, normalised clip array from raw _pmEvents-style EDL event objects.
 * Each returned clip is ready to pass to matchMarkersToTimelineClips().
 */
export function buildClipsFromEvents(events, fps) {
  const clips = [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || typeof ev !== 'object') continue;
    const eIn  = _tcf(ev.recIn  || '00:00:00:00', fps);
    const eOut = _tcf(ev.recOut || '00:00:00:00', fps);
    const outF = eOut > eIn ? eOut : eIn + 1;
    clips.push({
      clipId:     i,
      clipName:   ev.clipName || ev.reel || '',
      trackIndex: ev.trackIndex ?? 0,
      trackRaw:   ev.trackRaw  || ev.role || `V${(ev.trackIndex ?? 0) + 1}`,
      srcFile:    ev.srcFile   || ev.reel || '',
      recInF:     eIn,
      recOutF:    outF,
      srcIn:      ev.srcIn  || '',
      srcOut:     ev.srcOut || '',
    });
  }
  return clips;
}

/**
 * Match each VFX marker to the timeline clip whose record range contains it.
 *
 * Algorithm priority (for each marker):
 *   1. Exact containment: marker.recIn ∈ [clip.recIn, clip.recOut)
 *      → if multiple, prefer preferTrack (default V1), then highest overlap
 *      → single exact  → matched / confidence 100
 *      → multiple exact → multi_match / confidence 50
 *   2. Overlap only: marker range ∩ clip range > 0
 *      → best overlap clip → matched / confidence 80
 *   3. No candidate → orphan / confidence 0
 *
 * Duplicate marker ranges (req 15) are intentional — each marker is evaluated
 * independently; two markers on the same recIn both match the same clip without
 * triggering conflict.
 *
 * @param {Array}  markers
 * @param {Array}  clips        — from buildClipsFromEvents()
 * @param {number} fps
 * @param {object} options
 * @returns {Map<string, object>}  markerId → MatchResult
 */
export function matchMarkersToTimelineClips(markers, clips, fps, options = {}) {
  const preferTrack = options.preferTrack ?? 0;
  const results = new Map();

  for (const mk of markers) {
    const mInF  = _tcf(mk.recIn  || mk.tcIn  || '00:00:00:00', fps);
    const mOutF = _tcf(mk.recOut || mk.tcOut || '00:00:00:00', fps);
    const mEndF = mOutF > mInF ? mOutF : mInF + 1;

    const exactCands   = [];
    const overlapCands = [];

    for (const clip of clips) {
      // Exact containment: marker start is within the clip
      if (mInF >= clip.recInF && mInF < clip.recOutF) {
        const ols = Math.max(mInF, clip.recInF);
        const ole = Math.min(mEndF, clip.recOutF);
        exactCands.push({ clip, overlap: Math.max(0, ole - ols), exact: true });
      } else {
        // Overlap: any intersection
        const ols = Math.max(mInF, clip.recInF);
        const ole = Math.min(mEndF, clip.recOutF);
        if (ole > ols) {
          overlapCands.push({ clip, overlap: ole - ols, exact: false });
        }
      }
    }

    const allCands = [...exactCands, ...overlapCands];

    if (!allCands.length) {
      console.log('[ClipMatch] ORPHAN', mk.id, mk.shotName, { mInF, mEndF });
      results.set(mk.id, {
        markerId:          mk.id,
        matchStatus:       'orphan',
        confidence:        0,
        matchedClipId:     null,
        matchedTrack:      null,
        matchedClipName:   null,
        matchedSourceFile: null,
        sourceIn:          null,
        sourceOut:         null,
        candidates:        [],
        warning:           'No timeline clip found at marker record TC',
      });
      continue;
    }

    // Sort: exact first, then preferTrack, then highest overlap
    const sorted = allCands.slice().sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      const ap = a.clip.trackIndex === preferTrack ? 0 : 1;
      const bp = b.clip.trackIndex === preferTrack ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return b.overlap - a.overlap;
    });

    const best       = sorted[0];
    const isMulti    = exactCands.length > 1;
    const isExact    = best.exact;
    const confidence = isMulti ? 50 : (isExact ? 100 : 80);
    const status     = isMulti ? 'multi_match' : 'matched';

    const warning = isMulti
      ? `Marker falls on ${exactCands.length} clips — best: ${best.clip.trackRaw} ${best.clip.clipName}`
      : !isExact ? 'Overlap match — marker start is outside clip range' : null;

    console.log('[ClipMatch]', status, mk.id, mk.shotName, {
      confidence, clip: best.clip.clipName, track: best.clip.trackRaw, mInF,
    });

    results.set(mk.id, {
      markerId:          mk.id,
      matchStatus:       status,
      confidence,
      matchedClipId:     best.clip.clipId,
      matchedTrack:      best.clip.trackRaw,
      matchedClipName:   best.clip.clipName,
      matchedSourceFile: best.clip.srcFile,
      sourceIn:          best.clip.srcIn,
      sourceOut:         best.clip.srcOut,
      candidates:        sorted.map(c => ({
        clipId:   c.clip.clipId,
        clipName: c.clip.clipName,
        trackRaw: c.clip.trackRaw,
        overlap:  c.overlap,
        exact:    c.exact,
      })),
      warning,
    });
  }

  return results;
}
