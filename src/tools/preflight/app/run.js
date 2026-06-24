
import { analyzeFiles } from "./validators.js";

function nowISO(){ return new Date().toISOString(); }

async function readBytes(file, start, length){
  const blob = file.slice(start, start + length);
  const buf = await blob.arrayBuffer();
  return new DataView(buf);
}

// Minimal WAV header parser (PCM/BWAV) — just enough for smart auto-assign.
async function parseWavHeader(file){
  const dv = await readBytes(file, 0, Math.min(4096, file.size));
  const riff = String.fromCharCode(dv.getUint8(0),dv.getUint8(1),dv.getUint8(2),dv.getUint8(3));
  const wave = String.fromCharCode(dv.getUint8(8),dv.getUint8(9),dv.getUint8(10),dv.getUint8(11));
  if (riff !== "RIFF" || wave !== "WAVE") return { ok:false, reason:"not_wav" };

  // Walk chunks to find "fmt "
  let offset = 12;
  let fmt = null;
  while (offset + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(offset),dv.getUint8(offset+1),dv.getUint8(offset+2),dv.getUint8(offset+3));
    const size = dv.getUint32(offset+4, true);
    if (id === "fmt ") {
      const audioFormat = dv.getUint16(offset+8, true);
      const channels = dv.getUint16(offset+10, true);
      const sampleRate = dv.getUint32(offset+12, true);
      fmt = { audioFormat, channels, sampleRate };
      break;
    }
    // RIFF spec: odd-sized chunks have a silent pad byte that must be skipped.
    offset += 8 + size + (size & 1);
  }
  if (!fmt) return { ok:false, reason:"no_fmt" };
  return { ok:true, ...fmt };
}

