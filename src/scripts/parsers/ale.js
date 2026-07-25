// modules/parser_ale.js
// -----------------------------------------------------------------------------
// ALE (Avid Log Exchange) parser for PostFlowX
// - รองรับรูปแบบ Heading / Column / Data (เช่น demo_ale_day005.ale)
// - Header จริงมาจากบรรทัดหลังคำว่า "Column"
// - Timecode: HH:MM:SS:FF, HH:MM:SS:FFFFF และ drop-frame HH;MM;SS;FF
// - Reel name ใช้จาก Tape name ก่อน แล้วค่อย fallback เป็น filename stem
// -----------------------------------------------------------------------------

/**
 * Normalise one ALE timecode field to "HH:MM:SS:FF", or null if it is not a
 * timecode at all.
 *
 * Separators may be ':' or ';' in any position. NTSC drop-frame uses ';', and
 * Avid most often writes the mixed form "HH:MM:SS;FF" — semicolon on the last
 * separator only. Both are accepted and normalised to colons, after which the
 * value is treated as non-drop. That is the convention every other timecode
 * reader in this codebase already follows (utils_time.js::tcToFrames, which
 * says so in as many words; xml.js:652; edl.js's /[:;]/ field regex), and
 * matching it is the point: ale.js was the only parser here that did not.
 *
 * Rejecting ';' was not a harmless gap. All four timecode fields of a
 * drop-frame row failed together, buildEventFromRow's "no usable timecode"
 * guard returned null, and the row vanished — so a 29.97 DF ALE imported as an
 * empty timeline. Neither call site in ui.js reports an empty parse: the import
 * loop treats it as "not this file" and the match-back modal `continue`s past
 * it. There was no error, no warning, and no console line.
 *
 * A trailing subframe (".5") is stripped, as tcToFrames does for DaVinci
 * Resolve 21 exports.
 */
function parseTC(tc) {
  if (!tc || typeof tc !== "string") return null;
  const s = tc.trim();
  const m = s.match(/^(\d+)[:;](\d+)[:;](\d+)[:;](\d+)(?:\.\d+)?$/);
  if (!m) return null;
  const [, h, m2, s2, f] = m;
  // No modulo on the frame field. `ffInt % 100` silently rewrote the
  // HH:MM:SS:FFFFF form this file's own header claims to accept — 00120 frames
  // came back as 20 — which is wrong and looks right. Whatever a five-digit
  // frame field means, it is not "the last two digits of itself"; the value is
  // passed through for tcToFrames to turn into a frame count.
  const pad2 = (v) => String(parseInt(v, 10) || 0).padStart(2, "0");
  return `${pad2(h)}:${pad2(m2)}:${pad2(s2)}:${pad2(f)}`;
}

// Written twice before this: once here-by-way-of detectFPSFromHeading and once
// in parseALE's empty-input return. A mutation sweep changed one and every test
// still passed, which is the only warning two copies of a constant ever give.
const DEFAULT_FPS = 24;

function detectFPSFromHeading(headingLines) {
  let fps = DEFAULT_FPS;
  for (const line of headingLines) {
    const trimmed = line.trim();
    if (/^FPS\b/i.test(trimmed)) {
      // Standard Avid ALE uses tab-separated "FPS\t24"; some exports use "FPS: 24"
      const afterKey = trimmed.slice(3).replace(/^[\s:\t]+/, '');
      const num = parseFloat(afterKey);
      if (!Number.isNaN(num) && num > 0) fps = num;
    }
  }
  return fps;
}

// Camera-original naming heuristic (avoid false positives from generic .mov assets)
const __PFX_OCF_RE1 = /^[A-Za-z]_\d{4}C\d{3}_\d{6}_\d{6}/i;
const __PFX_OCF_RE2 = /^[A-Za-z]\d{3}C\d{3}[_-]/i;

function __pfxLooksLikeCameraStem(stem = "") {
  const s = String(stem || "").trim();
  if (!s) return false;
  if (/^(nested sequence|sequence|mps fcpx clip)/i.test(s)) return false;
  if (__PFX_OCF_RE1.test(s)) return true;
  if (__PFX_OCF_RE2.test(s)) return true;
  return false;
}

function isOCFByExt(filename) {
  if (!filename) return false;
  const base0 = String(filename).split(/[\\/]/).pop() || "";
  const base = base0.replace(/\s+-\s+v\d+$/i, "").trim();
  const lower = base.toLowerCase();

  // Strong camera-original formats
  if (lower.endsWith('.r3d') || lower.endsWith('.braw')) return true;
  if (lower.endsWith('.mxf')) return true;
  if (lower.endsWith('.dpx') || lower.endsWith('.exr')) return true;

  // Generic containers: require camera-like naming
  const generic = ['.mov', '.mp4', '.m2t', '.m2ts', '.mkv', '.mjpeg', '.avi'];
  for (const ext of generic) {
    if (lower.endsWith(ext)) {
      const stem = base.replace(/\.[^\.\/\\]+$/, '');
      return __pfxLooksLikeCameraStem(stem);
    }
  }

  // Audio / others are not camera originals
  return false;
}

