// modules/parser_fcpxml.js
// FCPXML parser — recursive decompose + correct nested offsets + sequence TC start
// NORMALIZES reel from Resolve/FCPX:
//   - Resolve: <asset name="A_0001C012_251026_075200_c1I89.mov">
//   - FCPX:    <video name="A_0001C012_251026_075200_c1I89.mov - v1">
//   - strip " - v1" / " - v2" and extension → reel = "A_0001C012_251026_075200_c1I89"
// ไม่ใช้ clipName เป็นแหล่งรีล ยกเว้นกรณีที่ไม่มี asset และ video จริง ๆ
//
// TWO RATES, DELIBERATELY.
// Every FCPXML time attribute is a rational number of REAL seconds, and the
// frame index it denotes is value / frameDuration — so seconds→frames must use
// the true rate (24000/1001 = 23.976…). A timecode label has no fractional
// frame field, so frames→HH:MM:SS:FF must use the whole-frame base (24).
// The `fps` threaded through this file is now the EXACT rate; nominalBase() is
// applied at the two places a whole number is required (the timecode pair) and
// at every place a rate leaves the module (`res.fps`, `event.fps`, `srcFps`),
// so the public contract is unchanged — only the timecodes are now right.
//
// Returns:
// {
//   events: [{
//     clipName, srcFile, reel, srcIn, srcOut, recIn, recOut,
//     fps, role, type, markers, _markers,
//     disabled   // ✅ true ถ้ามาจาก clip ที่ enabled="0" หรืออยู่ใต้พ่อที่ถูกปิด
//   }],
//   projectName,
//   fps,        // WHOLE-FRAME timecode base (24 for a 23.976 show) — see below
//   fpsExact    // TRUE playback rate (23.976023976…) — see below
// }
//
// The two-rate contract, shared by every parser in this directory:
//   `fps`      is the number of frame fields in one timecode second. It is
//              always a whole number, and it is what TC↔frames math must use.
//   `fpsExact` is the real-time playback rate. It is what real-time math must
//              use: seconds↔frames, an A/V clock, a comp's frame rate.
// They differ by 0.1% on every NTSC rate, which is 3.6 seconds per hour — small
// enough to look like nothing in a unit test and large enough to lose sync.
// Consumers that only build timecode strings can keep reading `fps` alone.

import { nominalBase } from '../modules/utils_time.js';

