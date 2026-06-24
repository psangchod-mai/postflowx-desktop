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
const mediaEngine     = optionalRequire('./native/media_engine');
const mpvEngine       = optionalRequire('./native/mpv_engine');
const imfProvider     = optionalRequire('./imf/imf_frame_provider');
const imfDirectEngine = optionalRequire('./imf/imf_direct_engine');
const imfPhoton       = optionalRequire('./imf/imf_photon');
const imfFfmpegBackend = optionalRequire('./imf/imf_ffmpeg_backend');

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
    if (url) shell.openExternal(url);
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

    if (!nativeRouter || !nativeRouter.handles(type)) {
      return { ok: false, error: { code: 'UNKNOWN_ACTION', message: `Unknown native action: ${type}` } };
    }

    try {
      const result = await Promise.race([
        nativeRouter.route({ type, payload }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`pfx:native-command timeout (${type})`)), timeoutMs)),
      ]);
      return { ok: true, result };
    } catch (err) {
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

    try {
      const result = await Promise.race([
        engine.route({ type, payload }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error(`pfx:media timeout (${type})`)), timeoutMs)),
      ]);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: { code: err.code || 'MEDIA_ENGINE_ERROR', message: err.message } };
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

  ipcMain.handle('pfx:download', async (_e, { url, filename, dataUrl } = {}) => {
    const defaultPath = path.join(app.getPath('downloads'), filename || 'download');
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, { defaultPath });
    if (canceled || !filePath) return { ok: false };

    try {
      if (dataUrl) {
        // data: URL — decode and write directly
        const [header, b64] = dataUrl.split(',');
        const buf = Buffer.from(b64, 'base64');
        fs.writeFileSync(filePath, buf);
        shell.showItemInFolder(filePath);
        return { ok: true, filePath };
      }
      // Regular URL — use Electron's downloadItem via webContents.downloadURL
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
    if (!folderPath) return { ok: false, error: 'folderPath required' };
    return imfProvider.preparePackage(folderPath);
  });

  ipcMain.handle('pfx:imf:requestFrame', async (_e, args = {}) => {
    return imfProvider.requestFrame(args);
  });

  ipcMain.handle('pfx:imf:cacheFrame', (_e, args = {}) => {
    return imfProvider.cacheFrame(args);
  });

  ipcMain.handle('pfx:imf:clearCache', (_e, { packageHash } = {}) => {
    imfProvider.clearCache(packageHash || null);
  });

  ipcMain.handle('pfx:imf:diagnostics', async () => {
    return imfProvider.diagnostics();
  });

  ipcMain.handle('pfx:imf:posterFrame', async (_e, args = {}) => {
    return imfProvider.findPosterFrame(args);
  });

  ipcMain.handle('pfx:imf:reelList', (_e, { packageHash, cplId } = {}) => {
    if (!packageHash) return { ok: false, error: 'packageHash required' };
    return imfProvider.getReelList(packageHash, cplId || null);
  });

  ipcMain.handle('pfx:imf:cplInfo', (_e, { packageHash, cplId } = {}) => {
    if (!packageHash) return { ok: false, error: 'packageHash required' };
    return imfProvider.getCplInfo(packageHash, cplId || null);
  });

  ipcMain.handle('pfx:imf:decodeFrame', async (_e, args = {}) => {
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
      errors.push(`ffprobe failed: ${probe.error}`);
      const assetMapsStr = (Array.isArray(assetMaps) ? assetMaps : []).join(',');
      const command = [
        'ffprobe', '-hide_banner', '-v', 'quiet',
        '-f', 'imf',
        ...(assetMapsStr ? ['-assetmaps', `"${assetMapsStr}"`] : []),
        '-show_streams', '-show_format', '-of', 'json',
        `"${cplPath}"`,
      ].join(' ');
      return {
        ok: false, error: probe.error, code: 'PROBE_FAILED',
        command, outputPng: null, fileExists: false,
        stderr: probe.stderr || '',
        probe: null, log, errors,
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
    if (!imfDirectEngine.handles(command)) {
      return { ok: false, error: `Unknown IMF engine command: ${command}`, code: 'UNKNOWN_COMMAND' };
    }
    try {
      return await imfDirectEngine.route({ command, payload });
    } catch (e) {
      console.error(`[pfx:imf-engine] ${command} threw:`, e);
      return { ok: false, error: e.message, code: 'INTERNAL_ERROR' };
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
    if (!imfPhoton) return { engines: [] };
    try {
      return await imfPhoton.engineStatus();
    } catch (e) {
      return { engines: [], error: e.message };
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
