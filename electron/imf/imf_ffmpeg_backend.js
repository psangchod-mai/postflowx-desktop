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

// Capability cache: populated once at startup, invalidated on bin-path changes
let _capabilities = null;

// Electron launches with a stripped macOS PATH (no /opt/homebrew/bin).
// Resolve the absolute binary paths at module load so spawn never fails silently.
function _resolveBin(name, candidates) {
  for (const p of candidates) { if (fs.existsSync(p)) return p; }
  return name;
}
const FFMPEG      = _resolveBin('ffmpeg',      ['/opt/homebrew/bin/ffmpeg',      '/usr/local/bin/ffmpeg',      '/usr/bin/ffmpeg']);
const FFPROBE     = _resolveBin('ffprobe',     ['/opt/homebrew/bin/ffprobe',     '/usr/local/bin/ffprobe',     '/usr/bin/ffprobe']);
const OJPH_EXPAND = _resolveBin('ojph_expand', ['/opt/homebrew/bin/ojph_expand', '/usr/local/bin/ojph_expand']);

// Bare string fallback means the binary was not found at any known absolute path.
const _FFMPEG_MISSING  = FFMPEG  === 'ffmpeg';
const _FFPROBE_MISSING = FFPROBE === 'ffprobe';

// GPU tonemap (libplacebo) is OPT-IN via PFX_GPU_TONEMAP=1. Benchmarks showed it
// is slightly SLOWER than the zscale CPU chain in our per-frame-spawn model
// (Vulkan re-inits each ffmpeg launch), so the default stays zscale. libplacebo
// gives higher-quality BT.2390 tonemapping and offloads the CPU — worth enabling
// for a future persistent decode process. It needs the MoltenVK Vulkan ICD.
const _MOLTENVK_ICD = (() => {
  if (process.env.VK_ICD_FILENAMES) return process.env.VK_ICD_FILENAMES;
  for (const p of [
    '/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json',
    '/opt/homebrew/share/vulkan/icd.d/MoltenVK_icd.json',
    '/usr/local/share/vulkan/icd.d/MoltenVK_icd.json',
  ]) { try { if (fs.existsSync(p)) return p; } catch {} }
  return null;
})();
const _GPU_TONEMAP = process.env.PFX_GPU_TONEMAP === '1' && !!_MOLTENVK_ICD;
// Env for ffmpeg spawns — injects the Vulkan ICD only when GPU tonemap is opted in.
function _ffEnv() {
  return _GPU_TONEMAP ? { ...process.env, VK_ICD_FILENAMES: _MOLTENVK_ICD } : process.env;
}

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
  if (_FFPROBE_MISSING) return { ok: false, code: 'FFMPEG_NOT_INSTALLED', error: 'ffprobe not found. Install via: brew install ffmpeg' };
  if (_probeCache.has(mxfPath)) return _probeCache.get(mxfPath);

  const result = await new Promise((resolve) => {
    if (!fs.existsSync(mxfPath)) {
      return resolve({ ok: false, error: `File not found: ${mxfPath}` });
    }
    const args = [
      '-v', 'quiet', '-print_format', 'json',
      '-show_streams', '-show_format', mxfPath,
    ];
    const proc = spawn(FFPROBE,args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, error: 'ffprobe timeout' }); }, 20000);
    let out = ''; let err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      clearTimeout(timer);
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
    proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, error: `ffprobe not found: ${e.message}` }); });
  });

  if (result.ok) _probeCache.set(mxfPath, result);
  return result;
}

