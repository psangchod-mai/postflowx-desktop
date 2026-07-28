// modules/filters.js
// -----------------------------------------------------------------------------
// Event filters / pipeline for PostFlowX
// Pipeline: Decompose → Flatten → Merge → Conform (OCF-only) → Dedupe
//           → VFX Marker → Extra Handles → filterValidTimecode
// - *** สำหรับ OTIO (sourceType === "otio") จะไม่ Merge overlap
// -----------------------------------------------------------------------------

import { nominalBase } from './utils_time.js';

/* ---------- Helpers ---------- */

function tcToFrames(tc, fps = 24) {
  if (!tc || typeof tc !== "string") return 0;
  // Drop-frame EDLs use "HH:MM:SS;FF" — normalise the semicolon to a colon so
  // DF timecodes still match this regex instead of returning 0 and getting
  // every event in the pipeline treated as zero-length by filterValidTimecode.
  const m = tc.replace(/;/g, ':').match(/^(\d+):(\d+):(\d+):(\d+)$/);
  if (!m) return 0;
  const hh = +m[1], mm = +m[2], ss = +m[3], ff = +m[4];
  return ((hh * 3600) + (mm * 60) + ss) * nominalBase(fps) + ff;
}

function framesToTC(fr, fps = 24) {
  const base = nominalBase(fps);
  fr = Math.round(fr || 0);
  const totalSec = Math.floor(fr / base);
  const ff = fr % base;
  const hh = Math.floor(totalSec / 3600);
  const mm = Math.floor((totalSec % 3600) / 60);
  const ss = totalSec % 60;
  const pad = n => String(n).padStart(2, "0");
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

function cloneEvents(evs) {
  return (evs || []).map(e => ({ ...e }));
}

// Netflix VFX marker name validation
// Accepts:
//   - SHOW_###_### (e.g. LMP_009_020)
//   - SHOW_###_###_### (e.g. AGM_104_065_010)
// And allows plate/version suffixes like:
//   - _EL_028 / _EL028
//   - _PL01_v001
//   - _comp_NFX_v001 (and similar)
function isValidNetflixVfxMarkerName(name) {
  const s = String(name || "").trim();
  if (!s) return false;

  // Allow only alphanumerics + underscores (Netflix best practice)
  if (!/^[A-Za-z0-9_]+$/.test(s)) return false;

  // Common editorial suffix (not a Netflix VFX name)
  if (/_OK$/i.test(s)) return false;

  // Shot prefix: SHOW_###_### or SHOW_###_###_###
  // SHOW token starts with a letter, length 2–10 (e.g. LMP, AGM)
  const m = s.match(/^([A-Za-z][A-Za-z0-9]{1,9}_\d{3}_\d{3}(?:_\d{3})?)(?:_(.+))?$/);
  if (!m) return false;

  const rest = m[2];
  if (!rest) return true; // shot name alone is valid

  const tokens = rest.split("_").filter(Boolean);
  if (!tokens.length) return false;

  const isV  = (t) => /^v\d{3,4}$/i.test(t);
  const isEL = (t) => /^EL\d{2,3}$/i.test(t);
  const isPL = (t) => /^PL\d{2,3}$/i.test(t);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t) return false;

    // ban common non-VFX marker suffix
    if (/^OK$/i.test(t)) return false;

    // Allow EL_028 / PL_01 forms
    if (/^EL$/i.test(t) || /^PL$/i.test(t)) {
      const nxt = tokens[i + 1];
      if (!nxt || !/^\d{2,3}$/.test(nxt)) return false;
      i++; // consume digits token
      continue;
    }

    // Allow EL028 / PL01 forms
    if (isEL(t) || isPL(t) || isV(t)) continue;

    // General token (comp, NFX, vendor, task, etc.)
    if (!/^[A-Za-z0-9]{2,16}$/.test(t)) return false;
  }

  return true;
}

/* ---------- Normalization ---------- */

