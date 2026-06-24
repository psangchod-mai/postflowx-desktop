'use strict';

/**
 * imf_ffmpeg_backend.js — FFprobe MXF validation + FFmpeg frame extraction.
 *
 * Backend C in the IMF decode priority chain:
 *   A: Resolve Engine (HTJ2K / HDR) — Phase 2
 *   B: Native IMF decoder (asdcplib/OpenJPH) — Phase 3
 *   C: FFmpeg — this module
 *   D: Placeholder with diagnostic
 *
 * Rules:
 *  1. Always ffprobe the MXF before calling ffmpeg. Reject if codec is not
 *     J2K-family (j2k, jpeg2000, jp2, mpeg2video in mxf context).
 *  2. Extract frame N (entryPoint + reelLocalFrame) using the `select` filter.
 *  3. Test-decode one frame on first use per MXF to catch corrupt/empty output.
 *  4. HTJ2K MXF: ffmpeg does not support it — return { ok:false, code:'UNSUPPORTED_HTJ2K' }.
 *  5. PQ HDR source: return raw frame + PQ metadata so caller can tone-map.
 */

const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { spawn }    = require('child_process');

// Probe cache: mxfPath → probeResult (avoid redundant ffprobe per session)
const _probeCache = new Map();

// ── ffprobe ───────────────────────────────────────────────────────────────────

/**
 * Run ffprobe on an MXF file and return its stream info.
 * Cached per mxfPath within the process lifetime.
 *
 * Returns:
 *   { ok, codec_name, pix_fmt, width, height, color_space, color_transfer,
 *     color_primaries, r_frame_rate, nb_frames, duration, isJ2K, isHTJ2K,
 *     isAudio, streams, error? }
 */
async function probeStream(mxfPath) {
  if (_probeCache.has(mxfPath)) return _probeCache.get(mxfPath);

  const result = await new Promise((resolve) => {
    if (!fs.existsSync(mxfPath)) {
      return resolve({ ok: false, error: `File not found: ${mxfPath}` });
    }
    const args = [
      '-v', 'quiet', '-print_format', 'json',
      '-show_streams', '-show_format', mxfPath,
    ];
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      if (code !== 0 || !out) {
        return resolve({ ok: false, error: `ffprobe exit ${code}: ${err.slice(0, 200)}` });
      }
      let parsed;
      try { parsed = JSON.parse(out); }
      catch { return resolve({ ok: false, error: 'ffprobe JSON parse error' }); }

      const videoStream = (parsed.streams || []).find(s => s.codec_type === 'video');
      if (!videoStream) {
        return resolve({ ok: false, error: 'No video stream found in MXF', streams: parsed.streams });
      }

      const codec    = (videoStream.codec_name    || '').toLowerCase();
      const pixFmt   = (videoStream.pix_fmt       || '').toLowerCase();
      const transfer = (videoStream.color_transfer || '').toLowerCase();
      const primaries= (videoStream.color_primaries|| '').toLowerCase();

      const isHTJ2K = codec.includes('htj2k') || pixFmt.includes('htj2k');
      const isJ2K   = !isHTJ2K && (
        codec === 'jpeg2000' || codec === 'j2k' || codec === 'jp2' ||
        codec.includes('j2k') || codec.includes('jpeg2000') || codec.includes('jp2')
      );
      // PQ = SMPTE ST 2084;  HLG = ARIB STD-B67
      const isPQ  = transfer === 'smpte2084' || transfer.includes('2084') || transfer.includes('pq');
      const isHLG = transfer === 'arib-std-b67' || transfer.includes('hlg');
      const isHDR = isPQ || isHLG;

      resolve({
        ok: true,
        codec_name:       videoStream.codec_name,
        pix_fmt:          videoStream.pix_fmt,
        width:            videoStream.width  || 0,
        height:           videoStream.height || 0,
        color_space:      videoStream.color_space      || '',
        color_transfer:   videoStream.color_transfer   || '',
        color_primaries:  videoStream.color_primaries  || '',
        r_frame_rate:     videoStream.r_frame_rate     || '',
        nb_frames:        parseInt(videoStream.nb_frames || '0', 10) || 0,
        duration:         parseFloat(videoStream.duration || '0') || 0,
        isJ2K,
        isHTJ2K,
        isPQ,
        isHLG,
        isHDR,
        streams:          parsed.streams,
        format:           parsed.format,
      });
    });
    proc.on('error', e => resolve({ ok: false, error: `ffprobe not found: ${e.message}` }));
    setTimeout(() => { proc.kill(); resolve({ ok: false, error: 'ffprobe timeout' }); }, 20000);
  });

  if (result.ok) _probeCache.set(mxfPath, result);
  return result;
}