// Does this ffmpeg build have the zscale filter (libzimg)? Required for the
// PQ/HLG → SDR tonemap. Cached. When absent, HDR tonemap silently can't run, so
// the fast 8-bit decode path is safe to use for HDR too (output is 8-bit either way).
// Cached `ffmpeg -filters` output, so zscale/libplacebo detection costs one spawn.
let _filtersList = null;
function _ffmpegFilters() {
  if (_filtersList !== null) return Promise.resolve(_filtersList);
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn(FFMPEG, ['-hide_banner', '-filters'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} _filtersList = ''; resolve(''); }, 5000);
    proc.stdout.on('data', (d) => { out += d; });
    proc.on('close', () => { clearTimeout(timer); _filtersList = out; resolve(out); });
    proc.on('error', () => { clearTimeout(timer); _filtersList = ''; resolve(''); });
  });
}
async function _hasZscale()     { return /\bzscale\b/.test(await _ffmpegFilters()); }
async function _hasLibplacebo() { return /\blibplacebo\b/.test(await _ffmpegFilters()); }

// libplacebo is a GPU filter that needs a working Vulkan device (MoltenVK on
// macOS). It's often present but unusable (VK_ERROR_INCOMPATIBLE_DRIVER), which
// would silently drop HDR to raw. Probe actual usability once with a tiny
// synthetic frame and cache the result, so we only prefer it when it really works.
let _placeboUsable = null;
function _libplaceboUsable() {
  if (_placeboUsable !== null) return Promise.resolve(_placeboUsable);
  return new Promise((resolve) => {
    const args = ['-hide_banner', '-f', 'lavfi', '-i', 'color=c=red:s=64x64:d=1',
      '-vframes', '1', '-vf', 'libplacebo=tonemapping=bt.2390', '-f', 'null', '-'];
    const proc = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'ignore'], env: _ffEnv() });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} _placeboUsable = false; resolve(false); }, 8000);
    proc.on('close', (code) => { clearTimeout(timer); _placeboUsable = (code === 0); resolve(_placeboUsable); });
    proc.on('error', () => { clearTimeout(timer); _placeboUsable = false; resolve(false); });
  });
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
async function extractFrame(mxfPath, mxfFrame, outputPath, probeInfo, displayMode = 'sdr', opts = {}) {
  if (_FFMPEG_MISSING) return { ok: false, code: 'FFMPEG_NOT_INSTALLED', error: 'FFmpeg not found. Install via: brew install ffmpeg' };
  if (!probeInfo) probeInfo = await probeStream(mxfPath);
  if (!probeInfo.ok) return { ok: false, error: probeInfo.error, code: 'PROBE_FAILED' };

  if (probeInfo.isHTJ2K) {
    const htj2k = require('./imf_htj2k_backend');
    return htj2k.extractFrame(mxfPath, mxfFrame, outputPath, probeInfo);
  }

  // Reduced-resolution decode for scrub/playback preview. JPEG2000 is wavelet
  // multi-resolution, so `-lowres N` decodes only the top levels — ~4× faster
  // per level (measured: lowres 1 ≈ 3.7×, lowres 2 ≈ 11×). 0 = full resolution.
  // Clamped to 0..3; on failure we retry at full res below.
  const lowres = Math.max(0, Math.min(3, opts.lowres | 0));

  try { fs.mkdirSync(path.dirname(outputPath), { recursive: true }); } catch {}

  const needsToneMap = displayMode === 'sdr' && probeInfo.isHDR;
  // A real (>8-bit) tonemap needs libplacebo (GPU, best) or zscale (CPU). When
  // neither exists, HDR→SDR falls back to an 8-bit raw encode, so the 8-bit fast
  // path is equivalent. willToneMap gates BOTH the tonemap branch and fast path.
  const usePlacebo  = needsToneMap && _GPU_TONEMAP && await _libplaceboUsable();
  const willToneMap = needsToneMap && (usePlacebo || await _hasZscale());

  // J2K is intra-only — every frame is a keyframe, so input-seek to the target
  // timestamp instead of scanning with select=eq(n\,N) which decodes all N frames.
  const fps      = _parseFpsStr(probeInfo.r_frame_rate);
  const seekTs   = fps && mxfFrame > 0 ? mxfFrame / fps : 0;

  // Optional fast J2K decoder (Grok/Kakadu) — OFF unless the operator opted in
  // via PFX_FAST_J2K. Only used when we will NOT tonemap (its 8-bit BMP can't
  // carry HDR precision for a >8-bit tonemap). Decodes the frame to an 8-bit
  // image; the ffmpeg step below then only encodes (no J2K decode) — ~8× faster.
  const fastJ2k = require('./imf_fast_j2k');
  let _fast = null;
  if (fastJ2k.isEnabled() && !willToneMap && !opts._noFast) {
    const fr = await fastJ2k.decodeToImage(mxfPath, mxfFrame, probeInfo, lowres, FFMPEG);
    if (fr.ok) _fast = fr;
  }
  const fromFast  = !!_fast;
  const fastName  = _fast ? _fast.decoder : null;
  const inputPath = _fast ? _fast.path : mxfPath;

  // PQ→SDR / HLG→SDR tone-map (decodes from the MXF; never used on the fast path).
  // libplacebo does the whole HDR→SDR conversion on the GPU in one pass (best
  // quality, BT.2390); zscale is the CPU fallback. libplacebo reads the source's
  // HDR metadata, so one filter string covers both PQ and HLG.
  const LIBPLACEBO_TONEMAP = 'libplacebo=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=bt.2390';
  const PQ_TONEMAP = [
    'zscale=t=linear:npl=100', 'format=gbrpf32le', 'zscale=p=bt709',
    'tonemap=tonemap=hable:desat=0', 'zscale=t=bt709:m=bt709:r=tv', 'format=yuv420p',
  ].join(',');
  const HLG_TONEMAP = 'colorspace=iall=bt2020:all=bt709:fast=1';

  // JPEG output (SDR preview) encodes ~2× faster than PNG and is ~65× smaller,
  // which also speeds the pfx-media:// fetch + renderer decode. 4:4:4 chroma
  // (yuvj444p) preserves colour for the vectorscope; q:v 2 is near-lossless.
  // PNG (16-bit) is kept for hdr/raw paths where the caller passes a .png path.
  const isJpeg = /\.jpe?g$/i.test(outputPath);
  const encArgs = isJpeg ? ['-q:v', '2', '-pix_fmt', 'yuvj444p'] : [];

  const _runExtract = (filterChain, lr = lowres) => new Promise((resolve) => {
    const vfArgs = filterChain ? ['-vf', filterChain] : [];
    // The fast decoder already applied frame-seek and reduced-resolution, so the
    // ffmpeg step must NOT seek or apply -lowres when reading its output image.
    const lrArgs   = (!fromFast && lr > 0)     ? ['-lowres', String(lr)] : [];
    const seekArgs = (!fromFast && seekTs > 0) ? ['-ss', seekTs.toFixed(6)] : [];
    const args = [
      '-y', ...lrArgs, ...seekArgs,
      // NOTE: do NOT add -allowed_extensions here. It is an image2/IMF-demuxer
      // input option and is rejected ("Option allowed_extensions not found",
      // exit 8) by ffmpeg when the input is a plain .mxf file — which is always
      // the case on this direct-MXF path (the -f imf demuxer is a separate path).
      '-i', inputPath,
      ...vfArgs, ...encArgs,
      '-vframes', '1', '-update', '1', outputPath,
    ];
    let stderr = '';
    const proc = spawn(FFMPEG,args, { stdio: ['ignore', 'pipe', 'pipe'], env: _ffEnv() });
    const timer = setTimeout(() => { proc.kill(); resolve({ ok: false, code: 'TIMEOUT', error: 'ffmpeg timeout' }); }, 60000);
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      clearTimeout(timer);
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
    proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, code: 'FFMPEG_NOT_FOUND', error: e.message }); });
  });

  try {
    if (willToneMap) {
      // Prefer libplacebo (GPU); else zscale PQ / colorspace HLG. On failure,
      // retry without filter (raw HDR) so a frame still shows.
      const zscaleFilter  = probeInfo.isHLG ? HLG_TONEMAP : PQ_TONEMAP;
      const toneMapFilter = usePlacebo ? LIBPLACEBO_TONEMAP : zscaleFilter;
      let r = await _runExtract(toneMapFilter);
      if (!r.ok && lowres > 0) r = await _runExtract(toneMapFilter, 0); // lowres unsupported → full res
      if (r.ok) return { ...r, backend: usePlacebo ? 'ffmpeg+libplacebo' : 'ffmpeg', toneMapApplied: toneMapFilter };

      // libplacebo failed at runtime → fall back to the zscale CPU chain before raw.
      if (usePlacebo && await _hasZscale()) {
        let rz = await _runExtract(zscaleFilter);
        if (rz.ok) return { ...rz, backend: 'ffmpeg', toneMapApplied: zscaleFilter };
      }

      // tone-map unavailable at runtime — extract raw, mark as rawHDR
      let r2 = await _runExtract(null);
      if (!r2.ok && lowres > 0) r2 = await _runExtract(null, 0);
      return r2.ok ? { ...r2, rawHDR: true, toneMapFailed: r.error } : r2;
    }

    let r = await _runExtract(null);
    if (!r.ok && !fromFast && lowres > 0) r = await _runExtract(null, 0); // lowres unsupported → full res
    // Fast path failed → fall back to the normal MXF decode (no fast, no loop).
    if (!r.ok && fromFast) {
      if (_fast.cleanup) _fast.cleanup(); _fast = null;
      return extractFrame(mxfPath, mxfFrame, outputPath, probeInfo, displayMode, { ...opts, _noFast: true });
    }
    if (r.ok && fromFast) r.backend = `${fastName}+ffmpeg`;
    if (r.ok && needsToneMap && !willToneMap) r.rawHDR = true;
    return r;
  } finally {
    if (_fast && _fast.cleanup) _fast.cleanup();
  }
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
    const proc = spawn(FFMPEG,[
      '-y', '-i', imagePath,
      // metadata=print emits lavfi.signalstats.YAVG=… to stderr. Modern ffmpeg's
      // signalstats no longer prints YAVG:… on its own, so this is required.
      '-vf', 'signalstats,metadata=print',
      '-frames:v', '1',
      '-f', 'null', '-',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => { proc.kill(); resolve(FALLBACK); }, 10000);
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', () => {
      clearTimeout(timer);
      // Accept both old "YAVG:127.45" and new metadata "…YAVG=127.45" forms.
      const yavg = stderr.match(/YAVG[:=]([\d.]+)/);
      const ymin = stderr.match(/YMIN[:=]([\d.]+)/);
      const ymax = stderr.match(/YMAX[:=]([\d.]+)/);
      if (!yavg) return resolve(FALLBACK);
      const mean = parseFloat(yavg[1]);
      const min  = ymin ? parseFloat(ymin[1]) : 0;
      const max  = ymax ? parseFloat(ymax[1]) : 255;
      resolve({ mean, min, max, classification: _classifyLuma(mean, min, max) });
    });
    proc.on('error', () => { clearTimeout(timer); resolve(FALLBACK); });
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
  if (_FFMPEG_MISSING) return false;
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG,['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const proc = spawn(FFPROBE,args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: false, imfDemuxerOK: false, error: 'ffprobe timeout 30s' }); }, 30000);
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => {
      clearTimeout(timer);
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
    proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, imfDemuxerOK: false, error: `ffprobe not found: ${e.message}` }); });
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
    const proc = spawn(FFMPEG,args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} resolve({ ok: false, code: 'TIMEOUT', error: 'ffmpeg timeout 120s', stderr }); }, 120000);
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      clearTimeout(timer);
      const exists = (() => { try { return fs.existsSync(outputPath); } catch { return false; } })();
      const sz     = exists ? (() => { try { return fs.statSync(outputPath).size; } catch { return 0; } })() : 0;
      console.log(`[IMF] extractImfFrame exit=${code} exists=${exists} size=${sz}B`);
      if (!exists || sz < 200) {
        try { if (exists) fs.unlinkSync(outputPath); } catch {}
        return resolve({ ok: false, code: 'NO_OUTPUT', error: `ffmpeg exit ${code}, output ${sz}B`, stderr: stderr.slice(-2000) });
      }
      resolve({ ok: true, outputPath, stderr: stderr.slice(-1000) });
    });
    proc.on('error', e => { clearTimeout(timer); resolve({ ok: false, code: 'FFMPEG_NOT_FOUND', error: e.message, stderr: '' }); });
  });
}

