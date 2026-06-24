// scripts/features/acesLook/devtools/smokeTests.js
// ACES Look regression checks. Run from DevTools console:
//   pfxAcesLookRunChecks()
//
// Each check is self-contained, builds synthetic state, and verifies
// the invariants described in the implementation plan (section S3).

import { buildAmf }  from '../services/amfBuilder.js';
import { validate }  from '../state/acesLookValidation.js';
import { defaultState } from '../state/acesLookDefaults.js';

const PASS = '✅ PASS';
const FAIL = '❌ FAIL';

function _baseState(overrides = {}) {
  return {
    ...defaultState(),
    clipId:         'TEST_C001',
    inputTransform: 'ARRI_LOGC3',
    sourceClass:    'camera_native',
    source:         { name: 'test.mov' },
    ...overrides,
  };
}

// ── Check 1: AUTO input transform blocks AMF export ───────────────────────────
function checkAutoBlocksExport() {
  const state = _baseState({ inputTransform: 'AUTO' });
  const result = buildAmf(state);
  const pass = result.ok === false &&
    (result.errors || []).some(e => /auto|unresolved/i.test(e));
  return {
    name: 'AUTO input transform blocks AMF export',
    pass,
    detail: pass ? 'buildAmf returned ok:false with AUTO error'
                 : `buildAmf returned ok:${result.ok}, errors: ${JSON.stringify(result.errors)}`,
  };
}

// ── Check 2: Look stack order preserved in AMF output ────────────────────────
function checkLookStackOrder() {
  const state = _baseState({
    outputTransform: 'SDR_REC709',
    lookStack: [
      { id: 'l1', kind: 'clf', label: 'First Look',  enabled: true,  transformId: 'urn:test:first'  },
      { id: 'l2', kind: 'lut', label: 'Second Look', enabled: true,  transformId: 'urn:test:second' },
      { id: 'l3', kind: 'clf', label: 'Third Look',  enabled: false, transformId: 'urn:test:third'  },
    ],
  });
  const result = buildAmf(state);
  if (!result.ok) return { name: 'Look stack order preserved in AMF', pass: false,
    detail: `buildAmf failed: ${JSON.stringify(result.errors)}` };

  const xml = result.xml;
  const firstPos  = xml.indexOf('urn:test:first');
  const secondPos = xml.indexOf('urn:test:second');
  const thirdPos  = xml.indexOf('urn:test:third');

  const orderOk   = firstPos > 0 && secondPos > firstPos;
  const skippedOk = thirdPos === -1; // disabled item must be absent

  const pass = orderOk && skippedOk;
  return {
    name: 'Look stack order preserved + disabled items omitted',
    pass,
    detail: pass
      ? 'First before Second; Third (disabled) absent'
      : `orderOk=${orderOk} skippedOk=${skippedOk} firstPos=${firstPos} secondPos=${secondPos} thirdPos=${thirdPos}`,
  };
}

// ── Check 3: NONE_RECIPE_ONLY omits outputTransform element ──────────────────
function checkVfxPullOmitsOutputTransform() {
  const state = _baseState({ outputTransform: 'NONE_RECIPE_ONLY' });
  const result = buildAmf(state);
  if (!result.ok) return { name: 'VFX pull (NONE_RECIPE_ONLY) omits outputTransform', pass: false,
    detail: `buildAmf failed: ${JSON.stringify(result.errors)}` };

  const hasOT = result.xml.includes('<aces:outputTransform');
  const pass  = !hasOT;
  return {
    name: 'VFX pull (NONE_RECIPE_ONLY) omits outputTransform element',
    pass,
    detail: pass ? 'No outputTransform element in AMF' : 'outputTransform element unexpectedly present',
  };
}

// ── Check 4: CDL appears first in look stack order ───────────────────────────
function checkCdlFirstInLookStack() {
  const state = _baseState({
    outputTransform: 'SDR_REC709',
    cdlEnabled: true,
    cdl: { slope: [1,1,1], offset: [0,0,0], power: [1,1,1], sat: 1 },
    lookStack: [
      { id: 'l1', kind: 'clf', label: 'A CLF', enabled: true, transformId: 'urn:test:clf' },
    ],
  });
  const result = buildAmf(state);
  if (!result.ok) return { name: 'CDL appears before other look items', pass: false,
    detail: `buildAmf failed: ${JSON.stringify(result.errors)}` };

  const cdlPos = result.xml.indexOf('LMT.Academy.ASC_CDL');
  const clfPos = result.xml.indexOf('urn:test:clf');
  const pass   = cdlPos > 0 && clfPos > cdlPos;
  return {
    name: 'CDL appears before other look items in AMF',
    pass,
    detail: pass ? `CDL at ${cdlPos}, CLF at ${clfPos}` : `CDL=${cdlPos} CLF=${clfPos} — wrong order or missing`,
  };
}

// ── Check 5: Missing clipId is a hard error ───────────────────────────────────
function checkMissingClipIdBlocks() {
  const state = _baseState({ clipId: '' });
  const { errors } = validate(state);
  const pass = errors.some(e => /clip.?id/i.test(e));
  return {
    name: 'Missing Clip ID produces hard validation error',
    pass,
    detail: pass ? 'Clip ID error found in validate()' : `No Clip ID error. Errors: ${JSON.stringify(errors)}`,
  };
}

// ── Check 6: AMF namespace and root element are correct ───────────────────────
function checkAmfNamespaceAndRoot() {
  const state = _baseState({ outputTransform: 'SDR_REC709' });
  const result = buildAmf(state);
  if (!result.ok) return { name: 'AMF namespace and root element', pass: false,
    detail: `buildAmf failed: ${JSON.stringify(result.errors)}` };

  const hasCorrectNs   = result.xml.includes('urn:ampas:aces:amf:v2.0');
  const hasCorrectRoot = result.xml.includes('aces:acesMetadataFile');
  const hasVersion     = result.xml.includes('version="2.0"');
  const pass = hasCorrectNs && hasCorrectRoot && hasVersion;
  return {
    name: 'AMF uses correct namespace + root element (spec compliance)',
    pass,
    detail: pass ? 'Namespace, root element, and version attribute all correct'
                 : `ns=${hasCorrectNs} root=${hasCorrectRoot} version=${hasVersion}`,
  };
}

// ── Runner ────────────────────────────────────────────────────────────────────
function runAllChecks() {
  const checks = [
    checkAutoBlocksExport,
    checkLookStackOrder,
    checkVfxPullOmitsOutputTransform,
    checkCdlFirstInLookStack,
    checkMissingClipIdBlocks,
    checkAmfNamespaceAndRoot,
  ];

  console.group('%c PostFlowX — ACES Look Regression Checks', 'font-weight:bold;color:#b39ddb');
  let passed = 0;
  let failed = 0;

  for (const fn of checks) {
    const { name, pass, detail } = fn();
    const icon = pass ? PASS : FAIL;
    if (pass) {
      console.log(`${icon}  ${name}`, detail ? `— ${detail}` : '');
      passed++;
    } else {
      console.warn(`${icon}  ${name}`, `\n    ${detail}`);
      failed++;
    }
  }

  console.log(`\n  ${passed}/${checks.length} passed${failed > 0 ? `  (${failed} failed)` : ''}`);
  console.groupEnd();
  return { passed, failed, total: checks.length };
}

// Expose globally for DevTools console use
window.pfxAcesLookRunChecks = runAllChecks;

export { runAllChecks };
