/**
 * native_helper_client.js
 *
 * Thin extension-side wrapper for the future native playback helper contract.
 *
 * Design notes:
 * - Uses the existing background bridge with type `IMF_COMPANION_CALL`
 * - Sends action-based messages to the current companion scaffold
 * - Exposes timecode / transport / thumbnail helpers for future UI work
 * - Fails cleanly while the native playback actions are still scaffold-only
 */

const PFX_COMPANION_HOST = 'com.postflowx.companion';

let _seq = 0;
function _nextId(prefix = 'nh') {
  _seq += 1;
  return `${prefix}_${Date.now()}_${_seq}`;
}

function _normalizeCompanionResponse(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: true, result: raw, data: raw };
  }
  if ('result' in raw || 'data' in raw) {
    const result = raw.result ?? raw.data ?? {};
    const data = raw.data ?? raw.result ?? {};
    return { ...raw, ok: raw.ok ?? true, result, data };
  }
  return { ...raw, ok: raw.ok ?? true, result: raw, data: raw };
}

async function _sendAction(action, payload = {}, timeoutMs = 20000) {
  // In the Electron desktop app, route through the native command router instead
  // of the IMF_COMPANION_CALL chrome.runtime bridge, which doesn't reach the Python
  // companion for Resolve-specific actions.
  const IS_DESKTOP = typeof window !== 'undefined' &&
    !!(window.__PFX_IS_ELECTRON || window.pfxPlatform?.isMacApp);
  if (IS_DESKTOP && typeof window !== 'undefined' && window.pfxPlatform?.sendNativeCommand) {
    try {
      const result = await window.pfxPlatform.sendNativeCommand({ type: action, payload }, timeoutMs);
      return _normalizeCompanionResponse(result);
    } catch (err) {
      // Preserve code so _isUnknownActionError() can identify UNKNOWN_ACTION
      // and allow _sendFirstAvailable() to fall through to the next action name.
      const e = new Error(err?.message || String(err));
      e.code = err?.code || '';
      e.userMessage = err?.userMessage || '';
      throw e;
    }
  }

  const req = { action, ...payload, _id: _nextId(action) };
  const bridged = await chrome.runtime.sendMessage({
    type: 'IMF_COMPANION_CALL',
    payload: req,
    timeoutMs,
  });
  if (bridged?.ok && bridged.response) return _normalizeCompanionResponse(bridged.response);
  const err = bridged?.error || {};
  const rawMessage = typeof err === 'string' ? err : (err.message || err.error || 'Companion host error');
  const e = new Error(rawMessage);
  const lower = String(rawMessage || '').toLowerCase();
  e.code = (typeof err === 'object' && err.code) ? err.code : (lower.includes('unknown action') ? 'PFX_HELPER_TOO_OLD' : '');
  e.userMessage = (typeof err === 'object' && err.userMessage) ? err.userMessage : '';
  if (e.code === 'PFX_HELPER_TOO_OLD') {
    e.userMessage = 'The PostFlowX Helper is installed, but it is too old for Resolve Engine. Install/update the Helper, then reload PostFlowX.';
  }
  throw e;
}

async function _sendNativeCmd(cmd, payload = {}, timeoutMs = 20000) {
  return _sendAction(cmd, payload, timeoutMs);
}



function _isUnknownActionError(err) {
  const msg = String(err?.userMessage || err?.message || err || '');
  const code = String(err?.code || '');
  return /unknown action/i.test(msg) || /not supported by this build/i.test(msg) || code === 'BAD_REQUEST' || code === 'UNKNOWN_ACTION';
}

function _compatResponse(data = {}) {
  return _normalizeCompanionResponse({
    ok: true,
    status: 'ok',
    result: data,
    data,
  });
}

