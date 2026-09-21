'use strict';

/**
 * imf_frame_provider.js — Main-process IMF frame decode service.
 *
 * Implements the multi-backend decode pipeline:
 *   A: Resolve Engine (HTJ2K / HDR) ......... Phase 2
 *   B: Native IMF decoder (OpenJPH) ......... Phase 3
 *   C: FFmpeg (J2K MXF, validated) .......... this module
 *   D: Placeholder with diagnostic .......... always available
 *
 * API (called from ipc.js):
 *   preparePackage(folderPath)
 *     → { ok, packageId, index }
 *
 *   requestFrame({ mxfPath, mxfFrame, packageHash, cplId, displayMode, requestId })
 *     → { ok, imagePath, imageDataUrl, frameInfo, error?, attemptedBackends[] }
 *
 *   clearCache(packageHash?)
 *     → void
 *
 *   diagnostics()
 *     → { ffmpegAvailable, cacheDir, cacheSizeBytes, packageCount }
 */

const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const { app } = require('electron');

const { IMFPackageIndex }  = require('./imf_package_index');
const ffmpegBackend        = require('./imf_ffmpeg_backend');
const htj2kBackend         = require('./imf_htj2k_backend');
const nativeDecoder        = require('./imf_native_decoder');
const { IMFPreviewCache }  = require('./imf_cache');

// ── Singleton state ───────────────────────────────────────────────────────────

let _cache          = null;      // IMFPreviewCache instance
let _ffmpegAvail    = null;      // cached availability boolean
let _mediaEngine    = null;      // media engine ref (set via init())
const _packages     = new Map(); // packageHash → IMFPackageIndex
let _logFilePath    = null;      // ~/Library/Application Support/PostFlowX/logs/imf_engine.log

// ── Scrub-storm guard ───────────────────────────────────────────────────────
// During fast scrubbing / read-ahead the renderer fires many requestFrame()
// calls in a burst. Previously the main process placed NO bound on this: each
// call immediately spawned ffprobe + a decoder process, so a burst spawned
// dozens of concurrent processes that exhausted CPU/RAM and froze the machine.
//
// Three bounds, none of which defeat the renderer's parallel prefetch:
//   1. Global concurrency cap — at most MAX_CONCURRENT_DECODES heavy decodes run
//      at once; the rest queue. This is the bound that prevents the freeze.
//   2. Per-frame in-flight dedup — identical concurrent requests (same clip +
//      frame + display mode) share one decode instead of spawning duplicates.
//   3. Bounded backlog — on a long scrub the oldest queued (stale) requests are
//      dropped so the user's latest on-screen target isn't stuck behind a
//      backlog of frames they already scrubbed past.
//
// Cache hits bypass all three (see _cacheHit), so scrubbing over already-decoded
// frames stays instant. Distinct upcoming frames still decode in parallel up to
// the cap, so the renderer's read-ahead prefetch keeps working.

const MAX_CONCURRENT_DECODES = Math.max(2, Math.min(6, Math.floor((os.cpus()?.length || 8) / 2)));
const MAX_QUEUED_DECODES     = 32;

let _activeDecodes = 0;
const _decodeQueue = [];        // FIFO of { run, resolve, args } waiting for a slot
const _inflight    = new Map(); // frameKey → Promise (dedup of identical requests)

function _frameKey(args) {
  return `${args?.packageHash || 'pkg'}:${args?.cplId || 'cpl'}:${args?.mxfPath || ''}` +
         `:${args?.mxfFrame ?? 0}:${args?.displayMode || 'sdr'}:lr${args?.lowres | 0}`;
}

// Cache key segment. Preview (reduced-resolution) frames are cached separately
// from full-resolution frames so a scrub preview never satisfies a full-res
// request and vice-versa.
function _cacheMode(displayMode, lowres) {
  return (lowres | 0) > 0 ? `${displayMode}.lr${lowres | 0}` : displayMode;
}

function _supersededResult(args) {
  return {
    ok: false, code: 'SUPERSEDED', cancelled: true,
    error: 'Superseded — dropped from decode backlog',
    frameInfo: { mxfFrame: args?.mxfFrame ?? 0, backend: null, fromCache: false },
    attemptedBackends: [],
  };
}

function _errorResult(args, e) {
  return {
    ok: false, code: 'DECODE_ERROR', error: (e && e.message) || String(e),
    frameInfo: { mxfFrame: args?.mxfFrame ?? 0, backend: null, fromCache: false },
    attemptedBackends: [],
  };
}

/**
 * Cache-only lookup. Returns a ready response if the frame is already decoded,
 * else null. Mirrors the cache-hit branch inside _requestFrameUncoalesced so
 * cached frames can skip the decode queue.
 */
function _cacheHit(args) {
  const {
    mxfFrame = 0, packageHash = 'unknown', cplId = 'unknown',
    displayMode = 'sdr', lowres = 0, mxfPath,
  } = args || {};
  try {
    const cache  = _ensureCache();
    const cached = cache.get(packageHash, cplId, mxfFrame, _cacheMode(displayMode, lowres));
    if (!cached) return null;
    return {
      ok: true, imagePath: cached, imageUrl: _mediaUrl(cached),
      frameInfo: {
        mxfFrame, mxfPath: mxfPath ? path.basename(mxfPath) : null,
        backend: 'cache', fromCache: true,
      },
      attemptedBackends: ['cache'],
    };
  } catch { return null; }
}

/** Start as many queued decodes as the concurrency cap allows. */
function _pumpDecodeQueue() {
  while (_activeDecodes < MAX_CONCURRENT_DECODES && _decodeQueue.length) {
    const job = _decodeQueue.shift();
    _activeDecodes++;
    Promise.resolve().then(job.run).then(
      (res) => { _activeDecodes--; job.resolve(res); _pumpDecodeQueue(); },
      (err) => { _activeDecodes--; job.resolve(_errorResult(job.args, err)); _pumpDecodeQueue(); },
    );
  }
}

/** Schedule a decode under the concurrency cap, dropping the oldest stale work
 *  if the backlog is already too deep. */
function _scheduleDecode(args, run) {
  return new Promise((resolve) => {
    while (_decodeQueue.length >= MAX_QUEUED_DECODES) {
      const stale = _decodeQueue.shift();
      stale.resolve(_supersededResult(stale.args));
    }
    _decodeQueue.push({ run, resolve, args });
    _pumpDecodeQueue();
  });
}

