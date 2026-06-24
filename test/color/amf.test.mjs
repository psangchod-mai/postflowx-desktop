// Phase B — AMF v2.0 writer correctness + reader + round-trip.
// Run: node --test test/color/amf.test.mjs
import './_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildAmf } from '../../src/scripts/features/aceslook/services/amfBuilder.js';
import { parseAmf } from '../../src/scripts/features/aceslook/services/amfReader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => readFileSync(path.join(HERE, 'fixtures', n), 'utf8');
const state = (n) => JSON.parse(fx(n));

test('writer: systemVersion reflects ACES 2.0 (2/0/0), not hardcoded 1/0/0', () => {
  const res = buildAmf(state('look_cdl_sdr.json'));
  assert.ok(res.ok, `build ok: ${res.errors}`);
  assert.match(res.xml, /<aces:majorVersion>2<\/aces:majorVersion>/, 'major 2');
  assert.match(res.xml, /<aces:minorVersion>0<\/aces:minorVersion>/, 'minor 0');
  assert.ok(!/<aces:majorVersion>1<\/aces:majorVersion>/.test(res.xml), 'not 1.x');
});

test('writer: CDL LMT id sourced from manifest (not a literal), look applied=false', () => {
  const res = buildAmf(state('look_cdl_sdr.json'));
  assert.match(res.xml, /LMT\.Academy\.ASC_CDL/, 'ASC_CDL LMT present');
  assert.match(res.xml, /<aces:lookTransform applied="false">/, 'applied=false preserved');
});

test('reader: parses a known-good AMF v2.0 + reverse-maps IDs to registry keys', () => {
  const r = parseAmf(fx('goodknown_amf_v2.xml'));
  assert.equal(r.ok, true);
  assert.equal(r.acesVersion, '2.0');
  assert.equal(r.clipId, 'A001C001');
  assert.equal(r.inputTransform.key, 'ARRI_LOGC3', 'IDT id → key');
  assert.equal(r.outputTransform.key, 'SDR_REC709', 'ODT id → key');
  assert.equal(r.lookTransforms.length, 1);
  assert.equal(r.lookTransforms[0].key, 'LMT_ASC_CDL', 'CDL LMT id → key');
  assert.equal(r.inputTransform.applied, false, 'applied flag parsed');
  // inline ASC-CDL extracted
  assert.deepEqual(r.cdl.slope, [1.02, 1.0, 0.98]);
  assert.equal(r.cdl.saturation, 1.05);
});

test('reader: tolerates missing optional blocks without throwing', () => {
  const minimal = `<?xml version="1.0"?><aces:acesMetadataFile version="2.0" xmlns:aces="urn:ampas:aces:amf:v2.0"><aces:pipeline><aces:inputTransform applied="true"><aces:transformId>urn:ampas:aces:transformId:v2.0:IDT.ARRI.Alexa35-logC4.a1.v1</aces:transformId></aces:inputTransform></aces:pipeline></aces:acesMetadataFile>`;
  const r = parseAmf(minimal);
  assert.equal(r.ok, true);
  assert.equal(r.outputTransform, null, 'no ODT → null, no throw');
  assert.equal(r.inputTransform.key, 'ARRI_LOGC4');
  assert.equal(r.inputTransform.applied, true);
});

test('reader: non-AMF input fails soft (ok:false + warning, no throw)', () => {
  const r = parseAmf('<foo/>');
  assert.equal(r.ok, false);
  assert.ok(r.warnings.length > 0);
});

test('ROUND-TRIP: build → parse recovers IDT/ODT keys + look order', () => {
  const res1 = buildAmf(state('look_cdl_sdr.json'));
  const parsed = parseAmf(res1.xml);
  assert.equal(parsed.inputTransform.key, 'ARRI_LOGC3');
  assert.equal(parsed.outputTransform.key, 'SDR_REC709');
  assert.equal(parsed.lookTransforms[0].key, 'LMT_ASC_CDL', 'CDL look survives round-trip');
});
