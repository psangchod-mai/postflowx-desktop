// REMEDIATION (round 1): integration/wiring coverage. The tester found that
// validateTimeline / validateOPL / validateTTML were standalone exports never
// reached by the running QC flow. They are now COMPOSED into the two entry points
// the renderer already calls:
//   validateStructure(assetMap, pkl, cpl, fileMap) -> runs validateTimeline(cpl)
//   validateSchema({ ..., opl?, timedText? })      -> runs validateOPL/validateTTML
// These tests assert the composition actually fires (by code prefix), that it does
// NOT fire / crash when the relevant inputs are absent, and that a malformed
// sidecar cannot crash the composing pass.
//
// Run: node tests-js/imfWiring.test.mjs
import {
  validateStructure, validateSchema, SEV,
} from '../src/scripts/modules/imf/imf_validator.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
const has = (rs, prefix) => rs.some(r => typeof r.code === 'string' && r.code.startsWith(prefix));

// ── Minimal parsed-package fixtures (shape validateStructure consumes) ──────────
const emptyAssetMap = { assets: {} };
const emptyPkl = { assets: {} };

function cplWithTimeline() {
  // Two virtual tracks that DO NOT span the same composition duration -> TL004 FAIL.
  return {
    id: 'urn:uuid:cpl-1',
    editRate: 24,
    totalFrames: 240,
    videoResources: [{ trackFileId: 'v1', essenceDescriptorId: 'd1', entryPoint: 0, sourceDuration: 240, intrinsicDuration: 240, editRate: 24 }],
    audioResources: [{ trackFileId: 'a1', essenceDescriptorId: 'd2', entryPoint: 0, sourceDuration: 120, intrinsicDuration: 120, editRate: 24 }],
    videoSequences: [{ trackId: 'V', seqType: 'MainImage', resources: [{ trackFileId: 'v1', entryPoint: 0, sourceDuration: 240, intrinsicDuration: 240, editRate: 24 }] }],
    audioSequences: [{ trackId: 'A', seqType: 'MainAudio', resources: [{ trackFileId: 'a1', entryPoint: 0, sourceDuration: 120, intrinsicDuration: 120, editRate: 24 }] }],
    descriptors: [],
  };
}

// ── 1) validateStructure composes validateTimeline ──────────────────────────────
{
  const cpl = cplWithTimeline();
  const rs = validateStructure(emptyAssetMap, emptyPkl, cpl, new Map());
  ok(Array.isArray(rs), 'validateStructure returns an array');
  ok(has(rs, 'TL'), 'validateStructure now emits TL* timeline findings (validateTimeline is wired)');
  const tl004 = rs.find(r => r.code === 'TL004');
  ok(tl004 && tl004.sev === SEV.FAIL, 'TL004 FAIL fires for mismatched track durations through validateStructure');
}

// ── 2) validateStructure stays quiet + never throws when there is no timeline ────
{
  const cpl = { id: 'urn:uuid:x', editRate: 24, videoResources: [], audioResources: [], videoSequences: [], audioSequences: [], descriptors: [] };
  let threw = false, rs = [];
  try { rs = validateStructure(emptyAssetMap, emptyPkl, cpl, new Map()); } catch { threw = true; }
  ok(!threw, 'validateStructure does not throw on an empty CPL');
  ok(!has(rs, 'TL'), 'no TL* findings when the CPL carries no timeline resources (no false findings)');
}

// ── 3) validateSchema composes validateOPL (semantic macro/handle pass) ──────────
{
  const CPL = `<?xml version="1.0"?>
<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016"><Id>urn:uuid:cpl-9</Id></CompositionPlaylist>`;
  // OPL references a DIFFERENT CPL id -> OPL002 FAIL, and its input handle is dangling -> OPL004 FAIL.
  const OPL = `<?xml version="1.0"?>
<OutputProfileList xmlns="http://www.smpte-ra.org/schemas/2067-100/2016">
  <Id>urn:uuid:opl-1</Id>
  <CompositionPlaylistId>urn:uuid:some-other-cpl</CompositionPlaylistId>
  <MacroList>
    <Macro name="m0"><InputList><Handle>undefinedHandle</Handle></InputList></Macro>
  </MacroList>
</OutputProfileList>`;
  const rs = validateSchema({ assetMap: '', pkl: '', cpl: CPL, opl: OPL });
  ok(has(rs, 'OPL'), 'validateSchema now emits OPL* semantic findings (validateOPL is wired)');
  const opl002 = rs.find(r => r.code === 'OPL002');
  ok(opl002 && opl002.sev === SEV.FAIL, 'OPL002 FAIL fires (OPL->CPL id resolved against loaded CPL) through validateSchema');
  const opl004 = rs.find(r => r.code === 'OPL004');
  ok(opl004 && opl004.sev === SEV.FAIL, 'OPL004 FAIL fires for a dangling macro input handle through validateSchema');
}

// ── 4) validateSchema composes validateTTML (single string + array forms) ────────
{
  const CPL = `<?xml version="1.0"?>
<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016"><Id>urn:uuid:cpl-9</Id></CompositionPlaylist>`;
  const badTtml = `<?xml version="1.0"?>
<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p region="ghost">hi</p></div></body></tt>`; // missing xml:lang + dangling region

  const rsStr = validateSchema({ cpl: CPL, timedText: badTtml });
  ok(has(rsStr, 'TT'), 'validateSchema emits TT* findings for a single timedText string (validateTTML wired)');
  ok(rsStr.some(r => r.code === 'TT002' && r.sev === SEV.FAIL), 'TT002 FAIL fires (missing xml:lang) through validateSchema');
  ok(rsStr.some(r => r.code === 'TT004' && r.sev === SEV.FAIL), 'TT004 FAIL fires (dangling region) through validateSchema');

  const rsArr = validateSchema({ cpl: CPL, ttml: [{ file: 'sub_en.ttml', xml: badTtml }, badTtml] });
  ok(has(rsArr, 'TT'), 'validateSchema emits TT* findings for an array of timed-text docs');
  ok(rsArr.some(r => r.resourceRef && r.resourceRef.file === 'sub_en.ttml'), 'per-file label carried through for { file, xml } array entries');
}

// ── 5) absent OPL/TTML -> no OPL*/TT* findings, no throw (backward compatible) ────
{
  const CPL = `<?xml version="1.0"?>
<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016"><Id>urn:uuid:cpl-9</Id></CompositionPlaylist>`;
  const rs = validateSchema({ assetMap: '', pkl: '', cpl: CPL });
  ok(!has(rs, 'OPL'), 'no OPL* findings when rawXml carries no opl (backward compatible)');
  ok(!has(rs, 'TT'), 'no TT* findings when rawXml carries no timed text (backward compatible)');
}

// ── 6) malformed sidecars cannot crash the composing passes ──────────────────────
{
  let threw = false, rs = [];
  try {
    rs = validateSchema({
      cpl: '<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016"><Id>urn:uuid:cpl-9</Id></CompositionPlaylist>',
      opl: '<<< not xml >>>',
      timedText: [null, 123, {}, { xml: '<<< also not xml' }],
    });
  } catch { threw = true; }
  ok(!threw, 'validateSchema never throws on malformed OPL / garbage timed-text entries');
  ok(Array.isArray(rs), 'validateSchema still returns an array with malformed sidecars');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