export function normalizeEvents(events) {
  return (events || []).map((ev, idx) => ({
    id: ev.id != null ? ev.id : idx,
    ...ev
  }));
}

/* ---------- Decompose / Flatten ---------- */

export function decomposeEvents(events) {
  const fps = (events && events[0] && events[0].fps) || 24;
  const out = cloneEvents(events);
  if (!out.length) return out;

  const recInF = (e) => tcToFrames(e.recIn || "00:00:00:00", fps);
  const recOutF = (e) => tcToFrames(e.recOut || e.recIn || "00:00:00:00", fps);

  // If no trackIndex (or only one track), behave like original: sort by Rec In.
  const trackIds = out
    .map(e => (Number.isFinite(+e?.trackIndex) ? +e.trackIndex : null))
    .filter(v => v != null);

  const hasTracks = trackIds.length > 0;
  const uniqueTracks = hasTracks ? Array.from(new Set(trackIds)) : [];

  if (!hasTracks || uniqueTracks.length <= 1) {
    out.sort((a, b) => recInF(a) - recInF(b));
    return out;
  }

  // Primary track = V1.
  // OTIO Stack/Track order is bottom→top; we treat the lowest index as primary by convention.
  const primaryTid = uniqueTracks.includes(0) ? 0 : Math.min(...uniqueTracks);

  const v1 = [];
  const tracks = new Map(); // tid -> events[]

  for (const ev of out) {
    const t = Number.isFinite(+ev?.trackIndex) ? +ev.trackIndex : primaryTid;
    if (t === primaryTid) {
      v1.push(ev);
    } else {
      if (!tracks.has(t)) tracks.set(t, []);
      tracks.get(t).push(ev);
    }
  }

  // Sort primary by timeline order.
  v1.sort((a, b) => recInF(a) - recInF(b));

  // Cursor = end of primary track (in frames).
  let cursor = 0;
  for (const ev of v1) cursor = Math.max(cursor, recOutF(ev));

  const result = [...v1];

  // Option A: append V2 then V3 then V4... (by track index), each internally sorted by Rec In.
  const appendTids = Array.from(tracks.keys()).sort((a, b) => a - b);

  for (const tid of appendTids) {
    const arr = tracks.get(tid) || [];
    arr.sort((a, b) => recInF(a) - recInF(b));

    for (const ev of arr) {
      const oldIn = recInF(ev);
      const oldOut = recOutF(ev);
      const dur = Math.max(1, oldOut - oldIn);

      const newIn = cursor;
      const newOut = cursor + dur;
      const shift = newIn - oldIn;

      cursor = newOut;

      // Keep trace back to original layer.
      ev._origTrackIndex = ev.trackIndex;
      ev.trackIndex = 0; // single-layer output

      ev.recIn = framesToTC(newIn, fps);
      ev.recOut = framesToTC(newOut, fps);

      // Shift absolute marker timecodes (if any). Markers that are relative (inFrames/startSeconds)
      // will follow the new recIn automatically, so we leave those untouched.
      const baseMarkers = (Array.isArray(ev._markers) && ev._markers.length)
        ? ev._markers
        : (Array.isArray(ev.markers) && ev.markers.length)
          ? ev.markers
          : (ev.metadata && Array.isArray(ev.metadata.markers) && ev.metadata.markers.length)
            ? ev.metadata.markers
            : null;

      if (baseMarkers) {
        const shifted = baseMarkers.map(m => {
          if (!m || typeof m !== 'object') return m;
          const mm = { ...m };
          if (mm.tc && typeof mm.tc === 'string') {
            const mf = tcToFrames(mm.tc, fps);
            mm.tc = framesToTC(mf + shift, fps);
          }
          return mm;
        });
        ev._markers = shifted;
        ev.markers = shifted;
        if (ev.metadata && Array.isArray(ev.metadata.markers)) ev.metadata.markers = shifted;
      }

      result.push(ev);
    }
  }

  return result;
}

