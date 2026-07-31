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
   * The words for a refusal, translated, from core/accessNotice.js.
   *
   * This file is a classic <script> (src/index.html) and cannot import, so the
   * builders arrive on window from core/noticeGlobals.js. The fallback string
   * is English on purpose: it is only reachable if the module layer never
   * loaded, and a refusal the user cannot read still beats a click that
   * silently does nothing.
   *
   * @param {string} actionId
   * @returns {string}
   */
  function denyText(actionId) {
    const readOnly = !!window.PFX_READONLY?.isActive?.()
                  || !!window.PFX_PERMISSIONS?.isReadOnly?.();
    const n = window.PFX_NOTICE?.guardNotice?.({
      actionId,
      readOnly,
      reason: window.PFX_READONLY?.reason?.(),
    });
    return n?.text || 'Your account cannot do this';
  }

  /**
   * Show the refusal toast for a blocked action id.
   *
   * The whole point of the entry point: a call site names the *action*, never
   * the sentence. Ten call sites used to pass their own English — five of them
   * printing the permission key — because writing a sentence was the only
   * thing toast() offered them.
   *
   * @param {string} actionId
   */
  function deny(actionId) {
    toast(denyText(actionId), 'deny');
  }

  /**
   * Run fn() only if user has permission for actionId.
   * @param {string}   actionId  - canonical action ID (e.g. 'save_project')
   * @param {Function} fn        - async or sync function to run
   * @param {string}   [label]   - ignored; see below
   * @returns {Promise<any>}     - fn() result, or undefined if denied
   */
  async function guardedAction(actionId, fn, label) {  // eslint-disable-line no-unused-vars
    if (window.PFX_PERMISSIONS && !window.PFX_PERMISSIONS.canDoAction(actionId)) {
      // `label` used to be interpolated into the toast, and every caller that
      // omitted it printed the raw permission key at the user — the shape of
      // `Permission denied — "import_timeline"`. The name now comes from the
      // one table that has an entry for every blockable id and a test holding
      // it complete, so the argument is accepted and unused rather than being
      // a trap for the next caller.
      deny(actionId);
      console.warn(`[PFX Guard] Blocked action: ${actionId}`);
      return undefined;
    }
    return typeof fn === 'function' ? fn() : undefined;
  }

  return { guardedAction, toast, deny, denyText };
})();
