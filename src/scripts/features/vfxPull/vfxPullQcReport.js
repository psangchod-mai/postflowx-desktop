/**
 * vfxPullQcReport.js
 * PostFlowX — VFX Pull
 *
 * Generates self-contained HTML and JSON QC reports for a VFX pull package.
 * No external dependencies.
 */

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_COLOR = {
  ready:     '#22c55e',  // green
  review:    '#eab308',  // yellow
  missing:   '#ef4444',  // red
  confirmed: '#638eff',  // blue (PostFlowX accent)
  skipped:   '#6b7280',  // gray
};

const STATUS_LABEL = {
  ready:     'Ready',
  review:    'Review',
  missing:   'Missing',
  confirmed: 'Confirmed',
  skipped:   'Skipped',
};

const AMF_FDL_COLOR = {
  generated: '#22c55e',
  pending:   '#eab308',
  error:     '#ef4444',
};

// Normalize matcher uppercase statuses ('SAFE', 'REVIEW_NEEDED', 'MISSING',
// 'NOT_RECOMMENDED') to the lowercase keys used by STATUS_COLOR/STATUS_LABEL.
function _normalizeStatus(status) {
  switch ((status || '').toUpperCase()) {
    case 'SAFE':             return 'ready';
    case 'REVIEW_NEEDED':
    case 'NOT_RECOMMENDED':  return 'review';
    case 'MISSING':          return 'missing';
    case 'CONFIRMED':        return 'confirmed';
    case 'SKIPPED':          return 'skipped';
    default:                 return (status || '').toLowerCase();
  }
}

function _statusBadge(status) {
  const norm  = _normalizeStatus(status);
  const color = STATUS_COLOR[norm] || '#6b7280';
  const label = STATUS_LABEL[norm] || status;
  return `<span class="badge" style="background:${color}20;color:${color};border:1px solid ${color}60">${label}</span>`;
}

function _smallBadge(val, map) {
  if (!val) return '<span class="badge-sm badge-gray">—</span>';
  const color = map[val] || '#6b7280';
  return `<span class="badge-sm" style="background:${color}20;color:${color}">${val}</span>`;
}

function _escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _fmtNum(n, digits = 2) {
  if (n == null || n === '') return '—';
  return Number(n).toFixed(digits);
}

function _fmtTc(tc) {
  return tc || '—';
}

// ---------------------------------------------------------------------------
// Embedded CSS
// ---------------------------------------------------------------------------

