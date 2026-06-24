// VFX Pull core builders — speed detection, job assembly, FDL, QC blocks.
// Ported from the legacy tests/js/vfx_pull.test.mjs (which was orphaned from the
// runner after the src/ reorg). Run: node tests-js/vfxPullCore.test.mjs
import { buildAllExrJobs, detectSpeedChange } from '../src/scripts/smart/smartExrPullPlanner.js';
import { buildFDL } from '../src/scripts/features/vfxPull/fdlGenerator.js';
import { computeQcBlocks } from '../src/scripts/features/vfxPull/vfxPullQcReport.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ── buildAllExrJobs: reads handleFrames (not "handles") + surfaces retime ──────
{
  const matchResults = [{
    event: {
      reel: 'A001', clipName: 'A001_C001.mov',
      srcIn: '01:00:00:00', srcOut: '01:00:04:00',
      recIn: '00:00:10:00', recOut: '00:00:14:00',
      fps: 24, durationFrames: 96, speedPercent: 200,
    },
    match: { status: 'SAFE', confidence: 92, matchedPath: '/ocf/A001_C001.mov' },
    ocf: { name: 'A001_C001.mov', path: '/ocf/A001_C001.mov' },
  }];
  const config = {
    handleFrames: 16, frameStart: 1001,
    retime: { mode: 'bake_to_timeline' },
    reframe: { mode: 'match_qt_ref_uhd', targetWidth: 3840, targetHeight: 2160 },
  };
  const [job] = buildAllExrJobs(matchResults, config, {});
  ok(job.handleFrames === 16, 'handleFrames flows through (not "handles")');
  ok(job.frameStart === 1001, 'frameStart flows through');
  ok(job.retime.mode === 'bake_to_timeline', 'retime.mode surfaced');
  ok(job.retime.hasSpeedChange === true && job.retime.speed === 2 && job.retime.speedPercent === 200, '200% speed fields surfaced');
  ok(job.retime.isDynamic === false, 'constant speed is not dynamic');
  ok(job.expectedRenderedFrameCount === Math.round(job.expectedFrameCount / 2), '200% → half the rendered frames');
}

// ── detectSpeedChange ──────────────────────────────────────────────────────────
{
  const r = detectSpeedChange({ speedKeys: [{ tc: '01:00:00:00', speed: 1 }, { tc: '01:00:02:00', speed: 2 }] });
  ok(r.hasSpeedChange && r.isDynamic && r.speedKeys.length === 2, 'dynamic ramp via speedKeys');
}
{
  const r = detectSpeedChange({ speedReversed: true });
  ok(r.hasSpeedChange && r.reversed, 'reverse detected');
}
{
  const r = detectSpeedChange({ speedPercent: 100 });
  ok(r.hasSpeedChange === false && r.isDynamic === false && r.speed === 1, '100% is a no-op');
}
{
  const r = detectSpeedChange({ speed: 200 });
  ok(r.hasSpeedChange && r.speedPercent === 200 && r.speed === 2, 'event.speed > 5 interpreted as percent');
}

// ── buildFDL: referenceInfo writes the UHD reformat block ──────────────────────
{
  const job = {
    shotId: 'SHOT_010', plateName: 'SHOT_010_PL_v01', sourcePath: '/ocf/A001.mov',
    exportIn: '00:59:59:08', exportOut: '01:00:04:08',
    fps: 24, frameStart: 1001, expectedFrameCount: 100,
    color: { mode: 'aces', outputColorSpace: 'ACES2065-1' },
    reframe: { mode: 'match_qt_ref_uhd', scale: 2.0, cropBox: [0, 0, 1920, 1080], fit: 'centerCrop', notes: 'HD → UHD' },
  };
  const fdl = buildFDL({
    job, matchResult: { confidence: 95, status: 'SAFE', warnings: [] },
    referenceInfo: { path: '/ref/master.mov', tcIn: '00:00:10:00', tcOut: '00:00:14:00', width: 3840, height: 2160, reformat: job.reframe },
    amfFileName: 'SHOT_010_PL_v01.amf',
    pullMode: 'IDT_PLUS_MATCH_LOOK',
  });
  ok(fdl.reference.resolution === '3840x2160', 'reference resolution 3840x2160');
  ok(fdl.pull.referenceReformat.scale === 2.0, 'reformat scale carried');
  ok(eq(fdl.pull.referenceReformat.crop, [0, 0, 1920, 1080]), 'reformat crop carried');
  ok(fdl.pull.referenceReformat.fit === 'centerCrop', 'reformat fit carried');
  ok(fdl.color.amf === 'SHOT_010_PL_v01.amf', 'amf filename carried');
}

// ── computeQcBlocks: hard-error block conditions ───────────────────────────────
{
  const blocks = computeQcBlocks({ shots: [], settings: {}, providers: { hasEvents: false, hasReference: true, hasOcfFolder: true } });
  ok(blocks.some(b => b.code === 'NO_TIMELINE_EVENTS' && b.severity === 'error'), 'NO_TIMELINE_EVENTS when no events');
}
{
  const blocks = computeQcBlocks({
    shots: [{ shotName: 'A', status: 'SAFE' }, { shotName: 'B', status: 'MISSING' }],
    settings: { outputFolder: '/out', exportMode: 'aces_plate' },
    providers: { hasEvents: true, hasReference: true, hasOcfFolder: true },
  });
  const blk = blocks.find(b => b.code === 'OCF_MISSING_PER_SHOT');
  ok(blk && eq(blk.shots, ['B']), 'OCF_MISSING_PER_SHOT lists the missing shot');
}
{
  const blocks = computeQcBlocks({
    shots: [{ shotName: 'A', status: 'SAFE', retime: { isDynamic: true } }],
    settings: { outputFolder: '/out', exportMode: 'aces_plate', bakeSpeed: true },
    providers: { hasEvents: true, hasReference: true, hasOcfFolder: true },
  });
  ok(blocks.some(b => b.code === 'DYNAMIC_RETIME_UNSUPPORTED' && b.severity === 'error'), 'DYNAMIC_RETIME_UNSUPPORTED on bakeSpeed + dynamic');
}
{
  const blocks = computeQcBlocks({
    shots: [{ shotName: 'A', status: 'SAFE' }],
    settings: { outputFolder: '/out', exportMode: 'aces_plate' },
    providers: { hasEvents: true, hasReference: true, hasOcfFolder: true },
  });
  ok(blocks.filter(b => b.severity === 'error').length === 0, 'silent (no errors) when everything is fine');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
