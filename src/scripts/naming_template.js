// naming_template.js — Standalone Naming Template Modal (PostFlowX 6+)
// Extracted from shot_marker.js. Provides window.__smOpenNamingTemplateById
// and window.__smGetMarkersRef so the Pull Prep 2.0 Template button works
// without the full shot_marker.js loaded.

(function(){
'use strict';

// ── Internal marker pool ──────────────────────────────────────────────────────
const _ntMarkers = [];
try{ window.__smGetMarkersRef = () => _ntMarkers; }catch{}

// ── Per-marker OCR registry (maps markerId → marker object for OCR chip reads) ─
const _ntCurrentMarkers = new Map();
try{ window.__ntRegisterMarker   = (id, mk) => _ntCurrentMarkers.set(String(id), mk); }catch{}
try{ window.__ntUnregisterMarker = (id)     => _ntCurrentMarkers.delete(String(id));  }catch{}

// ── markerInfoBarSettings ─────────────────────────────────────────────────────
const _MIBAR_LS_KEY = 'pfx_mibar_settings_v1';
const _MIBAR_DEFAULT_ORDER = ['show','ep','seq','scene','shot','plate','ocr','vendor','ver'];
const _MIBAR_DEFAULT_VISIBLE = { show:true, ep:true, seq:true, scene:true, shot:true, plate:true, ocr:true, vendor:true, ver:true };
const _MIBAR_REMOVED_KEYS = new Set(['task']);
function _ntReadMibarSettings(){
  try{
    const raw = localStorage.getItem(_MIBAR_LS_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    // Always repair: merge saved into defaults so new keys always have a value
    const savedVisible = (saved.visible && typeof saved.visible === 'object') ? saved.visible : {};
    const savedOrder   = Array.isArray(saved.order) && saved.order.length ? saved.order : null;
    const visible = { ..._MIBAR_DEFAULT_VISIBLE, ...savedVisible };
    for (const k of _MIBAR_REMOVED_KEYS) delete visible[k];
    return {
      order:       (savedOrder || [..._MIBAR_DEFAULT_ORDER]).filter(k => !_MIBAR_REMOVED_KEYS.has(k)),
      visible,
      displayMode: saved.displayMode || 'auto',
    };
  }catch{ return { order: [..._MIBAR_DEFAULT_ORDER], visible: { ..._MIBAR_DEFAULT_VISIBLE }, displayMode: 'auto' }; }
}
function _ntWriteMibarSettings(s){
  try{ localStorage.setItem(_MIBAR_LS_KEY, JSON.stringify(s)); }catch{}
}
function _ntGetSortedTokens(){
  const { order } = _ntReadMibarSettings();
  return [..._NT_TOKENS].sort((a, b) => {
    const ai = order.indexOf(a.key), bi = order.indexOf(b.key);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
}

// ── Utilities ─────────────────────────────────────────────────────────────────
function _ntPad(n, w){ return String(Math.floor(Math.abs(Number(n)||0))).padStart(w, '0'); }
function escapeHTML(s){ return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;"); }

// Canonical shot name builder — scene is included whenever fields.scene is non-empty.
// PLATE is excluded (plate is a separate naming concern).
function buildAssociatedShotName(fields) {
  const { show = '', ep = '', scene = '', shot = '' } = fields;
  const parts = [];
  if (show)  parts.push(String(show).toUpperCase().replace(/[^A-Za-z0-9]/g, ''));
  if (ep)    parts.push(String(ep).padStart(3, '0'));
  if (scene) parts.push(String(scene).padStart(3, '0'));
  if (shot)  parts.push(String(shot).padStart(4, '0'));
  return parts.join('_');
}

// ── localStorage keys ─────────────────────────────────────────────────────────
const _NT = {
  show:     'pfx_sm_show_val',
  sq:       'pfx_sm_sq_val',
  seq:      'pfx_sm_seq_val',
  scene:    'pfx_sm_scene_val',
  start:    'pfx_sm_start_val',
  step:     'pfx_sm_step_val',
  pad:      'pfx_sm_pad_val',
  task:     'pfx_sm_task_val',
  vendor:   'pfx_sm_vendor_val',
  ver:      'pfx_sm_ver_val',
  showOn:   'pfx_sm_show_on',
  epOn:     'pfx_sm_ep_on',
  seqOn:    'pfx_sm_seq_on',
  sceneOn:  'pfx_sm_scene_on',
  startOn:  'pfx_sm_start_on',
  stepOn:   'pfx_sm_step_on',
  padOn:    'pfx_sm_pad_on',
  taskOn:   'pfx_sm_task_on',
  vendorOn: 'pfx_sm_vendor_on',
  verOn:    'pfx_sm_ver_on',
  plateCode: 'pfx_sm_plate_code_val',
  plateNum:  'pfx_sm_plate_num_val',
  plateOn:   'pfx_sm_plate_on',
};

// ── Name token helpers ────────────────────────────────────────────────────────
function __smSanitizeNameToken(s){
  return String(s || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}
function __smParsePlateName(name){
  const s = String(name || '').trim();
  if (!s) return null;
  const m = s.match(/^(.*?)(?:_BG_?(\d{2})|_CP(\d{2})|_([A-Za-z]+?)(\d{2}))(?:_([A-Za-z0-9-]+))?(?:_([A-Za-z0-9-]+))?(?:_(v\d{3,4}))?$/i);
  if (!m) return null;
  const code = m[2] ? 'BG' : m[3] ? 'CP' : (m[4] || 'PL');
  const num  = m[2] || m[3] || m[5] || '01';
  const tokenA = String(m[6] || '').trim();
  const tokenB = String(m[7] || '').trim();
  const ver = String(m[8] || '').trim();
  return {
    base: String(m[1] || '').trim(),
    code,
    num,
    task: tokenA,
    vendor: tokenB || '',
    ver,
  };
}

function __smStripPlateSuffix(s){
  const parsed = __smParsePlateName(s);
  return String(parsed?.base || s || '').trim();
}
function __smLooksLikePlateName(s){
  return !!__smParsePlateName(s);
}

function __smBuildPlateStyleName(base, code, num, taskOrVer='', vendor='', ver=''){
  const cleanBase = __smSanitizeNameToken(__smStripPlateSuffix(base || '')) || 'SHOT';
  const cleanCode = String(code || 'PL').trim();
  const cleanNumRaw = String(num || '01').trim() || '01';
  const cleanNum = /^\d+$/.test(cleanNumRaw) ? cleanNumRaw.padStart(2, '0') : cleanNumRaw;
  const legacyVerOnly = !vendor && !ver && /^v\d{3,4}$/i.test(String(taskOrVer || '').trim());
  const cleanTask = legacyVerOnly ? '' : __smSanitizeNameToken(String(taskOrVer || '').trim());
  const cleanVendor = __smSanitizeNameToken(String(vendor || '').trim());
  const cleanVer = String((legacyVerOnly ? taskOrVer : ver) ?? '').trim();
  const codeUC = cleanCode.toUpperCase();
  const baseName = codeUC === 'CP'
    ? __smSanitizeNameToken(`${cleanBase}_CP${cleanNum}`)
    : codeUC === 'BG'
      ? __smSanitizeNameToken(`${cleanBase}_BG${cleanNum}`)
      : __smSanitizeNameToken(`${cleanBase}_${cleanCode}${cleanNum}`);
  const parts = [baseName];
  if (cleanTask) parts.push(cleanTask);
  if (cleanVendor) parts.push(cleanVendor);
  if (cleanVer) parts.push(cleanVer);
  return __smSanitizeNameToken(parts.join('_'));
}

function __smTrackPlateDefaults(trackIndex, layerOrderIndex=null, totalLayers=null){
  const total = Number.isFinite(Number(totalLayers)) ? Number(totalLayers) : null;
  const order = Number.isFinite(Number(layerOrderIndex)) ? Number(layerOrderIndex) : null;
  if (total === 1) return { plateCode:'PL', plateNum:'01' };
  const t = Number(trackIndex);
  if (Number.isFinite(t)){
    const ti = Math.max(0, Math.round(t));
    if (ti <= 0) return { plateCode:'BG', plateNum:'01' };
    return { plateCode:'PL', plateNum:String(ti).padStart(2,'0') };
  }
  if (order != null && order >= 0){
    if (order === 0) return { plateCode:'BG', plateNum:'01' };
    return { plateCode:'PL', plateNum:String(order).padStart(2,'0') };
  }
  return { plateCode:'PL', plateNum:'01' };
}

function __smBuildTrackLayerShotName(base, trackIndex, ver='', layerOrderIndex=null, totalLayers=null){
  const defs = __smTrackPlateDefaults(trackIndex, layerOrderIndex, totalLayers);
  return __smBuildPlateStyleName(base, defs.plateCode, defs.plateNum, String(ver || '').trim());
}

function __smResolveNextCpNum(base, excludeId=''){
  const cleanBase = __smSanitizeNameToken(__smStripPlateSuffix(base || ''));
  if (!cleanBase) return '01';
  let maxNum = 0;
  try{
    const list = window.__smGetMarkersRef?.() || [];
    for (const mk of list){
      if (!mk) continue;
      if (excludeId && String(mk.id || '') === String(excludeId)) continue;
      const shot = String(mk.shotName || '').trim();
      if (!shot) continue;
      const mm = shot.match(/^(.*)_CP(\d{2})(?:_(v\d{3,4}))?$/i);
      if (!mm) continue;
      const mkBase = __smSanitizeNameToken(__smStripPlateSuffix(mm[1] || ''));
      if (mkBase !== cleanBase) continue;
      const n = parseInt(mm[2], 10);
      if (Number.isFinite(n)) maxNum = Math.max(maxNum, n);
    }
  }catch{}
  return String(Math.max(1, maxNum + 1)).padStart(2, '0');
}

// ── Settings ──────────────────────────────────────────────────────────────────
function __smReadNamingTemplateSettings(){
  const show     = String(localStorage.getItem(_NT.show)   || "LMP").trim() || "SHOW";
  const sq       = String(localStorage.getItem(_NT.sq)     || "101").trim() || "101";
  const seq      = String(localStorage.getItem(_NT.seq)    || "").trim();
  const scene    = String(localStorage.getItem(_NT.scene)  || "").trim();
  const task     = String(localStorage.getItem(_NT.task)   || "").trim();
  const vendor   = String(localStorage.getItem(_NT.vendor) || "").trim();
  const ver      = String(localStorage.getItem(_NT.ver)    || "").trim();
  const startNum = parseInt(localStorage.getItem(_NT.start) || "10", 10);
  const stepNum  = parseInt(localStorage.getItem(_NT.step)  || "10", 10);
  const padNum   = parseInt(localStorage.getItem(_NT.pad)   || "3",  10);
  const counterNum = Number(window.__smShotCounter);
  return {
    show, sq, seq, scene, task, vendor, ver,
    start:   Number.isFinite(startNum) ? startNum : 10,
    step:    Number.isFinite(stepNum)  ? stepNum  : 10,
    pad:     Math.max(2, Math.min(6, Number.isFinite(padNum) ? padNum : 3)),
    counter: Number.isFinite(counterNum) ? counterNum : null
  };
}

function __smWriteNamingTemplateSettings(cfg, opts={}){
  const prev = __smReadNamingTemplateSettings();
  const nextShow   = String(cfg?.show   != null ? cfg.show   : prev.show  ).trim() || "SHOW";
  const nextSq     = String(cfg?.sq     != null ? cfg.sq     : prev.sq    ).trim() || "101";
  const nextSeq    = String(cfg?.seq    != null ? cfg.seq    : prev.seq   ).trim();
  const nextScene  = String(cfg?.scene  != null ? cfg.scene  : prev.scene ).trim();
  const nextTask   = String(cfg?.task   != null ? cfg.task   : prev.task  ).trim();
  const nextVendor = String(cfg?.vendor != null ? cfg.vendor : prev.vendor).trim();
  const nextVer    = String(cfg?.ver    != null ? cfg.ver    : prev.ver   ).trim();
  const startNum   = parseInt(cfg?.start != null ? cfg.start : prev.start, 10);
  const stepNum    = parseInt(cfg?.step  != null ? cfg.step  : prev.step,  10);
  const padNum     = parseInt(cfg?.pad   != null ? cfg.pad   : prev.pad,   10);
  const nextStart  = Number.isFinite(startNum) ? startNum : 10;
  const nextStep   = Number.isFinite(stepNum)  ? stepNum  : 10;
  const nextPad    = Math.max(2, Math.min(6, Number.isFinite(padNum) ? padNum : 3));

  localStorage.setItem(_NT.show,   nextShow);
  localStorage.setItem(_NT.sq,     nextSq);
  localStorage.setItem(_NT.seq,    nextSeq);
  localStorage.setItem(_NT.scene,  nextScene);
  localStorage.setItem(_NT.task,   nextTask);
  localStorage.setItem(_NT.vendor, nextVendor);
  localStorage.setItem(_NT.ver,    nextVer);
  localStorage.setItem(_NT.start,  String(nextStart));
  localStorage.setItem(_NT.step,   String(nextStep));
  localStorage.setItem(_NT.pad,    String(nextPad));

  const currentCounter = Number(window.__smShotCounter);
  const shouldResetCounter = !!opts.forceResetCounter || !Number.isFinite(currentCounter) || nextStart !== prev.start;
  if (shouldResetCounter) window.__smShotCounter = nextStart;
  return { show:nextShow, sq:nextSq, seq:nextSeq, scene:nextScene, task:nextTask, vendor:nextVendor, ver:nextVer,
           start:nextStart, step:nextStep, pad:nextPad, counter:Number(window.__smShotCounter)||nextStart };
}

// ── Shot name token array (showID + ep + seq + scene + shotID#) ──────────────
function _ntBuildParts(cfg, shotNumStr){
  const showOn  = localStorage.getItem(_NT.showOn)  !== '0';
  const epOn    = localStorage.getItem(_NT.epOn)    !== '0';
  const seqOn   = localStorage.getItem(_NT.seqOn)   === '1';
  const sceneOn = localStorage.getItem(_NT.sceneOn) === '1';
  const plateOn = localStorage.getItem(_NT.plateOn) === '1';

  const parts = [];
  if (showOn)  { const v = String(cfg.show||'SHOW').trim(); if(v) parts.push(v); }
  if (epOn)    { parts.push(_ntPad(parseInt(cfg.sq||'101',10)||0, 3)); }
  if (seqOn)   { const v = String(cfg.seq||'').trim(); if(v) parts.push(/^\d+$/.test(v) ? _ntPad(parseInt(v,10), 3) : __smSanitizeNameToken(v)); }
  if (sceneOn) { const v = String(cfg.scene||'').trim(); if(v) parts.push(_ntPad(parseInt(v,10)||0, 3)); }
  parts.push(shotNumStr);
  if (plateOn) {
    const code = String(localStorage.getItem(_NT.plateCode)||'').trim();
    const num  = String(localStorage.getItem(_NT.plateNum)||'01').trim();
    if (code) parts.push(__smSanitizeNameToken(code) + String(num||'01').padStart(2,'0'));
  }
  return parts;
}

// ── Version name token array (shot parts + task + vendorID + ver#) ────────────
function _ntBuildVersionParts(cfg, shotNumStr){
  const taskOn  = localStorage.getItem(_NT.taskOn)  === '1';
  const vendorOn= localStorage.getItem(_NT.vendorOn)=== '1';
  const verOn   = localStorage.getItem(_NT.verOn)   === '1';
  const parts = _ntBuildParts(cfg, shotNumStr).slice();
  if (taskOn)  { const v = String(cfg.task  ||'').trim(); if(v) parts.push(__smSanitizeNameToken(v)); }
  if (vendorOn){ const v = String(cfg.vendor||'').trim(); if(v) parts.push(__smSanitizeNameToken(v)); }
  if (verOn)   { const v = String(cfg.ver   ||'').trim(); if(v) parts.push(__smSanitizeNameToken(v)); }
  return parts;
}

// ── Peek next shot name without advancing counter ─────────────────────────────
function __smPeekNextShotName(){
  const cfg   = __smReadNamingTemplateSettings();
  const padOn = localStorage.getItem(_NT.padOn) !== '0';
  const padW  = padOn ? cfg.pad : 1;
  const next  = window.__smShotCounter || cfg.start;
  return _ntBuildParts(cfg, _ntPad(next, padW)).join('_');
}

// ── Build and advance shot counter ────────────────────────────────────────────
function buildShotName(){
  const cfg    = __smReadNamingTemplateSettings();
  const padOn  = localStorage.getItem(_NT.padOn)  !== '0';
  const stepOn = localStorage.getItem(_NT.stepOn) !== '0';
  const padW   = padOn  ? cfg.pad  : 1;
  const step   = stepOn ? cfg.step : 1;
  const startVal = cfg.start;
  const shotNum  = window.__smShotCounter || startVal;
  window.__smShotCounter = shotNum + step;
  return _ntBuildParts(cfg, _ntPad(shotNum, padW)).join('_');
}

function __smPreviewShotNameFromSettings(liveCfg, baseCfg){
  const cfg  = { ...(baseCfg || __smReadNamingTemplateSettings()), ...(liveCfg || {}) };
  const padOn = localStorage.getItem(_NT.padOn) !== '0';
  const padW  = padOn ? Math.max(2, Math.min(6, parseInt(cfg.pad, 10)||3)) : 1;
  const startNum = parseInt(cfg.start, 10);
  const start = Number.isFinite(startNum) ? startNum : 10;
  const currentCounter = Number(window.__smShotCounter);
  const base = __smReadNamingTemplateSettings();
  const nextCounter = (start !== base.start || !Number.isFinite(currentCounter)) ? start : currentCounter;
  return _ntBuildParts(cfg, _ntPad(nextCounter, padW)).join('_');
}

// ── Defaults from a marker ────────────────────────────────────────────────────
function __smGetNamingDefaultsForMarker(m){
  const shotStr = String(m?.shotName || '').trim();
  let plateCode = '';
  let plateNum  = '';
  let taskToken = '';
  let vendorToken = '';
  let verToken  = 'v001';
  const parsed = __smParsePlateName(shotStr);
  if (parsed){
    plateCode = parsed.code || 'PL';
    plateNum = parsed.num || '01';
    taskToken = parsed.task || '';
    vendorToken = parsed.vendor || '';
    if (parsed.ver) verToken = parsed.ver;
  }
  let base = String(m?.shotName || m?.clipName || '').trim();
  base = __smStripPlateSuffix(base);
  base = __smSanitizeNameToken(base);
  if (!base) base = __smPeekNextShotName() || 'SHOT';
  if (!plateCode || !plateNum || String(plateCode).toUpperCase() === 'CP'){
    const td = __smTrackPlateDefaults(m?.clip?.track ?? m?.clip?.trackIndex ?? null);
    if (!plateCode || String(plateCode).toUpperCase() !== 'CP'){ plateCode=td.plateCode; plateNum=td.plateNum; }
  }
  if (String(plateCode).toUpperCase() === 'CP' && !(parsed && String(parsed.code).toUpperCase() === 'CP')){
    plateNum = __smResolveNextCpNum(base, m?.id || '');
  }
  return { base, plateCode, plateNum, taskToken, vendorToken, verToken,
           plateCodeLC:String(plateCode).toLowerCase(), verTokenLC:String(verToken).toLowerCase() };
}

// ── SVG icons ─────────────────────────────────────────────────────────────────
const __SM_TEMPLATE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v4H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M4 11h7v8H4z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13 11h7v3h-7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13 16h7v3h-7z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`;

// ── Modal state ───────────────────────────────────────────────────────────────
let __smNamingTemplateModal = null;
let __smNamingTemplateEsc   = null;

function closeNamingTemplatePopup(){
  try{ if (__smNamingTemplateEsc) window.removeEventListener('keydown', __smNamingTemplateEsc, true); }catch{}
  __smNamingTemplateEsc = null;
  try{ __smNamingTemplateModal?.remove?.(); }catch{}
  __smNamingTemplateModal = null;
}

// ── Helper: render a format-bar token pill ────────────────────────────────────
function _ntFmtPill(text, cls='', shot=false, ver=false){
  const extra = shot ? ' sm-name-fmt-shot' : ver ? ' sm-name-fmt-ver' : '';
  return `<span class="sm-name-fmt-token${extra}${cls?' '+cls:''}">${escapeHTML(text)}</span>`;
}
function _ntFmtSep(){ return '<span class="sm-name-fmt-sep">_</span>'; }

// ── Main popup ────────────────────────────────────────────────────────────────
function openNamingTemplatePopup(id){
  const __smFindMarkerLive = (markerId) => {
    try{ const hit = window.__smFindMarkerById?.(markerId); if(hit) return hit; }catch{}
    try{ const all = window.__smGetMarkersRef?.(); if(Array.isArray(all)) return all.find(x=>x?.id===markerId)||null; }catch{}
    return null;
  };
  const __smSetActiveLive  = (...a) => { try{ window.__smSetActiveFromPopup?.(...a); }catch{} };
  const __smPushUndoLive   = (...a) => { try{ window.__smPushMarkerUndo?.(...a); }catch{} };
  const __smMarkDirtyLive  = ()     => { try{ window.__smMarkDirtyFromPopup?.(); }catch{} try{ window.MPS_markProjectDirty?.(); }catch{} };
  const __smSnapshotLive   = ()     => { try{ return window.__smGetProjectSnapshot?.(); }catch{} return null; };
  const __smRenderLive     = ()     => { try{ window.__smRenderFromPopup?.(); }catch{} };

  const m = __smFindMarkerLive(id);
  if (!m) return;
  closeNamingTemplatePopup();

  const defs         = __smGetNamingDefaultsForMarker(m);
  const shotCfgAtOpen = __smReadNamingTemplateSettings();

  // ── helpers for initial field disabled/off state ──────────────────────────
  const _ison  = (key, defaultOn=true) => defaultOn ? localStorage.getItem(key) !== '0' : localStorage.getItem(key) === '1';
  const _offCls = (key, defaultOn=true) => _ison(key, defaultOn) ? '' : 'sm-name-field-off';
  const _chkd   = (key, defaultOn=true) => _ison(key, defaultOn) ? 'checked' : '';
  const _dis    = (key, defaultOn=true) => _ison(key, defaultOn) ? '' : 'disabled';

  const backdrop = document.createElement('div');
  backdrop.className = 'sm-name-modal-backdrop';
  backdrop.innerHTML = `
    <div class="sm-name-modal sm-name-modal-pro sm-name-modal-pro2 sm-name-modal-v3" role="dialog" aria-modal="true" aria-label="Naming Template">

      <!-- HEADER: icon · title · current marker pill · close -->
      <div class="sm-name-modal-head">
        <div class="sm-name-modal-titlewrap">
          <span class="sm-name-modal-ico">${__SM_TEMPLATE_SVG}</span>
          <div class="sm-name-modal-title">Naming Template</div>
        </div>
        <div class="sm-name-v3-hd-ctx">
          <span class="sm-name-v3-hd-lbl">Marker</span>
          <span class="sm-name-v3-hd-val">${escapeHTML(String(m.shotName || defs.base || '—'))}</span>
        </div>
        <button type="button" class="btn mini sm-name-modal-close" title="Close">✕</button>
      </div>

      <!-- BODY -->
      <div class="sm-name-modal-body">

        <!-- PREVIEW: the output name is the hero -->
        <div class="sm-name-previewbox sm-name-previewbox-side sm-name-v3-preview">
          <div class="sm-name-v3-preview-top">
            <div class="sm-name-v3-preview-label">Shot Name <span class="sm-name-v3-preview-sub">→ written to SHOT column on Apply</span></div>
            <div class="sm-name-previewtag" data-role="previewTag">SHOT</div>
          </div>
          <div class="v mono sm-name-preview sm-name-v3-preview-value"></div>
          <div class="sm-name-v3-compare">
            <span class="sm-name-v3-compare-item">
              <span class="k">Now</span>
              <span class="v mono">${escapeHTML(String(m.shotName || defs.base || '—'))}</span>
            </span>
            <span class="sm-name-v3-arrow">→</span>
            <span class="sm-name-v3-compare-item sm-name-v3-after">
              <span class="k">After Apply</span>
              <span class="v mono" data-role="previewEcho">—</span>
            </span>
          </div>
        </div>

        <!-- FIELDS: single card, two sections -->
        <div class="sm-name-shotsettings sm-name-v3-fields" data-role="shotSettingsBox">

          <!-- Section A: Prefix + Counter (the critical fields) -->
          <div class="sm-name-v3-section">
            <div class="sm-name-v3-section-head">
              <span class="sm-name-v3-section-title">Shot Name Parts</span>
              <span class="sm-name-v3-section-hint">showID · episode · seq · scene · shot#</span>
            </div>
            <div class="sm-name-v3-fields-grid">
              <label class="sm-name-field ${_offCls(_NT.showOn)}">
                <div class="sm-name-field-hdr"><span class="sm-name-field-lbl">Show ID</span><input type="checkbox" class="sm-name-chk sm-name-show-chk" ${_chkd(_NT.showOn)}></div>
                <input type="text" class="sm-name-show" value="${escapeHTML(shotCfgAtOpen.show)}" placeholder="AGM" ${_dis(_NT.showOn)}>
              </label>
              <label class="sm-name-field ${_offCls(_NT.epOn)}">
                <div class="sm-name-field-hdr"><span class="sm-name-field-lbl">Episode</span><input type="checkbox" class="sm-name-chk sm-name-ep-chk" ${_chkd(_NT.epOn)}></div>
                <input type="text" class="sm-name-sq" value="${escapeHTML(shotCfgAtOpen.sq)}" placeholder="101" ${_dis(_NT.epOn)}>
              </label>
              <label class="sm-name-field ${_offCls(_NT.seqOn, false)}">
                <div class="sm-name-field-hdr"><span class="sm-name-field-lbl">Seq</span><input type="checkbox" class="sm-name-chk sm-name-seq-chk" ${_chkd(_NT.seqOn, false)}></div>
                <input type="text" class="sm-name-seq" value="${escapeHTML(shotCfgAtOpen.seq)}" placeholder="TCC" ${_dis(_NT.seqOn, false)}>
              </label>
              <label class="sm-name-field ${_offCls(_NT.sceneOn, false)}">
                <div class="sm-name-field-hdr"><span class="sm-name-field-lbl">Scene</span><input type="checkbox" class="sm-name-chk sm-name-scene-chk" ${_chkd(_NT.sceneOn, false)}></div>
                <input type="text" class="sm-name-scene" value="${escapeHTML(shotCfgAtOpen.scene)}" placeholder="067" ${_dis(_NT.sceneOn, false)}>
              </label>
              <label class="sm-name-field ${_offCls(_NT.startOn)}">
                <div class="sm-name-field-hdr"><span class="sm-name-field-lbl">Start #</span><input type="checkbox" class="sm-name-chk sm-name-start-chk" ${_chkd(_NT.startOn)}></div>
                <input type="number" class="sm-name-start" value="${escapeHTML(String(shotCfgAtOpen.start))}" min="0" step="1" ${_dis(_NT.startOn)}>
              </label>
              <label class="sm-name-field ${_offCls(_NT.stepOn)}">
                <div class="sm-name-field-hdr"><span class="sm-name-field-lbl">Step</span><input type="checkbox" class="sm-name-chk sm-name-step-chk" ${_chkd(_NT.stepOn)}></div>
                <input type="number" class="sm-name-step" value="${escapeHTML(String(shotCfgAtOpen.step))}" min="1" step="1" ${_dis(_NT.stepOn)}>
              </label>
              <label class="sm-name-field ${_offCls(_NT.padOn)}">
                <div class="sm-name-field-hdr"><span class="sm-name-field-lbl">Padding</span><input type="checkbox" class="sm-name-chk sm-name-pad-chk" ${_chkd(_NT.padOn)}></div>
                <input type="number" class="sm-name-pad" value="${escapeHTML(String(shotCfgAtOpen.pad))}" min="2" max="6" step="1" ${_dis(_NT.padOn)}>
              </label>
            </div>
          </div>

          <!-- Section B: Version suffix (optional, visually de-emphasised) -->
          <div class="sm-name-v3-section sm-name-v3-section-dim">
            <div class="sm-name-v3-section-head">
              <span class="sm-name-v3-section-title">Version Suffix</span>
              <span class="sm-name-v3-section-hint">optional — task · vendor · v# (all off by default)</span>
            </div>
            <div class="sm-name-v3-fields-grid">
              <label class="sm-name-field ${_offCls(_NT.taskOn, false)}">
                <div class="sm-name-field-hdr"><span class="sm-name-field-lbl">Task</span><input type="checkbox" class="sm-name-chk sm-name-task-chk" ${_chkd(_NT.taskOn, false)}></div>
                <input type="text" class="sm-name-task" value="${escapeHTML(shotCfgAtOpen.task)}" placeholder="comp" ${_dis(_NT.taskOn, false)}>
              </label>
              <label class="sm-name-field ${_offCls(_NT.vendorOn, false)}">
                <div class="sm-name-field-hdr"><span class="sm-name-field-lbl">Vendor</span><input type="checkbox" class="sm-name-chk sm-name-vendor-chk" ${_chkd(_NT.vendorOn, false)}></div>
                <input type="text" class="sm-name-vendor" value="${escapeHTML(shotCfgAtOpen.vendor)}" placeholder="NFX" ${_dis(_NT.vendorOn, false)}>
              </label>
              <label class="sm-name-field ${_offCls(_NT.verOn, false)}">
                <div class="sm-name-field-hdr"><span class="sm-name-field-lbl">Version #</span><input type="checkbox" class="sm-name-chk sm-name-ver-shot-chk" ${_chkd(_NT.verOn, false)}></div>
                <input type="text" class="sm-name-ver-shot" value="${escapeHTML(shotCfgAtOpen.ver)}" placeholder="v001" ${_dis(_NT.verOn, false)}>
              </label>
            </div>
          </div>

        </div><!-- /sm-name-v3-fields -->

        <!-- FOOTER: format token bar + actions -->
        <div class="sm-name-v3-footer">
          <div class="sm-name-fmt-bar" data-role="fmtBar"></div>
          <div class="sm-name-v3-footer-actions">
            <span class="sm-name-actions-note">Selected marker only</span>
            <button type="button" class="btn mini sm-name-cancel">Close</button>
            <button type="button" class="btn sm-name-apply">Apply to SHOT</button>
          </div>
        </div>

        <!-- Hidden compatibility nodes (JS reads these via data-role) -->
        <span style="display:none" data-role="hint-shot"></span>
        <span style="display:none" data-role="footerLabel"></span>
        <div  style="display:none" data-role="verPreviewBlock">
          <div class="v mono sm-name-ver-name-preview" data-role="verNamePreview"></div>
        </div>
        <div  style="display:none" data-role="exampleShot"></div>

      </div><!-- /sm-name-modal-body -->
    </div>`;
  document.body.appendChild(backdrop);
  __smNamingTemplateModal = backdrop;

  const modal            = backdrop.querySelector('.sm-name-modal');
  const shotSettingsBox  = backdrop.querySelector('[data-role="shotSettingsBox"]');
  const hintShot         = backdrop.querySelector('[data-role="hint-shot"]');
  const fmtBar           = backdrop.querySelector('[data-role="fmtBar"]');
  const exampleShot      = backdrop.querySelector('[data-role="exampleShot"]');
  const preview          = backdrop.querySelector('.sm-name-preview');
  const previewEcho      = backdrop.querySelector('[data-role="previewEcho"]');
  const previewTag       = backdrop.querySelector('[data-role="previewTag"]');
  const applyBtn         = backdrop.querySelector('.sm-name-apply');
  const footerLabel      = backdrop.querySelector('[data-role="footerLabel"]');

  // Shot name inputs
  const showInput   = backdrop.querySelector('.sm-name-show');
  const sqInput     = backdrop.querySelector('.sm-name-sq');
  const seqInput    = backdrop.querySelector('.sm-name-seq');
  const sceneInput  = backdrop.querySelector('.sm-name-scene');
  const startInput  = backdrop.querySelector('.sm-name-start');
  const stepInput   = backdrop.querySelector('.sm-name-step');
  const padInput    = backdrop.querySelector('.sm-name-pad');
  const taskInput   = backdrop.querySelector('.sm-name-task');
  const vendorInput = backdrop.querySelector('.sm-name-vendor');
  const verShotInput= backdrop.querySelector('.sm-name-ver-shot');
  const verNamePreview = backdrop.querySelector('[data-role="verNamePreview"]');
  const verPreviewBlock= backdrop.querySelector('[data-role="verPreviewBlock"]');

  // Checkboxes
  const showChk    = backdrop.querySelector('.sm-name-show-chk');
  const epChk      = backdrop.querySelector('.sm-name-ep-chk');
  const seqChk     = backdrop.querySelector('.sm-name-seq-chk');
  const sceneChk   = backdrop.querySelector('.sm-name-scene-chk');
  const startChk   = backdrop.querySelector('.sm-name-start-chk');
  const stepChk    = backdrop.querySelector('.sm-name-step-chk');
  const padChk     = backdrop.querySelector('.sm-name-pad-chk');
  const taskChk    = backdrop.querySelector('.sm-name-task-chk');
  const vendorChk  = backdrop.querySelector('.sm-name-vendor-chk');
  const verShotChk = backdrop.querySelector('.sm-name-ver-shot-chk');

  const getShotCfg = () => ({
    show:  showInput?.value   || shotCfgAtOpen.show,
    sq:    sqInput?.value     || shotCfgAtOpen.sq,
    seq:   seqInput?.value    ?? shotCfgAtOpen.seq,
    scene: sceneInput?.value  ?? shotCfgAtOpen.scene,
    start: startInput?.value  || shotCfgAtOpen.start,
    step:  stepInput?.value   || shotCfgAtOpen.step,
    pad:   padInput?.value    || shotCfgAtOpen.pad,
    task:  taskInput?.value   ?? shotCfgAtOpen.task,
    vendor:vendorInput?.value ?? shotCfgAtOpen.vendor,
    ver:   verShotInput?.value?? shotCfgAtOpen.ver,
  });

  const persistShotCfg = () => { try{ __smWriteNamingTemplateSettings(getShotCfg()); }catch{} };

  // ── Build live format bar HTML (shows full version name pattern) ─────────
  const rebuildFmtBar = (cfg) => {
    if (!fmtBar) return;
    const showOn  = localStorage.getItem(_NT.showOn)  !== '0';
    const epOn    = localStorage.getItem(_NT.epOn)    !== '0';
    const seqOn   = localStorage.getItem(_NT.seqOn)   === '1';
    const sceneOn = localStorage.getItem(_NT.sceneOn) === '1';
    const padOn   = localStorage.getItem(_NT.padOn)   !== '0';
    const taskOn  = localStorage.getItem(_NT.taskOn)  === '1';
    const vendorOn= localStorage.getItem(_NT.vendorOn)=== '1';
    const verOn   = localStorage.getItem(_NT.verOn)   === '1';
    const padW    = padOn ? Math.max(2, Math.min(6, parseInt(padInput?.value||'3',10)||3)) : 1;
    const ctr     = Number(window.__smShotCounter) || parseInt(startInput?.value||'10',10) || 10;

    // Shot name tokens (highlighted in amber at shot#)
    const tokens = [];
    if (showOn)  tokens.push({ text: showInput?.value || 'SHOW' });
    if (epOn)    tokens.push({ text: String(parseInt(sqInput?.value||'101',10)||0).padStart(3,'0') });
    if (seqOn)   { const v = seqInput?.value?.trim(); if(v) tokens.push({ text: /^\d+$/.test(v) ? _ntPad(parseInt(v,10), 3) : v }); }
    if (sceneOn) { const v = sceneInput?.value?.trim(); if(v) tokens.push({ text: v }); }
    tokens.push({ text: String(ctr).padStart(padW,'0'), shot: true });
    // Version tokens (after shot#, dimmer amber)
    if (taskOn)  { const v = taskInput?.value?.trim();   if(v) tokens.push({ text: v, ver: true }); }
    if (vendorOn){ const v = vendorInput?.value?.trim();  if(v) tokens.push({ text: v, ver: true }); }
    if (verOn)   { const v = verShotInput?.value?.trim(); if(v) tokens.push({ text: v, ver: true }); }

    fmtBar.innerHTML = tokens.map((t, i) =>
      (i > 0 ? _ntFmtSep() : '') + _ntFmtPill(t.text, '', t.shot, t.ver)
    ).join('');
  };

  const sync = () => {
    shotSettingsBox?.classList.remove('is-hidden');
    hintShot?.classList.remove('is-hidden');
    exampleShot?.classList.remove('is-hidden');
    verPreviewBlock?.classList.remove('is-hidden');
    const cfg = getShotCfg();
    const next = __smPreviewShotNameFromSettings(cfg, shotCfgAtOpen);
    if (preview)     preview.textContent     = next || 'SHOT';
    if (previewEcho) previewEcho.textContent = next || '—';
    if (previewTag)  previewTag.textContent  = 'SHOT';
    if (applyBtn)    applyBtn.textContent    = 'Apply to SHOT';
    if (footerLabel) footerLabel.textContent = 'Format';
    // Update the marker header to reflect the live preview
    const hdVal = backdrop.querySelector('.sm-name-v3-hd-val');
    if (hdVal) hdVal.textContent = next || m.shotName || '—';

    if (verNamePreview) {
      const padOn = localStorage.getItem(_NT.padOn) !== '0';
      const padW  = padOn ? Math.max(2, Math.min(6, parseInt(cfg.pad,10)||3)) : 1;
      const currentCounter = Number(window.__smShotCounter);
      const base = __smReadNamingTemplateSettings();
      const startNum = parseInt(cfg.start, 10);
      const start = Number.isFinite(startNum) ? startNum : 10;
      const nextCounter = (start !== base.start || !Number.isFinite(currentCounter)) ? start : currentCounter;
      verNamePreview.textContent = _ntBuildVersionParts(cfg, _ntPad(nextCounter, padW)).join('_') || '—';
    }

    rebuildFmtBar(cfg);
  };

  [showInput, sqInput, seqInput, sceneInput, startInput, stepInput, padInput, taskInput, vendorInput, verShotInput].forEach(el => el?.addEventListener('input', sync));
  [showInput, sqInput, seqInput, sceneInput, startInput, stepInput, padInput, taskInput, vendorInput, verShotInput]
    .forEach(el => el?.addEventListener('change', () => { persistShotCfg(); sync(); }));

  // Checkbox toggles — defaultOn=true for original 5, false for new fields
  const _chkMap = [
    [showChk,    showInput,    _NT.showOn,   true ],
    [epChk,      sqInput,      _NT.epOn,     true ],
    [seqChk,     seqInput,     _NT.seqOn,    false],
    [sceneChk,   sceneInput,   _NT.sceneOn,  false],
    [startChk,   startInput,   _NT.startOn,  true ],
    [stepChk,    stepInput,    _NT.stepOn,   true ],
    [padChk,     padInput,     _NT.padOn,    true ],
    [taskChk,    taskInput,    _NT.taskOn,   false],
    [vendorChk,  vendorInput,  _NT.vendorOn, false],
    [verShotChk, verShotInput, _NT.verOn,    false],
  ];
  _chkMap.forEach(([chk, inp, key]) => {
    if (!chk) return;
    chk.addEventListener('change', () => {
      const on = chk.checked;
      localStorage.setItem(key, on ? '1' : '0');
      if (inp) inp.disabled = !on;
      chk.closest('.sm-name-field')?.classList.toggle('sm-name-field-off', !on);
      sync();
    });
  });

  backdrop.querySelector('.sm-name-modal-close')?.addEventListener('click', closeNamingTemplatePopup);
  backdrop.querySelector('.sm-name-cancel')?.addEventListener('click', closeNamingTemplatePopup);
  backdrop.querySelector('.sm-name-apply')?.addEventListener('click', () => {
    __smWriteNamingTemplateSettings(getShotCfg());
    const next = buildShotName();
    if (!next) return;
    if (m?._pmShotLocked) {
      try { window.__pmNotifyShotNameLocked?.(String(id), 'template'); } catch {}
      return;
    }
    __smPushUndoLive('namingtemplate');
    m.shotName = String(next || '').trim();
    try{ __smSetActiveLive(id, { noRender:true }); }catch{}
    try{ __smMarkDirtyLive(); }catch{}
    try{ window.__MPS_SM_SNAPSHOT = __smSnapshotLive(); }catch{}
    try{ window.MPS_updateValidation?.({}); }catch{}
    __smRenderLive();
    closeNamingTemplatePopup();
  });

  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeNamingTemplatePopup(); });
  __smNamingTemplateEsc = e => { if (e.key === 'Escape') closeNamingTemplatePopup(); };
  window.addEventListener('keydown', __smNamingTemplateEsc, true);
  sync();
  try{ modal?.querySelector('.sm-name-modal-close')?.focus?.(); }catch{}
}

// ── Public entry point ────────────────────────────────────────────────────────
function __smOpenNamingTemplateById(id){
  const markerId = String(id || '').trim();
  if (!markerId) return;
  setTimeout(() => {
    try{ openNamingTemplatePopup(markerId); }catch(err){ try{ console.error('[NT] Template popup open failed', err); }catch{} }
  }, 0);
}

try{ window.__smOpenNamingTemplateById    = __smOpenNamingTemplateById;    }catch{}
try{ window.__smBuildPlateStyleName      = __smBuildPlateStyleName;       }catch{}
try{ window.__smBuildTrackLayerShotName  = __smBuildTrackLayerShotName;   }catch{}
try{ window.__smSanitizeNameToken        = __smSanitizeNameToken;         }catch{}
try{ window.__smStripPlateSuffix         = __smStripPlateSuffix;          }catch{}
try{ window.__pfxBuildAssociatedShotName = buildAssociatedShotName;       }catch{}

// Test helper: window.PFX_TEST_FIX_NAME(markerId)
// Returns { shotName, computed, match } so the console can verify the fix without a full reload.
try {
  window.PFX_TEST_FIX_NAME = (markerId) => {
    const mk = _ntCurrentMarkers.get(String(markerId));
    if (!mk) return { error: `marker ${markerId} not registered — call window.__ntRegisterMarker(id, mk) first` };
    const computed = _ntComputeShotName(String(markerId));
    _ntApplyShotNameToMarker(String(markerId), computed);
    return { markerId, shotName: mk.shotName, computed, match: mk.shotName === computed };
  };
} catch {}

// ── Inline chip bar (no popup) ────────────────────────────────────────────────
let _ntInlineBar         = null;
let _ntInlineDocHandler  = null;
let _ntInlineEscHandler  = null;

function _ntCloseInlineBar(){
  try{ if(_ntInlineEscHandler) window.removeEventListener('keydown', _ntInlineEscHandler, true); }catch{}
  _ntInlineEscHandler = null;
  try{ if(_ntInlineDocHandler) document.removeEventListener('pointerdown', _ntInlineDocHandler, true); }catch{}
  _ntInlineDocHandler = null;
  try{ _ntInlineBar?.remove(); }catch{}
  _ntInlineBar = null;
}

// Token order follows Netflix VFX Shot Naming: showID_ep_[seq]_[scene]_shotID#_[task]_[vendor]_ver#
// Ref: Netflix VFX Shot and Version Naming Recommendations
const _NT_TOKENS = [
  { key:'show',   label:'Show',   lsOn:_NT.showOn,   lsVal:_NT.show,   defOn:true,  ph:'LMP'  },
  { key:'ep',     label:'EP',     lsOn:_NT.epOn,     lsVal:_NT.sq,     defOn:true,  ph:'101'  },
  { key:'seq',    label:'Seq',    lsOn:_NT.seqOn,    lsVal:_NT.seq,    defOn:false, ph:'TCC'  },
  { key:'scene',  label:'Scene',  lsOn:_NT.sceneOn,  lsVal:_NT.scene,  defOn:false, ph:'067'  },
  { key:'shot',   label:'Shot#',  lsOn:null,          lsVal:_NT.start,     defOn:true,  ph:'010',  special:true    },
  { key:'plate',  label:'Plate',  lsOn:_NT.plateOn,  lsVal:_NT.plateCode, defOn:false, ph:'BG01', special:'plate' },
  { key:'ocr',    label:'OCR',    lsOn:null,          lsVal:null,          defOn:false, ph:'',     special:'ocr'   },
  { key:'vendor', label:'Vendor', lsOn:_NT.vendorOn, lsVal:_NT.vendor, defOn:false, ph:'NFX'  },
  { key:'ver',    label:'Ver#',   lsOn:_NT.verOn,    lsVal:_NT.ver,    defOn:false, ph:'v001' },
];

function _ntTokIsOn(tok, markerId){
  // Mibar settings carry the merged per-user visibility with correct defaults (all true).
  // This is the single source of truth — raw lsOn localStorage flags are only used
  // as a legacy write target so removing/adding chips still persists.
  const s = _ntReadMibarSettings();
  if(tok.key in s.visible) return s.visible[tok.key] !== false;
  // Fallback for any token not yet in the mibar settings (e.g. shot# which has lsOn:null)
  if(tok.lsOn === null) return true;
  return tok.defOn ? localStorage.getItem(tok.lsOn) !== '0' : localStorage.getItem(tok.lsOn) === '1';
}

function _ntParseTokensFromShotName(shotName){
  const result = {};
  if(!shotName) return result;
  const parts = String(shotName).trim().split(/[_\-\.]+/).filter(Boolean);
  // Version: v001, v01
  const verIdx = parts.findIndex(p => /^[vV]\d+$/.test(p));
  if(verIdx >= 0) { result.ver = parts[verIdx].toLowerCase(); parts.splice(verIdx, 1); }
  // Vendor: 2-4 all-caps that don't match other patterns
  const vendorIdx = parts.findIndex(p => /^[A-Z]{2,5}$/.test(p) && !/^\d+$/.test(p) && parts.indexOf(p) > 0);
  if(vendorIdx >= 0) { result.vendor = parts[vendorIdx]; parts.splice(vendorIdx, 1); }
  // SHOW = first token (3-5 alpha chars)
  if(parts[0] && /^[A-Za-z]{2,6}$/.test(parts[0])) result.show = parts[0].toUpperCase();
  // EP = 3-digit numeric or Exx
  const epIdx = parts.findIndex((p,i) => i>0 && (/^\d{3}$/.test(p) || /^[Ee]\d{2,3}$/.test(p)));
  if(epIdx >= 0) result.ep = parts[epIdx].toUpperCase();
  // SEQ = 2-4 alpha chars after show
  const seqIdx = parts.findIndex((p,i) => i>0 && /^[A-Z]{2,4}$/.test(p) && p !== result.show && p !== result.vendor);
  if(seqIdx >= 0) result.seq = parts[seqIdx];
  // SCENE = 3-digit or Sxxx
  const scIdx = parts.findIndex((p,i) => i>0 && (/^\d{3}$/.test(p) || /^[Ss]\d{2,4}$/.test(p)) && parts.indexOf(p) !== epIdx);
  if(scIdx >= 0) result.scene = parts[scIdx].toUpperCase();
  // SHOT = 4-digit numeric
  const shotIdx = parts.findIndex(p => /^\d{4,5}$/.test(p));
  if(shotIdx >= 0) result.shot = parts[shotIdx];
  // PLATE = ends with digits (BG01, PL01, BK02)
  const plateIdx = parts.findIndex(p => /^[A-Z]{1,4}\d{2}$/.test(p));
  if(plateIdx >= 0) result.plate = parts[plateIdx];
  return result;
}

function _ntTokDisplayVal(tok, markerId){
  if(tok.special === 'ocr'){
    const mk = _ntCurrentMarkers.get(String(markerId || ''));
    const text = mk?.ocr?.verifiedText || mk?.ocr?.cleanText || mk?.ocr?.rawText || '';
    return text || 'Not Set';
  }
  if(tok.special === 'plate'){
    const code = String(localStorage.getItem(_NT.plateCode)||'').trim();
    const num  = String(localStorage.getItem(_NT.plateNum)||'01').trim();
    return code ? (code + String(num||'01').padStart(2,'0')) : '';
  }
  if(tok.special){
    // Per-marker shot# takes priority; fallback shows c2.start (same value that onDone commits)
    const mk2 = _ntCurrentMarkers.get(String(markerId || ''));
    if(mk2?.template?.shot) return mk2.template.shot;
    const c2 = __smReadNamingTemplateSettings();
    const padOn = localStorage.getItem(_NT.padOn) !== '0';
    const padW  = padOn ? c2.pad : 1;
    return String(c2.start).padStart(padW, '0');
  }
  // Per-marker template staging area takes priority over global localStorage
  const mk = _ntCurrentMarkers.get(String(markerId || ''));
  if(mk?.template?.[tok.key]) return mk.template[tok.key];
  const lsVal = localStorage.getItem(tok.lsVal) || '';
  if(lsVal) return lsVal;
  // Fallback: parse from registered marker's shot name
  if(mk?.shotName){
    const parsed = _ntParseTokensFromShotName(mk.shotName);
    return parsed[tok.key] || '';
  }
  return '';
}

function _ntOcrStatus(markerId){
  const mk = _ntCurrentMarkers.get(String(markerId || ''));
  const hasOcr = !!(mk?.template?.ocrText || mk?.ocr?.cleanText || mk?.ocr?.verifiedText);
  if(!hasOcr) return 'empty';
  if(mk?.ocr?.status === 'verified' || mk?.ocr?.verifiedText) return 'verified';
  return mk?.ocr?.status || 'review';
}

function _ntShotNumPanel(anchorChip, onDone){
  document.querySelector('.pm-nt-shotnum-panel')?.remove();
  const c2    = __smReadNamingTemplateSettings();
  const panel = document.createElement('div');
  panel.className = 'pm-nt-shotnum-panel';
  panel.innerHTML =
    `<label class="pm-nt-sn-lbl">Start<input class="pm-nt-sn-inp" data-f="start" type="number" value="${c2.start}" min="0" step="1"></label>` +
    `<label class="pm-nt-sn-lbl">Step<input class="pm-nt-sn-inp" data-f="step" type="number" value="${c2.step}" min="1" step="1"></label>` +
    `<label class="pm-nt-sn-lbl">Pad<input class="pm-nt-sn-inp" data-f="pad" type="number" value="${c2.pad}" min="2" max="6" step="1"></label>` +
    `<button class="pm-nt-sn-ok">OK</button>`;
  anchorChip.after(panel);
  const commit = () => {
    const s = parseInt(panel.querySelector('[data-f="start"]').value, 10);
    const t = parseInt(panel.querySelector('[data-f="step"]').value,  10);
    const p = parseInt(panel.querySelector('[data-f="pad"]').value,   10);
    __smWriteNamingTemplateSettings({ start:s, step:t, pad:p });
    panel.remove();
    onDone();
  };
  panel.querySelector('.pm-nt-sn-ok').addEventListener('click', e => { e.stopPropagation(); commit(); });
  panel.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('keydown', e => {
      if(e.key==='Enter') { e.preventDefault(); commit(); }
      if(e.key==='Escape'){ e.preventDefault(); panel.remove(); onDone(); }
      e.stopPropagation();
    });
  });
  panel.querySelector('[data-f="start"]')?.focus();
}

function _ntPlatePanel(anchorChip, onDone){
  document.querySelector('.pm-nt-plate-panel')?.remove();
  const PRESETS = ['FG','BG','EL','RF','BS','GS','CC','LG','CP'];
  const curCode = String(localStorage.getItem(_NT.plateCode)||'').trim();
  const curNum  = parseInt(localStorage.getItem(_NT.plateNum)||'1',10)||1;
  const isPreset = PRESETS.includes(curCode);

  const panel = document.createElement('div');
  panel.className = 'pm-nt-plate-panel';
  panel.innerHTML =
    `<div class="pm-nt-pl-grid">${PRESETS.map(c =>
      `<button class="pm-nt-pl-code${curCode===c?' active':''}" data-code="${c}" title="${_ntPlateLabel(c)}">${c}</button>`
    ).join('')}</div>` +
    `<div class="pm-nt-pl-custom-row">` +
      `<input class="pm-nt-pl-custom" type="text" placeholder="custom…" value="${isPreset?'':curCode}" maxlength="20">` +
      `<input class="pm-nt-pl-num" type="number" value="${curNum}" min="1" max="99" step="1">` +
    `</div>` +
    `<button class="pm-nt-sn-ok">OK</button>`;

  anchorChip.after(panel);

  const codeInp = panel.querySelector('.pm-nt-pl-custom');
  const numInp  = panel.querySelector('.pm-nt-pl-num');

  panel.querySelectorAll('.pm-nt-pl-code').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      panel.querySelectorAll('.pm-nt-pl-code').forEach(b => b.classList.remove('active'));
      btn.classList.toggle('active', true);
      codeInp.value = '';
    });
  });

  codeInp.addEventListener('input', () => {
    if(codeInp.value.trim()) panel.querySelectorAll('.pm-nt-pl-code').forEach(b => b.classList.remove('active'));
  });

  const commit = () => {
    const activeBtn = panel.querySelector('.pm-nt-pl-code.active');
    const code = (codeInp.value.trim() || activeBtn?.dataset.code || '').trim();
    const num  = parseInt(numInp.value,10)||1;
    if(code){
      localStorage.setItem(_NT.plateCode, __smSanitizeNameToken(code));
      localStorage.setItem(_NT.plateNum,  String(num));
    }
    panel.remove();
    onDone();
  };

  panel.querySelector('.pm-nt-sn-ok').addEventListener('click', e => { e.stopPropagation(); commit(); });
  [codeInp, numInp].forEach(inp => {
    inp.addEventListener('keydown', e => {
      if(e.key==='Enter') { e.preventDefault(); commit(); }
      if(e.key==='Escape'){ e.preventDefault(); panel.remove(); onDone(); }
      e.stopPropagation();
    });
  });
}

function _ntPlateLabel(code){
  const MAP = {FG:'Foreground',BG:'Background',EL:'Element',RF:'Reference',
               BS:'Bluescreen',GS:'Greenscreen',CC:'Color Chart',LG:'Lens Grid',CP:'Clean Plate'};
  return MAP[code] || code;
}

function openNamingTemplateInline(id, anchorEl){
  const findM = (mid) => {
    try{ const h = window.__smFindMarkerById?.(mid); if(h) return h; }catch{}
    try{ const a = window.__smGetMarkersRef?.(); if(Array.isArray(a)) return a.find(x=>x?.id===mid)||null; }catch{}
    return null;
  };
  const m = findM(id);
  if(!m) return;

  // Toggle off if already open for same marker
  if(_ntInlineBar){
    const prev = _ntInlineBar.dataset.markerId;
    _ntCloseInlineBar();
    if(prev === String(id)) return;
  }

  const bar = document.createElement('div');
  bar.className = 'pm-nt-bar';
  bar.dataset.markerId = String(id);

  const renderBar = () => {
    const mid     = String(id);
    const sorted  = _ntGetSortedTokens();
    const active  = sorted.filter(t => _ntTokIsOn(t, mid));
    const inactive= sorted.filter(t => !_ntTokIsOn(t, mid));
    const c2      = __smReadNamingTemplateSettings();
    const preview = __smPreviewShotNameFromSettings({}, c2);
    const { displayMode } = _ntReadMibarSettings();

    const chipsHtml = active.map(tok => {
      const raw  = _ntTokDisplayVal(tok, mid);
      const disp = raw || `(${tok.ph})`;
      let chipCls = tok.special===true ? ' pm-nt-chip-shot' : tok.special==='plate' ? ' pm-nt-chip-plate' : '';
      if(tok.special === 'ocr') chipCls = ` pm-nt-chip-ocr pm-nt-chip-ocr--${_ntOcrStatus(mid)}`;
      return `<span class="pm-nt-chip${chipCls}" data-tok="${tok.key}" draggable="true">` +
        `<span class="pm-nt-chip-lbl">${tok.label}</span>` +
        `<span class="pm-nt-chip-colon">:</span>` +
        `<span class="pm-nt-chip-val" data-edit="${tok.key}">${escapeHTML(disp)}</span>` +
        (tok.special===true ? '' : `<button class="pm-nt-chip-rm" data-rm="${tok.key}">×</button>`) +
        `</span>`;
    }).join('');

    const ghostsHtml = inactive.map(t =>
      `<button class="pm-nt-ghost" data-add="${t.key}">+ ${t.label}</button>`
    ).join('');

    bar.className = `pm-nt-bar pm-nt-bar--mode-${displayMode}`;
    bar.dataset.markerId = mid;
    const modeLbl = displayMode === 'compact' ? '▣' : displayMode === 'expanded' ? '▦' : '⋯';
    bar.innerHTML =
      `<span class="pm-nt-ico"><svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.5" width="12" height="12" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="2.5" width="11" height="9" rx="1.5"/><line x1="4" y1="5.5" x2="10" y2="5.5"/><line x1="4" y1="8" x2="7.5" y2="8"/></svg></span>` +
      `<span class="pm-nt-chips-row">${chipsHtml}${ghostsHtml}</span>` +
      `<button class="pm-nt-mode-btn" title="Display mode: ${displayMode}">${modeLbl}</button>` +
      `<span class="pm-nt-preview" title="${escapeHTML(preview)}">${escapeHTML(preview||'—')}</span>` +
      `<button class="pm-nt-apply">Apply</button>` +
      `<button class="pm-nt-close">✕</button>`;

    wireBar();
  };

  const wireBar = () => {
    const mid = String(id);

    bar.querySelectorAll('[data-rm]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const tok = _NT_TOKENS.find(t => t.key===btn.dataset.rm);
        if(tok) {
          const s = _ntReadMibarSettings();
          _ntWriteMibarSettings({ ...s, visible: { ...s.visible, [tok.key]: false } });
          if(tok.lsOn) localStorage.setItem(tok.lsOn, '0');
        }
        renderBar();
      });
    });

    bar.querySelectorAll('[data-add]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const tok = _NT_TOKENS.find(t => t.key===btn.dataset.add);
        if(tok) {
          const s = _ntReadMibarSettings();
          _ntWriteMibarSettings({ ...s, visible: { ...s.visible, [tok.key]: true } });
          if(tok.lsOn) localStorage.setItem(tok.lsOn, '1');
          if(tok.lsVal && !localStorage.getItem(tok.lsVal) && tok.ph) {
            localStorage.setItem(tok.lsVal, tok.ph);
          }
        }
        renderBar();
      });
    });

    // Drag-and-drop chip reorder
    let _dragKey = null;
    bar.querySelectorAll('.pm-nt-chip[draggable]').forEach(chip => {
      chip.addEventListener('dragstart', e => {
        _dragKey = chip.dataset.tok;
        e.dataTransfer.effectAllowed = 'move';
      });
      chip.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        chip.classList.add('pm-nt-chip--dragover');
      });
      chip.addEventListener('dragleave', () => chip.classList.remove('pm-nt-chip--dragover'));
      chip.addEventListener('drop', e => {
        e.preventDefault();
        chip.classList.remove('pm-nt-chip--dragover');
        const toKey = chip.dataset.tok;
        if(!_dragKey || _dragKey === toKey) return;
        const s = _ntReadMibarSettings();
        const order = [...s.order];
        // Ensure all token keys present in order
        _MIBAR_DEFAULT_ORDER.forEach(k => { if(!order.includes(k)) order.push(k); });
        const fI = order.indexOf(_dragKey), tI = order.indexOf(toKey);
        if(fI >= 0 && tI >= 0){ order.splice(fI, 1); order.splice(tI, 0, _dragKey); }
        _ntWriteMibarSettings({ ...s, order });
        _dragKey = null;
        renderBar();
      });
    });

    // OCR chip: left-click → run OCR; right-click → context menu
    const ocrChip = bar.querySelector('.pm-nt-chip-ocr');
    if(ocrChip){
      ocrChip.querySelector('.pm-nt-chip-val')?.addEventListener('click', e => {
        e.stopPropagation();
        try{ window.__pmRunOcrForChip?.(mid); }catch{}
      });
      ocrChip.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        _ntShowOcrContextMenu(e, mid, renderBar);
      });
    }

    bar.querySelectorAll('[data-edit]').forEach(span => {
      span.addEventListener('click', e => {
        e.stopPropagation();
        const tok = _NT_TOKENS.find(t => t.key===span.dataset.edit);
        if(!tok) return;
        if(tok.special === 'ocr'){
          try{ window.__pmRunOcrForChip?.(mid); }catch{}
          return;
        }
        if(tok.special === 'plate'){
          _ntPlatePanel(span.closest('.pm-nt-chip'), renderBar);
          return;
        }
        if(tok.special){
          _ntShotNumPanel(span.closest('.pm-nt-chip'), renderBar);
          return;
        }
        const cur = localStorage.getItem(tok.lsVal) || '';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'pm-nt-chip-inp';
        inp.value = cur;
        inp.placeholder = tok.ph;
        inp.style.width = Math.max(32, Math.min(120, cur.length*9+20))+'px';
        span.replaceWith(inp);
        inp.focus(); inp.select();
        const commit = () => {
          if(tok.lsVal) localStorage.setItem(tok.lsVal, inp.value.trim());
          renderBar();
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', e2 => {
          if(e2.key==='Enter') { e2.preventDefault(); commit(); }
          if(e2.key==='Escape'){ e2.preventDefault(); renderBar(); }
          e2.stopPropagation();
        });
      });
    });

    bar.querySelector('.pm-nt-mode-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      const s = _ntReadMibarSettings();
      const cycle = { auto: 'compact', compact: 'expanded', expanded: 'auto' };
      _ntWriteMibarSettings({ ...s, displayMode: cycle[s.displayMode] || 'auto' });
      renderBar();
    });

    bar.querySelector('.pm-nt-apply')?.addEventListener('click', e => {
      e.stopPropagation();
      __smWriteNamingTemplateSettings({
        show:  localStorage.getItem(_NT.show)  ||'',
        sq:    localStorage.getItem(_NT.sq)    ||'101',
        seq:   localStorage.getItem(_NT.seq)   ||'',
        scene: localStorage.getItem(_NT.scene) ||'',
        vendor:localStorage.getItem(_NT.vendor)||'',
        ver:   localStorage.getItem(_NT.ver)   ||'',
      });
      const next = buildShotName();
      if(!next) return;
      if (m?._pmShotLocked) {
        try { window.__pmNotifyShotNameLocked?.(String(id), 'template'); } catch {}
        return;
      }
      try{ window.__smPushMarkerUndo?.('namingtemplate'); }catch{}
      m.shotName = String(next).trim();
      try{ window.__smMarkDirtyFromPopup?.(); }catch{}
      try{ window.MPS_markProjectDirty?.(); }catch{}
      try{ window.__smRenderFromPopup?.(); }catch{}
      try{ window.__pmNamingTemplateApplied?.(String(id), m.shotName); }catch{}
      _ntCloseInlineBar();
    });

    bar.querySelector('.pm-nt-close')?.addEventListener('click', e => {
      e.stopPropagation();
      _ntCloseInlineBar();
    });
  };

  // Insert bar after .pm-insp-name-actions (parent grid row) or after anchor
  const actionsDiv = anchorEl?.closest('.pm-insp-name-actions');
  if(actionsDiv){
    actionsDiv.insertAdjacentElement('afterend', bar);
  } else if(anchorEl?.parentNode){
    anchorEl.parentNode.insertBefore(bar, anchorEl.nextSibling);
  } else {
    document.body.appendChild(bar);
  }
  _ntInlineBar = bar;
  bar._ntRenderBar = renderBar;
  renderBar();

  setTimeout(() => {
    _ntInlineDocHandler = e => { if(!bar.contains(e.target) && !e.target.closest('.pm-nt-shotnum-panel') && !e.target.closest('.pm-nt-plate-panel')) _ntCloseInlineBar(); };
    document.addEventListener('pointerdown', _ntInlineDocHandler, true);
  }, 0);
  _ntInlineEscHandler = e => { if(e.key==='Escape') _ntCloseInlineBar(); };
  window.addEventListener('keydown', _ntInlineEscHandler, true);
}

