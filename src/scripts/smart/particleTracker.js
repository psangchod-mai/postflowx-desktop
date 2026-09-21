/**
 * particleTracker.js — Sequential Importance Resampling (SIR) Particle Filter
 *
 * Algorithm: Particle Filter + Lucas-Kanade optical flow motion model
 *            + Sobel edge NCC observation model
 *
 * Why this works for dark/featureless objects:
 *   - Motion model: LK flow at each particle's centre. LK needs only local gradient
 *     to estimate displacement — finds boundary edges even for near-black regions.
 *   - Observation model: Sobel edge NCC, NOT color histogram. Edge magnitude is
 *     computed from local contrast differences, not absolute pixel intensity.
 *     A dark object moving against a slightly lighter background has edge signal
 *     at its boundary even if the interior is uniform black.
 *   - Particle spread: multiple hypotheses survive occlusion and low-confidence frames
 *     without committing to a single incorrect position (unlike KF or template match).
 *
 * References:
 *   - johnhw/pfilter (MIT) — systematic resampling
 *   - tanglang96/particle-filter — LK motion model design
 *   - Optical flow-based observation models for PF tracking (Springer 2014)
 *   - CSRT: Channel & Spatial Reliability DCF (arXiv 1611.08461)
 */

const N_DEFAULT  = 150;    // particle count
const TPL_SZ     = 32;     // edge template resolution
const SIGMA_POS  = 3.5;    // px position noise per frame
const SIGMA_SCL  = 0.035;  // log-scale noise per frame
const SIGMA_OBS  = 0.30;   // NCC → weight sensitivity (lower = sharper)
const NEFF_THR   = 0.50;   // resample when N_eff / N drops below this
const INJECT_PCT = 0.025;  // % fresh prior particles injected each resample

// ── Utility ──────────────────────────────────────────────────────────────────
function _randn() {
  const u = 1 - Math.random(), v = Math.random();
  return Math.sqrt(-2 * Math.log(Math.max(u, 1e-10))) * Math.cos(2 * Math.PI * v);
}

function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// Bilinear luma sample from RGBA Uint8ClampedArray
function _luma(d, x, y, W, H) {
  const cx = _clamp(Math.round(x), 0, W-1), cy = _clamp(Math.round(y), 0, H-1);
  const i = (cy * W + cx) * 4;
  return 0.299*d[i] + 0.587*d[i+1] + 0.114*d[i+2];
}

function _lumaB(d, fx, fy, W, H) {
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0+1,W-1), y1 = Math.min(y0+1,H-1);
  const dx = fx-x0, dy = fy-y0;
  const g = (x,y)=>_luma(d,x,y,W,H);
  return (1-dx)*(1-dy)*g(x0,y0)+dx*(1-dy)*g(x1,y0)+(1-dx)*dy*g(x0,y1)+dx*dy*g(x1,y1);
}

// ── Lucas-Kanade flow at a single point ──────────────────────────────────────
function _lkAt(prev, curr, px, py, W, H, winR = 5) {
  let Ixx=0,Iyy=0,Ixy=0,Ixt=0,Iyt=0;
  const x=Math.round(_clamp(px,1,W-2)), y=Math.round(_clamp(py,1,H-2));
  for (let wy=-winR; wy<=winR; wy++) {
    for (let wx=-winR; wx<=winR; wx++) {
      const nx=_clamp(x+wx,0,W-1), ny=_clamp(y+wy,0,H-1);
      const Ix=(_luma(prev,nx+1,ny,W,H)-_luma(prev,nx-1,ny,W,H))*0.5;
      const Iy=(_luma(prev,nx,ny+1,W,H)-_luma(prev,nx,ny-1,W,H))*0.5;
      const It=_luma(curr,nx,ny,W,H)-_luma(prev,nx,ny,W,H);
      Ixx+=Ix*Ix; Iyy+=Iy*Iy; Ixy+=Ix*Iy; Ixt+=Ix*It; Iyt+=Iy*It;
    }
  }
  const det = Ixx*Iyy - Ixy*Ixy;
  if (Math.abs(det) < 0.3) return [0, 0];
  const u = -(Iyy*Ixt - Ixy*Iyt)/det;
  const v = -(Ixx*Iyt - Ixy*Ixt)/det;
  return [_clamp(u,-40,40), _clamp(v,-40,40)];
}

