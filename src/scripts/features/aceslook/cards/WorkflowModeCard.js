// scripts/features/acesLook/cards/WorkflowModeCard.js

import { setMode }      from '../state/acesLookStore.js';
import { MODE_DEFAULTS } from '../state/acesLookDefaults.js';

const MODES = Object.entries(MODE_DEFAULTS).map(([key, d]) => ({ key, label: d.displayLabel, desc: d.description }));

export function renderWorkflowModeCard(container, state) {
  container.innerHTML = `
    <div class="al-card" id="al-mode-card">
      <div class="al-card-header">Workflow Mode</div>
      <div class="al-card-body">
        <select class="al-select" id="al-mode-select" aria-label="Workflow mode">
          ${MODES.map(m => `
            <option value="${m.key}" ${state.mode === m.key ? 'selected' : ''}>${m.label}</option>
          `).join('')}
        </select>
        <div class="al-mode-desc" id="al-mode-desc">
          ${MODE_DEFAULTS[state.mode]?.description || ''}
        </div>
      </div>
    </div>
  `;

  container.querySelector('#al-mode-select').addEventListener('change', e => {
    setMode(e.target.value);
  });
}