export function parseFCPXML(xmlText) {
  try {
    const safe = sanitizeXML(xmlText);
    const doc  = new DOMParser().parseFromString(safe, "application/xml");
    const perr = doc.querySelector("parsererror");
    if (perr) throw new Error(perr.textContent?.trim().slice(0, 200) || "XML parser error");
    if (!doc.querySelector("fcpxml")) return { events: [], projectName: "—", fps: 24 };

    // ---- Project name
    const projectName =
      doc.querySelector("project")?.getAttribute("name") ||
      doc.querySelector("library")?.getAttribute("name") ||
      doc.querySelector("event")?.getAttribute("name") ||
      "PROJECT";

    // ---- FPS
    // fps is resolved after formats map is built and mainSeq is found
    // (see "Resolve FPS" block below)

    // ---- Formats + Assets map (for src filenames + best-effort source FPS)
    const formats = {};
    doc.querySelectorAll("resources > format[id][frameDuration]").forEach(fmt => {
      const id = fmt.getAttribute("id");
      if (!id) return;
      const fdRaw = (fmt.getAttribute("frameDuration") || "").trim(); // e.g. "100/2400s"
      const fd = fdRaw.endsWith("s") ? fdRaw.slice(0, -1) : fdRaw;
      const parts = fd.split("/");
      if (parts.length === 2) {
        const num = Number(parts[0]);
        const den = Number(parts[1]);
        if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) {
          // Exact, unrounded: "1001/24000s" is 23.976…, and rounding it here to
          // 24 is what made every seconds→frames conversion below drift.
          const v = den / num;
          if (v > 0) formats[id] = v;
        }
      }
    });

    const assets = {};
    doc.querySelectorAll("resources > asset[id]").forEach(a => {
      const id = a.getAttribute("id");
      if (!id) return;
      const name = a.getAttribute("name") || "";
      const fmtId = a.getAttribute("format");
      // Reported, never used for arithmetic — so it leaves as a nominal rate.
      const srcFps = (fmtId && formats[fmtId]) ? nominalBase(formats[fmtId]) : null;
      // Real camera filename from media-rep src — authoritative OCF identity that
      // survives clip renames in FCP X (the 'name' attribute does not).
      let file = "";
      try {
        const src = a.querySelector('media-rep[src]')?.getAttribute('src') || "";
        if (src) file = decodeURIComponent(src.split(/[\\/]/).pop() || "");
      } catch {}
      assets[id] = { name, srcFps, file };
    });
    // ---- Effects map (for titles/generators)
    const effects = {};
    try {
      doc.querySelectorAll("resources > effect[id]").forEach(eff => {
        const id = eff.getAttribute("id");
        if (!id) return;
        const name = eff.getAttribute("name") || "";
        const uid  = eff.getAttribute("uid") || "";
        effects[id] = { name, uid };
      });
    } catch {}


    // ---- Media map (multicam -> resolve underlying OCF per active angle)
    // Many FCPXML timelines use <mc-clip ref="rX"> where rX points to <media id="rX"><multicam>...
    // In that case the real camera filename lives under:
    //   media(id=rX) -> multicam -> mc-angle(angleID=...) -> asset-clip/clip/video
    // We build a small index so mc-clip events can expose the original camera file name.
    const medias = {};
    try {
      doc.querySelectorAll('resources > media[id]').forEach(m => {
        const id = m.getAttribute('id');
        if (!id) return;
        const mc = firstChild(m, 'multicam');
        if (!mc) return;

        const angles = {};
        mc.querySelectorAll(':scope > mc-angle[angleID]').forEach(ang => {
          const angleID = ang.getAttribute('angleID');
          if (!angleID) return;

          // Resolve underlying camera media for this angle.
          // FCPXML variants:
          //   A) <asset-clip ref=\"rX\" name=\"A001C...\">
          //   B) <clip ...><video ref=\"rX\" name=\"A001C... - v1\">...
          //   C) reel stored in metadata on clip/multicam
          let vref = '';
          let vname = '';
          let reelMeta = '';
          try {
            const aclip = ang.querySelector('asset-clip[ref], clip[ref]');
            if (aclip) {
              vref = aclip.getAttribute('ref') || '';
              vname = aclip.getAttribute('name') || '';
              reelMeta = aclip.querySelector('metadata md[key=\"com.apple.proapps.studio.reel\"]')?.getAttribute('value') || '';
            } else {
              const vid = ang.querySelector('video[ref]');
              if (vid) {
                vref = vid.getAttribute('ref') || '';
                vname = vid.getAttribute('name') || '';
                const host = vid.closest('clip') || vid.closest('asset-clip') || ang;
                reelMeta = host?.querySelector('metadata md[key=\"com.apple.proapps.studio.reel\"]')?.getAttribute('value') || '';
              } else {
                reelMeta = ang.querySelector('metadata md[key=\"com.apple.proapps.studio.reel\"]')?.getAttribute('value') || '';
              }
            }
            if (!reelMeta) {
              reelMeta = mc.querySelector(':scope > metadata md[key=\"com.apple.proapps.studio.reel\"]')?.getAttribute('value') || '';
            }
          } catch {}

          const assetObj = (vref && assets && assets[vref]) ? assets[vref] : null;
          const assetName = assetObj?.name || '';
          const assetSrcFps = assetObj?.srcFps || null;

          angles[angleID] = {
            angleID,
            clipName: vname,
            reelMeta,
            assetRef: vref,
            assetName,
            assetSrcFps,
          };
        });

        medias[id] = { id, type: 'multicam', angles };
      });
    } catch (e) {
      // Non-fatal: parser should still work without multicam resolution.
      console.warn('parseFCPXML: medias index build failed', e);
    }

    // ---- Main sequence
    const mainSeq = doc.querySelector("library project > sequence") ||
                    doc.querySelector("project > sequence") ||
                    doc.querySelector("sequence");
    if (!mainSeq) {
      const docFps = readFPS(doc);
      return { events: [], projectName, fps: nominalBase(docFps), fpsExact: docFps, sourceType: "fcpxml" };
    }

    // ---- Resolve FPS from the sequence's own format attribute.
    // readFPS(doc) falls back to the first format element, which may not be the
    // sequence format when multiple source formats precede the timeline format in
    // <resources>. Use the sequence's format ID to look up the correct value.
    const fps = (() => {
      const fmtId = mainSeq.getAttribute("format");
      if (fmtId && formats[fmtId]) return formats[fmtId];
      return readFPS(doc); // fallback: first format element
    })();

    // Sequence TC start (in frames)
    const seqStartF = readSequenceStartFrames(mainSeq, fps);
    // FCPXML exporters differ:
    // - Some write clip.offset values RELATIVE to the sequence start (usually 0)
    // - Some (notably Resolve) write clip.offset values in the SAME DOMAIN as tcStart
    //   (e.g. first clip offset == tcStart)
    // We detect which domain the first-level offsets are using.
    const seqOriginF = detectSequenceOrigin(mainSeq, fps, seqStartF);

    // ---- Collect events
    const events = [];
    const spines = mainSeq.querySelectorAll(":scope > spine");
    if (spines.length) {
      spines.forEach(sp => {
        for (const ch of sp.children) collect(ch, seqStartF, seqOriginF, fps, assets, medias, effects, doc, events, false);
      });
    } else {
      for (const ch of mainSeq.children) collect(ch, seqStartF, seqOriginF, fps, assets, medias, effects, doc, events, false);
    }


    // Sort helper — declared here so fallback paths below can use it without TDZ.
    const tcToF = (tc) => tcToFrames(tc, fps);

    // Fallback: some large FCPXML exports still fail the recursive collector even though
    // the sequence clearly contains visual editorial items. Build a minimal flat event list
    // directly from sequence nodes so timeline cuts can still be extracted.
    if (!events.length) {
      try {
        const flat = buildFlatFCPXMLEvents(mainSeq, seqStartF, seqOriginF, fps, assets, effects);
        if (flat.length) {
          flat.sort((a, b) => tcToF(a.recIn) - tcToF(b.recIn));
          let maxTI2 = 0;
          for (const e of flat) {
            const ti = Number(e.trackIndex ?? 0);
            if (Number.isFinite(ti)) maxTI2 = Math.max(maxTI2, ti);
          }
          if (flat.length) {
            try { flat[0]._seqBaseFrames = seqStartF; } catch {}
          }
          return { events: flat, projectName, fps: nominalBase(fps), fpsExact: fps, videoTrackCount: Math.max(1, maxTI2 + 1), _seqBaseFrames: seqStartF, _fallback: 'flat-sequence-scan', sourceType: "fcpxml" };
        }
      } catch (e) {
        console.warn('parseFCPXML flat fallback failed', e);
      }
      try {
        const topLevel = buildTopLevelFCPXMLEvents(mainSeq, seqStartF, seqOriginF, fps, assets, medias, effects);
        if (topLevel.length) {
          topLevel.sort((a, b) => tcToF(a.recIn) - tcToF(b.recIn));
          let maxTI3 = 0;
          for (const e of topLevel) {
            const ti = Number(e.trackIndex ?? 0);
            if (Number.isFinite(ti)) maxTI3 = Math.max(maxTI3, ti);
          }
          try { topLevel[0]._seqBaseFrames = seqStartF; } catch {}
          return { events: topLevel, projectName, fps: nominalBase(fps), fpsExact: fps, videoTrackCount: Math.max(1, maxTI3 + 1), _seqBaseFrames: seqStartF, _fallback: 'top-level-spine-scan', sourceType: "fcpxml" };
        }
      } catch (e) {
        console.warn('parseFCPXML top-level fallback failed', e);
      }
    }
    // Sort by Rec In
    events.sort((a, b) => tcToF(a.recIn) - tcToF(b.recIn));

    // ── Associate <transition> elements with their incoming clips ────────────
    // FCPXML transitions are siblings of clips inside <spine> elements.
    // Each <transition offset="..." duration="..." name="..."/> marks an edit
    // between the outgoing clip (before the transition) and the incoming clip
    // (after the transition). We attach an EDL-style token to the incoming clip
    // so the timeline renderer can draw dissolve/wipe/fade overlays.
    {
      // Only look at direct-spine transitions of the main sequence to avoid false
      // matches from transitions inside nested ref-clip sub-sequences.
      const trNodes = mainSeq.querySelectorAll(':scope > spine > transition, :scope > transition');
      trNodes.forEach(trNode => {
        const trRawF = ratToFrames(trNode.getAttribute('offset') || '0s', fps);
        const trDurF = Math.max(1, ratToFrames(trNode.getAttribute('duration') || '0s', fps));
        const trName = (trNode.getAttribute('name') || '').toLowerCase();

        // Convert raw offset to absolute sequence frame using same domain correction as clips.
        // seqOriginF is the "base" raw offset of the first clip; seqStartF is its absolute frame.
        const trAbsF = seqStartF + (trRawF - seqOriginF);

        // The incoming clip's recIn ≈ midpoint of the transition in absolute frames.
        const expectedAbsIn = trAbsF + Math.round(trDurF / 2);

        // Find the event whose recIn is closest to expectedAbsIn (within 1 transition duration).
        let bestEv = null, bestDist = Infinity;
        for (const ev of events) {
          const evAbsIn = tcToFrames(ev.recIn || '00:00:00:00', fps);
          const dist    = Math.abs(evAbsIn - expectedAbsIn);
          if (dist < bestDist && dist <= trDurF + 2) { bestDist = dist; bestEv = ev; }
        }
        if (!bestEv) return;

        // Map FCPXML transition name to EDL-style token (D = dissolve, W = wipe, FI = fade-in).
        const d = String(trDurF).padStart(3, '0');
        let token;
        if (/wipe/i.test(trName))                                token = `W${d}`;
        else if (/fade.*black|dip.*black|fade.*white/i.test(trName)) token = `FI${d}`;
        else                                                      token = `D${d}`; // Cross Dissolve + anything else

        bestEv.transition = token;
      });
    }

    // Resolve-like track packing (V1..V4): clamp to a small, stable set of tracks.
    // - V1: primary storyline (trackIndex 0)
    // - V2: connected clips / most titles (trackIndex 1)
    // - V3: adjustment/nameplate overlays (trackIndex 2)
    // - V4: higher-lane titles/credits (trackIndex 3)
    // Keep the raw value for debugging.
    for (const e of events) {
      const raw = Number(e.trackIndex ?? 0);
      try { e._trackIndexRaw = raw; } catch {}
      let ti = Number.isFinite(raw) ? Math.floor(raw) : 0;
      if (ti < 0) ti = 0;
      if (ti > 3) ti = 3;
      e.trackIndex = ti;
    }


    // Best-effort track count for UI (Shot Marker timeline uses this)
    let maxTI = 0;
    for (const e of events) {
      const ti = Number(e.trackIndex ?? 0);
      if (Number.isFinite(ti)) maxTI = Math.max(maxTI, ti);
    }
    const videoTrackCount = Math.max(1, maxTI + 1);

    // Expose sequence base (record) start timecode in frames for downstream syncing (e.g. Cut Diff video compare)
    // Also mirror onto the first event for backward-compat with older heuristics.
    if (events.length) {
      try { events[0]._seqBaseFrames = seqStartF; } catch {}
    }

    return { events, projectName, fps: nominalBase(fps), fpsExact: fps, videoTrackCount, _seqBaseFrames: seqStartF, sourceType: "fcpxml" };
  } catch (e) {
    console.warn("parseFCPXML failed", e);
    return { events: [], projectName: "—", fps: 24, fpsExact: 24, _error: String(e?.message || e), sourceType: "fcpxml" };
  }
}

