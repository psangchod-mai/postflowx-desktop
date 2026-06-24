// scripts/auth/noAccessView.js
// Renders a friendly "no access" state into any container element.
// Used when canAccessTab() or canDoAction() is false for a protected area.

const _ICON_LOCK = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

const _STATUS_MESSAGES = {
  pending:  { heading: 'Access Pending',    body: 'Your account is registered but not yet approved. You will receive an email when access is granted.' },
  disabled: { heading: 'Access Disabled',   body: 'Your account has been disabled. Contact your PostFlowX admin for assistance.' },
  denied:   { heading: 'Access Restricted', body: 'You don\'t have permission to access this feature with your current role.' },
};

/**
 * Render a no-access card into `container`.
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string} [opts.status]  — 'pending' | 'disabled' | 'denied'  (default: 'denied')
 * @param {string} [opts.feature] — human label for what was blocked (e.g. "ACES Look")
 * @param {string} [opts.contact] — override contact email
 */
function renderNoAccess(container, { status = 'denied', feature = '', contact = 'sangchod@netflix.com' } = {}) {
  if (!container) return;
  const msg = _STATUS_MESSAGES[status] || _STATUS_MESSAGES.denied;
  const featureLabel = feature ? `<span class="nav-badge" style="font-size:11px;background:#222;border:1px solid #333;padding:2px 8px;border-radius:3px;color:#8a8c90;margin-top:4px;display:inline-block">${feature}</span>` : '';

  container.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:320px;background:#111215;">
      <div style="text-align:center;max-width:360px;padding:32px 24px;background:#1a1b1f;border:1px solid #2a2b30;border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.5)">
        <div style="color:#3a3b42;margin-bottom:16px">${_ICON_LOCK}</div>
        ${featureLabel}
        <h2 style="font-size:15px;font-weight:700;color:#c8cacd;margin:12px 0 8px">${msg.heading}</h2>
        <p style="font-size:12px;color:#6c6e72;line-height:1.6;margin:0 0 20px">${msg.body}</p>
        <div style="font-size:11px;color:#4a4b54">
          For access requests, contact<br>
          <a href="mailto:${contact}" style="color:#5a8de0;text-decoration:none">${contact}</a>
        </div>
        ${status === 'pending' ? `
          <div style="margin-top:16px;padding:8px 12px;background:#111215;border-radius:4px;font-size:11px;color:#6c6e72;border:1px solid #222">
            Already approved? Reload PostFlowX to refresh your session.
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

/**
 * Show a transient "permission denied" toast for action-level blocks.
 * Appends to document.body, auto-removes after 3s.
 * @param {string} actionId — the blocked action key
 */
function showDeniedToast(actionId) {
  const existing = document.getElementById('pfx-denied-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'pfx-denied-toast';
  toast.style.cssText = [
    'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
    'background:#3a1010', 'color:#c06060', 'border:1px solid #5a2020',
    'border-radius:6px', 'padding:8px 16px', 'font-size:12px',
    'z-index:99999', 'pointer-events:none',
    'box-shadow:0 4px 16px rgba(0,0,0,.5)',
    'animation:pfx-toast-in .15s ease',
  ].join(';');

  const label = _actionLabel(actionId);
  toast.textContent = `⊘ Permission denied: ${label}`;
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
  return map[actionId] || actionId;
}

window.pfxNoAccessView = { renderNoAccess, showDeniedToast };
