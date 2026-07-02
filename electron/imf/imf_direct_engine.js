'use strict';

/**
 * imf_direct_engine.js — IMF Direct Playback Engine (main process).
 *
 * Manages IMF package sessions, validates assets, and provides
 * frame-accurate preview via FFmpeg's IMF demuxer (-f imf).
 *
 * Playback pipeline:
 *   FFmpeg -f imf -assetmaps ASSETMAP.xml -i CPL.xml
 *     → MJPEG pipe → local HTTP server → renderer canvas
 *
 * Commands (dispatched by ipc.js via 'pfx:imf-engine'):
 *   openPackage      { path }                         → { ok, packageId, package }
 *   validatePackage  { packageId, cplId? }            → { ok, validation }
 *   startPlayback    { packageId, cplId, opts? }      → { ok, sessionId, streamUrl, info }
 *   controlPlayback  { sessionId, command, value? }   → { ok }
 *   stopPlayback     { sessionId }                    → { ok }
 *   getFrame         { packageId, cplId, frame, mode }→ { ok, imageDataUrl, frameInfo }
 *   getPackageInfo   { packageId }                    → { ok, package }
 *   listPackages     {}                               → { ok, packages[] }
 *   diagnostics      {}                               → { ok, ... }
 */

const fs            = require('fs');
const path          = require('path');
const http          = require('http');
const os            = require('os');
const { spawn }     = require('child_process');