/**
 * Wire up the media engine so Backend A (Resolve / AVFoundation) is available.
 * Called from ipc.js after both engines are initialised.
 */
function init(mediaEngine) {
  _mediaEngine = mediaEngine;
}

// ── Init ──────────────────────────────────────────────────────────────────────

function _ensureCache() {
  if (_cache) return _cache;
  let userData;
  try { userData = app.getPath('userData'); }
  catch { userData = require('os').tmpdir(); }
  _cache = new IMFPreviewCache().init(userData);
  return _cache;
}

// ── Engine log ────────────────────────────────────────────────────────────────

function _initLogPath() {
  if (_logFilePath) return _logFilePath;
  try {
    let userData;
    try { userData = app.getPath('userData'); }
    catch { userData = path.join(os.homedir(), 'Library', 'Application Support', 'PostFlowX'); }
    const logsDir = path.join(userData, 'logs');
    try { fs.mkdirSync(logsDir, { recursive: true }); } catch {}
    _logFilePath = path.join(logsDir, 'imf_engine.log');
  } catch {}
  return _logFilePath;
}

/**
 * Append one or more log lines to the persistent IMF engine log.
 * Writes to ~/Library/Application Support/PostFlowX/logs/imf_engine.log.
 * Never throws — all errors are silently swallowed so decode never fails due to logging.
 */
function _writeEngineLog(lines) {
  try {
    const logFile = _initLogPath();
    if (!logFile) return;
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 23);
    const content = (Array.isArray(lines) ? lines : [lines])
      .filter(Boolean)
      .map(l => `[${ts}] ${l}\n`)
      .join('');
    if (content) fs.appendFileSync(logFile, content);
  } catch {}
}

async function _checkFFmpeg() {
  if (_ffmpegAvail !== null) return _ffmpegAvail;
  _ffmpegAvail = await ffmpegBackend.checkAvailability();
  return _ffmpegAvail;
}

// ── IMF package probe cache ─────────────────────────────────────────────────
// probeImfPackage() spawns a full `ffprobe -f imf` (parses the whole CPL +
// ASSETMAP graph) and was previously run on EVERY uncached frame. Package
// metadata is invariant for a given CPL, so the result is cached by
// cplPath + assetMaps. Failures are cached too (deterministic for this build /
// file) so a broken or demuxer-less ffmpeg doesn't re-spawn ffprobe per frame —
// that repeated probe is what filled the engine log with megabytes of retries.

const _imfProbeCache    = new Map(); // `${cplPath}|${assetMapsStr}` → probe result
const _streamProbeCache = new Map(); // mxfPath → probeStream result

async function _probeImfPackageCached(cplPath, assetMaps) {
  const assetMapsStr = (Array.isArray(assetMaps) ? assetMaps : []).join(',');
  const key = `${cplPath}|${assetMapsStr}`;
  if (_imfProbeCache.has(key)) return _imfProbeCache.get(key);
  const probe = await ffmpegBackend.probeImfPackage(cplPath, assetMaps);
  _imfProbeCache.set(key, probe);
  return probe;
}

// Per-MXF codec/HDR probe — invariant per file, but was re-run on every
// uncached frame on the direct-MXF decode path. Cache by path.
async function _probeStreamCached(mxfPath) {
  if (_streamProbeCache.has(mxfPath)) return _streamProbeCache.get(mxfPath);
  const probe = await ffmpegBackend.probeStream(mxfPath);
  _streamProbeCache.set(mxfPath, probe);
  return probe;
}

// ── preparePackage ────────────────────────────────────────────────────────────

/**
 * Scan an IMF package folder and build a package index.
 * The index is cached in memory for the process lifetime.
 *
 * @param {string} folderPath — absolute path to the IMF package folder,
 *   OR path to a CPL .xml file (folder is derived automatically).
 */
function preparePackage(folderPath) {
  try {
    // Normalise: if a CPL file was passed, use its directory
    const stat = fs.statSync(folderPath);
    const folder = stat.isDirectory() ? folderPath : path.dirname(folderPath);

    const idx = new IMFPackageIndex().scan(folder);

    if (idx.packageHash) {
      _packages.set(idx.packageHash, idx);
    }

    return { ok: true, packageId: idx.packageHash, index: idx.toJSON() };
  } catch (e) {
    return { ok: false, error: e.message, code: 'SCAN_ERROR' };
  }
}

// ── requestFrame ──────────────────────────────────────────────────────────────

/**
 * Request a decoded preview frame for a specific MXF frame.
 *
 * @param {object} args
 *   mxfPath      {string}  — absolute path to the .mxf file
 *   mxfFrame     {number}  — 0-based frame in the MXF (= CPL entryPoint + reelLocalFrame)
 *   packageHash  {string}  — package identifier for cache key
 *   cplId        {string}  — CPL UUID for cache key
 *   displayMode  {string}  — 'sdr' | 'hdr' | 'raw' (default: 'sdr')
 *   requestId    {string}  — client-supplied request ID for cancellation
 *
 * @returns {{ ok, imagePath?, imageDataUrl?, frameInfo, error?, code?, attemptedBackends[] }}
 */
async function requestFrame(args) {
  // Fast path: cached frames bypass the decode queue so scrubbing over
  // already-decoded frames stays instant and parallel.
  const hit = _cacheHit(args);
  if (hit) return hit;

  // Dedup: if an identical frame (same clip + frame + mode) is already being
  // decoded, share that decode instead of spawning a duplicate.
  const key = _frameKey(args);
  const existing = _inflight.get(key);
  if (existing) return existing;

  // Schedule under the global concurrency cap; the cap is what prevents the
  // process pile-up that used to freeze the machine.
  const p = _scheduleDecode(args, () => _requestFrameUncoalesced(args))
    .catch((e) => _errorResult(args, e));
  _inflight.set(key, p);
  p.finally(() => { if (_inflight.get(key) === p) _inflight.delete(key); });
  return p;
}

/**
 * Uncoalesced decode pipeline. Always goes through requestFrame() in normal
 * operation; split out so the scrub-storm guard can wrap it.
 */
