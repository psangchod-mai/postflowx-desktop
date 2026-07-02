// scripts/features/vfxPull/ocfErrorPane.js
//
// Pure HTML builder for the OCF preview "cannot be decoded" error pane.
// Extracted from prep_mark so the markup + stage escaping + conditional action
// buttons are unit-testable (prep_mark is a large DOM-coupled module). The
// `data-ocf-action` hooks are wired by the caller after injecting this HTML.

function _esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @param {object} opts
 * @param {string} [opts.stage]            failure stage from the decode result (untrusted → escaped)
 * @param {boolean} [opts.resolveConnected] true → show the "Test Resolve Still" diagnostic + connected message
 * @returns {string} HTML for slot.innerHTML
 */
export function buildOcfErrorPaneHtml({ stage = '', resolveConnected = false } = {}) {
  const stageMsg = stage ? ` Stage: ${_esc(stage)}.` : '';
  const errDetail = resolveConnected
    ? `Resolve Engine is connected but extraction failed.${stageMsg} Use [Test Resolve Still] to diagnose.`
    : 'Check console for details.';
  return `OCF linked, but preview frame cannot be decoded.
                 <span class="pfx-vfx-ocf-err-detail">${errDetail}</span>
                 <div class="pfx-vfx-ocf-engine-actions">
                   ${resolveConnected ? '<button class="pfx-vfx-ocf-btn pfx-vfx-ocf-btn-diag" data-ocf-action="test-resolve">Test Resolve Still</button>' : ''}
                   <button class="pfx-vfx-ocf-btn" data-ocf-action="retry">Retry Preview</button>
                   <button class="pfx-vfx-ocf-btn pfx-vfx-ocf-btn-minor" data-ocf-action="use-ffmpeg">Use FFmpeg Fallback</button>
                 </div>`;
}

/**
 * HTML for one failed cell in the 7-frame OCF preview strip (label + escaped
 * stage/error). All fields are file/decoder-derived → escaped.
 * @param {object} opts - { label, stage, error }
 * @returns {string}
 */
// Map raw decode-stage tokens to human-readable cell labels so the strip never
// surfaces internal stage strings like "connect"/"import" to the user.
const _STAGE_LABELS = {
  connect: 'Start Resolve',
  import: 'Importing…',
  project: 'Resolve busy',
  media_pool: 'Resolve busy',
  validation: 'No source',
  helper_outdated: 'Update helper',
  exception: 'decode error',
  unknown: 'decode error',
};

export function buildOcfStripCellHtml({ label = '', stage = '', error = '' } = {}) {
  const stageLabel = _STAGE_LABELS[stage] || (stage && stage !== 'unknown' ? stage : 'decode error');
  return `<span class="pfx-vfx-strip-lbl">${_esc(label)}</span>
            <span class="pfx-vfx-strip-err" title="${_esc(error || '')}">${_esc(stageLabel)}</span>`;
}

/**
 * "Resolve required" pane — shown when a correctly-linked clip is camera-RAW
 * that FFmpeg can't preview. Camera-RAW (`isRaw`) hides the "Try FFmpeg anyway"
 * button (it would always fail). `rawLabel` is escaped defensively.
 * @param {object} opts - { rawLabel, isRaw }
 * @returns {string}
 */
export function buildOcfEngineRequiredHtml({ rawLabel = '', isRaw = false } = {}) {
  return `<span class="pfx-vfx-ocf-engine-msg">✓ This shot is linked correctly.<br>
                   <b>${_esc(rawLabel)}</b> can't be previewed by FFmpeg — DaVinci Resolve decodes it.</span>
                 <div class="pfx-vfx-ocf-engine-actions">
                   <button class="pfx-vfx-ocf-btn" data-ocf-action="start-resolve">⚡ Connect Resolve &amp; preview</button>
                   <button class="pfx-vfx-ocf-btn" data-ocf-action="retry">Retry</button>
                   ${isRaw ? '' : '<button class="pfx-vfx-ocf-btn pfx-vfx-ocf-btn-minor" data-ocf-action="use-ffmpeg">Try FFmpeg anyway</button>'}
                 </div>
                 <span class="pfx-vfx-ocf-engine-hint">You can still approve and export this shot without a preview.</span>`;
}