const REPORT_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg:        #0b1120;
    --surface:   #111827;
    --surface2:  #1a2540;
    --border:    #1e2e50;
    --accent:    #638eff;
    --accent-dim:#3b5bd6;
    --text:      #e2e8f0;
    --text-dim:  #94a3b8;
    --green:     #22c55e;
    --yellow:    #eab308;
    --red:       #ef4444;
    --gray:      #6b7280;
    --radius:    8px;
    --radius-sm: 4px;
  }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.5;
    padding: 24px;
  }
  a { color: var(--accent); text-decoration: none; }
  /* Header */
  .report-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }
  .logo { font-size: 20px; font-weight: 700; color: var(--accent); letter-spacing: -0.3px; }
  .logo span { color: var(--text); font-weight: 400; }
  .header-meta { text-align: right; color: var(--text-dim); font-size: 12px; }
  .header-meta strong { color: var(--text); font-size: 14px; }
  .overall-badge {
    display: inline-block;
    padding: 4px 14px;
    border-radius: 20px;
    font-size: 13px;
    font-weight: 600;
    margin-top: 6px;
  }
  /* Summary cards */
  .summary-cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 12px;
    margin-bottom: 24px;
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
  }
  .card-label { font-size: 11px; font-weight: 600; text-transform: uppercase;
                letter-spacing: 0.06em; color: var(--text-dim); margin-bottom: 6px; }
  .card-value { font-size: 28px; font-weight: 700; line-height: 1; }
  .card-value.green  { color: var(--green); }
  .card-value.yellow { color: var(--yellow); }
  .card-value.red    { color: var(--red); }
  .card-value.accent { color: var(--accent); }
  /* Section heading */
  .section-heading {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-dim);
    margin-bottom: 10px;
  }
  /* Meta block */
  .meta-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 6px 24px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px 16px;
    margin-bottom: 24px;
  }
  .meta-row { display: flex; gap: 8px; font-size: 12px; }
  .meta-row .k { color: var(--text-dim); min-width: 120px; }
  .meta-row .v { color: var(--text); word-break: break-all; }
  /* Table */
  .table-wrap {
    overflow-x: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  thead tr {
    background: var(--surface2);
  }
  thead th {
    padding: 9px 10px;
    text-align: left;
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-dim);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  tbody tr {
    border-bottom: 1px solid var(--border);
    transition: background 0.1s;
  }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:nth-child(even) { background: #0d1628; }
  tbody tr:hover { background: var(--surface2); }
  td {
    padding: 8px 10px;
    vertical-align: top;
    color: var(--text);
  }
  td.dim { color: var(--text-dim); }
  td.mono { font-family: 'Fira Mono', 'Consolas', monospace; font-size: 11px; }
  /* Badges */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
  }
  .badge-sm {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    white-space: nowrap;
  }
  .badge-gray { background: #6b728020; color: var(--gray); }
  /* Warnings */
  .warn-list { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 3px; }
  .warn-chip {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 10px;
    background: #eab30820;
    color: #fbbf24;
    border: 1px solid #eab30840;
    cursor: default;
    max-width: 300px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .warn-chip[title]:hover { max-width: none; overflow: visible; z-index: 10; }
  /* Score bar */
  .score-bar-wrap { display: flex; align-items: center; gap: 6px; }
  .score-bar {
    flex: 1;
    height: 4px;
    background: var(--border);
    border-radius: 2px;
    overflow: hidden;
    min-width: 40px;
  }
  .score-bar-fill {
    height: 100%;
    border-radius: 2px;
  }
  /* Footer */
  .report-footer {
    margin-top: 32px;
    padding-top: 14px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-dim);
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 6px;
  }
`;

// ---------------------------------------------------------------------------
// Embedded minimal JS for warning chip expand
// ---------------------------------------------------------------------------

const REPORT_JS = `
  document.querySelectorAll('.warn-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      chip.style.maxWidth = chip.style.maxWidth === 'none' ? '' : 'none';
      chip.style.overflow = chip.style.overflow === 'visible' ? '' : 'visible';
      chip.style.whiteSpace = chip.style.whiteSpace === 'normal' ? '' : 'normal';
      chip.style.zIndex = chip.style.zIndex ? '' : '20';
    });
  });
