// scripts/features/aceslook/services/transformRegistry.js
// ACES transform registry — now CONFIG-DRIVEN from acesTransformIds.js (the
// editable manifest). Switching `acesVersion` ('1.3' | '2.0', default '2.0')
// yields the version-correct Transform ID. No more hardcoded ID literals here.
//
// Back-compat: `REGISTRY.inputTransforms` / `REGISTRY.outputTransforms` keep the
// same shape the cards expect (keyed by KEY, with .label/.transformId/.ocioName/
// .note), with transformId defaulting to the ACES 2.0 ID. LMTs live under
// REGISTRY.lookTransforms so they don't pollute the IDT/ODT dropdowns.
import { ACES_TRANSFORM_IDS } from './acesTransformIds.js';

export const ACES_DEFAULT_VERSION = ACES_TRANSFORM_IDS.acesVersion || '2.0';

function idFor(entry, acesVersion) {
  if (!entry) return null;
  return String(acesVersion) === '1.3' ? (entry.aces1_3_id || null) : (entry.aces2_0_id || null);
}

function viewEntry(key, acesVersion) {
  const entry = ACES_TRANSFORM_IDS.transforms[key];
  if (!entry) return null;
  return {
    key,
    kind:          entry.kind,
    label:         entry.label,
    ocioName:      entry.ocioName ?? null,
    note:          entry.note,
    amfApplicable: !!entry.amfApplicable,
    parametric:    !!entry.parametric,
    params:        entry.params || null,
    legacy20NotRecommended: !!entry.legacy20NotRecommended,
    transformId:   idFor(entry, acesVersion),
  };
}

function groupByKind(kind, acesVersion) {
  const out = {};
  for (const [key, entry] of Object.entries(ACES_TRANSFORM_IDS.transforms)) {
    if (entry.kind !== kind) continue;
    out[key] = viewEntry(key, acesVersion);
  }
  return out;
}

// Back-compat REGISTRY (default ACES version). Built once at module load.
export const REGISTRY = {
  inputTransforms:  groupByKind('idt', ACES_DEFAULT_VERSION),
  outputTransforms: groupByKind('odt', ACES_DEFAULT_VERSION),
  lookTransforms:   groupByKind('lmt', ACES_DEFAULT_VERSION),
};

/** Resolve an input transform key for a given ACES version. */
export function resolveInputTransform(key, { acesVersion = ACES_DEFAULT_VERSION } = {}) {
  const v = viewEntry(key, acesVersion);
  if (!v || v.kind !== 'idt') return null;
  return { ...v, resolved: key !== 'AUTO' && key !== 'CUSTOM_FILE' };
}

/** Resolve an output transform key. Returns null for NONE_RECIPE_ONLY (omitted in AMF) or unknown keys. */
export function resolveOutputTransform(key, { acesVersion = ACES_DEFAULT_VERSION } = {}) {
  if (key === 'NONE_RECIPE_ONLY') return null;
  const v = viewEntry(key, acesVersion);
  return v && v.kind === 'odt' ? v : null;
}

/** Resolve a look (LMT) transform key for a given ACES version. */
export function resolveLookTransform(key, { acesVersion = ACES_DEFAULT_VERSION } = {}) {
  const v = viewEntry(key, acesVersion);
  return v && v.kind === 'lmt' ? v : null;
}

/** List output transforms for the UI dropdown (version-aware). */
export function listOutputTransforms(acesVersion = ACES_DEFAULT_VERSION) {
  return Object.keys(groupByKind('odt', acesVersion))
    .filter((k) => k !== 'NONE_RECIPE_ONLY')
    .map((k) => viewEntry(k, acesVersion));
}

/** Reverse lookup: a Transform ID (any version) → registry key, or null. */
export function keyForTransformId(transformId) {
  if (!transformId) return null;
  for (const [key, entry] of Object.entries(ACES_TRANSFORM_IDS.transforms)) {
    if (entry.aces2_0_id === transformId || entry.aces1_3_id === transformId) return key;
  }
  return null;
}