async function _requestFrameUncoalesced(args) {
  const {
    mxfPath,
    mxfFrame     = 0,
    packageHash  = 'unknown',
    cplId        = 'unknown',
    displayMode  = 'sdr',
    lowres       = 0,
    requestId    = String(Date.now()),
  } = args || {};

  const cache = _ensureCache();
  const cmode = _cacheMode(displayMode, lowres);  // cache key (separates preview from full-res)
  // SDR frames are tone-mapped to 8-bit for display, so JPEG is safe and far
  // cheaper to encode/transfer than PNG. hdr/raw keep 16-bit PNG.
  const frameExt = displayMode === 'sdr' ? 'jpg' : 'png';
  const attemptedBackends = [];
  const log = [];

  const frameInfo = {
    mxfFrame,
    mxfPath: mxfPath ? path.basename(mxfPath) : null,
    backend: null,
    fromCache: false,
  };

  // ── Cache hit ──────────────────────────────────────────────────────────────
  const cached = cache.get(packageHash, cplId, mxfFrame, cmode);
  if (cached) {
    frameInfo.backend   = 'cache';
    frameInfo.fromCache = true;
    return {
      ok: true, imagePath: cached, imageUrl: _mediaUrl(cached),
      frameInfo: { ...frameInfo, backend: 'cache' },
      attemptedBackends: ['cache'],
    };
  }

  if (!mxfPath) {
    return {
      ok: false, code: 'NO_MXF_PATH', error: 'No MXF path provided',
      frameInfo, attemptedBackends,
    };
  }
  if (!fs.existsSync(mxfPath)) {
    return {
      ok: false, code: 'MXF_NOT_FOUND', error: `MXF not found: ${mxfPath}`,
      frameInfo, attemptedBackends,
    };
  }

  // ── Backend A: Resolve Engine / AVFoundation (OCF still pipeline) ────────────
  // 3-tier engine: Resolve → AVFoundation → FFmpeg, handles HTJ2K + full HDR.
  if (_mediaEngine && _mediaEngine.handles('media.getOcfStill')) {
    attemptedBackends.push('resolve');
    try {
      const ocf = await _mediaEngine.route({
        type: 'media.getOcfStill',
        payload: { ocfPath: mxfPath, sourceFrame: mxfFrame, outputWidth: 1920, colorPreviewMode: displayMode },
      });
      if (ocf?.ok && ocf.imageDataUrl) {
        const decoder = ocf.decoder || 'resolve';
        cache.ensureDir(packageHash, cplId);
        const outPath = cache.framePath(packageHash, cplId, mxfFrame, cmode);
        if (outPath) {
          try {
            const b64 = ocf.imageDataUrl.replace(/^data:[^;]+;base64,/, '');
            fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
          } catch {}
        }
        return {
          ok: true, imagePath: outPath || null, imageDataUrl: ocf.imageDataUrl,
          frameInfo: { ...frameInfo, backend: decoder, codec: ocf.codec || 'resolve' },
          probeInfo: null, attemptedBackends, log,
        };
      }
      if (ocf?.error) log.push(`resolve: ${ocf.error}`);
    } catch (e) {
      log.push(`resolve error: ${e.message}`);
    }
  }

  // ── Shared probe (used by Backends B and C) ──────────────────────────────
  const ffAvail = await _checkFFmpeg();
  let probe = null;

  if (ffAvail) {
    probe = await _probeStreamCached(mxfPath);
    log.push(`ffprobe: ${probe.ok ? probe.codec_name + (probe.isHDR ? ' HDR' : '') : probe.error}`);
  } else {
    log.push('ffmpeg not available in PATH');
  }

  // ── Backend B: Native HTJ2K (ojph_expand / ffmpeg+openjph) ───────────────
  // Only entered when the MXF is confirmed HTJ2K — J2K files skip to Backend C.
  if (probe?.ok && probe.isHTJ2K) {
    attemptedBackends.push('htj2k');
    const htj2kAvail = await htj2kBackend.checkAvailability();
    if (htj2kAvail.any) {
      cache.ensureDir(packageHash, cplId);
      const outPath = cache.framePath(packageHash, cplId, mxfFrame, cmode);
      const tmpOut  = outPath || require('path').join(require('os').tmpdir(), `pfx_htj2k_${Date.now()}.png`);
      const r = await htj2kBackend.extractFrame(mxfPath, mxfFrame, tmpOut, probe);
      if (r.ok && fs.existsSync(tmpOut)) {
        const dataUrl = _readAsDataUrl(tmpOut);
        if (!outPath) { try { fs.unlinkSync(tmpOut); } catch {} }
        const engineName = htj2kAvail.ffmpegOpenjph ? 'ffmpeg-openjph' : 'ojph';
        return {
          ok: true, imagePath: outPath || null, imageDataUrl: dataUrl,
          frameInfo: { ...frameInfo, backend: engineName, codec: probe.codec_name },
          probeInfo: probe, attemptedBackends, log,
        };
      }
      log.push(`htj2k: ${r.error || r.code}`);
    }
    // ── Metal HTJ2K native decoder (feature-flagged, default OFF) ────────────
    // When PFX_IMF_METAL_HTJ2K is set AND the native Metal helper is available,
    // extract the raw .j2c and decode it to interleaved samples on the GPU, then
    // attach the samples to the UNSUPPORTED_HTJ2K response (renderer presents them
    // directly, skipping WASM). On ANY error / unavailable / CAP-absent (Part-1,
    // e.g. Meridian => NOT_HTJ2K) this falls through to the existing path below,
    // so the flag-OFF (and failure) behaviour is byte-identical to before.
    if (process.env.PFX_IMF_METAL_HTJ2K && ffAvail) {
      try {
        const metal = require('./imf_metal_htj2k_backend');
        const mAvail = await metal.checkAvailability();
        if (mAvail.any) {
          const rawBuf = await htj2kBackend.extractRawCodestream(mxfPath, mxfFrame, probe);
          if (rawBuf && rawBuf.length > 16) {
            const os = require('os');
            const tmpJ2C = require('path').join(os.tmpdir(), `pfx_metal_${Date.now()}_${mxfFrame}.j2c`);
            fs.writeFileSync(tmpJ2C, rawBuf);
            let dec;
            // Map the renderer preview-scale ladder (lowres reduce-level) to the
            // decoder's --skip level: reduced-res is the realtime lever and is
            // bit-exact vs `ojph_expand -skip_res N` in the harness.
            try { dec = await metal.decodeCodestream(tmpJ2C, { skip: (lowres | 0) }); }
            finally { try { fs.unlinkSync(tmpJ2C); } catch {} }
            if (dec && dec.ok) {
              log.push(`metal-htj2k: decoded ${dec.width}x${dec.height} ${dec.pixelsType} on GPU`);
              return {
                ok: false, code: 'UNSUPPORTED_HTJ2K',        // reuse the renderer seam
                error: 'HTJ2K decoded by native Metal helper (samples attached)',
                samplesB64: dec.samples.toString('base64'),  // pre-decoded interleaved samples
                metalFrameInfo: {
                  width: dec.width, height: dec.height, componentCount: dec.componentCount,
                  bitsPerSample: dec.bitsPerSample, isSigned: dec.isSigned,
                  pixelsType: dec.pixelsType, sampleLayout: dec.sampleLayout,
                },
                frameInfo: { ...frameInfo, backend: 'metal-htj2k', codec: probe.codec_name },
                probeInfo: probe, attemptedBackends, log,
              };
            }
            log.push(`metal-htj2k: ${dec?.code || 'failed'} — falling back`);
          }
        }
      } catch (e) { log.push(`metal-htj2k: error ${e.message} — falling back`); }
    }

    // HTJ2K and no main-process decoder — try to extract raw codestream bytes
    // so the renderer's WASM HTJ2K decoder (OpenJPH WASM) can handle the frame.
    // ffmpeg -c:v copy works WITHOUT any HTJ2K decoder, so this is always possible
    // as long as ffmpeg is in PATH. The raw bytes are base64-encoded and piggybacked
    // onto the UNSUPPORTED_HTJ2K response; the renderer checks for essenceBytesB64.
    let essenceBytesB64 = null;
    if (ffAvail) {
      try {
        const rawBuf = await htj2kBackend.extractRawCodestream(mxfPath, mxfFrame, probe);
        if (rawBuf && rawBuf.length > 16) {
          essenceBytesB64 = rawBuf.toString('base64');
          log.push(`htj2k-raw: extracted ${rawBuf.length} codestream bytes for renderer WASM`);
        } else {
          log.push('htj2k-raw: codestream extraction returned empty/null');
        }
      } catch (e) {
        log.push(`htj2k-raw: extraction failed: ${e.message}`);
      }
    }
    return {
      ok: false, code: 'UNSUPPORTED_HTJ2K',
      error: 'HTJ2K: no main-process decoder (ojph_expand/ffmpeg-openjph not found or failed)',
      essenceBytesB64,  // renderer can decode this with its WASM OpenJPH
      frameInfo: { ...frameInfo, backend: null, codec: probe.codec_name },
      probeInfo: probe, attemptedBackends, log,
    };
  }

  // ── Backend B: Native decoder (asdcplib + OpenJPEG + libplacebo) ─────────
  // Handles regular J2K MXF with frame-accurate seeking and optional HDR/DV.
  // Preferred over FFmpeg when pfx-helper or asdcp+opj CLI tools are available.
  if (probe?.ok && (probe.isJ2K || probe.codec_name) && !probe.isHTJ2K) {
    const nativeAvail = await nativeDecoder.checkAvailability();
    if (nativeAvail.any) {
      attemptedBackends.push('native');
      cache.ensureDir(packageHash, cplId);
      const outPath = cache.framePath(packageHash, cplId, mxfFrame, cmode);
      const tmpOut  = outPath || path.join(os.tmpdir(), `pfx_native_${Date.now()}.png`);

      const nr = await nativeDecoder.extractFrame(mxfPath, mxfFrame, tmpOut, probe, displayMode);
      if (nr.ok && fs.existsSync(tmpOut)) {
        const dataUrl = _readAsDataUrl(tmpOut);
        if (!outPath) { try { fs.unlinkSync(tmpOut); } catch {} }
        const backendName = nativeAvail.pfxHelper ? 'pfx-helper' : 'asdcp+openjpeg';
        return {
          ok: true, imagePath: outPath || null, imageDataUrl: dataUrl,
          frameInfo: { ...frameInfo, backend: backendName, codec: probe.codec_name,
            toneMapApplied: nr.toneMapApplied || false,
            dvProfile: nr.dvProfile || null },
          probeInfo: probe, attemptedBackends, log,
        };
      }
      log.push(`native: ${nr.error || 'decode failed'}`);
    }
  }

  // ── Backend C: FFmpeg (J2K, non-HTJ2K) ───────────────────────────────────
  if (ffAvail && probe?.ok && (probe.isJ2K || probe.codec_name)) {
    attemptedBackends.push('ffmpeg');
    cache.ensureDir(packageHash, cplId);
    const outPath = cache.framePath(packageHash, cplId, mxfFrame, cmode, frameExt);

    if (!outPath) {
      const tmpOut = require('path').join(require('os').tmpdir(), `pfx_imf_${Date.now()}.${frameExt}`);
      const r = await ffmpegBackend.extractFrame(mxfPath, mxfFrame, tmpOut, probe, displayMode, { lowres });
      if (r.ok) {
        const dataUrl = _readAsDataUrl(tmpOut);
        try { fs.unlinkSync(tmpOut); } catch {}
        return {
          ok: true, imageDataUrl: dataUrl,
          frameInfo: { ...frameInfo, backend: 'ffmpeg', codec: probe.codec_name,
            toneMapApplied: r.toneMapApplied || null, rawHDR: r.rawHDR || false },
          attemptedBackends, log,
        };
      }
      log.push(`ffmpeg extract (tmp): ${r.error}`);
    } else {
      const r = await ffmpegBackend.extractFrame(mxfPath, mxfFrame, outPath, probe, displayMode, { lowres });
      if (r.ok) {
        return {
          ok: true, imagePath: outPath, imageUrl: _mediaUrl(outPath),
          frameInfo: { ...frameInfo, backend: 'ffmpeg', codec: probe.codec_name,
            toneMapApplied: r.toneMapApplied || null, rawHDR: r.rawHDR || false },
          probeInfo: probe, attemptedBackends, log,
        };
      }
      log.push(`ffmpeg extract: ${r.error} (${r.stderr || ''})`);
    }
  } else if (ffAvail && probe && !probe.ok) {
    log.push(`ffprobe failed: ${probe.error}`);
  }

  // ── Backend D: Placeholder ────────────────────────────────────────────────
  attemptedBackends.push('placeholder');
  return {
    ok: false, code: 'NO_BACKEND',
    error: `No backend could decode frame ${mxfFrame} from ${path.basename(mxfPath || '')}`,
    frameInfo, attemptedBackends, log,
  };
}

