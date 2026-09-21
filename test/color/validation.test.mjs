// Phase D — ACES 2.0-aware validation. Run: node --test test/color/validation.test.mjs
import './_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../../src/scripts/features/aceslook/state/acesLookValidation.js';

const base = (over = {}) => ({
  source: 'a.mov', sourceClass: 'arri_logc3', mode: 'sdr_delivery', acesVersion: '2.0',
  inputTransform: 'ARRI_LOGC3', outputTransform: 'SDR_REC709', clipId: 'C1',
  cdlEnabled: false, cdl: { slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1], sat: 1 },
  lookStack: [], ...over,
});
const hasWarn = (r, re) => r.warnings.some((w) => re.test(w));
const hasErr = (r, re) => r.errors.some((e) => re.test(e));

test('no regression: a clean SDR state has no errors/warnings', () => {
  const r = validate(base());
  assert.equal(r.errors.length, 0, `errors: ${r.errors}`);
  assert.equal(r.warnings.length, 0, `warnings: ${r.warnings}`);
});

test('RGC + ACES 2.0 ODT → warning; off → silent', () => {
  assert.ok(hasWarn(validate(base({ rgcEnabled: true })), /Reference Gamut Compression/), 'fires');
  assert.ok(!hasWarn(validate(base({ rgcEnabled: false })), /Reference Gamut Compression/), 'silent without RGC');
});

test('legacy ACES 1.x look fix in a 2.0 pipeline → warning', () => {
  const r = validate(base({ lookStack: [{ enabled: true, label: 'Blue fix', transformId: 'urn:ampas:aces:transformId:v1.1:LMT.Academy.BlueLightArtifact.a1.v1' }] }));
  assert.ok(hasWarn(r, /legacy ACES 1\.x/), 'fires on legacy LMT');
  const clean = validate(base({ lookStack: [{ enabled: true, label: 'Show LUT', file: '/luts/x.clf' }] }));
  assert.ok(!hasWarn(clean, /legacy ACES 1\.x/), 'silent for a normal file look');
});

test('version coherence: 2.0-only transform used at 1.3 → warning', () => {
  const r = validate(base({ acesVersion: '1.3', outputTransform: 'HDR_P3D65_PQ2000' }));
  assert.ok(hasWarn(r, /no ACES 1\.3 transform ID/), 'flags the 2.0-only target at 1.3');
  // a transform present at both versions stays silent
  assert.ok(!hasWarn(validate(base({ acesVersion: '1.3', outputTransform: 'SDR_REC709' })), /no ACES 1\.3 transform ID/));
});

test('parametric custom display: bad params are hard errors', () => {
  assert.ok(hasErr(validate(base({ outputTransform: 'CUSTOM_DISPLAY', customDisplay: { peak_nits: 0, eotf: 'PQ' } })), /peak_nits/), 'peak_nits ≤ 0 errors');
  assert.ok(hasErr(validate(base({ outputTransform: 'CUSTOM_DISPLAY', customDisplay: { peak_nits: 1000, eotf: 'nope' } })), /EOTF/), 'bad eotf errors');
  const good = validate(base({ outputTransform: 'CUSTOM_DISPLAY', customDisplay: { peak_nits: 1000, limiting_primaries: 'P3-D65', eotf: 'PQ' } }));
  assert.ok(!hasErr(good, /Custom display/), 'valid params → no display error');
});
