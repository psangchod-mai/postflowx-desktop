// scripts/features/acesLook/services/amfBuilder.js
// Builds an ACES Metadata File (AMF) XML string from validated ACES Look state.
//
// Spec reference: aces-aswf/aces-amf (https://github.com/aces-aswf/aces-amf)
// Namespace:      urn:ampas:aces:amf:v2.0
// Root element:   aces:acesMetadataFile   (NOT aces:amf)
// Version attr:   version="2.0"
//
// TODO (future): align transformId values with OpenColorIO-Config-ACES
//   transforms.json / interchange.amf_transform_ids when that config ships
//   a stable v2.0 release. Current IDs are taken from the ACES 2.0 IDT/ODT
//   registry and should be re-validated against OCIO-Config-ACES v4+.

import { resolveInputTransform, resolveOutputTransform, resolveLookTransform, ACES_DEFAULT_VERSION } from './transformRegistry.js';
import { validate } from '../state/acesLookValidation.js';
import { resolveIdtFromOCFMeta } from './ocfIdtResolver.js';

const AMF_NS = 'urn:ampas:aces:amf:v2.0';

// ACES system version "X.Y" → { major:X, minor:Y } for <aces:systemVersion>.
function _sysVersion(acesVersion) {
  const [maj, min] = String(acesVersion || ACES_DEFAULT_VERSION).split('.').map((n) => parseInt(n, 10) || 0);
  return { major: maj || 2, minor: min || 0, patch: 0 };
}

/**
 * Build an AMF XML string from the current state.
 * Returns { ok: boolean, xml?: string, errors: string[], warnings: string[] }
 */