// ── findPosterFrame ───────────────────────────────────────────────────────────

/**
 * Sample a reel at 5%/15%/30%/50%/70% of its duration and return the first
 * frame whose luma is in the 'normal_frame' range. Skips pure black, near-white,
 * and slate frames. Falls back to the 30% mark if no normal frame is found.
 *
 * @param {object} args
 *   mxfPath     {string}  — absolute path to the .mxf file
 *   totalFrames {number}  — CPL sourceDuration (reel frame count)
 *   entryPoint  {number}  — CPL entryPoint (absolute MXF frame offset)
 *   packageHash {string}
 *   cplId       {string}
 *   displayMode {string}  — 'sdr' | 'hdr' | 'raw'
 *
 * @returns {{ ok, frame, mxfFrame, imageDataUrl?, frameInfo, attemptedBackends[] }}
 */
async function findPosterFrame(args) {
  const {
    mxfPath,
    totalFrames  = 0,
    entryPoint   = 0,
    packageHash  = 'unknown',
    cplId        = 'unknown',
    displayMode  = 'sdr',
  } = args || {};

  if (!mxfPath || totalFrames < 1) {
    return { ok: false, error: 'mxfPath and totalFrames required' };
  }

  const samplePcts = [0.05, 0.15, 0.30, 0.50, 0.70];
  let fallbackResult = null;

  for (const pct of samplePcts) {
    const reelFrame = Math.min(Math.floor((totalFrames - 1) * pct), totalFrames - 1);
    const mxfFrame  = entryPoint + reelFrame;

    const result = await requestFrame({ mxfPath, mxfFrame, packageHash, cplId, displayMode });
    if (!result.ok) continue;

    // Quick luma classification using Node.js — decode PNG with ffprobe signalstats
    const imagePath = result.imagePath;
    let lumaClass = 'unknown';
    if (imagePath && fs.existsSync(imagePath)) {
      try {
        const stats = await ffmpegBackend.lumaStats(imagePath);
        lumaClass = stats.classification;
      } catch {}
    }

    const isNormal = lumaClass === 'normal_frame' || lumaClass === 'unknown';
    if (!fallbackResult || pct === 0.30) fallbackResult = { ...result, reelFrame, mxfFrame, lumaClass };

    if (isNormal) {
      return { ok: true, frame: reelFrame, mxfFrame, lumaClass, ...result };
    }
  }

  // No normal frame found — return 30% fallback (or best we have)
  if (fallbackResult) {
    return { ok: true, ...fallbackResult, frame: fallbackResult.reelFrame };
  }
  return { ok: false, error: 'No decodable poster frame found' };
}