// Prefer the BUNDLED ffmpeg/ffprobe (.app/Contents/Resources/bin) over Homebrew.
// Critical here: only the bundled build has the IMF demuxer (--enable-demuxer=imf
// + libxml2); Homebrew/system ffmpeg does NOT, so the -f imf stream would fail.
// ffbins.js resolves bundled → PFX_*_BIN env → Homebrew (Dev Brief P0#2).
let FFMPEG, FFPROBE;
try {
  ({ FFMPEG, FFPROBE } = require('../native/ffbins'));
} catch {
  const _resolveBin = (name, candidates) => {
    const env = process.env[`PFX_${name.toUpperCase()}_BIN`];
    if (env && fs.existsSync(env)) return env;
    for (const p of candidates) { if (fs.existsSync(p)) return p; }
    return name;
  };
  FFMPEG  = _resolveBin('ffmpeg',  ['/opt/homebrew/bin/ffmpeg',  '/usr/local/bin/ffmpeg',  '/usr/bin/ffmpeg']);
  FFPROBE = _resolveBin('ffprobe', ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe']);
}

const crypto              = require('crypto');
const { IMFPackageIndex } = require('./imf_package_index');
const nativeDecoder       = require('./imf_native_decoder');

// ── Module state ──────────────────────────────────────────────────────────────

const _packages  = new Map();   // packageId → { index: IMFPackageIndex, path }
const _sessions  = new Map();   // sessionId → PlaybackSession
const _jobs      = new Map();   // jobId → ProgressJob (long IMF passes)
let   _httpServer = null;
let   _httpPort   = 0;
let   _sessionSeq = 0;
let   _jobSeq     = 0;
let   _ffmpegAvail  = null;
let   _imfDemuxAvail = null;
let   _photonPath    = null;
let   _photonChecked = false;

// ── P1-PROGRESS: progress reporting + cooperative cancellation ─────────────────
// Long IMF passes (validation / PKL hashing / essence probe / decode warm-up) can
// run for tens of seconds on large UHD packages. A ProgressJob carries:
//   - a CancellationToken (cooperative: checked at safe points; kills any child
//     ffmpeg/hash stream in flight),
//   - a progress callback path (fraction 0..1 + stage label + message),
// so callers can drive a UI progress bar and a Cancel affordance.
//
// This is an IN-PROCESS API surfaced via route() as 'startJob' / 'jobProgress' /
// 'cancelJob' (poll-based, since the existing pfx:imf-engine IPC channel is
// request/response and cannot stream). It is additive and non-breaking: the
// legacy validatePackage(packageId, cplId) call still works unchanged.

class CancellationError extends Error {
  constructor(msg = 'cancelled') { super(msg); this.name = 'CancellationError'; this.code = 'CANCELLED'; }
}

// Cooperative cancellation token. cancel() flips the flag, runs any registered
// abort callbacks (e.g. kill a spawned ffmpeg), and resolves waiters.
class CancellationToken {
  constructor() {
    this._cancelled = false;
    this._callbacks = new Set();
  }
  get cancelled() { return this._cancelled; }
  // Register a cleanup/abort callback. If already cancelled, runs immediately.
  onCancel(fn) {
    if (typeof fn !== 'function') return () => {};
    if (this._cancelled) { try { fn(); } catch {} return () => {}; }
    this._callbacks.add(fn);
    return () => this._callbacks.delete(fn);
  }
  cancel() {
    if (this._cancelled) return;
    this._cancelled = true;
    for (const fn of this._callbacks) { try { fn(); } catch {} }
    this._callbacks.clear();
  }
  // Throw at a cooperative checkpoint. Callers wrap stages with this.
  throwIfCancelled() { if (this._cancelled) throw new CancellationError(); }
}

// A tracked long-running pass. Holds the token, the latest progress snapshot,
// and (for poll-based consumers) the terminal result once settled.
class ProgressJob {
  constructor(id, kind) {
    this.id     = id;
    this.kind   = kind;                 // 'validate' | 'warmup' | …
    this.token  = new CancellationToken();
    this.state  = 'running';            // running | done | error | cancelled
    this.progress = { fraction: 0, stage: 'init', message: '', done: false };
    this.result = null;                 // terminal payload for pollers
    this.error  = null;
    this._onProgress = new Set();        // in-process subscribers
    this.startedAt = Date.now();
  }
  // Emit a progress update. fraction is clamped to [0,1]; stage/message describe
  // the current pass. Never throws (subscriber errors are swallowed).
  emit(fraction, stage, message) {
    const f = Math.max(0, Math.min(1, Number(fraction) || 0));
    this.progress = { fraction: f, stage: stage || this.progress.stage, message: message || '', done: false };
    for (const fn of this._onProgress) { try { fn(this.progress); } catch {} }
  }
  onProgress(fn) {
    if (typeof fn !== 'function') return () => {};
    this._onProgress.add(fn);
    try { fn(this.progress); } catch {}   // fire current snapshot immediately
    return () => this._onProgress.delete(fn);
  }
  settle(state, resultOrError) {
    this.state = state;
    const done = { fraction: state === 'done' ? 1 : this.progress.fraction, stage: state, message: '', done: true };
    this.progress = done;
    if (state === 'error')     this.error  = resultOrError;
    else                       this.result = resultOrError;
    for (const fn of this._onProgress) { try { fn(this.progress); } catch {} }
    this._onProgress.clear();
  }
  snapshot() {
    return {
      id: this.id, kind: this.kind, state: this.state,
      progress: this.progress,
      result: this.result, error: this.error,
      elapsedMs: Date.now() - this.startedAt,
    };
  }
}

function _newJob(kind) {
  const id = `job-${++_jobSeq}-${Date.now().toString(36)}`;
  const job = new ProgressJob(id, kind);
  _jobs.set(id, job);
  return job;
}

// GC settled jobs after a grace period so pollers can read the terminal result.
function _reapJob(jobId, graceMs = 60000) {
  const t = setTimeout(() => { _jobs.delete(jobId); }, graceMs);
  if (t.unref) t.unref();
}

// Real-time playback instrumentation (P0-RT-PERSIST). The architectural
// invariant is: continuous play uses ONE long-lived ffmpeg (_startFFmpegStream);
// per-frame ffmpeg spawns (_extractSingleFrame) are confined to scrub/step ONLY.
// _perFrameSpawns counts single-frame spawns; _perFrameSpawnsDuringPlay counts
// any that fire while a session is 'playing' (should stay 0). Exposed via
// diagnostics() and asserted by tests-js/imfDirectEngineRealtime.test.mjs.
let   _perFrameSpawns = 0;
let   _perFrameSpawnsDuringPlay = 0;
const _rtLog = (...a) => { if (process.env.PFX_LOG_IMF_RT) console.log('[imf-rt]', ...a); };
// Bounded decode-ahead: max bytes buffered from the ffmpeg mpjpeg stream before
// we apply backpressure (pause stdout). Keeps memory bounded for UHD frames.
const _MPJPEG_BUFFER_CAP = 24 * 1024 * 1024; // ~24 MB (several UHD MJPEG frames)
// Low-water mark: once a buffer-cap pause fires, we only resume the decoder after
// the reassembly buffer has drained back below this AND no sink is still saturated.
const _MPJPEG_BUFFER_LOWATER = Math.floor(_MPJPEG_BUFFER_CAP / 2); // ~12 MB
// Safety net: if 'drain' never fires (slow/half-open socket) re-check periodically
// so a buffer-cap pause can never wedge playback forever.
const _RESUME_WATCHDOG_MS = 250;

// ── HTTP MJPEG server ─────────────────────────────────────────────────────────

function _ensureHttpServer() {
  if (_httpServer) return Promise.resolve(_httpPort);
  return new Promise((resolve, reject) => {
    _httpServer = http.createServer((req, res) => {
      const url = req.url || '';

      if (url === '/imf/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }

      // MJPEG stream: GET /imf/stream/{sessionId}[?q=auto|full|half|quarter]
      const streamMatch = url.match(/^\/imf\/stream\/([^/?]+)/);
      if (streamMatch) {
        const session = _sessions.get(streamMatch[1]);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Session not found' }));
        }
        // Reduced-resolution playback (C-RT1): J2K DWT reduce-level via ffmpeg
        // -lowres makes UHD/HD sustain real-time on CPU (full-res can't — see
        // PostFlowX_CRT0_Audit.md). Scrub/pause stay full-res for a crisp frame.
        const qMatch = url.match(/[?&]q=([a-z0-9]+)/i);
        if (qMatch) {
          session.quality = qMatch[1];
          session.lowres = _qualityToLowres(qMatch[1], session.resolution);
        }
        _attachMJPEGStream(session, req, res);
        return;
      }

      // Single frame: GET /imf/frame/{sessionId}/{frameNum}
      const frameMatch = url.match(/^\/imf\/frame\/([^/]+)\/(\d+)/);
      if (frameMatch) {
        const session = _sessions.get(frameMatch[1]);
        const frameNum = parseInt(frameMatch[2], 10);
        if (!session) {
          res.writeHead(404); return res.end();
        }
        _serveFrame(session, frameNum, res);
        return;
      }

      res.writeHead(404); res.end();
    });

    _httpServer.on('error', (e) => {
      _httpServer = null;
      reject(e);
    });

    _httpServer.listen(0, '127.0.0.1', () => {
      _httpPort = _httpServer.address().port;
      resolve(_httpPort);
    });
  });
}

// Map a quality label to a J2K reduce-level (ffmpeg -lowres power-of-two).
// 'auto' is RESOLUTION-AWARE (P0-RT-REDUCED): HD (≤~2K) → lowres 1 (~40fps, clears
// 23.976); UHD/4K → lowres 2 (per CRT0 UHD full ~5fps, lowres1 ~20fps still misses
// 24, lowres2 ~149fps HD-equivalent clears cadence). Pass the source resolution
// (a {w,h} object or a numeric long-edge px) so Auto can pick the level.
function _qualityToLowres(q, resolution) {
  switch (String(q || '').toLowerCase()) {
    case 'full':    return 0;   // full resolution (decode-bound; may drop below realtime)
    case 'half':    return 1;   // 1/2 each axis — verified ~40fps HD IMF (clears 23.976)
    case 'quarter': return 2;   // 1/4 each axis — fastest preview
    case 'auto':    return _autoLowresForResolution(resolution);
    default:        return 0;
  }
}

// Pick the Auto reduce-level from source resolution. Long edge > 2560px (i.e. UHD
// / 4K and above) → level 2; anything HD/2K and below → level 1.
function _autoLowresForResolution(resolution) {
  let longEdge = 0;
  if (resolution && typeof resolution === 'object') {
    longEdge = Math.max(Number(resolution.w) || 0, Number(resolution.h) || 0);
  } else if (typeof resolution === 'number') {
    longEdge = resolution;
  }
  if (longEdge > 2560) return 2;  // UHD / 4K+ → quarter-res decode
  return 1;                        // HD / 2K and unknown → half-res decode
}

function _attachMJPEGStream(session, _req, res) {
  const boundary = 'pfxframe';
  res.writeHead(200, {
    'Content-Type':  `multipart/x-mixed-replace; boundary=${boundary}`,
    'Cache-Control': 'no-cache, no-store',
    'Connection':    'close',
    'Access-Control-Allow-Origin': '*',
  });

  // If already streaming, register this response as an additional sink.
  session.sinks = session.sinks || [];
  session.sinks.push({ res, boundary, closed: false });

  res.on('close', () => {
    const sink = session.sinks.find(s => s.res === res);
    if (sink) sink.closed = true;
  });

  // If process is already running and we have a pipe, hook this sink in.
  // The FFmpeg process writes to all active sinks via _broadcastFrame().
  if (session.state === 'playing' && !session.ffmpegProc) {
    _startFFmpegStream(session);
  }
}

// Push one JPEG frame buffer to all open sinks.
function _broadcastFrame(session, jpegBuf) {
  const sinks = session.sinks || [];
  const header = [
    `--${sinks[0]?.boundary || 'pfxframe'}`,
    'Content-Type: image/jpeg',
    `Content-Length: ${jpegBuf.length}`,
    '',
    '',
  ].join('\r\n');
  const headerBuf = Buffer.from(header, 'ascii');

  // Track HTTP-sink backpressure: res.write() returns false when the socket
  // buffer is full. If any sink is saturated we pause the ffmpeg stdout (bounded
  // decode-ahead) and resume once ALL sinks have drained.
  let anyBackpressure = false;
  for (const sink of sinks) {
    if (sink.closed) continue;
    try {
      const ok = sink.res.write(Buffer.concat([headerBuf, jpegBuf, Buffer.from('\r\n', 'ascii')]));
      if (ok === false) anyBackpressure = true;
    } catch {}
  }
  session.lastFrameBuf = jpegBuf;
  session.frameCount = (session.frameCount || 0) + 1;
  if (anyBackpressure) _pauseStream(session);
}

// True while any open sink's socket write buffer is still full (write() would
// return false). A drain event on any sink flips it back.
function _anySinkSaturated(session) {
  for (const sink of (session.sinks || [])) {
    if (sink.closed) continue;
    // res.writableNeedDrain is set by Node once a write() returned false and stays
    // true until 'drain' fires — a reliable per-sink saturation flag.
    if (sink.res && sink.res.writableNeedDrain) return true;
  }
  return false;
}

// Backpressure control for the persistent mpjpeg stream (bounded decode-ahead).
// The pause can be triggered by EITHER a saturated sink (write()===false) OR the
// reassembly buffer exceeding the cap (a giant partial frame / slow socket that
// has not yet reported drain). Because a buffer-cap pause may fire WITHOUT any
// sink having returned false, we cannot rely solely on a 'drain' handler to
// resume — so we (a) arm a drain listener on every open sink and (b) run a
// watchdog timer that re-checks and resumes so playback can never wedge.
function _pauseStream(session) {
  const p = session && session.ffmpegProc;
  if (!p || !p.stdout || session._stdoutPaused) return;
  session._stdoutPaused = true;
  try { p.stdout.pause(); } catch {}
  _rtLog('backpressure → paused ffmpeg stdout');

  // Arm a one-shot drain listener on each open sink.
  for (const sink of (session.sinks || [])) {
    if (sink.closed || sink._drainWired) continue;
    sink._drainWired = true;
    try {
      sink.res.once('drain', () => { sink._drainWired = false; _resumeStream(session); });
    } catch { sink._drainWired = false; }
  }

  // Watchdog: guarantees a resume even if no sink ever emits 'drain'.
  if (!session._resumeWatchdog) {
    session._resumeWatchdog = setInterval(() => _resumeStream(session), _RESUME_WATCHDOG_MS);
    if (session._resumeWatchdog.unref) session._resumeWatchdog.unref();
  }
}
function _resumeStream(session) {
  const p = session && session.ffmpegProc;
  if (!p || !p.stdout || !session._stdoutPaused) {
    _clearResumeWatchdog(session);
    return;
  }
  // Only resume once memory has drained below the low-water mark AND no sink is
  // still saturated — otherwise we would immediately re-pause and thrash.
  const bufLen = session._mpjpegBufLen || 0;
  if (bufLen > _MPJPEG_BUFFER_LOWATER || _anySinkSaturated(session)) return;

  session._stdoutPaused = false;
  _clearResumeWatchdog(session);
  try { p.stdout.resume(); } catch {}
  _rtLog('drain → resumed ffmpeg stdout');
}
function _clearResumeWatchdog(session) {
  if (session && session._resumeWatchdog) {
    clearInterval(session._resumeWatchdog);
    session._resumeWatchdog = null;
  }
}

function _serveFrame(session, frameNum, res) {
  _extractSingleFrame(session, frameNum).then((jpegBuf) => {
    if (!jpegBuf) {
      res.writeHead(500); res.end();
      return;
    }
    res.writeHead(200, {
      'Content-Type':   'image/jpeg',
      'Content-Length': jpegBuf.length,
      'Cache-Control':  'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(jpegBuf);
  }).catch(() => { try { res.writeHead(500); res.end(); } catch {} });
}

// ── FFmpeg spawn helpers ───────────────────────────────────────────────────────

async function _checkFFmpeg() {
  if (_ffmpegAvail !== null) return _ffmpegAvail;
  _ffmpegAvail = await _probe(['ffmpeg', '-version'], 5000);
  return _ffmpegAvail;
}

async function _checkIMFDemux() {
  if (_imfDemuxAvail !== null) return _imfDemuxAvail;
  // FFmpeg reports 'imf' in `-formats` when the demuxer is compiled in
  _imfDemuxAvail = await new Promise(resolve => {
    let out = '';
    const p = spawn(FFMPEG,['-formats'], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => { out += d; });
    p.on('close', () => resolve(/\bimf\b/i.test(out)));
    p.on('error', () => resolve(false));
    setTimeout(() => { p.kill(); resolve(false); }, 6000);
  });
  return _imfDemuxAvail;
}

async function _checkPhoton() {
  if (_photonChecked) return _photonPath;
  _photonChecked = true;
  const javaOk = await _probe(['java', '-version'], 5000);
  if (!javaOk) return null;

  const candidates = [
    '/usr/local/bin/photon.jar',
    '/opt/homebrew/bin/photon.jar',
    path.join(os.homedir(), 'bin', 'photon.jar'),
    path.join(os.homedir(), 'photon.jar'),
    '/Applications/Photon/photon.jar',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) { _photonPath = c; return c; }
  }
  return null;
}

function _probe(args, timeout) {
  return new Promise(resolve => {
    const p = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    p.on('close', code => resolve(code === 0));
    p.on('error', () => resolve(false));
    setTimeout(() => { p.kill(); resolve(false); }, timeout);
  });
}

// ── openPackage ───────────────────────────────────────────────────────────────

async function openPackage(inputPath) {
  if (!inputPath) return { ok: false, error: 'path required', code: 'BAD_REQUEST' };

  let folderPath = inputPath;
  const stat = fs.existsSync(inputPath) ? fs.statSync(inputPath) : null;
  if (!stat) return { ok: false, error: 'Path does not exist', code: 'NOT_FOUND' };

  if (stat.isFile()) {
    const base = path.basename(inputPath).toUpperCase();
    if (base === 'ASSETMAP.XML' || base === 'ASSETMAP') {
      folderPath = path.dirname(inputPath);
    } else if (base.endsWith('.XML') && (
      inputPath.toUpperCase().includes('CPL') ||
      _peekXML(inputPath, 'CompositionPlaylist')
    )) {
      folderPath = path.dirname(inputPath);
    } else {
      folderPath = path.dirname(inputPath);
    }
  }

  let idx;
  try {
    idx = new IMFPackageIndex().scan(folderPath);
  } catch (e) {
    return { ok: false, error: `Package scan failed: ${e.message}`, code: 'SCAN_ERROR' };
  }

  if (!idx.packageHash) {
    return {
      ok: false, code: 'NO_ASSETMAP',
      error: 'No ASSETMAP.xml found. Select the IMF package folder or ASSETMAP.xml directly.',
    };
  }

  // If a specific CPL.xml was passed, activate that CPL.
  if (stat.isFile() && inputPath.toUpperCase().includes('CPL') && idx.cpls.length > 1) {
    const cplId = idx.cpls.find(c => c.cplPath === inputPath)?.id;
    if (cplId) idx.activeCpl = idx.cplById.get(cplId) || idx.activeCpl;
  }

  _packages.set(idx.packageHash, { index: idx, path: folderPath });

  return {
    ok:        true,
    packageId: idx.packageHash,
    package:   _serializeIndex(idx),
  };
}

// ── validatePackage ───────────────────────────────────────────────────────────

// validatePackage(packageId, cplId[, opts])
//   opts.job    — optional ProgressJob to report progress into and honour
//                 cancellation from (P1-PROGRESS). Omitted → legacy behaviour
//                 (runs to completion, no progress, cannot be cancelled).
//   opts.hash   — when true (or a PKL Hash is present), verify essence SHA-1
//                 against the PKL. Off by default (can be slow on UHD reels).
async function validatePackage(packageId, cplId, opts = {}) {
  const pkg = _packages.get(packageId);
  if (!pkg) return { ok: false, error: 'Package not loaded', code: 'NOT_FOUND' };

  const job   = opts.job || null;
  const token = job ? job.token : null;
  // Cooperative checkpoint helper: throws CancellationError if cancelled.
  const ck = () => { if (token) token.throwIfCancelled(); };
  const step = (f, stage, msg) => { if (job) job.emit(f, stage, msg); };

  const idx = pkg.index;
  const cpl = cplId ? idx.cplById.get(cplId) : idx.activeCpl;

  const v = {
    assetmapFound:  !!idx.assetMapPath && fs.existsSync(idx.assetMapPath),
    pklFound:       idx.pklPaths.length > 0 && idx.pklPaths.some(p => fs.existsSync(p)),
    cplCount:       idx.cpls.length,
    pictureTrackCount: 0,
    audioTrackCount:   0,
    missingMXFs:    [],
    encryptedAssets:[],
    codecWarnings:  [],
    checksumStatus: 'not_checked',
    checksumResults:[],
    ffprobeResult:  null,
    photonResult:   null,
    errors:         [...idx.errors],
    warnings:       [],
    canPlay:        false,
    cancelled:      false,
  };

  try {
    step(0.02, 'assetmap', 'Checking ASSETMAP / PKL…');
    if (!v.assetmapFound) {
      v.errors.push('ASSETMAP.xml missing or unreadable');
    }
    if (!v.pklFound) {
      v.warnings.push('No Packing List (PKL) found. Hash verification unavailable.');
    }
    if (!cpl) {
      v.errors.push('No Composition Playlist (CPL) selected or found');
      if (job) job.settle('done', v);
      return { ok: true, validation: v };
    }
    ck();

    // ── Stage: track census + MXF existence ──────────────────────────────────
    step(0.08, 'tracks', 'Enumerating tracks…');
    const seenMXFs = new Set();
    for (const seg of (cpl.segments || [])) {
      for (const seq of (seg.sequences || [])) {
        const isPicture = seq.seqType === 'MainImageSequence' || seq.seqType?.toLowerCase().includes('image');
        const isAudio   = seq.seqType === 'MainAudioSequence' || seq.seqType === 'IABSequence' || seq.seqType?.toLowerCase().includes('audio');
        if (isPicture) v.pictureTrackCount++;
        if (isAudio)   v.audioTrackCount++;

        for (const res of (seq.resources || [])) {
          if (!res.trackFileId || seenMXFs.has(res.trackFileId)) continue;
          seenMXFs.add(res.trackFileId);
          const mxfPath = idx.resolveMXFPath(res.trackFileId);
          if (!mxfPath) {
            v.missingMXFs.push({
              uuid: res.trackFileId,
              friendlyName: `${isPicture ? 'Picture' : isAudio ? 'Audio' : 'Unknown'} track MXF not found`,
              seqType: seq.seqType,
            });
          }
        }
      }
    }
    ck();

    // Encryption check: look for KLVFill / CryptographicContext in CPL text
    if (cpl.videoResources?.some(r => r.descriptor?.pecUL?.includes('encrypt'))) {
      v.encryptedAssets.push('Encrypted picture essence detected — direct playback not supported');
    }

    // Codec support check
    const picDesc = cpl.picDesc || {};
    if (picDesc.isHTJ2K) {
      const imfDemux = await _checkIMFDemux();
      if (!imfDemux) {
        v.codecWarnings.push('HTJ2K (JPEG 2000 Part 15): FFmpeg IMF demuxer not available. Install FFmpeg ≥5.1 with OpenJPH support.');
      }
    }
    ck();

    // ── Stage: PKL hash verification (optional, cancellable) ─────────────────
    // Reads per-asset SHA-1 from the PKL <Hash> and streams each essence file to
    // verify it. This is the heaviest pass on UHD reels, so it is cooperatively
    // cancellable at both the per-file boundary AND mid-stream (kills the hash
    // read). Skipped unless opts.hash and a PKL is present.
    if (opts.hash && v.pklFound) {
      step(0.20, 'hashing', 'Verifying essence checksums…');
      v.checksumResults = await _verifyPKLHashes(idx, {
        token,
        onProgress: (frac, msg) => step(0.20 + frac * 0.45, 'hashing', msg),
      });
      const bad = v.checksumResults.filter(r => r.status === 'mismatch');
      const okc = v.checksumResults.filter(r => r.status === 'ok');
      if (v.checksumResults.length === 0)      v.checksumStatus = 'no_hashes_in_pkl';
      else if (bad.length > 0)                 { v.checksumStatus = 'mismatch'; for (const b of bad) v.errors.push(`Checksum mismatch: ${b.name}`); }
      else if (okc.length > 0)                 v.checksumStatus = 'verified';
      else                                     v.checksumStatus = 'incomplete';
    }
    ck();

    // ── Stage: essence probe (ffprobe over the IMF demuxer) ──────────────────
    step(0.68, 'probe', 'Probing essence with ffprobe…');
    const ffOk = await _checkFFmpeg();
    if (ffOk && idx.assetMapPath && cpl.cplPath) {
      try {
        v.ffprobeResult = await _ffprobeIMF(idx.assetMapPath, cpl.cplPath, token);
      } catch (e) {
        if (e instanceof CancellationError) throw e;
        v.warnings.push(`ffprobe validation failed: ${e.message}`);
      }
    }
    ck();

    // ── Stage: Photon (if available) ─────────────────────────────────────────
    step(0.85, 'photon', 'Running Photon (if available)…');
    const photonJar = await _checkPhoton();
    if (photonJar && idx.folderPath) {
      try {
        v.photonResult = await _runPhoton(photonJar, idx.folderPath, token);
      } catch (e) { if (e instanceof CancellationError) throw e; }
    }
    ck();

    // Determine playability
    v.canPlay = v.assetmapFound && !!cpl && v.missingMXFs.length === 0 &&
                v.encryptedAssets.length === 0 && v.errors.length === 0 && ffOk;

    step(1, 'done', 'Validation complete');
    if (job) job.settle('done', v);
    return { ok: true, validation: v };
  } catch (e) {
    if (e instanceof CancellationError) {
      v.cancelled = true;
      v.warnings.push('Validation cancelled before completion.');
      if (job) job.settle('cancelled', v);
      return { ok: true, validation: v, cancelled: true, code: 'CANCELLED' };
    }
    if (job) job.settle('error', e.message);
    return { ok: false, error: e.message, code: 'VALIDATE_ERROR' };
  }
}

// Stream each PKL-listed essence file and compare its SHA-1 to the PKL <Hash>.
// Cooperatively cancellable: honours token at file boundaries AND kills the
// in-flight read stream if cancelled mid-file. Returns per-asset results.
async function _verifyPKLHashes(idx, { token, onProgress } = {}) {
  const results = [];
  // Collect { uuid, name, expectedHash, path } from every PKL, reading the raw
  // XML for <Hash> (the package index intentionally drops it).
  const assets = [];
  for (const pklPath of (idx.pklPaths || [])) {
    let text;
    try { text = fs.readFileSync(pklPath, 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/<[\w:]*Asset\b[\s\S]*?<\/[\w:]*Asset>/g)) {
      const block = m[0];
      const id   = (block.match(/<[\w:]*Id>\s*(?:urn:uuid:)?([0-9a-fA-F-]+)\s*<\/[\w:]*Id>/) || [])[1];
      const hash = (block.match(/<[\w:]*Hash>\s*([A-Za-z0-9+/=\s]+?)\s*<\/[\w:]*Hash>/) || [])[1];
      const name = (block.match(/<[\w:]*OriginalFileName[^>]*>\s*([\s\S]*?)\s*<\/[\w:]*OriginalFileName>/) || [])[1];
      if (!id || !hash) continue;
      const p = idx.resolveMXFPath(id) || (idx.assetMap && idx.assetMap.get(_normUuid(id))?.absPath) || null;
      assets.push({ uuid: id, name: (name || '').trim() || id, expectedHash: hash.replace(/\s+/g, ''), path: p });
    }
  }
  const total = assets.length;
  for (let i = 0; i < total; i++) {
    if (token) token.throwIfCancelled();
    const a = assets[i];
    if (onProgress) onProgress(total ? i / total : 0, `Hashing ${a.name} (${i + 1}/${total})`);
    if (!a.path || !fs.existsSync(a.path)) {
      results.push({ uuid: a.uuid, name: a.name, status: 'missing' });
      continue;
    }
    try {
      const actual = await _sha1File(a.path, token);
      results.push({
        uuid: a.uuid, name: a.name,
        status: actual === a.expectedHash ? 'ok' : 'mismatch',
        expected: a.expectedHash, actual,
      });
    } catch (e) {
      if (e instanceof CancellationError) throw e;
      results.push({ uuid: a.uuid, name: a.name, status: 'error', error: e.message });
    }
  }
  if (onProgress && total) onProgress(1, `Hashed ${total} asset${total > 1 ? 's' : ''}`);
  return results;
}

// SHA-1 of a file as base64 (PKL <Hash> encoding). Cancellable mid-stream.
function _sha1File(filePath, token) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    const rs = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
    let unregister = () => {};
    if (token) {
      unregister = token.onCancel(() => { try { rs.destroy(); } catch {} reject(new CancellationError()); });
    }
    rs.on('data', (chunk) => {
      if (token && token.cancelled) { try { rs.destroy(); } catch {} return; }
      h.update(chunk);
    });
    rs.on('error', (e) => { unregister(); reject(e); });
    rs.on('end', () => { unregister(); resolve(h.digest('base64')); });
  });
}

