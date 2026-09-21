// IMF multi-layer compare core (Sprint 5 #3). Run: node tests-js/imfLayerCompare.test.mjs
import { COMPARE_MODES, compositeFrames, diffStats } from '../src/scripts/modules/imf/imf_layer_compare.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// Helpers to build solid-colour RGBA buffers.
const fill = (w, h, [r, g, b, a = 255]) => {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a; }
  return buf;
};
const px = (buf, w, x, y) => { const i = (y * w + x) * 4; return [buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]; };

const W = 4, H = 2;
const BASE = fill(W, H, [200, 100, 50]);   // base/live
const COMP = fill(W, H, [50, 150, 250]);   // comparison

// ── split ──────────────────────────────────────────────────────────────────
{
  const out = compositeFrames(BASE, COMP, W, H, { mode: 'split', split: 0.5 });
  ok(px(out, W, 0, 0).join() === '200,100,50,255', 'split: left half = base');
  ok(px(out, W, 3, 0).join() === '50,150,250,255', 'split: right half = comp');
  ok(px(out, W, 1, 1).join() === '200,100,50,255', 'split: row 2 left also base');
  // split=0 → all comp; split=1 → all base
  const allComp = compositeFrames(BASE, COMP, W, H, { mode: 'split', split: 0 });
  ok(px(allComp, W, 0, 0).join() === '50,150,250,255', 'split=0 → entirely comp');
  const allBase = compositeFrames(BASE, COMP, W, H, { mode: 'split', split: 1 });
  ok(px(allBase, W, 3, 1).join() === '200,100,50,255', 'split=1 → entirely base');
  // out-of-range split is clamped
  const clamped = compositeFrames(BASE, COMP, W, H, { mode: 'split', split: 5 });
  ok(px(clamped, W, 3, 0).join() === '200,100,50,255', 'split>1 clamps to 1 (all base)');
}

// ── difference ───────────────────────────────────────────────────────────────
{
  const out = compositeFrames(BASE, COMP, W, H, { mode: 'difference' });
  // |200-50|=150, |100-150|=50, |50-250|=200, alpha forced 255
  ok(px(out, W, 0, 0).join() === '150,50,200,255', 'difference: per-channel |base-comp|, alpha=255');
  const same = compositeFrames(BASE, BASE, W, H, { mode: 'difference' });
  ok(px(same, W, 2, 1).join() === '0,0,0,255', 'difference of identical layers → black');
  // gain amplifies and clamps
  const gained = compositeFrames(BASE, COMP, W, H, { mode: 'difference', gain: 2 });
  ok(px(gained, W, 0, 0)[0] === 255, 'difference gain=2 amplifies + clamps (150*2→255)');
}

// ── blend ────────────────────────────────────────────────────────────────────
{
  const mid = compositeFrames(BASE, COMP, W, H, { mode: 'blend', opacity: 0.5 });
  // (200+50)/2=125, (100+150)/2=125, (50+250)/2=150
  ok(px(mid, W, 0, 0).slice(0, 3).join() === '125,125,150', 'blend 0.5 → channel average');
  const b0 = compositeFrames(BASE, COMP, W, H, { mode: 'blend', opacity: 0 });
  ok(px(b0, W, 0, 0).slice(0, 3).join() === '200,100,50', 'blend opacity 0 → base');
  const b1 = compositeFrames(BASE, COMP, W, H, { mode: 'blend', opacity: 1 });
  ok(px(b1, W, 0, 0).slice(0, 3).join() === '50,150,250', 'blend opacity 1 → comp');
}

// ── mode fallback & validation ────────────────────────────────────────────────
{
  const def = compositeFrames(BASE, COMP, W, H, { mode: 'bogus', split: 0.5 });
  ok(px(def, W, 0, 0).join() === '200,100,50,255', 'invalid mode falls back to split');
  ok(COMPARE_MODES.length === 3 && COMPARE_MODES.includes('difference'), 'COMPARE_MODES exported');
  let threw = false;
  try { compositeFrames(BASE, fill(2, 2, [0, 0, 0]), W, H, {}); } catch { threw = true; }
  ok(threw, 'buffer length mismatch throws (caller must scale to common size)');
  let threw2 = false;
  try { compositeFrames(null, COMP, W, H, {}); } catch { threw2 = true; }
  ok(threw2, 'missing base buffer throws');
}

// ── diffStats ─────────────────────────────────────────────────────────────────
{
  const same = diffStats(BASE, BASE, W, H);
  ok(same.identical === true && same.changedPercent === 0 && same.meanAbsDiff === 0, 'diffStats: identical → 0% / identical');
  const full = diffStats(BASE, COMP, W, H);   // every pixel differs well beyond threshold
  ok(full.changedPercent === 100 && !full.identical, 'diffStats: all-different → 100% changed');
  // meanAbsDiff = (150+50+200)/3 = 133.33…
  ok(Math.abs(full.meanAbsDiff - (150 + 50 + 200) / 3) < 1e-6, 'diffStats: meanAbsDiff matches per-channel mean');
  // threshold ignores sub-threshold noise
  const noisy = fill(W, H, [205, 103, 54]);   // +5/+3/+4 vs BASE, all ≤ default threshold 8
  const noiseStats = diffStats(BASE, noisy, W, H, { threshold: 8 });
  ok(noiseStats.changedPercent === 0 && noiseStats.meanAbsDiff > 0, 'diffStats: threshold ignores codec noise (0% changed but non-zero mean)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