export function buildAmf(state) {
  const { errors, warnings } = validate(state);
  if (errors.length > 0) return { ok: false, errors, warnings };

  const acesVersion = state.acesVersion || ACES_DEFAULT_VERSION;
  const idt = resolveInputTransform(state.inputTransform, { acesVersion });
  // OCF auto-detect: when the IDT is unresolved (no registry entry, or the AUTO
  // sentinel) but the clip carries OCF metadata, derive the IDT (label + ACES
  // URN) straight from the camera format so the inputTransform isn't left blank.
  const idtUnresolved = !idt || idt.resolved === false || state.inputTransform === 'AUTO';
  const ocfIdt = (idtUnresolved && state.ocfMeta && state.inputTransform !== 'NONE_ALREADY_ACES')
    ? resolveIdtFromOCFMeta(state.ocfMeta) : null;
  const odt = resolveOutputTransform(state.outputTransform, { acesVersion });
  const now = new Date().toISOString();
  const uuid1 = _uuid();
  const uuid2 = _uuid();

  const lines = [];
  const p = s => lines.push(s);

  p(`<?xml version="1.0" encoding="UTF-8"?>`);
  p(`<aces:acesMetadataFile version="2.0" xmlns:aces="${AMF_NS}">`);

  // ── amfInfo ──────────────────────────────────────────────────────────────
  // Resolve 21 displays this description as the "AMF transform name" in the
  // project settings ACES AMF tree. Make it informative: IDT → ODT.
  const idt_label = ocfIdt ? ocfIdt.colorSpaceLabel : ((idt && idt.label) ? idt.label : (state.inputTransform || 'Camera'));
  const odt_label = (odt && odt.label) ? odt.label : (state.outputTransform || 'Display');
  const transformName = state.clipId
    ? `${_esc(state.clipId)} | ${_esc(idt_label)} → ${_esc(odt_label)}`
    : `${_esc(idt_label)} → ${_esc(odt_label)}`;

  p(`  <aces:amfInfo>`);
  p(`    <aces:description>${transformName}</aces:description>`);
  p(`    <aces:dateTime>`);
  p(`      <aces:creationDateTime>${now}</aces:creationDateTime>`);
  p(`      <aces:modificationDateTime>${now}</aces:modificationDateTime>`);
  p(`    </aces:dateTime>`);
  p(`    <aces:uuid>urn:uuid:${uuid1}</aces:uuid>`);
  p(`  </aces:amfInfo>`);

  // ── clipId — omit for project-level look (Resolve 21 project settings AMF) ──
  // When state.projectLevel === true or clipId is empty, Resolve 21 applies
  // this AMF as a project-level look transform (not clip-specific).
  if (state.clipId && !state.projectLevel) {
    p(`  <aces:clipId>`);
    p(`    <aces:clipName>${_esc(state.clipId)}</aces:clipName>`);
    p(`  </aces:clipId>`);
  }

  // ── pipeline ─────────────────────────────────────────────────────────────
  p(`  <aces:pipeline>`);
  p(`    <aces:pipelineInfo>`);
  p(`      <aces:dateTime>`);
  p(`        <aces:creationDateTime>${now}</aces:creationDateTime>`);
  p(`        <aces:modificationDateTime>${now}</aces:modificationDateTime>`);
  p(`      </aces:dateTime>`);
  p(`      <aces:uuid>urn:uuid:${uuid2}</aces:uuid>`);
  // systemVersion reflects the ACES SYSTEM version actually used (2/0/0 for
  // ACES 2.0) — sourced from the registry/project version, not hardcoded.
  const sv = _sysVersion(acesVersion);
  p(`      <aces:systemVersion>`);
  p(`        <aces:majorVersion>${sv.major}</aces:majorVersion>`);
  p(`        <aces:minorVersion>${sv.minor}</aces:minorVersion>`);
  p(`        <aces:patchVersion>${sv.patch}</aces:patchVersion>`);
  p(`      </aces:systemVersion>`);
  p(`    </aces:pipelineInfo>`);

  // ── Input Transform ───────────────────────────────────────────────────────
  if ((idt || ocfIdt) && state.inputTransform !== 'NONE_ALREADY_ACES') {
    // OCF-resolved IDT wins when the registry transform was unresolved/AUTO.
    const idtDesc = ocfIdt ? ocfIdt.colorSpaceLabel : idt.label;
    const idtTid  = ocfIdt ? ocfIdt.acesIdtUrn : idt.transformId;
    p(`    <aces:inputTransform applied="false">`);
    p(`      <aces:description>${_esc(idtDesc)}</aces:description>`);
    if (idtTid) {
      p(`      <aces:transformId>${_esc(idtTid)}</aces:transformId>`);
    } else {
      // No official ACES IDT — reference the CLF file
      p(`      <aces:file>${_esc(state.inputTransformFile || '')}</aces:file>`);
    }
    p(`    </aces:inputTransform>`);
  }

  // ── Look Transforms (one element per item, in UI order) ────────────────────
  // ACES Reference Gamut Compression — emitted ONLY when explicitly enabled.
  // Gamut mapping conceptually precedes the creative look, so RGC leads.
  if (state.rgcEnabled) {
    const rgc = resolveLookTransform('LMT_RGC', { acesVersion });
    p(`    <aces:lookTransform applied="false">`);
    p(`      <aces:description>${_esc(rgc?.label || 'Reference Gamut Compression')}</aces:description>`);
    if (rgc?.transformId) p(`      <aces:transformId>${_esc(rgc.transformId)}</aces:transformId>`);
    p(`    </aces:lookTransform>`);
    // Per ACES 2.0 guidance, the 2.0 Output Transform already gamut-maps, so a
    // standalone RGC is usually unnecessary and can over-compress — warn.
    if (odt && acesVersion === '2.0') {
      warnings.push('Standalone Reference Gamut Compression with an ACES 2.0 Output Transform is generally not recommended — the 2.0 Output Transform already performs gamut mapping.');
    }
  }

  // CDL is first among creative look items if enabled. The ASC-CDL LMT ID comes
  // from the manifest (ACES 2.0 carries the v1.4 ASC_CDL LMT ID — documented in
  // acesTransformIds.js), not a literal.
  if (state.cdlEnabled) {
    const cdlLmt = resolveLookTransform('LMT_ASC_CDL', { acesVersion });
    p(`    <aces:lookTransform applied="false">`);
    p(`      <aces:description>ASC CDL</aces:description>`);
    p(`      <aces:transformId>${_esc(cdlLmt?.transformId || '')}</aces:transformId>`);
    p(`    </aces:lookTransform>`);
  }

  for (const item of state.lookStack) {
    if (!item.enabled) continue;
    p(`    <aces:lookTransform applied="false">`);
    p(`      <aces:description>${_esc(item.label)}</aces:description>`);
    if (item.transformId) {
      p(`      <aces:transformId>${_esc(item.transformId)}</aces:transformId>`);
    } else if (item.file) {
      p(`      <aces:file>${_esc(item.file)}</aces:file>`);
    }
    p(`    </aces:lookTransform>`);
  }

  // ── Output Transform ─────────────────────────────────────────────────────
  // Omitted for NONE_RECIPE_ONLY (VFX pull — no output bake)
  if (odt) {
    p(`    <aces:outputTransform applied="false">`);
    p(`      <aces:description>${_esc(odt.label)}</aces:description>`);
    if (odt.transformId) {
      p(`      <aces:transformId>${_esc(odt.transformId)}</aces:transformId>`);
    } else {
      p(`      <aces:file>${_esc(odt.ocioName || '')}</aces:file>`);
    }
    p(`    </aces:outputTransform>`);
  }

  p(`  </aces:pipeline>`);

  // ── Warnings as notes ────────────────────────────────────────────────────
  if (warnings.length > 0) {
    p(`  <aces:notes>`);
    for (const w of warnings) p(`    <aces:note>${_esc(w)}</aces:note>`);
    p(`  </aces:notes>`);
  }

  p(`</aces:acesMetadataFile>`);

  return { ok: true, xml: lines.join('\n'), errors: [], warnings };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function _uuid() {
  // RFC 4122 v4 UUID
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (crypto.getRandomValues(new Uint8Array(1))[0] & 0xff);
    return (c === 'x' ? (r & 0xf) : ((r & 0x3) | 0x8)).toString(16);
  });
}
