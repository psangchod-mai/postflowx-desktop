// modules/parser_xml.js
// -----------------------------------------------------------------------------
// XMEML / FCP XML (Premiere / old FCP / Resolve) parser for PostFlowX
//
// v3.5
// - ใช้เฉพาะ "main sequence" ตัวแรกเป็น timeline หลัก
// - Rec TC = sequence/timecode (base TC) + clipitem start/end
// - Src TC = file/timecode (หรือ clipitem/timecode) + in/out → ได้กล้องจริง (ถ้ายังเป็น OCF)
// - ใส่ flag:
//      • isOCF    = true  เฉพาะกรณีที่ "ไฟล์จริง" เป็นไฟล์กล้อง (.mov/.mxf/.r3d/.braw/.mp4/.mkv/.dpx/.exr)
//      • kind     = "clip" | "nested" | "compound"
//      • disabled = true ถ้า <enabled> เป็น FALSE/0
//      • type     = "video"
// - markers:
//      • ดึงเฉพาะจากคลิปที่ isOCF === true && kind === "clip"
//      • markers บน Nested Sequence / comp จะไม่ถูกนับ (ช่วยลดซ้ำใน VFX Marker)
// - normalize:  ตัดเฉพาะ event ที่ srcIn == "00:00:00:00"
//    ถ้า srcFile เดียวกันมีทั้ง srcIn == "00:00:00:00" และ srcIn อื่น → เก็บเฉพาะตัวที่ srcIn != "00:00:00:00"
// -----------------------------------------------------------------------------

// ล้าง DOCTYPE + control chars ออกจาก XML
function sanitizeXML(txt) {
  let s = String(txt || "");
  s = s.replace(/<!DOCTYPE[\s\S]*?>/gi, "");
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  return s;
}

function stemNoExt(path = "") {
  const s = String(path || "");
  const i = s.lastIndexOf(".");
  return i > 0 ? s.slice(0, i) : s;
}

function getText(node, tagName, fallback = "") {
  if (!node) return fallback;
  const els = node.getElementsByTagName(tagName);
  if (!els || !els.length || !els[0].textContent) return fallback;
  return String(els[0].textContent).trim();
}

function toInt(str, def = 0) {
  const n = parseInt(str, 10);
  return Number.isFinite(n) ? n : def;
}


// Normalize FPS for timecode math: always use integer timebase (e.g. 24/30/60)
// XMEML time values (<start>/<end>/<in>/<out>) are frame counts at <timebase>.
function normFps(fps){
  const n = Number(fps);
  if (!Number.isFinite(n) || n <= 0) return 24;
  // For 23.976/29.97/59.94, use nominal integer for TC formatting.
  return Math.round(n);
}


// --- TC helpers --------------------------------------------------------------
function tcToFrames(tc, fps) {
  fps = normFps(fps);
  if (!tc || typeof tc !== "string") return 0;
  const m = tc.match(/^(\d+)[:;](\d+)[:;](\d+)[:;](\d+)$/);
  if (!m) return 0;
  const hh = +m[1], mm = +m[2], ss = +m[3], ff = +m[4];
  return ((hh * 3600) + (mm * 60) + ss) * fps + ff;
}

function framesToTC(fr, fps) {
  fps = normFps(fps);
  // Guard against negative frames (can appear in some XML exports around transitions)
  fr = Math.round(fr || 0);
  if (fr < 0) fr = 0;
  const totalSeconds = Math.floor(fr / fps);
  const ff = fr % fps;
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60);
  const ss = totalSeconds % 60;
  const p = (n) => String(n).padStart(2, "0");
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
}

function extractFPS(rateNode) {
  if (!rateNode) return 24;
  const tb = toInt(getText(rateNode, "timebase"), 24) || 24;

  // IMPORTANT:
  // For EDL/timecode math we always use the *integer* timebase (24/25/30/50/60).
  // XMEML may set <ntsc>TRUE to indicate 23.976/29.97/59.94, but the frame counts
  // in <start>/<end>/<in>/<out> are still based on the nominal timebase.
  return tb;
}

// Full rate info for the sequence: integer tcBase for TC math + actual playback fps for display.
// ntsc=TRUE means rate is 1000/1001 of the timebase: 24/ntsc → 23.976023976…
function parseRateInfo(rateNode) {
  const tcBase = extractFPS(rateNode);  // always integer
  const isNtsc = rateNode
    ? getText(rateNode, "ntsc", "").trim().toUpperCase() === "TRUE"
    : false;
  const playbackFps = isNtsc ? (tcBase * 1000) / 1001 : tcBase;
  return { tcBase, isNtsc, playbackFps, dropFrame: false };
}

function extractProjectName(root, seq) {
  const seqName = getText(seq, "name", "").trim();
  if (seqName) return seqName;

  const seqs = root.getElementsByTagName("sequence");
  if (seqs && seqs.length) {
    const n = getText(seqs[0], "name", "").trim();
    if (n) return n;
  }
  return "PROJECT";
}

// --- OCF helpers -------------------------------------------------------------
function isOCFFileName(name = "") {
  const raw = String(name || "").trim();
  if (!raw) return false;

  // keep basename only
  const base0 = raw.split(/[\/]/).pop() || "";
  const base = normalizeNameBase(base0);
  if (!base) return false;
  const low = base.toLowerCase();
  const stem = stemNoExt(base);

  // Unique camera formats
  if (/(\.r3d|\.braw|\.crm|\.ari)$/i.test(low)) return true;

  // RED folder
  if (/\.rdc$/i.test(low)) return true;

  // File-level camera patterns (common originals)
  const FILE_PATTERNS = [
    /^[A-Z]\d{3}C\d{3}_.+\.(mxf|mov|ari)$/i,                 // ARRI
    /^F\d{7}\.(mov|mxf|mp4|mkv)$/i,                           // ARRI short (F#######)
    /^[A-Z]\d{3}_C\d{3}_\d{4}[A-Z0-9]{2}\.RDC$/i,          // RED folder
    /^C\d{4}\..+$/i,                                        // Sony standard
    /^[A-Z]\d{3}C\d{3}_\d{6}[A-Z0-9]{2}\..+$/i,            // Sony CamID+Reel
    /^(IMG|MVI)_\d{4}\.(JPG|MOV|MP4)$/i,                    // Canon
    /^[^_]+_\d+_\d{4}-\d{2}-\d{2}_\d{4}_C\d+\.(mov|braw)$/i, // Blackmagic
    /^DJI_\d{4}\..+$/i,                                     // DJI seq
    /^DJI_\d{14}_\d{4}_.+\..+$/i,                           // DJI datetime
    /^DJI_\d{8}T\d{6}_\d{4}_.+\.(mp4|mov|mxf|mkv)$/i,       // DJI YYYYMMDDTHHMMSS
    /^DJI_\d{8}_\d{6}_\d{4}_.+\.(mp4|mov|mxf|mkv)$/i,       // DJI YYYYMMDD_HHMMSS

    // DJI (variants)
    /^DJI_\d{14}_\d{4}\.(mp4|mov|mxf|mkv)$/i,
    /^DJI_\d{8}T?\d{6}\.(mp4|mov|mxf|mkv)$/i,
    /^DJI_\d{8}_\d{6}\.(mp4|mov|mxf|mkv)$/i,
    /^DJI_\d{8}T?\d{6}_\d{4}\.(mp4|mov|mxf|mkv)$/i,
    /^DJI_\d{8}_\d{6}_\d{4}\.(mp4|mov|mxf|mkv)$/i,
    /^DJI_.+\.(mp4|mov|mxf|mkv)$/i,
    /^imag\d{4,}\..+$/i,                                    // Phantom image seq
    /^[A-Za-z]_\d{3,4}C\d{3}_\d{6}_\d{6}_[A-Za-z0-9]+\.(mov|mp4|mxf|mkv)$/i, // PostFlowX underscore
    /^[A-Za-z]\d{3,4}C\d{3,4}[_-].+\.(mov|mp4|mxf|mkv)$/i,    // General A001C001_...
    /^[A-Za-z]\d{2}[A-Za-z]C\d{3}[_-].+\.(mov|mp4|mxf|mkv)$/i, // Variant A07GC003_...
  ];

  for (const re of FILE_PATTERNS) {
    if (re.test(base)) return true;
  }

  // Sequence formats (DPX/EXR): only if the stem matches camera patterns (avoid VFX EXR false positives)
  if (/(\.dpx|\.exr)$/i.test(low)) {
    return looksLikeOCFStem(stem);
  }

  // Common containers still require stem to look like camera output
  if (/(\.mxf|\.mov|\.mp4|\.mkv|\.jpg|\.jpeg)$/i.test(low)) {
    return looksLikeOCFStem(stem);
  }

  return false;
}