function getStem(pathOrName) {
  if (!pathOrName) return "";
  const s = String(pathOrName);
  const lastSlash = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  const basename = lastSlash >= 0 ? s.slice(lastSlash + 1) : s;
  const dotIdx = basename.lastIndexOf(".");
  if (dotIdx > 0) return basename.slice(0, dotIdx);
  return basename;
}

function buildEventFromRow(row, headerMap, defaults) {
  const get = (keys) => {
    for (const key of keys) {
      const idx = headerMap[key];
      if (idx != null && idx < row.length) {
        const v = String(row[idx] || "").trim();
        if (v) return v;
      }
    }
    return "";
  };

  const clipName = get(["name", "clip name", "clip"]);

  const srcInStr  = get([
    "source in", "src in",
    "start", "start tc", "start timecode", "tc in"
  ]);
  const srcOutStr = get([
    "source out", "src out",
    "end", "end tc", "end timecode", "tc out"
  ]);

  const recInStr  = get(["record in", "rec in", "master in"]);
  const recOutStr = get(["record out", "rec out", "master out"]);

  const tapeStr   = get(["tape", "soundroll", "reel"]);
  const srcFile   = get(["filepath", "path", "source file name", "source file", "file", "filename"]);
  const comment   = get(["comment", "comments", "descript", "notes"]);

  let srcIn  = parseTC(srcInStr);
  let srcOut = parseTC(srcOutStr);
  let recIn  = parseTC(recInStr);
  let recOut = parseTC(recOutStr);

  if (!srcIn && recIn)   srcIn  = recIn;
  if (!srcOut && recOut) srcOut = recOut;
  if (!recIn && srcIn)   recIn  = srcIn;
  if (!recOut && srcOut) recOut = srcOut;

  if (!srcIn && !srcOut && !recIn && !recOut) return null;

  const srcStem = getStem(srcFile);
  // 🔹 ใช้ Tape เป็น Reel ก่อน ถ้าไม่มี Tape ค่อยใช้ชื่อไฟล์
  const reel = tapeStr || srcStem || "";

  const isOCF = isOCFByExt(srcFile);

  return {
    sourceType: "ale",
    type: "video",
    trackIndex: 0,
    clipName: clipName || srcStem || reel || "UNNAMED",
    reel,
    srcFile: srcFile || "",
    isOCF,
    srcIn,
    srcOut,
    recIn,
    recOut,
    fps: defaults.fps,
    comment,
    disabled: false,
    role: "V1",
    markers:  [],
    _markers: [],
    fx: {},
    grade: {}
  };
}

export function parseALE(text, filename = "ALE_Import") {
  if (!text || typeof text !== "string") {
    return { projectName: getStem(filename) || "ALE_Import", fps: DEFAULT_FPS, events: [] };
  }

  const lines = text.split(/\r\n|\n|\r/);

  const headingLines = [];
  const dataLines = [];
  let columnsLine = null;
  let headerAfterColumn = null;
  let seenColumn = false;
  let inData = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\uFEFF/g, "");
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^Heading\b/i.test(trimmed)) {
      continue;
    }

    if (/^Column\b/i.test(trimmed)) {
      seenColumn = true;
      continue;
    }

    if (/^Data\b/i.test(trimmed)) {
      inData = true;
      seenColumn = false;
      continue;
    }

    if (inData) {
      dataLines.push(line);
    } else if (seenColumn && !headerAfterColumn) {
      headerAfterColumn = line;
    } else {
      headingLines.push(line);
    }
  }

  const fps = detectFPSFromHeading(headingLines);

  if (headerAfterColumn) {
    columnsLine = headerAfterColumn;
  }

  if (!columnsLine && dataLines.length) {
    columnsLine = dataLines.shift();
  }

  if (!columnsLine) {
    return { projectName: getStem(filename) || "ALE_Import", fps, events: [] };
  }

  // Use tab delimiter if the line contains tabs (standard Avid ALE format).
  // Falling back to comma on a tab-delimited file would split field values that
  // happen to contain commas (e.g. "Scene, Take" → two columns).
  const delim = columnsLine.includes('\t') ? '\t' : ',';
  const rawCols = columnsLine.split(delim);
  const headers = rawCols.map(h => h.trim());
  const headerMap = {};
  headers.forEach((h, idx) => {
    const key = h.toLowerCase();
    headerMap[key] = idx;
  });

  const defaults = { fps };
  const events = [];

  for (const dl of dataLines) {
    const row = dl.split(delim);
    if (!row.length) continue;
    const ev = buildEventFromRow(row, headerMap, defaults);
    if (!ev) continue;
    events.push(ev);
  }

  const projStem = getStem(filename) || "ALE_Import";

  return {
    projectName: projStem,
    fps,
    events,
    sourceType: "ale"
  };
}
