// scripts/modules/amf_convert.js
// AMF Converter - VFX folder scan + Mapping + AE JSX + Nuke PY/NK
// FIXES (2025-12-24):
// 1) Nuke .nk paths are ALWAYS based on script directory (user places .nk in VFX root):
//    file "[python {nuke.script_directory().replace(chr(92),'/').rstrip('/')}]/<relPath>"
// 2) Fix "only 1 frame" in Nuke:
//    - Read uses sequence PATTERN (%0Nd) (never a single-frame filename)
//    - Root first/last match sequence range in per-shot mode (or timeline length in master mode)
// 3) Apply .amf automatically when possible WITHOUT requiring ACES OCIO config:
//    - Best-effort parse ASC CDL (Slope/Offset/Power/Sat) from .amf / .cdl / .cc
//    - If found -> create ColorCorrect with values
//    - Otherwise -> NoOp note "LOOK: <file> (manual)"
//
// Notes:
// - Full AMF look application (IDT/LMT/ODT + named Looks) requires an ACES OCIO config
//   that defines those colorspaces/looks. This exporter avoids generating OCIO nodes that
//   would error under nuke-default configs.
// - AE .aep binary cannot be generated directly; JSX will generate the project inside AE.

import { unzip, strFromU8 } from "../../lib/zip.js";
import { storeNamedHandle, loadNamedHandle, clearNamedHandle } from "../core/projectFile.js";
import { createRadialMenu, RadialIcons } from "../components/radialMenu/index.js";
import { openAnnotateModal as openPfxAnnotateModal } from "../components/annotateModal/index.js";
import { attachPlayableVideo, releasePlayableVideo, PLAYABLE_STATUS } from "../core/playableMedia.js";
import { getCachedProxyForFile } from "./proResProxy.js";
import { nominalBase } from "./utils_time.js";

const SEQ_EXT = new Set(["exr", "dpx", "tif", "tiff"]);
const LOOK_PRIORITY = ["amf", "cc", "cdl", "cube"];
const DEFAULT_FPS = 24;

// -----------------------------
// Directory Handle (Native VFX Root) support
// - If user chooses folder via showDirectoryPicker, we keep a directory handle,
//   allowing us to save exports (.nk) directly into that folder WITHOUT a save dialog.
// - Falls back to normal browser download if handle is unavailable.
// -----------------------------
let __vfxDirHandle = null; // FileSystemDirectoryHandle (if available)
const __VFX_DIR_HANDLE_KEY = "vfxMapping.vfxRoot";

function __setExportStatus(state, main, sub){
  try{
    if (typeof window !== "undefined" && typeof window.MPS_setExportStatus === "function"){
      window.MPS_setExportStatus(state, main || "", sub || "");
    }
  }catch{}
}

function __errText(err){
  try{
    if (!err) return "Unknown error";
    if (typeof err === "string") return err;
    return err.message || String(err);
  }catch(_){
    return "Unknown error";
  }
}

async function __yieldUiFrames(count = 1){
  const total = Math.max(1, Number(count) || 1);
  for (let i = 0; i < total; i++){
    await new Promise((resolve) => {
      try{
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => setTimeout(resolve, 0));
        } else {
          setTimeout(resolve, 0);
        }
      }catch(_){
        setTimeout(resolve, 0);
      }
    });
  }
}

// Run async tasks with a max concurrency limit to avoid saturating Chrome I/O.
// Like Promise.allSettled but at most `limit` tasks run at once.
// Yields to the UI thread between each wave to prevent janking.
async function __pooledAllSettled(items, fn, limit = 8){
  if (!items || !items.length) return [];
  const results = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length){
      const i = idx++;
      try{ results[i] = { status: 'fulfilled', value: await fn(items[i]) }; }
      catch(e){ results[i] = { status: 'rejected', reason: e }; }
    }
  };
  const concurrency = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: concurrency }, worker);
  await Promise.all(workers);
  // Yield after batch to allow paint/event loop before caller continues
  await new Promise(r => setTimeout(r, 0));
  return results;
}

function __progressPercent(done, total){
  const d = Math.max(0, Number(done) || 0);
  const t = Math.max(0, Number(total) || 0);
  if (!t) return 0;
  return Math.max(0, Math.min(100, Math.round((d / t) * 100)));
}

async function __reportImportProgress(onProgress, payload = {}, yieldFrames = 0){
  try{
    if (typeof onProgress === "function") onProgress(payload || {});
  }catch{}
  if ((Number(yieldFrames) || 0) > 0){
    await __yieldUiFrames(Number(yieldFrames) || 1);
  }
}


async function __pickVfxDirectoryHandle(){
  if (typeof window === "undefined") return null;
  const picker = window.showDirectoryPicker;
  if (typeof picker !== "function") return null;
  try{
    const h = await picker({ mode: "readwrite" });
    __vfxDirHandle = h || null;
    try{ if (__vfxDirHandle) await storeNamedHandle(__VFX_DIR_HANDLE_KEY, __vfxDirHandle); }catch{}
    return __vfxDirHandle;
  }catch(e){
    // user cancelled or unsupported
    return null;
  }
}

async function __restoreVfxDirectoryHandle(){
  try{
    const h = await loadNamedHandle(__VFX_DIR_HANDLE_KEY);
    if (h) __vfxDirHandle = h;
    return __vfxDirHandle;
  }catch{ return null; }
}

async function __walkDir(handle, baseName, outFiles, opts = {}){
  const stack = [{ h: handle, rel: "" }];
  const onProgress = (opts && typeof opts.onProgress === "function") ? opts.onProgress : null;
  let fileCount = 0;
  let folderCount = 0;
  while (stack.length){
    const cur = stack.pop();
    folderCount += 1;
    if (onProgress && (folderCount === 1 || folderCount % 10 === 0)){
      await __reportImportProgress(onProgress, {
        phase: 'enumerating',
        state: 'work',
        main: 'Importing VFX Folder…',
        sub: `Reading folders ${folderCount} • files ${fileCount}`,
        files: fileCount,
        folders: folderCount
      }, 1);
    }
    for await (const [name, entry] of cur.h.entries()){
      if (entry.kind === "directory"){
        stack.push({ h: entry, rel: cur.rel ? (cur.rel + "/" + name) : name });
      } else if (entry.kind === "file"){
        try{
          const f = await entry.getFile();
          const rel = cur.rel ? (cur.rel + "/" + name) : name;
          const vp = (baseName ? (baseName + "/") : "") + rel;
          try{
            Object.defineProperty(f, "virtualPath", { value: vp, configurable: true });
          }catch{
            f.virtualPath = vp;
          }
          outFiles.push(f);
          fileCount += 1;
          if (onProgress && (fileCount === 1 || fileCount % 25 === 0)){
            await __reportImportProgress(onProgress, {
              phase: 'enumerating',
              state: 'work',
              main: 'Importing VFX Folder…',
              sub: `Reading files ${fileCount} • folders ${folderCount}`,
              files: fileCount,
              folders: folderCount,
              current: rel
            }, 1);
          }
        }catch{}
      }
    }
  }
  if (onProgress){
    await __reportImportProgress(onProgress, {
      phase: 'enumerating-done',
      state: 'work',
      main: 'Importing VFX Folder…',
      sub: `Indexed ${fileCount} files • ${folderCount} folders`,
      files: fileCount,
      folders: folderCount
    }, 1);
  }
}

async function __filesFromDirHandle(dirHandle, opts = {}){
  const files = [];
  if (!dirHandle) return files;
  const base = String(dirHandle.name || "VFX_ROOT");
  await __walkDir(dirHandle, base, files, opts || {});
  return files;
}

function __trimLeadingSlashLike(v){
  let s = String(v || '');
  while (s.startsWith('/') || s.startsWith('\\')) s = s.slice(1);
  return s;
}

function __trimEdgeSlashLike(v){
  let s = String(v || '');
  while (s.startsWith('/') || s.startsWith('\\')) s = s.slice(1);
  while (s.endsWith('/') || s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

function __splitSlashLikeParts(v){
  const src = __trimLeadingSlashLike(v);
  const out = [];
  let cur = '';
  for (const ch of src){
    if (ch === '/' || ch === '\\'){
      if (cur){ out.push(cur); cur = ''; }
    }else{
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

async function __saveTextToVfxRoot(filename, content, mime="text/plain"){
  const parts = __splitSlashLikeParts(filename);
  const leafName = parts.length ? parts.pop() : 'export.txt';

  if (__vfxDirHandle && typeof __vfxDirHandle.getDirectoryHandle === "function" && typeof __vfxDirHandle.getFileHandle === "function"){
    try{
      let dir = __vfxDirHandle;
      for (const part of parts){
        dir = await dir.getDirectoryHandle(part, { create: true });
      }
      const fh = await dir.getFileHandle(leafName, { create: true });
      const w = await fh.createWritable();
      await w.write(new Blob([content], { type: mime }));
      await w.close();
      return true;
    }catch(e){
      console.warn("VFX root write failed, falling back to download:", e);
    }
  }

  const relName = parts.length ? (parts.join('/') + '/' + leafName) : leafName;
  downloadText(relName, content, mime);
  return false;
}
// -----------------------------
// QT Ref (thumbnail) support
// - Best-effort find QT ref per shot (image/video) and render thumbnails in UI
// - Notes:
//   * Chrome may NOT decode ProRes .mov; in that case thumbnail may remain as placeholder.
//   * We match QT refs flexibly (folder name not strictly required) by scoring candidates
//     that look like previews for each shot.
// -----------------------------
const QT_IMG_EXT = new Set(["jpg","jpeg","png","webp"]);
const QT_VID_EXT = new Set(["mov","mp4","m4v"]);

function __normKey(s=""){
  return String(s||"").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isQTPath(relPath=""){
  const p = String(relPath||"").toLowerCase();
  // folder-ish hints
  if (p.includes("qt_ref") || p.includes("qtref") || p.includes("qt-ref")) return true;
  // "QT Ref" with spaces
  if (p.includes("qt ref")) return true;
  // regex: qt...ref or ref...qt in same segment
  if (/(?:^|\/)(?:qt[^\/]{0,16}ref|ref[^\/]{0,16}qt)(?:\/|$)/i.test(p)) return true;
  // loose: any '/qt/' segment (some teams use QT/Preview)
  if (/(?:^|\/)(qt|quicktime)(?:\/|$)/i.test(p)) return true;
  return false;
}

function collectQTRefs(files){
  // raw: relPath -> { relPath, relLower, file, kind, ext, stem, stemKey }
  const raw = new Map();
  for (const f of (files || [])){
    const rp = relFromRoot(f);
    if (!rp) continue;
    const e = ext(rp);
    if (!QT_IMG_EXT.has(e) && !QT_VID_EXT.has(e)) continue;

    const bn = baseName(rp);
    const st = stem(bn);
    const relLower = String(rp).toLowerCase();
    raw.set(rp, {
      relPath: rp,
      relLower,
      file: f,
      size: Number(f?.size || 0),
      kind: QT_IMG_EXT.has(e) ? "img" : "vid",
      ext: e,
      stem: st,
      stemKey: __normKey(st),
      isQtHint: isQTPath(relLower)
    });
  }
  return { raw };
}

const __thumbCache = new Map(); // key=root::shot -> dataURL
let __thumbLoading = false;
const __THUMB_MAX_EDGE = 320;
const __THUMB_JPEG_QUALITY = 0.78;
const __THUMB_CACHE_MAX = 256;
let __thumbTrimTimer = 0;

function __thumbPlaceholderStatus(shot){
  try{
    if (shot?.flags?.ready) return { label: 'READY', fg: '#d9fff0', bgA: '#173f34', bgB: '#245548', accent: '#45d0a0' };
    const hasSeq = !!shot?.flags?.hasSeq;
    const hasLook = !!shot?.flags?.hasLook;
    const hasEDL = !!shot?.flags?.hasEDL;
    if (!hasSeq) return { label: 'NO SHOT', fg: '#ffe9ea', bgA: '#462326', bgB: '#6a2f35', accent: '#ff6c78' };
    if (!hasLook) return { label: 'NO LOOK', fg: '#fff3dc', bgA: '#4a331a', bgB: '#664520', accent: '#ffb347' };
    if (!hasEDL) return { label: 'NO EDL', fg: '#fff3dc', bgA: '#4a331a', bgB: '#664520', accent: '#ffb347' };
  }catch{}
  return { label: 'EVENT', fg: '#e8f1ff', bgA: '#20283f', bgB: '#27355a', accent: '#77a8ff' };
}

function __makeThumbPlaceholderDataURL(shot, result){
  try{
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 180;
    const ctx = c.getContext('2d');
    if (!ctx) return null;

    const tone = __thumbPlaceholderStatus(shot);
    const g = ctx.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, tone.bgA || '#21263a');
    g.addColorStop(1, tone.bgB || '#353f68');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, c.width, c.height);

    const glow = ctx.createRadialGradient(c.width * 0.18, c.height * 0.22, 10, c.width * 0.18, c.height * 0.22, c.width * 0.7);
    glow.addColorStop(0, 'rgba(255,255,255,0.14)');
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, c.width, c.height);

    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(14, 14, c.width - 28, c.height - 28);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(14.5, 14.5, c.width - 29, c.height - 29);

    const title = String(shot?.shotName || shot?.compName || 'SHOT').trim();
    const sub = String(shot?.seq?.patternRel || shot?.qt?.relPath || shot?.look?.relPath || '').trim();
    const frames = Number.isFinite(Number(shot?.seq?.count)) ? `${Number(shot.seq.count)} fr` : '';

    ctx.fillStyle = tone.accent || '#6ea3ff';
    ctx.beginPath();
    ctx.arc(28, 28, 6, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f7faff';
    ctx.font = '600 18px system-ui, -apple-system, Segoe UI, sans-serif';
    const maxW = c.width - 34;
    let line1 = title;
    while (ctx.measureText(line1).width > maxW && line1.length > 8) {
      line1 = line1.slice(0, -2);
    }
    if (line1 !== title) line1 = line1.slice(0, -1) + '…';
    ctx.fillText(line1, 24, 62);

    if (frames){
      ctx.font = '600 12px system-ui, -apple-system, Segoe UI, sans-serif';
      ctx.fillStyle = 'rgba(255,255,255,0.78)';
      ctx.fillText(frames, 24, 84);
    }

    ctx.font = '500 11px system-ui, -apple-system, Segoe UI, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.62)';
    const subLine = sub || 'Thumbnail placeholder';
    let sline = subLine;
    while (ctx.measureText(sline).width > (c.width - 48) && sline.length > 10) {
      sline = sline.slice(0, -2);
    }
    if (sline !== subLine) sline = sline.slice(0, -1) + '…';
    ctx.fillText(sline, 24, c.height - 26);

    const badgeText = tone.label || 'EVENT';
    ctx.font = '700 11px system-ui, -apple-system, Segoe UI, sans-serif';
    const bw = Math.ceil(ctx.measureText(badgeText).width) + 18;
    const bx = c.width - bw - 16;
    const by = 18;
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    if (typeof ctx.roundRect === 'function'){
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, 24, 12);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.stroke();
    } else {
      ctx.fillRect(bx, by, bw, 24);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.strokeRect(bx + 0.5, by + 0.5, bw - 1, 23);
    }
    ctx.fillStyle = tone.fg || '#ffffff';
    ctx.fillText(badgeText, bx + 9, by + 16);

    return c.toDataURL('image/jpeg', 0.8);
  }catch{
    // Canvas failed — return a minimal SVG placeholder so the thumb always shows something
    try{
      const label = String(shot?.shotName || 'SHOT').replace(/[&<>"']/g, '');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">
        <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#21263a"/><stop offset="100%" stop-color="#353f68"/></linearGradient></defs>
        <rect width="320" height="180" fill="url(#g)"/>
        <text x="24" y="62" font-size="16" font-family="system-ui,sans-serif" fill="#f0f4ff" font-weight="600">${label.slice(0,28)}</text>
        <text x="24" y="84" font-size="12" font-family="system-ui,sans-serif" fill="rgba(255,255,255,0.55)">No preview</text>
      </svg>`;
      return 'data:image/svg+xml;base64,' + btoa(svg);
    }catch{ return null; }
  }
}

async function __resolveThumbDataURL(shot, result){
  try{
    const qt = shot && shot.qt ? shot.qt : null;
    if (qt?.dataUrl && typeof qt.dataUrl === 'string' && qt.dataUrl.startsWith('data:image/')) return qt.dataUrl;
    if (qt?.file){
      try{
        const got = (qt.kind === 'img') ? await imgFileToJpegDataURL(qt.file) : await videoFileToJpegDataURL(qt.file);
        if (got) return got;
      }catch{}
    }
    return __makeThumbPlaceholderDataURL(shot, result);
  }catch{
    return __makeThumbPlaceholderDataURL(shot, result);
  }
}

function __applyThumbToEl(el, dataUrl){
  if (!el) return;
  if (dataUrl){
    try{ el.style.backgroundImage = `url("${dataUrl}")`; }catch{}
    try{ el.classList.add('has-thumb'); el.classList.remove('thumb-pending'); }catch{}
  } else {
    // No image — remove background but add a CSS class so the element shows
    // a styled "no preview" state instead of a plain gray box.
    try{ el.style.removeProperty('background-image'); }catch{}
    try{ el.classList.remove('has-thumb'); el.classList.add('thumb-pending'); }catch{}
  }
}

function __scaledThumbDims(w, h, maxEdge = __THUMB_MAX_EDGE){
  const ww = Number(w || 0);
  const hh = Number(h || 0);
  if (!ww || !hh) return { w: 0, h: 0 };
  const scale = Math.min(1, maxEdge / Math.max(ww, hh));
  return {
    w: Math.max(1, Math.round(ww * scale)),
    h: Math.max(1, Math.round(hh * scale))
  };
}

function __thumbCacheSet(key, dataUrl){
  const k = String(key || '').trim();
  if (!k) return;
  try{ if (__thumbCache.has(k)) __thumbCache.delete(k); }catch{}
  try{ __thumbCache.set(k, dataUrl || null); }catch{}
  while (__thumbCache.size > __THUMB_CACHE_MAX){
    const oldest = __thumbCache.keys().next();
    if (!oldest || oldest.done) break;
    try{ __thumbCache.delete(oldest.value); }catch{}
  }
}

function __thumbScrollerFor(tableHost){
  try{
    return tableHost?.closest?.('.amf-table-host, .amf-table-scroll, .card-body') || tableHost?.parentElement || tableHost || null;
  }catch{
    return tableHost?.parentElement || tableHost || null;
  }
}

function __thumbNearViewport(el, scroller, margin = 700){
  try{
    if (!el || !scroller) return true;
    const er = el.getBoundingClientRect();
    const sr = scroller.getBoundingClientRect();
    return er.bottom >= (sr.top - margin) && er.top <= (sr.bottom + margin);
  }catch{
    return true;
  }
}

function __thumbRootKey(result, tableHost){
  return String(result?.rootName || result?.edlTitle || tableHost?.dataset?.thumbRoot || 'VFX_ROOT');
}

function __thumbVisibleKeys(tableHost, result, margin = 700, limit = __THUMB_CACHE_MAX){
  const out = new Set();
  try{
    const rootKey = __thumbRootKey(result, tableHost);
    const scroller = __thumbScrollerFor(tableHost);
    const thumbs = Array.from(tableHost?.querySelectorAll?.('.vfx-thumb[data-shot]') || []);
    for (const el of thumbs){
      if (!__thumbNearViewport(el, scroller, margin)) continue;
      const shotName = String(el.getAttribute('data-shot') || '').trim();
      if (!shotName) continue;
      out.add(rootKey + '::' + shotName);
      if (out.size >= limit) break;
    }
  }catch{}
  try{
    if (__qtCtx?.qtKey) out.add(String(__qtCtx.qtKey));
  }catch{}
  return out;
}

function __trimThumbRuntime(tableHost, result, opts = {}){
  const keep = (opts.keepKeys instanceof Set) ? opts.keepKeys : __thumbVisibleKeys(tableHost, result, opts.margin || 700, opts.limit || __THUMB_CACHE_MAX);
  // Only evict the in-memory cache — never remove background-image from DOM elements.
  // Removing DOM styles races with the async thumb loader and causes blank thumbnails.
  try{
    for (const k of Array.from(__thumbCache.keys())){
      if (!keep.has(k)) __thumbCache.delete(k);
    }
  }catch{}
}

function __scheduleThumbRuntimeTrim(tableHost, result, delay = 900){
  try{ clearTimeout(__thumbTrimTimer); }catch{}
  __thumbTrimTimer = setTimeout(() => {
    try{ __trimThumbRuntime(tableHost, result); }catch{}
  }, Math.max(50, Number(delay || 0)));
}

function __wireThumbLazyLoading(tableHost, result){
  if (!tableHost) return;
  try{ tableHost.dataset.thumbRoot = __thumbRootKey(result, tableHost); }catch{}

  try{
    if (typeof tableHost.__mpsThumbLazyDispose === 'function'){
      tableHost.__mpsThumbLazyDispose();
    }
  }catch{}

  const scroller = __thumbScrollerFor(tableHost);
  let raf = 0;
  let fullPassTimer = 0;
  const schedule = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      queueThumbLoad(tableHost, result, { visibleOnly: true, limit: 32, margin: 900 });
      __scheduleThumbRuntimeTrim(tableHost, result, 1200);
    });
  };

  try{ scroller?.addEventListener?.('scroll', schedule, { passive: true }); }catch{}
  try{ window.addEventListener('resize', schedule, { passive: true }); }catch{}

  tableHost.__mpsThumbLazyDispose = () => {
    try{ if (raf) cancelAnimationFrame(raf); }catch{}
    try{ clearTimeout(fullPassTimer); }catch{}
    raf = 0;
    try{ scroller?.removeEventListener?.('scroll', schedule); }catch{}
    try{ window.removeEventListener('resize', schedule); }catch{}
  };

  // Initial visible pass immediately
  schedule();
  // Background full pass: load ALL thumbnails without visibility restriction
  // Delayed so visible-pass renders first, then fills in the rest
  fullPassTimer = setTimeout(() => {
    try{ queueThumbLoad(tableHost, result, { visibleOnly: false, limit: 256 }); }catch{}
  }, 1800);
}

async function videoFileToJpegDataURL(file){
  // Best-effort: decode first available frame from a video File into a JPEG dataURL.
  // Prefers a cached proxy stream URL for ProRes/MXF files that Chrome cannot decode directly.
  // Falls back to a direct blob URL for H.264/VP9/WebM where no proxy exists yet.
  const cached = getCachedProxyForFile(file);
  const url = cached?.url || URL.createObjectURL(file);
  const isBlob = !cached?.url;

  return new Promise((resolve) => {
    const v = document.createElement("video");
    v.preload = "auto";
    v.muted = true;
    v.playsInline = true;
    v.crossOrigin = "anonymous";
    v.src = url;

    let doneOnce = false;
    const done = (dataUrl) => {
      if (doneOnce) return;
      doneOnce = true;
      if (isBlob) try { URL.revokeObjectURL(url); } catch {} // proxy URLs are HTTP — no revoke
      resolve(dataUrl || null);
    };

    const tryDraw = () => {
      try{
        const w = v.videoWidth || 0;
        const h = v.videoHeight || 0;
        if (!w || !h) return false;
        const { w: tw, h: th } = __scaledThumbDims(w, h);
        const canvas = document.createElement("canvas");
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(v, 0, 0, tw, th);
        const dataUrl = canvas.toDataURL("image/jpeg", __THUMB_JPEG_QUALITY);
        done(dataUrl);
        return true;
      } catch {
        return false;
      }
    };

    v.addEventListener("error", () => done(null), { once: true });

    v.addEventListener("loadedmetadata", () => {
      // Try to seek slightly into the clip; if seek fails, we'll still try frame 0.
      try{
        const dur = Number(v.duration || 0);
        const t = (Number.isFinite(dur) && dur > 0) ? Math.min(0.2, dur * 0.05) : 0.1;
        v.currentTime = t;
      } catch {}
    }, { once: true });

    v.addEventListener("loadeddata", () => {
      // Some formats won't allow seek but will have frame 0 ready here.
      if (tryDraw()) return;
      // otherwise, wait for seeked
    });

    v.addEventListener("seeked", () => {
      if (tryDraw()) return;
      done(null);
    }, { once: true });

    // Last-resort: timeout
    setTimeout(() => {
      if (doneOnce) return;
      if (tryDraw()) return;
      done(null);
    }, 1200);
  });
}

async function imgFileToJpegDataURL(file){
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try{
        const w = img.naturalWidth || img.width || 0;
        const h = img.naturalHeight || img.height || 0;
        if (!w || !h) { try{URL.revokeObjectURL(url);}catch{}; return resolve(null); }
        const { w: tw, h: th } = __scaledThumbDims(w, h);
        const canvas = document.createElement("canvas");
        canvas.width = tw; canvas.height = th;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, tw, th);
        const dataUrl = canvas.toDataURL("image/jpeg", __THUMB_JPEG_QUALITY);
        try{ URL.revokeObjectURL(url); }catch{}
        resolve(dataUrl);
      } catch {
        try{ URL.revokeObjectURL(url); }catch{}
        resolve(null);
      }
    };
    img.onerror = () => { try{ URL.revokeObjectURL(url); }catch{}; resolve(null); };
    img.src = url;
  });
}

function __taskKey(rootName, shotName){
  const rn = String(rootName || "").trim() || "VFX_ROOT";
  const sn = String(shotName || "").trim() || "SHOT";
  return `mps.vfx.task.${rn}.${sn}`;
}
function __getTask(rootName, shotName){
  try { return localStorage.getItem(__taskKey(rootName, shotName)) || ""; } catch { return ""; }
}
function __setTask(rootName, shotName, val){
  try { localStorage.setItem(__taskKey(rootName, shotName), String(val || "")); } catch {}
}

// Scope of Work (legacy key: Task) — prefer inline fields (SHOT MARKER) then fallback to localStorage
function __getScopeOfWork(rootName, shot){
  const inline = shot && (shot.scopeOfWork ?? shot.scope ?? shot.task ?? shot.taskText);
  if (inline !== undefined && inline !== null){
    const s = String(inline).trim();
    if (s) return s;
  }
  const shotName = String(shot?.shotName || shot?.shot || "").trim();
  if (!shotName) return "";
  return __getTask(rootName, shotName) || "";
}


function __camLensKey(rootName, shotName){
  const rn = String(rootName || "").trim() || "VFX_ROOT";
  const sn = String(shotName || "").trim() || "SHOT";
  return `mps.vfx.camlens.${rn}.${sn}`;
}
function __getCamLens(rootName, shotName){
  try{
    const raw = localStorage.getItem(__camLensKey(rootName, shotName));
    if (!raw) return { cam:"", lens:"", focal:"", tstop:"", focus:"" };
    const obj = JSON.parse(raw);
    return {
      cam: String(obj?.cam || ""),
      lens: String(obj?.lens || ""),
      focal: String(obj?.focal || ""),
      tstop: String(obj?.tstop || ""),
      focus: String(obj?.focus || "")
    };
  } catch {
    return { cam:"", lens:"", focal:"", tstop:"", focus:"" };
  }
}
function __setCamLensField(rootName, shotName, field, val){
  const f = String(field || "").trim();
  if (!f) return;
  const cur = __getCamLens(rootName, shotName);
  cur[f] = String(val || "");
  try{ localStorage.setItem(__camLensKey(rootName, shotName), JSON.stringify(cur)); } catch {}
}


// -----------------------------
// EXR header metadata (Camera/Lens)
// Lightweight parser (no external libs). Reads only EXR header attrs.
// -----------------------------
function __exrReadNullTerm(u8, off){
  let i = off;
  while (i < u8.length && u8[i] !== 0) i++;
  const s = new TextDecoder("utf-8").decode(u8.subarray(off, i));
  return { s, next: i + 1 };
}
function __exrParseAttrsFromArrayBuffer(ab){
  const u8 = new Uint8Array(ab);
  const dv = new DataView(ab);
  // EXR magic 20000630 little-endian
  if (u8.length < 16) return null;
  const magic = dv.getUint32(0, true);
  if (magic !== 20000630) return null;

  let off = 8; // skip magic + version
  const attrs = new Map();

  while (off < u8.length){
    const nameRes = __exrReadNullTerm(u8, off);
    const name = nameRes.s;
    off = nameRes.next;
    if (!name) break;

    const typeRes = __exrReadNullTerm(u8, off);
    const type = typeRes.s;
    off = typeRes.next;

    if (off + 4 > u8.length) break;
    const size = dv.getUint32(off, true); off += 4;
    if (off + size > u8.length) break;
    const val = u8.subarray(off, off + size);
    off += size;

    attrs.set(name, { type, val });
  }
  return attrs;
}
function __exrAttrToNumber(attr){
  if (!attr) return null;
  const { type, val } = attr;
  const dv = new DataView(val.buffer, val.byteOffset, val.byteLength);
  try{
    if (type === "float" && val.byteLength >= 4) return dv.getFloat32(0, true);
    if (type === "double" && val.byteLength >= 8) return dv.getFloat64(0, true);
    if (type === "int" && val.byteLength >= 4) return dv.getInt32(0, true);
    if (type === "rational" && val.byteLength >= 8){
      const n = dv.getInt32(0, true);
      const d = dv.getInt32(4, true);
      if (d) return n / d;
      return n;
    }
  }catch{}
  return null;
}
function __exrAttrToString(attr){
  if (!attr) return "";
  const { type, val } = attr;
  if (type === "string"){
    // value is null-terminated string
    const u8 = val;
    let end = u8.length;
    if (end && u8[end - 1] === 0) end -= 1;
    return new TextDecoder("utf-8").decode(u8.subarray(0, end));
  }
  const n = __exrAttrToNumber(attr);
  if (n === null || !Number.isFinite(n)) return "";
  return String(n);
}
function __pickFirst(attrs, keys){
  for (const k of keys){
    if (!k) continue;
    const a = attrs.get(k);
    const s = __exrAttrToString(a);
    if (s) return s;
  }
  return "";
}
function __pickFirstNumber(attrs, keys){
  for (const k of keys){
    const a = attrs.get(k);
    const n = __exrAttrToNumber(a);
    if (n !== null && Number.isFinite(n)) return n;
    const s = __exrAttrToString(a);
    const f = parseFloat(s);
    if (Number.isFinite(f)) return f;
  }
  return null;
}

function __findFirstNumberByKey(attrs, includeAny, includeAll, excludeAny){
  try{
    const any = (includeAny || []).map(s => String(s||"").toLowerCase()).filter(Boolean);
    const all = (includeAll || []).map(s => String(s||"").toLowerCase()).filter(Boolean);
    const exc = (excludeAny || []).map(s => String(s||"").toLowerCase()).filter(Boolean);

    for (const [k, a] of attrs.entries()){
      const kl = String(k || "").toLowerCase();
      if (exc.length && exc.some(e => kl.includes(e))) continue;
      if (all.length && !all.every(w => kl.includes(w))) continue;
      if (any.length && !any.some(w => kl.includes(w))) continue;

      const n = __exrAttrToNumber(a);
      if (n !== null && Number.isFinite(n)) return n;

      const s = __exrAttrToString(a);
      const cleaned = String(s || "").replace(/[^0-9.+\-eE]/g, " ");
      const f = parseFloat(cleaned);
      if (Number.isFinite(f)) return f;
    }
  }catch{}
  return null;
}
function __formatFocusDist(n){
  if (n === null || !Number.isFinite(n)) return "";
  // Heuristic: many EXRs store focus distance in mm (>=1000). Convert to meters.
  if (n >= 1000) return `${(n / 1000).toFixed(2)}m`;
  if (n < 10) return `${n.toFixed(2)}m`;
  if (n < 100) return `${n.toFixed(1)}m`;
  return `${Math.round(n)}m`;
}

function __formatMaybeMM(n){
  if (n === null || !Number.isFinite(n)) return "";
  // If looks like meters, convert? (heuristic)
  if (n > 0 && n < 10) return `${n.toFixed(2)}m`;
  // assume mm
  const mm = n;
  if (Math.abs(mm - Math.round(mm)) < 1e-3) return `${Math.round(mm)}mm`;
  return `${mm.toFixed(1)}mm`;
}
function __formatTStop(n){
  if (n === null || !Number.isFinite(n)) return "";
  if (n <= 0) return "";
  if (Math.abs(n - Math.round(n)) < 1e-3) return `T${Math.round(n)}`;
  return `T${n.toFixed(1)}`;
}
async function __extractCamLensFromEXRFile(file){
  try{
    if (!file) return null;
    const name = String(file.name || "");
    if (!/\.exr$/i.test(name)) return null;

    // Read just first ~1MB; header is usually tiny
    const ab = await file.slice(0, 1024 * 1024).arrayBuffer();
    const attrs = __exrParseAttrsFromArrayBuffer(ab);
    if (!attrs) return null;

    const camMake = __pickFirst(attrs, [
      "arriraw/cameraDevice/cameraMake",
      "cameraMake",
      "exif:Make",
      "Make"
    ]);
    const camModel = __pickFirst(attrs, [
      "arriraw/cameraDevice/cameraModel",
      "cameraModel",
      "exif:Model",
      "Model",
      "oiio:Camera"
    ]);
    const camSerial = __pickFirst(attrs, [
      "arriraw/cameraDevice/cameraSerialNumber",
      "cameraSerialNumber",
      "exif:BodySerialNumber",
      "BodySerialNumber"
    ]);
    const camera = [camMake, camModel].filter(Boolean).join(" ").trim() || camModel || camMake || "";

    const lensModel = __pickFirst(attrs, [
      "arriraw/lensDevice/lensModel",
      "lensModel",
      "LensModel",
      "exif:LensModel",
      "LensModel",
      "oiio:LensModel"
    ]);
    const lensMake = __pickFirst(attrs, [
      "arriraw/lensDevice/lensMake",
      "lensMake",
      "exif:LensMake",
      "LensMake"
    ]);
    const lens = [lensMake, lensModel].filter(Boolean).join(" ").trim() || lensModel || lensMake || "";

    const focalN0 = __pickFirstNumber(attrs, [
      "FocalLength",
      "focalLength",
      "exif:FocalLength",
      "oiio:FocalLength",
      "arriraw/lensDevice/focalLength",
      "arri:LensFocalLength",
      "arri:LensFocalLengthNominal"
    ]);
    const focalN = (focalN0 !== null) ? focalN0 : __findFirstNumberByKey(attrs,
      ["focal"],
      [],
      ["focalplane", "plane", "resolution"]
    );

    const tstopN0 = __pickFirstNumber(attrs, [
      "TStop",
      "tstop",
      "exif:TStop",
      "oiio:TStop",
      "arriraw/lensDevice/tStop",
      "arri:LensTStop",
      "arri:LensTStopNominal",
      "FNumber",
      "fNumber",
      "exif:FNumber"
    ]);
    const tstopN = (tstopN0 !== null) ? tstopN0 : (
      __findFirstNumberByKey(attrs, ["tstop","t-stop","t_stop"], [], ["timestamp","timecode"]) ??
      __findFirstNumberByKey(attrs, ["fnumber","f-number","f_number","fstop","f-stop","f_stop","aperture","iris"], [], ["focal"])
    );

    const focusN0 = __pickFirstNumber(attrs, [
      "FocusDistance",
      "focusDistance",
      "exif:FocusDistance",
      "oiio:FocusDistance",
      "arriraw/lensDevice/focusDistance",
      "arri:LensFocusDistance",
      "arri:LensFocusDistanceNominal"
    ]);
    const focusN = (focusN0 !== null) ? focusN0 : (
      __findFirstNumberByKey(attrs, ["focusdistance","focus_distance","focusdist","focus_dist"], [], ["focusplane","plane"]) ??
      __findFirstNumberByKey(attrs, ["focus"], ["dist"], ["focusplane","plane"])
    );

    // Some cameras store squeeze; useful fallback for lens info
    const squeeze = __pickFirstNumber(attrs, [
      "arriraw/lensDevice/lensSqueezeFactor",
      "lensSqueezeFactor"
    ]);

    const out = {
      cam: (camera + (camSerial ? ` (S/N ${camSerial})` : "")).trim(),
      lens: lens || (squeeze ? `Squeeze ${squeeze}` : ""),
      focal: __formatMaybeMM(focalN),
      tstop: __formatTStop(tstopN),
      focus: __formatFocusDist(focusN)
    };

    // Return only if we got at least one meaningful value
    const any = Object.values(out).some(v => String(v || "").trim() !== "");
    return any ? out : null;
  }catch{
    return null;
  }
}
async function __autoFillCamLensFromSeq(rootName, shotName, seq, relFileMap){
  try{
    if (!seq || !seq.firstFileRel) return;
    const existing = __getCamLens(rootName, shotName);
    const hasAny = Object.values(existing || {}).some(v => String(v || "").trim() !== "");
    if (hasAny) return; // respect manual/previous values

    const f = relFileMap ? relFileMap.get(seq.firstFileRel) : null;
    if (!f) return;

    const meta = await __extractCamLensFromEXRFile(f);
    if (!meta) return;

    for (const k of ["cam","lens","focal","tstop","focus"]){
      if (meta[k]) __setCamLensField(rootName, shotName, k, meta[k]);
    }
  }catch{}
}

let __thumbLoadPending = false;
let __thumbLoadPendingArgs = null;

async function queueThumbLoad(tableHost, result, opts = {}){
  if (__thumbLoading){
    // Mark as pending so we re-run after the current load finishes
    __thumbLoadPending = true;
    __thumbLoadPendingArgs = [tableHost, result, opts];
    return;
  }
  __thumbLoading = true;
  __thumbLoadPending = false;
  __thumbLoadPendingArgs = null;
  try{
    const r = result || __lastResult;
    const qtM = document.getElementById('mpsQTModal');
    if (qtM && qtM.classList.contains('show')) return; // avoid background decoding while preview is open

    if (!r || !tableHost) return;
    const shots = Array.isArray(r.shots) ? r.shots : [];
    const byName = new Map(shots.map(s => [s.shotName, s]));
    const allThumbs = Array.from(tableHost.querySelectorAll('.vfx-thumb[data-shot]'));
    const scroller = __thumbScrollerFor(tableHost);
    const margin = Number(opts.margin || 900);
    const visibleOnly = opts.visibleOnly !== false;
    let thumbs = visibleOnly
      ? allThumbs.filter((el) => __thumbNearViewport(el, scroller, margin))
      : allThumbs.slice();
    const hardLimit = opts.limit != null ? Math.max(4, Number(opts.limit)) : (visibleOnly ? 32 : thumbs.length);
    if (thumbs.length > hardLimit) thumbs = thumbs.slice(0, hardLimit);
    const workers = Math.min(4, Math.max(1, thumbs.length));
    const rootKey = __thumbRootKey(r, tableHost);
    let cursor = 0;
    const worker = async () => {
      while (cursor < thumbs.length){
        const el = thumbs[cursor++];
        const shotName = String(el.getAttribute('data-shot') || '');
        const s = byName.get(shotName);
        if (!s) continue;
        const key = rootKey + '::' + shotName;
        const cached = __thumbCache.get(key);
        if (cached !== undefined){
          __applyThumbToEl(el, cached);
          if (cached) __thumbCacheSet(key, cached);
          continue;
        }
        let dataUrl = null;
        try{
          dataUrl = await __resolveThumbDataURL(s, r);
        } catch { dataUrl = __makeThumbPlaceholderDataURL(s, r); }
        if (!dataUrl) dataUrl = __makeThumbPlaceholderDataURL(s, r);
        // Only cache a non-null result so null is never stored permanently.
        // A null means placeholder generation failed; we retry on next load.
        if (dataUrl) __thumbCacheSet(key, dataUrl);
        __applyThumbToEl(el, dataUrl);
        await new Promise(res => setTimeout(res, 0));
      }
    };
    if (thumbs.length){
      await Promise.all(new Array(workers).fill(0).map(worker));
    }
  } finally {
    __thumbLoading = false;
    try{ __scheduleThumbRuntimeTrim(tableHost, result); }catch{}
    // Re-run if a load was requested while we were busy
    if (__thumbLoadPending && __thumbLoadPendingArgs){
      const args = __thumbLoadPendingArgs;
      __thumbLoadPending = false;
      __thumbLoadPendingArgs = null;
      setTimeout(() => { try{ queueThumbLoad(...args); }catch{} }, 0);
    }
  }
}

if (typeof window !== 'undefined' && !window.__mpsPlateLinkMemoryWired){
  window.__mpsPlateLinkMemoryWired = true;
  window.addEventListener('mps:beforeClearRuntimeMemory', () => {
    try{ clearTimeout(__thumbTrimTimer); }catch{}
    try{ __thumbCache.clear(); }catch{}
    try{
      const qtVid = document.querySelector('.mps-qt-video');
      if (qtVid) releasePlayableVideo(qtVid);
    }catch{}
    try{ if (__qtModalUrl){ URL.revokeObjectURL(__qtModalUrl); } }catch{}
    try{ __qtModalUrl = null; }catch{}
  });
}

export function autoTrimPlateLinkMemory(delay = 120){
  const host = document.getElementById('amfTable');
  try{ __scheduleThumbRuntimeTrim(host, __lastResult, delay); }catch{}
}

// -----------------------------
// QT preview modal (click thumbnail)
// -----------------------------
let __qtModalUrl = null;
let __qtCtx = null; // { shotName, qtKey, thumbEl, kind }

// Watermark: Chrome profile email (best-effort)
// NOTE: To get a real email, the extension may need the "identity" permission in manifest.json.
let __qtProfileEmail = "";
let __qtProfileEmailP = null;

function __getQTProfileEmail(){
  if (__qtProfileEmail) return Promise.resolve(__qtProfileEmail);
  if (__qtProfileEmailP) return __qtProfileEmailP;

  __qtProfileEmailP = new Promise((resolve) => {
    try{
      if (typeof chrome !== "undefined" && chrome?.identity?.getProfileUserInfo){
        chrome.identity.getProfileUserInfo((info) => {
          const email = info?.email ? String(info.email) : "";
          __qtProfileEmail = email;
          resolve(email);
        });
        return;
      }
    }catch{}
    resolve("");
  }).finally(() => {
    __qtProfileEmailP = null;
  });

  return __qtProfileEmailP;
}

function __applyQTWatermark(modalEl){
  try{
    const w = modalEl?.querySelector?.(".mps-qt-watermark");
    if (!w) return;
    w.textContent = "";
    w.style.display = "none";
    __getQTProfileEmail().then((email) => {
      const t = (email || "").trim();
      if (!t) return;
      w.textContent = t;
      w.style.display = "block";
    });
  } catch {}
}
function __ensureQTModal(){
  let m = document.getElementById("mpsQTModal");
  if (m) return m;
  m = document.createElement("div");
  m.id = "mpsQTModal";
  m.className = "mps-qt-modal";
  m.innerHTML = `
    <div class="mps-qt-panel" role="dialog" aria-modal="true">
      <div class="mps-qt-head" data-drag-handle="1">
        <div class="mps-qt-title mono">QT Preview</div>
        <div class="mps-qt-actions">
          <button class="mps-qt-btn mps-qt-update" type="button" title="Capture current frame and update the shot thumbnail">Update Still</button>
          <button class="mps-qt-btn mps-qt-annotate" type="button" title="Annotate on the viewer (D)">Annotate</button>
          <button class="mps-qt-btn mps-qt-upload" type="button" title="Upload QT + current thumbnail to Autodesk Flow (ShotGrid) as a Version">Upload Flow</button>
          <div class="mps-qt-status" aria-live="polite" aria-atomic="true"></div>
        </div>
      </div>

      <button class="mps-qt-close" type="button" aria-label="Close" title="Close">✕</button>
      <div class="mps-qt-body">
        <div class="mps-qt-stage">
          <video class="mps-qt-video" playsinline preload="metadata"></video>
          <img class="mps-qt-img" alt="QT Preview" />
          <div class="mps-qt-watermark mono" aria-hidden="true"></div>
          <canvas class="mps-qt-anno" aria-hidden="true"></canvas>
          <div class="mps-qt-annoBar" aria-hidden="true">
            <button class="mps-qt-annoBtn is-active" data-tool="circle" title="Circle (O)">◯</button>
            <button class="mps-qt-annoBtn" data-tool="arrow" title="Arrow (R)">➜</button>
            <button class="mps-qt-annoBtn" data-tool="pen" title="Pen (P)">✎</button>
            <span class="mps-qt-annoSep"></span>
            <button class="mps-qt-annoSw is-active" data-col="red" title="Red (1)"></button>
            <button class="mps-qt-annoSw" data-col="yellow" title="Yellow (2)"></button>
            <span class="mps-qt-annoSep"></span>
            <button class="mps-qt-annoBtn" data-act="thin" title="Thinner ([)">−</button>
            <button class="mps-qt-annoBtn" data-act="thick" title="Thicker (])">+</button>
            <span class="mps-qt-annoSep"></span>
            <button class="mps-qt-annoBtn" data-act="undo" title="Undo (Cmd/Ctrl+Z)">Undo</button>
            <button class="mps-qt-annoBtn" data-act="clear" title="Clear (Backspace)">Clear</button>
          </div>
        </div>

        <div class="mps-qt-controls" aria-label="Playback controls">
          <div class="mps-qt-controls-left">
<button class="mps-qt-player-btn" type="button" data-act="rew" title="Rewind 1s" aria-label="Rewind 1 second">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <polygon points="11,12 18,6 18,18"></polygon>
                <polygon points="4,12 11,6 11,18"></polygon>
              </svg>
            </button>
            <button class="mps-qt-player-btn" type="button" data-act="prevf" title="Previous frame" aria-label="Previous frame">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="6" y="6" width="2.6" height="12" rx="1"></rect>
                <polygon points="10,12 18,6 18,18"></polygon>
              </svg>
            </button>
            <button class="mps-qt-player-btn" type="button" data-act="play" title="Play" aria-label="Play">
              <svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="18,12 8,6 8,18"></polygon></svg>
            </button>
            <button class="mps-qt-player-btn" type="button" data-act="nextf" title="Next frame" aria-label="Next frame">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <polygon points="14,12 6,6 6,18"></polygon>
                <rect x="16" y="6" width="2.6" height="12" rx="1"></rect>
              </svg>
            </button>
            <button class="mps-qt-player-btn" type="button" data-act="ff" title="Forward 1s" aria-label="Forward 1 second">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <polygon points="13,12 6,6 6,18"></polygon>
                <polygon points="20,12 13,6 13,18"></polygon>
              </svg>
            </button>
</div>

          <input class="mps-qt-range" type="range" min="1" max="1" value="1" step="1" aria-label="Scrub by frame" />

          <div class="mps-qt-controls-right">
            <span class="mps-qt-mini mono mps-qt-frame-read">1 / 1</span>
            <span class="mps-qt-mini mono mps-qt-src-tc">SRC —:—:—:—</span>
            <div class="mps-qt-jump">
              <label class="mps-qt-mini muted" for="mpsQTFrameInput">Frame</label>
              <input id="mpsQTFrameInput" class="mps-qt-frame-input" type="number" min="1" step="1" value="1" inputmode="numeric" />
              <button class="mps-qt-btn mps-qt-btn-ghost" type="button" data-act="gof" title="Go to frame">Go</button>
            </div>
          </div>
        </div>

        <div class="mps-qt-err"></div>
      </div>
    </div>
  `;
  document.body.appendChild(m);

  // UI: remove header action buttons in QT modal (use Radial Menu like Marker/Review)
  try{
    const headEl = m.querySelector('.mps-qt-head');
    const actionsEl = m.querySelector('.mps-qt-actions');
    const statusEl = actionsEl ? actionsEl.querySelector('.mps-qt-status') : null;
    if (actionsEl){
      // Move the status pill into the header (top-right) then remove the buttons group.
      if (statusEl){
        const dock = document.createElement('div');
        dock.className = 'mps-qt-statusDock';
        dock.appendChild(statusEl);
        try{ headEl && headEl.appendChild(dock); }catch{}
      }
      try{ actionsEl.remove(); }catch{}
      try{ headEl && headEl.classList.add('pfx-qt-head-compact'); }catch{}
    }
  }catch{}

  // --- QT custom controls (24fps, 1-based frames) ---
  const __QT_FPS = 24;
  const $ = (sel) => m.querySelector(sel);
  const panel = $('.mps-qt-panel');
  const head  = $('.mps-qt-head');
  const vEl   = $('.mps-qt-video');
  const imgEl = $('.mps-qt-img');
  const ctrls = $('.mps-qt-controls');
  const rng   = $('.mps-qt-range');
  const inFrame = $('#mpsQTFrameInput');
  const btnRew  = m.querySelector('[data-act="rew"]');
  const btnPrev = m.querySelector('[data-act="prevf"]');
  const btnPlay = m.querySelector('[data-act="play"]');
  const __PLAY_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><polygon points="18,12 8,6 8,18"></polygon></svg>`;
  const __STOP_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"></rect></svg>`;
  const btnNext = m.querySelector('[data-act="nextf"]');
  const btnFf   = m.querySelector('[data-act="ff"]');
  const btnGo   = m.querySelector('[data-act="gof"]');
  const elSrcTC = $('.mps-qt-src-tc');
  const elFrameRead = $('.mps-qt-frame-read');

  // ===== Smart Annotate overlay (for VFX Mapping QT preview) =====
  const btnAnnoToggle = m.querySelector('.mps-qt-annotate');
  const annoCanvas = m.querySelector('.mps-qt-anno');
  const annoBar = m.querySelector('.mps-qt-annoBar');
  const annoCtx = annoCanvas ? annoCanvas.getContext('2d') : null;
  let annoEnabled = false;
  let annoTool = 'circle'; // circle | arrow | pen
  let annoColor = 'red';   // red | yellow
  let annoWidth = 6;
  /** @type {Array<any>} */
  let annoShapes = [];
  let annoDrawing = null;

  const __annoKey = () => {
    const k = String((__qtCtx && __qtCtx.qtKey) ? __qtCtx.qtKey : '');
    return k ? `pfx.amf.qtAnno::${k}` : '';
  };
  const __loadAnno = () => {
    try{
      const key = __annoKey();
      if (!key){ annoShapes = []; return; }
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      annoShapes = Array.isArray(parsed) ? parsed : [];
    }catch{ annoShapes = []; }
  };
  const __saveAnno = () => {
    try{
      const key = __annoKey();
      if (!key) return;
      localStorage.setItem(key, JSON.stringify(annoShapes || []));
    }catch{}
  };
  const __annoCol = (c) => (c === 'yellow') ? 'rgba(255, 205, 64, 0.95)' : 'rgba(255, 70, 85, 0.95)';
  const __annoStroke = (ctx, c, w) => { ctx.strokeStyle = __annoCol(c); ctx.lineWidth = Math.max(1, w||6); ctx.lineCap='round'; ctx.lineJoin='round'; };
  const __annoResize = () => {
    try{
      if (!annoCanvas) return;
      const stage = m.querySelector('.mps-qt-stage');
      if (!stage) return;
      const r = stage.getBoundingClientRect();
      const w = Math.max(2, Math.round(r.width));
      const h = Math.max(2, Math.round(r.height));
      if (annoCanvas.width !== w) annoCanvas.width = w;
      if (annoCanvas.height !== h) annoCanvas.height = h;
      __annoRender();
    }catch{}
  };
  const __evtToPt = (ev) => {
    const r = annoCanvas.getBoundingClientRect();
    const x = (ev.clientX - r.left) * (annoCanvas.width / Math.max(1, r.width));
    const y = (ev.clientY - r.top) * (annoCanvas.height / Math.max(1, r.height));
    return { x, y };
  };
  const __annoRender = () => {
    if (!annoCtx || !annoCanvas) return;
    annoCtx.clearRect(0,0,annoCanvas.width, annoCanvas.height);
    const drawOne = (s) => {
      if (!s) return;
      const tool = s.tool;
      const col = s.color || 'red';
      const w = s.width || 6;
      __annoStroke(annoCtx, col, w);
      if (tool === 'circle'){
        const cx = s.cx, cy = s.cy, r = s.r;
        if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(r)) return;
        annoCtx.beginPath();
        annoCtx.arc(cx, cy, Math.max(2, r), 0, Math.PI*2);
        annoCtx.stroke();
      } else if (tool === 'arrow'){
        const x1=s.x1, y1=s.y1, x2=s.x2, y2=s.y2;
        if (![x1,y1,x2,y2].every(Number.isFinite)) return;
        annoCtx.beginPath();
        annoCtx.moveTo(x1,y1);
        annoCtx.lineTo(x2,y2);
        annoCtx.stroke();
        // arrow head
        const ang = Math.atan2(y2-y1, x2-x1);
        const len = Math.max(10, (w||6)*2.2);
        const a1 = ang + Math.PI*0.82;
        const a2 = ang - Math.PI*0.82;
        annoCtx.beginPath();
        annoCtx.moveTo(x2,y2);
        annoCtx.lineTo(x2 + Math.cos(a1)*len, y2 + Math.sin(a1)*len);
        annoCtx.moveTo(x2,y2);
        annoCtx.lineTo(x2 + Math.cos(a2)*len, y2 + Math.sin(a2)*len);
        annoCtx.stroke();
      } else if (tool === 'pen'){
        const pts = Array.isArray(s.pts) ? s.pts : [];
        if (pts.length < 2) return;
        annoCtx.beginPath();
        annoCtx.moveTo(pts[0].x, pts[0].y);
        for (let i=1;i<pts.length;i++) annoCtx.lineTo(pts[i].x, pts[i].y);
        annoCtx.stroke();
      }
    };
    for (const s of (annoShapes||[])) drawOne(s);
    if (annoDrawing) drawOne(annoDrawing);
  };
  const __annoSetEnabled = (on) => {
    annoEnabled = !!on;
    try{ btnAnnoToggle?.classList.toggle('is-active', annoEnabled); }catch{}
    try{ annoCanvas?.classList.toggle('show', annoEnabled); }catch{}
    try{ annoBar?.classList.toggle('show', annoEnabled); }catch{}
    if (annoEnabled){ __annoResize(); }
  };
  const __annoClear = () => { annoShapes = []; annoDrawing = null; __saveAnno(); __annoRender(); };
  const __annoUndo = () => { if (annoShapes && annoShapes.length){ annoShapes.pop(); __saveAnno(); __annoRender(); } };
  const __annoSetTool = (tool) => {
    annoTool = tool;
    try{ annoBar?.querySelectorAll('.mps-qt-annoBtn[data-tool]').forEach(b=>b.classList.toggle('is-active', b.getAttribute('data-tool')===tool)); }catch{}
  };
  const __annoSetColor = (col) => {
    annoColor = col;
    try{ annoBar?.querySelectorAll('.mps-qt-annoSw').forEach(b=>b.classList.toggle('is-active', b.getAttribute('data-col')===col)); }catch{}
  };
  const __annoSetWidth = (w) => { annoWidth = Math.max(2, Math.min(22, Math.round(w||6))); };
  const __annoCaptureComposite = async () => {
    // Returns a dataURL (jpeg) of current frame with annotations composited.
    const ctx = __qtCtx || {};
    const kind = ctx.kind || 'vid';
    const v = m.querySelector('.mps-qt-video');
    const im = m.querySelector('.mps-qt-img');
    const srcEl = (kind === 'img') ? im : v;
    if (!srcEl) return null;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const w = (kind === 'img') ? (im?.naturalWidth || 0) : (v?.videoWidth || 0);
    const h = (kind === 'img') ? (im?.naturalHeight || 0) : (v?.videoHeight || 0);
    if (!w || !h) return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { alpha:false });
    g.drawImage(srcEl, 0,0,w,h);
    // map annoCanvas coords to video coords via stage
    try{
      const stage = m.querySelector('.mps-qt-stage');
      if (stage && annoCanvas && annoShapes && annoShapes.length){
        const sr = stage.getBoundingClientRect();
        const sx = w / Math.max(1, sr.width);
        const sy = h / Math.max(1, sr.height);
        const drawScaled = (s) => {
          if (!s) return;
          const tool = s.tool;
          const col = s.color || 'red';
          const ww = (s.width||6) * ((sx+sy)/2);
          __annoStroke(g, col, ww);
          if (tool === 'circle'){
            g.beginPath();
            g.arc(s.cx*sx, s.cy*sy, Math.max(2, s.r*((sx+sy)/2)), 0, Math.PI*2);
            g.stroke();
          } else if (tool === 'arrow'){
            const x1=s.x1*sx, y1=s.y1*sy, x2=s.x2*sx, y2=s.y2*sy;
            g.beginPath(); g.moveTo(x1,y1); g.lineTo(x2,y2); g.stroke();
            const ang = Math.atan2(y2-y1, x2-x1);
            const len = Math.max(10, ww*2.2);
            const a1 = ang + Math.PI*0.82;
            const a2 = ang - Math.PI*0.82;
            g.beginPath();
            g.moveTo(x2,y2);
            g.lineTo(x2 + Math.cos(a1)*len, y2 + Math.sin(a1)*len);
            g.moveTo(x2,y2);
            g.lineTo(x2 + Math.cos(a2)*len, y2 + Math.sin(a2)*len);
            g.stroke();
          } else if (tool === 'pen'){
            const pts = Array.isArray(s.pts) ? s.pts : [];
            if (pts.length < 2) return;
            g.beginPath();
            g.moveTo(pts[0].x*sx, pts[0].y*sy);
            for (let i=1;i<pts.length;i++) g.lineTo(pts[i].x*sx, pts[i].y*sy);
            g.stroke();
          }
        };
        for (const s of annoShapes) drawScaled(s);
      }
    }catch{}
    return c.toDataURL('image/jpeg', 0.9);
  };

  // Shared Annotate (same as Markers + Reviews) — Plate Link uses the shared Annotate Modal.
  // - Keeps tools/UX consistent across tabs
  // - Stores vector objects per-shot (qtKey) so edits persist
  let __qtAnnoObjects = [];
  const __qtAnnoKey = () => {
    const k = String((__qtCtx && __qtCtx.qtKey) ? __qtCtx.qtKey : '').trim();
    return k ? `pfx.platelink.qtAnnoObjects::${k}` : '';
  };
  const __qtAnnoLoad = () => {
    try{
      const key = __qtAnnoKey();
      if (!key){ __qtAnnoObjects = []; return; }
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      __qtAnnoObjects = Array.isArray(parsed) ? parsed : [];
    }catch{ __qtAnnoObjects = []; }
  };
  const __qtAnnoSave = () => {
    try{
      const key = __qtAnnoKey();
      if (!key) return;
      localStorage.setItem(key, JSON.stringify(__qtAnnoObjects || []));
    }catch{}
  };

  const __qtCaptureFramePng = async () => {
    const ctx = __qtCtx || {};
    const kind = ctx.kind || 'vid';
    const v = m.querySelector('.mps-qt-video');
    const im = m.querySelector('.mps-qt-img');
    const srcEl = (kind === 'img') ? im : v;
    if (!srcEl) return null;
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const w = (kind === 'img') ? (im?.naturalWidth || 0) : (v?.videoWidth || 0);
    const h = (kind === 'img') ? (im?.naturalHeight || 0) : (v?.videoHeight || 0);
    if (!w || !h) return null;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { alpha: false });
    g.drawImage(srcEl, 0, 0, w, h);
    return c.toDataURL('image/png');
  };

  // Hide legacy on-viewer annotate UI (we keep markup for layout stability)
  try{ if (annoCanvas) annoCanvas.style.display = 'none'; }catch{}
  try{ if (annoBar) annoBar.style.display = 'none'; }catch{}

  // Shared Annotate helper (same Annotate system as Marker/Review)
  const __qtOpenAnnotate = async (tool='pen') => {
    try{
      const ctx = __qtCtx || {};
      if (!ctx?.qtKey || !ctx?.thumbEl) throw new Error('No active shot context');
      // Ensure playback is stopped while annotating (modal overlays the viewer)
      try{ if (vEl && !vEl.paused) vEl.pause(); }catch{}
      __qtAnnoLoad();
      const srcDataUrl = await __qtCaptureFramePng();
      if (!srcDataUrl) throw new Error('Media not ready');

      openPfxAnnotateModal({
        srcDataUrl,
        title: (ctx.shotName || ctx.locShotName || 'QT'),
        initialShapes: Array.isArray(__qtAnnoObjects) ? __qtAnnoObjects : [],
        initialTool: String(tool || 'pen'),
        nativeResolution: true,
        onDone: ({ thumbDataUrl, shapes }) => {
          try{
            __qtAnnoObjects = Array.isArray(shapes) ? shapes : [];
            __qtAnnoSave();
            const du = thumbDataUrl || srcDataUrl;
            // Update thumb cache + originating card
            try{ __thumbCache.set(String(ctx.qtKey), du); }catch{}
            try{
              const el = ctx.thumbEl;
              el.style.backgroundImage = `url(${du})`;
              el.classList.add('has-thumb');
              el.dataset.thumbUpdated = '1';
            }catch{}
            setStatus(true, '✅ Annotated');
            __toast(`Annotated: ${ctx.shotName || ''}`.trim());
          }catch{}
        }
      });

      // Ensure requested tool is active in the modal
      try{
        const modal = document.querySelector('.sm-anno-modal');
        const b = modal?.querySelector?.(`.sm-anno-iconbtn[data-tool="${String(tool||'pen')}"]`);
        b?.click?.();
      }catch{}
    }catch(e){
      setStatus(false, '❌ Failed');
      try{ console.warn('Annotate failed:', e); }catch{}
    }
  };

  // Wire legacy Annotate button (if present)
  try{ btnAnnoToggle?.addEventListener('click', async () => { await __qtOpenAnnotate('pen'); }); }catch{}


  const tcToFramesLocal = (tc, fps=__QT_FPS) => {
    const mm = String(tc||'').match(/^(\d+):(\d+):(\d+):(\d+)$/);
    if (!mm) return null;
    const hh=+mm[1], mi=+mm[2], ss=+mm[3], ff=+mm[4];
    return ((hh*3600 + mi*60 + ss) * fps) + ff;
  };
  const framesToTCLocal = (frames, fps=__QT_FPS) => {
    const fr = Math.max(0, Math.round(Number(frames)||0));
    const totalSec = Math.floor(fr / fps);
    const ff = fr % fps;
    const hh = Math.floor(totalSec / 3600);
    const mi = Math.floor((totalSec % 3600) / 60);
    const ss = totalSec % 60;
    const pad2 = (n) => String(n).padStart(2,'0');
    return `${pad2(hh)}:${pad2(mi)}:${pad2(ss)}:${pad2(ff)}`;
  };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  let __qtTotalFrames = 1;
  let __qtUIRaf = 0;
  let __qtIgnore = false;

  const __currentFrame1 = () => {
    const t = Number(vEl?.currentTime || 0);
    const f = Math.round(t * __QT_FPS) + 1;
    return clamp(f, 1, __qtTotalFrames || 1);
  };
  const __seekToFrame1 = (frame1) => {
    if (!vEl) return;
    const f1 = clamp(Math.round(Number(frame1)||1), 1, __qtTotalFrames || 1);
    vEl.pause();
    vEl.currentTime = (f1 - 1) / __QT_FPS;
  };
  const __setPlayIcon = () => {
  const playing = !!(vEl && !vEl.paused);
  if (btnPlay){
    btnPlay.innerHTML = playing ? __STOP_SVG : __PLAY_SVG;
    btnPlay.title = playing ? "Stop" : "Play";
    btnPlay.setAttribute("aria-label", playing ? "Stop" : "Play");
  }
};


  const __updateReadouts = () => {
    if (!vEl || !ctrls || ctrls.style.display === 'none') return;
    const cur = __currentFrame1();
    if (elFrameRead) elFrameRead.textContent = `${cur} / ${__qtTotalFrames}`;

    if (rng && !__qtIgnore){
      __qtIgnore = true;
      rng.max = String(__qtTotalFrames);
      rng.value = String(cur);
      __qtIgnore = false;
    }

    if (inFrame && document.activeElement !== inFrame){
      inFrame.max = String(__qtTotalFrames);
      inFrame.value = String(cur);
    }

    // SRC TC
    try{
      const ctx = __qtCtx || {};
      const base = tcToFramesLocal(ctx?.srcIn || ctx?.srcInTc);
      if (base !== null){
        const tc = framesToTCLocal(base + (cur - 1));
        if (elSrcTC) elSrcTC.textContent = `SRC ${tc}`;
      } else {
        if (elSrcTC) elSrcTC.textContent = "SRC —:—:—:—";
      }
    }catch{}
  };

  const __tick = () => {
    __updateReadouts();
    __qtUIRaf = 0;
  };
  const __scheduleTick = () => {
    if (__qtUIRaf) return;
    __qtUIRaf = requestAnimationFrame(__tick);
  };

  // Wire controls (match ref set)
if (btnRew)  btnRew.addEventListener('click', () => { __seekToFrame1(__currentFrame1() - __QT_FPS); __scheduleTick(); });
  if (btnPrev) btnPrev.addEventListener('click', () => { __seekToFrame1(__currentFrame1() - 1); __scheduleTick(); });
  if (btnNext) btnNext.addEventListener('click', () => { __seekToFrame1(__currentFrame1() + 1); __scheduleTick(); });
  if (btnFf)   btnFf.addEventListener('click', () => { __seekToFrame1(__currentFrame1() + __QT_FPS); __scheduleTick(); });

  if (btnPlay) btnPlay.addEventListener('click', async () => {
  if (!vEl) return;
  if (vEl.paused){
    try{ await vEl.play(); }catch{}
  } else {
    try{ vEl.pause(); }catch{}
  }
  __setPlayIcon();
  __scheduleTick();
});
if (rng) rng.addEventListener('input', () => {
    if (__qtIgnore) return;
    const f1 = Number(rng.value||1);
    __seekToFrame1(f1);
    __scheduleTick();
  });

  const goToInput = () => {
    const f1 = Number(inFrame?.value || 1);
    __seekToFrame1(f1);
    __scheduleTick();
  };
  if (btnGo) btnGo.addEventListener('click', goToInput);
  if (inFrame) inFrame.addEventListener('keydown', (e) => {
    if (e.key === 'Enter'){ e.preventDefault(); goToInput(); }
  });

  // Keyboard controls (when modal is open)
// Space / K: Play↔Stop (toggle), J/L: -1s/+1s, ←/→: -1f/+1f, Shift+←/→: -1s/+1s
// Home/End: first/last frame, 0 or S: stop + go to first frame, Esc: close (handled elsewhere)
document.addEventListener('keydown', (e) => {
  if (!m.classList.contains('show')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const ae = document.activeElement;
  if (ae && (ae === inFrame || ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return;

  const key = e.key;

  const stopToStart = () => { if (!vEl) return; try{ vEl.pause(); }catch{}; __seekToFrame1(1); __setPlayIcon(); __scheduleTick(); };

  if (key === ' ' || key === 'k' || key === 'K'){
    e.preventDefault();
    if (!vEl) return;
    if (vEl.paused){ try{ vEl.play(); }catch{}; }
    else { try{ vEl.pause(); }catch{}; }
    __setPlayIcon();
    __scheduleTick();
    return;
  }

  if (key === '0' || key === 's' || key === 'S'){
    e.preventDefault();
    stopToStart();
    return;
  }

  if (key === 'j' || key === 'J'){
    e.preventDefault();
    __seekToFrame1(__currentFrame1() - __QT_FPS);
    __scheduleTick();
    return;
  }

  if (key === 'l' || key === 'L'){
    e.preventDefault();
    __seekToFrame1(__currentFrame1() + __QT_FPS);
    __scheduleTick();
    return;
  }

  if (key === 'Home'){
    e.preventDefault();
    __seekToFrame1(1);
    __scheduleTick();
    return;
  }

  if (key === 'End'){
    e.preventDefault();
    __seekToFrame1(__qtTotalFrames || 1);
    __scheduleTick();
    return;
  }

  if (key === 'ArrowLeft'){
    e.preventDefault();
    const step = e.shiftKey ? __QT_FPS : 1;
    __seekToFrame1(__currentFrame1() - step);
    __scheduleTick();
    return;
  }

  if (key === 'ArrowRight'){
    e.preventDefault();
    const step = e.shiftKey ? __QT_FPS : 1;
    __seekToFrame1(__currentFrame1() + step);
    __scheduleTick();
    return;
  }

  // Optional: , / . for frame step
  if (key === ',' ){
    e.preventDefault();
    __seekToFrame1(__currentFrame1() - 1);
    __scheduleTick();
    return;
  }
  if (key === '.'){
    e.preventDefault();
    __seekToFrame1(__currentFrame1() + 1);
    __scheduleTick();
    return;
  }
});
// Update readouts based on video events
  if (vEl){
    vEl.addEventListener('loadedmetadata', () => {
      const dur = Number(vEl.duration || 0);
      __qtTotalFrames = Math.max(1, Math.round(dur * __QT_FPS) || 1);
      if (rng){ rng.min = '1'; rng.max = String(__qtTotalFrames); }
      if (inFrame){ inFrame.min = '1'; inFrame.max = String(__qtTotalFrames); }
      __setPlayIcon();
      __scheduleTick();
    });
    vEl.addEventListener('timeupdate', __scheduleTick);
    vEl.addEventListener('seeked', __scheduleTick);
    vEl.addEventListener('play', () => { m.classList.add('playing'); __setPlayIcon(); __scheduleTick(); });
    vEl.addEventListener('pause', () => { m.classList.remove('playing'); __setPlayIcon(); __scheduleTick(); });
  }

  // --- Make the panel draggable (drag header only) ---
  try{
    if (panel && head){
      panel.style.left = panel.style.left || '4vw';
      panel.style.top  = panel.style.top  || '6vh';
      let dragging = false;
      let sx=0, sy=0, sl=0, st=0;
      const clampPos = (val, min, max) => Math.max(min, Math.min(max, val));
      const onMove = (ev) => {
        if (!dragging) return;
        const dx = (ev.clientX - sx);
        const dy = (ev.clientY - sy);
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const rect = panel.getBoundingClientRect();
        const w = rect.width;
        const h = rect.height;
        const nl = clampPos(sl + dx, 8, Math.max(8, vw - w - 8));
        const nt = clampPos(st + dy, 8, Math.max(8, vh - h - 8));
        panel.style.left = nl + 'px';
        panel.style.top  = nt + 'px';
      };
      const onUp = () => {
        dragging = false;
        panel.classList.remove('dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
      };
      head.addEventListener('pointerdown', (ev) => {
        // ignore when clicking buttons/inputs
        const tgt = ev.target;
        if (tgt && (tgt.closest('button') || tgt.closest('input') || tgt.closest('label'))) return;
        dragging = true;
        panel.classList.add('dragging');
        const rect = panel.getBoundingClientRect();
        sx = ev.clientX; sy = ev.clientY;
        sl = rect.left; st = rect.top;
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
      });
    }
  }catch{}

  const setStatus = (ok, msg) => {
    try{
      const s = m.querySelector('.mps-qt-status');
      if (!s) return;
      if (!msg){
        s.textContent = '';
        s.classList.remove('show','ok','bad');
        return;
      }
      s.textContent = msg;
      s.classList.add('show');
      s.classList.toggle('ok', !!ok);
      s.classList.toggle('bad', !ok);
    }catch{}
  };

  const captureStill = async () => {
    try{
      const ctx = __qtCtx || {};
      if (!ctx?.qtKey || !ctx?.thumbEl) throw new Error('No active shot context');
      const kind = ctx.kind || 'vid';
      const v = m.querySelector('.mps-qt-video');
      const im = m.querySelector('.mps-qt-img');
      const srcEl = (kind === 'img') ? im : v;
      if (!srcEl) throw new Error('No media element');

      // Let the UI settle for a frame (helps avoid capturing a black frame on some decoders)
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      const w = (kind === 'img') ? (im?.naturalWidth || 0) : (v?.videoWidth || 0);
      const h = (kind === 'img') ? (im?.naturalHeight || 0) : (v?.videoHeight || 0);
      if (!w || !h) throw new Error('Media not ready');

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d', { alpha: false });
      g.drawImage(srcEl, 0, 0, w, h);

      // Composite shared Annotate objects (Markers/Reviews style) onto the captured frame
      try{
        if (__qtAnnoObjects && __qtAnnoObjects.length){
          const oCan = document.createElement('canvas');
          oCan.width = w;
          oCan.height = h;
          const octx = oCan.getContext('2d');
          if (octx){
            const applyStroke = (ctx, style, isHighlight)=>{
              ctx.lineCap = 'round';
              ctx.lineJoin = 'round';
              ctx.strokeStyle = style?.color || '#ff4c4c';
              ctx.lineWidth = style?.width ?? 4;
              ctx.globalAlpha = style?.opacity ?? 1;
              if (isHighlight) ctx.globalAlpha = Math.max(0.15, (style?.opacity ?? 1) * 0.35);
            };
            const drawArrow = (ctx, x1,y1,x2,y2, style)=>{
              const ww = style?.width ?? 4;
              const headLen = Math.max(10, ww*3);
              const dx = x2-x1; const dy=y2-y1;
              const ang = Math.atan2(dy,dx);
              ctx.beginPath();
              ctx.moveTo(x1,y1);
              ctx.lineTo(x2,y2);
              ctx.stroke();
              ctx.beginPath();
              ctx.moveTo(x2,y2);
              ctx.lineTo(x2 - headLen*Math.cos(ang - Math.PI/7), y2 - headLen*Math.sin(ang - Math.PI/7));
              ctx.lineTo(x2 - headLen*Math.cos(ang + Math.PI/7), y2 - headLen*Math.sin(ang + Math.PI/7));
              ctx.lineTo(x2,y2);
              ctx.closePath();
              ctx.fillStyle = style?.color || '#ff4c4c';
              ctx.globalAlpha = style?.opacity ?? 1;
              ctx.fill();
            };
            const renderObj = (ctx, o)=>{
              if (!o) return;
              ctx.save();
              if (o.kind === 'erase') ctx.globalCompositeOperation = 'destination-out';
              else ctx.globalCompositeOperation = 'source-over';
              const style = o.style || {};
              const isHighlight = (o.kind === 'stroke' && o.mode === 'highlighter');
              if (o.kind === 'stroke' || o.kind === 'erase'){
                applyStroke(ctx, style, isHighlight);
                if (o.kind === 'erase'){
                  ctx.globalAlpha = 1;
                  ctx.lineWidth = Math.max(10, (style.width ?? 4) * 3);
                }
                const pts = Array.isArray(o.points) ? o.points : [];
                if (pts.length){
                  ctx.beginPath();
                  ctx.moveTo(pts[0].x, pts[0].y);
                  for (let i=1;i<pts.length;i++) ctx.lineTo(pts[i].x, pts[i].y);
                  ctx.stroke();
                }
              } else if (o.kind === 'rect'){
                applyStroke(ctx, style, false);
                const mnx = Math.min(o.x1,o.x2), mny = Math.min(o.y1,o.y2);
                const rw = Math.abs(o.x2-o.x1), rh = Math.abs(o.y2-o.y1);
                ctx.strokeRect(mnx,mny,rw,rh);
              } else if (o.kind === 'ellipse'){
                applyStroke(ctx, style, false);
                const cx=(o.x1+o.x2)/2, cy=(o.y1+o.y2)/2;
                const rx=Math.abs(o.x2-o.x1)/2, ry=Math.abs(o.y2-o.y1)/2;
                ctx.beginPath();
                ctx.ellipse(cx,cy,Math.max(1,rx),Math.max(1,ry),0,0,Math.PI*2);
                ctx.stroke();
              } else if (o.kind === 'arrow'){
                applyStroke(ctx, style, false);
                drawArrow(ctx, o.x1,o.y1,o.x2,o.y2, style);
              } else if (o.kind === 'text'){
                const fs = o.fontSize ?? Math.max(14, (style.width ?? 4) * 4);
                ctx.globalAlpha = style.opacity ?? 1;
                ctx.fillStyle = style.color || '#ff4c4c';
                ctx.font = `${fs}px "NetflixSans", system-ui, sans-serif`;
                ctx.textBaseline = 'top';
                ctx.fillText(String(o.text||''), o.x, o.y);
              }
              ctx.restore();
            };
            (__qtAnnoObjects||[]).forEach(o=>{ try{ renderObj(octx, o); }catch{} });
            // overlay only; do not apply destination-out onto base image
            g.drawImage(oCan, 0, 0, w, h);
          }
        }
      }catch{}
      const dataUrl = canvas.toDataURL('image/jpeg', 0.88);

      // Save PNG still to disk (filename = shot name)
      try{
        const stem = safeFileStem(ctx.shotName || ctx.locShotName || 'STILL');
        const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        if (pngBlob){
          const pngUrl = URL.createObjectURL(pngBlob);
          try{
            if (chrome?.downloads?.download){
              chrome.downloads.download({
                url: pngUrl,
                filename: `${stem}.png`,
                saveAs: false
              }, () => {
                const err = chrome.runtime?.lastError?.message;
                if (err) try{ console.warn('PNG download error:', err); }catch{}
              });
            } else {
              const a = document.createElement('a');
              a.href = pngUrl;
              a.download = `${stem}.png`;
              a.click();
            }
          } finally {
            setTimeout(() => { try{ URL.revokeObjectURL(pngUrl); }catch{} }, 30000);
          }
        }
      } catch (e){
        try{ console.warn('PNG still save failed:', e); }catch{}
      }


      // Update thumb cache for this specific QT relPath
      try{ __thumbCache.set(String(ctx.qtKey), dataUrl); }catch{}

      // Update only the originating event card thumbnail immediately
      try{
        const el = ctx.thumbEl;
        el.style.backgroundImage = `url(${dataUrl})`;
        el.classList.add('has-thumb');
        el.dataset.thumbUpdated = '1';
      }catch{}

      setStatus(true, '✅ Updated');
      __toast(`Updated still: ${ctx.shotName || ''}`.trim());
    } catch (e){
      setStatus(false, '❌ Failed');
      try{ console.warn('Update Still failed:', e); }catch{}
    }
  };

  const uploadFlow = async () => {
    const ctx = __qtCtx || {};
    try{
      if (!ctx?.shotName || !ctx?.qtKey || !ctx?.qtFile) throw new Error("No active shot/QT context");
      setStatus(true, "⏳ Uploading…");

      // Resolve endpoint/token (stored for convenience; do NOT put ShotGrid keys in the extension)
      let endpoint = "";
      let token = "";
      try{ endpoint = (localStorage.getItem("mps.flow.endpoint") || "").trim(); }catch{}
      try{ token = (localStorage.getItem("mps.flow.token") || "").trim(); }catch{}

      if (!endpoint){
        endpoint = (prompt("Flow Upload Endpoint (backend URL)", "https://YOUR_BACKEND/flow/version/upload") || "").trim();
        try{ if (endpoint) localStorage.setItem("mps.flow.endpoint", endpoint); }catch{}
      }
      if (!endpoint) throw new Error("Missing endpoint");

      // Thumbnail: prefer user-updated cache; fall back to current card bg if present
      let dataUrl = null;
      try{ dataUrl = __thumbCache.get(String(ctx.qtKey)) || null; }catch{}
      if (!dataUrl){
        try{
          const bg = ctx?.thumbEl?.style?.backgroundImage || "";
          const m = bg.match(/url\(["']?(.*?)["']?\)/i);
          if (m && m[1]) dataUrl = m[1];
        }catch{}
      }
      if (!dataUrl) throw new Error("No thumbnail found (Update Still first)");

      const thumbBlob = await (await fetch(dataUrl)).blob();

      const projectKey = String(ctx.rootName || "VFX_ROOT");
      const shotCode = String(ctx.shotName || "");
      const versionCode = `${shotCode}_v001`; // backend can override/increment

      // Try to pass user email (if permission allowed)
      let userEmail = "";
      try{ userEmail = (await __getQTProfileEmail()) || ""; }catch{}

      const resp = await new Promise((resolve) => {
        try{
          chrome.runtime.sendMessage({
            type: "FLOW_UPLOAD_VERSION",
            endpoint,
            token,
            projectKey,
            shotCode,
            versionCode,
            userEmail,
            movieFile: ctx.qtFile,
            thumbBlob
          }, (r) => resolve(r || { ok:false, error:"No response" }));
        }catch(e){
          resolve({ ok:false, error: e?.message || String(e) });
        }
      });

      if (!resp || resp.ok === false){
        throw new Error(resp?.error || (resp?.data && typeof resp.data === "string" ? resp.data : "Upload failed"));
      }

      setStatus(true, "✅ Uploaded");
      __toast(`Uploaded to Flow: ${shotCode}`);
    }catch(e){
      setStatus(false, "❌ Upload failed");
      __toast(String(e?.message || e));
      try{ console.warn("Flow upload failed:", e); }catch{}
    }
  };

  // QT Modal Radial Menu (same UX as Marker/Review)
  // - Right-click on the viewer => radial quick tools
  // - Shift+Right-click => native browser context menu
  try{
    if (!m.__pfxQtRadialInstalled){
      m.__pfxQtRadialInstalled = true;
      const stageEl = m.querySelector('.mps-qt-stage') || m;

      const __qtFitViewer = () => {
        try{
          const v = m.querySelector('.mps-qt-video');
          const im = m.querySelector('.mps-qt-img');
          if (v){ v.style.objectFit = 'contain'; v.style.transform = 'none'; }
          if (im){ im.style.objectFit = 'contain'; im.style.transform = 'none'; }
        }catch{}
      };

      const __qtToggleFullscreen = async () => {
        try{
          const el = panel || stageEl;
          const d = document;
          const fsEl = d.fullscreenElement || d.webkitFullscreenElement;
          if (fsEl){
            const exit = d.exitFullscreen || d.webkitExitFullscreen;
            if (exit) await exit.call(d);
            return;
          }
          const req = el.requestFullscreen || el.webkitRequestFullscreen;
          if (req) await req.call(el);
        }catch{}
      };

      const qtRadial = createRadialMenu({
        ariaLabel: 'QT quick tools',
        radius: 72,
        pad: 120,
        getHost: () => (document.fullscreenElement || document.webkitFullscreenElement || document.body),
        actions: [
          { id: 'note',  title: 'Update Still (thumbnail)',  icon: RadialIcons.note,   onSelect: async()=>{ try{ await captureStill(); }catch{} } },
          { id: 'pen',   title: 'Annotate: Pen',             icon: RadialIcons.pen,    onSelect: async()=>{ await __qtOpenAnnotate('pen'); } },
          { id: 'arrow', title: 'Annotate: Arrow',           icon: RadialIcons.arrow,  onSelect: async()=>{ await __qtOpenAnnotate('arrow'); } },
          { id: 'circle',title: 'Annotate: Circle',          icon: RadialIcons.circle, onSelect: async()=>{ await __qtOpenAnnotate('circle'); } },
          { id: 'rect',  title: 'Annotate: Square',          icon: RadialIcons.rect,   onSelect: async()=>{ await __qtOpenAnnotate('rect'); } },
          { id: 'text',  title: 'Annotate: Text',            icon: RadialIcons.text,   onSelect: async()=>{ await __qtOpenAnnotate('text'); } },
          { id: 'play',  title: 'Play / Pause',              icon: () => (vEl && !vEl.paused ? RadialIcons.pause : RadialIcons.play), onSelect: async()=>{ try{ btnPlay?.click?.(); }catch{} } },
          { id: 'fit',   title: 'Fit Viewer',                icon: RadialIcons.fit,    onSelect: async()=>{ __qtFitViewer(); } },
          { id: 'full',  title: 'Fullscreen',                icon: RadialIcons.full,   onSelect: async()=>{ await __qtToggleFullscreen(); } },
          { id: 'upload',title: 'Upload Flow',               icon: RadialIcons.export, onSelect: async()=>{ await uploadFlow(); } },
        ],
      });

      const __qtCtxOk = (e) => {
        try{
          let t = e?.target || null;
          if (t && t.nodeType === 3) t = t.parentElement;
          if (!t || !t.closest) return false;
          if (t.closest('.sm-anno-modal')) return false;
          return !!t.closest('.mps-qt-stage');
        }catch{
          return false;
        }
      };

      const onCtx = (e) => {
        if (!e) return;
        if (e.shiftKey) return;
        if (!__qtCtxOk(e)) return;
        try{ if (e.cancelable) e.preventDefault(); }catch{}
        try{ e.stopPropagation(); }catch{}
        // UX: when quick-tools radial menu opens, stop playback (same as Marker/Review)
        try{ if (vEl && !vEl.paused) vEl.pause(); }catch{}
        try{ qtRadial.openAt(e.clientX, e.clientY); }catch{}
      };

      const onPtr = (e) => {
        if (!e || e.shiftKey) return;
        const isRight = (e.button === 2);
        const isCtrlClick = (e.button === 0 && !!e.ctrlKey && !e.metaKey);
        if (!isRight && !isCtrlClick) return;
        if (!__qtCtxOk(e)) return;
        try{ if (e.cancelable) e.preventDefault(); }catch{}
        try{ e.stopPropagation(); }catch{}
        // UX: when quick-tools radial menu opens, stop playback (same as Marker/Review)
        try{ if (vEl && !vEl.paused) vEl.pause(); }catch{}
        try{ qtRadial.openAt(e.clientX, e.clientY); }catch{}
      };

      try{ stageEl.addEventListener('contextmenu', onCtx, true); }catch{}
      try{ stageEl.addEventListener('pointerdown', onPtr, true); }catch{}
      try{ m.__pfxQtRadial = qtRadial; }catch{}
    }
  }catch{}


  m.addEventListener('click', (e) => {
    const u = e.target?.closest?.('.mps-qt-update');
    const up = e.target?.closest?.('.mps-qt-upload');
    if (u){
      captureStill();
      return;
    }
    if (up){
      uploadFlow();
      return;
    }
  });

  // Guard: ignore close() calls within this window after open. Prevents the
  // click that opened the modal (or any synthesized/bubbled event landing on
  // the freshly-mounted backdrop) from immediately closing it.
  const QT_OPEN_GRACE_MS = 280;
  let __qtClosing = false;
  let __qtMouseDownOnBackdrop = false;

  const close = (opts) => {
    if (__qtClosing) return;
    if (!m.classList.contains("show")) return;
    const force = !!(opts && opts.force);
    if (!force) {
      const openedAt = Number(m.__qtOpenedAt || 0);
      if (openedAt && (performance.now() - openedAt) < QT_OPEN_GRACE_MS) return;
    }
    __qtClosing = true;
    try{
      const v = m.querySelector(".mps-qt-video");
      const im = m.querySelector(".mps-qt-img");
      const err = m.querySelector(".mps-qt-err");
      const wm = m.querySelector(".mps-qt-watermark");
      const st = m.querySelector(".mps-qt-status");
      if (v){ releasePlayableVideo(v); v.style.display = "none"; }  // releases blob ref + pipeline
      if (im){ im.removeAttribute("src"); im.style.display = "none"; }
      if (err) err.textContent = "";
      if (wm){ wm.textContent = ""; wm.style.display = "none"; }
      if (st){ st.textContent = ""; st.classList.remove('show','ok','bad'); }
      // Reset annotate UI (keep saved shapes in localStorage)
      try{ __annoSetEnabled(false); }catch{}
      try{ if (annoCtx && annoCanvas) annoCtx.clearRect(0,0,annoCanvas.width, annoCanvas.height); }catch{}
      if (__qtModalUrl){ try{ URL.revokeObjectURL(__qtModalUrl); }catch{}; __qtModalUrl = null; }
    } catch {}
    __qtCtx = null;
    m.classList.remove("show");
    __qtClosing = false;
  };

  // Track mousedown target so a press-inside-drag-out doesn't count as a
  // backdrop click. click() fires on the nearest common ancestor of mousedown
  // and mouseup — if you press inside the panel and release on the backdrop
  // the click target is `m`, which would otherwise trip the close path.
  m.addEventListener("mousedown", (e) => {
    __qtMouseDownOnBackdrop = (e.target === m);
  }, true);

  m.addEventListener("click", (e) => {
    const closeBtn = e.target?.closest?.(".mps-qt-close");
    if (closeBtn){ e.stopPropagation(); close(); return; }
    if (e.target === m && __qtMouseDownOnBackdrop) close();
    __qtMouseDownOnBackdrop = false;
  });

  // Defensive: any click that originates inside the panel must not reach
  // the backdrop handler. This is belt-and-braces on top of the e.target
  // check above, and protects against synthesized/dispatched click events
  // that don't carry a matching mousedown.
  const __qtPanel = m.querySelector(".mps-qt-panel");
  if (__qtPanel){
    __qtPanel.addEventListener("click", (e) => { e.stopPropagation(); });
    __qtPanel.addEventListener("mousedown", (e) => { e.stopPropagation(); });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!m.classList.contains("show")) return;
    // Don't hijack Escape while the user is typing in a field — that should
    // cancel the field's edit first. Inputs INSIDE the modal also get
    // priority so number/frame inputs behave normally.
    const ae = document.activeElement;
    const tag = ae && ae.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || ae?.isContentEditable) return;
    close();
  });
  m.__close = close;
  // Expose annotate helpers for __openQTFromFile (preload per-shot shapes for the shared Annotate modal)
  try{
    m.__annoLoad = __qtAnnoLoad;
  }catch{}
  return m;
}

function __toast(msg=""){
  if (!msg) return;
  // Prefer the shared toast. The div below emits class="mps-toast", which no
  // stylesheet in src/ defined until now — so for as long as this function has
  // existed its messages have been unstyled text at the bottom of the document,
  // and `.show` toggled a class with no rule behind it.
  try{
    if (typeof window !== "undefined" && typeof window.pfxToast?.show === "function"){
      window.pfxToast.show(msg);
      return;
    }
  }catch{}
  try{
    let t = document.getElementById("mpsToast");
    if (!t){
      t = document.createElement("div");
      t.id = "mpsToast";
      t.className = "mps-toast";
      document.body.appendChild(t);
    }
    t.textContent = String(msg);
    t.classList.add("show");
    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => t.classList.remove("show"), 2200);
  } catch {}
}

function __openQTFromFile(file, kind="vid", title="QT Preview", ctx=null){
  if (!file) return;
  const m = __ensureQTModal();
  const ttl = m.querySelector(".mps-qt-title");
  if (ttl) ttl.textContent = title;
  // Reset status box every time the modal opens
  try{
    const st = m.querySelector('.mps-qt-status');
    if (st){ st.textContent = ''; st.classList.remove('show','ok','bad'); }
  }catch{}
  __qtCtx = ctx ? { ...ctx, kind } : null;
  if (__qtCtx){ __qtCtx.fps = 24; }
  // Watermark (email of Chrome profile, if available)
  __applyQTWatermark(m);

  // Preload any saved annotations for this shot (so Update Still + PDF can include them)
  try{ if (typeof m.__annoLoad === 'function') m.__annoLoad(); }catch{}
  const v = m.querySelector(".mps-qt-video");
  const im = m.querySelector(".mps-qt-img");
  const err = m.querySelector(".mps-qt-err");
  if (err) err.textContent = "";

  // Release previous video element state (handles blob URL ref + pipeline abort).
  if (v) releasePlayableVideo(v);
  // __qtModalUrl still tracks the blob URL used for image previews; cleared on modal close.
  if (__qtModalUrl){ try{ URL.revokeObjectURL(__qtModalUrl); }catch{}; __qtModalUrl = null; }

  const ctrls = m.querySelector(".mps-qt-controls");
  if (kind === "img"){
    if (ctrls) ctrls.style.display = "none";
    if (v){ try{ v.pause(); }catch{}; v.style.display = "none"; }
    if (im){
      __qtModalUrl = URL.createObjectURL(file);
      im.style.display = "block";
      im.src = __qtModalUrl;
    }
  } else {
    if (ctrls) ctrls.style.display = "flex";
    if (im){ im.style.display = "none"; }
    if (v){
      v.style.display = "block";
      if (err) err.textContent = "";

      // Status label in the .mps-qt-err span (used as a non-blocking status area here).
      const _showStatus = (label) => {
        if (!err) return;
        if (label === PLAYABLE_STATUS.direct || label === PLAYABLE_STATUS.proxy) {
          err.textContent = '';
        } else {
          err.textContent = label;
        }
      };

      attachPlayableVideo(v, file, {
        onStatus: _showStatus,
        onMode: (mode) => {
          if (mode === 'direct' || mode === 'proxy' || mode === 'restored-proxy') {
            if (err) err.textContent = '';
            try { v.play(); } catch {}
          }
        },
        onProxyFail: (hint) => {
          if (err) err.textContent = `⚠️ ${hint}`;
        },
      });
    }
  }

  // Stamp open time before showing — the close handler's grace window reads
  // this to refuse closes that arrive within ~280ms of open (the click that
  // triggered the open, late bubbles, synthesized events, etc.).
  m.__qtOpenedAt = performance.now();
  m.classList.add("show");
}

// -----------------------------
// Shared state (so ui.js can read last scan result for Native Host .aep export)
// -----------------------------
let __lastFiles = [];
let __lastResult = null;
let __clearUIFn = null;

function __setLastScan(files, result){
  try{
    __lastFiles = Array.isArray(files) ? files : Array.from(files || []);
  } catch {
    __lastFiles = [];
  }
  __lastResult = result || null;
}

export function getLastFiles(){ return __lastFiles; }
export function getLastResult(){ return __lastResult; }

// -----------------------------
// Shot selection (VFX Mapping table)
// -----------------------------
let __selectedShotSet = new Set();
let __selectedRootKey = "";

// Compute stats for a subset of shots (used for "export selected only")
function __statsFromShots(shotsArr){
  const arr = Array.isArray(shotsArr) ? shotsArr : [];
  const shots = arr.length;
  const ready = arr.filter(s => s?.flags?.ready).length;
  const missing = shots - ready;
  const missingShot = arr.filter(s => !s?.flags?.hasSeq).length;
  const missingLook = arr.filter(s => !s?.flags?.hasLook).length;
  const missingEDL  = arr.filter(s => !s?.flags?.hasEDL).length;
  return { shots, ready, missing, missingShot, missingLook, missingEDL };
}

function __resetSelectionFor(result){
  const r = result || __lastResult;
  const root = String(r?.rootName || "");
  __selectedRootKey = root;
  __selectedShotSet = new Set((r?.shots || []).filter(s => !!s?.flags?.hasSeq).map(s => s.shotName));
}

export function getSelectedShotNames(){
  return Array.from(__selectedShotSet || []);
}

export function getSelectedResult(){
  const r = __lastResult;
  if (!r) return null;

  // If root changed, reset selection to all for the new result
  const root = String(r?.rootName || "");
  if (root && __selectedRootKey && root !== __selectedRootKey){
    __resetSelectionFor(r);
  }
  if (!__selectedRootKey && root){
    __selectedRootKey = root;
  }
  if (!__selectedShotSet || __selectedShotSet.size === 0){
    return { ...r, shots: [], stats: __statsFromShots([]) };
  }
  const shots = r?.shots || [];
  if (__selectedShotSet.size === shots.length){
    return r;
  }
  const filtered = shots.filter(s => __selectedShotSet.has(s.shotName));
  return { ...r, shots: filtered, stats: __statsFromShots(filtered) };
}

// Clear VFX folder selection + mapping state (and Native VFX Root/Base in localStorage)
// Used by ui.js and the VFX Mapping tab "Clear" button.
export function clearVFXMapping(){
  try {
    localStorage.removeItem("mps.amf.nativeRoot");
    localStorage.removeItem("mps.amf.nativeBase");
  } catch {}

  // Also forget the persisted directory handle so refresh/reopen does not
  // immediately restore a folder the user explicitly cleared.
  try{ __vfxDirHandle = null; }catch{}
  try{ clearNamedHandle(__VFX_DIR_HANDLE_KEY); }catch{}

  if (typeof __clearUIFn === "function"){
    return __clearUIFn();
  }

  __setLastScan([], null);
  try { updateNativeRootRow("-"); } catch {}
  return true;
}

// -----------------------------
// Utils
// -----------------------------
function normSlash(p = "") {
  return String(p || "").replace(/\\/g, "/");
}
function baseName(p = "") {
  const s = normSlash(p);
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(i + 1) : s;
}
function dirName(p = "") {
  const s = normSlash(p);
  const i = s.lastIndexOf("/");
  return i >= 0 ? s.slice(0, i) : "";
}
function stem(p = "") {
  const b = baseName(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(0, i) : b;
}

// -----------------------------
// LOC helpers
// -----------------------------
// LOC format (from our EDL exporter):
//   LOC: <TC> <COLOR> <SHOTNAME>
// We use <SHOTNAME> as the primary comp name when exporting AE/Nuke.
function parseLocShotName(locLine){
  if(!locLine) return null;
  const line = String(locLine).trim();
  const m = line.match(/^LOC:\s*(\S+)\s+(\S+)\s+(.+)$/i);
  if(!m) return null;
  const name = (m[3] || "").trim();
  return name || null;
}

function extractFirstLocShotName(edlHits){
  try{
    for (const hit of (edlHits || [])){
      for (const b of (hit?.matches || [])){
        for (const c of (b?.comments || [])){
          if (/^LOC:/i.test(String(c))) {
            const n = parseLocShotName(c);
            if (n) return n;
          }
        }
      }
    }
  } catch {}
  return null;
}
function ext(p = "") {
  const b = baseName(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
}
function escHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
  );
}
function pad(n, w) {
  const s = String(n);
  return s.length >= w ? s : "0".repeat(w - s.length) + s;
}
function clampNum(x, a, b) {
  const v = Number(x);
  if (!Number.isFinite(v)) return a;
  return Math.max(a, Math.min(b, v));
}
function tcToFrames(tc, fps) {
  // Drop-frame EDLs use "HH:MM:SS;FF" — normalise the semicolon to a colon
  // so DF timecodes still match instead of returning 0.
  const m = String(tc || "").replace(/;/g, ':').match(/^(\d+):(\d+):(\d+):(\d+)$/);
  if (!m) return 0;
  const hh = +m[1], mm = +m[2], ss = +m[3], ff = +m[4];
  // fps may be the raw fractional NTSC rate (23.976/29.97/59.94); timecode's
  // FF field always counts against the nominal whole-frame base (24/30/60),
  // not the fractional rate itself.
  return ((hh * 3600 + mm * 60 + ss) * nominalBase(fps)) + ff;
}

function normalizeDownloadPath(filename, fallback = "export.txt"){
  const raw = String(filename || fallback).replace(/\\/g, "/");
  const parts = raw.split("/").filter(Boolean).map(seg => {
    const clean = String(seg || "")
      .replace(/[<>:"|?*\r\n\t]+/g, "_")
      .replace(/^\.+$/, "_")
      .trim();
    return clean || "_";
  });
  return parts.length ? parts.join("/") : String(fallback || "export.txt");
}

function downloadText(filename, content, mime = "text/plain") {
  const rel = normalizeDownloadPath(filename, "export.txt");
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);

  if (chrome?.downloads?.download){
    try{
      chrome.downloads.download({ url, filename: rel, saveAs: false }, () => {
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      });
      return;
    }catch(e){
      console.warn("downloadText(downloads API) failed:", e);
    }
  }

  const a = document.createElement("a");
  a.href = url;
  a.download = rel.split("/").pop() || "export.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function downloadBytes(filename, u8, mime = "application/octet-stream") {
  try{
    const rel = normalizeDownloadPath(filename, "download.bin");
    const blob = new Blob([u8], { type: mime });
    const url = URL.createObjectURL(blob);

    if (chrome?.downloads?.download){
      try{
        chrome.downloads.download({ url, filename: rel, saveAs: false }, () => {
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        });
        return;
      }catch(e){
        console.warn("downloadBytes(downloads API) failed:", e);
      }
    }

    const a = document.createElement("a");
    a.href = url;
    a.download = rel.split("/").pop() || "download.bin";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }catch(e){
    console.warn("downloadBytes failed:", e);
  }
}

function safeFileStem(name, fallback="VFX_Mapping") {
  const base = String((name ?? "")).trim() || String(fallback || "VFX_Mapping");
  return base
    .replace(/[\\\/\:\*\?\"\<\>\|\r\n\t]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "VFX_Mapping";
}

// Nuke node/variable identifiers must be short, ASCII-ish, and never empty.
// We also want stability across exports, so we include a small hash suffix.
function __djb2Hash(str){
  let h = 5381;
  const s = String(str || '');
  for (let i=0;i<s.length;i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return (h >>> 0).toString(36);
}
function nukeSafeId(name, fallback='SHOT'){
  const raw = String(name ?? '').trim() || String(fallback || 'SHOT');
  let base = raw
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) base = String(fallback || 'SHOT');
  if (/^\d/.test(base)) base = `S_${base}`;
  // Keep it short for stack vars; add hash to avoid collisions.
  const h = __djb2Hash(raw);
  base = base.slice(0, 42);
  return `${base}_${h}`.slice(0, 64);
}

function __shotStemFromAny(str){
  const s = String(str||'');
  const m = s.match(/([A-Za-z0-9]+_\d{3}_\d{3})/);
  return m ? m[1] : '';
}
function getShotStem(shot, index=0){
  const cand = [shot?.shotName, shot?.locShotName, shot?.compName, shot?.name];
  for (const c of cand){
    const stem = __shotStemFromAny(c);
    if (stem) return stem;
    const t = String(c||'').trim();
    if (t && !/\s/.test(t) && t.length <= 64) return t;
  }
  return `SHOT_${index||0}`;
}

function safeCompName(name, fallback="MASTER_TIMELINE") {
  const base = String((name ?? "")).trim() || String(fallback || "MASTER_TIMELINE");
  return base
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[\\\/]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "MASTER_TIMELINE";
}

function relFromRoot(file) {
  const wp = normSlash(file?.webkitRelativePath || file?.virtualPath || file?.name || "");
  if (!wp.includes("/")) return wp;
  const parts = wp.split("/");
  parts.shift(); // remove root folder segment
  return parts.join("/");
}
function rootNameFromFiles(files) {
  for (const f of files || []) {
    const wp = normSlash(f?.webkitRelativePath || f?.virtualPath || "");
    if (wp.includes("/")) return wp.split("/")[0];
  }
  return "VFX_ROOT";
}

// -----------------------------
// Native VFX Root (Auto) - keep UI + localStorage in sync with chosen folder
// - Chrome folder picker cannot expose absolute paths. We derive absolute root by
//   combining a user-provided BASE path (stored in localStorage) with rootName.
// - On every Choose VFX Folder selection, we update the UI row immediately.
// -----------------------------
function __getLS(key){
  try { return localStorage.getItem(key) || ""; } catch { return ""; }
}
function __setLS(key, val){
  try { localStorage.setItem(key, val); } catch {}
}

function trimSlashEnd(p=""){
  const s = normSlash(p).trim();
  if (/^[A-Za-z]:\/$/.test(s)) return s;
  return s.replace(/\/+$/g, "");
}
function joinPath(a="", b=""){
  const aa = trimSlashEnd(a);
  const bb = normSlash(b).replace(/^\/+/, "");
  if (!aa) return bb;
  if (!bb) return aa;
  return aa + "/" + bb;
}
function dirOnly(p=""){
  const s = trimSlashEnd(p);
  const i = s.lastIndexOf("/");
  if (i < 0) return "";
  if (i === 0) return "/";
  return s.slice(0, i);
}
function updateNativeRootRow(text){
  const el = document.getElementById("amfNativeRootText");
  if (el) el.textContent = text || "-";
}

// Compute + persist "Native VFX Root (Auto)" for a given rootName.
// Returns computed absolute root string, or "" when base is unknown.
function autoSyncNativeRootFor(rootName){
  const rn = String(rootName || "").trim();
  if (!rn){
    updateNativeRootRow(__getLS("mps.amf.nativeRoot") || "-");
    return "";
  }

  let base = trimSlashEnd(__getLS("mps.amf.nativeBase"));
  let curRoot = trimSlashEnd(__getLS("mps.amf.nativeRoot"));

  // If base not set yet, derive from existing nativeRoot.
  if (!base && curRoot){
    const last = curRoot.split("/").pop() || "";
    if (last === rn) base = dirOnly(curRoot) || "";
    else base = curRoot; // treat stored nativeRoot as a BASE folder
  }

  if (!base){
    // No base known yet: show selected folder name only (no prompt).
    __setLS("mps.amf.rootName", rn);
    updateNativeRootRow(rn);
    return "";
  }

  const next = joinPath(base, rn);
  __setLS("mps.amf.nativeBase", base);
  __setLS("mps.amf.nativeRoot", next);
  updateNativeRootRow(next);
  return next;
}

// -----------------------------
// ASC CDL parsing (best effort)
// returns { slope:[r,g,b], offset:[r,g,b], power:[r,g,b], sat:number } or null
// Works for .amf/.cdl/.cc by regex (does NOT require valid XML)
// -----------------------------
function parseVec3(text) {
  const t = String(text || "").trim();
  const parts = t.split(/[,\s]+/g).filter(Boolean).slice(0, 3).map(Number);
  if (parts.length !== 3 || parts.some(v => !Number.isFinite(v))) return null;
  return parts;
}

function regexTagValue(xml, tagNames) {
  const names = Array.isArray(tagNames) ? tagNames : [tagNames];
  for (const tn of names) {
    const re = new RegExp(
      String.raw`<[^>]*\b${tn}\b[^>]*>([^<]+)</[^>]*\b${tn}\b[^>]*>`,
      "i"
    );
    const m = String(xml || "").match(re);
    if (m && m[1]) return String(m[1]).trim();
  }
  return "";
}

function parseTextToCDL(anyText = "") {
  const txt = String(anyText || "");

  // Try common CDL tag variants (with or without namespaces)
  const slopeT =
    regexTagValue(txt, ["Slope", "slope"]) ||
    regexTagValue(txt, ["ASC_SOP", "asc_sop"]); // sometimes contains 9 numbers; we handle below

  const offsetT = regexTagValue(txt, ["Offset", "offset"]);
  const powerT = regexTagValue(txt, ["Power", "power"]);
  let satT = regexTagValue(txt, ["Saturation", "saturation", "Sat", "sat", "ASC_SAT", "asc_sat"]);

  // If ASC_SOP contains 9 numbers (slope offset power), parse accordingly
  // ASC_SOP usually: "sR sG sB oR oG oB pR pG pB"
  if (slopeT && !offsetT && !powerT) {
    const nums = slopeT.split(/[,\s]+/g).filter(Boolean).map(Number).filter(Number.isFinite);
    if (nums.length >= 9) {
      const slope = nums.slice(0, 3);
      const offset = nums.slice(3, 6);
      const power = nums.slice(6, 9);
      const sat = Number.isFinite(+satT) ? +satT : 1.0;
      return {
        slope: slope.map(v => clampNum(v, -1000, 1000)),
        offset: offset.map(v => clampNum(v, -1000, 1000)),
        power: power.map(v => clampNum(v, 0.0001, 1000)),
        sat: clampNum(sat, 0, 10),
      };
    }
  }

  const slope = slopeT ? parseVec3(slopeT) : null;
  const offset = offsetT ? parseVec3(offsetT) : null;
  const power = powerT ? parseVec3(powerT) : null;

  let sat = satT ? Number(String(satT).trim()) : NaN;
  if (!Number.isFinite(sat)) sat = 1.0;

  if (!slope || !offset || !power) return null;

  return {
    slope: slope.map(v => clampNum(v, -1000, 1000)),
    offset: offset.map(v => clampNum(v, -1000, 1000)),
    power: power.map(v => clampNum(v, 0.0001, 1000)),
    sat: clampNum(sat, 0, 10),
  };
}

// -----------------------------

// -----------------------------
// AMF parsing (ACES 2.0) helpers
// - Extracts applied LMT looks and CDL values from .amf
// - Designed for OCIO workflows (Nuke 13/14/15+)
// -----------------------------
function _camelToWords(s){
  return String(s||"")
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function guessOcioLookNameFromAMF(desc, transformId){
  const tid = String(transformId||"");
  // Special-case: ACES Reference Gamut Compression LMT name varies between AMF and OCIO configs.
  // Most studio configs expose it as: "ACES 1.3 Reference Gamut Compression"
  if (/ReferenceGamutCompress/i.test(tid)) return 'ACES 1.3 Reference Gamut Compression';

  const d = String(desc||"").trim();
  if (d) return d;


  // e.g. urn:ampas:aces:transformId:v1.5:LMT.Academy.ReferenceGamutCompress.a1.v1.0
  const m = tid.match(/\bLMT\.[^.]+\.([^\.]+)\b/i) || tid.match(/\bLMT\.[^\.]+\.([^\.]+)\./i);
  if (m && m[1]) return _camelToWords(m[1]);

  // fallback: last token
  const tail = tid.split(/[.:]/).pop();
  return _camelToWords(tail);
}

function parseAMFMeta(amfText = ""){
  const txt = String(amfText||"");
  if (!txt) return null;

  const blocks = txt.match(/<aces:lookTransform\b[\s\S]*?<\/aces:lookTransform>/gi) || [];

  const looksAll = [];
  const looksApplied = [];

  let cdl = null;
  let cdlApplied = false;
  let cdlWorkingSpace = null;

  for (const b of blocks) {
    const appliedAttr = (b.match(/\bapplied\s*=\s*"(true|false)"/i) || [])[1];
    const applied = (appliedAttr ? appliedAttr.toLowerCase() !== 'false' : true);

    const transformId = regexTagValue(b, ["transformId"]) || "";
    const desc = regexTagValue(b, ["description"]) || "";

    // LMT look
    if (/\bLMT\./i.test(transformId) || /\bLMT\./i.test(desc)) {
      const lookName = guessOcioLookNameFromAMF(desc, transformId);
      if (lookName) {
        looksAll.push(lookName);
        if (applied) looksApplied.push(lookName);
      }
    }

    // CDL (SOP/Sat)
    if (!cdl && /<cdl:SOPNode\b/i.test(b)) {
      cdl = parseTextToCDL(b);
      cdlApplied = !!applied;

      // Try to infer the CDL working space (usually ACEScct)
      const wsDesc = (b.match(/<aces:toCdlWorkingSpace>[\s\S]*?<aces:description>([^<]+)<\/aces:description>/i) || [])[1];
      if (wsDesc) {
        const m = String(wsDesc).match(/\bto\s+([^\s]+)\s*$/i);
        if (m && m[1]) cdlWorkingSpace = String(m[1]).trim();
      }
    }
  }

  // Fallback: CDL may exist without SOPNode namespace match
  if (!cdl) {
    const c = parseTextToCDL(txt);
    if (c) {
      cdl = c;
      cdlApplied = true;
    }
  }

  return {
    looksAll: looksAll.filter(Boolean),
    looksApplied: looksApplied.filter(Boolean),
    cdl,
    cdlApplied,
    cdlWorkingSpace
  };
}


function parseAMFOutputInfo(amfText = ""){
  const txt = String(amfText||"");
  if (!txt) return null;
  const outBlock = (txt.match(/<aces:outputTransform\b[\s\S]*?<\/aces:outputTransform>/i) || [])[0] || "";
  if (!outBlock) return null;
  const appliedAttr = (outBlock.match(/\bapplied\s*=\s*"(true|false)"/i) || [])[1];
  const applied = (appliedAttr ? appliedAttr.toLowerCase() !== 'false' : true);
  const rrtDesc = (outBlock.match(/<aces:referenceRenderingTransform[\s\S]*?<aces:description>([^<]+)<\/aces:description>/i) || [])[1] || "";
  const rrtId   = (outBlock.match(/<aces:referenceRenderingTransform[\s\S]*?<aces:transformId>([^<]+)<\/aces:transformId>/i) || [])[1] || "";
  const odtDesc = (outBlock.match(/<aces:outputDeviceTransform[\s\S]*?<aces:description>([^<]+)<\/aces:description>/i) || [])[1] || "";
  const odtId   = (outBlock.match(/<aces:outputDeviceTransform[\s\S]*?<aces:transformId>([^<]+)<\/aces:transformId>/i) || [])[1] || "";
  return { applied, rrtDesc, rrtId, odtDesc, odtId };
}

function parseAMFInputInfo(amfText = ""){
  const txt = String(amfText||"");
  if (!txt) return null;
  const inBlock = (txt.match(/<aces:inputTransform\b[\s\S]*?<\/aces:inputTransform>/i) || [])[0] || "";
  if (!inBlock) return null;
  const appliedAttr = (inBlock.match(/\bapplied\s*=\s*"(true|false)"/i) || [])[1];
  const applied = (appliedAttr ? appliedAttr.toLowerCase() !== 'false' : true);
  const desc = (inBlock.match(/<aces:description>([^<]+)<\/aces:description>/i) || [])[1] || "";
  const id   = (inBlock.match(/<aces:transformId>([^<]+)<\/aces:transformId>/i) || [])[1] || "";
  return { applied, desc, id };
}
// EDL parsing (CMX3600-ish)
// -----------------------------
function parseEDLBlocks(edlText = "") {
  const lines = String(edlText || "").split(/\r?\n/);
  const blocks = [];
  let cur = null;

  let title = null;

  // CMX3600-ish: <num> <reel> V C <srcIn> <srcOut> <recIn> <recOut>
  const evRe = /^\s*(\d+)\s+(\S+)\s+V\s+C\s+(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})\s+(\d{2}:\d{2}:\d{2}:\d{2})/;
  const titleRe = /^\s*TITLE\s*:\s*(.+?)\s*$/i;

  const speedStaticRe = /^\*\s*SPEED\s*:\s*([0-9.]+)\s*%/i;
  const speedDynAvgRe = /^\*\s*SPEED\s*:\s*DYNAMIC\s*\(\s*AVG\s*([0-9.]+)\s*%\s*\)/i;

  const transformRe = /^\*\s*TRANSFORM\s*:\s*(.+?)\s*$/i;
  const extraRe = /^\*\s*EXTRA\s*:\s*(.+?)\s*$/i;

  const finalize = (b) => {
    if (!b) return;
    if (Array.isArray(b.transformVals)) {
      const v = b.transformVals.map(x => String(x || "").trim()).filter(Boolean);
      b.transformVal = v.length ? v.join(" | ") : null;
    } else {
      b.transformVal = null;
    }
    if (Array.isArray(b.extraVals)) {
      const v = b.extraVals.map(x => String(x || "").trim()).filter(Boolean);
      b.extraVal = v.length ? v.join(" | ") : null;
    } else {
      b.extraVal = null;
    }
  };

  for (const ln of lines) {
    const mt = ln.match(titleRe);
    if (mt && !title) {
      title = String(mt[1] || "").trim();
      continue;
    }

    const m = ln.match(evRe);
    if (m) {
      if (cur) { finalize(cur); blocks.push(cur); }
      cur = {
        num: m[1],
        reel: m[2],
        srcIn: m[3],
        srcOut: m[4],
        recIn: m[5],
        recOut: m[6],
        comments: [],
        speedPct: 100,
        speedIsDynamic: false,
        speedRaw: null,
        transformVals: [],
        extraVals: [],
        transformVal: null,
        extraVal: null
      };
      continue;
    }

    if (cur) {
      const t = ln.trim();
      if (!t) continue;
      cur.comments.push(t);

      // TRANSFORM / EXTRA (may appear more than once)
      const mx = t.match(transformRe);
      if (mx) {
        cur.transformVals.push(String(mx[1] || "").trim());
        continue;
      }
      const me = t.match(extraRe);
      if (me) {
        cur.extraVals.push(String(me[1] || "").trim());
        continue;
      }

      // Parse speed from comment lines
      const md = t.match(speedDynAvgRe);
      if (md) {
        const pct = parseFloat(md[1]);
        if (Number.isFinite(pct)) {
          cur.speedPct = pct;
          cur.speedIsDynamic = true;
          cur.speedRaw = t;
        }
        continue;
      }
      const ms = t.match(speedStaticRe);
      if (ms) {
        const pct = parseFloat(ms[1]);
        if (Number.isFinite(pct)) {
          cur.speedPct = pct;
          cur.speedIsDynamic = false;
          cur.speedRaw = t;
        }
        continue;
      }
    }
  }

  if (cur) { finalize(cur); blocks.push(cur); }
  if (title) blocks.title = title;
  return blocks;
}


function matchBlocksForShot(blocks, shotName) {
  const key = String(shotName || "");
  if (!key) return [];

  const lowKey = key.toLowerCase();
  return (blocks || []).filter(b => {
    const reel = String(b.reel || "").toLowerCase();
    if (reel === lowKey || reel.includes(lowKey)) return true;
    for (const c of (b.comments || [])) {
      if (String(c).toLowerCase().includes(lowKey)) return true;
    }
    return false;
  });
}

// -----------------------------
// Sequence grouping
// -----------------------------
function detectShotNameFromRelPath(relPath) {
  const p = normSlash(relPath);
  const m = p.match(/(?:^|\/)EXR_Files\/([^\/]+)\//i);
  if (m) return m[1];

  // Fallback: top-level folder name as shot (common structure: <SHOT>/...frames...)
  if (p.includes("/")) {
    const seg = (p.split("/")[0] || "").trim();
    const bad = /^(look_files|attached_files|edl|edls|edl_files|editorial|plate(s)?|element(s)?|temp|ref(s)?)$/i;
    if (seg && !seg.startsWith(".") && !bad.test(seg)) {
      return seg;
    }
  }

  return "";
}

async function groupSequences(files) {
  // Optimized: avoid storing every frame record + sorting (can freeze UI on long sequences).
  // We only track min/max frame and count per (dir+prefix+ext+padding) group.
  // Async: yields every 5000 files to keep UI responsive on large VFX folders.
  const groups = new Map();
  const allFiles = files || [];

  for (let fi = 0; fi < allFiles.length; fi++) {
    // Yield to UI thread every 5000 files to prevent jank on large folders
    if (fi > 0 && fi % 5000 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }

    const f = allFiles[fi];
    const rp = relFromRoot(f);
    const e = ext(rp);
    if (!SEQ_EXT.has(e)) continue;

    const bn = baseName(rp);
    const m = bn.match(/^(.*?)(\d+)\.(exr|dpx|tif|tiff)$/i);
    if (!m) continue;

    const prefix = m[1];
    const frameStr = m[2];
    const padding = frameStr.length;
    const frame = parseInt(frameStr, 10);
    if (!Number.isFinite(frame)) continue;

    const dir = dirName(rp);
    let shotName = detectShotNameFromRelPath(rp);

    if (!shotName) {
      shotName = String(prefix).replace(/[._-]+$/g, "");
    }
    if (!shotName) shotName = "SHOT";

    const key = `${dir}::${prefix}::${e}::${padding}`;

    if (!groups.has(shotName)) groups.set(shotName, new Map());
    const byKey = groups.get(shotName);

    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, { dir, prefix, ext: e, padding, start: frame, end: frame, count: 1 });
    } else {
      cur.count += 1;
      if (frame < cur.start) cur.start = frame;
      if (frame > cur.end) cur.end = frame;
    }
  }

  const out = new Map();
  for (const [shot, byKey] of groups.entries()) {
    let best = null;
    for (const g of byKey.values()) {
      const start = g.start ?? 0;
      const end = g.end ?? 0;
      const count = g.count ?? 0;

      const patternNuke = `${g.dir}/${g.prefix}%0${g.padding}d.${g.ext}`;
      const firstFile = `${g.dir}/${g.prefix}${pad(start, g.padding)}.${g.ext}`;

      const seq = {
        shotName: shot,
        dir: g.dir,
        prefix: g.prefix,
        ext: g.ext,
        padding: g.padding,
        start,
        end,
        count,
        firstFileRel: firstFile,
        patternRel: patternNuke
      };

      if (!best || count > best.count) best = seq;
    }
    if (best) out.set(shot, best);
  }
  return out;
}

// -----------------------------
// Look files
// -----------------------------
function collectLookFiles(files) {
  const lookMap = new Map();

  const rels = (files || []).map(f => ({ f, rp: relFromRoot(f) }));
  for (const { f, rp } of rels) {
    const e = ext(rp);
    if (!LOOK_PRIORITY.includes(e)) continue;

    const inLookFolder = /(?:^|\/)Look_Files\//i.test(normSlash(rp));
    if (!inLookFolder) continue;

    const s = stem(rp);
    if (!s) continue;

    const cur = lookMap.get(s);
    const pri = LOOK_PRIORITY.indexOf(e);

    if (!cur) {
      lookMap.set(s, { shotName: s, relPath: rp, type: e, priority: pri, file: f, cdl: null });
    } else {
      if (pri < cur.priority) {
        lookMap.set(s, { shotName: s, relPath: rp, type: e, priority: pri, file: f, cdl: null });
      }
    }
  }

  return lookMap;
}

// -----------------------------
// EDL detection
// -----------------------------
async function collectEDLFiles(files) {
  const edls = [];
  for (const f of files || []) {
    const rp = relFromRoot(f);
    if (ext(rp) !== "edl") continue;
    edls.push({ f, rp, name: baseName(rp) });
  }
  return edls;
}

function pickRootEDL(edls) {
  const list = Array.isArray(edls) ? edls.slice() : [];
  if (!list.length) return null;

  // Prefer EDLs living in Attached_Files (common Netflix CH export pattern)
  const inAttached = list.find(x => /(?:^|\/)Attached_Files\//i.test(normSlash(x.rp)));
  if (inAttached) return inAttached;

  // Then prefer root-level (direct under chosen folder)
  const direct = list.find(x => !normSlash(x.rp).includes("/"));
  if (direct) return direct;

  // Then prefer an EDL folder
  const inEdlDir = list.find(x => /(?:^|\/)EDL(s)?\//i.test(normSlash(x.rp)));
  if (inEdlDir) return inEdlDir;

  // Fallback: first found
  return list[0] || null;
}

function pickShotEDL(edls, shotName) {
  const low = String(shotName || "").toLowerCase();
  const exact = (edls || []).find(x => stem(x.name).toLowerCase() === low);
  if (exact) return exact;
  const incl = (edls || []).find(x => x.name.toLowerCase().includes(low));
  return incl || null;
}

async function resolveEDLForShot(edls, rootEdl, shotName) {
  const shotEdl = pickShotEDL(edls, shotName);
  if (shotEdl) {
    const txt = await shotEdl.f.text();
    const blocks = parseEDLBlocks(txt);
    const hits = matchBlocksForShot(blocks, shotName);
    return { relPath: shotEdl.rp, mode: "per-shot", hits };
  }

  if (rootEdl) {
    const txt = await rootEdl.f.text();
    const blocks = parseEDLBlocks(txt);
    const hits = matchBlocksForShot(blocks, shotName);
    if (hits.length) {
      return { relPath: rootEdl.rp, mode: "root-match", hits };
    }
  }

  return null;
}

// -----------------------------
// Public: scan
// -----------------------------
export async function scanVFXFolder(files, opts = {}) {
  const fps = Number(opts.fps) || DEFAULT_FPS;
  const onProgress = (opts && typeof opts.onProgress === "function") ? opts.onProgress : null;
  const totalFiles = Array.isArray(files) ? files.length : 0;

  const rootName = rootNameFromFiles(files);
  await __reportImportProgress(onProgress, {
    phase: 'prepare',
    state: 'work',
    main: 'Importing VFX Folder…',
    sub: `Preparing ${totalFiles} files`,
    done: 0,
    total: Math.max(totalFiles, 1),
    percent: 0,
    rootName
  }, 1);

    const relFileMap = new Map();
  for (const f of (files || [])) relFileMap.set(relFromRoot(f), f);
  const seqByShot = await groupSequences(files);
  await __reportImportProgress(onProgress, {
    phase: 'group-sequences',
    state: 'work',
    main: 'Importing VFX Folder…',
    sub: `Grouping sequences • ${seqByShot.size} shots`,
    done: 0,
    total: Math.max(seqByShot.size, 1),
    percent: 0,
    rootName
  }, 1);
  const lookByStem = collectLookFiles(files);
  await __reportImportProgress(onProgress, {
    phase: 'collect-looks',
    state: 'work',
    main: 'Importing VFX Folder…',
    sub: `Collecting looks • ${lookByStem.size} candidates`,
    rootName
  }, 1);
  const edls = await collectEDLFiles(files);
  await __reportImportProgress(onProgress, {
    phase: 'collect-edl',
    state: 'work',
    main: 'Importing VFX Folder…',
    sub: `Reading EDL • ${edls.length} file${edls.length === 1 ? '' : 's'}`,
    rootName
  }, 1);
  const rootEdl = pickRootEDL(edls);
  const __qt = collectQTRefs(files);
  await __reportImportProgress(onProgress, {
    phase: 'collect-previews',
    state: 'work',
    main: 'Importing VFX Folder…',
    sub: `Collecting previews • ${__qt?.raw?.size || 0} refs`,
    rootName
  }, 1);

  // Cache root EDL blocks once (huge speedup vs re-reading per shot)
  let rootEdlRel = null;
  let rootBlocks = null;
  let edlTitle = null;
  if (rootEdl) {
    rootEdlRel = rootEdl.rp;
    try {
      const txt = await rootEdl.f.text();
      rootBlocks = parseEDLBlocks(txt);
      edlTitle = rootBlocks && rootBlocks.title ? String(rootBlocks.title) : null;
    } catch {
      rootBlocks = null;
    }
  }

  const shots = [];

  const shotNames = new Set();
  for (const k of seqByShot.keys()) shotNames.add(k);
  for (const k of lookByStem.keys()) shotNames.add(k);

  // Cache per-shot EDL parses (rp -> blocks)
  const edlBlocksCache = new Map();

  let idx = 0;
  const __groupKeyOf = (shotName) => {
    const s = String(shotName || "").trim();
    const parts = s.split(/[_\s]+/).filter(Boolean);
    // Group shot policy:
    // Example: HSM_104_001_010_PL01_v001 -> HSM_104_001
    // Fallback: first 2 tokens.
    if (parts.length >= 3) return (parts[0] + "_" + parts[1] + "_" + parts[2]);
    if (parts.length >= 2) return (parts[0] + "_" + parts[1]);
    return s;
  };

  const __pickQTForShot = (shotName) => {
    try{
      const sn = String(shotName || "");
      if (!sn) return null;

      const shotKey = __normKey(sn);
      const groupKey = __normKey(__groupKeyOf(sn));

      let best = null;
      let bestScore = -1;

      const vals = (__qt?.raw?.values?.() ? __qt.raw.values() : []);
      for (const v of vals){
        if (!v || !v.file) continue;

        // Hard filter: must have *some* relation to shot (stem or path)
        const relKey = __normKey(v.relLower || v.relPath || "");
        const stemKey = v.stemKey || __normKey(v.stem || "");
        const relates =
          (stemKey && shotKey && (stemKey.includes(shotKey) || shotKey.includes(stemKey))) ||
          (relKey && shotKey && relKey.includes(shotKey));
        if (!relates) continue;

        let score = 0;

        if (stemKey === shotKey) score += 100;
        else if (stemKey && shotKey && stemKey.startsWith(shotKey)) score += 85;
        else if (stemKey && shotKey && stemKey.includes(shotKey)) score += 70;
        else score += 30;

        if (v.isQtHint) score += 30;

        if (groupKey && relKey && relKey.includes(groupKey)) score += 12;

        // Prefer images, then mp4, then mov
        if (v.kind === "img") score += 18;
        if (v.ext === "mp4" || v.ext === "m4v") score += 10;
        if (v.ext === "mov") score += 6;

        // Prefer "smaller" preview files when tie (often proxies)
        const size = Number(v.size || 0);
        if (size && size < 80_000_000) score += 4; // <80MB

        if (score > bestScore){
          bestScore = score;
          best = v;
        } else if (score === bestScore && best && size && best.size && size < best.size){
          best = v;
        }
      }

      return best || null;
    } catch {
      return null;
    }
  };

  // ── Pre-fetch all look files + EDL files + EXR metadata in parallel ──────────
  // This converts N sequential awaits in the loop into one parallel batch,
  // giving a 3-5x speedup for large (100+) shot folders.
  const sortedShotNames = Array.from(shotNames).sort();

  // 1. Pre-read all unique look files
  const lookTextCache = new Map(); // shotName -> text
  {
    const lookEntries = [];
    for (const sn of sortedShotNames) {
      const look = lookByStem.get(sn) || lookByStem.get(String(sn).replace(/\s+/g, "")) || null;
      if (look && (look.type === "amf" || look.type === "cdl" || look.type === "cc") && look.file && !look.cdl) {
        lookEntries.push({ sn, look });
      }
    }
    // Limit concurrency: avoid saturating Chrome I/O with 100+ simultaneous reads
    const texts = await __pooledAllSettled(lookEntries, e => e.look.file.text(), 16);
    texts.forEach((r, i) => {
      if (r.status === 'fulfilled') lookTextCache.set(lookEntries[i].sn, r.value);
    });
  }

  // 2. Pre-read all unique EDL files (supplement the existing edlBlocksCache)
  {
    const edlEntries = [];
    const seenEdlRp = new Set();
    for (const sn of sortedShotNames) {
      const shotEdl = pickShotEDL(edls, sn);
      if (shotEdl && !edlBlocksCache.has(shotEdl.rp) && !seenEdlRp.has(shotEdl.rp)) {
        seenEdlRp.add(shotEdl.rp);
        edlEntries.push({ rp: shotEdl.rp, f: shotEdl.f });
      }
    }
    // EDL files are small but still cap concurrency for consistency
    const texts = await __pooledAllSettled(edlEntries, e => e.f.text(), 16);
    texts.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        const blocks = parseEDLBlocks(r.value);
        edlBlocksCache.set(edlEntries[i].rp, blocks);
        if (!edlTitle && blocks && blocks.title) edlTitle = String(blocks.title);
      }
    });
  }

  // 3. Pre-extract EXR metadata for all sequences in parallel
  const exrMetaCache = new Map(); // shotName -> meta|null
  {
    const exrEntries = [];
    for (const sn of sortedShotNames) {
      const seq = seqByShot.get(sn) || null;
      if (seq?.firstFileRel) {
        const f = relFileMap ? relFileMap.get(seq.firstFileRel) : null;
        if (f) exrEntries.push({ sn, f });
      }
    }
    // EXR reads: each reads up to 1MB. Cap at 6 concurrent to avoid freezing Chrome.
    const metas = await __pooledAllSettled(exrEntries, e => __extractCamLensFromEXRFile(e.f), 6);
    metas.forEach((r, i) => {
      exrMetaCache.set(exrEntries[i].sn, r.status === 'fulfilled' ? r.value : null);
    });
  }
  // ─────────────────────────────────────────────────────────────────────────────

  for (const shotName of sortedShotNames) {
    const seq = seqByShot.get(shotName) || null;

    // Apply pre-fetched EXR metadata (replaces sequential await per shot)
    try{
      const existing = __getCamLens(rootName, shotName);
      const hasAny = Object.values(existing || {}).some(v => String(v || "").trim() !== "");
      if (!hasAny && exrMetaCache.has(shotName)){
        const meta = exrMetaCache.get(shotName);
        if (meta) for (const k of ["cam","lens","focal","tstop","focus"]) if (meta[k]) __setCamLensField(rootName, shotName, k, meta[k]);
      }
    }catch{}

    const look =
      lookByStem.get(shotName) ||
      lookByStem.get(String(shotName).replace(/\s+/g, "")) ||
      null;

    // Best-effort: parse look once (AMF: extract LMT+CDL; CDL/CC: parse CDL)
    if (look && (look.type === "amf" || look.type === "cdl" || look.type === "cc") && look.file && !look.cdl) {
      try {
        const t = lookTextCache.get(shotName) ?? await look.file.text();
        if (look.type === "amf") {
          const meta = parseAMFMeta(t);
          if (meta) {
            if (meta.cdl) look.cdl = meta.cdl;
            if (meta.cdlWorkingSpace) look.cdlWorkingSpace = meta.cdlWorkingSpace;
            if (Array.isArray(meta.looksApplied) && meta.looksApplied.length) look.amfLooks = meta.looksApplied.slice();
            if (Array.isArray(meta.looksAll) && meta.looksAll.length) look.amfLooksAll = meta.looksAll.slice();
            look.amfCdlApplied = !!meta.cdlApplied;
            // AMF IO transforms (for Nuke graph preview)
            const inInfo = parseAMFInputInfo(t);
            if (inInfo){
              look.amfInputDesc = inInfo.desc || "";
              look.amfInputId = inInfo.id || "";
              look.amfInputApplied = !!inInfo.applied;
            }
            const outInfo = parseAMFOutputInfo(t);
            if (outInfo){
              look.amfRrtDesc = outInfo.rrtDesc || "";
              look.amfRrtId = outInfo.rrtId || "";
              look.amfOdtDesc = outInfo.odtDesc || "";
              look.amfOdtId = outInfo.odtId || "";
              look.amfOutputApplied = !!outInfo.applied;
            }

          } else {
            const cdl = parseTextToCDL(t);
            if (cdl) look.cdl = cdl;
          }
        } else {
          const cdl = parseTextToCDL(t);
          if (cdl) look.cdl = cdl;
        }
      } catch {
        // ignore
      }
    }

    // Resolve EDL: prefer per-shot EDL; else root-match using cached blocks
    let edl = null;
    const shotEdl = pickShotEDL(edls, shotName);

    if (shotEdl) {
      try {
        const rp = shotEdl.rp;
        let blocks = edlBlocksCache.get(rp);
        if (!blocks) {
          // Fallback: pre-fetch cache miss (rare after parallel pre-fetch above)
          const txt = await shotEdl.f.text();
          blocks = parseEDLBlocks(txt);
          edlBlocksCache.set(rp, blocks);
          if (!edlTitle && blocks && blocks.title) edlTitle = String(blocks.title);
        }
        const hits = matchBlocksForShot(blocks, shotName);
        edl = { relPath: rp, mode: "per-shot", hits };
      } catch {
        edl = null;
      }
    } else if (rootBlocks && rootEdlRel) {
      const hits = matchBlocksForShot(rootBlocks, shotName);
      if (hits.length) {
        edl = { relPath: rootEdlRel, mode: "root-match", hits };
      }
    }

    const ready = !!(seq && look && edl && edl.hits && edl.hits.length);
    const hasSeq = !!seq;
    const hasLook = !!look;
    const hasEDL = !!(edl && edl.hits && edl.hits.length);

    // Primary comp name should follow LOC shotName when available.
    const locShotName = extractFirstLocShotName(edl && edl.hits ? edl.hits : null);
    const compName = locShotName || shotName;

    const qt = __pickQTForShot(shotName);

    shots.push({
      shotName,
      locShotName,
      compName,
      seq,
      look,
      edl,
      qt,
      flags: { hasSeq, hasLook, hasEDL, ready }
    });

    // Keep UI responsive for large folders
    idx += 1;
    if (onProgress && (idx === 1 || idx % 8 === 0 || idx === shotNames.size)) {
      const readySoFar = shots.reduce((acc, s) => acc + (s?.flags?.ready ? 1 : 0), 0);
      const pct = __progressPercent(idx, shotNames.size || 1);
      await __reportImportProgress(onProgress, {
        phase: 'match-shots',
        state: 'work',
        main: `Importing VFX Folder… ${pct}%`,
        sub: `Matching shots ${idx}/${shotNames.size || 0} • Ready ${readySoFar}`,
        done: idx,
        total: shotNames.size || 0,
        percent: pct,
        currentShot: shotName,
        rootName
      }, 1);
    }
    if (idx % 40 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  const readyCount = shots.filter(s => s.flags.ready).length;
  const missingCount = shots.length - readyCount;

  // Missing breakdown (counts are per-category; a shot can be counted in multiple categories)
  const missingShot = shots.filter(s => !s.flags.hasSeq).length;
  const missingLook = shots.filter(s => !s.flags.hasLook).length;
  const missingEDL  = shots.filter(s => !s.flags.hasEDL).length;

  const stats = {
    shots: shots.length,
    ready: readyCount,
    missing: missingCount,
    missingShot,
    missingLook,
    missingEDL
  };

  const result = {
    rootName,
    fps,
    edlTitle,
    edlRoot: rootEdlRel,
    shots,
    stats
  };

  await __reportImportProgress(onProgress, {
    phase: 'done',
    state: 'ok',
    main: '✅ Imported VFX Folder',
    sub: `${stats.ready}/${stats.shots} ready • Missing ${stats.missing}`,
    done: stats.shots,
    total: stats.shots,
    percent: 100,
    rootName
  }, 1);

  __resetSelectionFor(result);
  __setLastScan(files, result);
  return result;
}

// -----------------------------
// UI helpers: table
// -----------------------------

export function buildMappingTableHTML(result, opts={}) {
  const r = result || {};
  const shots = Array.isArray(r.shots) ? r.shots : [];
  const selectedSet = (opts && opts.selectedSet instanceof Set) ? opts.selectedSet : null;
  const groupOpen = (opts && opts.groupOpen instanceof Map) ? opts.groupOpen : null;

  if (!shots.length) {
    return `<div class="amf-empty muted">No shots found.</div>`;
  }

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, m => ({
    "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"
  }[m]));

  // Group key: HSM_104_001_010_PL01_v001 -> HSM_104_001
  const groupKeyOf = (shotName) => {
    const s = String(shotName || "").trim();
    const parts = s.split(/[_\s]+/).filter(Boolean);
    if (parts.length >= 3) return parts[0] + "_" + parts[1] + "_" + parts[2];
    if (parts.length >= 2) return parts[0] + "_" + parts[1];
    return s;
  };

  const statusDot = (ok, label) => {
    const cls = ok ? "ok" : "miss";
    return `<span class="vfx-dot ${cls}"></span><span class="vfx-dot-label">${esc(label)}</span>`;
  };

  const lineDotClass = (ok) => (ok ? "ok" : "miss");
  const vfxMiniIcon = (name) => {
    const icons = {
      seq: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 7h12"/><path d="M6 12h12"/><path d="M6 17h8"/><circle cx="4.5" cy="7" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="4.5" cy="17" r="1" fill="currentColor" stroke="none"/></svg>',
      edl: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10"/><path d="M4 12h16"/><path d="M4 17h10"/><path d="M17 8v8"/><path d="M14.5 10.5 17 8l2.5 2.5"/></svg>',
      look: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4c4.2 0 7.6 3.6 7.6 8 0 3-2.4 5.4-5.3 5.4h-1.1a1.3 1.3 0 0 0-1.2 1.8 1.9 1.9 0 0 1-1.8 2.8C6.2 22 4 19.1 4 15.5 4 9.2 8.3 4 12 4Z"/></svg>',
      upload: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V7"/><path d="M8.5 10.5 12 7l3.5 3.5"/><path d="M5 19h14"/></svg>',
      camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="8" width="12" height="8" rx="2"/><path d="M16 10 20 8v8l-4-2"/></svg>',
      lens: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/></svg>',
      focal: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7"/><path d="M12 5v3"/><path d="M12 16v3"/><path d="M5 12h3"/><path d="M16 12h3"/></svg>',
      tstop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M7 8h10"/></svg>',
      focus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5H5v4"/><path d="M15 5h4v4"/><path d="M19 15v4h-4"/><path d="M5 15v4h4"/></svg>',
      speed: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 16a7 7 0 1 1 12 0"/><path d="M12 12l4-2"/></svg>',
      transform: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z"/><path d="M7 3v4H3"/><path d="M17 3v4h4"/><path d="M7 21v-4H3"/><path d="M17 21v-4h4"/></svg>',
      handles: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 8v8"/><path d="M17 8v8"/><path d="M10 12h4"/></svg>',
      note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H10l-4 3v-3H7a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/></svg>'
    };
    return `<span class="vfx-ico" aria-hidden="true">${icons[name] || ''}</span>`;
  };

  const lineVal = (s) => {
    const v = String(s || "").trim();
    return v ? esc(v) : "—";
  };

  const __uniq = (arr) => {
    const out = [];
    const seen = new Set();
    for (const v of (arr || [])) {
      const s = String(v ?? "").trim();
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push(s);
    }
    return out;
  };

  const __trimMid = (s, max = 72) => {
    const t = String(s || "");
    if (t.length <= max) return t;
    return t.slice(0, max - 1) + "…";
  };

  const __fmtPct = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return "";
    const r = Math.round(x * 100) / 100;
    return (Math.abs(r - Math.round(r)) < 1e-9) ? String(Math.round(r)) : String(r);
  };

  const __mixedText = (vals, opts = {}) => {
    const maxShow = Number.isFinite(opts.maxShow) ? opts.maxShow : 3;
    const trimTo = Number.isFinite(opts.trimTo) ? opts.trimTo : 72;

    const u = __uniq(vals);
    if (!u.length) return { text: "—", mixed: false };
    if (u.length === 1) return { text: __trimMid(u[0], trimTo), mixed: false };

    const show = u.slice(0, Math.max(1, maxShow)).map(v => __trimMid(v, trimTo));
    const more = u.length - show.length;
    const tail = more > 0 ? ` | +${more}` : "";
    return { text: `Mixed (${u.length}): ${show.join(" | ")}${tail}`, mixed: true };
  };

  const __summarizeEDLMeta = (hits) => {
    const list = Array.isArray(hits) ? hits : [];
    if (!list.length) {
      return {
        speed: { text: "—", mixed: false },
        transform: { text: "—", mixed: false },
        extra: { text: "—", mixed: false }
      };
    }

    const speedVals = [];
    const xformVals = [];
    const extraVals = [];

    for (const b of list) {
      // SPEED
      const pct = (b && Number.isFinite(Number(b.speedPct))) ? Number(b.speedPct) : 100;
      const isDyn = !!b?.speedIsDynamic;
      const sp = isDyn ? `DYNAMIC (AVG ${__fmtPct(pct)}%)` : `${__fmtPct(pct)}%`;
      speedVals.push(sp);

      // TRANSFORM
      if (b?.transformVal) {
        xformVals.push(String(b.transformVal));
      } else {
        for (const c of (b?.comments || [])) {
          const m = String(c || "").match(/^\*\s*TRANSFORM\s*:\s*(.+?)\s*$/i);
          if (m) xformVals.push(String(m[1] || "").trim());
        }
      }

      // EXTRA (Handles+)
      if (b?.extraVal) {
        extraVals.push(String(b.extraVal));
      } else {
        for (const c of (b?.comments || [])) {
          const m = String(c || "").match(/^\*\s*EXTRA\s*:\s*(.+?)\s*$/i);
          if (m) extraVals.push(String(m[1] || "").trim());
        }
      }
    }

    return {
      speed: __mixedText(speedVals, { maxShow: 4, trimTo: 60 }),
      transform: __mixedText(xformVals, { maxShow: 2, trimTo: 84 }),
      extra: __mixedText(extraVals, { maxShow: 2, trimTo: 76 })
    };
  };

  // Preserve scan order while grouping
  const groups = new Map();
  for (const s of shots) {
    const g = groupKeyOf(s.shotName || "");
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }

  const total = shots.length;
  const totalSelectable = shots.filter(s => !!s?.flags?.hasSeq).length;
  const selectedCount = selectedSet ? selectedSet.size : totalSelectable;

  const rows = [];

  for (const [g, gShots] of groups.entries()) {
    const gEsc = esc(g);
    const open = groupOpen ? !!groupOpen.get(g) : false; // default collapsed
    const caretClass = open ? "is-open" : "is-closed";

    // Group checkbox state from selectedSet (only selectable shots = hasSeq)
    const gSelectable = gShots.filter(s => !!s?.flags?.hasSeq);
    const gTotalSel = gSelectable.length;

    let gChecked = false;
    let gInd = false;
    if (selectedSet) {
      let sel = 0;
      for (const s of gSelectable) { if (selectedSet.has(s.shotName)) sel++; }
      gChecked = (gTotalSel > 0 && sel === gTotalSel);
      gInd = (sel > 0 && sel < gTotalSel);
    }
    const gCheckedAttr = gChecked ? "checked" : "";
    const gIndAttr = gInd ? "data-ind=\"1\"" : "";
    const gDisAttr = (gTotalSel === 0) ? "disabled" : "";

    rows.push(`
      <tr class="amf-group-row" data-group="${gEsc}" data-open="${open ? 1 : 0}">
        <td class="c-check"><input type="checkbox" class="amf-group-check" data-group="${gEsc}" ${gCheckedAttr} ${gIndAttr} ${gDisAttr}></td>
        <td class="c-shot mono">
          <span class="amf-group-caret ${caretClass}" aria-hidden="true"></span>
          <span class="amf-group-label">${gEsc}</span>
          <span class="amf-group-meta"> (${gShots.length})</span>
        </td>
      </tr>
    `);

    for (const s of gShots) {
      const name = esc(s.shotName || "");
      // IMPORTANT: compute flags BEFORE using them (avoid TDZ issues)
      const hasSeq  = !!s?.flags?.hasSeq;
      const hasEDL  = !!s?.flags?.hasEDL;
      const hasLook = !!s?.flags?.hasLook;

      const isSelectable = hasSeq;
      const checked = isSelectable
        ? (selectedSet ? (selectedSet.has(s.shotName) ? "checked" : "") : "checked")
        : "";
      const disAttr = isSelectable ? "" : "disabled";
      const noSeqCls = isSelectable ? "" : "is-no-seq";

      const qtKind = String(s?.qt?.kind || ""); // 'vid' | 'img' | ''
      const qtClass = (qtKind === "vid") ? "qt-video" : (qtKind === "img" ? "qt-image" : "");

      const patternFull = normSlash(s?.seq?.patternRel || "");
      const patternDisp = baseName(patternFull);

      const edlFull = normSlash(s?.edl?.relPath || "");
      const edlDisp = baseName(edlFull);

      // Look can be from scan, or a user override (custom upload)
      const customLookName = String(s?.look?.customName || "").trim();
      const lookFull = normSlash(s?.look?.relPath || "");
      const lookDisp = customLookName || baseName(lookFull);

      const startF = Number(s?.seq?.start);
      const endF = Number(s?.seq?.end);
      const totalFrames = (Number.isFinite(startF) && Number.isFinite(endF) && endF >= startF)
        ? (endF - startF) + 1
        : null;

      const rootName = r.rootName || r.edlTitle || "VFX_ROOT";
      const taskVal = esc(__getScopeOfWork(rootName, s));

      const camLens = __getCamLens(rootName, s.shotName);
      const camVal = esc(camLens.cam || "—");
      const lensVal = esc(camLens.lens || "—");
      const focalVal = esc(camLens.focal || "—");
      const tVal = esc(camLens.tstop || "—");
      const focusVal = esc(camLens.focus || "—");

      const edlHits = Array.isArray(s?.edl?.hits) ? s.edl.hits : [];
      const edlMeta = __summarizeEDLMeta(edlHits);

      const spTxt = esc(edlMeta.speed.text);
      const xfTxt = esc(edlMeta.transform.text);
      const exTxt = esc(edlMeta.extra.text);

      const spCls = edlMeta.speed.mixed ? "is-mixed" : "";
      const xfCls = edlMeta.transform.mixed ? "is-mixed" : "";
      const exCls = edlMeta.extra.mixed ? "is-mixed" : "";

      rows.push(`
        <tr class="amf-child-row ${noSeqCls}" data-group="${gEsc}" data-shot="${name}" style="${open ? "" : "display:none"}">
          <td class="c-check">
            <input type="checkbox" class="amf-shot-check" data-shot="${name}" data-group="${gEsc}" ${checked} ${disAttr}>
          </td>
          <td class="c-shot vfx-card-cell" colspan="1">
            <div class="vfx-shotcard ${noSeqCls}">
              <div class="vfx-left">
                <div class="vfx-thumb ${qtClass}" data-shot="${name}" data-qt-kind="${esc(qtKind)}" title="Click to preview QT Ref (if available)"><div class="vfx-thumb-play" aria-hidden="true"></div></div>
              </div>

              <div class="vfx-mid vfx-info-card">
                <div class="vfx-title-row">
                  <div class="vfx-title mono">${name}</div>
                  <div class="vfx-frames mono">${totalFrames ? `(${esc(totalFrames)} fr)` : ""}</div>
                </div>

                <div class="vfx-status-lines mono">
                  <div class="vfx-line">
                    <span class="vfx-dot ${lineDotClass(hasSeq)}"></span>
                    <span class="lbl">${vfxMiniIcon('seq')}Seq :</span>
                    <span class="val">${lineVal(patternDisp)}</span>
                  </div>
                  <div class="vfx-line">
                    <span class="vfx-dot ${lineDotClass(hasEDL)}"></span>
                    <span class="lbl">${vfxMiniIcon('edl')}EDL :</span>
                    <span class="val">${lineVal(edlDisp)}</span>
                  </div>
                  <div class="vfx-line">
                    <span class="vfx-dot ${lineDotClass(hasLook)}"></span>
                    <span class="lbl">${vfxMiniIcon('look')}Look :</span>
                    <span class="val">${lineVal(lookDisp)}</span>
                  </div>
                </div>

                <div class="vfx-info-actions">
                  <button class="vfx-upload-btn" type="button" data-shot="${name}"><span class="vfx-btn-label">${vfxMiniIcon('upload')}Upload Look</span></button>
                  <span class="vfx-upload-hint">→ Look_Files/custom</span>
                  <input class="vfx-upload-input" data-shot="${name}" type="file" accept=".amf,.cc,.cdl,.cube" style="display:none" />
                </div>
              </div>

              <div class="vfx-camlens-card" data-shot="${name}">
                <div class="vfx-camlens-row">
                  <span class="vfx-camlens-k">${vfxMiniIcon('camera')}Cam:</span>
                  <span class="vfx-camlens-v mono" data-field="cam">${camVal}</span>
                  <button class="vfx-pill" type="button" data-shot="${name}" data-field="cam" title="Edit">-</button>
                </div>
                <div class="vfx-camlens-row">
                  <span class="vfx-camlens-k">${vfxMiniIcon('lens')}Lens:</span>
                  <span class="vfx-camlens-v mono" data-field="lens">${lensVal}</span>
                  <button class="vfx-pill" type="button" data-shot="${name}" data-field="lens" title="Edit">-</button>
                </div>
                <div class="vfx-camlens-row" style="margin-bottom:0">
                  <span class="vfx-camlens-k">${vfxMiniIcon('focal')}Focal:</span>
                  <span class="vfx-camlens-v mono" data-field="focal">${focalVal}</span>
                  <button class="vfx-pill" type="button" data-shot="${name}" data-field="focal" title="Edit">-</button>
                  <span class="vfx-camlens-k" style="width:auto">${vfxMiniIcon('tstop')}T:</span>
                  <span class="vfx-camlens-v mono" style="flex:0 0 auto" data-field="tstop">${tVal}</span>
                  <button class="vfx-pill" type="button" data-shot="${name}" data-field="tstop" title="Edit">-</button>
                  <span class="vfx-camlens-k" style="width:auto">${vfxMiniIcon('focus')}Focus:</span>
                  <span class="vfx-camlens-v mono" style="flex:1 1 auto" data-field="focus">${focusVal}</span>
                  <button class="vfx-pill" type="button" data-shot="${name}" data-field="focus" title="Edit">-</button>
                </div>

                <div class="vfx-edlmeta">
                  <div class="vfx-edlmeta-row">
                    <span class="vfx-edlmeta-k">${vfxMiniIcon('speed')}SPEED:</span>
                    <span class="vfx-edlmeta-v mono ${spCls}">${spTxt}</span>
                  </div>
                  <div class="vfx-edlmeta-row">
                    <span class="vfx-edlmeta-k">${vfxMiniIcon('transform')}TRANSFORM:</span>
                    <span class="vfx-edlmeta-v mono ${xfCls}">${xfTxt}</span>
                  </div>
                  <div class="vfx-edlmeta-row">
                    <span class="vfx-edlmeta-k">${vfxMiniIcon('handles')}Handles:</span>
                    <span class="vfx-edlmeta-v mono ${exCls}">${exTxt}</span>
                  </div>
                </div>
              </div>

              <div class="vfx-right">
                <div class="vfx-task-label">${vfxMiniIcon('note')}Scope of Work</div>
                <textarea class="vfx-task-input" data-shot="${name}" placeholder="Scope of Work">${taskVal}</textarea>
              </div>
            </div>
          </td>
        </tr>
      `);
    }
  }

  return `
    <div class="amf-table-meta muted">
      <span id="amfShotSelMeta">Selected ${selectedCount} / ${totalSelectable}</span>
      <span class="amf-edl-title">EDL Title: ${esc(r.edlTitle || '-' )}</span>
    </div>
    <table class="amf-table amf-vfx-cards">
      <thead>
        <tr>
          <th class="c-check" title="Select / Deselect all">
            <input type="checkbox" id="amfShotSelAll" aria-label="Select all shots">
          </th>
          <th class="c-shot">Shot</th>
        </tr>
      </thead>
      <tbody>
        ${rows.join('')}
      </tbody>
    </table>
  `;
}

// -----------------------------
// Export: Mapping JSON
// -----------------------------
export function exportMappingJSON(result) {
  const payload = {
    generatedAt: new Date().toISOString(),
    rootName: result?.rootName || "VFX_ROOT",
    fps: result?.fps || DEFAULT_FPS,
    edlRoot: result?.edlRoot || null,
    stats: result?.stats || {},
    shots: (result?.shots || []).map(s => ({
      shotName: s.shotName,
      seq: s.seq,
      look: s.look ? {
        relPath: s.look.relPath,
        type: s.look.type,
        cdl: s.look.cdl || null,
        cdlWorkingSpace: s.look.cdlWorkingSpace || null,
        amfLooks: Array.isArray(s.look.amfLooks) ? s.look.amfLooks.slice() : null,
        amfLooksAll: Array.isArray(s.look.amfLooksAll) ? s.look.amfLooksAll.slice() : null,
        amfCdlApplied: (typeof s.look.amfCdlApplied === "boolean") ? s.look.amfCdlApplied : null
      } : null,
      edl: s.edl ? {
        relPath: s.edl.relPath,
        mode: s.edl.mode,
        hits: (s.edl.hits || []).map(h => ({
          num: h.num, reel: h.reel, srcIn: h.srcIn, srcOut: h.srcOut, recIn: h.recIn, recOut: h.recOut,
          speedPct: (Number(h.speedPct) || 100), speedIsDynamic: !!h.speedIsDynamic, speedRaw: h.speedRaw || null
        }))
      } : null,
      flags: s.flags
    }))
  };
  downloadText("VFX_mapping.json", JSON.stringify(payload, null, 2), "application/json");
}


function getAEPHandoffContext(result){
  const base = result || __lastResult || null;
  if (!base) throw new Error("No Plate Link result.");

  const full = (__lastResult && Array.isArray(__lastResult.shots)) ? __lastResult : null;
  let shots = Array.isArray(base?.shots) ? base.shots : [];
  if ((!shots || shots.length === 0) && full && Array.isArray(full.shots) && full.shots.length){
    shots = full.shots;
  }

  const fps = base?.fps || full?.fps || DEFAULT_FPS;
  const rootName = String(base?.rootName || full?.rootName || 'VFX_ROOT');
  const edlTitle = safeCompName(base?.edlTitle || full?.edlTitle || rootName || 'MASTER_TIMELINE');
  const tlStem = safeFileStem(edlTitle || rootName || 'VFX_Project');

  return { base, full, shots, fps, rootName, edlTitle, tlStem };
}

function __aepSharedOutputNames(ctx){
  const tlStem = String(ctx?.tlStem || 'VFX_Project');
  const masterDir = '00_MASTER';
  const readmeName = `${tlStem}_AEP_README.txt`;
  const manifestName = `${tlStem}_AEP_BatchManifest.json`;
  return {
    masterDir,
    shotsDir: '01_SHOTS',
    watchName: 'PostFlowX_AE_WatchFolder.jsx',
    watchRelPath: `${masterDir}/PostFlowX_AE_WatchFolder.jsx`,
    panelName: 'PostFlowX_AE_Panel.jsx',
    panelRelPath: `${masterDir}/PostFlowX_AE_Panel.jsx`,
    queueName: 'PostFlowX_AE_QueueRenderComps.jsx',
    queueRelPath: `${masterDir}/PostFlowX_AE_QueueRenderComps.jsx`,
    installName: 'Install_PostFlowX_AE_Panel.command',
    installRelPath: `${masterDir}/Install_PostFlowX_AE_Panel.command`,
    readmeName,
    readmeRelPath: `${masterDir}/${readmeName}`,
    manifestName,
    manifestRelPath: `${masterDir}/${manifestName}`
  };
}

function __aepShotLabel(shot, index){
  return safeCompName(
    shot?.compName || shot?.locShotName || shot?.shotName || `SHOT_${index+1}`,
    `SHOT_${index+1}`
  );
}

function __aepUniqueStem(raw, usedStems, fallback='SHOT'){
  const used = (usedStems && typeof usedStems.add === 'function') ? usedStems : new Set();
  let baseStem = safeFileStem(raw || '', fallback);
  if (!baseStem) baseStem = safeFileStem(fallback || 'SHOT', 'SHOT');
  let out = baseStem;
  let n = 2;
  while (used.has(String(out).toLowerCase())){
    out = `${baseStem}_${n++}`;
  }
  used.add(String(out).toLowerCase());
  return out;
}

function buildAEPHandoffJob(result, opts={}){
  const ctx = opts?.ctx || getAEPHandoffContext(result);
  let shots = Array.isArray(opts?.shots) ? opts.shots : ctx.shots;
  if ((!shots || shots.length === 0) && Array.isArray(ctx.shots) && ctx.shots.length){
    shots = ctx.shots;
  }

  const shared = __aepSharedOutputNames(ctx);
  const stemSuffix = opts?.stemSuffix ? __aepUniqueStem(opts.stemSuffix, opts?.usedStems, opts?.fallbackStem || 'SHOT') : '';
  const outputStem = stemSuffix ? safeFileStem(`${ctx.tlStem}_${stemSuffix}`, ctx.tlStem) : ctx.tlStem;
  const exportMode = String(opts?.exportMode || (stemSuffix ? 'per-shot' : 'timeline'));
  const derivedTitle = stemSuffix ? safeCompName(`${ctx.edlTitle}_${stemSuffix}`, ctx.edlTitle) : ctx.edlTitle;
  const packageDir = __trimEdgeSlashLike(
    String(
      opts?.packageDir ||
      ((exportMode === 'per-shot' && stemSuffix)
        ? `${shared.shotsDir}/${safeFileStem(stemSuffix, 'SHOT')}`
        : shared.masterDir)
    )
  );
  const aepName = `${outputStem}.aep`;
  const jsxName = `${outputStem}_Build_AE_Project.jsx`;
  const jobName = `${outputStem}_AEP_Job.json`;
  const renderSpecName = `${outputStem}_RenderSpec.json`;
  const deliverySpecName = `${outputStem}_DeliverySpec.json`;

  const renderDir = __trimEdgeSlashLike(
    String(
      opts?.renderDir ||
      ((exportMode === 'per-shot' && stemSuffix)
        ? `04_RENDERS/${safeFileStem(stemSuffix, 'SHOT')}`
        : '04_RENDERS')
    )
  );
  const deliveryDir = __trimEdgeSlashLike(
    String(
      opts?.deliveryDir ||
      ((exportMode === 'per-shot' && stemSuffix)
        ? `05_DELIVERY/${safeFileStem(stemSuffix, 'SHOT')}`
        : '05_DELIVERY')
    )
  );

  return {
    generatedAt: new Date().toISOString(),
    schema: 'postflowx.aep.handoff.v4',
    exportMode,
    rootName: ctx.rootName,
    sourceEdlTitle: ctx.edlTitle,
    edlTitle: derivedTitle,
    fps: ctx.fps,
    batch: {
      baseStem: ctx.tlStem,
      totalShots: Array.isArray(ctx.shots) ? ctx.shots.length : 0,
      jobCount: Math.max(1, Number(opts?.jobCount) || 1)
    },
    output: {
      packageDir,
      renderDir,
      deliveryDir,
      aepName,
      aepRelPath: `${packageDir}/${aepName}`,
      jsxName,
      jsxRelPath: `${packageDir}/${jsxName}`,
      jobName,
      jobRelPath: `${packageDir}/${jobName}`,
      renderSpecName,
      renderSpecRelPath: `${packageDir}/${renderSpecName}`,
      deliverySpecName,
      deliverySpecRelPath: `${packageDir}/${deliverySpecName}`,
      watchName: shared.watchName,
      watchRelPath: shared.watchRelPath,
      panelName: shared.panelName,
      panelRelPath: shared.panelRelPath,
      queueName: shared.queueName,
      queueRelPath: shared.queueRelPath,
      installName: shared.installName,
      installRelPath: shared.installRelPath,
      readmeName: shared.readmeName,
      readmeRelPath: shared.readmeRelPath,
      manifestName: shared.manifestName,
      manifestRelPath: shared.manifestRelPath
    },
    shots: (shots || []).map((s, idx) => {
      const shotName = String(s?.shotName || `SHOT_${idx+1}`);
      const camLens = __getCamLens(ctx.rootName, shotName);
      const scope = String(__getScopeOfWork(ctx.rootName, s) || '');
      return ({
        shotName,
        compName: safeCompName(s.compName || s.locShotName || s.shotName || `SHOT_${idx+1}`, `SHOT_${idx+1}`),
        locShotName: s.locShotName || null,
        scopeOfWork: scope || null,
        cameraMeta: {
          cam: String(camLens?.cam || ''),
          lens: String(camLens?.lens || ''),
          focal: String(camLens?.focal || ''),
          tstop: String(camLens?.tstop || ''),
          focus: String(camLens?.focus || '')
        },
        seq: s.seq ? {
          firstFileRel: s.seq.firstFileRel,
          patternRel: s.seq.patternRel,
          start: s.seq.start,
          end: s.seq.end,
          padding: s.seq.padding,
          ext: s.seq.ext,
          count: s.seq.count
        } : null,
        look: s.look ? {
          relPath: s.look.relPath,
          type: s.look.type || null,
          cdl: s.look.cdl || null
        } : null,
        edlHits: (s.edl?.hits || []).map(h => ({
          num: h.num,
          reel: h.reel || null,
          srcIn: h.srcIn || null,
          srcOut: h.srcOut || null,
          recIn: h.recIn || null,
          recOut: h.recOut || null,
          speedPct: Number(h.speedPct) || 100,
          speedIsDynamic: !!h.speedIsDynamic,
          speedRaw: h.speedRaw || null
        })),
        flags: s.flags || null
      });
    })
  };
}

function buildAEPBatchManifest(pack){
  const ctx = pack?.ctx || null;
  const shared = pack?.shared || __aepSharedOutputNames(ctx || {});
  const jobs = Array.isArray(pack?.jobs) ? pack.jobs : [];
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    schema: 'postflowx.aep.batch.v1',
    mode: String(pack?.mode || (jobs.length > 1 ? 'per-shot' : 'timeline')),
    rootName: ctx?.rootName || null,
    edlTitle: ctx?.edlTitle || null,
    batchStem: ctx?.tlStem || null,
    masterDir: shared.masterDir || '00_MASTER',
    shotsDir: shared.shotsDir || '01_SHOTS',
    jobCount: jobs.length,
    jobs: jobs.map((job, idx) => ({
      index: idx + 1,
      exportMode: job?.exportMode || null,
      packageDir: job?.output?.packageDir || null,
      shotName: Array.isArray(job?.shots) && job.shots.length ? (job.shots[0]?.shotName || job.shots[0]?.compName || null) : null,
      compName: Array.isArray(job?.shots) && job.shots.length ? (job.shots[0]?.compName || null) : null,
      jobName: job?.output?.jobName || null,
      jobRelPath: job?.output?.jobRelPath || null,
      jsxName: job?.output?.jsxName || null,
      jsxRelPath: job?.output?.jsxRelPath || null,
      aepName: job?.output?.aepName || null,
      aepRelPath: job?.output?.aepRelPath || null,
      renderDir: job?.output?.renderDir || null,
      deliveryDir: job?.output?.deliveryDir || null,
      renderSpecRelPath: job?.output?.renderSpecRelPath || null,
      deliverySpecRelPath: job?.output?.deliverySpecRelPath || null
    }))
  }, null, 2);
}

function buildAEPRenderSpec(job){
  const shots = Array.isArray(job?.shots) ? job.shots : [];
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    schema: 'postflowx.aep.renderSpec.v1',
    exportMode: job?.exportMode || 'per-shot',
    edlTitle: job?.edlTitle || null,
    rootName: job?.rootName || null,
    aepRelPath: job?.output?.aepRelPath || null,
    renderDir: job?.output?.renderDir || null,
    suggestedComp: shots[0] ? `${shots[0].compName || shots[0].shotName || 'SHOT'}__RENDER` : null,
    suggestedFileStem: shots[0] ? safeFileStem(`${shots[0].compName || shots[0].shotName || 'SHOT'}_v001`, 'SHOT_v001') : 'SHOT_v001',
    shots: shots.map((shot, idx) => ({
      index: idx + 1,
      shotName: shot?.shotName || null,
      compName: shot?.compName || null,
      renderCompName: `${shot?.compName || shot?.shotName || `SHOT_${idx+1}`}__RENDER`,
      renderDir: job?.output?.renderDir || null,
      scopeOfWork: shot?.scopeOfWork || null
    }))
  }, null, 2);
}

function buildAEPDeliverySpec(job){
  const shots = Array.isArray(job?.shots) ? job.shots : [];
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    schema: 'postflowx.aep.deliverySpec.v1',
    exportMode: job?.exportMode || 'per-shot',
    edlTitle: job?.edlTitle || null,
    rootName: job?.rootName || null,
    aepRelPath: job?.output?.aepRelPath || null,
    deliveryDir: job?.output?.deliveryDir || null,
    shots: shots.map((shot, idx) => ({
      index: idx + 1,
      shotName: shot?.shotName || null,
      compName: shot?.compName || null,
      deliveryDir: job?.output?.deliveryDir || null,
      platePattern: shot?.seq?.patternRel || null,
      lookPath: shot?.look?.relPath || null,
      scopeOfWork: shot?.scopeOfWork || null
    }))
  }, null, 2);
}

function buildAEPHandoffJobs(result){
  const ctx = getAEPHandoffContext(result);
  const shots = Array.isArray(ctx.shots) ? ctx.shots.filter(Boolean) : [];
  const usedStems = new Set();
  const shared = __aepSharedOutputNames(ctx);

  if (!shots.length){
    return {
      mode: 'timeline',
      ctx,
      shared,
      jobs: [buildAEPHandoffJob(result, { ctx, exportMode:'timeline', jobCount:1 })]
    };
  }

  const jobs = shots.map((shot, idx) => buildAEPHandoffJob(result, {
    ctx,
    shots: [shot],
    exportMode: 'per-shot',
    stemSuffix: __aepShotLabel(shot, idx),
    usedStems,
    jobCount: shots.length
  }));

  return {
    mode: 'per-shot',
    ctx,
    shared,
    jobs
  };
}


function __buildAEPCommonJSX(defaultJobName, defaultAepName){
  return `
  function isoNow(){
    var d = new Date();
    function p2(n){ return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p2(d.getMonth()+1) + '-' + p2(d.getDate()) + 'T' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
  }
  function tcToFrames(tc, fps){
    var m = String(tc || '').replace(/;/g, ':').match(/^(\d+):(\d+):(\d+):(\d+)$/);
    if (!m) return 0;
    return ((+m[1] * 3600 + +m[2] * 60 + +m[3]) * fps) + (+m[4]);
  }
  function framesToSec(fr, fps){ return (Number(fr) || 0) / (Number(fps) || 24); }
  function escPathJoin(folder, name){ return String(folder.fsName).replace(/[\\]+/g, '/') + '/' + String(name || '').replace(/^\/+/, ''); }
  function readTextFile(file){
    if (!file || !file.exists) return '';
    file.encoding = 'UTF-8';
    if (!file.open('r')) return '';
    var txt = file.read();
    file.close();
    return txt || '';
  }
  function writeTextFile(file, txt){
    if (!file) return false;
    file.encoding = 'UTF-8';
    if (!file.open('w')) return false;
    file.write(String(txt || ''));
    file.close();
    return true;
  }
  function readJSONFile(file){
    try{
      var txt = readTextFile(file);
      if (!txt) return null;
      return JSON.parse(txt);
    }catch(e){ return null; }
  }
  function writeJSONFile(file, obj){
    try{ return writeTextFile(file, JSON.stringify(obj, null, 2)); }catch(e){ return false; }
  }
  function replaceJsonExt(name, suffix){
    var s = String(name || 'job.json');
    return s.replace(/\.json$/i, '') + String(suffix || '.done.json');
  }
  function doneFileFor(jobFile){
    if (!jobFile || !jobFile.parent) return null;
    return new File(escPathJoin(jobFile.parent, replaceJsonExt(jobFile.name, '.done.json')));
  }
  function markJobState(jobFile, payload){
    try{
      var f = doneFileFor(jobFile);
      if (!f) return false;
      return writeJSONFile(f, payload || {});
    }catch(e){ return false; }
  }
  function loadJob(defaultName){
    var sf = null;
    try{ if ($ && $.fileName) sf = new File($.fileName); }catch(e){}
    var candidate = null;
    if (sf && sf.parent){
      candidate = new File(escPathJoin(sf.parent, defaultName));
      if (candidate.exists) return { file: candidate, data: readJSONFile(candidate) };
    }
    candidate = File.openDialog('Select PostFlowX AEP job JSON', '*.json');
    if (!candidate) return null;
    return { file: candidate, data: readJSONFile(candidate) };
  }
  function anySeqExists(rootFolder, job){
    if (!rootFolder || !job || !job.shots) return false;
    for (var i=0; i<job.shots.length; i++){
      var seq = job.shots[i] && job.shots[i].seq;
      if (!seq || !seq.firstFileRel) continue;
      var f = new File(escPathJoin(rootFolder, seq.firstFileRel));
      if (f.exists) return true;
    }
    return false;
  }
  function resolveRootFolder(jobFile, job, opts){
    var preferred = (opts && opts.rootFolder) ? opts.rootFolder : null;
    if (preferred && anySeqExists(preferred, job)) return preferred;
    var byJob = jobFile && jobFile.parent ? jobFile.parent : null;
    if (byJob && anySeqExists(byJob, job)) return byJob;
    if (opts && opts.noPromptRoot) return preferred || byJob || null;
    return Folder.selectDialog('Select VFX ROOT folder for ' + String(job && job.rootName || 'VFX_ROOT'));
  }
  function ensureProjectFolder(name){
    for (var i=1; i<=app.project.numItems; i++){
      var it = app.project.item(i);
      if (it instanceof FolderItem && it.name === name) return it;
    }
    return app.project.items.addFolder(name);
  }
  function ensureChildFolder(parentFolder, name){
    if (!parentFolder) return ensureProjectFolder(name);
    for (var i=1; i<=app.project.numItems; i++){
      var it = app.project.item(i);
      if (!(it instanceof FolderItem)) continue;
      if (it.parentFolder === parentFolder && it.name === name) return it;
    }
    var f = app.project.items.addFolder(name);
    try{ f.parentFolder = parentFolder; }catch(e){}
    return f;
  }
  function safeFolderName(name, fallback){
    var s = String(name == null ? '' : name);
    s = s.replace(/[\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    return s || String(fallback || 'Item');
  }
  function setItemComment(item, txt){
    try{ if (item) item.comment = String(txt || ''); }catch(e){}
  }
  function setItemLabel(item, label){
    try{ if (item && label != null) item.label = label; }catch(e){}
  }
  function splitInfoLines(txt){
    var s = String(txt || '').replace(/
/g, '');
    var parts = s.split('
');
    var out = [];
    for (var i=0; i<parts.length; i++){
      var line = String(parts[i] || '').replace(/^\s+|\s+$/g, '');
      if (line) out.push(line);
    }
    return out;
  }
  function addGuideTextLayer(comp, name, txt, y){
    if (!comp || !txt) return null;
    try{
      var layer = comp.layers.addText(String(txt));
      layer.name = String(name || '__PFX_INFO');
      try{ layer.guideLayer = true; }catch(e){}
      try{ layer.locked = true; }catch(e){}
      try{ layer.shy = true; }catch(e){}
      try{ layer.label = 9; }catch(e){}
      var td = layer.property('Source Text').value;
      td.fontSize = Math.max(16, Math.round((Number(comp.height) || 1080) * 0.018));
      td.leading = td.fontSize * 1.18;
      td.fillColor = [0.88, 0.93, 1.0];
      td.justification = ParagraphJustification.LEFT_JUSTIFY;
      layer.property('Source Text').setValue(td);
      var p = layer.property('Position');
      if (p) p.setValue([Math.round((Number(comp.width) || 1920) * 0.03), Number(y) || Math.round((Number(comp.height) || 1080) * 0.07)]);
      return layer;
    }catch(e){ return null; }
  }
  function addCompControlNull(comp, shot){
    if (!comp) return null;
    try{
      var layer = comp.layers.addNull();
      layer.name = '__PFX_CTRL';
      try{ layer.label = 10; }catch(e){}
      try{ layer.shy = true; }catch(e){}
      var y = Math.max(70, Math.round((Number(comp.height) || 1080) * 0.09));
      var x = Math.max(120, Math.round((Number(comp.width) || 1920) * 0.5));
      try{ layer.property('Position').setValue([x, y]); }catch(e){}
      try{ layer.comment = 'PostFlowX control null for ' + String((shot && (shot.compName || shot.shotName)) || comp.name || 'shot'); }catch(e){}
      return layer;
    }catch(e){ return null; }
  }
  function addAdjustmentLayer(comp, name, dur){
    if (!comp) return null;
    try{
      var layer = comp.layers.addSolid([0.14, 0.16, 0.2], String(name || '__PFX_GRADE'), Math.max(1, Number(comp.width)||1920), Math.max(1, Number(comp.height)||1080), 1, Math.max(Number(dur)||Number(comp.duration)||1/24, 1/24));
      try{ layer.adjustmentLayer = true; }catch(e){}
      try{ layer.enabled = false; }catch(e){}
      try{ layer.label = 2; }catch(e){}
      try{ layer.shy = true; }catch(e){}
      try{ layer.comment = 'PostFlowX adjustment placeholder'; }catch(e){}
      return layer;
    }catch(e){ return null; }
  }
  function addNoteTextLayer(comp, name, txt){
    if (!comp || !txt) return null;
    try{
      var layer = comp.layers.addText(String(txt));
      layer.name = String(name || '__PFX_NOTE');
      try{ layer.label = 14; }catch(e){}
      try{ layer.locked = true; }catch(e){}
      var td = layer.property('Source Text').value;
      td.fontSize = Math.max(18, Math.round((Number(comp.height) || 1080) * 0.022));
      td.leading = td.fontSize * 1.15;
      td.fillColor = [1.0, 0.93, 0.62];
      td.justification = ParagraphJustification.LEFT_JUSTIFY;
      layer.property('Source Text').setValue(td);
      try{ layer.property('Position').setValue([Math.round((Number(comp.width)||1920)*0.03), Math.round((Number(comp.height)||1080)*0.92)]); }catch(e){}
      try{ layer.comment = 'PostFlowX note placeholder'; }catch(e){}
      return layer;
    }catch(e){ return null; }
  }
  function addRenderOutputNote(comp, job, shot, y){
    if (!comp) return null;
    var out = (job && job.output) ? job.output : {};
    var shotStem = String((shot && (shot.compName || shot.shotName)) || comp.name || 'SHOT');
    var lines = [];
    lines.push('Render target: ' + String((out.renderDir || '04_RENDERS') + '/' + shotStem));
    lines.push('Delivery target: ' + String((out.deliveryDir || '05_DELIVERY') + '/' + shotStem));
    lines.push('Suggested comp: ' + shotStem + '__RENDER');
    lines.push('Suggested file: ' + shotStem + '_v001');
    return addGuideTextLayer(comp, '__PFX_RENDER_INFO', lines.join('\n'), Number(y) || Math.round((Number(comp.height) || 1080) * 0.16));
  }
  function addRenderPrepComp(parentFolder, sourceComp, shotName, w, h, dur, fps){
    if (!parentFolder || !sourceComp) return null;
    var nm = String(shotName || sourceComp.name || 'SHOT') + '__RENDER';
    var c = ensureComp(nm, w, h, dur, fps, parentFolder);
    try{ while (c.numLayers > 0) c.layer(1).remove(); }catch(e){}
    try{
      var ly = c.layers.add(sourceComp);
      ly.startTime = 0;
      ly.inPoint = 0;
      ly.outPoint = Math.max(Number(dur) || Number(c.duration) || 1/(Number(fps)||24), 1/(Number(fps)||24));
      addAdjustmentLayer(c, '__PFX_RENDER_GRADE', c.duration);
      addNoteTextLayer(c, '__PFX_RENDER_NOTE', 'RENDER NOTES: Output to the suggested render folder before delivery.');
      try{ c.motionBlur = true; }catch(e){}
      try{ c.frameBlending = true; }catch(e){}
      try{ c.workAreaStart = 0; c.workAreaDuration = c.duration; }catch(e){}
      try{ c.bgColor = [0.08, 0.08, 0.09]; }catch(e){}
      setItemLabel(c, 2);
      setItemComment(c, 'PostFlowX Render Prep Comp\nShot: ' + String(shotName || sourceComp.name || 'SHOT'));
    }catch(e){}
    return c;
  }
  function addSafeTitleGuides(comp){
    if (!comp) return 0;
    var made = 0;
    try{
      var w = Math.max(1, Number(comp.width)||1920), h = Math.max(1, Number(comp.height)||1080);
      var mx = Math.round(w * 0.1), my = Math.round(h * 0.1);
      function addGuide(x1,y1,x2,y2,nm){
        try{
          var sh = comp.layers.addShape();
          sh.name = nm;
          try{ sh.guideLayer = true; }catch(e){}
          try{ sh.locked = true; }catch(e){}
          try{ sh.shy = true; }catch(e){}
          try{ sh.label = 15; }catch(e){}
          var root = sh.property('Contents');
          var grp = root.addProperty('ADBE Vector Group');
          grp.name = 'Path';
          var path = grp.property('Contents').addProperty('ADBE Vector Shape - Group');
          var shape = new Shape();
          shape.vertices = [[x1-w/2,y1-h/2],[x2-w/2,y2-h/2]];
          shape.inTangents = [[0,0],[0,0]];
          shape.outTangents = [[0,0],[0,0]];
          shape.closed = false;
          path.property('Path').setValue(shape);
          var stroke = grp.property('Contents').addProperty('ADBE Vector Graphic - Stroke');
          stroke.property('Color').setValue([0.96,0.86,0.38]);
          stroke.property('Stroke Width').setValue(Math.max(2, Math.round(w*0.0012)));
          made++;
        }catch(e){}
      }
      addGuide(mx,my,w-mx,my,'__PFX_SAFE_TOP');
      addGuide(mx,h-my,w-mx,h-my,'__PFX_SAFE_BOTTOM');
      addGuide(mx,my,mx,h-my,'__PFX_SAFE_LEFT');
      addGuide(w-mx,my,w-mx,h-my,'__PFX_SAFE_RIGHT');
    }catch(e){}
    return made;
  }
  function addTimingMarkers(comp, hits, fps){
    if (!comp || !hits || !hits.length) return 0;
    var count = 0;
    for (var i=0; i<hits.length; i++){
      var hit = hits[i] || {};
      var recInF = tcToFrames(hit.recIn, fps);
      var recOutF = tcToFrames(hit.recOut, fps);
      var t = framesToSec(recInF, fps);
      var durF = Math.max(1, recOutF - recInF);
      var bits = [];
      if (hit.num != null && hit.num !== '') bits.push('#' + String(hit.num));
      if (hit.reel) bits.push(String(hit.reel));
      if (hit.srcIn || hit.srcOut) bits.push(String(hit.srcIn || '') + ' → ' + String(hit.srcOut || ''));
      bits.push('Dur ' + String(durF) + 'f');
      if (hit.speedPct && Math.abs(Number(hit.speedPct) - 100) > 0.0001) bits.push('Speed ' + String(hit.speedPct) + '%');
      try{
        var mv = new MarkerValue(bits.join(' | '));
        comp.markerProperty.setValueAtTime(t, mv);
        count++;
      }catch(e){}
    }
    return count;
  }
  function buildShotInfoText(shot, compKind){
    if (!shot) return '';
    var lines = [];
    lines.push('PostFlowX ' + String(compKind || 'SHOT') + ' COMP');
    lines.push('Shot: ' + String(shot.compName || shot.shotName || 'SHOT'));
    if (shot.locShotName) lines.push('LOC: ' + String(shot.locShotName));
    if (shot.scopeOfWork) lines.push('Scope: ' + String(shot.scopeOfWork));
    var cam = shot.cameraMeta || {};
    var camBits = [];
    if (cam.cam) camBits.push('Cam ' + String(cam.cam));
    if (cam.lens) camBits.push('Lens ' + String(cam.lens));
    if (cam.focal) camBits.push('Focal ' + String(cam.focal));
    if (cam.tstop) camBits.push('T ' + String(cam.tstop));
    if (cam.focus) camBits.push('Focus ' + String(cam.focus));
    if (camBits.length) lines.push(camBits.join(' · '));
    if (shot.seq && shot.seq.patternRel) lines.push('Plate: ' + String(shot.seq.patternRel));
    if (shot.look && shot.look.relPath) lines.push('Look: ' + String(shot.look.relPath));
    lines.push('FPS: ' + String(Math.round((Number(shot.fps) || 0) * 1000) / 1000 || '24'));
    return lines.join('
');
  }
  function buildMasterInfoText(job, builtShots, segmentCount){
    var lines = [];
    lines.push('PostFlowX MASTER COMP');
    lines.push('Title: ' + String((job && job.edlTitle) || 'MASTER_TIMELINE'));
    lines.push('Mode: ' + String((job && job.exportMode) || 'timeline'));
    lines.push('Built shots: ' + String(builtShots || 0));
    lines.push('Segments: ' + String(segmentCount || 0));
    if (job && job.sourceEdlTitle && job.sourceEdlTitle !== job.edlTitle) lines.push('Source title: ' + String(job.sourceEdlTitle));
    return lines.join('
');
  }
  function ensureComp(name, w, h, dur, fps, parentFolder){
    for (var i=1; i<=app.project.numItems; i++){
      var it = app.project.item(i);
      if (it instanceof CompItem && it.name === name) return it;
    }
    var c = app.project.items.addComp(String(name || 'COMP'), Math.max(1, w||1920), Math.max(1, h||1080), 1, Math.max((Number(dur)||0), 1/(Number(fps)||24)), Number(fps)||24);
    if (parentFolder) c.parentFolder = parentFolder;
    return c;
  }
  function importSequence(rootFolder, seq, fps){
    if (!rootFolder || !seq || !seq.firstFileRel) return null;
    var f = new File(escPathJoin(rootFolder, seq.firstFileRel));
    if (!f.exists) return null;
    var io = new ImportOptions(f);
    io.sequence = true;
    var item = app.project.importFile(io);
    try{ item.parentFolder = null; }catch(e){}
    try{ item.mainSource.conformFrameRate = Number(fps) || 24; }catch(e){}
    return item;
  }
  function pushUnique(arr, value){ if (value != null && value !== '' && arr.indexOf(value) === -1) arr.push(value); }
  function buildProjectFromLoaded(loaded, opts){
    if (!loaded || !loaded.data) return { ok:false, error:'No PostFlowX AEP job selected.' };
    var JOB = loaded.data;
    var fps = Number(JOB.fps) || 24;
    var rootFolder = resolveRootFolder(loaded.file, JOB, opts || null);
    if (!rootFolder) return { ok:false, error:'No VFX ROOT selected.' };

    if (!app.project || (app.project && app.project.numItems > 0)){
      if (!(opts && opts.auto)){
        try{ if (!confirm('Create a new PostFlowX After Effects project? Unsaved changes in the current project may be lost.')) return { ok:false, error:'Canceled by user.' }; }catch(e){}
      }
      app.newProject();
    }

    var result = {
      ok:true,
      job:JOB,
      rootFolder:rootFolder,
      outputFile:null,
      missing:[],
      builtShots:0,
      segmentCount:0,
      error:''
    };

    app.beginUndoGroup('PostFlowX Build AEP');
    try{
      var packageFolder = ensureProjectFolder(String(JOB.rootName || 'PostFlowX_AEP'));
      var masterFolder = ensureChildFolder(packageFolder, '00_MASTER');
      var shotsFolder = ensureChildFolder(packageFolder, '01_SHOTS');
      var footageFolder = ensureChildFolder(packageFolder, '02_PLATES');
      var dataFolder = ensureChildFolder(packageFolder, '03_DATA');
      var outputFolder = ensureChildFolder(packageFolder, '04_OUTPUT');

      var compsByShot = {};
      var missing = [];
      var masterWidth = 1920;
      var masterHeight = 1080;
      var allSegs = [];
      var builtShots = 0;
      var isPerShotJob = String(JOB.exportMode || '').toLowerCase() === 'per-shot';
      var primaryShotName = '';

      for (var i=0; i<(JOB.shots || []).length; i++){
        var s = JOB.shots[i];
        if (!s || !s.seq || !s.seq.firstFileRel) continue;

        var shotName = String(s.compName || s.shotName || ('SHOT_' + (i+1)));
        if (!primaryShotName) primaryShotName = shotName;
        var shotFolderName = safeFolderName(shotName, 'SHOT_' + (i+1));
        var shotCompFolder = ensureChildFolder(shotsFolder, shotFolderName);
        var shotPlateFolder = ensureChildFolder(footageFolder, shotFolderName);
        var shotDataFolder = ensureChildFolder(dataFolder, shotFolderName);
        var shotOutputFolder = ensureChildFolder(outputFolder, shotFolderName);

        var footage = importSequence(rootFolder, s.seq, fps);
        if (!footage){
          pushUnique(missing, shotName);
          continue;
        }
        try{ footage.parentFolder = shotPlateFolder; }catch(e){}
        setItemLabel(footage, 9);
        setItemComment(footage,
          'PostFlowX Plate\n' +
          'Shot: ' + shotName + '\n' +
          'Sequence: ' + String(s.seq.patternRel || s.seq.firstFileRel || '') + '\n' +
          'Frames: ' + String(s.seq.start || '') + '-' + String(s.seq.end || '')
        );

        var w = Number(footage.width) || masterWidth || 1920;
        var h = Number(footage.height) || masterHeight || 1080;
        masterWidth = w;
        masterHeight = h;

        var seqFrames = Math.max(1, (Number(s.seq.end) || 1) - (Number(s.seq.start) || 1) + 1);
        var seqDur = Math.max(framesToSec(seqFrames, fps), Number(footage.duration) || 0, 1/fps);

        var srcCompName = shotName + '__SRC';
        var shotCompsFolder = ensureChildFolder(shotCompFolder, '01_COMPS');
        var shotPrecompsFolder = ensureChildFolder(shotCompFolder, '02_PRECOMPS');
        var shotComp = ensureComp(shotName, w, h, seqDur, fps, shotCompsFolder);
        var srcComp = ensureComp(srcCompName, w, h, seqDur, fps, shotPrecompsFolder);
        setItemLabel(srcComp, 10);
        setItemLabel(shotComp, 11);
        setItemComment(srcComp,
          'PostFlowX Source Comp\n' +
          'Shot: ' + shotName + '\n' +
          'LOC: ' + String(s.locShotName || '') + '\n' +
          'Look: ' + String((s.look && s.look.relPath) || '')
        );
        setItemComment(shotComp,
          'PostFlowX Shot Comp\n' +
          'Shot: ' + shotName + '\n' +
          'LOC: ' + String(s.locShotName || '') + '\n' +
          'Look: ' + String((s.look && s.look.relPath) || '')
        );

        try{
          while (srcComp.numLayers > 0) srcComp.layer(1).remove();
          var srcLayer = srcComp.layers.add(footage);
          srcLayer.startTime = 0;
          srcLayer.inPoint = 0;
          srcLayer.outPoint = seqDur;
          if (srcComp.duration < seqDur) srcComp.duration = seqDur;
          addGuideTextLayer(srcComp, '__PFX_SRC_INFO', buildShotInfoText({ compName: shotName, shotName: shotName, locShotName: s.locShotName, scopeOfWork: s.scopeOfWork, cameraMeta: s.cameraMeta, seq: s.seq, look: s.look, fps: fps }, 'SRC'), Math.round(h * 0.08));
        }catch(e){}

        try{
          while (shotComp.numLayers > 0) shotComp.layer(1).remove();
          var shotLayer = shotComp.layers.add(srcComp);
          shotLayer.startTime = 0;
          shotLayer.inPoint = 0;
          shotLayer.outPoint = seqDur;
          if (shotComp.duration < seqDur) shotComp.duration = seqDur;
          addCompControlNull(shotComp, s);
          addAdjustmentLayer(shotComp, '__PFX_GRADE', seqDur);
          addGuideTextLayer(shotComp, '__PFX_SHOT_INFO', buildShotInfoText({ compName: shotName, shotName: shotName, locShotName: s.locShotName, scopeOfWork: s.scopeOfWork, cameraMeta: s.cameraMeta, seq: s.seq, look: s.look, fps: fps }, 'SHOT'), Math.round(h * 0.08));
          addRenderOutputNote(shotComp, JOB, s, Math.round(h * 0.17));
          addNoteTextLayer(shotComp, '__PFX_NOTE', 'NOTES: ' + String(s.scopeOfWork || 'Add notes here'));
          addSafeTitleGuides(shotComp);
        }catch(e){}
        try{ addRenderPrepComp(shotOutputFolder, shotComp, shotName, w, h, seqDur, fps); }catch(e){}
        var shotMarkerCount = 0;
        try{ shotMarkerCount = addTimingMarkers(shotComp, hits, fps); }catch(e){}
        try{ setItemComment(shotComp, String(shotComp.comment || '') + '
Markers: ' + String(shotMarkerCount)); }catch(e){}

        try{ if (shotDataFolder && shotDataFolder.comment !== undefined) shotDataFolder.comment = 'Shot data placeholder for ' + shotName; }catch(e){}

        compsByShot[shotName] = shotComp;
        builtShots++;

        var hits = s.edlHits || [];
        for (var hIdx=0; hIdx<hits.length; hIdx++){
          var hit = hits[hIdx];
          var a = tcToFrames(hit.recIn, fps);
          var b = tcToFrames(hit.recOut, fps);
          var durF = Math.max(1, b - a);
          allSegs.push({
            comp: shotComp,
            shotName: shotName,
            recInF: a,
            recOutF: b,
            durF: durF,
            speedPct: Number(hit.speedPct) || 100
          });
        }
      }

      var masterName = String(JOB.edlTitle || 'MASTER_TIMELINE');
      if (isPerShotJob && primaryShotName) masterName = primaryShotName + '__MASTER';

      if (allSegs.length){
        allSegs.sort(function(a,b){ return a.recInF - b.recInF; });
        var baseRec = allSegs[0].recInF;
        var maxRec = allSegs[0].recOutF;
        for (var si=0; si<allSegs.length; si++) if (allSegs[si].recOutF > maxRec) maxRec = allSegs[si].recOutF;
        var masterDur = Math.max(framesToSec(maxRec - baseRec, fps), 1/fps);
        var master = ensureComp(masterName, masterWidth, masterHeight, masterDur, fps, masterFolder);
        setItemLabel(master, 13);
        setItemComment(master,
          'PostFlowX Master Comp\n' +
          'Title: ' + masterName + '\n' +
          'Export mode: ' + String(JOB.exportMode || 'timeline')
        );
        try{ master.duration = masterDur; }catch(e){}
        try{ while (master.numLayers > 0) master.layer(1).remove(); }catch(e){}
        for (var si2=0; si2<allSegs.length; si2++){
          var sg = allSegs[si2];
          var startS = framesToSec(sg.recInF - baseRec, fps);
          var durS = framesToSec(sg.durF, fps);
          var ly = master.layers.add(sg.comp);
          try{
            ly.startTime = startS;
            ly.inPoint = startS;
            ly.outPoint = startS + durS;
            if (sg.speedPct && Math.abs(sg.speedPct - 100) > 0.0001){ ly.stretch = (10000 / sg.speedPct); }
            try{ ly.label = 11; }catch(e){}
            try{ ly.comment = 'Shot: ' + String(sg.shotName || sg.comp.name || '') + '
Rec: ' + String(sg.recInF || 0) + '-' + String(sg.recOutF || 0); }catch(e){}
          }catch(e){}
        }
        try{ addGuideTextLayer(master, '__PFX_MASTER_INFO', buildMasterInfoText(JOB, builtShots, allSegs.length), Math.round(masterHeight * 0.08)); }catch(e){}
        try{ addRenderOutputNote(master, JOB, { compName: masterName, shotName: masterName }, Math.round(masterHeight * 0.17)); }catch(e){}
        try{ addCompControlNull(master, { compName: masterName, shotName: masterName }); }catch(e){}
        try{ addAdjustmentLayer(master, '__PFX_MASTER_GRADE', masterDur); }catch(e){}
        try{ addNoteTextLayer(master, '__PFX_MASTER_NOTE', 'MASTER NOTES: Review shot notes and render settings before delivery.'); }catch(e){}
        try{ addSafeTitleGuides(master); }catch(e){}
        try{ addRenderPrepComp(masterFolder, master, masterName, masterWidth, masterHeight, masterDur, fps); }catch(e){}
      } else {
        var seqStart = 0;
        var masterSeq = ensureComp(masterName, masterWidth, masterHeight, 1/fps, fps, masterFolder);
        setItemLabel(masterSeq, 13);
        setItemComment(masterSeq,
          'PostFlowX Master Comp\n' +
          'Title: ' + masterName + '\n' +
          'Export mode: ' + String(JOB.exportMode || 'timeline')
        );
        try{ while (masterSeq.numLayers > 0) masterSeq.layer(1).remove(); }catch(e){}
        for (var key in compsByShot){
          if (!compsByShot.hasOwnProperty(key)) continue;
          var c = compsByShot[key];
          var ly2 = masterSeq.layers.add(c);
          try{
            ly2.startTime = seqStart;
            ly2.inPoint = seqStart;
            ly2.outPoint = seqStart + c.duration;
            if (masterSeq.duration < seqStart + c.duration) masterSeq.duration = seqStart + c.duration;
            try{ ly2.label = 11; }catch(e){}
            try{ ly2.comment = 'Shot: ' + String(c.name || key); }catch(e){}
          }catch(e){}
          seqStart += c.duration;
        }
        try{ addGuideTextLayer(masterSeq, '__PFX_MASTER_INFO', buildMasterInfoText(JOB, builtShots, 0), Math.round(masterHeight * 0.08)); }catch(e){}
        try{ addRenderOutputNote(masterSeq, JOB, { compName: masterName, shotName: masterName }, Math.round(masterHeight * 0.17)); }catch(e){}
        try{ addCompControlNull(masterSeq, { compName: masterName, shotName: masterName }); }catch(e){}
        try{ addAdjustmentLayer(masterSeq, '__PFX_MASTER_GRADE', masterSeq.duration); }catch(e){}
        try{ addNoteTextLayer(masterSeq, '__PFX_MASTER_NOTE', 'MASTER NOTES: Review shot notes and render settings before delivery.'); }catch(e){}
        try{ addSafeTitleGuides(masterSeq); }catch(e){}
        try{ addRenderPrepComp(masterFolder, masterSeq, masterName, masterWidth, masterHeight, masterSeq.duration, fps); }catch(e){}
      }

      var saveFolder = rootFolder;
      try{
        if (loaded && loaded.file && loaded.file.parent && loaded.file.parent.exists){
          saveFolder = loaded.file.parent;
        }
      }catch(e){}
      var outFile = new File(escPathJoin(saveFolder, String((JOB.output && JOB.output.aepName) || ${JSON.stringify(defaultAepName)})));
      app.project.save(outFile);
      result.outputFile = outFile;
      result.missing = missing;
      result.builtShots = builtShots;
      result.segmentCount = allSegs.length;
      markJobState(loaded.file, {
        schema: 'postflowx.aep.done.v1',
        status: 'ok',
        builtAt: isoNow(),
        generatedAt: JOB.generatedAt || null,
        aepName: outFile.name || null,
        outputPath: outFile.fsName || null,
        builtShots: builtShots,
        segmentCount: allSegs.length,
        missing: missing
      });
    }catch(err){
      result.ok = false;
      result.error = String(err);
      markJobState(loaded.file, {
        schema: 'postflowx.aep.done.v1',
        status: 'error',
        builtAt: isoNow(),
        generatedAt: JOB.generatedAt || null,
        error: result.error
      });
    }
    try{ app.endUndoGroup(); }catch(e){}
    return result;
  }
  function formatBuildMessage(result){
    if (!result) return 'Unknown AE build result.';
    if (!result.ok) return 'AE build failed:\\n' + String(result.error || 'Unknown error');
    var outPath = result.outputFile ? result.outputFile.fsName : '';
    var msg = 'Saved AE project:\\n' + outPath;
    if (result.missing && result.missing.length){ msg += '\\n\\nMissing sequences (' + result.missing.length + '):\\n- ' + result.missing.join('\\n- '); }
    return msg;
  }
  `;
}

function buildAEPBuilderJSX(job){
  const jobName = String(job?.output?.jobName || 'PostFlowX_AEP_Job.json');
  const aepName = String(job?.output?.aepName || 'VFX_Project.aep');
  const watchName = String(job?.output?.watchName || 'PostFlowX_AE_WatchFolder.jsx');
  return `/* eslint-disable */
// Generated by PostFlowX — AE Project handoff (manual builder)
// 1) Place this JSX next to ${jobName}
// 2) In After Effects: File > Scripts > Run Script File…
// 3) Choose this JSX; it will build and save ${aepName}
// Optional auto-build: run ${watchName} in a dedicated AE session.
(function(){
${__buildAEPCommonJSX(jobName, aepName)}
  var loaded = loadJob(${JSON.stringify(jobName)});
  if (!loaded || !loaded.data){ alert('No PostFlowX AEP job selected.'); return; }
  var result = buildProjectFromLoaded(loaded, {});
  if (!result || !result.ok){ alert(formatBuildMessage(result)); return; }
  alert(formatBuildMessage(result));
})();`;
}

function buildAEPWatchFolderJSX(job){
  const jobName = String(job?.output?.jobName || 'PostFlowX_AEP_Job.json');
  const aepName = String(job?.output?.aepName || 'VFX_Project.aep');
  return `/* eslint-disable */
#target aftereffects
#targetengine "postflowx_ae_watch"
// Generated by PostFlowX — AE watch mode (no Native Host)
// Keep this script running in a dedicated After Effects session.
(function(thisObj){
${__buildAEPCommonJSX(jobName, aepName)}
  var KEY_SECTION = 'PostFlowX';
  var KEY_FOLDER = 'AEWatchFolder';
  var g = $.global;
  if (!g.__PFX_AE_WATCH__) g.__PFX_AE_WATCH__ = {};
  var STATE = g.__PFX_AE_WATCH__;
  if (typeof STATE.auto !== 'boolean') STATE.auto = false;
  if (!STATE.timerMs) STATE.timerMs = 2500;
  if (!STATE.logLines) STATE.logLines = [];

  function sortFiles(files){
    files.sort(function(a,b){
      var an = String(a && (a.fsName || a.name) || '').toLowerCase();
      var bn = String(b && (b.fsName || b.name) || '').toLowerCase();
      return an < bn ? -1 : (an > bn ? 1 : 0);
    });
    return files;
  }
  function appendLog(msg){
    var line = '[' + isoNow().replace('T',' ') + '] ' + String(msg || '');
    STATE.logLines.push(line);
    if (STATE.logLines.length > 200) STATE.logLines.shift();
    if (STATE.logField) STATE.logField.text = STATE.logLines.join('\\n');
  }
  function setStatus(msg){ if (STATE.statusText) STATE.statusText.text = String(msg || ''); }
  function saveFolderSetting(folder){
    try{ if (folder && folder.fsName) app.settings.saveSetting(KEY_SECTION, KEY_FOLDER, folder.fsName); }catch(e){}
  }
  function loadFolderSetting(){
    try{
      if (app.settings.haveSetting(KEY_SECTION, KEY_FOLDER)){
        var p = app.settings.getSetting(KEY_SECTION, KEY_FOLDER);
        if (p){ var f = new Folder(p); if (f.exists) return f; }
      }
    }catch(e){}
    try{ if ($ && $.fileName){ var sf = new File($.fileName); if (sf && sf.parent && sf.parent.exists) return sf.parent; } }catch(e){}
    return null;
  }
  function setWatchFolder(folder){
    STATE.watchFolder = folder || null;
    if (STATE.pathText) STATE.pathText.text = folder ? String(folder.fsName) : 'No watch folder selected';
    if (folder) saveFolderSetting(folder);
    rescan();
  }
  function chooseFolder(){
    var base = STATE.watchFolder || loadFolderSetting() || null;
    var f = Folder.selectDialog('Select PostFlowX watch folder', base);
    if (f) setWatchFolder(f);
  }
  function collectJobFiles(folder, out){
    if (!folder || !folder.exists) return out;
    var list = folder.getFiles();
    for (var i=0; i<list.length; i++){
      var it = list[i];
      if (it instanceof Folder){ collectJobFiles(it, out); }
      else if (it instanceof File && /_AEP_Job\.json$/i.test(String(it.name||''))){ out.push(it); }
    }
    return out;
  }
  function readJob(jobFile){ return readJSONFile(jobFile); }
  function readDone(jobFile){ var f = doneFileFor(jobFile); return f && f.exists ? readJSONFile(f) : null; }
  function isPending(jobFile){
    var job = readJob(jobFile);
    if (!job) return false;
    var done = readDone(jobFile);
    if (!done) return true;
    return String(done.generatedAt || '') !== String(job.generatedAt || '');
  }
  function listJobs(){
    var out = [];
    if (!STATE.watchFolder) return out;
    return sortFiles(collectJobFiles(STATE.watchFolder, out));
  }
  function summarize(){
    var jobs = listJobs();
    var pending = 0;
    for (var i=0; i<jobs.length; i++) if (isPending(jobs[i])) pending++;
    setStatus('Jobs ' + jobs.length + ' · Pending ' + pending + (STATE.auto ? ' · Auto ON' : ' · Auto OFF'));
    return { jobs: jobs, pending: pending };
  }
  function buildJobFile(jobFile, autoMode){
    if (!jobFile) return false;
    var data = readJob(jobFile);
    if (!data){ appendLog('Skip invalid job: ' + jobFile.fsName); return false; }
    appendLog('Build: ' + jobFile.name);
    var result = buildProjectFromLoaded({ file: jobFile, data: data }, { auto: !!autoMode, rootFolder: STATE.watchFolder, noPromptRoot: !!autoMode });
    if (result && result.ok){
      appendLog('Saved: ' + (result.outputFile ? result.outputFile.fsName : '(unknown path)'));
      if (result.missing && result.missing.length) appendLog('Missing sequences: ' + result.missing.join(', '));
      setStatus('Built ' + jobFile.name);
      return true;
    }
    appendLog('Failed: ' + jobFile.name + ' — ' + String(result && result.error || 'Unknown error'));
    setStatus('Failed ' + jobFile.name);
    return false;
  }
  function buildNext(autoMode){
    var jobs = listJobs();
    for (var i=0; i<jobs.length; i++){
      if (!isPending(jobs[i])) continue;
      return buildJobFile(jobs[i], !!autoMode);
    }
    setStatus('No pending AEP jobs');
    return false;
  }
  function rescan(){ summarize(); }
  function updateAutoButton(){ if (STATE.autoBtn) STATE.autoBtn.text = STATE.auto ? 'Auto ON' : 'Auto OFF'; }
  function scheduleTick(){
    if (!STATE.auto) return;
    try{ app.scheduleTask('$.global.__PFX_AE_WATCH__ && $.global.__PFX_AE_WATCH__.tick && $.global.__PFX_AE_WATCH__.tick()', STATE.timerMs, false); }catch(e){ appendLog('scheduleTask error: ' + e); }
  }
  STATE.tick = function(){
    if (!STATE.auto) return;
    try{ if (STATE.watchFolder) buildNext(true); }catch(e){ appendLog('Auto error: ' + e); }
    rescan();
    scheduleTick();
  };
  function toggleAuto(){
    STATE.auto = !STATE.auto;
    updateAutoButton();
    appendLog(STATE.auto ? 'Auto watch started' : 'Auto watch stopped');
    rescan();
    if (STATE.auto) scheduleTick();
  }
  function makeUI(){
    if (STATE.win && STATE.win instanceof Window){ try{ STATE.win.close(); }catch(e){} }
    var w = new Window('palette', 'PostFlowX AE Watch', undefined, { resizeable:true });
    w.orientation = 'column';
    w.alignChildren = ['fill','top'];
    w.spacing = 8;
    w.margins = 12;

    var info = w.add('statictext', undefined, 'Watch folder');
    info.alignment = ['fill','top'];
    STATE.pathText = w.add('edittext', undefined, STATE.watchFolder ? STATE.watchFolder.fsName : 'No watch folder selected', { readonly:true });
    STATE.pathText.alignment = ['fill','top'];

    var row = w.add('group');
    row.orientation = 'row';
    row.alignChildren = ['fill','center'];
    var btnChoose = row.add('button', undefined, 'Choose Folder');
    var btnScan = row.add('button', undefined, 'Scan');
    var btnBuild = row.add('button', undefined, 'Build Next');
    STATE.autoBtn = row.add('button', undefined, STATE.auto ? 'Auto ON' : 'Auto OFF');

    STATE.statusText = w.add('statictext', undefined, '');
    STATE.statusText.alignment = ['fill','top'];
    STATE.logField = w.add('edittext', undefined, STATE.logLines.join('\\n'), { multiline:true, readonly:true, scrolling:true });
    STATE.logField.preferredSize = [620, 240];
    STATE.logField.alignment = ['fill','fill'];

    btnChoose.onClick = chooseFolder;
    btnScan.onClick = function(){ appendLog('Manual scan'); rescan(); };
    btnBuild.onClick = function(){
      if (!STATE.watchFolder){ chooseFolder(); if (!STATE.watchFolder) return; }
      buildNext(false);
      rescan();
    };
    STATE.autoBtn.onClick = toggleAuto;

    w.onClose = function(){ STATE.auto = false; updateAutoButton(); return true; };
    w.layout.layout(true);
    STATE.win = w;
    return w;
  }

  if (!STATE.watchFolder) STATE.watchFolder = loadFolderSetting();
  var win = makeUI();
  if (STATE.watchFolder && STATE.pathText) STATE.pathText.text = STATE.watchFolder.fsName;
  appendLog('Ready. Watch mode builds new *_AEP_Job.json files into .aep projects.');
  appendLog('Tip: keep this AE session dedicated to PostFlowX auto-build jobs.');
  rescan();
  if (win instanceof Window) win.show();
})(this);`;
}


function buildAEPPanelJSX(job){
  const jobName = String(job?.output?.jobName || 'PostFlowX_AEP_Job.json');
  const aepName = String(job?.output?.aepName || 'VFX_Project.aep');
  return `/* eslint-disable */
#target aftereffects
#targetengine "postflowx_ae_panel"
// Generated by PostFlowX — dockable AE panel for PostFlowX AEP jobs.
// Install this file into After Effects ScriptUI Panels, then open it from the Window menu.
(function(thisObj){
${__buildAEPCommonJSX(jobName, aepName)}
  var KEY_SECTION = 'PostFlowX';
  var KEY_FOLDER = 'AEWatchFolder';
  var g = $.global;
  if (!g.__PFX_AE_PANEL__) g.__PFX_AE_PANEL__ = {};
  var STATE = g.__PFX_AE_PANEL__;
  if (typeof STATE.auto !== 'boolean') STATE.auto = false;
  if (!STATE.timerMs) STATE.timerMs = 2500;
  if (!STATE.logLines) STATE.logLines = [];

  function sortFiles(files){
    files.sort(function(a,b){
      var an = String(a && (a.fsName || a.name) || '').toLowerCase();
      var bn = String(b && (b.fsName || b.name) || '').toLowerCase();
      return an < bn ? -1 : (an > bn ? 1 : 0);
    });
    return files;
  }
  function appendLog(msg){
    var line = '[' + isoNow().replace('T',' ') + '] ' + String(msg || '');
    STATE.logLines.push(line);
    if (STATE.logLines.length > 300) STATE.logLines.shift();
    if (STATE.logField) STATE.logField.text = STATE.logLines.join('\n');
    try{ if (STATE.logField) STATE.logField.active = false; }catch(e){}
  }
  function setStatus(msg){ if (STATE.statusText) STATE.statusText.text = String(msg || ''); }
  function saveFolderSetting(folder){
    try{ if (folder && folder.fsName) app.settings.saveSetting(KEY_SECTION, KEY_FOLDER, folder.fsName); }catch(e){}
  }
  function loadFolderSetting(){
    try{
      if (app.settings.haveSetting(KEY_SECTION, KEY_FOLDER)){
        var p = app.settings.getSetting(KEY_SECTION, KEY_FOLDER);
        if (p){ var f = new Folder(p); if (f.exists) return f; }
      }
    }catch(e){}
    return null;
  }
  function setWatchFolder(folder){
    STATE.watchFolder = folder || null;
    if (STATE.pathText) STATE.pathText.text = folder ? String(folder.fsName) : 'No watch folder selected';
    if (folder) saveFolderSetting(folder);
    rescan();
  }
  function chooseFolder(){
    var base = STATE.watchFolder || loadFolderSetting() || null;
    var f = Folder.selectDialog('Select PostFlowX watch folder', base);
    if (f) setWatchFolder(f);
  }
  function collectJobFiles(folder, out){
    if (!folder || !folder.exists) return out;
    var list = folder.getFiles();
    for (var i=0; i<list.length; i++){
      var it = list[i];
      if (it instanceof Folder){ collectJobFiles(it, out); }
      else if (it instanceof File && /_AEP_Job\.json$/i.test(String(it.name||''))){ out.push(it); }
    }
    return out;
  }
  function readJob(jobFile){ return readJSONFile(jobFile); }
  function readDone(jobFile){ var f = doneFileFor(jobFile); return f && f.exists ? readJSONFile(f) : null; }
  function isPending(jobFile){
    var job = readJob(jobFile);
    if (!job) return false;
    var done = readDone(jobFile);
    if (!done) return true;
    return String(done.generatedAt || '') !== String(job.generatedAt || '');
  }
  function listJobs(){
    var out = [];
    if (!STATE.watchFolder) return out;
    return sortFiles(collectJobFiles(STATE.watchFolder, out));
  }
  function summarize(){
    var jobs = listJobs();
    var pending = 0;
    for (var i=0; i<jobs.length; i++) if (isPending(jobs[i])) pending++;
    setStatus('Jobs ' + jobs.length + ' · Pending ' + pending + (STATE.auto ? ' · Auto ON' : ' · Auto OFF'));
    if (STATE.pendingText) STATE.pendingText.text = pending ? ('Pending ' + pending) : 'Pending 0';
    return { jobs: jobs, pending: pending };
  }
  function buildJobFile(jobFile, autoMode){
    if (!jobFile) return false;
    var data = readJob(jobFile);
    if (!data){ appendLog('Skip invalid job: ' + jobFile.fsName); return false; }
    appendLog('Build: ' + jobFile.name);
    var result = buildProjectFromLoaded({ file: jobFile, data: data }, { auto: !!autoMode, rootFolder: STATE.watchFolder || jobFile.parent, noPromptRoot: !!autoMode });
    if (result && result.ok){
      appendLog('Saved: ' + (result.outputFile ? result.outputFile.fsName : '(unknown path)'));
      if (result.missing && result.missing.length) appendLog('Missing sequences: ' + result.missing.join(', '));
      setStatus('Built ' + jobFile.name);
      return true;
    }
    appendLog('Failed: ' + jobFile.name + ' — ' + String(result && result.error || 'Unknown error'));
    setStatus('Failed ' + jobFile.name);
    return false;
  }
  function buildNext(autoMode){
    var jobs = listJobs();
    for (var i=0; i<jobs.length; i++){
      if (!isPending(jobs[i])) continue;
      return buildJobFile(jobs[i], !!autoMode);
    }
    setStatus('No pending AEP jobs');
    return false;
  }
  function chooseAndBuildJob(){
    var base = STATE.watchFolder || loadFolderSetting() || null;
    var f = File.openDialog('Select PostFlowX AEP job JSON', '*.json');
    if (!f) return false;
    var data = readJob(f);
    if (!data){ appendLog('Invalid job JSON: ' + f.fsName); return false; }
    if (!STATE.watchFolder && f.parent) setWatchFolder(f.parent);
    return buildJobFile(f, false);
  }
  function rescan(){ summarize(); }
  function updateAutoButton(){ if (STATE.autoBtn) STATE.autoBtn.text = STATE.auto ? 'Auto ON' : 'Auto OFF'; }
  function scheduleTick(){
    if (!STATE.auto) return;
    try{ app.scheduleTask('$.global.__PFX_AE_PANEL__ && $.global.__PFX_AE_PANEL__.tick && $.global.__PFX_AE_PANEL__.tick()', STATE.timerMs, false); }catch(e){ appendLog('scheduleTask error: ' + e); }
  }
  STATE.tick = function(){
    if (!STATE.auto) return;
    try{ if (STATE.watchFolder) buildNext(true); }catch(e){ appendLog('Auto error: ' + e); }
    rescan();
    scheduleTick();
  };
  function toggleAuto(){
    STATE.auto = !STATE.auto;
    updateAutoButton();
    appendLog(STATE.auto ? 'Auto watch started' : 'Auto watch stopped');
    rescan();
    if (STATE.auto) scheduleTick();
  }
  function buildUI(host){
    var pal = (host instanceof Panel) ? host : new Window('palette', 'PostFlowX AE Panel', undefined, { resizeable:true });
    pal.orientation = 'column';
    pal.alignChildren = ['fill','top'];
    pal.spacing = 8;
    pal.margins = 12;

    var title = pal.add('statictext', undefined, 'PostFlowX AE Panel');
    try{ title.graphics.font = ScriptUI.newFont(title.graphics.font.name, 'BOLD', 14); }catch(e){}

    STATE.pathText = pal.add('edittext', undefined, STATE.watchFolder ? STATE.watchFolder.fsName : 'No watch folder selected', { readonly:true });
    STATE.pathText.alignment = ['fill','top'];

    var row1 = pal.add('group');
    row1.orientation = 'row';
    row1.alignChildren = ['fill','center'];
    row1.spacing = 6;
    var btnChoose = row1.add('button', undefined, 'Choose Folder');
    var btnScan = row1.add('button', undefined, 'Scan');
    var btnBuild = row1.add('button', undefined, 'Build Next');
    var btnBuildJob = row1.add('button', undefined, 'Build Job…');
    STATE.autoBtn = row1.add('button', undefined, STATE.auto ? 'Auto ON' : 'Auto OFF');

    var row2 = pal.add('group');
    row2.orientation = 'row';
    row2.alignChildren = ['left','center'];
    row2.spacing = 10;
    STATE.statusText = row2.add('statictext', undefined, '');
    STATE.pendingText = row2.add('statictext', undefined, 'Pending 0');

    STATE.logField = pal.add('edittext', undefined, STATE.logLines.join('\n'), { multiline:true, readonly:true, scrolling:true });
    STATE.logField.preferredSize = [680, 260];
    STATE.logField.alignment = ['fill','fill'];

    btnChoose.onClick = chooseFolder;
    btnScan.onClick = function(){ appendLog('Manual scan'); rescan(); };
    btnBuild.onClick = function(){ if (!STATE.watchFolder){ chooseFolder(); if (!STATE.watchFolder) return; } buildNext(false); rescan(); };
    btnBuildJob.onClick = function(){ chooseAndBuildJob(); rescan(); };
    STATE.autoBtn.onClick = toggleAuto;

    pal.onClose = function(){ STATE.auto = false; updateAutoButton(); return true; };
    pal.layout.layout(true);
    pal.layout.resize();
    STATE.win = pal;
    return pal;
  }

  if (!STATE.watchFolder) STATE.watchFolder = loadFolderSetting();
  var panel = buildUI(thisObj);
  if (STATE.watchFolder && STATE.pathText) STATE.pathText.text = STATE.watchFolder.fsName;
  appendLog('Ready. Use Build Next for one pending job, or Auto ON for continuous builds.');
  appendLog('Tip: install this file in AE ScriptUI Panels, then open it from Window > PostFlowX_AE_Panel.');
  rescan();
  if (panel instanceof Window){ panel.center(); panel.show(); }
})(this);`;
}

function buildAEPPanelInstallCommand(job){
  const panelName = String(job?.output?.panelName || 'PostFlowX_AE_Panel.jsx');
  return `#!/bin/bash
set -euo pipefail
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
PANEL_SRC="$SELF_DIR/${panelName}"
if [ ! -f "$PANEL_SRC" ]; then
  echo "Missing panel file: $PANEL_SRC"
  exit 1
fi
TARGET="$(osascript <<'APPLESCRIPT'
set chosen to choose folder with prompt "Choose the After Effects ScriptUI Panels folder"
POSIX path of chosen
APPLESCRIPT
)"
TARGET="\${TARGET%/}"
mkdir -p "$TARGET"
cp -f "$PANEL_SRC" "$TARGET/${panelName}"
osascript <<APPLESCRIPT >/dev/null 2>&1 || true
display dialog "Installed ${panelName}\n\nNext:\n1) Open or restart After Effects\n2) Open Window > ${panelName.replace(/\.jsx$/,'')}" buttons {"OK"} default button "OK"
APPLESCRIPT
echo "Installed: $TARGET/${panelName}"
`;
}
function buildAEPQueueRenderJSX(job){
  const manifestName = String(job?.output?.manifestName || 'PostFlowX_AEP_BatchManifest.json');
  return `// Generated by PostFlowX — queue render comps helper
(function(){
  function trimSlash(s){ return String(s||'').replace(/[\/]+$/,''); }
  function parentFolder(fileObj){ try{ return fileObj ? fileObj.parent : null; }catch(e){ return null; } }
  function joinFs(base, leaf){
    try{
      var b = trimSlash(base && base.fsName ? base.fsName : base || '');
      var l = String(leaf||'').replace(/^([\/]+)/,'');
      return b ? (b + '/' + l) : l;
    }catch(e){ return String(leaf||''); }
  }
  function readJson(fileObj){
    try{
      if (!fileObj || !fileObj.exists) return null;
      fileObj.encoding = 'UTF-8';
      fileObj.open('r');
      var txt = fileObj.read();
      fileObj.close();
      return txt ? JSON.parse(txt) : null;
    }catch(e){ try{ if (fileObj && fileObj.close) fileObj.close(); }catch(_e){} return null; }
  }
  function findSiblingSpec(renderCompName){
    try{
      if (!app.project || !app.project.file) return null;
      var projDir = parentFolder(app.project.file);
      if (!projDir) return null;
      var shotsDir = new Folder(joinFs(projDir.parent, '01_SHOTS'));
      if (!shotsDir.exists) return null;
      var stack = [shotsDir];
      while (stack.length){
        var dir = stack.shift();
        var kids = dir.getFiles();
        for (var i=0; i<kids.length; i++){
          var it = kids[i];
          try{
            if (it instanceof Folder) { stack.push(it); continue; }
            var nm = String(it.name||'');
            if (!/_RenderSpec\.json$/i.test(nm)) continue;
            var data = readJson(it);
            if (!data || !data.shots || !data.shots.length) continue;
            for (var j=0; j<data.shots.length; j++){
              var s = data.shots[j] || {};
              if (String(s.renderCompName||'') === String(renderCompName||'')){
                return { file: it, data: data, shot: s };
              }
            }
          }catch(e){}
        }
      }
    }catch(e){}
    return null;
  }
  function ensureFolderPath(pathStr){
    try{
      var f = new Folder(String(pathStr||''));
      if (!f.exists) f.create();
      return f;
    }catch(e){ return null; }
  }
  function safeStem(s){
    var out = String(s||'').replace(/\.[^.]+$/,'').replace(/[^A-Za-z0-9._-]+/g,'_').replace(/_+/g,'_');
    out = out.replace(/^_+|_+$/g,'');
    return out || 'SHOT_v001';
  }
  function listRenderComps(){
    var out = [];
    if (!app.project) return out;
    for (var i=1; i<=app.project.numItems; i++){
      var it = app.project.item(i);
      try{
        if (it instanceof CompItem && /__RENDER$/i.test(String(it.name||''))) out.push(it);
      }catch(e){}
    }
    return out;
  }
  function configureRQItem(rqItem, comp){
    if (!rqItem || !comp) return { ok:false, mode:'none' };
    var found = findSiblingSpec(comp.name);
    var outFile = null;
    var note = 'manual';
    try{
      if (found && found.data){
        var projDir = parentFolder(app.project.file);
        var rootDir = projDir ? projDir.parent : null;
        var renderDirRel = String((found.shot && found.shot.renderDir) || found.data.renderDir || '04_RENDERS');
        var folder = ensureFolderPath(joinFs(rootDir, renderDirRel));
        if (folder){
          var fileStem = safeStem((found.data && found.data.suggestedFileStem) || comp.name || 'SHOT_v001');
          outFile = new File(joinFs(folder, fileStem + '.mov'));
          note = 'spec';
        }
      }
      if (!outFile){
        var chosen = File.saveDialog('Choose render output for ' + comp.name, '*.mov');
        if (chosen) outFile = chosen;
      }
      if (!outFile) return { ok:false, mode:'skip' };
      try{ rqItem.outputModule(1).file = outFile; }catch(e){}
      try{ rqItem.comment = 'PostFlowX ' + note + ' output'; }catch(e){}
      return { ok:true, mode:note, file:outFile.fsName };
    }catch(e){ return { ok:false, mode:'error', error:String(e) }; }
  }
  function addSelectedOrAllToRQ(){
    var comps = listRenderComps();
    if (!comps.length){ alert('No __RENDER comps found in this project.'); return; }
    app.beginUndoGroup('PostFlowX Queue Render Comps');
    var added = 0, autoMapped = 0, asked = 0, skipped = 0;
    var logs = [];
    try{
      for (var i=0; i<comps.length; i++){
        try{
          var rq = app.project.renderQueue.items.add(comps[i]);
          added++;
          var cfg = configureRQItem(rq, comps[i]);
          if (cfg.ok && cfg.mode === 'spec') autoMapped++;
          else if (cfg.ok && cfg.mode === 'manual') asked++;
          else if (cfg.mode === 'skip') skipped++;
          if (cfg.file) logs.push(comps[i].name + ' -> ' + cfg.file);
        }catch(e){}
      }
    } finally {
      app.endUndoGroup();
    }
    alert('Queued ' + added + ' render comp(s).
Auto-mapped from RenderSpec: ' + autoMapped + '
Manual output picks: ' + asked + '
Skipped output selection: ' + skipped + '
Reference manifest: ${manifestName}' + (logs.length ? '

' + logs.slice(0,8).join('
') : ''));
  }
  addSelectedOrAllToRQ();
})();
`;
}


function buildAEPReadme(job, meta={}){
  const out = job?.output || {};
  const batchStem = String(meta?.batchStem || job?.batch?.baseStem || safeFileStem(job?.sourceEdlTitle || job?.edlTitle || 'VFX_Project'));
  const jobCount = Math.max(1, Number(meta?.jobCount) || Number(job?.batch?.jobCount) || 1);
  const perShot = jobCount > 1 || String(job?.exportMode || '').toLowerCase() === 'per-shot';
  const jobLabel = perShot ? `${batchStem}_*_AEP_Job.json (${jobCount} files, one per shot)` : (out.jobName || 'VFX_Project_AEP_Job.json');
  const jsxLabel = perShot ? `${batchStem}_*_Build_AE_Project.jsx (${jobCount} files, one per shot)` : (out.jsxName || 'VFX_Project_Build_AE_Project.jsx');
  const aepLabel = perShot ? `${batchStem}_*.aep (${jobCount} per-shot projects)` : (out.aepName || 'VFX_Project.aep');
  const panelWindowName = String(out.panelName || 'PostFlowX_AE_Panel.jsx').replace(/\.jsx$/i, '');
  const renderLabel = perShot ? `04_RENDERS/<shot>/ (${jobCount} shot folders)` : (out.renderDir || '04_RENDERS/');
  const deliveryLabel = perShot ? `05_DELIVERY/<shot>/ (${jobCount} shot folders)` : (out.deliveryDir || '05_DELIVERY/');
  const lines = [
    'PostFlowX AE Project handoff',
    '',
    perShot ? `Export mode: per shot (${jobCount} jobs)` : 'Export mode: timeline package',
    '',
    'Package folders written by the extension:',
    '- 00_MASTER : shared AE helpers, queue helper, README, and batch manifest',
    '- 01_SHOTS/<shot> : per-shot job JSON, builder JSX, built .aep, and done sidecars',
    '- 04_RENDERS/<shot> : suggested per-shot render output folder',
    '- 05_DELIVERY/<shot> : suggested per-shot delivery folder',
    '',
    'AE project structure created by the builder:',
    '- 00_MASTER : delivery / assembled master comps',
    '- 01_SHOTS/<shot> : per-shot working comps',
    '- 02_PLATES/<shot> : imported plate/image sequences',
    '- 03_DATA/<shot> : look/data placeholders for the shot package',
    '- 04_OUTPUT/<shot> : render-ready notes / queue targets in the AE project',
    '',
    'Files exported by the extension:',
    `- ${jobLabel} : job description JSON`,
    `- ${jsxLabel} : one-shot builder JSX`,
    `- ${out.watchRelPath || out.watchName || '00_MASTER/PostFlowX_AE_WatchFolder.jsx'} : watch mode`,
    `- ${out.panelRelPath || out.panelName || '00_MASTER/PostFlowX_AE_Panel.jsx'} : dockable AE panel`,
    `- ${out.installRelPath || out.installName || '00_MASTER/Install_PostFlowX_AE_Panel.command'} : macOS helper to install the AE panel`,
    `- ${out.manifestRelPath || out.manifestName || '00_MASTER/VFX_Project_AEP_BatchManifest.json'} : batch manifest`,
    `- ${out.readmeRelPath || out.readmeName || '00_MASTER/VFX_Project_AEP_README.txt'} : this guide`,
    '- AE comps now include guide info text, control nulls, timing markers, adjustment placeholders, note layers, safe-title guides, and render-output notes per shot.',
    `- Suggested render folder: ${renderLabel}`,
    `- Suggested delivery folder: ${deliveryLabel}`,
    '',
    'Recommended setup (panel install):',
    `1) Run ${out.installRelPath || out.installName || '00_MASTER/Install_PostFlowX_AE_Panel.command'}`,
    '2) Choose the After Effects ScriptUI Panels folder when prompted',
    '3) Open or restart After Effects',
    `4) Open Window > ${panelWindowName}`,
    '5) In the panel, choose the exported VFX root or the 01_SHOTS folder',
    '6) Click Auto ON for continuous builds, or Build Next for one pending job',
    '',
    'Manual one-shot build:',
    '1) Open After Effects',
    '2) File > Scripts > Run Script File...',
    '3) Choose one of the exported builder JSX files inside 01_SHOTS/<shot>/',
    `4) That script reads the matching job JSON and saves ${aepLabel} next to the job`,
    '',
    'Watch mode (portable, no install):',
    '1) Open After Effects in a dedicated session',
    '2) File > Scripts > Run Script File...',
    `3) Choose ${out.watchRelPath || out.watchName || '00_MASTER/PostFlowX_AE_WatchFolder.jsx'}`,
    '4) In the watch window, choose the exported VFX root',
    '5) Click Auto ON to let AE build new jobs automatically',
    '',
    'Notes:',
    '- The dockable panel and watch mode do not require Native Messaging.',
    '- Re-exporting a newer job JSON with a new generatedAt timestamp will be treated as pending again.',
    '- Each processed job gets a sidecar *.done.json next to the job file so AE will not rebuild the same job forever.',
    '- The panel and watch mode scan recursively, so nested per-shot folders are supported.',
    '- Keep the AE auto-build session dedicated to PostFlowX builds to avoid replacing an unrelated open project.'
  ];
  return lines.join("\n");
}

export async function exportAEProjectPackage(result) {
  const pack = buildAEPHandoffJobs(result);
  const jobs = Array.isArray(pack?.jobs) && pack.jobs.length ? pack.jobs : [buildAEPHandoffJob(result)];
  const shared = pack?.shared || __aepSharedOutputNames(pack?.ctx || getAEPHandoffContext(result));
  const primaryJob = jobs[0];
  const readmeText = buildAEPReadme(primaryJob, {
    jobCount: jobs.length,
    batchStem: pack?.ctx?.tlStem || primaryJob?.batch?.baseStem || 'VFX_Project'
  });
  const watchText = buildAEPWatchFolderJSX(primaryJob);
  const panelText = buildAEPPanelJSX(primaryJob);
  const queueText = buildAEPQueueRenderJSX(primaryJob);
  const installText = buildAEPPanelInstallCommand(primaryJob);
  const manifestText = buildAEPBatchManifest({ ctx: pack?.ctx, shared, jobs, mode: pack?.mode });

  const files = [];
  let savedToVfxRoot = true;

  for (const job of jobs){
    const jobText = JSON.stringify(job, null, 2);
    const jsxText = buildAEPBuilderJSX(job);
    const renderSpecText = buildAEPRenderSpec(job);
    const deliverySpecText = buildAEPDeliverySpec(job);
    files.push(job.output.jobRelPath, job.output.jsxRelPath, job.output.renderSpecRelPath, job.output.deliverySpecRelPath);
    savedToVfxRoot = (await __saveTextToVfxRoot(job.output.jobRelPath, jobText, 'application/json')) && savedToVfxRoot;
    savedToVfxRoot = (await __saveTextToVfxRoot(job.output.jsxRelPath, jsxText, 'application/javascript')) && savedToVfxRoot;
    savedToVfxRoot = (await __saveTextToVfxRoot(job.output.renderSpecRelPath, renderSpecText, 'application/json')) && savedToVfxRoot;
    savedToVfxRoot = (await __saveTextToVfxRoot(job.output.deliverySpecRelPath, deliverySpecText, 'application/json')) && savedToVfxRoot;
  }

  const placeholderText = 'PostFlowX placeholder\n';
  for (const job of jobs){
    if (job?.output?.renderDir) {
      const shotRenderRel = `${job.output.renderDir}/.keep`;
      files.push(shotRenderRel);
      savedToVfxRoot = (await __saveTextToVfxRoot(shotRenderRel, placeholderText, 'text/plain')) && savedToVfxRoot;
    }
    if (job?.output?.deliveryDir) {
      const shotDeliveryRel = `${job.output.deliveryDir}/.keep`;
      files.push(shotDeliveryRel);
      savedToVfxRoot = (await __saveTextToVfxRoot(shotDeliveryRel, placeholderText, 'text/plain')) && savedToVfxRoot;
    }
  }

  files.push(shared.watchRelPath, shared.panelRelPath, shared.queueRelPath, shared.installRelPath, shared.readmeRelPath, shared.manifestRelPath);
  savedToVfxRoot = (await __saveTextToVfxRoot(shared.watchRelPath, watchText, 'application/javascript')) && savedToVfxRoot;
  savedToVfxRoot = (await __saveTextToVfxRoot(shared.panelRelPath, panelText, 'application/javascript')) && savedToVfxRoot;
  savedToVfxRoot = (await __saveTextToVfxRoot(shared.queueRelPath, queueText, 'application/javascript')) && savedToVfxRoot;
  savedToVfxRoot = (await __saveTextToVfxRoot(shared.installRelPath, installText, 'text/x-shellscript')) && savedToVfxRoot;
  savedToVfxRoot = (await __saveTextToVfxRoot(shared.readmeRelPath, readmeText, 'text/plain')) && savedToVfxRoot;
  savedToVfxRoot = (await __saveTextToVfxRoot(shared.manifestRelPath, manifestText, 'application/json')) && savedToVfxRoot;

  return {
    ok: true,
    savedToVfxRoot,
    mode: jobs.length > 1 ? 'per-shot' : 'single-shot',
    files,
    aepName: jobs.length === 1 ? jobs[0].output.aepName : null,
    aepNames: jobs.map(j => j.output.aepName),
    aepPaths: jobs.map(j => j.output.aepRelPath || j.output.aepName),
    jobName: jobs.length === 1 ? jobs[0].output.jobName : null,
    jobNames: jobs.map(j => j.output.jobName),
    jobPaths: jobs.map(j => j.output.jobRelPath || j.output.jobName),
    jsxName: jobs.length === 1 ? jobs[0].output.jsxName : null,
    jsxNames: jobs.map(j => j.output.jsxName),
    jsxPaths: jobs.map(j => j.output.jsxRelPath || j.output.jsxName),
    watchName: shared.watchName,
    watchPath: shared.watchRelPath,
    panelName: shared.panelName,
    panelPath: shared.panelRelPath,
    queueName: shared.queueName,
    queuePath: shared.queueRelPath,
    installName: shared.installName,
    installPath: shared.installRelPath,
    readmeName: shared.readmeName,
    readmePath: shared.readmeRelPath,
    manifestName: shared.manifestName,
    manifestPath: shared.manifestRelPath,
    shotCount: jobs.length,
    jobCount: jobs.length
  };
}


let __aepxShotStubTemplatePromise = null;

async function __loadAEPXShotStubTemplate(){
  if (__aepxShotStubTemplatePromise) return __aepxShotStubTemplatePromise;
  const rel = 'assets/templates/ae/postflowx_shot_stub.aepx';
  const url = (typeof chrome !== 'undefined' && chrome?.runtime?.getURL)
    ? chrome.runtime.getURL(rel)
    : rel;
  __aepxShotStubTemplatePromise = fetch(url).then(async (resp) => {
    if (!resp || !resp.ok) throw new Error('AEPX starter template is missing.');
    return await resp.text();
  });
  return __aepxShotStubTemplatePromise;
}

function __aepxSharedOutputNames(ctx){
  const tlStem = String(ctx?.tlStem || 'VFX_Project');
  const masterDir = '00_MASTER';
  const readmeName = `${tlStem}_AEPX_README.txt`;
  const manifestName = `${tlStem}_AEPX_BatchManifest.json`;
  return {
    masterDir,
    shotsDir: '01_SHOTS',
    readmeName,
    readmeRelPath: `${masterDir}/${readmeName}`,
    manifestName,
    manifestRelPath: `${masterDir}/${manifestName}`
  };
}

function __xmlText(v=''){
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function __xmlCommentText(v=''){
  return String(v ?? '').replace(/--/g, '—');
}

function __aepxShotPaths(job, ctx){
  const packageDir = __trimEdgeSlashLike(String(job?.output?.packageDir || `${__aepxSharedOutputNames(ctx).shotsDir}/${safeFileStem(job?.shots?.[0]?.shotName || 'SHOT', 'SHOT')}`));
  const baseStem = safeFileStem(String(job?.output?.aepName || `${ctx?.tlStem || 'VFX_Project'}.aep`).replace(/\.aep$/i, ''), ctx?.tlStem || 'VFX_Project');
  const aepxName = `${baseStem}.aepx`;
  const manifestName = `${baseStem}_AEPX_Manifest.json`;
  return {
    packageDir,
    aepxName,
    aepxRelPath: `${packageDir}/${aepxName}`,
    manifestName,
    manifestRelPath: `${packageDir}/${manifestName}`
  };
}

function buildAEPXStarterManifest(job, extra={}){
  const shot = Array.isArray(job?.shots) && job.shots.length ? job.shots[0] : null;
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    schema: 'postflowx.aepx.starter.v1',
    exportMode: String(job?.exportMode || 'per-shot'),
    rootName: String(job?.rootName || ''),
    edlTitle: String(job?.edlTitle || ''),
    fps: Number(job?.fps || DEFAULT_FPS),
    starterProject: {
      fileName: extra?.aepxName || null,
      filePath: extra?.aepxRelPath || null,
      template: 'postflowx_shot_stub.aepx',
      note: 'Extension-generated AE XML starter project. Starter comp and sidecar manifest are generated in Chrome without Native Host.'
    },
    shot: shot ? {
      shotName: shot.shotName || null,
      compName: shot.compName || shot.locShotName || shot.shotName || null,
      locShotName: shot.locShotName || null,
      scopeOfWork: shot.scopeOfWork || null,
      cameraMeta: shot.cameraMeta || null,
      seq: shot.seq || null,
      look: shot.look || null,
      edlHits: Array.isArray(shot.edlHits) ? shot.edlHits : [],
      flags: shot.flags || null
    } : null
  }, null, 2);
}

function buildAEPXBatchManifest(pack){
  const ctx = pack?.ctx || null;
  const shared = __aepxSharedOutputNames(ctx || {});
  const jobs = Array.isArray(pack?.jobs) ? pack.jobs : [];
  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    schema: 'postflowx.aepx.batch.v1',
    mode: String(pack?.mode || (jobs.length > 1 ? 'per-shot' : 'timeline')),
    rootName: String(ctx?.rootName || ''),
    edlTitle: String(ctx?.edlTitle || ''),
    fps: Number(ctx?.fps || DEFAULT_FPS),
    readmeName: shared.readmeName,
    readmeRelPath: shared.readmeRelPath,
    manifestName: shared.manifestName,
    manifestRelPath: shared.manifestRelPath,
    jobs: jobs.map((job) => {
      const paths = __aepxShotPaths(job, ctx || {});
      const shot = Array.isArray(job?.shots) && job.shots.length ? job.shots[0] : null;
      return {
        shotName: shot?.shotName || null,
        compName: shot?.compName || shot?.locShotName || shot?.shotName || null,
        aepxName: paths.aepxName,
        aepxRelPath: paths.aepxRelPath,
        manifestName: paths.manifestName,
        manifestRelPath: paths.manifestRelPath
      };
    })
  }, null, 2);
}

function buildAEPXReadme(pack){
  const ctx = pack?.ctx || {};
  const jobs = Array.isArray(pack?.jobs) ? pack.jobs : [];
  const shared = __aepxSharedOutputNames(ctx);
  const lines = [
    'PostFlowX AE XML starter export (.aepx)',
    '',
    `Batch: ${ctx?.tlStem || 'VFX_Project'}`,
    `Shots: ${jobs.length || 0}`,
    '',
    'What is included:',
    '- One AE XML starter project (*.aepx) per exported shot',
    '- One sidecar manifest (*.json) per exported shot with sequence / look / EDL references',
    `- One batch manifest in ${shared.manifestRelPath}`,
    '',
    'How to use:',
    '1) Open any exported .aepx file in After Effects',
    '2) Read the matching *_AEPX_Manifest.json file next to it for source plate, look, and EDL metadata',
    '3) Import / relink footage in After Effects as needed',
    '',
    'Notes:',
    '- This export is generated entirely inside the Chrome extension (extension-only mode).',
    '- It does not require Native Host.',
    '- It is a starter project intended to preserve shot naming and handoff metadata in a browser-safe export flow.'
  ];
  return lines.join('\n');
}

async function buildAEPXStarterProject(job, templateText){
  const shot = Array.isArray(job?.shots) && job.shots.length ? job.shots[0] : null;
  const shotName = String(shot?.shotName || shot?.compName || shot?.locShotName || 'SHOT');
  const compName = safeCompName(shot?.compName || shot?.locShotName || shotName, shotName);
  const layerNameBase = shot?.scopeOfWork ? `${shotName} · ${shot.scopeOfWork}` : `${shotName} · PostFlowX`;
  const layerName = layerNameBase.slice(0, 80);
  const seq = shot?.seq || null;
  const noteParts = [
    'PostFlowX starter AEPX',
    `shot=${shotName}`,
    `comp=${compName}`,
    seq?.firstFileRel ? `plate=${seq.firstFileRel}` : null,
    shot?.look?.relPath ? `look=${shot.look.relPath}` : null
  ].filter(Boolean);
  let xml = String(templateText || '');
  xml = xml.replace('__PFX_COMP_NAME__', __xmlText(compName));
  xml = xml.replace('__PFX_LAYER_NAME__', __xmlText(layerName));
  xml = xml.replace('__PFX_XML_COMMENT__', __xmlCommentText(noteParts.join(' | ')));
  return xml;
}

export async function exportAEPXPackage(result) {
  const pack = buildAEPHandoffJobs(result);
  const jobs = Array.isArray(pack?.jobs) && pack.jobs.length ? pack.jobs : [buildAEPHandoffJob(result)];
  const ctx = pack?.ctx || getAEPHandoffContext(result);
  const shared = __aepxSharedOutputNames(ctx);
  const templateText = await __loadAEPXShotStubTemplate();
  const files = [];
  let savedToVfxRoot = true;

  for (const job of jobs){
    const paths = __aepxShotPaths(job, ctx);
    const xmlText = await buildAEPXStarterProject(job, templateText);
    const manifestText = buildAEPXStarterManifest(job, paths);
    files.push(paths.aepxRelPath, paths.manifestRelPath);
    savedToVfxRoot = (await __saveTextToVfxRoot(paths.aepxRelPath, xmlText, 'application/xml')) && savedToVfxRoot;
    savedToVfxRoot = (await __saveTextToVfxRoot(paths.manifestRelPath, manifestText, 'application/json')) && savedToVfxRoot;
  }

  const batchManifestText = buildAEPXBatchManifest({ ctx, jobs, mode: pack?.mode });
  const readmeText = buildAEPXReadme({ ctx, jobs, mode: pack?.mode });
  files.push(shared.manifestRelPath, shared.readmeRelPath);
  savedToVfxRoot = (await __saveTextToVfxRoot(shared.manifestRelPath, batchManifestText, 'application/json')) && savedToVfxRoot;
  savedToVfxRoot = (await __saveTextToVfxRoot(shared.readmeRelPath, readmeText, 'text/plain')) && savedToVfxRoot;

  return {
    ok: true,
    savedToVfxRoot,
    mode: jobs.length > 1 ? 'per-shot' : 'single-shot',
    files,
    aepxNames: jobs.map((job) => __aepxShotPaths(job, ctx).aepxName),
    aepxPaths: jobs.map((job) => __aepxShotPaths(job, ctx).aepxRelPath),
    manifestNames: jobs.map((job) => __aepxShotPaths(job, ctx).manifestName),
    manifestPaths: jobs.map((job) => __aepxShotPaths(job, ctx).manifestRelPath),
    readmeName: shared.readmeName,
    readmePath: shared.readmeRelPath,
    batchManifestName: shared.manifestName,
    batchManifestPath: shared.manifestRelPath,
    shotCount: jobs.length,
    jobCount: jobs.length
  };
}

// -----------------------------
// Export: After Effects JSX (unchanged core behavior)
// -----------------------------
export function exportAEJSX(result) {
  const fps = result?.fps || DEFAULT_FPS;
  const shots = result?.shots || [];
  const hasAnyEDL = shots.some(s => (s.edl?.hits || []).length);

  const manifest = {
    fps,
    rootName: result?.rootName || "VFX_ROOT",
    edlTitle: safeCompName(result?.edlTitle, "MASTER_TIMELINE"),
    shots: shots.map(s => ({
      shotName: s.shotName,
      // Use LOC shotName as primary comp name when available.
      compName: s.compName || s.locShotName || s.shotName,
      locShotName: s.locShotName || null,
      seq: s.seq ? {
        firstFileRel: s.seq.firstFileRel,
        patternRel: s.seq.patternRel,
        start: s.seq.start,
        end: s.seq.end,
        padding: s.seq.padding
      } : null,
      look: s.look ? { relPath: s.look.relPath, type: s.look.type } : null,
      edlHits: (s.edl?.hits || []).map(h => ({ recIn: h.recIn, recOut: h.recOut }))
    }))
  };

  const jsx = `/* eslint-disable */
// Generated by PostFlowX (VFX Mapping)
// Usage: File > Scripts > Run Script File… (select this .jsx)
(function(){
  function tcToFrames(tc,fps){
    var m = (tc||"").replace(/;/g, ':').match(/^(\\d+):(\\d+):(\\d+):(\\d+)$/);
    if(!m) return 0;
    return ((+m[1]*3600 + +m[2]*60 + +m[3]) * fps) + (+m[4]);
  }
  function framesToSec(fr,fps){ return fr / fps; }

  function ensureComp(name, w, h, durSec, fps_){
    for(var i=1;i<=app.project.numItems;i++){
      var it = app.project.item(i);
      if(it instanceof CompItem && it.name === name) return it;
    }
    return app.project.items.addComp(name, w, h, 1, durSec, fps_);
  }

  var MANIFEST = ${JSON.stringify(manifest, null, 2)};

  if(!app.project) app.newProject();
  app.beginUndoGroup("MPS VFX Mapping Build");

  var root = Folder.selectDialog("Select VFX ROOT folder (contains EXR_Files / Look_Files / EDL)");
  if(!root){ alert("No folder selected."); app.endUndoGroup(); return; }

  var fps = MANIFEST.fps || ${fps};

  function importSequence(firstFileRel){
    var f = new File(root.fsName + "/" + firstFileRel);
    if(!f.exists){ alert("Missing sequence file:\\n" + f.fsName); return null; }
    var io = new ImportOptions(f);
    io.sequence = true;
    var item = app.project.importFile(io);
    try{ item.mainSource.conformFrameRate = fps; }catch(e){}
    return item;
  }

  function applyCubeLUT(layer, cubeRelPath){
    try{
      var fx = layer.property("ADBE Effect Parade");
      if(!fx) return;
      var eff = fx.addProperty("ADBE Apply Color LUT2");
      if(!eff) return;
      var fileProp = eff.property(1);
      if(fileProp){ fileProp.setValue(new File(root.fsName + "/" + cubeRelPath)); }
    }catch(e){}
  }

  var shotFolder = app.project.items.addFolder("MPS_SHOTS");
  var compsByShot = {};
  var created = 0;

  for(var i=0;i<MANIFEST.shots.length;i++){
    var s = MANIFEST.shots[i];
    if(!s.seq || !s.seq.firstFileRel) continue;

    var footage = importSequence(s.seq.firstFileRel);
    if(!footage) continue;

    var seqLen = Math.max(1, (s.seq.end - s.seq.start + 1));
    var durSec = seqLen / fps;
    var compName = s.compName || s.shotName;

    // Create the shot comp (or find existing) — same as Nuke Read node per shot
    var comp = ensureComp(compName, 1920, 1080, durSec, fps);
    comp.parentFolder = shotFolder;
    footage.parentFolder = shotFolder;

    var layer = comp.layers.add(footage);
    layer.startTime = 0;
    layer.inPoint = 0;
    layer.outPoint = durSec;

    if(s.look && s.look.relPath){
      if(String(s.look.type).toLowerCase() === "cube"){
        applyCubeLUT(layer, s.look.relPath);
      }
    }

    compsByShot[compName] = comp;
    created++;
  }

  if(${hasAnyEDL ? "true" : "false"}){
    var segs = [];
    var minRec = null;
    var maxRec = 0;

    for(var j=0;j<MANIFEST.shots.length;j++){
      var sh = MANIFEST.shots[j];
      var compKey = sh.compName || sh.shotName;
      var comp = compsByShot[compKey];
      if(!comp) continue;

      for(var k=0;k<(sh.edlHits||[]).length;k++){
        var h = sh.edlHits[k];
        var a = tcToFrames(h.recIn, fps);
        var b = tcToFrames(h.recOut, fps);
        var dur = Math.max(1, b - a);

        if(minRec === null || a < minRec) minRec = a;
        if(b > maxRec) maxRec = b;

        segs.push({ shotName: compKey, comp: comp, recInF: a, recOutF: b, durF: dur, speedPct: (Number(h.speedPct)||100) });
      }
    }

    if(segs.length){
      segs.sort(function(x,y){ return x.recInF - y.recInF; });

      var base = (minRec !== null) ? minRec : 0;
      var totalFrames = (maxRec - base);
      var masterDur = Math.max(1, totalFrames) / fps;

      var masterName = (MANIFEST.edlTitle && String(MANIFEST.edlTitle).length) ? String(MANIFEST.edlTitle) : "MASTER_TIMELINE";
      var master = ensureComp(masterName, 1920, 1080, masterDur);
      master.parentFolder = app.project.rootFolder;

      for(var sidx=0;sidx<segs.length;sidx++){
        var sg = segs[sidx];
        var startF = sg.recInF - base;
        var startS = framesToSec(startF, fps);
        var durS = framesToSec(sg.durF, fps);

        var ly = master.layers.add(sg.comp);
        // SPEED: apply time-stretch on precomp layer (retimes all layers inside)
        if(sg.speedPct && Math.abs(sg.speedPct - 100) > 0.0001){
          try{ ly.stretch = (10000 / sg.speedPct); }catch(e){}
        }
        ly.startTime = startS;
        ly.inPoint = startS;
        ly.outPoint = startS + durS;
      }
    }
  }

  app.endUndoGroup();
  alert("Done. Created " + created + " shot comp(s).");
})();`;

  const tlName = safeFileStem(result?.edlTitle || result?.rootName || "MPS_VFX_Mapping");
  downloadText(`${tlName}_Create_AE_Project.jsx`, jsx, "application/javascript");
}

// -----------------------------
// Export: Nuke PY (per-shot only)
// - applies CDL via ColorCorrect when parsed
// -----------------------------
export async function exportNukePY(result) {
  const fps = result?.fps || DEFAULT_FPS;
  const shots = result?.shots || [];
  const prefs = getNukeExportPrefs();

  // Option C: Prefer saving .nk into the selected VFX ROOT folder (so script_directory resolves EXR_Files).
  // If user cancels / unsupported, we still export and rely on MPS_VFX_ROOT knob as fallback.
  if (!__vfxDirHandle) {
    try { await __pickVfxDirectoryHandle(); } catch(e) {}
  }

  const ocioCfg = prefs.ocioConfigPath || '[getenv OCIO]';
  const workingSpace = prefs.workingSpace || 'scene_linear';
  const readCS = prefs.readColorspace || workingSpace;
  const applyAllAmf = !!prefs.applyAllAmf;

  const lines = [];
  lines.push('# Generated by PostFlowX (VFX Mapping)');
  lines.push('# Run inside Nuke Script Editor.');
  lines.push('import os');
  lines.push('import nuke');
  lines.push('');
  lines.push(`fps = ${fps}`);
  lines.push('root = nuke.root()');
  lines.push("try: root['fps'].setValue(float(fps))\nexcept: pass");
  lines.push('');
  lines.push(`MPS_OCIO_CFG = ${JSON.stringify(String(ocioCfg))}`);
  lines.push(`MPS_WORKING = ${JSON.stringify(String(workingSpace))}`);
  lines.push(`MPS_READ_CS = ${JSON.stringify(String(readCS))}`);
  lines.push(`MPS_APPLY_ALL_AMF = ${applyAllAmf ? 'True' : 'False'}`);
  lines.push('');

  lines.push(
`def _set_enum(knob, candidates):
    if knob is None:
        return None
    try:
        vals = list(knob.values())
    except Exception:
        vals = []
    for c in candidates:
        if c in vals:
            try:
                knob.setValue(c)
                return c
            except Exception:
                pass
    for c in candidates:
        try:
            knob.setValue(c)
            return c
        except Exception:
            pass
    return None

def _setup_ocio():
    try:
        r = nuke.root()
        if "colorManagement" in r.knobs():
            r["colorManagement"].setValue("OCIO")
        if "OCIO_config" in r.knobs():
            _set_enum(r["OCIO_config"], [
                "fn-nuke_studio-config-v1.0.0_aces-v1.3_ocio-v2.1.ocio",
                "fn-nuke_studio-config-v1.0.0_aces-v1.3_ocio-v2.1",
                "aces_1.2",
                "aces_1.3",
                "nuke-default",
            ])
        if "workingSpaceLUT" in r.knobs() and MPS_WORKING:
            _set_enum(r["workingSpaceLUT"], [
                MPS_WORKING,
                "scene_linear",
                "ACES - ACEScg",
                "ACEScg",
                "ACES2065-1",
                "linear",
            ])
    except Exception:
        pass

_setup_ocio()
`
  );

  lines.push('');
  lines.push('# Select VFX ROOT folder (contains EXR_Files / Look_Files)');
  lines.push("basePath = nuke.getFilename('Select VFX ROOT (folder)', '*.') or ''");
  lines.push("if not basePath: raise RuntimeError('No root selected')");
  lines.push("basePath = basePath.replace('\\\\','/').rstrip('/')");
  lines.push('');

  for (const s of shots) {
    if (!s.seq?.patternRel) continue;

    const safeName = (s.compName || s.locShotName || s.shotName).replace(/[^\w]+/g, '_');
    const patternRel = '/' + normSlash(s.seq.patternRel);

    lines.push(`# ---- ${s.shotName} ----`);
    lines.push(`r = nuke.nodes.Read(name='READ_${safeName}')`);
    lines.push(`r['file'].setValue(basePath + ${JSON.stringify(patternRel)})`);
    lines.push(`r['first'].setValue(${s.seq.start})`);
    lines.push(`r['last'].setValue(${s.seq.end})`);
    lines.push(`r['origfirst'].setValue(${s.seq.start})`);
    lines.push(`r['origlast'].setValue(${s.seq.end})`);
    lines.push("try:\n  if 'colorspace' in r.knobs(): r['colorspace'].setValue(MPS_READ_CS)\nexcept: pass");
    lines.push('prev = r');

    const look = s.look || null;
    if (look) {
      const t = String(look.type || '').toLowerCase();

      // AMF: apply LMT look(s) + CDL (if applied=true, or forced)
      if (t === 'amf') {
        const looks = (Array.isArray(look.amfLooks) && look.amfLooks.length)
          ? look.amfLooks
          : (applyAllAmf && Array.isArray(look.amfLooksAll) ? look.amfLooksAll : null);

        if (looks && looks.length) {
          let _lidx = 0;
          for (const _lk of looks) {
            _lidx++;
            const _n = `LMT_${safeName}_${String(_lidx).padStart(2,'0')}`;
            lines.push(`lmt = nuke.nodes.OCIOLookTransform(inputs=[prev], name='${_n}')`);
            lines.push(`lmt['look'].setValue(${JSON.stringify(String(_lk))})`);
            lines.push("try:\n  lmt['in_colorspace'].setValue(MPS_WORKING)\n  lmt['out_colorspace'].setValue(MPS_WORKING)\nexcept: pass");
            lines.push('prev = lmt');
          }
        }
      }

      // Numeric CDL (already parsed) for AMF/CDL/CC
      if ((t === 'amf' || t === 'cdl' || t === 'cc') && look.cdl) {
        const allowCdl = (t !== 'amf') ? true : (applyAllAmf || (look.amfCdlApplied === true));
        if (allowCdl) {
          const c = look.cdl;
          const ws = String(look.cdlWorkingSpace || 'ACEScct');
          lines.push(`cdl = nuke.nodes.OCIOCDLTransform(inputs=[prev], name='CDL_${safeName}')`);
          lines.push(`cdl['slope'].setValue([${c.slope[0]}, ${c.slope[1]}, ${c.slope[2]}])`);
          lines.push(`cdl['offset'].setValue([${c.offset[0]}, ${c.offset[1]}, ${c.offset[2]}])`);
          lines.push(`cdl['power'].setValue([${c.power[0]}, ${c.power[1]}, ${c.power[2]}])`);
          lines.push(`cdl['saturation'].setValue(${Number(c.sat)})`);
          lines.push(`try:\n  cdl['working_space'].setValue(${JSON.stringify(ws)})\nexcept: pass`);
          lines.push('prev = cdl');
        } else {
          lines.push(`note = nuke.nodes.NoOp(inputs=[prev], name='CDL_NOTE_${safeName}')`);
          lines.push("note['label'].setValue('CDL in AMF is applied=false (not applied). Set mps.vfx.applyAllAmfLooks=1 to force.')");
          lines.push('prev = note');
        }
      } else if (t === 'cube' && look.relPath) {
        const lutRel = '/' + normSlash(look.relPath);
        lines.push(`lut = nuke.nodes.OCIOFileTransform(inputs=[prev], name='LUT_${safeName}')`);
        lines.push(`lut['file'].setValue(basePath + ${JSON.stringify(lutRel)})`);
        lines.push('prev = lut');
      } else if (look.relPath) {
        lines.push(`# Look file (manual): ${normSlash(look.relPath)}`);
      }
    }

    lines.push('');
  }

  const tlName = safeFileStem(result?.edlTitle || result?.rootName || 'MPS_VFX_Mapping');
  downloadText(`${tlName}_Nuke_PerShot.py`, lines.join('\n'), 'text/plain');
}

// -----------------------------
// Export: Nuke NK
// -----------------------------
// Base path used inside exported .nk. If MPS_VFX_ROOT is an absolute path, use it.
// If it is a relative folder name (common with browser file pickers), resolve relative to script_directory().
const NK_BASE_EXPR = `[python {(lambda rv,sd: (rv if (rv and (rv.startswith('/') or (len(rv)>2 and rv[1]==':' and rv[2]=='/'))) else (sd if (rv and sd.rstrip('/').endswith('/'+rv)) else (((sd+'/'+rv).rstrip('/')) if rv else sd))))((('MPS_VFX_ROOT' in nuke.root().knobs()) and str(nuke.root()['MPS_VFX_ROOT'].value()).replace(chr(92),'/').strip().rstrip('/')) or '', nuke.script_directory().replace(chr(92),'/').rstrip('/'))}]`;

function getNukeExportPrefs(){
  // Defaults: Nuke 13+ compatible script. We prefer the studio OCIO config when available.
  const get = (k, d) => {
    try {
      const v = localStorage.getItem(k);
      if (v === null || v === undefined) return d;
      const s = String(v).trim();
      return s ? s : d;
    } catch { return d; }
  };

  const nukeVersion = get('mps.vfx.nukeVersion', get('mps.amf.nukeVersion', '13.2 v5'));
  const ocioConfigPath = get('mps.vfx.ocioConfigPath', get('mps.amf.ocioConfigPath', ''));
  const workingSpace = get('mps.vfx.ocioWorkingSpace', get('mps.amf.ocioWorkingSpace', 'scene_linear'));
  const readColorspace = get('mps.vfx.readColorspace', get('mps.amf.readColorspace', 'ACES2065-1'));
  // ODT preview (OCIOColorSpace) output colorspace for studio custom OCIO configs.
  // Default chosen by user: "ACES 1.0 Output - Rec709 100 nits".
  const odtOutColorspace = get(
    'mps.vfx.odtOutColorspace',
    get('mps.amf.odtOutColorspace', 'ACES 1.0 Output - Rec709 100 nits')
  );
  const applyAllAmf = String(get('mps.vfx.applyAllAmfLooks', get('mps.amf.applyAllAmfLooks', '0'))).trim() === '1';

  const perShotOnly = String(get('mps.vfx.nukePerShotOnly', get('mps.amf.nukePerShotOnly', '1'))).trim() !== '0';
  const addWriteNodes = String(get('mps.vfx.nukeAddWriteNodes', get('mps.amf.nukeAddWriteNodes', '1'))).trim() === '1';

  return { nukeVersion, ocioConfigPath, workingSpace, readColorspace, odtOutColorspace, applyAllAmf, perShotOnly, addWriteNodes };
}
function nkEscPath(p=""){
  try{ return normSlash(String(p||"")).replace(/"/g, '\\"'); }catch{ return ''; }
}

function nkHeader({ nukeVersion, fps, firstFrame, lastFrame, formatName, formatW, formatH, workingSpace, defaultVfxRoot='', defaultAmfRoot='' }){
  const vfxRoot = nkEscPath(defaultVfxRoot);
  const amfRoot = nkEscPath(defaultAmfRoot || defaultVfxRoot);
  // Minimal header for maximum compatibility (NukeX 16 + any OCIO config).
  // IMPORTANT: Do not force OCIO config / view / looks on load.
  return `# Nuke ${nukeVersion}
add_format "${formatW} ${formatH} 0 0 ${formatW} ${formatH} 1 ${formatName}"
Root {
 fps ${fps}
 first_frame ${firstFrame}
 last_frame ${lastFrame}
 lock_range true
 format "${formatName}"
 name Root1
 addUserKnob {20 PostFlowX l "PostFlowX"}
 addUserKnob {1 MPS_VFX_ROOT l "VFX Root (optional)"}
 MPS_VFX_ROOT "${vfxRoot}"
 addUserKnob {1 MPS_AMF_ROOT l "AMF Root (optional)"}
 MPS_AMF_ROOT "${amfRoot}"
}
`;
}

function nkPickSeqExpr(relCandidates, sampleFrame=1){
  const list = (Array.isArray(relCandidates) ? relCandidates : [relCandidates])
    .map(s => normSlash(s || ""))
    .filter(Boolean);

  const uniq = [];
  for (const p of list){
    if (!uniq.includes(p)) uniq.push(p);
  }

  if (!uniq.length) return `${NK_BASE_EXPR}`;

  // Fast path: single candidate => keep original NK_BASE_EXPR behavior.
  if (uniq.length === 1){
    return `${NK_BASE_EXPR}/${uniq[0]}`;
  }

    // Multiple candidates: PostFlowX scan already chose the preferred pattern; use first as deterministic fallback.
  return `${NK_BASE_EXPR}/${uniq[0]}`;
}

function nkReadNode(name, filePatternRel, first, last, xpos, ypos, readColorspace) {
  // Default: read EXR as AP0 (ACES2065-1). Allow override via Read node.
  const abs = nkPickSeqExpr(filePatternRel, first);
  const cs = String(readColorspace || 'ACES2065-1').replace(/"/g, "'");
  return [
    "Read {",
    " inputs 0",
    ` file "${abs}"`,
    ` first ${first}`,
    ` last ${last}`,
    ` origfirst ${first}`,
    ` origlast ${last}`,
    ` colorspace "${cs}"`,
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}


function nkWriteNode(name, outRel, first, last, xpos, ypos) {
  const fp = normSlash(outRel);
  const abs = `${NK_BASE_EXPR}/${fp}`;
  return [
    "Write {",
    " inputs 1",
    ` file "${abs}"`,
    " file_type exr",
    " channels rgba",
    " create_directories true",
    " use_limit true",
    ` first ${first}`,
    ` last ${last}`,
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function nkOCIOFileLUT(name, lookRel, xpos, ypos) {
  const p = normSlash(lookRel);
  const abs = `${NK_BASE_EXPR}/${p}`;
  return [
    "OCIOFileTransform {",
    " inputs 1",
    ` file "${abs}"`,
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function nkNormalizeOcioLookName(lookStr){
  const s = String(lookStr || '').trim();
  if (!s) return '';
  // Fix common naming mismatch: "Gamut Compress" vs "Gamut Compression".
  // Nuke/OCIO matches look names exactly.
  if (/Gamut\s+Compress(?!ion)/i.test(s)) {
    return s.replace(/Gamut\s+Compress(?!ion)/ig, 'Gamut Compression');
  }
  if (/\bCompress\b/i.test(s) && !/\bCompression\b/i.test(s)) {
    // As a last resort, replace a trailing "Compress" with "Compression".
    return s.replace(/Compress\b/ig, 'Compression');
  }
  return s;
}

function nkOCIOLookTransform(name, lookStr, inCS, outCS, xpos, ypos) {
  const lk = nkNormalizeOcioLookName(lookStr).replace(/"/g, "'");
  const a = String(inCS || '').replace(/"/g, "'");
  const b = String(outCS || '').replace(/"/g, "'");
  return [
    "OCIOLookTransform {",
    " inputs 1",
    ` look \"${lk}\"`,
    ` in_colorspace \"${a}\"`,
    ` out_colorspace \"${b}\"`,
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function nkOCIOColorSpace(name, inCS, outCS, xpos, ypos) {
  const a = String(inCS || '').replace(/"/g, "'");
  const b = String(outCS || '').replace(/"/g, "'");
  return [
    "OCIOColorSpace {",
    " inputs 1",
    ` in_colorspace "${a}"`,
    ` out_colorspace "${b}"`,
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function nkOCIODisplay(name, display, view, xpos, ypos) {
  const d = String(display || '').replace(/"/g, "'");
  const v = String(view || '').replace(/"/g, "'");
  return [
    "OCIODisplay {",
    " inputs 1",
    ` display "${d}"`,
    ` view "${v}"`,
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function guessOcioOutputFromOdt(odtDesc='', odtId='') {
  const s = `${odtDesc} ${odtId}`.toLowerCase();
  if (s.includes('rec709') || s.includes('rec.709')) return 'Output - Rec.709';
  if (s.includes('p3') && s.includes('d65')) return 'Output - P3-D65';
  if (s.includes('st2084') || s.includes('pq') || s.includes('hdr')) return 'Output - Rec.2100 PQ';
  if (s.includes('hlg')) return 'Output - Rec.2100 HLG';
  return 'Output - Rec.709';
}

function nkOCIOCDLTransformFromCDL(name, cdl, workingSpace, xpos, ypos) {
  const slope = (cdl?.slope || [1, 1, 1]).map(Number);
  const offset = (cdl?.offset || [0, 0, 0]).map(Number);
  const power = (cdl?.power || [1, 1, 1]).map(Number);
  const sat = Number(cdl?.sat ?? 1);

  return [
    "OCIOCDLTransform {",
    " inputs 1",
    ` slope {${slope[0]} ${slope[1]} ${slope[2]}}`,
    ` offset {${offset[0]} ${offset[1]} ${offset[2]}}`,
    ` power {${power[0]} ${power[1]} ${power[2]}}`,
    ` saturation ${sat}`,
    // Strip any embedded quotes from workingSpace so the Nuke .nk string stays valid.
    ` working_space "${String(workingSpace || 'ACEScct').replace(/"/g, '')}"`,
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function nkColorCorrectFromCDL(name, cdl, xpos, ypos) {
  const slope = (cdl?.slope || [1, 1, 1]).map(Number);
  const offset = (cdl?.offset || [0, 0, 0]).map(Number);
  const power = (cdl?.power || [1, 1, 1]).map(Number);
  const sat = Number(cdl?.sat ?? 1);

  return [
    "ColorCorrect {",
    " inputs 1",
    ` gain {${slope[0]} ${slope[1]} ${slope[2]}}`,
    ` offset {${offset[0]} ${offset[1]} ${offset[2]}}`,
    ` gamma {${power[0]} ${power[1]} ${power[2]}}`,
    ` saturation ${sat}`,
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function nkNoOpNote(name, label, xpos, ypos) {
  const safe = String(label || "").replace(/"/g, "'");
  return [
    "NoOp {",
    " inputs 1",
    ` name ${name}`,
    ` label "${safe}"`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

// 2D Transform + Crop helpers (for Per-shot export)
// - Parses TRANSFORM json like: {"scale":[1.02,1.02],"translate":[-10,5],"rotate":0.5}
// - Writes a Transform node + Crop-to-format node to keep bbox stable.
function __safeJsonParse(s){
  try{ return JSON.parse(String(s||'')); }catch{ return null; }
}

function __parseTransformFromText(transformText){
  const t = String(transformText||'').trim();
  if (!t) return null;

  // If multiple are joined ("a | b"), try the first segment.
  const first = t.split('|')[0].trim();

  // Try JSON
  const obj = __safeJsonParse(first);
  if (obj && typeof obj === 'object') return obj;

  return null;
}

function nkTransform2D(name, tf, xpos, ypos, fmtW=3840, fmtH=2160){
  const o = (tf && typeof tf === 'object') ? tf : {};
  const scale = Array.isArray(o.scale) ? o.scale : null;
  const translate = Array.isArray(o.translate) ? o.translate : (Array.isArray(o.translation) ? o.translation : (Array.isArray(o.position) ? o.position : null));
  const rotate = Number.isFinite(Number(o.rotate)) ? Number(o.rotate) : (Number.isFinite(Number(o.rotation)) ? Number(o.rotation) : null);
  const center = Array.isArray(o.center) ? o.center : [fmtW/2, fmtH/2];

  const sx = scale && Number.isFinite(Number(scale[0])) ? Number(scale[0]) : 1;
  const sy = scale && Number.isFinite(Number(scale[1])) ? Number(scale[1]) : sx;
  const tx = translate && Number.isFinite(Number(translate[0])) ? Number(translate[0]) : 0;
  const ty = translate && Number.isFinite(Number(translate[1])) ? Number(translate[1]) : 0;
  const cx = Number.isFinite(Number(center[0])) ? Number(center[0]) : (fmtW/2);
  const cy = Number.isFinite(Number(center[1])) ? Number(center[1]) : (fmtH/2);
  const rot = (rotate === null) ? 0 : rotate;

  return [
    "Transform {",
    " inputs 1",
    ` translate {${tx} ${ty}}`,
    ` scale {${sx} ${sy}}`,
    ` rotate ${rot}`,
    ` center {${cx} ${cy}}`,
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function nkCropToFormat(name, fmtW=3840, fmtH=2160, xpos=0, ypos=0){
  // Nuke format bbox is usually 0..(W-1), 0..(H-1)
  const r = Math.max(0, Math.round(fmtW) - 1);
  const t = Math.max(0, Math.round(fmtH) - 1);
  return [
    "Crop {",
    " inputs 1",
    ` box {0 0 ${r} ${t}}`,
    " crop true",
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function __pickPerShotEDLMeta(shot){
  const hits = Array.isArray(shot?.edl?.hits) ? shot.edl.hits : [];
  if (!hits.length) {
    return { hasAny:false, speedPct:100, speedMixed:false, speedIsDynamic:false, transformText:'', transformMixed:false, transformObj:null };
  }

  // SPEED
  const speeds = hits.map(h => Number(h?.speedPct)||100);
  const speedU = Array.from(new Set(speeds.map(v => Math.round(v*1000)/1000)));
  const speedMixed = speedU.length > 1;
  const speedPct = speedMixed ? 100 : speedU[0];
  const speedIsDynamic = hits.some(h => !!h?.speedIsDynamic);

  // TRANSFORM (take raw text; treat as mixed if distinct)
  const tfTexts = [];
  for (const h of hits){
    let txt = '';
    if (h?.transformVal) txt = String(h.transformVal||'').trim();
    if (!txt) {
      for (const c of (h?.comments||[])) {
        const m = String(c||'').match(/^\*\s*TRANSFORM\s*:\s*(.+?)\s*$/i);
        if (m) { txt = String(m[1]||'').trim(); break; }
      }
    }
    if (txt) tfTexts.push(txt);
  }
  const tfU = Array.from(new Set(tfTexts.map(s => s.trim()).filter(Boolean)));
  const transformMixed = tfU.length > 1;
  const transformText = tfU.length ? tfU[0] : '';
  const transformObj = (!transformMixed) ? __parseTransformFromText(transformText) : null;

  return { hasAny:true, speedPct, speedMixed, speedIsDynamic, transformText, transformMixed, transformObj };
}


// StickyNote helpers (ASCII-safe + HTML label) ------------------------------
function nkEscHtmlASCII(input){
  const str = String(input ?? "");
  let out = "";
  for (let i = 0; i < str.length; i++){
    const cp = str.codePointAt(i);
    if (cp > 0xFFFF) i++; // skip surrogate pair
    const ch = String.fromCodePoint(cp);
    if (ch === "&") out += "&amp;";
    else if (ch === "<") out += "&lt;";
    else if (ch === ">") out += "&gt;";
    else if (ch === '"') out += "&quot;";
    else if (ch === "'") out += "&#39;";
    else if (cp < 32 || cp > 126) out += `&#${cp};`; // keep label ASCII-safe
    else out += ch;
  }
  return out;
}
function nkLabelSafe(label){
  return String(label ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}
function nkStickyNote(name, htmlLabel, xpos, ypos){
  // Nuke StickyNote labels do NOT render HTML; convert <br/> to newlines and strip tags.
  const plain = String(htmlLabel || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?b>/gi, "")
    .replace(/<\/?[^>]+>/g, "")
    .replace(/\r/g, "");

  const lines = plain.split("\n").map(s => String(s).trim()).filter(Boolean);

  const cleaned = [];
  for (let i = 0; i < lines.length; i++){
    let l = lines[i];

    // shorten long paths in Look/Seq
    if (/^Look:\s*/i.test(l)){
      let p = l.replace(/^Look:\s*/i, "").trim().replace(/\\/g,'/');
      if (p.includes('/')) p = p.split('/').slice(-1)[0];
      l = "Look: " + p;
    }
    if (/^Seq:\s*/i.test(l)){
      let p = l.replace(/^Seq:\s*/i, "").trim().replace(/\\/g,'/');
      // keep last 2 segments to retain shot folder + pattern
      const parts = p.split('/').filter(Boolean);
      if (parts.length >= 2) p = parts.slice(-2).join('/');
      l = "Seq: " + p;
    }

    // clamp line length
    if (l.length > 96) l = l.slice(0, 96) + "…";
    cleaned.push(l);
    if (cleaned.length >= 10) break; // keep note compact
  }

  let label = cleaned.join("\n");
  if (label.length > 900) label = label.slice(0, 900) + "…";

  const safe = nkLabelSafe(label);
  return [
    "StickyNote {",
    " inputs 0",
    ` name ${name}`,
    ` label "${safe}"`,
    " note_font_size 12",
    ` xpos ${Math.round(xpos)}`,
    ` ypos ${Math.round(ypos)}`,
    "}"
  ].join("\n");
}

function nkConstantNode(name, xpos, ypos){
  return [
    "Constant {",
    " inputs 0",
    " channels rgba",
    " color {0 0 0 1}",
    ` name ${name}`,
    ` xpos ${Math.round(xpos)}`,
    ` ypos ${Math.round(ypos)}`,
    "}"
  ].join("\n");
}

function nkTimeOffset(name, offset, xpos, ypos) {
  return [
    "TimeOffset {",
    " inputs 1",
    ` time_offset ${offset}`,
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function nkTimeWarpLinear(name, first, last, speedPct, xpos, ypos) {
  const sp = Number(speedPct) || 100;
  const k = sp / 100.0;
  // Nuke TimeWarp "lookup" is an ANIMATED curve (x,y pairs).
  // In .nk it must be written with DOUBLE braces: {{curve x1 y1 x2 y2}}.
  // If written as {curve ...} Nuke parses it as a 1-row matrix (5 columns)
  // and throws: "cannot set lookup to 5 columns, 1 rows".
  const a = Math.round(Number(first));
  const b = Math.round(Number(last));
  const endIn = a + ((b - a) * k);

  // lookup maps output frames (x) to input frames (y)
  return [
    "TimeWarp {",
    " inputs 1",
    ` lookup {{curve ${a} ${a} ${b} ${endIn}}}`,
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function nkFrameRange(name, first, last, xpos, ypos) {
  return [
    "FrameRange {",
    " inputs 1",
    ` first_frame ${first}`,
    ` last_frame ${last}`,
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function nkAppendClip(name, xpos, ypos) {
  return [
    "AppendClip {",
    " inputs 2",
    ` name ${name}`,
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function nkViewer(xpos, ypos) {
  return [
    "Viewer {",
    " inputs 1",
    " name Viewer1",
    ` xpos ${xpos}`,
    ` ypos ${ypos}`,
    "}"
  ].join("\n");
}

function buildLookChainNK(shot, segName, x, y, inVar) {
  // returns { nodeTextLines:[], outVar:"SOMETHING" }
  const out = [];
  const s = shot || {};
  const prefs = getNukeExportPrefs();
  const ws = prefs.workingSpace || 'scene_linear';
  const applyAllAmf = !!prefs.applyAllAmf;

  const hasLook = !!(s.look && s.look.relPath);
  const t = String(s.look?.type || '').toLowerCase();

  // If we don't have a look file, just pass-through (no ODT preview)
  if (!hasLook) {
    return { nodeTextLines: out, outVar: (inVar || `READ_${segName}_N`) };
  }

  let curVar = inVar || `READ_${segName}_N`;

  // Start the chain from the provided var
  out.push(`push $${curVar}`);

  // 1) AMF named Looks (OCIOLookTransform) - applied looks only by default
  const amfLooks = Array.isArray(s.look?.amfLooks) ? s.look.amfLooks : null;
  const amfLooksAll = Array.isArray(s.look?.amfLooksAll) ? s.look.amfLooksAll : null;
  const looksToApply = (t === 'amf') ? ((amfLooks && amfLooks.length) ? amfLooks : (applyAllAmf ? amfLooksAll : null)) : null;

  if (looksToApply && looksToApply.length) {
    let lidx = 0;
    for (const lk of looksToApply) {
      lidx++;
      out.push(nkOCIOLookTransform(`LMT_${segName}_${pad(lidx,2)}`, lk, ws, ws, x, y));
      out.push(`set LMT_${segName}_${pad(lidx,2)}_N [stack 0]`);
      curVar = `LMT_${segName}_${pad(lidx,2)}_N`;
      out.push(`push $${curVar}`);
      y += 60;
    }
  }

  // 2) CDL (from AMF or .cdl/.cc)
  const hasCDL = !!(s.look && (t === 'amf' || t === 'cdl' || t === 'cc') && s.look.cdl);
  if (hasCDL) {
    const allowCdl = (t !== 'amf') ? true : (applyAllAmf || (s.look.amfCdlApplied === true));
    if (allowCdl) {
      const cws = s.look.cdlWorkingSpace || 'ACEScct';
      out.push(nkOCIOCDLTransformFromCDL(`CDL_${segName}`, s.look.cdl, cws, x, y));
      out.push(`set CDL_${segName}_N [stack 0]`);
      curVar = `CDL_${segName}_N`;
      out.push(`push $${curVar}`);
      y += 60;
    } else {
      out.push(nkNoOpNote(`CDL_NOTE_${segName}`, `CDL in AMF is applied=false (not applied).`, x, y));
      out.push(`set CDL_NOTE_${segName}_N [stack 0]`);
      curVar = `CDL_NOTE_${segName}_N`;
      out.push(`push $${curVar}`);
      y += 60;
    }
  }

  // 3) .cube LUT
  if (t === 'cube') {
    out.push(nkOCIOFileLUT(`LUT_${segName}`, s.look.relPath, x, y));
    out.push(`set LUT_${segName}_N [stack 0]`);
    curVar = `LUT_${segName}_N`;
    out.push(`push $${curVar}`);
    y += 60;
  }

  // 4) WorkingLocation marker
  const wl = String(s.look.amfWorkingLocation || ws || 'scene_linear');
  out.push(nkNoOpNote(`WORK_${segName}`, `WORKINGLOCATION: ${wl}`, x, y));
  out.push(`set WORK_${segName}_N [stack 0]`);
  curVar = `WORK_${segName}_N`;
  out.push(`push $${curVar}`);
  y += 60;

  // OutputTransform preview (ODT) is created later in the per-shot graph so that:
  // - It always exists (even if no look file)
  // - Viewer can be wired to the same consistent ODT node

  return { nodeTextLines: out, outVar: curVar };
}

export async function exportNukeNK(result) {
  await __yieldUiFrames(2);
  // IMPORTANT:
  // - UI may call export with getSelectedResult(), which returns shots: [] when user deselects all.
  // - Per spec, if none selected we fall back to exporting ALL shots (so .nk is never Root-only).
  const base = result || __lastResult || null;
  const fps = base?.fps || DEFAULT_FPS;

  const prefs = getNukeExportPrefs();

  const full = (__lastResult && Array.isArray(__lastResult.shots)) ? __lastResult : null;
  let shots = Array.isArray(base?.shots) ? base.shots : [];
  let __usedFallbackAllShots = false;
  if ((!shots || shots.length === 0) && full && Array.isArray(full.shots) && full.shots.length) {
    shots = full.shots;
    __usedFallbackAllShots = true;
  }

  const rootName = String(base?.rootName || full?.rootName || "VFX_ROOT");

  // Collect segments by EDL (master mode)
  const segs = [];
  for (const s of shots) {
    if (!s.seq?.patternRel) continue;
    const hits = (s.edl?.hits || []);
    for (const h of hits) {
      const a = tcToFrames(h.recIn, fps);
      const b = tcToFrames(h.recOut, fps);
      const dur = Math.max(1, b - a);
      segs.push({ shot: s, recInF: a, recOutF: b, durF: dur, speedPct: (Number(h.speedPct)||100) });
    }
  }
  segs.sort((x, y) => x.recInF - y.recInF);

  const hasMaster = (!prefs.perShotOnly) && segs.length > 0;

  // Determine Root range
  let rootFirst = 1;
  let rootLast = 1;

  if (hasMaster) {
    const baseRec = Math.min(...segs.map(s => s.recInF));
    const endRec = Math.max(...segs.map(s => s.recOutF));
    const totalFrames = Math.max(1, (endRec - baseRec));
    rootFirst = 1;
    rootLast = totalFrames;
  } else {
    // per-shot mode: match sequence frames -> fixes "only 1 frame"
    const starts = shots.filter(s => Number.isFinite(s.seq?.start)).map(s => s.seq.start);
    const ends = shots.filter(s => Number.isFinite(s.seq?.end)).map(s => s.seq.end);
    rootFirst = starts.length ? Math.min(...starts) : 1;
    rootLast = ends.length ? Math.max(...ends) : Math.max(rootFirst, 100);
  }

  const out = [];
  // IMPORTANT: nkHeader() expects an options object. If called with positional args,
  // the Root "format" line becomes invalid (undefined values) and Nuke will error.
  const __nukeDefaultRoot = trimSlashEnd(__getLS('mps.amf.nativeRoot') || __getLS('mps.vfx.nativeRoot') || __getLS('mps.vfx.nativeRootAbs') || rootName || '');

  out.push(nkHeader({
    nukeVersion: '13.2 v5',
    fps,
    firstFrame: rootFirst,
    lastFrame: rootLast,
    // UHD (Netflix SDR pipeline default for these pulls)
    formatName: 'UHD_3840x2160',
    formatW: 3840,
    formatH: 2160,
    // Keep as a hint only; actual value is applied safely onScriptLoad if available.
    workingSpace: 'scene_linear',
    defaultVfxRoot: __nukeDefaultRoot,
    defaultAmfRoot: __nukeDefaultRoot
  }));
  out.push("");

  // -------------------
  // MASTER (EDL) mode
  // -------------------
  if (hasMaster) {
    const baseRec = Math.min(...segs.map(s => s.recInF));
    let idx = 0;
    const segmentVars = [];

    let x = 200;
    const y0 = 80;

    for (const sg of segs) {
      idx++;
      const s = sg.shot;
      const safe = s.shotName.replace(/[^\w]+/g, "_");
      const segName = `${safe}_S${pad(idx, 3)}`;

      // Read (pattern)
      out.push(nkReadNode(`READ_${segName}`, s.seq.patternRel, s.seq.start, s.seq.end, x, y0, prefs.readColorspace));
      out.push(`set READ_${segName}_N [stack 0]`);

      // Convert Read colorspace -> workingSpace (scene_linear by default)
      out.push(`push $READ_${segName}_N`);
      out.push(nkOCIOColorSpace(`CSIN_${segName}`, prefs.readColorspace, prefs.workingSpace, x, y0 + 60));
      out.push(`set CSIN_${segName}_N [stack 0]`);

      // Look chain + WORK + ODT preview
      const lookChain = buildLookChainNK(s, segName, x, y0 + 120, `CSIN_${segName}_N`);
      out.push(...lookChain.nodeTextLines);

      // push last node
      out.push(`push $${lookChain.outVar}`);

      // TimeOffset so that segment starts at its recIn relative to base
      const startOnTimeline = (sg.recInF - baseRec) + 1;
      const timeOffset = startOnTimeline - (s.seq.start || 1);
      out.push(nkTimeOffset(`TO_${segName}`, timeOffset, x, y0 + 190));
      out.push(`set TO_${segName}_N [stack 0]`);
      out.push(`push $TO_${segName}_N`);

      // Trim to duration
      const seqLen = Math.max(1, (s.seq.end - s.seq.start + 1));
      const dur = Math.min(seqLen, sg.durF);
      const trimFirst = startOnTimeline;
      const trimLast = startOnTimeline + dur - 1;

      // SPEED: retime on timeline (static/AVG) via TimeWarp
      if (sg.speedPct && Math.abs(sg.speedPct - 100) > 0.0001) {
        out.push(nkTimeWarpLinear(`TW_${segName}`, trimFirst, trimLast, sg.speedPct, x, y0 + 235));
        out.push(`set TW_${segName}_N [stack 0]`);
        out.push(`push $TW_${segName}_N`);
      }

      out.push(nkFrameRange(`TRIM_${segName}`, trimFirst, trimLast, x, y0 + 280));
      out.push(`set OUT_${segName} [stack 0]`);
      segmentVars.push(`OUT_${segName}`);

      out.push("");
      x += 160;

      if (idx % 8 === 0){
        __setExportStatus("work", "Exporting: Nuke Project (.nk)…", `Building timeline ${idx}/${segs.length}`);
        await __yieldUiFrames(1);
      }
    }

    // AppendClip chain
    if (segmentVars.length) {
      out.push(`push $${segmentVars[0]}`);
      out.push(`set APP_PREV [stack 0]`);

      for (let i = 1; i < segmentVars.length; i++) {
        const nm = segmentVars[i];
        out.push(`push $APP_PREV`);
        out.push(`push $${nm}`);
        out.push(nkAppendClip(`APPEND_${pad(i + 1, 3)}`, 300 + i * 160, 460));
        out.push(`set APP_PREV [stack 0]`);
      }

      out.push(`push $APP_PREV`);
      out.push(nkViewer(900, 560));
    }

    const tlName = safeFileStem(base?.edlTitle || base?.rootName || "MPS_VFX_Mapping");
    __setExportStatus("work", "Exporting: Nuke Project (.nk)…", `Saving ${tlName}_Nuke_Timeline.nk`);
    await __yieldUiFrames(1);
    await __saveTextToVfxRoot(`${tlName}_Nuke_Timeline.nk`, out.join("\n"), "text/plain");
    return;
  }

  // -------------------
  // PER-GROUP (Per-shot) mode
  // - Export 1 .nk per GROUP SHOT (stem like ABC_123_456)
  // - Matches prior "mode B" behavior: if only 1 group => <TITLE>_Nuke.nk; else => <TITLE>_Nuke_<GROUP>.nk
  // -------------------

  const __guessPatternRelCandidates = (shot) => {
    const out = [];
    const push = (p) => {
      const v = normSlash(p || "").trim();
      if (!v) return;
      if (!out.includes(v)) out.push(v);
    };

    // 1) Preferred: detected sequence pattern from scanned files
    push(shot?.seq?.patternRel);

    // 2) From first frame (derive padding)
    const ff = normSlash(shot?.seq?.firstFileRel || "");
    if (ff) {
      const bn = baseName(ff);
      const m = bn.match(/^(.*?)(\d+)\.(exr|dpx|tif|tiff)$/i);
      if (m) {
        const dir = dirName(ff);
        const prefix = m[1];
        const padding = m[2].length;
        const extn = String(m[3] || "exr").toLowerCase();
        push(`${dir}/${prefix}%0${padding}d.${extn}`);
      }
    }

    // 3) From seq metadata (dir/prefix)
    if (shot?.seq?.dir && shot?.seq?.prefix && shot?.seq?.padding && shot?.seq?.ext) {
      push(`${shot.seq.dir}/${shot.seq.prefix}%0${shot.seq.padding}d.${shot.seq.ext}`);
    }

    // 4) Layout fallbacks (Netflix-style default): EXR_Files/<SHOT>/<SHOT>.%04d.exr
    const shotStem = getShotStem(shot, 0);
    const shotLabelRaw = String(shot?.compName || shot?.locShotName || shot?.shotName || "").trim();
    const shotLabel = shotLabelRaw.replace(/\s+/g, "");

    const extn = String(shot?.seq?.ext || "exr").toLowerCase();
    const padN = Number.isFinite(shot?.seq?.padding) ? shot.seq.padding : 4;

    const names = [];
    if (shotLabel) names.push(shotLabel);
    if (shotStem && !names.includes(shotStem)) names.push(shotStem);

    for (const nm of names) {
      push(`EXR_Files/${nm}/${nm}.%0${padN}d.${extn}`);
      if (shotStem && shotStem !== nm) push(`EXR_Files/${shotStem}/${nm}.%0${padN}d.${extn}`);
      push(`${nm}/EXR_Files/${nm}/${nm}.%0${padN}d.${extn}`);
    }

    return out;
  };

  // Group shots by stem (group shot)
  const groups = new Map();
  let __idx = 0;
  for (const s of shots) {
    __idx++;
    const stem = getShotStem(s, __idx);
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push(s);
  }
  const groupKeys = Array.from(groups.keys()).sort();

  const tlName2 = safeFileStem(base?.edlTitle || base?.rootName || "MPS_VFX_Mapping");
  const fileBase = `${tlName2}_Nuke`;
  const saved = [];

  let __groupFileIndex = 0;
  for (const stem of groupKeys) {
    __groupFileIndex += 1;
    __setExportStatus("work", "Exporting: Nuke Project (.nk)…", `Preparing ${__groupFileIndex}/${groupKeys.length} · ${stem}`);
    await __yieldUiFrames(1);
    const gShots = groups.get(stem) || [];
    if (!gShots.length) continue;

    // Determine group frame range
    const starts = gShots.filter(s => Number.isFinite(s.seq?.start)).map(s => s.seq.start);
    const ends   = gShots.filter(s => Number.isFinite(s.seq?.end)).map(s => s.seq.end);
    const gFirst = starts.length ? Math.min(...starts) : rootFirst;
    const gLast  = ends.length ? Math.max(...ends) : rootLast;

    const out = [];
    out.push(nkHeader({
      nukeVersion: '13.2 v5',
      fps,
      firstFrame: gFirst,
      lastFrame: gLast,
      formatName: 'UHD_3840x2160',
      formatW: 3840,
      formatH: 2160,
      workingSpace: 'scene_linear',
      defaultVfxRoot: __nukeDefaultRoot,
      defaultAmfRoot: __nukeDefaultRoot
    }));
    out.push("");

    let firstOutputVar = "";
    let i = 0;

    for (const s of gShots) {
      i++;
      const shotStem = getShotStem(s, i);
      const shotLabel = (s.compName || s.locShotName || s.shotName || shotStem || `SHOT_${i}`);
      const safe = nukeSafeId(shotLabel, `SHOT_${i}`);
      const x = 220 + (i - 1) * 180;
      const y = 80;

      const patCands = __guessPatternRelCandidates(s);
      const pat = (patCands && patCands.length) ? patCands[0] : "";
      const first = Number.isFinite(s?.seq?.start) ? s.seq.start : gFirst;
      const last  = Number.isFinite(s?.seq?.end)   ? s.seq.end   : gLast;

      const psMeta = __pickPerShotEDLMeta(s);

      let outVar = "";
      if (pat) {
        const readRel = (s?.seq?.patternRel && String(s.seq.patternRel).trim()) ? String(s.seq.patternRel).trim() : patCands;
        out.push(nkReadNode(`READ_${safe}`, readRel, first, last, x, y, prefs.readColorspace));
        out.push(`set READ_${safe}_N [stack 0]`);

        out.push(`push $READ_${safe}_N`);
        out.push(nkOCIOColorSpace(`CSIN_${safe}`, prefs.readColorspace, prefs.workingSpace, x, y + 60));
        out.push(`set CSIN_${safe}_N [stack 0]`);
        outVar = `CSIN_${safe}_N`;

        if (s.look?.relPath) {
          const segName = safe;
          const lookChain = buildLookChainNK(s, segName, x, y + 120, outVar);
          out.push(...lookChain.nodeTextLines);
          outVar = lookChain.outVar;
        }

        if (psMeta.hasAny && !psMeta.speedMixed && psMeta.speedPct && Math.abs(psMeta.speedPct - 100) > 0.0001) {
          out.push(`push $${outVar}`);
          out.push(nkTimeWarpLinear(`TW_${safe}`, first, last, psMeta.speedPct, x, y + 190));
          out.push(`set TW_${safe}_N [stack 0]`);
          outVar = `TW_${safe}_N`;
        }

        if (psMeta.hasAny && !psMeta.transformMixed && psMeta.transformObj) {
          out.push(`push $${outVar}`);
          out.push(nkTransform2D(`XFORM_${safe}`, psMeta.transformObj, x, y + 235, 3840, 2160));
          out.push(`set XFORM_${safe}_N [stack 0]`);
          outVar = `XFORM_${safe}_N`;

          out.push(`push $${outVar}`);
          out.push(nkCropToFormat(`CROP_${safe}`, 3840, 2160, x, y + 280));
          out.push(`set CROP_${safe}_N [stack 0]`);
          outVar = `CROP_${safe}_N`;
        }
      } else {
        out.push(nkConstantNode(`PLATE_${safe}`, x, y));
        out.push(`set PLATE_${safe}_N [stack 0]`);
        outVar = `PLATE_${safe}_N`;
      }

      if (prefs.addWriteNodes && pat) {
        const outRel = `Renders/${safe}/${safe}.%04d.exr`;
        out.push(`push $${outVar}`);
        out.push(nkWriteNode(`WRITE_${safe}`, outRel, first, last, x, y + 330));
        out.push(`set WRITE_${safe}_N [stack 0]`);
      }

      if (!firstOutputVar) firstOutputVar = outVar;

      if (i % 8 === 0){
        __setExportStatus("work", "Exporting: Nuke Project (.nk)…", `Building ${stem} ${i}/${gShots.length}`);
        await __yieldUiFrames(1);
      }
    }

    if (firstOutputVar) {
      out.push(`push $${firstOutputVar}`);
      out.push(nkViewer(900, 360));
    }

    const fname = (groupKeys.length <= 1) ? `${fileBase}.nk` : `${fileBase}_${stem}.nk`;
    __setExportStatus("work", "Exporting: Nuke Project (.nk)…", `Saving ${__groupFileIndex}/${groupKeys.length} · ${fname}`);
    await __yieldUiFrames(1);
    await __saveTextToVfxRoot(fname, out.join("\n"), "text/plain");
    saved.push(fname);
  }

  return saved;
}


// -----------------------------
// VFX Shots List: PDF (Light) Export
// - Opens a print-friendly Light report (2-column) and triggers Print → Save as PDF.
// -----------------------------
function __fmtYYYYMMDD(d=new Date()){
  try{
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const da = String(d.getDate()).padStart(2,'0');
    return `${y}${m}${da}`;
  }catch{ return '';
  }
}

function __summarizeEDLMetaForPDF(hits){
  const list = Array.isArray(hits) ? hits : [];
  const fmtPct = (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return '100';
    return (Math.round(n*100)/100).toString();
  };
  const uniq = (arr) => {
    const out=[]; const seen=new Set();
    for (const v of arr||[]){
      const s = String(v??'').trim();
      if (!s) continue;
      if (seen.has(s)) continue;
      seen.add(s); out.push(s);
    }
    return out;
  };
  const trimMid = (s, max=80) => {
    const t = String(s||'');
    if (t.length<=max) return t;
    return t.slice(0, max-1) + '…';
  };
  const mixedText = (vals, maxShow=3, trimTo=80) => {
    const u = uniq(vals);
    if (!u.length) return { text:'—', mixed:false };
    if (u.length===1) return { text:trimMid(u[0], trimTo), mixed:false };
    const show = u.slice(0, Math.max(1, maxShow)).map(v => trimMid(v, trimTo));
    const more = u.length - show.length;
    const tail = more>0 ? ` | +${more}` : '';
    return { text:`Mixed (${u.length}): ${show.join(' | ')}${tail}`, mixed:true };
  };

  if (!list.length){
    return {
      speed: { text:'—', mixed:false },
      transform: { text:'—', mixed:false },
      extra: { text:'—', mixed:false }
    };
  }

  const speedVals=[];
  const xformVals=[];
  const extraVals=[];

  for (const b of list){
    const pct = (b && Number.isFinite(Number(b.speedPct))) ? Number(b.speedPct) : 100;
    const isDyn = !!b?.speedIsDynamic;
    speedVals.push(isDyn ? `DYNAMIC (AVG ${fmtPct(pct)}%)` : `${fmtPct(pct)}%`);

    if (b?.transformVal) xformVals.push(String(b.transformVal));
    else {
      for (const c of (b?.comments||[])){
        const m = String(c||'').match(/^\*\s*TRANSFORM\s*:\s*(.+?)\s*$/i);
        if (m) xformVals.push(String(m[1]||'').trim());
      }
    }

    if (b?.extraVal) extraVals.push(String(b.extraVal));
    else {
      for (const c of (b?.comments||[])){
        const m = String(c||'').match(/^\*\s*EXTRA\s*:\s*(.+?)\s*$/i);
        if (m) extraVals.push(String(m[1]||'').trim());
      }
    }
  }

  return {
    speed: mixedText(speedVals, 4, 64),
    transform: mixedText(xformVals, 2, 92),
    extra: mixedText(extraVals, 2, 92)
  };
}

async function __preloadThumbsForPDF(result, shots, opts={}){
  const r = result || __lastResult;
  if (!r) return;

  opts = opts || {};
  const arr = Array.isArray(shots) ? shots : (Array.isArray(r.shots) ? r.shots : []);
  const rootKey = (r && (r.rootName || r.edlTitle)) ? (r.rootName || r.edlTitle) : 'VFX_ROOT';
  const max = Number.isFinite(opts.max) ? Math.max(0, opts.max) : null; // null = unlimited
  const concurrency = Number.isFinite(opts.concurrency) ? Math.max(1, Math.min(6, opts.concurrency)) : 2;

  let list = arr.filter(s => !!s?.shotName);
  if (max !== null) list = list.slice(0, max);

  let idx = 0;
  const worker = async () => {
    while (idx < list.length){
      const s = list[idx++];
      const key = rootKey + '::' + String(s.shotName);
      if (__thumbCache.has(key)) continue;
      let dataUrl = null;
      try{
        dataUrl = await __resolveThumbDataURL(s, r);
      } catch { dataUrl = __makeThumbPlaceholderDataURL(s, r); }
      __thumbCache.set(key, dataUrl);
      await new Promise(res => setTimeout(res, 0));
    }
  };

  await Promise.all(new Array(concurrency).fill(0).map(worker));
}

async function __exportVFXShotsListPDFLightLayout2(result){
  const r = result || __lastResult;
  if (!r){
    try{ alert('No VFX folder scanned.'); }catch{}
    return;
  }

  const shots = Array.isArray(r.shots) ? r.shots : [];
  const project = String(r.rootName || r.edlTitle || 'PROJECT');
  const dateObj = new Date();
  const dateISO = (dateObj.toISOString ? dateObj.toISOString().slice(0,10) : '') || '';
  const ymd = __fmtYYYYMMDD(dateObj) || '';

  const total = shots.length;
  const ready = shots.filter(s => !!s?.flags?.ready).length;
  const missing = total - ready;

  // Best-effort preload thumbnails (unlimited; but concurrency-limited)
  try{ await __preloadThumbsForPDF(r, shots, { concurrency: 2 }); }catch{}

  const rootKey = (r && (r.rootName || r.edlTitle)) ? (r.rootName || r.edlTitle) : 'VFX_ROOT';
  const titleStem = safeFileStem(project, 'PROJECT');
  const isShotMarker = String(r?.source || '') === 'shot_marker';
  const docTitle = isShotMarker
    ? `${titleStem}_SHOTMARKER_Report_${ymd || dateISO.replace(/-/g,'')}`
    : `${titleStem}_ED_VFX_ShotsList_${ymd || dateISO.replace(/-/g,'')}`;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'
  }[m]));

  const base = (p) => {
    const s = String(p || '');
    const i = s.lastIndexOf('/');
    return i>=0 ? s.slice(i+1) : s;
  };


  let css = '';
  const cards = [];

  const __srcOnly = (s) => {
    const t = String(s || '').trim();
    if (!t) return '—';
    const m = t.match(/(\d{2}[:;]\d{2}[:;]\d{2}[:;]\d{2})/);
    const tc = m ? m[1] : t;
    return tc.split('/')[0].trim();
  };
  const __clipOnly = (s) => {
    const t = String(s || '').trim();
    return t || '—';
  };

  const ocrOk = shots.filter(s => {
    const q = s?.qt || {};
    return String(q?.clipName || '').trim() && String(q?.srcTcFm || '').trim();
  }).length;

  if (isShotMarker){
    css = `
      :root { --muted:#6b7280; --border:#e5e7eb; --bg:#ffffff; --chip:#f3f4f6; }
      *{ box-sizing:border-box; }
      html,body{ margin:0; padding:0; background:var(--bg); color:#111827; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }
      @page { size: A4 landscape; margin: 12mm; }
      header{ padding: 14px 16px 10px 16px; border-bottom:1px solid var(--border); }
      .h-top{ display:flex; align-items:flex-end; justify-content:space-between; gap:12px; }
      .title{ font-size:18px; font-weight:800; letter-spacing:.2px; }
      .meta{ font-size:12px; color:var(--muted); }
      .kpi{ display:flex; gap:10px; margin-top:10px; flex-wrap:wrap; }
      .kpi .box{ background:var(--chip); border:1px solid var(--border); border-radius:10px; padding:8px 10px; min-width:110px; }
      .kpi .k{ font-size:11px; color:var(--muted); }
      .kpi .v{ font-size:18px; font-weight:800; line-height:1.1; }
      .actions{ display:flex; gap:8px; }
      .btn{ border:1px solid var(--border); background:#fff; border-radius:10px; padding:7px 10px; font-size:12px; cursor:pointer; }
      .btn:hover{ background:#f9fafb; }

      main{ padding: 12px 16px 16px 16px; }
      .grid{ display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      .card{ border:1px solid var(--border); border-radius:14px; overflow:hidden; break-inside:avoid; page-break-inside:avoid; }
      .thumb{ width:100%; background:#f3f4f6; border-bottom:1px solid var(--border); aspect-ratio: 16/9; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:11px; }
      .thumb img{ width:100%; height:100%; object-fit:cover; display:block; }
      .body{ padding:10px 11px 11px 11px; }
      .top{ display:flex; justify-content:space-between; gap:10px; align-items:baseline; }
      .shot{ font-weight:800; font-size:13px; letter-spacing:.2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .src{ font-size:12px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; white-space:nowrap; }
      .kv{ margin-top:8px; display:grid; grid-template-columns: 44px 1fr; gap:4px 8px; }
      .k{ color:var(--muted); font-size:10px; letter-spacing:.4px; }
      .v{ font-size:11px; }
      .ocf{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; word-break:break-word; }
      .task{ white-space:pre-wrap; word-break:break-word; line-height:1.25; }

      @media print {
        .actions{ display:none; }
        header{ position: static; }
        /* Keep colors and avoid unexpected image downgrades during printing */
        body{ -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      }
    `;

    for (const s of shots){
      const shotName = String(s?.shotName || '').trim();
      if (!shotName) continue;
      const q = s?.qt || {};
      const src = __srcOnly(q?.srcTcFm || '');
      const ocf = __clipOnly(q?.clipName || '');
      const task = String(s?.scopeOfWork || '').trim() || '—';
      const vendor = String(s?.vendor || '').trim() || '—';
      const metaSm = __pfxShotMarkerTemplateMeta(shotName);

      const key = rootKey + '::' + shotName;
      const thumb = __thumbCache.get(key);
      const thumbHtml = thumb ? `<img src="${thumb}" alt="thumb">` : `<div>No Still</div>`;

      cards.push(`
        <div class="card">
          <div class="thumb">${thumbHtml}</div>
          <div class="body">
            <div class="top">
              <div class="shot">${esc(shotName)}</div>
              <div class="src">${esc(metaSm.episode || src)}</div>
            </div>
            <div class="kv">
              <div class="k">SEQ</div><div class="v">${esc(metaSm.sequence || '—')}</div>
              <div class="k">VER</div><div class="v">${esc(metaSm.finalVersion || '—')}</div>
              <div class="k">VENDOR</div><div class="v">${esc(vendor)}</div>
              <div class="k">OCF</div><div class="v ocf">${esc(ocf)}</div>
              <div class="k">TASK</div><div class="v task">${esc(task)}</div>
            </div>
          </div>
        </div>
      `);
    }
  } else {
    css = `      :root { --muted:#6b7280; --border:#e5e7eb; --bg:#ffffff; --chip:#f3f4f6; }
      *{ box-sizing:border-box; }
      html,body{ margin:0; padding:0; background:var(--bg); color:#111827; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; }
      @page { margin: 12mm; }
      header{ padding: 14px 16px 10px 16px; border-bottom:1px solid var(--border); }
      .h-top{ display:flex; align-items:flex-end; justify-content:space-between; gap:12px; }
      .title{ font-size:18px; font-weight:700; letter-spacing: .2px; }
      .meta{ font-size:12px; color:var(--muted); }
      .kpi{ display:flex; gap:10px; margin-top:10px; flex-wrap:wrap; }
      .kpi .box{ background:var(--chip); border:1px solid var(--border); border-radius:10px; padding:8px 10px; min-width:110px; }
      .kpi .k{ font-size:11px; color:var(--muted); }
      .kpi .v{ font-size:18px; font-weight:700; line-height:1.1; }
      .actions{ display:flex; gap:8px; }
      .btn{ border:1px solid var(--border); background:#fff; border-radius:10px; padding:7px 10px; font-size:12px; cursor:pointer; }
      .btn:hover{ background:#f9fafb; }
    
      main{ padding: 12px 16px 16px 16px; }
      .grid{ display:grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .card{ border:1px solid var(--border); border-radius:14px; padding:10px; display:flex; gap:10px; break-inside:avoid; page-break-inside:avoid; }
      .thumb{ width:160px; height:90px; border-radius:10px; background: #f3f4f6; border:1px solid var(--border); overflow:hidden; flex:0 0 auto; display:flex; align-items:center; justify-content:center; color:var(--muted); font-size:11px; }
      .thumb img{ width:100%; height:100%; object-fit:cover; display:block; }
      .body{ flex:1 1 auto; min-width:0; }
      .row1{ display:flex; justify-content:space-between; gap:10px; align-items:flex-start; }
      .shot{ font-weight:800; font-size:14px; letter-spacing:.2px; }
      .badge{ font-size:11px; padding:3px 8px; border-radius:999px; border:1px solid var(--border); background: #f9fafb; color: #111827; white-space:nowrap; }
      .badge.ready{ background:#ecfdf3; border-color:#bbf7d0; color:#065f46; }
      .badge.miss{ background:#fef2f2; border-color:#fecaca; color:#7f1d1d; }
    
      .kv{ margin-top:6px; display:grid; grid-template-columns: 88px 1fr; gap:4px 8px; }
      .kv .k{ color:var(--muted); font-size:11px; }
      .kv .v{ font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    
      .task{ margin-top:8px; border-top:1px dashed var(--border); padding-top:7px; font-size:11px; }
      .task .k{ color:var(--muted); }
      .task .v{ white-space:pre-wrap; word-break:break-word; }
    
      .small{ font-size:10px; color:var(--muted); }
    
      @media print {
        .actions{ display:none; }
        header{ position: static; }
      }
    `;
    
    for (const s of shots){
      const shotName = String(s?.shotName || '');
      if (!shotName) continue;
    
      const hasSeq = !!s?.flags?.hasSeq;
      const hasEDL = !!s?.flags?.hasEDL;
      const hasLook = !!s?.flags?.hasLook;
      const isReady = !!s?.flags?.ready;
    
      const seqDisp = hasSeq ? base(normSlash(s?.seq?.patternRel || '')) : 'MISSING';
      const edlDisp = hasEDL ? base(normSlash(s?.edl?.relPath || '')) : 'MISSING';
    
      const customLookName = String(s?.look?.customName || '').trim();
      const lookDisp = hasLook ? (customLookName || base(normSlash(s?.look?.relPath || ''))) : 'MISSING';
    
      const loc = String(s?.locShotName || '').trim();
      const comp = String(s?.compName || '').trim();
    
      const camLens = __getCamLens(rootKey, shotName) || {};
      const cam = String(camLens.cam || '').trim() || '—';
      const lens = String(camLens.lens || '').trim() || '—';
      const focal = String(camLens.focal || '').trim() || '—';
      const tstop = String(camLens.tstop || '').trim() || '—';
      const focus = String(camLens.focus || '').trim() || '—';
    
      const task = String(__getScopeOfWork(rootKey, s) || '').trim() || '—';
    
      const edlMeta = __summarizeEDLMetaForPDF(s?.edl?.hits || []);
    
      const startF = Number(s?.seq?.start);
      const endF = Number(s?.seq?.end);
      const frames = (Number.isFinite(startF) && Number.isFinite(endF) && endF >= startF) ? ((endF - startF) + 1) : null;
    
      const key = rootKey + '::' + shotName;
      const thumb = __thumbCache.get(key);
      const thumbHtml = thumb ? `<img src="${thumb}" alt="thumb">` : `<div>No Still</div>`;
    
      cards.push(`
        <div class="card">
          <div class="thumb">${thumbHtml}</div>
          <div class="body">
            <div class="row1">
              <div>
                <div class="shot">${esc(shotName)} ${frames ? `<span class=\"small\">(${esc(frames)} fr)</span>` : ''}</div>
                <div class="small">${loc ? `Locator: ${esc(loc)}` : ''}${(loc && comp && comp!=loc) ? '  •  ' : ''}${(comp && comp!=loc) ? `Comp: ${esc(comp)}` : ''}</div>
              </div>
              <div class="badge ${isReady ? 'ready' : 'miss'}">${isReady ? 'READY' : 'MISSING'}</div>
            </div>
    
            <div class="kv">
              <div class="k">Seq</div><div class="v">${esc(seqDisp)}</div>
              <div class="k">EDL</div><div class="v">${esc(edlDisp)}</div>
              <div class="k">Look</div><div class="v">${esc(lookDisp)}</div>
    
              <div class="k">SPEED</div><div class="v">${esc(edlMeta.speed.text)}</div>
              <div class="k">TRANSFORM</div><div class="v">${esc(edlMeta.transform.text)}</div>
              <div class="k">Handles</div><div class="v">${esc(edlMeta.extra.text)}</div>
    
              <div class="k">Cam</div><div class="v">${esc(cam)}</div>
              <div class="k">Lens</div><div class="v">${esc(lens)}</div>
              <div class="k">Focal</div><div class="v">${esc(focal)}</div>
              <div class="k">T</div><div class="v">${esc(tstop)}</div>
              <div class="k">Focus</div><div class="v">${esc(focus)}</div>
            </div>
    
            <div class="task"><span class="k">Scope of Work:</span> <span class="v">${esc(task)}</span></div>
          </div>
        </div>
      `);
    }
    
  }

  const html = `<!doctype html>
  <html><head><meta charset="utf-8"><title>${esc(docTitle)}</title><style>${css}</style></head>
  <body>
    <header>
      <div class="h-top">
        <div>
          <div class="title">${isShotMarker ? "SHOT MARKER VFX Report" : "ED VFX Shots List"}</div>
          <div class="meta">Project: <b>${esc(project)}</b> &nbsp;•&nbsp; Date: <b>${esc(dateISO)}</b></div>
        </div>
        <div class="actions">
          <button class="btn" id="btnPrint">Print / Save as PDF</button>
        </div>
      </div>
      ${isShotMarker ? `
      <div class=\"kpi\">
        <div class=\"box\"><div class=\"k\">Shots</div><div class=\"v\">${esc(total)}</div></div>
        <div class=\"box\"><div class=\"k\">OCR OK</div><div class=\"v\">${esc(ocrOk)}</div></div>
      </div>` : `
      <div class=\"kpi\">
        <div class=\"box\"><div class=\"k\">Shots</div><div class=\"v\">${esc(total)}</div></div>
        <div class=\"box\"><div class=\"k\">Ready</div><div class=\"v\">${esc(ready)}</div></div>
        <div class=\"box\"><div class=\"k\">Missing</div><div class=\"v\">${esc(missing)}</div></div>
      </div>`}
    </header>
    <main>
      <div class="grid">${cards.join('')}</div>
    </main>
  </body></html>`;

  const w = window.open('', '_blank');
  if (!w){
    try{ alert('Popup blocked. Please allow popups for this extension, then try again.'); }catch{}
    return;
  }
  try{
    w.document.open();
    w.document.write(html);
    w.document.close();
    // CSP: avoid inline scripts/onclick in MV3.
    try{
      const btn = w.document.getElementById('btnPrint');
      if (btn) btn.addEventListener('click', ()=>{ try{ w.focus(); w.print(); }catch(e){} });
    }catch{}
    setTimeout(()=>{ try{ w.focus(); w.print(); }catch(e){} }, 350);
  } catch(e) {
    try{ w.document.body.innerText = 'Failed to render PDF report.'; }catch{}
  }
}

// -----------------------------
// Microsoft Excel (.xlsx) export (V5 template) — with embedded thumbnails
// - Uses bundled template: assets/templates/SERIES_TEMPLATE_VFX_STATUS_REPORTING_V5.xlsx
// - Fills the SHOTS sheet (sheet2.xml) rows starting at 2
// - Embeds thumbnails as drawing anchors in column A (drawing2.xml)
// -----------------------------

function __u8FromStr(s){ return new TextEncoder().encode(String(s ?? "")); }

// CRC32 (for ZIP "store" writer)
const __CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i=0;i<256;i++){
    let c = i;
    for (let k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();
function __crc32(u8){
  let c = 0xFFFFFFFF;
  for (let i=0;i<u8.length;i++){
    c = __CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function __zipStore(filesMap){
  // filesMap: { "path/in/zip": Uint8Array, ... }
  const names = Object.keys(filesMap || {});
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;

  const pushU16 = (arr, v) => { arr.push(v & 255, (v >>> 8) & 255); };
  const pushU32 = (arr, v) => { arr.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); };

  for (const name of names){
    const data = filesMap[name] || new Uint8Array();
    const nameBytes = enc.encode(name);
    const crc = __crc32(data);
    const size = data.length >>> 0;

    // Local file header
    const lh = [];
    pushU32(lh, 0x04034b50);
    pushU16(lh, 20);     // version needed
    pushU16(lh, 0);      // flags
    pushU16(lh, 0);      // compression = store
    pushU16(lh, 0);      // mod time
    pushU16(lh, 0);      // mod date
    pushU32(lh, crc);
    pushU32(lh, size);
    pushU32(lh, size);
    pushU16(lh, nameBytes.length);
    pushU16(lh, 0);      // extra len
    const lhU8 = new Uint8Array(lh);
    locals.push(lhU8, nameBytes, data);

    // Central directory header
    const ch = [];
    pushU32(ch, 0x02014b50);
    pushU16(ch, 20);     // version made by
    pushU16(ch, 20);     // version needed
    pushU16(ch, 0);      // flags
    pushU16(ch, 0);      // compression
    pushU16(ch, 0);      // mod time
    pushU16(ch, 0);      // mod date
    pushU32(ch, crc);
    pushU32(ch, size);
    pushU32(ch, size);
    pushU16(ch, nameBytes.length);
    pushU16(ch, 0);      // extra
    pushU16(ch, 0);      // comment
    pushU16(ch, 0);      // disk start
    pushU16(ch, 0);      // int attrs
    pushU32(ch, 0);      // ext attrs
    pushU32(ch, offset);
    const chU8 = new Uint8Array(ch);
    centrals.push(chU8, nameBytes);

    offset += (lhU8.length + nameBytes.length + size);
  }

  // End of central directory
  const cdSize = centrals.reduce((a,u8) => a + u8.length, 0) >>> 0;
  const cdOffset = offset >>> 0;
  const eocd = [];
  pushU32(eocd, 0x06054b50);
  pushU16(eocd, 0); // disk
  pushU16(eocd, 0); // disk start
  pushU16(eocd, names.length);
  pushU16(eocd, names.length);
  pushU32(eocd, cdSize);
  pushU32(eocd, cdOffset);
  pushU16(eocd, 0); // comment len
  const eocdU8 = new Uint8Array(eocd);

  const total = locals.reduce((a,u8)=>a+u8.length,0) + cdSize + eocdU8.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of locals){
    out.set(part, p); p += part.length;
  }
  for (const part of centrals){
    out.set(part, p); p += part.length;
  }
  out.set(eocdU8, p);
  return out;
}

function __dataUrlToBytes(dataUrl){
  const s = String(dataUrl || "");
  const i = s.indexOf(",");
  if (i < 0) return null;
  const b64 = s.slice(i+1);
  try{
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let j=0;j<bin.length;j++) u8[j] = bin.charCodeAt(j) & 255;
    return u8;
  }catch{
    return null;
  }
}

function __parseShotSeqEp(shotName=""){
  const s = String(shotName || "").trim();
  const parts = s.split(/[_\-\s]+/).filter(Boolean);
  // Typical: LMP_001_060 -> [LMP,001,060]
  const seq = parts[0] || "";
  const ep = parts.length > 1 ? parts[1] : "";
  return { seq, ep };
}

async function __getThumbDataURLForShot(rootKey, shot){
  const shotName = String(shot?.shotName || "").trim();
  if (!shotName) return null;
  const key = String(rootKey || "VFX_ROOT") + "::" + shotName;
  const cached = __thumbCache.get(key);
  if (cached !== undefined) return cached || null;
  const qt = shot?.qt || null;

// Allow captured thumbnails (e.g. SHOT MARKER) to pass dataUrl directly
if (qt?.dataUrl && typeof qt.dataUrl === "string"){
  const du = String(qt.dataUrl);
  if (du.startsWith("data:image/")){
    try{ __thumbCache.set(key, du); }catch{}
    return du;
  }
}

if (!qt?.file) { __thumbCache.set(key, null); return null; }
  let dataUrl = null;
  try{
    dataUrl = (qt.kind === "img") ? await imgFileToJpegDataURL(qt.file) : await videoFileToJpegDataURL(qt.file);
  }catch{ dataUrl = null; }
  try{ __thumbCache.set(key, dataUrl); }catch{}
  return dataUrl || null;
}


function __pfxShotMarkerTemplateMeta(shotName){
  const shot = String(shotName || "").trim();
  const parts = shot.split("_").filter(Boolean);
  const episodeOnly = (parts.length >= 2) ? String(parts[1]).trim() : "";
  const sequence = (parts.length >= 2) ? `${parts[0]}_${parts[1]}` : "";
  const episode = episodeOnly ? `EP_${episodeOnly}` : "";
  const m = shot.match(/v\d+/i);
  const finalVersion = m ? m[0] : "";
  return { shot, sequence, episode, episodeOnly, finalVersion };
}

async function __exportVFXStatusReportingXlsxV5(result, opts){
  const r = result || __lastResult;
  if (!r) return;

  const __returnBytes = !!(opts && opts.returnBytes);

  const rootKey = String(opts.rootKey || (r.rootName || r.edlTitle || "PROJECT"));
  const stem = safeFileStem(rootKey, "PROJECT");
  const date = (new Date()).toISOString().slice(0,10);
  const dateCompact = date.replace(/-/g, "");

  // Prefer selected-only if user has selection, otherwise export all (unless ignoreSelection)
  let useR = r;
  if (!opts.ignoreSelection){
    let rSel = null;
    try{ rSel = getSelectedResult(); }catch{ rSel = null; }
    if (rSel && Array.isArray(rSel.shots) && rSel.shots.length) useR = rSel;
  }

  const shotsAll = Array.isArray(useR.shots) ? useR.shots : [];
  if (!shotsAll.length){
    try{ __toast("No shots to export."); }catch{}
    return;
  }

  // Load template bytes from extension package
  const tplUrl = (typeof chrome !== "undefined" && chrome?.runtime?.getURL)
    ? chrome.runtime.getURL("assets/templates/SERIES_TEMPLATE_VFX_STATUS_REPORTING_V5.xlsx")
    : "assets/templates/SERIES_TEMPLATE_VFX_STATUS_REPORTING_V5.xlsx";

  let tplU8 = null;
  try{
    const resp = await fetch(tplUrl);
    if (!resp.ok) throw new Error("Template not found");
    tplU8 = new Uint8Array(await resp.arrayBuffer());
  }catch(e){
    console.warn("Template load failed:", e);
    try{ alert("Template file missing: SERIES_TEMPLATE_VFX_STATUS_REPORTING_V5.xlsx"); }catch{}
    return;
  }

  // Unzip template
  let files = null;
  try{ files = await unzip(tplU8); }catch(e){
    console.warn("Template unzip failed:", e);
    try{ alert("Failed to read .xlsx template (ZIP error)."); }catch{}
    return;
  }

  // ---- Fill SHOTS sheet (sheet2.xml) ----
  const sheetPath = "xl/worksheets/sheet2.xml";
  const sheetBytes = files[sheetPath];
  if (!sheetBytes){
    try{ alert("Template error: SHOTS sheet not found (sheet2.xml)."); }catch{}
    return;
  }

  const sheetXmlStr = strFromU8 ? strFromU8(sheetBytes) : (new TextDecoder().decode(sheetBytes));
  const doc = new DOMParser().parseFromString(sheetXmlStr, "application/xml");
  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const sheetData = doc.getElementsByTagNameNS(NS, "sheetData")[0];
  if (!sheetData){
    try{ alert("Template error: sheetData missing."); }catch{}
    return;
  }

  // Build row map (rows already exist in template up to ~985)
  const rowEls = Array.from(sheetData.getElementsByTagNameNS(NS, "row"));
  const rowMap = new Map();
  for (const row of rowEls){
    const rr = row.getAttribute("r");
    if (rr) rowMap.set(String(rr), row);
  }

  const setCellText = (cellEl, text) => {
    // Preserve style (s attr) but replace value with inline string
    try{
      while (cellEl.firstChild) cellEl.removeChild(cellEl.firstChild);
    }catch{}
    const t = String(text ?? "").trimEnd();
    if (!t){
      try{ cellEl.removeAttribute("t"); }catch{}
      return;
    }
    try{ cellEl.setAttribute("t", "inlineStr"); }catch{}
    const isEl = doc.createElementNS(NS, "is");
    const tEl = doc.createElementNS(NS, "t");
    // Preserve leading spaces if any
    try{ tEl.setAttributeNS("http://www.w3.org/XML/1998/namespace", "xml:space", "preserve"); }catch{}
    tEl.textContent = t;
    isEl.appendChild(tEl);
    cellEl.appendChild(isEl);
  };

  const getCellInRow = (rowEl, colLetter) => {
    const rr = rowEl?.getAttribute?.("r") || "";
    const ref = String(colLetter || "") + String(rr || "");
    const cells = Array.from(rowEl.getElementsByTagNameNS(NS, "c"));
    for (const c of cells){
      if (c.getAttribute("r") === ref) return c;
    }
    return null;
  };

  // Build images list (and set row height for those rows)
  const images = []; // { relId, filename, bytes, rowIndex }
  let imgCount = 0;

  const reportDateStr = date; // keep YYYY-MM-DD as text
  const maxRows = 985; // template limit
  let outRow = 2;
  const isShotMarkerSource = String(useR?.source || r?.source || "").trim() === "shot_marker";

  for (const s of shotsAll){
    if (outRow > maxRows) break;
    const rowEl = rowMap.get(String(outRow));
    if (!rowEl) break;

    // Set row height for better thumbnail visibility
    try{
      rowEl.setAttribute("ht", "60");
      rowEl.setAttribute("customHeight", "1");
    }catch{}

    const shotName = String(s?.shotName || "").trim();
    const metaSm = __pfxShotMarkerTemplateMeta(shotName);
    const { sequence: seq, episode: ep, episodeOnly: epOnly, finalVersion } = metaSm;

    const colB = getCellInRow(rowEl, "B");
    const colC = getCellInRow(rowEl, "C");
    const colD = getCellInRow(rowEl, "D");
    const colE = getCellInRow(rowEl, "E");
    const colF = getCellInRow(rowEl, "F");
    const colG = getCellInRow(rowEl, "G");
    const colH = getCellInRow(rowEl, "H");
    const colI = getCellInRow(rowEl, "I");
    const colJ = getCellInRow(rowEl, "J");
    const colK = getCellInRow(rowEl, "K");
    const colL = getCellInRow(rowEl, "L");
    const colM = getCellInRow(rowEl, "M");
    const colN = getCellInRow(rowEl, "N");
    const colO = getCellInRow(rowEl, "O");
    const colP = getCellInRow(rowEl, "P");
    const colQ = getCellInRow(rowEl, "Q");

    if (isShotMarkerSource){
      // Shot Marker exports only the requested red-header fields:
      // A Thumbnail (image), C Episode, D Shot Name.
      if (colB) setCellText(colB, "");
      if (colC) setCellText(colC, epOnly || "");
      if (colD) setCellText(colD, shotName);
      if (colE) setCellText(colE, "");
      if (colF) setCellText(colF, "");
      if (colG) setCellText(colG, "");
      if (colH) setCellText(colH, "");
      if (colI) setCellText(colI, "");
      if (colJ) setCellText(colJ, "");
      if (colK) setCellText(colK, "");
      if (colL) setCellText(colL, "");
      if (colM) setCellText(colM, "");
      if (colN) setCellText(colN, "");
      if (colO) setCellText(colO, "");
      if (colP) setCellText(colP, "");
      if (colQ) setCellText(colQ, "");
    } else {
      const edlHits = Array.isArray(s?.edl?.hits) ? s.edl.hits : [];
      const meta = __summarizeEDLMetaForPDF(edlHits);
      const task = String(s?.scopeOfWork || "").trim() || __getScopeOfWork(rootKey, s) || "";
      const vendor = String(s?.vendor || "").trim();
      const cam = __getCamLens(rootKey, shotName) || {};

      if (colB) setCellText(colB, seq);
      if (colC) setCellText(colC, ep);
      if (colD) setCellText(colD, shotName);
      if (colE) setCellText(colE, s?.flags?.ready ? "READY" : "MISSING");
      if (colF) setCellText(colF, "");
      if (colG) setCellText(colG, "");
      if (colH) setCellText(colH, task);
      if (colI) setCellText(colI, vendor);
      if (colM) setCellText(colM, finalVersion);
      if (colP) setCellText(colP, reportDateStr);

      const noteParts = [];
      if (meta?.speed?.text) noteParts.push(`SPEED: ${meta.speed.text}`);
      if (meta?.transform?.text) noteParts.push(`TRANSFORM: ${meta.transform.text}`);
      if (meta?.extra?.text) noteParts.push(`Handles: ${meta.extra.text}`);
      const camBits = [];
      if (cam?.cam) camBits.push(`Cam: ${cam.cam}`);
      if (cam?.lens) camBits.push(`Lens: ${cam.lens}`);
      if (cam?.focal) camBits.push(`Focal: ${cam.focal}`);
      if (cam?.tstop) camBits.push(`T: ${cam.tstop}`);
      if (cam?.focus) camBits.push(`Focus: ${cam.focus}`);
      if (camBits.length) noteParts.push(camBits.join(" | "));
      if (s?.qt?.relPath) noteParts.push(`QT: ${s.qt.relPath}`);
      if (colQ) setCellText(colQ, noteParts.join(" | "));
    }

    // Thumbnail (optional)
    const dataUrl = await __getThumbDataURLForShot(rootKey, s);
    const bytes = dataUrl ? __dataUrlToBytes(dataUrl) : null;
    if (bytes && bytes.length){
      imgCount += 1;
      const relId = "rId" + imgCount;
      const filename = `image${imgCount}.jpeg`;
      images.push({ relId, filename, bytes, rowIndex: outRow });
    }

    outRow += 1;
  }

  // Serialize updated sheet XML back into bytes
  const sheetOutStr = new XMLSerializer().serializeToString(doc);
  files[sheetPath] = __u8FromStr('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + sheetOutStr.replace(/^\s*<\?xml[^>]*>\s*/i,''));

  // ---- Add thumbnails as drawings (drawing2.xml) ----
  if (images.length){
    // Ensure content-types supports JPEG
    const ctPath = "[Content_Types].xml";
    const ctBytes = files[ctPath];
    if (ctBytes){
      let ctStr = strFromU8 ? strFromU8(ctBytes) : (new TextDecoder().decode(ctBytes));
      if (!/Extension="jpe?g"/i.test(ctStr)){
        ctStr = ctStr.replace(/<\/Types>\s*$/i, '<Default Extension="jpeg" ContentType="image/jpeg"/></Types>');
        files[ctPath] = __u8FromStr(ctStr);
      }
    }

    // Write image binaries
    for (const im of images){
      files[`xl/media/${im.filename}`] = im.bytes;
    }

    const pxToEmu = (px) => String(Math.round(Number(px||0) * 9525));
    const cx = pxToEmu(140);
    const cy = pxToEmu(78);

    // Build drawing2.xml
    const anchors = images.map((im, idx) => {
      const row0 = Math.max(0, Number(im.rowIndex) - 1); // zero-based
      const picId = idx + 1;
      const rel = im.relId;
      return `
<xdr:oneCellAnchor>
  <xdr:from>
    <xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff>
    <xdr:row>${row0}</xdr:row><xdr:rowOff>0</xdr:rowOff>
  </xdr:from>
  <xdr:ext cx="${cx}" cy="${cy}"/>
  <xdr:pic>
    <xdr:nvPicPr>
      <xdr:cNvPr id="${picId}" name="Thumbnail ${picId}"/>
      <xdr:cNvPicPr/>
    </xdr:nvPicPr>
    <xdr:blipFill>
      <a:blip r:embed="${rel}"/>
      <a:stretch><a:fillRect/></a:stretch>
    </xdr:blipFill>
    <xdr:spPr>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
    </xdr:spPr>
  </xdr:pic>
  <xdr:clientData/>
</xdr:oneCellAnchor>`;
    }).join("");

    const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors}\n</xdr:wsDr>`;
    files["xl/drawings/drawing2.xml"] = __u8FromStr(drawingXml);

    // Create drawing2 rels
    const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n${
      images.map((im) => `  <Relationship Id="${im.relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${im.filename}"/>`).join("\n")
    }\n</Relationships>`;
    files["xl/drawings/_rels/drawing2.xml.rels"] = __u8FromStr(relsXml);
  }

  // ---- Zip back into .xlsx (store) ----
  const outZip = __zipStore(files);
  if (__returnBytes) return outZip;
  downloadBytes(`${stem}_VFX_StatusReporting_V5_${dateCompact}.xlsx`, outZip, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  try{ __toast("Exported Excel (V5 Template)."); }catch{}
}

// -----------------------------
// AMF UI: init
// -----------------------------


function __exportVFXShotsListCSV(result, opts){
  const r = result || __lastResult;
  if (!r) return;

  opts = opts || {};
  const rootKey = String(opts.rootKey || (r.rootName || r.edlTitle || "PROJECT"));
  const __returnText = !!opts.returnText;

  if (String(r.source || "").trim() === "shot_marker"){
    const escCsv = (v) => {
      const s = String(v ?? "");
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
      return s;
    };
    // Shot Marker CSV intentionally mirrors only the requested red-header fields
    // from SERIES_TEMPLATE_VFX_STATUS_REPORTING_V5.xlsx.
    const headers = ["Thumbnail","Episode","Shot Name"];
    const rows = [headers.map(escCsv).join(",")];
    for (const s of (r.shots || [])){
      const meta = __pfxShotMarkerTemplateMeta(s.shotName || "");
      rows.push([
        "",
        meta.episodeOnly || "",
        meta.shot
      ].map(escCsv).join(","));
    }
    const csvText = rows.join("\n");
    if (__returnText) return csvText;
    downloadText("VFX_STATUS_REPORTING.csv", csvText, "text/csv");
    return;
  }

  const rows = [];
  const escCsv = (v) => {
    const s = String(v ?? "");
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
    return s;
  };

  rows.push([
    "Shot","Comp","Locator","Ready","Seq","EDL","Look",
    "SPEED","TRANSFORM","Handles",
    "Cam","Lens","Focal","T","Focus","Scope of Work","QT"
  ].map(escCsv).join(","));

  for (const s of (r.shots||[])){
    const sow = __getScopeOfWork(rootKey, s) || "";
    const meta = __getCamLens(rootKey, s.shotName) || {};
    const edlHits = Array.isArray(s?.edl?.hits) ? s.edl.hits : [];
    const m = __summarizeEDLMetaForPDF(edlHits);

    rows.push([
      s.shotName||"",
      s.compName||"",
      s.locShotName||"",
      s?.flags?.ready ? "READY" : "MISSING",
      (s?.seq?.patternRel ? baseName(s.seq.patternRel) : ""),
      (s?.edl?.relPath ? baseName(s.edl.relPath) : ""),
      (String(s?.look?.customName||"").trim() || (s?.look?.relPath ? baseName(s.look.relPath) : "")),
      m.speed.text || "",
      m.transform.text || "",
      m.extra.text || "",
      meta.cam||"",
      meta.lens||"",
      meta.focal||"",
      meta.tstop||"",
      meta.focus||"",
      sow,
      (s?.qt?.relPath||"")
    ].map(escCsv).join(","));
  }

  const csvText = rows.join("\n");
  if (__returnText) return csvText;
  const date = (new Date()).toISOString().slice(0,10).replace(/-/g,"");
  const stem = safeFileStem(rootKey, "PROJECT");
  downloadText(`${stem}_ED_VFX_ShotsList_${date}.csv`, csvText, "text/csv");
}
export async function exportShotsListXlsxV5(result, opts){
  return await __exportVFXStatusReportingXlsxV5(result, opts || {});
}

// Build-only helpers (for package export)
export async function buildShotsListXlsxV5Bytes(result, opts){
  return await __exportVFXStatusReportingXlsxV5(result, { ...(opts||{}), returnBytes: true });
}
export function buildShotsListCSVText(result, opts){
  return __exportVFXShotsListCSV(result, { ...(opts||{}), returnText: true });
}
export async function exportShotsListPDFLightLayout2(result){
  return await __exportVFXShotsListPDFLightLayout2(result);
}
export function exportShotsListCSV(result, opts){
  return __exportVFXShotsListCSV(result, opts || {});
}
/** Set the VFX root directory handle so exports write directly to the folder. */
export function setVfxDirHandle(h) { __vfxDirHandle = h || null; }

export function initAMFConverter() {
  const main = document.getElementById("main-amf");
  if (!main) return false;

  const folderInput = document.getElementById("amfFolderPicker");
  const btnChoose = document.getElementById("amfChooseFolder");
  const btnRescan = document.getElementById("amfRescan");
  const btnClear = document.getElementById("amfClear");
  const btnJson = document.getElementById("amfExportJson");
  const btnAE = document.getElementById("amfExportAE");
  const btnNukePy = document.getElementById("amfExportNuke");
  const btnNukeNk = document.getElementById("amfExportNukeNK");

  // VFX Shots List export menu
  const btnShotsMenu = document.getElementById("amfExportShotsCsv");
  const shotsMenu = document.getElementById("amfShotsExportMenu");
  const btnShotsPdf = document.getElementById("amfShotsExportPdf");
  const btnShotsSheets = document.getElementById("amfShotsExportSheets");
  const btnShotsCsv = document.getElementById("amfShotsExportCsv");

  const sumEl = document.getElementById("amfSummary");
  const tableHost = document.getElementById("amfTable");

  // If required DOM is missing, let ui.js fall back to legacy wiring.
  if (!folderInput || !btnChoose || !tableHost) return false;

  // NOTE: We restore + auto-rescan a persisted VFX Root handle AFTER doScan() is defined.

  let lastFiles = [];
  let lastResult = null;
  let __amfGroupOpen = new Map();
  // Always start VFX Mapping groups collapsed after any (re)scan.
  // Some table re-renders (or external sort wiring) can momentarily desync icons;
  // we enforce a one-shot collapse pass right after rendering.
  let __forceCollapseAfterRender = false;

  // Provide a callable clear hook for ui.js
  __clearUIFn = async () => {
    try { if (folderInput) folderInput.value = ""; } catch {}
    try {
      localStorage.removeItem("mps.amf.nativeRoot");
      localStorage.removeItem("mps.amf.nativeBase");
    } catch {}
    updateNativeRootRow("-");
    await doScan([]);
    return true;
  };

  function syncSelectionUI(result){
    const r = result || lastResult || __lastResult;
    const total = (r?.shots || []).filter(s => !!s?.flags?.hasSeq).length;
    const sel = __selectedShotSet ? __selectedShotSet.size : 0;

    const meta = document.getElementById("amfShotSelMeta");
    if (meta){
      meta.textContent = `Selected ${sel} / ${total}`;
    }

    const cbAll = document.getElementById("amfShotSelAll");
    if (cbAll){
      cbAll.checked = (total > 0 && sel === total);
      cbAll.indeterminate = (sel > 0 && sel < total);
    }
  }

  function applySelectionToRows(){
    if (!tableHost) return;
    const shotCbs = Array.from(tableHost.querySelectorAll("input.amf-shot-check"));
    for (const cb of shotCbs){
      const name = String(cb.dataset.shot || "");
      // Shots without Seq are not selectable (kept visible but faded)
      if (cb.disabled){
        cb.checked = false;
        try{ __selectedShotSet && __selectedShotSet.delete(name); }catch{}
        continue;
      }
      cb.checked = __selectedShotSet ? __selectedShotSet.has(name) : true;
    }

    // Group checkbox states (checked/indeterminate)
    const groupCbs = Array.from(tableHost.querySelectorAll("input.amf-group-check"));
    for (const gcb of groupCbs){
      const g = String(gcb.dataset.group || "");
      const kidsAll = Array.from(tableHost.querySelectorAll(`input.amf-shot-check[data-group="${g}"]`));
      const kids = kidsAll.filter(x => !x.disabled);
      const total = kids.length;
      const sel = kids.filter(x => x.checked).length;
      gcb.checked = (total > 0 && sel === total);
      gcb.indeterminate = (sel > 0 && sel < total);
      gcb.disabled = (total === 0);
    }

    // Some browsers ignore indeterminate on initial HTML; apply it explicitly
    for (const gcb of groupCbs){
      const ind = String(gcb.getAttribute('data-ind') || '') === '1';
      if (ind) gcb.indeterminate = true;
    }
  }

  // Ensure caret icons and child-row visibility always match data-open.
  // Collapsed => ▶ , Expanded => ▼ (Netflix-style list)
  // If forceCollapsed=true, we hard-collapse ALL groups (used right after scan).
  function normalizeGroupUI(forceCollapsed=false){
    if (!tableHost) return;

    const escAttr = (s) => String(s ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/\"/g, "\\\"");

    const groupRows = Array.from(tableHost.querySelectorAll('tr.amf-group-row'));
    for (const tr of groupRows){
      const g = String(tr.getAttribute('data-group') || '');
      let isOpen = String(tr.getAttribute('data-open') || '0') === '1';
      if (forceCollapsed) {
        isOpen = false;
        tr.setAttribute('data-open', '0');
        try{ __amfGroupOpen.set(g, false); }catch{}
      }

      const caretEl = tr.querySelector('.amf-group-caret');
      if (caretEl){
        caretEl.textContent = '';
        caretEl.classList.toggle('is-open', isOpen);
        caretEl.classList.toggle('is-closed', !isOpen);
      }

      const gQ = escAttr(g);
      const kids = Array.from(tableHost.querySelectorAll(`tr.amf-child-row[data-group="${gQ}"]`));
      for (const row of kids){
        row.style.display = isOpen ? '' : 'none';
      }
    }
  }

  function handleSelectionChange(e){
    const t = e?.target;
    if (!t || !lastResult) return;

    if (t.id === "amfShotSelAll"){
      if (t.checked){
        __selectedShotSet = new Set((lastResult.shots || []).filter(s => !!s?.flags?.hasSeq).map(s => s.shotName));
      } else {
        __selectedShotSet = new Set();
      }
      applySelectionToRows();
      syncSelectionUI(lastResult);
      return;
    }

    if (t.classList && t.classList.contains('amf-group-check')){
      const g = String(t.dataset.group || '');
      if (!__selectedShotSet) __selectedShotSet = new Set();
      const kids = Array.from(tableHost.querySelectorAll(`input.amf-shot-check[data-group="${g}"]`));
      for (const cb of kids){
        if (cb.disabled) continue;
        const name = String(cb.dataset.shot || '');
        cb.checked = !!t.checked;
        if (t.checked) __selectedShotSet.add(name);
        else __selectedShotSet.delete(name);
      }
      applySelectionToRows();
      syncSelectionUI(lastResult);
      return;
    }

    if (t.classList && t.classList.contains("amf-shot-check")){
      const name = String(t.dataset.shot || "");
      if (!__selectedShotSet) __selectedShotSet = new Set();

      if (t.checked) __selectedShotSet.add(name);
      else __selectedShotSet.delete(name);

      applySelectionToRows();
      syncSelectionUI(lastResult);
    }
  }

  if (tableHost && !tableHost.__mpsShotSelWired){
    tableHost.__mpsShotSelWired = true;
    tableHost.addEventListener("change", handleSelectionChange);
  }


  // Toggle group expand/collapse (caret)
  if (tableHost && !tableHost.__mpsGroupToggleWired){
    tableHost.__mpsGroupToggleWired = true;
    tableHost.addEventListener('click', (e) => {
      const tr = e?.target?.closest ? e.target.closest('tr.amf-group-row') : null;
      if (!tr) return;
      // Don't toggle when clicking checkboxes
      if (e.target && (e.target.tagName === 'INPUT')) return;

      const g = String(tr.getAttribute('data-group') || '');
      const isOpen = String(tr.getAttribute('data-open') || '0') === '1';
      const next = !isOpen;
      tr.setAttribute('data-open', next ? '1' : '0');

      const caretEl = tr.querySelector('.amf-group-caret');
      if (caretEl){
        caretEl.textContent = '';
        caretEl.classList.toggle('is-open', next);
        caretEl.classList.toggle('is-closed', !next);
      }

      const kids = Array.from(tableHost.querySelectorAll(`tr.amf-child-row[data-group="${g}"]`));
      for (const row of kids){
        row.style.display = next ? '' : 'none';
      }

      try{ __amfGroupOpen.set(g, next); }catch{}
      // Load thumbnails for newly expanded rows.
      // Use visibleOnly:false — newly-shown rows may not have layout yet so
      // getBoundingClientRect() can return zeros, causing the visibility filter
      // to exclude them. Loading all (limit:64) is safe and fast.
      if (next){
        setTimeout(() => {
          try{ queueThumbLoad(tableHost, lastResult || __lastResult, { visibleOnly: false, limit: 64 }); }catch{}
        }, 80);
      }
    });
  }


// Task textarea persistence (per rootName + shotName)
if (tableHost && !tableHost.__mpsTaskWired){
  tableHost.__mpsTaskWired = true;
  tableHost.addEventListener("input", (e) => {
    const t = e?.target;
    if (!t || !t.classList || !t.classList.contains("vfx-task-input")) return;
    const shot = String(t.getAttribute("data-shot") || "");
    if (!shot) return;
    const rn = (lastResult && (lastResult.rootName || lastResult.edlTitle)) ? (lastResult.rootName || lastResult.edlTitle) : (__lastResult?.rootName || __lastResult?.edlTitle || "VFX_ROOT");
    __setTask(rn, shot, t.value || "");
  });
}

// VFX Mapping per-shot controls: Upload Look + editable Cam/Lens fields
if (tableHost && !tableHost.__mpsVfxCardWired){
  tableHost.__mpsVfxCardWired = true;

  const getRootName = () => {
    const lr = lastResult || __lastResult;
    return (lr && (lr.rootName || lr.edlTitle)) ? (lr.rootName || lr.edlTitle) : "VFX_ROOT";
  };

  const fileToBase64 = (file) => new Promise((resolve) => {
    try{
      const fr = new FileReader();
      fr.onload = () => {
        try{
          const buf = fr.result;
          const bytes = new Uint8Array(buf);
          let binary = "";
          const chunk = 0x8000;
          for (let i=0; i<bytes.length; i+=chunk){
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i+chunk));
          }
          resolve(btoa(binary));
        } catch { resolve(null); }
      };
      fr.onerror = () => resolve(null);
      fr.readAsArrayBuffer(file);
    } catch {
      resolve(null);
    }
  });

  tableHost.addEventListener("click", async (e) => {
    const t = e?.target;
    if (!t) return;

    const thumb = t.closest?.(".vfx-thumb");
    if (thumb){
      const shot = String(thumb.getAttribute("data-shot") || "");
      if (!shot) return;
      try{
        const lr = lastResult || __lastResult;
        const shots = Array.isArray(lr?.shots) ? lr.shots : [];
        const s = shots.find(x => String(x?.shotName || "") === shot);
        const qt = s && s.qt ? s.qt : null;
        if (qt && qt.file){
          // Pass context so "Update Still" can update ONLY the initiating card thumbnail.
          __openQTFromFile(
            qt.file,
            qt.kind === "img" ? "img" : "vid",
            `${shot}`,
            { shotName: shot, qtFile: qt.file, rootName: (lr && (lr.rootName || lr.edlTitle)) ? (lr.rootName || lr.edlTitle) : 'VFX_ROOT', fps: (lr && lr.fps) ? lr.fps : 24, srcIn: (s && s.edl && s.edl.hits && s.edl.hits.length) ? s.edl.hits[0].srcIn : null, qtKey: (lr && (lr.rootName || lr.edlTitle) ? (lr.rootName || lr.edlTitle) : 'VFX_ROOT') + '::' + shot, thumbEl: thumb }
          );
        } else {
          __toast(`No QT Ref found for ${shot}. Put a .mov/.mp4 in QT_Files or root.`);
        }
      } catch {
        __toast("QT preview failed.");
      }
      return;
    }

    const uploadBtn = t.closest?.(".vfx-upload-btn");
    if (uploadBtn){
      const shot = String(uploadBtn.getAttribute("data-shot") || "");
      const row = uploadBtn.closest?.(".vfx-shotcard") || uploadBtn.parentElement;
      const inp = row ? row.querySelector(`.vfx-upload-input[data-shot="${CSS.escape(shot)}"]`) : null;
      if (inp) inp.click();
      return;
    }

    const pill = t.closest?.(".vfx-pill");
    if (pill){
      const shot = String(pill.getAttribute("data-shot") || "");
      const field = String(pill.getAttribute("data-field") || "");
      if (!shot || !field) return;
      const rn = getRootName();
      const cur = __getCamLens(rn, shot);
      const prev = cur[field] || "";
      const label = ({cam:"Cam",lens:"Lens",focal:"Focal (mm)",tstop:"T",focus:"Focus"})[field] || field;
      const next = prompt(`Edit ${label} for ${shot}`, prev);
      if (next === null) return;
      __setCamLensField(rn, shot, field, next);
      // Update this card immediately
      try{
        const card = pill.closest?.(".vfx-camlens-card") || pill.closest?.(".vfx-shotcard");
        const span = card ? card.querySelector(`.vfx-camlens-v[data-field="${CSS.escape(field)}"]`) : null;
        if (span) span.textContent = String(next || "—") || "—";
      } catch {}
      return;
    }
  });

  tableHost.addEventListener("change", async (e) => {
    const t = e?.target;
    if (!t || !t.classList || !t.classList.contains("vfx-upload-input")) return;
    const shot = String(t.getAttribute("data-shot") || "");
    const file = t.files && t.files[0] ? t.files[0] : null;
    if (!shot || !file) return;

    const rn = getRootName();

    // Update in-memory lastResult so exports (Mapping/Nuke/AE) can see the override
    try{
      const lr = lastResult || __lastResult;
      const shots = Array.isArray(lr?.shots) ? lr.shots : [];
      const s = shots.find(x => String(x?.shotName || "") === shot);
      if (s){
        if (!s.look) s.look = {};
        s.look.customName = file.name;
        if (!s.flags) s.flags = {};
        s.flags.hasLook = true;
      }
    } catch {}

    // Update UI line
    try{
      const card = t.closest?.(".vfx-info-card") || t.closest?.(".vfx-shotcard");
      const lookVal = card ? card.querySelector(".vfx-status-lines .vfx-line:nth-child(3) .val") : null;
      if (lookVal) lookVal.textContent = file.name;
      const lookDot = card ? card.querySelector(".vfx-status-lines .vfx-line:nth-child(3) .vfx-dot") : null;
      if (lookDot){ lookDot.classList.remove("miss"); lookDot.classList.add("ok"); }
    } catch {}

    // Best-effort: ask Native Host to write file into Look_Files/custom
    try{
      const b64 = await fileToBase64(file);
      if (b64){
        chrome.runtime?.sendMessage?.({
          type: "VFX_CUSTOM_LOOK_UPLOAD",
          rootName: rn,
          shotName: shot,
          fileName: file.name,
          dataBase64: b64,
          targetRel: "Look_Files/custom"
        });
      }
    } catch {}

    // reset input so selecting the same file again still triggers change
    try{ t.value = ""; } catch {}
  });
}

  function render(result) {
    if (!tableHost) return;

    const hintEl = document.getElementById("amfSummaryHint");
    const showKpis = !!result;

    // Toggle a CSS hook so the summary card can compact itself when KPI is shown
    try{
      const cardEl = document.getElementById("amfSummaryCard");
      if (cardEl) cardEl.classList.toggle("has-kpis", showKpis);
    } catch {}

    // Summary Card B: before choosing folder = show hint only
    if (sumEl) sumEl.style.display = showKpis ? "flex" : "none";
    if (hintEl) hintEl.style.display = showKpis ? "none" : "block";

    function setSummary(st, shotsArr){
      const s = st || { shots:0, ready:0, missing:0 };
      const shots = (typeof s.shots === "number") ? s.shots : (parseInt(s.shots || 0, 10) || 0);
      const ready = (typeof s.ready === "number") ? s.ready : (parseInt(s.ready || 0, 10) || 0);
      const miss  = (typeof s.missing === "number") ? s.missing : (parseInt(s.missing || 0, 10) || 0);

      // Ready coverage (smart KPI)
      const pct = shots > 0 ? Math.round((ready / shots) * 100) : 0;

      // Missing breakdown
      const arr = Array.isArray(shotsArr) ? shotsArr : [];
      const missShot = (typeof s.missingShot === "number") ? s.missingShot : arr.filter(x => !x?.flags?.hasSeq).length;
      const missLook = (typeof s.missingLook === "number") ? s.missingLook : arr.filter(x => !x?.flags?.hasLook).length;
      const missEDL  = (typeof s.missingEDL  === "number") ? s.missingEDL  : arr.filter(x => !x?.flags?.hasEDL).length;

      const kShots = document.getElementById("amfKpiShots");
      const kReady = document.getElementById("amfKpiReady");
      const kMiss  = document.getElementById("amfKpiMissing");
      const kBreak = document.getElementById("amfKpiMissingBreakdown");

      if (kShots && kReady && kMiss){
        kShots.textContent = String(shots);
        // Compact + informative: show ready as ratio (e.g. 13/15), keep percent in tooltip
        kReady.textContent = shots > 0 ? `${ready}/${shots}` : String(ready);
        try{ kReady.title = `Ready: ${ready} of ${shots} (${pct}%)`; } catch {}
        kMiss.textContent  = String(miss);
      }
      if (kBreak){
        // More readable breakdown (keep compact, but not cryptic)
        // Example: "Shot 1 • Look 1 • EDL 0"
        const parts = [
          `Shot ${missShot}`,
          `Look ${missLook}`,
          `EDL ${missEDL}`,
        ];
        kBreak.textContent = parts.join(" • ");
        kBreak.title = `Missing breakdown — Shot: ${missShot}  Look: ${missLook}  EDL: ${missEDL}`;
      }
    }

    if (!result) {
      setSummary({ shots:0, ready:0, missing:0, missingShot:0, missingLook:0, missingEDL:0 }, []);
      try{ if (typeof tableHost.__mpsThumbLazyDispose === "function") tableHost.__mpsThumbLazyDispose(); }catch{}
      try{ __thumbCache.clear(); }catch{}
      tableHost.innerHTML = `<div class="muted" style="padding:8px;opacity:.8">No folder selected.</div>`;
      __selectedShotSet = new Set();
      __selectedRootKey = "";
      __amfGroupOpen = new Map();
      __forceCollapseAfterRender = false;
      syncSelectionUI(null);
      return;
    }

    const st = result.stats || { shots: 0, ready: 0, missing: 0 };
    setSummary(st, result.shots || []);
    tableHost.innerHTML = buildMappingTableHTML(result, { selectedSet: __selectedShotSet, groupOpen: __amfGroupOpen });
    try{ tableHost.dataset.thumbRoot = __thumbRootKey(result, tableHost); }catch{}
    try{ __wireThumbLazyLoading(tableHost, result); }catch{}
    // Ensure initial state is collapsed after scan/load, and always keep icons in sync.
    normalizeGroupUI(__forceCollapseAfterRender);
    __forceCollapseAfterRender = false;
    applySelectionToRows();
    syncSelectionUI(result);
  }

  function __afterHeavyPlateLinkWork(delay = 900){
    // Do NOT call __scheduleThumbRuntimeTrim here — it races with the reload below
    // and would clear background-image styles from elements still loading.
    try{
      if (__vfxDirHandle && Array.isArray(lastFiles) && lastFiles.length){
        lastFiles = [];
        __setLastScan([], lastResult || null);
      }
    }catch{}
    // Re-wire lazy loading and reload all visible thumbnails.
    const r = lastResult || __lastResult;
    if (tableHost && r){
      try{ __wireThumbLazyLoading(tableHost, r); }catch{}
      // Use visibleOnly:false so viewport-check timing can't exclude shots.
      // 300ms head-start before the full pass so visible shots render first.
      setTimeout(() => {
        try{ queueThumbLoad(tableHost, r, { visibleOnly: false, limit: 64 }); }catch{}
      }, 300);
    }
  }

  async function __prepareHeavyPlateLinkExport(delay = 0){
    // Pause background thumb decoding during export but keep the lazy-loader wired.
    // (Disposing it would remove scroll/resize listeners; we restore them in __afterHeavyPlateLinkWork.)
    try{ __thumbCache.clear(); }catch{}
    try{ __scheduleThumbRuntimeTrim(tableHost, lastResult || __lastResult, delay); }catch{}
    await __yieldUiFrames(2);
  }

  async function doScan(files) {
    try{ if (typeof tableHost.__mpsThumbLazyDispose === "function") tableHost.__mpsThumbLazyDispose(); }catch{}
    try{ __thumbCache.clear(); }catch{}
    lastFiles = files || [];
    if (!lastFiles.length) {
      lastResult = null;
      __setLastScan([], null);
      // Keep whatever user has set (or show -)
      autoSyncNativeRootFor("");
      __amfGroupOpen = new Map();
      __forceCollapseAfterRender = false;
      render(null);
      __setExportStatus('idle', 'Status: Ready', '—');
      return;
    }

    // OK Always update Native VFX Root (Auto) immediately on folder pick
    const pickedRoot = rootNameFromFiles(lastFiles);
    autoSyncNativeRootFor(pickedRoot);
    __setExportStatus('work', 'Importing VFX Folder…', `${pickedRoot || 'VFX_ROOT'} • ${lastFiles.length} files`);

    try{
      lastResult = await scanVFXFolder(lastFiles, {
        fps: DEFAULT_FPS,
        onProgress: (payload = {}) => {
          const main = String(payload.main || 'Importing VFX Folder…');
          const sub = String(payload.sub || `${pickedRoot || 'VFX_ROOT'} • ${lastFiles.length} files`);
          __setExportStatus(payload.state || 'work', main, sub);
        }
      });
    }catch(err){
      __setExportStatus('err', '❌ Import failed', __errText(err));
      throw err;
    }
    __resetSelectionFor(lastResult);
    __setLastScan(lastFiles, lastResult);

    // Always start collapsed on load/rescan
    __amfGroupOpen = new Map();
    __forceCollapseAfterRender = true;

    // Prefer scan result rootName if provided
    if (lastResult && lastResult.rootName) {
      autoSyncNativeRootFor(lastResult.rootName);
    }

    render(lastResult);
    const st = lastResult?.stats || { shots: 0, ready: 0, missing: 0 };
    __setExportStatus('ok', '✅ Imported VFX Folder', `${st.ready}/${st.shots} ready • Missing ${st.missing}`);
    __afterHeavyPlateLinkWork(1400);
  }

  // Auto-restore the last VFX folder after refresh/reopen.
  // This makes Plate Link "remember" the folder and repopulate the list without
  // requiring users to click Rescan or Choose Folder again.
  (async ()=>{
    try{
      // Only auto-restore when nothing is currently loaded.
      if (lastFiles && lastFiles.length) return;

      const h = await __restoreVfxDirectoryHandle();
      if (!h) return;
      __vfxDirHandle = h;

      // Surface in UI immediately.
      try{ updateNativeRootRow(String(h?.name || 'VFX_ROOT')); }catch{}

      __setExportStatus('work', 'Auto Rescan…', String(h?.name || 'VFX_ROOT'));
      const filesFromHandle = await __filesFromDirHandle(h, {
        onProgress: (payload = {}) => {
          __setExportStatus(payload.state || 'work', payload.main || 'Auto Rescan…', payload.sub || String(h?.name || 'VFX_ROOT'));
        }
      });
      if (filesFromHandle && filesFromHandle.length){
        await doScan(filesFromHandle);
        __setExportStatus('ok', '✅ Auto Rescan done', String(h?.name || 'VFX_ROOT'));
      } else {
        __setExportStatus('idle', '', '');
      }
    }catch(err){
      __setExportStatus('err', '⚠️ Auto Rescan failed', __errText(err));
    }
  })();

  if (folderInput) {
    folderInput.addEventListener("change", async (e) => {
      const fs = Array.from(e.target.files || []);
      await doScan(fs);
    });
  }

  if (btnChoose && folderInput) {
    btnChoose.addEventListener("click", async (ev) => {
      // NOTE: calling <input>.click() after an await loses user-activation in Chrome.
      // Use Shift/Alt/Cmd-click to force the legacy folder input picker.
      const forceLegacy = !!(ev && (ev.shiftKey || ev.altKey || ev.metaKey));
      const hasDirPicker = (typeof window !== "undefined" && typeof window.showDirectoryPicker === "function");

      if (forceLegacy || !hasDirPicker) {
        folderInput.value = "";
        folderInput.click();
        return;
      }

      const h = await __pickVfxDirectoryHandle();
      if (h) {
        // Scan files from directory handle and render
        __setExportStatus('work', 'Importing VFX Folder…', String(h?.name || 'VFX_ROOT'));
        const files = await __filesFromDirHandle(h, {
          onProgress: (payload = {}) => {
            __setExportStatus(payload.state || 'work', payload.main || 'Importing VFX Folder…', payload.sub || String(h?.name || 'VFX_ROOT'));
          }
        });
        await doScan(files);
        return;
      }

      // If user cancelled/blocked the directory picker, we can't open the legacy picker in the same click.
      __toast("Folder picker cancelled/blocked. Shift+Click 'Choose Folder' to use legacy picker.");
    });
  }

  if (btnRescan) {
    btnRescan.addEventListener("click", async () => {
      // Prefer scanning from a persisted directory handle (works after refresh)
      if ((!lastFiles || !lastFiles.length) && __vfxDirHandle){
        try{
          const files = await __filesFromDirHandle(__vfxDirHandle, {
            onProgress: (payload = {}) => {
              __setExportStatus(payload.state || 'work', payload.main || 'Rescanning VFX Folder…', payload.sub || String(__vfxDirHandle?.name || 'VFX_ROOT'));
            }
          });
          await doScan(files);
          return;
        }catch{}
      }
      if (!lastFiles.length) { render(null); return; }
      await doScan(lastFiles);
    });
  }

  if (btnClear) {
    btnClear.addEventListener("click", async (e) => {
      try { e.preventDefault(); } catch {}
      await clearVFXMapping();
      try{ await window.PFX_clearAllTabs?.(); }catch{}
    });
  }

  if (btnJson) {
    btnJson.addEventListener("click", () => {
      if (!lastResult) return;
      const selRes = getSelectedResult();
      if (!selRes || !selRes.shots || selRes.shots.length === 0){
        try { alert("No shots selected. Please tick at least one shot."); } catch {}
        syncSelectionUI(lastResult);
        return;
      }
      const edlTitle = (selRes && (selRes.edlTitle || selRes.title || selRes.projectName)) || "VFX_Mapping";
      const fname = `${edlTitle}.json`;
      __setExportStatus("work", "Exporting: Mapping (.json)…", fname);
      try{
        exportMappingJSON(selRes);
        __setExportStatus("ok", "✅ Exported: Mapping (.json)", fname);
        __afterHeavyPlateLinkWork(180);
      }catch(err){
        __setExportStatus("err", "❌ Export failed: Mapping (.json)", __errText(err));
        __afterHeavyPlateLinkWork(180);
        throw err;
      }
    });
  }

  if (btnAE) {
    btnAE.addEventListener("click", () => {
      if (!lastResult) return;
      const selRes = getSelectedResult();
      if (!selRes || !selRes.shots || selRes.shots.length === 0){
        try { alert("No shots selected. Please tick at least one shot."); } catch {}
        syncSelectionUI(lastResult);
        return;
      }
      const edlTitle = (selRes && (selRes.edlTitle || selRes.title || selRes.projectName)) || "VFX_Mapping";
      const fname = `${edlTitle}_AE.jsx`;
      __setExportStatus("work", "Exporting: AE Script (.jsx)…", fname);
      try{
        exportAEJSX(selRes);
        __setExportStatus("ok", "✅ Exported: AE Script (.jsx)", fname);
        __afterHeavyPlateLinkWork(180);
      }catch(err){
        __setExportStatus("err", "❌ Export failed: AE Script (.jsx)", __errText(err));
        __afterHeavyPlateLinkWork(180);
        throw err;
      }
    });
  }

  if (btnNukePy) {
    btnNukePy.addEventListener("click", async () => {
      if (!lastResult) return;
      const selRes = getSelectedResult();
      if (!selRes || !selRes.shots || selRes.shots.length === 0){
        try { alert("No shots selected. Please tick at least one shot."); } catch {}
        syncSelectionUI(lastResult);
        return;
      }
      const edlTitle = (selRes && (selRes.edlTitle || selRes.title || selRes.projectName)) || "VFX_Mapping";
      const fname = `${edlTitle}_Nuke.py`;
      __setExportStatus("work", "Exporting: Nuke Script (.py)…", fname);
      await __prepareHeavyPlateLinkExport(0);
      try{
        exportNukePY(selRes);
        __setExportStatus("ok", "✅ Exported: Nuke Script (.py)", fname);
        __afterHeavyPlateLinkWork(180);
      }catch(err){
        __setExportStatus("err", "❌ Export failed: Nuke Script (.py)", __errText(err));
        __afterHeavyPlateLinkWork(180);
        throw err;
      }
    });
  }

  if (btnNukeNk) {
    btnNukeNk.addEventListener("click", async () => {
      if (!lastResult) return;
      const selRes = getSelectedResult();
      if (!selRes || !selRes.shots || selRes.shots.length === 0){
        try { alert("No shots selected. Please tick at least one shot."); } catch {}
        syncSelectionUI(lastResult);
        return;
      }
      const edlTitle = (selRes && (selRes.edlTitle || selRes.title || selRes.projectName)) || "VFX_Mapping";
      const fname = `${edlTitle}_Nuke.nk`;
      __setExportStatus("work", "Exporting: Nuke Project (.nk)…", fname);
      await __prepareHeavyPlateLinkExport(0);
      try{
        const saved = await exportNukeNK(selRes);
        const n = Array.isArray(saved) ? saved.length : 1;
        const label = (Array.isArray(saved) && saved.length) ? (saved.length === 1 ? saved[0] : (saved[0] + ' … (+' + (saved.length-1) + ')')) : fname;
        __setExportStatus("ok", "✅ Exported: Nuke Project (.nk)" + (n>1 ? (" ("+n+" files)") : ""), label);
        __afterHeavyPlateLinkWork(180);
      }catch(err){
        __setExportStatus("err", "❌ Export failed: Nuke Project (.nk)", __errText(err));
        __afterHeavyPlateLinkWork(180);
        throw err;
      }
    });
  }



  // -----------------------------------------------------------------
  // VFX Shots List export menu (Dropdown)
  // -----------------------------------------------------------------
  function __closeShotsMenu(){
    if (shotsMenu) shotsMenu.style.display = "none";
    try{ btnShotsMenu && btnShotsMenu.setAttribute("aria-expanded","false"); }catch{}
  }
  function __toggleShotsMenu(){
    if (!shotsMenu || !btnShotsMenu) return;
    const isOpen = shotsMenu.style.display !== "none";
    shotsMenu.style.display = isOpen ? "none" : "block";
    try{ btnShotsMenu.setAttribute("aria-expanded", isOpen ? "false" : "true"); }catch{}
  }

  if (btnShotsMenu && shotsMenu && !btnShotsMenu.__mpsShotsMenuWired){
    btnShotsMenu.__mpsShotsMenuWired = true;
    btnShotsMenu.addEventListener("click", (e) => {
      try{ e.preventDefault(); e.stopPropagation(); }catch{}
      __toggleShotsMenu();
    });

    // close when clicking outside
    document.addEventListener("click", (e) => {
      if (!shotsMenu) return;
      const t = e?.target;
      if (t === btnShotsMenu) return;
      if (shotsMenu.contains(t)) return;
      __closeShotsMenu();
    });

    document.addEventListener("keydown", (e) => {
      if (e && e.key === "Escape") __closeShotsMenu();
    });
  }

  if (btnShotsPdf && !btnShotsPdf.__mpsShotsPdfWired){
    btnShotsPdf.__mpsShotsPdfWired = true;
    btnShotsPdf.addEventListener("click", async (e) => {
      try{ e.preventDefault(); e.stopPropagation(); }catch{}
      __closeShotsMenu();
      const rootKey = (lastResult && (lastResult.edlTitle || lastResult.projectName || lastResult.rootName)) || "PROJECT";
      const date = (new Date()).toISOString().slice(0,10).replace(/-/g,"");
      const stem = safeFileStem(rootKey, "PROJECT");
      const fname = `${stem}_ED_VFX_ShotsList_${date}.pdf`;
      __setExportStatus("work", "Exporting: Shots List (PDF)…", fname);
      try{
        await __exportVFXShotsListPDFLightLayout2(lastResult);
        __setExportStatus("ok", "✅ Exported: Shots List (PDF)", fname);
        __afterHeavyPlateLinkWork(180);
      }catch(err){
        __setExportStatus("err", "❌ Export failed: Shots List (PDF)", __errText(err));
        __afterHeavyPlateLinkWork(180);
        throw err;
      }
    });
  }

  if (btnShotsCsv && !btnShotsCsv.__mpsShotsCsvWired){
    btnShotsCsv.__mpsShotsCsvWired = true;
    btnShotsCsv.addEventListener("click", (e) => {
      try{ e.preventDefault(); e.stopPropagation(); }catch{}
      __closeShotsMenu();
      // simple CSV export (All shots)
      const r = lastResult || __lastResult;
      if (!r) return;
      const rows = [];
      const escCsv = (v) => {
        const s = String(v ?? "");
        if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
        return s;
      };
      rows.push([
        "Shot","Comp","Locator","Ready","Seq","EDL","Look",
        "SPEED","TRANSFORM","Handles",
        "Cam","Lens","Focal","T","Focus","Scope of Work","QT"
      ].map(escCsv).join(","));

      const rootKey = (r.rootName||r.edlTitle||"PROJECT");
      for (const s of (r.shots||[])){
        const task = __getScopeOfWork(rootKey, s) || "";
        const meta = __getCamLens(rootKey, s.shotName) || {};
        const edlHits = Array.isArray(s?.edl?.hits) ? s.edl.hits : [];
        const m = __summarizeEDLMetaForPDF(edlHits);
        rows.push([
          s.shotName||"",
          s.compName||"",
          s.locShotName||"",
          s?.flags?.ready ? "READY" : "MISSING",
          (s?.seq?.patternRel ? baseName(s.seq.patternRel) : ""),
          (s?.edl?.relPath ? baseName(s.edl.relPath) : ""),
          (String(s?.look?.customName||"").trim() || (s?.look?.relPath ? baseName(s.look.relPath) : "")),
          m.speed.text || "",
          m.transform.text || "",
          m.extra.text || "",
          meta.cam||"",
          meta.lens||"",
          meta.focal||"",
          meta.tstop||"",
          meta.focus||"",
          task,
          (s?.qt?.relPath||"")
        ].map(escCsv).join(","));
      }

      const date = (new Date()).toISOString().slice(0,10).replace(/-/g,"");
      const stem = safeFileStem(rootKey, "PROJECT");
      const fname = `${stem}_ED_VFX_ShotsList_${date}.csv`;
      __setExportStatus("work", "Exporting: CSV…", fname);
      try{
        downloadText(fname, rows.join("\n"), "text/csv");
        __setExportStatus("ok", "✅ Exported: CSV", fname);
        __afterHeavyPlateLinkWork(180);
      }catch(err){
        __setExportStatus("err", "❌ Export failed: CSV", __errText(err));
        __afterHeavyPlateLinkWork(180);
        throw err;
      }
    });
  }

  if (btnShotsSheets && !btnShotsSheets.__mpsShotsSheetsWired){
  btnShotsSheets.__mpsShotsSheetsWired = true;
  btnShotsSheets.addEventListener("click", async (e) => {
    try{ e.preventDefault(); e.stopPropagation(); }catch{}
    __closeShotsMenu();

    // Prefer selected-only if user selected shots; fallback to all.
    const rAll = lastResult || __lastResult;
    if (!rAll) return;
    let rSel = null;
    try { rSel = getSelectedResult(); } catch {}
    const useR = (rSel && Array.isArray(rSel.shots) && rSel.shots.length) ? rSel : rAll;

    const rootKey = (useR && (useR.edlTitle || useR.projectName || useR.rootName)) || "PROJECT";
    const date = (new Date()).toISOString().slice(0,10).replace(/-/g,"");
    const stem = safeFileStem(rootKey, "PROJECT");
    const fname = `${stem}_VFX_StatusReporting_V5_${date}.xlsx`;
    __setExportStatus("work", "Exporting: Excel (.xlsx)…", fname);
    try{
      await __exportVFXStatusReportingXlsxV5(useR);
      __setExportStatus("ok", "✅ Exported: Excel (.xlsx)", fname);
      __afterHeavyPlateLinkWork(180);
    }catch(err){
      __setExportStatus("err", "❌ Export failed: Excel (.xlsx)", __errText(err));
      __afterHeavyPlateLinkWork(180);
      throw err;
    }
  });
}

  // Initialize Native VFX Root row from storage
  updateNativeRootRow(__getLS("mps.amf.nativeRoot") || "-");

  // Shared Radial Menu (module): Plate Link
  // - Right-click inside Plate Link to open quick actions
  // - Shift+Right-click preserves native browser context menu
  try{
    if (!main.__pfxPlateRadialInstalled){
      main.__pfxPlateRadialInstalled = true;
      const target = document.getElementById('amfTableCard') || document.getElementById('amfTableWrap') || main;

      const plateRadial = createRadialMenu({
        ariaLabel: 'Plate Link quick tools',
        radius: 74,
        pad: 120,
        getHost: () => (document.fullscreenElement || document.webkitFullscreenElement || document.body),
        actions: [
          { id:'folder',  title:'Choose VFX Folder', icon: RadialIcons.folder,  isEnabled: ()=>!!btnChoose,  onSelect: async()=>{ try{ btnChoose?.click?.(); }catch{} } },
          { id:'rescan',  title:'Rescan',           icon: RadialIcons.refresh, isEnabled: ()=>!!btnRescan,  onSelect: async()=>{ try{ btnRescan?.click?.(); }catch{} } },
          { id:'clear',   title:'Clear',            icon: RadialIcons.clear,   isEnabled: ()=>!!btnClear,   onSelect: async()=>{ try{ btnClear?.click?.(); }catch{} } },
          { id:'json',    title:'Export Mapping (.json)', icon: RadialIcons.export, isEnabled: ()=>!!btnJson, onSelect: async()=>{ try{ btnJson?.click?.(); }catch{} } },
          { id:'nk',      title:'Export Nuke Project (.nk)', icon: RadialIcons.export, isEnabled: ()=>!!btnNukeNk, onSelect: async()=>{ try{ btnNukeNk?.click?.(); }catch{} } },
        ]
      });

      const onCtx = (e)=>{
        if (e.shiftKey) return;
        try{ if (e.cancelable) e.preventDefault(); }catch{}
        try{ e.stopPropagation(); }catch{}
        try{ plateRadial.openAt(e.clientX, e.clientY); }catch{}
      };

      try{ target.addEventListener('contextmenu', onCtx); }catch{}
    }
  }catch{}

  render(null);
  return true;
}
