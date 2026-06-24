// modules/edl_export.js
// CMX3600 EDL exporter — Reel/Tape = filename stem (no extension, NOT truncated)
// Always emit "* SOURCE FILE: <filename.ext>" in comments.
// Supports auto-split @1500 events (renumber per part), VFX modes, and metadata comments.
// Filename rule: _VFX_PULL when in any VFX mode, otherwise _CF_PULL.
//
// Patch (REC TC fix):
// - If upstream recIn/recOut are broken (often 1-frame duration), auto-rebuild REC timeline
//   from 00:00:00:00 using src duration.
// - Option: opts.recStartAtZero (default true) to always start REC at 00:00:00:00.

function pad3(n) { return String(n).padStart(3, "0"); }
function pad2(n) { return String(n).padStart(2, "0"); }

function stemNoExt(path = "") {
  const s = String(path || "");
  const i = s.lastIndexOf(".");
  return i > 0 ? s.slice(0, i) : s;
}

// Strip [DISABLED] tag from any string (case-insensitive, with optional leading space)
function stripDisabledTag(str) {
  if (!str) return "";
  return String(str).replace(/\s*\[DISABLED\]/ig, "").trim();
}

// Strip FCPX version suffix like " - v1", " - v2" at the very end of the string
function stripFCPXVersionSuffix(str) {
  if (!str) return "";
  return String(str).replace(/\s+-\s+v\d+$/i, "").trim();
}

// Marker name cleanup (VFX Marker mode)
// - Hide generic marker names: "Marker", "Marker 1"...
// - Hide shot-like marker names: 117A-3-01a, 117+117A-4-02a_OK, V117+117A-5-01a ...
function isGenericMarkerName(name){
  const s = String(name || "").trim();
  if (!s) return true;
  return /^marker\s*\d*$/i.test(s);
}

// Netflix VFX naming guard (Shot / Version / Plate)
function isValidNetflixVfxMarkerName(name){
  const s = String(name || "").trim();
  if (!s) return false;
  if (/[\s]/.test(s)) return false;
  if (!/^[A-Za-z0-9._-]+$/.test(s)) return false;
  if (!s.includes("_")) return false;

  const SHOW = "[A-Za-z][A-Za-z0-9]{1,5}";
  const EP   = "\\d{3}";
  const SEQ  = "[A-Za-z0-9]{2,3}";
  const SCN  = "\\d{3}";
  const SHOT = "\\d{3,4}";

  const SHOT_BASE = `(?:` +
    `${SHOW}_${EP}_${SCN}_${SHOT}|` +
    `${SHOW}_${EP}_${SEQ}_${SHOT}|` +
    `${SHOW}_${EP}_${SEQ}_${SCN}_${SHOT}|` +
    `${SHOW}_${SCN}_${SHOT}|` +
    `${SHOW}_${SEQ}_${SHOT}|` +
    `${SHOW}_${SEQ}_${SCN}_${SHOT}` +
  `)`;

  const reShotBase  = new RegExp(`^${SHOT_BASE}$`);
  const reVersion   = new RegExp(`^${SHOT_BASE}_[A-Za-z0-9]+_[A-Za-z0-9]{2,6}_v\\d{3,4}$`, "i");
  const PLATE_ONE   = "(?:PL\\d{2}|[A-Za-z]{2,}\\d{2,3})";
  const rePlateA    = new RegExp(`^${SHOT_BASE}_${PLATE_ONE}(?:_v\\d{3,4})?$`, "i");
  const rePlateB    = new RegExp(`^${SHOT_BASE}_[A-Za-z]{2,}_\\d{2,3}(?:_v\\d{3,4})?$`, "i");
  const rePlateAFile = new RegExp(`^${SHOT_BASE}_${PLATE_ONE}_v\\d{3,4}(?:\\.\\d{4})?(?:\\.[A-Za-z0-9]+)?$`, "i");
  const rePlateBFile = new RegExp(`^${SHOT_BASE}_[A-Za-z]{2,}_\\d{2,3}_v\\d{3,4}(?:\\.\\d{4})?(?:\\.[A-Za-z0-9]+)?$`, "i");

  return (
    reShotBase.test(s) ||
    reVersion.test(s) ||
    rePlateA.test(s) || rePlateB.test(s) ||
    rePlateAFile.test(s) || rePlateBFile.test(s)
  );
}