// ── Precompute full-frame Sobel edge map (called once per frame) ─────────────
// Returns Float32Array of edge magnitudes normalised to [0,1].
function _sobelMap(rgba, W, H) {
  const gray = new Float32Array(W*H);
  for (let i = 0; i < W*H; i++) {
    gray[i] = 0.299*rgba[i*4] + 0.587*rgba[i*4+1] + 0.114*rgba[i*4+2];
  }
  const edges = new Float32Array(W*H);
  let maxE = 1;
  for (let y = 1; y < H-1; y++) {
    for (let x = 1; x < W-1; x++) {
      const gx = (gray[(y-1)*W+x+1] - gray[(y-1)*W+x-1]
                + 2*(gray[y*W+x+1]   - gray[y*W+x-1])
                +   gray[(y+1)*W+x+1] - gray[(y+1)*W+x-1]);
      const gy = (gray[(y+1)*W+x-1] - gray[(y-1)*W+x-1]
                + 2*(gray[(y+1)*W+x]   - gray[(y-1)*W+x])
                +   gray[(y+1)*W+x+1] - gray[(y-1)*W+x+1]);
      const m = Math.sqrt(gx*gx+gy*gy);
      edges[y*W+x] = m;
      if (m > maxE) maxE = m;
    }
  }
  for (let i = 0; i < edges.length; i++) edges[i] /= maxE;
  return edges;
}

// ── Extract TPL_SZ×TPL_SZ edge patch from precomputed Sobel map ─────────────
function _edgePatch(sobelMap, cx, cy, bw, bh, W, H) {
  const out = new Float32Array(TPL_SZ * TPL_SZ);
  for (let py = 0; py < TPL_SZ; py++) {
    for (let px = 0; px < TPL_SZ; px++) {
      const fx = cx - bw/2 + (px+0.5)*(bw/TPL_SZ);
      const fy = cy - bh/2 + (py+0.5)*(bh/TPL_SZ);
      const x0=_clamp(Math.floor(fx),0,W-2), y0=_clamp(Math.floor(fy),0,H-2);
      const x1=x0+1, y1=y0+1, dx=fx-x0, dy=fy-y0;
      out[py*TPL_SZ+px] = (1-dx)*(1-dy)*sobelMap[y0*W+x0]
                        +    dx*(1-dy)*sobelMap[y0*W+x1]
                        + (1-dx)*  dy *sobelMap[y1*W+x0]
                        +    dx*   dy *sobelMap[y1*W+x1];
    }
  }
  return out;
}

// ── Normalised Cross-Correlation ─────────────────────────────────────────────
function _ncc(a, b) {
  let ma=0, mb=0, n=a.length;
  for (let i=0;i<n;i++){ma+=a[i];mb+=b[i];}
  ma/=n; mb/=n;
  let num=0,da=0,db=0;
  for (let i=0;i<n;i++){const ai=a[i]-ma,bi=b[i]-mb;num+=ai*bi;da+=ai*ai;db+=bi*bi;}
  return num/(Math.sqrt(da*db)+1e-8);
}

// ── ParticleTracker ──────────────────────────────────────────────────────────
export class ParticleTracker {
  /**
   * @param {number} N  particle count (default 150)
   */
  constructor(N = N_DEFAULT) {
    this.N = N;
    // Flat state array: [x, y, scale, vx, vy] × N
    this.p  = new Float32Array(N * 5);
    this.w  = new Float32Array(N).fill(1/N);
    this.tpl = null;       // edge template Float32Array(TPL_SZ²)
    this.prevRgba = null;
    this.W = 0; this.H = 0;
    this.initBw = 0; this.initBh = 0;
    this.isReady = false;
    this.lostFrames = 0;
    this._frameCount = 0;
  }

  /**
   * Initialise particles around the initial bounding box.
   * @param {Uint8ClampedArray} rgba  RGBA pixel data of start frame
   * @param {number} W  canvas width
   * @param {number} H  canvas height
   * @param {{x1,y1,x2,y2}} bbox  in canvas coordinates
   */
  init(rgba, W, H, bbox) {
    this.W = W; this.H = H;
    const bw = bbox.x2 - bbox.x1, bh = bbox.y2 - bbox.y1;
    const cx = (bbox.x1+bbox.x2)/2, cy = (bbox.y1+bbox.y2)/2;
    this.initBw = bw; this.initBh = bh;
    const s0 = 1.0; // scale factor (1 = original size)
    for (let i = 0; i < this.N; i++) {
      this.p[i*5+0] = cx + _randn()*3;
      this.p[i*5+1] = cy + _randn()*3;
      this.p[i*5+2] = s0 * Math.exp(_randn()*0.03);
      this.p[i*5+3] = _randn()*1.2;
      this.p[i*5+4] = _randn()*1.2;
    }
    this.w.fill(1/this.N);
    const sobel = _sobelMap(rgba, W, H);
    this.tpl = _edgePatch(sobel, cx, cy, bw, bh, W, H);
    this.prevRgba = rgba.slice();
    this.isReady = true;
    this.lostFrames = 0;
    this._frameCount = 0;
  }