function _normUuid(u) {
  return String(u || '').replace(/^urn:uuid:/i, '').toLowerCase();
}

async function _ffprobeIMF(assetMapPath, cplPath, token) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'quiet',
      '-f', 'imf',
      '-assetmaps', assetMapPath,
      '-show_streams', '-show_format',
      '-of', 'json',
      cplPath,
    ];
    let out = ''; let err = '';
    const p = spawn(FFPROBE,args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: 'ffprobe timeout' }); }, 30000);
    let unregister = () => {};
    if (token) {
      unregister = token.onCancel(() => { clearTimeout(timer); try { p.kill('SIGKILL'); } catch {} reject(new CancellationError()); });
    }
    const _done = (r) => { clearTimeout(timer); unregister(); resolve(r); };
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      if (code !== 0 || !out.trim()) {
        // ffprobe returned error — this is still informative
        _done({ ok: false, error: err.slice(-300), supportsIMFDemux: false });
        return;
      }
      try {
        const parsed = JSON.parse(out);
        const streams = parsed.streams || [];
        const videoStream = streams.find(s => s.codec_type === 'video');
        const audioStream = streams.find(s => s.codec_type === 'audio');
        _done({
          ok: true,
          supportsIMFDemux: true,
          streams: streams.length,
          video: videoStream ? {
            codec:    videoStream.codec_name,
            width:    videoStream.width,
            height:   videoStream.height,
            pix_fmt:  videoStream.pix_fmt,
            r_frame_rate: videoStream.r_frame_rate,
            color_transfer: videoStream.color_transfer,
          } : null,
          audio: audioStream ? {
            codec:        audioStream.codec_name,
            channels:     audioStream.channels,
            sample_rate:  audioStream.sample_rate,
            channel_layout: audioStream.channel_layout,
          } : null,
          duration: parseFloat(parsed.format?.duration || '0') || 0,
        });
      } catch {
        _done({ ok: false, error: 'ffprobe JSON parse failed' });
      }
    });
    p.on('error', () => { _done({ ok: false, error: 'ffprobe not found' }); });
  });
}

