// imf_metal_htj2k_backend.js
// -----------------------------------------------------------------------------
// Main-process bridge to the native Metal HTJ2K decoder helper
// (electron/native/pfx_htj2k_metal/pfx_htj2k_metal). Persistent --ipc stdio
// session (newline-delimited JSON, id-correlated), modeled on the pfx-helper
// session in imf_native_decoder.js.
//
// GATED: only used when the PFX_IMF_METAL_HTJ2K feature flag is ON (see
// imf_frame_provider.js). Default OFF => this module is never engaged and
// playback is byte-identical to before.
//
// Pixel channel (M6a): the helper writes interleaved integer samples to a temp
// file; the JSON reply carries the path + dims; we read it into a Buffer and
// unlink. (M6b will replace this with a shared-memory ring.)
//
// CAP-absent (Part-1 MQ, e.g. Meridian) => helper replies code:'NOT_HTJ2K' and
// the caller falls back to the existing essence/ffmpeg path.
// -----------------------------------------------------------------------------
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Resolve the helper binary in both dev and packaged (asarUnpack) layouts.
function _binPath() {
  const rel = path.join('native', 'pfx_htj2k_metal', 'pfx_htj2k_metal');
  const candidates = [
    path.join(__dirname, '..', rel),                         // dev: electron/native/...
    path.join(__dirname, '..', rel).replace('app.asar', 'app.asar.unpacked'),
    process.resourcesPath ? path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', rel) : null,
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch {} }
  return candidates[0];
}

let _avail = null;
async function checkAvailability() {
  if (_avail) return _avail;
  const bin = _binPath();
  let ok = false, version = null, metal = false;
  try {
    if (fs.existsSync(bin)) {
      version = await _runCapture(bin, ['--version'], 5000);
      ok = /pfx-htj2k-metal/i.test(version);
    }
  } catch {}
  _avail = { any: ok, bin, version, metal };
  return _avail;
}

function _runCapture(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('timeout')); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', () => { clearTimeout(t); resolve(out); });
  });
}

// ── persistent --ipc session ─────────────────────────────────────────────────
class MetalHtj2kSession {
  constructor(bin) { this._bin = bin; this._proc = null; this._buf = ''; this._pending = new Map(); this._seq = 0; }
  start() {
    if (this._proc) return;
    const env = { ...process.env, PFX_MSL_DIR: path.dirname(this._bin) };
    this._proc = spawn(this._bin, ['--ipc'], { stdio: ['pipe', 'pipe', 'pipe'], env });
    this._proc.stdout.setEncoding('utf8');
    this._proc.stdout.on('data', (chunk) => this._onData(chunk));
    this._proc.stderr.on('data', () => {});
    const fail = (e) => { for (const [, p] of this._pending) { clearTimeout(p.timer); p.reject(e); } this._pending.clear(); this._proc = null; };
    this._proc.on('close', () => fail(new Error('metal-htj2k helper closed')));
    this._proc.on('error', (e) => fail(e));
  }
  _onData(chunk) {
    this._buf += chunk;
    const lines = this._buf.split('\n');
    this._buf = lines.pop();
    for (const line of lines) {
      const t = line.trim(); if (!t) continue;
      let msg; try { msg = JSON.parse(t); } catch { continue; }
      const p = this._pending.get(msg.id); if (!p) continue;
      clearTimeout(p.timer); this._pending.delete(msg.id);
      p.resolve(msg);   // resolve even ok:false (caller inspects code)
    }
  }
  send(cmd, payload = {}, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      if (!this._proc) this.start();
      if (!this._proc) { reject(new Error('metal-htj2k helper not running')); return; }
      const id = ++this._seq;
      const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`metal-htj2k timeout cmd=${cmd}`)); }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try { this._proc.stdin.write(JSON.stringify({ id, cmd, ...payload }) + '\n'); }
      catch (e) { clearTimeout(timer); this._pending.delete(id); reject(e); }
    });
  }
  // Read a decoded frame from the mmap'd ring (a plain temp file the helper
  // mmap-writes; coherent with our reads via the OS buffer cache). The helper
  // writes payload+len, barriers, then writes the ready-seq LAST — so this is a
  // true seqlock READ: verify seq before the payload, then RE-READ seq after and
  // reject if it changed (a concurrent same-slot overwrite would otherwise yield
  // an {old-seq, new-payload} torn frame). Correct-by-construction, not by
  // timing — required before decode-ahead makes same-slot overwrite reachable.
  // Returns a Buffer or null on torn/stale (caller falls back).
  readRingSlot(reply) {
    if (this._ringPath !== reply.ringPath) {
      if (this._ringFd != null) { try { fs.closeSync(this._ringFd); } catch {} this._ringFd = null; }
      try { this._ringFd = fs.openSync(reply.ringPath, 'r'); this._ringPath = reply.ringPath; }
      catch { this._ringFd = null; this._ringPath = null; return null; }
    }
    const base = reply.slot * reply.slotSize;
    const wantSeq = BigInt(reply.seq);
    const wantLen = reply.byteLength | 0;
    const hdr = Buffer.allocUnsafe(16);
    // Bounded retry covers a transient in-progress write; a genuine overwrite to
    // a newer seq never matches wantSeq again, so we give up → fallback.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (fs.readSync(this._ringFd, hdr, 0, 16, base) !== 16) return null;
      if (hdr.readBigUInt64LE(0) !== wantSeq || Number(hdr.readBigUInt64LE(8)) !== wantLen) continue; // torn/stale seq or len
      const payload = Buffer.allocUnsafe(wantLen);
      if (fs.readSync(this._ringFd, payload, 0, wantLen, base + 16) !== wantLen) return null;
      // Re-read seq AFTER the payload; if the writer overwrote this slot mid-read
      // the seq will have advanced → payload is torn → retry.
      if (fs.readSync(this._ringFd, hdr, 0, 8, base) !== 8) return null;
      if (hdr.readBigUInt64LE(0) === wantSeq) return payload; // seq stable across the read → intact
    }
    return null; // never got a stable read → fall back
  }

  close() {
    if (this._ringFd != null) { try { fs.closeSync(this._ringFd); } catch {} this._ringFd = null; this._ringPath = null; }
    if (this._proc) { try { this._proc.stdin.end(); } catch {} try { this._proc.kill('SIGTERM'); } catch {} this._proc = null; }
    this._pending.clear();
  }
}

