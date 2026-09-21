// Export Package — JSON / CSV / preflight report downloads from SWI state.
(function () {
  'use strict';

  function _now() { return new Date().toISOString(); }

  function _buildShotRecord(swi) {
    return {
      shotWorkId:        swi.shotWorkId,
      shotName:          swi.shotName          || '',
      plateName:         swi.plateName || swi.sourceClipName || '',
      reel:              swi.reel              || '',
      camera:            swi.camera            || '',
      srcTcIn:           swi.srcTcIn           || '',
      srcTcOut:          swi.srcTcOut          || '',
      fps:               swi.fps               || 24,
      durationFrames:    swi.durationFrames    || 0,
      ocfStatus:         swi.ocfStatus         || '',
      ocfPath:           swi.ocf?.path         || '',
      colorStatus:       swi.colorStatus       || '',
      proxyStatus:       swi.proxyStatus       || '',
      proxyPath:         swi.proxy?.outputPath || '',
      proxyIsStale:      swi.proxyIsStale      || false,
      proxyStaleReasons: swi.proxyStaleReasons || [],
      qcStatus:          swi.qc?.qcStatus || swi.qcStatus || '',
      qcChecks:          swi.qc?.checks   || {},
      qcNotes:           swi.qc?.notes    || [],
      nextAction:        window.PFX_SMART_RUN?.getNextAction?.(swi) || '',
      updatedAt:         swi.updatedAt    || '',
    };
  }

  function _download(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function _getAllVfxSWIs() {
    if (!window.PFX_SWI) return [];
    const projectId = window.PFX_SWI.getProjectId ? window.PFX_SWI.getProjectId() : 'default';
    const all = await window.PFX_SWI.getAll(projectId);
    return all.filter(s => s.markerType === 'VFX' && s.enabled !== false);
  }

  // ── Single shot JSON ──────────────────────────────────────────────────────
  async function exportShot(shotWorkId) {
    const swi = await window.PFX_SWI?.getById(shotWorkId);
    if (!swi) return;
    const record = _buildShotRecord(swi);
    const ts = _now().slice(0, 10);
    _download(`pfx_shot_${swi.shotName || swi.shotWorkId}_${ts}.json`, JSON.stringify(record, null, 2), 'application/json');
  }

  // ── All shots JSON (filter: 'all' | 'ready' | 'pass') ────────────────────
  async function exportAll(filter) {
    const all = await _getAllVfxSWIs();
    let items = all;
    if (filter === 'ready') items = all.filter(s => s.proxyStatus === 'ready' && !s.proxyIsStale);
    if (filter === 'pass')  items = all.filter(s => (s.qc?.qcStatus || s.qcStatus) === 'pass');
    const records = items.map(_buildShotRecord);
    const ts = _now().slice(0, 10);
    _download(
      `pfx_export_${filter || 'all'}_${ts}.json`,
      JSON.stringify({ exportedAt: _now(), filter: filter || 'all', shots: records }, null, 2),
      'application/json'
    );
  }

  // ── QC CSV report ─────────────────────────────────────────────────────────
  async function exportQCReport() {
    const all = await _getAllVfxSWIs();
    const headers = [
      'shotWorkId', 'shotName', 'plateName', 'reel', 'camera',
      'srcTcIn', 'srcTcOut', 'fps', 'durationFrames',
      'ocfStatus', 'ocfPath', 'colorStatus',
      'proxyStatus', 'proxyPath', 'proxyIsStale', 'proxyStaleReasons',
      'qcStatus', 'nextAction',
    ];
    const rows = all.map(swi => {
      const r = _buildShotRecord(swi);
      return headers.map(h => {
        const v = r[h];
        if (Array.isArray(v)) return `"${v.join('; ')}"`;
        return typeof v === 'string' ? `"${v.replace(/"/g, '""')}"` : String(v ?? '');
      }).join(',');
    });
    const ts = _now().slice(0, 10);
    _download(`pfx_qc_report_${ts}.csv`, [headers.join(','), ...rows].join('\n'), 'text/csv');
  }

  // ── Preflight JSON report ─────────────────────────────────────────────────
  async function exportPreflightReport(summary) {
    const ts = _now().slice(0, 10);
    const report = {
      exportedAt:   _now(),
      vfxMarkers:   summary?.total         || 0,
      ocfIndexCount: summary?.ocfIndexCount || 0,
      ocfLinked:    summary?.ocfLinked      || 0,
      ocfMissing:   summary?.ocfMissing     || 0,
      ocfCandidate: summary?.ocfCandidate   || 0,
      proxyReady:   summary?.proxyReady     || 0,
      proxyMissing: summary?.proxyMissing   || 0,
      proxyStale:   summary?.proxyStale     || 0,
      proxyFailed:  summary?.proxyFailed    || 0,
      qcPending:    summary?.qcPending      || 0,
      qcHold:       summary?.qcHold         || 0,
      exportReady:  summary?.exportReady    || 0,
    };
    _download(`pfx_preflight_${ts}.json`, JSON.stringify(report, null, 2), 'application/json');
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.PFX_EXPORT_PKG = {
    exportShot,
    exportAll,
    exportQCReport,
    exportPreflightReport,
  };

  console.info('[EXPORT_PKG] Export Package module ready');
})();
