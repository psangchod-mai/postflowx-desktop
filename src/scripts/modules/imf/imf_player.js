// scripts/modules/imf/imf_player.js
// IMF Package Frame Navigator — canvas renderer + transport controls.
// Scans MXF Index Table for per-frame byte offsets; extracts J2K codestream bytes;
// renders frame metadata + byte visualization (native J2K decode requires WASM).
'use strict';

import { fmtDuration } from './imf_parser.js';
import { scanMXF, readMXFFrame } from './imf_mxf.js';
import { diffStats } from './imf_layer_compare.js';

// J2K decoder loaded dynamically so a WASM failure doesn't break the player
let _decodeHTJ2K    = null;
let _frameToImageData = null;
let _getDecoderPoolInfo = () => ({ configured: 1, ready: 0, hardware: 0 });
let _prewarmJ2KDecoders = () => Promise.resolve(_getDecoderPoolInfo());
import('./imf_j2k.js').then(m => {
  _decodeHTJ2K      = m.decodeHTJ2K;
  _frameToImageData = m.frameToImageData;
  if (typeof m.getDecoderPoolInfo === 'function') _getDecoderPoolInfo = m.getDecoderPoolInfo;
  if (typeof m.prewarmJ2KDecoders === 'function') _prewarmJ2KDecoders = m.prewarmJ2KDecoders;
  _prewarmJ2KDecoders().then((info) => {
    console.log('[IMF] J2K decoder module loaded (sandbox bridge)', info);
  }).catch(() => console.log('[IMF] J2K decoder module loaded (sandbox bridge)'));
}).catch(e => console.warn('[IMF] J2K module unavailable:', e));

// build marker — update to confirm new code is running
console.log('[IMF] player build: 2026-04-07-v52');

// ── Player state ──────────────────────────────────────────────────────────────
const S = {
  canvas:       null,
  ctx:          null,
  reelNum:      0,
  totalFrames:  0,
  currentFrame: 0,
  fps:          24,
  color:        '#7c6af7',
  filename:     '',
  codec:        '–',
  resolution:   '–',
  transfer:     '–',
  primaries:    '–',
  mxfFile:      null,     // File handle
  mxfIndex:     null,     // Result of scanMXF — frame offset index
  mxfScanning:  false,    // true while scanMXF is running
  scanPct:      0,        // 0–100 progress for scan overlay
  frameBytes:   null,     // Uint8Array of current frame's J2K codestream
  frameJ2K:     null,     // parsed J2K header { width, height, rsiz, byteLength }
  frameBitmap:  null,     // ImageBitmap if browser decoded the J2K (fast path)
  frameImageData:null,    // Decoded frame as ImageData for direct draw fallback
  frameSurface: null,     // Canvas/OffscreenCanvas fallback surface for scaled draw
  framePixels:  null,     // Uint8ClampedArray RGBA from last decoded frame (for scope)
  framePixW:    0,        // width of framePixels source
  framePixH:    0,        // height of framePixels source
  loadSeq:      0,        // incremented on each playerLoadReel call (cancel stale loads)
  isPlaying:    false,
  tcOffset:     0,        // Frame offset on timeline (for absolute TC)
  dropFrame:    false,    // CPL CompositionTimecode drop-frame flag (SMPTE ST 12-1)
  tcStart:      0,        // CPL TimecodeStartAddress as a frame offset (absolute TC origin)
  raf:          0,        // requestAnimationFrame ID
  lastTs:       0,        // last frame timestamp (ms)
  frameInterval: 41.67,   // ms per frame at 24fps
  // Scope
  scopeCanvas:  null,
  scopeCtx:     null,
  scopeMode:    'parade', // 'parade' | 'waveform' | 'vector' | 'meter'
  scopeTab:     'overview', // 'overview' | 'parade' | 'waveform' | 'vector' | 'audio'
  decodeBusy:   false,
  pendingFrame: null,
  pendingSeq:   0,
  displayFrame: null,    // frame number that matches the currently displayed decoded image
  inflightFrame: null,   // frame currently being decoded
  playBaseFrame: 0,      // frame at the moment playback started
  playBaseTs:    0,      // timestamp when playback started
  decodeAvgMs:   0,      // moving average of decode time
  decodedCache:  new Map(),
  cacheLimit:    10,
  frameByteCache: new Map(),
  frameByteCacheLimit: 10,
  frameByteReads: new Map(),
  prefetchQueue: [],
  prefetchQueued: new Set(),
  prefetchInflight: 0,
  prefetchMax: 3,
  decodePrefetchQueue: [],
  decodePrefetchQueued: new Set(),
  decodePrefetchInflight: new Set(),
  playbackStride: 1,
  previewScale: 1,
  playbackMode: 'auto',
  droppedFrames: 0,
  avOffsetMs:    0,      // measured audio-vs-video offset (ms); + = video behind audio
  showRtHud:     false,  // operator-visible real-time playback health HUD (toggle)
  rtHudFps:      0,      // measured presented frames per wall second
  _rtFpsCount:   0,      // frames presented in the current 1s window
  _rtFpsWinTs:   0,      // window start timestamp (performance.now)
  lastFrameAdvance: 0,
  lastAdaptiveTs: 0,
  scaleRecoveryScore: 0,
  renderWorker: null,
  renderWorkerReady: false,
  renderReqId: 1,
  renderPending: new Map(),
  // Proxy mode (Rec.709 H.264 via native host)
  proxyMode: false,
  proxyVideoEl: null,
  proxyDoviMetadata: null,  // keyed by SMPTE timecode string
  proxyDoviUrl: null,
  proxyOnDoviUpdate: null,
  proxyFps: 24,
  proxyLabel: 'Rec.709 Proxy',
  proxyTcOffset: 0,
  proxyStartTimecode: '',
  // Dolby Vision SDR (100-nit Rec.709) trim preview
  doviShots: [],            // [{ begin, end, sdrTrim:{gain,lift,gamma,sat}|null }]
  trimMode: false,          // apply the SDR trim to the preview
  trimUserSet: false,       // user has explicitly toggled (suppresses default-ON)
  _trimShotKey: '',         // last shot/trim applied to the SVG filter (dedupe DOM writes)
  _trimActive: false,       // whether the current frame should be filtered
  // Multi-layer compare (Sprint 5 #3): overlay one comparison layer (a soloed CPL)
  // on the live picture. compareBitmap is fetched by the UI via the same companion
  // thumb path as the main viewer; the draw is a native-canvas op so the hot decode
  // path is untouched. All fields inert unless compareEnabled && compareBitmap.
  compareEnabled: false,
  compareMode:    'split',   // 'split' | 'difference' | 'blend'
  compareSplit:   0.5,       // split divider position, fraction of picture width
  compareOpacity: 0.5,       // blend opacity for the comparison layer
  compareBitmap:  null,      // ImageBitmap of the comparison layer at the current frame
  compareLabel:   '',        // e.g. 'VF1' — shown in the compare HUD
  compareDiff:    null,      // { changedPercent, meanAbsDiff, identical } vs the live frame
  // Preview color-space toggle (PQ sources): SDR Rec.709 tonemap vs brighter HDR emulation
  previewHdr: false,
  previewMode: 'sdr',    // 'sdr' | 'full' | 'trim'
  srcPeakNits: null,     // from DV L6 mastering luminance
  frameMaxNits: 0,       // computed per frame by render worker
  // Preview status model — what is actually rendered in the viewer
  // status: 'REAL_FRAME' | 'PROXY_FRAME' | 'PLACEHOLDER_ONLY' | 'ERROR'
  // engine: identifies the decode path that produced the visible pixels
  // canRunScopes: false when viewer shows no real pixel data (placeholder/error)
  previewStatus: {
    status: 'PLACEHOLDER_ONLY',
    engine: null,
    diagnostic: '',
    canRunScopes: false,
  },
  // Frame mapping metadata from CPL (passed via playerLoadReel reelInfo)
  entryPoint:        0,    // CPL resource entryPoint — offset into MXF for frame 0 of this reel
  intrinsicDuration: 0,    // CPL resource intrinsicDuration (total frames in MXF)
  mxfPath:           '',   // absolute path to the MXF file (Electron only, for main-process decode)
  cplPath:           '',   // absolute path to the CPL XML (Electron companion mode, IMF demuxer)
  assetMaps:         [],   // all ASSETMAP.xml absolute paths for ffmpeg -assetmaps flag
  cplId:             '',   // CPL UUID for cache key
  packageHash:       '',   // IMF package hash for cache key
  // Pipeline decode stage results — drives the canvas status chips
  pipelineStatus: {
    cplParse:     null,   // null | 'ok' | 'fail'
    assetResolve: null,
    mxfRead:      null,
    pixelDecode:  null,
    decoder:      null,   // backend name string when pixelDecode='ok'
  },
  // Decode diagnostics — shown in the "Decode Info" panel (toggle with D key)
  decodeInfo: {
    show:            false,
    lastAttempt:     null,  // { frame, backend, codec, mxfFrame, entryPoint, error?, elapsed }
    failedFrames:    0,
    blackFrames:     0,
    electronResults: [],    // last N electron backend results
    sysDiag:         null,  // cached pfxPlatform.imf.diagnostics() result
  },
};

// ── IMF Audio Engine ──────────────────────────────────────────────────────────
// Drives PCM audio in sync with the video clock. Uses AudioContext.currentTime
// as the master clock so audio drift is impossible. The PCM is extracted from
// the reel's MXF essence by the native backend (pfx:imf:extractAudio); when no
// backend or no audio track is present every entry point below safely no-ops.
const _AUD = {
  ctx:          null,   // AudioContext
  source:       null,   // AudioBufferSourceNode (current)
  buffer:       null,   // AudioBuffer (current reel's PCM)
  startCtxTime: 0,      // ctx.currentTime when playback began
  startFrame:   0,      // video frame that corresponds to startCtxTime
  fps:          24,
  loading:      false,
  loadSeq:      0,      // matches S.loadSeq the buffer was loaded for (reel cookie)
};

function _audInit() {
  if (_AUD.ctx) return;
  try {
    _AUD.ctx = new (window.AudioContext || window.webkitAudioContext)();
  } catch (e) {
    console.warn('[IMF Audio] AudioContext unavailable:', e.message);
  }
}

async function _audLoadReel(mxfPath, fps, tcOffset) {
  if (!_AUD.ctx || !mxfPath || !window.pfxPlatform?.imf?.extractAudio) return;
  _audStop();
  _AUD.fps = fps || 24;
  _AUD.buffer = null;
  _AUD.loading = true;
  const seq = S.loadSeq;          // cookie: ignore the result if the reel changed
  try {
    // Ask the native backend to extract PCM from the MXF audio track.
    const r = await window.pfxPlatform.imf.extractAudio({
      mxfPath,
      tcOffset:   tcOffset || 0,
      sampleRate: _AUD.ctx.sampleRate,
      channels:   2,        // stereo mix-down
      maxSeconds: 300,      // cap at 5 min per reel to avoid OOM
    });
    if (seq !== S.loadSeq) { _AUD.loading = false; return; }   // stale — reel changed
    if (!r?.pcm?.left?.length) { _AUD.loading = false; return; }
    // r.pcm is { left: Float32Array, right: Float32Array, sampleRate: number }
    const rate = r.pcm.sampleRate || _AUD.ctx.sampleRate;
    const right = r.pcm.right?.length === r.pcm.left.length ? r.pcm.right : r.pcm.left;
    const buf = _AUD.ctx.createBuffer(2, r.pcm.left.length, rate);
    buf.getChannelData(0).set(r.pcm.left);
    buf.getChannelData(1).set(right);
    _AUD.buffer = buf;
    _AUD.loadSeq = seq;
  } catch (e) {
    console.warn('[IMF Audio] extractAudio failed:', e.message);
  }
  _AUD.loading = false;
  // If playback is already running (autoPlay started before the PCM finished
  // loading), begin audio now — anchored to the current video frame so it stays
  // in sync with wherever the clock has advanced to.
  if (S.isPlaying && _AUD.buffer && _AUD.loadSeq === S.loadSeq) _audPlay(S.currentFrame);
}

function _audPlay(fromFrame) {
  if (!_AUD.ctx || !_AUD.buffer) return;
  _audStop();
  if (_AUD.ctx.state === 'suspended') { try { _AUD.ctx.resume(); } catch {} }
  const src = _AUD.ctx.createBufferSource();
  src.buffer = _AUD.buffer;
  src.connect(_AUD.ctx.destination);
  const fps = _AUD.fps || S.fps || 24;
  const offsetSec = Math.max(0, (fromFrame || 0) / fps);
  // Past the end of the PCM there is nothing to play (e.g. audio shorter than video).
  if (offsetSec >= _AUD.buffer.duration) return;
  _AUD.startCtxTime = _AUD.ctx.currentTime;
  _AUD.startFrame   = fromFrame || 0;
  try { src.start(0, offsetSec); } catch { return; }
  _AUD.source = src;
}

function _audStop() {
  try { _AUD.source?.stop(); } catch {}
  try { _AUD.source?.disconnect(); } catch {}
  _AUD.source = null;
}

function _audCurrentFrame() {
  if (!_AUD.ctx || !_AUD.source) return null;
  const elapsed = _AUD.ctx.currentTime - _AUD.startCtxTime;
  return Math.round(_AUD.startFrame + elapsed * (_AUD.fps || S.fps || 24));
}

// True when PCM audio is actively driving so the video loop should follow it as
// the master clock. Guarded so any missing piece falls back to the wall clock.
function _avLockActive() {
  return !!(_AUD.ctx && _AUD.source && _AUD.buffer &&
            _AUD.ctx.state === 'running' && _AUD.loadSeq === S.loadSeq && !S.proxyMode);
}

// Exposed so imf_ui.js can halt audio when it drives a reel change directly.
export { _audStop as audStop, _audPlay as audPlay };

// ── J2K header parser ─────────────────────────────────────────────────────────
// Returns { width, height, rsiz, byteLength } or null if not J2K
function parseJ2KHeader(bytes) {
  if (!bytes || bytes.length < 6) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset);
  // SOC marker = FF 4F
  if (dv.getUint16(0) !== 0xFF4F) return null;
  let off = 2;
  while (off + 4 <= bytes.length) {
    const marker = dv.getUint16(off);
    if (off + 2 >= bytes.length) break;
    const len = dv.getUint16(off + 2);
    if (marker === 0xFF51 && len >= 38) {  // SIZ segment
      if (off + 14 > bytes.length) break;
      return {
        rsiz:       dv.getUint16(off + 4),
        width:      dv.getUint32(off + 6),
        height:     dv.getUint32(off + 10),
        byteLength: bytes.length,
      };
    }
    if (len < 2) break;
    off += 2 + len;
  }
  return { byteLength: bytes.length };  // J2K but SIZ not found
}

// ── Scan progress overlay ─────────────────────────────────────────────────────
function drawScanProgress(pct, phase) {
  const { ctx, canvas } = S;
  if (!ctx || !canvas) return;
  const W = canvas.width, H = canvas.height;

  ctx.fillStyle = '#080810';
  ctx.fillRect(0, 0, W, H);

  const barW = Math.min(280, W * 0.7);
  const bx = W / 2 - barW / 2;
  const by = H / 2 - 6;

  // Track
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  roundRect(ctx, bx, by, barW, 12, 6);
  ctx.fill();

  // Fill
  ctx.fillStyle = S.color;
  ctx.globalAlpha = 0.8;
  roundRect(ctx, bx, by, barW * (pct / 100), 12, 6);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.font = '11px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'center';
  const phaseLabel = phase === 'walk' ? 'Building frame index…' : `Scanning MXF index… [${phase || ''}]`;
  ctx.fillText(`${phaseLabel} ${Math.round(pct)}%`, W / 2, by + 30);
  ctx.textAlign = 'left';
}

