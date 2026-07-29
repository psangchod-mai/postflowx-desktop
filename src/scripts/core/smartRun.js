// Smart Run Orchestration — Marker Proxy QC
// Pipeline: relink OCF → detect color → stale check → preflight modal → submit proxy jobs
// Also owns: Next Action cache, Issue Inbox, Cut Diff reaction, safe-fix actions
(function () {
  'use strict';

  // ── Next Action definitions ───────────────────────────────────────────────
  const ACTION_META = {
    'Relink OCF':         { cls: 'pm-nxt-ocf-missing',   fix: 'relink'  },
    'Confirm OCF':        { cls: 'pm-nxt-ocf-candidate', fix: 'confirm' },
    'Fix Color Conflict': { cls: 'pm-nxt-color',         fix: 'color'   },
    'Build Proxy':        { cls: 'pm-nxt-build',         fix: 'build'   },
    'Rebuild Proxy':      { cls: 'pm-nxt-rebuild',       fix: 'rebuild' },
    'Rendering…':         { cls: 'pm-nxt-rendering',     fix: null      },
    'Retry Proxy':        { cls: 'pm-nxt-failed',        fix: 'retry'   },
    'Compare QC':         { cls: 'pm-nxt-qc-compare',    fix: 'qc'      },
    'Mark QC':            { cls: 'pm-nxt-qc-hold',       fix: 'qc'      },
    'Export Ready':       { cls: 'pm-nxt-export',        fix: 'export'  },
  };

  const ISSUE_GROUPS = [
    { key: 'ocfMissing',    label: 'OCF Missing',    cls: 'pfx-fix-relink',  fix: 'relink'  },
    { key: 'ocfCandidate',  label: 'OCF Candidate',  cls: 'pfx-fix-confirm', fix: 'confirm' },
    { key: 'colorMissing',  label: 'Color Missing',  cls: '',                fix: null       },
    { key: 'colorConflict', label: 'Color Conflict', cls: 'pfx-fix-color',   fix: 'color'   },
    { key: 'proxyMissing',  label: 'Proxy Missing',  cls: 'pfx-fix-build',   fix: 'build'   },
    { key: 'proxyStale',    label: 'Proxy Stale',    cls: 'pfx-fix-build',   fix: 'rebuild' },
    { key: 'proxyFailed',   label: 'Proxy Failed',   cls: 'pfx-fix-retry',   fix: 'retry'   },
    { key: 'qcPending',     label: 'QC Pending',     cls: 'pfx-fix-qc',      fix: 'qc'      },
    { key: 'qcHold',        label: 'QC Hold',        cls: 'pfx-fix-qc',      fix: 'qc'      },
    { key: 'exportReady',   label: 'Export Ready',   cls: 'pfx-fix-export',  fix: 'export'  },
  ];

  // ── Synchronous next-action cache: markerId → actionString ───────────────
  const _cache = new Map();

  // refreshActionCache() is triggered from many independent, uncoordinated
  // sources (proxy-job completion, cross-tab SWI BroadcastChannel, cut-diff
  // reactions, safe-fix actions, boot warm-up) that can overlap. Without a
  // guard, an earlier call reading a stale SWI snapshot can resolve AFTER a
  // later call reading a fresher one, and its clear()+repopulate would
  // clobber the fresher cache with stale data.
  let _cacheSeq = 0;

  function getNextAction(swi) {
    if (!swi || swi.enabled === false || swi.markerType !== 'VFX') return null;
    if (swi.ocfStatus === 'missing') return 'Relink OCF';
    if (swi.ocfStatus === 'candidate' || swi.ocfStatus === 'ambiguous') return 'Confirm OCF';
    if (swi.colorStatus === 'conflict') return 'Fix Color Conflict';
    if (swi.proxyStatus === 'rendering') return 'Rendering…';
    if (swi.proxyStatus === 'failed') return 'Retry Proxy';
    if (swi.proxyIsStale || swi.proxyStatus === 'stale') return 'Rebuild Proxy';
    const isLinked = swi.ocfStatus === 'linked' || swi.ocfStatus === 'locked';
    if (isLinked && (!swi.proxy?.outputPath || swi.proxyStatus === 'missing' || swi.proxyStatus === 'blocked')) return 'Build Proxy';
    if (swi.proxyStatus === 'ready') {
      const qcStat = swi.qc?.qcStatus || swi.qcStatus || 'pending';
      if (qcStat === 'pass') return 'Export Ready';
      if (qcStat === 'hold') return 'Mark QC';
      if (qcStat === 'fail') return 'Retry Proxy';
      return 'Compare QC';
    }
    return null;
  }

  // Returns HTML badge string for use in prep_mark.js row renderer (synchronous)
  function getNextActionForMarkers(linkedMks) {
    if (!linkedMks?.length) return '';
    for (const mk of linkedMks) {
      const id = mk.id || mk.markerId;
      const action = _cache.get(id);
      if (action) {
        const meta = ACTION_META[action];
        if (!meta) return '';
        const tip = action + (mk.shotName ? ` — ${mk.shotName}` : '');
        return `<span class="pm-nxt-badge ${meta.cls}" title="${tip}">${action}</span>`;
      }
    }
    return '';
  }

  // ── Cache refresh ─────────────────────────────────────────────────────────
  async function refreshActionCache() {
    if (!window.PFX_SWI) return;
    const seq = ++_cacheSeq;
    try {
      const projectId = window.PFX_SWI.getProjectId ? window.PFX_SWI.getProjectId() : 'default';
      const all = await window.PFX_SWI.getAll(projectId);
      if (seq !== _cacheSeq) return;
      _cache.clear();
      for (const swi of all) {
        const action = getNextAction(swi);
        if (action && swi.markerId) _cache.set(swi.markerId, action);
      }
      try { if (typeof window._pmRenderEventTable === 'function') window._pmRenderEventTable(); } catch {}
    } catch {}
  }

  // ── Classify one SWI into an issue group key ──────────────────────────────
  function _classifySWI(swi) {
    if (!swi || swi.enabled === false || swi.markerType !== 'VFX') return null;
    if (swi.ocfStatus === 'missing') return 'ocfMissing';
    if (swi.ocfStatus === 'candidate' || swi.ocfStatus === 'ambiguous') return 'ocfCandidate';
    if (swi.colorStatus === 'conflict') return 'colorConflict';
    if (swi.colorStatus === 'missing') return 'colorMissing';
    if (swi.proxyStatus === 'failed') return 'proxyFailed';
    if (swi.proxyIsStale || swi.proxyStatus === 'stale') return 'proxyStale';
    const linked = swi.ocfStatus === 'linked' || swi.ocfStatus === 'locked';
    if (linked && (!swi.proxy?.outputPath || swi.proxyStatus === 'missing' || swi.proxyStatus === 'blocked')) return 'proxyMissing';
    if (swi.proxyStatus === 'ready') {
      const qcStat = swi.qc?.qcStatus || swi.qcStatus || 'pending';
      if (qcStat === 'pass') return 'exportReady';
      if (qcStat === 'hold') return 'qcHold';
      if (qcStat === 'fail') return 'proxyFailed';
      return 'qcPending';
    }
    return null;
  }

  function getIssueGroups(swis) {
    const groups = {};
    ISSUE_GROUPS.forEach(g => { groups[g.key] = []; });
    for (const swi of swis) {
      const key = _classifySWI(swi);
      if (key && groups[key]) groups[key].push(swi);
    }
    return groups;
  }

  // ── Preflight summary ─────────────────────────────────────────────────────
  async function buildPreflightSummary() {
    if (!window.PFX_SWI) return null;
    const projectId = window.PFX_SWI.getProjectId ? window.PFX_SWI.getProjectId() : 'default';
    const all = await window.PFX_SWI.getAll(projectId);
    const vfx = all.filter(s => s.enabled !== false && s.markerType === 'VFX');
    const groups = getIssueGroups(vfx);
    const ocfIndexCount = (await window.PFX_OCF_INDEX?.getCount?.()) || 0;

    return {
      total:        vfx.length,
      ocfIndexCount,
      ocfLinked:    vfx.filter(s => s.ocfStatus === 'linked' || s.ocfStatus === 'locked').length,
      ocfMissing:   groups.ocfMissing.length,
      ocfCandidate: groups.ocfCandidate.length,
      proxyReady:   vfx.filter(s => s.proxyStatus === 'ready' && !s.proxyIsStale).length,
      proxyMissing: groups.proxyMissing.length,
      proxyStale:   groups.proxyStale.length,
      proxyFailed:  groups.proxyFailed.length,
      qcPending:    groups.qcPending.length,
      qcHold:       groups.qcHold.length,
      exportReady:  groups.exportReady.length,
      groups,
      vfxItems: vfx,
    };
  }

  // ── Preflight modal ───────────────────────────────────────────────────────
  function _showPreflightModal(summary, onRun, onCancel) {
    const modal     = document.getElementById('pfxSmartPreflightModal');
    const inner     = modal?.querySelector('.pfx-preflight-inner');
    const runBtn    = document.getElementById('pfxPreflightRunBtn');
    const cancelBtn = document.getElementById('pfxPreflightCancelBtn');
    const exportBtn = document.getElementById('pfxPreflightExportBtn');
    const resolveBtn = document.getElementById('pfxPreflightResolveBtn');
    if (!modal || !inner) return;

    const row = (label, val, cls) =>
      `<div class="pfx-preflight-row"><span class="pfx-preflight-label">${label}</span><span class="pfx-preflight-val${cls ? ' ' + cls : ''}">${val}</span></div>`;

    const hasOcf  = summary.ocfIndexCount > 0;
    const jobCount = summary.proxyMissing + summary.proxyStale + summary.proxyFailed;

    inner.innerHTML = [
      row('VFX markers',  summary.total,        ''),
      row('OCF index',    hasOcf ? `${summary.ocfIndexCount} files` : 'empty', hasOcf ? 'ok' : 'err'),
      row('OCF linked',   summary.ocfLinked,    summary.ocfLinked === summary.total ? 'ok' : 'warn'),
      summary.ocfMissing   ? row('OCF missing',   summary.ocfMissing,   'err')  : '',
      summary.ocfCandidate ? row('OCF candidate', summary.ocfCandidate, 'warn') : '',
      row('Proxy ready',  summary.proxyReady,   summary.proxyReady > 0 ? 'ok' : ''),
      summary.proxyMissing ? row('Proxy missing', summary.proxyMissing, 'warn') : '',
      summary.proxyStale   ? row('Proxy stale',   summary.proxyStale,   'warn') : '',
      summary.proxyFailed  ? row('Proxy failed',  summary.proxyFailed,  'err')  : '',
      summary.qcHold       ? row('QC hold',       summary.qcHold,       'warn') : '',
      summary.exportReady  ? row('Export ready',  summary.exportReady,  'ok')   : '',
      !hasOcf ? `<div style="margin-top:10px;font-size:10px;color:#f47;">No OCF index — add an OCF folder in Settings before building proxies.</div>` : '',
    ].join('');

    if (runBtn) {
      runBtn.disabled    = jobCount === 0;
      runBtn.textContent = jobCount > 0 ? `Render ${jobCount} Jobs` : 'No Jobs Ready';
    }
    if (resolveBtn) resolveBtn.style.display = summary.ocfMissing > 0 ? '' : 'none';

    const _close = () => { modal.style.display = 'none'; };

    // Backdrop click must resolve the same onCancel as the Cancel button, or a
    // caller awaiting run()'s preflight Promise (see run()) hangs forever —
    // rebind per call (like cancelBtn.onclick) so it always targets the
    // current call's onCancel, not whichever call last ran _init().
    modal.onclick = (e) => { if (e.target === modal) { _close(); onCancel?.(); } };

    if (cancelBtn) cancelBtn.onclick = () => { _close(); onCancel?.(); };
    if (runBtn) {
      runBtn.onclick = async () => {
        _close();
        await onRun?.();
      };
    }
    if (exportBtn) {
      exportBtn.onclick = () => window.PFX_EXPORT_PKG?.exportPreflightReport?.(summary);
    }
    if (resolveBtn) {
      resolveBtn.onclick = async () => {
        _close();
        await window.PFX_OCF_RELINK?.relinkMarkers?.('vfx');
        await refreshActionCache();
      };
    }

    modal.style.display = 'flex';
  }

  // ── Issue Inbox ───────────────────────────────────────────────────────────
  function renderIssueInbox(_container, summary) {
    const inbox = document.getElementById('pfxIssueInbox');
    const body  = document.getElementById('pfxIssueInboxBody');
    if (!inbox || !body) return;

    const hasIssues = ISSUE_GROUPS.some(g => g.key !== 'exportReady' && (summary?.groups?.[g.key]?.length || 0) > 0);
    inbox.style.display = hasIssues ? '' : 'none';
    if (!hasIssues) { body.innerHTML = ''; return; }

    const parts = [];
    for (const group of ISSUE_GROUPS) {
      if (group.key === 'exportReady') continue;
      const items = summary.groups[group.key] || [];
      if (!items.length) continue;

      parts.push(`<div class="pfx-issue-group-hdr">
        <span>${group.label}</span>
        <span class="pfx-issue-group-count">${items.length}</span>
      </div>`);

      for (const swi of items) {
        const name = swi.shotName || swi.sourceClipName || swi.shotWorkId || '(unknown)';
        const fixBtn = group.fix
          ? `<button class="pfx-issue-fix-btn ${group.cls}" data-fix="${group.fix}"${swi.shotWorkId != null ? ` data-id="${swi.shotWorkId}"` : ''}>Fix</button>`
          : '';
        parts.push(`<div class="pfx-issue-row">
          <span class="pfx-issue-row-shot" title="${name}">${name}</span>
          ${fixBtn}
        </div>`);
      }
    }
    body.innerHTML = parts.join('');

    body.querySelectorAll('[data-fix]').forEach(btn => {
      btn.addEventListener('click', () => safeFixAction(btn.dataset.fix, btn.dataset.id));
    });
  }

  // ── Safe-fix actions ──────────────────────────────────────────────────────
  async function safeFixAction(fix, shotWorkId) {
    switch (fix) {
      case 'relink':
        if (shotWorkId) {
          const swi = await window.PFX_SWI?.getById(shotWorkId);
          if (swi) {
            const patch = await window.PFX_OCF_RELINK?.relinkOne(swi);
            if (patch) await window.PFX_SWI?.update(shotWorkId, patch);
          }
        } else {
          await window.PFX_OCF_RELINK?.relinkMarkers('vfx');
        }
        break;
      case 'confirm':
        window.dispatchEvent(new CustomEvent('pfx_swi_confirm_ocf', { detail: { shotWorkId } }));
        break;
      case 'color':
        window.dispatchEvent(new CustomEvent('pfx_swi_fix_color', { detail: { shotWorkId } }));
        break;
      case 'build':
        await window.PFX_PROXY_JOBS?.submitJobs?.('missing_only');
        break;
      case 'rebuild':
        await window.PFX_PROXY_JOBS?.submitJobs?.('force_rebuild');
        break;
      case 'retry':
        await window.PFX_PROXY_JOBS?.submitJobs?.('force_rebuild');
        break;
      case 'qc':
        window.dispatchEvent(new CustomEvent('pfx_open_qc_hub', { detail: { shotWorkId } }));
        break;
      case 'export':
        await window.PFX_EXPORT_PKG?.exportAll?.('ready');
        break;
    }
    await refreshActionCache();
  }

  // ── Cut Diff reaction ─────────────────────────────────────────────────────
  async function _reactToCutDiff(e) {
    if (!window.PFX_SWI || !window.PFX_PROXY_FP) return;
    const updatedMarkers = e?.detail?.markers || [];
    if (!updatedMarkers.length) return;

    const projectId = window.PFX_SWI.getProjectId ? window.PFX_SWI.getProjectId() : 'default';
    const all = await window.PFX_SWI.getAll(projectId);

    for (const swi of all) {
      if (!swi.markerId) continue;
      const mk = updatedMarkers.find(m => (m.id || m.markerId) === swi.markerId);
      if (!mk) continue;

      const tcChanged = (mk.srcIn && mk.srcIn !== swi.srcTcIn) || (mk.srcOut && mk.srcOut !== swi.srcTcOut);
      if (!tcChanged) continue;

      if (typeof window.PFX_SWI.onMarkerRangeChanged === 'function') {
        await window.PFX_SWI.onMarkerRangeChanged(swi.shotWorkId, {
          srcTcIn:  mk.srcIn  || swi.srcTcIn,
          srcTcOut: mk.srcOut || swi.srcTcOut,
        });
      } else {
        await window.PFX_SWI.update(swi.shotWorkId, {
          srcTcIn:  mk.srcIn  || swi.srcTcIn,
          srcTcOut: mk.srcOut || swi.srcTcOut,
        });
      }

      if (typeof window.PFX_PROXY_FP.markStale === 'function') {
        await window.PFX_PROXY_FP.markStale(swi.shotWorkId, ['marker range changed']);
      }
    }

    await refreshActionCache();
  }

  // ── Smart Run pipeline ────────────────────────────────────────────────────
  let _running = false;

  async function run(options) {
    if (_running) return;
    _running = true;
    const btn = document.getElementById('pfxSmartRunBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⚡ Running…'; }

    try {
      if (window.PFX_OCF_RELINK?.relinkMarkers) {
        await window.PFX_OCF_RELINK.relinkMarkers('vfx');
      }
      if (window.PFX_COLOR_RECIPE?.detectForAll) {
        await window.PFX_COLOR_RECIPE.detectForAll();
      }
      if (window.PFX_PROXY_FP?.checkAll) {
        await window.PFX_PROXY_FP.checkAll();
      }

      const summary = await buildPreflightSummary();
      if (!summary) return;

      await refreshActionCache();
      renderIssueInbox(null, summary);

      await new Promise((resolve) => {
        _showPreflightModal(summary, async () => {
          try {
            const filter = options?.filter || 'all_vfx';
            await window.PFX_PROXY_JOBS?.submitJobs?.(filter);
            await refreshActionCache();
          } finally {
            resolve();
          }
        }, () => resolve());
      });

    } finally {
      _running = false;
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Smart Run'; }
    }
  }

  // ── Init wiring ───────────────────────────────────────────────────────────
  function _init() {
    const btn = document.getElementById('pfxSmartRunBtn');
    if (btn) btn.addEventListener('click', () => run());

    // Issue Inbox expand/collapse
    const inboxHdr = document.getElementById('pfxIssueInboxHdr');
    const inboxBody = document.getElementById('pfxIssueInboxBody');
    const inboxTog  = document.getElementById('pfxIssueInboxToggle');
    if (inboxHdr) {
      inboxHdr.addEventListener('click', () => {
        const open = inboxBody?.style.display !== 'none';
        if (inboxBody) inboxBody.style.display = open ? 'none' : '';
        if (inboxTog) inboxTog.textContent = open ? '▼' : '▲';
      });
    }

    // Preflight modal backdrop-click is bound per call inside _showPreflightModal
    // (needs the current call's onCancel — see the race this fixed).

    // Proxy committed → refresh cache
    window.addEventListener('pfx_proxy_committed', () => refreshActionCache());

    // SWI updates via BroadcastChannel
    try {
      const bc = new BroadcastChannel('pfx_swi_updates');
      bc.onmessage = () => refreshActionCache();
    } catch {}

    // Cut Diff reaction
    window.addEventListener('mps:edl-timeline-updated', _reactToCutDiff);

    // Warm the cache on load
    refreshActionCache();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    setTimeout(_init, 400);
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.PFX_SMART_RUN = {
    run,
    getNextAction,
    getNextActionForMarkers,
    getIssueGroups,
    buildPreflightSummary,
    safeFixAction,
    renderIssueInbox,
    refreshActionCache,
    ACTION_META,
    ISSUE_GROUPS,
  };

  console.info('[SMART_RUN] Smart Run module ready');
})();
