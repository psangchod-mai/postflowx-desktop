// Burn-in Setup Modal (PostFlowX)
// - Per-project preset (stored in localStorage; persisted via settings shard)
// - User draws ROIs on a captured frame and validates via OCR preview

const KEY_CFG = 'pfx.burnin.config.v1';

// Default OCF regex:
// - Match common camera-original filenames WITH extension
// - Also match DJI burn-in identifiers even when extension is missing in the ROI/OCR output
//   (e.g. "DJI_20250719191357_0035_D" or "DJI_20250719T191357_0035")
const DEFAULT_OCF_REGEX_OLD = "\\b[\\w.-]+\\.(mxf|mov|mp4)\\b";
const DEFAULT_OCF_REGEX = "\\b(?:DJI[_-]\\d{8}(?:T?\\d{6})?(?:[_-]\\d{4})?(?:[_-][A-Za-z])?(?:\\.(?:mxf|mov|mp4))?|[\\w.-]+\\.(?:mxf|mov|mp4))\\b";

function TT(s){
  try{ if (typeof window.PFX_t === 'function') return window.PFX_t(String(s||'')); }catch{}
  return String(s||'');
}

function escapeHtml(s){
  return String(s || '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}

function clamp01(v){
  v = Number(v);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function deepClone(obj){
  try{ return JSON.parse(JSON.stringify(obj)); }catch{ return obj; }
}

function defaultConfig(){
  return {
    activePresetId: 'default',
    presets: {
      default: {
        name: 'Default',
        fields: {
          src_tc: {
            label: 'SRC TC',
            enabled: true,
            roi: null,
            regex: "\\b\\d{2}:\\d{2}:\\d{2}:\\d{2}\\b",
            ocr: { psm: 7, whitelist: '0123456789:' }
          },
          ocf: {
            label: 'OCF',
            enabled: true,
            roi: null,
            regex: DEFAULT_OCF_REGEX,
            ocr: { psm: 7, whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_./-' }
          }
        }
      }
    }
  };
}

export function PFX_loadBurninConfig(){
  try{
    const raw = localStorage.getItem(KEY_CFG);
    if (!raw) return defaultConfig();
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return defaultConfig();
    if (!obj.presets || typeof obj.presets !== 'object') return defaultConfig();
    if (!obj.activePresetId || !obj.presets[obj.activePresetId]){
      const first = Object.keys(obj.presets)[0] || 'default';
      obj.activePresetId = first;
    }
    // Ensure defaults exist
    if (!obj.presets.default) obj.presets.default = defaultConfig().presets.default;

    // Gentle migration: upgrade the default OCF regex only if it hasn't been customized.
    try{
      for (const p of Object.values(obj.presets || {})){
        const f = p?.fields?.ocf;
        if (!f || typeof f !== 'object') continue;
        const rx = String(f.regex || '').trim();
        if (!rx || rx === DEFAULT_OCF_REGEX_OLD) f.regex = DEFAULT_OCF_REGEX;
      }
    }catch{}
    return obj;
  }catch{
    return defaultConfig();
  }
}

export function PFX_saveBurninConfig(cfg){
  try{
    localStorage.setItem(KEY_CFG, JSON.stringify(cfg || defaultConfig()));
    try{ window.dispatchEvent(new CustomEvent('pfx:burnin-updated', { detail: { config: cfg || null } })); }catch{}
    try{ window.MPS_markProjectDirty?.('burnin setup'); }catch{}
    return true;
  }catch{ return false; }
}

export function PFX_getActiveBurninPreset(){
  const cfg = PFX_loadBurninConfig();
  const id = cfg?.activePresetId;
  const p = (id && cfg?.presets?.[id]) ? cfg.presets[id] : null;
  return { cfg, presetId: id, preset: p };
}

// Resolve the *effective* burn-in preset for a specific clip.
// - If clip has a per-clip override, use it.
// - Else if clip requests a specific project preset, use that.
// - Else fall back to the project's active preset.
export function PFX_getBurninPresetForClip(clip){
  const { cfg, presetId, preset } = PFX_getActiveBurninPreset();
  const c = (clip && typeof clip === 'object') ? clip : null;
  const ov = c?.burninOverride;
  if (ov && typeof ov === 'object' && ov.preset && typeof ov.preset === 'object'){
    return { cfg, presetId: ov.presetId || presetId, preset: ov.preset, isOverride: true };
  }
  const reqId = String(c?.burninPresetId || '').trim();
  if (reqId && cfg?.presets?.[reqId]){
    return { cfg, presetId: reqId, preset: cfg.presets[reqId], isOverride: false, isClipPreset: true };
  }
  return { cfg, presetId, preset, isOverride: false };
}

// Expose helpers globally (used by other features like Visual QC)
try{ window.PFX_loadBurninConfig = PFX_loadBurninConfig; }catch{}
try{ window.PFX_getActiveBurninPreset = PFX_getActiveBurninPreset; }catch{}
try{ window.PFX_getBurninPresetForClip = PFX_getBurninPresetForClip; }catch{}

// ---------------- OCR Client (worker) ----------------
let __ocrClient = null;
function getOcrClient(){
  if (__ocrClient) return __ocrClient;

  const workerUrl = chrome?.runtime?.getURL
    ? chrome.runtime.getURL('scripts/ocr_burnin_worker.js')
    : 'scripts/ocr_burnin_worker.js';

  const worker = new Worker(workerUrl);
  let seq = 0;
  const pending = new Map();

  const rejectAll = (err) => {
    try{
      for (const [id, p] of pending.entries()){
        try{ p.reject(err); }catch{}
      }
      pending.clear();
    }catch{}
  };

  worker.onmessage = (ev) => {
    const msg = ev.data || {};
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || 'OCR worker error'));
  };

  worker.onerror = (e) => {
    console.warn('Burn-in OCR worker error', e);
    rejectAll(new Error('OCR worker crashed'));
    __ocrClient = null;
  };

  __ocrClient = {
    async recognize(imageData, opts={}){
      const id = `ocr_${Date.now()}_${++seq}`;
      const rgba = new Uint8Array(imageData.data); // copy
      const payload = {
        id,
        type: 'recognize',
        image: { buffer: rgba.buffer, width: imageData.width, height: imageData.height },
        psm: (Number.isFinite(opts?.psm) ? Number(opts.psm) : undefined),
        whitelist: (typeof opts?.whitelist === 'string' ? opts.whitelist : undefined)
      };
      const p = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      worker.postMessage(payload, [rgba.buffer]);
      const res = await Promise.race([
        p,
        new Promise((_, rej)=> setTimeout(()=> rej(new Error('OCR timeout')), 25_000))
      ]);
      return String(res.text || '').trim();
    }
  };

  return __ocrClient;
}

// ---------------- Image helpers ----------------
function drawImgToCanvas(img){
  const c = document.createElement('canvas');
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  return c;
}

function cropImageData(srcCanvas, roiNorm, maxSide=1600){
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  if (!sw || !sh) return null;
  const rx = clamp01(roiNorm.x);
  const ry = clamp01(roiNorm.y);
  const rw = clamp01(roiNorm.w);
  const rh = clamp01(roiNorm.h);
  const x = Math.round(rx * sw);
  const y = Math.round(ry * sh);
  const w = Math.max(2, Math.round(rw * sw));
  const h = Math.max(2, Math.round(rh * sh));

  const sx = Math.max(0, Math.min(sw-2, x));
  const sy = Math.max(0, Math.min(sh-2, y));
  const ex = Math.max(sx+2, Math.min(sw, sx+w));
  const ey = Math.max(sy+2, Math.min(sh, sy+h));
  const cw = ex - sx;
  const ch = ey - sy;

  // scale up small strips for OCR
  let outW = cw, outH = ch;
  const maxDim = Math.max(cw, ch);
  if (maxDim < maxSide){
    const scale = Math.min(3.0, maxSide / Math.max(1, maxDim));
    outW = Math.round(cw * scale);
    outH = Math.round(ch * scale);
  }

  const tmp = document.createElement('canvas');
  tmp.width = Math.max(2, outW);
  tmp.height = Math.max(2, outH);
  const g = tmp.getContext('2d');
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(srcCanvas, sx, sy, cw, ch, 0, 0, outW, outH);

  return g.getImageData(0, 0, outW, outH);
}

function meanLuma(imageData){
  const d = imageData?.data;
  if (!d || !d.length) return 0;
  let s = 0;
  const n = d.length / 4;
  for (let i=0;i<d.length;i+=4){
    // Rec. 709
    s += (0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]);
  }
  return s / Math.max(1, n);
}

function preprocessForOcr(img){
  if (!img) return null;
  const d = img.data;
  if (!d) return img;

  // grayscale
  for (let i=0;i<d.length;i+=4){
    const y = (0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2]);
    d[i] = d[i+1] = d[i+2] = y;
  }

  // Otsu threshold
  const hist = new Uint32Array(256);
  for (let i=0;i<d.length;i+=4){ hist[d[i] | 0]++; }
  const total = d.length / 4;
  let sum = 0;
  for (let t=0;t<256;t++) sum += t * hist[t];
  let sumB = 0, wB = 0, wF = 0;
  let varMax = 0;
  let threshold = 140;
  for (let t=0;t<256;t++){
    wB += hist[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > varMax){ varMax = v; threshold = t; }
  }

  let white = 0, black = 0;
  for (let i=0;i<d.length;i+=4){
    const v = (d[i] > threshold) ? 255 : 0;
    d[i] = d[i+1] = d[i+2] = v;
    if (v === 255) white++; else black++;
  }

  // Tesseract likes black text on white background.
  // If background seems dark (more black pixels), invert so background becomes white.
  if (black > white){
    for (let i=0;i<d.length;i+=4){
      const v = d[i] === 255 ? 0 : 255;
      d[i] = d[i+1] = d[i+2] = v;
    }
  }

  // If very dark source, a light dilation-ish pass (thicken) helps
  const luma = meanLuma(img);
  if (luma < 55){
    // Simple 1px max filter on luminance channel
    const w = img.width, h = img.height;
    const copy = new Uint8ClampedArray(d);
    const idx = (x,y)=> (y*w + x) * 4;
    for (let y=1;y<h-1;y++){
      for (let x=1;x<w-1;x++){
        let mx = 0;
        for (let oy=-1;oy<=1;oy++){
          for (let ox=-1;ox<=1;ox++){
            const ii = idx(x+ox, y+oy);
            mx = Math.max(mx, copy[ii]);
          }
        }
        const i0 = idx(x,y);
        d[i0] = d[i0+1] = d[i0+2] = mx;
      }
    }
  }

  return img;
}