// ── ffmpeg frame extract ──────────────────────────────────────────────────────

/**
 * Extract a single frame from an MXF file using ffmpeg.
 *
 * @param {string}  mxfPath     — absolute path to .mxf file
 * @param {number}  mxfFrame    — 0-based frame index in the MXF (= entryPoint + reelLocalFrame)
 * @param {string}  outputPath  — absolute path for the output .png
 * @param {object}  probeInfo   — result from probeStream (optional, avoids re-probe)
 * @param {string}  displayMode — 'sdr' (default) | 'hdr' | 'raw'
 *                                When 'sdr' and source is PQ/HLG, applies tone-mapping.
 * @returns {Promise<{ ok, outputPath, rawHDR?, toneMapFailed?, error?, stderr? }>}
 */
async function extractFrame(mxfPath, mxfFrame, outputPath, probeInfo, displayMode = 'sdr') {
  if (!probeInfo) probeInfo = await probeStream(mxfPath);
  if (!probeInfo.ok) return { ok: false, error: probeInfo.error, code: 'PROBE_FAILED' };

  if (probeInfo.isHTJ2K) {
    return { ok: false, error: 'HTJ2K not supported by this ffmpeg build', code: 'UNSUPPORTED_HTJ2K' };
  }

  try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch {}

  const needsToneMap = displayMode === 'sdr' && probeInfo.isHDR;

  // PQ→SDR tone-map filter chain (requires libzimg via zscale)
  const PQ_TONEMAP = [
    'zscale=t=linear:npl=100',
    'format=gbrpf32le',
    'zscale=p=bt709',
    'tonemap=tonemap=hable:desat=0',
    'zscale=t=bt709:m=bt709:r=tv',
    'format=yuv420p',
  ].join(',');
  // HLG→SDR: simpler colorspace conversion
  const HLG_TONEMAP = 'colorspace=iall=bt2020:all=bt709:fast=1';

  // J2K is intra-only — every frame is a keyframe, so input-seek to the target
  // timestamp instead of scanning with select=eq(n\,N) which decodes all N frames.
  const fps      = _parseFpsStr(probeInfo.r_frame_rate);
  const seekTs   = fps && mxfFrame > 0 ? mxfFrame / fps : 0;
  const seekArgs = seekTs > 0 ? ['-ss', seekTs.toFixed(6)] : [];

  const _runExtract = (filterChain) => new Promise((resolve) => {
    const vfArgs = filterChain ? ['-vf', filterChain] : [];
    const args = [
      '-y', ...seekArgs,
      '-allowed_extensions', 'ALL',
      '-i', mxfPath,
      ...vfArgs,
      '-vframes', '1', '-f', 'image2', outputPath,
    ];
    let stderr = '';
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (!fs.existsSync(outputPath)) {
        return resolve({ ok: false, code: 'NO_OUTPUT', error: `ffmpeg exit ${code}`, stderr: stderr.slice(-500) });
      }
      const sz = fs.statSync(outputPath).size;
      if (sz < 200) {
        try { fs.unlinkSync(outputPath); } catch {}
        return resolve({ ok: false, code: 'EMPTY_OUTPUT', error: `output ${sz}B`, stderr: stderr.slice(-500) });
      }
      resolve({ ok: true, outputPath });
    });
    proc.on('error', e => resolve({ ok: false, code: 'FFMPEG_NOT_FOUND', error: e.message }));
    setTimeout(() => { proc.kill(); resolve({ ok: false, code: 'TIMEOUT', error: 'ffmpeg timeout' }); }, 60000);
  });

  if (needsToneMap) {
    // Try PQ or HLG tone-map filter; on failure retry without filter (raw HDR)
    const toneMapFilter = probeInfo.isHLG ? HLG_TONEMAP : PQ_TONEMAP;
    const r = await _runExtract(toneMapFilter);
    if (r.ok) return { ...r, toneMapApplied: toneMapFilter };

    // zscale or colorspace not available — extract raw, mark as rawHDR
    const r2 = await _runExtract(null);
    return r2.ok ? { ...r2, rawHDR: true, toneMapFailed: r.error } : r2;
  }

  return _runExtract(null);
}

