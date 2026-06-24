/**
 * nanoTracker.js — PostFlowX NanoTrack V2 neural single-object tracker
 *
 * Model: NanoTrack V2 (Apache-2.0)
 *   nanotrack_backbone_sim.onnx  ~1.0 MB
 *   nanotrack_head_sim.onnx      ~0.7 MB
 *   Source: github.com/HonglinChu/SiamTrackers/tree/master/NanoTrack/models/nanotrackv2
 *
 * Architecture: Siamese network
 *   - Backbone extracts deep features from a 127×127 template crop and a 255×255 search crop
 *   - Head cross-correlates them, outputs a 17×17 score map + 4×17×17 bbox regression
 *   - Deep features handle fast motion, texture repeats, and lighting changes far better
 *     than pixel-level template matching
 *
 * Usage:
 *   const t = new NanoTracker();
 *   await t.init(canvas, {x1,y1,x2,y2});        // first frame
 *   const box = await t.track(canvas);            // subsequent frames → {x1,y1,x2,y2,score}
 *   t.dispose();
 */

const MODEL_BASE = 'https://raw.githubusercontent.com/HonglinChu/SiamTrackers/master/NanoTrack/models/nanotrackv2/';
const BACKBONE_URL = MODEL_BASE + 'nanotrack_backbone_sim.onnx';
const HEAD_URL     = MODEL_BASE + 'nanotrack_head_sim.onnx';
const ORT_CDN      = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js';

// ImageNet normalization constants
const MEAN = [123.675, 116.28, 103.53];
const STD  = [58.395,  57.12,  57.375];

// Tracker constants
const TEMPLATE_SZ   = 127;
const SEARCH_SZ     = 255;
const SCORE_SZ      = 17;       // output score map size (255 / 16 + 1 ≈ 17)
const STRIDE        = 16;
const CONTEXT_AMOUNT = 0.5;     // context padding ratio for crop extraction
const PENALTY_K     = 0.062;    // scale/ratio change penalty
const LR            = 0.765;    // tracking learning rate (bbox size EMA)
const WINDOW_INF    = 0.25;     // Hanning window influence
const SCORE_THRESH  = 0.35;     // minimum confidence to accept result

// ── Utilities ─────────────────────────────────────────────────────────────────

function _cosineWindow1D(n) {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
  return w;
}
function _hanning2D(sz) {
  const h = _cosineWindow1D(sz);
  const w = new Float32Array(sz * sz);
  for (let r = 0; r < sz; r++) for (let c = 0; c < sz; c++) w[r*sz+c] = h[r]*h[c];
  return w;
}

// Extract a square crop centered at (cx,cy) with side s from a canvas.
// Pads with mean-color if the crop exceeds image boundaries.
function _extractCrop(sourceCanvas, cx, cy, s, outSz) {
  const oc = new OffscreenCanvas(outSz, outSz);
  const ctx = oc.getContext('2d');
  // Fill with ImageNet mean color as padding
  ctx.fillStyle = `rgb(${Math.round(MEAN[0])},${Math.round(MEAN[1])},${Math.round(MEAN[2])})`;
  ctx.fillRect(0, 0, outSz, outSz);
  const srcX = cx - s / 2, srcY = cy - s / 2;
  // Map source rect → dest rect handling boundary clamps
  const dstX = Math.max(0, -srcX / s * outSz);
  const dstY = Math.max(0, -srcY / s * outSz);
  const sX2 = Math.max(0, srcX), sY2 = Math.max(0, srcY);
  const sW  = Math.min(s, sourceCanvas.width  - sX2);
  const sH  = Math.min(s, sourceCanvas.height - sY2);
  if (sW > 0 && sH > 0) {
    const dW = (sW / s) * outSz, dH = (sH / s) * outSz;
    ctx.drawImage(sourceCanvas, sX2, sY2, sW, sH, dstX, dstY, dW, dH);
  }
  return oc;
}

// Convert OffscreenCanvas to normalised float32 CHW tensor [1, 3, H, W]
function _canvasToTensor(cropCanvas) {
  const W = cropCanvas.width, H = cropCanvas.height;
  const ctx = cropCanvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, W, H);
  const tensor = new Float32Array(3 * H * W);
  for (let i = 0; i < H * W; i++) {
    tensor[0 * H*W + i] = (data[i*4+0] - MEAN[0]) / STD[0];
    tensor[1 * H*W + i] = (data[i*4+1] - MEAN[1]) / STD[1];
    tensor[2 * H*W + i] = (data[i*4+2] - MEAN[2]) / STD[2];
  }
  return tensor;
}

function _sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

