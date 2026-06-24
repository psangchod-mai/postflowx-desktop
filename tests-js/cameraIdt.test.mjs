// Camera profile → IDT inference regression tests.
// Run: node tests-js/cameraIdt.test.mjs
import { resolveIdtUrn, buildVfxPullAmf } from '../src/scripts/features/vfxPull/amfVfxPullGenerator.js';
import { inferCameraProfile, buildColorPlan } from '../src/scripts/features/vfxPull/colorPlanEngine.js';

globalThis.crypto ||= {
  getRandomValues(bytes) {
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37 + 11) & 0xff;
    return bytes;
  },
};

let passed = 0, failed = 0;
function ok(condition, label) {
  if (condition) { passed++; console.log('PASS -', label); }
  else { failed++; console.error('FAIL -', label); }
}

const arri35 = inferCameraProfile({ metadata: { cameraModel: 'ARRI ALEXA 35 LogC4' }, sourcePath: '/ocf/A001C001.ari' });
ok(arri35.cameraProfile === 'ARRI LogC4', 'ARRI ALEXA 35 maps to LogC4');
ok(/ALEXA35/.test(arri35.idtUrn || ''), 'ARRI LogC4 resolves ALEXA35 IDT URN');

const red = inferCameraProfile({ sourcePath: '/ocf/R001_C001_0612AB.R3D', metadata: { codec: 'REDCODE RAW IPP2 Log3G10' } });
ok(red.cameraProfile === 'RED IPP2 Log3G10', 'RED IPP2 Log3G10 detected from R3D metadata');
ok(/RED/.test(resolveIdtUrn(red.cameraProfile) || ''), 'RED profile resolves RED IDT URN');

const sonyPlan = buildColorPlan({
  sourcePath: '/ocf/A001C005.mxf',
  metadata: { cameraModel: 'Sony VENICE 2 S-Gamut3.Cine S-Log3', codec: 'XOCN' },
}, 'ocf_native');
ok(sonyPlan.applyIDT === true, 'OCF native Sony plan applies IDT');
ok(sonyPlan.cameraProfile === 'Sony S-Gamut3.Cine/S-Log3', 'Sony profile propagated into color plan');

const amf = buildVfxPullAmf({
  clipName: 'A001C005.mxf',
  shotName: 'SH010',
  filePath: '/ocf/A001C005.mxf',
  tcIn: '01:00:00:00',
  tcOut: '01:00:10:00',
  cameraProfile: 'Canon C-Log2/C-Gamut',
  mode: 'ocf_native',
});
ok(amf.ok && /IDT\.Canon\.CanonLog2_CGamut/.test(amf.xml), 'AMF emits Canon C-Log2 IDT');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
