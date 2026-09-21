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

const { ipcMain, dialog, shell, app, clipboard } = require('electron');
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

// The IPC handlers are process-global (ipcMain.handle) and must be registered
// exactly once. register() can be called again when the window is reopened
// (macOS dock activate → createWindow); re-invoking ipcMain.handle for an
// already-registered channel throws, so we guard registration with a flag and
// keep a live reference to the current window that handlers read at call time.
let _activeWindow  = null;
let _ipcRegistered = false;

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
      'format=duration:format_tags=timecode,material_package_umid,company_name,modification_date:stream=codec_type,codec_name,width,height,r_frame_rate,duration_ts,nb_frames:stream_tags=timecode',
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
                  recordDate: recordDate || undefined, tcKnown,
                  codec: v.codec_name || undefined, width: v.width || undefined, height: v.height || undefined });
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
  // Index the scanned media into the native SQLite DB (PFXMAC Sprint 3).
  // Best-effort + non-blocking: a missing engine or DB error must never break the scan.
  try {
    const engine  = require('./native/pfx_native_engine.js');
    const indexer  = require('./native/mediaIndexer.js');
    indexer.indexFiles(files, engine)
      .then(n => { if (n) console.log(`[MediaIndexer] indexed ${n} asset(s) into native DB`); })
      .catch(() => {});
  } catch { /* native engine/indexer unavailable — skip indexing */ }
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
  // Always track the current window so already-bound handlers target it.
  _activeWindow = mainWindow;
  // Register process-global handlers/listeners only once.
  if (_ipcRegistered) return;
  _ipcRegistered = true;

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
    const { canceled, filePaths } = await dialog.showOpenDialog(_activeWindow, {
      properties: ['openFile'],
      title: options.title || 'Select File',
      filters: options.filters || [],
      defaultPath: options.defaultPath,
    });
    return canceled ? null : (filePaths[0] || null);
  });

  ipcMain.handle('pfx:pickFiles', async (_e, { options = {} } = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(_activeWindow, {
      properties: ['openFile', 'multiSelections'],
      title: options.title || 'Select Files',
      filters: options.filters || [],
      defaultPath: options.defaultPath,
    });
    return canceled ? [] : filePaths;
  });

  ipcMain.handle('pfx:pickFolder', async (_e, { options = {} } = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(_activeWindow, {
      properties: ['openDirectory', 'createDirectory'],
      title: options.title || 'Select Folder',
      defaultPath: options.defaultPath,
    });
    return canceled ? null : (filePaths[0] || null);
  });

  ipcMain.handle('pfx:listMediaFolder', async (_e, { folderPath, extensions = ['.mov'] } = {}) => {
    if (!folderPath) return [];
    try {
      const allowed = new Set((extensions || []).map(ext => String(ext).toLowerCase()));
      return fs.readdirSync(folderPath, { withFileTypes: true })
        .filter(entry => entry.isFile() && !entry.name.startsWith('.') && allowed.has(path.extname(entry.name).toLowerCase()))
        .map(entry => {
          const absolutePath = path.join(folderPath, entry.name);
          const stat = fs.statSync(absolutePath);
          return { name: entry.name, absolutePath, size: stat.size, lastModified: stat.mtimeMs };
        })
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    } catch (err) {
      console.warn('[IPC] listMediaFolder failed:', err.message);
      return [];
    }
  });

  ipcMain.handle('pfx:saveFile', async (_e, { defaultPath, data, encoding = 'utf8' } = {}) => {
    const { canceled, filePath } = await dialog.showSaveDialog(_activeWindow, {
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

  // Direct write to an absolute path — NO dialog (used by project save once a
  // Project Folder is configured). Creates parent dirs as needed.
  ipcMain.handle('pfx:writeFile', async (_e, { filePath, data, encoding = 'utf8' } = {}) => {
    try {
      if (!filePath) return { ok: false, error: 'no filePath' };
      const p = require('path');
      fs.mkdirSync(p.dirname(filePath), { recursive: true });
      if (encoding === 'base64') fs.writeFileSync(filePath, Buffer.from(data, 'base64'));
      else fs.writeFileSync(filePath, data, encoding);
      return { ok: true, path: filePath };
    } catch (e) {
      console.error('[IPC] writeFile error:', e.message);
      return { ok: false, error: e.message };
    }
  });

  // List PostFlowX projects under a folder (subdirs containing project.json, or
  // top-level *.json). Powers smart project Load. Newest first.
  ipcMain.handle('pfx:listProjects', async (_e, { dirPath } = {}) => {
    try {
      if (!dirPath || !fs.existsSync(dirPath)) return { ok: true, projects: [] };
      const p = require('path');
      const out = [];
      for (const ent of fs.readdirSync(dirPath, { withFileTypes: true })) {
        if (ent.name.startsWith('.')) continue;
        if (ent.isDirectory()) {
          const sub = p.join(dirPath, ent.name);
          let manifest = null;
          try {
            const f = fs.readdirSync(sub).find(n => n === 'project.json' || /\.mpsproj\.json$/i.test(n));
            if (f) manifest = p.join(sub, f);
          } catch {}
          if (manifest) {
            let mtime = 0, created = 0;
            try { const s = fs.statSync(manifest); mtime = s.mtimeMs; created = s.birthtimeMs || s.ctimeMs || 0; } catch {}
            // Smart catalog: detect which tool tabs this project actually has
            // data in (a shard file is written only when that tool is used).
            // `settings` is excluded (always present, not a "what it's for" signal);
            // tiny/empty shards (≤80 bytes ≈ "{}") are skipped.
            let tabs = [];
            try {
              const tabsDir = p.join(sub, 'tabs');
              if (fs.existsSync(tabsDir)) {
                for (const tf of fs.readdirSync(tabsDir)) {
                  const m = /^([a-z_]+)\.json$/i.exec(tf);
                  if (!m || m[1] === 'settings') continue;
                  let size = 0, smt = mtime;
                  try { const s = fs.statSync(p.join(tabsDir, tf)); size = s.size; smt = s.mtimeMs; } catch {}
                  if (size > 80) tabs.push({ key: m[1], size, mtime: smt });
                }
                tabs.sort((a, b) => b.size - a.size);   // primary tool first
              }
            } catch {}
            out.push({ name: ent.name, path: sub, manifest, mtime, created, tabs });
          }
        } else if (/\.(mpsproj\.)?json$/i.test(ent.name)) {
          const full = p.join(dirPath, ent.name);
          let mtime = 0, created = 0;
          try { const s = fs.statSync(full); mtime = s.mtimeMs; created = s.birthtimeMs || s.ctimeMs || 0; } catch {}
          out.push({ name: ent.name.replace(/\.(mpsproj\.)?json$/i, ''), path: full, manifest: full, mtime, created });
        }
      }
      out.sort((a, b) => b.mtime - a.mtime);
      return { ok: true, projects: out };
    } catch (e) {
      return { ok: false, error: e.message, projects: [] };
    }
  });

  // Delete a project (move to Trash — recoverable). Accepts the project's
  // resolved path (file or dir). Safety: target must live inside the configured
  // Project Folder and, if a directory, must contain a project manifest.
  ipcMain.handle('pfx:deleteProject', async (_e, { dirPath, targetPath, name } = {}) => {
    try {
      const p = require('path');
      const root = dirPath ? p.resolve(dirPath) : '';
      let target = targetPath ? p.resolve(targetPath)
                 : (root && name ? p.resolve(p.join(root, name)) : '');
      if (!target || !fs.existsSync(target)) return { ok: false, error: 'Project not found' };
      // Confine to the Project Folder — refuse anything outside it.
      if (root) {
        const rel = p.relative(root, target);
        if (rel === '' || rel.startsWith('..') || p.isAbsolute(rel)) {
          return { ok: false, error: 'Refusing to delete outside the Project Folder' };
        }
      }
      const st = fs.statSync(target);
      if (st.isDirectory()) {
        const hasManifest = fs.readdirSync(target)
          .some(n => n === 'project.json' || /\.mpsproj\.json$/i.test(n));
        if (!hasManifest) return { ok: false, error: 'Not a PostFlowX project folder' };
      } else if (!/\.(mpsproj\.)?json$/i.test(target)) {
        return { ok: false, error: 'Not a PostFlowX project file' };
      }
      await shell.trashItem(target);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Rename / duplicate a project within the Project Folder. Same confinement as
  // deleteProject: target must live inside dirPath and be a PFX project. newName
  // is sanitised (no path separators / leading dots) and must not already exist.
  const _pmSafeName = (n) => String(n || '').trim().replace(/[\/\\:*?"<>|]/g, '').replace(/^\.+/, '');
  const _pmResolveTarget = (fsMod, pMod, dirPath, targetPath) => {
    const root = dirPath ? pMod.resolve(dirPath) : '';
    const target = targetPath ? pMod.resolve(targetPath) : '';
    if (!target || !fsMod.existsSync(target)) return { err: 'Project not found' };
    if (root) {
      const rel = pMod.relative(root, target);
      if (rel === '' || rel.startsWith('..') || pMod.isAbsolute(rel)) return { err: 'Refusing to act outside the Project Folder' };
    }
    return { target };
  };
  const _pmDestPath = (pMod, target, isDir, cleanName) => {
    let destName = cleanName;
    if (!isDir) { const ext = (target.match(/\.(mpsproj\.)?json$/i) || [''])[0]; destName = cleanName + ext; }
    return pMod.join(pMod.dirname(target), destName);
  };

  ipcMain.handle('pfx:renameProject', async (_e, { dirPath, targetPath, newName } = {}) => {
    try {
      const p = require('path');
      const { target, err } = _pmResolveTarget(fs, p, dirPath, targetPath);
      if (err) return { ok: false, error: err };
      const clean = _pmSafeName(newName);
      if (!clean) return { ok: false, error: 'Invalid name' };
      const isDir = fs.statSync(target).isDirectory();
      const dest = _pmDestPath(p, target, isDir, clean);
      if (fs.existsSync(dest)) return { ok: false, error: 'A project with that name already exists' };
      fs.renameSync(target, dest);
      return { ok: true, name: clean, path: dest };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('pfx:duplicateProject', async (_e, { dirPath, targetPath, newName } = {}) => {
    try {
      const p = require('path');
      const { target, err } = _pmResolveTarget(fs, p, dirPath, targetPath);
      if (err) return { ok: false, error: err };
      const clean = _pmSafeName(newName);
      if (!clean) return { ok: false, error: 'Invalid name' };
      const isDir = fs.statSync(target).isDirectory();
      const dest = _pmDestPath(p, target, isDir, clean);
      if (fs.existsSync(dest)) return { ok: false, error: 'A project with that name already exists' };
      if (isDir) fs.cpSync(target, dest, { recursive: true });
      else fs.copyFileSync(target, dest);
      return { ok: true, name: clean, path: dest };
    } catch (e) { return { ok: false, error: e.message }; }
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

    // Build a browser-playable proxy directly from a native filesystem path.
    // mediaOpenFile above is owned by the Electron AVFoundation engine, whose
    // playerId is not known to the Python companion.  Re-open the same path in
    // the companion before asking it to build the cached H.264 proxy; this
    // avoids uploading/copying multi-GB ProRes files through the renderer.
    if (type === 'buildMediaProxy' && payload?.path) {
      if (!companion?.isReady) {
        return { ok: false, error: { code: 'COMPANION_UNAVAILABLE', message: 'Native companion is not running' } };
      }
      try {
        const opened = await companion.call({ action: 'openFile', path: payload.path }, timeoutMs);
        if (opened?.status === 'error' || opened?.error) {
          const e = opened.error || {};
          throw new Error(e.message || e.userMessage || 'Companion could not open the media path');
        }
        const companionAssetId = opened?.data?.assetId;
        if (!companionAssetId) throw new Error('Companion returned no media asset ID');
        const built = await companion.call({ action: 'buildMediaProxy', assetId: companionAssetId }, timeoutMs);
        if (built?.status === 'error' || built?.error) {
          const e = built.error || {};
          throw new Error(e.message || e.userMessage || 'Companion could not start the proxy');
        }
        return { ok: true, result: built?.data || {} };
      } catch (err) {
        return { ok: false, error: { code: 'PROXY_BUILD_ERROR', message: err.message } };
      }
    }

    // ── OCF folder picker ─────────────────────────────────────────────────────
    // nativePickOcfFolder() in native_helper_client.js sends 'ocfPickFolder'.
    // Show a native directory picker and return { path } so _nativePayload()
    // unwraps correctly in vfxPullPanel.js _chooseAndRelinkOcf().
    if (type === 'ocfPickFolder') {
      try {
        const { canceled, filePaths } = await dialog.showOpenDialog(_activeWindow, {
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

  // Policy calls run in the trusted main process. The renderer keeps
  // webSecurity enabled and never needs a CORS exception for Apps Script.
  ipcMain.handle('pfx:policy-request', async (_e, { path: route, method = 'GET', params = {}, body = null } = {}) => {
    // Keep this list in sync with every route exposed by policyApi.js. The
    // renderer cannot call Apps Script directly in Electron (CORS/webSecurity),
    // so omitting a route here silently turns a valid backend feature into a
    // network-looking failure. The allowlist remains explicit so arbitrary
    // renderer-controlled paths can never be proxied by the trusted process.
    const allowedRoutes = new Set([
      'health',
      'licenseCheck',
      'registerOrPingUser',
      'requestLink',
      'checkLink',
      'featureFlags',
      'annotateCatalog',
      'annotateTrack',
      'request',
      'logEvent',
      'auth/logout',
    ]);
    const routeName = String(route || '').trim();
    if (!allowedRoutes.has(routeName)) return { ok: false, status: 400, error: 'unsupported_policy_route' };
    const baseUrl = _getPostflowxAuthApiUrl();
    if (!baseUrl || !baseUrl.startsWith('https://')) return { ok: false, status: 503, error: 'policy_service_not_configured' };
    try {
      const url = new URL(baseUrl);
      if (url.hostname === 'script.google.com') url.searchParams.set('path', routeName);
      else url.pathname = `${url.pathname.replace(/\/$/, '')}/${routeName}`;
      for (const [key, value] of Object.entries(params || {})) {
        if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value));
      }
      const requestMethod = String(method || 'GET').toUpperCase();
      const response = await fetch(url, {
        method: requestMethod,
        headers: requestMethod === 'GET' ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: requestMethod === 'GET' ? undefined : JSON.stringify(body || {}),
        redirect: 'follow',
        signal: AbortSignal.timeout(12000),
      });
      const data = await response.json().catch(() => null);
      return { ok: response.ok, status: response.status, data };
    } catch (error) {
      return { ok: false, status: 0, error: error?.name === 'TimeoutError' ? 'policy_timeout' : 'policy_unreachable' };
    }
  });

  // ── Downloads (chrome.downloads.download shim) ───────────────────────────

  // Real chrome.downloads.download() defaults conflictAction to 'uniquify'
  // (rename to "name (1).ext" etc.) rather than overwriting an existing file.
  // Mirror that here for the silent-write path, which is the only one that
  // writes bytes directly ourselves via fs.writeFileSync.
  function _uniquifyPath(filePath) {
    if (!fs.existsSync(filePath)) return filePath;
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    for (let i = 1; ; i++) {
      const candidate = path.join(dir, `${base} (${i})${ext}`);
      if (!fs.existsSync(candidate)) return candidate;
    }
  }

  ipcMain.handle('pfx:download', async (_e, { url, filename, dataUrl, saveAs, conflictAction } = {}) => {
    const defaultPath = path.join(app.getPath('downloads'), filename || 'download');

    // saveAs === false means caller wants a silent write — no dialog
    if (saveAs === false) {
      try {
        fs.mkdirSync(path.dirname(defaultPath), { recursive: true });
        if (dataUrl) {
          const finalPath = conflictAction === 'overwrite' ? defaultPath : _uniquifyPath(defaultPath);
          const [, b64] = dataUrl.split(',');
          fs.writeFileSync(finalPath, Buffer.from(b64, 'base64'));
          return { ok: true, filePath: finalPath };
        }
        _activeWindow.webContents.downloadURL(url);
        return { ok: true, filePath: defaultPath };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }

    const { canceled, filePath } = await dialog.showSaveDialog(_activeWindow, { defaultPath });
    // `canceled` rides along with ok:false. Without it the renderer cannot tell
    // "the user closed the dialog" from "the write threw", and the save cascade
    // in reviews / visual QC responded to the former by opening another dialog
    // and eventually writing the file anyway.
    if (canceled || !filePath) return { ok: false, canceled: true };

    try {
      if (dataUrl) {
        const [, b64] = dataUrl.split(',');
        const buf = Buffer.from(b64, 'base64');
        fs.writeFileSync(filePath, buf);
        shell.showItemInFolder(filePath);
        return { ok: true, filePath };
      }
      _activeWindow.webContents.downloadURL(url);
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

  // pfx:imf:hashFile { filePath, algorithm } → { ok, algorithm, hashBase64 } | { ok:false, error }
  //   Streams the file through node crypto so files >2 GB (most UHD MXF essence)
  //   are hashed rather than silently skipped. algorithm: 'sha1' | 'sha256'.
  ipcMain.handle('pfx:imf:hashFile', async (_e, { filePath, algorithm = 'sha256' } = {}) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: 'file not found' };
      const algo = String(algorithm).toLowerCase() === 'sha1' ? 'sha1' : 'sha256';
      const crypto = require('crypto');
      const hash = crypto.createHash(algo);
      await new Promise((resolve, reject) => {
        const rs = fs.createReadStream(filePath, { highWaterMark: 8 * 1024 * 1024 });
        rs.on('data', (chunk) => hash.update(chunk));
        rs.on('error', reject);
        rs.on('end', resolve);
      });
      return { ok: true, algorithm: algo, hashBase64: hash.digest('base64') };
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
        const outputPng = path.join(require('os').tmpdir(), `postflowx_imf_frame_${process.pid}_${frameNumber}_${Date.now()}.png`);
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
    const outputPng = path.join(os.tmpdir(), `postflowx_imf_frame_${process.pid}_${frameNumber}_${Date.now()}.png`);
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
          if (res.trackFileId && !idx.assetMap.has(res.trackFileId)) missingVideo++;
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

  // Meechum / Edward OAuth configuration. Public desktop builds intentionally
  // contain no client secret: PKCE is used for the authorization-code exchange.
  function _getMeechumConfig() {
    const nodePath = require('path');
    let userCfg = {};
    try {
      userCfg = _tryReadJson(nodePath.join(app.getPath('userData'), 'pfx-auth-config.json')) || {};
    } catch {}
    const runtimeCfg = _getRuntimeConfig();
    const loopbackEnv = process.env.POSTFLOWX_MEECHUM_LOOPBACK_REDIRECTS;
    return {
      clientId: process.env.POSTFLOWX_MEECHUM_CLIENT_ID
        || userCfg.meechumClientId || runtimeCfg.meechumClientId || '',
      issuer: process.env.POSTFLOWX_MEECHUM_ISSUER
        || userCfg.meechumIssuer || runtimeCfg.meechumIssuer
        || 'https://meechum.prod.netflix.net/',
      redirectUri: process.env.POSTFLOWX_MEECHUM_REDIRECT_URI
        || userCfg.meechumRedirectUri || runtimeCfg.meechumRedirectUri || '',
      scopes: process.env.POSTFLOWX_MEECHUM_SCOPES
        || userCfg.meechumScopes || runtimeCfg.meechumScopes || 'openid profile default',
      // Meechum/Edward auth strategy. 'NetflixPartnerLogin' (prod) or
      // 'NetflixPartnerTestLogin' (test) admits partner (Pandora-managed)
      // accounts; empty = workforce-only. Must match the Edward client config
      // (go/edward) — this is only the request-level hint. See docs/PARTNER_AUTH.md.
      authStrategy: process.env.POSTFLOWX_MEECHUM_AUTH_STRATEGY
        || userCfg.meechumAuthStrategy || runtimeCfg.meechumAuthStrategy || '',
      // Disabled by default because Edward exact-matches loopback callback URLs.
      // Enable only after every fixed callback below is registered on the client.
      loopbackRedirects: loopbackEnv !== undefined
        ? loopbackEnv === 'true'
        : userCfg.meechumLoopbackRedirects === true
          || runtimeCfg.meechumLoopbackRedirects === true,
      // Optional for local testing only. Never put this value in authConfig.json
      // or another file shipped inside the application bundle.
      clientSecret: process.env.POSTFLOWX_MEECHUM_CLIENT_SECRET
        || userCfg.meechumClientSecret || '',
    };
  }

  function _isMeechumConfigured(cfg = _getMeechumConfig()) {
    if (!cfg.clientId || !cfg.redirectUri) return false;
    try {
      const issuer = new URL(cfg.issuer);
      const redirect = new URL(cfg.redirectUri);
      return issuer.protocol === 'https:' && redirect.protocol === 'https:';
    } catch { return false; }
  }

  function _meeEndpoint(cfg, endpoint) {
    return new URL(endpoint, cfg.issuer).toString();
  }

  function _saveMeechumToken(tokenJson) {
    try {
      const { safeStorage } = require('electron');
      const nodePath = require('path');
      const nodeFs = require('fs');
      if (!safeStorage.isEncryptionAvailable()) return;
      const enc = safeStorage.encryptString(JSON.stringify(tokenJson));
      nodeFs.writeFileSync(nodePath.join(app.getPath('userData'), 'pfx-meechum-token.enc'), enc);
    } catch {}
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
    const nodePath = require('path');
    // Resources/authConfig.json — replaceable post-build without repacking.
    const runtimeCfg = _getRuntimeConfig();
    if (runtimeCfg.postflowxAuthApiUrl) return runtimeCfg.postflowxAuthApiUrl;
    // Bundled build-time config inside the asar. _getGoogleClientId has always
    // read this as its second line of defence; this function did not, so a
    // single empty value in Resources/authConfig.json was enough to take the
    // whole access-policy check offline with nothing to fall back on.
    const gen = _tryReadJson(nodePath.join(__dirname, 'generated', 'authConfig.generated.json'));
    if (gen?.postflowxAuthApiUrl) return gen.postflowxAuthApiUrl;
    // Post-install user config in OS userData — lets an admin repair a shipped
    // build in place, without a reinstall.
    try {
      const cfg = _tryReadJson(nodePath.join(app.getPath('userData'), 'pfx-auth-config.json'));
      if (cfg?.postflowxAuthApiUrl) return cfg.postflowxAuthApiUrl;
    } catch {}
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

  // ── PFX desktop session (role/permissions/token) — safeStorage-encrypted ──
  // Mirrors the Google-token pattern above, but with a read/clear path too,
  // since the renderer needs this back on every boot (unlike the Google token,
  // which the renderer never reads directly).
  function _sessionEncPath() {
    const { app } = require('electron');
    const nodePath = require('path');
    return nodePath.join(app.getPath('userData'), 'pfx-session.enc');
  }

  function _saveSessionEnc(sessionJson) {
    try {
      const { safeStorage } = require('electron');
      const nodeFs = require('fs');
      if (!safeStorage.isEncryptionAvailable()) return false;
      const enc = safeStorage.encryptString(JSON.stringify(sessionJson));
      nodeFs.writeFileSync(_sessionEncPath(), enc);
      return true;
    } catch { return false; }
  }

  function _loadSessionEnc() {
    try {
      const { safeStorage } = require('electron');
      const nodeFs = require('fs');
      const p = _sessionEncPath();
      if (!nodeFs.existsSync(p)) return null;
      if (!safeStorage.isEncryptionAvailable()) return null;
      const enc = nodeFs.readFileSync(p);
      return JSON.parse(safeStorage.decryptString(enc));
    } catch { return null; }
  }

  function _clearSessionEnc() {
    try {
      const nodeFs = require('fs');
      const p = _sessionEncPath();
      if (nodeFs.existsSync(p)) nodeFs.unlinkSync(p);
    } catch {}
  }

  // Reports whether a valid client ID is present (used by renderer to show/hide button).
  ipcMain.handle('pfx:is-google-auth-configured', () => {
    return { configured: _isGoogleClientIdValid(_getGoogleClientId()) };
  });

  ipcMain.handle('pfx:is-enterprise-auth-configured', () => {
    return { configured: _isMeechumConfigured() };
  });

  ipcMain.handle('pfx:enterprise-auth-debug', () => {
    const cfg = _getMeechumConfig();
    return {
      configured: _isMeechumConfigured(cfg),
      provider: 'Meechum',
      clientId: cfg.clientId,
      issuer: cfg.issuer,
      redirectUri: cfg.redirectUri,
      scopes: cfg.scopes,
      authStrategy: cfg.authStrategy || null,
      partnerLoginEnabled: /partner/i.test(cfg.authStrategy || ''),
      isPackaged: app.isPackaged,
      devBypassEnabled: _isDevAuthBypassEnabled(),
      postflowxApiConfigured: _isPostflowxApiConfigured(),
    };
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

  // Synchronous PFX session storage — boot-guard.js reads/writes this on its
  // no-await Electron boot path, so these must stay sync (mirrors the channel above).
  ipcMain.on('pfx:session-load-sync', (event) => {
    event.returnValue = _loadSessionEnc();
  });
  ipcMain.on('pfx:session-save-sync', (event, sessionJson) => {
    event.returnValue = _saveSessionEnc(sessionJson);
  });
  ipcMain.on('pfx:session-clear-sync', (event) => {
    _clearSessionEnc();
    event.returnValue = true;
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

  // Netflix Team Workspaces authentication. That app uses Netflix's supported
  // nflx-access SDK instead of owning an Edward client/callback. Use the same SDK
  // and registered `nflxaccess-client-prod` flow, but keep PostFlowX credentials
  // isolated inside PostFlowX's own userData directory.
  function _loadNflxAccess() {
    const candidates = [
      'nflx-access',
      '/Applications/Netflix Team Workspaces.app/Contents/Resources/app.asar/node_modules/nflx-access',
    ];
    for (const candidate of candidates) {
      try { return require(candidate); } catch {}
    }
    return null;
  }

  function _postflowxNflxAccessCredentialsPath() {
    const nodePath = require('path');
    return process.env.POSTFLOWX_NFLX_ACCESS_CERTS_PATH
      || nodePath.join(app.getPath('userData'), 'nflxaccess');
  }

  function _nflxAccessCredentialsAreValid(info) {
    if (!info?.notBefore || !info?.notAfter) return false;
    const now = Date.now();
    return new Date(info.notBefore).getTime() <= now
      && now < new Date(info.notAfter).getTime();
  }

  async function _runTeamWorkspacesAuthentication() {
    const certsPath = _postflowxNflxAccessCredentialsPath();
    process.env.NFLX_ACCESS_CERTS_PATH = certsPath;
    try { fs.mkdirSync(certsPath, { recursive: true }); } catch {}

    // Set the isolated path before loading nflx-access. The SDK reads this
    // environment variable during module initialization; loading it first
    // makes it fall back to Team Workspaces' credential store.
    const nflxAccess = _loadNflxAccess();
    if (!nflxAccess) return { ok: false, error: 'NFLX_ACCESS_UNAVAILABLE' };

    try {
      let credentials = await nflxAccess.getCredentialsInfo(certsPath);
      if (!_nflxAccessCredentialsAreValid(credentials)) {
        await nflxAccess.renewCredentials({
          targetPath: certsPath,
          skipClearMetatronCertificates: true,
          env: 'prod',
          authStrategy: 'NetflixPartnerLogin',
          // Let nflx-access open Meechum itself. Returning false here
          // suppresses its browser launch and leaves the app on the login card.
          authUrlCallback: () => true,
        });
        credentials = await nflxAccess.getCredentialsInfo(certsPath);
      }
      if (!_nflxAccessCredentialsAreValid(credentials)) {
        return { ok: false, error: 'Netflix authentication completed without valid client credentials.' };
      }

      // Team Workspaces maps the authenticated Netflix certificate to the local
      // managed macOS account. Keep that behavior identical for interoperability.
      const userName = String(process.env.USER || '').trim();
      if (!userName) return { ok: false, error: 'Unable to determine the managed Netflix account on this Mac.' };
      const email = userName.includes('@') ? userName.toLowerCase() : `${userName.toLowerCase()}@netflix.com`;
      const user = { email, name: userName, picture: '' };

      const apiUrl = _getPostflowxAuthApiUrl();
      if (!_isPostflowxApiConfigured()) {
        return { ok: false, error: 'PostFlowX access policy service is not configured for this build.' };
      }
      const policyUrl = new URL(apiUrl);
      policyUrl.searchParams.set('path', 'licenseCheck');
      policyUrl.searchParams.set('email', email);
      const policyResponse = await fetch(policyUrl, { headers: { Accept: 'application/json' } });
      const policy = await policyResponse.json().catch(() => ({}));
      if (!policyResponse.ok || !policy.ok) {
        // A previously approved user can continue during a policy-service
        // outage/deployment mismatch, but only with the encrypted session that
        // is already on this Mac, only when it belongs to the same account, and
        // only until its original expiry. Never synthesize access here.
        if (policy.error === 'not_found' || policy.status === 'not_found') {
          const cached = _loadSessionEnc();
          const cachedEmail = String(cached?.user?.email || '').trim().toLowerCase();
          const cachedExpiry = new Date(cached?.session?.expiresAt || cached?.expiresAt || 0).getTime();
          if (cached?.ok && cachedEmail === email && cachedExpiry > Date.now()) {
            return {
              ok: true,
              email,
              name: userName,
              picture: '',
              accessToken: '',
              pfxSession: cached,
              policyWarning: 'PostFlowX policy service is unavailable; using your existing unexpired session.',
            };
          }
        }
        // Normalize the "no active access for this email" result to a clean
        // status the login card can present as a friendly, localized message.
        // A legacy `error:'not_found'` and the current `status:'pending'` both
        // mean the same thing — this account is not provisioned — so surface
        // that, never the raw `not_found` token (which used to leak to the UI).
        const rawStatus = String(policy.status || '').trim().toLowerCase();
        const rawError  = String(policy.error  || '').trim().toLowerCase();
        if (rawStatus === 'pending' || rawStatus === 'not_found' || rawError === 'not_found') {
          return { ok: false, status: 'pending' };
        }
        if (rawStatus === 'disabled' || rawError === 'account_disabled') {
          return { ok: false, status: 'disabled' };
        }
        return {
          ok: false,
          status: policy.status || '',
          error: policy.error || `PostFlowX access policy HTTP ${policyResponse.status}`,
        };
      }

      const certExpiry = new Date(credentials.notAfter).toISOString();
      return {
        ok: true,
        email,
        name: userName,
        picture: '',
        accessToken: '',
        pfxSession: {
          ok: true,
          status: 'active',
          user,
          role: policy.role || 'viewer',
          permissions: {
            tabs: policy.allowedTabs || policy.permissions?.tabs || [],
            actions: policy.allowedActions || policy.permissions?.actions || [],
          },
          featureFlags: policy.featureFlags || {},
          session: {
            token: '',
            expiresAt: policy.expiresAt || certExpiry,
          },
        },
      };
    } catch (error) {
      return { ok: false, error: `Netflix Team Workspaces sign-in failed: ${error.message}` };
    }
  }

  async function _runMeechumSystemBrowserOAuth(mainWindow, cfg) {
    const crypto = require('crypto');
    const http   = require('http');
    const apiUrl = _getPostflowxAuthApiUrl();
    if (!_isPostflowxApiConfigured()) {
      const forPartners = /partner/i.test(cfg.authStrategy || '');
      return {
        ok: false,
        error: forPartners
          ? 'Partner sign-in is enabled but the PostFlowX auth service (postflowxAuthApiUrl) that exchanges Meechum tokens is not configured for this build. Ask your PostFlowX admin to set postflowxAuthApiUrl, and confirm the Edward client uses the NetflixPartnerLogin auth strategy.'
          : 'Netflix sign-in needs the PostFlowX auth service to exchange the Meechum token, but postflowxAuthApiUrl is not set for this build. Ask your PostFlowX admin to configure it (see docs/PARTNER_AUTH.md).',
      };
    }

    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(24).toString('base64url');

    // Loopback (127.0.0.1) redirect — matches Netflix Team Workspaces and the
    // Google flow above. A short-lived local HTTP server catches the auth-code
    // redirect automatically, so the user never copies/pastes anything.
    //
    // FIXED ports (not ephemeral): Edward exact-matches the callback URL INCLUDING
    // the port, so a random port can never be in the allow-list (that was the
    // `unauthorized_client — Callback URL mismatch` error). We bind the first free
    // port from this fixed set; register EVERY one of these as an allowed redirect
    // URI on the Edward client (go/edward) — see docs/PARTNER_AUTH.md:
    //   http://127.0.0.1:51900/oauth2/callback
    //   http://127.0.0.1:8477/oauth2/callback
    //   http://127.0.0.1:8478/oauth2/callback
    //   http://127.0.0.1:8479/oauth2/callback
    let resolveCode, rejectCode;
    const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/oauth2/callback') { res.writeHead(404); res.end(); return; }
      const returnedState = u.searchParams.get('state');
      const code  = u.searchParams.get('code');
      const error = u.searchParams.get('error_description') || u.searchParams.get('error');
      if (error || !code || returnedState !== state) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<html><body style="font:16px system-ui,sans-serif;text-align:center;padding:60px 40px;color:#e8eaf0;background:#0e0f13"><h2 style="margin:0 0 8px">&#x274C; Netflix sign-in failed</h2><p style="color:#888;margin:0">You can close this browser tab and try again.</p></body></html>');
        if (error) { rejectCode(new Error(error)); }
        else if (returnedState !== state) { rejectCode(new Error('The sign-in response did not match this PostFlowX request. Please start again.')); }
        else { rejectCode(new Error('Invalid OAuth response')); }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<html><body style="font:16px system-ui,sans-serif;text-align:center;padding:60px 40px;color:#e8eaf0;background:#0e0f13"><h2 style="margin:0 0 8px">&#x2713; Signed in to PostFlowX</h2><p style="color:#888;margin:0">You can close this browser tab.</p></body></html>');
      resolveCode(code);
    });
    // 51900 is the callback registered on the existing PostFlowX Edward client.
    // Keep the newer fallback ports for environments where they are also allowed.
    const MEE_LOOPBACK_PORTS = [51900, 8477, 8478, 8479];
    let boundPort = 0;
    for (const p of MEE_LOOPBACK_PORTS) {
      try {
        await new Promise((res, rej) => {
          const onErr = (e) => { server.removeListener('error', onErr); rej(e); };
          server.once('error', onErr);
          server.listen(p, '127.0.0.1', () => { server.removeListener('error', onErr); res(); });
        });
        boundPort = p;
        break;
      } catch { /* port busy — try the next fixed port */ }
    }
    if (!boundPort) {
      try { server.close(); } catch {}
      return { ok: false, error: `Netflix sign-in needs one of these local ports free: ${MEE_LOOPBACK_PORTS.join(', ')}. Close whatever is using it and try again.` };
    }
    const port        = boundPort;
    const redirectUri = `http://127.0.0.1:${port}/oauth2/callback`;

    const authParams = {
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: cfg.scopes,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    };
    // Request the partner login experience when configured. The authoritative
    // control is the Edward client's auth_strategy (go/edward); this hint just
    // asks Meechum to surface the partner IdP handoff for this authorization
    // request. Omitted entirely when unset, so workforce-only is unchanged.
    if (cfg.authStrategy) authParams.auth_strategy = cfg.authStrategy;
    const authorizationUrl = _meeEndpoint(cfg, '/as/authorization.oauth2') + '?' + new URLSearchParams(authParams);

    // Registered HTTPS redirect (already allow-listed on the Edward client) for the
    // paste fallback — lets sign-in work before the loopback URLs are added to Edward.
    const httpsRedirect = cfg.redirectUri || 'https://postflowx.netflix.net/oauth2/callback';
    const buildHttpsAuthUrl = () => {
      const p = { client_id: cfg.clientId, redirect_uri: httpsRedirect, response_type: 'code',
        scope: cfg.scopes, code_challenge: challenge, code_challenge_method: 'S256', state };
      if (cfg.authStrategy) p.auth_strategy = cfg.authStrategy;
      return _meeEndpoint(cfg, '/as/authorization.oauth2') + '?' + new URLSearchParams(p);
    };
    // Parse a pasted callback URL → authorization code (origin-agnostic; checks state).
    const parsePastedCallback = (raw) => {
      let u;
      try { u = new URL(String(raw || '').trim()); }
      catch { throw new Error('That is not a valid URL. Copy the full address from the browser after signing in.'); }
      const err = u.searchParams.get('error_description') || u.searchParams.get('error');
      if (err) throw new Error(err);
      if (u.searchParams.get('state') !== state) throw new Error('The sign-in response did not match this request. Please start again.');
      const c = u.searchParams.get('code');
      if (!c) throw new Error('That URL has no authorization code — finish Netflix sign-in first, then copy the full address.');
      return c;
    };

    // Workforce and partner IdP handoffs need a full browser — never an embedded
    // webview. The registered HTTPS callback is the safe default. Only offer the
    // seamless loopback method when an administrator explicitly confirms that all
    // fixed callbacks are registered in Edward; otherwise it produces the exact
    // `unauthorized_client — Callback URL mismatch` page this fallback avoids.
    const pick = cfg.loopbackRedirects
      ? await dialog.showMessageBox(mainWindow, {
          type: 'question',
          title: 'Sign in to Netflix',
          message: 'How do you want to finish Netflix sign-in?',
          detail: `Automatic returns to PostFlowX by itself. Paste callback URL uses the registered HTTPS callback.`,
          buttons: ['Automatic', 'Paste callback URL', 'Cancel'],
          defaultId: 0, cancelId: 2, noLink: true,
        })
      : { response: 1 };
    if (pick.response === 2) { try { server.close(); } catch {} return { ok: false, error: 'Sign-in cancelled' }; }

    let code;
    let usedRedirect = redirectUri;
    if (pick.response === 0) {
      // ── Automatic: the loopback server above captures the code ──
      shell.openExternal(authorizationUrl);
      try {
        code = await Promise.race([
          codePromise,
          new Promise((_, rej) => setTimeout(() => rej(new Error('Netflix sign-in timed out (5 min). If the browser showed "unauthorized_client", add the loopback URLs to Edward or use Paste callback URL.')), 300_000)),
        ]);
      } catch (e) { try { server.close(); } catch {} return { ok: false, error: e.message }; }
      try { server.close(); } catch {}
    } else {
      // ── Paste fallback: registered HTTPS redirect + manual copy-paste ──
      try { server.close(); } catch {}   // loopback not used in this path
      usedRedirect = httpsRedirect;
      await shell.openExternal(buildHttpsAuthUrl());
      code = '';
      let lastError = '';
      for (let attempt = 0; attempt < 3 && !code; attempt += 1) {
        const choice = await dialog.showMessageBox(mainWindow, {
          type: lastError ? 'warning' : 'info',
          title: 'Paste the callback URL',
          message: lastError || 'Sign in using the browser that just opened.',
          detail: 'After you sign in, the browser tries to open a page that will not load — that is expected. Copy the FULL address from the browser address bar, come back here, and click Paste callback URL.',
          buttons: ['Paste callback URL', 'Open browser again', 'Cancel'],
          defaultId: 0, cancelId: 2, noLink: true,
        });
        if (choice.response === 2) return { ok: false, error: 'Sign-in cancelled' };
        if (choice.response === 1) { await shell.openExternal(buildHttpsAuthUrl()); attempt -= 1; lastError = ''; continue; }
        try { code = parsePastedCallback(clipboard.readText()); }
        catch (err) { lastError = err.message; }
      }
      if (!code) return { ok: false, error: lastError || 'No valid callback URL was pasted.' };
    }

    try {
      const exchangeUrl = new URL(apiUrl);
      exchangeUrl.searchParams.set('path', 'auth/meechum');
      const exchangeResponse = await fetch(exchangeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ code, codeVerifier: verifier, redirectUri: usedRedirect }),
      });
      const result = await exchangeResponse.json().catch(() => ({}));
      if (!exchangeResponse.ok || !result.ok) {
        return {
          ok: false,
          status: result.status || '',
          error: result.error || `PostFlowX auth service HTTP ${exchangeResponse.status}`,
        };
      }
      const user = result.user || {};
      const pfxSession = {
        ok: true,
        status: 'active',
        user,
        role: result.role || 'viewer',
        permissions: result.permissions || { tabs: [], actions: [] },
        featureFlags: result.featureFlags || {},
        session: {
          token: result.sessionToken || '',
          expiresAt: result.expiresAt || new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
        },
      };
      return {
        ok: true,
        email: user.email || '',
        name: user.name || '',
        picture: user.picture || '',
        accessToken: '',
        pfxSession,
      };
    } catch (error) {
      return { ok: false, error: `Secure sign-in exchange failed: ${error.message}` };
    }
  }

  ipcMain.handle('pfx:meechum-oauth', async () => {
    const cfg = _getMeechumConfig();

    // nflx-access client certificates prove that this Mac has a valid Netflix
    // credential, but they do not expose the Pandora/Meechum email that was
    // authenticated. The Team Workspaces compatibility path therefore maps the
    // local macOS username to @netflix.com and cannot safely identify a partner.
    // A partner-enabled Edward client must always use browser OAuth so the
    // backend returns the verified userinfo email (workforce or partner).
    const partnerLoginEnabled = /partner/i.test(cfg.authStrategy || '');
    if (partnerLoginEnabled) {
      if (!_isMeechumConfigured(cfg)) {
        return { ok: false, error: 'MEECHUM_DESKTOP_CLIENT_MISSING' };
      }
      return _runMeechumSystemBrowserOAuth(_activeWindow, cfg);
    }

    // Workforce-only builds may keep the Team Workspaces certificate shortcut.
    const workspaceResult = await _runTeamWorkspacesAuthentication();
    if (workspaceResult.ok || workspaceResult.error !== 'NFLX_ACCESS_UNAVAILABLE') {
      return workspaceResult;
    }
    if (!_isMeechumConfigured(cfg)) {
      return { ok: false, error: 'MEECHUM_DESKTOP_CLIENT_MISSING' };
    }
    return _runMeechumSystemBrowserOAuth(_activeWindow, cfg);
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
            // Pass through the backend status (e.g. 'pending' / 'disabled') so the
            // renderer can show the right message instead of a raw "Backend HTTP 200".
            return {
              ok:     false,
              status: bd.status,
              error:  bd.error || (bd.status ? undefined : `Backend HTTP ${br.status}`),
            };
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
    if (_activeWindow && !_activeWindow.isDestroyed()) {
      _activeWindow.webContents.send('pfx:fromMain', msg);
    }
  });
}

module.exports = { register };
