// Phase A — config-driven ACES transform registry.
// Run: node --test test/color/registry.test.mjs
import './_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REGISTRY, resolveInputTransform, resolveOutputTransform, listOutputTransforms,
  keyForTransformId, ACES_DEFAULT_VERSION,
} from '../../src/scripts/features/aceslook/services/transformRegistry.js';

test('defaults to ACES 2.0', () => {
  assert.equal(ACES_DEFAULT_VERSION, '2.0');
});

test('resolves version-correct IDs (2.0 default vs 1.3)', () => {
  const v20 = resolveOutputTransform('SDR_REC709');
  const v13 = resolveOutputTransform('SDR_REC709', { acesVersion: '1.3' });
  assert.match(v20.transformId, /:v2\.0:ODT\.Academy\.Rec709_100nits_dim/, '2.0 ID');
  assert.match(v13.transformId, /:v1\.0:ODT\.Academy\.Rec709_100nits_dim\.a1\.0\.3/, '1.3 ID differs');
  assert.notEqual(v20.transformId, v13.transformId, 'version switch changes the ID');
});

test('input transform resolves + marks AUTO/CUSTOM unresolved', () => {
  const arri = resolveInputTransform('ARRI_LOGC3');
  assert.match(arri.transformId, /:v2\.0:IDT\.ARRI/, 'ARRI LogC3 2.0 ID');
  assert.equal(arri.resolved, true);
  assert.equal(resolveInputTransform('AUTO').resolved, false, 'AUTO not resolved');
  assert.equal(resolveInputTransform('CUSTOM_FILE').resolved, false);
});

test('unknown key returns null (no throw)', () => {
  assert.equal(resolveInputTransform('NOPE'), null);
  assert.equal(resolveOutputTransform('NOPE'), null);
});

test('NONE_RECIPE_ONLY output → null (omitted in AMF)', () => {
  assert.equal(resolveOutputTransform('NONE_RECIPE_ONLY'), null);
});

test('1.3 ID null where not in manifest → null transformId, no guess', () => {
  // LogC4 postdates ACES 1.x; aces1_3_id is null.
  assert.equal(resolveInputTransform('ARRI_LOGC4', { acesVersion: '1.3' }).transformId, null);
  // …but 2.0 resolves.
  assert.ok(resolveInputTransform('ARRI_LOGC4').transformId);
});

test('listOutputTransforms includes new 2.0 targets, excludes recipe-only', () => {
  const keys = listOutputTransforms('2.0').map((t) => t.key);
  for (const k of ['SDR_REC709', 'HDR_REC2100_PQ', 'HDR_P3D65_PQ1000', 'HDR_P3D65_PQ2000', 'HDR_P3D65_PQ4000', 'CUSTOM_DISPLAY']) {
    assert.ok(keys.includes(k), `dropdown includes ${k}`);
  }
  assert.ok(!keys.includes('NONE_RECIPE_ONLY'), 'recipe-only excluded from dropdown');
});

test('parametric custom display carries params + amfApplicable', () => {
  const cd = resolveOutputTransform('CUSTOM_DISPLAY');
  assert.equal(cd.parametric, true);
  assert.ok(cd.params && cd.params.peak_nits > 0 && cd.params.eotf, 'has peak_nits + eotf');
  assert.equal(cd.amfApplicable, true);
});

test('reverse lookup: transformId → key', () => {
  const id = resolveOutputTransform('SDR_REC709').transformId;
  assert.equal(keyForTransformId(id), 'SDR_REC709');
  assert.equal(keyForTransformId('urn:bogus'), null);
});

test('back-compat REGISTRY shape preserved for the cards', () => {
  assert.ok(REGISTRY.inputTransforms.ARRI_LOGC3, 'inputTransforms keyed by KEY');
  assert.ok(REGISTRY.outputTransforms.SDR_REC709, 'outputTransforms keyed by KEY');
  assert.ok(REGISTRY.inputTransforms.ARRI_LOGC3.label && 'transformId' in REGISTRY.inputTransforms.ARRI_LOGC3);
  // LMTs kept OUT of the IDT/ODT dropdown groups.
  assert.equal(REGISTRY.inputTransforms.LMT_ASC_CDL, undefined);
  assert.ok(REGISTRY.lookTransforms.LMT_ASC_CDL, 'LMTs under lookTransforms');
});
