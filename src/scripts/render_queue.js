// Render Queue — persistent export job manager for PostFlowX.
// Jobs survive extension reloads; history persists across sessions.
(function () {
  'use strict';

  // ── Constants ──────────────────────────────────────────────────────────────

  const JOBS_KEY    = 'mps.renderQueue.jobs.v1';
  const PAUSED_KEY  = 'mps.renderQueue.paused.v1';
  const HISTORY_KEY = 'mps.renderQueue.history.v1';
  const VIEW_KEY    = 'mps.renderQueue.view.v1';

  const HEAVY_FMTS  = new Set(['qt', 'qt_full', 'package', 'vfxpackage', 'xlsx']);
  const EXPECTED_OUTPUT_FMTS = new Set(['qt', 'qt_full', 'package', 'xlsx']);
  const MAX_RETRIES = 3;
  const MAX_LOG     = 30;
  const MAX_HISTORY = 50;
  const RECHECK_MS  = 5_000;   // how often to re-evaluate blocked jobs

  const TYPE_LABEL = {
    qt:'QT Shot Export', qt_full:'QT Full Timeline', package:'Package (ZIP)', vfxpackage:'VFX Package',
    xlsx:'Excel (XLSX)', pulledl:'Pull EDL', ale:'Status ALE',
    srt:'SRT Subtitles', markersxml:'Markers XML', csv:'Pull List CSV',
    vfxcsv:'VFX Breakdown CSV', xls:'Change List XLSX', edl:'Conformed EDL',
    report:'IMF Validation Report', rvw_json:'Reviews JSON', rvw_csv:'Reviews CSV',
  };

  const MOD_META = {
    pulls:   { label:'PULLS',    color:'#4a8ad4', tab:'PULLS PREP 2.0'  },
    cd2:     { label:'CUT DIFF', color:'#9060c0', tab:'CUT DIFF 2.0'    },
    trlconf: { label:'TRAILER',  color:'#c07030', tab:'TRAILER CONFORM'  },
    imf:     { label:'IMF',      color:'#30a0b0', tab:'IMF'              },
    reviews: { label:'REVIEWS',  color:'#40a060', tab:'REVIEWS'          },
  };

  const PHASE_LABEL = {
    seeking:'Seeking', extracting:'Extracting',
    encoding:'Encoding', muxing:'Muxing', saving:'Saving',
  };
  const PHASE_ORDER = ['seeking','extracting','encoding','muxing','saving'];

  // ── Job types ──────────────────────────────────────────────────────────────

  const JOB_TYPES = ['probe', 'copy', 'render', 'qc', 'marker_proxy'];
  const JOB_TYPE_LABEL = { probe: 'Probe', copy: 'Copy', render: 'Render', qc: 'QC', marker_proxy: 'Marker Proxy' };
  const JOB_TYPE_COLOR = { probe: '#4a8ad4', copy: '#9060c0', render: '#c07030', qc: '#30a060', marker_proxy: '#7040c0' };
  let _typeFilter = 'all';

  // ── State ──────────────────────────────────────────────────────────────────

  let _jobs        = [];
  let _history     = [];
  let _paused      = false;
  let _busy        = false;
  let _tickTimer    = null;
  let _recheckTimer = null;
  let _sysPollTimer = null;
  let _sysStats     = { cpu: 0, cpuActiveCores: null, cpuEqCores: null, ramUsed: 0, ramTotal: 0, ramPct: 0, gpu: null };
  let _gpuName      = '';
  let _cpuCores     = 0;
  let _historyOpen = false;
  let _viewMode    = 'progress';
  let _dragId      = null;
  const _dirHandles = new Map();  // jobId → FileSystemDirectoryHandle (not serialisable; in-memory only)

  let _resumeCount          = 0;    // jobs interrupted by reload, set by _load()
  let _resumeCountdown      = 0;    // seconds left in auto-start countdown
  let _resumeCountdownTimer = null; // setInterval handle

  // ── Persistence ────────────────────────────────────────────────────────────

  function _save() {
    try { localStorage.setItem(JOBS_KEY, JSON.stringify(_jobs)); } catch {}
  }

  function _saveHistory() {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(_history)); } catch {}
  }

  function _saveView() {
    try { localStorage.setItem(VIEW_KEY, _viewMode); } catch {}
  }

  function _load() {
    try {
      _jobs    = JSON.parse(localStorage.getItem(JOBS_KEY)    || '[]');
      _history = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      _paused  = localStorage.getItem(PAUSED_KEY) === '1';
      _viewMode = localStorage.getItem(VIEW_KEY) === 'completed' ? 'completed' : 'progress';
      let dirty = false;
      _resumeCount = 0;
      _jobs.forEach(j => {
        if (!j.type) j.type = 'render';
        if (j.requiresResolve === undefined) j.requiresResolve = j.params?.fmt === 'vfxpackage';
        if (!Array.isArray(j.requireReasons)) j.requireReasons = [];
        if (j.resolveEngine === undefined) j.resolveEngine = null;
        if (j.status === 'running' || j.status === 'cancelling' || j.status === 'starting_engine') {
          j._interruptedProgress = j.progress       || 0;
          j._interruptedSteps    = j.completedSteps || 0;
          j._interruptedAt       = Date.now();
          j.status = 'pending'; j.progress = 0; j.completedSteps = 0;
          j.startedAt = null; j.phase = null; j._resumed = true; dirty = true;
          if (j.readiness) j.readiness = { ...j.readiness, starting: false, autoStarting: false };
          _resumeCount++;
        }
      });
      if (dirty) _save();
    } catch { _jobs = []; _history = []; }
  }

  function _archiveJob(j) {
    _history.unshift({
      id: j.id, label: j.label, fmt: j.fmt,
      module:      j.params?.module || 'pulls',
      status:      j.status,
      encoderPath: j.encoderPath || null,
      encoderDetail: j.encoderDetail || null,
      completedAt: j.completedAt || Date.now(),
      startedAt:   j.startedAt,
      error:       j.error || null,
      outputFiles: j.outputFiles || [],
      log:         j.log || [],
      duration:    (j.completedAt && j.startedAt)
        ? Math.round((j.completedAt - j.startedAt) / 1000) : null,
    });
    if (_history.length > MAX_HISTORY) _history.length = MAX_HISTORY;
    _saveHistory();
  }

  // ── Save-location picker ───────────────────────────────────────────────────

  // Called immediately after a job is created (still within the user-gesture
  // chain from the Export click), so showDirectoryPicker is permitted.
  async function _promptSaveDir(job) {
    if (typeof window.showDirectoryPicker !== 'function') return;
    try {
      const handle = await window.showDirectoryPicker({
        id: 'pfx-export',         // Chrome remembers this location across calls
        mode: 'readwrite',
        startIn: 'downloads',
      });
      _dirHandles.set(job.id, handle);
      job.saveDir = handle.name;
      _save(); _render();
    } catch {
      // User dismissed — saveDir stays null, falls back to Downloads
    }
  }

  async function _repickSaveDir(id) {
    const job = _jobs.find(j => j.id === id);
    if (!job) return;
    await _promptSaveDir(job);
  }

  // ── Intelligence: readiness checks ────────────────────────────────────────
  // A readiness check returns { ready: bool, reason: string, action: string }.
  // The queue runs a check before every job attempt and skips blocked jobs,
  // allowing later ready jobs to proceed.
  // Modules can register extended checks via window.__rqReadinessChecks[mod].

  function _checkReadiness(job) {
    const mod  = job.params.module || 'pulls';
    const meta = MOD_META[mod] || MOD_META.pulls;

    // Tier 1: Is the handler registered? (tab must be open)
    const handlerOk = mod === 'pulls'
      ? typeof window.__pmExportQueued === 'function'
      : typeof window.__rqExportHandlers?.[mod] === 'function';

    if (!handlerOk) {
      return {
        ready:  false,
        reason: `${meta.tab} tab not open`,
        action: `Open the ${meta.tab} tab to unblock`,
      };
    }

    // Tier 2: Optional extended check registered by the module
    const ext = window.__rqReadinessChecks?.[mod];
    if (typeof ext === 'function') {
      try {
        const r = ext(job);
        if (r && !r.ready) return r;
      } catch {}
    }

    // Tier 2.5: VFX Package — Resolve Engine availability check
    if (job.params.fmt === 'vfxpackage' && job.requiresResolve) {
      const ra = _resolveAvailability(job);
      if (!ra.canRunNow) {
        const resolveCode = !ra.enabled         ? 'DISABLED'
          : !ra.resolveInstalled                ? 'NOT_CONFIGURED'
          : ra.resolveMode === 'handoff'         ? 'HANDOFF_MODE'
          : ra.resolveMode === 'never'           ? 'LAUNCH_NEVER'
          : ra.resolveMode === 'background_auto' ? 'BACKGROUND_AUTO'
          : 'NOT_RUNNING';
        _dbgRq('VFX Package blocked', resolveCode, ra.reason);
        return {
          ready:             false,
          reason:            ra.reason,
          action: ra.resolveMode === 'handoff'
            ? 'Download handoff package and render in DaVinci Resolve'
            : ra.resolveMode === 'never'
            ? 'Change mode in Project Settings or create a handoff package'
            : ra.resolveMode === 'background_auto'
            ? 'PostFlowX will start Resolve Engine automatically'
            : !ra.configured
            ? 'Open Project Settings → Resolve Engine to configure'
            : 'Click Start Resolve & Retry to launch DaVinci Resolve',
          resolveBlocked:    true,
          resolveCode,
          resolveMode:       ra.resolveMode,
          resolvePath:       ra.path,
          resolveVersion:    ra.version,
          canAutoLaunch:     ra.canAutoLaunch,
          canManualLaunch:   ra.canManualLaunch,
          launchPolicy:      ra.launchPolicy,
          mode:              ra.mode,
        };
      }
      _dbgRq('VFX Package resolve ready', ra.resolveMode);
    }

    // Tier 3: Preflight readiness check (all job types)
    const pfxCheck = window.__rqReadinessChecks?.['preflight'];
    if (typeof pfxCheck === 'function') {
      try {
        const r = pfxCheck(job);
        if (r && r.ok === false) return { ready: false, reason: r.message || 'Preflight check failed', action: r.message || 'Fix preflight issues' };
      } catch {}
    }

    return { ready: true };
  }

  // ── Debug helpers ─────────────────────────────────────────────────────────
  function _dbgRq(msg, ...a) { if (window.PFX_DEBUG_RENDER_QUEUE)   console.debug('[RQ]',         msg, ...a); }
  function _dbgRe(msg, ...a) { if (window.PFX_DEBUG_RESOLVE_ENGINE) console.debug('[RQ:resolve]', msg, ...a); }

  // ── Resolve Engine availability check ────────────────────────────────────
  // Returns { configured, helperConnected, resolveInstalled, installed, launchPolicy, mode,
  //           path, version, running, canRunNow, canAutoLaunch, canManualLaunch,
  //           canRetry, reason, resolveMode, enabled, settings }
  // resolveMode: 'running' | 'background_auto' | 'start_manual' | 'never' | 'handoff' | 'blocked'
  function _resolveAvailability(job) {
    // Live settings take priority over the snapped copy on the job.
    const settings = window.__pfxProjectSetup?.getSettings?.()?.resolveEngine
      || job.resolveEngine
      || {};
    const enabled      = !!(settings.enabled);
    const resolvePath  = settings.resolvePath  || settings.resolveExecutablePath || '';
    const resolveInstalled = !!(resolvePath);
    const resolveStatus    = window.PFX_RESOLVE_STATUS;
    const helperConnected  = resolveStatus?.state === 'connected';
    const path    = resolvePath || resolveStatus?.resolvePath || '';
    const version = resolveStatus?.version || settings.resolveVersion || settings.version || '';
    const running = helperConnected;
    const configured = enabled && resolveInstalled;

    // Normalize mode from new field; fall back to old launchPolicy for backward compat.
    // Old project_setup.js used mode='background'/'visible'/'handoff'; new uses 'background_auto'/'assisted'/'manual_handoff'/'disabled'.
    // Old render_queue used launchPolicy='on_demand'/'manual'/'never'/'handoff'/'ask'.
    const rawMode       = settings.mode || settings.engineMode || '';
    const rawLaunchPol  = settings.launchPolicy || '';
    let mode;
    if (rawMode === 'background_auto' || rawMode === 'background') {
      mode = 'background_auto';
    } else if (rawMode === 'assisted' || rawMode === 'visible') {
      mode = 'assisted';
    } else if (rawMode === 'manual_handoff' || rawMode === 'handoff' || rawMode === 'manual') {
      mode = 'manual_handoff';
    } else if (rawMode === 'disabled') {
      mode = 'disabled';
    } else if (rawLaunchPol === 'on_demand' || rawLaunchPol === 'onDemand') {
      mode = 'background_auto';
    } else if (rawLaunchPol === 'handoff') {
      mode = 'manual_handoff';
    } else if (rawLaunchPol === 'never') {
      mode = 'disabled';
    } else {
      // 'manual', 'ask', or unrecognised → assisted (user launches Resolve manually)
      mode = 'assisted';
    }
    // Keep launchPolicy for legacy callers and diag text.
    const launchPolicy = rawLaunchPol || (mode === 'background_auto' ? 'on_demand' : mode === 'manual_handoff' ? 'handoff' : mode === 'disabled' ? 'never' : 'manual');

    let canRunNow = false, canAutoLaunch = false, canManualLaunch = false, canRetry = true;
    let reason = '';
    let resolveMode = 'blocked';

    if (!enabled) {
      reason = 'Resolve Engine is disabled — enable it in Project Settings';
      canRetry = false;
    } else if (!resolveInstalled) {
      reason = 'Resolve Engine path not configured — set it in Project Settings';
      canRetry = false;
    } else if (mode === 'manual_handoff') {
      reason = 'Handoff mode active — export this job as a Resolve package for manual render';
      resolveMode = 'handoff';
    } else if (mode === 'disabled') {
      reason = 'Resolve Engine is disabled — change mode in Project Settings to enable automation';
      resolveMode = 'never';
    } else if (helperConnected) {
      canRunNow = true;
      resolveMode = 'running';
    } else if (mode === 'background_auto') {
      // Queue will auto-start Resolve in the background when the job runs.
      canRunNow = true;
      canAutoLaunch = true;
      resolveMode = 'background_auto';
    } else {
      // 'assisted' — user must start Resolve manually
      reason = 'Resolve Engine is not running — click Start Resolve & Retry to launch it';
      resolveMode = 'start_manual';
      canManualLaunch = true;
    }

    _dbgRe('_resolveAvailability', { enabled, mode, launchPolicy, resolveInstalled, helperConnected, canRunNow, canAutoLaunch, canManualLaunch, resolveMode, reason });
    return {
      configured, helperConnected, resolveInstalled, installed: resolveInstalled,
      launchPolicy, mode, path, version, running,
      canRunNow, canAutoLaunch, canManualLaunch, canRetry,
      reason, resolveMode, enabled, settings,
    };
  }

  // Translate a raw error message into a specific, actionable recovery hint.
  function _parseError(msg, job) {
    const m   = String(msg || '').toLowerCase();
    const mod = job.params.module || 'pulls';
    const tab = MOD_META[mod]?.tab || mod;

    if (m.includes('memory access out of bounds') || m.includes('runtimeerror'))
      return 'WASM crash — close and reopen the tab, then retry (low GPU or system memory)';
    if (m.includes('not ready') || m.includes('not loaded') || m.includes('tab first') || m.includes('open the'))
      return `Open the ${tab} tab, then retry`;
    if (m.includes('no files') || m.includes('exported,') || m.includes('shots failed'))
      return 'Open the job log for per-shot failures, then retry';
    if (m.includes('video') && (m.includes('file') || m.includes('load')))
      return 'Load a proxy video file in the tab, then retry';
    if (m.includes('marker') || m.includes('shot'))
      return 'Ensure shots/markers are set in the tab, then retry';
    if (m.includes('ffmpeg') || m.includes('encode') || m.includes('codec') || m.includes('mux'))
      return 'Encode failed — check proxy format (H.264 MP4 recommended), then retry';
    if (m.includes('permission') || m.includes('download'))
      return 'Check Downloads folder permissions, then retry';
    return null;
  }

  // Re-evaluate blocked / needs_manual jobs periodically; auto-unblock when conditions change.
  function _startRecheckTimer() {
    if (_recheckTimer) return;
    _recheckTimer = setInterval(() => {
      const stalled = _jobs.filter(j => j.status === 'blocked' || j.status === 'needs_manual' || j.status === 'starting_engine');
      if (!stalled.length) { clearInterval(_recheckTimer); _recheckTimer = null; return; }
      let changed = false;
      stalled.forEach(j => {
        // Don't disturb jobs that are actively launching Resolve
        if (j.status === 'starting_engine') return;
        const r = _checkReadiness(j);
        if (r.ready) {
          j.status    = 'pending';
          j.readiness = null;
          changed = true;
        } else {
          const newStatus = r.resolveMode === 'handoff' ? 'needs_manual' : 'blocked';
          if (j.status !== newStatus || j.readiness?.reason !== r.reason) {
            j.status = newStatus; j.readiness = r; changed = true;
          }
          // Auto-kick background_auto jobs that just moved to blocked
          if (newStatus === 'blocked' && r.resolveMode === 'background_auto' && !r.autoStarting) {
            j.status = 'starting_engine';
            if (j.readiness) j.readiness = { ...j.readiness, autoStarting: true };
            changed = true;
            _startResolveAndRetry(j.id);
          }
        }
      });
      if (changed) {
        _save(); _render();
        if (!_paused && !_busy) _processNext();
      }
    }, RECHECK_MS);
  }

  // ── Job CRUD ───────────────────────────────────────────────────────────────

  async function _add(fmt, label, params) {
    // Support PFX_RQ_addJob({ type, fmt, label, params, priority }) object form
    if (fmt && typeof fmt === 'object' && !label && !params) {
      const o = fmt;
      return _add(o.fmt || 'render', o.label || o.fmt || 'Job', { ...(o.params || {}), module: o.params?.module || 'pulls', fmt: o.fmt, type: o.type, priority: o.priority });
    }
    const pFmt  = params.fmt    || fmt;
    const pMod  = params.module || 'pulls';
    const pStem = params.stem   || '';
    const pType = JOB_TYPES.includes(params.type) ? params.type : 'render';

    // Deduplication — flash the existing pending card
    const dupe = _jobs.find(j =>
      (j.status === 'pending' || j.status === 'blocked') &&
      j.params.fmt === pFmt && j.params.module === pMod && j.params.stem === pStem
    );
    if (dupe) {
      _showToast(`Already queued: ${label}`, 'info');
      const el = document.querySelector(`[data-rq-card="${CSS.escape(dupe.id)}"]`);
      if (el) { el.classList.add('rq-job-flash'); setTimeout(() => el.classList.remove('rq-job-flash'), 700); }
      return null;
    }

    const job = {
      id:             'rq_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      fmt, label, type: pType,
      params:         { fmt: pFmt, stem: pStem, module: pMod },
      lastDownloadId: null,
      status:         'pending',
      priority:       0,
      phase:          null,
      statusText:     null,
      currentFrame:   0,
      totalFrames:    0,
      currentFps:     0,
      encoderPath:    null,
      encoderDetail:  null,
      readiness:      null,
      progress:       0,
      totalSteps:     1,
      completedSteps: 0,
      retryCount:     0,
      outputFiles:    [],
      log:            [],
      createdAt:      Date.now(),
      startedAt:      null,
      completedAt:    null,
      error:          null,
      recovery:       null,
      recoveryAction: null,
      saveDir:        null,
      _resumed:       false,
      _logOpen:       false,
      // Resolve Engine fields — populated for vfxpackage jobs
      requiresResolve: pFmt === 'vfxpackage' ? (params.requiresResolve !== false) : !!(params.requiresResolve),
      requireReasons:  Array.isArray(params.requireReasons) ? [...params.requireReasons] : [],
      resolveEngine:   null,   // snapped from project settings below
    };

    // Snapshot current resolveEngine settings for VFX Package jobs so the
    // readiness check can evaluate them even after settings change.
    if (pFmt === 'vfxpackage') {
      const src = params.resolveEngine
        || window.__pfxProjectSetup?.getSettings?.()?.resolveEngine
        || null;
      if (src) { try { job.resolveEngine = JSON.parse(JSON.stringify(src)); } catch {} }
    }

    _jobs.push(job);
    _save(); _render();
    _showToast(`Queued: ${label}`, 'info');
    // Prompt for save dir only for heavy multi-file exports (QT, Package, XLSX).
    // Quick text exports (CSV, ALE, EDL, SRT, XML, OTIO) download directly — no folder picker.
    if (HEAVY_FMTS.has(job.params.fmt)) await _promptSaveDir(job);
    if (!_paused && !_busy) _processNext();
    return job.id;
  }

  function _remove(id) {
    const j = _jobs.find(j => j.id === id);
    if (j && (j.status === 'done' || j.status === 'error' || j.status === 'cancelled'))
      _archiveJob(j);
    _jobs = _jobs.filter(j => j.id !== id);
    _dirHandles.delete(id);
    _save(); _render(); _renderHistory();
  }

  function _retry(id) {
    const j = _jobs.find(j => j.id === id);
    if (!j || j.retryCount >= MAX_RETRIES) return;
    j.retryCount++; j.status = 'pending'; j.progress = 0;
    j.completedSteps = 0; j.lastDownloadId = null; j.phase = null;
    j.encoderPath = null; j.encoderDetail = null;
    j.outputFiles = [];
    j.startedAt = null; j.completedAt = null; j.error = null; j.recovery = null; j.recoveryAction = null; j.log = [];
    _save(); _render();
    if (!_paused && !_busy) _processNext();
  }

  function _cancel(id) {
    const j = _jobs.find(j => j.id === id);
    if (!j) return;
    if (j.status === 'pending' || j.status === 'blocked' || j.status === 'needs_manual' || j.status === 'starting_engine') { _remove(id); return; }
    if (j.status === 'running') {
      j.status = 'cancelling'; window.__rqCancelFlag = true;
      _save(); _render();
    }
  }

  function _setPriority(id, p) {
    const j = _jobs.find(j => j.id === id);
    if (!j || (j.status !== 'pending' && j.status !== 'blocked' && j.status !== 'starting_engine')) return;
    j.priority = p; _save(); _render();
  }

  function _toggleLog(id) {
    const j = _jobs.find(j => j.id === id);
    if (j) { j._logOpen = !j._logOpen; _render(); }
  }

  function _clearDone() {
    const done = _jobs.filter(j =>
      j.status === 'done' || j.status === 'error' || j.status === 'cancelled'
    );
    done.forEach(j => _archiveJob(j));
    _jobs = _jobs.filter(j =>
      j.status !== 'done' && j.status !== 'error' && j.status !== 'cancelled'
    );
    _save(); _render(); _renderHistory();
  }

  function _pauseQueue()  {
    _paused = true;
    try { localStorage.setItem(PAUSED_KEY, '1'); } catch {}
    _render();
  }

  function _resumeQueue() {
    _paused = false;
    _dismissResumeBanner();   // clear reload banner if still showing
    try { localStorage.setItem(PAUSED_KEY, '0'); } catch {}
    _render();
    if (!_busy) _processNext();
  }

  function _moveUp(id) {
    const idx = _jobs.findIndex(j => j.id === id);
    if (idx <= 0) return;
    const firstMovable = _jobs.findIndex(j => j.status === 'pending' || j.status === 'blocked' || j.status === 'starting_engine');
    if (idx <= firstMovable) return;
    [_jobs[idx - 1], _jobs[idx]] = [_jobs[idx], _jobs[idx - 1]];
    _save(); _render();
  }

  function _dragMove(fromId, toId) {
    const fi = _jobs.findIndex(j => j.id === fromId);
    const ti = _jobs.findIndex(j => j.id === toId);
    if (fi < 0 || ti < 0 || fi === ti) return;
    const fs = _jobs[fi].status, ts = _jobs[ti].status;
    if ((fs !== 'pending' && fs !== 'blocked' && fs !== 'starting_engine') || (ts !== 'pending' && ts !== 'blocked' && ts !== 'starting_engine')) return;
    const [item] = _jobs.splice(fi, 1);
    _jobs.splice(ti, 0, item);
    _save(); _render();
  }

  function _openDir(id) {
    const j = _jobs.find(j => j.id === id);
    if (!j) return;
    // chrome.downloads path — reveal the specific output file in Finder
    if (j.lastDownloadId != null) { try { chrome.downloads.show(j.lastDownloadId); return; } catch {} }
    // FS API path — the extension cannot get the OS path from a FileSystemDirectoryHandle.
    // Search chrome.downloads history for any file whose filename starts with the folder name.
    if (j.saveDir && typeof chrome !== 'undefined' && chrome.downloads?.search) {
      chrome.downloads.search({ filenameRegex: String(j.saveDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), limit: 1 }, (results) => {
        if (results?.length && results[0].id != null) {
          try { chrome.downloads.show(results[0].id); return; } catch {}
        }
        // No matching download found — tell the user the folder name so they can find it manually
        _showToast(`Files saved to folder: "${j.saveDir}" — use Finder ⌘⇧G to navigate there`);
      });
      return;
    }
    _showToast(j.saveDir ? `Files saved to folder: "${j.saveDir}"` : 'Output folder not found');
  }

  // ── Execution ──────────────────────────────────────────────────────────────

  async function _processNext() {
    if (_paused || _busy) return;
    _busy = true;  // lock immediately — prevents re-entrant call while we select a job

    // Walk candidates in priority order, skipping those that fail readiness.
    // This way a blocked job at the front doesn't stall the whole queue.
    const candidates = _jobs
      .filter(j => j.status === 'pending' || j.status === 'blocked' || j.status === 'needs_manual' || j.status === 'starting_engine')
      .sort((a, b) => b.priority - a.priority);

    let job = null;
    let anyBlocked = false;

    for (const j of candidates) {
      const r = _checkReadiness(j);
      if (r.ready) {
        if (j.status === 'blocked' || j.status === 'needs_manual' || j.status === 'starting_engine') { j.status = 'pending'; j.readiness = null; }
        job = j;
        break;
      } else {
        // Jobs already in starting_engine stay there — don't clobber to blocked mid-launch.
        if (j.status === 'starting_engine') { anyBlocked = true; continue; }
        // Handoff-mode jobs get needs_manual status; all other blocks stay blocked.
        const newStatus = r.resolveMode === 'handoff' ? 'needs_manual' : 'blocked';
        if (j.status !== newStatus || j.readiness?.reason !== r.reason) {
          j.status = newStatus; j.readiness = r;
        }
        anyBlocked = true;
      }
    }

    if (anyBlocked) {
      // For background_auto jobs, kick off engine start immediately if not already starting.
      for (const j of _jobs.filter(j => j.status === 'blocked' && j.readiness?.resolveMode === 'background_auto')) {
        if (!j.readiness?.autoStarting) {
          j.status = 'starting_engine';
          if (j.readiness) j.readiness = { ...j.readiness, autoStarting: true };
          _save(); _render();
          _startResolveAndRetry(j.id);
        }
      }
      _save(); _render(); _startRecheckTimer();
    }
    if (!job) { _busy = false; return; }
    job.status    = 'running';
    job.startedAt = Date.now();
    job.phase     = null;
    job.encoderPath = null;
    job.encoderDetail = null;

    window.__rqCurrentJobId   = job.id;
    window.__rqCurrentStem    = job.params.stem;
    window.__rqCancelFlag     = false;
    window.__rqReportDownload = (id) => { job.lastDownloadId = id; };
    window.__rqOnShotProgress = (done, total) => {
      job.progress = total > 0 ? Math.round(done / total * 100) : 0;
      job.completedSteps = done; job.totalSteps = total;
      _save(); _render();
    };
    window.__rqReportPhase = (phase) => {
      job.phase = phase;
      try {
        const card = document.querySelector(`[data-rq-card="${CSS.escape(job.id)}"]`);
        if (!card) return;
        const b = card.querySelector('.rq-badge');
        if (b) b.textContent = PHASE_LABEL[phase] || 'Running';
        const loz = card.querySelector('.rq-phase-lozenge');
        if (loz) {
          loz.className = `rq-phase-lozenge rq-phase-lozenge-${phase || 'working'}`;
          loz.innerHTML = `<span class="rq-phase-dot"></span>${_esc(PHASE_LABEL[phase] || 'Working')}`;
        }
        const phIdx = PHASE_ORDER.indexOf(phase || '');
        card.querySelectorAll('.rq-phase-step').forEach((el, i) => {
          el.className = i < phIdx ? 'rq-phase-step is-done'
                       : i === phIdx ? 'rq-phase-step is-active' : 'rq-phase-step';
        });
        card.querySelectorAll('.rq-phase-line').forEach((el, i) => {
          el.className = i < phIdx ? 'rq-phase-line is-done' : 'rq-phase-line';
        });
      } catch {}
    };
    window.__rqReportStatus = (text) => {
      job.statusText = text ? String(text).slice(0, 120) : null;
    };
    window.__rqReportEncoder = (mode, detail = '') => {
      const nextPath = mode === 'hw' ? 'hw' : mode === 'sw' ? 'sw' : null;
      const nextDetail = detail ? String(detail).slice(0, 40) : null;
      if (job.encoderPath === nextPath && job.encoderDetail === nextDetail) return;
      job.encoderPath = nextPath;
      job.encoderDetail = nextDetail;
      _save(); _render();
    };
    window.__rqReportFrames = (current, total, fps = 0) => {
      job.currentFrame = current | 0;
      job.totalFrames  = total   | 0;
      job.currentFps   = fps || 0;
      try {
        const card = document.querySelector(`[data-rq-card="${CSS.escape(job.id)}"]`);
        if (!card) return;
        const cur = card.querySelector('.rq-frame-cur');
        if (cur) cur.textContent = job.currentFrame.toLocaleString('en-US');
        const fpsEl = card.querySelector('.rq-fps-val');
        if (fpsEl) fpsEl.textContent = job.currentFps > 0 ? job.currentFps.toFixed(1) : '—';
        if (job.totalFrames > 0) {
          const fill = card.querySelector('.rq-frame-bar-fill');
          if (fill) fill.style.width = `${Math.min(100, job.currentFrame / job.totalFrames * 100).toFixed(2)}%`;
        }
      } catch {}
    };
    window.__rqReportProgress = (pct) => {
      job.progress = Math.max(0, Math.min(100, Math.round(pct)));
      try {
        const card = document.querySelector(`[data-rq-card="${CSS.escape(job.id)}"]`);
        if (card) {
          const fill  = card.querySelector('.rq-progress-fill');
          const track = card.querySelector('.rq-progress-track');
          if (fill)  fill.style.width = `${job.progress}%`;
          if (track) track.title = `${job.progress}%`;
        }
      } catch {}
    };
    window.__rqLog = (msg) => {
      job.log.push({ ts: Date.now(), msg: String(msg).slice(0, 300) });
      if (job.log.length > MAX_LOG) job.log.shift();
    };

    _save(); _render(); _startTick(); _startSysPoll();

    try {
      const mod = job.params.module || 'pulls';
      const fn  = mod === 'pulls'
        ? window.__pmExportQueued
        : window.__rqExportHandlers?.[mod];
      // Re-check after acquiring (handler could have unloaded between schedule and start)
      if (typeof fn !== 'function') {
        const r = _checkReadiness(job);
        throw new Error(r.reason || `Handler for '${mod}' not available`);
      }
      await fn(job.params.fmt, job.params.stem, job.params);
      if ((job.params.module || 'pulls') === 'pulls'
          && EXPECTED_OUTPUT_FMTS.has(job.params.fmt)
          && !job.outputFiles.length) {
        throw new Error('No files were saved');
      }

      if (window.__rqCancelFlag || job.status === 'cancelling') {
        job.status = 'cancelled';
        _notify('Export Cancelled', job.label);
      } else {
        job.status = 'done'; job.progress = 100; job.completedAt = Date.now();
        const elapsed = Math.round((job.completedAt - job.startedAt) / 1000);
        _notify('Export Complete', `${job.label} — ${_fmtSec(elapsed)}`);
        _checkQueueComplete();
      }
    } catch (e) {
      const raw = String(e?.message || e || 'Unknown error');
      if (raw === 'Cancelled' || job.status === 'cancelling') {
        job.status = 'cancelled';
      } else {
        job.status   = 'error';
        job.error    = raw;
        job.recovery = _parseError(raw, job);
        if (job.recovery?.toLowerCase().includes('job log') && job.log.length) {
          job.recoveryAction = 'log';
        }
        _notify('Export Failed', `${job.label}: ${raw.slice(0, 80)}`);
      }
    } finally {
      _busy = false;
      window.__rqCurrentJobId = window.__rqCurrentStem =
      window.__rqCancelFlag   = null;
      window.__rqReportDownload = window.__rqOnShotProgress =
      window.__rqReportPhase    = window.__rqReportStatus =
      window.__rqReportEncoder  =
      window.__rqReportProgress = window.__rqReportFrames =
      window.__rqLog = null;
      job.statusText   = null;
      job.currentFrame = 0;
      job.totalFrames  = 0;
      job.currentFps   = 0;
      job._resumed     = false;   // clear after job ends (not at start)
      window.__rqCancelFlag = false;
      _save(); _render(); _syncBadge();
      if (!_paused) _processNext();
    }
  }

  // ── Resolve Engine recovery actions ──────────────────────────────────────

  // Re-evaluate a blocked/needs_manual vfxpackage job immediately and
  // transition it to pending if Resolve is now available.
  function _retryWithResolve(id) {
    const j = _jobs.find(j => j.id === id);
    if (!j) return;
    const r = _checkReadiness(j);
    if (r.ready) {
      j.status = 'pending'; j.readiness = null;
      _save(); _render();
      if (!_paused && !_busy) _processNext();
    } else {
      // Refresh reason text (e.g. Resolve might now be installed but not running)
      const newStatus = r.resolveMode === 'handoff' ? 'needs_manual' : 'blocked';
      j.status = newStatus; j.readiness = r;
      _save(); _render();
      _showToast(r.reason || 'Resolve Engine still not available', 'warn');
    }
  }

  // Start DaVinci Resolve via native helper, wait for readiness, then retry the job.
  // For background_auto mode: uses nativeResolveStartBackground (open -g, minimized).
  // For assisted mode: uses nativeResolveStartEngine (foreground, visible).
  async function _startResolveAndRetry(id) {
    const j = _jobs.find(j => j.id === id);
    if (!j) return;

    const ra = _resolveAvailability(j);
    if (!ra.installed) {
      _showToast('Resolve path not configured — set it in Project Setup');
      if (j.status === 'starting_engine') { j.status = 'blocked'; _save(); _render(); }
      return;
    }

    const isBackground = ra.mode === 'background_auto';

    // Show transient "Starting…" state in the card
    j.statusText = isBackground ? 'Starting Resolve Engine in background…' : 'Starting Resolve Engine…';
    if (j.status !== 'starting_engine') j.status = 'starting_engine';
    if (j.readiness) j.readiness = { ...j.readiness, starting: true, autoStarting: isBackground };
    _save(); _render();

    let helper = null;
    try { helper = await import('./scripts/modules/native_helper_client.js'); } catch {}

    // For background_auto, prefer nativeResolveStartBackground; fall back to nativeResolveStartEngine.
    const startFn = isBackground
      ? (helper?.nativeResolveStartBackground || helper?.nativeResolveStartEngine)
      : helper?.nativeResolveStartEngine;

    if (!startFn) {
      j.statusText = null;
      j.status = 'blocked';
      if (j.readiness) j.readiness = { ...j.readiness, starting: false, autoStarting: false,
        reason: 'Native helper not available — start DaVinci Resolve manually, then click Fix & Retry' };
      _save(); _render();
      _showToast('Native helper not available — start Resolve manually, then retry');
      return;
    }

    const timeoutSeconds = ra.settings?.advanced?.jobTimeoutSeconds
      || ra.settings?.timeoutSeconds || 60;
    _dbgRe('_startResolveAndRetry', { path: ra.path, mode: ra.mode, isBackground, timeoutSeconds });

    try {
      const res = await startFn({
        resolvePath:          ra.path,
        launchPolicy:         isBackground ? 'background' : 'manual',
        runMode:              isBackground ? 'background' : 'manual',
        minimize:             isBackground && !!(ra.settings?.minimizeOnLaunch !== false),
        waitForReady:         true,
        apiReadyTimeoutSeconds: timeoutSeconds,
        timeoutSeconds,
      });
      const data = res?.result || res?.data || {};
      _dbgRe('_startResolveAndRetry result', data);

      if (data.connected || data.running) {
        try {
          window.PFX_RESOLVE_STATUS = {
            ...(window.PFX_RESOLVE_STATUS || {}),
            state: 'connected',
            label: 'Resolve: Connected',
            sub:   `v${data.version || ra.version || '?'} · ready`,
            version: data.version || ra.version || '',
            resolvePath: ra.path,
            at: Date.now(),
          };
          document.dispatchEvent(new CustomEvent('pfx:resolve-status', { detail: window.PFX_RESOLVE_STATUS }));
        } catch {}
        j.statusText = null;
        j.status     = 'pending';
        j.readiness  = null;
        _save(); _render();
        _showToast('Resolve Engine ready — retrying job');
        if (!_paused && !_busy) _processNext();
      } else {
        const msg = data.userMessage || data.message
          || (isBackground ? 'Resolve launched in background but scripting API is not yet ready — will retry when Resolve is fully open' : 'Resolve launched but scripting API is not yet ready');
        const fallbackReadiness = {
          ready: false, reason: msg + (isBackground ? '' : ' — wait for Resolve to fully open, then click Fix & Retry'),
          resolveBlocked: true,
          resolveCode: isBackground ? 'BACKGROUND_AUTO' : 'NOT_RUNNING',
          resolveMode: isBackground ? 'background_auto' : 'start_manual',
          resolvePath: ra.path, resolveVersion: ra.version,
          launchPolicy: ra.launchPolicy, mode: ra.mode,
          canAutoLaunch: isBackground, canManualLaunch: !isBackground,
        };
        j.statusText = null;
        j.status = 'blocked';
        j.readiness  = j.readiness
          ? { ...j.readiness, starting: false, autoStarting: false, reason: fallbackReadiness.reason }
          : fallbackReadiness;
        _save(); _render();
        _showToast(isBackground ? 'Resolve launching in background — will retry automatically' : msg);
      }
    } catch (e) {
      const msg = String(e?.userMessage || e?.message || e);
      const errReadiness = {
        ready: false, reason: `Failed to start Resolve: ${msg}`,
        resolveBlocked: true,
        resolveCode: isBackground ? 'BACKGROUND_AUTO' : 'NOT_RUNNING',
        resolveMode: isBackground ? 'background_auto' : 'start_manual',
        resolvePath: ra.path, resolveVersion: ra.version,
        launchPolicy: ra.launchPolicy, mode: ra.mode,
        canAutoLaunch: isBackground, canManualLaunch: !isBackground,
      };
      j.statusText = null;
      j.status = 'blocked';
      j.readiness  = j.readiness
        ? { ...j.readiness, starting: false, autoStarting: false, reason: errReadiness.reason }
        : errReadiness;
      _save(); _render();
      _showToast(`Resolve start failed: ${msg}`);
      _dbgRe('_startResolveAndRetry error', e);
    }
  }

  // Switch mode to background_auto in live settings, save, then start Resolve and retry.
  async function _changeLaunchPolicyAndRetry(id) {
    const j = _jobs.find(j => j.id === id);
    if (!j) return;
    const setup = window.__pfxProjectSetup;
    if (setup?.getSettings) {
      try {
        const s = setup.getSettings();
        if (s?.resolveEngine) {
          s.resolveEngine.mode = 'background_auto';
          s.resolveEngine.launchPolicy = 'on_demand';
          await setup.saveNow?.();
          document.dispatchEvent(new CustomEvent('pfx:resolve-settings-updated',
            { detail: { settings: s.resolveEngine } }));
          _showToast('Mode set to Background Auto');
        }
      } catch (e) { _dbgRq('_changeLaunchPolicyAndRetry settings error', e); }
    } else {
      // No API — open Project Setup so user can change it manually
      setup?.open?.('resolve');
      _showToast('Open Project Setup → Resolve Engine to change mode');
      return;
    }
    await _startResolveAndRetry(id);
  }

  // Allow a vfxpackage job to run without Resolve (metadata-only export).
  function _noResolveExport(id) {
    const j = _jobs.find(j => j.id === id);
    if (!j || j.params.fmt !== 'vfxpackage') return;
    j.requiresResolve = false;
    j.readiness = null;
    j.status = 'pending';
    _save(); _render();
    _showToast('Re-queued without Resolve — metadata-only export', 'info');
    if (!_paused && !_busy) _processNext();
  }

  // Generate and download a Resolve handoff package (JSON) for a vfxpackage job.
  async function _generateResolveHandoff(id) {
    const j = _jobs.find(j => j.id === id);
    if (!j) return;

    const reasons = j.requireReasons || [];
    const flags = [];
    if (reasons.includes('hasSpeedChange') || reasons.includes('speed')) flags.push('Speed Change');
    if (reasons.includes('hasGeometry')    || reasons.includes('resize')) flags.push('Resize/Reframe');
    if (reasons.includes('colorPlan')      || reasons.includes('color'))  flags.push('Color Pipeline');

    const handoff = {
      pfxHandoff: true,
      version:    '1.0',
      jobId:      j.id,
      jobLabel:   j.label,
      stem:       j.params.stem || '',
      fmt:        j.params.fmt,
      module:     j.params.module,
      createdAt:  new Date().toISOString(),
      requiresResolve: true,
      requireReasons:  reasons,
      resolveFlags:    flags,
      resolveEngine:   j.resolveEngine || null,
      instructions: [
        '1. Open DaVinci Resolve.',
        '2. Import the source media referenced in this package.',
        '3. Apply any speed changes, resize, or reframe operations listed in requireReasons.',
        '4. Export the VFX plates to the designated output folder.',
        '5. Return to PostFlowX and dismiss or re-queue this job.',
      ].join('\n'),
    };

    try {
      const blob = new Blob([JSON.stringify(handoff, null, 2)], { type: 'application/json' });
      const stem = String(j.params.stem || j.label || 'handoff').replace(/[^a-zA-Z0-9_-]/g, '_');
      const filename = `${stem}_resolve_handoff.json`;
      if (typeof window.__pfxSaveBlob === 'function') {
        await window.__pfxSaveBlob(filename, blob);
      } else {
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
      }
      _showToast(`Handoff package saved: ${filename}`, 'info');
      _dbgRq('Resolve handoff exported', filename, handoff);
    } catch (e) {
      _showToast(`Handoff export failed: ${e?.message || e}`, 'error');
    }
  }

  function _startResumeBanner(count) {
    const banner   = document.getElementById('rq-resume-banner');
    const countEl  = document.getElementById('rq-resume-banner-count');
    const cdEl     = document.getElementById('rq-resume-banner-countdown');
    const pauseBtn = document.getElementById('rq-resume-pause-btn');

    if (!banner) {
      // Banner div not in DOM (older HTML) — just delay then process
      if (!_paused) setTimeout(() => { if (!_busy) _processNext(); }, 3500);
      return;
    }

    if (countEl) countEl.textContent = count;
    banner.removeAttribute('hidden');

    if (_paused) {
      // Queue already paused — no countdown, just inform
      if (cdEl) cdEl.textContent = 'queue paused';
      banner.classList.add('rq-resume-banner-paused');
      if (pauseBtn) pauseBtn.hidden = true;
      return;
    }

    _resumeCountdown = 5;
    const tick = () => {
      if (cdEl) cdEl.textContent = _resumeCountdown > 0 ? `in ${_resumeCountdown}s` : '…';
      if (_resumeCountdown <= 0) {
        _dismissResumeBanner();
        if (!_paused && !_busy) _processNext();
      }
    };
    tick();
    clearInterval(_resumeCountdownTimer);
    _resumeCountdownTimer = setInterval(() => { _resumeCountdown--; tick(); }, 1000);
  }

  function _dismissResumeBanner() {
    clearInterval(_resumeCountdownTimer);
    _resumeCountdownTimer = null;
    _resumeCountdown = 0;
    const banner = document.getElementById('rq-resume-banner');
    if (banner) banner.hidden = true;
  }

  function _checkQueueComplete() {
    if (_jobs.some(j => j.status === 'pending' || j.status === 'blocked' || j.status === 'running')) return;
    const nDone = _jobs.filter(j => j.status === 'done').length;
    if (nDone > 1) _notify('Queue Complete', `All ${nDone} exports finished`);
  }

  // ── Notifications & badge ──────────────────────────────────────────────────

  function _notify(title, message) {
    try {
      chrome.notifications.create('pfx_rq_' + Date.now(), {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('assets/icons/app_icon_128.png'),
        title, message, priority: 1,
      });
    } catch {}
  }

  function _syncBadge() {
    const nActive = _jobs.filter(j =>
      j.status === 'pending' || j.status === 'blocked' || j.status === 'needs_manual' ||
      j.status === 'running' || j.status === 'cancelling' || j.status === 'starting_engine'
    ).length;
    const nError = _jobs.filter(j => j.status === 'error').length;
    try {
      if (nActive > 0) {
        chrome.action.setBadgeText({ text: String(nActive) });
        chrome.action.setBadgeBackgroundColor({ color: '#e8a04a' });
      } else if (nError > 0) {
        chrome.action.setBadgeText({ text: '!' });
        chrome.action.setBadgeBackgroundColor({ color: '#a03838' });
      } else {
        chrome.action.setBadgeText({ text: '' });
      }
    } catch {}
    _updateQueueBadge();
  }

  // ── Global queue-aware save helper ────────────────────────────────────────

  window.__pfxSaveBlob = async function (filename, blob) {
    const stem  = window.__rqCurrentStem;
    const jobId = window.__rqCurrentJobId;
    const recordOutput = () => {
      if (!jobId) return;
      const j = _jobs.find(j => j.id === jobId);
      if (!j) return;
      j.outputFiles.push({ name: filename, size: blob.size });
    };

    // ── Path A: user-chosen directory via File System Access API ─────────────
    const dirHandle = jobId ? _dirHandles.get(jobId) : null;
    if (dirHandle) {
      try {
        const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
        const writable   = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        recordOutput();
        window.__rqLog?.(`✓ ${filename}  →  ${dirHandle.name}/`);
        return;
      } catch (e) {
        window.__rqLog?.(`⚠ FS write failed (${e?.message || e}) — falling back to Downloads`);
        // fall through
      }
    }

    // ── Path B: chrome.downloads (subfolder inside Downloads) ────────────────
    if (stem && jobId && typeof chrome !== 'undefined' && chrome.downloads?.download) {
      const url        = URL.createObjectURL(blob);
      const safeFolder = stem.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 128);
      const downloadId = await new Promise((resolve, reject) => {
        chrome.downloads.download(
          { url, filename: `${safeFolder}/${filename}`, saveAs: false, conflictAction: 'uniquify' },
          (downloadId) => {
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message || 'Download failed'));
              return;
            }
            if (downloadId == null) {
              reject(new Error('Download failed'));
              return;
            }
            resolve(downloadId);
          }
        );
      });
      try { window.__rqReportDownload?.(downloadId); } catch {}
      recordOutput();
      return;
    }

    // ── Path C: anchor-click fallback ─────────────────────────────────────────
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    if (jobId) window.__rqLog?.(`⚠ ${filename} saved via browser fallback — verify it appears in Downloads`);
    recordOutput();
  };

  // ── Timers ─────────────────────────────────────────────────────────────────

  function _startTick() {
    if (_tickTimer) return;
    _tickTimer = setInterval(() => {
      const cards = document.querySelectorAll(
        '.rq-job-running[data-rq-card],.rq-job-cancelling[data-rq-card]'
      );
      if (!cards.length) { clearInterval(_tickTimer); _tickTimer = null; _stopSysPoll(); return; }
      cards.forEach(el => {
        const j = _jobs.find(j => j.id === el.dataset.rqCard);
        if (!j?.startedAt) return;
        const et = el.querySelector('.rq-elapsed');
        if (et) et.textContent = _fmtElapsed(j);
      });
    }, 1000);
  }

  // ── System stats polling (CPU / RAM) ────────────────────────────────────────

  function _initSysPanel() {
    _initGpuName();
    // GPU name — synchronous, set immediately
    const gpuEl = document.getElementById('rq-sysp-gpu');
    if (gpuEl) gpuEl.textContent = _gpuChipLabel();
    // CPU + RAM — routed via background service worker (chrome.system not accessible from page)
    chrome.runtime.sendMessage({ type: 'GET_SYS_INFO' }, res => {
      if (chrome.runtime.lastError || !res) return;
      const cpuEl = document.getElementById('rq-sysp-cpu');
      if (cpuEl && res.cpu) cpuEl.textContent = res.cpu;
      const ramEl = document.getElementById('rq-sysp-ram');
      if (ramEl && res.ram) ramEl.textContent = res.ram;
      // Store core count for live "Xc active" display
      if (res.cores) _cpuCores = res.cores;
    });
  }
  function _startSysPoll() {
    if (_sysPollTimer) return;
    _sysPollTimer = setInterval(() => { if (!document.hidden) _doSysPoll(); }, 1500);
    if (!document.hidden) _doSysPoll();
    // Pause polling when tab is hidden, resume on visibility
    if (!window.__rqVisBound) {
      window.__rqVisBound = true;
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) _stopSysPoll(); else _startSysPoll();
      }, { passive: true });
    }
  }
  function _stopSysPoll() {
    if (_sysPollTimer) { clearInterval(_sysPollTimer); _sysPollTimer = null; }
  }
  function _doSysPoll() {
    chrome.runtime.sendMessage({ type: 'GET_SYS_USAGE' }, res => {
      if (chrome.runtime.lastError || !res) return;
      if (typeof res.cpu      === 'number') _sysStats.cpu      = res.cpu;
      if (typeof res.cpuActiveCores === 'number') _sysStats.cpuActiveCores = res.cpuActiveCores;
      if (typeof res.cpuEqCores     === 'number') _sysStats.cpuEqCores     = res.cpuEqCores;
      if (typeof res.ramTotal === 'number' && res.ramTotal > 0) {
        _sysStats.ramTotal = res.ramTotal;
        _sysStats.ramUsed  = res.ramUsed  || 0;
        _sysStats.ramPct   = res.ramPct   || 0;
      }
      _updateSysDom();
    });
    // GPU usage via background → companion (ioreg on macOS Apple Silicon)
    chrome.runtime.sendMessage({ type: 'GET_GPU_USAGE' }, res => {
      if (chrome.runtime.lastError || !res) return;
      if (typeof res.gpuPct === 'number') { _sysStats.gpu = res.gpuPct; _updateSysDom(); }
    });
  }
  function _updateSysDom() {
    const cpuLvl = _sysStats.cpu > 80 ? 'hot' : _sysStats.cpu > 60 ? 'warn' : 'ok';
    const ramLvl = _sysStats.ramPct > 85 ? 'hot' : _sysStats.ramPct > 70 ? 'warn' : 'ok';
    let ramStr = '— GB';
    if (_sysStats.ramTotal > 0) {
      const GiB     = 1073741824;
      const totalGb = (_sysStats.ramTotal / GiB).toFixed(0);
      const usedGb  = (_sysStats.ramUsed  / GiB).toFixed(1);
      // If used > 95% of total it's likely macOS reporting near-zero free — show total only
      ramStr = _sysStats.ramPct > 95
        ? `${totalGb} GB`
        : `${usedGb} / ${totalGb} GB`;
    }
    const cpuLabel = _cpuUsageLabel();
    document.querySelectorAll('.rq-sys-cpu-bar').forEach(el => {
      el.style.width = `${_sysStats.cpu}%`;
      el.className = `rq-sys-mini-fill rq-sys-cpu-bar rq-sys-${cpuLvl}`;
    });
    document.querySelectorAll('.rq-sys-cpu-pct').forEach(el => {
      el.textContent = cpuLabel;
      el.className = `rq-sys-val rq-sys-cpu-pct rq-sys-${cpuLvl}`;
    });
    document.querySelectorAll('.rq-sys-ram-bar').forEach(el => {
      el.style.width = `${_sysStats.ramPct}%`;
      el.className = `rq-sys-mini-fill rq-sys-ram-bar rq-sys-${ramLvl}`;
    });
    document.querySelectorAll('.rq-sys-ram-val').forEach(el => {
      el.textContent = ramStr;
      el.className = `rq-sys-val rq-sys-ram-val rq-sys-${ramLvl}`;
    });
    const gpuEl = document.getElementById('rq-sysp-gpu');
    if (gpuEl) gpuEl.textContent = _gpuChipLabel();
    if (typeof _sysStats.gpu === 'number') {
      const gpuLvl = _sysStats.gpu > 80 ? 'hot' : _sysStats.gpu > 60 ? 'warn' : 'ok';
      document.querySelectorAll('.rq-sys-gpu-bar').forEach(el => {
        el.style.width = `${_sysStats.gpu}%`;
        el.className = `rq-sys-mini-fill rq-sys-gpu-bar rq-sys-${gpuLvl}`;
      });
      document.querySelectorAll('.rq-sys-gpu-pct').forEach(el => {
        el.textContent = `${_sysStats.gpu}%`;
        el.className = `rq-sys-val rq-sys-gpu-pct rq-sys-${gpuLvl}`;
      });
    } else {
      document.querySelectorAll('.rq-sys-gpu-bar').forEach(el => {
        el.style.width = '0%';
        el.className = 'rq-sys-mini-fill rq-sys-gpu-bar';
      });
      document.querySelectorAll('.rq-sys-gpu-pct').forEach(el => {
        el.textContent = '—';
        el.className = 'rq-sys-val rq-sys-gpu-pct';
      });
    }
  }
  function _gpuChipLabel() {
    if (!_gpuName) return '—';
    return typeof _sysStats.gpu === 'number' ? `${_gpuName} · ${_sysStats.gpu}%` : _gpuName;
  }
  function _cpuUsageLabel() {
    if (typeof _sysStats.cpuActiveCores === 'number' && _sysStats.cpuActiveCores >= 0) {
      const total = _cpuCores > 0 ? `/${_cpuCores}c` : '';
      return `${_sysStats.cpu}%  ·  ${_sysStats.cpuActiveCores}${total} active`;
    }
    if (typeof _sysStats.cpuEqCores === 'number' && _cpuCores > 0) {
      return `${_sysStats.cpu}%  ·  ${_sysStats.cpuEqCores}/${_cpuCores}c`;
    }
    return `${_sysStats.cpu}%`;
  }
  // GPU core counts for known chips — used to annotate the GPU chip label
  const _GPU_CORES = {
    'Apple M1':        '7c',  'Apple M1 Pro': '16c', 'Apple M1 Max': '32c', 'Apple M1 Ultra': '64c',
    'Apple M2':       '10c',  'Apple M2 Pro': '19c', 'Apple M2 Max': '38c', 'Apple M2 Ultra': '76c',
    'Apple M3':       '10c',  'Apple M3 Pro': '18c', 'Apple M3 Max': '40c', 'Apple M3 Ultra': '80c',
    'Apple M4':       '10c',  'Apple M4 Pro': '20c', 'Apple M4 Max': '40c', 'Apple M4 Ultra': '80c',
  };

  function _initGpuName() {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return;
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (!ext) return;
      let name = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '';
      // Unwrap ANGLE(vendor, "ANGLE Metal Renderer: GPU_NAME, version") on macOS
      const angleInner = name.match(/^ANGLE\s*\(([^)]+)\)/i)?.[1] || '';
      if (angleInner) {
        const metalMatch = angleInner.match(/Metal Renderer:\s*([^,]+)/i);
        if (metalMatch) {
          name = metalMatch[1].trim();
        } else {
          const parts = angleInner.split(/,\s*/);
          name = parts[parts.length - 1].trim();
        }
      }
      name = name.replace(/\/PCIe\/.*$/i, '').replace(/\s+OpenGL\s+Engine$/i, '').replace(/\s+Direct3D\d*.*$/i, '').trim();
      if (name.length > 35) name = name.slice(0, 33) + '…';
      // Append known GPU core count
      const cores = _GPU_CORES[name];
      _gpuName = cores ? `${name} · ${cores}` : name;
    } catch {}
  }

  function _fmtElapsed(job) {
    const elapsed = Math.floor((Date.now() - job.startedAt) / 1000);
    const e = _fmtSec(elapsed);
    if (HEAVY_FMTS.has(job.fmt) && job.totalSteps > 1 && job.completedSteps > 0) {
      const sps  = elapsed / job.completedSteps;
      const left = Math.round(sps * (job.totalSteps - job.completedSteps));
      return `${e}  ·  ~${_fmtSec(left)} left  ·  ${sps.toFixed(1)}s/shot`;
    }
    if (job.progress > 5 && job.progress < 100) {
      const left = Math.round(elapsed * (100 - job.progress) / job.progress);
      return `${e} elapsed  ·  ~${_fmtSec(left)} left`;
    }
    return `${e} elapsed`;
  }

  function _fmtSec(s) {
    if (s < 60)   return `${s}s`;
    if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
    return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────

  function _esc(s) {
    return String(s || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _relTime(ts) {
    if (!ts) return '';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5)     return 'just now';
    if (s < 60)    return `${s}s ago`;
    if (s < 3600)  return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  function _absTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function _isProgressStatus(status) {
    return status === 'pending' || status === 'running' || status === 'cancelling' ||
      status === 'blocked' || status === 'needs_manual' || status === 'starting_engine' || status === 'error';
  }

  function _isCompletedStatus(status) {
    return status === 'done' || status === 'cancelled';
  }

  function _setView(mode) {
    _viewMode = mode === 'completed' ? 'completed' : 'progress';
    _saveView();
    _render();
  }

  function _initials(text) {
    const parts = String(text || 'PF').trim().split(/[\s_\-]+/).filter(Boolean).slice(0, 2);
    if (!parts.length) return 'PF';
    return parts.map(p => p[0]).join('').toUpperCase();
  }

  function _displayLabel(job) {
    const label = String(job.label || '').trim();
    const bits = label.split(' — ').map(s => s.trim()).filter(Boolean);
    const primary = (bits.length > 1 ? bits.slice(1).join(' — ') : (job.params?.stem || label || TYPE_LABEL[job.fmt] || 'Untitled render')).trim();
    const eyebrow = (bits[0] || TYPE_LABEL[job.fmt] || 'Render').trim();
    return { primary, eyebrow };
  }

  function _statusMessage(job) {
    if (job.status === 'running') {
      return job.statusText || `${PHASE_LABEL[job.phase] || 'Working'} • ${_fmtElapsed(job)}`;
    }
    if (job.status === 'cancelling') {
      return `Stopping job • ${_fmtElapsed(job)}`;
    }
    if (job.status === 'starting_engine') {
      return job.statusText || 'Starting Resolve Engine in background…';
    }
    if (job.status === 'blocked') {
      return job.statusText || job.readiness?.reason || 'Waiting for required source';
    }
    if (job.status === 'needs_manual') {
      return job.readiness?.reason || 'Manual render required in DaVinci Resolve';
    }
    if (job.status === 'error') {
      return `Failed on ${_absTime(job.completedAt || job.startedAt || job.createdAt)}`;
    }
    if (job.status === 'done') {
      return `Finished on ${_absTime(job.completedAt || job.startedAt || job.createdAt)}`;
    }
    if (job.status === 'cancelled') {
      return `Cancelled on ${_absTime(job.completedAt || job.startedAt || job.createdAt)}`;
    }
    if (job._resumed) {
      const pct = (job._interruptedProgress || 0) > 5 ? ` · was at ${job._interruptedProgress}%` : '';
      return `Interrupted — pending restart${pct}`;
    }
    return `Queued on ${_absTime(job.createdAt)}`;
  }

  function _showToast(msg, severity) {
    // Humanize raw exception text on error/warn toasts (pass-through otherwise).
    if (msg && /err|error|warn|danger|fail/i.test(String(severity || ''))) {
      try { msg = window.pfxFriendlyText ? window.pfxFriendlyText(msg) : msg; } catch (_) {}
    }
    try {
      // `window._pmShowToast` used to head this chain. Nothing in src/ ever
      // assigned it, so the shared toast was never reached and every message
      // below fell through to the hand-rolled div underneath.
      const fn = window._pfxToast;
      if (fn) { fn(msg, severity || 'info'); return; }
      const t = document.createElement('div');
      t.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:999999;' +
        'background:#1a2540;border:1px solid #3060a0;color:#c8d8ff;' +
        'font:12px ui-monospace,monospace;padding:10px 16px;border-radius:8px;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.6);max-width:340px;pointer-events:none';
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 3500);
    } catch {}
  }

  // ── Icons ──────────────────────────────────────────────────────────────────

  const SPINNER_SVG = `<svg class="rq-spinner" viewBox="0 0 16 16" width="14" height="14">
    <circle cx="8" cy="8" r="5.5" stroke="currentColor" stroke-width="2" fill="none"
      stroke-dasharray="22" stroke-dashoffset="8" stroke-linecap="round"/></svg>`;
  const CHECK_SVG = `<svg viewBox="0 0 14 14" width="13" height="13" class="rq-svg-icon">
    <polyline points="2,7.5 5.5,11 12,3" stroke="currentColor" stroke-width="2" fill="none"
      stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const X_SVG = `<svg viewBox="0 0 14 14" width="13" height="13" class="rq-svg-icon">
    <line x1="3" y1="3" x2="11" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <line x1="11" y1="3" x2="3" y2="11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
  const DOT_SVG = `<svg viewBox="0 0 14 14" width="13" height="13" class="rq-svg-icon">
    <circle cx="7" cy="7" r="3" fill="currentColor"/></svg>`;
  const WARN_SVG = `<svg viewBox="0 0 14 14" width="13" height="13" class="rq-svg-icon">
    <path d="M7 1.5 L13 12.5 H1 Z" stroke="currentColor" stroke-width="1.5" fill="none"
      stroke-linejoin="round"/><line x1="7" y1="5.5" x2="7" y2="8.5" stroke="currentColor"
      stroke-width="1.5" stroke-linecap="round"/><circle cx="7" cy="10.5" r=".8" fill="currentColor"/></svg>`;
  const ALERT_SVG = `<svg viewBox="0 0 14 14" width="13" height="13" class="rq-svg-icon">
    <circle cx="7" cy="7" r="5.25" stroke="currentColor" stroke-width="1.5" fill="none"/>
    <path d="M7 4.2v3.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    <circle cx="7" cy="10.15" r=".8" fill="currentColor"/></svg>`;
  const FOLDER_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" class="rq-svg-icon">
    <path d="M2.5 5h3l1.3-1.5h6.7a1 1 0 0 1 1 1V12a1.5 1.5 0 0 1-1.5 1.5H3.5A1.5 1.5 0 0 1 2 12V6a1 1 0 0 1 .5-1Z"
      fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
  const UP_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" class="rq-svg-icon">
    <path d="M8 12V4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    <path d="M4.8 7.2 8 4l3.2 3.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const RETRY_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" class="rq-svg-icon">
    <path d="M13 8a5 5 0 1 1-1.5-3.6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>
    <path d="M13 3.8v3.1H9.9" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const LOG_SVG = `<svg viewBox="0 0 16 16" width="14" height="14" class="rq-svg-icon">
    <path d="M4 4.5h8M4 8h8M4 11.5h5.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

  const ICON_MAP = {
    pending:'', running:SPINNER_SVG, cancelling:SPINNER_SVG,
    blocked:WARN_SVG, done:CHECK_SVG, error:ALERT_SVG, cancelled:X_SVG,
    needs_manual:WARN_SVG, starting_engine:SPINNER_SVG,
  };
  const STATUS_LABEL = {
    pending:'Pending', running:'Running', cancelling:'Cancelling…',
    blocked:'Blocked', done:'Done', error:'Error', cancelled:'Cancelled',
    needs_manual:'Manual Render', starting_engine:'Starting Resolve…',
  };

  function _encoderMeta(job) {
    const path = job?.encoderPath === 'hw' || job?.encoderPath === 'sw' ? job.encoderPath : '';
    if (!path) return null;
    return {
      path,
      short: path === 'hw' ? 'HW' : 'SW',
      detail: job.encoderDetail || (path === 'hw' ? 'VideoEncoder' : 'libx264'),
    };
  }

  // ── Rich running stats panel ───────────────────────────────────────────────

  function _richRunningStats(job) {
    const phIdx      = PHASE_ORDER.indexOf(job.phase || '');
    const phaseLabel = PHASE_LABEL[job.phase] || 'Working';
    const phaseMod   = job.phase || 'working';
    const encMeta    = _encoderMeta(job);

    const hasFrames = job.totalFrames > 0;
    const framePct  = hasFrames ? Math.min(100, job.currentFrame / job.totalFrames * 100) : 0;

    const framesHtml = hasFrames ? `
      <div class="rq-stat-row rq-stat-row-frames">
        <span class="rq-stat-label">Frame</span>
        <span class="rq-stat-frame-num">
          <span class="rq-frame-cur">${job.currentFrame.toLocaleString('en-US')}</span><span class="rq-stat-sep"> / </span><span class="rq-frame-tot">${job.totalFrames.toLocaleString('en-US')}</span>
        </span>
        <span class="rq-stat-spacer"></span>
        <span class="rq-fps-val">${job.currentFps > 0 ? job.currentFps.toFixed(1) : '—'}</span><span class="rq-stat-unit"> fps</span>
      </div>
      <div class="rq-frame-bar-track" title="${framePct.toFixed(1)}%">
        <div class="rq-frame-bar-fill" style="width:${framePct.toFixed(2)}%"></div>
      </div>` : '';

    const shotsHtml = job.totalSteps > 1
      ? `<span class="rq-richstat-shots">${job.completedSteps}&thinsp;/&thinsp;${job.totalSteps}<span class="rq-stat-unit"> shots</span></span>` : '';

    const pipeHtml = phIdx >= 0 ? `
      <div class="rq-phase-pipe">
        ${PHASE_ORDER.map((ph, i) => {
          const sc = i < phIdx ? 'rq-phase-step is-done'
                   : i === phIdx ? 'rq-phase-step is-active' : 'rq-phase-step';
          const lc = i < phIdx ? 'rq-phase-line is-done' : 'rq-phase-line';
          return (i > 0 ? `<span class="${lc}"></span>` : '')
               + `<span class="${sc}">${_esc(PHASE_LABEL[ph])}</span>`;
        }).join('')}
      </div>` : '';

    const cpuLvl = _sysStats.cpu     > 80 ? 'hot' : _sysStats.cpu     > 60 ? 'warn' : 'ok';
    const ramLvl = _sysStats.ramPct  > 85 ? 'hot' : _sysStats.ramPct  > 70 ? 'warn' : 'ok';
    const ramStr = _sysStats.ramTotal > 0
      ? `${(_sysStats.ramUsed / 1073741824).toFixed(1)} / ${(_sysStats.ramTotal / 1073741824).toFixed(0)} GB`
      : '— GB';
    const cpuLabel = _cpuUsageLabel();
    const gpuPct = typeof _sysStats.gpu === 'number' ? _sysStats.gpu : null;
    const gpuLvl = gpuPct > 80 ? 'hot' : gpuPct > 60 ? 'warn' : 'ok';
    const sysHtml = `
      <div class="rq-sys-stats">
        <div class="rq-sys-block">
          <span class="rq-sys-label">CPU</span>
          <div class="rq-sys-mini-track"><div class="rq-sys-mini-fill rq-sys-cpu-bar rq-sys-${cpuLvl}" style="width:${_sysStats.cpu}%"></div></div>
          <span class="rq-sys-val rq-sys-cpu-pct rq-sys-${cpuLvl}">${cpuLabel}</span>
        </div>
        <div class="rq-sys-block">
          <span class="rq-sys-label">RAM</span>
          <div class="rq-sys-mini-track"><div class="rq-sys-mini-fill rq-sys-ram-bar rq-sys-${ramLvl}" style="width:${_sysStats.ramPct}%"></div></div>
          <span class="rq-sys-val rq-sys-ram-val rq-sys-${ramLvl}">${ramStr}</span>
        </div>
        ${_gpuName ? `<div class="rq-sys-block rq-sys-block-gpu">
          <span class="rq-sys-label">GPU</span>
          <div class="rq-sys-mini-track"><div class="rq-sys-gpu-bar rq-sys-mini-fill${gpuPct === null ? '' : ` rq-sys-${gpuLvl}`}" style="width:${gpuPct === null ? 0 : gpuPct}%"></div></div>
          <span class="rq-sys-val rq-sys-gpu-pct${gpuPct === null ? '' : ` rq-sys-${gpuLvl}`}">${gpuPct === null ? '—' : `${gpuPct}%`}</span>
          <span class="rq-sys-gpu-name">${_esc(_gpuName)}</span>
        </div>` : ''}
      </div>`;

    return `<div class="rq-richstats">
      <div class="rq-stat-row rq-stat-row-primary">
        <span class="rq-phase-lozenge rq-phase-lozenge-${_esc(phaseMod)}"><span class="rq-phase-dot"></span>${_esc(phaseLabel)}</span>
        ${encMeta ? `<span class="rq-enc-chip rq-enc-chip-${_esc(encMeta.path)}" title="${_esc(encMeta.detail)}">${_esc(encMeta.short)}</span>` : ''}
        ${shotsHtml}
        <span class="rq-stat-spacer"></span>
        <span class="rq-elapsed">${_fmtElapsed(job)}</span>
      </div>
      ${framesHtml}
      ${pipeHtml}
      ${sysHtml}
    </div>`;
  }

  // ── Job card ───────────────────────────────────────────────────────────────

  function _jobCard(job, idx) {
    const { status, fmt, priority, phase } = job;
    const mod      = job.params.module || 'pulls';
    const modMeta  = MOD_META[mod] || MOD_META.pulls;
    const modC     = modMeta.color;
    const typeLabel = TYPE_LABEL[fmt] || fmt;
    const { primary, eyebrow } = _displayLabel(job);
    const statusLabel = (status === 'running' && phase)
      ? (PHASE_LABEL[phase] || 'Running')
      : (STATUS_LABEL[status] || status);

    const pendingReady = status === 'pending' ? _checkReadiness(job) : null;
    const leadIcon = status === 'pending'
      ? (pendingReady?.ready ? DOT_SVG : WARN_SVG)
      : (ICON_MAP[status] || DOT_SVG);

    const progress = status === 'running' || status === 'cancelling'
      ? Math.max(6, Math.min(100, Number(job.progress) || 0))
      : (status === 'blocked' || status === 'needs_manual')
        ? 20
        : status === 'starting_engine'
          ? 12
          : status === 'pending'
            ? 8
            : 100;
    const progressHtml = `<div class="rq-progress-track" title="${progress}%"><div class="rq-progress-fill" style="width:${progress}%"></div></div>`;

    const isActive = status === 'running' || status === 'cancelling';

    const hasHandle   = _dirHandles.has(job.id);
    const canPick     = status === 'pending' || status === 'blocked' || status === 'needs_manual' || status === 'starting_engine';
    const dirAction   = canPick ? 'pickdir' : (job.saveDir && !hasHandle ? 'pickdir' : 'opendir');
    const dirTitle    = canPick
      ? (job.saveDir && !hasHandle ? 'Re-pick save folder' : 'Choose save folder')
      : (job.saveDir && !hasHandle ? 'Re-pick save folder' : 'Reveal output folder');
    const dirClass    = `rq-icon-btn rq-icon-folder${job.saveDir ? ' is-picked' : ''}${job.saveDir && !hasHandle ? ' is-lost' : ''}`;
    const dirBtn      = `<button class="${dirClass}" data-rq-action="${dirAction}" data-rq-id="${_esc(job.id)}" title="${_esc(dirTitle)}">${FOLDER_SVG}</button>`;

    const firstMovable  = _jobs.findIndex(j => j.status === 'pending' || j.status === 'blocked' || j.status === 'needs_manual' || j.status === 'starting_engine');
    const jobIdxInFull  = _jobs.findIndex(j => j.id === job.id);
    const canMoveUp = (status === 'pending' || status === 'blocked' || status === 'needs_manual' || status === 'starting_engine') && jobIdxInFull > firstMovable;
    const canRetry  = status === 'error' && (job.retryCount || 0) < MAX_RETRIES;
    const priBtn    = (status === 'pending' || status === 'blocked' || status === 'needs_manual' || status === 'starting_engine')
      ? (priority === 1
          ? `<button class="rq-icon-btn rq-icon-priority is-high" data-rq-action="pri0" data-rq-id="${_esc(job.id)}" title="Set normal priority">▲</button>`
          : `<button class="rq-icon-btn rq-icon-priority" data-rq-action="pri1" data-rq-id="${_esc(job.id)}" title="Mark high priority">▲</button>`)
      : '';
    const moveBtn   = canMoveUp
      ? `<button class="rq-icon-btn rq-icon-move" data-rq-action="up" data-rq-id="${_esc(job.id)}" title="Move up">${UP_SVG}</button>` : '';
    const removeBtn = `<button class="rq-icon-btn rq-icon-remove" data-rq-action="${status === 'pending' || status === 'blocked' || status === 'running' || status === 'needs_manual' || status === 'starting_engine' ? 'cancel' : 'remove'}" data-rq-id="${_esc(job.id)}" title="${status === 'running' ? 'Cancel job' : (status === 'pending' || status === 'blocked' || status === 'needs_manual' || status === 'starting_engine' ? 'Remove from queue' : 'Dismiss')}">${X_SVG}</button>`;

    let actionsHtml = '';
    if (status === 'pending' || status === 'blocked' || status === 'needs_manual' || status === 'starting_engine') {
      actionsHtml = `${priBtn}${moveBtn}${dirBtn}${removeBtn}`;
    } else if (status === 'running') {
      actionsHtml = `${dirBtn}<button class="rq-icon-btn rq-icon-stop" data-rq-action="cancel" data-rq-id="${_esc(job.id)}" title="Cancel job">${X_SVG}</button>`;
    } else if (status === 'cancelling') {
      actionsHtml = `${dirBtn}<button class="rq-icon-btn rq-icon-stop" disabled title="Stopping">${X_SVG}</button>`;
    } else if (status === 'error') {
      actionsHtml = `
        ${canRetry ? `<button class="rq-icon-btn rq-icon-retry" data-rq-action="retry" data-rq-id="${_esc(job.id)}" title="Retry ${(job.retryCount || 0) + 1}/${MAX_RETRIES}">${RETRY_SVG}</button>` : ''}
        ${dirBtn}
        ${job.log.length ? `<button class="rq-icon-btn rq-icon-log" data-rq-action="log" data-rq-id="${_esc(job.id)}" title="${job._logOpen ? 'Hide log' : 'Show log'}">${LOG_SVG}</button>` : ''}
        ${removeBtn}`;
    } else {
      actionsHtml = `
        ${dirBtn}
        ${job.log.length ? `<button class="rq-icon-btn rq-icon-log" data-rq-action="log" data-rq-id="${_esc(job.id)}" title="${job._logOpen ? 'Hide log' : 'Show log'}">${LOG_SVG}</button>` : ''}
        ${removeBtn}`;
    }

    const extraDetail = [];
    if (status === 'blocked' && job.readiness?.resolveBlocked) {
      const reasons  = job.requireReasons || [];
      const flagChips = [
        reasons.includes('hasSpeedChange') || reasons.includes('speed')  ? '<span class="rq-resolve-flag">Speed Change</span>' : '',
        reasons.includes('hasGeometry')    || reasons.includes('resize') ? '<span class="rq-resolve-flag">Resize/Reframe</span>' : '',
        reasons.includes('colorPlan')      || reasons.includes('color')  ? '<span class="rq-resolve-flag">Color Pipeline</span>' : '',
      ].filter(Boolean).join('');

      const rc = job.readiness.resolveCode;
      const isNotRunning   = rc === 'NOT_RUNNING' || rc === 'LAUNCH_NEVER' || rc === 'BACKGROUND_AUTO';
      const isNeverPolicy  = rc === 'LAUNCH_NEVER';
      const isBackgroundAuto = rc === 'BACKGROUND_AUTO';
      const isStarting     = !!(job.readiness.starting) || isBackgroundAuto;
      const resolvePath    = job.readiness.resolvePath    || '';
      const resolveVersion = job.readiness.resolveVersion || '';
      const launchPolicy   = job.readiness.launchPolicy   || 'manual';
      const resolveMode    = job.readiness.resolveMode    || '';

      if (isNotRunning) {
        // ── Rich "installed but not running" card ──────────────────────────
        const jid = _esc(job.id);

        // Primary action depends on mode/policy
        let primaryBtn;
        if (isBackgroundAuto) {
          primaryBtn = `<button class="rq-resolve-action-btn rq-resolve-action-btn--primary" data-rq-action="resolve-start-retry" data-rq-id="${jid}" title="Start Resolve in background and retry automatically">Start in Background &amp; Retry</button>`;
        } else if (isStarting) {
          primaryBtn = `<button class="rq-resolve-action-btn rq-resolve-action-btn--primary" disabled title="Starting Resolve Engine…">Starting Resolve…</button>`;
        } else if (isNeverPolicy) {
          primaryBtn = `<button class="rq-resolve-action-btn rq-resolve-action-btn--primary" data-rq-action="change-launch-policy" data-rq-id="${jid}" title="Switch to Background Auto mode and start Resolve">Switch to Background Auto</button>`;
        } else {
          primaryBtn = `<button class="rq-resolve-action-btn rq-resolve-action-btn--primary" data-rq-action="resolve-start-retry" data-rq-id="${jid}" title="Launch DaVinci Resolve and retry this job">Start Resolve &amp; Retry</button>`;
        }

        // Diagnostic section content
        const reasonLines = reasons.length
          ? reasons.map(r => `• ${r}`).join('\n')
          : '• (no reasons recorded)';
        const diagText = [
          'Resolve Engine Check:',
          `Path: ${resolvePath || 'Not configured'}`,
          `Version: ${resolveVersion || 'Unknown'}`,
          `Installed: Yes`,
          `Running: No`,
          `Mode: ${resolveMode || launchPolicy}`,
          `Can Auto Launch: ${isBackgroundAuto ? 'Yes (Background Auto)' : 'No'}`,
          `Can Manual Launch: ${!isNeverPolicy && !isBackgroundAuto ? 'Yes' : 'No'}`,
          '',
          'Job requires Resolve because:',
          reasonLines,
          '',
          `Last status: ${rc}`,
          `Suggested fix: ${isBackgroundAuto
            ? 'PostFlowX will start Resolve in background automatically. Click "Start in Background & Retry" to trigger now.'
            : isNeverPolicy
            ? 'Switch to Background Auto mode or create a handoff package.'
            : 'Click Start Resolve & Retry to launch DaVinci Resolve.'}`,
        ].join('\n');

        const cardHeader = isBackgroundAuto
          ? 'Blocked — Background Auto mode: Resolve not running'
          : 'Blocked — Resolve is installed but not running';
        extraDetail.push(`<div class="rq-resolve-blocked rq-resolve-blocked--not-running">
          <div class="rq-resolve-blocked-hdr">${cardHeader}</div>
          ${resolvePath || resolveVersion ? `<div class="rq-resolve-detected">
            ${resolveVersion ? `<span class="rq-resolve-detected-name">DaVinci Resolve ${_esc(resolveVersion)}</span>` : ''}
            ${resolvePath    ? `<span class="rq-resolve-detected-path">${_esc(resolvePath)}</span>` : ''}
          </div>` : ''}
          ${flagChips ? `<div class="rq-resolve-blocked-flags">${flagChips}</div>` : ''}
          <div class="rq-resolve-blocked-reason">${_esc(job.readiness.action || job.readiness.reason || '')}</div>
          <div class="rq-resolve-blocked-actions">
            ${primaryBtn}
            ${!isNeverPolicy && !isStarting && !isBackgroundAuto ? `<button class="rq-resolve-action-btn rq-resolve-action-btn--open" data-rq-action="open-resolve-app" data-rq-id="${jid}" title="Open DaVinci Resolve without waiting">Open Resolve</button>` : ''}
            <button class="rq-resolve-action-btn rq-resolve-action-btn--setup" data-rq-action="open-resolve-setup" data-rq-id="${jid}" title="Open Project Setup → Resolve Engine tab">${isBackgroundAuto ? 'Change Mode' : 'Change Launch Policy'}</button>
            <button class="rq-resolve-action-btn rq-resolve-action-btn--handoff" data-rq-action="resolve-handoff" data-rq-id="${jid}" title="Download a handoff package for manual Resolve render">Create Manual Handoff</button>
            <button class="rq-resolve-action-btn rq-resolve-action-btn--skip" data-rq-action="no-resolve" data-rq-id="${jid}" title="Export metadata only — skip Resolve-dependent steps">Metadata Only</button>
          </div>
          <details class="rq-resolve-diag">
            <summary class="rq-resolve-diag-toggle">Show Logs</summary>
            <pre class="rq-resolve-diag-content">${_esc(diagText)}</pre>
          </details>
        </div>`);
      } else {
        // ── Simple card for DISABLED / NOT_CONFIGURED / HANDOFF_MODE ──────
        const isNotConfigured = rc === 'DISABLED' || rc === 'NOT_CONFIGURED';
        extraDetail.push(`<div class="rq-resolve-blocked">
          <div class="rq-resolve-blocked-hdr">Blocked: Resolve Engine Required</div>
          ${flagChips ? `<div class="rq-resolve-blocked-flags">${flagChips}</div>` : ''}
          <div class="rq-resolve-blocked-reason">${_esc(job.readiness.reason || job.readiness.action || '')}</div>
          <div class="rq-resolve-blocked-actions">
            <button class="rq-resolve-action-btn" data-rq-action="resolve-retry" data-rq-id="${_esc(job.id)}" title="Re-check Resolve and start job">Fix &amp; Retry</button>
            <button class="rq-resolve-action-btn rq-resolve-action-btn--setup" data-rq-action="open-resolve-setup" data-rq-id="${_esc(job.id)}" title="Open Project Setup → Resolve Engine">${isNotConfigured ? 'Configure Resolve' : 'Project Setup'}</button>
            <button class="rq-resolve-action-btn rq-resolve-action-btn--handoff" data-rq-action="resolve-handoff" data-rq-id="${_esc(job.id)}" title="Download handoff package for manual Resolve render">Create Handoff</button>
            <button class="rq-resolve-action-btn rq-resolve-action-btn--skip" data-rq-action="no-resolve" data-rq-id="${_esc(job.id)}" title="Export metadata only — skip Resolve-dependent render steps">Metadata Only</button>
          </div>
        </div>`);
      }
    } else if (status === 'starting_engine') {
      const re = job.readiness || {};
      const sv  = re.resolveVersion || '';
      const sp  = re.resolvePath    || '';
      extraDetail.push(`<div class="rq-resolve-blocked rq-resolve-blocked--starting-engine">
        <div class="rq-resolve-blocked-hdr">Starting Resolve Engine in background…</div>
        ${sv || sp ? `<div class="rq-resolve-detected">
          ${sv ? `<span class="rq-resolve-detected-name">DaVinci Resolve ${_esc(sv)}</span>` : ''}
          ${sp ? `<span class="rq-resolve-detected-path">${_esc(sp)}</span>` : ''}
        </div>` : ''}
        <div class="rq-resolve-blocked-reason">PostFlowX is launching DaVinci Resolve in the background. The job will start automatically once the scripting API is ready.</div>
        <div class="rq-resolve-blocked-actions">
          <button class="rq-resolve-action-btn rq-resolve-action-btn--primary" disabled title="Starting…">Starting Resolve…</button>
          <button class="rq-resolve-action-btn rq-resolve-action-btn--setup" data-rq-action="open-resolve-setup" data-rq-id="${_esc(job.id)}" title="Open Project Setup → Resolve Engine">Change Mode</button>
          <button class="rq-resolve-action-btn rq-resolve-action-btn--skip" data-rq-action="no-resolve" data-rq-id="${_esc(job.id)}" title="Export metadata only — skip Resolve-dependent steps">Metadata Only</button>
        </div>
      </div>`);
    } else if (status === 'blocked') {
      extraDetail.push(`<div class="rq-transfer-detail rq-transfer-detail-blocked">${_esc(job.readiness?.action || 'Resolve the blocked dependency and retry.')}</div>`);
    } else if (status === 'needs_manual') {
      // Manual render required in Resolve (handoff mode)
      const reasons = job.requireReasons || [];
      const flagChips = [
        reasons.includes('hasSpeedChange') || reasons.includes('speed')  ? '<span class="rq-resolve-flag">Speed Change</span>' : '',
        reasons.includes('hasGeometry')    || reasons.includes('resize') ? '<span class="rq-resolve-flag">Resize/Reframe</span>' : '',
        reasons.includes('colorPlan')      || reasons.includes('color')  ? '<span class="rq-resolve-flag">Color Pipeline</span>' : '',
      ].filter(Boolean).join('');
      extraDetail.push(`<div class="rq-resolve-blocked rq-resolve-handoff">
        <div class="rq-resolve-blocked-hdr">Manual Render Required in DaVinci Resolve</div>
        ${flagChips ? `<div class="rq-resolve-blocked-flags">${flagChips}</div>` : ''}
        <div class="rq-resolve-blocked-reason">Download the handoff package, render in Resolve, then dismiss this job.</div>
        <div class="rq-resolve-blocked-actions">
          <button class="rq-resolve-action-btn rq-resolve-action-btn--handoff" data-rq-action="resolve-handoff" data-rq-id="${_esc(job.id)}" title="Download handoff package for manual Resolve render">Download Handoff Package</button>
          <button class="rq-resolve-action-btn rq-resolve-action-btn--setup" data-rq-action="open-resolve-setup" data-rq-id="${_esc(job.id)}" title="Configure Resolve Engine in Project Settings">Configure Resolve</button>
        </div>
      </div>`);
    }
    if (job.error) {
      let recoveryHtml = '';
      if (job.recovery) {
        if (job.recoveryAction === 'log' && job.log.length) {
          recoveryHtml = ` → <button class="rq-recovery-log-btn" data-rq-action="log" data-rq-id="${_esc(job.id)}">Open job log</button>, then retry`;
        } else {
          recoveryHtml = `<span class="rq-transfer-recovery"> → ${_esc(job.recovery)}</span>`;
        }
      }
      extraDetail.push(`<div class="rq-transfer-detail rq-transfer-detail-error">${_esc(job.error)}${recoveryHtml}</div>`);
    }

    // Log panel
    const logHtml = job._logOpen && job.log.length
      ? `<div class="rq-log-panel">${job.log.map(e =>
          `<div class="rq-log-line"><span class="rq-log-ts">${new Date(e.ts).toLocaleTimeString()}</span> ${_esc(e.msg)}</div>`
        ).join('')}</div>` : '';

    const draggable = (status === 'pending' || status === 'blocked' || status === 'needs_manual' || status === 'starting_engine') ? 'draggable="true"' : '';
    const sourceText = (modMeta.tab || modMeta.label || 'render queue').toLowerCase();
    const encMeta = _encoderMeta(job);
    const interruptedPct = (job._resumed && (job._interruptedProgress || 0) > 5)
      ? ` · was ${job._interruptedProgress}%` : '';
    const resumedTag = job._resumed
      ? `<span class="rq-transfer-tag rq-transfer-tag-resumed" title="Interrupted by page reload — restarting from scratch">↩ Resumed${interruptedPct}</span>` : '';
    const priorityTag = priority === 1 ? `<span class="rq-transfer-tag rq-transfer-tag-priority">High Priority</span>` : '';
    const encoderTag = encMeta
      ? `<span class="rq-transfer-tag rq-transfer-tag-encoder rq-transfer-tag-${_esc(encMeta.path)}" title="${_esc(encMeta.detail)}">${_esc(encMeta.short)} · ${_esc(encMeta.detail)}</span>`
      : '';
    const countTag = job.outputFiles?.length ? `<span class="rq-transfer-tag">${job.outputFiles.length} file${job.outputFiles.length !== 1 ? 's' : ''}</span>` : '';

    return `<article class="rq-job rq-job-${_esc(status)}${priority === 1 && (status === 'pending' || status === 'blocked' || status === 'needs_manual' || status === 'starting_engine') ? ' rq-job-high-pri' : ''}"
      data-rq-card="${_esc(job.id)}" ${draggable} style="--rq-accent:${_esc(modC)};">
      <div class="rq-transfer-grid">
        <div class="rq-transfer-copy">
          <div class="rq-transfer-eyebrow">${_esc(eyebrow)}</div>
          <div class="rq-transfer-name" title="${_esc(primary)}">${_esc(primary)}</div>
          ${progressHtml}
          ${isActive ? _richRunningStats(job) : ''}
          <div class="rq-transfer-foot${isActive ? ' rq-transfer-foot-slim' : ''}">
            ${isActive
              ? (status === 'cancelling'
                  ? `<div class="rq-transfer-status"><span class="rq-job-icon rq-icon-cancelling">${SPINNER_SVG}</span><span class="rq-transfer-status-copy">Stopping…</span></div>`
                  : '')
              : `<div class="rq-transfer-status">
                   <span class="rq-job-icon rq-icon-${_esc(status)}">${leadIcon}</span>
                   <span class="rq-transfer-status-copy">${_esc(_statusMessage(job))}</span>
                 </div>`}
            <div class="rq-transfer-meta">
              ${resumedTag}${priorityTag}${encoderTag}${countTag}
              <span class="rq-transfer-chip">${_esc(typeLabel)}</span>
              <span class="rq-transfer-source">from: ${_esc(sourceText)}</span>
            </div>
          </div>
          ${extraDetail.join('')}
          ${logHtml}
        </div>
        <div class="rq-job-acts">
          <span class="rq-badge rq-badge-${_esc(status)}">${_esc(statusLabel)}</span>
          ${job.type && job.type !== 'render' ? `<span class="rq-type-badge rq-type-badge--${_esc(job.type)}" style="background:${JOB_TYPE_COLOR[job.type] || '#555'}22;color:${JOB_TYPE_COLOR[job.type] || '#aaa'};border:1px solid ${JOB_TYPE_COLOR[job.type] || '#555'}44">${JOB_TYPE_LABEL[job.type] || job.type}</span>` : ''}
          ${actionsHtml}
        </div>
      </div>
    </article>`;
  }

  // ── Main render ────────────────────────────────────────────────────────────

  function _render() {
    const list = document.getElementById('rq-job-list');
    if (!list) return;

    const nRunning  = _jobs.filter(j => j.status === 'running' || j.status === 'cancelling').length;
    const nPending  = _jobs.filter(j => j.status === 'pending').length;
    const nBlocked  = _jobs.filter(j => j.status === 'blocked').length;
    const nStarting = _jobs.filter(j => j.status === 'starting_engine').length;
    const nDone    = _jobs.filter(j => j.status === 'done').length;
    const nError   = _jobs.filter(j => j.status === 'error').length;
    const progressJobs  = _jobs.filter(j => _isProgressStatus(j.status));
    const completedJobs = _jobs.filter(j => _isCompletedStatus(j.status));
    const nProgress     = progressJobs.length;
    const nCompletedAll = completedJobs.length + _history.length;

    const progressBtn = document.getElementById('rq-view-progress');
    const completedBtn = document.getElementById('rq-view-completed');
    if (progressBtn) {
      progressBtn.textContent = 'In Progress';
      progressBtn.classList.toggle('is-active', _viewMode === 'progress');
      progressBtn.setAttribute('aria-selected', _viewMode === 'progress' ? 'true' : 'false');
      progressBtn.title = `${nProgress} active render${nProgress === 1 ? '' : 's'}`;
    }
    if (completedBtn) {
      completedBtn.textContent = 'Completed';
      completedBtn.classList.toggle('is-active', _viewMode === 'completed');
      completedBtn.setAttribute('aria-selected', _viewMode === 'completed' ? 'true' : 'false');
      completedBtn.title = `${nCompletedAll} completed render${nCompletedAll === 1 ? '' : 's'}`;
    }

    const identityName = String(
      document.getElementById('projectNameGlobal')?.value ||
      window.__MPS_PROJECT_NAME ||
      window.__MPS_EDL_RAW?.projectName ||
      'PostFlowX'
    ).trim() || 'PostFlowX';
    const userName = document.getElementById('rq-user-name');
    const userTeam = document.getElementById('rq-user-team');
    const userAvatar = document.getElementById('rq-user-avatar');
    if (userName) userName.textContent = identityName;
    if (userTeam) userTeam.textContent = _viewMode === 'completed'
      ? `${nCompletedAll} completed render${nCompletedAll === 1 ? '' : 's'}`
      : (nRunning
          ? `${nRunning} rendering now`
          : `${nProgress} queued render${nProgress === 1 ? '' : 's'}`);
    if (userAvatar) userAvatar.textContent = _initials(identityName);

    const bar = document.getElementById('rq-status-bar');
    if (bar) {
      if (_viewMode === 'completed') {
        bar.textContent = nCompletedAll
          ? `${completedJobs.length} finished in this session · ${_history.length} archived`
          : 'No completed renders yet';
        bar.className = nCompletedAll ? 'rq-status-bar rq-sb-ready' : 'rq-status-bar rq-sb-idle';
      } else if (nRunning || nStarting) {
        const parts = [];
        if (nRunning)  parts.push(`${nRunning} running`);
        if (nStarting) parts.push(`${nStarting} starting Resolve`);
        if (nPending)  parts.push(`${nPending} queued`);
        if (nBlocked)  parts.push(`${nBlocked} blocked`);
        if (nError)    parts.push(`${nError} failed`);
        bar.textContent = parts.join(' · ');
        bar.className   = 'rq-status-bar rq-sb-running';
      } else if (_paused) {
        bar.textContent = `Queue paused · ${nPending} queued · ${nBlocked} blocked`;
        bar.className   = 'rq-status-bar rq-sb-paused';
      } else if (nPending || nBlocked || nError) {
        bar.textContent = nBlocked
          ? `${nBlocked} item${nBlocked === 1 ? '' : 's'} waiting on required tabs or media`
          : nError
            ? `${nError} item${nError === 1 ? '' : 's'} need attention`
            : `${nPending} render${nPending === 1 ? '' : 's'} ready to start`;
        bar.className   = (nBlocked || nError) ? 'rq-status-bar rq-sb-blocked' : 'rq-status-bar rq-sb-ready';
      } else {
        bar.textContent = _jobs.length
          ? `No active renders · ${nDone} finished in this session`
          : 'Queue idle — use Export in any tool to add work';
        bar.className = 'rq-status-bar rq-sb-idle';
      }
    }

    const connectionPill = document.getElementById('rq-connection-pill');
    if (connectionPill) {
      let label = 'Connected';
      let cls = 'rq-connection-pill is-good';
      if (_paused) {
        label = 'Paused';
        cls = 'rq-connection-pill is-paused';
      } else if (nRunning) {
        label = 'Connected';
        cls = 'rq-connection-pill is-live';
      }
      connectionPill.textContent = label;
      connectionPill.className = cls;
    }

    const stopBtn = document.getElementById('rq-btn-stop');
    if (stopBtn) {
      const runningJob = _jobs.find(j => j.status === 'running' || j.status === 'cancelling');
      const isCancelling = runningJob?.status === 'cancelling';
      stopBtn.hidden   = _viewMode === 'completed' || !runningJob;
      stopBtn.disabled = isCancelling;
      const stopLabel  = stopBtn.querySelector('.rq-ctrl-label');
      if (stopLabel) stopLabel.textContent = isCancelling ? 'Stopping…' : 'Stop';
      stopBtn.title = isCancelling ? 'Stopping current job…' : (runningJob ? `Stop: ${runningJob.label}` : 'Stop current job');
    }

    const pauseBtn = document.getElementById('rq-btn-pause');
    if (pauseBtn) {
      pauseBtn.className   = _paused ? 'rq-ctrl-btn rq-btn-resume' : 'rq-ctrl-btn rq-btn-pause';
      const label = pauseBtn.querySelector('.rq-ctrl-label');
      if (label) label.textContent = _paused ? 'Resume' : 'Pause';
      pauseBtn.title = _paused ? 'Resume queue' : 'Pause queue';
      pauseBtn.hidden = _viewMode === 'completed';
    }

    const clearBtn = document.getElementById('rq-btn-clear');
    if (clearBtn) {
      clearBtn.disabled = !_jobs.some(j =>
        j.status === 'done' || j.status === 'error' || j.status === 'cancelled'
      );
      clearBtn.hidden = _viewMode !== 'completed';
    }

    _syncBadge();

    // ── Type filter chips ──────────────────────────────────────────────────
    const typeFilterBar = document.getElementById('rq-type-filter-bar');
    if (typeFilterBar) {
      const allJobs = _viewMode === 'completed' ? completedJobs : progressJobs;
      const typeCounts = { all: allJobs.length };
      JOB_TYPES.forEach(t => { typeCounts[t] = allJobs.filter(j => (j.type || 'render') === t).length; });
      typeFilterBar.innerHTML = ['all', ...JOB_TYPES].map(t => {
        const cnt = typeCounts[t] || 0;
        const label = t === 'all' ? 'All' : (JOB_TYPE_LABEL[t] || t);
        const col = JOB_TYPE_COLOR[t] || '#fff';
        const active = _typeFilter === t;
        return `<button class="rq-type-chip${active ? ' is-active' : ''}" data-type="${t}"
          style="${active ? `background:${col}22;color:${col};border-color:${col}66` : ''}"
          >${label}<span class="rq-type-chip-cnt">${cnt}</span></button>`;
      }).join('');
      typeFilterBar.querySelectorAll('[data-type]').forEach(btn => {
        btn.addEventListener('click', () => { _typeFilter = btn.dataset.type; _render(); });
      });
    }
    const visibleJobs = (_viewMode === 'completed' ? completedJobs : progressJobs)
      .filter(j => _typeFilter === 'all' || (j.type || 'render') === _typeFilter);
    const hintRow = document.querySelector('#main-renderq .rq-hint-row');
    const quietChrome = visibleJobs.length > 0 || (_viewMode === 'completed' && _history.length > 0);
    if (bar) bar.hidden = quietChrome;
    if (hintRow) hintRow.hidden = quietChrome;
    const hasArchivedOnly = _viewMode === 'completed' && !visibleJobs.length && _history.length > 0;

    if (!visibleJobs.length && !hasArchivedOnly) {
      list.innerHTML = `<div class="rq-empty">
        <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
          <rect x="6" y="8" width="20" height="26" rx="3" stroke="#2a4070" stroke-width="1.5" fill="none"/>
          <line x1="10" y1="14" x2="22" y2="14" stroke="#2a4070" stroke-width="1.3"/>
          <line x1="10" y1="18" x2="22" y2="18" stroke="#2a4070" stroke-width="1.3"/>
          <line x1="10" y1="22" x2="17" y2="22" stroke="#2a4070" stroke-width="1.3"/>
          <circle cx="30" cy="30" r="8" fill="#0d1a30" stroke="#2a5090" stroke-width="1.5"/>
          <line x1="30" y1="26" x2="30" y2="30" stroke="#61afef" stroke-width="1.5" stroke-linecap="round"/>
          <circle cx="30" cy="32.5" r="1" fill="#61afef"/>
        </svg>
        <p>${_viewMode === 'completed' ? 'No completed renders yet.' : 'No active renders.'}</p>
        <p class="rq-empty-hint">${_viewMode === 'completed'
          ? 'Finished work will appear here, along with your archived history.'
          : 'Click <strong>Export</strong> in any tool to add work to the queue.'}</p>
      </div>`;
      _renderHistory(); return;
    }

    if (!visibleJobs.length) {
      list.innerHTML = '';
      _renderHistory(); return;
    }

    list.innerHTML = visibleJobs.map((j, i) => _jobCard(j, i)).join('');

    list.querySelectorAll('[data-rq-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id  = btn.dataset.rqId;
        const act = btn.dataset.rqAction;
        if (act === 'remove')            _remove(id);
        if (act === 'retry')             _retry(id);
        if (act === 'cancel')            _cancel(id);
        if (act === 'up')                _moveUp(id);
        if (act === 'opendir')           _openDir(id);
        if (act === 'log')               _toggleLog(id);
        if (act === 'pri0')              _setPriority(id, 0);
        if (act === 'pri1')              _setPriority(id, 1);
        if (act === 'pickdir')           _repickSaveDir(id);
        if (act === 'resolve-retry')       _retryWithResolve(id);
        if (act === 'resolve-start-retry') _startResolveAndRetry(id);
        if (act === 'open-resolve-app')    _startResolveAndRetry(id);   // fire-and-forget open
        if (act === 'change-launch-policy') _changeLaunchPolicyAndRetry(id);
        if (act === 'open-resolve-setup')  window.__pfxProjectSetup?.open('resolve');
        if (act === 'resolve-handoff')     _generateResolveHandoff(id);
        if (act === 'no-resolve')          _noResolveExport(id);
      });
    });

    // Drag-and-drop on pending/blocked/needs_manual cards
    list.querySelectorAll('.rq-job-pending[draggable],.rq-job-blocked[draggable],.rq-job-needs_manual[draggable],.rq-job-starting_engine[draggable]').forEach(el => {
      el.addEventListener('dragstart', e => {
        _dragId = el.dataset.rqCard; e.dataTransfer.effectAllowed = 'move';
        el.classList.add('rq-job-dragging');
      });
      el.addEventListener('dragend', () => {
        _dragId = null;
        list.querySelectorAll('.rq-drop-above').forEach(x => x.classList.remove('rq-drop-above'));
        el.classList.remove('rq-job-dragging');
      });
      el.addEventListener('dragover', e => {
        if (!_dragId || _dragId === el.dataset.rqCard) return;
        const t = _jobs.find(j => j.id === el.dataset.rqCard);
        if (!t || (t.status !== 'pending' && t.status !== 'blocked' && t.status !== 'needs_manual' && t.status !== 'starting_engine')) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        list.querySelectorAll('.rq-drop-above').forEach(x => x.classList.remove('rq-drop-above'));
        el.classList.add('rq-drop-above');
      });
      el.addEventListener('dragleave', () => el.classList.remove('rq-drop-above'));
      el.addEventListener('drop', e => {
        e.preventDefault();
        if (_dragId) _dragMove(_dragId, el.dataset.rqCard);
        el.classList.remove('rq-drop-above');
      });
    });

    if (nRunning > 0) _startTick();
    _renderHistory();
  }

  // ── History section ────────────────────────────────────────────────────────

  function _renderHistory() {
    const sec = document.getElementById('rq-history-section');
    if (!sec || !_history.length || _viewMode !== 'completed') { if (sec) sec.innerHTML = ''; return; }

    const entries = _historyOpen ? _history : [];
    const cards   = entries.map(h => {
      const mm   = MOD_META[h.module] || MOD_META.pulls;
      const icon = h.status === 'done' ? CHECK_SVG : X_SVG;
      const dur  = h.duration ? `  ·  ${_fmtSec(h.duration)}` : '';
      const fl   = h.outputFiles?.length ? `  ·  ${h.outputFiles.length} file${h.outputFiles.length !== 1 ? 's' : ''}` : '';
      return `<div class="rq-hist-card rq-hist-${_esc(h.status)}">
        <span class="rq-job-icon rq-icon-${_esc(h.status)}">${icon}</span>
        <span class="rq-mod-badge" style="background:${mm.color}18;color:${mm.color};border-color:${mm.color}40">${_esc(mm.label)}</span>
        <span class="rq-hist-label" title="${_esc(h.label)}">${_esc(h.label)}</span>
        <span class="rq-hist-meta">${_relTime(h.completedAt)}${dur}${fl}</span>
      </div>`;
    }).join('');

    sec.innerHTML = `<button class="rq-hist-toggle" id="rq-hist-btn">
      ${_historyOpen ? '▾' : '▸'} Earlier Renders&thinsp;<span class="rq-hist-count">${_history.length}</span>
    </button>
    ${_historyOpen ? `<div class="rq-hist-list">${cards}</div>` : ''}`;

    document.getElementById('rq-hist-btn')
      ?.addEventListener('click', () => { _historyOpen = !_historyOpen; _renderHistory(); });
  }

  function _updateQueueBadge() {
    try {
      const btn = document.getElementById('pmExportBtn');
      if (!btn) return;
      const n = _jobs.filter(j => j.status === 'pending' || j.status === 'running' || j.status === 'blocked' || j.status === 'needs_manual' || j.status === 'starting_engine').length;
      let badge = btn.querySelector('.rq-export-badge');
      if (n > 0) {
        if (!badge) { badge = document.createElement('span'); badge.className = 'rq-export-badge'; btn.appendChild(badge); }
        badge.textContent = String(n);
      } else if (badge) { badge.remove(); }
    } catch {}
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function _init() {
    _load();
    _initSysPanel();

    window.__rqAddJob          = _add;
    window.__rqTabActivated    = () => _render();
    window.__rqExportHandlers  = window.__rqExportHandlers  || {};
    window.__rqReadinessChecks = window.__rqReadinessChecks || {};
    window.__rqCancelFlag      = false;

    // ── PFX_RQ public API ────────────────────────────────────────────────────
    window.PFX_RQ_addJob = (jobDef) => _add(jobDef);
    window.PFX_RQ_registerHandler = (mod, fn) => { window.__rqExportHandlers[mod] = fn; };
    window.PFX_RQ_registerReadinessCheck = (mod, fn) => { window.__rqReadinessChecks[mod] = fn; };
    window.PFX_RQ_getJobs = () => [..._jobs];
    window.PFX_RQ_getHistory = () => [..._history];
    // Update a marker_proxy job by worker jobId (stored as params.stem)
    window.PFX_RQ_updateJob = (workerJobId, patch) => {
      const job = _jobs.find(j => j.params?.stem === workerJobId && j.params?.module === 'marker_proxy');
      if (!job) return;
      if (patch.progress != null) job.progress = Math.min(100, Math.max(0, patch.progress));
      if (patch.status === 'done')   { job.status = 'done';   job.completedAt = Date.now(); }
      if (patch.status === 'failed' || patch.status === 'error') {
        job.status = 'error';
        job.error  = patch.error || 'render failed';
        job.completedAt = Date.now();
      }
      _save(); _render();
    };

    const wire = () => {
      document.getElementById('rq-btn-stop')?.addEventListener('click', () => {
        const runningJob = _jobs.find(j => j.status === 'running');
        if (runningJob) _cancel(runningJob.id);
      });
      document.getElementById('rq-btn-pause')?.addEventListener('click', () => _paused ? _resumeQueue() : _pauseQueue());
      document.getElementById('rq-btn-clear')?.addEventListener('click', _clearDone);
      document.getElementById('rq-view-progress')?.addEventListener('click', () => _setView('progress'));
      document.getElementById('rq-view-completed')?.addEventListener('click', () => _setView('completed'));
      // Resume-banner actions
      document.getElementById('rq-resume-now-btn')?.addEventListener('click', () => {
        _dismissResumeBanner();
        if (_paused) _resumeQueue(); else if (!_busy) _processNext();
      });
      document.getElementById('rq-resume-pause-btn')?.addEventListener('click', () => {
        _pauseQueue();
        _dismissResumeBanner();
      });
      document.getElementById('rq-resume-dismiss-btn')?.addEventListener('click', () => {
        _dismissResumeBanner();
        if (!_paused && !_busy) _processNext();
      });
      // Inject history section after job list
      const jobList = document.getElementById('rq-job-list');
      if (jobList && !document.getElementById('rq-history-section')) {
        const sec = document.createElement('div');
        sec.id = 'rq-history-section'; sec.className = 'rq-history-section';
        jobList.insertAdjacentElement('afterend', sec);
      }
    };
    document.readyState === 'loading'
      ? document.addEventListener('DOMContentLoaded', wire)
      : wire();

    if (_resumeCount > 0) {
      // Interrupted jobs restored — show countdown banner, then auto-start
      _startResumeBanner(_resumeCount);
    } else if (!_paused && _jobs.some(j => j.status === 'pending')) {
      _processNext();
    }

    // If there are blocked/needs_manual jobs on load, start the recheck timer
    if (_jobs.some(j => j.status === 'blocked' || j.status === 'needs_manual')) _startRecheckTimer();

    // Re-evaluate blocked/needs_manual VFX Package jobs when Resolve settings change.
    document.addEventListener('pfx:resolve-settings-updated', () => {
      let changed = false;
      _jobs.filter(j =>
        (j.status === 'blocked' || j.status === 'needs_manual' || j.status === 'starting_engine') &&
        j.params.fmt === 'vfxpackage'
      ).forEach(j => {
        if (j.status === 'starting_engine') return; // let in-flight launch finish
        const r = _checkReadiness(j);
        if (r.ready) {
          j.status = 'pending'; j.readiness = null; changed = true;
        } else {
          const ns = r.resolveMode === 'handoff' ? 'needs_manual' : 'blocked';
          if (j.status !== ns || j.readiness?.reason !== r.reason) {
            j.status = ns; j.readiness = r; changed = true;
          }
        }
      });
      if (changed) {
        _save(); _render();
        if (!_paused && !_busy) _processNext();
      }
      _dbgRq('pfx:resolve-settings-updated processed', { changed });
    });

    setInterval(() => {
      if (document.getElementById('main-renderq')?.classList.contains('active')) _render();
    }, 10_000);
  }

  _init();
})();
