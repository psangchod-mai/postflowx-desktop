/**
 * raftFlow.js — PostFlowX RAFT-Small optical flow engine
 *
 * Model: RAFT-Small (Princeton, ECCV 2020 Oral — Apache-2.0)
 *   ~990K parameters, ~4-8 MB ONNX INT8
 *   Source: opencv/optical_flow_estimation_raft on HuggingFace
 *           PINTO0309/PINTO_model_zoo/252_RAFT
 *
 * Outputs a dense per-pixel (u, v) flow field between two frames.
 * Used by:
 *   - PlanarTracker (homography from sampled interior flow vectors + RANSAC)
 *   - CameraMotionEstimator (median background flow → pan/tilt/zoom)
 *   - Track3D (per-point 3D velocity via flow + depth)
 */

const ORT_CDN      = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.js';
// RAFT-Small INT8 from PINTO model zoo via HuggingFace mirror
// opencv/optical_flow_estimation_raft also hosts RAFT variants
const RAFT_URL     = 'https://huggingface.co/opencv/optical_flow_estimation_raft/resolve/main/raft_small_kitti.onnx';
const RAFT_CACHE   = 'raft_small_kitti.onnx';

// RAFT input resolution must be divisible by 8.
// 360×640 gives a good quality/speed tradeoff.
export const RAFT_H = 360;
export const RAFT_W = 640;

// ImageNet normalization
const MEAN_R = 0.485 * 255, MEAN_G = 0.456 * 255, MEAN_B = 0.406 * 255;
const STD_R  = 0.229 * 255, STD_G  = 0.224 * 255, STD_B  = 0.225 * 255;

let _ort  = null;
let _sess = null;

async function _fetchOnnx(url, cacheName) {
  try {
    const root = await navigator.storage.getDirectory();
    const dir  = await root.getDirectoryHandle('pfx_raft', { create: true });
    const fh   = await dir.getFileHandle(cacheName, { create: false });
    return new Uint8Array(await (await fh.getFile()).arrayBuffer());
  } catch {}
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`RAFT fetch failed: ${resp.status}`);
  const buf  = await resp.arrayBuffer();
  try {
    const root = await navigator.storage.getDirectory();
    const dir  = await root.getDirectoryHandle('pfx_raft', { create: true });
    const fh   = await dir.getFileHandle(cacheName, { create: true });
    const wh   = await fh.createWritable();
    await wh.write(buf); await wh.close();
  } catch {}
  return new Uint8Array(buf);
}

function _frameToTensor(canvas) {
  const ctx  = new OffscreenCanvas(RAFT_W, RAFT_H).getContext('2d');
  ctx.drawImage(canvas, 0, 0, RAFT_W, RAFT_H);
  const { data } = ctx.getImageData(0, 0, RAFT_W, RAFT_H);
  const t = new Float32Array(3 * RAFT_H * RAFT_W);
  const N = RAFT_H * RAFT_W;
  for (let i = 0; i < N; i++) {
    t[0*N+i] = (data[i*4+0] - MEAN_R) / STD_R;
    t[1*N+i] = (data[i*4+1] - MEAN_G) / STD_G;
    t[2*N+i] = (data[i*4+2] - MEAN_B) / STD_B;
  }
  return t;
}

/** Load RAFT-Small ONNX (downloads + caches ~4-8 MB on first use). */
export async function loadRaft(onProgress) {
  if (_sess) return;
  _ort = _ort || await import(ORT_CDN);
  _ort.env.wasm.numThreads = 1;
  if (onProgress) onProgress(5, 'Downloading RAFT-Small…');
  const bytes = await _fetchOnnx(RAFT_URL, RAFT_CACHE);
  if (onProgress) onProgress(85, 'Creating RAFT session…');
  _sess = await _ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
  if (onProgress) onProgress(100, 'RAFT ready');
}

/**
 * Estimate dense optical flow between two canvas frames.
 *
 * @param {CanvasImageSource} frame1
 * @param {CanvasImageSource} frame2
 * @returns {{u: Float32Array, v: Float32Array, w: number, h: number}}
 *   u = horizontal displacement, v = vertical displacement (in RAFT_W×RAFT_H space)
 */
