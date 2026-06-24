// scripts/app/features/edl/pipeline/recOffset.js
// Apply REC (record) timecode offset from the UI "REC TC" input,
// and (optionally) extract default REC start from XMEML (Premiere/FCP7) XML sequence timecode.
//
// Project standard: fps 24 (but caller can pass fps).
//
// IMPORTANT: XMEML contains MANY <timecode> blocks. We specifically read the *direct child*
// <sequence><timecode><string>... which represents the timeline start timecode (record start).

const DEFAULT_FPS = 24;

function pad2(n) {
  return String(Math.max(0, n | 0)).padStart(2, "0");
}

export function tcToFrames(tc, fps = DEFAULT_FPS) {
  if (!tc || typeof tc !== "string") return 0;

  // Accept "HH:MM:SS:FF" and "HH;MM;SS;FF" (drop-frame style delimiter).
  const raw = tc.trim();
  if (!raw) return 0;

  // Strip any non timecode tail (e.g. "01:00:00:00 (rec)")
  const m = raw.match(/^(\d{1,3})[:;](\d{2})[:;](\d{2})(?:[:;](\d{2}))?/);
  if (!m) return 0;

  const hh = parseInt(m[1], 10) || 0;
  const mm = parseInt(m[2], 10) || 0;
  const ss = parseInt(m[3], 10) || 0;
  const ff = parseInt(m[4] ?? "0", 10) || 0;

  return (((hh * 60 + mm) * 60 + ss) * fps) + ff;
}

export function framesToTc(frames, fps = DEFAULT_FPS) {
  const rate = (Number.isFinite(fps) && fps > 0) ? fps : DEFAULT_FPS;
  // Clamp to 0 to avoid negative record timecodes in UI/export.
  let f = Number.isFinite(frames) ? Math.floor(frames) : 0;
  if (f < 0) f = 0;

  const ff = f % rate;
  f = (f - ff) / rate;

  const ss = f % 60;
  f = (f - ss) / 60;

  const mm = f % 60;
  f = (f - mm) / 60;

  const hh = f;

  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

function getNumber(v) {
  const n = typeof v === "string" ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

function pickTimelineFrames(ev) {
  // Prefer explicit timeline fields
  const inCandidates = [
    ev.timelineInFrames, ev.timeline_in_frames, ev.tlInFrames, ev.tl_in_frames,
    ev.timelineIn, ev.timeline_in, ev.inTimelineFrames, ev.in_timeline_frames,
  ];
  const outCandidates = [
    ev.timelineOutFrames, ev.timeline_out_frames, ev.tlOutFrames, ev.tl_out_frames,
    ev.timelineOut, ev.timeline_out, ev.outTimelineFrames, ev.out_timeline_frames,
  ];

  let tlIn = null;
  let tlOut = null;

  for (const c of inCandidates) {
    const n = getNumber(c);
    if (n !== null) { tlIn = n; break; }
  }
  for (const c of outCandidates) {
    const n = getNumber(c);
    if (n !== null) { tlOut = n; break; }
  }

  // Fallback: if record frames exist but timeline frames don't, assume old REC start was 00:00:00:00,
  // meaning recInFrames/recOutFrames were effectively timeline frames.
  if (tlIn === null) {
    const n = getNumber(ev.recInFrames ?? ev.rec_in_frames ?? ev.recordInFrames ?? ev.record_in_frames);
    if (n !== null) tlIn = n;
  }
  if (tlOut === null) {
    const n = getNumber(ev.recOutFrames ?? ev.rec_out_frames ?? ev.recordOutFrames ?? ev.record_out_frames);
    if (n !== null) tlOut = n;
  }

  // Fallback: parse timecode strings (timeline or record), then treat them as timeline frames (old behavior)
  if (tlIn === null) {
    const s = ev.timelineInTc ?? ev.timeline_in_tc ?? ev.timelineInTC ?? ev.timelineInTimecode ??
              ev.recIn ?? ev.rec_in ?? ev.recordIn ?? ev.record_in;
    if (typeof s === "string" && s.trim()) tlIn = tcToFrames(s);
  }
  if (tlOut === null) {
    const s = ev.timelineOutTc ?? ev.timeline_out_tc ?? ev.timelineOutTC ?? ev.timelineOutTimecode ??
              ev.recOut ?? ev.rec_out ?? ev.recordOut ?? ev.record_out;
    if (typeof s === "string" && s.trim()) tlOut = tcToFrames(s);
  }

  // Last-resort: make it safe
  if (tlIn === null) tlIn = 0;
  if (tlOut === null) tlOut = Math.max(0, tlIn);

  return { tlInFrames: tlIn, tlOutFrames: tlOut };
}

export function applyRecTcOffset(events, recStartTc, fps = DEFAULT_FPS) {
  if (!Array.isArray(events) || events.length === 0) return events;

  const recStartFrames = tcToFrames(recStartTc || "00:00:00:00", fps);

  for (const ev of events) {
    if (!ev || typeof ev !== "object") continue;

    const { tlInFrames, tlOutFrames } = pickTimelineFrames(ev);

    // Preserve timeline frames if they weren't explicitly stored
    if (getNumber(ev.timelineInFrames) === null) ev.timelineInFrames = tlInFrames;
    if (getNumber(ev.timelineOutFrames) === null) ev.timelineOutFrames = tlOutFrames;

    const recInFrames = recStartFrames + tlInFrames;
    const recOutFrames = recStartFrames + tlOutFrames;

    const recInTc = framesToTc(recInFrames, fps);
    const recOutTc = framesToTc(recOutFrames, fps);

    // Store multiple aliases for compatibility across UI/export code
    ev.recInFrames = recInFrames;
    ev.recOutFrames = recOutFrames;
    ev.recIn = recInTc;
    ev.recOut = recOutTc;

    ev.recordInFrames = recInFrames;
    ev.recordOutFrames = recOutFrames;
    ev.recordIn = recInTc;
    ev.recordOut = recOutTc;

    ev.recInTc = recInTc;
    ev.recOutTc = recOutTc;
  }

  return events;
}

// -------- XML helpers --------

export function extractXmemlSequenceStartTc(xmlText) {
  if (!xmlText || typeof xmlText !== "string") return null;

  // Use DOMParser (available in Chrome extensions / browsers)
  try {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    const seq = doc.getElementsByTagName("sequence")[0];
    if (!seq) return null;

    // Find direct child <timecode> under <sequence>
    let tcNode = null;
    for (const child of seq.childNodes) {
      if (child && child.nodeType === 1 && child.tagName === "timecode") { // 1 = ELEMENT_NODE
        tcNode = child;
        break;
      }
    }
    if (!tcNode) return null;

    const strNode = tcNode.getElementsByTagName("string")[0];
    const tc = (strNode?.textContent || "").trim();
    if (!tc) return null;

    // Normalize delimiter to ":" for UI/export
    return tc.replace(/;/g, ":");
  } catch (e) {
    // ignore and fallback below
  }

  // Regex fallback (best-effort): read a limited window near the sequence start
  try {
    const seqOpen = xmlText.match(/<sequence\b[^>]*>/i);
    if (!seqOpen) return null;
    const startIdx = xmlText.indexOf(seqOpen[0]);
    if (startIdx < 0) return null;

    // sequence timecode is usually near the top
    const window = xmlText.slice(startIdx, startIdx + 400000);
    const m = window.match(/<sequence\b[\s\S]*?<timecode>[\s\S]*?<string>([^<]+)<\/string>[\s\S]*?<\/timecode>/i);
    if (!m) return null;
    return String(m[1]).trim().replace(/;/g, ":");
  } catch (e) {
    return null;
  }
}
