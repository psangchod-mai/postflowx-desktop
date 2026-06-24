// Proxy Job Builder — Phase 1.
// Filters ShotWorkItems to build marker-only proxy job queue.
// Does NOT render. Submits jobs to PFX_RENDER_WORKER and PFX_RQ (render queue UI).
(function () {
  'use strict';

  function _now() { return new Date().toISOString(); }

  function _jobId(swi, version) {
    const v = String(version || '001').padStart(3, '0');
    return `proxy_${(swi.shotName || swi.shotWorkId.slice(4,20)).replace(/[^a-zA-Z0-9._-]/g, '_')}_v${v}`;
  }

  function _outputPath(swi, version) {
    const base = localStorage.getItem('pfx.project.shotsDir') || '/tmp/pfx_shots';
    const shot = (swi.shotName || swi.shotWorkId).replace(/[^a-zA-Z0-9._-]/g, '_');
    const v = String(version || '001').padStart(3, '0');
    const profile = localStorage.getItem('pfx.proxy.profile') || 'h264_rec709_review_v1';
    const ext = profile.startsWith('prores') ? '.mov' : '.mp4';
    return `${base}/${shot}/proxy/${shot}_proxy_v${v}${ext}`;
  }

  // ── Determine why a job is blocked ────────────────────────────────────────
  function getBlockedReasons(swi) {
    const reasons = [];
    if (!swi.enabled) reasons.push('marker disabled');
    if (swi.markerType !== 'VFX') reasons.push('not a VFX marker');
    if (swi.ocfStatus === 'missing') reasons.push('OCF missing');
    if (swi.ocfStatus === 'candidate' || swi.ocfStatus === 'ambiguous') {
      reasons.push('OCF ambiguous — needs manual confirm');
    }
    if (swi.colorStatus === 'conflict') reasons.push('AMF/color conflict');
    if (!swi.srcTcIn || swi.srcTcIn === '00:00:00:00') reasons.push('source TC missing');
    if (swi.proxyStatus === 'ready' && !swi.proxyIsStale) reasons.push('proxy already current');
    const workerOnline = window.PFX_RENDER_WORKER?.isOnline?.() ?? false;
    if (!workerOnline) reasons.push('render worker offline');
    return reasons;
  }

  // ── Create a single proxy job object ─────────────────────────────────────
  function createProxyJob(swi, version) {
    const jobId = _jobId(swi, version || 1);
    const outputPath = _outputPath(swi, version || 1);
    const proxyProfile = localStorage.getItem('pfx.proxy.profile') || 'h264_rec709_review_v1';
    const burninProfile = localStorage.getItem('pfx.proxy.burnin') || 'tc_clip_shot_v1';

    return {
      jobId,
      shotWorkId:   swi.shotWorkId,
      sourcePath:   swi.ocf?.path || '',
      srcTcIn:      swi.srcTcIn  || '',
      srcTcOut:     swi.srcTcOut || '',
      fps:          swi.fps      || 24,
      handles:      swi.handles  || 8,
      outputPath,
      proxyProfile,
      burninProfile,
      colorRecipe:  swi.color || { mode: 'bypass', status: 'bypass' },
      proxyIsStale: swi.proxyIsStale || false,
      createdAt:    _now(),
    };
  }

  // ── Build the full queue from SWIs ────────────────────────────────────────
  async function buildMarkerProxyJobs(filter) {
    // filter: 'all_vfx' | 'missing_only' | 'selected' | 'force_rebuild'
    if (!window.PFX_SWI) return { ok: false, error: 'SWI module not loaded' };

    const projectId = window.PFX_SWI.getProjectId ? window.PFX_SWI.getProjectId() : 'default';
    const all = await window.PFX_SWI.getAll(projectId);

    const vfxItems = all.filter(s => s.markerType === 'VFX' && s.enabled !== false);

    const jobs = [];
    const blocked = [];
    const skipped = [];

    for (const swi of vfxItems) {
      const isLinked = swi.ocfStatus === 'linked' || swi.ocfStatus === 'locked';

      if (!isLinked) {
        blocked.push({ swi, reasons: getBlockedReasons(swi) });
        continue;
      }

      if (filter !== 'force_rebuild' && swi.proxyStatus === 'ready' && !swi.proxyIsStale) {
        skipped.push({ swi, reason: 'proxy already current' });
        continue;
      }

      if (filter === 'missing_only' && swi.proxyStatus === 'ready') {
        skipped.push({ swi, reason: 'proxy exists' });
        continue;
      }

      const reasons = getBlockedReasons(swi).filter(r => r !== 'proxy already current');
      if (reasons.length > 0) {
        blocked.push({ swi, reasons });
        continue;
      }

      jobs.push(createProxyJob(swi));
    }

    return { ok: true, jobs, blocked, skipped, total: vfxItems.length };
  }

  // ── Submit jobs to render worker + UI queue ───────────────────────────────
  async function submitJobs(filter) {
    const result = await buildMarkerProxyJobs(filter || 'all_vfx');
    if (!result.ok) return result;

    const submitted = [];
    const failed    = [];

    for (const job of result.jobs) {
      // Submit to render worker
      let workerResult = { status: 'blocked', message: 'render_worker_offline' };
      try {
        if (window.PFX_RENDER_WORKER?.buildProxy) {
          workerResult = await window.PFX_RENDER_WORKER.buildProxy(job);
        }
      } catch (e) {
        workerResult = { status: 'blocked', message: e.message || 'worker_error' };
      }

      // Update SWI status
      const proxyStatus = workerResult.status === 'queued' || workerResult.status === 'rendering'
        ? 'rendering' : 'blocked';

      if (window.PFX_SWI?.update) {
        await window.PFX_SWI.update(job.shotWorkId, {
          proxyStatus,
          state: proxyStatus === 'rendering' ? 'proxy_rendering' : 'proxy_pending',
          proxy: {
            jobId:      job.jobId,
            outputPath: job.outputPath,
            status:     proxyStatus,
            workerMsg:  workerResult.message || '',
            submittedAt: new Date().toISOString(),
          },
        });
      }

      // Add to render queue UI (stem = workerJobId so PFX_RQ_updateJob can find it)
      if (window.PFX_RQ_addJob) {
        const swi = await window.PFX_SWI?.getById(job.shotWorkId);
        const label = `${swi?.shotName || job.jobId} — Marker Proxy`;
        window.PFX_RQ_addJob({
          type:   'marker_proxy',
          label,
          params: {
            module:       'marker_proxy',
            stem:         job.jobId,
            shotWorkId:   job.shotWorkId,
            outputPath:   job.outputPath,
            blockedReason: proxyStatus === 'blocked' ? workerResult.message : '',
          },
          status: proxyStatus === 'rendering' ? 'pending' : 'blocked',
        });
      }

      // Start polling for submitted jobs
      if (proxyStatus === 'rendering') {
        submitted.push(job.jobId);
        window.PFX_JOB_POLLER?.watchJob(job.jobId, job.shotWorkId, job.outputPath);
      } else {
        failed.push({ jobId: job.jobId, reason: workerResult.message });
      }
    }

    // Add blocked jobs to render queue as blocked entries for visibility
    for (const { swi, reasons } of result.blocked) {
      if (window.PFX_RQ_addJob) {
        window.PFX_RQ_addJob({
          type:   'marker_proxy',
          label:  `${swi.shotName || swi.shotWorkId} — Blocked`,
          params: { module: 'marker_proxy', shotWorkId: swi.shotWorkId, blockedReason: reasons.join('; ') },
          status: 'blocked',
        });
      }
    }

    return {
      ok: true,
      submitted:  submitted.length,
      blocked:    result.blocked.length,
      skipped:    result.skipped.length,
      failed:     failed.length,
    };
  }

  // ── Preflight summary (show before submitting) ────────────────────────────
  async function preflight(filter) {
    const result = await buildMarkerProxyJobs(filter || 'all_vfx');
    if (!result.ok) return result;

    const summary = {
      vfxMarkers:  result.total,
      ocfLinked:   result.jobs.length
        + result.skipped.filter(s => s.swi?.ocfStatus === 'linked' || s.swi?.ocfStatus === 'locked').length
        + result.blocked.filter(b => b.swi?.ocfStatus === 'linked' || b.swi?.ocfStatus === 'locked').length,
      ocfMissing:  result.blocked.filter(b => b.reasons.includes('OCF missing')).length,
      proxiesMissing: result.jobs.length,
      proxiesStale:   result.jobs.filter(j => {
        const swi = result.blocked.concat(result.skipped).map(x => x.swi)
          .concat(result.jobs.map(x => x._swi)).find(s => s?.shotWorkId === j.shotWorkId);
        // jobs carry shotWorkId; cross-reference from the original vfxItems via a rebuilt lookup
        // simpler fix: track proxyIsStale on the job at creation time
        return j.proxyIsStale;
      }).length,
      proxiesSkipped: result.skipped.length,
      blockedJobs:    result.blocked,
      readyJobs:      result.jobs.length,
    };

    // Color/AMF counts
    const all = [...result.jobs, ...result.blocked.map(b => b.swi), ...result.skipped.map(s => s.swi)]
      .filter(Boolean);
    summary.amfFound = all.filter(s => s.colorStatus === 'amf_found').length;
    summary.colorFallback = all.filter(s => s.colorStatus === 'aces_default' || s.colorStatus === 'bypass').length;

    return { ok: true, summary, jobs: result.jobs };
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.PFX_PROXY_JOBS = {
    buildMarkerProxyJobs,
    createProxyJob,
    getBlockedReasons,
    submitJobs,
    preflight,
  };

  console.info('[PROXY_JOBS] Proxy Job Builder ready');
})();
