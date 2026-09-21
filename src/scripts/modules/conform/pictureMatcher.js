/**
 * pictureMatcher.js — Region-robust perceptual frame hashing for trailer conform.
 *
 * Ported from V1.4's conform_lib.py `regional_hash()` / `regional_distance()`.
 *
 * A whole-frame hash is corrupted by any burn-in/watermark/timecode overlay
 * that covers part of the frame — every downstream comparison against a
 * clean master inherits that corruption. This splits each frame into a 4×4
 * grid (16 cells) and hashes each cell independently (8×8 dHash → 64 bits
 * per cell). On comparison, the 6 worst-matching cells are discarded before
 * summing distance, so localized garbage in a few cells (the typical place
 * a lower-third TC or logo lands) doesn't poison the match.
 */

const GRID           = 4;                          // 4×4 grid → 16 cells
const CELL_HASH_SIZE  = 8;                          // 8×8 dHash per cell → 64 bits
const N_BEST_CELLS    = 10;                         // sum only the 10 lowest-distance cells
const GRID_CELLS      = GRID * GRID;                // 16
const CELL_BITS       = CELL_HASH_SIZE * CELL_HASH_SIZE; // 64

// Resize target chosen so each of the 16 cells divides evenly (mirrors conform_lib.py).
const TARGET_W = GRID * (CELL_HASH_SIZE + 1) * 4;   // 144
const TARGET_H = GRID * CELL_HASH_SIZE * 4;         // 128
const CELL_W   = TARGET_W / GRID;                   // 36
const CELL_H   = TARGET_H / GRID;                   // 32

// Theoretical max for the robust-distance metric (10 cells × 64 bits).
export const MAX_DISTANCE = N_BEST_CELLS * CELL_BITS; // 640

// Mirrors conform.py's THRESH_OK / THRESH_REVIEW.
const THRESH_OK     = 80;
const THRESH_REVIEW = 200;

let _canvas = null;
let _ctx    = null;
function _scratch() {
  if (!_canvas) {
    _canvas = document.createElement('canvas');
    _canvas.width  = TARGET_W;
    _canvas.height = TARGET_H;
    _ctx = _canvas.getContext('2d', { willReadFrequently: true });
  }
  return _ctx;
}

// Box-average a grayscale sub-region down to outW×outH (cv2.INTER_AREA equivalent).
function _downsampleGray(gray, srcW, x0, y0, cellW, cellH, outW, outH) {
  const out = new Float32Array(outW * outH);
  for (let oy = 0; oy < outH; oy++) {
    const sy0 = y0 + Math.floor((oy * cellH) / outH);
    const sy1 = Math.max(sy0 + 1, y0 + Math.floor(((oy + 1) * cellH) / outH));
    for (let ox = 0; ox < outW; ox++) {
      const sx0 = x0 + Math.floor((ox * cellW) / outW);
      const sx1 = Math.max(sx0 + 1, x0 + Math.floor(((ox + 1) * cellW) / outW));
      let sum = 0, count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const row = sy * srcW;
        for (let sx = sx0; sx < sx1; sx++) { sum += gray[row + sx]; count++; }
      }
      out[oy * outW + ox] = count ? sum / count : 0;
    }
  }
  return out;
}

/**
 * Compute a 16-cell regional dHash from an image source (video/canvas/img element).
 * @param {CanvasImageSource} source
 * @returns {Uint8Array} length GRID_CELLS * CELL_BITS (1024) — 0/1 bits, cell-major then row-major.
 */
export function regionalHash(source) {
  const ctx = _scratch();
  ctx.drawImage(source, 0, 0, TARGET_W, TARGET_H);
  const data = ctx.getImageData(0, 0, TARGET_W, TARGET_H).data;

  const gray = new Float32Array(TARGET_W * TARGET_H);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  const bits = new Uint8Array(GRID_CELLS * CELL_BITS);
  const W1 = CELL_HASH_SIZE + 1;
  for (let cy = 0; cy < GRID; cy++) {
    for (let cx = 0; cx < GRID; cx++) {
      const small = _downsampleGray(gray, TARGET_W, cx * CELL_W, cy * CELL_H, CELL_W, CELL_H, W1, CELL_HASH_SIZE);
      const cellIdx = cy * GRID + cx;
      const base = cellIdx * CELL_BITS;
      for (let y = 0; y < CELL_HASH_SIZE; y++) {
        for (let x = 0; x < CELL_HASH_SIZE; x++) {
          bits[base + y * CELL_HASH_SIZE + x] = small[y * W1 + x + 1] > small[y * W1 + x] ? 1 : 0;
        }
      }
    }
  }
  return bits;
}

/**
 * Robust distance between two regional hashes: per-cell Hamming distance,
 * sorted ascending, summing only the best N_BEST_CELLS (discarding the 6
 * cells most likely corrupted by burn-ins/watermarks). Lower = better match.
 * @returns {number} 0..MAX_DISTANCE
 */
export function regionalDistance(a, b) {
  const perCell = new Array(GRID_CELLS);
  for (let c = 0; c < GRID_CELLS; c++) {
    const base = c * CELL_BITS;
    let d = 0;
    for (let i = 0; i < CELL_BITS; i++) if (a[base + i] !== b[base + i]) d++;
    perCell[c] = d;
  }
  perCell.sort((x, y) => x - y);
  let sum = 0;
  for (let i = 0; i < N_BEST_CELLS; i++) sum += perCell[i];
  return sum;
}

/**
 * Vectorized distance from one query hash to many candidate hashes.
 * @param {Uint8Array} query
 * @param {Uint8Array[]} candidates
 * @returns {number[]}
 */
export function regionalDistanceBatch(query, candidates) {
  return candidates.map(hash => regionalDistance(query, hash));
}

/** distance (0..640, lower=better) → confidence (0..100, higher=better), clamped linear inversion. */
export function distanceToConfidence(distance) {
  return Math.max(0, Math.min(100, Math.round((1 - distance / MAX_DISTANCE) * 100)));
}

/** Mirrors conform.py's THRESH_OK/THRESH_REVIEW classification. */
export function confidenceStatus(distance) {
  if (distance <= THRESH_OK) return 'OK';
  if (distance <= THRESH_REVIEW) return 'REVIEW';
  return 'NO_MATCH';
}