try{ window.__smOpenNamingTemplateInline = openNamingTemplateInline; }catch{}
try{ window.__smCloseNamingTemplateInline = _ntCloseInlineBar; }catch{}

// ── Floating popup with number list for chip value editing in the static bar ──
function _ntChipPopup(tok, anchorEl, onDone){
  document.querySelector('.pm-nt-chip-popup')?.remove();
  const cur   = localStorage.getItem(tok.lsVal) || '';
  const isNum = tok.key === 'ep' || tok.key === 'scene';

  // Build selectable option list
  const options = [];
  if(tok.key === 'ep'){
    for(let i=101; i<=112; i++) options.push(String(i));
    for(let i=201; i<=212; i++) options.push(String(i));
    for(let i=301; i<=312; i++) options.push(String(i));
  } else if(tok.key === 'scene'){
    const base = parseInt(cur,10)||1;
    for(let i=Math.max(1,base-5); i<=base+14; i++) options.push(String(i).padStart(3,'0'));
  } else if(tok.key === 'ver'){
    for(let i=1; i<=20; i++) options.push(`v${String(i).padStart(3,'0')}`);
  }

  // Normalise current value for active-match
  const curNorm = tok.key === 'ep' ? String(parseInt(cur,10)||0) :
                  isNum            ? String(parseInt(cur,10)||0).padStart(3,'0') : cur;

  const listHtml = options.map(o =>
    `<button class="pm-nt-popup-opt${o===curNorm?' pm-nt-popup-opt-active':''}" data-val="${escapeHTML(o)}">${escapeHTML(o)}</button>`
  ).join('');

  const popup = document.createElement('div');
  popup.className = 'pm-nt-chip-popup';
  popup.innerHTML =
    `<input class="pm-nt-chip-popup-inp" type="${isNum?'number':'text'}" ` +
      `value="${escapeHTML(cur)}" placeholder="${escapeHTML(tok.ph)}"` +
      `${isNum?' min="1" step="1"':''}` +
    `>` +
    (options.length ? `<div class="pm-nt-popup-list">${listHtml}</div>` : '') +
    `<button class="pm-nt-sn-ok">OK</button>`;

  const rect = anchorEl.getBoundingClientRect();
  popup.style.cssText = `position:fixed;top:${rect.bottom+4}px;left:${rect.left}px;z-index:99999;`;
  document.body.appendChild(popup);

  // Scroll highlighted item into view
  const activeOpt = popup.querySelector('.pm-nt-popup-opt-active');
  if(activeOpt) setTimeout(() => activeOpt.scrollIntoView({block:'nearest'}), 0);

  const inp = popup.querySelector('input');
  inp.focus(); inp.select();

  const commit = (val) => {
    const v = val !== undefined ? val : inp.value.trim();
    if(tok.lsVal && v) localStorage.setItem(tok.lsVal, v);
    popup.remove();
    onDone();
  };

  popup.querySelectorAll('.pm-nt-popup-opt').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); commit(btn.dataset.val); });
  });
  popup.querySelector('.pm-nt-sn-ok').addEventListener('click', e => { e.stopPropagation(); commit(); });
  inp.addEventListener('keydown', e => {
    if(e.key==='Enter') { e.preventDefault(); commit(); }
    if(e.key==='Escape'){ e.preventDefault(); popup.remove(); onDone(); }
    e.stopPropagation();
  });

  setTimeout(() => {
    const dismiss = ev => {
      if(!popup.contains(ev.target) && ev.target !== anchorEl){
        document.removeEventListener('pointerdown', dismiss, true);
        if (inp.value.trim()) commit(); else popup.remove();
      }
    };
    document.addEventListener('pointerdown', dismiss, true);
  }, 0);
}

