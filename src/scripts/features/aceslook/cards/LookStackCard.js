// scripts/features/acesLook/cards/LookStackCard.js

import { addLookItem, toggleLookItem, removeLookItem, updateLookItem, reorderLookItems } from '../state/acesLookStore.js';

export function renderLookStackCard(container, state) {
  container.innerHTML = `
    <div class="al-card" id="al-lookstack-card">
      <div class="al-card-header">
        Look Stack
        <button class="al-btn al-btn--xs" id="al-ls-add-cdl">+ CDL</button>
        <button class="al-btn al-btn--xs" id="al-ls-add-clf">+ CLF</button>
        <button class="al-btn al-btn--xs" id="al-ls-add-lut">+ LUT</button>
      </div>
      <div class="al-card-body" id="al-ls-body">
        ${state.lookStack.length === 0
          ? '<div class="al-empty-msg">No look items. Add CDL, CLF, or LUT.</div>'
          : state.lookStack.map((item, idx) => _renderItem(item, idx, state.lookStack.length)).join('')
        }
      </div>
    </div>
  `;

  container.querySelector('#al-ls-add-cdl').addEventListener('click', () => {
    addLookItem('cdl', 'CDL');
  });
  container.querySelector('#al-ls-add-clf').addEventListener('click', () => {
    addLookItem('clf', 'CLF', { file: '' });
  });
  container.querySelector('#al-ls-add-lut').addEventListener('click', () => {
    addLookItem('lut', 'LUT', { file: '' });
  });

  container.querySelectorAll('.al-ls-toggle').forEach(el => {
    el.addEventListener('change', () => toggleLookItem(el.dataset.id));
  });
  container.querySelectorAll('.al-ls-remove').forEach(el => {
    el.addEventListener('click', () => removeLookItem(el.dataset.id));
  });
  container.querySelectorAll('.al-ls-label').forEach(el => {
    el.addEventListener('change', () => updateLookItem(el.dataset.id, { label: el.value }));
  });
  container.querySelectorAll('.al-ls-file').forEach(el => {
    el.addEventListener('change', () => updateLookItem(el.dataset.id, { file: el.value }));
  });
  container.querySelectorAll('.al-ls-transformid').forEach(el => {
    el.addEventListener('change', () => updateLookItem(el.dataset.id, { transformId: el.value }));
  });

  // Drag-to-reorder look items
  let _dragId = null;
  container.querySelectorAll('.al-ls-item').forEach(el => {
    el.setAttribute('draggable', 'true');
    el.addEventListener('dragstart', (e) => {
      _dragId = el.dataset.id;
      el.classList.add('al-ls-dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    el.addEventListener('dragend', () => {
      _dragId = null;
      container.querySelectorAll('.al-ls-item').forEach(i => {
        i.classList.remove('al-ls-dragging', 'al-ls-drag-over');
      });
    });
    el.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (el.dataset.id !== _dragId) el.classList.add('al-ls-drag-over');
    });
    el.addEventListener('dragleave', () => el.classList.remove('al-ls-drag-over'));
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      el.classList.remove('al-ls-drag-over');
      if (!_dragId || _dragId === el.dataset.id) return;
      const items = [...container.querySelectorAll('.al-ls-item')];
      const ids   = items.map(i => i.dataset.id);
      const from  = ids.indexOf(_dragId);
      const to    = ids.indexOf(el.dataset.id);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1);
      ids.splice(to, 0, _dragId);
      reorderLookItems(ids);
    });
  });
}

function _renderItem(item, idx, total) {
  return `
    <div class="al-ls-item ${item.enabled ? '' : 'al-ls-item--disabled'}" data-id="${item.id}">
      <div class="al-ls-row">
        <span class="al-ls-drag-handle" title="Drag to reorder">⠿</span>
        <input type="checkbox" class="al-ls-toggle" data-id="${item.id}" ${item.enabled ? 'checked' : ''}>
        <span class="al-ls-kind al-ls-kind--${item.kind}">${item.kind.toUpperCase()}</span>
        <input type="text" class="al-input al-ls-label" data-id="${item.id}" value="${_esc(item.label)}" placeholder="Label">
        <button class="al-btn al-btn--icon al-ls-remove" data-id="${item.id}" title="Remove">✕</button>
      </div>
      ${(item.kind === 'clf' || item.kind === 'lut') ? `
        <div class="al-ls-sub">
          <input type="text" class="al-input al-ls-file" data-id="${item.id}"
                 value="${_esc(item.file || '')}" placeholder="File path">
        </div>
      ` : ''}
      ${item.kind === 'cdl' ? `
        <div class="al-ls-sub">
          <input type="text" class="al-input al-ls-transformid" data-id="${item.id}"
                 value="${_esc(item.transformId || '')}" placeholder="Transform ID (optional)">
        </div>
      ` : ''}
    </div>
  `;
}

function _esc(s) {
  return String(s || '').replace(/"/g, '&quot;');
}