/* ---------------- helpers ---------------- */

function sanitizeXML(txt) {
  let s = String(txt || "");
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  return s;
}
function pad2(n) { return String(n).padStart(2, "0"); }
function stemNoExt(path = "") {
  const s = String(path || "");
  const i = s.lastIndexOf(".");
  return i > 0 ? s.slice(0, i) : s;
}
// The timecode pair works in whole frame fields: HH:MM:SS:FF cannot hold a
// fraction, so a timecode second is 24 fields at 23.976 and 30 at 29.97 NDF.
// pad2 does not round, so a fractional field would be stringified whole.
function framesToTC(fr, fps = 24) {
  const base = nominalBase(fps);
  fr = Math.max(0, Math.round(fr || 0));
  const s = Math.floor(fr / base);
  const ff = fr % base;
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}
function tcToFrames(tc, fps = 24) {
  const m = typeof tc === "string" && tc.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const hh = +m[1], mm = +m[2], ss = +m[3], ff = +m[4];
  return Math.round(((hh * 3600) + (mm * 60) + ss) * nominalBase(fps) + ff);
}
// Rational REAL seconds → frame index. This one must use the true rate: the
// frame a value denotes is value / frameDuration. Multiplying by the rounded
// base instead put every event 86 frames (3.6s) late at the 1-hour mark of a
// 23.976 timeline, and the error grows with position down the reel.
function ratToFrames(val, fps) {
  if (!Number.isFinite(fps) || fps <= 0) fps = 24;
  if (val == null) return 0;
  let s = String(val).trim();
  if (!s) return 0;

  let isSeconds = false;
  if (s.endsWith('s')) {
    isSeconds = true;
    s = s.slice(0, -1);
  }

  if (s.includes('/')) {
    const [a, b] = s.split('/');
    const num = parseFloat(a);
    const den = parseFloat(b);
    if (!isFinite(num) || !isFinite(den) || den === 0) return 0;
    const n = (num / den);
    return Math.round(isSeconds ? (n * fps) : n);
  }

  const n = parseFloat(s);
  if (!isFinite(n)) return 0;
  return Math.round(isSeconds ? (n * fps) : n);
}
function firstChild(el, sel) { return el?.querySelector(`:scope > ${sel}`) || null; }

function readTimeMapPoints(el, fps) {
  const tm = firstChild(el, 'timeMap');
  if (!tm) return null;
  const pts = [];
  tm.querySelectorAll(':scope > timept').forEach(pt => {
    const t = ratToFrames(pt.getAttribute('time'), fps);
    const v = ratToFrames(pt.getAttribute('value'), fps);
    if (Number.isFinite(t) && Number.isFinite(v)) pts.push({ t, v });
  });
  pts.sort((a, b) => a.t - b.t);
  return pts.length >= 2 ? pts : null;
}

function mapTimeMap(pts, t) {
  if (!pts || pts.length < 2 || !Number.isFinite(t)) return Math.round(t || 0);

  const lerp = (a, b, t) => {
    const dt = (b.t - a.t);
    if (!dt) return Math.round(a.v);
    const u = (t - a.t) / dt;
    return Math.round(a.v + u * (b.v - a.v));
  };

  if (t <= pts[0].t) return lerp(pts[0], pts[1], t);
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) return lerp(pts[i - 1], pts[i], t);
  }
  return lerp(pts[pts.length - 2], pts[pts.length - 1], t);
}
function readFPS(doc) {
  let fps = 24;
  const fmt = doc.querySelector("resources > format[frameDuration]");
  if (fmt) {
    const fdRaw = (fmt.getAttribute("frameDuration") || "").trim(); // e.g. "100/2400s"
    const fd = fdRaw.endsWith("s") ? fdRaw.slice(0, -1) : fdRaw;    // "100/2400"
    const parts = fd.split("/");
    if (parts.length === 2) {
      const num = Number(parts[0]);
      const den = Number(parts[1]);
      if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) {
        fps = den / num;   // exact — see the formats map above
      }
    }
  }
  return fps;
}
function readSequenceStartFrames(sequenceEl, fps) {
  const tcStart = sequenceEl.getAttribute("tcStart");
  if (tcStart) return ratToFrames(tcStart, fps);
  const start = sequenceEl.getAttribute("start");
  if (start) return ratToFrames(start, fps);
  return 0;
}

// Detect whether a sequence's first-level clip offsets are:
//   A) relative (0-based), OR
//   B) written in the same absolute domain as tcStart (Resolve-style)
// Returns the origin offset (frames) to subtract from child offsets.
function detectSequenceOrigin(sequenceEl, fps, seqStartF) {
  if (!sequenceEl) return 0;
  if (!seqStartF) return 0;

  // Look at the minimum offset among immediate spine children
  const sp = sequenceEl.querySelector(":scope > spine");
  const kids = sp ? Array.from(sp.children) : Array.from(sequenceEl.children || []);

  let minOff = Infinity;
  for (const ch of kids) {
    if (!ch || ch.nodeType !== 1) continue;
    const offF = ratToFrames(ch.getAttribute?.("offset"), fps);
    if (Number.isFinite(offF)) minOff = Math.min(minOff, offF);
  }

  if (!Number.isFinite(minOff) || minOff === Infinity) return 0;

  // If seqStartF is non-zero and the minimum offset is at/near seqStartF,
  // treat offsets as absolute-in-timecode (origin = seqStartF).
  const pad = Math.round(fps * 2); // 2 seconds of tolerance
  if (seqStartF > 0 && minOff >= (seqStartF - pad)) return seqStartF;

  return 0;
}

// Some exporters write nested clip.offset values in the same absolute domain
// as the parent's clip.start (source timecode domain).
// Example:
//   parent start = 08:00:00:00
//   child  offset = 08:00:01:11  (instead of 00:00:01:11)
// In that case record position should be:
//   parentRecIn + (childOffset - parentStart)
function inferChildOrigin(parentNode, fps, parentStartF, parentDurF, parentOffF) {
  if (!parentNode) return 0;
  if (!Number.isFinite(parentStartF) || parentStartF <= 0) return 0;

  // FCPXML nested lanes can express child.offset in different domains:
  //  A) relative-to-parent (0-based)
  //  B) absolute source domain near parent.start
  //  C) absolute source domain near (parent.start - parent.offset)
  //     (seen in some ref-clip/media sequences)
  // We pick the best "origin" by checking which candidate is closest to the observed child offsets.
  const pad = Math.round(fps * 10); // 10 seconds tolerance

  const cand = [parentStartF];
  if (Number.isFinite(parentOffF) && parentOffF > 0) cand.push(parentStartF - parentOffF);

  const childOffs = [];
  for (const ch of parentNode.children || []) {
    if (!isMediaOrRef(ch)) continue;
    const offF = ratToFrames(ch.getAttribute?.("offset"), fps);
    if (Number.isFinite(offF)) childOffs.push(offF);
  }
  if (!childOffs.length) return 0;

  let bestOrigin = 0;
  let bestScore = Infinity;
  for (const origin of cand) {
    let score = Infinity;
    for (const offF of childOffs) score = Math.min(score, Math.abs(offF - origin));
    if (score < bestScore) { bestScore = score; bestOrigin = origin; }
  }

  if (bestOrigin && bestScore <= pad) return bestOrigin;
  return 0;
}