// ── OCR chip context menu ─────────────────────────────────────────────────────
function _ntShowOcrContextMenu(e, markerId, onAction){
  document.querySelector('.pm-nt-ocr-ctx-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'pm-nt-ocr-ctx-menu';
  const mk = _ntCurrentMarkers.get(String(markerId));
  const hasOcr = !!(mk?.ocr?.cleanText || mk?.ocr?.verifiedText);
  const hasVerified = !!(mk?.ocr?.verifiedText);
  const items = [
    { label: '↻ Re-run OCR',     key: 'rerun',   always: true },
    { label: '⊡ Set OCR Area',   key: 'setarea', always: true },
    { label: '— Copy OCR text',  key: 'copy',    show: hasOcr },
    { label: '✦ Parse → Fields', key: 'parse',   show: hasOcr },
    { label: '✓ Mark Verified',  key: 'verify',  show: hasOcr && !hasVerified },
    { label: '✕ Clear OCR',      key: 'clear',   show: hasOcr },
  ];
  menu.innerHTML = items
    .filter(it => it.always || it.show)
    .map(it => `<button class="pm-nt-ocr-ctx-item" data-action="${it.key}">${it.label}</button>`)
    .join('');
  menu.style.cssText = `position:fixed;top:${e.clientY}px;left:${e.clientX}px;z-index:99999;`;
  document.body.appendChild(menu);

  menu.querySelectorAll('.pm-nt-ocr-ctx-item').forEach(btn => {
    btn.addEventListener('click', ev => {
      ev.stopPropagation();
      menu.remove();
      const action = btn.dataset.action;
      if(action === 'rerun')   try{ window.__pmRunOcrForChip?.(markerId); }catch{}
      if(action === 'setarea') try{ window.__pmSetOcrAreaForChip?.(markerId); }catch{}
      if(action === 'copy'){
        const txt = mk?.ocr?.verifiedText || mk?.ocr?.cleanText || '';
        try{ navigator.clipboard.writeText(txt); }catch{}
      }
      if(action === 'parse')   try{ window.__pmParseOcrToFields?.(markerId); }catch{}
      if(action === 'verify'){
        if(mk?.ocr){ mk.ocr.verifiedText = mk.ocr.cleanText; mk.ocr.status = 'verified'; mk.ocr.updatedAt = Date.now(); }
        try{ window.__pmSaveAfterOcrUpdate?.(markerId); onAction?.(); }catch{}
      }
      if(action === 'clear'){
        if(mk?.ocr){ mk.ocr = null; }
        try{ window.__pmSaveAfterOcrUpdate?.(markerId); onAction?.(); }catch{}
      }
    });
  });

  const dismiss = ev => {
    if(!menu.contains(ev.target)){ menu.remove(); document.removeEventListener('pointerdown', dismiss, true); }
  };
  setTimeout(() => document.addEventListener('pointerdown', dismiss, true), 0);
}

// ── Real-time shot name helpers ───────────────────────────────────────────────

// Compute canonical shot name for a registered marker from current chip state.
// Scene is included only when the scene chip is active (visible via mibar settings).
function _ntComputeShotName(mid) {
  const mk = _ntCurrentMarkers.get(String(mid));
  const tmpl = mk?.template || {};
  const show  = String(tmpl.show  || localStorage.getItem(_NT.show)  || '').trim();
  const ep    = String(tmpl.ep    || localStorage.getItem(_NT.sq)    || '').trim();
  const sceneTok    = _NT_TOKENS.find(t => t.key === 'scene');
  const sceneActive = sceneTok ? _ntTokIsOn(sceneTok, mid) : false;
  const scene = sceneActive ? String(tmpl.scene || localStorage.getItem(_NT.scene) || '').trim() : '';
  const shot  = (() => {
    if (tmpl.shot) return String(tmpl.shot).trim();
    const c2   = __smReadNamingTemplateSettings();
    const padOn = localStorage.getItem(_NT.padOn) !== '0';
    const padW  = padOn ? Math.max(2, Math.min(6, parseInt(c2.pad,10)||3)) : 1;
    return _ntPad(c2.start, padW);
  })();
  const name = buildAssociatedShotName({ show, ep, scene, shot });
  if (window.PFX_DEBUG_NAMING) {
    try { console.log('[PFX naming] _ntComputeShotName', { mid, show, ep, scene, shot, sceneActive, name }); } catch {}
  }
  return name;
}

// Write a computed shot name back to a registered PM marker immediately.
// No-ops if marker is locked or not registered.
function _ntApplyShotNameToMarker(mid, shotName) {
  if (!shotName) return;
  const mk = _ntCurrentMarkers.get(String(mid));
  if (!mk || mk._pmShotLocked) return;
  if (window.PFX_DEBUG_NAMING) {
    try { console.log('[PFX naming] _ntApplyShotNameToMarker', { mid, requested: shotName, current: mk.shotName }); } catch {}
  }
  // Immediate DOM feedback — reads active chips independently, does NOT write mk.shotName.
  // Writing mk.shotName here would trigger the guard in _pmAutoNameFromTemplate and skip
  // _pmCommitShotNameChange, leaving the saved state stale and reverting on next full render.
  try { window.__pmPushShotNameNow?.(mid); } catch {}
  // Full commit: active chips → buildShotNameFromTemplate → _pmCommitShotNameChange → render+save
  try { window.__pmAutoNameFromTemplate?.(mid, { silent: true }); } catch {}
  try { window.__smMarkDirtyFromPopup?.(); } catch {}
}

// ── Static (always-visible) chip bar — mounted into a container div ───────────
function openNamingTemplateStatic(id, containerEl){
  if(!containerEl) return;
  const findM = (mid) => {
    // PM markers are registered via window.__ntRegisterMarker — check first
    const reg = _ntCurrentMarkers.get(String(mid));
    if(reg) return reg;
    try{ const h = window.__smFindMarkerById?.(mid); if(h) return h; }catch{}
    try{ const a = window.__smGetMarkersRef?.(); if(Array.isArray(a)) return a.find(x=>x?.id===mid)||null; }catch{}
    // Synthesize a minimal stub so the bar renders even with no marker data
    return { id: mid, shotName: '' };
  };
  const m = findM(id);

  // Remove any existing chip bar; preserve pre-rendered plate controls + actions
  containerEl.querySelector('.pm-nt-bar')?.remove();

  const bar = document.createElement('div');
  bar.className = 'pm-nt-bar pm-nt-bar-static';
  bar.dataset.markerId = String(id);
  containerEl.prepend(bar);

  const renderBar = () => {
    const mid     = String(id);
    const sorted  = _ntGetSortedTokens();
    const active  = sorted.filter(t => _ntTokIsOn(t, mid));
    const inactive= sorted.filter(t => !_ntTokIsOn(t, mid));
    const c2      = __smReadNamingTemplateSettings();
    const preview = __smPreviewShotNameFromSettings({}, c2);
    const { displayMode } = _ntReadMibarSettings();

    // Compute full name (includes task / vendor / ver#)
    const padOn2 = localStorage.getItem(_NT.padOn) !== '0';
    const padW2  = padOn2 ? Math.max(2, Math.min(6, parseInt(c2.pad,10)||3)) : 1;
    const ctr2   = Number(window.__smShotCounter) || c2.start;
    const fullName = _ntBuildVersionParts(c2, _ntPad(ctr2, padW2)).join('_') || preview;
    const isLocked = !!m._pmShotLocked;
    const markerMode = String(m._pmNameMode || '').trim().toLowerCase();
    const currentShotName = String(m.shotName || '').trim();
    // PM markers use template staging — shot name is never auto-committed from the chip bar
    const isPmMarker = _ntCurrentMarkers.has(String(id));
    const shouldTemplateOwnName =
      !isPmMarker &&
      !isLocked &&
      markerMode !== 'shot' &&
      (!currentShotName || currentShotName === fullName || __smLooksLikePlateName(currentShotName));

    // Live-mirror into layer header input only while template/plate mode owns the marker name.
    try {
      const shotInp = containerEl.closest?.('.pm-layer-row')?.querySelector('.pm-layer-shot');
      if (shotInp && shouldTemplateOwnName) shotInp.value = fullName;
    } catch {}

    // Apply template name to marker + pull list only while template/plate mode owns the marker name.
    // Skip when called from inside _pmRenderInspector — the deferred re-render
    // scheduled by _pmCommitShotNameChange will sync the name after the render.
    if (shouldTemplateOwnName && fullName && m.shotName !== fullName && !window.__pmRenderingInspector) {
      m._pmNameMode = 'plate';
      m.shotName = fullName;
      try { window.__smMarkDirtyFromPopup?.(); }     catch {}
      try { window.__smRenderFromPopup?.(); }         catch {}
      try { window.__pmApplyShotName?.(String(id), fullName); } catch {}
    }

    const chipsHtml = active.map(tok => {
      const raw  = _ntTokDisplayVal(tok, mid);
      const disp = raw || `(${tok.ph})`;
      let chipCls = tok.special===true ? ' pm-nt-chip-shot' : tok.special==='plate' ? ' pm-nt-chip-plate' : '';
      if(tok.special === 'ocr') chipCls = ` pm-nt-chip-ocr pm-nt-chip-ocr--${_ntOcrStatus(mid)}`;
      return `<span class="pm-nt-chip${chipCls}" data-tok="${tok.key}" draggable="true">` +
        `<span class="pm-nt-chip-lbl">${tok.label}</span>` +
        `<span class="pm-nt-chip-colon">:</span>` +
        `<span class="pm-nt-chip-val" data-edit="${tok.key}">${escapeHTML(disp)}</span>` +
        (tok.special===true ? '' : `<button class="pm-nt-chip-rm" data-rm="${tok.key}">×</button>`) +
        `</span>`;
    }).join('');

    const ghostsHtml = inactive.map(t => {
      let dimCls = t.special===true ? ' pm-nt-chip-shot' : t.special==='plate' ? ' pm-nt-chip-plate' : '';
      if(t.special === 'ocr') dimCls = ' pm-nt-chip-ocr pm-nt-chip-ocr--empty';
      return `<span class="pm-nt-chip pm-nt-chip--dim${dimCls}" data-tok="${t.key}" title="Click to show ${t.label}">${escapeHTML(t.label)}</span>`;
    }).join('');

    bar.className = `pm-nt-bar pm-nt-bar-static pm-nt-bar--mode-${displayMode}`;
    bar.innerHTML = `<span class="pm-nt-chips-row">${chipsHtml}${ghostsHtml}</span>`;

    wireBar();
  };

  // These tokens open a floating popup instead of editing inline in the chip
  const _POPUP_KEYS = new Set(['ep', 'seq', 'scene', 'ver']);

  const wireBar = () => {
    const mid = String(id);

    bar.querySelectorAll('[data-rm]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const tok = _NT_TOKENS.find(t => t.key===btn.dataset.rm);
        if(tok) {
          const s = _ntReadMibarSettings();
          _ntWriteMibarSettings({ ...s, visible: { ...s.visible, [tok.key]: false } });
          if(tok.lsOn) localStorage.setItem(tok.lsOn, '0');
          // Clear per-marker template value so it is excluded from shot name
          const rmMk = _ntCurrentMarkers.get(mid);
          if(rmMk?.template) rmMk.template[tok.key] = '';
        }
        renderBar();
        _ntApplyShotNameToMarker(mid, _ntComputeShotName(mid));
      });
    });

    // Dim chips (inactive) — click to re-enable
    bar.querySelectorAll('.pm-nt-chip--dim').forEach(chip => {
      chip.addEventListener('click', e => {
        e.stopPropagation();
        const tok = _NT_TOKENS.find(t => t.key===chip.dataset.tok);
        if(tok) {
          const s = _ntReadMibarSettings();
          _ntWriteMibarSettings({ ...s, visible: { ...s.visible, [tok.key]: true } });
          if(tok.lsOn) localStorage.setItem(tok.lsOn, '1');
          // Pre-populate marker template value from localStorage or placeholder
          const addMk = _ntCurrentMarkers.get(mid);
          if(addMk) {
            if(!addMk.template) addMk.template = {};
            if(!addMk.template[tok.key] && tok.lsVal) {
              addMk.template[tok.key] = localStorage.getItem(tok.lsVal) || tok.ph || '';
            }
          }
        }
        renderBar();
        _ntApplyShotNameToMarker(mid, _ntComputeShotName(mid));
      });
    });

    // Drag-and-drop chip reorder
    let _dragKey = null;
    bar.querySelectorAll('.pm-nt-chip[draggable]').forEach(chip => {
      chip.addEventListener('dragstart', e => {
        _dragKey = chip.dataset.tok;
        e.dataTransfer.effectAllowed = 'move';
      });
      chip.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        chip.classList.add('pm-nt-chip--dragover');
      });
      chip.addEventListener('dragleave', () => chip.classList.remove('pm-nt-chip--dragover'));
      chip.addEventListener('drop', e => {
        e.preventDefault();
        chip.classList.remove('pm-nt-chip--dragover');
        const toKey = chip.dataset.tok;
        if(!_dragKey || _dragKey === toKey) return;
        const s = _ntReadMibarSettings();
        const order = [...s.order];
        _MIBAR_DEFAULT_ORDER.forEach(k => { if(!order.includes(k)) order.push(k); });
        const fI = order.indexOf(_dragKey), tI = order.indexOf(toKey);
        if(fI >= 0 && tI >= 0){ order.splice(fI, 1); order.splice(tI, 0, _dragKey); }
        _ntWriteMibarSettings({ ...s, order });
        _dragKey = null;
        renderBar();
      });
    });

    // OCR chip: left-click → run OCR; right-click → context menu
    const ocrChip = bar.querySelector('.pm-nt-chip-ocr');
    if(ocrChip){
      ocrChip.querySelector('.pm-nt-chip-val')?.addEventListener('click', e => {
        e.stopPropagation();
        try{ window.__pmRunOcrForChip?.(mid); }catch{}
      });
      ocrChip.addEventListener('contextmenu', e => {
        e.preventDefault(); e.stopPropagation();
        _ntShowOcrContextMenu(e, mid, renderBar);
      });
    }

    bar.querySelectorAll('[data-edit]').forEach(span => {
      span.addEventListener('click', e => {
        e.stopPropagation();
        const tok = _NT_TOKENS.find(t => t.key===span.dataset.edit);
        if(!tok) return;
        if(tok.special === 'ocr'){
          try{ window.__pmRunOcrForChip?.(mid); }catch{}
          return;
        }
        if(tok.special === 'plate'){
          _ntPlatePanel(span.closest('.pm-nt-chip'), () => {
            const pmMk = _ntCurrentMarkers.get(mid);
            if(pmMk) {
              const code = String(localStorage.getItem(_NT.plateCode)||'').trim();
              const num  = String(localStorage.getItem(_NT.plateNum)||'01').trim();
              if(code) {
                if(!pmMk.template) pmMk.template = {};
                pmMk.template.plate = code + String(num||'01').padStart(2,'0');
                try{ window.__pmPushShotNameNow?.(mid); }catch{}
                try{ window.__pmSaveAfterOcrUpdate?.(mid); }catch{}
              }
            }
            renderBar();
            _ntApplyShotNameToMarker(mid, _ntComputeShotName(mid));
          });
          return;
        }
        if(tok.special){
          _ntShotNumPanel(span.closest('.pm-nt-chip'), () => {
            const pmMk = _ntCurrentMarkers.get(mid);
            if(pmMk) {
              const c2   = __smReadNamingTemplateSettings();
              const padOn = localStorage.getItem(_NT.padOn) !== '0';
              const padW  = padOn ? Math.max(2, Math.min(6, parseInt(c2.pad,10)||3)) : 1;
              if(!pmMk.template) pmMk.template = {};
              pmMk.template.shot = String(c2.start).padStart(padW, '0');
              try{ window.__pmPushShotNameNow?.(mid); }catch{}
              try{ window.__pmSaveAfterOcrUpdate?.(mid); }catch{}
            }
            renderBar();
            _ntApplyShotNameToMarker(mid, _ntComputeShotName(mid));
          });
          return;
        }
        // EP / SEQ / SCENE / VER# → floating popup dropdown
        if(_POPUP_KEYS.has(tok.key)){
          _ntChipPopup(tok, span.closest('.pm-nt-chip'), () => {
            const pmMk = _ntCurrentMarkers.get(mid);
            if(pmMk && tok.lsVal) {
              const newVal = localStorage.getItem(tok.lsVal) || '';
              if(newVal) {
                if(!pmMk.template) pmMk.template = {};
                pmMk.template[tok.key] = newVal;
                try{ window.__pmPushShotNameNow?.(mid); }catch{}
                try{ window.__pmSaveAfterOcrUpdate?.(mid); }catch{}
              }
            }
            renderBar();
            _ntApplyShotNameToMarker(mid, _ntComputeShotName(mid));
          });
          return;
        }
        // Other tokens (show, vendor) → inline edit in chip
        const pmMk = _ntCurrentMarkers.get(mid);
        const cur = pmMk?.template?.[tok.key] || localStorage.getItem(tok.lsVal) || '';
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'pm-nt-chip-inp';
        inp.value = cur;
        inp.placeholder = tok.ph;
        inp.style.width = Math.max(32, Math.min(120, cur.length*9+20))+'px';
        span.replaceWith(inp);
        inp.focus(); inp.select();
        const commit = () => {
          if(pmMk) {
            if(!pmMk.template) pmMk.template = {};
            pmMk.template[tok.key] = inp.value.trim();
            try{ window.__pmPushShotNameNow?.(mid); }catch{}
            try{ window.__pmSaveAfterOcrUpdate?.(mid); }catch{}
          } else {
            if(tok.lsVal) localStorage.setItem(tok.lsVal, inp.value.trim());
          }
          renderBar();
          _ntApplyShotNameToMarker(mid, _ntComputeShotName(mid));
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', e2 => {
          if(e2.key==='Enter') { e2.preventDefault(); commit(); }
          if(e2.key==='Escape'){ e2.preventDefault(); renderBar(); }
          e2.stopPropagation();
        });
      });
    });

  };

  // Must be assigned AFTER renderBar is defined (const TDZ)
  bar._ntRenderBar = renderBar;
  renderBar();
  // Apply shot name immediately on bar open so header reflects current chip values.
  // Skip when mounted from inside _pmRenderInspector — the guard in
  // _pmAutoNameFromTemplate already blocks the call, but skipping here is
  // belt-and-suspenders and avoids the redundant work of computing a name that
  // will be discarded.  The deferred re-render scheduled by _pmCommitShotNameChange
  // will refresh the bar once the current render cycle is complete.
  if (_ntCurrentMarkers.has(String(id)) && !window.__pmRenderingInspector) {
    _ntApplyShotNameToMarker(String(id), _ntComputeShotName(String(id)));
    try { window.__pmAutoNameFromTemplate?.(String(id), { silent: true }); } catch {}
  }
}