// ตัด suffix " - v1" ฯลฯ
function normalizeNameBase(name = "") {
  let s = String(name || "").trim();
  if (!s) return "";
  s = s.replace(/\s+-\s+v\d+$/i, "");
  return s;
}

// เดาว่าเป็น OCF stem แม้ไม่มีนามสกุล
function looksLikeOCFStem(name = "") {
  const s = normalizeNameBase(name);
  if (!s) return false;

  // Skip generic names
  if (/^(nested sequence|sequence|mps fcpx clip)/i.test(s)) return false;

  const stem = String(s).trim();
  if (!stem) return false;
  if (/\s/.test(stem)) return false;

  // If it already looks like an OCF filename (has extension)
  if (isOCFFileName(stem)) return true;

  const st = stemNoExt(stem);

  const STEM_PATTERNS = [
    // PostFlowX underscore
    /^[A-Za-z]_\d{3,4}C\d{3}_\d{6}_\d{6}(_[A-Za-z0-9]+)?$/i,

    // ARRI short (F#######)
    /^F\d{7}$/i,

    // ARRI / Sony CamID+Reel style
    /^[A-Za-z]\d{3,4}C\d{3,4}[_-].+$/i,
    /^[A-Za-z]\d{3,4}C\d{3,4}$/i,

    // Variant A07GC003...
    /^[A-Za-z]\d{2}[A-Za-z]C\d{3}[_-].+$/i,
    /^[A-Za-z]\d{2}[A-Za-z]C\d{3}$/i,

    // RED folder no-ext
    /^[A-Z]\d{3}_C\d{3}_\d{4}[A-Z0-9]{2}$/i,

    // Sony standard
    /^C\d{4}$/i,

    // Sony CamID+Reel
    /^[A-Z]\d{3}C\d{3}_\d{6}[A-Z0-9]{2}$/i,

    // Canon
    /^(IMG|MVI)_\d{4}$/i,

    // DJI
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

    // Phantom
    /^imag\d{4,}$/i,
  ];

  for (const re of STEM_PATTERNS) {
    if (re.test(st)) return true;
  }

  return false;
}

function extractFileNameFromPathUrl(pathUrl = "") {
  if (!pathUrl) return "";
  let s = String(pathUrl);
  try {
    s = decodeURI(s);
  } catch {}
  const m = s.match(/([^\/\\]+)$/);
  return m ? m[1] : "";
}

// เลือกชื่อที่จะใช้เป็น srcFile / reel + flag isOCF
// - isOCF อิงจาก "ไฟล์จริง" (fileName/pathUrl) เท่านั้น
// - reel/srcFile จะพยายามใช้ชื่อ OCF จาก clipName/path เพื่อให้ EDL อ่านง่าย
// tape: <tape> element value from FCP XML / Resolve XML — is the camera reel identifier,
//   inserted between fileName and clipName in the priority chain so that offline clips
//   (no <file> node) still get the correct reel instead of falling through to clipName.
function pickSourceFromNames({ fileName, clipName, pathUrl, tape = "" }) {
  const fileNameNorm = normalizeNameBase(fileName);
  const clipNameNorm = normalizeNameBase(clipName);
  const pathNameRaw  = extractFileNameFromPathUrl(pathUrl);
  const pathNameNorm = normalizeNameBase(pathNameRaw);
  const tapeNorm     = normalizeNameBase(tape);

  const fileIsOCF = isOCFFileName(fileNameNorm) || isOCFFileName(pathNameRaw);

  const clipLooksOCF = looksLikeOCFStem(clipNameNorm);
  const pathLooksOCF = looksLikeOCFStem(pathNameNorm);

  // base สำหรับ reel/srcFile
  // tape is inserted before clipName: it is the camera reel name, not a scene annotation.
  let chosenForReel = fileNameNorm || tapeNorm || pathNameNorm || clipNameNorm || "CLIP";

  // ถ้าไฟล์จริงไม่ใช่ OCF แต่ clip/path ดูเหมือน OCF → ใช้ชื่อ OCF นั้นเป็น reel
  if (!fileIsOCF) {
    if (clipLooksOCF) {
      chosenForReel = clipNameNorm;
    } else if (pathLooksOCF) {
      chosenForReel = pathNameNorm;
    }
  }

  // ลองเติม extension ถ้าเดาจาก raw ได้
  if (!/\.[A-Za-z0-9]+$/.test(chosenForReel)) {
    const rawList = [fileName, pathNameRaw, tape, clipName];
    for (const raw of rawList) {
      if (!raw) continue;
      const rawNorm = normalizeNameBase(raw);
      const stemLower = chosenForReel.toLowerCase();
      if (rawNorm.toLowerCase().startsWith(stemLower + ".")) {
        const dot = rawNorm.lastIndexOf(".");
        chosenForReel = chosenForReel + rawNorm.slice(dot);
        break;
      }
    }
  }

  const srcFile = chosenForReel;
  // If tape is present and the file name was absent (chosenForReel fell through to tape or clip),
  // use tape stem as reel directly — it IS the camera reel identifier without extension.
  const reel = (tapeNorm && !fileNameNorm && !pathNameNorm) ? (stemNoExt(tapeNorm) || stemNoExt(chosenForReel) || "R") : (stemNoExt(chosenForReel) || "R");

  const isOCF = !!fileIsOCF; // อิงจากไฟล์จริงเท่านั้น

  return { srcFile, reel, isOCF };
}