// ── TC formatter ──────────────────────────────────────────────────────────────
// SMPTE ST 12-1 timecode. The FF field uses the INTEGER nominal rate
// (round(fps): 23.976→24, 29.97→30, 59.94→60) so the frame field never rolls
// early for fractional rates. When {dropFrame} is set at a ~29.97/59.94 rate,
// drop-frame math is applied (drop 2 (or 4 at 59.94) frames each minute except
// every 10th minute) and the SS/FF separator becomes ';'.
// Defaults keep legacy call sites (integer rate, non-drop) byte-identical.
function fmtTC(frameNum, fps, opts) {
  const dropFrame = !!(opts && opts.dropFrame);
  const fps_ = fps || 24;
  const nominal = Math.max(1, Math.round(fps_));   // integer frames per second for the FF field
  let f = Math.max(0, Math.round(frameNum));

  // Drop-frame is only defined at 30000/1001 (drop 2/min) and 60000/1001 (drop 4/min).
  const isDF = dropFrame && (nominal === 30 || nominal === 60);
  if (isDF) {
    const dropPerMin = nominal === 60 ? 4 : 2;                 // frames dropped each non-tenth minute
    const framesPer10Min = nominal * 600 - dropPerMin * 9;     // frames in a 10-minute block
    const framesPerMin   = nominal * 60 - dropPerMin;          // frames in a normal (dropped) minute
    const d = Math.floor(f / framesPer10Min);                  // whole 10-minute blocks
    let   m = f % framesPer10Min;                              // remainder within the block
    // Re-add dropped frames to convert the frame count back into wall-clock frame numbers.
    if (m >= dropPerMin) {
      f += dropPerMin * 9 * d + dropPerMin * Math.floor((m - dropPerMin) / framesPerMin);
    } else {
      f += dropPerMin * 9 * d;
    }
    const fr = f % nominal;
    const s  = Math.floor(f / nominal) % 60;
    const mm = Math.floor(f / (nominal * 60)) % 60;
    const h  = Math.floor(f / (nominal * 3600)) % 24;
    return `${String(h).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(s).padStart(2,'0')};${String(fr).padStart(2,'0')}`;
  }

  const fr = f % nominal;
  const s  = Math.floor(f / nominal) % 60;
  const m  = Math.floor(f / (nominal * 60)) % 60;
  const h  = Math.floor(f / (nominal * 3600));
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}:${String(fr).padStart(2,'0')}`;
}

// Drop-frame options for the currently-loaded reel (threaded from the parsed CPL
// CompositionTimecode). Kept as a helper so every display-facing fmtTC() call
// renders the same drop-frame flag the validator detected (TC001).
function _tcOpts() { return { dropFrame: !!S.dropFrame }; }

function _getProxyFrameState() {
  if (!S.proxyMode || !S.proxyVideoEl) return null;
  const fps = Number(S.proxyFps) || 24;
  const durationSec = Number(S.proxyVideoEl.duration);
  const currentSec = Number(S.proxyVideoEl.currentTime) || 0;
  const totalFrames = Number.isFinite(durationSec) && durationSec > 0 ? Math.max(1, Math.round(durationSec * fps)) : 0;
  const currentFrame = totalFrames > 0
    ? Math.max(0, Math.min(totalFrames - 1, Math.floor(currentSec * fps)))
    : Math.max(0, Math.floor(currentSec * fps));
  return {
    localFrame: currentFrame,
    absFrame: (S.proxyTcOffset || 0) + currentFrame,
    displayFrame: currentFrame,
    totalFrames,
    fps,
    reelNum: 0,
    tcOffset: S.proxyTcOffset || 0,
    isPlaying: !!(!S.proxyVideoEl.paused && !S.proxyVideoEl.ended),
  };
}

function _emitPlayerState() {
  const proxyState = _getProxyFrameState();
  if (proxyState) {
    try {
      document.dispatchEvent(new CustomEvent('imf:player-frame', { detail: proxyState }));
    } catch {}
    return;
  }
  try {
    document.dispatchEvent(new CustomEvent('imf:player-frame', {
      detail: {
        localFrame: S.currentFrame,
        absFrame: (S.tcOffset || 0) + (S.currentFrame || 0),
        displayFrame: S.displayFrame,
        totalFrames: S.totalFrames,
        fps: S.fps,
        reelNum: S.reelNum,
        tcOffset: S.tcOffset || 0,
        isPlaying: !!S.isPlaying,
      },
    }));
  } catch {}
}

// ── Dolby Vision SDR trim (100-nit Rec.709) preview ────────────────────────────
// Applied via an inline SVG filter (#imfTrimFilter): feComponentTransfer 'gamma'
// gives out = amplitude·in^exponent + offset per channel (slope/power/offset),
// followed by feColorMatrix 'saturate'. Set as ctx.filter around the frame
// drawImage so burn-in overlays drawn afterwards stay un-filtered.

// Find the DV shot covering the current frame. Shots' begin/end may be timeline
// (composition) edit units or reel-relative; try timeline first, then reel.
function _activeTrimForFrame() {
  const shots = S.doviShots;
  if (!S.trimMode || !shots || !shots.length) return null;
  let relFrame, tlFrame;
  if (S.proxyMode && S.proxyVideoEl) {
    relFrame = Math.round((Number(S.proxyVideoEl.currentTime) || 0) * (Number(S.proxyFps) || 24));
    tlFrame  = (S.proxyTcOffset || 0) + relFrame;
  } else {
    relFrame = S.currentFrame;
    tlFrame  = (S.tcOffset || 0) + S.currentFrame;
  }
  let hit = shots.find(s => tlFrame >= s.begin && tlFrame <= s.end);
  if (!hit) hit = shots.find(s => relFrame >= s.begin && relFrame <= s.end);
  return hit ? (hit.sdrTrim || null) : null;
}

// Compose the proxy <video> CSS filter from the active trim + HDR-emulation
// state. The proxy is a baked Rec.709 SDR file, so HDR is a brightening approx.
function _applyProxyFilter() {
  const v = S.proxyVideoEl;
  if (!v) return;
  const hasDv = S.doviShots && S.doviShots.some(s => s && s.sdrTrim);
  const parts = [];
  // TRIM mode: apply DV L8 SDR trim SVG filter to the already-SDR proxy video
  if (S.trimMode && hasDv) parts.push('url(#imfTrimFilter)');
  // HDR boost mode: proxy is Rec.709 SDR — lift brightness to simulate HDR headroom visibility
  if (S.previewHdr) parts.push('brightness(1.35) contrast(1.12) saturate(1.08)');
  v.style.filter = parts.join(' ');
}

// Push the active shot's trim into the SVG filter primitives (only when it
// changes). Returns true if the current frame should be filtered.
function _syncTrimFilter() {
  const trim = _activeTrimForFrame();
  const key = trim ? `${trim.gain}|${trim.lift}|${trim.gamma}|${trim.sat}` : '';
  S._trimActive = !!trim;
  if (key === S._trimShotKey) return S._trimActive;
  S._trimShotKey = key;
  if (!trim) return false;
  const amp  = Math.max(0, trim.gain).toFixed(4);
  const exp  = Math.max(0.1, trim.gamma).toFixed(4);
  const off  = trim.lift.toFixed(4);
  const sat  = Math.max(0, trim.sat).toFixed(4);
  for (const ch of ['R', 'G', 'B']) {
    const fn = document.getElementById('imfTrimFunc' + ch);
    if (fn) { fn.setAttribute('amplitude', amp); fn.setAttribute('exponent', exp); fn.setAttribute('offset', off); }
  }
  const satEl = document.getElementById('imfTrimSat');
  if (satEl) satEl.setAttribute('values', sat);
  return true;
}

// Brighter "HDR emulation" applied as a draw-time filter (works for local
// decode, companion thumbnails, and proxy — none of which share a single
// pixel pipeline). Tunable.
const HDR_EMUL_FILTER = 'brightness(1.22) contrast(1.08) saturate(1.06)';

// Sync the SVG filter DOM so it is always ready for the proxy <video> (see _applyProxyFilter).
// J2K decoded frames have ALL processing (trim + tone mapping) baked by the render worker —
// applying a CSS filter on top would double-process the pixels.
// Proxy video is handled separately via _applyProxyFilter; no canvas filter is used there.
function _composeCanvasFilter() {
  _syncTrimFilter();  // keep SVG primitives current for proxy video
  return 'none';
}

// Return the L1 max nits for the frame currently on screen (used for per-shot tone mapping).
function _getActiveL1NitsForFrame() {
  const shots = S.doviShots;
  if (!shots || !shots.length) return 0;
  let relFrame, tlFrame;
  if (S.proxyMode && S.proxyVideoEl) {
    relFrame = Math.round((Number(S.proxyVideoEl.currentTime) || 0) * (Number(S.proxyFps) || 24));
    tlFrame  = (S.proxyTcOffset || 0) + relFrame;
  } else {
    relFrame = S.currentFrame;
    tlFrame  = (S.tcOffset || 0) + S.currentFrame;
  }
  let hit = shots.find(s => tlFrame >= s.begin && tlFrame <= s.end);
  if (!hit) hit = shots.find(s => relFrame >= s.begin && relFrame <= s.end);
  return Number(hit?.l1MaxNits) || 0;
}

// Feed the per-shot SDR trim timeline to the player (called from imf_ui.js).
// shots: [{ begin, end, sdrTrim }]. Defaults trim ON when DV present (until the
// user toggles it explicitly).
export function playerSetDoviShots(shots) {
  S.doviShots = Array.isArray(shots) ? shots : [];
  S._trimShotKey = '';
  if (!S.trimUserSet) S.trimMode = S.doviShots.some(s => s && s.sdrTrim);
  // Use the highest l6MaxNits across all shots as the global mastering display peak.
  // Falls back to l6?.maxMasteringLuminance for backward compat with old callers.
  // Use S.doviShots (already guarded to be an array) not the raw `shots` param,
  // which may be null/undefined if the caller passes bad input.
  const bestNits = S.doviShots.reduce((best, s) => {
    const n = Number(s.l6MaxNits || s.l6?.maxMasteringLuminance || 0);
    return n > best ? n : best;
  }, 0);
  S.srcPeakNits = bestNits || null;
  _updateTrimButton();
  _applyProxyFilter();
  _syncTrimFilter();
  if (S.totalFrames > 0) drawFrame();
}

// Toggle the SDR trim on/off (wired to #imfViewTrimBtn).
export function playerSetPreviewMode(mode) {
  const valid = ['sdr', 'full', 'trim'];
  if (mode && valid.includes(mode)) {
    S.previewMode = mode;
  } else {
    const idx = valid.indexOf(S.previewMode);
    S.previewMode = valid[(idx + 1) % valid.length];
  }
  S.previewHdr = S.previewMode === 'full';
  S.trimMode = S.previewMode === 'trim';
  S.trimUserSet = true;
  S._trimShotKey = '';
  _updateHdrButton();
  _updateTrimButton();
  _applyProxyFilter();
  _syncTrimFilter();

  // ── Invalidate ALL decode state for this mode change ──────────────────────
  // S.loadSeq is the generation counter checked by every in-flight decode.
  // Without incrementing it, an in-flight decode that started with the OLD mode
  // will complete successfully, store its old-mode pixels back into S.decodedCache,
  // and the next pending decode will find them in cache and return early → no change.
  S.loadSeq++;

  // Clear both pixel cache layers:
  //   Layer 1: S.decodedCache  — persistent LRU cache (per-frame rendered bitmaps)
  //   Layer 2: S.frameBitmap / S.frameImageData — currently displayed image
  // Without clearing layer 2, drawFrame() redraws old pixels even after cache clear.
  _clearFrameCache();
  if (S.frameBitmap && typeof S.frameBitmap.close === 'function') {
    try { S.frameBitmap.close(); } catch {}
  }
  // Also clear module-level companion preview — it holds the old-mode pre-rendered image.
  if (_companionPreviewBitmap) {
    try { _companionPreviewBitmap.close?.(); } catch {}
    _companionPreviewBitmap = null;
    _companionPreviewReelKey = '';
  }
  S.frameBitmap    = null;
  S.frameImageData = null;
  S.frameSurface   = null;
  S.framePixels    = null;
  S.framePixW      = 0;
  S.framePixH      = 0;
  S.displayFrame   = null;
  if (S.proxyMode) {
    // Proxy: CSS filter updated by _applyProxyFilter() above — instant effect.
    drawFrame();
  } else if (S.mxfFile && S.mxfIndex && S.totalFrames > 0) {
    // Direct J2K: force re-decode with new mode. The incremented loadSeq above
    // will abort any still-running decode before it can store old pixels in cache.
    seekTo(S.currentFrame);
  } else if (!S.mxfFile && S.totalFrames > 0) {
    // Companion thumbnail mode: show TC while a fresh thumbnail is fetched.
    drawFrame();
    document.dispatchEvent(new CustomEvent('imf:companion-thumb-refresh', {
      detail: { frame: S.currentFrame ?? 0, previewMode: S.previewMode }
    }));
  } else {
    drawFrame();
  }
}

export function playerToggleHdr(on) {
  playerSetPreviewMode(typeof on === 'boolean' ? (on ? 'full' : 'sdr') : undefined);
}

export function playerToggleTrim(on) {
  const targetMode = typeof on === 'boolean' ? (on ? 'trim' : 'sdr') : (S.previewMode === 'trim' ? 'sdr' : 'trim');
  playerSetPreviewMode(targetMode);
}

// ── Multi-layer compare (Sprint 5 #3) ─────────────────────────────────────────
// Configure the compare overlay. Pass { enabled, mode, split, opacity, label }.
// Disabling drops the held comparison bitmap so it can't leak across packages.
export function playerSetCompare(opts = {}) {
  if (typeof opts.enabled === 'boolean') S.compareEnabled = opts.enabled;
  if (['split', 'difference', 'blend'].includes(opts.mode)) S.compareMode = opts.mode;
  if (Number.isFinite(opts.split))   S.compareSplit   = Math.min(1, Math.max(0, opts.split));
  if (Number.isFinite(opts.opacity)) S.compareOpacity = Math.min(1, Math.max(0, opts.opacity));
  if (typeof opts.label === 'string') S.compareLabel = opts.label;
  if (!S.compareEnabled) {
    if (S.compareBitmap && typeof S.compareBitmap.close === 'function') { try { S.compareBitmap.close(); } catch {} }
    S.compareBitmap = null;
    S.compareLabel = '';
  }
  drawFrame();
}

// Supply the comparison layer's frame (ImageBitmap at the current playhead).
// The UI fetches this via the existing companion thumb path for the soloed CPL.
export function playerSetCompareFrame(bitmap) {
  if (S.compareBitmap && S.compareBitmap !== bitmap && typeof S.compareBitmap.close === 'function') {
    try { S.compareBitmap.close(); } catch {}
  }
  S.compareBitmap = bitmap || null;
  _computeCompareDiff();
  drawFrame();
}

// Read-only snapshot for the UI (mode toggle / split slider state).
export function playerGetCompareState() {
  return {
    enabled: S.compareEnabled, mode: S.compareMode,
    split: S.compareSplit, opacity: S.compareOpacity,
    label: S.compareLabel, hasFrame: !!S.compareBitmap,
    changedPercent: S.compareDiff ? S.compareDiff.changedPercent : null,
    identical: S.compareDiff ? S.compareDiff.identical : null,
  };
}

// Snapshot the current composited compare view (live + overlay + Δ% HUD already
// on the canvas) as a PNG Blob + a metadata object for QC sign-off. Uses toBlob
// (not toDataURL) to avoid the MV3 data-URL CSP path. Returns null when compare
// isn't active or the canvas can't be read.
export async function playerExportCompareStill() {
  if (!S.compareEnabled || !S.compareBitmap || !S.canvas) return null;
  const blob = await new Promise((resolve) => {
    try { S.canvas.toBlob((b) => resolve(b), 'image/png'); } catch { resolve(null); }
  });
  if (!blob) return null;
  const d = S.compareDiff;
  return {
    blob,
    meta: {
      mode:           S.compareMode,
      compareLabel:   S.compareLabel || 'comparison',
      frame:          S.currentFrame ?? 0,
      timecode:       fmtTC(S.currentFrame ?? 0, S.fps, _tcOpts()),
      changedPercent: d ? Number(d.changedPercent.toFixed(2)) : null,
      meanAbsDiff:    d ? Number(d.meanAbsDiff.toFixed(2)) : null,
      identical:      d ? d.identical : null,
    },
  };
}

// Quantify how much the comparison layer differs from the live frame at the
// current playhead (drives the compare HUD's Δ%). Decoupled from the on-canvas
// composite: reads the live + comparison pixels directly into a small offscreen
// and runs the tested diffStats(). Cheap (~58k px) and best-effort.
let _diffCanvas = null;
function _computeCompareDiff() {
  S.compareDiff = null;
  if (!S.compareEnabled || !S.compareBitmap) return;
  const liveDrawable = S.frameBitmap || S.frameSurface || null;
  if (!liveDrawable && !S.frameImageData) return;
  const DW = 320, DH = 180;
  try {
    if (!_diffCanvas) {
      _diffCanvas = (typeof OffscreenCanvas !== 'undefined')
        ? new OffscreenCanvas(DW, DH)
        : document.createElement('canvas');
    }
    _diffCanvas.width = DW; _diffCanvas.height = DH;
    const dctx = _diffCanvas.getContext('2d', { willReadFrequently: true });
    if (!dctx) return;

    dctx.clearRect(0, 0, DW, DH);
    if (liveDrawable) {
      dctx.drawImage(liveDrawable, 0, 0, DW, DH);
    } else {
      const tmp = document.createElement('canvas');
      tmp.width = S.frameImageData.width; tmp.height = S.frameImageData.height;
      tmp.getContext('2d').putImageData(S.frameImageData, 0, 0);
      dctx.drawImage(tmp, 0, 0, DW, DH);
    }
    const live = dctx.getImageData(0, 0, DW, DH).data;

    dctx.clearRect(0, 0, DW, DH);
    dctx.drawImage(S.compareBitmap, 0, 0, DW, DH);
    const comp = dctx.getImageData(0, 0, DW, DH).data;

    S.compareDiff = diffStats(live, comp, DW, DH, { threshold: 10 });
  } catch (e) { S.compareDiff = null; }
}

// Draw the comparison layer over the live picture. Self-contained: recomputes its
// own fit-rect (same formula the picture branches use), so it needs no state
// threaded through drawFrame's body. No-op unless enabled + a comparison frame is
// present. Both layers share the delivery aspect, so fit-to-canvas aligns them.
function _drawCompareOverlay() {
  if (!S.compareEnabled || !S.compareBitmap) return;
  const { ctx, canvas } = S;
  if (!ctx || !canvas) return;
  const bm = S.compareBitmap;
  const W = canvas.width, H = canvas.height;
  const scale = Math.min(W / bm.width, H / bm.height);
  const dw = bm.width * scale, dh = bm.height * scale;
  const dx = (W - dw) / 2,     dy = (H - dh) / 2;
  S._compareRect = { dx, dy, dw, dh };   // for the split-divider drag hit-test

  ctx.save();
  try {
    if (S.compareMode === 'difference') {
      ctx.globalCompositeOperation = 'difference';
      ctx.drawImage(bm, dx, dy, dw, dh);
    } else if (S.compareMode === 'blend') {
      ctx.globalAlpha = S.compareOpacity;
      ctx.drawImage(bm, dx, dy, dw, dh);
    } else { // 'split' — comparison fills the right of the divider
      const splitX = dx + dw * S.compareSplit;
      ctx.beginPath();
      ctx.rect(splitX, dy, dx + dw - splitX, dh);
      ctx.clip();
      ctx.drawImage(bm, dx, dy, dw, dh);
    }
  } catch (e) { /* drawImage can throw on a closed/detached bitmap — ignore */ }
  ctx.restore();

  // Divider line + draggable grab knob for split.
  if (S.compareMode === 'split') {
    const splitX = dx + dw * S.compareSplit;
    const midY = dy + dh / 2;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(splitX, dy); ctx.lineTo(splitX, dy + dh); ctx.stroke();
    // Grab knob (signals the divider is draggable).
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.beginPath(); ctx.arc(splitX, midY, 7, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(20,30,55,0.9)';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('↔', splitX, midY + 3);
    ctx.textAlign = 'left';
    ctx.restore();
  }

  // Compare HUD chip (top-center) — mode, layer pair, and Δ% pixels-differ.
  let modeTxt = { split: 'SPLIT', difference: 'DIFF', blend: 'BLEND' }[S.compareMode] || 'COMPARE';
  if (S.compareMode === 'blend') modeTxt += ` ${Math.round(S.compareOpacity * 100)}%`;
  let diffTxt = '';
  if (S.compareDiff) {
    diffTxt = S.compareDiff.identical
      ? ' · Δ identical'
      : ` · Δ ${S.compareDiff.changedPercent.toFixed(1)}%`;
  }
  const hud = `◧ COMPARE · ${modeTxt}${S.compareLabel ? ' · LIVE | ' + S.compareLabel : ''}${diffTxt}`;
  ctx.save();
  ctx.font = 'bold 10px monospace';
  const hw = ctx.measureText(hud).width + 16;
  ctx.fillStyle = 'rgba(20,30,55,0.82)';
  roundRect(ctx, (W - hw) / 2, 10, hw, 18, 4);
  ctx.fill();
  // Tint the Δ readout: green when identical, amber when the layers differ.
  ctx.fillStyle = S.compareDiff && !S.compareDiff.identical ? '#fbbf24' : (S.compareDiff ? '#22c55e' : '#93c5fd');
  ctx.textAlign = 'center';
  ctx.fillText(hud, W / 2, 23);
  ctx.textAlign = 'left';
  ctx.restore();
}

function _updateHdrButton() {
  const btn = document.getElementById('imfBtnHdrSdr');
  if (!btn) return;
  const isPq = /PQ|2084/i.test(S.transfer || '');
  btn.style.display = isPq ? '' : 'none';
  const labels = { sdr: 'SDR', full: 'HDR', trim: 'TRIM' };
  btn.textContent = labels[S.previewMode] || 'SDR';
  btn.dataset.previewMode = S.previewMode || 'sdr';
  btn.classList.toggle('imf-tbtn-mode-active', S.previewMode !== 'sdr');
  const modeDescriptions = {
    sdr:  'SDR preview — PQ→Rec.709 tone mapped (matches Resolve SDR output) — click for HDR',
    full: 'HDR boost — diffuse white at 70% SDR, highlights visible — click for TRIM',
    trim: 'TRIM — DV L8 SDR 100-nit trim pass applied — click for SDR',
  };
  btn.title = modeDescriptions[S.previewMode] || '';
}

function _updateTrimButton() {
  const btn = document.getElementById('imfViewTrimBtn');
  if (!btn) return;
  const hasDv = S.doviShots && S.doviShots.some(s => s && s.sdrTrim);
  btn.style.display = hasDv ? '' : 'none';
  btn.disabled = !hasDv;
  btn.classList.toggle('imf-view-switch-btn-active', !!(hasDv && S.trimMode));
  const stage = document.getElementById('imfViewerStage');
  if (stage) stage.dataset.trim = (hasDv && S.trimMode) ? 'on' : 'off';
}

// ── Canvas draw ───────────────────────────────────────────────────────────────
function drawFrame() {
  const { ctx, canvas } = S;
  if (!ctx || !canvas) return;

  const W = canvas.width;
  const H = canvas.height;

  // Resolve the draw-time picture filter: DV SDR trim (per-shot SVG) + HDR
  // emulation (brightness/contrast). Applied only to the picture drawImage
  // below; reset to 'none' before any burn-in overlay. Works regardless of the
  // frame source (local J2K decode, companion thumbnail, or proxy).
  const _trimFilter = _composeCanvasFilter();

  // Background
  ctx.fillStyle = '#080810';
  ctx.fillRect(0, 0, W, H);

  // Subtle vignette
  const vg = ctx.createRadialGradient(W/2, H/2, H*0.1, W/2, H/2, H*0.9);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);

  // Color accent bar at top
  ctx.fillStyle = S.color;
  ctx.globalAlpha = 0.7;
  ctx.fillRect(0, 0, W, 3);
  ctx.globalAlpha = 1;

  // Reel badge (top-left)
  const badgeTxt = `REEL ${S.reelNum}`;
  ctx.font = `bold 11px monospace`;
  const bw = ctx.measureText(badgeTxt).width + 16;
  ctx.fillStyle = S.color;
  ctx.globalAlpha = 0.18;
  roundRect(ctx, 10, 12, bw, 20, 4);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = S.color;
  ctx.fillText(badgeTxt, 18, 25);

  // Codec badge (top-right)
  const codec = S.codec !== '–' ? S.codec : 'HTJ2K';
  ctx.font = 'bold 10px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.textAlign = 'right';
  ctx.fillText(codec, W - 12, 24);
  ctx.textAlign = 'left';

  // Filename (below badge)
  if (S.filename) {
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    const maxW = W - 120;
    let name = S.filename;
    while (name.length > 4 && ctx.measureText(name + '…').width > maxW) {
      name = name.slice(0, -1);
    }
    if (name !== S.filename) name += '…';
    ctx.fillText(name, 12, 44);
  }

  // Resolution
  if (S.resolution && S.resolution !== '–') {
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.textAlign = 'right';
    ctx.fillText(S.resolution, W - 12, 44);
    ctx.textAlign = 'left';
  }

  // ── Center: frame data or timecode ──────────────────────────────────────────
  const tc = fmtTC(S.currentFrame, S.fps, _tcOpts());

  if (!S.frameImageData && !S.frameBitmap && S.displayFrame == null) {
    _restoreAnyUsefulCachedFrame(S.currentFrame);
  }

  if (S.frameImageData) {
    // ── Decoded ImageData: browser-safe preview path ─────────────────────────
    const img = S.frameImageData;
    let surface = S.frameSurface;
    if (!surface || surface.width !== img.width || surface.height !== img.height) {
      surface = _createFrameSurface(img.width, img.height);
      S.frameSurface = surface;
    }
    const sctx = surface.getContext('2d', { alpha: false, willReadFrequently: false });
    sctx.putImageData(img, 0, 0);

    const scale = Math.min(W / img.width, H / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;
    try {
      ctx.filter = _trimFilter;
      ctx.drawImage(surface, dx, dy, dw, dh);
      ctx.filter = 'none';
    } catch (e) {
      ctx.filter = 'none';
      console.warn('[IMF] drawImage failed for frame surface', e);
    }
    _toneMapCtx(ctx, dx, dy, dw, dh);   // rawHDR PQ/HLG → SDR salvage (no-op otherwise)

    const tc2 = fmtTC((S.displayFrame ?? S.currentFrame), S.fps, _tcOpts());
    ctx.font = 'bold 13px monospace';
    const tw = ctx.measureText(tc2).width;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(8, H - 36, tw + 16, 24);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(tc2, 16, H - 18);
    if (S.displayFrame != null && S.displayFrame !== S.currentFrame) {
      ctx.font = '10px monospace';
      ctx.fillStyle = 'rgba(255,255,120,0.75)';
      const waitBits = [`buffering → fr ${(S.currentFrame + 1).toLocaleString()}`, _playbackModeLabel()];
      if (S.previewScale < 1) waitBits.push(_previewLabel());
      ctx.fillText(waitBits.join('  '), 16, H - 48);
    }

  } else if (S.frameBitmap) {
    // ── Decoded ImageBitmap: optional fast path ──────────────────────────────
    const bm = S.frameBitmap;
    const scale = Math.min(W / bm.width, H / bm.height);
    const dw = bm.width * scale;
    const dh = bm.height * scale;
    const dx = (W - dw) / 2;
    const dy = (H - dh) / 2;
    try {
      ctx.filter = _trimFilter;
      ctx.drawImage(bm, dx, dy, dw, dh);
      ctx.filter = 'none';
    } catch (e) {
      ctx.filter = 'none';
      console.warn('[IMF] drawImage failed for decoded bitmap', e);
    }
    _toneMapCtx(ctx, dx, dy, dw, dh);   // rawHDR PQ/HLG → SDR salvage (no-op otherwise)

    const tc2 = fmtTC((S.displayFrame ?? S.currentFrame), S.fps, _tcOpts());
    ctx.font = 'bold 13px monospace';
    const tw = ctx.measureText(tc2).width;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(8, H - 36, tw + 16, 24);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(tc2, 16, H - 18);
    if (S.displayFrame != null && S.displayFrame !== S.currentFrame) {
      ctx.font = '10px monospace';
      ctx.fillStyle = 'rgba(255,255,120,0.75)';
      const waitBits = [`buffering → fr ${(S.currentFrame + 1).toLocaleString()}`, _playbackModeLabel()];
      if (S.previewScale < 1) waitBits.push(_previewLabel());
      ctx.fillText(waitBits.join('  '), 16, H - 48);
    }

  } else if (S.frameBytes && S.frameBytes.length > 0) {
    // ── J2K frame bytes available: draw data visualization ───────────────────
    const j2k = S.frameJ2K;

    // Resolution info (center-top)
    if (j2k?.width && j2k?.height) {
      const resTxt = `${j2k.width} × ${j2k.height}`;
      const resFontSz = Math.max(16, Math.min(38, Math.floor(W / 14)));
      ctx.font = `bold ${resFontSz}px monospace`;
      ctx.fillStyle = S.color;
      ctx.globalAlpha = 0.9;
      ctx.textAlign = 'center';
      ctx.fillText(resTxt, W / 2, H / 2 - 14);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
    }

    // Timecode (smaller, below resolution)
    const tcFontSize = Math.max(14, Math.min(30, Math.floor(W / 14)));
    ctx.font = `bold ${tcFontSize}px monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'center';
    const tcY = H / 2 + tcFontSize + (j2k?.width ? 10 : 0);
    ctx.fillText(tc, W / 2, tcY);
    ctx.textAlign = 'left';

    // Frame size badge
    const kb = (S.frameBytes.length / 1024).toFixed(0);
    const mb = S.frameBytes.length >= 1024 * 1024 ? (S.frameBytes.length / (1024*1024)).toFixed(2) + ' MB' : kb + ' KB';
    ctx.font = '10px monospace';
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.textAlign = 'center';
    ctx.fillText(`J2K · ${mb}`, W / 2, tcY + tcFontSize);
    ctx.textAlign = 'left';

    // ── Byte-strip visualization (bottom third) ───────────────────────────────
    const stripH = Math.max(18, Math.min(36, H * 0.12));
    const stripY = H - 26 - stripH - 6;
    const stripW = W - 24;
    const stripX = 12;
    const sampleCount = Math.min(S.frameBytes.length, stripW);
    const step = S.frameBytes.length / sampleCount;
    for (let i = 0; i < sampleCount; i++) {
      const byteVal = S.frameBytes[Math.floor(i * step)];
      const hue = (byteVal * 1.41) % 360;          // map 0-255 to a hue
      const lum = 25 + (byteVal / 255) * 35;       // luminance 25–60%
      ctx.fillStyle = `hsl(${hue},40%,${lum}%)`;
      ctx.fillRect(stripX + i, stripY, 1, stripH);
    }
    // border
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    ctx.strokeRect(stripX, stripY, stripW, stripH);

    // Timeline TC
    if (S.tcOffset > 0) {
      const absTc = fmtTC(S.tcOffset + S.currentFrame, S.fps, _tcOpts());
      ctx.font = '9px monospace';
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.textAlign = 'center';
      ctx.fillText(`TL: ${absTc}`, W / 2, tcY + tcFontSize + 16);
      ctx.textAlign = 'left';
    }

  } else {
    // ── No frame bytes yet: fallback timecode display ─────────────────────────
    const tcFontSize = Math.max(22, Math.min(52, Math.min(Math.floor(W / 9), Math.floor(H / 4.5))));
    ctx.font = `bold ${tcFontSize}px monospace`;
    ctx.fillStyle = 'rgba(255,255,255,0.90)';
    ctx.textAlign = 'center';
    const tcY = H / 2 + tcFontSize * 0.38;
    ctx.fillText(tc, W / 2, tcY);
    ctx.textAlign = 'left';

    if (S.tcOffset > 0) {
      const absTc = fmtTC(S.tcOffset + S.currentFrame, S.fps, _tcOpts());
      const subSize = Math.max(9, Math.min(12, Math.floor(tcFontSize * 0.28)));
      ctx.font = `${subSize}px monospace`;
      ctx.fillStyle = 'rgba(255,255,255,0.28)';
      ctx.textAlign = 'center';
      ctx.fillText(`TL: ${absTc}`, W / 2, tcY + subSize + 6);
      ctx.textAlign = 'left';
    }

    // Index / scan status hint
    {
      let hint = '';
      if (S.mxfScanning) {
        hint = `Scanning MXF… ${Math.round(S.scanPct)}%`;
      } else if (S.mxfIndex) {
        if (S.mxfIndex.error) hint = `MXF: ${S.mxfIndex.error}`;
        else if (S.mxfIndex.frameCount === 0) hint = 'MXF: index found but 0 frames';
        else if (!S.mxfIndex.frameOffsets && !S.mxfIndex.editUnitByteCount) hint = 'MXF: no index — essence walk failed';
        else if (S.mxfIndex.essenceStartOffset === 0) hint = 'MXF: essence start not found';
        else hint = `MXF: ${S.mxfIndex.frameCount}fr  ess@0x${S.mxfIndex.essenceStartOffset.toString(16)}`;
      } else if (S.mxfFile) {
        hint = 'Waiting for MXF scan…';
      }
      if (hint) {
        ctx.font = '9px monospace';
        ctx.fillStyle = 'rgba(255,255,100,0.45)';
        ctx.textAlign = 'center';
        ctx.fillText(hint, W / 2, tcY + 32);
        ctx.textAlign = 'left';
      }
    }
  }

  // ── Diagnostic overlay (build/lane/drop/decode-ms) ──────────────────────────
  // Hidden by default — this developer HUD does not belong burned onto the image
  // in a delivery-QC tool. Enable with `window.PFX_DEBUG_IMF = true` when profiling.
  if (window.PFX_DEBUG_IMF) {
    ctx.font = 'bold 10px monospace';
    ctx.fillStyle = 'rgba(255,200,50,0.7)';
    ctx.textAlign = 'right';
    const buildBits = [_playbackModeLabel()];
    const lanes = _decoderLaneCount();
    if (S.previewScale < 1) buildBits.push(_previewLabel());
    if (lanes > 1) buildBits.push(`LANE ${lanes}`);
    if (S.droppedFrames > 0) buildBits.push(`DROP ${S.droppedFrames}`);
    if (S.decodeAvgMs > 0) buildBits.push(`${Math.round(S.decodeAvgMs)}ms`);
    ctx.fillText(buildBits.join('  '), W - 6, 58);
    ctx.textAlign = 'left';
  }

  // ── Real-time playback health HUD (operator toggle: 'H' key) ────────────────
  // Surfaces whether playback is actually hitting cadence, at what preview scale,
  // and (when audio drives) the A/V offset — all derived from existing S.* fields,
  // no extra decode work. Off by default so it never burns onto delivery captures.
  if (S.showRtHud) {
    const scaleLabel = S.previewScale <= 0.25 ? 'Quarter' : (S.previewScale < 1 ? 'Half' : 'Full');
    const bits = [
      `${(S.rtHudFps || 0).toFixed(1)} fps`,
      `scale ${scaleLabel}`,
      `drop ${S.droppedFrames | 0}`,
      `${Math.round(S.decodeAvgMs || 0)}ms`,
    ];
    if (_avLockActive()) bits.push(`A/V ${S.avOffsetMs >= 0 ? '+' : ''}${Math.round(S.avOffsetMs)}ms`);
    const text = bits.join('  ·  ');
    ctx.font = 'bold 10px monospace';
    const tw = ctx.measureText(text).width;
    const padX = 8, boxH = 18, bx = 8, by = 8;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, bx, by, tw + padX * 2, boxH, 4);
    ctx.fill();
    const targetFps = S.fps || 24;
    const cadenceOk = (S.rtHudFps || 0) >= targetFps * 0.9 && S.previewScale >= 1;
    ctx.fillStyle = cadenceOk ? '#4caf80' : (S.previewScale < 1 ? '#f7a26a' : '#e5c07b');
    ctx.textAlign = 'left';
    ctx.fillText(text, bx + padX, by + 13);
  }

  const barH = 26;

  // ── Per-frame nits HUD (DV content) ─────────────────────────────────────────
  if (S.doviShots && S.doviShots.length && S.frameMaxNits > 0) {
    const activeShot = S.doviShots.find(s => {
      const f = S.proxyMode ? (S.proxyTcOffset || 0) + Math.round((Number(S.proxyVideoEl?.currentTime) || 0) * (S.proxyFps || 24)) : (S.tcOffset || 0) + S.currentFrame;
      return f >= s.begin && f <= s.end;
    });
    // Shots stored in S.doviShots use flat l1MaxNits (not nested l1.maxNits).
    const l1Nits = activeShot?.l1MaxNits ?? S.frameMaxNits;
    const nitsLabel = `L1 ${l1Nits.toLocaleString()} nits`;
    const modeLabel = (S.previewMode || 'sdr').toUpperCase();
    ctx.font = 'bold 9px monospace';
    const nw = ctx.measureText(nitsLabel).width;
    const mw = ctx.measureText(modeLabel).width;
    const hudW = Math.max(nw, mw) + 14;
    const hudH = 30;
    const hudX = W - hudW - 8;
    const hudY = H - barH - hudH - 4;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, hudX, hudY, hudW, hudH, 4);
    ctx.fill();
    const modeColor = (S.previewMode === 'full' || S.previewMode === 'hdr') ? '#f7a26a' : S.previewMode === 'trim' ? '#7c6af7' : '#4caf80';
    ctx.fillStyle = modeColor;
    ctx.textAlign = 'center';
    ctx.fillText(modeLabel, hudX + hudW / 2, hudY + 12);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.font = '8px monospace';
    ctx.fillText(nitsLabel, hudX + hudW / 2, hudY + 24);
    ctx.textAlign = 'left';
  }

  // ── Preview status badge ─────────────────────────────────────────────────────
  {
    const ps = S.previewStatus;
    let statusLabel = '';
    let statusColor = 'rgba(255,255,255,0.5)';
    if (ps.status === 'REAL_FRAME') {
      const engMap = { 'j2k-worker': 'J2K', 'j2k-main': 'J2K (main)', 'bitmap': 'Browser', 'ffmpeg': 'FFmpeg', 'ffmpeg-openjph': 'FFmpeg+OJ', 'ojph': 'ojph_expand', 'resolve': 'Resolve', 'electron-ffmpeg': 'eFFmpeg', 'electron-cache': 'eCache', 'electron-ffmpeg-openjph': 'eFFmpeg+OJ', 'electron-ojph': 'eOJPH' };
      const er0 = (S.decodeInfo?.electronResults || [])[0];
      const rawHDRWarning = er0?.rawHDR ? ' · rawHDR' : '';
      statusLabel = `Real frame · ${engMap[ps.engine] || ps.engine || 'J2K'}${rawHDRWarning}`;
      statusColor = er0?.rawHDR ? '#f7a26a' : '#4caf80';
    } else if (ps.status === 'PROXY_FRAME') {
      statusLabel = 'Proxy preview';
      statusColor = '#f7a26a';
    } else if (ps.status === 'PLACEHOLDER_ONLY') {
      statusLabel = 'Placeholder · no decoded pixels';
      statusColor = '#e55353';
    } else if (ps.status === 'ERROR') {
      statusLabel = `Error · ${ps.diagnostic || 'decode failed'}`;
      statusColor = '#e55353';
    }
    if (statusLabel) {
      ctx.font = 'bold 9px monospace';
      const sw = ctx.measureText(statusLabel).width + 14;
      const sh = 16;
      const sx2 = W - sw - 8;
      const sy2 = H - barH - sh - 6;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      roundRect(ctx, sx2, sy2, sw, sh, 3);
      ctx.fill();
      ctx.fillStyle = statusColor;
      ctx.textAlign = 'right';
      ctx.fillText(statusLabel, W - 15, sy2 + sh - 4);
      ctx.textAlign = 'left';
    }

    // ── Pipeline stage chips (CPL Parse / Asset Resolve / MXF Packet Read / Pixel Decode / Decoder)
    const pip = S.pipelineStatus;
    if (pip && (pip.cplParse || pip.assetResolve || pip.mxfRead || pip.pixelDecode)) {
      const stages = [
        { label: 'CPL',     key: pip.cplParse },
        { label: 'Assets',  key: pip.assetResolve },
        { label: 'MXF',     key: pip.mxfRead },
        { label: 'Decode',  key: pip.pixelDecode },
        { label: pip.decoder ? String(pip.decoder).slice(0, 12) : 'Backend', key: pip.pixelDecode },
      ];
      const chipH  = 12;
      const chipGap = 3;
      ctx.font = '7px monospace';
      let cx = 8;
      const cy = H - barH - chipH - 4;
      for (const s of stages) {
        if (!s.key && !s.label) continue;
        const chipColor = s.key === 'ok' ? '#4caf80' : s.key === 'fail' ? '#e55353' : 'rgba(255,255,255,0.3)';
        const chipLabel = `${s.label}${s.key === 'ok' ? ' ✓' : s.key === 'fail' ? ' ✗' : ''}`;
        const chipW = ctx.measureText(chipLabel).width + 8;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        roundRect(ctx, cx, cy, chipW, chipH, 2);
        ctx.fill();
        ctx.fillStyle = chipColor;
        ctx.fillText(chipLabel, cx + 4, cy + chipH - 2);
        cx += chipW + chipGap;
      }
    }
  }

  // ── Decode Info panel (toggle with D key) ────────────────────────────────────
  if (S.decodeInfo && S.decodeInfo.show) {
    const di  = S.decodeInfo;
    const la  = di.lastAttempt;
    const er  = (di.electronResults || [])[0];
    const lines = [
      'Decode Info  (D to hide)',
      `Backend:    ${la ? la.backend : S.previewStatus.engine || '—'}`,
      `Codec:      ${S.codec !== '–' ? S.codec : 'HTJ2K'}  ${S.resolution || ''}`,
      `MXF:        ${S.mxfPath ? S.mxfPath.split('/').pop() : '—'}`,
      `EntryPt:    ${S.entryPoint || 0}  IntrDur: ${S.intrinsicDuration || '—'}`,
      `Frame:      reel ${S.currentFrame}  →  MXF ${(S.entryPoint || 0) + S.currentFrame}`,
      `CPL:        ${S.cplId ? S.cplId.slice(-16) : '—'}`,
      `Luma:       ${la?.lumaClass || '—'}  Black fr: ${di.blackFrames}  Failed: ${di.failedFrames}`,
      `ToneMap:    ${er?.toneMapApplied ? 'zscale/PQ→SDR' : er?.rawHDR ? 'NONE (rawHDR)' : '—'}`,
      `Last:       ${la ? (la.ok ? 'ok' : `FAIL ${la.code || la.error || ''}`) : '—'}  ${la?.elapsed != null ? la.elapsed + 'ms' : ''}`,
      (() => {
        const sd = di.sysDiag;
        if (!sd) return 'Backends:   fetching…';
        const parts = [];
        if (sd.resolveAvailable)      parts.push('Resolve');
        if (sd.htj2kFfmpegOpenjph)    parts.push('FFmpeg+OJ');
        if (sd.htj2kOjphExpand)       parts.push('ojph_expand');
        if (sd.ffmpegAvailable)       parts.push('FFmpeg');
        return `Backends:   ${parts.length ? parts.join(' · ') : 'none detected'}`;
      })(),
    ];
    const panelPad = 10; const lineH = 14;
    const panelH = lines.length * lineH + panelPad * 2;
    const panelW = Math.min(310, W - 16);
    const panelX = 8;
    const panelY = H - barH - panelH - 6;
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    roundRect(ctx, panelX, panelY, panelW, panelH, 5);
    ctx.fill();
    ctx.textAlign = 'left';
    lines.forEach((line, i) => {
      ctx.font      = i === 0 ? 'bold 9px monospace' : '9px monospace';
      ctx.fillStyle = i === 0 ? '#f7a26a' : i % 2 === 0 ? 'rgba(200,220,255,0.75)' : 'rgba(255,255,255,0.72)';
      ctx.fillText(line, panelX + panelPad, panelY + panelPad + (i + 0.75) * lineH);
    });
    // "Copy Decode Diagnostic" button above the panel
    const btnW = 180; const btnH = 17;
    const btnX = panelX; const btnY = panelY - btnH - 3;
    ctx.fillStyle = 'rgba(40,70,120,0.88)';
    roundRect(ctx, btnX, btnY, btnW, btnH, 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.font = 'bold 8px monospace';
    ctx.fillText('Copy Decode Diagnostic', btnX + 8, btnY + 12);
    S._decodeInfoBtnRect = { x: btnX, y: btnY, w: btnW, h: btnH };
  } else {
    S._decodeInfoBtnRect = null;
  }

  // ── Bottom bar ──────────────────────────────────────────────────────────────
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, H - barH, W, barH);

  // Frame number (bottom-left)
  ctx.font = '11px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillText(`Fr ${(S.currentFrame + 1).toLocaleString()}`, 10, H - 8);

  // FPS (bottom-center)
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(255,255,255,0.3)';
  ctx.fillText(`${S.fps} fps`, W / 2, H - 8);

  // Total frames (bottom-right)
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.fillText(`/ ${S.totalFrames.toLocaleString()} fr`, W - 10, H - 8);
  ctx.textAlign = 'left';

  // Playing indicator (top-right, below codec text — position scales with H)
  if (S.isPlaying) {
    const dotY = Math.min(62, H * 0.18);
    ctx.fillStyle = S.color;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.arc(W - 18, dotY, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.font = '8px monospace';
    ctx.fillStyle = S.color;
    ctx.textAlign = 'right';
    ctx.fillText('PLAY', W - 26, dotY + 3);
    ctx.textAlign = 'left';
  }

  // Multi-layer compare overlay — last, so it sits above the picture + chrome.
  // No-op unless compare is enabled and a comparison frame has been supplied.
  _drawCompareOverlay();
}

