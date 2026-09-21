'use strict';

/**
 * imf_native_decoder.js — Backend B: Native IMF decode via pfx-helper / asdcplib.
 *
 * Priority chain (within this module):
 *   1. pfx-helper binary (bundled)  — asdcplib demux + OpenJPEG decode + libplacebo HDR
 *   2. asdcp-test + opj_decompress  — Homebrew CLI fallback (frame-accurate, no HDR)
 *   3. Unavailable                  — caller falls through to Backend C (FFmpeg)
 *
 * Public API:
 *   checkAvailability()
 *     → { any, pfxHelper, asdcpCli, openjpeg, libplacebo, version? }
 *
 *   extractFrame(mxfPath, mxfFrame, outPath, probe, displayMode?)
 *     → { ok, backend, toneMapApplied?, error? }
 *
 *   stepFrame(mxfPath, currentFrame, direction, outPath)
 *     → { ok, frame, backend, error? }
 *
 *   grabThumbnail(mxfPath, frame, outPath, width?)
 *     → { ok, backend, error? }
 *
 *   openPackage(mxfPath)
 *     → { ok, frameCount, editRate, timecodeStart, codec, width, height, isHDR, isDV, error? }
 *
 *   diagnostics()
 *     → { pfxHelper, asdcpCli, openjpeg, libplacebo, version, paths }
 */

const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const { spawn, execFile } = require('child_process');

// ── Binary search paths ───────────────────────────────────────────────────────

// pfx-helper: bundled alongside the existing PFXNativeMediaEngine binary.
const _PFX_HELPER_CANDIDATES = [
  path.join(__dirname, '..', 'native', 'pfx_helper'),
  path.join(__dirname, '..', 'native', 'pfx-helper'),
  path.join(process.resourcesPath || '', 'pfx_helper'),
  path.join(process.resourcesPath || '', 'pfx-helper'),
  '/usr/local/bin/pfx-helper',
  '/opt/homebrew/bin/pfx-helper',
];

const _ASDCP_CANDIDATES = [
  '/opt/homebrew/bin/asdcp-test',
  '/usr/local/bin/asdcp-test',
  '/usr/bin/asdcp-test',
];

const _OPJ_CANDIDATES = [
  '/opt/homebrew/bin/opj_decompress',
  '/usr/local/bin/opj_decompress',
  '/usr/bin/opj_decompress',
  '/opt/homebrew/bin/openjpeg',   // alternate install name
];

const _FFMPEG_CANDIDATES = [
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/usr/bin/ffmpeg',
];

