// scripts/auth/guarded-action.js — PostFlowX Action Guard
// guardedAction(actionId, fn, label?) wraps any function with a permission check.
// Shows a non-blocking toast on denial.
// Exposed as window.PFX_GUARD

window.PFX_GUARD = (() => {
  'use strict';

  const TOAST_ID = 'pfx-guard-toast';
  let _timer = null;

  function toast(msg, type = 'deny') {
    clearTimeout(_timer);
    let el = document.getElementById(TOAST_ID);
    if (!el) {
      el = document.createElement('div');
      el.id = TOAST_ID;
      el.className = 'pfx-guard-toast';
      el.setAttribute('role', 'status');
      el.setAttribute('aria-live', 'polite');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.dataset.type = type;
    el.classList.add('pfx-guard-toast--on');
    _timer = setTimeout(() => el.classList.remove('pfx-guard-toast--on'), 3500);
  }

  /**
   * Run fn() only if user has permission for actionId.
   * @param {string}   actionId  - canonical action ID (e.g. 'save_project')
   * @param {Function} fn        - async or sync function to run
   * @param {string}   [label]   - human-readable name shown in toast
   * @returns {Promise<any>}     - fn() result, or undefined if denied
   */
  async function guardedAction(actionId, fn, label) {
    if (window.PFX_PERMISSIONS && !window.PFX_PERMISSIONS.canDoAction(actionId)) {
      const ro  = window.PFX_PERMISSIONS.isReadOnly();
      const who = label || actionId;
      toast(
        ro ? `Read-only mode — "${who}" not allowed` : `Permission denied — "${who}"`,
        'deny'
      );
      console.warn(`[PFX Guard] Blocked action: ${actionId}`);
      return undefined;
    }
    return typeof fn === 'function' ? fn() : undefined;
  }

  return { guardedAction, toast };
})();