// ── HDR → SDR tone map (rawHDR safety net) ────────────────────────────────────
// The IMF ffmpeg backend already tone-maps PQ/HLG → Rec.709 SDR (zscale + hable)
// whenever displayMode==='sdr' (the default), so decoded pixels are normally
// already display-ready. The ONLY case where un-mapped HDR pixels reach the
// canvas is the `rawHDR` fallback — when libzimg/zscale was unavailable and the
// backend returned the raw PQ/HLG frame. This pass salvages those frames with a
// lightweight per-channel inverse-EOTF + Reinhard roll-off so they are viewable
// on an SDR display instead of blown out. It is gated on `rawHDR` precisely so it
// never double-tone-maps already-SDR pixels (which would crush the image).
//
// Operates on the picture rectangle only (x,y,w,h) so the burn-in chrome drawn
// outside the image is never touched.
function _toneMapCtx(ctx, x, y, w, h) {
  const er0 = (S.decodeInfo?.electronResults || [])[0];
  if (!er0?.rawHDR) return;                          // backend already mapped → pass-through
  const transfer = S.transfer || '';
  const isPq  = /PQ|2084/i.test(transfer);
  const isHlg = /HLG|B67/i.test(transfer);
  if (!isPq && !isHlg) return;                       // SDR source — nothing to do

  const cw = ctx.canvas.width, ch = ctx.canvas.height;
  const ix = Math.max(0, Math.floor(x));
  const iy = Math.max(0, Math.floor(y));
  const iw = Math.min(cw - ix, Math.ceil(w));
  const ih = Math.min(ch - iy, Math.ceil(h));
  if (iw <= 0 || ih <= 0) return;

  let imgData;
  try { imgData = ctx.getImageData(ix, iy, iw, ih); } catch { return; }
  const d = imgData.data;
  const len = d.length;

  if (isPq) {
    // ST 2084 inverse EOTF → linear, then Reinhard at a 100-nit display target.
    const m1 = 2610 / 16384, m2 = 2523 / 32, c1 = 107 / 128, c2 = 2413 / 128, c3 = 2392 / 128;
    for (let i = 0; i < len; i += 4) {
      for (let c = 0; c < 3; c++) {
        const v = d[i + c] / 255;
        const Vp = Math.pow(v, 1 / m2);
        const lin = Math.pow(Math.max(0, Vp - c1) / (c2 - c3 * Vp), 1 / m1);
        // PQ peak 10,000 nit → 100 nit display
        const scaled = lin * 100;
        d[i + c] = Math.round(Math.min(1, scaled / (1 + scaled)) * 255);
      }
    }
  } else {
    // BT.2100 HLG inverse OETF → display (simplified).
    const a = 0.17883277, b = 0.28466892, c = 0.55991073;
    for (let i = 0; i < len; i += 4) {
      for (let ch2 = 0; ch2 < 3; ch2++) {
        const v = d[i + ch2] / 255;
        const lin = v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12;
        d[i + ch2] = Math.round(Math.min(1, lin) * 255);
      }
    }
  }
  ctx.putImageData(imgData, ix, iy);
}

// ── Scope engine ──────────────────────────────────────────────────────────────
// Draws parade / waveform / vectorscope from RGBA pixel data into the scope canvas.
// Uses a downsampled line scan for performance (every N-th pixel column).
// ── Scope Overview: frame stats & mini-canvas rendering ──────────────────────
let _lastScopeAnalysisMs = 0;
const _SCOPE_ANALYSIS_INTERVAL = 160; // ~6 fps max

// Offscreen capture buffer (reused across frames)
let _scopeOffscreen = null;
let _scopeOffscreenCtx = null;
const _SCOPE_CAP_W = 256, _SCOPE_CAP_H = 144;

// RAF loop handle
let _scopeLoopId = null;

// Last capture result (shared across stats + mini drawing)
let _activeScopePx  = null;
let _activeScopeW   = 0;
let _activeScopeH   = 0;
let _activeScopeSrc = '';

// ── Frame capture from the best available source ──────────────────────────────
// Priority: J2K scope buffer → proxy video → player canvas
function _captureScopeFrame() {
  const logDbg = window.PFX_DEBUG_SCOPES;

  // Gate: placeholder or error state has no real pixel data — scopes must not run
  if (!S.previewStatus.canRunScopes) {
    _activeScopePx  = null;
    _activeScopeW   = 0;
    _activeScopeH   = 0;
    _activeScopeSrc = 'No real pixel data';
    return false;
  }

  // 1. J2K decoded scope buffer (render worker path)
  if (S.framePixels && S.framePixW > 0 && S.framePixH > 0) {
    _activeScopePx = S.framePixels;
    _activeScopeW  = S.framePixW;
    _activeScopeH  = S.framePixH;
    _activeScopeSrc = 'j2k';
    if (logDbg) console.log(`[PFX Scopes] source=j2k ${S.framePixW}x${S.framePixH}`);
    return true;
  }

  // Ensure offscreen canvas exists
  if (!_scopeOffscreen) {
    _scopeOffscreen = document.createElement('canvas');
    _scopeOffscreen.width  = _SCOPE_CAP_W;
    _scopeOffscreen.height = _SCOPE_CAP_H;
    _scopeOffscreenCtx = _scopeOffscreen.getContext('2d', { alpha: false, willReadFrequently: true });
  }

  // 2. Proxy video element
  const vid = S.proxyVideoEl || document.querySelector('#main-imf video.imf-proxy-video') || document.querySelector('#main-imf video');
  if (vid && vid.videoWidth > 0 && vid.readyState >= 2) {
    try {
      _scopeOffscreenCtx.drawImage(vid, 0, 0, _SCOPE_CAP_W, _SCOPE_CAP_H);
      const imgData = _scopeOffscreenCtx.getImageData(0, 0, _SCOPE_CAP_W, _SCOPE_CAP_H);
      _activeScopePx  = imgData.data;
      _activeScopeW   = _SCOPE_CAP_W;
      _activeScopeH   = _SCOPE_CAP_H;
      _activeScopeSrc = 'proxy-video';
      if (logDbg) console.log(`[PFX Scopes] source=proxy-video ${vid.videoWidth}x${vid.videoHeight} readyState=${vid.readyState}`);
      return true;
    } catch (e) {
      _activeScopeSrc = e.name === 'SecurityError' ? 'Cannot sample frame (CORS)' : 'Frame capture failed';
      if (logDbg) console.warn('[PFX Scopes]', _activeScopeSrc, e);
      _activeScopePx = null; return false;
    }
  }

  // 3. J2K player canvas (already decoded to canvas)
  const playerCanvas = S.canvas || document.querySelector('#main-imf canvas.imf-canvas');
  if (playerCanvas && playerCanvas.width > 0 && playerCanvas.height > 0) {
    try {
      _scopeOffscreenCtx.drawImage(playerCanvas, 0, 0, _SCOPE_CAP_W, _SCOPE_CAP_H);
      const imgData = _scopeOffscreenCtx.getImageData(0, 0, _SCOPE_CAP_W, _SCOPE_CAP_H);
      _activeScopePx  = imgData.data;
      _activeScopeW   = _SCOPE_CAP_W;
      _activeScopeH   = _SCOPE_CAP_H;
      _activeScopeSrc = 'player-canvas';
      if (logDbg) console.log(`[PFX Scopes] source=player-canvas ${playerCanvas.width}x${playerCanvas.height}`);
      return true;
    } catch (e) {
      _activeScopeSrc = 'Cannot sample player canvas';
      if (logDbg) console.warn('[PFX Scopes]', _activeScopeSrc, e);
      _activeScopePx = null; return false;
    }
  }

  _activeScopeSrc = vid ? 'Waiting for video frame' : 'No player frame found';
  _activeScopePx = null;
  if (logDbg) console.log('[PFX Scopes]', _activeScopeSrc);
  return false;
}

// ── RAF-based scope update loop (6 fps while overview active) ─────────────────
function _startScopeLoop() {
  if (_scopeLoopId !== null) return;
  const tick = () => {
    if (S.scopeTab === 'overview') {
      const now = performance.now();
      if (now - _lastScopeAnalysisMs >= _SCOPE_ANALYSIS_INTERVAL) {
        _lastScopeAnalysisMs = now;
        _updateScopeOverview();
      }
    }
    _scopeLoopId = requestAnimationFrame(tick);
  };
  _scopeLoopId = requestAnimationFrame(tick);
}

function _stopScopeLoop() {
  if (_scopeLoopId !== null) { cancelAnimationFrame(_scopeLoopId); _scopeLoopId = null; }
}

// ── Ensure mini canvases are properly sized (lazy — clientWidth may be 0 at init) ──
function _ensureMiniCanvasReady(id, fallbackW, fallbackH) {
  const el = document.getElementById(id);
  if (!el) return false;
  const dpr = window.devicePixelRatio || 1;
  const cw  = el.clientWidth  || fallbackW;
  const ch  = el.clientHeight || fallbackH;
  // Size the bitmap to the live CSS layout box. NOTE: we deliberately do NOT
  // pin el.style.width/height — the canvas display size is driven by CSS
  // (width/height:100% inside the grid cell), so clientWidth/clientHeight
  // always reflect the current card size and the bitmap follows on resize.
  const wantW = Math.round(cw * dpr), wantH = Math.round(ch * dpr);
  if (el.width !== wantW || el.height !== wantH) {
    el.width  = wantW || Math.round(fallbackW * dpr);
    el.height = wantH || Math.round(fallbackH * dpr);
    const ctx = el.getContext('2d', { alpha: false, willReadFrequently: false });
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    el._pfxCtx = ctx;
  }
  return !!(el._pfxCtx && el.width > 0 && el.height > 0);
}

function _computeFrameStats() {
  // Use the last captured frame (_activeScopePx set by _captureScopeFrame)
  const px = _activeScopePx;
  if (!px || _activeScopeW === 0 || _activeScopeH === 0) return null;
  const iW = _activeScopeW, iH = _activeScopeH, total = iW * iH;
  const step = Math.max(1, Math.floor(total / 3000));
  let rS=0, gS=0, bS=0, lMin=255, lMax=0, lS=0, satS=0, satMax=0, n=0;
  for (let i = 0; i < total; i += step) {
    const b2 = i * 4;
    const r = px[b2], g = px[b2+1], b = px[b2+2];
    rS += r; gS += g; bS += b;
    const l = Math.round(0.2126*r + 0.7152*g + 0.0722*b);
    if (l < lMin) lMin = l; if (l > lMax) lMax = l; lS += l;
    const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    satS += sat; if (sat > satMax) satMax = sat;
    n++;
  }
  if (!n) return null;
  return { rAvg:rS/n, gAvg:gS/n, bAvg:bS/n, lumaMin:lMin, lumaMax:lMax, lumaAvg:lS/n, satAvg:satS/n, satMax };
}

function _castLabel(st) {
  if (!st) return '–';
  const {rAvg:r, gAvg:g, bAvg:b} = st;
  const avg = (r+g+b)/3, thr = 14;
  const rd = Math.abs(r-avg) < thr, gd = Math.abs(g-avg) < thr, bd = Math.abs(b-avg) < thr;
  if (rd && gd && bd) return 'Neutral';
  const rh = r > avg+thr, gh = g > avg+thr, bh = b > avg+thr;
  if (rh && gh) return 'Yellow'; if (rh && bh) return 'Magenta'; if (gh && bh) return 'Cyan';
  if (rh) return 'Red'; if (gh) return 'Green'; if (bh) return 'Blue';
  return 'Mixed';
}

function _clipLabel(st) {
  if (!st) return '–';
  const bl = st.lumaMin < 6, wh = st.lumaMax > 249;
  if (bl && wh) return 'Black+White clip';
  if (bl) return 'Black clip';
  if (wh) return 'White clip';
  return 'OK';
}

function _warn(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? '' : 'none';
}

// Set text AND apply a semantic color class (ok/warn/clip) to the value span.
function _setValText(id, val, cls) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = val;
  el.classList.remove('imf-val-ok', 'imf-val-warn', 'imf-val-clip');
  if (cls) el.classList.add(cls);
}

function _setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function _drawToMini(id, fn) {
  const el = document.getElementById(id);
  if (!el || !el._pfxCtx) return;
  const dpr = window.devicePixelRatio || 1;
  const W = el.width / dpr, H = el.height / dpr;
  const sx = el._pfxCtx;
  sx.fillStyle = '#0d0d18'; sx.fillRect(0, 0, W, H);
  fn(sx, W, H);
}

function _drawMiniParade(sx, W, H) {
  const px = _activeScopePx, iW = _activeScopeW, iH = _activeScopeH;
  if (!px || !iW) return;
  const gap = 1, colW = Math.floor((W - gap*4) / 3);
  const COLS = [
    { off:0, col:'rgba(255,80,80,'   },
    { off:1, col:'rgba(60,230,100,'  },
    { off:2, col:'rgba(80,140,255,'  },
  ];
  const IRE = [0, 0.5, 1];
  COLS.forEach(({off, col}, ci) => {
    const x0 = gap + ci*(colW+gap);
    for (const ire of IRE) {
      const y = Math.round(H - ire*H);
      sx.strokeStyle = ire===0||ire===1 ? 'rgba(255,255,255,.30)' : 'rgba(255,255,255,.14)';
      sx.lineWidth=0.5;
      sx.beginPath(); sx.moveTo(x0,y); sx.lineTo(x0+colW,y); sx.stroke();
    }
    const maxH = Math.max(1, iH/2);
    for (let cx2=0; cx2<colW; cx2++) {
      const srcCol = Math.min(Math.round(cx2*iW/colW), iW-1);
      const hist = new Uint32Array(256);
      for (let row=0; row<iH; row+=3) hist[px[(row*iW+srcCol)*4+off]]++;
      for (let v=0; v<256; v++) {
        if (!hist[v]) continue;
        const y = Math.round(H-(v/255)*H);
        const a = Math.min(1.0, .35+hist[v]/maxH*.70);
        sx.fillStyle = col+a.toFixed(2)+')';
        sx.fillRect(x0+cx2, y, 1, 1);
      }
    }
  });
}

function _drawMiniWave(sx, W, H) {
  const px = _activeScopePx, iW = _activeScopeW, iH = _activeScopeH;
  if (!px || !iW) return;
  const IRE=[0,0.5,1];
  for (const ire of IRE) {
    const y=Math.round(H-ire*H);
    sx.strokeStyle=ire===0||ire===1?'rgba(255,255,255,.30)':'rgba(255,255,255,.14)';
    sx.lineWidth=0.5;
    sx.beginPath(); sx.moveTo(0,y); sx.lineTo(W,y); sx.stroke();
  }
  const maxH = Math.max(1,iH/2);
  for (let cx2=0; cx2<W; cx2++) {
    const srcCol=Math.min(Math.round(cx2*iW/W),iW-1);
    const hist=new Uint32Array(256);
    for (let row=0; row<iH; row+=3) {
      const b2=(row*iW+srcCol)*4;
      hist[Math.min(Math.round(0.2126*px[b2]+0.7152*px[b2+1]+0.0722*px[b2+2]),255)]++;
    }
    for (let v=0;v<256;v++) {
      if (!hist[v]) continue;
      const y=Math.round(H-(v/255)*H);
      const a=Math.min(1.0,.30+hist[v]/maxH*.75);
      sx.fillStyle=`rgba(72,230,120,${a.toFixed(2)})`;
      sx.fillRect(cx2,y,1,1);
    }
  }
}

function _drawMiniVector(sx, W, H) {
  const px = _activeScopePx, iW = _activeScopeW, iH = _activeScopeH;
  const cx2=W/2, cy2=H/2, R=Math.min(W,H)*0.44;
  sx.strokeStyle='rgba(255,255,255,.28)'; sx.lineWidth=0.5;
  sx.beginPath(); sx.arc(cx2,cy2,R,0,Math.PI*2); sx.stroke();
  sx.strokeStyle='rgba(255,255,255,.14)';
  sx.beginPath(); sx.arc(cx2,cy2,R*.75,0,Math.PI*2); sx.stroke();
  sx.beginPath(); sx.moveTo(cx2-R,cy2); sx.lineTo(cx2+R,cy2); sx.stroke();
  sx.beginPath(); sx.moveTo(cx2,cy2-R); sx.lineTo(cx2,cy2+R); sx.stroke();
  if (!px || !iW) return;
  const step=Math.max(1,Math.floor(iW*iH/6000));
  for (let i=0;i<iW*iH;i+=step) {
    const b2=i*4;
    const r=px[b2]/255, g=px[b2+1]/255, b=px[b2+2]/255;
    const cb=-0.1145*r-0.3854*g+0.5*b;
    const cr=0.5*r-0.4541*g-0.0459*b;
    const px3=cx2+cb*R*2, py3=cy2-cr*R*2;
    const dx=px3-cx2, dy=py3-cy2;
    if (dx*dx+dy*dy>R*R) continue;
    sx.fillStyle=`rgba(${px[b2]},${px[b2+1]},${px[b2+2]},0.85)`;
    sx.fillRect(px3,py3,1,1);
  }
}

function _drawMiniAudio(sx, W, H) {
  // Show static bars derived from luma as proxy for audio level
  const px = _activeScopePx, iW = _activeScopeW, iH = _activeScopeH;
  const CH = ['L','R','Ls','Rs','C','LFE'];
  const nCh = Math.min(CH.length, 6);
  const pad = 4, barW = Math.floor((W - pad*2 - (nCh-1)*2) / nCh);
  for (let i=0;i<nCh;i++) {
    const x0 = pad + i*(barW+2);
    let lv = 0;
    if (px && iW) {
      const step = Math.max(1, Math.floor(iW*iH/300));
      let s=0, n=0;
      const chOff = i%3;
      for (let j=0;j<iW*iH;j+=step) { s+=px[j*4+chOff]/255; n++; }
      lv = Math.min(1, n>0 ? s/n * (0.85+0.3*Math.sin(i*1.3)) : 0);
    }
    sx.fillStyle='rgba(255,255,255,.12)';
    sx.fillRect(x0, pad, barW, H-pad*2);
    const bH=Math.round(lv*(H-pad*2));
    const col = lv > .9 ? 'rgba(255,60,60,1.0)' : lv > .7 ? 'rgba(255,210,40,1.0)' : 'rgba(60,220,110,1.0)';
    sx.fillStyle = col;
    sx.fillRect(x0, H-pad-bH, barW, bH);
    sx.fillStyle='rgba(255,255,255,.65)'; sx.font='5px monospace'; sx.textAlign='center';
    sx.fillText(CH[i], x0+barW/2, H-1);
  }
  sx.textAlign='left';
}

function _updateFullStats() {
  const st = _computeFrameStats();
  const el = document.getElementById('imfScopeFullStats');
  if (!el) return;
  if (!st) { el.textContent = ''; return; }
  const pct = v => Math.round(v/2.55)+'%';
  const lines = [];
  if (S.scopeTab === 'parade') {
    lines.push(`R avg ${pct(st.rAvg)}  G avg ${pct(st.gAvg)}  B avg ${pct(st.bAvg)}`);
    lines.push(`Cast: ${_castLabel(st)}`);
  } else if (S.scopeTab === 'waveform') {
    lines.push(`Min ${pct(st.lumaMin)}  Max ${pct(st.lumaMax)}  Avg ${pct(st.lumaAvg)}`);
    lines.push(`Clipping: ${_clipLabel(st)}`);
  } else if (S.scopeTab === 'vector') {
    lines.push(`Sat avg ${(st.satAvg*100).toFixed(1)}%  max ${(st.satMax*100).toFixed(1)}%`);
    lines.push(st.satMax > 0.9 ? '⚠ Over-saturation' : 'Saturation OK');
  } else if (S.scopeTab === 'audio') {
    lines.push('Source: IMF CPL audio track');
    lines.push('Live meter requires proxy playback');
  }
  el.innerHTML = lines.map(l=>`<div class="imf-sfstat">${l}</div>`).join('');
}

function _updateScopeOverview() {
  // 1. Ensure mini canvases are sized (lazy — clientWidth may be 0 at init)
  _ensureMiniCanvasReady('imfSovParade', 220, 100);
  _ensureMiniCanvasReady('imfSovWave',   220, 100);
  _ensureMiniCanvasReady('imfSovVector', 200, 120);
  _ensureMiniCanvasReady('imfSovAudio',  220, 100);

  // 2. Capture frame from the best available source
  const hasFrame = _captureScopeFrame();

  if (window.PFX_DEBUG_SCOPES) console.log(`[PFX Scopes] overview tick src=${_activeScopeSrc} hasFrame=${hasFrame}`);

  // 3. Compute stats if we have pixels
  const st = hasFrame ? _computeFrameStats() : null;
  const pct = v => v != null ? Math.round(v / 2.55) + '%' : '--';

  // 4. Update readouts with color-coded semantic classes
  _setText('imfSovR', st ? pct(st.rAvg) : '--');
  _setText('imfSovG', st ? pct(st.gAvg) : '--');
  _setText('imfSovB', st ? pct(st.bAvg) : '--');
  const cast = st ? _castLabel(st) : '--';
  _setValText('imfSovCast', cast, cast === 'Neutral' ? 'imf-val-ok' : cast === '--' ? '' : 'imf-val-warn');
  _warn('imfWarnParade', cast !== 'Neutral' && cast !== '--' ? cast : '');

  _setText('imfSovLMin', st ? pct(st.lumaMin) : '--');
  _setText('imfSovLMax', st ? pct(st.lumaMax) : '--');
  _setText('imfSovLAvg', st ? pct(st.lumaAvg) : '--');
  const clipTxt = st ? _clipLabel(st) : '--';
  _setValText('imfSovClip', clipTxt,
    clipTxt === 'OK' ? 'imf-val-ok' : clipTxt === '--' ? '' : 'imf-val-clip');
  _warn('imfWarnWave', clipTxt !== 'OK' && clipTxt !== '--' ? clipTxt : '');

  const satAvgPct = st ? (st.satAvg * 100).toFixed(1) + '%' : '--';
  const satMaxPct = st ? (st.satMax * 100).toFixed(1) + '%' : '--';
  _setText('imfSovSatAvg', satAvgPct);
  _setValText('imfSovSatMax', satMaxPct,
    st && st.satMax > 0.9 ? 'imf-val-clip' : st && st.satMax > 0.75 ? 'imf-val-warn' : '');
  _warn('imfWarnVec', st && st.satMax > 0.9 ? 'Over-sat' : '');

  _setText('imfSovAudioPeak', '--');
  _setText('imfSovLUFS', '--');
  _setText('imfSovAudioCh', '--');

  // 5. Draw canvases — error state or live scopes
  if (!hasFrame) {
    const reason = _activeScopeSrc || 'No player frame found';
    ['imfSovParade', 'imfSovWave', 'imfSovVector', 'imfSovAudio'].forEach(id => {
      const canvasEl = document.getElementById(id);
      if (!canvasEl || !canvasEl._pfxCtx) return;
      const dpr = window.devicePixelRatio || 1;
      const W = canvasEl.width / dpr, H = canvasEl.height / dpr;
      const sx = canvasEl._pfxCtx;
      sx.fillStyle = '#040408'; sx.fillRect(0, 0, W, H);
      sx.fillStyle = 'rgba(255,255,255,.22)'; sx.font = '7px monospace'; sx.textAlign = 'center';
      sx.fillText(reason, W / 2, H / 2 + 3);
      sx.textAlign = 'left';
    });
    return;
  }

  if (window.PFX_DEBUG_SCOPES) console.log(`[PFX Scopes] drawing mini scopes ${_activeScopeW}x${_activeScopeH}`);

  // 6. Draw live mini scopes
  _drawToMini('imfSovParade', _drawMiniParade);
  _drawToMini('imfSovWave',   _drawMiniWave);
  _drawToMini('imfSovVector', _drawMiniVector);
  _drawToMini('imfSovAudio',  _drawMiniAudio);
}

function drawScope() {
  // In overview mode, update mini canvases instead (throttled)
  if (S.scopeTab === 'overview') {
    const now = performance.now();
    if (now - _lastScopeAnalysisMs < _SCOPE_ANALYSIS_INTERVAL) return;
    _lastScopeAnalysisMs = now;
    _updateScopeOverview();
    return;
  }
  const sc = S.scopeCanvas;
  const sx = S.scopeCtx;
  if (!sc || !sx) return;

  const W = sc.width;
  const H = sc.height;

  // Dim overlay when viewer has no real pixel data
  if (!S.previewStatus.canRunScopes) {
    sx.fillStyle = '#060610';
    sx.fillRect(0, 0, W, H);
    sx.strokeStyle = 'rgba(255,255,255,0.04)';
    sx.lineWidth = 1;
    for (let i = -H; i < W + H; i += 14) {
      sx.beginPath(); sx.moveTo(i, 0); sx.lineTo(i + H, H); sx.stroke();
    }
    sx.font = 'bold 9px monospace';
    sx.fillStyle = 'rgba(229,83,83,0.75)';
    sx.textAlign = 'center';
    sx.fillText('No real pixel data', W / 2, H / 2 - 9);
    sx.font = '8px monospace';
    sx.fillStyle = 'rgba(255,255,255,0.28)';
    const diag = S.previewStatus.diagnostic || S.previewStatus.status;
    sx.fillText(diag, W / 2, H / 2 + 7);
    sx.textAlign = 'left';
    return;
  }

  sx.fillStyle = '#060610';
  sx.fillRect(0, 0, W, H);

  // Capture frame (handles J2K, proxy video, and player canvas)
  _captureScopeFrame();

  if (!_activeScopePx || _activeScopeW === 0) {
    // No frame data — draw empty horizontal guide lines + reason
    sx.strokeStyle = 'rgba(255,255,255,0.06)'; sx.lineWidth = 0.5;
    for (let i = 1; i < 4; i++) {
      const y = Math.round(H * i / 4);
      sx.beginPath(); sx.moveTo(0, y); sx.lineTo(W, y); sx.stroke();
    }
    sx.fillStyle = 'rgba(255,255,255,0.22)'; sx.font = '8px monospace'; sx.textAlign = 'center';
    sx.fillText(_activeScopeSrc || 'No frame source', W / 2, H / 2);
    sx.textAlign = 'left';
    return;
  }

  if (S.scopeMode === 'parade') _drawParade(sx, W, H);
  else if (S.scopeMode === 'waveform') _drawWaveform(sx, W, H);
  else if (S.scopeMode === 'vector') _drawVector(sx, W, H);
  else if (S.scopeMode === 'meter') _drawAudioMeter(sx, W, H);
}

// ── Shared broadcast graticule helpers ───────────────────────────────────────
// IRE marks: 0, 10, 20 … 100 with key lines at 0/50/75/100
const _IRE_MARKS = [0,10,20,30,40,50,60,70,75,80,90,100];
const _IRE_KEY   = new Set([0,50,75,100]);

function _drawIREGraticule(sx, x0, y0, plotW, plotH, chColor) {
  sx.font = '6.5px monospace';
  for (const ire of _IRE_MARKS) {
    const y = y0 + plotH - Math.round((ire / 100) * plotH);
    const isKey = _IRE_KEY.has(ire);
    sx.strokeStyle = isKey ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
    sx.lineWidth   = isKey ? 1 : 0.5;
    sx.beginPath(); sx.moveTo(x0, y); sx.lineTo(x0 + plotW, y); sx.stroke();
    if (isKey || ire % 20 === 0) {
      sx.fillStyle   = isKey ? 'rgba(255,255,255,0.50)' : 'rgba(255,255,255,0.22)';
      sx.textAlign   = 'right';
      sx.fillText(String(ire), x0 - 2, y + 3);
    }
  }
  sx.textAlign = 'left';
}

function _drawWaveformTrace(sx, px, iW, iH, x0, y0, plotW, plotH, color) {
  const maxH = Math.max(1, iH / 2);
  for (let cx = 0; cx < plotW; cx++) {
    const srcCol = Math.min(Math.round(cx * iW / plotW), iW - 1);
    const hist = new Uint32Array(256);
    for (let row = 0; row < iH; row += 2) {
      const base = (row * iW + srcCol) * 4;
      const luma = Math.round(0.2126 * px[base] + 0.7152 * px[base+1] + 0.0722 * px[base+2]);
      hist[Math.min(luma, 255)]++;
    }
    for (let v = 0; v < 256; v++) {
      if (!hist[v]) continue;
      const y = y0 + plotH - Math.round((v / 255) * plotH);
      const a = Math.min(0.95, 0.08 + hist[v] / maxH * 0.90);
      sx.fillStyle = color + a.toFixed(2) + ')';
      sx.fillRect(x0 + cx, y, 1, 1);
    }
  }
}

function _drawChannelTrace(sx, px, ch, iW, iH, x0, y0, plotW, plotH, color) {
  const maxH = Math.max(1, iH / 2);
  for (let cx = 0; cx < plotW; cx++) {
    const srcCol = Math.min(Math.round(cx * iW / plotW), iW - 1);
    const hist = new Uint32Array(256);
    for (let row = 0; row < iH; row += 2) {
      const idx = (row * iW + srcCol) * 4 + ch;
      hist[px[idx]]++;
    }
    for (let v = 0; v < 256; v++) {
      if (!hist[v]) continue;
      const y = y0 + plotH - Math.round((v / 255) * plotH);
      const a = Math.min(0.95, 0.08 + hist[v] / maxH * 0.90);
      sx.fillStyle = color + a.toFixed(2) + ')';
      sx.fillRect(x0 + cx, y, 1, 1);
    }
  }
}

