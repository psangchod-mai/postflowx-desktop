// pictureMatcher regional-hash distance tests. Run: node tests-js/pictureMatcher.test.mjs
//
// regionalHash() itself needs a real 2D canvas (drawImage/getImageData), which
// this repo's Node test harness has no backend for (no `canvas` dependency) —
// so these tests exercise the ported algorithm directly on synthetic hash
// arrays: regionalDistance's best-10-of-16 robustness, and the
// distance→confidence/status conversions.
import {
  regionalDistance,
  regionalDistanceBatch,
  distanceToConfidence,
  confidenceStatus,
  MAX_DISTANCE,
} from '../src/scripts/modules/conform/pictureMatcher.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

const GRID_CELLS = 16;
const CELL_BITS = 64;

function makeHash(fill = 0) {
  return new Uint8Array(GRID_CELLS * CELL_BITS).fill(fill);
}

// Flip every bit in the given cell index.
function flipCell(hash, cellIdx) {
  const out = hash.slice();
  const base = cellIdx * CELL_BITS;
  for (let i = 0; i < CELL_BITS; i++) out[base + i] = out[base + i] ? 0 : 1;
  return out;
}

// Identical hashes → zero distance.
{
  const a = makeHash(0);
  const b = a.slice();
  ok(regionalDistance(a, b) === 0, 'identical hashes → distance 0');
}

// Every cell mismatched → distance is capped at N_BEST_CELLS*CELL_BITS = MAX_DISTANCE
// even though the *total* mismatch across all 16 cells would be 16*64=1024.
{
  const a = makeHash(0);
  const b = makeHash(1); // every bit differs in every cell
  ok(regionalDistance(a, b) === MAX_DISTANCE, `fully mismatched → distance == MAX_DISTANCE (${MAX_DISTANCE})`);
}

// Watermark-corrupted robustness: corrupt 6 of 16 cells completely (simulating
// a burned-in timecode/logo overlay); the other 10 cells still match exactly.
// The best-10-of-16 selection should discard the 6 corrupted cells entirely,
// yielding distance 0 despite ~37% of the frame being garbage.
{
  let a = makeHash(0);
  let b = a.slice();
  for (let c = 0; c < 6; c++) b = flipCell(b, c);
  ok(regionalDistance(a, b) === 0, 'best-10-of-16 discards 6 fully-corrupted cells → distance 0');
}

// Corrupting 7 of 16 cells leaves only 9 good cells, so the worst-of-the-good
// cells (a 10th, still-corrupted one) must be included → distance > 0.
{
  let a = makeHash(0);
  let b = a.slice();
  for (let c = 0; c < 7; c++) b = flipCell(b, c);
  const d = regionalDistance(a, b);
  ok(d === CELL_BITS, `7 corrupted cells (>6 tolerance) → exactly one corrupted cell counted (distance ${d} === ${CELL_BITS})`);
}

// Distance sums the *smallest* per-cell distances, not an arbitrary subset —
// verify with graduated per-cell corruption.
{
  const a = makeHash(0);
  const b = a.slice();
  // Give cells 0..15 distances 1,2,3,...,16 bit-flips respectively.
  for (let c = 0; c < GRID_CELLS; c++) {
    const base = c * CELL_BITS;
    for (let i = 0; i <= c; i++) b[base + i] = 1;
  }
  // Best 10 cells are those with fewest flips: distances 1..10 → sum 55.
  const expected = Array.from({ length: 10 }, (_, i) => i + 1).reduce((s, v) => s + v, 0);
  ok(regionalDistance(a, b) === expected, `sums the 10 lowest per-cell distances (got ${regionalDistance(a, b)}, want ${expected})`);
}

// regionalDistanceBatch matches per-candidate regionalDistance.
{
  const q = makeHash(0);
  const candidates = [makeHash(0), makeHash(1), flipCell(makeHash(0), 3)];
  const batch = regionalDistanceBatch(q, candidates);
  const direct = candidates.map(c => regionalDistance(q, c));
  ok(JSON.stringify(batch) === JSON.stringify(direct), 'regionalDistanceBatch matches per-candidate regionalDistance');
}

// distanceToConfidence: 0 → 100, MAX_DISTANCE → 0, linear + clamped.
{
  ok(distanceToConfidence(0) === 100, 'distance 0 → confidence 100');
  ok(distanceToConfidence(MAX_DISTANCE) === 0, 'distance MAX_DISTANCE → confidence 0');
  ok(distanceToConfidence(MAX_DISTANCE + 100) === 0, 'distance beyond MAX_DISTANCE clamps to confidence 0');
  ok(distanceToConfidence(MAX_DISTANCE / 2) === 50, 'distance at midpoint → confidence 50');
}

// confidenceStatus thresholds mirror conform.py's THRESH_OK/THRESH_REVIEW.
{
  ok(confidenceStatus(0) === 'OK', 'distance 0 → OK');
  ok(confidenceStatus(80) === 'OK', 'distance at THRESH_OK boundary (80) → OK');
  ok(confidenceStatus(81) === 'REVIEW', 'distance just past THRESH_OK → REVIEW');
  ok(confidenceStatus(200) === 'REVIEW', 'distance at THRESH_REVIEW boundary (200) → REVIEW');
  ok(confidenceStatus(201) === 'NO_MATCH', 'distance just past THRESH_REVIEW → NO_MATCH');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
