// scripts/features/cutdiff_feature.js
// CUT DIFF UI feature module (extracted from scripts/ui.js)
// -----------------------------------------------------------------------------
// Goal: isolate CUT DIFF tab wiring + state so changes here won't ripple into
// other tabs (EDL Converter / VFX Mapping).

import { createTimeline } from "../../components/timeline/index.js";
import { storeNamedFileHandle, loadNamedFileHandle } from "../../core/projectFile.js";
import { pfxGetHandleFile, pfxAcquireObjectUrl, pfxReleaseObjectUrl } from "../../core/mediaCache.js";
import { setIconButton, setTimelineFitToggleButton } from "../../core/iconButtons.js";
import { resolveShortcutAction, getShortcutsConfig } from "../../core/shortcuts.js";
import { getSeqBaseFrames } from "../../core/timelineModel.js";
import { loadVideoWithProxyFallback, tryRestoreProxyForMeta } from "../../modules/proResProxy.js";
import { sharedMediaOpen } from "../../modules/native_helper_client.js";

export function createCutDiffFeature(deps = {}){
  const {
    // domain / engines
    CutDiff,
    Filters,

    // shared ingestion
    parseFromFiles,
    handleDroppedDataTransfer,
    pickTimelineFiles,
    pickFCPXMLFromBundle,

    // shared helpers
    normalizeOCFReel,
    stemNoExt,
    tcToFrames,
    esc,
    on,
    showError,
    toggleHeartbeat,

    // storage KPI helpers
    estimateStorageForEvents,
    storageFmtGB,

    // export
    buildEDLFiles,
  } = deps;

  // ── Transcode queue (shared across ProRes loads in OLD/NEW source boxes) ──
  const _cdXcodeJobs = new Map();
  let _cdXcodeJobSeq = 0;

  function _cdRegisterXcodeJob(name) {
    const id = ++_cdXcodeJobSeq;
    _cdXcodeJobs.set(id, { name, pct: 0, done: false, error: null });
    _cdRenderXcodePane();
    _cdUpdateXcodeBadge();
    // Auto-switch timeline to transcode tab
    try { _cdSetTimelineMode('transcode'); } catch (_) {}
    return id;
  }

  function _cdUpdateXcodeJob(id, pct, { done = false, error = null } = {}) {
    const j = _cdXcodeJobs.get(id); if (!j) return;
    j.pct = pct; j.done = done; j.error = error;
    _cdRenderXcodePane();
    _cdUpdateXcodeBadge();
  }

  function _cdRenderXcodePane() {
    const el = document.getElementById('cdXcodeList');
    if (!el) return;
    if (_cdXcodeJobs.size === 0) {
      el.innerHTML = '<div class="cd-xcode-empty">No transcodes yet. Load ProRes files as OLD / NEW sources.</div>';
      return;
    }
    const _xesc = typeof esc === 'function' ? esc : (s) => String(s || '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
    el.innerHTML = [..._cdXcodeJobs.values()].reverse().map(j => {
      const pct  = j.done && !j.error ? 100 : j.pct;
      const cls  = j.error ? 'cd-xcode-error' : j.done ? 'cd-xcode-done' : 'cd-xcode-active';
      const stat = j.error ? `✗ ${String(j.error).slice(0, 60)}` : j.done ? '✓ Done' : `${pct}%`;
      return `<div class="cd-xcode-row ${cls}">
        <div class="cd-xcode-name" title="${_xesc(j.name)}">${_xesc(j.name)}</div>
        <div class="cd-xcode-bar-wrap"><div class="cd-xcode-bar" style="width:${pct}%"></div></div>
        <div class="cd-xcode-stat">${_xesc(stat)}</div>
      </div>`;
    }).join('');
  }

  function _cdUpdateXcodeBadge() {
    const active = [..._cdXcodeJobs.values()].filter(j => !j.done).length;
    const badge  = document.getElementById('cdXcodeBadge');
    if (badge) { badge.textContent = active; badge.style.display = active ? '' : 'none'; }
  }

  // --- CUT DIFF local state (no cross-tab globals) ---
  // NLE reverse-playback RAF state (hoisted so clear() can cancel)
  let _cdRevRafId   = null;
  let _cdRevActive  = false;
  // Export menu global listener cleanup (set when export menu is wired)
  let _cdExportMenuCleanup = null;

  const state = {
    oldRaw   : null,
    newRaw   : null,
    oldView  : [],
    newView  : [],
    diff     : [],
    removed  : [],
    analyzed : false,
  };

  const audioCompareState = {
    key: '',
    payload: null,
  };

  // Table sorting (UI only)
  const sortState = {
    // index | type | conf | reel | srcIn | srcOut | recIn | recOut | duration | clipName | status | note
    key: null,
    dir: 1
  };

  // Row selection (keyboard navigation)
  const selState = {
    srcIdx: null, // index into state.diff
    rowPos: 0
  };

  // Smart timeline compare (mini-map)
  const tlState = {
    collapsed: false,
    mode: "compare", // compare | new | old
    segByKey: new Map(), // diffKey -> element (NEW track)
    rowByKey: new Map(), // diffKey -> srcIdx

    // Compare timeline view state (zoom/pan)
    zoom: 1,
    pan: 0,
    _meta: { startF: 0, endF: 0, range: 1 },
    _resizeObs: null,
    _drag: null,
    fitRestore: { compare: null, new: null, old: null },

    // Original timeline views (EDL Converter style)
    orig: {
      old: { api: null, cache: null },
      new: { api: null, cache: null },
    }
  };

  // Diff type filters (shared across table + smart timeline)
  const CD_FILTER_KEY = 'mps.cutdiff.filter.types.v1';
  const filterState = {
    NEW: true,
    EXTENDED: true,
    CHANGED: true,
    REMOVED: true,
  };

  const CD_SHOW_AUDIO_TIMELINE = false;
  const CD_DIFFTL_HEIGHT_STORAGE_KEY = 'mps.cutdiff.difftl.height';
  const CD_DIFFTL_HEIGHT_REV_KEY = 'mps.cutdiff.difftl.height.rev';
  const CD_DIFFTL_HEIGHT_REV = '2026.2.3.32.compare-compact-v1';
  const CD_DIFFTL_ORIG_MIN_HEIGHT = 152;
  const CD_DIFFTL_COMPARE_FALLBACK_HEIGHT = CD_SHOW_AUDIO_TIMELINE ? 182 : 154;

  const __tlUI = {
    root: null,
    body: null,
    title: null,
    btnModeCompare: null,
    btnModeNew: null,
    btnModeOld: null,
    legend: null,
    btnPrev: null,
    btnNext: null,
    overview: null,
    ovTrack: null,
    ovWindow: null,
    viewport: null,
    ruler: null,
    laneOld: null,
    laneNew: null,
    trackOldAudio: null,
    trackNewAudio: null,
    laneOldAudio: null,
    laneNewAudio: null,
    origOld: null,
    origNew: null,
    btnFit: null,
    btnToggle: null,
  };


  function _cdTimelineModeKey(which){
    return (which === 'new' || which === 'old') ? which : 'compare';
  }

  function _cdMeasureCompareTimelineHeight(){
    if (!__tlUI.root || !__tlUI.body) return CD_DIFFTL_COMPARE_FALLBACK_HEIGHT;
    try{
      const rootCS = window.getComputedStyle(__tlUI.root);
      const padTop = parseFloat(rootCS.paddingTop) || 0;
      const padBottom = parseFloat(rootCS.paddingBottom) || 0;
      const head = __tlUI.root.querySelector('.cd-difftl-head');
      const headCS = head ? window.getComputedStyle(head) : null;
      const headH = head?.getBoundingClientRect?.().height || 0;
      const headMB = headCS ? (parseFloat(headCS.marginBottom) || 0) : 0;
      const bodyH = __tlUI.body.scrollHeight || __tlUI.body.getBoundingClientRect?.().height || 0;
      return Math.max(CD_DIFFTL_COMPARE_FALLBACK_HEIGHT, Math.ceil(padTop + padBottom + headH + headMB + bodyH));
    }catch{
      return CD_DIFFTL_COMPARE_FALLBACK_HEIGHT;
    }
  }

  function _cdTimelineMinHeight(mode = tlState.mode){
    return _cdTimelineModeKey(mode) === 'compare' ? _cdMeasureCompareTimelineHeight() : CD_DIFFTL_ORIG_MIN_HEIGHT;
  }

  function _cdApplyTimelineRootHeight(height, opts = {}){
    if (!__tlUI.root) return;
    const mode = _cdTimelineModeKey(opts.mode || tlState.mode);
    const minH = Math.max(120, Math.round(_cdTimelineMinHeight(mode)));
    const next = Math.max(minH, Math.round(Number(height) || 0));
    __tlUI.root.style.minHeight = `${minH}px`;
    __tlUI.root.style.height = `${next}px`;
    if (opts.skipSave) return;
    try{
      localStorage.setItem(CD_DIFFTL_HEIGHT_STORAGE_KEY, String(next));
      localStorage.setItem(CD_DIFFTL_HEIGHT_REV_KEY, CD_DIFFTL_HEIGHT_REV);
    }catch{}
  }

  function _cdRestoreTimelineRootHeight(){
    if (!__tlUI.root) return;
    const mode = _cdTimelineModeKey(tlState.mode);
    const minH = Math.max(120, Math.round(_cdTimelineMinHeight(mode)));
    let next = minH;
    try{
      const saved = Number(localStorage.getItem(CD_DIFFTL_HEIGHT_STORAGE_KEY));
      const rev = localStorage.getItem(CD_DIFFTL_HEIGHT_REV_KEY);
      if (rev === CD_DIFFTL_HEIGHT_REV && Number.isFinite(saved) && saved >= minH){
        next = Math.round(saved);
      }
    }catch{}
    _cdApplyTimelineRootHeight(next, { mode });
  }

  function _cdSyncTimelineRootHeight(opts = {}){
    if (!__tlUI.root) return;
    const mode = _cdTimelineModeKey(opts.mode || tlState.mode);
    const minH = Math.max(120, Math.round(_cdTimelineMinHeight(mode)));
    const curH = __tlUI.root.getBoundingClientRect?.().height || Number.parseFloat(__tlUI.root.style.height) || 0;
    let rev = '';
    try{ rev = localStorage.getItem(CD_DIFFTL_HEIGHT_REV_KEY) || ''; }catch{}
    if (!!opts.forceCompact || rev !== CD_DIFFTL_HEIGHT_REV || !Number.isFinite(curH) || curH < minH){
      _cdApplyTimelineRootHeight(minH, { mode, skipSave: !!opts.skipSave });
      return;
    }
    __tlUI.root.style.minHeight = `${minH}px`;
  }

  function _cdCaptureTimelineView(which = tlState.mode){
    const w = _cdTimelineModeKey(which);
    if (w === 'compare'){
      return {
        zoom: Math.max(1, Math.min(50, Number(tlState.zoom) || 1)),
        pan: Math.max(0, Math.min(1, Number(tlState.pan) || 0))
      };
    }
    const api = tlState.orig?.[w]?.api;
    return api?.getViewState?.() || { zoom: 1, pan: 0 };
  }

  function _cdIsTimelineFit(which = tlState.mode){
    const view = _cdCaptureTimelineView(which);
    return Math.abs((Number(view.zoom) || 1) - 1) < 0.01 && Math.abs(Number(view.pan) || 0) < 0.01;
  }

  function _cdSyncTimelineFitBtn(){
    if (!__tlUI.btnFit) return;
    try{
      setTimelineFitToggleButton(__tlUI.btnFit, _cdIsTimelineFit(), {
        fitLabel: 'Fit timeline to view',
        unfitLabel: 'Unfit timeline'
      });
    }catch{}
  }

  function _cdSetCompareView(view, opts = {}){
    const v = view || { zoom: 1, pan: 0 };
    tlState.zoom = Math.max(1, Math.min(50, Number(v.zoom) || 1));
    tlState.pan = Math.max(0, Math.min(1, Number(v.pan) || 0));
    try{ localStorage.setItem('mps.cutdiff.difftl.zoom', String(tlState.zoom)); }catch{}
    try{ localStorage.setItem('mps.cutdiff.difftl.pan', String(tlState.pan)); }catch{}
    if (opts.rerender !== false) renderDiffTimeline(!!opts.force);
    else _cdSyncTimelineFitBtn();
  }

  function _cdSetOrigView(which, view, opts = {}){
    const w = _cdTimelineModeKey(which);
    renderOrigTimeline(w, { force:false, skipScrollToSelection:true });
    const api = tlState.orig?.[w]?.api;
    try{ api?.setViewState?.(view || { zoom: 1, pan: 0 }); }catch{}
    if (opts.scrollFrame != null) {
      try{ api?.scrollToFrame?.(Number(opts.scrollFrame) || 0); }catch{}
    }
    _cdSyncTimelineFitBtn();
  }

  function _cdToggleTimelineFit(){
    const w = _cdTimelineModeKey(tlState.mode);
    if (_cdIsTimelineFit(w)){
      const prev = tlState.fitRestore?.[w];
      const restore = (prev && ((Number(prev.zoom) || 1) > 1.01 || (Number(prev.pan) || 0) > 0.01))
        ? prev
        : { zoom: 1.35, pan: 0 };
      if (w === 'compare') _cdSetCompareView(restore, { rerender:true });
      else _cdSetOrigView(w, restore);
      return;
    }

    tlState.fitRestore[w] = _cdCaptureTimelineView(w);
    if (w === 'compare') _cdSetCompareView({ zoom: 1, pan: 0 }, { rerender:true, force:true });
    else _cdSetOrigView(w, { zoom: 1, pan: 0 });
  }

  // ---------------------------------------------------------------------------
  // Video Compare (EditHero-style in-frame compare)
  // ---------------------------------------------------------------------------
  const vcState = {
    enabled: true,
    mode: 'wipe', // wipe | sbs | split | ab | diff | heat
    wipe: 0.5,
    showA: true,
    fit: 'contain', // contain | cover
    rate: 1.0,
    _scrubbing: false,
    loop: false,
    audio: false,
    cleanFeed: false,
    chain: true,
    chainOffsetF: 0,
    profile: null, // {startF,endF,values,max}
    _scanId: 0,
    _scanT: 0,
    _scanOld: null,
    _scanNew: null,
    _scanReadyOld: false,
    _scanReadyNew: false,
    oldUrl: '',
    newUrl: '',
    oldName: '',
    newName: '',
    oldStartTc: '00:00:00:00',
    newStartTc: '00:00:00:00',
    _oldStartF: 0,
    _newStartF: 0,
    _userStartOld: false,
    _userStartNew: false,
    _autoOldStartTc: '',
    _autoNewStartTc: '',
    _readyOld: false,
    _readyNew: false,
    _raf: 0,
    _lastHud: '',
    _loopRange: null, // {startF,endF}
    _offA: null,
    _offB: null,
  };

  const __vcUI = {
    card: null,
    body: null,
    btnToggle: null,
    inpOld: null,
    inpNew: null,
    btnOld: null,
    btnNew: null,
    tcOld: null,
    tcNew: null,
    scrub: null,
    probar: null,
    btnFull: null,
    btnFit: null,
    btnPlay: null,
    btnPrevF: null,
    btnNextF: null,
    btnLoop: null,
    btnAudio: null,
    btnChain: null,
    btnHome: null,
    btnEnd: null,
    btnBack10: null,
    btnFwd10: null,
    selRate: null,
    inpTc: null,
    btnCleanFeed: null,
    modes: null,
    wipe: null,
    view: null,
    canvas: null,
    diffGraph: null,
    hud: null,
    vidOld: null,
    vidNew: null,
  };

  // Video Compare persistence (remember last OLD/NEW videos across refresh + per-project)
  const CD_VCMP_OLD_NAME_KEY = 'mps.cutdiff.vcmp.oldName.v1';
  const CD_VCMP_NEW_NAME_KEY = 'mps.cutdiff.vcmp.newName.v1';

  function __cdBaseName(path){
    const s = String(path || '').trim();
    if (!s) return '';
    const parts = s.split(/[\\/]/);
    return parts[parts.length - 1] || s;
  }
  function __cdStripExt(name){
    return String(name || '').trim().replace(/\.[A-Za-z0-9]{2,5}$/,'');
  }
  function __cdSafeKey(s){
    return String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g,'')
      .slice(0, 96);
  }
  function __cdVcmpHandleKey(which, name){
    const base = __cdStripExt(__cdBaseName(name));
    const k = __cdSafeKey(base || name);
    return k ? (`cd.vcmp.${which}.${k}`) : (`cd.vcmp.${which}`);
  }

  function _vcRememberName(which, name){
    const n = String(name || '').trim();
    if (!n) return;
    if (which === 'old') vcState.oldName = n;
    else vcState.newName = n;
    try{ localStorage.setItem(which === 'old' ? CD_VCMP_OLD_NAME_KEY : CD_VCMP_NEW_NAME_KEY, n); }catch{}
  }

  function _vcGetRememberedName(which){
    const v = (which === 'old') ? vcState.oldName : vcState.newName;
    if (v) return String(v).trim();
    try{
      return String(localStorage.getItem(which === 'old' ? CD_VCMP_OLD_NAME_KEY : CD_VCMP_NEW_NAME_KEY) || '').trim();
    }catch{ return ''; }
  }

  async function _vcTryOpenFromPersistedHandle(which, name){
    try{
      if (!name) return false;
      const key = __cdVcmpHandleKey(which, name);
      const fh = await loadNamedFileHandle(key);
      if (!fh) return false;
      const f = await pfxGetHandleFile(fh);
      if (!f) return false;
      // Keep handle stored (refresh-safe)
      try{ await storeNamedFileHandle(__cdVcmpHandleKey(which, f.name || name), fh); }catch{}
      _vcLoad(which, f, { fromRestore:true });
      return true;
    }catch{ return false; }
  }

  async function _vcTryRelinkFromMediaRoot(which, name){
    try{
      if (!name) return false;
      const finder = window.__PFX_MEDIA_FIND;
      const hit = (typeof finder === 'function') ? finder(name) : null;
      const fh = hit?.handle;
      if (!fh) return false;

      // Non-intrusive: only relink automatically if permission is already granted.
      try{
        if (fh.queryPermission){
          const q = await fh.queryPermission({ mode:'read' });
          if (q !== 'granted') return false;
        }
      }catch{ return false; }

      const f = await pfxGetHandleFile(fh);
      if (!f) return false;
      try{ await storeNamedFileHandle(__cdVcmpHandleKey(which, name), fh); }catch{}
      _vcLoad(which, f, { fromRestore:true });
      return true;
    }catch{ return false; }
  }

  async function _vcRestoreRemembered(){
    try{
      const oldName = _vcGetRememberedName('old');
      const newName = _vcGetRememberedName('new');
      if (oldName) {
        const ok = await _vcTryOpenFromPersistedHandle('old', oldName);
        if (!ok) await _vcTryRelinkFromMediaRoot('old', oldName);
      }
      if (newName) {
        const ok = await _vcTryOpenFromPersistedHandle('new', newName);
        if (!ok) await _vcTryRelinkFromMediaRoot('new', newName);
      }
      // Proxy-only restore: if file handles not available but proxy was transcoded before
      for (const which of ['old', 'new']) {
        const alreadyLoaded = which === 'old' ? !!vcState.oldUrl : !!vcState.newUrl;
        if (alreadyLoaded) continue;
        const fm = which === 'old' ? state.oldRaw?.fileMeta : state.newRaw?.fileMeta;
        if (!fm?.name || !fm.size || !fm.lastModified) continue;
        try{
          const proxy = await tryRestoreProxyForMeta(fm);
          if (!proxy?.url) continue;
          const v = (which === 'old') ? __vcUI.vidOld : __vcUI.vidNew;
          if (!v) continue;
          if (which === 'old') { vcState.oldUrl = proxy.url; vcState._readyOld = false; }
          else                 { vcState.newUrl = proxy.url; vcState._readyNew = false; }
          v.src = proxy.url;
          try{ if (which === 'old' && __vcUI.nameOld) __vcUI.nameOld.textContent = fm.name; }catch{}
          try{ if (which === 'new' && __vcUI.nameNew) __vcUI.nameNew.textContent = fm.name; }catch{}
        }catch{}
      }
    }catch{}
  }

  let mounted = false;
  let wiredKeyboard = false;
  let wiredSorting = false;

  // ---------------------------------------------------------------------------
  // Project system (multi-project + save/load + auto-restore)
  // ---------------------------------------------------------------------------
  const CD_PROJECTS_INDEX_KEY = "mps.cutdiff.projects.index.v1";
  const CD_PROJECT_KEY_PREFIX = "mps.cutdiff.project.";
  const CD_AUTOSAVE_DEBOUNCE_MS = 1200;

  let __cdProjectIndex = null; // { activeId, projects:[{id,name,createdAt,updatedAt}] }
  let __cdActiveProjectId = null;
  let __cdDirty = false;
  let __cdAutosaveT = 0;
  let __cdApplyingProject = false;

  const __cdUI = {
    sel: null,
    btnNew: null,
    btnRename: null,
    btnDelete: null,
    btnSave: null,
    btnSaveAs: null,
    btnLoad: null,
    fileInput: null,
    status: null,
  };

  function _cdHasStorage(){
    try{ return !!(globalThis.chrome && chrome.storage && chrome.storage.local); }catch{ return false; }
  }
  function _cdStorageGet(key){
    return new Promise((resolve) => {
      if (!_cdHasStorage()) return resolve(null);
      try{ chrome.storage.local.get([key], (res) => resolve(res ? res[key] : null)); }
      catch{ resolve(null); }
    });
  }
  function _cdStorageSet(obj){
    return new Promise((resolve) => {
      if (!_cdHasStorage()) return resolve(false);
      try{ chrome.storage.local.set(obj, () => resolve(true)); }
      catch{ resolve(false); }
    });
  }
  function _cdNowISO(){
    try{ return new Date().toISOString(); }catch{ return String(Date.now()); }
  }
  async function _cdFileMeta(file){
    if (!file) return null;
    const meta = {
      name: file.name || '',
      size: Number(file.size || 0),
      lastModified: Number(file.lastModified || 0),
      importedAt: _cdNowISO(),
      sha256: ''
    };
    try{
      // NOTE: Avoid optional chaining for compatibility with older Chrome builds.
      const hasCrypto = (typeof crypto !== 'undefined') && crypto && crypto.subtle && (typeof crypto.subtle.digest === 'function');
      const hasArrayBuffer = file && (typeof file.arrayBuffer === 'function');
      if (hasCrypto && hasArrayBuffer){
        const buf = await file.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', buf);
        const bytes = new Uint8Array(hash);
        let hex = '';
        for (let i = 0; i < bytes.length; i++){
          hex += bytes[i].toString(16).padStart(2, '0');
        }
        meta.sha256 = hex;
      }
    }catch{}
    return meta;
  }

  function _cdShortHash(h){
    const s = String(h || '');
    return s ? (s.slice(0, 10) + '…') : '—';
  }

  function _cdFmtBytes(n){
    const v = Number(n || 0);
    if (!Number.isFinite(v) || v <= 0) return '0 B';
    const units = ['B','KB','MB','GB'];
    let x=v, i=0;
    while(x>=1024 && i<units.length-1){ x/=1024; i++; }
    return `${x.toFixed(i?1:0)} ${units[i]}`;
  }

  function _cdFmtDate(ms){
    const t = Number(ms||0);
    if (!Number.isFinite(t) || t<=0) return '';
    try{ return new Date(t).toLocaleString(); }catch{ return String(t); }
  }

  function _cdRenderCompareLock(){
    const host = document.getElementById('cutdiffCompareLock');
    if (!host) return;
    const o = state.oldRaw;
    const n = state.newRaw;
    if (!o && !n){
      host.innerHTML = '<div class="muted" style="font-size:12px;">No cuts loaded.</div>';
      return;
    }
    const fps = _cdGetFps();
    const oMeta = o?.fileMeta || null;
    const nMeta = n?.fileMeta || null;
    const left = (label, raw, meta) => {
      const proj = (raw?.projectName || label).trim();
      const file = (meta?.name || '').trim();
      const hash = _cdShortHash(meta?.sha256);
      const size = _cdFmtBytes(meta?.size);
      const mod  = _cdFmtDate(meta?.lastModified);
      const imp  = _cdFmtDate(Date.parse(meta?.importedAt || '') || 0);
      const main = `${proj}${file ? ' • ' + file : ''}`;
      const sub  = `${size}${hash && hash !== '—' ? ' • ' + hash : ''}${mod ? ' • mtime ' + mod : ''}`;
      return `
        <div class="cd-lock-side">
          <div class="cd-lock-label">${label}</div>
          <div class="cd-lock-main" title="${(typeof esc==='function')?esc(main):main}">${(typeof esc==='function')?esc(main):main}</div>
          <div class="cd-lock-sub">${(typeof esc==='function')?esc(sub):sub}</div>
        </div>`;
    };

    const warn = (!oMeta?.sha256 || !nMeta?.sha256) ? '<div class="cd-lock-warn">Tip: SHA-256 is unavailable in this browser context. (Still safe—just no checksum.)</div>' : '';

    host.innerHTML = `
      <div class="cd-lock-row">
        ${left('OLD', o, oMeta)}
        ${left('NEW', n, nMeta)}
      </div>
      <!-- FPS removed for compact KPI -->
      ${warn}`;
  }

  function _cdId(){
    return "p_" + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
  }

  function _cdSetProjectStatus(msg){
    if (__cdUI.status) __cdUI.status.textContent = msg || "—";
  }

  function _cdSafeHtml(v){
    const clean = _cdCleanText(v);
    return (typeof esc === 'function') ? esc(clean) : clean;
  }

  function _cdAudioMetaNone(reason = 'Audio n/a'){
    return {
      available: false,
      trackCount: 0,
      clipCount: 0,
      source: '',
      reason: reason || 'No embedded audio metadata'
    };
  }

  function _cdAudioCountFromTrackToken(tok){
    const s = String(tok || '').toUpperCase().trim();
    if (!s || s.indexOf('A') === -1) return 0;
    if (/^A\d+$/.test(s)) return Math.max(1, parseInt(s.slice(1), 10) || 1);
    const digitMatch = s.match(/A(\d+)/);
    if (digitMatch && digitMatch[1]) return Math.max(1, parseInt(digitMatch[1], 10) || 1);
    const aCount = (s.match(/A/g) || []).length;
    return Math.max(1, aCount || 1);
  }

  function _cdAudioMetaFromEDLText(txt){
    const lines = String(txt || '').split(String.fromCharCode(10));
    let clipCount = 0;
    let trackCount = 0;
    const evRe = new RegExp('^\\s*\\d{3,}\\b');
    for (const line of lines){
      const trimmed = String(line || '').replace(/\\r/g, '').trim();
      if (!evRe.test(trimmed)) continue;
      const parts = trimmed.split(/\\s+/);
      if (parts.length < 3) continue;
      const trackTok = String(parts[2] || '').toUpperCase();
      if (trackTok.indexOf('A') === -1) continue;
      clipCount += 1;
      trackCount = Math.max(trackCount, _cdAudioCountFromTrackToken(trackTok));
    }
    if (!clipCount) return _cdAudioMetaNone('No audio events found in EDL');
    return {
      available: true,
      trackCount: Math.max(1, trackCount || 1),
      clipCount,
      source: 'edl',
      reason: ''
    };
  }

  function _cdAudioMetaFromOtioText(txt){
    let obj = null;
    try{ obj = JSON.parse(String(txt || '{}')); }catch{ return _cdAudioMetaNone('OTIO audio metadata unavailable'); }
    let trackCount = 0;
    let clipCount = 0;
    const seen = new Set();
    function walk(node, inAudioTrack){
      if (!node || typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);
      const schema = String(node.OTIO_SCHEMA || node.schema_name || '').toLowerCase();
      const kind = String(node.kind || node.track_kind || '').toLowerCase();
      const isTrack = schema.indexOf('track') !== -1;
      const isAudioTrack = isTrack && kind === 'audio';
      const nextAudio = !!(inAudioTrack || isAudioTrack);
      if (isAudioTrack) trackCount += 1;
      if (nextAudio && schema.indexOf('clip') !== -1) clipCount += 1;
      for (const key of Object.keys(node)){
        const val = node[key];
        if (Array.isArray(val)){
          for (const child of val) walk(child, nextAudio);
        } else if (val && typeof val === 'object'){
          walk(val, nextAudio);
        }
      }
    }
    walk(obj, false);
    if (!trackCount && !clipCount) return _cdAudioMetaNone('No audio tracks found in OTIO');
    return {
      available: true,
      trackCount: Math.max(1, trackCount || (clipCount ? 1 : 0)),
      clipCount,
      source: 'otio',
      reason: ''
    };
  }

  function _cdAudioMetaFromXmlText(txt, kind){
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(txt || ''), 'application/xml');
    const rootTag = String(doc?.documentElement?.tagName || '').toLowerCase();
    const xmlKind = String(kind || '').toLowerCase();

    if (doc.querySelector('parsererror')){
      return _cdAudioMetaNone('Unable to read XML audio metadata');
    }

    if (xmlKind === 'fcpxml' || rootTag === 'fcpxml'){
      const audioNodes = Array.from(doc.querySelectorAll('audio'));
      if (!audioNodes.length) return _cdAudioMetaNone('No audio clips found in FCPXML');
      const lanes = new Set();
      for (const node of audioNodes){
        let lane = '';
        try{ lane = String(node.getAttribute('lane') || node.parentElement?.getAttribute?.('lane') || ''); }catch{}
        lane = lane.trim();
        lanes.add(lane || '0');
      }
      return {
        available: true,
        trackCount: Math.max(1, lanes.size || 1),
        clipCount: audioNodes.length,
        source: 'fcpxml',
        reason: ''
      };
    }

    const trackNodes = Array.from(doc.querySelectorAll('sequence > media > audio > track, media > audio > track, audio > track'));
    const clipCount = Array.from(doc.querySelectorAll('sequence > media > audio > track > clipitem, media > audio > track > clipitem, audio track clipitem')).length;
    if (!trackNodes.length && !clipCount) return _cdAudioMetaNone('No audio tracks found in XML timeline');
    return {
      available: true,
      trackCount: Math.max(1, trackNodes.length || (clipCount ? 1 : 0)),
      clipCount,
      source: 'xml',
      reason: ''
    };
  }

  async function _cdExtractAudioMeta(file){
    if (!file) return _cdAudioMetaNone('No file selected');
    const name = String(file.name || '').toLowerCase();
    try{
      const txt = await file.text();
      if (name.endsWith('.fcpxml')) return _cdAudioMetaFromXmlText(txt, 'fcpxml');
      if (name.endsWith('.xml')) return _cdAudioMetaFromXmlText(txt, 'xml');
      if (name.endsWith('.otio') || name.endsWith('.json')) return _cdAudioMetaFromOtioText(txt);
      if (name.endsWith('.edl')) return _cdAudioMetaFromEDLText(txt);
      if (name.endsWith('.ale')) return _cdAudioMetaNone('ALE has no timeline audio layout');
    }catch(err){
      return _cdAudioMetaNone(err?.message || 'Audio metadata unavailable');
    }
    return _cdAudioMetaNone('Audio metadata unavailable');
  }

  function _cdAudioSummaryText(meta, opts = {}){
    const compact = !!opts.compact;
    const m = meta && typeof meta === 'object' ? meta : _cdAudioMetaNone();
    const tracks = Math.max(0, Number(m.trackCount) || 0);
    const clips = Math.max(0, Number(m.clipCount) || 0);
    if (m.available){
      return compact
        ? `A${tracks || 1} / ${clips}`
        : `Tracks ${tracks || 1} • Clips ${clips}`;
    }
    return compact ? 'Audio n/a' : (m.reason || 'Audio n/a');
  }

  function _cdAudioCompareLabel(oldMeta, newMeta){
    const oldAvail = !!oldMeta?.available;
    const newAvail = !!newMeta?.available;
    if (!oldAvail && !newAvail) return 'Audio status: unavailable from the imported timelines';
    if (oldAvail && newAvail){
      const dt = (Number(newMeta.trackCount) || 0) - (Number(oldMeta.trackCount) || 0);
      const dc = (Number(newMeta.clipCount) || 0) - (Number(oldMeta.clipCount) || 0);
      if (!dt && !dc) return 'Audio status: same track/clip count in OLD and NEW';
      const fmt = (n, suffix) => `${n >= 0 ? '+' : ''}${n}${suffix}`;
      return `Audio status: changed (${fmt(dt, 'T')} / ${fmt(dc, 'C')})`;
    }
    return oldAvail ? 'Audio status: only OLD has embedded audio metadata' : 'Audio status: only NEW has embedded audio metadata';
  }

  function _cdBuildLoadedStatus(raw, fallbackLabel){
    if (!raw?.events?.length && !raw?.projectName) return 'No cut loaded.';
    const name = raw?.projectName || fallbackLabel || 'CUT';
    const count = Number(raw?.viewCount) || (Array.isArray(raw?.events) ? raw.events.length : 0);
    const audioText = _cdAudioSummaryText(raw?.audioMeta, { compact: true });
    return `Loaded: ${name} (${count} events${audioText ? ' • ' + audioText : ''})`;
  }


  function _cdStemLike(value){
    const raw = String(value || '').trim();
    if (!raw) return '';
    try{
      if (typeof stemNoExt === 'function') return stemNoExt(raw);
    }catch{}
    return raw.replace(/[?#].*$/, '').replace(/^.*[\/]/, '').replace(/\.[^.]+$/, '');
  }

  function _cdBaseFileName(value){
    const raw = String(value || '').trim();
    if (!raw) return '';
    let s = raw;
    try{ s = decodeURIComponent(s); }catch{}
    s = s.replace(/^file:\/+/i, '');
    s = s.replace(/\\/g, '/').replace(/[?#].*$/, '');
    const leaf = s.split('/').pop() || raw.split(/[\\/]/).pop() || raw;
    return String(leaf || '').trim();
  }

  function _cdAudioLaneToIndex(lane){
    const raw = String(lane == null ? '' : lane).trim();
    if (!raw) return 0;
    const num = parseInt(raw, 10);
    if (Number.isFinite(num)){
      if (num === 0) return 0;
      return Math.max(0, Math.abs(num) - 1);
    }
    const m = raw.match(/-?\d+/);
    if (m) return Math.max(0, Math.abs(parseInt(m[0], 10) || 0) - 1);
    return 0;
  }

  function _cdAudioTrackTokenToIndex(tok){
    const s = String(tok || '').toUpperCase().trim();
    if (!s) return 0;
    const m = s.match(/A\s*(\d+)/);
    if (m && m[1]) return Math.max(0, (parseInt(m[1], 10) || 1) - 1);
    const all = s.match(/(\d+)/g);
    if (all && all.length) return Math.max(0, (parseInt(all[0], 10) || 1) - 1);
    return 0;
  }

  function _cdAudioTrackLabel(idx){
    const n = Math.max(0, Number(idx) || 0);
    return `A${n + 1}`;
  }

  function _cdAudioRangeOverlap(a0, a1, b0, b1){
    const aa = Number(a0) || 0;
    const ab = Number(a1) || 0;
    const ba = Number(b0) || 0;
    const bb = Number(b1) || 0;
    return Math.max(0, Math.min(ab, bb) - Math.max(aa, ba));
  }

  function _cdAudioLabelKey(ev){
    return String(ev?.clipName || ev?.reel || ev?.srcFile || '').trim().toUpperCase();
  }

  function _cdAudioIdentity(ev){
    return [
      _cdAudioLabelKey(ev),
      String(ev?.reel || '').trim().toUpperCase(),
      String(ev?.srcIn || ''),
      String(ev?.srcOut || ''),
      String(ev?.recIn || ''),
      String(ev?.recOut || ''),
      Math.max(0, Number(ev?.trackIndex) || 0)
    ].join('|');
  }

  function _cdAudioClipFromFrames(data, fps){
    const rate = Math.max(1, Number(fps) || _cdGetFps() || 24);
    const recInF = Math.max(0, Math.round(Number(data?.recInF) || 0));
    let recOutF = Math.round(Number(data?.recOutF) || 0);
    if (!Number.isFinite(recOutF) || recOutF <= recInF) recOutF = recInF + 1;
    const srcInF = Math.max(0, Math.round(Number(data?.srcInF) || 0));
    let srcOutF = Math.round(Number(data?.srcOutF) || 0);
    if (!Number.isFinite(srcOutF) || srcOutF <= srcInF) srcOutF = srcInF + Math.max(1, recOutF - recInF);
    const trackIndex = Math.max(0, Number(data?.trackIndex) || 0);
    const srcFile = String(data?.srcFile || data?.clipName || data?.reel || `Audio_${trackIndex + 1}`).trim();
    const reel = String(data?.reel || _cdStemLike(srcFile) || _cdStemLike(data?.clipName) || srcFile || `AUDIO_${trackIndex + 1}`).trim();
    const clipName = String(data?.clipName || data?.name || reel || srcFile || `Audio ${trackIndex + 1}`).trim();
    return {
      clipName,
      srcFile,
      reel,
      srcIn: _cdFramesToTC(srcInF, rate),
      srcOut: _cdFramesToTC(srcOutF, rate),
      recIn: _cdFramesToTC(recInF, rate),
      recOut: _cdFramesToTC(recOutF, rate),
      fps: rate,
      role: 'audio',
      type: 'audio',
      kind: 'audio',
      trackType: 'audio',
      trackIndex,
      trackLabel: String(data?.trackLabel || _cdAudioTrackLabel(trackIndex)),
      sourceType: String(data?.sourceType || 'audio')
    };
  }

  function _cdAudioDedupe(events){
    const out = [];
    const seen = new Set();
    for (const ev of (events || [])){
      if (!ev || typeof ev !== 'object') continue;
      const key = [
        String(ev.clipName || ''),
        String(ev.reel || ''),
        String(ev.srcIn || ''),
        String(ev.srcOut || ''),
        String(ev.recIn || ''),
        String(ev.recOut || ''),
        Math.max(0, Number(ev.trackIndex) || 0)
      ].join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ev);
    }
    return out;
  }

  function _cdAudioMetaFromEvents(events, source, fallbackReason = 'No embedded audio metadata'){
    const list = Array.isArray(events) ? events : [];
    if (!list.length) return _cdAudioMetaNone(fallbackReason);
    const lanes = new Set();
    for (const ev of list){
      lanes.add(Math.max(0, Number(ev?.trackIndex) || 0));
    }
    return {
      available: true,
      trackCount: Math.max(1, lanes.size || 1),
      clipCount: list.length,
      source: String(source || ''),
      reason: ''
    };
  }

  function _cdFallbackAudioEventsFromParsed(parsed, sourceType = 'timeline-derived'){
    const list = Array.isArray(parsed?.events) ? parsed.events : (Array.isArray(parsed) ? parsed : []);
    if (!list.length) return [];
    const rate = Math.max(1, Number(parsed?.fps) || _cdGetFps() || 24);
    const out = [];
    for (const raw of list){
      const ev = raw && typeof raw === 'object' ? raw : null;
      if (!ev) continue;
      if (String(ev?.role || '').toLowerCase() === 'audio') continue;
      if (ev?.isTitle || ev?.isGenerator) continue;
      const type = String(ev?.type || '').toLowerCase();
      const subtype = String(ev?.subtype || '').toLowerCase();
      if (type === 'title' || subtype === 'generator') continue;
      const recIn = String(ev?.recIn || '').trim();
      const recOut = String(ev?.recOut || '').trim();
      if (!recIn || !recOut) continue;
      const recInF = _cdTcNum(recIn, rate);
      const recOutF = _cdTcNum(recOut, rate);
      if (!Number.isFinite(recInF) || !Number.isFinite(recOutF) || recOutF <= recInF) continue;
      let srcInF = _cdTcNum(ev?.srcIn || '', rate);
      let srcOutF = _cdTcNum(ev?.srcOut || '', rate);
      if (!Number.isFinite(srcInF)) srcInF = 0;
      if (!Number.isFinite(srcOutF) || srcOutF <= srcInF) srcOutF = srcInF + Math.max(1, recOutF - recInF);
      const clipName = String(ev?.clipName || ev?.srcFile || ev?.reel || '').trim();
      const srcFile = String(ev?.srcFile || ev?.clipName || ev?.reel || clipName || '').trim();
      const reel = String(ev?.reel || _cdStemLike(srcFile || clipName) || clipName || '').trim();
      if (!clipName && !srcFile && !reel) continue;
      out.push({
        clipName: clipName || reel || srcFile || `Audio ${out.length + 1}`,
        srcFile: srcFile || clipName || reel || `Audio_${out.length + 1}`,
        reel: reel || _cdStemLike(srcFile || clipName) || `AUDIO_${out.length + 1}`,
        srcIn: _cdFramesToTC(srcInF, rate),
        srcOut: _cdFramesToTC(srcOutF, rate),
        recIn,
        recOut,
        fps: rate,
        role: 'audio',
        type: 'audio',
        kind: 'audio',
        trackType: 'audio',
        trackIndex: 0,
        trackLabel: _cdAudioTrackLabel(0),
        sourceType: String(sourceType || 'timeline-derived'),
        derivedFromVideo: true
      });
    }
    return _cdAudioDedupe(out);
  }


  function _cdAudioTrackStats(events, fps){
    const rate = Math.max(1, Number(fps) || _cdGetFps() || 24);
    const byTrack = new Map();
    for (const raw of (Array.isArray(events) ? events : [])){
      const ev = raw && typeof raw === 'object' ? raw : null;
      if (!ev) continue;
      const trackIndex = Math.max(0, Number(ev?.trackIndex) || 0);
      const trackLabel = String(ev?.trackLabel || _cdAudioTrackLabel(trackIndex));
      const recInF = Number(ev?._recInF);
      const recOutF = Number(ev?._recOutF);
      let durF = 0;
      if (Number.isFinite(recInF) && Number.isFinite(recOutF) && recOutF > recInF) durF = recOutF - recInF;
      if (!durF){
        const tcIn = _cdTcNum(ev?.recIn, rate);
        const tcOut = _cdTcNum(ev?.recOut, rate);
        if (Number.isFinite(tcIn) && Number.isFinite(tcOut) && tcOut > tcIn) durF = tcOut - tcIn;
      }
      if (!durF) durF = Math.max(1, Number(ev?._lenFrames) || 1);
      if (!byTrack.has(trackIndex)) byTrack.set(trackIndex, { trackIndex, trackLabel, clipCount: 0, durF: 0 });
      const row = byTrack.get(trackIndex);
      row.clipCount += 1;
      row.durF += Math.max(1, Number(durF) || 1);
    }
    return Array.from(byTrack.values())
      .sort((a, b) => (a.trackIndex - b.trackIndex))
      .map(row => ({ ...row, durationTc: _cdFramesToTC(row.durF, rate) }));
  }

  function _cdAudioTrackStatsText(events, fps, opts = {}){
    const list = _cdAudioTrackStats(events, fps);
    if (!list.length) return '';
    const compact = !!opts.compact;
    const maxTracks = Math.max(1, Number(opts.maxTracks) || (compact ? 4 : 8));
    const shown = list.slice(0, maxTracks).map(row => (
      compact
        ? `${row.trackLabel} ${row.clipCount}`
        : `${row.trackLabel} ${row.clipCount} clip${row.clipCount === 1 ? '' : 's'} (${row.durationTc})`
    )).join(' • ');
    const extra = list.length > maxTracks ? ` • +${list.length - maxTracks}` : '';
    return shown + extra;
  }

  function _cdAudioDiffTrackStats(cmp, fps){
    const rate = Math.max(1, Number(fps) || _cdGetFps() || 24);
    const out = new Map();
    const ensure = (trackIndex, trackLabel) => {
      const idx = Math.max(0, Number(trackIndex) || 0);
      if (!out.has(idx)) out.set(idx, { trackIndex: idx, trackLabel: String(trackLabel || _cdAudioTrackLabel(idx)), NEW: 0, EXTENDED: 0, CHANGED: 0, REMOVED: 0, durF: 0 });
      return out.get(idx);
    };
    const add = (ev, diffType, preferOld = false) => {
      const dt = String(diffType || ev?.diffType || 'CHANGED').toUpperCase();
      const trackIndex = preferOld ? Math.max(0, Number(ev?.matchOldTrackIndex) || Number(ev?.trackIndex) || 0) : Math.max(0, Number(ev?.trackIndex) || Number(ev?.matchOldTrackIndex) || 0);
      const trackLabel = preferOld ? String(ev?.matchOldTrackLabel || ev?.trackLabel || _cdAudioTrackLabel(trackIndex)) : String(ev?.trackLabel || ev?.matchOldTrackLabel || _cdAudioTrackLabel(trackIndex));
      const row = ensure(trackIndex, trackLabel);
      if (dt in row) row[dt] += 1;
      const recInF = Number(ev?._recInF);
      const recOutF = Number(ev?._recOutF);
      const durF = (Number.isFinite(recInF) && Number.isFinite(recOutF) && recOutF > recInF) ? (recOutF - recInF) : Math.max(1, Number(ev?._lenFrames) || 1);
      row.durF += Math.max(1, Number(durF) || 1);
    };
    for (const ev of (cmp?.diff || [])) add(ev, ev?.diffType, false);
    for (const ev of (cmp?.removed || [])) add(ev, 'REMOVED', true);
    return Array.from(out.values())
      .sort((a, b) => (a.trackIndex - b.trackIndex))
      .map(row => ({ ...row, durationTc: _cdFramesToTC(row.durF, rate) }));
  }

  function _cdAudioDiffTrackStatsText(cmp, fps, opts = {}){
    const list = _cdAudioDiffTrackStats(cmp, fps);
    if (!list.length) return '';
    const compact = !!opts.compact;
    const maxTracks = Math.max(1, Number(opts.maxTracks) || (compact ? 4 : 8));
    const shown = list.slice(0, maxTracks).map(row => {
      const body = compact ? `N${row.NEW}/E${row.EXTENDED}/C${row.CHANGED}/R${row.REMOVED}` : `NEW ${row.NEW} • EXT ${row.EXTENDED} • CHG ${row.CHANGED} • REM ${row.REMOVED} (${row.durationTc})`;
      return `${row.trackLabel} ${body}`;
    }).join(' • ');
    const extra = list.length > maxTracks ? ` • +${list.length - maxTracks}` : '';
    return shown + extra;
  }

  function _cdReadXmlText(node, sel){
    try{ return String(node?.querySelector?.(sel)?.textContent || '').trim(); }catch{ return ''; }
  }

  function _cdReadXmlNum(node, sel){
    const n = Number(_cdReadXmlText(node, sel));
    return Number.isFinite(n) ? n : NaN;
  }

  function _cdOtioFrames(v, fps){
    if (v == null) return 0;
    if (typeof v === 'number') return Math.round(v);
    if (typeof v === 'object'){
      const value = Number(v.value);
      const rate = Number(v.rate) || Number(fps) || 24;
      if (Number.isFinite(value)) return Math.round((value / rate) * (Number(fps) || 24));
      if (v.duration != null) return _cdOtioFrames(v.duration, fps);
    }
    return 0;
  }

  function _cdExtractAudioEventsFromEDLText(txt, fps){
    const lines = String(txt || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
    const events = [];
    const tcRe = /\b\d{2}:\d{2}:\d{2}:\d{2}\b/g;
    let cur = null;
    const pushCur = () => {
      if (!cur) return;
      const trackIndex = _cdAudioTrackTokenToIndex(cur.trackTok);
      events.push({
        clipName: String(cur.clipName || cur.reel || cur.srcFile || `Audio ${events.length + 1}`).trim(),
        srcFile: String(cur.srcFile || cur.reel || cur.clipName || '').trim(),
        reel: String(cur.reel || _cdStemLike(cur.srcFile || cur.clipName || cur.reel) || '').trim(),
        srcIn: String(cur.srcIn || ''),
        srcOut: String(cur.srcOut || ''),
        recIn: String(cur.recIn || ''),
        recOut: String(cur.recOut || ''),
        fps: Math.max(1, Number(fps) || 24),
        role: 'audio',
        type: 'audio',
        kind: 'audio',
        trackType: 'audio',
        trackIndex,
        trackLabel: _cdAudioTrackLabel(trackIndex),
        sourceType: 'edl'
      });
      cur = null;
    };

    for (const rawLine of lines){
      const line = String(rawLine || '');
      const t = line.trim();
      if (!t) continue;
      if (/^\d{1,6}\s+/.test(t)){
        const tcs = t.match(tcRe);
        if (tcs && tcs.length >= 4){
          const firstTc = tcs[0];
          const prefix = t.slice(0, t.indexOf(firstTc)).trim();
          const tokens = prefix.split(/\s+/);
          const reelTok = tokens[1] || 'AUDIO';
          const trackTok = String(tokens[2] || 'V').toUpperCase();
          pushCur();
          if (trackTok.indexOf('A') === -1) continue;
          const last4 = tcs.slice(-4);
          const [srcIn, srcOut, recIn, recOut] = last4;
          cur = {
            reel: reelTok,
            clipName: reelTok,
            srcFile: reelTok,
            srcIn,
            srcOut,
            recIn,
            recOut,
            trackTok,
          };
          continue;
        }
      }
      if (!cur) continue;
      if (/^\*/.test(t)){
        const c = t.replace(/^\*\s*/, '');
        if (/^FROM CLIP NAME\s*:/i.test(c)){
          const v = c.replace(/^FROM CLIP NAME\s*:/i, '').trim();
          if (v) cur.clipName = v;
          continue;
        }
        if (/^SOURCE FILE\s*:/i.test(c)){
          const v = c.replace(/^SOURCE FILE\s*:/i, '').trim();
          if (v) cur.srcFile = v;
          continue;
        }
      }
    }
    pushCur();
    return _cdAudioDedupe(events);
  }

  function _cdExtractAudioEventsFromXmemlText(txt, fps, parsed = null){
    const parser = new DOMParser();
    const doc = parser.parseFromString(String(txt || ''), 'application/xml');
    if (doc.querySelector('parsererror')) return [];
    const seq = doc.querySelector('xmeml > sequence, sequence');
    if (!seq) return [];
    const rate = Math.max(1, Number(parsed?.fps) || Number(fps) || 24);
    let seqBaseF = Number(parsed?._seqBaseFrames ?? parsed?.seqBaseFrames ?? parsed?._timelineBaseFrames ?? parsed?.timelineBaseFrames);
    if (!Number.isFinite(seqBaseF)){
      const tcString = _cdReadXmlText(seq, 'timecode > string');
      seqBaseF = tcString ? _cdTcNum(tcString, rate) : 0;
      if (!Number.isFinite(seqBaseF)) seqBaseF = 0;
    }
    const tracks = Array.from(seq.querySelectorAll(':scope > media > audio > track, media > audio > track'));
    const events = [];
    tracks.forEach((track, idx) => {
      Array.from(track.querySelectorAll(':scope > clipitem')).forEach((clip, clipIdx) => {
        const start = _cdReadXmlNum(clip, 'start');
        const end = _cdReadXmlNum(clip, 'end');
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
        const inF = _cdReadXmlNum(clip, 'in');
        const outF = _cdReadXmlNum(clip, 'out');
        const clipName = _cdReadXmlText(clip, 'name') || _cdReadXmlText(clip, 'file > name') || `Audio ${idx + 1}.${clipIdx + 1}`;
        const srcFile = _cdReadXmlText(clip, 'file > pathurl') || _cdReadXmlText(clip, 'file > name') || clipName;
        events.push(_cdAudioClipFromFrames({
          clipName,
          srcFile,
          reel: _cdStemLike(srcFile || clipName),
          recInF: seqBaseF + start,
          recOutF: seqBaseF + end,
          srcInF: Number.isFinite(inF) ? Math.max(0, inF) : 0,
          srcOutF: Number.isFinite(outF) && outF > (Number.isFinite(inF) ? inF : 0)
            ? outF
            : ((Number.isFinite(inF) ? Math.max(0, inF) : 0) + Math.max(1, end - start)),
          trackIndex: idx,
          trackLabel: _cdAudioTrackLabel(idx),
          sourceType: 'xml'
        }, rate));
      });
    });
    return _cdAudioDedupe(events);
  }

  function _cdExtractAudioEventsFromOtioText(txt, fps){
    let obj = null;
    try{ obj = JSON.parse(String(txt || '{}')); }catch{ return []; }
    const rate = Math.max(1, Number(fps) || 24);
    const events = [];
    const seen = new Set();

    const readClipRange = (node) => {
      const r = node?.source_range || node?.trimmed_range || node?.available_range || {};
      const startF = _cdOtioFrames(r.start_time || r.startTime || 0, rate);
      let durF = _cdOtioFrames(r.duration || r.duration_time || node?.duration || 0, rate);
      if (!durF && node?.available_range) durF = _cdOtioFrames(node.available_range.duration || 0, rate);
      if (!durF) durF = 1;
      return { startF, durF: Math.max(1, durF) };
    };

    const walkAudioTrack = (trackNode, trackIndex) => {
      let cursorF = 0;
      const children = Array.isArray(trackNode?.children) ? trackNode.children : [];
      for (const child of children){
        if (!child || typeof child !== 'object') continue;
        const schema = String(child.OTIO_SCHEMA || child.schema_name || '').toLowerCase();
        if (schema.indexOf('gap') !== -1){
          cursorF += readClipRange(child).durF;
          continue;
        }
        if (schema.indexOf('transition') !== -1) continue;
        if (schema.indexOf('stack') !== -1 || (schema.indexOf('track') !== -1 && String(child.kind || child.track_kind || '').toLowerCase() === 'audio')){
          const nestedChildren = Array.isArray(child.children) ? child.children : [];
          if (nestedChildren.length){
            const fakeTrack = { children: nestedChildren };
            walkAudioTrack(fakeTrack, trackIndex);
          }
          continue;
        }
        if (schema.indexOf('clip') === -1){
          if (Array.isArray(child.children)){
            const fakeTrack = { children: child.children };
            walkAudioTrack(fakeTrack, trackIndex);
          }
          continue;
        }
        const { startF, durF } = readClipRange(child);
        const name = String(child.name || child.display_name || child.media_reference?.name || `Audio ${trackIndex + 1}`).trim();
        const targetUrl = String(child.media_reference?.target_url || child.media_reference?.targetUrl || child.media_reference?.name || name).trim();
        events.push(_cdAudioClipFromFrames({
          clipName: name,
          srcFile: targetUrl || name,
          reel: _cdStemLike(targetUrl || name),
          recInF: cursorF,
          recOutF: cursorF + durF,
          srcInF: startF,
          srcOutF: startF + durF,
          trackIndex,
          trackLabel: _cdAudioTrackLabel(trackIndex),
          sourceType: 'otio'
        }, rate));
        cursorF += durF;
      }
    };

    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);
      const schema = String(node.OTIO_SCHEMA || node.schema_name || '').toLowerCase();
      const kind = String(node.kind || node.track_kind || '').toLowerCase();
      if (schema.indexOf('track') !== -1 && kind === 'audio'){
        const idx = events.reduce((m, ev) => Math.max(m, Number(ev?.trackIndex) || 0), -1) + 1;
        walkAudioTrack(node, idx);
      }
      for (const key of Object.keys(node)){
        const val = node[key];
        if (Array.isArray(val)){
          for (const child of val) walk(child);
        }else if (val && typeof val === 'object'){
          walk(val);
        }
      }
    };

    walk(obj);
    return _cdAudioDedupe(events);
  }

  function _cdFcpSanitizeXml(txt){
    let safe = String(txt || '');
    safe = safe.replace(/<!DOCTYPE[\s\S]*?>/gi, '');
    safe = safe.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
    return safe;
  }

  function _cdFcpRatToFrames(val, fps){
    if (val == null) return 0;
    let raw = String(val).trim();
    if (!raw) return 0;
    let isSeconds = false;
    if (raw.endsWith('s')){
      isSeconds = true;
      raw = raw.slice(0, -1);
    }
    if (raw.includes('/')){
      const parts = raw.split('/');
      const num = parseFloat(parts[0]);
      const den = parseFloat(parts[1]);
      if (!Number.isFinite(num) || !Number.isFinite(den) || !den) return 0;
      const n = num / den;
      return Math.round(isSeconds ? (n * fps) : n);
    }
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return 0;
    return Math.round(isSeconds ? (n * fps) : n);
  }

  function _cdFcpFirstChild(el, sel){
    return el?.querySelector?.(`:scope > ${sel}`) || null;
  }

  function _cdFcpReadFPS(doc){
    const fmt = doc.querySelector('resources > format[frameDuration]');
    if (!fmt) return 24;
    const fdRaw = String(fmt.getAttribute('frameDuration') || '').trim();
    const fd = fdRaw.endsWith('s') ? fdRaw.slice(0, -1) : fdRaw;
    const parts = fd.split('/');
    if (parts.length !== 2) return 24;
    const num = Number(parts[0]);
    const den = Number(parts[1]);
    if (!Number.isFinite(num) || !Number.isFinite(den) || num <= 0 || den <= 0) return 24;
    return Math.max(1, Math.round(den / num));
  }

  function _cdFcpReadSeqBaseFrames(sequenceEl, fps){
    if (!sequenceEl) return 0;
    const tcStart = sequenceEl.getAttribute('tcStart');
    if (tcStart) return _cdFcpRatToFrames(tcStart, fps);
    const start = sequenceEl.getAttribute('start');
    if (start) return _cdFcpRatToFrames(start, fps);
    return 0;
  }

  function _cdFcpDetectSeqOrigin(sequenceEl, fps, seqStartF){
    if (!sequenceEl || !seqStartF) return 0;
    const sp = sequenceEl.querySelector(':scope > spine');
    const kids = sp ? Array.from(sp.children || []) : Array.from(sequenceEl.children || []);
    let minOff = Infinity;
    for (const ch of kids){
      if (!ch || ch.nodeType !== 1) continue;
      const offF = _cdFcpRatToFrames(ch.getAttribute?.('offset'), fps);
      if (Number.isFinite(offF)) minOff = Math.min(minOff, offF);
    }
    if (!Number.isFinite(minOff) || minOff === Infinity) return 0;
    const pad = Math.round(fps * 2);
    if (seqStartF > 0 && minOff >= (seqStartF - pad)) return seqStartF;
    return 0;
  }

  function _cdFcpInferChildOrigin(parentNode, fps, parentStartF, parentDurF, parentOffF){
    void parentDurF;
    if (!parentNode || !Number.isFinite(parentStartF) || parentStartF <= 0) return 0;
    const pad = Math.round(fps * 10);
    const cand = [parentStartF];
    if (Number.isFinite(parentOffF) && parentOffF > 0) cand.push(parentStartF - parentOffF);
    const childOffs = [];
    for (const ch of parentNode.children || []){
      if (!ch || ch.nodeType !== 1) continue;
      const offF = _cdFcpRatToFrames(ch.getAttribute?.('offset'), fps);
      if (Number.isFinite(offF)) childOffs.push(offF);
    }
    if (!childOffs.length) return 0;
    let bestOrigin = 0;
    let bestScore = Infinity;
    for (const origin of cand){
      let score = Infinity;
      for (const offF of childOffs) score = Math.min(score, Math.abs(offF - origin));
      if (score < bestScore){ bestScore = score; bestOrigin = origin; }
    }
    if (bestOrigin && bestScore <= pad) return bestOrigin;
    return 0;
  }

  function _cdExtractAudioEventsFromFcpXmlText(txt, fps){
    const safe = _cdFcpSanitizeXml(txt);
    const doc = new DOMParser().parseFromString(safe, 'application/xml');
    if (doc.querySelector('parsererror') || !doc.querySelector('fcpxml')) return [];
    const rate = Math.max(1, Number(fps) || _cdFcpReadFPS(doc) || 24);
    const assets = {};
    doc.querySelectorAll('resources > asset[id]').forEach((a) => {
      const id = a.getAttribute('id');
      if (!id) return;
      const audioSources = Math.max(0, parseInt(a.getAttribute('audioSources') || a.getAttribute('audio-sources') || '0', 10) || 0);
      const audioChannels = Math.max(0, parseInt(a.getAttribute('audioChannels') || a.getAttribute('audio-channels') || '0', 10) || 0);
      const hasAudioAttr = String(a.getAttribute('hasAudio') || a.getAttribute('has-audio') || '').toLowerCase();
      const audioRate = String(a.getAttribute('audioRate') || a.getAttribute('audio-rate') || '').trim();
      const assetName = String(a.getAttribute('name') || '').trim();
      const assetSrc = String(a.getAttribute('src') || a.querySelector('media-rep[src]')?.getAttribute('src') || '').trim();
      const assetSrcName = _cdBaseFileName(assetSrc) || assetName;
      assets[id] = {
        name: assetName,
        srcPath: assetSrc,
        srcName: assetSrcName,
        hasAudio: hasAudioAttr === '1' || hasAudioAttr === 'true' || audioSources > 0 || audioChannels > 0 || !!audioRate,
        audioSources,
        audioChannels,
        audioRate,
      };
    });
    const medias = {};
    doc.querySelectorAll('resources > media[id]').forEach((m) => {
      const id = m.getAttribute('id');
      if (!id) return;
      medias[id] = m;
    });
    const mainSeq = doc.querySelector('library project > sequence, project > sequence, sequence');
    if (!mainSeq) return [];
    const seqStartF = _cdFcpReadSeqBaseFrames(mainSeq, rate);
    const seqOriginF = _cdFcpDetectSeqOrigin(mainSeq, rate, seqStartF);
    const out = [];

    const resolveRefInfo = (node) => {
      let ptr = node;
      while (ptr){
        const ref = ptr.getAttribute?.('ref');
        if (ref && assets[ref]) return assets[ref];
        ptr = ptr.parentElement;
      }
      return null;
    };

    const resolveRefName = (node) => {
      const info = resolveRefInfo(node);
      return String(info?.name || '').trim();
    };

    const resolveRefFileName = (node) => {
      const info = resolveRefInfo(node);
      return String(info?.srcName || info?.name || '').trim();
    };

    const traverse = (node, baseRecF, originF, inheritedLane = null) => {
      if (!node || node.nodeType !== 1) return;
      const tag = String(node.tagName || '').toLowerCase();
      if (tag === 'ref-clip'){
        const ref = node.getAttribute('ref');
        const localOff = _cdFcpRatToFrames(node.getAttribute('offset'), rate);
        const refRecInF = baseRecF + (localOff - (originF || 0));
        const media = ref ? medias[ref] : null;
        const seq = media ? _cdFcpFirstChild(media, 'sequence') : null;
        if (seq){
          const innerSeqStartF = _cdFcpReadSeqBaseFrames(seq, rate);
          const innerSeqOriginF = _cdFcpDetectSeqOrigin(seq, rate, innerSeqStartF);
          const spines = seq.querySelectorAll(':scope > spine');
          if (spines.length){
            spines.forEach((sp) => {
              for (const ch of sp.children || []) traverse(ch, refRecInF, innerSeqOriginF, inheritedLane);
            });
          }else{
            for (const ch of seq.children || []) traverse(ch, refRecInF, innerSeqOriginF, inheritedLane);
          }
        }
        return;
      }

      const laneAttr = node.getAttribute?.('lane');
      const lane = (laneAttr != null && laneAttr !== '') ? laneAttr : inheritedLane;
      const trackIndex = _cdAudioLaneToIndex(lane);
      const durF = _cdFcpRatToFrames(node.getAttribute?.('duration'), rate);
      const offF = _cdFcpRatToFrames(node.getAttribute?.('offset'), rate);
      const srcF = _cdFcpRatToFrames(node.getAttribute?.('start'), rate);
      const recInF = baseRecF + (offF - (originF || 0));
      const recOutF = recInF + Math.max(0, durF);

      if (tag === 'audio' && durF > 0){
        const clipName = String(node.getAttribute('name') || node.parentElement?.getAttribute?.('name') || resolveRefName(node) || `Audio ${out.length + 1}`).trim();
        const srcFile = String(resolveRefFileName(node) || resolveRefName(node) || clipName || `Audio_${trackIndex + 1}`).trim();
        out.push(_cdAudioClipFromFrames({
          clipName,
          srcFile,
          reel: _cdStemLike(srcFile || clipName),
          recInF,
          recOutF,
          srcInF: Math.max(0, srcF),
          srcOutF: Math.max(0, srcF + Math.max(0, durF)),
          trackIndex,
          trackLabel: _cdAudioTrackLabel(trackIndex),
          sourceType: 'fcpxml'
        }, rate));
      } else if (durF > 0) {
        let hasExplicitAudio = false;
        try{ hasExplicitAudio = !!node.querySelector(':scope > audio, :scope audio'); }catch{}
        const audioRole = String(node.getAttribute('audioRole') || node.getAttribute('audio-role') || '').trim();
        const assetInfo = resolveRefInfo(node);
        const audioSources = Math.max(0, Number(assetInfo?.audioSources) || Number(node.getAttribute('audioSources') || node.getAttribute('audio-sources') || 0) || 0);
        const audioChannels = Math.max(0, Number(assetInfo?.audioChannels) || Number(node.getAttribute('audioChannels') || node.getAttribute('audio-channels') || 0) || 0);
        const hasAudioAttr = String(node.getAttribute('hasAudio') || node.getAttribute('has-audio') || '').toLowerCase();
        const isAudioBearingTag = tag === 'asset-clip' || tag === 'clip' || tag === 'sync-clip' || tag === 'mc-clip';
        const hasImplicitAudio = isAudioBearingTag && !hasExplicitAudio && (
          !!audioRole ||
          !!assetInfo?.hasAudio ||
          hasAudioAttr === '1' ||
          hasAudioAttr === 'true' ||
          audioSources > 0 ||
          audioChannels > 0
        );
        if (hasImplicitAudio){
          const clipName = String(node.getAttribute('name') || resolveRefName(node) || `Audio ${out.length + 1}`).trim();
          const srcFile = String(resolveRefFileName(node) || resolveRefName(node) || clipName || `Audio_${trackIndex + 1}`).trim();
          out.push(_cdAudioClipFromFrames({
            clipName,
            srcFile,
            reel: _cdStemLike(srcFile || clipName),
            recInF,
            recOutF,
            srcInF: Math.max(0, srcF),
            srcOutF: Math.max(0, srcF + Math.max(0, durF)),
            trackIndex,
            trackLabel: _cdAudioTrackLabel(trackIndex),
            sourceType: 'fcpxml-implicit'
          }, rate));
        }
      }

      const childOriginF = _cdFcpInferChildOrigin(node, rate, srcF, durF, offF);
      for (const ch of node.children || []){
        traverse(ch, recInF, childOriginF, lane);
      }
    };

    const spines = mainSeq.querySelectorAll(':scope > spine');
    if (spines.length){
      spines.forEach((sp) => {
        for (const ch of sp.children || []) traverse(ch, seqStartF, seqOriginF, null);
      });
    }else{
      for (const ch of mainSeq.children || []) traverse(ch, seqStartF, seqOriginF, null);
    }

    return _cdAudioDedupe(out);
  }

  async function _cdExtractAudioDetails(file, parsed = null){
    if (!file) return { meta: _cdAudioMetaNone('No file selected'), events: [] };
    const name = String(file.name || '').toLowerCase();
    try{
      const txt = await file.text();
      let events = [];
      let source = name.endsWith('.fcpxml') ? 'fcpxml' : (name.endsWith('.xml') ? 'xml' : (name.endsWith('.otio') || name.endsWith('.json') ? 'otio' : (name.endsWith('.edl') ? 'edl' : '')));
      if (name.endsWith('.fcpxml')) events = _cdExtractAudioEventsFromFcpXmlText(txt, parsed?.fps || _cdGetFps());
      else if (name.endsWith('.xml')) events = _cdExtractAudioEventsFromXmemlText(txt, parsed?.fps || _cdGetFps(), parsed);
      else if (name.endsWith('.otio') || name.endsWith('.json')) events = _cdExtractAudioEventsFromOtioText(txt, parsed?.fps || _cdGetFps());
      else if (name.endsWith('.edl')) events = _cdExtractAudioEventsFromEDLText(txt, parsed?.fps || _cdGetFps());
      else if (name.endsWith('.ale')) events = [];
      events = _cdAudioDedupe(events);
      if (!events.length && parsed?.events?.length && (name.endsWith('.fcpxml') || name.endsWith('.xml'))){
        const fallbackEvents = _cdFallbackAudioEventsFromParsed(parsed, `${source || 'timeline'}-derived`);
        if (fallbackEvents.length){
          events = fallbackEvents;
          source = `${source || 'timeline'}-derived`;
        }
      }
      const meta = events.length
        ? _cdAudioMetaFromEvents(events, source || 'timeline')
        : _cdAudioMetaNone(name.endsWith('.ale') ? 'ALE has no timeline audio layout' : 'Audio metadata unavailable');
      return { meta, events };
    }catch(err){
      return { meta: _cdAudioMetaNone(err?.message || 'Audio metadata unavailable'), events: [] };
    }
  }

  function _cdComputeAudioCompare(oldEvents, newEvents, fps){
    const rate = Math.max(1, Number(fps) || _cdGetFps() || 24);
    const oldList = _cdAudioDedupe((oldEvents || []).map(ev => ({ ...ev })));
    const newList = _cdAudioDedupe((newEvents || []).map(ev => ({ ...ev })));
    _cdEnsureFrames(oldList, rate);
    _cdEnsureFrames(newList, rate);

    const exactOld = new Map();
    oldList.forEach((ev, idx) => {
      const key = _cdAudioIdentity(ev);
      if (!exactOld.has(key)) exactOld.set(key, []);
      exactOld.get(key).push(idx);
    });

    const usedOld = new Set();
    const unchanged = [];
    const diff = [];

    const findBestOld = (ev) => {
      const ns = Number(ev?._recInF) || 0;
      const ne = Number(ev?._recOutF) || 0;
      const nTrack = Math.max(0, Number(ev?.trackIndex) || 0);
      const nLabel = _cdAudioLabelKey(ev);
      const nSrcIn = String(ev?.srcIn || '');
      const nSrcOut = String(ev?.srcOut || '');
      let best = null;
      for (let i = 0; i < oldList.length; i++){
        if (usedOld.has(i)) continue;
        const cand = oldList[i];
        const os = Number(cand?._recInF) || 0;
        const oe = Number(cand?._recOutF) || 0;
        const overlap = _cdAudioRangeOverlap(ns, ne, os, oe);
        const sameTrack = Math.max(0, Number(cand?.trackIndex) || 0) === nTrack;
        const sameLabel = !!nLabel && (nLabel === _cdAudioLabelKey(cand));
        const sameSrc = sameLabel && String(cand?.srcIn || '') === nSrcIn && String(cand?.srcOut || '') === nSrcOut;
        const nLen = Math.max(1, ne - ns);
        const oLen = Math.max(1, oe - os);
        const ovFrac = overlap / Math.max(nLen, oLen);
        let score = 0;
        if (sameTrack) score += 30;
        if (sameLabel) score += 30;
        if (sameSrc) score += 20;
        if (overlap > 0) score += Math.min(45, ovFrac * 45);
        const delta = Math.abs(ns - os) + Math.abs(ne - oe);
        if (Number.isFinite(delta)) score += Math.max(0, 10 - Math.min(10, delta / Math.max(1, rate)));
        if (!best || score > best.score){
          best = { idx: i, ev: cand, score, overlap, ovFrac, sameTrack, sameLabel, sameSrc };
        }
      }
      return best;
    };

    for (const ev of newList){
      const key = _cdAudioIdentity(ev);
      const exactPool = exactOld.get(key) || [];
      let exactIdx = -1;
      while (exactPool.length){
        const idx = exactPool.shift();
        if (!usedOld.has(idx)) { exactIdx = idx; break; }
      }
      if (exactIdx >= 0){
        usedOld.add(exactIdx);
        unchanged.push({ ...ev, diffType: 'UNCHANGED' });
        continue;
      }

      const best = findBestOld(ev);
      if (!best || best.score < 32 || best.overlap <= 0){
        diff.push({ ...ev, diffType: 'NEW' });
        continue;
      }

      usedOld.add(best.idx);
      const ns = Number(ev?._recInF) || 0;
      const ne = Number(ev?._recOutF) || 0;
      const os = Number(best.ev?._recInF) || 0;
      const oe = Number(best.ev?._recOutF) || 0;
      const extendsHead = ns < os;
      const extendsTail = ne > oe;
      const diffType = (best.sameTrack && (best.sameLabel || best.sameSrc) && best.ovFrac >= 0.55 && (extendsHead !== extendsTail))
        ? 'EXTENDED'
        : 'CHANGED';
      diff.push({
        ...ev,
        diffType,
        matchScore: Math.max(0, Math.min(1, best.score / 100)),
        matchOldClipName: best.ev?.clipName || '',
        matchOldSrcFile: best.ev?.srcFile || '',
        matchOldRecIn: best.ev?.recIn || '',
        matchOldRecOut: best.ev?.recOut || '',
        matchOldSrcIn: best.ev?.srcIn || '',
        matchOldSrcOut: best.ev?.srcOut || '',
        matchOldTrackIndex: Math.max(0, Number(best.ev?.trackIndex) || 0),
        matchOldTrackLabel: String(best.ev?.trackLabel || _cdAudioTrackLabel(best.ev?.trackIndex || 0)),
      });
    }

    const removed = [];
    for (let i = 0; i < oldList.length; i++){
      if (usedOld.has(i)) continue;
      removed.push({ ...oldList[i], diffType: 'REMOVED' });
    }

    const summary = { NEW: 0, EXTENDED: 0, CHANGED: 0, REMOVED: removed.length, UNCHANGED: unchanged.length };
    for (const ev of diff){
      const dt = String(ev?.diffType || 'CHANGED').toUpperCase();
      if (dt in summary) summary[dt] += 1;
    }

    return { old: oldList, new: newList, diff, removed, unchanged, summary };
  }

  function _cdGetAudioCompareData(){
    const oldEvents = Array.isArray(state.oldRaw?.audioEvents) ? state.oldRaw.audioEvents : [];
    const newEvents = Array.isArray(state.newRaw?.audioEvents) ? state.newRaw.audioEvents : [];
    const key = [
      String(state.oldRaw?.fileMeta?.sha256 || state.oldRaw?.projectName || 'old'),
      String(state.newRaw?.fileMeta?.sha256 || state.newRaw?.projectName || 'new'),
      oldEvents.length,
      newEvents.length,
      _cdGetFps()
    ].join('|');
    if (audioCompareState.key === key && audioCompareState.payload) return audioCompareState.payload;
    const payload = _cdComputeAudioCompare(oldEvents, newEvents, _cdGetFps());
    audioCompareState.key = key;
    audioCompareState.payload = payload;
    return payload;
  }

  function _cdAudioChangeSummaryText(cmp){
    const sum = cmp?.summary || {};
    const total = (sum.NEW || 0) + (sum.EXTENDED || 0) + (sum.CHANGED || 0) + (sum.REMOVED || 0);
    if (!cmp || !total) return 'Audio diff: no timeline audio changes detected';
    return `Audio diff: NEW ${sum.NEW || 0} • EXT ${sum.EXTENDED || 0} • CHG ${sum.CHANGED || 0} • REM ${sum.REMOVED || 0}`;
  }

  function _cdShowToast(msg){
    try{
      if (typeof window !== "undefined" && typeof window.showToast === "function"){
        window.showToast(msg);
        return;
      }
    }catch{}
    _cdSetProjectStatus(String(msg || ""));
  }

  function _cdProjectSnapshot(){
    const maxSecInput = document.getElementById("cutdiffMaxSeconds");
    const maxSeconds = parseFloat(maxSecInput?.value) || 0;
    return {
      v: 1,
      savedAt: _cdNowISO(),
      state: {
        oldRaw: state.oldRaw,
        newRaw: state.newRaw,
        oldView: state.oldView,
        newView: state.newView,
        diff: state.diff,
        removed: state.removed,
        analyzed: state.analyzed,
      },
      ui: {
        maxSeconds,
        sortState: { ...sortState },
        selState: { ...selState },
      },
      vcmp: {
        oldName: _vcGetRememberedName('old') || '',
        newName: _vcGetRememberedName('new') || '',
        oldStartTc: String(__vcUI.tcOld?.value || vcState.oldStartTc || '00:00:00:00'),
        newStartTc: String(__vcUI.tcNew?.value || vcState.newStartTc || '00:00:00:00'),
        mode: vcState.mode,
        wipe: vcState.wipe,
        fit: vcState.fit,
        loop: !!vcState.loop,
        audio: !!vcState.audio,
        cleanFeed: false
      }
    };
  }

  function _cdApplyProjectSnapshot(snap){
    if (!snap || typeof snap !== "object") { clear(); return; }
    // Sprint A: expose snapshot for unified project save
    try{ window.__MPS_CD_SNAPSHOT = snap; }catch{}
    __cdApplyingProject = true;
    try{
      const s = snap.state || {};
      state.oldRaw = s.oldRaw || null;
      state.newRaw = s.newRaw || null;
      state.oldView = Array.isArray(s.oldView) ? s.oldView : [];
      state.newView = Array.isArray(s.newView) ? s.newView : [];
      state.diff = Array.isArray(s.diff) ? s.diff : [];
      state.removed = Array.isArray(s.removed) ? s.removed : [];
      state.analyzed = !!s.analyzed;

      const ui = snap.ui || {};
      const maxSecInput = document.getElementById("cutdiffMaxSeconds");
      if (maxSecInput && ui.maxSeconds != null) maxSecInput.value = String(ui.maxSeconds);

      if (ui.sortState){
        sortState.key = ui.sortState.key || null;
        sortState.dir = ui.sortState.dir || 1;
      }
      if (ui.selState){
        selState.srcIdx = (ui.selState.srcIdx != null) ? ui.selState.srcIdx : null;
        selState.rowPos = Number(ui.selState.rowPos) || 0;
      }

      _cdRebuildDerivedStateFromRaw({ keepAnalyze: true });

      // Restore Video Compare (Cut Diff)
      try{
        const vcmp = (snap.vcmp && typeof snap.vcmp === 'object') ? snap.vcmp : null;
        if (vcmp){
          if (vcmp.oldName) _vcRememberName('old', vcmp.oldName);
          if (vcmp.newName) _vcRememberName('new', vcmp.newName);
          if (__vcUI.tcOld && vcmp.oldStartTc) __vcUI.tcOld.value = String(vcmp.oldStartTc);
          if (__vcUI.tcNew && vcmp.newStartTc) __vcUI.tcNew.value = String(vcmp.newStartTc);
          try{
            const oTc = String(vcmp.oldStartTc || '').trim();
            const nTc = String(vcmp.newStartTc || '').trim();
            if (oTc && oTc !== '00:00:00:00') vcState._userStartOld = true;
            if (nTc && nTc !== '00:00:00:00') vcState._userStartNew = true;
          }catch{}
          if (vcmp.mode) vcState.mode = String(vcmp.mode);
          if (vcmp.fit) vcState.fit = String(vcmp.fit);
          if (vcmp.wipe != null) vcState.wipe = Math.max(0, Math.min(1, Number(vcmp.wipe) || 0.5));
          vcState.loop = !!vcmp.loop;
          vcState.audio = !!vcmp.audio;
          vcState.cleanFeed = false;
        }

        // reflect in UI controls
        try{ _vcUpdateStartFrames(); }catch{}
        try{
          // wipe slider
          if (__vcUI.wipe) __vcUI.wipe.value = String(Math.round((Number(vcState.wipe)||0.5) * 100));
          // mode buttons
          if (__vcUI.modes){
            __vcUI.modes.querySelectorAll?.('[data-mode]')?.forEach?.(b => b.classList.toggle('is-active', b.getAttribute('data-mode') === vcState.mode));
          }
          // audio/loop buttons
          __vcUI.btnLoop?.classList?.toggle?.('is-active', !!vcState.loop);
          __vcUI.btnLoop?.setAttribute?.('aria-pressed', vcState.loop ? 'true' : 'false');
          __vcUI.btnAudio?.classList?.toggle?.('is-active', !!vcState.audio);
          if (__vcUI.vidNew) __vcUI.vidNew.muted = !vcState.audio;
        }catch{}

        // clean feed button + viewer class
        try{ _vcSyncCleanFeed(); }catch{}

        // Attempt to restore videos (no prompt; uses persisted handles / Media Root index if already granted)
        setTimeout(() => { void _vcRestoreRemembered(); }, 0);
      }catch{}
// restore status labels
      const oldStatus = document.getElementById("cutdiffOldStatus");
      const newStatus = document.getElementById("cutdiffNewStatus");
      if (oldStatus){
        oldStatus.textContent = state.oldView?.length
          ? _cdBuildLoadedStatus(state.oldRaw, "OLD")
          : "No cut loaded.";
      }
      if (newStatus){
        newStatus.textContent = state.newView?.length
          ? _cdBuildLoadedStatus(state.newRaw, "NEW")
          : "No cut loaded.";
      }

      // Always show the full Summary/KPI layout.
      // Default values are shown until the user clicks Analyze.
      try{ _cdRenderSummary(); }catch{}
      _cdRenderCompareLock();
      renderTable();
      _cdRenderTimelineActive(true);
      updateHeartbeat();
    } finally {
      __cdApplyingProject = false;
    }
  }

  async function _cdLoadIndex(){
    const idx = await _cdStorageGet(CD_PROJECTS_INDEX_KEY);
    if (idx && typeof idx === "object" && Array.isArray(idx.projects)) return idx;
    const id = _cdId();
    return {
      activeId: id,
      projects: [{ id, name: "Default", createdAt: _cdNowISO(), updatedAt: _cdNowISO() }]
    };
  }

  async function _cdSaveIndex(){
    if (!__cdProjectIndex) return;
    await _cdStorageSet({ [CD_PROJECTS_INDEX_KEY]: __cdProjectIndex });
  }

  function _cdRenderProjectSelect(){
    if (!__cdUI.sel) return;
    const sel = __cdUI.sel;
    sel.innerHTML = "";
    const list = (__cdProjectIndex?.projects || []);
    for (const p of list){
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.name || p.id;
      sel.appendChild(opt);
    }
    if (__cdActiveProjectId) sel.value = __cdActiveProjectId;
  }

  async function _cdLoadActiveProject(){
    if (!__cdActiveProjectId) return;
    const snap = await _cdStorageGet(CD_PROJECT_KEY_PREFIX + __cdActiveProjectId);
    if (snap) _cdApplyProjectSnapshot(snap);
    __cdDirty = false;
    _cdSetProjectStatus("Restored");
  }

  function _cdMarkDirty(reason){
    if (__cdApplyingProject) return;
    __cdDirty = true;
    _cdSetProjectStatus("● Unsaved");
    try{ window.MPS_markProjectDirty?.("cut diff"); }catch{}
    _cdScheduleAutosave(reason);
  }

  function _cdScheduleAutosave(reason){
    if (__cdApplyingProject) return;
    if (__cdAutosaveT) clearTimeout(__cdAutosaveT);
    __cdAutosaveT = setTimeout(() => {
      __cdAutosaveT = 0;
      void _cdAutosaveNow(reason);
    }, CD_AUTOSAVE_DEBOUNCE_MS);
  }

  async function _cdAutosaveNow(reason){
    if (!__cdActiveProjectId) return;
    if (!__cdDirty) return;
    const snap = _cdProjectSnapshot();
    // Sprint A: expose latest CUT DIFF snapshot for unified project save
    try{ window.__MPS_CD_SNAPSHOT = snap; }catch{}
    await _cdStorageSet({ [CD_PROJECT_KEY_PREFIX + __cdActiveProjectId]: snap });

    // bump updatedAt
    const p = (__cdProjectIndex?.projects || []).find(x => x.id === __cdActiveProjectId);
    if (p) p.updatedAt = _cdNowISO();
    if (__cdProjectIndex) __cdProjectIndex.activeId = __cdActiveProjectId;
    await _cdSaveIndex();
    __cdDirty = false;
    _cdSetProjectStatus(reason ? `Saved (${reason})` : "Saved");
  }

  function _cdDownloadJSON(filename, obj){
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => { try{ URL.revokeObjectURL(a.href); }catch{} }, 1200);
  }

  async function _cdNewProject(){
    const id = _cdId();
    const now = _cdNowISO();
    const p = { id, name: `Project ${(__cdProjectIndex?.projects?.length||0) + 1}`, createdAt: now, updatedAt: now };
    __cdProjectIndex.projects.push(p);
    __cdProjectIndex.activeId = id;
    __cdActiveProjectId = id;
    await _cdSaveIndex();
    await _cdStorageSet({ [CD_PROJECT_KEY_PREFIX + id]: _cdProjectSnapshot() });
    _cdRenderProjectSelect();
    clear();
    _cdSetProjectStatus("New project");
  }

  async function _cdSelectProject(id){
    if (!id) return;
    if (__cdDirty) await _cdAutosaveNow("autosave");
    __cdActiveProjectId = id;
    if (__cdProjectIndex) __cdProjectIndex.activeId = id;
    await _cdSaveIndex();
    await _cdLoadActiveProject();
    _cdRenderProjectSelect();
  }

  async function _cdRenameProject(){
    const p = (__cdProjectIndex?.projects || []).find(x => x.id === __cdActiveProjectId);
    if (!p) return;
    const name = prompt("Project name", p.name || "");
    if (!name) return;
    p.name = name;
    p.updatedAt = _cdNowISO();
    await _cdSaveIndex();
    _cdRenderProjectSelect();
    _cdSetProjectStatus("Renamed");
  }

  async function _cdDeleteProject(){
    const list = (__cdProjectIndex?.projects || []);
    if (list.length <= 1){
      _cdShowToast("Cannot delete the last project.");
      return;
    }
    const p = list.find(x => x.id === __cdActiveProjectId);
    const ok = confirm(`Delete project “${p?.name || __cdActiveProjectId}”?`);
    if (!ok) return;
    const idx = list.findIndex(x => x.id === __cdActiveProjectId);
    if (idx >= 0) list.splice(idx, 1);
    const next = list[0];
    __cdActiveProjectId = next.id;
    __cdProjectIndex.activeId = next.id;
    await _cdSaveIndex();
    _cdRenderProjectSelect();
    await _cdLoadActiveProject();
    _cdSetProjectStatus("Deleted");
  }

  async function _cdSaveProjectFile(mode){
    if (__cdDirty) await _cdAutosaveNow("autosave");
    const p = (__cdProjectIndex?.projects || []).find(x => x.id === __cdActiveProjectId);
    const name = (p?.name || "CutDiff").replace(/[^a-z0-9\-_ ]/gi, "").trim().replace(/\s+/g, "_") || "CutDiff";
    const file = {
      schema: "mps-pulls-assistant-x.project",
      schemaVersion: 1,
      feature: "cutdiff",
      exportedAt: _cdNowISO(),
      project: { id: p?.id || __cdActiveProjectId, name: p?.name || name },
      payload: _cdProjectSnapshot()
    };
    const stamp = _cdNowISO().replace(/[:.]/g, "-");
    const fname = `${name}_CUTDIFF_${stamp}.mpscutdiff.json`;
    _cdDownloadJSON(fname, file);
    _cdSetProjectStatus(mode === "saveas" ? "Saved As" : "Saved");
  }

  async function _cdImportProjectFile(file){
    const txt = await file.text();
    let obj = null;
    try{ obj = JSON.parse(txt); }catch(e){ throw new Error("Invalid JSON project file."); }
    const payload = obj?.payload || obj?.cutdiff || obj;
    if (!payload) throw new Error("Project file missing payload.");

    const id = _cdId();
    const now = _cdNowISO();
    const name = (obj?.project?.name || file.name || "Imported").replace(/\.mpscutdiff\.json$/i, "");
    const p = { id, name, createdAt: now, updatedAt: now };
    __cdProjectIndex.projects.push(p);
    __cdProjectIndex.activeId = id;
    __cdActiveProjectId = id;
    await _cdSaveIndex();
    await _cdStorageSet({ [CD_PROJECT_KEY_PREFIX + id]: payload });
    _cdRenderProjectSelect();
    await _cdLoadActiveProject();
    _cdSetProjectStatus("Loaded");
  }

  async function _cdInitProjectUI(){
    __cdProjectIndex = await _cdLoadIndex();
    __cdActiveProjectId = __cdProjectIndex.activeId || __cdProjectIndex.projects?.[0]?.id;
    if (!__cdActiveProjectId){
      const id = _cdId();
      __cdProjectIndex.projects = [{ id, name: "Default", createdAt: _cdNowISO(), updatedAt: _cdNowISO() }];
      __cdProjectIndex.activeId = id;
      __cdActiveProjectId = id;
      await _cdSaveIndex();
    }
    _cdRenderProjectSelect();
    await _cdLoadActiveProject();
  }

  // ---------------------------------------------------------------------------
  // Pipeline (CUT DIFF needs stable, normalized OCF reels)
  // ---------------------------------------------------------------------------
  function normalizeEventsOCF(evs){
    return (evs || []).map(ev => normalizeOCFReel ? normalizeOCFReel(ev) : ev);
  }

  function _cdIsStrictOcfEvent(ev){
    if (!ev || ev.disabled) return false;
    if (ev.isOCF === false) return false;

    const kind = String(ev.kind || '').trim().toLowerCase();
    if (kind && kind !== 'clip' && ev.isOCF !== true) return false;

    try{
      if (typeof Filters?.filterCameraOriginal === 'function'){
        if ((Filters.filterCameraOriginal([ev]) || []).length) return true;
      }
    }catch{}

    return ev.isOCF === true;
  }

  function _cdFilterStrictOcf(events){
    return (events || []).filter(_cdIsStrictOcfEvent);
  }

  function _cdRebuildDerivedStateFromRaw(opts = {}){
    const keepAnalyze = opts.keepAnalyze !== false;

    if (Array.isArray(state.oldRaw?.events) && state.oldRaw.events.length){
      state.oldView = runDefaultCutDiffPipeline(state.oldRaw.events, state.oldRaw?.fps || _cdFpsFallback());
    } else {
      state.oldView = _cdFilterStrictOcf(normalizeEventsOCF(state.oldView || []));
    }

    if (Array.isArray(state.newRaw?.events) && state.newRaw.events.length){
      state.newView = runDefaultCutDiffPipeline(state.newRaw.events, state.newRaw?.fps || _cdFpsFallback());
    } else {
      state.newView = _cdFilterStrictOcf(normalizeEventsOCF(state.newView || []));
    }

    const fps = state.newRaw?.fps || state.oldRaw?.fps || 24;

    if (keepAnalyze && state.analyzed && state.oldView.length && state.newView.length && CutDiff?.computeCutDiff){
      const maxSecInput = document.getElementById('cutdiffMaxSeconds');
      const maxSec = parseFloat(maxSecInput?.value) || 0;
      const maxFrames = maxSec > 0 ? Math.round(maxSec * fps) : 0;

      state.diff = _cdFilterStrictOcf(CutDiff.computeCutDiff(
        state.oldView,
        state.newView,
        {
          minFrames: 0,
          maxFrames,
          includeTrimmed: false,
          includeUnchanged: false
        }
      ) || []);

      state.removed = _cdFilterStrictOcf(_cdComputeRemoved(state.oldView, state.newView, fps) || []);
      _cdComputeConfidence(state.oldView, state.diff, fps);
      state.analyzed = true;
    } else {
      state.diff = _cdFilterStrictOcf(normalizeEventsOCF(state.diff || []));
      state.removed = _cdFilterStrictOcf(normalizeEventsOCF(state.removed || []));
    }
  }

  function runDefaultCutDiffPipeline(events, fps){
    if (!Array.isArray(events) || !events.length) return [];

    let evs;

    if (Filters?.runPipeline){
      evs = Filters.runPipeline(events, {
        decompose   : true,
        flatten     : true,
        mergeOverlap: false,
        conformOCF  : true,
        vfxRename   : false,
        vfxMarker   : false,
        extraHandles: false,
        metadata    : false,
        hideDisabled: true
      });
    } else {
      evs = events.slice();
      if (Filters?.decomposeEvents) evs = Filters.decomposeEvents(evs);
      if (Filters?.flattenTracks)   evs = Filters.flattenTracks(evs);
      if (Filters?.filterCameraOriginal) evs = Filters.filterCameraOriginal(evs);
    }

    if (Filters?.filterValidTimecode){
      try{ evs = Filters.filterValidTimecode(evs, fps || 24); }catch{}
    }

    evs = normalizeEventsOCF(evs);
    evs = _cdFilterStrictOcf(evs);
    return evs;
  }

  // ---------------------------------------------------------------------------
  // UI helpers
  // ---------------------------------------------------------------------------
  function _cdFpsFallback(){
    return (
      state.newRaw?.fps ||
      state.oldRaw?.fps ||
      24
    );
  }

  function _cdTcNum(tc, fps){
    if (!tc) return NaN;
    try{
      const f = tcToFrames ? tcToFrames(tc, fps || _cdFpsFallback()) : NaN;
      return Number.isFinite(f) ? f : NaN;
    }catch{
      return NaN;
    }
  }

  function _cdTypeRank(t){
    const s = String(t || "CHANGED").toUpperCase();
    if (s === "NEW") return 0;
    if (s === "EXTENDED") return 1;
    if (s === "CHANGED") return 2;
    if (s === "TRIMMED") return 3;
    if (s === "UNCHANGED") return 4;
    return 99;
  }

  function _cdSortValueFor(ev, key){
    if (!ev) return "";
    const fps = Number(ev.fps) || _cdFpsFallback();
    switch(String(key||"")){
      case "type":     return _cdTypeRank(ev.diffType);
      case "conf":     return Number(ev.matchScore ?? -1);
      case "reel":     return String(ev.reel || "").toUpperCase();
      case "srcIn":    return _cdTcNum(ev.srcIn, fps);
      case "srcOut":   return _cdTcNum(ev.srcOut, fps);
      case "recIn":    return _cdTcNum(ev.recIn, fps);
      case "recOut":   return _cdTcNum(ev.recOut, fps);
      case "duration": return Number(ev._lenFrames ?? 0);
      case "clipName": return String(ev.clipName || "").toUpperCase();
      case "status":   return String(ev.status || "").toUpperCase();
      case "note":     return String(ev.note || "").toUpperCase();
      default:          return "";
    }
  }

  function _cdCmpSort(a, b, key){
    const av = _cdSortValueFor(a, key);
    const bv = _cdSortValueFor(b, key);

    const an = (typeof av === "number") ? av : NaN;
    const bn = (typeof bv === "number") ? bv : NaN;
    const aIsNum = Number.isFinite(an);
    const bIsNum = Number.isFinite(bn);

    if (aIsNum || bIsNum){
      const aa = aIsNum ? an : Number.POSITIVE_INFINITY;
      const bb = bIsNum ? bn : Number.POSITIVE_INFINITY;
      if (aa < bb) return -1;
      if (aa > bb) return 1;
      return 0;
    }

    const as = String(av ?? "");
    const bs = String(bv ?? "");
    return as.localeCompare(bs);
  }

  function renderHeaderSort(){
    const table = document.getElementById("cutdiffTable");
    if (!table) return;
    const ths = table.querySelectorAll("thead th[data-sort]");
    ths.forEach(th => {
      const k = th.getAttribute("data-sort");
      const label = th.getAttribute("data-label") || th.textContent || "";
      const isActive = (sortState.key === k);
      const arrow = isActive
        ? (sortState.dir > 0 ? "▲" : "▼")
        : "↕";
      const cls = isActive ? "cd-sort-arrow" : "cd-sort-arrow is-idle";
      const safe = esc ? esc(label) : String(label);
      th.innerHTML = `${safe}<span class="${cls}">${arrow}</span>`;
    });
  }

  function _cdRows(){
    const tbody = document.querySelector('#cutdiffTable tbody');
    return tbody ? Array.from(tbody.querySelectorAll('tr[data-idx]')) : [];
  }

  function _cdApplySelection(){
    const rows = _cdRows();
    rows.forEach(r => {
      r.classList.remove('sel');
      r.removeAttribute('aria-selected');
    });

    if (!rows.length){
      selState.srcIdx = null;
      selState.rowPos = 0;
      return;
    }

    let row = null;
    if (selState.srcIdx != null){
      row = rows.find(r => Number(r.dataset.idx) === Number(selState.srcIdx));
    }
    if (!row){
      const pos = Math.max(0, Math.min(Number(selState.rowPos) || 0, rows.length - 1));
      row = rows[pos] || rows[0];
    }
    if (!row) return;

    selState.srcIdx = Number(row.dataset.idx);
    selState.rowPos = rows.indexOf(row);
    row.classList.add('sel');
    row.setAttribute('aria-selected', 'true');

    // keep Smart Timeline Compare selection in sync
    _cdApplyTimelineSelection();

      // playhead sync
      _cdUpdateDiffTlPlayhead();

    // keep Video Compare in sync (seek to selected Rec In)
    try{ _vcApplySelection(); }catch{}
  }

  function _cdSelectByPos(pos, opts = {}){
    const rows = _cdRows();
    if (!rows.length) return;
    const clamped = Math.max(0, Math.min(Number(pos) || 0, rows.length - 1));
    const row = rows[clamped];
    if (!row) return;

    selState.rowPos = clamped;
    selState.srcIdx = Number(row.dataset.idx);
    _cdApplySelection();

    if (opts.scroll !== false){
      try{ row.scrollIntoView({ block: 'nearest' }); }catch{}
    }
  }

  function _cdSelectSrcIdx(srcIdx, opts = {}){
    const rows = _cdRows();
    if (!rows.length) return;
    const row = rows.find(r => Number(r.dataset.idx) === Number(srcIdx));
    if (!row) return;
    selState.srcIdx = Number(srcIdx);
    selState.rowPos = rows.indexOf(row);
    _cdApplySelection();
    if (opts.scroll !== false){
      try{ row.scrollIntoView({ block:'center', behavior:'smooth' }); }catch{}
    }
  }

  function _cdVisibleDiffIndices(){
    const diff = state.diff || [];
    const out = [];
    for (let i = 0; i < diff.length; i++){
      const t = String(diff[i]?.diffType || 'CHANGED').toUpperCase();
      if (_cdTypeEnabled(t)) out.push(i);
    }
    return out;
  }

  function _cdJumpChange(dir){
    const vis = _cdVisibleDiffIndices();
    if (!vis.length) return;

    let curPos = -1;
    if (selState.srcIdx != null){
      curPos = vis.indexOf(Number(selState.srcIdx));
    }
    const nextPos = (curPos < 0) ? (dir > 0 ? 0 : vis.length - 1) : Math.max(0, Math.min(vis.length - 1, curPos + (dir > 0 ? 1 : -1)));
    const target = vis[nextPos];
    _cdSelectSrcIdx(target);

    // Center view on selection (compare mode)
    if (tlState.mode === 'compare' && state.diff?.[target]){
      try{ _cdPanToFrames(state.diff[target]._recInF, state.diff[target]._recOutF); }catch{}
    }
  }

  // ---------------------------------------------------------------------------
  // Smart Timeline Compare (OLD vs NEW)
  // ---------------------------------------------------------------------------
  function _cdFramesToTC(fr, fps){
    fr = Math.max(0, Math.round(fr || 0));
    const pad = (n) => String(n).padStart(2, '0');
    const hh = Math.floor(fr / (3600 * fps)); fr -= hh * 3600 * fps;
    const mm = Math.floor(fr / (60 * fps));   fr -= mm * 60 * fps;
    const ss = Math.floor(fr / fps);          fr -= ss * fps;
    const ff = Math.floor(Math.max(0, fr));
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
  }

  function _cdDiffKey(ev){
    const cn = (ev?.clipName || ev?.name || "").trim();
    const ri = String(ev?.recIn || "");
    const ro = String(ev?.recOut || "");
    // Prefer clipName + rec range; fallback to range only
    return cn ? `${cn}|${ri}|${ro}` : `${ri}|${ro}`;
  }

  function _cdGetFps(){
    return state.newRaw?.fps || state.oldRaw?.fps || 24;
  }

  // Guess timeline (record) base TC in frames for a cut, so video compare can map REC frames -> video seconds.
  // Prefer explicit sequence base frames when available (e.g. XMEML _seqBaseFrames).
  function _cdGuessSeqBaseFrames(raw){
    const fps = _cdGetFps();

    // Newer parsers may expose the sequence base directly on the parsed object
    try {
      const directRaw = Number(raw?._seqBaseFrames ?? raw?.seqBaseFrames ?? raw?._timelineBaseFrames ?? raw?.timelineBaseFrames);
      if (Number.isFinite(directRaw) && directRaw >= 0) return Math.round(directRaw);
    } catch {}

    const events = raw?.events;
    if (!Array.isArray(events) || !events.length) return null;

    let ev0 = null;
    for (let i=0; i<events.length; i++){
      const e = events[i];
      if (e && typeof e === 'object'){ ev0 = e; break; }
    }
    if (!ev0) return null;

    const directKeys = [
      '_seqBaseFrames','seqBaseFrames',
      '_timelineBaseFrames','timelineBaseFrames',
      '_timelineStartFrames','timelineStartFrames',
      'sequenceBaseFrames'
    ];
    for (const k of directKeys){
      const v = Number(ev0?.[k]);
      if (Number.isFinite(v) && v >= 0) return Math.round(v);
    }

    // Derive: base = recAbs - recRel (if parser stored relative rec frames)
    const recRel = Number(ev0?._recInFrames ?? ev0?.recInFrames ?? ev0?.timelineInFrames ?? ev0?.timeline_in_frames ?? ev0?.tlInFrames ?? ev0?.tl_in_frames);
    let recAbs = NaN;
    try{ recAbs = tcToFrames ? tcToFrames(ev0?.recIn || '', fps) : NaN; }catch{ recAbs = NaN; }
    if (Number.isFinite(recRel) && Number.isFinite(recAbs)){
      const base = Math.round(recAbs - recRel);
      return Math.max(0, base);
    }

    // Fallback: use min recIn across events.
    // If it's very close to an hour boundary, snap to that boundary; otherwise keep the true min.
    let minAbs = 1e18;
    for (const e of events){
      if (!e || typeof e !== 'object') continue;
      let f = NaN;
      try{ f = tcToFrames ? tcToFrames(e?.recIn || '', fps) : NaN; }catch{ f = NaN; }
      if (Number.isFinite(f) && f < minAbs) minAbs = f;
    }
    if (Number.isFinite(minAbs) && minAbs < 1e17){
      const hour = Math.max(1, Math.round(fps * 3600));
      const nearest = Math.round(minAbs / hour) * hour;
      const tol = Math.max(1, Math.round(fps * 2)); // 2 seconds tolerance
      if (Math.abs(minAbs - nearest) <= tol) return Math.max(0, nearest);
      return Math.max(0, Math.round(minAbs));
    }
    return null;
  }

  // Auto-set Video Compare start TCs from the cut timelines so the timeline and video are aligned by REC TC.
  // Only applies when user hasn't manually changed the start TC fields.
  function _vcAutoSyncStartTcFromCuts(opts = {}){
    const force = !!opts.force;
    if (!__vcUI.tcOld || !__vcUI.tcNew) return;

    // Need both cuts
    if (!state.oldRaw?.events?.length || !state.newRaw?.events?.length) return;

    const fps = _cdGetFps();
    const baseOldF = _cdGuessSeqBaseFrames(state.oldRaw);
    const baseNewF = _cdGuessSeqBaseFrames(state.newRaw);
    if (!Number.isFinite(baseOldF) || !Number.isFinite(baseNewF)) return;

    const autoOld = _cdFramesToTC(baseOldF, fps);
    const autoNew = _cdFramesToTC(baseNewF, fps);

    const curOld = String(__vcUI.tcOld.value || vcState.oldStartTc || '00:00:00:00').trim() || '00:00:00:00';
    const curNew = String(__vcUI.tcNew.value || vcState.newStartTc || '00:00:00:00').trim() || '00:00:00:00';

    const canOld = force || (!vcState._userStartOld && (curOld === '00:00:00:00' || curOld === String(vcState._autoOldStartTc || '')));
    const canNew = force || (!vcState._userStartNew && (curNew === '00:00:00:00' || curNew === String(vcState._autoNewStartTc || '')));

    let changed = false;
    if (canOld && autoOld && curOld !== autoOld){
      __vcUI.tcOld.value = autoOld;
      vcState._autoOldStartTc = autoOld;
      changed = true;
    }
    if (canNew && autoNew && curNew !== autoNew){
      __vcUI.tcNew.value = autoNew;
      vcState._autoNewStartTc = autoNew;
      changed = true;
    }

    if (changed){
      try{ _vcUpdateStartFrames(); }catch{}
      // Re-seek current selection to keep viewer aligned
      try{ if (selState.srcIdx != null) _vcApplySelection(); }catch{}
      try{ _vcRender(); }catch{}
    }
  }

  // ---------------------------------------------------------------------------
  // Video Compare helpers
  // ---------------------------------------------------------------------------
  function _vcSetHud(left, right){
    if (!__vcUI.hud) return;
    // Clean Feed: keep the video output clean (no HUD overlays)
    if (vcState.cleanFeed){
      if (vcState._lastHud !== '__clean__'){
        vcState._lastHud = '__clean__';
        __vcUI.hud.innerHTML = '';
      }
      return;
    }
    const l = left ? `<span class="pill">${(typeof esc==='function')?esc(left):left}</span>` : '';
    const r = right ? `<span class="pill">${(typeof esc==='function')?esc(right):right}</span>` : '';
    const html = `${l}${r}`;
    if (html === vcState._lastHud) return;
    vcState._lastHud = html;
    __vcUI.hud.innerHTML = html;
  }

  const __vcCleanFeed = (() => {
    let win = null;
    let ch = null;
    let timer = null;
    let lastSig = '';
    let remoteOpen = false;

    const isOpen = () => {
      try{ return !!(win && !win.closed); }catch{ return false; }
    };

    const syncBtn = () => {
      const on = isOpen() || remoteOpen;
      try{ __vcUI.view?.classList?.remove?.('is-cleanfeed'); }catch{}
      try{
        if (__vcUI.btnCleanFeed){
          __vcUI.btnCleanFeed.classList.toggle('is-active', on);
          __vcUI.btnCleanFeed.setAttribute('aria-pressed', on ? 'true' : 'false');
          __vcUI.btnCleanFeed.title = on ? 'Clean Feed on (click to close)' : 'Clean Feed off (click to open)';
        }
      }catch{}
      vcState.cleanFeed = false;
      vcState._lastHud = '';
    };

    const stopPump = () => {
      if (!timer) return;
      try{ clearInterval(timer); }catch{}
      timer = null;
    };

    const resetState = () => {
      stopPump();
      win = null;
      lastSig = '';
      remoteOpen = false;
      syncBtn();
    };

    const ensureChannel = () => {
      if (ch) return ch;
      try{
        ch = new BroadcastChannel('pfx_cleanfeed_cutdiff');
        ch.onmessage = (ev) => {
          const d = ev?.data;
          if (!d) return;
          if (d.type === 'ready'){
            remoteOpen = true;
            syncBtn();
            push(true);
          }else if (d.type === 'closing'){
            remoteOpen = false;
            if (!isOpen()) win = null;
            lastSig = '';
            syncBtn();
          }
        };
      }catch{}
      return ch;
    };

    const getLabel = () => {
      try{
        const oldNm = String(_vcGetRememberedName('old') || vcState.oldName || '').trim();
        const newNm = String(_vcGetRememberedName('new') || vcState.newName || '').trim();
        if (oldNm || newNm) return `Clean Feed · ${newNm || 'NEW'}${oldNm ? ` vs ${oldNm}` : ''}`;
      }catch{}
      return 'Clean Feed';
    };

    const packet = () => {
      const srcOld = String(__vcUI.vidOld?.currentSrc || __vcUI.vidOld?.src || vcState.oldUrl || '');
      const srcNew = String(__vcUI.vidNew?.currentSrc || __vcUI.vidNew?.src || vcState.newUrl || '');
      const oldT = Number(__vcUI.vidOld?.currentTime || 0) || 0;
      const newT = Number(__vcUI.vidNew?.currentTime || 0) || 0;
      const playing = !!(_vcIsPlaying());
      const rate = Number(vcState.rate || 1) || 1;
      const tc = String(__vcUI.inpTc?.value || '00:00:00:00').trim() || '00:00:00:00';
      return {
        type: 'sync',
        label: getLabel(),
        tc,
        srcOld,
        srcNew,
        oldT,
        newT,
        playing,
        rate,
        audio: !!vcState.audio,
        mode: String(vcState.mode || 'wipe'),
        wipe: Math.max(0, Math.min(1, Number(vcState.wipe) || 0.5)),
        fit: String(vcState.fit || 'contain'),
        showA: !!vcState.showA,
      };
    };

    const open = () => {
      try{
        if (isOpen()){
          remoteOpen = true;
          try{ win.focus(); }catch{}
          push(true);
          syncBtn();
          return true;
        }
      }catch{}
      const url = (chrome?.runtime?.getURL) ? chrome.runtime.getURL('clean_feed_cutdiff.html') : 'clean_feed_cutdiff.html';
      const w = 1280;
      const h = 720;
      const features = `popup=yes,width=${w},height=${h},resizable=yes,scrollbars=no`;
      try{ win = window.open(url, 'pfx_cleanfeed_cutdiff', features); }catch{ win = null; }
      ensureChannel();
      try{ ch?.postMessage({ type:'hello' }); }catch{}
      remoteOpen = !!win;
      syncBtn();
      if (!win) return false;
      stopPump();
      timer = setInterval(() => {
        try{
          if (!isOpen()){
            resetState();
            return;
          }
        }catch{}
        push(false);
      }, 160);
      push(true);
      return true;
    };

    const close = () => {
      const wasOn = isOpen() || remoteOpen;
      stopPump();
      try{ ensureChannel(); ch?.postMessage({ type:'shutdown' }); }catch{}
      try{ if (win && !win.closed) win.close(); }catch{}
      win = null;
      lastSig = '';
      remoteOpen = false;
      syncBtn();
      return wasOn;
    };

    const toggle = () => {
      if (isOpen() || remoteOpen) return close();
      return open();
    };

    const push = (force) => {
      try{
        if (!isOpen()) return;
        const p = packet();
        const sig = [
          p.srcOld, p.srcNew,
          Math.round(p.oldT * 1000), Math.round(p.newT * 1000),
          p.playing ? 1 : 0,
          p.rate, p.audio ? 1 : 0,
          p.mode, Math.round(p.wipe * 1000), p.fit, p.showA ? 1 : 0,
          p.tc
        ].join('|');
        if (!force && sig === lastSig) return;
        lastSig = sig;
        ensureChannel();
        ch?.postMessage(p);
      }catch{}
    };

    return { open, close, toggle, push, isOpen, syncBtn };
  })();

  function _vcSyncCleanFeed(){
    try{ __vcCleanFeed.syncBtn(); }catch{}
  }

  function _vcUpdateStartFrames(){
    const fps = _cdGetFps();
    const a = (__vcUI.tcOld?.value || vcState.oldStartTc || '00:00:00:00').trim();
    const b = (__vcUI.tcNew?.value || vcState.newStartTc || '00:00:00:00').trim();
    vcState.oldStartTc = a;
    vcState.newStartTc = b;
    try{ vcState._oldStartF = tcToFrames ? tcToFrames(a, fps) : 0; }catch{ vcState._oldStartF = 0; }
    try{ vcState._newStartF = tcToFrames ? tcToFrames(b, fps) : 0; }catch{ vcState._newStartF = 0; }
  }

  function _vcResizeCanvas(){
    if (!__vcUI.view || !__vcUI.canvas) return;
    const r = __vcUI.view.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const w = Math.max(2, Math.floor(r.width * dpr));
    const h = Math.max(2, Math.floor(r.height * dpr));
    if (__vcUI.canvas.width !== w) __vcUI.canvas.width = w;
    if (__vcUI.canvas.height !== h) __vcUI.canvas.height = h;

     // Keep wipe slider above the bottom player bar (CSS var)
     try{
       const barH = __vcUI.probar ? __vcUI.probar.getBoundingClientRect().height : 92;
       __vcUI.view.style.setProperty('--cd-vcmp-bar-h', `${Math.max(56, Math.round(barH))}px`);
     }catch{}
  }

  function _vcFitRect(w, h){
    const v = __vcUI.vidNew || __vcUI.vidOld;
    const vw = Number(v?.videoWidth || 0);
    const vh = Number(v?.videoHeight || 0);
    if (!vw || !vh) return { dx: 0, dy: 0, dw: w, dh: h };
    const vr = vw / vh;
    const cr = w / h;
    let dw, dh;
    if (vcState.fit === 'cover'){
      if (vr > cr){
        dh = h;
        dw = h * vr;
      }else{
        dw = w;
        dh = w / vr;
      }
    }else{
      // contain
      if (vr > cr){
        dw = w;
        dh = w / vr;
      }else{
        dh = h;
        dw = h * vr;
      }
    }
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    return { dx, dy, dw, dh };
  }

  function _vcDrawFitted(ctx, video, w, h){
    const r = _vcFitRect(w, h);
    try{ ctx.drawImage(video, r.dx, r.dy, r.dw, r.dh); }catch{}
    return r;
  }

  function _vcHasBoth(){
    return !!(vcState._readyOld && vcState._readyNew && __vcUI.vidOld && __vcUI.vidNew);
  }

  function _vcIsPlaying(){
    const v = __vcUI.vidNew;
    return !!(v && !v.paused && !v.ended);
  }

  function _vcSetPlayIcon(){
    if (!__vcUI.btnPlay) return;
    const playing = _vcIsPlaying();
    // SVG-based icon (avoid OS emoji glyphs). Toggle state via class.
    __vcUI.btnPlay.classList.toggle('is-active', playing);
    __vcUI.btnPlay.setAttribute('aria-pressed', playing ? 'true' : 'false');
    __vcUI.btnPlay.title = playing ? 'Pause' : 'Play';
  }

  function _vcApplyRate(){
    const r = Math.max(0.1, Math.min(4, Number(vcState.rate) || 1));
    vcState.rate = r;
    try{ if (__vcUI.vidNew) __vcUI.vidNew.playbackRate = r; }catch{}
    try{ if (__vcUI.vidOld) __vcUI.vidOld.playbackRate = r; }catch{}
  }

  function _vcCurrentTimelineFrame(){
    const fps = _cdGetFps();
    const t = Number(__vcUI.vidNew?.currentTime || 0);
    const fr = Math.round(t * fps);
    return fr + (vcState._newStartF || 0);
  }

  function _vcGoToTc(tc){
    const fps = _cdGetFps();
    const s = String(tc || '').trim();
    if (!s) return;
    let f = null;
    try{ f = tcToFrames ? tcToFrames(s, fps) : null; }catch{ f = null; }
    if (!Number.isFinite(f)) return;
    _vcSeekToTimelineFrames(f);
  }

  function _vcStopRaf(){
    if (vcState._raf) cancelAnimationFrame(vcState._raf);
    vcState._raf = 0;
  }

  // Highlight the table row whose REC range contains curF — without seeking video.
  function _cdSyncRowToPlayhead(curF){
    if (!Number.isFinite(curF)) return;
    const diff = state.diff;
    if (!Array.isArray(diff) || !diff.length) return;
    const fps = _cdGetFps();
    // Find the diff event whose rec range contains curF
    let matchIdx = null;
    for (let i = 0; i < diff.length; i++){
      const ev = diff[i];
      if (!ev) continue;
      const fIn  = Number.isFinite(ev._recInF)  ? ev._recInF  : null;
      const fOut = Number.isFinite(ev._recOutF) ? ev._recOutF : null;
      if (fIn == null || fOut == null) continue;
      if (curF >= fIn && curF < fOut){
        matchIdx = i;
        break;
      }
    }
    if (matchIdx == null || matchIdx === selState.srcIdx) return;
    // Update row highlight without triggering a video seek
    const rows = _cdRows();
    rows.forEach(r => { r.classList.remove('sel'); r.removeAttribute('aria-selected'); });
    const row = rows.find(r => Number(r.dataset.idx) === matchIdx);
    if (!row) return;
    row.classList.add('sel');
    row.setAttribute('aria-selected', 'true');
    selState.srcIdx = matchIdx;
    selState.rowPos = rows.indexOf(row);
    try{ row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }catch{}
    // Keep timeline segment highlight in sync
    try{ _cdApplyTimelineSelection(); }catch{}
  }

  function _vcStartRaf(){
    _vcStopRaf();
    let _lastSyncF = -1;
    const tick = () => {
      _vcRender();
      try{ _cdUpdateDiffTlPlayhead(); }catch(e){}
      // Sync table row highlight to playhead — throttled to once per frame change
      try{
        const curF = _vcCurrentTimelineFrame();
        if (curF !== _lastSyncF){
          _lastSyncF = curF;
          _cdSyncRowToPlayhead(curF);
        }
      }catch(e){}
      if (_vcIsPlaying()) vcState._raf = requestAnimationFrame(tick);
      else vcState._raf = 0;
    };
    vcState._raf = requestAnimationFrame(tick);
  }

  function _vcComputeDiff(){
    if (!__vcUI.canvas) return null;
    const w = __vcUI.canvas.width || 0;
    const h = __vcUI.canvas.height || 0;
    if (w < 2 || h < 2) return null;

    const fitR = _vcFitRect(w, h);
    const srcW = Math.max(2, Math.round(fitR.dw || w));
    const srcH = Math.max(2, Math.round(fitR.dh || h));

    // Downsample only the fitted image area so Diff/Heat keep the correct aspect
    // ratio and do not get stretched into the matte/padding region.
    const targetW = Math.min(720, srcW);
    const s = targetW / Math.max(1, srcW);
    const dw = Math.max(2, Math.floor(srcW * s));
    const dh = Math.max(2, Math.floor(srcH * s));

    if (!vcState._offA){
      vcState._offA = document.createElement('canvas');
      vcState._offB = document.createElement('canvas');
      vcState._offO = document.createElement('canvas');
    }
    const aC = vcState._offA;
    const bC = vcState._offB;
    const oC = vcState._offO;
    if (aC.width !== dw) aC.width = dw;
    if (aC.height !== dh) aC.height = dh;
    if (bC.width !== dw) bC.width = dw;
    if (bC.height !== dh) bC.height = dh;
    if (oC.width !== dw) oC.width = dw;
    if (oC.height !== dh) oC.height = dh;

    const aCtx = aC.getContext('2d', { willReadFrequently: true });
    const bCtx = bC.getContext('2d', { willReadFrequently: true });
    const oCtx = oC.getContext('2d', { willReadFrequently: true });
    if (!aCtx || !bCtx || !oCtx) return null;

    aCtx.clearRect(0,0,dw,dh);
    bCtx.clearRect(0,0,dw,dh);
    try{ aCtx.drawImage(__vcUI.vidOld, 0, 0, dw, dh); }catch{}
    try{ bCtx.drawImage(__vcUI.vidNew, 0, 0, dw, dh); }catch{}

    let aData, bData;
    try{ aData = aCtx.getImageData(0,0,dw,dh); }catch{ return null; }
    try{ bData = bCtx.getImageData(0,0,dw,dh); }catch{ return null; }

    const out = oCtx.createImageData(dw, dh);
    const A = aData.data;
    const B = bData.data;
    const O = out.data;
    let changed = 0;
    const px = dw * dh;
    const thr = 18; // threshold (0-255)
    const span = Math.max(1, 255 - thr);
    for (let i = 0; i < A.length; i += 4){
      const dr = Math.abs(A[i] - B[i]);
      const dg = Math.abs(A[i+1] - B[i+1]);
      const db = Math.abs(A[i+2] - B[i+2]);
      const d = (dr * 0.299) + (dg * 0.587) + (db * 0.114);
      const soft = Math.max(0, d - thr);
      const norm = soft / span;
      const boosted = soft > 0 ? Math.min(255, Math.round(Math.pow(norm, 0.65) * 255)) : 0;
      if (soft > 0) changed++;
      O[i] = boosted;
      O[i+1] = boosted;
      O[i+2] = boosted;
      O[i+3] = 255;
    }
    return { dw, dh, out, changed, px, scale: s, oC, fitR };
  }

  // --- Diff Graph (selected change) -----------------------------------------
  function _vcResizeGraph(){
    const g = __vcUI.diffGraph;
    if (!g) return;
    const r = g.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const cssW = Math.max(2, Math.floor(r.width));
    const cssH = Math.max(2, Math.floor(r.height));
    const w = cssW * dpr;
    const h = cssH * dpr;
    if (g.width !== w) { g.width = w; g.style.width = cssW + 'px'; }
    if (g.height !== h) { g.height = h; g.style.height = cssH + 'px'; }
  }

  function _vcComputeDiffPctQuick(aVid, bVid, opts = {}){
    const maxW = Math.max(80, Math.min(220, Number(opts.maxW) || 160));
    const thr = Math.max(6, Math.min(64, Number(opts.thr) || 18));
    const vw = Math.max(1, Number((bVid && bVid.videoWidth) || (aVid && aVid.videoWidth) || 0));
    const vh = Math.max(1, Number((bVid && bVid.videoHeight) || (aVid && aVid.videoHeight) || 0));
    if (!vw || !vh) return 0;

    const s = maxW / vw;
    const dw = Math.max(2, Math.floor(vw * s));
    const dh = Math.max(2, Math.floor(vh * s));

    if (!vcState._offA){
      vcState._offA = document.createElement('canvas');
      vcState._offB = document.createElement('canvas');
      vcState._offO = document.createElement('canvas');
    }
    const aC = vcState._offA;
    const bC = vcState._offB;
    if (aC.width !== dw) aC.width = dw;
    if (aC.height !== dh) aC.height = dh;
    if (bC.width !== dw) bC.width = dw;
    if (bC.height !== dh) bC.height = dh;

    const aCtx = aC.getContext('2d', { willReadFrequently: true });
    const bCtx = bC.getContext('2d', { willReadFrequently: true });
    if (!aCtx || !bCtx) return 0;

    try{ aCtx.drawImage(aVid, 0, 0, dw, dh); }catch{}
    try{ bCtx.drawImage(bVid, 0, 0, dw, dh); }catch{}

    let A = null, B = null;
    try{ A = aCtx.getImageData(0,0,dw,dh).data; }catch{ return 0; }
    try{ B = bCtx.getImageData(0,0,dw,dh).data; }catch{ return 0; }

    let changed = 0;
    const px = dw * dh;
    for (let i=0; i<A.length; i+=4){
      const d = (Math.abs(A[i]-B[i]) + Math.abs(A[i+1]-B[i+1]) + Math.abs(A[i+2]-B[i+2])) / 3;
      if (d > thr) changed++;
    }
    return (changed / Math.max(1, px)) * 100;
  }

  function _vcEnsureScanVideos(){
    // Use hidden scan videos so building the diff profile doesn't disturb playback/scrub.
    if (!vcState._scanOld){
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.style.display = 'none';
      vcState._scanOld = v;
    }
    if (!vcState._scanNew){
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.style.display = 'none';
      vcState._scanNew = v;
    }

    // Sync sources
    if (vcState._scanOld && vcState.oldUrl && vcState._scanOld.src !== vcState.oldUrl){
      try{ vcState._scanOld.src = vcState.oldUrl; vcState._scanOld.load(); }catch{}
    }
    if (vcState._scanNew && vcState.newUrl && vcState._scanNew.src !== vcState.newUrl){
      try{ vcState._scanNew.src = vcState.newUrl; vcState._scanNew.load(); }catch{}
    }
  }

  function _vcWaitMeta(v){
    return new Promise((res) => {
      if (!v) return res(false);
      if (v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0) return res(true);
      const onMeta = () => { try{ v.removeEventListener('loadedmetadata', onMeta); }catch{}; res(true); };
      try{ v.addEventListener('loadedmetadata', onMeta, { once:true }); }catch{ res(false); }
    });
  }

  function _vcTimelineFrameToTimes(f){
    const fps = _cdGetFps();
    _vcUpdateStartFrames();
    const offF = (vcState.chain ? (vcState.chainOffsetF || 0) : 0);
    const oldF = Number(f) + offF;
    const newF = Number(f);
    const oldT = Math.max(0, (oldF - (vcState._oldStartF || 0)) / fps);
    const newT = Math.max(0, (newF - (vcState._newStartF || 0)) / fps);
    return { oldT, newT };
  }

  function _vcSeekScanToTimelineFrame(f){
    const aVid = vcState._scanOld;
    const bVid = vcState._scanNew;
    if (!aVid || !bVid) return Promise.resolve(false);
    const t = _vcTimelineFrameToTimes(f);

    const seek1 = (v, sec) => new Promise((res) => {
      if (!v) return res(false);
      const cur = Number.isFinite(v.currentTime) ? v.currentTime : 0;
      if (Math.abs(cur - sec) < 0.0009) return res(true);
      const onSeeked = () => { try{ v.removeEventListener('seeked', onSeeked); }catch{}; res(true); };
      try{ v.addEventListener('seeked', onSeeked, { once:true }); }catch{ return res(false); }
      try{ v.currentTime = Math.max(0, sec); }catch{ res(false); }
    });

    return Promise.all([seek1(aVid, t.oldT), seek1(bVid, t.newT)]).then(() => true);
  }

  function _vcScheduleDiffScan(){
    if (__vcUI.diffGraph == null) return;
    if (vcState._scanT) clearTimeout(vcState._scanT);
    vcState._scanT = setTimeout(() => { try{ void _vcScanDiffProfile(); }catch{} }, 60);
  }

  async function _vcScanDiffProfile(){
    if (__vcUI.diffGraph == null) return;
    const r = vcState._loopRange;
    if (!r || !Number.isFinite(r.startF) || !Number.isFinite(r.endF)){
      vcState.profile = null;
      _vcDrawDiffGraph();
      return;
    }
    if (!_vcHasBoth()){
      vcState.profile = null;
      _vcDrawDiffGraph();
      return;
    }

    _vcEnsureScanVideos();
    const aVid = vcState._scanOld;
    const bVid = vcState._scanNew;
    if (!aVid || !bVid) return;

    await _vcWaitMeta(aVid);
    await _vcWaitMeta(bVid);

    const my = ++vcState._scanId;
    const fps = _cdGetFps();
    const startF = Math.round(r.startF);
    const endF = Math.max(startF + 1, Math.round(r.endF));
    const lenF = Math.max(1, endF - startF);
    const lenS = lenF / Math.max(1, fps);

    // Adaptive sampling: ~6 samples/sec, clamped
    const samples = Math.max(16, Math.min(80, Math.round(lenS * 6) + 2));
    const values = new Array(samples).fill(0);

    for (let i=0; i<samples; i++){
      if (my !== vcState._scanId) return; // cancelled
      const p = (samples <= 1) ? 0 : (i / (samples - 1));
      const f = startF + p * lenF;

      await _vcSeekScanToTimelineFrame(f);
      await new Promise((res) => requestAnimationFrame(res));

      values[i] = _vcComputeDiffPctQuick(aVid, bVid, { maxW: 160, thr: 18 });

      if ((i % 8) === 0){
        const partial = values.slice(0, i+1);
        let mx = 0;
        for (let k=0; k<partial.length; k++){ if (partial[k] > mx) mx = partial[k]; }
        vcState.profile = { startF, endF, values: partial, max: mx };
        _vcDrawDiffGraph();
      }
    }

    let maxV = 0;
    for (let i=0; i<values.length; i++){ if (values[i] > maxV) maxV = values[i]; }
    vcState.profile = { startF, endF, values, max: maxV };
    _vcDrawDiffGraph();
  }

  function _vcDrawDiffGraph(){
    const g = __vcUI.diffGraph;
    if (!g) return;
    _vcResizeGraph();
    const ctx = g.getContext('2d');
    if (!ctx) return;

    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const W = (g.width || 0) / dpr;  // CSS pixels
    const H = (g.height || 0) / dpr; // CSS pixels
    if (W < 2 || H < 2) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0,0,W,H);

    // Background
    try{ ctx.fillStyle = 'rgba(0,0,0,0.10)'; ctx.fillRect(0,0,W,H); }catch{}

    // Baseline
    try{ ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(0, H-1, W, 1); }catch{}

    const prof = vcState.profile;
    if (!prof || !Array.isArray(prof.values) || prof.values.length < 2) return;

    const vals = prof.values;
    const n = vals.length;
    let maxV = Number(prof.max) || 0;
    for (let i=0; i<n; i++){ const v = Number(vals[i]) || 0; if (v > maxV) maxV = v; }
    maxV = Math.max(8, Math.min(100, maxV || 8));

    // Line
    try{
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = Math.max(1, Math.round(W/520));
      ctx.beginPath();
      for (let i=0; i<n; i++){
        const x = (i / (n - 1)) * (W - 1);
        const v = Math.max(0, Math.min(maxV, Number(vals[i]) || 0));
        const y = (H - 2) - (v / maxV) * (H - 4);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }catch{}

    // Cursor (current NEW time mapped into profile range)
    try{
      const fps2 = _cdGetFps();
      const tf = Math.round((__vcUI.vidNew?.currentTime || 0) * fps2) + (vcState._newStartF || 0);
      const span = Math.max(1, (prof.endF - prof.startF) || 1);
      const x01 = Math.max(0, Math.min(1, (tf - prof.startF) / span));
      const x = x01 * W;
      ctx.fillStyle = 'rgba(205,170,255,0.75)';
      ctx.fillRect(Math.round(x), 0, 1, H);
    }catch{}
  }


  function _vcRender(){
    if (!__vcUI.canvas) return;
    const ctx = __vcUI.canvas.getContext('2d');
    if (!ctx){ return; }

    _vcResizeCanvas();
    try{ _vcDrawDiffGraph(); }catch{}
    const w = __vcUI.canvas.width;
    const h = __vcUI.canvas.height;

    ctx.clearRect(0,0,w,h);
    ctx.imageSmoothingEnabled = true;

    const hasA = !!(__vcUI.vidOld && vcState._readyOld);
    const hasB = !!(__vcUI.vidNew && vcState._readyNew);
    if (!hasA && !hasB){
      // If videos are missing, ensure the Setup panel is visible so user can load/relink.
      try{
        const target = __vcUI.sourcesCard || __vcUI.setup;
        if (target && target.style.display === 'none') target.style.display = '';
        __vcUI.btnSetup && __vcUI.btnSetup.classList.add('is-active');
      }catch{}
      _vcSetHud('Load OLD/NEW videos', '');
      return;
    }
    if (!hasA || !hasB){
      try{
        const target = __vcUI.sourcesCard || __vcUI.setup;
        if (target && target.style.display === 'none') target.style.display = '';
        __vcUI.btnSetup && __vcUI.btnSetup.classList.add('is-active');
      }catch{}
      _vcSetHud(hasA ? 'OLD ready' : 'Load OLD', hasB ? 'NEW ready' : 'Load NEW');
      try{ ctx.fillStyle = 'rgba(255,255,255,.08)'; ctx.fillRect(0,0,w,h); }catch{}
      return;
    }

    const fps = _cdGetFps();
    const t = __vcUI.vidNew?.currentTime || 0;
    const fr = Math.round(t * fps);
    const tc = _cdFramesToTC(fr + (vcState._newStartF || 0), fps);

    // Keep the pro TC box in sync (do not override while user is typing)
    try{
      if (__vcUI.inpTc && document.activeElement !== __vcUI.inpTc) __vcUI.inpTc.value = tc;
    }catch{}

    const fitR = _vcFitRect(w, h);

    if (vcState.mode === 'ab'){
      const v = vcState.showA ? __vcUI.vidOld : __vcUI.vidNew;
      try{ ctx.drawImage(v, fitR.dx, fitR.dy, fitR.dw, fitR.dh); }catch{}
      _vcSetHud(vcState.showA ? 'A: OLD' : 'B: NEW', `TC ${tc}`);
      __vcUI.wipe && (__vcUI.wipe.style.display = 'none');
      try{
        if (__vcUI.scrub && !vcState._scrubbing) __vcUI.scrub.value = String(__vcUI.vidNew?.currentTime || 0);
      }catch{}
      return;
    }

    if (vcState.mode === 'sbs'){
      // side-by-side: OLD and NEW each fit into half width
      const half = w / 2;
      const fitL = _vcFitRect(half, h);
      try{ ctx.save(); ctx.beginPath(); ctx.rect(0,0,half,h); ctx.clip(); ctx.drawImage(__vcUI.vidOld, fitL.dx, fitL.dy, fitL.dw, fitL.dh); ctx.restore(); }catch{}
      try{ ctx.save(); ctx.beginPath(); ctx.rect(half,0,half,h); ctx.clip(); ctx.drawImage(__vcUI.vidNew, half + fitL.dx, fitL.dy, fitL.dw, fitL.dh); ctx.restore(); }catch{}
      if (!vcState.cleanFeed){
        try{ ctx.strokeStyle = 'rgba(255,255,255,.22)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(half,0); ctx.lineTo(half,h); ctx.stroke(); }catch{}
      }
      _vcSetHud('Side-by-side: OLD | NEW', `TC ${tc}`);
      __vcUI.wipe && (__vcUI.wipe.style.display = 'none');
      try{
        if (__vcUI.scrub && !vcState._scrubbing) __vcUI.scrub.value = String(__vcUI.vidNew?.currentTime || 0);
      }catch{}
      return;
    }

    if (vcState.mode === 'split'){
      // left = OLD, right = NEW
      try{ ctx.save(); ctx.beginPath(); ctx.rect(0,0,w/2,h); ctx.clip(); ctx.drawImage(__vcUI.vidOld, fitR.dx, fitR.dy, fitR.dw, fitR.dh); ctx.restore(); }catch{}
      try{ ctx.save(); ctx.beginPath(); ctx.rect(w/2,0,w/2,h); ctx.clip(); ctx.drawImage(__vcUI.vidNew, fitR.dx, fitR.dy, fitR.dw, fitR.dh); ctx.restore(); }catch{}
      if (!vcState.cleanFeed){
        try{ ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(w/2,0); ctx.lineTo(w/2,h); ctx.stroke(); }catch{}
      }
      _vcSetHud('Split: OLD | NEW', `TC ${tc}`);
      __vcUI.wipe && (__vcUI.wipe.style.display = 'none');
      try{
        if (__vcUI.scrub && !vcState._scrubbing) __vcUI.scrub.value = String(__vcUI.vidNew?.currentTime || 0);
      }catch{}
      return;
    }

    if (vcState.mode === 'diff' || vcState.mode === 'heat'){
      // Visualize pixel differences (snapshot)
      const d = _vcComputeDiff();
      if (!d){
        _vcSetHud('Diff unavailable', `TC ${tc}`);
        return;
      }
      const pct = (d.changed / Math.max(1, d.px)) * 100;

      if (vcState.mode === 'diff'){
        // High-contrast grayscale diff inside the fitted image area only.
        const oCtx = d.oC.getContext('2d');
        try{ ctx.fillStyle = 'rgba(0,0,0,0.98)'; ctx.fillRect(0, 0, w, h); }catch{}
        oCtx.putImageData(d.out, 0, 0);
        ctx.drawImage(d.oC, 0, 0, d.dw, d.dh, d.fitR.dx, d.fitR.dy, d.fitR.dw, d.fitR.dh);
        _vcSetHud(`Diff ${pct.toFixed(1)}%`, `TC ${tc}`);
      }else{
        // Heat overlay on NEW with a clearer yellow/orange/red ramp.
        try{ ctx.drawImage(__vcUI.vidNew, fitR.dx, fitR.dy, fitR.dw, fitR.dh); }catch{}
        const oCtx = d.oC.getContext('2d');
        const O = d.out.data;
        for (let i=0; i<O.length; i+=4){
          const v = O[i];
          if (v <= 0){
            O[i] = 0;
            O[i+1] = 0;
            O[i+2] = 0;
            O[i+3] = 0;
            continue;
          }
          const n = Math.max(0, Math.min(1, v / 255));
          let r = 255, g = 180, b = 0;
          if (n < 0.33){
            const t2 = n / 0.33;
            r = 255;
            g = Math.round(240 - (40 * t2));
            b = Math.round(40 * (1 - t2));
          }else if (n < 0.66){
            const t2 = (n - 0.33) / 0.33;
            r = 255;
            g = Math.round(200 - (120 * t2));
            b = 0;
          }else{
            const t2 = (n - 0.66) / 0.34;
            r = 255;
            g = Math.round(Math.max(0, 80 - (80 * t2)));
            b = 0;
          }
          O[i] = r;
          O[i+1] = g;
          O[i+2] = b;
          O[i+3] = Math.max(0, Math.min(235, Math.round(28 + (n * 190))));
        }
        oCtx.putImageData(d.out, 0, 0);
        ctx.drawImage(d.oC, 0, 0, d.dw, d.dh, d.fitR.dx, d.fitR.dy, d.fitR.dw, d.fitR.dh);
        _vcSetHud(`Heat ${pct.toFixed(1)}%`, `TC ${tc}`);
      }
      __vcUI.wipe && (__vcUI.wipe.style.display = 'none');
      try{
        if (__vcUI.scrub && !vcState._scrubbing) __vcUI.scrub.value = String(__vcUI.vidNew?.currentTime || 0);
      }catch{}
      return;
    }

    // default: wipe
    const a = Math.max(0, Math.min(1, Number(vcState.wipe) || 0.5));
    try{ ctx.drawImage(__vcUI.vidOld, fitR.dx, fitR.dy, fitR.dw, fitR.dh); }catch{}
    try{
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, w * a, h);
      ctx.clip();
      ctx.drawImage(__vcUI.vidNew, fitR.dx, fitR.dy, fitR.dw, fitR.dh);
      ctx.restore();
      if (!vcState.cleanFeed){
        ctx.strokeStyle = 'rgba(205,170,255,.55)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(w*a, 0);
        ctx.lineTo(w*a, h);
        ctx.stroke();
      }
    }catch{}
    _vcSetHud(`Wipe ${Math.round(a*100)}%`, `TC ${tc}`);
    __vcUI.wipe && (__vcUI.wipe.style.display = '');

    try{ if (__vcCleanFeed?.isOpen?.()) __vcCleanFeed.push(false); }catch{}
  }

  function _vcSeekToTimelineFrames(timelineF){
    if (!_vcHasBoth()) return;
    const fps = _cdGetFps();
    _vcUpdateStartFrames();
    const f = Number(timelineF);
    if (!Number.isFinite(f)) return;

    const offF = (vcState.chain ? (vcState.chainOffsetF || 0) : 0);
    const oldF = f + offF;
    const oldT = Math.max(0, (oldF - (vcState._oldStartF || 0)) / fps);
    const newT = Math.max(0, (f - (vcState._newStartF || 0)) / fps);

    try{ __vcUI.vidOld.pause(); }catch{}
    try{ __vcUI.vidNew.pause(); }catch{}
    try{ __vcUI.vidOld.currentTime = oldT; }catch{}
    try{ __vcUI.vidNew.currentTime = newT; }catch{}
    _vcStopRaf();
    _vcRender();
  }

  function _vcApplySelection(){
    const idx = selState.srcIdx;
    if (idx == null) return;
    const ev = state.diff?.[idx];
    if (!ev) return;
    const fps = _cdGetFps();
    _cdEnsureFrames([ev], fps);

    const fIn = Number.isFinite(ev._recInF) ? ev._recInF : (tcToFrames ? tcToFrames(ev.recIn || '00:00:00:00', fps) : 0);
    const fOut= Number.isFinite(ev._recOutF) ? ev._recOutF : (tcToFrames ? tcToFrames(ev.recOut|| '00:00:00:00', fps) : fIn);
    vcState._loopRange = { startF: fIn, endF: Math.max(fIn, fOut) };

    // Frames chained (EditHero-style): align OLD to the best match from OLD cut.
    let chainOff = 0;
    if (vcState.chain){
      const ms = Number(ev.matchScore);
      if (ev.matchOldRecIn && Number.isFinite(ms) && ms >= 0.55){
        try{
          const mf = tcToFrames ? tcToFrames(ev.matchOldRecIn, fps) : NaN;
          if (Number.isFinite(mf)) chainOff = mf - fIn;
        }catch{}
      }
    }
    vcState.chainOffsetF = chainOff;
    try{ __vcUI.btnChain?.classList?.toggle?.('is-active', !!vcState.chain); }catch{}
    try{ __vcUI.btnChain?.setAttribute?.('aria-pressed', vcState.chain ? 'true' : 'false'); }catch{}

    _vcSeekToTimelineFrames(fIn);

    // Build a small diff profile for the selected change (Diff Graph).
    try{ _vcScheduleDiffScan(); }catch{}
  }

  function _vcStepFrames(delta){
    if (!_vcHasBoth()) return;
    const fps = _cdGetFps();
    const d = (Number(delta) || 0) / fps;
    try{ __vcUI.vidOld.pause(); __vcUI.vidNew.pause(); }catch{}
    _vcStopRaf();
    try{ __vcUI.vidNew.currentTime = Math.max(0, (__vcUI.vidNew.currentTime || 0) + d); }catch{}
    try{
      const fps = _cdGetFps();
      const off = (vcState.chain ? (vcState.chainOffsetF || 0) : 0) / fps;
      __vcUI.vidOld.currentTime = Math.max(0, (__vcUI.vidNew.currentTime || 0) + off);
    }catch{}
    _vcSetPlayIcon();
    _vcRender();
    try{ _cdUpdateDiffTlPlayhead(); }catch(e){}
  }

  function _vcPlayPause(){
    if (!_vcHasBoth()) return;
    const playing = _vcIsPlaying();
    if (playing){
      try{ __vcUI.vidOld.pause(); }catch{}
      try{ __vcUI.vidNew.pause(); }catch{}
      _vcStopRaf();
      _vcSetPlayIcon();
      _vcRender();
      return;
    }

    // align OLD to NEW before play (respect chain offset)
    try{
      const fps = _cdGetFps();
      const off = (vcState.chain ? (vcState.chainOffsetF || 0) : 0) / fps;
      __vcUI.vidOld.currentTime = Math.max(0, (__vcUI.vidNew.currentTime || 0) + off);
    }catch{}
    try{ __vcUI.vidOld.play(); }catch{}
    try{ __vcUI.vidNew.play(); }catch{}
    _vcSetPlayIcon();
    _vcStartRaf();
  }

  function _vcMaybeLoop(){
    if (!vcState.loop || !vcState._loopRange || !_vcHasBoth()) return;
    const fps = _cdGetFps();
    const r = vcState._loopRange;
    const startT = Math.max(0, (r.startF - (vcState._newStartF||0)) / fps);
    const endT   = Math.max(startT, (r.endF - (vcState._newStartF||0)) / fps);
    const t = __vcUI.vidNew?.currentTime || 0;
    if (t > endT + (1/fps)){
      try{ __vcUI.vidNew.currentTime = startT; }catch{}
      try{
        const offF = (vcState.chain ? (vcState.chainOffsetF || 0) : 0);
        __vcUI.vidOld.currentTime = Math.max(0, (r.startF + offF - (vcState._oldStartF||0)) / fps);
      }catch{}
    }
  }

  function _vcSyncDrift(){
    if (!_vcHasBoth()) return;
    const a = __vcUI.vidOld?.currentTime || 0;
    const b = __vcUI.vidNew?.currentTime || 0;
    const fps = _cdGetFps();
    const off = (vcState.chain ? (vcState.chainOffsetF || 0) : 0) / fps;
    const drift = a - (b + off);
    if (Math.abs(drift) > 0.25){
      try{ __vcUI.vidOld.currentTime = Math.max(0, b + off); }catch{}
    }
  }

  async function _vcLoad(which, file, opts={}){
    if (!file) return;
    const v = (which === 'old') ? __vcUI.vidOld : __vcUI.vidNew;
    if (!v) return;
    // revoke previous
    try{
      const prev = (which === 'old') ? vcState.oldUrl : vcState.newUrl;
      if (prev) pfxReleaseObjectUrl(prev);
    }catch{}

    const url = pfxAcquireObjectUrl(file);
    try{ _vcRememberName(which, file.name || ''); }catch{}
    try{
      if (which === 'old' && __vcUI.nameOld) __vcUI.nameOld.textContent = file.name || '(unnamed)';
      if (which === 'new' && __vcUI.nameNew) __vcUI.nameNew.textContent = file.name || '(unnamed)';
      // If user previously hid setup, keep it visible until at least one file is loaded.
      if (__vcUI.sourcesCard && __vcUI.sourcesCard.style.display === 'none') {
        // keep collapsed; user can open via Setup
      }
    }catch{}

    // Best-effort: if Media Root index knows this file, persist its handle for refresh-safe restore
    try{
      const finder = window.__PFX_MEDIA_FIND;
      const hit = (typeof finder === 'function') ? finder(file.name) : null;
      if (hit?.handle){
        // store without prompting
        if (!hit.handle.queryPermission || (await hit.handle.queryPermission({mode:'read'})) === 'granted'){
          await storeNamedFileHandle(__cdVcmpHandleKey(which, file.name), hit.handle);
        }
      }
    }catch{}

    if (which === 'old') vcState.oldUrl = url;
    else vcState.newUrl = url;

    if (which === 'old') vcState._readyOld = false;
    else vcState._readyNew = false;

    // Shared runtime fast path: .mov + native path → try direct ProRes stream (no transcode)
    const _nativePath = file?._nativePath || null;
    if (_nativePath && /\.mov$/i.test(file?.name || '')) {
      sharedMediaOpen(_nativePath).then(resp => {
        const d = resp?.data || {};
        if (d.canPlay && d.streamUrl) {
          if (which === 'old') vcState.oldUrl = d.streamUrl;
          else vcState.newUrl = d.streamUrl;
          try { v.src = d.streamUrl; v.load(); } catch {}
        }
      }).catch(() => {});
    }

    try{ v.src = url; v.load(); }catch{}
    _vcSetHud('Loading…', '');

    // ProRes / MXF fallback — if Chrome can't decode the file natively,
    // proxy it through the native helper.
    const nameEl = which === 'old' ? __vcUI.nameOld : __vcUI.nameNew;
    const baseName = file.name || '(unnamed)';
    let _xcJobId = null;
    loadVideoWithProxyFallback(v, file, url, {
      onProxying: () => {
        try{ _vcSetHud('ProRes → H.264  0%…', ''); }catch{}
        try{ if (nameEl) nameEl.textContent = `${baseName} — 0%…`; }catch{}
        try{ _xcJobId = _cdRegisterXcodeJob(baseName); }catch{}
      },
      onProgress: (pct) => {
        try{ _vcSetHud(`ProRes → H.264  ${pct}%…`, ''); }catch{}
        try{ if (nameEl) nameEl.textContent = `${baseName} — ${pct}%…`; }catch{}
        try{ if (_xcJobId !== null) _cdUpdateXcodeJob(_xcJobId, pct); }catch{}
      },
      onProxySuccess: (streamUrl) => {
        if (which === 'old') vcState.oldUrl = streamUrl;
        else vcState.newUrl = streamUrl;
        try{ _vcSetHud('ProRes → H.264 ▶', ''); }catch{}
        try{ if (nameEl) nameEl.textContent = baseName; }catch{}
        try{ if (_xcJobId !== null) _cdUpdateXcodeJob(_xcJobId, 100, { done: true }); }catch{}
      },
      onProxyFail: (hint) => {
        try{ _vcSetHud(hint, ''); }catch{}
        try{ if (nameEl) nameEl.textContent = baseName; }catch{}
        try{ if (_xcJobId !== null) _cdUpdateXcodeJob(_xcJobId, 0, { done: true, error: hint.split('—')[1]?.trim() || hint.slice(0, 60) }); }catch{}
      },
    });
  }

  function _vcInit(){
    __vcUI.card = document.getElementById('cutdiffVideoCompareCard');
    __vcUI.body = document.getElementById('cutdiffVcmpBody');
    __vcUI.btnToggle = document.getElementById('cutdiffVcmpToggle');
    __vcUI.btnSetup = document.getElementById('cutdiffVcmpSetupToggle');
    __vcUI.setup = document.getElementById('cutdiffVcmpSetup');
    __vcUI.sourcesCard = document.getElementById('cutdiffVcmpSourcesCard');
    __vcUI.nameOld = document.getElementById('cutdiffVcmpOldName');
    __vcUI.nameNew = document.getElementById('cutdiffVcmpNewName');
    __vcUI.inpOld = document.getElementById('cutdiffVcmpOldFile');
    __vcUI.inpNew = document.getElementById('cutdiffVcmpNewFile');
    __vcUI.btnOld = document.getElementById('cutdiffVcmpOldBrowse');
    __vcUI.btnNew = document.getElementById('cutdiffVcmpNewBrowse');
    __vcUI.tcOld  = document.getElementById('cutdiffVcmpOldStartTc');
    __vcUI.tcNew  = document.getElementById('cutdiffVcmpNewStartTc');
    __vcUI.scrub  = document.getElementById('cutdiffVcmpScrub');
    __vcUI.probar = document.getElementById('cutdiffVcmpProBar');
    __vcUI.btnFit = document.getElementById('cutdiffVcmpFit');
    __vcUI.btnFull= document.getElementById('cutdiffVcmpFull');
    __vcUI.btnPlay= document.getElementById('cutdiffVcmpPlay');
    __vcUI.btnPrevF = document.getElementById('cutdiffVcmpPrevF');
    __vcUI.btnNextF = document.getElementById('cutdiffVcmpNextF');
    __vcUI.btnLoop  = document.getElementById('cutdiffVcmpLoop');
    __vcUI.btnAudio = document.getElementById('cutdiffVcmpAudio');
    __vcUI.btnChain = document.getElementById('cutdiffVcmpChain');
    __vcUI.btnHome  = document.getElementById('cutdiffVcmpHome');
    __vcUI.btnEnd   = document.getElementById('cutdiffVcmpEnd');
    __vcUI.btnBack10= document.getElementById('cutdiffVcmpBack10');
    __vcUI.btnFwd10 = document.getElementById('cutdiffVcmpFwd10');
    __vcUI.selRate  = document.getElementById('cutdiffVcmpRate');
    __vcUI.inpTc    = document.getElementById('cutdiffVcmpTc');
    __vcUI.btnCleanFeed  = document.getElementById('cutdiffVcmpCleanFeed');
    __vcUI.modes  = __vcUI.card?.querySelector?.('.cd-vcmp-modes') || null;
    __vcUI.wipe   = document.getElementById('cutdiffVcmpWipe');
    __vcUI.view   = document.getElementById('cutdiffVcmpView');
    __vcUI.canvas = document.getElementById('cutdiffVcmpCanvas');
    __vcUI.diffGraph = document.getElementById('cutdiffVcmpDiffGraph');
    __vcUI.hud    = document.getElementById('cutdiffVcmpHud');
    __vcUI.vidOld = document.getElementById('cutdiffVcmpOldVid');
    __vcUI.vidNew = document.getElementById('cutdiffVcmpNewVid');

    // Reflect initial Clean Feed state in UI
    try{ _vcSyncCleanFeed(); }catch{}

    if (!__vcUI.card || !__vcUI.canvas) return;

    // Hawkins: dock Setup/Hide controls into the pro transport bar to maximize viewer height.
    // (We keep the same element IDs for existing wiring, but move them out of the header row.)
    try{
      const transport = __vcUI.card?.querySelector?.('.cd-vcmp-transport2');
      if (transport){
        if (__vcUI.btnSetup){
          __vcUI.btnSetup.classList.add('cd-vcmp-iconbtn');
          __vcUI.btnSetup.textContent = '⚙';
          __vcUI.btnSetup.setAttribute('aria-label', 'Setup');
          __vcUI.btnSetup.title = 'Setup';
          transport.appendChild(__vcUI.btnSetup);
        }
        if (__vcUI.btnToggle){
          __vcUI.btnToggle.classList.add('cd-vcmp-iconbtn');
          __vcUI.btnToggle.setAttribute('aria-label', 'Show/Hide');
          transport.appendChild(__vcUI.btnToggle);
        }
      }
    }catch{}

    // Keep Setup and Toggle both visible — panel is collapsible.
    try{
      if (__vcUI.btnSetup) __vcUI.btnSetup.style.display = '';
      if (__vcUI.btnToggle) __vcUI.btnToggle.style.display = '';
    }catch{}

    const _vcSetCollapseBtn = (collapsed) => {
      if (!__vcUI.btnToggle) return;
      __vcUI.btnToggle.textContent = collapsed ? '▲ Show' : '▼ Hide';
      __vcUI.btnToggle.title = collapsed ? 'Expand video compare' : 'Collapse video compare';
    };

    const persistKey = 'mps.cutdiff.vcmp.collapsed.v1';
    // Default: collapsed. Restore if user previously expanded it.
    let _vcPersistedCollapsed = true;
    try{ _vcPersistedCollapsed = localStorage.getItem(persistKey) !== '0'; }catch{}
    if (__vcUI.body) __vcUI.body.style.display = _vcPersistedCollapsed ? 'none' : '';
    _vcSetCollapseBtn(_vcPersistedCollapsed);

    const setupKey = 'mps.cutdiff.vcmp.setupOpen.v1';
    try{ vcState._setupPref = localStorage.getItem(setupKey) || ''; }catch{ vcState._setupPref = ''; }
    // Always show sources at boot (needed to load videos). It may auto-collapse after both videos are ready.
    const __vcTarget = __vcUI.sourcesCard || __vcUI.setup;
    if (__vcTarget) __vcTarget.style.display = '';
    __vcUI.btnSetup && __vcUI.btnSetup.classList.add('is-active');

    on?.(__vcUI.btnSetup, 'click', () => {
      const target = __vcUI.sourcesCard || __vcUI.setup;
      if (!target) return;
      const hidden = target.style.display === 'none';
      target.style.display = hidden ? '' : 'none';
      __vcUI.btnSetup?.classList?.toggle?.('is-active', hidden);
      const pref = hidden ? '1' : '0';
      try{ localStorage.setItem(setupKey, pref); }catch{}
      vcState._setupPref = pref;
      _vcResizeCanvas();
      _vcRender();
    });

    on?.(__vcUI.btnToggle, 'click', () => {
      if (!__vcUI.body) return;
      const wasCollapsed = __vcUI.body.style.display === 'none';
      __vcUI.body.style.display = wasCollapsed ? '' : 'none';
      const collapsed = !wasCollapsed;
      _vcSetCollapseBtn(collapsed);
      try{ localStorage.setItem(persistKey, collapsed ? '1' : '0'); }catch{}
      _vcResizeCanvas();
      _vcRender();
    });

    // browse wiring
    const __vcPickVideo = async (which) => {
      try {
        if (typeof window.showOpenFilePicker === 'function') {
          const handles = await window.showOpenFilePicker({
            multiple: false,
            excludeAcceptAllOption: false,
            types: [{
              description: 'Video files',
              accept: {
                'video/mp4': ['.mp4'],
                'video/quicktime': ['.mov'],
                'video/*': ['.mp4', '.mov']
              }
            }]
          });
          const h = Array.isArray(handles) ? handles[0] : null;
          if (h && h.kind === 'file') {
            const f = await h.getFile();
            if (f) {
              try { await storeNamedFileHandle(__cdVcmpHandleKey(which, f.name || ''), h); } catch {}
              _vcLoad(which, f);
              return;
            }
          }
        }
      } catch (err) {
        // Fall back to file input below.
      }
      try {
        const inp = (which === 'old') ? __vcUI.inpOld : __vcUI.inpNew;
        if (inp) inp.value = '';
        inp?.click?.();
      } catch {}
    };
    on?.(__vcUI.btnOld, 'click', () => { void __vcPickVideo('old'); });
    on?.(__vcUI.btnNew, 'click', () => { void __vcPickVideo('new'); });
    on?.(__vcUI.inpOld, 'change', (e) => { const f = e?.target?.files?.[0]; if (f) _vcLoad('old', f); });
    on?.(__vcUI.inpNew, 'change', (e) => { const f = e?.target?.files?.[0]; if (f) _vcLoad('new', f); });

    // timecode inputs
    on?.(__vcUI.tcOld, 'change', () => { vcState._userStartOld = true; _vcUpdateStartFrames(); _vcApplySelection(); });
    on?.(__vcUI.tcNew, 'change', () => { vcState._userStartNew = true; _vcUpdateStartFrames(); _vcApplySelection(); });

    // transport
    on?.(__vcUI.btnPlay, 'click', _vcPlayPause);
    on?.(__vcUI.btnPrevF, 'click', () => _vcStepFrames(-1));
    on?.(__vcUI.btnNextF, 'click', () => _vcStepFrames(1));
    on?.(__vcUI.btnLoop, 'click', () => {
      vcState.loop = !vcState.loop;
      __vcUI.btnLoop?.classList?.toggle?.('is-active', vcState.loop);
      __vcUI.btnLoop?.setAttribute?.('aria-pressed', vcState.loop ? 'true' : 'false');
      _vcRender();
    });
    on?.(__vcUI.btnAudio, 'click', () => {
      vcState.audio = !vcState.audio;
      try{ if (__vcUI.vidNew) __vcUI.vidNew.muted = !vcState.audio; }catch{}
      __vcUI.btnAudio && (__vcUI.btnAudio.textContent = 'A');
      __vcUI.btnAudio?.classList?.toggle?.('is-active', vcState.audio);
      __vcUI.btnAudio?.setAttribute?.('aria-pressed', vcState.audio ? 'true' : 'false');
    });

    on?.(__vcUI.btnChain, 'click', () => {
      vcState.chain = !vcState.chain;
      __vcUI.btnChain?.classList?.toggle?.('is-active', vcState.chain);
      __vcUI.btnChain?.setAttribute?.('aria-pressed', vcState.chain ? 'true' : 'false');
      // Re-apply selection so OLD aligns to the match (or unchains).
      try{ _vcApplySelection(); }catch{}
      _vcRender();
    });

    // pro controls: scrub
    if (__vcUI.scrub){
      const endScrub = () => { vcState._scrubbing = false; };
      on?.(__vcUI.scrub, 'pointerdown', () => { vcState._scrubbing = true; });
      on?.(__vcUI.scrub, 'pointerup', endScrub);
      on?.(__vcUI.scrub, 'pointercancel', endScrub);
      on?.(__vcUI.scrub, 'change', endScrub);
      on?.(__vcUI.scrub, 'input', (e) => {
        if (!_vcHasBoth()) return;
        const t = Math.max(0, Number(e?.target?.value || 0));
        try{ __vcUI.vidOld.pause(); __vcUI.vidNew.pause(); }catch{}
        _vcStopRaf();
        const fps = _cdGetFps();
        const off = (vcState.chain ? (vcState.chainOffsetF || 0) : 0) / fps;
        try{ __vcUI.vidNew.currentTime = t; }catch{}
        try{ __vcUI.vidOld.currentTime = Math.max(0, t + off); }catch{}
        _vcSetPlayIcon();
        _vcRender();
        _cdUpdateDiffTlPlayhead();
      });
    }

    // pro controls: fit/fill toggle
    const syncFitBtn = () => {
      if (!__vcUI.btnFit) return;
      const cover = vcState.fit === 'cover';
      __vcUI.btnFit.textContent = cover ? '▣' : '⤢';
      __vcUI.btnFit.classList.toggle('is-active', cover);
      __vcUI.btnFit.setAttribute('aria-pressed', cover ? 'true' : 'false');
    };
    on?.(__vcUI.btnFit, 'click', () => {
      vcState.fit = (vcState.fit === 'contain') ? 'cover' : 'contain';
      syncFitBtn();
      _vcRender();
    });

    // pro controls: fullscreen
    const syncFullBtn = () => {
      if (!__vcUI.btnFull) return;
      const onFs = !!document.fullscreenElement;
      __vcUI.btnFull.textContent = onFs ? '⤡' : '⛶';
      __vcUI.btnFull.setAttribute('aria-pressed', onFs ? 'true' : 'false');
    };
    on?.(__vcUI.btnFull, 'click', async () => {
      const el = __vcUI.view;
      if (!el) return;
      try{
        if (document.fullscreenElement) await document.exitFullscreen();
        else await el.requestFullscreen();
      }catch{}
      syncFullBtn();
      _vcResizeCanvas();
      _vcRender();
    });
    on?.(document, 'fullscreenchange', () => {
      syncFullBtn();
      _vcResizeCanvas();
      _vcRender();
    });

    // modes
    if (__vcUI.modes){
      on?.(__vcUI.modes, 'click', (e) => {
        const btn = e?.target?.closest?.('[data-mode]');
        const m = btn?.getAttribute?.('data-mode');
        if (!m) return;
        vcState.mode = m;
        if (m === 'ab') vcState.showA = true;
        __vcUI.modes.querySelectorAll?.('[data-mode]')?.forEach?.(b => b.classList.toggle('is-active', b.getAttribute('data-mode') === m));
        _vcRender();
        _cdUpdateDiffTlPlayhead();
      });
    }
    on?.(__vcUI.wipe, 'input', (e) => {
      const v = Number(e?.target?.value || 50);
      vcState.wipe = Math.max(0, Math.min(1, v / 100));
      _vcRender();
    });

    // click canvas in A/B to toggle
    on?.(__vcUI.canvas, 'click', () => {
      if (vcState.mode !== 'ab') return;
      vcState.showA = !vcState.showA;
      _vcRender();
    });

    // Diff graph click: jump within selected change
    if (__vcUI.diffGraph){
      on?.(__vcUI.diffGraph, 'click', (e) => {
        const prof = vcState.profile;
        if (!prof || !Number.isFinite(prof.startF) || !Number.isFinite(prof.endF)) return;
        const rect = __vcUI.diffGraph.getBoundingClientRect();
        const x01 = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
        const f = prof.startF + x01 * Math.max(1, (prof.endF - prof.startF));
        _vcSeekToTimelineFrames(f);
      });
    }

    // Pro playback controls (center cluster)
    if (__vcUI.selRate){
      try{ __vcUI.selRate.value = String(vcState.rate || 1); }catch{}
      on?.(__vcUI.selRate, 'change', () => {
        const r = Number(__vcUI.selRate.value || 1);
        vcState.rate = r;
        _vcApplyRate();
      });
    }

    on?.(__vcUI.btnHome, 'click', () => {
      const f = vcState._loopRange?.startF;
      _vcSeekToTimelineFrames(Number.isFinite(f) ? f : (vcState._newStartF || 0));
    });
    on?.(__vcUI.btnEnd, 'click', () => {
      const f = vcState._loopRange?.endF;
      _vcSeekToTimelineFrames(Number.isFinite(f) ? f : _vcCurrentTimelineFrame());
    });
    on?.(__vcUI.btnBack10, 'click', () => {
      const f = _vcCurrentTimelineFrame();
      _vcSeekToTimelineFrames(Math.max(0, f - 10));
    });
    on?.(__vcUI.btnFwd10, 'click', () => {
      const f = _vcCurrentTimelineFrame();
      _vcSeekToTimelineFrames(Math.max(0, f + 10));
    });

    const goTc = () => { try{ _vcGoToTc(__vcUI.inpTc?.value); }catch{} };
    on?.(__vcUI.btnCleanFeed, 'click', (e) => {
      e?.preventDefault?.();
      e?.stopPropagation?.();
      try{ __vcCleanFeed.toggle(); }catch{}
    });
    on?.(__vcUI.inpTc, 'keydown', (e) => {
      if (e.key === 'Enter'){
        e.preventDefault();
        e.stopPropagation();
        goTc();
        try{ __vcUI.inpTc.blur(); }catch{}
      }
    });

    // video events
    const onReady = (which) => () => {
      if (which === 'old') vcState._readyOld = true;
      else vcState._readyNew = true;

      // Update scrub range once NEW duration is known
      if (which === 'new' && __vcUI.scrub && Number.isFinite(__vcUI.vidNew?.duration) && __vcUI.vidNew.duration > 0){
        const fps = _cdGetFps();
        __vcUI.scrub.min = '0';
        __vcUI.scrub.max = String(__vcUI.vidNew.duration);
        __vcUI.scrub.step = String(Math.max(1/fps, 0.001));
        try{ __vcUI.scrub.value = String(__vcUI.vidNew.currentTime || 0); }catch{}
      }

      _vcResizeCanvas();
      _vcUpdateStartFrames();
      _vcApplyRate();
      _vcApplySelection();

      // Auto-collapse sources once both videos are ready (keeps UI clean), unless user pinned it open.
      const target = __vcUI.sourcesCard || __vcUI.setup;
      if (vcState._readyOld && vcState._readyNew && target && target.style.display !== 'none'){
        if (String(vcState._setupPref || '') !== '1'){
          target.style.display = 'none';
          __vcUI.btnSetup && __vcUI.btnSetup.classList.remove('is-active');
          vcState._setupPref = '0';
          try{ localStorage.setItem(setupKey, '0'); }catch{}
        }
      }

      _vcSetPlayIcon();
      _vcRender();
    };
    on?.(__vcUI.vidOld, 'loadedmetadata', onReady('old'));
    on?.(__vcUI.vidNew, 'loadedmetadata', onReady('new'));

    on?.(__vcUI.vidNew, 'timeupdate', () => {
      _vcMaybeLoop();
      _vcSyncDrift();
      try{
        if (__vcUI.scrub && !vcState._scrubbing) __vcUI.scrub.value = String(__vcUI.vidNew.currentTime || 0);
      }catch{}
    });
    on?.(__vcUI.vidNew, 'pause', () => { _vcSetPlayIcon(); _vcStopRaf(); _vcRender(); });
    on?.(__vcUI.vidNew, 'play',  () => { _vcSetPlayIcon(); _vcStartRaf(); });
    on?.(window, 'resize', () => { _vcResizeCanvas(); _vcRender(); });

    // Auto relink when Media Root changes or is rescanned (Settings → Media Manager)
    try{
      if (!window.__CD_VCMP_MEDIA_RELINK_LISTENER){
        window.__CD_VCMP_MEDIA_RELINK_LISTENER = true;
        const kick = () => { try{ void _vcRestoreRemembered(); }catch{} };
        document.addEventListener('pfx:mediaRescanned', kick);
        document.addEventListener('pfx:mediaRootChanged', kick);
      }
    }catch{}

    // Restore last remembered videos (refresh-safe)
    setTimeout(() => { void _vcRestoreRemembered(); }, 0);

    // Initial render
    _vcResizeCanvas();
    // Ensure icons match state
    _vcSetPlayIcon();
    if (__vcUI.btnAudio) __vcUI.btnAudio.textContent = 'A';
    __vcUI.btnAudio?.classList?.toggle?.('is-active', vcState.audio);
    __vcUI.btnLoop?.setAttribute?.('aria-pressed', vcState.loop ? 'true' : 'false');
    try{
      // init pro buttons
      const cover = vcState.fit === 'cover';
      __vcUI.btnFit && (__vcUI.btnFit.textContent = cover ? '▣' : '⤢');
      __vcUI.btnFit?.classList?.toggle?.('is-active', cover);
      __vcUI.btnFull && (__vcUI.btnFull.textContent = document.fullscreenElement ? '⤡' : '⛶');
    }catch{}
    _vcRender();
  }

  function _cdLoadFilters(){
    try{
      const raw = localStorage.getItem(CD_FILTER_KEY);
      if (!raw) return;
      const o = JSON.parse(raw);
      if (o && typeof o === 'object'){
        if (typeof o.NEW === 'boolean') filterState.NEW = o.NEW;
        if (typeof o.EXTENDED === 'boolean') filterState.EXTENDED = o.EXTENDED;
        if (typeof o.CHANGED === 'boolean') filterState.CHANGED = o.CHANGED;
        if (typeof o.REMOVED === 'boolean') filterState.REMOVED = o.REMOVED;
      }
    }catch{}
  }

  function _cdSaveFilters(){
    try{ localStorage.setItem(CD_FILTER_KEY, JSON.stringify(filterState)); }catch{}
  }

  function _cdTypeEnabled(t){
    const k = String(t || '').toUpperCase();
    if (k === 'NEW') return !!filterState.NEW;
    if (k === 'EXTENDED') return !!filterState.EXTENDED;
    if (k === 'CHANGED') return !!filterState.CHANGED;
    if (k === 'REMOVED') return !!filterState.REMOVED;
    return true;
  }

  function _cdToggleType(t){
    const k = String(t || '').toUpperCase();
    if (!(k in filterState)) return;
    // Always keep at least 1 type enabled
    const onCount = Object.values(filterState).filter(Boolean).length;
    if (filterState[k] && onCount <= 1) return;
    filterState[k] = !filterState[k];
    _cdSaveFilters();
    _cdSyncFilterUI();
    renderTable();
    _cdRenderTimelineActive(true);
    // Summary needs refresh (counts + duration impact)
    if (state.analyzed) _cdRenderSummary();
  }

  function _cdSyncFilterUI(){
    try{
      // Timeline legend buttons
      __tlUI.legend?.querySelectorAll?.('[data-filter]')?.forEach?.(btn => {
        const k = String(btn.getAttribute('data-filter') || '').toUpperCase();
        btn.classList.toggle('is-off', !_cdTypeEnabled(k));
      });
      // Summary chips (rendered dynamically)
      document.querySelectorAll('#cutdiffSummaryKpi [data-filter]')?.forEach?.(el => {
        const k = String(el.getAttribute('data-filter') || '').toUpperCase();
        el.classList.toggle('is-off', !_cdTypeEnabled(k));
      });
    }catch{}
  }

  function _cdEnsureFrames(list, fps){
    if (!Array.isArray(list)) return;
    for (const ev of list){
      if (ev == null || typeof ev !== 'object') continue;
      if (ev._recInF == null){
        try{ ev._recInF = tcToFrames ? tcToFrames(ev.recIn || "", fps) : 0; }
        catch{ ev._recInF = 0; }
      }
      if (ev._recOutF == null){
        try{ ev._recOutF = tcToFrames ? tcToFrames(ev.recOut || "", fps) : 0; }
        catch{ ev._recOutF = 0; }
      }
      if (ev._lenFrames == null){
        const len = Math.max(0, (ev._recOutF || 0) - (ev._recInF || 0));
        ev._lenFrames = len;
      }
    }
  }

  function _cdPanToFrames(fIn, fOut){
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const meta = tlState._meta || { startF:0, range:1 };
    const startF = Number(meta.startF) || 0;
    const range  = Math.max(1, Number(meta.range) || 1);
    const zoom   = clamp(Number(tlState.zoom) || 1, 1, 50);
    const span   = range / zoom;
    if (range <= span){
      tlState.pan = 0;
    }else{
      const a = Number.isFinite(fIn) ? fIn : startF;
      const b = Number.isFinite(fOut) ? fOut : a;
      const center = (a + b) / 2;
      const maxStart = startF + (range - span);
      const viewStart = clamp(center - span / 2, startF, maxStart);
      tlState.pan = clamp((viewStart - startF) / (range - span), 0, 1);
    }
    try{ localStorage.setItem('mps.cutdiff.difftl.pan',  String(tlState.pan)); }catch{}
    renderDiffTimeline(false);
  }// --- Cut Diff Compare Timeline: playhead sync ---
  function _cdUpdateDiffTlPlayhead() {
    try {
      if (!__tlUI || !__tlUI.playhead || !__tlUI.viewport || !__tlUI.laneNew) return;

      const viewStart = Number.isFinite(__tlUI._viewStartF) ? __tlUI._viewStartF : null;
      const spanF = Number.isFinite(__tlUI._viewSpanF) ? __tlUI._viewSpanF : null;
      if (viewStart == null || spanF == null || spanF <= 0) {
        __tlUI.playhead.style.display = 'none';
        return;
      }

      // Prefer Video Compare timeline frame; fallback to selected diff row.
      let curF = null;
      try { curF = _vcCurrentTimelineFrame(); } catch (e) {}
      if (!Number.isFinite(curF)) {
        try {
          const selIdx = (selState && Number.isFinite(selState.srcIdx)) ? selState.srcIdx : null;
          const row = (selIdx != null && state && state.diff && state.diff[selIdx]) ? state.diff[selIdx] : null;
          curF = (row && Number.isFinite(row._recInF)) ? row._recInF : null;
        } catch (e) {}
      }
      if (!Number.isFinite(curF)) {
        __tlUI.playhead.style.display = 'none';
        return;
      }

      const rawPct = (curF - viewStart) / spanF;
      const oob = rawPct < 0 || rawPct > 1;
      const pct = Math.max(0, Math.min(1, rawPct));

      // Auto-follow playhead: pan timeline to keep playhead in view during playback
      if (oob && tlState.zoom > 1 && tlState.mode === 'compare'){
        try{
          if (_vcIsPlaying()){
            const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
            const meta    = tlState._meta || { startF: 0, range: 1 };
            const sF      = Number(meta.startF) || 0;
            const range   = Math.max(1, Number(meta.range) || 1);
            const zoom    = Math.max(1, Number(tlState.zoom) || 1);
            const span    = range / zoom;
            const maxStart = sF + (range - span);
            // Center playhead in view
            const viewS   = clamp(curF - span / 2, sF, maxStart);
            const newPan  = (range - span) > 0 ? clamp((viewS - sF) / (range - span), 0, 1) : 0;
            tlState.pan = newPan;
            try{ localStorage.setItem('mps.cutdiff.difftl.pan', String(newPan)); }catch{}
            renderDiffTimeline(false);
            return; // renderDiffTimeline will re-call _cdUpdateDiffTlPlayhead
          }
        }catch{}
      }

      // Use bounding rects so positioning stays correct even when offsetParents/layout change.
      const vp = __tlUI.viewport;
      const laneNew = __tlUI.laneNew;
      const vpRect = vp.getBoundingClientRect();
      const laneRect = laneNew.getBoundingClientRect();
      const trackLeft = (laneRect.left - vpRect.left);
      const trackW = (laneRect.width || laneNew.clientWidth || 1);

      const x = trackLeft + pct * trackW - 1; // -1 to center 2px line

      __tlUI.playhead.style.display = 'block';
      __tlUI.playhead.style.opacity = oob ? '0.45' : '1';
      __tlUI.playhead.style.height = `${vp.clientHeight}px`;
      // subpixel transform for smooth realtime movement (avoid Math.round which can look frozen at wide zoom)
      __tlUI.playhead.style.transform = `translate3d(${x.toFixed(2)}px,0,0)`;
    } catch (e) {}
  }

  function _cdEnsureTimelineAudioRows(){
    const tracksRoot = document.getElementById('cutdiffDiffTlTracks');
    if (!tracksRoot) return;
    if (!CD_SHOW_AUDIO_TIMELINE){
      try{ document.getElementById('cutdiffDiffTlTrackOldAudio')?.remove?.(); }catch{}
      try{ document.getElementById('cutdiffDiffTlTrackNewAudio')?.remove?.(); }catch{}
      __tlUI.trackOldAudio = null;
      __tlUI.trackNewAudio = null;
      __tlUI.laneOldAudio = null;
      __tlUI.laneNewAudio = null;
      return;
    }
    const ensureRow = (id, trackName, label) => {
      let row = document.getElementById(id);
      if (!row){
        row = document.createElement('div');
        row.className = 'cd-track is-audio';
        row.id = id;
        row.setAttribute('data-track', trackName);
        row.innerHTML = `<div class="cd-track-label">${label}</div><div class="cd-track-lane" id="${id}Lane"></div>`;
        tracksRoot.appendChild(row);
      }
      return row;
    };
    __tlUI.trackOldAudio = ensureRow('cutdiffDiffTlTrackOldAudio', 'old-audio', 'OLD A');
    __tlUI.trackNewAudio = ensureRow('cutdiffDiffTlTrackNewAudio', 'new-audio', 'NEW A');
    __tlUI.laneOldAudio = document.getElementById('cutdiffDiffTlTrackOldAudioLane');
    __tlUI.laneNewAudio = document.getElementById('cutdiffDiffTlTrackNewAudioLane');
  }

  function _cdEnsureTimelineUI(){
    if (__tlUI.root) return true;
    __tlUI.root     = document.getElementById('cutdiffDiffTl');
    __tlUI.body     = document.getElementById('cutdiffDiffTlBody');
    __tlUI.title    = document.getElementById('cutdiffDiffTlTitle');
    __tlUI.btnModeCompare = document.getElementById('cutdiffTlModeCompare');
    __tlUI.btnModeNew     = document.getElementById('cutdiffTlModeNew');
    __tlUI.btnModeOld     = document.getElementById('cutdiffTlModeOld');
    __tlUI.btnModeXcode   = document.getElementById('cutdiffTlModeXcode');
    __tlUI.xcodePane      = document.getElementById('cutdiffXcodePane');
    __tlUI.legend   = document.getElementById('cutdiffDiffTlLegend');
    __tlUI.btnPrev  = document.getElementById('cutdiffDiffTlPrev');
    __tlUI.btnNext  = document.getElementById('cutdiffDiffTlNext');
    __tlUI.overview = document.getElementById('cutdiffDiffTlOverview');
    __tlUI.ovTrack  = document.getElementById('cutdiffDiffTlOverviewTrack');
    __tlUI.ovWindow = document.getElementById('cutdiffDiffTlOverviewWindow');
    __tlUI.viewport = document.getElementById('cutdiffDiffTlViewport');
    __tlUI.ruler    = document.getElementById('cutdiffDiffTlRuler');
    __tlUI.laneOld  = document.getElementById('cutdiffDiffTlOld');
    __tlUI.laneNew  = document.getElementById('cutdiffDiffTlNew');
    _cdEnsureTimelineAudioRows();
    __tlUI.origNew  = document.getElementById('cutdiffOrigTlNew');
    __tlUI.origOld  = document.getElementById('cutdiffOrigTlOld');
    __tlUI.btnFit   = document.getElementById('cutdiffDiffTlFit');
    __tlUI.btnToggle= document.getElementById('cutdiffDiffTlToggle');

	    if (!__tlUI.root || !__tlUI.viewport || !__tlUI.laneOld || !__tlUI.laneNew) return false;

    // Compare timeline playhead overlay (red)
    try {
      if (__tlUI.viewport && !__tlUI.playhead) {
        const ph = document.createElement('div');
        ph.className = 'cd-difftl-playhead';
        ph.id = 'cutdiffDiffTlPlayhead';
        ph.style.display = 'none';
        ph.style.transform = 'translateX(0px)';
        __tlUI.viewport.appendChild(ph);
        __tlUI.playhead = ph;
      }
    } catch (e) {}


	    // Icon-only toolbar buttons (Prev/Next/Fit/Hide) — compact like the red-box spec.
	    try{
	      setIconButton(__tlUI.btnPrev, 'prev', 'Previous change');
	      setIconButton(__tlUI.btnNext, 'next', 'Next change');
	      setTimelineFitToggleButton(__tlUI.btnFit, false, { fitLabel:'Fit timeline to view', unfitLabel:'Unfit timeline' });
	      // Toggle is updated via _cdSetTimelineCollapsed (chevUp/chevDown).
	    }catch(e){}

    // Restore collapse state
    try{
      const v = localStorage.getItem('mps.cutdiff.difftl.collapsed');
      tlState.collapsed = (v === '1');
    }catch{}
    _cdSetTimelineCollapsed(tlState.collapsed);

    // Restore mode (Compare / NEW / OLD)
    try{
      const m = localStorage.getItem('mps.cutdiff.difftl.mode');
      if (m === 'new' || m === 'old' || m === 'compare') tlState.mode = m;
    }catch{}
    _cdSetTimelineMode(tlState.mode, { skipSave:true, skipRender:true });

    // Restore compare zoom/pan + card height
    try{
      const z = Number(localStorage.getItem('mps.cutdiff.difftl.zoom'));
      const p = Number(localStorage.getItem('mps.cutdiff.difftl.pan'));
      if (Number.isFinite(z) && z > 0) tlState.zoom = z;
      if (Number.isFinite(p)) tlState.pan = p;
    }catch{}
    _cdRestoreTimelineRootHeight();

    // Mode buttons
    if (__tlUI.btnModeCompare) on?.(__tlUI.btnModeCompare, 'click', () => _cdSetTimelineMode('compare'));
    if (__tlUI.btnModeNew)     on?.(__tlUI.btnModeNew,     'click', () => _cdSetTimelineMode('new'));
    if (__tlUI.btnModeOld)     on?.(__tlUI.btnModeOld,     'click', () => _cdSetTimelineMode('old'));
    if (__tlUI.btnModeXcode)   on?.(__tlUI.btnModeXcode,   'click', () => _cdSetTimelineMode('transcode'));
    on?.(document.getElementById('cdXcodeClearBtn'), 'click', () => {
      for (const [id, j] of _cdXcodeJobs) { if (j.done) _cdXcodeJobs.delete(id); }
      _cdRenderXcodePane();
      _cdUpdateXcodeBadge();
    });

    // Filter legend
    if (__tlUI.legend){
      on?.(__tlUI.legend, 'click', (e) => {
        const btn = e.target?.closest?.('[data-filter]');
        if (!btn) return;
        const t = btn.getAttribute('data-filter');
        _cdToggleType(t);
      });
    }

    // Prev/Next change
    if (__tlUI.btnPrev) on?.(__tlUI.btnPrev, 'click', () => _cdJumpChange(-1));
    if (__tlUI.btnNext) on?.(__tlUI.btnNext, 'click', () => _cdJumpChange(+1));

    // Overview mini-map (compare mode)
    try{
      const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

      if (__tlUI.overview){
        __tlUI.overview.addEventListener('click', (ev) => {
          if (!mounted) return;
          if (tlState.mode !== 'compare') return;

          const seg = ev.target?.closest?.('.cd-ov-seg');
          if (seg){
            const idx = Number(seg.getAttribute('data-diff-idx'));
            if (Number.isFinite(idx)){
              // If filtered, enable that type then select
              const t = String(seg.getAttribute('data-diff-type') || '').toUpperCase();
              if (t && !_cdTypeEnabled(t)){
                filterState[t] = true;
                _cdSaveFilters();
                _cdSyncFilterUI();
                renderTable();
                _cdRenderTimelineActive(true);
                if (state.analyzed) _cdRenderSummary();
              }
              _cdSelectSrcIdx(idx);
              _cdPanToFrames(state.diff?.[idx]?._recInF, state.diff?.[idx]?._recOutF);
              return;
            }
          }

          const meta = tlState._meta || { startF:0, range:1 };
          const startF = Number(meta.startF) || 0;
          const range  = Math.max(1, Number(meta.range) || 1);
          const zoom   = clamp(Number(tlState.zoom) || 1, 1, 50);
          const span   = range / zoom;
          if (range <= span){ tlState.pan = 0; return; }

          const rect = __tlUI.overview.getBoundingClientRect();
          const x01 = clamp((ev.clientX - rect.left) / Math.max(1, rect.width), 0, 1);
          const maxStart = startF + (range - span);
          const viewStart = clamp(startF + x01 * range - span / 2, startF, maxStart);
          tlState.pan = clamp((viewStart - startF) / (range - span), 0, 1);
          try{ localStorage.setItem('mps.cutdiff.difftl.pan',  String(tlState.pan)); }catch{}
          renderDiffTimeline(false);
        });
      }

      if (__tlUI.ovWindow){
        __tlUI.ovWindow.addEventListener('pointerdown', (ev) => {
          if (!mounted) return;
          if (tlState.mode !== 'compare') return;
          if (ev.button != null && ev.button !== 0) return;
          __tlUI.ovWindow.setPointerCapture?.(ev.pointerId);
          const meta = tlState._meta || { startF:0, range:1 };
          const startF = Number(meta.startF) || 0;
          const range  = Math.max(1, Number(meta.range) || 1);
          const zoom   = clamp(Number(tlState.zoom) || 1, 1, 50);
          const span   = range / zoom;
          const denom  = Math.max(1, range - span);
          const leftFrac0 = (denom <= 1) ? 0 : (clamp(Number(tlState.pan) || 0, 0, 1) * denom) / range;
          tlState._ovDrag = { x0: ev.clientX, leftFrac0, startF, range, span };
          __tlUI.overview?.classList?.add?.('is-dragging');
        });
        const onMove = (ev) => {
          if (!mounted) return;
          if (tlState.mode !== 'compare') return;
          if (!tlState._ovDrag) return;
          const d = tlState._ovDrag;
          const rect = __tlUI.overview?.getBoundingClientRect?.();
          const w = Math.max(1, rect?.width || 1);
          const dx = ev.clientX - d.x0;
          const maxLeftFrac = Math.max(0, (d.range - d.span) / d.range);
          const leftFrac = clamp(d.leftFrac0 + (dx / w), 0, maxLeftFrac);
          const viewStart = d.startF + leftFrac * d.range;
          const denom = Math.max(1, d.range - d.span);
          tlState.pan = clamp((viewStart - d.startF) / denom, 0, 1);
          try{ localStorage.setItem('mps.cutdiff.difftl.pan',  String(tlState.pan)); }catch{}
          renderDiffTimeline(false);
        };
        const end = () => {
          tlState._ovDrag = null;
          __tlUI.overview?.classList?.remove?.('is-dragging');
        };
        __tlUI.ovWindow.addEventListener('pointermove', onMove);
        __tlUI.ovWindow.addEventListener('pointerup', end);
        __tlUI.ovWindow.addEventListener('pointercancel', end);
      }
    }catch{}

    // Sync initial filter UI
    _cdSyncFilterUI();

    // Fit (Compare = rerender; NEW/OLD = rebuild timeline to reset zoom/pan)
    if (__tlUI.btnFit){
      on?.(__tlUI.btnFit, 'click', () => {
        _cdToggleTimelineFit();
      });
    }

    if (__tlUI.btnToggle){
      on?.(__tlUI.btnToggle, 'click', () => {
        tlState.collapsed = !tlState.collapsed;
        try{ localStorage.setItem('mps.cutdiff.difftl.collapsed', tlState.collapsed ? '1' : '0'); }catch{}
        _cdSetTimelineCollapsed(tlState.collapsed);
        if (!tlState.collapsed) _cdRenderTimelineActive(true);
      });
    }

    // Click diff segment => select row (compare mode)
    on?.(__tlUI.viewport, 'click', (e) => {
      if (tlState.mode !== 'compare') return;
      const seg = e.target?.closest?.('.cd-seg');
      if (!seg) return;
      const idx = seg.getAttribute('data-diff-idx');
      if (idx == null) return;
      const srcIdx = Number(idx);
      if (!Number.isFinite(srcIdx)) return;

      // If this type is currently filtered out, enable it so the click makes sense.
      const t = String(seg.getAttribute('data-diff-type') || '').toUpperCase();
      if (t && !_cdTypeEnabled(t) && (t in filterState)){
        filterState[t] = true;
        _cdSaveFilters();
        _cdSyncFilterUI();
        renderTable();
        _cdRenderTimelineActive(true);
        if (state.analyzed) _cdRenderSummary();
      }

      selState.srcIdx = srcIdx;
      _cdApplySelection();
      _cdApplyTimelineSelection();

      // playhead sync
      _cdUpdateDiffTlPlayhead();
      _cdMarkDirty('select');
      // Scroll table to row
      try{
        const row = document.querySelector(`#cutdiffTable tbody tr[data-idx="${srcIdx}"]`);
        row?.scrollIntoView?.({ block:'center', behavior:'smooth' });
      }catch{}
    });

    // Rich hover tooltip on diff segments
    try{
      const tooltip = document.getElementById('cdTlTooltip');
      if (tooltip && __tlUI.viewport){
        on?.(__tlUI.viewport, 'pointermove', (e) => {
          if (!mounted) return;
          const seg = e.target?.closest?.('.cd-seg[data-diff-idx]');
          if (!seg || tlState.mode !== 'compare'){
            tooltip.classList.remove('is-visible');
            return;
          }
          const idx = Number(seg.getAttribute('data-diff-idx'));
          const ev = Number.isFinite(idx) ? state.diff?.[idx] : null;
          if (!ev){ tooltip.classList.remove('is-visible'); return; }

          const diffType = String(ev.diffType || 'CHANGED').toUpperCase();
          const risk = _cdRiskLevel(ev);
          const riskIcon = risk === 'high' ? '🔴' : risk === 'med' ? '🟡' : '🟢';
          const pct = Number.isFinite(Number(ev.matchScore)) ? Math.round(Number(ev.matchScore) * 100) : null;
          const confStr = pct !== null ? `${pct}%` : '—';
          const statusRaw = String(ev.status || 'New');
          const clipRaw = _cdCleanText(ev.clipName || ev.reel || '') || '(no clip)';
          const noteRaw = _cdCleanText(ev.note || '');
          const H = (s) => (typeof esc === 'function') ? esc(String(s)) : String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
          const noteSlice = noteRaw.slice(0, 80) + (noteRaw.length > 80 ? '…' : '');
          const notePart = noteRaw
            ? `<div class="cd-tl-tooltip-note">${H(noteSlice)}</div>`
            : '';
          const frames = Number(ev._lenFrames) || 0;
          const framesStr = frames ? ` • ${frames}f` : '';

          tooltip.innerHTML = `
            <div class="cd-tl-tooltip-badges">
              <span class="cd-tt-type cd-tt-type-${diffType.toLowerCase()}">${H(diffType)}</span>
              <span>${riskIcon}</span>
              <span class="cd-tl-tooltip-clip">${H(clipRaw)}</span>
            </div>
            <div class="cd-tl-tooltip-row">
              <span>${H(ev.recIn || '—')} → ${H(ev.recOut || '—')}${H(framesStr)}</span>
            </div>
            <div class="cd-tl-tooltip-row">
              <span>Conf: <b>${H(confStr)}</b></span>
              <span>Status: <b>${H(statusRaw)}</b></span>
            </div>
            ${notePart}
          `;

          const x = e.clientX + 16;
          const y = e.clientY - 12;
          const ttW = 270;
          tooltip.style.left = (x + ttW > window.innerWidth) ? `${e.clientX - ttW - 8}px` : `${x}px`;
          tooltip.style.top = `${Math.max(4, y)}px`;
          tooltip.classList.add('is-visible');
        });
        on?.(__tlUI.viewport, 'pointerleave', () => {
          tooltip.classList.remove('is-visible');
        });
      }
    }catch(e){}

    // ---------------------------------------------------------
    // NLE-style keyboard shortcuts (when viewport is focused)
    // - Arrow Up/Down : prev/next change
    // - Shift + Arrow Up/Down : (reserved for marker nav; no-op here)
    // - Arrow Left/Right : nudge 1 frame (Shift=10) when videos loaded; else pan
    // - Z : Fit (arms Z+Up/Down = zoom)
    // - Ctrl/Cmd + 0/=/- : Fit / Zoom in / Zoom out
    // - Space : Play/Pause (video compare)
    // ---------------------------------------------------------
    try{
      const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
      const isMac = (navigator.platform || '').toUpperCase().includes('MAC');
      const isActiveTab = () => (document.querySelector('.tabs .tab.active')?.getAttribute('data-main') === 'cutdiff');

      const saveView = () => {
        try{ localStorage.setItem('mps.cutdiff.difftl.zoom', String(tlState.zoom)); }catch{}
        try{ localStorage.setItem('mps.cutdiff.difftl.pan',  String(tlState.pan)); }catch{}
      };

      const fitTimeline = () => {
        _cdToggleTimelineFit();
      };

      const zoomAt = (dir, anchor01) => {
        if (tlState.mode !== 'compare') return;
        const meta = tlState._meta || { startF:0, range:1 };
        const startF = Number(meta.startF) || 0;
        const range  = Math.max(1, Number(meta.range) || 1);

        const prevZoom = clamp(Number(tlState.zoom) || 1, 1, 50);
        const nextZoom = clamp(prevZoom * (dir > 0 ? 1.12 : 1/1.12), 1, 50);

        const prevSpan = range / prevZoom;
        const nextSpan = range / nextZoom;

        const prevStart = startF + (range - prevSpan) * clamp(Number(tlState.pan) || 0, 0, 1);
        const anchorF = prevStart + clamp(anchor01, 0, 1) * prevSpan;

        let nextStart = anchorF - clamp(anchor01, 0, 1) * nextSpan;
        const maxStart = startF + (range - nextSpan);
        if (range <= nextSpan){
          nextStart = startF;
        }else{
          nextStart = clamp(nextStart, startF, maxStart);
        }

        tlState.zoom = nextZoom;
        tlState.pan  = (range <= nextSpan) ? 0 : clamp((nextStart - startF) / (range - nextSpan), 0, 1);
        saveView();
        renderDiffTimeline(false);
      };

      const panByPx = (dxPx) => {
        if (tlState.mode !== 'compare') return;
        const meta = tlState._meta || { startF:0, range:1 };
        const startF = Number(meta.startF) || 0;
        const range  = Math.max(1, Number(meta.range) || 1);
        const zoom   = clamp(Number(tlState.zoom) || 1, 1, 50);
        const span   = range / zoom;
        if (range <= span) return;
        const vw = __tlUI.viewport?.clientWidth || 1;
        const df = (dxPx / vw) * span;
        const curStart = startF + (range - span) * clamp(Number(tlState.pan) || 0, 0, 1);
        const nextStart = clamp(curStart - df, startF, startF + (range - span));
        tlState.pan = clamp((nextStart - startF) / (range - span), 0, 1);
        saveView();
        renderDiffTimeline(false);
      };

      // Focus viewport on click/drag so hotkeys always work.
      __tlUI.viewport.addEventListener('pointerdown', () => {
        try{ __tlUI.viewport.focus({ preventScroll:true }); }catch{}
      }, { passive:true });

      // ── CUT DIFF NLE keyboard state ────────────────────────────────────────
      let _cdKHeld      = false;
      // _cdRevActive and _cdRevRafId are hoisted to module scope so clear() can cancel them
      let _cdRevLastTs  = 0;
      let _cdRevSpeed   = 1;
      let _cdFwdSpeed   = 0;
      const _CD_SHUTTLE = [0.25, 0.5, 1, 2, 4, 8, 16];
      const _CD_MID     = 2; // index of ×1
      let _cdShuttleIdx = _CD_MID;

      function _cdGetFpsVal() { try { return _cdGetFps(); } catch { return 24; } }

      function _cdUpdateHud(msg) {
        let el = document.getElementById('cdKbHint');
        if (!el) {
          el = document.createElement('div');
          el.id = 'cdKbHint'; el.className = 'cd-kb-hint';
          document.body.appendChild(el);
        }
        if (msg) {
          el.textContent = msg;
          el.classList.add('cd-kb-hint-show');
          clearTimeout(el._t);
          el._t = setTimeout(() => el.classList.remove('cd-kb-hint-show'), 1100);
        }
      }

      function _cdStopReverse() {
        _cdRevActive = false;
        if (_cdRevRafId) { cancelAnimationFrame(_cdRevRafId); _cdRevRafId = null; }
      }

      function _cdRevTick(ts) {
        if (!_cdRevActive) return;
        if (_cdRevLastTs) {
          const elapsed = ts - _cdRevLastTs;
          const fps     = _cdGetFpsVal();
          const frames  = (elapsed / (1000 / fps)) * _cdRevSpeed;
          const newT    = Math.max(0, ((__vcUI.vidNew?.currentTime) || 0) - frames / fps);
          try { __vcUI.vidNew.currentTime = newT; } catch {}
          const off = (vcState.chain ? (vcState.chainOffsetF || 0) : 0) / fps;
          try { __vcUI.vidOld.currentTime = Math.max(0, newT + off); } catch {}
          try { _vcRender(); } catch {}
          try { _cdUpdateDiffTlPlayhead(); } catch {}
          if (newT <= 0) { _cdStopReverse(); _cdUpdateHud(''); return; }
        }
        _cdRevLastTs = ts;
        _cdRevRafId  = requestAnimationFrame(_cdRevTick);
      }

      function _cdStartReverse(speed) {
        _cdStopReverse();
        try { __vcUI.vidOld.pause(); } catch {}
        try { __vcUI.vidNew.pause(); } catch {}
        _cdRevSpeed = speed; _cdRevLastTs = 0; _cdRevActive = true;
        _cdRevRafId = requestAnimationFrame(_cdRevTick);
      }

      function _cdJklStop() {
        _cdStopReverse(); _cdFwdSpeed = 0; _cdShuttleIdx = _CD_MID;
        try { __vcUI.vidOld.playbackRate = 1; } catch {}
        try { __vcUI.vidNew.playbackRate = 1; } catch {}
        try { __vcUI.vidOld.pause(); } catch {}
        try { __vcUI.vidNew.pause(); } catch {}
        try { _vcSetPlayIcon(); } catch {}
        _cdUpdateHud('⏹ Stop');
      }

      function _cdJklL() {
        _cdStopReverse();
        if (_cdFwdSpeed === 0) { _cdShuttleIdx = _CD_MID; }
        else { _cdShuttleIdx = Math.min(_CD_SHUTTLE.length - 1, _cdShuttleIdx + 1); }
        _cdFwdSpeed = _CD_SHUTTLE[_cdShuttleIdx];
        try { __vcUI.vidOld.playbackRate = _cdFwdSpeed; } catch {}
        try { __vcUI.vidNew.playbackRate = _cdFwdSpeed; } catch {}
        try { __vcUI.vidOld.play(); } catch {}
        try { __vcUI.vidNew.play(); } catch {}
        try { _vcSetPlayIcon(); } catch {}
        _cdUpdateHud(`▶ ×${_cdFwdSpeed < 1 ? _cdFwdSpeed.toFixed(2).replace(/\.?0+$/,'') : _cdFwdSpeed}`);
      }

      function _cdJklJ() {
        if (_cdFwdSpeed > 0) {
          try { __vcUI.vidOld.playbackRate = 1; } catch {}
          try { __vcUI.vidNew.playbackRate = 1; } catch {}
          try { __vcUI.vidOld.pause(); } catch {}
          try { __vcUI.vidNew.pause(); } catch {}
          _cdFwdSpeed = 0; _cdShuttleIdx = _CD_MID;
          _cdStartReverse(1); _cdUpdateHud('◀ ×1');
        } else if (_cdRevActive) {
          _cdRevSpeed = Math.min(16, _cdRevSpeed * 2);
          _cdStopReverse(); _cdStartReverse(_cdRevSpeed);
          _cdUpdateHud(`◀ ×${_cdRevSpeed}`);
        } else {
          _cdStartReverse(1); _cdUpdateHud('◀ ×1');
        }
      }

      function _cdSeekBy(frames) {
        try { _vcStepFrames(frames); } catch {}
      }

      function _toggleCdKbOverlay() {
        let el = document.getElementById('cdKbOverlay');
        if (el) { el.remove(); return; }
        el = document.createElement('div');
        el.id = 'cdKbOverlay'; el.className = 'cd-kb-overlay';
        el.innerHTML = `
          <div class="cd-kb-overlay-box">
            <div class="cd-kb-overlay-title">CUT DIFF Keyboard Shortcuts <span class="cd-kb-overlay-close">✕</span></div>
            <div class="cd-kb-overlay-grid">
              <div class="cd-kb-section">Playback</div><div></div>
              <kbd>Space</kbd><span>Play / Pause</span>
              <kbd>K</kbd><span>Stop</span>
              <kbd>L</kbd><span>Play forward (press again = faster)</span>
              <kbd>J</kbd><span>Play reverse (press again = faster)</span>
              <kbd>K</kbd>+<kbd>L</kbd><span>Step +1 frame (hold K)</span>
              <kbd>K</kbd>+<kbd>J</kbd><span>Step −1 frame (hold K)</span>
              <div class="cd-kb-section">Navigation</div><div></div>
              <kbd>←</kbd><span>Step −1 frame</span>
              <kbd>→</kbd><span>Step +1 frame</span>
              <kbd>Shift+←</kbd><span>Jump −1 second</span>
              <kbd>Shift+→</kbd><span>Jump +1 second</span>
              <kbd>Alt+←</kbd><span>Jump −5 seconds</span>
              <kbd>Alt+→</kbd><span>Jump +5 seconds</span>
              <kbd>Shift+Alt+←</kbd><span>Jump −10 seconds</span>
              <kbd>Shift+Alt+→</kbd><span>Jump +10 seconds</span>
              <div class="cd-kb-section">Help</div><div></div>
              <kbd>?</kbd><span>Toggle this overlay</span>
            </div>
          </div>`;
        el.addEventListener('click', ev => {
          if (ev.target.closest('.cd-kb-overlay-close') || ev.target === el) el.remove();
        });
        document.body.appendChild(el);
      }

      // ── CUT DIFF NLE global keyboard handler (J/K/L + ?) ──────────────────
      document.addEventListener('keydown', e => {
        if (!isActiveTab()) return;
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;

        if (e.key === 'k' || e.key === 'K') _cdKHeld = true;

        const hasVid = (() => { try { return _vcHasBoth(); } catch { return false; } })();
        const onViewport = document.activeElement === __tlUI.viewport;

        switch (e.key) {
          case ' ':
            if (!onViewport) { e.preventDefault(); try { _vcPlayPause(); } catch {} }
            break;
          case 'j': case 'J':
            e.preventDefault();
            if (!hasVid) return;
            if (_cdKHeld) { _cdSeekBy(-1); _cdUpdateHud('◀ −1 fr'); }
            else _cdJklJ();
            break;
          case 'k': case 'K':
            e.preventDefault();
            if (hasVid) _cdJklStop();
            break;
          case 'l': case 'L':
            e.preventDefault();
            if (!hasVid) return;
            if (_cdKHeld) { _cdSeekBy(1); _cdUpdateHud('▶ +1 fr'); }
            else _cdJklL();
            break;
          case 'ArrowLeft':
            if (onViewport || !hasVid) return;
            e.preventDefault(); _cdJklStop();
            if      (e.shiftKey && e.altKey) { _cdSeekBy(-_cdGetFpsVal()*10); _cdUpdateHud('◀◀◀ −10s'); }
            else if (e.shiftKey)             { _cdSeekBy(-_cdGetFpsVal());     _cdUpdateHud('◀◀ −1s');   }
            else if (e.altKey)               { _cdSeekBy(-_cdGetFpsVal()*5);   _cdUpdateHud('◀◀◀ −5s');  }
            else                             { _cdSeekBy(-1);                   _cdUpdateHud('◀ −1 fr');  }
            break;
          case 'ArrowRight':
            if (onViewport || !hasVid) return;
            e.preventDefault(); _cdJklStop();
            if      (e.shiftKey && e.altKey) { _cdSeekBy(_cdGetFpsVal()*10);  _cdUpdateHud('▶▶▶ +10s'); }
            else if (e.shiftKey)             { _cdSeekBy(_cdGetFpsVal());      _cdUpdateHud('▶▶ +1s');   }
            else if (e.altKey)               { _cdSeekBy(_cdGetFpsVal()*5);    _cdUpdateHud('▶▶▶ +5s');  }
            else                             { _cdSeekBy(1);                    _cdUpdateHud('▶ +1 fr');  }
            break;
          case '?':
            e.preventDefault();
            _toggleCdKbOverlay();
            break;
        }
      });

      document.addEventListener('keyup', e => {
        if (e.key === 'k' || e.key === 'K') _cdKHeld = false;
      });

      __tlUI.viewport.addEventListener('keydown', (e) => {
        if (!mounted) return;
        if (!isActiveTab()) return;

        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;

        const k = e.key;
        const now = Date.now();
        const zHeld = now < (tlState._zHeldUntil || 0);
        const mod = isMac ? e.metaKey : e.ctrlKey;

        // User-configurable shortcuts (Settings → Keyboard Shortcuts)
        try{
          const act = resolveShortcutAction(e, [
            'zoom_fit','zoom_in','zoom_out',
            'play_toggle',
            'step_back','step_forward',
            'step_back_fine','step_forward_fine',
            'nav_prev','nav_next',
            'home','end'
          ], { cfg: getShortcutsConfig() });

          if (act){
            if (e.cancelable) e.preventDefault();

            if (act === 'zoom_fit'){
              tlState._zHeldUntil = now + 900;
              fitTimeline();
              return;
            }
            if (act === 'zoom_in'){
              zoomAt(+1, 0.5);
              return;
            }
            if (act === 'zoom_out'){
              zoomAt(-1, 0.5);
              return;
            }
            if (act === 'play_toggle'){
              try{ _vcPlayPause(); }catch{}
              return;
            }

            if (act === 'nav_prev'){
              if (zHeld) zoomAt(+1, 0.5);
              else _cdJumpChange(-1);
              return;
            }
            if (act === 'nav_next'){
              if (zHeld) zoomAt(-1, 0.5);
              else _cdJumpChange(+1);
              return;
            }

            if (act === 'home'){
              if (tlState.mode === 'compare'){
                tlState.pan = 0;
                saveView();
                renderDiffTimeline(false);
              }
              return;
            }
            if (act === 'end'){
              if (tlState.mode === 'compare'){
                tlState.pan = 1;
                saveView();
                renderDiffTimeline(false);
              }
              return;
            }

            if (act === 'step_back' || act === 'step_forward'){
              const dir = (act === 'step_back') ? -1 : 1;
              const stepF = e.shiftKey ? 10 : 1;
              const hasVid = (()=>{ try{ return _vcHasBoth(); }catch{ return false; } })();
              if (hasVid){
                try{ _vcStepFrames(dir * stepF); }catch{}
              }else{
                panByPx(dir * 140);
              }
              return;
            }

            if (act === 'step_back_fine' || act === 'step_forward_fine'){
              const dir = (act === 'step_back_fine') ? -1 : 1;
              const hasVid = (()=>{ try{ return _vcHasBoth(); }catch{ return false; } })();
              if (hasVid){
                try{ _vcStepFrames(dir * 1); }catch{}
              }
              return;
            }
          }
        }catch{}

        // Ctrl/Cmd zoom keys
        if (mod && !e.altKey){
          if (k === '0'){
            if (e.cancelable) e.preventDefault();
            fitTimeline();
            return;
          }
          if (k === '=' || k === '+'){
            if (e.cancelable) e.preventDefault();
            zoomAt(+1, 0.5);
            return;
          }
          if (k === '-'){
            if (e.cancelable) e.preventDefault();
            zoomAt(-1, 0.5);
            return;
          }
        }

        if (k === 'z' || k === 'Z'){
          if (e.cancelable) e.preventDefault();
          tlState._zHeldUntil = now + 900;
          fitTimeline();
          return;
        }

        // Space: play/pause compare videos (best-effort)
        if (k === ' '){
          if (e.cancelable) e.preventDefault();
          try{ _vcPlayPause(); }catch{}
          return;
        }

        // Arrow Up/Down: prev/next change (Z-held => zoom)
        if (k === 'ArrowUp'){
          if (e.cancelable) e.preventDefault();
          if (zHeld) zoomAt(+1, 0.5);
          else _cdJumpChange(-1);
          return;
        }
        if (k === 'ArrowDown'){
          if (e.cancelable) e.preventDefault();
          if (zHeld) zoomAt(-1, 0.5);
          else _cdJumpChange(+1);
          return;
        }

        // Home/End: jump to start/end of timeline view
        if (k === 'Home'){
          if (e.cancelable) e.preventDefault();
          if (tlState.mode === 'compare'){
            tlState.pan = 0;
            saveView();
            renderDiffTimeline(false);
          }
          return;
        }
        if (k === 'End'){
          if (e.cancelable) e.preventDefault();
          if (tlState.mode === 'compare'){
            tlState.pan = 1;
            saveView();
            renderDiffTimeline(false);
          }
          return;
        }

        // Arrow Left/Right: nudge frames (Shift=10) when video compare is loaded; else pan
        if (k === 'ArrowLeft' || k === 'ArrowRight'){
          if (e.cancelable) e.preventDefault();
          const dir = (k === 'ArrowLeft') ? -1 : 1;
          const stepF = e.shiftKey ? 10 : 1;
          const hasVid = (()=>{ try{ return _vcHasBoth(); }catch{ return false; } })();
          if (hasVid){
            try{ _vcStepFrames(dir * stepF); }catch{}
          }else{
            panByPx(dir * 140);
          }
          return;
        }

        // ',' and '.' fine nudge (1 frame)
        if (k === ',' || k === '.'){
          if (e.cancelable) e.preventDefault();
          const dir = (k === ',') ? -1 : 1;
          try{ _vcStepFrames(dir * 1); }catch{}
          return;
        }
      });
    }catch{}

    // Compare timeline: wheel zoom + drag pan
    try{
      // Wheel: zoom (default). Shift+wheel: pan.
      const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
      const saveView = () => {
        try{ localStorage.setItem('mps.cutdiff.difftl.zoom', String(tlState.zoom)); }catch{}
        try{ localStorage.setItem('mps.cutdiff.difftl.pan',  String(tlState.pan)); }catch{}
      };

      const applyZoomAt = (dir, anchor01) => {
        const meta = tlState._meta || { startF:0, range:1 };
        const startF = Number(meta.startF) || 0;
        const range  = Math.max(1, Number(meta.range) || 1);

        const prevZoom = clamp(Number(tlState.zoom) || 1, 1, 50);
        const nextZoom = clamp(prevZoom * (dir > 0 ? 1.12 : 1/1.12), 1, 50);

        const prevSpan = range / prevZoom;
        const nextSpan = range / nextZoom;

        const prevStart = startF + (range - prevSpan) * clamp(Number(tlState.pan) || 0, 0, 1);
        const anchorF = prevStart + clamp(anchor01, 0, 1) * prevSpan;

        let nextStart = anchorF - clamp(anchor01, 0, 1) * nextSpan;
        const maxStart = startF + (range - nextSpan);
        if (range <= nextSpan){
          nextStart = startF;
        }else{
          nextStart = clamp(nextStart, startF, maxStart);
        }

        tlState.zoom = nextZoom;
        tlState.pan  = (range <= nextSpan) ? 0 : clamp((nextStart - startF) / (range - nextSpan), 0, 1);
        saveView();
      };

      const panByPx = (dxPx) => {
        const meta = tlState._meta || { startF:0, range:1 };
        const startF = Number(meta.startF) || 0;
        const range  = Math.max(1, Number(meta.range) || 1);
        const zoom   = clamp(Number(tlState.zoom) || 1, 1, 50);
        const span   = range / zoom;
        if (range <= span) return;
        const vw = __tlUI.viewport?.clientWidth || 1;
        const df = (dxPx / vw) * span;
        const curStart = startF + (range - span) * clamp(Number(tlState.pan) || 0, 0, 1);
        const nextStart = clamp(curStart - df, startF, startF + (range - span));
        tlState.pan = clamp((nextStart - startF) / (range - span), 0, 1);
        saveView();
      };

      __tlUI.viewport.addEventListener('wheel', (ev) => {
        if (!mounted) return;
        if (tlState.mode !== 'compare') return;

        // Don't fight trackpad vertical scroll elsewhere.
        ev.preventDefault();

        const rect = __tlUI.viewport.getBoundingClientRect();
        const x01 = clamp((ev.clientX - rect.left) / Math.max(1, rect.width), 0, 1);

        if (ev.shiftKey){
          // Pan (horizontal)
          panByPx(ev.deltaY);
        }else{
          // Zoom
          const dir = (ev.deltaY > 0) ? -1 : 1;
          applyZoomAt(dir, x01);
        }

        renderDiffTimeline(false);
      }, { passive:false });

      // Drag pan
      __tlUI.viewport.addEventListener('pointerdown', (ev) => {
        if (!mounted) return;
        if (tlState.mode !== 'compare') return;
        if (ev.button != null && ev.button !== 0) return;
        __tlUI.viewport.setPointerCapture?.(ev.pointerId);
        tlState._drag = { x0: ev.clientX };
        __tlUI.viewport.classList.add('is-dragging');
      });
      __tlUI.viewport.addEventListener('pointermove', (ev) => {
        if (!mounted) return;
        if (tlState.mode !== 'compare') return;
        if (!tlState._drag) return;
        const dx = ev.clientX - tlState._drag.x0;
        tlState._drag.x0 = ev.clientX;
        panByPx(dx);
        renderDiffTimeline(false);
      });
      const endDrag = () => {
        tlState._drag = null;
        __tlUI.viewport?.classList?.remove?.('is-dragging');
      };
      __tlUI.viewport.addEventListener('pointerup', endDrag);
      __tlUI.viewport.addEventListener('pointercancel', endDrag);
      __tlUI.viewport.addEventListener('pointerleave', endDrag);
    }catch{}

    // Persist timeline card height + re-render on resize
    try{
      if (!tlState._resizeObs && window.ResizeObserver){
        let raf = 0;
        tlState._resizeObs = new ResizeObserver(() => {
          if (!mounted) return;
          if (raf) cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            try{
              localStorage.setItem(CD_DIFFTL_HEIGHT_STORAGE_KEY, String(__tlUI.root?.clientHeight || 0));
              localStorage.setItem(CD_DIFFTL_HEIGHT_REV_KEY, CD_DIFFTL_HEIGHT_REV);
            }catch{}
            _cdRenderTimelineActive(false);
          });
        });
        tlState._resizeObs.observe(__tlUI.root);
      }
    }catch{}

    // Re-render on resize (keeps proportions tight)
    try{
      on?.(window, 'resize', () => {
        if (!mounted) return;
        _cdRenderTimelineActive(false);
      }, { passive:true });
    }catch{}

    return true;
  }

  function _cdSetTimelineCollapsed(flag){
    if (!__tlUI.root) return;
    __tlUI.root.classList.toggle('is-collapsed', !!flag);
	    if (__tlUI.btnToggle){
	      const lbl = flag ? 'Show timeline' : 'Hide timeline';
	      setIconButton(__tlUI.btnToggle, flag ? 'chevDown' : 'chevUp', lbl);
	    }
  }

  function _cdSetTimelineMode(mode, opts = {}){
    const m = (mode === 'new' || mode === 'old' || mode === 'compare' || mode === 'transcode') ? mode : 'compare';
    tlState.mode = m;

    // Persist
    if (!opts.skipSave){
      try{ localStorage.setItem('mps.cutdiff.difftl.mode', m); }catch{}
    }

    // Root state
    if (__tlUI.root) __tlUI.root.dataset.mode = m;

    // Buttons
    const setA = (btn, onFlag) => { try{ btn?.classList?.toggle?.('is-active', !!onFlag); }catch{} };
    setA(__tlUI.btnModeCompare, m === 'compare');
    setA(__tlUI.btnModeNew,     m === 'new');
    setA(__tlUI.btnModeOld,     m === 'old');
    setA(__tlUI.btnModeXcode,   m === 'transcode');

    // Title
    if (__tlUI.title){
      __tlUI.title.textContent =
        (m === 'compare')   ? 'Timeline Compare Map' :
        (m === 'new')       ? 'NEW Timeline (Original)' :
        (m === 'transcode') ? 'ProRes Transcode Queue' :
        'OLD Timeline (Original)';
    }

    // Visibility
    const isTl = m !== 'transcode';
    if (__tlUI.viewport) __tlUI.viewport.style.display = (m === 'compare' && isTl) ? '' : 'none';
    if (__tlUI.origNew)  __tlUI.origNew.style.display  = (m === 'new') ? '' : 'none';
    if (__tlUI.origOld)  __tlUI.origOld.style.display  = (m === 'old') ? '' : 'none';
    if (__tlUI.xcodePane) __tlUI.xcodePane.style.display = (m === 'transcode') ? '' : 'none';

    _cdSyncTimelineRootHeight({ mode: m });

    if (!opts.skipRender) _cdRenderTimelineActive(true);
    else _cdSyncTimelineFitBtn();
  }

  function _cdRenderTimelineActive(force){
    if (!_cdEnsureTimelineUI()) return;
    if (tlState.collapsed) return;
    if (tlState.mode === 'compare') renderDiffTimeline(!!force);
    else renderOrigTimeline(tlState.mode, { force: !!force });
  }

  function _cdBuildRuler(startF, endF, fps){
    if (!__tlUI.ruler) return;
    const w = __tlUI.ruler.clientWidth || 1;
    const range = Math.max(1, (endF - startF) || 1);
    // 5 ticks: 0,25,50,75,100%
    const ps = [0, 0.25, 0.5, 0.75, 1];
    __tlUI.ruler.innerHTML = ps.map(p => {
      const x = Math.round(p * w);
      const fr = Math.round(startF + p * range);
      const label = _cdFramesToTC(fr, fps);
      return `<div class="cd-tick" style="left:${x}px;"><div class="cd-tick-label" style="left:0;">${label}</div></div>`;
    }).join('');
  }

  function renderDiffTimeline(force){
    if (!_cdEnsureTimelineUI()) return;
    if (tlState.collapsed) return;

    const fps = _cdGetFps();
    _cdEnsureFrames(state.oldView, fps);
    _cdEnsureFrames(state.newView, fps);
    _cdEnsureFrames(state.diff, fps);

    const oldList = state.oldView || [];
    const newList = state.newView || [];
    const audioCmp = CD_SHOW_AUDIO_TIMELINE ? _cdGetAudioCompareData() : null;
    const oldAudioList = CD_SHOW_AUDIO_TIMELINE ? (audioCmp?.old || []) : [];
    const newAudioList = CD_SHOW_AUDIO_TIMELINE ? (audioCmp?.new || []) : [];
    if (CD_SHOW_AUDIO_TIMELINE){
      _cdEnsureFrames(oldAudioList, fps);
      _cdEnsureFrames(newAudioList, fps);
      _cdEnsureFrames(audioCmp?.diff, fps);
      _cdEnsureFrames(audioCmp?.removed, fps);
    }

    // If nothing loaded, show empty lanes
    if (!oldList.length && !newList.length){
      __tlUI.laneOld.innerHTML = '';
      __tlUI.laneNew.innerHTML = '';
      if (__tlUI.laneOldAudio) __tlUI.laneOldAudio.innerHTML = '';
      if (__tlUI.laneNewAudio) __tlUI.laneNewAudio.innerHTML = '';
      if (__tlUI.trackOldAudio) __tlUI.trackOldAudio.style.display = 'none';
      if (__tlUI.trackNewAudio) __tlUI.trackNewAudio.style.display = 'none';
      if (__tlUI.ruler) __tlUI.ruler.innerHTML = '';
      tlState.segByKey.clear();
      tlState.rowByKey.clear();
      return;
    }

    // Build diff maps (after analyze, highlights will show)
    const diff = state.diff || [];
    const diffByKey = new Map();
    const diffByClip = new Map();
    tlState.rowByKey.clear();
    for (let i = 0; i < diff.length; i++){
      const d = diff[i];
      const k = _cdDiffKey(d);
      const t = String(d?.diffType || 'CHANGED').toUpperCase();
      diffByKey.set(k, t);
      tlState.rowByKey.set(k, i);
      const cn = (d?.clipName || '').trim();
      if (cn){
        // prefer NEW > EXTENDED > CHANGED for visibility
        const prev = diffByClip.get(cn);
        const rank = (x) => x === 'NEW' ? 3 : (x === 'EXTENDED' ? 2 : 1);
        if (!prev || rank(t) > rank(prev)) diffByClip.set(cn, t);
      }
    }

    // Global range across both cuts (video only)
    let startF = Infinity;
    let endF   = 0;
    for (const ev of [...oldList, ...newList]){
      const a = Number(ev?._recInF) || 0;
      const b = Number(ev?._recOutF) || 0;
      if (a < startF) startF = a;
      if (b > endF) endF = b;
    }
    if (!Number.isFinite(startF)) startF = 0;
    let range = Math.max(1, endF - startF);

    // Prefer the true sequence start (e.g. FCPXML tcStart) so timelines match across tabs
    try{
      const seqBase = getSeqBaseFrames(state.newRaw || state.oldRaw, fps);
      if (Number.isFinite(seqBase)) startF = seqBase;
      range = Math.max(1, endF - startF);
    }catch{}

    // Persist meta for zoom/pan calculations
    tlState._meta = { startF, endF, range };

    // Compute view range from zoom/pan
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const zoom = clamp(Number(tlState.zoom) || 1, 1, 50);
    const span = range / zoom;
    const panN = clamp(Number(tlState.pan) || 0, 0, 1);
    const viewStart = (range <= span) ? startF : (startF + (range - span) * panN);
    const viewEnd   = viewStart + span;

    // Cache view mapping for playhead sync
    __tlUI._fps = fps;
    __tlUI._viewStartF = viewStart;
    __tlUI._viewEndF = viewEnd;
    __tlUI._viewSpanF = span;

    // Ruler
    _cdBuildRuler(viewStart, viewEnd, fps);

    // Render lanes
    // NOTE: In compare mode we may have multiple overlapping change segments (e.g. V1 + titles/overlays).
    // To keep the map readable we auto-stack segments into sub-rows inside each lane so they do not overlap.
    const makeSeg = (ev, clsExtra, diffIdx, diffType, layout) => {
      const a = Number(ev?._recInF) || 0;
      const b = Number(ev?._recOutF) || 0;

      // Clip to view range
      const aa = Math.max(a, viewStart);
      const bb = Math.min(b, viewEnd);
      const wFrames = Math.max(0, bb - aa);
      if (wFrames <= 0) return '';

      const left = ((aa - viewStart) / span) * 100;
      const w = (wFrames / span) * 100;
      const safeLeft = Math.max(0, Math.min(100, left));
      const safeW = Math.max(0.15, Math.min(100 - safeLeft, w));
      const trackInfo = ev?.trackLabel ? ` • ${ev.trackLabel}` : '';
      const title = esc ? esc(`${ev?.clipName || ''}${trackInfo}  ${ev?.recIn || ''} → ${ev?.recOut || ''}`) : `${ev?.clipName || ''}${trackInfo}  ${ev?.recIn || ''} → ${ev?.recOut || ''}`;
      const idxAttr = (diffIdx != null) ? ` data-diff-idx="${diffIdx}"` : '';
      const dt = diffType ? String(diffType).toUpperCase() : '';
      const typeAttr = dt ? ` data-diff-type="${dt}"` : '';
      const filtCls = (dt && !_cdTypeEnabled(dt)) ? ' is-filtered' : '';
      const baseCls = (!dt && !(String(clsExtra || '').trim())) ? ' is-base' : '';
      const extraStyle = (layout && Number.isFinite(layout.top) && Number.isFinite(layout.h))
        ? ` top:${Math.round(layout.top)}px; height:${Math.round(layout.h)}px; border-radius:${Math.round(layout.r || 8)}px;`
        : '';
      return `<div class="cd-seg${baseCls} ${clsExtra||''}${filtCls}" style="left:${safeLeft}%; width:${safeW}%;${extraStyle}" title="${title}"${idxAttr}${typeAttr}></div>`;
    };

    const _cdBuildStackedLane = (laneEl, items, opts = {}) => {
      if (!laneEl) return;
      const vis = [];
      const rowKeyFn = (typeof opts.rowKey === 'function') ? opts.rowKey : null;
      for (const it of (items || [])){
        const ev = it?.ev;
        const a = Number(ev?._recInF) || 0;
        const b = Number(ev?._recOutF) || 0;
        const aa = Math.max(a, viewStart);
        const bb = Math.min(b, viewEnd);
        if ((bb - aa) <= 0) continue;
        vis.push({ ev, clsExtra: it?.clsExtra || '', idx: it?.idx, dt: it?.dt, aa, bb, rowKey: rowKeyFn ? rowKeyFn(it) : null });
      }
      if (!vis.length){
        laneEl.innerHTML = '';
        try{ laneEl.style.height = ''; }catch{}
        return;
      }

      vis.sort((x,y) => (x.aa - y.aa) || (x.bb - y.bb));
      if (rowKeyFn){
        const keys = [];
        const seenKeys = new Set();
        for (const s of vis){
          const rawKey = s.rowKey == null ? '0' : String(s.rowKey);
          if (seenKeys.has(rawKey)) continue;
          seenKeys.add(rawKey);
          keys.push(rawKey);
        }
        keys.sort((a,b) => {
          const an = Number(a); const bn = Number(b);
          if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
          return String(a).localeCompare(String(b));
        });
        const keyToRow = new Map(keys.map((k, idx) => [k, idx]));
        for (const s of vis){
          const rk = s.rowKey == null ? '0' : String(s.rowKey);
          s.row = keyToRow.get(rk) ?? 0;
        }
      } else {
        const rowEnd = [];
        for (const s of vis){
          let row = 0;
          while (row < rowEnd.length && s.aa < rowEnd[row]) row++;
          if (row === rowEnd.length) rowEnd.push(s.bb);
          else rowEnd[row] = s.bb;
          s.row = row;
        }
      }

      const rows = Math.max(1, vis.reduce((m, s) => Math.max(m, Number(s.row) || 0), 0) + 1);
      const PAD = Number.isFinite(opts.pad) ? opts.pad : 3;
      const GAP = Number.isFinite(opts.gap) ? opts.gap : 2;
      const TARGET_H = Number.isFinite(opts.targetSegHeight) ? opts.targetSegHeight : 6;
      const BASE_H = Number.isFinite(opts.minHeight) ? opts.minHeight : 18;
      const MAX_H = Number.isFinite(opts.maxHeight) ? opts.maxHeight : 42;
      const needH = (PAD*2) + (rows*TARGET_H) + ((rows-1)*GAP);
      const laneH = Math.max(BASE_H, Math.min(MAX_H, needH));
      let segH = Math.floor((laneH - (PAD*2) - (GAP*(rows-1))) / rows);
      if (!Number.isFinite(segH) || segH < 2) segH = 2;
      const rad = (h) => Math.max(2, Math.min(8, Math.round(h * 0.75)));

      try{ laneEl.style.height = `${laneH}px`; }catch{}

      laneEl.innerHTML = vis.map(s => {
        const top = PAD + ((Number(s.row) || 0) * (segH + GAP));
        return makeSeg(s.ev, s.clsExtra, s.idx, s.dt, { top, h: segH, r: rad(segH) });
      }).filter(Boolean).join('');
    };

    // Removed segments (OLD only) — visualize editorial removals too.
    let removedList = state.removed || [];
    if ((!removedList || !removedList.length) && oldList.length && newList.length){
      try{ removedList = _cdComputeRemoved(oldList, newList, fps) || []; }catch{ removedList = []; }
    }
    const removedByKey = new Set();
    for (const r of (removedList || [])){
      try{ removedByKey.add(_cdDiffKey(r)); }catch{}
    }

    // OLD lane: show ONLY changes (REMOVED + matched OLD segments for diff rows)
    const oldItems = [];
    for (const ev of (removedList || [])){
      const k = _cdDiffKey(ev);
      if (!removedByKey.has(k)) continue;
      oldItems.push({ ev, clsExtra: ' is-diff-removed', idx: null, dt: 'REMOVED' });
    }
    for (let i = 0; i < diff.length; i++){
      const d = diff[i] || {};
      const dt = String(d?.diffType || 'CHANGED').toUpperCase();
      if (dt === 'NEW') continue;
      const oi = d?.matchOldRecIn;
      const oo = d?.matchOldRecOut;
      if (!oi || !oo) continue;
      const a = _cdTcNum(oi, fps);
      const b = _cdTcNum(oo, fps);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
      const pseudo = {
        clipName: (d?.matchOldClipName || d?.clipName || '').trim(),
        recIn: oi,
        recOut: oo,
        _recInF: a,
        _recOutF: b,
      };
      const cls = (dt === 'EXTENDED') ? 'is-diff-extended' : 'is-diff-changed';
      oldItems.push({ ev: pseudo, clsExtra: cls ? ` ${cls}` : '', idx: i, dt });
    }

    // NEW lane: show ONLY changes; clickable if diff
    tlState.segByKey.clear();
    const newItems = [];
    for (const ev of (newList || [])){
      const k = _cdDiffKey(ev);
      const t = diffByKey.get(k) || '';
      if (!t) continue;
      const cls =
        t === 'NEW' ? 'is-diff-new' :
        t === 'EXTENDED' ? 'is-diff-extended' :
        'is-diff-changed';
      const idx = tlState.rowByKey.get(k);
      const diffEv = (idx != null) ? (state.diff?.[idx] || null) : null;
      const risk = diffEv ? _cdRiskLevel(diffEv) : 'low';
      const riskCls = risk !== 'low' ? ` is-risk-${risk}` : '';
      newItems.push({ ev, clsExtra: (cls ? ` ${cls}` : '') + riskCls, idx: (idx != null ? idx : null), dt: t });
    }

    _cdBuildStackedLane(__tlUI.laneOld, oldItems);
    _cdBuildStackedLane(__tlUI.laneNew, newItems);

    if (__tlUI.trackOldAudio) __tlUI.trackOldAudio.style.display = 'none';
    if (__tlUI.trackNewAudio) __tlUI.trackNewAudio.style.display = 'none';
    if (__tlUI.laneOldAudio) __tlUI.laneOldAudio.innerHTML = '';
    if (__tlUI.laneNewAudio) __tlUI.laneNewAudio.innerHTML = '';

    // Build segByKey lookup (NEW lane only)
    try{
      const segs = __tlUI.laneNew.querySelectorAll('.cd-seg');
      segs.forEach(seg => {
        const idx = seg.getAttribute('data-diff-idx');
        if (idx == null) return;
        // For selection, we key by diff row index (stable)
        tlState.segByKey.set(String(idx), seg);
      });
    }catch{}

    _cdApplyTimelineSelection();

      // playhead sync
      _cdUpdateDiffTlPlayhead();

    // Overview window + segments (compare mode)
    _cdRenderOverview(startF, endF, fps);
    // Density heatmap + cluster badge
    try{ _cdRenderDensityBar(state.diff || [], startF, endF); }catch{}
    try{ _cdUpdateClusterBadge(state.diff || [], startF, endF); }catch{}
    try{ _cdSyncTimelineFitBtn(); }catch{}
    void force;
  }

  function _cdRenderOverview(startF, endF, fps){
    void fps;
    if (!__tlUI.overview || !__tlUI.ovTrack || !__tlUI.ovWindow) return;
    if (tlState.mode !== 'compare') return;

    const meta = tlState._meta || { startF, endF, range: Math.max(1, (endF - startF)) };
    const sF = Number(meta.startF) || 0;
    const eF = Number(meta.endF) || (Number(endF) || 0);
    const range = Math.max(1, Number(meta.range) || (eF - sF) || 1);

    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const zoom = clamp(Number(tlState.zoom) || 1, 1, 50);
    const span = range / zoom;
    const panN = clamp(Number(tlState.pan) || 0, 0, 1);
    const viewStart = (range <= span) ? sF : (sF + (range - span) * panN);

    // Window
    const leftPct = ((viewStart - sF) / range) * 100;
    const wPct = (span / range) * 100;
    __tlUI.ovWindow.style.left = `${Math.max(0, Math.min(100, leftPct))}%`;
    __tlUI.ovWindow.style.width = `${Math.max(2.5, Math.min(100, wPct))}%`;

       // Segments (diff + removed)
    const diff = state.diff || [];
    let removedList = state.removed || [];
    if ((!removedList || !removedList.length) && (state.oldView?.length || 0) && (state.newView?.length || 0))
      { try{ removedList = _cdComputeRemoved(state.oldView, state.newView, _cdGetFps()) || []; }catch{ removedList = []; } }

    if (!diff.length && !removedList.length){
      __tlUI.ovTrack.innerHTML = '';
      return;
    }

    const segs = [];
    for (let i = 0; i < diff.length; i++){
      const d = diff[i] || {};
      segs.push({ idx: String(i), dt: String(d?.diffType || 'CHANGED').toUpperCase(), a: Number(d?._recInF) || 0, b: Number(d?._recOutF) || 0, extraCls: '' });
    }
    for (let j = 0; j < removedList.length; j++){
      const d = removedList[j] || {};
      segs.push({ idx: 'r' + j, dt: 'REMOVED', a: Number(d?._recInF) || 0, b: Number(d?._recOutF) || 0, extraCls: '' });
    }


    const segHtml = segs.map((s) => {
      const a = Number(s.a) || 0;
      const b = Number(s.b) || 0;
      const w = Math.max(0, b - a);
      if (w <= 0) return '';
      const dt = String(s.dt || 'CHANGED').toUpperCase();
      const cls =
        dt === 'NEW' ? 'is-diff-new' :
        dt === 'EXTENDED' ? 'is-diff-extended' :
        dt === 'REMOVED' ? 'is-diff-removed' :
        'is-diff-changed';

      const left = ((a - sF) / range) * 100;
      const width = (w / range) * 100;
      const safeLeft = Math.max(0, Math.min(100, left));
      const safeW = Math.max(0.25, Math.min(100 - safeLeft, width));
      const filt = !_cdTypeEnabled(dt) ? ' is-filtered' : '';
      const extraCls = String(s.extraCls || '');
      return `<div class="cd-ov-seg ${cls}${extraCls}${filt}" style="left:${safeLeft}%; width:${safeW}%" data-diff-idx="${s.idx}" data-diff-type="${dt}" title="${esc ? esc(dt) : dt}"></div>`;
    }).filter(Boolean).join('');

    __tlUI.ovTrack.innerHTML = segHtml;
  }

  // ── Smart density heatmap ────────────────────────────────────────────────
  function _cdRenderDensityBar(diff, startF, endF){
    const bar = document.getElementById('cutdiffDensityBar');
    if (!bar) return;
    if (tlState.mode !== 'compare' || !diff.length){
      bar.innerHTML = '';
      return;
    }
    const range = Math.max(1, endF - startF);
    const N = 60;
    const buckets = Array.from({ length: N }, () => ({ count: 0, types: new Set() }));
    for (const d of diff){
      const a = Number(d?._recInF) || 0;
      const b = Number(d?._recOutF) || 0;
      const midF = (a + b) / 2;
      const bi = Math.min(N - 1, Math.max(0, Math.floor(((midF - startF) / range) * N)));
      buckets[bi].count++;
      buckets[bi].types.add(String(d?.diffType || 'CHANGED').toUpperCase());
    }
    const maxCount = Math.max(1, ...buckets.map(b => b.count));
    bar.innerHTML = buckets.map((bk, i) => {
      if (!bk.count) return '';
      const heightPct = Math.max(18, Math.round((bk.count / maxCount) * 88));
      const types = [...bk.types];
      const dom = types.includes('NEW') ? 'new' : types.includes('EXTENDED') ? 'extended' : types.includes('REMOVED') ? 'removed' : 'changed';
      const left = (i / N) * 100;
      const w = Math.max(0.6, (1 / N) * 100);
      return `<div class="cd-density-bucket has-${dom}" style="left:${left.toFixed(2)}%;width:${w.toFixed(2)}%;height:${heightPct}%" title="${bk.count} change${bk.count > 1 ? 's' : ''}"></div>`;
    }).filter(Boolean).join('');
  }

  // ── Smart cluster detection + badge ──────────────────────────────────────
  function _cdComputeClusters(diff, startF, endF){
    if (!diff.length) return [];
    const GAP_F = Math.max(24, Math.round((endF - startF) / 15));
    const sorted = diff
      .map((d, i) => ({ f: Number(d?._recInF) || 0, i }))
      .sort((a, b) => a.f - b.f);
    const clusters = [];
    let cur = null;
    for (const s of sorted){
      if (!cur || (s.f - cur.lastF) > GAP_F){
        cur = { start: s.f, lastF: s.f, count: 0 };
        clusters.push(cur);
      }
      cur.lastF = s.f;
      cur.count++;
    }
    return clusters;
  }

  function _cdUpdateClusterBadge(diff, startF, endF){
    const badge = document.getElementById('cdClusterInfo');
    if (!badge) return;
    if (tlState.mode !== 'compare' || !diff.length || !state.analyzed){
      badge.textContent = '';
      badge.classList.remove('has-clusters');
      return;
    }
    const clusters = _cdComputeClusters(diff, startF, endF);
    if (clusters.length > 1){
      badge.textContent = `• ${clusters.length} clusters`;
      badge.classList.add('has-clusters');
    } else {
      badge.textContent = '';
      badge.classList.remove('has-clusters');
    }
  }

  function _cdDestroyOrigTimeline(which){
    const w = (which === 'new' || which === 'old') ? which : 'new';
    const obj = tlState.orig?.[w];
    if (!obj) return;
    try{ obj.api?.destroy?.(); }catch{}
    obj.api = null;
    obj.cache = null;

    const root = (w === 'new') ? __tlUI.origNew : __tlUI.origOld;
    if (root) root.innerHTML = '';
  }

  function _cdBuildDiffMaps(){
    const diff = state.diff || [];
    const diffByKey = new Map();
    const diffByClip = new Map();
    const rowByKey = new Map();
    const rank = (x) => x === 'NEW' ? 3 : (x === 'EXTENDED' ? 2 : 1);

    for (let i = 0; i < diff.length; i++){
      const d = diff[i];
      const k = _cdDiffKey(d);
      const t = String(d?.diffType || 'CHANGED').toUpperCase();
      diffByKey.set(k, t);
      rowByKey.set(k, i);
      const cn = (d?.clipName || '').trim();
      if (!cn) continue;
      const prev = diffByClip.get(cn);
      if (!prev || rank(t) > rank(prev)) diffByClip.set(cn, t);
    }
    return { diffByKey, diffByClip, rowByKey };
  }

  function _cdAllocateLanes(clips){
    const sorted = [...clips].sort((a, b) => (a.start - b.start) || (a.end - b.end));
    const laneEnd = [];
    for (const c of sorted){
      let lane = -1;
      for (let i = 0; i < laneEnd.length; i++){
        if (c.start >= laneEnd[i]){ lane = i; break; }
      }
      if (lane === -1){ lane = laneEnd.length; laneEnd.push(c.end); }
      else laneEnd[lane] = c.end;
      c.track = lane + 1;
    }
    return Math.max(1, laneEnd.length);
  }

  function _cdBuildOrigTimelineCache(which, list, fps){
    const { diffByKey, diffByClip, rowByKey } = _cdBuildDiffMaps();
    const clips = [];
    const keyToId = new Map();
    const idToDiffIdx = new Map();
    const clipNameToId = new Map();

    let timeStart = Infinity;
    let timeEnd = -Infinity;
    let trackCount = 1;

    const hasExplicitTrack = list.some(ev =>
      ev?.trackIndex != null || ev?.track != null || ev?.vTrack != null || ev?.videoTrack != null
    );

    for (let i = 0; i < list.length; i++){
      const ev = list[i] || {};
      const isDis = !!(ev && ev.disabled);
      const start = Number.isFinite(ev._recInF) ? ev._recInF : tcToFrames?.(ev.recIn || '00:00:00:00', fps);
      let end = Number.isFinite(ev._recOutF) ? ev._recOutF : tcToFrames?.(ev.recOut || '00:00:00:00', fps);
      if (!Number.isFinite(end) || end <= start) end = start + 1;

      const rawTrack =
        (ev.trackIndex != null) ? Number(ev.trackIndex) + 1 :
        (ev.vTrack != null) ? Number(ev.vTrack) :
        (ev.videoTrack != null) ? Number(ev.videoTrack) :
        (ev.track != null) ? Number(ev.track) :
        1;
      const track = (hasExplicitTrack && Number.isFinite(rawTrack) && rawTrack > 0) ? rawTrack : 1;

      const clipName = (ev.clipName || ev.reel || '').trim();
      const k = _cdDiffKey(ev);
      const tKey = diffByKey.get(k);
      const tClip = clipName ? diffByClip.get(clipName) : null;
      const flags = [];
      if (tKey) flags.push(tKey);
      else if (tClip) flags.push(tClip);

      const id = `${which}:${i}`;
      const label = clipName || (ev.reel || '').trim() || 'Clip';
      const c = { id, start, end, track, label, flags, disabled: isDis };
      clips.push(c);

      keyToId.set(k, id);
      if (rowByKey.has(k)) idToDiffIdx.set(id, rowByKey.get(k));
      if (clipName && !clipNameToId.has(clipName)) clipNameToId.set(clipName, id);

      if (start < timeStart) timeStart = start;
      if (end > timeEnd) timeEnd = end;
      if (track > trackCount) trackCount = track;
    }

    // Resolve-style: when explicit tracks exist, keep them as-is.
    // (Do not explode overlaps into extra lanes; that can create dozens of V-tracks and becomes unreadable.)

    // Prefer the true sequence start (e.g. FCPXML tcStart) so original timelines match other tabs
    try{
      const rawObj = (which === 'new') ? state.newRaw : state.oldRaw;
      const seqBase = getSeqBaseFrames(rawObj, fps);
      if (Number.isFinite(seqBase)) timeStart = Math.min(timeStart, seqBase);
    }catch{}

    if (!clips.length){
      timeStart = 0;
      timeEnd = 1;
      trackCount = 1;
    }

    // If we don't have explicit tracks, allocate lanes by overlap
    if (!hasExplicitTrack){
      trackCount = _cdAllocateLanes(clips);
    }

    const sig = `${which}:${list.length}:${timeStart}:${timeEnd}:${(state.diff || []).length}`;
    return { sig, clips, timeStart, timeEnd, trackCount, keyToId, idToDiffIdx, clipNameToId };
  }


  function _cdNiceStepFrames(stepFrames, fps){
    const fpsN = Math.max(1, Math.round(Number(fps) || 24));
    const stepSeconds = Math.max(1 / fpsN, (Number(stepFrames) || 1) / fpsN);
    const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300];
    let best = candidates[candidates.length - 1];
    for (const c of candidates){
      if (c >= stepSeconds){ best = c; break; }
    }
    return Math.max(1, Math.round(best * fpsN));
  }

  function _cdCreateOrigPullPrepTimeline(rootEl, options = {}){
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const fps = Math.max(1, Math.round(Number(options.fps) || 24));
    const onSelect = (typeof options.onSelect === 'function') ? options.onSelect : (() => {});
    const onViewChange = (typeof options.onViewChange === 'function') ? options.onViewChange : (() => {});
    const labelW = 48;

    rootEl.innerHTML = '';
    rootEl.classList.add('cd-origtl-pullprep');

    const shell = document.createElement('div');
    shell.className = 'cd-origtl-shell';
    shell.innerHTML = `
      <div class="edl-tl-minimap-wrap">
        <canvas class="edl-tl-minimap-canvas" aria-hidden="true"></canvas>
        <div class="edl-tl-minimap-window" aria-hidden="true"></div>
      </div>
      <div class="edl-tl-viewport" tabindex="0">
        <div class="edl-tl-ruler"></div>
        <div class="edl-tl-tracks"></div>
      </div>
    `;
    rootEl.appendChild(shell);

    const minimapWrap = shell.querySelector('.edl-tl-minimap-wrap');
    const minimapCanvas = shell.querySelector('.edl-tl-minimap-canvas');
    const minimapWindow = shell.querySelector('.edl-tl-minimap-window');
    const viewport = shell.querySelector('.edl-tl-viewport');
    const ruler = shell.querySelector('.edl-tl-ruler');
    const tracks = shell.querySelector('.edl-tl-tracks');

    let drag = null;
    let minimapDrag = null;
    const state = {
      clips: [],
      selectedId: null,
      timeStart: 0,
      timeEnd: 1,
      trackCount: 1,
      zoom: 1,
      pan: 0,
    };

    function fullSpan(){
      return Math.max(1, (Number(state.timeEnd) || 1) - (Number(state.timeStart) || 0));
    }

    function contentWidth(){
      const vw = viewport.clientWidth || rootEl.clientWidth || 900;
      const span = fullSpan();
      let pxPerSec = (vw * 1.8) / Math.max(1, span / fps);
      pxPerSec = Math.max(2, Math.min(120, pxPerSec));
      const baseContentW = Math.max(vw, Math.round((span / fps) * pxPerSec));
      return Math.max(vw, Math.round(baseContentW * clamp(Number(state.zoom) || 1, 1, 50)));
    }

    function pxPerFrame(){
      return contentWidth() / fullSpan();
    }

    function maxScroll(){
      return Math.max(0, contentWidth() - (viewport.clientWidth || 0));
    }

    function syncPanFromScroll(notify = true){
      const max = maxScroll();
      state.pan = (max > 0) ? clamp((viewport.scrollLeft || 0) / max, 0, 1) : 0;
      renderMinimapWindow();
      if (notify){
        try{ onViewChange({ zoom: state.zoom, pan: state.pan }); }catch{}
      }
    }

    function clipDiffType(clip){
      const flags = Array.isArray(clip?.flags) ? clip.flags : [];
      for (const f of flags){
        const s = String(f || '').toUpperCase();
        if (s === 'NEW' || s === 'EXTENDED' || s === 'CHANGED' || s === 'REMOVED') return s;
      }
      return '';
    }

    function renderRuler(ppf){
      ruler.innerHTML = '';
      const spacer = document.createElement('div');
      spacer.className = 'spacer';
      ruler.appendChild(spacer);

      const span = fullSpan();
      const stepF = _cdNiceStepFrames(span / 6, fps);
      for (let fr = 0; fr <= span; fr += stepF){
        const x = labelW + Math.round(fr * ppf);

        const tick = document.createElement('div');
        tick.className = 'tick';
        tick.style.left = `${x}px`;
        ruler.appendChild(tick);

        const lab = document.createElement('div');
        lab.className = 'label';
        lab.style.left = `${x}px`;
        lab.textContent = _cdFramesToTC((Number(state.timeStart) || 0) + fr, fps);
        ruler.appendChild(lab);
      }

      if ((span % stepF) !== 0){
        const x = labelW + Math.round(span * ppf);
        const tick = document.createElement('div');
        tick.className = 'tick';
        tick.style.left = `${x}px`;
        ruler.appendChild(tick);

        const lab = document.createElement('div');
        lab.className = 'label';
        lab.style.left = `${x}px`;
        lab.textContent = _cdFramesToTC((Number(state.timeStart) || 0) + span, fps);
        ruler.appendChild(lab);
      }
    }

    function renderTracks(ppf){
      tracks.innerHTML = '';
      const frag = document.createDocumentFragment();
      const byTrack = new Map();
      for (const clip of state.clips || []){
        const t = Math.max(1, Math.floor(Number(clip?.track) || 1));
        if (!byTrack.has(t)) byTrack.set(t, []);
        byTrack.get(t).push(clip);
      }

      const trackCount = Math.max(1, Math.floor(Number(state.trackCount) || 1));
      for (let track = trackCount; track >= 1; track--){
        const row = document.createElement('div');
        row.className = 'edl-tl-track';
        row.dataset.track = String(track);
        row.style.setProperty('--edl-tl-row-h', `${track === 1 ? 28 : 24}px`);
        if (track === 1) row.classList.add('is-spine');
        else row.classList.add('is-connected');

        const label = document.createElement('div');
        label.className = 'edl-tl-label';
        if (track === 1) label.classList.add('is-v1');
        label.textContent = `V${track}`;
        row.appendChild(label);

        const lane = document.createElement('div');
        lane.className = 'edl-tl-lane';
        lane.dataset.track = String(track);

        const items = (byTrack.get(track) || []).slice().sort((a, b) => {
          return ((Number(a?.start) || 0) - (Number(b?.start) || 0)) || ((Number(a?.end) || 0) - (Number(b?.end) || 0));
        });

        for (const clip of items){
          const start = Number(clip?.start) || 0;
          const end = Math.max(start + 1, Number(clip?.end) || (start + 1));
          const relStart = Math.max(0, start - (Number(state.timeStart) || 0));
          const relEnd = Math.max(relStart + 1, end - (Number(state.timeStart) || 0));
          const left = relStart * ppf;
          const width = Math.max(2, (relEnd - relStart) * ppf);
          const dt = clipDiffType(clip);

          const bar = document.createElement('div');
          bar.className = 'edl-tl-item cd-origtl-item';
          if (track === 1) bar.classList.add('is-spine-clip');
          else bar.classList.add('is-connected-clip');
          if (clip?.disabled) bar.classList.add('is-disabled');
          if (dt){
            bar.dataset.diff = dt;
            bar.classList.add(`is-diff-${dt.toLowerCase()}`);
          }
          bar.style.left = `${left.toFixed(2)}px`;
          bar.style.width = `${width.toFixed(2)}px`;
          bar.dataset.clipId = String(clip?.id || '');
          bar.title = `${clip?.label || 'Clip'} • ${_cdFramesToTC(start, fps)} → ${_cdFramesToTC(end, fps)}`;
          if (clip?.id != null && String(clip.id) === String(state.selectedId)) bar.classList.add('is-selected');

          if (width >= 58) bar.textContent = String(clip?.label || 'Clip');
          else if (width >= 14) bar.textContent = '•';

          lane.appendChild(bar);
        }

        row.appendChild(lane);
        frag.appendChild(row);
      }

      tracks.appendChild(frag);
    }

    function renderMinimapWindow(){
      const wrapW = Math.max(1, minimapWrap.clientWidth || 1);
      const cw = Math.max(1, contentWidth());
      const vw = Math.max(1, viewport.clientWidth || 1);
      const leftRatio = clamp((viewport.scrollLeft || 0) / cw, 0, 1);
      const widthRatio = clamp(vw / cw, 0.04, 1);
      const pxW = Math.max(12, Math.round(widthRatio * wrapW));
      const pxL = Math.round(leftRatio * wrapW);
      minimapWindow.style.width = `${pxW}px`;
      minimapWindow.style.left = `${Math.min(Math.max(0, wrapW - pxW), pxL)}px`;
      minimapWindow.style.display = (cw > vw + 2) ? '' : 'none';
    }

    function renderMinimap(){
      const wrapW = Math.max(10, Math.floor(minimapWrap.clientWidth || 10));
      const wrapH = Math.max(10, Math.floor(minimapWrap.clientHeight || 10));
      const dpr = window.devicePixelRatio || 1;
      minimapCanvas.width = Math.floor(wrapW * dpr);
      minimapCanvas.height = Math.floor(wrapH * dpr);
      const ctx = minimapCanvas.getContext('2d');
      if (!ctx){
        renderMinimapWindow();
        return;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, wrapW, wrapH);
      ctx.fillStyle = 'rgba(0,0,0,0.20)';
      ctx.fillRect(0, 0, wrapW, wrapH);

      const span = fullSpan();
      const trackCount = Math.max(1, Math.floor(Number(state.trackCount) || 1));
      const rowH = Math.max(2, Math.floor((wrapH - 4) / trackCount));
      for (const clip of state.clips || []){
        const start = Number(clip?.start) || 0;
        const end = Math.max(start + 1, Number(clip?.end) || (start + 1));
        const relStart = Math.max(0, start - (Number(state.timeStart) || 0));
        const relEnd = Math.max(relStart + 1, end - (Number(state.timeStart) || 0));
        const x = Math.round((relStart / span) * wrapW);
        const w = Math.max(1, Math.round(((relEnd - relStart) / span) * wrapW));
        const track = Math.max(1, Math.floor(Number(clip?.track) || 1));
        const yIdx = trackCount - track;
        const y = 2 + (yIdx * rowH);
        const dt = clipDiffType(clip);
        ctx.fillStyle = (dt === 'NEW') ? 'rgba(43,230,167,0.92)'
          : (dt === 'EXTENDED') ? 'rgba(90,162,255,0.92)'
          : (dt === 'CHANGED') ? 'rgba(255,184,74,0.88)'
          : (dt === 'REMOVED') ? 'rgba(255,94,94,0.84)'
          : 'rgba(86,160,235,0.82)';
        if (clip?.disabled) ctx.fillStyle = 'rgba(165,170,180,0.28)';
        ctx.fillRect(x, y, w, Math.max(2, rowH - 2));
      }

      renderMinimapWindow();
    }

    function render(){
      const cw = contentWidth();
      const ppf = cw / fullSpan();
      rootEl.style.setProperty('--edl-tl-label-w', `${labelW}px`);
      rootEl.style.setProperty('--edl-tl-content-w', `${cw}px`);
      renderRuler(ppf);
      renderTracks(ppf);
      const max = Math.max(0, cw - (viewport.clientWidth || 0));
      viewport.scrollLeft = (max > 0) ? Math.round(clamp(Number(state.pan) || 0, 0, 1) * max) : 0;
      renderMinimap();
      try{ onViewChange({ zoom: state.zoom, pan: state.pan }); }catch{}
    }

    function scrollToFrame(frame){
      const ppf = pxPerFrame();
      const vw = Math.max(1, viewport.clientWidth || 1);
      const left = ((Number(frame) || 0) - (Number(state.timeStart) || 0)) * ppf - (vw * 0.5);
      viewport.scrollLeft = clamp(left, 0, maxScroll());
      syncPanFromScroll();
    }

    function applyZoomAt(dir, clientX){
      const rect = viewport.getBoundingClientRect();
      const x01 = (rect.width > 0) ? clamp((clientX - rect.left) / rect.width, 0, 1) : 0.5;
      const oldCw = contentWidth();
      const oldPpf = oldCw / fullSpan();
      const anchorFrame = (Number(state.timeStart) || 0) + ((viewport.scrollLeft || 0) + (x01 * rect.width)) / oldPpf;
      state.zoom = clamp((Number(state.zoom) || 1) * (dir > 0 ? 1.12 : (1 / 1.12)), 1, 50);
      render();
      const newPpf = pxPerFrame();
      const target = ((anchorFrame - (Number(state.timeStart) || 0)) * newPpf) - (x01 * rect.width);
      viewport.scrollLeft = clamp(target, 0, maxScroll());
      syncPanFromScroll();
    }

    function onScroll(){
      syncPanFromScroll();
    }

    function onClick(ev){
      const item = ev.target?.closest?.('.edl-tl-item[data-clip-id]');
      if (!item) return;
      if (item.classList.contains('is-disabled')) return;
      onSelect(String(item.dataset.clipId || ''));
    }

    function onWheel(ev){
      if (!(ev.shiftKey || ev.ctrlKey || ev.metaKey || options.wheelZoom === 'always')) return;
      ev.preventDefault();
      if (ev.shiftKey){
        viewport.scrollLeft = clamp((viewport.scrollLeft || 0) + (ev.deltaY || ev.deltaX || 0), 0, maxScroll());
        syncPanFromScroll();
        return;
      }
      const dir = (ev.deltaY > 0) ? -1 : 1;
      applyZoomAt(dir, ev.clientX);
    }

    function onPointerDown(ev){
      if (ev.button != null && ev.button !== 0) return;
      const item = ev.target?.closest?.('.edl-tl-item');
      if (item) return;
      drag = { x: ev.clientX, scrollLeft: viewport.scrollLeft || 0 };
      viewport.setPointerCapture?.(ev.pointerId);
      viewport.classList.add('is-dragging');
    }

    function onPointerMove(ev){
      if (!drag) return;
      const dx = ev.clientX - drag.x;
      viewport.scrollLeft = clamp(drag.scrollLeft - dx, 0, maxScroll());
      syncPanFromScroll();
    }

    function endDrag(){
      drag = null;
      viewport.classList.remove('is-dragging');
    }

    function applyMinimapClientX(clientX){
      const rect = minimapWrap.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / Math.max(1, rect.width), 0, 1);
      const target = (ratio * contentWidth()) - ((viewport.clientWidth || 1) * 0.5);
      viewport.scrollLeft = clamp(target, 0, maxScroll());
      syncPanFromScroll();
    }

    function onMinimapDown(ev){
      if (ev.button != null && ev.button !== 0) return;
      minimapDrag = true;
      applyMinimapClientX(ev.clientX);
      minimapWrap.setPointerCapture?.(ev.pointerId);
      ev.preventDefault();
    }

    function onMinimapMove(ev){
      if (!minimapDrag) return;
      applyMinimapClientX(ev.clientX);
    }

    function onMinimapUp(){
      minimapDrag = null;
    }

    viewport.addEventListener('scroll', onScroll, { passive:true });
    viewport.addEventListener('click', onClick);
    viewport.addEventListener('wheel', onWheel, { passive:false });
    viewport.addEventListener('pointerdown', onPointerDown);
    viewport.addEventListener('pointermove', onPointerMove);
    viewport.addEventListener('pointerup', endDrag);
    viewport.addEventListener('pointercancel', endDrag);
    minimapWrap.addEventListener('pointerdown', onMinimapDown);
    minimapWrap.addEventListener('pointermove', onMinimapMove);
    minimapWrap.addEventListener('pointerup', onMinimapUp);
    minimapWrap.addEventListener('pointercancel', onMinimapUp);

    let ro = null;
    try{
      ro = new ResizeObserver(() => {
        const max = Math.max(0, maxScroll());
        state.pan = (max > 0) ? clamp((viewport.scrollLeft || 0) / max, 0, 1) : 0;
        render();
      });
      ro.observe(rootEl);
    }catch{}

    const api = {
      el: shell,
      setData(next = {}){
        const maxBefore = Math.max(0, maxScroll());
        state.pan = (maxBefore > 0) ? clamp((viewport.scrollLeft || 0) / maxBefore, 0, 1) : clamp(Number(state.pan) || 0, 0, 1);
        state.clips = Array.isArray(next.clips) ? next.clips.slice() : state.clips;
        state.selectedId = (next.selectedId != null) ? next.selectedId : state.selectedId;
        state.timeStart = Number.isFinite(next.timeStart) ? next.timeStart : state.timeStart;
        state.timeEnd = Number.isFinite(next.timeEnd) ? next.timeEnd : state.timeEnd;
        state.trackCount = Number.isFinite(next.trackCount) ? next.trackCount : state.trackCount;
        if (!(state.timeEnd > state.timeStart)) state.timeEnd = state.timeStart + 1;
        state.trackCount = Math.max(1, Math.floor(Number(state.trackCount) || 1));
        render();
      },
      scrollToFrame(frame){
        scrollToFrame(frame);
      },
      getViewState(){
        const max = Math.max(0, maxScroll());
        const pan = (max > 0) ? clamp((viewport.scrollLeft || 0) / max, 0, 1) : 0;
        return { zoom: state.zoom, pan };
      },
      setViewState(next = {}){
        state.zoom = clamp(Number(next.zoom) || state.zoom || 1, 1, 50);
        state.pan = clamp(Number(next.pan) || 0, 0, 1);
        render();
      },
      destroy(){
        try{ ro?.disconnect?.(); }catch{}
        viewport.removeEventListener('scroll', onScroll);
        viewport.removeEventListener('click', onClick);
        viewport.removeEventListener('wheel', onWheel);
        viewport.removeEventListener('pointerdown', onPointerDown);
        viewport.removeEventListener('pointermove', onPointerMove);
        viewport.removeEventListener('pointerup', endDrag);
        viewport.removeEventListener('pointercancel', endDrag);
        minimapWrap.removeEventListener('pointerdown', onMinimapDown);
        minimapWrap.removeEventListener('pointermove', onMinimapMove);
        minimapWrap.removeEventListener('pointerup', onMinimapUp);
        minimapWrap.removeEventListener('pointercancel', onMinimapUp);
        rootEl.innerHTML = '';
      }
    };

    render();
    return api;
  }

  function renderOrigTimeline(which, opts = {}){
    const w = (which === 'new' || which === 'old') ? which : 'new';
    if (!_cdEnsureTimelineUI()) return;
    if (tlState.collapsed) return;

    const fps = _cdGetFps();
    const list = (w === 'new') ? (state.newView || []) : (state.oldView || []);
    _cdEnsureFrames(list, fps);

    const obj = tlState.orig[w];
    if (!obj) return;

    if (opts.rebuild) _cdDestroyOrigTimeline(w);

    const newCache = _cdBuildOrigTimelineCache(w, list, fps);
    if (!obj.cache || obj.cache.sig !== newCache.sig || opts.force){
      obj.cache = newCache;
    }

    const root = (w === 'new') ? __tlUI.origNew : __tlUI.origOld;
    if (!root) return;

    if (!obj.api){
      root.innerHTML = '';
      obj.api = _cdCreateOrigPullPrepTimeline(root, {
        fps,
        wheelZoom: 'always',
        onViewChange: () => {
          try{ if (tlState.mode === w) _cdSyncTimelineFitBtn(); }catch{}
        },
        onSelect: (clipId) => {
          const di = obj.cache?.idToDiffIdx?.get?.(String(clipId));
          if (di == null) return;
          selState.srcIdx = Number(di);
          _cdApplySelection();
          _cdApplyTimelineSelection();
          _cdUpdateDiffTlPlayhead();
          _cdMarkDirty('select');
          try{
            const row = document.querySelector(`#cutdiffTable tbody tr[data-idx="${Number(di)}"]`);
            row?.scrollIntoView?.({ block:'center', behavior:'smooth' });
          }catch{}
        }
      });
    }

    let selectedId = null;
    if (selState.srcIdx != null && state.diff?.[selState.srcIdx]){
      const d = state.diff[selState.srcIdx];
      const k = _cdDiffKey(d);
      selectedId = obj.cache?.keyToId?.get?.(k) || null;
      if (!selectedId){
        const cn = (d?.clipName || '').trim();
        if (cn) selectedId = obj.cache?.clipNameToId?.get?.(cn) || null;
      }
    }

    const { clips, timeStart, timeEnd, trackCount } = obj.cache || { clips:[], timeStart:0, timeEnd:1, trackCount:1 };
    obj.api.setData({ clips, selectedId, timeStart, timeEnd, trackCount });

    if (selectedId && !opts.skipScrollToSelection){
      const c = clips.find(x => x.id === selectedId);
      if (c) obj.api.scrollToFrame(c.start);
    }

    try{ _cdSyncTimelineFitBtn(); }catch{}
  }

  function _cdApplyTimelineSelection(){
    if (tlState.mode !== 'compare'){
      // Update selection highlight in original timeline view
      renderOrigTimeline(tlState.mode, { force:false });
      return;
    }
    if (!__tlUI.laneNew) return;
    try{
      __tlUI.laneNew.querySelectorAll('.cd-seg.is-selected').forEach(el => el.classList.remove('is-selected'));
    }catch{}
    if (selState.srcIdx == null) return;
    const seg = tlState.segByKey.get(String(selState.srcIdx));
    if (seg) seg.classList.add('is-selected');
  }

  function _cdConfCell(ev){
    const s = Number(ev?.matchScore);
    const pct = Number.isFinite(s) ? Math.round(s * 100) : null;
    const lvl = (pct == null) ? 'low' : (pct >= 80 ? 'high' : (pct >= 55 ? 'med' : 'low'));
    const titleParts = [];
    if (pct != null) titleParts.push(`Confidence ${pct}%`);
    if (ev?.matchReason) titleParts.push(String(ev.matchReason));
    if (ev?.matchOldClipName) titleParts.push(`OLD: ${ev.matchOldClipName}`);
    if (ev?.matchOldRecIn && ev?.matchOldRecOut) titleParts.push(`OLD REC ${ev.matchOldRecIn}→${ev.matchOldRecOut}`);
    const title = titleParts.join(' | ');
    const label = (pct == null) ? '—' : `${pct}%`;
    const safeTitle = (typeof esc === 'function') ? esc(title) : String(title);
    return `<span class="cd-conf ${lvl}" title="${safeTitle}"><span class="dot"></span>${label}</span>`;
  }

  function _cdStatusCell(ev){
    const cur = String(ev?.status || 'New');
    const opts = ['New','Assigned','In Progress','Review','Done','Dropped','Hold'];
    const safeCur = (typeof esc === 'function') ? esc(cur) : cur;
    const options = opts.map(o => {
      const sel = (o === cur) ? ' selected' : '';
      const so = (typeof esc === 'function') ? esc(o) : o;
      return `<option value="${so}"${sel}>${so}</option>`;
    }).join('');
    return `<select class="cd-status" data-field="status" aria-label="Status">${options}</select>`;
  }

  function _cdNoteCell(ev){
    const v = String(ev?.note || '');
    const safeV = (typeof esc === 'function') ? esc(v) : v;
    return `<input class="cd-note" data-field="note" type="text" value="${safeV}" placeholder="Note…" aria-label="Note" />`;
  }

  function _cdCleanText(v){
    const raw = (v == null) ? '' : String(v);
    let out = '';
    for (const ch of raw){
      const code = ch.codePointAt(0);
      if (code === 0) continue;
      if ((code >= 0x01 && code <= 0x08) || code === 0x0B || code === 0x0C || (code >= 0x0E && code <= 0x1F) || code === 0x7F) continue;
      if (code >= 0xD800 && code <= 0xDFFF) continue;
      out += ch;
    }
    return out;
  }

  function _cdSetTableMessage(tbody, text){
    tbody.textContent = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 12;
    td.className = 'muted';
    td.style.padding = '6px';
    td.textContent = _cdCleanText(text);
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  // ---------------------------------------------------------------------------
  // Smart helpers
  // ---------------------------------------------------------------------------

  // Risk level: 'high' | 'med' | 'low'
  function _cdRiskLevel(ev){
    if (!ev) return 'low';
    const diffType = String(ev.diffType || '').toUpperCase();
    const pct   = Number.isFinite(Number(ev.matchScore)) ? Math.round(Number(ev.matchScore) * 100) : null;
    const frames = Number(ev._lenFrames) || 0;
    if (diffType === 'NEW') return 'high';
    if (pct !== null && pct < 50) return 'high';
    if (frames > 240) return 'high';   // > 10 s at 24 fps
    if (pct !== null && pct < 75) return 'med';
    if (frames > 48) return 'med';     // > 2 s
    return 'low';
  }

  // Auto-note text for an event
  function _cdAutoNoteForEvent(ev){
    if (!ev) return '';
    const diffType = String(ev.diffType || '').toUpperCase();
    const reel   = _cdCleanText(ev.reel || ev.clipName || '');
    const frames = Number(ev._lenFrames) || 0;
    const pct    = Number.isFinite(Number(ev.matchScore)) ? Math.round(Number(ev.matchScore) * 100) : null;
    const confStr = pct !== null ? ` • ${pct}% conf` : '';
    const reelStr = reel ? ` • ${reel}` : '';
    if (diffType === 'NEW')      return `New clip — no match in OLD${reelStr}`;
    if (diffType === 'EXTENDED') return `Extended ${frames}f${reelStr}${confStr}`;
    if (diffType === 'CHANGED')  return `Changed ${frames}f${reelStr}${confStr}`;
    return `${diffType} ${frames}f${reelStr}${confStr}`;
  }

  // Active risk filter ('all' | 'high' | 'med')
  let _cdRiskFilter = 'all';

  // Progress KPI (Approved / Pending / High-risk / % reviewed)
  function _cdSmartProgress(diff){
    const d = Array.isArray(diff) ? diff : [];
    let approved = 0, pending = 0, highRisk = 0;
    for (const ev of d){
      const s = String(ev?.status || 'New');
      if (s === 'Done') approved++;
      if (s === 'New' || !s) pending++;
      if (_cdRiskLevel(ev) === 'high') highRisk++;
    }
    const total = d.length || 1;
    const pctDone = Math.round((approved / total) * 100);
    return { approved, pending, highRisk, pctDone, total: d.length };
  }

  function _cdBuildConfNode(ev){
    const s = Number(ev?.matchScore);
    const pct = Number.isFinite(s) ? Math.round(s * 100) : null;
    const lvl = (pct == null) ? 'low' : (pct >= 80 ? 'high' : (pct >= 55 ? 'med' : 'low'));
    const titleParts = [];
    if (pct != null) titleParts.push(`Confidence ${pct}%`);
    if (ev?.matchReason) titleParts.push(String(ev.matchReason));
    if (ev?.matchOldClipName) titleParts.push(`OLD: ${ev.matchOldClipName}`);
    if (ev?.matchOldRecIn && ev?.matchOldRecOut) titleParts.push(`OLD REC ${ev.matchOldRecIn}→${ev.matchOldRecOut}`);
    const label = (pct == null) ? '—' : `${pct}%`;
    const wrap = document.createElement('span');
    wrap.className = `cd-conf ${lvl}`;
    const title = _cdCleanText(titleParts.join(' | '));
    if (title) wrap.title = title;
    const dot = document.createElement('span');
    dot.className = 'dot';
    wrap.appendChild(dot);
    wrap.appendChild(document.createTextNode(label));
    return wrap;
  }

  function _cdBuildStatusNode(ev){
    const cur = _cdCleanText(ev?.status || 'New') || 'New';
    const opts = ['New','Assigned','In Progress','Review','Done','Dropped','Hold'];
    const select = document.createElement('select');
    select.className = 'cd-status';
    select.dataset.field = 'status';
    select.setAttribute('aria-label', 'Status');
    const values = opts.slice();
    if (cur && !values.includes(cur)) values.unshift(cur);
    for (const o of values){
      const opt = document.createElement('option');
      opt.value = o;
      opt.textContent = o;
      if (o === cur) opt.selected = true;
      select.appendChild(opt);
    }
    return select;
  }

  function _cdBuildNoteNode(ev){
    const input = document.createElement('input');
    input.className = 'cd-note';
    input.dataset.field = 'note';
    input.type = 'text';
    input.placeholder = 'Note…';
    input.setAttribute('aria-label', 'Note');
    input.value = _cdCleanText(ev?.note || '');
    return input;
  }

  function renderTable(){
    const tbody = document.querySelector("#cutdiffTable tbody");
    if (!tbody) return;

    const fps = _cdGetFps();
    const diff = state.diff || [];
    if (!diff.length){
      _cdSetTableMessage(tbody, 'No changes detected.');
      _cdApplySelection();
      renderHeaderSort();
      return;
    }

    // Apply diff type + risk filters
    const visible = [];
    for (let i = 0; i < diff.length; i++){
      const t = String(diff[i]?.diffType || 'CHANGED').toUpperCase();
      if (!_cdTypeEnabled(t)) continue;
      if (_cdRiskFilter === 'high' && _cdRiskLevel(diff[i]) !== 'high') continue;
      if (_cdRiskFilter === 'med'  && _cdRiskLevel(diff[i]) === 'low')  continue;
      visible.push(i);
    }
    if (!visible.length){
      _cdSetTableMessage(tbody, 'All changes are hidden by filters.');
      _cdApplySelection();
      renderHeaderSort();
      return;
    }

    const order = visible.slice();
    const k = sortState.key;
    const d = sortState.dir || 1;
    if (k){
      const riskRank = { high: 0, med: 1, low: 2 };
      order.sort((ia, ib) => {
        if (k === "index") return (ia - ib) * d;
        if (k === "risk"){
          const ra = riskRank[_cdRiskLevel(diff[ia])] ?? 2;
          const rb = riskRank[_cdRiskLevel(diff[ib])] ?? 2;
          return ((ra - rb) * d) || (ia - ib);
        }
        const r = _cdCmpSort(diff[ia], diff[ib], k);
        return (r * d) || (ia - ib);
      });
    }

    const frag = document.createDocumentFragment();
    for (let rowIdx = 0; rowIdx < order.length; rowIdx++){
      const srcIdx = order[rowIdx];
      const ev = diff[srcIdx] || {};
      const diffType = _cdCleanText(String(ev.diffType || 'CHANGED').toUpperCase());
      const typeKey = diffType === 'NEW' ? 'new' : (diffType === 'EXTENDED' ? 'extended' : 'changed');
      const riskLvl = _cdRiskLevel(ev);
      const rowClass = `diff-${typeKey} cd-risk-${riskLvl}`;
      const lenFrames = (ev._lenFrames != null) ? ev._lenFrames : 0;

      const tr = document.createElement('tr');
      tr.dataset.idx = String(srcIdx);
      tr.className = rowClass;

      const pushTextCell = (value) => {
        const td = document.createElement('td');
        td.textContent = _cdCleanText(value);
        tr.appendChild(td);
        return td;
      };

      pushTextCell(String(rowIdx + 1));

      const typeTd = document.createElement('td');
      typeTd.className = 'cd-type-cell';
      const pill = document.createElement('span');
      pill.className = `diff-pill diff-pill-${typeKey}`;
      pill.textContent = diffType;
      typeTd.appendChild(pill);

      // Duration delta badge — like Netflix's "+00:00:01:08" per row
      if (ev.matchOldRecIn && ev.matchOldRecOut && diffType !== 'NEW' && diffType !== 'REMOVED') {
        try {
          const oldInF  = tcToFrames ? tcToFrames(ev.matchOldRecIn, fps) : NaN;
          const oldOutF = tcToFrames ? tcToFrames(ev.matchOldRecOut, fps) : NaN;
          if (Number.isFinite(oldInF) && Number.isFinite(oldOutF)) {
            const oldLen = Math.max(0, oldOutF - oldInF);
            const newLen = ev._lenFrames || 0;
            const delta  = newLen - oldLen;
            if (delta !== 0) {
              const deltaBadge = document.createElement('span');
              const sign = delta > 0 ? '+' : '';
              deltaBadge.className = `cd-dur-delta cd-dur-delta-${delta > 0 ? 'pos' : 'neg'}`;
              deltaBadge.textContent = `${sign}${delta}f`;
              deltaBadge.title = `Duration change — OLD: ${oldLen}f → NEW: ${newLen}f  |  OLD REC ${ev.matchOldRecIn}→${ev.matchOldRecOut}`;
              typeTd.appendChild(deltaBadge);
            }
          }
        } catch {}
      }
      tr.appendChild(typeTd);

      const confTd = document.createElement('td');
      confTd.appendChild(_cdBuildConfNode(ev));
      tr.appendChild(confTd);

      // Risk cell — clean text badges (no emoji)
      const riskTd = document.createElement('td');
      const riskBadge = document.createElement('span');
      riskBadge.className = `cd-risk-badge cd-risk-badge-${riskLvl}`;
      riskBadge.textContent = riskLvl === 'high' ? 'High' : (riskLvl === 'med' ? 'Med' : 'Low');
      riskTd.appendChild(riskBadge);
      tr.appendChild(riskTd);

      pushTextCell(ev.reel || '');
      pushTextCell(ev.srcIn || '');
      pushTextCell(ev.srcOut || '');
      pushTextCell(ev.recIn || '');
      pushTextCell(ev.recOut || '');
      pushTextCell(`${lenFrames}f`);
      pushTextCell(ev.clipName || '');

      const statusTd = document.createElement('td');
      statusTd.appendChild(_cdBuildStatusNode(ev));
      tr.appendChild(statusTd);

      const noteTd = document.createElement('td');
      noteTd.appendChild(_cdBuildNoteNode(ev));
      tr.appendChild(noteTd);

      frag.appendChild(tr);
    }

    tbody.textContent = '';
    tbody.appendChild(frag);
    renderHeaderSort();
    _cdApplySelection();

    // ── Scope bar (Netflix-style "X% runtime affected" headline above table) ──
    try {
      const tableEl = document.getElementById('cutdiffTable');
      if (tableEl) {
        let scopeBar = document.getElementById('cdScopeBar');
        if (!scopeBar) {
          scopeBar = document.createElement('div');
          scopeBar.id = 'cdScopeBar';
          scopeBar.className = 'cd-scope-bar';
          // Inject into smart bar as a middle section (single row)
          const smartBar = document.getElementById('cdSmartBar');
          const smartBarRight = smartBar?.querySelector('.cd-smart-bar-right');
          if (smartBar && smartBarRight) {
            smartBar.insertBefore(scopeBar, smartBarRight);
          } else {
            tableEl.parentNode?.insertBefore(scopeBar, tableEl);
          }
        }
        const total   = state.newView?.length || 0;
        const removed = state.removed?.length || 0;
        const totalAll = total + removed;
        const visCount = order.length;
        const allCount = diff.length;
        const pct = total ? ((allCount / total) * 100).toFixed(1) : '0.0';
        // Net delta
        let netDeltaStr = '';
        try {
          _cdEnsureFrames(state.oldView, fps);
          _cdEnsureFrames(state.newView, fps);
          let os = Infinity, oe = -Infinity, ns = Infinity, ne = -Infinity;
          for (const ev of (state.oldView || [])) {
            const a = Number(ev?._recInF), b = Number(ev?._recOutF);
            if (Number.isFinite(a) && a < os) os = a;
            if (Number.isFinite(b) && b > oe) oe = b;
          }
          for (const ev of (state.newView || [])) {
            const a = Number(ev?._recInF), b = Number(ev?._recOutF);
            if (Number.isFinite(a) && a < ns) ns = a;
            if (Number.isFinite(b) && b > ne) ne = b;
          }
          const nd = ((Number.isFinite(ne) ? ne : 0) - (Number.isFinite(ns) ? ns : 0)) -
                     ((Number.isFinite(oe) ? oe : 0) - (Number.isFinite(os) ? os : 0));
          if (Math.abs(nd) >= 2) {
            const sign = nd >= 0 ? '+' : '−';
            const abs = _cdFramesToTC(Math.abs(nd), fps);
            const short = abs.startsWith('00:') ? abs.slice(3) : abs;
            netDeltaStr = `<span class="cd-scope-sep">|</span><span class="cd-scope-stat cd-scope-delta cd-scope-delta-${nd >= 0 ? 'pos' : 'neg'}">${sign}${short}</span>`;
          }
        } catch {}
        scopeBar.innerHTML = `
          <span class="cd-scope-metric">
            <span class="cd-scope-big">${pct}%</span>
            <span class="cd-scope-sub">runtime affected</span>
          </span>
          <span class="cd-scope-sep">|</span>
          <span class="cd-scope-stat"><b>${allCount}</b> changes</span>
          <span class="cd-scope-sep">·</span>
          <span class="cd-scope-stat"><b>${removed}</b> removed</span>
          ${netDeltaStr}
          <span class="cd-scope-right">
            ${visCount < allCount ? `<span class="cd-scope-filter">${visCount} shown (filtered)</span>` : ''}
          </span>
        `;
      }
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // Core actions
  // ---------------------------------------------------------------------------
  async function handleCutDiffFile(which, fileOrFiles){
    const statusEl = document.getElementById(
      which === "old" ? "cutdiffOldStatus" : "cutdiffNewStatus"
    );

    const files = Array.isArray(fileOrFiles)
      ? fileOrFiles.filter(Boolean)
      : (fileOrFiles ? [fileOrFiles] : []);

    if (!files.length){
      if (statusEl) statusEl.textContent = "No file selected.";
      return;
    }

    try{
      // loading a cut invalidates the previous analysis
      state.analyzed = false;
      state.diff = [];
      updateHeartbeat();

      if (statusEl) statusEl.textContent = "Parsing…";

      const parsed = parseFromFiles ? await parseFromFiles(files) : null;
      const events = parsed?.events || [];
      const fps    = parsed?.fps || 24;

      if (!events.length){
        if (statusEl) statusEl.textContent = "No valid events in file.";
        return;
      }

      const firstFile   = files[0];
      const projectName = parsed?.projectName || (stemNoExt ? stemNoExt(firstFile.name) : (firstFile.name || "CUT"));
      const fileMeta = await _cdFileMeta(firstFile);
      const audioDetails = await _cdExtractAudioDetails(firstFile, parsed);
      const audioMeta = audioDetails?.meta || _cdAudioMetaNone();
      const audioEvents = Array.isArray(audioDetails?.events) ? audioDetails.events : [];

      const viewCut = runDefaultCutDiffPipeline(events, fps);

      audioCompareState.key = '';
      audioCompareState.payload = null;

      if (which === "old"){
        state.oldRaw  = { events, fps, projectName, fileMeta, audioMeta, audioEvents, viewCount: viewCut.length };
        state.oldView = viewCut;
      } else {
        state.newRaw  = { events, fps, projectName, fileMeta, audioMeta, audioEvents, viewCount: viewCut.length };
        state.newView = viewCut;
      }

      if (statusEl){
        const h = _cdShortHash(fileMeta?.sha256);
        const audioText = _cdAudioSummaryText(audioMeta, { compact: true });
        statusEl.textContent = `Loaded: ${projectName} (${viewCut.length} events${audioText ? " • " + audioText : ""})${h && h!=="—" ? " • " + h : ""}`;
      }

      updateHeartbeat();
      _cdRenderCompareLock();
      // Auto-align Video Compare start TCs once both cuts are loaded (does not override manual values).
      try{ _vcAutoSyncStartTcFromCuts(); }catch{}
      // Always keep Summary/KPIs visible (even before Analyze)
      try{ _cdRenderSummary(); }catch{}
      _cdRenderTimelineActive(true);
      _cdMarkDirty(`load ${which}`);
    } catch(err){
      console.error("CUT DIFF parse error:", err);
      if (statusEl){
        statusEl.textContent = "Error: " + (err?.message || String(err));
      }
    }
  }

  function _cdComputeRemoved(oldView, newView, fps){
    const out = [];
    const byReel = new Map();
    for (const ev of (newView || [])){
      const reel = String(ev?.reel || '');
      if (!reel) continue;
      const ns = _cdTcNum(ev.srcIn, fps);
      const ne = _cdTcNum(ev.srcOut, fps);
      if (!Number.isFinite(ns) || !Number.isFinite(ne) || ne <= ns) continue;
      if (!byReel.has(reel)) byReel.set(reel, []);
      byReel.get(reel).push([ns, ne]);
    }
    for (const list of byReel.values()) list.sort((a,b)=>a[0]-b[0]);

    for (const ev of (oldView || [])){
      const reel = String(ev?.reel || '');
      const list = byReel.get(reel);
      if (!list || !list.length){
        out.push({ ...ev, diffType: 'REMOVED' });
        continue;
      }
      const os = _cdTcNum(ev.srcIn, fps);
      const oe = _cdTcNum(ev.srcOut, fps);
      if (!Number.isFinite(os) || !Number.isFinite(oe) || oe <= os) continue;
      let ov = false;
      for (const [ns, ne] of list){
        if (ns < oe && ne > os){ ov = true; break; }
        if (ns > oe) break;
      }
      if (!ov) out.push({ ...ev, diffType: 'REMOVED' });
    }

    _cdEnsureFrames(out, fps);
    return out;
  }

  function _cdComputeConfidence(oldView, diff, fps){
    const oldByReel = new Map();
    for (const o of (oldView || [])){
      const reel = String(o?.reel || '');
      if (!oldByReel.has(reel)) oldByReel.set(reel, []);
      oldByReel.get(reel).push(o);
    }

    for (const ev of (diff || [])){
      if (!ev || typeof ev !== 'object') continue;
      // Keep existing annotations if present
      if (ev.matchScore != null && ev.matchOldRecIn != null) continue;

      const reel = String(ev.reel || '');
      const cands = oldByReel.get(reel) || [];

      const cn = String(ev.clipName || '').trim().toUpperCase();
      const ns = _cdTcNum(ev.srcIn, fps);
      const ne = _cdTcNum(ev.srcOut, fps);
      const nr = _cdTcNum(ev.recIn, fps);

      let best = null;
      let bestScore = -1;
      let bestReason = '';

      for (const o of cands){
        const ocn = String(o.clipName || '').trim().toUpperCase();
        const os = _cdTcNum(o.srcIn, fps);
        const oe = _cdTcNum(o.srcOut, fps);
        const orc = _cdTcNum(o.recIn, fps);
        if (!Number.isFinite(ns) || !Number.isFinite(ne) || !Number.isFinite(os) || !Number.isFinite(oe)) continue;

        const overlap = Math.max(0, Math.min(ne, oe) - Math.max(ns, os));
        const len = Math.max(1, ne - ns);
        const ovFrac = overlap / len;

        let score = 0;
        let reason = [];

        // reel match is implied (we're in same reel bucket)
        score += 0.20;

        if (cn && ocn && cn == ocn){ score += 0.45; reason.push('clipName'); }
        if (ovFrac > 0){
          score += 0.30 * Math.min(1, ovFrac);
          reason.push(`srcOverlap ${Math.round(ovFrac*100)}%`);
        }

        if (Number.isFinite(nr) && Number.isFinite(orc)){
          const d = Math.abs(nr - orc);
          const oneSec = Math.max(1, fps);
          if (d <= oneSec){ score += 0.10; reason.push('recNear'); }
          else if (d <= oneSec * 5){ score += 0.05; reason.push('recNear-ish'); }
        }

        // diffType hints
        const dt = String(ev.diffType || '').toUpperCase();
        if (dt === 'EXTENDED' && ovFrac > 0.5){ score += 0.05; }

        if (score > bestScore){
          bestScore = score;
          best = o;
          bestReason = reason.join(', ');
        }
      }

      if (best){
        ev.matchScore = Math.max(0, Math.min(1, bestScore));
        ev.matchReason = bestReason || 'matched';
        ev.matchOldClipName = best.clipName || '';
        ev.matchOldRecIn = best.recIn || '';
        ev.matchOldRecOut = best.recOut || '';
        ev.matchOldSrcIn = best.srcIn || '';
        ev.matchOldSrcOut = best.srcOut || '';
        try{
          const nrInF = _cdTcNum(ev.recIn, fps);
          const orInF = _cdTcNum(best.recIn, fps);
          if (Number.isFinite(nrInF) && Number.isFinite(orInF)){
            ev.movedByFrames = Math.round(nrInF - orInF);
          }
        }catch{}
      } else {
        ev.matchScore = 0;
        ev.matchReason = 'no match';
      }

      if (ev.status == null) ev.status = 'New';
      if (ev.note == null) ev.note = '';
    }
  }

  function analyzeCutDiff(){
    const infoEl = document.getElementById("cutdiffSummaryKpi");
    const tbody  = document.querySelector("#cutdiffTable tbody");

    if (!infoEl || !tbody) return;

    if (!state.oldView?.length || !state.newView?.length){
      // Keep Summary/KPIs visible at all times; avoid filling UI with extra text.
      try{ showError?.('Please load BOTH OLD and NEW cuts first.'); }catch{}
      try{ _cdRenderSummary(); }catch{}
      tbody.innerHTML = "";
      state.diff = [];
      state.analyzed = false;
      updateHeartbeat();
      return;
    }

    const maxSecInput = document.getElementById("cutdiffMaxSeconds");
    const maxSec = parseFloat(maxSecInput?.value) || 0;

    const fps =
      state.newRaw?.fps ||
      state.oldRaw?.fps ||
      24;

    const maxFrames = maxSec > 0 ? Math.round(maxSec * fps) : 0;

    if (!CutDiff || typeof CutDiff.computeCutDiff !== "function"){
      infoEl.innerHTML =
        '<div class="muted" style="font-size:12px;">CUT DiFF module not available.</div>';
      return;
    }

    const diff = _cdFilterStrictOcf(CutDiff.computeCutDiff(
      state.oldView,
      state.newView,
      {
        minFrames       : 0,
        maxFrames       : maxFrames,
        includeTrimmed  : false,
        includeUnchanged: false
      }
    ) || []);

    state.diff = diff;
    state.removed = _cdFilterStrictOcf(_cdComputeRemoved(state.oldView, state.newView, fps) || []);
    _cdComputeConfidence(state.oldView, state.diff, fps);
    state.analyzed = true;
    try{ chrome?.runtime?.sendMessage?.({ type: "USAGE_EVENT", event: "cutdiff" }); }catch(_){}

    _cdMarkDirty("analyze");

    _cdRenderCompareLock();

    // Auto-align Video Compare start TCs to the cuts so timeline and video match.
    try{ _vcAutoSyncStartTcFromCuts(); }catch{}

    _cdRenderSummary();

    // Render table (supports header sorting)
    renderTable();

    // Smart Timeline Compare highlights diff regions on NEW (and related on OLD)
    _cdRenderTimelineActive(true);

    updateHeartbeat();
  }

  function _cdRenderSummary(){
    const infoEl = document.getElementById('cutdiffSummaryKpi');
    if (!infoEl) return;

    const isReady = !!state.analyzed;

    const fps = _cdGetFps();
    _cdEnsureFrames(state.oldView, fps);
    _cdEnsureFrames(state.newView, fps);
    _cdEnsureFrames(state.diff, fps);

    const diff = state.diff || [];
    const visDiff = diff.filter(d => _cdTypeEnabled(String(d?.diffType || 'CHANGED').toUpperCase()));

    const totalNew = state.newView?.length || 0;
    const changedAll  = diff.length;
    const changedVis  = visDiff.length;
    const pctAll = totalNew ? ((changedAll / totalNew) * 100).toFixed(1) : '0.0';
    const pctVis = totalNew ? ((changedVis / totalNew) * 100).toFixed(1) : '0.0';

    const sumAll = (CutDiff?.summarizeDiff && CutDiff.summarizeDiff(diff)) || {};
    const sumVis = (CutDiff?.summarizeDiff && CutDiff.summarizeDiff(visDiff)) || {};

    // Duration impact (C = show impacted + net delta)
    let oldStart = Infinity, oldEnd = -Infinity;
    let newStart = Infinity, newEnd = -Infinity;
    for (const ev of (state.oldView || [])){
      const a = Number(ev?._recInF);
      const b = Number(ev?._recOutF);
      if (Number.isFinite(a) && a < oldStart) oldStart = a;
      if (Number.isFinite(b) && b > oldEnd) oldEnd = b;
    }
    for (const ev of (state.newView || [])){
      const a = Number(ev?._recInF);
      const b = Number(ev?._recOutF);
      if (Number.isFinite(a) && a < newStart) newStart = a;
      if (Number.isFinite(b) && b > newEnd) newEnd = b;
    }
    if (!Number.isFinite(oldStart)) oldStart = 0;
    if (!Number.isFinite(newStart)) newStart = 0;
    const oldLen = Math.max(0, (Number.isFinite(oldEnd) ? oldEnd : 0) - oldStart);
    const newLen = Math.max(0, (Number.isFinite(newEnd) ? newEnd : 0) - newStart);
    const netDelta = newLen - oldLen;
    const netSign = netDelta >= 0 ? '+' : '-';

    let impactedAll = 0;
    let impactedVis = 0;
    for (let i = 0; i < diff.length; i++){
      const d = diff[i] || {};
      const a = Number(d._recInF);
      const b = Number(d._recOutF);
      const w = (Number.isFinite(a) && Number.isFinite(b)) ? Math.max(1, b - a) : 0;
      impactedAll += w;
      const t = String(d.diffType || 'CHANGED').toUpperCase();
      if (_cdTypeEnabled(t)) impactedVis += w;
    }

    const tcImpVis = _cdFramesToTC(impactedVis, fps);
    const tcImpAll = _cdFramesToTC(impactedAll, fps);
    const tcNetAbs = _cdFramesToTC(Math.abs(netDelta), fps);
    const tcOld = _cdFramesToTC(oldLen, fps);
    const tcNew = _cdFramesToTC(newLen, fps);

    // Storage estimate
    const estAll = estimateStorageForEvents ? estimateStorageForEvents(diff, fps) : { totalGB:0, conformGB:0, vfxGB:0, redGB:0, otherGB:0 };
    const estVis = estimateStorageForEvents ? estimateStorageForEvents(visDiff, fps) : estAll;
    const fmt = storageFmtGB || ((gb)=>String(gb));
    const estConform = fmt(estVis.conformGB);
    const estVfx     = fmt(estVis.vfxGB);
    const tip = `OLD ${tcOld}  |  NEW ${tcNew}  |  Net ${netSign}${tcNetAbs}`;

    const oldAudioMeta = state.oldRaw?.audioMeta || null;
    const newAudioMeta = state.newRaw?.audioMeta || null;
    const oldAudioFullRaw = _cdAudioSummaryText(oldAudioMeta);
    const newAudioFullRaw = _cdAudioSummaryText(newAudioMeta);
    const oldAudioPillRaw = _cdAudioSummaryText(oldAudioMeta, { compact: true });
    const newAudioPillRaw = _cdAudioSummaryText(newAudioMeta, { compact: true });
    const audioCompareFullRaw = _cdAudioCompareLabel(oldAudioMeta, newAudioMeta);
    const audioCmp = _cdGetAudioCompareData();
    const audioChangeFullRaw = _cdAudioChangeSummaryText(audioCmp);
    const oldAudioTracksRaw = _cdAudioTrackStatsText(state.oldRaw?.audioEvents, fps, { compact: true, maxTracks: 3 }) || 'n/a';
    const newAudioTracksRaw = _cdAudioTrackStatsText(state.newRaw?.audioEvents, fps, { compact: true, maxTracks: 3 }) || 'n/a';
    const audioTrackChangeRaw = _cdAudioDiffTrackStatsText(audioCmp, fps, { compact: true, maxTracks: 2 }) || 'No per-track audio changes';
    const oldAudioText = _cdSafeHtml(oldAudioPillRaw);
    const newAudioText = _cdSafeHtml(newAudioPillRaw);
    const audioCompare = _cdSafeHtml(audioCompareFullRaw);
    const audioChange = _cdSafeHtml(audioChangeFullRaw);
    const oldAudioTracks = _cdSafeHtml(oldAudioTracksRaw);
    const newAudioTracks = _cdSafeHtml(newAudioTracksRaw);
    const audioTrackChange = _cdSafeHtml(audioTrackChangeRaw);
    const audioStatusCompactRaw = (() => {
      const oldAvail = !!oldAudioMeta?.available;
      const newAvail = !!newAudioMeta?.available;
      if (!oldAvail && !newAvail) return 'Status: unavailable';
      if (oldAvail && newAvail){
        const dt = (Number(newAudioMeta?.trackCount) || 0) - (Number(oldAudioMeta?.trackCount) || 0);
        const dc = (Number(newAudioMeta?.clipCount) || 0) - (Number(oldAudioMeta?.clipCount) || 0);
        if (!dt && !dc) return 'Status: same';
        const fmtDelta = (n, suffix) => `${n >= 0 ? '+' : ''}${n}${suffix}`;
        return `Status: ${fmtDelta(dt, 'T')} / ${fmtDelta(dc, 'C')}`;
      }
      return oldAvail ? 'Status: OLD only' : 'Status: NEW only';
    })();
    const audioDiffCompactRaw = (() => {
      const s = String(audioChangeFullRaw || '').replace(/^Audio diff:\s*/i, '').trim();
      if (!s) return '';
      if (/^No timeline audio changes detected\.?$/i.test(s)) return 'Diff: none';
      return `Diff: ${s}`;
    })();
    const showAudioTrackLine = !!((state.oldRaw?.audioEvents?.length || 0) || (state.newRaw?.audioEvents?.length || 0));
    const audioStatusValueRaw = String(audioStatusCompactRaw || '').replace(/^Status:\s*/i, '').trim() || 'unavailable';
    const audioDiffValueRaw = (() => {
      const sum = audioCmp?.summary || {};
      const total = (Number(sum.NEW) || 0) + (Number(sum.EXTENDED) || 0) + (Number(sum.CHANGED) || 0) + (Number(sum.REMOVED) || 0);
      if (!total) return 'none';
      return `New ${sum.NEW || 0} • Ext ${sum.EXTENDED || 0} • Chg ${sum.CHANGED || 0} • Rem ${sum.REMOVED || 0}`;
    })();
    const audioStatusCompact = _cdSafeHtml(audioStatusValueRaw);
    const audioDiffCompact = _cdSafeHtml(audioDiffValueRaw);
    const audioStatusTitleRaw = [audioCompareFullRaw, showAudioTrackLine ? `OLD tracks: ${oldAudioTracksRaw} • NEW tracks: ${newAudioTracksRaw}` : '']
      .filter(Boolean)
      .join(' • ');
    const audioDiffTitleRaw = [audioChangeFullRaw, audioTrackChangeRaw ? `By track: ${audioTrackChangeRaw}` : '']
      .filter(Boolean)
      .join(' • ');
    const audioStatusTitle = _cdSafeHtml(audioStatusTitleRaw);
    const audioDiffTitle = _cdSafeHtml(audioDiffTitleRaw || audioChangeFullRaw || 'Audio diff: none');

    // Removed is computed during Analyze. For "always visible" KPI we provide a best-effort
    // estimate when BOTH cuts are loaded, even if Analyze hasn't run.
    let removedCount = (state.removed && state.removed.length) ? state.removed.length : 0;
    if (!isReady && !removedCount && (state.oldView?.length || 0) > 0 && (state.newView?.length || 0) > 0){
      try{ removedCount = _cdComputeRemoved(state.oldView, state.newView, fps)?.length || 0; }catch{}
    }

    // Default placeholders before Analyze: show a full layout with 0 / 00:00:00:00.
    const pPull = isReady ? changedVis : 0;
    const pPct  = isReady ? (pctVis + '%') : '0%';
    const pDur  = isReady ? tcImpVis : '00:00:00:00';
    const pOcf  = isReady ? estConform : '0 GB';
    const pExr  = isReady ? estVfx : '0 GB';
    const _shortTC = (tc) => String(tc || '').startsWith('00:') ? String(tc).slice(3) : String(tc || '—');
    const pDurShort = isReady ? _shortTC(tcImpVis) : '—';
    const pNetDelta = isReady ? (Math.abs(netDelta) < 2 ? '±0' : netSign + _shortTC(tcNetAbs)) : '—';
    const prog = _cdSmartProgress(diff);
    const kpiHtml = `
      <div class="cd2-kpi-content">

        <!-- Type filter chips -->
        <div class="cd2-kpi-types">
          <button type="button" class="cd2-kpi-type chip-new" data-filter="NEW" title="Toggle NEW shots">
            <span class="cd2-type-k">NEW</span><span class="cd2-type-n">${sumAll.NEW || 0}</span>
          </button>
          <button type="button" class="cd2-kpi-type chip-ext" data-filter="EXTENDED" title="Toggle EXTENDED shots">
            <span class="cd2-type-k">EXT</span><span class="cd2-type-n">${sumAll.EXTENDED || 0}</span>
          </button>
          <button type="button" class="cd2-kpi-type chip-chg" data-filter="CHANGED" title="Toggle CHANGED shots">
            <span class="cd2-type-k">CHG</span><span class="cd2-type-n">${sumAll.CHANGED || 0}</span>
          </button>
          <button type="button" class="cd2-kpi-type chip-rem" data-filter="REMOVED" title="Toggle REMOVED shots">
            <span class="cd2-type-k">REM</span><span class="cd2-type-n">${removedCount}</span>
          </button>
        </div>

        <div class="cd2-kpi-sep"></div>

        <!-- Pull metrics -->
        <div class="cd2-kpi-metric cd2-kpi-pull" title="Shots requiring a pull (visible filter)">
          <span class="cd2-m-val">${pPull}</span><span class="cd2-m-lbl">Pull</span>
        </div>
        <div class="cd2-kpi-metric" title="Visible: ${pctVis}%  |  All: ${pctAll}%">
          <span class="cd2-m-val">${pPct}</span><span class="cd2-m-lbl">Chg</span>
        </div>
        <div class="cd2-kpi-metric" title="Total footage impacted: ${tcImpVis} (all: ${tcImpAll})">
          <span class="cd2-m-val">${pDurShort}</span><span class="cd2-m-lbl">Impact</span>
        </div>
        <div class="cd2-kpi-metric" title="Net sequence length delta — OLD ${tcOld} → NEW ${tcNew}">
          <span class="cd2-m-val cd-delta-val" data-sign="${netSign}">${pNetDelta}</span><span class="cd2-m-lbl">Delta</span>
        </div>

        <div class="cd2-kpi-sep"></div>

        <!-- Storage estimate -->
        <div class="cd2-kpi-storage" title="Storage estimate — visible shots only&#10;Total OCF ${fmt(estAll.conformGB)} / EXR ${fmt(estAll.vfxGB)}">
          <span class="cd2-st-lbl">Est.</span>
          <span class="cd2-st-pill cd2-st-ocf"><span class="cd2-st-k">OCF</span><span class="cd2-st-v">${pOcf}</span></span>
          <span class="cd2-st-pill cd2-st-exr"><span class="cd2-st-k">EXR</span><span class="cd2-st-v">${pExr}</span></span>
        </div>

        <div class="cd2-kpi-sep"></div>

        <!-- Progress + Risk -->
        <div class="cd2-kpi-progress" title="Review progress — ${prog.pctDone}% done · ${prog.approved} of ${prog.total} reviewed">
          <div class="cd2-prog-bar-wrap"><div class="cd2-prog-bar" style="width:${prog.pctDone}%"></div></div>
          <div class="cd2-prog-nums">
            <span class="cd2-prog-done">${prog.approved}</span><span class="cd2-prog-sep">/</span><span class="cd2-prog-total">${prog.total}</span>
            <span class="cd2-prog-lbl">Done</span>
          </div>
        </div>
        <div class="cd2-kpi-risk" title="High-risk changes (new type / low confidence / large shift)">
          <span class="cd2-risk-n">${prog.highRisk}</span><span class="cd2-risk-l">Risk</span>
        </div>

        <div class="cd2-kpi-sep"></div>

        <!-- Audio compact -->
        <div class="cd2-kpi-audio" title="OLD: ${_cdSafeHtml(oldAudioFullRaw)} · NEW: ${_cdSafeHtml(newAudioFullRaw)} · ${audioStatusTitle} · ${audioDiffTitle}">
          <div class="cd2-aud-row"><span class="cd2-aud-k">OLD</span><span class="cd2-aud-v">${oldAudioText}</span></div>
          <div class="cd2-aud-row"><span class="cd2-aud-k">NEW</span><span class="cd2-aud-v">${newAudioText}</span></div>
          <div class="cd2-aud-row cd2-aud-diff"><span class="cd2-aud-k">Δ</span><span class="cd2-aud-v">${audioDiffCompact || audioStatusCompact || '—'}</span></div>
        </div>

      </div>
    `;

    infoEl.innerHTML = kpiHtml;

    // Wire filter buttons
    try{
      infoEl.querySelectorAll('[data-filter]')?.forEach?.(btn => {
        btn.addEventListener('click', (e) => {
          e.preventDefault();
          const t = btn.getAttribute('data-filter');
          _cdToggleType(t);
        });
      });
    }catch{}

    // Not ready => keep the KPI visible, but disable toggles to avoid confusing empty-state behavior.
    if (!isReady){
      try{
        infoEl.querySelectorAll('[data-filter]')?.forEach?.(btn => {
          btn.disabled = true;
          btn.classList.add('is-off');
          btn.style.opacity = '0.55';
          btn.style.cursor = 'not-allowed';
        });
      }catch{}
    }

    _cdSyncFilterUI();
    _cdRenderInsights(diff, prog, sumAll, removedCount, isReady);
  }

  function _cdRenderInsights(diff, prog, sumAll, removedCount, isReady) {
    const bar = document.getElementById('cdInsightsBar');
    if (!bar) return;
    if (!isReady || !diff?.length) { bar.hidden = true; return; }

    const insights = [];
    const warns = [];

    if ((sumAll.NEW || 0) > 0) {
      const n = sumAll.NEW;
      warns.push(`${n} new shot${n > 1 ? 's' : ''} need${n === 1 ? 's' : ''} DIT pull`);
    }
    if (prog.highRisk > 0) {
      warns.push(`${prog.highRisk} high-risk change${prog.highRisk > 1 ? 's' : ''} need review`);
    }
    if (removedCount > 0) {
      insights.push(`${removedCount} shot${removedCount > 1 ? 's' : ''} removed from cut`);
    }
    if ((sumAll.EXTENDED || 0) > 0) {
      insights.push(`${sumAll.EXTENDED} shot${sumAll.EXTENDED > 1 ? 's' : ''} extended`);
    }
    if (prog.pctDone === 100 && prog.total > 0) {
      insights.push('All shots reviewed');
    } else if (prog.pending > 0) {
      insights.push(`${prog.pending} shot${prog.pending > 1 ? 's' : ''} pending review`);
    }

    const isWarning = warns.length > 0;
    const allParts = [...warns, ...insights].filter(Boolean);
    const text = allParts.length ? allParts.join(' · ') : 'Analysis complete — no changes detected.';

    bar.hidden = false;
    bar.classList.toggle('cd2-ins-warn', isWarning);
    const textEl = bar.querySelector('.cd2-ins-text');
    if (textEl) textEl.textContent = text;
  }

  function exportCutDiffEDL(){
    if (!state.diff?.length){
      showError?.("No changed shots to export. Run Analyze CUT DiFF first.");
      return;
    }
    if (!buildEDLFiles){
      showError?.("EDL exporter not available.");
      return;
    }

    const baseName =
      state.newRaw?.projectName ||
      state.oldRaw?.projectName ||
      "CUT_DIFF";

    const projectTitle = `${baseName} CUT DIFF`;

    const parts = buildEDLFiles(
      state.diff,
      {
        projectName: projectTitle,
        autosplit:   true,
        metadata:    true,
        vfxMarker:   false,
        vfxRename:   false
      }
    );

    for (const p of (parts || [])){
      const blob = new Blob([p.content], { type:"text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = p.filename;
      a.click();
      setTimeout(() => { try{ URL.revokeObjectURL(a.href); }catch{} }, 1200);
    }
  }

  function _cdCsvEscape(v){
    const s = (v == null) ? '' : String(v);
    // Quote CSV field if it contains comma, quote, or newlines.
    // (Avoid regex literals here to prevent rare parsing issues that can freeze the UI.)
    if (s.indexOf(',') !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1){
      // Escape quotes by doubling them per RFC4180. Use split/join to avoid regex literals.
      return '"' + s.split('"').join('""') + '"';
    }
    return s;
  }

  function exportCutDiffCSV(){
    let payload;
    try{ payload = _cdBuildExportRows(); }
    catch(err){ showError?.(err?.message || String(err)); return; }

    const csv = _cdRowsToCsv(payload.rows);
    const filename = `${payload.baseName}_CutDiff_${payload.stamp}.csv`;

    const blob = new Blob([csv], { type:'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => { try{ URL.revokeObjectURL(a.href); }catch{} }, 1200);
  }

  function exportCutDiffVFXPack(){
    exportCutDiffPackageZip();
  }



  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  function ensureCutDiffFolderPicker(which){
    const id = which === "old" ? "__cutdiffOldFolderPicker" : "__cutdiffNewFolderPicker";
    let inp = document.getElementById(id);
    if (inp) return inp;

    inp = document.createElement("input");
    inp.type = "file";
    inp.id = id;
    inp.multiple = true;
    inp.setAttribute("webkitdirectory", "true");
    inp.setAttribute("directory", "true");
    inp.style.position = "fixed";
    inp.style.left = "-9999px";
    inp.style.top = "0";
    inp.style.width = "1px";
    inp.style.height = "1px";
    inp.style.opacity = "0";
    inp.style.pointerEvents = "none";
    document.body.appendChild(inp);

    on?.(inp, "change", async (e) => {
      const fs = [...(e.target.files || [])];
      const chosen = pickFCPXMLFromBundle ? pickFCPXMLFromBundle(fs) : null;
      if (!chosen){
        showError?.("No .fcpxml found in the selected .fcpxmld folder.");
        return;
      }
      await handleCutDiffFile(which, [chosen]);
    });

    return inp;
  }

  function wireKeyboard(){
    const wrap  = document.getElementById('cutdiffTableWrapper');
    const table = document.getElementById('cutdiffTable');
    if (!wrap || !table || wiredKeyboard) return;

    // Make wrapper focusable so it can receive key events
    if (!wrap.hasAttribute('tabindex')) wrap.tabIndex = 0;
    wrap.setAttribute('role', 'grid');
    wrap.setAttribute('aria-label', 'CUT DIFF Event Table');

    // Click row => select + focus wrapper
    on?.(table, 'click', (e) => {
      const tr = e.target?.closest?.('tbody tr[data-idx]');
      // Allow editing without hijacking focus
      if (e.target?.closest?.('select.cd-status,input.cd-note')) return;
      if (!tr) return;
      selState.srcIdx = Number(tr.dataset.idx);
      _cdApplySelection();
      _cdMarkDirty("select");
      try{ wrap.focus(); }catch{}
      try{ tr.scrollIntoView({ block: 'nearest' }); }catch{}
      // Auto-zoom compare timeline to selected clip
      if (tlState.mode === 'compare'){
        try{
          const ev = state.diff?.[selState.srcIdx];
          const fIn  = Number(ev?._recInF);
          const fOut = Number(ev?._recOutF);
          if (Number.isFinite(fIn) && Number.isFinite(fOut) && fOut > fIn){
            const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
            const meta   = tlState._meta || { startF: 0, range: 1 };
            const startF = Number(meta.startF) || 0;
            const range  = Math.max(1, Number(meta.range) || 1);
            const clipLen = fOut - fIn;
            // Target: clip fills ~65% of the viewport width
            const targetZoom = clamp(range / clipLen * 0.65, 1, 50);
            // Center the clip in the zoomed view
            const span      = range / targetZoom;
            const center    = (fIn + fOut) / 2;
            const maxStart  = startF + (range - span);
            const viewStart = clamp(center - span / 2, startF, maxStart);
            const targetPan = (range - span) > 0
              ? clamp((viewStart - startF) / (range - span), 0, 1)
              : 0;
            _cdSetCompareView({ zoom: targetZoom, pan: targetPan }, { rerender: true });
          }
        }catch{}
      }
    });

    // Row meta editing (Status / Note)
    on?.(table, 'input', (e) => {
      const el = e.target;
      if (!el) return;
      const tr = el.closest?.('tbody tr[data-idx]');
      if (!tr) return;
      const idx = Number(tr.dataset.idx);
      if (!Number.isFinite(idx) || !state.diff?.[idx]) return;
      const field = el.getAttribute?.('data-field');
      if (field === 'note'){
        state.diff[idx].note = String(el.value || '');
        _cdMarkDirty('note');
      }
    });
    on?.(table, 'change', (e) => {
      const el = e.target;
      if (!el) return;
      const tr = el.closest?.('tbody tr[data-idx]');
      if (!tr) return;
      const idx = Number(tr.dataset.idx);
      if (!Number.isFinite(idx) || !state.diff?.[idx]) return;
      const field = el.getAttribute?.('data-field');
      if (field === 'status'){
        state.diff[idx].status = String(el.value || '');
        _cdMarkDirty('status');
      }
    });

    // Keyboard navigation when wrapper is focused
    on?.(wrap, 'keydown', (e) => {
      const rows = _cdRows();
      if (!rows.length) return;

      const key = e.key;
      const pos = Number(selState.rowPos) || 0;

      // rows per page (based on wrapper height)
      const rowH = rows[0]?.getBoundingClientRect?.().height || 20;
      const pageStep = Math.max(1, Math.floor((wrap.clientHeight || 200) / rowH) - 1);

      let handled = true;
      if (key === 'ArrowUp')        _cdSelectByPos(pos - 1);
      else if (key === 'ArrowDown') _cdSelectByPos(pos + 1);
      else if (key === 'PageUp')    _cdSelectByPos(pos - pageStep);
      else if (key === 'PageDown')  _cdSelectByPos(pos + pageStep);
      else if (key === 'Home')      _cdSelectByPos(0);
      else if (key === 'End')       _cdSelectByPos(rows.length - 1);
      else handled = false;

      if (handled){
        e.preventDefault();
        e.stopPropagation();
        _cdMarkDirty("select");
      }
    });

    wiredKeyboard = true;
  }

  function wireSmartBar(){
    const bar = document.getElementById('cdSmartBar');
    if (!bar || bar._wired) return;
    bar._wired = true;

    // Batch status apply
    const applyBtn  = document.getElementById('cdBatchApply');
    const typeSelEl = document.getElementById('cdBatchType');
    const statusSelEl = document.getElementById('cdBatchStatus');
    on?.(applyBtn, 'click', () => {
      const typeFilter = String(typeSelEl?.value || '').toUpperCase();
      const newStatus  = String(statusSelEl?.value || '');
      if (!newStatus) return;
      const diff = state.diff || [];
      let changed = 0;
      for (const ev of diff){
        if (typeFilter && String(ev.diffType || '').toUpperCase() !== typeFilter) continue;
        ev.status = newStatus;
        changed++;
      }
      if (changed){
        renderTable();
        _cdRenderSummary();
        _cdMarkDirty('status');
      }
      if (statusSelEl) statusSelEl.value = '';
    });

    // Risk filter chips
    bar.querySelectorAll('[data-risk-filter]').forEach(btn => {
      on?.(btn, 'click', () => {
        _cdRiskFilter = btn.getAttribute('data-risk-filter') || 'all';
        bar.querySelectorAll('[data-risk-filter]').forEach(b => b.classList.toggle('is-active', b === btn));
        renderTable();
      });
    });

    // Auto-notes
    const autoNoteBtn = document.getElementById('cdAutoNote');
    on?.(autoNoteBtn, 'click', () => {
      const diff = state.diff || [];
      let filled = 0;
      for (const ev of diff){
        if (!ev.note || !ev.note.trim()){
          ev.note = _cdAutoNoteForEvent(ev);
          filled++;
        }
      }
      if (filled){
        renderTable();
        _cdMarkDirty('note');
      }
    });
  }

  function wireSorting(){
    const table = document.getElementById("cutdiffTable");
    if (!table || wiredSorting) return;

    on?.(table, "click", (ev) => {
      const th = ev.target.closest("th[data-sort]");
      if (!th) return;
      const key = th.getAttribute("data-sort");
      if (!key) return;

      if (sortState.key === key) sortState.dir *= -1;
      else { sortState.key = key; sortState.dir = 1; }

      renderTable();
      _cdMarkDirty("sort");
    });

    wiredSorting = true;
    renderHeaderSort();
  }

  async function dropIntoCutDiff(e){
    if (e.cancelable) e.preventDefault();
    const dt = e.dataTransfer;
    if (!dt) return;

    const files = handleDroppedDataTransfer ? await handleDroppedDataTransfer(dt) : [...(dt.files || [])];
    if (!files?.length) return;

    // If user drops 2+ timeline files at once: auto fill OLD then NEW (sorted)
    const tl = (pickTimelineFiles ? pickTimelineFiles(files) : files)
      .sort((a,b)=>String(a.name||"").localeCompare(String(b.name||"")));
    if (tl.length >= 2){
      await handleCutDiffFile("old", [tl[0]]);
      await handleCutDiffFile("new", [tl[1]]);
      return;
    }

    // Otherwise: decide target slot
    let which = (!state.oldRaw) ? "old" : (!state.newRaw ? "new" : "new");
    if (e.altKey) which = "old";
    if (e.shiftKey) which = "new";

    await handleCutDiffFile(which, files);
  }

  async function _cdGetDroppedFiles(e){
    if (e?.cancelable) e.preventDefault();
    const dt = e?.dataTransfer;
    if (!dt) return [];
    const files = handleDroppedDataTransfer ? await handleDroppedDataTransfer(dt) : [...(dt.files || [])];
    return Array.isArray(files) ? files.filter(Boolean) : [];
  }

  function _cdIsVideoFile(file){
    const name = String(file?.name || '').trim();
    const type = String(file?.type || '').trim().toLowerCase();
    return type.startsWith('video/') || /\.(mov|mp4|m4v|mxf|avi|webm|mkv)$/i.test(name);
  }

  async function _cdDropIntoSlot(which, kind, e){
    const files = await _cdGetDroppedFiles(e);
    if (!files.length) return;

    if (kind === 'video'){
      const vids = files.filter(_cdIsVideoFile).sort((a,b)=>String(a?.name||'').localeCompare(String(b?.name||'')));
      if (!vids.length){
        showError?.('Drop a video file on OLD or NEW.');
        return;
      }
      await _vcLoad(which, vids[0]);
      return;
    }

    const tl = (pickTimelineFiles ? pickTimelineFiles(files) : files).filter(Boolean);
    if (!tl.length){
      showError?.('Drop a supported timeline file on OLD or NEW.');
      return;
    }
    await handleCutDiffFile(which, tl);
  }

  function addTargetedDropZone(el, opts = {}){
    const card = document.getElementById('cutdiffCard');
    const which = String(opts?.which || '').toLowerCase();
    const kind = String(opts?.kind || 'timeline').toLowerCase();
    if (!el || !which) return;

    const onEnterOver = (e) => {
      if (e?.cancelable) e.preventDefault();
      if (typeof e?.stopPropagation === 'function') e.stopPropagation();
      try{ if (e?.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }catch{}
      card?.classList?.add?.('drag');
      el.classList.add('drag');
    };
    const onLeave = (e) => {
      if (typeof e?.stopPropagation === 'function') e.stopPropagation();
      const rt = e?.relatedTarget;
      if (rt && el.contains?.(rt)) return;
      el.classList.remove('drag');
      card?.classList?.remove?.('drag');
    };

    on?.(el, 'dragenter', onEnterOver);
    on?.(el, 'dragover', onEnterOver);
    on?.(el, 'dragleave', onLeave);
    on?.(el, 'drop', async (e) => {
      if (typeof e?.stopPropagation === 'function') e.stopPropagation();
      el.classList.remove('drag');
      card?.classList?.remove?.('drag');
      try{
        await _cdDropIntoSlot(which, kind, e);
      }catch(err){
        console.error('CUT DIFF targeted drop error:', err);
        showError?.(err?.message || String(err));
      }
    });
  }

  function addTargetedInputRow(el, opts = {}){
    const which = String(opts?.which || '').toLowerCase();
    const kind = String(opts?.kind || 'timeline').toLowerCase();
    const open = (typeof opts?.open === 'function') ? opts.open : null;
    if (!el || !which) return;

    addTargetedDropZone(el, { which, kind });

    try{
      el.setAttribute('role', 'button');
      if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    }catch{}

    const triggerOpen = (e) => {
      if (!open) return;
      try{ open(e); }catch(err){ console.error('CUT DIFF input row open error:', err); }
    };

    on?.(el, 'click', (e) => {
      const tgt = e?.target;
      if (tgt?.closest?.('button, input, select, textarea, a, label')) return;
      if (e?.cancelable) e.preventDefault();
      if (typeof e?.stopPropagation === 'function') e.stopPropagation();
      triggerOpen(e);
    });

    on?.(el, 'keydown', (e) => {
      const key = e?.key;
      if (key !== 'Enter' && key !== ' ') return;
      if (e?.cancelable) e.preventDefault();
      if (typeof e?.stopPropagation === 'function') e.stopPropagation();
      triggerOpen(e);
    });
  }

  function addDropZone(el){
    const card = document.getElementById("cutdiffCard");
    if (!el) return;

    on?.(el, "dragover", (e) => {
      if (e.cancelable) e.preventDefault();
      card?.classList.add("drag");
      el.classList.add("drag");
    });
    on?.(el, "dragleave", () => {
      card?.classList.remove("drag");
      el.classList.remove("drag");
    });
    on?.(el, "drop", async (e) => {
      el.classList.remove("drag");
      card?.classList.remove("drag");
      try{
        await dropIntoCutDiff(e);
      } catch(err){
        console.error("CUT DIFF drop error:", err);
        showError?.(err?.message || String(err));
      }
    });
  }

  function mount(){
    if (mounted) return;

    // Restore diff type filters
    _cdLoadFilters();

    // Sprint A: allow unified project loader to restore CUT DIFF
    try{ window.MPS_applyCutDiffSnapshot = _cdApplyProjectSnapshot; }catch{}

    // If a unified project was loaded before CUT DIFF mounted, apply it now.
    try{
      if (window.__MPS_CD_SNAPSHOT){
        _cdApplyProjectSnapshot(window.__MPS_CD_SNAPSHOT);
      }
    }catch{}

    // React to global project changes.
    try{
      if (!window.__MPS_CD_PROJECT_LISTENER){
        window.__MPS_CD_PROJECT_LISTENER = true;
        window.addEventListener('mps:project-applied', (e) => {
          try{
            const snap = e?.detail?.cutDiff || window.__MPS_CD_SNAPSHOT;
            if (snap) _cdApplyProjectSnapshot(snap);
          }catch{}
        });
      }
    }catch{}

    // Validation jump: from Validation panel → jump to a CUT DIFF row.
    try{
      if (!window.__MPS_CD_VALIDATION_JUMP_LISTENER){
        window.__MPS_CD_VALIDATION_JUMP_LISTENER = true;
        window.addEventListener('mps:validation-jump', (e) => {
          try{
            const t = e?.detail || {};
            if (!t) return;
            if (t.source !== 'cutdiff') return;

            // Activate tab (best-effort)
            try{
              const tab = document.querySelector('.tabs .tab[data-main="cutdiff"]');
              tab?.click?.();
            }catch{}

            // Prefer srcIdx (stable)
            const srcIdx = (t.idx != null) ? Number(t.idx) : null;
            const rows = _cdRows();
            if (!rows.length) return;

            let row = null;
            if (srcIdx != null){
              row = rows.find(r => Number(r.dataset.idx) === srcIdx) || null;
            }
            if (!row && t.name){
              const n = String(t.name).trim();
              row = rows.find(r => {
                // reel is col 3, clip name often in last col (hidden in this snippet) - best effort
                const txt = (r.textContent || '').trim();
                return txt.includes(n);
              }) || null;
            }
            if (!row) return;

            // Update selection state + scroll
            selState.srcIdx = Number(row.dataset.idx);
            selState.rowPos = rows.indexOf(row);
            _cdApplySelection();
            try{ row.scrollIntoView({ block:'center', behavior:'smooth' }); }catch{}
          }catch{}
        });
      }
    }catch{}

    // Project UI elements (optional - safe if not present)
    __cdUI.sel      = document.getElementById("cutdiffProjectSelect");
    __cdUI.btnNew   = document.getElementById("cutdiffProjectNew");
    __cdUI.btnRename= document.getElementById("cutdiffProjectRename");
    __cdUI.btnDelete= document.getElementById("cutdiffProjectDelete");
    __cdUI.btnSave  = document.getElementById("cutdiffProjectSave");
    __cdUI.btnSaveAs= document.getElementById("cutdiffProjectSaveAs");
    __cdUI.btnLoad  = document.getElementById("cutdiffProjectLoad");
    __cdUI.fileInput= document.getElementById("cutdiffProjectFileInput");
    __cdUI.status   = document.getElementById("cutdiffProjectStatus");

    const oldInput   = document.getElementById("cutdiffOldFile");
    const newInput   = document.getElementById("cutdiffNewFile");
    const oldBtn     = document.getElementById("cutdiffOldBrowse");
    const newBtn     = document.getElementById("cutdiffNewBrowse");
    const oldRow     = document.getElementById("cutdiffOldRow");
    const newRow     = document.getElementById("cutdiffNewRow");
    const vOldRow    = document.getElementById("cutdiffVcmpOldRow");
    const vNewRow    = document.getElementById("cutdiffVcmpNewRow");
    const analyzeBtn = document.getElementById("cutdiffAnalyzeBtn");
    const exportBtn  = document.getElementById("cutdiffExportBtn");
    const exportMenu = document.getElementById("cutdiffExportMenu");
    const exportCsvBtn = document.getElementById("cutdiffExportCsvBtn");
    const exportPdfBtn = document.getElementById("cutdiffExportPdfBtn");
    const exportPackBtn= document.getElementById("cutdiffExportPackBtn");
    const clearBtn   = document.getElementById("cutdiffClearBtn");
    const card       = document.getElementById("cutdiffCard");
    const mainPane   = document.getElementById("main-cutdiff");

    // Move actions panel to under Sources in left column
    try {
      const actionsCard = document.getElementById('cutdiffActionsCard');
      const sourcesCard = document.getElementById('cutdiffSourcesCard');
      if (actionsCard && sourcesCard && !sourcesCard.nextElementSibling?.id?.includes('cutdiffActionsCard')) {
        actionsCard.classList.add('cd-actions-inlined');
        sourcesCard.insertAdjacentElement('afterend', actionsCard);
      }
    } catch {}

    const oldFolder = ensureCutDiffFolderPicker("old");
    const newFolder = ensureCutDiffFolderPicker("new");

    // Video Compare (optional)
    try{ _vcInit(); }catch{}

    // Pause compare playback when the app is hidden or another main tab is active.
    try{
      if (!window.__PFX_CUTDIFF_VIS_PAUSE_WIRED){
        window.__PFX_CUTDIFF_VIS_PAUSE_WIRED = true;
        const pauseComparePlayback = () => {
          try{ __vcUI.vidOld.pause(); }catch{}
          try{ __vcUI.vidNew.pause(); }catch{}
          try{ _vcStopRaf(); }catch{}
          try{ _vcSetPlayIcon(); }catch{}
        };
        document.addEventListener('visibilitychange', () => {
          if (document.hidden) pauseComparePlayback();
        }, { passive: true });
        document.addEventListener('mps:mainTabChanged', (e) => {
          if (e?.detail?.key !== 'cutdiff') pauseComparePlayback();
        });
      }
    }catch{}

    // Project bar wiring
    if (__cdUI.sel){
      on?.(__cdUI.sel, "change", (e) => {
        const id = e.target?.value;
        void _cdSelectProject(id);
      });
    }
    if (__cdUI.btnNew)    on?.(__cdUI.btnNew,    "click", () => void _cdNewProject());
    if (__cdUI.btnRename) on?.(__cdUI.btnRename, "click", () => void _cdRenameProject());
    if (__cdUI.btnDelete) on?.(__cdUI.btnDelete, "click", () => void _cdDeleteProject());
    if (__cdUI.btnSave)   on?.(__cdUI.btnSave,   "click", () => void _cdSaveProjectFile("save"));
    if (__cdUI.btnSaveAs) on?.(__cdUI.btnSaveAs, "click", () => void _cdSaveProjectFile("saveas"));
    if (__cdUI.btnLoad && __cdUI.fileInput){
      on?.(__cdUI.btnLoad, "click", async () => {
        try{ __cdUI.fileInput.value = ""; }catch{}
        try{
          if (typeof window.showOpenFilePicker === 'function'){
            const [handle] = await window.showOpenFilePicker({
              multiple: false,
              excludeAcceptAllOption: false,
              types: [{ description: 'PostFlowX Cut Diff Project', accept: { 'application/json': ['.json', '.mpscutdiff.json'] } }]
            });
            const f = handle ? await handle.getFile() : null;
            if (f) await _cdImportProjectFile(f);
            return;
          }
        }catch(err){
          if (String(err?.name || '') === 'AbortError') return;
        }
        try{
          if (__cdUI.fileInput && typeof __cdUI.fileInput.showPicker === 'function') __cdUI.fileInput.showPicker();
          else __cdUI.fileInput?.click();
        }catch{
          try{ __cdUI.fileInput?.click(); }catch{}
        }
      });
      on?.(__cdUI.fileInput, "change", async (e) => {
        const f = e.target?.files?.[0];
        if (!f) return;
        try{ await _cdImportProjectFile(f); }
        catch(err){ showError?.(err?.message || String(err)); }
      });
    }

    // Options change -> autosave
    const maxSecInput = document.getElementById("cutdiffMaxSeconds");
    if (maxSecInput){
      on?.(maxSecInput, "input", () => _cdMarkDirty("options"));
      on?.(maxSecInput, "change", () => _cdMarkDirty("options"));
    }

    // Browse OLD (Shift-click => folder picker for .fcpxmld)
    if (oldBtn && oldInput){
      on?.(oldBtn, "click", (e) => {
        if (e?.shiftKey){
          oldFolder.value = "";
          oldFolder.click();
          return;
        }
        oldInput.value = "";
        oldInput.click();
      });
      on?.(oldInput, "change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) handleCutDiffFile("old", f);
      });
    }
    if (oldRow){
      addTargetedInputRow(oldRow, {
        which: 'old',
        kind: 'timeline',
        open: (e) => {
          if (e?.shiftKey && oldFolder){
            oldFolder.value = '';
            oldFolder.click();
            return;
          }
          if (oldInput){
            oldInput.value = '';
            oldInput.click();
          }
        }
      });
    }

    // Browse NEW (Shift-click => folder picker for .fcpxmld)
    if (newBtn && newInput){
      on?.(newBtn, "click", (e) => {
        if (e?.shiftKey){
          newFolder.value = "";
          newFolder.click();
          return;
        }
        newInput.value = "";
        newInput.click();
      });
      on?.(newInput, "change", (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) handleCutDiffFile("new", f);
      });
    }
    if (newRow){
      addTargetedInputRow(newRow, {
        which: 'new',
        kind: 'timeline',
        open: (e) => {
          if (e?.shiftKey && newFolder){
            newFolder.value = '';
            newFolder.click();
            return;
          }
          if (newInput){
            newInput.value = '';
            newInput.click();
          }
        }
      });
    }

    if (vOldRow){
      addTargetedInputRow(vOldRow, {
        which: 'old',
        kind: 'video',
        open: () => {
          if (__vcUI.inpOld){
            __vcUI.inpOld.value = '';
            __vcUI.inpOld.click();
          }
        }
      });
    }
    if (vNewRow){
      addTargetedInputRow(vNewRow, {
        which: 'new',
        kind: 'video',
        open: () => {
          if (__vcUI.inpNew){
            __vcUI.inpNew.value = '';
            __vcUI.inpNew.click();
          }
        }
      });
    }

    // Analyze / Export / Clear
    if (analyzeBtn) on?.(analyzeBtn, "click", () => analyzeCutDiff());
    if (exportBtn && exportMenu){
      let portalBound = false;
      const ensureExportMenuPortal = () => {
        try{
          if (portalBound) return;
          portalBound = true;
          exportMenu.classList.add('cd-export-menu--portal');
          if (exportMenu.parentElement !== document.body) document.body.appendChild(exportMenu);
        }catch{}
      };
      const positionExportMenu = () => {
        try{
          ensureExportMenuPortal();
          const rect = exportBtn.getBoundingClientRect();
          const vw = Math.max(document.documentElement?.clientWidth || 0, window.innerWidth || 0);
          const vh = Math.max(document.documentElement?.clientHeight || 0, window.innerHeight || 0);
          const gap = 8;
          const prevVis = exportMenu.style.visibility || '';
          const prevLeft = exportMenu.style.left || '';
          const prevTop = exportMenu.style.top || '';
          exportMenu.style.visibility = 'hidden';
          exportMenu.style.left = '0px';
          exportMenu.style.top = '0px';
          const w = Math.max(exportMenu.offsetWidth || 188, 188);
          const h = Math.max(exportMenu.offsetHeight || 0, 0);
          let left = Math.round(rect.right - w);
          let top = Math.round(rect.bottom + gap);
          if (left < 8) left = 8;
          if ((left + w) > (vw - 8)) left = Math.max(8, vw - w - 8);
          if ((top + h) > (vh - 8)) top = Math.max(8, Math.round(rect.top - h - gap));
          exportMenu.style.left = left + 'px';
          exportMenu.style.top = top + 'px';
          exportMenu.style.visibility = prevVis;
          if (!prevLeft){} else exportMenu.style.left = left + 'px';
          if (!prevTop){} else exportMenu.style.top = top + 'px';
        }catch{}
      };
      const closeExportMenu = () => {
        try{ exportMenu.hidden = true; }catch{}
        try{ exportBtn.setAttribute('aria-expanded', 'false'); }catch{}
      };
      const openExportMenu = () => {
        try{ ensureExportMenuPortal(); }catch{}
        try{ exportMenu.hidden = false; }catch{}
        try{ exportBtn.setAttribute('aria-expanded', 'true'); }catch{}
        try{ positionExportMenu(); }catch{}
      };
      on?.(exportBtn, 'click', (ev) => {
        try{ ev?.preventDefault?.(); ev?.stopPropagation?.(); }catch{}
        const isOpen = !exportMenu.hidden;
        if (isOpen) closeExportMenu();
        else openExportMenu();
      });
      exportMenu.querySelectorAll('.cd-export-item').forEach((btn) => {
        on?.(btn, 'click', (ev) => {
          const act = String(btn.dataset.act || '').toLowerCase();
          closeExportMenu();
          if (act === 'xlsx') void exportCutDiffXLSX();
          else if (act === 'pdf') exportCutDiffPDF();
          else if (act === 'csv') exportCutDiffCSV();
          else if (act === 'edl') exportCutDiffEDL();
          else if (act === 'ale') exportCutDiffALE();
          else if (act === 'pkg') void exportCutDiffPackageZip();
          try{ ev?.preventDefault?.(); ev?.stopPropagation?.(); }catch{}
        });
      });
      const _onDocClickExport = (ev) => {
        const t = ev?.target;
        if (t && (exportBtn.contains(t) || exportMenu.contains(t))) return;
        closeExportMenu();
      };
      const _onDocKeyExport = (ev) => {
        if (String(ev?.key || '') === 'Escape') closeExportMenu();
      };
      const _onWinResizeExport = () => { if (!exportMenu.hidden) positionExportMenu(); };
      const _onWinScrollExport = () => { if (!exportMenu.hidden) positionExportMenu(); };
      on?.(document, 'click', _onDocClickExport);
      on?.(document, 'keydown', _onDocKeyExport);
      window.addEventListener('resize', _onWinResizeExport);
      window.addEventListener('scroll', _onWinScrollExport, { passive:true, capture:true });
      // Store for destroy-time cleanup
      _cdExportMenuCleanup = () => {
        try{ document.removeEventListener('click', _onDocClickExport); }catch{}
        try{ document.removeEventListener('keydown', _onDocKeyExport); }catch{}
        try{ window.removeEventListener('resize', _onWinResizeExport); }catch{}
        try{ window.removeEventListener('scroll', _onWinScrollExport, { capture:true }); }catch{}
      };
    }
    if (exportCsvBtn)   on?.(exportCsvBtn,   "click", () => exportCutDiffCSV());
    if (exportPdfBtn)   on?.(exportPdfBtn,   "click", () => exportCutDiffPDF());
    if (exportPackBtn)  on?.(exportPackBtn,  "click", () => exportCutDiffVFXPack());
    if (clearBtn)   on?.(clearBtn,   "click", async () => { clear(); try{ await window.PFX_clearAllTabs?.(); }catch{} });

    // Drag & drop support: card + main pane (works like EDL Converter)
    addDropZone(card);
    addDropZone(mainPane);

    // init
    wireSorting();
    wireKeyboard();
    wireSmartBar();
    updateHeartbeat();
    _cdEnsureTimelineUI();
    _cdRenderCompareLock();
    // Always show Summary/KPIs even before Analyze (Hawkins compact layout).
    try{ _cdRenderSummary(); }catch{}
    _cdRenderTimelineActive(true);

    // auto-restore last active project
    void _cdInitProjectUI();

    mounted = true;
  }

  // ---------------------------------------------------------------------------
  // Heartbeat + Clear
  // ---------------------------------------------------------------------------
  function updateHeartbeat(){
    const oldBtn     = document.getElementById("cutdiffOldBrowse");
    const newBtn     = document.getElementById("cutdiffNewBrowse");
    const analyzeBtn = document.getElementById("cutdiffAnalyzeBtn");
    const exportBtn  = document.getElementById("cutdiffExportBtn");
    const exportCsvBtn = document.getElementById("cutdiffExportCsvBtn");
    const exportPdfBtn = document.getElementById("cutdiffExportPdfBtn");
    const exportPackBtn= document.getElementById("cutdiffExportPackBtn");

    if (!oldBtn || !newBtn || !analyzeBtn || !exportBtn) return;
    // ✅ UX change: no heartbeat/pulse animations in Cut Diff.
    // Keep clarity via enabled/disabled states + vertical accent bars.
    [oldBtn, newBtn, analyzeBtn, exportBtn, exportCsvBtn, exportPdfBtn, exportPackBtn]
      .filter(Boolean)
      .forEach(btn => btn.classList.remove('heartbeat'));
  }

  function _cdSafeStem(name){
    return String(name || 'CUT_DIFF').replace(/[\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'CUT_DIFF';
  }

  function _cdDownloadBytesFile(bytes, filename, mimeType='application/octet-stream'){
    const blob = new Blob([bytes], { type: mimeType });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => { try{ URL.revokeObjectURL(a.href); }catch{} }, 1200);
  }

  function _cdBuildExportRows(){
    if (!state.analyzed){
      throw new Error('Please run Analyze CUT first.');
    }

    const fps = _cdGetFps();
    const rows = [];

    const oMeta = state.oldRaw?.fileMeta || {};
    const nMeta = state.newRaw?.fileMeta || {};
    const oldAudioCsv = _cdAudioSummaryText(state.oldRaw?.audioMeta);
    const newAudioCsv = _cdAudioSummaryText(state.newRaw?.audioMeta);
    const audioCompareCsv = _cdAudioCompareLabel(state.oldRaw?.audioMeta, state.newRaw?.audioMeta);
    const audioCmpCsv = _cdGetAudioCompareData();
    const oldAudioTracksCsv = _cdAudioTrackStatsText(state.oldRaw?.audioEvents, fps, { maxTracks: 12 });
    const newAudioTracksCsv = _cdAudioTrackStatsText(state.newRaw?.audioEvents, fps, { maxTracks: 12 });
    const audioDiffByTrackCsv = _cdAudioDiffTrackStatsText(audioCmpCsv, fps, { maxTracks: 12 });

    const header = [
      'ChangeType','RowKind','Reel','ClipName','OriginalFileName','TrackLabel','TrackIndex','SrcIn','SrcOut','RecIn','RecOut','DurationFrames',
      'Confidence','MatchReason','OldClipName','OldOriginalFileName','OldTrackLabel','OldTrackIndex','OldSrcIn','OldSrcOut','OldRecIn','OldRecOut',
      'Status','Note',
      'OldFile','OldSHA256','NewFile','NewSHA256','FPS','OldAudio','NewAudio','AudioStatus','OldAudioTracks','NewAudioTracks','AudioDiffByTrack'
    ];
    rows.push(header);

    const entries = [];
    const addRow = (ev, changeTypeOverride, rowKind = 'VIDEO') => {
      const t = String(changeTypeOverride || ev?.diffType || '');
      const conf = (ev?.matchScore != null) ? String(Math.round(Number(ev.matchScore)*100)) : '';
      entries.push({ event: ev || null, changeType: t, rowKind: rowKind || 'VIDEO' });
      rows.push([
        t,
        rowKind,
        ev?.reel || '',
        ev?.clipName || '',
        _cdBaseFileName(ev?.srcFile || ''),
        ev?.trackLabel || '',
        String((ev?.trackIndex != null) ? ev.trackIndex : ''),
        ev?.srcIn || '',
        ev?.srcOut || '',
        ev?.recIn || '',
        ev?.recOut || '',
        String(ev?._lenFrames ?? ''),
        conf,
        ev?.matchReason || '',
        ev?.matchOldClipName || '',
        _cdBaseFileName(ev?.matchOldSrcFile || ''),
        ev?.matchOldTrackLabel || '',
        String((ev?.matchOldTrackIndex != null) ? ev.matchOldTrackIndex : ''),
        ev?.matchOldSrcIn || '',
        ev?.matchOldSrcOut || '',
        ev?.matchOldRecIn || '',
        ev?.matchOldRecOut || '',
        ev?.status || '',
        ev?.note || '',
        oMeta?.name || (state.oldRaw?.projectName||''),
        oMeta?.sha256 || '',
        nMeta?.name || (state.newRaw?.projectName||''),
        nMeta?.sha256 || '',
        String(fps),
        oldAudioCsv,
        newAudioCsv,
        audioCompareCsv,
        oldAudioTracksCsv,
        newAudioTracksCsv,
        audioDiffByTrackCsv
      ]);
    };

    const addAudioRow = (ev, changeTypeOverride) => {
      const t = String(changeTypeOverride || ev?.diffType || '');
      const row = {
        ...ev,
        _lenFrames: (ev?._lenFrames != null) ? ev._lenFrames : Math.max(1, (Number(ev?._recOutF) || 0) - (Number(ev?._recInF) || 0)),
        matchOldTrackLabel: ev?.matchOldTrackLabel || ((String(t).toUpperCase() === 'REMOVED') ? ev?.trackLabel : ''),
        matchOldTrackIndex: (ev?.matchOldTrackIndex != null) ? ev.matchOldTrackIndex : ((String(t).toUpperCase() === 'REMOVED') ? ev?.trackIndex : ''),
        matchOldClipName: ev?.matchOldClipName || ((String(t).toUpperCase() === 'REMOVED') ? ev?.clipName : ''),
        matchOldSrcFile: ev?.matchOldSrcFile || ((String(t).toUpperCase() === 'REMOVED') ? ev?.srcFile : ''),
        matchOldSrcIn: ev?.matchOldSrcIn || ((String(t).toUpperCase() === 'REMOVED') ? ev?.srcIn : ''),
        matchOldSrcOut: ev?.matchOldSrcOut || ((String(t).toUpperCase() === 'REMOVED') ? ev?.srcOut : ''),
        matchOldRecIn: ev?.matchOldRecIn || ((String(t).toUpperCase() === 'REMOVED') ? ev?.recIn : ''),
        matchOldRecOut: ev?.matchOldRecOut || ((String(t).toUpperCase() === 'REMOVED') ? ev?.recOut : ''),
      };
      addRow(row, t, 'AUDIO');
    };

    for (const ev of (state.diff || [])) addRow(ev);
    for (const ev of (state.removed || [])) addRow(ev, 'REMOVED');
    for (const ev of (audioCmpCsv?.diff || [])) addAudioRow(ev);
    for (const ev of (audioCmpCsv?.removed || [])) addAudioRow(ev, 'REMOVED');

    const baseName = _cdSafeStem(state.newRaw?.projectName || state.oldRaw?.projectName || 'CUT_DIFF');
    const stamp = _cdNowISO().replace(/[:.]/g,'-');
    return { rows, fps, baseName, stamp, entries };
  }

  function _cdRowsToCsv(rows){
    const _CD_NL = String.fromCharCode(10);
    return (rows || []).map(r => (r || []).map(_cdCsvEscape).join(',')).join(_CD_NL);
  }

  const __CD_CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i=0;i<256;i++){
      let c = i;
      for (let k=0;k<8;k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();
  function __cdCrc32(u8){
    let c = 0xFFFFFFFF;
    for (let i=0;i<u8.length;i++) c = __CD_CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }
  function _cdU8FromStr(s){ return new TextEncoder().encode(String(s ?? '')); }
  function _cdZipStore(filesMap){
    const names = Object.keys(filesMap || {});
    const enc = new TextEncoder();
    const locals = [];
    const centrals = [];
    let offset = 0;
    const pushU16 = (arr, v) => { arr.push(v & 255, (v >>> 8) & 255); };
    const pushU32 = (arr, v) => { arr.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); };
    const GP_UTF8 = 0x0800;
    const V_NEEDED = 20;
    const V_MADEBY = (3 << 8) | V_NEEDED;
    const now = new Date();
    const dosTime = (((now.getHours() & 31) << 11) | ((now.getMinutes() & 63) << 5) | (Math.floor((now.getSeconds() & 59) / 2) & 31)) & 0xFFFF;
    const dosDate = ((((now.getFullYear() - 1980) & 127) << 9) | (((now.getMonth() + 1) & 15) << 5) | (now.getDate() & 31)) & 0xFFFF;
    for (const name of names){
      const data = filesMap[name] || new Uint8Array();
      const nameBytes = enc.encode(name);
      const crc = __cdCrc32(data);
      const size = data.length >>> 0;
      const lh = [];
      pushU32(lh, 0x04034b50); pushU16(lh, V_NEEDED); pushU16(lh, GP_UTF8); pushU16(lh, 0); pushU16(lh, dosTime); pushU16(lh, dosDate);
      pushU32(lh, crc); pushU32(lh, size); pushU32(lh, size); pushU16(lh, nameBytes.length); pushU16(lh, 0);
      const lhU8 = new Uint8Array(lh);
      locals.push(lhU8, nameBytes, data);
      const ch = [];
      pushU32(ch, 0x02014b50); pushU16(ch, V_MADEBY); pushU16(ch, V_NEEDED); pushU16(ch, GP_UTF8); pushU16(ch, 0); pushU16(ch, dosTime); pushU16(ch, dosDate);
      pushU32(ch, crc); pushU32(ch, size); pushU32(ch, size); pushU16(ch, nameBytes.length); pushU16(ch, 0); pushU16(ch, 0); pushU16(ch, 0); pushU16(ch, 0); pushU32(ch, 0); pushU32(ch, offset);
      const chU8 = new Uint8Array(ch);
      centrals.push(chU8, nameBytes);
      offset += lhU8.length + nameBytes.length + data.length;
    }
    let centralSize = 0; for (const p of centrals) centralSize += p.length;
    const eocd = [];
    pushU32(eocd, 0x06054b50); pushU16(eocd, 0); pushU16(eocd, 0); pushU16(eocd, names.length); pushU16(eocd, names.length); pushU32(eocd, centralSize); pushU32(eocd, offset); pushU16(eocd, 0);
    const total = offset + centralSize + eocd.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of locals){ out.set(p, pos); pos += p.length; }
    for (const p of centrals){ out.set(p, pos); pos += p.length; }
    out.set(new Uint8Array(eocd), pos);
    return out;
  }

  function _cdXmlEsc(value){
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
  function _cdXlsxColName(idx){
    let n = Number(idx) + 1;
    let out = '';
    while (n > 0){
      const rem = (n - 1) % 26;
      out = String.fromCharCode(65 + rem) + out;
      n = Math.floor((n - 1) / 26);
    }
    return out || 'A';
  }
  function _cdBuildSimpleXlsxBytes(rows, sheetName='CutDiff'){
    const safeSheet = String(sheetName || 'CutDiff').slice(0, 31).replace(/[\/*?:\[\]]/g, '_') || 'CutDiff';
    const rowXml = (rows || []).map((row, rowIdx) => {
      const cells = (row || []).map((cell, colIdx) => {
        const text = String(cell ?? '');
        if (!text) return '';
        const ref = `${_cdXlsxColName(colIdx)}${rowIdx + 1}`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${_cdXmlEsc(text)}</t></is></c>`;
      }).join('');
      return `<row r="${rowIdx + 1}">${cells}</row>`;
    }).join('');
    const lastCol = _cdXlsxColName(Math.max(0, ((rows?.[0]?.length || 1) - 1)));
    const lastRow = Math.max(1, rows?.length || 1);
    const files = {
      '[Content_Types].xml': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`),
      '_rels/.rels': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`),
      'docProps/app.xml': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>PostFlowX</Application><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${_cdXmlEsc(safeSheet)}</vt:lpstr></vt:vector></TitlesOfParts></Properties>`),
      'docProps/core.xml': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>PostFlowX</dc:creator><cp:lastModifiedBy>PostFlowX</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`),
      'xl/workbook.xml': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${_cdXmlEsc(safeSheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
      'xl/styles.xml': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Aptos"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`),
      'xl/worksheets/sheet1.xml': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastCol}${lastRow}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>${rowXml}</sheetData><autoFilter ref="A1:${lastCol}${lastRow}"/></worksheet>`)
    };
    return _cdZipStore(files);
  }

  function _cdDataUrlToU8(dataUrl){
    const m = String(dataUrl || '').match(/^data:([^;,]+)?(?:;charset=[^;,]+)?(;base64)?,(.*)$/i);
    if (!m) return new Uint8Array();
    const isB64 = !!m[2];
    const data = m[3] || '';
    const bin = isB64 ? atob(data) : decodeURIComponent(data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 255;
    return out;
  }
  function _cdAleSafe(value){
    return String(value ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  }
  async function _cdLoadImageEl(url){
    return await new Promise((resolve) => {
      try{
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = String(url || '');
      }catch{
        resolve(null);
      }
    });
  }
  async function _cdComposeExportThumb(oldUrl, newUrl){
    const W = 320;
    const H = 180;
    const cvs = document.createElement('canvas');
    cvs.width = W;
    cvs.height = H;
    const ctx = cvs.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = '#101014';
    ctx.fillRect(0, 0, W, H);
    const drawFit = (img, x, y, w, h, label) => {
      if (!img) return;
      ctx.save();
      ctx.fillStyle = '#17171c';
      ctx.fillRect(x, y, w, h);
      const vw = Math.max(1, img.naturalWidth || img.width || 1);
      const vh = Math.max(1, img.naturalHeight || img.height || 1);
      const s = Math.min(w / vw, h / vh);
      const dw = Math.round(vw * s);
      const dh = Math.round(vh * s);
      const dx = x + Math.round((w - dw) / 2);
      const dy = y + Math.round((h - dh) / 2);
      ctx.drawImage(img, dx, dy, dw, dh);
      if (label){
        ctx.fillStyle = 'rgba(0,0,0,0.58)';
        ctx.fillRect(x + 6, y + 6, 38, 18);
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px Arial';
        ctx.fillText(label, x + 12, y + 19);
      }
      ctx.restore();
    };
    const oldImg = oldUrl ? await _cdLoadImageEl(oldUrl) : null;
    const newImg = newUrl ? await _cdLoadImageEl(newUrl) : null;
    if (oldImg && newImg){
      drawFit(oldImg, 0, 0, Math.floor(W / 2), H, 'OLD');
      drawFit(newImg, Math.floor(W / 2), 0, Math.ceil(W / 2), H, 'NEW');
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(Math.floor(W / 2), 0);
      ctx.lineTo(Math.floor(W / 2), H);
      ctx.stroke();
    } else if (newImg){
      drawFit(newImg, 0, 0, W, H, 'NEW');
    } else if (oldImg){
      drawFit(oldImg, 0, 0, W, H, 'OLD');
    } else {
      return '';
    }
    return cvs.toDataURL('image/jpeg', 0.86);
  }
  async function _cdBuildThumbDataUrls(payload){
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    if (!entries.length) return [];
    const fps = Number(payload?.fps || _cdGetFps() || 24) || 24;
    const diffList = Array.isArray(state.diff) ? state.diff : [];
    const removedList = Array.isArray(state.removed) ? state.removed : [];
    const diffNewMap = await _cdCaptureThumbs(diffList, 'new', (ev) => Number(ev?._recInF), 220);
    const diffOldMap = await _cdCaptureThumbs(diffList, 'old', (ev) => {
      const f = _cdTcNum(ev?.matchOldRecIn, fps);
      return Number.isFinite(f) ? f : NaN;
    }, 220);
    const remOldMap = await _cdCaptureThumbs(removedList, 'old', (ev) => Number(ev?._recInF), 220);
    const diffNewByEv = new Map();
    const diffOldByEv = new Map();
    const remOldByEv = new Map();
    diffList.forEach((ev, i) => {
      if (diffNewMap.has(i)) diffNewByEv.set(ev, diffNewMap.get(i));
      if (diffOldMap.has(i)) diffOldByEv.set(ev, diffOldMap.get(i));
    });
    removedList.forEach((ev, i) => {
      if (remOldMap.has(i)) remOldByEv.set(ev, remOldMap.get(i));
    });
    const out = [];
    for (const entry of entries){
      if (String(entry?.rowKind || '').toUpperCase() !== 'VIDEO'){
        out.push('');
        continue;
      }
      const ev = entry?.event || null;
      const type = String(entry?.changeType || ev?.diffType || '').toUpperCase();
      const oldUrl = (type === 'REMOVED') ? (remOldByEv.get(ev) || '') : (diffOldByEv.get(ev) || '');
      const newUrl = (type === 'REMOVED') ? '' : (diffNewByEv.get(ev) || '');
      out.push(await _cdComposeExportThumb(oldUrl, newUrl));
    }
    return out;
  }
  function _cdBuildXlsxWithThumbsBytes(rows, thumbUrls, sheetName='CutDiff'){
    const safeSheet = String(sheetName || 'CutDiff').slice(0, 31).replace(/[\/*?:\[\]]/g, '_') || 'CutDiff';
    const dataRows = Array.isArray(rows) ? rows : [];
    const xRows = dataRows.map((row, idx) => idx === 0 ? ['Thumbnail', ...(row || [])] : ['', ...(row || [])]);
    const imgEntries = [];
    const rowXml = xRows.map((row, rowIdx) => {
      const cells = (row || []).map((cell, colIdx) => {
        const text = String(cell ?? '');
        if (!text) return '';
        const ref = `${_cdXlsxColName(colIdx)}${rowIdx + 1}`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${_cdXmlEsc(text)}</t></is></c>`;
      }).join('');
      const isHeader = rowIdx === 0;
      const height = isHeader ? 20 : ((thumbUrls && thumbUrls[rowIdx - 1]) ? 58 : 18);
      return `<row r="${rowIdx + 1}" ht="${height}" customHeight="1">${cells}</row>`;
    }).join('');
    const lastCol = _cdXlsxColName(Math.max(0, ((xRows?.[0]?.length || 1) - 1)));
    const lastRow = Math.max(1, xRows?.length || 1);
    const files = {
      '[Content_Types].xml': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="jpeg" ContentType="image/jpeg"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`),
      '_rels/.rels': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`),
      'docProps/app.xml': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>PostFlowX</Application><TitlesOfParts><vt:vector size="1" baseType="lpstr"><vt:lpstr>${_cdXmlEsc(safeSheet)}</vt:lpstr></vt:vector></TitlesOfParts></Properties>`),
      'docProps/core.xml': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>PostFlowX</dc:creator><cp:lastModifiedBy>PostFlowX</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`),
      'xl/workbook.xml': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${_cdXmlEsc(safeSheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`),
      'xl/styles.xml': _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Aptos"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>`)
    };
    const colsXml = `<cols><col min="1" max="1" width="20" customWidth="1"/><col min="2" max="${xRows[0]?.length || 2}" width="15" customWidth="1"/></cols>`;
    const hasImages = Array.isArray(thumbUrls) && thumbUrls.some(Boolean);
    files['xl/worksheets/sheet1.xml'] = _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${lastCol}${lastRow}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>${colsXml}<sheetFormatPr defaultRowHeight="15"/><sheetData>${rowXml}</sheetData><autoFilter ref="A1:${lastCol}${lastRow}"/>${hasImages ? '<drawing r:id="rId1"/>' : ''}</worksheet>`);
    if (hasImages){
      files['xl/worksheets/_rels/sheet1.xml.rels'] = _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`);
      let relId = 1;
      const rels = [];
      const anchors = [];
      for (let i = 0; i < thumbUrls.length; i++){
        const dataUrl = thumbUrls[i];
        if (!dataUrl) continue;
        const rowNumber = i + 2;
        const name = `image${relId}.jpg`;
        files[`xl/media/${name}`] = _cdDataUrlToU8(dataUrl);
        rels.push(`<Relationship Id="rId${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${name}"/>`);
        anchors.push(`<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>0</xdr:col><xdr:colOff>19050</xdr:colOff><xdr:row>${rowNumber - 1}</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:from><xdr:to><xdr:col>1</xdr:col><xdr:colOff>19050</xdr:colOff><xdr:row>${rowNumber}</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${relId}" name="${name}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId${relId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`);
        relId += 1;
      }
      files['xl/drawings/_rels/drawing1.xml.rels'] = _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
      files['xl/drawings/drawing1.xml'] = _cdU8FromStr(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${anchors.join('')}</xdr:wsDr>`);
    }
    return _cdZipStore(files);
  }

  function _cdBuildAleText(payload){
    const fps = Number(payload?.fps || _cdGetFps() || 24) || 24;
    const lines = [];
    lines.push('Heading');
    lines.push('FIELD_DELIM\tTABS');
    lines.push(`FPS\t${_cdAleSafe(String(fps))}`);
    lines.push('VIDEO_FORMAT\t1080');
    lines.push('AUDIO_FORMAT\t48khz');
    lines.push('');
    lines.push('Column');
    const cols = ['Name','Tape','Start','End','Duration','ChangeType','RowKind','ClipName','SourceFile','Track','Status','Note','OldClipName','OldSourceFile','OldTrack','OldStart','OldEnd'];
    lines.push(cols.join('\t'));
    lines.push('Data');
    const rows = Array.isArray(payload?.rows) ? payload.rows.slice(1) : [];
    const entries = Array.isArray(payload?.entries) ? payload.entries : [];
    rows.forEach((row, idx) => {
      const entry = entries[idx] || {};
      const name = row?.[3] || row?.[2] || `EVENT_${idx + 1}`;
      const tape = row?.[2] || row?.[3] || '';
      const data = [
        name,
        tape,
        row?.[9] || '',
        row?.[10] || '',
        row?.[11] || '',
        entry?.changeType || row?.[0] || '',
        entry?.rowKind || row?.[1] || '',
        row?.[3] || '',
        row?.[4] || '',
        row?.[5] || '',
        row?.[22] || '',
        row?.[23] || '',
        row?.[13] || '',
        row?.[14] || '',
        row?.[15] || '',
        row?.[20] || '',
        row?.[21] || ''
      ].map(_cdAleSafe);
      lines.push(data.join('\t'));
    });
    lines.push('');
    return lines.join('\r\n');
  }

  async function exportCutDiffXLSX(){
    let payload;
    try{ payload = _cdBuildExportRows(); }
    catch(err){ showError?.(err?.message || String(err)); return; }
    const filename = `${payload.baseName}_CutDiff_${payload.stamp}.xlsx`;
    let thumbUrls = [];
    let hasThumbs = false;
    try{
      thumbUrls = await _cdBuildThumbDataUrls(payload);
      hasThumbs = Array.isArray(thumbUrls) && thumbUrls.some(Boolean);
    }catch(err){
      console.warn('CutDiff XLSX thumbnail capture failed; exporting without thumbnails.', err);
      thumbUrls = [];
      hasThumbs = false;
    }
    try{
      const bytes = hasThumbs ? _cdBuildXlsxWithThumbsBytes(payload.rows, thumbUrls, 'CutDiff') : _cdBuildSimpleXlsxBytes(payload.rows, 'CutDiff');
      _cdDownloadBytesFile(bytes, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      if (!hasThumbs) showNotice?.('XLSX exported' + (thumbUrls?.length ? ' (without thumbnails)' : ''));
    }catch(err){
      console.warn('CutDiff XLSX export with thumbnails failed; retrying without thumbnails.', err);
      try{
        const bytes = _cdBuildSimpleXlsxBytes(payload.rows, 'CutDiff');
        _cdDownloadBytesFile(bytes, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      }catch(err2){
        console.error('CutDiff XLSX export failed', err2);
        showError?.(err2?.message || String(err2));
      }
    }
  }

  function exportCutDiffALE(){
    let payload;
    try{ payload = _cdBuildExportRows(); }
    catch(err){ showError?.(err?.message || String(err)); return; }
    const aleText = _cdBuildAleText(payload);
    _cdDownloadBytesFile(_cdU8FromStr(aleText), `${payload.baseName}_CutDiff_${payload.stamp}.ale`, 'text/plain;charset=utf-8');
  }

  async function exportCutDiffPackageZip(){
    let payload;
    try{ payload = _cdBuildExportRows(); }
    catch(err){ showError?.(err?.message || String(err)); return; }
    const csvText = _cdRowsToCsv(payload.rows);
    let thumbUrls = [];
    let hasThumbs = false;
    try{
      thumbUrls = await _cdBuildThumbDataUrls(payload);
      hasThumbs = Array.isArray(thumbUrls) && thumbUrls.some(Boolean);
    }catch(err){
      console.warn('CutDiff package thumbnail capture failed; exporting without thumbnails.', err);
      thumbUrls = [];
      hasThumbs = false;
    }
    const buildFiles = (includeThumbs) => {
      const files = {};
      if (includeThumbs) files['thumbnail/'] = new Uint8Array();
      files[`${payload.baseName}_CutDiff_${payload.stamp}.csv`] = _cdU8FromStr(csvText);
      files[`${payload.baseName}_CutDiff_${payload.stamp}.xlsx`] = includeThumbs ? _cdBuildXlsxWithThumbsBytes(payload.rows, thumbUrls, 'CutDiff') : _cdBuildSimpleXlsxBytes(payload.rows, 'CutDiff');
      files[`${payload.baseName}_CutDiff_${payload.stamp}.ale`] = _cdU8FromStr(_cdBuildAleText(payload));
      if (state.diff?.length && buildEDLFiles){
        try{
          files['EDL/'] = new Uint8Array();
          const parts = buildEDLFiles(state.diff, {
            projectName: `${payload.baseName} CUT DIFF`,
            autosplit: true,
            metadata: true,
            vfxMarker: false,
            vfxRename: false
          }) || [];
          for (const p of parts){
            if (!p?.filename) continue;
            files[`EDL/${p.filename}`] = _cdU8FromStr(p.content || '');
          }
        }catch(err){ console.warn('CutDiff package EDL build failed', err); }
      }
      if (includeThumbs){
        const entries = Array.isArray(payload.entries) ? payload.entries : [];
        thumbUrls.forEach((url, idx) => {
          if (!url) return;
          const entry = entries[idx] || {};
          const ev = entry?.event || {};
          const label = _cdSafeStem(`${String(entry?.changeType || ev?.diffType || 'ROW').toUpperCase()}_${ev?.clipName || ev?.reel || ('ROW_' + String(idx + 1).padStart(3,'0'))}`);
          files[`thumbnail/${String(idx + 1).padStart(3,'0')}_${label}.jpg`] = _cdDataUrlToU8(url);
        });
      }
      files['manifest.json'] = _cdU8FromStr(JSON.stringify({
        exportedAt: new Date().toISOString(),
        project: payload.baseName,
        diffCount: state.diff?.length || 0,
        removedCount: state.removed?.length || 0,
        analyzed: !!state.analyzed,
        hasThumbnailFolder: !!includeThumbs,
        files: Object.keys(files)
      }, null, 2));
      return files;
    };
    try{
      const zipBytes = _cdZipStore(buildFiles(hasThumbs));
      _cdDownloadBytesFile(zipBytes, `${payload.baseName}_CutDiff_Export_${payload.stamp}.zip`, 'application/zip');
    }catch(err){
      console.warn('CutDiff package ZIP export with thumbnails failed; retrying without thumbnails.', err);
      try{
        const zipBytes = _cdZipStore(buildFiles(false));
        _cdDownloadBytesFile(zipBytes, `${payload.baseName}_CutDiff_Export_${payload.stamp}.zip`, 'application/zip');
      }catch(err2){
        console.error('CutDiff package ZIP export failed', err2);
        showError?.(err2?.message || String(err2));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Export PDF (Print-to-PDF)
  // ---------------------------------------------------------------------------
  async function exportCutDiffPDF(){
    if (!state.analyzed){
      showError?.('Please run Analyze CUT first.');
      return;
    }

    const fps = _cdGetFps();
    _cdEnsureFrames(state.oldView, fps);
    _cdEnsureFrames(state.newView, fps);
    _cdEnsureFrames(state.diff, fps);

    const diff = state.diff || [];
    const removed = state.removed || [];
    const visDiff = diff.filter(d => _cdTypeEnabled(String(d?.diffType || 'CHANGED').toUpperCase()));

    const totalNew = state.newView?.length || 0;
    const removedCount = removed.length || 0;
    const changedAll = diff.length;
    const changedVis = visDiff.length;
    const pctAll = totalNew ? ((changedAll / totalNew) * 100).toFixed(1) : '0.0';
    const pctVis = totalNew ? ((changedVis / totalNew) * 100).toFixed(1) : '0.0';

    const sumAll = (CutDiff?.summarizeDiff && CutDiff.summarizeDiff(diff)) || {};

    // Duration impact (same logic as KPI)
    let oldStart = Infinity, oldEnd = -Infinity;
    let newStart = Infinity, newEnd = -Infinity;
    for (const ev of (state.oldView || [])){
      const a = Number(ev?._recInF);
      const b = Number(ev?._recOutF);
      if (Number.isFinite(a) && a < oldStart) oldStart = a;
      if (Number.isFinite(b) && b > oldEnd) oldEnd = b;
    }
    for (const ev of (state.newView || [])){
      const a = Number(ev?._recInF);
      const b = Number(ev?._recOutF);
      if (Number.isFinite(a) && a < newStart) newStart = a;
      if (Number.isFinite(b) && b > newEnd) newEnd = b;
    }
    if (!Number.isFinite(oldStart)) oldStart = 0;
    if (!Number.isFinite(newStart)) newStart = 0;
    const oldLen = Math.max(0, (Number.isFinite(oldEnd) ? oldEnd : 0) - oldStart);
    const newLen = Math.max(0, (Number.isFinite(newEnd) ? newEnd : 0) - newStart);
    const netDelta = newLen - oldLen;
    const netSign = netDelta >= 0 ? '+' : '-';

    let impactedAll = 0;
    let impactedVis = 0;
    for (let i = 0; i < diff.length; i++){
      const d = diff[i] || {};
      const a = Number(d._recInF);
      const b = Number(d._recOutF);
      const w = (Number.isFinite(a) && Number.isFinite(b)) ? Math.max(1, b - a) : 0;
      impactedAll += w;
      const t = String(d.diffType || 'CHANGED').toUpperCase();
      if (_cdTypeEnabled(t)) impactedVis += w;
    }
    const tcImpVis = _cdFramesToTC(impactedVis, fps);
    const tcImpAll = _cdFramesToTC(impactedAll, fps);
    const tcNetAbs = _cdFramesToTC(Math.abs(netDelta), fps);

    // Storage estimate
    const estAll = estimateStorageForEvents ? estimateStorageForEvents(diff, fps) : { conformGB:0, vfxGB:0 };
    const estVis = estimateStorageForEvents ? estimateStorageForEvents(visDiff, fps) : estAll;
    const fmt = storageFmtGB || ((gb)=>String(gb));

    const oldAudioMetaPdf = state.oldRaw?.audioMeta || null;
    const newAudioMetaPdf = state.newRaw?.audioMeta || null;
    const audioCmpPdf = _cdGetAudioCompareData();
    const oldAudioTextPdf = _cdAudioSummaryText(oldAudioMetaPdf);
    const newAudioTextPdf = _cdAudioSummaryText(newAudioMetaPdf);
    const audioComparePdf = _cdAudioCompareLabel(oldAudioMetaPdf, newAudioMetaPdf);
    const audioChangePdf = _cdAudioChangeSummaryText(audioCmpPdf);
    const oldAudioTracksPdf = _cdAudioTrackStatsText(state.oldRaw?.audioEvents, fps, { maxTracks: 12 }) || 'n/a';
    const newAudioTracksPdf = _cdAudioTrackStatsText(state.newRaw?.audioEvents, fps, { maxTracks: 12 }) || 'n/a';
    const audioDiffTrackPdf = _cdAudioDiffTrackStatsText(audioCmpPdf, fps, { maxTracks: 12 }) || 'No per-track audio changes';

    const oMeta = state.oldRaw?.fileMeta || {};
    const nMeta = state.newRaw?.fileMeta || {};
    const baseName = (state.newRaw?.projectName || state.oldRaw?.projectName || 'CUT_DIFF');
    const reportTitle = `${baseName} — CUT DIFF Report`;

    const escH = (s) => {
      const v = (s == null) ? '' : String(s);
      return v
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;')
        .replace(/'/g,'&#39;');
    };

    // Optional thumbnails (best-effort): captures from loaded OLD/NEW compare videos.
    // Use record-time frames (Rec In) and show OLD vs NEW for quick A/B.
    // NOTE: We limit captures to avoid slow reports when the list is huge.
    async function _cdCaptureThumbs(list, which, getRecInF, maxCount=80){
      const out = new Map();
      const hardMax = Math.max(1, Number(maxCount || 80));
      const maxN = Math.max(0, Math.min(hardMax, Number(list?.length || 0)));
      if (!maxN) return out;

      let vid = (which === 'old') ? __vcUI?.vidOld : __vcUI?.vidNew;
      let startF = (which === 'old') ? (vcState?._oldStartF || 0) : (vcState?._newStartF || 0);

      // Fallback: if OLD video isn't loaded, try NEW video so the report still has images.
      // (Useful when teams only load a single reference movie.)
      if (which === 'old'){
        const bad = (!vid || !vid.src || vid.readyState < 2);
        const v2 = __vcUI?.vidNew;
        if (bad && v2 && v2.src && v2.readyState >= 2){
          vid = v2;
          startF = (vcState?._newStartF || 0);
        }
      }

      if (!vid || !vid.src) return out;
      if (vid.readyState < 2) return out;

      const W = 320;
      const H = 180;
      const cvs = document.createElement('canvas');
      cvs.width = W;
      cvs.height = H;
      const ctx = cvs.getContext('2d');
      if (!ctx) return out;

      const wasPaused = !!vid.paused;
      const oldTime = Number.isFinite(vid.currentTime) ? vid.currentTime : 0;
      try{ vid.pause(); }catch{}

      function seekTo(t){
        return new Promise(res => {
          let done = false;
          const finish = () => { if (done) return; done = true; res(); };
          const onSeeked = () => { try{ vid.removeEventListener('seeked', onSeeked); }catch{}; finish(); };
          try{ vid.addEventListener('seeked', onSeeked, { once:true }); }catch{ finish(); return; }
          try{ vid.currentTime = Math.max(0, t); }catch{ finish(); }
          // Failsafe: some browsers don't fire seeked reliably for tiny jumps.
          setTimeout(finish, 300);
        });
      }

      for (let i=0; i<maxN; i++){
        const ev = list[i];
        const inF = getRecInF ? Number(getRecInF(ev, i)) : Number(ev?._recInF);
        if (!Number.isFinite(inF)) continue;
        const sec = (inF - startF) / fps;
        if (!Number.isFinite(sec)) continue;
        await seekTo(sec);
        try{
          const vw = Math.max(1, vid.videoWidth || 1);
          const vh = Math.max(1, vid.videoHeight || 1);
          ctx.clearRect(0,0,W,H);
          const s = Math.min(W / vw, H / vh);
          const dw = Math.round(vw * s);
          const dh = Math.round(vh * s);
          const dx = Math.round((W - dw)/2);
          const dy = Math.round((H - dh)/2);
          ctx.drawImage(vid, dx, dy, dw, dh);
          const url = cvs.toDataURL('image/jpeg', 0.82);
          if (url && url.startsWith('data:image')) out.set(i, url);
        }catch{}
      }

      try{ await seekTo(oldTime); }catch{}
      try{ if (!wasPaused) vid.play(); }catch{}
      return out;
    }
    const rowHtml = (ev, tag, thumbOldUrl, thumbNewUrl) => {
      const t = String(tag || ev?.diffType || '').toUpperCase();
      const conf = (ev?.matchScore != null) ? `${Math.round(Number(ev.matchScore)*100)}%` : '';
      const dur = (ev?._lenFrames != null) ? `${ev._lenFrames}f` : '';

      // Thumbnail rules per request:
      // - REMOVED: show OLD only
      // - EXTENDED: show NEW only
      // - NEW: show NEW only
      // - CHANGED (and others): show OLD + NEW for A/B compare
      const showOld = (t === 'REMOVED') || (t === 'CHANGED');
      const showNew = (t === 'EXTENDED') || (t === 'NEW') || (t === 'CHANGED');

      const slots = [
        showOld ? `
              <div class="slot">
                <div class="lab">OLD</div>
                ${thumbOldUrl ? `<img src="${thumbOldUrl}"/>` : `<div class="ph">—</div>`}
              </div>` : '',
        showNew ? `
              <div class="slot">
                <div class="lab">NEW</div>
                ${thumbNewUrl ? `<img src="${thumbNewUrl}"/>` : `<div class="ph">—</div>`}
              </div>` : ''
      ].filter(Boolean).join('');

      return `
        <tr>
          <td class="thumb2">
            <div class="pair">${slots}
            </div>
          </td>
          <td>${escH(t)}</td>
          <td>${escH(ev?.reel || '')}</td>
          <td>${escH(ev?.clipName || '')}</td>
          <td class="tc">${escH(ev?.recIn || '')}</td>
          <td class="tc">${escH(ev?.recOut || '')}</td>
          <td class="tc">${escH(ev?.srcIn || '')}</td>
          <td class="tc">${escH(ev?.srcOut || '')}</td>
          <td>${escH(dur)}</td>
          <td>${escH(conf)}</td>
          <td>${escH(ev?.status || '')}</td>
          <td>${escH(ev?.note || '')}</td>
        </tr>
      `;
    };


    const audioRowHtml = (ev, tag) => {
      const t = String(tag || ev?.diffType || '').toUpperCase();
      const durFrames = (ev?._lenFrames != null) ? ev._lenFrames : Math.max(1, (Number(ev?._recOutF) || 0) - (Number(ev?._recInF) || 0));
      const oldTrack = ev?.matchOldTrackLabel || ((t === 'REMOVED') ? ev?.trackLabel : '');
      const oldClip = ev?.matchOldClipName || ((t === 'REMOVED') ? ev?.clipName : '');
      const srcFile = _cdBaseFileName(ev?.srcFile || ev?.sourceFile || ev?.clipName || '');
      const oldSrcFile = _cdBaseFileName(ev?.matchOldSrcFile || ((t === 'REMOVED') ? ev?.srcFile : '') || oldClip || '');
      const oldRecIn = ev?.matchOldRecIn || ((t === 'REMOVED') ? ev?.recIn : '');
      const oldRecOut = ev?.matchOldRecOut || ((t === 'REMOVED') ? ev?.recOut : '');
      return `
        <tr>
          <td>${escH(t)}</td>
          <td>${escH(ev?.trackLabel || '')}</td>
          <td>${escH(ev?.clipName || '')}</td>
          <td class="file">${escH(srcFile || '')}</td>
          <td class="tc">${escH(ev?.recIn || '')}</td>
          <td class="tc">${escH(ev?.recOut || '')}</td>
          <td>${escH(String(durFrames || ''))}f</td>
          <td>${escH(oldTrack || '')}</td>
          <td>${escH(oldClip || '')}</td>
          <td class="file">${escH(oldSrcFile || '')}</td>
          <td class="tc">${escH(oldRecIn || '')}</td>
          <td class="tc">${escH(oldRecOut || '')}</td>
        </tr>
      `;
    };

    // thumbnails: capture a small number for speed (best-effort)
    // Pull-needed rows: show OLD vs NEW for quick A/B compare.
    // Removed rows: show OLD (NEW is blank).
    let thumbsDiffNew = new Map();
    let thumbsDiffOld = new Map();
    let thumbsRemovedOld = new Map();
    try{
      // Ensure frames exist for all lists used by capture.
      try{ _cdEnsureFrames(removed, fps); }catch{}

      thumbsDiffNew = await _cdCaptureThumbs(visDiff, 'new', (ev)=>Number(ev?._recInF));
      thumbsDiffOld = await _cdCaptureThumbs(visDiff, 'old', (ev)=>{
        const f = _cdTcNum(ev?.matchOldRecIn, fps);
        return Number.isFinite(f) ? f : NaN;
      });
      thumbsRemovedOld = await _cdCaptureThumbs(removed, 'old', (ev)=>Number(ev?._recInF));
    }catch{}

    const diffRows = visDiff.map((ev, i) => rowHtml(ev, null, thumbsDiffOld.get(i), thumbsDiffNew.get(i))).join('') || '<tr><td colspan="12" class="muted">No pull-needed shots (for enabled types).</td></tr>';
    const removedRows = removed.map((ev, i) => rowHtml(ev, 'REMOVED', thumbsRemovedOld.get(i), null)).join('') || '<tr><td colspan="12" class="muted">No removed shots.</td></tr>';
    const audioDiffRows = (audioCmpPdf?.diff || []).map((ev) => audioRowHtml(ev, null)).join('');
    const audioRemovedRows = (audioCmpPdf?.removed || []).map((ev) => audioRowHtml(ev, 'REMOVED')).join('');
    const audioRows = (audioDiffRows + audioRemovedRows) || '<tr><td colspan="12" class="muted">No timeline audio changes detected.</td></tr>';

    const stamp = _cdNowISO().replace('T',' ').replace('Z',' UTC');

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escH(reportTitle)}</title>
  <style>
    :root { color-scheme: light; }
    body{ font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 24px; }
    h1{ font-size: 18px; margin: 0 0 6px; }
    .meta{ font-size: 12px; color:#444; margin-bottom: 14px; }
    .grid{ display:grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin: 12px 0 18px; }
    .box{ border: 1px solid #ddd; border-radius: 10px; padding: 10px; }
    .k{ font-size: 11px; color:#666; }
    .v{ font-size: 16px; font-weight: 700; margin-top: 4px; }
    .sub{ font-size: 11px; color:#666; margin-top: 4px; }
    .chips{ margin-top: 6px; display:flex; gap:6px; flex-wrap:wrap; }
    .chip{ border:1px solid #ddd; border-radius: 999px; padding: 2px 8px; font-size: 11px; }
    table{ width:100%; border-collapse: collapse; font-size: 11px; }
    th, td{ border-bottom: 1px solid #eee; padding: 6px 6px; vertical-align: top; }
    th{ text-align:left; background: #fafafa; position: sticky; top: 0; }
    .tc{ font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.thumb2{ width: 144px; }
    td.thumb2 .pair{ display:flex; flex-direction:column; gap:6px; }
    td.thumb2 .slot{ position:relative; }
    td.thumb2 .lab{ position:absolute; left:6px; top:6px; font-size:10px; font-weight:700; color:#fff; text-shadow: 0 1px 2px rgba(0,0,0,.65); }
    td.thumb2 img{ width:128px; height:72px; object-fit: contain; border-radius: 8px; background:#111; border:1px solid #e6e6e6; display:block; }
    td.thumb2 .ph{ width:128px; height:72px; border-radius: 8px; background:#f2f2f2; border:1px dashed #ddd; display:flex; align-items:center; justify-content:center; color:#888; font-size:12px; }
    .section{ margin-top: 18px; }
    .section h2{ font-size: 13px; margin: 0 0 8px; }
    .file{ word-break: break-word; }
    .muted{ color:#666; }
    @media print{
      body{ margin: 12mm; }
      th{ position: static; }
      .no-print{ display:none; }
    }
  </style>
</head>
<body>
  <div class="no-print" style="font-size:12px;color:#666;margin-bottom:10px;">Tip: in the print dialog, choose “Save as PDF”.</div>

  <h1>${escH(reportTitle)}</h1>
  <div class="meta">
    Generated: ${escH(stamp)} &nbsp;•&nbsp; FPS: ${escH(String(fps))}
    <br/>
    OLD: ${escH(oMeta?.name || state.oldRaw?.projectName || '')} ${oMeta?.sha256 ? `&nbsp;•&nbsp; SHA256: ${escH(oMeta.sha256)}` : ''}
    <br/>
    NEW: ${escH(nMeta?.name || state.newRaw?.projectName || '')} ${nMeta?.sha256 ? `&nbsp;•&nbsp; SHA256: ${escH(nMeta.sha256)}` : ''}
  </div>

  <div class="grid">
    <div class="box"><div class="k">Shots (NEW / Removed)</div><div class="v">${escH(String(totalNew))} / ${escH(String(removedCount))}</div><div class="sub">New cut / From OLD</div></div>
    <div class="box">
      <div class="k">Pull-needed</div><div class="v">${escH(String(changedVis))}</div>
      <div class="chips">
        <span class="chip">NEW ${escH(String(sumAll.NEW || 0))}</span>
        <span class="chip">EXT ${escH(String(sumAll.EXTENDED || 0))}</span>
        <span class="chip">CHG ${escH(String(sumAll.CHANGED || 0))}</span>
      </div>
    </div>
    <div class="box"><div class="k">% Changed</div><div class="v">${escH(String(pctVis))}%</div><div class="sub">All: ${escH(String(pctAll))}%</div></div>
    <div class="box"><div class="k">Duration Impact</div><div class="v">${escH(tcImpVis)}</div><div class="sub">All: ${escH(tcImpAll)} • Net Δ: ${escH(netSign + tcNetAbs)}</div></div>
    <div class="box"><div class="k">Storage (Est.)</div><div class="v">OCF ${escH(fmt(estVis.conformGB))}</div><div class="sub">EXR ${escH(fmt(estVis.vfxGB))} • (All OCF ${escH(fmt(estAll.conformGB))} / EXR ${escH(fmt(estAll.vfxGB))})</div></div>
    <div class="box"><div class="k">Counts</div><div class="v">Diff ${escH(String(changedAll))}</div><div class="sub">Visible ${escH(String(changedVis))} • Removed ${escH(String(removedCount))}</div></div>
  </div>

  <div class="section">
    <h2>Audio Overview</h2>
    <div class="grid" style="grid-template-columns: repeat(3, minmax(0, 1fr));">
      <div class="box"><div class="k">OLD Audio</div><div class="v">${escH(oldAudioTextPdf)}</div><div class="sub">${escH(oldAudioTracksPdf)}</div></div>
      <div class="box"><div class="k">NEW Audio</div><div class="v">${escH(newAudioTextPdf)}</div><div class="sub">${escH(newAudioTracksPdf)}</div></div>
      <div class="box"><div class="k">Audio Diff</div><div class="v">${escH(audioChangePdf.replace('Audio diff: ', ''))}</div><div class="sub">${escH(audioComparePdf)} • ${escH(audioDiffTrackPdf)}</div></div>
    </div>
  </div>

  <div class="section">
    <h2>Handoff Checklist (Conform / Color / Sound)</h2>
    <div class="muted" style="font-size:11px;line-height:1.45">
      <b>Conform</b>: verify NEW/EXT/CHG segments in the NEW cut, especially around scene boundaries and speed/transform flags. Use Rec In/Out as the primary reference.
      <br/>
      <b>Color / Grade</b>: review pull-needed segments with thumbnails. Watch for shot swaps, optical changes, and any transform-only updates.
      <br/>
      <b>Sound</b>: focus on duration impact (${escH(tcImpVis)} affected; net Δ ${escH(netSign + tcNetAbs)}). Check music cues and transitions near changed/removed segments. Audio summary: ${escH(audioChangePdf)}.
    </div>
  </div>

  <div class="section">
    <h2>Pull-needed Shots (Enabled types only)</h2>
    <table>
      <thead>
        <tr>
          <th>Frame</th><th>Type</th><th>Reel</th><th>Clip Name</th>
          <th>Rec In</th><th>Rec Out</th>
          <th>Src In</th><th>Src Out</th>
          <th>Dur</th><th>Conf</th><th>Status</th><th>Note</th>
        </tr>
      </thead>
      <tbody>${diffRows}</tbody>
    </table>
  </div>

  <div class="section">
    <h2>Removed Shots (From OLD cut)</h2>
    <table>
      <thead>
        <tr>
          <th>Frame</th><th>Type</th><th>Reel</th><th>Clip Name</th>
          <th>Rec In</th><th>Rec Out</th>
          <th>Src In</th><th>Src Out</th>
          <th>Dur</th><th>Conf</th><th>Status</th><th>Note</th>
        </tr>
      </thead>
      <tbody>${removedRows}</tbody>
    </table>
  </div>

  <div class="section">
    <h2>Audio Changes</h2>
    <table>
      <thead>
        <tr>
          <th>Type</th><th>Track</th><th>Clip Name</th><th>Original File</th><th>Rec In</th><th>Rec Out</th><th>Dur</th><th>OLD Track</th><th>OLD Clip</th><th>OLD Original File</th><th>OLD Rec In</th><th>OLD Rec Out</th>
        </tr>
      </thead>
      <tbody>${audioRows}</tbody>
    </table>
  </div>
</body>
</html>`;

    try{
      const w = window.open('', '_blank');
      if (!w){
        showError?.('Popup blocked. Please allow popups for this extension page, then try again.');
        return;
      }
      w.document.open();
      w.document.write(html);
      w.document.close();
      w.focus();
      // give browser a moment to layout
      setTimeout(() => { try{ w.print(); }catch{} }, 350);
    }catch(err){
      showError?.(err?.message || String(err));
    }
  }

  function clear(){
    // Stop any running RAF loops before clearing state
    _cdRevActive = false;
    if (_cdRevRafId) { cancelAnimationFrame(_cdRevRafId); _cdRevRafId = null; }
    try{ _vcStopRaf(); }catch{}

    state.oldRaw = null;
    state.newRaw = null;
    state.oldView = [];
    state.newView = [];
    state.diff = [];
    state.removed = [];
    state.analyzed = false;
    audioCompareState.key = '';
    audioCompareState.payload = null;

    const oldStatus = document.getElementById("cutdiffOldStatus");
    const newStatus = document.getElementById("cutdiffNewStatus");
    if (oldStatus) oldStatus.textContent = "No cut loaded.";
    if (newStatus) newStatus.textContent = "No cut loaded.";

    // Keep Summary/KPIs visible at all times.
    try{ _cdRenderSummary(); }catch{}

    const tbody = document.querySelector("#cutdiffTable tbody");
    if (tbody) tbody.innerHTML = "";

    // reset sorting UI
    sortState.key = null;
    sortState.dir = 1;
    renderHeaderSort();

    const oldInput = document.getElementById("cutdiffOldFile");
    const newInput = document.getElementById("cutdiffNewFile");
    if (oldInput) oldInput.value = "";
    if (newInput) newInput.value = "";

    // reset selection
    selState.srcIdx = null;
    selState.rowPos = 0;

    updateHeartbeat();

    // clear Smart Timeline Compare
    tlState.segByKey.clear();
    tlState.rowByKey.clear();
    _cdDestroyOrigTimeline('new');
    _cdDestroyOrigTimeline('old');
    _cdRenderTimelineActive(true);

    _cdRenderCompareLock();

    _cdMarkDirty("clear");
  }

  function destroy() {
    _cdRevActive = false;
    if (_cdRevRafId) { cancelAnimationFrame(_cdRevRafId); _cdRevRafId = null; }
    try{ _vcStopRaf(); }catch{}
    try{ if (_cdExportMenuCleanup) { _cdExportMenuCleanup(); _cdExportMenuCleanup = null; } }catch{}
  }

  return {
    mount,
    updateHeartbeat,
    clear,
    destroy,
    getState: () => ({ ...state })
  };
}
