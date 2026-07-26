// modules/eventDuration.js
// How long an event runs, in frames — the one question the Event Table, the EDL
// record map and the Inspector all have to answer, and the one they each answered
// with their own private copy of the same broken fallback chain.
//
// Extracted from ui.js so it can be tested at all. Everything in ui.js is private
// to a 20k-line module that node cannot import (it touches `document` at load), so
// the chain below had never once been run by a test — and it was broken in a way
// only a test would have found.

import { nominalBase } from "./utils_time.js";

/**
 * Parse "HH:MM:SS:FF" to an absolute frame count, or NaN if `tc` is not a timecode.
 *
 * NaN, not 0. ui.js's private parser returned 0 for anything it could not read, and
 * every caller checked the result with Number.isFinite. 0 is finite, so "this is not
 * a timecode" and "this is frame zero" became the same answer to that question. The
 * guard in durationFramesFor —
 *
 *     Number.isFinite(si) && Number.isFinite(so) && so >= si
 *
 * — therefore reduced to `0 >= 0`, which is always true, and the record-timecode
 * fallback underneath it was unreachable. Any event whose source timecode was
 * absent, empty, malformed, drop-frame or three-part took the source branch,
 * measured 0 - 0, and reported a duration of zero instead of falling through to the
 * record columns that would have answered correctly. A sentinel that passes the
 * caller's validity check is worse than a value that fails it.
 *
 * Accepts `;` as a separator so a drop-frame timecode reads as a timecode rather
 * than as nothing. The frame fields are then counted as non-drop, which is this
 * app's established convention (utils_time.js says so in as many words). For a
 * duration — a difference between two timecodes on the same timeline — the dropped
 * labels cancel except across a minute boundary, where this reads at most a frame or
 * two long. True drop-frame arithmetic lives in modules/conform/edlParser.js if an
 * exact answer is ever needed here; reading DF as zero, which is what shipped, is
 * not the safer of the two errors.
 *
 * Also tolerates the fractional subframe suffix DaVinci Resolve 21 emits ("12.5").
 */
export function parseTimecodeFrames(tc, fps) {
  const m = String(tc ?? "").trim().match(/^(\d{1,4})[:;](\d{1,2})[:;](\d{1,2})[:;](\d{1,3})(?:\.\d+)?$/);
  if (!m) return NaN;
  const hh = +m[1], mm = +m[2], ss = +m[3], ff = +m[4];
  // The whole-frame base, shared with utils_time.js rather than re-derived: 23.976
  // fits 24 frame fields into a timecode second, 29.97 NDF fits 30. Counting on the
  // fractional rate is what made a five-second span at 23.976 measure 119.88 frames
  // and format as "00:00:05:0.12000000000000455".
  return ((hh * 3600) + (mm * 60) + ss) * nominalBase(fps) + ff;
}

/**
 * The duration of one event in frames: explicit count, else source span, else
 * record span, else NaN.
 *
 * NaN means "this event does not say how long it is" — which is not the same
 * statement as "this event is zero frames long", and the two callers want it told
 * apart differently. Use durationFramesFor() if you are summing.
 */
export function measuredDurationFrames(ev, fps) {
  if (ev && Number.isFinite(ev.durationFrames)) return Math.max(0, Math.round(ev.durationFrames));

  const si = parseTimecodeFrames(ev?.srcIn, fps);
  const so = parseTimecodeFrames(ev?.srcOut, fps);
  if (Number.isFinite(si) && Number.isFinite(so) && so >= si) return so - si;

  const ri = parseTimecodeFrames(ev?.recIn, fps);
  const ro = parseTimecodeFrames(ev?.recOut, fps);
  if (Number.isFinite(ri) && Number.isFinite(ro) && ro >= ri) return ro - ri;

  return NaN;
}

/**
 * As measuredDurationFrames, but an unreadable event counts as 0 rather than NaN.
 *
 * For callers that add: the record map lays clips out back-to-back, so a zero-length
 * event collapses into its neighbour and is visible as such, while one NaN would
 * poison the running total for every event after it. Callers that *display* a
 * duration should use measuredDurationFrames and say "unknown" instead of "0".
 */
export function durationFramesFor(ev, fps) {
  const d = measuredDurationFrames(ev, fps);
  return Number.isFinite(d) ? d : 0;
}
