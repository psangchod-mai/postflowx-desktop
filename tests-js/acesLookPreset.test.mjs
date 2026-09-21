// ACES Look preset export/import (.pfxpreset). Run: node tests-js/acesLookPreset.test.mjs

// Minimal localStorage polyfill (Node has none) so the storage-backed wrappers work.
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
})();

const {
  savePreset, listPresets, loadPreset,
  serializePresets, parsePresetsFile,
  exportPreset, exportAllPresets, importPresets,
  getDefaultPresets, seedDefaultPresets,
  PRESET_FILE_FORMAT, PRESET_FILE_VERSION,
} = await import('../src/scripts/features/aceslook/services/presetService.js');
const { resolveInputTransform } = await import('../src/scripts/features/aceslook/services/transformRegistry.js');
const { MODE_DEFAULTS, WORKING_LOCATIONS } = await import('../src/scripts/features/aceslook/state/acesLookDefaults.js');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }
function eq(got, want, l) { ok(got === want, `${l} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`); }

const state = {
  mode: 'aces', inputTransform: 'ARRI LogC4', workingLocation: 'ACEScct',
  outputTransform: 'Rec.709', preserveSdr: true,
  primaryControls: { exposure: 0.2 }, cdlEnabled: true,
  cdl: { slope: [1, 1, 1] }, lookStack: [{ id: 'a', amount: 0.5 }],
};

// ── serialize ──
savePreset('Show A', state);
const doc = serializePresets({ 'Show A': loadPreset('Show A') });
eq(doc.format, PRESET_FILE_FORMAT, 'serialize: format tag');
eq(doc.version, PRESET_FILE_VERSION, 'serialize: version');
ok(!!doc.presets['Show A'], 'serialize: preset present');
eq(doc.presets['Show A'].inputTransform, 'ARRI LogC4', 'serialize: field preserved');

// ── round-trip export → fresh store → import ──
const exp = exportAllPresets();
ok(exp.ok && exp.filename.endsWith('.pfxpreset'), 'exportAllPresets: ok + .pfxpreset filename');
localStorage.clear();
eq(listPresets().length, 0, 'store cleared');
const imp = importPresets(exp.json);
ok(imp.ok && imp.imported.includes('Show A'), 'importPresets: imported Show A');
eq(loadPreset('Show A').outputTransform, 'Rec.709', 'round-trip: field intact');

// ── collision handling ──
const imp2 = importPresets(exp.json);                       // same names again
ok(imp2.skipped.includes('Show A') && imp2.imported.length === 0, 'import: collision skipped by default');
const imp3 = importPresets(exp.json, { overwrite: true });
ok(imp3.imported.includes('Show A'), 'import: overwrite replaces');

// ── single-preset export ──
const one = exportPreset('Show A');
ok(one.ok && one.filename === 'Show A.pfxpreset', 'exportPreset: single file');
eq(exportPreset('Missing').ok, false, 'exportPreset: missing → not ok');

// ── validation / hardening ──
eq(parsePresetsFile('not json{').ok, false, 'parse: bad JSON rejected');
eq(parsePresetsFile('{"format":"something.else","presets":{}}').ok, false, 'parse: wrong format rejected');
eq(parsePresetsFile(JSON.stringify({ format: PRESET_FILE_FORMAT, version: 999, presets: {} })).ok, false, 'parse: newer version rejected');
eq(parsePresetsFile('{"presets":{}}').ok, false, 'parse: empty presets rejected');
// junk keys stripped — only whitelisted fields survive
const inj = parsePresetsFile(JSON.stringify({ presets: { Evil: { name: 'Evil', __proto__hack: 1, danger: 'x', mode: 'aces' } } }));
ok(inj.ok && !('danger' in inj.presets.Evil) && !('__proto__hack' in inj.presets.Evil), 'parse: non-whitelisted keys stripped');
// legacy bare {name: preset} map still imports
const legacy = parsePresetsFile(JSON.stringify({ 'Legacy One': { name: 'Legacy One', mode: 'aces' } }));
ok(legacy.ok && !!legacy.presets['Legacy One'], 'parse: legacy bare map accepted');

// ── bundled starter library: every preset must use valid enum values ──
const VALID_OUTPUTS = new Set(['NONE_RECIPE_ONLY', 'HDR_P3D65_PQ1000', 'HDR_REC2100_PQ', 'SDR_REC709']);
const defs = getDefaultPresets();
ok(defs.length >= 5, `default library has presets (${defs.length})`);
for (const p of defs) {
  ok(p.name && p.name.trim().length > 0, `default "${p.name}": has name`);
  ok(p.mode in MODE_DEFAULTS, `default "${p.name}": mode "${p.mode}" valid`);
  ok(resolveInputTransform(p.inputTransform) !== null, `default "${p.name}": inputTransform "${p.inputTransform}" valid`);
  ok(WORKING_LOCATIONS.includes(p.workingLocation), `default "${p.name}": workingLocation "${p.workingLocation}" valid`);
  ok(VALID_OUTPUTS.has(p.outputTransform), `default "${p.name}": outputTransform "${p.outputTransform}" valid`);
  ok(parsePresetsFile(JSON.stringify(serializePresets({ [p.name]: p }))).ok, `default "${p.name}": serializes + parses`);
}

// ── seeding: adds to empty store, idempotent on second call ──
localStorage.clear();
const s1 = seedDefaultPresets();
eq(s1.imported.length, defs.length, 'seed: all starters imported into empty store');
eq(listPresets().length, defs.length, 'seed: store now has starters');
const s2 = seedDefaultPresets();
eq(s2.imported.length, 0, 'seed: idempotent (second call adds nothing)');
eq(s2.skipped.length, defs.length, 'seed: second call skips existing');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