function isShotLikeMarkerName(name){
  const s = String(name || "").trim();
  if (!s) return false;
  if (/[^\S\r\n]/.test(s)) return false;
  if (!/\d/.test(s)) return false;
  if (!/[-+]/.test(s)) return false;
  if (!/^[A-Za-z0-9+_-]+$/.test(s)) return false;
  return /^[Vv]?\d+[A-Za-z]?(?:\+\d+[A-Za-z]?)*(?:-[A-Za-z0-9]+){2,}(?:_[A-Za-z0-9]+)*$/.test(s);
}

function markerDisplayName(ev){
  const m = ev?._marker || {};
  const raw = String(m.name || "").trim();
  const clip = String(ev?.clipName || ev?.reel || "").trim();

  if (!raw || isGenericMarkerName(raw)) return clip || "MARKER";
  if (clip && raw.toLowerCase() === clip.toLowerCase()) return clip || "MARKER";
  if (isValidNetflixVfxMarkerName(raw)) return raw;
  if (isShotLikeMarkerName(raw)) return clip || "MARKER";
  return clip || "MARKER";
}

function tcToFrames(tc, fps = 24) {
  const m = typeof tc === "string" && tc.match(/^(\d{2}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const ss = parseInt(m[3], 10);
  const ff = parseInt(m[4], 10);
  return (((hh * 60 + mm) * 60) + ss) * fps + ff;
}

function framesToTC(frames, fps = 24) {
  frames = Math.max(0, Math.round(frames || 0));
  const ff = frames % fps;
  const totalSeconds = (frames - ff) / fps;
  const ss = totalSeconds % 60;
  const totalMinutes = (totalSeconds - ss) / 60;
  const mm = totalMinutes % 60;
  const hh = (totalMinutes - mm) / 60;
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}:${pad2(ff)}`;
}

function safeTC(tc, fps = 24) {
  if (!tc) return "00:00:00:00";
  if (typeof tc === "string" && tc.match(/^\d{2}:\d{2}:\d{2}:\d{2}$/)) return tc;
  const n = Number(tc);
  if (!Number.isFinite(n)) return "00:00:00:00";
  return framesToTC(n, fps);
}

function eventDurationFramesFromTC(inTC, outTC, fps = 24) {
  const a = tcToFrames(inTC, fps);
  const b = tcToFrames(outTC, fps);
  return Math.max(0, b - a);
}

// Convert an event's recIn/recOut into a duration in frames
function eventDurationFrames(ev, fps = 24) {
  return eventDurationFramesFromTC(ev.recIn, ev.recOut, fps);
}

// Normalize reel: prefer ev.reel, otherwise derive from srcFile/clipName.
// Full stem — NO length truncation (CMX3600 editors accept long reel names).
function normReel(ev) {
  if (ev && ev.reel && ev.reel.trim()) {
    const cleanReel = stemNoExt(stripFCPXVersionSuffix(stripDisabledTag(ev.reel)));
    return cleanReel || "REEL";
  }

  const raw =
    (ev && ev.srcFile && ev.srcFile.trim()) ? ev.srcFile :
    (ev && ev.clipName && ev.clipName.trim()) ? ev.clipName :
    (ev && ev.reel) ? ev.reel :
    "REEL";

  const cleaned = stripFCPXVersionSuffix(stripDisabledTag(raw));
  const stem = stemNoExt(cleaned);
  return stem || "REEL";
}

function eventLine(i, ev) {
  const reel   = normReel(ev);
  const trk    = "V";
  const ed     = "C";
  const fps    = ev.fps || 24;

  const srcIn  = safeTC(ev.srcIn, fps);
  const srcOut = safeTC(ev.srcOut, fps);

  // Use repaired REC if present
  const recIn  = safeTC(ev._recInFixed ?? ev.recIn, fps);
  const recOut = safeTC(ev._recOutFixed ?? ev.recOut, fps);

  return `${pad3(i)}  ${reel}  ${trk}     ${ed}   ${srcIn} ${srcOut} ${recIn} ${recOut}`;
}

// ---------------- FX comment formatting (Speed / Dynamic Retime) -------------

function extractSpeedPercent(ev) {
  if (!ev) return null;
  const normalizePct = (value) => {
    if (value == null || value === "") return null;
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    const abs = Math.abs(n);
    if (abs > 0 && abs <= 10) return n * 100;
    return n;
  };

  const nums = [
    normalizePct(ev.speed),
    normalizePct(ev.speedFactor),
    normalizePct(ev?.fx?.speed?.percent)
  ].filter(Number.isFinite);

  const txt = String(ev?.speedComment || ev?.speedSummary || ev?.fx?.speed?.summary || "");
  let textPct = null;
  let m = txt.match(/(\d+(?:\.\d+)?)\s*%/);
  if (m) textPct = parseFloat(m[1]);
  if (textPct == null) {
    m = txt.match(/speed[_\s-]*(\d+(?:\.\d+)?)/i);
    if (m) textPct = parseFloat(m[1]);
  }

  const numericNonDefault = nums.find(n => Math.abs(n) > 0.0001 && Math.abs(n - 100) > 0.0001);
  const numericNonZero = nums.find(n => Math.abs(n) > 0.0001);
  const numericAny = nums.length ? nums[0] : null;

  if (textPct != null && Math.abs(textPct - 100) > 0.0001) {
    if (numericNonDefault == null) return textPct;
  }

  return numericNonDefault ?? textPct ?? numericNonZero ?? numericAny ?? null;
}

function extractSpeedKeys(ev) {
  if (!ev) return null;
  const keys = (Array.isArray(ev.speedKeys) && ev.speedKeys.length)
    ? ev.speedKeys
    : (Array.isArray(ev?.fx?.speed?.keys) && ev.fx.speed.keys.length)
      ? ev.fx.speed.keys
      : null;
  return keys && keys.length ? keys : null;
}

function isTcString(s) {
  return typeof s === "string" && /^\d{2}:\d{2}:\d{2}:\d{2}$/.test(s.trim());
}

function parseRelFramesFromWhen(when, fps) {
  if (when == null) return null;
  const s = String(when).trim();
  if (!s) return null;
  if (isTcString(s)) return tcToFrames(s, fps);
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n < 120 && !Number.isInteger(n)) {
    return Math.round(n * fps);
  }
  return Math.round(n);
}

function clamp(n, a, b) { return Math.min(b, Math.max(a, n)); }

function buildDynamicRetimeSegments(ev, fps) {
  const keys = extractSpeedKeys(ev);
  if (!keys) return null;

  const durF = eventDurationFramesFromTC(
    safeTC(ev._recInFixed ?? ev.recIn, fps),
    safeTC(ev._recOutFixed ?? ev.recOut, fps),
    fps
  );
  if (!durF) return null;

  const recInF = tcToFrames(safeTC(ev._recInFixed ?? ev.recIn, fps), fps);
  const srcInF = tcToFrames(safeTC(ev.srcIn, fps), fps);

  const looksFcp = keys.every(k => k && Number.isFinite(k.t) && Number.isFinite(k.pct));
  if (looksFcp) {
    const sorted = keys
      .map(k => ({ t: Number(k.t), pct: Number(k.pct) }))
      .filter(k => Number.isFinite(k.t) && Number.isFinite(k.pct))
      .sort((a, b) => a.t - b.t);
    if (!sorted.length) return null;

    const t0 = sorted[0].t;
    const pts = sorted
      .map(k => ({ relF: Math.round(k.t - t0), pct: k.pct }))
      .filter(k => Number.isFinite(k.relF) && Number.isFinite(k.pct))
      .map(k => ({ relF: clamp(k.relF, 0, durF), pct: k.pct }))
      .sort((a, b) => a.relF - b.relF);
    if (!pts.length) return null;

    const dedup = [];
    for (const p of pts) {
      const last = dedup[dedup.length - 1];
      if (last && last.relF === p.relF) last.pct = p.pct;
      else dedup.push({ ...p });
    }

    const segments = [];
    let srcCursor = 0;
    for (let i = 0; i < dedup.length; i++) {
      const a = dedup[i];
      const b = (i + 1 < dedup.length) ? dedup[i + 1] : { relF: durF, pct: a.pct };
      const outStart = a.relF;
      const outEnd = Math.max(outStart, b.relF);
      const outLen = outEnd - outStart;
      if (outLen <= 0) continue;

      const pct = Number(a.pct);
      const srcStart = srcInF + Math.round(srcCursor);
      const srcLen = outLen * (pct / 100);
      const srcEnd = srcInF + Math.round(srcCursor + srcLen);

      segments.push({
        outStart,
        outEnd,
        recStartTC: framesToTC(recInF + outStart, fps),
        recEndTC:   framesToTC(recInF + outEnd, fps),
        srcStartTC: framesToTC(srcStart, fps),
        srcEndTC:   framesToTC(srcEnd, fps),
        pct
      });

      srcCursor += srcLen;
    }

    const keyframes = dedup.map(p => {
      let srcDelta = 0;
      for (const seg of segments) {
        if (p.relF <= seg.outStart) break;
        const segLen = seg.outEnd - seg.outStart;
        const take = Math.min(segLen, Math.max(0, p.relF - seg.outStart));
        srcDelta += take * (seg.pct / 100);
      }
      const srcAt = srcInF + Math.round(srcDelta);
      return {
        recTC: framesToTC(recInF + p.relF, fps),
        srcTC: framesToTC(srcAt, fps),
        pct: p.pct
      };
    });

    const avgPct = segments.length
      ? (segments.reduce((acc, s) => acc + (s.pct * (s.outEnd - s.outStart)), 0) / durF)
      : null;

    return { kind: "timemap", segments, keyframes, avgPct };
  }

  const pts = [];
  for (const k of keys) {
    if (!k || typeof k !== "object") continue;
    const when = k.when ?? k.time ?? k.t ?? k.at ?? k.frame ?? null;
    const value = k.value ?? k.val ?? k.pct ?? k.speed ?? null;
    const pct = Number(value);
    if (!Number.isFinite(pct)) continue;

    const relF = parseRelFramesFromWhen(when, fps);
    if (relF == null) continue;
    pts.push({ relF: clamp(relF, 0, durF), pct });
  }

  if (!pts.length) {
    return { kind: "keys", segments: null, keyframes: null, raw: keys };
  }

  pts.sort((a, b) => a.relF - b.relF);
  const dedup = [];
  for (const p of pts) {
    const last = dedup[dedup.length - 1];
    if (last && last.relF === p.relF) last.pct = p.pct;
    else dedup.push({ ...p });
  }

  const segments = [];
  let srcCursor = 0;
  for (let i = 0; i < dedup.length; i++) {
    const a = dedup[i];
    const b = (i + 1 < dedup.length) ? dedup[i + 1] : { relF: durF, pct: a.pct };
    const outStart = a.relF;
    const outEnd = Math.max(outStart, b.relF);
    const outLen = outEnd - outStart;
    if (outLen <= 0) continue;

    const pct = Number(a.pct);
    const srcStart = srcInF + Math.round(srcCursor);
    const srcLen = outLen * (pct / 100);
    const srcEnd = srcInF + Math.round(srcCursor + srcLen);
    segments.push({
      outStart,
      outEnd,
      recStartTC: framesToTC(recInF + outStart, fps),
      recEndTC:   framesToTC(recInF + outEnd, fps),
      srcStartTC: framesToTC(srcStart, fps),
      srcEndTC:   framesToTC(srcEnd, fps),
      pct
    });
    srcCursor += srcLen;
  }

  const keyframes = dedup.map(p => {
    let srcDelta = 0;
    for (const seg of segments) {
      if (p.relF <= seg.outStart) break;
      const segLen = seg.outEnd - seg.outStart;
      const take = Math.min(segLen, Math.max(0, p.relF - seg.outStart));
      srcDelta += take * (seg.pct / 100);
    }
    const srcAt = srcInF + Math.round(srcDelta);
    return { recTC: framesToTC(recInF + p.relF, fps), srcTC: framesToTC(srcAt, fps), pct: p.pct };
  });

  const avgPct = segments.length
    ? (segments.reduce((acc, s) => acc + (s.pct * (s.outEnd - s.outStart)), 0) / durF)
    : null;

  return { kind: "keys", segments, keyframes, avgPct, raw: keys };
}

function pushDynamicSpeedComments(out, ev, fps) {
  const info = buildDynamicRetimeSegments(ev, fps);
  if (!info) return false;

  const segs = info.segments;
  const kfs  = info.keyframes;
  const avg  = (info.avgPct != null && Number.isFinite(info.avgPct)) ? info.avgPct : null;

  const SEP = `* ${"─".repeat(54)}`;
  out.push(SEP);

  if (!segs || !segs.length) {
    out.push(`* ◈  SPEED RAMP  [VARIABLE — raw keys only]`);
    out.push(`* SPEED KEYS: ${JSON.stringify(info.raw ?? extractSpeedKeys(ev))}`);
    out.push(SEP);
    return true;
  }

  // Speed range summary
  const allPcts  = segs.map(s => s.pct);
  const minPct   = Math.min(...allPcts);
  const maxPct   = Math.max(...allPcts);
  const avgStr   = avg != null ? ` avg=${Number(avg).toFixed(1)}%` : "";
  const rangeStr = Math.abs(minPct - maxPct) < 0.1
    ? `${minPct.toFixed(1)}%`
    : `${minPct.toFixed(1)}–${maxPct.toFixed(1)}%`;
  const effFpsMin = (fps * minPct / 100).toFixed(2);
  const effFpsMax = (fps * maxPct / 100).toFixed(2);
  const effFpsStr = Math.abs(minPct - maxPct) < 0.1
    ? `eff_fps=${effFpsMin}`
    : `eff_fps=${effFpsMin}–${effFpsMax}`;

  out.push(`* ◈  SPEED RAMP  [VARIABLE  ${rangeStr}${avgStr}]  ${segs.length} seg · ${kfs?.length ?? 0} KF  ${effFpsStr}`);
  out.push(SEP);

  // Compact accuracy summary line: first and last KF TC mapping
  if (kfs && kfs.length >= 2) {
    const first = kfs[0], last = kfs[kfs.length - 1];
    out.push(`*   RANGE: R ${first.recTC}→${last.recTC}  S ${first.srcTC}→${last.srcTC}`);
    out.push(`*`);
  }

  const MAX_SEG = 30;
  const MAX_KF  = 40;
  const segShow = segs.length > MAX_SEG
    ? [...segs.slice(0, Math.floor(MAX_SEG / 2)), ...segs.slice(-Math.ceil(MAX_SEG / 2))]
    : segs;

  out.push(`*   SEGMENTS  (Rec In → Out  |  Src In → Out  |  Speed%)`);;
  for (const s of segShow) {
    const pct    = Number(s.pct);
    const bar    = Math.round(pct / 10);
    const fill   = '█'.repeat(Math.min(20, Math.max(0, bar)));
    const effFps = (fps * pct / 100).toFixed(2);
    out.push(`*   ${s.recStartTC}→${s.recEndTC}  ${s.srcStartTC}→${s.srcEndTC}  ${pct.toFixed(1).padStart(7)}%  fps=${effFps}  ${fill}`);
  }
  if (segs.length > segShow.length) out.push(`*   … (+${segs.length - segShow.length} more segments)`);

  if (kfs && kfs.length) {
    out.push(`*`);
    out.push(`*   KEYFRAME ACCURACY  (Rec TC  ↔  Src TC  |  Speed%)`);
    const kfShow = kfs.length > MAX_KF
      ? [...kfs.slice(0, Math.floor(MAX_KF / 2)), ...kfs.slice(-Math.ceil(MAX_KF / 2))]
      : kfs;
    for (const k of kfShow) {
      // Accuracy indicator: how many frames into source at this KF
      out.push(`*   ◆ R ${k.recTC}  ↔  S ${k.srcTC}  ${Number(k.pct).toFixed(1).padStart(7)}%`);
    }
    if (kfs.length > kfShow.length) out.push(`*   … (+${kfs.length - kfShow.length} more keyframes)`);
  }

  out.push(SEP);
  return true;
}

function commentLines(ev, opts) {
  const out = [];
  const wantMeta = !!(opts && opts.metadata);
  const forceFx  = !!(opts && opts.forceFx);
  const wantFx   = wantMeta || forceFx;

  const srcRaw = (ev && ev.srcFile && ev.srcFile.trim())
    ? ev.srcFile
    : (ev && ev.clipName && ev.clipName.trim())
      ? ev.clipName
      : (ev && ev.reel) ? ev.reel : "";

  const _edlStr = (s) => String(s || '').replace(/[\r\n\t]/g, ' ').replace(/[^\x20-\x7E]/g, '').trim();
  const cleanSrc = _edlStr(stripFCPXVersionSuffix(stripDisabledTag(srcRaw)));
  if (cleanSrc) out.push(`* SOURCE FILE: ${cleanSrc}`);

  if (ev.clipName) {
    const cleanClip = _edlStr(stripDisabledTag(ev.clipName));
    if (cleanClip) out.push(`* FROM CLIP NAME: ${cleanClip}`);
  }

  if (wantFx) {
    const fps  = ev?.fps || 24;
    const keys = extractSpeedKeys(ev);
    if (keys && keys.length) {
      // Dynamic / variable speed — full keyframe breakdown
      pushDynamicSpeedComments(out, ev, fps);
    } else {
      const sp = extractSpeedPercent(ev);
      // Only emit a speed section when speed is actually non-default
      if (sp != null && Math.abs(sp - 100) > 0.01) {
        const SEP   = `* ${"─".repeat(54)}`;
        const isRev = sp < 0;
        const absP  = Math.abs(sp);
        const effFps = (fps * absP / 100).toFixed(3);
        const tag   = isRev
          ? `REVERSE ${absP.toFixed(1)}%`
          : absP < 100
            ? `SLOW  ${absP.toFixed(1)}%`
            : `FAST  ${absP.toFixed(1)}%`;

        // Compute effective source range at this speed
        const srcIn  = safeTC(ev.srcIn, fps);
        const srcOut = safeTC(ev.srcOut, fps);
        const srcDur = eventDurationFramesFromTC(srcIn, srcOut, fps);
        const srcFpsNote = `eff_fps=${effFps}  src_dur=${srcDur}f`;

        out.push(SEP);
        out.push(`* ◈  SPEED  [${tag}]  ${srcFpsNote}`);
        if (isRev) out.push(`* NOTE: Source plays BACKWARD — Src In/Out are end/start of source material`);
        // Compact keyframe accuracy note (SRC TC at start & end of the pulled range)
        out.push(`*   SRC RANGE: ${srcIn} → ${srcOut}`);
        out.push(`*   REC RANGE: ${safeTC(ev._recInFixed ?? ev.recIn, fps)} → ${safeTC(ev._recOutFixed ?? ev.recOut, fps)}`);
        out.push(SEP);
      }
    }
  }

  if (wantFx) {
    const tr       = ev?.transform ?? ev?.fx?.transform ?? null;
    const isResize = !!(ev._pmResizeAuto || ev._pmResize === true);
    const isStab   = !!ev._pmStabilize;
    const hasCrop  = !!(ev.crop || ev.flip || ev.rotate);
    const hasTr    = (tr && typeof tr === "object");
    const hasAny   = hasTr || isResize || isStab || hasCrop;

    if (hasAny || forceFx) {
      const SEP = `* ${"─".repeat(54)}`;
      out.push(SEP);

      const tags = [];
      if (isResize) tags.push('RESIZE');
      if (isStab)   tags.push('STABILIZE');
      if (hasCrop)  tags.push('CROP/FLIP/ROTATE');
      if (!hasAny)  tags.push('NONE');

      const xformLabel = ev._pmTransformDisplay
        ? ` — ${ev._pmTransformDisplay}` : '';
      out.push(`* ◈  TRANSFORM  [${tags.join(' + ')}${xformLabel}]`);
      out.push(SEP);

      if (hasTr) {
        const xformKeys = Object.keys(tr).filter(k => !['summary','raw','comment','notes','keys','keyframes'].includes(k));
        for (const k of xformKeys) {
          const v = tr[k];
          if (v != null && v !== '' && v !== false) {
            out.push(`*   ${k.toUpperCase()}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
          }
        }
        if (tr.summary) out.push(`*   SUMMARY: ${tr.summary}`);

        // Animation keyframes on transform (position/scale/rotation over time)
        const animKeys = tr.keys ?? tr.keyframes ?? null;
        if (Array.isArray(animKeys) && animKeys.length > 0) {
          const fps = ev?.fps || 24;
          const recInF = tcToFrames(safeTC(ev._recInFixed ?? ev.recIn, fps), fps);
          out.push(`*`);
          out.push(`*   ANIMATION KEYFRAMES  (${animKeys.length} total)  — Rec TC  |  params`);
          const MAX_ANK = 30;
          const ankShow = animKeys.length > MAX_ANK
            ? [...animKeys.slice(0, Math.floor(MAX_ANK / 2)), ...animKeys.slice(-Math.ceil(MAX_ANK / 2))]
            : animKeys;
          for (const ak of ankShow) {
            const relF  = Number(ak.frame ?? ak.t ?? ak.relF ?? 0);
            const recTc = framesToTC(recInF + Math.round(relF), fps);
            const params = Object.entries(ak)
              .filter(([k]) => !['frame','t','relF'].includes(k))
              .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
              .join(' ');
            out.push(`*   ◆ R ${recTc}  ${params}`);
          }
          if (animKeys.length > ankShow.length) out.push(`*   … (+${animKeys.length - ankShow.length} more keyframes)`);
        }
      }

      if (hasCrop) {
        if (ev.crop)   out.push(`*   CROP:   ${JSON.stringify(ev.crop)}`);
        if (ev.flip)   out.push(`*   FLIP:   ${ev.flip}`);
        if (ev.rotate) out.push(`*   ROTATE: ${ev.rotate}`);
      }

      out.push(SEP);
    }
  }

  if (wantMeta && ev._extraHandles) {
    const h = Number(ev._extraHandles.head) || 0;
    const t = Number(ev._extraHandles.tail) || 0;
    const s = (typeof ev.speed === "number" && isFinite(ev.speed)) ? ev.speed : undefined;
    out.push(`* EXTRA: +${h}f / +${t}f${s ? ` for speed ${s}%` : ""}`);
  }

  if (wantMeta) {
    const scene = String(ev._scene ?? ev.scene ?? "").trim();
    const take  = String(ev._take  ?? ev.take  ?? "").trim();
    if (scene) out.push(`* SCENE: ${scene}`);
    if (take)  out.push(`* TAKE: ${take}`);
  }

  return out;
}