function _friendlyResolveCompat(data = {}) {
  return {
    engineSupported: false,
    compatMode: true,
    status: 'compat',
    code: 'RESOLVE_ENGINE_HELPER_UPDATE_REQUIRED',
    userMessage: 'Simple Mode is active. PostFlowX IMF Validation still works. Update the Native Helper only if you need automatic Resolve background jobs.',
    message: 'The installed Native Helper does not support the newer Resolve Engine actions.',
    ...data,
  };
}
async function _sendFirstAvailable(actions = [], payload = {}, timeoutMs = 20000) {
  let lastError = null;
  for (const action of actions) {
    try {
      return await _sendAction(action, payload, timeoutMs);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Companion host error');
}

export async function nativeHelperPing() {
  return _sendAction('ping', {}, 10000);
}

export async function nativeHelperGetCapabilities() {
  return _sendAction('getCapabilities', {}, 15000);
}

export async function nativeHelperGetAafCapabilities(extensionId = '') {
  return _sendAction('aafCapabilities', { extensionId: extensionId || (typeof chrome !== 'undefined' ? chrome.runtime?.id : '') }, 15000);
}

/**
 * Open a single-file picker via the companion.
 * @param {string} title  Dialog prompt title.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]
 *   Allowed file extensions (no dot, lowercase). Passed to the OS picker so
 *   non-matching files are dimmed. When omitted the picker defaults to video
 *   files only — pass an empty array [] or the full list explicitly for
 *   non-video pickers (e.g. EDL/XML/OTIO).
 */
export async function nativePickMediaFile(title = 'Select media file', opts = {}) {
  const payload = { title };
  if (Array.isArray(opts.extensions)) payload.extensions = opts.extensions;
  return _sendFirstAvailable(['pickMediaFile'], payload, 60000);
}

/**
 * Open a multi-file picker via the companion.
 * @param {string} title  Dialog prompt title.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]  See nativePickMediaFile.
 */
export async function nativePickMediaFiles(title = 'Select media files', opts = {}) {
  const payload = { title };
  if (Array.isArray(opts.extensions)) payload.extensions = opts.extensions;
  try {
    return await _sendFirstAvailable(['pickMediaFiles', 'pick.mediaFiles'], payload, 60000);
  } catch (multiErr) {
    // Back-compat fallback for older helpers that only support single-file pick.
    const single = await _sendFirstAvailable(['pickMediaFile'], payload, 60000);
    const path = single?.result?.path || single?.result?.filePath || '';
    if (!path) throw multiErr;
    return {
      ...single,
      result: {
        ...(single.result || {}),
        paths: [path],
        filePaths: [path],
      },
    };
  }
}

export async function nativeOpenFile(path) {
  return _sendNativeCmd('openFile', { path }, 30000);
}

export async function nativeBuildMediaProxy(assetId) {
  return _sendNativeCmd('buildMediaProxy', { assetId }, 15000);
}

export async function nativeExportQtFullTimeline(options = {}) {
  return _sendNativeCmd('exportQtFullTimeline', options, 30000);
}

export async function nativeGetTimecodeInfo(assetId) {
  return _sendNativeCmd('getTimecodeInfo', { assetId }, 15000);
}

export async function nativeGetJobStatus(jobId) {
  return _sendAction('getJobStatus', { jobId }, 15000);
}

export async function nativeGetJobLog(jobId) {
  return _sendAction('getJobLog', { jobId }, 15000);
}

export async function nativeCancelJob(jobId) {
  return _sendAction('cancelJob', { jobId }, 15000);
}

export async function nativeGetCurrentTimecode(assetId) {
  return _sendNativeCmd('getCurrentTimecode', { assetId }, 15000);
}

export async function nativeSeekTimecode(assetId, timecode, mode = 'exact') {
  return _sendNativeCmd('seekTimecode', { assetId, timecode, mode }, 30000);
}

export async function nativeSeekFrame(assetId, frameIndex) {
  return _sendNativeCmd('seekFrame', { assetId, frameIndex }, 30000);
}

export async function nativeStepFrame(assetId, delta = 1) {
  return _sendNativeCmd('stepFrame', { assetId, delta }, 20000);
}

export async function nativePlay(assetId) {
  return _sendNativeCmd('play', { assetId }, 15000);
}

export async function nativePause(assetId) {
  return _sendNativeCmd('pause', { assetId }, 15000);
}

export async function nativeGrabThumbnailAtTimecode(assetId, timecode, options = {}) {
  const {
    width = 320,
    height = 180,
    format = 'jpg',
    mode = 'fast',
    seekMode = 'source_tc',  // 'source_tc' | 'sequence_fallback'
  } = options || {};
  return _sendNativeCmd('grabThumbnailAtTimecode', {
    assetId,
    timecode,
    width,
    height,
    format,
    mode,
    seekMode,
  }, 45000);
}

export async function nativeGrabThumbnailAtPlayhead(assetId, options = {}) {
  const {
    width = 320,
    height = 180,
    format = 'jpg',
  } = options || {};
  return _sendNativeCmd('grabThumbnailAtPlayhead', {
    assetId,
    width,
    height,
    format,
  }, 45000);
}

export async function nativeGrabThumbnailStrip(assetId, startTimecode, endTimecode, options = {}) {
  const {
    count = 10,
    width = 160,
    height = 90,
    format = 'jpg',
    mode = 'fast',
  } = options || {};
  return _sendNativeCmd('grabThumbnailStrip', {
    assetId,
    startTimecode,
    endTimecode,
    count,
    width,
    height,
    format,
    mode,
  }, 90000);
}

export async function nativeTimecodeToFrame(assetId, timecode) {
  return _sendNativeCmd('timecodeToFrame', { assetId, timecode }, 15000);
}

export async function nativeFrameToTimecode(assetId, frameIndex) {
  return _sendNativeCmd('frameToTimecode', { assetId, frameIndex }, 15000);
}

export function nativeHelperHostName() {
  return PFX_COMPANION_HOST;
}

// ── Shared Media Runtime wrappers ──────────────────────────────────────────────
// All tabs should use these instead of the legacy nativeOpenFile / nativeBuildMediaProxy.
// These route through the companion MediaRuntime for proper backend selection.

/**
 * Open a media file via the shared runtime.
 * Returns { sessionId, assetId, canPlay, streamUrl, codec, fps, startTimecode,
 *           width, height, metadata, capabilities, backend }
 */
export async function sharedMediaOpen(filePath, options = {}) {
  return _sendNativeCmd('mediaOpenFile', { path: filePath, ...options }, 30000);
}

/**
 * Get a decoded preview frame for an open session.
 * sessionId may also be an assetId from the mediaOpenFile response.
 */
export async function sharedMediaGetFrame(sessionId, frameIndex = 0, options = {}) {
  const { quality = 'half', format = 'jpg', width = 1280, height = 720 } = options;
  return _sendNativeCmd('mediaGetFrame', {
    sessionId,
    assetId: sessionId,   // compat — companion accepts either
    frameIndex,
    quality,
    format,
    width,
    height,
  }, 60000);
}

/**
 * Close a shared media session.
 */
export async function sharedMediaClose(sessionId) {
  return _sendNativeCmd('mediaCloseFile', { sessionId, assetId: sessionId }, 10000);
}

/**
 * Get backend status for diagnostics panel.
 */
export async function sharedMediaGetBackendStatus() {
  return _sendNativeCmd('mediaGetBackendStatus', {}, 10000);
}

/**
 * Get metadata for an open shared media session.
 */
export async function sharedMediaGetMetadata(sessionId) {
  return _sendNativeCmd('mediaGetMetadata', { sessionId, assetId: sessionId }, 15000);
}

// ── OCF to EXR Pull — Native Helper commands ────────────────────────────────

/** Probe an OCF file or folder: returns array of { name, path, reel, tcIn, tcOut, fps, frameCount }. */
export async function nativeProbeOcfFolder(folderPath) {
  return _sendNativeCmd('ocfProbeFolder', { folderPath }, 60000);
}

/** Probe a single OCF file and return its metadata (TC, fps, reel, camera).
 *  Used by VFX Pull manual relink to score a user-picked file against an event.
 *  @param {string} filePath  Absolute path to the camera original file.
 *  @returns {Promise<{path, name, ext, fps, durationFrames, startTimecode, reel, cameraModel, colorSpace, resolution}>}
 */
export async function nativeProbeOcfFile(filePath) {
  return _sendNativeCmd('ocfProbeFile', { filePath }, 30000);
}

/** Export a single EXR job. Calls pfx-helper export-exr internally.
 *  @param {object} job  — job JSON from smartExrPullPlanner
 *  @param {function} onProgress — optional (pct: number) => void
 *  Returns native helper result JSON.
 */
export async function nativeExportEXR(job, onProgress = null) {
  // Progress is streamed via separate status polls for long jobs.
  // We kick off the job, then poll until done.
  const startRes = await _sendNativeCmd('ocfExrExportStart', { job }, 30000);
  if (!startRes?.jobId) throw new Error('Native helper did not return a jobId');

  const POLL_MS = 800;
  const MAX_WAIT = 60 * 60 * 1000; // 1 hour max
  const deadline = Date.now() + MAX_WAIT;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, POLL_MS));
    let status;
    try { status = await _sendNativeCmd('ocfExrExportStatus', { jobId: startRes.jobId }, 10000); }
    catch { continue; }
    if (typeof onProgress === 'function' && Number.isFinite(status?.progressPct)) {
      try { onProgress(status.progressPct); } catch {}
    }
    if (status?.state === 'done' || status?.state === 'success') return status.result;
    if (status?.state === 'failed' || status?.state === 'error') {
      throw new Error(status.error || 'Export failed');
    }
  }
  throw new Error('Export timed out after 1 hour');
}

