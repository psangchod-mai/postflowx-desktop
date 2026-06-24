// Project Storage v4 (Per-Tab Shards)
// Goal: Save/Load a project folder:
// <PFX>/<ProjectName>/project.json (manifest)
// <PFX>/<ProjectName>/tabs/*.json (per-tab state)
// <PFX>/<ProjectName>/autosave/project.autosave.json (latest autosave)
// <PFX>/<ProjectName>/thumbs/... (thumbnails)
// <PFX>/<ProjectName>/media/handles.json (relink hints)
// <PFX>/<ProjectName>/logs/audit.json (optional)
//
// Preferred save location: user-selected folder via File System Access API.
// Fallback: Chrome downloads (best-effort; will create the same folder structure under Downloads).

import { safeWriteText, safeReadJSON } from './safeFile.js';

const DB_NAME = "mps_handles_v1";
const DB_STORE = "handles";
const KEY_PROJECT_DIR = "projectDir";
const KEY_MEDIA_ROOT_DIR = "mediaRootDir";

const PFX_ROOT_DIR = "PFX";
const PROJECT_MANIFEST = "project.json";
const DIR_TABS = "tabs";
const DIR_AUTOSAVE = "autosave";
const DIR_THUMBS = "thumbs";
const DIR_MEDIA = "media";
const DIR_LOGS = "logs";
const AUTOSAVE_FILE = "project.autosave.json";

const TAB_FILES = {
  pull_prep:    "pull_prep.json",
  cut_diff:     "cut_diff.json",
  markers:      "markers.json",
  plate_link:   "plate_link.json",
  imf:          "imf.json",
  review:       "review.json",
  trl_conf:     "trl_conf.json",
  aces_look:    "aces_look.json",
  render_queue: "render_queue.json",
  settings:     "settings.json",
  shots:        "shots.json",  // Marker Proxy QC — ShotWorkItems + OCF index
};

function isValidTabKey(tab){
  const t = String(tab || '').trim();
  return !!(t && Object.prototype.hasOwnProperty.call(TAB_FILES, t));
}

// Legacy (v1) constant kept to avoid breaking older helper code paths that may still be referenced.
// v4 does not use .mpsproj.json files.
const AUTOSAVE_SUFFIX = ".autosave";

export function sanitizeFilename(name){
  const s = String(name || "Project")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "Project";
}

function nowISO(){
  return new Date().toISOString();
}

function buildUnifiedProject(projectName){
  const pn = sanitizeFilename(projectName);

  // Enterprise Offline (best-effort metadata)
  const entMeta = (()=>{ try{ return window.__MPS_ENTERPRISE_OFFLINE_META || null; }catch{ return null; } })();
  const projectId = (()=>{
    try{ return String(window.__MPS_PROJECT_ID || entMeta?.projectId || '').trim(); }catch{ return ''; }
  })();
  const projectSalt = (()=>{
    try{ return String(window.__MPS_PROJECT_SALT || entMeta?.projectSalt || '').trim(); }catch{ return ''; }
  })();
  const auditHead = (()=>{ try{ return window.__MPS_ENTERPRISE_AUDIT_HEAD || entMeta?.auditHead || null; }catch{ return null; } })();
  const enterprise = (()=>{
    const enabled = (()=>{ try{ return !!window.__MPS_ENTERPRISE_OFFLINE_ENABLED; }catch{ return false; } })();
    if (!enabled && !projectId && !projectSalt && !auditHead) return null;
    return {
      enabled: !!enabled,
      projectId: projectId || '',
      projectSalt: projectSalt || '',
      auditHead: (auditHead && typeof auditHead === 'object') ? auditHead : null
    };
  })();
  const edlRaw = (() => {
    try{ return window.__MPS_EDL_RAW || null; }catch{ return null; }
  })();
  const cutDiff = (() => {
    try{ return window.__MPS_CD_SNAPSHOT || null; }catch{ return null; }
  })();
  const shotMarker = (() => {
    try{ return window.__MPS_SM_SNAPSHOT || null; }catch{ return null; }
  })();

  const amfState = (() => {
    try{ return window.__MPS_AMF_STATE || null; }catch{ return null; }
  })();
  const amfFile = (() => {
    try{ return window.__MPS_AMF_FILE_PARSED || null; }catch{ return null; }
  })();

  const auditLog = (() => {
    try{ return window.__MPS_AUDIT_LOG || null; }catch{ return null; }
  })();

  const ocio = (() => {
    try{
      const projectHash = String(window.__MPS_OCIO_PROJECT_HASH || '').trim();
      const currentHash = String(window.__MPS_OCIO_HASH || localStorage.getItem('mps.ocio.hash') || '').trim();
      const meta = (() => {
        try{ return window.__MPS_OCIO_FILE_META || null; }catch{ return null; }
      })();
      return {
        hash: projectHash || currentHash || '',
        meta: meta || null
      };
    }catch{ return { hash: '' }; }
  })();


  // Preserve createdAt across saves within the same session.
  let createdAt = nowISO();
  try{ if (window.__MPS_PROJECT_CREATED_AT) createdAt = String(window.__MPS_PROJECT_CREATED_AT); }catch{}
  try{ window.__MPS_PROJECT_CREATED_AT = createdAt; }catch{}

  return {
    meta: {
      schema: "mpsproj",
      schemaVersion: 1,
      projectName: pn,
      projectId: projectId || '',
      createdAt,
      updatedAt: nowISO()
    },
    enterprise,
    edl: edlRaw,
    cutDiff,
    shotMarker,
    amf: amfState,
    amfFile: amfFile,
    ocio,
    audit: auditLog
  };
}

// ---------------- Project Storage v4 (manifest + per-tab shards) ----------------
function buildManifest(projectName){
  const pn = sanitizeFilename(projectName);
  let createdAt = nowISO();
  try{ if (window.__PFX_PROJECT_CREATED_AT) createdAt = String(window.__PFX_PROJECT_CREATED_AT); }catch{}
  try{ window.__PFX_PROJECT_CREATED_AT = createdAt; }catch{}
  const projectType = (() => { try { return window.__PFX_PROJECT_TYPE || 'standalone'; } catch { return 'standalone'; } })();
  const seriesMeta  = (() => { try { return window.__PFX_SERIES_META  || null; } catch { return null; } })();
  return {
    schema: 'pfxproj',
    schemaVersion: 4,
    projectName: pn,
    projectType,
    seriesMeta,
    createdAt,
    updatedAt: nowISO(),
    tabs: {
      pull_prep:    `${DIR_TABS}/${TAB_FILES.pull_prep}`,
      cut_diff:     `${DIR_TABS}/${TAB_FILES.cut_diff}`,
      markers:      `${DIR_TABS}/${TAB_FILES.markers}`,
      plate_link:   `${DIR_TABS}/${TAB_FILES.plate_link}`,
      imf:          `${DIR_TABS}/${TAB_FILES.imf}`,
      review:       `${DIR_TABS}/${TAB_FILES.review}`,
      trl_conf:     `${DIR_TABS}/${TAB_FILES.trl_conf}`,
      aces_look:    `${DIR_TABS}/${TAB_FILES.aces_look}`,
      render_queue: `${DIR_TABS}/${TAB_FILES.render_queue}`,
      settings:     `${DIR_TABS}/${TAB_FILES.settings}`,
      shots:        `${DIR_TABS}/${TAB_FILES.shots}`,
    },
    autosave: { latest: `${DIR_AUTOSAVE}/${AUTOSAVE_FILE}` },
    thumbs: {
      markersDir: `${DIR_THUMBS}/markers/`,
      reviewDir: `${DIR_THUMBS}/review/`,
    },
    media: { handles: `${DIR_MEDIA}/handles.json` },
    logs: { audit: `${DIR_LOGS}/audit.json` },
  };
}

function wrapTabState(tabName, state){
  return {
    schema: 'pfxproj_tab',
    schemaVersion: 1,
    tab: String(tabName || ''),
    updatedAt: nowISO(),
    state: state ?? null,
  };
}

function extractPullPrepEdl(state){
  if (state?.events?.length) return state;
  if (state?.edl?.events?.length) return state.edl;
  return null;
}

function extractPullPrepMedia(state){
  return state?._pfxMedia || state?.media || null;
}

function applyPullPrepProjectState(state, { applyEdl=true } = {}){
  try{ if (typeof window.PFX_applyPullPrepState === 'function') window.PFX_applyPullPrepState(state); }catch{}
  const edl = extractPullPrepEdl(state);
  const media = extractPullPrepMedia(state);
  try{ window.__MPS_EDL_RAW = edl || null; }catch{}
  if (applyEdl && edl?.events?.length) {
    try{ if (typeof window.MPS_applyEdlRaw === 'function') window.MPS_applyEdlRaw(edl); }catch{}
  }
  try{ if (typeof window.MPS_restorePullPrepMedia === 'function') window.MPS_restorePullPrepMedia(media); }catch{}
  return edl;
}

async function _flushSWISnapshot() {
  try {
    if (typeof window.PFX_SWI?.exportState === 'function') {
      const [swiState, ocfState] = await Promise.all([
        window.PFX_SWI.exportState(),
        typeof window.PFX_OCF_INDEX?.exportState === 'function'
          ? window.PFX_OCF_INDEX.exportState() : Promise.resolve(null),
      ]);
      window.__PFX_SWI_SNAPSHOT = { ...(swiState || {}), ...(ocfState || {}) };
    }
  } catch { /* ignore — snapshot stays as last known */ }
}