async function mapLimit(items, limit, fn){
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.max(1, limit)).fill(0).map(async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function buildRun(config, settings, files, prevRun){
  const profile = settings.profile || "final_delivery";
  const reqIdsAll = config.profiles[profile]?.requirements || [];

  // Scope filter: only run checks for selected categories (vendor-by-vendor workflow).
  const selectedCats = Array.isArray(settings.selectedCategories) ? settings.selectedCategories : null;
  const catSet = selectedCats ? new Set(selectedCats) : null;
  const reqIds = catSet ? reqIdsAll.filter(id => catSet.has(config.requirements[id]?.category)) : reqIdsAll;

  // Series episode expansion
  const _isSeries = settings.projectType === 'series' && parseInt(settings.episodeCount, 10) > 1;
  const _epCount  = _isSeries ? Math.max(1, parseInt(settings.episodeCount, 10) || 18) : 1;
  const _epPad    = (n) => String(n).padStart(2, '0');
  const _baseId   = (id) => id.replace(/_EP\d+$/, '');
  const _epNum    = (id) => { const m = id.match(/_EP(\d+)$/); return m ? parseInt(m[1], 10) : null; };
  const _detectEp = (path) => {
    const s = String(path || '');
    const m = s.match(/[_\-\/\s][Ee][Pp]?0*(\d{1,3})[_\-\/\s\.]/)
            || s.match(/[Ee]pisode[\s_\-]?0*(\d{1,3})/i)
            || s.match(/[Ee]0*(\d{2,3})[_\-\/\.]/);
    return m ? parseInt(m[1], 10) : null;
  };
  const expandedReqIds = _isSeries
    ? reqIds.flatMap(id => Array.from({ length: _epCount }, (_, i) => `${id}_EP${_epPad(i + 1)}`))
    : reqIds;

  const reqList = expandedReqIds.map(id => {
    const baseId = _isSeries ? _baseId(id) : id;
    const req = config.requirements[baseId];
    if (!req) return null;
    const epNum = _epNum(id);
    return { id, ...req, ...(epNum !== null ? { epNum } : {}) };
  }).filter(Boolean);

  // Build assignments (auto bucket + allow overrides from draftAssignments)
  const draftAssignments = (prevRun && prevRun.draftAssignments) ? prevRun.draftAssignments : {};
  const disabledSet = new Set((prevRun && prevRun.disabledFileIdxs) ? prevRun.disabledFileIdxs : []);
  const assigned = new Map(); // fileIdx -> reqId

  // Smart auto-assign
  const lower = (s) => (s||"").toLowerCase();
  const fileMeta = files
    .map((f, idx) => {
      if (!f) return null;
      const path = f.__pfxRelPath || f.webkitRelativePath || f.name;
      const parts = String(path || "").split("/");
      const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
      const ext = lower((f.name.split(".").pop() || ""));
      const base = f.name.replace(/\.[^.]+$/, "");
      return {
        idx,
        name: f.name,
        path,
        parts,
        dir,
        ext,
        lowerName: lower(f.name),
        lowerPath: lower(path),
        dirLower: lower(dir),
        baseLower: lower(base),
        size: f.size
      };
    })
    .filter(Boolean)
    .filter(fm => !disabledSet.has(fm.idx));

  const fmByIdx = new Map(fileMeta.map(fm => [fm.idx, fm]));

  const hasReq = (rid) => reqIds.includes(rid);

  // helper to assign if not already assigned or forced by draft
  function forceAssign(idx, reqId){ assigned.set(idx, reqId); }
  function tryAssign(idx, reqId){ if (!assigned.has(idx)) assigned.set(idx, reqId); }

  function isUnderRoot(fm, rootLower){
    if (!rootLower) return true;
    return fm.lowerPath === rootLower || fm.lowerPath.startsWith(rootLower + "/");
  }

  function assignSubtree(rootLower, reqId){
    for (const fm of fileMeta) {
      if (!isUnderRoot(fm, rootLower)) continue;
      tryAssign(fm.idx, reqId);
    }
  }

  // Apply draft overrides first
  for (const [idxStr, reqId] of Object.entries(draftAssignments || {})) {
    const idx = Number(idxStr);
    if (!Number.isNaN(idx) && !disabledSet.has(idx) && expandedReqIds.includes(reqId)) forceAssign(idx, reqId);
  }

  // Directory stats (helps disambiguate stems vs print masters, etc.)
  const dirStats = new Map(); // dirLower -> { wav, mov, exr, dpx, ptx, sesx, fileCount }
  for (const fm of fileMeta) {
    const k = fm.dirLower || "";
    const st = dirStats.get(k) || { wav:0, mov:0, exr:0, dpx:0, ptx:0, sesx:0, fileCount:0 };
    st.fileCount++;
    if (fm.ext === "wav" || fm.ext === "bwf") st.wav++;
    if (fm.ext === "mov" || fm.ext === "mp4" || fm.ext === "mxf") st.mov++;
    if (fm.ext === "exr") st.exr++;
    if (fm.ext === "dpx") st.dpx++;
    if (fm.ext === "ptx") st.ptx++;
    if (fm.ext === "sesx") st.sesx++;
    dirStats.set(k, st);
  }

  // --- Strong signature matchers (folder/package level) ---

  // IMF package detection: find the folder that contains ASSETMAP, then validate signature inside that subtree.
  // This avoids accidentally assigning an entire delivery root when the IMF is nested.
  {
    const assetmapRoots = new Set();
    for (const fm of fileMeta) {
      if (fm.lowerName === "assetmap" || fm.lowerPath.endsWith("/assetmap")) assetmapRoots.add(fm.dirLower || "");
    }

    for (const rootLower of assetmapRoots) {
      let hasPkl = false;
      let mxfCount = 0;
      let anyTextless = false;

      for (const fm of fileMeta) {
        if (!isUnderRoot(fm, rootLower)) continue;
        if (fm.lowerName.includes("pkl")) hasPkl = true;
        if (fm.ext === "mxf") mxfCount++;
        if (fm.lowerPath.includes("textless")) anyTextless = true;
      }

      if (!hasPkl || mxfCount === 0) continue;

      const isTextless = rootLower.includes("textless") || anyTextless;

      let rid = null;
      if (isTextless && hasReq("IMF_DV_TEXTLESS")) rid = "IMF_DV_TEXTLESS";
      else if (hasReq("IMF_DV")) rid = "IMF_DV";
      else if (hasReq("IMF_DV_TEXTLESS")) rid = "IMF_DV_TEXTLESS";

      if (rid) assignSubtree(rootLower, rid);
    }
  }

  // NAM: checksum.txt + EXR/DPX sequence within the same checksum folder.
  if (hasReq("NAM_TEXTLESS")) {
    const checksumRoots = new Set();
    for (const fm of fileMeta) {
      if (fm.lowerName === "checksum.txt" || fm.lowerPath.endsWith("/checksum.txt")) checksumRoots.add(fm.dirLower || "");
    }
    for (const rootLower of checksumRoots) {
      let hasSeq = false;
      for (const fm of fileMeta) {
        if (!isUnderRoot(fm, rootLower)) continue;
        if (fm.ext === "exr" || fm.ext === "dpx") { hasSeq = true; break; }
      }
      if (hasSeq) assignSubtree(rootLower, "NAM_TEXTLESS");
    }
  }

  // Sound editorial / stage mix projects: Pro Tools (.ptx) / Nuendo (.sesx) signature.
  // Assign the whole session folder subtree to SOUND_EDITORIAL_STAGE_PROJECT.
  if (hasReq("SOUND_EDITORIAL_STAGE_PROJECT")) {
    const sessionRoots = new Set();
    for (const fm of fileMeta) {
      if (fm.ext === "ptx" || fm.ext === "sesx") sessionRoots.add(fm.dirLower || "");
    }
    for (const rootLower of sessionRoots) assignSubtree(rootLower, "SOUND_EDITORIAL_STAGE_PROJECT");
  }

  // Sound editorial / stage mix heuristics (folder hints even without PTX/Sesx)
  if (hasReq("SOUND_EDITORIAL_STAGE_PROJECT")) {
    const exts = new Set(["ptx","sesx","aaf","xml","wav","bwf","pt","omf"]);
    const reStage = /(\bprotools\b|\bsesx\b|\bstage[-_ ]?mix\b|\bsound[-_ ]?editorial\b|\bmix[-_ ]?project\b|\bdialog[-_ ]?edit\b|\bsfx[-_ ]?edit\b|\bmusic[-_ ]?edit\b)/i;
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      if (!exts.has(fm.ext)) continue;
      if (reStage.test(fm.lowerPath)) tryAssign(fm.idx, "SOUND_EDITORIAL_STAGE_PROJECT");
    }
  }

  // --- High-precision per-file rules (ordered by specificity) ---

  // Show logo
  if (hasReq("SHOW_LOGO")) {
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      if ((fm.ext === "png" || fm.ext === "svg" || fm.ext === "ai" || fm.ext === "psd") && /(^|[^a-z0-9])logo([^a-z0-9]|$)/i.test(fm.lowerPath)) {
        tryAssign(fm.idx, "SHOW_LOGO");
      }
    }
  }

  // Graphics/Titles projects
  if (hasReq("GRAPHICS_TITLES_PROJECT")) {
    const exts = new Set(["psd","ai","aep","prproj","drp","nk","svg","ttf","otf"]);
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      if (exts.has(fm.ext)) tryAssign(fm.idx, "GRAPHICS_TITLES_PROJECT");
    }
  }

  // Color Pipeline / Transforms
  if (hasReq("COLOR_PIPELINE_TRANSFORMS")) {
    const strongExts = new Set(["cube","ctl","dctl","ocio","cdl","ccc","cc","lut"]);
    const weakExts = new Set(["json","txt"]);
    const reColor = /(\blut\b|\bctl\b|\bdctl\b|\bocio\b|\baces\b|\btransform\b|\bpipeline\b|\bcolor\b|\bcdl\b|\bccc\b)/i;
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      if (strongExts.has(fm.ext)) { tryAssign(fm.idx, "COLOR_PIPELINE_TRANSFORMS"); continue; }
      if (weakExts.has(fm.ext) && reColor.test(fm.lowerPath)) { tryAssign(fm.idx, "COLOR_PIPELINE_TRANSFORMS"); continue; }
    }
  }

  // Picture mastering framing charts
  if (hasReq("PICTURE_MASTERING_FRAMING_CHARTS")) {
    const exts = new Set(["pdf","png","jpg","jpeg"]);
    const reChart = /(\bframing\b|\bchart\b|\bsafe[-_ ]?area\b|\btitle[-_ ]?safe\b|\baction[-_ ]?safe\b|\bcenter[-_ ]?extract\b|\baperture\b)/i;
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      if (!exts.has(fm.ext)) continue;
      if (reChart.test(fm.lowerPath)) tryAssign(fm.idx, "PICTURE_MASTERING_FRAMING_CHARTS");
    }
  }

  // Picture mastering project files (DI/Conform)
  if (hasReq("PICTURE_MASTERING_PROJECT")) {
    const exts = new Set(["drp","otio","fcpxml","xml","edl"]);
    const reMaster = /(\bmaster\b|\bmastering\b|\bconform\b|\bdi\b|\bgrading\b|\bgrade\b|\bcolor\b|\bresolve\b|\bdavinci\b|\bbaselight\b)/i;
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      if (!exts.has(fm.ext)) continue;
      // Avoid stealing locked cut turnovers (handled below) when path clearly says turnover/locked.
      if (/(\blocked\b|\bturnover\b|\bcut\b)/i.test(fm.lowerPath)) continue;
      if (fm.ext === "drp" || fm.ext === "otio" || reMaster.test(fm.lowerPath)) tryAssign(fm.idx, "PICTURE_MASTERING_PROJECT");
    }
  }

  // Original Camera Files (OCF)
  if (hasReq("ORIGINAL_CAMERA_FILES_OCF") || hasReq("ORIGINAL_CAMERA_FILES_OCF_ALT_TAKES")) {
    const rawExts = new Set(["ari","r3d","braw","crm","dng","mxf"]);
    const vidExts = new Set(["mov","mp4"]);
    const altRe = /(alt[-_ ]?take(s)?|pick[-_ ]?ups?|pickups?|selects?)/i;
    const reOCFContext = /(\bocf\b|\bcamera\b|\braw\b|\bcard\b|\bmag\b)/i;

    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;

      const isRaw = rawExts.has(fm.ext);
      const isVid = vidExts.has(fm.ext);
      const contextOK = reOCFContext.test(fm.lowerPath);

      // For generic video files (mov/mp4) only treat as OCF when context strongly suggests camera/originals.
      if (!isRaw && !(isVid && contextOK)) continue;

      const isAlt = altRe.test(fm.lowerPath);
      if (isAlt && hasReq("ORIGINAL_CAMERA_FILES_OCF_ALT_TAKES")) {
        tryAssign(fm.idx, "ORIGINAL_CAMERA_FILES_OCF_ALT_TAKES");
        continue;
      }
      if (hasReq("ORIGINAL_CAMERA_FILES_OCF")) tryAssign(fm.idx, "ORIGINAL_CAMERA_FILES_OCF");
    }
  }

  // Locked Cut - Editorial Turnover (AAFs/EDLs/XML/OTIO)
  if (hasReq("LOCKED_CUT_EDITORIAL_TURNOVER")) {
    const exts = new Set(["aaf","edl","otio","xml","fcpxml","prproj","drp","pdf","txt"]);
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      if (!exts.has(fm.ext)) continue;
      const p = fm.lowerPath;
      if (p.includes("turnover") || p.includes("locked") || /(^|[^a-z0-9])cut([^a-z0-9]|$)/i.test(p)) {
        tryAssign(fm.idx, "LOCKED_CUT_EDITORIAL_TURNOVER");
      }
    }
  }

  // Editorial project
  if (hasReq("FINAL_EDITORIAL_PROJECT")) {
    const exts = new Set(["prproj","aep","drp","avb","aaf","xml"]);
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      if (exts.has(fm.ext) && !fm.lowerName.includes("logo")) tryAssign(fm.idx, "FINAL_EDITORIAL_PROJECT");
    }
  }

  // Servicing prores (mov)
  {
    const hasTurnover = hasReq("PRORES_422HQ_SDR_TURNOVER");
    const hasTextless = hasReq("PRORES_422HQ_SDR_TEXTLESS_COMPLETE");
    if (hasTurnover || hasTextless) {
      for (const fm of fileMeta) {
        if (assigned.has(fm.idx)) continue;
        if (fm.ext !== "mov") continue;
        const p = fm.lowerPath;
        const looksServicing = p.includes("turnover") || p.includes("servicing") || p.includes("prores") || p.includes("422hq") || p.includes("422") || p.includes("hq");
        if (!looksServicing) continue;
        const looksTextless = p.includes("textless") || /(^|[^a-z0-9])tl([^a-z0-9]|$)/i.test(p);
        if (looksTextless && hasTextless) tryAssign(fm.idx, "PRORES_422HQ_SDR_TEXTLESS_COMPLETE");
        else if (hasTurnover) tryAssign(fm.idx, "PRORES_422HQ_SDR_TURNOVER");
        else if (hasTextless) tryAssign(fm.idx, "PRORES_422HQ_SDR_TEXTLESS_COMPLETE");
      }
    }
  }

  // Editorial media (avoid grabbing servicing prores)
  if (hasReq("FINAL_EDITORIAL_MEDIA")) {
    const exts = new Set(["mov","mp4","mxf"]);
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      if (!exts.has(fm.ext)) continue;
      const p = fm.lowerPath;
      if (p.includes("turnover") || p.includes("servicing") || p.includes("prores") || p.includes("422hq")) continue;
      tryAssign(fm.idx, "FINAL_EDITORIAL_MEDIA");
    }
  }

  // Mixer notes (localized mix)
  if (hasReq("MIXER_NOTES_LOCALIZED_MIX")) {
    const exts = new Set(["pdf","doc","docx","txt","rtf","md"]);
    const reNotes = /(\bmixer\b|\bnotes\b|\blocalized\b|\blocalisation\b|\bmix\b)/i;
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      if (exts.has(fm.ext) && reNotes.test(fm.lowerPath)) tryAssign(fm.idx, "MIXER_NOTES_LOCALIZED_MIX");
    }
  }

  // --- Audio smart assignment (WAV/BWAV) ---
  // Key idea: use path/folder context first, then WAV header channel count as the strongest signal.
  {
    const wavIdxs = fileMeta
      .filter(f => (f.ext === "wav" || f.ext === "bwf") && !assigned.has(f.idx))
      .map(f => f.idx);

    const wavMetaByIdx = new Map();
    if (wavIdxs.length) {
      const metas = await mapLimit(wavIdxs, 12, async (idx) => {
        try {
          const meta = await parseWavHeader(files[idx]);
          return { idx, meta };
        } catch (_e) {
          return { idx, meta: { ok:false, reason:"read_fail" } };
        }
      });
      for (const { idx, meta } of metas) wavMetaByIdx.set(idx, meta);
    }

    const RE_NEARFIELD = /(near[-_ ]?field|\bnf\b)/i;
    const RE_STEMS = /\bstems?\b/i;
    const RE_PRINT = /(\bprint\b|\bprint[-_ ]?master\b|\bprintmaster\b|\bprt\b)/i;
    const RE_PM = /(^|[^a-z0-9])pm([^a-z0-9]|$)/i;
    const RE_FULLMIX = /(\bfull[-_ ]?mix\b|\bfullmix\b)/i;
    const RE_ME = /(m[\s._-]?&[\s._-]?e|m\+e|mxe|mne|(^|[^a-z0-9])me([^a-z0-9]|$))/i;
    const RE_ATMOS = /(\batmos\b|\badm\b|\bdolby[-_ ]?atmos\b)/i;
    const RE_SCORE_CTX = /(\bcomposer\b|\bscore\b|\bcue(s)?\b|\bost\b)/i;
    const RE_SONG_CTX = /(\bsong\b|\bvocal\b|\blyric(s)?\b|\bartist\b)/i;
    const RE_PROD_AUDIO_CTX = /(\bproduction\b|\bprod\b|\blocation\b|\bpolywav\b|\biso\b|\bboom\b|\blav\b|\bzax(com)?\b|\bsound[-_ ]?roll\b|\bsoundroll\b)/i;
    const RE_STEM_TYPE = /(\bdx\b|\bdialog(ue)?\b|\bmx\b|\bmusic\b|\bfx\b|\bsfx\b|\beffects\b|\bfoley\b|\bamb(ience)?\b)/i;

    const RE_20 = /(^|[^0-9])2[._ -]?0([^0-9]|$)|\bstereo\b|\b2ch\b/i;
    const RE_51 = /(^|[^0-9])5[._ -]?1([^0-9]|$)|\b5_1\b|\b51ch\b|\b6ch\b/i;

    for (const idx of wavIdxs) {
      if (assigned.has(idx)) continue;
      const fm = fmByIdx.get(idx);
      if (!fm) continue;

      const p = fm.lowerPath;
      const d = fm.dirLower || "";
      const st = dirStats.get(d) || { wav:0 };
      const manyWavsInDir = (st.wav || 0) >= 6;

      const meta = wavMetaByIdx.get(idx);
      const ch = (meta && meta.ok) ? meta.channels : null;
      const layout = (Number.isFinite(ch) && ch >= 6) ? "5.1" : (ch === 2 ? "stereo" : null);

      const nearfield = RE_NEARFIELD.test(p);
      const stemsWord = RE_STEMS.test(p);
      const printWord = RE_PRINT.test(p) || RE_PM.test(p) || RE_FULLMIX.test(p);
      const meWord = RE_ME.test(p);
      const atmosWord = RE_ATMOS.test(p);

      const scoreCtx = RE_SCORE_CTX.test(p);
      const songCtx = RE_SONG_CTX.test(p);
      const prodCtx = RE_PROD_AUDIO_CTX.test(p);
      const stemType = RE_STEM_TYPE.test(p);

      // 1) Atmos print master
      if (atmosWord && hasReq("PRINT_MASTER_ATMOS_NEARFIELD")) {
        tryAssign(idx, "PRINT_MASTER_ATMOS_NEARFIELD");
        continue;
      }

      // 2) M&E is typically 5.1
      if (meWord && hasReq("AUDIO_ME_51_NEARFIELD") && (layout === "5.1" || RE_51.test(p))) {
        tryAssign(idx, "AUDIO_ME_51_NEARFIELD");
        continue;
      }

      // 3) Nearfield deliverables (Sound Mastering) — folder/path context wins over generic MUSIC tokens.
      if (nearfield || stemsWord || printWord) {
        // Determine likely layout when header isn't available.
        const inferredLayout = layout || (RE_51.test(p) ? "5.1" : (RE_20.test(p) ? "stereo" : null));

        // Prefer explicit folder naming.
        const stemsLike = stemsWord || stemType || manyWavsInDir;
        const printLike = printWord && !stemsWord && !stemType && !manyWavsInDir;

        if (printLike) {
          if (inferredLayout === "5.1" && hasReq("PRINT_MASTER_51_NEARFIELD")) { tryAssign(idx, "PRINT_MASTER_51_NEARFIELD"); continue; }
          if (inferredLayout === "stereo" && hasReq("PRINT_MASTER_20_NEARFIELD")) { tryAssign(idx, "PRINT_MASTER_20_NEARFIELD"); continue; }
        }

        if (stemsLike) {
          if (inferredLayout === "5.1" && hasReq("AUDIO_STEMS_51_NEARFIELD")) { tryAssign(idx, "AUDIO_STEMS_51_NEARFIELD"); continue; }
          if (inferredLayout === "stereo" && hasReq("AUDIO_STEMS_20_NEARFIELD")) { tryAssign(idx, "AUDIO_STEMS_20_NEARFIELD"); continue; }
        }

        // Fallback: choose the only available nearfield card matching inferred layout.
        if (inferredLayout === "5.1") {
          const cands = ["AUDIO_STEMS_51_NEARFIELD","PRINT_MASTER_51_NEARFIELD","AUDIO_ME_51_NEARFIELD"].filter(hasReq);
          if (cands.length === 1) { tryAssign(idx, cands[0]); continue; }
        }
        if (inferredLayout === "stereo") {
          const cands = ["AUDIO_STEMS_20_NEARFIELD","PRINT_MASTER_20_NEARFIELD"].filter(hasReq);
          if (cands.length === 1) { tryAssign(idx, cands[0]); continue; }
        }
      }

      // 4) Music deliverables (Composer / Songs) — only when not nearfield-like.
      if (scoreCtx && hasReq("SCORE_MIXES_20")) {
        if (stemsWord && hasReq("SCORE_STEMS")) { tryAssign(idx, "SCORE_STEMS"); continue; }
        // Score mixes are commonly stereo.
        tryAssign(idx, "SCORE_MIXES_20");
        continue;
      }
      if (songCtx && hasReq("SONG_MIXES_STEMS")) { tryAssign(idx, "SONG_MIXES_STEMS"); continue; }

      // 5) Production audio (location sound)
      if (prodCtx && hasReq("PRODUCTION_AUDIO")) { tryAssign(idx, "PRODUCTION_AUDIO"); continue; }

      // 6) Last resort: if WAV header strongly indicates stereo/5.1 and only one matching card exists.
      if (layout === "5.1") {
        const candidates = ["AUDIO_STEMS_51_NEARFIELD","PRINT_MASTER_51_NEARFIELD","AUDIO_ME_51_NEARFIELD"].filter(hasReq);
        if (candidates.length === 1) { tryAssign(idx, candidates[0]); continue; }
      }
      if (layout === "stereo") {
        const candidates = ["AUDIO_STEMS_20_NEARFIELD","PRINT_MASTER_20_NEARFIELD","SCORE_MIXES_20"].filter(hasReq);
        if (candidates.length === 1) { tryAssign(idx, candidates[0]); continue; }
      }
    }
  }

  // Production audio (folder-based, for missed wavs)
  if (hasReq("PRODUCTION_AUDIO")) {
    const reProd = /(\bproduction\b|\bprod\b|\blocation\b|\bpolywav\b|\bsound[-_ ]?roll\b|\bsoundroll\b)/i;
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      if (fm.ext !== "wav" && fm.ext !== "bwf") continue;
      if (reProd.test(fm.lowerPath)) tryAssign(fm.idx, "PRODUCTION_AUDIO");
    }
  }

  // VFX Wrap Report (prefer over generic VFX report matching)
  if (hasReq("VFX_WRAP_REPORT")) {
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      if (fm.ext === "xlsx" || fm.ext === "csv" || fm.ext === "pdf" || fm.ext === "txt") {
        if (fm.lowerName.includes("wrap") || fm.lowerPath.includes("wrap")) tryAssign(fm.idx, "VFX_WRAP_REPORT");
      }
    }
  }

  // VFX reports / spreadsheets
  if (hasReq("VFX_SHOT_ASSET_STATUS_REPORT") || hasReq("SELECTED_VFX_DELIVERABLES")) {
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      if (fm.ext !== "xlsx" && fm.ext !== "csv" && fm.ext !== "pdf" && fm.ext !== "txt") continue;
      const p = fm.lowerPath;
      if ((p.includes("status") || p.includes("shot") || p.includes("asset")) && hasReq("VFX_SHOT_ASSET_STATUS_REPORT")) { tryAssign(fm.idx, "VFX_SHOT_ASSET_STATUS_REPORT"); continue; }
      if ((p.includes("selected") || p.includes("deliverable") || p.includes("delivery")) && hasReq("SELECTED_VFX_DELIVERABLES")) { tryAssign(fm.idx, "SELECTED_VFX_DELIVERABLES"); continue; }
    }
  }

  // VFX materials (heuristic)
  {
    const vfxExts = new Set(["exr","dpx","fbx","abc","obj","usd","usda","mov","mxf","png","jpg","jpeg","psd","ai","tif","tiff"]);
    const wantsAnyVfx = reqIds.some(x => ["FINAL_MODELS","BACKGROUND_PLATES","SCANNING_DATA","VFX_SHOTS","ELEMENTS_2D"].includes(x));
    if (wantsAnyVfx) {
      for (const fm of fileMeta) {
        if (assigned.has(fm.idx)) continue;
        if (!vfxExts.has(fm.ext)) continue;

        const p = fm.lowerPath;

        if (["fbx","abc","obj","usd","usda"].includes(fm.ext) && hasReq("FINAL_MODELS")) { tryAssign(fm.idx, "FINAL_MODELS"); continue; }

        if (["exr","dpx"].includes(fm.ext) && (p.includes("plate") || p.includes("plates") || p.includes("bg") || p.includes("background")) && hasReq("BACKGROUND_PLATES")) { tryAssign(fm.idx, "BACKGROUND_PLATES"); continue; }

        if ((p.includes("scan") || p.includes("lidar") || p.includes("photogram") || p.includes("survey")) && hasReq("SCANNING_DATA")) { tryAssign(fm.idx, "SCANNING_DATA"); continue; }

        if ((fm.ext === "exr" || fm.ext === "dpx" || fm.ext === "mov" || fm.ext === "mxf") && (p.includes("shot") || p.includes("shots") || p.includes("vfx")) && hasReq("VFX_SHOTS")) { tryAssign(fm.idx, "VFX_SHOTS"); continue; }

        if ((fm.ext === "psd" || fm.ext === "ai" || fm.ext === "png" || fm.ext === "tif" || fm.ext === "tiff") && hasReq("ELEMENTS_2D")) { tryAssign(fm.idx, "ELEMENTS_2D"); continue; }
      }
    }
  }

  // On-Set Data (folder/name heuristic)
  if (hasReq("ON_SET_DATA")) {
    for (const fm of fileMeta) {
      if (assigned.has(fm.idx)) continue;
      const p = fm.lowerPath;
      if (p.includes("on-set") || p.includes("onset") || p.includes("on_set") || p.includes("setdata") || p.includes("lensgrid") || p.includes("lens_grid") || p.includes("hdri") || p.includes("witness") || p.includes("camera_report") || p.includes("camera report")) {
        tryAssign(fm.idx, "ON_SET_DATA");
      }
    }
  }

  // In series mode: translate base-req assignments to episode-specific IDs
  if (_isSeries) {
    const translated = new Map();
    for (const [idx, baseId] of assigned) {
      const fm = fmByIdx.get(idx);
      const detectedEp = fm ? _detectEp(fm.path) : null;
      const ep = (detectedEp && detectedEp >= 1 && detectedEp <= _epCount) ? detectedEp : 1;
      translated.set(idx, `${baseId}_EP${_epPad(ep)}`);
    }
    assigned.clear();
    for (const [idx, id] of translated) assigned.set(idx, id);
  }

  // Build per-card file lists
  const filesByReq = {};
  for (const rid of expandedReqIds) filesByReq[rid] = [];
  const unassigned = [];
  for (const fm of fileMeta) {
    const rid = assigned.get(fm.idx);
    if (rid && filesByReq[rid]) filesByReq[rid].push(fm.idx);
    else unassigned.push(fm.idx);
  }

  // Run validators (async, reads files)
  const analysis = await analyzeFiles(config, reqList, files, filesByReq, prevRun?.manual || {}, prevRun?.checklist || {});

  // Treat manual_confirm + manual_check as resolvable (manual_check resolves when all checklist items are ticked).
  const isResolved = (finding) => {
    if (!finding) return false;
    if (finding.module === "manual_confirm") return !!analysis.manualState?.[finding.id];
    if (finding.module === "manual_check") {
      const items = Array.isArray(finding.checklist) ? finding.checklist : [];
      if (!items.length) return false;
      const st = analysis.checklistState?.[finding.id] || {};
      return items.every(it => !!st[it.id]);
    }
    return false;
  };

  // Compute status per card
  const cards = reqList.map(req => {
    const cardFindings = analysis.findingsByReq[req.id] || [];
    const filesIdx = filesByReq[req.id] || [];
    let status = "NOT_ADDED";
    if (filesIdx.length === 0) status = "NOT_ADDED";
    else {
      const hasBlocker = cardFindings.some(f => f.severity === "BLOCKER" && !isResolved(f));
      const hasWarning = cardFindings.some(f => f.severity === "WARNING" && !isResolved(f));
      if (hasBlocker) status = "BLOCKED";
      else if (hasWarning) status = "ISSUES";
      else status = "PASSED";
    }

    // Memory-safe: store indices + count; keep only a small sample of file metadata.
    const SAMPLE_LIMIT = 50;
    const sampleIdx = filesIdx.slice(0, SAMPLE_LIMIT);
    return {
      id: req.id,
      epNum: req.epNum ?? null,
      category: req.category,
      group: req.group,
      title: req.title,
      subtitle: req.subtitle,
      status,
      fileIdxs: filesIdx,
      fileCount: filesIdx.length,
      filesTruncated: filesIdx.length > SAMPLE_LIMIT,
      files: sampleIdx.map(i => ({
        name: files[i].name,
        path: files[i].__pfxRelPath || files[i].webkitRelativePath || files[i].name,
        size: files[i].size
      })),
      findings: cardFindings
    };
  });

  // Cross-episode consistency: flag episodes missing files when siblings have them
  if (_isSeries) {
    const byBase = new Map();
    for (const card of cards) {
      const base = _baseId(card.id);
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base).push(card);
    }
    for (const epCards of byBase.values()) {
      const haveFiles = epCards.filter(c => c.fileCount > 0).length;
      if (haveFiles === 0 || haveFiles === epCards.length) continue;
      const total = epCards.length;
      for (const card of epCards) {
        if (card.fileCount > 0) continue;
        card.findings.push({
          id: `${card.id}::EP_CONSISTENCY`,
          reqId: card.id,
          checkId: "EP_CONSISTENCY",
          severity: "WARNING",
          title: "Partial delivery — other episodes have files",
          issue: {
            what: `${haveFiles} of ${total} episodes have files for "${card.title}". Episode ${card.epNum} has none.`,
            why: "Netflix requires all episodes delivered together. Missing episodes block QC sign-off.",
            fix: `Upload files for Episode ${card.epNum}, or reduce the episode count if this series has fewer episodes.`
          },
          module: "ep_consistency"
        });
        if (card.status === "NOT_ADDED") card.status = "ISSUES";
      }
    }
  }

  // Summary
  const total = cards.length;
  const blockers = cards.reduce((n,c)=> n + c.findings.filter(f=>f.severity==="BLOCKER" && !isResolved(f)).length, 0);
  const missing = cards.filter(c=> (c.fileCount ?? c.files?.length ?? 0) === 0).length;
  const passed = cards.filter(c=>c.status==="PASSED").length;

  return {
    id: crypto.randomUUID(),
    createdAt: nowISO(),
    projectName: settings.projectName || "",
    profile,
    filesCount: fileMeta.length,
    unassigned,
    cards,
    // Persist assignment overrides so re-runs keep the same per-package upload mapping.
    draftAssignments,
    disabledFileIdxs: Array.from(disabledSet),
    manual: analysis.manualState,
    checklist: analysis.checklistState,
    summary: { total, passed, blockers, missing }
  };
}