export function flattenTracks(events) {
  const fps = (events && events[0] && events[0].fps) || 24;
  const out = cloneEvents(events);
  out.sort((a, b) => {
    const af = tcToFrames(a.recIn || "00:00:00:00", fps);
    const bf = tcToFrames(b.recIn || "00:00:00:00", fps);
    if (af === bf) {
      return (a.trackIndex || 0) - (b.trackIndex || 0);
    }
    return af - bf;
  });
  return out;
}

/* ---------- Merge (Src+Rec) ---------- */

export function mergeOverlap(events) {
  if (!events || !events.length) return [];

  const fps = (events[0] && events[0].fps) || 24;
  const isOTIO = events[0] && events[0].sourceType === "otio";

  // *** OTIO: ไม่ merge เพื่อให้จำนวน event ตรงกับ XML spec (9 events หลัง Conform)
  if (isOTIO) {
    return flattenTracks(events);
  }

  const sorted = flattenTracks(events);
  const out = [];

  let cur = { ...sorted[0] };

  for (let i = 1; i < sorted.length; i++) {
    const ev = sorted[i];
    if (!ev) continue;

    const sameReel = (ev.reel || "") === (cur.reel || "");
    const sameFps  = (ev.fps || fps) === (cur.fps || fps);

    if (!sameReel || !sameFps) {
      out.push(cur);
      cur = { ...ev };
      continue;
    }

    const curRecOutF = tcToFrames(cur.recOut || "00:00:00:00", fps);
    const nextRecInF = tcToFrames(ev.recIn || "00:00:00:00", fps);

    const curSrcOutF = tcToFrames(cur.srcOut || "00:00:00:00", fps);
    const nextSrcInF = tcToFrames(ev.srcIn || "00:00:00:00", fps);

    if (curRecOutF === nextRecInF && curSrcOutF === nextSrcInF) {
      cur.recOut = ev.recOut;
      cur.srcOut = ev.srcOut;
    } else {
      out.push(cur);
      cur = { ...ev };
    }
  }

  out.push(cur);
  return out;
}

/* ---------- Dedupe by Src Range ---------- */

export function dedupeBySrcRange(events) {
  if (!events || !events.length) return [];

  const map = new Map();
  const order = [];

  for (const ev of events) {
    const key = [ev.reel || "", ev.srcIn || "", ev.srcOut || ""].join("|");
    if (!map.has(key)) order.push(key);
    map.set(key, ev);
  }

  return order.map(k => map.get(k));
}

/* ---------- Conform (OCF-only) ---------- */

function __pfxBaseName(name = "") {
  const s = String(name || "").trim();
  if (!s) return "";
  const parts = s.split(/[\/]/);
  return parts[parts.length - 1] || "";
}

function __pfxStripVersionSuffix(name = "") {
  // FCP/Resolve sometimes appends " - v2" style suffix
  return String(name || "").replace(/\s+-\s+v\d+$/i, "").trim();
}

function __pfxStemNoExt(name = "") {
  const s = String(name || "");
  const i = s.lastIndexOf(".");
  return i > 0 ? s.slice(0, i) : s;
}

// ---------------- OCF name patterns (Source File / Reel only) ----------------
// IMPORTANT: We classify OCF ONLY by source file name OR reel (tape name).
// Clip names can be merged/title/graphic labels and must NOT be used.

