// Dynamic speed-ramp source-frame map. Run: node tests-js/dynamicRamp.test.mjs
import { buildDynamicSourceFrameMap } from '../src/scripts/smart/smartExrPullPlanner.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// Linear ramp 100% → 200% across the segment, anchored at source frame 1000.
{
  const keys = [{ tc: '00:00:00:00', speed: 1 }, { tc: '00:00:04:03', speed: 2 }]; // ~99f @24
  const m = buildDynamicSourceFrameMap(keys, { srcInFrames: 1000, outputFrameCount: 100, fps: 24 });
  ok(Array.isArray(m) && m.length === 100, 'ramp produces one entry per output frame');
  ok(m[0].sourceFrame === 1000, 'map is anchored at the source in-point (1000)');
  let mono = true;
  for (let i = 1; i < m.length; i++) if (m[i].sourceFrame < m[i - 1].sourceFrame) mono = false;
  ok(mono, 'source frames are monotonic non-decreasing (never plays backward)');
  ok(m[0].speed === 100 && m[99].speed === 200, 'speed column ramps 100%→200%');
  // A 1.0→2.0 ramp integrates to ~1.5× the frame count of source advance.
  const span = m[99].sourceFrame - m[0].sourceFrame;
  ok(span >= 140 && span <= 155, `source span matches the ramp integral (~148, got ${span})`);
  ok(m.every(e => e.retimeType === 'dynamic'), 'every entry tagged retimeType=dynamic');
}

// Constant-speed keys (both 200%) → linear 2× advance, no acceleration.
{
  const keys = [{ tc: '00:00:00:00', speed: 2 }, { tc: '00:00:04:03', speed: 2 }];
  const m = buildDynamicSourceFrameMap(keys, { srcInFrames: 0, outputFrameCount: 10, fps: 24 });
  ok(m[0].sourceFrame === 0 && m[5].sourceFrame === 10 && m[9].sourceFrame === 18,
    'flat 200% advances 2 source frames per output frame');
}

// speed given as a factor (2.0) vs percent (200) must be equivalent.
{
  const asFactor  = buildDynamicSourceFrameMap([{ tc: '00:00:00:00', speed: 2 }, { tc: '00:00:01:00', speed: 2 }], { srcInFrames: 0, outputFrameCount: 8, fps: 24 });
  const asPercent = buildDynamicSourceFrameMap([{ tc: '00:00:00:00', speed: 200 }, { tc: '00:00:01:00', speed: 200 }], { srcInFrames: 0, outputFrameCount: 8, fps: 24 });
  ok(JSON.stringify(asFactor) === JSON.stringify(asPercent), 'speed factor 2.0 ≡ percent 200');
}

// Guards: fewer than 2 keys, or zero output frames → null (caller falls back).
{
  ok(buildDynamicSourceFrameMap([{ tc: '00:00:00:00', speed: 2 }], { srcInFrames: 0, outputFrameCount: 10, fps: 24 }) === null, 'single keyframe → null');
  ok(buildDynamicSourceFrameMap([], { srcInFrames: 0, outputFrameCount: 10, fps: 24 }) === null, 'no keyframes → null');
  ok(buildDynamicSourceFrameMap([{ tc: '00:00:00:00', speed: 1 }, { tc: '00:00:01:00', speed: 2 }], { srcInFrames: 0, outputFrameCount: 0, fps: 24 }) === null, 'zero output frames → null');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
