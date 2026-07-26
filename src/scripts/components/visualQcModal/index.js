// Visual QC Modal (PostFlowX)
// - Local in-browser scan (v0): edge intrusion + highlight spikes
// - Uses Burn-in presets (project + per-clip override) to resolve OCF + SRC TC
// - Stores report on the clip object (clip.visualQc)

import { PFX_getBurninPresetForClip } from '../burninSetupModal/index.js';
import { getCachedProxyForFile } from '../../modules/proResProxy.js';
// The tiers here throw on cancel rather than returning it, so runSaveCascade's
// own catch classifies them and this file never needs isUserCancel directly.
import { SAVED, UNAVAILABLE, runSaveCascade } from '../../core/saveOutcome.js';
import { saveNotice } from '../../core/saveNotice.js';

/**
 * Resolve the best playable URL for a clip used by hidden analysis video elements
 * (scan, thumbnail extraction, still capture). Does NOT use attachPlayableVideo —
 * analysis surfaces must not claim exclusive playback coordination.
 *
 * Priority:
 *   1. In-memory proxy cache (cross-tab, covers ProRes already proxied by another surface)
 *   2. clip.url (original blob URL set by the calling code)
 *
 * Synchronous — no proxy generation is triggered here. If no proxy exists yet the
 * analysis will attempt direct decode via clip.url; ProRes will silently fail in that
 * case, which is acceptable for round 1 (analysis can only use what's already available).
 */
function _resolveQcUrl(clip) {
  if (clip.file instanceof File) {
    const cached = getCachedProxyForFile(clip.file);
    if (cached?.url) return cached.url;
  }
  return clip.url || '';
}