const __PFX_OCF_FILE_PATTERNS = [
  // ARRI (ALEXA family)
  /^[A-Z]\d{3}C\d{3}_.+\.(mxf|mov|ari)$/i,

  // ARRI (common short naming): F#######.mov
  /^F\d{7}\.(mov|mxf|mp4|mkv)$/i,

  // RED folder (RDC)
  /^[A-Z]\d{3}_C\d{3}_\d{4}[A-Z0-9]{2}\.RDC$/i,

  // Sony standard (C0001.*)
  /^C\d{4}\..+$/i,

  // Sony CamID + Reel (A001C001_230101AB.*)
  /^[A-Z]\d{3}C\d{3}_\d{6}[A-Z0-9]{2}\..+$/i,

  // Canon (IMG_0001.JPG / MVI_0001.MOV)
  /^(IMG|MVI)_\d{4}\.(JPG|MOV|MP4)$/i,

  // Blackmagic (BRAW/MOV) pattern
  /^[^_]+_\d+_\d{4}-\d{2}-\d{2}_\d{4}_C\d+\.(mov|braw)$/i,

  // DJI
  /^DJI_\d{4}\..+$/i,
  /^DJI_\d{14}_\d{4}_.+\..+$/i,
  // DJI (newer date-time style: DJI_YYYYMMDDTHHMMSS_####_...)
  /^DJI_\d{8}T\d{6}_\d{4}_.+\.(mp4|mov|mxf|mkv)$/i,
  // DJI (variant: DJI_YYYYMMDD_HHMMSS_####_...)
  /^DJI_\d{8}_\d{6}_\d{4}_.+\.(mp4|mov|mxf|mkv)$/i,

  // DJI (variants)
  /^DJI_\d{14}_\d{4}\.(mp4|mov|mxf|mkv)$/i,
  /^DJI_\d{8}T?\d{6}\.(mp4|mov|mxf|mkv)$/i,
  /^DJI_\d{8}_\d{6}\.(mp4|mov|mxf|mkv)$/i,
  /^DJI_\d{8}T?\d{6}_\d{4}\.(mp4|mov|mxf|mkv)$/i,
  /^DJI_\d{8}_\d{6}_\d{4}\.(mp4|mov|mxf|mkv)$/i,
  /^DJI_.+\.(mp4|mov|mxf|mkv)$/i,

  // Phantom (image sequences)
  /^imag\d{4,}\..+$/i,

  // PostFlowX camera naming (underscore style)
  /^[A-Za-z]_\d{3,4}C\d{3}_\d{6}_\d{6}_[A-Za-z0-9]+\.(mov|mp4|mxf|mkv)$/i,

  // General camera container naming (A001C001_...)
  /^[A-Za-z]\d{3,4}C\d{3,4}[_-].+\.(mov|mp4|mxf|mkv)$/i,

  // Variant seen in some reels (A07GC003_...)
  /^[A-Za-z]\d{2}[A-Za-z]C\d{3}[_-].+\.(mov|mp4|mxf|mkv)$/i,

  // ARRI / generic: any letter between roll and clip numbers (e.g. A001L002_25030194.mxf)
  // Covers LF, 35, Mini variants that use letters other than 'C' for the clip segment
  /^[A-Za-z]\d{3}[A-Za-z]\d{3,}_[A-Za-z0-9]+\.(mxf|mov|mp4|mkv|ari)$/i,
];

const __PFX_OCF_STEM_PATTERNS = [
  // PostFlowX underscore stem
  /^[A-Za-z]_\d{3,4}C\d{3}_\d{6}_\d{6}(_[A-Za-z0-9]+)?$/i,

  // ARRI (common short naming): F#######
  /^F\d{7}$/i,

  // ARRI / Sony CamID + Reel style (A001C001_...)
  /^[A-Za-z]\d{3,4}C\d{3,4}[_-].+$/i,
  /^[A-Za-z]\d{3,4}C\d{3,4}$/i,

  // Variant (A07GC003...)
  /^[A-Za-z]\d{2}[A-Za-z]C\d{3}[_-].+$/i,
  /^[A-Za-z]\d{2}[A-Za-z]C\d{3}$/i,

  // ARRI / generic stem: any letter between roll and clip (e.g. A001L002_25030194)
  /^[A-Za-z]\d{3}[A-Za-z]\d{3,}_[A-Za-z0-9]+$/i,
  /^[A-Za-z]\d{3}[A-Za-z]\d{3,}$/i,

  // RED folder (no ext)
  /^[A-Z]\d{3}_C\d{3}_\d{4}[A-Z0-9]{2}$/i,

  // Sony standard (no ext)
  /^C\d{4}$/i,

  // Sony CamID+Reel (no ext)
  /^[A-Z]\d{3}C\d{3}_\d{6}[A-Z0-9]{2}$/i,

  // Canon (no ext)
  /^(IMG|MVI)_\d{4}$/i,

  // DJI (no ext)
  /^DJI_\d{4}$/i,
  /^DJI_\d{14}_\d{4}_.+$/i,
  /^DJI_\d{8}T\d{6}_\d{4}_.+$/i,
  /^DJI_\d{8}_\d{6}_\d{4}_.+$/i,

  // DJI (variants)
  /^DJI_\d{14}_\d{4}$/i,
  /^DJI_\d{8}T?\d{6}$/i,
  /^DJI_\d{8}_\d{6}$/i,
  /^DJI_\d{8}T?\d{6}_\d{4}$/i,
  /^DJI_\d{8}_\d{6}_\d{4}$/i,
  /^DJI_.+$/i,

  // Phantom (no ext)
  /^imag\d{4,}$/i,
];

