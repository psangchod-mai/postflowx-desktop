'use strict';

/**
 * native_router.js — Native command router for PostFlowX Electron app.
 *
 * Routes typed command objects { type, payload } to the appropriate handler:
 *   - Simple operations (ping, paths, file ops)  → handled in Node.js
 *   - Resolve operations                          → companion or resolve_bridge.py fallback
 *   - Media probe / extract-still                 → companion or ffprobe/qlmanage
 *
 * Registered to the pfx:native-command IPC channel in ipc.js.
 */

const { app, shell } = require('electron');
const { spawn }      = require('child_process');
const path           = require('path');
const fs             = require('fs');
const os             = require('os');
// Absolute ffprobe path — GUI-launched apps have a stripped PATH (no
// /opt/homebrew/bin), so a bare spawn('ffprobe') ENOENTs in production.
const { FFPROBE }    = require('./ffbins');

// resolve_bridge.py is asar-unpacked; redirect from app.asar → app.asar.unpacked
// so Python can read it (a path inside the asar archive isn't a real file).
const BRIDGE_SCRIPT = path.join(__dirname, 'resolve_bridge.py')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// All actions this router owns.
const HANDLED = new Set([
  'helper.ping', 'helper.capabilities',
  'app.paths', 'file.exists', 'folder.reveal',
  'media.probe', 'media.extractStill',
  'resolve.status', 'resolve.detect', 'resolve.engineStatus',
  'resolve.extractStillFrame', 'resolve.renderEXR.prepare',
]);

// Companion action name mapping (some have different legacy names in the Python side).
const COMPANION_MAP = {
  'resolve.status':            'resolveStatus',
  'resolve.extractStillFrame': 'resolve.extractStillFrame',
  'resolve.renderEXR.prepare': 'resolve.renderEXR.prepare',
  'media.probe':               'mediaProbe',
  'media.extractStill':        'vfx.preview.avfStill',
};

let _companion = null;

/** Call this once with the companion instance so Resolve routes can reach it. */
function init(companionInstance) {
  _companion = companionInstance;
}

/** Returns true if this router owns the given action type. */
function handles(type) {
  return HANDLED.has(type);
}

// ── App-path helpers ─────────────────────────────────────────────────────────

function _getAppPaths() {
  const userData = app.getPath('userData');
  return {
    userData,
    cache:  path.join(userData, 'cache', 'vfxpull'),
    logs:   path.join(userData, 'logs'),
    config: path.join(userData, 'settings.json'),
  };
}

function _ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
}

/** Create all required directories on first use. */
function ensureAppDirs() {
  const p = _getAppPaths();
  _ensureDir(p.cache);
  _ensureDir(p.logs);
}

// ── Python helpers ───────────────────────────────────────────────────────────

function _findPython() {
  const candidates = [
    process.env.PFX_PYTHON,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    'python3',
  ].filter(Boolean);

  for (const p of candidates) {
    if (path.isAbsolute(p)) {
      try { if (fs.existsSync(p)) return p; } catch {}
    } else {
      return p; // bare name — let PATH resolve it
    }
  }
  return 'python3';
}

/**
 * Spawn resolve_bridge.py with a JSON command on stdin.
 * Returns the parsed JSON result from stdout.
 */
function _runResolveBridge(command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(BRIDGE_SCRIPT)) {
      return reject(new Error(`resolve_bridge.py not found: ${BRIDGE_SCRIPT}`));
    }

    const python = _findPython();
    const logDir = _getAppPaths().logs;
    _ensureDir(logDir);

    const proc = spawn(python, [BRIDGE_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env:   { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    let settled = false;
    const settle = (fn) => { if (!settled) { settled = true; fn(); } };

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      settle(() => reject(new Error('resolve_bridge.py timed out')));
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', () => {
      if (settled) return;
      clearTimeout(timer);
      if (stderr.trim()) {
        const logPath = path.join(logDir, 'resolve-bridge.log');
        try {
          fs.appendFileSync(logPath,
            `[${new Date().toISOString()}]\n${stderr.trim()}\n---\n`);
        } catch {}
      }
      settle(() => {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          reject(new Error(
            `resolve_bridge parse error: ${e.message}. stdout: ${stdout.slice(0, 200)}`));
        }
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      settle(() => reject(new Error(`resolve_bridge spawn failed: ${err.message}`)));
    });

    proc.stdin.write(JSON.stringify(command));
    proc.stdin.end();
  });
}

// ── Resolve status (Node-side fast path, no Python needed for basic checks) ──

function _isProcessRunning(name) {
  return new Promise((res) => {
    const ps = spawn('pgrep', ['-x', name]);
    ps.on('exit', (code) => res(code === 0));
    ps.on('error', () => res(false));
  });
}