// ── cacheFrame ────────────────────────────────────────────────────────────────

/**
 * Persist a renderer-decoded frame to the main-process cache.
 * Called via pfx:imf:cacheFrame when the renderer's J2K/HTJ2K path succeeds.
 * On subsequent requestFrame calls, the cache hit path returns instantly.
 *
 * @param {{ packageHash, cplId, mxfFrame, displayMode, imageDataUrl }} args
 * @returns {{ ok, imagePath?, error? }}
 */
function cacheFrame({ packageHash, cplId, mxfFrame, displayMode = 'sdr', imageDataUrl } = {}) {
  if (!packageHash || !cplId || mxfFrame == null || !imageDataUrl) {
    return { ok: false, error: 'missing required fields' };
  }
  try {
    const cache = _ensureCache();
    cache.ensureDir(packageHash, cplId);
    const outPath = cache.framePath(packageHash, cplId, mxfFrame, displayMode);
    if (!outPath) return { ok: false, error: 'cache path unavailable' };
    // Skip if already cached — renderer fires this fire-and-forget
    if (fs.existsSync(outPath)) return { ok: true, imagePath: outPath, skipped: true };
    const b64 = imageDataUrl.replace(/^data:[^;]+;base64,/, '');
    fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    return { ok: true, imagePath: outPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── clearCache ────────────────────────────────────────────────────────────────

function clearCache(packageHash) {
  const cache = _ensureCache();
  if (packageHash) cache.clearPackage(packageHash);
  else { cache.clearAll(); _imfProbeCache.clear(); _streamProbeCache.clear(); }
}

// ── diagnostics ───────────────────────────────────────────────────────────────

async function diagnostics() {
  const cache = _ensureCache();
  const [ffmpegAvailable, htj2kAvail, nativeAvail] = await Promise.all([
    _checkFFmpeg(),
    htj2kBackend.checkAvailability(),
    nativeDecoder.checkAvailability(),
  ]);
  return {
    ffmpegAvailable,
    htj2kFfmpegOpenjph: htj2kAvail.ffmpegOpenjph,
    htj2kOjphExpand:    htj2kAvail.ojphExpand,
    nativeDecoderAvailable:  nativeAvail.any,
    nativePfxHelper:         nativeAvail.pfxHelper,
    nativeAsdcpCli:          nativeAvail.asdcpCli,
    nativeOpenjpeg:          nativeAvail.openjpeg,
    nativeLibplacebo:        nativeAvail.libplacebo,
    nativeVersion:           nativeAvail.version || null,
    cacheDir: cache._baseDir || null,
    cacheSizeBytes: cache.sizeBytes(),
    packageCount: _packages.size,
    resolveAvailable: !!(_mediaEngine && _mediaEngine.handles('media.getOcfStill')),
  };
}

// ── getReelList ───────────────────────────────────────────────────────────────

/**
 * Return the reel list for a CPL in a previously-prepared package.
 * Used by the renderer (via IPC) to obtain absolute mxfPath values for each
 * reel when operating in Electron companion mode (no browser File handles).
 *
 * @param {string} packageHash — key returned by preparePackage
 * @param {string} [cplId]     — CPL UUID; omit to use the package's active CPL
 * @returns {{ ok, reels? }} where reels = buildReelList() output
 */
function getReelList(packageHash, cplId) {
  let idx = _packages.get(packageHash);
  // For multi-package bundles, the CPL may live in a supplemental package registered
  // under a different hash. Search all loaded packages when the primary one lacks it.
  if (cplId && (!idx || !idx.cplById?.get(cplId))) {
    for (const [, pkg] of _packages) {
      if (pkg.cplById?.get(cplId)) { idx = pkg; break; }
    }
  }
  if (!idx) return { ok: false, error: 'Package not found', code: 'NOT_FOUND' };
  try {
    const reels = idx.buildReelList(cplId || null);
    return { ok: true, reels };
  } catch (e) {
    return { ok: false, error: e.message, code: 'BUILD_REEL_ERROR' };
  }
}

// ── getCplInfo ────────────────────────────────────────────────────────────────

/**
 * Return the CPL XML path and all discovered ASSETMAP.xml paths for a package.
 * Used by the renderer to feed the FFmpeg IMF demuxer (-f imf -assetmaps ...).
 *
 * Collects ASSETMAP paths from:
 *  1. The primary package's own assetMapPath
 *  2. All other loaded packages (supplemental bundles opened separately)
 *  3. Subdirectory scan of the package folder (up to 2 levels, for nested supplementals)
 *
 * @param {string} packageHash — key from preparePackage
 * @param {string} [cplId]     — CPL UUID; omit to use the package's active CPL
 * @returns {{ ok, cplPath, assetMapPaths }}
 */
function getCplInfo(packageHash, cplId) {
  let idx = _packages.get(packageHash);
  // For multi-package bundles, the CPL may live in a supplemental package registered
  // under a different hash. Search all loaded packages when the primary one lacks it.
  if (cplId && (!idx || !idx.cplById?.get(cplId))) {
    for (const [, pkg] of _packages) {
      if (pkg.cplById?.get(cplId)) { idx = pkg; break; }
    }
  }
  if (!idx) return { ok: false, error: 'Package not found', code: 'NOT_FOUND' };

  const cpl = cplId ? idx.cplById.get(cplId) : idx.activeCpl;
  if (!cpl) return { ok: false, error: 'CPL not found in package', code: 'CPL_NOT_FOUND' };

  const assetMapSet = new Set();

  // 1. Primary package ASSETMAP
  if (idx.assetMapPath) assetMapSet.add(idx.assetMapPath);

  // 2. All other loaded packages (user may open base + supplemental as separate folders)
  for (const [, pkg] of _packages) {
    if (pkg.assetMapPath) assetMapSet.add(pkg.assetMapPath);
  }

  // 3. Scan package folder for additional ASSETMAP.xml files (nested supplementals)
  if (idx.folderPath) _scanFolderForAssetMaps(idx.folderPath, assetMapSet, 2);

  return {
    ok: true,
    cplPath:       cpl.cplPath || null,
    assetMapPaths: [...assetMapSet],
  };
}

function _scanFolderForAssetMaps(folderPath, resultSet, maxDepth, _depth = 0) {
  if (_depth > maxDepth) return;
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && /^assetmap(\.xml)?$/i.test(e.name)) {
        resultSet.add(path.join(folderPath, e.name));
      } else if (e.isDirectory() && _depth < maxDepth) {
        _scanFolderForAssetMaps(path.join(folderPath, e.name), resultSet, maxDepth, _depth + 1);
      }
    }
  } catch {}
}

