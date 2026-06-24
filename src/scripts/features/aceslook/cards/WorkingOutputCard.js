// scripts/features/acesLook/cards/WorkingOutputCard.js

import { setWorkingLocation, setOutputTransform, patch } from '../state/acesLookStore.js';
import { REGISTRY }                                       from '../services/transformRegistry.js';
import { WORKING_LOCATIONS }                              from '../state/acesLookDefaults.js';

const OUTPUT_KEYS = Object.keys(REGISTRY.outputTransforms);

export function renderWorkingOutputCard(container, state) {
  container.innerHTML = `
    <div class="al-card" id="al-working-card">
      <div class="al-card-header">Working Space & Output</div>
      <div class="al-card-body">
        <label class="al-label" for="al-working-select">Working Location</label>
        <select class="al-select" id="al-working-select" aria-label="Working location">
          ${WORKING_LOCATIONS.map(l => `
            <option value="${l}" ${state.workingLocation === l ? 'selected' : ''}>${l}</option>
          `).join('')}
        </select>

        <label class="al-label" for="al-odt-select">Output Transform</label>
        <select class="al-select" id="al-odt-select" aria-label="Output transform">
          ${OUTPUT_KEYS.map(k => `
            <option value="${k}" ${state.outputTransform === k ? 'selected' : ''}>
              ${REGISTRY.outputTransforms[k].label}
            </option>
          `).join('')}
        </select>

        ${state.mode === 'sdr_qt_in_hdr_show' ? `
          <label class="al-checkbox-label">
            <input type="checkbox" id="al-preserve-sdr" ${state.preserveSdr ? 'checked' : ''}>
            Preserve SDR Appearance
          </label>
        ` : ''}
      </div>
    </div>
  `;

  container.querySelector('#al-working-select').addEventListener('change', e => setWorkingLocation(e.target.value));
  container.querySelector('#al-odt-select').addEventListener('change',     e => setOutputTransform(e.target.value));
  container.querySelector('#al-preserve-sdr')?.addEventListener('change',  e => patch({ preserveSdr: e.target.checked }));
}