try{ window.__smOpenNamingTemplateStatic = openNamingTemplateStatic; }catch{}

// Refresh all rendered static bars for a given marker (call after OCR data changes)
try{
  window.__ntRefreshMarkerBar = (markerId) => {
    const mid = String(markerId || '');
    document.querySelectorAll(`.pm-nt-bar[data-marker-id="${mid}"], .pm-nt-bar[data-markerId="${mid}"]`).forEach(bar => {
      const refreshFn = bar._ntRenderBar;
      if(typeof refreshFn === 'function') try{ refreshFn(); }catch{}
    });
  };
}catch{}

// Expose markerInfoBarSettings read/write for project settings sync
try{ window.__ntReadMibarSettings  = _ntReadMibarSettings;  }catch{}
try{ window.__ntWriteMibarSettings = _ntWriteMibarSettings; }catch{}

// Returns current chip display values for a marker — ACTIVE chips only.
// Inactive (dim) chips are excluded so they don't bleed into the shot name.
// Keys match marker.template keys; OCR text is under key 'ocr'.
try{ window.__ntGetMarkerDisplayValues = (markerId) => {
  const mid = String(markerId || '');
  const result = {};
  for (const tok of _NT_TOKENS) {
    if (!_ntTokIsOn(tok, mid)) continue;  // skip dim/inactive chips
    const v = _ntTokDisplayVal(tok, mid);
    if (v && v !== 'Not Set') result[tok.key] = v;
  }
  return result;
}; }catch{}

// Clear project-specific naming values (SHOW, EP, SEQ, SCENE, TASK, VENDOR, VER).
// Toggle on/off states and counter settings (start, step, pad) are preserved
// since they are user preferences rather than per-project data.
try{ window.__ntResetProjectValues = () => {
  const valuesToClear = [
    _NT.show, _NT.sq, _NT.seq, _NT.scene,
    _NT.task, _NT.vendor, _NT.ver,
    _NT.plateCode, _NT.plateNum,
  ];
  for (const key of valuesToClear) {
    try { localStorage.removeItem(key); } catch {}
  }
  // Clear registered marker cache so shot-name fallback parsing can't
  // surface values (e.g. SHOW "STB") from the previous project's markers.
  _ntCurrentMarkers.clear();
  // Reset shot counter to default start value.
  try { window.__smShotCounter = parseInt(localStorage.getItem(_NT.start) || '10', 10) || 10; } catch {}
  // Re-render the static naming bar if it's open so the cleared values show.
  try { window.__smOpenNamingTemplateStatic?.(); } catch {}
}; }catch{}

})();
