// IMF structure validation rules. Run: node tests-js/imfValidator.test.mjs
import { validateStructure, SEV } from '../src/scripts/modules/imf/imf_validator.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
const byCode = (results, code) => results.find(r => r.code === code);
const sevOf = (results, code) => byCode(results, code)?.sev;

// Build a valid IMP structure (parsed-object shapes the validator consumes).
function makeValid() {
  const assetMap = { assets: {
    'pkl-1': { id: 'pkl-1', isPKL: true, path: 'PKL_1.xml' },
    'cpl-1': { id: 'cpl-1', path: 'CPL_1.xml' },
    'file-v': { id: 'file-v', path: 'media/video.mxf' },
    'file-a': { id: 'file-a', path: 'media/audio.mxf' },
  } };
  const pkl = { id: 'pkl-1', assets: {
    'cpl-1':  { type: 'text/xml',        file: 'CPL_1.xml' },
    'file-v': { type: 'application/mxf',  file: 'media/video.mxf' },
    'file-a': { type: 'application/mxf',  file: 'media/audio.mxf' },
  } };
  const cpl = {
    id: 'cpl-1', editRate: 24, resolution: { w: 1920, h: 1080 },
    videoResources: [{ trackFileId: 'file-v', editRate: 24 }],
    audioResources: [{ trackFileId: 'file-a', editRate: 24 }],
    videoSequences: [{ seqType: 'MainImageSequence', trackId: 't-v', resources: [{ trackFileId: 'file-v' }] }],
    audioSequences: [{ seqType: 'MainAudioSequence', trackId: 't-a', resources: [{ trackFileId: 'file-a' }] }],
    descriptors: [],
  };
  const fileMap = new Map([
    ['media/video.mxf', {}], ['media/audio.mxf', {}], ['file-v', {}], ['file-a', {}],
  ]);
  return { assetMap, pkl, cpl, fileMap };
}

// ── Valid package: the cross-reference rules PASS (no false failures) ──
{
  const { assetMap, pkl, cpl, fileMap } = makeValid();
  const r = validateStructure(assetMap, pkl, cpl, fileMap);
  ok(sevOf(r, 'AM001') === SEV.PASS, 'AM001 PASS — ASSETMAP references a PKL');
  ok(sevOf(r, 'PKL001') === SEV.PASS, 'PKL001 PASS — CPL listed in PKL');
  ok(sevOf(r, 'PKL002') === SEV.PASS, 'PKL002 PASS — all essence files present');
  ok(sevOf(r, 'CPL009') === SEV.PASS, 'CPL009 PASS — single picture essence per image sequence');
  ok(sevOf(r, 'AUD002') === SEV.PASS, 'AUD002 PASS — single-essence audio sequence');
}

// ── No PKL in ASSETMAP → AM001 FAIL ──
{
  const v = makeValid();
  delete v.assetMap.assets['pkl-1'].isPKL;
  const r = validateStructure(v.assetMap, v.pkl, v.cpl, v.fileMap);
  ok(sevOf(r, 'AM001') === SEV.FAIL, 'AM001 FAIL when no PKL entry in ASSETMAP');
}

// ── CPL not listed in PKL → PKL001 FAIL ──
{
  const v = makeValid();
  delete v.pkl.assets['cpl-1'];
  const r = validateStructure(v.assetMap, v.pkl, v.cpl, v.fileMap);
  ok(sevOf(r, 'PKL001') === SEV.FAIL, 'PKL001 FAIL when CPL not in PKL');
}

// ── Missing essence file on disk → PKL002 FAIL ──
{
  const v = makeValid();
  v.fileMap = new Map(); // nothing present
  const r = validateStructure(v.assetMap, v.pkl, v.cpl, v.fileMap);
  ok(sevOf(r, 'PKL002') === SEV.FAIL, 'PKL002 FAIL when essence files are missing');
}

// ── Image sequence referencing 2 picture essences → CPL009 WARN (the rule whose
//    DATA the round-37 per-sequence fix protects) ──
{
  const v = makeValid();
  v.cpl.videoSequences[0].resources = [{ trackFileId: 'file-v' }, { trackFileId: 'file-v2' }];
  const r = validateStructure(v.assetMap, v.pkl, v.cpl, v.fileMap);
  ok(sevOf(r, 'CPL009') === SEV.WARN, 'CPL009 WARN when an image sequence references multiple essences');
}

// ── Robustness: empty/garbage structures don't throw ──
{
  const r = validateStructure({ assets: {} }, { id: '', assets: {} }, { id: '' }, new Map());
  ok(Array.isArray(r) && r.length > 0, 'empty structures → results array, no throw');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
