// scripts/features/acesLook/services/exportService.js
// Orchestrates all ACES Look export outputs: AMF, CLF skeleton, CDL, summary TXT.

import { buildAmf }               from './amfBuilder.js';
import { validate }               from '../state/acesLookValidation.js';
import { REGISTRY, resolveInputTransform, resolveOutputTransform, ACES_DEFAULT_VERSION } from './transformRegistry.js';
import { MODE_DEFAULTS }          from '../state/acesLookDefaults.js';

function _esc(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _download(filename, content, mimeType = 'text/xml') {
  const blob = new Blob([content], { type: mimeType });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  setTimeout(() => { try { URL.revokeObjectURL(url); } catch {} }, 10_000);
}

function _safeName(state) {
  return (state.clipId || 'postflowx').replace(/[^\w.-]/g, '_');
}

// ── AMF ──────────────────────────────────────────────────────────────────────
export function exportAmf(state) {
  const result = buildAmf(state);
  if (!result.ok) return result;
  _download(`${_safeName(state)}.amf`, result.xml, 'application/xml');
  return { ok: true, warnings: result.warnings };
}

// ── CDL ──────────────────────────────────────────────────────────────────────
export function exportCdl(state) {
  const { errors } = validate(state);
  if (errors.length > 0) return { ok: false, errors };
  if (!state.cdlEnabled) return { ok: false, errors: ['CDL is not enabled.'] };

  const { slope, offset, power, sat } = state.cdl;
  const fmt = v => (Array.isArray(v) ? v.map(n => n.toFixed(6)).join(' ') : Number(v).toFixed(6));
  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ColorDecisionList xmlns="urn:ASC:CDL:v1.2">`,
    `  <ColorDecision>`,
    `    <ColorCorrection id="${_safeName(state)}">`,
    `      <SOPNode>`,
    `        <Slope>${fmt(slope)}</Slope>`,
    `        <Offset>${fmt(offset)}</Offset>`,
    `        <Power>${fmt(power)}</Power>`,
    `      </SOPNode>`,
    `      <SatNode>`,
    `        <Saturation>${fmt(sat)}</Saturation>`,
    `      </SatNode>`,
    `    </ColorCorrection>`,
    `  </ColorDecision>`,
    `</ColorDecisionList>`,
  ].join('\n');

  _download(`${_safeName(state)}.cdl`, xml, 'application/xml');
  return { ok: true };
}

// ── CLF v3 ──────────────────────────────────────────────────────────────────
// Build a valid, self-contained CLF v3 ProcessList encoding the look components
// that are LOSSLESSLY expressible as CLF ProcessNodes:
//   • ASC CDL → exact <ASC_CDL> node (the high-value case).
//   • Look-stack items with a file → <Reference path="…"> (CLF v3 external ref).
//   • IDT/ODT (ACES transforms) → NOT baked. The ACES 2.0 Output Transform is
//     non-invertible as a 3D-LUT per spec, so we document the transformId in
//     <Info> + return a warning rather than emit a CLF that lies about it.
// Returns { ok, xml?, warnings, errors? } — pure; exportClf wraps it w/ download.
export function buildClf(state) {
  const { errors, warnings } = validate(state);
  if (errors.length > 0) return { ok: false, errors, warnings };

  const acesVersion = state.acesVersion || ACES_DEFAULT_VERSION;
  const idt = resolveInputTransform(state.inputTransform, { acesVersion });
  const odt = resolveOutputTransform(state.outputTransform, { acesVersion });
  const clfWarnings = [...warnings];
  const nodes = [];
  const f3 = (v) => v.map((n) => Number(n).toFixed(6)).join(' ');

  // 1) ASC CDL — exact, lossless.
  if (state.cdlEnabled && state.cdl) {
    const { slope, offset, power, sat } = state.cdl;
    nodes.push([
      `  <ASC_CDL id="cdl0" inBitDepth="32f" outBitDepth="32f" style="v1.2_Rev1_SOP_SAT">`,
      `    <SOPNode>`,
      `      <Slope>${f3(slope)}</Slope>`,
      `      <Offset>${f3(offset)}</Offset>`,
      `      <Power>${f3(power)}</Power>`,
      `    </SOPNode>`,
      `    <SatNode>`,
      `      <Saturation>${Number(sat).toFixed(6)}</Saturation>`,
      `    </SatNode>`,
      `  </ASC_CDL>`,
    ].join('\n'));
  }

  // 2) Look-stack file references → <Reference>. transform-id-only looks can't
  //    be baked → warn.
  for (const item of state.lookStack || []) {
    if (!item.enabled) continue;
    if (item.file) {
      nodes.push(`  <Reference id="${_esc(item.label || 'look')}" inBitDepth="32f" outBitDepth="32f" path="${_esc(item.file)}"/>`);
    } else if (item.transformId) {
      clfWarnings.push(`Look "${item.label}" references ACES transform ${item.transformId}; apply it in an ACES-aware app (not baked into CLF).`);
    }
  }

  // 3) IDT/ODT — documented, never baked.
  const info = [];
  if (idt?.transformId) info.push(`Input transform (apply upstream in an ACES-aware app): ${idt.transformId}`);
  if (odt?.transformId) {
    info.push(`Output transform (apply downstream; NOT baked — ACES Output Transform is non-invertible as a LUT): ${odt.transformId}`);
    clfWarnings.push(`Output Transform "${odt.label}" is documented but omitted from the CLF — baking an ACES Output Transform into a LUT is non-invertible per the ACES 2.0 spec. Apply it in an ACES-aware app.`);
  }
  if (!nodes.length) clfWarnings.push('No losslessly-expressible look components — CLF carries metadata only.');

  const inDesc = idt?.label || state.inputTransform || 'input';
  const xml = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ProcessList xmlns="urn:AMPAS:CLF:v3.0" compCLFversion="3" id="${_esc(_safeName(state))}" name="PostFlowX ACES Look">`,
    `  <Info>`,
    `    <Description>PostFlowX ACES Look — ${_esc(state.mode || '')}</Description>`,
    `    <InputDescriptor>${_esc(inDesc)}</InputDescriptor>`,
    `    <OutputDescriptor>ACES2065-1</OutputDescriptor>`,
    ...info.map((c) => `    <Comment>${_esc(c)}</Comment>`),
    `  </Info>`,
    ...nodes,
    `</ProcessList>`,
  ].join('\n');

  return { ok: true, xml, warnings: clfWarnings };
}

