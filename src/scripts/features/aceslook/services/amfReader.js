// scripts/features/aceslook/services/amfReader.js
// AMF v2.0 READER — parses the real ACES Metadata File pipeline (not just CDL
// scraping like amf_convert.js) so PostFlowX can IMPORT a colorist's AMF, show
// the pipeline, and re-export it (round-trip). Reverse-maps known transformIds
// back to registry keys via the Phase A manifest; unknown IDs pass through.
//
// Namespace-agnostic: matches on element localName (ignores the `aces:` prefix)
// so it works under both linkedom (tests) and the renderer's DOMParser.
import { keyForTransformId } from './transformRegistry.js';

// ── DOM helpers (localName-based; prefix-agnostic) ──────────────────────────
function _local(el) { return (el.localName || el.tagName || '').replace(/^.*:/, '').toLowerCase(); }
function _allByLocal(root, name) {
  const want = name.toLowerCase();
  const out = [];
  const walk = (node) => {
    for (const ch of node.children || []) {
      if (_local(ch) === want) out.push(ch);
      walk(ch);
    }
  };
  if (root) walk(root);
  return out;
}
function _firstByLocal(root, name) { return _allByLocal(root, name)[0] || null; }
// Direct-child variant (so a pipeline's own inputTransform isn't confused with a nested one)
function _childByLocal(root, name) {
  const want = name.toLowerCase();
  for (const ch of (root && root.children) || []) if (_local(ch) === want) return ch;
  return null;
}
function _childrenByLocal(root, name) {
  const want = name.toLowerCase();
  return [...((root && root.children) || [])].filter((ch) => _local(ch) === want);
}
function _text(el) { return el ? String(el.textContent || '').trim() : ''; }

// Parse one transform block → { applied, transformId, file, description, key, label }.
function _parseTransform(el) {
  if (!el) return null;
  const transformId = _text(_childByLocal(el, 'transformId')) || null;
  const file = _text(_childByLocal(el, 'file')) || null;
  const description = _text(_childByLocal(el, 'description')) || '';
  const appliedAttr = (el.getAttribute && el.getAttribute('applied')) || '';
  const applied = String(appliedAttr).toLowerCase() === 'true';
  const key = transformId ? keyForTransformId(transformId) : null;
  return { applied, transformId, file, description, key, label: description || key || transformId || file || '' };
}

// Extract ASC-CDL SOP/Sat if present inside a lookTransform (aces:ASC_CDL or SOPNode).
function _parseCdl(lookEl) {
  if (!lookEl) return null;
  const sop = _firstByLocal(lookEl, 'SOPNode') || _firstByLocal(lookEl, 'sopnode');
  const sat = _firstByLocal(lookEl, 'SatNode') || _firstByLocal(lookEl, 'satnode');
  const triple = (name) => {
    const n = _firstByLocal(lookEl, name);
    if (!n) return null;
    const nums = _text(n).split(/\s+/).map(Number).filter((x) => Number.isFinite(x));
    return nums.length === 3 ? nums : null;
  };
  const slope = triple('Slope');
  const offset = triple('Offset');
  const power = triple('Power');
  const satV = sat ? Number(_text(_firstByLocal(sat, 'Saturation'))) : NaN;
  if (!slope && !offset && !power && !Number.isFinite(satV)) return null;
  return { slope, offset, power, saturation: Number.isFinite(satV) ? satV : null };
}

/**
 * Parse an AMF v2.0 XML string.
 * @returns {{ ok, acesVersion, clipId, inputTransform, lookTransforms, outputTransform, cdl, warnings }}
 */
export function parseAmf(xmlText) {
  const warnings = [];
  const empty = {
    ok: false, acesVersion: null, clipId: null,
    inputTransform: null, lookTransforms: [], outputTransform: null, cdl: null, warnings,
  };
  if (!xmlText || typeof xmlText !== 'string') { warnings.push('Empty AMF input.'); return empty; }

  let doc;
  try { doc = new DOMParser().parseFromString(xmlText, 'application/xml'); }
  catch (e) { warnings.push(`AMF XML parse error: ${e.message}`); return empty; }

  const root = doc.documentElement;
  if (!root || _local(root) !== 'acesmetadatafile') {
    warnings.push('Not an AMF document (root is not acesMetadataFile).');
    return empty;
  }

  const clipId = _text(_firstByLocal(root, 'clipName')) || null;

  // ACES system version from pipelineInfo/systemVersion → "major.minor"
  let acesVersion = null;
  const sysV = _firstByLocal(root, 'systemVersion');
  if (sysV) {
    const maj = _text(_firstByLocal(sysV, 'majorVersion'));
    const min = _text(_firstByLocal(sysV, 'minorVersion'));
    if (maj) acesVersion = `${maj}.${min || 0}`;
  }

  const pipeline = _firstByLocal(root, 'pipeline');
  if (!pipeline) { warnings.push('AMF has no <pipeline> — nothing to apply.'); return { ...empty, acesVersion, clipId }; }

  const inputTransform = _parseTransform(_childByLocal(pipeline, 'inputTransform'));
  const lookEls = _childrenByLocal(pipeline, 'lookTransform');
  const lookTransforms = lookEls.map(_parseTransform);
  const outputTransform = _parseTransform(_childByLocal(pipeline, 'outputTransform'));

  // First look that carries an inline ASC-CDL (Slope/Offset/Power/Sat).
  let cdl = null;
  for (const el of lookEls) { cdl = _parseCdl(el); if (cdl) break; }

  for (const t of lookTransforms) {
    if (t && !t.transformId && !t.file) warnings.push(`Look "${t.description || '?'}" has neither transformId nor file.`);
  }

  return { ok: true, acesVersion, clipId, inputTransform, lookTransforms, outputTransform, cdl, warnings };
}

export default parseAmf;
