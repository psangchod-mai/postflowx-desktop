import {
  listUnifiedProjects,
  loadUnifiedProjectByName,
  saveUnifiedProjectFile,
  deleteUnifiedProjectByName,
  readUnifiedProjectInfo,
  renameUnifiedProjectByName,
  cloneUnifiedProjectByName,
  saveProjectTemplate,
  listProjectTemplates,
  createProjectFromTemplate,
  sanitizeFilename,
  pickProjectDirByUser,
  getStoredProjectDir
} from './projectFile.js';

/* ─── state ──────────────────────────────────────────────────────────────── */
let _projects = [];
let _templates = [];
let _query = '';
let _selectedProject = null;
const PANE_ID = 'main-dashboard';

/* ─── helpers ────────────────────────────────────────────────────────────── */
function _esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _pane() { return document.getElementById(PANE_ID); }

function _toast(msg, type = 'info') {
  let el = document.getElementById('pfx-dash-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pfx-dash-toast';
    el.className = 'pfx-dash-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.dataset.type = type;
  el.classList.add('is-visible');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('is-visible'), 3000);
}

async function _prompt(msg, defaultVal = '') {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'pfx-dash-prompt-overlay';
    overlay.innerHTML = `
      <div class="pfx-dash-prompt">
        <div class="pfx-dash-prompt-msg">${_esc(msg)}</div>
        <input class="pfx-dash-prompt-input" type="text" value="${_esc(defaultVal)}" />
        <div class="pfx-dash-prompt-btns">
          <button class="pfx-dash-btn pfx-dash-btn--primary" id="pfx-dpi-ok">OK</button>
          <button class="pfx-dash-btn" id="pfx-dpi-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('input');
    input.focus(); input.select();
    const cleanup = v => { document.body.removeChild(overlay); resolve(v); };
    overlay.querySelector('#pfx-dpi-ok').addEventListener('click', () => cleanup(input.value.trim()));
    overlay.querySelector('#pfx-dpi-cancel').addEventListener('click', () => cleanup(null));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') cleanup(input.value.trim()); if (e.key === 'Escape') cleanup(null); });
  });
}

async function _confirm(msg) {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'pfx-dash-prompt-overlay';
    overlay.innerHTML = `
      <div class="pfx-dash-prompt">
        <div class="pfx-dash-prompt-msg">${_esc(msg)}</div>
        <div class="pfx-dash-prompt-btns">
          <button class="pfx-dash-btn pfx-dash-btn--danger" id="pfx-dci-ok">Delete</button>
          <button class="pfx-dash-btn" id="pfx-dci-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const cleanup = v => { document.body.removeChild(overlay); resolve(v); };
    overlay.querySelector('#pfx-dci-ok').addEventListener('click', () => cleanup(true));
    overlay.querySelector('#pfx-dci-cancel').addEventListener('click', () => cleanup(false));
  });
}

/* ─── data fetch ─────────────────────────────────────────────────────────── */
async function _refreshList() {
  const [listRes, tplRes] = await Promise.all([
    listUnifiedProjects().catch(() => ({ ok: false, projects: [] })),
    listProjectTemplates().catch(() => ({ ok: true, templates: [] }))
  ]);
  _projects = listRes.projects || [];
  _templates = tplRes.templates || [];
}

/* ─── actions ────────────────────────────────────────────────────────────── */
async function _actionLoad(name) {
  _toast(`Loading "${name}"…`);
  try {
    const r = await loadUnifiedProjectByName(name);
    if (!r.ok) throw new Error(r.reason || 'load failed');
    _selectedProject = name;
    _toast(`"${name}" loaded`, 'success');
    document.dispatchEvent(new CustomEvent('pfx:project-applied', { detail: { projectName: name } }));
    _render();
  } catch (e) {
    _toast(`Load failed: ${e.message}`, 'error');
  }
}

