// scripts/features/acesLook/modals/PresetSaveModal.js

import { savePreset, listPresets } from '../services/presetService.js';

/**
 * Show the preset save modal.
 * @param {object} state — current ACES Look state
 * @param {function} onSaved — called with preset name after successful save
 */
export function showPresetSaveModal(state, onSaved) {
  const existing = listPresets();
  const backdrop = document.createElement('div');
  backdrop.className = 'al-modal-backdrop';
  backdrop.innerHTML = `
    <div class="al-modal" role="dialog" aria-modal="true" aria-label="Save Preset">
      <div class="al-modal-header">
        Save Preset
        <button class="al-btn al-btn--icon al-modal-close" aria-label="Close">✕</button>
      </div>
      <div class="al-modal-body">
        <label class="al-label" for="al-preset-name">Preset name</label>
        <input type="text" class="al-input" id="al-preset-name" placeholder="My HDR VFX Pull">
        ${existing.length > 0 ? `
          <div class="al-field-note">Existing: ${existing.join(', ')}</div>
        ` : ''}
        <div class="al-modal-err" id="al-preset-err" hidden></div>
      </div>
      <div class="al-modal-footer">
        <button class="al-btn" id="al-preset-cancel">Cancel</button>
        <button class="al-btn al-btn--primary" id="al-preset-save">Save</button>
      </div>
    </div>
  `;

  document.body.appendChild(backdrop);

  const nameInput = backdrop.querySelector('#al-preset-name');
  const errDiv    = backdrop.querySelector('#al-preset-err');

  function _close() { backdrop.remove(); }

  backdrop.querySelector('.al-modal-close').addEventListener('click', _close);
  backdrop.querySelector('#al-preset-cancel').addEventListener('click', _close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) _close(); });

  backdrop.querySelector('#al-preset-save').addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) {
      errDiv.textContent = 'Preset name is required.';
      errDiv.hidden = false;
      return;
    }
    // Warn before overwriting an existing preset
    if (existing.includes(name)) {
      errDiv.textContent = `"${name}" already exists. Save again to overwrite.`;
      errDiv.hidden = false;
      // Change button label to confirm intent
      backdrop.querySelector('#al-preset-save').textContent = 'Overwrite';
      errDiv.style.color = '#c8a040';
      // Second click proceeds
      backdrop.querySelector('#al-preset-save').onclick = () => {
        const result = savePreset(name, state);
        if (!result.ok) {
          errDiv.textContent = result.error || 'Failed to save preset.';
          errDiv.style.color = '';
          errDiv.hidden = false;
          return;
        }
        _close();
        onSaved?.(name);
      };
      return;
    }
    const result = savePreset(name, state);
    if (!result.ok) {
      errDiv.textContent = result.error || 'Failed to save preset.';
      errDiv.hidden = false;
      return;
    }
    _close();
    onSaved?.(name);
  });

  nameInput.focus();
}
