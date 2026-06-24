// Proxy Fingerprint — Phase 1.
// Computes a stale-detection hash for each ShotWorkItem's proxy.
// Proxy is stale when any input to the render changes.
(function () {
  'use strict';

  function _hashString(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
    return (h >>> 0).toString(16);
  }

  function _version() {
    try { return String(window.__PFX_VERSION || '1.0').trim(); } catch { return '1.0'; }
  }

  function _proxyProfile() {
    return localStorage.getItem('pfx.proxy.profile') || 'h264_rec709_review_v1';
  }

  function _burninProfile() {
    return localStorage.getItem('pfx.proxy.burnin') || 'tc_clip_shot_v1';
  }

  // ── Compute fingerprint from a ShotWorkItem ───────────────────────────────
  function compute(swi) {
    if (!swi) return null;
    const fp = {
      shotWorkId:       swi.shotWorkId,
      sourcePath:       swi.ocf?.path || '',
      sourceMtime:      swi.ocf?.mtime || 0,
      sourceSize:       swi.ocf?.size  || 0,
      srcTcIn:          swi.srcTcIn  || '',
      srcTcOut:         swi.srcTcOut || '',
      fps:              swi.fps      || 24,
      handles:          swi.handles  || 0,
      colorRecipeHash:  swi.color?.hash || '',
      proxyProfile:     _proxyProfile(),
      burninProfile:    _burninProfile(),
      postflowxVersion: _version(),
    };

    const fingerString = [
      fp.sourcePath, String(fp.sourceMtime), String(fp.sourceSize),
      fp.srcTcIn, fp.srcTcOut, String(fp.fps), String(fp.handles),
      fp.colorRecipeHash, fp.proxyProfile, fp.burninProfile,
    ].join('|');

    fp.hash = _hashString(fingerString);
    return fp;
  }

  // ── Check if a SWI's proxy is stale ──────────────────────────────────────
  function isStale(swi) {
    if (!swi) return false;
    if (swi.proxyStatus === 'not_required' || swi.proxyStatus === 'blocked') return false;
    if (!swi.proxyFingerprint) return true; // no fingerprint = never rendered
    const current = compute(swi);
    return current.hash !== swi.proxyFingerprint.hash;
  }

  // ── Update fingerprint on SWI after proxy render ──────────────────────────
  async function markRendered(shotWorkId) {
    if (!window.PFX_SWI?.getById) return;
    const swi = await window.PFX_SWI.getById(shotWorkId);
    if (!swi) return;
    const fp = compute(swi);
    await window.PFX_SWI.update(shotWorkId, {
      proxyFingerprint: fp,
      proxyIsStale:     false,
      proxyStatus:      'ready',
    });
  }

  // ── Explain why a proxy is stale ─────────────────────────────────────────
  function computeStaleReasons(swi) {
    if (!swi || !swi.proxyFingerprint) return ['proxy never rendered'];
    const old = swi.proxyFingerprint;
    const reasons = [];
    if (old.srcTcIn !== (swi.srcTcIn || '') || old.srcTcOut !== (swi.srcTcOut || ''))
      reasons.push('marker range changed');
    if (old.handles !== (swi.handles || 0))
      reasons.push('handles changed');
    if (old.sourcePath !== (swi.ocf?.path || ''))
      reasons.push('OCF path changed');
    if (old.sourceMtime !== (swi.ocf?.mtime || 0))
      reasons.push('OCF file mtime changed');
    if (old.sourceSize !== (swi.ocf?.size || 0))
      reasons.push('OCF file size changed');
    if (old.colorRecipeHash !== (swi.color?.hash || ''))
      reasons.push('color recipe changed');
    if (old.proxyProfile !== _proxyProfile())
      reasons.push('proxy profile changed');
    if (old.burninProfile !== _burninProfile())
      reasons.push('burn-in changed');
    return [...new Set(reasons)];
  }

  // ── Mark a single SWI as stale with reasons ───────────────────────────────
  async function markStale(shotWorkId, reasons) {
    if (!window.PFX_SWI) return;
    const swi = await window.PFX_SWI.getById(shotWorkId);
    if (!swi) return;
    const existing = Array.isArray(swi.proxyStaleReasons) ? swi.proxyStaleReasons : [];
    const merged   = [...new Set([...existing, ...(reasons || [])])];
    await window.PFX_SWI.update(shotWorkId, {
      proxyIsStale:      true,
      proxyStatus:       swi.proxyStatus === 'ready' ? 'stale' : swi.proxyStatus,
      proxyStaleReasons: merged,
    });
  }

  // ── Check all SWIs and mark stale ─────────────────────────────────────────
  async function checkAll() {
    if (!window.PFX_SWI) return { ok: false };
    const projectId = window.PFX_SWI.getProjectId ? window.PFX_SWI.getProjectId() : 'default';
    const all = await window.PFX_SWI.getAll(projectId);
    let staleCount = 0;
    for (const swi of all) {
      if (swi.proxyStatus === 'ready' && isStale(swi)) {
        const reasons = computeStaleReasons(swi);
        await window.PFX_SWI.update(swi.shotWorkId, {
          proxyIsStale:      true,
          proxyStatus:       'stale',
          proxyStaleReasons: reasons,
        });
        staleCount++;
      }
    }
    return { ok: true, stale: staleCount };
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.PFX_PROXY_FP = {
    compute,
    isStale,
    markRendered,
    checkAll,
    computeStaleReasons,
    markStale,
  };

  console.info('[PROXY_FP] Proxy Fingerprint module ready');
})();