/** Cancel an in-progress EXR export job. */
export async function nativeCancelEXRExport(jobId) {
  return _sendNativeCmd('ocfExrExportCancel', { jobId }, 10000);
}

/** Open a native folder browser to pick the OCF root directory. */
export async function nativePickOcfFolder() {
  return _sendNativeCmd('ocfPickFolder', {}, 30000);
}

/** Open a native folder browser to pick any folder. Returns { path: string }. */
export async function nativePickFolder(title = 'Select folder') {
  return _sendFirstAvailable(['pickFolder', 'folder.pick'], { title, mode: 'write' }, 30000);
}

/** Open the output folder in Finder/Explorer. */
export async function nativeOpenOutputFolder(folderPath) {
  return _sendNativeCmd('openFolder', { path: folderPath }, 10000);
}

/** Set the proxy/temp storage root.  All proxy and temp files will be written
 *  under {mediaRoot}/proxy/ so they travel with the project media.
 *  Pass null or empty string to reset to the default ~/.cache/postflowx/ location. */
export async function nativeSetProxyRoot(mediaRoot) {
  return _sendNativeCmd('setProxyRoot', { mediaRoot: mediaRoot || '' }, 8000);
}

/** Return the currently active proxy root path (or null if default). */
export async function nativeGetProxyRoot() {
  return _sendNativeCmd('getProxyRoot', {}, 5000);
}

