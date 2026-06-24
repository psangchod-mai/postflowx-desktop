'use strict';

/**
 * mpv_engine.js — MPV subprocess manager with JSON IPC socket control.
 *
 * Spawns mpv with --input-ipc-server for transport control.
 * mpv handles display in its own floating window.
 *
 * Binary search order:
 *   1. electron/native/mpv   (bundled)
 *   2. /opt/homebrew/bin/mpv (Apple Silicon Homebrew)
 *   3. /usr/local/bin/mpv    (Intel Homebrew / manual install)
 *   4. /usr/bin/mpv
 *
 * IPC protocol: newline-delimited JSON on a Unix socket.
 * Each command sends { "command": [...], "request_id": N }
 * Response: { "error": "success"|"...", "data": ..., "request_id": N }
 */

const { spawn } = require('child_process');
const net        = require('net');
const path       = require('path');
const fs         = require('fs');
const os         = require('os');

const BUNDLED_MPV = path.join(__dirname, 'mpv');
const SYSTEM_MPV_PATHS = [
  '/opt/homebrew/bin/mpv',
  '/usr/local/bin/mpv',
  '/usr/bin/mpv',
];

function _findMpv() {
  if (fs.existsSync(BUNDLED_MPV)) return BUNDLED_MPV;
  for (const p of SYSTEM_MPV_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Active sessions: sessionId → { proc, socketPath, filePath }
const _sessions = new Map();
let _nextId = 1;

function _socketPath(id) {
  return path.join(os.tmpdir(), `pfx-mpv-${id}.sock`);
}

// ── IPC helpers ───────────────────────────────────────────────────────────────

let _reqCounter = 1;

function _sendCommand(socketPath, command) {
  return new Promise((resolve, reject) => {
    const reqId = _reqCounter++;
    const msg   = JSON.stringify({ command, request_id: reqId }) + '\n';

    const client = net.createConnection(socketPath);
    const timer  = setTimeout(() => {
      client.destroy();
      reject(new Error(`MPV IPC timeout for command: ${command[0]}`));
    }, 5000);

    let buf = '';
    client.on('connect', () => { client.write(msg); });
    client.on('data', (chunk) => {
      buf += chunk.toString();
      // MPV sends event lines too; find the response with our request_id
      const lines = buf.split('\n');
      buf = lines.pop(); // keep partial last line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const r = JSON.parse(line);
          if (r.request_id === reqId) {
            clearTimeout(timer);
            client.destroy();
            if (r.error && r.error !== 'success') {
              reject(new Error(`MPV IPC error: ${r.error}`));
            } else {
              resolve(r.data ?? null);
            }
            return;
          }
        } catch {}
      }
    });
    client.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function _waitForSocket(socketPath, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(socketPath)) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`MPV socket not created at ${socketPath} within ${timeoutMs}ms`);
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function open({ path: filePath } = {}) {
  if (!filePath) throw new Error('path required');
  const mpvBin = _findMpv();
  if (!mpvBin) {
    throw Object.assign(
      new Error('mpv not found. Install mpv: brew install mpv'),
      { code: 'MPV_NOT_FOUND' }
    );
  }

  const sessionId  = `mpv-${_nextId++}`;
  const sockPath   = _socketPath(sessionId);

  // Clean up any stale socket from a previous crashed session
  try { fs.unlinkSync(sockPath); } catch {}

  const proc = spawn(mpvBin, [
    `--input-ipc-server=${sockPath}`,
    '--pause',          // start paused — caller calls play() when ready
    '--no-terminal',
    '--really-quiet',
    '--ontop',
    '--no-border',
    '--autofit=60%',    // float at 60% of screen width
    filePath,
  ], { stdio: 'ignore', detached: false });

  proc.on('close', () => {
    _sessions.delete(sessionId);
    try { fs.unlinkSync(sockPath); } catch {}
  });
  proc.on('error', (err) => {
    console.error('[MPVEngine] spawn error:', err.message);
    _sessions.delete(sessionId);
  });

  await _waitForSocket(sockPath);

  _sessions.set(sessionId, { proc, socketPath: sockPath, filePath });
  return { ok: true, sessionId };
}

async function play({ sessionId } = {}) {
  const s = _sessions.get(sessionId);
  if (!s) return { ok: false, error: 'Unknown sessionId' };
  await _sendCommand(s.socketPath, ['set_property', 'pause', false]);
  return { ok: true };
}

async function pause({ sessionId } = {}) {
  const s = _sessions.get(sessionId);
  if (!s) return { ok: false, error: 'Unknown sessionId' };
  await _sendCommand(s.socketPath, ['set_property', 'pause', true]);
  return { ok: true };
}

async function seek({ sessionId, position } = {}) {
  const s = _sessions.get(sessionId);
  if (!s) return { ok: false, error: 'Unknown sessionId' };
  await _sendCommand(s.socketPath, ['seek', position, 'absolute']);
  return { ok: true };
}

async function stepForward({ sessionId } = {}) {
  const s = _sessions.get(sessionId);
  if (!s) return { ok: false, error: 'Unknown sessionId' };
  await _sendCommand(s.socketPath, ['frame-step']);
  return { ok: true };
}

async function stepBack({ sessionId } = {}) {
  const s = _sessions.get(sessionId);
  if (!s) return { ok: false, error: 'Unknown sessionId' };
  await _sendCommand(s.socketPath, ['frame-back-step']);
  return { ok: true };
}

async function getTime({ sessionId } = {}) {
  const s = _sessions.get(sessionId);
  if (!s) return { ok: false, error: 'Unknown sessionId' };
  const time = await _sendCommand(s.socketPath, ['get_property', 'time-pos']);
  return { ok: true, time: time ?? 0 };
}

async function getDuration({ sessionId } = {}) {
  const s = _sessions.get(sessionId);
  if (!s) return { ok: false, error: 'Unknown sessionId' };
  const duration = await _sendCommand(s.socketPath, ['get_property', 'duration']);
  return { ok: true, duration: duration ?? 0 };
}

async function close({ sessionId } = {}) {
  const s = _sessions.get(sessionId);
  if (!s) return { ok: true };
  try { await _sendCommand(s.socketPath, ['quit']); } catch {}
  try { s.proc.kill('SIGTERM'); } catch {}
  _sessions.delete(sessionId);
  try { fs.unlinkSync(s.socketPath); } catch {}
  return { ok: true };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

const HANDLED = new Set([
  'media.mpv.open',
  'media.mpv.play',
  'media.mpv.pause',
  'media.mpv.seek',
  'media.mpv.stepForward',
  'media.mpv.stepBack',
  'media.mpv.getTime',
  'media.mpv.getDuration',
  'media.mpv.close',
]);

function handles(type) { return HANDLED.has(type); }

async function route({ type, payload = {} }) {
  switch (type) {
    case 'media.mpv.open':        return open(payload);
    case 'media.mpv.play':        return play(payload);
    case 'media.mpv.pause':       return pause(payload);
    case 'media.mpv.seek':        return seek(payload);
    case 'media.mpv.stepForward': return stepForward(payload);
    case 'media.mpv.stepBack':    return stepBack(payload);
    case 'media.mpv.getTime':     return getTime(payload);
    case 'media.mpv.getDuration': return getDuration(payload);
    case 'media.mpv.close':       return close(payload);
    default: throw new Error(`Unknown MPV action: ${type}`);
  }
}

module.exports = { handles, route, _findMpv };