`;

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

function _summaryCards(meta) {
  const overall = meta.missingCount > 0 ? 'review'
    : meta.reviewCount > 0 ? 'review' : 'ready';
  const overallColor = overall === 'ready'
    ? STATUS_COLOR.ready : STATUS_COLOR.review;

  return `
    <div class="summary-cards">
      <div class="card">
        <div class="card-label">Total Shots</div>
        <div class="card-value accent">${meta.totalShots}</div>
      </div>
      <div class="card">
        <div class="card-label">Ready</div>
        <div class="card-value green">${meta.readyCount}</div>
      </div>
      <div class="card">
        <div class="card-label">Review</div>
        <div class="card-value yellow">${meta.reviewCount}</div>
      </div>
      <div class="card">
        <div class="card-label">Missing</div>
        <div class="card-value red">${meta.missingCount}</div>
      </div>
    </div>
    <div style="margin-bottom:20px">
      <span class="overall-badge"
            style="background:${overallColor}20;color:${overallColor};border:1px solid ${overallColor}60">
        ${overall === 'ready' ? 'All shots ready' : 'Requires review'}
      </span>
    </div>
  `;
}

function _metaBlock(meta) {
  const rows = [
    ['Show',         meta.show        || '—'],
    ['Episode',      meta.episode     || '—'],
    ['Timeline',     meta.timelineName|| '—'],
    ['Reference',    meta.refPath     || '—'],
    ['OCF Folder',   meta.ocfFolder   || '—'],
    ['Output Folder',meta.outputFolder|| '—'],
    ['Generated',    meta.generatedAt || '—'],
    ['App Version',  meta.appVersion  || '—'],
  ];
  const rowsHtml = rows.map(([k, v]) =>
    `<div class="meta-row"><span class="k">${_escapeHtml(k)}</span><span class="v">${_escapeHtml(v)}</span></div>`
  ).join('');
  return `
    <div class="section-heading">Pull Package Info</div>
    <div class="meta-grid">${rowsHtml}</div>
  `;
}

function _scoreBarHtml(score) {
  if (score == null) return '<span class="dim">—</span>';
  const pct = Math.max(0, Math.min(100, score));
  const color = pct >= 80 ? '#22c55e' : pct >= 55 ? '#eab308' : '#ef4444';
  return `
    <div class="score-bar-wrap">
      <div class="score-bar">
        <div class="score-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <span style="font-size:11px;color:${color};min-width:28px">${pct.toFixed(0)}</span>
    </div>
  `;
}

function _warningsHtml(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return '';
  const chips = warnings.map(w =>
    `<span class="warn-chip" title="${_escapeHtml(w)}">${_escapeHtml(w)}</span>`
  ).join('');
  return `<div class="warn-list">${chips}</div>`;
}

function _shotTableHtml(shots) {
  const thead = `
    <thead>
      <tr>
        <th>#</th>
        <th>Shot / Plate</th>
        <th>Status</th>
        <th>Timeline TC In/Out</th>
        <th>Ref TC In/Out</th>
        <th>OCF Clip</th>
        <th>OCF TC In/Out</th>
        <th>Handles</th>
        <th>Res (OCF)</th>
        <th>Res (Ref)</th>
        <th>Scale</th>
        <th>Color Mode</th>
        <th>AMF</th>
        <th>FDL</th>
        <th>Frame Δ</th>
        <th>Visual Match</th>
        <th>Match Method</th>
        <th>Confidence</th>
        <th>Warnings</th>
      </tr>
    </thead>
  `;

  const rows = shots.map((s, idx) => {
    const rowColor = STATUS_COLOR[_normalizeStatus(s.status)] || '#6b7280';
    const leftBorder = `border-left: 3px solid ${rowColor};`;

    // Normalize field names — qcShots uses different keys than the original
    // column names. Accept both shapes with fallbacks so the table renders
    // real data regardless of which builder populated _state.qcShots.
    const plateName      = s.plateName     || s.shotName || `plate_${idx + 1}`;
    const timelineTcIn   = s.timelineTcIn  || s.recIn    || null;
    const timelineTcOut  = s.timelineTcOut || s.recOut   || null;
    const refTcIn        = s.refTcIn  || s.qtRefFrame?.tc || null;
    const refTcOut       = s.refTcOut || null;
    const ocfClipName    = s.ocfClipName || s.clipName  || '';
    const ocfPath        = s.ocfPath     || s.filePath  || '';
    const ocfSourceTcIn  = s.ocfSourceTcIn  || s.tcIn  || null;
    const ocfSourceTcOut = s.ocfSourceTcOut || s.tcOut || null;
    const resolution     = s.resolution     || s.sourceResolution || '';
    const refResolution  = s.refResolution  || s.outputResolution || '';
    const reformatScale  = s.reformatScale  ?? null;
    const colorMode      = s.colorMode      || s.colorPipeline || '';
    const amfStatus      = s.amfStatus || (s.amf ? 'generated' : s.amf === undefined ? null : 'pending');
    const fdlStatus      = s.fdlStatus || (s.fdl ? 'generated' : s.fdl === undefined ? null : 'pending');
    const frameOffset    = s.frameOffset ?? null;
    const visualMatchScore = s.visualMatchScore ??
      (s.frameMatch?.confidence != null ? Math.round(s.frameMatch.confidence * 100) : null);
    const matchMethod    = s.matchMethod || s.ocfMatch?.method || '';

    return `
      <tr>
        <td class="dim" style="${leftBorder}">${idx + 1}</td>
        <td>
          <div style="font-weight:600;color:var(--text)">${_escapeHtml(s.shotName)}</div>
          <div style="color:var(--text-dim);font-size:11px">${_escapeHtml(plateName)}</div>
        </td>
        <td>${_statusBadge(s.status)}</td>
        <td class="mono">${_fmtTc(timelineTcIn)}<br>${_fmtTc(timelineTcOut)}</td>
        <td class="mono">${_fmtTc(refTcIn)}<br>${_fmtTc(refTcOut)}</td>
        <td class="mono" style="max-width:160px;word-break:break-all">
          ${_escapeHtml(ocfClipName) || '<span class="dim">—</span>'}
          ${ocfPath ? `<div style="color:var(--text-dim);font-size:10px">${_escapeHtml(ocfPath)}</div>` : ''}
        </td>
        <td class="mono">${_fmtTc(ocfSourceTcIn)}<br>${_fmtTc(ocfSourceTcOut)}</td>
        <td class="mono dim">${s.handles != null ? String(s.handles) : '—'}</td>
        <td class="dim">${_escapeHtml(resolution) || '—'}</td>
        <td class="dim">${_escapeHtml(refResolution) || '—'}</td>
        <td class="dim">${reformatScale != null ? _fmtNum(reformatScale, 3) : '—'}</td>
        <td class="dim">${_escapeHtml(colorMode) || '—'}</td>
        <td>${_smallBadge(amfStatus, AMF_FDL_COLOR)}</td>
        <td>${_smallBadge(fdlStatus, AMF_FDL_COLOR)}</td>
        <td class="mono dim">${frameOffset != null ? (frameOffset >= 0 ? '+' : '') + frameOffset : '—'}</td>
        <td>${_scoreBarHtml(visualMatchScore)}</td>
        <td class="dim">${_escapeHtml(matchMethod) || '—'}</td>
        <td>${_scoreBarHtml(s.confidence)}</td>
        <td>${_warningsHtml(s.warnings)}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="section-heading">Shot QC Table</div>
    <div class="table-wrap">
      <table>${thead}<tbody>${rows}</tbody></table>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

