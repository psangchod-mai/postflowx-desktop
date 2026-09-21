// Render Worker Client — Phase 1.
// HTTP client to local render worker (default port 47125).
// Production behavior is fail-closed: an offline worker is reported as blocked.
// The deterministic mock is available only when a test harness explicitly sets
// window.__PFX_ALLOW_RENDER_MOCKS__ = true before this script loads.
(function () {
  'use strict';

  const DEFAULT_PORT = 47125;
  const HEALTH_INTERVAL_ONLINE  = 15000;  // ms — when worker is reachable
  const HEALTH_INTERVAL_OFFLINE = 60000;  // ms — back-off when offline to avoid console spam

  let _port = DEFAULT_PORT;
  let _online = false;
  let _healthTimer = null;
  let _mockMode = false;
  let _consecutiveFails = 0;

  function _base() { return `http://127.0.0.1:${_port}`; }

  function _mockAllowed() {
    return window.__PFX_ALLOW_RENDER_MOCKS__ === true;
  }

  function _workerUnavailable(operation, extra = {}) {
    return {
      ok: false,
      status: 'blocked',
      code: 'render_worker_offline',
      operation,
      message: 'Render worker is offline. Open Settings to start or repair the local media service.',
      ...extra,
    };
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────
  async function _get(path, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 4000);
    try {
      const res = await fetch(_base() + path, { signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  async function _post(path, body, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
    try {
      const res = await fetch(_base() + path, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal:  ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }

  // ── Mock stub responses ───────────────────────────────────────────────────
  const _mockJobs = {};

  function _mockHealth() {
    return { ok: true, status: 'mock', version: '0.0.1-stub', message: 'Mock worker (no real worker found)' };
  }

  function _mockProbe(req) {
    return {
      ok: true, path: req.path,
      metadata: { codec: 'unknown', fps: 24, width: 1920, height: 1080, timecodeStart: '00:00:00:00' },
      message: 'mock probe'
    };
  }

  function _mockBuildProxy(job) {
    const jobId = job.jobId || `mock_${Date.now()}`;
    _mockJobs[jobId] = { jobId, status: 'queued', progress: 0, outputPath: job.outputPath };
    setTimeout(() => { if (_mockJobs[jobId]) _mockJobs[jobId].status = 'rendering'; }, 200);
    setTimeout(() => { if (_mockJobs[jobId]) { _mockJobs[jobId].status = 'done'; _mockJobs[jobId].progress = 1; } }, 3000);
    return { jobId, status: 'queued', message: 'queued (mock)' };
  }

  function _mockGetJobStatus(jobId) {
    const j = _mockJobs[jobId];
    if (!j) return { jobId, status: 'not_found', error: 'Job not found in mock' };
    return { jobId, status: j.status, progress: j.progress || 0, outputPath: j.outputPath, error: null };
  }

  function _mockCancelJob(jobId) {
    if (_mockJobs[jobId]) { _mockJobs[jobId].status = 'cancelled'; }
    return { jobId, status: 'cancelled' };
  }

  // ── Real worker calls ─────────────────────────────────────────────────────
  async function health() {
    if (_mockMode && _mockAllowed()) return _mockHealth();
    try {
      const result = await _get('/health', 3000);
      _online = true;
      _consecutiveFails = 0;
      return result;
    } catch (e) {
      _online = false;
      _consecutiveFails++;
      return { ok: false, status: 'offline', error: e.message };
    }
  }

  async function probe(req) {
    if (_mockMode && _mockAllowed()) return _mockProbe(req);
    if (!_online) return _workerUnavailable('probe', { path: req?.path || '' });
    try {
      return await _post('/probe', req);
    } catch (e) {
      return { ok: false, error: e.message, path: req.path };
    }
  }

  async function buildProxy(job) {
    if (_mockMode && _mockAllowed()) return _mockBuildProxy(job);
    if (!_online) return _workerUnavailable('build-proxy', { jobId: job?.jobId || '' });
    try {
      return await _post('/build-proxy', job, 10000);
    } catch (e) {
      _online = false;
      return { status: 'blocked', message: `render_worker_offline: ${e.message}` };
    }
  }

  async function getJobStatus(jobId) {
    if (_mockMode && _mockAllowed()) return _mockGetJobStatus(jobId);
    if (!_online) return _workerUnavailable('job-status', { jobId });
    try {
      return await _get(`/jobs/${encodeURIComponent(jobId)}`);
    } catch (e) {
      return { jobId, status: 'unknown', error: e.message };
    }
  }

  async function cancelJob(jobId) {
    if (_mockMode && _mockAllowed()) return _mockCancelJob(jobId);
    if (!_online) return _workerUnavailable('cancel-job', { jobId });
    try {
      return await _post(`/jobs/${encodeURIComponent(jobId)}/cancel`, {});
    } catch (e) {
      return { jobId, status: 'unknown', error: e.message };
    }
  }

  function isOnline() { return _online; }
  function isMockMode() { return _mockMode && _mockAllowed(); }
  function setMockMode(enabled) {
    if (enabled && !_mockAllowed()) {
      _mockMode = false;
      console.warn('[RW] Mock render mode is disabled in production builds.');
      return false;
    }
    _mockMode = !!enabled;
    return _mockMode;
  }
  function setPort(p) { _port = Number(p) || DEFAULT_PORT; }

  // ── Periodic health check ─────────────────────────────────────────────────
  function startHealthCheck() {
    if (_healthTimer) return;
    const scheduleNext = () => {
      const interval = _online ? HEALTH_INTERVAL_ONLINE : HEALTH_INTERVAL_OFFLINE;
      _healthTimer = setTimeout(runCheck, interval);
    };
    const runCheck = async () => {
      _healthTimer = null;
      const prev = _online;
      await health();
      if (prev !== _online) {
        try {
          const event = new CustomEvent('pfx_worker_status', { detail: { online: _online } });
          window.dispatchEvent(event);
        } catch { }
      }
      scheduleNext();
    };
    runCheck();
  }

  function stopHealthCheck() {
    if (_healthTimer) { clearInterval(_healthTimer); _healthTimer = null; }
  }

  // Load saved port from settings
  const savedPort = parseInt(localStorage.getItem('pfx.worker.port') || '0', 10);
  if (savedPort > 1000) _port = savedPort;

  // Start health check on load
  startHealthCheck();

  // ── Public API ────────────────────────────────────────────────────────────
  window.PFX_RENDER_WORKER = {
    health,
    probe,
    buildProxy,
    getJobStatus,
    cancelJob,
    isOnline,
    isMockMode,
    setMockMode,
    setPort,
    startHealthCheck,
    stopHealthCheck,
  };

  console.info('[RENDER_WORKER] Render Worker Client ready (port:', _port, ')');
})();
