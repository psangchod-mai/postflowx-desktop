/**
 * imf_proxy.js — IMF Proxy QC orchestration.
 *
 * Prefers the new `com.postflowx.companion` host when available and falls back
 * to the legacy `com.postflowx.host` helper otherwise.
 *
 * Exports two functions consumed by imf_ui.js:
 *
 *   imfPickFolder()                                 → { backend, folder, cpls, packageId? } | null
 *   imfGenerateProxy(selection, cplSelection, cb)   → { videoUrl, doviUrl }
 */

const PFX_LEGACY_HOST = 'com.postflowx.host';
const PFX_COMPANION_HOST = 'com.postflowx.companion';

// ── Shared HTTP token (set once when capabilities are received via native messaging) ──
// The companion returns this in getCapabilities/ping responses so only the extension
// (via the secure native messaging channel) knows it.  All HTTP requests include it.
let _httpToken = '';
export function setCompanionHttpToken(token) { if (token) _httpToken = String(token); }
function _tokenHdrs() { return _httpToken ? { 'X-PFX-Token': _httpToken } : {}; }

// ── Shared native-port state (module singleton) ────────────────────────────
const _ports = new Map();
const _pending = new Map();
let _reqId = 0;

function _connect(host) {
  try {
    const port = chrome.runtime.connectNative(host);
    _ports.set(host, port);

    port.onMessage.addListener((msg) => {
      const id = msg._id;
      if (id !== undefined && _pending.has(id)) {
        const { resolve, reject, timer } = _pending.get(id);
        clearTimeout(timer);
        _pending.delete(id);
        if (msg?.status === 'error') {
          const err = new Error(msg?.error?.message || msg?.error || 'Host error');
          err.code = msg?.error?.code || '';
          err.userMessage = msg?.error?.userMessage || '';
          reject(err);
        }
        else resolve(msg);
      }
    });

    port.onDisconnect.addListener(() => {
      chrome.runtime.lastError;   // consume to suppress "unchecked" warning
      _ports.delete(host);
      for (const [id, pending] of _pending) {
        if (pending.host !== host) continue;
        clearTimeout(pending.timer);
        try {
          const err = new Error('Host disconnected');
          err.code = 'HOST_DISCONNECTED';
          pending.reject(err);
        } catch {}
        _pending.delete(id);
      }
    });
  } catch {
    _ports.delete(host);
  }
}

function _send(host, msg, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let port = _ports.get(host);
    if (!port) {
      _connect(host);
      port = _ports.get(host);
    }
    if (!port) {
      const err = new Error('host_unavailable');
      err.code = 'host_unavailable';
      reject(err);
      return;
    }
    const id = ++_reqId;
    const timer = setTimeout(() => {
      _pending.delete(id);
      const err = new Error('host_timeout');
      err.code = 'host_timeout';
      reject(err);
    }, timeoutMs);
    _pending.set(id, { resolve, reject, timer, host });
    try {
      port.postMessage({ ...msg, _id: id });
    } catch (e) {
      // Port died between the timer setup and send — clean up immediately so the
      // 20-second timer doesn't hold a stale pending entry with live references.
      clearTimeout(timer);
      _pending.delete(id);
      reject(e);
    }
  });
}

async function _sendCompanion(msg, timeoutMs = 20000) {
  try {
    const bridged = await chrome.runtime.sendMessage({
      type: 'IMF_COMPANION_CALL',
      payload: msg,
      timeoutMs,
    });
    if (bridged?.ok && bridged.response) return bridged.response;
    const err = bridged?.error || {};
    if (bridged && bridged.ok === false) {
      const e = new Error(err.message || 'Companion host error');
      e.code = err.code || '';
      e.userMessage = err.userMessage || '';
      throw e;
    }
  } catch (err) {
    if (err?.message !== 'The message port closed before a response was received.') {
      if (err?.code || err?.message) throw err;
    }
  }
  return _send(PFX_COMPANION_HOST, msg, timeoutMs);
}

async function _sendLegacy(msg, timeoutMs = 20000) {
  return _send(PFX_LEGACY_HOST, msg, timeoutMs);
}

