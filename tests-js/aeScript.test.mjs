// Per-shot After Effects (.jsx) handoff builder. Run: node tests-js/aeScript.test.mjs
import { buildAeScript } from '../src/scripts/features/vfxPull/aeScript.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

const baseJob = {
  plateName: 'SHOT_010_BG01_v001',
  shotId: 'SHOT_010',
  frameStart: 1001,
  expectedRenderedFrameCount: 48,
  fps: 24,
  package: { exr: 'plates' },
  colorPlan: { outputSpace: 'ACES2065-1' },
  reframe: { targetWidth: 3840, targetHeight: 2160 },
};
const opts = { manifest: { shotName: 'SHOT_010', colorInfo: { exrColorSpace: 'ACES2065-1' } } };

// Structure: builds a comp at FDL canvas size with the correct fps.
{
  const jsx = buildAeScript(baseJob, opts);
  ok(jsx.includes('app.newProject()'), 'creates a project');
  ok(/addComp\("SHOT_010_pull", TW, TH/.test(jsx) && jsx.includes('var TW    = 3840;') && jsx.includes('var TH    = 2160;'),
    'comp at FDL canvas size (3840x2160)');
  ok(jsx.includes('var FPS   = 24;') && jsx.includes('var COUNT = 48;'), 'fps + frame count baked');
  ok(jsx.includes('proj.workingSpace ='), 'uses real app.project.workingSpace DOM property (not colorSettings)');
}

// Bug-fix #4: reframe uses a UNIFORM scale (never per-axis squash).
{
  const job = { ...baseJob, geometry: { scale: 1, positionX: 0, positionY: 0 }, renderPlan: { bakeReframe: false } };
  const jsx = buildAeScript(job, opts);
  const m = jsx.match(/Scale"\)\.setValue\(\[(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)\]\)/);
  ok(m && m[1] === m[2], 'Scale X === Scale Y (uniform, no distortion)');
  // baked reframe → no transform.
  const baked = buildAeScript({ ...job, renderPlan: { bakeReframe: true } }, opts);
  ok(!/Scale"\)\.setValue/.test(baked) && /already baked/.test(baked), 'baked reframe → no scale, note only');
}

// Bug-fix #5: dynamic retime bakes per-frame Time Remap keyframes (not a single start speed).
{
  const job = { ...baseJob, expectedRenderedFrameCount: 3, frameCount: 3,
    retime: { hasSpeedChange: true, isDynamic: true,
      sourceFrameMap: [{ sourceFrame: 1001 }, { sourceFrame: 1002 }, { sourceFrame: 1004 }] } };
  const jsx = buildAeScript(job, opts);
  ok(jsx.includes('timeRemapEnabled = true'), 'enables Time Remap on speed change');
  ok(/var TIME_REMAP = \[.*time_sec.*\]/s.test(jsx), 'bakes the per-frame Time Remap table');
  ok(/KeyframeInterpolationType\.LINEAR/.test(jsx), 'linear between keys (ramp already resolved per-frame)');
}

// Color: CDL + show LUT conditional.
{
  const job = { ...baseJob,
    color: { match: { cdl: { slope: [1.1, 1, 0.9], offset: [0, 0, 0], power: [1, 1, 1], sat: 1.05 } } },
    colorPlan: { applyLook: true, luts: [{ type: 'show_lut', path: '/show/luts/v3.clf' }] } };
  const jsx = buildAeScript(job, opts);
  ok(/OCIO CDL Transform/.test(jsx) && jsx.includes('1.1'), 'CDL effect emitted from auto-match grade');
  ok(/OCIO File Transform/.test(jsx) && jsx.includes('/show/luts/v3.clf'), 'show LUT emitted when applyLook');

  const noLook = buildAeScript({ ...job, colorPlan: { applyLook: false, luts: job.colorPlan.luts } }, opts);
  ok(!/OCIO File Transform/.test(noLook), 'no show LUT when applyLook is false');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
