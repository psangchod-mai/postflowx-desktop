// OCF-to-reference reformat scale/fit computation. Run: node tests-js/computeReformatParams.test.mjs
import { computeReformatParams } from '../src/scripts/features/vfxPull/referenceMatchEngine.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// OCF wider than reference (e.g. 2.39 anamorphic plate → 16:9 reference): fit
// resolves to 'centerCrop', which must COVER the reference on both axes (the
// larger of the two per-axis scale factors), not letterbox it (the smaller one).
{
  const rp = computeReformatParams(1920, 1080, 2048, 858, null);
  ok(rp.fit === 'centerCrop', 'wider OCF than reference selects centerCrop');
  const expected = Math.max(1920 / 2048, 1080 / 858);
  ok(Math.abs(rp.scale - expected) < 1e-9, `centerCrop scale covers both axes (got ${rp.scale}, expected ${expected})`);
  ok(rp.scale * 858 >= 1080 - 1e-9, 'scaled OCF height covers the reference height (no letterbox gap)');
}

// OCF narrower/taller than reference: fit resolves to 'fit' (letterbox), which
// must CONTAIN the OCF within the reference (the smaller of the two factors).
{
  const rp = computeReformatParams(1920, 1080, 1000, 1000, null);
  ok(rp.fit === 'fit', 'narrower OCF than reference selects fit');
  const expected = Math.min(1920 / 1000, 1080 / 1000);
  ok(Math.abs(rp.scale - expected) < 1e-9, `fit scale contains within both axes (got ${rp.scale}, expected ${expected})`);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
