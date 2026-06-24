// features/vfxPull/ascFdl.js
// ASC Framing Decision List (FDL) v2.0 writer — the standard Netflix tooling
// ingests, replacing PostFlowX's proprietary `postflowx.vfxpull.fdl.v1`.
//
// Structure follows the ASC FDL spec (framing_intents + contexts→canvases→
// framing_decisions). Framing decisions are computed PIXEL-ACCURATELY from the
// source canvas + intent aspect ratio (the Netflix calculator stresses pixel
// accuracy). Pure (no DOM); JSON only.
//
// NOTE: the exact `version` object the v2.0 `.fdl` files carry must be confirmed
// against a real Netflix-exported sample (file-format version vs the spec "2.0"
// naming differ). Until a sample is committed, we emit a documented default and
// the byte-parity test is skipped — see test/color/fdl.test.mjs.
'use strict';

export const ASC_FDL_VERSION = { major: 1, minor: 0 }; // TODO: confirm vs real Netflix .fdl sample

function _uuid() {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
  // deterministic-ish fallback (tests pass uuid explicitly)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Compute a pixel-accurate framing decision rectangle for an intent inside a
 * source canvas. Centers the rectangle; `protection` (0..1) insets all edges.
 * @returns {{ dimensions:{width,height}, anchor_point:{x,y} }}
 */
export function computeFramingDecision({ canvasWidth, canvasHeight, aspectWidth, aspectHeight, protection = 0, anamorphicSqueeze = 1 }) {
  const cw = Math.max(1, Math.round(canvasWidth));
  const ch = Math.max(1, Math.round(canvasHeight));
  // De-squeeze the canvas horizontally to reason in display aspect, then re-apply.
  const displayW = cw * (anamorphicSqueeze || 1);
  const canvasAR = displayW / ch;
  const intentAR = aspectWidth / aspectHeight;

  let dw, dh;
  if (intentAR >= canvasAR) {
    // width-limited (pillar/full width): fit to canvas width
    dw = cw;
    dh = Math.round((cw * (anamorphicSqueeze || 1)) / intentAR);
  } else {
    // height-limited (letterbox): fit to canvas height
    dh = ch;
    dw = Math.round((ch * intentAR) / (anamorphicSqueeze || 1));
  }
  // Apply symmetric protection inset.
  const p = Math.max(0, Math.min(0.49, Number(protection) || 0));
  if (p > 0) { dw = Math.round(dw * (1 - 2 * p)); dh = Math.round(dh * (1 - 2 * p)); }
  dw = Math.min(dw, cw); dh = Math.min(dh, ch);
  // Center → anchor in pixels from top-left.
  const ax = Math.round((cw - dw) / 2);
  const ay = Math.round((ch - dh) / 2);
  return { dimensions: { width: dw, height: dh }, anchor_point: { x: ax, y: ay } };
}

/**
 * Build an ASC FDL v2.0 document object.
 * @param {object} params
 *   uuid?, fdlCreator?
 *   canvas: { id, label, width, height, anamorphicSqueeze? }
 *   framingIntents: [{ id, label, aspectWidth, aspectHeight, protection? }]
 *   contextLabel?
 */
export function buildAscFdl(params = {}) {
  const canvas = params.canvas || {};
  const intents = Array.isArray(params.framingIntents) ? params.framingIntents : [];
  const squeeze = canvas.anamorphicSqueeze || 1;

  const framing_intents = intents.map((fi) => ({
    id: fi.id,
    label: fi.label || fi.id,
    aspect_ratio: { width: Math.round(fi.aspectWidth), height: Math.round(fi.aspectHeight) },
    protection: Number(fi.protection) || 0,
  }));

  const framing_decisions = intents.map((fi) => {
    const fd = computeFramingDecision({
      canvasWidth: canvas.width, canvasHeight: canvas.height,
      aspectWidth: fi.aspectWidth, aspectHeight: fi.aspectHeight,
      protection: fi.protection, anamorphicSqueeze: squeeze,
    });
    return {
      id: `${canvas.id || 'cnv'}-${fi.id}`,
      label: fi.label || fi.id,
      framing_intent_id: fi.id,
      dimensions: fd.dimensions,
      anchor_point: fd.anchor_point,
    };
  });

  const canvasObj = {
    id: canvas.id || 'cnv0',
    label: canvas.label || 'Source Canvas',
    source_canvas_id: canvas.id || 'cnv0',
    dimensions: { width: Math.round(canvas.width), height: Math.round(canvas.height) },
    effective_dimensions: { width: Math.round(canvas.width), height: Math.round(canvas.height) },
    effective_anchor_point: { x: 0, y: 0 },
    anamorphic_squeeze: squeeze,
    framing_decisions,
  };

  return {
    uuid: params.uuid || _uuid(),
    version: { ...ASC_FDL_VERSION },
    fdl_creator: params.fdlCreator || 'PostFlowX',
    default_framing_intent: framing_intents[0] ? framing_intents[0].id : null,
    framing_intents,
    contexts: [
      { label: params.contextLabel || 'PostFlowX VFX Pull', context_creator: 'PostFlowX', canvases: [canvasObj] },
    ],
  };
}

export function buildAscFdlJson(obj) {
  return JSON.stringify(obj, null, 2);
}

// ── Hand-rolled structural validator (no heavy deps) ────────────────────────
// Mirrors assets/fdl/asc_fdl_v2.schema.json. Returns { ok, errors }.
export function validateAscFdl(doc) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  const isDim = (d) => isObj(d) && Number.isInteger(d.width) && Number.isInteger(d.height) && d.width > 0 && d.height > 0;
  const isPt = (p) => isObj(p) && Number.isFinite(p.x) && Number.isFinite(p.y);

  req(isObj(doc), 'root must be an object');
  if (!isObj(doc)) return { ok: false, errors };
  req(typeof doc.uuid === 'string' && doc.uuid.length > 0, 'uuid required');
  req(isObj(doc.version) && Number.isInteger(doc.version.major) && Number.isInteger(doc.version.minor), 'version {major,minor} required');
  req(Array.isArray(doc.framing_intents) && doc.framing_intents.length > 0, 'framing_intents[] required');
  for (const fi of doc.framing_intents || []) {
    req(typeof fi.id === 'string' && fi.id, 'framing_intent.id required');
    req(isObj(fi.aspect_ratio) && fi.aspect_ratio.width > 0 && fi.aspect_ratio.height > 0, `framing_intent "${fi.id}" aspect_ratio invalid`);
  }
  req(Array.isArray(doc.contexts) && doc.contexts.length > 0, 'contexts[] required');
  for (const ctx of doc.contexts || []) {
    req(Array.isArray(ctx.canvases) && ctx.canvases.length > 0, 'context.canvases[] required');
    for (const cv of ctx.canvases || []) {
      req(typeof cv.id === 'string' && cv.id, 'canvas.id required');
      req(isDim(cv.dimensions), `canvas "${cv.id}" dimensions invalid`);
      req(Array.isArray(cv.framing_decisions), `canvas "${cv.id}" framing_decisions[] required`);
      for (const fd of cv.framing_decisions || []) {
        req(typeof fd.id === 'string' && fd.id, 'framing_decision.id required');
        req(typeof fd.framing_intent_id === 'string', `framing_decision "${fd.id}" framing_intent_id required`);
        req(isDim(fd.dimensions), `framing_decision "${fd.id}" dimensions invalid`);
        req(isPt(fd.anchor_point), `framing_decision "${fd.id}" anchor_point invalid`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