/**
 * Build a full self-contained HTML QC report.
 *
 * @param {Array}  shots - Array of QC shot entry objects
 * @param {object} meta  - Pull package metadata
 * @returns {string} Full HTML document string
 */
export function buildQcReportHtml(shots, meta) {
  const safeShots = Array.isArray(shots) ? shots : [];
  const safeMeta  = {
    ...meta,
    totalShots:   safeShots.length,
    readyCount:   safeShots.filter(s => _normalizeStatus(s.status) === 'ready').length,
    reviewCount:  safeShots.filter(s => _normalizeStatus(s.status) === 'review').length,
    missingCount: safeShots.filter(s => _normalizeStatus(s.status) === 'missing').length,
  };

  const title = `PostFlowX QC — ${_escapeHtml(safeMeta.show || '')} ${_escapeHtml(safeMeta.episode || '')}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>${REPORT_CSS}</style>
</head>
<body>
  <header class="report-header">
    <div>
      <div class="logo">PostFlow<span>X</span></div>
      <div style="color:var(--text-dim);font-size:12px;margin-top:2px">VFX Pull QC Report</div>
    </div>
    <div class="header-meta">
      <div><strong>${_escapeHtml(safeMeta.show || '—')}</strong>${safeMeta.episode ? ' / ' + _escapeHtml(safeMeta.episode) : ''}</div>
      <div>${_escapeHtml(safeMeta.timelineName || '')}</div>
      <div style="margin-top:4px">${_escapeHtml(safeMeta.generatedAt || new Date().toISOString())}</div>
    </div>
  </header>

  <main>
    ${_summaryCards(safeMeta)}
    ${_metaBlock(safeMeta)}
    ${_shotTableHtml(safeShots)}
  </main>

  <footer class="report-footer">
    <span>PostFlowX ${_escapeHtml(safeMeta.appVersion || '')} — VFX Pull QC</span>
    <span>Generated ${_escapeHtml(safeMeta.generatedAt || new Date().toISOString())}</span>
  </footer>

  <script>${REPORT_JS}</script>
</body>
</html>`;
}