// Locator line
function locatorLine(ev, mode) {
  if (ev && ev._locatorOverride) {
    return ev._locatorOverride;
  }

  // Use repaired recIn for locator timing when present
  const fps = ev?.fps || 24;
  const recInForLoc = safeTC(ev?._recInFixed ?? ev?.recIn ?? ev?.srcIn, fps);

  if (mode === "rename") {
    const rawName   = ev.clipName || "CLIP";
    const cleanName = stripDisabledTag(rawName);
    const clipStem  = stemNoExt(cleanName) || "CLIP";
    return `LOC: ${recInForLoc} RED ${clipStem}`;
  }

  if (mode === "marker" && ev && ev._marker) {
    const m      = ev._marker;
    const baseNm = markerDisplayName(ev);
    const nm     = stripDisabledTag(baseNm).trim() || "CLIP";
    const colRaw = String(m?.color || "").trim();
    const col    = colRaw
      ? colRaw.toUpperCase().replace(/\s+/g, "")
      : "GREEN";
    // Always use the rebuilt/repaired record TC so the LOC position sits
    // inside the pull-EDL timeline (00:00:xx:xx space).
    // m.tc is the *original* sequence TC — using it would place the LOC
    // outside the rebuilt record range entirely.
    return `LOC: ${recInForLoc} ${col} ${nm}`;
  }

  return null;
}