function __pfxIsOCFStem(stem = "") {
  const st = String(stem || "").trim();
  if (!st) return false;
  if (/^(nested sequence|sequence|mps fcpx clip)/i.test(st)) return false;
  if (/\s/.test(st)) return false;
  for (const re of __PFX_OCF_STEM_PATTERNS) {
    if (re.test(st)) return true;
  }
  return false;
}

// Heuristic: camera-original style naming
function looksLikeCameraOCF(name = "") {
  const base = __pfxStripVersionSuffix(__pfxBaseName(name));
  if (!base) return false;
  const stem = __pfxStemNoExt(base);

  // If full filename matches a known camera pattern
  for (const re of __PFX_OCF_FILE_PATTERNS) {
    if (re.test(base)) return true;
  }

  // Otherwise check stem patterns
  return __pfxIsOCFStem(stem);
}

function isOCFFileName(name = "") {
  const base = __pfxStripVersionSuffix(__pfxBaseName(name));
  if (!base) return false;
  const low = base.toLowerCase();
  const stem = __pfxStemNoExt(base);

  // Unique camera formats
  if (low.endsWith('.r3d') || low.endsWith('.braw') || low.endsWith('.crm') || low.endsWith('.ari')) return true;

  // RED folder
  if (low.endsWith('.rdc')) return true;

  // Sequences: only if name itself looks like camera output (avoid VFX EXR false positives)
  if (low.endsWith('.dpx') || low.endsWith('.exr')) return __pfxIsOCFStem(stem);

  // Common containers: require pattern match
  if (low.endsWith('.mxf') || low.endsWith('.mov') || low.endsWith('.mp4') || low.endsWith('.mkv') || low.endsWith('.jpg') || low.endsWith('.jpeg')) {
    return looksLikeCameraOCF(base);
  }

  return false;
}

// รองรับทั้งแบบมีนามสกุล และ pattern OCF ที่ไม่มีนามสกุล (เช่น A_0001C024_250617_143613_h1C001)
function isOCFNameFlexible(name = "") {
  if (!name) return false;
  const base = __pfxStripVersionSuffix(__pfxBaseName(name));

  // Has extension → classify by extension + pattern
  if (/\.[A-Za-z0-9]+$/.test(base)) return isOCFFileName(base);

  // No extension → rely on naming
  return looksLikeCameraOCF(base);
}

export function filterCameraOriginal(events) {
  return (events || []).filter(ev => {
    if (!ev) return false;

    // ✅ OCF detection must come from **Source File name** OR **Reel (Tape name)** only.
    // Never rely on clipName, because editorial clip names are often merged/title/graphic labels.
    const src = ev.srcFile || "";
    const reel = ev.reel || "";

    // If either source file name or reel looks like OCF → keep.
    // This also allows reel to override incorrect ev.isOCF flags.
    if (isOCFNameFlexible(src)) return true;
    if (isOCFNameFlexible(reel)) return true;

    return false;
  });
}

/* ---------- Extra Handles (Speed >100%) ---------- */

