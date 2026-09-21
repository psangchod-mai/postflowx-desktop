/**
 * Continuous picture comparison for Trailer Conform.
 *
 * Regional dHash is deliberately tolerant of burn-ins, but that tolerance can
 * also make two different shots with similar composition look deceptively
 * close. This companion metric compares actual luma values in a 4x4 grid and
 * keeps the best 10 cells, preserving burn-in resistance while requiring the
 * underlying pixels to correlate.
 */

const GRID = 4;
const KEEP = 10;

function luma(data, pixelIndex) {
  const p = pixelIndex * 4;
  return 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
}

function cellScore(a, b, width, x0, y0, x1, y1) {
  let count = 0;
  let sumA = 0, sumB = 0, absDiff = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      const av = luma(a, i), bv = luma(b, i);
      sumA += av; sumB += bv; absDiff += Math.abs(av - bv); count++;
    }
  }
  if (!count) return 0;

  const meanA = sumA / count, meanB = sumB / count;
  let covariance = 0, varianceA = 0, varianceB = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      const da = luma(a, i) - meanA;
      const db = luma(b, i) - meanB;
      covariance += da * db;
      varianceA += da * da;
      varianceB += db * db;
    }
  }

  const denom = Math.sqrt(varianceA * varianceB);
  const correlation = denom > 1e-6
    ? Math.max(-1, Math.min(1, covariance / denom))
    : (Math.abs(meanA - meanB) <= 2 ? 1 : 0);
  const correlationScore = ((correlation + 1) / 2) * 100;
  const maeScore = Math.max(0, 100 - (absDiff / count / 255) * 100);
  return 0.75 * correlationScore + 0.25 * maeScore;
}

/**
 * @param {Uint8ClampedArray|Uint8Array} a RGBA pixels
 * @param {Uint8ClampedArray|Uint8Array} b RGBA pixels
 * @param {number} width
 * @param {number} height
 * @returns {number} 0..100, higher is more visually alike
 */
export function robustPixelSimilarity(a, b, width, height) {
  if (!a || !b || a.length !== b.length || a.length !== width * height * 4 || width < GRID || height < GRID) return 0;
  const scores = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const x0 = Math.floor((gx * width) / GRID);
      const x1 = Math.floor(((gx + 1) * width) / GRID);
      const y0 = Math.floor((gy * height) / GRID);
      const y1 = Math.floor(((gy + 1) * height) / GRID);
      scores.push(cellScore(a, b, width, x0, y0, x1, y1));
    }
  }
  scores.sort((x, y) => y - x);
  const kept = scores.slice(0, KEEP);
  return Math.max(0, Math.min(100, Math.round(kept.reduce((sum, v) => sum + v, 0) / kept.length)));
}

export function pixelSimilarityStatus(score) {
  if (score >= 88) return 'OK';
  if (score >= 72) return 'REVIEW';
  return 'NO_MATCH';
}