// ── Waveform Monitor (broadcast-standard: green phosphor, IRE graticule) ─────
function _drawWaveform(sx, W, H) {
  const px = _activeScopePx, iW = _activeScopeW, iH = _activeScopeH;
  const padL = 22, padR = 4, padT = 6, padB = 10;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  // Illegal-zone tint (above 100 IRE = clipping)
  sx.fillStyle = 'rgba(229,9,20,0.07)';
  sx.fillRect(padL, 0, plotW, padT);
  // 7.5 IRE setup line (NTSC black level reference)
  const y75 = padT + plotH - Math.round(0.075 * plotH);
  sx.strokeStyle = 'rgba(255,180,0,0.18)'; sx.lineWidth = 1;
  sx.setLineDash([2, 3]);
  sx.beginPath(); sx.moveTo(padL, y75); sx.lineTo(W - padR, y75); sx.stroke();
  sx.setLineDash([]);
  sx.fillStyle = 'rgba(255,180,0,0.35)'; sx.font = '5.5px monospace'; sx.textAlign = 'right';
  sx.fillText('7.5', padL - 1, y75 + 3);
  sx.textAlign = 'left';

  _drawIREGraticule(sx, padL, padT, plotW, plotH, null);
  if (iW > 0 && iH > 0) {
    _drawWaveformTrace(sx, px, iW, iH, padL, padT, plotW, plotH, 'rgba(72,230,120,');
  }

  // Title
  sx.fillStyle = 'rgba(255,255,255,0.22)'; sx.font = '6px monospace';
  sx.fillText('WAVEFORM  Y', padL + 2, padT + 8);
}

// ── RGB Parade (3 channels side-by-side, broadcast-standard) ─────────────────
function _drawParade(sx, W, H) {
  const px = _activeScopePx, iW = _activeScopeW, iH = _activeScopeH;
  const padL = 22, padR = 2, padT = 6, padB = 14;
  const gap  = 3;
  const totalW = W - padL - padR;
  const colW   = Math.floor((totalW - gap * 2) / 3);
  const CHANNELS = [
    { label:'R', off:0, color:'rgba(235,65,65,'   },
    { label:'G', off:1, color:'rgba(65,215,90,'   },
    { label:'B', off:2, color:'rgba(65,115,240,'  },
  ];
  const plotH = H - padT - padB;

  CHANNELS.forEach((ch, i) => {
    const x0 = padL + i * (colW + gap);
    // Column background
    sx.fillStyle = 'rgba(255,255,255,0.02)';
    sx.fillRect(x0, padT, colW, plotH);
    // IRE graticule
    _drawIREGraticule(sx, x0, padT, colW, plotH, ch.color);
    // Trace
    if (iW > 0 && iH > 0) _drawChannelTrace(sx, px, ch.off, iW, iH, x0, padT, colW, plotH, ch.color);
    // Channel label at bottom
    sx.font = 'bold 8px monospace';
    sx.fillStyle = ch.color + '0.8)';
    sx.textAlign = 'center';
    sx.fillText(ch.label, x0 + colW / 2, H - 3);
  });
  sx.textAlign = 'left';

  // Scale label top-left
  sx.fillStyle = 'rgba(255,255,255,0.22)'; sx.font = '6px monospace';
  sx.fillText('RGB PARADE', 2, padT + 8);
}

// ── Vectorscope — broadcast-standard (SMPTE/Emerson style) ───────────────────
// • Circular display clipped at 100% saturation ring
// • Hue color-wheel gradient ring around perimeter
// • Concentric saturation rings: 25 / 50 / 75 / 100%
// • Cross-hair + 45° diagonal guides
// • SMPTE 75% box targets + 100% box targets (correct Rec.709 positions)
// • Flesh/skin-tone line (Q-axis, ~123° from Cb)
// • Colored pixel trace clipped to circle
function _drawVector(sx, W, H) {
  const px = _activeScopePx, iW = _activeScopeW, iH = _activeScopeH;
  const margin = 14;  // extra space for labels outside the circle
  const R   = (Math.min(W, H) - margin * 2) / 2;
  const cx  = W / 2, cy = H / 2;
  const TAU = Math.PI * 2;

  // ── 1. Color-wheel gradient ring ─────────────────────────────────────────
  // Draw a thin hue ring just outside the 100% circle.
  // At screen angle θ (0=right, CCW+), Cb = cos θ, Cr = sin θ.
  // Convert to RGB via Rec.709 YCbCr (Y=0.5 reference white).
  const ringSteps = 180;
  const ringInner = R + 2, ringOuter = R + 8;
  for (let i = 0; i < ringSteps; i++) {
    const a0 = (i / ringSteps) * TAU;
    const a1 = ((i + 1) / ringSteps) * TAU;
    const θ  = (a0 + a1) / 2;
    const cbN = Math.cos(θ), crN = Math.sin(θ);  // normalized Cb/Cr unit vector
    // Rec.709 YCbCr→RGB with Y=0.5, full saturation
    const rr = Math.max(0, Math.min(255, Math.round((0.5 + 1.5748 * crN) * 255)));
    const gg = Math.max(0, Math.min(255, Math.round((0.5 - 0.1873 * cbN - 0.4681 * crN) * 255)));
    const bb = Math.max(0, Math.min(255, Math.round((0.5 + 1.8556 * cbN) * 255)));
    sx.strokeStyle = `rgb(${rr},${gg},${bb})`;
    sx.lineWidth   = ringOuter - ringInner;
    sx.beginPath();
    sx.arc(cx, cy, (ringInner + ringOuter) / 2, a0, a1);
    sx.stroke();
  }

  // ── 2. Circular clip for trace and graticule ─────────────────────────────
  sx.save();
  sx.beginPath(); sx.arc(cx, cy, R, 0, TAU); sx.clip();

  // ── 3. Dark circular background ──────────────────────────────────────────
  const bg = sx.createRadialGradient(cx, cy, 0, cx, cy, R);
  bg.addColorStop(0,   'rgba(8,8,18,1)');
  bg.addColorStop(0.7, 'rgba(5,5,14,1)');
  bg.addColorStop(1,   'rgba(2,3,10,1)');
  sx.fillStyle = bg;
  sx.fillRect(cx - R, cy - R, R * 2, R * 2);

  // ── 4. Saturation rings ───────────────────────────────────────────────────
  const RINGS = [ [0.25,'25%'], [0.50,'50%'], [0.75,'75%'], [1.00,'100%'] ];
  for (const [pct, lbl] of RINGS) {
    sx.strokeStyle = pct === 1.0 ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.09)';
    sx.lineWidth   = pct === 1.0 ? 1 : 0.5;
    sx.beginPath(); sx.arc(cx, cy, R * pct, 0, TAU); sx.stroke();
  }

  // ── 5. Cross-hairs and 45° diagonals ─────────────────────────────────────
  sx.strokeStyle = 'rgba(255,255,255,0.15)'; sx.lineWidth = 0.5;
  sx.beginPath(); sx.moveTo(cx - R, cy); sx.lineTo(cx + R, cy); sx.stroke();
  sx.beginPath(); sx.moveTo(cx, cy - R); sx.lineTo(cx, cy + R); sx.stroke();
  const d45 = R * 0.707;
  sx.strokeStyle = 'rgba(255,255,255,0.07)';
  sx.beginPath(); sx.moveTo(cx-d45, cy-d45); sx.lineTo(cx+d45, cy+d45); sx.stroke();
  sx.beginPath(); sx.moveTo(cx+d45, cy-d45); sx.lineTo(cx-d45, cy+d45); sx.stroke();

  // ── 6. Pixel trace (Cb/Cr of each pixel, colored by its own RGB) ─────────
  if (iW > 0 && iH > 0) {
    const step = Math.max(1, Math.floor(iW * iH / 14000));
    const total = iW * iH;
    for (let i = 0; i < total; i += step) {
      const base = i * 4;
      const r = px[base]/255, g = px[base+1]/255, b = px[base+2]/255;
      const cb = -0.1145*r - 0.3854*g + 0.5*b;
      const cr =  0.5*r    - 0.4541*g  - 0.0459*b;
      const px2 = cx + cb * R * 2;
      const py2 = cy - cr * R * 2;
      // clip check against circular boundary (already canvas-clipped, but fast rejection)
      const dx = px2 - cx, dy = py2 - cy;
      if (dx*dx + dy*dy > R*R) continue;
      sx.fillStyle = `rgba(${px[base]},${px[base+1]},${px[base+2]},0.72)`;
      sx.fillRect(px2, py2, 1, 1);
    }
  }

  sx.restore();  // remove circular clip

  // ── 7. SMPTE 75% + 100% box targets (correct Rec.709 positions) ──────────
  // 75% bars: RGB values at 0.75 amplitude for each primary/secondary.
  // BT.709 Cb/Cr (correct for HD/DV content): Cb = -0.1145R - 0.3854G + 0.5B; Cr = 0.5R - 0.4541G - 0.0459B
  const cbCr = (r, g, b) => ({
    cb: -0.1145*r - 0.3854*g + 0.5*b,
    cr:  0.5*r     - 0.4541*g - 0.0459*b,
  });
  const V = 0.75; // 75% amplitude
  const TARGETS = [
    { n:'Yl', ...cbCr(V,V,0), col:'rgba(235,230,55,'  },
    { n:'Cy', ...cbCr(0,V,V), col:'rgba(55,220,215,'  },
    { n:'G',  ...cbCr(0,V,0), col:'rgba(55,215,80,'   },
    { n:'Mg', ...cbCr(V,0,V), col:'rgba(220,55,215,'  },
    { n:'R',  ...cbCr(V,0,0), col:'rgba(235,60,60,'   },
    { n:'B',  ...cbCr(0,0,V), col:'rgba(60,110,240,'  },
  ];

  sx.font = 'bold 7px monospace';
  for (const t of TARGETS) {
    const x75 = cx + t.cb * R * 2;
    const y75 = cy - t.cr * R * 2;
    const x100 = cx + t.cb * R * (2/V);  // 100% amplitude position
    const y100 = cy - t.cr * R * (2/V);
    const bs = 5.5;

    // 100% outline box (dimmer)
    sx.strokeStyle = t.col + '0.35)'; sx.lineWidth = 0.8;
    sx.strokeRect(x100 - bs/2, y100 - bs/2, bs, bs);

    // 75% solid box (bright, standard SMPTE target)
    sx.strokeStyle = t.col + '1)';  sx.lineWidth = 1.5;
    sx.strokeRect(x75 - bs/2, y75 - bs/2, bs, bs);
    // Filled center dot inside 75% box
    sx.fillStyle = t.col + '0.6)';
    sx.fillRect(x75 - 1, y75 - 1, 2, 2);

    // Label — positioned outside the box, away from center
    const angle = Math.atan2(cy - y75, x75 - cx);
    const lx = x75 + Math.cos(angle) * (bs + 4);
    const ly = y75 - Math.sin(angle) * (bs + 4) + 3;
    sx.fillStyle = t.col + '0.85)';
    sx.textAlign = lx < cx ? 'right' : 'left';
    sx.fillText(t.n, lx, ly);
  }
  sx.textAlign = 'left';

  // ── 8. Flesh / skin-tone line (Q-axis, ~123° CCW from Cb axis) ───────────
  // The flesh-tone line passes from center toward the hue angle where human
  // skin tones cluster (approximately between R and Yl on the vectorscope).
  const fleshAngle = 123 * Math.PI / 180;  // 123° from positive Cb (right)
  const fx = cx + Math.cos(fleshAngle) * R;
  const fy = cy - Math.sin(fleshAngle) * R;
  sx.strokeStyle = 'rgba(255,200,120,0.50)'; sx.lineWidth = 1;
  sx.setLineDash([3, 3]);
  sx.beginPath(); sx.moveTo(cx, cy); sx.lineTo(fx, fy); sx.stroke();
  sx.setLineDash([]);
  // Flesh tone label outside the circle
  const fleshLabelX = cx + Math.cos(fleshAngle) * (R + 12);
  const fleshLabelY = cy - Math.sin(fleshAngle) * (R + 12) + 3;
  sx.fillStyle = 'rgba(255,200,120,0.60)'; sx.font = '6px monospace';
  sx.textAlign = 'center';
  sx.fillText('FLESH', fleshLabelX, fleshLabelY);
  sx.textAlign = 'left';

  // ── 9. Saturation ring labels (outside circle) ────────────────────────────
  sx.font = '6px monospace'; sx.fillStyle = 'rgba(255,255,255,0.28)';
  for (const [pct, lbl] of RINGS) {
    sx.fillText(lbl, cx + R * pct + 2, cy + 8);
  }

  // ── 10. Center cross dot + title ──────────────────────────────────────────
  sx.fillStyle = 'rgba(255,255,255,0.55)';
  sx.beginPath(); sx.arc(cx, cy, 2, 0, TAU); sx.fill();
  sx.fillStyle = 'rgba(255,255,255,0.22)'; sx.font = '6px monospace';
  sx.textAlign = 'left';
  sx.fillText('VECTORSCOPE  Rec.709', 3, 10);
}

// ── Audio Meter (PPM-style, derived from frame luminance per channel) ────────
function _drawAudioMeter(sx, W, H) {
  const pad = 8;
  const CH = ['L', 'R', 'Ls', 'Rs', 'C', 'LFE'];
  const nCh = CH.length;
  const barW = Math.floor((W - pad * 2 - (nCh - 1) * 3) / nCh);
  const barX = (i) => pad + i * (barW + 3);

  // Derive pseudo-levels from frame luminance if pixels available
  const levels = CH.map((_, i) => {
    if (!S.framePixels || S.framePixW === 0) return 0;
    const px = S.framePixels; const iW = S.framePixW; const iH = S.framePixH;
    const step = Math.max(1, Math.floor(iW * iH / 400));
    let sum = 0, count = 0;
    const chOff = i % 3; // use R/G/B alternately per channel
    for (let j = 0; j < iW * iH; j += step) {
      sum += px[j * 4 + chOff] / 255;
      count++;
    }
    // Phase-shift each channel slightly so they look independent
    const raw = count > 0 ? sum / count : 0;
    return Math.min(1, raw * (0.9 + 0.25 * Math.sin(i * 1.7 + (S.currentFrame || 0) * 0.05)));
  });

  // IRE / dBFS reference lines
  const DB_MARKS = [0, -6, -12, -18, -24, -40];
  sx.font = `7px monospace`;
  for (const db of DB_MARKS) {
    const rel = Math.min(1, Math.pow(10, db / 20));
    const y   = Math.round(pad + (1 - rel) * (H - pad * 2));
    sx.strokeStyle = db === 0 ? 'rgba(229,9,20,.4)' : 'rgba(255,255,255,.08)';
    sx.lineWidth = 1;
    sx.beginPath(); sx.moveTo(pad, y); sx.lineTo(W - pad, y); sx.stroke();
    sx.fillStyle = 'rgba(255,255,255,.28)';
    sx.fillText(db === 0 ? '0dB' : `${db}`, W - pad + 2, y + 4);
  }

  // Draw each channel bar
  for (let i = 0; i < nCh; i++) {
    const x = barX(i);
    const lv = levels[i];
    const barH = Math.round(lv * (H - pad * 2));
    const y0   = H - pad - barH;

    // Background track
    sx.fillStyle = 'rgba(255,255,255,.04)';
    sx.fillRect(x, pad, barW, H - pad * 2);

    // Color zones: green → amber → red
    const zones = [
      { from: 0,    to: 0.75, color: 'rgba(70,211,105,' },
      { from: 0.75, to: 0.90, color: 'rgba(245,197,24,' },
      { from: 0.90, to: 1.00, color: 'rgba(229,9,20,'   },
    ];
    for (const z of zones) {
      const zFrom = Math.max(lv - (z.to - z.from), 0);
      const lvClamped = Math.max(0, Math.min(lv, z.to) - z.from);
      if (lvClamped <= 0) continue;
      const zh = Math.round(lvClamped * (H - pad * 2));
      const zy = H - pad - Math.round(Math.min(lv, z.to) * (H - pad * 2));
      sx.fillStyle = z.color + '0.85)';
      sx.fillRect(x, zy, barW, zh);
    }

    // Peak hold tick
    if (lv > 0.01) {
      sx.fillStyle = lv >= 0.9 ? 'rgba(229,9,20,.95)' : lv >= 0.75 ? 'rgba(245,197,24,.95)' : 'rgba(120,240,150,.95)';
      sx.fillRect(x, y0 - 2, barW, 2);
    }

    // Channel label
    sx.fillStyle = 'rgba(255,255,255,.45)';
    sx.font = '7px monospace';
    sx.textAlign = 'center';
    sx.fillText(CH[i], x + barW / 2, H - 1);
    sx.textAlign = 'left';
  }

  // "Atmos" badge
  sx.fillStyle = 'rgba(124,106,247,.55)';
  sx.font = '7px system-ui';
  sx.fillText('Atmos / IAB', pad, pad - 2);
}

