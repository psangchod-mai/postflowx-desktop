// scripts/features/trlconf/index.js
import { loadModel, extractEmbedding, searchMasterAI, isReady as aiReady, AI_W, AI_H } from './ai_matcher.js';
import { sharedMediaOpen, sharedMediaClose, nativeHelperPing } from '../../modules/native_helper_client.js';
import { getProxyStreamUrl, tryRestoreProxyForMeta } from '../../modules/proResProxy.js';
import { neOpen, neFrameExtract } from '../../media/nativeEngineClient.js';
import { attachResolveTransport } from '../../core/resolveVideoTransport.js';
import { regionalHash, regionalDistance, distanceToConfidence, confidenceStatus, MAX_DISTANCE as _REGIONAL_MAX_DIST } from '../../modules/conform/pictureMatcher.js';
import { isRefinableSpeed, acceptRefinedEnd } from '../../modules/conform/endRefine.js';
import { shouldSearchAllMasters, pickBestMaster, resolveMaster, isEpisodeLibraryEvent, WEAK_MATCH_CONFIDENCE } from '../../modules/conform/multiMaster.js';
import { histCorrelation, segmentShots } from '../../modules/conform/shotDetect.js';
import { mergeAdjacentMatches } from '../../modules/conform/mergeMatches.js';   // no-EDL detected-shot repair (used by _detectAndMatchNoEdl)
import { confidenceLabel } from '../../modules/conform/audioMatcher.js';        // plain-word confidence label beside the Final % (high/medium/low)
import { referenceBaseFrames } from '../../modules/conform/referenceTimeline.js';
import { robustPixelSimilarity, pixelSimilarityStatus } from '../../modules/conform/pixelSimilarity.js';
import { relativeTime } from '../../core/relativeTime.js';
// Trailers Conform — re-conform a trailer cut (from proxy/locked files)
// to final Screening Masters, inspired by EditHero's shot-matching workflow.
// Visual frame matching uses perceptual hashing (mean hash) vs UNMREF.
// -------------------------------------------------------------------------
//
// Workflow:
//   Trailer Cut   = XML (XMEML/FCPXML) or EDL — the trailer picture cut
//   Source Folder = Screening Masters (full episode ProRes/MOV files)
//   Ref MOV       = UNMREF / flattened trailer render for visual matching
//
//   1. Parse trailer cut → events with source clip names + timecodes
//   2. Extract episode numbers from proxy clip names (TNG2_204_... → 204)
//   3. Match episode numbers to screening master files
//   4. Build reel map: proxy clip → screening master
//   5. [Visual Match] For each event: grab frame from UNMREF at rec-in,
//      search matching master for most-similar frame → exact src timecode
//   6. Export corrected XML/EDL/CSV pointing at screening masters
// -------------------------------------------------------------------------

const DEFAULT_FPS = 24;
let _companionTokenPromise = null;

// ── Helpers ──────────────────────────────────────────────────────────────

function _esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _stem(name) {
  return String(name || '').replace(/\.[^/.]+$/, '').trim();
}

// Attach the native filesystem path (Electron webUtils.getPathForFile) to picked/
// dropped File objects. Trailer Conform passes this path to the bundled Swift
// AVFoundation engine, which reads Apple ProRes frames in place — no upload,
// copy, or H.264 proxy. No-op on the web build or when a path is unavailable.
function _withNativePaths(files) {
  const getp = (typeof window !== 'undefined') && window.pfxPlatform?.getNativeFilePath;
  if (typeof getp !== 'function' || !Array.isArray(files)) return files;
  for (const f of files) {
    if (f && !f._nativePath) {
      try { const p = getp(f); if (p) f._nativePath = p; } catch { /* keep undefined → upload fallback */ }
    }
  }
  return files;
}

function _fpsIsDrop(fps) {
  return Math.abs(fps - 29.97) < 0.01 || Math.abs(fps - 59.94) < 0.01;
}

// ── Two clocks run through this file; they are not the same number ──────────
// `state.fps`      whole-frame TIMECODE BASE   — 24 on a 23.976 show, 30 on 29.97
// `state.fpsExact` true PLAYBACK RATE          — 23.976023976…, 29.97002997…
//
// Timecode arithmetic (_tcToFrames / _framesToTC / _eventFrameMetrics) counts
// frame FIELDS and must use the base. Anything that reaches real media time —
// a video.currentTime seek, a frames→seconds display, a seconds→frames result
// coming back OUT of a seek — must use the exact rate, or it is 0.1% off on
// every NTSC show: 3.6 seconds, ~86 frames, at the one-hour mark.
//
// The visual conform engine below seeks the REFERENCE video with no search
// window at all, so a rate error there does not degrade a match — it hashes a
// different shot and matches that instead. Parsers now report both halves
// (see src/scripts/parsers/*.js); this file is the consumer that needs them.
function _tcToFrames(tc, fps = DEFAULT_FPS) {
  const m = String(tc || '').trim().match(/^(\d{2})[:;](\d{2})[:;](\d{2})([:;])(\d{2})$/);
  if (!m) return 0;
  const hh = +m[1], mm = +m[2], ss = +m[3], ff = +m[5];
  // Nominal integer rate (24 for 23.976, 30 for 29.97) — a TC's frame field
  // counts nominal frames, so multiplying by the fractional fps is wrong.
  const nominal = fps > 0 ? Math.round(fps) : 24;
  if (m[4] === ';') {   // drop-frame TC
    const drop = nominal === 30 ? 2 : 4;
    const totalMin = hh * 60 + mm;
    const dropped = drop * (totalMin - Math.floor(totalMin / 10));
    return hh * 3600 * nominal + mm * 60 * nominal + ss * nominal + ff - dropped;
  }
  return (hh * 3600 + mm * 60 + ss) * nominal + ff;
}

function _framesToTC(frames, fps = DEFAULT_FPS) {
  frames = Math.max(0, Math.round(frames));
  let sep = ':';
  let rate = fps > 0 ? Math.round(fps) : 24;
  if (_fpsIsDrop(fps)) {
    const nominal = Math.round(fps);
    const drop = nominal === 30 ? 2 : 4;
    const framesPerMin = nominal * 60 - drop;
    const framesPer10Min = framesPerMin * 10 + drop;
    const d = Math.floor(frames / framesPer10Min);
    const md = frames % framesPer10Min;
    if (md > drop) frames += (drop * 9 * d) + drop * Math.floor((md - drop) / framesPerMin);
    else frames += drop * 9 * d;
    sep = ';';
    rate = nominal;
  }
  const ff = frames % rate;
  const totalS = Math.floor(frames / rate);
  const ss = totalS % 60;
  const mm = Math.floor(totalS / 60) % 60;
  const hh = Math.floor(totalS / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}${sep}${p(ff)}`;
}

function _pathToFileUrl(path) {
  const raw = String(path || '').trim();
  if (!raw) return '';
  if (/^file:\/\//i.test(raw)) return raw;
  const normalized = raw.replace(/\\/g, '/');
  return `file://${normalized.startsWith('/') ? '' : '/'}${encodeURI(normalized)}`;
}

function _download(text, filename, mime = 'text/plain') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function _decodeStatusLabel(mode) {
  switch (mode) {
    case 'native-avfoundation': return 'Direct Apple ProRes · AVFoundation';
    case 'native-stream':   return 'Ready via native stream';
    case 'proxy-cache':     return 'Ready via cached proxy';
    case 'proxy-transcode': return 'Ready via proxy convert';
    case 'browser-direct':  return 'Direct decode';
    case 'browser-fallback':return 'Fallback decode';
    default:                return 'Ready';
  }
}

async function _getCompanionHttpToken() {
  const existing = String(window.__pfxCompanionHttpToken || '').trim();
  if (existing) return existing;
  if (_companionTokenPromise) return _companionTokenPromise;
  _companionTokenPromise = (async () => {
    try {
      const resp = await nativeHelperPing();
      const token = String(resp?.data?.httpToken || '').trim();
      if (token) {
        try { window.__pfxCompanionHttpToken = token; } catch {}
      }
      return token;
    } catch {
      return '';
    } finally {
      _companionTokenPromise = null;
    }
  })();
  return _companionTokenPromise;
}

async function _withCompanionToken(url) {
  const raw = String(url || '').trim();
  if (!raw) return raw;
  if (!/^https?:\/\/127\.0\.0\.1:\d+\//i.test(raw)) return raw;
  if (/[?&]token=/.test(raw)) return raw;
  const token = await _getCompanionHttpToken();
  if (!token) return raw;
  return `${raw}${raw.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

// Fetch the startTimecode stored in a proxy transcode session.
// The companion stores it during the ffprobe pre-probe; the /progress/ endpoint
// surfaces it as startTimecode. Returns '' if unavailable.
async function _fetchProxyTimecodeStart(streamUrl, sessionId) {
  if (!streamUrl || !sessionId) return '';
  try {
    const portMatch = String(streamUrl).match(/127\.0\.0\.1:(\d+)/);
    const port = portMatch ? portMatch[1] : '47125';
    const raw = `http://127.0.0.1:${port}/progress/${sessionId}`;
    const url = await _withCompanionToken(raw);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    let resp;
    try { resp = await fetch(url, { signal: ctrl.signal }); } finally { clearTimeout(timer); }
    if (!resp.ok) return '';
    const data = await resp.json();
    return String(data.startTimecode || '');
  } catch {
    return '';
  }
}

// Extract episode number from a filename.
// Supports: TNG2_204_LOCKED..., BLVRS2_202_..., TheBelieversSeason2_204_..., S2E04, etc.
function _extractEpNum(name) {
  const s = _stem(name);

  // Human-readable editorial names such as
  // `The_Believers_Season_2_Episode_2_...` identify the same master as 202.
  let m = s.match(/season[_\s-]*(\d+).*?episode[_\s-]*(\d+)/i);
  if (m) return (parseInt(m[1], 10) * 100) + parseInt(m[2], 10);

  // Pattern: _NNN_ or _NNN at end (3-digit episode number)
  m = s.match(/_(\d{3})(?:_|$)/);
  if (m) return parseInt(m[1], 10);

  // Pattern: Season2_NNN_  (e.g. TheBelieversSeason2_204_)
  m = s.match(/Season\d+[_\s](\d{3})/i);
  if (m) return parseInt(m[1], 10);

  // Pattern: S\d+E(\d+)
  m = s.match(/S\d+E(\d+)/i);
  if (m) return parseInt(m[1], 10);

  // Pattern: Ep(\d+)
  m = s.match(/[Ee]p(\d+)/);
  if (m) return parseInt(m[1], 10);

  // Pattern: standalone 3-digit number surrounded by non-digits
  m = s.match(/(?:^|[^0-9])(\d{3})(?:[^0-9]|$)/);
  if (m) return parseInt(m[1], 10);

  return null;
}

// Fuzzy score 0-100 between two episode numbers (exact = 100, off by 1 = 20, else 0)
function _epScore(a, b) {
  if (a == null || b == null) return 0;
  if (a === b) return 100;
  if (Math.abs(a - b) === 1) return 20;
  return 0;
}

// ── CMX3600 EDL Builder ──────────────────────────────────────────────────

// eventCorrections: ev.id → { srcIn, srcOut, confidence, method }
// Visual corrections take priority over the TC-offset approach.
function _buildEDL(events, reelMapByProxy, fps, seqTitle, tcOffsets, eventCorrections) {
  const lines = [`TITLE: ${seqTitle}`, 'FCM: NON-DROP FRAME', ''];
  let evNum = 1;

  for (const ev of events) {
    if (ev.disabled || ev.type !== 'video' || ev.autoPreserve) continue;

    const proxyKey = ev.reel || ev.srcFile || '';
    const entry = reelMapByProxy[proxyKey];
    const reel = entry?.status === 'matched'
      ? _stem(entry.masterName).substring(0, 32)
      : entry?.status === 'skip'
      ? _stem(proxyKey).substring(0, 32)
      : 'AX';

    // Prefer visual correction over TC offset
    const corr = eventCorrections?.[ev.id];
    let srcInF, srcOutF;
    if (corr) {
      srcInF  = _tcToFrames(corr.srcIn,  fps);
      srcOutF = _tcToFrames(corr.srcOut, fps);
    } else {
      const offset = (entry?.status === 'matched' && tcOffsets?.[proxyKey]) || 0;
      srcInF  = _tcToFrames(ev.srcIn,  fps) + offset;
      srcOutF = _tcToFrames(ev.srcOut, fps) + offset;
    }

    const srcIn  = _framesToTC(Math.max(0, srcInF), fps);
    const srcOut = _framesToTC(Math.max(0, srcOutF), fps);
    const recIn  = ev.recIn  || '01:00:00:00';
    const recOut = ev.recOut || '01:00:00:00';

    const evStr = String(evNum).padStart(3, '0');
    lines.push(`${evStr}  ${reel.padEnd(8)}  V     C        ${srcIn} ${srcOut} ${recIn} ${recOut} `);
    if (ev.clipName) lines.push(`* FROM CLIP NAME: ${ev.clipName}`);
    lines.push('');
    evNum++;
  }

  return lines.join('\n');
}

// ── Visual Frame Matching ─────────────────────────────────────────────────
// Perceptual mean hash: 32×18 grayscale thumbnail → 576 bits.
// Robust to subtitle overlays, mild colour grading, and scaling differences.

const _HASH_W    = 32;
const _HASH_H    = 18;
const _HASH_BITS = _HASH_W * _HASH_H; // 576

// Draw current video frame into ctx at _HASH_W×_HASH_H — shared prep for
// _computeFrameLuma/_computeEdgeHash, which both read the same pixel data.
function _drawHashFrame(video, ctx) {
  ctx.drawImage(video, 0, 0, _HASH_W, _HASH_H);
}

// Average luma (0–100) of the current _HASH_W×_HASH_H canvas draw.
// Call after _drawHashFrame (reuses the same pixel read).
function _computeFrameLuma(ctx) {
  const data = ctx.getImageData(0, 0, _HASH_W, _HASH_H).data;
  let sum = 0;
  for (let i = 0; i < _HASH_BITS; i++) {
    const p = i * 4;
    sum += 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }
  return (sum / (_HASH_BITS * 255)) * 100;
}

// ── Edge hash (Sobel) ────────────────────────────────────────────────────
// Sobel gradient magnitude on the 32×18 grayscale canvas → 576-bit edge map.
// Threshold at mean magnitude so sparse and dense edge images both produce stable hashes.
// Reuses the same ctx already drawn for mean hash — no extra seek or canvas.
function _computeEdgeHash(ctx) {
  const data = ctx.getImageData(0, 0, _HASH_W, _HASH_H).data;
  const gray = new Float32Array(_HASH_BITS);
  for (let i = 0; i < _HASH_BITS; i++) {
    const p = i * 4;
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  const mag = new Float32Array(_HASH_BITS);
  let sumMag = 0, edgeCount = 0;
  for (let y = 1; y < _HASH_H - 1; y++) {
    for (let x = 1; x < _HASH_W - 1; x++) {
      const tl = gray[(y - 1) * _HASH_W + (x - 1)], tc = gray[(y - 1) * _HASH_W + x], tr = gray[(y - 1) * _HASH_W + (x + 1)];
      const ml = gray[y       * _HASH_W + (x - 1)],                                    mr = gray[y       * _HASH_W + (x + 1)];
      const bl = gray[(y + 1) * _HASH_W + (x - 1)], bc = gray[(y + 1) * _HASH_W + x], br = gray[(y + 1) * _HASH_W + (x + 1)];
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const m  = Math.sqrt(gx * gx + gy * gy);
      mag[y * _HASH_W + x] = m;
      sumMag += m;
      edgeCount++;
    }
  }

  const threshold = edgeCount > 0 ? sumMag / edgeCount : 1;
  const bits = new Uint8Array(_HASH_BITS);
  for (let i = 0; i < _HASH_BITS; i++) bits[i] = mag[i] >= threshold ? 1 : 0;
  return bits;
}

// Edge-hash similarity: fraction of matching edge-map bits → 0–100.
function _eHashSimilarity(a, b) {
  let matches = 0;
  for (let i = 0; i < _HASH_BITS; i++) if (a[i] === b[i]) matches++;
  return Math.round((matches / _HASH_BITS) * 100);
}

// ── dHash (difference hash) ───────────────────────────────────────────────
// 8×8 output = 64 bits. Canvas must be drawn at (_DHASH_W+1)×_DHASH_H = 9×8.
// Each bit: pixel[x,y].luma > pixel[x+1,y].luma → 1, else 0.
const _DHASH_W    = 8;
const _DHASH_H    = 8;
const _DHASH_BITS = _DHASH_W * _DHASH_H; // 64

function _computeDHash(dhCtx) {
  const W1   = _DHASH_W + 1;
  const data = dhCtx.getImageData(0, 0, W1, _DHASH_H).data;
  const bits = new Uint8Array(_DHASH_BITS);
  for (let y = 0; y < _DHASH_H; y++) {
    for (let x = 0; x < _DHASH_W; x++) {
      const p0 = (y * W1 + x)     * 4;
      const p1 = (y * W1 + x + 1) * 4;
      const l0 = 0.299 * data[p0] + 0.587 * data[p0 + 1] + 0.114 * data[p0 + 2];
      const l1 = 0.299 * data[p1] + 0.587 * data[p1 + 1] + 0.114 * data[p1 + 2];
      bits[y * _DHASH_W + x] = l0 > l1 ? 1 : 0;
    }
  }
  return bits;
}

function _grabDHash(video, dhCanvas, dhCtx) {
  dhCtx.drawImage(video, 0, 0, _DHASH_W + 1, _DHASH_H);
  return _computeDHash(dhCtx);
}

const _PIXEL_W = 64;
const _PIXEL_H = 36;
let _pixelCanvas = null;
let _pixelCtx = null;
function _capturePixelEvidence(source) {
  if (!_pixelCanvas) {
    _pixelCanvas = document.createElement('canvas');
    _pixelCanvas.width = _PIXEL_W;
    _pixelCanvas.height = _PIXEL_H;
    _pixelCtx = _pixelCanvas.getContext('2d', { willReadFrequently: true });
  }
  _pixelCtx.drawImage(source, 0, 0, _PIXEL_W, _PIXEL_H);
  return new Uint8ClampedArray(_pixelCtx.getImageData(0, 0, _PIXEL_W, _PIXEL_H).data);
}

// ── Similarity helpers ────────────────────────────────────────────────────

// dHash similarity: fraction of matching bits → 0–100.
function _dHashSimilarity(a, b) {
  let matches = 0;
  for (let i = 0; i < _DHASH_BITS; i++) if (a[i] === b[i]) matches++;
  return Math.round((matches / _DHASH_BITS) * 100);
}

// Duration regularity score 0–100. Penalises extreme speed ratios and dynamic speed.
function _durationSimilarity(metrics) {
  if (metrics.dynamicSpeed) return 60;
  const r = metrics.speedRatio;
  if (!Number.isFinite(r) || r <= 0) return 50;
  if (r > 4 || r < 0.25) return 40;
  return Math.max(0, Math.min(100, Math.round(100 - Math.abs(Math.log2(r)) * 20)));
}

// Weighted visual confidence. Continuous pixel correlation is deliberately the
// largest term: regional hashes are tolerant enough to confuse different shots
// with similar composition, while actual normalized pixels must still agree.
// The remaining 0.15 is the audio/envelope term, blended in at the call site
// once envelope correlation is available (finalConfidence = 0.85·visual + 0.15·audio).
function _weightedFrameSimilarity({ spatialSim, pixelSim, pHashSim, edgeSim, lumaSim, durationSim = 100 }) {
  const W_PIXEL    = 0.35;
  const W_LUMA     = 0.10;
  const W_SPATIAL  = 0.20;
  const W_EDGE     = 0.10;
  const W_PHASH    = 0.05;
  const W_DURATION = 0.05;
  const W_TOTAL    = W_PIXEL + W_LUMA + W_SPATIAL + W_EDGE + W_PHASH + W_DURATION;
  const raw = W_PIXEL    * (pixelSim ?? 0)
            + W_LUMA     * (lumaSim  ?? 50)
            + W_SPATIAL  * spatialSim
            + W_EDGE     * (edgeSim  ?? 50)
            + W_PHASH    * pHashSim
            + W_DURATION * durationSim;
  return Math.max(0, Math.min(100, Math.round(raw / W_TOTAL)));
}

// ── Worker client ─────────────────────────────────────────────────────────
// Lazily spawns fp_worker.js and routes compute requests to it.
// Each call returns Promise<{mHash,eHash,luma}|null>; null = worker unavailable.
// Falls back silently — callers check for null and use sync path instead.
const _FpWorkerClient = (() => {
  let _worker = null;
  let _ready  = false;
  let _failed = false;
  let _nextId = 0;
  const _pending = new Map(); // id → { resolve, reject }

  function _init() {
    if (_ready || _failed) return;
    try {
      _worker = new Worker(new URL('./fp_worker.js', import.meta.url));
      _worker.onmessage = (e) => {
        const { id, mHash, eHash, luma, error } = e.data;
        const p = _pending.get(id);
        if (!p) return;
        _pending.delete(id);
        if (error) p.reject(new Error(error));
        else p.resolve({ mHash, eHash, luma });
      };
      _worker.onerror = () => {
        _failed = true;
        _pending.forEach(p => p.reject(new Error('fp_worker crashed')));
        _pending.clear();
      };
      _ready = true;
    } catch {
      _failed = true;
    }
  }

  return {
    compute(pixels) {
      _init();
      if (_failed || !_worker) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const id = _nextId++;
        _pending.set(id, { resolve, reject });
        // Transfer the buffer — zero-copy to worker.
        const buf = pixels.buffer.slice(pixels.byteOffset, pixels.byteOffset + pixels.byteLength);
        _worker.postMessage({ type: 'compute', id, pixels: new Uint8ClampedArray(buf) }, [buf]);
      }).catch(() => null);
    },
  };
})();

// Persistent AVFoundation sessions keyed by native path. Each _loadVideo call
// receives its OWN canvas facade while sharing the underlying AVAsset session.
// This prevents background matching seeks from overwriting the frame currently
// shown in Verify, without duplicating media or creating a proxy.
const _nativeMediaSessions = new Map();

async function _drawNativeDataUrl(canvas, dataUrl) {
  if (!dataUrl) throw new Error('AVFoundation returned no frame image');
  // Do not fetch(data:...). The desktop CSP intentionally blocks data: in
  // connect-src even though the bytes came from our own native engine. Decode
  // the base64 payload locally and hand the Blob straight to createImageBitmap.
  const match = String(dataUrl).match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) throw new Error('AVFoundation returned an invalid frame data URL');
  const mime = match[1] || 'image/jpeg';
  const raw = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
  const blob = new Blob([bytes], { type: mime });
  const bitmap = await createImageBitmap(blob);
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  } finally {
    bitmap.close?.();
  }
}

async function _loadNativeFrameSource(file, nativePath, { onProgress } = {}) {
  let sessionLoading = _nativeMediaSessions.get(nativePath);
  if (!sessionLoading) {
    sessionLoading = (async () => {
      onProgress?.(0);
      const session = await neOpen(nativePath, 30_000);
      if (!session?.sessionId || !session?.frameCount || !session?.fps) {
        throw new Error(`AVFoundation could not open ${file?.name || nativePath}`);
      }
      // Metadata-only companion open is retained solely for embedded start TC.
      // It does not upload, copy, transcode, or create a proxy.
      let startTimecode = '';
      try {
        const meta = await sharedMediaOpen(nativePath);
        startTimecode = String(meta?.data?.startTimecode || '');
      } catch {}
      return { session, startTimecode };
    })();
    _nativeMediaSessions.set(nativePath, sessionLoading);
  }

  let opened;
  try { opened = await sessionLoading; }
  catch (err) { _nativeMediaSessions.delete(nativePath); throw err; }
  const { session, startTimecode } = opened;
  const canvas = document.createElement('canvas');
  const outputWidth = Math.max(320, Math.min(960, Number(session.width) || 960));
  const aspect = (Number(session.width) || 16) / Math.max(1, Number(session.height) || 9);
  canvas.width = outputWidth;
  canvas.height = Math.max(1, Math.round(outputWidth / aspect));
  canvas._pfxNativeFrameSource = true;
  canvas._pfxNativeSessionId = session.sessionId;
  canvas._pfxDecoderKey = 'avfoundation-prores-v1';
  canvas._pfxFps = Number(session.fps) || 24;
  canvas._pfxFrameCount = Number(session.frameCount) || 1;
  canvas._pfxDuration = Number(session.duration) || (canvas._pfxFrameCount / canvas._pfxFps);
  canvas._pfxCurrentTime = 0;
  canvas._pfxCurrentFrame = -1;
  Object.defineProperties(canvas, {
    duration:    { get: () => canvas._pfxDuration },
    currentTime: { get: () => canvas._pfxCurrentTime, set: v => { canvas._pfxCurrentTime = Number(v) || 0; } },
    videoWidth:  { get: () => Number(session.width) || canvas.width },
    videoHeight: { get: () => Number(session.height) || canvas.height },
    readyState:  { get: () => 4 },
    paused:      { get: () => true },
    ended:       { get: () => false },
  });
  canvas._pfxSeekTime = async (seconds) => {
    const t = Math.max(0, Math.min(Number(seconds) || 0, Math.max(0, canvas._pfxDuration - 0.001)));
    const frame = Math.max(0, Math.min(Math.round(t * canvas._pfxFps), canvas._pfxFrameCount - 1));
    if (frame !== canvas._pfxCurrentFrame) {
      const extracted = await neFrameExtract(session.sessionId, frame, outputWidth, 0.96);
      await _drawNativeDataUrl(canvas, extracted?.imageDataUrl || extracted?.dataUrl);
      canvas._pfxCurrentFrame = frame;
    }
    canvas._pfxCurrentTime = frame / canvas._pfxFps;
    canvas.dispatchEvent(new Event('seeked'));
    canvas.dispatchEvent(new Event('timeupdate'));
  };
  await canvas._pfxSeekTime(0);
  onProgress?.(100);
  return {
    video: canvas,
    url: null,
    duration: canvas._pfxDuration,
    decodeStatus: 'native-avfoundation',
    startTimecode,
    nativeSessionId: session.sessionId,
    sessionId: null,
  };
}

// Load a local File into a drawable media source.
// Desktop ProRes uses an AVFoundation-backed canvas; browser-playable formats
// continue using a normal <video> element.
async function _loadVideo(file, { onProgress } = {}) {
  const isMov = /\.mov$/i.test(file?.name || '');

  // 1. Desktop native path: direct AVFoundation/VideoToolbox frame extraction.
  const _nativePath = file?._nativePath || null;
  if (_nativePath && isMov) {
    try {
      return await _loadNativeFrameSource(file, _nativePath, { onProgress });
    } catch (nativeErr) {
      // A desktop ProRes selection must never silently create a proxy or upload
      // hundreds of GB. Surface the native error so the operator can fix it.
      throw new Error(`Cannot decode ${file?.name} directly with AVFoundation (${nativeErr.message})`);
    }
  }

  // 2. Cross-tab proxy cache — reuse if another tab already transcoded this file
  if (isMov) {
    try {
      const cached = await tryRestoreProxyForMeta(file);
      if (cached?.url) {
        const playableUrl = await _withCompanionToken(cached.url);
        return { ...(await _loadVideoFromUrl(file, playableUrl)), decodeStatus: 'proxy-cache' };
      }
    } catch { /* fall through */ }
  }

  // 3. Blob URL (native for H.264/VP9; ProRes may load but render no frames)
  const blobUrl = URL.createObjectURL(file);
  let blobResult = null;
  try {
    blobResult = await _loadVideoFromUrl(file, blobUrl);
  } catch {
    URL.revokeObjectURL(blobUrl);
    blobResult = null;
  }

  // Blind-frame check: .mov loads successfully but videoWidth === 0 = ProRes codec fail
  const isBlind = blobResult && isMov && (blobResult.video.videoWidth || 0) === 0;
  if (blobResult && !isBlind) return { ...blobResult, decodeStatus: 'browser-direct' };

  // Non-.mov files: nothing more we can do
  if (!isMov) {
    if (blobResult) return blobResult;
    throw new Error(`Cannot load video: ${file.name}`);
  }

  // 4. Proxy transcode via companion — blob failed or was blind
  // Don't revoke blobUrl until proxy succeeds so we can fall back on 403/network error.
  // getProxyStreamUrl returns {url, sessionId, ...} — extract the url string.
  // A blind blobResult (videoWidth 0, i.e. ProRes decode) is never returned as a
  // fallback here — a 0×0 "video" can't be hashed/matched, so callers must see a
  // clear failure instead of a silently-unusable result (was the root cause of
  // AI Match completing at 100% with 0 events matched: regionalHash() threw on
  // the blind video and the per-event catch swallowed it).
  let streamUrl;
  let proxyResult;
  try {
    proxyResult = await getProxyStreamUrl(file, { onProgress: onProgress || (() => {}) });
    streamUrl = proxyResult?.url || null;
  } catch (proxyErr) {
    if (blobResult && !isBlind) return { ...blobResult, decodeStatus: 'browser-fallback' };
    throw isBlind
      ? new Error(`Cannot decode ${file?.name}: ProRes not supported by the browser and the companion proxy is unavailable (${proxyErr.message})`)
      : proxyErr;
  }
  if (!streamUrl) {
    if (blobResult && !isBlind) return { ...blobResult, decodeStatus: 'browser-fallback' };
    throw new Error(`Proxy returned no URL for ${file?.name}`);
  }
  if (blobResult) URL.revokeObjectURL(blobUrl);
  const playableUrl = await _withCompanionToken(streamUrl);
  const proxyLoaded = await _loadVideoFromUrl(file, playableUrl);
  if ((proxyLoaded.video.videoWidth || 0) === 0) {
    throw new Error(`Companion proxy for ${file?.name} produced no decodable video frames`);
  }
  return {
    ...proxyLoaded,
    decodeStatus: 'proxy-transcode',
    proxySessionId: proxyResult?.sessionId || '',
    proxyStreamUrl: streamUrl,
  };
}