async function _resolveStatusDirect() {
  const appBundle = '/Applications/DaVinci Resolve/DaVinci Resolve.app';
  const installed = fs.existsSync(appBundle);
  if (!installed) {
    return { ok: true, installed: false, running: false, connected: false,
             state: 'not_installed' };
  }
  // The main process binary is named "Resolve" (pgrep -x matches by exact name)
  const running = await _isProcessRunning('Resolve');
  if (!running) {
    return { ok: true, installed: true, running: false, connected: false,
             state: 'not_running' };
  }
  // Resolve is running — probe via Python bridge
  try {
    const result = await _runResolveBridge({ action: 'status' }, 10000);
    return {
      ok: true, installed: true, running: true,
      connected: !!result.connected,
      state: result.connected ? 'connected' : 'disconnected',
      resolveVersion: result.resolveVersion,
      currentProject: result.currentProject,
      error: result.error,
    };
  } catch (err) {
    return { ok: true, installed: true, running: true, connected: false,
             state: 'disconnected', error: err.message };
  }
}

// ── Resolve detect (install + scripting + API probe) ────────────────────────

const _SCRIPTING_PATHS = [
  '/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules',
  path.join(os.homedir(), 'Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules'),
];

function _resolveScriptingAvailable() {
  return _SCRIPTING_PATHS.some(p => { try { return fs.existsSync(p); } catch { return false; } });
}

async function _resolveDetect() {
  const appBundle = '/Applications/DaVinci Resolve/DaVinci Resolve.app';
  const installed = fs.existsSync(appBundle);
  if (!installed) {
    return { ok: true, found: false, resolvedPath: '', path: '', scriptingAvailable: false, apiAvailable: false, running: false, version: '' };
  }

  const scriptingAvailable = _resolveScriptingAvailable();
  const running = await _isProcessRunning('Resolve');

  let apiAvailable = false;
  let version = '';
  let currentProject = '';

  if (running && scriptingAvailable) {
    try {
      const status = await _runResolveBridge({ action: 'status' }, 10000);
      apiAvailable = !!status.connected;
      version = status.resolveVersion || '';
      currentProject = status.currentProject || '';
    } catch {}
  }

  return { ok: true, found: true, resolvedPath: appBundle, path: appBundle, version, running, scriptingAvailable, apiAvailable, currentProject };
}

// ── Companion proxy helper ───────────────────────────────────────────────────

async function _viaCompanion(type, payload, timeoutMs = 90000) {
  if (!_companion?.isReady) {
    throw Object.assign(
      new Error('Native companion is not running'),
      { code: 'COMPANION_UNAVAILABLE' });
  }
  const action = COMPANION_MAP[type] || type;
  const req    = { action, ...payload };
  const resp   = await _companion.call(req, timeoutMs);
  // Companion returns ResponseEnvelope { status, data, error }
  if (resp?.status === 'error' || resp?.error) {
    const e = resp.error || {};
    throw Object.assign(
      new Error(e.message || e.userMessage || 'Companion error'),
      { code: e.code || 'COMPANION_ERROR' });
  }
  return resp?.data ?? resp ?? {};
}

// ── Main route dispatcher ────────────────────────────────────────────────────