function parseByRegex(text, regexStr){
  const t = String(text || '').replace(/\r/g,' ').replace(/\n+/g,' ').trim();
  if (!regexStr) return '';
  try{
    const re = new RegExp(regexStr, 'i');
    const m = t.match(re);
    if (!m) return '';
    return String(m[0] || '').trim();
  }catch{
    return '';
  }
}

async function captureActiveVideoFrame(){
  const pane = document.querySelector('.main-pane.active') || document.body;
  const vids = Array.from(pane.querySelectorAll('video'));
  const vis = vids
    .filter(v => v && v.videoWidth > 0 && v.videoHeight > 0)
    .map(v => ({ v, r: v.getBoundingClientRect() }))
    .filter(o => o.r.width > 10 && o.r.height > 10)
    .sort((a,b)=> (b.r.width*b.r.height) - (a.r.width*a.r.height));

  const v = vis[0]?.v || null;
  if (!v) return null;

  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  const g = c.getContext('2d');
  g.drawImage(v, 0, 0);
  const dataUrl = c.toDataURL('image/png');
  return { dataUrl, width: c.width, height: c.height };
}

function ensurePresetIntegrity(cfg){
  const out = cfg && typeof cfg === 'object' ? cfg : defaultConfig();
  out.presets = (out.presets && typeof out.presets === 'object') ? out.presets : defaultConfig().presets;
  if (!out.activePresetId || !out.presets[out.activePresetId]){
    out.activePresetId = Object.keys(out.presets)[0] || 'default';
  }
  const p = out.presets[out.activePresetId];
  if (!p || !p.fields || typeof p.fields !== 'object'){
    if (!p) out.presets[out.activePresetId] = deepClone(defaultConfig().presets.default);
    else p.fields = {};
  }
  const _p = out.presets[out.activePresetId];
  if (!p.fields.src_tc) p.fields.src_tc = defaultConfig().presets.default.fields.src_tc;
  if (!p.fields.ocf) p.fields.ocf = defaultConfig().presets.default.fields.ocf;
  return out;
}