// Compute the time-domain for children under a <spine> container.
// In many FCPXMLs, connected storylines are represented as:
//   <gap> ... <spine lane="1" offset="..."> <title offset="0s" .../> ...
// where the LANE is on the spine, and the spine.offset may be absolute (near tcStart) OR relative.
// Child offsets inside the spine are usually 0-based relative to the spine.
// This helper decides whether child offsets should be treated as absolute or relative.
function computeSpineChildDomain(spineEl, parentBaseRecF, parentOriginF, parentRecInF, parentStartF, parentOffF, fps){
  const spOffF = ratToFrames(spineEl?.getAttribute?.('offset'), fps);

  // Find minimum child offset inside this spine
  let minChildOff = Infinity;
  try {
    for (const ch of spineEl?.children || []){
      if (!ch || ch.nodeType !== 1) continue;
      const o = ratToFrames(ch.getAttribute?.('offset'), fps);
      if (Number.isFinite(o)) minChildOff = Math.min(minChildOff, o);
    }
  } catch {}

  const pad = Math.round((fps || 24) * 10); // 10s tolerance
  const hasSpOff = Number.isFinite(spOffF) && spOffF > 0;
  const hasChildMin = Number.isFinite(minChildOff) && minChildOff !== Infinity;

  // If children offsets are already absolute in the SAME domain as the spine offset,
  // keep using an origin/base pair that matches that domain.
  const childOffsetsAbsolute = hasSpOff && hasChildMin && (minChildOff >= (spOffF - pad));
  if (childOffsetsAbsolute){
    // Pick which domain this "absolute" offset belongs to.
    const cands = [];
    if (Number.isFinite(parentOriginF) && parentOriginF > 0) cands.push({ origin: parentOriginF, base: parentBaseRecF, mode: 'timeline' });
    if (Number.isFinite(parentStartF) && parentStartF > 0) cands.push({ origin: parentStartF, base: parentRecInF, mode: 'source' });
    if (Number.isFinite(parentStartF) && parentStartF > 0 && Number.isFinite(parentOffF) && parentOffF > 0) {
      cands.push({ origin: parentStartF - parentOffF, base: parentRecInF, mode: 'source2' });
    }

    let best = null;
    let bestDiff = Infinity;
    for (const c of cands){
      const d = Math.abs(spOffF - c.origin);
      if (d < bestDiff){ bestDiff = d; best = c; }
    }

    if (best && bestDiff <= pad){
      return { baseRecF: best.base, originF: best.origin, mode: 'absolute' };
    }

    // Fallback: assume timeline domain
    return { baseRecF: parentBaseRecF, originF: parentOriginF || 0, mode: 'absolute' };
  }

  // Otherwise treat children offsets as relative to the spine.
  // The spine.offset itself might be:
  //  - relative to the parent recIn (0-based)
  //  - absolute in the parent's timeline domain (near parentOriginF)
  //  - absolute in the parent's SOURCE domain (near parentStartF)
  let spineBaseRecF = parentRecInF;
  if (hasSpOff){
    const near = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= pad);

    if (near(spOffF, parentStartF)){
      spineBaseRecF = parentRecInF + (spOffF - parentStartF);
    } else if (Number.isFinite(parentStartF) && Number.isFinite(parentOffF) && parentOffF > 0 && near(spOffF, (parentStartF - parentOffF))){
      spineBaseRecF = parentRecInF + (spOffF - (parentStartF - parentOffF));
    } else if (near(spOffF, parentOriginF)){
      spineBaseRecF = parentBaseRecF + (spOffF - parentOriginF);
    } else {
      spineBaseRecF = parentRecInF + spOffF;
    }
  }

  return { baseRecF: spineBaseRecF, originF: 0, mode: 'relative' };
}


// สำหรับเช็คชื่อที่ดูเหมือน OCF (เช่น A_0001C012_...)
const OCF_NAME_RE = /^A_\d{4}C\d{3}/i;

/** normalize ชื่อ OCF: ตัด " - v1" / " - v2" และ extension */
function normalizeOCFStem(rawName = "") {
  let s = String(rawName || "").trim();
  s = s.replace(/\s+-\s+v\d+$/i, ""); // remove " - v1"
  return stemNoExt(s);                // remove .mov / .mxf ...
}

/**
 * Recursively collect events with correct nested offsets.
 * Reel logic:
 *   - ocfSource = assetName || videoName
 *   - reel = normalizeOCFStem(ocfSource)
 *   - ถ้าไม่มี asset และ video จริง ๆ ค่อย fallback เป็น clipName (กรณีพิเศษ)
 *
 * disabled logic:
 *   - ถ้า node มี enabled="0" หรือ "false" → nodeDisabled = true
 *   - disabled = parentDisabled || nodeDisabled
 *   - ทุก event leaf จะได้ flag disabled และชื่อจะมี " [DISABLED]" ต่อท้ายถ้า disabled === true
 */
