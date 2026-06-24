'use strict';
/**
 * pfx_native_engine.js — Electron-side lifecycle manager for PFXNativeMediaEngine.
 *
 * Spawns the Swift binary on app startup, discovers its HTTP port from stdout,
 * and proxies all pfx:nativeEngine IPC calls as HTTP POSTs to the running engine.
 */

const { spawn } = require('child_process');
const path      = require('path');
const fs        = require('fs');
const http      = require('http');

// Resolve binary path — must be in asarUnpack so it's executable
const BINARY_NAME = 'pfx_native_media_engine';
const BINARY_PATH = path.join(__dirname, BINARY_NAME)
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

const STARTUP_TIMEOUT_MS = 20_000;

class NativeEngineManager {
  constructor() {
    this._proc            = null;
    this._port            = null;
    this._ready           = false;
    this._readyWaiters    = [];  // resolve() callbacks waiting for ready
    this._startAttempted  = false;
  }

  get isReady() { return this._ready; }
  get port()    { return this._port; }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start() {
    if (this._startAttempted) return this._ready;
    this._startAttempted = true;

    if (!this._binaryExists()) {
      console.warn('[NativeEngine] Binary not found at', BINARY_PATH, '— hardware engine disabled');
      return false;
    }

    return new Promise((resolve) => {
      console.log('[NativeEngine] Starting', BINARY_PATH);
      this._proc = spawn(BINARY_PATH, [], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env:   { ...process.env },
      });

      let stdoutBuf = '';

      this._proc.stdout.on('data', (chunk) => {
        stdoutBuf += chunk.toString();
        const match = /PFX_ENGINE_PORT:(\d+)/.exec(stdoutBuf);
        if (match && !this._ready) {
          this._port  = parseInt(match[1], 10);
          this._ready = true;
          console.log(`[NativeEngine] Ready on http://127.0.0.1:${this._port}`);
          this._readyWaiters.forEach(fn => fn());
          this._readyWaiters = [];
          resolve(true);
        }
      });

      this._proc.stderr.on('data', (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) console.warn('[NativeEngine]', msg);
      });

      this._proc.on('exit', (code) => {
        console.warn('[NativeEngine] exited with code', code);
        this._proc  = null;
        this._ready = false;
        this._port  = null;
      });

      this._proc.on('error', (err) => {
        console.error('[NativeEngine] spawn error:', err.message);
        resolve(false);
      });

      setTimeout(() => {
        if (!this._ready) {
          console.warn('[NativeEngine] startup timeout after', STARTUP_TIMEOUT_MS, 'ms');
          resolve(false);
        }
      }, STARTUP_TIMEOUT_MS);
    });
  }

  stop() {
    if (this._proc) {
      this._proc.kill('SIGTERM');
      this._proc  = null;
      this._ready = false;
      this._port  = null;
    }
  }

  // ── Command routing ─────────────────────────────────────────────────────────

  async command(type, payload = {}, timeoutMs = 60_000) {
    if (!this._ready) {
      if (!this._proc) throw new Error('NativeEngine not started');
      await new Promise((res) => this._readyWaiters.push(res));
    }
    return this._http({ type, payload }, timeoutMs);
  }

  async health() {
    if (!this._ready) return false;
    return new Promise((resolve) => {
      const req = http.get(`http://127.0.0.1:${this._port}/health`, (res) => {
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    });
  }

  // ── Internal HTTP client ────────────────────────────────────────────────────

  _http(body, timeoutMs) {
    return new Promise((resolve, reject) => {
      const json = JSON.stringify(body);
      const opts = {
        hostname: '127.0.0.1',
        port:     this._port,
        path:     '/command',
        method:   'POST',
        headers: {
          'Content-Type':   'application/json',
          'Content-Length': Buffer.byteLength(json),
        },
      };

      const timer = setTimeout(() => {
        req.destroy();
        reject(new Error(`NativeEngine timeout: ${body.type}`));
      }, timeoutMs);

      const req = http.request(opts, (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          clearTimeout(timer);
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString());
            if (!parsed.ok) {
              reject(new Error(parsed.error || 'NativeEngine command failed'));
            } else {
              resolve(parsed.data ?? parsed);
            }
          } catch (e) {
            reject(new Error(`NativeEngine parse error: ${e.message}`));
          }
        });
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`NativeEngine HTTP error: ${err.message}`));
      });

      req.write(json);
      req.end();
    });
  }

  _binaryExists() {
    try { return fs.existsSync(BINARY_PATH) && fs.statSync(BINARY_PATH).size > 0; }
    catch { return false; }
  }
}

module.exports = new NativeEngineManager();
