// scripts/features/acesLook/services/presetService.js
// Save/load ACES Look presets via localStorage.

import { DEFAULT_PRESETS } from './defaultPresets.js';

const STORAGE_KEY = 'pfx_acesLook_presets_v1';

function _load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  } catch {
    return {};
  }
}

function _save(presets) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  } catch {}
}

/** List all saved preset names. */
export function listPresets() {
  return Object.keys(_load()).sort();
}

/**
 * Save the current ACES Look state as a named preset.
 * Only persists the portable subset of state (excludes source File object).
 */
export function savePreset(name, state) {
  if (!name || !name.trim()) return { ok: false, error: 'Preset name is required.' };
  const presets = _load();
  presets[name.trim()] = {
    name:            name.trim(),
    mode:            state.mode,
    inputTransform:  state.inputTransform,
    workingLocation: state.workingLocation,
    outputTransform: state.outputTransform,
    preserveSdr:     state.preserveSdr,
    primaryControls: { ...state.primaryControls },
    cdlEnabled:      state.cdlEnabled,
    cdl:             { ...state.cdl },
    lookStack:       state.lookStack.map(l => ({ ...l })),
    savedAt:         new Date().toISOString(),
  };
  _save(presets);
  return { ok: true };
}

/**
 * Load a preset by name.
 * Returns the preset payload (not the full state) or null if not found.
 */
export function loadPreset(name) {
  const presets = _load();
  return presets[name] || null;
}

/** Delete a preset by name. */
export function deletePreset(name) {
  const presets = _load();
  if (!presets[name]) return { ok: false, error: 'Preset not found.' };
  delete presets[name];
  _save(presets);
  return { ok: true };
}

// ── Shareable preset files (.pfxpreset) ──────────────────────────────────────
// Export to / import from a portable JSON document so presets can be shared
// across machines and teammates, not just held in this browser's localStorage.

export const PRESET_FILE_FORMAT  = 'postflowx.acesLook.preset';
export const PRESET_FILE_VERSION = 1;

// Whitelist + coerce one preset payload to the known portable shape. Returns
// null for anything that isn't a usable object — so importing a junk/oversized
// or hand-edited file can never inject arbitrary keys into stored state.
function _sanitizePreset(raw, fallbackName = '') {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || fallbackName || '').trim();
  if (!name) return null;
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
  return {
    name,
    mode:            raw.mode ?? null,
    inputTransform:  raw.inputTransform ?? null,
    workingLocation: raw.workingLocation ?? null,
    outputTransform: raw.outputTransform ?? null,
    preserveSdr:     !!raw.preserveSdr,
    primaryControls: { ...obj(raw.primaryControls) },
    cdlEnabled:      !!raw.cdlEnabled,
    cdl:             { ...obj(raw.cdl) },
    lookStack:       Array.isArray(raw.lookStack) ? raw.lookStack.map(l => ({ ...obj(l) })) : [],
    savedAt:         raw.savedAt || new Date().toISOString(),
  };
}

/**
 * Pure: wrap a {name: preset} map into the portable .pfxpreset document.
 * No localStorage — safe to unit-test and to call with any preset map.
 */
export function serializePresets(presetsMap) {
  const presets = {};
  for (const [key, val] of Object.entries(presetsMap || {})) {
    const clean = _sanitizePreset(val, key);
    if (clean) presets[clean.name] = clean;
  }
  return {
    format:     PRESET_FILE_FORMAT,
    version:    PRESET_FILE_VERSION,
    exportedAt: new Date().toISOString(),
    presets,
  };
}

/**
 * Pure: parse + validate a .pfxpreset document (string or object).
 * Returns { ok, presets, error }. Tolerates a bare {name: preset} map or a
 * single preset object too, so older/hand-made files still import.
 */
export function parsePresetsFile(input) {
  let doc;
  try {
    doc = typeof input === 'string' ? JSON.parse(input) : input;
  } catch (e) {
    return { ok: false, error: 'Not valid JSON.' };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, error: 'Empty or invalid file.' };

  // Reject only on a clearly-wrong format tag; accept untagged legacy shapes.
  if (doc.format && doc.format !== PRESET_FILE_FORMAT) {
    return { ok: false, error: `Unrecognized file format: ${doc.format}` };
  }
  if (Number.isFinite(doc.version) && doc.version > PRESET_FILE_VERSION) {
    return { ok: false, error: `Preset file is from a newer version (${doc.version}). Update PostFlowX.` };
  }

  // Accept {presets:{...}}, a bare {name:preset} map, or a single preset.
  const rawMap = doc.presets && typeof doc.presets === 'object' ? doc.presets
               : (doc.name ? { [doc.name]: doc } : doc);

  const presets = {};
  for (const [key, val] of Object.entries(rawMap || {})) {
    const clean = _sanitizePreset(val, key);
    if (clean) presets[clean.name] = clean;
  }
  if (!Object.keys(presets).length) return { ok: false, error: 'No valid presets found in file.' };
  return { ok: true, presets };
}

/** Export one preset as a pretty-printed .pfxpreset JSON string. */
export function exportPreset(name) {
  const p = loadPreset(name);
  if (!p) return { ok: false, error: 'Preset not found.' };
  return { ok: true, filename: `${name}.pfxpreset`, json: JSON.stringify(serializePresets({ [name]: p }), null, 2) };
}

/** Export all saved presets as a single .pfxpreset JSON string. */
export function exportAllPresets() {
  const all = _load();
  if (!Object.keys(all).length) return { ok: false, error: 'No presets to export.' };
  return { ok: true, filename: 'acesLook-presets.pfxpreset', json: JSON.stringify(serializePresets(all), null, 2) };
}

/**
 * Import presets from a .pfxpreset document into localStorage.
 * By default existing presets are kept (collisions skipped); pass
 * { overwrite: true } to replace them. Returns { ok, imported, skipped, error }.
 */
export function importPresets(input, { overwrite = false } = {}) {
  const parsed = parsePresetsFile(input);
  if (!parsed.ok) return { ok: false, imported: [], skipped: [], error: parsed.error };
  const store = _load();
  const imported = [], skipped = [];
  for (const [name, preset] of Object.entries(parsed.presets)) {
    if (store[name] && !overwrite) { skipped.push(name); continue; }
    store[name] = preset;
    imported.push(name);
  }
  _save(store);
  return { ok: true, imported, skipped };
}

// ── Bundled starter library ──────────────────────────────────────────────────

/** The shipped starter presets (sanitized copies — never mutate the originals). */
export function getDefaultPresets() {
  return DEFAULT_PRESETS.map(p => _sanitizePreset(p)).filter(Boolean);
}

/**
 * Add the bundled starter presets to the store. Existing user presets with the
 * same name are kept (skipped) unless { overwrite:true }. Returns the same
 * { ok, imported, skipped } shape as importPresets.
 */
export function seedDefaultPresets({ overwrite = false } = {}) {
  return importPresets(serializePresets(
    Object.fromEntries(getDefaultPresets().map(p => [p.name, p])),
  ), { overwrite });
}