// ---------- markers -----------------------------------------------------------
// NOTE: จะถูกเรียกเฉพาะกรณี isOCF === true && kind === "clip"
function extractResolveMarkers(clipitem, fps, recInFramesAbs) {
  const markers = [];
  const markerNodes = clipitem.getElementsByTagName("marker");
  for (let i = 0; i < markerNodes.length; i++) {
    const m = markerNodes[i];
    const name =
      getText(m, "name", "") ||
      getText(m, "comment", "") ||
      "Marker";

    const inStr  = getText(m, "in", "0");
    const outStr = getText(m, "out", "-1");
    const inFrames  = toInt(inStr, 0);
    const outFrames = toInt(outStr, -1);

    const absFrames = recInFramesAbs + inFrames;
    const tc = framesToTC(absFrames, fps);

    markers.push({
      name,
      color: "Green",   // สีจริงไป map ต่อใน VFX pipeline
      tc,
      inFrames,
      outFrames,
      scope: "clip"
    });
  }
  return markers;
}


// ---------------- FX extraction (Speed / Transform) ----------------
// Best-effort parsing of XMEML <filter><effect><parameter>.
// Works with common Premiere / Resolve XML exports where:
//   - Motion/Basic Motion provides scale/rotation/center
//   - Time Remap / Speed provides speed percent
function extractFxFromClipitem(clipitem){
  if (!clipitem) return null;

  let speedPercent = null;
  let speedKeys = null;
  let transform = null;

  const readNum = (v) => {
    const n = Number(String(v || '').trim());
    return Number.isFinite(n) ? n : null;
  };

  const normalizeSpeedPercent = (v) => {
    const n = readNum(v);
    if (n == null) return null;
    const abs = Math.abs(n);
    if (abs > 0 && abs <= 10) return n * 100;
    return n;
  };

  const readPair = (v) => {
    const parts = String(v || '').trim().split(/[,\s]+/).filter(Boolean).map(Number);
    if (!parts.length || parts.some(x => !Number.isFinite(x))) return null;
    if (parts.length === 1) return [parts[0], parts[0]];
    return [parts[0], parts[1]];
  };

  const sameNum = (a, b, tol = 0.001) => Math.abs(Number(a) - Number(b)) <= tol;
  const samePair = (a, b, tol = 0.001) =>
    Array.isArray(a) && Array.isArray(b) &&
    a.length >= 2 && b.length >= 2 &&
    Math.abs(Number(a[0]) - Number(b[0])) <= tol &&
    Math.abs(Number(a[1]) - Number(b[1])) <= tol;
  const isNonZeroPair = (pair) =>
    Array.isArray(pair) &&
    pair.length >= 2 &&
    (Math.abs(Number(pair[0])) > 0.001 || Math.abs(Number(pair[1])) > 0.001);

  const parseKeyframes = (param) => {
    const kfs = [];
    try{
      const nodes = param.getElementsByTagName('keyframe');
      for (let i=0; i<nodes.length; i++){
        const k = nodes[i];
        const when = getText(k, 'when', '') || getText(k, 'time', '') || '';
        const val  = getText(k, 'value', '') || '';
        if (when || val) kfs.push({ when, value: val });
      }
    }catch{}
    return kfs.length ? kfs : null;
  };

  const chooseMotionValueFromKeys = (current, kfs, parser, same, isMeaningful) => {
    if (!kfs || !kfs.length) return current;
    const parsed = kfs
      .map(k => parser(k.value))
      .filter(v => v != null);
    if (!parsed.length) return current;

    if (current != null && (!isMeaningful || isMeaningful(current))) return current;

    const first = parsed[0];
    const isConst = parsed.every(v => same(v, first));
    if (isConst) return first;

    if (isMeaningful) {
      for (let i = parsed.length - 1; i >= 0; i--) {
        if (isMeaningful(parsed[i])) return parsed[i];
      }
    }
    return parsed[parsed.length - 1];
  };

  const pickSpeedPercent = (next) => {
    if (next == null) return;
    if (speedPercent == null) {
      speedPercent = next;
      return;
    }
    const cur = Number(speedPercent);
    if (!Number.isFinite(cur) || (Math.abs(cur) <= 0.0001 && Math.abs(next) > 0.0001)) {
      speedPercent = next;
    }
  };

  // Some XMEML includes <speed> directly
  try{
    const spNode = clipitem.getElementsByTagName('speed')[0];
    if (spNode && spNode.textContent){
      pickSpeedPercent(normalizeSpeedPercent(spNode.textContent));
    }
  }catch{}

  // Walk filters/effects
  const filters = clipitem.getElementsByTagName('filter');
  for (let i=0; i<filters.length; i++){
    const filter = filters[i];
    const effect = filter.getElementsByTagName('effect')[0];
    if (!effect) continue;

    const effName = (getText(effect, 'name', '') || '').trim();
    const effNameL = effName.toLowerCase();

    const isMotion = /\bmotion\b|basic motion|transform/i.test(effName);
    const isSpeed  = /time remap|speed|rate|retime/i.test(effNameL);
    const isCrop   = /\bcrop\b/i.test(effName);

    const params = effect.getElementsByTagName('parameter');

    if (isMotion){
      const t = transform || {};
      for (let pi=0; pi<params.length; pi++){
        const param = params[pi];
        const pid = (getText(param, 'parameterid', '') || '').trim().toLowerCase();
        const pname = (getText(param, 'name', '') || '').trim().toLowerCase();
        const key = pid || pname;
        const val = (getText(param, 'value', '') || '').trim();
        const kfs = parseKeyframes(param);

        if (key.includes('scale') && !key.includes('scalex') && !key.includes('scaley') && key !== 'scale x' && key !== 'scale y'){
          let scaleVal = readNum(val);
          scaleVal = chooseMotionValueFromKeys(scaleVal, kfs, readNum, sameNum, n => Math.abs(Number(n)) > 0.001);
          if (scaleVal != null) t.scale = scaleVal;
          if (kfs) t.scaleKeys = kfs;
        }
        if (key === 'scalex' || key === 'scale x') {
          const v = readNum(val); if (v != null) t.scaleX = v > 10 ? v / 100 : v;
        }
        if (key === 'scaley' || key === 'scale y') {
          const v = readNum(val); if (v != null) t.scaleY = v > 10 ? v / 100 : v;
        }
        if (key.includes('rotation')){
          let rotVal = readNum(val);
          rotVal = chooseMotionValueFromKeys(rotVal, kfs, readNum, sameNum, n => Math.abs(Number(n)) > 0.001);
          if (rotVal != null) t.rotation = rotVal;
          if (kfs) t.rotationKeys = kfs;
        }
        if (key.includes('center') || key.includes('position')){
          let pair = readPair(val);
          pair = chooseMotionValueFromKeys(pair, kfs, readPair, samePair, isNonZeroPair);
          if (pair) t.position = pair;
          if (kfs) t.positionKeys = kfs;
        }
      }
      transform = t;
    }

    if (isCrop){
      const t = transform || {};
      if (!t.crop) t.crop = {};
      for (let pi=0; pi<params.length; pi++){
        const param = params[pi];
        const pid = (getText(param, 'parameterid', '') || getText(param, 'name', '') || '').trim().toLowerCase();
        const val = parseFloat(getText(param, 'value', '0') || '0') || 0;
        if (pid === 'left'   || pid.includes('left'))   t.crop.left   = val;
        if (pid === 'right'  || pid.includes('right'))  t.crop.right  = val;
        if (pid === 'top'    || pid.includes('top'))     t.crop.top    = val;
        if (pid === 'bottom' || pid.includes('bottom')) t.crop.bottom = val;
      }
      transform = t;
    }

    if (isSpeed){
      // Look for parameter named/ID 'speed'
      for (let pi=0; pi<params.length; pi++){
        const param = params[pi];
        const pid = (getText(param, 'parameterid', '') || '').trim().toLowerCase();
        const pname = (getText(param, 'name', '') || '').trim().toLowerCase();
        const key = pid || pname;
        if (!key) continue;
        if (key.includes('speed') || key.includes('rate')){
          const val = (getText(param, 'value', '') || '').trim();
          pickSpeedPercent(normalizeSpeedPercent(val));

          const kfs = parseKeyframes(param);
          if (kfs && kfs.length){
            const parsed = kfs
              .map(k => {
                const pct = normalizeSpeedPercent(k.value);
                return pct == null ? null : { when: k.when, value: pct };
              })
              .filter(Boolean);
            if (parsed.length){
              const first = parsed[0].value;
              const isConst = parsed.every(k => sameNum(k.value, first));
              if (isConst){
                pickSpeedPercent(first);
              } else if (!speedKeys || !speedKeys.length) {
                speedKeys = parsed;
              }
            }
          }
        }
      }
    }
  }

  // Nothing found
  if (speedPercent == null && !speedKeys && !transform) return null;

  if (speedKeys && speedKeys.length) {
    speedPercent = null;
  }

  const out = {};
  if (speedPercent != null){
    out.speed = speedPercent;
    out.speedFactor = speedPercent;
    out.speedComment = `${speedPercent}%`;
    out.speedSummary = `${speedPercent}%`;
  }
  if (speedKeys){
    out.speedKeys = speedKeys;
    out.speedComment = out.speedComment || 'DYNAMIC';
    out.speedSummary = out.speedSummary || 'DYNAMIC';
  }

  if (transform){
    out.transform = transform;
    const parts = [];
    if (transform.position) parts.push(`POS ${transform.position[0]},${transform.position[1]}`);
    if (transform.scale != null) parts.push(`SCALE ${transform.scale}`);
    if (transform.rotation != null) parts.push(`ROT ${transform.rotation}`);
    out.transformComment = parts.join(' | ') || 'TRANSFORM';
    out.transformSummary = out.transformComment;
  }

  return out;
}