// ── Helper: rounded rect path ─────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Idle / empty canvas ───────────────────────────────────────────────────────
function drawIdle() {
  const { ctx, canvas } = S;
  if (!ctx || !canvas) return;
  const W = canvas.width, H = canvas.height;

  ctx.fillStyle = '#080810';
  ctx.fillRect(0, 0, W, H);

  // Subtle grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.025)';
  ctx.lineWidth = 1;
  const step = Math.max(40, Math.floor(Math.min(W, H) / 8));
  for (let x = 0; x < W; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Center icon box — scales with canvas size
  const boxW = Math.min(80, W * 0.2);
  const boxH = boxW * 0.65;
  const bx = W / 2 - boxW / 2;
  const by = H / 2 - boxH / 2 - 14;
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1.5;
  roundRect(ctx, bx, by, boxW, boxH, 6);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  roundRect(ctx, bx, by, boxW, boxH, 6);
  ctx.fill();

  const iconSize = Math.max(14, Math.min(22, Math.floor(boxH * 0.55)));
  ctx.font = `bold ${iconSize}px monospace`;
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  ctx.textAlign = 'center';
  ctx.fillText('▶', W / 2, by + boxH / 2 + iconSize * 0.38);

  ctx.font = '10px monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillText('Click a reel to load', W / 2, by + boxH + 20);
  ctx.textAlign = 'left';
}


function _decoderPoolInfo() {
  try {
    return _getDecoderPoolInfo ? (_getDecoderPoolInfo() || { configured: 1, ready: 0, hardware: 0 }) : { configured: 1, ready: 0, hardware: 0 };
  } catch (_) {
    return { configured: 1, ready: 0, hardware: 0 };
  }
}

function _decoderLaneCount() {
  const info = _decoderPoolInfo();
  return Math.max(1, Number(info.ready || info.configured || 1) || 1);
}

function _freeDecodeLaneBudget() {
  return Math.max(0, _decoderLaneCount() - (S.decodePrefetchInflight.size || 0) - (S.decodeBusy ? 1 : 0));
}

function _effectiveDecodedCacheLimit() {
  const mode = _getEffectivePlaybackMode();
  const lanes = _decoderLaneCount();
  if (!S.totalFrames) return Math.max(12, 8 + lanes * 4);
  if (!S.isPlaying) return Math.max(18, 12 + lanes * 4);
  if (mode === 'quality') return Math.max(24, 12 + lanes * 6);
  if (S.previewScale <= 0.25) return Math.max(40, 16 + lanes * 10);
  if (S.previewScale < 1) return Math.max(32, 14 + lanes * 8);
  return Math.max(28, 12 + lanes * 7);
}

function _anyDecodeInflight(frame) {
  return S.inflightFrame === frame || S.decodePrefetchInflight.has(frame);
}

function _evictFrameCache() {
  S.cacheLimit = _effectiveDecodedCacheLimit();
  while (S.decodedCache.size > S.cacheLimit) {
    const oldestKey = S.decodedCache.keys().next().value;
    const oldest = S.decodedCache.get(oldestKey);
    if (oldest?.bitmap && typeof oldest.bitmap.close === 'function') {
      try { oldest.bitmap.close(); } catch {}
    }
    S.decodedCache.delete(oldestKey);
  }
}

function _cacheDecodedFrame(frame, imageData, surface, bitmap, pixels, pixW, pixH) {
  if (frame == null || !imageData) return;
  const prev = S.decodedCache.get(frame);
  if (prev?.bitmap && prev.bitmap !== bitmap && typeof prev.bitmap.close === 'function') {
    try { prev.bitmap.close(); } catch {}
  }
  S.decodedCache.delete(frame);
  S.decodedCache.set(frame, {
    imageData,
    surface,
    bitmap: bitmap || null,
    pixels: pixels || null,
    pixW: pixW || 0,
    pixH: pixH || 0,
  });
  _evictFrameCache();
}

function _restoreCachedFrame(frame) {
  const cached = S.decodedCache.get(frame);
  if (!cached) return false;
  S.decodedCache.delete(frame);
  S.decodedCache.set(frame, cached);
  S.frameImageData = cached.imageData || null;
  S.frameSurface = cached.surface || null;
  S.frameBitmap = cached.bitmap || null;
  S.framePixels = cached.pixels || null;
  S.framePixW = cached.pixW || 0;
  S.framePixH = cached.pixH || 0;
  S.displayFrame = frame;
  return true;
}

function _restoreNearestCachedFrame(frame, radius = 6) {
  for (let d = 1; d <= radius; d++) {
    const fwd = frame + d;
    if (_restoreCachedFrame(fwd)) return true;
    const back = frame - d;
    if (_restoreCachedFrame(back)) return true;
  }
  return false;
}

function _clearFrameCache() {
  for (const cached of S.decodedCache.values()) {
    if (cached?.bitmap && typeof cached.bitmap.close === 'function') {
      try { cached.bitmap.close(); } catch {}
    }
  }
  S.decodedCache.clear();
}

function _evictFrameByteCache() {
  S.frameByteCacheLimit = _effectiveFrameByteCacheLimit();
  let skipped = 0;
  while (S.frameByteCache.size > S.frameByteCacheLimit) {
    const oldestKey = S.frameByteCache.keys().next().value;
    if (oldestKey === S.currentFrame || oldestKey === S.displayFrame || oldestKey === S.inflightFrame) {
      const v = S.frameByteCache.get(oldestKey);
      S.frameByteCache.delete(oldestKey);
      S.frameByteCache.set(oldestKey, v);
      if (++skipped >= S.frameByteCache.size) break; // all remaining entries are protected
      continue;
    }
    skipped = 0;
    S.frameByteCache.delete(oldestKey);
  }
}

function _cacheFrameBytes(frame, bytes) {
  if (frame == null || !bytes) return;
  S.frameByteCache.delete(frame);
  S.frameByteCache.set(frame, bytes);
  _evictFrameByteCache();
}

function _getCachedFrameBytes(frame) {
  const cached = S.frameByteCache.get(frame);
  if (!cached) return null;
  S.frameByteCache.delete(frame);
  S.frameByteCache.set(frame, cached);
  return cached;
}

function _clearFrameByteCache() {
  S.frameByteCache.clear();
  S.frameByteReads.clear();
  S.prefetchQueue.length = 0;
  S.prefetchQueued.clear();
  S.prefetchInflight = 0;
  S.decodePrefetchQueue.length = 0;
  S.decodePrefetchQueued.clear();
  S.decodePrefetchInflight.clear();
}

async function _readFrameBytesCached(frame) {
  const cached = _getCachedFrameBytes(frame);
  if (cached) return cached;
  const inflight = S.frameByteReads.get(frame);
  if (inflight) return inflight;
  // Apply CPL entryPoint offset: the MXF frame index starts at entryPoint for this reel.
  // frame is reel-local (0-based); mxfFrame is the absolute edit unit within the MXF body.
  const mxfFrame = (S.entryPoint || 0) + frame;
  const p = readMXFFrame(S.mxfFile, S.mxfIndex, mxfFrame).then(bytes => {
    S.frameByteReads.delete(frame);
    if (bytes && bytes.length) _cacheFrameBytes(frame, bytes);
    return bytes;
  }).catch(err => {
    S.frameByteReads.delete(frame);
    throw err;
  });
  S.frameByteReads.set(frame, p);
  return p;
}

function _scheduleFrameBytePrefetch(frames, seq) {
  _enqueueFrameBytePrefetch(frames, seq);
}

function _prefetchAroundFrame(anchorFrame, seq) {
  if (!S.totalFrames || seq !== S.loadSeq) return;
  const stride = Math.max(1, S.playbackStride || 1);
  const frames = [];
  const decodeFrames = [];
  const mode = _getEffectivePlaybackMode();
  const lanes = _decoderLaneCount();
  if (S.isPlaying) {
    if (mode === 'quality') {
      const depth = Math.max(6, Math.min(12, 4 + lanes * 2));
      for (let i = 1; i <= depth; i++) frames.push(anchorFrame + i, anchorFrame - Math.min(i, 3));
      for (let i = 1; i <= Math.min(4, lanes + 1); i++) decodeFrames.push(anchorFrame + i);
    } else {
      const depth = S.previewScale <= 0.25 ? Math.max(8, 4 + lanes * 2) : (S.previewScale < 1 ? Math.max(7, 4 + lanes * 2) : Math.max(6, 3 + lanes * 2));
      for (let i = 1; i <= depth; i++) frames.push(_quantizeFrame(anchorFrame + i * stride, stride));
      for (let i = 1; i <= Math.min(3, depth); i++) frames.push(_quantizeFrame(anchorFrame + i, 1));
      frames.push(_quantizeFrame(anchorFrame + Math.max(1, stride >> 1), 1));
      for (let i = 1; i <= Math.min(3, lanes); i++) {
        decodeFrames.push(_quantizeFrame(anchorFrame + Math.max(1, stride * i), stride));
      }
      decodeFrames.push(_quantizeFrame(anchorFrame + Math.max(1, stride >> 1), 1));
    }
  } else {
    const depth = Math.max(4, 2 + lanes);
    for (let i = 1; i <= depth; i++) frames.push(anchorFrame + i, anchorFrame - i);
    decodeFrames.push(anchorFrame + 1, anchorFrame - 1, anchorFrame + 2);
  }
  _scheduleFrameBytePrefetch(frames, seq);
  _enqueueDecodePrefetch(decodeFrames, seq);
}

function _ensureRenderWorker() {
  if (S.renderWorker) return S.renderWorker;
  try {
    const workerUrl = new URL('./imf_render_worker.js?v=2026-04-07-v52', import.meta.url);
    const w = new Worker(workerUrl, { type: 'module' });
    w.onmessage = (event) => {
      const data = event.data || {};
      const pending = S.renderPending.get(data.id);
      if (!pending) return;
      S.renderPending.delete(data.id);
      try { clearTimeout(pending.timer); } catch {}
      if (!data.ok) {
        pending.reject(new Error(data.error || 'render worker failed'));
        return;
      }
      pending.resolve(data);
    };
    w.onerror = (event) => {
      console.warn('[IMF] render worker error', event?.message || event);
      for (const [id, pending] of S.renderPending.entries()) {
        pending.reject(new Error('render worker error'));
      }
      S.renderPending.clear();
      S.renderWorkerReady = false;
    };
    S.renderWorker = w;
    S.renderWorkerReady = true;
    console.log('[IMF] render worker ready (OffscreenCanvas)');
    return w;
  } catch (e) {
    console.warn('[IMF] render worker unavailable, using main thread', e);
    S.renderWorkerReady = false;
    return null;
  }
}

async function _renderDecodedFrame(decoded, scale, opts = {}) {
  const worker = _ensureRenderWorker();
  if (!worker) {
    const imageData = _frameToImageData ? _frameToImageData(decoded, scale, { transfer: S.transfer || '–', primaries: S.primaries || '–', previewHdr: S.previewHdr }) : null;
    return { imageData, bitmap: null, scopePixels: null, scopeW: 0, scopeH: 0, mode: 'main' };
  }
  const id = S.renderReqId++;
  const pixelsView = decoded.pixels;
  const copy = new Uint8Array(pixelsView.byteLength);
  copy.set(new Uint8Array(pixelsView.buffer, pixelsView.byteOffset, pixelsView.byteLength));
  const payload = {
    id,
    width: decoded.width,
    height: decoded.height,
    componentCount: decoded.componentCount,
    bitsPerSample: decoded.bitsPerSample,
    isSigned: !!decoded.isSigned,
    sampleLayout: decoded.sampleLayout || 'interleaved',
    scale,
    needScope: opts.needScope !== false,
    transfer: S.transfer || '–',
    primaries: S.primaries || '–',
    tonemapMode: S.previewMode || 'sdr',
    srcPeakNits: S.srcPeakNits,
    activeL1MaxNits: _getActiveL1NitsForFrame(),
    dvTrim: S.previewMode === 'trim' ? _activeTrimForFrame() : null,
    pixelsType: (decoded.bitsPerSample > 8 ? (decoded.isSigned ? 'i16' : 'u16') : 'u8'),
    pixelsBuffer: copy.buffer,
  };
  const p = new Promise((resolve, reject) => {
    // Store the timer ID in the pending entry so the worker response handler can
    // clear it immediately — without this, every completed render leaves a 20-second
    // dangling timer (no-op when it fires, but stacks hundreds during sustained playback).
    const timer = setTimeout(() => {
      const pending = S.renderPending.get(id);
      if (!pending) return;
      S.renderPending.delete(id);
      reject(new Error('render worker timeout'));
    }, 20000);
    S.renderPending.set(id, { resolve, reject, timer });
  });
  worker.postMessage(payload, [copy.buffer]);
  const res = await p;
  if (res.frameMaxNits > 0) S.frameMaxNits = res.frameMaxNits;
  return {
    imageData: res.imageBuffer ? new ImageData(new Uint8ClampedArray(res.imageBuffer), res.imageWidth, res.imageHeight) : null,
    bitmap: res.bitmap || null,
    scopePixels: res.scopeBuffer ? new Uint8ClampedArray(res.scopeBuffer) : null,
    scopeW: res.scopeW || 0,
    scopeH: res.scopeH || 0,
    mode: res.mode || 'worker',
  };
}

function _previewLabel() {
  if (S.previewScale <= 0.25) return '1/4';
  if (S.previewScale < 1) return '1/2';
  return 'FULL';
}

function _nextPreviewScaleDown(scale) {
  if (scale >= 1) return 0.5;
  if (scale > 0.25) return 0.25;
  return 0.25;
}

function _nextPreviewScaleUp(scale) {
  if (scale <= 0.25) return 0.5;
  if (scale < 1) return 1;
  return 1;
}

function _setPreviewScale(scale, reason = '') {
  const next = scale <= 0.25 ? 0.25 : (scale < 1 ? 0.5 : 1);
  if (next === S.previewScale) return false;
  S.previewScale = next;
  S.lastAdaptiveTs = performance.now();
  S.scaleRecoveryScore = 0;
  _clearFrameCache();
  updatePlaybackButtons();
  updateTopbar();
  console.log(`[IMF] preview scale -> ${_previewLabel()}${reason ? ` (${reason})` : ''}`);
  return true;
}

// Predict the decode resolution to START playback at, so heavy media plays
// smoothly from the first frame instead of stuttering at full-res for ~0.7s
// until the reactive controller drops it. CPU J2K decode cost ∝ pixel count, and
// full-res already misses 23.976 above ~HD (C-RT0 audit: HD full = 20.7 fps),
// so pick a level from the frame dimensions. Quality (HQ) mode never reduces.
function _predictInitialPlaybackScale() {
  if (S.playbackMode === 'quality') return 1;
  const m = /(\d{3,5})\s*[x×]\s*(\d{3,5})/.exec(String(S.resolution || ''));
  const px = m ? parseInt(m[1], 10) * parseInt(m[2], 10) : 0;
  if (px) {
    if (px >= 3200 * 1700) return 0.25;   // ~UHD/4K+ → quarter
    if (px >= 1700 * 900)  return 0.5;    // ~HD/2K   → half (full-res < real-time)
    return 1;                              // SD/small → full is fine
  }
  // Dims unknown — fall back to a prior decode-time sample if we have one.
  const avg = S.decodeAvgMs || 0, fi = S.frameInterval || 41.67;
  if (avg > fi * 2) return 0.25;
  if (avg > fi)     return 0.5;
  return 1;
}

function _maybeAdaptPreviewScale() {
  if (!S.isPlaying || S.playbackMode === 'quality') return false;
  const now = performance.now();
  const fi = Math.max(1, S.frameInterval || 41.67);
  const avg = Math.max(0, S.decodeAvgMs || 0);
  const stressed = avg > fi * 1.1 || S.lastFrameAdvance > 1 || S.droppedFrames > 0;

  // React faster when severely behind (>2× the frame budget) so a bad guess or a
  // resolution jump doesn't stutter for a full 700ms before dropping a level.
  const downCooldown = (avg > fi * 2) ? 300 : 700;
  if (stressed && now - S.lastAdaptiveTs > downCooldown) {
    return _setPreviewScale(_nextPreviewScaleDown(S.previewScale), `adaptive down ${Math.round(avg)}ms`);
  }

  if (S.playbackMode !== 'auto' || S.previewScale >= 1) return false;
  if (now - S.lastAdaptiveTs < 2200) return false;
  if (avg > 0 && avg < fi * 0.55 && S.lastFrameAdvance <= 1 && S.droppedFrames === 0) {
    S.scaleRecoveryScore += 1;
    if (S.scaleRecoveryScore >= 18) {
      return _setPreviewScale(_nextPreviewScaleUp(S.previewScale), `adaptive up ${Math.round(avg)}ms`);
    }
  } else {
    S.scaleRecoveryScore = 0;
  }
  return false;
}

function _playbackModeLabel() {
  if (S.playbackMode === 'realtime') return 'RT';
  if (S.playbackMode === 'quality') return 'HQ';
  return 'AUTO';
}

function _cyclePlaybackMode() {
  if (S.playbackMode === 'auto') S.playbackMode = 'realtime';
  else if (S.playbackMode === 'realtime') S.playbackMode = 'quality';
  else S.playbackMode = 'auto';
  S.playbackStride = _getPlaybackStride();
  updatePlaybackButtons();
  updateTopbar();
  if (S.totalFrames) drawFrame();
}

function _getEffectivePlaybackMode() {
  if (!S.isPlaying) return 'quality';
  if (S.playbackMode === 'realtime') return 'realtime';
  if (S.playbackMode === 'quality') return 'quality';
  const avg = Math.max(0, S.decodeAvgMs || 0);
  const fi = Math.max(1, S.frameInterval || 41.67);
  return (S.previewScale < 1 || avg > fi * 0.95) ? 'realtime' : 'quality';
}

function _effectiveFrameByteCacheLimit() {
  const mode = _getEffectivePlaybackMode();
  const lanes = _decoderLaneCount();
  if (mode === 'quality') return Math.max(40, 24 + lanes * 8);
  if (S.previewScale <= 0.25) return Math.max(28, 16 + lanes * 8);
  if (S.previewScale < 1) return Math.max(32, 18 + lanes * 8);
  return Math.max(32, 20 + lanes * 8);
}

function _effectivePrefetchMax() {
  const mode = _getEffectivePlaybackMode();
  const lanes = _decoderLaneCount();
  if (mode === 'quality') return Math.max(2, Math.min(6, lanes + 1));
  if (S.previewScale <= 0.25) return Math.max(4, Math.min(8, lanes * 2));
  if (S.previewScale < 1) return Math.max(4, Math.min(7, lanes * 2));
  return Math.max(3, Math.min(6, lanes + 2));
}

function _effectiveDecodePrefetchDepth() {
  const mode = _getEffectivePlaybackMode();
  const lanes = _decoderLaneCount();
  if (!S.isPlaying) return Math.max(2, Math.min(6, lanes + 1));
  if (mode === 'quality') return Math.max(3, Math.min(8, lanes * 2));
  if (S.previewScale <= 0.25) return Math.max(4, Math.min(10, lanes * 3));
  if (S.previewScale < 1) return Math.max(4, Math.min(8, lanes * 2 + 1));
  return Math.max(3, Math.min(7, lanes * 2));
}

function _enqueueFrameBytePrefetch(frames, seq) {
  if (!S.mxfFile || !S.mxfIndex || seq !== S.loadSeq) return;
  const total = Math.max(0, S.totalFrames || 0);
  for (const raw of frames) {
    const frame = raw | 0;
    if (frame < 0 || frame >= total) continue;
    if (S.frameByteCache.has(frame) || S.frameByteReads.has(frame) || S.decodedCache.has(frame) || _anyDecodeInflight(frame)) continue;
    if (S.prefetchQueued.has(frame)) continue;
    S.prefetchQueued.add(frame);
    S.prefetchQueue.push(frame);
  }
  _drainFrameBytePrefetch(seq);
}

function _drainFrameBytePrefetch(seq) {
  if (!S.mxfFile || !S.mxfIndex || seq !== S.loadSeq) return;
  S.prefetchMax = _effectivePrefetchMax();
  while (S.prefetchInflight < S.prefetchMax && S.prefetchQueue.length) {
    const frame = S.prefetchQueue.shift();
    S.prefetchQueued.delete(frame);
    if (frame == null || frame < 0 || frame >= S.totalFrames) continue;
    if (S.frameByteCache.has(frame) || S.frameByteReads.has(frame) || S.decodedCache.has(frame) || _anyDecodeInflight(frame)) continue;
    S.prefetchInflight++;
    _readFrameBytesCached(frame).catch(() => null).finally(() => {
      // Only touch the counter for the CURRENT reel. A reel change resets
      // prefetchInflight to 0 (_clearFrameByteCache); a late read from the old
      // reel must not decrement the new reel's count and starve its prefetch.
      if (seq !== S.loadSeq) return;
      S.prefetchInflight = Math.max(0, S.prefetchInflight - 1);
      _drainFrameBytePrefetch(seq);
    });
  }
}

function _enqueueDecodePrefetch(frames, seq) {
  if (!S.mxfFile || !S.mxfIndex || seq !== S.loadSeq) return;
  for (const raw of frames) {
    const frame = raw | 0;
    if (frame < 0 || frame >= S.totalFrames) continue;
    if (frame === S.currentFrame || frame === S.displayFrame || frame === S.inflightFrame) continue;
    if (S.decodedCache.has(frame) || S.decodePrefetchQueued.has(frame)) continue;
    S.decodePrefetchQueued.add(frame);
    S.decodePrefetchQueue.push(frame);
  }
  _drainDecodePrefetch(seq);
}

function _effectiveBackgroundDecodeMax() {
  const mode = _getEffectivePlaybackMode();
  const lanes = _decoderLaneCount();
  if (!S.isPlaying) return Math.max(1, Math.min(3, lanes - 1));
  if (mode === 'quality') return Math.max(1, Math.min(3, lanes - 1));
  if (S.previewScale <= 0.25) return Math.max(1, Math.min(4, lanes));
  if (S.previewScale < 1) return Math.max(1, Math.min(3, lanes));
  return Math.max(1, Math.min(2, lanes - 1));
}

function _drainDecodePrefetch(seq) {
  if (!S.mxfFile || !S.mxfIndex || seq !== S.loadSeq) return;
  const depth = _effectiveDecodePrefetchDepth();
  const maxBg = _effectiveBackgroundDecodeMax();
  while (S.decodePrefetchQueue.length > depth) {
    const dropped = S.decodePrefetchQueue.pop();
    S.decodePrefetchQueued.delete(dropped);
  }
  while (S.decodePrefetchInflight.size < maxBg && S.decodePrefetchQueue.length) {
    const frame = S.decodePrefetchQueue.shift();
    S.decodePrefetchQueued.delete(frame);
    if (frame == null) break;
    if (frame === S.currentFrame || frame === S.displayFrame || S.decodedCache.has(frame) || S.inflightFrame === frame || S.decodePrefetchInflight.has(frame)) {
      continue;
    }
    S.decodePrefetchInflight.add(frame);
    _loadFrameBytes(frame, seq, { prefetch: true, present: false }).finally(() => {
      S.decodePrefetchInflight.delete(frame);
      if (seq === S.loadSeq) _drainDecodePrefetch(seq);
    });
  }
}

function updatePlaybackButtons() {
  const btnHalf = document.getElementById('imfBtnHalf');
  const btnPerf = document.getElementById('imfBtnPerf');
  // These buttons only affect direct MXF decode.
  // In companion-only mode (no local file), grey them out so the user knows why.
  const hasDirectFile = !!(S.mxfFile);
  if (btnHalf) {
    btnHalf.classList.toggle('imf-tbtn-mode-active', S.previewScale < 1 && hasDirectFile);
    btnHalf.classList.toggle('imf-tbtn-mode-dim', !hasDirectFile);
    btnHalf.textContent = _previewLabel();
    btnHalf.title = hasDirectFile
      ? 'Toggle decode resolution: FULL / 1∕2 / 1∕4'
      : 'Scale toggle — requires direct MXF file access (use Relink)';
  }
  if (btnPerf) {
    btnPerf.textContent = _playbackModeLabel();
    btnPerf.classList.toggle('imf-tbtn-mode-active', S.playbackMode !== 'auto' && hasDirectFile);
    btnPerf.classList.toggle('imf-tbtn-mode-dim', !hasDirectFile);
    btnPerf.title = !hasDirectFile
      ? 'Playback mode — requires direct MXF file access (use Relink)'
      : S.playbackMode === 'quality'
        ? 'Playback mode: Quality — prioritize every frame'
        : (S.playbackMode === 'realtime'
          ? 'Playback mode: Realtime — prioritize smooth playback'
          : 'Playback mode: Auto — switch between quality and realtime');
  }
}

function _useRealtimePreviewMode() {
  return _getEffectivePlaybackMode() === 'realtime';
}

function _getRealtimeStepFrames() {
  if (_getEffectivePlaybackMode() !== 'realtime') return 1;
  const avg = Math.max(0, S.decodeAvgMs || 0);
  const fi = Math.max(1, S.frameInterval || 41.67);
  let step = Math.max(1, Math.ceil((avg || fi) / fi));
  if (S.previewScale <= 0.25) step = Math.max(step, 8);
  else if (S.previewScale < 1) step = Math.max(step, 4);
  return Math.max(1, Math.min(48, step));
}

function _getPlaybackStride() {
  if (!S.isPlaying) return 1;
  if (_getEffectivePlaybackMode() !== 'realtime') return 1;
  const avg = Math.max(0, S.decodeAvgMs || 0);
  const fi = Math.max(1, S.frameInterval || 41.67);
  const ratio = avg > 0 ? (avg / fi) : 1;
  const previewBoost = S.previewScale <= 0.25 ? 2.5 : (S.previewScale < 1 ? 2.0 : 1.5);
  const raw = Math.ceil(Math.max(1, ratio * previewBoost));
  return Math.max(1, Math.min(24, raw));
}

function _quantizeFrame(frame, stride) {
  const total = Math.max(1, S.totalFrames || 1);
  const clamped = Math.max(0, Math.min(frame, total - 1));
  if (stride <= 1) return clamped;
  return Math.max(0, Math.min(total - 1, Math.floor(clamped / stride) * stride));
}

function _restoreNearbyCachedFrame(frame, maxDistance) {
  if (!S.decodedCache.size) return false;
  const maxD = Math.max(0, maxDistance | 0);
  for (let d = 1; d <= maxD; d++) {
    const back = frame - d;
    if (back >= 0 && _restoreCachedFrame(back)) return true;
    const fwd = frame + d;
    if (fwd < S.totalFrames && _restoreCachedFrame(fwd)) return true;
  }
  return false;
}

function _restoreLatestCachedAtOrBefore(frame, maxDistance) {
  if (!S.decodedCache.size) return false;
  const maxD = Math.max(0, maxDistance | 0);
  for (let d = 0; d <= maxD; d++) {
    const back = frame - d;
    if (back < 0) break;
    if (_restoreCachedFrame(back)) return true;
  }
  return false;
}


function _restoreAnyUsefulCachedFrame(frame) {
  if (!S.decodedCache.size) return false;
  if (_restoreCachedFrame(frame)) return true;
  if (_restoreLatestCachedAtOrBefore(frame, Math.min(120, Math.max(12, S.playbackStride * 10)))) return true;
  if (_restoreNearbyCachedFrame(frame, Math.min(72, Math.max(8, S.playbackStride * 8)))) return true;
  const newestKey = Array.from(S.decodedCache.keys()).pop();
  if (newestKey != null) return _restoreCachedFrame(newestKey);
  return false;
}

function _tryUrgentParallelDecode(frame, seq) {
  if (!S.isPlaying || frame == null || seq !== S.loadSeq) return false;
  if (S.decodedCache.has(frame) || _anyDecodeInflight(frame)) return false;
  if (_freeDecodeLaneBudget() <= 0) return false;
  S.decodePrefetchInflight.add(frame);
  // Important: urgent parallel decode must be allowed to present when it wins.
  // Otherwise transport can keep running at realtime while the viewer shows only
  // the timecode placeholder even though a real decoded frame becomes available.
  _loadFrameBytes(frame, seq, { prefetch: true, present: true, urgent: true }).finally(() => {
    S.decodePrefetchInflight.delete(frame);
  });
  return true;
}

function _clockTargetFrame(ts, step = 1) {
  const total = Math.max(1, S.totalFrames || 1);
  const elapsedFrames = Math.max(0, Math.floor((ts - S.playBaseTs) / S.frameInterval));
  const raw = (S.playBaseFrame + elapsedFrames) % total;
  return _quantizeFrame(raw, Math.max(1, step | 0));
}

// ── Playback loop ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════
// Realtime playback via the persistent IMF stream engine (imf_direct_engine).
// On Play we route through ONE long-lived ffmpeg that streams JPEG frames over
// a local MJPEG endpoint (with -lowres for cadence) into an <img> overlay —
// instead of spawning ffmpeg per displayed frame (the "eCache" path that can't
// hit realtime). Pause/scrub tear the stream down and return to crisp,
// frame-accurate per-frame decode. Fully additive: any failure returns false
// and the caller falls back to the per-frame playLoop (no regression).
// ════════════════════════════════════════════════════════════════════════
function _streamQuality() {
  // Map the FULL/HALF/QUARTER preview toggle to the engine's -lowres ladder.
  try {
    const t = (document.getElementById('imfBtnHalf')?.textContent || '').toUpperCase();
    if (t.includes('QUARTER')) return 'quarter';
    if (t.includes('HALF'))    return 'half';
    if (t.includes('FULL'))    return 'full';
  } catch {}
  return 'auto';
}

// If the realtime MJPEG stream hasn't painted a new frame within this window while
// the clock is running, treat it as stalled and fall back to per-frame playback.
const _STREAM_STALL_MS = 1500;

function _ensureStreamImg() {
  if (S.streamImgEl && document.body.contains(S.streamImgEl)) return S.streamImgEl;
  let img = document.getElementById('imfStreamImg');
  if (!img) {
    const stage = document.getElementById('imfViewerStage');
    if (!stage) return null;
    img = document.createElement('img');
    img.id = 'imfStreamImg';
    img.className = 'imf-stream-img';
    img.alt = '';
    stage.appendChild(img);
  }
  S.streamImgEl = img;
  if (!img._pfxStallWired) {
    img._pfxStallWired = true;
    // multipart/x-mixed-replace fires a 'load' per received part in Chromium — this
    // is our frame-arrival heartbeat that the stall watchdog checks against.
    img.addEventListener('load', () => {
      S.streamFramesSeen = (S.streamFramesSeen || 0) + 1;
      S.streamLastFrameTs = performance.now();
    });
    // A hard stream error (server gone, decoder died) — bail immediately.
    // Guarded by streamSessionId so tearing the src down in _stopRealtimeStream
    // (which nulls the session first) can't trigger a spurious fallback.
    img.addEventListener('error', () => {
      if (S.streamMode && S.streamSessionId) _fallbackToPerFrame('stream <img> error');
    });
  }
  return img;
}

async function _startRealtimeStream() {
  if (S.streamStallFallback) return false;   // this media already fell back to per-frame
  const eng = (typeof window !== 'undefined') && window.pfxPlatform && window.pfxPlatform.imfEngine;
  if (!eng || typeof eng.startPlayback !== 'function' || typeof eng.openPackage !== 'function') return false;
  if (!S.cplPath) return false;          // need the IMF-demux (CPL) path
  if (S.proxyMode) return false;         // proxy playback owns the <video>
  if (S.streamMode) return true;
  const img = _ensureStreamImg();
  if (!img) return false;
  try {
    if (!S.streamPackageId || S.streamPackageCplPath !== S.cplPath) {
      const op = await eng.openPackage(S.cplPath);
      if (!op || !op.ok || !op.packageId) return false;
      S.streamPackageId      = op.packageId;
      S.streamPackageCplPath = S.cplPath;
    }
    if (!S.isPlaying) return false;      // user paused while opening
    const startFrame = (S.displayFrame ?? S.currentFrame ?? 0) | 0;
    const r = await eng.startPlayback(S.streamPackageId, S.cplId || '', {
      startFrame, quality: _streamQuality()
    });
    if (!r || !r.ok || !r.streamUrl) return false;
    if (!S.isPlaying) { try { eng.stopPlayback(r.sessionId); } catch {} return false; }
    S.streamSessionId  = r.sessionId;
    S.streamStartFrame = startFrame;
    S.streamStartTs    = performance.now();
    S.streamLastFrameTs = performance.now();   // stall-watchdog heartbeat baseline
    S.streamFramesSeen  = 0;
    const canvas = document.getElementById('imfCanvas');
    if (canvas) canvas.style.visibility = 'hidden';
    img.style.display = 'block';
    img.src = r.streamUrl;
    S.streamMode = true;
    if (S.streamClockRaf) cancelAnimationFrame(S.streamClockRaf);
    S.streamClockRaf = requestAnimationFrame(_streamClockTick);
    try { _emitPlayerState(); } catch {}
    return true;
  } catch (e) {
    console.warn('[IMF] realtime stream unavailable, using per-frame play:', (e && e.message) || e);
    try { _stopRealtimeStream(); } catch {}
    return false;
  }
}

function _stopRealtimeStream() {
  if (S.streamClockRaf) { cancelAnimationFrame(S.streamClockRaf); S.streamClockRaf = 0; }
  const eng = (typeof window !== 'undefined') && window.pfxPlatform && window.pfxPlatform.imfEngine;
  if (S.streamSessionId && eng && typeof eng.stopPlayback === 'function') {
    try { eng.stopPlayback(S.streamSessionId); } catch {}
  }
  S.streamSessionId = null;
  if (S.streamImgEl) { try { S.streamImgEl.src = ''; S.streamImgEl.style.display = 'none'; } catch {} }
  const canvas = document.getElementById('imfCanvas');
  if (canvas) canvas.style.visibility = '';
  S.streamMode = false;
}

// The realtime MJPEG stream started but isn't delivering frames (e.g. the bundled
// ffmpeg lacks the IMF demuxer, or the decoder stalled under backpressure). The
// wall-clock TC in _streamClockTick would keep advancing while the <img> stays
// frozen. Bail to the per-frame decode loop, which draws every frame it advances
// so the picture can never desync from the timecode.
function _fallbackToPerFrame(reason) {
  console.warn('[IMF] realtime stream stalled (' + reason + ') — falling back to per-frame playback');
  _stopRealtimeStream();
  S.streamStallFallback = true;   // don't retry the stream for this media
  if (!S.isPlaying) return;
  try { _setPreviewScale(_predictInitialPlaybackScale(), 'stream-fallback'); } catch {}
  S.lastTs          = performance.now();
  S.playBaseTs      = S.lastTs;
  S.playBaseFrame   = (S.displayFrame ?? S.currentFrame);
  S.currentFrame    = (S.displayFrame ?? S.currentFrame);
  S.droppedFrames   = 0;
  S.lastFrameAdvance = 0;
  S.scaleRecoveryScore = 0;
  if (S.raf) cancelAnimationFrame(S.raf);
  S.raf = requestAnimationFrame(playLoop);
}

// Clock-driven TC/scrubber update while the MJPEG stream paints the <img>.
// The engine advances frames on its own ffmpeg clock; we estimate the playhead
// from wall-clock for the timecode + scrubber (monitor-accurate, not the
// authority for decode). Honors loop + multi-reel auto-advance like playLoop.
function _streamClockTick() {
  if (!S.streamMode || !S.isPlaying) return;
  // Stall watchdog: if the <img> hasn't painted a new frame within the window, the
  // stream is dead — fall back to per-frame so the picture can't freeze while this
  // clock keeps advancing the timecode.
  if (performance.now() - (S.streamLastFrameTs || 0) > _STREAM_STALL_MS) {
    _fallbackToPerFrame('no frame within ' + _STREAM_STALL_MS + 'ms');
    return;
  }
  const fps = S.fps || (S.frameInterval ? 1000 / S.frameInterval : 24) || 24;
  // Prefer the audio clock for the displayed playhead/TC when PCM audio is
  // actively playing (presentation-accurate, matches the per-frame A/V lock).
  // Falls back to the wall-clock estimate when audio is absent — no regression.
  let f;
  const audFrame = _avLockActive() ? _audCurrentFrame() : null;
  if (audFrame != null && Number.isFinite(audFrame)) {
    f = audFrame;
    S.avOffsetMs = 0;   // audio is the reference on this path
  } else {
    const elapsed = (performance.now() - S.streamStartTs) / 1000;
    f = S.streamStartFrame + Math.floor(elapsed * fps);
  }
  if (S.totalFrames && f >= S.totalFrames - 1) {
    const seqBefore = S.loadSeq;
    S.currentFrame = S.totalFrames - 1;
    document.dispatchEvent(new CustomEvent('imf:reel-end', {
      detail: { tcOffset: S.tcOffset, totalFrames: S.totalFrames }
    }));
    if (S.loadSeq !== seqBefore) return;   // next reel loaded — bow out
    if (S.loop) {                          // loop this reel
      _stopRealtimeStream();
      S.currentFrame = 0; S.displayFrame = 0;
      _startRealtimeStream();
      return;
    }
    S.isPlaying = false;                   // last reel — stop at final frame
    _stopRealtimeStream();
    const btn = document.getElementById('imfBtnPlay'); if (btn) btn.textContent = '▶';
    syncSeek();
    drawFrame();
    _refineCurrentFrameFullRes();
    try { _emitPlayerState(); } catch {}
    return;
  }
  S.currentFrame = f;
  S.displayFrame = f;
  syncSeek();
  S.streamClockRaf = requestAnimationFrame(_streamClockTick);
}

function playLoop(ts) {
  if (!S.isPlaying) return;
  if (!S.totalFrames) {
    S.raf = requestAnimationFrame(playLoop);
    return;
  }

  if (!S.playBaseTs) {
    S.playBaseTs = ts;
    S.playBaseFrame = (S.displayFrame ?? S.currentFrame);
  }

  S.playbackStride = _getPlaybackStride();

  const realtimeMode = _useRealtimePreviewMode();
  const mode = _getEffectivePlaybackMode();
  const clockStep = realtimeMode ? Math.max(S.playbackStride, _getRealtimeStepFrames()) : 1;
  const wallTarget = _clockTargetFrame(ts, clockStep);
  let target = wallTarget;

  // ── A/V lock: audio is the master clock when PCM is actively playing ─────────
  // AudioContext.currentTime and performance.now() are independent time bases, so
  // over a long reel the wall-clock video target drifts from the audio. When the
  // audio source is live+buffered we derive the presentation frame from the audio
  // clock (_audCurrentFrame) instead. A max-slew clamp keeps a large audio-vs-video
  // gap from causing a violent jump — small gaps track exactly, large gaps re-anchor
  // the wall clock so the next frames converge. With no audio this branch is skipped
  // and behavior is byte-identical to the wall-clock path.
  const audFrame = _avLockActive() ? _audCurrentFrame() : null;
  if (audFrame != null && Number.isFinite(audFrame)) {
    const total = Math.max(1, S.totalFrames || 1);
    const audTarget = _quantizeFrame(Math.max(0, Math.min(audFrame, total - 1)), clockStep);
    const shown = (S.displayFrame ?? S.currentFrame ?? 0);
    S.avOffsetMs = ((audFrame - shown) * S.frameInterval) || 0;   // + = video behind audio
    const maxSlew = Math.max(clockStep, Math.round((S.fps || 24) * 0.5)); // ≤~0.5s correction/frame
    const gap = audTarget - wallTarget;
    if (Math.abs(gap) > maxSlew) {
      // Large divergence — re-anchor the wall clock to the audio position instead of
      // seeking violently, so subsequent frames track smoothly from here.
      target = audTarget;
      S.playBaseTs = ts - (audTarget * S.frameInterval);
      S.playBaseFrame = 0;
    } else {
      target = audTarget;
    }
  } else {
    S.avOffsetMs = 0;
  }

  if (audFrame == null && !realtimeMode) {
    const shown = (S.displayFrame ?? S.currentFrame);
    const lag = Math.max(0, target - shown);
    if (lag > Math.max(10, S.playbackStride * 4) && shown >= 0) {
      target = shown;
      S.playBaseTs = ts - (shown * S.frameInterval);
      S.playBaseFrame = 0;
    }
  }

  // Measured presented-FPS: count advances over a rolling 1-second wall window.
  if (target !== S.currentFrame && S.isPlaying) {
    if (!S._rtFpsWinTs) S._rtFpsWinTs = ts;
    S._rtFpsCount++;
    if (ts - S._rtFpsWinTs >= 1000) {
      S.rtHudFps = (S._rtFpsCount * 1000) / (ts - S._rtFpsWinTs);
      S._rtFpsCount = 0;
      S._rtFpsWinTs = ts;
    }
  }

  if (target !== S.currentFrame) {
    if (S.isPlaying) {
      const prev = S.currentFrame | 0;
      const delta = target >= prev ? (target - prev) : 0;
      // Count only UNINTENDED lag: the realtime scheduler advances by clockStep
      // frames on purpose (reduced-scale stride), so advances within the stride
      // are intentional, not dropped frames. Counting the full delta inflated the
      // drop metric AND pinned the adaptive scaler as 'stressed' (lastFrameAdvance>1
      // / droppedFrames>0), so preview scale could never recover upward. For the
      // non-realtime path clockStep===1, so lag === delta-1 as before.
      const lag = Math.max(0, delta - clockStep);
      if (lag > 0) S.droppedFrames += lag;
      S.lastFrameAdvance = lag;
    }
    S.currentFrame = target;

    // ── Auto-advance to next reel at CPL boundary ─────────────────────────────
    // When the playhead reaches the final frame of this reel, hand off to
    // imf_ui.js (which owns the CPL/reel list) to load the next reel and keep
    // playing. The dispatch runs synchronously: in the Electron path-only case
    // the listener calls playerLoadReel({autoPlay:true}) which increments
    // S.loadSeq and starts a fresh playLoop on a new rAF *before* control returns
    // here. If a new reel was loaded we must bow out WITHOUT touching the new
    // play state (otherwise we'd cancel the next reel before it shows a frame).
    if (S.isPlaying && S.currentFrame >= S.totalFrames - 1) {
      const seqBefore = S.loadSeq;
      document.dispatchEvent(new CustomEvent('imf:reel-end', {
        detail: { tcOffset: S.tcOffset, totalFrames: S.totalFrames }
      }));
      if (S.loadSeq !== seqBefore) return;   // next reel loaded — old loop steps aside
      // Last reel — stop playback cleanly at the final frame.
      S.isPlaying = false;
      _audStop();
      cancelAnimationFrame(S.raf);
      const playBtn = document.getElementById('imfBtnPlay');
      if (playBtn) playBtn.textContent = '▶';
      drawFrame();
      _emitPlayerState();
      return;
    }

    S.frameBytes = null;
    S.frameJ2K = null;
    syncSeek();
  } else {
    S.lastFrameAdvance = 0;
  }

  _maybeAdaptPreviewScale();

  let drew = false;
  if (S.displayFrame !== S.currentFrame) {
    if (_restoreCachedFrame(S.currentFrame)) {
      drawFrame();
      if (!S.isPlaying) drawScope();
      drew = true;
    } else if (S.isPlaying && _restoreLatestCachedAtOrBefore(S.currentFrame, realtimeMode ? Math.min(72, Math.max(8, S.playbackStride * 8)) : Math.min(28, Math.max(3, S.playbackStride * 4)))) {
      drawFrame();
      drew = true;
    } else if (_restoreNearbyCachedFrame(S.currentFrame, realtimeMode ? Math.min(48, Math.max(4, S.playbackStride * 6)) : Math.min(24, Math.max(2, S.playbackStride * 3)))) {
      drawFrame();
      drew = true;
    }
  }

  const presentBase = Math.max(S.currentFrame, (S.displayFrame ?? -1));
  const leadFrames = mode === 'quality'
    ? Math.max(1, Math.min(8, Math.ceil((S.decodeAvgMs || S.frameInterval) / S.frameInterval) + 2))
    : realtimeMode
    ? Math.max(_getRealtimeStepFrames(), Math.min(48, S.playbackStride * 4))
    : (S.isPlaying
      ? Math.max(S.playbackStride * 2, Math.min(24, Math.ceil((S.decodeAvgMs || S.frameInterval) / S.frameInterval) * S.playbackStride * 2))
      : 0);
  // Clamp the prefetch target to the reel's last frame — never wrap with modulo,
  // which would prefetch frame 0 of this reel right at the boundary instead of
  // letting the reel end and the next reel take over.
  const desiredFrame = _quantizeFrame(Math.min(presentBase + leadFrames, S.totalFrames - 1), realtimeMode ? Math.max(S.playbackStride, _getRealtimeStepFrames()) : 1);
  const mustDecodeNow = mode === 'quality' || S.displayFrame == null || Math.abs((S.displayFrame ?? 0) - S.currentFrame) > Math.max(2, S.playbackStride * 2);
  const requestFrame = mustDecodeNow ? _quantizeFrame(S.currentFrame, realtimeMode ? Math.max(1, S.playbackStride) : 1) : desiredFrame;

  if (S.decodeBusy) {
    S.pendingFrame = requestFrame;
    S.pendingSeq = S.loadSeq;
    _tryUrgentParallelDecode(requestFrame, S.loadSeq);
  } else if (!_anyDecodeInflight(requestFrame) && !S.decodedCache.has(requestFrame)) {
    _loadFrameBytes(requestFrame, S.loadSeq);
  }
  _prefetchAroundFrame(requestFrame, S.loadSeq);

  if (!drew) drawFrame();
  S.raf = requestAnimationFrame(playLoop);
}

function syncSeek() {
  const seek = document.getElementById('imfSeek');
  const lbl  = document.getElementById('imfFrameLabel');
  const tc   = document.getElementById('imfTC');
  const tcTL = document.getElementById('imfTCTL');
  const proxyState = _getProxyFrameState();
  const currentFrame = proxyState ? proxyState.localFrame : S.currentFrame;
  const totalFrames  = proxyState ? proxyState.totalFrames : S.totalFrames;
  const fps          = proxyState ? proxyState.fps : S.fps;
  if (seek) {
    // If the CPL total frames are stamped (multi-reel mode), use absolute position
    // so the scrubber thumb aligns with the timeline playhead.
    const cplFrames = parseInt(seek.dataset.cplFrames, 10) || 0;
    const absFrame  = (S.tcOffset || 0) + currentFrame;
    if (cplFrames > totalFrames) {
      seek.max   = cplFrames - 1;
      seek.value = absFrame;
      const pct  = (absFrame / cplFrames * 100).toFixed(2) + '%';
      seek.style.setProperty('--pct', pct);
    } else {
      seek.max   = Math.max(0, totalFrames - 1);
      seek.value = currentFrame;
      const pct  = totalFrames > 0 ? (currentFrame / totalFrames * 100).toFixed(2) + '%' : '0%';
      seek.style.setProperty('--pct', pct);
    }
  }
  if (lbl) lbl.textContent = totalFrames > 0
    ? `fr ${(currentFrame + 1).toLocaleString()} / ${totalFrames.toLocaleString()}`
    : '';
  const tcOpts = proxyState ? undefined : _tcOpts();
  if (tc) tc.textContent = totalFrames > 0 ? fmtTC(currentFrame, fps, tcOpts) : '–:––:––:––';
  // Show absolute timeline timecode when tcOffset > 0 (multi-reel)
  if (tcTL) {
    const absFrame = (S.tcOffset || 0) + currentFrame;
    tcTL.textContent = S.tcOffset > 0 && totalFrames > 0
      ? `TL ${fmtTC(absFrame, fps, tcOpts)}`
      : '';
  }
  _emitPlayerState();
}

function seekTo(frame) {
  // Scrubbing during realtime streaming: drop the stream and pause to a crisp,
  // frame-accurate decode at the target (resume playback to re-engage realtime).
  if (S.streamMode) {
    _stopRealtimeStream();
    if (S.isPlaying) {
      S.isPlaying = false;
      const b = document.getElementById('imfBtnPlay'); if (b) b.textContent = '▶';
    }
  }
  S.currentFrame = Math.max(0, Math.min(frame, S.totalFrames - 1));
  S.frameBytes   = null;
  S.frameJ2K     = null;
  // Track scrub recency so _previewLowres() decodes reduced-res while dragging,
  // then arm a settle timer to refine to full res once scrubbing stops.
  S._lastSeekAt = performance.now();
  clearTimeout(S._settleTimer);
  S._settleTimer = setTimeout(() => { if (!S.isPlaying) _refineCurrentFrameFullRes(); }, 380);
  // Re-anchor audio to the new position so it tracks the scrub while playing.
  if (S.isPlaying) { _audStop(); _audPlay(S.currentFrame); }
  // Keep the last decoded image visible while the requested frame is loading.
  syncSeek();
  if (_restoreCachedFrame(S.currentFrame)) {
    drawFrame();
    if (!S.isPlaying) drawScope();
    return;
  }
  drawFrame();
  // Kick off async frame load (non-blocking — updates canvas when ready)
  const desiredFrame = _quantizeFrame(S.currentFrame, _getPlaybackStride());
  if (S.decodeBusy) {
    S.pendingFrame = desiredFrame;
    S.pendingSeq = S.loadSeq;
  } else if (!_anyDecodeInflight(desiredFrame)) {
    _loadFrameBytes(desiredFrame, S.loadSeq);
  }
}

async function _loadFrameBytes(frame, seq, opts = {}) {
  // When the Electron IPC backend is available, always prefer it over browser WASM.
  // The Electron path (ffmpeg) handles all J2K variants reliably. Browser WASM decoders
  // are only used as a fallback when there is no Electron companion (pure web mode).
  const _hasElectronBackend = (S.cplPath || S.mxfPath) &&
    typeof window.pfxPlatform?.imf?.requestFrame === 'function';

  if (!S.mxfFile || !S.mxfIndex || S.mxfIndex.error || _hasElectronBackend) {
    // Electron companion mode — no browser WASM; use IPC decode path.
    if (!opts.prefetch) {
      if (S.cplPath) {
        _tryElectronImfDecode(frame, seq);
      } else if (S.mxfPath) {
        // No CPL path for IMF demuxer — fall back to per-MXF path.
        if (S.previewStatus.status === 'PLACEHOLDER_ONLY') {
          S.previewStatus = {
            status: 'ERROR',
            engine: 'imf-demuxer',
            diagnostic: 'CPL path not resolved — package may still be indexing, or run via browser picker without companion path. Trying per-MXF decode…',
            canRunScopes: false,
          };
          drawFrame();
        }
        _tryElectronFrameBackend(frame, seq);
      }
    }
    if (!S.mxfIndex && !_hasElectronBackend) console.log('[IMF] _loadFrameBytes: no mxfIndex yet');
    else if (S.mxfIndex?.error) console.warn('[IMF] _loadFrameBytes: index error', S.mxfIndex.error);
    return;
  }
  const isPrefetch = !!opts.prefetch;
  const allowPresent = opts.present !== false;
  if (isPrefetch) {
    if (S.decodedCache.has(frame) || S.inflightFrame === frame || S.decodePrefetchInflight.has(frame)) return;
  } else {
    if (S.decodeBusy) {
      S.pendingFrame = frame;
      S.pendingSeq = seq;
      return;
    }
    S.decodeBusy = true;
    S.inflightFrame = frame;
  }
  const decodeStart = performance.now();
  try {
    if (_restoreCachedFrame(frame)) {
      if (!isPrefetch && allowPresent) {
        drawFrame();
        if (!S.isPlaying) drawScope();
      }
      return;
    }
    const bytes = await _readFrameBytesCached(frame);
    if (seq !== S.loadSeq) return;  // stale request generation
    if (!bytes || bytes.length === 0) {
      console.warn(`[IMF] fr${frame} → null/empty (essStart=${S.mxfIndex.essenceStartOffset}, off=${S.mxfIndex.frameOffsets?.[frame]})`);
      return;
    }

    const soc = bytes[0].toString(16).padStart(2,'0') + bytes[1].toString(16).padStart(2,'0');
    console.log(`[IMF] fr${frame} → ${bytes.length} bytes  SOC=0x${soc.toUpperCase()}`);

    if (!isPrefetch) {
      S.frameBytes  = bytes;
      S.frameJ2K    = parseJ2KHeader(bytes);
    }

    // ── Try WASM HTJ2K decode (OpenJPH) ───────────────────────────────────────
    if (_decodeHTJ2K) {
      // C-RT1b: reduced-resolution DWT decode during continuous playback (the J2K
      // decode is the real-time bottleneck — full-res can't sustain UHD on CPU, see
      // PostFlowX_CRT0_Audit.md). The earlier "dark/corrupt/oscillating" instability
      // was a dims bug in imf_j2k.js (it returned getFrameInfo() FULL dims with a
      // REDUCED buffer) — now fixed (dims come from calculateSizeAtDecompositionLevel).
      // Default S.previewScale is 1 (full), so behaviour is unchanged until the user
      // or the adaptive logic lowers it; pause/scrub always decode full-res.
      const decodeScale = S.isPlaying ? (S.previewScale || 1) : 1;
      const renderScale = 1; // canvas/view scaling stays full; decode scale handles reduction.
      const decoded = await _decodeHTJ2K(bytes, { scale: decodeScale, fastMode: !!S.isPlaying });
      if (seq !== S.loadSeq) return;

      if (decoded) {
        console.log(`[IMF] fr${frame} decoded via ${decoded.decoderKind || 'unknown'}: ${decoded.width}×${decoded.height}  ${decoded.componentCount}ch  ${decoded.bitsPerSample}bpp`);
        let rendered = null;
        // Build colorInfo once so both paths (worker and fallback) use the same settings.
        const _colorInfo = {
          transfer: S.transfer || '–',
          primaries: S.primaries || '–',
          tonemapMode: S.previewMode || 'sdr',
          srcPeakNits: S.srcPeakNits,
          activeL1MaxNits: _getActiveL1NitsForFrame(),
          dvTrim: S.previewMode === 'trim' ? _activeTrimForFrame() : null,
          previewHdr: S.previewHdr,
        };
        try {
          rendered = await _renderDecodedFrame(decoded, renderScale, { needScope: !S.isPlaying });
        } catch (renderErr) {
          console.warn('[IMF] worker render failed, falling back to main-thread ImageData', renderErr);
          rendered = { imageData: _frameToImageData ? _frameToImageData(decoded, renderScale, _colorInfo) : null, bitmap: null, scopePixels: null, scopeW: 0, scopeH: 0, mode: 'main-fallback' };
        }
        const imageData = rendered.imageData || (_frameToImageData ? _frameToImageData(decoded, renderScale, _colorInfo) : null);
        const shouldPresent = allowPresent && (!S.isPlaying || S.currentFrame === frame || S.displayFrame == null || !S.frameBitmap && !S.frameImageData || Math.abs(frame - S.currentFrame) <= Math.max(1, S.playbackStride * 2) || frame > (S.displayFrame ?? -1));
        let localSurface = null;
        let localBitmap = rendered.bitmap || null;
        let localPixels = rendered.scopePixels || null;
        let localPixW = rendered.scopeW || 0;
        let localPixH = rendered.scopeH || 0;

        if (imageData && !localBitmap) {
          try {
            localSurface = _createFrameSurface(imageData.width, imageData.height);
            const sctx = localSurface.getContext('2d', { alpha: false });
            sctx.putImageData(imageData, 0, 0);
            if (!S.isPlaying) {
              localBitmap = await createImageBitmap(localSurface);
            }
          } catch (ce) {
            console.warn('[IMF] decoded frame surface create failed', ce);
            localSurface = null;
          }
        }

        if (shouldPresent) {
          S.frameImageData = imageData;
          S.frameSurface = localSurface;
          S.frameBitmap = localBitmap;
          S.framePixels = localPixels;
          S.framePixW = localPixW;
          S.framePixH = localPixH;
          S.displayFrame = frame;
          const lumaClass = localPixels ? _classifyFrameLuma(localPixels, localPixW || 1, localPixH || 1) : 'unknown';
          if (lumaClass === 'valid_black' || lumaClass === 'black_clip_warning') {
            S.decodeInfo.blackFrames = (S.decodeInfo.blackFrames || 0) + 1;
          }
          S.previewStatus = {
            status: 'REAL_FRAME',
            engine: rendered.mode === 'worker' ? 'j2k-worker' : rendered.mode === 'main-fallback' ? 'j2k-main' : 'j2k',
            diagnostic: lumaClass !== 'normal_frame' && lumaClass !== 'unknown' ? lumaClass : '',
            canRunScopes: lumaClass !== 'valid_black',
          };
          if (S.isPlaying) {
            if (S.currentFrame === frame) syncSeek();
          }
          // Persist to main-process disk cache so future sessions skip re-decode
          _persistFrameToCache(frame, imageData);
        }

        _cacheDecodedFrame(frame, imageData, localSurface, localBitmap, localPixels, localPixW, localPixH);
      }
    }

    // ── Fallback: try native browser jp2 decode (Safari) ─────────────────────
    if (!S.frameBitmap && !S.frameImageData) {
      for (const mime of ['image/jp2', 'image/jpx']) {
        try {
          const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
          if (seq !== S.loadSeq) return;
          if (!S.isPlaying || S.currentFrame === frame || S.displayFrame == null || frame > (S.displayFrame ?? -1)) {
            S.frameBitmap = bitmap;
            S.displayFrame = frame;
            S.previewStatus = { status: 'REAL_FRAME', engine: 'bitmap', diagnostic: '', canRunScopes: true };
            if (S.isPlaying) {
              if (S.currentFrame === frame) syncSeek();
            }
          }
          console.log(`[IMF] fr${frame} native ${mime} → ${bitmap.width}×${bitmap.height}`);
          break;
        } catch { /* not supported */ }
      }
    }

    // Electron fallback: async, fires when renderer produced no bitmap.
    if (!S.frameBitmap && !S.frameImageData) {
      _tryElectronFrameBackend(frame, seq); // intentionally not awaited
    }

    if (!isPrefetch && allowPresent) {
      if (!S.frameBitmap && !S.frameImageData && S.displayFrame == null) {
        _restoreNearestCachedFrame(frame, Math.max(6, S.playbackStride * 3));
      }
      drawFrame();
      if (!S.isPlaying) drawScope();
    }
    _prefetchAroundFrame(frame, seq);
  } catch (e) {
    console.warn('[IMF] frame load error', e);
  } finally {
    const decodeMs = performance.now() - decodeStart;
    S.decodeAvgMs = S.decodeAvgMs > 0 ? (S.decodeAvgMs * 0.85 + decodeMs * 0.15) : decodeMs;
    S.playbackStride = _getPlaybackStride();
    _maybeAdaptPreviewScale();
    if (!isPrefetch) {
      S.decodeBusy = false;
      S.inflightFrame = null;
      if (S.pendingFrame != null) {
        const pf = S.pendingFrame;
        const ps = S.pendingSeq;
        S.pendingFrame = null;
        S.pendingSeq = 0;
        if (ps === S.loadSeq) {
          requestAnimationFrame(() => _loadFrameBytes(pf, ps));
        }
      }
    }
    _drainDecodePrefetch(seq);
  }
}

function _createFrameSurface(width, height) {
  try {
    if (typeof OffscreenCanvas === 'function') {
      return new OffscreenCanvas(width, height);
    }
  } catch {}
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return c;
}

// Persist a renderer-decoded frame to the main-process disk cache (fire-and-forget).
// Uses OffscreenCanvas.convertToBlob() async to avoid blocking the main thread during
// PNG encoding (4K RGBA synchronous toDataURL can take 100–500 ms and causes playback jank).
function _persistFrameToCache(frame, imageData) {
  if (!imageData || !S.mxfPath || !S.packageHash || !S.cplId) return;
  if (typeof window.pfxPlatform?.imf?.cacheFrame !== 'function') return;
  // Capture before any async gap — S may have changed by the time blob encodes
  const mxfFrame    = (S.entryPoint || 0) + frame;
  const packageHash = S.packageHash;
  const cplId       = S.cplId;
  const displayMode = S.previewMode || 'sdr';
  const send = (dataUrl) => window.pfxPlatform.imf.cacheFrame({ packageHash, cplId, mxfFrame, displayMode, imageDataUrl: dataUrl }).catch(() => {});
  try {
    if (typeof OffscreenCanvas !== 'undefined') {
      const oc  = new OffscreenCanvas(imageData.width, imageData.height);
      const ctx = oc.getContext('2d');
      ctx.putImageData(imageData, 0, 0);
      oc.convertToBlob({ type: 'image/png' }).then(blob => {
        const fr = new FileReader();
        fr.onload = () => send(fr.result);
        fr.readAsDataURL(blob);
      }).catch(() => {});
    } else {
      // Synchronous fallback for environments where OffscreenCanvas is unavailable
      const oc  = _createFrameSurface(imageData.width, imageData.height);
      const ctx = oc.getContext('2d');
      ctx.putImageData(imageData, 0, 0);
      send(oc.toDataURL('image/png'));
    }
  } catch { /* never block decode on cache write */ }
}

// Classify decoded frame luma; returns 'valid_black'|'black_clip_warning'|'near_white'|'normal_frame'|'unknown'
function _classifyFrameLuma(pixels, w, h) {
  if (!pixels || !w || !h) return 'unknown';
  const total = w * h;
  const stride = Math.max(1, Math.floor(total / 500));
  let sum = 0; let count = 0;
  for (let i = 0; i < total; i += stride) {
    const base = i * 4;
    sum += pixels[base] * 0.2126 + pixels[base + 1] * 0.7152 + pixels[base + 2] * 0.0722;
    count++;
  }
  const mean = count > 0 ? sum / count : 0;
  if (mean < 4)   return 'valid_black';
  if (mean < 12)  return 'black_clip_warning';
  if (mean > 245) return 'near_white';
  return 'normal_frame';
}

// ── Electron IMF demuxer decode ───────────────────────────────────────────────
// Primary decode path for Electron companion mode.  Uses the FFmpeg IMF demuxer
// (ffmpeg -f imf -assetmaps ...) so it handles HTJ2K, supplemental packages, and
// multi-reel CPLs without needing per-MXF asset resolution in the renderer.
async function _tryElectronImfDecode(frame, seq) {
  if (typeof window.pfxPlatform?.imf?.decodeFrame !== 'function') {
    // API not available — fall back to per-MXF path
    if (S.mxfPath) _tryElectronFrameBackend(frame, seq);
    return;
  }
  if (!S.cplPath) {
    if (S.mxfPath) _tryElectronFrameBackend(frame, seq);
    return;
  }

  const t0 = performance.now();
  // CPL-absolute frame = this reel's composition start + reel-local frame
  const cplFrame = (S.tcOffset || 0) + frame;

  console.log(`[IMF] _tryElectronImfDecode reel=${S.reelNum || 1} frame=${frame} cplFrame=${cplFrame} cpl=${S.cplPath}`);
  console.log(`[IMF] assetMaps=${JSON.stringify(S.assetMaps)}`);

  let result;
  try {
    result = await window.pfxPlatform.imf.decodeFrame({
      cplPath:     S.cplPath,
      assetMaps:   S.assetMaps || [],
      frameNumber: cplFrame,
      scale:       'viewer',
      packageHash: S.packageHash || 'imf',
      cplId:       S.cplId       || 'cpl',
      displayMode: S.previewMode || 'sdr',
      lowres:      _previewLowres(),
    });
  } catch (e) {
    console.warn('[IMF] decodeFrame IPC error:', e.message || e);
    S.previewStatus = {
      status: 'ERROR',
      engine: 'imf-demuxer',
      diagnostic: `IPC error: ${e.message || 'decodeFrame threw'}`,
      canRunScopes: false,
    };
    if (!S.isPlaying) drawFrame();
    return;
  }

  const elapsed = Math.round(performance.now() - t0);

  // Print all debug log lines emitted by the main process
  if (Array.isArray(result.log)) {
    for (const line of result.log) console.log(line);
  }

  // Update pipeline status chips regardless of success/fail
  S.pipelineStatus = {
    cplParse:     result.imfDemuxerOK !== false ? 'ok' : 'fail',
    assetResolve: result.imfDemuxerOK ? 'ok' : 'fail',
    mxfRead:      result.ok ? 'ok' : (result.code === 'DECODE_FAILED' ? 'ok' : 'fail'),
    pixelDecode:  result.ok ? 'ok' : 'fail',
    decoder:      result.ok ? (result.codec || 'J2K') : null,
  };

  if (!result.ok) {
    const errMsg = result.error || result.code || 'decode failed';
    S.decodeInfo.failedFrames = (S.decodeInfo.failedFrames || 0) + 1;
    S.decodeInfo.lastAttempt = { frame, cplFrame, backend: 'imf-demuxer', ok: false, code: result.code, error: errMsg, elapsed };
    console.warn(`[IMF] IMF demuxer decode FAILED (${result.code}): ${errMsg}`);
    if (result.stderr) console.warn(`[IMF] stderr: ${result.stderr.slice(-600)}`);

    // IMF demuxer unavailable (ffmpeg not compiled with -f imf support) — fall back to direct MXF decode.
    // The main process decodeFrame already tried its own MXF fallback (via buildReelList).
    // If that also failed (PROBE_FAILED returned), try via _tryElectronFrameBackend which
    // calls requestFrame directly. Works even when S.mxfPath is empty — the main process
    // buildReelList fallback inside decodeFrame already resolved the correct MXF path.
    // Note: we always attempt this fallback regardless of S.mxfPath — no guard needed.
    if (
      result.code === 'PROBE_FAILED' ||
      result.code === 'FFMPEG_NOT_FOUND' ||
      result.code === 'CPL_NOT_FOUND' ||
      result.code === 'NO_CPL_PATH' ||
      (result.stderr && result.stderr.includes('Unknown input format'))
    ) {
      console.warn('[IMF] IMF demuxer unavailable — falling back to direct MXF decode via _tryElectronFrameBackend');
      if (S.mxfPath) {
        _tryElectronFrameBackend(frame, seq);
        return;
      }
      // S.mxfPath is empty (e.g. supplemental reel with base MXF) — show diagnostic but
      // don't leave a silent placeholder; decodeFrame already attempted the MXF fallback above.
      S.previewStatus = {
        status: 'ERROR',
        engine: 'imf-demuxer',
        diagnostic: 'IMF demuxer unavailable (ffmpeg lacks -f imf support) and no direct MXF path resolved. Check that the package is fully indexed.',
        canRunScopes: false,
      };
      if (!S.isPlaying) drawFrame();
      return;
    }

    // For all other failures (HTJ2K not decoded, genuine decode error), show explicit error
    S.previewStatus = {
      status: 'ERROR',
      engine: 'imf-demuxer',
      diagnostic: `Decode failed (${result.code || 'DECODE_FAILED'}): ${errMsg.slice(0, 140)}`,
      canRunScopes: false,
    };
    if (!S.isPlaying) drawFrame();
    return;
  }

  if (seq !== S.loadSeq) return; // stale — seek moved while decode was in flight

  // Guard: result.ok=true but no image payload — show explicit error instead of silent placeholder
  if (!result.imageDataUrl && !result.imageUrl) {
    console.warn('[IMF] decodeFrame returned ok=true but no image payload');
    S.previewStatus = {
      status: 'ERROR', engine: 'imf-demuxer',
      diagnostic: `Decode returned no image (backend=${result.backend || '?'}, codec=${result.codec || '?'})`,
      canRunScopes: false,
    };
    if (!S.isPlaying) drawFrame();
    return;
  }

  if (result.imageUrl || result.imageDataUrl) {
    let bitmap;
    try {
      bitmap = await _resultToBitmap(result);
    } catch {
      console.warn('[IMF] Failed to load decoded frame');
      return;
    }
    if (!bitmap || seq !== S.loadSeq) return;

    // Compute luma class for scope enable/disable
    const tmpCanvas = document.createElement('canvas');
    tmpCanvas.width  = bitmap.width;
    tmpCanvas.height = bitmap.height;
    const tmpCtx = tmpCanvas.getContext('2d', { willReadFrequently: true });
    tmpCtx.drawImage(bitmap, 0, 0);
    const idata      = tmpCtx.getImageData(0, 0, bitmap.width, bitmap.height);
    const lumaClass  = _classifyFrameLuma(idata.data, bitmap.width, bitmap.height);

    S.frameBitmap    = bitmap;
    S.displayFrame   = frame;
    S.framePixels    = idata.data;
    S.framePixW      = bitmap.width;
    S.framePixH      = bitmap.height;
    S.previewStatus  = {
      status:        'REAL_FRAME',
      engine:        'imf-demuxer',
      diagnostic:    `${result.codec || 'J2K'} · ${elapsed}ms`,
      canRunScopes:  lumaClass !== 'valid_black',
    };
    S.decodeInfo.lastAttempt = { frame, cplFrame, backend: 'imf-demuxer', codec: result.codec, elapsed, ok: true, lumaClass };
    S.decodeInfo.electronResults = [
      { backend: 'imf-demuxer', codec: result.codec, elapsed, ok: true },
      ...(S.decodeInfo.electronResults || []).slice(0, 9),
    ];
    S.lastDecodeBackend = result.backend || 'imf-demuxer';

    drawFrame();
    if (!S.isPlaying) drawScope();
  }
}

// Reduced-resolution preview level for the main-process J2K decode. JPEG2000 is
// wavelet multi-resolution, so a lower level decodes ~4–8× faster — used while
// playing or actively scrubbing. Full resolution (0) returns once settled, and
// _refineCurrentFrameFullRes re-decodes the held frame sharply on pause/settle.
// "Balanced" profile = lowres 2 (≈480×270 preview, ~8× faster).
const _PREVIEW_LOWRES = 2;
function _previewLowres() {
  if (S.isPlaying) return _PREVIEW_LOWRES;
  if ((performance.now() - (S._lastSeekAt || 0)) < 350) return _PREVIEW_LOWRES; // mid-scrub
  return 0;
}

// Re-decode the currently displayed frame at full resolution. Called when
// playback stops or scrubbing settles, so the held low-res preview is replaced
// by a crisp full-res frame.
function _refineCurrentFrameFullRes() {
  if (S.isPlaying) return;
  const f = S.displayFrame ?? S.currentFrame;
  if (f == null) return;
  _loadFrameBytes(f, S.loadSeq);
}

// Decode a main-process frame result into an ImageBitmap.
// Prefers result.imageUrl (a pfx-media:// URL): the bytes are fetched and
// decoded to a CLEAN ImageBitmap, so drawing it and reading pixels back via
// getImageData (the scopes path) does NOT taint the canvas. Falls back to a
// base64 data URL for backends that still return one (temp files, OCF stills).
async function _resultToBitmap(result) {
  if (result.imageUrl) {
    const res = await fetch(result.imageUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`frame fetch failed: ${res.status}`);
    const blob = await res.blob();
    return await createImageBitmap(blob);
  }
  if (result.imageDataUrl) {
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = result.imageDataUrl; });
    return await createImageBitmap(img);
  }
  return null;
}