async function _runPhoton(jarPath, folderPath, token) {
  return new Promise((resolve, reject) => {
    let out = ''; let err = '';
    const p = spawn('java', ['-jar', jarPath, folderPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { p.kill(); resolve({ ok: false, error: 'photon timeout' }); }, 60000);
    let unregister = () => {};
    if (token) {
      unregister = token.onCancel(() => { clearTimeout(timer); try { p.kill('SIGKILL'); } catch {} reject(new CancellationError()); });
    }
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('close', code => {
      clearTimeout(timer); unregister();
      resolve({
        ok: code === 0,
        errors:   _parsePhotonOutput(out + err, 'ERROR'),
        warnings: _parsePhotonOutput(out + err, 'WARNING'),
        rawOutput: (out + err).slice(0, 2000),
      });
    });
    p.on('error', () => { clearTimeout(timer); unregister(); resolve({ ok: false, error: 'java not found' }); });
  });
}

function _parsePhotonOutput(text, level) {
  return text.split('\n')
    .filter(l => l.toUpperCase().includes(level))
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 50);
}

// ── startPlayback ─────────────────────────────────────────────────────────────

async function startPlayback(packageId, cplId, opts = {}) {
  const pkg = _packages.get(packageId);
  if (!pkg) return { ok: false, error: 'Package not loaded', code: 'NOT_FOUND' };

  const idx = pkg.index;
  const cpl = cplId ? idx.cplById.get(cplId) : idx.activeCpl;
  if (!cpl) return { ok: false, error: 'CPL not found', code: 'NO_CPL' };
  if (!idx.assetMapPath) return { ok: false, error: 'ASSETMAP not found', code: 'NO_ASSETMAP' };

  const ffOk = await _checkFFmpeg();
  if (!ffOk) return { ok: false, error: 'FFmpeg not found in PATH', code: 'NO_FFMPEG' };

  const imfOk = await _checkIMFDemux();
  if (!imfOk) {
    return {
      ok: false, code: 'NO_IMF_DEMUX',
      error: 'FFmpeg does not have the IMF demuxer. Install FFmpeg ≥5.1 built with IMF support.',
    };
  }

  const port = await _ensureHttpServer();

  const sessionId = `imf-${++_sessionSeq}-${Date.now().toString(36)}`;
  // imf_xml.parseEditRate returns a scalar fps (e.g. 23.976), NOT an [num,den]
  // array — indexing [0]/[1] yielded NaN and broke seek/fps for non-24p packages.
  const fps        = (typeof cpl.editRate === 'number' && cpl.editRate > 0) ? cpl.editRate : 24;
  const seekFrame  = opts.startFrame || 0;

  const session = {
    sessionId,
    packageId,
    cplId:       cpl.id,
    cplPath:     cpl.cplPath,
    assetMapPath:idx.assetMapPath,
    fps,
    totalFrames: cpl.totalFrames,
    currentFrame: seekFrame,
    state:       'stopped',
    ffmpegProc:  null,
    sinks:       [],
    lastFrameBuf:null,
    frameCount:  0,
    codec:       cpl.codec || '–',
    resolution:  cpl.resolution || null,
    transfer:    cpl.transfer || '–',
    primaries:   cpl.primaries || '–',
    audioInfo:   null,
    outputWidth: opts.outputWidth || 1920,
    quality:     (opts.quality || 'full'),                  // last requested quality label
    lowres:      _qualityToLowres(opts.quality || 'full', cpl.resolution),  // continuous-play reduce level
  };
  _sessions.set(sessionId, session);

  const streamUrl = `http://127.0.0.1:${port}/imf/stream/${sessionId}`;
  const frameUrl  = `http://127.0.0.1:${port}/imf/frame/${sessionId}`;

  return {
    ok: true,
    sessionId,
    streamUrl,
    frameUrl,
    info: {
      fps, totalFrames: cpl.totalFrames,
      codec:     cpl.codec     || '–',
      resolution:cpl.resolution || null,
      transfer:  cpl.transfer  || '–',
      primaries: cpl.primaries || '–',
      cplId:     cpl.id,
      cplPath:   cpl.cplPath,
      editRate:  cpl.editRate,
    },
  };
}