// --------------------------------------
// การ parse หลัก
// --------------------------------------
export function parseXMEML(xmlText) {
  const safe = sanitizeXML(xmlText);

  let doc;
  try {
    const parser = new DOMParser();
    doc = parser.parseFromString(safe, "application/xml");
  } catch (err) {
    throw new Error("Unable to parse XML.");
  }

  const perr = doc.querySelector && doc.querySelector("parsererror");
  if (perr) {
    const msg = perr.textContent
      ? perr.textContent.trim().slice(0, 200)
      : "XML parser error";
    throw new Error(msg);
  }

  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "xmeml") {
    return { events: [], fps: 24, fpsExact: 24, projectName: "—" };
  }

  const sequences = root.getElementsByTagName("sequence");
  if (!sequences || !sequences.length) {
    return { events: [], fps: 24, fpsExact: 24, projectName: "—" };
  }
  const seq = sequences[0];

  const projectName = extractProjectName(root, seq);

  const rateNode = seq.getElementsByTagName("rate")[0] || null;
  // fps = integer tcBase for all internal TC math; playbackFps = actual playback rate
  const { tcBase: fps, isNtsc, playbackFps } = parseRateInfo(rateNode);

  // base timeline TC
  // IMPORTANT:
  // XMEML contains many <timecode> blocks (files, clipitems, sequences, etc).
  // We must read the *direct child* <sequence><timecode> as the timeline (record) start.
  // If missing, fall back to Premiere's MZ.ZeroPoint (Adobe ticks).
  // WARNING: do NOT use seq.getElementsByTagName("timecode")[0] as a fallback —
  // that returns the first <timecode> anywhere in the subtree (e.g. a file's source TC).
  let seqBaseFrames = null;

  let seqTcNode = null;
  const seqKids = seq.childNodes || [];
  for (let k = 0; k < seqKids.length; k++) {
    const ch = seqKids[k];
    if (ch && ch.nodeType === 1 && ch.nodeName === "timecode") {
      seqTcNode = ch;
      break;
    }
  }

  let seqDisplayFormat = "NDF";
  if (seqTcNode) {
    seqDisplayFormat = getText(seqTcNode, "displayformat", "NDF") || "NDF";
    const tcStr = getText(seqTcNode, "string", "");
    if (tcStr) {
      seqBaseFrames = tcToFrames(tcStr.replace(/;/g, ":"), fps);
    } else {
      const fStr = getText(seqTcNode, "frame", "");
      if (fStr !== "") seqBaseFrames = toInt(fStr, 0);
    }
  }

  // Premiere / Adobe ticks: MZ.ZeroPoint is "ticks" at 254016000000 ticks/sec.
  // For NTSC rates (ntsc=TRUE): ticks_per_frame = TICKS_PER_SECOND * 1001 / (fps * 1000)
  // For integer rates: ticks_per_frame = TICKS_PER_SECOND / fps
  if (seqBaseFrames == null) {
    const zp = seq.getAttribute ? seq.getAttribute("MZ.ZeroPoint") : null;
    if (zp) {
      const ticks = Number(zp);
      const TICKS_PER_SECOND = 254016000000;
      if (Number.isFinite(ticks) && ticks >= 0) {
        const ticksPerFrame = isNtsc
          ? TICKS_PER_SECOND * 1001 / (fps * 1000)
          : TICKS_PER_SECOND / fps;
        seqBaseFrames = Math.round(ticks / ticksPerFrame);
      }
    }
  }

  if (seqBaseFrames == null) seqBaseFrames = 0;

  const events = [];

  // ---------------------------------------------------------------------------
  // Resolve <file id="..."/> stubs
  //
  // Premiere / Resolve XMEML often references a file via:
  //   <file id="file-5"/>
  // while the full definition exists elsewhere:
  //   <file id="file-5"> ... <name>...</name> <timecode>...</timecode> ...
  //
  // If we don't resolve the stub, we lose:
  //   - fileName / pathurl
  //   - source timecode start
  // which causes srcIn/srcOut to appear as 00:00:xx:yy.
  // ---------------------------------------------------------------------------
  const fileDefById = new Map();
  try {
    const allFiles = root.getElementsByTagName("file") || [];
    for (let i = 0; i < allFiles.length; i++) {
      const f = allFiles[i];
      const id = f && f.getAttribute ? f.getAttribute("id") : null;
      if (!id) continue;

      // Only index "real" definitions (have name/pathurl/timecode)
      const hasName = !!getText(f, "name", "");
      const hasPath = !!getText(f, "pathurl", "");
      const hasTC   = !!(f.getElementsByTagName && f.getElementsByTagName("timecode") && f.getElementsByTagName("timecode").length);
      if (hasName || hasPath || hasTC) {
        fileDefById.set(id, f);
      }
    }
  } catch (e) {}

  function resolveFileNode(fileNode) {
    if (!fileNode) return null;
    const id = fileNode.getAttribute ? fileNode.getAttribute("id") : null;
    if (!id) return fileNode;

    // If this <file> node is just a stub (no children / no useful fields), replace with the indexed definition.
    const hasName = !!getText(fileNode, "name", "");
    const hasPath = !!getText(fileNode, "pathurl", "");
    const hasTC   = !!(fileNode.getElementsByTagName && fileNode.getElementsByTagName("timecode") && fileNode.getElementsByTagName("timecode").length);
    if (!hasName && !hasPath && !hasTC) {
      const def = fileDefById.get(id);
      if (def) return def;
    }
    return fileNode;
  }

  const sequenceDefById = new Map();
  const sequenceDefs = [];
  const sequenceDefByName = new Map();
  try {
    const allSeq = root.getElementsByTagName("sequence") || [];
    for (let i = 0; i < allSeq.length; i++) {
      const s = allSeq[i];
      if (!s || !s.getAttribute) continue;
      const id = s.getAttribute("id") || "";
      if (id) sequenceDefById.set(id, s);
      sequenceDefs.push(s);
      const nm = getText(s, "name", "").trim();
      if (nm) {
        const key = String(nm).trim().toLowerCase();
        if (key && !sequenceDefByName.has(key)) sequenceDefByName.set(key, s);
      }
    }
  } catch (e) {}

  function sequenceHasVideo(seqNode) {
    if (!seqNode || !seqNode.getElementsByTagName) return false;
    const media = firstDirectChild(seqNode, "media") || seqNode.getElementsByTagName("media")[0] || null;
    const video = media ? (media.getElementsByTagName("video")[0] || null) : null;
    const tracks = video ? video.getElementsByTagName("track") : [];
    return !!(tracks && tracks.length);
  }

  function normalizeSequenceLookupKey(name = "") {
    return String(name || "")
      .replace(/\.[^.]+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function resolveSequenceNode(seqNode, hintName = "", excludeNode = null) {
    let candidate = seqNode || null;
    if (candidate) {
      const sid = candidate.getAttribute ? (candidate.getAttribute("id") || "") : "";
      const hasDirectVideo = sequenceHasVideo(candidate);
      if (!hasDirectVideo && sid && sequenceDefById.has(sid)) {
        candidate = sequenceDefById.get(sid) || candidate;
      }
      if (candidate && candidate !== excludeNode && sequenceHasVideo(candidate)) return candidate;
    }

    const key = normalizeSequenceLookupKey(hintName);
    if (!key) return null;

    const exact = sequenceDefByName.get(key);
    if (exact && exact !== excludeNode && sequenceHasVideo(exact)) return exact;

    for (const seqDef of sequenceDefs) {
      if (!seqDef || seqDef === excludeNode || !sequenceHasVideo(seqDef)) continue;
      const nm = normalizeSequenceLookupKey(getText(seqDef, "name", ""));
      if (!nm) continue;
      if (nm === key) return seqDef;
      if (nm.includes(key) || key.includes(nm)) return seqDef;
    }
    return null;
  }

  // --- Nested / Compound flatten (unlimited depth)
  // XMEML nests are commonly represented as a clipitem without a direct <file>,
  // or as a <file> that contains a <sequence>.
  // We auto-flatten on import (Option A1/1): recursively walk any child <sequence>
  // and emit real leaf clip events with correct record offsets and track stacking.
  const MAX_NEST_GUARD = 2000; // hard guard against malformed cyclic XML
  let _nestCount = 0;

  function firstDirectChild(el, tag) {
    const kids = el ? (el.childNodes || []) : [];
    for (let i = 0; i < kids.length; i++) {
      const ch = kids[i];
      if (ch && ch.nodeType === 1 && ch.nodeName === tag) return ch;
    }
    return null;
  }

  function parseSequenceVideo(seqEl, seqBaseAbsFrames, trackBaseIndex) {
    if (!seqEl) return;
    if (_nestCount++ > MAX_NEST_GUARD) return;

    const mediaNode2 = firstDirectChild(seqEl, "media") || (seqEl.getElementsByTagName("media")[0] || null);
    const videoNode2 = mediaNode2 ? (mediaNode2.getElementsByTagName("video")[0] || null) : null;
    const tracks2 = videoNode2 ? videoNode2.getElementsByTagName("track") : [];

    for (let ti2 = 0; ti2 < tracks2.length; ti2++) {
      const tr2 = tracks2[ti2];

      // direct clipitems only
      const clipitems2 = [];
      const kids2 = tr2.childNodes || [];
      for (let k = 0; k < kids2.length; k++) {
        const ch = kids2[k];
        if (ch && ch.nodeType === 1 && ch.nodeName === "clipitem") clipitems2.push(ch);
      }

      for (let ci2 = 0; ci2 < clipitems2.length; ci2++) {
        const clipitem2 = clipitems2[ci2];

        const enabledText2 = getText(clipitem2, "enabled", "TRUE").trim().toUpperCase();
        const isEnabled2 = !(enabledText2 === "FALSE" || enabledText2 === "0");

        const clipName2 = getText(clipitem2, "name", "CLIP");

        // direct <file> (may be a stub: <file id="..."/>)
        const fileNode2 = resolveFileNode(firstDirectChild(clipitem2, "file"));
        const fileName2 = fileNode2 ? getText(fileNode2, "name", "") : "";
        const pathUrl2  = fileNode2 ? getText(fileNode2, "pathurl", "") : "";
        const tape2     = getText(clipitem2, "tape", "");

        // nested sequence may appear either directly under clipitem, or under file
        const nestedSeq2 = resolveSequenceNode(
          firstDirectChild(clipitem2, "sequence") || (fileNode2 ? firstDirectChild(fileNode2, "sequence") : null),
          clipName2 || fileName2,
          seqEl
        ) || resolveSequenceNode(null, clipName2 || fileName2, seqEl);
        if (nestedSeq2) {
          // nested content stacks upward relative to the parent track
          const parentRecStart2 = toInt(getText(clipitem2, "start", "0"), 0);
          const nestedBaseAbs = seqBaseAbsFrames + Math.max(0, parentRecStart2);
          parseSequenceVideo(nestedSeq2, nestedBaseAbs, trackBaseIndex + ti2);
          continue;
        }

        // leaf clip (same extraction logic as main parser)
        const srcInfo2 = pickSourceFromNames({ fileName: fileName2, clipName: clipName2, pathUrl: pathUrl2, tape: tape2 });
        const srcFile2 = srcInfo2.srcFile;
        const reel2    = srcInfo2.reel;
        const isOCF2   = srcInfo2.isOCF;

        const clipRateNode2 = fileNode2 ? fileNode2.getElementsByTagName("rate")[0] : null;
        const clipFps2 = clipRateNode2 ? extractFPS(clipRateNode2) : fps;

        const srcInFrames2   = Math.max(0, toInt(getText(clipitem2, "in",  "0"), 0));
        const _srcOutRaw2    = toInt(getText(clipitem2, "out", "0"), 0);

        let recStartFrames2 = toInt(getText(clipitem2, "start", "0"), 0);
        let recEndFrames2   = toInt(getText(clipitem2, "end",   "0"), 0);

        const clipDurFrames2 = Math.max(0, _srcOutRaw2 - srcInFrames2);
        if (recStartFrames2 < 0 && recEndFrames2 >= 0 && clipDurFrames2 > 0) recStartFrames2 = recEndFrames2 - clipDurFrames2;
        else if (recEndFrames2 < 0 && recStartFrames2 >= 0 && clipDurFrames2 > 0) recEndFrames2 = recStartFrames2 + clipDurFrames2;
        if (recStartFrames2 < 0 || recEndFrames2 <= recStartFrames2) continue;
        const srcOutFrames2 = _srcOutRaw2 < 0
          ? srcInFrames2 + Math.max(0, recEndFrames2 - recStartFrames2)
          : _srcOutRaw2;

        // source tc start
        let tcStartFrames2 = 0;
        let tcNode2 = fileNode2 ? fileNode2.getElementsByTagName("timecode")[0] : null;
        if (!tcNode2) tcNode2 = clipitem2.getElementsByTagName("timecode")[0] || null;
        if (tcNode2) {
          const tcString2 = getText(tcNode2, "string", "");
          if (tcString2) tcStartFrames2 = tcToFrames(tcString2, clipFps2);
          else tcStartFrames2 = toInt(getText(tcNode2, "frame", ""), 0);
        }

        const srcInTC2  = framesToTC(tcStartFrames2 + srcInFrames2,  clipFps2);
        const srcOutTC2 = framesToTC(tcStartFrames2 + srcOutFrames2, clipFps2);

        const recInAbs2  = seqBaseAbsFrames + recStartFrames2;
        const recOutAbs2 = seqBaseAbsFrames + recEndFrames2;
        const recInTC2  = framesToTC(recInAbs2,  fps);
        const recOutTC2 = framesToTC(recOutAbs2, fps);

        let resolveMarkers2 = [];
        if (isOCF2) {
          resolveMarkers2 = extractResolveMarkers(clipitem2, fps, recInAbs2);
        }

        const fx2 = extractFxFromClipitem(clipitem2);

        events.push({
          id: events.length,
          sourceType: "xml",
          type: "video",
          trackIndex: trackBaseIndex + ti2,
          clipIndex: ci2,
          role: `V${(trackBaseIndex + ti2) + 1}`,
          clipName: clipName2,
          srcFile: srcFile2,
          reel: reel2,
          srcIn:  srcInTC2,
          srcOut: srcOutTC2,
          recIn:  recInTC2,
          recOut: recOutTC2,
          _srcInFrames:   srcInFrames2,
          _srcOutFrames:  srcOutFrames2,
          _recInFrames:   recStartFrames2,
          _recOutFrames:  recEndFrames2,
          _tcStartFrames: tcStartFrames2,
          _seqBaseFrames: seqBaseAbsFrames,
          fps,
          clipFps: clipFps2,
          isOCF: isOCF2,
          kind: "clip",
          disabled: !isEnabled2,
          _pathUrl: pathUrl2 || "",
          _fileNameOriginal: fileName2 || "",
          markers: resolveMarkers2,
          _markers: resolveMarkers2,
          metadata: resolveMarkers2.length ? { markers: resolveMarkers2 } : {},
          ...(fx2 || {})
        });
      }
    }
  }

  const mediaNode = seq.getElementsByTagName("media")[0] || null;
  const videoNode = mediaNode ? mediaNode.getElementsByTagName("video")[0] : null;
  const tracks    = videoNode ? videoNode.getElementsByTagName("track") : [];

  for (let ti = 0; ti < tracks.length; ti++) {
    const track = tracks[ti];
    // IMPORTANT:
    // Only take *direct* clipitems under this track.
    // Using getElementsByTagName() would also capture nested clipitems inside a nested sequence,
    // which can introduce invalid start/end values (e.g. -1) and duplicate events.
    const clipitems = [];
    const transitionItems = [];
    const tKids = track.childNodes || [];
    for (let k = 0; k < tKids.length; k++) {
      const ch = tKids[k];
      if (!ch || ch.nodeType !== 1) continue;
      if (ch.nodeName === "clipitem") clipitems.push(ch);
      if (ch.nodeName === "transitionclipitem") transitionItems.push(ch);
    }

    // Build transition lookup: recStart → { token, dur }
    const trByEnd = new Map();   // outgoing: keyed by transition end frame (≈ clip end)
    const trByStart = new Map(); // incoming: keyed by transition start frame (≈ clip start)
    for (const tri of transitionItems) {
      const trStart  = toInt(getText(tri, "start", "0"), 0);
      const trEnd    = toInt(getText(tri, "end",   "0"), 0);
      const trDur    = Math.max(0, trEnd - trStart);
      if (trDur <= 0) continue;
      const tEffect  = tri.getElementsByTagName("effect")[0];
      const trName   = (tEffect ? getText(tEffect, "name",  "") : "").toLowerCase();
      const trAlign  = getText(tri, "alignment", "").toLowerCase();
      let token;
      if (/fadein|fade.in|start.black/i.test(trName + trAlign)) token = `FI${trDur}`;
      else if (/fadeout|fade.out|end.black/i.test(trName + trAlign)) token = `FO${trDur}`;
      else token = `D${trDur}`;
      trByEnd.set(trEnd,   token);
      trByStart.set(trStart, token.startsWith('D') ? token : null);  // incoming side of a dissolve
    }

    for (let ciIndex = 0; ciIndex < clipitems.length; ciIndex++) {
      const clipitem = clipitems[ciIndex];

      const enabledText = getText(clipitem, "enabled", "TRUE").trim().toUpperCase();
      const isEnabled = !(enabledText === "FALSE" || enabledText === "0");

      const clipName = getText(clipitem, "name", "CLIP");

      // หา <file> เฉพาะ "ลูกตรง" ของ clipitem เท่านั้น
      let fileNode = null;
      const kids = clipitem.childNodes || [];
      for (let k = 0; k < kids.length; k++) {
        const ch = kids[k];
        if (ch.nodeType === 1 && ch.nodeName === "file") {
          fileNode = ch;
          break;
        }
      }

      // Resolve <file id="..."/> stub → full <file> definition (if available)
      fileNode = resolveFileNode(fileNode);

      const fileName = fileNode ? getText(fileNode, "name", "") : "";
      const pathUrl  = fileNode ? getText(fileNode, "pathurl", "") : "";
      const tape     = getText(clipitem, "tape", "");

      const srcInfo = pickSourceFromNames({ fileName, clipName, pathUrl, tape });
      const srcFile = srcInfo.srcFile;
      const reel    = srcInfo.reel;
      const isOCF   = srcInfo.isOCF;

      // classify kind
      let kind = "clip";
      if (!fileNode) {
        // ไม่มี <file> ตรง ๆ แสดงว่าเป็น Nested Sequence / comp
        kind = "nested";
      } else {
        const fileNameLower = String(fileName || "").toLowerCase();
        if (!isOCF || /mps fcpx clip|prores/gi.test(fileNameLower)) {
          kind = "compound";
        }
      }

      const clipRateNode = fileNode ? fileNode.getElementsByTagName("rate")[0] : null;
      const clipFps = clipRateNode ? extractFPS(clipRateNode) : fps;

      // --- Auto-flatten nested/compound (unlimited depth)
      // If this clipitem embeds a <sequence>, expand it now and do not emit the wrapper.
      const nestedSeq = resolveSequenceNode(
        firstDirectChild(clipitem, "sequence") || (fileNode ? firstDirectChild(fileNode, "sequence") : null),
        clipName || fileName,
        seq
      ) || ((kind !== "clip") ? resolveSequenceNode(null, clipName || fileName, seq) : null);
      if (nestedSeq) {
        // Nested content stacks upward relative to this track.
        // Record offset = this clip's start on the parent sequence.
        const parentRecStart = toInt(getText(clipitem, "start", "0"), 0);
        const nestedBaseAbs = seqBaseFrames + Math.max(0, parentRecStart);
        parseSequenceVideo(nestedSeq, nestedBaseAbs, ti);
        continue;
      }

      // XMEML uses -1 to mean "no explicit in/out point" (use full media).
      // Clamp in to 0; defer out resolution until after recEnd is known.
      const srcInFrames   = Math.max(0, toInt(getText(clipitem, "in",  "0"), 0));
      const _srcOutRaw    = toInt(getText(clipitem, "out", "0"), 0);

      let recStartFrames = toInt(getText(clipitem, "start", "0"), 0);
      let recEndFrames   = toInt(getText(clipitem, "end",   "0"), 0);

      // Premiere (and some XMEML exports) can write -1 for start/end around transitions.
      // Example: dissolve clips may have <end>-1</end> for the outgoing clip and
      //          <start>-1</start> for the incoming clip.
      // Recover with duration on timeline = (out - in).
      const clipDurFrames = Math.max(0, _srcOutRaw - srcInFrames);

      if (recStartFrames < 0 || recEndFrames < 0) {
        const _dbg = { clip: clipName, ti, recStartRaw: recStartFrames, recEndRaw: recEndFrames, srcIn: srcInFrames, srcOut: _srcOutRaw, dur: clipDurFrames };
        console.log('[xml.js -1 debug]', JSON.stringify(_dbg));
        // Guard: this parser also runs in Node (tests) where `window` is undefined.
        if (typeof window !== 'undefined') {
          if (!window.__PFX_NEG_DEBUG) window.__PFX_NEG_DEBUG = [];
          window.__PFX_NEG_DEBUG.push(_dbg);
        }
      }

      if (recStartFrames < 0 && recEndFrames >= 0 && clipDurFrames > 0) {
        recStartFrames = recEndFrames - clipDurFrames;
      } else if (recEndFrames < 0 && recStartFrames >= 0 && clipDurFrames > 0) {
        recEndFrames = recStartFrames + clipDurFrames;
      }

      // Rule 5: both -1 — try adjacent transitionclipitems for boundary recovery.
      // A clip sandwiched between two dissolves will have its start set to the preceding
      // transition's <end> and its end set to the following transition's <start>.
      if (recStartFrames < 0 && recEndFrames < 0) {
        if (clipDurFrames > 0) {
          let prevTrEnd = -1, nextTrStart = -1;
          for (let ki = 0; ki < tKids.length; ki++) {
            if (tKids[ki] !== clipitem) continue;
            for (let bi = ki - 1; bi >= 0; bi--) {
              const n = tKids[bi];
              if (n.nodeType === 1 && n.nodeName === "transitionclipitem") {
                prevTrEnd = toInt(getText(n, "end", "-1"), -1);
                break;
              }
            }
            for (let fi = ki + 1; fi < tKids.length; fi++) {
              const n = tKids[fi];
              if (n.nodeType === 1 && n.nodeName === "transitionclipitem") {
                nextTrStart = toInt(getText(n, "start", "-1"), -1);
                break;
              }
            }
            break;
          }
          if (prevTrEnd >= 0 && nextTrStart >= prevTrEnd &&
              Math.abs((nextTrStart - prevTrEnd) - clipDurFrames) <= 2) {
            recStartFrames = prevTrEnd;
            recEndFrames   = nextTrStart;
          } else if (prevTrEnd >= 0) {
            recStartFrames = prevTrEnd;
            recEndFrames   = prevTrEnd + clipDurFrames;
          } else if (nextTrStart >= 0) {
            recEndFrames   = nextTrStart;
            recStartFrames = nextTrStart - clipDurFrames;
          }
        }
        if (recStartFrames < 0 || recEndFrames < 0) continue;
      }

      // Rule 7: skip if still invalid after recovery — never clamp.
      if (recStartFrames < 0 || recEndFrames <= recStartFrames) continue;

      // Resolve XMEML out=-1 ("end of media"): use record duration as source duration.
      const srcOutFrames = _srcOutRaw < 0
        ? srcInFrames + Math.max(0, recEndFrames - recStartFrames)
        : _srcOutRaw;

      // source tc start
      let tcStartFrames = 0;
      let tcNode = fileNode ? fileNode.getElementsByTagName("timecode")[0] : null;
      if (!tcNode) {
        tcNode = clipitem.getElementsByTagName("timecode")[0] || null;
      }
      if (tcNode) {
        const tcString = getText(tcNode, "string", "");
        if (tcString) {
          tcStartFrames = tcToFrames(tcString, clipFps);
        } else {
          const fFrames = getText(tcNode, "frame", "");
          tcStartFrames = toInt(fFrames, 0);
        }
      }

      const srcInTC  = framesToTC(tcStartFrames + srcInFrames,  clipFps);
      const srcOutTC = framesToTC(tcStartFrames + srcOutFrames, clipFps);

      const recInAbsFrames  = seqBaseFrames + recStartFrames;
      const recOutAbsFrames = seqBaseFrames + recEndFrames;
      const recInTC  = framesToTC(recInAbsFrames,  fps);
      const recOutTC = framesToTC(recOutAbsFrames, fps);

      // markers: เฉพาะ OCF clip จริง ๆ
      let resolveMarkers = [];
      if (isOCF && kind === "clip") {
        resolveMarkers = extractResolveMarkers(clipitem, fps, recInAbsFrames);
      }

      const metadata = {};

      // FX (Speed/Transform)
      const fx = extractFxFromClipitem(clipitem);
      if (resolveMarkers.length) {
        metadata.markers = resolveMarkers;
      }

      // Transition detection: check if a transitionclipitem borders this clip
      // Outgoing: transition ends at recEndFrames
      // Incoming: transition starts at recStartFrames (only for dissolves)
      let transitionToken = trByEnd.get(recEndFrames) || null;
      if (!transitionToken) {
        const incomingToken = trByStart.get(recStartFrames);
        if (incomingToken) transitionToken = incomingToken;
      }

      // Enrich transform with animation flag when keyframes vary
      if (fx?.transform) {
        const tf = fx.transform;
        const hasAnimScale = Array.isArray(tf.scaleKeys)    && tf.scaleKeys.length    > 1;
        const hasAnimRot   = Array.isArray(tf.rotationKeys) && tf.rotationKeys.length > 1;
        const hasAnimPos   = Array.isArray(tf.positionKeys) && tf.positionKeys.length > 1;
        if (hasAnimScale || hasAnimRot || hasAnimPos) {
          tf.animated = true;
          const labels = [];
          if (hasAnimScale) labels.push('Scale↗');
          if (hasAnimRot)   labels.push('Rot↗');
          if (hasAnimPos)   labels.push('Pos↗');
          fx.transformSummary = (fx.transformSummary ? fx.transformSummary + ' ' : '') + labels.join('+');
        }
      }

      events.push({
        id: events.length,

        sourceType: "xml",
        type: "video",
        trackIndex: ti,
        clipIndex: ciIndex,
        role: `V${ti + 1}`,

        clipName,
        srcFile,
        reel,

        srcIn:  srcInTC,
        srcOut: srcOutTC,
        recIn:  recInTC,
        recOut: recOutTC,

        _srcInFrames:    srcInFrames,
        _srcOutFrames:   srcOutFrames,
        _recInFrames:    recStartFrames,
        _recOutFrames:   recEndFrames,
        _tcStartFrames:  tcStartFrames,
        _seqBaseFrames:  seqBaseFrames,

        fps,
        clipFps,

        isOCF,
        kind,               // "clip" | "nested" | "compound"
        disabled: !isEnabled,

        _pathUrl: pathUrl || "",
        _fileNameOriginal: fileName || "",

        markers: resolveMarkers,
        _markers: resolveMarkers,
        metadata,

        // Transition token from transitionclipitem (if present)
        ...(transitionToken ? { transition: transitionToken } : {}),

        // FX fields (if present)
        ...(fx || {})
      });
    }
  }

  // normalize: ตัด event ที่ srcIn == "00:00:00:00" ถ้า srcFile เดียวกันมีทั้ง 00:00:00:00 และ non-zero
  const ZERO_TC = "00:00:00:00";
  const bySrc = new Map();

  for (const ev of events) {
    const key = ev.srcFile || ev.reel || ev.clipName || "";
    if (!bySrc.has(key)) bySrc.set(key, []);
    bySrc.get(key).push(ev);
  }

  const normalizedEvents = [];
  for (const [, group] of bySrc.entries()) {
    const hasNonZero = group.some(ev => (ev.srcIn && ev.srcIn !== ZERO_TC));
    if (!hasNonZero) {
      normalizedEvents.push(...group);
    } else {
      for (const ev of group) {
        if (ev.srcIn !== ZERO_TC) normalizedEvents.push(ev);
      }
    }
  }

  normalizedEvents
    .sort((a, b) => {
      const af = tcToFrames(a.recIn || ZERO_TC, a.fps || fps);
      const bf = tcToFrames(b.recIn || ZERO_TC, b.fps || fps);
      return af - bf;
    })
    .forEach((ev, idx) => { ev.id = idx; });

  console.log(
    `[XMEML] sequenceName=${projectName}`,
    `timebase=${fps} ntsc=${isNtsc}`,
    `detectedFrameRate=${Math.round(playbackFps * 1000000) / 1000000}`,
    `timecodeBase=${fps}`,
    `displayFormat=${seqDisplayFormat}`,
    `sequenceStartTC=${framesToTC(seqBaseFrames, fps)}`,
    `sequenceStartFrame=${seqBaseFrames}`,
    `durationFrames=${normalizedEvents.length > 0
      ? Math.max(...normalizedEvents.map(e => tcToFrames(e.recOut || '00:00:00:00', fps))) - seqBaseFrames
      : 0}`
  );

  // `fps` is the WHOLE-FRAME timecode base and `fpsExact` is the true playback
  // rate — the same contract every parser in this directory now exports.
  //
  // This boundary used to hand out the playback rate as `fps`, alone among the
  // parsers. Downstream code cannot tell which kind of rate it was given, so
  // each consumer guessed: `trlconf` fed it straight into tcToFrames and ran
  // whole NTSC conforms on fractional frame counts (86313.686 frames for
  // 01:00:00:00 instead of 86400), while `prep_mark` learned to reach past it
  // for `timecodeBase`. The events this very function emits are stamped
  // `fps: 24` — the header disagreed with its own rows.
  //
  // `timecodeBase` is kept as an alias: it is the same number as `fps` now, and
  // removing it would break the one consumer that did the right thing.
  return {
    events: normalizedEvents,
    fps,                       // whole-frame timecode base (e.g. 24 for ntsc 24)
    fpsExact: playbackFps,     // true playback rate (e.g. 23.976023976…)
    timecodeBase: fps,         // alias of `fps`, retained for existing callers
    isNtsc,
    dropFrame: false,          // XMEML NDF sequences
    displayFormat: seqDisplayFormat,
    projectName,
    sourceType: "xml"
  };
}

export default { parseXMEML };