function _findBin(candidates) {
  for (const p of candidates) {
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

// ── Availability cache ─────────────────────────────────────────────────────────

let _avail = null;   // resolved once, cached permanently

async function checkAvailability() {
  if (_avail) return _avail;

  const pfxHelperPath = _findBin(_PFX_HELPER_CANDIDATES);
  const asdcpPath     = _findBin(_ASDCP_CANDIDATES);
  const opjPath       = _findBin(_OPJ_CANDIDATES);
  const ffmpegPath    = _findBin(_FFMPEG_CANDIDATES);

  // Verify pfx-helper responds to --version
  let pfxHelperOk = false;
  let pfxVersion  = null;
  if (pfxHelperPath) {
    try {
      pfxVersion  = await _runCapture(pfxHelperPath, ['--version'], 5000);
      pfxHelperOk = /pfx.helper|PFXHelper|version/i.test(pfxVersion);
    } catch {}
  }

  // Verify asdcp-test responds
  let asdcpOk = false;
  if (asdcpPath) {
    try {
      const out = await _runCapture(asdcpPath, ['-V'], 5000);
      asdcpOk = out.length > 0;
    } catch {}
  }

  // Verify opj_decompress responds
  let opjOk = false;
  if (opjPath) {
    try {
      await _runCapture(opjPath, ['-h'], 5000);
      opjOk = true;   // opj exits non-zero for -h but stdout has usage
    } catch (e) {
      // opj_decompress -h exits 1 but still works
      opjOk = /opj_decompress|usage/i.test(e.message || '');
      if (!opjOk) {
        try { await _runCapture(opjPath, [], 3000); } catch { opjOk = true; }
      }
    }
  }

  // libplacebo: only available via pfx-helper (it links libplacebo at build time)
  const libplaceboOk = pfxHelperOk;

  _avail = {
    any:         pfxHelperOk || (asdcpOk && opjOk),
    pfxHelper:   pfxHelperOk,
    pfxHelperPath,
    asdcpCli:    asdcpOk,
    asdcpPath,
    openjpeg:    opjOk,
    opjPath,
    ffmpegPath,
    libplacebo:  libplaceboOk,
    version:     pfxVersion,
  };
  return _avail;
}

// ── pfx-helper persistent process ────────────────────────────────────────────
// We keep one long-lived pfx-helper process per opened MXF file.
// Commands are sent as newline-delimited JSON; responses arrive the same way.

class PfxHelperSession {
  constructor(binaryPath, mxfPath) {
    this._bin     = binaryPath;
    this._mxf     = mxfPath;
    this._proc    = null;
    this._buf     = '';
    this._pending = new Map();   // reqId → { resolve, reject, timer }
    this._seq     = 0;
    this._opened  = false;
  }

  async start() {
    if (this._proc) return;
    this._proc = spawn(this._bin, ['--ipc'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this._proc.stdout.setEncoding('utf8');
    this._proc.stdout.on('data', (chunk) => this._onData(chunk));
    this._proc.stderr.on('data', () => {});  // silence; pfx-helper logs to stderr
    this._proc.on('close', () => {
      this._proc = null;
      for (const [, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(new Error('pfx-helper process closed'));
      }
      this._pending.clear();
    });
    this._proc.on('error', (e) => {
      for (const [, p] of this._pending) {
        clearTimeout(p.timer);
        p.reject(e);
      }
      this._pending.clear();
      this._proc = null;
    });
  }

  _onData(chunk) {
    this._buf += chunk;
    const lines = this._buf.split('\n');
    this._buf = lines.pop();   // keep incomplete last line
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        const p   = this._pending.get(msg.id);
        if (!p) continue;
        clearTimeout(p.timer);
        this._pending.delete(msg.id);
        if (msg.ok === false || msg.error) {
          p.reject(new Error(msg.error || 'pfx-helper error'));
        } else {
          p.resolve(msg);
        }
      } catch {}
    }
  }

  send(cmd, payload = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      if (!this._proc) { reject(new Error('pfx-helper not running')); return; }
      const id  = ++this._seq;
      const msg = JSON.stringify({ id, cmd, ...payload }) + '\n';
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`pfx-helper timeout for cmd=${cmd}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._proc.stdin.write(msg);
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  async openFile(mxfPath) {
    if (!this._proc) await this.start();
    const r = await this.send('openFile', { path: mxfPath }, 15000);
    this._opened = true;
    return r;
  }

  async close() {
    if (this._proc) {
      try { this._proc.stdin.end(); } catch {}
      try { this._proc.kill('SIGTERM'); } catch {}
      this._proc = null;
    }
    this._opened  = false;
    this._pending.clear();
  }
}

// One session per MXF path — re-used across frame requests.
const _sessions = new Map();   // mxfPath → PfxHelperSession

async function _getSession(mxfPath, binaryPath) {
  let session = _sessions.get(mxfPath);
  if (!session) {
    session = new PfxHelperSession(binaryPath, mxfPath);
    _sessions.set(mxfPath, session);
  }
  if (!session._proc) await session.start();
  if (!session._opened) await session.openFile(mxfPath);
  return session;
}

// ── openPackage ───────────────────────────────────────────────────────────────

async function openPackage(mxfPath) {
  const avail = await checkAvailability();

  // --- pfx-helper path ---
  if (avail.pfxHelper) {
    try {
      const session = await _getSession(mxfPath, avail.pfxHelperPath);
      const r = await session.send('getInfo', {}, 10000);
      return {
        ok:             true,
        frameCount:     r.frameCount     || 0,
        editRate:       r.editRate       || 24,
        timecodeStart:  r.timecodeStart  || '00:00:00:00',
        codec:          r.codec          || 'jpeg2000',
        width:          r.width          || 0,
        height:         r.height         || 0,
        isHDR:          r.isHDR          || false,
        isDV:           r.isDV           || false,
        dvProfile:      r.dvProfile      || null,
        backend:        'pfx-helper',
      };
    } catch (e) {
      return { ok: false, error: `pfx-helper openPackage: ${e.message}`, backend: 'pfx-helper' };
    }
  }

  // --- asdcp-test fallback ---
  if (avail.asdcpCli) {
    try {
      const out = await _runCapture(avail.asdcpPath, ['-i', mxfPath], 15000);
      return _parseAsdcpInfo(out);
    } catch (e) {
      return { ok: false, error: `asdcp-test: ${e.message}`, backend: 'asdcp-cli' };
    }
  }

  return { ok: false, error: 'No native backend available', backend: 'none' };
}

function _parseAsdcpInfo(asdcpOutput) {
  const lines = asdcpOutput.split('\n');
  const find  = (re) => { for (const l of lines) { const m = l.match(re); if (m) return m[1]; } return null; };

  const frameCount = parseInt(find(/(?:Duration|Frame Count)\s*[=:]\s*(\d+)/i) || '0', 10);
  const width      = parseInt(find(/(?:Width|Horizontal)\s*[=:]\s*(\d+)/i) || '0', 10);
  const height     = parseInt(find(/(?:Height|Vertical)\s*[=:]\s*(\d+)/i) || '0', 10);
  const editNum    = parseInt(find(/Edit Rate.*?(\d+)\s*\//i) || '24', 10);
  const editDen    = parseInt(find(/Edit Rate.*?\/\s*(\d+)/i) || '1', 10);
  const editRate   = editDen > 0 ? editNum / editDen : 24;

  return {
    ok: frameCount > 0,
    frameCount, editRate, width, height,
    timecodeStart: find(/Timecode[^=]*=\s*([0-9:;]+)/i) || '00:00:00:00',
    codec: 'jpeg2000',
    isHDR: false, isDV: false, dvProfile: null,
    backend: 'asdcp-cli',
  };
}

// ── extractFrame ──────────────────────────────────────────────────────────────

/**
 * Extract one frame from a J2K MXF via asdcplib + OpenJPEG.
 *
 * @param {string} mxfPath    — absolute MXF path
 * @param {number} mxfFrame   — 0-based frame index in MXF
 * @param {string} outPath    — where to write the result PNG/JPEG
 * @param {object} probe      — ffprobe result (used for HDR metadata)
 * @param {string} displayMode — 'sdr' | 'hdr' | 'raw'
 */
async function extractFrame(mxfPath, mxfFrame, outPath, probe, displayMode = 'sdr') {
  const avail = await checkAvailability();
  if (!avail.any) {
    return { ok: false, error: 'No native IMF backend available', backend: 'none' };
  }

  // --- pfx-helper path (asdcplib + OpenJPEG + libplacebo) ---
  if (avail.pfxHelper) {
    try {
      const session = await _getSession(mxfPath, avail.pfxHelperPath);
      const r = await session.send('seekFrame', {
        frame:       mxfFrame,
        outputPath:  outPath,
        displayMode,
        outputWidth: 1920,
      }, 20000);
      if (r.ok && fs.existsSync(outPath)) {
        return {
          ok:             true,
          backend:        'pfx-helper',
          toneMapApplied: r.toneMapApplied || false,
          dvProfile:      r.dvProfile      || null,
        };
      }
      return { ok: false, error: r.error || 'pfx-helper seekFrame failed', backend: 'pfx-helper' };
    } catch (e) {
      // Fall through to CLI path
    }
  }

  // --- asdcp-test + opj_decompress path ---
  if (avail.asdcpCli && avail.openjpeg) {
    return _extractViaCliTools(mxfPath, mxfFrame, outPath, avail, displayMode, probe);
  }

  return { ok: false, error: 'No native backend could decode frame', backend: 'none' };
}

async function _extractViaCliTools(mxfPath, mxfFrame, outPath, avail, displayMode, probe) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfx-native-'));
  try {
    // Step 1: asdcp-test -x extracts one J2K codestream file per frame
    // -f sets the start frame, -p sets the output file prefix, -1 for single frame.
    const j2cPath = path.join(tmpDir, `frame_${mxfFrame}.j2c`);
    const asdcpArgs = [
      '-x',              // extract frames
      '-f', String(mxfFrame),  // start frame (0-based)
      '-p', j2cPath.replace(/\.j2c$/, ''),  // output prefix (asdcp appends _XXXXXXXX.j2c)
      mxfPath,
    ];
    await _runWithTimeout(avail.asdcpPath, asdcpArgs, 30000);

    // asdcp-test writes files as prefix_00000001.j2c (1-based suffix)
    // Find the extracted file.
    const extractedFiles = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.j2c'))
      .map(f => path.join(tmpDir, f));
    if (extractedFiles.length === 0) {
      return { ok: false, error: 'asdcp-test: no j2c file produced', backend: 'asdcp-cli' };
    }
    const j2cFile = extractedFiles[0];

    // Step 2: opj_decompress decodes J2K → PPM, then ffmpeg converts to JPEG/PNG
    const ppmPath = path.join(tmpDir, 'frame.ppm');
    const opjArgs = ['-i', j2cFile, '-o', ppmPath];
    await _runWithTimeout(avail.opjPath, opjArgs, 20000);

    if (!fs.existsSync(ppmPath)) {
      return { ok: false, error: 'opj_decompress: no PPM output', backend: 'openjpeg' };
    }

    // Step 3: convert PPM → output format with optional HDR tone-map
    const isHDR   = probe?.isHDR || false;
    const outIsJpeg = outPath.endsWith('.jpg') || outPath.endsWith('.jpeg');
    const ffmpeg  = avail.ffmpegPath || 'ffmpeg';

    const ffArgs  = ['-y', '-i', ppmPath];

    if (isHDR && displayMode === 'hdr') {
      // Pass through without tone-mapping (display handles it)
      ffArgs.push('-vf', 'scale=1920:-2');
    } else if (isHDR && displayMode !== 'raw') {
      // SDR tone-map: BT.2020 → BT.709 via Reinhard
      ffArgs.push('-vf', 'scale=1920:-2,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=reinhard,zscale=t=bt709:m=bt709:r=tv,format=yuv420p');
    } else {
      ffArgs.push('-vf', 'scale=1920:-2');
    }

    if (outIsJpeg) {
      ffArgs.push('-c:v', 'mjpeg', '-q:v', '3');
    } else {
      ffArgs.push('-c:v', 'png');
    }
    ffArgs.push(outPath);

    await _runWithTimeout(ffmpeg, ffArgs, 20000);
    if (!fs.existsSync(outPath) || fs.statSync(outPath).size < 100) {
      return { ok: false, error: 'ffmpeg PPM→output conversion failed', backend: 'openjpeg' };
    }

    return {
      ok:             true,
      backend:        'asdcp+openjpeg',
      toneMapApplied: isHDR && displayMode === 'sdr',
    };
  } catch (e) {
    return { ok: false, error: e.message, backend: 'asdcp-cli' };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── stepFrame ────────────────────────────────────────────────────────────────

/**
 * Decode the frame at currentFrame ± 1 (or ± N) for jog-wheel scrubbing.
 * Uses the pfx-helper step protocol which avoids re-seeking the MXF.
 *
 * @param {string} mxfPath
 * @param {number} currentFrame   — 0-based
 * @param {number} direction      — +1 (forward) or -1 (backward)
 * @param {string} outPath        — where to write the decoded image
 * @param {string} displayMode
 */
async function stepFrame(mxfPath, currentFrame, direction, outPath, displayMode = 'sdr') {
  const avail = await checkAvailability();
  const targetFrame = Math.max(0, currentFrame + (direction >= 0 ? 1 : -1));

  // pfx-helper has a stepFrame command that re-uses the open MXF handle.
  if (avail.pfxHelper) {
    try {
      const session = await _getSession(mxfPath, avail.pfxHelperPath);
      const r = await session.send('stepFrame', {
        direction:  direction >= 0 ? 'forward' : 'backward',
        outputPath: outPath,
        displayMode,
        outputWidth: 1920,
      }, 15000);
      if (r.ok && fs.existsSync(outPath)) {
        return { ok: true, frame: r.frame !== undefined ? r.frame : targetFrame, backend: 'pfx-helper' };
      }
      return { ok: false, frame: currentFrame, error: r.error || 'pfx-helper stepFrame failed', backend: 'pfx-helper' };
    } catch (e) {
      // fall through to extractFrame
    }
  }

  // CLI fallback: just extract targetFrame directly
  const r = await extractFrame(mxfPath, targetFrame, outPath, null, displayMode);
  return { ...r, frame: r.ok ? targetFrame : currentFrame };
}

// ── grabThumbnail ─────────────────────────────────────────────────────────────

/**
 * Extract a small thumbnail JPEG from a given frame.
 * Used by the scrub-bar hover preview and the poster frame generator.
 */
async function grabThumbnail(mxfPath, frame, outPath, width = 320) {
  const avail = await checkAvailability();

  if (avail.pfxHelper) {
    try {
      const session = await _getSession(mxfPath, avail.pfxHelperPath);
      const r = await session.send('grabThumbnail', {
        frame, outputPath: outPath, width,
      }, 15000);
      if (r.ok && fs.existsSync(outPath)) {
        return { ok: true, backend: 'pfx-helper' };
      }
    } catch {}
  }

  // CLI path: extract full frame then down-scale to thumbnail width
  const tmpPng = outPath.replace(/\.[^.]+$/, '_tmp.png');
  try {
    const r = await extractFrame(mxfPath, frame, tmpPng, null, 'sdr');
    if (!r.ok) return { ok: false, error: 'thumbnail extraction failed', backend: r.backend };

    const ffmpeg = avail.ffmpegPath || 'ffmpeg';
    await _runWithTimeout(ffmpeg, [
      '-y', '-i', tmpPng,
      '-vf', `scale=${width}:-2`,
      '-c:v', 'mjpeg', '-q:v', '5',
      outPath,
    ], 10000);

    if (!fs.existsSync(outPath)) return { ok: false, error: 'thumbnail resize failed' };
    return { ok: true, backend: r.backend };
  } finally {
    try { if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng); } catch {}
  }
}

// ── diagnostics ───────────────────────────────────────────────────────────────

async function diagnostics() {
  const avail = await checkAvailability();
  return {
    pfxHelper:  avail.pfxHelper,
    asdcpCli:   avail.asdcpCli,
    openjpeg:   avail.openjpeg,
    libplacebo: avail.libplacebo,
    version:    avail.version,
    paths: {
      pfxHelper: avail.pfxHelperPath,
      asdcp:     avail.asdcpPath,
      opj:       avail.opjPath,
      ffmpeg:    avail.ffmpegPath,
    },
    activeSessions: _sessions.size,
  };
}

// ── Process cleanup ───────────────────────────────────────────────────────────

function closeAll() {
  for (const [, session] of _sessions) {
    try { session.close(); } catch {}
  }
  _sessions.clear();
}

// Register cleanup on process exit so pfx-helper children are reaped.
process.on('exit',    closeAll);
process.on('SIGTERM', closeAll);

// ── Internal helpers ──────────────────────────────────────────────────────────

function _runCapture(bin, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let out = ''; let err = '';
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout: ${bin}`)); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', () => { clearTimeout(timer); resolve(out || err); });
  });
}

function _runWithTimeout(bin, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p   = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`timeout: ${bin}`)); }, timeoutMs);
    p.stderr.on('data', d => { stderr += d; });
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stderr);
      } else {
        reject(new Error(`${path.basename(bin)} exit ${code}: ${stderr.slice(-300)}`));
      }
    });
  });
}

module.exports = {
  checkAvailability,
  extractFrame,
  stepFrame,
  grabThumbnail,
  openPackage,
  diagnostics,
  closeAll,
};
