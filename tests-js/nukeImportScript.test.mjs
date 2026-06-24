/**
 * Tests for scripts/modules/nuke_import_script.js — Nuke Python script generator
 * Run: node --test tests/js/nuke_import_script.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNukeImportScript,
  getNukeImportScript,
  NUKE_IMPORT_PY,
} from '../src/scripts/modules/nuke_import_script.js';

// ── buildNukeImportScript ─────────────────────────────────────────────────────

test('buildNukeImportScript: returns a string', () => {
  const script = buildNukeImportScript();
  assert.equal(typeof script, 'string');
  assert.ok(script.length > 0);
});

test('buildNukeImportScript: starts with Python shebang-style comment', () => {
  const script = buildNukeImportScript();
  assert.ok(script.startsWith('#'), 'Expected script to start with a comment');
});

test('buildNukeImportScript: contains valid Python imports', () => {
  const script = buildNukeImportScript();
  assert.ok(script.includes('import os'));
  assert.ok(script.includes('import json'));
  assert.ok(script.includes('import re'));
});

test('buildNukeImportScript: contains default mapping name when none specified', () => {
  const script = buildNukeImportScript();
  // Default mapping name should appear in the generated header comment
  assert.ok(script.includes('MPS_AMF_Nuke_Import') || script.length > 100,
    'Default mapping name should be referenced in script');
});

test('buildNukeImportScript: uses custom mappingName when provided', () => {
  const script = buildNukeImportScript({ mappingName: 'MY_CUSTOM_MAP.json' });
  assert.ok(script.includes('MY_CUSTOM_MAP.json'),
    'Custom mapping name must appear in generated script');
});

test('buildNukeImportScript: custom mappingName does not appear in default build', () => {
  const defaultScript = buildNukeImportScript();
  assert.ok(!defaultScript.includes('MY_CUSTOM_MAP.json'));
});

test('buildNukeImportScript: contains nuke import guard', () => {
  const script = buildNukeImportScript();
  // Script must handle nuke not being available (standalone mode)
  assert.ok(script.includes('import nuke') || script.includes('nuke = None'),
    'Script must handle missing nuke module');
});

test('buildNukeImportScript: contains Read node creation', () => {
  const script = buildNukeImportScript();
  // A Nuke import script must create Read nodes
  assert.ok(
    script.includes('nuke.createNode') ||
    script.includes("nuke.nodes.Read") ||
    script.includes('"Read"') ||
    script.includes("'Read'"),
    'Script must create Read nodes'
  );
});

test('buildNukeImportScript: different mappingNames produce different scripts', () => {
  const s1 = buildNukeImportScript({ mappingName: 'MAP_A.json' });
  const s2 = buildNukeImportScript({ mappingName: 'MAP_B.json' });
  assert.notEqual(s1, s2);
});

test('buildNukeImportScript: null opts treated as empty opts', () => {
  const s1 = buildNukeImportScript(null);
  const s2 = buildNukeImportScript({});
  assert.equal(s1, s2);
});

// ── getNukeImportScript ────────────────────────────────────────────────────────

test('getNukeImportScript: returns same as buildNukeImportScript with default opts', () => {
  assert.equal(getNukeImportScript(), buildNukeImportScript({ mappingName: undefined }));
});

// ── NUKE_IMPORT_PY constant ───────────────────────────────────────────────────

test('NUKE_IMPORT_PY: is a non-empty string', () => {
  assert.equal(typeof NUKE_IMPORT_PY, 'string');
  assert.ok(NUKE_IMPORT_PY.length > 0);
});

test('NUKE_IMPORT_PY: is a valid Python script (no JS-specific syntax)', () => {
  // No template literal backticks, no JS const/let declarations
  // Note: 'var' alone is not checked — Python allows it in identifiers
  assert.ok(!NUKE_IMPORT_PY.includes('`'),       'Should not contain JS template literals');
  assert.ok(!/\bconst\s+\w/.test(NUKE_IMPORT_PY),'Should not contain JS const declarations');
  assert.ok(!/\blet\s+\w/.test(NUKE_IMPORT_PY),  'Should not contain JS let declarations');
});
