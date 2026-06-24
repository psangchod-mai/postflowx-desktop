/**
 * track3D.js — PostFlowX 3D tracking engine
 *
 * Three capabilities built on RAFT-Small optical flow:
 *
 * 1. PlanarTracker — tracks a user-defined quad (4-corner surface) using
 *    RAFT flow at sampled interior points + RANSAC homography (DLT).
 *    Use case: screen replacement, wall projection, poster compositing.
 *
 * 2. CameraMotionEstimator — infers camera pan/tilt/zoom/roll per frame.
 *    Use case: stabilize the tracking search window so the Kalman filter
 *    doesn't chase the camera rather than the object.
 *
 * 3. DepthTracker — lifts 2D tracked points into 3D using Depth Anything V2.
 *    Use case: Z-depth value per tracked shape, 3D velocity vectors,
 *    depth-sorted layer stacking for compositing.
 */

import { loadRaft, estimateFlow, flowAt, estimateCameraMotion, RAFT_W, RAFT_H } from './raftFlow.js';

const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/dist/transformers.min.js';
let _tf = null, _depthPipe = null;

// ── Pure-JS homography (DLT + RANSAC) ────────────────────────────────────────

/**
 * Direct Linear Transform: compute 3×3 homography from 4+ point correspondences.
 * pts1, pts2: Array of {x, y}
 */
function _dlt(pts1, pts2) {
  const n = pts1.length;
  if (n < 4) return null;
  // Build A matrix (2n × 9)
  const rows = [];
  for (let i = 0; i < n; i++) {
    const { x: x1, y: y1 } = pts1[i], { x: x2, y: y2 } = pts2[i];
    rows.push([-x1,-y1,-1, 0,0,0, x2*x1, x2*y1, x2]);
    rows.push([0,0,0, -x1,-y1,-1, y2*x1, y2*y1, y2]);
  }
  // Solve with SVD-like Jacobi — for homography we use the closed-form 4-point solution
  // For 4 exact points (no noise), compute H directly from 4 exact pairs
  if (n === 4) return _solve4PointHomography(pts1, pts2);
  // For overdetermined case, use least-squares via normal equations
  return _solveLsqHomography(rows);
}

function _solve4PointHomography(src, dst) {
  // Build 8×8 linear system from 4 point pairs, solve for H (8 unknowns, h9=1)
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const { x: sx, y: sy } = src[i], { x: dx, y: dy } = dst[i];
    A.push([sx, sy, 1, 0, 0, 0, -dx*sx, -dx*sy]);
    b.push(dx);
    A.push([0, 0, 0, sx, sy, 1, -dy*sx, -dy*sy]);
    b.push(dy);
  }
  const h = _solveLinear8(A, b);
  if (!h) return null;
  return [[h[0],h[1],h[2]], [h[3],h[4],h[5]], [h[6],h[7],1]];
}

function _solveLinear8(A, b) {
  // Gaussian elimination for 8×8 system
  const n = 8;
  const m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let maxR = c;
    for (let r = c+1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[maxR][c])) maxR = r;
    [m[c], m[maxR]] = [m[maxR], m[c]];
    if (Math.abs(m[c][c]) < 1e-12) return null;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((r, i) => r[n] / r[i]);
}

function _solveLsqHomography(rows) {
  // Least-squares via AtA → solve for h (minimal 4-point version for stability)
  const n = rows.length, k = 9;
  const AtA = Array.from({length:k}, () => new Float64Array(k));
  const Atb = new Float64Array(k);
  // Use h[8]=1 constraint: move column 8 to RHS
  for (const row of rows) {
    const r8 = row[8];
    for (let i = 0; i < k-1; i++) {
      Atb[i] -= row[i] * r8;
      for (let j = 0; j < k-1; j++) AtA[i][j] += row[i] * row[j];
    }
  }
  const h8 = _solveLinear(AtA.slice(0,8).map(r => Array.from(r).slice(0,8)), Array.from(Atb).slice(0,8));
  if (!h8) return null;
  return [[h8[0],h8[1],h8[2]], [h8[3],h8[4],h8[5]], [h8[6],h8[7],1]];
}

