// scripts/features/trlconf/index.js
import { loadModel, extractEmbedding, searchMasterAI, isReady as aiReady, AI_W, AI_H } from './ai_matcher.js';
import { sharedMediaOpen, nativeHelperPing } from '../../modules/native_helper_client.js';
import { getProxyStreamUrl, tryRestoreProxyForMeta } from '../../modules/proResProxy.js';
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

function _tcToFrames(tc, fps = DEFAULT_FPS) {
  const m = String(tc || '').trim().match(/^(\d{2})[:;](\d{2})[:;](\d{2})[:;](\d{2})$/);
  if (!m) return 0;
  const [, hh, mm, ss, ff] = m.map(Number);
  return ((hh * 3600 + mm * 60 + ss) * fps) + ff;
}

function _framesToTC(frames, fps = DEFAULT_FPS) {
  frames = Math.max(0, Math.round(frames));
  const ff = frames % fps;
  const totalS = Math.floor(frames / fps);
  const ss = totalS % 60;
  const mm = Math.floor(totalS / 60) % 60;
  const hh = Math.floor(totalS / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}`;
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

  // Pattern: _NNN_ or _NNN at end (3-digit episode number)
  let m = s.match(/_(\d{3})(?:_|$)/);
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
    if (ev.disabled || ev.type !== 'video') continue;

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

// Compute mean hash from a 2D context drawn at _HASH_W × _HASH_H.
function _computeHash(ctx) {
  const data = ctx.getImageData(0, 0, _HASH_W, _HASH_H).data;
  const gray = new Float32Array(_HASH_BITS);
  let sum = 0;
  for (let i = 0; i < _HASH_BITS; i++) {
    const p = i * 4;
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    sum += gray[i];
  }
  const mean = sum / _HASH_BITS;
  const bits = new Uint8Array(_HASH_BITS);
  for (let i = 0; i < _HASH_BITS; i++) bits[i] = gray[i] >= mean ? 1 : 0;
  return bits;
}

// Hamming distance (number of differing bits) between two 576-bit hashes.
function _hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < _HASH_BITS; i++) if (a[i] !== b[i]) d++;
  return d;
}

// Draw current video frame to canvas and return hash.
function _grabHash(video, canvas, ctx) {
  ctx.drawImage(video, 0, 0, _HASH_W, _HASH_H);
  return _computeHash(ctx);
}

// Average luma (0–100) of the current _HASH_W×_HASH_H canvas draw.
// Call after _grabHash (reuses the same pixel read).
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

// ── Similarity helpers ────────────────────────────────────────────────────

// Mean-hash similarity: fraction of matching bits → 0–100.
function _mHashSimilarity(a, b) {
  return Math.round((1 - _hammingDistance(a, b) / _HASH_BITS) * 100);
}

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

// Weighted visual confidence per spec formula (visual terms only):
//   0.25·luma + 0.30·spatial + 0.15·edge + 0.10·pHash + 0.05·duration
// Weights sum to 0.85; result is normalised to 0–100 over visual terms.
// The remaining 0.15 is the audio/envelope term, blended in at the call site
// once envelope correlation is available (finalConfidence = 0.85·visual + 0.15·audio).
function _weightedFrameSimilarity({ spatialSim, pHashSim, edgeSim, lumaSim, durationSim = 100 }) {
  const W_LUMA     = 0.25;
  const W_SPATIAL  = 0.30;
  const W_EDGE     = 0.15;
  const W_PHASH    = 0.10;
  const W_DURATION = 0.05;
  const W_TOTAL    = W_LUMA + W_SPATIAL + W_EDGE + W_PHASH + W_DURATION; // 0.85
  const raw = W_LUMA     * (lumaSim  ?? 50)
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

// Load a local File into a <video> element.
// Returns Promise<{ video, url, duration }>.
async function _loadVideo(file, { onProgress } = {}) {
  const isMov = /\.mov$/i.test(file?.name || '');

  // 1. Shared runtime fast-path for companion-opened files
  const _nativePath = file?._nativePath || null;
  if (_nativePath && isMov) {
    try {
      const resp = await sharedMediaOpen(_nativePath);
      const d = resp?.data || {};
      if (d.canPlay && d.streamUrl) {
        const playableUrl = await _withCompanionToken(d.streamUrl);
        return {
          ...(await _loadVideoFromUrl(file, playableUrl)),
          decodeStatus: 'native-stream',
          startTimecode: d.startTimecode || '',
        };
      }
    } catch { /* fall through */ }
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
  let streamUrl;
  let proxyResult;
  try {
    proxyResult = await getProxyStreamUrl(file, { onProgress: onProgress || (() => {}) });
    streamUrl = proxyResult?.url || null;
  } catch (proxyErr) {
    // Proxy unavailable — fall back to blind blob rather than hard-crashing callers.
    if (blobResult) return { ...blobResult, decodeStatus: 'browser-fallback' };
    throw proxyErr;
  }
  if (!streamUrl) {
    if (blobResult) return { ...blobResult, decodeStatus: 'browser-fallback' };
    throw new Error(`Proxy returned no URL for ${file?.name}`);
  }
  if (blobResult) URL.revokeObjectURL(blobUrl);
  const playableUrl = await _withCompanionToken(streamUrl);
  return {
    ...(await _loadVideoFromUrl(file, playableUrl)),
    decodeStatus: 'proxy-transcode',
    proxySessionId: proxyResult?.sessionId || '',
    proxyStreamUrl: streamUrl,
  };
}

function _loadVideoFromUrl(file, url) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted   = true;
    video.crossOrigin = 'anonymous';
    video.playsInline = true;

    const onMeta = () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onErr);
      resolve({ video, url, duration: video.duration });
    };
    const onErr = () => {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('error', onErr);
      reject(new Error(`Cannot load video: ${file?.name || url}`));
    };

    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', onErr);
    video.src = url;
  });
}

// Seek video to timeSec. Resolves when seeked; rejects after 6 s timeout.
function _seekVideo(video, timeSec) {
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
//   approxSec  — proxy srcIn as a hint (may be inaccurate).
//   Coarse pass: ±30 s, 2 s step (30 seeks).
//   Fine pass:   ±1.5 s, 1-frame step around coarse best.
// Returns { bestSec, confidence(0–100), distance }.
async function _searchMasterForFrame(refHash, masterVideo, canvas, ctx, approxSec, fps, opts = {}) {
  // NaN duration (streaming proxy without Content-Length) → treat as unknown; coarse/wide
  // loops will clamp via Math.min(duration-0.1, ...) which still bounds them correctly.
  const duration    = Number.isFinite(masterVideo.duration) && masterVideo.duration > 0 ? masterVideo.duration : 0;
  const COARSE_STEP = Number(opts.coarseStepSec || 2);
  const COARSE_WIN  = Number(opts.coarseWindowSec || 30);
  const FINE_STEP   = 1 / fps;
  const FINE_WIN    = Number(opts.fineWindowSec || 1.5);
  const WIDE_STEP   = Number(opts.wideStepSec || Math.max(0.75, Math.min(3, duration / 160 || 2)));
  const wideSearch  = !!opts.wideSearch;
  const minLocal    = Number(opts.minLocalConfidence ?? 68);
  const fileKey     = opts.fileKey || '';

  let bestSec  = Math.max(0, Math.min(approxSec || 0, Math.max(0, duration - 0.001)));
  let bestDist = _HASH_BITS + 1;

  const testAt = async (t) => {
    try {
      const tt       = Math.max(0, Math.min(t, duration - 0.001));
      const frameIdx = Math.round(tt * fps);
      const fpKey    = fileKey ? `h|${fileKey}|${frameIdx}` : '';

      let hash;
      if (fpKey) {
        const cached = await _fpCacheGet(fpKey);
        if (cached) hash = new Uint8Array(cached);
      }
      if (!hash) {
        await _seekVideo(masterVideo, tt);
        hash = _grabHash(masterVideo, canvas, ctx);
        if (fpKey) _fpCachePut(fpKey, Array.from(hash));
      }

      const d = _hammingDistance(refHash, hash);
      if (d < bestDist) { bestDist = d; bestSec = tt; }
      return d;
    } catch { return null; }
  };

  // ─ Local coarse pass around XML/source hint ────────────────────────────
  const cStart = Math.max(0,              (approxSec || 0) - COARSE_WIN);
  const cEnd   = Math.min(duration - 0.1, (approxSec || 0) + COARSE_WIN);

  for (let t = cStart; t <= cEnd + 0.001; t += COARSE_STEP) {
    const d = await testAt(t);
    if (d === 0) break;
  }

  let localConfidence = Math.round((1 - bestDist / _HASH_BITS) * 100);

  // ─ Wide/global coarse pass when timecode is unreliable ────────────────
  // This is essential for trailer/editorial conforms where XML source TC may
  // not line up with the ProRes source media. We still use the source hint first
  // for speed, but fall back to a whole-clip visual-wave scan when needed.
  if (wideSearch && duration > 0 && localConfidence < minLocal) {
    for (let t = 0; t <= duration - 0.1; t += WIDE_STEP) {
      const d = await testAt(t);
      if (d === 0) break;
    }
  }

  // ─ Fine pass around the best coarse hit ───────────────────────────────
  const fStart = Math.max(0,              bestSec - FINE_WIN);
  const fEnd   = Math.min(duration - 0.1, bestSec + FINE_WIN);

  for (let t = fStart; t <= fEnd + FINE_STEP * 0.1; t += FINE_STEP) {
    const d = await testAt(t);
    if (d === 0) break;
  }

  return {
    bestSec,
    distance:   bestDist,
    confidence: Math.round((1 - bestDist / _HASH_BITS) * 100),
  };
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

  let speedPct = _numOrNull(ev.speedFactor ?? ev.speed ?? ev._pmSpeed ?? ev._speedPercent);
  // Parsers store speedFactor as percent (100 = normal, 200 = 2x). If absent,
  // infer speed from XML source span vs record duration.
  let speedRatio = speedPct != null ? Math.abs(speedPct) / 100 : (srcSpanF > 0 ? srcSpanF / recDurF : 1);
  if (!Number.isFinite(speedRatio) || speedRatio <= 0) speedRatio = 1;
  // Keep crazy parser outliers from exploding search offsets.
  speedRatio = Math.max(0.01, Math.min(32, speedRatio));

  const reversed = !!ev.speedReversed || (speedPct != null && speedPct < 0) || (srcOutF < srcInF);
  const direction = reversed ? -1 : 1;
  if (!srcSpanF || srcSpanF < 1) srcSpanF = Math.max(1, Math.round(recDurF * speedRatio));

  return {
    recInF, recOutF, recDurF,
    srcInF, srcOutF, srcSpanF,
    speedPct: speedPct != null ? speedPct : Math.round(speedRatio * 10000) / 100,
    speedRatio,
    reversed,
    direction,
    dynamicSpeed: !!(ev.speedKeys && Array.isArray(ev.speedKeys) && ev.speedKeys.length),
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
  return metrics.srcInF + metrics.direction * (timelineOffsetF * metrics.speedRatio);
}

function _deriveSourceInFromMatched(metrics, timelineOffsetF, matchedSourceFrameF) {
  return matchedSourceFrameF - metrics.direction * (timelineOffsetF * metrics.speedRatio);
}

function _median(values) {
  const arr = values.filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (!arr.length) return 0;
  const mid = Math.floor(arr.length / 2);
  return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
}

async function _matchEventByVisualWave({ ev, refVideo, masterVideo, canvas, ctx, dhCanvas, dhCtx, fps, seqBaseFrames, useAI = false, masterFileKey = '', tcOffset = 0 }) {
  const metrics = _eventFrameMetrics(ev, fps);
  const sampleOffsets = _sampleOffsetsForEvent(ev, fps);
  const sampleMatches = [];
  // Use Infinity as fallback so NaN/0 duration (streaming proxies without Content-Length)
  // does not filter out every sample offset — seeks will clamp naturally inside _seekVideo.
  const refDur    = Number.isFinite(refVideo.duration)    && refVideo.duration    > 0 ? refVideo.duration    : 1e9;
  const masterDur = Number.isFinite(masterVideo.duration) && masterVideo.duration > 0 ? masterVideo.duration : 1e9;

  for (const eventOffsetF of sampleOffsets) {
    const refFrameF = metrics.recInF - seqBaseFrames + eventOffsetF;
    const refSec = refFrameF / fps;
    if (refSec < 0 || refSec >= refDur - 0.001) continue;

    await _seekVideo(refVideo, refSec);
    const approxSrcFrameF = _expectedSourceFrameAtOffset(metrics, eventOffsetF);
    // Subtract the master's embedded start TC so tape-TC srcIn values (e.g. 08:37:xx:xx)
    // translate to file-time seconds rather than clamping to the end of the file.
    const approxSec = Math.max(0, Math.min((approxSrcFrameF - tcOffset) / fps, Math.max(0, masterDur - 0.001)));

    let result;
    // Use hash search for the first production implementation. It now supports
    // wide/global search, which is more important than deep embeddings when TC is wrong.
    if (useAI) {
      const refEmb = await extractEmbedding(refVideo, canvas);
      result = await searchMasterAI(refEmb, masterVideo, canvas, fps, approxSec);
      // AI helper currently searches locally. If confidence is weak, fall back to
      // whole-clip hash search for trailer conforms with unreliable source TC.
      if ((result?.confidence ?? 0) < 68 && ctx) {
        await _seekVideo(refVideo, refSec);
        const refHash = _grabHash(refVideo, canvas, ctx);
        result = await _searchMasterForFrame(refHash, masterVideo, canvas, ctx, approxSec, fps, {
          wideSearch: true,
          minLocalConfidence: 68,
          wideStepSec: 2,
          fileKey: masterFileKey,
        });
      }
    } else {
      const refMHash     = _grabHash(refVideo, canvas, ctx);
      // Sync ref hashes — always available as fallback even if worker is unavailable.
      const refLumaSync  = _computeFrameLuma(ctx);
      const refEHashSync = _computeEdgeHash(ctx);
      const refDHash     = dhCtx ? _grabDHash(refVideo, dhCanvas, dhCtx) : null;
      // Fire worker with ref pixels — runs during the search loop below (free overlap).
      const refWorkerP   = _FpWorkerClient.compute(ctx.getImageData(0, 0, _HASH_W, _HASH_H).data);

      result = await _searchMasterForFrame(refMHash, masterVideo, canvas, ctx, approxSec, fps, {
        wideSearch: true,
        minLocalConfidence: 68,
        wideStepSec: 2,
        fileKey: masterFileKey,
      });

      // Upgrade raw mHash confidence to the full weighted formula.
      if (dhCtx) {
        try {
          await _seekVideo(masterVideo, result.bestSec);
          ctx.drawImage(masterVideo, 0, 0, _HASH_W, _HASH_H);
          // Sync master hashes — ctx holds the master frame at this point.
          const masterMHashSync = _computeHash(ctx);
          const masterLumaSync  = _computeFrameLuma(ctx);
          const masterEHashSync = _computeEdgeHash(ctx);
          // Fire worker with master pixels; await both worker results together.
          const masterWorkerP   = _FpWorkerClient.compute(ctx.getImageData(0, 0, _HASH_W, _HASH_H).data);
          const masterDHash     = _grabDHash(masterVideo, dhCanvas, dhCtx);

          const [refW, masterW] = await Promise.all([refWorkerP, masterWorkerP]);

          result = {
            ...result,
            confidence: _weightedFrameSimilarity({
              spatialSim:  _mHashSimilarity(refW?.mHash ?? refMHash, masterW?.mHash ?? masterMHashSync),
              edgeSim:     _eHashSimilarity(refW?.eHash ?? refEHashSync, masterW?.eHash ?? masterEHashSync),
              pHashSim:    _dHashSimilarity(refDHash, masterDHash),
              lumaSim:     Math.max(0, 100 - Math.abs((refW?.luma ?? refLumaSync) - (masterW?.luma ?? masterLumaSync))),
              durationSim: _durationSimilarity(metrics),
            }),
          };
        } catch { /* keep raw mHash confidence on seek/draw error */ }
      }
    }

    const matchedFrameF = Math.round((result.bestSec || 0) * fps);
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
  const visualConfidence = Math.max(0, Math.min(100, Math.round(avgScore + consistencyBonus + durationBonus - variancePenalty - dynamicPenalty)));

  const correctedSrcInF = Math.max(0, Math.round(medianSrcInF));
  const correctedSrcOutF = Math.max(0, Math.round(correctedSrcInF + metrics.srcSpanF));
  const status = (consistent >= 3 && varianceF <= 2 && visualConfidence >= 82)
    ? 'SAFE'
    : (consistent >= 2 && varianceF <= 8 && visualConfidence >= 58)
      ? 'REVIEW'
      : 'FAIL';

  return {
    srcIn:      _framesToTC(correctedSrcInF,  fps),
    srcOut:     _framesToTC(correctedSrcOutF, fps),
    confidence: visualConfidence,
    visualConfidence,
    audioConfidence: null,
    finalConfidence: visualConfidence,
    distance:   Math.round((100 - visualConfidence) * 100) / 100,
    method:     metrics.dynamicSpeed ? 'visual_wave_duration_speed_dynamic' : 'visual_wave_duration_speed',
    status,
    sampleMatches,
    samplesUsed: sampleMatches.length,
    consistentSamples: consistent,
    offsetVarianceFrames: varianceF,
    speedPercent: metrics.speedPct,
    speedRatio: metrics.speedRatio,
    sourceSpanFrames: metrics.srcSpanF,
    durationFrames: metrics.recDurF,
  };
}

// ── Per-reel slip computation ──────────────────────────────────────────────
// After per-event visual matching, collapse individual event corrections into a
// single median offset per reel. This is the classic "analyze → slip" workflow.

function _computeReelSlips(events, eventCorrections, fps) {
  const reelBuckets = new Map(); // masterName → [{offset, confidence}]
  for (const [evId, corr] of Object.entries(eventCorrections)) {
    if (!corr.srcIn || corr.method === 'reel_slip') continue;
    const ev = events.find(e => e.id === evId);
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
      .filter(e => !e.disabled && e.type === 'video')
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
    fps:                DEFAULT_FPS,
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
    matchHasRun:        false,
    // New v3 fields
    epId:               null,
    matchResults:       {},   // ev.id → { status: 'SAFE'|'REVIEW'|'FAIL'|'MANUAL'|null, approved: false, notes: '' }
    selectedEvId:       null,
    verifyMode:         'side',
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
<div class="trc-root" id="trcRoot">

  <!-- Header/Status Row -->
  <div class="trc-header">
    <span class="trc-header-logo">TRAILERS CONFORM</span>
    <div class="trc-status-row">
      <span class="trc-sbadge trc-sbadge--ep" id="trcSbEp">EP ---</span>
      <span class="trc-sbadge" id="trcSbXml">XML: Not loaded</span>
      <span class="trc-sbadge" id="trcSbRef">REF QT: Not loaded</span>
      <span class="trc-sbadge" id="trcSbSource">SOURCE: Not indexed</span>
      <span class="trc-sbadge" id="trcSbMatch">MATCH: Not run</span>
      <span class="trc-sbadge" id="trcSbExport">EXPORT: Pending</span>
    </div>
  </div>

  <div class="trc-body">

    <!-- STEP 4: VERIFY -->
    <div class="trc-panel trc-panel-verify" id="trcPanelVerify">
      <div class="trc-panel-head">
        <span class="trc-step-num">4</span>
        <span class="trc-panel-title">VERIFY</span>
        <span class="trc-verify-event-label" id="trcVerifyEventLabel">—</span>
        <div class="trc-view-modes">
          <button class="trc-view-mode-btn is-active" data-mode="side">Side by Side</button>
          <button class="trc-view-mode-btn" data-mode="wipe">Wipe</button>
          <button class="trc-view-mode-btn" data-mode="overlay">Overlay</button>
          <button class="trc-view-mode-btn" data-mode="diff">Difference</button>
        </div>
        <button class="trc-close-verify" id="trcCloseVerify" title="Close verify">&#215;</button>
      </div>
      <div class="trc-verify-body">
        <div class="trc-verify-empty" id="trcVerifyEmpty">
          Select a result row to compare the Reference QT against the matched source and review the waveform offset.
        </div>
        <div class="trc-frames-row" id="trcFramesRow">
          <div class="trc-frame-panel">
            <div class="trc-frame-label">Reference Frame</div>
            <canvas class="trc-frame-canvas" id="trcRefCanvas" width="480" height="270"></canvas>
          </div>
          <div class="trc-frame-divider" id="trcFrameDivider"></div>
          <div class="trc-frame-panel">
            <div class="trc-frame-label">Matched Source Frame</div>
            <canvas class="trc-frame-canvas" id="trcSrcCanvas" width="480" height="270"></canvas>
          </div>
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
          <button class="trc-btn trc-btn-approve-match" id="trcBtnApproveMatch">&#10003; Approve Match</button>
          <button class="trc-btn trc-btn-reject-match" id="trcBtnRejectMatch">&#10005; Reject</button>
          <button class="trc-btn trc-btn-mark-review" id="trcBtnMarkReview">&#9873; Mark Review</button>
        </div>
      </div>
    </div>

    <!-- STEP 1: INPUTS -->
    <div class="trc-panel trc-panel-inputs">
      <div class="trc-panel-head">
        <span class="trc-step-num">1</span>
        <span class="trc-panel-title">INPUTS</span>
      </div>
      <div class="trc-input-cards">

        <!-- Card A: Editorial Cut -->
        <div class="trc-icard trc-icard--cut" id="trcIcardCut">
          <div class="trc-icard-header">
            <svg class="trc-icard-icon" width="13" height="13" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="11" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M4 7h8M4 10h5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
            <span class="trc-icard-label">EDITORIAL CUT</span>
            <span class="trc-icard-formats">.xml · .fcpxml · .edl</span>
          </div>
          <div class="trc-icard-body">
            <div class="trc-drop-zone" id="trcDropCut">
              <div class="trc-drop-inner" id="trcDropCutInner">
                <svg class="trc-drop-icon" width="26" height="26" viewBox="0 0 28 28" fill="none"><rect x="4" y="3" width="13" height="17" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M13 3v5h4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M20 17v6M17 21l3 3 3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <div class="trc-drop-text" id="trcCutLabel">Drop XML / EDL / FCPXML</div>
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
            <button class="trc-load-btn" id="trcBtnLoadCut">Load XML / EDL / FCPXML</button>
          </div>
          <button class="trc-clear-btn" id="trcClearCut" style="display:none" title="Clear">×</button>
        </div>

        <!-- Card B: Reference QT -->
        <div class="trc-icard trc-icard--ref" id="trcIcardRef">
          <div class="trc-icard-header">
            <svg class="trc-icard-icon" width="13" height="13" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.4"/><path d="M6 5.5l5 2.5-5 2.5V5.5z" fill="currentColor"/></svg>
            <span class="trc-icard-label">REFERENCE QT</span>
            <span class="trc-icard-formats">Apple ProRes .mov</span>
          </div>
          <div class="trc-icard-body">
            <div class="trc-icard-sub">Timeline truth for visual/audio matching</div>
            <div class="trc-drop-zone" id="trcDropRef">
              <div class="trc-drop-inner" id="trcDropRefInner">
                <svg class="trc-drop-icon" width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="2" y="4" width="20" height="14" rx="2" stroke="currentColor" stroke-width="1.4"/><path d="M9 9l5 3-5 3V9z" fill="currentColor"/></svg>
                <div class="trc-drop-text" id="trcRefLabel">Drop Reference QT</div>
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
            <button class="trc-load-btn" id="trcBtnLoadRef">Load Reference QT</button>
          </div>
          <button class="trc-clear-btn" id="trcClearRef" style="display:none" title="Clear">×</button>
        </div>

        <!-- Card C: Source ProRes -->
        <div class="trc-icard trc-icard--source" id="trcIcardSource">
          <div class="trc-icard-header">
            <svg class="trc-icard-icon" width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2 5h4l2 3h8v7H2V5z" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/></svg>
            <span class="trc-icard-label">SOURCE PRORES</span>
            <span class="trc-icard-formats">.mov folder / files</span>
          </div>
          <div class="trc-icard-body">
            <div class="trc-icard-sub">Candidate source media; timecode may differ</div>
            <div class="trc-drop-zone" id="trcDropMasters">
              <div class="trc-drop-inner" id="trcDropSourceInner">
                <svg class="trc-drop-icon" width="26" height="26" viewBox="0 0 28 28" fill="none"><path d="M4 8h6l2 3h12v12H4V8z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" fill="none"/></svg>
                <div class="trc-drop-text" id="trcMastersLabel">Drop Source ProRes folder / files</div>
                <div class="trc-drop-hint">MOV · candidate source media</div>
              </div>
              <div class="trc-icard-info" id="trcSourceInfo" style="display:none">
                <div class="trc-info-row"><span class="trc-info-key">Files</span><span class="trc-info-val" id="trcSourceInfoCount">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">Indexed</span><span class="trc-info-val" id="trcSourceInfoIndexed">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">Total dur.</span><span class="trc-info-val" id="trcSourceInfoDur">—</span></div>
                <div class="trc-info-row"><span class="trc-info-key">Status</span><span class="trc-info-val" id="trcSourceInfoStatus">—</span></div>
              </div>
            </div>
            <button class="trc-load-btn" id="trcBtnLoadSource">Load Source ProRes</button>
          </div>
          <button class="trc-clear-btn" id="trcClearMasters" style="display:none" title="Clear">×</button>
        </div>

      </div>
    </div>

    <!-- STEP 2: AI MATCH -->
    <div class="trc-panel trc-panel-match">
      <div class="trc-panel-head">
        <span class="trc-step-num">2</span>
        <span class="trc-panel-title">AI MATCH</span>
        <div class="trc-match-btns" id="trcMatchBtns">
          <button class="trc-btn trc-btn-match-step" id="trcBtnBuildFP" disabled>Build Reference Fingerprints</button>
          <button class="trc-btn trc-btn-match-step" id="trcBtnIndexSource" disabled>Index Source Frames</button>
          <button class="trc-btn trc-btn-run-match" id="trcBtnRunMatch" disabled>&#9654; Auto Match + Slip</button>
          <button class="trc-btn trc-btn-stop" id="trcBtnStop" style="display:none">&#9632; Stop</button>
          <button class="trc-btn trc-btn-reset-match" id="trcBtnResetMatch" style="display:none">&#8634; Reset Match</button>
        </div>
      </div>
      <div class="trc-match-note">
        Reference QT filename only infers episode ID. Visual and audio alignment drive conform. Filename and timecode are weak hints only.
      </div>
      <div class="trc-progress-wrap" id="trcProgressWrap" style="display:none">
        <div class="trc-progress-phases" id="trcProgressPhases">
          <span class="trc-phase-step" id="trcPhStep0">Parsing XML</span>
          <span class="trc-phase-arrow">&#8250;</span>
          <span class="trc-phase-step" id="trcPhStep1">Sampling reference frames</span>
          <span class="trc-phase-arrow">&#8250;</span>
          <span class="trc-phase-step" id="trcPhStep2">Reading reference audio</span>
          <span class="trc-phase-arrow">&#8250;</span>
          <span class="trc-phase-step" id="trcPhStep3">Indexing source frames</span>
          <span class="trc-phase-arrow">&#8250;</span>
          <span class="trc-phase-step" id="trcPhStep4">Indexing source audio</span>
          <span class="trc-phase-arrow">&#8250;</span>
          <span class="trc-phase-step" id="trcPhStep5">Solving offsets</span>
          <span class="trc-phase-arrow">&#8250;</span>
          <span class="trc-phase-step" id="trcPhStep6">Done</span>
        </div>
        <div class="trc-progress-bar-row">
          <progress class="trc-progress-bar" id="trcProgressBar" value="0" max="100"></progress>
          <span class="trc-progress-pct" id="trcProgressPct">0%</span>
          <span class="trc-progress-current" id="trcProgressCurrent"></span>
        </div>
      </div>
      <div class="trc-slip-summary" id="trcSlipSummary" style="display:none"></div>
    </div>

    <!-- STEP 3: MATCH RESULTS -->
    <div class="trc-panel trc-panel-results" id="trcPanelResults">
      <div class="trc-panel-head">
        <span class="trc-step-num">3</span>
        <span class="trc-panel-title">MATCH RESULTS</span>
        <span class="trc-results-stats" id="trcResultsStats"></span>
      </div>
      <div class="trc-empty-state" id="trcEmptyState">
        <div class="trc-empty-hint">Load XML, Reference QT, and Source ProRes to start AI conform.<br>Reference QT is timeline truth. Source timecode may differ.</div>
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
    <div class="trc-panel trc-panel-export">
      <div class="trc-panel-head">
        <span class="trc-step-num">5</span>
        <span class="trc-panel-title">EXPORT</span>
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
          <label class="trc-opt-check"><input type="checkbox" id="trcOptOnlyApproved" checked> Export only approved matches</label>
          <label class="trc-opt-check"><input type="checkbox" id="trcOptIncludeReview"> Include approved REVIEW matches</label>
          <label class="trc-opt-check"><input type="checkbox" id="trcOptLeaveFailUnchanged" checked> Leave failed events unchanged</label>
          <label class="trc-opt-check"><input type="checkbox" id="trcOptRelativePaths"> Use relative media paths</label>
          <label class="trc-opt-check"><input type="checkbox" id="trcOptAddNotes"> Add review/fail notes if supported</label>
        </div>
        <div class="trc-export-btns">
          <button class="trc-btn trc-btn-export-xml" id="trcBtnExportXML" disabled>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M8 2v9M4 7l4 5 4-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><line x1="2" y1="14" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            Export Corrected XML
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
    return state.events.filter(e => !e.disabled && e.type === 'video');
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
    let toUpdate = 0;

    for (const ev of visibleEvents) {
      const status = _computeRowStatus(ev.id);
      const approved = _isEventApproved(ev.id);
      if (status === 'SAFE' && approved) safeApproved++;
      if (status === 'REVIEW' && approved) reviewApproved++;
      if (status === 'REVIEW' && !approved) reviewUnapproved++;
      if (status === 'FAIL') fail++;
      if (_shouldApplyCorrection(ev)) toUpdate++;
    }

    return {
      total: visibleEvents.length,
      safeApproved,
      reviewApproved,
      reviewUnapproved,
      fail,
      toUpdate,
      unchanged: Math.max(0, visibleEvents.length - toUpdate),
    };
  }

  function _updateVerifyControls() {
    const hasSelection = state.selectedEvId != null;
    const ids = [
      'trcBtnApproveMatch',
      'trcBtnRejectMatch',
      'trcBtnMarkReview',
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

    const expEl = _$('trcSbExport');
    if (expEl) {
      const ready = _getExportSummaryData().toUpdate > 0;
      expEl.textContent = ready ? 'EXPORT: Ready' : 'EXPORT: Pending';
      expEl.classList.toggle('trc-sbadge--ok', ready);
      expEl.classList.toggle('trc-sbadge--loaded', false);
    }
  }

  // ── Row status computation ────────────────────────────────────────────

  function _computeRowStatus(evId) {
    const override = state.matchResults[evId]?.status;
    if (override) return override;
    const corr = state.eventCorrections[evId];
    if (!corr) return 'UNMATCH';
    if (corr.status) return corr.status;
    const c = corr.finalConfidence ?? corr.confidence ?? 0;
    const variance = corr.offsetVarianceFrames ?? 999;
    const samples = corr.consistentSamples ?? corr.samplesUsed ?? 0;
    if (c >= 82 && variance <= 2 && samples >= 3) return 'SAFE';
    if (c >= 58 && variance <= 8 && samples >= 2) return 'REVIEW';
    if (c >= 70) return 'REVIEW';
    return 'FAIL';
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

    if (!visibleEvents.length) {
      if (emptyState) emptyState.style.display = '';
      if (resultsWrap) resultsWrap.style.display = 'none';
      if (statsEl) statsEl.textContent = '';
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
      const corrSrcIn  = corr ? corr.srcIn  : (ev.srcIn  || '—');
      const corrSrcOut = corr ? corr.srcOut : (ev.srcOut || '—');

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

      const status = _computeRowStatus(ev.id);
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

      const approved = _isEventApproved(ev.id);
      const approvedAttr = approved ? ' data-approved="1"' : '';
      const selectedClass = state.selectedEvId === ev.id ? ' is-selected' : '';
      const eventLabel = `EVT ${String(i + 1).padStart(3, '0')}`;
      const finalPctClass = corr
        ? (corr.finalConfidence ?? corr.confidence ?? 0) >= 80 ? 'trc-pct-high'
        : (corr.finalConfidence ?? corr.confidence ?? 0) >= 60 ? 'trc-pct-med'
        : 'trc-pct-low'
        : 'trc-pct-none';

      return `<tr class="${rowClasses[status] || ''}${selectedClass}" data-evid="${ev.id}"${approvedAttr}>
  <td class="trc-col-num">${i + 1}</td>
  <td class="trc-col-event">${_esc(eventLabel)}</td>
  <td class="trc-col-clip" title="${_esc(ev.clipName || ev.reel || '')}">${_esc(clipDisp)}</td>
  <td class="trc-col-tc">${_esc(ev.recIn)}</td>
  <td class="trc-col-tc">${_esc(ev.recOut)}</td>
  <td class="trc-col-dur">${_esc(durStr)}</td>
  <td class="trc-col-source" title="${_esc(displayMasterFull)}">${_esc(displayMasterDisp)}</td>
  <td class="trc-col-tc">${_esc(corrSrcIn)}</td>
  <td class="trc-col-tc">${_esc(corrSrcOut)}</td>
  <td class="trc-col-offset">${_esc(offsetStr)}</td>
  <td class="trc-col-pct">${_esc(visualPct)}</td>
  <td class="trc-col-pct">${audioPct}</td>
  <td class="trc-col-pct ${finalPctClass}">${_esc(finalPct)}</td>
  <td class="trc-col-status"><span class="trc-badge ${statusColors[status] || ''}">${status}${approved ? ' · Approved' : ''}</span></td>
  <td class="trc-col-action">
    <div class="trc-act-stack">
      <button class="trc-act-btn" data-act="view"    data-evid="${ev.id}" title="Verify">View</button>
      <button class="trc-act-btn" data-act="approve" data-evid="${ev.id}" title="Approve">Approve</button>
      <button class="trc-act-btn" data-act="review"  data-evid="${ev.id}" title="Mark Review">Review</button>
      <button class="trc-act-btn" data-act="reject"  data-evid="${ev.id}" title="Reject">Reject</button>
      <button class="trc-act-btn" data-act="manual"  data-evid="${ev.id}" title="Manual">Manual</button>
    </div>
  </td>
</tr>`;
    }).join('');

    if (statsEl) {
      const safe   = visibleEvents.filter(e => _computeRowStatus(e.id) === 'SAFE').length;
      const review = visibleEvents.filter(e => _computeRowStatus(e.id) === 'REVIEW').length;
      const fail   = visibleEvents.filter(e => _computeRowStatus(e.id) === 'FAIL').length;
      statsEl.textContent = `${visibleEvents.length} events · ${safe} SAFE · ${review} REVIEW · ${fail} FAIL`;
    }

    _renderExportSummary();
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
  }

  // ── Select row for verify ─────────────────────────────────────────────

  function _selectRow(evId) {
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
    const waveOffsetEl = _$('trcWaveOffset');
    if (waveOffsetEl) {
      if (corr) {
        const origF = ev?._srcInFrames ?? _tcToFrames(ev?.srcIn || '00:00:00:00', state.fps);
        const corrF = _tcToFrames(corr.srcIn, state.fps);
        const delta = corrF - origF;
        waveOffsetEl.textContent = `${delta === 0 ? '0f' : (delta > 0 ? `+${delta}f` : `${delta}f`)} · ${(delta / (state.fps || DEFAULT_FPS)).toFixed(3)}s`;
      } else {
        waveOffsetEl.textContent = '—';
      }
    }

    const offsetFrames = corr
      ? (_tcToFrames(corr.srcIn, state.fps || DEFAULT_FPS) - (ev?._srcInFrames ?? _tcToFrames(ev?.srcIn || '00:00:00:00', state.fps || DEFAULT_FPS)))
      : 0;

    _drawWaveformPlaceholder('trcWaveRef', 42, 0.5, '#56d2c6');
    _drawWaveformPlaceholder('trcWaveSrc', 137, Math.max(0.08, Math.min(0.92, 0.5 + (offsetFrames / 120))), '#f6b562');

    _drawVerifyPlaceholder('trcRefCanvas', 'Loading…');
    _drawVerifyPlaceholder('trcSrcCanvas', 'Loading…');

    _loadVerifyFrames(evId).catch(() => {});

    if (window.innerWidth < 1180) {
      panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // ── Load verify frames ────────────────────────────────────────────────

  async function _loadVerifyFrames(evId) {
    const ev = state.events.find(e => e.id === evId);
    if (!ev) return;

    const fps = state.fps || DEFAULT_FPS;
    const visibleEvents = state.events.filter(e => !e.disabled && e.type === 'video');
    const seqBaseFrames = Math.min(...visibleEvents.map(e => e._recInFrames ?? _tcToFrames(e.recIn, fps)));
    const recInF = ev._recInFrames ?? _tcToFrames(ev.recIn, fps);
    const unmrefSec = (recInF - seqBaseFrames) / fps;

    const refCanvasEl = _$('trcRefCanvas');
    const srcCanvasEl = _$('trcSrcCanvas');

    // Draw reference frame
    if (state.refFile && refCanvasEl) {
      try {
        const { video: refVid, url: refVidUrl } = await _loadVideo(state.refFile);
        await _seekVideo(refVid, Math.max(0, unmrefSec));
        const ctx = refCanvasEl.getContext('2d');
        ctx.drawImage(refVid, 0, 0, refCanvasEl.width, refCanvasEl.height);
        state._refImageData = ctx.getImageData(0, 0, refCanvasEl.width, refCanvasEl.height);
        if (refVidUrl && refVidUrl.startsWith('blob:')) URL.revokeObjectURL(refVidUrl);
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
        const srcSec = Math.max(0, (corrSrcInF - tcOffsetF) / fps);
        capturedSrcSec = srcSec;
        const { video } = await _loadVideo(masterFile);
        await _seekVideo(video, srcSec);
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
    // Uses _loadVideo so ProRes source files decode through the companion proxy (H264 transcode).
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
          const lagFrames    = Math.round(sync.lag * secPerSample * fps);
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
  // Uses _loadVideo so ProRes source files are handled through the companion proxy.
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
      state.projectName = result.projectName || _stem(state.timelineFile.name);

      if (!state.events.length) throw new Error('No video events found in timeline');

      // Update XML info card
      const extMatch = state.timelineFile.name.match(/\.(\w+)$/i);
      const fmt = extMatch ? extMatch[1].toUpperCase() : 'UNKNOWN';
      const visCount = state.events.filter(e => !e.disabled && e.type === 'video').length;
      _showCutInfo(state.timelineFile.name, fmt, visCount, state.projectName, state.fps);

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
        onProgress: pct => { if (progCur) progCur.textContent = `Generating proxy: ${state.refFile.name} — ${pct}%`; },
      });
      refUrl = refData.url;
      const refVideo    = refData.video;
      const refDuration = refData.duration;

      _setMatchPhaseActive(1);
      if (progBar) progBar.value = 10;
      if (progPct) progPct.textContent = '10%';
      if (progCur) progCur.textContent = 'Sampling reference frames…';

      const visibleEvents = _getVisibleEvents();
      const seqBaseFrames = visibleEvents[0]?._seqBaseFrames
        ?? Math.min(...visibleEvents.map(e => e._recInFrames || _tcToFrames(e.recIn, state.fps)));

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

      for (const [masterName, group] of masterGroups) {
        if (state.visualMatchCancel) break;
        if (progCur) progCur.textContent = `Loading ${_stem(masterName)}…`;
        _setMatchPhaseActive(4);

        let masterVideo = null, masterUrl2 = null;
        try {
          const mv = await _loadVideo(group.file, {
            onProgress: pct => { if (progCur) progCur.textContent = `Generating proxy: ${_stem(masterName)} — ${pct}%`; },
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

          try {
            const recInF    = ev._recInFrames || _tcToFrames(ev.recIn, state.fps);
            const unmrefSec = (recInF - seqBaseFrames) / state.fps;

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
              seqBaseFrames,
              useAI,
              masterFileKey: group.file ? _fpFileKey(group.file) : '',
              tcOffset: group.tcOffset || 0,
            });

            // ── Luma-envelope audio similarity ────────────────────────────
            // Capture a 2.5 s brightness envelope from ref and master at the
            // matched position, cross-correlate, and blend into finalConfidence.
            // Fills the 0.15 audio slot from the spec: 0.85·visual + 0.15·audio.
            let audioConfidence = null;
            let finalConfidence = result.visualConfidence;
            try {
              const corrSrcSec = _tcToFrames(result.srcIn, state.fps) / state.fps;
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

            // Seed matchResults from solver status. Keep user overrides if present.
            if (!state.matchResults[ev.id]) {
              state.matchResults[ev.id] = { status: null, approved: false, notes: '' };
            }
            if (!state.matchResults[ev.id].status && result.status === 'FAIL') {
              state.matchResults[ev.id].status = 'FAIL';
            }

          } catch (evErr) {
            console.warn('[TrlConform] Visual match failed for event', ev.id, evErr.message);
          }

          try { _renderMatchResults(); } catch {}
        }

        if (masterUrl2) URL.revokeObjectURL(masterUrl2);
      }

      if (refUrl) { URL.revokeObjectURL(refUrl); refUrl = null; }

      _setMatchPhaseActive(6);
      state.matchHasRun = Object.keys(state.eventCorrections).length > 0 || !state.visualMatchCancel;

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
          : `Complete — ${corrCount}/${totalEvents} events matched · ${Object.keys(slipMap).length} reel slip(s) applied`;
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
    }
  }

  // ── Match button state helpers ────────────────────────────────────────

  function _updateMatchBtns() {
    const canBuildFP = !!state.refFile;
    const canIndex   = state.masterFiles.length > 0;
    const canRun     = !!state.timelineFile && !!state.refFile && state.masterFiles.length > 0
                    && state.sourceIndexed && !state.visualMatchRunning;
    const allReady   = canRun && state.sourceIndexed;

    const el = (id, dis) => { const b = _$(id); if (b) b.disabled = dis; };
    el('trcBtnBuildFP',    !canBuildFP);
    el('trcBtnIndexSource',!canIndex);
    el('trcBtnRunMatch',   !canRun);

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
      state.projectName = result.projectName || _stem(state.timelineFile.name);

      const extMatch = state.timelineFile.name.match(/\.(\w+)$/i);
      const fmt = extMatch ? extMatch[1].toUpperCase() : '—';
      const visCount = state.events.filter(e => !e.disabled && e.type === 'video').length;
      _showCutInfo(state.timelineFile.name, fmt, visCount, state.projectName, state.fps);

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

  // ── Auto-index source files with proxy gen ────────────────────────────
  // Uses the full _loadVideo() path so ProRes .mov files get companion proxies
  // generated upfront — "Run Match" then runs instantly without per-event proxy waits.

  async function _autoIndexSource() {
    const files = state.masterFiles.filter(f => /\.mov$/i.test(f.name || ''));
    if (!files.length) return;

    state.sourceIndexed = false;
    const _el = (id, v) => { const e = _$(id); if (e) e.textContent = v; };
    _el('trcSourceInfoIndexed', 'Indexing…');
    _el('trcSourceInfoStatus',  'Starting…');

    let totalDur = 0;
    let ok = 0;
    let proxyCount = 0;

    for (let i = 0; i < files.length; i++) {
      if (!state.masterFiles.length) break;  // cleared mid-flight
      const f = files[i];
      const isMov = /\.mov$/i.test(f.name);
      _el('trcSourceInfoIndexed', `${i + 1} / ${files.length}`);
      _el('trcSourceInfoStatus', `${_stem(f.name)}…`);
      try {
        const { video, decodeStatus, startTimecode: tcNative, proxySessionId, proxyStreamUrl } = await _loadVideo(f, {
          onProgress: pct => _el('trcSourceInfoStatus', `Proxy ${_stem(f.name)}: ${pct}%`),
        });
        totalDur += video.duration || 0;
        if (isMov && ['proxy-cache', 'proxy-transcode', 'native-stream'].includes(decodeStatus)) proxyCount++;

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
      } catch {
        ok++;  // non-fatal — file may decode via different path at match time
      }
    }

    if (!state.masterFiles.length) return;  // was cleared while we ran

    state.sourceIndexed = true;
    const durStr = totalDur >= 3600
      ? `${(totalDur / 3600).toFixed(1)} hr`
      : `${(totalDur / 60).toFixed(1)} min`;
    _el('trcSourceInfoIndexed', `${ok} / ${files.length}${proxyCount > 0 ? ` · ${proxyCount} proxied` : ''}`);
    _el('trcSourceInfoDur',    totalDur > 0 ? durStr : '—');
    _el('trcSourceInfoStatus', 'Ready');

    // If XML already parsed, rebuild reel map and render initial UNMATCH table
    if (state.events.length) {
      state.reelMap  = _buildReelMap(state.events, state.masterFiles);
      _applyTcOffsets(state.reelMap, state.fileTcOffsets);
      state.analyzed = true;
      _renderMatchResults();
      _renderExportSummary();
      _updateExportBtns();
    }
    _updateMatchBtns();
    _updateStatusBadges();

    // Auto-trigger match when all three inputs are loaded and match hasn't run yet
    if (state.timelineFile && state.refFile && !state.matchHasRun && !state.visualMatchRunning) {
      _runVisualMatch().catch(() => {});
    }
  }

  // ── Exports ───────────────────────────────────────────────────────────

  function _exportCorrectedXML() {
    if (!state.analyzed || !state.events.length) return;
    const fps = state.fps || DEFAULT_FPS;
    const visibleEvents = _getVisibleEvents();
    const reelByProxy = {};
    for (const r of state.reelMap) reelByProxy[r.proxyName] = r;

    const clipItems = visibleEvents.map(ev => {
      const corr = state.eventCorrections[ev.id];
      const proxyKey = ev.reel || ev.srcFile || '';
      const entry = reelByProxy[proxyKey];
      const shouldApply = _shouldApplyCorrection(ev);
      const corrSourceName = corr?.matchedSourceFile || corr?.masterFileName || corr?.masterName || '';
      const corrSourcePath = corr?.matchedSourcePath || corrSourceName;
      const masterStem = shouldApply
        ? _stem(corrSourceName || entry?.masterName || proxyKey)
        : _stem(proxyKey);
      const filePath = shouldApply
        ? (corrSourcePath || entry?.masterFile?._nativePath || entry?.masterName || masterStem)
        : (ev.srcFile || proxyKey || masterStem);

      const corrSrcInF  = shouldApply && corr ? _tcToFrames(corr.srcIn,  fps) : (ev._srcInFrames  ?? _tcToFrames(ev.srcIn,  fps));
      const corrSrcOutF = shouldApply && corr ? _tcToFrames(corr.srcOut, fps) : (ev._srcOutFrames ?? _tcToFrames(ev.srcOut, fps));
      const recInF  = ev._recInFrames  ?? _tcToFrames(ev.recIn,  fps);
      const recOutF = ev._recOutFrames ?? _tcToFrames(ev.recOut, fps);
      const matchState = state.matchResults[ev.id] || {};
      const noteBits = [];
      if (state.exportOptions.addNotes) {
        const status = _computeRowStatus(ev.id);
        if (status === 'REVIEW' || status === 'FAIL' || status === 'MANUAL') noteBits.push(status);
        if (matchState.notes) noteBits.push(matchState.notes);
      }
      const commentNode = noteBits.length ? `\n            <comments>${_esc(noteBits.join(' · '))}</comments>` : '';
      const pathNode = filePath
        ? `\n              <pathurl>${_esc(state.exportOptions.relativePaths ? _stem(masterStem) : _pathToFileUrl(filePath))}</pathurl>`
        : '';

      return `          <clipitem id="event_${ev.id}">
            <name>${_esc(ev.clipName || ev.reel || '')}</name>
            <in>${corrSrcInF}</in>
            <out>${corrSrcOutF}</out>
            <start>${recInF}</start>
            <end>${recOutF}</end>
            <file id="file_${ev.id}">
              <name>${_esc(masterStem)}</name>${pathNode}
            </file>${commentNode}
          </clipitem>`;
    }).join('\n');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<xmeml version="4">
  <sequence>
    <name>${_esc(state.projectName)}</name>
    <rate><timebase>${fps}</timebase><ntsc>FALSE</ntsc></rate>
    <media>
      <video>
        <track>
${clipItems}
        </track>
      </video>
    </media>
  </sequence>
</xmeml>`;

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
      const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
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
    // Prefer File System Access API (Chrome 86+) — returns storable handles.
    if (accept !== 'folder' && typeof window.showOpenFilePicker === 'function') {
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

      // Probe duration — uses full _loadVideo() path so ProRes QTs get auto-proxied
      el('trcRefInfoDecode', 'Probing…');
      try {
        const { video, decodeStatus } = await _loadVideo(f, {
          onProgress: pct => el('trcRefInfoDecode', `Proxy: ${pct}%`),
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
      // Auto-index with proxy gen in background — ProRes files get proxied before Run Match
      if (state.masterFiles.length) _autoIndexSource().catch(() => {});
      else {
        _renderMatchResults();
        _renderExportSummary();
        _updateExportBtns();
      }
    };

    _wireDropZone('trcDropMasters', 'trcMastersLabel', 'trcClearMasters', '.mov', _onSourceFiles);
    _$('trcBtnLoadSource')?.addEventListener('click', () => _openFilePicker('.mov', _onSourceFiles));

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
          onProgress: pct => { if (progCur) progCur.textContent = `Generating proxy: ${pct}%`; },
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
      let totalDur = 0, ok = 0, proxyCount = 0;
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
                if (progCur) progCur.textContent = `Proxy ${_stem(f.name)}: ${p}%`;
                _el('trcSourceInfoStatus', `Proxy gen: ${p}%`);
              },
            });
            totalDur += video.duration || 0;
            if (isMov && ['proxy-cache', 'proxy-transcode', 'native-stream'].includes(decodeStatus)) proxyCount++;
            ok++;
          } catch { ok++; }
        }
        state.sourceIndexed = true;
        const durStr = totalDur >= 3600
          ? `${(totalDur / 3600).toFixed(1)} hr`
          : `${(totalDur / 60).toFixed(1)} min`;
        _el('trcSourceInfoIndexed', `${ok} / ${state.masterFiles.length}${proxyCount > 0 ? ` · ${proxyCount} proxied` : ''}`);
        _el('trcSourceInfoDur',     totalDur > 0 ? durStr : '—');
        _el('trcSourceInfoStatus',  'Ready');
        if (progCur) progCur.textContent = `${ok} source files indexed${proxyCount > 0 ? ` · ${proxyCount} proxied` : ''}`;
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
      try {
        await _runConform();
        await _runVisualMatch();
      } catch (err) {
        console.error('[TrlConform] Run match error', err);
      }
    });

    // ── Wire: Stop ────────────────────────────────────────────────────
    _$('trcBtnStop')?.addEventListener('click', () => {
      state.visualMatchCancel = true;
    });

    // ── Wire: Reset Match ─────────────────────────────────────────────
    _$('trcBtnResetMatch')?.addEventListener('click', () => {
      if (!confirm('Reset all match results and corrections? This cannot be undone.')) return;
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

    // ── Wire: Verify approve/reject/review ────────────────────────────
    _$('trcBtnApproveMatch')?.addEventListener('click', () => {
      if (state.selectedEvId == null) return;
      const meta = _getMatchMeta(state.selectedEvId);
      const algorithmicStatus = _computeRowStatus(state.selectedEvId);
      if (!meta.status || meta.status === 'UNMATCH') {
        meta.status = (algorithmicStatus === 'FAIL' || algorithmicStatus === 'UNMATCH') ? 'REVIEW' : algorithmicStatus;
      }
      meta.approved = true;
      _renderMatchResults();
      _renderExportSummary();
      _updateStatusBadges();
      _updateExportBtns();
    });

    _$('trcBtnRejectMatch')?.addEventListener('click', () => {
      if (state.selectedEvId == null) return;
      const meta = _getMatchMeta(state.selectedEvId);
      meta.status   = 'FAIL';
      meta.approved = false;
      _renderMatchResults();
      _renderExportSummary();
      _updateStatusBadges();
      _updateExportBtns();
    });

    _$('trcBtnMarkReview')?.addEventListener('click', () => {
      if (state.selectedEvId == null) return;
      const meta = _getMatchMeta(state.selectedEvId);
      meta.status = 'REVIEW';
      if (meta.approved !== true) meta.approved = false;
      _renderMatchResults();
      _renderExportSummary();
      _updateStatusBadges();
      _updateExportBtns();
    });

    // ── Wire: Close verify ────────────────────────────────────────────
    _$('trcCloseVerify')?.addEventListener('click', () => {
      state.selectedEvId = null;
      const labelEl = _$('trcVerifyEventLabel');
      if (labelEl) labelEl.textContent = '—';
      const waveOffsetEl = _$('trcWaveOffset');
      if (waveOffsetEl) waveOffsetEl.textContent = '—';
      _drawVerifyPlaceholder('trcRefCanvas', 'Reference frame');
      _drawVerifyPlaceholder('trcSrcCanvas', 'Matched source frame');
      _updateVerifyControls();
      _renderMatchResults();
    });

    // ── Wire: View mode buttons ───────────────────────────────────────
    _root?.querySelectorAll('.trc-view-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _root.querySelectorAll('.trc-view-mode-btn').forEach(b => b.classList.remove('is-active'));
        btn.classList.add('is-active');
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
          state.matchResults[state.selectedEvId] = { status: 'MANUAL', approved: false, notes: '' };
        } else {
          state.matchResults[state.selectedEvId].status = 'MANUAL';
          state.matchResults[state.selectedEvId].approved = false;
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

      const meta = _getMatchMeta(evId);

      if (act === 'approve') {
        const algStatus = _computeRowStatus(evId);
        if (!meta.status || meta.status === 'UNMATCH') {
          meta.status = (algStatus === 'FAIL' || algStatus === 'UNMATCH') ? 'REVIEW' : algStatus;
        }
        meta.approved = true;
      } else if (act === 'review') {
        meta.status = 'REVIEW';
        if (meta.approved !== true) meta.approved = false;
      } else if (act === 'reject') {
        meta.status   = 'FAIL';
        meta.approved = false;
      } else if (act === 'manual') {
        meta.status = 'MANUAL';
        meta.approved = false;
        _selectRow(evId);
        return;
      }

      _renderMatchResults();
      _renderExportSummary();
      _updateStatusBadges();
      _updateExportBtns();
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
    if (_root) mount();
  }

  function onTabActivated() {}

  function exportState() {
    if (!state.analyzed) return null;
    return {
      events:           state.events,
      fps:              state.fps,
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
      })),
      eventCorrections: state.eventCorrections,
      matchResults:     state.matchResults,
      exportOptions:    state.exportOptions,
      analyzed:         true,
    };
  }

  function applyState(saved) {
    if (!saved?.analyzed) { clear(); return; }
    state.events           = saved.events           || [];
    state.fps              = saved.fps              || DEFAULT_FPS;
    state.projectName      = saved.projectName      || '';
    state.epId             = saved.epId             ?? null;
    state.eventCorrections = saved.eventCorrections || {};
    state.matchResults     = saved.matchResults     || {};
    state.exportOptions    = { ...state.exportOptions, ...(saved.exportOptions || {}) };
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

  return { mount, onTabActivated, clear, exportState, applyState };
}
