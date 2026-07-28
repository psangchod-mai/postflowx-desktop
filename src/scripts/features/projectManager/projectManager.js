// projectManager.js — Resolve-style Project Manager (PFXMAC).
//
// ONE unified picker that replaces the inline name-dropdown + the old Open modal.
// Lists projects from the configured Project Folder (pfx:listProjects) in a
// sortable table (Name · Date Modified · Date Created · Path) with search.
// Resolves to an action the caller performs:
//   { action:'open', name } | { action:'new' } | { action:'browse' } | null
'use strict';

import { friendlyAlert } from '../../core/friendlyAlert.js';

const _esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Friendly labels for the per-project tool shards (the "what is this project for")
const _TAB_LABELS = {
  cut_diff:     'Cut Diff',
  pull_prep:    'Pulls Prep',
  markers:      'Markers',
  shots:        'Shots',
  plate_link:   'Plate Link',
  imf:          'IMF',
  review:       'Reviews',
  trl_conf:     'Trailers',
  aces_look:    'ACES Look',
  render_queue: 'Render Q',
};

// Per-tool signature colours — matched to the app's top-tab glow palette so the
// Project Manager reads on-brand (each workflow gets its own accent).
const _TAB_COLORS = {
  cut_diff:     '#ffad33',
  pull_prep:    '#42d7ff',
  markers:      '#b8ff5a',
  shots:        '#7affc0',
  plate_link:   '#3de0c8',
  imf:          '#ff5fd4',
  review:       '#5ad1ff',
  trl_conf:     '#b97aff',
  aces_look:    '#ff9d3d',
  render_queue: '#8a9bff',
};

// Line-icon glyphs for the radial right-click menu (stroke = currentColor).
const _ICONS = {
  open:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg>',
  reveal:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  rename:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  duplicate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  delete:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
};

// #rrggbb → rgba(...) with alpha (for tinted chip/tile fills & borders).
function _hexA(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return `rgba(107,124,255,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

// A project's primary colour = the colour of its largest (primary) tool shard.
function _projColor(p) {
  const k = (Array.isArray(p.tabs) && p.tabs[0] && p.tabs[0].key) || '';
  return _TAB_COLORS[k] || '#6b7cff';
}

// Smart catalog: render small colour-coded chips for the tools a project uses.
function _tabChips(tabs) {
  if (!Array.isArray(tabs) || !tabs.length) {
    return `<div class="pfx-pm-tabs"><span class="pfx-pm-tab-empty">empty project</span></div>`;
  }
  const chips = tabs
    .filter(t => _TAB_LABELS[t.key])
    .map(t => {
      const c = _TAB_COLORS[t.key] || '#6b7cff';
      return `<span class="pfx-pm-tabchip" style="color:${c};background:${_hexA(c, .14)};border-color:${_hexA(c, .4)}">${_esc(_TAB_LABELS[t.key])}</span>`;
    })
    .join('');
  return `<div class="pfx-pm-tabs">${chips}</div>`;
}

function _fmtDate(ms) {
  if (!ms) return '—';
  try {
    const d = new Date(ms);
    const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    const p = n => String(n).padStart(2, '0');
    return `${mo} ${p(d.getDate())} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch { return '—'; }
}

// Day index (local midnight, days since epoch) for "same day" / bucket math.
function _dayIndex(ms) {
  const d = new Date(ms);
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 86400000);
}

// Relative "smart" date for the row (exact timestamp goes in the title attribute).
function _relDate(ms) {
  if (!ms) return '—';
  try {
    const now = Date.now();
    const diff = now - ms;
    const min = 60000, hr = 3600000, day = 86400000;
    if (diff < 0) return _fmtDate(ms);
    if (diff < min) return 'just now';
    if (diff < hr)  return `${Math.floor(diff / min)} min ago`;
    const today = _dayIndex(now), d = _dayIndex(ms);
    if (d === today)     return `${Math.floor(diff / hr) || 1} hr ago`;
    if (d === today - 1) return 'Yesterday';
    if (today - d < 7)   return `${today - d} days ago`;
    const dd = new Date(ms);
    const mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][dd.getMonth()];
    return `${mo} ${dd.getDate()}, ${dd.getFullYear()}`;
  } catch { return _fmtDate(ms); }
}