function buildTabsSnapshot(projectName){
  const pullPrep = (() => {
    try{
      if (typeof window.PFX_exportPullPrepState === 'function') {
        return window.PFX_exportPullPrepState();
      }
      const raw = window.__MPS_EDL_RAW || null;
      const media = window.__PFX_PULLPREP_MEDIA || null;
      if (!raw && !media) return null;
      // Keep the EDL-raw shape at top level (events/fps/projectName) for backward
      // compat, and attach the proxy video descriptor as an extra key so media is
      // remembered even for markers-only projects with no EDL.
      const out = raw ? { ...raw } : {};
      if (media) out._pfxMedia = media;
      return out;
    }catch{ return null; }
  })();
  const cutDiff = (() => { try{ return window.__MPS_CD_SNAPSHOT || null; }catch{ return null; } })();
  const markers = (() => { try{ return window.__MPS_SM_SNAPSHOT || null; }catch{ return null; } })();
  const plateLink = (() => {
    try{
      return {
        amf: window.__MPS_AMF_STATE || null,
        amfFile: window.__MPS_AMF_FILE_PARSED || null,
        ocio: {
          hash: String(window.__MPS_OCIO_PROJECT_HASH || window.__MPS_OCIO_HASH || localStorage.getItem('mps.ocio.hash') || '').trim(),
          meta: window.__MPS_OCIO_FILE_META || null
        }
      };
    }catch{ return null; }
  })();
  const review = (() => {
    try{
      if (typeof window.PFX_exportReviewsState === 'function') return window.PFX_exportReviewsState();
      return window.__PFX_REVIEWS_STATE || null;
    }catch{ return null; }
  })();
  const imf = (() => {
    try{
      if (typeof window.PFX_exportIMFState === 'function') return window.PFX_exportIMFState();
      return window.__PFX_IMF_STATE || null;
    }catch{ return null; }
  })();
  const trlConf = (() => {
    try{
      if (typeof window.PFX_exportTrlConfState === 'function') return window.PFX_exportTrlConfState();
      return window.__PFX_TRL_CONF_STATE || null;
    }catch{ return null; }
  })();
  const settings = (() => {
    try{
      const out = {};
      for (let i=0;i<localStorage.length;i++){
        const k = localStorage.key(i);
        if (!k) continue;
        if (k.startsWith('pfx.') || k.startsWith('mps.')) out[k] = localStorage.getItem(k);
      }
      return { localStorage: out };
    }catch{ return { localStorage:{} }; }
  })();
  const acesLook = (() => {
    try{
      if (typeof window.PFX_exportAcesLookState === 'function') return window.PFX_exportAcesLookState();
      return window.__PFX_ACES_LOOK_STATE || null;
    }catch{ return null; }
  })();

  const shots = (() => {
    try { return window.__PFX_SWI_SNAPSHOT || null; } catch { return null; }
  })();

  return {
    pull_prep: wrapTabState('pull_prep', pullPrep),
    cut_diff: wrapTabState('cut_diff', cutDiff),
    markers: wrapTabState('markers', markers),
    plate_link: wrapTabState('plate_link', plateLink),
    imf: wrapTabState('imf', imf),
    review: wrapTabState('review', review),
    trl_conf: wrapTabState('trl_conf', trlConf),
    aces_look: wrapTabState('aces_look', acesLook),
    render_queue: wrapTabState('render_queue', null),
    settings: wrapTabState('settings', settings),
    shots: wrapTabState('shots', shots),
  };
}

async function readFileAsText(file){
  if (file.text) return await file.text();
  return await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => resolve(String(r.result || ""));
    r.readAsText(file);
  });
}

async function readHandleAsText(fileHandle){
  const file = await fileHandle.getFile();
  return await readFileAsText(file);
}

// ---------------- IndexedDB handle persistence ----------------
// Singleton connection — idbGet/idbSet are called frequently (autosave, project load,
// kvSet). Opening a fresh connection per call was leaking unclosed handles that
// accumulate until GC eventually reclaims them. One persistent connection is enough.
let _dbConn = null;
let _dbOpenPromise = null;
function openDB(){
  if (_dbConn) return Promise.resolve(_dbConn);
  if (_dbOpenPromise) return _dbOpenPromise;
  _dbOpenPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => { _dbConn = req.result; _dbOpenPromise = null; resolve(_dbConn); };
    req.onerror = () => { _dbOpenPromise = null; reject(req.error); };
  });
  return _dbOpenPromise;
}

async function idbGet(key){
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value){
  const db = await openDB();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const req = store.put(value, key);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error);
  });
}

// Expose raw IDB helpers as window globals for modules that can't import ES modules
// (e.g. ocfIndexStore.js uses window.pfxIdbGet/Set to persist FileSystemDirectoryHandles)
window.pfxIdbGet = idbGet;
window.pfxIdbSet = idbSet;

// ---------------- Generic small KV store (IndexedDB) ----------------
// Used for lightweight per-tab/session persistence without localStorage quota limits.
// Values must be structured-cloneable (plain objects/arrays/strings/numbers).
const KV_PREFIX = "pfx.kv.";

export async function kvSet(key, value){
  try{
    const k = KV_PREFIX + String(key || '').trim();
    if (!k || k.endsWith('.')) return false;
    await idbSet(k, value);
    return true;
  }catch{ return false; }
}

export async function kvGet(key){
  try{
    const k = KV_PREFIX + String(key || '').trim();
    if (!k || k.endsWith('.')) return null;
    const v = await idbGet(k);
    return (v === undefined) ? null : v;
  }catch{ return null; }
}

export async function kvDel(key){
  try{
    const k = KV_PREFIX + String(key || '').trim();
    if (!k || k.endsWith('.')) return false;
    await idbSet(k, null);
    return true;
  }catch{ return false; }
}

// ---------------- Named handle persistence (for tab-level media folders) ----------------
// We already persist projectDir/mediaRootDir under fixed keys.
// Some tabs (e.g. VFX Mapping "VFX Root" directory handle) need their own persisted handles
// so that refresh/close does not lose the folder permission.
const KEY_NAMED_PREFIX = "pfx.namedHandle.";

// Named FILE handle persistence (for per-tab last-opened media)
// Stored in the same IndexedDB store as directory handles.
const KEY_NAMED_FILE_PREFIX = "pfx.namedFileHandle.";

export async function storeNamedHandle(name, handle){
  try{
    const k = KEY_NAMED_PREFIX + String(name || "").trim();
    if (!k || k.endsWith('.')) return false;
    await idbSet(k, handle || null);
    return true;
  }catch{ return false; }
}

// NOTE: This must NOT prompt. If permission is missing, it returns null.
export async function loadNamedHandle(name){
  try{
    const k = KEY_NAMED_PREFIX + String(name || "").trim();
    if (!k || k.endsWith('.')) return null;
    const stored = await idbGet(k);
    if (!stored) return null;
    const ok = await ensureDirPermission(stored);
    return ok ? stored : null;
  }catch{ return null; }
}

export async function clearNamedHandle(name){
  try{
    const k = KEY_NAMED_PREFIX + String(name || "").trim();
    if (!k || k.endsWith('.')) return false;
    await idbSet(k, null);
    return true;
  }catch{ return false; }
}

async function ensureDirPermission(dirHandle, mode = "readwrite", { noPrompt = false } = {}){
  try{
    if (!dirHandle) return false;
    // queryPermission/requestPermission are optional in some contexts
    if (dirHandle.queryPermission){
      const q = await dirHandle.queryPermission({ mode });
      if (q === "granted") return true;
      if (noPrompt) return false; // caller requires silent check — don't prompt
    }
    if (dirHandle.requestPermission){
      const r = await dirHandle.requestPermission({ mode });
      return r === "granted";
    }
    // If no permission APIs exist, assume allowed.
    return true;
  }catch{
    return false;
  }
}

async function ensureFilePermission(fileHandle){
  try{
    if (!fileHandle) return false;
    // IMPORTANT: must NOT prompt. We only accept already-granted permissions.
    if (fileHandle.queryPermission){
      const q = await fileHandle.queryPermission({ mode: "read" });
      return q === "granted";
    }
    // If no permission APIs exist, assume allowed.
    return true;
  }catch{
    return false;
  }
}

export async function storeNamedFileHandle(name, handle){
  try{
    const k = KEY_NAMED_FILE_PREFIX + String(name || "").trim();
    if (!k || k.endsWith('.')) return false;
    await idbSet(k, handle || null);
    return true;
  }catch{ return false; }
}

// NOTE: This must NOT prompt. If permission is missing, it returns null.
export async function loadNamedFileHandle(name){
  try{
    const k = KEY_NAMED_FILE_PREFIX + String(name || "").trim();
    if (!k || k.endsWith('.')) return null;
    const stored = await idbGet(k);
    if (!stored) return null;
    const ok = await ensureFilePermission(stored);
    if (ok) return stored;
    // Chrome sometimes reports "prompt" after refresh even though the handle is still usable.
    // In that case, try a silent read before giving up. Do NOT request permission here.
    try{
      if (stored && typeof stored.getFile === 'function') {
        const f = await stored.getFile();
        if (f) return stored;
      }
    }catch{}
    return null;
  }catch{ return null; }
}

export async function clearNamedFileHandle(name){
  try{
    const k = KEY_NAMED_FILE_PREFIX + String(name || "").trim();
    if (!k || k.endsWith('.')) return false;
    await idbSet(k, null);
    return true;
  }catch{ return false; }
}

