// modules/parser_fcpxml.js
// FCPXML parser — recursive decompose + correct nested offsets + sequence TC start
// NORMALIZES reel from Resolve/FCPX:
//   - Resolve: <asset name="A_0001C012_251026_075200_c1I89.mov">
//   - FCPX:    <video name="A_0001C012_251026_075200_c1I89.mov - v1">
//   - strip " - v1" / " - v2" and extension → reel = "A_0001C012_251026_075200_c1I89"
// ไม่ใช้ clipName เป็นแหล่งรีล ยกเว้นกรณีที่ไม่มี asset และ video จริง ๆ
//
// Returns:
// {
//   events: [{
//     clipName, srcFile, reel, srcIn, srcOut, recIn, recOut,
//     fps, role, type, markers, _markers,
//     disabled   // ✅ true ถ้ามาจาก clip ที่ enabled="0" หรืออยู่ใต้พ่อที่ถูกปิด
//   }],
//   projectName,
//   fps
// }

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
    // fps resolved after formats map + mainSeq (see "Resolve FPS" block below)

    // ---- Formats + Assets map (for src filenames + best-effort source FPS)
    const formats = {};
    doc.querySelectorAll("resources > format[id][frameDuration]").forEach(fmt => {
      const id = fmt.getAttribute("id");
      if (!id) return;
      const fdRaw = (fmt.getAttribute("frameDuration") || "").trim();
      const fd = fdRaw.endsWith("s") ? fdRaw.slice(0, -1) : fdRaw;
      const parts = fd.split("/");
      if (parts.length === 2) {
        const num = Number(parts[0]);
        const den = Number(parts[1]);
        if (Number.isFinite(num) && Number.isFinite(den) && num > 0 && den > 0) {
          const v = Math.round(den / num);
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
      const srcFps = (fmtId && formats[fmtId]) ? formats[fmtId] : null;
      assets[id] = { name, srcFps };
    });

    // ---- Main sequence
    const mainSeq = doc.querySelector("library project > sequence") ||
                    doc.querySelector("project > sequence") ||
                    doc.querySelector("sequence");
    if (!mainSeq) return { events: [], projectName, fps: readFPS(doc), sourceType: "fcpxml" };

    // ---- Resolve FPS from the sequence's own format attribute.
    const fps = (() => {
      const fmtId = mainSeq.getAttribute("format");
      if (fmtId && formats[fmtId]) return formats[fmtId];
      return readFPS(doc);
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
        for (const ch of sp.children) collect(ch, seqStartF, seqOriginF, fps, assets, doc, events, false);
      });
    } else {
      for (const ch of mainSeq.children) collect(ch, seqStartF, seqOriginF, fps, assets, doc, events, false);
    }

    // Sort by Rec In
    const tcToF = (tc) => tcToFrames(tc, fps);
    events.sort((a, b) => tcToF(a.recIn) - tcToF(b.recIn));

    return { events, projectName, fps, sourceType: "fcpxml" };
  } catch (e) {
    console.warn("parseFCPXML failed", e);
    return { events: [], projectName: "—", fps: 24, sourceType: "fcpxml", _error: String(e?.message || e) };
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
function framesToTC(fr, fps = 24) {
  fr = Math.max(0, Math.round(fr || 0));
  const s = Math.floor(fr / fps);
  const ff = fr % fps;
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}
function tcToFrames(tc, fps = 24) {
  const m = typeof tc === "string" && tc.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const hh = +m[1], mm = +m[2], ss = +m[3], ff = +m[4];
  return Math.round(((hh * 3600) + (mm * 60) + ss) * fps + ff);
}
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

  if (t <= pts[0].t) return Math.round(pts[0].v);
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
        fps = Math.round(den / num);
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
function collect(node, baseRecF, originF, fps, assets, doc, out, parentDisabled = false) {
  if (!node || node.nodeType !== 1) return;

  const tag = node.tagName;

  // ---- Enabled / Disabled state
  const enabledAttr  = node.getAttribute && node.getAttribute("enabled");
  const nodeDisabled = enabledAttr === "0" || enabledAttr === "false";
  const disabled     = parentDisabled || nodeDisabled;

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
          for (const ch of sp.children) collect(ch, refRecInF, seqOriginF2, fps, assets, doc, out, disabled);
        });
      } else {
        for (const ch of seq.children) collect(ch, refRecInF, seqOriginF2, fps, assets, doc, out, disabled);
      }
    }
    return;
  }

  // ---- Timing
  let durF = ratToFrames(node.getAttribute("duration"), fps);
  const offF = ratToFrames(node.getAttribute("offset"), fps);
  const srcF = ratToFrames(node.getAttribute("start"), fps);

  if (!durF) {
    const childDur = maxChildExtent(node, fps);
    if (childDur > 0) durF = childDur;
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
  const ref       = node.getAttribute("ref");
  const assetObj  = (ref && assets && assets[ref]) ? assets[ref] : null;
  const assetName = assetObj?.name || "";
  const assetSrcFps = assetObj?.srcFps || null;

  // inner <video> (บางครั้ง FCPX ใส่ OCF ไว้ตรงนี้)
  const videoEl   = firstChild(node, "video");
  const videoName = videoEl?.getAttribute("name") || "";

  // SOURCE FILE (ไว้ใช้ใน * SOURCE FILE:)
  const srcForComment = videoName || assetName || clipName || "SOURCE";

  // OCF reel: ใช้เฉพาะ asset / video
  let ocfSource = assetName || videoName || "";
  let reel = ocfSource ? normalizeOCFStem(ocfSource) : ""; // ถ้ายังไม่มีเดี๋ยวค่อย fallback

  // ถ้าไม่มี asset + video จริง ๆ (เช่น title/graphic) ค่อยยอมใช้ clipName เป็น reel
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
    (tag === "asset-clip" || tag === "clip" || tag === "mc-clip" || tag === "sync-clip");

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
      fps,
      // Best-effort: source clip FPS (may differ from timeline fps)
      srcFps: assetSrcFps || fps,
      role    : "video",
      type    : tag,
      trackIndex: 0,
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
      disabled
    });
  }

  // ---- Recurse containers
  const childOriginF = inferChildOrigin(node, fps, srcF, durF, offF);

  const innerSpines = node.querySelectorAll(":scope > spine");
  if (innerSpines.length) {
    innerSpines.forEach(sp => {
      for (const ch of sp.children) collect(ch, recInF, childOriginF, fps, assets, doc, out, disabled);
    });
    return;
  }

  const seq = firstChild(node, "sequence");
  if (seq) {
    const seqStartF2 = readSequenceStartFrames(seq, fps);
    const seqOriginF2 = detectSequenceOrigin(seq, fps, seqStartF2);
    const sp2 = seq.querySelectorAll(":scope > spine");
    if (sp2.length) {
      sp2.forEach(sp => {
        for (const ch of sp.children) collect(ch, recInF, seqOriginF2, fps, assets, doc, out, disabled);
      });
    } else {
      for (const ch of seq.children) collect(ch, recInF, seqOriginF2, fps, assets, doc, out, disabled);
    }
    return;
  }

  if (tag === "gap") {
    for (const ch of node.children) if (isMediaOrRef(ch)) collect(ch, recInF, childOriginF, fps, assets, doc, out, disabled);
    return;
  }
  for (const ch of node.children) if (isMediaOrRef(ch)) collect(ch, recInF, childOriginF, fps, assets, doc, out, disabled);
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
  return t === "asset-clip" || t === "clip" || t === "mc-clip" || t === "sync-clip" || t === "ref-clip" || t === "gap";
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

  return { transform: out, summary: parts.join(' | ') || 'TRANSFORM' };
}