export async function nativeOcfExtractFrame(filePath, timecode, opts = {}) {
  const { width = 640, height = 360, format = 'jpg' } = opts;
  return _sendAction('ocfExtractFrame', { filePath, timecode, width, height, format }, 30000);
}

/** Extract a frame and write it directly to disk (no base64 round-trip).
 *  outputPath: absolute path for the output JPEG/PNG.
 *  Returns { outputPath, width, height, timecode }.
 */
export async function nativeOcfExtractFrameToFile(filePath, timecode, outputPath, opts = {}) {
  const { width = 720, height = 404, format = 'jpg' } = opts;
  return _sendAction('ocfExtractFrameToFile', { filePath, timecode, outputPath, width, height, format }, 30000);
}

/** Transcode a range of an OCF file to a small H.264 proxy MOV written to disk.
 *  tcIn/tcOut: HH:MM:SS:FF timecodes bounding the range to extract.
 *  Returns { outputPath, tcIn, tcOut }.
 */
export async function nativeOcfExtractProxyMov(filePath, tcIn, tcOut, outputPath, opts = {}) {
  const { fps = 24, width = 1280, height = 720 } = opts;
  return _sendAction('ocfExtractProxyMov', { filePath, tcIn, tcOut, outputPath, fps, width, height }, 300000);
}

export async function nativeOcfWriteFiles(outputDir, files) {
  return _sendAction('ocfWriteFiles', { outputDir, files }, 60000);
}

/** Copy existing EXR delivery sequences + AMF look files to an output directory.
 *  shots: [{ shotName, exrFolder, amfPath }] — amfPath may be '' if not found.
 *  Returns { results: [{ shotName, ok, exrDst, error }], outputDir }.
 */
export async function nativeCopyExrDelivery(shots, outputDir) {
  return _sendAction('ocfCopyExrDelivery', { shots, outputDir }, 7_200_000); // 2-hour ceiling for large EXR copies
}

// ── Pull Engine (render_pull_exr) ─────────────────────────────────────────────

/**
 * Start an async VFX Pull EXR render for one job.
 * Companion routes to Resolve → OIIO → FFmpeg based on colorPlan.engineHint
 * and available tools. Returns { jobId } immediately; poll with nativeRenderPullExrStatus.
 *
 * job shape: PullJob from buildPullJob / buildExrJob with geometry + colorPlan blocks.
 */