function collect(node, baseRecF, originF, fps, assets, medias, effects, doc, out, parentDisabled = false, inheritedLane = null) {
  if (!node || node.nodeType !== 1) return;

  const tag = node.tagName;

  // ---- Skip audio-only <clip> containers
  // Many Resolve/FCPXML exports include audio-only clip containers on the main spine.
  // They may contain only <audio> children (often with negative lane values) and no video media.
  // If we ingest these as video events they will stack/overlap on V1 and make the timeline unreadable.
  // Keep only clips that actually contain video-ish media.
  if (tag === 'clip') {
    try {
      const hasAudio = !!(node.querySelector(':scope > audio, :scope audio'));
      if (hasAudio) {
        const hasVideoish = !!(
          node.querySelector(':scope > video, :scope video, :scope > title, :scope title, :scope > asset-clip, :scope asset-clip, :scope > mc-clip, :scope mc-clip, :scope > sync-clip, :scope sync-clip')
        );
        if (!hasVideoish) return; // audio-only clip
      }
    } catch {
      // If :scope is unsupported for some reason, fall back to a simpler heuristic.
      try {
        const hasAudio = !!node.querySelector('audio');
        const hasVideoish = !!node.querySelector('video, title, asset-clip, mc-clip, sync-clip');
        if (hasAudio && !hasVideoish) return;
      } catch {}
    }
  }

  // ---- Enabled / Disabled state
  const enabledAttr  = node.getAttribute && node.getAttribute("enabled");
  const nodeDisabled = enabledAttr === "0" || enabledAttr === "false";
  const disabled     = parentDisabled || nodeDisabled;

  // ---- Track mapping (multi-layer timeline)
  // Base storyline clips typically have no lane -> V1 (trackIndex 0)
  // Connected clips often have lane="1", "2", ... -> V2, V3, ...
  // Some exporters may write negative lane values; clamp to 0.
  const laneAttr = node.getAttribute && node.getAttribute("lane");
  let trackIndex = 0;
  if (laneAttr != null && laneAttr !== "") {
    const n = parseInt(laneAttr, 10);
    if (Number.isFinite(n)) trackIndex = Math.max(0, n);
  } else if (inheritedLane != null) {
    const n = (typeof inheritedLane === 'number') ? inheritedLane : parseInt(inheritedLane, 10);
    if (Number.isFinite(n)) trackIndex = Math.max(0, n);
  }

  // ---- ref-clip → media/sequence
  if (tag === "ref-clip") {
    const ref = node.getAttribute("ref");
    const localOff = ratToFrames(node.getAttribute("offset"), fps);
    const refRecInF = baseRecF + (localOff - (originF || 0));
    const media = ref ? doc.querySelector(`media[id="${CSS.escape(ref)}"]`) : null;
    const seq = media ? firstChild(media, "sequence") : null;
    if (seq) {
      const seqStartF2 = readSequenceStartFrames(seq, fps);
      const seqOriginF2 = detectSequenceOrigin(seq, fps, seqStartF2);
      const spines = seq.querySelectorAll(":scope > spine");
      if (spines.length) {
        spines.forEach(sp => {
          for (const ch of sp.children) collect(ch, refRecInF, seqOriginF2, fps, assets, medias, effects, doc, out, disabled);
        });
      } else {
        for (const ch of seq.children) collect(ch, refRecInF, seqOriginF2, fps, assets, medias, effects, doc, out, disabled);
      }
    }
    return;
  }

  // ---- Timing
  let durF = ratToFrames(node.getAttribute("duration"), fps);
  const offF = ratToFrames(node.getAttribute("offset"), fps);
  const srcF = ratToFrames(node.getAttribute("start"), fps);

  // Some exports wrap real media inside <clip>/<sync-clip>/<mc-clip> and set the container duration
  // to a tiny sentinel (often 1 frame) while nested <video>/<asset-clip> carries the true duration.
  //
  // CRITICAL: Do NOT “grow” an edit decision based on nested child offsets.
  // In Resolve/FCPXML exports, nested <video> under <clip> commonly uses SOURCE-TIMECODE domain
  // (absolute, e.g. 21:26:21:05) and its duration is the *master clip length*.
  // Using that to override the edit duration explodes clips into hours, causing massive overlaps
  // and hundreds of fake V-tracks (V100).
  //
  // Resolve treats the container's duration as the actual edit decision. Therefore:
  // - Never override a non-trivial container duration.
  // - Only fall back to child extent when duration is missing or sentinel (<= 1 frame).
  const allowChildExtent = !(tag === 'sync-clip' || tag === 'mc-clip');
  const childDur = allowChildExtent ? maxChildExtent(node, fps) : 0;
  if (allowChildExtent) {
    if (!durF || durF <= 1) {
      if (childDur > 0) durF = childDur;
    }
  }

  const recInF  = baseRecF + (offF - (originF || 0));
  const recOutF = recInF + Math.max(0, durF);
  let srcInF  = srcF;
  let srcOutF = srcF + Math.max(0, durF);

  // If this clip has a <timeMap>, map the local (time-domain) src range to the true source timecode.
  // This is required for correct source timecodes in VFX pulls when retime is present.
  const tmPts = readTimeMapPoints(node, fps);
  if (tmPts) {
    const tmin = tmPts[0].t;
    const tmax = tmPts[tmPts.length - 1].t;
    const pad = fps * 10; // 10s tolerance

    const useStartAsTime = (srcF >= (tmin - pad) && srcF <= (tmax + pad));
    if (useStartAsTime) {
      srcInF  = mapTimeMap(tmPts, srcF);
      srcOutF = mapTimeMap(tmPts, srcF + Math.max(0, durF));
    } else {
      // Fallback: treat time-domain as 0..dur (some exports use relative timepts)
      srcInF  = mapTimeMap(tmPts, 0);
      srcOutF = mapTimeMap(tmPts, Math.max(0, durF));
    }
  }

  // ---- Retime summary (Speed) + Transform
  const speedInfo = tmPts ? computeSpeedFromTimeMap(tmPts) : null;
  const transformInfo = readFCPTransform(node);

  // ---- Names / Source
  const clipName  = node.getAttribute("name") || "";

  // In many real-world FCPXMLs, timeline clips are wrapped in <sync-clip>/<mc-clip>.
  // Those containers often omit `ref` at the top level; the actual media ref/name lives in a nested <video>.
  const videoEl   = firstChild(node, "video") || node.querySelector("video");
  const videoName = videoEl?.getAttribute("name") || "";
  const videoRef  = videoEl?.getAttribute("ref") || "";

  let ref = node.getAttribute("ref") || videoRef;

  // Special: multicam clip — resolve active angle -> underlying asset/video
  // Timeline mc-clip usually has ref="rX" where rX points to <media id="rX"><multicam>...
  // and contains <mc-source angleID="..." srcEnable="video"/>.
  let mcResolved = null;
  if (tag === 'mc-clip' && ref && medias && medias[ref] && medias[ref].type === 'multicam') {
    try {
      const angId = node.querySelector(':scope > mc-source[srcEnable="video"][angleID]')?.getAttribute('angleID') ||
                    node.querySelector('mc-source[srcEnable="video"][angleID]')?.getAttribute('angleID') || '';
      const angles = medias[ref]?.angles || {};
      mcResolved = (angId && angles[angId]) ? angles[angId] : (Object.values(angles)[0] || null);
    } catch {}
  }

  const assetObj  = (ref && assets && assets[ref]) ? assets[ref] : null;
  const assetName = assetObj?.name || "";
  const assetFile = assetObj?.file || "";   // real media filename (survives renames)
  const assetSrcFps = assetObj?.srcFps || null;

  // Some FCPXML exports put the real OCF reel in metadata (esp. sync-clip / multicam)
  let reelMeta = "";
  try{
    reelMeta = node.querySelector('metadata md[key="com.apple.proapps.studio.reel"]')?.getAttribute("value") || "";
  }catch{}

  // SOURCE FILE (ไว้ใช้ใน * SOURCE FILE:)
  // Prefer resolved multicam angle asset; if asset name is empty fall back to the angle's reel metadata (camera reel)
  // rather than the angle's clip name (which is a scene annotation like "101-02-04/04_B", not a file name).
  const srcForComment = mcResolved?.assetName || mcResolved?.reelMeta || mcResolved?.clipName || assetFile || videoName || assetName || reelMeta || clipName || "SOURCE";

  // OCF reel: prefer metadata reel, then resolved multicam asset, then the real
  // media filename (assetFile) BEFORE the asset's display name — so a clip
  // renamed in FCP X still resolves to its camera original.
  let ocfSource = reelMeta || mcResolved?.reelMeta || mcResolved?.assetName || mcResolved?.clipName || assetFile || assetName || videoName || "";
  let reel = ocfSource ? normalizeOCFStem(ocfSource) : ""; // ถ้ายังไม่มีเดี๋ยวค่อย fallback

  // ถ้าไม่มี asset + video + metadata จริง ๆ (เช่น title/graphic) ค่อยยอมใช้ clipName เป็น reel
  if (!reel && clipName) {
    reel = clipName;
  }

  const srcFile = srcForComment;

  // ---- Markers (clip scope)
  const markers = [];
  // Collect markers inside this clip (direct or nested), but they are still clip-scope.
  const _markerEls = new Set();
  node.querySelectorAll(':scope > marker, :scope marker, :scope > chapter-marker, :scope chapter-marker, :scope > to-do, :scope to-do, :scope > keyword-marker, :scope keyword-marker')
    .forEach(mk => _markerEls.add(mk));

  _markerEls.forEach(mk => {
    const mName  = mk.getAttribute("value") || mk.getAttribute("name") || mk.getAttribute("note") || mk.textContent || "";
    const mStart = ratToFrames(mk.getAttribute("start") || mk.getAttribute("offset"), fps);
    let rel = mStart;
    if (Number.isFinite(mStart) && mStart > (Math.max(0, durF) + fps * 2)) {
      // Some FCPXML exports markers with absolute "start" in the same domain as clip "start".
      rel = mStart - srcF;
    }
    const mTC = framesToTC(recInF + rel, fps);
    const color  = (mk.getAttribute("color") || mk.getAttribute("lane") || "GREEN");
    markers.push({ name: mName, color, tc: mTC, scope: "clip" });
  });

  // ---- Push leaf media rows
  const isLeafMedia =
    (tag === "asset-clip" || tag === "clip" || tag === "mc-clip" || tag === "sync-clip" || tag === "title" || tag === "video");
  // ---- Title / Generator placement
  // Respect real lane metadata when present.
  // Only bump to V2 when there is *no* lane info (trackIndex===0) so titles don't merge into V1.
  const isTitle = (tag === "title");
  const isGenerator = (!isTitle && tag === "video" && !!ref && !!effects && !!effects[ref]);
  if ((isTitle || isGenerator) && trackIndex === 0) trackIndex = 1;


  const looksOCF =
    OCF_NAME_RE.test(assetName) ||
    OCF_NAME_RE.test(videoName) ||
    OCF_NAME_RE.test(reel);

  if (isLeafMedia && durF > 0 && (looksOCF || ref || srcFile)) {
    const baseClipName  = clipName || srcFile || "CLIP";
    const finalClipName = disabled ? `${baseClipName} [DISABLED]` : baseClipName;

    out.push({
      sourceType: "fcpxml",
      clipName: finalClipName,
      srcFile : srcFile,
      reel    : reel || "REEL",
      srcIn   : framesToTC(srcInF, fps),
      srcOut  : framesToTC(srcOutF, fps),
      recIn   : framesToTC(recInF, fps),
      recOut  : framesToTC(recOutF, fps),
      fps: nominalBase(fps),
      // Best-effort: source clip FPS (may differ from timeline fps)
      srcFps: mcResolved?.assetSrcFps || assetSrcFps || nominalBase(fps),
      role    : "video",
      type    : tag,
      isTitle,
      isGenerator,
      subtype: isGenerator ? 'generator' : (isTitle ? 'title' : undefined),
      isOCF   : looksOCF,

      markers,
      _markers: markers,

      // --- FX metadata (best-effort)
      speed:        speedInfo?.speedPercent ?? undefined,
      speedFactor:  speedInfo?.speedPercent ?? undefined,
      speedComment: speedInfo?.summary ?? undefined,
      speedSummary: speedInfo?.summary ?? undefined,
      speedKeys:    speedInfo?.keys ?? undefined,

      transform:        transformInfo?.transform ?? undefined,
      transformComment: transformInfo?.summary ?? undefined,
      transformSummary: transformInfo?.summary ?? undefined,
      disabled,
      trackIndex
    });

  }

  // ---- Recurse containers
  const childOriginF = inferChildOrigin(node, fps, srcF, durF, offF);

  // Many real FCPXMLs place overlays (Adjustment Clips, Name Plates, graphics) as *direct* children
  // of <sync-clip>/<mc-clip> with a positive lane number (V2/V3/...). Resolve keeps these as separate
  // video tracks. We must collect them, but avoid recursing into the underlying media representation.
  const collectLaneChildren = () => {
    for (const ch of node.children || []) {
      if (!ch || ch.nodeType !== 1) continue;
      const chTag = ch.tagName;
      if (chTag === 'spine') continue; // handled separately

      // IMPORTANT:
      // Direct children of <sync-clip>/<mc-clip> can include internal media containers
      // (e.g. nested sync-clip/mc-clip) whose offsets live in a SOURCE domain far away
      // (tens of hours). If we ingest those as timeline events, they explode the visible
      // timeline range and create “mystery clips” at the far right.
      //
      // Resolve only surfaces *overlay-style* items here (titles/generators/asset-clip/clip).
      // Therefore, only collect a safe subset of tag types.
      if (!(chTag === 'video' || chTag === 'title' || chTag === 'clip' || chTag === 'asset-clip')) continue;

      const chLaneAttr = ch.getAttribute && ch.getAttribute('lane');
      if (chLaneAttr == null || chLaneAttr === '') continue;
      const ln = parseInt(chLaneAttr, 10);
      if (!Number.isFinite(ln) || ln <= 0) continue; // only lanes above the primary storyline

      // Child offsets in this pattern are usually in the parent's SOURCE domain.
      // Map to record domain by using base=parentRecIn and origin=parentStart.
      collect(ch, recInF, srcF, fps, assets, medias, effects, doc, out, disabled, null);
    }
  };

  const innerSpines = node.querySelectorAll(":scope > spine");
  if (innerSpines.length) {
    innerSpines.forEach(sp => {
      // Lane can live on the spine container (common for connected storylines inside <gap>/<compound>).
      const spLaneAttr = sp.getAttribute && sp.getAttribute("lane");
      let spLane = inheritedLane;
      if (spLaneAttr != null && spLaneAttr !== "") {
        const n = parseInt(spLaneAttr, 10);
        if (Number.isFinite(n)) spLane = Math.max(0, n);
      }

      // IMPORTANT (Resolve parity):
      // <sync-clip>/<mc-clip> often contains an *internal* <spine> (no lane) that describes
      // how the clip is built in SOURCE timecode domain (gaps + underlying media clips).
      // Resolve does NOT surface these internal spine children as timeline clips.
      // If we ingest them, their offsets (often absolute source-domain like 36085s)
      // explode the visible timeline range and create “ghost clips” far to the right.
      //
      // We only want to collect:
      //  - lane spines (e.g. lane="3") that represent connected storylines/titles, OR
      //  - explicit lane children inside the spine (rare), but never the base internal media.
      const spHasLane = (spLaneAttr != null && spLaneAttr !== "");
      if ((tag === "sync-clip" || tag === "mc-clip") && !spHasLane) {
        // Keep only explicit lane children (overlay-style) and skip the rest.
        try {
          for (const ch of sp.children) {
            if (!ch || ch.nodeType !== 1) continue;
            const chLaneAttr = ch.getAttribute && ch.getAttribute('lane');
            if (chLaneAttr == null || chLaneAttr === '') continue;
            const ln = parseInt(chLaneAttr, 10);
            if (!Number.isFinite(ln) || ln <= 0) continue;
            const chTag = ch.tagName;
            if (!(chTag === 'video' || chTag === 'title' || chTag === 'clip' || chTag === 'asset-clip')) continue;
            // Child offsets in this pattern are commonly in the parent's SOURCE domain.
            collect(ch, recInF, srcF, fps, assets, medias, effects, doc, out, disabled, null);
          }
        } catch {}
        return; // Skip internal (no-lane) spine traversal for sync/mc clips.
      }

      const dom = computeSpineChildDomain(sp, baseRecF, originF, recInF, srcF, offF, fps);

      for (const ch of sp.children) {
        // Preserve legacy heuristic: if child has its own lane, its offset may be in the parent's source domain.
        const childLane = ch.getAttribute && ch.getAttribute("lane");
        const childBase = (childLane != null && childLane !== "") ? recInF : dom.baseRecF;
        const childOrg  = (childLane != null && childLane !== "") ? srcF   : dom.originF;
        collect(ch, childBase, childOrg, fps, assets, medias, effects, doc, out, disabled, spLane);
      }
    });

    // Important: <sync-clip>/<mc-clip> can also carry direct lane children outside <spine>.
    if (tag === "sync-clip" || tag === "mc-clip") collectLaneChildren();
    return;
  }

  // sync-clip / mc-clip are timeline containers.
  // We already emitted the container itself as the timeline event.
  // Avoid recursing into underlying media (source-timing domain), but DO collect direct lane children (overlays).
  if (tag === "sync-clip" || tag === "mc-clip") {
    collectLaneChildren();
    return;
  }

  const seq = firstChild(node, "sequence");
  if (seq) {
    const seqStartF2 = readSequenceStartFrames(seq, fps);
    const seqOriginF2 = detectSequenceOrigin(seq, fps, seqStartF2);
    const sp2 = seq.querySelectorAll(":scope > spine");
    if (sp2.length) {
      sp2.forEach(sp => {
        for (const ch of sp.children) {
          const lane = ch.getAttribute && ch.getAttribute("lane");
          collect(ch, recInF, lane ? srcF : seqOriginF2, fps, assets, medias, effects, doc, out, disabled);
        }
      });
    } else {
      for (const ch of seq.children) {
      const lane = ch.getAttribute && ch.getAttribute("lane");
      collect(ch, recInF, lane ? srcF : seqOriginF2, fps, assets, medias, effects, doc, out, disabled);
    }
    }
    return;
  }

  if (tag === "gap") {
    for (const ch of node.children) if (isMediaOrRef(ch) || ch?.tagName === 'video') {
    const lane = ch.getAttribute && ch.getAttribute("lane");
    collect(ch, recInF, lane ? srcF : childOriginF, fps, assets, medias, effects, doc, out, disabled);
  }
    return;
  }
  for (const ch of node.children) if (isMediaOrRef(ch)) {
    const lane = ch.getAttribute && ch.getAttribute("lane");
    collect(ch, recInF, lane ? srcF : childOriginF, fps, assets, medias, effects, doc, out, disabled);
  }
}

