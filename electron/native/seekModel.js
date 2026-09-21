// electron/native/seekModel.js
//
// C2 — frame-accurate seek/step parity across the playback engines.
// AVFoundation is frame-native (getStill({frame})); mpv seeks by SECONDS and
// has no frame-seek. This pure module normalizes any seek request (by frame,
// timecode, or seconds) to a canonical frame index, then emits the correct
// per-engine argument — for mpv, the MID-FRAME time `(frame + 0.5)/fps`, which
// reliably lands inside frame N instead of on the N-1/N boundary (the classic
// off-by-one in float seconds→frame seeks). No I/O here → unit-testable; the
// engines call toEngineSeek() and pass its result to their native seek.
//
// CommonJS so electron/native/*.js (main process) can require it. Tests import
// the default export via Node's ESM↔CJS interop.

'use strict';

/** Parse HH:MM:SS:FF (or ';' drop separator) → frame count at nominal rate. */
function tcToFrame(tc, fps) {
  const m = /^(\d+):(\d+):(\d+)[:;](\d+)$/.exec(String(tc || '').trim());
  if (!m) return 0;
  const nominal = Math.max(1, Math.round(fps || 24));
  const [h, mn, s, f] = m.slice(1).map(Number);
  return ((h * 3600 + mn * 60 + s) * nominal) + Math.min(f, nominal - 1);
}

/** Seconds for an absolute (mpv) seek that lands INSIDE frame `frame`. */
function frameToSeconds(frame, fps) {
  const f = Math.max(0, Math.floor(Number(frame) || 0));
  const r = Number(fps) > 0 ? Number(fps) : 24;
  return (f + 0.5) / r;   // mid-frame → robust against float boundary rounding
}

/** Frame index displayed at a given time. Frame N occupies [N/fps, (N+1)/fps),
 *  so FLOOR is correct (round would mis-assign at frame boundaries, breaking the
 *  mid-frame round-trip). The epsilon absorbs float underflow at exact starts. */
function secondsToFrame(seconds, fps) {
  const r = Number(fps) > 0 ? Number(fps) : 24;
  return Math.max(0, Math.floor((Number(seconds) || 0) * r + 1e-6));
}

/**
 * Normalize a seek request → canonical 0-based frame index.
 * @param {{frame?:number, timecode?:string, seconds?:number}} req
 * @param {number} fps
 * @param {string} [startTc] OCF free-run start TC; timecode is taken RELATIVE to it
 */
function normalizeToFrame(req = {}, fps = 24, startTc = '') {
  if (Number.isFinite(req.frame)) return Math.max(0, Math.floor(req.frame));
  if (req.timecode) {
    const base = startTc ? tcToFrame(startTc, fps) : 0;
    return Math.max(0, tcToFrame(req.timecode, fps) - base);
  }
  if (Number.isFinite(req.seconds)) return secondsToFrame(req.seconds, fps);
  return 0;
}

/**
 * Per-engine seek argument for a canonical frame.
 * @returns mpv → {kind:'seconds', seconds, command:['seek', seconds, 'absolute']}
 *          avf/native → {kind:'frame', frame}
 */
function toEngineSeek(frame, fps, engine) {
  const f = Math.max(0, Math.floor(Number(frame) || 0));
  const e = String(engine || '').toLowerCase();
  if (e === 'mpv') {
    const seconds = frameToSeconds(f, fps);
    return { kind: 'seconds', seconds, command: ['seek', seconds, 'absolute'] };
  }
  // AVFoundation / native media engine are frame-native.
  return { kind: 'frame', frame: f };
}

/** Step `delta` frames from the current frame, clamped to ≥ 0. */
function stepFrame(currentFrame, delta) {
  return Math.max(0, (Math.floor(Number(currentFrame) || 0)) + (Math.trunc(Number(delta) || 0)));
}

/**
 * Plan a frame-accurate STILL for any playback engine — closes the thumbnail
 * parity gap: AVFoundation extracts by frame natively, but mpv has no still
 * capability, so an mpv-played clip falls back to ffmpeg seeking the MID-frame
 * time (same `(f+0.5)/fps` landing as the seek path → the still matches the
 * frame the player shows). Returns {extractor, frame, seconds?}.
 * @param {{engine?:string, frame?:number, timecode?:string, seconds?:number}} req
 */
function planStill(req = {}, fps = 24, startTc = '') {
  const frame = normalizeToFrame(req, fps, startTc);
  const e = String(req.engine || '').toLowerCase();
  if (e === 'avf' || e === 'avfoundation' || e === 'native' || e === 'native-avfoundation') {
    return { extractor: 'avf', frame };               // frame-native getStill({frame})
  }
  // mpv / J2K / unknown → ffmpeg at the same mid-frame time the seek lands on.
  return { extractor: 'ffmpeg', frame, seconds: frameToSeconds(frame, fps) };
}

module.exports = {
  tcToFrame, frameToSeconds, secondsToFrame, normalizeToFrame, toEngineSeek, stepFrame, planStill,
};
