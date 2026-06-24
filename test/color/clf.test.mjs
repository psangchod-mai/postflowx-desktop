// Phase C — real CLF v3 writer. Run: node --test test/color/clf.test.mjs
import './_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildClf } from '../../src/scripts/features/aceslook/services/exportService.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const state = (n) => JSON.parse(readFileSync(path.join(HERE, 'fixtures', n), 'utf8'));

test('CLF v3 header is correct + well-formed XML', () => {
  const r = buildClf(state('look_cdl_sdr.json'));
  assert.ok(r.ok, `build ok: ${r.errors}`);
  assert.match(r.xml, /xmlns="urn:AMPAS:CLF:v3\.0"/, 'CLF v3 namespace');
  assert.match(r.xml, /compCLFversion="3"/, 'compCLFversion 3');
  assert.ok(!r.xml.includes('Add your ProcessNode'), 'no skeleton placeholder');
  // well-formed
  const doc = new DOMParser().parseFromString(r.xml, 'application/xml');
  assert.equal((doc.documentElement.localName || doc.documentElement.tagName), 'ProcessList');
});

test('CDL → exact ASC_CDL ProcessNode (lossless)', () => {
  const r = buildClf(state('look_cdl_sdr.json'));
  assert.match(r.xml, /<ASC_CDL[^>]*style="v1\.2_Rev1_SOP_SAT"/, 'ASC_CDL node with style');
  assert.match(r.xml, /<Slope>1\.020000 1\.000000 0\.980000<\/Slope>/, 'exact slope');
  assert.match(r.xml, /<Offset>0\.000000 0\.000000 0\.010000<\/Offset>/, 'exact offset');
  assert.match(r.xml, /<Saturation>1\.050000<\/Saturation>/, 'exact saturation');
});

test('ACES Output Transform is documented + omitted-with-warning, never baked', () => {
  const r = buildClf(state('look_cdl_sdr.json'));
  // ODT id appears only as an Info Comment, not as a baked LUT node.
  assert.match(r.xml, /<Comment>Output transform[^<]*ODT\.Academy\.Rec709/, 'ODT documented in Info');
  assert.ok(!/LUT3D|LUT1D/.test(r.xml), 'no baked LUT for the ODT');
  assert.ok(r.warnings.some((w) => /non-invertible/.test(w)), 'warns the OT is not baked');
});

test('file-reference look → <Reference path>', () => {
  const r = buildClf(state('look_hdr_pq.json'));
  assert.match(r.xml, /<Reference[^>]*path="\/luts\/show_v3\.clf"/, 'CLF Reference to the LUT file');
});

test('IDT documented in Info', () => {
  const r = buildClf(state('look_cdl_sdr.json'));
  assert.match(r.xml, /<Comment>Input transform[^<]*IDT\.ARRI/, 'IDT documented in Info');
});