// Decode NanoTrack head output → center + size (in search-crop coordinates)
function _decodeOutput(cls, reg, prevSz, hanning) {
  // cls: Float32Array [2 × 17 × 17], take channel 1 (positive)
  // reg: Float32Array [4 × 17 × 17] — (x_off, y_off, w, h) per cell, in units of stride
  const n = SCORE_SZ * SCORE_SZ;
  const scores = new Float32Array(n);
  for (let i = 0; i < n; i++) scores[i] = _sigmoid(cls[n + i]); // channel 1

  // Build grid of cell centres in search-crop coordinates
  // Cell (r,c) centre = (c + 0.5) * STRIDE, (r + 0.5) * STRIDE
  const cellCx = new Float32Array(n);
  const cellCy = new Float32Array(n);
  for (let r = 0; r < SCORE_SZ; r++)
    for (let c = 0; c < SCORE_SZ; c++) {
      cellCx[r*SCORE_SZ+c] = (c + 0.5) * STRIDE;
      cellCy[r*SCORE_SZ+c] = (r + 0.5) * STRIDE;
    }

  // Decode predicted box for each cell
  const predCx = new Float32Array(n), predCy = new Float32Array(n);
  const predW  = new Float32Array(n), predH  = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    predCx[i] = cellCx[i] + reg[0*n+i] * STRIDE;
    predCy[i] = cellCy[i] + reg[1*n+i] * STRIDE;
    predW[i]  = Math.exp(reg[2*n+i]) * STRIDE;
    predH[i]  = Math.exp(reg[3*n+i]) * STRIDE;
  }

  // Scale/ratio change penalty
  const s_prev = Math.sqrt(prevSz.w * prevSz.h);
  const penalised = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const rW = predW[i] / prevSz.w, rH = predH[i] / prevSz.h;
    const scalePen  = Math.max(rW, 1/rW) * Math.max(rH, 1/rH);
    const penalty   = Math.exp(-PENALTY_K * (scalePen - 1));
    // Blend Hanning cosine window
    penalised[i] = scores[i] * penalty * (1 - WINDOW_INF) + hanning[i] * WINDOW_INF;
  }

  // Find peak
  let best = 0;
  for (let i = 1; i < n; i++) if (penalised[i] > penalised[best]) best = i;

  return {
    cx: predCx[best],
    cy: predCy[best],
    w:  predW[best],
    h:  predH[best],
    score: scores[best],
    idx: best,
  };
}

// ── Model download & OPFS cache ───────────────────────────────────────────────