async function route({ type, payload = {} }) {
  switch (type) {

    // ── Simple Node.js ops ─────────────────────────────────────────────────
    case 'helper.ping':
      return { ok: true };

    case 'helper.capabilities':
      // If companion is ready, ask it for live capabilities (includes resolveConnected).
      if (_companion?.isReady) {
        try {
          const caps = await _viaCompanion('helper.capabilities', {}, 8000);
          return { ok: true, ...caps };
        } catch {}
      }
      // Static fallback
      return {
        ok: true,
        capabilities: {
          resolveExtractStillFrame: true,
          ffmpegFallback: true,
          mediaProbe: true,
          revealFolder: true,
          resolveConnected: false,
        },
      };

    case 'app.paths': {
      const paths = _getAppPaths();
      _ensureDir(paths.cache);
      _ensureDir(paths.logs);
      return { ok: true, paths };
    }

    case 'file.exists':
      return { ok: true, exists: !!(payload.path && fs.existsSync(payload.path)) };

    case 'folder.reveal':
      if (payload.path) shell.showItemInFolder(payload.path);
      return { ok: true };

    // ── Resolve ────────────────────────────────────────────────────────────
    case 'resolve.status':
      // Try companion first (richer data), fall back to Node-level detection.
      if (_companion?.isReady) {
        try {
          const r = await _viaCompanion('resolve.status', {}, 10000);
          return { ok: true, ...r };
        } catch {}
      }
      return _resolveStatusDirect();

    case 'resolve.detect':
      return _resolveDetect();

    case 'resolve.engineStatus': {
      const det = await _resolveDetect();
      return {
        ok: det.ok,
        found: det.found,
        resolvedPath: det.resolvedPath || '',
        resolvePath: det.resolvedPath || '',
        path: det.path || '',
        version: det.version || '',
        running: det.running || false,
        scriptingAvailable: det.scriptingAvailable || false,
        apiAvailable: det.apiAvailable || false,
        connected: det.apiAvailable || false,
        currentProject: det.currentProject || '',
        queueDepth: 0,
        engineSupported: true,
        state: det.apiAvailable ? 'connected' : (det.running ? 'running' : (det.found ? 'idle' : 'not_found')),
      };
    }

    case 'resolve.extractStillFrame':
      // Try companion (it has the full implementation).
      if (_companion?.isReady) {
        try {
          const r = await _viaCompanion(type, payload, 120000);
          return { ok: true, ...r };
        } catch (err) {
          if (err.code === 'COMPANION_UNAVAILABLE') throw err;
          // Companion failed — fall through to direct bridge
        }
      }
      // Direct bridge fallback
      try {
        const cacheDir = _getAppPaths().cache;
        _ensureDir(cacheDir);
        const r = await _runResolveBridge({
          action: 'extractStillFrame',
          ...payload,
          cacheDir,
        }, 120000);
        return r;
      } catch (bridgeErr) {
        return { ok: false, stage: 'bridge_error', error: bridgeErr.message,
                 requiresResolve: true };
      }

    case 'resolve.renderEXR.prepare':
      return { ok: true, status: 'stub',
               message: 'EXR render preparation is coming in a future release.' };

    // ── Media ──────────────────────────────────────────────────────────────
    case 'media.probe':
      if (_companion?.isReady) {
        try { return { ok: true, ...await _viaCompanion(type, payload, 30000) }; }
        catch {}
      }
      return _mediaProbeNative(payload);

    case 'media.extractStill':
      if (_companion?.isReady) {
        try { return { ok: true, ...await _viaCompanion(type, payload, 30000) }; }
        catch {}
      }
      return _mediaExtractStillNative(payload);

    default:
      throw new Error(`Unknown native action: ${type}`);
  }
}

// ── Native media probe (ffprobe) ─────────────────────────────────────────────

function _mediaProbeNative({ path: filePath } = {}) {
  return new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath)) {
      return resolve({ ok: false, error: `File not found: ${filePath}` });
    }
    const args = [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams',
      filePath,
    ];
    const proc = spawn(FFPROBE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    const ffprobeTimer = setTimeout(() => { proc.kill(); resolve({ ok: false, error: 'ffprobe timeout' }); }, 20000);
    proc.on('close', (code) => {
      clearTimeout(ffprobeTimer);
      if (code !== 0 || !out) return resolve({ ok: false, error: 'ffprobe failed', code });
      try { resolve({ ok: true, ...JSON.parse(out) }); }
      catch   { resolve({ ok: false, error: 'ffprobe output parse error' }); }
    });
    proc.on('error', (e) => { clearTimeout(ffprobeTimer); resolve({ ok: false, error: `ffprobe not found: ${e.message}` }); });
  });
}

// ── Native still extract (qlmanage / ffmpeg) ─────────────────────────────────

function _mediaExtractStillNative({ path: filePath, outputWidth = 640 } = {}) {
  return new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath)) {
      return resolve({ ok: false, error: `File not found: ${filePath}` });
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfx-still-'));
    const proc = spawn(
      '/usr/bin/qlmanage',
      ['-t', '-s', String(Math.max(outputWidth, 320)), '-o', tmpDir, filePath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let qlTimer = null;
    let settled = false;
    const cleanup = () => {
      if (qlTimer) { clearTimeout(qlTimer); qlTimer = null; }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    };
    const settle = (val) => { if (!settled) { settled = true; cleanup(); resolve(val); } };

    proc.on('close', () => {
      if (settled) return;
      try {
        const files = fs.readdirSync(tmpDir)
          .filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
        if (!files.length) {
          return settle({ ok: false, error: 'qlmanage produced no preview' });
        }
        const imgPath = path.join(tmpDir, files[0]);
        const raw     = fs.readFileSync(imgPath);
        const mime    = imgPath.endsWith('.png') ? 'image/png' : 'image/jpeg';
        const dataUrl = `data:${mime};base64,${raw.toString('base64')}`;
        settle({ ok: true, dataUrl, decoder: 'AVFoundation', extractor: 'avf' });
      } catch (e) {
        settle({ ok: false, error: e.message });
      }
    });
    proc.on('error', (e) => {
      settle({ ok: false, error: `qlmanage error: ${e.message}` });
    });
    qlTimer = setTimeout(() => {
      proc.kill();
      settle({ ok: false, error: 'qlmanage timeout' });
    }, 25000);
  });
}

module.exports = { handles, route, init, ensureAppDirs, getAppPaths: _getAppPaths };
