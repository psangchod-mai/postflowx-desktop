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

  // Why the project is read-only, as project-lease.js reported it. Kept so the
  // badge, its tooltip, and the shortcut toast can all say the same true thing
  // — see core/accessNotice.js for what was wrong with saying one thing.
  let _reason = '';

  function apply(reason) {
    // Not `if (isActive()) return`: apply() is called again when the lease
    // changes hands, and the cause can change with it. Bailing early left the
    // first reason's tooltip on screen for the second reason's situation.
    if (arguments.length) _reason = String(reason == null ? '' : reason);
    document.body.classList.add(BODY_CLASS);
    _ensureBadge();
    _disableControls();
  }

  function remove() {
    _reason = '';
    document.body.classList.remove(BODY_CLASS);
    document.getElementById(BADGE_ID)?.remove();
    _enableControls();
  }

  function isActive() {
    return document.body.classList.contains(BODY_CLASS);
  }

  function reason() {
    return _reason;
  }

  function _notice() {
    // window.PFX_NOTICE comes from core/noticeGlobals.js — this file is a
    // classic script and cannot import it. The fallback is English on purpose:
    // it is only reachable if the module layer failed to load at all, and a
    // badge with no tooltip is worse than a badge with an untranslated one.
    return window.PFX_NOTICE?.readOnlyNotice?.({ reason: _reason })
        || { badge: 'Read Only', title: 'This project cannot be changed right now' };
  }

  function _ensureBadge() {
    const n = _notice();
    let b = document.getElementById(BADGE_ID);
    if (!b) {
      b = document.createElement('div');
      b.id        = BADGE_ID;
      b.className = 'pfx-readonly-badge';
      document.body.appendChild(b);
    }
    // Rewritten every time, not just on create, so a lease handover updates the
    // words instead of leaving the previous cause showing.
    b.title       = n.title;
    b.textContent = n.badge;
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

  return { apply, remove, isActive, reason };
})();