// Return the stored project directory handle if it exists AND permission is granted.
// IMPORTANT: this must NOT prompt the user. (Used by autosave + listing)
export async function getStoredProjectDir(){
  try{
    const stored = await idbGet(KEY_PROJECT_DIR);
    if (!stored) return null;
    // noPrompt=true: only query — never call requestPermission.
    // Autosave runs silently; an unexpected browser dialog here would break the UX.
    const ok = await ensureDirPermission(stored, "readwrite", { noPrompt: true });
    return ok ? stored : null;
  }catch{
    return null;
  }
}

// Return the stored MEDIA ROOT directory handle if it exists AND permission is granted.
// IMPORTANT: this must NOT prompt the user. (Used by auto-relink in tabs)
// Returns the handle only if permission is already granted (no prompt — safe to call without user gesture).
export async function getStoredMediaRootDirSilent(){
  try{
    const stored = await idbGet(KEY_MEDIA_ROOT_DIR);
    if (!stored) return null;
    const ok = await ensureDirPermission(stored, "read", { noPrompt: true });
    return ok ? stored : null;
  }catch{
    return null;
  }
}

// Returns the handle, prompting for permission if needed (requires a user gesture).
export async function getStoredMediaRootDir(){
  try{
    const stored = await idbGet(KEY_MEDIA_ROOT_DIR);
    if (!stored) return null;
    const ok = await ensureDirPermission(stored, "read");
    return ok ? stored : null;
  }catch{
    return null;
  }
}

// Returns true if a handle is stored in IDB, regardless of current permission state.
export async function hasStoredMediaRootHandle(){
  try{ return !!(await idbGet(KEY_MEDIA_ROOT_DIR)); }catch{ return false; }
}

// Explicit user action: pick a directory and persist the handle.
// Used for "Media Root" (relink/restore media after refresh).
export async function pickMediaRootDirByUser(){
  if (!window.showDirectoryPicker) return { ok:false, reason:"no_api" };
  try{
    const dir = await window.showDirectoryPicker({ mode: "read" });
    const ok = await ensureDirPermission(dir, "read");
    if (!ok) return { ok:false, reason:"no_permission" };
    await idbSet(KEY_MEDIA_ROOT_DIR, dir);
    return { ok:true, name: String(dir?.name || "").trim() };
  }catch(err){
    return { ok:false, reason:"cancel", error:String(err?.message||err) };
  }
}

export async function isMediaRootConfigured(){
  const d = await getStoredMediaRootDir();
  return !!d;
}

export async function clearMediaRootDir(){
  try{ await idbSet(KEY_MEDIA_ROOT_DIR, null); }catch{}
  return true;
}

// Explicit user action: pick a directory and persist the handle.
// Use this from UI (gear icon) so Save/Load won't need to prompt later.
export async function pickProjectDirByUser(){
  if (!window.showDirectoryPicker) return { ok:false, reason:"no_api" };
  try{
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });
    const ok = await ensureDirPermission(dir);
    if (!ok) return { ok:false, reason:"no_permission" };
    await idbSet(KEY_PROJECT_DIR, dir);
    return { ok:true, name: String(dir?.name || "").trim() };
  }catch(err){
    // user cancel is normal
    return { ok:false, reason:"cancel", error:String(err?.message||err) };
  }
}

export async function isProjectDirConfigured(){
  const d = await getStoredProjectDir();
  return !!d;
}

async function getOrPickProjectDir(){
  // 1) Try stored handle (silent — already granted this session)
  try{
    const stored = await getStoredProjectDir();
    if (stored) return stored;
  }catch{}

  // 2) Stored handle exists but permission expired after restart — re-request on stored handle
  //    (avoids opening a brand-new directory picker when the user already configured a folder)
  try{
    const stored = await idbGet(KEY_PROJECT_DIR);
    if (stored){
      const ok = await ensureDirPermission(stored, "readwrite"); // prompts if needed
      if (ok) return stored;
    }
  }catch{}

  // 3) No stored handle — ask user to pick for the first time
  if (!window.showDirectoryPicker) return null;
  try{
    const dir = await window.showDirectoryPicker({ mode: "readwrite" });
    const ok = await ensureDirPermission(dir);
    if (!ok) return null;
    await idbSet(KEY_PROJECT_DIR, dir);
    return dir;
  }catch{
    return null;
  }
}

// ---------------- v4 FS helpers ----------------
async function ensureProjectSubdirs(rootDirHandle, projectName){
  const pfxDir = await rootDirHandle.getDirectoryHandle(PFX_ROOT_DIR, { create:true });
  const projDir = await pfxDir.getDirectoryHandle(sanitizeFilename(projectName), { create:true });
  const tabsDir = await projDir.getDirectoryHandle(DIR_TABS, { create:true });
  const autosaveDir = await projDir.getDirectoryHandle(DIR_AUTOSAVE, { create:true });
  const thumbsDir = await projDir.getDirectoryHandle(DIR_THUMBS, { create:true });
  const mediaDir = await projDir.getDirectoryHandle(DIR_MEDIA, { create:true });
  const logsDir = await projDir.getDirectoryHandle(DIR_LOGS, { create:true });
  try{ await thumbsDir.getDirectoryHandle('markers', { create:true }); }catch{}
  try{ await thumbsDir.getDirectoryHandle('review', { create:true }); }catch{}
  return { pfxDir, projDir, tabsDir, autosaveDir, thumbsDir, mediaDir, logsDir };
}

async function writeTextFile(dirHandle, filename, text){
  // Crash-safe: snapshots the prior copy to <name>.bak, writes, then verifies the
  // bytes committed — restores the backup and throws on a corrupt/partial write
  // so a save can never silently destroy the last good data.
  return await safeWriteText(dirHandle, filename, text);
}

async function writeProjectV4ViaFS(projectName, { autosave=false } = {}){
  const root = autosave ? await getStoredProjectDir() : await getOrPickProjectDir();
  if (!root) return { ok:false, reason:'no_dir' };
  const ok = await ensureDirPermission(root);
  if (!ok) return { ok:false, reason:'no_permission' };

  const dirs = await ensureProjectSubdirs(root, projectName);
  const manifest = buildManifest(projectName);
  await _flushSWISnapshot();
  const tabs = buildTabsSnapshot(projectName);

  // Tabs
  for (const [tab, file] of Object.entries(TAB_FILES)){
    await writeTextFile(dirs.tabsDir, file, JSON.stringify(tabs[tab], null, 2));
  }
  // Manifest
  await writeTextFile(dirs.projDir, PROJECT_MANIFEST, JSON.stringify(manifest, null, 2));

  // Autosave snapshot (latest)
  if (autosave){
    const snap = {
      schema: 'pfxproj_autosave',
      schemaVersion: 1,
      projectName: sanitizeFilename(projectName),
      updatedAt: nowISO(),
      tabs: Object.fromEntries(Object.entries(tabs).map(([k,v])=>[k, v?.updatedAt || nowISO()])),
    };
    await writeTextFile(dirs.autosaveDir, AUTOSAVE_FILE, JSON.stringify(snap, null, 2));
  }

  return { ok:true, where:'fs_access', folder:`${PFX_ROOT_DIR}/${sanitizeFilename(projectName)}` };
}

// v4: per-tab save/load (do NOT overwrite other tab shards)
async function writeTabV4ViaFS(projectName, { tabKey, autosave=false } = {}){
  const t = String(tabKey || '').trim();
  if (!isValidTabKey(t)) return { ok:false, reason:'bad_tab' };

  const root = autosave ? await getStoredProjectDir() : await getOrPickProjectDir();
  if (!root) return { ok:false, reason:'no_dir' };
  const ok = await ensureDirPermission(root);
  if (!ok) return { ok:false, reason:'no_permission' };

  const dirs = await ensureProjectSubdirs(root, projectName);
  const manifest = buildManifest(projectName);
  if (t === 'shots') await _flushSWISnapshot();
  const tabs = buildTabsSnapshot(projectName);

  // Only write the requested tab shard
  await writeTextFile(dirs.tabsDir, TAB_FILES[t], JSON.stringify(tabs[t], null, 2));
  // Ensure manifest exists / updated
  await writeTextFile(dirs.projDir, PROJECT_MANIFEST, JSON.stringify(manifest, null, 2));

  if (autosave){
    const snap = {
      schema: 'pfxproj_autosave',
      schemaVersion: 1,
      projectName: sanitizeFilename(projectName),
      updatedAt: nowISO(),
      tabs: { [t]: tabs?.[t]?.updatedAt || nowISO() },
    };
    await writeTextFile(dirs.autosaveDir, AUTOSAVE_FILE, JSON.stringify(snap, null, 2));
  }

  return { ok:true, where:'fs_access', folder:`${PFX_ROOT_DIR}/${sanitizeFilename(projectName)}`, tab:t };
}

async function readJSONFile(dirHandle, filename){
  // Corruption-resilient: falls back to <name>.bak if the primary is missing,
  // empty, or unparseable — so a half-written/corrupt shard can't surface as
  // "project forgot my content".
  return await safeReadJSON(dirHandle, filename, (fn) => {
    try{ console.warn(`[projectFile] recovered "${fn}" from backup (.bak)`); }catch{}
  });
}

