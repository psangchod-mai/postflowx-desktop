/**
 * shotDetect.js — CV shot-boundary detection cores (V1.4 conform_lib port).
 *
 * Ported from V1.4 conform_lib.py `_choose_threshold()` + `detect_shots()`.
 * These are the pure decision functions; the DOM side (index.js
 * `_detectShotsFromVideo`) decodes frames, builds per-frame HSV histograms and
 * their consecutive correlations, and feeds them here.
 *
 * Lets Trailer Conform segment an offline into shots when NO agency EDL/XML is
 * available. When an EDL IS present it stays authoritative (its record-TC cuts
 * are exact), so this path is a fallback, mirroring V1.4's own preference order.
 */

/**
 * HISTCMP_CORREL between two flat histogram vectors (mirrors cv2.compareHist).
 * Returns a correlation in roughly [-1, 1] (1 = identical). Used by the DOM
 * decoder to build the correlation series this module segments on.
 * @param {number[]|Float32Array} h1
 * @param {number[]|Float32Array} h2
 */
export function histCorrelation(h1, h2) {
  const n = Math.min(h1.length, h2.length);
  if (!n) return 1;
  let m1 = 0, m2 = 0;
  for (let i = 0; i < n; i++) { m1 += h1[i]; m2 += h2[i]; }
  m1 /= n; m2 /= n;
  let num = 0, d1 = 0, d2 = 0;
  for (let i = 0; i < n; i++) {
    const a = h1[i] - m1, b = h2[i] - m2;
    num += a * b; d1 += a * a; d2 += b * b;
  }
  const den = Math.sqrt(d1 * d2);
  return den === 0 ? 1 : num / den;   // flat/identical histograms → perfectly correlated
}

/**
 * Auto-pick a shot-cut threshold from the correlation distribution.
 * Faithful port of conform_lib._choose_threshold().
 * @param {number[]} correlations consecutive-frame correlations (low = a cut)
 * @returns {number} threshold; correlations below it are treated as cuts
 */
export function chooseThreshold(correlations) {
  if (!correlations || correlations.length < 30) return 0.85; // too little data for stats

  const s = correlations.slice().sort((a, b) => a - b);

  // Bottom ~1.5% of transitions are our cut candidates (min 3, max 40).
  const nLikelyCuts = Math.min(40, Math.max(3, Math.floor(s.length * 0.015)));
  const cutBandMax = s[nLikelyCuts - 1];

  // If even the top of the cut band is very high, the content is likely a single
  // continuous shot (interview / slow montage) — back off so we don't false-split.
  if (cutBandMax > 0.95) return 0.5;

  const threshold = cutBandMax + 0.02;   // small margin above the cut cluster
  return Math.max(0.5, Math.min(0.97, threshold));
}

/**
 * Segment a correlation series into shots. Faithful port of the detect_shots()
 * loop (correlations[i] compares frame i+1 to frame i, so a drop starts a new
 * shot at i+1). Shots shorter than minShotFrames are absorbed into their
 * predecessor (filters flash frames / compression noise).
 *
 * @param {number[]} correlations
 * @param {number} total total frame count of the offline
 * @param {object} [opts]
 * @param {number|null} [opts.threshold] explicit threshold, else auto (chooseThreshold)
 * @param {number} [opts.minShotFrames=12] 0.5s @ 24fps
 * @returns {{shots: {startFrame:number,endFrame:number}[], threshold:number, warnings:string[]}}
 */
export function segmentShots(correlations, total, opts = {}) {
  const minShotFrames = opts.minShotFrames ?? 12;
  const warnings = [];
  if (!correlations || !correlations.length) return { shots: [], threshold: 0, warnings };

  const threshold = (opts.threshold == null) ? chooseThreshold(correlations) : opts.threshold;

  const shots = [];
  let shotStart = 0;
  for (let i = 0; i < correlations.length; i++) {
    const frameIdx = i + 1;
    if (correlations[i] < threshold && (frameIdx - shotStart) >= minShotFrames) {
      shots.push({ startFrame: shotStart, endFrame: frameIdx - 1 });
      shotStart = frameIdx;
    }
  }
  if (total > shotStart) shots.push({ startFrame: shotStart, endFrame: total - 1 });

  // Pathological-count sanity warnings (mirror conform_lib's log.warning cases).
  if (shots.length === 1 && total > 240) {
    warnings.push('Only 1 shot detected — detection may have missed cuts. Try a higher threshold (e.g. 0.95).');
  } else if (shots.length > Math.floor(total / 12)) {
    warnings.push(`${shots.length} shots in ${total} frames (very dense). Try a lower threshold (e.g. 0.6) to reduce false cuts.`);
  }

  return { shots, threshold, warnings };
}
