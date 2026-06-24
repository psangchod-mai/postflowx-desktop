// estimateCDL slope/offset/power/saturation solve. Run: node tests-js/cdlMatch.test.mjs
import { estimateCDL } from '../src/scripts/features/vfxPull/referenceMatchEngine.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

const W = 200, H = 200;
// 5×5 distinct colored blocks so the grid sampler gets varied mid-range patches.
function build(transform) {
  const a = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const gx = Math.min(4, Math.floor(x / (W / 5))), gy = Math.min(4, Math.floor(y / (H / 5)));
    let r = 80 + gx * 22, g = 70 + gy * 22, b = 120 + ((gx + gy) % 5) * 14;
    [r, g, b] = transform(r / 255, g / 255, b / 255).map(v => Math.max(0, Math.min(255, Math.round(v * 255))));
    const i = (y * W + x) * 4; a[i] = r; a[i + 1] = g; a[i + 2] = b; a[i + 3] = 255;
  }
  return a;
}
const ref = build((r, g, b) => [r, g, b]);

// Identity: ref === OCF → no correction, full confidence.
{
  const c = estimateCDL(ref, build((r, g, b) => [r, g, b]), W, H, W, H);
  ok(c.slope.every(s => Math.abs(s - 1) < 0.02), 'identity → slope ≈ 1');
  ok(c.power.every(p => p === 1), 'identity → power = 1 (no false gamma)');
  ok(c.sat === 1, 'identity → saturation = 1 (no false sat)');
  ok(c.confidence >= 90, 'identity → high confidence');
}

// OCF is gamma-darkened + desaturated vs ref → matching must raise saturation
// and lift the darkened mids (slope > 1). power stays conservative.
{
  const ocf = build((r, g, b) => {
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b, desat = 0.6, gamma = 1.5;
    return [L + desat * (r - L), L + desat * (g - L), L + desat * (b - L)].map(v => Math.pow(Math.max(0, v), gamma));
  });
  const c = estimateCDL(ref, ocf, W, H, W, H);
  ok(c.slope.every(s => s > 1), 'darkened OCF → slope > 1 (lifts toward ref)');
  ok(c.sat > 1, 'desaturated OCF → saturation > 1 (restores ref chroma)');
  ok(c.power.every(p => p >= 0.5 && p <= 2.0), 'power stays within clamp [0.5, 2.0]');
  ok(c.sat >= 0.5 && c.sat <= 1.8, 'saturation stays within clamp [0.5, 1.8]');
}

// Too few valid patches (all overexposed) → identity CDL, confidence 0.
{
  const white = build(() => [1, 1, 1]);
  const c = estimateCDL(white, white, W, H, W, H);
  ok(c.confidence === 0, 'overexposed frames → confidence 0');
  ok(c.power.every(p => p === 1) && c.sat === 1, 'overexposed → identity power/sat');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
