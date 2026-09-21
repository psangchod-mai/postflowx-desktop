// Smart VFX Pull Setup modal → pull config wiring.
// Regression guard: EXR bit depth / compression and the project colorspace the
// user picks in the modal must actually drive the planned jobs. They used to be
// hard-coded (16-bit half / ZIP / ACES2065-1) regardless of the modal.
// Run: node tests-js/vfxPullSettingsWiring.test.mjs
import { buildAllExrJobs } from '../src/scripts/smart/smartExrPullPlanner.js';

let passed = 0, failed = 0;
function eq(got, want, l) {
  if (got === want) { passed++; console.log('PASS -', `${l} (got ${JSON.stringify(got)})`); }
  else { failed++; console.error('FAIL -', `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }
}

const matches = [{
  shotName: 'DLS_101_020_COMP', clipName: 'A001',
  matchedPath: '/x/A001.exr',
  event: { reel: 'A001', clipName: 'A001' },
  match: { matchedPath: '/x/A001.exr' },
  ocf: {},
}];

// 1) Non-default EXR settings flow through to the job.
const proxy = buildAllExrJobs(matches, {
  pullMode: 'review_proxy',
  exr:   { bitDepth: 'float', compression: 'piz', channels: 'rgb' },
  color: { mode: 'aces', outputColorSpace: 'Rec.709' },
}, {})[0];
eq(proxy.exr?.bitDepth, 'float', 'EXR bit depth honored');
eq(proxy.exr?.compression, 'piz', 'EXR compression honored');

// 2) Project colorspace selects the review-proxy ACES 2.0 ODT.
eq(proxy.colorPlan?.odtId, 'rec709_sdr', 'Rec.709 colorspace → rec709_sdr ODT');

const proxyP3 = buildAllExrJobs(matches, {
  pullMode: 'review_proxy',
  exr: { bitDepth: 'half', compression: 'zip' },
  color: { outputColorSpace: 'P3-D65' },
}, {})[0];
eq(proxyP3.colorPlan?.odtId, 'p3d65_sdr', 'P3-D65 colorspace → p3d65_sdr ODT');

// 3) Defaults still produce a Netflix-spec plate.
const plate = buildAllExrJobs(matches, {
  pullMode: 'ocf_native',
  exr: { bitDepth: 'half', compression: 'zip' },
  color: { outputColorSpace: 'ACES2065-1' },
}, {})[0];
eq(plate.exr?.bitDepth, 'half', 'default plate bit depth half');
eq(plate.exr?.compression, 'zip', 'default plate compression zip');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
