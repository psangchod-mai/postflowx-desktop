// scripts/features/acesLook/modals/ValidationDrawer.js
// Footer validation drawer — shows errors (red) and warnings (amber).

export function renderValidationDrawer(container, state) {
  const errors   = state.errors   || [];
  const warnings = state.warnings || [];

  container.innerHTML = `
    <div class="al-validation-drawer" id="al-validation-drawer">
      ${errors.length > 0 ? `
        <div class="al-vd-section al-vd-section--errors">
          <span class="al-vd-label">Errors (${errors.length})</span>
          <ul class="al-vd-list">
            ${errors.map(e => `<li class="al-vd-item al-vd-item--error">✗ ${e}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
      ${warnings.length > 0 ? `
        <div class="al-vd-section al-vd-section--warnings">
          <span class="al-vd-label">Warnings (${warnings.length})</span>
          <ul class="al-vd-list">
            ${warnings.map(w => `<li class="al-vd-item al-vd-item--warning">⚠ ${w}</li>`).join('')}
          </ul>
        </div>
      ` : ''}
      ${errors.length === 0 && warnings.length === 0 ? `
        <div class="al-vd-clear">No issues</div>
      ` : ''}
    </div>
  `;
}