function _solveLinear(A, b) {
  const n = A.length;
  const m = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let mx = c;
    for (let r = c+1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[mx][c])) mx = r;
    [m[c], m[mx]] = [m[mx], m[c]];
    if (Math.abs(m[c][c]) < 1e-12) return null;
    const piv = m[c][c];
    for (let k = c; k <= n; k++) m[c][k] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map(r => r[n]);
}

function _applyH(H, x, y) {
  const w = H[2][0]*x + H[2][1]*y + H[2][2];
  return { x: (H[0][0]*x + H[0][1]*y + H[0][2]) / w,
           y: (H[1][0]*x + H[1][1]*y + H[1][2]) / w };
}

/** RANSAC homography from noisy point correspondences. */
function _ransacHomography(pts1, pts2, { inlierThresh = 3, iterations = 200 } = {}) {
  const n = pts1.length;
  if (n < 4) return null;
  let bestH = null, bestCount = 0, bestMask = [];
  for (let iter = 0; iter < iterations; iter++) {
    // Sample 4 random pairs
    const idx = [];
    while (idx.length < 4) {
      const r = Math.floor(Math.random() * n);
      if (!idx.includes(r)) idx.push(r);
    }
    const s1 = idx.map(i => pts1[i]), s2 = idx.map(i => pts2[i]);
    const H = _dlt(s1, s2);
    if (!H) continue;
    // Count inliers
    let count = 0;
    const mask = [];
    for (let i = 0; i < n; i++) {
      const p = _applyH(H, pts1[i].x, pts1[i].y);
      const d = Math.hypot(p.x - pts2[i].x, p.y - pts2[i].y);
      const inlier = d < inlierThresh;
      mask.push(inlier); if (inlier) count++;
    }
    if (count > bestCount) { bestCount = count; bestH = H; bestMask = mask; }
    if (count > n * 0.85) break; // early exit
  }
  if (bestCount < 4) return null;
  // Refine H using all inliers
  const in1 = pts1.filter((_, i) => bestMask[i]);
  const in2 = pts2.filter((_, i) => bestMask[i]);
  return { H: _dlt(in1, in2) || bestH, inlierCount: bestCount, mask: bestMask };
}

// ── PlanarTracker ─────────────────────────────────────────────────────────────

/**
 * Tracks a 4-corner quadrilateral surface using RAFT optical flow + RANSAC homography.
 *
 * The homography H maps points on the surface in frame N to frame N+1.
 * Can be used for: screen replacement, wall/poster compositing, perspective correction.
 *
 * Usage:
 *   const pt = new PlanarTracker();
 *   await pt.init(canvas, [{x,y},{x,y},{x,y},{x,y}]);  // 4 corners (TL,TR,BR,BL)
 *   const result = await pt.track(nextCanvas);
 *   // result.corners: updated [{x,y}] × 4
 *   // result.H: 3×3 homography matrix
 *   // result.inliers: number of RANSAC inliers
 */
export class PlanarTracker {
  constructor() {
    this._corners = null;  // [{x,y}] × 4, in logical canvas coords
    this._prevCanvas = null;
    this._loaded = false;
  }

  async load(onProgress) {
    if (this._loaded) return;
    await loadRaft(onProgress);
    this._loaded = true;
  }

  init(canvas, corners) {
    if (corners.length !== 4) throw new Error('PlanarTracker needs exactly 4 corners');
    this._corners = corners.map(c => ({ x: c.x, y: c.y }));
    this._prevCanvas = this._snapshotCanvas(canvas);
    return this;
  }

