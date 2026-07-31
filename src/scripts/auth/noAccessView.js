// scripts/auth/noAccessView.js
// Renders the "you cannot open this" state into any container element.
// Used when canAccessTab() or canDoAction() is false for a protected area.
//
// The words all come from core/accessNotice.js — see that file for why they
// changed. This one only draws them, which is the split that lets the wording
// be unit-tested and the translations be enforced by errorI18n.test.mjs.
//
// Loaded as a module (index.html) so it can import; it still publishes
// window.pfxNoAccessView, because both callers reach it through the global.

import { accessNotice, deniedActionNotice } from '../core/accessNotice.js';

const _ICON_LOCK = `<svg aria-hidden="true" focusable="false" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

// Nothing here is attacker-controlled today, but every value below is a
// translated sentence, a workspace name that falls back to a raw `data-main`
// attribute read off the DOM, or a contact address a caller supplies — none of
// which this file gets to assume are HTML-safe.
function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Render a no-access card into `container`.
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string} [opts.status]  — 'pending' | 'disabled' | 'denied'  (default: 'denied')
 * @param {string} [opts.key]     — the workspace's `data-main` key, e.g. 'platelink2'.
 *                                  The name is looked up, never passed in: a caller
 *                                  that spelled it itself is how this panel came to
 *                                  say "ACES Look" about the tab marked ACES LOOK.
 * @param {string} [opts.contact] — override contact email
 */
function renderNoAccess(container, { status = 'denied', key = '', contact = '' } = {}) {
  if (!container) return;
  const n = accessNotice({ status, key, contact });

  // role=status + aria-live: this replaces a whole pane in place, with no
  // navigation and no focus change, so a screen-reader user would otherwise be
  // told nothing at all about why the workspace they opened is now a lock icon.
  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:320px;background:#111215;">
      <div role="status" aria-live="polite" style="text-align:center;max-width:360px;padding:32px 24px;background:#1a1b1f;border:1px solid #2a2b30;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5)">
        <div style="color:#3a3b42;margin-bottom:16px">${_ICON_LOCK}</div>
        ${n.name ? `<span class="nav-badge" style="font-size:11px;background:#222;border:1px solid #333;padding:2px 8px;border-radius:3px;color:#8a8c90;margin-top:4px;display:inline-block">${_esc(n.name)}</span>` : ''}
        <h2 style="font-size:15px;font-weight:700;color:#c8cacd;margin:12px 0 8px">${_esc(n.heading)}</h2>
        <p style="font-size:12px;color:#6c6e72;line-height:1.6;margin:0 0 20px">${_esc(n.body)}</p>
        <div style="font-size:11px;color:#4a4b54">
          ${_esc(n.contactLabel)}<br>
          <a href="mailto:${_esc(n.contact)}" style="color:#5a8de0;text-decoration:none">${_esc(n.contact)}</a>
        </div>
        ${n.reloadLabel ? `
          <div style="margin-top:16px;padding:8px 12px;background:#111215;border-radius:4px;font-size:11px;color:#6c6e72;border:1px solid #222">
            ${_esc(n.hint)}
            <div style="margin-top:8px">
              <button type="button" data-pfx-noaccess-reload style="font:inherit;color:#c8cacd;background:#24252b;border:1px solid #35363d;border-radius:4px;padding:5px 12px;cursor:pointer">${_esc(n.reloadLabel)}</button>
            </div>
          </div>
        ` : ''}
      </div>
    </div>
  `;

  // The old copy told the user to reload and left them to work out that it
  // meant ⌘R. Wired here rather than inline so the markup stays free of
  // handlers the CSP and the XSS gate would both have to reason about.
  container.querySelector('[data-pfx-noaccess-reload]')
    ?.addEventListener('click', () => { try { location.reload(); } catch {} });
}

/**
 * Show a transient toast for action-level blocks.
 * Appends to document.body, auto-removes after 3s.
 * @param {string} actionId — the blocked action key
 */
function showDeniedToast(actionId) {
  const existing = document.getElementById('pfx-denied-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'pfx-denied-toast';
  toast.setAttribute('role', 'status');
  toast.style.cssText = [
    'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
    'background:#3a1010', 'color:#c06060', 'border:1px solid #5a2020',
    'border-radius:6px', 'padding:8px 16px', 'font-size:12px',
    'z-index:99999', 'pointer-events:none',
    'box-shadow:0 4px 16px rgba(0,0,0,.5)',
    'animation:pfx-toast-in .15s ease',
    // The workspace wording is two sentences on two lines; textContent keeps the
    // newline but the default white-space collapses it into one run-on line.
    'white-space:pre-line', 'text-align:center', 'max-width:min(90vw,420px)',
  ].join(';');

  // textContent, so the text needs no escaping — and must not grow into markup.
  // The id goes in raw: naming it is core/accessNotice.js's job, because that
  // is where errorI18n.test.mjs can see the names and hold them to six locales.
  toast.textContent = deniedActionNotice({ id: actionId }).text;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

// The 22-entry action-name table that used to live here is now
// core/accessNotice.js's actionName(), where it is written as translate()
// literals and therefore scanned into all six locales. Resolving it here meant
// passing a variable to the notice, which the scanner cannot see.

window.pfxNoAccessView = { renderNoAccess, showDeniedToast };