export function addExtraHandlesForFastClips(events, opts = {}) {
  const fps = opts.fps || (events && events[0] && events[0].fps) || 24;
  const out = cloneEvents(events);

  out.forEach(ev => {
    const s = Number(ev.speedFactor || 100);
    if (!Number.isFinite(s) || s <= 100) return;

    let extra = Math.round(0.5 * fps * (s / 100 - 1));
    if (extra < 8) extra = 8;
    if (extra < Math.min(fps, 48)) extra = Math.min(fps, 48); // at least ~1 second, but no more than 48
    if (extra > 48) extra = 48;

    ev._extraHandles = { head: extra, tail: extra };
  });

  return out;
}

/* ---------- VFX Marker ---------- */

export function onlyVfxMarker(events, opts = {}) {
  const fps = opts.fps || (events && events[0] && events[0].fps) || 24;
  const colorFilter = String(opts.color || "All").toLowerCase();

  // Support LOC lines imported from .edl as VFX markers.
  // Example: "LOC: 14:49:48:10 RED LMP_TST_BG001" (or "LOC: tc (RED) name")
  function parseEdlLocToMarker(locLine = "") {
    const s = String(locLine || "").trim();
    if (!s) return null;

    // LOC: 00:00:00:00 RED NAME
    let m = s.match(/^LOC:\s*(\d{2}:\d{2}:\d{2}:\d{2})\s+([^\s]+)\s+(.*)$/i);
    if (m) {
      return {
        tc: m[1],
        color: m[2],
        name: (m[3] || "").trim() || "MARKER",
        _from: "edlLoc",
        _range: "base" // keep base clip duration for EDL LOC markers
      };
    }

    // LOC: 00:00:00:00 (RED) NAME
    m = s.match(/^LOC:\s*(\d{2}:\d{2}:\d{2}:\d{2})\s*\(([^)]+)\)\s+(.*)$/i);
    if (m) {
      return {
        tc: m[1],
        color: m[2],
        name: (m[3] || "").trim() || "MARKER",
        _from: "edlLoc",
        _range: "base"
      };
    }

    return null;
  }

  const result = [];
  let idx = 0;

  (events || []).forEach(baseEv => {
    if (!baseEv) return;

    let markers = [];
    if (Array.isArray(baseEv._markers) && baseEv._markers.length) {
      markers = baseEv._markers;
    } else if (baseEv.metadata && Array.isArray(baseEv.metadata.markers)) {
      markers = baseEv.metadata.markers;
    }

    // If no markers but we have LOC from imported EDL, treat it as a marker.
    if (!markers.length && baseEv._edlLoc) {
      const mm = parseEdlLocToMarker(baseEv._edlLoc);
      if (mm) markers = [mm];
    }

    // ✅ VFX Marker: ONLY include CLIP markers (ignore timeline markers)
    // We keep legacy/unknown markers if scope is missing (undefined/null),
    // but explicitly drop anything that declares a non-clip scope.
    if (markers.length) {
      markers = markers.filter(m => {
        if (!m) return false;
        if (m._from === "edlLoc") return true; // imported LOC line (keep)
        const sc = (m.scope == null) ? "" : String(m.scope).toLowerCase();
        return (!sc || sc === "clip");
      });
    }
    if (!markers.length) return;

    const baseRecInF = tcToFrames(baseEv.recIn || "00:00:00:00", fps);

    markers.forEach(m => {
      if (!m) return;

      // Accept ALL clip markers (clip-scope only filtering happens above).
      // If marker name is empty or generic ("Marker", "Marker 1", ...), fall back to clip name.
      let markerName = String(m.name || "").trim();
      const isGeneric = (!markerName) || /^marker\s*\d*$/i.test(markerName);
      if (isGeneric) {
        markerName = String(baseEv.clipName || baseEv.reel || "").trim();
      }
      if (!markerName) return;

      // Normalize color (FCPXML lane/color can be "Green", "RED", etc.)
      const normColor = String(m.color || "GREEN").trim();
      const mm = { ...m, name: markerName, color: normColor };

      const mColor = String(mm.color || "Green").toLowerCase();
      if (colorFilter !== "all" && mColor !== colorFilter) return;

      let recInTC = "00:00:00:00";
      if (mm.tc) {
        recInTC = mm.tc;
      } else if (Number.isFinite(mm.inFrames)) {
        const f = baseRecInF + (mm.inFrames || 0);
        recInTC = framesToTC(f, fps);
      } else if (Number.isFinite(mm.startSeconds)) {
        const f = baseRecInF + Math.round(mm.startSeconds * fps);
        recInTC = framesToTC(f, fps);
      } else {
        recInTC = baseEv.recIn || "00:00:00:00";
      }

      const recOutTC = framesToTC(tcToFrames(recInTC, fps) + 1, fps);
      const srcInTC = baseEv.srcIn || "00:00:00:00";
      const srcOutTC = baseEv.srcOut || "00:00:00:00";

      const keepBaseRange = (mm && (mm._range === "base" || mm._from === "edlLoc"));

      const markerEvent = {
        ...baseEv,
        id: idx++,
        recIn: keepBaseRange ? (baseEv.recIn || recInTC) : recInTC,
        recOut: keepBaseRange ? (baseEv.recOut || recOutTC) : recOutTC,
        srcIn: keepBaseRange ? (baseEv.srcIn || srcInTC) : srcInTC,
        srcOut: keepBaseRange ? (baseEv.srcOut || srcOutTC) : srcOutTC,
        _marker: mm
      };

      result.push(markerEvent);
    });
  });

  return result;
}

