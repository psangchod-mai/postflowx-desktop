// Bundle-path Nuke handoff (nuke_handoff.py) — retime + show-LUT wiring.
// Run: node tests-js/nukeHandoff.test.mjs
import { buildNukeHandoffScript } from '../src/scripts/smart/smartExrReportExporter.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

// Gaps 2/3: dynamic ramp → TimeWarp lookup curve; show LUT → OCIOFileTransform.
{
  const jobs = [{
    plateName: 'SHOT_020_PL_v01',
    outputDir: '/out/03_exr/SHOT_020_PL_v01', outputPattern: 'SHOT_020_PL_v01.%04d.exr',
    frameStart: 1001, frameCount: 3,
    colorPlan: { applyLook: true, luts: [{ type: 'show_lut', path: '/show/luts/show_v3.clf' }] },
    reframe: { crop: 'crop=1:1:0:0' },   // baked → no Reformat
    retime: { hasSpeedChange: true, isDynamic: true,
      sourceFrameMap: [{ sourceFrame: 1001 }, { sourceFrame: 1002 }, { sourceFrame: 1005 }] },
  }];
  const py = buildNukeHandoffScript(jobs, [{ shotName: 'SHOT_020' }], {});
  ok(py.includes('OCIOFileTransform') && py.includes('/show/luts/show_v3.clf'), 'show LUT OCIOFileTransform emitted when applyLook');
  ok(py.includes('nuke.createNode("TimeWarp")'), 'dynamic ramp → TimeWarp node');
  ok(py.includes('tw["lookup"].setValueAt(1005, 1003)'), 'lookup maps output→plate-local source frames');
  ok(py.includes('DYNAMIC (frame map)'), 'label reflects wired retime, not "review"');
}

// Gap 2: freeze → FrameHold at the plate-local held frame.
{
  const jobs = [{
    plateName: 'SHOT_030_PL_v01', outputDir: '/out', outputPattern: 'x.%04d.exr',
    frameStart: 1001, frameCount: 5,
    retime: { hasSpeedChange: true, freeze: { frame: 1010 }, sourceFrameMap: [{ sourceFrame: 1010 }] },
  }];
  const py = buildNukeHandoffScript(jobs, [{ shotName: 'SHOT_030' }], {});
  ok(py.includes('nuke.createNode("FrameHold")') && py.includes('fh["first_frame"].setValue(1001)'), 'freeze → FrameHold at plate-local first frame');
}

// Regression: no show LUT / retime nodes for a plain shot.
{
  const jobs = [{ plateName: 'S_v01', outputDir: '/o', outputPattern: 's.%04d.exr', frameStart: 1001, frameCount: 10, retime: {} }];
  const py = buildNukeHandoffScript(jobs, [{ shotName: 'S' }], {});
  ok(!py.includes('OCIOFileTransform') && !py.includes('TimeWarp') && !py.includes('FrameHold'), 'plain shot → no look/retime nodes');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
