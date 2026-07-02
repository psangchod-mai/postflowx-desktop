// scripts/features/acesLook/cards/SourceDetectionCard.js
// Left panel card: drop/select source file, show detection result.

import { detectSource }                                        from '../services/sourceDetection.js';
import { setSource, setInputTransform, setClipId, setOcfMeta, patch, getState } from '../state/acesLookStore.js';

// Escape the dropped file's name before it goes into innerHTML (untrusted —
// macOS filenames can contain <>"'&).
const _esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function renderSourceDetectionCard(container, state) {
  container.innerHTML = `
    <div class="al-card" id="al-source-card">
      <div class="al-card-header">Source</div>
      <div class="al-card-body">
        <div class="al-drop-zone" id="al-drop-zone" tabindex="0" role="button"
             aria-label="Drop source file or click to browse">
          <span class="al-drop-icon">⬆</span>
          <span class="al-drop-label">${state.source ? _esc(state.source.name) : 'Drop file or click to browse'}</span>
          <input type="file" id="al-source-input" accept=".exr,.dpx,.mov,.mp4,.mxf,.r3d,.arx,.ari,.braw" hidden>
        </div>
        ${state.source ? `
          <div class="al-detect-result">
            <span class="al-detect-class">${state.sourceClass}</span>
            <span class="al-detect-conf al-detect-conf--${_confClass(state)}">
              ${_confLabel(state)}
            </span>
          </div>
        ` : ''}
      </div>
    </div>
  `;

  const dropZone = container.querySelector('#al-drop-zone');
  const fileInput = container.querySelector('#al-source-input');

  dropZone.addEventListener('click',   () => fileInput.click());
  dropZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('al-drop-zone--over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('al-drop-zone--over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('al-drop-zone--over');
    const file = e.dataTransfer?.files?.[0];
    if (file) _handleFile(file);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) _handleFile(file);
  });
}

function _handleFile(file) {
  const { sourceClass, suggestedInputTransform } = detectSource(file);
  setSource(file);
  patch({ sourceClass });
  // Feed OCF metadata for the AUTO-IDT path. The renderer can't probe a dropped
  // File (no companion), so the only signal is the filename + extension — but the
  // IDT_MAP token list (venice/alexa/komodo/xocn/…) is far richer than
  // detectSource's coarse regex, so resolveIdtFromOCFMeta in amfBuilder can still
  // resolve the camera from the name when detection returns AUTO. Put the filename
  // in cameraType (a searched field) so those tokens match.
  if (file?.name) {
    const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
    setOcfMeta({
      colorSpace: '',
      codec:      ext,
      cameraType: file.name,
      container:  ext,
      source:     'filename',
    });
  }
  if (suggestedInputTransform !== 'AUTO') {
    setInputTransform(suggestedInputTransform);
  }
  // Auto-fill Clip ID from filename stem if the user hasn't typed one yet.
  if (!getState().clipId) {
    const stem = file.name.replace(/\.[^.]+$/, '');
    setClipId(stem);
  }
}

function _confClass(state) {
  const { confidence } = detectSource(state.source);
  return confidence;
}

function _confLabel(state) {
  const { confidence } = detectSource(state.source);
  const map = { high: 'High confidence', medium: 'Medium confidence', low: 'Low confidence — verify' };
  return map[confidence] || '';
}
