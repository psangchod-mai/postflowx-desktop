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
  ].join(';');

  // textContent, so the label needs no escaping — and must not grow into markup.
  toast.textContent = deniedActionNotice({ label: _actionLabel(actionId) }).text;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

function _actionLabel(actionId) {
  const map = {
    open_project:         'Open Project',
    save_project:         'Save Project',
    load_timeline:        'Load Timeline',
    load_video:           'Load Video',
    view_markers:         'View Markers',
    add_marker:           'Add Marker',
    edit_marker_meta:     'Edit Marker Metadata',
    delete_marker:        'Delete Marker',
    open_annotation:      'Open Annotation',
    edit_annotation:      'Edit Annotation',
    export_csv:           'Export CSV',
    export_pdf:           'Export PDF',
    export_xlsx:          'Export XLSX',
    export_package:       'Export Package',
    relink_all:           'Relink All',
    export_amf:           'Export AMF',
    export_cdl:           'Export CDL',
    export_clf:           'Export CLF',
    export_color_summary: 'Export Summary',
    save_aces_preset:     'Save Preset',
    load_aces_preset:     'Load Preset',
    open_aces_look:       'Open ACES Look',
  };
  // hasOwn, not a plain lookup: actionId reaches here from call sites all over
  // the renderer, and `constructor` would otherwise resolve up the prototype
  // chain and put a function body in the toast.
  return Object.hasOwn(map, actionId) ? map[actionId] : String(actionId ?? '');
}

window.pfxNoAccessView = { renderNoAccess, showDeniedToast };
