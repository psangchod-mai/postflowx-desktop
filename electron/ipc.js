'use strict';

/**
 * ipc.js — All ipcMain handlers for the PostFlowX Electron app.
 *
 * Channels exposed to the renderer via preload.js:
 *   pfx:storage:get       → { keys }  → object
 *   pfx:storage:set       → { obj }   → void
 *   pfx:storage:remove    → { keys }  → void
 *   pfx:storage:clear     → {}        → void
 *   pfx:pickFile          → { options } → filePath | null
 *   pfx:pickFolder        → { options } → folderPath | null
 *   pfx:saveFile          → { defaultPath, data, encoding } → savedPath | null
 *   pfx:readFile          → { filePath, encoding } → content | null
 *   pfx:revealInFinder    → { filePath } → void
 *   pfx:openExternal      → { url } → void
 *   pfx:companion         → { payload, timeoutMs } → response
 *   pfx:companionStatus   → {} → { ready, features }
 *   pfx:native-command    → { type, payload, timeoutMs } → { ok, result | error }
 *   pfx:media             → { type, payload, timeoutMs } → { ok, result | error }
 *   pfx:getAppInfo        → {} → { version, appPath, userData, platform }
 *   pfx:getManifest       → {} → manifest object
 */

const { ipcMain, dialog, shell, app } = require('electron');
const path = require('path');
const fs   = require('fs');

const storage   = require('./storage');
const companion = require('./companion');

function optionalRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (err) {
    const isMissingSelf =
      err &&
      err.code === 'MODULE_NOT_FOUND' &&
      String(err.message || '').includes(modulePath);
    if (isMissingSelf) {
      console.warn(`[Desktop] Optional native module not found: ${modulePath}`);
      return null;
    }
    throw err;
  }
}

const nativeRouter    = optionalRequire('./native/native_router');
const smartRouter     = optionalRequire('./native/smart_router');
const mediaEngine     = optionalRequire('./native/media_engine');
const nativeEngine    = optionalRequire('./native/pfx_native_engine');
const mpvEngine       = optionalRequire('./native/mpv_engine');
const imfProvider     = optionalRequire('./imf/imf_frame_provider');
const imfDirectEngine = optionalRequire('./imf/imf_direct_engine');
const imfPhoton       = optionalRequire('./imf/imf_photon');
const imfFfmpegBackend = optionalRequire('./imf/imf_ffmpeg_backend');

// ── OCF metadata probe (timecode / UMID / duration) ──────────────────────────
// Camera RAW (Sony X-OCN, ARRIRAW, RED) cannot be DECODED by ffmpeg, but its MXF
// container metadata — start timecode, material-package UMID, duration, fps — IS
// readable via ffprobe format/stream tags. Reading it here lets the matcher link
// by timecode even when the companion/Resolve are unavailable. Best-effort: on any
// failure the file simply keeps name/reel-only matching.
const { spawn: _spawn } = require('child_process');
const _FFPROBE_BIN = (() => {
  for (const p of ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe']) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return 'ffprobe';
})();

function _parseFpsRatio(s) {
  if (!s) return 0;
  const [n, d] = String(s).split('/').map(Number);
  return d > 0 ? n / d : (parseFloat(s) || 0);
}
function _tcAddFrames(tc, frames, fps) {
  const m = /^(\d+):(\d+):(\d+)[:;](\d+)$/.exec(String(tc || ''));
  if (!m || !fps) return '';
  const r = Math.round(fps);
  let f = ((+m[1] * 3600 + +m[2] * 60 + +m[3]) * r + +m[4]) + Math.round(frames);
  if (f < 0) f = 0;
  const ff = f % r; const s = Math.floor(f / r) % 60;
  const mm = Math.floor(f / (r * 60)) % 60; const hh = Math.floor(f / (r * 3600)) % 24;
  const z = n => String(n).padStart(2, '0');
  return `${z(hh)}:${z(mm)}:${z(s)}:${z(ff)}`;
}

// Read MXF/camera metadata for one file. Resolves to {} on any failure.
function _probeOcfMeta(filePath, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet', '-of', 'json',
      '-show_entries',
      'format=duration:format_tags=timecode,material_package_umid,company_name,modification_date:stream=codec_type,r_frame_rate,duration_ts,nb_frames:stream_tags=timecode',
      filePath,
    ];
    let out = '';
    let proc;
    try { proc = _spawn(_FFPROBE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return resolve({}); }
    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve({}); }, timeoutMs);
    proc.stdout.on('data', d => { out += d; });
    proc.on('error', () => { clearTimeout(timer); resolve({}); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const j = JSON.parse(out || '{}');
        const ft = j.format?.tags || {};
        const streams = j.streams || [];
        const v = streams.find(s => s.codec_type === 'video') || streams[0] || {};
        const tcIn = ft.timecode || v.tags?.timecode || streams.find(s => s.tags?.timecode)?.tags?.timecode || '';
        const fps = _parseFpsRatio(v.r_frame_rate);
        const dur = parseFloat(j.format?.duration || v.duration_ts || '0') || 0;
        const frameCount = parseInt(v.nb_frames || '0', 10) || (fps && dur ? Math.round(dur * fps) : 0);
        const umidRaw = ft.material_package_umid || '';
        const umid = umidRaw ? String(umidRaw).replace(/^0x/i, '').toLowerCase() : '';
        const recordDate = (ft.modification_date || '').slice(2, 10).replace(/-/g, ''); // YYYY-MM-DD → YYMMDD
        const tcKnown = !!(tcIn && tcIn !== '00:00:00:00');
        const tcOut = (tcKnown && fps && frameCount) ? _tcAddFrames(tcIn, frameCount - 1, fps) : '';
        resolve({ tcIn: tcIn || undefined, tcOut: tcOut || undefined, fps: fps || undefined,
                  frameCount: frameCount || undefined, umid: umid || undefined,
                  recordDate: recordDate || undefined, tcKnown });
      } catch { resolve({}); }
    });
  });
}

// Probe an array of {path,...} files with bounded concurrency; merges metadata in place.
async function _enrichOcfMeta(files, concurrency = 4) {
  let i = 0;
  const worker = async () => {
    while (i < files.length) {
      const idx = i++;
      const meta = await _probeOcfMeta(files[idx].path).catch(() => ({}));
      Object.assign(files[idx], meta);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length || 1) }, worker));
  return files;
}

let _manifest = null;

function _loadManifest(appRoot) {
  if (_manifest) return _manifest;
  try {
    _manifest = JSON.parse(fs.readFileSync(path.join(appRoot, 'extension', 'manifest.json'), 'utf8'));
  } catch { _manifest = { name: 'PostFlowX', version: app.getVersion() }; }
  return _manifest;
}