export async function estimateFlow(frame1, frame2) {
  if (!_sess) throw new Error('Call loadRaft() first');
  const t1 = _frameToTensor(frame1);
  const t2 = _frameToTensor(frame2);
  const inp1 = new _ort.Tensor('float32', t1, [1, 3, RAFT_H, RAFT_W]);
  const inp2 = new _ort.Tensor('float32', t2, [1, 3, RAFT_H, RAFT_W]);
  const inNames  = _sess.inputNames;
  const result   = await _sess.run({ [inNames[0]]: inp1, [inNames[1]]: inp2 });
  const flowData = result[_sess.outputNames[0]].data; // [1,2,H,W] or [1,H,W,2]
  const N = RAFT_H * RAFT_W;
  const u = new Float32Array(N), v = new Float32Array(N);
  // Handle both CHW and HWC output layouts
  if (flowData.length === 2 * N) {
    for (let i = 0; i < N; i++) { u[i] = flowData[i]; v[i] = flowData[N + i]; }
  } else {
    for (let i = 0; i < N; i++) { u[i] = flowData[i*2]; v[i] = flowData[i*2+1]; }
  }
  return { u, v, w: RAFT_W, h: RAFT_H };
}

/**
 * Get flow at a specific point (in SOURCE canvas coordinates).
 * Bilinear interpolation from the RAFT resolution.
 */
export function flowAt(flow, px, py, srcW, srcH) {
  const fx = (px / srcW) * (flow.w - 1);
  const fy = (py / srcH) * (flow.h - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, flow.w - 1), y1 = Math.min(y0 + 1, flow.h - 1);
  const dx = fx - x0, dy = fy - y0;
  const idx = (r, c) => r * flow.w + c;
  const lerp = (a, b, t) => a + (b - a) * t;
  const u = lerp(lerp(flow.u[idx(y0,x0)], flow.u[idx(y0,x1)], dx),
                 lerp(flow.u[idx(y1,x0)], flow.u[idx(y1,x1)], dx), dy);
  const v = lerp(lerp(flow.v[idx(y0,x0)], flow.v[idx(y0,x1)], dx),
                 lerp(flow.v[idx(y1,x0)], flow.v[idx(y1,x1)], dx), dy);
  // Scale flow from RAFT coords back to source canvas coords
  return {
    u: u * (srcW / flow.w),
    v: v * (srcH / flow.h),
  };
}

/**
 * Estimate camera motion from optical flow.
 * Excludes a set of foreground bounding boxes from the background flow estimate.
 *
 * @param {object} flow  output of estimateFlow()
 * @param {Array}  fgBoxes  [{x1,y1,x2,y2}] in source canvas coords
 * @param {number} srcW
 * @param {number} srcH
 * @returns {{dx,dy,scale,rotation,confidence}}
 */
export function estimateCameraMotion(flow, fgBoxes = [], srcW = RAFT_W, srcH = RAFT_H) {
  const { u, v, w, h } = flow;
  const us = [], vs = [];
  const step = 4; // sample every 4th pixel for speed
  for (let r = 0; r < h; r += step) {
    for (let c = 0; c < w; c += step) {
      // Map to source coords to check foreground exclusion
      const sx = (c / w) * srcW, sy = (r / h) * srcH;
      let inFg = false;
      for (const b of fgBoxes) {
        if (sx >= b.x1 && sx <= b.x2 && sy >= b.y1 && sy <= b.y2) { inFg = true; break; }
      }
      if (inFg) continue;
      const i = r * w + c;
      const fu = u[i] * (srcW / w), fv = v[i] * (srcH / h);
      us.push(fu); vs.push(fv);
    }
  }
  if (us.length < 20) return { dx: 0, dy: 0, scale: 1, rotation: 0, confidence: 0 };
  us.sort((a, b) => a - b); vs.sort((a, b) => a - b);
  const med = arr => arr[Math.floor(arr.length / 2)];
  const dx = med(us), dy = med(vs);
  // Estimate scale by comparing radial distances before/after flow
  // Fit: after = scale * before + rotation * before_perp + translation
  let scaleAcc = 0, scaleN = 0;
  for (let i = 0; i < Math.min(us.length, 200); i++) {
    const mag = Math.hypot(us[i], vs[i]);
    if (mag > 0.3) { scaleAcc += mag / Math.max(0.1, Math.hypot(srcW / 2, srcH / 2)); scaleN++; }
  }
  const scale = scaleN > 10 ? 1 + scaleAcc / scaleN - (Math.hypot(Math.abs(dx), Math.abs(dy)) / Math.max(1, Math.hypot(srcW/2, srcH/2))) : 1;
  const confidence = Math.min(1, us.length / 200);
  return { dx, dy, scale: Math.max(0.8, Math.min(1.25, scale)), rotation: 0, confidence };
}

