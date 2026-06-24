'use strict';

/**
 * imf_htj2k_backend.js — Native HTJ2K decode for IMF MXF files.
 *
 * Backend B in the IMF decode priority chain.
 * Provides two decode paths, probed at runtime:
 *
 *   1. ffmpeg with openjph decoder (best — single-command decode)
 *      Requires: ffmpeg built with OpenJPH support (check: ffmpeg -h decoder=openjph)
 *
 *   2. ojph_expand standalone tool (requires codestream extraction step)
 *      Workflow:
 *        a. ffmpeg -c:v copy → extract raw codestream to .j2c
 *        b. Strip any KLV/container header bytes to isolate the HTJ2K SOC marker (FF 50)
 *        c. ojph_expand -i frame.j2c -o frame.ppm
 *        d. ffmpeg -i frame.ppm → output.png
 *
 * On first call, checkAvailability() caches which paths are usable.
 * extractFrame() tries path 1 then path 2, returning ok:false with a
 * diagnostic code if both fail — caller falls back to UNSUPPORTED_HTJ2K.
 */

const fs          = require('fs');
const path        = require('path');
const os          = require('os');
const { spawn }   = require('child_process');

function _resolveBin(name, candidates) {
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  return name;
}
const FFMPEG  = _resolveBin('ffmpeg',  ['/opt/homebrew/bin/ffmpeg',  '/usr/local/bin/ffmpeg',  '/usr/bin/ffmpeg']);

let _availability = null;

// ── checkAvailability ─────────────────────────────────────────────────────────

/**
 * Probe at runtime which HTJ2K decode paths are usable.
 * Cached for the process lifetime.
 *
 * @returns {Promise<{ ffmpegOpenjph: bool, ojphExpand: bool, any: bool }>}
 */
async function checkAvailability() {
  if (_availability !== null) return _availability;
  const [ffmpegOpenjph, ojphExpand] = await Promise.all([
    _checkFfmpegDecoder('openjph'),
    _checkCommand('ojph_expand'),
  ]);
  _availability = { ffmpegOpenjph, ojphExpand, any: ffmpegOpenjph || ojphExpand };
  return _availability;
}

// ── extractFrame ──────────────────────────────────────────────────────────────

/**
 * Decode one HTJ2K MXF frame to a PNG file.
 *
 * @param {string}  mxfPath    — absolute path to .mxf file
 * @param {number}  mxfFrame   — 0-based frame index (= CPL entryPoint + reelLocalFrame)
 * @param {string}  outputPath — absolute path for the output .png
 * @param {object}  probeInfo  — result from ffmpegBackend.probeStream (may be null)
 * @returns {Promise<{ ok, outputPath?, code?, error? }>}
 */