export async function nativeRenderPullExrStart(job) {
  return _sendAction('renderPullExrStart', { job }, 10_000);
}

/** Poll render status for a job returned by nativeRenderPullExrStart. */
export async function nativeRenderPullExrStatus(jobId) {
  return _sendAction('renderPullExrStatus', { jobId }, 10_000);
}

/** Cancel a running render_pull_exr job. */
export async function nativeRenderPullExrCancel(jobId) {
  return _sendAction('renderPullExrCancel', { jobId }, 10_000);
}

/**
 * Start an async review-proxy movie render (Rec.709/P3 with the ACES 2.0 ODT
 * baked) from an AP0 EXR sequence. job: { exrDir, exrPattern, frameStart, fps,
 * colorPlan:{odtId}, codec:'h264'|'prores', output? }.
 * Returns { jobId }; poll with nativeRenderPullExrStatus (shared job registry).
 */
export async function nativeRenderReviewProxyStart(job) {
  return _sendAction('renderReviewProxyStart', { job }, 10_000);
}

/** List the ACES 2.0 output transforms the companion can bake (for the ODT picker). */
export async function nativeAces2OutputTransforms() {
  return _sendAction('colorAces2OutputTransforms', {}, 8_000);
}

/**
 * Run QC on a completed EXR sequence.
 * job.package.exr — folder containing the frames.
 * Returns { pass, warnings, errors, frameCount, firstFrame, lastFrame, ... }.
 */
export async function nativeQcExrSequence(job) {
  return _sendAction('qcExrSequence', { job }, 120_000);
}

/**
 * Write pull-package sidecars to job.package.metadata/:
 *   - frameMap CSV
 *   - geometry JSON
 *   - pull report JSON
 * Sidecars written by companion so paths are always absolute on the local FS.
 */
export async function nativeWritePullSidecars(job, qcResult = null) {
  return _sendAction('writePullSidecars', { job, qcResult }, 30_000);
}

// ── Resolve Background Engine ─────────────────────────────────────────────────

/** Detect DaVinci Resolve installation paths and scripting capability. */
export async function nativeResolveDetect() {
  return _sendFirstAvailable(['resolveDetect', 'resolve.detect'], {}, 15000);
}

/** Test live scripting connection to a running Resolve instance. */
export async function nativeResolveTest(resolvePath = '') {
  return _sendFirstAvailable(['resolveTest', 'resolve.test'], { resolvePath }, 15000);
}

/** Return central Resolve Engine status and queue snapshot. */
export async function nativeResolveEngineStatus(resolvePath = '') {
  try {
    return await _sendFirstAvailable(['resolveEngineStatus', 'resolve.engineStatus'], { resolvePath }, 8000);
  } catch (err) {
    if (!_isUnknownActionError(err)) throw err;
    try {
      const det = await nativeResolveDetect();
      const data = det?.result || det?.data || {};
      return _compatResponse(_friendlyResolveCompat({
        found: !!(data.found || data.resolvePath || data.resolvedPath || data.version),
        resolvePath: data.resolvePath || data.resolvedPath || resolvePath || '',
        resolvedPath: data.resolvedPath || data.resolvePath || resolvePath || '',
        version: data.version || '',
        scriptingAvailable: !!data.scriptingAvailable,
        apiAvailable: !!data.apiAvailable,
        connected: !!data.apiAvailable,
        running: !!data.apiAvailable,
        queueDepth: 0,
      }));
    } catch (_) {
      return _compatResponse(_friendlyResolveCompat({ found: false, queueDepth: 0 }));
    }
  }
}

