(function () {
  'use strict';

  /* ─── rule registry ──────────────────────────────────────────────────────── */
  const _rules = [];
  let _lastResults = [];

  function registerRule(rule) {
    if (!rule || !rule.id || typeof rule.run !== 'function') return;
    const existing = _rules.findIndex(r => r.id === rule.id);
    if (existing >= 0) { _rules[existing] = rule; } else { _rules.push(rule); }
  }

  /* ─── run ─────────────────────────────────────────────────────────────────── */
  function run(context) {
    const ctx = context || _buildContext();
    const results = [];
    _rules.forEach(rule => {
      let res;
      try {
        res = rule.run(ctx);
      } catch (e) {
        res = { status: 'fail', message: `Rule error: ${e.message}` };
      }
      if (!res || typeof res !== 'object') res = { status: 'skip', message: '' };
      results.push({
        ruleId: rule.id,
        label: rule.label || rule.id,
        category: rule.category || 'project',
        severity: rule.severity || 'warn',
        status: res.status || 'skip',
        message: res.message || '',
        fixActionId: res.fixActionId || null,
        detail: res.detail || null
      });
    });
    _lastResults = results;
    _renderPanel(results);
    return results;
  }

  function getLastResults() { return _lastResults; }

  /* ─── context builder ────────────────────────────────────────────────────── */
  function _buildContext() {
    return {
      edl: window.__MPS_EDL_RAW || null,
      markers: window.__MPS_SM_SNAPSHOT || null,
      cutDiff: window.__MPS_CD_SNAPSHOT || null,
      imf: (typeof PFX_exportIMFState === 'function' ? PFX_exportIMFState() : window.__PFX_IMF_STATE) || null,
      reviews: (typeof PFX_exportReviewsState === 'function' ? PFX_exportReviewsState() : window.__PFX_REVIEWS_STATE) || null,
      renderQueue: window.PFX_RQ_getJobs ? window.PFX_RQ_getJobs() : [],
      projectDir: null
    };
  }

  /* ─── built-in rules ─────────────────────────────────────────────────────── */

  // Category: project
  registerRule({
    id: 'project.edl_loaded',
    label: 'EDL Loaded',
    category: 'project',
    severity: 'fail',
    run(ctx) {
      if (ctx.edl && (Array.isArray(ctx.edl) ? ctx.edl.length > 0 : Object.keys(ctx.edl).length > 0)) {
        return { status: 'pass', message: 'EDL is loaded' };
      }
      return { status: 'fail', message: 'No EDL loaded. Import or load a project first.' };
    }
  });

  registerRule({
    id: 'project.project_dir_set',
    label: 'Project Directory Set',
    category: 'project',
    severity: 'warn',
    run() {
      const hasDir = typeof window.getStoredProjectDir === 'function' || typeof window.PFX_getProjectDir === 'function';
      if (hasDir) return { status: 'pass', message: 'Project directory available' };
      return { status: 'warn', message: 'No project save directory set. Use File → Set Project Folder.' };
    }
  });

  // Category: timeline/media
  registerRule({
    id: 'timeline.has_events',
    label: 'Timeline Has Events',
    category: 'timeline',
    severity: 'fail',
    run(ctx) {
      const events = ctx.edl;
      const count = Array.isArray(events) ? events.length : 0;
      if (count > 0) return { status: 'pass', message: `${count} event(s) on timeline` };
      return { status: 'fail', message: 'Timeline has no events.' };
    }
  });

  registerRule({
    id: 'timeline.missing_media',
    label: 'No Missing Media',
    category: 'timeline',
    severity: 'warn',
    run(ctx) {
      const events = Array.isArray(ctx.edl) ? ctx.edl : [];
      const missing = events.filter(e => e.missingMedia || e.status === 'missing-media' || (!e.hasMedia && e.hasMedia !== undefined));
      if (missing.length === 0) return { status: 'pass', message: 'All media present' };
      return { status: 'warn', message: `${missing.length} event(s) missing media`, detail: missing.map(e => e.clipName || e.id).join(', ') };
    }
  });

  registerRule({
    id: 'timeline.fps_consistent',
    label: 'Consistent Frame Rate',
    category: 'timeline',
    severity: 'warn',
    run(ctx) {
      const events = Array.isArray(ctx.edl) ? ctx.edl : [];
      const fpsSeen = new Set(events.map(e => e.fps || e.frameRate).filter(Boolean));
      if (fpsSeen.size <= 1) return { status: 'pass', message: fpsSeen.size === 0 ? 'No FPS data' : `All events at ${[...fpsSeen][0]} fps` };
      return { status: 'warn', message: `Mixed frame rates detected: ${[...fpsSeen].join(', ')}` };
    }
  });

  // Category: qc
  registerRule({
    id: 'qc.no_open_errors',
    label: 'No Open QC Errors',
    category: 'qc',
    severity: 'fail',
    run(ctx) {
      const reviews = Array.isArray(ctx.reviews) ? ctx.reviews : (ctx.reviews?.reviews || ctx.reviews?.items || []);
      const openErrors = reviews.filter(r => {
        const sev = (r.severity || r.type || '').toLowerCase();
        const st = (r.status || r.state || 'open').toLowerCase();
        return (sev === 'error' || sev === 'critical') && st === 'open';
      });
      if (openErrors.length === 0) return { status: 'pass', message: 'No open QC errors' };
      return { status: 'fail', message: `${openErrors.length} open QC error(s) require resolution` };
    }
  });

  registerRule({
    id: 'qc.open_warnings',
    label: 'Check Open Warnings',
    category: 'qc',
    severity: 'warn',
    run(ctx) {
      const reviews = Array.isArray(ctx.reviews) ? ctx.reviews : (ctx.reviews?.reviews || ctx.reviews?.items || []);
      const open = reviews.filter(r => (r.status || r.state || 'open').toLowerCase() === 'open');
      if (open.length === 0) return { status: 'pass', message: 'All QC items resolved' };
      return { status: 'warn', message: `${open.length} open QC item(s)` };
    }
  });

  // Category: imf
  registerRule({
    id: 'imf.validation_complete',
    label: 'IMF Validation Complete',
    category: 'imf',
    severity: 'warn',
    run(ctx) {
      if (!ctx.imf) return { status: 'skip', message: 'No IMF state' };
      const results = ctx.imf.validationResults || ctx.imf.results || [];
      if (results.length === 0) return { status: 'warn', message: 'IMF validation has not been run' };
      const fails = results.filter(r => r.pass === false);
      if (fails.length > 0) return { status: 'fail', message: `${fails.length} IMF validation failure(s)` };
      return { status: 'pass', message: `IMF validation passed (${results.length} checks)` };
    }
  });

  registerRule({
    id: 'imf.no_validation_errors',
    label: 'No IMF Errors',
    category: 'imf',
    severity: 'fail',
    run(ctx) {
      if (!ctx.imf) return { status: 'skip', message: 'No IMF state' };
      const results = ctx.imf.validationResults || ctx.imf.results || [];
      const errors = results.filter(r => r.severity === 'error' || r.level === 'error');
      if (errors.length === 0) return { status: 'pass', message: 'No IMF errors' };
      return { status: 'fail', message: `${errors.length} IMF error(s) found` };
    }
  });

  // Category: render/export
  registerRule({
    id: 'render.no_failed_jobs',
    label: 'No Failed Render Jobs',
    category: 'render',
    severity: 'warn',
    run(ctx) {
      const jobs = Array.isArray(ctx.renderQueue) ? ctx.renderQueue : [];
      const failed = jobs.filter(j => j.status === 'error' || j.status === 'failed');
      if (failed.length === 0) return { status: 'pass', message: 'No failed render jobs' };
      return { status: 'warn', message: `${failed.length} failed render job(s) in queue`, detail: failed.map(j => j.label || j.id).join(', ') };
    }
  });

  registerRule({
    id: 'render.queue_not_paused',
    label: 'Render Queue Not Paused',
    category: 'render',
    severity: 'warn',
    run() {
      try {
        const paused = localStorage.getItem('mps.renderQueue.paused.v1');
        if (paused === 'true') return { status: 'warn', message: 'Render queue is paused' };
      } catch (e) { /* ignore */ }
      return { status: 'pass', message: 'Render queue is active' };
    }
  });

  /* ─── export JSON ────────────────────────────────────────────────────────── */
  function exportJSON() {
    const results = _lastResults.length ? _lastResults : (() => { const r = _buildContext ? run() : []; return _lastResults; })();
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), results }, null, 2)], { type: 'application/json' });
    _dl(blob, `preflight_${_dateStr()}.json`);
  }

  /* ─── export CSV ─────────────────────────────────────────────────────────── */
  function exportCSV() {
    const results = _lastResults.length ? _lastResults : run();
    const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const COLS = ['ruleId','label','category','severity','status','message'];
    const rows = [COLS.join(','), ...results.map(r => COLS.map(c => esc(r[c])).join(','))];
    const blob = new Blob([rows.join('\r\n')], { type: 'text/csv' });
    _dl(blob, `preflight_${_dateStr()}.csv`);
  }

  function _dl(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
  }

  function _dateStr() { return new Date().toISOString().slice(0, 10).replace(/-/g, ''); }

  /* ─── UI panel ───────────────────────────────────────────────────────────── */
  const CAT_LABELS = { project: 'Project', timeline: 'Timeline / Media', qc: 'QC', imf: 'IMF', render: 'Render / Export' };
  const STATUS_ICON = { pass: '✓', warn: '⚠', fail: '✕', skip: '—' };

  function _renderPanel(results) {
    const panel = document.getElementById('pfx-preflight-engine-panel');
    if (!panel) return;

    const cats = {};
    results.forEach(r => {
      (cats[r.category] = cats[r.category] || []).push(r);
    });

    const failCount = results.filter(r => r.status === 'fail').length;
    const warnCount = results.filter(r => r.status === 'warn').length;
    const passCount = results.filter(r => r.status === 'pass').length;

    const overallStatus = failCount > 0 ? 'fail' : warnCount > 0 ? 'warn' : 'pass';

    const catBlocks = Object.entries(cats).map(([cat, rows]) => {
      const catFail = rows.some(r => r.status === 'fail');
      const catWarn = rows.some(r => r.status === 'warn');
      const catClass = catFail ? 'fail' : catWarn ? 'warn' : 'pass';
      const rowHtml = rows.map(r => `
        <div class="pfx-pfe-row pfx-pfe-row--${r.status}">
          <span class="pfx-pfe-icon pfx-pfe-icon--${r.status}">${STATUS_ICON[r.status] || '?'}</span>
          <span class="pfx-pfe-label">${r.label}</span>
          <span class="pfx-pfe-msg">${r.message}${r.detail ? ` <span class="pfx-pfe-detail">(${r.detail})</span>` : ''}</span>
          ${r.fixActionId ? `<button class="pfx-pfe-fix" data-fix="${r.fixActionId}">Fix</button>` : ''}
        </div>`).join('');
      return `
        <div class="pfx-pfe-category">
          <div class="pfx-pfe-cat-header pfx-pfe-cat-header--${catClass}">
            <span>${CAT_LABELS[cat] || cat}</span>
            <span class="pfx-pfe-cat-count">${rows.length} check${rows.length !== 1 ? 's' : ''}</span>
          </div>
          <div class="pfx-pfe-cat-body">${rowHtml}</div>
        </div>`;
    }).join('');

    panel.innerHTML = `
<div class="pfx-pfe-root">
  <div class="pfx-pfe-header">
    <div class="pfx-pfe-title">
      <span class="pfx-pfe-overall pfx-pfe-overall--${overallStatus}">
        ${overallStatus === 'pass' ? '✓ PASS' : overallStatus === 'fail' ? '✕ FAIL' : '⚠ WARN'}
      </span>
      <span class="pfx-pfe-summary">${passCount} pass &bull; ${warnCount} warn &bull; ${failCount} fail</span>
    </div>
    <div class="pfx-pfe-actions">
      <button class="pfx-pfe-btn" id="pfx-pfe-run">▶ Run Checks</button>
      <button class="pfx-pfe-btn" id="pfx-pfe-export-json">⬇ JSON</button>
      <button class="pfx-pfe-btn" id="pfx-pfe-export-csv">⬇ CSV</button>
    </div>
  </div>
  <div class="pfx-pfe-body">${catBlocks || '<div class="pfx-pfe-empty">Click ▶ Run Checks to evaluate project state</div>'}</div>
</div>`;

    panel.querySelector('#pfx-pfe-run')?.addEventListener('click', () => run());
    panel.querySelector('#pfx-pfe-export-json')?.addEventListener('click', exportJSON);
    panel.querySelector('#pfx-pfe-export-csv')?.addEventListener('click', exportCSV);
    panel.querySelectorAll('[data-fix]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.dispatchEvent(new CustomEvent('pfx:preflight-fix', { detail: { fixActionId: btn.dataset.fix } }));
      });
    });
  }

  /* ─── readiness check for Render Queue ──────────────────────────────────── */
  function _registerRQReadiness() {
    if (typeof window.PFX_RQ_registerReadinessCheck === 'function') {
      window.PFX_RQ_registerReadinessCheck('preflight', (job) => {
        const results = _lastResults;
        if (!results.length) return { ok: true };
        const requiredFails = results.filter(r => r.status === 'fail' && r.severity === 'fail');
        if (requiredFails.length > 0) {
          return {
            ok: false,
            message: `Preflight: ${requiredFails.length} check(s) failed — ${requiredFails.map(r => r.label).join(', ')}`
          };
        }
        const warns = results.filter(r => r.status === 'warn');
        if (warns.length > 0) return { ok: true, warning: `${warns.length} preflight warning(s)` };
        return { ok: true };
      });
    }
  }

  /* ─── init ───────────────────────────────────────────────────────────────── */
  function _init() {
    _renderPanel([]);
    _registerRQReadiness();
    document.addEventListener('pfx:tab-activated', e => {
      if (e.detail?.tab === 'preflight') _renderPanel(_lastResults);
    });
    document.addEventListener('pfx:project-applied', () => {
      if (_lastResults.length) run();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  /* ─── public API ─────────────────────────────────────────────────────────── */
  window.PFX_Preflight = { registerRule, run, getLastResults, exportJSON, exportCSV };

})();
