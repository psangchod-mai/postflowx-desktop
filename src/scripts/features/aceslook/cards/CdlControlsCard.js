// scripts/features/acesLook/cards/CdlControlsCard.js

import { setCdlEnabled, setCdlValue } from '../state/acesLookStore.js';
import { EMPTY_CDL }                  from '../state/acesLookDefaults.js';
import { attachScrubGanged, attachScrub } from '../utils/scrubInput.js';

const CDL_VEC_FIELDS = [
  { key: 'slope',  label: 'Slope',  defaultVal: 1, min: 0,    max: 4,  step: 0.001 },
  { key: 'offset', label: 'Offset', defaultVal: 0, min: -2,   max: 2,  step: 0.0005 },
  { key: 'power',  label: 'Power',  defaultVal: 1, min: 0.01, max: 4,  step: 0.001 },
];

export function renderCdlControlsCard(container, state) {
  container.innerHTML = `
    <div class="al-card" id="al-cdl-card">
      <div class="al-card-header">
        CDL
        <label class="al-toggle al-toggle--right">
          <input type="checkbox" id="al-cdl-enabled" ${state.cdlEnabled ? 'checked' : ''}>
          <span class="al-toggle-label">Enable</span>
        </label>
      </div>
      <div class="al-card-body ${state.cdlEnabled ? '' : 'al-card-body--disabled'}" id="al-cdl-body">
        ${CDL_VEC_FIELDS.map(f => `
          <div class="al-cdl-row">
            <span class="al-cdl-row-label" id="al-cdl-lbl-${f.key}">${f.label}</span>
            ${[0,1,2].map(i => `
              <input type="number" class="al-number" id="al-cdl-${f.key}-${i}"
                     min="${f.min}" max="${f.max}" step="${f.step}"
                     value="${(state.cdl[f.key]?.[i] ?? f.defaultVal).toFixed(4)}"
                     ${state.cdlEnabled ? '' : 'disabled'}>
            `).join('')}
          </div>
        `).join('')}
        <div class="al-cdl-row">
          <span class="al-cdl-row-label" id="al-cdl-lbl-sat">Saturation</span>
          <input type="number" class="al-number al-number--wide" id="al-cdl-sat"
                 min="0" max="4" step="0.0001"
                 value="${(state.cdl.sat ?? 1).toFixed(4)}"
                 ${state.cdlEnabled ? '' : 'disabled'}>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#al-cdl-enabled').addEventListener('change', e => {
    setCdlEnabled(e.target.checked);
    container.querySelector('#al-cdl-body').classList.toggle('al-card-body--disabled', !e.target.checked);
    container.querySelectorAll('#al-cdl-body input[type=number]').forEach(el => {
      el.disabled = !e.target.checked;
    });
  });

  // Vec fields: change + ganged drag-scrub on label + per-input double-click reset
  for (const f of CDL_VEC_FIELDS) {
    const inputs = [0,1,2].map(i => container.querySelector(`#al-cdl-${f.key}-${i}`));

    const commitVec = vals => {
      inputs.forEach((el, i) => { el.value = vals[i].toFixed(4); });
      setCdlValue(f.key, vals);
    };

    inputs.forEach((el, i) => {
      el.addEventListener('change', () => {
        const vals = inputs.map((inp, j) => {
          const v = parseFloat(inp.value);
          return isNaN(v) ? (f.defaultVal) : Math.min(f.max, Math.max(f.min, v));
        });
        commitVec(vals);
      });

      // Double-click individual input to reset that channel only
      el.addEventListener('dblclick', e => {
        e.preventDefault();
        el.value = f.defaultVal.toFixed(4);
        const vals = inputs.map(inp => parseFloat(inp.value) || f.defaultVal);
        setCdlValue(f.key, vals);
      });
      el.title = 'Double-click to reset channel';
    });

    const labelEl = container.querySelector(`#al-cdl-lbl-${f.key}`);
    attachScrubGanged(labelEl, inputs, {
      step:        f.step,
      min:         f.min,
      max:         f.max,
      decimals:    4,
      defaultVals: [f.defaultVal, f.defaultVal, f.defaultVal],
      onChange:    commitVec,
    });
  }

  // Saturation scalar
  const satInput = container.querySelector('#al-cdl-sat');
  const satLabel = container.querySelector('#al-cdl-lbl-sat');

  const commitSat = v => {
    const clamped = Math.min(4, Math.max(0, v));
    satInput.value = clamped.toFixed(4);
    setCdlValue('sat', clamped);
  };

  satInput.addEventListener('change', () => commitSat(parseFloat(satInput.value) || 1));

  attachScrub(satLabel, satInput, {
    step:       0.001,
    min:        0,
    max:        4,
    decimals:   4,
    defaultVal: 1,
    onChange:   commitSat,
  });
}