// infer duration when missing by max(child offset+duration)
function maxChildExtent(node, fps) {
  const items = [];
  let minOff = Infinity;
  for (const ch of node.children || []) {
    const off = ratToFrames(ch.getAttribute?.("offset"), fps);
    const dur = ratToFrames(ch.getAttribute?.("duration"), fps);
    if (!Number.isFinite(off) || !Number.isFinite(dur)) continue;
    items.push({ off, dur });
    minOff = Math.min(minOff, off);
  }
  if (!items.length || !Number.isFinite(minOff) || minOff === Infinity) return 0;

  // Normalize offsets so both 0-based and absolute-domain offsets infer the same duration.
  let maxF = 0;
  for (const it of items) {
    maxF = Math.max(maxF, (it.off - minOff) + it.dur);
  }
  return maxF;
}
function isMediaOrRef(el) {
  if (!el) return false;
  const t = el.tagName;
  // NOTE: do NOT include nested <video> nodes here.
  // Nested <video> under <clip>/<sync-clip> is a media representation, not a timeline event.
  // Timeline generator items may appear as top-level <video> children of <spine> and will be collected there.
  return t === "asset-clip" || t === "clip" || t === "mc-clip" || t === "sync-clip" || t === "ref-clip" || t === "gap" || t === "title";
}


