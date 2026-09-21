// EXR pull job metadata contract tests.
// Run: node tests-js/exrJobMetadata.test.mjs
import { buildExrJob } from '../src/scripts/smart/smartExrPullPlanner.js';
import { buildFrameMapCSV } from '../src/scripts/features/vfxPull/pullJobModel.js';
import { buildPackagePaths } from '../src/scripts/features/vfxPull/packagePaths.js';

let passed = 0, failed = 0;
function ok(condition, label) {
  if (condition) { passed++; console.log('PASS -', label); }
  else { failed++; console.error('FAIL -', label); }
}

const event = {
  eventNumber: '7',
  _pmShot: 'SH020',
  reel: 'A001',
  clipName: 'A001C007',
  srcIn: '01:00:00:00',
  srcOut: '01:00:10:00',
  recIn: '01:10:00:00',
  recOut: '01:10:10:00',
  fps: 24,
  speedPercent: 50,
  scale: 1.25,
};

const job = buildExrJob({
  event,
  marker: { cameraModel: 'ARRI ALEXA 35', format: 'ARRIRAW' },
  matchResult: { matchedPath: '/ocf/A001C007.ari', confidence: 98, status: 'SAFE' },
  config: {
    outputBasePath: '/tmp/pfx',
    frameStart: 1001,
    handleFrames: 8,
    pullMode: 'ocf_native',
    retime: { mode: 'bake_to_timeline' },
    reframe: { mode: 'baked', targetWidth: 3840, targetHeight: 2160 },
    exr: { bitDepth: 'half', compression: 'zip', channels: 'rgb' },
  },
  projectMeta: {
    timelineName: 'VFX_PULL_TIMELINE',
    timelineResolution: '1920x1080',
    projectName: 'SHOW',
  },
});

ok(job.colorPlan.cameraProfile === 'ARRI LogC4', 'job colorPlan carries inferred ARRI LogC4 profile');
ok(/ALEXA35/.test(job.colorPlan.idtUrn || ''), 'job colorPlan carries resolved IDT URN');
ok(job.renderPlan.bakeSpeed === true, 'renderPlan records speed bake');
ok(job.renderPlan.bakeReframe === true, 'renderPlan records reframe bake');
ok(job.renderPlan.targetResolution === '3840x2160', 'renderPlan carries target resolution');
ok(job.metadata.recIn === event.recIn && job.metadata.recOut === event.recOut, 'metadata carries timeline record range');
ok(job.expectedRenderedFrameCount > job.expectedFrameCount, '50% speed bake doubles rendered frame count');

const csv = buildFrameMapCSV(job);
ok(csv.split('\n').length === job.expectedRenderedFrameCount + 1, 'frame map rows match rendered frame count');

const paths = buildPackagePaths('/tmp/pfx', job.plateName, job.shotId);
ok(paths.amfFile.endsWith(`/amf/${job.plateName}.amf`), 'package paths include AMF sidecar');
ok(paths.fdlFile.endsWith(`/metadata/${job.plateName}.fdl.json`), 'package paths include FDL sidecar');

// ── Freeze count → timeline duration (audit E1) ────────────────────────────
// A freeze holds one source frame for the cut duration; the source span
// collapses, so the rendered count must come from the timeline duration +
// handles, NOT from expectedFrameCount.
const HANDLES = 8;
function freezeJob(extra) {
  return buildExrJob({
    event: {
      eventNumber: '9', _pmShot: 'SH030', reel: 'A001', clipName: 'A001C009',
      // Collapsed source range — a single held frame.
      srcIn: '01:00:00:00', srcOut: '01:00:00:00',
      fps: 24,
      freeze: { frame: 86412 },
      ...extra,
    },
    marker: { cameraModel: 'ARRI ALEXA 35', format: 'ARRIRAW' },
    matchResult: { matchedPath: '/ocf/A001C009.ari', confidence: 98, status: 'SAFE' },
    config: {
      outputBasePath: '/tmp/pfx', frameStart: 1001, handleFrames: HANDLES,
      pullMode: 'ocf_native', retime: { mode: 'bake_to_timeline' },
      exr: { bitDepth: 'half', compression: 'zip', channels: 'rgb' },
    },
    projectMeta: { timelineName: 'T', projectName: 'SHOW' },
  });
}

// 1. durationFrames present → count = duration + 2*handles (NOT the ~17-frame source span).
const fzDur = freezeJob({ durationFrames: 100 });
ok(fzDur.expectedRenderedFrameCount === 100 + 2 * HANDLES,
   'freeze: rendered count = durationFrames(100) + 2*handles(16) = 116');
ok(fzDur.expectedRenderedFrameCount > fzDur.expectedFrameCount,
   'freeze: rendered count exceeds the collapsed source span (the bug it fixes)');
const fzCsv = buildFrameMapCSV(fzDur);
ok(fzCsv.trim().split('\n').length - 1 === 116, 'freeze: frame map has one row per rendered frame');
const fzSrc = fzCsv.trim().split('\n').slice(1).map(l => Number(l.split(',')[3]));
ok(fzSrc.every(v => v === 86412), 'freeze: every rendered frame holds the freeze source frame (86412)');

// 2. No durationFrames → fall back to recOut − recIn.
const fzRec = freezeJob({ recIn: '01:10:00:00', recOut: '01:10:02:00' }); // 48 frames @24
ok(fzRec.expectedRenderedFrameCount === 48 + 2 * HANDLES,
   'freeze: falls back to record span (recOut−recIn = 48) + 2*handles = 64');

// 3. No timeline duration at all → no regression, keeps source-span count.
const fzNone = freezeJob({});
ok(fzNone.expectedRenderedFrameCount === fzNone.expectedFrameCount,
   'freeze: no timeline duration → falls back to expectedFrameCount (no regression)');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