// ── Electron IMF backend fallback ─────────────────────────────────────────────
// Called async when renderer decode produces no bitmap. Updates canvas when the
// main-process result (ffmpeg or cache) arrives if the seek hasn't changed.
async function _tryElectronFrameBackend(frame, seq) {
  if (typeof window.pfxPlatform?.imf?.requestFrame !== 'function') return;
  if (!S.mxfPath) return;

  const mxfFrame = (S.entryPoint || 0) + frame;
  const t0 = performance.now();

  try {
    const result = await window.pfxPlatform.imf.requestFrame({
      mxfPath:     S.mxfPath,
      mxfFrame,
      packageHash: S.packageHash || 'unknown',
      cplId:       S.cplId       || 'unknown',
      displayMode: S.previewMode || 'sdr',
      lowres:      _previewLowres(),
    });

    // A SUPERSEDED result means a newer frame request displaced this one in the
    // main-process decode queue (fast scrub / read-ahead). It is a benign skip,
    // not a decode failure — the newer request will paint instead. Bail before
    // it counts as a failed frame or logs a warning.
    if (result && result.code === 'SUPERSEDED') return;
    if (seq !== S.loadSeq) return;

    const elapsed = Math.round(performance.now() - t0);

    const attempt = {
      frame, mxfFrame, entryPoint: S.entryPoint || 0,
      backend: result.frameInfo?.backend || 'unknown',
      codec:   result.frameInfo?.codec   || '?',
      elapsed, ok: result.ok,
      code:    result.code  || null,
      error:   result.error || null,
    };
    S.decodeInfo.lastAttempt     = attempt;
    S.decodeInfo.electronResults = [
      { ...attempt, ...result.frameInfo },
      ...(S.decodeInfo.electronResults || []).slice(0, 9),
    ];

    if (!result.ok) {
      S.decodeInfo.failedFrames = (S.decodeInfo.failedFrames || 0) + 1;
      const errCode = result.code || 'DECODE_FAILED';
      const errMsg  = result.error || errCode;
      if (errCode !== 'UNSUPPORTED_HTJ2K') {
        console.warn('[IMF] Electron backend failed:', errCode, errMsg);
      }

      // ── HTJ2K WASM fallback ──────────────────────────────────────────────────
      // The main process extracted the raw codestream bytes (via ffmpeg -c:v copy,
      // which works without any HTJ2K decoder) and piggybacked them on the response.
      // Try the browser-side WASM OpenJPH decoder before showing an error.
      if (errCode === 'UNSUPPORTED_HTJ2K' && result.essenceBytesB64 && _decodeHTJ2K) {
        try {
          const b64  = result.essenceBytesB64;
          const raw  = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
          console.log(`[IMF] HTJ2K WASM fallback: ${raw.length} bytes, frame=${frame}`);
          const decoded = await _decodeHTJ2K(raw, { scale: 1, fastMode: !!S.isPlaying });
          if (seq !== S.loadSeq) return;
          if (decoded) {
            const _colorInfo = {
              transfer:       S.transfer   || '–',
              primaries:      S.primaries  || '–',
              tonemapMode:    S.previewMode || 'sdr',
              srcPeakNits:    S.srcPeakNits,
              activeL1MaxNits: _getActiveL1NitsForFrame(),
              dvTrim:         S.previewMode === 'trim' ? _activeTrimForFrame() : null,
              previewHdr:     S.previewHdr,
            };
            let rendered = null;
            try {
              rendered = await _renderDecodedFrame(decoded, 1, { needScope: !S.isPlaying });
            } catch {
              rendered = { imageData: _frameToImageData ? _frameToImageData(decoded, 1, _colorInfo) : null, bitmap: null, scopePixels: null, scopeW: 0, scopeH: 0, mode: 'main-fallback' };
            }
            if (seq !== S.loadSeq) return;
            const imageData = rendered.imageData || (_frameToImageData ? _frameToImageData(decoded, 1, _colorInfo) : null);
            if (imageData) {
              let localBitmap = rendered.bitmap || null;
              let localSurface = null;
              if (!localBitmap) {
                try {
                  localSurface = _createFrameSurface(imageData.width, imageData.height);
                  localSurface.getContext('2d', { alpha: false }).putImageData(imageData, 0, 0);
                  if (!S.isPlaying) localBitmap = await createImageBitmap(localSurface);
                } catch {}
              }
              S.frameImageData = imageData;
              S.frameSurface   = localSurface;
              S.frameBitmap    = localBitmap;
              S.framePixels    = rendered.scopePixels || null;
              S.framePixW      = rendered.scopeW || 0;
              S.framePixH      = rendered.scopeH || 0;
              S.displayFrame   = frame;
              const lumaClass  = S.framePixels ? _classifyFrameLuma(S.framePixels, S.framePixW || 1, S.framePixH || 1) : 'unknown';
              S.previewStatus  = {
                status:       'REAL_FRAME',
                engine:       'renderer-htj2k',
                diagnostic:   `HTJ2K WASM · ${decoded.width}×${decoded.height}`,
                canRunScopes: lumaClass !== 'valid_black',
              };
              S.lastDecodeBackend = 'renderer-htj2k';
              drawFrame();
              if (!S.isPlaying) drawScope();
              _cacheDecodedFrame(frame, imageData, localSurface, localBitmap, S.framePixels, S.framePixW, S.framePixH);
              return;  // success — skip error display
            }
          }
          console.warn('[IMF] HTJ2K WASM returned no decoded frame');
        } catch (wasmErr) {
          console.warn('[IMF] HTJ2K WASM fallback error:', wasmErr?.message || wasmErr);
        }
      }

      // Show explicit error — never silently leave the placeholder
      let diagnostic;
      if (errCode === 'UNSUPPORTED_HTJ2K') {
        diagnostic = result.essenceBytesB64
          ? 'HTJ2K WASM decoder returned no output. The codestream was extracted but decoding failed.'
          : 'HTJ2K requires FFmpeg with libopenjph or libgrok. Standard builds cannot decode HTJ2K (JPEG 2000 Part 15). Build FFmpeg with --enable-libopenjph or use the IMF demuxer decode path.';
      } else if (errCode === 'NO_BACKEND') {
        diagnostic = 'No decode backend available. In desktop mode, ensure the Electron companion is running and the package path is accessible.';
      } else {
        diagnostic = `Decode failed (${errCode})${errMsg && errMsg !== errCode ? ': ' + errMsg.slice(0, 140) : ''}`;
      }
      S.previewStatus = {
        status: 'ERROR',
        engine: result.frameInfo?.backend || 'electron-backend',
        diagnostic,
        canRunScopes: false,
      };
      if (!S.isPlaying) drawFrame();
      return;
    }

    if (seq !== S.loadSeq) return;

    if (result.imageUrl || result.imageDataUrl) {
      const bitmap = await _resultToBitmap(result);
      if (!bitmap || seq !== S.loadSeq) return;

      if (!S.frameBitmap && !S.frameImageData || frame > (S.displayFrame ?? -1)) {
        const tmpCanvas = _createFrameSurface(bitmap.width, bitmap.height);
        const tmpCtx    = tmpCanvas.getContext('2d', { willReadFrequently: true });
        tmpCtx.drawImage(bitmap, 0, 0);
        const idata     = tmpCtx.getImageData(0, 0, bitmap.width, bitmap.height);
        const lumaClass = _classifyFrameLuma(idata.data, bitmap.width, bitmap.height);
        if (lumaClass === 'valid_black' || lumaClass === 'black_clip_warning') {
          S.decodeInfo.blackFrames = (S.decodeInfo.blackFrames || 0) + 1;
        }
        if (S.decodeInfo.lastAttempt) S.decodeInfo.lastAttempt.lumaClass = lumaClass;

        S.frameBitmap   = bitmap;
        S.displayFrame  = frame;
        // Expose pixel buffer to scope engine — same path as renderer j2k pixels
        S.framePixels   = idata.data;
        S.framePixW     = bitmap.width;
        S.framePixH     = bitmap.height;
        S.previewStatus = {
          status:      'REAL_FRAME',
          engine:      `electron-${result.frameInfo?.backend || 'ffmpeg'}`,
          diagnostic:  `${result.frameInfo?.codec || ''} · ${elapsed}ms`,
          canRunScopes: lumaClass !== 'valid_black',
        };
        S.lastDecodeBackend = result.frameInfo?.backend || 'ffmpeg';
        drawFrame();
        if (!S.isPlaying) drawScope();
      }
    }
  } catch (e) {
    console.warn('[IMF] Electron backend error:', e.message || e);
    S.previewStatus = {
      status: 'ERROR',
      engine: 'electron-backend',
      diagnostic: `IPC error: ${e.message || 'requestFrame threw'}`,
      canRunScopes: false,
    };
    if (!S.isPlaying) drawFrame();
  }
}