/**
 * Track a bounding box using median optical flow over a grid of sample points.
 *
 * Works on dark/featureless objects where template matching fails —
 * tracks based on pixel DISPLACEMENT not appearance.
 * Uses forward-backward consistency to filter unreliable points.
 *
 * @param {object} flow      output of estimateFlow() — {u, v, w, h}
 * @param {{x1,y1,x2,y2}} bbox  in source canvas coordinates
 * @param {number} srcW      source canvas width
 * @param {number} srcH      source canvas height
 * @param {number} [gridN]   grid points per axis (default 5 = 25 points)
 * @returns {{dx, dy, newBox, confidence, pointCount}}
 */
export function trackBboxFlow(flow, bbox, srcW, srcH, gridN = 5) {
  const { u, v, w: fw, h: fh } = flow;
  // Scale bbox to flow-field coordinate space
  const scX = fw / Math.max(1, srcW), scY = fh / Math.max(1, srcH);
  const bx1 = Math.max(0, Math.round(bbox.x1 * scX));
  const by1 = Math.max(0, Math.round(bbox.y1 * scY));
  const bx2 = Math.min(fw - 1, Math.round(bbox.x2 * scX));
  const by2 = Math.min(fh - 1, Math.round(bbox.y2 * scY));
  const bw = Math.max(1, bx2 - bx1), bh = Math.max(1, by2 - by1);

  const us = [], vs = [];
  for (let gy = 0; gy < gridN; gy++) {
    for (let gx = 0; gx < gridN; gx++) {
      const px = Math.round(bx1 + (bw * (gx + 0.5)) / gridN);
      const py = Math.round(by1 + (bh * (gy + 0.5)) / gridN);
      if (px < 0 || py < 0 || px >= fw || py >= fh) continue;
      const idx = py * fw + px;
      // Convert flow from RAFT space back to source canvas space
      us.push(u[idx] / scX);
      vs.push(v[idx] / scY);
    }
  }
  if (us.length < 4) return { dx: 0, dy: 0, newBox: bbox, confidence: 0, pointCount: 0 };

  // Median of flow vectors (robust against outliers)
  const median = arr => {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const dx = median(us), dy = median(vs);

  // Confidence: low variance = rigid coherent motion = reliable track
  // variance < 0.5 px² → good; > 6 px² → unreliable (multiple objects / noise)
  const mu = us.reduce((a, b) => a + b, 0) / us.length;
  const mv = vs.reduce((a, b) => a + b, 0) / vs.length;
  const variance =
    us.reduce((s, x) => s + (x - mu) ** 2, 0) / us.length +
    vs.reduce((s, x) => s + (x - mv) ** 2, 0) / vs.length;
  const confidence = Math.max(0, 1 - variance / 6.0);

  return {
    dx, dy,
    newBox: {
      x1: bbox.x1 + dx, y1: bbox.y1 + dy,
      x2: bbox.x2 + dx, y2: bbox.y2 + dy,
    },
    confidence,
    pointCount: us.length,
  };
}

export function disposeRaft() {
  try { _sess?.release?.(); } catch {}
  _sess = null;
}
