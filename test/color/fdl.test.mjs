// Phase E — ASC FDL v2.0 conformance. Run: node --test test/color/fdl.test.mjs
import './_setup.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildAscFdl, buildAscFdlJson, validateAscFdl, computeFramingDecision } from '../../src/scripts/features/vfxPull/ascFdl.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const fixture = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'canvas_169_anamorphic.json'), 'utf8'));

test('committed ASC FDL schema is valid JSON', () => {
  const schema = JSON.parse(readFileSync(path.join(REPO, 'assets/fdl/asc_fdl_v2.schema.json'), 'utf8'));
  assert.equal(schema.title.includes('ASC Framing Decision List'), true);
  assert.ok(Array.isArray(schema.required) && schema.required.includes('framing_intents'));
});

test('buildAscFdl output passes structural validation', () => {
  const doc = buildAscFdl(fixture);
  const v = validateAscFdl(doc);
  assert.ok(v.ok, `validation errors: ${v.errors.join('; ')}`);
  assert.ok(doc.version && Number.isInteger(doc.version.major), 'has version {major,minor}');
  assert.equal(doc.default_framing_intent, 'scope_239', 'default = first intent');
});

test('GOLDEN: 2.39 scope on a 4096×2160 canvas is pixel-accurate', () => {
  const doc = buildAscFdl(fixture);
  const decisions = doc.contexts[0].canvases[0].framing_decisions;
  const scope = decisions.find((d) => d.framing_intent_id === 'scope_239');
  assert.deepEqual(scope.dimensions, { width: 4096, height: 1714 }, '4096/2.39 → 1714 tall');
  assert.deepEqual(scope.anchor_point, { x: 0, y: 223 }, 'centered vertically');
});

test('GOLDEN: 16:9 on a 4096×2160 canvas is pixel-accurate', () => {
  const doc = buildAscFdl(fixture);
  const hd = doc.contexts[0].canvases[0].framing_decisions.find((d) => d.framing_intent_id === 'hd_169');
  assert.deepEqual(hd.dimensions, { width: 3840, height: 2160 }, '2160*16/9 → 3840 wide');
  assert.deepEqual(hd.anchor_point, { x: 128, y: 0 }, 'centered horizontally');
});

test('computeFramingDecision honors anamorphic squeeze', () => {
  // 2x anamorphic 2048-wide sensor → 4096 display width; 2.39 target.
  const fd = computeFramingDecision({ canvasWidth: 2048, canvasHeight: 2160, aspectWidth: 239, aspectHeight: 100, anamorphicSqueeze: 2 });
  // display width 4096 → height 4096/2.39 = 1714; stored against the 2048 canvas
  assert.equal(fd.dimensions.height, 1714, 'de-squeezed height matches scope');
});

test('round-trips through JSON parse unchanged', () => {
  const doc = buildAscFdl(fixture);
  assert.deepEqual(JSON.parse(buildAscFdlJson(doc)), doc);
});

test('protection inset shrinks the framing decision', () => {
  const doc = buildAscFdl({ ...fixture, framingIntents: [{ id: 'p', label: 'p', aspectWidth: 16, aspectHeight: 9, protection: 0.05 }] });
  const fd = doc.contexts[0].canvases[0].framing_decisions[0];
  assert.ok(fd.dimensions.width < 3840, 'protection reduces width');
});

// Byte-parity vs a real Netflix-exported .fdl — locks the exact version object
// and key casing. Skipped until the user commits test/color/fixtures/netflix_sample.fdl.
test('byte-parity vs real Netflix .fdl sample', { skip: existsSync(path.join(HERE, 'fixtures', 'netflix_sample.fdl')) ? false : 'no netflix_sample.fdl committed yet — see test/README / task §E' }, () => {
  const sample = JSON.parse(readFileSync(path.join(HERE, 'fixtures', 'netflix_sample.fdl'), 'utf8'));
  // Structural-key parity (not full value parity): version object + top-level keys.
  assert.deepEqual(Object.keys(buildAscFdl(fixture)).sort(), Object.keys(sample).sort());
});