// ── Engine capability detection ───────────────────────────────────────────────

/**
 * Probe the local ffmpeg build and installed tools once per process lifetime.
 * Returns a structured capability object that drives engine status in the UI and
 * controls which decode paths are entered.
 *
 * Checks:
 *   ffmpeg            — binary found and exits 0
 *   ffmpegImfDemuxer  — "-f imf" listed in ffmpeg -demuxers (requires libxml2)
 *   ffmpegLibxml2     — libxml2 appears in ffmpeg -version output
 *   libopenjpeg       — libopenjpeg listed in ffmpeg -decoders
 *   openjph           — /opt/homebrew/bin/ojph_expand exists
 *   opjDecompress     — /opt/homebrew/bin/opj_decompress exists
 */
async function engineCapabilities() {
  if (_capabilities) return _capabilities;

  const ffmpegOk = await checkAvailability();
  let ffmpegImfDemuxer = false;
  let libopenjpeg      = false;
  let ffmpegLibxml2    = false;
  let ffmpegVersion    = null;

  if (ffmpegOk) {
    [ffmpegImfDemuxer, libopenjpeg, ffmpegVersion] = await Promise.all([
      _checkFfmpegDemuxer('imf'),
      _checkFfmpegDecoderList('libopenjpeg'),
      _getFfmpegVersion(),
    ]);
    ffmpegLibxml2 = !!(ffmpegVersion && ffmpegVersion.toLowerCase().includes('libxml2'));
  }

  _capabilities = {
    ffmpeg:           ffmpegOk,
    ffmpegPath:       ffmpegOk ? FFMPEG : null,
    ffmpegVersion,
    ffmpegImfDemuxer,
    ffmpegLibxml2,
    libopenjpeg,
    openjph:          fs.existsSync('/opt/homebrew/bin/ojph_expand') || fs.existsSync('/usr/local/bin/ojph_expand'),
    opjDecompress:    fs.existsSync('/opt/homebrew/bin/opj_decompress') || fs.existsSync('/usr/local/bin/opj_decompress'),
    photon:           false,
    asdcplib:         false,
    imscJS:           false,
    grok:             false,
  };
  return _capabilities;
}