async function _scanWithCompanion(folderPath) {
  const scanned = await _sendCompanion({ action: 'scanImfPackage', folderPath }, 130000);
  const data = scanned?.data || {};
  return {
    backend: 'companion',
    folder: data.folderPath || folderPath,
    folderPath: data.folderPath || folderPath,
    packageId: data.packageId,
    snapshot: data.snapshot || null,
    scan: data,
    cpls: (data.cpls || []).map((cpl) => ({
      name: cpl.relativePath || cpl.label || cpl.cplId,
      contentTitle: cpl.contentTitle || cpl.label || cpl.relativePath || cpl.cplId,
      cplId: cpl.cplId,
      relativePath: cpl.relativePath,
      playable: !!cpl.playable,
    })),
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

export async function imfPickFolderCompanion() {
  const picked = await _sendCompanion({ action: 'pickImfFolder' }, 130000);
  const folderPath = picked?.data?.folderPath;
  if (!folderPath) return null;
  return _scanWithCompanion(folderPath);
}

export async function imfScanFolderCompanion(folderPath) {
  const safeFolder = String(folderPath || '').trim();
  if (!safeFolder) throw new Error('folderPath_required');
  return _scanWithCompanion(safeFolder);
}

export async function imfPingCompanion() {
  const res = await _sendCompanion({ action: 'ping' }, 10000);
  return { status: res?.status || 'ok', ...(res?.data || {}) };
}

export async function imfRestoreProxyOutput({ outputPath, folderPath = '', cplPath = '', audioMode = '', audioMessage = '' } = {}) {
  const safePath = String(outputPath || '').trim();
  if (!safePath) throw new Error('outputPath_required');
  const res = await _sendCompanion({
    action: 'restoreProxyOutput',
    outputPath: safePath,
    folderPath: String(folderPath || '').trim(),
    cplPath: String(cplPath || '').trim(),
    audioMode: String(audioMode || '').trim(),
    audioMessage: String(audioMessage || '').trim(),
  }, 20000);
  const data = res?.data || {};
  return {
    sessionId: String(data.sessionId || '').trim(),
    videoUrl: String(data.streamUrl || '').trim(),
    doviUrl: String(data.metadataUrl || '').trim(),
    logUrl: String(data.logUrl || '').trim(),
    audioMode: String(data.audioMode || audioMode || 'unknown').trim(),
    audioMessage: String(data.audioMessage || audioMessage || '').trim(),
    immersiveAudio: data.immersiveAudio || null,
    outputPath: String(data.outputPath || safePath).trim(),
    progressUrl: String(data.progressUrl || '').trim(),
    state: String(data.state || '').trim(),
    proxyName: String(data.proxyName || '').trim(),
    startTimecode: String(data.startTimecode || '').trim(),
  };
}

export async function imfGetCapabilities() {
  try {
    const res = await _sendCompanion({ action: 'getCapabilities' }, 30000);
    return { backend: 'companion', ...(res?.data || {}) };
  } catch (err) {
    try {
      await _sendLegacy({ action: 'check_ffmpeg' }, 10000);
      return {
        backend: 'legacy',
        engines: [],
        features: {
          imfPlayback: false,
          fullCplProxy: true,
          dolbyVisionMetadata: true,
          iabDecode: false,
          admDecode: false,
          proresImf: false,
          photonQc: false,
          pickImfFolder: false,
          scanImfPackage: false,
        },
        immersiveAudio: {
          ready: false,
          iabDecode: false,
          admDecode: false,
          admExtract: true,
          engineId: '',
          engineLabel: 'Legacy helper',
          userMessage: 'Legacy helper is installed, but it does not provide IAB PCM decode.',
          blockers: ['No immersive-audio decoder is exposed by the legacy helper'],
          notes: ['Embedded ADM / AXML inspection still works inside PostFlowX'],
        },
      };
    } catch {}
  }

  return {
    backend: '',
    engines: [],
    features: {
      imfPlayback: false,
      fullCplProxy: false,
      dolbyVisionMetadata: true,
      iabDecode: false,
      admDecode: false,
      proresImf: false,
      photonQc: false,
      pickImfFolder: false,
      scanImfPackage: false,
    },
    immersiveAudio: {
      ready: false,
      iabDecode: false,
      admDecode: false,
      admExtract: true,
      engineId: '',
      engineLabel: 'Unavailable',
      userMessage: 'No local native companion reported IAB decode support.',
      blockers: ['Native companion is unavailable'],
      notes: ['Embedded ADM / AXML inspection still works inside PostFlowX'],
    },
  };
}

export async function imfInspectImmersiveAudio(packageId, cplId) {
  const safePackage = String(packageId || '').trim();
  const safeCpl = String(cplId || '').trim();
  if (!safePackage || !safeCpl) throw new Error('packageId_and_cplId_required');
  const res = await _sendCompanion({
    action: 'inspectImmersiveAudio',
    packageId: safePackage,
    cplId: safeCpl,
  }, 30000);
  return res?.data || null;
}

export async function imfStartIabDecode(selection, cplSelection, { onProgress, onStatus } = {}) {
  const packageId = String(selection?.packageId || '').trim();
  const cplId = String(cplSelection?.cplId || '').trim();
  if (!packageId || !cplId) throw new Error('packageId_and_cplId_required');

  onStatus?.('Submitting IAB decode job…');
  const res = await _sendCompanion({
    action: 'startIabDecode',
    packageId,
    cplId,
    options: {},
  }, 30000);
  const data = res?.data || {};
  const progressUrl = data.progressUrl;
  const logUrl = data.logUrl;
  let immersiveAudio = data.immersiveAudio || null;

  onStatus?.(`Queued IAB decode for ${data.assetName || 'IAB track'}…`);
  onProgress?.(0);

  const finalStatus = await new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const r = await _fetchWithTokenRefresh(progressUrl);
        if (!r.ok) { reject(new Error('progress_fetch_failed')); return; }
        const payload = await r.json();
        if (payload.immersiveAudio) immersiveAudio = payload.immersiveAudio;
        onProgress?.(Math.max(0, Math.min(100, payload.pct || 0)));
        onStatus?.(payload.message || 'Decoding IAB…');
        if (payload.state === 'failed') {
          let detail = payload.message || payload.error || 'iab_decode_failed';
          try {
            const logR = await fetch(logUrl, { headers: _tokenHdrs() });
            if (logR.ok) {
              const log = (await logR.text()).trim();
              if (log && log !== 'no log') detail += `\n\ncompanion log:\n${log}`;
            }
          } catch {}
          reject(new Error(detail));
          return;
        }
        if (payload.done || payload.state === 'done') {
          resolve(payload);
          return;
        }
        setTimeout(poll, 400);
      } catch (err) {
        reject(err);
      }
    };
    poll();
  });

  return {
    jobId: data.jobId,
    progressUrl,
    logUrl,
    artifactPath: finalStatus?.artifactPath || data.artifactPath || '',
    artifactType: finalStatus?.artifactType || data.artifactType || 'wav',
    assetPath: finalStatus?.assetPath || data.assetPath || '',
    trackFileId: finalStatus?.trackFileId || data.trackFileId || '',
    immersiveAudio,
  };
}