// ── decodeFrame (IMF demuxer path) ────────────────────────────────────────────

/**
 * Decode a single frame from a CPL using the FFmpeg IMF demuxer (-f imf -assetmaps).
 * This is the primary decode path — it bypasses per-MXF asset resolution and lets
 * ffmpeg handle multi-package supplemental content natively.
 *
 * @param {object} args
 *   cplPath      {string}    — absolute path to the CPL XML
 *   assetMaps    {string[]}  — all ASSETMAP.xml paths
 *   frameNumber  {number}    — CPL-absolute 0-based frame index
 *   scale        {string}    — 'viewer' (960px) | 'full' | 'none'
 *   packageHash  {string}
 *   cplId        {string}
 *   displayMode  {string}    — 'sdr' | 'hdr' | 'raw'
 *
 * @returns {{ ok, imagePath?, imageDataUrl?, imfDemuxerOK, codec?, backend?, stderr?, errors[], log[] }}
 */
async function decodeFrame(args = {}) {
  const {
    cplPath,
    assetMaps    = [],
    frameNumber  = 0,
    scale        = 'viewer',
    packageHash  = 'imf',
    cplId        = 'cpl',
    displayMode  = 'sdr',
    lowres       = 0,
  } = args;

  const log    = [];
  const errors = [];

  log.push(`[IMF] assetMaps=${JSON.stringify(assetMaps)}`);
  log.push(`[IMF] cpl=${cplPath}`);
  log.push(`[IMF] frameNumber=${frameNumber}`);

  if (!cplPath) {
    errors.push('cplPath required');
    _writeEngineLog(log);
    return { ok: false, error: 'cplPath required', code: 'NO_CPL_PATH', imfDemuxerOK: false, errors, log };
  }
  if (!fs.existsSync(cplPath)) {
    errors.push(`CPL not found: ${cplPath}`);
    _writeEngineLog(log);
    return { ok: false, error: `CPL not found: ${cplPath}`, code: 'CPL_NOT_FOUND', imfDemuxerOK: false, errors, log };
  }

  const ffAvail = await _checkFFmpeg();
  if (!ffAvail) {
    errors.push('ffmpeg not in PATH');
    _writeEngineLog(log);
    return { ok: false, error: 'ffmpeg not available in PATH', code: 'FFMPEG_NOT_FOUND', imfDemuxerOK: false, errors, log };
  }

  // Log engine capabilities once per decode (capabilities are cached after first check)
  let caps = null;
  try {
    caps = await ffmpegBackend.engineCapabilities();
    log.push(`[IMF] ffmpegPath=${caps.ffmpegPath || 'unknown'}`);
    log.push(`[IMF] ffmpegImfDemuxer=${caps.ffmpegImfDemuxer} libopenjpeg=${caps.libopenjpeg} libxml2=${caps.ffmpegLibxml2}`);
    log.push(`[IMF] ffmpegBuildConf=${(caps.ffmpegVersion || '').split(' ').slice(0, 6).join(' ')}`);
  } catch {}

  // ── Cache check ───────────────────────────────────────────────────────────
  const cache     = _ensureCache();
  const cmode     = _cacheMode(displayMode, lowres);
  const cached    = cache.get(packageHash, cplId, frameNumber, cmode);
  if (cached) {
    log.push('[IMF] cache hit');
    return { ok: true, imagePath: cached, imageUrl: _mediaUrl(cached), imfDemuxerOK: true, fromCache: true, errors, log };
  }

  // ── Step 1: ffprobe self-test ─────────────────────────────────────────────
  const assetMapsStr = (Array.isArray(assetMaps) ? assetMaps : []).join(',');
  const probeCmd = [
    'ffprobe -hide_banner -v quiet -f imf',
    assetMapsStr ? `-assetmaps "${assetMapsStr}"` : '',
    '-show_streams -show_format -of json',
    `"${cplPath}"`,
  ].filter(Boolean).join(' ');
  log.push(`[IMF] ffprobeCommand=${probeCmd}`);
  let probe;
  if (caps && caps.ffmpegImfDemuxer === false) {
    // This ffmpeg build has no IMF demuxer (-f imf needs libxml2). The probe
    // can only ever fail, so skip the per-frame ffprobe spawn and go straight
    // to the direct-MXF fallback below.
    probe = { ok: false, imfDemuxerOK: false, error: 'IMF demuxer not built into ffmpeg (-f imf unavailable) — probe skipped' };
    log.push('[IMF] ffprobe skipped — ffmpegImfDemuxer=false');
  } else {
    probe = await _probeImfPackageCached(cplPath, assetMaps);
  }
  log.push(`[IMF] ffprobeOK=${probe.ok} codec=${probe.pictureCodec || '?'} streams=${probe.streamCount || 0}`);
  if (probe.ok) log.push(`[IMF] codec=${probe.pictureCodec || '?'} fps=${probe.fps || '?'} w=${probe.width} h=${probe.height}`);
  if (probe.stderr) log.push(`[IMF] probe.stderr=${probe.stderr.slice(0, 300)}`);

  if (!probe.ok) {
    errors.push(`ffprobe IMF demuxer: ${probe.error}`);
    log.push(`[IMF] IMF demuxer probe failed — checking for direct MXF fallback`);

    // IMF demuxer not available in this ffmpeg build (no -f imf support).
    // Fall back: look up the reel's MXF path from the package index and decode directly.
    // Use buildReelList() which handles cross-package asset resolution (base + supplemental).
    let fallbackMxfPath = null;
    let fallbackMxfFrame = frameNumber;

    // Search all loaded packages — supplemental CPLs reference MXFs from the base package
    for (const [, pkg] of _packages) {
      try {
        const reels = pkg.buildReelList(cplId || null);
        for (const reel of reels) {
          if (reel.mxfPath && fs.existsSync(reel.mxfPath)) {
            // If we have a frame number, find the right reel by composition frame range
            if (frameNumber >= reel.compStartFrame && frameNumber <= reel.compEndFrame) {
              fallbackMxfPath = reel.mxfPath;
              fallbackMxfFrame = reel.entryPoint + (frameNumber - reel.compStartFrame);
              log.push(`[IMF] Reel match: reel ${reel.reelIndex + 1} compFrame ${reel.compStartFrame}-${reel.compEndFrame}, mxfFrame=${fallbackMxfFrame}`);
              break;
            }
          }
        }
        if (fallbackMxfPath) break;
        // No exact reel match — take first valid MXF as last resort
        const firstValid = reels.find(r => r.mxfPath && fs.existsSync(r.mxfPath));
        if (firstValid) {
          fallbackMxfPath = firstValid.mxfPath;
          fallbackMxfFrame = firstValid.entryPoint + Math.min(frameNumber, firstValid.sourceDuration - 1);
          log.push(`[IMF] No exact reel match, using first valid MXF: ${path.basename(fallbackMxfPath)}`);
        }
      } catch (e) {
        log.push(`[IMF] buildReelList error for pkg: ${e.message}`);
      }
      if (fallbackMxfPath) break;
    }
    if (fallbackMxfPath) {
      log.push(`[IMF] resolvedMxf=${fallbackMxfPath}`);
      log.push(`[IMF] selectedFrame=${fallbackMxfFrame}`);
    } else {
      log.push('[IMF] No fallback MXF found across all loaded packages');
    }

    if (fallbackMxfPath) {
      log.push(`[IMF] Attempting direct MXF decode: ${path.basename(fallbackMxfPath)} frame=${fallbackMxfFrame}`);
      const fallbackResult = await requestFrame({
        mxfPath: fallbackMxfPath,
        mxfFrame: fallbackMxfFrame,
        packageHash,
        cplId: cplId || 'cpl',
        displayMode,
        lowres,
        requestId: `decodeFrame-fallback-${frameNumber}`,
      });
      if (fallbackResult.ok) {
        log.push(`[IMF] Direct MXF decode succeeded (backend=${fallbackResult.frameInfo?.backend})`);
        _writeEngineLog(log);
        return {
          ...fallbackResult,
          imfDemuxerOK: false,
          backend: fallbackResult.frameInfo?.backend || 'ffmpeg-mxf',
          codec: fallbackResult.frameInfo?.codec,
          log, errors,
          _usedMxfFallback: true,
        };
      }
      log.push(`[IMF] Direct MXF fallback also failed: ${fallbackResult.error || fallbackResult.code}`);
    }

    _writeEngineLog(log);
    return {
      ok: false, error: probe.error, code: 'PROBE_FAILED',
      imfDemuxerOK: false, stderr: probe.stderr,
      errors, log,
    };
  }

  // ── Step 2: Extract frame ─────────────────────────────────────────────────
  const outPath = path.join(os.tmpdir(), `pfx_imf_${packageHash}_fr${frameNumber}_${require('crypto').randomUUID()}.png`);
  const decodeCmd = [
    'ffmpeg -hide_banner -y -f imf',
    assetMapsStr ? `-assetmaps "${assetMapsStr}"` : '',
    `-i "${path.basename(cplPath)}"`,
    '-map 0:v:0 -vf scale=960:-2 -frames:v 1 -f image2',
    `"${outPath}"`,
  ].filter(Boolean).join(' ');
  log.push(`[IMF] decodeCommand=${decodeCmd}`);
  log.push(`[IMF] outputPng=${outPath}`);

  const r = await ffmpegBackend.extractImfFrame(cplPath, assetMaps, frameNumber, outPath, scale, probe);
  const fileExists = (() => { try { return fs.existsSync(outPath); } catch { return false; } })();
  log.push(`[IMF] decodeOK=${r.ok} fileExists=${fileExists}`);
  if (r.stderr) log.push(`[IMF] stderr=${r.stderr.slice(0, 500)}`);

  if (!r.ok) {
    errors.push(`ffmpeg: ${r.error}`);
    _writeEngineLog(log);
    return {
      ok: false, error: r.error, code: r.code || 'DECODE_FAILED',
      imfDemuxerOK: true, probe, stderr: r.stderr,
      errors, log,
    };
  }

  // ── Persist to cache ──────────────────────────────────────────────────────
  cache.ensureDir(packageHash, cplId);
  const cachePath = cache.framePath(packageHash, cplId, frameNumber, cmode);
  if (cachePath) {
    try { fs.copyFileSync(outPath, cachePath); } catch {}
  }

  // Persisted cache frames are served via pfx-media:// (no base64 over IPC).
  // If we couldn't persist, outPath is a temp file with no stable URL, so fall
  // back to a base64 data URL.
  const finalPath    = cachePath || outPath;
  const imageUrl     = cachePath ? _mediaUrl(finalPath) : undefined;
  const imageDataUrl = cachePath ? undefined : _readAsDataUrl(finalPath);

  // Clean up tmp file if we have a cache copy
  if (cachePath) { try { fs.unlinkSync(outPath); } catch {} }

  log.push(`[IMF] finalPath=${finalPath}`);
  _writeEngineLog(log);
  return {
    ok: true,
    imagePath:     finalPath,
    imageUrl,
    imageDataUrl,
    imfDemuxerOK:  true,
    codec:         probe.pictureCodec,
    backend:       'ffmpeg-imf',
    probe,
    errors,
    log,
  };
}