function el(tag, cls, text){
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function escapeHtml(s){
  return String(s || '').replace(/[&<>\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
}

function clamp01(v){
  v = Number(v);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function uid(){
  return `qc_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
}

function meanLumaFromRGBA(d, i){
  // Rec.709
  return 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
}

function regionScore(prev, cur, w, h, rx0, ry0, rx1, ry1, opts={}){
  // Returns { avgDiff, changedFrac }
  const step = Math.max(1, Number(opts.step) || 2);
  const thr = Math.max(1, Number(opts.pixelThr) || 25);

  const x0 = Math.max(0, Math.min(w-1, Math.floor(rx0 * w)));
  const y0 = Math.max(0, Math.min(h-1, Math.floor(ry0 * h)));
  const x1 = Math.max(x0+1, Math.min(w, Math.ceil(rx1 * w)));
  const y1 = Math.max(y0+1, Math.min(h, Math.ceil(ry1 * h)));

  let sum = 0;
  let n = 0;
  let changed = 0;
  const pd = prev.data;
  const cd = cur.data;
  for (let y=y0; y<y1; y+=step){
    let row = (y*w + x0) * 4;
    for (let x=x0; x<x1; x+=step){
      const i = row;
      const a = meanLumaFromRGBA(pd, i);
      const b = meanLumaFromRGBA(cd, i);
      const diff = Math.abs(a - b);
      sum += diff;
      n++;
      if (diff >= thr) changed++;
      row += step * 4;
    }
  }
  const avgDiff = n ? (sum / n) : 0;
  const changedFrac = n ? (changed / n) : 0;
  return { avgDiff, changedFrac };
}

function hotspotBboxFromDiff(prev, cur, w, h, rx0, ry0, rx1, ry1, opts={}){
  // Returns bbox_norm [x,y,w,h] for the "hottest" diff cluster inside the region.
  // Uses a coarse grid heatmap + flood fill to avoid expensive CC labeling.
  const step = Math.max(1, Number(opts.step) || 3);
  const thr = Math.max(1, Number(opts.pixelThr) || 25);
  const gridX = Math.max(4, Number(opts.gridX) || 24);
  const gridY = Math.max(4, Number(opts.gridY) || 14);
  const padPct = clamp01(opts.padPct ?? 0.012);

  const x0 = Math.max(0, Math.min(w-1, Math.floor(rx0 * w)));
  const y0 = Math.max(0, Math.min(h-1, Math.floor(ry0 * h)));
  const x1 = Math.max(x0+1, Math.min(w, Math.ceil(rx1 * w)));
  const y1 = Math.max(y0+1, Math.min(h, Math.ceil(ry1 * h)));

  const rw = Math.max(1, x1 - x0);
  const rh = Math.max(1, y1 - y0);
  const cellW = rw / gridX;
  const cellH = rh / gridY;
  const counts = new Array(gridX * gridY).fill(0);

  const pd = prev.data;
  const cd = cur.data;
  for (let y=y0; y<y1; y+=step){
    const cy = Math.max(0, Math.min(gridY-1, Math.floor((y - y0) / cellH)));
    let row = (y*w + x0) * 4;
    for (let x=x0; x<x1; x+=step){
      const cx = Math.max(0, Math.min(gridX-1, Math.floor((x - x0) / cellW)));
      const i = row;
      const a = meanLumaFromRGBA(pd, i);
      const b = meanLumaFromRGBA(cd, i);
      const diff = Math.abs(a - b);
      if (diff >= thr){
        counts[cy * gridX + cx]++;
      }
      row += step * 4;
    }
  }

  let max = 0;
  let maxIdx = -1;
  for (let i=0;i<counts.length;i++){
    const v = counts[i];
    if (v > max){ max = v; maxIdx = i; }
  }
  if (maxIdx < 0 || max <= 0) return null;

  const cut = Math.max(1, Math.floor(max * 0.35));
  const seen = new Uint8Array(counts.length);
  const q = [maxIdx];
  seen[maxIdx] = 1;
  let minCx = maxIdx % gridX, maxCx = minCx;
  let minCy = Math.floor(maxIdx / gridX), maxCy = minCy;

  while (q.length){
    const idx = q.pop();
    const cx = idx % gridX;
    const cy = Math.floor(idx / gridX);
    minCx = Math.min(minCx, cx);
    maxCx = Math.max(maxCx, cx);
    minCy = Math.min(minCy, cy);
    maxCy = Math.max(maxCy, cy);
    const nb = [
      (cx>0) ? (idx-1) : -1,
      (cx<gridX-1) ? (idx+1) : -1,
      (cy>0) ? (idx-gridX) : -1,
      (cy<gridY-1) ? (idx+gridX) : -1,
    ];
    for (const j of nb){
      if (j<0 || seen[j]) continue;
      if (counts[j] >= cut){
        seen[j] = 1;
        q.push(j);
      }
    }
  }

  let bx0 = x0 + minCx * cellW;
  let by0 = y0 + minCy * cellH;
  let bx1 = x0 + (maxCx + 1) * cellW;
  let by1 = y0 + (maxCy + 1) * cellH;

  // pad
  const padX = padPct * w;
  const padY = padPct * h;
  bx0 = Math.max(0, bx0 - padX);
  by0 = Math.max(0, by0 - padY);
  bx1 = Math.min(w, bx1 + padX);
  by1 = Math.min(h, by1 + padY);

  const bw = Math.max(1, bx1 - bx0);
  const bh = Math.max(1, by1 - by0);
  return [bx0 / w, by0 / h, bw / w, bh / h];
}

function hotspotBboxFromBright(cur, w, h, opts={}){
  // Returns bbox_norm [x,y,w,h] for bright hotspot cluster (reflection cue)
  const step = Math.max(1, Number(opts.step) || 3);
  const thr = Math.max(1, Number(opts.brightThr) || 245);
  const gridX = Math.max(4, Number(opts.gridX) || 24);
  const gridY = Math.max(4, Number(opts.gridY) || 14);
  const padPct = clamp01(opts.padPct ?? 0.012);
  const excludeBottom = clamp01(opts.excludeBottomPct ?? 0.28);

  const yMax = Math.max(1, Math.floor((1 - excludeBottom) * h));
  const x0 = 0, y0 = 0, x1 = w, y1 = yMax;
  const rw = Math.max(1, x1 - x0);
  const rh = Math.max(1, y1 - y0);
  const cellW = rw / gridX;
  const cellH = rh / gridY;
  const counts = new Array(gridX * gridY).fill(0);

  const cd = cur.data;
  for (let y=y0; y<y1; y+=step){
    const cy = Math.max(0, Math.min(gridY-1, Math.floor((y - y0) / cellH)));
    let row = (y*w + x0) * 4;
    for (let x=x0; x<x1; x+=step){
      const cx = Math.max(0, Math.min(gridX-1, Math.floor((x - x0) / cellW)));
      const i = row;
      const yv = meanLumaFromRGBA(cd, i);
      if (yv >= thr){
        counts[cy * gridX + cx]++;
      }
      row += step * 4;
    }
  }

  let max = 0;
  let maxIdx = -1;
  for (let i=0;i<counts.length;i++){
    const v = counts[i];
    if (v > max){ max = v; maxIdx = i; }
  }
  if (maxIdx < 0 || max <= 0) return null;

  const cut = Math.max(1, Math.floor(max * 0.35));
  const seen = new Uint8Array(counts.length);
  const q = [maxIdx];
  seen[maxIdx] = 1;
  let minCx = maxIdx % gridX, maxCx = minCx;
  let minCy = Math.floor(maxIdx / gridX), maxCy = minCy;

  while (q.length){
    const idx = q.pop();
    const cx = idx % gridX;
    const cy = Math.floor(idx / gridX);
    minCx = Math.min(minCx, cx);
    maxCx = Math.max(maxCx, cx);
    minCy = Math.min(minCy, cy);
    maxCy = Math.max(maxCy, cy);
    const nb = [
      (cx>0) ? (idx-1) : -1,
      (cx<gridX-1) ? (idx+1) : -1,
      (cy>0) ? (idx-gridX) : -1,
      (cy<gridY-1) ? (idx+gridX) : -1,
    ];
    for (const j of nb){
      if (j<0 || seen[j]) continue;
      if (counts[j] >= cut){
        seen[j] = 1;
        q.push(j);
      }
    }
  }

  let bx0 = x0 + minCx * cellW;
  let by0 = y0 + minCy * cellH;
  let bx1 = x0 + (maxCx + 1) * cellW;
  let by1 = y0 + (maxCy + 1) * cellH;

  const padX = padPct * w;
  const padY = padPct * h;
  bx0 = Math.max(0, bx0 - padX);
  by0 = Math.max(0, by0 - padY);
  bx1 = Math.min(w, bx1 + padX);
  by1 = Math.min(h, by1 + padY);

  const bw = Math.max(1, bx1 - bx0);
  const bh = Math.max(1, by1 - by0);
  return [bx0 / w, by0 / h, bw / w, bh / h];
}

function highlightSpikeScore(cur, w, h, opts={}){
  // crude reflection cue: bright pixels spike (excluding bottom area to avoid subtitles)
  const excludeBottom = clamp01(opts.excludeBottomPct ?? 0.28);
  const y1 = Math.max(1, Math.floor((1 - excludeBottom) * h));
  const cd = cur.data;
  const step = Math.max(1, Number(opts.step) || 2);
  const thr = Math.max(1, Number(opts.brightThr) || 245);
  let n = 0;
  let bright = 0;
  for (let y=0; y<y1; y+=step){
    let row = (y*w) * 4;
    for (let x=0; x<w; x+=step){
      const i = row;
      const yv = meanLumaFromRGBA(cd, i);
      n++;
      if (yv >= thr) bright++;
      row += step * 4;
    }
  }
  const frac = n ? (bright / n) : 0;
  return { brightFrac: frac };
}

function mergeHitsToEvents(hits, gapSec=1.0){
  const out = [];
  const g = Math.max(0.05, Number(gapSec) || 1.0);
  let cur = null;
  for (const h of hits){
    if (!cur){
      cur = { start: h.t, end: h.t, maxScore: h.score, keyT: h.t, keyBbox: h.bbox || null, keyMeta: h.meta || null, type: h.type };
      continue;
    }
    if ((h.t - cur.end) <= g && h.type === cur.type){
      cur.end = h.t;
      if (h.score > cur.maxScore){
        cur.maxScore = h.score;
        cur.keyT = h.t;
        cur.keyBbox = h.bbox || null;
        cur.keyMeta = h.meta || null;
      }
    }else{
      out.push(cur);
      cur = { start: h.t, end: h.t, maxScore: h.score, keyT: h.t, keyBbox: h.bbox || null, keyMeta: h.meta || null, type: h.type };
    }
  }
  if (cur) out.push(cur);
  // Expand end a bit for readability
  for (const e of out){
    e.end = Math.max(e.end, e.start + 0.2);
  }
  return out;
}

// ---------------- OCR worker client (reuse tesseract assets) ----------------
let __ocrClient = null;
function getOcrClient(){
  if (__ocrClient) return __ocrClient;
  const workerUrl = chrome?.runtime?.getURL
    ? chrome.runtime.getURL('scripts/ocr_burnin_worker.js')
    : 'scripts/ocr_burnin_worker.js';
  const worker = new Worker(workerUrl);
  let seq = 0;
  const pending = new Map();

  worker.onmessage = (ev)=>{
    const msg = ev.data || {};
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(msg.error || 'OCR worker error'));
  };
  worker.onerror = ()=>{
    for (const [,p] of pending) { try{ p.reject(new Error('OCR worker crashed')); }catch{} }
    pending.clear();
    __ocrClient = null;
    try{ worker.terminate(); }catch{}
  };

  __ocrClient = {
    async recognize(imageData, opts={}){
      const id = `ocr_${Date.now()}_${++seq}`;
      const rgba = new Uint8Array(imageData.data);
      const payload = {
        id,
        type: 'recognize',
        image: { buffer: rgba.buffer, width: imageData.width, height: imageData.height },
        psm: (Number.isFinite(opts?.psm) ? Number(opts.psm) : undefined),
        whitelist: (typeof opts?.whitelist === 'string' ? opts.whitelist : undefined),
      };
      const p = new Promise((resolve,reject)=> pending.set(id, { resolve, reject }));
      worker.postMessage(payload, [rgba.buffer]);
      let ocrTimer = null;
      try {
        const res = await Promise.race([
          p,
          new Promise((_,rej)=>{
            ocrTimer = setTimeout(()=>{
              pending.delete(id);
              rej(new Error('OCR timeout'));
            }, 25_000);
          })
        ]);
        return String(res.text || '').trim();
      } finally {
        clearTimeout(ocrTimer);
      }
    }
  };
  return __ocrClient;
}

function cropFromCanvas(srcCanvas, roiNorm, maxSide=1600){
  const sw = srcCanvas.width;
  const sh = srcCanvas.height;
  if (!sw || !sh) return null;
  const rx = clamp01(roiNorm?.x);
  const ry = clamp01(roiNorm?.y);
  const rw = clamp01(roiNorm?.w);
  const rh = clamp01(roiNorm?.h);
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
  const imgData = g.getImageData(0, 0, outW, outH);
  try{ tmp.width = 0; }catch{} // release GPU-backed canvas memory immediately instead of waiting for GC
  return imgData;
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
  // adaptive-ish threshold (cheap): pick mid between p20 and p80 luma
  const hist = new Uint32Array(256);
  for (let i=0;i<d.length;i+=4){ hist[d[i] | 0]++; }
  const total = d.length / 4;
  const pAt = (p)=>{
    const goal = total * p;
    let acc = 0;
    for (let t=0;t<256;t++){
      acc += hist[t];
      if (acc >= goal) return t;
    }
    return 140;
  };
  const p20 = pAt(0.20);
  const p80 = pAt(0.80);
  const thr = Math.max(60, Math.min(210, Math.round((p20 + p80) / 2)));
  for (let i=0;i<d.length;i+=4){
    const v = d[i] >= thr ? 255 : 0;
    d[i] = d[i+1] = d[i+2] = v;
  }
  return img;
}

function firstMatch(text, re){
  try{
    const m = String(text||'').match(re);
    return m ? (m[0] || '') : '';
  }catch{ return ''; }
}

function buildRegex(s, fallback){
  try{ return new RegExp(String(s||fallback||''), 'i'); }catch{ return new RegExp(String(fallback||''), 'i'); }
}

function fmtClock(t){
  const s = Math.max(0, Number(t) || 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor(s / 60) % 60;
  const ss = Math.floor(s) % 60;
  const ms = Math.floor((s - Math.floor(s)) * 1000);
  const pad2 = (n)=>String(n).padStart(2,'0');
  const pad3 = (n)=>String(n).padStart(3,'0');
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}.${pad3(ms)}`;
}

function safeName(s){
  return String(s || 'clip').replace(/[\\/:*?"<>|]+/g,'_').slice(0,120);
}

function formatBytes(bytes){
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1){
    value /= 1024;
    idx++;
  }
  const fixed = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(fixed)} ${units[idx]}`;
}

function gcd(a, b){
  let x = Math.abs(Math.round(Number(a) || 0));
  let y = Math.abs(Math.round(Number(b) || 0));
  while (y){
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

function formatAspectRatio(w, h){
  const ww = Math.round(Number(w) || 0);
  const hh = Math.round(Number(h) || 0);
  if (!ww || !hh) return '';
  const d = gcd(ww, hh);
  return `${Math.round(ww / d)}:${Math.round(hh / d)}`;
}

function countSummaryText(counts){
  const src = (counts && typeof counts === 'object') ? counts : {};
  const bits = [];
  const crew = (Number(src.crew_edge) || 0) + (Number(src.reflection_spike) || 0) + (Number(src.crew_equipment) || 0);
  const framing = Number(src.framing_error) || 0;
  if (crew) bits.push(`${crew} crew`);
  if (framing) bits.push(`${framing} framing`);
  for (const [k, v] of Object.entries(src)){
    const n = Number(v) || 0;
    if (!n) continue;
    if (k === 'crew_edge' || k === 'reflection_spike' || k === 'crew_equipment' || k === 'framing_error') continue;
    bits.push(`${n} ${k}`);
  }
  return bits.join(' • ');
}

function buildPreflightSnapshot({ clip, file, video, durationSec, fps, presetResolved } = {}){
  const width = Math.max(0, Number(video?.videoWidth) || Number(clip?.width) || 0);
  const height = Math.max(0, Number(video?.videoHeight) || Number(clip?.height) || 0);
  const duration = Math.max(0, Number(durationSec) || Number(video?.duration) || Number(clip?.durationSec) || 0);
  const _nameParts = String(file?.name || clip?.name || '').split('.');
  const ext = (_nameParts.length > 1 ? _nameParts.pop() : '').trim().toLowerCase();
  return {
    fileName: String(file?.name || clip?.name || ''),
    mimeType: String(file?.type || ''),
    extension: ext || '',
    sizeBytes: Math.max(0, Number(file?.size) || 0),
    sizeLabel: formatBytes(file?.size),
    durationSec: duration,
    durationLabel: duration ? fmtClock(duration) : '',
    width,
    height,
    raster: (width && height) ? `${width}x${height}` : '',
    aspectRatio: formatAspectRatio(width, height),
    fpsContext: Math.max(1, Number(fps) || 24),
    burninPresetName: String(presetResolved?.preset?.name || presetResolved?.presetId || ''),
  };
}

function preflightSummaryText(preflight){
  if (!preflight) return '';
  const bits = [];
  if (preflight.extension) bits.push(preflight.extension.toUpperCase());
  if (preflight.raster) bits.push(preflight.raster);
  if (preflight.aspectRatio) bits.push(preflight.aspectRatio);
  if (preflight.durationLabel) bits.push(preflight.durationLabel);
  if (preflight.sizeLabel) bits.push(preflight.sizeLabel);
  return bits.join(' • ');
}

function evaluatePreflightChecks({ clip, preflight, presetResolved } = {}){
  const checks = [];
  const push = (level, code, message)=>{
    checks.push({ level: String(level || 'info'), code: String(code || ''), message: String(message || '') });
  };

  if (clip?.canPlay === false) {
    push('error', 'PLAYBACK', 'Clip is currently marked as not playable in the browser review pipeline.');
  }

  if (!preflight?.durationSec) {
    push('error', 'DURATION', 'Duration metadata is missing or unreadable.');
  }

  if (!preflight?.width || !preflight?.height) {
    push('error', 'RASTER', 'Frame size metadata is missing or unreadable.');
  }

  if (!presetResolved?.preset) {
    push('warn', 'BURNIN', 'No burn-in preset is linked. OCR may not resolve SRC TC or OCF correctly.');
  }

  if (!clip?.startTC || String(clip.startTC || '00:00:00:00') === '00:00:00:00') {
    push('info', 'TC', 'Clip start TC is default/unknown in the review store. Burn-in remains the preferred time source.');
  }

  if ((preflight?.width || 0) > 0 && (preflight?.height || 0) > 0) {
    const minEdge = Math.min(Number(preflight.width) || 0, Number(preflight.height) || 0);
    if (minEdge > 0 && minEdge < 720) {
      push('warn', 'RESOLUTION', 'Low raster may reduce OCR and framing-check reliability.');
    }
  }

  const ext = String(preflight?.extension || '').toLowerCase();
  if (ext && !['mov', 'mp4', 'mxf', 'webm'].includes(ext)) {
    push('info', 'WRAPPER', `Wrapper .${ext} is unusual for the current browser-first review flow.`);
  }

  let status = 'ready';
  if (checks.some((c) => c.level === 'error')) status = 'blocked';
  else if (checks.some((c) => c.level === 'warn')) status = 'warn';

  return { status, checks };
}

function preflightStatusText(preflight){
  const status = String(preflight?.status || 'ready');
  const checks = Array.isArray(preflight?.checks) ? preflight.checks : [];
  const label = status === 'blocked' ? 'Blocked' : status === 'warn' ? 'Warn' : 'Ready';
  const lead = checks.find((c) => c?.level === 'error')
    || checks.find((c) => c?.level === 'warn')
    || checks.find((c) => c?.level === 'info')
    || null;
  return lead?.message ? `${label} • ${lead.message}` : `${label} • No immediate scan blockers detected.`;
}

function csvEscape(s){
  const v = String(s ?? '');
  if (/[",\n]/.test(v)) return '"' + v.replace(/"/g,'""') + '"';
  return v;
}

function reportToCsv(report){
  const rows = [];
  rows.push(['id','asset_qc_code','asset_qc_name','severity_suggest','type','priority','ocf','src_tc_in','src_tc_out','start_sec','end_sec','key_sec','score','bbox_norm'].join(','));
  for (const e of (report?.events || [])){
    const bb = Array.isArray(e?.evidence?.bbox_norm) ? e.evidence.bbox_norm : null;
    rows.push([
      e.id,
      e.asset_qc?.code || '',
      e.asset_qc?.name || '',
      e.asset_qc?.severity_suggest || '',
      e.type,
      e.priority,
      e.shot?.ocf_name || '',
      e.timecode?.src_tc_in || '',
      e.timecode?.src_tc_out || '',
      String(e.start_sec ?? ''),
      String(e.end_sec ?? ''),
      String(e.evidence?.key_sec ?? ''),
      String(e.evidence?.score ?? '')
      ,
      bb ? JSON.stringify(bb) : ''
    ].map(csvEscape).join(','));
  }
  return rows.join('\n');
}

// ---------------- Asset QC mapping (Netflix-style labels) ----------------
const ASSET_QC = {
  crew096: {
    code: '096',
    name: 'Visible Production Crew/Equipment',
    ref: 'https://partnerhelp.netflixstudios.com/hc/en-us/articles/115001115691--096-Visible-Production-Crew-Equipment'
  },
  framing: {
    code: '',
    name: 'Framing Error',
    ref: 'https://partnerhelp.netflixstudios.com/hc/en-us/articles/115000670191-Framing-Error'
  }
};

function getAssetQcForEvent(ev){
  const t = String(ev?.type || '');
  if (t === 'crew_edge' || t === 'reflection_spike' || t === 'crew_equipment') return ASSET_QC.crew096;
  if (t === 'framing_error') return ASSET_QC.framing;
  return null;
}

function formatEventLabel(ev){
  const t = String(ev?.type || '');
  if (t === 'crew_edge') return 'Visible Crew/Equipment [096] • Edge';
  if (t === 'reflection_spike') return 'Visible Crew/Equipment [096] • Reflection';
  if (t === 'crew_equipment') return 'Visible Crew/Equipment [096]';
  if (t === 'framing_error') return 'Framing Error';
  return t;
}

function buildPrintHtmlReport({ title, subtitle, metaLines, items }){
  const safe = (s)=> escapeHtml(String(s ?? ''));
  const meta = (metaLines || []).filter(Boolean).map(l=>`<div class="metaLine">${safe(l)}</div>`).join('');
  const cards = (items || []).map((it, idx)=>{
    const img = it?.imgDataUrl ? `<img class="thumb" src="${it.imgDataUrl}" />` : `<div class="thumb thumb--empty">No Still</div>`;
    const fields = it?.fields || [];
    const rows = fields.map(f=>{
      const k = safe(f?.k || '');
      const v = safe(f?.v || '');
      return `<div class="kv"><div class="k">${k}</div><div class="v mono">${v}</div></div>`;
    }).join('');
    return `
      <div class="card" data-idx="${idx}">
        <div class="thumbWrap">${img}</div>
        <div class="cardMeta">
          <div class="cardTitle">${safe(it?.type || '')}</div>
          <div class="cardGrid">${rows}</div>
        </div>
      </div>
    `;
  }).join('');

  return `<!doctype html>
  <html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${safe(title || 'Visual QC Report')}</title>
    <style>
      @page { size: A4 landscape; margin: 10mm; }
      *{ box-sizing:border-box; }
      body{ margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color:#111; }
      .wrap{ padding: 10mm; }
      .header{ display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin-bottom:10px; }
      .hL{ display:flex; flex-direction:column; gap:3px; }
      .title{ font-size:18px; font-weight:800; letter-spacing:.2px; }
      .sub{ font-size:12px; opacity:.8; }
      .meta{ font-size:11px; opacity:.85; }
      .metaLine{ line-height:1.25; }
      .hR{ font-size:11px; opacity:.85; text-align:right; }
      .grid{ display:grid; grid-template-columns: 1fr 1fr; gap:10px; }
      .card{ border:1px solid #e5e5ea; border-radius:12px; overflow:hidden; display:flex; flex-direction:column; min-height: 140px; }
      .thumbWrap{ width:100%; background:#f6f6f8; display:flex; align-items:center; justify-content:center; }
      .thumb{ width:100%; height:auto; display:block; object-fit:contain; }
      .thumb--empty{ width:100%; padding:24px; text-align:center; color:#666; font-size:12px; }
      .cardMeta{ padding:10px 12px 12px; display:flex; flex-direction:column; gap:8px; }
      .cardTitle{ font-size:12px; font-weight:900; letter-spacing:.2px; text-transform:uppercase; }
      .cardGrid{ display:grid; grid-template-columns: 110px 1fr; gap:6px 10px; }
      .kv{ display:contents; }
      .k{ font-size:11px; color:#555; font-weight:700; }
      .v{ font-size:11px; color:#111; }
      .mono{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
      .footer{ margin-top:10px; font-size:10px; opacity:.7; display:flex; justify-content:space-between; gap:10px; }
      /* Keep cards from splitting */
      .card{ break-inside: avoid; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="header">
        <div class="hL">
          <div class="title">${safe(title || 'Visual QC Report')}</div>
          <div class="sub mono">${safe(subtitle || '')}</div>
          <div class="meta">${meta}</div>
        </div>
        <div class="hR">Generated ${safe(new Date().toLocaleString())}</div>
      </div>
      <div class="grid">${cards}</div>
      <div class="footer">
        <div>PostFlowX • Visual QC</div>
        <div class="mono">${safe(String(items?.length || 0))} item(s)</div>
      </div>
    </div>
  </body>
  </html>`;
}

// The print window opened. Distinct from SAVED, because the two endings need
// different sentences: one points at a dialog on screen, the other at a file.
const PRINTED = 'printed';

// Returns PRINTED, or the save cascade's own outcome for the HTML fallback.
// It used to return a bare `true` in both of those cases *and* after a
// cancelled or failed fallback save, which is how the caller ended up
// announcing a print dialog that had never opened.
async function openPrintReportHtml({ filenameBase, html }){
  // Try open in a new tab/window and auto-print. If blocked, download HTML as fallback.
  try{
    const w = window.open('', '_blank');
    if (w && w.document){
      w.document.open();
      w.document.write(html);
      w.document.close();
      // CSP: do NOT rely on inline <script> or onclick handlers (MV3 blocks them).
      try{
        const btn = w.document.getElementById('btnPrint');
        if (btn) btn.addEventListener('click', ()=>{ try{ w.focus(); w.print(); }catch(e){} });
      }catch{}
      // Auto-open print dialog (best-effort).
      setTimeout(()=>{ try{ w.focus(); w.print(); }catch(e){} }, 300);
      return PRINTED;
    }
  }catch{}
  // Fallback: save HTML for user to open and Print to PDF. Hand the caller the
  // real outcome so it can say what actually happened.
  try{
    return await downloadOrSaveText(`${safeName(filenameBase)}_visual_qc_report.html`, html, 'text/html');
  }catch{}
  return UNAVAILABLE;
}

// Same three-route cascade the review notes export uses, and it had the same
// bug: each tier reported "the user cancelled" and "this route is unusable"
// as one indistinguishable `false`, so cancelling the QC report's Save dialog
// opened a second one and then wrote the file to Downloads anyway. The tiers
// below genuinely differ from the review ones (blob URL, not data URL; a
// finally-closed writable), so they stay here — the sequencing rule that both
// copies got wrong is what moved into runSaveCascade.
async function downloadOrSaveText(filename, text, mime='text/plain'){
  return runSaveCascade([
    async () => {
      const dl = (globalThis.chrome && chrome.downloads && chrome.downloads.download) ? chrome.downloads : null;
      if (!dl) return UNAVAILABLE;
      const url = `data:${mime};charset=utf-8,${encodeURIComponent(String(text ?? ''))}`;
      const id = await new Promise((resolve, reject) => {
        dl.download({ url, filename, saveAs: true, conflictAction:'uniquify' }, (downloadId)=>{
          const err = chrome.runtime?.lastError;
          if (err) return reject(err);
          resolve(downloadId);
        });
      });
      return id ? SAVED : UNAVAILABLE;
    },
    async () => {
      if (typeof window.showSaveFilePicker !== 'function') return UNAVAILABLE;
      const ext = (filename.split('.').pop() || '').toLowerCase();
      const picker = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: ext.toUpperCase() || 'File', accept: { [mime]: [ext ? `.${ext}` : ''] } }],
      });
      const w = await picker.createWritable();
      try{ await w.write(new Blob([text], { type: mime })); }finally{ await w.close(); }
      return SAVED;
    },
    () => {
      const blob = new Blob([text], { type: mime });
      const url = URL.createObjectURL(blob);
      try{
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }finally{
        setTimeout(()=> URL.revokeObjectURL(url), 1000);
      }
      return SAVED;
    },
  ]);
}

export async function openVisualQcModal({
  clip,
  store,
  jumpToSec,
  onStatus,
  rangeSec = null,
  autoRun = false,
  initialMode = null,
}){
  const c = clip;
  if (!c) throw new Error('No clip');
  if (!c.url || !c.file) throw new Error('Clip media not linked. Please relink media first.');

  // Modal shell
  const backdrop = el('div', 'mps-modal-backdrop');
  const modal = el('div', 'mps-modal pfx-qc-modal');
  modal.setAttribute('role','dialog');
  modal.setAttribute('aria-modal','true');

  const head = el('div', 'mps-modal-head pfx-qc-head');
  const headL = el('div', 'pfx-qc-headL');
  headL.append(
    el('div', 'pfx-qc-title', 'Visual QC'),
    (()=>{
      const sub = el('div', 'pfx-qc-sub');
      sub.innerHTML = `<span class="mono">${escapeHtml(c.name || c.file?.name || 'Clip')}</span>`;
      return sub;
    })()
  );

  const headR = el('div', 'pfx-qc-headR');
  const btnClose = el('button', 'btn theme-danger', 'Close');
  btnClose.innerHTML = '<span class="bar"></span>Close';
  const btnRun = el('button', 'btn theme-q3 active', 'Run');
  btnRun.innerHTML = '<span class="bar"></span>Run';
  const btnExportJson = el('button', 'btn theme-amf', 'Export JSON');
  btnExportJson.innerHTML = '<span class="bar"></span>JSON';
  const btnExportCsv = el('button', 'btn theme-amf', 'Export CSV');
  btnExportCsv.innerHTML = '<span class="bar"></span>CSV';
  const btnExportPdf = el('button', 'btn theme-amf', 'Export PDF');
  btnExportPdf.innerHTML = '<span class="bar"></span>PDF';
  headR.append(btnExportJson, btnExportCsv, btnExportPdf, btnRun, btnClose);
  head.append(headL, headR);

  const body = el('div', 'mps-modal-body pfx-qc-body');

  const controls = el('div', 'pfx-qc-controls');
  const ctlRow = el('div', 'pfx-qc-ctlRow');
  const modeSel = el('select', 'pfx-qc-select');
  modeSel.innerHTML = `
    <option value="quick">Quick (0.5 fps)</option>
    <option value="normal" selected>Normal (1 fps)</option>
    <option value="dense">Dense (2 fps)</option>
  `;
  // Optional: preselect mode (used by playhead QC)
  try{ if (initialMode) { modeSel.value = String(initialMode); } }catch{}

  const gapInput = el('input', 'pfx-qc-input');
  gapInput.type = 'number';
  gapInput.min = '0.2';
  gapInput.max = '5';
  gapInput.step = '0.1';
  gapInput.value = '1.0';
  const thrInput = el('input', 'pfx-qc-input');
  thrInput.type = 'number';
  thrInput.min = '4';
  thrInput.max = '80';
  thrInput.step = '1';
  thrInput.value = '14';
  thrInput.title = 'Edge intrusion luma-diff threshold for the heuristic crew scan (0-255). Higher values are stricter.';
  const cbCrew = el('label', 'pfx-qc-check');
  cbCrew.innerHTML = `<input type="checkbox" checked /> <span>Visible Crew/Equipment <b>[096]</b></span>`;
  const cbFraming = el('label', 'pfx-qc-check');
  cbFraming.innerHTML = `<input type="checkbox" checked /> <span>Framing Error</span>`;

  const pdfMaxInput = el('input', 'pfx-qc-input');
  pdfMaxInput.type = 'number';
  pdfMaxInput.min = '1';
  pdfMaxInput.max = '300';
  pdfMaxInput.step = '1';
  pdfMaxInput.value = '60';
  pdfMaxInput.title = 'Max items for PDF report (top by score)';

  ctlRow.append(
    (()=>{ const w = el('div','pfx-qc-ctl'); w.innerHTML = `<span class="k">Mode</span>`; w.appendChild(modeSel); return w; })(),
    (()=>{ const w = el('div','pfx-qc-ctl'); w.innerHTML = `<span class="k">Merge</span>`; w.appendChild(gapInput); w.appendChild(el('span','pfx-qc-unit','s')); return w; })(),
    (()=>{ const w = el('div','pfx-qc-ctl'); w.innerHTML = `<span class="k">CrewThr</span>`; w.appendChild(thrInput); w.appendChild(el('span','pfx-qc-unit','/255')); return w; })(),
    (()=>{ const w = el('div','pfx-qc-ctl'); w.innerHTML = `<span class="k">PDF Max</span>`; w.appendChild(pdfMaxInput); return w; })(),
    cbCrew,
    cbFraming,
  );

  const presetInfo = el('div','pfx-qc-presetInfo');
  const presetResolved = (()=>{
    try{ return PFX_getBurninPresetForClip(c); }catch{ return null; }
  })();
  const pName = presetResolved?.preset?.name || presetResolved?.presetId || '—';
  const pBadge = presetResolved?.isOverride ? 'Clip Override' : (presetResolved?.isClipPreset ? 'Clip Preset' : 'Project Preset');
  presetInfo.innerHTML = `Burn-in: <b>${escapeHtml(pName)}</b> <span class="pfx-qc-pill">${escapeHtml(pBadge)}</span>`;
  const sourceInfo = el('div','pfx-qc-presetInfo');
  const sourcePreflight = buildPreflightSnapshot({
    clip: c,
    file: c.file,
    durationSec: Number(c?.durationSec) || 0,
    fps: Number(store?.state?.fps) || 24,
    presetResolved,
  });
  const sourcePreflightEval = evaluatePreflightChecks({
    clip: c,
    preflight: sourcePreflight,
    presetResolved,
  });
  sourcePreflight.status = sourcePreflightEval.status;
  sourcePreflight.checks = sourcePreflightEval.checks;
  sourceInfo.innerHTML = `Source: <b>${escapeHtml(preflightSummaryText(sourcePreflight) || 'Pending probe')}</b>`;
  const preflightInfo = el('div','pfx-qc-presetInfo');
  preflightInfo.innerHTML = `Preflight: <b>${escapeHtml(preflightStatusText(sourcePreflight))}</b>`;

  const prog = el('div', 'pfx-qc-progress');
  prog.innerHTML = `
    <div class="pfx-qc-progressBar"><div class="pfx-qc-progressFill" style="width:0%"></div></div>
    <div class="pfx-qc-progressTxt muted">Ready.</div>
  `;
  const progFill = prog.querySelector('.pfx-qc-progressFill');
  const progTxt = prog.querySelector('.pfx-qc-progressTxt');

  controls.append(ctlRow, presetInfo, sourceInfo, preflightInfo, prog);

  const results = el('div', 'pfx-qc-results');
  results.innerHTML = `
    <div class="pfx-qc-resultsHead">
      <div class="pfx-qc-resultsTitle">Results</div>
      <div class="muted" id="pfxQcSummary">—</div>
    </div>
    <div class="pfx-qc-tableWrap">
      <table class="pfx-qc-table">
        <thead>
          <tr>
            <th class="pfx-qc-th-thumb">Thumb</th>
            <th>Type</th>
            <th>OCF</th>
            <th>SRC IN</th>
            <th>SRC OUT</th>
            <th>Range</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody id="pfxQcBody"></tbody>
      </table>
    </div>
  `;
  const summaryEl = results.querySelector('#pfxQcSummary');
  const tbody = results.querySelector('#pfxQcBody');

  body.append(controls, results);
  modal.append(head, body);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const onEscKey = (e)=>{ if (e.key === 'Escape') close(); };
  const close = ()=>{
    abort = true;
    window.removeEventListener('keydown', onEscKey);
    try{ backdrop.remove(); }catch{}
    try{ stopThumbs?.(); }catch{}
  };
  btnClose.addEventListener('click', close);
  backdrop.addEventListener('click', (e)=>{ if (e.target === backdrop) close(); });
  window.addEventListener('keydown', onEscKey);

  let currentReport = c.visualQc || null;

  // Mini thumbnail (lazy) for results list (not persisted to project)
  const thumbCache = new Map(); // ev.id -> dataUrl
  let thumbVideo = null;
  let thumbCanvas = null;
  let thumbCtx = null;
  let thumbQueue = [];
  let thumbBusy = false;
  let thumbKill = false;
  let io = null;
  let thumbEvMap = null; // updated on renderReport

  const ensureThumbVideo = async ()=>{
    if (thumbVideo && thumbVideo.readyState >= 1) return;
    if (!thumbVideo){
      thumbVideo = document.createElement('video');
      thumbVideo.muted = true;
      thumbVideo.playsInline = true;
      thumbVideo.preload = 'auto';
      thumbVideo.src = _resolveQcUrl(c);
    }
    const vid = thumbVideo; // capture before any async gap so cleanup() doesn't close over the mutable ref
    await new Promise((resolve, reject)=>{
      const onMeta = ()=>{ cleanup(); resolve(); };
      const onErr = ()=>{ cleanup(); reject(new Error('Failed to load video for thumbnails')); };
      const cleanup = ()=>{
        vid.removeEventListener('loadedmetadata', onMeta);
        vid.removeEventListener('error', onErr);
      };
      vid.addEventListener('loadedmetadata', onMeta);
      vid.addEventListener('error', onErr);
    });
    if (thumbKill) throw new Error('Stopped'); // stopThumbs() may have fired during the await above
    if (!thumbCanvas){
      const vw = Math.max(2, Number(thumbVideo.videoWidth) || 1920);
      const vh = Math.max(2, Number(thumbVideo.videoHeight) || 1080);
      const aspect = vw / vh;
      const w = 256;
      const h = Math.max(2, Math.round(w / Math.max(0.1, aspect)));
      thumbCanvas = document.createElement('canvas');
      thumbCanvas.width = w;
      thumbCanvas.height = h;
      thumbCtx = thumbCanvas.getContext('2d', { willReadFrequently:false });
    }
  };

  const seekThumb = async (t)=>{
    if (thumbKill) throw new Error('Stopped');
    await ensureThumbVideo();
    const dur = Math.max(0, Number(thumbVideo.duration) || 0);
    const tt = Math.max(0, Math.min(dur - 0.001, Number(t) || 0));
    if (Math.abs(thumbVideo.currentTime - tt) < 0.0005) return;
    await new Promise((resolve, reject)=>{
      let timer = null;
      const onSeeked = ()=>{ clearTimeout(timer); cleanup(); resolve(); };
      const onErr = ()=>{ clearTimeout(timer); cleanup(); reject(new Error('Seek failed during thumbnail capture')); };
      const cleanup = ()=>{
        thumbVideo.removeEventListener('seeked', onSeeked);
        thumbVideo.removeEventListener('error', onErr);
      };
      thumbVideo.addEventListener('seeked', onSeeked);
      thumbVideo.addEventListener('error', onErr);
      timer = setTimeout(()=>{ cleanup(); reject(new Error('Thumb seek timeout')); }, 15_000);
      try{ thumbVideo.currentTime = tt; }catch(e){ clearTimeout(timer); cleanup(); reject(e); }
    });
  };

  const drawThumbWithMark = (ev)=>{
    if (!thumbCtx || !thumbCanvas) return '';
    const w = thumbCanvas.width, h = thumbCanvas.height;
    try{ thumbCtx.drawImage(thumbVideo, 0, 0, w, h); }catch{}
    const bb = ev?.evidence?.bbox_norm;
    if (Array.isArray(bb) && bb.length === 4){
      try{
        const x = bb[0] * w;
        const y = bb[1] * h;
        const w0 = bb[2] * w;
        const h0 = bb[3] * h;
        thumbCtx.save();
        thumbCtx.lineWidth = Math.max(2, Math.round(w * 0.012));
        thumbCtx.strokeStyle = 'rgba(255,64,64,0.95)';
        thumbCtx.fillStyle = 'rgba(255,64,64,0.10)';
        thumbCtx.strokeRect(x, y, w0, h0);
        thumbCtx.fillRect(x, y, w0, h0);
        thumbCtx.restore();
      }catch{}
    }
    try{ return thumbCanvas.toDataURL('image/jpeg', 0.72); }catch{ return ''; }
  };

  const pumpThumbs = async ()=>{
    if (thumbBusy) return;
    thumbBusy = true;
    try{
      while (thumbQueue.length && !thumbKill){
        const job = thumbQueue.shift();
        if (!job) continue;
        const { ev, imgEl } = job;
        if (!imgEl || !imgEl.isConnected) continue;
        if (thumbCache.has(ev.id)){
          imgEl.src = thumbCache.get(ev.id);
          imgEl.classList.add('is-ready');
          continue;
        }
        if (imgEl.dataset.wantThumb !== '1') continue;

        const mid = (Number(ev.start_sec)||0) + ((Number(ev.end_sec)||0) - (Number(ev.start_sec)||0)) * 0.5;
        const keySec = Number(ev?.evidence?.key_sec);
        const tCap = Number.isFinite(keySec) ? keySec : mid;
        try{
          await seekThumb(tCap);
          const url = drawThumbWithMark(ev);
          if (url){
            thumbCache.set(ev.id, url);
            if (imgEl.isConnected && imgEl.dataset.wantThumb === '1'){
              imgEl.src = url;
              imgEl.classList.add('is-ready');
            }
          }
        }catch{}
      }
    } finally {
      thumbBusy = false;
    }
  };

  const requestThumb = (ev, imgEl)=>{
    if (!ev?.id || !imgEl) return;
    imgEl.dataset.wantThumb = '1';
    if (thumbCache.has(ev.id)){
      imgEl.src = thumbCache.get(ev.id);
      imgEl.classList.add('is-ready');
      return;
    }
    if (!thumbQueue.some(j=>j?.ev?.id === ev.id && j?.imgEl === imgEl)){
      thumbQueue.push({ ev, imgEl });
      pumpThumbs();
    }
  };

  const stopThumbs = ()=>{
    thumbKill = true;
    thumbQueue = [];
    try{ io?.disconnect?.(); }catch{}
    io = null;
    try{ if (thumbVideo){ thumbVideo.pause?.(); thumbVideo.src = ''; } }catch{}
    thumbVideo = null;
    thumbCanvas = null;
    thumbCtx = null;
  };

  const setupThumbObserver = ()=>{
    try{ io?.disconnect?.(); }catch{}
    io = null;
    const root = results.querySelector('.pfx-qc-tableWrap') || null;
    if (!root) return;
    io = new IntersectionObserver((entries)=>{
      for (const ent of entries){
        const imgEl = ent.target;
        if (!imgEl) continue;
        if (!ent.isIntersecting){ imgEl.dataset.wantThumb = '0'; continue; }
        const evId = imgEl.dataset.evId;
        const ev = thumbEvMap?.get?.(evId);
        if (ev) requestThumb(ev, imgEl);
      }
    }, { root, threshold: 0.05 });
  };
  const renderReport = (rep)=>{
    tbody.innerHTML = '';
    if (rep?.preflight){
      try{ sourceInfo.innerHTML = `Source: <b>${escapeHtml(preflightSummaryText(rep.preflight) || 'Pending probe')}</b>`; }catch{}
      try{ preflightInfo.innerHTML = `Preflight: <b>${escapeHtml(preflightStatusText(rep.preflight))}</b>`; }catch{}
    }
    if (!rep || !Array.isArray(rep.events) || !rep.events.length){
      const pf = preflightSummaryText(rep?.preflight);
      summaryEl.textContent = pf ? `No events • ${pf}` : 'No events.';
      return;
    }

    // Update mapping for lazy thumbnails; clear stale cache entries from prior scans
    thumbCache.clear();
    thumbEvMap = new Map();
    for (const ev of rep.events){
      if (ev?.id) thumbEvMap.set(ev.id, ev);
    }
    setupThumbObserver();

    const countsTxt = countSummaryText(rep?.summary?.counts);
    const pf = preflightSummaryText(rep?.preflight);
    const bits = [`${rep.events.length} event(s)`];
    if (countsTxt) bits.push(countsTxt);
    if (pf) bits.push(pf);
    bits.push(`updated ${new Date(rep.updatedAt || Date.now()).toLocaleString()}`);
    summaryEl.textContent = bits.join(' • ');
    for (const ev of rep.events){
      const tr = document.createElement('tr');

      const tdThumb = document.createElement('td');
      tdThumb.className = 'pfx-qc-thumbcell';
      const img = document.createElement('img');
      img.className = 'pfx-qc-thumb';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.dataset.evId = ev.id;
      img.dataset.wantThumb = '0';
      tdThumb.appendChild(img);

      const tdType = document.createElement('td');
      tdType.innerHTML = `<span class="pfx-qc-tag">${escapeHtml(formatEventLabel(ev))}</span>`;

      const tdOcf = document.createElement('td');
      tdOcf.className = 'mono';
      tdOcf.textContent = ev.shot?.ocf_name || '';

      const tdIn = document.createElement('td');
      tdIn.className = 'mono';
      tdIn.textContent = ev.timecode?.src_tc_in || '';

      const tdOut = document.createElement('td');
      tdOut.className = 'mono';
      tdOut.textContent = ev.timecode?.src_tc_out || '';

      const tdRange = document.createElement('td');
      tdRange.className = 'mono';
      tdRange.textContent = `${fmtClock(ev.start_sec)}–${fmtClock(ev.end_sec)}`;

      const tdScore = document.createElement('td');
      tdScore.className = 'mono';
      tdScore.textContent = Number(ev.evidence?.score ?? 0).toFixed(3);

      tr.append(tdThumb, tdType, tdOcf, tdIn, tdOut, tdRange, tdScore);
      tr.addEventListener('click', async ()=>{
        try{ await jumpToSec?.(Number(ev.start_sec) || 0); }catch{}
      });
      tbody.appendChild(tr);

      try{ io?.observe?.(img); }catch{}
    }
  };
  renderReport(currentReport);

  // Optional: auto-run scan (used by playhead QC button)
  try{
    if (autoRun){
      setTimeout(()=>{ try{ scan(); }catch{} }, 0);
    }
  }catch{}

  const setProgress = (p, text)=>{
    const pct = Math.max(0, Math.min(100, Math.round((Number(p)||0) * 100)));
    progFill.style.width = `${pct}%`;
    progTxt.textContent = text || '';
    try{ onStatus?.(text || ''); }catch{}
  };

  const setBusy = (on)=>{
    btnRun.disabled = !!on;
    btnExportJson.disabled = !!on;
    btnExportCsv.disabled = !!on;
    btnExportPdf.disabled = !!on;
    modeSel.disabled = !!on;
    gapInput.disabled = !!on;
    thrInput.disabled = !!on;
    pdfMaxInput.disabled = !!on;
    cbCrew.querySelector('input').disabled = !!on;
    cbFraming.querySelector('input').disabled = !!on;
  };

  let abort = false;
  const cancelBtn = el('button', 'btn theme-danger', 'Cancel');
  cancelBtn.innerHTML = '<span class="bar"></span>Cancel';
  cancelBtn.style.display = 'none';
  headR.insertBefore(cancelBtn, btnRun);
  cancelBtn.addEventListener('click', ()=>{ abort = true; });

  async function scan(){
    if (abort) return; // guard: close() may have fired before the autoRun setTimeout callback
    abort = false;
    setBusy(true);
    cancelBtn.style.display = '';
    let video = null;
    let canvas = null;
    let frCanvas = null;
    let canvas2 = null;
    try{
      setProgress(0, 'Preparing…');

      const mode = String(modeSel.value || 'normal');
      const sampleFps = mode === 'quick' ? 0.5 : (mode === 'dense' ? 2.0 : 1.0);
      const mergeGap = Math.max(0.2, Number(gapInput.value) || 1.0);
      const edgeThr = Math.max(4, Number(thrInput.value) || 14);
      const doCrew = !!cbCrew.querySelector('input').checked;
      const doFraming = !!cbFraming.querySelector('input').checked;
      const doEdge = doCrew;
      const doHi = doCrew;

      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = _resolveQcUrl(c);

      await new Promise((resolve, reject)=>{
        const onMeta = ()=>{ cleanup(); resolve(); };
        const onErr = ()=>{ cleanup(); reject(new Error('Failed to load video metadata')); };
        const cleanup = ()=>{
          video.removeEventListener('loadedmetadata', onMeta);
          video.removeEventListener('error', onErr);
        };
        video.addEventListener('loadedmetadata', onMeta);
        video.addEventListener('error', onErr);
      });

      const dur = Math.max(0, Number(video.duration) || 0);
      if (!dur || !Number.isFinite(dur)) throw new Error('Unknown duration');
      const preflight = buildPreflightSnapshot({
        clip: c,
        file: c.file,
        video,
        durationSec: dur,
        fps: Number(store?.state?.fps) || 24,
        presetResolved,
      });
      const preflightEval = evaluatePreflightChecks({
        clip: c,
        preflight,
        presetResolved,
      });
      preflight.status = preflightEval.status;
      preflight.checks = preflightEval.checks;
      sourceInfo.innerHTML = `Source: <b>${escapeHtml(preflightSummaryText(preflight) || 'Pending probe')}</b>`;
      preflightInfo.innerHTML = `Preflight: <b>${escapeHtml(preflightStatusText(preflight))}</b>`;

      // Optional: scan only a window (e.g. around playhead).
      let scanStart = 0;
      let scanEnd = dur;
      try{
        if (rangeSec && typeof rangeSec === 'object'){
          const rs = Number(rangeSec.start);
          const re = Number(rangeSec.end);
          if (Number.isFinite(rs)) scanStart = Math.max(0, Math.min(dur, rs));
          if (Number.isFinite(re)) scanEnd = Math.max(0, Math.min(dur, re));
          if (scanEnd <= scanStart + 0.05){
            // Ensure non-empty window
            scanEnd = Math.min(dur, scanStart + 0.5);
          }
        }
      }catch{}

      const capW = 640;
      const aspect = (video.videoWidth && video.videoHeight) ? (video.videoWidth / video.videoHeight) : (16/9);
      const capH = Math.max(2, Math.round(capW / Math.max(0.1, aspect)));
      canvas = document.createElement('canvas');
      canvas.width = capW;
      canvas.height = capH;
      const g = canvas.getContext('2d', { willReadFrequently: true });

      // Framing detector works on a much smaller canvas to keep it fast.
      const frW = 96;
      const frH = Math.max(2, Math.round(frW / Math.max(0.1, aspect)));
      frCanvas = document.createElement('canvas');
      frCanvas.width = frW;
      frCanvas.height = frH;
      const frG = frCanvas.getContext('2d', { willReadFrequently: true });

      const stepSec = 1 / Math.max(0.1, sampleFps);
      const totalSteps = Math.max(1, Math.ceil((Math.max(0.0001, (scanEnd - scanStart))) / stepSec));

      const hits = [];
      let prevImg = null;
      let prevHi = 0;
      let prevFr = null;

      const sadShift = (aImg, bImg, dx=0, dy=0)=>{
        // avg abs luma diff between aImg (shifted) and bImg
        const w = frW, h = frH;
        const a = aImg.data, b = bImg.data;
        const x0 = Math.max(0, dx);
        const y0 = Math.max(0, dy);
        const x1 = Math.min(w, w + Math.min(0, dx));
        const y1 = Math.min(h, h + Math.min(0, dy));
        let sum = 0;
        let n = 0;
        for (let y=y0; y<y1; y++){
          for (let x=x0; x<x1; x++){
            const ax = x - dx;
            const ay = y - dy;
            const ia = (ay*w + ax) * 4;
            const ib = (y*w + x) * 4;
            const la = meanLumaFromRGBA(a, ia);
            const lb = meanLumaFromRGBA(b, ib);
            sum += Math.abs(la - lb);
            n++;
          }
        }
        return n ? (sum / n) : 0;
      };

      const sadScale = (aImg, bImg, scale=1.0)=>{
        // Compare aImg scaled about center to bImg (nearest sampling)
        const w = frW, h = frH;
        const a = aImg.data, b = bImg.data;
        const cx = (w - 1) / 2;
        const cy = (h - 1) / 2;
        let sum = 0;
        let n = 0;
        for (let y=0; y<h; y++){
          const ayF = (y - cy) / scale + cy;
          const ay = Math.round(ayF);
          if (ay < 0 || ay >= h) continue;
          for (let x=0; x<w; x++){
            const axF = (x - cx) / scale + cx;
            const ax = Math.round(axF);
            if (ax < 0 || ax >= w) continue;
            const ia = (ay*w + ax) * 4;
            const ib = (y*w + x) * 4;
            const la = meanLumaFromRGBA(a, ia);
            const lb = meanLumaFromRGBA(b, ib);
            sum += Math.abs(la - lb);
            n++;
          }
        }
        return n ? (sum / n) : 0;
      };

      const seekTo = async (t)=>{
        if (abort) throw new Error('Cancelled');
        const tt = Math.max(0, Math.min(dur - 0.001, t));
        if (Math.abs(video.currentTime - tt) < 0.0005) return;
        await new Promise((resolve, reject)=>{
          let timer = null;
          const onSeeked = ()=>{ clearTimeout(timer); cleanup(); resolve(); };
          const onErr = ()=>{ clearTimeout(timer); cleanup(); reject(new Error('Seek failed')); };
          const cleanup = ()=>{
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onErr);
          };
          video.addEventListener('seeked', onSeeked);
          video.addEventListener('error', onErr);
          timer = setTimeout(()=>{ cleanup(); reject(new Error('Seek timeout')); }, 15_000);
          try{ video.currentTime = tt; }catch(e){ clearTimeout(timer); cleanup(); reject(e); }
        });
      };

      for (let i=0;i<totalSteps;i++){
        const t = scanStart + (i * stepSec);
        setProgress(i/totalSteps, `Scanning… ${i+1}/${totalSteps}`);
        await seekTo(t);
        g.drawImage(video, 0, 0, capW, capH);
        const img = g.getImageData(0, 0, capW, capH);

        // Small frame for framing detection
        let frImg = null;
        if (doFraming){
          try{
            frG.drawImage(video, 0, 0, frW, frH);
            frImg = frG.getImageData(0, 0, frW, frH);
          }catch{ frImg = null; }
        }

        if (prevImg){
          if (doEdge){
            const edge = 0.12;
            const regTop = { name:'top', rx0:0, ry0:0, rx1:1, ry1:edge };
            const regLeft = { name:'left', rx0:0, ry0:0, rx1:edge, ry1:1-edge };
            const regRight = { name:'right', rx0:1-edge, ry0:0, rx1:1, ry1:1-edge };

            const top = { ...regionScore(prevImg, img, capW, capH, regTop.rx0, regTop.ry0, regTop.rx1, regTop.ry1, { step:2, pixelThr:25 }), reg: regTop };
            const left = { ...regionScore(prevImg, img, capW, capH, regLeft.rx0, regLeft.ry0, regLeft.rx1, regLeft.ry1, { step:2, pixelThr:25 }), reg: regLeft };
            const right = { ...regionScore(prevImg, img, capW, capH, regRight.rx0, regRight.ry0, regRight.rx1, regRight.ry1, { step:2, pixelThr:25 }), reg: regRight };
            const best = [top,left,right].sort((a,b)=>b.avgDiff-a.avgDiff)[0];
            // score: avgDiff normalized + changedFrac weighting
            const score = (best.avgDiff/255) * 0.7 + (best.changedFrac) * 0.3;
            if (best.avgDiff >= edgeThr && best.changedFrac >= 0.012){
              const bbox = hotspotBboxFromDiff(
                prevImg,
                img,
                capW,
                capH,
                best.reg.rx0,
                best.reg.ry0,
                best.reg.rx1,
                best.reg.ry1,
                { step:3, pixelThr:25, gridX: 24, gridY: 10, padPct: 0.014 }
              );
              hits.push({ t, type:'crew_edge', score, bbox, meta:{ kind:'edge', edge: String(best?.reg?.name||'') } });
            }
          }

          if (doHi){
            const hi = highlightSpikeScore(img, capW, capH, { excludeBottomPct: 0.28, brightThr: 245, step: 2 });
            const spike = Math.max(0, hi.brightFrac - prevHi);
            if (spike >= 0.010){
              const bbox = hotspotBboxFromBright(img, capW, capH, { excludeBottomPct: 0.28, brightThr: 245, step: 3, gridX: 24, gridY: 12, padPct: 0.014 });
              hits.push({ t, type:'reflection_spike', score: spike, bbox, meta:{ kind:'reflection' } });
            }
            prevHi = hi.brightFrac;
          }

          // Framing Error heuristic: detect sudden global shift/zoom mid-shot.
          if (doFraming && prevFr && frImg){
            const base = sadShift(prevFr, frImg, 0, 0);

            // Guard against hard cuts (base diff too large)
            const CUT_MAX = 85; // avg luma diff (0-255). higher => likely cut
            const MIN_BASE = 10; // ignore near-identical frames
            if (base >= MIN_BASE && base <= CUT_MAX){
              let best = base;
              let bestMeta = null;

              // small shifts (up to 2 px in the tiny frame)
              for (let dy=-2; dy<=2; dy++){
                for (let dx=-2; dx<=2; dx++){
                  if (dx===0 && dy===0) continue;
                  const d = sadShift(prevFr, frImg, dx, dy);
                  if (d < best){
                    best = d;
                    bestMeta = { method:'shift', dx, dy };
                  }
                }
              }

              // small zoom candidates
              const zIn = sadScale(prevFr, frImg, 1.04);
              if (zIn < best){ best = zIn; bestMeta = { method:'zoom_in', scale: 1.04 }; }
              const zOut = sadScale(prevFr, frImg, 0.96);
              if (zOut < best){ best = zOut; bestMeta = { method:'zoom_out', scale: 0.96 }; }

              const improve = base - best;
              const improveRatio = base > 0 ? (improve / base) : 0;
              if (bestMeta && improve >= 6 && improveRatio >= 0.18){
                const score = Math.max(0, Math.min(1, improve / 255));
                // Framing error affects whole frame: mark nearly full-frame bbox.
                const bbox = [0.02, 0.02, 0.96, 0.96];
                hits.push({ t, type:'framing_error', score, bbox, meta: bestMeta });
              }
            }
          }
        } else {
          if (doHi){
            const hi = highlightSpikeScore(img, capW, capH, { excludeBottomPct: 0.28, brightThr: 245, step: 2 });
            prevHi = hi.brightFrac;
          }
        }

        prevImg = img;
        if (doFraming && frImg) prevFr = frImg;
        if (abort) throw new Error('Cancelled');
      }

      setProgress(0.82, `Merging hits… (${hits.length})`);
      hits.sort((a,b)=>a.t-b.t);
      const events0 = mergeHitsToEvents(hits, mergeGap);

      // Build report skeleton
      const report = {
        version: '0.2',
        updatedAt: new Date().toISOString(),
        clip: { id: c.id, name: c.name || '', fileName: c.file?.name || '' },
        preflight,
        scan: {
          mode,
          sampleFps,
          mergeGap,
          edgeThr,
          edgeThrUnit: 'luma-diff/255',
          doCrew,
          doFraming,
          doEdge,
          doHi,
          durationSec: dur,
          engines: {
            visibleCrew: doCrew ? ['edge-intrusion-diff', 'reflection-spike'] : [],
            framingError: doFraming ? ['global-shift-heuristic', 'micro-zoom-heuristic'] : [],
            burnIn: ['tesseract-ocr'],
          },
        },
        events: [],
        summary: { counts: {}, total: 0 }
      };

      if (!events0.length){
        report.summary.total = 0;
        store?.updateClip?.(c.id, { visualQc: report });
        currentReport = report;
        renderReport(report);
        setProgress(1, 'Done. No events.');
        return;
      }

      // OCR only on events (start/end). Use bigger capture for OCR.
      const capW2 = 1280;
      const capH2 = Math.max(2, Math.round(capW2 / Math.max(0.1, aspect)));
      canvas2 = document.createElement('canvas');
      canvas2.width = capW2;
      canvas2.height = capH2;
      const g2 = canvas2.getContext('2d', { willReadFrequently: true });

      const preset = (()=>{
        try{ return PFX_getBurninPresetForClip(c)?.preset || null; }catch{ return null; }
      })();
      const fields = preset?.fields || {};
      const fTc = fields?.src_tc;
      const fOcf = fields?.ocf;
      const reTc = buildRegex(fTc?.regex, "\\b\\d{2}:\\d{2}:\\d{2}:\\d{2}\\b");
      const reOcf = buildRegex(fOcf?.regex, "\\b[\\w.-]+\\.(mxf|mov|mp4)\\b");
      const ocr = getOcrClient();

      const readBurninAt = async (t)=>{
        await seekTo(t);
        g2.drawImage(video, 0, 0, capW2, capH2);
        const out = { ocf:'', tc:'' };
        if (fTc?.enabled !== false && fTc?.roi){
          const crop = cropFromCanvas(canvas2, fTc.roi, 1600);
          const pre = preprocessForOcr(crop);
          if (pre) {
            const raw = await ocr.recognize(pre, fTc.ocr || { psm:7, whitelist:'0123456789:' });
            out.tc = firstMatch(raw, reTc) || '';
          }
        }
        if (fOcf?.enabled !== false && fOcf?.roi){
          const crop = cropFromCanvas(canvas2, fOcf.roi, 1600);
          const pre = preprocessForOcr(crop);
          if (pre) {
            const raw = await ocr.recognize(pre, fOcf.ocr || { psm:7, whitelist:'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_./-' });
            out.ocf = firstMatch(raw, reOcf) || '';
          }
        }
        return out;
      };

      for (let i=0;i<events0.length;i++){
        if (abort) throw new Error('Cancelled');
        const e0 = events0[i];
        setProgress(0.84 + (i / events0.length) * 0.14, `Resolving burn-in… ${i+1}/${events0.length}`);

        const bIn = await readBurninAt(e0.start);
        const bOut = await readBurninAt(e0.end);
        const ocf = (bIn.ocf || bOut.ocf || '').trim();
        const tcIn = (bIn.tc || '').trim();
        const tcOut = (bOut.tc || '').trim();
        const priority = (e0.type === 'framing_error' || e0.type === 'crew_edge') ? 'high' : 'medium';

        const asset = getAssetQcForEvent({ type: e0.type });
        const scoreNum = Number(e0.maxScore) || 0;
        const severitySuggest = (()=>{
          if (e0.type === 'framing_error') return 'Issue';
          if (e0.type === 'crew_edge') return (scoreNum >= 0.10 ? 'Issue' : 'FYI');
          if (e0.type === 'reflection_spike') return (scoreNum >= 0.02 ? 'Issue' : 'FYI');
          return '';
        })();

        const ev = {
          id: uid(),
          type: e0.type,
          priority,
          start_sec: Number(e0.start) || 0,
          end_sec: Number(e0.end) || 0,
          asset_qc: asset ? { code: asset.code || '', name: asset.name || '', ref: asset.ref || '', severity_suggest: severitySuggest } : null,
          shot: { ocf_name: ocf, ocf_base: ocf ? ocf.replace(/\.(mxf|mov|mp4)$/i,'') : '' },
          timecode: { src_tc_in: tcIn, src_tc_out: tcOut },
          evidence: {
            score: scoreNum,
            key_sec: e0.keyT != null ? Number(e0.keyT) : (Number(e0.start) || 0),
            bbox_norm: Array.isArray(e0.keyBbox) ? e0.keyBbox : null,
            meta: (e0.keyMeta || null),
          },
        };
        report.events.push(ev);
        report.summary.counts[ev.type] = (report.summary.counts[ev.type] || 0) + 1;
      }
      report.summary.total = report.events.length;

      // Persist on clip
      store?.updateClip?.(c.id, { visualQc: report });
      currentReport = report;
      renderReport(report);
      setProgress(1, 'Done.');
    }finally{
      setBusy(false);
      cancelBtn.style.display = 'none';
      try{ video?.pause(); if (video) video.src = ''; }catch{}
      try{ if (canvas) canvas.width = 0; }catch{}
      try{ if (frCanvas) frCanvas.width = 0; }catch{}
      try{ if (canvas2) canvas2.width = 0; }catch{}
    }
  }

  btnRun.addEventListener('click', ()=> scan().catch(err=>{
    try{ setProgress(0, err?.message || String(err)); }catch{}
  }));

  btnExportJson.addEventListener('click', async ()=>{
    const rep = currentReport || (store?.state?.clips?.find(x=>x.id===c.id)?.visualQc) || null;
    if (!rep) return;
    const name = safeName((rep.clip?.name || c.name || c.file?.name || 'clip'));
    const outcome = await downloadOrSaveText(`${name}_visual_qc.json`, JSON.stringify(rep, null, 2), 'application/json');
    setProgress(outcome === SAVED ? 1 : 0, saveNotice(outcome).text);
  });

  btnExportCsv.addEventListener('click', async ()=>{
    const rep = currentReport || (store?.state?.clips?.find(x=>x.id===c.id)?.visualQc) || null;
    if (!rep) return;
    const name = safeName((rep.clip?.name || c.name || c.file?.name || 'clip'));
    const outcome = await downloadOrSaveText(`${name}_visual_qc.csv`, reportToCsv(rep), 'text/csv');
    setProgress(outcome === SAVED ? 1 : 0, saveNotice(outcome).text);
  });

  btnExportPdf.addEventListener('click', async ()=>{
    const rep = currentReport || (store?.state?.clips?.find(x=>x.id===c.id)?.visualQc) || null;
    if (!rep || !Array.isArray(rep.events) || !rep.events.length) return;

    abort = false;
    setBusy(true);
    cancelBtn.style.display = '';
    let video = null;
    let canvas = null;

    try{
      const nameBase = safeName((rep.clip?.name || c.name || c.file?.name || 'clip'));
      const maxN = Math.max(1, Math.min(300, Number(pdfMaxInput.value) || 60));

      // Sort by score (desc) and take top N for a practical PDF size.
      const events = rep.events
        .slice()
        .sort((a,b)=> (Number(b?.evidence?.score)||0) - (Number(a?.evidence?.score)||0))
        .slice(0, maxN);

      setProgress(0.02, `Capturing stills… 0/${events.length}`);

      // Load video for still capture
      video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.src = _resolveQcUrl(c);

      await new Promise((resolve, reject)=>{
        const onMeta = ()=>{ cleanup(); resolve(); };
        const onErr = ()=>{ cleanup(); reject(new Error('Failed to load video for still capture')); };
        const cleanup = ()=>{
          video.removeEventListener('loadedmetadata', onMeta);
          video.removeEventListener('error', onErr);
        };
        video.addEventListener('loadedmetadata', onMeta);
        video.addEventListener('error', onErr);
      });

      const dur = Math.max(0, Number(video.duration) || 0);
      const vw = Math.max(2, Number(video.videoWidth) || 1920);
      const vh = Math.max(2, Number(video.videoHeight) || 1080);
      const aspect = vw / vh;

      const capW = Math.min(1280, vw);
      const capH = Math.max(2, Math.round(capW / Math.max(0.1, aspect)));
      canvas = document.createElement('canvas');
      canvas.width = capW;
      canvas.height = capH;
      const g = canvas.getContext('2d', { willReadFrequently: false });

      const seekTo = async (t)=>{
        if (abort) throw new Error('Cancelled');
        const tt = Math.max(0, Math.min(dur - 0.001, t));
        if (Math.abs(video.currentTime - tt) < 0.0005) return;
        await new Promise((resolve, reject)=>{
          let timer = null;
          const onSeeked = ()=>{ clearTimeout(timer); cleanup(); resolve(); };
          const onErr = ()=>{ clearTimeout(timer); cleanup(); reject(new Error('Seek failed during still capture')); };
          const cleanup = ()=>{
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onErr);
          };
          video.addEventListener('seeked', onSeeked);
          video.addEventListener('error', onErr);
          timer = setTimeout(()=>{ cleanup(); reject(new Error('Seek timeout')); }, 15_000);
          try{ video.currentTime = tt; }catch(e){ clearTimeout(timer); cleanup(); reject(e); }
        });
      };

      const items = [];
      for (let i=0;i<events.length;i++){
        if (abort) throw new Error('Cancelled');
        const ev = events[i];
        const mid = (Number(ev.start_sec)||0) + ((Number(ev.end_sec)||0) - (Number(ev.start_sec)||0)) * 0.5;
        const keySec = Number(ev?.evidence?.key_sec);
        const tCap = Number.isFinite(keySec) ? keySec : mid;
        await seekTo(tCap);
        try{ g.drawImage(video, 0, 0, capW, capH); }catch{}

        // Auto-mark: draw bbox if available.
        const bb = ev?.evidence?.bbox_norm;
        if (Array.isArray(bb) && bb.length === 4){
          try{
            const x = bb[0] * capW;
            const y = bb[1] * capH;
            const w0 = bb[2] * capW;
            const h0 = bb[3] * capH;
            g.save();
            g.lineWidth = Math.max(2, Math.round(capW * 0.004));
            g.strokeStyle = 'rgba(255,64,64,0.95)';
            g.fillStyle = 'rgba(255,64,64,0.10)';
            g.strokeRect(x, y, w0, h0);
            g.fillRect(x, y, w0, h0);
            g.restore();
          }catch{}
        }

        let imgDataUrl = '';
        try{ imgDataUrl = canvas.toDataURL('image/jpeg', 0.85); }catch{}
        items.push({
          type: formatEventLabel(ev),
          imgDataUrl,
          fields: [
            { k:'Asset QC', v: `${ev.asset_qc?.code ? ('['+ev.asset_qc.code+'] ') : ''}${ev.asset_qc?.name || ''}`.trim() },
            { k:'OCF', v: ev.shot?.ocf_name || '' },
            { k:'SRC IN', v: ev.timecode?.src_tc_in || '' },
            { k:'SRC OUT', v: ev.timecode?.src_tc_out || '' },
            { k:'Range', v: `${fmtClock(ev.start_sec)}–${fmtClock(ev.end_sec)}` },
            { k:'Score', v: String((Number(ev.evidence?.score)||0).toFixed(3)) },
          ]
        });
        setProgress(0.02 + (i+1)/events.length * 0.78, `Capturing stills… ${i+1}/${events.length}`);
      }

      setProgress(0.85, 'Building report…');

      const metaLines = [];
      try{
        const scan = rep.scan || {};
        const pf = rep.preflight || {};
        metaLines.push(`Mode: ${scan.mode || ''} • ${scan.sampleFps ? (scan.sampleFps + ' fps') : ''} • Merge: ${scan.mergeGap ?? ''}s`);
        metaLines.push(`Source: ${[pf.extension ? pf.extension.toUpperCase() : '', pf.raster || '', pf.aspectRatio || '', pf.durationLabel || '', pf.sizeLabel || ''].filter(Boolean).join(' • ')}`);
        metaLines.push(`Preflight: ${preflightStatusText(pf)}`);
        metaLines.push(`CrewThr: ${scan.edgeThr ?? ''} ${scan.edgeThrUnit ? '(' + scan.edgeThrUnit + ')' : ''} • Visible Crew/Equipment [096]: ${scan.doCrew ? 'ON' : 'OFF'} • Framing Error: ${scan.doFraming ? 'ON' : 'OFF'}`);
        metaLines.push(`Engines: Crew = heuristic edge/reflection scan • Framing = shift/zoom heuristic • Burn-in = Tesseract OCR`);
      }catch{}
      metaLines.push(`Items: Top ${events.length} by score (PDF Max = ${maxN})`);
      metaLines.push(`OCF = primary key • SRC TC = time truth (from Burn-in preset)`);

      const html = buildPrintHtmlReport({
        title: 'Visual QC Report',
        subtitle: rep.clip?.name || c.name || c.file?.name || '',
        metaLines,
        items
      });

      setProgress(0.95, 'Opening print dialog…');
      const how = await openPrintReportHtml({ filenameBase: nameBase, html });
      if (how === PRINTED){
        setProgress(1, 'Ready. Use “Save as PDF” in the print dialog.');
      } else if (how === SAVED){
        // The popup was blocked, so there is no print dialog to point at. Point
        // at the file that did get written instead.
        setProgress(1, 'Report saved as HTML. Open it and print to PDF.');
      } else {
        setProgress(0, saveNotice(how).text);
      }
    }catch(err){
      setProgress(0, err?.message || String(err));
    }finally{
      setBusy(false);
      cancelBtn.style.display = 'none';
      try{ video?.pause(); if (video) video.src = ''; }catch{}
      try{ if (canvas) canvas.width = 0; }catch{}
    }
  });

  return { close };
}