let _session = null;
function _getSession(bin) { if (!_session) _session = new MetalHtj2kSession(bin); return _session; }

// Decode a raw .j2c codestream file to interleaved samples.
// Returns { ok, code?, samples:Buffer, width, height, componentCount,
//           bitsPerSample, isSigned, pixelsType, sampleLayout } or { ok:false, code }.
async function decodeCodestream(j2cPath, opts = {}) {
  const avail = await checkAvailability();
  if (!avail.any) return { ok: false, code: 'UNAVAILABLE' };
  const s = _getSession(avail.bin);
  let reply;
  try {
    reply = await s.send('decode', { j2cPath, skip: (opts.skip | 0) || 0 }, 20000);
  } catch (e) {
    return { ok: false, code: 'DECODE_FAILED', error: e.message };
  }
  if (!reply || reply.ok === false) return { ok: false, code: reply?.code || 'DECODE_FAILED' };
  // Pixel channel: ring (mmap'd temp file, no per-frame churn) or temp file (M6a).
  let samples = null;
  if (reply.ring) {
    samples = s.readRingSlot(reply);
    if (!samples) return { ok: false, code: 'DECODE_FAILED', error: 'ring read/torn' };
  } else {
    try { samples = fs.readFileSync(reply.path); }
    catch (e) { return { ok: false, code: 'DECODE_FAILED', error: 'read samples: ' + e.message }; }
    finally { try { fs.unlinkSync(reply.path); } catch {} }
  }
  if (!samples || samples.length !== (reply.byteLength | 0)) {
    return { ok: false, code: 'DECODE_FAILED', error: 'sample byte length mismatch' };
  }
  return {
    ok: true, samples,
    width: reply.width, height: reply.height,
    componentCount: reply.componentCount,
    bitsPerSample: reply.bitsPerSample,
    isSigned: !!reply.isSigned,
    pixelsType: reply.pixelsType,
    sampleLayout: reply.sampleLayout || 'interleaved',
  };
}

module.exports = { checkAvailability, decodeCodestream, _binPath };
