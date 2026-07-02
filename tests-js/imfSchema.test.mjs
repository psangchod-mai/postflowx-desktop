// P0-SCHEMA: SMPTE namespace / root / application-version conformance for
// CPL/PKL/ASSETMAP/OPL — pure JS, no Java/libxml2. Run: node tests-js/imfSchema.test.mjs
import { validateSchema, parseXmlDoc, SEV } from '../src/scripts/modules/imf/imf_validator.js';

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
const byCode = (rs, code) => rs.find(r => r.code === code);
const sevOf = (rs, code) => byCode(rs, code)?.sev;

// ── Conformant IMP documents ──────────────────────────────────────────────────
const AM = `<?xml version="1.0"?>
<am:AssetMap xmlns:am="http://www.smpte-ra.org/schemas/429-9/2007/AM">
  <am:Id>urn:uuid:0001</am:Id>
</am:AssetMap>`;

const PKL = `<?xml version="1.0"?>
<pkl:PackingList xmlns:pkl="http://www.smpte-ra.org/schemas/2067-2/2016/PKL">
  <pkl:Id>urn:uuid:0002</pkl:Id>
</pkl:PackingList>`;

const CPL = `<?xml version="1.0"?>
<cpl:CompositionPlaylist xmlns:cpl="http://www.smpte-ra.org/schemas/2067-3/2016"
    xmlns:cc="http://www.smpte-ra.org/schemas/2067-21/2020">
  <cpl:Id>urn:uuid:0003</cpl:Id>
  <cpl:ApplicationIdentification>http://www.smpte-ra.org/schemas/2067-21/2020</cpl:ApplicationIdentification>
</cpl:CompositionPlaylist>`;

const OPL = `<?xml version="1.0"?>
<opl:OutputProfileList xmlns:opl="http://www.smpte-ra.org/schemas/2067-100/2016">
  <opl:Id>urn:uuid:0004</opl:Id>
</opl:OutputProfileList>`;

// ── parseXmlDoc (fallback path in Node — no DOMParser) ──
{
  const r = parseXmlDoc(CPL);
  ok(r.ok && r.rootLocalName === 'CompositionPlaylist', 'parseXmlDoc extracts root local-name (ns-agnostic)');
  ok(!parseXmlDoc('').ok, 'parseXmlDoc rejects empty');
  ok(!parseXmlDoc('<a><b></a>').ok, 'parseXmlDoc rejects unclosed root');
  ok(!parseXmlDoc('<!DOCTYPE x [<!ENTITY e "x">]><Root/>').ok, 'parseXmlDoc rejects DOCTYPE/ENTITY (XXE-shaped)');
  ok(parseXmlDoc('<Root/>').ok, 'parseXmlDoc accepts self-closing root');
}

// ── Conformant package → all PASS, no schema FAIL ──
{
  const r = validateSchema({ assetMap: AM, pkl: PKL, cpl: CPL, opl: OPL });
  ok(sevOf(r, 'SCHEMA-AM-NS') === SEV.PASS, 'SCHEMA-AM-NS PASS for ST 429-9 AssetMap');
  ok(sevOf(r, 'SCHEMA-PKL-NS') === SEV.PASS, 'SCHEMA-PKL-NS PASS for ST 2067-2 PKL');
  ok(sevOf(r, 'SCHEMA-CPL-NS') === SEV.PASS, 'SCHEMA-CPL-NS PASS for ST 2067-3 CPL');
  ok(sevOf(r, 'SCHEMA-OPL-NS') === SEV.PASS, 'SCHEMA-OPL-NS PASS for ST 2067-100 OPL');
  ok(sevOf(r, 'SCHEMA-CPL-APP') === SEV.PASS, 'SCHEMA-CPL-APP PASS — App #2E recognised');
  ok(byCode(r, 'SCHEMA-CPL-APP').msg.includes('2E'), 'App #2E label reported');
  ok(!r.some(x => x.sev === SEV.FAIL), 'conformant IMP → no schema FAIL (no false-fail)');
}