// Bucket for date grouping headers. Lower order = nearer to now.
function _dateBucket(ms) {
  if (!ms) return { order: 4, label: 'Undated' };
  const today = _dayIndex(Date.now()), d = _dayIndex(ms);
  if (d >= today)      return { order: 0, label: 'Today' };
  if (d === today - 1) return { order: 1, label: 'Yesterday' };
  if (today - d < 7)   return { order: 2, label: 'Previous 7 Days' };
  return { order: 3, label: 'Older' };
}

function _injectStyle() {
  if (document.getElementById('pfx-pm-style')) return;
  const st = document.createElement('style');
  st.id = 'pfx-pm-style';
  st.textContent = `
  .pfx-pm-ov { position:fixed; inset:0; z-index:9000; background:rgba(0,0,0,.6);
    display:flex; align-items:center; justify-content:center; }
  .pfx-pm { width:880px; max-width:94vw; height:600px; max-height:88vh; display:flex; flex-direction:column;
    background:#1b1b22; border:1px solid #303040; border-radius:10px; box-shadow:0 24px 70px rgba(0,0,0,.65);
    color:#d6d6e0; font-size:12px; overflow:hidden; }
  .pfx-pm-top { display:flex; align-items:center; gap:12px; padding:12px 16px; border-bottom:1px solid #2a2a36;
    background:linear-gradient(180deg, rgba(33,114,227,.10), rgba(33,114,227,0) 90%); }
  .pfx-pm-title { font-size:15px; font-weight:700; color:#fff; }
  .pfx-pm-search { margin-left:auto; width:240px; background:#0e0e14; border:1px solid #2c2c3a; border-radius:6px;
    color:#ddd; font-size:12px; padding:5px 9px; outline:none; }
  .pfx-pm-search:focus { border-color:#4a8ce8; }
  .pfx-pm-x { background:none; border:0; color:#888; font-size:15px; cursor:pointer; padding:2px 6px; }
  .pfx-pm-x:hover { color:#fff; }
  .pfx-pm-dir { padding:6px 16px; font-size:10px; color:#7a7a8c; border-bottom:1px solid #2a2a36; display:flex; align-items:center; gap:10px; }
  .pfx-pm-dir-path { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; min-width:0; }
  .pfx-pm-dir-change { flex-shrink:0; background:none; border:0; color:#4a8ce8; font-size:10px; cursor:pointer; padding:2px 4px; }
  .pfx-pm-dir-change:hover { color:#8cc4ff; text-decoration:underline; }
  .pfx-pm-table { flex:1; display:flex; flex-direction:column; overflow:hidden; }
  .pfx-pm-head, .pfx-pm-row { display:grid; grid-template-columns:2.2fr 1.5fr 1.5fr 3fr; align-items:center; }
  .pfx-pm-head { padding:8px 16px; border-bottom:1px solid #2a2a36; color:#8a8a9c; font-weight:700; font-size:10px;
    text-transform:uppercase; letter-spacing:.04em; }
  .pfx-pm-head [data-sort] { cursor:pointer; user-select:none; }
  .pfx-pm-head [data-sort]:hover { color:#cfe0ff; }
  .pfx-pm-rows { flex:1; overflow:auto; }
  .pfx-pm-row { padding:9px 16px; border-bottom:1px solid #20202a; cursor:pointer; transition:background .1s; }
  .pfx-pm-row:hover { background:#23232f; }
  .pfx-pm-row:hover .pfx-pm-icon { transform:scale(1.06); }
  .pfx-pm-row.sel { background:var(--pm-accent-wash, rgba(33,114,227,.16)); box-shadow:inset 3px 0 0 var(--pm-accent, #2172E3); }
  .pfx-pm-hint { color:rgba(255,255,255,.4); font-size:11px; margin-left:10px; white-space:nowrap; }
  .pfx-pm-c-name { min-width:0; padding-right:10px; display:flex; align-items:center; gap:11px; }
  .pfx-pm-icon { width:34px; height:34px; flex-shrink:0; border-radius:9px; border:1px solid;
    display:flex; align-items:center; justify-content:center; font-weight:800; font-size:15px;
    transition:transform .12s ease; }
  .pfx-pm-name-wrap { min-width:0; }
  .pfx-pm-name-line { color:#fff; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pfx-pm-tabs { display:flex; flex-wrap:wrap; gap:4px; margin-top:4px; }
  .pfx-pm-tabchip { font-size:9px; font-weight:600; line-height:1.4; padding:1px 7px; border-radius:100px;
    background:rgba(33,114,227,.16); color:#4a8ce8; border:1px solid rgba(33,114,227,.32); white-space:nowrap; }
  .pfx-pm-tab-empty { font-size:9px; color:#5a5a66; font-style:italic; }
  .pfx-pm-c-mod, .pfx-pm-c-cre { color:#9a9aac; }
  .pfx-pm-c-path { color:#6a6a7c; font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .pfx-pm-empty { padding:28px 16px; color:#888; text-align:center; }
  .pfx-pm-foot { display:flex; align-items:center; gap:8px; padding:12px 16px; border-top:1px solid #2a2a36; }
  .pfx-pm-foot-r { margin-left:auto; display:flex; gap:8px; }
  .pfx-pm-btn { font-size:12px; padding:7px 16px; border-radius:7px; border:1px solid #34344a; background:#26262f; color:#ddd; cursor:pointer; }
  .pfx-pm-btn:hover { background:#30303c; }
  .pfx-pm-primary { background:#2f6fe0; border-color:#2f6fe0; color:#fff; }
  .pfx-pm-primary:hover { background:#3b7bf0; }
  .pfx-pm-primary:disabled { background:#2a2a3a; border-color:#2a2a3a; color:#666; cursor:default; }
  .pfx-pm-danger { border-color:#5a2a2a; color:#ff8d8d; }
  .pfx-pm-danger:hover { background:#3a2020; border-color:#7a3030; color:#ffb0b0; }
  .pfx-pm-danger:disabled { background:#26262f; border-color:#34344a; color:#555; cursor:default; }
  /* active sort column + direction arrow (makes the sortable headers discoverable) */
  .pfx-pm-head [data-sort].active { color:#cfe0ff; }
  .pfx-pm-sort-arrow { font-size:8px; opacity:.9; margin-left:3px; vertical-align:1px; }
  /* right-click context menu */
  .pfx-pm-menu { position:fixed; z-index:100000; min-width:150px; background:#1c1c26; border:1px solid #34344a;
    border-radius:8px; padding:4px; box-shadow:0 10px 32px rgba(0,0,0,.5); }
  .pfx-pm-menu button { display:block; width:100%; text-align:left; background:none; border:0; color:#ddd;
    font-size:12px; padding:7px 10px; border-radius:5px; cursor:pointer; }
  .pfx-pm-menu button:hover { background:#2f6fe0; color:#fff; }
  .pfx-pm-menu button.danger { color:#ff8d8d; }
  .pfx-pm-menu button.danger:hover { background:#7a3030; color:#fff; }
  .pfx-pm-menu-sep { height:1px; background:#2a2a36; margin:4px 2px; }
  /* filter bar: type chips + live count */
  .pfx-pm-filters { display:flex; align-items:center; gap:6px; padding:8px 16px; border-bottom:1px solid #2a2a36; flex-wrap:wrap; }
  .pfx-pm-fchip { font-size:11px; padding:3px 10px; border-radius:100px; border:1px solid #34344a;
    background:#22222c; color:#a6a6b8; cursor:pointer; user-select:none; white-space:nowrap; }
  .pfx-pm-fchip:hover { background:#2c2c38; color:#d8d8e6; }
  .pfx-pm-fchip.active { background:rgba(33,114,227,.22); border-color:#2f6fe0; color:#cfe0ff; }
  .pfx-pm-count { margin-left:auto; font-size:11px; color:#7a7a8c; white-space:nowrap; }
  /* date group headers */
  .pfx-pm-group { padding:7px 16px 5px; font-size:10px; font-weight:700; letter-spacing:.06em;
    text-transform:uppercase; color:#7a7a8c; background:#191921; border-bottom:1px solid #23232f;
    position:sticky; top:0; z-index:1; }
  .pfx-pm-c-mod, .pfx-pm-c-cre { cursor:default; }
  /* radial (pie) right-click menu — a ring of icon buttons around the cursor */
  .pfx-pm-radial { position:fixed; z-index:100000; width:0; height:0;
    opacity:0; transform:scale(.82); transform-origin:0 0;
    transition:opacity .12s ease, transform .16s cubic-bezier(.2,.85,.3,1.25); }
  .pfx-pm-radial.open { opacity:1; transform:scale(1); }
  .pfx-pm-rad-hub { position:absolute; left:0; top:0; width:66px; height:66px;
    transform:translate(-50%,-50%); border-radius:50%; background:#191921;
    border:1px solid #3a3a4c; display:flex; align-items:center; justify-content:center;
    box-shadow:0 10px 30px rgba(0,0,0,.55), inset 0 0 0 3px rgba(255,255,255,.02);
    cursor:pointer; padding:6px; }
  .pfx-pm-rad-hub:hover { border-color:#4a4a60; }
  .pfx-pm-rad-hub-label { max-width:56px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    font-weight:800; font-size:13px; }
  .pfx-pm-rad-item { position:absolute; left:0; top:0; width:48px; height:48px; border-radius:50%;
    background:#23232f; border:1px solid #3a3a4c; color:#cfcfe0;
    display:flex; align-items:center; justify-content:center; cursor:pointer;
    box-shadow:0 6px 20px rgba(0,0,0,.5);
    transition:background .12s, color .12s, border-color .12s, box-shadow .12s; }
  .pfx-pm-rad-item svg { width:21px; height:21px; }
  .pfx-pm-rad-item:hover { background:var(--pm-accent, #2172E3); border-color:var(--pm-accent, #2172E3);
    color:#0b0b12; box-shadow:0 0 0 4px var(--pm-accent-wash, rgba(33,114,227,.3)), 0 6px 20px rgba(0,0,0,.5); }
  .pfx-pm-rad-item.danger:hover { background:#e0554f; border-color:#e0554f; color:#fff;
    box-shadow:0 0 0 4px rgba(224,85,79,.28), 0 6px 20px rgba(0,0,0,.5); }
  `;
  document.head.appendChild(st);
}