/** Start or attach to the local Resolve Engine. */
export async function nativeResolveStartEngine(options = {}) {
  const payload = {
    resolvePath: options.resolvePath || options.resolveExecutablePath || '',
    resolveExecutablePath: options.resolveExecutablePath || options.resolvePath || '',
    launchPolicy: options.launchPolicy || 'manual',
    runMode: options.runMode || options.mode || 'headless',
    timeoutSeconds: options.timeoutSeconds || options.timeout || 60,
  };
  try {
    return await _sendFirstAvailable(['resolveStartEngine', 'resolve.startEngine'], payload, Math.max(15000, (payload.timeoutSeconds * 1000) + 5000));
  } catch (err) {
    if (!_isUnknownActionError(err)) throw err;
    // Older helpers cannot start/manage a background engine. Fall back to a
    // passive test/detect so non-technical users see a useful state, not a red
    // "Unknown action" failure.
    try {
      const test = await nativeResolveTest(payload.resolvePath);
      const data = test?.result || test?.data || {};
      return _compatResponse(_friendlyResolveCompat({
        connected: !!data.connected,
        running: !!data.connected,
        found: !!(data.connected || data.version || data.resolvePath),
        resolvePath: data.resolvePath || payload.resolvePath || '',
        version: data.version || '',
        currentProject: data.currentProject || '',
        queueDepth: 0,
        userMessage: data.connected
          ? 'Connected to the Resolve session that is already open. Automatic background jobs require a Native Helper update.'
          : 'Simple Mode is active. Update the Native Helper if you need automatic Resolve background jobs.',
      }));
    } catch (_) {
      return _compatResponse(_friendlyResolveCompat({
        found: false,
        connected: false,
        running: false,
        queueDepth: 0,
      }));
    }
  }
}

/**
 * Launch DaVinci Resolve as a hidden background process (open -g on macOS).
 * Falls back to nativeResolveStartEngine for older helpers.
 * options: { resolvePath, minimize, waitForReady, apiReadyTimeoutSeconds, timeoutSeconds }
 */
export async function nativeResolveStartBackground(options = {}) {
  const payload = {
    resolvePath: options.resolvePath || options.resolveExecutablePath || '',
    resolveExecutablePath: options.resolveExecutablePath || options.resolvePath || '',
    launchPolicy: 'background',
    runMode: 'background',
    minimize: options.minimize !== false,
    waitForReady: options.waitForReady !== false,
    apiReadyTimeoutSeconds: options.apiReadyTimeoutSeconds || options.timeoutSeconds || 60,
    timeoutSeconds: options.timeoutSeconds || 60,
  };
  try {
    return await _sendFirstAvailable(
      ['resolveStartBackground', 'resolve.startBackground'],
      payload,
      Math.max(20000, (payload.apiReadyTimeoutSeconds * 1000) + 10000)
    );
  } catch (err) {
    if (!_isUnknownActionError(err)) throw err;
    // Helper doesn't support RESOLVE_START_BACKGROUND — fall back to regular start engine.
    return nativeResolveStartEngine({ ...options, launchPolicy: 'background', runMode: 'background' });
  }
}

/**
 * Poll whether Resolve scripting API is ready without launching.
 * Returns { connected, running, version, resolvePath }.
 */
export async function nativeResolveCheckReady() {
  try {
    return await _sendFirstAvailable(['resolveCheckReady', 'resolve.checkReady'], {}, 10000);
  } catch (err) {
    if (!_isUnknownActionError(err)) throw err;
    return nativeResolveEngineStatus();
  }
}

/**
 * Run a named Python script inside Resolve via the native helper.
 * options: { scriptName, payloadPath, timeoutSeconds }
 * Returns the script's result object.
 */
export async function nativeResolveRunScript(options = {}) {
  const payload = {
    scriptName:   options.scriptName   || '',
    payloadPath:  options.payloadPath  || '',
    timeoutSeconds: options.timeoutSeconds || 120,
  };
  return _sendFirstAvailable(
    ['resolveRunScript', 'resolve.runScript'],
    payload,
    Math.max(15000, (payload.timeoutSeconds * 1000) + 5000)
  );
}

/** Stop only a companion-owned Resolve background process. */
export async function nativeResolveStopEngine(force = false) {
  try {
    return await _sendFirstAvailable(['resolveStopEngine', 'resolve.stopEngine'], { force }, 10000);
  } catch (err) {
    if (!_isUnknownActionError(err)) throw err;
    return _compatResponse(_friendlyResolveCompat({ stopped: false, message: 'Nothing to stop in Simple Mode.' }));
  }
}

/** List Resolve jobs known by the native companion. */
export async function nativeResolveListJobs() {
  try {
    return await _sendFirstAvailable(['resolveListJobs', 'resolve.listJobs'], {}, 8000);
  } catch (err) {
    if (!_isUnknownActionError(err)) throw err;
    return _compatResponse(_friendlyResolveCompat({ jobs: [], queueDepth: 0 }));
  }
}