// ── controlPlayback ───────────────────────────────────────────────────────────

async function controlPlayback(sessionId, command, value) {
  const session = _sessions.get(sessionId);
  if (!session) return { ok: false, error: 'Session not found', code: 'NOT_FOUND' };

  switch (command) {
    case 'play':
      if (session.state !== 'playing') {
        session.state = 'playing';
        _startFFmpegStream(session, session.currentFrame);
      }
      return { ok: true };

    case 'pause':
      session.state = 'paused';
      _killFFmpegProc(session);
      return { ok: true };

    case 'stop':
      session.state = 'stopped';
      session.currentFrame = 0;
      _killFFmpegProc(session);
      return { ok: true };

    case 'seek': {
      const targetFrame = Math.max(0, Math.min(session.totalFrames - 1, Math.round(Number(value) || 0)));
      session.currentFrame = targetFrame;
      if (session.state === 'playing') {
        _killFFmpegProc(session);
        _startFFmpegStream(session, targetFrame);
      }
      return { ok: true, frame: targetFrame };
    }

    case 'quality': {
      // Reduced-resolution continuous-play level (C-RT1). Restart the stream so
      // the new -lowres takes effect mid-playback.
      const lowres = _qualityToLowres(value, session.resolution);
      const changed = lowres !== session.lowres;
      session.quality = value;
      session.lowres = lowres;
      if (changed && session.state === 'playing') {
        _killFFmpegProc(session);
        _startFFmpegStream(session, session.currentFrame);
      }
      return { ok: true, quality: value, lowres };
    }

    case 'stepForward': {
      const next = Math.min(session.currentFrame + 1, session.totalFrames - 1);
      session.currentFrame = next;
      session.state = 'paused';
      _killFFmpegProc(session);
      return { ok: true, frame: next };
    }

    case 'stepBack': {
      const prev = Math.max(session.currentFrame - 1, 0);
      session.currentFrame = prev;
      session.state = 'paused';
      _killFFmpegProc(session);
      return { ok: true, frame: prev };
    }

    case 'setRate':
      session.rate = Number(value) || 1;
      if (session.state === 'playing') {
        _killFFmpegProc(session);
        _startFFmpegStream(session, session.currentFrame);
      }
      return { ok: true };

    default:
      return { ok: false, error: `Unknown command: ${command}`, code: 'UNKNOWN_COMMAND' };
  }
}