export async function imfExtractWaveformPeaks(wavPath, { maxSec = 0, pointsPerSec = 100 } = {}) {
  const safePath = String(wavPath || '').trim();
  if (!safePath) throw new Error('wavPath_required');
  const res = await _sendCompanion({
    action: 'extractWaveformPeaks',
    wavPath: safePath,
    maxSec,
    pointsPerSec,
  }, 60000);
  if (res?.status === 'error') throw new Error(res?.error?.message || 'waveform_peaks_failed');
  return res?.data || null;
}

/**
 * Check the companion's content-addressable proxy registry.
 *
 * @param {object} selection  - { backend, packageId, folderPath }
 * @param {object} cplSelection - { cplId, trackFileIds, totalFrames, editRate }
 * @returns registry hit { found, proxyPath, proxyName, audioMode, audioMessage,
 *          startTimecode, fps, fingerprint } or { found: false }
 */
export async function imfLookupProxy(selection, cplSelection) {
  const cplId       = String(cplSelection?.cplId       || '').trim();
  const trackFileIds = Array.isArray(cplSelection?.trackFileIds) ? cplSelection.trackFileIds.filter(Boolean) : [];
  const totalFrames  = Number(cplSelection?.totalFrames  || 0) || 0;
  const editRate     = cplSelection?.editRate != null ? cplSelection.editRate : 0;
  if (!cplId) return { found: false };
  const res = await _sendCompanion({
    action: 'lookupProxy',
    cplId,
    trackFileIds,
    totalFrames,
    editRate,
  }, 10000);
  if (res?.status === 'error') return { found: false };
  return res?.data || { found: false };
}