// ── Printable QC contact sheet ───────────────────────────────────────────────
const CONTACT_SHEET_CSS = `
.cs-shot { border:1px solid #d8dde6; border-radius:8px; margin:14px 0; padding:12px 14px; page-break-inside:avoid; background:#fff; }
.cs-shot-hd { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; }
.cs-shot-name { font-weight:700; font-size:14px; color:#1a2230; }
.cs-shot-sub { color:#67707f; font-size:11px; font-weight:400; margin-left:6px; }
.cs-verdict { font-size:11px; font-weight:800; letter-spacing:.06em; padding:3px 10px; border-radius:20px; text-transform:uppercase; }
.cs-verdict.ok { background:#e3f7ec; color:#1c7a44; border:1px solid #9fdcb8; }
.cs-verdict.review { background:#fdf3df; color:#8a5d00; border:1px solid #ecc878; }
.cs-verdict.blocked { background:#fde7e9; color:#9e2230; border:1px solid #f0a8b0; }
.cs-strip { display:grid; grid-template-columns:46px repeat(7,1fr); gap:4px; margin:6px 0; }
.cs-strip-lbl { font-size:8px; font-weight:700; color:#8893a3; align-self:center; letter-spacing:.04em; }
.cs-cell { display:flex; flex-direction:column; align-items:center; }
.cs-cell img { width:100%; aspect-ratio:16/9; object-fit:cover; border-radius:3px; background:#0a0c10; border:1px solid #cfd6e0; }
.cs-cell .ph { width:100%; aspect-ratio:16/9; border-radius:3px; background:#eef1f5; border:1px dashed #cfd6e0; }
.cs-cell span { font-size:7px; color:#9aa3b2; margin-top:2px; }
.cs-meta { display:grid; grid-template-columns:repeat(4,1fr); gap:6px 14px; margin-top:8px; }
.cs-kv { font-size:10px; }
.cs-kv b { display:block; color:#8893a3; font-size:8px; font-weight:700; text-transform:uppercase; letter-spacing:.04em; }
.cs-kv span { color:#1a2230; }
.cs-kv span.warn { color:#9a6a00; font-weight:700; }
.cs-reasons { margin-top:6px; font-size:10px; color:#9e2230; }
.cs-signoff { display:flex; gap:24px; margin-top:10px; padding-top:8px; border-top:1px dashed #d8dde6; font-size:10px; color:#67707f; }
.cs-signoff .line { flex:1; border-bottom:1px solid #c2cad6; padding-bottom:1px; }
.cs-overall { margin:18px 0; padding:14px; border:2px solid #1a2230; border-radius:8px; }
.cs-overall .row { display:flex; gap:30px; margin-top:10px; font-size:12px; }
.cs-overall .row .line { flex:1; border-bottom:1px solid #1a2230; }
@media print { .cs-shot { box-shadow:none; } body { background:#fff; } }
`;

function _csVerdict(shot) {
  const lvl = shot.risk?.level
    || (_normalizeStatus(shot.status) === 'ready' ? 'ok'
        : _normalizeStatus(shot.status) === 'missing' ? 'blocked' : 'review');
  const label = lvl === 'ok' ? 'Ready' : lvl === 'blocked' ? 'Blocked' : 'Review';
  return { lvl, label };
}

function _csStripRow(label, frames) {
  const cells = [];
  for (let i = 0; i < 7; i++) {
    const f = (frames || [])[i];
    const inner = f?.dataUrl
      ? `<img src="${f.dataUrl}" alt="${_escapeHtml(f.pos || '')}">`
      : `<div class="ph"></div>`;
    cells.push(`<div class="cs-cell">${inner}<span>${_escapeHtml(f?.pos || ['Hdl','In','25%','50%','75%','Out','Tail'][i])}</span></div>`);
  }
  return `<div class="cs-strip-lbl">${label}</div>${cells.join('')}`;
}

function _csKv(label, value, warn = false) {
  return `<div class="cs-kv"><b>${_escapeHtml(label)}</b><span class="${warn ? 'warn' : ''}">${_escapeHtml(value == null || value === '' ? '—' : String(value))}</span></div>`;
}