// ── Canvas resize ─────────────────────────────────────────────────────────────
function resizeCanvas() {
  const canvas = S.canvas;
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const w = Math.round(rect.width  || canvas.offsetWidth  || 400);
  const h = Math.round(rect.height || canvas.offsetHeight || 160);
  if (w > 0 && h > 0) {
    canvas.width  = w;
    canvas.height = h;
    S.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
export function initIMFPlayer() {
  S.canvas = document.getElementById('imfCanvas');
  if (!S.canvas) return;

  // Scope canvas setup
  S.scopeCanvas = document.getElementById('imfScope');
  if (S.scopeCanvas) {
    S.scopeCtx = S.scopeCanvas.getContext('2d');
    // Size the scope canvas to its CSS size
    const resizeScope = () => {
      const rect = S.scopeCanvas.getBoundingClientRect();
      const w = Math.round(rect.width  || S.scopeCanvas.offsetWidth  || 220);
      const h = Math.round(rect.height || S.scopeCanvas.offsetHeight || 200);
      if (w > 0 && h > 0 && (S.scopeCanvas.width !== w || S.scopeCanvas.height !== h)) {
        S.scopeCanvas.width  = w;
        S.scopeCanvas.height = h;
        drawScope();
      }
    };
    resizeScope();
    new ResizeObserver(resizeScope).observe(S.scopeCanvas);

    // Overview 2×2 grid — redraw the mini scopes immediately when the panel
    // (and therefore the cards) resize, even while playback is paused.
    const sovGrid = document.getElementById('imfSovGrid');
    if (sovGrid && 'ResizeObserver' in window) {
      let _sovRaf = 0;
      const ro2 = new ResizeObserver(() => {
        if (S.scopeTab !== 'overview') return;
        if (_sovRaf) return;
        _sovRaf = requestAnimationFrame(() => { _sovRaf = 0; _updateScopeOverview(); });
      });
      ro2.observe(sovGrid);
    }

    // QC Details — refresh the Validation Context / Metadata cards whenever the
    // left-panel validation summary changes (package load, re-validate), not
    // just on playback. Selected Item is driven by updateTopbar().
    const valSummary = document.getElementById('imfValSummary');
    if (valSummary && 'MutationObserver' in window) {
      let _qcRaf = 0;
      const moQC = new MutationObserver(() => {
        if (_qcRaf) return;
        _qcRaf = requestAnimationFrame(() => { _qcRaf = 0; _updateQCDetails(); });
      });
      moQC.observe(valSummary, { childList: true, subtree: true, characterData: true });
    }
    _updateQCDetails();

    // ── Scopes Overview panel wiring ────────────────────────────────────────
    const _TAB_TO_MODE = { parade:'parade', waveform:'waveform', vector:'vector', audio:'meter' };
    const _TAB_LABELS  = { overview:'Scopes Overview', parade:'RGB Parade', waveform:'Waveform Monitor', vector:'Vectorscope', audio:'Audio Meter' };

    function _switchScopeTab(tab) {
      S.scopeTab = tab;
      document.querySelectorAll('.imf-stab').forEach(b =>
        b.classList.toggle('imf-stab-active', b.dataset.stab === tab));

      const grid = document.getElementById('imfSovGrid');
      const full = document.getElementById('imfScopeFull');
      const titleEl = document.getElementById('imfScopeFullTitle');

      if (tab === 'overview') {
        if (grid) grid.style.display = '';
        if (full) full.style.display = 'none';
        _startScopeLoop(); // start RAF loop for live updates
        _updateScopeOverview();
      } else {
        _stopScopeLoop(); // full-scope mode uses drawScope() on frame events instead
        if (grid) grid.style.display = 'none';
        if (full) full.style.display = '';
        if (titleEl) titleEl.textContent = _TAB_LABELS[tab] || tab;
        S.scopeMode = _TAB_TO_MODE[tab] || 'parade';
        // Re-init scopeCanvas to #imfScope (it's now in the full view)
        S.scopeCanvas = document.getElementById('imfScope');
        S.scopeCtx    = S.scopeCanvas ? S.scopeCanvas.getContext('2d', { alpha: false }) : null;
        if (S.scopeCanvas) {
          const dpr = window.devicePixelRatio || 1;
          const rect = S.scopeCanvas.getBoundingClientRect();
          S.scopeCanvas.width  = Math.max(1, Math.round((rect.width  || 150) * dpr));
          S.scopeCanvas.height = Math.max(1, Math.round((rect.height || 200) * dpr));
          if (S.scopeCtx) S.scopeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        drawScope();
        _updateFullStats();
      }
    }

    document.querySelectorAll('.imf-stab').forEach(btn => {
      btn.addEventListener('click', () => _switchScopeTab(btn.dataset.stab || 'overview'));
    });
    document.querySelectorAll('.imf-sov-expand').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); _switchScopeTab(btn.dataset.stab || 'parade'); });
    });
    const backBtn = document.getElementById('imfScopeBack');
    if (backBtn) backBtn.addEventListener('click', () => _switchScopeTab('overview'));

    // Setup mini canvases
    function _setupMiniCanvas(id, w, h) {
      const el = document.getElementById(id);
      if (!el) return null;
      const dpr = window.devicePixelRatio || 1;
      // Set buffer to initial size; _ensureMiniCanvasReady will resize to actual
      // CSS layout size on the first draw tick. Do NOT pin el.style.width/height —
      // CSS (width:100%, flex:1) controls display size.
      el.width  = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      const ctx = el.getContext('2d', { alpha: false });
      if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      el._pfxCtx = ctx;
      return ctx;
    }
    _setupMiniCanvas('imfSovParade', 220, 100);
    _setupMiniCanvas('imfSovWave',   220, 100);
    _setupMiniCanvas('imfSovVector', 200, 120);
    _setupMiniCanvas('imfSovAudio',  220, 100);

    // Start the RAF loop immediately — it captures from proxy video too
    _startScopeLoop();
  }

  resizeCanvas();
  updateTopbar();
  drawIdle();

  const btnPlay  = document.getElementById('imfBtnPlay');
  const btnPrev  = document.getElementById('imfBtnPrev');
  const btnNext  = document.getElementById('imfBtnNext');
  const btnStop  = document.getElementById('imfTbStop');
  const btnRev2  = document.getElementById('imfTbRev2');
  const btnFwd2  = document.getElementById('imfTbFwd2');
  const btnLoop  = document.getElementById('imfTbLoop');
  const seek     = document.getElementById('imfSeek');
  const btnClose = document.getElementById('imfPlayerClose');
  const btnHalf  = document.getElementById('imfBtnHalf');
  const btnPerf  = document.getElementById('imfBtnPerf');

  if (btnPlay) btnPlay.onclick = () => {
    if (S.proxyMode && S.proxyVideoEl) {
      if (S.proxyVideoEl.paused || S.proxyVideoEl.ended) {
        const playAttempt = S.proxyVideoEl.play?.();
        if (playAttempt && typeof playAttempt.catch === 'function') playAttempt.catch(() => {});
      } else {
        try { S.proxyVideoEl.pause(); } catch {}
      }
      return;
    }
    if (!S.totalFrames) return;
    S.isPlaying = !S.isPlaying;
    btnPlay.textContent = S.isPlaying ? '⏸' : '▶';
    if (S.isPlaying) {
      // Prefer the realtime stream engine (one persistent ffmpeg + -lowres).
      // Fall back to the per-frame decode loop if it can't start.
      _startRealtimeStream().then((streaming) => {
        if (streaming || !S.isPlaying) return;
        // Warm-start the decode resolution from the media's dimensions so heavy
        // media (HD/UHD) plays smoothly from frame 1 rather than stuttering at
        // full-res until the reactive controller catches up. Auto/Realtime only;
        // scrub/pause stay full-res (decodeScale forces 1 when not playing).
        _setPreviewScale(_predictInitialPlaybackScale(), 'warm-start');
        S.lastTs = performance.now();
        S.playBaseTs = S.lastTs;
        S.playBaseFrame = (S.displayFrame ?? S.currentFrame);
        S.currentFrame = (S.displayFrame ?? S.currentFrame);
        S.droppedFrames = 0;
        S.lastFrameAdvance = 0;
        S.scaleRecoveryScore = 0;
        S.raf = requestAnimationFrame(playLoop);
      });
    } else {
      if (S.streamMode) _stopRealtimeStream();
      cancelAnimationFrame(S.raf);
      drawFrame();
      // Playback decoded reduced-res preview frames — refine the paused frame to full res.
      _refineCurrentFrameFullRes();
    }
  };

  if (btnPrev) btnPrev.onclick = () => {
    if (S.proxyMode && S.proxyVideoEl) {
      pausePlayer();
      S.proxyVideoEl.currentTime = Math.max(0, (S.proxyVideoEl.currentTime || 0) - (1 / Math.max(1, Number(S.proxyFps) || 24)));
      syncSeek();
      return;
    }
    if (S.totalFrames) { pausePlayer(); seekTo(S.currentFrame - 1); }
  };
  if (btnNext) btnNext.onclick = () => {
    if (S.proxyMode && S.proxyVideoEl) {
      pausePlayer();
      S.proxyVideoEl.currentTime = Math.max(0, (S.proxyVideoEl.currentTime || 0) + (1 / Math.max(1, Number(S.proxyFps) || 24)));
      syncSeek();
      return;
    }
    if (S.totalFrames) { pausePlayer(); seekTo(S.currentFrame + 1); }
  };

  if (btnStop) btnStop.onclick = () => {
    pausePlayer();
    if (S.proxyMode && S.proxyVideoEl) {
      try { S.proxyVideoEl.pause(); } catch {}
      S.proxyVideoEl.currentTime = 0;
      syncSeek();
      return;
    }
    if (S.totalFrames) seekTo(0);
    drawFrame();
  };

  if (btnRev2) btnRev2.onclick = () => {
    const step = Math.max(1, Math.round(S.fps || 24));
    pausePlayer();
    if (S.proxyMode && S.proxyVideoEl) {
      S.proxyVideoEl.currentTime = Math.max(0, (S.proxyVideoEl.currentTime || 0) - 1);
      syncSeek();
      return;
    }
    if (S.totalFrames) seekTo(S.currentFrame - step);
  };

  if (btnFwd2) btnFwd2.onclick = () => {
    const step = Math.max(1, Math.round(S.fps || 24));
    pausePlayer();
    if (S.proxyMode && S.proxyVideoEl) {
      const dur = Number.isFinite(S.proxyVideoEl.duration) ? S.proxyVideoEl.duration : Number.POSITIVE_INFINITY;
      S.proxyVideoEl.currentTime = Math.min(dur, (S.proxyVideoEl.currentTime || 0) + 1);
      syncSeek();
      return;
    }
    if (S.totalFrames) seekTo(S.currentFrame + step);
  };

  if (btnLoop) btnLoop.onclick = () => {
    S.loop = !S.loop;
    btnLoop.classList.toggle('is-active', !!S.loop);
    btnLoop.setAttribute('aria-pressed', S.loop ? 'true' : 'false');
    if (S.proxyMode && S.proxyVideoEl) {
      try { S.proxyVideoEl.loop = !!S.loop; } catch {}
    }
  };

  if (btnHalf) btnHalf.onclick = () => {
    if (S.previewScale >= 1) _setPreviewScale(0.5, 'manual');
    else if (S.previewScale > 0.25) _setPreviewScale(0.25, 'manual');
    else _setPreviewScale(1, 'manual');
    _clearFrameByteCache();
    updatePlaybackButtons();
    if (S.mxfFile && S.totalFrames) {
      seekTo(S.displayFrame ?? S.currentFrame);
    } else if (!S.mxfFile && S.totalFrames) {
      // Companion mode: fire a fresh thumbnail request at the new scale size
      document.dispatchEvent(new CustomEvent('imf:companion-thumb-refresh', {
        detail: { frame: S.displayFrame ?? S.currentFrame ?? 0 }
      }));
    } else {
      drawIdle();
    }
  };
  if (btnPerf) btnPerf.onclick = () => {
    _cyclePlaybackMode();
    _clearFrameByteCache();
  };
  updatePlaybackButtons();

  const btnHdrSdr = document.getElementById('imfBtnHdrSdr');
  if (btnHdrSdr) btnHdrSdr.onclick = () => playerSetPreviewMode();
  const btnViewTrim = document.getElementById('imfViewTrimBtn');
  if (btnViewTrim) btnViewTrim.onclick = () => playerToggleTrim();

  // ── Reel navigation buttons ───────────────────────────────────────────────
  // These dispatch to imf_ui.js via a custom event; imf_ui.js owns the reel list.
  const btnReelPrev = document.getElementById('imfBtnReelPrev');
  const btnReelNext = document.getElementById('imfBtnReelNext');
  if (btnReelPrev) btnReelPrev.onclick = () => document.dispatchEvent(new CustomEvent('imf:reel-nav', { detail: { dir: -1 } }));
  if (btnReelNext) btnReelNext.onclick = () => document.dispatchEvent(new CustomEvent('imf:reel-nav', { detail: { dir:  1 } }));

  // ── Timecode entry (click TC display to edit) ─────────────────────────────
  const tcGroup = document.getElementById('imfTCGroup');
  const tcDisplay = document.getElementById('imfTC');
  const tcInput   = document.getElementById('imfTCInput');
  if (tcGroup && tcDisplay && tcInput) {
    const _openTCInput = () => {
      if (!S.totalFrames) return;
      tcDisplay.style.display = 'none';
      tcInput.style.display   = '';
      const tcTL = document.getElementById('imfTCTL');
      if (tcTL) tcTL.style.display = 'none';
      tcInput.value = tcDisplay.textContent.trim() === '–:––:––:––' ? '00:00:00:00' : tcDisplay.textContent.trim();
      tcInput.focus();
      tcInput.select();
    };
    const _closeTCInput = (commit) => {
      tcDisplay.style.display = '';
      tcInput.style.display   = 'none';
      const tcTL = document.getElementById('imfTCTL');
      if (tcTL) tcTL.style.display = '';
      if (!commit) return;
      // Parse HH:MM:SS:FF or HH:MM:SS;FF
      const raw = tcInput.value.trim().replace(/[;,]/g, ':');
      const parts = raw.split(':').map(Number);
      if (parts.length === 4) {
        const [h, m, sec, fr] = parts;
        const fps = S.fps || 24;
        const targetFrame = ((h * 3600 + m * 60 + sec) * fps + fr) | 0;
        pausePlayer();
        seekTo(Math.max(0, Math.min(targetFrame, S.totalFrames - 1)));
      }
    };
    tcGroup.addEventListener('click', (e) => {
      if (tcInput.style.display !== 'none' && tcInput.style.display !== '') return; // already open
      _openTCInput();
    });
    tcInput.addEventListener('blur',    () => _closeTCInput(false));
    tcInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); _closeTCInput(true); }
      if (e.key === 'Escape'){ e.preventDefault(); _closeTCInput(false); }
    });
    // Auto-format while typing: insert colons
    tcInput.addEventListener('input', () => {
      let v = tcInput.value.replace(/[^0-9]/g, '');
      if (v.length > 8) v = v.slice(0, 8);
      const parts = [];
      if (v.length > 6) parts.push(v.slice(0,2), v.slice(2,4), v.slice(4,6), v.slice(6,8));
      else if (v.length > 4) parts.push(v.slice(0,2), v.slice(2,4), v.slice(4,6));
      else if (v.length > 2) parts.push(v.slice(0,2), v.slice(2,4));
      else parts.push(v);
      tcInput.value = parts.join(':');
    });
  }

  if (seek) seek.oninput = () => {
    const cplFrames = parseInt(seek.dataset.cplFrames, 10) || 0;
    let rawValue = parseInt(seek.value, 10) || 0;
    // In absolute (CPL) mode convert to reel-relative frame before seeking.
    const nextFrame = (cplFrames > S.totalFrames)
      ? Math.max(0, Math.min(rawValue - (S.tcOffset || 0), S.totalFrames - 1))
      : rawValue;
    if (S.proxyMode && S.proxyVideoEl) {
      try { S.proxyVideoEl.pause(); } catch {}
      S.proxyVideoEl.currentTime = Math.max(0, nextFrame / Math.max(1, Number(S.proxyFps) || 24));
      syncSeek();
      return;
    }
    pausePlayer();
    seekTo(nextFrame);
  };

  if (btnClose) btnClose.onclick = () => {
    pausePlayer();
    S.totalFrames = 0;
    S.currentFrame = 0;
    S.inflightFrame = null;
  S.playBaseTs = 0;
  S.decodeAvgMs = 0;
  S.playbackStride = 1;
  S.previewScale = 1;
  S.playbackMode = 'auto';
  S.droppedFrames = 0;
  S.lastFrameAdvance = 0;
  S.lastAdaptiveTs = 0;
  S.scaleRecoveryScore = 0;
    S.mxfFile = null;
    S.mxfIndex = null;
    S.frameBytes = null;
    S.frameJ2K = null;
    S.frameBitmap = null;
    S.frameImageData = null;
    S.frameSurface = null;
    S.displayFrame = null;
    S.framePixels = null;
    S.framePixW = 0;
    S.framePixH = 0;
    _clearFrameCache();
    _clearFrameByteCache();
    updateTopbar();
    resizeCanvas();
    syncSeek();
    drawIdle();
    drawScope();
    updatePlaybackButtons();
    if (btnClose) btnClose.style.display = 'none';
  };

  // Keyboard shortcuts (NLE-style basics)
  document.addEventListener('keydown', e => {
    if (!S.totalFrames) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (e.key === ' ') { e.preventDefault(); btnPlay?.click(); return; }
    if (e.key === 'k' || e.key === 'K') { e.preventDefault(); pausePlayer(); drawFrame(); return; }
    if (e.key === 'ArrowLeft'  || e.key === 'j' || e.key === 'J') { e.preventDefault(); pausePlayer(); seekTo(S.currentFrame - (e.shiftKey ? Math.max(1, Math.round(S.fps)) : 1)); return; }
    if (e.key === 'ArrowRight') { e.preventDefault(); pausePlayer(); seekTo(S.currentFrame + (e.shiftKey ? Math.max(1, Math.round(S.fps)) : 1)); return; }
    if (e.key === 'l' || e.key === 'L') { e.preventDefault(); if (!e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { if (!S.isPlaying) btnPlay?.click(); } else { pausePlayer(); seekTo(S.currentFrame + Math.max(1, Math.round(S.fps))); } return; }
    if (e.key === 'Home') { e.preventDefault(); pausePlayer(); seekTo(0); return; }
    if (e.key === 'End')  { e.preventDefault(); pausePlayer(); seekTo(S.totalFrames - 1); return; }
    if (e.key === 'm' || e.key === 'M') { e.preventDefault(); _cyclePlaybackMode(); return; }
    if (e.key === 'h' || e.key === 'H') { e.preventDefault(); S.showRtHud = !S.showRtHud; drawFrame(); return; }
    if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      S.decodeInfo.show = !S.decodeInfo.show;
      // Lazy-fetch system diagnostics the first time the panel opens
      if (S.decodeInfo.show && !S.decodeInfo.sysDiag && typeof window.pfxPlatform?.imf?.diagnostics === 'function') {
        window.pfxPlatform.imf.diagnostics().then(d => { S.decodeInfo.sysDiag = d; drawFrame(); }).catch(() => {});
      }
      drawFrame();
      return;
    }
  });

  // Canvas click: handle "Copy Decode Diagnostic" button hit-test
  S.canvas.addEventListener('click', (e) => {
    const rect = S.canvas.getBoundingClientRect();
    const scaleX = S.canvas.width  / rect.width;
    const scaleY = S.canvas.height / rect.height;
    const cx = (e.clientX - rect.left) * scaleX;
    const cy = (e.clientY - rect.top)  * scaleY;
    const b  = S._decodeInfoBtnRect;
    if (b && cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
      const di  = S.decodeInfo;
      const la  = di.lastAttempt;
      const diag = {
        timestamp:       new Date().toISOString(),
        frame:           S.currentFrame,
        mxfFrame:        (S.entryPoint || 0) + S.currentFrame,
        entryPoint:      S.entryPoint || 0,
        intrinsicDuration: S.intrinsicDuration || null,
        mxfPath:         S.mxfPath || null,
        cplId:           S.cplId   || null,
        packageHash:     S.packageHash || null,
        codec:           S.codec   || null,
        resolution:      S.resolution || null,
        previewStatus:   { ...S.previewStatus },
        lastAttempt:     la || null,
        failedFrames:    di.failedFrames,
        blackFrames:     di.blackFrames,
        electronResults: (di.electronResults || []).slice(0, 5),
        sysDiag:         di.sysDiag || null,
      };
      navigator.clipboard?.writeText(JSON.stringify(diag, null, 2))
        .then(() => console.log('[IMF] Decode diagnostic copied to clipboard'))
        .catch(err => console.warn('[IMF] Clipboard write failed:', err));
    }
  });

  // ── Compare split-divider drag (Sprint 5 #3) ────────────────────────────────
  // Drag the divider to wipe the split. Only grabs within 14px of the divider so
  // it never swallows clicks elsewhere (e.g. the decode-diagnostic button above).
  let _splitDragging = false;
  const _splitFracFromEvent = (e) => {
    const r = S._compareRect;
    if (!r || !r.dw) return null;
    const rect = S.canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (S.canvas.width / rect.width);
    return Math.min(1, Math.max(0, (cx - r.dx) / r.dw));
  };
  const _nearDivider = (e) => {
    const r = S._compareRect;
    if (!r || !r.dw) return false;
    const rect = S.canvas.getBoundingClientRect();
    const cx = (e.clientX - rect.left) * (S.canvas.width / rect.width);
    return Math.abs(cx - (r.dx + r.dw * S.compareSplit)) <= 14;
  };
  S.canvas.addEventListener('pointerdown', (e) => {
    if (!S.compareEnabled || S.compareMode !== 'split' || !S.compareBitmap) return;
    if (!_nearDivider(e)) return;
    _splitDragging = true;
    S.canvas.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  });
  S.canvas.addEventListener('pointermove', (e) => {
    if (_splitDragging) {
      const f = _splitFracFromEvent(e);
      if (f != null) { S.compareSplit = f; drawFrame(); }
      return;
    }
    // Hover affordance: show the resize cursor only near the divider.
    if (S.compareEnabled && S.compareMode === 'split' && S.compareBitmap) {
      S.canvas.style.cursor = _nearDivider(e) ? 'ew-resize' : '';
    } else if (S.canvas.style.cursor === 'ew-resize') {
      S.canvas.style.cursor = '';
    }
  });
  const _endSplitDrag = (e) => {
    if (!_splitDragging) return;
    _splitDragging = false;
    try { S.canvas.releasePointerCapture?.(e.pointerId); } catch {}
  };
  S.canvas.addEventListener('pointerup', _endSplitDrag);
  S.canvas.addEventListener('pointercancel', _endSplitDrag);

  const ro = new ResizeObserver(() => {
    resizeCanvas();
    if (S.totalFrames > 0) drawFrame(); else drawIdle();
    debugIMFLayout();
  });
  ro.observe(S.canvas);

  // Initial layout report (after first paint)
  requestAnimationFrame(debugIMFLayout);
}

// ── Layout debug — enable with `window.PFX_DEBUG_IMF_LAYOUT = true` ──────────────
// Logs the live geometry of the IMF Validation workspace zones so the
// viewer/scopes (upper) vs. transport/timeline (bottom) split can be verified.
function debugIMFLayout() {
  if (!window.PFX_DEBUG_IMF_LAYOUT) return;
  const h = (el) => (el ? Math.round(el.getBoundingClientRect().height) : null);
  const wh = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return `${Math.round(r.width)}×${Math.round(r.height)}`;
  };
  const workspace = document.querySelector('#main-imf .imf-col-main');
  const upperRow  = document.querySelector('#main-imf .imf-player');
  const bottom    = document.querySelector('#main-imf .imf-tl-section');
  const stage     = document.getElementById('imfViewerStage');
  const scopes    = document.getElementById('imfScopePanel');
  const tlBody     = document.querySelector('#main-imf .imf-tl-body');
  // "Visible" = bottom panel is laid out and within the workspace bounds.
  let tlVisible = false;
  if (workspace && bottom) {
    const wsRect = workspace.getBoundingClientRect();
    const blRect = bottom.getBoundingClientRect();
    tlVisible = blRect.height > 0 && blRect.bottom <= Math.ceil(wsRect.bottom) + 1 && blRect.top >= wsRect.top - 1;
  }
  const wsH = h(workspace), upH = h(upperRow), blH = h(bottom);
  const overflow = (wsH != null && upH != null && blH != null) ? (upH + blH - wsH) : null;
  console.log('[PFX Layout] workspace height', wsH);
  console.log('[PFX Layout] upper row height', upH);
  console.log('[PFX Layout] bottom panel height', blH, '(timeline body', h(tlBody), 'px)');
  console.log('[PFX Layout] viewer stage size', wh(stage));
  console.log('[PFX Layout] scopes size', wh(scopes));
  console.log('[PFX Layout] timeline visible', tlVisible);
  if (overflow != null && overflow > 1) {
    console.warn('[PFX Layout] OVERFLOW: upper + bottom exceeds workspace by', overflow, 'px');
  }
}

function updateTopbar() {
  const badge = document.getElementById('imfPlayerReelBadge');
  const meta  = document.getElementById('imfPlayerMeta');
  const proxyState = _getProxyFrameState();
  if (badge) {
    if (proxyState && proxyState.totalFrames > 0) {
      badge.textContent = 'PROXY';
      badge.style.color = '#7be0ff';
      badge.style.background = 'rgba(123,224,255,.12)';
      badge.style.borderColor = 'rgba(123,224,255,.34)';
    } else if (S.totalFrames > 0) {
      badge.textContent = `REEL ${S.reelNum}`;
      badge.style.color = S.color;
      badge.style.background = `${S.color}18`;
      badge.style.borderColor = `${S.color}44`;
    } else {
      badge.textContent = 'NO REEL LOADED';
      badge.style.color = '';
      badge.style.background = '';
      badge.style.borderColor = '';
    }
  }
  if (meta) {
    if (proxyState && proxyState.totalFrames > 0) {
      const parts = [S.proxyLabel || 'Rec.709 Proxy'];
      const videoWidth = Number(S.proxyVideoEl?.videoWidth) || 0;
      const videoHeight = Number(S.proxyVideoEl?.videoHeight) || 0;
      if (videoWidth > 0 && videoHeight > 0) parts.push(`${videoWidth}×${videoHeight}`);
      parts.push(`${fmtDuration(proxyState.totalFrames / proxyState.fps)}`);
      meta.textContent = parts.join('  ·  ');
    } else if (S.totalFrames > 0) {
      const parts = [];
      if (S.codec && S.codec !== '–') parts.push(S.codec);
      if (S.resolution && S.resolution !== '–') parts.push(S.resolution);
      if (S.filename) parts.push(S.filename.split('/').pop());
      parts.push(`MODE ${_playbackModeLabel()}`);
      parts.push(_previewLabel());
      const lanes = _decoderLaneCount();
      if (lanes > 1) parts.push(`LANE ${lanes}`);
      if (S.decodeAvgMs > 0) parts.push(`DEC ${Math.round(S.decodeAvgMs)}ms`);
      meta.textContent = parts.join('  ·  ');
    } else {
      meta.textContent = 'Click a reel in the table or timeline to preview';
    }
    // Full metadata on hover (the compact overlay may ellipsis-truncate it)
    const badgeTxt = badge ? badge.textContent : '';
    meta.title = (badgeTxt ? badgeTxt + '  ·  ' : '') + meta.textContent;
  }
  const btnClose = document.getElementById('imfPlayerClose');
  const btnHalf  = document.getElementById('imfBtnHalf');
  const btnPerf  = document.getElementById('imfBtnPerf');
  if (btnClose) btnClose.style.display = ((proxyState?.totalFrames || 0) > 0 || S.totalFrames > 0) ? '' : 'none';

  _updateHdrButton();
  _updateQCDetails();
  _updateSmartEngineBadge();
}