async function loadAndApplyTabsFromFS(tabsDir){
  const pull = await readJSONFile(tabsDir, TAB_FILES.pull_prep);
  const cut = await readJSONFile(tabsDir, TAB_FILES.cut_diff);
  const markers = await readJSONFile(tabsDir, TAB_FILES.markers);
  const plate = await readJSONFile(tabsDir, TAB_FILES.plate_link);
  const imf = await readJSONFile(tabsDir, TAB_FILES.imf);
  const review = await readJSONFile(tabsDir, TAB_FILES.review);
  const trlConf = await readJSONFile(tabsDir, TAB_FILES.trl_conf);
  const settings = await readJSONFile(tabsDir, TAB_FILES.settings);
  const shots = await readJSONFile(tabsDir, TAB_FILES.shots);

  // Unconditionally overwrite every global — if a tab has no data in this project,
  // null it out so stale data from a previously-loaded project can't bleed through.
  // Only treat as EDL when there are events — a media/content-only state must not
  // masquerade as a loaded EDL.
  const pullEdl = applyPullPrepProjectState(pull?.state ?? null, { applyEdl:false });
  try{ window.__MPS_CD_SNAPSHOT         = cut?.state    ?? null; }catch{}
  try{ window.__MPS_SM_SNAPSHOT         = markers?.state ?? null; }catch{}
  try{ window.__MPS_AMF_STATE           = plate?.state?.amf     ?? null; }catch{}
  try{ window.__MPS_AMF_FILE_PARSED     = plate?.state?.amfFile ?? null; }catch{}
  try{ window.__MPS_OCIO_PROJECT_HASH   = String(plate?.state?.ocio?.hash || '').trim(); }catch{}
  try{ window.__MPS_OCIO_FILE_META      = plate?.state?.ocio?.meta ?? null; }catch{}
  try{ window.__PFX_IMF_STATE           = imf?.state    ?? null; }catch{}
  try{ window.__PFX_REVIEWS_STATE       = review?.state ?? null; }catch{}
  try{ window.__PFX_TRL_CONF_STATE      = trlConf?.state ?? null; }catch{}
  const acesLook = await readJSONFile(tabsDir, TAB_FILES.aces_look);
  try{ window.__PFX_ACES_LOOK_STATE = acesLook?.state ?? null; }catch{}

  // Restore localStorage (settings)
  try{
    const kv = settings?.state?.localStorage || null;
    if (kv && typeof kv === 'object'){
      for (const [k,v] of Object.entries(kv)){
        try{ localStorage.setItem(k, String(v ?? '')); }catch{}
      }
    }
  }catch{}

  // Sync EP checkbox default to project type (only when project explicitly has a type)
  try{
    const pt = window.__PFX_PROJECT_TYPE;
    if (pt === 'series')     localStorage.setItem('pfx_sm_ep_on', '1');
    else if (pt === 'standalone') localStorage.setItem('pfx_sm_ep_on', '0');
    // null = legacy project → leave whatever value was restored from settings
  }catch{}

  // Notify UI of project type change so badges/labels can update
  try{ window.dispatchEvent(new CustomEvent('pfx:project-type-changed', { detail:{ projectType: window.__PFX_PROJECT_TYPE, seriesMeta: window.__PFX_SERIES_META } })); }catch{}

  // Apply to mounted UIs (best-effort, all unconditional so missing tabs clear their UI).
  if (pullEdl?.events?.length) {
    try{ if (typeof window.MPS_applyEdlRaw === 'function') window.MPS_applyEdlRaw(pullEdl); }catch{}
  }
  try{ if (typeof window.MPS_applyCutDiffSnapshot === 'function') window.MPS_applyCutDiffSnapshot(cut?.state ?? null); }catch{}
  try{ if (typeof window.MPS_applyShotMarkerSnapshot === 'function') window.MPS_applyShotMarkerSnapshot(markers?.state ?? null); }catch{}
  try{ if (typeof window.MPS_applyAMFState === 'function') window.MPS_applyAMFState(plate?.state?.amf ?? null); }catch{}
  try{ if (typeof window.PFX_applyIMFState === 'function') window.PFX_applyIMFState(imf?.state ?? null); }catch{}
  try{ if (typeof window.PFX_applyReviewsState === 'function') window.PFX_applyReviewsState(review?.state ?? null); }catch{}
  try{ if (typeof window.PFX_applyTrlConfState === 'function') window.PFX_applyTrlConfState(trlConf?.state ?? null); }catch{}
  try{ if (typeof window.PFX_applyAcesLookState === 'function') window.PFX_applyAcesLookState(acesLook?.state ?? null); }catch{}

  // Restore SWI / OCF index state
  try{ window.__PFX_SWI_SNAPSHOT = shots?.state ?? null; }catch{}
  try{
    if (shots?.state && typeof window.PFX_SWI?.importState === 'function') {
      window.PFX_SWI.importState(shots.state);
    }
  }catch{}
  try{
    if (shots?.state?.ocfRoots != null || shots?.state?.ocfIndex != null) {
      if (typeof window.PFX_OCF_INDEX?.importState === 'function') {
        window.PFX_OCF_INDEX.importState({ ocfRoots: shots.state.ocfRoots, ocfIndex: shots.state.ocfIndex });
      }
    }
  }catch{}

  try{ window.dispatchEvent(new CustomEvent('pfx:project-applied', { detail:{ pull, cut, markers, plate, imf, review, trlConf, acesLook, settings, shots } })); }catch{}
}

async function loadAndApplyTabFromFS(tabsDir, tabKey){
  const t = String(tabKey || '').trim();
  if (!isValidTabKey(t)) return { ok:false, reason:'bad_tab' };

  const obj = await readJSONFile(tabsDir, TAB_FILES[t]);
  if (!obj) return { ok:false, reason:'missing_tab_file' };

  // Keep latest snapshot accessible even if UI hasn't mounted yet.
  if (t === 'pull_prep'){
    applyPullPrepProjectState(obj?.state ?? null);
  }
  if (t === 'cut_diff'){
    try{ if (obj?.state != null) window.__MPS_CD_SNAPSHOT = obj.state; }catch{}
    try{ if (typeof window.MPS_applyCutDiffSnapshot === 'function' && obj?.state != null) window.MPS_applyCutDiffSnapshot(obj.state); }catch{}
  }
  if (t === 'markers'){
    try{ if (obj?.state != null) window.__MPS_SM_SNAPSHOT = obj.state; }catch{}
    try{ if (typeof window.MPS_applyShotMarkerSnapshot === 'function' && obj?.state != null) window.MPS_applyShotMarkerSnapshot(obj.state); }catch{}
  }
  if (t === 'plate_link'){
    try{ if (obj?.state?.amf != null) window.__MPS_AMF_STATE = obj.state.amf; }catch{}
    try{ if (obj?.state?.amfFile != null) window.__MPS_AMF_FILE_PARSED = obj.state.amfFile; }catch{}
    try{ if (obj?.state?.ocio?.hash != null) window.__MPS_OCIO_PROJECT_HASH = String(obj.state.ocio.hash || '').trim(); }catch{}
    try{ if (obj?.state?.ocio?.meta != null) window.__MPS_OCIO_FILE_META = obj.state.ocio.meta; }catch{}
    try{ if (typeof window.MPS_applyAMFState === 'function' && obj?.state?.amf != null) window.MPS_applyAMFState(obj.state.amf); }catch{}
  }
  if (t === 'imf'){
    try{ window.__PFX_IMF_STATE = obj?.state ?? null; }catch{}
    try{ if (typeof window.PFX_applyIMFState === 'function') window.PFX_applyIMFState(obj?.state ?? null); }catch{}
  }
  if (t === 'review'){
    try{ if (obj?.state != null) window.__PFX_REVIEWS_STATE = obj.state; }catch{}
    try{ if (typeof window.PFX_applyReviewsState === 'function' && obj?.state != null) window.PFX_applyReviewsState(obj.state); }catch{}
  }
  if (t === 'trl_conf'){
    try{ window.__PFX_TRL_CONF_STATE = obj?.state ?? null; }catch{}
    try{ if (typeof window.PFX_applyTrlConfState === 'function') window.PFX_applyTrlConfState(obj?.state ?? null); }catch{}
  }
  if (t === 'aces_look'){
    try{ window.__PFX_ACES_LOOK_STATE = obj?.state ?? null; }catch{}
    try{ if (typeof window.PFX_applyAcesLookState === 'function') window.PFX_applyAcesLookState(obj?.state ?? null); }catch{}
  }
  if (t === 'shots'){
    // Restore ShotWorkItems (content) + OCF index/roots (media). Without this
    // branch the per-tab load path read shots.json but never applied it, so
    // shots content and linked media were silently dropped on reopen.
    try{ window.__PFX_SWI_SNAPSHOT = obj?.state ?? null; }catch{}
    try{
      if (obj?.state && typeof window.PFX_SWI?.importState === 'function') {
        window.PFX_SWI.importState(obj.state);
      }
    }catch{}
    try{
      if (obj?.state?.ocfRoots != null || obj?.state?.ocfIndex != null) {
        if (typeof window.PFX_OCF_INDEX?.importState === 'function') {
          window.PFX_OCF_INDEX.importState({ ocfRoots: obj.state.ocfRoots, ocfIndex: obj.state.ocfIndex });
        }
      }
    }catch{}
  }
  if (t === 'settings'){
    // Restore localStorage snapshot
    try{
      const kv = obj?.state?.localStorage || null;
      if (kv && typeof kv === 'object'){
        for (const [k,v] of Object.entries(kv)){
          try{ localStorage.setItem(k, String(v ?? '')); }catch{}
        }
      }
    }catch{}
    try{ window.dispatchEvent(new CustomEvent('pfx:settings-applied', { detail:{ settings: obj } })); }catch{}
  }

  try{ window.dispatchEvent(new CustomEvent('pfx:project-tab-applied', { detail:{ tab:t, obj } })); }catch{}
  return { ok:true, tab:t };
}