// ── stopPlayback ──────────────────────────────────────────────────────────────

function stopPlayback(sessionId) {
  const session = _sessions.get(sessionId);
  if (!session) return { ok: false, error: 'Session not found' };
  _killFFmpegProc(session);
  _sessions.delete(sessionId);
  return { ok: true };
}

// ── getFrame (single frame extraction for scrubbing) ─────────────────────────

async function getFrame(packageId, cplId, frameNum, displayMode = 'sdr') {
  const pkg = _packages.get(packageId);
  if (!pkg) return { ok: false, error: 'Package not loaded', code: 'NOT_FOUND' };

  const idx = pkg.index;
  const cpl = cplId ? idx.cplById.get(cplId) : idx.activeCpl;
  if (!cpl || !idx.assetMapPath) return { ok: false, error: 'CPL or ASSETMAP not found' };

  const session = {
    cplPath: cpl.cplPath,
    assetMapPath: idx.assetMapPath,
    fps: (typeof cpl.editRate === 'number' && cpl.editRate > 0) ? cpl.editRate : 24,
    outputWidth: 1920,
  };

  try {
    const jpegBuf = await _extractSingleFrame(session, frameNum);
    if (!jpegBuf) return { ok: false, error: 'Frame extraction failed', code: 'EXTRACT_FAILED' };

    const dataUrl = 'data:image/jpeg;base64,' + jpegBuf.toString('base64');
    return {
      ok: true,
      imageDataUrl: dataUrl,
      frameInfo: { frame: frameNum, backend: 'imf-direct-ffmpeg', codec: cpl.codec },
    };
  } catch (e) {
    return { ok: false, error: e.message, code: 'EXTRACT_ERROR' };
  }
}

// ── stepFrame ─────────────────────────────────────────────────────────────────
// Frame-accurate step ±1 within an active playback session.

async function stepFrame(sessionId, direction = 'forward', displayMode = 'sdr') {
  const session = _sessions.get(sessionId);
  if (!session) return { ok: false, error: 'Session not found', code: 'NOT_FOUND' };

  const next = direction === 'backward'
    ? Math.max(session.currentFrame - 1, 0)
    : Math.min(session.currentFrame + 1, (session.totalFrames || 1) - 1);

  session.currentFrame = next;
  session.state = 'paused';
  _killFFmpegProc(session);

  try {
    const jpegBuf = await _extractSingleFrame(session, next);
    if (!jpegBuf) return { ok: false, error: 'Frame extraction failed', code: 'EXTRACT_FAILED' };
    const dataUrl = 'data:image/jpeg;base64,' + jpegBuf.toString('base64');
    return { ok: true, frame: next, imageDataUrl: dataUrl, backend: 'imf-direct-ffmpeg' };
  } catch (e) {
    return { ok: false, error: e.message, code: 'EXTRACT_ERROR' };
  }
}

// ── grabThumbnail ─────────────────────────────────────────────────────────────
// Extract a low-resolution thumbnail at a given CPL frame number.
// Tries native decoder (direct MXF path) first, falls back to FFmpeg IMF demuxer.

async function grabThumbnail(packageId, cplId, frameNum, width = 320) {
  const pkg = _packages.get(packageId);
  if (!pkg) return { ok: false, error: 'Package not loaded', code: 'NOT_FOUND' };

  const idx = pkg.index;
  const cpl = cplId ? idx.cplById.get(cplId) : idx.activeCpl;
  if (!cpl || !idx.assetMapPath) return { ok: false, error: 'CPL or ASSETMAP not found' };

  // Try native decoder on the picture track MXF (single-reel optimisation).
  const nativeAvail = await nativeDecoder.checkAvailability();
  if (nativeAvail.any) {
    const mxfPath = _primaryPictureMxfPath(idx, cpl);
    if (mxfPath) {
      const tmpOut = path.join(os.tmpdir(), `pfx_thumb_${Date.now()}.jpg`);
      const nr = await nativeDecoder.grabThumbnail(mxfPath, frameNum, tmpOut, width);
      if (nr.ok && fs.existsSync(tmpOut)) {
        const b64 = fs.readFileSync(tmpOut).toString('base64');
        try { fs.unlinkSync(tmpOut); } catch {}
        return { ok: true, frame: frameNum, imageDataUrl: `data:image/jpeg;base64,${b64}`, backend: 'pfx-native' };
      }
    }
  }

  // FFmpeg fallback via IMF demuxer.
  const session = {
    cplPath: cpl.cplPath,
    assetMapPath: idx.assetMapPath,
    fps: (typeof cpl.editRate === 'number' && cpl.editRate > 0) ? cpl.editRate : 24,
    outputWidth: width,
  };

  try {
    const jpegBuf = await _extractSingleFrame(session, frameNum);
    if (!jpegBuf) return { ok: false, error: 'Thumbnail extraction failed', code: 'EXTRACT_FAILED' };
    const dataUrl = 'data:image/jpeg;base64,' + jpegBuf.toString('base64');
    return { ok: true, frame: frameNum, imageDataUrl: dataUrl, backend: 'imf-direct-ffmpeg' };
  } catch (e) {
    return { ok: false, error: e.message, code: 'EXTRACT_ERROR' };
  }
}

// Returns the path of the first picture-track MXF in the CPL, or null.
function _primaryPictureMxfPath(idx, cpl) {
  for (const seg of (cpl.segments || [])) {
    for (const seq of (seg.sequences || [])) {
      const isPicture = seq.seqType === 'MainImageSequence' || seq.seqType?.toLowerCase().includes('image');
      if (!isPicture) continue;
      for (const res of (seq.resources || [])) {
        if (!res.trackFileId) continue;
        const p = idx.resolveMXFPath(res.trackFileId);
        if (p) return p;
      }
    }
  }
  return null;
}

// ── getPackageInfo ────────────────────────────────────────────────────────────

function getPackageInfo(packageId) {
  const pkg = _packages.get(packageId);
  if (!pkg) return { ok: false, error: 'Package not loaded', code: 'NOT_FOUND' };
  return { ok: true, package: _serializeIndex(pkg.index) };
}

function listPackages() {
  const packages = [];
  for (const [id, pkg] of _packages) {
    const idx = pkg.index;
    packages.push({
      packageId:   id,
      folderPath:  idx.folderPath,
      cplCount:    idx.cpls.length,
      activeCplId: idx.activeCpl?.id,
    });
  }
  return { ok: true, packages };
}

// ── diagnostics ───────────────────────────────────────────────────────────────

async function diagnostics() {
  const [ffmpegAvail, imfDemuxAvail, photonJar] = await Promise.all([
    _checkFFmpeg(),
    _checkIMFDemux(),
    _checkPhoton(),
  ]);
  return {
    ok: true,
    ffmpegAvailable:    ffmpegAvail,
    imfDemuxAvailable:  imfDemuxAvail,
    photonAvailable:    !!photonJar,
    photonPath:         photonJar,
    httpPort:           _httpPort,
    activeSessions:     _sessions.size,
    loadedPackages:     _packages.size,
    // Real-time playback invariant counters (P0-RT-PERSIST). During continuous
    // play, perFrameSpawnsDuringPlay MUST stay 0 (all frames come from the
    // persistent stream); a non-zero value means a scrub/step path leaked into
    // the play loop and would break real-time cadence.
    perFrameSpawns:            _perFrameSpawns,
    perFrameSpawnsDuringPlay:  _perFrameSpawnsDuringPlay,
    mpjpegBufferCapBytes:      _MPJPEG_BUFFER_CAP,
  };
}

// Test/diagnostic hooks for the real-time invariant counters.
function _rtStats() {
  return {
    perFrameSpawns: _perFrameSpawns,
    perFrameSpawnsDuringPlay: _perFrameSpawnsDuringPlay,
    mpjpegBufferCapBytes: _MPJPEG_BUFFER_CAP,
  };
}
function _rtResetStats() { _perFrameSpawns = 0; _perFrameSpawnsDuringPlay = 0; }

