'use strict';

// Guard: session.registerPreloadScript({ type: 'frame' }) runs this script for
// every frame (main + subframes). webPreferences.preload also runs it for the
// main frame — so without this guard, preload runs twice on the main frame.
// The second run throws on contextBridge.exposeInMainWorld (key already exists),
// which in Electron 42 crashes the renderer with exitCode 11.
if (global.__pfxPreloadDone) return; // eslint-disable-line no-undef
global.__pfxPreloadDone = true; // eslint-disable-line no-undef

/**
 * preload.js — Injects window.__pfxChrome so that electron_shim.js
 * (already in index.html) merges it into window.chrome.
 *
 * This gives the existing PostFlowX JS full chrome.* API access
 * without changing any application code.
 *
 * All operations that need Node.js (file I/O, dialogs, etc.) go through
 * ipcRenderer.invoke so they run in the main process, never the renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');
const path = require('path');

// App root points to the built renderer tree so chrome.runtime.getURL resolves
// extension-relative paths (tools/, assets/, etc.) to actual renderer files.
const APP_ROOT = path.join(__dirname, '..', 'dist', 'desktop');

// ── Helpers ─────────────────────────────────────────────────────────────────

function invoke(channel, args) {
  return ipcRenderer.invoke(channel, args || {});
}

// Convert a relative extension path to an absolute file:// URL.
// Files in assets/ are extraResources (outside the asar) → use process.resourcesPath.
// Everything else (tools/, etc.) is bundled inside the asar dist/desktop tree.
function getURL(relativePath) {
  const clean = relativePath.replace(/^\/+/, '');
  const base = clean.startsWith('assets/')
    ? process.resourcesPath
    : APP_ROOT;
  const abs = path.join(base, clean);
  return 'file://' + abs.replace(/\\/g, '/').replace(/ /g, '%20');
}

// ── Storage shim — wraps chrome.storage.local ────────────────────────────────
// Every method returns a Promise AND calls the optional callback.
// This satisfies both chrome.storage.local.get(key, cb) and await chrome.storage.local.get(key).

const storageLocal = {
  get(keys, callback) {
    const p = invoke('pfx:storage:get', { keys }).catch(() => ({}));
    if (callback) p.then(callback);
    return p;
  },
  set(obj, callback) {
    const p = invoke('pfx:storage:set', { obj }).catch(() => {});
    if (callback) p.then(() => callback());
    return p;
  },
  remove(keys, callback) {
    const p = invoke('pfx:storage:remove', { keys }).catch(() => {});
    if (callback) p.then(() => callback());
    return p;
  },
  clear(callback) {
    const p = invoke('pfx:storage:clear').catch(() => {});
    if (callback) p.then(() => callback());
    return p;
  },
};

// ── Message routing — chrome.runtime.sendMessage shim ───────────────────────

// Registered listeners for messages pushed from main process
const _runtimeListeners = new Set();

ipcRenderer.on('pfx:fromMain', (_event, msg) => {
  for (const fn of _runtimeListeners) {
    try { fn(msg, null, () => {}); } catch (e) { console.warn('[preload] listener error', e); }
  }
});

function sendMessage(message, callbackOrOptions, maybeCallback) {
  // Signatures: sendMessage(msg, cb) or sendMessage(msg, options, cb)
  const callback = typeof callbackOrOptions === 'function'
    ? callbackOrOptions
    : (typeof maybeCallback === 'function' ? maybeCallback : null);

  const type    = message?.type || '';
  const payload = message?.payload || message;
  const timeout = message?.timeoutMs || 20000;

  let promise;

  if (type === 'IMF_COMPANION_CALL') {
    promise = invoke('pfx:companion', { payload: message.payload, timeoutMs: timeout });
  } else if (type === 'COMPANION_CHECK') {
    promise = invoke('pfx:companionStatus').then((s) => ({
      ok: s.ready,
      features: s.features || null,
      diagError: s.ready ? null : 'Companion not running',
    }));
  } else if (type === 'GET_PROFILE') {
    // Auth stub — desktop app doesn't use Chrome identity
    promise = Promise.resolve({ ok: false, user: null });
  } else if (type === 'SIGN_IN_CHROME') {
    promise = Promise.resolve({ ok: false, reason: 'desktop' });
  } else if (type === 'USAGE_PING' || type === 'USAGE_EVENT' || type === 'USAGE_CFG_SET') {
    // Analytics — silently ignore
    promise = Promise.resolve({});
  } else if (type === 'OPEN_TAB' || type === 'COMPANION_HTTP_START') {
    promise = invoke('pfx:companion', { payload, timeoutMs: timeout });
  } else if (type === 'PRORES_GET_HTTP_PORT') {
    // proResProxy.js uses this to get the companion's HTTP port + auth token.
    // The companion dispatches on 'action', not 'type', so forward as a ping.
    promise = invoke('pfx:companion', {
      payload: { action: 'ping' },
      timeoutMs: timeout,
    }).then((r) => {
      const data = r?.response?.data || {};
      return { port: data.port ?? 47125, token: data.httpToken ?? null };
    }).catch(() => ({ port: null, token: null }));
  } else {
    // Forward unknown messages to companion as generic action calls
    promise = invoke('pfx:companion', { payload: message, timeoutMs: timeout });
  }

  // Store last error so code checking chrome.runtime.lastError works
  _lastError = null;

  // MV3 semantics: when no callback is given, sendMessage must RETURN A PROMISE
  // that resolves with the response. The old shim returned undefined and only
  // delivered via the callback, so every `await chrome.runtime.sendMessage(...)`
  // caller (e.g. vfxPull's OCF preview tiers) got `undefined` and threw a bare
  // "Companion error" — the companion's real response was silently discarded.
  // On transport failure we RESOLVE with a structured {ok:false,error} (rather
  // than rejecting) so await-callers that test `bridged?.ok` see the real reason.
  return promise.then((result) => {
    _lastError = null;
    if (callback) callback(result);
    return result;
  }).catch((err) => {
    _lastError = { message: err.message || String(err) };
    if (callback) callback(undefined);
    return { ok: false, error: { code: err?.code || 'BRIDGE_ERROR', message: err?.message || String(err) } };
  });
}

let _lastError = null;

// ── chrome.downloads shim ────────────────────────────────────────────────────

const downloads = {
  download({ url, filename, saveAs }, callback) {
    invoke('pfx:download', { url, filename, saveAs })
      .then((r) => {
        if (callback) callback(r?.ok ? 1 : null);
      })
      .catch(() => {
        // Swallow IPC failures — surface as a failed download to the callback
        // rather than an unhandled promise rejection.
        if (callback) callback(null);
      });
  },
};

// ── chrome.tabs shim ─────────────────────────────────────────────────────────

const tabs = {
  create({ url }) {
    invoke('pfx:openExternal', { url });
    return Promise.resolve({ id: -1 });
  },
  query() { return Promise.resolve([]); },
  update() { return Promise.resolve(null); },
  get() { return Promise.resolve(null); },
};

// ── Assemble __pfxChrome ─────────────────────────────────────────────────────

const __pfxChrome = {
  runtime: {
    getURL,
    sendMessage,
    lastError: null,   // dynamically updated via getter below
    getManifest() {
      // Synchronous — return cached value set during preload init
      return window.__pfxManifest || { name: 'PostFlowX', version: '2026.6.1' };
    },
    id: 'postflowx-desktop',
    onMessage: {
      addListener(fn) { _runtimeListeners.add(fn); },
      removeListener(fn) { _runtimeListeners.delete(fn); },
      hasListener(fn) { return _runtimeListeners.has(fn); },
    },
    connectNative() {
      // Not used in desktop mode — return a no-op port
      return {
        postMessage() {},
        disconnect() {},
        onMessage: { addListener() {}, removeListener() {} },
        onDisconnect: { addListener(fn) { setTimeout(fn, 0); } },
      };
    },
    getPlatformInfo(cb) {
      cb({ os: 'mac', arch: 'x86-64' });
    },
  },
  storage: {
    local: storageLocal,
    sync: storageLocal, // sync → local for desktop
    session: {
      get(keys, cb) { if (cb) cb({}); return Promise.resolve({}); },
      set(_o, cb) { if (cb) cb(); return Promise.resolve(); },
    },
  },
  downloads,
  tabs,
  identity: {
    getProfileUserInfo(detailsOrCb, maybeCb) {
      const cb = typeof detailsOrCb === 'function' ? detailsOrCb : maybeCb;
      if (cb) cb(_googleProfile ? { email: _googleProfile.email, id: _googleProfile.email } : { email: '', id: '' });
    },
    getAuthToken(_opts, cb) { if (cb) cb(_googleProfile?.accessToken || null); },
  },
  notifications: {
    create() {},
    clear() {},
  },
  alarms: {
    create() {},
    clear() {},
    onAlarm: { addListener() {} },
  },
  action: {
    onClicked: { addListener() {} },
    setIcon() {},
    setBadgeText() {},
  },
  system: {
    cpu: {
      getInfo(cb) { cb({ numOfProcessors: navigator.hardwareConcurrency || 4 }); },
    },
    memory: {
      getInfo(cb) { cb({ capacity: 8 * 1024 * 1024 * 1024, availableCapacity: 4 * 1024 * 1024 * 1024 }); },
    },
  },
  scripting: {
    executeScript() { return Promise.resolve([]); },
  },
  offscreen: {
    createDocument() { return Promise.resolve(); },
    closeDocument() { return Promise.resolve(); },
    hasDocument() { return Promise.resolve(false); },
  },
};

// Make runtime.lastError a live getter so code reading it after sendMessage works
Object.defineProperty(__pfxChrome.runtime, 'lastError', {
  get() { return _lastError; },
  set(v) { _lastError = v; },
  enumerable: true,
  configurable: true,
});

// ── Expose to renderer ───────────────────────────────────────────────────────

// Signal to boot-guard.js and other scripts that we're running in Electron.
// boot-guard.js checks window.__PFX_IS_ELECTRON to bypass remote auth.
contextBridge.exposeInMainWorld('__PFX_IS_ELECTRON', true);

// Expose __PFX_TARGET__ via contextBridge so boot-guard.js and ui.js get it
// reliably. The inline <script> injected by build-renderer.js is blocked by CSP
// (no 'unsafe-inline' in script-src), so this is the authoritative source.
contextBridge.exposeInMainWorld('__PFX_TARGET__', 'desktop');

contextBridge.exposeInMainWorld('__pfxChrome', __pfxChrome);

// pfxPlatform: a cleaner native API for new code that doesn't need chrome shim
const _osUser = (() => { try { const os = require('os'); const u = os.userInfo(); return { username: u.username || '' }; } catch { return { username: '' }; } })();

// Cached Google OAuth profile — set after successful sign-in via googleSignIn()
let _googleProfile = null;

contextBridge.exposeInMainWorld('pfxPlatform', {
  isMacApp:    true,
  isExtension: false,
  osUser:      _osUser,

  // Synchronous boolean — set at preload time (from additionalArguments in main.js)
  // so boot-guard can read window.pfxPlatform.devBypass without any IPC.
  // true only when !app.isPackaged AND devAuthBypass is enabled in config/env.
  devBypass: process.argv.includes('--pfx-dev-bypass'),

  // Returns { configured: bool } — whether a Google OAuth client ID is set.
  isGoogleAuthConfigured: () => invoke('pfx:is-google-auth-configured'),
  // Returns { configured, source, clientIdPreview, isPackaged, devBypassEnabled } — safe debug info.
  googleAuthDebug: () => invoke('pfx:google-auth-debug'),
  // Dev-only sign-in bypass. Returns { ok, email, name, ... } or { ok: false, error } in production.
  devAuthBypass: () => invoke('pfx:dev-auth-bypass'),

  // Opens Google sign-in in the system browser, returns { ok, email, name, picture, accessToken }
  googleSignIn: async (clientId) => {
    const result = await invoke('pfx:google-oauth', { clientId: clientId || '' });
    if (result?.ok) {
      _googleProfile = { email: result.email, name: result.name, picture: result.picture, accessToken: result.accessToken };
    }
    return result;
  },

  pickFile:    (opts)  => invoke('pfx:pickFile',   { options: opts }),
  pickFiles:   (opts)  => invoke('pfx:pickFiles',  { options: opts }),
  pickFolder:  (opts)  => invoke('pfx:pickFolder', { options: opts }),
  saveFile:    (args)  => invoke('pfx:saveFile',   args),
  readFile:    (args)  => invoke('pfx:readFile',   args),
  writeFile:   (args)  => invoke('pfx:writeFile',  args),         // silent write to a path (no dialog)
  listProjects: (dirPath) => invoke('pfx:listProjects', { dirPath }),
  deleteProject: (args) => invoke('pfx:deleteProject', args),    // move project to Trash
  renameProject:    (args) => invoke('pfx:renameProject', args),
  duplicateProject: (args) => invoke('pfx:duplicateProject', args),
  fileExists:  (fp)    => invoke('pfx:fileExists', { filePath: fp }),
  revealInFinder: (fp) => invoke('pfx:revealInFinder', { filePath: fp }),
  openExternal:     (url) => invoke('pfx:openExternal',     { url }),
  openExternalSafe: (url) => invoke('pfx:openExternalSafe', { url }),

  // Route through the native command router (pfx:native-command).
  // Accepts either { type, payload } (new API) or legacy { action, ... } companion payloads.
  sendNativeCommand: async (payload, timeoutMs) => {
    const type = payload?.type || payload?.action;
    const args = payload?.payload ?? payload;

    // New structured commands with explicit type go to native router.
    if (type && typeof type === 'string') {
      const r = await invoke('pfx:native-command', { type, payload: args, timeoutMs });
      if (!r?.ok) {
        const e = r?.error || {};
        const err = new Error(e.message || 'native-command failed');
        err.code = e.code || '';
        throw err;
      }
      return r.result;
    }

    // Legacy fallback: forward raw payload to companion (old callers).
    return invoke('pfx:companion', { payload, timeoutMs });
  },

  getAppInfo: () => invoke('pfx:getAppInfo'),
  // Python companion process health → { ready, features }. Used by status panels.
  companionStatus: () => invoke('pfx:companionStatus'),
  getURL,

  // Return the native filesystem path for a File object dropped or picked in the
  // renderer.  Synchronous on Electron 32+ via webUtils.getPathForFile().
  getNativeFilePath(file) {
    try {
      const { webUtils } = require('electron');
      return webUtils.getPathForFile(file) || null;
    } catch { return null; }
  },

  // ── Native Media Engine ────────────────────────────────────────────────────
  // AVFoundation-backed media operations for the macOS app.
  // All methods return Promises that resolve to { ok, result } or throw on error.
  //
  // QT Ref player (H.264 / HEVC / ProRes):
  //   openPlayer({ path, role: "qtRef" }) → { playerId, info, srcUrl, requiresTranscode }
  //     srcUrl is a pfx-media:// URL ready for <video src=...> when requiresTranscode is false.
  //     When requiresTranscode is true (ProRes) the caller should use the HTTP streaming server.
  //
  // OCF still preview (3-tier: Resolve → AVFoundation → FFmpeg):
  //   getOcfStill({ ocfPath, sourceTc, sourceFrame, outputWidth, colorPreviewMode })
  //     → { ok, decoder, imageDataUrl, frame, ... }
  //
  // Hero frames (7-point per shot):
  //   getHeroFrames({ playerId|path, frames, outputWidth })
  //     → { ok, frames: [{ ok, label, frame, dataUrl, decoder }], decoder }

  media: {
    _call(type, payload, timeoutMs) {
      return invoke('pfx:media', { type, payload, timeoutMs }).then((r) => {
        if (!r?.ok) {
          const e = r?.error || {};
          const err = new Error(e.message || 'media engine error');
          err.code = e.code || 'MEDIA_ENGINE_ERROR';
          throw err;
        }
        return r.result;
      });
    },

    openPlayer(payload)      { return this._call('media.open',          payload, 15000); },
    closePlayer(payload)     { return this._call('media.close',         payload,  5000); },
    play(payload)            { return this._call('media.play',          payload,  5000); },
    pause(payload)           { return this._call('media.pause',         payload,  5000); },
    seek(payload)            { return this._call('media.seek',          payload,  5000); },
    stepFrame(payload)       { return this._call('media.stepFrame',     payload,  5000); },
    getInfo(payload)         { return this._call('media.getInfo',       payload, 15000); },
    getStill(payload)        { return this._call('media.getStill',      payload, 30000); },
    getHeroFrames(payload)   { return this._call('media.getHeroFrames', payload,120000); },
    getOcfStill(payload)     { return this._call('media.getOcfStill',   payload, 90000); },
    diagnostics()            { return this._call('media.diagnostics',   {},      10000); },
    ffprobeInfo(payload)     { return this._call('media.ffprobeInfo',   payload, 15000); },

    // Build a pfx-media:// URL for a local file (H.264/HEVC/MOV).
    // ProRes files must use the HTTP streaming server instead.
    srcUrl(filePath) {
      if (!filePath) return null;
      return `pfx-media://localfile/${encodeURIComponent(filePath)}`;
    },
  },

  // ── PFXNativeMediaEngine — persistent HW-accelerated media service ─────────
  // All commands proxy over HTTP to the Swift engine running at localhost:<port>.
  //
  //   nativeEngine.command(type, payload, timeoutMs)
  //     → resolves to the engine's "data" field, or rejects on error
  //
  // Convenience: nativeEngine.isReady (bool) lets the renderer skip calls when
  // the binary wasn't found or failed to start.
  //
  // Key commands:
  //   media.open({ path })              → { sessionId, fps, duration, codec, needsProxy, … }
  //   media.close({ sessionId })        → { ok }
  //   media.probe({ path })             → MediaInfo
  //   frame.extract({ sessionId, frame, outputWidth, quality })
  //                                     → { dataUrl, imageDataUrl, decoder, hwDecode }
  //   thumbnail.generate({ sessionId, count, outputWidth, outputDir })
  //                                     → { thumbnails: [{frame, dataUrl, diskPath}] }
  //   waveform.generate({ sessionId, buckets, channel })
  //                                     → { waveform: [{min, max, rms}] }
  //   proxy.create({ sessionId, outputDir, width, quality })
  //                                     → { jobId }
  //   proxy.status({ jobId })           → { status, progress, outputPath }
  //   render.createJob({ inputPath, outputPath, ranges, fps })
  //                                     → { jobId }
  //   render.getStatus({ jobId })       → { status, progress, logLines }
  //   engine.diagnostics()              → full diagnostics object

  nativeEngine: {
    get isReady() { return true; }, // IPC handler returns ENGINE_NOT_READY if binary not started

    _call(type, payload, timeoutMs) {
      return invoke('pfx:nativeEngine', { type, payload, timeoutMs }).then((r) => {
        if (!r?.ok) {
          const e = r?.error || {};
          const err = new Error(e.message || 'nativeEngine error');
          err.code = e.code || 'NATIVE_ENGINE_ERROR';
          throw err;
        }
        return r.result;
      });
    },

    command(type, payload = {}, timeoutMs = 60000) {
      return this._call(type, payload, timeoutMs);
    },

    // Session
    open(path, timeoutMs = 30000)  { return this._call('media.open',  { path }, timeoutMs); },
    close(sessionId)               { return this._call('media.close',  { sessionId }, 5000); },
    probe(path)                    { return this._call('media.probe',  { path }, 20000); },

    // Frame extraction — replaces per-process avf_bridge getStill (~100ms → ~5ms)
    frameExtract(sessionId, frame, outputWidth, quality) {
      return this._call('frame.extract', { sessionId, frame, outputWidth, quality }, 15000);
    },

    // Thumbnails
    thumbnailGenerate(sessionId, opts = {}) {
      return this._call('thumbnail.generate', { sessionId, ...opts }, 120000);
    },

    // Waveform
    waveformGenerate(sessionId, buckets = 1000, channel = 0) {
      return this._call('waveform.generate', { sessionId, buckets, channel }, 120000);
    },

    // Proxy
    proxyCreate(sessionId, opts = {}) { return this._call('proxy.create', { sessionId, ...opts }); },
    proxyStatus(jobId)                { return this._call('proxy.status', { jobId }); },
    proxyCancel(jobId)                { return this._call('proxy.cancel', { jobId }); },

    // Render jobs
    renderCreate(inputPath, outputPath, ranges, fps) {
      return this._call('render.createJob', { inputPath, outputPath, ranges, fps }, 10000);
    },
    renderPause(jobId)   { return this._call('render.pauseJob',  { jobId }); },
    renderCancel(jobId)  { return this._call('render.cancelJob', { jobId }); },
    renderStatus(jobId)  { return this._call('render.getStatus', { jobId }); },

    // Diagnostics
    diagnostics()        { return this._call('engine.diagnostics', {}, 10000); },

    // Playback state tracking
    play(sessionId)                  { return this._call('playback.play',     { sessionId }); },
    pause(sessionId)                 { return this._call('playback.pause',    { sessionId }); },
    seek(sessionId, frame)           { return this._call('playback.seek',     { sessionId, frame }); },
    setRate(sessionId, rate)         { return this._call('playback.setRate',  { sessionId, rate }); },
    setRange(sessionId, i, o)        { return this._call('playback.setRange', { sessionId, inPoint: i, outPoint: o }); },
  },

  // ── IMF Frame Provider ─────────────────────────────────────────────────────
  // Main-process frame decode service for IMF MXF files.
  // Falls back to FFmpeg (Backend C) when renderer-side J2K/HTJ2K decode fails.
  //
  // preparePackage(folderPath)
  //   Scan an IMF package folder and build an asset/CPL index.
  //   Returns { ok, packageId, index: { packageHash, folderPath, cpls, activeCpl, reels } }
  //
  // requestFrame({ mxfPath, mxfFrame, packageHash, cplId, displayMode })
  //   Decode one frame from an MXF file.
  //   mxfFrame = CPL entryPoint + reelLocalFrame (absolute MXF frame index).
  //   Returns { ok, imageDataUrl?, frameInfo, error?, code?, attemptedBackends[] }
  //
  // clearCache(packageHash?)
  //   Remove cached preview frames for a package (or all packages if omitted).
  //
  // diagnostics()
  //   Returns { ffmpegAvailable, cacheDir, cacheSizeBytes, packageCount }

  imf: {
    preparePackage(folderPath) {
      return invoke('pfx:imf:prepare', { folderPath });
    },
    requestFrame(args) {
      return invoke('pfx:imf:requestFrame', args);
    },
    // Extract synchronised PCM audio from a reel's MXF essence for IMF playback.
    // args: { mxfPath, tcOffset, sampleRate, channels, maxSeconds }
    // Returns: { ok, pcm: { left: Float32Array, right: Float32Array, sampleRate } }
    //          or { ok:false } when the MXF carries no audio track.
    extractAudio(args) {
      return invoke('pfx:imf:extractAudio', args);
    },
    // Stream-hash a file via native node crypto (handles files >2 GB).
    // args: { filePath, algorithm: 'sha1' | 'sha256' } → { ok, algorithm, hashBase64 }
    hashFile(args) {
      return invoke('pfx:imf:hashFile', args);
    },
    // Sample reel at 5/15/30/50/70% and return first non-black/slate frame.
    // args: { mxfPath, totalFrames, entryPoint, packageHash, cplId, displayMode }
    // Returns: { ok, frame (reel-relative), mxfFrame, imageDataUrl?, lumaClass, frameInfo }
    posterFrame(args) {
      return invoke('pfx:imf:posterFrame', args);
    },
    // Persist a renderer-decoded frame to the main-process disk cache.
    // Subsequent requestFrame calls for the same frame return from cache instantly.
    // args: { packageHash, cplId, mxfFrame, displayMode, imageDataUrl }
    // Fire-and-forget is safe — returns { ok, imagePath? } but caller can ignore result.
    cacheFrame(args) {
      return invoke('pfx:imf:cacheFrame', args);
    },
    reelList({ packageHash, cplId } = {}) {
      return invoke('pfx:imf:reelList', { packageHash, cplId });
    },
    // Return { ok, cplPath, assetMapPaths[] } for the given package/CPL.
    // Used to feed the IMF demuxer decode path (-f imf -assetmaps ...).
    cplInfo({ packageHash, cplId } = {}) {
      return invoke('pfx:imf:cplInfo', { packageHash, cplId });
    },
    // Decode a frame via the FFmpeg IMF demuxer.
    // args: { cplPath, assetMaps[], frameNumber, scale, packageHash, cplId, displayMode }
    // Returns: { ok, imagePath?, imageDataUrl?, codec?, backend?, imfDemuxerOK, stderr?, errors[], log[] }
    decodeFrame(args) {
      return invoke('pfx:imf:decodeFrame', args);
    },
    clearCache(packageHash) {
      return invoke('pfx:imf:clearCache', { packageHash });
    },
    diagnostics() {
      return invoke('pfx:imf:diagnostics');
    },
    // Run Photon IMF validator against a package folder.
    // Returns { ok, results[], summary, rawOutput, error? }
    runPhoton(packagePath) {
      return invoke('pfx:imf:runPhoton', { packagePath });
    },
    // Check open-source IMF engine availability (Photon, FFmpeg IMF, OpenJPEG, OpenJPH, imscJS, ASDCPlib).
    // Returns { engines: [{ id, label, status: 'ready'|'partial'|'missing', detail }] }
    engineStatus() {
      return invoke('pfx:imf:engineStatus');
    },
    // Direct decode test: run ffmpeg -f imf -assetmaps ... -i CPL.xml -frames:v 1 output.png
    // Returns { ok, command, outputPng, fileExists, codec, probe, stderr, log[], errors[] }
    decodeTestFrame(args) {
      return invoke('pfx:imf:decodeTestFrame', args);
    },
    loadPackage(folderPath) {
      return invoke('pfx:imf:loadPackage', { folderPath });
    },
    listFolder(folderPath) {
      return invoke('pfx:imf:listFolder', { folderPath });
    },
  },

  // ── Smart Media Playback Engine ───────────────────────────────────────────
  // Unified client for the Python companion Smart Playback Engine.
  // All methods return promises that resolve to the companion response object.
  //
  // probe({ path, context?, timelineFps?, timecodeBase? })
  //   → full classification: { ok, kind, codec, fps, recommendedEngine, … }
  //
  // selectEngine({ container, codec, … })
  //   → { ok, engine, fallbacks, reason }
  //
  // decodeFrame({ path, frameNumber, fps, scale?, outputFormat?, sequenceInfo? })
  //   → { ok, imagePath, frameNumber, engine, command, stderr }
  //
  // status()  → { ok, engines: [{ id, label, status, detail }] }
  // showLogs(payload?)  → { ok, logs: { playback, imf, proxy, resolve } }
  //
  // transcodeProxy({ sourcePath, outputDir, sessionId, … })
  //   → { ok, sessionId } (async, poll companion session for progress)
  //
  // imfOpen({ folderPath })  → { ok, folder, cplList, playableReels, … }
  // imfProbeCpl({ cplPath, assetMapPaths })  → { ok, streams, format, … }
  // imfDecodeTestFrame({ cplPath, assetMapPaths, frameNumber, scale })
  //   → { ok, imagePath, imageDataUrl?, … }
  //
  // resolveStatus()  → { ok, available, version }

  smartMedia: {
    _call(type, payload, timeoutMs) {
      return invoke('pfx:smartMedia', { type, payload: payload || {}, timeoutMs }).then((r) => {
        if (!r?.ok) {
          const e = r?.error || {};
          const err = new Error(e.message || 'smart media error');
          err.code = e.code || 'SMART_MEDIA_ERROR';
          throw err;
        }
        return r.result;
      });
    },

    probe(payload)              { return this._call('smartMedia.probe',              payload, 30000); },
    selectEngine(payload)       { return this._call('smartMedia.selectEngine',       payload, 10000); },
    decodeFrame(payload)        { return this._call('smartMedia.decodeFrame',        payload,120000); },
    status()                    { return this._call('smartMedia.status',             {},      15000); },
    showLogs(payload)           { return this._call('smartMedia.showLogs',           payload, 10000); },
    transcodeProxy(payload)     { return this._call('smartMedia.transcodeProxy',     payload,300000); },
    imfOpen(payload)            { return this._call('smartMedia.imf.open',           payload, 20000); },
    imfProbeCpl(payload)        { return this._call('smartMedia.imf.probeCpl',       payload, 90000); },
    imfDecodeTestFrame(payload) { return this._call('smartMedia.imf.decodeTestFrame',payload,120000); },
    resolveStatus()             { return this._call('smartMedia.resolve.status',     {},      15000); },
  },

  // ── IMF Direct Playback Engine ───────────────────────────────────────────
  imfEngine: {
    openPackage(path) {
      return invoke('pfx:imf-engine', { command: 'openPackage', payload: { path } });
    },
    validatePackage(packageId, cplId) {
      return invoke('pfx:imf-engine', { command: 'validatePackage', payload: { packageId, cplId } });
    },
    startPlayback(packageId, cplId, opts) {
      return invoke('pfx:imf-engine', { command: 'startPlayback', payload: { packageId, cplId, opts } });
    },
    controlPlayback(sessionId, command, value) {
      return invoke('pfx:imf-engine', { command: 'controlPlayback', payload: { sessionId, command, value } });
    },
    stopPlayback(sessionId) {
      return invoke('pfx:imf-engine', { command: 'stopPlayback', payload: { sessionId } });
    },
    getFrame(packageId, cplId, frame, displayMode) {
      return invoke('pfx:imf-engine', { command: 'getFrame', payload: { packageId, cplId, frame, displayMode } });
    },
    getPackageInfo(packageId) {
      return invoke('pfx:imf-engine', { command: 'getPackageInfo', payload: { packageId } });
    },
    listPackages() {
      return invoke('pfx:imf-engine', { command: 'listPackages', payload: {} });
    },
    diagnostics() {
      return invoke('pfx:imf-engine', { command: 'diagnostics', payload: {} });
    },
    // P1-PROGRESS: poll-based cancellable long-pass jobs. The renderer's
    // runImfEngineJob() driver (imf_ui.js) calls startJob(kind, params) →
    // polls jobProgress(jobId) → cancelJob(jobId). Signatures mirror the
    // in-process engine API so imf_player_engine and tests share one shape.
    startJob(kind, params) {
      return invoke('pfx:imf-engine', { command: 'startJob', payload: { kind, params: params || {} } });
    },
    jobProgress(jobId) {
      return invoke('pfx:imf-engine', { command: 'jobProgress', payload: { jobId } });
    },
    cancelJob(jobId) {
      return invoke('pfx:imf-engine', { command: 'cancelJob', payload: { jobId } });
    },
  },
});

// Pre-load manifest so getManifest() works synchronously
invoke('pfx:getManifest').then((m) => {
  window.__pfxManifest = m;
}).catch(() => {});

// Stamp <html> as desktop before any page script runs so CSS platform rules apply immediately.
// Guard against null: preload also runs for subframes (J2K sandbox iframes) where
// document.documentElement may be null during initial frame construction.
if (document.documentElement) {
  document.documentElement.dataset.pfxEnv = 'desktop';
}
