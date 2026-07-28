// scripts/modules/cutdiff.js
// CUT DIFF engine for PostFlowX — Editorial Diff
// -----------------------------------------------------------------------------
// Compares two normalized event lists (OLD vs NEW) by CLIP IDENTITY:
// matches each NEW event to the best OLD event by clipName + reel, then
// classifies by duration / source-in delta.
//
// Diff types:
//   UNCHANGED : same clip, same duration (within tolerance), same srcIn
//   EXTENDED  : same clip, NEW duration > OLD duration
//   TRIMMED   : same clip, NEW duration < OLD duration
//   CHANGED   : same clip name but different take/src-in (>tolerance)
//   NEW       : clip appears in NEW but has no identity match in OLD

import { nominalBase } from './utils_time.js';

export const DIFF_TYPES = {
  NEW       : 'NEW',
  EXTENDED  : 'EXTENDED',
  CHANGED   : 'CHANGED',
  TRIMMED   : 'TRIMMED',
  UNCHANGED : 'UNCHANGED',
};

function safeFps(evFps, fallback = 24) {
  const n = Number(evFps);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Timecode counts on the whole-frame base, not the playback rate: HH:MM:SS:FF
// has no fractional field, so 23.976 fits 24 of them into a timecode second and
// 29.97 NDF fits 30. Scaling by the fractional rate made every frame count here
// fractional — a four-second clip measured 95.90400000000955 frames, and that
// number is not just displayed, it leaves this module as `durationFrames` and
// `_pullLenFrames`, which is the length of a VFX pull.
export function tcToFrames(tc, fps) {
  if (!tc) return 0;
  // Drop-frame EDLs use "HH:MM:SS;FF" — normalise the semicolon to a colon so
  // DF timecodes split into 4 fields instead of silently failing the length
  // check below and collapsing every DF in/out point to 0.
  const parts = String(tc).replace(/;/g, ':').split(':').map(n => parseInt(n, 10) || 0);
  if (parts.length !== 4) return 0;
  const [hh, mm, ss, ff] = parts;
  return ((hh * 60 + mm) * 60 + ss) * nominalBase(fps) + ff;
}

function framesToTc(fr, fps) {
  // Same base as tcToFrames so the pair round-trips. The fractional rate as a
  // modulus left `ff` fractional, and padStart does not round, so this would
  // have emitted "01:00:04:0.5039999999898" — except that it could not: the
  // four call sites below are all `ev.X || framesToTc(nf.XF, fps)`, and nf.XF
  // is tcToFrames(ev.X), so when the fallback fires ev.X was falsy, the parse
  // returned 0, and the only reachable output is "00:00:00:00". Fixed because
  // the next caller will not be shielded by that accident, not because this
  // one was breaking.
  const rate = nominalBase(safeFps(fps, 24));
  let v = Math.max(0, Math.round(Number(fr) || 0));
  const ff = v % rate; v = Math.floor(v / rate);
  const ss = v % 60;   v = Math.floor(v / 60);
  const mm = v % 60;   const hh = Math.floor(v / 60);
  const p = n => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

// A trailing "_A" / "_AB" / "_A2" angle-or-take suffix — stripped only for
// matching, never for display. Requires at least one letter after the
// underscore so purely numeric suffixes ("_010", take counters) are left
// alone and still distinguish otherwise-identical clip names.
const ANGLE_SUFFIX_RE = /_[A-Za-z]+\d*$/;

// Normalise a clip identity key — strip trailing counters / angle suffixes
// so that `101-08-06/01_A` and `101-08-06/01_AB` still cluster together,
// but keep enough specificity to avoid false matches.
function identityKey(clipName, reel) {
  const name = (clipName || '').trim().replace(ANGLE_SUFFIX_RE, '');
  const r    = (reel    || '').trim();
  return r ? `${r}||${name}` : name;
}

function evFrames(ev, fps) {
  const srcInF  = tcToFrames(ev.srcIn,  fps);
  const srcOutF = tcToFrames(ev.srcOut, fps);
  const recInF  = tcToFrames(ev.recIn,  fps);
  const recOutF = tcToFrames(ev.recOut, fps);
  const durF    = srcOutF > srcInF ? srcOutF - srcInF
                : recOutF > recInF ? recOutF - recInF
                : Number(ev.durationFrames || ev._lenFrames || 0);
  return { srcInF, srcOutF, recInF, recOutF, durF };
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeCutDiff(oldEvents, newEvents, opts = {}) {
  const includeTrimmed   = opts.includeTrimmed   !== false; // default true
  const includeUnchanged = !!opts.includeUnchanged;         // default false
  const durTol           = opts.durTol  ?? 2;   // frames — same-duration tolerance
  const srcTol           = opts.srcTol  ?? 4;   // frames — same-source tolerance

  const defaultFps =
    (newEvents?.[0]?.fps) || (oldEvents?.[0]?.fps) || 24;

  // ── Index OLD events by identity key ──────────────────────────────────────
  // key → array of { ev, srcInF, srcOutF, recInF, recOutF, durF, used }
  const oldIndex = new Map();
  for (const ev of (oldEvents || [])) {
    const fps = safeFps(ev.fps, defaultFps);
    const key = identityKey(ev.clipName, ev.reel);
    if (!oldIndex.has(key)) oldIndex.set(key, []);
    oldIndex.get(key).push({ ev, fps, ...evFrames(ev, fps), used: false });
  }

  const out = [];

  for (const ev of (newEvents || [])) {
    const fps  = safeFps(ev.fps, defaultFps);
    const nf   = evFrames(ev, fps);
    const key  = identityKey(ev.clipName, ev.reel);
    const candidates = oldIndex.get(key) || [];

    // ── Find best unused OLD match ──────────────────────────────────────────
    // Score = duration delta + small weight on srcIn delta
    let best = null, bestScore = Infinity;
    for (const c of candidates) {
      if (c.used) continue;
      const durDelta = Math.abs(c.durF - nf.durF);
      const srcDelta = Math.abs(c.srcInF - nf.srcInF);
      const score    = durDelta + srcDelta * 0.05;
      if (score < bestScore) { bestScore = score; best = c; }
    }

    if (!best) {
      // No identity match in OLD → NEW clip
      out.push(_makeResult(ev, DIFF_TYPES.NEW, nf, null, fps));
      continue;
    }

    best.used = true; // consume this OLD entry

    const durDelta = nf.durF - best.durF;   // positive = NEW longer
    const srcDelta = Math.abs(nf.srcInF - best.srcInF);
    const durSame  = Math.abs(durDelta) <= durTol;
    const srcSame  = srcDelta <= srcTol;

    let diffType;
    if (durSame && srcSame) {
      diffType = DIFF_TYPES.UNCHANGED;
    } else if (!durSame && durDelta > 0) {
      diffType = DIFF_TYPES.EXTENDED;
    } else if (!durSame && durDelta < 0) {
      diffType = DIFF_TYPES.TRIMMED;
    } else {
      // Same duration but different source (retimed, regraded, different take)
      diffType = DIFF_TYPES.CHANGED;
    }

    if (diffType === DIFF_TYPES.UNCHANGED && !includeUnchanged) continue;
    if (diffType === DIFF_TYPES.TRIMMED   && !includeTrimmed)   continue;

    out.push(_makeResult(ev, diffType, nf, best, fps));
  }

  return out;
}

function _makeResult(ev, diffType, nf, oldMatch, fps) {
  const durF = nf.durF;
  const recF = nf.recOutF > nf.recInF ? nf.recOutF - nf.recInF : durF;
  return {
    ...ev,
    diffType,
    durationFrames : durF,
    _lenFrames     : recF,
    _pullLenFrames : durF,
    // Populate recIn/recOut from NEW event (preserve original)
    recIn  : ev.recIn  || framesToTc(nf.recInF,  fps),
    recOut : ev.recOut || framesToTc(nf.recOutF, fps),
    srcIn  : ev.srcIn  || framesToTc(nf.srcInF,  fps),
    srcOut : ev.srcOut || framesToTc(nf.srcOutF, fps),
    // Attach OLD match info for inspector / video seek
    matchOldRecIn  : oldMatch?.ev?.recIn  || null,
    matchOldRecOut : oldMatch?.ev?.recOut || null,
    matchOldSrcIn  : oldMatch?.ev?.srcIn  || null,
    matchOldClip   : oldMatch?.ev?.clipName || null,
    matchScore     : oldMatch ? _matchScore(nf, oldMatch) : 0,
  };
}

// Confidence score 0–1: 1 = perfect match, 0 = completely different
function _matchScore(nf, old) {
  const durDelta = Math.abs(nf.durF  - old.durF);
  const srcDelta = Math.abs(nf.srcInF - old.srcInF);
  const maxDur   = Math.max(1, nf.durF, old.durF);
  const durScore = 1 - Math.min(1, durDelta / maxDur);
  const srcScore = 1 - Math.min(1, srcDelta / Math.max(1, 240));
  return Math.round((durScore * 0.6 + srcScore * 0.4) * 100) / 100;
}

export function summarizeDiff(diff) {
  const s = { total: diff.length || 0, NEW: 0, EXTENDED: 0, CHANGED: 0, TRIMMED: 0, UNCHANGED: 0 };
  for (const ev of (diff || [])) {
    const t = ev.diffType || DIFF_TYPES.CHANGED;
    if (t in s) s[t]++;
  }
  return s;
}
