// scripts/features/acesLook/services/presetService.js
// Save/load ACES Look presets via localStorage.

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