function register(mainWindow, appRoot) {
  const manifest = _loadManifest(appRoot);

  // Wire native router to companion so Resolve actions can proxy through it.
  if (nativeRouter) {
    nativeRouter.init(companion);
    nativeRouter.ensureAppDirs();
  } else {
    console.warn('[Desktop] native_router disabled; native routes unavailable.');
  }

  // Wire smart router to companion HTTP port + token.
  // The companion returns port + httpToken in its 'ping' response once ready.
  if (smartRouter) {
    smartRouter.init(47125, '');  // sane defaults; will be updated on companion ready
    companion.on('ready', async () => {
      try {
        const resp = await companion.call({ action: 'ping' }, 5000);
        const data = resp?.data || {};
        if (data.port)      smartRouter.init(data.port, data.httpToken || '');
      } catch {
        // Leave defaults in place — smart router will still attempt port 47125
      }
    });
  }

  // Wire media engine to companion for OCF Resolve tier.
  if (mediaEngine) mediaEngine.init(companion);

  // Wire IMF provider to media engine so Backend A (Resolve/AVFoundation) is available.
  if (imfProvider && mediaEngine) imfProvider.init(mediaEngine);

  // ── Storage ──────────────────────────────────────────────────────────────

  ipcMain.handle('pfx:storage:get', (_e, { keys }) => storage.get(keys));
  ipcMain.handle('pfx:storage:set', (_e, { obj }) => { storage.set(obj); });
  ipcMain.handle('pfx:storage:remove', (_e, { keys }) => { storage.remove(keys); });
  ipcMain.handle('pfx:storage:clear', () => { storage.clear(); });

  // ── File pickers ─────────────────────────────────────────────────────────

  ipcMain.handle('pfx:pickFile', async (_e, { options = {} } = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      title: options.title || 'Select File',
      filters: options.filters || [],
      defaultPath: options.defaultPath,
    });
    return canceled ? null : (filePaths[0] || null);
  });

  ipcMain.handle('pfx:pickFiles', async (_e, { options = {} } = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: options.title || 'Select Files',
      filters: options.filters || [],
      defaultPath: options.defaultPath,
    });
    return canceled ? [] : filePaths;
  });

  ipcMain.handle('pfx:pickFolder', async (_e, { options = {} } = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: options.title || 'Select Folder',
      defaultPath: options.defaultPath,
    });
    return canceled ? null : (filePaths[0] || null);
  });

  ipcMain.handle('pfx:saveFile', async (_e, { defaultPath, data, encoding = 'utf8' } = {}) => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      defaultPath,
      properties: ['createDirectory'],
    });
    if (canceled || !filePath) return null;
    try {
      if (encoding === 'base64') {
        fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
      } else if (data instanceof Uint8Array || Buffer.isBuffer(data)) {
        fs.writeFileSync(filePath, data);
      } else {
        fs.writeFileSync(filePath, data, encoding);
      }
      return filePath;
    } catch (e) {
      console.error('[IPC] saveFile error:', e.message);
      return null;
    }
  });

  ipcMain.handle('pfx:readFile', async (_e, { filePath, encoding = 'utf8' } = {}) => {
    try {
      if (encoding === 'base64') {
        return fs.readFileSync(filePath).toString('base64');
      }
      return fs.readFileSync(filePath, encoding);
    } catch (e) {
      console.error('[IPC] readFile error:', e.message);
      return null;
    }
  });

  ipcMain.handle('pfx:fileExists', (_e, { filePath }) => {
    try { return fs.existsSync(filePath); } catch { return false; }
  });

  // ── Shell ────────────────────────────────────────────────────────────────

  ipcMain.handle('pfx:revealInFinder', (_e, { filePath }) => {
    if (filePath) shell.showItemInFolder(filePath);
  });

  ipcMain.handle('pfx:openExternal', (_e, { url }) => {
    if (url && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url);
    }
  });

  ipcMain.handle('pfx:openExternalSafe', async (_e, { url } = {}) => {
    const ALLOWED = [
      'https://sites.google.com/netflix.com/postflowx/home',
    ];
    if (!url || !ALLOWED.includes(url)) throw new Error('URL not allowed');
    await shell.openExternal(url);
    return { ok: true };
  });

  // ── Companion ────────────────────────────────────────────────────────────

  ipcMain.handle('pfx:companion', async (_e, { payload, timeoutMs = 20000 } = {}) => {
    if (!companion.isReady) {
      return {
        ok: false,
        error: {
          code: 'COMPANION_UNAVAILABLE',
          message: 'Native companion is not running.',
          userMessage: 'The PostFlowX native helper is not available. Some features require Python 3.10+ to be installed.',
        },
      };
    }
    try {
      const resp = await companion.call(payload, timeoutMs);
      return { ok: true, response: resp };
    } catch (err) {
      return { ok: false, error: { code: 'COMPANION_ERROR', message: err.message } };
    }
  });

  ipcMain.handle('pfx:companionStatus', () => ({
    ready: companion.isReady,
    // Desktop app always has native playback via pfxPlatform.media (AVFoundation)
    features: { nativePlayback: true, thumbnailGrab: true },
  }));

  // ── Native command router (pfxPlatform.sendNativeCommand) ────────────────
  // Handles: helper.*, app.*, file.*, folder.*, media.*, resolve.*

  ipcMain.handle('pfx:native-command', async (_e, { type, payload = {}, timeoutMs = 30000 } = {}) => {
    if (!type) return { ok: false, error: { code: 'BAD_REQUEST', message: 'type is required' } };

    // ── Media runtime bridge ──────────────────────────────────────────────────
    // native_helper_client.js sharedMediaOpen() / nativeOpenFile() call these
    // via sendNativeCommand → pfx:native-command.  Route them to media_engine so
    // ProRes on macOS gets a pfx-media:// srcUrl (canPlay=true) instead of null.

    if (type === 'ping') {
      return { ok: true, result: { ok: true, ready: true, httpToken: null } };
    }

    if (type === 'mediaOpenFile' || type === 'openFile') {
      const filePath = payload?.path;
      if (!filePath) return { ok: false, error: { code: 'BAD_REQUEST', message: 'path required' } };
      if (!mediaEngine) return { ok: false, error: { code: 'ENGINE_UNAVAILABLE', message: 'Media engine not loaded' } };
      try {
        const r = await mediaEngine.route({ type: 'media.open', payload: { path: filePath } });
        const info = r.info || {};
        return {
          ok: true,
          result: {
            sessionId:     r.playerId,
            assetId:       r.playerId,
            canPlay:       !r.requiresTranscode,
            streamUrl:     r.srcUrl || null,
            codec:         info.codec         || '',
            fps:           info.fps           || null,
            startTimecode: info.startTimecode || null,
            width:         info.width         || null,
            height:        info.height        || null,
            backend:       'avf',
          },
        };
      } catch (err) {
        return { ok: false, error: { code: 'MEDIA_OPEN_ERROR', message: err.message } };
      }
    }

    // ── OCF folder picker ─────────────────────────────────────────────────────
    // nativePickOcfFolder() in native_helper_client.js sends 'ocfPickFolder'.
    // Show a native directory picker and return { path } so _nativePayload()
    // unwraps correctly in vfxPullPanel.js _chooseAndRelinkOcf().
    if (type === 'ocfPickFolder') {
      try {
        const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
          properties: ['openDirectory', 'createDirectory'],
          title: payload?.title || 'Select OCF Root Folder',
          defaultPath: payload?.defaultPath,
        });
        if (canceled || !filePaths[0]) return { ok: true, result: null };
        return { ok: true, result: { path: filePaths[0], folderPath: filePaths[0] } };
      } catch (err) {
        return { ok: false, error: { code: 'DIALOG_ERROR', message: err.message } };
      }
    }

    // ── OCF folder probe ──────────────────────────────────────────────────────
    // nativeProbeOcfFolder(folderPath) sends 'ocfProbeFolder'.
    // Walk the directory tree and collect camera files with basic metadata.
    // Returns an array of { name, path, ext, reel, reelShort } objects so that
    // smartOcfMatcher.matchAllEvents() can do name/reel-based matching even
    // when the Python companion is unavailable (no ffprobe TC extraction).
    if (type === 'ocfProbeFolder') {
      const folderPath = payload?.folderPath;
      if (!folderPath) {
        return { ok: false, error: { code: 'BAD_REQUEST', message: 'folderPath is required' } };
      }
      try {
        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
          return { ok: false, error: { code: 'INVALID_PATH', message: `Not a directory: ${folderPath}` } };
        }
        const CAMERA_EXTS = new Set(['.r3d','.ari','.arx','.braw','.mxf','.mov','.dng','.dpx','.exr','.tiff','.tif','.mp4','.arw','.crm','.nef','.raw']);
        const files = [];
        const _walk = (dir) => {
          let entries;
          try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const e of entries) {
            if (e.name.startsWith('.')) continue;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) { _walk(full); continue; }
            const ext = path.extname(e.name).toLowerCase();
            if (!CAMERA_EXTS.has(ext)) continue;
            const stem = path.basename(e.name, ext);
            // Derive a short reel ID from common camera naming conventions
            // ARRI: A001C002 → A001  |  RED: A001_C003 → A001  |  Sony: A001S001 → A001
            const rollMatch = stem.match(/^([A-Za-z]\d{3,4})/);
            const reelShort = rollMatch ? rollMatch[1].toUpperCase() : '';
            files.push({ name: e.name, path: full, ext, reel: stem, reelShort });
          }
        };
        _walk(folderPath);
        // Enrich with container metadata (start TC / UMID / duration / fps) so the
        // matcher can link by timecode — even for RAW whose video can't be decoded.
        await _enrichOcfMeta(files);
        return { ok: true, result: files };
      } catch (err) {
        return { ok: false, error: { code: 'PROBE_ERROR', message: err.message } };
      }
    }

    if (!nativeRouter || !nativeRouter.handles(type)) {
      return { ok: false, error: { code: 'UNKNOWN_ACTION', message: `Unknown native action: ${type}` } };
    }

    let _timeoutId;
    try {
      const result = await Promise.race([
        nativeRouter.route({ type, payload }),
        new Promise((_, rej) => { _timeoutId = setTimeout(() => rej(new Error(`pfx:native-command timeout (${type})`)), timeoutMs); }),
      ]);
      clearTimeout(_timeoutId);
      return { ok: true, result };
    } catch (err) {
      clearTimeout(_timeoutId);
      return {
        ok: false,
        error: { code: err.code || 'NATIVE_COMMAND_ERROR', message: err.message },
      };
    }
  });

  // ── Media engine (AVFoundation + Resolve OCF + pfx-media:// protocol) ───────
  // Commands: media.open, media.close, media.play, media.pause, media.seek,
  //           media.stepFrame, media.getInfo, media.getStill, media.getHeroFrames,
  //           media.getOcfStill, media.diagnostics

  ipcMain.handle('pfx:media', async (_e, { type, payload = {}, timeoutMs = 60000 } = {}) => {
    if (!type) return { ok: false, error: { code: 'BAD_REQUEST', message: 'type is required' } };

    const engine = (mediaEngine?.handles(type)) ? mediaEngine
                 : (mpvEngine?.handles(type))   ? mpvEngine
                 : null;
    if (!engine) {
      return { ok: false, error: { code: 'UNKNOWN_ACTION', message: `Unknown media action: ${type}` } };
    }

    let _tid;
    try {
      const result = await Promise.race([
        engine.route({ type, payload }),
        new Promise((_, rej) => { _tid = setTimeout(() => rej(new Error(`pfx:media timeout (${type})`)), timeoutMs); }),
      ]);
      clearTimeout(_tid);
      return { ok: true, result };
    } catch (err) {
      clearTimeout(_tid);
      return { ok: false, error: { code: err.code || 'MEDIA_ENGINE_ERROR', message: err.message } };
    }
  });

  // ── Smart Media Playback Engine ──────────────────────────────────────────
  // Channel: pfx:smartMedia { type, payload, timeoutMs }
  // Actions: smartMedia.probe | smartMedia.selectEngine | smartMedia.decodeFrame
  //          smartMedia.status | smartMedia.showLogs | smartMedia.transcodeProxy
  //          smartMedia.imf.open | smartMedia.imf.probeCpl | smartMedia.imf.decodeTestFrame
  //          smartMedia.resolve.status

  ipcMain.handle('pfx:smartMedia', async (_e, { type, payload = {}, timeoutMs = 60000 } = {}) => {
    if (!type) return { ok: false, error: { code: 'BAD_REQUEST', message: 'type is required' } };
    if (!smartRouter) {
      return { ok: false, error: { code: 'SMART_ROUTER_UNAVAILABLE', message: 'Smart media router not loaded.' } };
    }
    if (!smartRouter.handles(type)) {
      return { ok: false, error: { code: 'UNKNOWN_ACTION', message: `Unknown smartMedia action: ${type}` } };
    }
    let _tid;
    try {
      const result = await Promise.race([
        smartRouter.route({ type, payload }),
        new Promise((_, rej) => { _tid = setTimeout(() => rej(new Error(`pfx:smartMedia timeout (${type})`)), timeoutMs); }),
      ]);
      clearTimeout(_tid);
      return { ok: true, result };
    } catch (err) {
      clearTimeout(_tid);
      return { ok: false, error: { code: err.code || 'SMART_MEDIA_ERROR', message: err.message } };
    }
  });

  // ── PFXNativeMediaEngine — persistent AVFoundation service ───────────────
  // Commands: media.open/close/probe, playback.*, frame.extract,
  //           thumbnail.generate, waveform.generate, proxy.*, render.*, engine.diagnostics

  ipcMain.handle('pfx:nativeEngine', async (_e, { type, payload = {}, timeoutMs = 60000 } = {}) => {
    if (!type) return { ok: false, error: { code: 'BAD_REQUEST', message: 'type is required' } };
    if (!nativeEngine) {
      return { ok: false, error: { code: 'ENGINE_UNAVAILABLE', message: 'PFXNativeMediaEngine not loaded' } };
    }
    if (!nativeEngine.isReady) {
      return { ok: false, error: { code: 'ENGINE_NOT_READY', message: 'PFXNativeMediaEngine not yet started' } };
    }
    try {
      const result = await nativeEngine.command(type, payload, timeoutMs);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: { code: err.code || 'NATIVE_ENGINE_ERROR', message: err.message } };
    }
  });

  // ── App info ─────────────────────────────────────────────────────────────

  ipcMain.handle('pfx:getAppInfo', () => ({
    version:  app.getVersion(),
    appPath:  app.getAppPath(),
    userData: app.getPath('userData'),
    platform: process.platform,
    arch:     process.arch,
    isPackaged: app.isPackaged,
  }));

  ipcMain.handle('pfx:getManifest', () => manifest);

  // ── Downloads (chrome.downloads.download shim) ───────────────────────────

  ipcMain.handle('pfx:download', async (_e, { url, filename, dataUrl, saveAs } = {}) => {
    const defaultPath = path.join(app.getPath('downloads'), filename || 'download');

    // saveAs === false means caller wants a silent write — no dialog
    if (saveAs === false) {
      try {
        fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
        if (dataUrl) {
          const [, b64] = dataUrl.split(',');
          fs.writeFileSync(defaultPath, Buffer.from(b64, 'base64'));
        } else {
          mainWindow.webContents.downloadURL(url);
        }
        return { ok: true, filePath: defaultPath };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, { defaultPath });
    if (canceled || !filePath) return { ok: false };

    try {
      if (dataUrl) {
        const [, b64] = dataUrl.split(',');
        const buf = Buffer.from(b64, 'base64');
        fs.writeFileSync(filePath, buf);
        shell.showItemInFolder(filePath);
        return { ok: true, filePath };
      }
      mainWindow.webContents.downloadURL(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── IMF Frame Provider ───────────────────────────────────────────────────
  // Channels: pfx:imf:prepare, pfx:imf:requestFrame, pfx:imf:cacheFrame,
  //           pfx:imf:posterFrame, pfx:imf:clearCache, pfx:imf:diagnostics
  //
  // pfx:imf:prepare      { folderPath }  → { ok, packageId, index }
  // pfx:imf:requestFrame { mxfPath, mxfFrame, packageHash, cplId, displayMode } → { ok, imageDataUrl?, frameInfo, ... }
  // pfx:imf:cacheFrame   { packageHash, cplId, mxfFrame, displayMode, imageDataUrl } → { ok, imagePath? }
  // pfx:imf:posterFrame  { mxfPath, totalFrames, entryPoint, packageHash, cplId, displayMode } → { ok, frame, ... }
  // pfx:imf:clearCache   { packageHash? } → void
  // pfx:imf:diagnostics  {} → { ffmpegAvailable, htj2kFfmpegOpenjph, htj2kOjphExpand, cacheDir, ... }

  ipcMain.handle('pfx:imf:prepare', (_e, { folderPath } = {}) => {
    if (!imfProvider) return { ok: false, error: 'IMF provider not available' };
    if (!folderPath) return { ok: false, error: 'folderPath required' };
    return imfProvider.preparePackage(folderPath);
  });

  ipcMain.handle('pfx:imf:requestFrame', async (_e, args = {}) => {
    if (!imfProvider) return { ok: false, error: 'IMF provider not available' };
    return imfProvider.requestFrame(args);
  });

  // pfx:imf:extractAudio { mxfPath, tcOffset, sampleRate, channels, maxSeconds }
  //   → { ok, pcm: { left:Float32Array, right:Float32Array, sampleRate } } | { ok:false }
  // Decodes the reel's MXF audio essence to planar f32 PCM for in-sync playback.
  ipcMain.handle('pfx:imf:extractAudio', async (_e, args = {}) => {
    if (!mediaEngine?.extractAudio) return { ok: false, error: 'media engine not available' };
    try {
      return await mediaEngine.extractAudio(args);
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('pfx:imf:cacheFrame', (_e, args = {}) => {
    if (!imfProvider) return { ok: false, error: 'IMF provider not available' };
    return imfProvider.cacheFrame(args);
  });

  ipcMain.handle('pfx:imf:clearCache', (_e, { packageHash } = {}) => {
    if (!imfProvider) return;
    imfProvider.clearCache(packageHash || null);
  });

  ipcMain.handle('pfx:imf:diagnostics', async () => {
    if (!imfProvider) return { ffmpegAvailable: false, cacheDir: null };
    return imfProvider.diagnostics();
  });

  ipcMain.handle('pfx:imf:posterFrame', async (_e, args = {}) => {
    if (!imfProvider) return { ok: false, error: 'IMF provider not available' };
    return imfProvider.findPosterFrame(args);
  });

  ipcMain.handle('pfx:imf:reelList', (_e, { packageHash, cplId } = {}) => {
    if (!imfProvider) return { ok: false, error: 'IMF provider not available' };
    if (!packageHash) return { ok: false, error: 'packageHash required' };
    return imfProvider.getReelList(packageHash, cplId || null);
  });

  ipcMain.handle('pfx:imf:cplInfo', (_e, { packageHash, cplId } = {}) => {
    if (!imfProvider) return { ok: false, error: 'IMF provider not available' };
    if (!packageHash) return { ok: false, error: 'packageHash required' };
    return imfProvider.getCplInfo(packageHash, cplId || null);
  });

  ipcMain.handle('pfx:imf:decodeFrame', async (_e, args = {}) => {
    if (!imfProvider) return { ok: false, error: 'IMF provider not available' };
    return imfProvider.decodeFrame(args);
  });

  // pfx:imf:decodeTestFrame — direct ffmpeg IMF demuxer test, full debug output.
  // Runs: ffmpeg -hide_banner -f imf -assetmaps A,B -i CPL.xml -map 0:v:0 -frames:v 1 -vf scale=960:-2 output.png
  // Returns: { ok, command, outputPng, fileExists, codec, probe, imageDataUrl?, stderr, log[], errors[] }
  ipcMain.handle('pfx:imf:decodeTestFrame', async (_e, args = {}) => {
    const os   = require('os');
    const { cplPath, assetMaps = [], frameNumber = 0, scale = 'viewer' } = args;
    const log    = [];
    const errors = [];

    log.push(`[DecodeTest] cplPath=${cplPath}`);
    log.push(`[DecodeTest] assetMaps=${JSON.stringify(assetMaps)}`);
    log.push(`[DecodeTest] frameNumber=${frameNumber}`);

    if (!cplPath) {
      errors.push('cplPath required — no CPL path provided');
      return { ok: false, error: 'cplPath required', code: 'NO_CPL_PATH', log, errors };
    }
    if (!require('fs').existsSync(cplPath)) {
      errors.push(`CPL file not found: ${cplPath}`);
      return { ok: false, error: `CPL not found: ${cplPath}`, code: 'CPL_NOT_FOUND', log, errors };
    }
    if (!imfFfmpegBackend) {
      errors.push('imf_ffmpeg_backend not loaded');
      return { ok: false, error: 'FFmpeg backend not available', code: 'BACKEND_NOT_LOADED', log, errors };
    }

    // ── Step 1: probe to get codec info ───────────────────────────────────
    log.push('[DecodeTest] Step 1: ffprobe -f imf …');
    const probe = await imfFfmpegBackend.probeImfPackage(cplPath, assetMaps);
    log.push(`[DecodeTest] probe.ok=${probe.ok} codec=${probe.pictureCodec || '?'} streams=${probe.streamCount || 0}`);
    if (probe.stderr) log.push(`[DecodeTest] probe.stderr: ${probe.stderr.slice(0, 600)}`);

    if (!probe.ok) {
      errors.push(`ffprobe -f imf failed (IMF demuxer likely absent): ${probe.error}`);
      log.push(`[DecodeTest] IMF demuxer probe failed — trying direct MXF fallback`);

      // Resolve the MXF path from CPL directory (look for *.mxf near CPL)
      const cplDir = path.dirname(cplPath);
      let fallbackMxfPath = null;
      try {
        const fsScan = require('fs');
        // Walk up to package root and scan for video MXF files
        const scanDirs = [cplDir, path.join(cplDir, '..'), path.join(cplDir, '../..')];
        for (const dir of scanDirs) {
          if (!fsScan.existsSync(dir)) continue;
          const entries = fsScan.readdirSync(dir);
          for (const e of entries) {
            if (e.endsWith('.mxf') || e.endsWith('.MXF')) {
              const candidate = path.join(dir, e);
              // Prefer files that look like video (not audio/PCM)
              if (!e.toLowerCase().includes('audio') && !e.toLowerCase().includes('pcm') && !e.toLowerCase().includes('wav')) {
                fallbackMxfPath = candidate;
                break;
              }
            }
          }
          if (fallbackMxfPath) break;
        }
        // Also check assetMaps dirs
        if (!fallbackMxfPath) {
          for (const am of assetMaps) {
            const amDir = path.dirname(am);
            if (!fsScan.existsSync(amDir)) continue;
            const entries = fsScan.readdirSync(amDir);
            for (const e of entries) {
              if ((e.endsWith('.mxf') || e.endsWith('.MXF')) &&
                  !e.toLowerCase().includes('audio') && !e.toLowerCase().includes('pcm')) {
                fallbackMxfPath = path.join(amDir, e);
                break;
              }
            }
            if (fallbackMxfPath) break;
          }
        }
      } catch (scanErr) {
        log.push(`[DecodeTest] MXF scan error: ${scanErr.message}`);
      }

      if (fallbackMxfPath) {
        log.push(`[DecodeTest] Found MXF fallback: ${fallbackMxfPath}`);
        const outputPng = path.join(require('os').tmpdir(), 'postflowx_imf_frame_000000.png');
        const mxfProbe = await imfFfmpegBackend.probeStream(fallbackMxfPath);
        log.push(`[DecodeTest] MXF probe ok=${mxfProbe.ok} codec=${mxfProbe.codec || '?'}`);
        const mxfResult = await imfFfmpegBackend.extractFrame(fallbackMxfPath, frameNumber, outputPng, mxfProbe, 'SDR');
        log.push(`[DecodeTest] MXF extract ok=${mxfResult.ok} code=${mxfResult.code || 'none'}`);
        const fileExists = (() => { try { return require('fs').existsSync(outputPng); } catch { return false; } })();
        const mxfCommand = `ffmpeg -hide_banner -i "${fallbackMxfPath}" -vframes 1 -vf scale=960:-2 "${outputPng}"`;
        if (mxfResult.ok && fileExists) {
          let imageDataUrl = null;
          try {
            const buf = require('fs').readFileSync(outputPng);
            imageDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
            log.push(`[DecodeTest] MXF fallback PNG read OK, size=${buf.length}B`);
          } catch (e) { log.push(`[DecodeTest] PNG read error: ${e.message}`); }
          return {
            ok: true, imfDemuxerOK: false, backend: 'ffmpeg-mxf',
            command: mxfCommand, outputPng, fileExists: true,
            codec: mxfProbe.codec || 'J2K',
            probe: { ok: false, error: probe.error, codec: null },
            imageDataUrl, stderr: mxfResult.stderr || '',
            log, errors,
          };
        }
        errors.push(`MXF fallback also failed: ${mxfResult.error || mxfResult.code}`);
        return {
          ok: false, error: `IMF demuxer absent; MXF fallback failed: ${mxfResult.error || mxfResult.code}`,
          code: 'MXF_FALLBACK_FAILED',
          command: mxfCommand, outputPng, fileExists,
          stderr: (probe.stderr || '') + '\n' + (mxfResult.stderr || ''),
          probe: null, log, errors,
        };
      }

      const assetMapsStr = (Array.isArray(assetMaps) ? assetMaps : []).join(',');
      const command = [
        'ffprobe', '-hide_banner', '-v', 'quiet', '-f', 'imf',
        ...(assetMapsStr ? ['-assetmaps', `"${assetMapsStr}"`] : []),
        '-show_streams', '-show_format', '-of', 'json', `"${cplPath}"`,
      ].join(' ');
      return {
        ok: false, error: probe.error, code: 'PROBE_FAILED',
        command, outputPng: null, fileExists: false,
        stderr: probe.stderr || '', probe: null, log, errors,
      };
    }

    // ── Step 2: extract frame 0 ────────────────────────────────────────────
    const outputPng = path.join(os.tmpdir(), 'postflowx_imf_frame_000000.png');
    log.push(`[DecodeTest] Step 2: ffmpeg -f imf … -frames:v 1 → ${outputPng}`);

    const r = await imfFfmpegBackend.extractImfFrame(cplPath, assetMaps, frameNumber, outputPng, scale, probe);
    log.push(`[DecodeTest] extract.ok=${r.ok} code=${r.code || 'none'}`);
    if (r.stderr) log.push(`[DecodeTest] ffmpeg.stderr: ${r.stderr.slice(0, 800)}`);

    const fileExists = (() => { try { return require('fs').existsSync(outputPng); } catch { return false; } })();
    log.push(`[DecodeTest] outputPng=${outputPng} fileExists=${fileExists}`);

    // Build the exact command string for display
    const assetMapsStr = (Array.isArray(assetMaps) ? assetMaps : []).join(',');
    const command = [
      'ffmpeg', '-hide_banner', '-y',
      '-f', 'imf',
      ...(assetMapsStr ? ['-assetmaps', `"${assetMapsStr}"`] : []),
      '-i', `"${cplPath}"`,
      '-map', '0:v:0',
      '-vf', 'scale=960:-2',
      '-frames:v', '1',
      '-f', 'image2',
      `"${outputPng}"`,
    ].join(' ');

    if (!r.ok || !fileExists) {
      errors.push(`ffmpeg extract failed: ${r.error || r.code}`);
      return {
        ok: false, error: r.error || r.code, code: r.code || 'DECODE_FAILED',
        command, outputPng, fileExists,
        codec: probe.pictureCodec || null,
        probe: { ok: probe.ok, codec: probe.pictureCodec, streams: probe.streamCount },
        stderr: r.stderr || '',
        log, errors,
      };
    }

    // ── Step 3: read PNG as data URL ──────────────────────────────────────
    let imageDataUrl = null;
    try {
      const buf = require('fs').readFileSync(outputPng);
      imageDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
      log.push(`[DecodeTest] PNG read OK, size=${buf.length}B`);
    } catch (e) {
      errors.push(`PNG read error: ${e.message}`);
      log.push(`[DecodeTest] PNG read error: ${e.message}`);
    }

    return {
      ok: true,
      command, outputPng, fileExists: true,
      codec: probe.pictureCodec || 'J2K',
      backend: 'ffmpeg-imf',
      probe: { ok: true, codec: probe.pictureCodec, streams: probe.streamCount, fps: probe.fps },
      imageDataUrl,
      stderr: r.stderr || '',
      log, errors,
    };
  });

  // ── IMF Direct Playback Engine ──────────────────────────────────────────
  // Channel: pfx:imf-engine  { command, payload }
  // Commands: openPackage | validatePackage | startPlayback | controlPlayback
  //           stopPlayback | getFrame | getPackageInfo | listPackages | diagnostics

  ipcMain.handle('pfx:imf-engine', async (_e, { command, payload = {} } = {}) => {
    if (!command) return { ok: false, error: 'command required', code: 'BAD_REQUEST' };
    if (!imfDirectEngine || !imfDirectEngine.handles(command)) {
      return { ok: false, error: `Unknown IMF engine command: ${command}`, code: 'UNKNOWN_COMMAND' };
    }
    try {
      return await imfDirectEngine.route({ command, payload });
    } catch (e) {
      console.error(`[pfx:imf-engine] ${command} threw:`, e);
      return { ok: false, error: e.message, code: 'INTERNAL_ERROR' };
    }
  });

  // ── IMF package loader (companion-free) ─────────────────────────────────
  // pfx:imf:loadPackage { folderPath } → { ok, snapshot, folderPath, packageId }
  // Scans the folder using IMFPackageIndex (pure Node.js — no Python companion needed).

  ipcMain.handle('pfx:imf:loadPackage', async (_e, { folderPath } = {}) => {
    if (!folderPath) return { ok: false, error: 'folderPath required' };
    try {
      const { IMFPackageIndex } = require('./imf/imf_package_index');
      const idx = new IMFPackageIndex().scan(folderPath);
      if (!idx.assetMapPath) return { ok: false, error: idx.errors[0] || 'No ASSETMAP.xml found in folder' };

      const assetMapObj = {};
      for (const [uuid, entry] of idx.assetMap) assetMapObj[uuid] = entry;

      const pklObj = {};
      for (const [uuid, entry] of idx.pkl) pklObj[uuid] = entry;

      const cplEntries = idx.cpls.map(cpl => {
        const cplCopy = { ...cpl };
        if (cplCopy.dvDescriptorIds instanceof Set) cplCopy.dvDescriptorIds = [...cplCopy.dvDescriptorIds];
        if (cplCopy.sourcePackageIdList instanceof Set) cplCopy.sourcePackageIdList = [...cplCopy.sourcePackageIdList];
        let missingVideo = 0;
        for (const res of (cpl.videoResources || [])) {
          if (res.fileId && !idx.assetMap.has(res.fileId)) missingVideo++;
        }
        return {
          key: cpl.id,
          root: folderPath,
          packageName: path.basename(folderPath),
          isSupplemental: !!cpl.isSupplemental,
          missingVideoRefs: missingVideo,
          missingAudioRefs: 0,
          playableReels: (cpl.videoResources || []).length,
          shortLabel: cpl.contentTitle || cpl.annotation || path.basename(cpl.cplPath || '') || 'CPL',
          cpl: cplCopy,
        };
      });

      const primaryCpl = cplEntries.find(c => !c.isSupplemental) || cplEntries[0];
      const snapshot = {
        packages: [{
          root: folderPath,
          packageName: path.basename(folderPath),
          assetMap: { assets: assetMapObj },
          pkl: { assets: pklObj },
          resolvedAssetIds: [...idx.assetMap.keys()],
          cpls: cplEntries,
        }],
        baseCplKey: primaryCpl?.key || '',
        currentCplKey: primaryCpl?.key || '',
        activeLeftTab: 'validation',
        source: {
          backend: 'electron',
          folderPath,
          folderName: path.basename(folderPath),
          packageId: idx.packageHash || '',
        },
      };

      return { ok: true, snapshot, folderPath, packageId: idx.packageHash || '' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── IMF folder listing (renderer-side JS parseCPL path) ─────────────────
  // pfx:imf:listFolder { folderPath } → [{ name, relativePath, absolutePath }]
  // Returns every file under folderPath with a folderName-prefixed relativePath
  // so the renderer can create File objects and feed them to loadFromFileList.

  ipcMain.handle('pfx:imf:listFolder', async (_e, { folderPath } = {}) => {
    if (!folderPath) return [];
    try {
      const results = [];
      const folderName = path.basename(folderPath);
      const walk = (dir, relBase) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const abs = path.join(dir, entry.name);
          const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
          if (entry.isDirectory()) walk(abs, rel);
          else if (entry.isFile()) results.push({ name: entry.name, relativePath: rel, absolutePath: abs });
        }
      };
      walk(folderPath, folderName);
      return results;
    } catch (e) {
      console.error('[IPC] listFolder error:', e.message);
      return [];
    }
  });

  // ── IMF Photon validator + engine status ────────────────────────────────
  // pfx:imf:runPhoton   { packagePath } → { ok, results[], summary, rawOutput, error? }
  // pfx:imf:engineStatus {}             → { engines: [{ id, label, status, detail }] }

  ipcMain.handle('pfx:imf:runPhoton', async (_e, { packagePath } = {}) => {
    if (!imfPhoton) return { ok: false, results: [], summary: 'Photon module unavailable', rawOutput: '', error: 'imf_photon not loaded' };
    if (!packagePath) return { ok: false, results: [], summary: 'No package path', rawOutput: '', error: 'packagePath required' };
    try {
      return await imfPhoton.runPhoton(packagePath);
    } catch (e) {
      return { ok: false, results: [], summary: 'Photon threw', rawOutput: '', error: e.message };
    }
  });

  ipcMain.handle('pfx:imf:engineStatus', async () => {
    if (!imfProvider) return { engines: [] };
    try {
      return await imfProvider.engineStatus();
    } catch (e) {
      // Fall back to photon engine status if provider throws
      if (imfPhoton) {
        try { return await imfPhoton.engineStatus(); } catch {}
      }
      return { engines: [], error: e.message };
    }
  });

  // ── Google OAuth for desktop sign-in ─────────────────────────────────────
  // Uses system browser + PKCE + loopback redirect (Google installed-app flow).
  // Token exchange and safeStorage encryption stay in main process only —
  // the renderer receives only { ok, email, name, picture, accessToken }.
  //
  // SETUP: Google Cloud Console → Credentials → Create OAuth 2.0 Client ID
  //   Application type: Desktop app
  //   Authorized redirect URIs: http://127.0.0.1  (loopback, no port needed)
  //   Copy the client ID and either:
  //     a) set env var  GOOGLE_DESKTOP_CLIENT_ID=xxxx.apps.googleusercontent.com
  //     b) create file  <userData>/pfx-auth-config.json  →  { "googleDesktopClientId": "xxxx..." }

  // ── Runtime config helpers ────────────────────────────────────────────────
  // Resolution order for Google Desktop client ID (first non-empty valid value wins):
  //   1. GOOGLE_DESKTOP_CLIENT_ID / POSTFLOWX_GOOGLE_DESKTOP_CLIENT_ID  — env vars
  //   2. <resourcesPath>/authConfig.json     — extraResources (packaged builds)
  //   3. electron/generated/authConfig.generated.json — baked into asar at build time
  //   4. electron/authConfig.local.json      — dev-only override (git-ignored)
  //   5. <userData>/pfx-auth-config.json     — post-install manual config

  function _tryReadJson(fp) {
    try { return JSON.parse(require('fs').readFileSync(fp, 'utf8')); } catch { return null; }
  }

  // Returns the runtime config object from the best available source.
  // Packaged builds use extraResources/authConfig.json (outside the asar, replaceable).
  // Dev builds use electron/authConfig.local.json (git-ignored local override).
  function _getRuntimeConfig() {
    const { app } = require('electron');
    const nodePath = require('path');
    if (app.isPackaged) {
      const cfg = _tryReadJson(nodePath.join(process.resourcesPath, 'authConfig.json'));
      if (cfg) return cfg;
    } else {
      const cfg = _tryReadJson(nodePath.join(__dirname, 'authConfig.local.json'));
      if (cfg) return cfg;
    }
    return {};
  }

  function _getGoogleClientId() {
    if (process.env.GOOGLE_DESKTOP_CLIENT_ID) return process.env.GOOGLE_DESKTOP_CLIENT_ID;
    if (process.env.POSTFLOWX_GOOGLE_DESKTOP_CLIENT_ID) return process.env.POSTFLOWX_GOOGLE_DESKTOP_CLIENT_ID;
    const nodePath = require('path');
    // extraResources / local override config
    const runtimeCfg = _getRuntimeConfig();
    if (runtimeCfg.googleDesktopClientId) return runtimeCfg.googleDesktopClientId;
    // Bundled build-time config (electron/generated/ is packaged into the asar).
    const gen = _tryReadJson(nodePath.join(__dirname, 'generated', 'authConfig.generated.json'));
    if (gen?.googleDesktopClientId) return gen.googleDesktopClientId;
    // Post-install user config in OS userData.
    try {
      const { app } = require('electron');
      const cfg = _tryReadJson(nodePath.join(app.getPath('userData'), 'pfx-auth-config.json'));
      if (cfg?.googleDesktopClientId) return cfg.googleDesktopClientId;
    } catch {}
    return '';
  }

  function _googleClientIdSource() {
    if (process.env.GOOGLE_DESKTOP_CLIENT_ID) return 'env:GOOGLE_DESKTOP_CLIENT_ID';
    if (process.env.POSTFLOWX_GOOGLE_DESKTOP_CLIENT_ID) return 'env:POSTFLOWX_GOOGLE_DESKTOP_CLIENT_ID';
    const { app } = require('electron');
    const nodePath = require('path');
    const runtimeCfg = _getRuntimeConfig();
    if (runtimeCfg.googleDesktopClientId) {
      return app.isPackaged ? 'resources:authConfig.json' : 'local:authConfig.local.json';
    }
    const gen = _tryReadJson(nodePath.join(__dirname, 'generated', 'authConfig.generated.json'));
    if (gen?.googleDesktopClientId) return 'bundled:authConfig.generated.json';
    try {
      const cfg = _tryReadJson(nodePath.join(app.getPath('userData'), 'pfx-auth-config.json'));
      if (cfg?.googleDesktopClientId) return 'userdata:pfx-auth-config.json';
    } catch {}
    return 'missing';
  }

  function _isGoogleClientIdValid(cid) {
    return !!(cid && cid.includes('.apps.googleusercontent.com'));
  }

  // Dev auth bypass — active when config/env enables it.
  // Production safety: build-renderer.js always writes devAuthBypass:false in CI authConfig.json.
  function _isDevAuthBypassEnabled() {
    if (process.env.POSTFLOWX_DEV_AUTH_BYPASS === 'true') return true;
    const cfg = _getRuntimeConfig();
    return cfg.devAuthBypass === true;
  }

  function _getPostflowxAuthApiUrl() {
    if (process.env.POSTFLOWX_AUTH_API_URL) return process.env.POSTFLOWX_AUTH_API_URL;
    const runtimeCfg = _getRuntimeConfig();
    if (runtimeCfg.postflowxAuthApiUrl) return runtimeCfg.postflowxAuthApiUrl;
    return '';
  }

  function _isPostflowxApiConfigured() {
    const url = _getPostflowxAuthApiUrl();
    return !!(url && url.startsWith('https://'));
  }

  function _saveGoogleToken(tokenJson) {
    try {
      const { safeStorage, app } = require('electron');
      const nodePath = require('path');
      const nodeFs   = require('fs');
      if (!safeStorage.isEncryptionAvailable()) return;
      const enc     = safeStorage.encryptString(JSON.stringify(tokenJson));
      const outPath = nodePath.join(app.getPath('userData'), 'pfx-google-token.enc');
      nodeFs.writeFileSync(outPath, enc);
    } catch {}
  }

  // Reports whether a valid client ID is present (used by renderer to show/hide button).
  ipcMain.handle('pfx:is-google-auth-configured', () => {
    return { configured: _isGoogleClientIdValid(_getGoogleClientId()) };
  });

  // Debug info for login screen / admin diagnostics — safe to call from renderer.
  // clientIdPreview never exposes the full ID.
  ipcMain.handle('pfx:google-auth-debug', async () => {
    const { app } = require('electron');
    const cid    = _getGoogleClientId();
    const ok     = _isGoogleClientIdValid(cid);
    const apiUrl = _getPostflowxAuthApiUrl();
    const apiOk  = _isPostflowxApiConfigured();

    let backendHealth = null;
    if (apiOk) {
      try {
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 4_000);
        const r    = await fetch(`${apiUrl}?path=health`, { signal: ctrl.signal });
        clearTimeout(tid);
        const body = await r.json().catch(() => ({}));
        backendHealth = { reachable: r.ok, status: r.status, ...body };
      } catch (e) {
        backendHealth = { reachable: false, error: e.message };
      }
    }

    return {
      configured:             ok,
      source:                 _googleClientIdSource(),
      clientIdPreview:        ok ? cid.slice(0, 8) + '...' + cid.slice(-28) : null,
      isPackaged:             app.isPackaged,
      devBypassEnabled:       _isDevAuthBypassEnabled(),
      postflowxApiConfigured: apiOk,
      postflowxApiUrlPreview: apiOk ? apiUrl.slice(0, 55) + '…' : null,
      backendHealth,
    };
  });

  // Synchronous check for dev auth bypass — used by preload.js at startup so boot-guard
  // can read the value without any async IPC.  Returns a boolean.
  ipcMain.on('pfx:dev-bypass-sync', (event) => {
    event.returnValue = _isDevAuthBypassEnabled();
  });

  // Dev-only sign-in bypass — returns a synthetic user without any Google OAuth.
  // Returns { ok: false, error: 'DEV_AUTH_BYPASS_DISABLED' } in packaged/production builds.
  ipcMain.handle('pfx:dev-auth-bypass', () => {
    if (!_isDevAuthBypassEnabled()) {
      return { ok: false, error: 'DEV_AUTH_BYPASS_DISABLED' };
    }
    return {
      ok:          true,
      email:       'local-dev@postflowx.local',
      name:        'Local Dev',
      picture:     '',
      accessToken: 'dev-bypass',
    };
  });

  ipcMain.handle('pfx:google-oauth', async (_e, { clientId } = {}) => {
    const { shell, app } = require('electron');
    const http   = require('http');
    const crypto = require('crypto');

    // Dev-only bypass — reads from env var OR authConfig.local.json; never active when packaged.
    if (_isDevAuthBypassEnabled()) {
      return { ok: true, email: 'local-dev@postflowx.local', name: 'Local Dev', picture: '', accessToken: 'dev-bypass' };
    }

    const cid = clientId || _getGoogleClientId();
    if (!_isGoogleClientIdValid(cid)) {
      return { ok: false, error: 'GOOGLE_DESKTOP_CLIENT_ID_MISSING' };
    }

    // PKCE + state (CSRF)
    const verifier   = crypto.randomBytes(32).toString('base64url');
    const challenge  = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state      = crypto.randomBytes(24).toString('base64url');

    // Temporary loopback server catches the auth-code redirect.
    let resolveCode, rejectCode;
    const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/oauth2/callback') { res.writeHead(404); res.end(); return; }
      const returnedState = u.searchParams.get('state');
      const code  = u.searchParams.get('code');
      const error = u.searchParams.get('error');
      if (error || !code || returnedState !== state) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font:16px system-ui,sans-serif;text-align:center;padding:60px 40px;color:#e8eaf0;background:#0e0f13"><h2 style="margin:0 0 8px">&#x274C; Sign-in failed</h2><p style="color:#888;margin:0">You can close this browser tab and try again.</p></body></html>');
        if (error) { rejectCode(new Error(error)); } else { rejectCode(new Error('Invalid OAuth response')); }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="font:16px system-ui,sans-serif;text-align:center;padding:60px 40px;color:#e8eaf0;background:#0e0f13"><h2 style="margin:0 0 8px">&#x2713; Signed in to PostFlowX</h2><p style="color:#888;margin:0">You can close this browser tab.</p></body></html>');
      resolveCode(code);
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port        = server.address().port;
    const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;

    const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id:             cid,
      redirect_uri:          redirectUri,
      response_type:         'code',
      scope:                 'openid email profile',
      code_challenge:        challenge,
      code_challenge_method: 'S256',
      state,
      access_type:           'offline',
      prompt:                'select_account',
    });

    // Open Google login in the system browser — never in an embedded webview.
    shell.openExternal(authUrl);

    let code;
    try {
      code = await Promise.race([
        codePromise,
        new Promise((_, rej) => setTimeout(() => rej(new Error('Sign-in timed out (5 min)')), 300_000)),
      ]);
    } catch (e) {
      server.close();
      return { ok: false, error: e.message };
    }
    server.close();

    // Exchange code for tokens (main process only — renderer never sees raw tokens).
    try {
      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id:     cid,
          redirect_uri:  redirectUri,
          grant_type:    'authorization_code',
          code_verifier: verifier,
        }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        return { ok: false, error: err.error_description || `Token exchange HTTP ${resp.status}` };
      }
      const tokens = await resp.json();
      // Decode ID token JWT claims (sig-verify not needed — we own the loopback redirect)
      const [, rawPayload] = (tokens.id_token || '').split('.');
      let claims = {};
      try { claims = JSON.parse(Buffer.from(rawPayload, 'base64url').toString('utf8')); } catch {}

      // Persist encrypted tokens — renderer never reads these directly.
      _saveGoogleToken({ ...tokens, email: claims.email, storedAt: Date.now() });

      // If postflowxAuthApiUrl is configured, verify the Google token with the backend
      // and return a complete PostFlowX session so the renderer can skip backend policy.
      const pfxApiUrl = _getPostflowxAuthApiUrl();
      if (pfxApiUrl) {
        try {
          const ctrl = new AbortController();
          const tid  = setTimeout(() => ctrl.abort(), 15_000);
          const br   = await fetch(`${pfxApiUrl}?path=auth/google`, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            signal:  ctrl.signal,
            body:    JSON.stringify({ token: tokens.access_token }),
          });
          clearTimeout(tid);
          const bd = await br.json().catch(() => ({}));
          if (!br.ok || !bd.ok) {
            return { ok: false, error: bd.error || `Backend HTTP ${br.status}` };
          }
          const pfxSession = {
            ok:           true,
            user:         { email: claims.email || '', name: claims.name || '', picture: claims.picture || '' },
            role:         bd.role         || 'viewer',
            permissions:  bd.permissions  || { tabs: [], actions: [] },
            featureFlags: bd.featureFlags || {},
            session: {
              token:     bd.sessionToken || bd.token || '',
              expiresAt: bd.expiresAt    || new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
            },
          };
          return {
            ok:          true,
            email:       claims.email        || '',
            name:        claims.name         || '',
            picture:     claims.picture      || '',
            accessToken: tokens.access_token || '',
            pfxSession,
          };
        } catch (e) {
          return { ok: false, error: `Backend auth failed: ${e.message}` };
        }
      }

      return {
        ok:          true,
        email:       claims.email        || '',
        name:        claims.name         || '',
        picture:     claims.picture      || '',
        accessToken: tokens.access_token || '',
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ── Push a message to the renderer (used by companion events) ────────────
  companion.on('message', (msg) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('pfx:fromMain', msg);
    }
  });
}

module.exports = { register };