function _checkFfmpegDemuxer(name) {
  return new Promise(resolve => {
    let out = '';
    const proc = spawn(FFMPEG, ['-hide_banner', '-demuxers'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    proc.on('close', () => {
      const re = new RegExp(`\\s${name}\\s`, 'i');
      resolve(re.test(out));
    });
    proc.on('error', () => resolve(false));
    setTimeout(() => { proc.kill(); resolve(false); }, 5000);
  });
}

function _checkFfmpegDecoderList(name) {
  return new Promise(resolve => {
    let out = '';
    const proc = spawn(FFMPEG, ['-hide_banner', '-decoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { out += d; });
    proc.on('close', () => {
      const re = new RegExp(`\\s${name}\\s`, 'i');
      resolve(re.test(out));
    });
    proc.on('error', () => resolve(false));
    setTimeout(() => { proc.kill(); resolve(false); }, 5000);
  });
}

function _getFfmpegVersion() {
  return new Promise(resolve => {
    let out = '';
    const proc = spawn(FFMPEG, ['-version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stdout.on('data', d => { out += d; });
    proc.on('close', () => resolve(out.trim().split('\n').slice(0, 4).join(' ')));
    proc.on('error', () => resolve(null));
    setTimeout(() => { proc.kill(); resolve(null); }, 5000);
  });
}

module.exports = { probeStream, extractFrame, testDecodeFrame, lumaStats, checkAvailability, probeImfPackage, extractImfFrame, engineCapabilities };
