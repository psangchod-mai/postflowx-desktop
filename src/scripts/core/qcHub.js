(function () {
  'use strict';

  /* ─── provider registry ─────────────────────────────────────────────────── */
  const _providers = {};

  function PFX_QC_registerProvider(id, fn) {
    if (typeof fn !== 'function') return;
    _providers[id] = fn;
  }

  /* ─── built-in providers ─────────────────────────────────────────────────── */
  function _collectReviews() {
    const items = [];
    try {
      const state = (typeof PFX_exportReviewsState === 'function')
        ? PFX_exportReviewsState()
        : window.__PFX_REVIEWS_STATE;
      if (!state) return items;
      const list = Array.isArray(state) ? state : (state.reviews || state.items || []);
      list.forEach((r, i) => {
        items.push({
          id: r.id || `review-${i}`,
          source: 'visual_qc',
          shotName: r.shotName || r.shot || r.clipName || '',
          timecode: r.timecode || r.tc || '',
          severity: _normSeverity(r.severity || r.type),
          status: r.status || r.state || 'open',
          category: 'visual',
          message: r.comment || r.note || r.message || '',
          roi: r.roi || null,
          thumbnailRef: r.thumbnailRef || r.thumb || null,
          validationCode: r.code || null,
          raw: r
        });
      });
    } catch (e) { /* ignore */ }
    return items;
  }

  function _collectIMF() {
    const items = [];
    try {
      const state = (typeof PFX_exportIMFState === 'function')
        ? PFX_exportIMFState()
        : window.__PFX_IMF_STATE;
      if (!state) return items;
      const results = state.validationResults || state.results || [];
      results.forEach((r, i) => {
        items.push({
          id: r.id || `imf-${i}`,
          source: 'imf_validation',
          shotName: r.assetPath || r.shotName || r.file || '',
          timecode: r.timecode || '',
          severity: _normSeverity(r.severity || r.level),
          status: r.pass === false ? 'fail' : (r.pass === true ? 'pass' : 'open'),
          category: 'technical',
          message: r.message || r.error || '',
          roi: null,
          thumbnailRef: null,
          validationCode: r.code || r.ruleId || null,
          raw: r
        });
      });
    } catch (e) { /* ignore */ }
    return items;
  }

  function _collectEXR() {
    const items = [];
    try {
      const state = window.__PFX_EXR_QC_STATE;
      if (!state) return items;
      const results = Array.isArray(state) ? state : (state.results || []);
      results.forEach((r, i) => {
        items.push({
          id: r.id || `exr-${i}`,
          source: 'exr_qc',
          shotName: r.shotName || r.file || '',
          timecode: r.timecode || '',
          severity: _normSeverity(r.severity),
          status: r.status || 'open',
          category: 'technical',
          message: r.message || '',
          roi: null,
          thumbnailRef: null,
          validationCode: r.code || null,
          raw: r
        });
      });
    } catch (e) { /* ignore */ }
    return items;
  }

  function _collectPreflight() {
    const items = [];
    try {
      if (typeof window.PFX_Preflight === 'undefined') return items;
      const results = window.PFX_Preflight.getLastResults ? window.PFX_Preflight.getLastResults() : [];
      results.forEach((r, i) => {
        if (r.status === 'pass' || r.status === 'skip') return;
        items.push({
          id: r.ruleId || `preflight-${i}`,
          source: 'preflight',
          shotName: r.label || r.ruleId || '',
          timecode: '',
          severity: r.status === 'fail' ? 'error' : 'warning',
          status: r.status,
          category: r.category || 'project',
          message: r.message || '',
          roi: null,
          thumbnailRef: null,
          validationCode: r.ruleId || null,
          raw: r
        });
      });
    } catch (e) { /* ignore */ }
    return items;
  }

  function _collectCutDiff() {
    const items = [];
    try {
      const state = window.__MPS_CD_SNAPSHOT;
      if (!state) return items;
      const notes = state.notes || state.changes || [];
      notes.forEach((n, i) => {
        items.push({
          id: n.id || `cutdiff-${i}`,
          source: 'cut_diff',
          shotName: n.shotName || n.clipName || n.shot || '',
          timecode: n.timecode || n.tc || '',
          severity: _normSeverity(n.severity || 'warning'),
          status: n.status || 'open',
          category: 'editorial',
          message: n.note || n.message || n.description || '',
          roi: null,
          thumbnailRef: null,
          validationCode: null,
          raw: n
        });
      });
    } catch (e) { /* ignore */ }
    return items;
  }

  function _normSeverity(raw) {
    if (!raw) return 'warning';
    const s = String(raw).toLowerCase();
    if (s === 'error' || s === 'fail' || s === 'critical') return 'error';
    if (s === 'info' || s === 'note' || s === 'pass') return 'info';
    return 'warning';
  }

  /* ─── built-in provider registration ────────────────────────────────────── */
  PFX_QC_registerProvider('visual_qc', _collectReviews);
  PFX_QC_registerProvider('imf_validation', _collectIMF);
  PFX_QC_registerProvider('exr_qc', _collectEXR);
  PFX_QC_registerProvider('preflight', _collectPreflight);
  PFX_QC_registerProvider('cut_diff', _collectCutDiff);

  /* ─── collect ────────────────────────────────────────────────────────────── */
  function PFX_QC_collect() {
    const items = [];
    Object.values(_providers).forEach(fn => {
      try { items.push(...fn()); } catch (e) { /* ignore */ }
    });
    return items;
  }

  /* ─── export JSON ────────────────────────────────────────────────────────── */
  function PFX_QC_exportJSON() {
    const items = PFX_QC_collect();
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), count: items.length, items }, null, 2)], { type: 'application/json' });
    _triggerDownload(blob, `qc_report_${_dateStr()}.json`);
    return items;
  }

  /* ─── export CSV ─────────────────────────────────────────────────────────── */
  function PFX_QC_exportCSV() {
    const items = PFX_QC_collect();
    const COLS = ['id','source','shotName','timecode','severity','status','category','message','validationCode'];
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [COLS.join(','), ...items.map(r => COLS.map(c => esc(r[c])).join(','))];
    const blob = new Blob([rows.join('\r\n')], { type: 'text/csv' });
    _triggerDownload(blob, `qc_report_${_dateStr()}.csv`);
    return items;
  }

  /* ─── export HTML ────────────────────────────────────────────────────────── */
  const _TEMPLATES = {
    creative_qc: { title: 'Creative QC Report', sources: ['visual_qc', 'cut_diff'] },
    technical_qc: { title: 'Technical QC Report', sources: ['imf_validation', 'exr_qc', 'preflight'] },
    vendor_package: { title: 'Vendor Package QC', sources: null }
  };

  function PFX_QC_exportHTML(templateId = 'technical_qc') {
    const tpl = _TEMPLATES[templateId] || _TEMPLATES.technical_qc;
    let items = PFX_QC_collect();
    if (tpl.sources) items = items.filter(r => tpl.sources.includes(r.source));
    const sevColor = { error: '#e55', warning: '#fa0', info: '#4a9' };
    const rows = items.map(r => `
      <tr>
        <td>${_esc(r.shotName)}</td>
        <td>${_esc(r.timecode)}</td>
        <td style="color:${sevColor[r.severity]||'#fff'}">${r.severity.toUpperCase()}</td>
        <td>${_esc(r.category)}</td>
        <td>${_esc(r.source)}</td>
        <td>${_esc(r.status)}</td>
        <td>${_esc(r.message)}</td>
        <td>${_esc(r.validationCode)}</td>
      </tr>`).join('');
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<title>${tpl.title}</title>
<style>
body{font-family:sans-serif;background:#111;color:#eee;padding:24px}
h1{font-size:1.4rem;margin-bottom:4px}
.meta{color:#888;font-size:.85rem;margin-bottom:20px}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{background:#222;padding:8px;text-align:left;border-bottom:1px solid #333}
td{padding:7px 8px;border-bottom:1px solid #1e1e1e;vertical-align:top}
tr:hover td{background:#1a1a1a}
@media print{body{background:#fff;color:#000}th{background:#eee}tr:hover td{background:none}}
</style>
</head><body>
<h1>${tpl.title}</h1>
<div class="meta">Generated: ${new Date().toLocaleString()} &bull; ${items.length} item(s)</div>
<table>
<thead><tr><th>Shot</th><th>TC</th><th>Severity</th><th>Category</th><th>Source</th><th>Status</th><th>Message</th><th>Code</th></tr></thead>
<tbody>${rows || '<tr><td colspan="8" style="text-align:center;color:#666;padding:32px">No QC items</td></tr>'}</tbody>
</table>
</body></html>`;
    const blob = new Blob([html], { type: 'text/html' });
    _triggerDownload(blob, `qc_report_${_dateStr()}.html`);
    return items;
  }

  /* ─── submit to Render Queue ─────────────────────────────────────────────── */
  function _submitToRenderQueue(format, templateId) {
    const fn = window.PFX_RQ_addJob || window.__rqAddJob;
    if (typeof fn !== 'function') return;
    fn({
      type: 'qc',
      fmt: 'qc_export',
      label: `QC Export — ${format.toUpperCase()}${templateId ? ' (' + templateId + ')' : ''}`,
      params: { format, templateId },
      priority: 5
    });
  }

  /* ─── helpers ────────────────────────────────────────────────────────────── */
  function _triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
  }

  function _dateStr() {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }

  function _esc(v) {
    return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function _sevRank(s) { return s === 'error' ? 2 : s === 'warning' ? 1 : 0; }

  /* ─── UI ─────────────────────────────────────────────────────────────────── */
  const SOURCE_LABELS = {
    visual_qc: 'Visual QC',
    imf_validation: 'IMF',
    exr_qc: 'EXR QC',
    preflight: 'Preflight',
    cut_diff: 'Cut Diff'
  };

  let _activeSource = 'all';
  let _activeSev = 'all';

  // Module-scope refs so _closeHtmlMenu uses a stable function reference across renders.
  let _htmlMenuToggleRef = null;
  let _htmlMenuRef = null;
  function _closeHtmlMenu(e) {
    if (!_htmlMenuToggleRef?.contains(e.target) && !_htmlMenuRef?.contains(e.target))
      _htmlMenuRef?.classList.remove('is-open');
  }

  function _render() {
    const el = document.getElementById('main-qchub');
    if (!el) return;

    const items = PFX_QC_collect();
    const filtered = items.filter(r => {
      if (_activeSource !== 'all' && r.source !== _activeSource) return false;
      if (_activeSev !== 'all' && r.severity !== _activeSev) return false;
      return true;
    });

    const errCount = items.filter(r => r.severity === 'error').length;
    const warnCount = items.filter(r => r.severity === 'warning').length;
    const sourceGroups = {};
    items.forEach(r => { sourceGroups[r.source] = (sourceGroups[r.source] || 0) + 1; });

    const sourceChips = ['all', ...Object.keys(SOURCE_LABELS)].map(s => {
      const cnt = s === 'all' ? items.length : (sourceGroups[s] || 0);
      const label = s === 'all' ? 'All' : SOURCE_LABELS[s];
      return `<button class="pfx-qchub-chip${_activeSource === s ? ' is-active' : ''}" data-src="${s}">${label}<span class="pfx-qchub-chip-cnt">${cnt}</span></button>`;
    }).join('');

    const sevChips = ['all', 'error', 'warning', 'info'].map(s => {
      const cnt = s === 'all' ? items.length : items.filter(r => r.severity === s).length;
      return `<button class="pfx-qchub-chip pfx-qchub-chip--sev pfx-qchub-chip--sev-${s}${_activeSev === s ? ' is-active' : ''}" data-sev="${s}">${s === 'all' ? 'All sev.' : s.charAt(0).toUpperCase() + s.slice(1)}<span class="pfx-qchub-chip-cnt">${cnt}</span></button>`;
    }).join('');

    const bodyRows = filtered.length ? filtered.sort((a, b) => _sevRank(b.severity) - _sevRank(a.severity)).map(r => `
      <tr data-id="${_esc(r.id)}" data-src="${r.source}">
        <td><span class="pfx-qchub-sev pfx-qchub-sev--${r.severity || 'warning'}">${(r.severity || 'warning')[0].toUpperCase()}</span></td>
        <td class="pfx-qchub-td-shot">${_esc(r.shotName)}</td>
        <td>${_esc(r.timecode)}</td>
        <td><span class="pfx-qchub-source-badge">${SOURCE_LABELS[r.source] || r.source}</span></td>
        <td>${_esc(r.category)}</td>
        <td><span class="pfx-qchub-status pfx-qchub-status--${(r.status ?? 'open').toLowerCase().replace(/\s+/g,'-')}">${_esc(r.status)}</span></td>
        <td class="pfx-qchub-td-msg">${_esc(r.message)}</td>
        <td class="pfx-qchub-td-code">${_esc(r.validationCode)}</td>
      </tr>`).join('')
      : `<tr><td colspan="8" class="pfx-qchub-empty">No QC items match current filter</td></tr>`;

    el.innerHTML = `
<div class="pfx-qchub-root">
  <div class="pfx-qchub-header">
    <div class="pfx-qchub-title">
      <span class="pfx-qchub-title-text">QC Hub</span>
      <span class="pfx-qchub-badge pfx-qchub-badge--error">${errCount} error${errCount !== 1 ? 's' : ''}</span>
      <span class="pfx-qchub-badge pfx-qchub-badge--warn">${warnCount} warning${warnCount !== 1 ? 's' : ''}</span>
    </div>
    <div class="pfx-qchub-actions">
      <button class="pfx-qchub-btn" id="pfx-qc-refresh" title="Re-collect from all providers">↻ Refresh</button>
      <div class="pfx-qchub-export-group">
        <button class="pfx-qchub-btn pfx-qchub-btn--primary" id="pfx-qc-export-json">⬇ JSON</button>
        <button class="pfx-qchub-btn pfx-qchub-btn--primary" id="pfx-qc-export-csv">⬇ CSV</button>
        <div class="pfx-qchub-dropdown-wrap">
          <button class="pfx-qchub-btn pfx-qchub-btn--primary" id="pfx-qc-export-html-toggle">⬇ HTML ▾</button>
          <div class="pfx-qchub-dropdown" id="pfx-qc-html-menu">
            <button data-tpl="creative_qc">Creative QC</button>
            <button data-tpl="technical_qc">Technical QC</button>
            <button data-tpl="vendor_package">Vendor Package</button>
          </div>
        </div>
        <button class="pfx-qchub-btn" id="pfx-qc-send-rq" title="Submit export job to Render Queue">→ Render Queue</button>
      </div>
    </div>
  </div>

  <div class="pfx-qchub-filters">
    <div class="pfx-qchub-chips" id="pfx-qc-src-chips">${sourceChips}</div>
    <div class="pfx-qchub-chips pfx-qchub-chips--sev" id="pfx-qc-sev-chips">${sevChips}</div>
  </div>

  <div class="pfx-qchub-table-wrap">
    <table class="pfx-qchub-table">
      <thead><tr>
        <th style="width:36px"></th>
        <th>Shot / Asset</th>
        <th style="width:96px">TC</th>
        <th style="width:108px">Source</th>
        <th style="width:96px">Category</th>
        <th style="width:80px">Status</th>
        <th>Message</th>
        <th style="width:100px">Code</th>
      </tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </div>
</div>`;

    /* event listeners */
    el.querySelector('#pfx-qc-refresh')?.addEventListener('click', _render);
    el.querySelector('#pfx-qc-export-json')?.addEventListener('click', () => PFX_QC_exportJSON());
    el.querySelector('#pfx-qc-export-csv')?.addEventListener('click', () => PFX_QC_exportCSV());

    const htmlToggle = el.querySelector('#pfx-qc-export-html-toggle');
    const htmlMenu = el.querySelector('#pfx-qc-html-menu');
    htmlToggle?.addEventListener('click', () => htmlMenu?.classList.toggle('is-open'));
    el.querySelectorAll('#pfx-qc-html-menu [data-tpl]').forEach(btn => {
      btn.addEventListener('click', () => { htmlMenu?.classList.remove('is-open'); PFX_QC_exportHTML(btn.dataset.tpl); });
    });
    _htmlMenuToggleRef = htmlToggle;
    _htmlMenuRef = htmlMenu;
    document.removeEventListener('click', _closeHtmlMenu, true);
    document.addEventListener('click', _closeHtmlMenu, true);
    // Also wire cleanup on tab deactivation so the listener doesn't persist indefinitely:
    // (add to _init): document.addEventListener('pfx:tab-deactivated', () => document.removeEventListener('click', _closeHtmlMenu, true));

    el.querySelector('#pfx-qc-send-rq')?.addEventListener('click', () => _submitToRenderQueue('html', 'technical_qc'));

    el.querySelectorAll('#pfx-qc-src-chips [data-src]').forEach(btn => {
      btn.addEventListener('click', () => { _activeSource = btn.dataset.src; _render(); });
    });
    el.querySelectorAll('#pfx-qc-sev-chips [data-sev]').forEach(btn => {
      btn.addEventListener('click', () => { _activeSev = btn.dataset.sev; _render(); });
    });
  }

  /* ─── init ────────────────────────────────────────────────────────────────── */
  function _init() {
    document.addEventListener('pfx:tab-activated', e => {
      if (e.detail?.tab === 'qchub') _render();
    });
    document.addEventListener('pfx:project-applied', _render);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  /* ─── public API ─────────────────────────────────────────────────────────── */
  window.PFX_QC_collect = PFX_QC_collect;
  window.PFX_QC_exportJSON = PFX_QC_exportJSON;
  window.PFX_QC_exportCSV = PFX_QC_exportCSV;
  window.PFX_QC_exportHTML = PFX_QC_exportHTML;
  window.PFX_QC_registerProvider = PFX_QC_registerProvider;

})();