/**
 * Quick test: decode one frame (frame 0) to verify this MXF is decodable.
 * Returns { ok, error? }
 */
async function testDecodeFrame(mxfPath, probeInfo) {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'pfx-imf-test-'));
  const outPath = path.join(tmpDir, 'test.png');
  try {
    const r = await extractFrame(mxfPath, 0, outPath, probeInfo);
    return r;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Compute basic luma stats from a decoded PNG using ffmpeg lavfi signalstats.
 * Returns { mean, min, max, classification }
 *
 * ffmpeg writes signalstats per-frame to stderr in the form:
 *   [Parsed_signalstats_0 @ 0x...] YMIN:0 YLOW:1 YAVG:127.45 YHIGH:253 YMAX:255 ...
 * We parse YAVG (mean), YMIN, and YMAX from that output.
 */
async function lumaStats(imagePath) {
  const FALLBACK = { mean: 128, min: 0, max: 255, classification: 'unknown' };
  if (!imagePath || !fs.existsSync(imagePath)) return FALLBACK;

  return new Promise((resolve) => {
    let stderr = '';
    const proc = spawn('ffmpeg', [
      '-y', '-i', imagePath,
      '-vf', 'signalstats',
      '-frames:v', '1',
      '-f', 'null', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', () => {
      // Parse: YAVG:127.45 YMIN:0 YMAX:255
      const yavg = stderr.match(/YAVG:([\d.]+)/);
      const ymin = stderr.match(/YMIN:([\d.]+)/);
      const ymax = stderr.match(/YMAX:([\d.]+)/);
      if (!yavg) return resolve(FALLBACK);
      const mean = parseFloat(yavg[1]);
      const min  = ymin ? parseFloat(ymin[1]) : 0;
      const max  = ymax ? parseFloat(ymax[1]) : 255;
      resolve({ mean, min, max, classification: _classifyLuma(mean, min, max) });
    });
    proc.on('error', () => resolve(FALLBACK));
    setTimeout(() => { proc.kill(); resolve(FALLBACK); }, 10000);
  });
}

function _parseFpsStr(r_frame_rate) {
  if (!r_frame_rate) return null;
  const parts = String(r_frame_rate).split('/');
  if (parts.length === 2) {
    const n = parseFloat(parts[0]); const d = parseFloat(parts[1]);
    if (d > 0) return n / d;
  }
  return parseFloat(r_frame_rate) || null;
}

function _classifyLuma(mean, min, max) {
  if (mean < 4) return 'valid_black';
  if (mean < 8) return 'black_clip_warning';
  if (mean > 245) return 'white_clip_warning';
  return 'normal_frame';
}

/**
 * Find ffmpeg in common locations (Homebrew, system, bundled).
 * Returns 'ffmpeg' (expects PATH), but validates it's available.
 */
async function checkAvailability() {
  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('close', code => resolve(code === 0));
    proc.on('error', () => resolve(false));
    setTimeout(() => { proc.kill(); resolve(false); }, 5000);
  });
}

// ── IMF demuxer probe ─────────────────────────────────────────────────────────

/**
 * Probe a CPL via the FFmpeg IMF demuxer.
 * Uses: ffprobe -hide_banner -f imf -assetmaps "A.xml,B.xml,..." -show_streams -show_format -of json CPL.xml
 *
 * Returns:
 *   { ok, imfDemuxerOK, streamCount, pictureCodec, width, height, fps,
 *     streams, format, resolvedMxfPath?, error?, stderr? }
 */
async function probeImfPackage(cplPath, assetMapPaths) {
  const assetmapsStr = (Array.isArray(assetMapPaths) ? assetMapPaths : []).join(',');
  const args = [
    '-hide_banner', '-v', 'quiet',
    '-f', 'imf',
    ...(assetmapsStr ? ['-assetmaps', assetmapsStr] : []),
    '-show_streams', '-show_format',
    '-of', 'json',
    cplPath,
  ];

  return new Promise((resolve) => {
    let out = '', err = '';
    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      console.log(`[IMF] probeImfPackage exit=${code} stderr=${err.slice(0, 300)}`);
      if (code !== 0 || !out.trim()) {
        return resolve({ ok: false, imfDemuxerOK: false, error: `ffprobe exit ${code}`, stderr: err.slice(0, 2000) });
      }
      let parsed;
      try { parsed = JSON.parse(out); }
      catch (e) { return resolve({ ok: false, imfDemuxerOK: false, error: `JSON parse: ${e.message}`, stderr: err.slice(0, 2000) }); }

      const streams  = parsed.streams || [];
      const video    = streams.find(s => s.codec_type === 'video');
      const codec    = video?.codec_name || '';
      const fps      = _parseFpsStr(video?.r_frame_rate || '') || null;

      resolve({
        ok: true,
        imfDemuxerOK: true,
        streamCount:   streams.length,
        pictureCodec:  codec,
        width:         video?.width  || 0,
        height:        video?.height || 0,
        fps,
        r_frame_rate:  video?.r_frame_rate || '',
        streams,
        format:        parsed.format,
      });
    });
    proc.on('error', e => resolve({ ok: false, imfDemuxerOK: false, error: `ffprobe not found: ${e.message}` }));
    setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: false, imfDemuxerOK: false, error: 'ffprobe timeout 30s' }); }, 30000);
  });
}