  async track(canvas) {
    if (!this._loaded || !this._corners) throw new Error('Call load() and init() first');
    const srcW = canvas.width, srcH = canvas.height;

    const flow = await estimateFlow(this._prevCanvas, canvas);

    // Sample interior points of the quad (uniform grid ~64 points)
    const pts1 = [], pts2 = [];
    const GRID = 8;
    const [tl, tr, br, bl] = this._corners;
    for (let i = 0; i <= GRID; i++) {
      for (let j = 0; j <= GRID; j++) {
        const s = i / GRID, t = j / GRID;
        // Bilinear interpolation within quad
        const x = (1-s)*(1-t)*tl.x + s*(1-t)*tr.x + s*t*br.x + (1-s)*t*bl.x;
        const y = (1-s)*(1-t)*tl.y + s*(1-t)*tr.y + s*t*br.y + (1-s)*t*bl.y;
        const f = flowAt(flow, x, y, srcW, srcH);
        pts1.push({ x, y });
        pts2.push({ x: x + f.u, y: y + f.v });
      }
    }

    const result = _ransacHomography(pts1, pts2, { inlierThresh: 2.5, iterations: 150 });
    if (!result?.H) {
      this._prevCanvas = this._snapshotCanvas(canvas);
      return { corners: this._corners, H: null, inliers: 0, confidence: 0 };
    }

    // Update corners using the homography
    const newCorners = this._corners.map(c => _applyH(result.H, c.x, c.y));
    const clamp = (p) => ({
      x: Math.max(0, Math.min(srcW, p.x)),
      y: Math.max(0, Math.min(srcH, p.y)),
    });
    this._corners = newCorners.map(clamp);
    this._prevCanvas = this._snapshotCanvas(canvas);

    const confidence = Math.min(1, result.inlierCount / Math.max(1, pts1.length) * 2);
    return {
      corners: this._corners,
      H: result.H,
      inliers: result.inlierCount,
      confidence,
    };
  }

  /** Compute the homography that maps the tracked quad to a target rect (for replacement). */
  computeReplaceHomography(targetW, targetH) {
    if (!this._corners) return null;
    const dst = [
      { x: 0,       y: 0       },
      { x: targetW, y: 0       },
      { x: targetW, y: targetH },
      { x: 0,       y: targetH },
    ];
    return _dlt(this._corners, dst);
  }

  _snapshotCanvas(src) {
    const oc = new OffscreenCanvas(src.width, src.height);
    oc.getContext('2d').drawImage(src, 0, 0);
    return oc;
  }

  dispose() { disposeRaft(); }
}

// ── Camera-motion-compensated tracker ────────────────────────────────────────

/**
 * Per-frame camera motion using RAFT background flow.
 * Returns {dx, dy, scale, confidence} — the camera's translation and zoom.
 * Feed dx/dy as a correction to your Kalman filter prediction to
 * track objects that are stationary in world space but moving in frame space
 * due to camera movement.
 */
export class CameraMotionEstimator {
  constructor() {
    this._prevCanvas = null;
    this._lastMotion = { dx: 0, dy: 0, scale: 1, rotation: 0, confidence: 0 };
    this.lastFlow    = null;  // exposed so _trackShape can reuse it for bbox tracking
  }

  async init(canvas) {
    await loadRaft();
    this._prevCanvas = this._snap(canvas);
    return this;
  }

  async update(canvas, fgBoxes = []) {
    if (!this._prevCanvas) { await this.init(canvas); return this._lastMotion; }
    const flow   = await estimateFlow(this._prevCanvas, canvas);
    this.lastFlow = flow;  // store for external reuse (bbox flow tracking)
    const motion = estimateCameraMotion(flow, fgBoxes, canvas.width, canvas.height);
    this._lastMotion = motion;
    this._prevCanvas = this._snap(canvas);
    return motion;
  }

  _snap(src) {
    const oc = new OffscreenCanvas(src.width, src.height);
    oc.getContext('2d').drawImage(src, 0, 0);
    return oc;
  }
}

// ── Depth-aware point tracker ─────────────────────────────────────────────────

/**
 * Lifts a set of 2D tracked points into 3D using:
 *   - RAFT optical flow for XY motion
 *   - Depth Anything V2 INT8 for Z depth
 *
 * Output per point:
 *   {x, y}     — new 2D position (canvas coords)
 *   {X, Y, Z}  — 3D world position (arbitrary units, Z = relative depth 0-1, 0=far, 1=near)
 *   dz         — frame-to-frame depth change (positive = moving toward camera)
 *   speed3d    — 3D speed estimate (pixels per frame equivalent)
 */
export class DepthTracker {
  constructor() {
    this._prevCanvas   = null;
    this._prevDepthMap = null;  // Float32Array H×W, 0=far, 1=near
    this._depthW = 0; this._depthH = 0;
    this._frameCount = 0;
    this._loaded = false;
  }

