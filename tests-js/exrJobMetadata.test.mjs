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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
