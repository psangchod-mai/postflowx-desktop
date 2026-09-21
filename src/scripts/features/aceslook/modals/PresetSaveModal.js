// scripts/features/acesLook/modals/PresetSaveModal.js

import { savePreset, listPresets, exportAllPresets, importPresets, seedDefaultPresets } from '../services/presetService.js';

// Trigger a browser/Electron download of a text payload as `filename`.
function _downloadText(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

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
        <button class="al-btn" id="al-preset-starter" title="Add the bundled starter presets (camera→ACES pulls + common deliveries)">Starter presets</button>
        <button class="al-btn" id="al-preset-import" title="Import presets from a .pfxpreset file">Import…</button>
        <button class="al-btn" id="al-preset-export" title="Export all saved presets to a .pfxpreset file"${existing.length ? '' : ' disabled'}>Export all</button>
        <span class="al-modal-footer-spacer" style="flex:1"></span>
        <button class="al-btn" id="al-preset-cancel">Cancel</button>
        <button class="al-btn al-btn--primary" id="al-preset-save">Save</button>
      </div>
      <input type="file" id="al-preset-file" accept=".pfxpreset,application/json,.json" hidden>
    </div>
  `;

  document.body.appendChild(backdrop);

  const nameInput = backdrop.querySelector('#al-preset-name');
  const errDiv    = backdrop.querySelector('#al-preset-err');

  function _close() { backdrop.remove(); }

  backdrop.querySelector('.al-modal-close').addEventListener('click', _close);
  backdrop.querySelector('#al-preset-cancel').addEventListener('click', _close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) _close(); });

  function _info(msg, color = '#7be3a0') {
    errDiv.textContent = msg; errDiv.style.color = color; errDiv.hidden = false;
  }

  // Add the bundled starter library (skips names that already exist)
  backdrop.querySelector('#al-preset-starter').addEventListener('click', () => {
    const r = seedDefaultPresets();
    const added = r.imported?.length || 0;
    _info(added ? `Added ${added} starter preset${added === 1 ? '' : 's'}.`
                : 'Starter presets already present.', added ? '#7be3a0' : '#c8a040');
    if (added) onSaved?.(r.imported[0]);
  });

  // Export all saved presets → .pfxpreset download
  backdrop.querySelector('#al-preset-export').addEventListener('click', () => {
    const r = exportAllPresets();
    if (!r.ok) { _info(r.error || 'Nothing to export.', '#c8a040'); return; }
    _downloadText(r.filename, r.json);
    _info('Exported all presets.');
  });

  // Import presets from a .pfxpreset file (collisions skipped unless overwritten)
  const fileInput = backdrop.querySelector('#al-preset-file');
  backdrop.querySelector('#al-preset-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    let text = '';
    try { text = await file.text(); } catch { _info('Could not read file.', '#e0746a'); return; }
    const r = importPresets(text);
    fileInput.value = '';
    if (!r.ok) { _info(r.error || 'Import failed.', '#e0746a'); return; }
    const parts = [];
    if (r.imported.length) parts.push(`imported ${r.imported.length}`);
    if (r.skipped.length)  parts.push(`${r.skipped.length} already existed (skipped)`);
    _info(`Import: ${parts.join(' · ') || 'nothing new'}.`);
    if (r.imported.length) onSaved?.(r.imported[0]);   // refresh caller's preset list
  });

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
