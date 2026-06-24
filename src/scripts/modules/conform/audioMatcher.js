/**
 * audioMatcher.js — Client-side scoring helpers for trailer conform matching.
 *
 * The heavy audio cross-correlation happens in Python (companion).
 * This module provides:
 *   - Filename / reel fuzzy scoring
 *   - Duration overlap scoring
 *   - Combined confidence calculation
 *   - Phase 2: luma waveform comparison (from proxy thumbnails)
 *   - Speed-change detection from duration ratio
 *   - Slate/leader frame detection heuristics
 */

// ── Text normalisation ────────────────────────────────────────────────────────

function _normalise(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[^\w\s]/g, ' ')
    .toLowerCase()
    .trim();
}

function _tokens(s) {
  return new Set(_normalise(s).split(/\s+/).filter(t => t.length > 1));
}

function _jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const inter = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return inter / union;
}

export function filenameScore(reel = '', clipName = '', srcPath = '') {
  const stem = srcPath.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  const reelToks = new Set([..._tokens(reel), ..._tokens(clipName)]);
  const srcToks  = _tokens(stem);
  if (!reelToks.size || !srcToks.size) return 0;
  // Exact stem match
  if (_normalise(stem) === _normalise(reel)) return 1.0;
  return Math.min(1, _jaccard(reelToks, srcToks) * 1.5);
}

export function durationScore(eventFrames, srcDurationFrames, fps = 24) {
  if (eventFrames <= 0 || srcDurationFrames <= 0) return 0;
  if (eventFrames > srcDurationFrames + fps * 2) return 0; // event longer than src + 2s grace
  const ratio = eventFrames / srcDurationFrames;
  return Math.min(1, ratio > 1 ? 1 / ratio : ratio);
}

export function combineScores({ filename = 0, duration = 0, audio = 0 }, hasAudio = false) {
  if (hasAudio) {
    return filename * 0.35 + duration * 0.25 + audio * 0.40;
  }
  return filename * 0.55 + duration * 0.45;
}

// ── Phase 2: Luma waveform matching ──────────────────────────────────────────

/**
 * Extract per-frame average luma from a series of HTMLImageElement thumbnails.
 * @param {HTMLImageElement[]} imgs
 * @returns {number[]} luma values 0–255
 */
export function extractLumaEnvelope(imgs) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = 64;
  canvas.height = 36;
  return imgs.map(img => {
    ctx.drawImage(img, 0, 0, 64, 36);
    const px = ctx.getImageData(0, 0, 64, 36).data;
    let sum = 0;
    for (let i = 0; i < px.length; i += 4) {
      sum += 0.299 * px[i] + 0.587 * px[i+1] + 0.114 * px[i+2];
    }
    return sum / (64 * 36);
  });
}

function _pearson(a, b) {
  const n = a.length;
  if (n < 2) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const ai = a[i] - ma, bi = b[i] - mb;
    num += ai * bi;
    da  += ai * ai;
    db  += bi * bi;
  }
  if (da < 1e-9 || db < 1e-9) return 0;
  return Math.max(-1, Math.min(1, num / Math.sqrt(da * db)));
}

/**
 * Slide refWindow over srcEnvelope, return { score, offsetFrames }.
 */
export function lumaMatchScore(refEnvelope, refStartFrame, refDurFrames, srcEnvelope) {
  const win = refEnvelope.slice(refStartFrame, refStartFrame + refDurFrames);
  if (win.length < 2 || srcEnvelope.length < win.length) return { score: 0, offsetFrames: 0 };
  let best = -1, bestOffset = 0;
  const stride = Math.max(1, Math.floor(win.length / 10));
  for (let off = 0; off <= srcEnvelope.length - win.length; off += stride) {
    const s = _pearson(win, srcEnvelope.slice(off, off + win.length));
    if (s > best) { best = s; bestOffset = off; }
  }
  // Refine
  for (let off = Math.max(0, bestOffset - stride); off <= Math.min(srcEnvelope.length - win.length, bestOffset + stride); off++) {
    const s = _pearson(win, srcEnvelope.slice(off, off + win.length));
    if (s > best) { best = s; bestOffset = off; }
  }
  return { score: Math.max(0, best), offsetFrames: bestOffset };
}

// ── Speed-change detection ────────────────────────────────────────────────────

/**
 * Detect if a clip appears to be speed-changed.
 * @param {number} eventFrames  — duration in the edit (record side)
 * @param {number} srcFrames    — total source duration
 * @param {number} offsetFrames — matched offset into source
 * @param {number} fps
 * @returns {{ hasSpeedChange: boolean, speedRatio: number, description: string }}
 */
export function detectSpeedChange(eventFrames, srcFrames, offsetFrames = 0, fps = 24) {
  if (eventFrames <= 0 || srcFrames <= 0) return { hasSpeedChange: false, speedRatio: 1, description: '' };
  const usedFrames = Math.min(srcFrames - offsetFrames, srcFrames);
  if (usedFrames <= 0) return { hasSpeedChange: false, speedRatio: 1, description: '' };
  const ratio = eventFrames / usedFrames;
  const hasSpeedChange = ratio < 0.90 || ratio > 1.10;
  let description = '';
  if (hasSpeedChange) {
    const pct = Math.round(ratio * 100);
    description = ratio < 1 ? `Slow ${pct}%` : `Fast ${pct}%`;
  }
  return { hasSpeedChange, speedRatio: Math.round(ratio * 1000) / 1000, description };
}

// ── Slate / leader detection ──────────────────────────────────────────────────

/**
 * Estimate number of slate/leader frames at head of a luma envelope.
 * Leader = very dark frames (luma < 20) or very uniform frames.
 * @param {number[]} lumaEnvelope  — per-frame luma values
 * @returns {{ slateFrames: number, hasSlate: boolean }}
 */
export function detectSlateFrames(lumaEnvelope) {
  let slateFrames = 0;
  for (const luma of lumaEnvelope) {
    if (luma < 20 || luma > 235) slateFrames++;
    else break;
  }
  return { slateFrames, hasSlate: slateFrames > 0 };
}

// ── Confidence interpretation ─────────────────────────────────────────────────

export function confidenceLabel(score) {
  if (score >= 0.85) return 'high';
  if (score >= 0.60) return 'medium';
  if (score >= 0.30) return 'low';
  return 'none';
}

export function confidenceColor(score) {
  if (score >= 0.85) return '#4caf50';
  if (score >= 0.60) return '#f5c542';
  if (score >= 0.30) return '#e07030';
  return '#666';
}