  async load(onProgress) {
    if (this._loaded) return;
    await loadRaft((p, f) => onProgress?.(Math.round(p * 0.4), f));
    _tf = _tf || await import(TRANSFORMERS_CDN);
    _tf.env.useBrowserCache(true);
    if (!_depthPipe) {
      _depthPipe = await _tf.pipeline('depth-estimation',
        'onnx-community/depth-anything-v2-small',
        { dtype: 'q4f16', progress_callback: (d) => {
            if (d.status === 'progress') onProgress?.(40 + Math.round((d.progress??0) * 0.6), d.file || '');
          }
        });
    }
    this._loaded = true;
    onProgress?.(100, 'DepthTracker ready');
  }

  async init(canvas) {
    if (!this._loaded) throw new Error('Call load() first');
    this._prevCanvas = this._snap(canvas);
    this._prevDepthMap = await this._getDepth(canvas);
    this._frameCount = 0;
    return this;
  }

  /**
   * Update to the next frame.
   * points: [{x, y}] in canvas coords
   * Returns: [{x, y, X, Y, Z, dz, speed3d}]
   */
  async update(canvas, points) {
    if (!this._loaded || !this._prevCanvas) throw new Error('Call init() first');
    this._frameCount++;
    const W = canvas.width, H = canvas.height;

    // Flow: every frame
    const flow = await estimateFlow(this._prevCanvas, canvas);

    // Depth: every 5 frames (semi-stable, expensive)
    let depthMap = this._prevDepthMap;
    if (this._frameCount % 5 === 0) {
      depthMap = await this._getDepth(canvas);
    }

    const estFocalLength = Math.max(W, H) * 1.2; // heuristic

    const result = points.map(pt => {
      const f     = flowAt(flow, pt.x, pt.y, W, H);
      const newX  = Math.max(0, Math.min(W, pt.x + f.u));
      const newY  = Math.max(0, Math.min(H, pt.y + f.v));

      // Sample depth at new position
      const dIdx = this._depthIdx(newX, newY, W, H);
      const Z    = depthMap ? (depthMap[dIdx] ?? 0.5) : 0.5;
      const Zprev= this._prevDepthMap ? (this._prevDepthMap[this._depthIdx(pt.x, pt.y, W, H)] ?? Z) : Z;

      // Lift to 3D (normalized device coords)
      const X3 = (newX - W / 2) / estFocalLength * Z;
      const Y3 = (newY - H / 2) / estFocalLength * Z;
      const dz = Z - Zprev;
      const speed3d = Math.sqrt(f.u*f.u + f.v*f.v + (dz * estFocalLength) ** 2);

      return { x: newX, y: newY, X: X3, Y: Y3, Z, dz, speed3d };
    });

    this._prevDepthMap = depthMap;
    this._prevCanvas   = this._snap(canvas);
    return result;
  }

  async _getDepth(canvas) {
    const W = canvas.width, H = canvas.height;
    const blob = await canvas.convertToBlob?.({ type: 'image/jpeg', quality: 0.9 })
      ?? await new Promise(r => { const c = document.createElement('canvas'); c.width=W; c.height=H; c.getContext('2d').drawImage(canvas,0,0); c.toBlob(r,'image/jpeg',0.9); });
    const url = URL.createObjectURL(blob);
    try {
      const { depth } = await _depthPipe(url);
      this._depthW = depth.width; this._depthH = depth.height;
      const src = depth.data;
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < src.length; i++) { if(src[i]<lo)lo=src[i]; if(src[i]>hi)hi=src[i]; }
      const range = hi - lo || 1;
      const out = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) out[i] = (src[i] - lo) / range;
      return out;
    } finally { URL.revokeObjectURL(url); }
  }

  _depthIdx(x, y, srcW, srcH) {
    if (!this._depthW) return 0;
    const dx = Math.round((x / srcW) * (this._depthW - 1));
    const dy = Math.round((y / srcH) * (this._depthH - 1));
    return Math.max(0, Math.min(this._depthW * this._depthH - 1, dy * this._depthW + dx));
  }

  _snap(src) {
    const oc = new OffscreenCanvas(src.width, src.height);
    oc.getContext('2d').drawImage(src, 0, 0);
    return oc;
  }
}
