// buildPackagePaths() sidecar-filename collision regression (Iteration 79).
//
// pullReportFile was defined identically to manifestFile (both
// `${root}/metadata/${plateName}_manifest.json`) — a copy-paste mistake.
// Both are written for the same plate in the same VFX Pull export run
// (_runExrExport -> nativeWritePullSidecars writes pullReportFile, then
// _buildVfxPackageFiles writes manifestFile), so the collision meant every
// export silently clobbered the Python-written pull report (retime/geometry/
// colorPlan/QC data) with the JS-written naming manifest.
// Run: node tests-js/packagePaths_sidecarCollision.test.mjs
import { buildPackagePaths } from '../src/scripts/features/vfxPull/packagePaths.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

const pkg = buildPackagePaths('/out', 'SHOT_010_PL01_v001');

ok(pkg.manifestFile !== pkg.pullReportFile,
  `manifestFile and pullReportFile must be distinct paths (both were ${pkg.manifestFile})`);
ok(pkg.pullReportFile === '/out/SHOT_010/metadata/SHOT_010_PL01_v001_pull_report.json',
  `pullReportFile has its own suffix (got ${pkg.pullReportFile})`);
ok(pkg.manifestFile === '/out/SHOT_010/metadata/SHOT_010_PL01_v001_manifest.json',
  `manifestFile unchanged (got ${pkg.manifestFile})`);

// No two sidecar keys in the returned object should ever resolve to the same path.
const sidecarKeys = [
  'amfFile', 'fdlFile', 'manifestFile', 'frameMapFile', 'frameMapJsonFile',
  'geometryFile', 'resizeFile', 'colorFile', 'pullReportFile', 'qcFile', 'qcJsonFile',
];
const seen = new Map();
let dupeFound = false;
for (const key of sidecarKeys) {
  const p = pkg[key];
  if (seen.has(p) && seen.get(p) !== 'resizeFile/geometryFile-known-alias') {
    // geometryFile/resizeFile are an intentional documented alias pair; skip that one.
    if (!((key === 'resizeFile' && seen.get(p) === 'geometryFile') ||
          (key === 'geometryFile' && seen.get(p) === 'resizeFile'))) {
      dupeFound = true;
      console.error(`FAIL - unexpected path collision between ${seen.get(p)} and ${key}: ${p}`);
    }
  }
  seen.set(p, key);
}
ok(!dupeFound, 'no unexpected sidecar path collisions among non-alias keys');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
