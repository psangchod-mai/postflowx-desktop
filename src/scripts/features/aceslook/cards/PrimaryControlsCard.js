// scripts/features/acesLook/cards/PrimaryControlsCard.js

import { setPrimaryControl } from '../state/acesLookStore.js';
import { attachScrub }       from '../utils/scrubInput.js';

const CONTROLS = [
  { key: 'exposure',    label: 'Exposure',    min: -4,   max: 4,   step: 0.01,  decimals: 2, defaultVal: 0 },
  { key: 'contrast',    label: 'Contrast',    min: 0.1,  max: 2,   step: 0.005, decimals: 2, defaultVal: 1 },
  { key: 'saturation',  label: 'Saturation',  min: 0,    max: 2,   step: 0.005, decimals: 2, defaultVal: 1 },
  { key: 'temperature', label: 'Temperature', min: -100, max: 100, step: 0.5,   decimals: 0, defaultVal: 0 },
];

export function renderPrimaryControlsCard(container, state) {
  container.innerHTML = `
    <div class="al-card" id="al-primary-card">
      <div class="al-card-header">Primary Controls</div>
      <div class="al-card-body al-primary-grid">
        ${CONTROLS.map(c => `
          <div class="al-control-row">
            <label class="al-control-label" for="al-pc-${c.key}" id="al-pcl-${c.key}">${c.label}</label>
            <input type="range" class="al-range" id="al-pc-${c.key}"
                   min="${c.min}" max="${c.max}" step="${c.step}"
                   value="${state.primaryControls[c.key] ?? c.defaultVal}">
            <input type="number" class="al-number al-number--sm" id="al-pcn-${c.key}"
                   min="${c.min}" max="${c.max}" step="${c.step}"
                   value="${Number(state.primaryControls[c.key] ?? c.defaultVal).toFixed(c.decimals)}">
          </div>
        `).join('')}
      </div>
    </div>
  `;

  for (const c of CONTROLS) {
    const label = container.querySelector(`#al-pcl-${c.key}`);
    const range = container.querySelector(`#al-pc-${c.key}`);
    const num   = container.querySelector(`#al-pcn-${c.key}`);

    const commit = v => {
      const clamped = Math.min(c.max, Math.max(c.min, v));
      range.value = clamped;
      num.value   = clamped.toFixed(c.decimals);
      setPrimaryControl(c.key, clamped);
    };

    range.addEventListener('input', () => commit(parseFloat(range.value)));
    num.addEventListener('change',  () => commit(parseFloat(num.value) || c.defaultVal));

    // Scroll wheel on range slider
    range.addEventListener('wheel', e => {
      e.preventDefault();
      commit((parseFloat(range.value) || 0) + (e.deltaY < 0 ? c.step : -c.step));
    }, { passive: false });

    // Drag label to scrub + double-click number to reset
    attachScrub(label, num, {
      step:       c.step,
      min:        c.min,
      max:        c.max,
      decimals:   c.decimals,
      defaultVal: c.defaultVal,
      onChange:   commit,
    });
  }
}