/**
 * Read authoritative clip metadata (Start TC / Reel / File Path / FPS / duration)
 * from DaVinci Resolve's MediaPool for a list of OCF paths. Used to enrich OCF
 * matching for camera RAW whose container metadata ffprobe can't read.
 * Returns { ok, result: { clips: [{ path, tcIn, tcOut, fps, frameCount, reel, ... }], unresolved, resolveVersion } }.
 */
export async function nativeResolveProbeClips(paths = []) {
  try {
    return await _sendFirstAvailable(['resolveProbeClips', 'resolve.probeClips'], { paths }, 120000);
  } catch (err) {
    if (!_isUnknownActionError(err)) throw err;
    return _compatResponse(_friendlyResolveCompat({ clips: [], unresolved: paths, resolveVersion: '' }));
  }
}

/** Clear queued/completed Resolve jobs. Active jobs are preserved by the companion. */
export async function nativeResolveClearQueue(includeCompleted = true) {
  try {
    return await _sendFirstAvailable(['resolveClearQueue', 'resolve.clearQueue'], { includeCompleted }, 10000);
  } catch (err) {
    if (!_isUnknownActionError(err)) throw err;
    return _compatResponse(_friendlyResolveCompat({ cleared: 0, removed: 0, message: 'No Resolve queue exists in Simple Mode.' }));
  }
}

/** Fetch Resolve Engine log lines and log path. */
export async function nativeResolveGetLogs(maxLines = 200) {
  try {
    return await _sendFirstAvailable(['resolveGetLogs', 'resolve.getLogs'], { maxLines }, 8000);
  } catch (err) {
    if (!_isUnknownActionError(err)) throw err;
    return _compatResponse(_friendlyResolveCompat({
      logs: [
        'Simple Mode active.',
        'The installed Native Helper does not support Resolve Engine logs yet.',
        'Run the Full Helper Installer to enable automatic background jobs.'
      ],
      lines: [],
      logPath: '',
    }));
  }
}

/**
 * Start a Resolve background job. Returns { ok, result: { jobId } } immediately.
 * Poll nativeResolveJobStatus(jobId) for progress and final result.
 *
 * @param {Object} job             - PFX Resolve job object (jobId, jobType, mediaFiles, …)
 * @param {string} [resolvePath]   - Override path to Resolve executable
 * @param {number} [timeoutSeconds=300]
 * @param {boolean} [debug=false]  - Save all job artifacts to debug/
 */
export async function nativeResolveRunJob(job, resolvePath = '', timeoutSeconds = 300, debug = false) {
  // Stamp the configured launch policy onto the job so the companion can
  // auto-launch Resolve in the background on demand (it no longer needs Resolve
  // to be open first). The job's own values win; otherwise fall back to the
  // published engine config, then to the product default (background auto).
  const _eng = (typeof window !== 'undefined' && window.PFX_RESOLVE_ENGINE) || {};
  const _job = { ...(job || {}) };
  if (!_job.launchPolicy) _job.launchPolicy = _eng.launchPolicy || 'on_demand';
  if (!_job.runMode)      _job.runMode      = _eng.runMode      || 'background';
  const _path = resolvePath || _eng.path || '';
  try {
    return await _sendFirstAvailable(['resolveRunJob', 'resolve.runJob'], { job: _job, resolvePath: _path, timeoutSeconds, debug }, 20000);
  } catch (err) {
    if (!_isUnknownActionError(err)) throw err;
    return _compatResponse(_friendlyResolveCompat({
      status: 'manualRequired',
      jobId: '',
      userMessage: 'Automatic Resolve job is not available on this helper. Use Manual Handoff or update the Native Helper.',
    }));
  }
}

/** Request cancellation of a running Resolve job. */
export async function nativeResolveCancelJob(jobId) {
  return _sendFirstAvailable(['resolveCancelJob', 'resolve.cancelJob'], { jobId }, 8000);
}

/**
 * Poll status of a Resolve background job.
 * Returns { ok, result: { jobId, step, percent, message, done, result? } }
 */
export async function nativeResolveJobStatus(jobId) {
  return _sendFirstAvailable(['resolveJobStatus', 'resolve.jobStatus'], { jobId }, 8000);
}

/**
 * Create a manual handoff package for a job that could not run automatically.
 * Returns { ok, result: { packageDir } }
 */
export async function nativeResolveManualHandoff(job, outputDir) {
  return _sendFirstAvailable(['resolveManualHandoff', 'resolve.manualHandoff'], { job, outputDir }, 15000);
}