export async function imfDeleteProxy({ proxyPath = '', fingerprint = '' } = {}) {
  const res = await _sendCompanion({ action: 'deleteProxy', proxyPath, fingerprint }, 15000);
  if (res?.status === 'error') throw new Error(res.error?.userMessage || res.error?.message || 'delete_failed');
  return res?.data || {};
}

export async function imfCancelDecodeJob(jobId) {
  const safeId = String(jobId || '').trim();
  if (!safeId) return;
  await _sendCompanion({ action: 'cancelJob', jobId: safeId }, 10000).catch(() => {});
}

export async function imfRevealArtifact(artifactPath) {
  const safePath = String(artifactPath || '').trim();
  if (!safePath) return;
  const res = await _sendCompanion({ action: 'revealArtifact', artifactPath: safePath }, 10000);
  if (res?.error) throw new Error(res.error.userMessage || res.error.code || 'reveal_failed');
}

/**
 * Ask the companion to scan a folder for a Dolby Vision CM XML sidecar
 * and return structured shot data for the Metafier.
 * @param {string} folderPath — absolute path to the IMF package folder
 * @returns {Promise<{shots, shotCount, version, title}|null>}
 */
export async function imfGetDoviMetafier(folderPath, cplPath) {
  const safePath = String(folderPath || '').trim();
  if (!safePath) return null;
  const payload = { action: 'getDoviMetafier', folder: safePath };
  const safeCpl = String(cplPath || '').trim();
  if (safeCpl) payload.cplPath = safeCpl;
  try {
    const res = await _sendCompanion(payload, 30000);
    if (res?.error) return null;
    return res?.data ?? null;
  } catch {
    return null;
  }
}

/** Detect Dolby Metafier installation. Returns {found, path, version}. */
export async function imfDetectMetafier(customPath) {
  try {
    const payload = { action: 'detectMetafier' };
    if (customPath) payload.customPath = customPath;
    const res = await _sendCompanion(payload, 15000);
    return res?.data ?? { found: false, path: '', version: '' };
  } catch {
    return { found: false, path: '', version: '' };
  }
}

/**
 * Extract Dolby Vision CM XML from a Video MXF using Metafier.
 * The companion reads the MXF from disk — no MXF binary passes through messaging.
 *
 * @param {object} params
 *   packageRootPath  — absolute filesystem path to IMF package root
 *   mxfRelativePath  — relative path to the video MXF from package root
 *   assetId          — CPL asset UUID (for logging)
 *   reelId           — reel label e.g. "R5"
 *   metafierPath     — optional override path to Metafier executable
 *   commandTemplate  — optional e.g. '"{metafier}" -e "{output}" "{input}"'
 *   timeoutSeconds   — extraction timeout (default 120)
 *   outputDir        — optional temp dir for extracted XML
 * @returns {Promise<{ok, xmlText, outputXmlPath, reelId, exitCode, stderr, warnings}|null>}
 */
export async function imfExtractDoviFromMxf(params = {}) {
  try {
    const res = await _sendCompanion({ action: 'extractDoviFromMxf', ...params }, 180000);
    if (!res) return null;
    if (res.error || res.status === 'error') {
      return { ok: false, errorCode: res.error?.code || 'EXTRACT_FAILED',
               message: res.error?.message || res.error?.userMessage || 'Extraction failed',
               stderr: res.error?.detail || '' };
    }
    return { ok: true, ...(res.data || {}) };
  } catch (err) {
    return { ok: false, errorCode: 'EXTRACT_FAILED', message: err?.message || String(err), stderr: '' };
  }
}

/** Read a large extracted DV XML from disk (when extractDoviFromMxf returns xmlTruncated:true). */
export async function imfReadExtractedXml(xmlPath) {
  if (!xmlPath) return null;
  try {
    const res = await _sendCompanion({ action: 'readExtractedXml', xmlPath }, 30000);
    if (res?.error) return null;
    return res?.data ?? null;
  } catch { return null; }
}