export function exportClf(state) {
  const r = buildClf(state);
  if (!r.ok) return r;
  _download(`${_safeName(state)}.clf`, r.xml, 'application/xml');
  return { ok: true, warnings: r.warnings };
}

// ── Summary TXT ──────────────────────────────────────────────────────────────
export function exportSummary(state) {
  const { errors, warnings } = validate(state);
  const modeInfo = MODE_DEFAULTS[state.mode] || {};
  const idt      = REGISTRY.inputTransforms[state.inputTransform] || {};
  const odt      = REGISTRY.outputTransforms[state.outputTransform] || {};
  const safe     = _safeName(state);
  const now      = new Date();
  const ts       = `${now.getFullYear()}-${_pad(now.getMonth()+1)}-${_pad(now.getDate())}  ${_pad(now.getHours())}:${_pad(now.getMinutes())}`;
  const HR       = '─'.repeat(60);
  const HDR      = '═'.repeat(60);

  const pc = state.primaryControls || {};
  const expSign = pc.exposure >= 0 ? '+' : '';

  const lines = [
    HDR,
    '  PostFlowX — ACES Look  Color Handoff Note',
    HDR,
    '',
    `  Generated : ${ts}`,
    `  Clip ID   : ${state.clipId || '(not set)'}`,
    `  Source    : ${state.source?.name || '(no file)'}`,
    '',
    HR,
    '  WORKFLOW INTENT',
    HR,
    `  Mode      : ${modeInfo.displayLabel || state.mode}`,
    `  Intent    : ${modeInfo.description  || ''}`,
    '',
    HR,
    '  COLOR PIPELINE',
    HR,
    `  Input     : ${idt.label || state.inputTransform}`,
  ];

  if (idt.transformId) {
    lines.push(`              ${idt.transformId}`);
  } else if (idt.note) {
    lines.push(`              (${idt.note})`);
  }

  lines.push(
    `  Working   : ${state.workingLocation}`,
    `  Output    : ${odt.label || 'None (recipe only — no output bake)'}`,
  );
  if (odt.transformId) lines.push(`              ${odt.transformId}`);

  lines.push(
    '',
    HR,
    '  PRIMARY ADJUSTMENTS',
    HR,
    `  Exposure    : ${expSign}${Number(pc.exposure    ?? 0).toFixed(2)} EV`,
    `  Contrast    : ${Number(pc.contrast    ?? 1).toFixed(2)}×`,
    `  Saturation  : ${Number(pc.saturation  ?? 1).toFixed(2)}×`,
    `  Temperature : ${pc.temperature >= 0 ? '+' : ''}${Number(pc.temperature ?? 0).toFixed(0)}`,
  );

  if (state.cdlEnabled) {
    const { slope, offset, power, sat } = state.cdl;
    const v3 = (v) => Array.isArray(v)
      ? `R ${v[0].toFixed(4)}  G ${v[1].toFixed(4)}  B ${v[2].toFixed(4)}`
      : Number(v).toFixed(4);
    lines.push(
      '',
      HR,
      '  CDL  (Applied)',
      HR,
      `  Slope       : ${v3(slope)}`,
      `  Offset      : ${v3(offset)}`,
      `  Power       : ${v3(power)}`,
      `  Saturation  : ${Number(sat).toFixed(4)}`,
    );
  }

  if ((state.lookStack || []).length > 0) {
    lines.push('', HR, '  LOOK STACK', HR);
    state.lookStack.forEach((l, i) => {
      const status = l.enabled ? 'ACTIVE' : 'SKIP ';
      const ref    = l.transformId ? `  id: ${l.transformId}` : l.file ? `  file: ${l.file}` : '';
      lines.push(`  ${i + 1}.  [${status}]  ${l.label}  (${l.kind})${ref}`);
    });
  }

  if (warnings.length > 0) {
    lines.push('', HR, '  WARNINGS', HR);
    warnings.forEach(w => lines.push(`  ⚠  ${w}`));
  }

  if (errors.length > 0) {
    lines.push('', HR, '  ERRORS  (export may be blocked)', HR);
    errors.forEach(e => lines.push(`  ✗  ${e}`));
  }

  lines.push(
    '',
    HR,
    '  DOWNSTREAM HANDOFF',
    HR,
    '  DaVinci Resolve :  Color menu → ACES → Load AMF → select .amf file',
    '  Baselight       :  Formats → ACES Metadata File → Import',
    '',
    '  Export files:',
    `    ${safe}.amf        — primary ACES handoff (AMF)`,
    `    ${safe}.cdl        — CDL values only${state.cdlEnabled ? '' : '  (CDL not enabled)'}`,
    `    ${safe}.clf        — CLF skeleton  (fill in ProcessNodes before use)`,
    '',
    HDR,
    '  Generated by PostFlowX ACES Look',
    HDR,
  );

  _download(`${safe}_summary.txt`, lines.join('\n'), 'text/plain');
  return { ok: true };
}

function _pad(n) { return String(n).padStart(2, '0'); }
