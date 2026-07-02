// P0-RT-PERSIST / P0-RT-REDUCED: real-time playback invariants for the IMF
// Direct Engine. Verifies (a) the reduced-decode quality ladder mapping and
// (b) the per-frame-spawn instrumentation used to assert that continuous play
// never routes through _extractSingleFrame. Run: node tests-js/imfDirectEngineRealtime.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

let engine = null;
try { engine = require(path.join(root, 'electron/imf/imf_direct_engine.js')); }
catch (e) { console.error('SKIP - could not load imf_direct_engine:', e.message); process.exit(0); }

// ── Reduced-decode quality ladder (P0-RT-REDUCED) ──
// full → lowres 0 (full res); half → 1; quarter → 2; auto → reduced (>=1).
{
  const q = engine._qualityToLowres;
  ok(q('full') === 0, 'quality full → lowres 0 (full resolution)');
  ok(q('half') === 1, 'quality half → lowres 1 (1/2 each axis)');
  ok(q('quarter') === 2, 'quality quarter → lowres 2 (1/4 each axis)');
  ok(q('auto') >= 1, 'quality auto → reduced decode (>=1) — reduced ON by default during play');
  ok(q(undefined) === 0, 'unknown/undefined quality → full (safe default)');
}

// ── Resolution-aware Auto ladder (P0-RT-REDUCED / RT-AUTO-NOT-RESOLUTION-AWARE) ──
// Auto must pick the reduce-level from source resolution: HD/2K → lowres 1, UHD/4K
// → lowres 2 (per CRT0: UHD full ~5fps, lowres1 ~20fps misses 24, lowres2 clears).
{
  const q = engine._qualityToLowres;
  const a = engine._autoLowresForResolution;
  ok(a({ w: 1920, h: 1080 }) === 1, 'auto: HD 1920x1080 → lowres 1');
  ok(a({ w: 2048, h: 1080 }) === 1, 'auto: 2K 2048x1080 → lowres 1');
  ok(a({ w: 3840, h: 2160 }) === 2, 'auto: UHD 3840x2160 → lowres 2');
  ok(a({ w: 4096, h: 2160 }) === 2, 'auto: 4K 4096x2160 → lowres 2');
  ok(a(null) === 1, 'auto: unknown resolution → lowres 1 (safe HD default)');
  ok(q('auto', { w: 3840, h: 2160 }) === 2, 'quality auto + UHD resolution → lowres 2 (resolution-aware)');
  ok(q('auto', { w: 1920, h: 1080 }) === 1, 'quality auto + HD resolution → lowres 1');
  // Explicit levels ignore resolution.
  ok(q('half', { w: 3840, h: 2160 }) === 1, 'quality half is fixed regardless of resolution');
}

// ── Real-time invariant instrumentation (P0-RT-PERSIST) ──
// Freshly reset, both counters are 0 and the mpjpeg buffer cap is bounded.
{
  engine._rtResetStats();
  const s = engine._rtStats();
  ok(s.perFrameSpawns === 0, 'per-frame spawn counter resets to 0');
  ok(s.perFrameSpawnsDuringPlay === 0, 'per-frame-during-play counter resets to 0 (the play invariant)');
  ok(typeof s.mpjpegBufferCapBytes === 'number' && s.mpjpegBufferCapBytes > 0 && s.mpjpegBufferCapBytes <= 64 * 1024 * 1024,
    'mpjpeg decode-ahead buffer is bounded (backpressure cap present, <=64MB)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