async function _fetchModelBytes(url, name) {
  // Try OPFS cache first
  try {
    const root = await navigator.storage.getDirectory();
    const dir  = await root.getDirectoryHandle('pfx_nanotrack', { create: true });
    const fh   = await dir.getFileHandle(name, { create: false });
    const f    = await fh.getFile();
    return new Uint8Array(await f.arrayBuffer());
  } catch {}
  // Download
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${name}: ${resp.status}`);
  const buf  = await resp.arrayBuffer();
  // Cache to OPFS
  try {
    const root = await navigator.storage.getDirectory();
    const dir  = await root.getDirectoryHandle('pfx_nanotrack', { create: true });
    const fh   = await dir.getFileHandle(name, { create: true });
    const wh   = await fh.createWritable();
    await wh.write(buf);
    await wh.close();
  } catch {}
  return new Uint8Array(buf);
}

// ── NanoTracker class ─────────────────────────────────────────────────────────

export class NanoTracker {
  constructor() {
    this._ort         = null;
    this._backbone    = null;
    this._head        = null;
    this._zFeat       = null;   // cached template features
    this._cx          = 0;      // current tracked centre (canvas coords)
    this._cy          = 0;
    this._targetW     = 0;      // current tracked size (canvas coords)
    this._targetH     = 0;
    this._scale       = 1;      // canvas-to-search-crop scale
    this._hanning     = _hanning2D(SCORE_SZ);
    this._ready       = false;
  }

  /** Load ONNX runtime + models. Call once before tracking. */
  async load(onProgress) {
    if (this._ready) return;
    // Load onnxruntime-web from CDN
    this._ort = await import(ORT_CDN);
    this._ort.env.wasm.numThreads = 1;
    this._ort.env.wasm.simd = true;
    if (onProgress) onProgress(5, 'Loading NanoTrack backbone…');
    const [bbBytes, hdBytes] = await Promise.all([
      _fetchModelBytes(BACKBONE_URL, 'backbone.onnx'),
      _fetchModelBytes(HEAD_URL,     'head.onnx'),
    ]);
    if (onProgress) onProgress(80, 'Creating ONNX sessions…');
    this._backbone = await this._ort.InferenceSession.create(bbBytes, { executionProviders: ['wasm'] });
    this._head     = await this._ort.InferenceSession.create(hdBytes, { executionProviders: ['wasm'] });
    if (onProgress) onProgress(100, 'NanoTrack ready');
    this._ready = true;
  }

  /** Initialise the tracker with the first frame and the target bounding box. */
  async init(canvas, box) {
    if (!this._ready) throw new Error('Call load() first');
    this._cx = (box.x1 + box.x2) / 2;
    this._cy = (box.y1 + box.y2) / 2;
    this._targetW = Math.max(1, box.x2 - box.x1);
    this._targetH = Math.max(1, box.y2 - box.y1);

    // Compute context padding: sqrt((w + p*2)(h + p*2)) = template_sz
    const context = CONTEXT_AMOUNT * (this._targetW + this._targetH);
    const sz = Math.round(Math.sqrt((this._targetW + context) * (this._targetH + context)));

    const crop = _extractCrop(canvas, this._cx, this._cy, sz, TEMPLATE_SZ);
    this._scale = sz / TEMPLATE_SZ;

    const tensor = _canvasToTensor(crop);
    const inp = new this._ort.Tensor('float32', tensor, [1, 3, TEMPLATE_SZ, TEMPLATE_SZ]);
    const bbOut = await this._backbone.run({ input: inp });
    this._zFeat = bbOut[Object.keys(bbOut)[0]]; // store template features
  }

  /**
   * Track to the next frame. Returns {x1,y1,x2,y2,score} in canvas coords.
   * Returns null if score < threshold (likely lost target).
   */
  async track(canvas) {
    if (!this._ready || !this._zFeat) return null;

    // Build search region around current prediction
    const context  = CONTEXT_AMOUNT * (this._targetW + this._targetH);
    const sz       = Math.round(Math.sqrt((this._targetW + context) * (this._targetH + context)));
    const searchSz = sz * (SEARCH_SZ / TEMPLATE_SZ);
    const crop     = _extractCrop(canvas, this._cx, this._cy, searchSz, SEARCH_SZ);

    const tensor = _canvasToTensor(crop);
    const xInp   = new this._ort.Tensor('float32', tensor, [1, 3, SEARCH_SZ, SEARCH_SZ]);

    // Backbone → search features
    const bbOut  = await this._backbone.run({ input: xInp });
    const xFeat  = bbOut[Object.keys(bbOut)[0]];

    // Head → cls + reg
    const hdInputs = {};
    const inNames  = this._head.inputNames;
    hdInputs[inNames[0]] = this._zFeat;
    hdInputs[inNames[1]] = xFeat;
    const hdOut = await this._head.run(hdInputs);
    const outNames = this._head.outputNames;
    const cls = hdOut[outNames[0]].data;   // [2 × 17 × 17]
    const reg = hdOut[outNames[1]].data;   // [4 × 17 × 17]

    const prevSz = {
      w: this._targetW / this._scale * (SEARCH_SZ / TEMPLATE_SZ),
      h: this._targetH / this._scale * (SEARCH_SZ / TEMPLATE_SZ),
    };
    const res = _decodeOutput(cls, reg, prevSz, this._hanning);

    if (res.score < SCORE_THRESH) return null;  // lost target

    // Map result from search-crop coords back to canvas coords
    const scaleInv = searchSz / SEARCH_SZ;
    const newCx = this._cx + (res.cx - SEARCH_SZ / 2) * scaleInv;
    const newCy = this._cy + (res.cy - SEARCH_SZ / 2) * scaleInv;
    const newW  = res.w * scaleInv;
    const newH  = res.h * scaleInv;

    // EMA update of size (smooth out jitter)
    const lr = res.score * LR;
    this._targetW = (1 - lr) * this._targetW + lr * newW;
    this._targetH = (1 - lr) * this._targetH + lr * newH;
    this._cx = newCx;
    this._cy = newCy;
    this._scale = searchSz / SEARCH_SZ;

    const hw = this._targetW / 2, hh = this._targetH / 2;
    return {
      x1: Math.max(0, newCx - hw),
      y1: Math.max(0, newCy - hh),
      x2: Math.min(canvas.width,  newCx + hw),
      y2: Math.min(canvas.height, newCy + hh),
      score: res.score,
      cx: newCx,
      cy: newCy,
    };
  }

  /** Release ONNX session memory. */
  dispose() {
    try { this._backbone?.release?.(); } catch {}
    try { this._head?.release?.(); } catch {}
    this._backbone = this._head = this._zFeat = null;
    this._ready = false;
  }

  get isReady() { return this._ready; }
}