function buildHeader(projectName, fps, partInfo = "") {
  const lines = [];
  lines.push(`TITLE: ${projectName}${partInfo ? " " + partInfo : ""}`);
  lines.push("FCM: NON-DROP FRAME");
  // NOTE: User requested no "COMMENT: REEL_NAME_EXTENDED=1" in output.
  lines.push("");
  return lines.join("\n");
}

function chunkByEvents(arr, size) {
  if (!Array.isArray(arr) || !arr.length) return [[]];
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

// Detect & repair broken recIn/recOut by rebuilding REC timeline from 00:00:00:00
function shouldRepairRec(events, fps) {
  const N = Math.min(50, events.length);
  if (!N) return false;

  let bad = 0;
  let checked = 0;
  for (let i = 0; i < N; i++) {
    const ev = events[i];
    if (!ev) continue;

    const srcIn  = safeTC(ev.srcIn, fps);
    const srcOut = safeTC(ev.srcOut, fps);
    const recIn  = safeTC(ev.recIn, fps);
    const recOut = safeTC(ev.recOut, fps);

    const srcDur = eventDurationFramesFromTC(srcIn, srcOut, fps);
    const recDur = eventDurationFramesFromTC(recIn, recOut, fps);

    // Only judge if srcDur is meaningful
    if (srcDur >= 2) {
      checked++;
      if (recDur <= 1) bad++;
    }
  }

  if (!checked) return false;
  // If majority looks broken, repair
  return (bad / checked) >= 0.5;
}

function rebuildRecFromZero(events, fps) {
  let cursor = 0;
  for (const ev of events) {
    const srcIn  = safeTC(ev.srcIn, fps);
    const srcOut = safeTC(ev.srcOut, fps);
    let dur = eventDurationFramesFromTC(srcIn, srcOut, fps);

    // Fallbacks
    if (dur <= 0) {
      const rIn  = safeTC(ev.recIn, fps);
      const rOut = safeTC(ev.recOut, fps);
      dur = eventDurationFramesFromTC(rIn, rOut, fps);
    }
    if (dur <= 0 && Number.isFinite(ev.durFrames)) dur = Math.max(1, Math.round(ev.durFrames));
    if (dur <= 0) dur = 1;

    ev._recInFixed  = framesToTC(cursor, fps);
    ev._recOutFixed = framesToTC(cursor + dur, fps);
    cursor += dur;
  }
}

/**
 * Build a single EDL part text from a slice of events.
 */
function buildPartEDL(eventsSlice, opts, partIndex, totalParts) {
  const { projectName = "PROJECT", metadata = true, vfxMarker = false, vfxRename = false } = opts;
  const fps = Number(eventsSlice && eventsSlice[0] && eventsSlice[0].fps) || Number(opts && opts.fps) || 24;

  const partTag = totalParts > 1 ? `(Part ${partIndex + 1} of ${totalParts})` : "";
  const lines = [];

  // Header
  lines.push(buildHeader(projectName, fps, partTag));

  // Body
  let idx = 1;
  const locMode = vfxRename ? "rename" : (vfxMarker ? "marker" : null);

  for (const ev of eventsSlice) {
    lines.push(eventLine(idx, ev));
    const loc = locatorLine(ev, locMode);
    if (loc) lines.push(loc);

    commentLines(ev, { metadata, forceFx: (vfxMarker || vfxRename) }).forEach(c => {
      lines.push(c);
    });

    lines.push("");
    idx++;
  }

  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

/**
 * Public API used by UI — takes the current view events and options,
 * returns an array of { filename, content } parts.
 */
export function buildEDLFiles(viewEvents, opts = {}) {
  const {
    projectName      = "PROJECT",
    autosplit        = true,
    metadata         = true,
    vfxMarker        = false,
    vfxRename        = false,
    maxEventsPerPart = 1500,
    fps              = undefined,
    skipDisabled     = false,
    recStartAtZero   = false  // preserve original REC TC; only repair when actually broken
  } = opts;

  let baseEvents = Array.isArray(viewEvents) ? viewEvents : [];

  if (skipDisabled) {
    baseEvents = baseEvents.filter(ev => {
      if (!ev) return false;
      if (ev.disabled) return false;
      const txt = `${ev.clipName || ""} ${ev.srcFile || ""}`;
      return !/\[DISABLED\]/i.test(txt);
    });
  }

  const events = baseEvents.map(ev => ({
    ...ev,
    reel:   normReel(ev),
    srcIn:  safeTC(ev.srcIn, fps || ev.fps || 24),
    srcOut: safeTC(ev.srcOut, fps || ev.fps || 24),
    recIn:  safeTC(ev.recIn, fps || ev.fps || 24),
    recOut: safeTC(ev.recOut, fps || ev.fps || 24),
    fps:    Number(ev.fps) || Number(fps) || 24
  }));

  // --- REC TC FIX ------------------------------------------------------------
  const fpsUse = Number(events[0]?.fps) || Number(fps) || 24;
  const repair = recStartAtZero || shouldRepairRec(events, fpsUse);
  if (repair) {
    rebuildRecFromZero(events, fpsUse);
  }
  // --------------------------------------------------------------------------

  const pullSuffix = (vfxMarker || vfxRename) ? "_VFX_PULL" : "_CF_PULL";

  const slices = autosplit
    ? chunkByEvents(events, Math.max(1, Number(maxEventsPerPart) || 1500))
    : [events];
  const total = slices.length;

  const out = [];
  for (let p = 0; p < total; p++) {
    const edlText  = buildPartEDL(
      slices[p],
      { projectName, metadata, vfxMarker, vfxRename, fps: fpsUse },
      p,
      total
    );
    const filename = `${projectName}${pullSuffix}${
      total > 1 ? `_P${String(p + 1).padStart(2, "0")}of${total}` : ""
    }.edl`;
    out.push({ filename, content: edlText });
  }

  return out;
}

// Optional convenience export (not used by UI but kept for compatibility)
export function exportEDL(params) {
  return buildEDLFiles(params.events || [], params);
}