// ── Trailer Conform Engine ────────────────────────────────────────────────────

/**
 * Start Phase 1 conform analysis.
 * job = { editFile, editFormat, referenceFile, sourceFiles[], outputDir, fps, proxyWidth, proxyHeight }
 * Returns { ok, result: { jobId } } immediately. Poll conformJobStatus(jobId).
 */
export async function nativeConformAnalyze(job) {
  return _sendAction('conformAnalyze', { job }, 10000);
}

/**
 * Poll status of a conform job (analyze or build).
 * Returns { ok, result: { jobId, step, pct, message, done, events?, proxies?, matches?, result? } }
 */
export async function nativeConformJobStatus(jobId) {
  return _sendAction('conformJobStatus', { jobId }, 8000);
}

/**
 * Start Phase 3: build conformed Resolve timeline.
 * job = { matchList[], outputDir, fps, label, renderReview, burnIn, exportFormats[] }
 * Returns { ok, result: { jobId } } immediately.
 */
export async function nativeConformBuildTimeline(job) {
  return _sendAction('conformBuildTimeline', { job }, 10000);
}

/** Cancel a running conform job. */
export async function nativeConformCancelJob(jobId) {
  return _sendAction('conformCancelJob', { jobId }, 8000);
}

/**
 * Export EDL/FCPXML/OTIO/CSV from an accepted match list without building timeline.
 * Returns { ok, result: { exports: { edl?, fcpxml?, otio?, csv? } } }
 */
export async function nativeConformExport(matchList, outputDir, fps, label, formats) {
  return _sendAction('conformExport', { matchList, outputDir, fps, label, formats }, 15000);
}

/**
 * Fast pre-flight sanity check for a Trailer Conform job. Validates the edit
 * file parses, the reference exists, the source folder has matching files,
 * and shows how many sources will survive the filename pre-filter. Returns
 * in ~100ms — no Resolve calls, no proxy rendering. Run this on Analyze
 * click before the long-running conformAnalyze job.
 *
 * Response data shape:
 *   { ok, errors[], warnings[], editEventsCount, editTotalFrames,
 *     editDurationSeconds, referenceFileBytes, sourceFileCount,
 *     sourceAfterPrefilter, sourceDropped, estimatedProxySeconds }
 */
export async function nativeConformPreflight(job) {
  return _sendAction('conformPreflight', { job }, 8000);
}

/* ─── Apple Vision OCR (macOS only — falls back to false on other platforms) ──── */

// Cached capability — set on first call, sticky for the session. The companion
// returns the same answer until restarted, so we only need to probe once.
let _pmOcrEngineCap = null; // { available: bool, engine: str, platform: str } | null

/** Quick probe — returns { available, engine, platform } and caches it. */
export async function nativeOcrCapabilities() {
  if (_pmOcrEngineCap) return { ok: true, result: _pmOcrEngineCap };
  try {
    const res = await _sendNativeCmd('ocrCapabilities', {}, 4000);
    if (res?.ok && res.result) _pmOcrEngineCap = res.result;
    return res;
  } catch (e) {
    return { ok: false, error: { message: String(e?.message || e) } };
  }
}

/**
 * Run Apple Vision text recognition on a PNG image.
 *
 * @param {string} pngBase64OrDataUrl
 *   Either a `data:image/png;base64,...` URL or just the base64 body.
 * @param {object} [opts]
 * @param {'accurate'|'fast'} [opts.recognitionLevel='accurate']
 * @param {string[]} [opts.languageList]  BCP-47 codes; default = auto-detect.
 * @param {number} [opts.minimumTextHeight=0]  0–1 (fraction of image height).
 * @returns {Promise<{ok, result?: {ok, engine, available, rawText, results, error}, error?}>}
 */
export async function nativeOcrImage(pngBase64OrDataUrl, opts = {}) {
  if (!pngBase64OrDataUrl) {
    return { ok: false, error: { message: 'Empty image' } };
  }
  const payload = {
    imageBase64: String(pngBase64OrDataUrl),
    recognitionLevel: opts.recognitionLevel || 'accurate',
    languageList: Array.isArray(opts.languageList) ? opts.languageList : undefined,
    minimumTextHeight: Number.isFinite(opts.minimumTextHeight) ? opts.minimumTextHeight : 0,
  };
  return _sendNativeCmd('ocrImage', payload, 10000);
}
