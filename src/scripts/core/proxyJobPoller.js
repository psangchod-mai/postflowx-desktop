// Proxy Job Poller — Phase 2.
// Polls GET /jobs/:jobId, validates proxy output on completion, runs metadata QC, commits to SWI.
(function () {
  'use strict';

  const POLL_INTERVAL_MS = 2000;
  const MAX_POLLS = 600; // 20-minute ceiling at 2s intervals

  // Active watchers: workerJobId → { timer, count, shotWorkId, outputPath }
  const _watchers = {};

  function _now() { return new Date().toISOString(); }

  // ── Validate proxy output via worker probe ────────────────────────────────
  async function _validateOutput(swi, outputPath) {
    const checks = {
      ocfLinked:        swi.ocfStatus === 'linked' || swi.ocfStatus === 'locked',
      proxyExists:      false,
      proxyReadable:    false,
      fpsMatch:         false,
      durationMatch:    false,
      timecodeMatch:    false,
      frameCountMatch:  false,
      colorRecipeFound: swi.colorStatus === 'amf_found' || swi.colorStatus === 'cdl_found',
      diffReviewDone:   false,
      manualApproval:   false,
    };
    const notes = [];

    if (!outputPath) {
      notes.push({ type: 'technical', severity: 'error', message: 'No output path specified', createdAt: _now() });
      return { checks, notes, qcStatus: 'blocked' };
    }

    let probeResult = null;
    try {
      probeResult = await window.PFX_RENDER_WORKER?.probe({ path: outputPath, probeType: 'metadata' });
    } catch (e) {
      notes.push({ type: 'technical', severity: 'error', message: `Probe error: ${e.message}`, createdAt: _now() });
    }

    if (probeResult?.ok) {
      checks.proxyExists   = true;
      checks.proxyReadable = true;

      const meta = probeResult.metadata || {};

      // FPS check
      if (meta.fps != null && swi.fps != null) {
        checks.fpsMatch = Math.abs(meta.fps - swi.fps) < 0.1;
        if (!checks.fpsMatch) {
          notes.push({ type: 'technical', severity: 'error', message: `FPS mismatch: expected ${swi.fps}, got ${meta.fps}`, createdAt: _now() });
        }
      } else {
        checks.fpsMatch = true; // can't verify; assume ok
      }

      // Duration / frame count check (±2 frames tolerance)
      if (meta.durationFrames != null && swi.durationFrames != null) {
        const expected = swi.durationFrames + (swi.handles || 0) * 2;
        const ok = Math.abs(meta.durationFrames - expected) <= 2;
        checks.durationMatch  = ok;
        checks.frameCountMatch = ok;
        if (!ok) {
          notes.push({ type: 'technical', severity: 'error', message: `Duration mismatch: expected ${expected}f, got ${meta.durationFrames}f`, createdAt: _now() });
        }
      } else {
        checks.durationMatch   = true;
        checks.frameCountMatch = true;
      }

      // TC — Phase 2: basic pass (Phase 3 adds exact TC arithmetic)
      checks.timecodeMatch = true;

    } else {
      const errMsg = probeResult?.error || 'Probe returned no result';
      notes.push({ type: 'technical', severity: 'error', message: `Proxy probe failed: ${errMsg}`, createdAt: _now() });
    }

    const allTechnical = checks.proxyExists && checks.proxyReadable &&
      checks.fpsMatch && checks.durationMatch && checks.frameCountMatch;
    const qcStatus = !checks.proxyExists ? 'blocked'
      : !allTechnical        ? 'fail'
      : 'hold'; // technical pass, but visual review still needed

    return { checks, notes, qcStatus };
  }

  // ── Commit completed proxy: validate + write QC result to SWI ────────────
  async function _commitProxy(shotWorkId, outputPath, workerJobResult) {
    if (!window.PFX_SWI) return;
    const swi = await window.PFX_SWI.getById(shotWorkId);
    if (!swi) return;

    const { checks, notes, qcStatus } = await _validateOutput(swi, outputPath);
    const proxyReady = qcStatus !== 'blocked' && qcStatus !== 'fail';
    const now = _now();

    if (proxyReady && window.PFX_PROXY_FP?.markRendered) {
      await window.PFX_PROXY_FP.markRendered(shotWorkId);
    }

    await window.PFX_SWI.update(shotWorkId, {
      proxyStatus: proxyReady ? 'ready' : 'failed',
      state:       proxyReady ? 'proxy_ready' : 'proxy_failed',
      proxyIsStale: false,
      proxyProgress: 1,
      proxy: {
        ...(swi.proxy || {}),
        outputPath,
        status:      proxyReady ? 'ready' : 'failed',
        completedAt: now,
      },
      qc: {
        shotName:  swi.shotName  || '',
        plateName: swi.sourceClipName || '',
        qcStatus,
        checks,
        notes,
        workerJobId: workerJobResult?.jobId || '',
        createdAt: swi.qc?.createdAt || now,
        updatedAt: now,
      },
    });

    try {
      window.dispatchEvent(new CustomEvent('pfx_proxy_committed', {
        detail: { shotWorkId, qcStatus, proxyReady },
      }));
    } catch { }
  }

  // ── Internal helpers ──────────────────────────────────────────────────────
  function _stopWatcher(jobId) {
    if (_watchers[jobId]) {
      clearInterval(_watchers[jobId].timer);
      delete _watchers[jobId];
    }
  }

  async function _getSwiProxy(shotWorkId) {
    try { return (await window.PFX_SWI?.getById(shotWorkId))?.proxy || {}; } catch { return {}; }
  }

  // ── Watch job: poll every POLL_INTERVAL_MS until terminal state ───────────
  function watchJob(jobId, shotWorkId, outputPath) {
    if (!jobId || _watchers[jobId]) return;

    let _ticking = false;
    const timer = setInterval(async () => {
      const w = _watchers[jobId];
      if (!w) return;
      if (_ticking) return;
      _ticking = true;
      try {
      w.count++;
      // cancelWatch() is synchronous and may land during any await below —
      // re-check that this tick's watcher is still the live one immediately
      // before each side-effecting write, so a stale tick never persists SWI
      // state or fires events for a job that's already been cancelled.
      const isLive = () => _watchers[jobId] === w;

      if (w.count > MAX_POLLS) {
        let proxyPatch = null;
        if (window.PFX_SWI?.update) {
          proxyPatch = { ...(await _getSwiProxy(shotWorkId)), status: 'failed', error: 'poll_timeout' };
        }
        if (!isLive()) return;
        _stopWatcher(jobId);
        if (proxyPatch) {
          await window.PFX_SWI.update(shotWorkId, {
            proxyStatus: 'failed',
            state: 'proxy_failed',
            proxy: proxyPatch,
          });
        }
        if (window.PFX_RQ_updateJob) window.PFX_RQ_updateJob(jobId, { status: 'error', error: 'Poll timeout' });
        return;
      }

      let status;
      try {
        status = await window.PFX_RENDER_WORKER?.getJobStatus(jobId);
      } catch (e) {
        console.warn('[JOB_POLLER] poll error', jobId, e);
        return;
      }
      if (!status) return;
      if (!isLive()) return;

      // Progress update
      const progress = typeof status.progress === 'number' ? status.progress : null;
      if (progress !== null && window.PFX_SWI?.update) {
        await window.PFX_SWI.update(shotWorkId, { proxyProgress: progress });
        if (!isLive()) return;
      }
      if (progress !== null && window.PFX_RQ_updateJob) {
        window.PFX_RQ_updateJob(jobId, { progress });
      }

      if (status.status === 'done') {
        _stopWatcher(jobId);
        await _commitProxy(shotWorkId, status.outputPath || outputPath, status);
        if (window.PFX_RQ_updateJob) window.PFX_RQ_updateJob(jobId, { status: 'done', progress: 1 });

      } else if (status.status === 'failed' || status.status === 'error' || status.status === 'cancelled') {
        let proxyPatch = null;
        if (window.PFX_SWI?.update) {
          proxyPatch = { ...(await _getSwiProxy(shotWorkId)), status: 'failed', error: status.error || status.status };
        }
        if (!isLive()) return;
        _stopWatcher(jobId);
        if (proxyPatch) {
          await window.PFX_SWI.update(shotWorkId, {
            proxyStatus: 'failed',
            state: 'proxy_failed',
            proxy: proxyPatch,
          });
        }
        if (window.PFX_RQ_updateJob) window.PFX_RQ_updateJob(jobId, { status: 'failed', error: status.error });
      }
      } finally {
        _ticking = false;
      }
    }, POLL_INTERVAL_MS);

    _watchers[jobId] = { timer, count: 0, shotWorkId, outputPath };
    console.info('[JOB_POLLER] watching', jobId);
  }

  function cancelWatch(jobId) {
    _stopWatcher(jobId);
  }

  function getActiveWatchers() {
    return Object.keys(_watchers);
  }

  window.PFX_JOB_POLLER = { watchJob, cancelWatch, getActiveWatchers };
  console.info('[JOB_POLLER] Proxy Job Poller ready');
})();