// ── P1-PROGRESS: decode warm-up pass (cancellable) ─────────────────────────────
// Decode the first N frames through the IMF demuxer so the first real play/scrub
// is instant (primes ffmpeg + the reduced-decode ladder). Reports progress and
// honours cancellation by killing the ffmpeg child. Uses the mpjpeg reassembly
// path (same as continuous play) to count decoded frames.
async function warmUpDecode(packageId, cplId, opts = {}, job = null) {
  const pkg = _packages.get(packageId);
  if (!pkg) return { ok: false, error: 'Package not loaded', code: 'NOT_FOUND' };
  const idx = pkg.index;
  const cpl = cplId ? idx.cplById.get(cplId) : idx.activeCpl;
  if (!cpl || !idx.assetMapPath) return { ok: false, error: 'CPL or ASSETMAP not found', code: 'NO_CPL' };

  const token = job ? job.token : null;
  const frames = Math.max(1, Math.min(240, opts.frames || 24));
  const fps    = (typeof cpl.editRate === 'number' && cpl.editRate > 0) ? cpl.editRate : 24;
  const outW   = opts.outputWidth || 1280;
  const lowres = _qualityToLowres(opts.quality || 'auto', cpl.resolution);

  const args = ['-v', 'warning', '-f', 'imf', '-assetmaps', idx.assetMapPath];
  if (lowres > 0) args.push('-lowres', String(lowres));
  args.push('-i', cpl.cplPath, '-frames:v', String(frames), '-an',
            '-vf', `scale=${outW}:-2`, '-c:v', 'mjpeg', '-q:v', '5', '-f', 'mpjpeg', 'pipe:1');

  return new Promise((resolve, reject) => {
    const ffOk = _checkFFmpeg();
    Promise.resolve(ffOk).then((avail) => {
      if (!avail) return resolve({ ok: false, error: 'FFmpeg not found', code: 'NO_FFMPEG' });
      const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let decoded = 0;
      const asm = createMpjpegReassembler((frame) => {
        decoded++;
        if (job) job.emit(Math.min(1, decoded / frames), 'warmup', `Warmed ${decoded}/${frames} frames`);
      });
      let unregister = () => {};
      if (token) unregister = token.onCancel(() => { try { p.kill('SIGKILL'); } catch {} reject(new CancellationError()); });
      const timer = setTimeout(() => { try { p.kill(); } catch {} }, 60000);
      p.stdout.on('data', (chunk) => asm.push(chunk));
      p.on('close', () => {
        clearTimeout(timer); unregister();
        const res = { ok: true, framesDecoded: decoded, requested: frames, lowres };
        if (job) job.settle('done', res);
        resolve(res);
      });
      p.on('error', (e) => { clearTimeout(timer); unregister(); if (job) job.settle('error', e.message); resolve({ ok: false, error: e.message }); });
    });
  });
}

// ── P1-PROGRESS: public start / onProgress / cancel job surface ────────────────
// Poll-based (the pfx:imf-engine IPC channel is request/response). A caller does:
//   startJob('validate', {...})  → { ok, jobId }
//   jobProgress(jobId)           → { ok, snapshot }   (poll)
//   cancelJob(jobId)             → { ok }
// In-process callers (tests, other main-process modules) can instead grab the
// ProgressJob directly via _getJob(jobId).onProgress(cb) for push updates.
function startJob(kind, params = {}) {
  const job = _newJob(kind);
  let runner;
  if (kind === 'validate') {
    runner = validatePackage(params.packageId, params.cplId, { job, hash: !!params.hash });
  } else if (kind === 'warmup') {
    runner = warmUpDecode(params.packageId, params.cplId, params.opts || {}, job);
  } else {
    _jobs.delete(job.id);
    return { ok: false, error: `Unknown job kind: ${kind}`, code: 'UNKNOWN_JOB' };
  }
  // Detach: pollers read progress/result via jobProgress(); ensure settle on throw.
  Promise.resolve(runner)
    .then((r) => { if (job.state === 'running') job.settle(r && r.ok === false ? 'error' : 'done', r && r.ok === false ? r.error : (r && r.validation ? r.validation : r)); })
    .catch((e) => { if (job.state === 'running') job.settle(e instanceof CancellationError ? 'cancelled' : 'error', e && e.message); })
    .finally(() => _reapJob(job.id));
  return { ok: true, jobId: job.id, kind };
}

function jobProgress(jobId) {
  const job = _jobs.get(jobId);
  if (!job) return { ok: false, error: 'Job not found (may have been reaped)', code: 'NOT_FOUND' };
  return { ok: true, snapshot: job.snapshot() };
}

function cancelJob(jobId) {
  const job = _jobs.get(jobId);
  if (!job) return { ok: false, error: 'Job not found', code: 'NOT_FOUND' };
  job.token.cancel();
  return { ok: true, jobId, state: job.state };
}

// In-process handle (tests / other main-process modules): push-based onProgress.
function _getJob(jobId) { return _jobs.get(jobId) || null; }

// ── FFmpeg subprocess management ──────────────────────────────────────────────

function _startFFmpegStream(session, startFrame) {
  if (session.ffmpegProc) _killFFmpegProc(session);

  const fps    = session.fps || 24;
  const seekTs = startFrame > 0 ? (startFrame / fps).toFixed(6) : null;
  const outW   = session.outputWidth || 1920;

  const args = [
    '-v', 'warning',
    '-f', 'imf',
    '-assetmaps', session.assetMapPath,
  ];
  // Reduced-resolution decode for real-time continuous playback (C-RT1). -lowres
  // is a DECODER option → must precede -i. The J2K decoder emits at 1/2^N per
  // axis (far cheaper); the scale filter below resizes to the canvas width.
  if (session.lowres > 0) args.push('-lowres', String(session.lowres));
  if (seekTs) args.push('-ss', seekTs);
  args.push('-i', session.cplPath);
  args.push(
    '-an',
    '-vf', `scale=${outW}:-2`,
    '-c:v', 'mjpeg',
    '-q:v', '3',
    '-r', String(fps),
    '-f', 'mpjpeg',
    'pipe:1',
  );

  const proc = spawn(FFMPEG,args, { stdio: ['ignore', 'pipe', 'pipe'] });
  session.ffmpegProc = proc;
  session.state = 'playing';
  session._stdoutPaused = false;

  // Shared mpjpeg framing (createMpjpegReassembler) — identical to the warm-up
  // and benchmark paths. Each complete JPEG is broadcast to all sinks.
  const asm = createMpjpegReassembler((frame) => {
    _broadcastFrame(session, frame);
    session.currentFrame++;
  });

  proc.stdout.on('data', (chunk) => {
    asm.push(chunk);

    // Publish the reassembly buffer size so _resumeStream can gate on the
    // low-water mark (see backpressure notes above).
    session._mpjpegBufLen = asm.bufferLength();

    // Bounded decode-ahead: if the reassembly buffer exceeds the cap (a partial
    // frame plus a saturated sink), pause the decoder so memory never balloons on
    // UHD. Resume is driven by sink 'drain' + a watchdog, gated on the low-water
    // mark, so a buffer-cap pause can never wedge playback.
    if (asm.bufferLength() > _MPJPEG_BUFFER_CAP) _pauseStream(session);
  });

  proc.stderr.on('data', d => {
    const msg = d.toString();
    if (msg.includes('error') || msg.includes('Error')) {
      session.lastError = msg.slice(-200);
    }
  });

  proc.on('close', (code) => {
    session.ffmpegProc = null;
    session._stdoutPaused = false;
    session._mpjpegBufLen = 0;
    _clearResumeWatchdog(session);
    if (session.state === 'playing') {
      session.state = code === 0 ? 'ended' : 'error';
    }
    // Close all MJPEG sinks cleanly
    for (const sink of (session.sinks || [])) {
      if (!sink.closed) {
        try { sink.res.end(); } catch {}
        sink.closed = true;
      }
    }
    session.sinks = [];
  });

  proc.on('error', (e) => {
    session.lastError = e.message;
    session.ffmpegProc = null;
    session.state = 'error';
  });
}

