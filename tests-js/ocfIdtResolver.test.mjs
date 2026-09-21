// OCF → IDT resolver + VFX Pull/ACES Look integration. Run: node tests-js/ocfIdtResolver.test.mjs
// Covers the ocf_vfxpull_aceslook automation prompt (Phases 1-4), adapted to PostFlowX (ESM, src/).
import { resolveIdtFromOCFMeta, resolveIdtFromProbe, listSupportedIdts }
  from '../src/scripts/features/aceslook/services/ocfIdtResolver.js';
import { buildColorPlan } from '../src/scripts/features/vfxPull/colorPlanEngine.js';
import { generateASCFDLv2 } from '../src/scripts/features/vfxPull/fdlGenerator.js';
import { buildAmf } from '../src/scripts/features/aceslook/services/amfBuilder.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

// ── Phase 1: resolver per camera family ──
eq(resolveIdtFromOCFMeta({ colorSpace: 'ARRI LogC3 / AWG3', codec: 'ARRIRAW', cameraType: 'ARRI ALEXA Mini LF' }).colorSpaceLabel,
   'ARRI LogC3 / AWG3', 'ARRI LogC3');
eq(resolveIdtFromOCFMeta({ colorSpace: 'ARRI LogC4 / AWG4', codec: 'ARRIRAW', cameraType: 'ALEXA 35' }).cameraFamily,
   'ARRI', 'ARRI LogC4 family');
eq(resolveIdtFromOCFMeta({ colorSpace: 'REDWideGamutRGB/Log3G10', codec: 'RED R3D', cameraType: 'RED KOMODO' }).cameraFamily,
   'RED', 'RED R3D');
eq(resolveIdtFromOCFMeta({ colorSpace: 'Panasonic V-Log / V-Gamut', codec: 'H.264', cameraType: 'VariCam' }).cameraFamily,
   'Panasonic', 'Panasonic V-Log');
eq(resolveIdtFromOCFMeta({ colorSpace: 'Canon C-Log3', codec: 'H.265', cameraType: 'EOS C70' }).cameraFamily,
   'Canon', 'Canon C-Log3');
eq(resolveIdtFromOCFMeta({ colorSpace: 'Blackmagic Design Film', codec: 'BRAW', cameraType: 'URSA' }).cameraFamily,
   'Blackmagic', 'Blackmagic BRAW');

// defaultAcesIdt URN is trusted first
eq(resolveIdtFromOCFMeta({ colorSpace: 'Sony S-Log3 / S-Gamut3', codec: 'Sony X-OCN', cameraType: 'VENICE 2',
   defaultAcesIdt: 'urn:ampas:aces:transformId:v1.5:IDT.Sony.SLog3_SGamut3Cine.a1.v1' }).cameraFamily,
   'Sony', 'Sony via defaultAcesIdt URN');

// Rec.709 generic + warning
const r709 = resolveIdtFromOCFMeta({ colorSpace: 'Rec.709', codec: 'Apple ProRes', cameraType: '' });
eq(r709.cameraFamily, 'Generic', 'Rec.709 → Generic');
ok(!!r709.warningMsg, 'Rec.709 carries a warning');

// unknown → fallback (Rec.709), not auto-detected, with warning, never throws
const unk = resolveIdtFromOCFMeta({ colorSpace: 'Weird XYZ', codec: 'mystery', cameraType: '' });
eq(unk.isAutoDetected, false, 'unknown → isAutoDetected false');
ok(unk.acesIdtUrn.includes('Rec709'), 'unknown → Rec.709 fallback URN');
ok(!!unk.warningMsg, 'unknown carries a warning');
eq(resolveIdtFromOCFMeta(null).isAutoDetected, false, 'null meta → safe fallback');

// probe adapter (ocf_engine probe → resolution)
eq(resolveIdtFromProbe({ cameraFamily: 'ARRI', format: 'ARRIRAW', colorSpace: 'LogC4' }).cameraFamily, 'ARRI', 'resolveIdtFromProbe ARRI');

// listSupportedIdts
ok(listSupportedIdts().length >= 6, `listSupportedIdts (${listSupportedIdts().length})`);
ok(listSupportedIdts().every(e => e.urn && e.label && e.cameraFamily), 'each supported IDT has urn/label/family');

// ── Phase 2: colorPlanEngine auto-detect from job.ocfMeta ──
const plan = buildColorPlan({ ocfMeta: { colorSpace: 'ARRI LogC3 / AWG3', codec: 'ARRIRAW', cameraType: 'ALEXA Mini LF' } });
eq(plan.idtName, 'ARRI LogC3 / AWG3', 'colorPlan idtName auto from OCF');
eq(plan.idtAutoDetected, true, 'colorPlan idtAutoDetected true');
ok(plan.idtUrn && plan.idtUrn.includes('ARRI'), 'colorPlan idtUrn is ARRI URN');
// user override wins (guardrail)
const planOverride = buildColorPlan({ color: { idtName: 'Manual Pick' }, ocfMeta: { colorSpace: 'ARRI LogC3 / AWG3', codec: 'ARRIRAW' } });
eq(planOverride.idtName, 'Manual Pick', 'user IDT override wins over OCF');
eq(planOverride.idtAutoDetected, false, 'override → autoDetected false');

// ── Phase 3: amfBuilder emits OCF-resolved IDT URN ──
const amf = buildAmf({ source: { name: 'A001C001.mxf' }, clipId: 'A001C001', inputTransform: 'AUTO',
  outputTransform: 'NONE_RECIPE_ONLY', cdlEnabled: false, lookStack: [],
  ocfMeta: { colorSpace: 'Sony S-Log3 / S-Gamut3', codec: 'Sony X-OCN', cameraType: 'VENICE 2' } });
ok(amf.ok, 'AMF builds (AUTO + ocfMeta is valid)');
ok(amf.ok && amf.xml.includes('IDT.Sony.SLog3_SGamut3Cine'), 'AMF inputTransform URN from OCF (Sony)');
ok(amf.ok && /<aces:inputTransform applied="false">/.test(amf.xml), 'AMF inputTransform block present');

// ── Phase 4: ASC FDL v2.0 ──
const fdlStr = generateASCFDLv2({
  label: 'MyShow_EP101', width: 4448, height: 3096,
  shots: [{ clipName: 'A001_C001', reelName: 'A001', width: 4448, height: 3096,
            framingWidth: 3840, framingHeight: 2160, framingOffsetX: 304, framingOffsetY: 468 }],
}, null);
const fdl = JSON.parse(fdlStr);
eq(fdl.version, '2.0', 'FDL version 2.0');
ok(fdl.$schema.includes('ascfdl'), 'FDL $schema references ascfdl.org');
ok(Array.isArray(fdl.canvases), 'FDL canvases is array');
ok(Array.isArray(fdl.framingDecisions), 'FDL framingDecisions is array');
eq(fdl.framingDecisions[0].framing.dimensions.width, 3840, 'FDL framing width 3840');
ok(/^[0-9a-f-]{36}$/i.test(fdl.uuid), 'FDL has a uuid');
ok(generateASCFDLv2({ label: 'X', shots: [{ clipName: 'c' }] },
   { colorSpace: 'ARRI LogC4', codec: 'ARRIRAW' }).includes('ARRI LogC4'), 'FDL label embeds OCF IDT');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
