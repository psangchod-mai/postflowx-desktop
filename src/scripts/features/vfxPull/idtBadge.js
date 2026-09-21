// scripts/features/vfxPull/idtBadge.js
//
// Pure builder for the VFX Pull job-row IDT badge. Extracted from vfxPullPanel
// so the OCF auto-detect badge logic is unit-testable (vfxPullPanel itself is a
// large DOM-coupled module). 🎬 marks an IDT auto-resolved from OCF metadata
// (ocfIdtResolver); the tooltip carries the full label + any warning.

function _esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Short, badge-sized IDT token from a full label (e.g. 'ARRI LogC3 / AWG3' → 'AWG3'). */
export function idtShortToken(idtName) {
  if (!idtName) return '';
  return String(idtName).split('/').pop().replace(/\s*\(.*?\)\s*/g, '').trim();
}

/**
 * Build the IDT badge HTML for a job's color plan, or '' when there's no IDT.
 * @param {object} colorPlan - { idtName, idtAutoDetected?, idtWarning? }
 * @returns {string} HTML (escaped) or ''
 */
export function buildIdtBadgeHtml(colorPlan) {
  if (!colorPlan || !colorPlan.idtName) return '';
  const idt = idtShortToken(colorPlan.idtName);
  if (!idt) return '';
  const auto = !!colorPlan.idtAutoDetected;
  const title = `IDT: ${_esc(colorPlan.idtName)}`
    + (auto ? ' · auto-detected from OCF' : '')
    + (colorPlan.idtWarning ? ` · ⚠ ${_esc(colorPlan.idtWarning)}` : '');
  const cls = `pm-vfx-pull-badge pm-vfx-pull-badge--color${auto ? ' pm-vfx-pull-badge--auto' : ''}`;
  return `<span class="${cls}" title="${title}">${auto ? '🎬 ' : ''}${_esc(idt.slice(0, 8))}</span>`;
}
