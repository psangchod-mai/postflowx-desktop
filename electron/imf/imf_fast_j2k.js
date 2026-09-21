'use strict';

/**
 * imf_fast_j2k.js — Optional high-speed JPEG2000 decode via a fast external
 * decoder (Grok or Kakadu).
 *
 * ⚠️  LICENSING — OFF BY DEFAULT. This module bundles and enables nothing. It
 * only shells out to a decoder the operator has installed AND explicitly opted
 * into via the PFX_FAST_J2K env var:
 *     PFX_FAST_J2K=grok     → grk_decompress  (Grok is AGPL-3.0; commercial use
 *                              requires Grok's commercial license)
 *     PFX_FAST_J2K=kakadu   → kdu_expand      (Kakadu is a commercial license)
 * When unset (the default), isEnabled() is false and the normal ffmpeg J2K path
 * is used. This keeps the shipped product free of AGPL/commercial obligations
 * unless the operator deliberately turns it on.
 *
 * Why: ffmpeg's built-in jpeg2000 decoder runs ~0.4 s/HD-frame (single-threaded).
 * Grok/Kakadu decode the same codestream in ~0.05 s (~8×). Measured end-to-end
 * (extract codestream → fast decode → encode): 1.27 s → 0.16 s full-res HD.
 *
 * Pipeline per frame:
 *   1. ffmpeg -ss <ts> -c:v copy   → extract the one J2K codestream (demux only)
 *   2. grk_decompress / kdu_expand → decode to a 16-bit TIFF (reduce = lowres)
 *   The caller then runs its existing ffmpeg tonemap+encode step on the TIFF,
 *   so colour management / HDR tonemap / JPEG-or-PNG output are unchanged.
 */

const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

function _find(cands) {
  for (const p of cands) { try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch {} }
  return null;
}

// Resolve the opted-in decoder, or null.
function _spec() {
  const which = (process.env.PFX_FAST_J2K || '').trim().toLowerCase();
  if (which === 'grok') {
    const bin = _find(['/opt/homebrew/bin/grk_decompress', '/usr/local/bin/grk_decompress']);
    return bin ? { name: 'grok', bin, reduce: (n) => ['-r', String(n)] } : null;
  }
  if (which === 'kakadu') {
    const bin = _find(['/usr/local/bin/kdu_expand', '/opt/homebrew/bin/kdu_expand']);
    return bin ? { name: 'kakadu', bin, reduce: (n) => ['-reduce', String(n)] } : null;
  }
  return null;
}

let _cachedSpec; // resolve once
function _getSpec() { if (_cachedSpec === undefined) _cachedSpec = _spec(); return _cachedSpec; }

function isEnabled() { return !!_getSpec(); }
function decoderName() { const s = _getSpec(); return s ? s.name : null; }

function _run(bin, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let stderr = '';
    const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: false, error: 'timeout' }); }, timeoutMs);
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, code, stderr: stderr.slice(-400) }); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
  });
}

/**
 * Extract frame `mxfFrame` from the MXF and decode it with the fast decoder to a
 * 16-bit TIFF. Returns { ok, path, cleanup() } — caller runs its own
 * tonemap/encode on `path`, then calls cleanup(). Returns { ok:false } on any
 * failure so the caller falls back to the normal ffmpeg path.
 *
 * @param ffmpegBin  path to ffmpeg (for the demux-only codestream extract)
 * @param lowres     0..N reduced-resolution level (maps to grok -r / kakadu -reduce)
 */
async function decodeToImage(mxfPath, mxfFrame, probeInfo, lowres, ffmpegBin) {
  const spec = _getSpec();
  if (!spec || !ffmpegBin) return { ok: false };

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfx-fastj2k-'));
  const j2kPath = path.join(tmpDir, 'frame.j2k');
  // 8-bit BMP: universally readable by ffmpeg (Grok's 12/16-bit TIFF is not).
  const imgPath = path.join(tmpDir, 'frame.bmp');
  const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} };

  try {
    // 1. Extract the single J2K codestream (input-seek; J2K is all-intra).
    const fps = _fps(probeInfo && probeInfo.r_frame_rate);
    const seekTs = fps && mxfFrame > 0 ? (mxfFrame / fps).toFixed(6) : null;
    const exArgs = ['-y', '-nostdin', '-loglevel', 'error'];
    if (seekTs) exArgs.push('-ss', seekTs);
    exArgs.push('-i', mxfPath, '-vframes', '1', '-c:v', 'copy', '-f', 'image2', j2kPath);
    const ex = await _run(ffmpegBin, exArgs, 20000);
    if (!ex.ok || !fs.existsSync(j2kPath) || fs.statSync(j2kPath).size < 64) { cleanup(); return { ok: false, error: 'codestream extract failed' }; }

    // 2. Fast-decode the codestream → 8-bit BMP (reduced-resolution if asked).
    const lr = Math.max(0, Math.min(5, lowres | 0));
    const decArgs = ['-i', j2kPath, '-o', imgPath, ...(lr > 0 ? spec.reduce(lr) : [])];
    const dec = await _run(spec.bin, decArgs, 30000);
    if (!dec.ok || !fs.existsSync(imgPath) || fs.statSync(imgPath).size < 128) { cleanup(); return { ok: false, error: `${spec.name} decode failed: ${dec.stderr || dec.error || dec.code}` }; }

    return { ok: true, path: imgPath, decoder: spec.name, cleanup };
  } catch (e) {
    cleanup();
    return { ok: false, error: e.message };
  }
}

function _fps(rate) {
  if (!rate) return null;
  const m = /^(\d+)(?:\/(\d+))?$/.exec(String(rate));
  if (!m) return null;
  const num = parseInt(m[1], 10); const den = m[2] ? parseInt(m[2], 10) : 1;
  return den > 0 ? num / den : null;
}

module.exports = { isEnabled, decoderName, decodeToImage };