// Loads url into a <video> element. Rejects after 20s if neither loadedmetadata
// nor error fires (e.g. a stalled companion stream) — without this timeout a
// hung request left the Verify panel stuck on "Loading…" forever.
function _loadVideoFromUrl(file, url, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted   = true;
    video.crossOrigin = 'anonymous';
    video.playsInline = true;

    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onErr);
    };
    const onMeta = () => {
      cleanup();
      resolve({ video, url, duration: video.duration });
    };
    const onErr = () => {
      cleanup();
      reject(new Error(`Cannot load video: ${file?.name || url}`));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out loading video: ${file?.name || url}`));
    }, timeoutMs);

    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onErr);
    video.src = url;
  });
}

// Seek video to timeSec. Resolves when seeked; rejects after 6 s timeout.
function _seekVideo(video, timeSec) {
  if (video?._pfxNativeFrameSource && typeof video._pfxSeekTime === 'function') {
    return video._pfxSeekTime(timeSec);
  }
  return new Promise((resolve, reject) => {
    // NaN duration (streaming proxy without Content-Length) must not clamp to 0.
    // When duration is unknown, skip the upper clamp — the browser will clamp internally.
    const durKnown = Number.isFinite(video.duration) && video.duration > 0;
    const t = durKnown
      ? Math.max(0, Math.min(timeSec, video.duration - 0.001))
      : Math.max(0, timeSec);
    if (Math.abs(video.currentTime - t) < 0.001) { resolve(); return; }

    let timer;
    const onSeeked = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    timer = setTimeout(() => {
      video.removeEventListener('seeked', onSeeked);
      reject(new Error(`Seek timeout at ${t.toFixed(2)}s`));
    }, 6000);

    video.addEventListener('seeked', onSeeked);
    video.currentTime = t;
  });
}

// Search masterVideo for the frame that best matches refHash.
//   approxSec  — XML srcIn as a hint (may be inaccurate).
//   Coarse pass: ±30 s, 2 s step (30 seeks).
//   Fine pass:   ±1.5 s, 1-frame step around coarse best.
// Returns { bestSec, confidence(0–100), distance }.
//
// `fpsExact` is the TRUE playback rate, not the timecode base. Every use of it
// in here is real media time — a one-frame seek step and a seconds→frame-index
// cache key — so there is no timecode arithmetic to want the nominal base.
// Callers that still pass the base get today's behaviour; on NTSC that makes
// FINE_STEP 0.1% short and the cache key drift by one frame per ~41 seconds.
async function _searchMasterForFrame(refHash, masterVideo, canvas, ctx, approxSec, fpsExact, opts = {}) {
  // NaN/0 duration (streaming proxy without Content-Length) → treat as unknown.
  // Do NOT clamp loop bounds to `duration - 0.1` in that case: it collapses to
  // -0.1, so no frame is ever tested and every match silently returns ~0
  // confidence. When unknown, run the hinted coarse+fine passes with an open
  // upper bound; the whole-clip wide pass still requires a known length.
  const durKnown    = Number.isFinite(masterVideo.duration) && masterVideo.duration > 0;
  const duration    = durKnown ? masterVideo.duration : 0;
  const COARSE_STEP = Number(opts.coarseStepSec || 2);
  const COARSE_WIN  = Number(opts.coarseWindowSec || 30);
  const FINE_STEP   = 1 / fpsExact;
  const FINE_WIN    = Number(opts.fineWindowSec || 1.5);
  const WIDE_STEP   = Number(opts.wideStepSec || Math.max(0.75, Math.min(3, duration / 160 || 2)));
  const wideSearch  = !!opts.wideSearch;
  const minLocal    = Number(opts.minLocalConfidence ?? 68);
  const fileKey     = opts.fileKey || '';
  const refPixelData = opts.refPixelData || null;
  const shouldCancel = typeof opts.shouldCancel === 'function' ? opts.shouldCancel : () => false;

  let bestSec  = Math.max(0, Math.min(approxSec || 0, Math.max(0, duration - 0.001)));
  let bestDist = _REGIONAL_MAX_DIST + 1;
  let bestPixelSimilarity = null;
  const coarseCandidates = [];
  const pixelByFrame = new Map();

  // dHash is an inexpensive shortlist, not the final identity decision. Keep a
  // bounded set of the strongest regional candidates, then re-rank those using
  // continuous luma pixels. This prevents a different shot with a similar edge
  // layout from winning merely because its tolerant regional hash is close.
  const rememberCandidate = (list, candidate, keep = 12) => {
    const existing = list.findIndex(c => c.frameIdx === candidate.frameIdx);
    if (existing >= 0) {
      if (candidate.d < list[existing].d) list[existing] = candidate;
    } else {
      list.push(candidate);
    }
    list.sort((a, b) => a.d - b.d);
    if (list.length > keep) list.length = keep;
  };

  const testAt = async (t, collector = coarseCandidates) => {
    if (shouldCancel()) throw new Error('Conform stopped');
    try {
      const tt       = durKnown ? Math.max(0, Math.min(t, duration - 0.001)) : Math.max(0, t);
      const frameIdx = Math.round(tt * fpsExact);
      const decoderKey = masterVideo?._pfxDecoderKey || 'browser-v1';
      const fpKey    = fileKey ? `rh|${decoderKey}|${fileKey}|${frameIdx}` : '';

      let hash;
      if (fpKey) {
        const cached = await _fpCacheGet(fpKey);
        if (cached) hash = new Uint8Array(cached);
      }
      if (!hash) {
        await _seekVideo(masterVideo, tt);
        hash = regionalHash(masterVideo);
        if (fpKey) _fpCachePut(fpKey, Array.from(hash));
      }

      const d = regionalDistance(refHash, hash);
      rememberCandidate(collector, { t: tt, d, frameIdx });
      if (d < bestDist) { bestDist = d; bestSec = tt; }
      return d;
    } catch { return null; }
  };

  const rerankCandidates = async (candidates) => {
    if (!refPixelData || !candidates.length) return null;
    let winner = null;
    for (const candidate of candidates) {
      if (shouldCancel()) throw new Error('Conform stopped');
      try {
        let pixelSimilarity = pixelByFrame.get(candidate.frameIdx);
        if (!Number.isFinite(pixelSimilarity)) {
          await _seekVideo(masterVideo, candidate.t);
          const masterPixels = _capturePixelEvidence(masterVideo);
          pixelSimilarity = robustPixelSimilarity(refPixelData, masterPixels, _PIXEL_W, _PIXEL_H);
          pixelByFrame.set(candidate.frameIdx, pixelSimilarity);
        }
        const regionalConfidence = distanceToConfidence(candidate.d);
        const combinedScore = 0.70 * pixelSimilarity + 0.30 * regionalConfidence;
        if (!winner || combinedScore > winner.combinedScore) {
          winner = { ...candidate, pixelSimilarity, combinedScore };
        }
      } catch { /* ignore an individual undecodable candidate */ }
    }
    return winner;
  };

  // ─ Local coarse pass around XML/source hint ────────────────────────────
  const cStart = Math.max(0, (approxSec || 0) - COARSE_WIN);
  const cEnd   = durKnown
    ? Math.min(duration - 0.1, (approxSec || 0) + COARSE_WIN)
    : (approxSec || 0) + COARSE_WIN;

  for (let t = cStart; t <= cEnd + 0.001; t += COARSE_STEP) {
    if (shouldCancel()) throw new Error('Conform stopped');
    const d = await testAt(t);
    if (d === 0 && !refPixelData) break;
  }

  let localConfidence = distanceToConfidence(bestDist);
  const localWinner = await rerankCandidates(coarseCandidates);
  const localPixelsWeak = refPixelData && (!localWinner || localWinner.pixelSimilarity < 88);

  // ─ Wide/global coarse pass when timecode is unreliable ────────────────
  // This is essential for trailer/editorial conforms where XML source TC may
  // not line up with the ProRes source media. We still use the source hint first
  // for speed, but fall back to a whole-clip visual-wave scan when needed.
  // Requires a known duration to bound the scan (an unknown-length streaming
  // proxy can't be swept end-to-end).
  if (wideSearch && durKnown && (localConfidence < minLocal || localPixelsWeak)) {
    for (let t = 0; t <= duration - 0.1; t += WIDE_STEP) {
      if (shouldCancel()) throw new Error('Conform stopped');
      const d = await testAt(t);
      if (d === 0 && !refPixelData) break;
    }
  }

  // Pick the actual-pixel winner before the fine pass. Regional hashes alone
  // can collide across shots, particularly in dark, centred trailer imagery.
  const coarseWinner = await rerankCandidates(coarseCandidates);
  if (coarseWinner) {
    bestSec = coarseWinner.t;
    bestDist = coarseWinner.d;
    bestPixelSimilarity = coarseWinner.pixelSimilarity;
  }

  // ─ Fine pass around the best coarse hit ───────────────────────────────
  const fStart = Math.max(0, bestSec - FINE_WIN);
  const fEnd   = durKnown ? Math.min(duration - 0.1, bestSec + FINE_WIN) : bestSec + FINE_WIN;
  const fineCandidates = [];

  for (let t = fStart; t <= fEnd + FINE_STEP * 0.1; t += FINE_STEP) {
    if (shouldCancel()) throw new Error('Conform stopped');
    const d = await testAt(t, fineCandidates);
    if (d === 0 && !refPixelData) break;
  }

  const fineWinner = await rerankCandidates(fineCandidates);
  if (coarseWinner || fineWinner) {
    const finalWinner = !coarseWinner
      ? fineWinner
      : !fineWinner
        ? coarseWinner
        : fineWinner.combinedScore > coarseWinner.combinedScore ? fineWinner : coarseWinner;
    bestSec = finalWinner.t;
    bestDist = finalWinner.d;
    bestPixelSimilarity = finalWinner.pixelSimilarity;
  }

  return {
    bestSec,
    distance:   bestDist,
    confidence: distanceToConfidence(bestDist),
    pixelSimilarity: bestPixelSimilarity,
  };
}

// ── CV shot detection (V1.4 detect_shots port — no-EDL fallback) ───────────
// Decodes the offline frame-by-frame, builds a per-frame HSV (H×S) histogram at
// 160×90, correlates consecutive frames, and delegates threshold + segmentation
// to modules/conform/shotDetect.js. Only for when no agency EDL/XML exists;
// when an EDL is present its record-TC cuts stay authoritative.
const _SD_W = 160, _SD_H = 90, _SD_HBINS = 16, _SD_SBINS = 16;
let _sdCanvas = null, _sdCtx = null;
function _sdScratch() {
  if (!_sdCanvas) {
    _sdCanvas = document.createElement('canvas');
    _sdCanvas.width = _SD_W; _sdCanvas.height = _SD_H;
    _sdCtx = _sdCanvas.getContext('2d', { willReadFrequently: true });
  }
  return _sdCtx;
}
// Normalized H×S histogram (256 bins) from the current scratch frame. Mirrors
// cv2.calcHist([hsv],[0,1],…,[16,16],[0,180,0,256]) + cv2.normalize (L2).
function _hsHistogram(ctx) {
  const data = ctx.getImageData(0, 0, _SD_W, _SD_H).data;
  const hist = new Float32Array(_SD_HBINS * _SD_SBINS);
  for (let p = 0; p < data.length; p += 4) {
    const r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    const hueCv = h / 2;                                   // OpenCV hue is 0-180
    const hb = Math.min(_SD_HBINS - 1, Math.floor(hueCv / (180 / _SD_HBINS)));
    const sb = Math.min(_SD_SBINS - 1, Math.floor((s * 255) / (256 / _SD_SBINS)));
    hist[hb * _SD_SBINS + sb] += 1;
  }
  let norm = 0;
  for (let i = 0; i < hist.length; i++) norm += hist[i] * hist[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < hist.length; i++) hist[i] /= norm;
  return hist;
}

// Returns { shots:[{startFrame,endFrame}], threshold, warnings } for the offline.
async function _detectShotsFromVideo(video, fps, opts = {}) {
  const minShotFrames = opts.minShotFrames ?? 12;
  const ctx = _sdScratch();
  const dur = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  if (!dur) throw new Error('Offline duration unknown — cannot detect shots');
  const total = Math.max(1, Math.round(dur * fps));

  const correlations = [];
  let prev = null;
  let decoded = 0;   // frames actually decoded (may be < total if the loop stops early)
  // Frames must stay consecutive so correlations[i] ↔ frame i+1 (segmentShots
  // relies on that), so a decode failure stops the sweep rather than skipping.
  for (let f = 0; f < total; f++) {
    if (opts.shouldCancel && opts.shouldCancel()) break;
    const t = f / fps;
    if (t >= dur - 0.001) break;
    await _seekVideo(video, t);
    if ((video.videoWidth || 0) === 0) break;
    ctx.drawImage(video, 0, 0, _SD_W, _SD_H);
    const hist = _hsHistogram(ctx);
    if (prev) correlations.push(histCorrelation(prev, hist));
    prev = hist;
    decoded++;
    if (opts.onProgress && (f % 20 === 0)) opts.onProgress(Math.round((f / total) * 100));
  }

  // Bound the last shot to frames actually inspected (not the fps estimate), so
  // it never claims un-decoded frames past a cancel / early stop.
  const effectiveTotal = Math.max(1, decoded);
  return segmentShots(correlations, effectiveTotal, { threshold: opts.threshold ?? null, minShotFrames });
}


// ── Event duration / speed helpers for trailer conform ─────────────────────
// XML/FCPXML/EDL source timecode is a hint, but its duration and retime metadata
// are still valuable. These helpers preserve source span/speed while the match
// solver replaces the absolute source in/out with visually matched positions.

function _numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function _eventFrameMetrics(ev, fps = DEFAULT_FPS) {
  const recInF  = ev._recInFrames  ?? _tcToFrames(ev.recIn,  fps);
  const recOutF = ev._recOutFrames ?? _tcToFrames(ev.recOut, fps);
  const srcInF  = ev._srcInFrames  ?? _tcToFrames(ev.srcIn,  fps);
  const srcOutF = ev._srcOutFrames ?? _tcToFrames(ev.srcOut, fps);
  const recDurF = Math.max(1, Math.abs(recOutF - recInF));
  let srcSpanF  = Math.abs(srcOutF - srcInF);

  const speedMap = (Array.isArray(ev.speedKeys) ? ev.speedKeys : [])
    .map(k => ({ when: Number(k?.when), value: Number(k?.value) }))
    .filter(k => Number.isFinite(k.when) && Number.isFinite(k.value))
    .sort((a, b) => a.when - b.when);
  const mapAt = (when) => {
    if (!speedMap.length) return null;
    if (when <= speedMap[0].when) return speedMap[0].value + (when - speedMap[0].when);
    for (let i = 1; i < speedMap.length; i++) {
      const a = speedMap[i - 1];
      const b = speedMap[i];
      if (when <= b.when) {
        const span = b.when - a.when;
        const t = span ? (when - a.when) / span : 0;
        return a.value + (b.value - a.value) * t;
      }
    }
    const a = speedMap[speedMap.length - 2] || speedMap[0];
    const b = speedMap[speedMap.length - 1];
    const slope = b.when !== a.when ? (b.value - a.value) / (b.when - a.when) : 1;
    return b.value + ((when - b.when) * slope);
  };
  const speedMapBaseWhen = speedMap.length && srcInF >= speedMap[0].when && srcInF <= speedMap[speedMap.length - 1].when
    ? srcInF
    : (speedMap[0]?.when ?? srcInF);
  const speedMapBaseValue = mapAt(speedMapBaseWhen);
  const speedMapEndValue = mapAt(speedMapBaseWhen + recDurF);
  const mappedSpan = Number.isFinite(speedMapBaseValue) && Number.isFinite(speedMapEndValue)
    ? speedMapEndValue - speedMapBaseValue
    : null;
  if (mappedSpan != null && Math.abs(mappedSpan) >= 1) srcSpanF = Math.abs(mappedSpan);

  let speedPct = _numOrNull(ev.speedFactor ?? ev.speed ?? ev._pmSpeed ?? ev._speedPercent);
  // Parsers store speedFactor as percent (100 = normal, 200 = 2x). If absent,
  // infer speed from XML source span vs record duration.
  let speedRatio = speedMap.length > 1 && mappedSpan != null
    ? Math.abs(mappedSpan) / recDurF
    : (speedPct != null ? Math.abs(speedPct) / 100 : (srcSpanF > 0 ? srcSpanF / recDurF : 1));
  if (!Number.isFinite(speedRatio) || speedRatio <= 0) speedRatio = 1;
  // Keep crazy parser outliers from exploding search offsets.
  speedRatio = Math.max(0.01, Math.min(32, speedRatio));

  const reversed = !!ev.speedReversed || (mappedSpan != null && mappedSpan < 0) || (speedPct != null && speedPct < 0) || (srcOutF < srcInF);
  const direction = reversed ? -1 : 1;
  if (!srcSpanF || srcSpanF < 1) srcSpanF = Math.max(1, Math.round(recDurF * speedRatio));

  return {
    recInF, recOutF, recDurF,
    srcInF, srcOutF, srcSpanF,
    speedPct: speedMap.length > 1 ? Math.round(speedRatio * 10000) / 100 : (speedPct != null ? speedPct : Math.round(speedRatio * 10000) / 100),
    speedRatio,
    reversed,
    direction,
    dynamicSpeed: speedMap.length > 1,
    speedMap,
    speedMapBaseWhen,
    speedMapBaseValue,
    mappedSpan,
  };
}

function _sampleOffsetsForEvent(ev, fps = DEFAULT_FPS) {
  const m = _eventFrameMetrics(ev, fps);
  const dur = m.recDurF;
  if (dur <= 1) return [0];
  const skip = Math.min(
    Math.max(2, Math.round(fps * 0.18)),
    Math.max(0, Math.floor(dur * 0.22))
  );
  const candidates = [
    skip,
    Math.round(dur * 0.50),
    Math.max(0, dur - 1 - skip),
  ];
  if (dur >= fps * 3) {
    candidates.push(Math.round(dur * 0.25), Math.round(dur * 0.75));
  }
  const seen = new Set();
  return candidates
    .map(v => Math.max(0, Math.min(dur - 1, Math.round(v))))
    .filter(v => { const k = String(v); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => a - b);
}

function _expectedSourceFrameAtOffset(metrics, timelineOffsetF) {
  if (metrics.dynamicSpeed && metrics.speedMap?.length) {
    const keys = metrics.speedMap;
    const when = metrics.speedMapBaseWhen + timelineOffsetF;
    let mapped = keys[0].value;
    if (when <= keys[0].when) mapped = keys[0].value + (when - keys[0].when);
    else {
      for (let i = 1; i < keys.length; i++) {
        const a = keys[i - 1], b = keys[i];
        if (when <= b.when) {
          const t = b.when === a.when ? 0 : (when - a.when) / (b.when - a.when);
          mapped = a.value + (b.value - a.value) * t;
          break;
        }
        if (i === keys.length - 1) {
          const slope = b.when === a.when ? 1 : (b.value - a.value) / (b.when - a.when);
          mapped = b.value + ((when - b.when) * slope);
        }
      }
    }
    return metrics.srcInF + (mapped - metrics.speedMapBaseValue);
  }
  return metrics.srcInF + metrics.direction * (timelineOffsetF * metrics.speedRatio);
}

function _deriveSourceInFromMatched(metrics, timelineOffsetF, matchedSourceFrameF) {
  return matchedSourceFrameF - (_expectedSourceFrameAtOffset(metrics, timelineOffsetF) - metrics.srcInF);
}

function _median(values) {
  const arr = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

// Throws a clear, actionable error instead of letting regionalHash()'s
// ctx.drawImage() throw an opaque IndexSizeError on a blind (undecoded) video.
function _assertDecodable(video, label) {
  if ((video.videoWidth || 0) === 0 || (video.videoHeight || 0) === 0) {
    throw new Error(`${label} produced no decodable frame (0×0) — codec likely unsupported`);
  }
}

// Independently refine the source OUT point by visually matching the offline
// shot's LAST frame in the master — instead of assuming srcOut = srcIn + span.
// Ported from V1.4 conform_lib.refine_boundaries() (independent end-frame match
// in a tight window). Returns { srcOutF, endConfidence, refinedSpanF } or null
// to fall back to the span-derived out.
//
// Guarded to normal-speed forward static shots only: retimed / reversed /
// dynamic-speed shots must preserve their exact source span (the record
// duration × speed defines the out), so we never independently move their out.
// On any weak/implausible end match we return null → span-derived out (i.e. the
// prior behavior), so this can only improve accuracy, never regress it.
async function _refineSourceOut({ metrics, refVideo, masterVideo, canvas, ctx, fps, seqBaseFrames, correctedSrcInF, masterFileKey = '' }) {
  if (!isRefinableSpeed(metrics)) return null;

  const spanF = metrics.srcSpanF;
  if (!(spanF > 1)) return null;

  // Offline shot's last frame, in the reference (offline) timeline.
  const refEndFrameF = metrics.recOutF - seqBaseFrames - 1;
  const refEndSec = refEndFrameF / fps;
  const refDur = Number.isFinite(refVideo.duration) && refVideo.duration > 0 ? refVideo.duration : 1e9;
  if (refEndSec < 0 || refEndSec >= refDur - 0.001) return null;

  await _seekVideo(refVideo, refEndSec);
  _assertDecodable(refVideo, 'Reference video');
  const refEndHash = regionalHash(refVideo);

  // Expected end in the master (file-time seconds) — srcIn is already median-
  // refined, so the true out sits very near correctedSrcInF + span.
  const masterDur = Number.isFinite(masterVideo.duration) && masterVideo.duration > 0 ? masterVideo.duration : 0;
  const expectedEndF = correctedSrcInF + spanF - 1;
  const expectedEndSec = Math.max(0, Math.min(expectedEndF / fps, Math.max(0, masterDur - 0.001)));

  // Tight, frame-accurate search around the expected end (≈ V1.4's ±32-frame
  // window). No wide/global pass — we trust the refined srcIn + span position.
  const endResult = await _searchMasterForFrame(refEndHash, masterVideo, canvas, ctx, expectedEndSec, fps, {
    coarseWindowSec: 0.9,
    coarseStepSec: 0.3,
    fineWindowSec: 1.2,
    wideSearch: false,
    fileKey: masterFileKey,
  });

  const matchedEndF = Math.round((endResult.bestSec || 0) * fps);
  const accepted = acceptRefinedEnd({
    correctedSrcInF, matchedEndF, endConfidence: endResult.confidence ?? 0, srcSpanF: spanF,
  });
  if (!accepted) return null;   // weak / implausible end match → keep span-derived out

  return { srcOutF: accepted.srcOutF, endConfidence: endResult.confidence, refinedSpanF: accepted.refinedSpanF };
}

// Validate the event's actual IN frame, not only its safer interior samples.
// Interior samples deliberately skip a few frames to avoid edit flashes, but
// blindly subtracting that offset can land before a master shot boundary. That
// produced a numerically excellent sample match while Verify showed two visibly
// different first frames. Search a tight ±12-frame window around the derived IN
// and either move to the real matching boundary or let the low boundary score
// demote the row out of SAFE.
async function _refineSourceInBoundary({ metrics, ev, refVideo, masterVideo, fpsExact, seqBaseFrames, candidateSrcInF, shouldCancel = () => false }) {
  // A resize/reframe intentionally changes the rendered pixels. Regional hashes
  // and multi-sample consistency remain useful, but a raw full-frame pixel gate
  // would reject the correct master merely because Motion/Crop is active.
  if (_transformDescriptor(ev).flagged) return null;
  const refStartF = metrics.recInF - seqBaseFrames;
  const refSec = refStartF / fpsExact;
  const refDur = Number.isFinite(refVideo.duration) && refVideo.duration > 0 ? refVideo.duration : 0;
  if (refSec < 0 || (refDur && refSec >= refDur - 0.001)) return null;

  await _seekVideo(refVideo, refSec);
  const refPixels = _capturePixelEvidence(refVideo);
  const maxFrame = Number.isFinite(masterVideo.duration) && masterVideo.duration > 0
    ? Math.max(0, Math.round(masterVideo.duration * fpsExact) - 1)
    : Number.MAX_SAFE_INTEGER;
  const clampFrame = f => Math.max(0, Math.min(Math.round(f), maxFrame));
  const scoreFrame = async frame => {
    if (shouldCancel()) throw new Error('Conform stopped');
    const f = clampFrame(frame);
    await _seekVideo(masterVideo, f / fpsExact);
    return {
      frame: f,
      pixelSimilarity: robustPixelSimilarity(refPixels, _capturePixelEvidence(masterVideo), _PIXEL_W, _PIXEL_H),
    };
  };

  const original = await scoreFrame(candidateSrcInF);
  let best = original;
  if (original.pixelSimilarity < 88) {
    for (let delta = 1; delta <= 12; delta++) {
      for (const sign of [-1, 1]) {
        const tested = await scoreFrame(candidateSrcInF + sign * delta);
        if (tested.pixelSimilarity > best.pixelSimilarity) best = tested;
        if (best.pixelSimilarity >= 98) break;
      }
      if (best.pixelSimilarity >= 98) break;
    }
  }

  // Require a meaningful improvement before moving the boundary. Even when no
  // acceptable boundary exists, return its low score so SAFE is impossible.
  const chosen = best.pixelSimilarity >= original.pixelSimilarity + 3 ? best : original;
  return {
    srcInF: chosen.frame,
    pixelSimilarity: chosen.pixelSimilarity,
    refined: chosen.frame !== original.frame,
    deltaFrames: chosen.frame - original.frame,
  };
}

// Speed-ramp / retime descriptor from event metrics. Reversed and variable-speed
// (keyframed) shots are flagged as ramps; static off-speed shots report slow/fast %.
// Purely informational — surfaced in the results table so an editor knows a shot's
// source OUT was preserved from its span (not independently refined) on retimes.
function _retimeDescriptor(metrics) {
  const r = metrics.speedRatio;
  if (metrics.reversed)     return { flagged: true, kind: 'reversed', label: 'Reversed' };
  if (metrics.dynamicSpeed) return { flagged: true, kind: 'ramp',     label: 'Speed ramp' };
  if (r < 0.92 || r > 1.08) {
    const pct = Math.round(r * 100);
    return { flagged: true, kind: r < 1 ? 'slow' : 'fast', label: `${r < 1 ? 'Slow' : 'Fast'} ${pct}%` };
  }
  return { flagged: false, kind: 'normal', label: '' };
}

function _transformDescriptor(ev) {
  const t = ev?.transform || {};
  const parts = [];
  const scale = Number(t.scale);
  const scaleX = Number(t.scaleX);
  const scaleY = Number(t.scaleY);
  const rotation = Number(t.rotation);
  const position = Array.isArray(t.position) ? t.position.map(Number) : null;
  const crop = t.crop || {};
  if (Number.isFinite(scale) && Math.abs(scale - 100) > 0.01 && Math.abs(scale - 1) > 0.01) parts.push(`Scale ${Math.round(scale * 100) / 100}%`);
  if (Number.isFinite(scaleX) && Math.abs(scaleX - 1) > 0.001) parts.push(`X ${Math.round(scaleX * 100)}%`);
  if (Number.isFinite(scaleY) && Math.abs(scaleY - 1) > 0.001) parts.push(`Y ${Math.round(scaleY * 100)}%`);
  if (position && position.some(v => Number.isFinite(v) && Math.abs(v) > 0.001)) parts.push(`Position ${position.join(', ')}`);
  if (Number.isFinite(rotation) && Math.abs(rotation) > 0.001) parts.push(`Rotate ${Math.round(rotation * 100) / 100}°`);
  const cropParts = ['left', 'right', 'top', 'bottom'].filter(k => Math.abs(Number(crop[k]) || 0) > 0.001);
  if (cropParts.length) parts.push(`Crop ${cropParts.map(k => `${k[0].toUpperCase()}${crop[k]}`).join(' ')}`);
  if (t.animated) parts.push('Keyframed');
  return { flagged: parts.length > 0, label: parts.join(' · ') || 'No resize' };
}

// `fps` is the timecode base (frame metrics, sample offsets); `fpsExact` is the
// true playback rate (every seek and every seconds→frames result below). It
// defaults to `fps` so a caller that has not been threaded through yet keeps
// exactly today's behaviour rather than silently changing rate underneath.
async function _matchEventByVisualWave({ ev, refVideo, masterVideo, canvas, ctx, dhCanvas, dhCtx, fps, fpsExact = fps, seqBaseFrames, useAI = false, masterFileKey = '', tcOffset = 0, searchProfile = 'full', shouldCancel = () => false }) {
  const metrics = _eventFrameMetrics(ev, fps);
  const allSampleOffsets = _sampleOffsetsForEvent(ev, fps);
  // The cross-master pass is an identity check, not the final boundary solve.
  // One representative frame plus a coarser global stride keeps the search
  // bounded; a winning master is still adopted only when it clears the margin.
  const sampleOffsets = searchProfile === 'library'
    ? [allSampleOffsets[Math.floor(allSampleOffsets.length / 2)] ?? 0]
    : allSampleOffsets;
  const sampleMatches = [];
  // Use Infinity as fallback so NaN/0 duration (streaming proxies without Content-Length)
  // does not filter out every sample offset — seeks will clamp naturally inside _seekVideo.
  const refDur    = Number.isFinite(refVideo.duration)    && refVideo.duration    > 0 ? refVideo.duration    : 1e9;
  const masterDur = Number.isFinite(masterVideo.duration) && masterVideo.duration > 0 ? masterVideo.duration : 1e9;

  for (const eventOffsetF of sampleOffsets) {
    if (shouldCancel()) throw new Error('Conform stopped');
    const refFrameF = metrics.recInF - seqBaseFrames + eventOffsetF;
    // Real media time: the reference is seeked straight here and hashed, with
    // no search window to absorb an error. On NTSC the base would land 3.6 s
    // late at the hour mark — a different shot, matched with full confidence.
    const refSec = refFrameF / fpsExact;
    if (refSec < 0 || refSec >= refDur - 0.001) continue;

    await _seekVideo(refVideo, refSec);
    const approxSrcFrameF = _expectedSourceFrameAtOffset(metrics, eventOffsetF);
    // Subtract the master's embedded start TC so tape-TC srcIn values (e.g. 08:37:xx:xx)
    // translate to file-time seconds rather than clamping to the end of the file.
    const approxSec = Math.max(0, Math.min((approxSrcFrameF - tcOffset) / fpsExact, Math.max(0, masterDur - 0.001)));

    let result;
    // Use hash search for the first production implementation. It now supports
    // wide/global search, which is more important than deep embeddings when TC is wrong.
    if (useAI) {
      const refEmb = await extractEmbedding(refVideo, canvas);
      result = await searchMasterAI(refEmb, masterVideo, canvas, fpsExact, approxSec);
      // AI helper currently searches locally. If confidence is weak, fall back to
      // whole-clip hash search for trailer conforms with unreliable source TC.
      if ((result?.confidence ?? 0) < 68 && ctx) {
        await _seekVideo(refVideo, refSec);
        _assertDecodable(refVideo, 'Reference video');
        const refHash = regionalHash(refVideo);
        result = await _searchMasterForFrame(refHash, masterVideo, canvas, ctx, approxSec, fpsExact, {
          wideSearch: true,
          minLocalConfidence: 68,
          wideStepSec: searchProfile === 'library' ? 12 : 2,
          coarseWindowSec: searchProfile === 'library' ? 12 : 30,
          coarseStepSec: searchProfile === 'library' ? 3 : 2,
          fineWindowSec: searchProfile === 'library' ? 0.5 : 1.5,
          fileKey: masterFileKey,
          refPixelData: _capturePixelEvidence(refVideo),
          shouldCancel,
        });
      }
    } else {
      _assertDecodable(refVideo, 'Reference video');
      const refRegionalHash = regionalHash(refVideo);
      // Sync ref hashes — always available as fallback even if worker is unavailable.
      _drawHashFrame(refVideo, ctx);
      const refLumaSync  = _computeFrameLuma(ctx);
      const refEHashSync = _computeEdgeHash(ctx);
      const refDHash     = dhCtx ? _grabDHash(refVideo, dhCanvas, dhCtx) : null;
      const refPixelData = _capturePixelEvidence(refVideo);
      // Fire worker with ref pixels — runs during the search loop below (free overlap).
      const refWorkerP   = _FpWorkerClient.compute(ctx.getImageData(0, 0, _HASH_W, _HASH_H).data);

      result = await _searchMasterForFrame(refRegionalHash, masterVideo, canvas, ctx, approxSec, fps, {
        wideSearch: true,
        minLocalConfidence: 68,
        wideStepSec: searchProfile === 'library' ? 12 : 2,
        coarseWindowSec: searchProfile === 'library' ? 12 : 30,
        coarseStepSec: searchProfile === 'library' ? 3 : 2,
        fineWindowSec: searchProfile === 'library' ? 0.5 : 1.5,
        fileKey: masterFileKey,
        refPixelData,
        shouldCancel,
      });

      // Upgrade raw regional-hash confidence to the full weighted formula.
      if (dhCtx) {
        try {
          await _seekVideo(masterVideo, result.bestSec);
          _assertDecodable(masterVideo, 'Source video');
          const masterRegionalHash = regionalHash(masterVideo);
          // Sync master hashes — ctx holds the master frame at this point.
          _drawHashFrame(masterVideo, ctx);
          const masterLumaSync  = _computeFrameLuma(ctx);
          const masterEHashSync = _computeEdgeHash(ctx);
          // Fire worker with master pixels; await both worker results together.
          const masterWorkerP   = _FpWorkerClient.compute(ctx.getImageData(0, 0, _HASH_W, _HASH_H).data);
          const masterDHash     = _grabDHash(masterVideo, dhCanvas, dhCtx);
          const masterPixelData = _capturePixelEvidence(masterVideo);
          const pixelSimilarity = robustPixelSimilarity(refPixelData, masterPixelData, _PIXEL_W, _PIXEL_H);

          const [refW, masterW] = await Promise.all([refWorkerP, masterWorkerP]);

          result = {
            ...result,
            pixelSimilarity,
            confidence: _weightedFrameSimilarity({
              spatialSim:  distanceToConfidence(regionalDistance(refRegionalHash, masterRegionalHash)),
              pixelSim:    pixelSimilarity,
              edgeSim:     _eHashSimilarity(refW?.eHash ?? refEHashSync, masterW?.eHash ?? masterEHashSync),
              pHashSim:    _dHashSimilarity(refDHash, masterDHash),
              lumaSim:     Math.max(0, 100 - Math.abs((refW?.luma ?? refLumaSync) - (masterW?.luma ?? masterLumaSync))),
              durationSim: _durationSimilarity(metrics),
            }),
          };
        } catch { /* keep raw regional-hash confidence on seek/draw error */ }
      }
    }

    // bestSec is real media time coming back out of a seek, so it converts to
    // frames on the exact rate — the inverse of the approxSec computed above.
    const matchedFrameF = Math.round((result.bestSec || 0) * fpsExact);
    const derivedSrcInF = _deriveSourceInFromMatched(metrics, eventOffsetF, matchedFrameF);
    sampleMatches.push({
      refFrame: Math.round(metrics.recInF + eventOffsetF),
      refTimelineOffset: Math.round(eventOffsetF),
      eventOffset: Math.round(eventOffsetF),
      approxSourceFrame: Math.round(approxSrcFrameF),
      matchedSourceFrame: matchedFrameF,
      derivedSourceInFrame: Math.round(derivedSrcInF),
      score: result.confidence ?? 0,
      distance: result.distance,
      pixelSimilarity: result.pixelSimilarity ?? null,
      method: useAI ? 'ai_frame_hash_fallback' : 'visual_hash_wave',
    });
  }

  if (!sampleMatches.length) throw new Error('No usable reference samples');

  const strong = sampleMatches.filter(s => (s.score ?? 0) >= 45);
  const srcInCandidates = (strong.length ? strong : sampleMatches).map(s => s.derivedSourceInFrame);
  const medianSrcInF = _median(srcInCandidates);
  const residuals = sampleMatches.map(s => Math.abs(s.derivedSourceInFrame - medianSrcInF));
  const varianceF = Math.round(Math.max(...residuals, 0));
  const consistent = sampleMatches.filter(s => Math.abs(s.derivedSourceInFrame - medianSrcInF) <= Math.max(2, Math.round(2 + metrics.speedRatio))).length;

  const avgScore = sampleMatches.reduce((a, s) => a + (s.score || 0), 0) / sampleMatches.length;
  const consistencyBonus = sampleMatches.length > 1 ? Math.round((consistent / sampleMatches.length) * 14) : 0;
  const variancePenalty = Math.min(28, Math.max(0, varianceF - 1) * 2);
  const dynamicPenalty = metrics.dynamicSpeed ? 8 : 0;
  const durationBonus = metrics.srcSpanF > 0 && metrics.recDurF > 0 ? 4 : 0;
  const pixelScores = sampleMatches.map(s => s.pixelSimilarity).filter(Number.isFinite);
  let visualPixelSimilarity = pixelScores.length ? Math.round(_median(pixelScores)) : null;
  let pixelStatus = Number.isFinite(visualPixelSimilarity) ? pixelSimilarityStatus(visualPixelSimilarity) : null;
  const rawVisualConfidence = Math.max(0, Math.min(100, Math.round(avgScore + consistencyBonus + durationBonus - variancePenalty - dynamicPenalty)));
  // Never let tolerant hashes report more confidence than the actual continuous
  // pixel agreement. This is the guard that prevents visibly different shots
  // from showing "Picture 100%" in the review cockpit.
  const transformEvidence = _transformDescriptor(ev);
  let visualConfidence = Number.isFinite(visualPixelSimilarity) && !transformEvidence.flagged
    ? Math.min(rawVisualConfidence, visualPixelSimilarity)
    : rawVisualConfidence;
  // Preserve V1.4's native regional-hash evidence instead of replacing it with
  // a confidence-derived pseudo-distance. Embedding-only results use a 0..1
  // cosine distance and therefore deliberately do not claim V1.4 evidence.
  const regionalDistances = useAI
    ? []
    : sampleMatches.map(s => s.distance).filter(d => Number.isFinite(d) && d >= 0 && d <= _REGIONAL_MAX_DIST);
  const visualDistance = regionalDistances.length ? Math.round(_median(regionalDistances)) : null;
  const visualStatus = Number.isFinite(visualDistance) ? confidenceStatus(visualDistance) : null;

  let correctedSrcInF = Math.max(0, Math.round(medianSrcInF));
  let startRefine = null;
  if (searchProfile !== 'library') {
    try {
      startRefine = await _refineSourceInBoundary({
        metrics, ev, refVideo, masterVideo, fpsExact, seqBaseFrames,
        candidateSrcInF: correctedSrcInF, shouldCancel,
      });
      if (startRefine) {
        correctedSrcInF = startRefine.srcInF;
        visualPixelSimilarity = Number.isFinite(visualPixelSimilarity)
          ? Math.min(visualPixelSimilarity, startRefine.pixelSimilarity)
          : startRefine.pixelSimilarity;
        pixelStatus = pixelSimilarityStatus(visualPixelSimilarity);
        visualConfidence = Math.min(visualConfidence, visualPixelSimilarity);
      }
    } catch { /* keep sample-derived boundary; existing evidence still applies */ }
  }
  // Independently refine the OUT point (V1.4 refine_boundaries port). Falls back
  // to the span-derived out for retimed shots or weak/implausible end matches.
  let correctedSrcOutF = Math.max(0, Math.round(correctedSrcInF + metrics.srcSpanF));
  let endRefine = null;
  if (searchProfile !== 'library') {
    try {
      endRefine = await _refineSourceOut({
        metrics, refVideo, masterVideo, canvas, ctx, fps, seqBaseFrames,
        correctedSrcInF, masterFileKey,
      });
    } catch { /* keep span-derived out on any refinement error */ }
  }
  if (endRefine) correctedSrcOutF = Math.max(correctedSrcInF + 1, Math.round(endRefine.srcOutF));
  // Picture evidence is authoritative. Audio/consistency may lower confidence,
  // but they may never promote a V1.4 REVIEW/NO_MATCH picture to SAFE.
  const pixelGateOk = transformEvidence.flagged ? visualStatus === 'OK' : pixelStatus === 'OK';
  // A variable-speed map deliberately makes the source-frame offsets diverge
  // across the edit. Treat that expected spread as review evidence instead of
  // a hard failure when the picture itself is a strong match. Retime results
  // never auto-promote to SAFE: an editor still checks the ramp in the NLE
  // viewer before using it.
  const dynamicVarianceLimit = Math.max(32, Math.round(metrics.srcSpanF * 0.2));
  const dynamicReview = metrics.dynamicSpeed
    && visualStatus === 'OK'
    && visualConfidence >= 58
    && consistent >= 2
    && varianceF <= dynamicVarianceLimit;
  const confidenceStatusValue = (consistent >= 3 && varianceF <= 2 && visualConfidence >= 82 && pixelGateOk && !metrics.dynamicSpeed)
    ? 'SAFE'
    : (dynamicReview || (consistent >= 2 && varianceF <= 8 && visualConfidence >= 58))
      ? 'REVIEW'
      : 'FAIL';
  const status = visualStatus === 'NO_MATCH' || (!transformEvidence.flagged && pixelStatus === 'NO_MATCH')
    ? 'FAIL'
    : visualStatus === 'REVIEW' || (!transformEvidence.flagged && pixelStatus === 'REVIEW')
      ? 'REVIEW'
      : confidenceStatusValue;

  return {
    srcIn:      _framesToTC(correctedSrcInF,  fps),
    srcOut:     _framesToTC(correctedSrcOutF, fps),
    confidence: visualConfidence,
    visualConfidence,
    audioConfidence: null,
    finalConfidence: visualConfidence,
    distance:   visualDistance,
    visualDistance,
    visualStatus,
    pixelSimilarity: visualPixelSimilarity,
    pixelStatus,
    boundaryPixelSimilarity: startRefine?.pixelSimilarity ?? null,
    startBoundaryRefined: !!startRefine?.refined,
    startBoundaryDeltaFrames: startRefine?.deltaFrames ?? 0,
    pictureEvidenceVersion: visualStatus ? 'V1.4+continuous-pixel' : null,
    method:     metrics.dynamicSpeed ? 'visual_wave_duration_speed_dynamic' : 'visual_wave_duration_speed',
    status,
    sampleMatches,
    samplesUsed: sampleMatches.length,
    consistentSamples: consistent,
    offsetVarianceFrames: varianceF,
    speedPercent: metrics.speedPct,
    speedRatio: metrics.speedRatio,
    retime: _retimeDescriptor(metrics),
    transform: transformEvidence,
    sourceSpanFrames: metrics.srcSpanF,
    durationFrames: metrics.recDurF,
    // Independent end-boundary refinement (V1.4 refine_boundaries port).
    endRefined:        !!endRefine,
    endConfidence:     endRefine ? Math.round(endRefine.endConfidence) : null,
    refinedSpanFrames: endRefine ? endRefine.refinedSpanF : metrics.srcSpanF,
  };
}

// ── Per-reel slip computation ──────────────────────────────────────────────
// After per-event visual matching, collapse individual event corrections into a
// single median offset per reel. This is the classic "analyze → slip" workflow.

function _computeReelSlips(events, eventCorrections, fps) {
  const reelBuckets = new Map(); // masterName → [{offset, confidence}]
  for (const [evId, corr] of Object.entries(eventCorrections)) {
    if (!corr.srcIn || corr.method === 'reel_slip') continue;
    const ev = events.find(e => String(e.id) === String(evId));
    if (!ev) continue;
    const origF = ev._srcInFrames ?? _tcToFrames(ev.srcIn || '00:00:00:00', fps);
    const corrF = _tcToFrames(corr.srcIn, fps);
    const key = corr.masterName || corr.matchedSourceFile || corr.masterFileName || '';
    if (!key) continue;
    if (!reelBuckets.has(key)) reelBuckets.set(key, []);
    reelBuckets.get(key).push({ offset: corrF - origF, confidence: corr.confidence ?? 0 });
  }
  const slipMap = {};
  for (const [reel, samples] of reelBuckets) {
    const strong = samples.filter(s => s.confidence >= 45);
    const pool = strong.length ? strong : samples;
    const offsets = pool.map(s => s.offset);
    const med = Math.round(_median(offsets));
    const avgConf = Math.round(pool.reduce((a, s) => a + s.confidence, 0) / pool.length);
    slipMap[reel] = { offset: med, sampleCount: pool.length, confidence: avgConf };
  }
  return slipMap;
}

// Apply per-reel slip to every event that lacks a high-confidence per-event match.
// Preserves per-event corrections with confidence ≥ 45 (visual hash found a strong match).
function _applyReelSlips(slipMap, events, eventCorrections, reelMap, fps) {
  const reelByProxy = {};
  for (const r of reelMap) reelByProxy[r.proxyName] = r;

  for (const ev of events) {
    if (ev.disabled || ev.type !== 'video') continue;
    const existing = eventCorrections[ev.id];
    if (existing && existing.method !== 'reel_slip' && (existing.confidence ?? 0) >= 45) continue;

    const entry = reelByProxy[ev.reel || ev.srcFile || ''];
    if (!entry?.masterFile) continue;
    const masterName = entry.masterName;
    const slip = slipMap[masterName];
    if (!slip) continue;

    const origSrcInF  = ev._srcInFrames  ?? _tcToFrames(ev.srcIn  || '00:00:00:00', fps);
    const origSrcOutF = ev._srcOutFrames ?? _tcToFrames(ev.srcOut || '00:00:00:00', fps);
    eventCorrections[ev.id] = {
      srcIn:            _framesToTC(Math.max(0, origSrcInF  + slip.offset), fps),
      srcOut:           _framesToTC(Math.max(0, origSrcOutF + slip.offset), fps),
      confidence:       slip.confidence,
      finalConfidence:  slip.confidence,
      method:           'reel_slip',
      slipFrames:       slip.offset,
      masterName,
      masterFileName:   entry.masterFile?.name || masterName,
      matchedSourceFile: entry.masterFile?.name || masterName,
      matchedSourcePath: entry.masterFile?._nativePath || entry.masterFile?.name || masterName,
      status:           'REVIEW',
    };
  }
}

// ── Build reel map ─────────────────────────────────────────────────────────

function _buildReelMap(events, masterFiles) {
  const uniqueProxies = [...new Set(
    events
      .filter(e => !e.disabled && e.type === 'video' && !e.autoPreserve)
      .map(e => e.reel || e.srcFile || e.clipName || '')
      .filter(Boolean)
  )];

  const mastersWithEp = masterFiles.map(f => ({
    file:  f,
    name:  f.name,
    epNum: _extractEpNum(f.name),
  }));

  return uniqueProxies.map(proxyName => {
    const proxyEp = _extractEpNum(proxyName);
    let bestMaster = null, bestScore = 0;
    for (const m of mastersWithEp) {
      const score = _epScore(proxyEp, m.epNum);
      if (score > bestScore) { bestScore = score; bestMaster = m; }
    }
    return {
      proxyName,
      proxyEp,
      masterFile: bestScore >= 100 ? bestMaster?.file : null,
      masterName: bestScore >= 100 ? bestMaster?.name : '',
      masterEp:   bestScore >= 100 ? bestMaster?.epNum : null,
      score:      bestScore,
      status:     proxyEp == null  ? 'skip'
                : bestScore >= 100 ? 'matched'
                : bestScore > 0    ? 'low'
                : 'unmatched',
      tcOffset:   0,
    };
  });
}

// Apply tape-TC→file-time offsets (populated by _autoIndexSource) to reel map entries.
function _applyTcOffsets(reelMap, fileTcOffsets) {
  if (!fileTcOffsets || !reelMap) return;
  for (const entry of reelMap) {
    if (entry.masterFile && fileTcOffsets[entry.masterFile.name] != null) {
      entry.tcOffset = fileTcOffsets[entry.masterFile.name];
    }
  }
}

// ── File Handle Persistence + Fingerprint Cache (IndexedDB) ──────────────
// FileSystemFileHandle objects can be stored in IDB and re-opened later.
// XML text is also stored so the timeline restores even if file permission lapses.
// trlconf_fp stores frame hashes and luma envelopes so re-runs skip re-extraction.

const _TRC_IDB_NAME    = 'PostFlowX';
const _TRC_IDB_VER     = 2;           // bumped from 1 to add trlconf_fp store
const _TRC_IDB_STORE   = 'trlconf';
const _FP_IDB_STORE    = 'trlconf_fp';
const _TRC_HANDLES_KEY = 'inputs_v1';

function _idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_TRC_IDB_NAME, _TRC_IDB_VER);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(_TRC_IDB_STORE)) {
        db.createObjectStore(_TRC_IDB_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(_FP_IDB_STORE)) {
        const s = db.createObjectStore(_FP_IDB_STORE, { keyPath: 'key' });
        s.createIndex('ts', 'ts', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
}

// Stable cache key for a source File object: name + size + lastModified.
function _fpFileKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

// Get a cached fingerprint (frame hash bits or luma envelope array). Returns null on miss.
async function _fpCacheGet(key) {
  try {
    const db  = await _idbOpen();
    const val = await new Promise((res, rej) => {
      const tx  = db.transaction(_FP_IDB_STORE, 'readonly');
      const req = tx.objectStore(_FP_IDB_STORE).get(key);
      req.onsuccess = (e) => res(e.target.result ?? null);
      req.onerror   = (e) => rej(e.target.error);
    });
    return val ? val.data : null;
  } catch { return null; }
}

// Store a fingerprint. Fire-and-forget — callers do not await this.
async function _fpCachePut(key, data) {
  try {
    const db = await _idbOpen();
    await new Promise((res, rej) => {
      const tx = db.transaction(_FP_IDB_STORE, 'readwrite');
      tx.objectStore(_FP_IDB_STORE).put({ key, data, ts: Date.now() });
      tx.oncomplete = res;
      tx.onerror    = (e) => rej(e.target.error);
    });
  } catch {}
}

// Delete entries in trlconf_fp older than maxAgeDays. Uses the ts index
// so only a cursor over old entries is opened — no full-store scan.
async function _fpPrune(maxAgeDays = 30) {
  try {
    const db     = await _idbOpen();
    const cutoff = Date.now() - maxAgeDays * 86_400_000;
    await new Promise((res, rej) => {
      const tx     = db.transaction(_FP_IDB_STORE, 'readwrite');
      const range  = IDBKeyRange.upperBound(cutoff);
      const req    = tx.objectStore(_FP_IDB_STORE).index('ts').openCursor(range);
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = res;
      tx.onerror    = (e) => rej(e.target.error);
    });
  } catch {}
}


async function _idbGetHandles() {
  try {
    const db = await _idbOpen();
    return await new Promise((resolve, reject) => {
      const tx  = db.transaction(_TRC_IDB_STORE, 'readonly');
      const req = tx.objectStore(_TRC_IDB_STORE).get(_TRC_HANDLES_KEY);
      req.onsuccess = (e) => resolve(e.target.result?.value ?? null);
      req.onerror   = (e) => reject(e.target.error);
    });
  } catch { return null; }
}

async function _idbSaveHandles(value) {
  try {
    const db = await _idbOpen();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(_TRC_IDB_STORE, 'readwrite');
      tx.objectStore(_TRC_IDB_STORE).put({ key: _TRC_HANDLES_KEY, value });
      tx.oncomplete = resolve;
      tx.onerror    = (e) => reject(e.target.error);
    });
  } catch {}
}

// Merge a "last matched" timestamp into the persisted handles record without
// clobbering the file handles already stored there (#7 — "Last matched" badge).
async function _idbSaveLastMatchedAt(ts) {
  try {
    const existing = await _idbGetHandles();
    await _idbSaveHandles({ ...(existing || {}), lastMatchedAt: ts });
  } catch {}
}

// Try to get permission for a stored handle.
// Returns 'granted' | 'prompt' | 'denied' (or 'denied' on error).
async function _queryHandlePermission(handle) {
  try {
    const state = await handle.queryPermission({ mode: 'read' });
    return state;
  } catch { return 'denied'; }
}

async function _requestHandlePermission(handle) {
  try {
    const state = await handle.requestPermission({ mode: 'read' });
    return state;
  } catch { return 'denied'; }
}

// ── Main Export ───────────────────────────────────────────────────────────

export function createTrlConformFeature(deps = {}) {
  const { parseXMEML, parseEDL, parseFCPXML } = deps;

  // Prune fingerprint cache entries older than 30 days on first load.
  _fpPrune().catch(() => {});

  // ── State ────────────────────────────────────────────────────────────
  const state = {
    timelineFile:       null,
    timelineText:       '',
    events:             [],
    fps:                DEFAULT_FPS,   // whole-frame timecode base
    fpsExact:           DEFAULT_FPS,   // true playback rate (differs on NTSC)
    projectName:        '',
    masterFiles:        [],
    reelMap:            [],
    analyzed:           false,
    refFile:            null,
    eventCorrections:   {},   // ev.id → { srcIn, srcOut, confidence, distance, method:'visual' }
    visualMatchRunning: false,
    visualMatchCancel:  false,
    aiMode:             false,
    aiModelLoading:     false,
    // Weak rows automatically search every loaded master. Editors expect the
    // folder they chose to be the authority; restricting the first pass to a
    // filename-pinned episode left valid cross-episode shots unmatched.
    multiMasterFallback: true,
    aiAutoFallback:     false,
    matchHasRun:        false,
    lastMatchedAt:      null,   // Date.now() when a match run last completed (persisted via IDB)
    // New v3 fields
    epId:               null,
    matchResults:       {},   // ev.id → { status: 'SAFE'|'REVIEW'|'FAIL'|'MANUAL'|null, approved: false, notes: '' }
    selectedEvId:       null,
    resultsFilter:      'all',  // render-only worklist filter: 'all'|'SAFE'|'REVIEW'|'FAIL'
    verifyMode:         'side',
    syncScrub:          true,
    autoAdvanceReview:  true,
    loopPlayback:       false,
    reviewHistory:      [],
    sourceIndexed:      false,
    exportOptions: {
      onlyApproved:           true,
      includeApprovedReview:  false,
      leaveFailedUnchanged:   true,
      relativePaths:          false,
      addNotes:               false,
    },
    // Internal verify frame storage for mode switching
    _refImageData:  null,
    _srcImageData:  null,
    _verifyEvId:    null,
    // Live scrubbable verify playback (Part B)
    _refVideoEl:       null,
    _srcVideoEl:       null,
    _refVideoUrl:      null,
    _srcVideoUrl:      null,
    _refSessionId:     null,
    _srcSessionId:     null,
    _refTransportOff:  null,   // detach fn returned by attachResolveTransport
    _srcTransportOff:  null,
    _verifyRafId:      null,
    _verifyFileKeys:   { ref: null, src: null }, // dedupe re-loading same file on reselect
    // Tape-TC → file-time offset per source file (frames). Populated during
    // _autoIndexSource via companion /progress/ → startTimecode. Used in
    // _loadVerifyFrames to seek unmatched events to the correct file position.
    fileTcOffsets:  {},
    // File System Access API handles for persistence
    _cutHandle:     null,
    _refHandle:     null,
    _sourceHandles: [],
  };

  let _root = null;
  const _$ = (id) => _root?.querySelector(`#${id}`);

  // ── Build HTML ────────────────────────────────────────────────────────

  function _buildHTML() {
    return /* html */`
<div class="trc-root trc-simple-mode trc-nle-workspace" id="trcRoot">

  <!-- Header/Status Row -->
  <div class="trc-header">
    <span class="trc-header-logo">TRAILERS CONFORM <small>PICTURE CONFORM · ONLINE EDIT</small></span>
    <span class="trc-engine-badge" title="Regional 4×4 dHash · best 10 of 16 cells · independent ±32 frame boundary refinement">PICTURE CONFORM V1.4</span>
    <button class="trc-mode-toggle" id="trcBtnModeToggle" type="button" aria-pressed="false" title="Show advanced matching and engineering controls">Advanced controls</button>
    <div class="trc-status-row">
      <span class="trc-sbadge trc-sbadge--ep" id="trcSbEp">EP ---</span>
      <span class="trc-sbadge" id="trcSbXml">XML: Not loaded</span>
      <span class="trc-sbadge" id="trcSbRef">REF QT: Not loaded</span>
      <span class="trc-sbadge" id="trcSbSource">SOURCE: Not indexed</span>
      <span class="trc-sbadge" id="trcSbMatch">MATCH: Not run</span>
      <span class="trc-sbadge trc-sbadge--last-matched" id="trcSbLastMatched" style="display:none"></span>
      <span class="trc-sbadge" id="trcSbExport">EXPORT: Pending</span>
    </div>
  </div>

  <section class="trc-coach" id="trcCoach" aria-live="polite">
    <div class="trc-coach-icon" id="trcCoachIcon">1</div>
    <div class="trc-coach-copy">
      <span class="trc-coach-kicker">YOUR NEXT STEP</span>
      <strong id="trcCoachTitle">Add your edit timeline</strong>
      <span id="trcCoachText">Start with the XML, EDL, or FCPXML exported from your editing app.</span>
    </div>
    <button class="trc-coach-action" id="trcBtnCoach" type="button">Choose edit timeline</button>
  </section>
  <nav class="trc-flow" aria-label="Trailer conform progress">
    <span class="trc-flow-step is-active" id="trcFlowLoad"><b>1</b><span>Add files</span></span>
    <i></i>
    <span class="trc-flow-step" id="trcFlowMatch"><b>2</b><span>Find matches</span></span>
    <i></i>
    <span class="trc-flow-step" id="trcFlowReview"><b>3</b><span>Review</span></span>
    <i></i>
    <span class="trc-flow-step" id="trcFlowExport"><b>4</b><span>Save XML</span></span>
  </nav>

  <nav class="trc-nle-workspace-strip" aria-label="Trailer conform workspace">
    <button class="trc-workspace-tab is-active" type="button" data-stage="load" data-target="trcPanelInputs"><b>1</b> MEDIA</button>
    <button class="trc-workspace-tab" type="button" data-stage="match" data-target="trcPanelMatch"><b>2</b> MATCH</button>
    <button class="trc-workspace-tab" type="button" data-stage="review" data-target="trcPanelResults"><b>3</b> REVIEW</button>
    <button class="trc-workspace-tab" type="button" data-stage="export" data-target="trcPanelExport"><b>4</b> DELIVER</button>
    <i></i>
    <span class="trc-workspace-state"><i></i> GUIDED NLE · PICTURE-FIRST</span>
  </nav>

  <div class="trc-body">

    <!-- STEP 4: VERIFY -->
    <div class="trc-panel trc-panel-verify" id="trcPanelVerify">
      <div class="trc-panel-head">
        <span class="trc-step-num">4</span>
        <span class="trc-panel-title">SOURCE / RECORD MONITORS</span>
        <span class="trc-verify-event-label" id="trcVerifyEventLabel">—</span>
        <div class="trc-review-nav" role="group" aria-label="Navigate conform review queue">
          <button class="trc-review-nav-btn" id="trcBtnPrevReview" title="Previous event">&#8592; Prev</button>
          <span class="trc-review-counter" id="trcReviewCounter">0 / 0</span>
          <button class="trc-review-nav-btn trc-review-nav-btn--attention" id="trcBtnNextAttention" title="Jump to the next item that needs a decision">Next to check</button>
          <button class="trc-review-nav-btn" id="trcBtnNextReview" title="Next event">Next &#8594;</button>
          <button class="trc-auto-next is-active" id="trcBtnAutoNext" type="button" aria-pressed="true" title="After a decision, open the next item that needs attention"><span></span>AUTO-NEXT</button>
          <button class="trc-review-undo" id="trcBtnUndoDecision" type="button" title="Undo last review decision (U)" disabled>&#8630; UNDO</button>
        </div>
        <div class="trc-view-modes">
          <button class="trc-view-mode-btn is-active" data-mode="side" aria-pressed="true" title="Side by side (1)">SIDE</button>
          <button class="trc-view-mode-btn" data-mode="wipe" aria-pressed="false" title="Adjustable wipe comparison (2)">WIPE</button>
          <button class="trc-view-mode-btn" data-mode="overlay" aria-pressed="false" title="50% overlay comparison (3)">OVERLAY</button>
          <button class="trc-view-mode-btn" data-mode="diff" aria-pressed="false" title="Picture difference view (4)">DIFF</button>
        </div>
        <button class="trc-close-verify" id="trcCloseVerify" title="Back to results">&#8592; Results</button>
      </div>
      <div class="trc-verify-body">
        <div class="trc-verify-empty" id="trcVerifyEmpty">
          Select a result row to compare the Reference QT against the matched source and review the waveform offset.
        </div>
        <div class="trc-verify-confidence-line" id="trcVerifyConfidenceLine" style="display:none" aria-live="polite"></div>
        <div class="trc-nle-inspector" id="trcNleInspector" aria-label="Selected edit properties">
          <span class="trc-nle-chip trc-nle-chip--track" id="trcNleTrack">V1</span>
          <span class="trc-nle-field"><small>RECORD</small><b id="trcNleRecord">—</b></span>
          <span class="trc-nle-field"><small>SOURCE</small><b id="trcNleSource">—</b></span>
          <span class="trc-nle-chip" id="trcNleSpeed">100%</span>
          <span class="trc-nle-chip" id="trcNleTransform">No resize</span>
          <span class="trc-nle-field trc-nle-field--clip"><small>CLIP</small><b id="trcNleClip">—</b></span>
          <button class="trc-gang-toggle is-active" id="trcBtnSyncScrub" type="button" aria-pressed="true" title="Gang Trailer Reference and Original Master for playback and frame stepping">
            <span class="trc-gang-dot" aria-hidden="true"></span>
            <span><b>GANG ON</b><small>REFERENCE + MASTER</small></span>
          </button>
        </div>
        <div class="trc-frames-row" id="trcFramesRow">
          <div class="trc-frame-panel" id="trcRefFramePanel">
            <div class="trc-frame-label"><b>TRAILER REFERENCE</b><span>PROGRAM</span></div>
            <canvas class="trc-frame-canvas" id="trcRefCanvas" width="480" height="270"></canvas>
            <video class="trc-frame-video" id="trcRefVideo" muted playsinline style="display:none"></video>
          </div>
          <div class="trc-frame-divider" id="trcFrameDivider"><span aria-hidden="true">&#128279;</span></div>
          <div class="trc-frame-panel" id="trcSrcFramePanel">
            <div class="trc-frame-label"><b>ORIGINAL MASTER</b><span>SOURCE</span></div>
            <canvas class="trc-frame-canvas" id="trcSrcCanvas" width="480" height="270"></canvas>
            <video class="trc-frame-video" id="trcSrcVideo" muted playsinline style="display:none"></video>
          </div>
        </div>
        <div class="trc-nle-timeline" aria-label="Timeline position for selected shot">
          <div class="trc-nle-transport" role="group" aria-label="Frame playback controls">
            <button id="trcNleGoStart" type="button" title="Go to first frame" aria-label="Go to first frame">|&#9664;</button>
            <button id="trcNleStepBack" type="button" title="Previous frame" aria-label="Previous frame">&#9664;|</button>
            <button class="trc-nle-play-main" id="trcNlePlay" type="button" title="Play both ganged monitors" aria-label="Play both ganged monitors"><span aria-hidden="true">&#9654;</span><b>PLAY BOTH</b></button>
            <button id="trcNleStepForward" type="button" title="Next frame" aria-label="Next frame">|&#9654;</button>
            <button id="trcNleGoEnd" type="button" title="Go to last frame" aria-label="Go to last frame">&#9654;|</button>
            <button class="trc-nle-loop" id="trcNleLoop" type="button" aria-pressed="false" title="Loop selected shot">LOOP</button>
          </div>
          <div class="trc-nle-lanes" id="trcNleLanes" role="slider" tabindex="0" aria-label="Scrub selected shot" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" title="Click or drag to scrub both monitors">
            <div class="trc-nle-ruler"><span id="trcNleTimelineIn">—</span><span id="trcNleTimelineOut">—</span></div>
            <div class="trc-nle-lane"><b>V2</b><span class="trc-nle-clip" id="trcNleClipV2"></span></div>
            <div class="trc-nle-lane"><b>V1</b><span class="trc-nle-clip" id="trcNleClipV1"></span></div>
            <i class="trc-nle-playhead" id="trcNlePlayhead"></i>
            <span class="trc-nle-scrub-hint">CLICK OR DRAG TO SCRUB BOTH</span>
          </div>
          <span class="trc-nle-position" id="trcNlePosition" aria-live="polite">00:00:00:00</span>
          <span class="trc-nle-duration" id="trcNleDuration">—</span>
        </div>
        <div class="trc-wave-strip">
          <div class="trc-wave-track"><span class="trc-wave-track-label">REF</span><canvas class="trc-wave-canvas" id="trcWaveRef" width="600" height="36"></canvas></div>
          <div class="trc-wave-track"><span class="trc-wave-track-label">SRC</span><canvas class="trc-wave-canvas" id="trcWaveSrc" width="600" height="36"></canvas></div>
          <div class="trc-wave-offset-row"><span class="trc-wave-offset-label">Offset &#916;</span><span class="trc-wave-offset-val" id="trcWaveOffset">—</span></div>
        </div>
        <div class="trc-manual-controls">
          <button class="trc-adj-btn" data-delta="-10">-10f</button>
          <button class="trc-adj-btn" data-delta="-1">-1f</button>
          <button class="trc-adj-btn" data-delta="+1">+1f</button>
          <button class="trc-adj-btn" data-delta="+10">+10f</button>
          <div class="trc-manual-sep"></div>
          <span class="trc-gang-help">Both monitors stay on the same edit frame.</span>
          <span class="trc-shortcut-help"><kbd>J</kbd><kbd>K</kbd><kbd>L</kbd> Transport <kbd>&larr;</kbd><kbd>&rarr;</kbd> Frame</span>
          <div class="trc-manual-sep"></div>
          <button class="trc-btn trc-btn-approve-match" id="trcBtnApproveMatch" title="Use this source match (A)">&#10003; Use this match <kbd>A</kbd></button>
          <button class="trc-btn trc-btn-reject-match" id="trcBtnRejectMatch" title="Reject this source match (X)">&#10005; Not a match <kbd>X</kbd></button>
          <button class="trc-btn trc-btn-mark-review" id="trcBtnMarkReview" title="Leave this item for later (D)">Decide later <kbd>D</kbd></button>
        </div>
      </div>
    </div>

    <!-- STEP 1: INPUTS -->
    <div class="trc-panel trc-panel-inputs" id="trcPanelInputs">
      <div class="trc-panel-head">
        <span class="trc-step-num">1</span>
        <span class="trc-panel-title">MEDIA POOL</span>
      </div>
      <div class="trc-media-guide" id="trcMediaGuide" aria-live="polite">
        <div class="trc-media-guide-copy">
          <span class="trc-media-ready-count" id="trcMediaReadyCount">0 / 3 READY</span>
          <strong id="trcMediaNextTitle">Add edit timeline</strong>
          <span id="trcMediaNextText">XML, FCPXML, or EDL from your editing app</span>
        </div>
        <div class="trc-media-meter" aria-label="Media preparation progress">
          <i id="trcMediaStepCut"></i>
          <i id="trcMediaStepRef"></i>
          <i id="trcMediaStepSource"></i>
        </div>
        <button class="trc-media-next-btn" id="trcBtnMediaNext" type="button">ADD TIMELINE</button>
      </div>
      <div class="trc-input-cards">

        <!-- Card A: Editorial Cut -->
        <div class="trc-icard trc-icard--cut" id="trcIcardCut">
          <div class="trc-icard-header">
            <svg class="trc-icard-icon" width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="11" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M4 7h8M4 10h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            <span class="trc-icard-label">1. EDIT TIMELINE</span>
            <span class="trc-media-card-state is-next" id="trcCutState">NEXT</span>
            <span class="trc-icard-formats">.xml · .fcpxml · .edl</span>
          </div>
          <div class="trc-icard-body">
            <div class="trc-drop-zone" id="trcDropCut">
              <div class="trc-drop-inner" id="trcDropCutInner">
                <svg class="trc-drop-icon" width="26" height="26" viewBox="0 0 28 28" fill="none"><rect x="4" y="3" width="13" height="17" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M13 3v5h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M20 17v6M17 21l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <div class="trc-drop-text" id="trcCutLabel">Choose your edit XML, EDL, or FCPXML</div>
                <div class="trc-drop-hint">Premiere · Resolve · Final Cut</div>
              </div>
              <div class="trc-icard-info" id="trcCutInfo" style="display:none">
                <div class="trc-info-row"><span class="trc-info-key">File</span><span class="trc-info-val trc-info-file" id="trcCutInfoFile">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">Format</span><span class="trc-info-val" id="trcCutInfoFmt">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">Events</span><span class="trc-info-val" id="trcCutInfoEvents">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">Timeline</span><span class="trc-info-val trc-info-file" id="trcCutInfoTimeline">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">FPS</span><span class="trc-info-val" id="trcCutInfoFps">—</span></div>
              </div>
            </div>
            <button class="trc-load-btn" id="trcBtnLoadCut">Choose timeline</button>
          </div>
          <button class="trc-clear-btn" id="trcClearCut" style="display:none" title="Clear">×</button>
        </div>

        <!-- Card B: Reference QT -->
        <div class="trc-icard trc-icard--ref" id="trcIcardRef">
          <div class="trc-icard-header">
            <svg class="trc-icard-icon" width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M6 5.5l5 2.5-5 2.5V5.5z" fill="currentColor"/></svg>
            <span class="trc-icard-label">2. TRAILER REFERENCE</span>
            <span class="trc-media-card-state" id="trcRefState">WAITING</span>
            <span class="trc-icard-formats">Apple ProRes .mov</span>
          </div>
          <div class="trc-icard-body">
            <div class="trc-icard-sub">Timeline truth for visual/audio matching</div>
            <div class="trc-drop-zone" id="trcDropRef">
              <div class="trc-drop-inner" id="trcDropRefInner">
                <svg class="trc-drop-icon" width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M9 9l5 3-5 3V9z" fill="currentColor"/></svg>
                <div class="trc-drop-text" id="trcRefLabel">Choose the finished trailer reference</div>
                <div class="trc-drop-hint">Timeline truth · ep ID from filename</div>
              </div>
              <div class="trc-icard-info" id="trcRefInfo" style="display:none">
                <div class="trc-info-row"><span class="trc-info-key">File</span><span class="trc-info-val trc-info-file" id="trcRefInfoFile">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">Episode</span><span class="trc-info-val trc-info-ep" id="trcRefInfoEp">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">Duration</span><span class="trc-info-val" id="trcRefInfoDur">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">FPS</span><span class="trc-info-val" id="trcRefInfoFps">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">Decode</span><span class="trc-info-val" id="trcRefInfoDecode">—</span></div>
              </div>
            </div>
            <button class="trc-load-btn" id="trcBtnLoadRef">Choose reference</button>
          </div>
          <button class="trc-clear-btn" id="trcClearRef" style="display:none" title="Clear">×</button>
        </div>

        <!-- Card C: Source ProRes -->
        <div class="trc-icard trc-icard--source" id="trcIcardSource">
          <div class="trc-icard-header">
            <svg class="trc-icard-icon" width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 5h4l2 3h8v7H2V5z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>
            <span class="trc-icard-label">3. ORIGINAL MASTERS</span>
            <span class="trc-media-card-state" id="trcSourceState">WAITING</span>
            <span class="trc-icard-formats">.mov folder / files</span>
          </div>
          <div class="trc-icard-body">
            <div class="trc-icard-sub">Candidate source media; timecode may differ</div>
            <div class="trc-drop-zone" id="trcDropMasters">
              <div class="trc-drop-inner" id="trcDropSourceInner">
                <svg class="trc-drop-icon" width="26" height="26" viewBox="0 0 28 28" fill="none"><path d="M4 8h6l2 3h12v12H4V8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/></svg>
                <div class="trc-drop-text" id="trcMastersLabel">Choose the folder containing original ProRes masters</div>
                <div class="trc-drop-hint">MOV · candidate source media</div>
              </div>
              <div class="trc-icard-info" id="trcSourceInfo" style="display:none">
                <div class="trc-info-row"><span class="trc-info-key">Files</span><span class="trc-info-val" id="trcSourceInfoCount">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">Indexed</span><span class="trc-info-val" id="trcSourceInfoIndexed">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">Total dur.</span><span class="trc-info-val" id="trcSourceInfoDur">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">Status</span><span class="trc-info-val" id="trcSourceInfoStatus">—</span></div>
              </div>
            </div>
            <button class="trc-load-btn" id="trcBtnLoadSource">Choose masters</button>
          </div>
          <button class="trc-clear-btn" id="trcClearMasters" style="display:none" title="Clear">×</button>
        </div>

      </div>
    </div>

    <!-- STEP 2: PICTURE MATCH -->
    <div class="trc-panel trc-panel-match" id="trcPanelMatch">
      <div class="trc-panel-head">
        <span class="trc-step-num">2</span>
        <span class="trc-panel-title">MATCH ENGINE</span>
        <span class="trc-match-readiness" id="trcMatchReadiness">3 ITEMS NEEDED</span>
        <div class="trc-match-btns" id="trcMatchBtns">
          <button class="trc-btn trc-btn-run-match" id="trcBtnRunMatch" disabled>&#9654; Find matching shots</button>
          <button class="trc-btn trc-btn-detect" id="trcBtnDetectShots" disabled title="No agency EDL/XML? Detect the offline's shots by picture, then match each against the whole master library.">&#9673; Detect Shots (no EDL)</button>
          <button class="trc-btn trc-btn-stop" id="trcBtnStop" style="display:none">&#9632; Stop</button>
          <button class="trc-btn trc-btn-reset-match" id="trcBtnResetMatch" style="display:none">&#8634; Reset Match</button>
          <details class="trc-advanced" id="trcMatchAdvanced">
            <summary class="trc-advanced-summary">Advanced &#9662;</summary>
            <div class="trc-advanced-body">
              <button class="trc-btn trc-btn-match-step" id="trcBtnBuildFP" disabled>Build Reference Fingerprints</button>
              <button class="trc-btn trc-btn-match-step" id="trcBtnIndexSource" disabled>Index Source Frames</button>
              <label class="trc-deep-search-opt" title="After the normal episode-pinned pass, search other episode masters and run the embedding fallback for weak rows. Slower, but cancellable.">
                <input type="checkbox" id="trcOptDeepSearch" checked>
                <span>Search all masters for weak shots</span>
                <small>recommended · slower</small>
              </label>
            </div>
          </details>
        </div>
      </div>
      <div class="trc-match-note">
        Picture-first V1.4 matching compares a 4×4 regional fingerprint, keeps the best 10 of 16 cells to resist burn-ins, and refines boundaries within ±32 frames. Sound is supporting evidence; filenames and source timecode are hints only. Weak shots are automatically checked against every ProRes master in the selected folder.
      </div>
      <div class="trc-progress-wrap" id="trcProgressWrap" style="display:none">
        <div class="trc-progress-phases" id="trcProgressPhases">
          <span class="trc-phase-step" id="trcPhStep0">Reading your cut</span>
          <span class="trc-phase-arrow">&#8250;</span>
          <span class="trc-phase-step" id="trcPhStep1">Looking at the reference picture</span>
          <span class="trc-phase-arrow">&#8250;</span>
          <span class="trc-phase-step" id="trcPhStep2">Listening to the reference sound</span>
          <span class="trc-phase-arrow">&#8250;</span>
          <span class="trc-phase-step" id="trcPhStep3">Scanning source picture</span>
          <span class="trc-phase-arrow">&#8250;</span>
          <span class="trc-phase-step" id="trcPhStep4">Scanning source sound</span>
          <span class="trc-phase-arrow">&#8250;</span>
          <span class="trc-phase-step" id="trcPhStep5">Lining everything up</span>
          <span class="trc-phase-arrow">&#8250;</span>
          <span class="trc-phase-step" id="trcPhStep6">Finished</span>
        </div>
        <div class="trc-progress-bar-row">
          <progress class="trc-progress-bar" id="trcProgressBar" value="0" max="100"></progress>
          <span class="trc-progress-pct" id="trcProgressPct">0%</span>
          <span class="trc-progress-current" id="trcProgressCurrent"></span>
          <span class="trc-progress-eta" id="trcProgressEta"></span>
        </div>
      </div>
      <div class="trc-slip-summary" id="trcSlipSummary" style="display:none"></div>
    </div>

    <!-- STEP 3: MATCH RESULTS -->
    <div class="trc-panel trc-panel-results" id="trcPanelResults">
      <div class="trc-panel-head">
        <span class="trc-step-num">3</span>
        <span class="trc-panel-title">CONFORM TIMELINE</span>
        <span class="trc-results-stats" id="trcResultsStats"></span>
        <div class="trc-results-filter" id="trcResultsFilter" role="group" aria-label="Filter results by status" style="display:none">
          <button class="trc-filter-btn is-active" data-filter="all"    title="Show every row">All</button>
          <button class="trc-filter-btn" data-filter="SAFE"   title="Show matches ready to use">Ready</button>
          <button class="trc-filter-btn" data-filter="REVIEW" title="Show matches that need checking">Check</button>
          <button class="trc-filter-btn" data-filter="FAIL"   title="Show shots with no confident match">No match</button>
        </div>
        <button class="trc-btn" id="trcBtnApproveAllSafe" title="Use every high-confidence match" style="display:none">Use all ready matches</button>
      </div>
      <div class="trc-results-guide" id="trcResultsGuide" style="display:none">
        <div class="trc-results-summary" id="trcResultsSummary"></div>
        <div class="trc-review-readiness">
          <div class="trc-review-readiness-copy"><span>Review progress</span><strong id="trcReviewReadinessPct">0%</strong></div>
          <div class="trc-review-readiness-track" aria-hidden="true"><span id="trcReviewReadinessFill"></span></div>
          <button class="trc-btn trc-btn-open-attention" id="trcBtnOpenAttention" type="button">Check next item</button>
        </div>
        <div class="trc-results-unmatched-reels" id="trcResultsUnmatchedReels" style="display:none"></div>
        <div class="trc-results-legend">
          <span class="trc-legend-item"><span class="trc-badge trc-badge-safe">READY</span> strong match — ready to use</span>
          <span class="trc-legend-item"><span class="trc-badge trc-badge-review">CHECK</span> compare both pictures before deciding</span>
          <span class="trc-legend-item"><span class="trc-badge trc-badge-fail">NO MATCH</span> choose another source or leave unchanged</span>
          <span class="trc-legend-note">V1.4 distance: OK 0–80 · REVIEW 81–200 · NO MATCH 201–640 (lower is better). Visual % = picture consistency · Audio % = supporting sound evidence.</span>
        </div>
      </div>
      <div class="trc-empty-state" id="trcEmptyState">
        <div class="trc-empty-hint">Add the three items above, then PostFlowX will find the matching original shots for you.</div>
      </div>
      <div class="trc-results-wrap" id="trcResultsWrap" style="display:none">
        <table class="trc-table trc-results-table">
          <thead>
            <tr>
              <th class="trc-col-num">#</th>
              <th class="trc-col-event">Event</th>
              <th class="trc-col-clip">XML Clip</th>
              <th class="trc-col-tc">Ref In</th>
              <th class="trc-col-tc">Ref Out</th>
              <th class="trc-col-dur">Dur</th>
              <th class="trc-col-source">Matched Source</th>
              <th class="trc-col-tc">Corr. Src In</th>
              <th class="trc-col-tc">Corr. Src Out</th>
              <th class="trc-col-offset">Offset</th>
              <th class="trc-col-pct">Visual %</th>
              <th class="trc-col-pct">Audio %</th>
              <th class="trc-col-pct">Final %</th>
              <th class="trc-col-status">Status</th>
              <th class="trc-col-action">Action</th>
            </tr>
          </thead>
          <tbody id="trcResultsBody"></tbody>
        </table>
      </div>
    </div>

    <!-- STEP 5: EXPORT -->
    <div class="trc-panel trc-panel-export" id="trcPanelExport">
      <div class="trc-panel-head">
        <span class="trc-step-num">5</span>
        <span class="trc-panel-title">OUTPUT</span>
        <div class="trc-export-summary" id="trcExportSummary">
          <span class="trc-sum-card">
            <span class="trc-sum-label">Total</span>
            <span class="trc-sum-value" id="trcSumTotal">0</span>
          </span>
          <span class="trc-sum-card trc-sum-card-safe">
            <span class="trc-sum-label">SAFE Approved</span>
            <span class="trc-sum-value" id="trcSumSafeApproved">0</span>
          </span>
          <span class="trc-sum-card trc-sum-card-review">
            <span class="trc-sum-label">REVIEW Approved</span>
            <span class="trc-sum-value" id="trcSumReviewApproved">0</span>
          </span>
          <span class="trc-sum-card trc-sum-card-review-soft">
            <span class="trc-sum-label">REVIEW Unapproved</span>
            <span class="trc-sum-value" id="trcSumReviewUnapproved">0</span>
          </span>
          <span class="trc-sum-card trc-sum-card-fail">
            <span class="trc-sum-label">FAIL</span>
            <span class="trc-sum-value" id="trcSumFail">0</span>
          </span>
          <span class="trc-sum-card">
            <span class="trc-sum-label">To Update</span>
            <span class="trc-sum-value" id="trcSumUpdate">0</span>
          </span>
          <span class="trc-sum-card">
            <span class="trc-sum-label">Unchanged</span>
            <span class="trc-sum-value" id="trcSumUnchanged">0</span>
          </span>
        </div>
      </div>
      <div class="trc-export-body">
        <div class="trc-export-opts">
          <label class="trc-opt-check"><input type="checkbox" id="trcOptOnlyApproved" checked> Only update events you've approved</label>
          <label class="trc-opt-check"><input type="checkbox" id="trcOptIncludeReview"> Also include approved REVIEW events</label>
          <label class="trc-opt-check"><input type="checkbox" id="trcOptLeaveFailUnchanged" checked> Leave failed events unchanged (keep original media)</label>
          <label class="trc-opt-check"><input type="checkbox" id="trcOptRelativePaths"> Use relative media paths (more portable)</label>
          <label class="trc-opt-check"><input type="checkbox" id="trcOptAddNotes"> Add REVIEW / FAIL notes to the exported file</label>
        </div>
        <div class="trc-export-preview" id="trcExportPreview" style="margin-top:8px;font-size:11px;opacity:0.85"></div>
        <div class="trc-export-btns">
          <button class="trc-btn trc-btn-export-xml" id="trcBtnExportXML" disabled>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2v9M4 7l4 5 4-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="2" y1="14" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            Save corrected XML
          </button>
        </div>
      </div>
    </div>

  </div>
</div>
`;
  }

  // ── Parse timeline file ───────────────────────────────────────────────

  async function _parseTimeline(file) {
    const text = await file.text();
    state.timelineText = text;  // cache for IDB persistence
    const name = file.name.toLowerCase();

    if (name.endsWith('.edl')) {
      if (!parseEDL) throw new Error('EDL parser not available');
      const result = parseEDL(text);
      const fps = result.fps || DEFAULT_FPS;
      const events = (result.events || [])
        .filter(e => e.srcFile !== 'BL' && e.reel !== 'BL')
        .map((e, i) => {
          const proxyKey = (e.reel === 'AX' || !e.reel)
            ? (e.clipName || e.srcFile || 'AX')
            : (e.reel || e.clipName || e.srcFile || '');
          return {
            id:            i,
            type:          'video',
            disabled:      false,
            clipName:      e.clipName || e.reel || '',
            reel:          proxyKey,
            srcFile:       e.srcFile || proxyKey || '',
            srcIn:         e.srcIn  || '00:00:00:00',
            srcOut:        e.srcOut || '00:00:00:00',
            recIn:         e.recIn  || '00:00:00:00',
            recOut:        e.recOut || '00:00:00:00',
            fps,
            _srcInFrames:  _tcToFrames(e.srcIn,  fps),
            _srcOutFrames: _tcToFrames(e.srcOut, fps),
            _recInFrames:  _tcToFrames(e.recIn,  fps),
            _recOutFrames: _tcToFrames(e.recOut, fps),
          };
        });
      return { events, fps, projectName: result.title || _stem(file.name) };
    }

    if (name.endsWith('.xml') || name.endsWith('.xmeml')) {
      if (!parseXMEML) throw new Error('XMEML parser not available');
      const result = parseXMEML(text);
      (result.events || []).forEach((e, i) => { if (e.id == null) e.id = i; });
      return result;
    }

    if (name.endsWith('.fcpxml')) {
      if (!parseFCPXML) throw new Error('FCPXML parser not available');
      return parseFCPXML(text);
    }

    throw new Error(`Unsupported format: ${file.name}`);
  }

  // ── Status badge update ───────────────────────────────────────────────

  function _getVisibleEvents() {
    return state.events.filter(e => !e.disabled && e.type === 'video' && !e.autoPreserve);
  }

  function _getPreservedEvents() {
    return state.events.filter(e => !e.disabled && e.type === 'video' && e.autoPreserve);
  }

  function _isReviewResolved(evId) {
    const meta = state.matchResults[evId];
    return !!meta?.approved || meta?.decision === 'rejected';
  }

  function _isAttentionEvent(ev) {
    const status = _computeRowStatus(ev.id);
    return status === 'REVIEW' || status === 'FAIL' || status === 'UNMATCH' || status === 'MANUAL';
  }

  function _getAttentionEvents({ unresolvedOnly = false } = {}) {
    return _getVisibleEvents().filter(ev =>
      _isAttentionEvent(ev) && (!unresolvedOnly || !_isReviewResolved(ev.id))
    );
  }

  function _navigateReview(direction = 1, attentionOnly = false) {
    const queue = attentionOnly
      ? _getAttentionEvents({ unresolvedOnly: true })
      : _getVisibleEvents();
    if (!queue.length) return;
    const current = queue.findIndex(ev => String(ev.id) === String(state.selectedEvId));
    const next = current < 0
      ? (direction < 0 ? queue.length - 1 : 0)
      : (current + direction + queue.length) % queue.length;
    _selectRow(queue[next].id);
  }

  function _advanceAfterDecision(decidedEvId) {
    if (!state.autoAdvanceReview) return;
    const all = _getVisibleEvents();
    const start = Math.max(0, all.findIndex(ev => String(ev.id) === String(decidedEvId)));
    for (let offset = 1; offset <= all.length; offset += 1) {
      const candidate = all[(start + offset) % all.length];
      if (_isAttentionEvent(candidate) && !_isReviewResolved(candidate.id)) {
        _selectRow(candidate.id);
        return;
      }
    }
  }

  function _recordDecisionHistory(evId) {
    const hadMeta = Object.prototype.hasOwnProperty.call(state.matchResults, evId);
    const meta = hadMeta ? { ...state.matchResults[evId] } : null;
    state.reviewHistory.push({ evId, hadMeta, meta });
    if (state.reviewHistory.length > 20) state.reviewHistory.shift();
    _updateUndoUi();
  }

  function _updateUndoUi() {
    const undo = _$('trcBtnUndoDecision');
    if (!undo) return;
    const last = state.reviewHistory[state.reviewHistory.length - 1];
    undo.disabled = !last;
    const help = last
      ? `Undo the last decision for Event ${Number(last.evId) + 1} (U)`
      : 'No review decision to undo';
    undo.title = help;
    undo.setAttribute('aria-label', help);
  }

  function _undoLastDecision() {
    const last = state.reviewHistory.pop();
    if (!last) return;
    if (last.hadMeta) state.matchResults[last.evId] = { ...last.meta };
    else delete state.matchResults[last.evId];
    _renderMatchResults();
    _renderExportSummary();
    _updateStatusBadges();
    _updateExportBtns();
    _selectRow(last.evId);
    _updateUndoUi();
  }

  function _getMatchMeta(evId) {
    if (!state.matchResults[evId]) {
      state.matchResults[evId] = { status: null, approved: false, notes: '' };
    }
    return state.matchResults[evId];
  }

  function _isEventApproved(evId) {
    return !!state.matchResults[evId]?.approved;
  }

  function _shouldApplyCorrection(ev) {
    const corr = state.eventCorrections[ev.id];
    if (!corr) return false;
    const status = _computeRowStatus(ev.id);
    const approved = _isEventApproved(ev.id);

    if (!state.exportOptions.onlyApproved) {
      if (status === 'FAIL' && state.exportOptions.leaveFailedUnchanged) return false;
      return true;
    }

    if (!approved) return false;
    if (status === 'FAIL' && state.exportOptions.leaveFailedUnchanged) return false;
    if (status === 'REVIEW') return !!state.exportOptions.includeApprovedReview;
    return status === 'SAFE' || status === 'MANUAL';
  }

  function _getExportSummaryData() {
    const visibleEvents = _getVisibleEvents();
    let safeApproved = 0;
    let reviewApproved = 0;
    let reviewUnapproved = 0;
    let fail = 0;
    let unmatched = 0;
    let toUpdate = 0;

    for (const ev of visibleEvents) {
      const status = _computeRowStatus(ev.id);
      const approved = _isEventApproved(ev.id);
      if (status === 'SAFE' && approved) safeApproved++;
      if (status === 'REVIEW' && approved) reviewApproved++;
      if (status === 'REVIEW' && !approved) reviewUnapproved++;
      if (status === 'FAIL') fail++;
      if (status === 'UNMATCH') unmatched++;
      if (_shouldApplyCorrection(ev)) toUpdate++;
    }

    return {
      total: visibleEvents.length + _getPreservedEvents().length,
      timelineTotal: visibleEvents.length + _getPreservedEvents().length,
      preserved: _getPreservedEvents().length,
      safeApproved,
      reviewApproved,
      reviewUnapproved,
      fail,
      unmatched,
      toUpdate,
      unchanged: Math.max(0, visibleEvents.length - toUpdate) + _getPreservedEvents().length,
    };
  }

  function _updateVerifyControls() {
    const hasSelection = state.selectedEvId != null;
    _updateGangUi();
    _updateLoopUi();
    const ids = [
      'trcBtnApproveMatch',
      'trcBtnRejectMatch',
      'trcBtnMarkReview',
      'trcNleGoStart',
      'trcNleStepBack',
      'trcNlePlay',
      'trcNleStepForward',
      'trcNleGoEnd',
      'trcNleLoop',
    ];
    ids.forEach((id) => {
      const el = _$(id);
      if (el) el.disabled = !hasSelection;
    });
    _root?.querySelectorAll('.trc-adj-btn').forEach((btn) => {
      btn.disabled = !hasSelection;
    });
    const emptyEl = _$('trcVerifyEmpty');
    if (emptyEl) emptyEl.style.display = hasSelection ? 'none' : '';

    const queue = _getVisibleEvents();
    const selectedIndex = queue.findIndex(ev => String(ev.id) === String(state.selectedEvId));
    const counter = _$('trcReviewCounter');
    if (counter) counter.textContent = `${selectedIndex >= 0 ? selectedIndex + 1 : 0} / ${queue.length}`;
    const prev = _$('trcBtnPrevReview');
    const next = _$('trcBtnNextReview');
    if (prev) prev.disabled = queue.length === 0;
    if (next) next.disabled = queue.length === 0;
    const attention = _$('trcBtnNextAttention');
    if (attention) attention.disabled = _getAttentionEvents({ unresolvedOnly: true }).length === 0;
    const autoNext = _$('trcBtnAutoNext');
    if (autoNext) {
      autoNext.classList.toggle('is-active', state.autoAdvanceReview);
      autoNext.setAttribute('aria-pressed', state.autoAdvanceReview ? 'true' : 'false');
      const help = state.autoAdvanceReview
        ? 'Auto-next is on: a decision opens the next item that needs attention'
        : 'Auto-next is off: stay on this item after a decision';
      autoNext.title = help;
      autoNext.setAttribute('aria-label', help);
    }
    _updateUndoUi();
    _syncReviewFocus();
  }

  function _syncReviewFocus() {
    const uiRoot = _$('trcRoot');
    if (!uiRoot) return;
    const shouldFocus = uiRoot.classList.contains('trc-simple-mode') && state.selectedEvId != null;
    uiRoot.classList.toggle('trc-review-focus', shouldFocus);
  }

  function _updateMediaPoolUI() {
    const hasCut = !!state.timelineFile;
    const hasRef = !!state.refFile;
    const masterCount = state.masterFiles.length;
    const hasMasters = masterCount > 0;
    const mastersReady = hasMasters && state.sourceIndexed;
    const readyCount = Number(hasCut) + Number(hasRef) + Number(mastersReady);
    const allReady = hasCut && hasRef && mastersReady;

    let activeKey = 'cut';
    let title = 'Add edit timeline';
    let copy = 'XML, FCPXML, or EDL from your editing app';
    let action = 'ADD TIMELINE';
    let targetId = 'trcBtnLoadCut';

    if (hasCut && !hasRef) {
      activeKey = 'ref';
      title = 'Add finished trailer';
      copy = 'The approved movie is your picture and sound truth';
      action = 'ADD REFERENCE';
      targetId = 'trcBtnLoadRef';
    } else if (hasCut && hasRef && !hasMasters) {
      activeKey = 'source';
      title = 'Add original masters';
      copy = 'Choose the folder containing the original ProRes MOV files';
      action = 'ADD MASTERS';
      targetId = 'trcBtnLoadSource';
    } else if (hasCut && hasRef && hasMasters && !mastersReady) {
      activeKey = 'source';
      title = `Preparing ${masterCount} ProRes master${masterCount === 1 ? '' : 's'}`;
      copy = 'Opening originals directly with AVFoundation — no proxy';
      action = 'PREPARING…';
      targetId = '';
    } else if (allReady && state.visualMatchRunning) {
      activeKey = '';
      title = 'Matching shots…';
      copy = `${_getVisibleEvents().length} timeline shots against ${masterCount} original masters`;
      action = 'MATCHING…';
      targetId = '';
    } else if (allReady && state.matchHasRun) {
      activeKey = '';
      title = 'Media and review list ready';
      copy = 'Open Review to check uncertain shots before saving XML';
      action = 'VIEW RESULTS';
      targetId = 'trcPanelResults';
    } else if (allReady) {
      activeKey = '';
      title = 'Ready to find matching shots';
      copy = `${_getVisibleEvents().length} timeline shots · ${masterCount} direct ProRes master${masterCount === 1 ? '' : 's'}`;
      action = 'FIND MATCHES';
      targetId = 'trcBtnRunMatch';
    }

    const setText = (id, value) => { const el = _$(id); if (el) el.textContent = value; };
    setText('trcMediaReadyCount', `${readyCount} / 3 READY`);
    setText('trcMediaNextTitle', title);
    setText('trcMediaNextText', copy);
    setText('trcBtnLoadCut', hasCut ? 'CHANGE' : 'CHOOSE TIMELINE');
    setText('trcBtnLoadRef', hasRef ? 'CHANGE' : 'CHOOSE REFERENCE');
    setText('trcBtnLoadSource', hasMasters ? 'CHANGE' : 'CHOOSE MASTERS');

    const nextBtn = _$('trcBtnMediaNext');
    if (nextBtn) {
      nextBtn.textContent = action;
      nextBtn.dataset.target = targetId;
      nextBtn.disabled = !targetId;
    }

    const states = [
      { key: 'cut', card: 'trcIcardCut', badge: 'trcCutState', meter: 'trcMediaStepCut', ready: hasCut },
      { key: 'ref', card: 'trcIcardRef', badge: 'trcRefState', meter: 'trcMediaStepRef', ready: hasRef },
      { key: 'source', card: 'trcIcardSource', badge: 'trcSourceState', meter: 'trcMediaStepSource', ready: mastersReady, preparing: hasMasters && !mastersReady },
    ];
    states.forEach((item) => {
      const isActive = item.key === activeKey;
      const card = _$(item.card);
      const badge = _$(item.badge);
      const meter = _$(item.meter);
      card?.classList.toggle('is-ready', item.ready);
      card?.classList.toggle('is-active', isActive);
      card?.classList.toggle('is-preparing', !!item.preparing);
      meter?.classList.toggle('is-ready', item.ready);
      meter?.classList.toggle('is-active', isActive && !item.preparing);
      meter?.classList.toggle('is-preparing', !!item.preparing);
      if (badge) {
        const label = item.ready ? 'READY' : item.preparing ? 'PREPARING' : isActive ? 'NEXT' : 'WAITING';
        badge.textContent = label;
        badge.classList.toggle('is-ready', item.ready);
        badge.classList.toggle('is-next', isActive && !item.preparing);
        badge.classList.toggle('is-preparing', !!item.preparing);
      }
    });

    const matchReadiness = _$('trcMatchReadiness');
    if (matchReadiness) {
      const remaining = 3 - readyCount;
      const label = state.visualMatchRunning
        ? 'MATCHING'
        : state.matchHasRun
          ? 'REVIEW READY'
          : allReady
            ? 'READY TO MATCH'
            : hasMasters && !mastersReady
              ? 'PREPARING MASTERS'
              : `${remaining} ITEM${remaining === 1 ? '' : 'S'} NEEDED`;
      matchReadiness.textContent = label;
      matchReadiness.classList.toggle('is-ready', allReady && !state.visualMatchRunning);
      matchReadiness.classList.toggle('is-busy', state.visualMatchRunning || (hasMasters && !mastersReady));
    }
  }

  function _updateStatusBadges() {
    const epEl = _$('trcSbEp');
    if (epEl) {
      epEl.textContent = state.epId ? `EP${state.epId}` : 'EP ---';
      epEl.classList.toggle('trc-sbadge--loaded', !!state.epId);
    }

    const xmlEl = _$('trcSbXml');
    if (xmlEl) {
      const loaded = !!state.timelineFile;
      xmlEl.textContent = loaded ? 'XML: Loaded' : 'XML: Not loaded';
      xmlEl.classList.toggle('trc-sbadge--loaded', loaded);
    }

    const refEl = _$('trcSbRef');
    if (refEl) {
      const loaded = !!state.refFile;
      refEl.textContent = loaded ? 'REF QT: Loaded' : 'REF QT: Not loaded';
      refEl.classList.toggle('trc-sbadge--loaded', loaded);
    }

    const srcEl = _$('trcSbSource');
    if (srcEl) {
      srcEl.textContent = state.sourceIndexed ? 'SOURCE: Indexed' : 'SOURCE: Not indexed';
      srcEl.classList.toggle('trc-sbadge--loaded', state.sourceIndexed);
    }

    const matchEl = _$('trcSbMatch');
    if (matchEl) {
      matchEl.textContent = state.matchHasRun ? 'MATCH: Ready' : 'MATCH: Not run';
      matchEl.classList.toggle('trc-sbadge--ok', state.matchHasRun);
      matchEl.classList.toggle('trc-sbadge--loaded', false);
    }

    const lastMatchedEl = _$('trcSbLastMatched');
    if (lastMatchedEl) {
      if (state.lastMatchedAt) {
        lastMatchedEl.textContent = `Last matched: ${_relativeTimeAgo(state.lastMatchedAt)}`;
        lastMatchedEl.style.display = '';
      } else {
        lastMatchedEl.style.display = 'none';
      }
    }

    const expEl = _$('trcSbExport');
    if (expEl) {
      const ready = _getExportSummaryData().toUpdate > 0;
      expEl.textContent = ready ? 'EXPORT: Ready' : 'EXPORT: Pending';
      expEl.classList.toggle('trc-sbadge--ok', ready);
      expEl.classList.toggle('trc-sbadge--loaded', false);
    }

    _updateMediaPoolUI();
    _updateGuidedFlow();
  }

  // Keep one obvious, plain-language action at the top of the screen. The
  // underlying professional controls remain available, but a coordinator does
  // not need to understand fingerprints, source indexing, or confidence bands
  // to know what to do next.
  function _updateGuidedFlow() {
    const coachTitle = _$('trcCoachTitle');
    const coachText = _$('trcCoachText');
    const coachIcon = _$('trcCoachIcon');
    const coachBtn = _$('trcBtnCoach');
    if (!coachTitle || !coachText || !coachIcon || !coachBtn) return;

    const attention = state.matchHasRun ? _getAttentionEvents({ unresolvedOnly: true }).length : 0;
    const safeWaiting = state.matchHasRun
      ? _getVisibleEvents().filter(ev => _computeRowStatus(ev.id) === 'SAFE' && !_isEventApproved(ev.id)).length
      : 0;
    const exportSummary = _getExportSummaryData();
    let stage = 'load';
    let title = 'Add your edit timeline';
    let copy = 'Start with the XML, EDL, or FCPXML exported from your editing app.';
    let action = 'Choose edit timeline';
    let targetId = 'trcBtnLoadCut';
    let disabled = false;

    if (state.timelineFile && !state.refFile) {
      title = 'Add the finished trailer reference';
      copy = 'Choose the reference movie that shows the approved trailer edit.';
      action = 'Choose reference movie';
      targetId = 'trcBtnLoadRef';
    } else if (state.timelineFile && state.refFile && !state.masterFiles.length) {
      title = 'Add the original master files';
      copy = 'Choose the folder containing the Apple ProRes episode or feature masters.';
      action = 'Choose master folder';
      targetId = 'trcBtnLoadSource';
    } else if (state.timelineFile && state.refFile && state.masterFiles.length && !state.sourceIndexed) {
      title = 'Preparing your ProRes masters';
      copy = 'PostFlowX is reading the original files directly. You can leave the app open while this finishes.';
      action = 'Preparing files…';
      targetId = '';
      disabled = true;
    } else if (state.timelineFile && state.refFile && state.sourceIndexed && state.visualMatchRunning) {
      stage = 'match';
      title = 'Finding matching shots…';
      copy = 'PostFlowX is comparing the trailer with the ProRes masters. Review will open automatically when this finishes.';
      action = 'Matching in progress…';
      targetId = '';
      disabled = true;
    } else if (state.timelineFile && state.refFile && state.sourceIndexed && !state.matchHasRun) {
      stage = 'match';
      title = 'Ready to find the original shots';
      copy = 'PostFlowX will compare the trailer with the ProRes masters and build a review list.';
      action = 'Find matching shots';
      targetId = 'trcBtnRunMatch';
    } else if (state.matchHasRun && attention > 0) {
      stage = 'review';
      title = `${attention} item${attention === 1 ? '' : 's'} need your decision`;
      copy = 'Compare the trailer frame on the left with the original master on the right, then choose Use this match or Not a match.';
      action = `Check next item (${attention})`;
      targetId = 'trcBtnOpenAttention';
    } else if (state.matchHasRun && safeWaiting > 0) {
      stage = 'review';
      title = `${safeWaiting} strong match${safeWaiting === 1 ? '' : 'es'} are ready`;
      copy = 'These matches have strong picture agreement. You can use them together or inspect them one by one.';
      action = `Use ready matches (${safeWaiting})`;
      targetId = 'trcBtnApproveAllSafe';
    } else if (state.matchHasRun && exportSummary.toUpdate > 0) {
      stage = 'export';
      title = 'Your corrected XML is ready';
      copy = `${exportSummary.toUpdate} approved event${exportSummary.toUpdate === 1 ? '' : 's'} will be updated. Unapproved items stay unchanged.`;
      action = 'Save corrected XML';
      targetId = 'trcBtnExportXML';
    } else if (state.matchHasRun) {
      stage = 'review';
      title = 'Review is complete';
      copy = 'No approved changes are ready to save yet. Review a match and choose Use this match.';
      action = 'View all matches';
      targetId = 'trcPanelResults';
    }

    coachTitle.textContent = title;
    coachText.textContent = copy;
    coachIcon.textContent = stage === 'load' ? '1' : stage === 'match' ? '2' : stage === 'review' ? '3' : '4';
    coachBtn.textContent = action;
    coachBtn.dataset.target = targetId;
    coachBtn.disabled = disabled;
    const uiRoot = _$('trcRoot');
    if (uiRoot) uiRoot.dataset.stage = stage;

    const order = ['load', 'match', 'review', 'export'];
    const activeIndex = order.indexOf(stage);
    const stageEls = [
      _$('trcFlowLoad'), _$('trcFlowMatch'), _$('trcFlowReview'), _$('trcFlowExport'),
    ];
    stageEls.forEach((el, index) => {
      if (!el) return;
      el.classList.toggle('is-active', index === activeIndex);
      el.classList.toggle('is-done', index < activeIndex);
    });
    _root?.querySelectorAll('.trc-workspace-tab').forEach((tab) => {
      const index = order.indexOf(tab.dataset.stage);
      tab.classList.toggle('is-active', index === activeIndex);
      tab.classList.toggle('is-done', index >= 0 && index < activeIndex);
      if (index === activeIndex) tab.setAttribute('aria-current', 'step');
      else tab.removeAttribute('aria-current');
    });
  }

  // ── Row status computation ────────────────────────────────────────────

  function _computeRowStatus(evId) {
    const override = state.matchResults[evId]?.status;
    if (override) return override;
    const corr = state.eventCorrections[evId];
    if (!corr) return 'UNMATCH';
    if (corr.visualStatus === 'NO_MATCH' || corr.pixelStatus === 'NO_MATCH') return 'FAIL';
    if (corr.visualStatus === 'REVIEW' || corr.pixelStatus === 'REVIEW') return 'REVIEW';
    if (corr.status) return corr.status;
    const c = corr.finalConfidence ?? corr.confidence ?? 0;
    const variance = corr.offsetVarianceFrames ?? 999;
    const samples = corr.consistentSamples ?? corr.samplesUsed ?? 0;
    if (c >= 82 && variance <= 2 && samples >= 3) return 'SAFE';
    if (c >= 58 && variance <= 8 && samples >= 2) return 'REVIEW';
    if (c >= 70) return 'REVIEW';
    return 'FAIL';
  }

  // Plain-language "why" sentence for a REVIEW/FAIL/UNMATCH row, built entirely
  // from fields _matchEventByVisualWave already returns (no new computation) —
  // reused by both the Results table (#2) and the Verify panel (#4).
  function _buildMatchReasonSentence(corr) {
    if (!corr) return 'No match was attempted for this event.';
    const samples    = corr.samplesUsed ?? corr.sampleMatches?.length ?? 0;
    const consistent = corr.consistentSamples ?? samples;
    const variance   = corr.offsetVarianceFrames;
    const conf        = corr.finalConfidence ?? corr.confidence ?? 0;
    const bits = [];
    if (corr.visualStatus === 'NO_MATCH' && Number.isFinite(corr.visualDistance)) {
      bits.push(`V1.4 picture distance was ${corr.visualDistance}, above the 200 no-match limit`);
    } else if (corr.visualStatus === 'REVIEW' && Number.isFinite(corr.visualDistance)) {
      bits.push(`V1.4 picture distance was ${corr.visualDistance}, inside the 81–200 review band`);
    }
    if (corr.pixelStatus === 'NO_MATCH' && Number.isFinite(corr.pixelSimilarity)) {
      bits.push(`continuous pixel agreement was only ${corr.pixelSimilarity}%, below the 72% match floor`);
    } else if (corr.pixelStatus === 'REVIEW' && Number.isFinite(corr.pixelSimilarity)) {
      bits.push(`continuous pixel agreement was ${corr.pixelSimilarity}%, inside the 72–87% review band`);
    }
    if (samples > 0 && consistent < samples) {
      bits.push(`Only ${consistent} of ${samples} sample point${samples === 1 ? '' : 's'} we checked found a confident match`);
    }
    if (Number.isFinite(variance) && variance > 2) {
      bits.push(`the matches that were found landed up to ${variance} frame${variance === 1 ? '' : 's'} apart`);
    }
    if (!bits.length) {
      bits.push(`overall confidence landed at ${conf}%`);
    }
    const sentence = bits.join(', and ');
    return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
  }

  function _renderVerifyEvidence(evId) {
    const el = _$('trcVerifyConfidenceLine');
    if (!el) return;
    if (evId == null) {
      el.replaceChildren();
      el.style.display = 'none';
      return;
    }

    const corr = state.eventCorrections[evId];
    const rowStatus = _computeRowStatus(evId);
    const meta = state.matchResults[evId] || {};
    const visualDistance = Number.isFinite(corr?.visualDistance) ? corr.visualDistance : null;
    const pictureStatus = corr?.visualStatus || null;
    const pixelScore = Number.isFinite(corr?.pixelSimilarity) ? corr.pixelSimilarity : null;
    const pixelStatus = corr?.pixelStatus || null;
    const finalConf = corr ? (corr.finalConfidence ?? corr.confidence ?? 0) : 0;
    const visualConf = corr ? (corr.visualConfidence ?? corr.confidence ?? 0) : 0;
    const audioConf = corr?.audioConfidence;
    const samples = corr?.samplesUsed ?? corr?.sampleMatches?.length ?? 0;
    const consistent = corr?.consistentSamples ?? samples;
    const variance = corr?.offsetVarianceFrames;
    const evidenceClass = pictureStatus === 'OK'
      ? 'trc-evidence-status--ok'
      : pictureStatus === 'REVIEW'
        ? 'trc-evidence-status--review'
        : 'trc-evidence-status--fail';
    const rowClass = rowStatus === 'SAFE'
      ? 'trc-evidence-status--ok'
      : rowStatus === 'REVIEW' || rowStatus === 'MANUAL'
        ? 'trc-evidence-status--review'
        : 'trc-evidence-status--fail';
    const decision = meta.approved ? 'Approved' : meta.decision === 'rejected' ? 'Rejected · unchanged on export' : 'Awaiting decision';
    const markerPct = visualDistance == null ? 0 : Math.max(0, Math.min(100, (visualDistance / _REGIONAL_MAX_DIST) * 100));
    const distanceText = visualDistance == null ? 'Not available' : `${visualDistance} / ${_REGIONAL_MAX_DIST}`;
    const pictureText = pictureStatus ? `PICTURE ${pictureStatus.replace('_', ' ')}` : 'PICTURE EVIDENCE N/A';
    const simpleTitle = rowStatus === 'SAFE'
      ? 'This looks like a strong match'
      : rowStatus === 'REVIEW' || rowStatus === 'MANUAL'
        ? 'Please compare these two pictures'
        : 'PostFlowX is not confident in this match';
    const simpleCopy = rowStatus === 'SAFE'
      ? 'If the shot on the left and right is the same, choose Use this match.'
      : rowStatus === 'REVIEW' || rowStatus === 'MANUAL'
        ? 'Check the person, action, and framing. Use the match only when both sides show the same shot.'
        : 'Choose Not a match to keep the original XML unchanged, or open Pro details to adjust it.';

    el.innerHTML = `
      <div class="trc-simple-verdict ${rowClass}">
        <span class="trc-simple-verdict-icon">${rowStatus === 'SAFE' ? '&#10003;' : rowStatus === 'REVIEW' || rowStatus === 'MANUAL' ? '!' : '&#215;'}</span>
        <div><strong>${_esc(simpleTitle)}</strong><span>${_esc(simpleCopy)}</span></div>
      </div>
      <div class="trc-technical-evidence">
      <div class="trc-evidence-topline">
        <span class="trc-evidence-status ${evidenceClass}">${_esc(pictureText)}</span>
        <span class="trc-evidence-status ${rowClass}">${_esc(rowStatus)}</span>
        <span class="trc-evidence-decision">${_esc(decision)}</span>
        <span class="trc-evidence-method">AVFoundation ProRes · regional dHash + continuous pixels · best 10/16 cells</span>
      </div>
      <div class="trc-evidence-grid">
        <div class="trc-evidence-metric trc-evidence-metric--distance">
          <span>V1.4 distance</span><strong>${_esc(distanceText)}</strong>
          <div class="trc-distance-scale ${visualDistance == null ? 'is-empty' : ''}">
            <i class="trc-distance-ok"></i><i class="trc-distance-review"></i><i class="trc-distance-fail"></i>
            ${visualDistance == null ? '' : `<b style="left:${markerPct.toFixed(2)}%"></b>`}
          </div>
          <small>OK ≤80 · REVIEW ≤200 · NO MATCH &gt;200</small>
        </div>
        <div class="trc-evidence-metric"><span>Final</span><strong>${Math.round(finalConf)}%</strong><small>combined confidence</small></div>
        <div class="trc-evidence-metric"><span>Picture</span><strong>${Math.round(visualConf)}%</strong><small>consistency score</small></div>
        <div class="trc-evidence-metric"><span>Pixel agreement</span><strong>${pixelScore == null ? '—' : `${Math.round(pixelScore)}%`}</strong><small>${pixelStatus ? pixelStatus.replace('_', ' ') : 'continuous evidence'}</small></div>
        <div class="trc-evidence-metric"><span>Sound</span><strong>${audioConf == null ? '—' : `${Math.round(audioConf)}%`}</strong><small>supporting evidence</small></div>
        <div class="trc-evidence-metric"><span>Samples</span><strong>${consistent}/${samples}</strong><small>${Number.isFinite(variance) ? `${variance}f max variance` : 'variance unavailable'}</small></div>
      </div>
      <div class="trc-evidence-reason">${_esc(_buildMatchReasonSentence(corr))}</div>
      </div>`;
    el.style.display = '';
  }

  // Round a remaining-time estimate to a human "About N minute(s) remaining"
  // string — nearest 30s under 2 minutes, nearest minute above. Never a promise,
  // always phrased as a rough estimate.
  function _formatEtaRemaining(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const totalSec = ms / 1000;
    if (totalSec < 40) return 'Less than a minute remaining';
    const mins = totalSec / 60;
    if (mins < 2) {
      const rounded = Math.round(mins * 2) / 2; // nearest 0.5 min (30s)
      return `About ${rounded} minute${rounded === 1 ? '' : 's'} remaining`;
    }
    const roundedMin = Math.round(mins);
    return `About ${roundedMin} minutes remaining`;
  }

  // "2 hours ago" style relative-time label for the "Last matched" badge (#7).
  function _relativeTimeAgo(ts) {
    // The `${n === 1 ? '' : 's'}` this replaced is an English plural rule, and
    // it was the only plural rule the badge had. Intl carries CLDR's, including
    // the categories Thai and Korean do not have and Filipino does.
    return relativeTime(ts);
  }

  // ── Render per-reel slip summary chips ────────────────────────────────

  function _renderSlipSummary(slipMap) {
    const el = _$('trcSlipSummary');
    if (!el) return;
    const entries = Object.entries(slipMap || {});
    if (!entries.length) { el.style.display = 'none'; return; }
    el.style.display = '';
    const fps = state.fps || DEFAULT_FPS;
    el.innerHTML =
      '<span class="trc-slip-label">Reel slips applied:</span>' +
      entries.map(([reel, s]) => {
        const sign = s.offset >= 0 ? '+' : '';
        const tcOff = _framesToTC(Math.abs(s.offset), fps);
        const dir   = s.offset >= 0 ? '' : '-';
        const cls   = Math.abs(s.offset) <= 2 ? 'trc-slip-chip--zero'
                    : s.confidence >= 70      ? 'trc-slip-chip--good'
                    : s.confidence >= 45      ? 'trc-slip-chip--ok'
                    : 'trc-slip-chip--warn';
        return `<span class="trc-slip-chip ${cls}" title="${s.sampleCount} samples · ${s.confidence}% conf">`
             + `<span class="trc-slip-reel">${_esc(_stem(reel).slice(0, 18))}</span>`
             + `<span class="trc-slip-offset">${sign}${s.offset}f</span>`
             + `</span>`;
      }).join('');
  }

  // ── Render match results table ────────────────────────────────────────

  function _renderMatchResults() {
    const tbody = _$('trcResultsBody');
    if (!tbody) return;

    const visibleEvents = _getVisibleEvents();
    const reelByProxy = {};
    for (const r of state.reelMap) reelByProxy[r.proxyName] = r;

    const emptyState = _$('trcEmptyState');
    const resultsWrap = _$('trcResultsWrap');
    const statsEl = _$('trcResultsStats');

    const guideEl = _$('trcResultsGuide');

    if (!visibleEvents.length) {
      if (emptyState) emptyState.style.display = '';
      if (resultsWrap) resultsWrap.style.display = 'none';
      if (guideEl) guideEl.style.display = 'none';
      if (statsEl) statsEl.textContent = '';
      const filterEl = _$('trcResultsFilter');
      if (filterEl) filterEl.style.display = 'none';
      _renderExportSummary();
      return;
    }

    if (emptyState) emptyState.style.display = 'none';
    if (resultsWrap) resultsWrap.style.display = '';

    const fps = state.fps || DEFAULT_FPS;

    tbody.innerHTML = visibleEvents.map((ev, i) => {
      const proxyKey = ev.reel || ev.srcFile || '';
      const entry = reelByProxy[proxyKey];
      const masterStemFull = entry?.status === 'matched' ? _stem(entry.masterName) : '';
      const masterStemDisp = masterStemFull.length > 24 ? masterStemFull.slice(0, 22) + '…' : (masterStemFull || '—');

      const corr = state.eventCorrections[ev.id];
      const corrMasterName = corr?.matchedSourceFile || corr?.masterFileName || corr?.masterName || '';
      const displayMasterFull = corrMasterName ? _stem(corrMasterName) : masterStemFull;
      const displayMasterDisp = displayMasterFull.length > 24 ? displayMasterFull.slice(0, 22) + '…' : (displayMasterFull || '—');
      // No fallback to the uncorrected XML srcIn/srcOut here — showing those
      // when corr is missing implied a match happened when it didn't.
      const corrSrcIn  = corr ? corr.srcIn  : '—';
      const corrSrcOut = corr ? corr.srcOut : '—';

      // Offset in frames
      let offsetStr = '—';
      if (corr) {
        const origF = ev._srcInFrames ?? _tcToFrames(ev.srcIn, fps);
        const corrF = _tcToFrames(corr.srcIn, fps);
        const delta = corrF - origF;
        offsetStr = delta === 0 ? '0' : (delta > 0 ? `+${delta}f` : `${delta}f`);
      }

      // Duration
      const recInF  = ev._recInFrames  ?? _tcToFrames(ev.recIn,  fps);
      const recOutF = ev._recOutFrames ?? _tcToFrames(ev.recOut, fps);
      const durF = recOutF - recInF;
      const durStr = durF >= 0 ? `${durF}f` : '—';

      const clipDisp = (ev.clipName || ev.reel || '').slice(0, 30);

      const visualPct  = corr ? `${corr.confidence ?? 0}%` : '—';
      const audioPct   = corr?.audioConfidence != null ? `${corr.audioConfidence}%` : '—';
      const finalPct   = corr ? `${corr.finalConfidence ?? corr.confidence ?? 0}%` : '—';
      // Plain-word confidence beside the Final % (e.g. "78% · Medium") so the
      // number is self-explanatory without cross-referencing the legend.
      // confidenceLabel() expects a 0-1 score; finalConfidence is a 0-100 pct.
      let finalWord = '';
      if (corr) {
        const finalScore = (corr.finalConfidence ?? corr.confidence ?? 0) / 100;
        const lbl = confidenceLabel(finalScore);
        if (lbl !== 'none') finalWord = ` · ${lbl.charAt(0).toUpperCase()}${lbl.slice(1)}`;
      }

      const status = _computeRowStatus(ev.id);
      // Render-only worklist filter (does not touch export/summary math).
      // 'all' shows everything (incl. MANUAL/UNMATCH); a specific status
      // shows only that class. Filtered-out rows render nothing, keeping
      // EVT numbering tied to the full list and the table body valid.
      const activeFilter = state.resultsFilter || 'all';
      if (activeFilter !== 'all' && status !== activeFilter) return '';
      const statusColors = {
        SAFE:    'trc-badge-safe',
        REVIEW:  'trc-badge-review',
        FAIL:    'trc-badge-fail',
        MANUAL:  'trc-badge-manual',
        UNMATCH: 'trc-badge-unmatch',
      };
      const rowClasses = {
        SAFE:    'trc-row-safe',
        REVIEW:  'trc-row-review',
        FAIL:    'trc-row-fail',
        MANUAL:  'trc-row-manual',
        UNMATCH: 'trc-row-unmatch',
      };

      // Speed-ramp / retime badge (informational): on retimed shots the source
      // OUT is preserved from the record span rather than independently refined.
      const retime = corr?.retime;
      const retimeBadge = retime?.flagged
        ? ` <span title="Retimed shot — source OUT preserved from span, not independently end-refined" style="display:inline-block;margin-left:6px;padding:0 5px;border-radius:3px;font-size:9px;font-weight:700;letter-spacing:.03em;background:rgba(224,179,65,.15);color:#e0b341;border:1px solid rgba(224,179,65,.35);vertical-align:middle">⚡ ${_esc(retime.label)}</span>`
        : '';

      const approved = _isEventApproved(ev.id);
      const rejected = state.matchResults[ev.id]?.decision === 'rejected';
      const approvedAttr = approved ? ' data-approved="1"' : '';
      const selectedClass = state.selectedEvId === ev.id ? ' is-selected' : '';
      const eventLabel = `EVT ${String(i + 1).padStart(3, '0')}`;
      const finalPctClass = corr
        ? (corr.finalConfidence ?? corr.confidence ?? 0) >= 80 ? 'trc-pct-high'
        : (corr.finalConfidence ?? corr.confidence ?? 0) >= 60 ? 'trc-pct-med'
        : 'trc-pct-low'
        : 'trc-pct-none';

      const statusLabel = ({ SAFE: 'READY', REVIEW: 'CHECK', FAIL: 'NO MATCH', UNMATCH: 'NOT FOUND', MANUAL: 'ADJUSTED' })[status] || status;
      return `<tr class="${rowClasses[status] || ''}${selectedClass}" data-evid="${ev.id}"${approvedAttr}>
  <td class="trc-col-num">${i + 1}</td>
  <td class="trc-col-event">${_esc(eventLabel)}</td>
  <td class="trc-col-clip" title="${_esc(ev.clipName || ev.reel || '')}">${_esc(clipDisp)}${retimeBadge}</td>
  <td class="trc-col-tc">${_esc(ev.recIn)}</td>
  <td class="trc-col-tc">${_esc(ev.recOut)}</td>
  <td class="trc-col-dur">${_esc(durStr)}</td>
  <td class="trc-col-source" title="${_esc(displayMasterFull)}">${_esc(displayMasterDisp)}</td>
  <td class="trc-col-tc">${_esc(corrSrcIn)}</td>
  <td class="trc-col-tc">${_esc(corrSrcOut)}</td>
  <td class="trc-col-offset">${_esc(offsetStr)}</td>
  <td class="trc-col-pct">${_esc(visualPct)}</td>
  <td class="trc-col-pct">${audioPct}</td>
  <td class="trc-col-pct ${finalPctClass}">${_esc(finalPct)}<span class="trc-pct-word">${_esc(finalWord)}</span></td>
  <td class="trc-col-status"><span class="trc-badge ${statusColors[status] || ''}">${statusLabel}${approved ? ' · Used' : rejected ? ' · Skipped' : ''}</span>${
    (status === 'REVIEW' || status === 'FAIL' || status === 'UNMATCH')
      ? `<div class="trc-row-reason">${_esc(_buildMatchReasonSentence(corr))}</div>`
      : ''
  }</td>
  <td class="trc-col-action">
    <div class="trc-act-stack">
      <button class="trc-act-btn" data-act="view"    data-evid="${ev.id}" title="Compare both pictures">Compare</button>
      <button class="trc-act-btn" data-act="approve" data-evid="${ev.id}" title="Use this match">Use match</button>
      <button class="trc-act-btn" data-act="review"  data-evid="${ev.id}" title="Decide later">Later</button>
      <button class="trc-act-btn" data-act="reject"  data-evid="${ev.id}" title="This is not the same shot">Wrong</button>
      <button class="trc-act-btn" data-act="manual"  data-evid="${ev.id}" title="Adjust the source position">Adjust</button>
    </div>
  </td>
</tr>`;
    }).join('');

    if (statsEl) {
      const safe   = visibleEvents.filter(e => _computeRowStatus(e.id) === 'SAFE').length;
      const review = visibleEvents.filter(e => _computeRowStatus(e.id) === 'REVIEW').length;
      const fail   = visibleEvents.filter(e => _computeRowStatus(e.id) === 'FAIL').length;
      const preserved = _getPreservedEvents().length;
      statsEl.textContent = `${visibleEvents.length} shots · ${safe} ready · ${review} check · ${fail} no match${preserved ? ` · ${preserved} overlays preserved` : ''}`;
    }

    // Worklist filter: show the control once there are rows and reflect the
    // active button. Pure render-layer — the filter only affects which rows
    // are drawn above (in the .map()), never the counts or export/summary math.
    const filterEl = _$('trcResultsFilter');
    if (filterEl) {
      filterEl.style.display = '';
      const activeFilter = state.resultsFilter || 'all';
      for (const btn of filterEl.querySelectorAll('.trc-filter-btn')) {
        btn.classList.toggle('is-active', btn.dataset.filter === activeFilter);
      }
    }

    // Plain-language summary sentence above the results (guide toggled with the table).
    if (guideEl) {
      const summaryEl = _$('trcResultsSummary');
      if (summaryEl) {
        const total = visibleEvents.length;
        const safeN   = visibleEvents.filter(e => _computeRowStatus(e.id) === 'SAFE').length;
        const reviewN = visibleEvents.filter(e => _computeRowStatus(e.id) === 'REVIEW').length;
        const failN   = visibleEvents.filter(e => _computeRowStatus(e.id) === 'FAIL').length;
        const unmatchN = visibleEvents.filter(e => _computeRowStatus(e.id) === 'UNMATCH').length;
        const needAttention = reviewN + failN + unmatchN;
        const evWord = n => (n === 1 ? 'event' : 'events');
        const processedN = visibleEvents.filter(ev =>
          !!state.eventCorrections[ev.id] || !!state.matchResults[ev.id]?.status
        ).length;
        const preservedNote = _getPreservedEvents().length ? ` ${_getPreservedEvents().length} editorial overlays stay unchanged.` : '';
        summaryEl.textContent = state.visualMatchRunning
          ? `Matching in progress — ${processedN} of ${total} ${evWord(total)} checked. Your review list will be ready when this finishes.`
          : needAttention === 0
            ? `All ${total} ${evWord(total)} have a match. Review them, then save your corrected XML.${preservedNote}`
            : `${safeN} of ${total} ${evWord(total)} have a strong match. `
              + `${needAttention} ${evWord(needAttention)} need${needAttention === 1 ? 's' : ''} a quick check before you save.${preservedNote}`;
      }
      guideEl.style.display = '';
    }

    const attentionEvents = _getAttentionEvents();
    const resolvedAttention = attentionEvents.filter(ev => _isReviewResolved(ev.id)).length;
    const unresolvedAttention = attentionEvents.length - resolvedAttention;
    const readinessPct = attentionEvents.length ? Math.round((resolvedAttention / attentionEvents.length) * 100) : 100;
    const readinessPctEl = _$('trcReviewReadinessPct');
    const readinessFillEl = _$('trcReviewReadinessFill');
    const openAttentionBtn = _$('trcBtnOpenAttention');
    const processedDuringMatch = visibleEvents.filter(ev =>
      !!state.eventCorrections[ev.id] || !!state.matchResults[ev.id]?.status
    ).length;
    const matchPct = visibleEvents.length ? Math.round((processedDuringMatch / visibleEvents.length) * 100) : 0;
    if (readinessPctEl) readinessPctEl.textContent = state.visualMatchRunning
      ? `${matchPct}% · ${processedDuringMatch}/${visibleEvents.length} checked`
      : `${readinessPct}% · ${resolvedAttention}/${attentionEvents.length} decided`;
    if (readinessFillEl) readinessFillEl.style.width = `${state.visualMatchRunning ? matchPct : readinessPct}%`;
    if (openAttentionBtn) {
      openAttentionBtn.disabled = state.visualMatchRunning || unresolvedAttention === 0;
      openAttentionBtn.textContent = state.visualMatchRunning
        ? 'Matching in progress…'
        : unresolvedAttention
          ? `Check next item (${unresolvedAttention})`
          : 'Everything checked';
    }

    // #6 — name unmatched / low-confidence proxy reels directly, so an editor
    // doesn't have to hunt through the table to find which reel is the problem.
    // #1 — manual reel-to-source override: a "Fix" dropdown of the currently
    // loaded source files sits right next to each named unmatched/low reel,
    // so a coordinator can point it at the right file without an engineer.
    const unmatchedReelsEl = _$('trcResultsUnmatchedReels');
    if (unmatchedReelsEl) {
      const badReels = (state.reelMap || []).filter(r => r.status === 'unmatched' || r.status === 'low');
      if (badReels.length) {
        const sourceOptions = (state.masterFiles || []).map(
          f => `<option value="${_esc(f.name)}">${_esc(_stem(f.name))}</option>`
        ).join('');
        const items = badReels.map(r => {
          const reason = r.status === 'unmatched' ? 'no source match found' : 'low-confidence match';
          const fixControl = (state.masterFiles || []).length
            ? `<select class="trc-fix-reel-select" data-proxy="${_esc(r.proxyName)}">
                 <option value="">Fix: choose source…</option>
                 ${sourceOptions}
               </select>`
            : '';
          return `<span class="trc-fix-reel">${_esc(_stem(r.proxyName))} (${_esc(reason)})${fixControl}</span>`;
        });
        unmatchedReelsEl.innerHTML = `Needs a source file: ${items.join(', ')}.`;
        unmatchedReelsEl.style.display = '';
      } else {
        unmatchedReelsEl.textContent = '';
        unmatchedReelsEl.style.display = 'none';
      }
    }

    const approveAllBtn = _$('trcBtnApproveAllSafe');
    if (approveAllBtn) {
      const unapprovedSafeCount = visibleEvents.filter(e =>
        _computeRowStatus(e.id) === 'SAFE' && !_isEventApproved(e.id)
      ).length;
      approveAllBtn.style.display = unapprovedSafeCount > 0 ? '' : 'none';
      approveAllBtn.textContent = unapprovedSafeCount > 0
        ? `Use all ready matches (${unapprovedSafeCount})`
        : 'All ready matches used';
    }

    _renderExportSummary();
    _updateVerifyControls();
    _renderVerifyEvidence(state.selectedEvId);
    _updateGuidedFlow();
  }

  // ── Export summary ────────────────────────────────────────────────────

  function _renderExportSummary() {
    const summary = _getExportSummaryData();

    const el = (id, val) => { const el = _$(id); if (el) el.textContent = val; };
    el('trcSumTotal',            String(summary.total));
    el('trcSumSafeApproved',     String(summary.safeApproved));
    el('trcSumReviewApproved',   String(summary.reviewApproved));
    el('trcSumReviewUnapproved', String(summary.reviewUnapproved));
    el('trcSumFail',             String(summary.fail));
    el('trcSumUpdate',           String(summary.toUpdate));
    el('trcSumUnchanged',        String(summary.unchanged));

    // Plain-language "what will export" preview — states, in one sentence, exactly
    // what the Export button will do given the current options + approvals. All
    // numbers come from _getExportSummaryData(); set via textContent (no markup).
    const evWord = (n) => (n === 1 ? 'event' : 'events');
    let previewText = '';
    if (summary.total > 0) {
      previewText = `Export will update ${summary.toUpdate} ${evWord(summary.toUpdate)} and leave ${summary.unchanged} unchanged.`;
      if (summary.preserved > 0) previewText += ` ${summary.preserved} editorial overlay${summary.preserved === 1 ? '' : 's'} will be preserved exactly.`;
      const attention = [];
      if (summary.fail > 0)             attention.push(`${summary.fail} failed`);
      if (summary.reviewUnapproved > 0) attention.push(`${summary.reviewUnapproved} still need review`);
      if (summary.unmatched > 0)        attention.push(`${summary.unmatched} never matched`);
      if (attention.length) previewText += ` Needs attention: ${attention.join(', ')}.`;
    }
    el('trcExportPreview', previewText);
  }

  // ── Select row for verify ─────────────────────────────────────────────

  function _renderNleInspector(ev, corr = null) {
    if (!ev) return;
    const fps = state.fps || DEFAULT_FPS;
    const metrics = _eventFrameMetrics(ev, fps);
    const transform = _transformDescriptor(ev);
    const sourceIn = corr?.srcIn || ev.srcIn || '—';
    const sourceOut = corr?.srcOut || ev.srcOut || '—';
    const speedKeys = Array.isArray(ev.speedKeys) ? ev.speedKeys.length : 0;
    const nominal = Number(ev.nominalSpeedPercent);
    const speedLabel = metrics.dynamicSpeed
      ? `Speed ramp · ${Math.round(metrics.speedRatio * 100)}% avg${Number.isFinite(nominal) ? ` · ${Math.round(nominal * 100) / 100}% set` : ''} · ${speedKeys} keys`
      : (Math.abs(metrics.speedRatio - 1) > 0.01 ? `${Math.round(metrics.speedRatio * 100)}% speed` : '100% speed');
    const set = (id, value, title = value) => {
      const el = _$(id);
      if (!el) return;
      el.textContent = value;
      el.title = title;
    };
    set('trcNleTrack', ev.role || `V${(Number(ev.trackIndex) || 0) + 1}`);
    set('trcNleRecord', `${ev.recIn} → ${ev.recOut}`);
    set('trcNleSource', `${sourceIn} → ${sourceOut}`);
    set('trcNleSpeed', speedLabel);
    set('trcNleTransform', transform.label);
    set('trcNleClip', ev.clipName || ev.srcFile || ev.reel || '—');
    set('trcNleDuration', `${metrics.recDurF}f edit · ${Math.round(metrics.srcSpanF)}f source`);

    // The monitor timeline represents the selected shot, not the full sequence.
    // This keeps the entire scrub target usable even for a two-frame insert in a
    // long trailer, which is how source/record monitor strips behave in an NLE.
    const left = 0;
    const width = 100;
    set('trcNleTimelineIn', ev.recIn || _framesToTC(metrics.recInF, fps));
    set('trcNleTimelineOut', ev.recOut || _framesToTC(metrics.recOutF, fps));
    const laneV1 = _$('trcNleClipV1');
    const laneV2 = _$('trcNleClipV2');
    for (const lane of [laneV1, laneV2]) {
      if (!lane) continue;
      lane.style.display = 'none';
      lane.style.left = `${left}%`;
      lane.style.width = `${width}%`;
      lane.textContent = '';
    }
    const selectedLane = Number(ev.trackIndex) > 0 ? laneV2 : laneV1;
    if (selectedLane) {
      selectedLane.style.display = '';
      selectedLane.textContent = `#${Number(ev.id) + 1} · ${ev.clipName || ev.srcFile || 'SHOT'}`;
    }
    const playhead = _$('trcNlePlayhead');
    if (playhead) playhead.style.left = `${left}%`;
    state._verifyTimelineLeft = left;
    state._verifyTimelineWidth = width;
    state._verifyShotDurationSec = metrics.recDurF / (state.fpsExact || state.fps || DEFAULT_FPS);
    const lanes = _$('trcNleLanes');
    if (lanes) lanes.setAttribute('aria-valuenow', '0');
    const position = _$('trcNlePosition');
    if (position) position.textContent = ev.recIn || '00:00:00:00';
  }

  function _verifySourceDelta(refDeltaSec) {
    const ev = state.events.find(e => String(e.id) === String(state.selectedEvId));
    if (!ev) return refDeltaSec;
    const fpsExact = state.fpsExact || state.fps || DEFAULT_FPS;
    const keys = Array.isArray(ev.speedKeys)
      ? ev.speedKeys.filter(k => Number.isFinite(Number(k.when)) && Number.isFinite(Number(k.value))).sort((a, b) => Number(a.when) - Number(b.when))
      : [];
    const refFrames = Math.max(0, refDeltaSec * fpsExact);
    if (keys.length >= 2) {
      const firstWhen = Number(keys[0].when);
      const targetWhen = firstWhen + refFrames;
      let a = keys[0];
      let b = keys[keys.length - 1];
      for (let i = 0; i < keys.length - 1; i++) {
        if (targetWhen <= Number(keys[i + 1].when)) { a = keys[i]; b = keys[i + 1]; break; }
      }
      const span = Math.max(1e-6, Number(b.when) - Number(a.when));
      const mix = Math.max(0, Math.min(1, (targetWhen - Number(a.when)) / span));
      return Math.max(0, ((Number(a.value) + (Number(b.value) - Number(a.value)) * mix) - Number(keys[0].value)) / fpsExact);
    }
    const metrics = _eventFrameMetrics(ev, state.fps || DEFAULT_FPS);
    return Math.max(0, refDeltaSec * (Number.isFinite(metrics.speedRatio) ? metrics.speedRatio : 1));
  }

  function _updateVerifyPlayhead(refTime = null) {
    const ref = state._refVideoEl;
    const base = state._verifyRefBaseSec;
    const delta = Math.max(0, Number((refTime ?? ref?.currentTime) || 0) - Number(base || 0));
    const duration = Math.max(0.001, Number(state._verifyShotDurationSec) || 0.001);
    const progress = Math.max(0, Math.min(1, delta / duration));
    const left = Number(state._verifyTimelineLeft) || 0;
    const width = Number(state._verifyTimelineWidth) || 0;
    const playhead = _$('trcNlePlayhead');
    if (playhead) playhead.style.left = `${left + width * progress}%`;
    const lanes = _$('trcNleLanes');
    if (lanes) {
      lanes.setAttribute('aria-valuenow', String(Math.round(progress * 100)));
      lanes.setAttribute('aria-valuetext', `${Math.round(progress * 100)}% through selected shot`);
    }
    const ev = state.events.find(e => String(e.id) === String(state.selectedEvId));
    const recIn = ev ? _tcToFrames(ev.recIn, state.fps || DEFAULT_FPS) : 0;
    const position = _$('trcNlePosition');
    if (position) position.textContent = _framesToTC(recIn + Math.round(delta * (state.fpsExact || state.fps || DEFAULT_FPS)), state.fps || DEFAULT_FPS);
  }

  function _setVerifyPlayUi(playing = false) {
    const play = _$('trcNlePlay');
    if (!play) return;
    play.classList.toggle('is-playing', playing);
    play.title = playing ? 'Pause both ganged monitors' : 'Play both ganged monitors';
    play.setAttribute('aria-label', play.title);
    play.innerHTML = playing
      ? '<span aria-hidden="true">Ⅱ</span><b>PAUSE BOTH</b>'
      : '<span aria-hidden="true">▶</span><b>PLAY BOTH</b>';
  }

  function _updateLoopUi() {
    const loop = _$('trcNleLoop');
    if (!loop) return;
    loop.classList.toggle('is-active', state.loopPlayback);
    loop.setAttribute('aria-pressed', state.loopPlayback ? 'true' : 'false');
    const help = state.loopPlayback
      ? 'Loop is on: repeat the selected shot'
      : 'Loop selected shot';
    loop.title = help;
    loop.setAttribute('aria-label', help);
  }

  function _updateGangUi() {
    const gang = _$('trcBtnSyncScrub');
    if (!gang) return;
    gang.classList.toggle('is-active', state.syncScrub);
    gang.setAttribute('aria-pressed', state.syncScrub ? 'true' : 'false');
    gang.title = state.syncScrub
      ? 'Gang is on: Trailer Reference and Original Master play and step together'
      : 'Gang is off: only the active monitor moves';
    gang.innerHTML = `<span class="trc-gang-dot" aria-hidden="true"></span><span><b>GANG ${state.syncScrub ? 'ON' : 'OFF'}</b><small>${state.syncScrub ? 'REFERENCE + MASTER' : 'REFERENCE ONLY'}</small></span>`;
  }

  function _stopNativeVerifyPlayback(message = '') {
    state._verifyNativePlaying = false;
    state._verifyPlaybackToken = (state._verifyPlaybackToken || 0) + 1;
    _setVerifyPlayUi(false);
    if (message) {
      const line = _$('trcVerifyConfidenceLine');
      if (line) { line.style.display = ''; line.textContent = message; }
    }
  }

  async function _seekVerifyProgress(rawProgress) {
    if (state.selectedEvId == null) return;
    _stopNativeVerifyPlayback();
    try { state._refVideoEl?.pause?.(); state._srcVideoEl?.pause?.(); } catch {}
    const fpsExact = state.fpsExact || state.fps || DEFAULT_FPS;
    const progress = Math.max(0, Math.min(1, Number(rawProgress) || 0));
    const lastFrameDelta = Math.max(0, Number(state._verifyShotDurationSec || 0) - (1 / fpsExact));
    const refDelta = lastFrameDelta * progress;
    const refTime = Number(state._verifyRefBaseSec || 0) + refDelta;
    const srcTime = Math.max(0, Number(state._verifySrcBaseSec || 0) + _verifySourceDelta(refDelta));
    await Promise.all([
      state._refVideoEl ? _seekVideo(state._refVideoEl, refTime) : Promise.resolve(),
      state._srcVideoEl && state.syncScrub ? _seekVideo(state._srcVideoEl, srcTime) : Promise.resolve(),
    ]).catch(() => {});
    _verifyRedrawFrame();
    _updateVerifyPlayhead(refTime);
    _setVerifyPlayUi(false);
  }

  async function _stepVerifyFrame(delta) {
    _stopNativeVerifyPlayback();
    try { state._refVideoEl?.pause?.(); state._srcVideoEl?.pause?.(); } catch {}
    const fpsExact = state.fpsExact || state.fps || DEFAULT_FPS;
    const refDelta = Number(delta) / fpsExact;
    const ref = state._refVideoEl;
    const src = state._srcVideoEl;
    const refBase = Number(state._verifyRefBaseSec || 0);
    const lastFrameDelta = Math.max(0, Number(state._verifyShotDurationSec || 0) - (1 / fpsExact));
    const currentRefDelta = Math.max(0, Math.min(
      lastFrameDelta,
      (Number(ref?.currentTime || refBase) - refBase) + refDelta,
    ));
    const nextRef = refBase + currentRefDelta;
    const nextSrc = Math.max(0, Number(state._verifySrcBaseSec || 0) + _verifySourceDelta(currentRefDelta));
    await Promise.all([
      ref ? _seekVideo(ref, nextRef) : Promise.resolve(),
      src && state.syncScrub ? _seekVideo(src, nextSrc) : Promise.resolve(),
    ]).catch(() => {});
    _verifyRedrawFrame();
    _updateVerifyPlayhead(nextRef);
    _setVerifyPlayUi(false);
  }

  async function _toggleVerifyPlayback() {
    const ref = state._refVideoEl;
    const src = state._srcVideoEl;
    if (!ref && !src) return;
    const playing = state._verifyNativePlaying || [ref, src].some(video => video && !video._pfxNativeFrameSource && !video.paused && !video.ended);
    if (playing) {
      _stopNativeVerifyPlayback();
      try { ref?.pause(); src?.pause(); } catch {}
      return;
    }
    const hasNative = !!(ref?._pfxNativeFrameSource || src?._pfxNativeFrameSource);
    if (hasNative) {
      const frameSec = 1 / (state.fpsExact || state.fps || DEFAULT_FPS);
      if (Number(ref?.currentTime || 0) - Number(state._verifyRefBaseSec || 0) >= Number(state._verifyShotDurationSec || 0) - frameSec) {
        await Promise.all([
          ref ? _seekVideo(ref, Number(state._verifyRefBaseSec || 0)) : Promise.resolve(),
          src && state.syncScrub ? _seekVideo(src, Number(state._verifySrcBaseSec || 0)) : Promise.resolve(),
        ]).catch(() => {});
      }
      const token = (state._verifyPlaybackToken || 0) + 1;
      state._verifyPlaybackToken = token;
      state._verifyNativePlaying = true;
      let startWall = performance.now();
      const startRef = Number(ref?.currentTime || state._verifyRefBaseSec || 0);
      let refStartDelta = Math.max(0, startRef - Number(state._verifyRefBaseSec || 0));
      const shotDuration = Math.max(0.04, Number(state._verifyShotDurationSec) || 0.04);
      const lastFrameDelta = Math.max(0, shotDuration - frameSec);
      _setVerifyPlayUi(true);
      const line = _$('trcVerifyConfidenceLine');
      if (line) {
        line.style.display = '';
        line.textContent = state.syncScrub
          ? 'GANG ON · Trailer Reference and Original Master are playing together at the edit speed'
          : 'GANG OFF · Playing the Trailer Reference only';
      }
      const tick = async () => {
        if (!state._verifyNativePlaying || state._verifyPlaybackToken !== token) return;
        const elapsed = (performance.now() - startWall) / 1000;
        const refDelta = refStartDelta + elapsed;
        if (refDelta >= lastFrameDelta) {
          if (state.loopPlayback) {
            const refTime = Number(state._verifyRefBaseSec || 0);
            const srcTime = Number(state._verifySrcBaseSec || 0);
            await Promise.all([
              ref ? _seekVideo(ref, refTime) : Promise.resolve(),
              src && state.syncScrub ? _seekVideo(src, srcTime) : Promise.resolve(),
            ]).catch(() => {});
            _verifyRedrawFrame();
            _updateVerifyPlayhead(refTime);
            startWall = performance.now();
            refStartDelta = 0;
            if (state._verifyNativePlaying && state._verifyPlaybackToken === token) {
              requestAnimationFrame(() => { tick().catch(() => {}); });
            }
            return;
          }
          const refTime = Number(state._verifyRefBaseSec || 0) + lastFrameDelta;
          const srcTime = Number(state._verifySrcBaseSec || 0) + _verifySourceDelta(lastFrameDelta);
          await Promise.all([
            ref ? _seekVideo(ref, refTime) : Promise.resolve(),
            src && state.syncScrub ? _seekVideo(src, srcTime) : Promise.resolve(),
          ]);
          _verifyRedrawFrame();
          _updateVerifyPlayhead(refTime);
          _stopNativeVerifyPlayback('Playback reached the last frame of this shot.');
          return;
        }
        const refTime = Number(state._verifyRefBaseSec || 0) + refDelta;
        const srcTime = Number(state._verifySrcBaseSec || 0) + _verifySourceDelta(refDelta);
        try {
          await Promise.all([
            ref ? _seekVideo(ref, refTime) : Promise.resolve(),
            src && state.syncScrub ? _seekVideo(src, srcTime) : Promise.resolve(),
          ]);
          _verifyRedrawFrame();
          _updateVerifyPlayhead(refTime);
          if (state._verifyNativePlaying && state._verifyPlaybackToken === token) requestAnimationFrame(() => { tick().catch(() => {}); });
        } catch (err) {
          _stopNativeVerifyPlayback(`Cannot play this ProRes shot: ${err?.message || 'frame decode failed'}`);
        }
      };
      tick().catch(() => {});
      return;
    }
    try {
      if (ref) ref.loop = state.loopPlayback;
      if (src) src.loop = state.loopPlayback;
      if (ref) await ref.play();
      if (src && state.syncScrub) await src.play();
      _setVerifyPlayUi(true);
      _kickVerifyRaf();
    } catch (err) {
      _setVerifyPlayUi(false);
      const line = _$('trcVerifyConfidenceLine');
      if (line) { line.style.display = ''; line.textContent = `Cannot play this shot: ${err?.message || 'video playback failed'}`; }
    }
  }

  function _selectRow(evId) {
    _stopNativeVerifyPlayback();
    state.selectedEvId = evId;
    const panel = _$('trcPanelVerify');
    if (!panel) return;
    _updateVerifyControls();
    _renderMatchResults();

    const ev = state.events.find(e => e.id === evId);
    const labelEl = _$('trcVerifyEventLabel');
    if (labelEl && ev) {
      const reelByProxy = {};
      for (const r of state.reelMap) reelByProxy[r.proxyName] = r;
      const entry = reelByProxy[ev.reel || ev.srcFile || ''];
      const masterName = entry?.masterName ? _stem(entry.masterName) : '—';
      labelEl.textContent = `Event ${evId + 1} · ${ev.recIn} → ${ev.recOut} · Source: ${masterName}`;
    }

    const corr = state.eventCorrections[evId];
    _renderNleInspector(ev, corr);
    const waveOffsetEl = _$('trcWaveOffset');
    if (waveOffsetEl) {
      if (corr) {
        const origF = ev?._srcInFrames ?? _tcToFrames(ev?.srcIn || '00:00:00:00', state.fps);
        const corrF = _tcToFrames(corr.srcIn, state.fps);
        const delta = corrF - origF;
        // delta is a frame COUNT (base arithmetic, above); the seconds beside it
        // are real elapsed time, so they divide by the exact rate. The error here
        // is only ~1 ms on a 24-frame offset — cosmetic, unlike the seeks — but a
        // duration in seconds has exactly one right denominator and it is this one.
        waveOffsetEl.textContent = `${delta === 0 ? '0f' : (delta > 0 ? `+${delta}f` : `${delta}f`)} · ${(delta / (state.fpsExact || state.fps || DEFAULT_FPS)).toFixed(3)}s`;
      } else {
        waveOffsetEl.textContent = '—';
      }
    }

    const offsetFrames = corr
      ? (_tcToFrames(corr.srcIn, state.fps || DEFAULT_FPS) - (ev?._srcInFrames ?? _tcToFrames(ev?.srcIn || '00:00:00:00', state.fps || DEFAULT_FPS)))
      : 0;

    _renderVerifyEvidence(evId);

    _drawWaveformPlaceholder('trcWaveRef', 42, 0.5, '#56d2c6');
    _drawWaveformPlaceholder('trcWaveSrc', 137, Math.max(0.08, Math.min(0.92, 0.5 + (offsetFrames / 120))), '#f6b562');

    _drawVerifyPlaceholder('trcRefCanvas', 'Loading…');
    _drawVerifyPlaceholder('trcSrcCanvas', 'Loading…');

    _loadVerifyFrames(evId).catch(() => {});

    if (_$('trcRoot')?.classList.contains('trc-simple-mode') || window.innerWidth < 1180) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ── Live scrubbable verify playback (Part B) ──────────────────────────
  // Two independent video decode sources, each fronted by the shared
  // pfxTransport bar via attachResolveTransport(). Canvases stay the only
  // visible surface (videos are display:none) so side/wipe/overlay/diff all
  // composite the same way whether paused or scrubbing/playing live.

  function _teardownVerifyVideo(which) {
    const elKey   = which === 'ref' ? '_refVideoEl'      : '_srcVideoEl';
    const urlKey  = which === 'ref' ? '_refVideoUrl'     : '_srcVideoUrl';
    const sessKey = which === 'ref' ? '_refSessionId'    : '_srcSessionId';
    const offKey  = which === 'ref' ? '_refTransportOff' : '_srcTransportOff';
    try { state[offKey]?.(); } catch {}
    state[offKey] = null;
    const video = state[elKey];
    if (video) {
      try { video.pause(); } catch {}
      try { video.removeAttribute('src'); video.load(); } catch {}
    }
    const url = state[urlKey];
    if (url && url.startsWith('blob:')) { try { URL.revokeObjectURL(url); } catch {} }
    state[urlKey] = null;
    const sess = state[sessKey];
    if (sess) { sharedMediaClose(sess).catch(() => {}); }
    state[sessKey] = null;
    state[elKey] = null;
  }

  function _teardownVerifyVideos() {
    _stopNativeVerifyPlayback();
    _stopVerifyRaf();
    _teardownVerifyVideo('ref');
    _teardownVerifyVideo('src');
    state._verifyFileKeys = { ref: null, src: null };
    state._verifyRefBaseSec = null;
    state._verifySrcBaseSec = null;
  }

  function _verifyRedrawFrame() {
    const refVideo = state._refVideoEl;
    const srcVideo = state._srcVideoEl;
    const refCanvasEl = _$('trcRefCanvas');
    const srcCanvasEl = _$('trcSrcCanvas');
    if (refVideo && refCanvasEl && refVideo.readyState >= 2) {
      const ctx = refCanvasEl.getContext('2d');
      ctx.drawImage(refVideo, 0, 0, refCanvasEl.width, refCanvasEl.height);
      state._refImageData = ctx.getImageData(0, 0, refCanvasEl.width, refCanvasEl.height);
    }
    if (srcVideo && srcCanvasEl && srcVideo.readyState >= 2) {
      const ctx = srcCanvasEl.getContext('2d');
      ctx.drawImage(srcVideo, 0, 0, srcCanvasEl.width, srcCanvasEl.height);
      state._srcImageData = ctx.getImageData(0, 0, srcCanvasEl.width, srcCanvasEl.height);
    }
    _applyVerifyMode(state.verifyMode);
  }

  function _verifyRafTick() {
    _verifyRedrawFrame();
    _updateVerifyPlayhead();
    const refVideo = state._refVideoEl;
    const srcVideo = state._srcVideoEl;
    const live = (refVideo && !refVideo.paused && !refVideo.ended) || (srcVideo && !srcVideo.paused && !srcVideo.ended);
    state._verifyRafId = live ? requestAnimationFrame(_verifyRafTick) : null;
  }

  function _kickVerifyRaf() {
    if (state._verifyRafId != null) return;
    state._verifyRafId = requestAnimationFrame(_verifyRafTick);
  }

  function _stopVerifyRaf() {
    if (state._verifyRafId != null) { cancelAnimationFrame(state._verifyRafId); state._verifyRafId = null; }
  }

  // Loads (or reuses) the decode <video> for one side, mounts its transport
  // bar, and seeks it to seekSec. Returns the live <video> element.
  async function _prepareVerifyVideo(which, file, seekSec) {
    const isRef      = which === 'ref';
    const videoId     = isRef ? 'trcRefVideo'      : 'trcSrcVideo';
    const panelId      = isRef ? 'trcRefFramePanel'  : 'trcSrcFramePanel';
    const baseKey       = isRef ? '_verifyRefBaseSec' : '_verifySrcBaseSec';
    const elKey          = isRef ? '_refVideoEl'        : '_srcVideoEl';
    const urlKey          = isRef ? '_refVideoUrl'       : '_srcVideoUrl';
    const sessKey          = isRef ? '_refSessionId'      : '_srcSessionId';
    const offKey            = isRef ? '_refTransportOff'   : '_srcTransportOff';
    const transportName      = isRef ? 'trlconfRef'          : 'trlconfSrc';

    const reused = state._verifyFileKeys[which] === file && state[elKey];
    if (!reused) {
      _teardownVerifyVideo(which);
      const loaded = await _loadVideo(file);
      const newVideo = loaded.video;
      newVideo.id = videoId;
      newVideo.className = 'trc-frame-video';
      newVideo.style.display = 'none';
      newVideo.muted = true;
      newVideo.playsInline = true;

      const panelEl = _$(panelId);
      const oldVideo = _$(videoId);
      if (panelEl && oldVideo && oldVideo !== newVideo) panelEl.replaceChild(newVideo, oldVideo);
      else if (panelEl && !oldVideo) panelEl.appendChild(newVideo);

      state[elKey]     = newVideo;
      state[urlKey]    = loaded.url || null;
      state[sessKey]   = loaded.sessionId || null;
      state._verifyFileKeys[which] = file;

      state[offKey] = attachResolveTransport(newVideo, {
        name: transportName,
        fps: () => state.fps || DEFAULT_FPS,
      });

      newVideo.addEventListener('play', () => {
        _kickVerifyRaf();
        if (isRef && state.syncScrub && state._srcVideoEl && state._srcVideoEl.paused) {
          try { state._srcVideoEl.playbackRate = newVideo.playbackRate; state._srcVideoEl.play(); } catch {}
        }
      });
      newVideo.addEventListener('pause', () => {
        if (isRef && state.syncScrub && state._srcVideoEl && !state._srcVideoEl.paused) {
          try { state._srcVideoEl.pause(); } catch {}
        }
      });
      newVideo.addEventListener('seeked', _verifyRedrawFrame);
      if (isRef) {
        // Sync scrub: mirror ref's position onto src, offset-locked to the
        // gap between their respective in-points captured at load time.
        newVideo.addEventListener('timeupdate', () => {
          if (!state.syncScrub) return;
          const srcVideo = state._srcVideoEl;
          if (!srcVideo || state._verifyRefBaseSec == null || state._verifySrcBaseSec == null) return;
          const delta = newVideo.currentTime - state._verifyRefBaseSec;
          const target = state._verifySrcBaseSec + delta;
          if (Number.isFinite(target) && Math.abs(srcVideo.currentTime - target) > 0.05) {
            srcVideo.currentTime = Math.max(0, target);
          }
        });
      }
    }

    await _seekVideo(state[elKey], Math.max(0, seekSec));
    state[baseKey] = state[elKey].currentTime;
    return state[elKey];
  }

  // ── Load verify frames ────────────────────────────────────────────────

  async function _loadVerifyFrames(evId) {
    const ev = state.events.find(e => e.id === evId);
    if (!ev) return;

    const fps = state.fps || DEFAULT_FPS;
    // Timecode arithmetic below stays on the base; the three conversions that
    // reach real media time — the two seek positions and the waveform lag —
    // use the exact rate. This panel is what an assistant looks at to decide a
    // match is right, so a 3.6 s error here is not a display bug: it is the
    // wrong frame presented as proof.
    const fpsExact = state.fpsExact || fps;
    const visibleEvents = state.events.filter(e => !e.disabled && e.type === 'video');
    const seqBaseFrames = referenceBaseFrames(visibleEvents, fps, _tcToFrames);
    const recInF = ev._recInFrames ?? _tcToFrames(ev.recIn, fps);
    const unmrefSec = (recInF - seqBaseFrames) / fpsExact;

    const refCanvasEl = _$('trcRefCanvas');
    const srcCanvasEl = _$('trcSrcCanvas');

    // Draw reference frame
    if (state.refFile && refCanvasEl) {
      try {
        const refVid = await _prepareVerifyVideo('ref', state.refFile, Math.max(0, unmrefSec));
        const ctx = refCanvasEl.getContext('2d');
        ctx.drawImage(refVid, 0, 0, refCanvasEl.width, refCanvasEl.height);
        state._refImageData = ctx.getImageData(0, 0, refCanvasEl.width, refCanvasEl.height);
      } catch {
        _drawVerifyPlaceholder('trcRefCanvas', 'Frame not available');
        state._refImageData = null;
      }
    } else if (refCanvasEl) {
      _drawVerifyPlaceholder('trcRefCanvas', 'No reference loaded');
    }

    // Draw source frame
    const reelByProxy = {};
    for (const r of state.reelMap) reelByProxy[r.proxyName] = r;
    const entry = reelByProxy[ev.reel || ev.srcFile || ''];
    const masterFile = entry?.masterFile;

    let capturedSrcSec = 0;
    if (masterFile && srcCanvasEl) {
      try {
        const corr = state.eventCorrections[evId];
        const corrSrcIn = corr ? corr.srcIn : ev.srcIn;
        const corrSrcInF = _tcToFrames(corrSrcIn, fps);
        // For matched events corr.srcIn is already file-time (0-based).
        // For unmatched events ev.srcIn is tape TC; subtract the reel's tcOffset
        // (populated from ffprobe startTimecode) to get file-time seek position.
        const tcOffsetF = corr ? 0 : (entry?.tcOffset || 0);
        const srcSec = Math.max(0, (corrSrcInF - tcOffsetF) / fpsExact);
        capturedSrcSec = srcSec;
        const video = await _prepareVerifyVideo('src', masterFile, srcSec);
        const ctx = srcCanvasEl.getContext('2d');
        ctx.drawImage(video, 0, 0, srcCanvasEl.width, srcCanvasEl.height);
        state._srcImageData = ctx.getImageData(0, 0, srcCanvasEl.width, srcCanvasEl.height);
        state._verifyEvId = evId;
      } catch {
        _drawVerifyPlaceholder('trcSrcCanvas', 'Frame not available');
        state._srcImageData = null;
      }
    } else if (srcCanvasEl) {
      _drawVerifyPlaceholder('trcSrcCanvas', 'No source matched');
    }

    // Apply composite mode if not side-by-side
    if (state.verifyMode !== 'side' && state._refImageData && state._srcImageData) {
      _applyVerifyMode(state.verifyMode);
    }

    // Capture video luma waveforms by sampling average frame brightness across a 2.5 s window.
    // Uses _loadVideo so desktop ProRes source files decode directly through AVFoundation.
    // For correctly matched events REF and SRC will produce identical brightness patterns.
    // Runs async so frames appear immediately; waveforms update ~2–4 s later.
    const _corr = state.eventCorrections[evId];
    const offsetFrames = _corr
      ? (_tcToFrames(_corr.srcIn, fps) - (ev._srcInFrames ?? _tcToFrames(ev.srcIn || '00:00:00:00', fps)))
      : 0;
    const waveMarker = Math.max(0.08, Math.min(0.92, 0.5 + (offsetFrames / 120)));
    // Waveform windows start AT the in-point and run forward 2.5 s.
    // Starting before the in-point would show the previous shot in the ref (different content),
    // making ref/src waveforms impossible to compare even for a correct match.
    const refAudioStart = Math.max(0, unmrefSec);
    const srcAudioStart = Math.max(0, capturedSrcSec);
    ;(async () => {
      const [refEnv, srcEnv] = await Promise.all([
        state.refFile ? _captureVideoEnvelope(state.refFile, refAudioStart) : Promise.resolve(null),
        masterFile    ? _captureVideoEnvelope(masterFile,    srcAudioStart) : Promise.resolve(null),
      ]);

      // Cross-correlate the two envelopes to find the best alignment lag and
      // shift the src waveform so a correct match displays as overlapping shapes.
      let alignedSrc = srcEnv;
      if (refEnv && srcEnv) {
        const sync = _envelopeSync(refEnv, srcEnv, 5);
        alignedSrc = _shiftEnvelope(srcEnv, sync.lag);
        const waveEl = _$('trcWaveOffset');
        if (waveEl) {
          const secPerSample = 2.5 / Math.max(1, refEnv.length - 1);
          const lagFrames    = Math.round(sync.lag * secPerSample * fpsExact);
          const pct          = Math.round(sync.corr * 100);
          const sign         = lagFrames > 0 ? '+' : '';
          waveEl.textContent = `${sign}${lagFrames}f · ${pct}% sync`;
        }
      }

      _drawWaveformReal('trcWaveRef', refEnv,     '#56d2c6', 0.02);
      _drawWaveformReal('trcWaveSrc', alignedSrc, '#f6b562', 0.02);
    })().catch(() => {});
  }

  // ── Apply verify mode ─────────────────────────────────────────────────

  function _applyVerifyMode(mode) {
    const refEl = _$('trcRefCanvas');
    const srcEl = _$('trcSrcCanvas');
    if (!refEl || !srcEl) return;

    const W = srcEl.width;
    const H = srcEl.height;

    if (mode === 'side') {
      // Restore both from stored image data
      if (state._refImageData) {
        const rCtx = refEl.getContext('2d');
        rCtx.putImageData(state._refImageData, 0, 0);
      }
      if (state._srcImageData) {
        const sCtx = srcEl.getContext('2d');
        sCtx.putImageData(state._srcImageData, 0, 0);
      }
      return;
    }

    if (!state._refImageData || !state._srcImageData) return;

    const sCtx = srcEl.getContext('2d');

    if (mode === 'wipe') {
      sCtx.putImageData(state._refImageData, 0, 0);
      // Draw src on right half
      const half = Math.floor(W / 2);
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = W; tempCanvas.height = H;
      const tCtx = tempCanvas.getContext('2d');
      tCtx.putImageData(state._srcImageData, 0, 0);
      sCtx.drawImage(tempCanvas, half, 0, W - half, H, half, 0, W - half, H);
      // Divider line
      sCtx.strokeStyle = 'rgba(255,255,255,0.8)';
      sCtx.lineWidth = 1;
      sCtx.beginPath(); sCtx.moveTo(half, 0); sCtx.lineTo(half, H); sCtx.stroke();
      return;
    }

    if (mode === 'overlay') {
      sCtx.putImageData(state._refImageData, 0, 0);
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = W; tempCanvas.height = H;
      const tCtx = tempCanvas.getContext('2d');
      tCtx.putImageData(state._srcImageData, 0, 0);
      sCtx.globalAlpha = 0.5;
      sCtx.drawImage(tempCanvas, 0, 0);
      sCtx.globalAlpha = 1.0;
      return;
    }

    if (mode === 'diff') {
      const refD = state._refImageData.data;
      const srcD = state._srcImageData.data;
      const out  = sCtx.createImageData(W, H);
      for (let i = 0; i < refD.length; i += 4) {
        out.data[i]     = Math.abs(refD[i]     - srcD[i]);
        out.data[i + 1] = Math.abs(refD[i + 1] - srcD[i + 1]);
        out.data[i + 2] = Math.abs(refD[i + 2] - srcD[i + 2]);
        out.data[i + 3] = 255;
      }
      sCtx.putImageData(out, 0, 0);
      return;
    }
  }

  // ── Draw placeholders ─────────────────────────────────────────────────

  function _drawVerifyPlaceholder(canvasId, text) {
    const canvas = _$(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font = '13px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }

  function _drawWaveformPlaceholder(canvasId, seed, marker = 0.5, stroke = 'rgba(64,220,200,0.65)') {
    const canvas = _$(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const phase = (seed % 100) / 100 * Math.PI * 2;
    for (let x = 0; x < W; x++) {
      const t = x / W;
      const y = H / 2 + Math.sin(t * Math.PI * 12 + phase) * (H * 0.28)
              + Math.sin(t * Math.PI * 27 + phase * 1.3) * (H * 0.12);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
    const mx = Math.round(W * marker);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mx, 0);
    ctx.lineTo(mx, H);
    ctx.stroke();
  }

  // Capture a luma (brightness) envelope from video frames over [startSec, startSec+durationSec].
  // Samples NUM_LUMA_SAMPLES frames evenly across the window, computes average luma per frame,
  // and returns a normalized envelope. For correctly matched events REF and SRC will produce
  // visually identical shapes regardless of audio track differences.
  // Uses _loadVideo so desktop ProRes source files are handled directly by AVFoundation.
  const _NUM_LUMA_SAMPLES = 14;
  const _LUMA_W = 32;
  const _LUMA_H = 18;

  async function _captureVideoEnvelope(file, startSec, durationSec = 2.5) {
    if (!file) return null;
    const envKey = `env|${_fpFileKey(file)}|${Math.round(startSec * 1000)}|${durationSec}`;
    const cachedEnv = await _fpCacheGet(envKey);
    if (cachedEnv) return cachedEnv;
    try {
      const { video } = await _loadVideo(file);
      const dur = video.duration || 9999;

      const canvas = document.createElement('canvas');
      canvas.width  = _LUMA_W;
      canvas.height = _LUMA_H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      const envelope = [];
      for (let i = 0; i < _NUM_LUMA_SAMPLES; i++) {
        const t = startSec + (i / (_NUM_LUMA_SAMPLES - 1)) * durationSec;
        try {
          await _seekVideo(video, Math.max(0, Math.min(t, dur - 0.001)));
          ctx.drawImage(video, 0, 0, _LUMA_W, _LUMA_H);
          const { data } = ctx.getImageData(0, 0, _LUMA_W, _LUMA_H);
          let sum = 0;
          for (let j = 0; j < data.length; j += 4) {
            // ITU-R BT.601 luma
            sum += 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2];
          }
          envelope.push(sum / (_LUMA_W * _LUMA_H * 255));
        } catch {
          envelope.push(envelope.length ? envelope[envelope.length - 1] : 0);
        }
      }

      const rawMax = Math.max(...envelope);
      const rawMin = Math.min(...envelope);
      const range  = rawMax - rawMin;
      // No meaningful variation = blank/solid frames, fall back to placeholder
      if (range < 0.01) return null;
      const normalized = envelope.map(v => (v - rawMin) / range);
      _fpCachePut(envKey, normalized);
      return normalized;
    } catch {
      return null;
    }
  }

  // Pearson cross-correlation between two normalized luma envelopes.
  // Scans lag offsets -maxLag..+maxLag (in samples) and returns the lag with the
  // highest correlation coefficient plus the coefficient itself (0..1).
  function _envelopeSync(refEnv, srcEnv, maxLag = 5) {
    const n = refEnv.length;
    let bestLag = 0, bestCorr = -Infinity;
    for (let lag = -maxLag; lag <= maxLag; lag++) {
      const a = [], b = [];
      for (let i = 0; i < n; i++) {
        const j = i + lag;
        if (j >= 0 && j < n) { a.push(refEnv[i]); b.push(srcEnv[j]); }
      }
      if (a.length < 4) continue;
      const ma = a.reduce((s, v) => s + v, 0) / a.length;
      const mb = b.reduce((s, v) => s + v, 0) / b.length;
      let num = 0, da = 0, db = 0;
      for (let i = 0; i < a.length; i++) {
        num += (a[i] - ma) * (b[i] - mb);
        da  += (a[i] - ma) ** 2;
        db  += (b[i] - mb) ** 2;
      }
      const denom = Math.sqrt(da * db);
      const r = denom < 1e-9 ? 0 : num / denom;
      if (r > bestCorr) { bestCorr = r; bestLag = lag; }
    }
    return { lag: bestLag, corr: Math.max(0, bestCorr) };
  }

  // Shift envelope by `lag` samples (positive = shift right). Edge-extends at boundaries.
  function _shiftEnvelope(env, lag) {
    if (!lag || !env) return env;
    const n = env.length;
    return Array.from({ length: n }, (_, i) => {
      const j = i + lag;
      if (j < 0)  return env[0];
      if (j >= n) return env[n - 1];
      return env[j];
    });
  }

  // Draw a video luma envelope waveform. Falls back to placeholder if null.
  // Luma values are [0..1] normalized — drawn center-mirrored so the shape reads like
  // a traditional waveform (bright frames = tall, dark frames = narrow).
  function _drawWaveformReal(canvasId, envelope, stroke, marker = 0.5) {
    if (!envelope || !envelope.length) {
      _drawWaveformPlaceholder(canvasId, Math.floor(Math.random() * 200), marker, stroke);
      return;
    }
    const canvas = _$(canvasId);
    if (!canvas) return;
    const ctx  = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, W, H);

    const bins = envelope.length;

    // Smooth the envelope by interpolating between sample points
    function sampleAt(x) {
      const pos = (x / W) * (bins - 1);
      const lo  = Math.floor(pos);
      const hi  = Math.min(lo + 1, bins - 1);
      const t   = pos - lo;
      return (envelope[lo] ?? 0) * (1 - t) + (envelope[hi] ?? 0) * t;
    }

    // Filled silhouette — center-mirrored so waveform reads symmetrically
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const amp = sampleAt(x);
      const y   = H / 2 - amp * (H * 0.44);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    for (let x = W - 1; x >= 0; x--) {
      const amp = sampleAt(x);
      ctx.lineTo(x, H / 2 + amp * (H * 0.44));
    }
    ctx.closePath();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle   = stroke;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Top outline only (bottom is mirrored so redundant)
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const y = H / 2 - sampleAt(x) * (H * 0.44);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.strokeStyle = stroke;
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    // Bottom outline
    ctx.beginPath();
    for (let x = 0; x < W; x++) {
      const y = H / 2 + sampleAt(x) * (H * 0.44);
      x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Marker line
    const mx = Math.round(W * marker);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(mx, 0);
    ctx.lineTo(mx, H);
    ctx.stroke();
  }

  // ── Set match phase active ────────────────────────────────────────────

  function _setMatchPhaseActive(stepIdx) {
    for (let i = 0; i <= 6; i++) {
      const el = _$(`trcPhStep${i}`);
      if (el) el.classList.toggle('trc-phase-active', i === stepIdx);
    }
  }

  // ── Run conform (parse + reel map + render) ───────────────────────────

  async function _runConform() {
    const progWrap = _$('trcProgressWrap');
    const progBar  = _$('trcProgressBar');
    const progPct  = _$('trcProgressPct');
    const progCur  = _$('trcProgressCurrent');

    if (progWrap) progWrap.style.display = '';
    if (progBar)  progBar.value = 0;
    if (progPct)  progPct.textContent = '0%';

    _setMatchPhaseActive(0);

    try {
      if (progCur) progCur.textContent = 'Parsing timeline…';
      const result = await _parseTimeline(state.timelineFile);
      state.events      = result.events || [];
      state.fps         = result.fps    || DEFAULT_FPS;
      // Falls back to the base when a producer predates the two-rate contract,
      // which is exactly the behaviour this file had before it was threaded.
      state.fpsExact    = result.fpsExact || state.fps;
      state.projectName = result.projectName || _stem(state.timelineFile.name);

      if (!state.events.length) throw new Error('No video events found in timeline');

      // Update XML info card
      const extMatch = state.timelineFile.name.match(/\.(\w+)$/i);
      const fmt = extMatch ? extMatch[1].toUpperCase() : 'UNKNOWN';
      const visCount = _getVisibleEvents().length;
      const preservedCount = _getPreservedEvents().length;
      _showCutInfo(state.timelineFile.name, fmt, preservedCount ? `${visCount} shots · ${preservedCount} overlays` : visCount, state.projectName, state.fps);

      if (progBar) progBar.value = 20;
      if (progPct) progPct.textContent = '20%';

      if (progCur) progCur.textContent = 'Building reel map…';
      state.reelMap          = _buildReelMap(state.events, state.masterFiles);
      _applyTcOffsets(state.reelMap, state.fileTcOffsets);
      // Only wipe corrections if this is a fresh parse (no approved results yet)
      const hasApprovals = Object.values(state.matchResults).some(m => m?.approved);
      if (!hasApprovals) {
        state.eventCorrections = {};
        state.matchResults     = {};
      }
      state.analyzed         = true;
      state.matchHasRun      = false;
      state.selectedEvId     = null;

      try { window.MPS_markProjectDirty?.('trl conf'); } catch {}

      if (progBar) progBar.value = 40;
      if (progPct) progPct.textContent = '40%';
      if (progCur) progCur.textContent = 'Rendering results…';

      _renderMatchResults();
      _updateStatusBadges();
      _updateMatchBtns();
      _updateExportBtns();

      if (progBar) progBar.value = 100;
      if (progPct) progPct.textContent = '100%';
      if (progCur) progCur.textContent = 'Done';
      _setMatchPhaseActive(6);

    } catch (err) {
      if (progCur) progCur.textContent = `Error: ${err.message}`;
      if (progWrap) progWrap.style.display = 'none';
      _setMatchPhaseActive(-1);
      console.error('[TrlConform] _runConform error', err);
      throw err;
    }
  }

  // Show info block in cut card
  function _showCutInfo(filename, fmt, events, timeline, fps) {
    const inner = _$('trcDropCutInner');
    const info  = _$('trcCutInfo');
    if (inner) inner.style.display = 'none';
    if (info)  info.style.display  = '';
    const el = (id, v) => { const e = _$(id); if (e) e.textContent = v; };
    el('trcCutInfoFile',     filename);
    el('trcCutInfoFmt',      fmt);
    el('trcCutInfoEvents',   String(events));
    el('trcCutInfoTimeline', timeline || '—');
    el('trcCutInfoFps',      String(fps));
  }

  // ── Visual match ──────────────────────────────────────────────────────

  async function _runVisualMatch() {
    if (state.visualMatchRunning || !state.refFile || !state.analyzed) return;

    const stopBtn     = _$('trcBtnStop');
    const resetBtn    = _$('trcBtnResetMatch');
    const runBtn      = _$('trcBtnRunMatch');
    const progWrap    = _$('trcProgressWrap');
    const progBar     = _$('trcProgressBar');
    const progPct     = _$('trcProgressPct');
    const progCur     = _$('trcProgressCurrent');

    state.visualMatchRunning = true;
    state.visualMatchCancel  = false;
    state.matchHasRun        = false;
    state.reviewHistory      = [];
    _updateUndoUi();
    _updateMediaPoolUI();

    if (runBtn)   runBtn.disabled = true;
    if (stopBtn)  stopBtn.style.display = '';
    if (resetBtn) resetBtn.style.display = 'none';
    if (progWrap) progWrap.style.display = '';
    if (progBar)  progBar.value = 0;
    if (progPct)  progPct.textContent = '0%';
    if (progCur)  progCur.textContent = 'Initializing…';

    _setMatchPhaseActive(1);

    const useAI  = state.aiMode && aiReady();
    const canvas = document.createElement('canvas');
    canvas.width  = useAI ? AI_W : _HASH_W;
    canvas.height = useAI ? AI_H : _HASH_H;
    const ctx     = useAI ? null : canvas.getContext('2d', { willReadFrequently: true });

    // dHash canvas: 9×8 (one pixel wider than hash output for horizontal comparison).
    const dhCanvas = document.createElement('canvas');
    dhCanvas.width  = _DHASH_W + 1;
    dhCanvas.height = _DHASH_H;
    const dhCtx    = useAI ? null : dhCanvas.getContext('2d', { willReadFrequently: true });

    let refUrl = null;

    try {
      if (progCur) progCur.textContent = `Loading reference: ${state.refFile.name}…`;
      const refData = await _loadVideo(state.refFile, {
        onProgress: pct => { if (progCur) progCur.textContent = `Opening ProRes: ${state.refFile.name} — ${pct}%`; },
      });
      refUrl = refData.url;
      const refVideo    = refData.video;
      const refDuration = refData.duration;

      _setMatchPhaseActive(1);
      if (progBar) progBar.value = 10;
      if (progPct) progPct.textContent = '10%';
      if (progCur) progCur.textContent = 'Sampling reference frames…';

      const visibleEvents = _getVisibleEvents();
      const seqBaseFrames = referenceBaseFrames(visibleEvents, state.fps, _tcToFrames);
      let lastEvErr = null;

      const reelByProxy = {};
      for (const r of state.reelMap) reelByProxy[r.proxyName] = r;

      const matchedEvents = visibleEvents.filter(e => {
        const entry = reelByProxy[e.reel || e.srcFile || ''];
        return entry?.status === 'matched' && entry.masterFile;
      });

      if (!matchedEvents.length) throw new Error('No matched episode events to process');

      _setMatchPhaseActive(2);
      if (progBar) progBar.value = 18;
      if (progPct) progPct.textContent = '18%';
      if (progCur) progCur.textContent = 'Reading reference audio…';

      _setMatchPhaseActive(3);

      const masterGroups = new Map();
      for (const ev of matchedEvents) {
        const entry = reelByProxy[ev.reel || ev.srcFile || ''];
        if (!masterGroups.has(entry.masterName)) {
          masterGroups.set(entry.masterName, { file: entry.masterFile, tcOffset: entry.tcOffset || 0, events: [] });
        }
        masterGroups.get(entry.masterName).events.push(ev);
      }

      const totalEvents = matchedEvents.length;
      let doneCount = 0;
      const matchStartTs = Date.now();
      const progEta = _$('trcProgressEta');
      if (progEta) progEta.textContent = '';

      for (const [masterName, group] of masterGroups) {
        if (state.visualMatchCancel) break;
        if (progCur) progCur.textContent = `Loading ${_stem(masterName)}…`;
        _setMatchPhaseActive(4);

        let masterVideo = null, masterUrl2 = null;
        try {
          const mv = await _loadVideo(group.file, {
            onProgress: pct => { if (progCur) progCur.textContent = `Opening ProRes: ${_stem(masterName)} — ${pct}%`; },
          });
          masterVideo = mv.video;
          masterUrl2  = mv.url;
        } catch (loadErr) {
          console.warn('[TrlConform] Cannot load master', masterName, loadErr);
          doneCount += group.events.length;
          continue;
        }

        for (const ev of group.events) {
          if (state.visualMatchCancel) break;

          doneCount++;
          const pct = 10 + Math.round((doneCount / totalEvents) * 80);
          if (progBar) progBar.value = pct;
          if (progPct) progPct.textContent = `${pct}%`;
          if (progCur) {
            progCur.textContent = `Event ${doneCount}/${totalEvents} — ${_stem(ev.reel || ev.srcFile || '')} @ ${ev.recIn}`;
          }
          // Rough ETA (#3) — derived from elapsed time / events done so far, no
          // new instrumentation needed. Wait until a few events have finished so
          // the very first (often slowest, cold-cache) event doesn't skew it.
          if (progEta && doneCount >= 3) {
            const elapsedMs   = Date.now() - matchStartTs;
            const avgMsPerEv  = elapsedMs / doneCount;
            const remainingMs = avgMsPerEv * (totalEvents - doneCount);
            progEta.textContent = _formatEtaRemaining(remainingMs);
          }

          try {
            const recInF    = ev._recInFrames || _tcToFrames(ev.recIn, state.fps);
            // recInF is a frame COUNT off the timecode base; unmrefSec is where we
            // physically seek the reference, so it divides by the exact rate. The
            // guard underneath makes the difference load-bearing rather than
            // merely inaccurate: on NTSC the base overshoots by 3.6 s at the hour
            // mark, so an event near the tail of a long reference trips
            // `>= refDuration - 0.1`, logs to a console nobody has open, and is
            // dropped from the conform with no row and no error.
            const unmrefSec = (recInF - seqBaseFrames) / (state.fpsExact || state.fps);

            if (unmrefSec < 0 || unmrefSec >= refDuration - 0.1) {
              console.warn('[TrlConform] Reference position out of range', unmrefSec, refDuration);
              continue;
            }

            _setMatchPhaseActive(5);
            const result = await _matchEventByVisualWave({
              ev,
              refVideo,
              masterVideo,
              canvas,
              ctx,
              dhCanvas,
              dhCtx,
              fps: state.fps,
              fpsExact: state.fpsExact || state.fps,
              seqBaseFrames,
              useAI,
              masterFileKey: group.file ? _fpFileKey(group.file) : '',
              tcOffset: group.tcOffset || 0,
              shouldCancel: () => state.visualMatchCancel,
            });

            // ── Luma-envelope audio similarity ────────────────────────────
            // Capture a 2.5 s brightness envelope from ref and master at the
            // matched position, cross-correlate, and blend into finalConfidence.
            // Fills the 0.15 audio slot from the spec: 0.85·visual + 0.15·audio.
            let audioConfidence = null;
            let finalConfidence = result.visualConfidence;
            try {
              // Two rates in one expression, deliberately: _tcToFrames reads a
              // timecode string so it takes the base, and the result is then a
              // seek position for _captureVideoEnvelope, so it leaves on the
              // exact rate. Writing `/ state.fps` twice was the tell that one
              // number was being asked to do both jobs.
              const corrSrcSec = _tcToFrames(result.srcIn, state.fps) / (state.fpsExact || state.fps);
              const [refEnv, srcEnv] = await Promise.all([
                state.refFile ? _captureVideoEnvelope(state.refFile, unmrefSec) : Promise.resolve(null),
                group.file    ? _captureVideoEnvelope(group.file, corrSrcSec)  : Promise.resolve(null),
              ]);
              if (refEnv && srcEnv) {
                const sync = _envelopeSync(refEnv, srcEnv, 5);
                audioConfidence = Math.round(sync.corr * 100);
                finalConfidence = Math.max(0, Math.min(100,
                  Math.round(0.85 * result.visualConfidence + 0.15 * audioConfidence)
                ));
              }
            } catch {}

            state.eventCorrections[ev.id] = {
              ...result,
              audioConfidence,
              finalConfidence,
              masterName,
              masterFileName: group.file?.name || masterName,
              matchedSourceFile: group.file?.name || masterName,
              matchedSourcePath: group.file?._nativePath || group.file?.webkitRelativePath || group.file?.name || masterName,
            };

            // matchResults stores operator decisions only. Solver status lives in
            // eventCorrections so a later whole-library winner cannot remain
            // falsely pinned to an earlier FAIL result.
            if (!state.matchResults[ev.id]) {
              state.matchResults[ev.id] = { status: null, approved: false, notes: '' };
            }

          } catch (evErr) {
            console.warn('[TrlConform] Visual match failed for event', ev.id, evErr.message);
            lastEvErr = evErr;
          }

          try { _renderMatchResults(); } catch {}
        }

        if (masterUrl2) URL.revokeObjectURL(masterUrl2);
      }

      // ── Multi-master fallback (V1.4 whole-library search) ─────────────────
      // Events still weak/FAIL against their episode-pinned master may actually
      // come from a DIFFERENT episode (mis-pinned/undecodable clip name, or a
      // shot reused across episodes). Search the rest of the library for those
      // and adopt a clearly-better master. Strong matches are left untouched.
      if (!state.visualMatchCancel && state.multiMasterFallback !== false) {
        try {
          await _multiMasterFallback({
            refVideo, canvas, ctx, dhCanvas, dhCtx, seqBaseFrames, useAI, progCur, progBar, progPct,
          });
        } catch (mmErr) {
          console.warn('[TrlConform] multi-master fallback error', mmErr);
        }
      }

      // ── Auto AI-embedding fallback (activates the otherwise-dormant matcher) ──
      // Shots still weak after hash + multi-master search get one more pass with
      // the CLIP-style embedding matcher, which is robust to reframe/recolor/crop.
      // Fully guarded + adopt-only-if-better: any failure is a silent no-op.
      if (!state.visualMatchCancel && state.aiAutoFallback !== false) {
        try {
          await _aiEscalateWeak({ refVideo, seqBaseFrames, progCur });
        } catch (aiErr) {
          console.warn('[TrlConform] AI escalation error', aiErr);
        }
      }

      if (refUrl) { URL.revokeObjectURL(refUrl); refUrl = null; }

      _setMatchPhaseActive(6);
      state.matchHasRun = Object.keys(state.eventCorrections).length > 0 || !state.visualMatchCancel;
      if (progEta) progEta.textContent = '';
      state.lastMatchedAt = Date.now();
      _idbSaveLastMatchedAt(state.lastMatchedAt).catch(() => {});

      // Compute per-reel median slip and apply to events that lack a strong per-event match
      let slipMap = {};
      if (!state.visualMatchCancel) {
        if (progCur) progCur.textContent = 'Computing reel slips…';
        slipMap = _computeReelSlips(state.events, state.eventCorrections, state.fps || DEFAULT_FPS);
        _applyReelSlips(slipMap, state.events, state.eventCorrections, state.reelMap, state.fps || DEFAULT_FPS);
      }

      if (progBar) progBar.value = 100;
      if (progPct) progPct.textContent = '100%';
      const corrCount = Object.keys(state.eventCorrections).length;
      if (progCur) {
        progCur.textContent = state.visualMatchCancel
          ? `Cancelled — ${corrCount} events corrected`
          : corrCount === 0 && totalEvents > 0
            ? `Complete — 0/${totalEvents} matched. Every event failed: ${lastEvErr?.message || 'unknown error'} (see console for details)`
            : `Complete — ${corrCount}/${totalEvents} events analyzed · ${Object.keys(slipMap).length} reel slip(s) applied`;
      }

      _renderSlipSummary(slipMap);
      _renderMatchResults();
      _renderExportSummary();
      _updateStatusBadges();
      _updateExportBtns();
      if (resetBtn) resetBtn.style.display = '';

    } catch (err) {
      if (refUrl) URL.revokeObjectURL(refUrl);
      if (progCur) progCur.textContent = `Error: ${err.message}`;
      if (progWrap) progWrap.style.display = 'none';
      console.error('[TrlConform] Visual match error', err);
    } finally {
      state.visualMatchRunning = false;
      if (runBtn)  runBtn.disabled = false;
      if (stopBtn) stopBtn.style.display = 'none';
      _updateMatchBtns();
      _renderMatchResults();
      _updateMediaPoolUI();
      _updateGuidedFlow();
    }
  }

  // ── Multi-master library search (V1.4 search_library port) ─────────────────
  // For events whose pinned-master match stayed weak/FAIL, search every OTHER
  // master file and adopt one only if it beats the pinned result by a margin
  // (multiMaster.resolveMaster). Proxies are loaded once and cached across the
  // pass. Fully additive: strong events are skipped; nothing is downgraded.
  // Events at or below this final confidence are eligible for an AI recheck.
  const AI_ESCALATE_MAX_CONF = 60;

  // Auto AI-embedding fallback. Activates the CLIP-style matcher (dormant unless a
  // user opted into AI mode) for shots that stayed weak after hash + multi-master
  // search. The embedding model is loaded on demand and cached (TF.js/IndexedDB).
  // Adopts an AI result ONLY when it strictly beats the existing confidence, so it
  // can never downgrade a match. Any error (model load, decode) is a silent no-op.
  async function _aiEscalateWeak({ refVideo, seqBaseFrames, progCur }) {
    const fps = state.fps || DEFAULT_FPS;
    const masters = state.masterFiles || [];
    if (!masters.length) return;

    const weak = _getVisibleEvents().filter(ev => {
      const c = state.eventCorrections[ev.id];
      const conf = c ? (c.finalConfidence ?? c.confidence ?? 0) : 0;
      return conf <= AI_ESCALATE_MAX_CONF;
    });
    if (!weak.length) return;

    // Load the embedding model on demand. Failure → keep hash-based results.
    if (!aiReady()) {
      try {
        state.aiModelLoading = true;
        if (progCur) progCur.textContent = 'Loading AI model for weak shots…';
        await loadModel();
      } catch (e) {
        console.warn('[TrlConform] AI model load failed; skipping AI fallback', e);
        return;
      } finally {
        state.aiModelLoading = false;
      }
    }
    if (!aiReady()) return;

    // The embedding matcher needs its own input-sized canvas (no 2D context).
    const aiCanvas = document.createElement('canvas');
    aiCanvas.width = AI_W;
    aiCanvas.height = AI_H;

    const proxyCache = new Map();
    const findMaster = (name) => masters.find(f => f.name === name);
    let idx = 0;
    try {
      for (const ev of weak) {
        if (state.visualMatchCancel) break;
        idx++;
        const cur = state.eventCorrections[ev.id];
        const masterName = cur?.masterFileName || cur?.masterName;
        const file = masterName ? findMaster(masterName) : null;
        if (!file) continue;
        if (progCur) progCur.textContent = `AI recheck ${idx}/${weak.length} — ${_stem(ev.reel || ev.srcFile || '')}`;

        let mv = proxyCache.get(file.name);
        if (!mv) {
          try { mv = await _loadVideo(file); proxyCache.set(file.name, mv); } catch { continue; }
        }

        try {
          const aiResult = await _matchEventByVisualWave({
            ev, refVideo, masterVideo: mv.video, canvas: aiCanvas, ctx: null,
            dhCanvas: null, dhCtx: null, fps, seqBaseFrames, useAI: true,
            masterFileKey: _fpFileKey(file),
            tcOffset: state.fileTcOffsets?.[file.name] || 0,
          });
          const prevConf = cur?.finalConfidence ?? cur?.confidence ?? 0;
          const newConf  = aiResult.finalConfidence ?? aiResult.visualConfidence ?? 0;
          if (newConf > prevConf) {
            // Keep the resolved master identity from the prior pass; only the
            // AI-refined TCs / confidence are adopted.
            state.eventCorrections[ev.id] = {
              ...aiResult,
              // Embedding fallback improves timing/confidence but its 0..1
              // cosine distance is not the V1.4 regional-hash metric.
              visualDistance: cur.visualDistance ?? null,
              visualStatus: cur.visualStatus ?? null,
              pixelSimilarity: cur.pixelSimilarity ?? null,
              pixelStatus: cur.pixelStatus ?? null,
              pictureEvidenceVersion: cur.pictureEvidenceVersion ?? null,
              masterName:        cur.masterName,
              masterFileName:    cur.masterFileName,
              matchedSourceFile: cur.matchedSourceFile,
              matchedSourcePath: cur.matchedSourcePath,
              viaAiFallback:     true,
            };
            try { _renderMatchResults(); } catch {}
          }
        } catch (e) {
          console.warn('[TrlConform] AI recheck failed for event', ev.id, e?.message);
        }
      }
    } finally {
      for (const { url } of proxyCache.values()) { if (url) URL.revokeObjectURL(url); }
    }
  }

  async function _multiMasterFallback({ refVideo, canvas, ctx, dhCanvas, dhCtx, seqBaseFrames, useAI, progCur, progBar, progPct }) {
    const fps = state.fps || DEFAULT_FPS;
    const allMasters = state.masterFiles || [];
    if (allMasters.length < 2) return;   // nothing else to search

    const visibleEvents = _getVisibleEvents();
    const weak = visibleEvents.filter(ev => {
      const c = state.eventCorrections[ev.id];
      const conf = c ? (c.finalConfidence ?? c.confidence ?? 0) : 0;
      return isEpisodeLibraryEvent(ev) && shouldSearchAllMasters(c ? { confidence: conf } : null);
    });
    if (!weak.length) return;

    const proxyCache = new Map();   // fileName → { video, url }
    const loadMaster = async (file) => {
      if (proxyCache.has(file.name)) return proxyCache.get(file.name);
      const mv = await _loadVideo(file);
      proxyCache.set(file.name, mv);
      return mv;
    };

    try {
      let idx = 0;
      for (const ev of weak) {
        if (state.visualMatchCancel) break;
        idx++;
        if (progCur) progCur.textContent = `Library search ${idx}/${weak.length} — ${_stem(ev.reel || ev.srcFile || '')}`;
        const libraryPct = 90 + Math.round((idx / weak.length) * 6);
        if (progBar) progBar.value = libraryPct;
        if (progPct) progPct.textContent = `${libraryPct}%`;

        const cur = state.eventCorrections[ev.id];
        const pinnedName = cur?.masterName || null;
        const pinned = cur
          ? { masterKey: pinnedName, result: { confidence: cur.finalConfidence ?? cur.confidence ?? 0 } }
          : null;

        const candidates = [];
        for (const file of allMasters) {
          if (state.visualMatchCancel) break;
          if (pinnedName && file.name === pinnedName) continue;   // already tried in main pass
          let mv;
          try { mv = await loadMaster(file); } catch { continue; }
          let result;
          try {
            result = await _matchEventByVisualWave({
              ev, refVideo, masterVideo: mv.video, canvas, ctx, dhCanvas, dhCtx,
              fps, seqBaseFrames, useAI,
              masterFileKey: _fpFileKey(file),
              tcOffset: state.fileTcOffsets?.[file.name] || 0,
              searchProfile: 'library',
              shouldCancel: () => state.visualMatchCancel,
            });
          } catch { continue; }
          candidates.push({
            masterKey: file.name, masterName: file.name, file,
            result: { confidence: result.finalConfidence ?? result.visualConfidence ?? 0, distance: result.distance, _full: result },
          });
        }

        const libBest = pickBestMaster(candidates);
        const winner  = resolveMaster(pinned, libBest);
        if (winner && libBest && winner.masterKey === libBest.masterKey && winner.masterKey !== pinnedName) {
          const r = libBest.result._full;
          // Blend the 0.15 audio slot for the adopted library master too, matching
          // the primary path (0.85·visual + 0.15·audio). Falls back to the
          // visual-only confidence when envelopes can't be captured — never worse.
          const visualConf = r.visualConfidence ?? libBest.result.confidence;
          let audioConfidence = null;
          let finalConfidence = libBest.result.confidence;
          try {
            const recInF    = ev._recInFrames || _tcToFrames(ev.recIn, fps);
            const unmrefSec  = (recInF - seqBaseFrames) / fps;
            const corrSrcSec = _tcToFrames(r.srcIn, fps) / fps;
            if (unmrefSec >= 0) {
              const [refEnv, srcEnv] = await Promise.all([
                state.refFile ? _captureVideoEnvelope(state.refFile, unmrefSec) : Promise.resolve(null),
                libBest.file  ? _captureVideoEnvelope(libBest.file, corrSrcSec)  : Promise.resolve(null),
              ]);
              if (refEnv && srcEnv) {
                const sync = _envelopeSync(refEnv, srcEnv, 5);
                audioConfidence = Math.round(sync.corr * 100);
                finalConfidence = Math.max(0, Math.min(100,
                  Math.round(0.85 * visualConf + 0.15 * audioConfidence)
                ));
              }
            }
          } catch {}
          state.eventCorrections[ev.id] = {
            ...r,
            audioConfidence,
            finalConfidence,
            masterName: libBest.masterName,
            masterFileName: libBest.file?.name || libBest.masterName,
            matchedSourceFile: libBest.file?.name || libBest.masterName,
            matchedSourcePath: libBest.file?._nativePath || libBest.file?.webkitRelativePath || libBest.file?.name || libBest.masterName,
            viaLibrarySearch: true,
          };
          if (!state.matchResults[ev.id]) state.matchResults[ev.id] = { status: null, approved: false, notes: '' };
          if (state.matchResults[ev.id].decision == null && state.matchResults[ev.id].status === 'FAIL') {
            state.matchResults[ev.id].status = null;
          }
          try { _renderMatchResults(); } catch {}
        }
      }
    } finally {
      for (const { url } of proxyCache.values()) { if (url) URL.revokeObjectURL(url); }
    }
  }

  // ── No-EDL conform (V1.4 conform.py run() port) ────────────────────────────
  // When no agency EDL/XML is available: CV-detect shots (#1), search the WHOLE
  // master library for each shot (#3), then repair over-split shots (#2). Pure
  // result — does not mutate event/render state; the caller decides how to use
  // it (e.g. seed synthetic events or export directly). Needs a loaded ref video
  // and state.masterFiles. Confidence→status uses trlconf's SAFE/REVIEW bands
  // mapped to the OK/REVIEW/NO_MATCH vocabulary mergeAdjacentMatches expects.
  async function _detectAndMatchNoEdl(refVideo, fps, opts = {}) {
    const canvas = document.createElement('canvas');
    canvas.width = _HASH_W; canvas.height = _HASH_H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const { shots, threshold, warnings } = await _detectShotsFromVideo(refVideo, fps, {
      minShotFrames: opts.minShotFrames ?? 12,
      threshold: opts.threshold ?? null,
      onProgress: opts.onDetectProgress,
      shouldCancel: opts.shouldCancel,
    });

    const masters = state.masterFiles || [];
    const proxyCache = new Map();
    const loadMaster = async (file) => {
      if (proxyCache.has(file.name)) return proxyCache.get(file.name);
      const mv = await _loadVideo(file); proxyCache.set(file.name, mv); return mv;
    };
    const matches = [];
    try {
      for (let i = 0; i < shots.length; i++) {
        if (opts.shouldCancel && opts.shouldCancel()) break;
        const shot = shots[i];
        const midF = Math.floor((shot.startFrame + shot.endFrame) / 2);
        await _seekVideo(refVideo, midF / fps);
        if ((refVideo.videoWidth || 0) === 0) continue;
        const midHash = regionalHash(refVideo);

        // Search every master for this shot's mid frame; keep the best (#3).
        const candidates = [];
        for (const file of masters) {
          if (opts.shouldCancel && opts.shouldCancel()) break;
          let mv; try { mv = await loadMaster(file); } catch { continue; }
          let res;
          try {
            // No-EDL has NO valid master-time hint (the offline position is
            // unrelated to master position), so force a whole-master scan:
            // minLocalConfidence 101 makes the wide pass always run, and the
            // seek hint is neutral (0). Otherwise a wrong-but-decent (≥68) hit
            // near a bogus offset would suppress the full search.
            res = await _searchMasterForFrame(midHash, mv.video, canvas, ctx, 0, fps, {
              wideSearch: true, minLocalConfidence: 101, fileKey: _fpFileKey(file),
            });
          } catch { continue; }
          candidates.push({ masterKey: file.name, masterName: file.name, file, result: { confidence: res.confidence, distance: res.distance, bestSec: res.bestSec } });
        }

        const best = pickBestMaster(candidates);
        const conf = best?.result.confidence ?? 0;
        const distance = Number.isFinite(best?.result.distance) ? Math.round(best.result.distance) : null;
        const pictureStatus = Number.isFinite(distance) ? confidenceStatus(distance) : 'NO_MATCH';
        const masterMid = best ? Math.round(best.result.bestSec * fps) : 0;
        const half = Math.floor((shot.endFrame - shot.startFrame) / 2);
        matches.push({
          offlineStart: shot.startFrame, offlineEnd: shot.endFrame,
          masterKey:  best?.masterKey || null,
          masterName: best?.masterName || null,
          masterStart: best ? masterMid - half : 0,
          masterEnd:   best ? masterMid + (shot.endFrame - shot.startFrame - half) : (shot.endFrame - shot.startFrame),
          confidence:  Math.round(conf),
          distance,
          visualDistance: distance,
          visualStatus: best ? pictureStatus : 'NO_MATCH',
          status:      best ? pictureStatus : 'NO_MATCH',
        });
        if (opts.onMatchProgress) opts.onMatchProgress(i + 1, shots.length);
      }
    } finally {
      for (const { url } of proxyCache.values()) { if (url) URL.revokeObjectURL(url); }
    }

    // Repair over-split detected shots that matched the same master at adjacent
    // TCs (#2). gapTolerance ≈ 1s of master frames.
    const merged = mergeAdjacentMatches(matches, { gapTolerance: Math.round(fps) });
    return { shots, threshold, warnings, matches: merged };
  }

  // ── Manual reel-to-source override (#1) ────────────────────────────────
  // After a coordinator manually points a `low`/`unmatched` reel at a source
  // file (see the "Fix" dropdown wired in the results-summary area below),
  // re-run the existing per-event visual+audio matching for just that reel's
  // events — reusing _matchEventByVisualWave / _captureVideoEnvelope exactly
  // as _runVisualMatch does, just scoped to one master file's events instead
  // of the whole project. Falls back to leaving events unmatched (but with
  // the corrected reel mapping in place) if no reference file is loaded yet;
  // the next full Run Match will then naturally pick this reel up.
  async function _rematchReelEvents(reelEntry) {
    if (state.visualMatchRunning) return;
    if (!reelEntry?.masterFile) return;

    const reelEvents = _getVisibleEvents().filter(
      e => (e.reel || e.srcFile || '') === reelEntry.proxyName
    );
    if (!reelEvents.length) { _renderMatchResults(); return; }

    // No reference loaded yet — nothing to match against. The corrected
    // mapping (status/masterFile) is already applied by the caller, so the
    // reel will simply be picked up by the next full Run Match.
    if (!state.refFile) { _renderMatchResults(); _updateExportBtns(); return; }

    state.visualMatchRunning = true;
    const progCur = _$('trcProgressCurrent');
    const progWrap = _$('trcProgressWrap');
    if (progWrap) progWrap.style.display = '';
    if (progCur) progCur.textContent = `Re-matching ${_stem(reelEntry.proxyName)}…`;

    const useAI  = state.aiMode && aiReady();
    const canvas = document.createElement('canvas');
    canvas.width  = useAI ? AI_W : _HASH_W;
    canvas.height = useAI ? AI_H : _HASH_H;
    const ctx     = useAI ? null : canvas.getContext('2d', { willReadFrequently: true });

    const dhCanvas = document.createElement('canvas');
    dhCanvas.width  = _DHASH_W + 1;
    dhCanvas.height = _DHASH_H;
    const dhCtx    = useAI ? null : dhCanvas.getContext('2d', { willReadFrequently: true });

    let refUrl = null, masterUrl2 = null;
    try {
      const refData = await _loadVideo(state.refFile, {
        onProgress: pct => { if (progCur) progCur.textContent = `Opening ProRes: ${state.refFile.name} — ${pct}%`; },
      });
      refUrl = refData.url;
      const refVideo    = refData.video;
      const refDuration = refData.duration;

      const visibleEvents = _getVisibleEvents();
      const seqBaseFrames = referenceBaseFrames(visibleEvents, state.fps, _tcToFrames);

      const mv = await _loadVideo(reelEntry.masterFile, {
        onProgress: pct => { if (progCur) progCur.textContent = `Opening ProRes: ${_stem(reelEntry.masterName)} — ${pct}%`; },
      });
      const masterVideo = mv.video;
      masterUrl2 = mv.url;

      let done = 0;
      for (const ev of reelEvents) {
        done++;
        if (progCur) progCur.textContent = `Re-matching ${_stem(reelEntry.proxyName)} — event ${done}/${reelEvents.length}…`;
        try {
          const recInF    = ev._recInFrames || _tcToFrames(ev.recIn, state.fps);
          const unmrefSec = (recInF - seqBaseFrames) / state.fps;
          if (unmrefSec < 0 || unmrefSec >= refDuration - 0.1) continue;

          const result = await _matchEventByVisualWave({
            ev,
            refVideo,
            masterVideo,
            canvas,
            ctx,
            dhCanvas,
            dhCtx,
            fps: state.fps,
            seqBaseFrames,
            useAI,
            masterFileKey: _fpFileKey(reelEntry.masterFile),
            tcOffset: reelEntry.tcOffset || 0,
          });

          let audioConfidence = null;
          let finalConfidence = result.visualConfidence;
          try {
            const corrSrcSec = _tcToFrames(result.srcIn, state.fps) / state.fps;
            const [refEnv, srcEnv] = await Promise.all([
              state.refFile        ? _captureVideoEnvelope(state.refFile, unmrefSec) : Promise.resolve(null),
              reelEntry.masterFile  ? _captureVideoEnvelope(reelEntry.masterFile, corrSrcSec) : Promise.resolve(null),
            ]);
            if (refEnv && srcEnv) {
              const sync = _envelopeSync(refEnv, srcEnv, 5);
              audioConfidence = Math.round(sync.corr * 100);
              finalConfidence = Math.max(0, Math.min(100,
                Math.round(0.85 * result.visualConfidence + 0.15 * audioConfidence)
              ));
            }
          } catch {}

          state.eventCorrections[ev.id] = {
            ...result,
            audioConfidence,
            finalConfidence,
            masterName: reelEntry.masterName,
            masterFileName: reelEntry.masterFile?.name || reelEntry.masterName,
            matchedSourceFile: reelEntry.masterFile?.name || reelEntry.masterName,
            matchedSourcePath: reelEntry.masterFile?._nativePath || reelEntry.masterFile?.webkitRelativePath || reelEntry.masterFile?.name || reelEntry.masterName,
          };

          if (!state.matchResults[ev.id]) {
            state.matchResults[ev.id] = { status: null, approved: false, notes: '' };
          }
        } catch (evErr) {
          console.warn('[TrlConform] Manual reel re-match failed for event', ev.id, evErr.message);
        }
      }

      // Re-apply the existing per-reel slip workflow so events on this reel
      // that lacked a strong per-event match still get the reel's median
      // slip — same behavior as a normal full match run, unchanged logic.
      const slipMap = _computeReelSlips(state.events, state.eventCorrections, state.fps || DEFAULT_FPS);
      _applyReelSlips(slipMap, state.events, state.eventCorrections, state.reelMap, state.fps || DEFAULT_FPS);

      state.matchHasRun = true;
      state.lastMatchedAt = Date.now();
      _idbSaveLastMatchedAt(state.lastMatchedAt).catch(() => {});

      if (progCur) progCur.textContent = `Done — re-matched ${reelEvents.length} event(s) on ${_stem(reelEntry.proxyName)}`;
      _renderSlipSummary(slipMap);
    } catch (err) {
      console.error('[TrlConform] Manual reel re-match error', err);
      if (progCur) progCur.textContent = `Error re-matching ${_stem(reelEntry.proxyName)}: ${err.message}`;
    } finally {
      if (refUrl) URL.revokeObjectURL(refUrl);
      if (masterUrl2) URL.revokeObjectURL(masterUrl2);
      state.visualMatchRunning = false;
      _renderMatchResults();
      _renderExportSummary();
      _updateStatusBadges();
      _updateExportBtns();
    }
  }

  // ── Match button state helpers ────────────────────────────────────────

  function _updateMatchBtns() {
    const canBuildFP = !!state.refFile;
    const canIndex   = state.masterFiles.length > 0;
    const canRun     = !!state.timelineFile && !!state.refFile && state.masterFiles.length > 0
                    && state.sourceIndexed && !state.visualMatchRunning;
    const allReady   = canRun && state.sourceIndexed;

    // No-EDL detection needs only a reference + at least one master (no timeline).
    const canDetect = !!state.refFile && state.masterFiles.length > 0 && !state.visualMatchRunning;

    const el = (id, dis) => { const b = _$(id); if (b) b.disabled = dis; };
    el('trcBtnBuildFP',    !canBuildFP);
    el('trcBtnIndexSource',!canIndex);
    el('trcBtnRunMatch',   !canRun);
    el('trcBtnDetectShots',!canDetect);

    // Pulse the Run Match button when all inputs are ready and indexed
    const runBtn = _$('trcBtnRunMatch');
    if (runBtn) runBtn.classList.toggle('trc-btn-run-match--ready', allReady);
  }

  function _updateExportBtns() {
    const xmlReady = _getExportSummaryData().toUpdate > 0;
    const xmlBtn = _$('trcBtnExportXML');
    if (xmlBtn) xmlBtn.disabled = !xmlReady;
  }

  // ── Auto-parse XML on load ────────────────────────────────────────────
  // Called immediately when a cut file is set — parses without running visual match.

  async function _autoParseXML() {
    if (!state.timelineFile) return;
    try {
      const result = await _parseTimeline(state.timelineFile);
      state.events      = result.events || [];
      state.fps         = result.fps    || DEFAULT_FPS;
      // Falls back to the base when a producer predates the two-rate contract,
      // which is exactly the behaviour this file had before it was threaded.
      state.fpsExact    = result.fpsExact || state.fps;
      state.projectName = result.projectName || _stem(state.timelineFile.name);

      const extMatch = state.timelineFile.name.match(/\.(\w+)$/i);
      const fmt = extMatch ? extMatch[1].toUpperCase() : '—';
      const visCount = _getVisibleEvents().length;
      const preservedCount = _getPreservedEvents().length;
      _showCutInfo(state.timelineFile.name, fmt, preservedCount ? `${visCount} shots · ${preservedCount} overlays` : visCount, state.projectName, state.fps);

      if (state.masterFiles.length) {
        state.reelMap  = _buildReelMap(state.events, state.masterFiles);
        _applyTcOffsets(state.reelMap, state.fileTcOffsets);
        state.analyzed = true;
        _renderMatchResults();
        _renderExportSummary();
        _updateExportBtns();
        // Auto-trigger: XML was the last piece to arrive
        if (state.refFile && !state.matchHasRun && !state.visualMatchRunning) {
          _runVisualMatch().catch(() => {});
        }
      }
    } catch (err) {
      console.warn('[TrlConform] Auto-parse failed', err.message);
    }
    _updateStatusBadges();
    _updateMatchBtns();
  }

  // ── Auto-index source files with direct native decode ─────────────────
  // Opens persistent AVFoundation sessions for every ProRes master. No proxy is
  // generated; Run Match extracts exact source frames from the original files.

  async function _autoIndexSource() {
    const files = state.masterFiles.filter(f => /\.mov$/i.test(f.name || ''));
    if (!files.length) return;

    state.sourceIndexed = false;
    const _el = (id, v) => { const e = _$(id); if (e) e.textContent = v; };
    _el('trcSourceInfoIndexed', 'Indexing…');
    _el('trcSourceInfoStatus',  'Starting…');

    let totalDur = 0;
    let ok = 0;
    let failed = 0;
    let nativeCount = 0;

    for (let i = 0; i < files.length; i++) {
      if (!state.masterFiles.length) break;  // cleared mid-flight
      const f = files[i];
      const isMov = /\.mov$/i.test(f.name);
      _el('trcSourceInfoIndexed', `${i + 1} / ${files.length}`);
      _el('trcSourceInfoStatus', `${_stem(f.name)}…`);
      try {
        const { video, decodeStatus, startTimecode: tcNative, proxySessionId, proxyStreamUrl } = await _loadVideo(f, {
          onProgress: pct => _el('trcSourceInfoStatus', `Opening ProRes ${_stem(f.name)}: ${pct}%`),
        });
        totalDur += video.duration || 0;
        if (isMov && decodeStatus === 'native-avfoundation') nativeCount++;

        // Populate tape-TC→file-time offset for this source file.
        // For native-stream files the companion returns startTimecode directly;
        // for proxy-transcoded files we query /progress/{sessionId} which now
        // surfaces startTimecode from the ffprobe pre-probe.
        let tcStart = tcNative || '';
        if (!tcStart && decodeStatus === 'proxy-transcode') {
          tcStart = await _fetchProxyTimecodeStart(proxyStreamUrl, proxySessionId);
        }
        if (tcStart) {
          state.fileTcOffsets[f.name] = _tcToFrames(tcStart, state.fps || DEFAULT_FPS);
        }
        ok++;
      } catch (indexErr) {
        failed++;
        console.warn('[TrlConform] Failed to index source file', f.name, indexErr.message);
      }
    }

    if (!state.masterFiles.length) return;  // was cleared while we ran

    state.sourceIndexed = ok === files.length && failed === 0;
    const durStr = totalDur >= 3600
      ? `${(totalDur / 3600).toFixed(1)} hr`
      : `${(totalDur / 60).toFixed(1)} min`;
    _el('trcSourceInfoIndexed', `${ok} / ${files.length}${nativeCount > 0 ? ` · ${nativeCount} direct ProRes` : ''}${failed ? ` · ${failed} FAILED` : ''}`);
    _el('trcSourceInfoDur',    totalDur > 0 ? durStr : '—');

    // If XML already parsed, rebuild reel map and render initial UNMATCH table.
    // Built *before* the status line below so #8's unused-source-file note can
    // be appended in the same write (no separate "base text" tracking needed).
    if (state.events.length) {
      state.reelMap  = _buildReelMap(state.events, state.masterFiles);
      _applyTcOffsets(state.reelMap, state.fileTcOffsets);
      state.analyzed = true;
      _renderMatchResults();
      _renderExportSummary();
      _updateExportBtns();
    }

    // #8 — warn when a dropped source file matches zero cut events (reuses
    // the reel classification _buildReelMap already computed; no new scoring).
    let statusMsg = failed ? `${failed} file(s) could not be decoded — see console` : 'Ready';
    if (state.events.length) {
      const unusedCount = state.masterFiles.filter(
        f => !state.reelMap.some(r => r.masterFile && r.masterFile.name === f.name)
      ).length;
      if (unusedCount > 0) {
        statusMsg += ` · ${unusedCount} source file${unusedCount === 1 ? '' : 's'} not used by this cut`;
      }
    }
    _el('trcSourceInfoStatus', statusMsg);
    _updateMatchBtns();
    _updateStatusBadges();

    // Auto-trigger match when all three inputs are loaded and match hasn't run yet
    if (state.timelineFile && state.refFile && !state.matchHasRun && !state.visualMatchRunning) {
      _runVisualMatch().catch(() => {});
    }
  }

  // ── Exports ───────────────────────────────────────────────────────────

  // Warn before re-running match on a project that already has approved rows —
  // re-running re-solves every event and can silently overwrite approval decisions.
  function _confirmRerunWithApprovedRows() {
    const approvedCount = Object.values(state.matchResults).filter(r => r.approved).length;
    if (approvedCount <= 0) return true;
    return confirm(
      `You've already approved ${approvedCount} match${approvedCount === 1 ? '' : 'es'} — `
      + `re-running will re-check everything, including approved rows. Continue?`
    );
  }

  function _confirmExportWithPendingReviews() {
    const summary = _getExportSummaryData();
    const pending = summary.reviewUnapproved + summary.fail + summary.unmatched;
    if (pending <= 0) return true;
    const bits = [];
    if (summary.reviewUnapproved > 0) bits.push(`${summary.reviewUnapproved} still need review`);
    if (summary.fail > 0) bits.push(`${summary.fail} failed to match`);
    if (summary.unmatched > 0) bits.push(`${summary.unmatched} were never matched`);
    return confirm(`${pending} event(s) ${bits.join(' and ')} before export. Export anyway?`);
  }

  function _exportCorrectedXML() {
    if (!state.analyzed || !state.events.length) return;
    if (!_confirmExportWithPendingReviews()) return;
    const fps = state.fps || DEFAULT_FPS;
    const visibleEvents = _getVisibleEvents();
    const reelByProxy = {};
    for (const r of state.reelMap) reelByProxy[r.proxyName] = r;
    const isOriginalXmeml = /<xmeml(?:\s|>)/i.test(state.timelineText || '');

    if (isOriginalXmeml) {
      const doc = new DOMParser().parseFromString(state.timelineText, 'application/xml');
      if (doc.querySelector?.('parsererror')) throw new Error('The original XML could not be preserved for export.');
      const direct = (parent, tag) => {
        for (const node of parent?.childNodes || []) {
          if (node?.nodeType === 1 && node.nodeName === tag) return node;
        }
        return null;
      };
      const directAll = (parent, tag) => Array.from(parent?.childNodes || []).filter(node => node?.nodeType === 1 && node.nodeName === tag);
      const setText = (parent, tag, value) => {
        let node = direct(parent, tag);
        if (!node) { node = doc.createElement(tag); parent.appendChild(node); }
        node.textContent = String(value);
        return node;
      };

      const sequence = doc.documentElement.getElementsByTagName('sequence')[0];
      const media = direct(sequence, 'media') || sequence?.getElementsByTagName('media')[0];
      const video = direct(media, 'video') || media?.getElementsByTagName('video')[0];
      const tracks = directAll(video, 'track');
      const fileDefs = new Map();
      for (const file of Array.from(doc.documentElement.getElementsByTagName('file'))) {
        const id = file.getAttribute?.('id');
        if (id && direct(file, 'name')) fileDefs.set(id, file);
      }
      const ticksPerFrame = 254016000000 / fps;

      for (const ev of visibleEvents) {
        const corr = state.eventCorrections[ev.id];
        if (!corr || !_shouldApplyCorrection(ev)) continue;
        const track = tracks[Number(ev.trackIndex) || 0];
        const clipitem = directAll(track, 'clipitem')[Number(ev.clipIndex) || 0];
        if (!clipitem) continue;

        const originalInF = ev._srcInFrames ?? _tcToFrames(ev.srcIn, fps);
        const originalOutF = ev._srcOutFrames ?? _tcToFrames(ev.srcOut, fps);
        const correctedInF = _tcToFrames(corr.srcIn, fps);
        const metrics = _eventFrameMetrics(ev, fps);
        // Premiere's graphdict owns the source excursion on a speed ramp. Its
        // clip in/out retain the original edit duration while every mapped
        // source value shifts to the newly matched master location.
        const correctedOutF = metrics.dynamicSpeed
          ? correctedInF + Math.max(1, originalOutF - originalInF)
          : _tcToFrames(corr.srcOut, fps);
        const sourceDelta = correctedInF - originalInF;
        setText(clipitem, 'in', correctedInF);
        setText(clipitem, 'out', correctedOutF);
        setText(clipitem, 'pproTicksIn', Math.round(correctedInF * ticksPerFrame));
        setText(clipitem, 'pproTicksOut', Math.round(correctedOutF * ticksPerFrame));

        if (metrics.dynamicSpeed && sourceDelta) {
          for (const param of Array.from(clipitem.getElementsByTagName('parameter'))) {
            const key = (direct(param, 'parameterid')?.textContent || direct(param, 'name')?.textContent || '').trim().toLowerCase();
            if (key !== 'graphdict') continue;
            for (const keyframe of Array.from(param.getElementsByTagName('keyframe'))) {
              const valueNode = direct(keyframe, 'value');
              const value = Number(valueNode?.textContent);
              if (valueNode && Number.isFinite(value)) valueNode.textContent = String(Math.round(value + sourceDelta));
            }
          }
        }

        const proxyKey = ev.reel || ev.srcFile || '';
        const entry = reelByProxy[proxyKey];
        const sourceName = corr.matchedSourceFile || corr.masterFileName || corr.masterName || entry?.masterName || proxyKey;
        const sourcePath = corr.matchedSourcePath || entry?.masterFile?._nativePath || sourceName;
        const oldFile = direct(clipitem, 'file');
        const definition = oldFile?.getAttribute?.('id') ? fileDefs.get(oldFile.getAttribute('id')) : null;
        const isolatedFile = (definition || oldFile)?.cloneNode(true) || doc.createElement('file');
        isolatedFile.setAttribute('id', `pfx-conform-file-${ev.id}`);
        setText(isolatedFile, 'name', sourceName);
        if (sourcePath) {
          setText(isolatedFile, 'pathurl', state.exportOptions.relativePaths ? `./${sourceName}` : _pathToFileUrl(sourcePath));
        }
        if (oldFile) clipitem.replaceChild(isolatedFile, oldFile);
        else clipitem.appendChild(isolatedFile);

        if (state.exportOptions.addNotes) {
          const meta = state.matchResults[ev.id] || {};
          const note = [_computeRowStatus(ev.id), meta.notes].filter(Boolean).join(' · ');
          if (note) setText(clipitem, 'comments', note);
        }
      }

      let xml = new XMLSerializer().serializeToString(doc);
      if (!/^<\?xml/i.test(xml)) xml = `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
      _download(xml, `${state.projectName || 'TRAILERS_CONFORM'}_CONFORMED.xml`, 'application/xml');
      return;
    }

    // EDL/FCPXML imports do not have an original XMEML tree to patch. Keep a
    // compact compatibility export for those formats.
    const clipItems = visibleEvents.map(ev => {
      const corr = state.eventCorrections[ev.id];
      const apply = !!corr && _shouldApplyCorrection(ev);
      const inF = apply ? _tcToFrames(corr.srcIn, fps) : (ev._srcInFrames ?? _tcToFrames(ev.srcIn, fps));
      const outF = apply ? _tcToFrames(corr.srcOut, fps) : (ev._srcOutFrames ?? _tcToFrames(ev.srcOut, fps));
      return `<clipitem id="event_${ev.id}"><name>${_esc(ev.clipName || ev.reel || '')}</name><in>${inF}</in><out>${outF}</out><start>${ev._recInFrames ?? 0}</start><end>${ev._recOutFrames ?? 0}</end></clipitem>`;
    }).join('');
    const xml = `<?xml version="1.0" encoding="UTF-8"?><xmeml version="4"><sequence><name>${_esc(state.projectName)}</name><rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate><media><video><track>${clipItems}</track></video></media></sequence></xmeml>`;
    _download(xml, `${state.projectName || 'TRAILERS_CONFORM'}_CONFORMED.xml`, 'application/xml');
  }

  function _exportCSVPullList() {
    if (!state.analyzed || !state.events.length) return;
    const fps = state.fps || DEFAULT_FPS;
    const visibleEvents = state.events.filter(e => !e.disabled && e.type === 'video');
    const reelByProxy = {};
    for (const r of state.reelMap) reelByProxy[r.proxyName] = r;

    const header = '#,Event,XML Clip,Ref In,Ref Out,DurationFrames,Speed%,Matched Source,Corrected Src In,Corrected Src Out,Offset,Visual%,Audio%,Final%,Status,Method,Samples,VarianceFrames';
    const rows = visibleEvents.map((ev, i) => {
      const proxyKey  = ev.reel || ev.srcFile || '';
      const entry     = reelByProxy[proxyKey];
      const corr = state.eventCorrections[ev.id];
      const masterStem = corr?.matchedSourceFile ? _stem(corr.matchedSourceFile) : (entry?.masterName ? _stem(entry.masterName) : '—');
      const corrSrcIn  = corr ? corr.srcIn  : ev.srcIn;
      const corrSrcOut = corr ? corr.srcOut : ev.srcOut;
      const origF = ev._srcInFrames ?? _tcToFrames(ev.srcIn, fps);
      const corrF = corr ? _tcToFrames(corr.srcIn, fps) : origF;
      const delta = corrF - origF;
      const offsetStr = corr ? (delta === 0 ? '0' : (delta > 0 ? `+${delta}f` : `${delta}f`)) : '—';
      const visualPct = corr ? `${corr.confidence}%` : '—';
      const audioPct = corr?.audioConfidence != null ? `${corr.audioConfidence}%` : '—';
      const finalPct = corr ? `${Math.round(corr.finalConfidence ?? corr.confidence)}%` : '—';
      const status = _computeRowStatus(ev.id);
      const metrics = _eventFrameMetrics(ev, fps);
      const evLabel = `${ev.recIn}→${ev.recOut}`;
      const esc = (s) => { let v = String(s); if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`; return `"${v.replace(/"/g, '""')}"`; };
      return [i+1, esc(evLabel), esc(ev.clipName || ev.reel || ''), ev.recIn, ev.recOut,
              metrics.recDurF, metrics.speedPct,
              esc(masterStem), corrSrcIn, corrSrcOut, offsetStr, visualPct, audioPct, finalPct, status,
              esc(corr?.method || ''), corr?.samplesUsed ?? '', corr?.offsetVarianceFrames ?? ''].join(',');
    });

    _download([header, ...rows].join('\n'), `${state.projectName || 'TRAILERS_CONFORM'}_PULL_LIST.csv`, 'text/csv');
  }

  function _exportMatchReportJSON() {
    if (!state.analyzed || !state.events.length) return;
    const fps = state.fps || DEFAULT_FPS;
    const visibleEvents = state.events.filter(e => !e.disabled && e.type === 'video');
    const reelByProxy = {};
    for (const r of state.reelMap) reelByProxy[r.proxyName] = r;

    const events = visibleEvents.map((ev, i) => {
      const proxyKey  = ev.reel || ev.srcFile || '';
      const entry     = reelByProxy[proxyKey];
      const corr = state.eventCorrections[ev.id];
      const masterStem = corr?.matchedSourceFile ? _stem(corr.matchedSourceFile) : (entry?.masterName ? _stem(entry.masterName) : null);
      const origF = ev._srcInFrames ?? _tcToFrames(ev.srcIn, fps);
      const corrF = corr ? _tcToFrames(corr.srcIn, fps) : origF;
      return {
        num:           i + 1,
        id:            ev.id,
        recIn:         ev.recIn,
        recOut:        ev.recOut,
        xmlClip:       ev.clipName || ev.reel || '',
        matchedSource: masterStem,
        corrSrcIn:     corr ? corr.srcIn  : ev.srcIn,
        corrSrcOut:    corr ? corr.srcOut : ev.srcOut,
        offsetFrames:  corr ? corrF - origF : 0,
        visualPct:     corr ? (corr.visualConfidence ?? corr.confidence) : null,
        audioPct:      corr?.audioConfidence ?? null,
        finalPct:      corr ? (corr.finalConfidence ?? corr.confidence) : null,
        method:        corr?.method || '',
        samplesUsed:   corr?.samplesUsed ?? null,
        consistentSamples: corr?.consistentSamples ?? null,
        varianceFrames: corr?.offsetVarianceFrames ?? null,
        speedPercent:  corr?.speedPercent ?? (_eventFrameMetrics(ev, fps).speedPct),
        sampleMatches: corr?.sampleMatches || [],
        status:        _computeRowStatus(ev.id),
        approved:      state.matchResults[ev.id]?.approved ?? false,
        notes:         state.matchResults[ev.id]?.notes    ?? '',
      };
    });

    const report = {
      projectName: state.projectName,
      fps,
      epId:        state.epId,
      exportedAt:  new Date().toISOString(),
      events,
    };

    _download(JSON.stringify(report, null, 2),
      `${state.projectName || 'TRAILERS_CONFORM'}_MATCH_REPORT.json`, 'application/json');
  }

  // ── Old EDL export (kept for render queue handler) ────────────────────

  async function _exportEDL() {
    if (!state.analyzed || !state.events.length) return;
    const reelMapByProxy = {};
    for (const r of state.reelMap) reelMapByProxy[r.proxyName] = r;
    const tcOffsets = {};
    for (const r of state.reelMap) tcOffsets[r.proxyName] = r.tcOffset || 0;
    const title   = state.projectName || 'TRAILERS_CONFORM';
    const edlText = _buildEDL(state.events, reelMapByProxy, state.fps, title, tcOffsets, state.eventCorrections);
    const fname   = `${title}_CONFORMED.edl`;
    const blob    = new Blob([edlText], { type: 'text/plain' });
    if (typeof window.__pfxSaveBlob === 'function') {
      await window.__pfxSaveBlob(fname, blob);
    } else {
      _download(edlText, fname);
    }
  }

  // ── Drop zone wiring ──────────────────────────────────────────────────

  function _wireDropZone(dropId, labelId, clearId, accept, onFiles) {
    const zone  = _$(dropId);
    const label = _$(labelId);
    const clear = _$(clearId);
    if (!zone) return;

    const _highlight = (on) => zone.classList.toggle('trc-drop-zone--over', on);

    zone.addEventListener('dragover',  (e) => { e.preventDefault(); _highlight(true); });
    zone.addEventListener('dragleave', () => _highlight(false));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault(); _highlight(false);
      const items = [...(e.dataTransfer?.items || [])];
      // Prefer FSA handles from drag-and-drop (Chrome 86+)
      if (items.length && typeof items[0].getAsFileSystemHandle === 'function') {
        const allHandles = (await Promise.all(items.map(i => i.getAsFileSystemHandle().catch(() => null))))
          .filter(Boolean);
        const fileHandles = allHandles.filter(h => h.kind === 'file');
        const dirHandles  = allHandles.filter(h => h.kind === 'directory');
        // Traverse top-level directory drops (ProRes source folder)
        for (const dirH of dirHandles) {
          try {
            for await (const [, entryH] of dirH.entries()) {
              if (entryH.kind === 'file') fileHandles.push(entryH);
            }
          } catch { /* directory iteration not supported in this context */ }
        }
        if (fileHandles.length) {
          const files = await Promise.all(fileHandles.map(h => h.getFile()));
          onFiles(files, fileHandles);
          return;
        }
      }
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) onFiles(files, null);
    });
    zone.addEventListener('click', () => _openFilePicker(accept, onFiles));

    if (clear) {
      clear.addEventListener('click', (e) => {
        e.stopPropagation();
        onFiles(null);
      });
    }
  }

  function _openFilePicker(accept, onFiles) {
    if (accept === 'folder' && typeof window.pfxPlatform?.pickFolder === 'function' && typeof window.pfxPlatform?.listMediaFolder === 'function') {
      window.pfxPlatform.pickFolder({ title: 'Select the folder containing original ProRes masters' })
        .then(async (folderPath) => {
          if (!folderPath) return;
          const entries = await window.pfxPlatform.listMediaFolder(folderPath, ['.mov']);
          const files = (entries || []).map(entry => ({
            name: entry.name,
            size: Number(entry.size) || 0,
            lastModified: Number(entry.lastModified) || 0,
            webkitRelativePath: entry.name,
            _nativePath: entry.absolutePath,
          }));
          onFiles(files, null);
        })
        .catch(() => {});
      return;
    }
    // On the desktop app, .mov picks use the classic <input> path: its File
    // objects resolve a native path via webUtils.getPathForFile (FSA/
    // showOpenFilePicker files do NOT), which lets _loadVideo transcode big
    // ProRes files straight from disk instead of a doomed multi-GB HTTP upload.
    const _desktopMov = !!window.pfxPlatform && /\.mov/i.test(accept || '');
    // Prefer File System Access API (Chrome 86+) — returns storable handles.
    if (accept !== 'folder' && !_desktopMov && typeof window.showOpenFilePicker === 'function') {
      const isMultiple = /\.mov$/i.test(accept || '') || (accept || '').includes(',');
      const types = _buildFsaTypes(accept);
      window.showOpenFilePicker({ types, multiple: isMultiple, excludeAcceptAllOption: false })
        .then(async (handles) => {
          const files = await Promise.all(handles.map(h => h.getFile()));
          onFiles(files, handles);
        })
        .catch(() => {}); // AbortError on cancel
      return;
    }
    // Fallback: classic <input type=file>
    const inp = document.createElement('input');
    inp.type = 'file';
    if (accept === 'folder') {
      inp.setAttribute('webkitdirectory', '');
      inp.setAttribute('multiple', '');
    } else {
      inp.accept = accept;
      inp.multiple = (accept === 'video/*' || (accept || '').includes(',') || /\.mov$/i.test(accept || ''));
    }
    inp.onchange = () => { if (inp.files?.length) onFiles([...inp.files], null); };
    inp.click();
  }

  function _buildFsaTypes(accept) {
    if (/\.mov/i.test(accept)) {
      return [{ description: 'Video files', accept: { 'video/quicktime': ['.mov'] } }];
    }
    if (/xml|edl|fcpxml/i.test(accept)) {
      return [{ description: 'Edit files', accept: { 'text/xml': ['.xml', '.edl', '.fcpxml', '.xmeml'] } }];
    }
    return [];
  }

  // ── Mount ─────────────────────────────────────────────────────────────

  function mount() {
    const mountEl = document.getElementById('trlconfMount');
    if (!mountEl) return;
    mountEl.innerHTML = _buildHTML();
    _root = mountEl;

    // ── File handle persistence helpers ───────────────────────────────
    const _saveFileHandles = () => {
      _idbSaveHandles({
        cutHandle:      state._cutHandle     || null,
        cutName:        state.timelineFile?.name || '',
        cutText:        state.timelineText   || '',
        refHandle:      state._refHandle     || null,
        refName:        state.refFile?.name  || '',
        sourceHandles:  state._sourceHandles || [],
        sourceName:     state._sourceHandles?.length
                          ? `${state._sourceHandles.length} files`
                          : '',
      });
    };

    // ── Wire: Editorial Cut ────────────────────────────────────────────
    const _onCutFiles = (files, handles = null) => {
      if (!files) {
        state.timelineFile = null;
        state._cutHandle   = null;
        state.events = [];
        state.projectName = '';
        state.reelMap = [];
        state.analyzed = false;
        state.eventCorrections = {};
        state.matchResults = {};
        state.selectedEvId = null;
        state.matchHasRun = false;
        const inner = _$('trcDropCutInner');
        const info  = _$('trcCutInfo');
        if (inner) inner.style.display = '';
        if (info)  info.style.display  = 'none';
        _$('trcClearCut')?.setAttribute('style', 'display:none');
        _$('trcDropCut')?.classList.remove('trc-drop-zone--loaded');
        _drawVerifyPlaceholder('trcRefCanvas', 'Reference frame');
        _drawVerifyPlaceholder('trcSrcCanvas', 'Matched source frame');
        const labelEl = _$('trcVerifyEventLabel');
        if (labelEl) labelEl.textContent = '—';
        const waveOffsetEl = _$('trcWaveOffset');
        if (waveOffsetEl) waveOffsetEl.textContent = '—';
        _updateVerifyControls();
        _renderMatchResults();
        _renderExportSummary();
        _updateExportBtns();
        _updateMatchBtns();
        _updateStatusBadges();
        return;
      }
      const f = files.find(f => /\.(xml|edl|fcpxml|xmeml)$/i.test(f.name)) || files[0];
      if (!f) return;
      state.timelineFile = f;
      state._cutHandle   = (handles && handles[0]) || null;
      // Show format immediately before parse
      const extMatch = f.name.match(/\.(\w+)$/i);
      const fmt = extMatch ? extMatch[1].toUpperCase() : '—';
      const inner = _$('trcDropCutInner');
      const info  = _$('trcCutInfo');
      if (inner) inner.style.display = 'none';
      if (info)  info.style.display  = '';
      const el = (id, v) => { const e = _$(id); if (e) e.textContent = v; };
      el('trcCutInfoFile', f.name);
      el('trcCutInfoFmt',  fmt);
      el('trcCutInfoEvents',   '—');
      el('trcCutInfoTimeline', '—');
      el('trcCutInfoFps',      '—');
      const cb = _$('trcClearCut');
      if (cb) cb.style.display = '';
      _$('trcDropCut')?.classList.add('trc-drop-zone--loaded');
      _updateMatchBtns();
      _updateStatusBadges();
      // Auto-parse XML immediately — populates event table without waiting for Run Match
      _autoParseXML().then(() => _saveFileHandles()).catch(() => {});
    };

    _wireDropZone('trcDropCut', 'trcCutLabel', 'trcClearCut', '.xml,.edl,.fcpxml', _onCutFiles);
    _$('trcBtnLoadCut')?.addEventListener('click', () => _openFilePicker('.xml,.edl,.fcpxml', _onCutFiles));

    // ── Wire: Reference QT ─────────────────────────────────────────────
    const _onRefFiles = async (files, handles = null) => {
      if (!files) {
        state.refFile    = null;
        state._refHandle = null;
        state.epId    = null;
        state.eventCorrections = {};
        state.matchResults = {};
        state.selectedEvId = null;
        state.matchHasRun = false;
        const inner = _$('trcDropRefInner');
        const info  = _$('trcRefInfo');
        if (inner) inner.style.display = '';
        if (info)  info.style.display  = 'none';
        _$('trcClearRef')?.setAttribute('style', 'display:none');
        _$('trcDropRef')?.classList.remove('trc-drop-zone--loaded');
        _updateVerifyControls();
        _renderMatchResults();
        _renderExportSummary();
        _updateExportBtns();
        _updateMatchBtns();
        _updateStatusBadges();
        return;
      }
      files = _withNativePaths(files);
      const f = files.find(file => /\.mov$/i.test(file.name || '')) || files[0];
      if (!f) return;
      state.refFile    = f;
      state._refHandle = (handles && handles[0]) || null;

      // Parse ep ID from filename
      const epNum = _extractEpNum(f.name);
      state.epId  = epNum != null ? String(epNum).padStart(3, '0') : null;

      const inner = _$('trcDropRefInner');
      const info  = _$('trcRefInfo');
      if (inner) inner.style.display = 'none';
      if (info)  info.style.display  = '';
      const el = (id, v) => { const e = _$(id); if (e) e.textContent = v; };
      el('trcRefInfoFile', f.name);
      el('trcRefInfoEp',   state.epId ? `EP${state.epId}` : '—');
      el('trcRefInfoDur',  'Probing…');
      el('trcRefInfoFps',  '—');
      el('trcRefInfoDecode', '—');

      const cb = _$('trcClearRef');
      if (cb) cb.style.display = '';
      _$('trcDropRef')?.classList.add('trc-drop-zone--loaded');
      _updateMatchBtns();
      _updateStatusBadges();

      // Probe duration using the same direct AVFoundation path used by matching.
      el('trcRefInfoDecode', 'Probing…');
      try {
        const { video, decodeStatus } = await _loadVideo(f, {
          onProgress: pct => el('trcRefInfoDecode', `Opening ProRes: ${pct}%`),
        });
        el('trcRefInfoDur',    `${video.duration.toFixed(2)}s`);
        el('trcRefInfoFps',    state.fps ? `${state.fps}` : '—');
        el('trcRefInfoDecode', _decodeStatusLabel(decodeStatus));
      } catch (err) {
        const hint = String(err?.message || 'Decode error')
          .replace(/^upload_failed_/i, 'Upload failed ')
          .replace(/_/g, ' ')
          .trim();
        el('trcRefInfoDur',    'Decode error');
        el('trcRefInfoDecode', hint || 'Decode error');
      }
      _saveFileHandles();
      // Auto-trigger: ref was the last piece to arrive
      if (state.timelineFile && state.analyzed && state.masterFiles.length
          && !state.matchHasRun && !state.visualMatchRunning) {
        _runVisualMatch().catch(() => {});
      }
    };

    _wireDropZone('trcDropRef', 'trcRefLabel', 'trcClearRef', '.mov', _onRefFiles);
    _$('trcBtnLoadRef')?.addEventListener('click', () => _openFilePicker('.mov', _onRefFiles));

    // ── Wire: Source ProRes ────────────────────────────────────────────
    const _onSourceFiles = (files, handles = null) => {
      if (!files) {
        state.masterFiles    = [];
        state._sourceHandles = [];
        state.sourceIndexed  = false;
        state.reelMap = [];
        state.eventCorrections = {};
        state.matchResults = {};
        state.matchHasRun = false;
        state.selectedEvId = null;
        state.analyzed = !!state.timelineFile && state.events.length > 0;
        const inner = _$('trcDropSourceInner');
        const info  = _$('trcSourceInfo');
        if (inner) inner.style.display = '';
        if (info)  info.style.display  = 'none';
        _$('trcClearMasters')?.setAttribute('style', 'display:none');
        _$('trcDropMasters')?.classList.remove('trc-drop-zone--loaded');
        _updateVerifyControls();
        _renderMatchResults();
        _renderExportSummary();
        _updateExportBtns();
        _updateMatchBtns();
        _updateStatusBadges();
        return;
      }
      files = _withNativePaths(files);
      const videoExts = /\.(mov)$/i;
      const filtered  = files.filter(f => videoExts.test(f.name));
      state.masterFiles    = filtered;
      state._sourceHandles = handles
        ? handles.filter((h, i) => videoExts.test(files[i]?.name || ''))
        : [];
      state.sourceIndexed = false;
      state.eventCorrections = {};
      state.matchResults = {};
      state.matchHasRun = false;
      state.selectedEvId = null;

      const inner = _$('trcDropSourceInner');
      const info  = _$('trcSourceInfo');
      if (inner) inner.style.display = 'none';
      if (info)  info.style.display  = '';
      const el = (id, v) => { const e = _$(id); if (e) e.textContent = v; };
      el('trcSourceInfoCount',   `${state.masterFiles.length}`);
      el('trcSourceInfoIndexed', 'Not indexed');
      el('trcSourceInfoDur',     '—');
      el('trcSourceInfoStatus',  state.masterFiles.length ? 'Ready to index' : 'No .mov files found');

      const cb = _$('trcClearMasters');
      if (cb) cb.style.display = '';
      _$('trcDropMasters')?.classList.add('trc-drop-zone--loaded');
      _updateMatchBtns();
      _updateStatusBadges();
      _saveFileHandles();
      // Auto-index by opening persistent AVFoundation sessions in the background.
      if (state.masterFiles.length) _autoIndexSource().catch(() => {});
      else {
        _renderMatchResults();
        _renderExportSummary();
        _updateExportBtns();
      }
    };

    _wireDropZone('trcDropMasters', 'trcMastersLabel', 'trcClearMasters', 'folder', _onSourceFiles);
    _$('trcBtnLoadSource')?.addEventListener('click', (e) => {
      e.stopPropagation();
      _openFilePicker('folder', _onSourceFiles);
    });

    // ── Wire: Build Reference Fingerprints ─────────────────────────────
    _$('trcBtnBuildFP')?.addEventListener('click', async () => {
      if (!state.refFile) return;
      const btn = _$('trcBtnBuildFP');
      if (btn) btn.disabled = true;
      const progWrap = _$('trcProgressWrap');
      const progCur  = _$('trcProgressCurrent');
      if (progWrap) progWrap.style.display = '';
      if (progCur)  progCur.textContent = 'Loading reference QT for fingerprinting…';
      _setMatchPhaseActive(1);
      try {
        await _loadVideo(state.refFile, {
          onProgress: pct => { if (progCur) progCur.textContent = `Opening ProRes: ${pct}%`; },
        });
        if (progCur) progCur.textContent = 'Reference fingerprints ready';
        _setMatchPhaseActive(2);
      } catch (err) {
        if (progCur) progCur.textContent = `Error: ${err.message}`;
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // ── Wire: Index Source Frames ──────────────────────────────────────
    _$('trcBtnIndexSource')?.addEventListener('click', async () => {
      if (!state.masterFiles.length) return;
      const btn = _$('trcBtnIndexSource');
      if (btn) btn.disabled = true;
      const progCur  = _$('trcProgressCurrent');
      const progWrap = _$('trcProgressWrap');
      const progBar  = _$('trcProgressBar');
      const progPct  = _$('trcProgressPct');
      if (progWrap) progWrap.style.display = '';
      if (progBar)  progBar.value = 0;
      if (progPct)  progPct.textContent = '0%';
      _setMatchPhaseActive(3);

      const _el = (id, v) => { const e = _$(id); if (e) e.textContent = v; };
      let totalDur = 0, ok = 0, failed = 0, nativeCount = 0;
      try {
        for (let i = 0; i < state.masterFiles.length; i++) {
          const f = state.masterFiles[i];
          const isMov = /\.mov$/i.test(f.name);
          if (progCur) progCur.textContent = `${i + 1}/${state.masterFiles.length}: ${_stem(f.name)}`;
          _el('trcSourceInfoIndexed', `${i + 1} / ${state.masterFiles.length}`);
          _el('trcSourceInfoStatus',  `${_stem(f.name)}…`);
          const pct = Math.round((i / state.masterFiles.length) * 100);
          if (progBar) progBar.value = pct;
          if (progPct) progPct.textContent = `${pct}%`;
          try {
            const { video, decodeStatus } = await _loadVideo(f, {
              onProgress: p => {
                if (progCur) progCur.textContent = `Opening ProRes ${_stem(f.name)}: ${p}%`;
                _el('trcSourceInfoStatus', `Direct ProRes: ${p}%`);
              },
            });
            totalDur += video.duration || 0;
            if (isMov && decodeStatus === 'native-avfoundation') nativeCount++;
            ok++;
          } catch (indexErr) {
            failed++;
            console.warn('[TrlConform] Failed to index source file', f.name, indexErr.message);
          }
        }
        state.sourceIndexed = ok === state.masterFiles.length && failed === 0;
        const durStr = totalDur >= 3600
          ? `${(totalDur / 3600).toFixed(1)} hr`
          : `${(totalDur / 60).toFixed(1)} min`;
        _el('trcSourceInfoIndexed', `${ok} / ${state.masterFiles.length}${nativeCount > 0 ? ` · ${nativeCount} direct ProRes` : ''}${failed ? ` · ${failed} FAILED` : ''}`);
        _el('trcSourceInfoDur',     totalDur > 0 ? durStr : '—');
        _el('trcSourceInfoStatus',  failed ? `${failed} file(s) could not be decoded — see console` : 'Ready');
        if (progCur) progCur.textContent = `${ok} source files indexed${nativeCount > 0 ? ` · ${nativeCount} direct ProRes` : ''}${failed ? ` · ${failed} failed (see console)` : ''}`;
        if (progBar) progBar.value = 100;
        if (progPct) progPct.textContent = '100%';
        _setMatchPhaseActive(4);
        _updateMatchBtns();
        _updateStatusBadges();
      } catch (err) {
        if (progCur) progCur.textContent = `Index error: ${err.message}`;
      } finally {
        if (btn) btn.disabled = false;
      }
    });

    // ── Wire: Run Match ────────────────────────────────────────────────
    _$('trcBtnRunMatch')?.addEventListener('click', async () => {
      if (!_confirmRerunWithApprovedRows()) return;
      try {
        await _runConform();
        await _runVisualMatch();
      } catch (err) {
        console.error('[TrlConform] Run match error', err);
      }
    });

    // ── Wire: Detect Shots (no EDL) ───────────────────────────────────
    _$('trcBtnDetectShots')?.addEventListener('click', () => {
      _runNoEdlDetect().catch(err => console.error('[TrlConform] no-EDL detect error', err));
    });

    // ── Wire: Stop ────────────────────────────────────────────────────
    _$('trcBtnStop')?.addEventListener('click', () => {
      state.visualMatchCancel = true;
    });

    // Whole-library search is on by default so choosing a master folder means
    // every weak shot is checked against that complete folder. AI remains an
    // explicit optional escalation because it may require a local model load.
    _$('trcOptDeepSearch')?.addEventListener('change', (e) => {
      const enabled = !!e.target.checked;
      state.multiMasterFallback = enabled;
    });

    // ── Wire: Reset Match ─────────────────────────────────────────────
    _$('trcBtnResetMatch')?.addEventListener('click', () => {
      const approvedCount = Object.values(state.matchResults).filter(r => r.approved).length;
      const msg = approvedCount > 0
        ? `You've already approved ${approvedCount} match${approvedCount === 1 ? '' : 'es'} — resetting will discard all match results and corrections, including approved rows. This cannot be undone. Continue?`
        : 'Reset all match results and corrections? This cannot be undone.';
      if (!confirm(msg)) return;
      state.eventCorrections   = {};
      state.matchResults       = {};
      state._refImageData      = null;
      state._srcImageData      = null;
      state._verifyEvId        = null;
      state.selectedEvId       = null;
      state.matchHasRun        = false;
      const resetBtn = _$('trcBtnResetMatch');
      if (resetBtn) resetBtn.style.display = 'none';
      const progWrap = _$('trcProgressWrap');
      if (progWrap) progWrap.style.display = 'none';
      const slipEl = _$('trcSlipSummary');
      if (slipEl) slipEl.style.display = 'none';
      _renderMatchResults();
      _updateVerifyControls();
      _renderExportSummary();
      _updateStatusBadges();
      _updateExportBtns();
    });

    // ── Wire: Export buttons ──────────────────────────────────────────
    _$('trcBtnExportXML')?.addEventListener('click', _exportCorrectedXML);

    // ── Wire: Export options checkboxes ───────────────────────────────
    const _wireCheck = (id, key) => {
      _$(id)?.addEventListener('change', (e) => {
        state.exportOptions[key] = e.target.checked;
        _renderExportSummary();
        _updateExportBtns();
        _updateStatusBadges();
      });
    };
    _wireCheck('trcOptOnlyApproved',    'onlyApproved');
    _wireCheck('trcOptIncludeReview',   'includeApprovedReview');
    _wireCheck('trcOptLeaveFailUnchanged', 'leaveFailedUnchanged');
    _wireCheck('trcOptRelativePaths',   'relativePaths');
    _wireCheck('trcOptAddNotes',        'addNotes');

    // ── Wire: Approve all SAFE rows in one click ───────────────────────
    _$('trcBtnApproveAllSafe')?.addEventListener('click', () => {
      const visibleEvents = _getVisibleEvents();
      for (const ev of visibleEvents) {
        if (_computeRowStatus(ev.id) !== 'SAFE') continue;
        const meta = _getMatchMeta(ev.id);
        if (!meta.status || meta.status === 'UNMATCH') meta.status = 'SAFE';
        meta.approved = true;
        meta.decision = 'approved';
      }
      _renderMatchResults();
      _renderExportSummary();
      _updateStatusBadges();
      _updateExportBtns();
    });

    // ── Wire: Results worklist filter (render-only) ───────────────────
    _$('trcResultsFilter')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.trc-filter-btn');
      if (!btn) return;
      const next = btn.dataset.filter || 'all';
      if (state.resultsFilter === next) return;
      state.resultsFilter = next;
      _renderMatchResults();
    });

    // ── Wire: Verify approve/reject/review ────────────────────────────
    _$('trcBtnApproveMatch')?.addEventListener('click', () => {
      if (state.selectedEvId == null) return;
      const decidedEvId = state.selectedEvId;
      _recordDecisionHistory(decidedEvId);
      const meta = _getMatchMeta(decidedEvId);
      const algorithmicStatus = _computeRowStatus(decidedEvId);
      if (!meta.status || meta.status === 'UNMATCH') {
        meta.status = (algorithmicStatus === 'FAIL' || algorithmicStatus === 'UNMATCH') ? 'REVIEW' : algorithmicStatus;
      }
      meta.approved = true;
      meta.decision = 'approved';
      _renderMatchResults();
      _renderExportSummary();
      _updateStatusBadges();
      _updateExportBtns();
      _advanceAfterDecision(decidedEvId);
    });

    _$('trcBtnRejectMatch')?.addEventListener('click', () => {
      if (state.selectedEvId == null) return;
      const decidedEvId = state.selectedEvId;
      _recordDecisionHistory(decidedEvId);
      const meta = _getMatchMeta(decidedEvId);
      meta.status   = 'FAIL';
      meta.approved = false;
      meta.decision = 'rejected';
      _renderMatchResults();
      _renderExportSummary();
      _updateStatusBadges();
      _updateExportBtns();
      _advanceAfterDecision(decidedEvId);
    });

    _$('trcBtnMarkReview')?.addEventListener('click', () => {
      if (state.selectedEvId == null) return;
      const decidedEvId = state.selectedEvId;
      _recordDecisionHistory(decidedEvId);
      const meta = _getMatchMeta(decidedEvId);
      meta.status = 'REVIEW';
      if (meta.approved !== true) meta.approved = false;
      meta.decision = null;
      _renderMatchResults();
      _renderExportSummary();
      _updateStatusBadges();
      _updateExportBtns();
      _advanceAfterDecision(decidedEvId);
    });

    // ── Wire: Close verify ────────────────────────────────────────────
    _$('trcCloseVerify')?.addEventListener('click', () => {
      state.selectedEvId = null;
      _teardownVerifyVideos();
      const labelEl = _$('trcVerifyEventLabel');
      if (labelEl) labelEl.textContent = '—';
      const waveOffsetEl = _$('trcWaveOffset');
      if (waveOffsetEl) waveOffsetEl.textContent = '—';
      _drawVerifyPlaceholder('trcRefCanvas', 'Reference frame');
      _drawVerifyPlaceholder('trcSrcCanvas', 'Matched source frame');
      _updateVerifyControls();
      _renderMatchResults();
    });

    // ── Wire: Review queue navigation ─────────────────────────────────
    _$('trcBtnPrevReview')?.addEventListener('click', () => _navigateReview(-1, false));
    _$('trcBtnNextReview')?.addEventListener('click', () => _navigateReview(1, false));
    _$('trcBtnNextAttention')?.addEventListener('click', () => _navigateReview(1, true));
    _$('trcBtnOpenAttention')?.addEventListener('click', () => _navigateReview(1, true));
    _$('trcBtnAutoNext')?.addEventListener('click', () => {
      state.autoAdvanceReview = !state.autoAdvanceReview;
      _updateVerifyControls();
    });
    _$('trcBtnUndoDecision')?.addEventListener('click', _undoLastDecision);
    _$('trcNleGoStart')?.addEventListener('click', () => { _seekVerifyProgress(0); });
    _$('trcNleStepBack')?.addEventListener('click', () => _stepVerifyFrame(-1));
    _$('trcNlePlay')?.addEventListener('click', () => { _toggleVerifyPlayback(); });
    _$('trcNleStepForward')?.addEventListener('click', () => _stepVerifyFrame(1));
    _$('trcNleGoEnd')?.addEventListener('click', () => { _seekVerifyProgress(1); });
    _$('trcNleLoop')?.addEventListener('click', () => {
      state.loopPlayback = !state.loopPlayback;
      if (state._refVideoEl) state._refVideoEl.loop = state.loopPlayback;
      if (state._srcVideoEl) state._srcVideoEl.loop = state.loopPlayback;
      _updateLoopUi();
    });

    const scrubTimelineFromEvent = (event) => {
      const lanes = _$('trcNleLanes');
      if (!lanes || state.selectedEvId == null) return;
      const rect = lanes.getBoundingClientRect();
      if (!rect.width) return;
      _seekVerifyProgress((event.clientX - rect.left) / rect.width);
    };
    _$('trcNleLanes')?.addEventListener('pointerdown', (event) => {
      state._timelineScrubbing = true;
      event.currentTarget.setPointerCapture?.(event.pointerId);
      scrubTimelineFromEvent(event);
    });
    _$('trcNleLanes')?.addEventListener('pointermove', (event) => {
      if (state._timelineScrubbing) scrubTimelineFromEvent(event);
    });
    window.addEventListener('pointerup', () => { state._timelineScrubbing = false; }, true);

    // Beginner-friendly guide and Simple / Pro detail switch.
    _$('trcBtnCoach')?.addEventListener('click', () => {
      const targetId = _$('trcBtnCoach')?.dataset.target;
      const target = targetId ? _$(targetId) : null;
      if (!target) return;
      if (target.matches('button:not(:disabled)')) target.click();
      else target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    _$('trcBtnMediaNext')?.addEventListener('click', () => {
      const targetId = _$('trcBtnMediaNext')?.dataset.target;
      const target = targetId ? _$(targetId) : null;
      if (!target) return;
      if (target.matches('button:not(:disabled)')) {
        target.click();
        return;
      }
      target.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      target.classList.add('trc-panel-pulse');
      window.setTimeout(() => target.classList.remove('trc-panel-pulse'), 850);
    });

    _$('trcBtnModeToggle')?.addEventListener('click', (e) => {
      const uiRoot = _$('trcRoot');
      if (!uiRoot) return;
      const simple = uiRoot.classList.toggle('trc-simple-mode');
      e.currentTarget.textContent = simple ? 'Advanced controls' : 'Guided controls';
      e.currentTarget.setAttribute('aria-pressed', simple ? 'false' : 'true');
      e.currentTarget.title = simple
        ? 'Show advanced matching and engineering controls'
        : 'Return to the guided non-technical workflow';
      _syncReviewFocus();
    });

    _root?.querySelectorAll('.trc-workspace-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        const stage = tab.dataset.stage;
        if (stage === 'review' && state.matchHasRun) {
          const attention = _getAttentionEvents({ unresolvedOnly: true });
          if (attention.length) {
            _selectRow(attention[0].id);
            return;
          }
        }
        const target = _$(tab.dataset.target);
        target?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        target?.classList.add('trc-panel-pulse');
        window.setTimeout(() => target?.classList.remove('trc-panel-pulse'), 850);
      });
    });

    // NLE keyboard controls only activate inside the focused review workspace.
    // Text fields keep their normal typing behaviour.
    window.addEventListener('keydown', (e) => {
      if (!_$('trcRoot')?.classList.contains('trc-review-focus')) return;
      if (state.selectedEvId == null) return;
      const tag = String(e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      const key = e.key.toLowerCase();
      if (key === 'escape') {
        e.preventDefault();
        _$('trcCloseVerify')?.click();
      } else if (key === ' ' || key === 'spacebar') {
        e.preventDefault();
        _$('trcNlePlay')?.click();
      } else if (key === 'arrowleft') {
        e.preventDefault();
        _stepVerifyFrame(-1);
      } else if (key === 'arrowright') {
        e.preventDefault();
        _stepVerifyFrame(1);
      } else if (key === 'arrowup') {
        e.preventDefault();
        _navigateReview(-1, false);
      } else if (key === 'arrowdown') {
        e.preventDefault();
        _navigateReview(1, false);
      } else if (key === 'home') {
        e.preventDefault();
        _seekVerifyProgress(0);
      } else if (key === 'end') {
        e.preventDefault();
        _seekVerifyProgress(1);
      } else if (key === 'j') {
        e.preventDefault();
        _stepVerifyFrame(-1);
      } else if (key === 'k') {
        e.preventDefault();
        _stopNativeVerifyPlayback();
        try { state._refVideoEl?.pause?.(); state._srcVideoEl?.pause?.(); } catch {}
      } else if (key === 'l') {
        e.preventDefault();
        if (e.shiftKey) {
          _$('trcNleLoop')?.click();
          return;
        }
        const playing = state._verifyNativePlaying || [state._refVideoEl, state._srcVideoEl]
          .some(video => video && !video._pfxNativeFrameSource && !video.paused && !video.ended);
        if (!playing) _toggleVerifyPlayback();
      } else if (['1', '2', '3', '4'].includes(key)) {
        e.preventDefault();
        const mode = ['side', 'wipe', 'overlay', 'diff'][Number(key) - 1];
        _root?.querySelector(`.trc-view-mode-btn[data-mode="${mode}"]`)?.click();
      } else if (key === 'a') {
        e.preventDefault();
        _$('trcBtnApproveMatch')?.click();
      } else if (key === 'x') {
        e.preventDefault();
        _$('trcBtnRejectMatch')?.click();
      } else if (key === 'd') {
        e.preventDefault();
        _$('trcBtnMarkReview')?.click();
      } else if (key === 'u') {
        e.preventDefault();
        _undoLastDecision();
      }
    }, true);

    // ── Wire: Sync scrub toggle ────────────────────────────────────────
    _$('trcBtnSyncScrub')?.addEventListener('click', () => {
      _stopNativeVerifyPlayback();
      try { state._refVideoEl?.pause?.(); state._srcVideoEl?.pause?.(); } catch {}
      state.syncScrub = !state.syncScrub;
      _updateGangUi();
      const line = _$('trcVerifyConfidenceLine');
      if (line && state.selectedEvId != null) {
        line.style.display = '';
        line.textContent = state.syncScrub
          ? 'GANG ON · Trailer Reference and Original Master will play and step together'
          : 'GANG OFF · Trailer Reference can be checked independently';
      }
    });

    // ── Wire: View mode buttons ───────────────────────────────────────
    _root?.querySelectorAll('.trc-view-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _root.querySelectorAll('.trc-view-mode-btn').forEach(b => {
          b.classList.remove('is-active');
          b.setAttribute('aria-pressed', 'false');
        });
        btn.classList.add('is-active');
        btn.setAttribute('aria-pressed', 'true');
        const mode = btn.dataset.mode;
        state.verifyMode = mode;
        if (mode === 'side' && state._verifyEvId != null) {
          _applyVerifyMode('side');
        } else if (state._refImageData && state._srcImageData) {
          _applyVerifyMode(mode);
        }
      });
    });

    // ── Wire: Manual adjustment buttons ──────────────────────────────
    _root?.querySelectorAll('.trc-adj-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (state.selectedEvId == null) return;
        const delta = parseInt(btn.dataset.delta, 10);
        if (!Number.isFinite(delta)) return;
        const fps = state.fps || DEFAULT_FPS;
        const ev  = state.events.find(e => e.id === state.selectedEvId);
        if (!ev) return;
        const corr = state.eventCorrections[state.selectedEvId];
        const srcInF  = corr ? _tcToFrames(corr.srcIn,  fps) : (ev._srcInFrames  ?? _tcToFrames(ev.srcIn,  fps));
        const srcOutF = corr ? _tcToFrames(corr.srcOut, fps) : (ev._srcOutFrames ?? _tcToFrames(ev.srcOut, fps));
        const newInF  = Math.max(0, srcInF  + delta);
        const newOutF = Math.max(0, srcOutF + delta);
        state.eventCorrections[state.selectedEvId] = {
          ...(corr || {}),
          srcIn:  _framesToTC(newInF,  fps),
          srcOut: _framesToTC(newOutF, fps),
          method: 'manual',
        };
        // Mark as manual override
        if (!state.matchResults[state.selectedEvId]) {
          state.matchResults[state.selectedEvId] = { status: 'MANUAL', approved: false, decision: null, notes: '' };
        } else {
          state.matchResults[state.selectedEvId].status = 'MANUAL';
          state.matchResults[state.selectedEvId].approved = false;
          state.matchResults[state.selectedEvId].decision = null;
        }
        // Update waveform offset display
        const waveOffsetEl = _$('trcWaveOffset');
        if (waveOffsetEl) {
          const origF = ev._srcInFrames ?? _tcToFrames(ev.srcIn, fps);
          const adjDelta = newInF - origF;
          waveOffsetEl.textContent = adjDelta === 0 ? '0f' : (adjDelta > 0 ? `+${adjDelta}f` : `${adjDelta}f`);
        }
        _renderMatchResults();
        _renderExportSummary();
        _updateStatusBadges();
        _updateExportBtns();
        // Reload verify frames with new offset
        _loadVerifyFrames(state.selectedEvId).catch(() => {});
      });
    });

    // ── Wire: Results table action delegation ─────────────────────────
    _$('trcResultsBody')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.trc-act-btn');
      if (!btn) {
        const row = e.target.closest('tr[data-evid]');
        if (!row) return;
        const evId = parseInt(row.dataset.evid, 10);
        if (Number.isFinite(evId)) _selectRow(evId);
        return;
      }
      const evId = parseInt(btn.dataset.evid, 10);
      if (!Number.isFinite(evId)) return;
      const act = btn.dataset.act;

      if (act === 'view') {
        _selectRow(evId);
        return;
      }

      if (act === 'approve' || act === 'review' || act === 'reject') {
        _recordDecisionHistory(evId);
      }
      const meta = _getMatchMeta(evId);

      if (act === 'approve') {
        const algStatus = _computeRowStatus(evId);
        if (!meta.status || meta.status === 'UNMATCH') {
          meta.status = (algStatus === 'FAIL' || algStatus === 'UNMATCH') ? 'REVIEW' : algStatus;
        }
        meta.approved = true;
        meta.decision = 'approved';
      } else if (act === 'review') {
        meta.status = 'REVIEW';
        if (meta.approved !== true) meta.approved = false;
        meta.decision = null;
      } else if (act === 'reject') {
        meta.status   = 'FAIL';
        meta.approved = false;
        meta.decision = 'rejected';
      } else if (act === 'manual') {
        meta.status = 'MANUAL';
        meta.approved = false;
        meta.decision = null;
        _selectRow(evId);
        return;
      }

      _renderMatchResults();
      _renderExportSummary();
      _updateStatusBadges();
      _updateExportBtns();
    });

    // ── Wire: Manual reel-to-source override "Fix" dropdown (#1) ───────
    // Delegated on the unmatched-reels strip so it survives _renderMatchResults()
    // re-rendering its innerHTML every time.
    _$('trcResultsUnmatchedReels')?.addEventListener('change', (e) => {
      const select = e.target.closest('.trc-fix-reel-select');
      if (!select) return;
      const proxyName = select.dataset.proxy;
      const fileName  = select.value;
      if (!proxyName || !fileName) return;

      const chosenFile = (state.masterFiles || []).find(f => f.name === fileName);
      if (!chosenFile) return;

      const entry = (state.reelMap || []).find(r => r.proxyName === proxyName);
      if (!entry) return;

      // Point this reel at the chosen source file — same fields _buildReelMap
      // sets for an automatic exact match, so downstream code (matching,
      // _applyReelSlips, export) treats it identically to an auto-detected one.
      entry.masterFile = chosenFile;
      entry.masterName = chosenFile.name;
      entry.masterEp   = _extractEpNum(chosenFile.name);
      entry.score      = 100;
      entry.status     = 'matched';
      entry.manualOverride = true;
      _applyTcOffsets(state.reelMap, state.fileTcOffsets);

      _rematchReelEvents(entry).catch(err => {
        console.error('[TrlConform] Manual reel override re-match failed', err);
      });
    });

    // Initialize state
    _drawVerifyPlaceholder('trcRefCanvas', 'Reference frame');
    _drawVerifyPlaceholder('trcSrcCanvas', 'Matched source frame');
    _drawWaveformPlaceholder('trcWaveRef', 42, 0.5, '#56d2c6');
    _drawWaveformPlaceholder('trcWaveSrc', 137, 0.5, '#f6b562');
    _updateVerifyControls();
    _updateMatchBtns();
    _updateExportBtns();
    _renderExportSummary();
    _updateStatusBadges();

    // Restore previously loaded files from IndexedDB
    // Defined here so it can close over _onCutFiles / _onRefFiles / _onSourceFiles.
    async function _restoreFileHandles() {
    const saved = await _idbGetHandles();
    if (!saved) return;

    // ── Restore "last matched" timestamp badge (#7) ──────────────────────
    if (!state.lastMatchedAt && saved.lastMatchedAt) {
      state.lastMatchedAt = saved.lastMatchedAt;
      _updateStatusBadges();
    }

    // ── Restore XML (text fallback — no permission needed) ──────────────
    if (!state.timelineFile && saved.cutText && saved.cutName) {
      const blob = new Blob([saved.cutText], { type: 'text/xml' });
      const file = new File([blob], saved.cutName, { type: 'text/xml' });
      _onCutFiles([file], saved.cutHandle ? [saved.cutHandle] : null);
      // Restore FSA handle reference — _onCutFiles may have set it, but ensure it's right
      if (saved.cutHandle) state._cutHandle = saved.cutHandle;
    }

    // ── Restore Ref QT via FSA handle ────────────────────────────────────
    if (!state.refFile && saved.refHandle) {
      const perm = await _queryHandlePermission(saved.refHandle);
      if (perm === 'granted') {
        const file = await saved.refHandle.getFile().catch(() => null);
        if (file) _onRefFiles([file], [saved.refHandle]);
      } else {
        _showReAuthChip('trcDropRef', saved.refName, async () => {
          const p = await _requestHandlePermission(saved.refHandle);
          if (p === 'granted') {
            const f = await saved.refHandle.getFile().catch(() => null);
            if (f) _onRefFiles([f], [saved.refHandle]);
          }
        });
      }
    }

    // ── Restore Source MOVs via FSA handles ──────────────────────────────
    if (!state.masterFiles.length && saved.sourceHandles?.length) {
      const handles  = saved.sourceHandles;
      const perms    = await Promise.all(handles.map(h => _queryHandlePermission(h)));
      const allOk    = perms.every(p => p === 'granted');
      if (allOk) {
        const resolved = await Promise.all(handles.map(async h => {
          const f = await h.getFile().catch(() => null);
          return f ? { h, f } : null;
        }));
        const valid = resolved.filter(Boolean);
        if (valid.length) _onSourceFiles(valid.map(p => p.f), valid.map(p => p.h));
      } else {
        _showReAuthChip('trcDropMasters', saved.sourceName || `${handles.length} files`, async () => {
          // Fire all requestPermission calls in parallel — sequential awaits consume the
          // user gesture activation so only the first handle would be granted in a loop.
          const perms = await Promise.all(handles.map(h => _requestHandlePermission(h)));
          const pairs = await Promise.all(
            handles.map(async (h, i) => {
              if (perms[i] !== 'granted') return null;
              const f = await h.getFile().catch(() => null);
              return f ? { h, f } : null;
            })
          );
          const valid = pairs.filter(Boolean);
          if (valid.length) _onSourceFiles(valid.map(p => p.f), valid.map(p => p.h));
        });
      }
    }
    }  // end _restoreFileHandles

    _restoreFileHandles().catch(() => {});
  }  // end mount()

  // Show a small "Re-authorize" chip inside a drop zone when permission needs refresh
  function _showReAuthChip(zoneId, name, onClick) {
    const zone = _$(zoneId);
    if (!zone) return;
    // Remove existing chip first
    zone.querySelector('.trc-reauth-chip')?.remove();
    const chip = document.createElement('button');
    chip.className = 'trc-reauth-chip';
    chip.setAttribute('style',
      'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
      'gap:5px;background:rgba(8,10,20,0.82);border:none;cursor:pointer;border-radius:6px;' +
      'color:#6a88c8;font-size:9px;font-family:inherit;font-weight:600;letter-spacing:.03em;z-index:2;'
    );
    chip.innerHTML = `<svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M2 8a6 6 0 1 0 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M2 4v4h4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg> Re-authorize: ${_esc(name)}`;
    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      chip.remove();
      await onClick();
    });
    zone.style.position = 'relative';
    zone.appendChild(chip);
  }

  // ── Public API ────────────────────────────────────────────────────────

  function clear() {
    state.timelineFile       = null;
    state.timelineText       = '';
    state.events             = [];
    state.fps                = DEFAULT_FPS;
    state.fpsExact           = DEFAULT_FPS;
    state.projectName        = '';
    state.masterFiles        = [];
    state.reelMap            = [];
    state.analyzed           = false;
    state.refFile            = null;
    state.eventCorrections   = {};
    state.visualMatchRunning = false;
    state.visualMatchCancel  = false;
    state.aiMode             = false;
    state.aiModelLoading     = false;
    state.matchHasRun        = false;
    state.lastMatchedAt      = null;
    state.epId               = null;
    state.matchResults       = {};
    state.selectedEvId       = null;
    state.verifyMode         = 'side';
    state.sourceIndexed      = false;
    state.exportOptions      = {
      onlyApproved:           true,
      includeApprovedReview:  false,
      leaveFailedUnchanged:   true,
      relativePaths:          false,
      addNotes:               false,
    };
    state._refImageData      = null;
    state._srcImageData      = null;
    state._verifyEvId        = null;
    state._cutHandle         = null;
    state._refHandle         = null;
    state._sourceHandles     = [];
    _idbSaveHandles(null);  // wipe persisted handles on explicit clear
    // Tear down live-verify playback before mount() wipes the DOM — otherwise the
    // native media sessions, transport listeners, blob URLs, <video> elements and
    // the rAF loop leak (mount() detaches the DOM but never releases them).
    _teardownVerifyVideos();
    if (_root) mount();
  }

  function onTabActivated() {}

  function exportState() {
    if (!state.analyzed) return null;
    return {
      events:           state.events,
      fps:              state.fps,
      fpsExact:         state.fpsExact,
      projectName:      state.projectName,
      epId:             state.epId,
      reelMap:          state.reelMap.map(r => ({
        proxyName:  r.proxyName,
        proxyEp:    r.proxyEp,
        masterName: r.masterName,
        masterEp:   r.masterEp,
        score:      r.score,
        status:     r.status,
        tcOffset:   r.tcOffset,
        manualOverride: r.manualOverride || false,
      })),
      eventCorrections: state.eventCorrections,
      matchResults:     state.matchResults,
      exportOptions:    state.exportOptions,
      lastMatchedAt:    state.lastMatchedAt,
      analyzed:         true,
    };
  }

  function applyState(saved) {
    if (!saved?.analyzed) { clear(); return; }
    state.events           = saved.events           || [];
    state.fps              = saved.fps              || DEFAULT_FPS;
    // Sessions saved before this field existed restore with base === exact.
    state.fpsExact         = saved.fpsExact         || state.fps;
    state.projectName      = saved.projectName      || '';
    state.epId             = saved.epId             ?? null;
    state.eventCorrections = saved.eventCorrections || {};
    state.matchResults     = saved.matchResults     || {};
    state.exportOptions    = { ...state.exportOptions, ...(saved.exportOptions || {}) };
    state.lastMatchedAt    = saved.lastMatchedAt     ?? null;
    state.analyzed         = true;
    state.matchHasRun      = Object.keys(state.eventCorrections).length > 0;
    state.reelMap = (saved.reelMap || []).map(r => ({ ...r, masterFile: null }));
    state.masterFiles  = [];
    state.timelineFile = null;
    state.refFile      = null;
    if (_root) {
      try { _renderMatchResults(); } catch {}
      try { _renderExportSummary(); } catch {}
      try { _updateVerifyControls(); } catch {}
      try { _updateMatchBtns();   } catch {}
      try { _updateExportBtns();  } catch {}
      try { _updateStatusBadges();} catch {}
    }
  }

  // ── Render Queue handler ──────────────────────────────────────────────
  window.__rqExportHandlers = window.__rqExportHandlers || {};
  window.__rqExportHandlers['trlconf'] = async (fmt) => {
    if (fmt === 'edl') await _exportEDL();
    if (fmt === 'xml') _exportCorrectedXML();
    if (fmt === 'csv') _exportCSVPullList();
    if (fmt === 'json') _exportMatchReportJSON();
  };

  // conformNoEdl — CV-detect shots + whole-library search + over-split repair
  // (V1.4 no-EDL workflow). Loads the current reference directly, returns
  // { shots, threshold, warnings, matches } without mutating render state. UI
  // wiring (a "Detect shots (no EDL)" action) is the remaining integration.
  async function conformNoEdl(opts = {}) {
    if (!state.refFile) throw new Error('Load a reference/offline first');
    const rd = await _loadVideo(state.refFile);
    try {
      return await _detectAndMatchNoEdl(rd.video, state.fps || DEFAULT_FPS, opts);
    } finally {
      if (rd.url) URL.revokeObjectURL(rd.url);
    }
  }

  // Turn a conformNoEdl() result into synthetic events + corrections + reel map
  // so the EXISTING results table / verify panel / exporters render it unchanged.
  function _applyNoEdlResult(result) {
    const fps = state.fps || DEFAULT_FPS;
    const statusMap = { OK: 'SAFE', REVIEW: 'REVIEW', NO_MATCH: 'FAIL' };
    const events = [];
    const corrections = {};

    (result.matches || []).forEach((m, i) => {
      const id = i;
      const masterName = m.masterName || '';
      const proxyKey = masterName || `shot_${i + 1}`;
      const shotLen = Math.max(1, m.offlineEnd - m.offlineStart + 1);
      // For NO_MATCH shots (no correction below) give the event a shot-length
      // source span so the exported EDL shows a real duration rather than a
      // zero-length 00:00:00:00→00:00:00:00 (mirrors V1.4 write_edl).
      events.push({
        id, type: 'video', disabled: false,
        clipName: `Shot ${i + 1}`,
        reel: proxyKey, srcFile: masterName,
        srcIn: '00:00:00:00', srcOut: _framesToTC(shotLen, fps),
        recIn: _framesToTC(m.offlineStart, fps), recOut: _framesToTC(m.offlineEnd + 1, fps),
        fps,
        _srcInFrames: 0, _srcOutFrames: shotLen,
        _recInFrames: m.offlineStart, _recOutFrames: m.offlineEnd + 1,
      });
      if (masterName) {
        corrections[id] = {
          srcIn:  _framesToTC(Math.max(0, m.masterStart), fps),
          srcOut: _framesToTC(Math.max(0, m.masterEnd + 1), fps),
          confidence: m.confidence,
          visualConfidence: m.confidence,
          audioConfidence: null,
          finalConfidence: m.confidence,
          status: statusMap[m.status] || 'FAIL',
          method: m.merged ? 'no_edl_cv_detect_merged' : 'no_edl_cv_detect',
          masterName, masterFileName: masterName, matchedSourceFile: masterName,
          sourceSpanFrames: Math.max(0, m.masterEnd - m.masterStart + 1),
          samplesUsed: 1, consistentSamples: 1, offsetVarianceFrames: 0,
          distance: m.visualDistance ?? m.distance ?? null,
          visualDistance: m.visualDistance ?? m.distance ?? null,
          visualStatus: m.visualStatus || m.status || null,
          pictureEvidenceVersion: Number.isFinite(m.visualDistance ?? m.distance) ? 'V1.4' : null,
        };
      }
    });

    // One reel-map row per unique master so the results table shows its name.
    const seen = new Set();
    const reelMap = [];
    for (const ev of events) {
      if (seen.has(ev.reel)) continue;
      seen.add(ev.reel);
      reelMap.push({
        proxyName: ev.reel, proxyEp: null, masterFile: null,
        masterName: ev.srcFile || '', masterEp: null,
        score: ev.srcFile ? 100 : 0,
        status: ev.srcFile ? 'matched' : 'unmatched', tcOffset: 0,
      });
    }

    state.events           = events;
    state.reelMap          = reelMap;
    state.eventCorrections = corrections;
    state.matchResults     = {};
    state.analyzed         = true;
    state.matchHasRun      = true;
    state.noEdlMode        = true;
    if (!state.projectName) state.projectName = 'No-EDL Conform';

    try { window.MPS_markProjectDirty?.('trl conf'); } catch {}
    _renderMatchResults();
    _updateStatusBadges();
    _updateMatchBtns();
    _updateExportBtns();
  }

  // Driver for the "Detect Shots (no EDL)" button: run detection + whole-library
  // match + over-split repair, then render through the normal results pipeline.
  async function _runNoEdlDetect() {
    if (state.visualMatchRunning) return;
    if (!state.refFile) { alert('Load a reference/offline video first.'); return; }
    if (!(state.masterFiles || []).length) { alert('Add at least one master/source file first.'); return; }
    // Guard against silently discarding a loaded agency timeline — no-EDL
    // detection replaces state.events with picture-detected shots.
    if (state.timelineFile || (state.events && state.events.length)) {
      const approved = Object.values(state.matchResults).filter(r => r.approved).length;
      const msg = approved > 0
        ? `Detect Shots (no EDL) replaces the loaded timeline and its ${approved} approved match(es) with picture-detected shots. This cannot be undone. Continue?`
        : 'Detect Shots (no EDL) replaces the loaded timeline/events with picture-detected shots. Continue?';
      if (!confirm(msg)) return;
    }

    const progWrap = _$('trcProgressWrap');
    const progBar  = _$('trcProgressBar');
    const progPct  = _$('trcProgressPct');
    const progCur  = _$('trcProgressCurrent');
    const detectBtn = _$('trcBtnDetectShots');
    const runBtn    = _$('trcBtnRunMatch');
    const stopBtn   = _$('trcBtnStop');

    state.visualMatchRunning = true;
    state.visualMatchCancel  = false;
    if (detectBtn) detectBtn.disabled = true;
    if (runBtn)    runBtn.disabled = true;
    if (stopBtn)   stopBtn.style.display = '';
    if (progWrap)  progWrap.style.display = '';
    if (progBar)   progBar.value = 0;
    if (progCur)   progCur.textContent = 'Detecting shots by picture…';

    const setProg = (p, msg) => {
      if (progBar) progBar.value = p;
      if (progPct) progPct.textContent = `${p}%`;
      if (progCur && msg) progCur.textContent = msg;
    };

    try {
      const result = await conformNoEdl({
        onDetectProgress: pct => setProg(Math.round(pct * 0.4), `Detecting shots… ${pct}%`),
        onMatchProgress:  (done, total) => setProg(40 + Math.round((done / total) * 55), `Matching shot ${done}/${total} against library…`),
        shouldCancel: () => state.visualMatchCancel,
      });
      _applyNoEdlResult(result);
      setProg(100);
      const n  = result.matches.length;
      const ok = result.matches.filter(m => m.status !== 'NO_MATCH').length;
      const warn = result.warnings && result.warnings.length ? ` · ${result.warnings[0]}` : '';
      if (progCur) progCur.textContent = state.visualMatchCancel
        ? `Cancelled — ${n} shot(s) detected`
        : `Detected ${result.shots.length} shot(s) · matched ${ok}/${n}${warn}`;
    } catch (err) {
      if (progCur) progCur.textContent = `Error: ${err.message}`;
      console.error('[TrlConform] no-EDL detect error', err);
    } finally {
      state.visualMatchRunning = false;
      if (stopBtn) stopBtn.style.display = 'none';
      _updateMatchBtns();
    }
  }

  return { mount, onTabActivated, clear, exportState, applyState, conformNoEdl };
}
