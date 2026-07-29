// Marker Proxy QC Settings UI wiring.
// Runs after DOMContentLoaded; connects index.html settings panel to module APIs.
(function () {
  'use strict';

  // HTML-escape file/user-derived strings before interpolating into innerHTML.
  const _esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const LS = {
    PROXY_PROFILE:        'pfx.proxy.profile',
    RENDER_BACKEND:       'pfx.worker.backend',
    WORKER_PORT:          'pfx.worker.port',
    POLICY_VFX_ONLY:      'pfx.policy.vfx_only',
    POLICY_SKIP_CURRENT:  'pfx.policy.skip_current',
    POLICY_REBUILD_RANGE: 'pfx.policy.rebuild_range',
    POLICY_REBUILD_COLOR: 'pfx.policy.rebuild_color',
    POLICY_CONFIRM_LOW:   'pfx.policy.confirm_low_score',
    POLICY_AUTO_RENDER:   'pfx.policy.auto_render',
  };

  function _wire() {
    // ── OCF Roots ──────────────────────────────────────────────────────────
    const addRootBtn     = document.getElementById('pfxOcfAddRootBtn');
    const rebuildIdxBtn  = document.getElementById('pfxOcfRebuildIndexBtn');
    const rootsList      = document.getElementById('pfxOcfRootsList');
    const indexStatus    = document.getElementById('pfxOcfIndexStatus');

    // Shared between the "Add OCF Folder" (scan) and "Rebuild Index" buttons:
    // both write to the same indexStatus/rootsList DOM, so whichever click's
    // await resolves last must not be allowed to overwrite the other's
    // (possibly newer) result.
    let _ocfIdxSeq = 0;

    function _refreshRootsList() {
      if (!rootsList || !window.PFX_OCF_INDEX) return;
      const roots = window.PFX_OCF_INDEX.getRoots();
      if (!roots.length) {
        rootsList.textContent = 'No OCF roots configured.';
        return;
      }
      rootsList.innerHTML = roots.map((r, i) =>
        `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${_esc(r.path)}">${_esc(r.label || r.path)}</span>
          <button data-root-idx="${i}" style="font-size:10px;opacity:.5;background:none;border:none;color:#f88;cursor:pointer;">✕</button>
        </div>`
      ).join('');
      rootsList.querySelectorAll('[data-root-idx]').forEach(btn => {
        btn.addEventListener('click', () => {
          window.PFX_OCF_INDEX.removeRoot(Number(btn.dataset.rootIdx));
          _refreshRootsList();
        });
      });
      const count = localStorage.getItem('pfx.ocf.count') || '?';
      const at    = localStorage.getItem('pfx.ocf.indexedAt') || '';
      if (indexStatus) indexStatus.textContent = `${count} files indexed${at ? ' · ' + at.slice(0,10) : ''}`;
    }

    if (addRootBtn) {
      addRootBtn.addEventListener('click', async () => {
        if (!window.PFX_OCF_INDEX) return;
        const seq = ++_ocfIdxSeq;
        addRootBtn.disabled = true;
        addRootBtn.textContent = 'Scanning…';
        try {
          const r = await window.PFX_OCF_INDEX.scanNewRoot();
          if (seq === _ocfIdxSeq) {
            if (r.ok) {
              _refreshRootsList();
              if (indexStatus) indexStatus.textContent = `${r.count} files indexed`;
            } else {
              console.warn('[Settings] scanNewRoot:', r.error);
            }
          }
        } catch (e) {
          console.warn('[Settings] addRoot error', e);
        } finally {
          addRootBtn.disabled = false;
          addRootBtn.textContent = '+ Add OCF Folder';
        }
      });
    }

    if (rebuildIdxBtn) {
      rebuildIdxBtn.addEventListener('click', async () => {
        if (!window.PFX_OCF_INDEX) return;
        const seq = ++_ocfIdxSeq;
        rebuildIdxBtn.disabled = true;
        rebuildIdxBtn.textContent = '↻ Rebuilding…';
        try {
          const r = await window.PFX_OCF_INDEX.rebuildIndex();
          if (seq === _ocfIdxSeq) {
            if (indexStatus) indexStatus.textContent = `${r.count} files indexed`;
            _refreshRootsList();
          }
        } catch (e) {
          console.warn('[Settings] rebuildIndex error', e);
        } finally {
          rebuildIdxBtn.disabled = false;
          rebuildIdxBtn.textContent = '↻ Rebuild Index';
        }
      });
    }

    _refreshRootsList();

    // ── Policy checkboxes ──────────────────────────────────────────────────
    const policyMap = {
      pfxPolicyVfxOnly:       LS.POLICY_VFX_ONLY,
      pfxPolicySkipCurrent:   LS.POLICY_SKIP_CURRENT,
      pfxPolicyRebuildRange:  LS.POLICY_REBUILD_RANGE,
      pfxPolicyRebuildColor:  LS.POLICY_REBUILD_COLOR,
      pfxPolicyConfirmLowScore: LS.POLICY_CONFIRM_LOW,
      pfxPolicyAutoRender:    LS.POLICY_AUTO_RENDER,
    };
    Object.entries(policyMap).forEach(([id, lsKey]) => {
      const cb = document.getElementById(id);
      if (!cb) return;
      const stored = localStorage.getItem(lsKey);
      if (stored !== null) cb.checked = stored === '1';
      cb.addEventListener('change', () => localStorage.setItem(lsKey, cb.checked ? '1' : '0'));
    });

    // ── Proxy profile ──────────────────────────────────────────────────────
    const profileSel = document.getElementById('pfxProxyProfileSelect');
    if (profileSel) {
      const _storedProfile = localStorage.getItem(LS.PROXY_PROFILE) || 'h264_rec709_review_v1';
      profileSel.value = _storedProfile;
      if (profileSel.value !== _storedProfile) {
        // Stored value no longer maps to a valid option — reset to default.
        profileSel.value = 'h264_rec709_review_v1';
        localStorage.setItem(LS.PROXY_PROFILE, profileSel.value);
      }
      profileSel.addEventListener('change', () => {
        localStorage.setItem(LS.PROXY_PROFILE, profileSel.value);
      });
    }

    // ── Render backend ──────────────────────────────────────────────────────
    const backendSel  = document.getElementById('pfxRenderBackendSelect');
    const workerStatus = document.getElementById('pfxWorkerStatus');

    if (backendSel) {
      backendSel.value = localStorage.getItem(LS.RENDER_BACKEND) || 'local_http';
      backendSel.addEventListener('change', () => {
        const val = backendSel.value;
        localStorage.setItem(LS.RENDER_BACKEND, val);
        if (window.PFX_RENDER_WORKER) {
          window.PFX_RENDER_WORKER.setMockMode(val === 'mock');
        }
        _refreshWorkerStatus();
      });

      // Restore mock mode from settings
      if (backendSel.value === 'mock' && window.PFX_RENDER_WORKER) {
        window.PFX_RENDER_WORKER.setMockMode(true);
      }
    }

    function _refreshWorkerStatus() {
      if (!workerStatus || !window.PFX_RENDER_WORKER) return;
      const isMock = window.PFX_RENDER_WORKER.isMockMode?.();
      if (isMock) { workerStatus.textContent = 'mock mode'; workerStatus.style.color = '#aaa'; return; }
      const online = window.PFX_RENDER_WORKER.isOnline?.();
      workerStatus.textContent = online ? '● online' : '○ offline';
      workerStatus.style.color = online ? '#4ca84c' : '#c05050';
    }

    _refreshWorkerStatus();
    window.addEventListener('pfx_worker_status', _refreshWorkerStatus);
  }

  // Wire after DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wire);
  } else {
    // Defer slightly to let other defer scripts initialize their globals
    setTimeout(_wire, 300);
  }

  console.info('[MARKER_PROXY_SETTINGS] Settings wiring module ready');
})();