function nextPresetId(cfg){
  const base = 'preset_';
  let i = 1;
  while (cfg.presets[base + i]) i++;
  return base + i;
}

// ── Camera brand presets ──────────────────────────────────────────────────
// Pre-configured ROI layouts for common cinema cameras.
// ROIs are normalised (0–1). These are starting points; users should fine-tune
// after loading a preset because exact burn-in positions vary by project/LUT.
const CAMERA_PRESETS = [
  {
    id: 'arri_alexa',
    name: 'ARRI ALEXA',
    fields: {
      src_tc: { label: 'Timecode', enabled: true,
        roi: { x:0.008, y:0.908, w:0.220, h:0.068 },
        regex: '(\\d{2}[:;]\\d{2}[:;]\\d{2}[:;]\\d{2})',
        ocr: { psm:7, whitelist:'0123456789:;' } },
      ocf:    { label: 'Clip Name', enabled: true,
        roi: { x:0.310, y:0.908, w:0.380, h:0.068 },
        regex: '',
        ocr: { psm:7, whitelist:'' } }
    }
  },
  {
    id: 'red_dsmc2',
    name: 'RED DSMC2 / V-RAPTOR',
    fields: {
      src_tc: { label: 'Timecode', enabled: true,
        roi: { x:0.008, y:0.015, w:0.220, h:0.065 },
        regex: '(\\d{2}[:;]\\d{2}[:;]\\d{2}[:;]\\d{2})',
        ocr: { psm:7, whitelist:'0123456789:;' } },
      ocf:    { label: 'Reel/Clip', enabled: true,
        roi: { x:0.310, y:0.908, w:0.380, h:0.065 },
        regex: '',
        ocr: { psm:7, whitelist:'' } }
    }
  },
  {
    id: 'sony_venice',
    name: 'Sony Venice / FX9',
    fields: {
      src_tc: { label: 'Timecode', enabled: true,
        roi: { x:0.008, y:0.915, w:0.220, h:0.065 },
        regex: '(\\d{2}[:;]\\d{2}[:;]\\d{2}[:;]\\d{2})',
        ocr: { psm:7, whitelist:'0123456789:;' } },
      ocf:    { label: 'Clip Name', enabled: true,
        roi: { x:0.310, y:0.915, w:0.380, h:0.065 },
        regex: '',
        ocr: { psm:7, whitelist:'' } }
    }
  },
  {
    id: 'blackmagic',
    name: 'Blackmagic Ursa / Pocket',
    fields: {
      src_tc: { label: 'Timecode', enabled: true,
        roi: { x:0.008, y:0.904, w:0.220, h:0.070 },
        regex: '(\\d{2}[:;]\\d{2}[:;]\\d{2}[:;]\\d{2})',
        ocr: { psm:7, whitelist:'0123456789:;' } },
      ocf:    { label: 'Clip Name', enabled: true,
        roi: { x:0.560, y:0.904, w:0.310, h:0.070 },
        regex: '',
        ocr: { psm:7, whitelist:'' } }
    }
  },
  {
    id: 'dji_pro',
    name: 'DJI (Inspire / Zenmuse)',
    fields: {
      src_tc: { label: 'Timecode', enabled: true,
        roi: { x:0.008, y:0.908, w:0.220, h:0.068 },
        regex: '(\\d{2}[:;]\\d{2}[:;]\\d{2}[:;]\\d{2})',
        ocr: { psm:7, whitelist:'0123456789:;' } },
      ocf:    { label: 'Filename', enabled: true,
        roi: { x:0.610, y:0.908, w:0.380, h:0.068 },
        regex: '',
        ocr: { psm:7, whitelist:'' } }
    }
  },
  {
    id: 'canon_cinema',
    name: 'Canon Cinema EOS',
    fields: {
      src_tc: { label: 'Timecode', enabled: true,
        roi: { x:0.008, y:0.908, w:0.220, h:0.068 },
        regex: '(\\d{2}[:;]\\d{2}[:;]\\d{2}[:;]\\d{2})',
        ocr: { psm:7, whitelist:'0123456789:;' } },
      ocf:    { label: 'Clip Name', enabled: true,
        roi: { x:0.310, y:0.908, w:0.380, h:0.068 },
        regex: '',
        ocr: { psm:7, whitelist:'' } }
    }
  }
];

