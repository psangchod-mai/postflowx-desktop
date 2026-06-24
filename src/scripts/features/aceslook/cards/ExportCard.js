// scripts/features/acesLook/cards/ExportCard.js

import { exportAmf, exportCdl, exportClf, exportSummary } from '../services/exportService.js';
import { setExportResult, setClipId }                      from '../state/acesLookStore.js';

// Action → permission key mapping (plan E2)
const _ACTION_KEYS = {
  amf:     'export_amf',
  cdl:     'export_cdl',
  clf:     'export_clf',
  summary: 'export_color_summary',
};

function _can(actionId) {
  const p = window.PFX_PERMISSIONS;
  if (!p) return true; // no permission layer → allow
  return p.canDoAction(actionId);
}

function _denied(actionId) {
  window.pfxPolicyApi?.logEvent({
    event:     'export_denied',
    action:    actionId,
    timestamp: new Date().toISOString(),
  });
  window.pfxNoAccessView?.showDeniedToast(actionId);
}

export function renderExportCard(container, state) {
  const hasErrors = state.errors?.length > 0;

  // Resolve per-button permission so we can show disabled state
  const canAmf     = _can('export_amf');
  const canCdl     = _can('export_cdl');
  const canClf     = _can('export_clf');
  const canSummary = _can('export_color_summary');

  const _noPermTitle = 'You don\'t have permission for this export';

  container.innerHTML = `
    <div class="al-card" id="al-export-card">
      <div class="al-card-header">Export</div>
      <div class="al-card-body">
        <label class="al-label" for="al-clip-id">Clip ID</label>
        <input type="text" class="al-input" id="al-clip-id"
               placeholder="e.g. A001C001" value="${_esc(state.clipId || '')}">

        <div class="al-export-btns">
          <button class="al-btn al-btn--primary" id="al-export-amf"
                  ${!canAmf || hasErrors ? 'disabled' : ''}
                  title="${!canAmf ? _noPermTitle : hasErrors ? 'Fix errors before exporting' : ''}">
            Export AMF${!canAmf ? ' 🔒' : ''}
          </button>
          <button class="al-btn" id="al-export-cdl"
                  ${!canCdl || !state.cdlEnabled || hasErrors ? 'disabled' : ''}
                  title="${!canCdl ? _noPermTitle : ''}">
            Export CDL${!canCdl ? ' 🔒' : ''}
          </button>
          <button class="al-btn" id="al-export-clf"
                  ${!canClf || hasErrors ? 'disabled' : ''}
                  title="${!canClf ? _noPermTitle : ''}">
            Export CLF${!canClf ? ' 🔒' : ''}
          </button>
          <button class="al-btn" id="al-export-summary"
                  ${!canSummary ? 'disabled' : ''}
                  title="${!canSummary ? _noPermTitle : ''}">
            Export Summary${!canSummary ? ' 🔒' : ''}
          </button>
        </div>

        ${state.exportResult ? `
          <div class="al-export-result al-export-result--${state.exportResult.ok ? 'ok' : 'err'}">
            ${state.exportResult.ok
              ? `✓ Exported${state.exportResult.warnings?.length ? ` (${state.exportResult.warnings.length} warning${state.exportResult.warnings.length > 1 ? 's' : ''})` : ''}`
              : `✗ ${(state.exportResult.errors || []).join('; ')}`
            }
          </div>
        ` : ''}
      </div>
    </div>
  `;

  container.querySelector('#al-clip-id').addEventListener('input', e => setClipId(e.target.value));

  container.querySelector('#al-export-amf').addEventListener('click', () => {
    if (!_can('export_amf')) { _denied('export_amf'); return; }
    setExportResult(exportAmf(state));
  });

  container.querySelector('#al-export-cdl').addEventListener('click', () => {
    if (!_can('export_cdl')) { _denied('export_cdl'); return; }
    setExportResult(exportCdl(state));
  });

  container.querySelector('#al-export-clf').addEventListener('click', () => {
    if (!_can('export_clf')) { _denied('export_clf'); return; }
    setExportResult(exportClf(state));
  });

  container.querySelector('#al-export-summary').addEventListener('click', () => {
    if (!_can('export_color_summary')) { _denied('export_color_summary'); return; }
    setExportResult(exportSummary(state));
  });
}

function _esc(s) {
  return String(s || '').replace(/"/g, '&quot;');
}