/** Resolve a relative IMF asset path to its absolute filesystem path. */
export async function imfGetRealPath(packageRootPath, relativePath) {
  try {
    const res = await _sendCompanion({ action: 'getImfRealPath', packageRootPath, relativePath }, 10000);
    return res?.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Opens a macOS folder picker via Python osascript.
 * Uses a 120 s timeout on the Python side (user has time to pick a folder).
 * @returns {Promise<{folder:string, cpls:{name:string,path:string}[]}|null>}
 *   null if the user cancelled the picker.
 */
export async function imfPickFolder() {
  try {
    return await imfPickFolderCompanion();
  } catch (err) {
    if (err?.code === 'CANCELLED') return null;
    if (err?.code && err.code !== 'host_unavailable' && err.code !== 'HOST_DISCONNECTED') {
      throw err;
    }
  }

  const res = await _sendLegacy({ action: 'pick_imf_folder' }, 130000);  // 130s — user has time to pick
  if (res.status === 'cancelled') return null;
  return { backend: 'legacy', folder: res.folder, cpls: res.cpls || [] };
}

/**
 * Starts the Rec.709 H.264 proxy generation pipeline on the native host,
 * polls /progress/{sid} until the transcode is done, then returns the
 * stream and Dolby Vision metadata URLs.
 *
 * @param {string} folderPath       IMF master folder path (from imfPickFolder)
 * @param {string} cplPath          Absolute path to the selected CPL.xml
 * @param {object} [opts]
 *   onProgress(pct)   Called with 0–100 as transcode progresses
 *   onStatus(text)    Human-readable status string updates
 * @returns {Promise<{videoUrl:string, doviUrl:string}>}
 */
/** Refresh the HTTP token from the companion and update _httpToken. */
async function _refreshToken() {
  try {
    const ping = await _sendCompanion({ action: 'ping' }, 8000);
    const tok = ping?.data?.httpToken;
    if (tok) { _httpToken = String(tok); }
  } catch {}
}

/** Fetch with automatic token refresh on 403. Returns the Response. */
async function _fetchWithTokenRefresh(url) {
  let r = await fetch(url, { headers: _tokenHdrs() });
  if (r.status === 403) {
    await _refreshToken();
    r = await fetch(url, { headers: _tokenHdrs() });
  }
  return r;
}

export async function imfGenerateProxy(selection, cplSelection, { onProgress, onStatus, onStart, forceResolve = false, proxyQuality } = {}) {
  // Always refresh the HTTP token before polling to handle companion restarts.
  await _refreshToken();

  if (selection?.backend === 'companion' && cplSelection?.cplId) {
    onStatus?.('Submitting CPL to companion…');
    const res = await _sendCompanion({
      action: 'startProxyPlayback',
      packageId: selection.packageId,
      cplId: cplSelection.cplId,
      options: {},
      forceResolve: forceResolve ? true : false,
      ...(proxyQuality ? { proxyQuality } : {}),
    }, 130000);
    const data = res?.data || {};
    const progressUrl = data.progressUrl;
    const logUrl = data.logUrl;
    let audioMode = data.audioMode || 'unknown';
    let audioMessage = data.audioMessage || '';
    let immersiveAudio = data.immersiveAudio || null;
    let outputPath = data.outputPath || '';
    let proxyName = String(data.proxyName || cplSelection?.contentTitle || cplSelection?.name || '').trim();
    let startTimecode = String(data.startTimecode || '').trim();

    const initialResult = {
      sessionId: String(data.sessionId || '').trim(),
      videoUrl: data.streamUrl,
      doviUrl: data.metadataUrl,
      logUrl,
      audioMode,
      audioMessage,
      immersiveAudio,
      outputPath: String(outputPath || '').trim(),
      proxyName,
      startTimecode,
    };
    onStart?.(initialResult);

    if (data.cached && data.streamUrl) {
      onStatus?.('Restoring cached full-CPL proxy…');
      onProgress?.(100);
      return initialResult;
    }

    onStatus?.('Building full-CPL proxy…');
    onProgress?.(0);

    await new Promise((resolve, reject) => {
      const poll = async () => {
        try {
          const r = await _fetchWithTokenRefresh(progressUrl);
          if (!r.ok) { reject(new Error('progress_fetch_failed')); return; }
          const payload = await r.json();
          if (payload.error) {
            let detail = payload.error;
            try {
              const logR = await fetch(logUrl, { headers: _tokenHdrs() });
              if (logR.ok) {
                const log = (await logR.text()).trim();
                if (log && log !== 'no log') detail += `\n\ncompanion log:\n${log}`;
              }
            } catch {}
            reject(new Error(detail)); return;
          }
          if (payload.audioMode) audioMode = payload.audioMode;
          if (typeof payload.audioMessage === 'string') audioMessage = payload.audioMessage;
          if (payload.immersiveAudio) immersiveAudio = payload.immersiveAudio;
          if (payload.outputPath) outputPath = payload.outputPath;
          if (payload.proxyName) proxyName = String(payload.proxyName || '').trim();
          if (typeof payload.startTimecode === 'string') startTimecode = String(payload.startTimecode || '').trim();
          onProgress?.(Math.max(0, Math.min(100, payload.pct || 0)));
          if (payload.done || payload.state === 'done') { resolve(); return; }
          if (payload.state === 'failed') {
            reject(new Error(payload.message || 'proxy_failed'));
            return;
          }
          setTimeout(poll, 400);
        } catch (e) {
          reject(e);
        }
      };
      poll();
    });

    return {
      sessionId: String(data.sessionId || '').trim(),
      videoUrl: data.streamUrl,
      doviUrl: data.metadataUrl,
      logUrl,
      audioMode,
      audioMessage,
      immersiveAudio,
      outputPath: String(outputPath || '').trim(),
      proxyName,
      startTimecode,
    };
  }

  const folderPath = selection?.folder || selection;
  const cplPath = cplSelection?.path || cplSelection;
  const ping = await _sendLegacy({ action: 'ping' });
  const port = ping?.port;
  if (!port) throw new Error('host_unavailable');

  const chk = await _sendLegacy({ action: 'check_ffmpeg' });
  if (chk?.status === 'missing') throw new Error('ffmpeg_missing');

  onStatus?.('Submitting CPL to native host…');
  const _rawOutDir = (typeof localStorage !== 'undefined' && localStorage.getItem('pfx_proxy_output_dir')) || '';
  const _outDir = _rawOutDir ? (_rawOutDir.endsWith('/PROXY') ? _rawOutDir : _rawOutDir.replace(/\/+$/, '') + '/PROXY') : '';
  const res = await _sendLegacy({ action: 'process_imf_cpl',
    folder_path: folderPath, cpl_path: cplPath,
    ...(_outDir ? { out_dir: _outDir } : {}) });
  if (res.status === 'error') throw new Error(res.error || 'process_failed');
  const sid = res.sessionId;

  onStatus?.('Transcoding Rec.709 H.264 proxy…');
  onProgress?.(0);

  const progressUrl = `http://127.0.0.1:${port}/progress/${sid}`;
  const logUrl      = `http://127.0.0.1:${port}/imf_log/${sid}`;
  await new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const r = await _fetchWithTokenRefresh(progressUrl);
        if (r.status === 404) { resolve(); return; }
        if (!r.ok) { reject(new Error('progress_fetch_failed')); return; }
        const data = await r.json();
        if (data.error) {
          let detail = data.error;
          try {
            const logR = await fetch(logUrl, { headers: _tokenHdrs() });
            if (logR.ok) {
              const log = (await logR.text()).trim();
              if (log && log !== 'no log') detail += `\n\nffmpeg log:\n${log}`;
            }
          } catch {}
          reject(new Error(detail)); return;
        }
        onProgress?.(Math.max(0, Math.min(100, data.pct || 0)));
        if (data.done) { resolve(); return; }
        setTimeout(poll, 400);
      } catch (e) { reject(e); }
    };
    poll();
  });

  return {
    sessionId: String(sid || '').trim(),
    videoUrl: `http://127.0.0.1:${port}/stream/${sid}`,
    doviUrl:  `http://127.0.0.1:${port}/imf_dovi/${sid}`,
    logUrl:   `http://127.0.0.1:${port}/imf_log/${sid}`,
    audioMode: 'unknown',
    audioMessage: '',
    immersiveAudio: null,
  };
}