// ── Malformed CPL → SCHEMA-CPL-WF FAIL ──
{
  const r = validateSchema({ assetMap: AM, pkl: PKL, cpl: '<cpl:CompositionPlaylist><cpl:Id>x</cpl:Idx>' });
  ok(sevOf(r, 'SCHEMA-CPL-WF') === SEV.FAIL, 'SCHEMA-CPL-WF FAIL for not-well-formed CPL');
}

// ── Wrong root element → SCHEMA-*-ROOT FAIL ──
{
  const bad = `<pkl:PackingList xmlns:pkl="http://www.smpte-ra.org/schemas/2067-3/2016"><pkl:Id>x</pkl:Id></pkl:PackingList>`;
  const r = validateSchema({ cpl: bad });
  ok(sevOf(r, 'SCHEMA-CPL-ROOT') === SEV.FAIL, 'SCHEMA-CPL-ROOT FAIL when root is not CompositionPlaylist');
  ok(byCode(r, 'SCHEMA-CPL-ROOT').msg.includes('PackingList'), 'ROOT fail cites the offending element');
}

// ── Unrecognised namespace → SCHEMA-*-NS FAIL ──
{
  const bad = `<CompositionPlaylist xmlns="http://example.com/not-smpte"><Id>x</Id></CompositionPlaylist>`;
  const r = validateSchema({ cpl: bad });
  ok(sevOf(r, 'SCHEMA-CPL-NS') === SEV.FAIL, 'SCHEMA-CPL-NS FAIL for non-SMPTE namespace');
}

// ── CPL without app id → SCHEMA-CPL-APP INFO (not FAIL) ──
{
  const noApp = `<cpl:CompositionPlaylist xmlns:cpl="http://www.smpte-ra.org/schemas/2067-3/2016"><cpl:Id>x</cpl:Id></cpl:CompositionPlaylist>`;
  const r = validateSchema({ cpl: noApp });
  ok(sevOf(r, 'SCHEMA-CPL-APP') === SEV.INFO, 'SCHEMA-CPL-APP INFO when no app identification');
}

// ── Single-quoted xmlns is legal XML → must NOT false-FAIL (SCHEMA-NS-SINGLEQUOTE) ──
{
  const sq = `<CompositionPlaylist xmlns='http://www.smpte-ra.org/schemas/2067-3/2016'><Id>x</Id></CompositionPlaylist>`;
  const r = validateSchema({ cpl: sq });
  ok(sevOf(r, 'SCHEMA-CPL-NS') === SEV.PASS, 'single-quoted xmlns → SCHEMA-CPL-NS PASS (no false FAIL)');
  ok(!r.some(x => x.sev === SEV.FAIL), 'single-quoted-namespace CPL → no schema FAIL');
}

// ── App-id detection must NOT match arbitrary content text (SCHEMA-APPID-CONTENT-FALSEMATCH) ──
{
  const promo = `<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016"><ContentTitleText>promo app 2</ContentTitleText></CompositionPlaylist>`;
  const r = validateSchema({ cpl: promo });
  ok(sevOf(r, 'SCHEMA-CPL-APP') === SEV.INFO, 'content text "promo app 2" does NOT false-match an App #2 identification');

  const realApp = `<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016"><ApplicationIdentification>http://www.smpte-ra.org/schemas/2067-20/2016</ApplicationIdentification></CompositionPlaylist>`;
  const r2 = validateSchema({ cpl: realApp });
  ok(sevOf(r2, 'SCHEMA-CPL-APP') === SEV.PASS, 'genuine ApplicationIdentification element → App #2 PASS');
}

// ── Robustness: no rawXml → empty (never throws) ──
{
  ok(Array.isArray(validateSchema(null)) && validateSchema(null).length === 0, 'null rawXml → [] no throw');
  ok(validateSchema({}).length === 0, 'empty rawXml → [] (missing docs handled by structural checks)');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