// ── engineStatus ─────────────────────────────────────────────────────────────

/**
 * Return the full engine capability status for the IMF validation tab status panel.
 * Returns { engines: [{ id, label, status, detail }], caps }
 * where status is 'ready' | 'partial' | 'missing'.
 */
async function engineStatus() {
  const [caps, htj2k, native] = await Promise.all([
    ffmpegBackend.engineCapabilities(),
    htj2kBackend.checkAvailability(),
    nativeDecoder.checkAvailability(),
  ]);

  const engines = [
    {
      id:     'native',
      label:  'Native IMF Decoder (asdcplib + OpenJPEG)',
      status: native.pfxHelper ? 'ready' : native.any ? 'partial' : 'missing',
      detail: native.pfxHelper
        ? `pfx-helper ${native.version || ''} — frame-accurate asdcplib demux + OpenJPEG decode${native.libplacebo ? ' + libplacebo HDR' : ''}`
        : native.any
          ? `CLI tools: asdcp-test=${native.asdcpCli} opj_decompress=${native.openjpeg} (no GPU HDR)`
          : 'Not found — install via: brew install asdcplib openjpeg, or build pfx-helper from electron/imf/pfx-helper/',
    },
    {
      id:     'libplacebo',
      label:  'libplacebo (HDR10 + Dolby Vision P5/P8)',
      status: native.libplacebo ? 'ready' : 'missing',
      detail: native.libplacebo
        ? 'Linked in pfx-helper — Metal GPU HDR tone-mapping + DV P5/P8 active'
        : 'Not available — build pfx-helper with libplacebo: brew install libplacebo && electron/imf/pfx-helper/build.sh',
    },
    {
      id:     'ffmpeg',
      label:  'FFmpeg (Backend C fallback)',
      status: caps.ffmpeg ? 'ready' : 'missing',
      detail: caps.ffmpeg
        ? `${caps.ffmpegPath} · ${(caps.ffmpegVersion || '').split(' ').slice(0, 3).join(' ')}`
        : 'Not found in /opt/homebrew/bin, /usr/local/bin, /usr/bin',
    },
    {
      id:     'ffmpeg-imf',
      label:  'FFmpeg IMF Demuxer (-f imf)',
      status: caps.ffmpegImfDemuxer ? 'ready' : 'missing',
      detail: caps.ffmpegImfDemuxer
        ? 'libxml2 + IMF demuxer compiled in'
        : 'Not compiled in Homebrew ffmpeg — direct MXF fallback active. Build ffmpeg with --enable-libxml2 to enable.',
    },
    {
      id:     'openjph',
      label:  'OpenJPH (HTJ2K)',
      status: (caps.openjph || htj2k.any) ? 'ready' : 'missing',
      detail: htj2k.ffmpegOpenjph
        ? 'ffmpeg compiled with openjph decoder'
        : caps.openjph
          ? 'ojph_expand found at /opt/homebrew/bin/ojph_expand'
          : 'ojph_expand not found — HTJ2K (JPEG 2000 Part 15) cannot be decoded',
    },
    {
      id:     'photon',
      label:  'Photon Validator',
      status: 'missing',
      detail: 'Not bundled in this build (requires Java runtime)',
    },
  ];

  return { engines, caps };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _readAsDataUrl(filePath) {
  try {
    const buf  = fs.readFileSync(filePath);
    const mime = filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')
      ? 'image/jpeg' : 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
}

// pfx-media:// URL for a frame already persisted in the on-disk cache. The
// renderer fetches the bytes natively via the protocol handler instead of us
// reading the file, base64-encoding it, and shipping a multi-MB string over IPC
// per frame. Only valid for persistent cache files (NOT temp files we unlink).
function _mediaUrl(filePath) {
  return `pfx-media://localfile/${encodeURIComponent(filePath)}`;
}

module.exports = { init, preparePackage, requestFrame, cacheFrame, findPosterFrame, clearCache, diagnostics, getReelList, getCplInfo, decodeFrame, engineStatus };