async function extractFrame(mxfPath, mxfFrame, outputPath, probeInfo) {
  const avail = await checkAvailability();
  if (!avail.any) {
    return { ok: false, code: 'OJPH_NOT_FOUND', error: 'No HTJ2K decoder found (neither ffmpeg+openjph nor ojph_expand in PATH)' };
  }

  try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch {}

  // ── Path 1: ffmpeg with openjph decoder ──────────────────────────────────────
  // Most reliable: ffmpeg handles the MXF container and decodes HTJ2K in one step.
  if (avail.ffmpegOpenjph) {
    // HTJ2K is intra-only — every frame is a keyframe, so input-seek to the
    // target timestamp directly instead of scanning with select=eq(n\,N).
    const fps1     = _parseFps(probeInfo?.r_frame_rate) || 24;
    const seekTs1  = mxfFrame > 0 ? (mxfFrame / fps1) : 0;
    const seekArgs1 = seekTs1 > 0 ? ['-ss', seekTs1.toFixed(6)] : [];
    const r = await _spawnPromise('ffmpeg', [
      '-y', ...seekArgs1,
      // -allowed_extensions is invalid for a plain .mxf input (image2/IMF-demuxer
      // only) and makes ffmpeg 8.x fail at option parse — omit it here.
      '-i', mxfPath,
      '-vframes', '1', '-update', '1',
      outputPath,
    ], 90000);
    if (r.ok && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 200) {
      return { ok: true, outputPath };
    }
    // ffmpeg+openjph found but decode failed — continue to path 2
  }

  // ── Path 2: codestream extract + ojph_expand ─────────────────────────────────
  if (!avail.ojphExpand) {
    return { ok: false, code: 'ALL_PATHS_FAILED', error: 'ffmpeg-openjph decode failed and ojph_expand not available' };
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfx-htj2k-'));
  const tmpJ2C = path.join(tmpDir, 'frame.j2c');
  const tmpPPM = path.join(tmpDir, 'frame.ppm');

  try {
    // Step 2a — extract raw codestream with stream copy (no decoding required).
    // For frame 0, no seek needed. For frame N, seek by computed timestamp.
    const fps = _parseFps(probeInfo?.r_frame_rate) || 24;
    const seekTs = mxfFrame > 0 ? (mxfFrame / fps) : 0;
    const seekArgs = seekTs > 0 ? ['-ss', seekTs.toFixed(6)] : [];

    const r1 = await _spawnPromise('ffmpeg', [
      '-y', ...seekArgs,
      // -allowed_extensions is invalid for a plain .mxf input — see note above.
      '-i', mxfPath,
      '-vframes', '1',
      '-map', '0:v:0',
      '-c:v', 'copy',
      tmpJ2C,
    ], 30000);

    if (!r1.ok || !fs.existsSync(tmpJ2C) || fs.statSync(tmpJ2C).size < 16) {
      return { ok: false, code: 'CODESTREAM_EXTRACT_FAILED', error: r1.error };
    }

    // Step 2b — strip any leading container/KLV bytes to expose the J2K SOC marker.
    // Both classic J2K and HTJ2K codestreams start with SOC = 0xFF 0x4F; HTJ2K is
    // distinguished later by the CAP marker (0xFF 0x50) / Rsiz HT bit, not the SOC.
    const raw = fs.readFileSync(tmpJ2C);
    const cleaned = _stripToJ2CStart(raw);
    if (cleaned && cleaned.length < raw.length) {
      fs.writeFileSync(tmpJ2C, cleaned);
    }

    // Step 2c — ojph_expand: .j2c → .ppm
    const r2 = await _spawnPromise('ojph_expand', ['-i', tmpJ2C, '-o', tmpPPM], 60000);
    if (!r2.ok || !fs.existsSync(tmpPPM) || fs.statSync(tmpPPM).size < 16) {
      return { ok: false, code: 'OJPH_DECODE_FAILED', error: r2.error };
    }

    // Step 2d — convert PPM → PNG
    const r3 = await _spawnPromise('ffmpeg', ['-y', '-i', tmpPPM, outputPath], 10000);
    if (!r3.ok || !fs.existsSync(outputPath) || fs.statSync(outputPath).size < 200) {
      return { ok: false, code: 'PPM_CONVERT_FAILED', error: r3.error };
    }
    return { ok: true, outputPath };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Check if ffmpeg was built with the given decoder (e.g. 'openjph').
 * Uses `ffmpeg -h decoder=<name>` — ffmpeg prints an error if the codec is unknown.
 */
function _checkFfmpegDecoder(decoderName) {
  return new Promise(resolve => {
    let out = '';
    const proc = spawn(FFMPEG,['-hide_banner', '-h', `decoder=${decoderName}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    proc.on('close', () => {
      // ffmpeg 4.x: "Codec <name> is not recognized by libavcodec."
      // ffmpeg 5+:  "Decoder <name> not found."
      const lo = out.toLowerCase();
      resolve(!lo.includes('is not recognized') && !lo.includes('not found') && !lo.includes('unknown'));
    });
    proc.on('error', () => resolve(false));
    setTimeout(() => { proc.kill(); resolve(false); }, 5000);
  });
}

function _checkCommand(cmd) {
  return new Promise(resolve => {
    const proc = spawn(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('close', () => resolve(true));
    proc.on('error', () => resolve(false));
    setTimeout(() => { proc.kill(); resolve(false); }, 3000);
  });
}

function _spawnPromise(cmd, args, timeout) {
  return new Promise(resolve => {
    let stderr = '';
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, error: `timeout after ${timeout}ms: ${cmd}` }); }, timeout);
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => { clearTimeout(timer); resolve({ ok: code === 0, error: stderr.slice(-400) }); });
    proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}

/**
 * Parse ffprobe r_frame_rate string (e.g. "24000/1001") to a float.
 */
function _parseFps(r_frame_rate) {
  if (!r_frame_rate) return null;
  const parts = r_frame_rate.split('/');
  if (parts.length === 2) {
    const n = parseFloat(parts[0]); const d = parseFloat(parts[1]);
    if (d > 0) return n / d;
  }
  return parseFloat(r_frame_rate) || null;
}

/**
 * Scan a buffer for the first J2K (0xFF 0x4F) or HTJ2K (0xFF 0x50) SOC marker
 * and return a slice starting at that marker. Returns null if not found.
 * Needed because ffmpeg -c:v copy may prepend KLV or container headers.
 */
function _stripToJ2CStart(buf) {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 0xFF && (buf[i + 1] === 0x4F || buf[i + 1] === 0x50)) {
      return i === 0 ? buf : buf.slice(i);
    }
  }
  return null;
}

// ── extractRawCodestream ──────────────────────────────────────────────────────

/**
 * Extract the raw HTJ2K/J2K codestream bytes from a single MXF frame using
 * ffmpeg stream-copy (no decoder required — works even without openjph/libgrok).
 * Returns a Buffer starting at the SOC marker (0xFF 0x4F or 0xFF 0x50), or null.
 *
 * Used by imf_frame_provider to piggyback raw bytes onto the UNSUPPORTED_HTJ2K
 * response so the renderer's WASM decoder can handle the frame.
 *
 * @param {string} mxfPath    — absolute path to .mxf file
 * @param {number} mxfFrame   — 0-based frame index
 * @param {object} probeInfo  — result from ffmpegBackend.probeStream (may be null)
 * @returns {Promise<Buffer|null>}
 */
async function extractRawCodestream(mxfPath, mxfFrame, probeInfo) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfx-htj2k-raw-'));
  const tmpJ2C = path.join(tmpDir, 'frame.j2c');
  try {
    const fps = _parseFps(probeInfo?.r_frame_rate) || 24;
    const seekTs = mxfFrame > 0 ? (mxfFrame / fps) : 0;
    const seekArgs = seekTs > 0 ? ['-ss', seekTs.toFixed(6)] : [];

    const r = await _spawnPromise(FFMPEG, [
      '-y', ...seekArgs,
      '-i', mxfPath,
      '-vframes', '1', '-map', '0:v:0', '-c:v', 'copy',
      tmpJ2C,
    ], 30000);

    if (!r.ok || !fs.existsSync(tmpJ2C) || fs.statSync(tmpJ2C).size < 16) return null;

    const raw = fs.readFileSync(tmpJ2C);
    const cleaned = _stripToJ2CStart(raw);
    return cleaned || raw;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = { checkAvailability, extractFrame, extractRawCodestream };
