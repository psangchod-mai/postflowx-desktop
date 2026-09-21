'use strict';

/**
 * companion.js — Manages the PostFlowX Python companion subprocess.
 *
 * The companion runs in "native-host" mode using the same 4-byte
 * length-prefixed JSON protocol as Chrome native messaging. This lets us
 * reuse the existing native_host.py with zero changes.
 *
 * Protocol (identical to Chrome native messaging):
 *   send: write 4-byte LE uint32 (message length) + JSON bytes to stdin
 *   recv: read 4-byte LE uint32 + JSON bytes from stdout
 */

const { spawn }      = require('child_process');
const path           = require('path');
const fs             = require('fs');
const { EventEmitter } = require('events');

const COMPANION_READY_TIMEOUT_MS = 15000;
// Upper bound on a single length-prefixed message. Generous enough for large
// base64 frame payloads, but far below the ~GB values a random/desynced 4-byte
// prefix produces — used to detect and recover from protocol desync.
const MAX_COMPANION_MSG_BYTES = 256 * 1024 * 1024;
const CALL_TIMEOUT_MS            = 60000;

class CompanionBridge extends EventEmitter {
  constructor() {
    super();
    this._proc      = null;
    this._pending   = new Map();   // id → { resolve, reject, timer }
    this._idSeq     = 1;
    this._ready     = false;
    this._readBuf   = Buffer.alloc(0);
    this._appRoot   = path.join(__dirname, '..');
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async start() {
    if (this._proc) return;

    const python = this._findPython();
    if (!python) {
      console.warn('[Companion] Python 3 not found — companion features unavailable');
      this.emit('unavailable', 'Python 3 not found');
      return;
    }

    const companionSrc = this._companionSrc();
    if (!companionSrc) {
      console.warn('[Companion] companion/src not found');
      this.emit('unavailable', 'companion/src not found');
      return;
    }

    // A signed macOS app bundle must remain immutable after launch. Python's
    // default import cache writes __pycache__/*.pyc beside bundled sources,
    // which changes sealed resources and invalidates the app signature. Keep
    // imports read-only inside the bundle; runtime caches belong in user data.
    const env = {
      ...process.env,
      PYTHONPATH: companionSrc,
      PYTHONUNBUFFERED: '1',
      PYTHONDONTWRITEBYTECODE: '1',
    };

    this._proc = spawn(python, ['-m', 'postflowx_companion.app', '--mode', 'native-host'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this._proc.stdout.on('data', (chunk) => this._onData(chunk));
    this._proc.stderr.on('data', (d) => console.log('[Companion stderr]', d.toString().trimEnd()));
    // Writing to stdin after the subprocess has died surfaces as an async EPIPE
    // 'error' event on the stream, not a throw from write() — _sendRaw()'s
    // try/catch can't catch it. Without a listener here Node's default behavior
    // is to throw uncaught, crashing the whole Electron main process.
    this._proc.stdin.on('error', (err) => {
      console.warn('[Companion] stdin write error:', err.message);
    });
    this._proc.on('error', (err) => {
      console.error('[Companion] process error:', err.message);
      this.emit('unavailable', err.message);
    });
    this._proc.on('exit', (code) => {
      console.log('[Companion] exited with code', code);
      this._proc = null;
      this._ready = false;
      this._rejectAllPending('Companion process exited');
      this.emit('exit', code);
    });

    // Probe readiness by calling getCapabilities
    try {
      await this._waitReady();
      this._ready = true;
      this.emit('ready');
      console.log('[Companion] ready');
    } catch (err) {
      console.warn('[Companion] startup probe failed:', err.message);
      console.log('[Companion] startup failed, retrying in 3s...');
      await new Promise(r => setTimeout(r, 3000));
      try {
        await this._waitReady();
        this._ready = true;
        this.emit('ready');
        return;
      } catch (retryErr) {
        console.warn('[Companion] retry also failed:', retryErr.message);
        // Both probe attempts failed — the subprocess is still running but will
        // never become usable. Kill and null it out so it isn't orphaned and so
        // the `if (this._proc) return;` guard above doesn't lock out every
        // future start() call.
        if (this._proc) {
          this._proc.kill('SIGTERM');
          this._proc = null;
        }
        this.emit('unavailable', retryErr.message);
      }
    }
  }

  stop() {
    if (this._proc) {
      this._proc.kill('SIGTERM');
      this._proc = null;
    }
    this._rejectAllPending('Companion stopped');
  }

  get isReady() { return this._ready && !!this._proc; }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Send an action to the companion and return a Promise for the response.
   * payload should have an `action` field (e.g. { action: 'getCapabilities' }).
   */
  call(payload, timeoutMs = CALL_TIMEOUT_MS) {
    if (!this._proc) {
      return Promise.reject(new Error('Companion not running'));
    }
    return new Promise((resolve, reject) => {
      const id = String(this._idSeq++);
      const msg = { ...payload, id };

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Companion call timed out: ${payload.action}`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer });
      this._sendRaw(msg);
    });
  }

  // ── Internal ─────────────────────────────────────────────────────────────

  _waitReady() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Companion startup timeout')),
        COMPANION_READY_TIMEOUT_MS,
      );
      this.call({ action: 'getCapabilities' }, COMPANION_READY_TIMEOUT_MS)
        .then((resp) => { clearTimeout(timer); resolve(resp); })
        .catch((err) => { clearTimeout(timer); reject(err); });
    });
  }

  _sendRaw(obj) {
    const json = JSON.stringify(obj);
    const buf  = Buffer.from(json, 'utf8');
    const len  = Buffer.alloc(4);
    len.writeUInt32LE(buf.length, 0);
    try {
      this._proc.stdin.write(len);
      this._proc.stdin.write(buf);
    } catch (e) {
      console.error('[Companion] write error:', e.message);
    }
  }

  _onData(chunk) {
    this._readBuf = Buffer.concat([this._readBuf, chunk]);

    while (this._readBuf.length >= 4) {
      const msgLen = this._readBuf.readUInt32LE(0);
      // Sanity-cap the length prefix. A desync (garbled/partial frame) can yield a
      // huge value; without this the loop breaks forever waiting for bytes that
      // never arrive, wedging the channel and growing _readBuf unbounded. On an
      // implausible length, drop the buffer to resynchronise instead of hanging.
      if (msgLen > MAX_COMPANION_MSG_BYTES) {
        console.error('[Companion] implausible message length', msgLen, '— resetting read buffer');
        this._readBuf = Buffer.alloc(0);
        break;
      }
      if (this._readBuf.length < 4 + msgLen) break;

      const raw = this._readBuf.slice(4, 4 + msgLen).toString('utf8');
      this._readBuf = this._readBuf.slice(4 + msgLen);

      try {
        const resp = JSON.parse(raw);
        const id   = resp.id || resp._id;
        if (id && this._pending.has(id)) {
          const { resolve, timer } = this._pending.get(id);
          this._pending.delete(id);
          clearTimeout(timer);
          resolve(resp);
        } else {
          this.emit('message', resp);
        }
      } catch (e) {
        console.warn('[Companion] parse error:', e.message, raw.slice(0, 100));
      }
    }
  }

  _rejectAllPending(reason) {
    for (const [id, { reject, timer }] of this._pending) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this._pending.clear();
  }

  _findPython() {
    const candidates = [
      process.env.PFX_PYTHON,
      '/opt/homebrew/bin/python3',
      '/usr/local/bin/python3',
      '/usr/bin/python3',
      'python3',
    ].filter(Boolean);

    for (const p of candidates) {
      try {
        // Quick existence check (skips 'python3' bare name — rely on PATH)
        if (path.isAbsolute(p) && !fs.existsSync(p)) continue;
        return p;
      } catch { /* continue */ }
    }
    return 'python3'; // fall back and let the OS resolve it
  }

  _companionSrc() {
    // Development: companion/src adjacent to project root
    const devPath = path.join(this._appRoot, 'companion', 'src');
    if (fs.existsSync(devPath)) return devPath;

    // Packaged: Resources/companion/src inside the .app bundle
    const resourcesPath = path.join(process.resourcesPath || '', 'companion', 'src');
    if (fs.existsSync(resourcesPath)) return resourcesPath;

    return null;
  }
}

module.exports = new CompanionBridge();