export async function openBurninSetupModal(options = {}){
  const isClipMode = (String(options?.scope || options?.mode || '').toLowerCase() === 'clip') || !!options?.clipId || !!options?.clip;
  const clipCtx = (()=>{
    if (!isClipMode) return null;
    const c = options?.clip && typeof options.clip === 'object' ? options.clip : null;
    const id = String(c?.id || options?.clipId || '').trim();
    const name = String(c?.name || options?.clipName || '').trim();
    return { id, name };
  })();

  const getOverride = (()=>{
    const fn = options?.getOverride || options?.getClipOverride;
    return (typeof fn === 'function') ? fn : null;
  })();
  const applyOverride = (()=>{
    const fn = options?.applyOverride || options?.onSaveClipOverride || options?.setClipOverride;
    return (typeof fn === 'function') ? fn : null;
  })();

  // Pause any playing videos (user request: when opening tools, video stops)
  try{
    const pane = document.querySelector('.main-pane.active') || document.body;
    for (const v of Array.from(pane.querySelectorAll('video'))){
      try{ if (!v.paused) v.pause(); }catch{}
    }
  }catch{}

  const cap = await captureActiveVideoFrame();
  if (!cap?.dataUrl){
    try{ window.showError?.(TT('No video loaded. Open a video first.')); }catch{}
    return;
  }

  let cfg = ensurePresetIntegrity(PFX_loadBurninConfig());
  let activePresetId = cfg.activePresetId;

  // Clip override loads a *local* preset draft (does not mutate project presets).
  let preset = null;
  const existingOv = isClipMode ? (getOverride ? (()=>{ try{ return getOverride(); }catch{ return null; } })() : null) : null;
  if (isClipMode && existingOv && typeof existingOv === 'object' && existingOv.preset && typeof existingOv.preset === 'object'){
    activePresetId = String(existingOv.presetId || activePresetId || cfg.activePresetId || 'default');
    preset = deepClone(existingOv.preset);
  }else{
    preset = deepClone(cfg.presets[activePresetId]);
  }

  // UI state
  let activeFieldKey = 'src_tc';
  let drawing = false;
  let dragMode = null; // 'draw' | 'move' | 'nw' | 'ne' | 'sw' | 'se'
  let dragStart = null;
  let ocrTimer = 0;
  const ocrCache = Object.create(null);

  const backdrop = document.createElement('div');
  backdrop.className = 'mps-modal-backdrop';
  const modal = document.createElement('div');
  modal.className = 'mps-modal pfx-burnin-modal';
  backdrop.appendChild(modal);

  const head = document.createElement('div');
  head.className = 'mps-modal-head pfx-burnin-head';
  const scopeLabel = isClipMode
    ? `${TT('Scope')}: ${TT('This Clip')} ${clipCtx?.name ? '— ' + clipCtx.name : ''}`
    : `${TT('Scope')}: ${TT('Project Preset')}`;
  const presetLabel = isClipMode ? TT('Base') : TT('Preset');
  const doneLabel = isClipMode ? TT('Save') : TT('Done');
  head.innerHTML = `
    <div class="pfx-burnin-headL">
      <div class="pfx-burnin-title">${escapeHtml(TT('Burn-in Setup'))}</div>
      <div class="pfx-burnin-sub">${escapeHtml(scopeLabel)}</div>
    </div>
    <div class="pfx-burnin-headR">
      <label class="pfx-burnin-ctl" title="${escapeHtml(TT('Preset'))}">
        <span class="k">${escapeHtml(presetLabel)}</span>
        <select class="pfx-burnin-preset"></select>
      </label>
      ${isClipMode ? '' : `<button class="btn mini pfx-burnin-btn" data-act="new" title="${escapeHtml(TT('New preset'))}">${escapeHtml(TT('New'))}</button>`}
      ${isClipMode ? '' : `<button class="btn mini pfx-burnin-btn" data-act="dup" title="${escapeHtml(TT('Duplicate preset'))}">${escapeHtml(TT('Duplicate'))}</button>`}
      ${isClipMode ? '' : `<button class="btn mini pfx-burnin-btn" data-act="del" title="${escapeHtml(TT('Delete preset'))}">${escapeHtml(TT('Delete'))}</button>`}
      <span class="pfx-burnin-sp"></span>
      <div class="pfx-burnin-camWrap">
        <button class="btn mini pfx-burnin-btn" data-act="camPreset" title="${escapeHtml(TT('Load camera burn-in preset'))}">Camera ▾</button>
        <div class="pfx-burnin-camMenu" hidden>
          ${CAMERA_PRESETS.map(cp => `<button class="pfx-burnin-camItem" data-cam="${escapeHtml(cp.id)}">${escapeHtml(cp.name)}</button>`).join('')}
        </div>
      </div>
      <button class="btn mini pfx-burnin-btn" data-act="autoDetect" title="${escapeHtml(TT('Auto-detect burn-in regions from current frame'))}">Auto-detect</button>
      <button class="btn mini pfx-burnin-btn" data-act="testFrames" title="${escapeHtml(TT('Test OCR accuracy across multiple frames'))}">Test Frames</button>
      <button class="btn mini pfx-burnin-btn" data-act="recap" title="${escapeHtml(TT('Capture current frame again'))}">${escapeHtml(TT('Recapture'))}</button>
      ${isClipMode ? `<button class="btn mini pfx-burnin-btn" data-act="clearOverride" title="${escapeHtml(TT('Remove this clip override and fall back to project preset'))}">${escapeHtml(TT('Clear Override'))}</button>` : ''}
      <button class="btn mini pfx-burnin-cancel" data-act="cancel">${escapeHtml(TT('Cancel'))}</button>
      <button class="btn mini theme-q2 pfx-burnin-done" data-act="done">${escapeHtml(doneLabel)}</button>
    </div>
  `;
  modal.appendChild(head);

  const body = document.createElement('div');
  body.className = 'mps-modal-body pfx-burnin-body';
  body.innerHTML = `
    <div class="pfx-burnin-stage">
      <div class="pfx-burnin-canvasWrap">
        <img class="pfx-burnin-img" src="${cap.dataUrl}" alt="">
        <div class="pfx-burnin-overlay" tabindex="0" aria-label="Burn-in ROI overlay">
          <div class="pfx-roi-box" style="display:none;">
            <i class="h nw" data-h="nw"></i><i class="h ne" data-h="ne"></i>
            <i class="h sw" data-h="sw"></i><i class="h se" data-h="se"></i>
            <div class="pfx-burnin-liveOcr" hidden></div>
          </div>
        </div>
      </div>
      <div class="pfx-burnin-help">
        <div class="k">${escapeHtml(TT('Tips'))}</div>
        <div class="v">
          • ${escapeHtml(TT('Click a field on the right, then drag on the frame to draw ROI.'))}<br>
          • ${escapeHtml(TT('Drag the box to move. Drag corners to resize.'))}<br>
          • ${escapeHtml(TT('Use Recapture on a night/day frame to validate OCR robustness.'))}
        </div>
      </div>
    </div>
    <div class="pfx-burnin-side">
      <div class="pfx-burnin-fields"></div>
      <div class="pfx-burnin-sideFoot">
        <button class="btn mini pfx-burnin-add" data-act="addField">${escapeHtml(TT('+ Field'))}</button>
      </div>
    </div>
  `;
  modal.appendChild(body);

  document.body.appendChild(backdrop);

  const imgEl = body.querySelector('.pfx-burnin-img');
  const overlay = body.querySelector('.pfx-burnin-overlay');
  const roiBox = body.querySelector('.pfx-roi-box');
  const liveOcrEl = roiBox?.querySelector('.pfx-burnin-liveOcr') ?? null;
  const presetSel = head.querySelector('.pfx-burnin-preset');
  const fieldsWrap = body.querySelector('.pfx-burnin-fields');

  imgEl.addEventListener('load', () => {
    try{ setRoiBoxFromField(); }catch{}
  });

  // Esc handler is bound later; keep a ref so close() can clean up.
  let __onKey = null;
  let __onResize = null;
  const close = () => {
    try{ if (__onKey) window.removeEventListener('keydown', __onKey, { capture:true }); }catch{}
    try{ if (__onResize) window.removeEventListener('resize', __onResize); }catch{}
    try{ document.body.removeChild(backdrop); }catch{}
    clearTimeout(ocrTimer);
  };

  const refreshPresetSelect = () => {
    presetSel.innerHTML = '';
    for (const [id,p] of Object.entries(cfg.presets || {})){
      const o = document.createElement('option');
      o.value = id;
      o.textContent = p?.name || id;
      if (id === activePresetId) o.selected = true;
      presetSel.appendChild(o);
    }
  };

  function ensureField(key){
    if (!preset.fields) preset.fields = {};
    if (!preset.fields[key]){
      preset.fields[key] = {
        label: key,
        enabled: true,
        roi: null,
        regex: '',
        ocr: { psm: 7, whitelist: '' }
      };
    }
  }

  function fieldKeys(){
    return Object.keys(preset.fields || {});
  }

  function getActiveField(){
    ensureField(activeFieldKey);
    return preset.fields[activeFieldKey];
  }

  function contentRect(){
    const r = overlay.getBoundingClientRect();
    const nw = imgEl?.naturalWidth || cap.width || 1920;
    const nh = imgEl?.naturalHeight || cap.height || 1080;
    const rw = Math.max(1, r.width);
    const rh = Math.max(1, r.height);
    const scale = Math.min(rw / Math.max(1,nw), rh / Math.max(1,nh));
    const cw = Math.max(1, nw * scale);
    const ch = Math.max(1, nh * scale);
    const ox = (rw - cw) / 2;
    const oy = (rh - ch) / 2;
    return { r, ox, oy, cw, ch };
  }

  function setRoiBoxFromField(){
    const f = getActiveField();
    const roi = f?.roi;
    if (!roi){
      roiBox.style.display = 'none';
      return;
    }
    const c = contentRect();
    roiBox.style.display = '';
    roiBox.style.left = `${c.ox + clamp01(roi.x) * c.cw}px`;
    roiBox.style.top = `${c.oy + clamp01(roi.y) * c.ch}px`;
    roiBox.style.width = `${Math.max(2, clamp01(roi.w) * c.cw)}px`;
    roiBox.style.height = `${Math.max(2, clamp01(roi.h) * c.ch)}px`;
    roiBox.setAttribute('data-field', activeFieldKey);
  }

  function renderFields(){
    const keys = fieldKeys();
    fieldsWrap.innerHTML = '';
    keys.forEach((k) => {
      const f = preset.fields[k] || {};
      const row = document.createElement('div');
      row.className = 'pfx-burnin-field' + (k === activeFieldKey ? ' is-active' : '');
      const roi = f.roi;
      const roiTxt = roi ? `${roi.x.toFixed(3)}, ${roi.y.toFixed(3)}, ${roi.w.toFixed(3)}, ${roi.h.toFixed(3)}` : '—';
      const ocrText = (ocrCache[k]?.ocr || '');
      const parsed = (ocrCache[k]?.parsed || '');
      const ok = !!parsed;

      row.innerHTML = `
        <div class="pfx-burnin-fieldTop">
          <button class="pfx-burnin-pick" data-act="pick" title="${escapeHtml(TT('Select this field for drawing'))}">${escapeHtml(f.label || k)}</button>
          <label class="pfx-burnin-en" title="${escapeHtml(TT('Enable'))}">
            <input type="checkbox" ${f.enabled!==false?'checked':''} data-act="en" />
            <span>${escapeHtml(TT('On'))}</span>
          </label>
          <button class="pfx-burnin-x" data-act="rm" title="${escapeHtml(TT('Remove field'))}">×</button>
        </div>
        <div class="pfx-burnin-fieldMid">
          <div class="pfx-burnin-k">ROI</div>
          <div class="pfx-burnin-v">${escapeHtml(roiTxt)}</div>
        </div>
        <div class="pfx-burnin-fieldMid">
          <div class="pfx-burnin-k">Regex</div>
          <input class="pfx-burnin-regex" data-act="regex" value="${escapeHtml(f.regex || '')}" placeholder="${escapeHtml(TT('Regex…'))}" />
        </div>
        <div class="pfx-burnin-ocr">
          <div class="pfx-burnin-ocrRow">
            <div class="pfx-burnin-k">OCR</div>
            <div class="pfx-burnin-ocrTxt">${escapeHtml(ocrText || '—')}</div>
          </div>
          <div class="pfx-burnin-ocrRow">
            <div class="pfx-burnin-k">Value</div>
            <div class="pfx-burnin-ocrVal ${ok?'ok':'bad'}">${escapeHtml(parsed || '—')}</div>
          </div>
        </div>
      `;

      const pickBtn = row.querySelector('[data-act="pick"]');
      const enCb = row.querySelector('[data-act="en"]');
      const rmBtn = row.querySelector('[data-act="rm"]');
      const rxInp = row.querySelector('[data-act="regex"]');

      pickBtn.addEventListener('click', () => {
        activeFieldKey = k;
        if (liveOcrEl) liveOcrEl.hidden = true;
        renderFields();
        setRoiBoxFromField();
        scheduleOcr(k);
      });
      pickBtn.addEventListener('dblclick', () => {
        try{
          const cur = String(f.label || k);
          const n = window.prompt(TT('Field name'), cur);
          if (n != null){
            f.label = String(n).trim() || cur;
            preset.fields[k] = f;
            renderFields();
          }
        }catch{}
      });
      enCb.addEventListener('change', () => {
        f.enabled = !!enCb.checked;
        preset.fields[k] = f;
      });
      rmBtn.addEventListener('click', () => {
        if (k === 'src_tc' || k === 'ocf'){
          // keep the core fields; just disable
          f.enabled = false;
          preset.fields[k] = f;
        } else {
          delete preset.fields[k];
          if (activeFieldKey === k) activeFieldKey = 'src_tc';
        }
        renderFields();
        setRoiBoxFromField();
      });
      rxInp.addEventListener('input', () => {
        f.regex = String(rxInp.value || '');
        preset.fields[k] = f;
        scheduleOcr(k);
      });

      fieldsWrap.appendChild(row);
    });
  }

  function overlayPointToNorm(clientX, clientY){
    const c = contentRect();
    const lx = (clientX - c.r.left) - c.ox;
    const ly = (clientY - c.r.top) - c.oy;
    const x = lx / Math.max(1, c.cw);
    const y = ly / Math.max(1, c.ch);
    return { x: clamp01(x), y: clamp01(y) };
  }

  function roiContains(roi, p){
    if (!roi) return false;
    return p.x >= roi.x && p.x <= (roi.x + roi.w) && p.y >= roi.y && p.y <= (roi.y + roi.h);
  }

  function scheduleOcr(fieldKey){
    clearTimeout(ocrTimer);
    ocrTimer = setTimeout(() => doOcr(fieldKey), 120);
  }

  async function doOcr(fieldKey){
    try{
      const f = preset.fields[fieldKey];
      if (!f || !f.enabled || !f.roi){
        ocrCache[fieldKey] = { ocr: '', parsed: '' };
        renderFields();
        return;
      }
      const srcCanvas = drawImgToCanvas(imgEl);
      const imgData = cropImageData(srcCanvas, f.roi, 1600);
      if (!imgData){
        ocrCache[fieldKey] = { ocr: '', parsed: '' };
        renderFields();
        return;
      }
      preprocessForOcr(imgData);
      const ocr = getOcrClient();
      const txt = await ocr.recognize(imgData, { psm: f?.ocr?.psm ?? 7, whitelist: f?.ocr?.whitelist ?? '' });
      const parsed = parseByRegex(txt, f.regex);
      ocrCache[fieldKey] = { ocr: txt, parsed };
      // Live preview: show result near the ROI box without waiting for full re-render
      if (fieldKey === activeFieldKey && liveOcrEl) {
        const display = parsed || txt;
        if (display) {
          liveOcrEl.textContent = display;
          liveOcrEl.className = 'pfx-burnin-liveOcr' + (parsed ? ' ok' : ' raw');
          liveOcrEl.hidden = false;
        } else {
          liveOcrEl.hidden = true;
        }
      }
      renderFields();
    }catch(err){
      ocrCache[fieldKey] = { ocr: String(err?.message || err), parsed: '' };
      renderFields();
    }
  }

  function setFieldRoiFromPoints(p0, p1){
    const x0 = Math.min(p0.x, p1.x);
    const y0 = Math.min(p0.y, p1.y);
    const x1 = Math.max(p0.x, p1.x);
    const y1 = Math.max(p0.y, p1.y);
    const roi = { x: x0, y: y0, w: Math.max(0.005, x1-x0), h: Math.max(0.005, y1-y0) };
    const f = getActiveField();
    f.roi = roi;
    preset.fields[activeFieldKey] = f;
    setRoiBoxFromField();
    scheduleOcr(activeFieldKey);
  }

  // ── Auto-detect: find high-edge-density horizontal bands in the frame ──────
  async function autoDetectRegions(){
    const srcCanvas = drawImgToCanvas(imgEl);
    const fw = srcCanvas.width, fh = srcCanvas.height;
    if (!fw || !fh) return;
    const ctx = srcCanvas.getContext('2d');

    // Sample horizontal strips (6.5% of height, stepping 2%)
    const bandH = Math.max(4, Math.floor(fh * 0.065));
    const step  = Math.max(2, Math.floor(fh * 0.020));
    const bands = [];

    for (let y = 0; y + bandH <= fh; y += step){
      const id = ctx.getImageData(0, y, fw, bandH);
      const d  = id.data;
      // Horizontal Sobel-ish edge density
      let edgeSum = 0;
      for (let row = 0; row < bandH; row++){
        for (let col = 1; col < fw - 1; col++){
          const il = (row * fw + col - 1) * 4;
          const ir = (row * fw + col + 1) * 4;
          const lL = 0.2126*d[il] + 0.7152*d[il+1] + 0.0722*d[il+2];
          const lR = 0.2126*d[ir] + 0.7152*d[ir+1] + 0.0722*d[ir+2];
          edgeSum += Math.abs(lR - lL);
        }
      }
      bands.push({ y, score: edgeSum / (fw * bandH) });
    }

    // Pick top-2 non-overlapping bands (centres at least 10% of height apart)
    const minGap = fh * 0.10;
    const sorted = [...bands].sort((a, b) => b.score - a.score);
    const selected = [];
    for (const band of sorted){
      if (selected.length >= 2) break;
      if (selected.every(s => Math.abs(s.y - band.y) > minGap)) selected.push(band);
    }
    if (!selected.length) return;

    selected.sort((a, b) => a.y - b.y); // top-to-bottom
    const keys = Object.keys(preset.fields);
    selected.forEach((band, i) => {
      const fk = keys[i] || keys[0];
      if (!fk) return;
      const field = preset.fields[fk] || {};
      field.roi = { x: 0.008, y: band.y / fh, w: 0.450, h: bandH / fh };
      preset.fields[fk] = field;
    });

    activeFieldKey = keys[0] || activeFieldKey;
    if (liveOcrEl) liveOcrEl.hidden = true;
    for (const k of Object.keys(ocrCache)) delete ocrCache[k];
    renderFields();
    setRoiBoxFromField();
    for (const k of Object.keys(preset.fields)) scheduleOcr(k);
  }

  // ── Multi-frame test: seek through video and run OCR on each sample ────────
  async function testMultipleFrames(nFrames = 6){
    const pane = document.querySelector('.main-pane.active') || document.body;
    const vid = Array.from(pane.querySelectorAll('video'))
      .filter(v => v.videoWidth > 0 && v.duration > 0 && !isNaN(v.duration))
      .sort((a, b) => {
        const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
        return (rb.width * rb.height) - (ra.width * ra.height);
      })[0] || null;

    if (!vid){
      try{ window.showError?.(TT('No seekable video found for multi-frame test.')); }catch{}
      return;
    }

    const dur = vid.duration;
    const origTime = vid.currentTime;
    const wasPlaying = !vid.paused;
    if (!vid.paused) vid.pause();

    const fieldKey = activeFieldKey;
    const f = preset.fields[fieldKey];

    // Progress overlay
    const progDiv = document.createElement('div');
    progDiv.className = 'pfx-burnin-testProgress';
    progDiv.innerHTML = `<span>${escapeHtml(TT('Testing frame'))} 0/${nFrames}…</span>`;
    overlay.appendChild(progDiv);

    const results = [];
    try{
      for (let i = 0; i < nFrames; i++){
        const t = (i === 0) ? Math.min(0.5, dur * 0.02)
                            : (i / (nFrames - 1)) * dur * 0.97;
        await new Promise(res => {
          const guard = setTimeout(res, 2500);
          const done  = () => { clearTimeout(guard); vid.removeEventListener('seeked', done); res(); };
          vid.addEventListener('seeked', done);
          vid.currentTime = Math.min(t, dur - 0.1);
        });
        progDiv.querySelector('span').textContent = `${TT('Testing frame')} ${i+1}/${nFrames}…`;

        const fc = document.createElement('canvas');
        fc.width = vid.videoWidth; fc.height = vid.videoHeight;
        fc.getContext('2d').drawImage(vid, 0, 0);

        if (f?.roi){
          const imgData = cropImageData(fc, f.roi, 1600);
          if (imgData){
            preprocessForOcr(imgData);
            try{
              const txt    = await getOcrClient().recognize(imgData, { psm: f?.ocr?.psm ?? 7, whitelist: f?.ocr?.whitelist ?? '' });
              const parsed = parseByRegex(txt, f.regex);
              results.push({ i: i+1, t: t.toFixed(1)+'s', raw: txt, parsed, ok: !!parsed });
            }catch(err){
              results.push({ i: i+1, t: t.toFixed(1)+'s', raw: String(err?.message||err), parsed: '', ok: false });
            }
          }
        } else {
          results.push({ i: i+1, t: t.toFixed(1)+'s', raw: '(no ROI)', parsed: '', ok: false });
        }
      }
    }finally{
      try{ vid.currentTime = origTime; }catch{}
      if (wasPlaying) try{ vid.play(); }catch{}
      try{ overlay.removeChild(progDiv); }catch{}
    }

    // Results panel
    const okN = results.filter(r => r.ok).length;
    const panel = document.createElement('div');
    panel.className = 'pfx-burnin-testResults';
    panel.innerHTML = `
      <div class="pfx-burnin-testHdr">
        <span>${escapeHtml(TT('Multi-frame test'))} — ${okN}/${nFrames} matched</span>
        <button class="pfx-burnin-testClose" data-act="closeTest">×</button>
      </div>
      <div class="pfx-burnin-testList">
        ${results.map(r => `
          <div class="pfx-burnin-testRow ${r.ok?'ok':'bad'}">
            <span class="pfx-burnin-testFr">#${r.i} ${escapeHtml(r.t)}</span>
            <span class="pfx-burnin-testVal">${escapeHtml(r.parsed || r.raw || '—')}</span>
          </div>`).join('')}
      </div>`;
    panel.querySelector('[data-act="closeTest"]').addEventListener('click', () => {
      try{ overlay.removeChild(panel); }catch{}
    });
    overlay.appendChild(panel);
  }

  // Pointer interaction
  overlay.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    overlay.setPointerCapture(e.pointerId);
    const p = overlayPointToNorm(e.clientX, e.clientY);
    const f = getActiveField();
    const roi = f?.roi;
    const h = e.target?.getAttribute?.('data-h');

    if (h && roi){
      dragMode = h;
      dragStart = { p, roi: { ...roi } };
      return;
    }

    if (roi && roiContains(roi, p)){
      dragMode = 'move';
      dragStart = { p, roi: { ...roi } };
      return;
    }

    // draw new
    drawing = true;
    dragMode = 'draw';
    dragStart = { p0: p, p1: p };
    setFieldRoiFromPoints(p, p);
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!dragMode) return;
    const p = overlayPointToNorm(e.clientX, e.clientY);
    const f = getActiveField();
    const roi = f?.roi;

    if (dragMode === 'draw' && dragStart?.p0){
      dragStart.p1 = p;
      setFieldRoiFromPoints(dragStart.p0, p);
      return;
    }

    if (!roi || !dragStart?.roi) return;
    const base = dragStart.roi;
    const dx = p.x - dragStart.p.x;
    const dy = p.y - dragStart.p.y;

    let next = { ...base };
    if (dragMode === 'move'){
      next.x = clamp01(base.x + dx);
      next.y = clamp01(base.y + dy);
      // keep inside bounds
      next.x = Math.min(next.x, 1 - next.w);
      next.y = Math.min(next.y, 1 - next.h);
    } else {
      // resize corners
      const x0 = base.x;
      const y0 = base.y;
      const x1 = base.x + base.w;
      const y1 = base.y + base.h;
      let nx0 = x0, ny0 = y0, nx1 = x1, ny1 = y1;
      if (dragMode.includes('n')) ny0 = clamp01(y0 + dy);
      if (dragMode.includes('s')) ny1 = clamp01(y1 + dy);
      if (dragMode.includes('w')) nx0 = clamp01(x0 + dx);
      if (dragMode.includes('e')) nx1 = clamp01(x1 + dx);
      // enforce min size
      const min = 0.005;
      if (nx1 - nx0 < min){
        if (dragMode.includes('w')) nx0 = nx1 - min; else nx1 = nx0 + min;
      }
      if (ny1 - ny0 < min){
        if (dragMode.includes('n')) ny0 = ny1 - min; else ny1 = ny0 + min;
      }
      nx0 = clamp01(nx0); ny0 = clamp01(ny0); nx1 = clamp01(nx1); ny1 = clamp01(ny1);
      // normalize ordering
      const ax0 = Math.min(nx0,nx1), ax1 = Math.max(nx0,nx1);
      const ay0 = Math.min(ny0,ny1), ay1 = Math.max(ny0,ny1);
      next = { x: ax0, y: ay0, w: Math.max(min, ax1-ax0), h: Math.max(min, ay1-ay0) };
      // keep inside
      next.x = Math.min(next.x, 1-next.w);
      next.y = Math.min(next.y, 1-next.h);
    }

    f.roi = next;
    preset.fields[activeFieldKey] = f;
    setRoiBoxFromField();
    scheduleOcr(activeFieldKey);
  });

  overlay.addEventListener('pointerup', (e) => {
    if (!dragMode) return;
    try{ overlay.releasePointerCapture(e.pointerId); }catch{}
    drawing = false;
    dragMode = null;
    dragStart = null;
    renderFields();
  });

  // Buttons
  head.addEventListener('click', async (e) => {
    const act   = e.target?.getAttribute?.('data-act');
    const camId = e.target?.getAttribute?.('data-cam');
    if (!act && !camId) return;
    if (act === 'cancel') return close();
    if (act === 'clearOverride'){
      if (isClipMode && applyOverride){
        try{ await applyOverride(null); }catch{}
      }
      return close();
    }
    if (act === 'done'){
      if (isClipMode){
        if (applyOverride){
          const payload = { presetId: activePresetId, preset: preset, updatedAt: new Date().toISOString() };
          try{ await applyOverride(payload); }catch{}
        }
      }else{
        // write preset back to cfg and persist
        cfg.presets[activePresetId] = preset;
        cfg.activePresetId = activePresetId;
        PFX_saveBurninConfig(cfg);
      }
      return close();
    }
    if (act === 'new'){
      if (isClipMode) return;
      const id = nextPresetId(cfg);
      cfg.presets[id] = deepClone(defaultConfig().presets.default);
      cfg.presets[id].name = `Preset ${Object.keys(cfg.presets).length}`;
      activePresetId = id;
      preset = deepClone(cfg.presets[id]);
      refreshPresetSelect();
      renderFields();
      setRoiBoxFromField();
      return;
    }
    if (act === 'dup'){
      if (isClipMode) return;
      const id = nextPresetId(cfg);
      cfg.presets[id] = deepClone(preset);
      cfg.presets[id].name = `${(preset?.name||'Preset')} Copy`;
      activePresetId = id;
      preset = deepClone(cfg.presets[id]);
      refreshPresetSelect();
      renderFields();
      setRoiBoxFromField();
      return;
    }
    if (act === 'del'){
      if (isClipMode) return;
      if (Object.keys(cfg.presets).length <= 1) return;
      if (activePresetId === 'default') return;
      delete cfg.presets[activePresetId];
      activePresetId = Object.keys(cfg.presets)[0];
      preset = deepClone(cfg.presets[activePresetId]);
      refreshPresetSelect();
      renderFields();
      setRoiBoxFromField();
      return;
    }
    if (act === 'recap'){
      const rec = await captureActiveVideoFrame();
      if (rec?.dataUrl){
        imgEl.src = rec.dataUrl;
        // Clear OCR cache on new frame
        for (const k of Object.keys(ocrCache)) delete ocrCache[k];
        if (liveOcrEl) liveOcrEl.hidden = true;
        setRoiBoxFromField();
        renderFields();
        scheduleOcr(activeFieldKey);
      }
      return;
    }

    // Camera brand preset dropdown toggle
    if (act === 'camPreset'){
      const camMenu = head.querySelector('.pfx-burnin-camMenu');
      if (camMenu) camMenu.hidden = !camMenu.hidden;
      return;
    }

    // Camera brand item selected
    if (camId){
      const cp = CAMERA_PRESETS.find(cp2 => cp2.id === camId);
      if (cp){
        preset.fields = deepClone(cp.fields);
        activeFieldKey = Object.keys(preset.fields)[0] || 'src_tc';
        if (liveOcrEl) liveOcrEl.hidden = true;
        for (const k of Object.keys(ocrCache)) delete ocrCache[k];
        renderFields();
        setRoiBoxFromField();
        for (const k of Object.keys(preset.fields)) scheduleOcr(k);
      }
      const camMenu = head.querySelector('.pfx-burnin-camMenu');
      if (camMenu) camMenu.hidden = true;
      return;
    }

    if (act === 'autoDetect'){
      try{ await autoDetectRegions(); }catch(err){ console.warn('Auto-detect failed', err); }
      return;
    }

    if (act === 'testFrames'){
      try{ await testMultipleFrames(6); }catch(err){ console.warn('Multi-frame test failed', err); }
      return;
    }
  });

  presetSel.addEventListener('change', () => {
    const prevPresetId = activePresetId;
    activePresetId = String(presetSel.value || 'default');
    if (!cfg.presets[activePresetId]) activePresetId = Object.keys(cfg.presets)[0] || 'default';
    if (!isClipMode){
      // store current preset draft back into the PREVIOUS slot before switching
      cfg.presets[prevPresetId] = preset;
    }
    preset = deepClone(cfg.presets[activePresetId]);
    activeFieldKey = 'src_tc';
    for (const k of Object.keys(ocrCache)) delete ocrCache[k];
    renderFields();
    setRoiBoxFromField();
    scheduleOcr(activeFieldKey);
  });

  body.addEventListener('click', (e) => {
    const act = e.target?.getAttribute?.('data-act');
    if (act === 'addField'){
      const id = `field_${Math.random().toString(16).slice(2,8)}`;
      preset.fields[id] = { label: 'Field', enabled: true, roi: null, regex: '', ocr: { psm: 7, whitelist: '' } };
      activeFieldKey = id;
      renderFields();
      setRoiBoxFromField();
      return;
    }
  });

  // Esc closes
  const onKey = (ev) => {
    if (ev.key === 'Escape'){
      ev.preventDefault();
      close();
    }
  };
  __onKey = onKey;
  window.addEventListener('keydown', onKey, { capture:true });

  // Keep ROI box aligned if the modal resizes
  const onResize = () => {
    try{ setRoiBoxFromField(); }catch{}
  };
  __onResize = onResize;
  window.addEventListener('resize', onResize);

  // Replace close references
  // (cheap but safe)
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop){ close(); return; }
    // Close camera menu if open and click is outside it
    if (!e.target?.closest?.('.pfx-burnin-camWrap')){
      const camMenu = head.querySelector('.pfx-burnin-camMenu');
      if (camMenu && !camMenu.hidden) camMenu.hidden = true;
    }
  });

  // Initial render
  refreshPresetSelect();
  renderFields();
  setRoiBoxFromField();
  scheduleOcr(activeFieldKey);

  // ensure focus
  try{ overlay.focus(); }catch{}
}