export async function saveTabProjectFile(tabKey, projectName){
  if (window.PFX_PERMISSIONS && !window.PFX_PERMISSIONS.canDoAction('save_project')) {
    window.PFX_GUARD?.toast?.('Save blocked — no save_project permission', 'deny');
    return { ok: false, error: 'Permission denied: save_project' };
  }
  const t = String(tabKey || '').trim();
  if (!isValidTabKey(t)) return { ok:false, reason:'bad_tab' };

  // Refresh the shots snapshot up front so the Downloads fallback (taken when no
  // project folder is granted / the picker is cancelled) writes current content +
  // media. The FS path flushes again internally for the shots tab — harmless.
  if (t === 'shots') await _flushSWISnapshot();

  // Prefer FS (may prompt on manual save)
  try{
    const r = await writeTabV4ViaFS(projectName, { tabKey:t, autosave:false });
    if (r.ok) return r;
  }catch{}

  // Downloads fallback
  try{
    const manifest = buildManifest(projectName);
    const tabs = buildTabsSnapshot(projectName);
    const proj = sanitizeFilename(projectName);
    const base = `${PFX_ROOT_DIR}/${proj}`;
    const files = [
      { path:`${base}/${PROJECT_MANIFEST}`, text:JSON.stringify(manifest,null,2) },
      { path:`${base}/${DIR_TABS}/${TAB_FILES[t]}`, text:JSON.stringify(tabs[t],null,2) },
    ];
    return await writeViaDownloads(projectName, files);
  }catch(err){
    return { ok:false, where:'none', error:String(err?.message||err) };
  }
}

export async function saveTabProjectAutosave(tabKey, projectName){
  const t = String(tabKey || '').trim();
  if (!isValidTabKey(t)) return { ok:false, reason:'bad_tab' };

  // Autosave must NOT prompt
  try{
    const r = await writeTabV4ViaFS(projectName, { tabKey:t, autosave:true });
    if (r.ok) return r;
    if (r && r.reason === 'no_dir') return { ok:false, where:'none', reason:'no_dir' };
  }catch{}

  try{
    const manifest = buildManifest(projectName);
    const tabs = buildTabsSnapshot(projectName);
    const proj = sanitizeFilename(projectName);
    const base = `${PFX_ROOT_DIR}/${proj}`;
    const files = [
      { path:`${base}/${PROJECT_MANIFEST}`, text:JSON.stringify(manifest,null,2) },
      { path:`${base}/${DIR_TABS}/${TAB_FILES[t]}`, text:JSON.stringify(tabs[t],null,2) },
      { path:`${base}/${DIR_AUTOSAVE}/${AUTOSAVE_FILE}`, text:JSON.stringify({ schema:'pfxproj_autosave', schemaVersion:1, projectName:proj, updatedAt:nowISO(), tabs:{ [t]: tabs?.[t]?.updatedAt || nowISO() } },null,2) },
    ];
    return await writeViaDownloads(projectName, files);
  }catch(err){
    return { ok:false, where:'none', error:String(err?.message||err) };
  }
}

export async function loadTabProjectByName(tabKey, projectName, { allowPrompt = false } = {}){
  const t = String(tabKey || '').trim();
  if (!isValidTabKey(t)) return { ok:false, reason:'bad_tab' };
  try{
    // User-initiated loads (dropdown / Load button) may prompt to re-grant the
    // folder handle — after an app restart its permission reverts to 'prompt',
    // so the silent getStoredProjectDir() would return null and the project's
    // tab shards (events, media, …) would never be read. Boot auto-restore stays
    // silent (allowPrompt=false) so launch never pops an unexpected dialog.
    const root = allowPrompt ? await getOrPickProjectDir() : await getStoredProjectDir();
    if (!root) return { ok:false, reason:'no_dir' };
    const ok = await ensureDirPermission(root);
    if (!ok) return { ok:false, reason:'no_permission' };
    const dirs = await ensureProjectSubdirs(root, projectName);
    // Ensure manifest exists (project folder marker)
    try{ await dirs.projDir.getFileHandle(PROJECT_MANIFEST, { create:false }); }catch{}
    const r = await loadAndApplyTabFromFS(dirs.tabsDir, t);
    if (!r.ok) return r;
    return { ok:true, where:'fs_access', tab:t, filename:`${PFX_ROOT_DIR}/${sanitizeFilename(projectName)}/${DIR_TABS}/${TAB_FILES[t]}` };
  }catch(err){
    return { ok:false, reason:'not_found', error:String(err?.message||err) };
  }
}

async function writeViaFileSystemAccess(projectName, jsonText){
  const dir = await getOrPickProjectDir();
  if (!dir) return { ok:false, reason:"no_dir" };

  // Ensure ast_project subfolder inside selected folder
  let astDir = dir;
  try{
    astDir = await dir.getDirectoryHandle("ast_project", { create: true });
  }catch{
    // If cannot create, fallback to root dir
    astDir = dir;
  }

  const filename = `${sanitizeFilename(projectName)}.mpsproj.json`;
  const fileHandle = await astDir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(jsonText);
  await writable.close();
  return { ok:true, where:"fs_access", filename };
}

export async function getAstProjectDirHandle(){
  const dir = await getOrPickProjectDir();
  if (!dir) return null;
  try{
    return await dir.getDirectoryHandle("ast_project", { create: true });
  }catch{
    return dir;
  }
}

async function getProjectFileHandle(projectName, { autosave=false, create=false } = {}){
  const astDir = await getAstProjectDirHandle();
  if (!astDir) return null;
  const base = sanitizeFilename(projectName);
  const filename = autosave ? `${base}${AUTOSAVE_SUFFIX}.mpsproj.json` : `${base}.mpsproj.json`;
  try{
    return await astDir.getFileHandle(filename, { create: !!create });
  }catch{
    return null;
  }
}

async function fileHandleInfo(fh){
  if (!fh) return { exists:false };
  try{
    const f = await fh.getFile();
    return { exists:true, lastModified:Number(f.lastModified||0), size:Number(f.size||0) };
  }catch{
    return { exists:false };
  }
}

export async function loadUnifiedProjectByName(projectName, { allowPrompt = false } = {}){
  try{
    // See loadTabProjectByName: user-initiated loads may re-prompt for the folder
    // handle after an app restart; boot auto-restore stays silent.
    const root = allowPrompt ? await getOrPickProjectDir() : await getStoredProjectDir();
    if (!root) return { ok:false, reason:'no_dir' };
    const ok = await ensureDirPermission(root);
    if (!ok) return { ok:false, reason:'no_permission' };

    const dirs = await ensureProjectSubdirs(root, projectName);
    // Ensure manifest exists
    const mh = await dirs.projDir.getFileHandle(PROJECT_MANIFEST, { create:false });
    const mText = await readHandleAsText(mh);
    try {
      const mObj = JSON.parse(mText);
      if (mObj?.projectType) {
        window.__PFX_PROJECT_TYPE = mObj.projectType;
        window.__PFX_SERIES_META  = mObj.seriesMeta || null;
      } else {
        // Legacy project with no type field — don't force-override EP setting
        window.__PFX_PROJECT_TYPE = null;
        window.__PFX_SERIES_META  = null;
      }
    } catch {}
    await loadAndApplyTabsFromFS(dirs.tabsDir);
    return { ok:true, where:'fs_access', filename:`${PFX_ROOT_DIR}/${sanitizeFilename(projectName)}/${PROJECT_MANIFEST}` };
  }catch(err){
    return { ok:false, reason:'not_found', error:String(err?.message||err) };
  }
}

export async function loadUnifiedProjectAutosaveByName(projectName){
  // v4: tabs are the source of truth; autosave is metadata only.
  return await loadUnifiedProjectByName(projectName);
}

export async function checkUnifiedProjectAutosave(projectName){
  // v4: autosave is a single file inside the project folder.
  try{
    const root = await getStoredProjectDir();
    if (!root) return { ok:false, reason:'no_dir' };
    const ok = await ensureDirPermission(root);
    if (!ok) return { ok:false, reason:'no_permission' };
    const dirs = await ensureProjectSubdirs(root, projectName);
    let autoFH = null;
    try{ autoFH = await dirs.autosaveDir.getFileHandle(AUTOSAVE_FILE, { create:false }); }catch{}
    const autosave = await fileHandleInfo(autoFH);
    return { ok:true, autosave, autosaveNewer: !!autosave.exists };
  }catch(err){
    return { ok:false, error:String(err?.message||err) };
  }
}

// List projects under <PFX>/ (best-effort)
export async function listUnifiedProjects(){
  // Listing should not force the directory picker.
  const dir = await getStoredProjectDir();
  if (!dir) return { ok:false, projects:[] };

  let pfxDir = null;
  try{ pfxDir = await dir.getDirectoryHandle(PFX_ROOT_DIR, { create:false }); }
  catch{ return { ok:true, projects:[] }; }

  const projects = [];
  try{
    for await (const [name, handle] of pfxDir.entries()){
      if (handle?.kind !== 'directory') continue;
      try{
        await handle.getFileHandle(PROJECT_MANIFEST, { create:false });
        projects.push(name);
      }catch{}
    }
  }catch{}
  projects.sort((a,b)=>a.localeCompare(b));
  return { ok:true, projects };
}