async function _extractSingleFrame(session, frameNum) {
  // Real-time invariant guard (P0-RT-PERSIST): a per-frame ffmpeg spawn during
  // continuous play would break real-time cadence (CRT0 §3e). Scrub/step set
  // state to 'paused' BEFORE calling this; a spawn while 'playing' is a defect.
  _perFrameSpawns++;
  if (session && session.state === 'playing') {
    _perFrameSpawnsDuringPlay++;
    _rtLog('WARN per-frame ffmpeg spawned during PLAY (breaks real-time)', { frame: frameNum });
  }
  const fps    = session.fps || 24;
  const seekTs = frameNum > 0 ? (frameNum / fps).toFixed(6) : '0';
  const outW   = session.outputWidth || 1920;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfx-imf-'));
  const outPath = path.join(tmpDir, 'frame.jpg');

  try {
    await new Promise((resolve, reject) => {
      const args = [
        '-v', 'warning',
        '-f', 'imf',
        '-assetmaps', session.assetMapPath,
        '-ss', seekTs,
        '-i', session.cplPath,
        '-vframes', '1',
        '-an',
        '-vf', `scale=${outW}:-2`,
        '-c:v', 'mjpeg',
        '-q:v', '4',
        '-y',
        outPath,
      ];
      const p = spawn(FFMPEG,args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { p.kill(); reject(new Error('ffmpeg timeout')); }, 45000);
      let err = '';
      p.stderr.on('data', d => { err += d; });
      p.on('close', code => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 100) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exit ${code}: ${err.slice(-200)}`));
        }
      });
      p.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function _killFFmpegProc(session) {
  if (session.ffmpegProc) {
    try { session.ffmpegProc.kill('SIGTERM'); } catch {}
    session.ffmpegProc = null;
  }
  session._stdoutPaused = false;
  session._mpjpegBufLen = 0;
  _clearResumeWatchdog(session);
}

// ── Command dispatcher ────────────────────────────────────────────────────────

const _COMMANDS = new Set([
  'openPackage', 'validatePackage', 'startPlayback', 'controlPlayback',
  'stopPlayback', 'getFrame', 'stepFrame', 'grabThumbnail',
  'getPackageInfo', 'listPackages', 'diagnostics',
  // P1-PROGRESS: poll-based long-pass job control.
  'startJob', 'jobProgress', 'cancelJob',
]);

function handles(command) {
  return _COMMANDS.has(command);
}

async function route({ command, payload = {} }) {
  switch (command) {
    case 'openPackage':     return openPackage(payload.path);
    case 'validatePackage': return validatePackage(payload.packageId, payload.cplId);
    case 'startPlayback':   return startPlayback(payload.packageId, payload.cplId, payload.opts);
    case 'controlPlayback': return controlPlayback(payload.sessionId, payload.command, payload.value);
    case 'stopPlayback':    return stopPlayback(payload.sessionId);
    case 'getFrame':        return getFrame(payload.packageId, payload.cplId, payload.frame, payload.displayMode);
    case 'stepFrame':       return stepFrame(payload.sessionId, payload.direction, payload.displayMode);
    case 'grabThumbnail':   return grabThumbnail(payload.packageId, payload.cplId, payload.frame, payload.width);
    case 'getPackageInfo':  return getPackageInfo(payload.packageId);
    case 'listPackages':    return listPackages();
    case 'diagnostics':     return diagnostics();
    // P1-PROGRESS: start a cancellable, progress-reporting long pass; poll it;
    // cancel it. Additive to the existing request/response IPC channel.
    case 'startJob':        return startJob(payload.kind, payload.params || {});
    case 'jobProgress':     return jobProgress(payload.jobId);
    case 'cancelJob':       return cancelJob(payload.jobId);
    default:
      return { ok: false, error: `Unknown command: ${command}`, code: 'UNKNOWN_COMMAND' };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _peekXML(filePath, keyword) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    return buf.slice(0, n).toString('utf8').includes(keyword);
  } catch { return false; }
}

function _findMarker(buf, fromOffset, b0, b1) {
  for (let i = fromOffset; i < buf.length - 1; i++) {
    if (buf[i] === b0 && buf[i + 1] === b1) return i;
  }
  return -1;
}

// mpjpeg reassembler — the SINGLE source of truth for carving complete JPEG
// frames (SOI 0xFFD8 … EOI 0xFFD9) out of the byte stream that ffmpeg's `-f
// mpjpeg` muxer writes to pipe:1. Used by BOTH continuous playback
// (_startFFmpegStream) and the decode warm-up pass so the runtime path and the
// FPS benchmark exercise identical framing. push(chunk) returns the number of
// complete frames emitted from that chunk; bufferLength() exposes the pending
// (partial-frame) bytes for backpressure gating. Deterministic + synchronous →
// unit-testable on synthetic byte streams without spawning ffmpeg.
function createMpjpegReassembler(onFrame) {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      let start = 0;
      let count = 0;
      let lastSoi = -1;
      while (true) {
        const soi = _findMarker(buf, start, 0xFF, 0xD8);
        if (soi < 0) break;
        lastSoi = soi;
        const eoi = _findMarker(buf, soi + 2, 0xFF, 0xD9);
        if (eoi < 0) break;   // partial frame: SOI seen, EOI not yet — keep from SOI
        const frame = buf.slice(soi, eoi + 2);
        try { onFrame(frame); } catch {}
        count++;
        start = eoi + 2;
        lastSoi = -1;
      }
      // Keep the trailing partial frame (from the last SOI). If NO SOI is pending,
      // drop consumed bytes but retain the final byte so an 0xFF split across the
      // chunk boundary still resolves against the next chunk.
      if (lastSoi >= 0)      buf = buf.slice(lastSoi);
      else if (start > 0)    buf = buf.slice(start);
      else                   buf = buf.slice(Math.max(0, buf.length - 1));
      return count;
    },
    bufferLength() { return buf.length; },
    reset() { buf = Buffer.alloc(0); },
  };
}

function _serializeIndex(idx) {
  const j = idx.toJSON();
  // Augment with per-CPL reel lists and audio sequence info
  j.cpls = idx.cpls.map(c => {
    const audioSeqs = [];
    for (const seg of (c.segments || [])) {
      for (const seq of (seg.sequences || [])) {
        if (seq.seqType === 'MainAudioSequence' || seq.seqType === 'IABSequence' ||
            seq.seqType?.toLowerCase().includes('audio')) {
          audioSeqs.push({ seqType: seq.seqType, seqId: seq.seqId, trackId: seq.trackId });
        }
      }
    }
    return {
      id:           c.id,
      editRate:     c.editRate,
      totalFrames:  c.totalFrames,
      codec:        c.codec,
      resolution:   c.resolution,
      transfer:     c.transfer,
      primaries:    c.primaries,
      isSupplemental: c.isSupplemental,
      cplPath:      c.cplPath,
      videoResourceCount: c.videoResources?.length || 0,
      audioSequences: audioSeqs,
      picDesc: c.picDesc ? {
        isHTJ2K: c.picDesc.isHTJ2K, isJ2K: c.picDesc.isJ2K,
        w: c.picDesc.w, h: c.picDesc.h,
        depth: c.picDesc.depth,
        masteringMaxLum: c.picDesc.masteringMaxLum,
        maxCLL: c.picDesc.maxCLL,
      } : null,
    };
  });
  return j;
}

module.exports = {
  handles, route,
  _rtStats, _rtResetStats, _qualityToLowres, _autoLowresForResolution,
  // P1-PROGRESS surface (in-process + poll-based).
  startJob, jobProgress, cancelJob, _getJob,
  CancellationToken, CancellationError,
  // Shared mpjpeg framing (runtime + benchmark + tests).
  createMpjpegReassembler,
};