function _csShotCard(shot) {
  const v = _csVerdict(shot);
  const hero = shot.heroFrames || {};
  const drift = shot.drift;
  const driftStr = drift == null ? '—'
    : `${drift > 0 ? '+' : ''}${drift}f${shot.driftApplied ? ' (applied)' : drift ? ' (not applied)' : ''}`;
  const pct = v => (v == null || !Number.isFinite(Number(v))) ? '—' : `${Math.round(Number(v))}%`;
  const reasons = (shot.risk?.reasons || []).length
    ? `<div class="cs-reasons">⚠ ${shot.risk.reasons.map(_escapeHtml).join(' · ')}</div>` : '';
  return `<section class="cs-shot">
  <div class="cs-shot-hd">
    <div class="cs-shot-name">${_escapeHtml(shot.shotName || shot.clipName || '—')}<span class="cs-shot-sub">${_escapeHtml(shot.plateName || '')}</span></div>
    <span class="cs-verdict ${v.lvl}">${v.label}</span>
  </div>
  <div class="cs-strip">${_csStripRow('QT REF', hero.qt)}</div>
  <div class="cs-strip">${_csStripRow('OCF', hero.ocf)}</div>
  <div class="cs-meta">
    ${_csKv('OCF Match', pct(shot.confidence), Number(shot.confidence) < 80)}
    ${_csKv('Visual Match', pct(shot.visualMatch), Number(shot.visualMatch) < 70)}
    ${_csKv('Color Match', pct(shot.colorConf), Number(shot.colorConf) < 60)}
    ${_csKv('Health', shot.risk?.health == null ? '—' : `${shot.risk.health}/100`)}
    ${_csKv('IDT', shot.idt)}
    ${_csKv('Frame Drift', driftStr, !!drift && !shot.driftApplied)}
    ${_csKv('Reframe', shot.reframe)}
    ${_csKv('Retime', shot.retime)}
    ${_csKv('Source TC', `${shot.tcIn || '—'} – ${shot.tcOut || '—'}`)}
    ${_csKv('Frames', shot.frameCount || '—')}
  </div>
  ${reasons}
  <div class="cs-signoff"><span>Reviewed by</span><span class="line"></span><span>Date</span><span class="line"></span><span>☐ Approved</span></div>
</section>`;
}

/**
 * Build a printable per-shot QC contact-sheet (HTML, print-to-PDF ready).
 * Each shot shows a QT-vs-OCF hero-frame strip, match/color/health scores,
 * IDT / drift / reframe / retime, risk reasons, and a sign-off line.
 *
 * @param {Array}  shots  enriched shots: + { heroFrames:{qt,ocf}, risk, idt,
 *                        visualMatch, colorConf, drift, driftApplied, reframe, retime }
 * @param {object} meta
 * @returns {string} HTML document
 */
export function buildContactSheetHtml(shots, meta) {
  const safeShots = Array.isArray(shots) ? shots : [];
  const safeMeta  = meta || {};
  const counts = { ok: 0, review: 0, blocked: 0 };
  for (const s of safeShots) counts[_csVerdict(s).lvl]++;
  const title = `PostFlowX QC Contact Sheet — ${_escapeHtml(safeMeta.show || '')} ${_escapeHtml(safeMeta.episode || '')}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>${REPORT_CSS}${CONTACT_SHEET_CSS}</style>
</head>
<body>
  <header class="report-header">
    <div>
      <div class="logo">PostFlow<span>X</span></div>
      <div style="color:var(--text-dim);font-size:12px;margin-top:2px">VFX Pull QC Contact Sheet</div>
    </div>
    <div class="header-meta">
      <div><strong>${_escapeHtml(safeMeta.show || '—')}</strong>${safeMeta.episode ? ' / ' + _escapeHtml(safeMeta.episode) : ''}</div>
      <div>${_escapeHtml(safeMeta.timelineName || '')}</div>
      <div style="margin-top:4px">${_escapeHtml(safeMeta.generatedAt || new Date().toISOString())}</div>
    </div>
  </header>
  <main>
    <div class="cs-overall">
      <div style="font-weight:800;font-size:13px">QC SUMMARY — ${safeShots.length} shots · ${counts.ok} ready · ${counts.review} review · ${counts.blocked} blocked</div>
      <div class="row"><span>Operator</span><span class="line"></span><span>Supervisor</span><span class="line"></span><span>Date</span><span class="line"></span></div>
    </div>
    ${safeShots.map(_csShotCard).join('')}
  </main>
  <footer class="report-footer">
    <span>PostFlowX ${_escapeHtml(safeMeta.appVersion || '')} — VFX Pull QC Contact Sheet</span>
    <span>Generated ${_escapeHtml(safeMeta.generatedAt || new Date().toISOString())}</span>
  </footer>
</body>
</html>`;
}

/**
 * Build a JSON QC report string.
 *
 * @param {Array}  shots
 * @param {object} meta
 * @returns {string} JSON string
 */