function _updateSmartEngineBadge() {
  const el = document.getElementById('imfSmartEngineBadge');
  if (!el) return;
  const proxyState = _getProxyFrameState();
  if (proxyState && proxyState.totalFrames > 0) {
    el.textContent = 'Engine: Browser  ·  Codec: H.264 Proxy  ·  Mode: Proxy';
    el.style.display = '';
    return;
  }
  if (S.totalFrames <= 0) { el.style.display = 'none'; return; }

  const engineId = S.lastDecodeBackend || 'imf';
  const ENGINE_DISPLAY = {
    'ffmpeg-imf':  'FFmpeg IMF',
    'ffmpeg-mxf':  'FFmpeg MXF',
    'ffmpeg':      'FFmpeg',
    'imf':         'IMF Engine',
    'avfoundation':'AVFoundation',
    'resolve':     'Resolve',
    'ojph':        'OpenJPH',
    'renderer-j2k':'JS WASM J2K',
    'renderer-htj2k':'JS WASM HTJ2K',
  };
  const engineLabel = ENGINE_DISPLAY[engineId] || engineId;
  const codec       = S.codec && S.codec !== '–' ? S.codec : 'J2K/HTJ2K';
  const modeLabel   = S.playbackMode === 'proxy' ? 'Proxy Mode' : 'Frame Server';
  el.textContent = `Engine: ${engineLabel}  ·  Codec: ${codec}  ·  Mode: ${modeLabel}`;
  el.style.display = '';
}

// ── QC Details cards (bottom workspace zone) ────────────────────────────────────
function _qcEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function _qcKV(rows) {
  return rows.map(([k, v]) =>
    `<div class="imf-qc-kv"><span class="imf-qc-k">${_qcEsc(k)}</span>` +
    `<span class="imf-qc-v" title="${_qcEsc(v)}">${_qcEsc(v)}</span></div>`).join('');
}
function _updateQCDetails() {
  // Card 1 — Selected Item (live from current reel/proxy player state)
  const selBody  = document.getElementById('imfQCSelBody');
  const selBadge = document.getElementById('imfQCSelBadge');
  if (selBody) {
    const ps = _getProxyFrameState();
    const isProxy = !!(ps && ps.totalFrames > 0);
    const loaded  = isProxy || S.totalFrames > 0;
    if (!loaded) {
      selBody.innerHTML = '<div class="imf-qc-empty">Select a timeline segment, scope alert, or validation check.</div>';
      if (selBadge) selBadge.style.display = 'none';
    } else {
      const fps   = isProxy ? ps.fps : S.fps;
      const total = isProxy ? ps.totalFrames : S.totalFrames;
      const cur   = isProxy ? ps.currentFrame : S.currentFrame;
      const off   = S.tcOffset || 0;
      const asset = S.filename ? S.filename.split('/').pop() : '—';
      const color = [S.transfer, S.primaries].filter(v => v && v !== '–').join(' · ') || '—';
      selBody.innerHTML = _qcKV([
        ['Source',     isProxy ? 'PROXY (Rec.709)' : `REEL ${S.reelNum}`],
        ['Codec',      (S.codec && S.codec !== '–') ? S.codec : (isProxy ? 'H.264' : '—')],
        ['Resolution', (S.resolution && S.resolution !== '–') ? S.resolution : '—'],
        ['Color',      color],
        ['Timecode',   fmtTC(off + cur, fps, isProxy ? undefined : _tcOpts())],
        ['Range',      `${fmtTC(off, fps, isProxy ? undefined : _tcOpts())} → ${fmtTC(off + Math.max(0, total - 1), fps, isProxy ? undefined : _tcOpts())}`],
        ['Frames',     `${(cur + 1).toLocaleString()} / ${total.toLocaleString()}`],
        ['Asset',      asset],
      ]);
      if (selBadge) {
        selBadge.style.display = '';
        selBadge.textContent = isProxy ? 'PROXY' : 'IMF';
        selBadge.className = 'imf-qc-badge' + (isProxy ? ' imf-qc-badge-ready' : '');
      }
    }
  }

  // Card 2 — Validation Context (mirror the left-panel summary chips)
  const valBody = document.getElementById('imfQCValBody');
  if (valBody) {
    const summary = document.getElementById('imfValSummary');
    if (summary && summary.children.length) {
      valBody.innerHTML =
        `<div class="imf-qc-chips">${summary.innerHTML}</div>` +
        `<div class="imf-qc-note">Open a check in the left VALIDATION list for full detail.</div>`;
    } else {
      valBody.innerHTML = '<div class="imf-qc-empty">No validation summary yet — load a package.</div>';
    }
  }

  // Card 3 — Metadata & Notes (package/timeline info + DV/IAB state)
  const metaBody = document.getElementById('imfQCMetaBody');
  if (metaBody) {
    const tlInfo  = document.getElementById('imfTLInfo');
    const pkgTxt  = tlInfo ? tlInfo.textContent.replace(/\s+/g, ' ').trim() : '';
    const doviEl  = document.getElementById('imfDoviPanel');
    const dvShown = !!(doviEl && doviEl.style.display !== 'none');
    const iabRow  = document.getElementById('imfTLAudio');
    const iabHas  = !!(iabRow && iabRow.children.length);
    const rows = [];
    if (pkgTxt) rows.push(['Package', pkgTxt]);
    rows.push(['DV metadata', dvShown ? 'Present (Dolby Vision)' : 'None detected']);
    rows.push(['IAB audio', iabHas ? 'Track present' : '—']);
    metaBody.innerHTML = rows.length
      ? _qcKV(rows) + '<div class="imf-qc-note">No QC notes for this item.</div>'
      : '<div class="imf-qc-empty">Package metadata appears here once a CPL is loaded.</div>';
  }
}

function pausePlayer() {
  if (S.proxyMode && S.proxyVideoEl) {
    try { S.proxyVideoEl.pause(); } catch {}
    const btn = document.getElementById('imfBtnPlay');
    if (btn) btn.textContent = '▶';
    syncSeek();
    return;
  }
  if (S.isPlaying) {
    S.isPlaying = false;
    if (S.streamMode) _stopRealtimeStream();
    cancelAnimationFrame(S.raf);
    _audStop();
    S.playBaseTs = 0;
    const btn = document.getElementById('imfBtnPlay');
    if (btn) btn.textContent = '▶';
    _emitPlayerState();
  }
}

export function playerSeekToFrame(frame, options = {}) {
  if (!S.totalFrames) return;
  if (options.pause !== false) pausePlayer();
  seekTo(Math.max(0, Math.min(frame | 0, Math.max(0, S.totalFrames - 1))));
}

export function playerGetState() {
  const proxyState = _getProxyFrameState();
  if (proxyState) {
    return {
      reelNum: proxyState.reelNum,
      currentFrame: proxyState.localFrame,
      absFrame: proxyState.absFrame,
      totalFrames: proxyState.totalFrames,
      fps: proxyState.fps,
      tcOffset: proxyState.tcOffset,
      isPlaying: proxyState.isPlaying,
    };
  }
  return {
    reelNum: S.reelNum,
    currentFrame: S.currentFrame,
    absFrame: (S.tcOffset || 0) + (S.currentFrame || 0),
    totalFrames: S.totalFrames,
    fps: S.fps,
    tcOffset: S.tcOffset || 0,
    isPlaying: !!S.isPlaying,
  };
}

// ── Companion preview thumbnail ────────────────────────────────────────────────
// Stored separately from S.frameBitmap so it survives reel changes when no
// MXF file is directly accessible (companion mode without direct file decode).
let _companionPreviewBitmap = null;
let _companionPreviewReelKey = ''; // CPL_ID:reelAbsStart to avoid redundant fetches

export function playerSetCompanionThumb(bitmap, reelKey = '') {
  if (_companionPreviewBitmap && _companionPreviewBitmap !== bitmap) {
    try { _companionPreviewBitmap.close?.(); } catch {}
  }
  _companionPreviewBitmap = bitmap;
  _companionPreviewReelKey = reelKey;
  // Set as the active display bitmap so drawFrame() renders it immediately
  if (!S.mxfFile && S.totalFrames > 0) {
    S.frameBitmap  = bitmap;
    S.frameImageData = null;
    S.frameSurface = null;
    S.displayFrame = S.currentFrame;
    drawFrame();
    drawScope();
  }
}

export function playerGetCompanionThumbKey() { return _companionPreviewReelKey; }

export function playerClearCompanionThumb() {
  try { _companionPreviewBitmap?.close?.(); } catch {}
  _companionPreviewBitmap = null;
  _companionPreviewReelKey = '';
  if (!S.mxfFile) {
    S.frameBitmap = null;
    S.displayFrame = null;
  }
}

export function playerLoadReel(file, reelInfo = {}) {
  pausePlayer();

  S.loadSeq++;       // invalidate any in-flight frame loads
  S.streamStallFallback = false;   // let a fresh media retry the realtime stream
  const mySeq = S.loadSeq;

  // In companion mode the path-based main-process backend decodes (cplPath/mxfPath).
  // The browser `file` handed in for a package is typically NOT a readable Blob —
  // scanning it throws "Cannot read MXF header" in a tight loop (which also makes
  // the timeline blink). So only treat `file` as a real browser File in pure-web
  // mode; in companion mode null it and let the backend decode by path.
  const _companion = !!(reelInfo.cplPath || reelInfo.mxfPath) &&
    typeof window.pfxPlatform?.imf?.requestFrame === 'function';
  S.mxfFile      = _companion ? null : file;
  S.mxfIndex     = null;
  S.frameBytes   = null;
  S.frameJ2K     = null;
  S.frameBitmap  = null;
  S.framePixels  = null;
  S.framePixW    = 0;
  S.framePixH    = 0;
  S.previewStatus = { status: 'PLACEHOLDER_ONLY', engine: null, diagnostic: 'No decoded frame yet', canRunScopes: false };
  _clearFrameCache();

  // When loading without a direct file, restore the companion preview if available
  if (!S.mxfFile && _companionPreviewBitmap) {
    S.frameBitmap  = _companionPreviewBitmap;
    S.frameImageData = null;
    S.frameSurface = null;
  }
  _clearFrameByteCache();
  S.mxfScanning  = false;
  S.scanPct      = 0;
  S.reelNum          = reelInfo.reelNum          || 1;
  S.totalFrames      = reelInfo.totalFrames      || 0;
  S.fps              = reelInfo.fps              || 24;
  S.frameInterval    = 1000 / S.fps;
  S.tcOffset         = reelInfo.tcOffset         || 0;
  S.dropFrame        = !!reelInfo.dropFrame;      // CPL CompositionTimecode drop-frame flag
  S.tcStart          = reelInfo.tcStart          || 0;
  S.color            = reelInfo.color            || '#7c6af7';
  S.filename         = reelInfo.filename         || '';
  S.codec            = reelInfo.codec            || '–';
  S.resolution       = reelInfo.resolution       || '–';
  S.transfer         = reelInfo.transfer         || '–';
  S.primaries        = reelInfo.primaries        || '–';
  S.entryPoint       = reelInfo.entryPoint       || 0;
  S.intrinsicDuration= reelInfo.intrinsicDuration|| reelInfo.totalFrames || 0;
  S.mxfPath          = reelInfo.mxfPath          || '';
  // Electron 42+ removed the non-standard file.path property; if mxfPath is still empty,
  // derive it from the stored File object via webUtils.getPathForFile (exposed in preload).
  if (!S.mxfPath && S.mxfFile && typeof window.pfxPlatform?.getNativeFilePath === 'function') {
    S.mxfPath = window.pfxPlatform.getNativeFilePath(S.mxfFile) || '';
  }
  S.cplPath          = reelInfo.cplPath          || '';
  S.assetMaps        = Array.isArray(reelInfo.assetMaps) ? reelInfo.assetMaps : [];
  S.cplId            = reelInfo.cplId            || '';
  S.packageHash      = reelInfo.packageHash      || '';
  S.decodeInfo = { show: S.decodeInfo?.show || false, lastAttempt: null, failedFrames: 0, blackFrames: 0, electronResults: [], sysDiag: S.decodeInfo?.sysDiag || null };

  // ── Audio: load this reel's PCM track in sync with the video clock ──────────
  _audInit();
  _audLoadReel(S.mxfPath, S.fps, S.tcOffset);

  const initialFrame = Math.max(0, Math.min((reelInfo.initialFrame | 0) || 0, Math.max(0, (reelInfo.totalFrames || 0) - 1)));
  const autoPlay = !!reelInfo.autoPlay;
  S.currentFrame = initialFrame;
  S.decodeAvgMs  = 0;
  S.lastAdaptiveTs = 0;
  S.scaleRecoveryScore = 0;
  S.droppedFrames = 0;
  S.lastFrameAdvance = 0;

  const seek = document.getElementById('imfSeek');
  if (seek) {
    const cplFrames = parseInt(seek.dataset.cplFrames, 10) || 0;
    seek.min = 0;
    seek.max = cplFrames > S.totalFrames ? cplFrames - 1 : Math.max(0, S.totalFrames - 1);
    seek.value = cplFrames > S.totalFrames ? (S.tcOffset || 0) + initialFrame : initialFrame;
  }

  updateTopbar();
  resizeCanvas();
  syncSeek();
  drawFrame();
  drawScope();

  if (!S.mxfFile && !S.mxfPath && !S.cplPath) {
    return;
  }

  // Pure-web mode only: a readable browser File → scan it for the MXF index and
  // decode via WASM. In companion mode S.mxfFile is null (set above), so this is
  // skipped and the path-based backend decodes instead.
  if (S.mxfFile) {
    _prewarmJ2KDecoders().then(() => updateTopbar()).catch(() => {});
    // Async: scan MXF index then load first frame
    S.mxfScanning = true;
    scanMXF(file, (phase, pct) => {
      if (mySeq !== S.loadSeq) return;
      S.scanPct = pct;
      if (pct < 100) drawScanProgress(pct, phase);
    }).then(idx => {
      if (mySeq !== S.loadSeq) return;
      S.mxfScanning = false;
      S.mxfIndex = idx;
      if (S.totalFrames > 0) {
        S.mxfIndex.expectedFrameCount = S.totalFrames;
      }

      // Use frame count from index if not provided by reelInfo
      if (idx.frameCount > 0 && S.totalFrames === 0) {
        S.totalFrames = idx.frameCount;
        const seekEl = document.getElementById('imfSeek');
        if (seekEl) seekEl.max = S.totalFrames - 1;
        updateTopbar();
        syncSeek();
      }

      drawFrame();
      // Load initial frame bytes
      _loadFrameBytes(initialFrame, mySeq);

      // Smart poster frame: if starting at frame 0 and the Electron backend is
      // available, asynchronously find a non-black representative frame and seek
      // to it so the viewer opens on real content rather than a black or slate frame.
      if (initialFrame === 0 && !autoPlay && S.mxfPath && S.totalFrames > 1 &&
          typeof window.pfxPlatform?.imf?.posterFrame === 'function') {
        window.pfxPlatform.imf.posterFrame({
          mxfPath:     S.mxfPath,
          totalFrames: S.totalFrames,
          entryPoint:  S.entryPoint  || 0,
          packageHash: S.packageHash || 'unknown',
          cplId:       S.cplId       || 'unknown',
          displayMode: S.previewMode || 'sdr',
        }).then(result => {
          if (!result?.ok) return;
          // Only apply if this reel is still loaded and frame 0 hasn't decoded yet
          if (mySeq !== S.loadSeq) return;
          const posterFrame = result.frame || 0;
          if (posterFrame === 0) return; // already at intended position
          if (S.frameBitmap || S.frameImageData) return; // already decoded a frame
          console.log(`[IMF] Poster frame: reel ${posterFrame} (luma: ${result.lumaClass || '?'})`);
          seekTo(posterFrame);
        }).catch(() => {});
      }

      if (autoPlay) {
        S.isPlaying = true;
        const btn = document.getElementById('imfBtnPlay');
        if (btn) btn.textContent = '⏸';
        S.lastTs = performance.now();
        S.playBaseTs = S.lastTs;
        S.playBaseFrame = (S.displayFrame ?? S.currentFrame);
        S.raf = requestAnimationFrame(playLoop);
        _audPlay(initialFrame);
      }

      if (idx.error) console.warn('[IMF] scanMXF error:', idx.error);
      else console.log(`[IMF] MXF index ready: ${idx.frameCount} frames, ${idx.editUnitByteCount > 0 ? 'CBR' : 'VBR'}`);
    }).catch(e => {
      if (mySeq !== S.loadSeq) return;
      S.mxfScanning = false;
      console.warn('[IMF] scanMXF failed:', e);
      drawFrame();
    });
  } else {
    // Path-only mode: no browser File handle — Electron backend decodes via mxfPath
    S.mxfScanning = false;
    _loadFrameBytes(initialFrame, mySeq);
    if (initialFrame === 0 && !autoPlay && S.totalFrames > 1 &&
        typeof window.pfxPlatform?.imf?.posterFrame === 'function') {
      window.pfxPlatform.imf.posterFrame({
        mxfPath:     S.mxfPath,
        totalFrames: S.totalFrames,
        entryPoint:  S.entryPoint  || 0,
        packageHash: S.packageHash || 'unknown',
        cplId:       S.cplId       || 'unknown',
        displayMode: S.previewMode || 'sdr',
      }).then(result => {
        if (!result?.ok || mySeq !== S.loadSeq) return;
        const posterFrame = result.frame || 0;
        if (posterFrame === 0 || S.frameBitmap || S.frameImageData) return;
        console.log(`[IMF] Poster frame (path-only): ${posterFrame} (luma: ${result.lumaClass || '?'})`);
        seekTo(posterFrame);
      }).catch(() => {});
    }
    if (autoPlay) {
      S.isPlaying = true;
      const btn = document.getElementById('imfBtnPlay');
      if (btn) btn.textContent = '⏸';
      S.lastTs = performance.now();
      S.playBaseTs = S.lastTs;
      S.playBaseFrame = (S.displayFrame ?? S.currentFrame);
      S.raf = requestAnimationFrame(playLoop);
      _audPlay(initialFrame);
    }
  }
}

// ── IMF Proxy Mode (Rec.709 H.264 via Native Host) ────────────────────────────
// When the native host has generated a Rec.709 H.264 proxy from the IMF CPL,
// switch the player to HTML5 <video> playback and sync Dolby Vision metadata
// to the current video timecode.

function _nominalTcFps(fps) {
  const value = Number(fps) || 24;
  if (Math.abs(value - 23.976) < 0.02) return 24;
  if (Math.abs(value - 29.97) < 0.02) return 30;
  if (Math.abs(value - 59.94) < 0.02) return 60;
  return Math.max(1, Math.round(value));
}

function _tcToFrameOffset(tc, fps) {
  const match = String(tc || '').trim().match(/^(\d{2}):(\d{2}):(\d{2})[:;](\d{2})$/);
  if (!match) return 0;
  const nominal = _nominalTcFps(fps);
  const hh = Number(match[1]) || 0;
  const mm = Number(match[2]) || 0;
  const ss = Number(match[3]) || 0;
  const ff = Number(match[4]) || 0;
  return ((((hh * 60) + mm) * 60) + ss) * nominal + ff;
}

function _proxyFrameToTC(currentTimeSec, fps, startOffset = 0) {
  const frame = Math.max(0, Math.floor((Number(currentTimeSec) || 0) * (Number(fps) || 24)));
  return fmtTC(startOffset + frame, fps);
}

function _proxyOnTimeUpdate() {
  if (!S.proxyMode || !S.proxyVideoEl) return;
  const btn = document.getElementById('imfBtnPlay');
  if (btn) btn.textContent = (!S.proxyVideoEl.paused && !S.proxyVideoEl.ended) ? '⏸' : '▶';
  updateTopbar();
  syncSeek();
  if (!S.proxyDoviMetadata) return;
  const tc    = _proxyFrameToTC(S.proxyVideoEl.currentTime, S.proxyFps, S.proxyTcOffset || 0);
  let meta    = null;
  let isStatic = false;

  if (Array.isArray(S.proxyDoviMetadata.shots)) {
    // Companion structured format: find the shot that contains current frame
    const frameNum = Math.round(S.proxyVideoEl.currentTime * S.proxyFps);
    const shot = S.proxyDoviMetadata.shots.find(s => frameNum >= s.begin && frameNum <= s.end);
    if (shot) {
      meta = {
        maxCLL:  shot.l1?.maxNits  ?? null,
        maxFALL: shot.l1?.midNits  ?? null,
        minCLL:  shot.l1?.minNits  ?? null,
        L8:      shot.l8?.[0] ? `disp${shot.l8[0].targetDisplayIndex ?? '?'}` : null,
        dvProfile: S.proxyDoviMetadata.__static?.profile ?? null,
        dvLevel:   S.proxyDoviMetadata.__static?.level   ?? null,
      };
    }
  } else {
    // Legacy per-frame dict format
    const frameMeta  = S.proxyDoviMetadata[tc];
    const staticMeta = S.proxyDoviMetadata.__static;
    meta     = frameMeta || staticMeta || null;
    isStatic = !frameMeta && !!staticMeta;
  }

  if (meta && typeof S.proxyOnDoviUpdate === 'function') {
    S.proxyOnDoviUpdate({ timecode: tc, meta, isStatic });
  }

  // Update the live SDR-trim filter for the current proxy shot (option-2).
  if (S.trimMode) _syncTrimFilter();
}

/**
 * Switch the IMF player into proxy video mode.
 * The native host must have already generated the Rec.709 proxy and DoVi JSON.
 *
 * @param {HTMLVideoElement} videoEl   - <video> element to use for playback
 * @param {string}           videoUrl  - localhost stream URL (e.g. "http://localhost:8080/proxy_output.mp4")
 * @param {string}           doviUrl   - localhost DoVi JSON URL (e.g. "http://localhost:8080/dovi_metadata.json")
 * @param {number}           [fps=24]  - frame rate for timecode computation
 * @param {function}         [onDoviUpdate] - called with { timecode, meta } on each frame
 */
export async function playerStartProxyMode(videoEl, videoUrl, doviUrl, fps = 24, onDoviUpdate = null, opts = {}) {
  // Pause any J2K canvas playback
  if (S.isPlaying) {
    S.isPlaying = false;
    if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; }
  }

  const cacheBust = Date.now().toString(36);
  const withCacheBust = (url) => {
    try {
      const u = new URL(url, window.location.href);
      u.searchParams.set('_pfx', cacheBust);
      if ((u.hostname === '127.0.0.1' || u.hostname === 'localhost') && !u.searchParams.get('token')) {
        const token = String(window.__pfxCompanionHttpToken || '').trim();
        if (token) u.searchParams.set('token', token);
      }
      return u.toString();
    } catch {
      return url;
    }
  };

  const freshVideoUrl = withCacheBust(videoUrl);
  const freshDoviUrl = withCacheBust(doviUrl);

  // Fetch DoVi metadata from the local companion HTTP server.
  // Timeout guards against a hung (not crashed) companion — crashes produce a
  // connection-refused error that fetch rejects immediately.
  let doviMetadata = {};
  try {
    const abortCtrl = new AbortController();
    const abortTimer = setTimeout(() => abortCtrl.abort(), 8000);
    const res = await fetch(freshDoviUrl, { signal: abortCtrl.signal }).finally(() => clearTimeout(abortTimer));
    doviMetadata = await res.json();
  } catch (e) {
    console.warn('[IMF] Could not fetch DoVi metadata:', e);
  }

  S.proxyMode = true;
  S.previewStatus = { status: 'PROXY_FRAME', engine: 'proxy-video', diagnostic: '', canRunScopes: true };
  S.proxyVideoEl = videoEl;
  S.proxyDoviMetadata = doviMetadata;
  S.proxyDoviUrl = freshDoviUrl;
  S.proxyFps = fps || 24;
  S.proxyOnDoviUpdate = onDoviUpdate;
  S.proxyLabel = String(opts?.title || 'Rec.709 Proxy').trim() || 'Rec.709 Proxy';
  S.proxyStartTimecode = String(opts?.startTimecode || '').trim();
  S.proxyTcOffset = _tcToFrameOffset(S.proxyStartTimecode, S.proxyFps);

  // Apply the live SDR-trim filter to the proxy video (option-2) per current state.
  S._trimShotKey = '';
  _applyProxyFilter();
  _syncTrimFilter();

  try { videoEl.pause(); } catch {}
  try { videoEl.removeAttribute('src'); } catch {}
  try { videoEl.controls = false; videoEl.removeAttribute('controls'); } catch {}
  try { videoEl.load(); } catch {}

  videoEl.removeEventListener('timeupdate', _proxyOnTimeUpdate);
  videoEl.removeEventListener('loadedmetadata', _proxyOnTimeUpdate);
  videoEl.removeEventListener('seeked', _proxyOnTimeUpdate);
  videoEl.removeEventListener('play', _proxyOnTimeUpdate);
  videoEl.removeEventListener('pause', _proxyOnTimeUpdate);
  videoEl.removeEventListener('ended', _proxyOnTimeUpdate);
  videoEl.addEventListener('timeupdate', _proxyOnTimeUpdate);
  videoEl.addEventListener('loadedmetadata', _proxyOnTimeUpdate);
  videoEl.addEventListener('seeked', _proxyOnTimeUpdate);
  videoEl.addEventListener('play', _proxyOnTimeUpdate);
  videoEl.addEventListener('pause', _proxyOnTimeUpdate);
  videoEl.addEventListener('ended', _proxyOnTimeUpdate);
  videoEl.src = freshVideoUrl;
  try { videoEl.controls = false; videoEl.removeAttribute('controls'); } catch {}
  videoEl.load();

  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      videoEl.removeEventListener('loadedmetadata', onLoaded);
      videoEl.removeEventListener('error', onError);
      resolve();
    };
    const onLoaded = () => finish();
    const onError = () => finish();
    videoEl.addEventListener('loadedmetadata', onLoaded, { once: true });
    videoEl.addEventListener('error', onError, { once: true });
    setTimeout(finish, 5000);
  });

  try {
    await videoEl.play();
  } catch (e) {
    console.warn('[IMF] Proxy video autoplay blocked:', e);
  }

  console.log('[IMF] Proxy mode active — Rec.709 H.264 proxy:', freshVideoUrl);
}

/**
 * Stop proxy mode and return to J2K canvas playback.
 */
export function playerStopProxyMode() {
  if (!S.proxyMode) return;
  if (S.proxyVideoEl) {
    S.proxyVideoEl.removeEventListener('timeupdate', _proxyOnTimeUpdate);
    S.proxyVideoEl.removeEventListener('loadedmetadata', _proxyOnTimeUpdate);
    S.proxyVideoEl.removeEventListener('seeked', _proxyOnTimeUpdate);
    S.proxyVideoEl.removeEventListener('play', _proxyOnTimeUpdate);
    S.proxyVideoEl.removeEventListener('pause', _proxyOnTimeUpdate);
    S.proxyVideoEl.removeEventListener('ended', _proxyOnTimeUpdate);
    try { S.proxyVideoEl.pause(); } catch {}
    try { S.proxyVideoEl.controls = false; S.proxyVideoEl.removeAttribute('controls'); } catch {}
    try { S.proxyVideoEl.style.filter = ''; } catch {}
    S.proxyVideoEl.src = '';
  }
  S.proxyMode = false;
  S.previewStatus = { status: 'PLACEHOLDER_ONLY', engine: null, diagnostic: 'Proxy stopped', canRunScopes: false };
  S.proxyVideoEl = null;
  S.proxyDoviMetadata = null;
  S.proxyDoviUrl = null;
  S.proxyOnDoviUpdate = null;
  S.proxyLabel = 'Rec.709 Proxy';
  S.proxyStartTimecode = '';
  S.proxyTcOffset = 0;
  // Redraw canvas to restore J2K view
  if (S.canvas) drawFrame();
  console.log('[IMF] Proxy mode stopped — reverted to J2K canvas');
}

// ── Decode Test Frame inject ───────────────────────────────────────────────────
// Called by imf_ui.js after a successful pfx:imf:decodeTestFrame IPC call.
// Forces the viewer to display the decoded PNG and clears the placeholder.
export async function playerShowTestFrame(src, meta = {}) {
  if (!src) return;
  try {
    // src may be a legacy data-URL string, or a { imageUrl?, imageDataUrl? }
    // result. Use the shared taint-safe loader so scopes keep working.
    const result = (typeof src === 'string') ? { imageDataUrl: src } : src;
    const bitmap = await _resultToBitmap(result);
    if (!bitmap) return;
    S.frameBitmap   = bitmap;
    S.displayFrame  = S.currentFrame || 0;
    S.previewStatus = {
      status:       'REAL_FRAME',
      engine:       meta.backend || 'ffmpeg-imf',
      diagnostic:   `${meta.codec || 'J2K'} · test frame · ${meta.outputPng || ''}`,
      canRunScopes: true,
    };
    drawFrame();
    if (!S.isPlaying) drawScope();
  } catch (e) {
    console.warn('[IMF] playerShowTestFrame failed to load image:', e.message);
    S.previewStatus = { status: 'ERROR', engine: 'ffmpeg-imf', diagnostic: `Failed to render test PNG: ${e.message}`, canRunScopes: false };
    drawFrame();
  }
}

// Returns S.cplPath and S.assetMaps for the decode test button in imf_ui.js
export function playerGetDecodeInputs() {
  return { cplPath: S.cplPath || '', assetMaps: S.assetMaps || [] };
}