// ---------------- FX helpers (Speed / Transform) ----------------

function computeSpeedFromTimeMap(pts){
  if (!pts || pts.length < 2) return null;
  const segs = [];
  for (let i = 1; i < pts.length; i++){
    const a = pts[i-1];
    const b = pts[i];
    const dt = (b.t - a.t);
    const dv = (b.v - a.v);
    if (!Number.isFinite(dt) || dt <= 0) continue;
    const rate = dv / dt; // source frames per output frame
    segs.push({ t:a.t, dt, dv, rate });
  }
  if (!segs.length) return null;

  // Determine if constant speed (all segment rates within tolerance)
  const avg = segs.reduce((acc,s)=>acc + s.rate * s.dt, 0) / segs.reduce((acc,s)=>acc + s.dt, 0);
  const tol = 0.01;
  const isConst = segs.every(s => Math.abs(s.rate - avg) <= tol);
  if (isConst){
    const sp = avg * 100;
    const speedPercent = Math.round(sp * 1000) / 1000;
    return {
      speedPercent,
      keys: null,
      summary: `${speedPercent}%`
    };
  }

  // Dynamic: return simplified keys as percent per segment
  const keys = segs.map(s => ({ t:s.t, pct: Math.round(s.rate*100000)/1000 }));
  return {
    speedPercent: null,
    keys,
    summary: 'DYNAMIC'
  };
}

function readFCPTransform(node){
  if (!node || node.nodeType !== 1) return null;

  // FCPXML commonly stores transforms under <adjust-transform> (inside clip/video/title)
  const tEl = node.querySelector(':scope > adjust-transform, :scope > transform') ||
              node.querySelector('adjust-transform, transform');
  const cEl = node.querySelector(':scope > adjust-crop, :scope > crop') ||
              node.querySelector('adjust-crop, crop');
  if (!tEl && !cEl) return null;

  const parsePair = (s) => {
    if (!s) return null;
    const parts = String(s).trim().split(/[,\s]+/).filter(Boolean).map(Number);
    if (!parts.length || parts.some(x => !Number.isFinite(x))) return null;
    if (parts.length === 1) return [parts[0], parts[0]];
    return [parts[0], parts[1]];
  };

  const out = {};

  if (tEl){
    const pos = parsePair(tEl.getAttribute('position'));
    const sc  = parsePair(tEl.getAttribute('scale'));
    const anc = parsePair(tEl.getAttribute('anchor'));
    const rot = tEl.getAttribute('rotation');

    if (pos) out.position = pos;
    if (sc)  out.scale = sc;
    if (anc) out.anchor = anc;
    if (rot != null && rot !== ''){
      const n = Number(rot);
      if (Number.isFinite(n)) out.rotation = n;
    }

    // Animated keyframes: <param key="..."><keyframe time="Xs" value="..."/>
    const paramEls = tEl.querySelectorAll(':scope > param');
    const keys = {};
    for (const p of paramEls) {
      const field = p.getAttribute('key') || '';
      if (!field) continue;
      const kfEls = p.querySelectorAll('keyframe');
      if (kfEls.length < 2) continue;  // static or missing — skip
      const kfArr = [];
      for (const kf of kfEls) {
        const t = kf.getAttribute('time') || '';
        const v = kf.getAttribute('value') || '';
        const tSec = t.endsWith('s') ? parseFloat(t) : (parseFloat(t) || 0);
        kfArr.push({ time: tSec, value: v });
      }
      if (kfArr.length >= 2) keys[field] = kfArr;
    }
    if (Object.keys(keys).length) {
      out.animated = true;
      out.keys = keys;
    }
  }

  if (cEl){
    const top = cEl.getAttribute('top');
    const bottom = cEl.getAttribute('bottom');
    const left = cEl.getAttribute('left');
    const right = cEl.getAttribute('right');
    const crop = {};
    const add = (k,v) => {
      if (v == null || v === '') return;
      const n = Number(v);
      crop[k] = Number.isFinite(n) ? n : v;
    };
    add('top', top); add('bottom', bottom); add('left', left); add('right', right);
    if (Object.keys(crop).length) out.crop = crop;
  }

  const keys = Object.keys(out);
  if (!keys.length) return null;

  const parts = [];
  if (out.position) parts.push(`POS ${out.position[0]},${out.position[1]}`);
  if (out.scale) parts.push(`SCALE ${out.scale[0]},${out.scale[1]}`);
  if (out.rotation != null) parts.push(`ROT ${out.rotation}`);
  if (out.crop) parts.push('CROP');
  if (out.animated && out.keys) parts.push(`ANIM(${Object.keys(out.keys).join(',')})`);

  return { transform: out, summary: parts.join(' | ') || 'TRANSFORM' };
}



