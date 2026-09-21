// scripts/features/acesLook/state/acesLookStore.js
// Centralized reactive state for the ACES Look tab.
// Subscriber pattern: subscribe(fn) -> unsubscribe fn.

import { defaultState, MODE_DEFAULTS } from './acesLookDefaults.js';

let _state = defaultState();
const _listeners = new Set();

function _notify() {
  const snapshot = getState();
  for (const fn of _listeners) fn(snapshot);
}

export function getState() {
  // Return a shallow copy so callers can't mutate directly
  return { ..._state, primaryControls: { ..._state.primaryControls }, cdl: { ..._state.cdl } };
}

export function subscribe(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function patch(partial) {
  _state = { ..._state, ...partial };
  _notify();
}

export function setSource(file) {
  patch({ source: file, exportResult: null });
}

export function setMode(mode) {
  const defaults = MODE_DEFAULTS[mode];
  if (!defaults) return;
  patch({
    mode,
    workingLocation: defaults.workingLocation,
    outputTransform: defaults.outputTransform,
    preserveSdr:     defaults.preserveSdr,
    exportResult:    null,
  });
}

export function setInputTransform(key) {
  patch({ inputTransform: key, exportResult: null });
}

export function setOutputTransform(key) {
  patch({ outputTransform: key, exportResult: null });
}

export function setWorkingLocation(loc) {
  patch({ workingLocation: loc, exportResult: null });
}

export function setPrimaryControl(key, value) {
  patch({ primaryControls: { ..._state.primaryControls, [key]: value }, exportResult: null });
}

export function setCdlEnabled(enabled) {
  patch({ cdlEnabled: enabled, exportResult: null });
}

export function setCdlValue(key, value) {
  patch({ cdl: { ..._state.cdl, [key]: value }, exportResult: null });
}

// ── Look stack mutations ─────────────────────────────────────────────────────
let _lookIdSeq = 0;
function _newId() { return `look_${++_lookIdSeq}`; }

export function addLookItem(kind, label, opts = {}) {
  const item = { id: _newId(), kind, label, enabled: true, ...opts };
  patch({ lookStack: [..._state.lookStack, item], exportResult: null });
  return item.id;
}

export function toggleLookItem(id) {
  patch({
    lookStack: _state.lookStack.map(l => l.id === id ? { ...l, enabled: !l.enabled } : l),
    exportResult: null,
  });
}

export function removeLookItem(id) {
  patch({ lookStack: _state.lookStack.filter(l => l.id !== id), exportResult: null });
}

export function reorderLookItems(ids) {
  const map = Object.fromEntries(_state.lookStack.map(l => [l.id, l]));
  patch({ lookStack: ids.map(id => map[id]).filter(Boolean), exportResult: null });
}

export function updateLookItem(id, partial) {
  patch({
    lookStack: _state.lookStack.map(l => l.id === id ? { ...l, ...partial } : l),
    exportResult: null,
  });
}

export function setClipId(clipId) { patch({ clipId }); }
export function setOcfMeta(ocfMeta) { patch({ ocfMeta: ocfMeta || null }); }

export function setValidation({ warnings = [], errors = [] }) {
  patch({ warnings, errors });
}

export function setExportResult(result) { patch({ exportResult: result }); }

export function resetState() {
  _state = defaultState();
  _notify();
}
