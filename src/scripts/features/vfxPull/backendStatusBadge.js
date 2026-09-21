// scripts/features/vfxPull/backendStatusBadge.js
//
// Pure classifier for the OCF media-backend status badge (Dev Brief P0#4).
// Maps an OCF preview/extraction result into ONE of five normalized states so
// the user can never mistake a missing-SDK / preview-only frame for a final,
// full-quality decode:
//
//   READY          decoded a real frame with a real decoder → trustworthy
//   PREVIEW_ONLY   a frame, but from a proxy/baked path — not final quality
//   METADATA_ONLY  metadata read, but no decodable frame
//   SDK_MISSING    camera-RAW needs Resolve / a vendor SDK that isn't present
//   UNAVAILABLE    engine not running / nothing could be read
//
// Pure (no DOM) so it is unit-tested directly; the renderer maps `tone` to its
// existing pfx-vfx-vf-{ok,warn,pending} CSS classes.

'use strict';

export const BACKEND_STATUS = {
  READY:         'READY',
  PREVIEW_ONLY:  'PREVIEW_ONLY',
  METADATA_ONLY: 'METADATA_ONLY',
  SDK_MISSING:   'SDK_MISSING',
  UNAVAILABLE:   'UNAVAILABLE',
};

const _META = {
  READY:         { label: 'Ready',         tone: 'ok',      hint: 'Full-quality decode' },
  PREVIEW_ONLY:  { label: 'Preview only',  tone: 'warn',    hint: 'Proxy / baked preview — not a final plate' },
  METADATA_ONLY: { label: 'Metadata only', tone: 'warn',    hint: 'Metadata read, frame not decodable here' },
  SDK_MISSING:   { label: 'SDK missing',   tone: 'warn',    hint: 'Camera-RAW needs DaVinci Resolve or a vendor SDK' },
  UNAVAILABLE:   { label: 'Unavailable',   tone: 'pending', hint: 'No decode engine available' },
};

function _mk(status) {
  const m = _META[status] || _META.UNAVAILABLE;
  return { status, label: m.label, tone: m.tone, hint: m.hint };
}

/**
 * Classify an OCF preview/extraction result.
 * @param {Object} r — { ok, dataUrl, decoder, extractor, backend, requiresResolve,
 *                        resolveAvailable, stage, error, previewOnly, metadataOnly }
 * @returns {{ status:string, label:string, tone:'ok'|'warn'|'pending', hint:string }}
 */
export function classifyBackendStatus(r = {}) {
  const ok               = !!r.ok;
  const hasFrame         = !!r.dataUrl;
  const requiresResolve  = !!r.requiresResolve;
  const resolveAvailable = r.resolveAvailable !== false;   // default true unless explicitly false
  const stage            = String(r.stage || '').toLowerCase();
  const err              = String(r.error || '').toLowerCase();
  const extractor        = String(r.extractor || '').toLowerCase();
  const backend          = String(r.backend || '').toLowerCase();

  if (ok && hasFrame) {
    if (r.previewOnly || extractor === 'proxy' || backend === 'proxy') {
      return _mk(BACKEND_STATUS.PREVIEW_ONLY);
    }
    return _mk(BACKEND_STATUS.READY);
  }
  // Camera-RAW that needs Resolve / a vendor SDK which isn't available.
  if (requiresResolve && !resolveAvailable) return _mk(BACKEND_STATUS.SDK_MISSING);
  // Engine not running / unreachable.
  if (stage === 'connect' || /not running|unavailable|unreachable/.test(err)) {
    return _mk(BACKEND_STATUS.UNAVAILABLE);
  }
  // Metadata read but no decodable frame.
  if (r.metadataOnly || (r.hasMetadata && !hasFrame)) return _mk(BACKEND_STATUS.METADATA_ONLY);
  return _mk(BACKEND_STATUS.UNAVAILABLE);
}

const _esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Build a small badge span. `tone` maps to the caller's CSS scheme via toneClass.
 * @param {Object} classification — output of classifyBackendStatus
 * @param {(tone:string)=>string} [toneClass] — maps tone→css class
 * @returns {string} escaped HTML
 */
export function buildBackendStatusBadgeHtml(classification, toneClass) {
  const c = classification || _mk(BACKEND_STATUS.UNAVAILABLE);
  const cls = typeof toneClass === 'function' ? toneClass(c.tone) : `pfx-backend-${c.tone}`;
  return `<span class="pfx-backend-badge ${_esc(cls)}" title="${_esc(c.hint)}">${_esc(c.label)}</span>`;
}