function buildTopLevelFCPXMLEvents(mainSeq, seqStartF, seqOriginF, fps, assets, medias, effects) {
  const out = [];
  const seen = new Set();
  const topSpines = [];
  for (const ch of (mainSeq?.children || [])) {
    if (ch && ch.nodeType === 1 && ch.tagName === 'spine') topSpines.push(ch);
  }
  if (!topSpines.length) return out;

  const addEvent = (node, inheritedTrack = 0) => {
    if (!node || node.nodeType !== 1) return;
    const tag = node.tagName;
    if (!['sync-clip', 'mc-clip', 'asset-clip', 'clip', 'video', 'title'].includes(tag)) return;

    // Skip internal media wrappers under sync/mc/clip containers unless they explicitly live on a lane.
    const parentTag = node.parentElement?.tagName || '';
    const laneAttr = node.getAttribute && node.getAttribute('lane');
    const hasOwnLane = laneAttr != null && laneAttr !== '';
    if ((tag === 'video' || tag === 'clip' || tag === 'asset-clip') && !hasOwnLane && (parentTag === 'clip' || parentTag === 'sync-clip' || parentTag === 'mc-clip')) {
      return;
    }

    if (tag === 'video') {
      const ref0 = node.getAttribute('ref') || '';
      if (ref0 && effects && effects[ref0]) return; // generator/effect node, not source editorial media
    }

    let trackIndex = 0;
    if (hasOwnLane) {
      const n = parseInt(laneAttr, 10);
      if (Number.isFinite(n)) trackIndex = Math.max(0, n);
    } else {
      trackIndex = Math.max(0, Number(inheritedTrack) || 0);
    }

    const offF = ratToFrames(node.getAttribute('offset'), fps);
    let durF = ratToFrames(node.getAttribute('duration'), fps);
    if (!Number.isFinite(offF) || !Number.isFinite(durF) || durF <= 0) return;

    const recInF = seqStartF + (offF - (seqOriginF || 0));
    const recOutF = recInF + durF;
    if (!Number.isFinite(recInF) || !Number.isFinite(recOutF) || recOutF <= recInF) return;

    const videoEl = (tag === 'video') ? node : (firstChild(node, 'video') || null);
    const ref = node.getAttribute('ref') || videoEl?.getAttribute('ref') || '';
    const clipName = node.getAttribute('name') || videoEl?.getAttribute('name') || '';
    const assetName = (ref && assets && assets[ref] && assets[ref].name) ? assets[ref].name : '';

    let reelMeta = '';
    try {
      for (const md of (node.children || [])) {
        if (!md || md.nodeType !== 1 || md.tagName !== 'metadata') continue;
        for (const sub of (md.children || [])) {
          if (!sub || sub.nodeType !== 1 || sub.tagName !== 'md') continue;
          if ((sub.getAttribute('key') || '') === 'com.apple.proapps.studio.reel') {
            reelMeta = sub.getAttribute('value') || '';
            break;
          }
        }
        if (reelMeta) break;
      }
    } catch {}

    let mcResolved = null;
    if (tag === 'mc-clip' && ref && medias && medias[ref] && medias[ref].type === 'multicam') {
      try {
        let angleId = '';
        for (const ch of (node.children || [])) {
          if (!ch || ch.nodeType !== 1 || ch.tagName !== 'mc-source') continue;
          if ((ch.getAttribute('srcEnable') || '') === 'video' && ch.getAttribute('angleID')) {
            angleId = ch.getAttribute('angleID') || '';
            break;
          }
        }
        const angles = medias[ref]?.angles || {};
        mcResolved = (angleId && angles[angleId]) ? angles[angleId] : (Object.values(angles)[0] || null);
      } catch {}
    }

    const srcName = mcResolved?.assetName || mcResolved?.reelMeta || mcResolved?.clipName || (ref && assets && assets[ref] && assets[ref].file) || assetName || clipName || 'CLIP';
    const reel = normalizeOCFStem(reelMeta || mcResolved?.reelMeta || srcName || clipName) || 'REEL';
    const key = `${trackIndex}|${recInF}|${recOutF}|${clipName}|${reel}`;
    if (seen.has(key)) return;
    seen.add(key);

    out.push({
      sourceType: 'fcpxml',
      clipName: clipName || srcName,
      srcFile: srcName,
      reel,
      srcIn: framesToTC(0, fps),
      srcOut: framesToTC(durF, fps),
      recIn: framesToTC(recInF, fps),
      recOut: framesToTC(recOutF, fps),
      fps: nominalBase(fps),
      srcFps: mcResolved?.assetSrcFps || ((ref && assets && assets[ref] && assets[ref].srcFps) ? assets[ref].srcFps : nominalBase(fps)),
      role: 'video',
      type: tag,
      markers: [],
      _markers: [],
      disabled: false,
      isOCF: false,
      trackIndex,
      isTitle: tag === 'title',
      isGenerator: false,
    });
  };

  const walk = (list, inheritedTrack = 0) => {
    for (const node of (list || [])) {
      if (!node || node.nodeType !== 1) continue;
      const tag = node.tagName;
      if (tag === 'spine') {
        const ln = parseInt(node.getAttribute('lane') || '', 10);
        walk(node.children, Number.isFinite(ln) ? Math.max(0, ln) : inheritedTrack);
        continue;
      }
      if (tag === 'gap') {
        // Gaps often host connected storylines/titles inside nested spines.
        for (const ch of (node.children || [])) {
          if (!ch || ch.nodeType !== 1) continue;
          if (ch.tagName === 'spine') {
            const ln = parseInt(ch.getAttribute('lane') || '', 10);
            walk(ch.children, Number.isFinite(ln) ? Math.max(0, ln) : inheritedTrack);
          } else {
            addEvent(ch, inheritedTrack);
          }
        }
        continue;
      }
      addEvent(node, inheritedTrack);
    }
  };

  for (const sp of topSpines) walk(sp.children, 0);
  return out;
}

function buildFlatFCPXMLEvents(mainSeq, seqStartF, seqOriginF, fps, assets, effects) {
  const out = [];
  const seen = new Set();
  const sels = ['asset-clip', 'mc-clip', 'sync-clip', 'clip', 'video'];
  for (const sel of sels) {
    const nodes = mainSeq.querySelectorAll(sel);
    nodes.forEach((node) => {
      try {
        if (!node || node.nodeType !== 1) return;
        const tag = node.tagName;
        if (tag === 'video') {
          const ref = node.getAttribute('ref') || '';
          if (ref && effects && effects[ref]) return; // generator/effect, not editorial media
        }
        if (tag === 'clip') {
          const hasAudio = !!node.querySelector('audio');
          const hasVideoish = !!node.querySelector('video, title, asset-clip, mc-clip, sync-clip');
          if (hasAudio && !hasVideoish) return;
        }
        const offF = ratToFrames(node.getAttribute('offset'), fps);
        const durF = ratToFrames(node.getAttribute('duration'), fps);
        if (!Number.isFinite(offF) || !Number.isFinite(durF) || durF <= 0) return;

        // lane can live on the node or its nearest ancestor spine.
        let trackIndex = 0;
        const laneSelf = node.getAttribute('lane');
        if (laneSelf != null && laneSelf !== '') {
          const n = parseInt(laneSelf, 10);
          if (Number.isFinite(n)) trackIndex = Math.max(0, n);
        } else {
          const spine = node.closest('spine[lane]');
          const lane = spine ? spine.getAttribute('lane') : '';
          const n = parseInt(lane || '', 10);
          if (Number.isFinite(n)) trackIndex = Math.max(0, n);
        }

        const recInF = seqStartF + (offF - (seqOriginF || 0));
        const recOutF = recInF + durF;
        if (!Number.isFinite(recInF) || !Number.isFinite(recOutF) || recOutF <= recInF) return;

        const ref = node.getAttribute('ref') || '';
        const assetName = (ref && assets && assets[ref] && assets[ref].name) ? assets[ref].name : '';
        const clipName = node.getAttribute('name') || assetName || tag.toUpperCase();
        const key = `${trackIndex}|${recInF}|${recOutF}|${clipName}`;
        if (seen.has(key)) return;
        seen.add(key);

        out.push({
          sourceType: 'fcpxml',
          clipName,
          srcFile: assetName || clipName,
          reel: normalizeOCFStem(assetName || clipName) || 'REEL',
          srcIn: framesToTC(0, fps),
          srcOut: framesToTC(durF, fps),
          recIn: framesToTC(recInF, fps),
          recOut: framesToTC(recOutF, fps),
          fps: nominalBase(fps),
          srcFps: (ref && assets && assets[ref] && assets[ref].srcFps) ? assets[ref].srcFps : nominalBase(fps),
          role: 'video',
          type: tag,
          markers: [],
          _markers: [],
          disabled: false,
          isOCF: false,
          trackIndex,
        });
      } catch {}
    });
  }
  return out;
}
