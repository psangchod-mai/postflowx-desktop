// scripts/features/acesLook/cards/InputTransformCard.js

import { setInputTransform } from '../state/acesLookStore.js';
import { REGISTRY }          from '../services/transformRegistry.js';

const TRANSFORM_KEYS = Object.keys(REGISTRY.inputTransforms);

export function renderInputTransformCard(container, state) {
  const current = state.inputTransform;
  const entry   = REGISTRY.inputTransforms[current] || {};

  container.innerHTML = `
    <div class="al-card" id="al-idt-card">
      <div class="al-card-header">Input Transform</div>
      <div class="al-card-body">
        <select class="al-select" id="al-idt-select" aria-label="Input transform">
          ${TRANSFORM_KEYS.map(k => `
            <option value="${k}" ${current === k ? 'selected' : ''}>${REGISTRY.inputTransforms[k].label}</option>
          `).join('')}
        </select>
        ${entry.note ? `<div class="al-field-note">${entry.note}</div>` : ''}
        ${current === 'CUSTOM_FILE' ? `
          <label class="al-label" for="al-idt-file">CLF/LUT file path</label>
          <input class="al-input" id="al-idt-file" type="text"
                 placeholder="path/to/transform.clf"
                 value="${state.inputTransformFile || ''}">
        ` : ''}
        ${entry.transformId ? `
          <div class="al-field-note al-field-note--id">ID: <code>${entry.transformId}</code></div>
        ` : ''}
      </div>
    </div>
  `;

  container.querySelector('#al-idt-select').addEventListener('change', e => {
    setInputTransform(e.target.value);
  });

  container.querySelector('#al-idt-file')?.addEventListener('input', e => {
    // Store custom file path in store via patch
    import('../state/acesLookStore.js').then(({ patch }) => patch({ inputTransformFile: e.target.value }));
  });
}
