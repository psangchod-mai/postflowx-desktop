// scripts/core/pfxToast.js — the one toast.
//
// WHY THIS EXISTS
// Six places in this renderer tell the user something small and transient —
// "Queued", "VFX marker created", "Exported Excel", "Cannot delete the last
// project". Each wrote its own toast, and three of them routed through a global
// that nothing in the tree ever assigns:
//
//     render_queue.js:1426    window._pmShowToast || window._pfxToast
//     core/shotWorkItems.js   window.pfxToast?.show, then window._showToast
//     features/cutdiff        window.showToast
//
// `grep -rn 'window\.<name> *=' src/` finds no writer for any of those five
// names. This is the phantom-element bug one level up: not a missing element,
// a missing *global*. It fails the same way — `if (typeof fn === 'function')`
// reads absent as "nothing to do", and the branch is skipped in silence.
//
// What it cost, precisely:
//   • shotWorkItems had no second chance. Both its lookups are phantoms, so
//     creating a VFX marker fell through to console.info('[SWI]', msg) — the
//     user got no confirmation at all that the marker existed.
//   • render_queue and cutdiff each had a working local fallback behind the
//     phantom, so they still spoke. Their preferred path was simply dead code.
//
// And a sixth, which is the same mistake made against a stylesheet rather than
// a script: modules/amf_convert.js `__toast()` builds a div with
// class="mps-toast" and toggles `.show` on it. Neither `.mps-toast` nor
// `#mpsToast` appears in any CSS file in src/. So ten messages — including
// "Exported Excel (V5 Template)." and raw upload errors — appended an unstyled
// block of text to the very bottom of a 6,500-line document, where removing
// `.show` did nothing because adding it had done nothing. A phantom class is a
// phantom id wearing a different hat.
//
// So: one implementation, installed on the two names the existing readers
// already look for (`window.pfxToast.show` and `window._pfxToast`), and the
// three misspelled readers corrected to match. The four local implementations
// stay where they are — they work, they are styled, and rewriting them would be
// a rewrite. This is the repair.
//
// DESIGN NOTES — these are for the people using the app, not reading this file
// An error that vanishes after 3.5 seconds has not been reported to anyone who
// has to read it, decide what it means, and act. Errors here do not auto-close;
// they carry a dismiss button and wait. Everything else auto-closes, with the
// duration scaled to how long the message takes to read rather than fixed.
//
// The stack is announced with aria-live so a screen reader hears it at all, and
// errors are marked role="alert" so they interrupt rather than queue.
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  'use strict';

  const STACK_ID = 'pfxToastStack';
  const MAX_VISIBLE = 4;

  // Every severity a caller in this tree currently passes, mapped onto the four
  // the stylesheet actually knows. Anything unrecognised is info — a toast with
  // an odd severity should still be readable, not invisible.
  const KINDS = {
    info: 'info', log: 'info', notice: 'info', '': 'info',
    ok: 'success', done: 'success', success: 'success',
    warn: 'warn', warning: 'warn',
    err: 'error', error: 'error', danger: 'error', fail: 'error',
  };

  function normalizeKind(type) {
    const k = String(type == null ? '' : type).trim().toLowerCase();
    return KINDS[k] || 'info';
  }

  /**
   * How long a message stays up. Reading speed is roughly 200 words/minute for
   * comfortable prose and slower for a notification you did not ask for, so
   * budget generously: a floor of 3.5s plus ~55ms per character, capped at 12s.
   * Errors are exempt — they get no timer at all.
   */
  function dwellMs(msg, kind) {
    if (kind === 'error') return 0;
    const n = String(msg || '').length;
    return Math.min(12000, Math.max(3500, 3500 + n * 55));
  }

  function stack() {
    let el = document.getElementById(STACK_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = STACK_ID;
    el.className = 'pfx-toast-stack';
    // polite, not assertive: most of these are confirmations, and an assertive
    // region interrupts whatever the user is having read to them. Errors opt
    // into interrupting individually, via role="alert" below.
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('aria-atomic', 'false');
    el.setAttribute('role', 'status');
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function dismiss(toast) {
    if (!toast || toast._pfxGone) return;
    toast._pfxGone = true;
    clearTimeout(toast._pfxTimer);
    toast.classList.add('is-leaving');
    // Remove on transitionend, but never trust it to fire — a toast in a hidden
    // tab, or under prefers-reduced-motion with no transition at all, would
    // otherwise stay in the DOM forever.
    setTimeout(() => { try { toast.remove(); } catch (_) {} }, 220);
  }

  function humanize(msg, kind) {
    if (kind !== 'error' && kind !== 'warn') return msg;
    try {
      return window.pfxFriendlyText ? window.pfxFriendlyText(msg) : msg;
    } catch (_) {
      return msg;
    }
  }

  /**
   * @param {string} msg   the text to show; anything else is stringified
   * @param {string} type  info | success | warn | error (aliases in KINDS)
   * @returns {HTMLElement|null} the toast, or null if there was nothing to say
   */
  function show(msg, type) {
    try {
      const kind = normalizeKind(type);
      const text = String(humanize(msg, kind) == null ? '' : humanize(msg, kind)).trim();
      if (!text) return null;

      const host = stack();

      // Repeat suppression. "Already queued: <clip>" fires once per click, and
      // four identical toasts stacked up is noise that hides the one message
      // underneath that differs. Bump a counter instead.
      const last = host.lastElementChild;
      if (last && !last._pfxGone && last._pfxText === text && last._pfxKind === kind) {
        last._pfxCount = (last._pfxCount || 1) + 1;
        const badge = last.querySelector('.pfx-toast-count');
        if (badge) {
          badge.textContent = '×' + last._pfxCount;
          badge.hidden = false;
        }
        clearTimeout(last._pfxTimer);
        const d = dwellMs(text, kind);
        if (d) last._pfxTimer = setTimeout(() => dismiss(last), d);
        return last;
      }

      const toast = document.createElement('div');
      toast.className = 'pfx-toast pfx-toast--' + kind;
      toast._pfxText = text;
      toast._pfxKind = kind;
      toast._pfxCount = 1;
      if (kind === 'error') toast.setAttribute('role', 'alert');

      const body = document.createElement('span');
      body.className = 'pfx-toast-msg';
      body.textContent = text;
      toast.appendChild(body);

      const badge = document.createElement('span');
      badge.className = 'pfx-toast-count';
      badge.hidden = true;
      toast.appendChild(badge);

      // Errors do not time out, so they must be closable or they are a bug of
      // their own. Warnings get the button too — same reasoning, shorter fuse.
      if (kind === 'error' || kind === 'warn') {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'pfx-toast-close';
        close.textContent = '✕';
        close.setAttribute('aria-label', 'Dismiss this message');
        close.addEventListener('click', () => dismiss(toast));
        toast.appendChild(close);
      }

      host.appendChild(toast);

      // Trim to the newest MAX_VISIBLE. Count only the toasts that are not
      // already leaving: dismiss() is deliberately asynchronous — it starts the
      // leave transition and removes the node ~220ms later — so a
      // `while (host.children.length > MAX_VISIBLE)` here never terminates. The
      // node it just dismissed is still a child, the count never drops, and the
      // fifth toast of a session locks the renderer.
      const live = Array.prototype.slice.call(host.children).filter((el) => !el._pfxGone);
      for (let i = 0; i < live.length - MAX_VISIBLE; i++) dismiss(live[i]);

      const d = dwellMs(text, kind);
      if (d) toast._pfxTimer = setTimeout(() => dismiss(toast), d);
      return toast;
    } catch (_) {
      // A notification that throws is strictly worse than one that does not
      // appear: it takes the caller's own work down with it.
      return null;
    }
  }

  function dismissAll() {
    const host = document.getElementById(STACK_ID);
    if (!host) return;
    Array.prototype.slice.call(host.children).forEach(dismiss);
  }

  window.pfxToast = { show, dismissAll };

  // The name render_queue.js already reaches for. Kept as a plain function
  // rather than a second implementation, so there is still only one.
  window._pfxToast = function (msg, type) { return show(msg, type); };
})();