export async function openProjectManager() {
  let pf = '';
  try { pf = localStorage.getItem('pfx_project_dir_path') || ''; } catch {}
  const list = (typeof window !== 'undefined') ? window.pfxPlatform?.listProjects : null;
  let projects = [];
  if (pf && typeof list === 'function') {
    try { const r = await list(pf); if (r && r.ok) projects = r.projects || []; } catch {}
  }

  return new Promise((resolve) => {
    _injectStyle();
    let sortKey = 'mtime', sortDir = -1, filter = '', selected = null;
    let typeFilter = 'all';   // 'all' or a tab key (e.g. 'imf', 'pull_prep')
    let viewNames = [];        // ordered names currently visible (for keyboard nav)
    let done = false;
    let _menuEl = null;
    const ov = document.createElement('div');
    ov.className = 'pfx-pm-ov';
    const close = (v) => { if (done) return; done = true; closeMenu(); try { ov.remove(); } catch {} document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => {
      if (done) return;
      if (e.key === 'Escape') { e.stopPropagation(); if (_menuEl) closeMenu(); else close(null); return; }
      const searchBox = modal.querySelector('.pfx-pm-search');
      const inSearch = document.activeElement === searchBox;
      if (e.key === 'ArrowDown') { e.preventDefault(); _moveSel(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); _moveSel(-1); return; }
      if (e.key === 'Enter')     { if (selected) { e.preventDefault(); close({ action: 'open', name: selected }); } return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && !inSearch) { if (selected) { e.preventDefault(); doDelete(selected); } return; }
      // Type-to-search: a printable char while not in the box focuses it so typing filters.
      if (!inSearch && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) searchBox?.focus();
    };

    const modal = document.createElement('div');
    modal.className = 'pfx-pm';
    modal.innerHTML = `
      <div class="pfx-pm-top">
        <div class="pfx-pm-title">Projects</div>
        <input class="pfx-pm-search" type="search" placeholder="Search projects…">
        <button class="pfx-pm-x" title="Close">✕</button>
      </div>
      <div class="pfx-pm-dir">
        <span class="pfx-pm-dir-path">${_esc(pf || 'No Project Folder set')}</span>
        <button class="pfx-pm-dir-change" type="button">${pf ? 'Change folder…' : 'Set Project Folder…'}</button>
      </div>
      <div class="pfx-pm-filters">
        <div class="pfx-pm-filter-chips"></div>
        <span class="pfx-pm-count"></span>
      </div>
      <div class="pfx-pm-table">
        <div class="pfx-pm-head">
          <div data-sort="name">Name</div>
          <div data-sort="mtime">Date Modified</div>
          <div data-sort="created">Date Created</div>
          <div>Path</div>
        </div>
        <div class="pfx-pm-rows"></div>
      </div>
      <div class="pfx-pm-foot">
        <button class="pfx-pm-btn pfx-pm-import">Import…</button>
        <button class="pfx-pm-btn pfx-pm-danger pfx-pm-delete" disabled>Delete</button>
        <span class="pfx-pm-hint">↑↓ navigate · ↵ or double-click to open · right-click for options</span>
        <div class="pfx-pm-foot-r">
          <button class="pfx-pm-btn pfx-pm-new">New Project</button>
          <button class="pfx-pm-btn pfx-pm-cancel">Cancel</button>
          <button class="pfx-pm-btn pfx-pm-primary pfx-pm-open" disabled>Open</button>
        </div>
      </div>`;
    ov.appendChild(modal);
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey, true);

    const rowsEl = modal.querySelector('.pfx-pm-rows');
    const openBtn = modal.querySelector('.pfx-pm-open');
    const deleteBtn = modal.querySelector('.pfx-pm-delete');
    const chipsEl = modal.querySelector('.pfx-pm-filter-chips');
    const countEl = modal.querySelector('.pfx-pm-count');

    const _projHasType = (p, key) => Array.isArray(p.tabs) && p.tabs.some(t => t.key === key);

    // Type filter chips — built once from the tool tabs present across projects.
    function _renderFilterChips() {
      const keys = [];
      for (const p of projects) for (const t of (p.tabs || [])) if (!keys.includes(t.key) && _TAB_LABELS[t.key]) keys.push(t.key);
      // Order chips by how many projects have each type (most common first).
      keys.sort((a, b) => projects.filter(p => _projHasType(p, b)).length - projects.filter(p => _projHasType(p, a)).length);
      const chip = (val, label) => `<span class="pfx-pm-fchip${typeFilter === val ? ' active' : ''}" data-type="${_esc(val)}">${_esc(label)}</span>`;
      chipsEl.innerHTML = chip('all', 'All') + keys.map(k => chip(k, _TAB_LABELS[k])).join('');
    }

    const render = () => {
      const f = filter.toLowerCase();
      const view = projects
        .filter(p => !f || (p.name || '').toLowerCase().includes(f) || (p.path || '').toLowerCase().includes(f))
        .filter(p => typeFilter === 'all' || _projHasType(p, typeFilter))
        .sort((a, b) => {
          const av = sortKey === 'name' ? (a.name || '').toLowerCase() : (a[sortKey] || 0);
          const bv = sortKey === 'name' ? (b.name || '').toLowerCase() : (b[sortKey] || 0);
          return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
        });

      const rowHtml = (p) => {
        const c = _projColor(p);
        const initial = _esc(((p.name || '?').trim().charAt(0) || '?').toUpperCase());
        return `<div class="pfx-pm-row${selected === p.name ? ' sel' : ''}" data-name="${_esc(p.name)}" style="--pm-accent:${c};--pm-accent-wash:${_hexA(c, .15)}">
            <div class="pfx-pm-c-name">
              <div class="pfx-pm-icon" style="color:${c};background:${_hexA(c, .16)};border-color:${_hexA(c, .45)}">${initial}</div>
              <div class="pfx-pm-name-wrap">
                <div class="pfx-pm-name-line">${_esc(p.name)}</div>
                ${_tabChips(p.tabs)}
              </div>
            </div>
            <div class="pfx-pm-c-mod" title="${_esc(_fmtDate(p.mtime))}">${_esc(_relDate(p.mtime))}</div>
            <div class="pfx-pm-c-cre" title="${_esc(_fmtDate(p.created))}">${_esc(_relDate(p.created))}</div>
            <div class="pfx-pm-c-path" title="${_esc(p.path)}">${_esc(p.path)}</div></div>`;
      };

      if (!view.length) {
        rowsEl.innerHTML = `<div class="pfx-pm-empty">${(filter || typeFilter !== 'all')
          ? 'No projects match the current search / filter.'
          : 'No projects in this folder yet. Create one with <b>New Project</b>, or <b>Import…</b> a project file.'}</div>`;
      } else if (sortKey === 'name') {
        // Flat list when sorting by name (grouping by date would be meaningless).
        rowsEl.innerHTML = view.map(rowHtml).join('');
      } else {
        // Group under Today / Yesterday / Previous 7 Days / Older headers.
        const key = sortKey;
        let html = '', lastBucket = null;
        for (const p of view) {
          const b = _dateBucket(p[key]);
          if (b.label !== lastBucket) { html += `<div class="pfx-pm-group">${_esc(b.label)}</div>`; lastBucket = b.label; }
          html += rowHtml(p);
        }
        rowsEl.innerHTML = html;
      }
      viewNames = view.map(p => p.name);

      // Auto-select: keep a valid selection (most-recent/first when none or filtered out).
      if (!viewNames.includes(selected)) selected = viewNames[0] || null;

      // Sort indicator: mark the active column and show a ▲/▼ direction arrow.
      modal.querySelectorAll('.pfx-pm-head [data-sort]').forEach(h => {
        const base = h.dataset.label || (h.dataset.label = h.textContent.trim());
        const active = h.dataset.sort === sortKey;
        h.classList.toggle('active', active);
        h.innerHTML = _esc(base) + (active ? ` <span class="pfx-pm-sort-arrow">${sortDir < 0 ? '▼' : '▲'}</span>` : '');
      });
      // Live count
      const total = projects.length;
      countEl.textContent = viewNames.length === total
        ? `${total} project${total === 1 ? '' : 's'}`
        : `${viewNames.length} of ${total}`;
      // Reflect selection on the freshly-built rows.
      rowsEl.querySelectorAll('.pfx-pm-row').forEach(x => x.classList.toggle('sel', x.dataset.name === selected));
      openBtn.disabled = !selected;
      if (deleteBtn) deleteBtn.disabled = !selected;
    };
    _renderFilterChips();
    render();

    const searchEl = modal.querySelector('.pfx-pm-search');
    searchEl.addEventListener('input', (e) => { filter = e.target.value; render(); });
    modal.querySelectorAll('.pfx-pm-head [data-sort]').forEach(h => h.addEventListener('click', () => {
      const k = h.dataset.sort;
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = (k === 'name') ? 1 : -1; }
      render();
    }));
    // Type filter chips.
    chipsEl.addEventListener('click', (e) => {
      const c = e.target.closest('.pfx-pm-fchip'); if (!c) return;
      typeFilter = c.dataset.type;
      _renderFilterChips();
      render();
    });
    // Select in place — do NOT re-render here. render() rebuilds rowsEl.innerHTML,
    // which replaces the row node between the two clicks of a double-click, so the
    // browser never fires 'dblclick' (it requires both clicks on the same element).
    const _markSelected = (scroll) => {
      rowsEl.querySelectorAll('.pfx-pm-row').forEach(x => x.classList.toggle('sel', x.dataset.name === selected));
      openBtn.disabled = !selected;
      if (deleteBtn) deleteBtn.disabled = !selected;
      if (scroll && selected) {
        const el = rowsEl.querySelector(`.pfx-pm-row[data-name="${(window.CSS && CSS.escape) ? CSS.escape(selected) : selected}"]`);
        el?.scrollIntoView({ block: 'nearest' });
      }
    };
    // Keyboard navigation: ↑/↓ move selection, Enter opens, ⌫/Delete removes.
    const _moveSel = (delta) => {
      if (!viewNames.length) return;
      const i = Math.max(0, viewNames.indexOf(selected));
      selected = viewNames[Math.min(viewNames.length - 1, Math.max(0, i + delta))];
      _markSelected(true);
    };
    rowsEl.addEventListener('click', (e) => { const r = e.target.closest('.pfx-pm-row'); if (r) { selected = r.dataset.name; _markSelected(); } });
    rowsEl.addEventListener('dblclick', (e) => { const r = e.target.closest('.pfx-pm-row'); if (r) close({ action: 'open', name: r.dataset.name }); });
    openBtn.addEventListener('click', () => { if (selected) close({ action: 'open', name: selected }); });

    // Shared delete logic (used by the Delete button and the right-click menu).
    async function doDelete(name) {
      const proj = projects.find(p => p.name === name);
      if (!proj) return;
      const ok = (typeof window !== 'undefined' && typeof window.confirm === 'function')
        ? window.confirm(`Move project "${proj.name}" to the Trash?\n\n${proj.path}`)
        : true;
      if (!ok) return;
      const del = window.pfxPlatform?.deleteProject;
      if (typeof del !== 'function') return;
      let r = null;
      try { r = await del({ dirPath: pf, targetPath: proj.path, name: proj.name }); } catch {}
      if (r && r.ok) {
        projects = projects.filter(p => p.name !== name);
        if (selected === name) selected = null;
      } else {
        friendlyAlert(`${proj.name}: ${r?.error || 'unknown error'}`, 'Deleting project failed');
      }
      render();
    }
    deleteBtn.addEventListener('click', () => { if (selected) doDelete(selected); });

    // Reveal the project on disk (macOS Finder / OS file browser).
    async function doReveal(name) {
      const proj = projects.find(p => p.name === name);
      if (proj) { try { await window.pfxPlatform?.revealInFinder?.(proj.path); } catch {} }
    }
    // Rename the project folder in place.
    async function doRename(name) {
      const proj = projects.find(p => p.name === name);
      if (!proj) return;
      const nn = (typeof window.prompt === 'function') ? window.prompt(`Rename project "${proj.name}" to:`, proj.name) : null;
      if (nn == null) return;
      const clean = nn.trim();
      if (!clean || clean === proj.name) return;
      const fn = window.pfxPlatform?.renameProject;
      if (typeof fn !== 'function') return;
      let r = null;
      try { r = await fn({ dirPath: pf, targetPath: proj.path, newName: clean }); } catch {}
      if (r && r.ok) {
        if (selected === proj.name) selected = r.name || clean;
        proj.name = r.name || clean;
        proj.path = r.path || proj.path;
        _renderFilterChips(); render();
      } else { friendlyAlert(`${proj.name}: ${r?.error || 'unknown error'}`, 'Renaming project failed'); }
    }
    // Duplicate the project folder under a new name.
    async function doDuplicate(name) {
      const proj = projects.find(p => p.name === name);
      if (!proj) return;
      const nn = (typeof window.prompt === 'function') ? window.prompt(`Duplicate "${proj.name}" as:`, `${proj.name} copy`) : null;
      if (nn == null) return;
      const clean = nn.trim();
      if (!clean) return;
      const fn = window.pfxPlatform?.duplicateProject;
      if (typeof fn !== 'function') return;
      let r = null;
      try { r = await fn({ dirPath: pf, targetPath: proj.path, newName: clean }); } catch {}
      if (r && r.ok) {
        const now = Date.now();
        projects.push({ ...proj, name: r.name || clean, path: r.path || proj.path, mtime: now, created: now });
        selected = r.name || clean;
        _renderFilterChips(); render();
      } else { friendlyAlert(`${proj.name}: ${r?.error || 'unknown error'}`, 'Duplicating project failed'); }
    }

    // ── Right-click context menu (Open · Reveal · Rename · Duplicate · Delete) ──
    function closeMenu() {
      if (!_menuEl) return;
      try { _menuEl.remove(); } catch {}
      _menuEl = null;
      document.removeEventListener('mousedown', _onDocDown, true);
      document.removeEventListener('scroll', closeMenu, true);
      window.removeEventListener('blur', closeMenu);
    }
    function _onDocDown(e) { if (_menuEl && !_menuEl.contains(e.target)) closeMenu(); }
    // Radial (pie) menu: a ring of icon buttons around the cursor. The center hub
    // shows the project's coloured initial at rest and the hovered action's name.
    function showRowMenu(x, y, name) {
      closeMenu();
      const proj = projects.find(p => p.name === name);
      const accent = proj ? _projColor(proj) : '#6b7cff';
      const initial = _esc(((proj?.name || name || '?').trim().charAt(0) || '?').toUpperCase());
      const items = [
        { act: 'open',      label: 'Open',      icon: _ICONS.open,      avail: true },
        { act: 'reveal',    label: 'Reveal',    icon: _ICONS.reveal,    avail: typeof window.pfxPlatform?.revealInFinder === 'function' },
        { act: 'rename',    label: 'Rename',    icon: _ICONS.rename,    avail: typeof window.pfxPlatform?.renameProject === 'function' },
        { act: 'duplicate', label: 'Duplicate', icon: _ICONS.duplicate, avail: typeof window.pfxPlatform?.duplicateProject === 'function' },
        { act: 'delete',    label: 'Delete',    icon: _ICONS.delete,    avail: true, danger: true },
      ].filter(i => i.avail);

      const m = document.createElement('div');
      m.className = 'pfx-pm-radial';
      m.style.setProperty('--pm-accent', accent);
      m.style.setProperty('--pm-accent-wash', _hexA(accent, .3));
      const R = 94, n = items.length;
      const btns = items.map((it, i) => {
        const ang = (-90 + i * (360 / n)) * Math.PI / 180;
        const bx = (Math.cos(ang) * R).toFixed(1), by = (Math.sin(ang) * R).toFixed(1);
        return `<button class="pfx-pm-rad-item${it.danger ? ' danger' : ''}" data-act="${it.act}" data-label="${_esc(it.label)}"
                  style="transform:translate(-50%,-50%) translate(${bx}px, ${by}px)" title="${_esc(it.label)}">${it.icon}</button>`;
      }).join('');
      m.innerHTML = `<div class="pfx-pm-rad-hub"><span class="pfx-pm-rad-hub-label" style="color:${accent}">${initial}</span></div>${btns}`;
      document.body.appendChild(m);

      // Center the ring at the cursor, clamped so the whole ring stays on-screen.
      const pad = R + 42;
      m.style.left = Math.max(pad, Math.min(x, window.innerWidth - pad)) + 'px';
      m.style.top  = Math.max(pad, Math.min(y, window.innerHeight - pad)) + 'px';

      const hubLabel = m.querySelector('.pfx-pm-rad-hub-label');
      m.addEventListener('mouseover', (e) => { const b = e.target.closest('.pfx-pm-rad-item'); if (b) { hubLabel.textContent = b.dataset.label; hubLabel.style.color = ''; } });
      m.addEventListener('mouseout',  (e) => { const b = e.target.closest('.pfx-pm-rad-item'); if (b) { hubLabel.textContent = initial; hubLabel.style.color = accent; } });
      m.addEventListener('click', (e) => {
        if (e.target.closest('.pfx-pm-rad-hub')) { closeMenu(); return; }   // center = cancel
        const b = e.target.closest('.pfx-pm-rad-item'); if (!b) return;
        const act = b.dataset.act;
        closeMenu();
        if (act === 'open') close({ action: 'open', name });
        else if (act === 'reveal') doReveal(name);
        else if (act === 'rename') doRename(name);
        else if (act === 'duplicate') doDuplicate(name);
        else if (act === 'delete') doDelete(name);
      });
      _menuEl = m;
      document.addEventListener('mousedown', _onDocDown, true);
      document.addEventListener('scroll', closeMenu, true);
      window.addEventListener('blur', closeMenu);
      requestAnimationFrame(() => m.classList.add('open'));
    }
    rowsEl.addEventListener('contextmenu', (e) => {
      const r = e.target.closest('.pfx-pm-row');
      if (!r) return;
      e.preventDefault();
      selected = r.dataset.name;
      _markSelected();
      showRowMenu(e.clientX, e.clientY, r.dataset.name);
    });
    modal.querySelector('.pfx-pm-new').addEventListener('click', () => close({ action: 'new' }));
    modal.querySelector('.pfx-pm-import').addEventListener('click', () => close({ action: 'browse' }));
    modal.querySelector('.pfx-pm-cancel').addEventListener('click', () => close(null));
    modal.querySelector('.pfx-pm-x').addEventListener('click', () => close(null));
    // Set/Change Project Folder: drive the existing (hidden) folder picker, then
    // close so the next open re-lists projects from the new folder.
    modal.querySelector('.pfx-pm-dir-change')?.addEventListener('click', () => {
      try { document.getElementById('projPickDir')?.click(); } catch {}
      close(null);
    });
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(null); });
  });
}
