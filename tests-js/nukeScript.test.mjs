// Per-shot Nuke (.nk) handoff builder. Run: node tests-js/nukeScript.test.mjs
import { buildNukeScript } from '../src/scripts/features/vfxPull/nukeScript.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

const baseJob = {
  plateName: 'SHOT_010_BG01_v001',
  shotId: 'SHOT_010',
  frameStart: 1001,
  expectedRenderedFrameCount: 100,
  package: { exr: 'plates' },
  colorPlan: { outputSpace: 'ACES2065-1' },
  sourcePath: '/ocf/A001.mxf',
  metadata: { matchConfidence: 96, visualMatch: 91 },
};
const opts = {
  manifest: { shotName: 'SHOT_010', colorInfo: { exrColorSpace: 'ACES2065-1' } },
  frameMapPath: '/pkg/metadata/SHOT_010_frame_map.csv',
  amfPath: '/pkg/amf/SHOT_010_BG01_v001.amf',
  resizePath: '/pkg/metadata/SHOT_010_resize.json',
};

// Read node: correct file + frame range + colorspace.
{
  const nk = buildNukeScript(baseJob, opts);
  ok(nk.includes('file "plates/SHOT_010_BG01_v001.%04d.exr"'), 'Read points at the plate sequence');
  ok(nk.includes('first 1001') && nk.includes('last 1100'), 'Read frame range = start..start+count-1');
  ok(nk.includes('colorspace "ACES2065-1"'), 'Read colorspace from color plan');
  ok(/Write \{[\s\S]*disable true/.test(nk), 'disabled comp Write placeholder present');
}

// CDL node emitted from the auto-match grade.
{
  const job = { ...baseJob, color: { match: { confidence: 87, cdl: { slope: [1.1, 1.0, 0.9], offset: [0.01, 0, -0.01], power: [1, 1, 1], sat: 1.05 } } } };
  const nk = buildNukeScript(job, opts);
  ok(nk.includes('OCIOCDLTransform'), 'CDL node present when a match CDL exists');
  ok(nk.includes('slope {1.1 1 0.9}'), 'CDL slope written');
  ok(nk.includes('offset {0.01 0 -0.01}'), 'CDL offset written');
  ok(nk.includes('saturation 1.05'), 'CDL saturation written');
  ok(/AUTO-MATCH CDL 87%/.test(nk), 'CDL labelled as auto-match reference with confidence');
}
// No CDL node when there is no match grade.
{
  const nk = buildNukeScript(baseJob, opts);
  ok(!nk.includes('OCIOCDLTransform'), 'no CDL node without a match grade');
}

// Reframe: sidecar (not baked) → Reformat node; baked → sticky note.
{
  const job = { ...baseJob, reframe: { mode: 'match_qt_ref_uhd', targetWidth: 3840, targetHeight: 2160, fit: 'centerCrop' }, renderPlan: { bakeReframe: false } };
  const nk = buildNukeScript(job, opts);
  ok(nk.includes('Reformat') && nk.includes('box_width 3840') && nk.includes('box_height 2160'), 'Reformat from FDL when not baked');
  ok(nk.includes('resize fill'), 'centerCrop maps to resize fill');

  const baked = buildNukeScript({ ...job, renderPlan: { bakeReframe: true } }, opts);
  ok(!baked.includes('Reformat {') && /baked into plate/.test(baked), 'baked reframe → sticky note, no Reformat');
}

// Retime: constant → Retime node; dynamic → frame-map sticky.
{
  const constant = buildNukeScript({ ...baseJob, retime: { hasSpeedChange: true, speed: 0.5, speedPercent: 50 } }, opts);
  ok(/Retime \{[\s\S]*speed 0.5/.test(constant), 'constant speed → Retime node with speed factor');

  const dynamic = buildNukeScript({ ...baseJob, retime: { hasSpeedChange: true, isDynamic: true } }, opts);
  ok(/DYNAMIC[\s\S]*frame_map/.test(dynamic), 'dynamic ramp w/o map → sticky pointing at the frame map');

  const freeze = buildNukeScript({ ...baseJob, retime: { freeze: { frame: 5 } } }, opts);
  ok(/FREEZE/.test(freeze), 'freeze w/o map → freeze sticky');
}

// Gap 2: dynamic WITH a resolved sourceFrameMap → TimeWarp lookup curve (plate-local).
{
  const job = { ...baseJob, retime: { hasSpeedChange: true, isDynamic: true,
    sourceFrameMap: [{ sourceFrame: 1001 }, { sourceFrame: 1002 }, { sourceFrame: 1005 }] } };
  const nk = buildNukeScript(job, opts);
  ok(/TimeWarp \{[\s\S]*lookup \{\{curve /.test(nk), 'dynamic+map → TimeWarp with lookup curve');
  ok(nk.includes('x1001 1001 x1002 1002 x1003 1005'), 'lookup curve maps output→source plate-local frames');
  ok(/filter none/.test(nk) && !/DYNAMIC speed ramp/.test(nk), 'no sticky fallback when map is present');
}

// Gap 2: freeze WITH a map → FrameHold on the (plate-local) held frame.
{
  const job = { ...baseJob, retime: { freeze: { frame: 1010 }, sourceFrameMap: [{ sourceFrame: 1010 }] } };
  const nk = buildNukeScript(job, opts);
  ok(/FrameHold \{[\s\S]*first_frame 1001/.test(nk), 'freeze+map → FrameHold at plate-local first frame');
}

// Gap 3: show LUT → OCIOFileTransform only when colorPlan.applyLook is true.
{
  const luts = [{ type: 'show_lut', path: '/show/luts/show_v3.clf' }];
  const withLook = buildNukeScript({ ...baseJob, colorPlan: { applyLook: true, luts } }, opts);
  ok(/OCIOFileTransform \{[\s\S]*show_v3\.clf/.test(withLook) && withLook.includes('PostFlowX_ShowLook'), 'show LUT emitted when applyLook');

  const noLook = buildNukeScript({ ...baseJob, colorPlan: { applyLook: false, luts } }, opts);
  ok(!noLook.includes('OCIOFileTransform'), 'no show LUT when applyLook is false');
}

// Metadata sticky carries match scores.
{
  const nk = buildNukeScript(baseJob, opts);
  ok(/OCF match: 96%/.test(nk) && /Visual match: 91%/.test(nk), 'metadata sticky includes match scores');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