// Delete an entire project folder: <ProjectDir>/PFX/<ProjectName>/...
// NOTE: This requires File System Access API support + granted permissions.
async function _pfxRemoveDirContentsRecursive(dirHandle){
  try{
    if (!dirHandle?.removeEntry) return;
    for await (const [name, handle] of dirHandle.entries()){
      if (handle?.kind === 'directory'){
        await _pfxRemoveDirContentsRecursive(handle);
        try{ await dirHandle.removeEntry(name); }catch{}
      }else{
        try{ await dirHandle.removeEntry(name); }catch{}
      }
    }
  }catch{}
}

export async function deleteUnifiedProjectByName(projectName){
  const pn = sanitizeFilename(projectName);
  if (!pn) return { ok:false, reason:'bad_name' };

  const root = await getStoredProjectDir();
  if (!root) return { ok:false, reason:'no_dir' };

  const ok = await ensureDirPermission(root);
  if (!ok) return { ok:false, reason:'no_permission' };

  let pfxDir = null;
  try{ pfxDir = await root.getDirectoryHandle(PFX_ROOT_DIR, { create:false }); }
  catch{ return { ok:false, reason:'not_found' }; }

  if (!pfxDir?.removeEntry) return { ok:false, reason:'not_supported' };

  // Fast path: recursive remove
  try{
    await pfxDir.removeEntry(pn, { recursive:true });
    return { ok:true };
  }catch(err){
    // Fallback: manual recursion (for builds that don't support {recursive:true})
    try{
      const projDir = await pfxDir.getDirectoryHandle(pn, { create:false });
      await _pfxRemoveDirContentsRecursive(projDir);
      await pfxDir.removeEntry(pn);
      return { ok:true };
    }catch(err2){
      return { ok:false, reason:'delete_failed', error:String(err2?.message||err2) };
    }
  }
}

async function writeViaDownloads(projectName, files){
  const download = (options) => new Promise((resolve) => {
    try{ chrome.downloads.download(options, (id) => resolve(id || null)); }
    catch{ resolve(null); }
  });

  const saved = [];
  for (const f of (files || [])){
    const blob = new Blob([f.text], { type: f.mime || 'application/json' });
    const url = URL.createObjectURL(blob);
    const id = await download({ url, filename: f.path, saveAs:false, conflictAction:'overwrite' });
    setTimeout(()=>{ try{ URL.revokeObjectURL(url);}catch{} }, 30_000);
    if (id) saved.push(f.path);
  }
  return { ok: saved.length === (files||[]).length, where:'downloads', files:saved };
}

async function writeAutosaveViaFileSystemAccess(projectName, jsonText){
  // Autosave must NOT prompt the user for directory permission.
  const dir = await getStoredProjectDir();
  if (!dir) return { ok:false, reason:"no_dir" };

  let astDir = dir;
  try{ astDir = await dir.getDirectoryHandle("ast_project", { create: true }); }
  catch{ astDir = dir; }

  const filename = `${sanitizeFilename(projectName)}${AUTOSAVE_SUFFIX}.mpsproj.json`;
  const fileHandle = await astDir.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(jsonText);
  await writable.close();
  return { ok:true, where:"fs_access", filename };
}