export function buildQcReportJson(shots, meta) {
  const safeShots = Array.isArray(shots) ? shots : [];
  const safeMeta  = meta || {};

  const report = {
    schema:      'postflowx.vfxpull.qc.v2',
    generatedAt: safeMeta.generatedAt || new Date().toISOString(),
    meta:        safeMeta,
    // Block conditions surface in the report header so the UI / Go button can
    // refuse export when any are true. `meta.blocks` is populated by
    // computeQcBlocks() at the call site.
    blocks:      Array.isArray(safeMeta.blocks) ? safeMeta.blocks : [],
    shots:       safeShots,
  };

  return JSON.stringify(report, null, 2);
}

/**
 * Compute the spec's hard-block conditions for a VFX Pull export.
 *
 * Returns an array of block objects: { code, severity:'error'|'warn', message }.
 * An empty array means the export is cleared to run. Severity 'error' blocks
 * the export; 'warn' is informational (e.g. fallback decoder used).
 *
 * @param {object} args
 * @param {Array}  args.shots          QC shot rows (post-normalisation)
 * @param {object} args.settings       _settings snapshot
 * @param {object} args.providers      { hasEvents, hasReference, hasOcfFolder }
 * @param {boolean} args.acknowledgedNotRecommended  user confirmed any NOT_RECOMMENDED
 * @param {boolean} args.browserDownloadAllowed      sidecar-only download fallback enabled
 * @returns {Array<{code,severity,message}>}
 */
export function computeQcBlocks({
  shots = [],
  settings = {},
  providers = {},
  acknowledgedNotRecommended = false,
  browserDownloadAllowed = true,
} = {}) {
  const out = [];

  if (!providers.hasEvents) {
    out.push({ code: 'NO_TIMELINE_EVENTS', severity: 'error',
      message: 'No timeline events. Load an EDL / XML / FCPXML / OTIO first.' });
  }
  if (!providers.hasReference) {
    out.push({ code: 'NO_QT_REFERENCE', severity: 'error',
      message: 'No QT reference loaded. The Rec709 reference is required for color / frame match.' });
  }
  if (!providers.hasOcfFolder) {
    out.push({ code: 'NO_OCF_FOLDER', severity: 'error',
      message: 'No OCF folder selected. Pick the camera-original folder to reconnect.' });
  }

  // Per-shot blockers.
  const missingShots = shots.filter(s => (s.status || '').toUpperCase() === 'MISSING');
  if (missingShots.length) {
    out.push({
      code: 'OCF_MISSING_PER_SHOT',
      severity: 'error',
      message: `${missingShots.length} shot(s) have no matched OCF. Relink or remove before export.`,
      shots: missingShots.map(s => s.shotName).filter(Boolean),
    });
  }

  const notRec = shots.filter(s => (s.status || '').toUpperCase() === 'NOT_RECOMMENDED');
  if (notRec.length && !acknowledgedNotRecommended) {
    out.push({
      code: 'NOT_RECOMMENDED_NEEDS_ACK',
      severity: 'error',
      message: `${notRec.length} shot(s) flagged NOT_RECOMMENDED. Confirm or relink to proceed.`,
      shots: notRec.map(s => s.shotName).filter(Boolean),
    });
  }

  // Dynamic retime: spec says we must NOT silently bake. If any shot has a
  // dynamic retime and bakeSpeed is on, block — that case needs manual review.
  const dynRetime = shots.filter(s => s?.retime?.isDynamic);
  if (dynRetime.length && settings.bakeSpeed) {
    out.push({
      code: 'DYNAMIC_RETIME_UNSUPPORTED',
      severity: 'error',
      message: `${dynRetime.length} shot(s) have dynamic speed ramps. Disable Bake Speed for these, or pre-render in Resolve.`,
      shots: dynRetime.map(s => s.shotName).filter(Boolean),
    });
  }

  // Output folder gating: EXR sequences can't go through browser download.
  // When output folder is unset AND the sidecar-only fallback is disabled,
  // block. When sidecar-only is allowed, just warn.
  if (!settings.outputFolder && settings.exportMode !== 'sidecar_only') {
    if (browserDownloadAllowed) {
      out.push({
        code: 'NO_OUTPUT_FOLDER',
        severity: 'warn',
        message: 'No output folder selected — EXR export will be skipped, sidecars only.',
      });
    } else {
      out.push({
        code: 'NO_OUTPUT_FOLDER_HARD',
        severity: 'error',
        message: 'No output folder selected and browser download fallback disabled.',
      });
    }
  }

  return out;
}