// ── IMF demuxer frame extract ─────────────────────────────────────────────────

/**
 * Extract a single frame from a CPL via the FFmpeg IMF demuxer.
 * Uses: ffmpeg -hide_banner -f imf -assetmaps "..." [-ss ts] -c:v libopenjpeg -i CPL.xml
 *             -map 0:v:0 [-vf scale=960:-2] -frames:v 1 -f image2 outputPath
 *
 * @param {string}   cplPath        — absolute path to the CPL XML
 * @param {string[]} assetMapPaths  — all ASSETMAP.xml paths (base + supplemental)
 * @param {number}   frameNumber    — 0-based CPL-absolute frame index
 * @param {string}   outputPath     — absolute path for the output .png
 * @param {string}   [scale]        — 'viewer' (960px) | 'full' | 'none'
 * @param {object}   [probeInfo]    — from probeImfPackage (to get fps for seek)
 * @returns {Promise<{ ok, outputPath?, error?, code?, stderr? }>}
 */
async function extractImfFrame(cplPath, assetMapPaths, frameNumber, outputPath, scale, probeInfo) {
  const assetmapsStr = (Array.isArray(assetMapPaths) ? assetMapPaths : []).join(',');

  // Compute input seek from frame number + FPS (J2K is intra-only — seek is accurate)
  const fps = _parseFpsStr(probeInfo?.r_frame_rate || '') || probeInfo?.fps || 24;
  const seekTs = (frameNumber > 0) ? (frameNumber / fps) : null;
  const seekArgs = seekTs ? ['-ss', seekTs.toFixed(6)] : [];

  // Scale filter: default 960px wide, preserving AR
  let scaleFilter = null;
  if (!scale || scale === 'viewer') scaleFilter = 'scale=960:-2';
  else if (scale !== 'full' && scale !== 'none') scaleFilter = 'scale=960:-2';

  try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch {}

  const args = [
    '-hide_banner', '-y',
    '-f', 'imf',
    ...(assetmapsStr ? ['-assetmaps', assetmapsStr] : []),
    ...seekArgs,
    '-i', cplPath,
    '-map', '0:v:0',
    ...(scaleFilter ? ['-vf', scaleFilter] : []),
    '-frames:v', '1',
    '-f', 'image2',
    outputPath,
  ];

  console.log(`[IMF] extractImfFrame: ffmpeg ${args.join(' ')}`);

  return new Promise((resolve) => {
    let stderr = '';
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      const exists = (() => { try { return fs.existsSync(outputPath); } catch { return false; } })();
      const sz     = exists ? (() => { try { return fs.statSync(outputPath).size; } catch { return 0; } })() : 0;
      console.log(`[IMF] extractImfFrame exit=${code} exists=${exists} size=${sz}B`);
      if (!exists || sz < 200) {
        try { if (exists) fs.unlinkSync(outputPath); } catch {}
        return resolve({ ok: false, code: 'NO_OUTPUT', error: `ffmpeg exit ${code}, output ${sz}B`, stderr: stderr.slice(-2000) });
      }
      resolve({ ok: true, outputPath, stderr: stderr.slice(-1000) });
    });
    proc.on('error', e => resolve({ ok: false, code: 'FFMPEG_NOT_FOUND', error: e.message, stderr: '' }));
    setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: false, code: 'TIMEOUT', error: 'ffmpeg timeout 120s', stderr }); }, 120000);
  });
}

module.exports = { probeStream, extractFrame, testDecodeFrame, lumaStats, checkAvailability, probeImfPackage, extractImfFrame };