/* ---------- Timecode validity ---------- */

export function filterValidTimecode(events, fps = 24) {
  return (events || []).filter(ev => {
    const si = ev.srcIn || "00:00:00:00";
    const so = ev.srcOut || "00:00:00:00";
    const ri = ev.recIn || "00:00:00:00";
    const ro = ev.recOut || "00:00:00:00";

    const siF = tcToFrames(si, fps);
    const soF = tcToFrames(so, fps);
    const riF = tcToFrames(ri, fps);
    const roF = tcToFrames(ro, fps);

    if (!Number.isFinite(siF) || !Number.isFinite(soF) ||
        !Number.isFinite(riF) || !Number.isFinite(roF)) {
      return false;
    }

    const srcZero = (si === "00:00:00:00" && so === "00:00:00:00");
    const recZero = (ri === "00:00:00:00" && ro === "00:00:00:00");
    if (srcZero && recZero) return false;

    if (soF <= siF || roF <= riF) return false;

    return true;
  });
}

/* ---------- Master pipeline ---------- */

export function runPipeline(rawEvents, qs = {}) {
  let evs = cloneEvents(rawEvents || []);
  const fps = (evs[0] && evs[0].fps) || 24;

  if (qs.hideDisabled) {
    evs = evs.filter(ev => !ev.disabled);
  }

  if (qs.decompose) {
    evs = decomposeEvents(evs);
  }

  if (qs.flatten) {
    evs = flattenTracks(evs);
  }

  if (qs.mergeOverlap) {
    evs = mergeOverlap(evs);
  }

  if (qs.conformOCF) {
    evs = filterCameraOriginal(evs);
  }

  evs = dedupeBySrcRange(evs);

  if (qs.vfxMarker) {
    evs = onlyVfxMarker(evs, { color: "All", fps });
  }

  if (qs.extraHandles) {
    evs = addExtraHandlesForFastClips(evs, { fps });
  }

  evs = filterValidTimecode(evs, fps);

  evs = evs.map((ev, idx) => ({ ...ev, id: idx }));

  return evs;
}

export default {
  normalizeEvents,
  decomposeEvents,
  flattenTracks,
  mergeOverlap,
  dedupeBySrcRange,
  filterCameraOriginal,
  addExtraHandlesForFastClips,
  onlyVfxMarker,
  filterValidTimecode,
  runPipeline
};
