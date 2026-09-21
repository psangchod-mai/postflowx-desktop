// Phase G — the single most valuable test: state → buildAmf → parseAmf →
// buildAmf is STABLE on transform IDs + look order (no drift across a round-trip).
// Run: node --test test/color/roundtrip.test.mjs
import './_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildAmf } from '../../src/scripts/features/aceslook/services/amfBuilder.js';
import { parseAmf } from '../../src/scripts/features/aceslook/services/amfReader.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const state = (n) => JSON.parse(readFileSync(path.join(HERE, 'fixtures', n), 'utf8'));

// Signature of the colour pipeline that must NOT drift across a round-trip:
// the ordered transform IDs (IDT, looks…, ODT).
function pipelineSignature(parsed) {
  return [
    parsed.inputTransform?.transformId || null,
    ...parsed.lookTransforms.map((l) => l.transformId || l.file || null),
    parsed.outputTransform?.transformId || null,
  ];
}

test('build is idempotent on IDs + look order (build twice → same pipeline)', () => {
  const s = state('look_cdl_sdr.json');
  const a = parseAmf(buildAmf(s).xml);
  const b = parseAmf(buildAmf(s).xml);
  assert.deepEqual(pipelineSignature(a), pipelineSignature(b), 'two builds agree');
});

test('state → buildAmf → parseAmf → buildAmf preserves the pipeline', () => {
  const s = state('look_cdl_sdr.json');
  const firstParse = parseAmf(buildAmf(s).xml);

  // Reconstruct a state from the parsed AMF (map keys back) and re-export.
  const reState = {
    ...s,
    inputTransform: firstParse.inputTransform.key,
    outputTransform: firstParse.outputTransform.key,
    // CDL look round-trips via cdlEnabled (LMT carries no SOP in this builder).
    cdlEnabled: firstParse.lookTransforms.some((l) => l.key === 'LMT_ASC_CDL'),
  };
  const secondParse = parseAmf(buildAmf(reState).xml);

  assert.deepEqual(pipelineSignature(secondParse), pipelineSignature(firstParse), 'no drift after re-import + re-export');
  assert.equal(secondParse.inputTransform.key, 'ARRI_LOGC3');
  assert.equal(secondParse.outputTransform.key, 'SDR_REC709');
  assert.equal(secondParse.lookTransforms[0].key, 'LMT_ASC_CDL', 'CDL look survives the full cycle');
});

test('HDR look-stack pipeline round-trips (LogC4 → CLF ref → Rec.2100 PQ)', () => {
  const s = state('look_hdr_pq.json');
  const p = parseAmf(buildAmf(s).xml);
  assert.equal(p.inputTransform.key, 'ARRI_LOGC4');
  assert.equal(p.outputTransform.key, 'HDR_REC2100_PQ');
  // the CLF file-ref look survives as a <file> look
  assert.ok(p.lookTransforms.some((l) => (l.file || '').includes('show_v3.clf')), 'CLF file-ref look preserved');
});
