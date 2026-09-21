// imf_layer_compare.js — pure frame-compositing core for the IMF multi-layer
// (N-stack) compare preview (Sprint 5 #3).
//
// No DOM / canvas dependencies: every function operates on raw RGBA byte buffers
// (Uint8ClampedArray, 4 bytes/pixel) so the compare math is unit-testable headless.
// The player (imf_player.js) decodes the live layer + one soloed comparison layer
// to equal-size RGBA buffers, calls compositeFrames(), and blits the result.
//
// Exports:
//   COMPARE_MODES            — supported compare modes
//   compositeFrames(...)     — combine base (live) + comp (comparison) → RGBA out
//   diffStats(...)           — quantify how much two layers differ (for the QC chip)

export const COMPARE_MODES = ['split', 'difference', 'blend'];

function _clamp01(v) {
  v = Number(v);
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function _requireMatching(base, comp, width, height, fn) {
  const n = width * height * 4;
  if (!base || !comp) throw new Error(`${fn}: base and comp RGBA buffers are required`);
  if (base.length !== n || comp.length !== n) {
    throw new Error(`${fn}: buffer length mismatch (expected ${n} for ${width}x${height}, got base=${base.length}, comp=${comp.length}) — caller must scale layers to a common size first`);
  }
  return n;
}

/**
 * Composite the live layer (base) with a comparison layer (comp) into a new RGBA
 * buffer. Both buffers must be width*height*4 bytes (caller scales to match).
 *
 * Modes:
 *   'split'      — vertical divider; left of split = base, right = comp.
 *                  opts.split ∈ [0,1] (fraction of width; default 0.5).
 *   'difference' — per-channel |base − comp|, optionally amplified by opts.gain
 *                  (default 1). Identical layers → black. Surfaces exact changes.
 *   'blend'      — opacity mix: out = base*(1−a) + comp*a, a = opts.opacity ∈ [0,1]
 *                  (default 0.5).
 *
 * @returns {Uint8ClampedArray} new RGBA buffer (never mutates inputs)
 */
export function compositeFrames(base, comp, width, height, opts = {}) {
  const n = _requireMatching(base, comp, width, height, 'compositeFrames');
  const mode = COMPARE_MODES.includes(opts.mode) ? opts.mode : 'split';
  const out = new Uint8ClampedArray(n);

  if (mode === 'split') {
    const splitX = Math.round(_clamp01(opts.split ?? 0.5) * width);
    for (let y = 0; y < height; y++) {
      const rowStart = y * width;
      for (let x = 0; x < width; x++) {
        const i = (rowStart + x) * 4;
        const src = x < splitX ? base : comp;
        out[i] = src[i]; out[i + 1] = src[i + 1]; out[i + 2] = src[i + 2]; out[i + 3] = src[i + 3];
      }
    }
  } else if (mode === 'difference') {
    const gain = Number.isFinite(opts.gain) && opts.gain > 0 ? opts.gain : 1;
    for (let i = 0; i < n; i += 4) {
      out[i]     = Math.abs(base[i]     - comp[i])     * gain;   // Uint8Clamped auto-clamps
      out[i + 1] = Math.abs(base[i + 1] - comp[i + 1]) * gain;
      out[i + 2] = Math.abs(base[i + 2] - comp[i + 2]) * gain;
      out[i + 3] = 255;
    }
  } else { // 'blend'
    const a = _clamp01(opts.opacity ?? 0.5);
    const ia = 1 - a;
    for (let i = 0; i < n; i += 4) {
      out[i]     = base[i]     * ia + comp[i]     * a;
      out[i + 1] = base[i + 1] * ia + comp[i + 1] * a;
      out[i + 2] = base[i + 2] * ia + comp[i + 2] * a;
      out[i + 3] = base[i + 3] * ia + comp[i + 3] * a;
    }
  }
  return out;
}

/**
 * Quantify how much two layers differ at the current frame — drives a QC chip
 * (e.g. "12.3% of pixels differ"). A per-channel threshold ignores codec noise.
 *
 * @returns {{changedFraction:number, changedPercent:number, meanAbsDiff:number, identical:boolean}}
 */
export function diffStats(base, comp, width, height, opts = {}) {
  _requireMatching(base, comp, width, height, 'diffStats');
  const thr = Number.isFinite(opts.threshold) ? opts.threshold : 8;
  const px = width * height;
  let changed = 0, sum = 0;
  for (let p = 0; p < px; p++) {
    const i = p * 4;
    const dr = Math.abs(base[i] - comp[i]);
    const dg = Math.abs(base[i + 1] - comp[i + 1]);
    const db = Math.abs(base[i + 2] - comp[i + 2]);
    sum += dr + dg + db;
    if (dr > thr || dg > thr || db > thr) changed++;
  }
  return {
    changedFraction: px ? changed / px : 0,
    changedPercent:  px ? (changed / px) * 100 : 0,
    meanAbsDiff:     px ? sum / (px * 3) : 0,
    identical:       changed === 0,
  };
}
