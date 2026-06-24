// scripts/auth/read-only.js — PostFlowX Read-Only Mode
// Applies/removes the read-only body class, badge, and disables mutating controls.
// Exposed as window.PFX_READONLY

window.PFX_READONLY = (() => {
  'use strict';

  const BADGE_ID   = 'pfx-readonly-badge';
  const BODY_CLASS = 'pfx-is-read-only';
  const ATTR       = 'data-pfx-ro';  // marks elements we disabled

  // Controls that should be disabled in read-only mode.
  // Extend this list as new mutating buttons are added to the UI.
  const MUTING_SELECTORS = [
    // Project / file
    '#saveProjectBtn',
    '[data-action="save-project"]',
    // Export
    '#exportBtn',
    '[data-action="export"]',
    '.pm-export-btn',
    // Markers
    '.pm-add-btn',
    '[data-action="add-marker"]',
    '[data-action="delete-marker"]',
    '[data-action="edit-marker"]',
    // Import
    '[data-action="import-media"]',
    '[data-action="import-timeline"]',
    // Render queue add
    '.rq-btn-add',
    // Annotate open button
    '[data-action="annotate"]',
    // Relink
    '[data-action="relink-media"]',
  ].join(',');

  function apply() {
    if (isActive()) return;
    document.body.classList.add(BODY_CLASS);
    _ensureBadge();
    _disableControls();
  }

  function remove() {
    document.body.classList.remove(BODY_CLASS);
    document.getElementById(BADGE_ID)?.remove();
    _enableControls();
  }

  function isActive() {
    return document.body.classList.contains(BODY_CLASS);
  }

  function _ensureBadge() {
    if (document.getElementById(BADGE_ID)) return;
    const b = document.createElement('div');
    b.id        = BADGE_ID;
    b.className = 'pfx-readonly-badge';
    b.title     = 'Read-only — you do not have edit permissions for this project';
    b.textContent = 'Read Only';
    document.body.appendChild(b);
  }

  function _disableControls() {
    try {
      document.querySelectorAll(MUTING_SELECTORS).forEach(el => {
        if (el.disabled || el.dataset.pfxRo) return;
        el.disabled = true;
        el.setAttribute('aria-disabled', 'true');
        el.dataset.pfxRo = '1';
      });
    } catch {}
  }

  function _enableControls() {
    try {
      document.querySelectorAll(`[${ATTR}]`).forEach(el => {
        el.disabled = false;
        el.removeAttribute('aria-disabled');
        el.removeAttribute(ATTR);
      });
    } catch {}
  }

  return { apply, remove, isActive };
})();