async function writeAutosaveViaDownloads(projectName, jsonText){
  const filename = `ast_project/${sanitizeFilename(projectName)}${AUTOSAVE_SUFFIX}.mpsproj.json`;
  const blob = new Blob([jsonText], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const download = (options) => new Promise((resolve) => {
    try{ chrome.downloads.download(options, (id) => resolve(id || null)); }
    catch{ resolve(null); }
  });

  const id = await download({ url, filename, saveAs: false, conflictAction: "overwrite" });
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return { ok: !!id, where:"downloads", filename };
}

function applyToApp(projectObj){
  // Enterprise Offline meta
  try{
    const ent = projectObj?.enterprise || null;
    const pid = String(projectObj?.meta?.projectId || ent?.projectId || '').trim();
    const salt = String(ent?.projectSalt || '').trim();
    if (pid) window.__MPS_PROJECT_ID = pid;
    if (salt) window.__MPS_PROJECT_SALT = salt;
    if (ent && typeof ent === 'object') window.__MPS_ENTERPRISE_OFFLINE_META = ent;
    if (ent?.auditHead) window.__MPS_ENTERPRISE_AUDIT_HEAD = ent.auditHead;
  }catch{}

  // Always keep latest project snapshots accessible, even if a tab hasn't mounted yet.
  try{ if (projectObj?.edl) window.__MPS_EDL_RAW = projectObj.edl; }catch{}
  try{ if (projectObj?.cutDiff) window.__MPS_CD_SNAPSHOT = projectObj.cutDiff; }catch{}
  try{ if (projectObj?.shotMarker) window.__MPS_SM_SNAPSHOT = projectObj.shotMarker; }catch{}
  try{ if (projectObj?.amf) window.__MPS_AMF_STATE = projectObj.amf; }catch{}
  try{ if (projectObj?.amfFile) window.__MPS_AMF_FILE_PARSED = projectObj.amfFile; }catch{}
  try{ if (projectObj?.ocio?.hash != null) window.__MPS_OCIO_PROJECT_HASH = String(projectObj.ocio.hash || '').trim(); }catch{}
  try{ if (projectObj?.ocio?.meta != null) window.__MPS_OCIO_FILE_META = projectObj.ocio.meta; }catch{}
  try{ if (projectObj?.audit) window.__MPS_AUDIT_LOG = projectObj.audit; }catch{}

  // EDL raw
  try{
    if (projectObj?.edl && typeof window.MPS_applyEdlRaw === "function"){
      window.MPS_applyEdlRaw(projectObj.edl);
    }
  }catch{}

  // Cut Diff
  try{
    if (projectObj?.cutDiff && typeof window.MPS_applyCutDiffSnapshot === "function"){
      window.MPS_applyCutDiffSnapshot(projectObj.cutDiff);
    }
  }catch{}

  // Shot Marker
  try{
    if (projectObj?.shotMarker && typeof window.MPS_applyShotMarkerSnapshot === "function"){
      window.MPS_applyShotMarkerSnapshot(projectObj.shotMarker);
    }
  }catch{}

  // AMF state (policy/profile)
  try{
    if (projectObj?.amf && typeof window.MPS_applyAMFState === "function"){
      window.MPS_applyAMFState(projectObj.amf);
    }
  }catch{}

  // Notify all tabs/components that a new project has been applied.
  try{
    window.dispatchEvent(new CustomEvent('mps:project-applied', { detail: {
      meta: projectObj?.meta || null,
      enterprise: projectObj?.enterprise || null,
      edl: projectObj?.edl || null,
      cutDiff: projectObj?.cutDiff || null,
      shotMarker: projectObj?.shotMarker || null,
      amf: projectObj?.amf || null,
      amfFile: projectObj?.amfFile || null,
      ocio: projectObj?.ocio || null,
      audit: projectObj?.audit || null
    }}));
  }catch{}
}

// ---------------- Public API ----------------
export 
function auditToCSVText(auditLog){
  try{
    const ex = auditLog?.exports || [];
    const cols = ['iso','project','type','intent','count','qs','timelineFP','ocioHash','amfHashShort','files','note','qsFlags'];
    const lines = [cols.join(',')];
    const esc = (v)=>{
      const s = String(v ?? '');
      if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
      return s;
    };
    for (const e of ex){
      const row = cols.map(c=>{
        if (c === 'files') return esc((e.files||[]).join(' | '));
        if (c === 'qsFlags'){
          try{ return esc(JSON.stringify(e.qsFlags||{})); }catch{ return esc(''); }
        }
        return esc(e[c]);
      }).join(',');
      lines.push(row);
    }
    return lines.join('\n') + '\n';
  }catch{
    return 'iso,project,type,intent,count,qs,timelineFP,ocioHash,amfHashShort,files,note,qsFlags\n';
  }
}

async function writeAuditSidecars(projectName){
  try{
    // Throttle to avoid spamming writes during frequent autosaves.
    try{
      const last = Number(window.__MPS_LAST_AUDIT_SIDECAR_AT || 0);
      const now = Date.now();
      if (now - last < 15000) return { ok:false, reason:'throttled' };
      window.__MPS_LAST_AUDIT_SIDECAR_AT = now;
    }catch{}

    const auditLog = (()=>{ try{ return window.__MPS_AUDIT_LOG || null; }catch{ return null; } })();
    if (!auditLog || !Array.isArray(auditLog.exports) || auditLog.exports.length === 0) return { ok:false, reason:'empty' };

    const astDir = await getAstProjectDirHandle();
    const base = sanitizeFilename(projectName);

    const jsonName = `${base}.audit.json`;
    const csvName  = `${base}.audit.csv`;
    const jsonText = JSON.stringify(auditLog, null, 2);
    const csvText  = auditToCSVText(auditLog);

    if (astDir && astDir.getFileHandle){
      try{
        // JSON
        const fhJ = await astDir.getFileHandle(jsonName, { create:true });
        const wJ = await fhJ.createWritable(); await wJ.write(jsonText); await wJ.close();
        // CSV
        const fhC = await astDir.getFileHandle(csvName, { create:true });
        const wC = await fhC.createWritable(); await wC.write(csvText); await wC.close();
        return { ok:true, where:'fs_access', files:[jsonName, csvName] };
      }catch{}
    }

    // Fallback: Downloads (best effort)
    try{
      const blobJ = new Blob([jsonText], { type:'application/json' });
      const urlJ = URL.createObjectURL(blobJ);
      chrome.downloads.download({ url:urlJ, filename:`ast_project/${jsonName}`, saveAs:false }, ()=>{ try{ URL.revokeObjectURL(urlJ);}catch{} });

      const blobC = new Blob([csvText], { type:'text/csv' });
      const urlC = URL.createObjectURL(blobC);
      chrome.downloads.download({ url:urlC, filename:`ast_project/${csvName}`, saveAs:false }, ()=>{ try{ URL.revokeObjectURL(urlC);}catch{} });

      return { ok:true, where:'downloads', files:[jsonName, csvName] };
    }catch(err){
      return { ok:false, where:'none', error:String(err?.message||err) };
    }
  }catch(err){
    return { ok:false, error:String(err?.message||err) };
  }
}

export async function saveUnifiedProjectFile(projectName){
  // Permission check
  if (window.PFX_PERMISSIONS && !window.PFX_PERMISSIONS.canDoAction('save_project')) {
    window.PFX_GUARD?.toast?.('Save blocked — no save_project permission', 'deny');
    return { ok: false, error: 'Permission denied: save_project' };
  }
  // Refresh the shots snapshot up front so the Downloads fallback (taken when no
  // project folder is granted / the picker is cancelled) writes current content +
  // media, not a stale snapshot. The FS path flushes again internally — harmless.
  await _flushSWISnapshot();
  // v4 per-tab shards
  try{
    const r = await writeProjectV4ViaFS(projectName, { autosave:false });
    if (r.ok){
      try{ window.MPS_auditAdd?.({ type:'PROJECT_SAVE', intent:'project', files:[`${PFX_ROOT_DIR}/${sanitizeFilename(projectName)}/${PROJECT_MANIFEST}`], note:'Save Project' }); }catch{}
      return r;
    }
  }catch{}

  // Downloads fallback
  try{
    const manifest = buildManifest(projectName);
    const tabs = buildTabsSnapshot(projectName);
    const proj = sanitizeFilename(projectName);
    const base = `${PFX_ROOT_DIR}/${proj}`;
    const files = [];
    files.push({ path:`${base}/${PROJECT_MANIFEST}`, text:JSON.stringify(manifest,null,2) });
    for (const [tab, file] of Object.entries(TAB_FILES)){
      files.push({ path:`${base}/${DIR_TABS}/${file}`, text:JSON.stringify(tabs[tab],null,2) });
    }
    const r2 = await writeViaDownloads(projectName, files);
    try{ window.MPS_auditAdd?.({ type:'PROJECT_SAVE', intent:'project', files:[`${base}/${PROJECT_MANIFEST}`], note:'Save Project (Downloads fallback)' }); }catch{}
    return r2;
  }catch(err){
    return { ok:false, where:'none', error:String(err?.message||err) };
  }
}

export async function saveUnifiedProjectAutosave(projectName){
  // Autosave must NOT prompt the user.
  try{
    const r = await writeProjectV4ViaFS(projectName, { autosave:true });
    if (r.ok){
      try{ window.MPS_auditAdd?.({ type:'PROJECT_AUTOSAVE', intent:'project', files:[`${PFX_ROOT_DIR}/${sanitizeFilename(projectName)}/${DIR_AUTOSAVE}/${AUTOSAVE_FILE}`], note:'Autosave' }); }catch{}
      return r;
    }
    if (r && r.reason === 'no_dir') return { ok:false, where:'none', reason:'no_dir' };
  }catch{}

  try{
    const manifest = buildManifest(projectName);
    const tabs = buildTabsSnapshot(projectName);
    const proj = sanitizeFilename(projectName);
    const base = `${PFX_ROOT_DIR}/${proj}`;
    const files = [];
    files.push({ path:`${base}/${PROJECT_MANIFEST}`, text:JSON.stringify(manifest,null,2) });
    for (const [tab, file] of Object.entries(TAB_FILES)){
      files.push({ path:`${base}/${DIR_TABS}/${file}`, text:JSON.stringify(tabs[tab],null,2) });
    }
    files.push({ path:`${base}/${DIR_AUTOSAVE}/${AUTOSAVE_FILE}`, text:JSON.stringify({ schema:'pfxproj_autosave', schemaVersion:1, projectName:proj, updatedAt:nowISO() },null,2) });
    const r2 = await writeViaDownloads(projectName, files);
    try{ window.MPS_auditAdd?.({ type:'PROJECT_AUTOSAVE', intent:'project', files:[`${base}/${DIR_AUTOSAVE}/${AUTOSAVE_FILE}`], note:'Autosave (Downloads fallback)' }); }catch{}
    return r2;
  }catch(err){
    return { ok:false, where:'none', error:String(err?.message||err) };
  }
}

export async function clearUnifiedProjectAutosave(projectName){
  try{
    const root = await getStoredProjectDir();
    if (!root) return { ok:false, reason:'no_dir' };
    const ok = await ensureDirPermission(root);
    if (!ok) return { ok:false, reason:'no_permission' };
    const dirs = await ensureProjectSubdirs(root, projectName);
    if (dirs.autosaveDir.removeEntry){
      await dirs.autosaveDir.removeEntry(AUTOSAVE_FILE);
      return { ok:true };
    }
    return { ok:false, reason:'unsupported' };
  }catch{ return { ok:false, reason:'unsupported' }; }
}

export async function applyUnifiedProjectFile(file){
  // Accept either project.json (manifest) or a single tabs/*.json.
  const text = await readFileAsText(file);
  let obj;
  try{ obj = JSON.parse(text); }catch{ throw new Error('Invalid project JSON.'); }

  // Tab file
  if (obj && obj.schema === 'pfxproj_tab' && obj.tab){
    const tab = String(obj.tab);
    if (tab === 'pull_prep'){ applyPullPrepProjectState(obj?.state ?? null); }
    if (tab === 'cut_diff'){ try{ window.__MPS_CD_SNAPSHOT = obj.state; window.MPS_applyCutDiffSnapshot?.(obj.state); }catch{} }
    if (tab === 'markers'){ try{ window.__MPS_SM_SNAPSHOT = obj.state; window.MPS_applyShotMarkerSnapshot?.(obj.state); }catch{} }
    if (tab === 'plate_link'){
      try{ if (obj.state?.amf != null){ window.__MPS_AMF_STATE = obj.state.amf; window.MPS_applyAMFState?.(obj.state.amf); } }catch{}
      try{ if (obj.state?.amfFile != null) window.__MPS_AMF_FILE_PARSED = obj.state.amfFile; }catch{}
    }
    if (tab === 'imf'){ try{ window.__PFX_IMF_STATE = obj.state; window.PFX_applyIMFState?.(obj.state ?? null); }catch{} }
    if (tab === 'review'){ try{ window.__PFX_REVIEWS_STATE = obj.state; window.PFX_applyReviewsState?.(obj.state); }catch{} }
    if (tab === 'trl_conf'){ try{ window.__PFX_TRL_CONF_STATE = obj.state; window.PFX_applyTrlConfState?.(obj.state ?? null); }catch{} }
    if (tab === 'aces_look'){ try{ window.__PFX_ACES_LOOK_STATE = obj.state; window.PFX_applyAcesLookState?.(obj.state ?? null); }catch{} }
    if (tab === 'settings'){
      try{
        const kv = obj.state?.localStorage || null;
        if (kv && typeof kv === 'object') for (const [k,v] of Object.entries(kv)) localStorage.setItem(k, String(v ?? ''));
      }catch{}
    }
    if (tab === 'shots'){
      try{
        if (obj.state && typeof window.PFX_SWI?.importState === 'function') {
          window.PFX_SWI.importState(obj.state);
        }
        if (obj.state?.ocfRoots != null || obj.state?.ocfIndex != null) {
          if (typeof window.PFX_OCF_INDEX?.importState === 'function') {
            window.PFX_OCF_INDEX.importState({ ocfRoots: obj.state.ocfRoots, ocfIndex: obj.state.ocfIndex });
          }
        }
      }catch{}
    }
    return true;
  }

  // Legacy unified file support
  if (obj && obj.meta && obj.meta.schema === 'mpsproj'){
    applyToApp(obj);
    return true;
  }

  // Manifest alone can't apply without folder context. Best-effort: no-op.
  return true;
}

/* ─── readUnifiedProjectInfo ────────────────────────────────────────────────
   Returns manifest + per-tab last-modified timestamps without applying state.
────────────────────────────────────────────────────────────────────────────── */
export async function readUnifiedProjectInfo(projectName) {
  const pn = sanitizeFilename(projectName);
  if (!pn) return { ok: false, reason: 'bad_name' };
  const root = await getStoredProjectDir();
  if (!root) return { ok: false, reason: 'no_dir' };
  const ok = await ensureDirPermission(root);
  if (!ok) return { ok: false, reason: 'no_permission' };

  let pfxDir, projDir, tabsDir;
  try { pfxDir = await root.getDirectoryHandle(PFX_ROOT_DIR, { create: false }); } catch { return { ok: false, reason: 'not_found' }; }
  try { projDir = await pfxDir.getDirectoryHandle(pn, { create: false }); } catch { return { ok: false, reason: 'not_found' }; }
  try { tabsDir = await projDir.getDirectoryHandle(DIR_TABS, { create: false }); } catch { tabsDir = null; }

  let manifest = null;
  try {
    const mfh = await projDir.getFileHandle(PROJECT_MANIFEST, { create: false });
    const mf = await mfh.getFile();
    manifest = JSON.parse(await mf.text());
  } catch { /* ignore */ }

  const tabs = {};
  if (tabsDir) {
    for await (const [name, handle] of tabsDir.entries()) {
      if (handle?.kind !== 'file') continue;
      try {
        const f = await handle.getFile();
        tabs[name] = { size: f.size, lastModified: f.lastModified };
      } catch { /* ignore */ }
    }
  }

  return { ok: true, projectName: pn, manifest, tabs };
}

/* ─── renameUnifiedProjectByName ────────────────────────────────────────────
   Copies all files under PFX/<oldName>/ to PFX/<newName>/ then deletes old.
────────────────────────────────────────────────────────────────────────────── */
export async function renameUnifiedProjectByName(oldName, newName) {
  const src = sanitizeFilename(oldName);
  const dst = sanitizeFilename(newName);
  if (!src || !dst || src === dst) return { ok: false, reason: 'bad_name' };

  const root = await getStoredProjectDir();
  if (!root) return { ok: false, reason: 'no_dir' };
  const ok = await ensureDirPermission(root);
  if (!ok) return { ok: false, reason: 'no_permission' };

  let pfxDir;
  try { pfxDir = await root.getDirectoryHandle(PFX_ROOT_DIR, { create: false }); } catch { return { ok: false, reason: 'not_found' }; }

  // Ensure dst doesn't exist
  try { await pfxDir.getDirectoryHandle(dst, { create: false }); return { ok: false, reason: 'dest_exists' }; } catch { /* ok */ }

  const cloneResult = await _copyProjectDir(pfxDir, src, dst);
  if (!cloneResult.ok) return cloneResult;

  // Update manifest name
  try {
    const dstProjDir = await pfxDir.getDirectoryHandle(dst, { create: false });
    const mfh = await dstProjDir.getFileHandle(PROJECT_MANIFEST, { create: false });
    const mf = await mfh.getFile();
    const manifest = JSON.parse(await mf.text());
    manifest.name = dst;
    if (manifest.meta) manifest.meta.projectName = dst;
    const w = await mfh.createWritable();
    await w.write(JSON.stringify(manifest, null, 2));
    await w.close();
  } catch { /* ignore */ }

  const delResult = await deleteUnifiedProjectByName(src);
  if (!delResult.ok) return { ok: false, reason: 'delete_src_failed', error: delResult.reason };
  return { ok: true, newName: dst };
}

/* ─── cloneUnifiedProjectByName ─────────────────────────────────────────────
   Deep-copies PFX/<sourceName>/ → PFX/<cloneName>/.
────────────────────────────────────────────────────────────────────────────── */
export async function cloneUnifiedProjectByName(sourceName, cloneName) {
  const src = sanitizeFilename(sourceName);
  const dst = sanitizeFilename(cloneName || `${src}_copy`);
  if (!src || !dst) return { ok: false, reason: 'bad_name' };

  const root = await getStoredProjectDir();
  if (!root) return { ok: false, reason: 'no_dir' };
  const ok = await ensureDirPermission(root);
  if (!ok) return { ok: false, reason: 'no_permission' };

  let pfxDir;
  try { pfxDir = await root.getDirectoryHandle(PFX_ROOT_DIR, { create: false }); } catch { return { ok: false, reason: 'not_found' }; }

  return _copyProjectDir(pfxDir, src, dst);
}

async function _copyProjectDir(pfxDir, src, dst) {
  let srcDir;
  try { srcDir = await pfxDir.getDirectoryHandle(src, { create: false }); } catch { return { ok: false, reason: 'not_found' }; }
  let dstDir;
  try { dstDir = await pfxDir.getDirectoryHandle(dst, { create: true }); } catch { return { ok: false, reason: 'create_failed' }; }

  await _copyDirHandle(srcDir, dstDir);
  return { ok: true, cloneName: dst };
}

async function _copyDirHandle(srcDir, dstDir) {
  for await (const [name, handle] of srcDir.entries()) {
    try {
      if (handle?.kind === 'file') {
        const f = await handle.getFile();
        const buf = await f.arrayBuffer();
        const dh = await dstDir.getFileHandle(name, { create: true });
        const w = await dh.createWritable();
        await w.write(buf);
        await w.close();
      } else if (handle?.kind === 'directory') {
        const subDst = await dstDir.getDirectoryHandle(name, { create: true });
        await _copyDirHandle(handle, subDst);
      }
    } catch { /* ignore */ }
  }
}

/* ─── saveProjectTemplate ───────────────────────────────────────────────────
   Saves a template (manifest + tabs snapshot) to PFX/__templates__/<id>.json.
────────────────────────────────────────────────────────────────────────────── */
const TEMPLATES_DIR = '__templates__';

export async function saveProjectTemplate(templateId, templateName, projectName) {
  const tid = sanitizeFilename(templateId || templateName || 'template');
  const root = await getStoredProjectDir();
  if (!root) return { ok: false, reason: 'no_dir' };
  const ok = await ensureDirPermission(root);
  if (!ok) return { ok: false, reason: 'no_permission' };

  let pfxDir, tplDir;
  try { pfxDir = await root.getDirectoryHandle(PFX_ROOT_DIR, { create: true }); } catch { return { ok: false, reason: 'pfx_dir_failed' }; }
  try { tplDir = await pfxDir.getDirectoryHandle(TEMPLATES_DIR, { create: true }); } catch { return { ok: false, reason: 'templates_dir_failed' }; }

  let tabsSnapshot = {};
  try { tabsSnapshot = buildTabsSnapshot(projectName || templateName || 'template'); } catch { /* ignore */ }

  const template = {
    schema: 'pfxproj_template',
    id: tid,
    name: templateName || tid,
    createdAt: nowISO(),
    sourceProject: projectName ? sanitizeFilename(projectName) : null,
    tabs: tabsSnapshot
  };

  try {
    const fh = await tplDir.getFileHandle(`${tid}.json`, { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify(template, null, 2));
    await w.close();
    return { ok: true, id: tid };
  } catch (e) {
    return { ok: false, reason: 'write_failed', error: String(e?.message || e) };
  }
}

/* ─── listProjectTemplates ──────────────────────────────────────────────────
   Returns array of { id, name, createdAt, sourceProject } from template files.
────────────────────────────────────────────────────────────────────────────── */
export async function listProjectTemplates() {
  const root = await getStoredProjectDir();
  if (!root) return { ok: true, templates: [] };
  const ok = await ensureDirPermission(root);
  if (!ok) return { ok: false, reason: 'no_permission' };

  let pfxDir, tplDir;
  try { pfxDir = await root.getDirectoryHandle(PFX_ROOT_DIR, { create: false }); } catch { return { ok: true, templates: [] }; }
  try { tplDir = await pfxDir.getDirectoryHandle(TEMPLATES_DIR, { create: false }); } catch { return { ok: true, templates: [] }; }

  const templates = [];
  for await (const [name, handle] of tplDir.entries()) {
    if (handle?.kind !== 'file' || !name.endsWith('.json')) continue;
    try {
      const f = await handle.getFile();
      const obj = JSON.parse(await f.text());
      if (obj.schema === 'pfxproj_template') {
        templates.push({ id: obj.id, name: obj.name, createdAt: obj.createdAt, sourceProject: obj.sourceProject || null });
      }
    } catch { /* ignore */ }
  }
  templates.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return { ok: true, templates };
}

/* ─── createProjectFromTemplate ─────────────────────────────────────────────
   Creates a new project and restores tab state from a saved template.
────────────────────────────────────────────────────────────────────────────── */
export async function createProjectFromTemplate(templateId, newProjectName) {
  const tid = sanitizeFilename(templateId);
  const pn = sanitizeFilename(newProjectName || `${tid}_project`);
  if (!tid || !pn) return { ok: false, reason: 'bad_name' };

  const root = await getStoredProjectDir();
  if (!root) return { ok: false, reason: 'no_dir' };
  const ok = await ensureDirPermission(root);
  if (!ok) return { ok: false, reason: 'no_permission' };

  let pfxDir, tplDir;
  try { pfxDir = await root.getDirectoryHandle(PFX_ROOT_DIR, { create: false }); } catch { return { ok: false, reason: 'not_found' }; }
  try { tplDir = await pfxDir.getDirectoryHandle(TEMPLATES_DIR, { create: false }); } catch { return { ok: false, reason: 'no_templates' }; }

  let template;
  try {
    const fh = await tplDir.getFileHandle(`${tid}.json`, { create: false });
    const f = await fh.getFile();
    template = JSON.parse(await f.text());
  } catch { return { ok: false, reason: 'template_not_found' }; }

  // Write per-tab files from template snapshot
  let projDir, tabsDir;
  try { projDir = await pfxDir.getDirectoryHandle(pn, { create: true }); } catch { return { ok: false, reason: 'create_failed' }; }
  try { tabsDir = await projDir.getDirectoryHandle(DIR_TABS, { create: true }); } catch { return { ok: false, reason: 'tabs_dir_failed' }; }

  const tabsSnapshot = template.tabs || {};
  for (const [tabKey, tabData] of Object.entries(tabsSnapshot)) {
    const filename = TAB_FILES[tabKey];
    if (!filename) continue;
    try {
      const fh = await tabsDir.getFileHandle(filename, { create: true });
      const w = await fh.createWritable();
      // tabData is already a full pfxproj_tab wrapper produced by wrapTabState();
      // write it as-is rather than re-wrapping it.
      await w.write(JSON.stringify(tabData, null, 2));
      await w.close();
    } catch { /* ignore */ }
  }

  // Write manifest
  const manifest = { ...buildManifest(pn), fromTemplate: tid };
  try {
    const mfh = await projDir.getFileHandle(PROJECT_MANIFEST, { create: true });
    const w = await mfh.createWritable();
    await w.write(JSON.stringify(manifest, null, 2));
    await w.close();
  } catch { /* ignore */ }

  return { ok: true, projectName: pn };
}