  /**
   * Run one tracking step.
   * @param {Uint8ClampedArray} rgba  current frame RGBA
   * @returns {{x1,y1,x2,y2,confidence,cx,cy,scale}} or null if not ready
   */
  track(rgba) {
    if (!this.isReady || !this.prevRgba) return null;
    const { N, W, H, prevRgba, initBw, initBh } = this;
    this._frameCount++;

    // Precompute Sobel edge map for this frame (once, shared across all particles)
    const sobelMap = _sobelMap(rgba, W, H);

    // 1. PREDICT via LK motion + Gaussian noise
    for (let i = 0; i < N; i++) {
      const x = this.p[i*5], y = this.p[i*5+1], s = this.p[i*5+2];
      const [fvx, fvy] = _lkAt(prevRgba, rgba, x, y, W, H);
      this.p[i*5+0] = _clamp(x + fvx + _randn()*SIGMA_POS, 0, W-1);
      this.p[i*5+1] = _clamp(y + fvy + _randn()*SIGMA_POS, 0, H-1);
      this.p[i*5+2] = _clamp(s * Math.exp(_randn()*SIGMA_SCL), 0.5, 3.0);
      // EMA velocity update from LK
      this.p[i*5+3] = 0.72*this.p[i*5+3] + 0.28*fvx;
      this.p[i*5+4] = 0.72*this.p[i*5+4] + 0.28*fvy;
    }

    // 2. WEIGHT by Sobel edge NCC (works for dark/featureless objects)
    let total = 0;
    for (let i = 0; i < N; i++) {
      const cx=this.p[i*5], cy=this.p[i*5+1], s=this.p[i*5+2];
      const bw = initBw*s, bh = initBh*s;
      const patch = _edgePatch(sobelMap, cx, cy, bw, bh, W, H);
      const ncc = _ncc(this.tpl, patch);
      this.w[i] *= Math.exp(ncc / SIGMA_OBS); // exponential weight from NCC
      total += this.w[i];
    }
    if (total < 1e-300) { this.w.fill(1/N); total = 1; }
    for (let i = 0; i < N; i++) this.w[i] /= total;

    // 3. Compute N_eff = 1 / Σ(w²) → normalised ∈ (0, 1]
    let sumSq = 0;
    for (let i = 0; i < N; i++) sumSq += this.w[i]*this.w[i];
    const nEffNorm = 1 / (sumSq * N);

    // 4. Systematic resample when degenerate
    if (nEffNorm < NEFF_THR) this._resample();

    // 5. Weighted mean estimate
    let ex=0, ey=0, es=0, evx=0, evy=0;
    for (let i = 0; i < N; i++) {
      const wi = this.w[i];
      ex+=this.p[i*5]*wi; ey+=this.p[i*5+1]*wi;
      es+=this.p[i*5+2]*wi; evx+=this.p[i*5+3]*wi; evy+=this.p[i*5+4]*wi;
    }
    const bw = initBw*es, bh = initBh*es;

    // 6. Adaptive template update — blend toward current appearance when confident
    if (this._frameCount % 8 === 0 && nEffNorm >= 0.55) {
      const freshTpl = _edgePatch(sobelMap, ex, ey, bw, bh, W, H);
      for (let i = 0; i < this.tpl.length; i++) {
        this.tpl[i] = 0.82*this.tpl[i] + 0.18*freshTpl[i];
      }
    }

    this.lostFrames = nEffNorm < 0.10 ? this.lostFrames+1 : 0;
    this.prevRgba = rgba.slice();

    const confidence = Math.max(0.10, Math.min(0.95, nEffNorm));
    return {
      x1: ex - bw/2, y1: ey - bh/2, x2: ex + bw/2, y2: ey + bh/2,
      cx: ex, cy: ey, scale: es, vx: evx, vy: evy, confidence,
    };
  }

  // Systematic resampling (O(N), single random draw) — from johnhw/pfilter MIT
  _resample() {
    const N = this.N;
    const r = Math.random() / N;
    const np = new Float32Array(N * 5);
    let c = 0, j = 0;
    for (let i = 0; i < N; i++) {
      const pos = r + i/N;
      while (pos > c && j < N) { c += this.w[j]; j++; }
      const src = (j-1) * 5;
      np[i*5]=this.p[src]; np[i*5+1]=this.p[src+1]; np[i*5+2]=this.p[src+2];
      np[i*5+3]=this.p[src+3]; np[i*5+4]=this.p[src+4];
    }
    // Inject INJECT_PCT fresh particles near current estimate (prevents long-term degeneracy)
    const nInj = Math.max(2, Math.floor(N * INJECT_PCT));
    let cx=0, cy=0;
    for (let i=0; i<N; i++){cx+=this.p[i*5]*this.w[i];cy+=this.p[i*5+1]*this.w[i];}
    for (let k=0; k<nInj; k++) {
      const idx = (N-1-k)*5;
      np[idx+0]=_clamp(cx+_randn()*18, 0, this.W-1);
      np[idx+1]=_clamp(cy+_randn()*18, 0, this.H-1);
      np[idx+2]=1.0+_randn()*0.08;
      np[idx+3]=0; np[idx+4]=0;
    }
    this.p = np;
    this.w.fill(1/N);
  }

  dispose() {
    this.isReady = false;
    this.prevRgba = null;
    this.tpl = null;
  }
}
