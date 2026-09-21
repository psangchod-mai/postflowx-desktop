(function(){
  function _updateProjectTypeBadge(type){
    const badge = document.getElementById('pfxProjectTypeBadge');
    if (!badge) return;
    if (!type){ badge.style.display = 'none'; return; }
    badge.textContent = type === 'series' ? 'Series' : 'Standalone';
    badge.dataset.type = type;
    badge.style.display = '';
  }
  window.addEventListener('pfx:project-type-changed', e => {
    _updateProjectTypeBadge(e.detail?.projectType || null);
  });
  document.addEventListener('DOMContentLoaded', () => {
    _updateProjectTypeBadge(window.__PFX_PROJECT_TYPE || null);
  });
})();