async function _promptNewProject() {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'pfx-dash-prompt-overlay';
    overlay.innerHTML = `
      <div class="pfx-dash-prompt pfx-dash-newproj">
        <div class="pfx-dash-prompt-msg">New Project</div>
        <input class="pfx-dash-prompt-input" id="pfx-np-name" type="text" value="Untitled_Project" placeholder="Project name" />
        <div class="pfx-np-type-row">
          <span class="pfx-np-type-lbl" id="pfx-np-lbl-standalone">Standalone</span>
          <label class="pfx-np-toggle" title="Toggle project type">
            <input type="checkbox" id="pfx-np-toggle-chk" />
            <span class="pfx-np-toggle-track">
              <span class="pfx-np-toggle-thumb"></span>
            </span>
          </label>
          <span class="pfx-np-type-lbl" id="pfx-np-lbl-series">Series</span>
        </div>
        <div class="pfx-np-series-fields" id="pfx-np-series" style="display:none">
          <input class="pfx-dash-prompt-input pfx-np-sub" id="pfx-np-show" type="text" placeholder="Show ID (e.g. SHOW1)" />
          <input class="pfx-dash-prompt-input pfx-np-sub" id="pfx-np-season" type="text" placeholder="Season (e.g. S01)" />
          <input class="pfx-dash-prompt-input pfx-np-sub pfx-np-ep-count" id="pfx-np-ep-count" type="number" min="1" max="999" value="18" placeholder="Episodes" />
        </div>
        <div class="pfx-dash-prompt-btns">
          <button class="pfx-dash-btn pfx-dash-btn--primary" id="pfx-np-ok">Create</button>
          <button class="pfx-dash-btn" id="pfx-np-cancel">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    let selectedType = 'standalone';
    const nameInput    = overlay.querySelector('#pfx-np-name');
    const seriesFields = overlay.querySelector('#pfx-np-series');
    const toggleChk    = overlay.querySelector('#pfx-np-toggle-chk');
    const lblStandalone = overlay.querySelector('#pfx-np-lbl-standalone');
    const lblSeries     = overlay.querySelector('#pfx-np-lbl-series');

    nameInput.focus(); nameInput.select();

    function _syncToggle() {
      selectedType = toggleChk.checked ? 'series' : 'standalone';
      seriesFields.style.display = toggleChk.checked ? 'flex' : 'none';
      lblStandalone.classList.toggle('pfx-np-type-lbl--active', !toggleChk.checked);
      lblSeries.classList.toggle('pfx-np-type-lbl--active', toggleChk.checked);
    }
    _syncToggle();
    toggleChk.addEventListener('change', _syncToggle);

    const cleanup = v => { document.body.removeChild(overlay); resolve(v); };

    overlay.querySelector('#pfx-np-ok').addEventListener('click', () => {
      const name = nameInput.value.trim();
      if (!name) return;
      const seriesMeta = selectedType === 'series' ? {
        showId:       overlay.querySelector('#pfx-np-show').value.trim()     || null,
        season:       overlay.querySelector('#pfx-np-season').value.trim()   || null,
        episodeCount: parseInt(overlay.querySelector('#pfx-np-ep-count').value, 10) || 18,
      } : null;
      cleanup({ name, projectType: selectedType, seriesMeta });
    });

    overlay.querySelector('#pfx-np-cancel').addEventListener('click', () => cleanup(null));
    nameInput.addEventListener('keydown', e => { if (e.key === 'Escape') cleanup(null); });
  });
}

async function _actionCreate() {
  const result = await _promptNewProject();
  if (!result) return;
  const { name, projectType, seriesMeta } = result;
  // Set globals so buildManifest picks them up
  try { window.__PFX_PROJECT_TYPE = projectType; } catch {}
  try { window.__PFX_SERIES_META  = seriesMeta; }  catch {}
  // Sync EP checkbox for naming template
  try { localStorage.setItem('pfx_sm_ep_on', projectType === 'series' ? '1' : '0'); } catch {}
  _toast(`Creating "${name}"…`);
  try {
    const r = await saveUnifiedProjectFile(name);
    if (!r.ok) throw new Error(r.reason || 'save failed');
    _toast(`"${name}" created`, 'success');
    try { window.dispatchEvent(new CustomEvent('pfx:project-type-changed', { detail:{ projectType, seriesMeta } })); } catch {}
    await _refreshList();
    _render();
  } catch (e) {
    _toast(`Create failed: ${e.message}`, 'error');
  }
}

async function _actionSave() {
  const name = _selectedProject || await _prompt('Save project as:', 'Untitled_Project');
  if (!name) return;
  _toast(`Saving "${name}"…`);
  try {
    const r = await saveUnifiedProjectFile(name);
    if (!r.ok) throw new Error(r.reason || 'save failed');
    _selectedProject = sanitizeFilename(name);
    _toast(`"${name}" saved`, 'success');
    await _refreshList();
    _render();
  } catch (e) {
    _toast(`Save failed: ${e.message}`, 'error');
  }
}

async function _actionRename(name) {
  const newName = await _prompt(`Rename "${name}" to:`, name);
  if (!newName || newName === name) return;
  _toast(`Renaming…`);
  try {
    const r = await renameUnifiedProjectByName(name, newName);
    if (!r.ok) throw new Error(r.reason);
    const resolvedName = r.newName ?? newName;
    if (_selectedProject === name) _selectedProject = resolvedName;
    _toast(`Renamed to "${resolvedName}"`, 'success');
    await _refreshList();
    _render();
  } catch (e) {
    _toast(`Rename failed: ${e.message}`, 'error');
  }
}

async function _actionClone(name) {
  const cloneName = await _prompt(`Clone "${name}" as:`, `${name}_copy`);
  if (!cloneName) return;
  _toast(`Cloning…`);
  try {
    const r = await cloneUnifiedProjectByName(name, cloneName);
    if (!r.ok) throw new Error(r.reason);
    _toast(`Cloned as "${r.cloneName ?? cloneName}"`, 'success');
    await _refreshList();
    _render();
  } catch (e) {
    _toast(`Clone failed: ${e.message}`, 'error');
  }
}

async function _actionDelete(name) {
  const confirmed = await _confirm(`Delete "${name}"? This cannot be undone.`);
  if (!confirmed) return;
  _toast(`Deleting…`);
  try {
    const r = await deleteUnifiedProjectByName(name);
    if (!r.ok) throw new Error(r.reason);
    if (_selectedProject === name) _selectedProject = null;
    _toast(`"${name}" deleted`, 'success');
    await _refreshList();
    _render();
  } catch (e) {
    _toast(`Delete failed: ${e.message}`, 'error');
  }
}

async function _actionExportBundle(name) {
  _toast(`Preparing export for "${name}"…`);
  try {
    const info = await readUnifiedProjectInfo(name);
    if (!info.ok) throw new Error(info.reason);
    const bundle = { exportedAt: new Date().toISOString(), projectName: name, manifest: info.manifest, tabs: info.tabs };
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `${name}_bundle.json`;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
    _toast(`Bundle exported`, 'success');
  } catch (e) {
    _toast(`Export failed: ${e.message}`, 'error');
  }
}

async function _actionSaveTemplate(name) {
  const tplName = await _prompt('Template name:', `${name}_template`);
  if (!tplName) return;
  _toast(`Saving template…`);
  try {
    const r = await saveProjectTemplate(tplName, tplName, name);
    if (!r.ok) throw new Error(r.reason);
    _toast(`Template "${tplName}" saved`, 'success');
    await _refreshList();
    _render();
  } catch (e) {
    _toast(`Template save failed: ${e.message}`, 'error');
  }
}

async function _actionCreateFromTemplate(tplId) {
  const newName = await _prompt(`New project name from template "${tplId}":`, `${tplId}_project`);
  if (!newName) return;
  _toast(`Creating from template…`);
  try {
    const r = await createProjectFromTemplate(tplId, newName);
    if (!r.ok) throw new Error(r.reason);
    _toast(`"${r.projectName}" created from template`, 'success');
    await _refreshList();
    _render();
  } catch (e) {
    _toast(`Create from template failed: ${e.message}`, 'error');
  }
}

async function _actionSetFolder() {
  try {
    const r = await pickProjectDirByUser();
    if (r?.ok) { _toast('Project folder set', 'success'); await _refreshList(); _render(); }
  } catch (e) {
    _toast(`Folder pick failed: ${e.message}`, 'error');
  }
}

/* ─── render ─────────────────────────────────────────────────────────────── */
function _render() {
  const pane = _pane();
  if (!pane) return;

  const q = _query.toLowerCase();
  const visible = q ? _projects.filter(n => n.toLowerCase().includes(q)) : _projects;

  const noDir = window._pfxDashHasDir === false;

  const projectRows = visible.length ? visible.map(name => {
    const isActive = name === _selectedProject;
    return `
      <div class="pfx-dash-project-row${isActive ? ' is-active' : ''}" data-project="${_esc(name)}" title="Double-click to load">
        <span class="pfx-dash-project-icon">📁</span>
        <span class="pfx-dash-project-name">${_esc(name)}</span>
        ${isActive ? '<span class="pfx-dash-active-badge">loaded</span>' : ''}
        <span class="pfx-dash-row-actions">
          <button class="pfx-dash-row-btn" data-action="load" data-name="${_esc(name)}" title="Load">Load</button>
          <button class="pfx-dash-row-btn" data-action="rename" data-name="${_esc(name)}" title="Rename">Rename</button>
          <button class="pfx-dash-row-btn" data-action="clone" data-name="${_esc(name)}" title="Clone">Clone</button>
          <button class="pfx-dash-row-btn" data-action="export" data-name="${_esc(name)}" title="Export Bundle">Export</button>
          <button class="pfx-dash-row-btn" data-action="template" data-name="${_esc(name)}" title="Save as Template">→ Tpl</button>
          <button class="pfx-dash-row-btn pfx-dash-row-btn--danger" data-action="delete" data-name="${_esc(name)}" title="Delete">✕</button>
        </span>
      </div>`;
  }).join('')
    : `<div class="pfx-dash-empty">${q ? 'No projects match your search.' : 'No projects found. Create one or set the project folder.'}</div>`;

  const templateRows = _templates.length ? _templates.map(t => `
    <div class="pfx-dash-tpl-row" data-tpl="${_esc(t.id)}">
      <span class="pfx-dash-project-icon">📄</span>
      <span class="pfx-dash-project-name">${_esc(t.name || t.id)}</span>
      <span class="pfx-dash-muted">${t.createdAt ? t.createdAt.slice(0, 10) : ''}</span>
      <button class="pfx-dash-row-btn pfx-dash-row-btn--primary" data-action="from-tpl" data-tpl="${_esc(t.id)}">New from Template</button>
    </div>`).join('')
    : `<div class="pfx-dash-empty">No templates saved yet.</div>`;

  pane.innerHTML = `
<div class="pfx-project-dashboard">
  <div class="pfx-dash-header">
    <h2 class="pfx-dash-title">Project Dashboard</h2>
    <div class="pfx-dash-toolbar">
      <button class="pfx-dash-btn pfx-dash-btn--primary" id="pfx-dash-new">+ New Project</button>
      <button class="pfx-dash-btn pfx-dash-btn--primary" id="pfx-dash-save">⬆ Save Current</button>
      <button class="pfx-dash-btn" id="pfx-dash-folder" title="Set project folder">📁 Set Folder</button>
      <button class="pfx-dash-btn" id="pfx-dash-refresh" title="Refresh list">↻ Refresh</button>
    </div>
  </div>

  ${noDir ? `<div class="pfx-dash-notice">No project folder set. Click <strong>📁 Set Folder</strong> to choose where projects are saved.</div>` : ''}

  <div class="pfx-dash-section">
    <div class="pfx-dash-section-header">
      <span class="pfx-dash-section-title">Projects <span class="pfx-dash-count">${_projects.length}</span></span>
      <input class="pfx-dash-search" id="pfx-dash-search" type="text" placeholder="Search…" value="${_esc(_query)}" />
    </div>
    <div class="pfx-dash-list" id="pfx-dash-list">${projectRows}</div>
  </div>

  <details class="pfx-dash-section pfx-dash-templates-section">
    <summary class="pfx-dash-section-header pfx-dash-section-summary">
      <span class="pfx-dash-section-title">Templates <span class="pfx-dash-count">${_templates.length}</span></span>
    </summary>
    <div class="pfx-dash-list">${templateRows}</div>
  </details>
</div>`;

  /* events */
  pane.querySelector('#pfx-dash-new')?.addEventListener('click', _actionCreate);
  pane.querySelector('#pfx-dash-save')?.addEventListener('click', _actionSave);
  pane.querySelector('#pfx-dash-folder')?.addEventListener('click', _actionSetFolder);
  pane.querySelector('#pfx-dash-refresh')?.addEventListener('click', async () => { await _refreshList(); _render(); });

  const searchInput = pane.querySelector('#pfx-dash-search');
  searchInput?.addEventListener('input', e => { _query = e.target.value; _render(); });

  pane.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const name = btn.dataset.name;
      const tpl = btn.dataset.tpl;
      if (action === 'load') _actionLoad(name).catch(e => _toast(`Load failed: ${e.message}`, 'error'));
      else if (action === 'rename') _actionRename(name).catch(e => _toast(`Rename failed: ${e.message}`, 'error'));
      else if (action === 'clone') _actionClone(name).catch(e => _toast(`Clone failed: ${e.message}`, 'error'));
      else if (action === 'export') _actionExportBundle(name).catch(e => _toast(`Export failed: ${e.message}`, 'error'));
      else if (action === 'template') _actionSaveTemplate(name).catch(e => _toast(`Template save failed: ${e.message}`, 'error'));
      else if (action === 'delete') _actionDelete(name).catch(e => _toast(`Delete failed: ${e.message}`, 'error'));
      else if (action === 'from-tpl') _actionCreateFromTemplate(tpl).catch(e => _toast(`Create from template failed: ${e.message}`, 'error'));
    });
  });

  pane.querySelectorAll('.pfx-dash-project-row').forEach(row => {
    row.addEventListener('dblclick', () => _actionLoad(row.dataset.project));
  });
}

/* ─── init ────────────────────────────────────────────────────────────────── */
async function _init() {
  try {
    const dir = await getStoredProjectDir();
    window._pfxDashHasDir = !!dir;
  } catch { window._pfxDashHasDir = false; }

  await _refreshList();
  _render();

  document.addEventListener('pfx:tab-activated', async e => {
    if (e.detail?.tab === 'dashboard') {
      try { const dir = await getStoredProjectDir(); window._pfxDashHasDir = !!dir; } catch { window._pfxDashHasDir = false; }
      await _refreshList();
      _render();
    }
  });

  document.addEventListener('pfx:project-applied', e => {
    if (e.detail?.projectName) _selectedProject = e.detail.projectName;
    _render();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _init);
} else {
  _init();
}
