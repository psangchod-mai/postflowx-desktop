'use strict';

/**
 * media_engine.js — PostFlowX Native Media Engine
 *
 * Owns all native media operations in the macOS app:
 *   - Still extraction via AVFoundation (avf_bridge.swift binary)
 *   - Media info probing (codec, fps, resolution, timecode)
 *   - Hero frame generation (7 frames per shot)
 *   - OCF still extraction (Resolve → AVFoundation → FFmpeg)
 *   - Player session management
 *   - pfx-media:// protocol handler (native file serving for <video>)
 *
 * Registered to pfx:media IPC channel in ipc.js.
 * Protocol registered in main.js via registerProtocol().
 */

const { spawn }    = require('child_process');
const { protocol } = require('electron');
const path         = require('path');
const fs           = require('fs');
const { Readable } = require('stream');
// Absolute ffmpeg/ffprobe paths — a GUI-launched app has a stripped PATH with
// no /opt/homebrew/bin, so a bare spawn('ffprobe') would ENOENT in production.
const { FFMPEG, FFPROBE } = require('./ffbins');

// avf_bridge binary lives next to this file. In packaged builds this module runs
// from inside app.asar, but the binary is unpacked — spawning a path inside the
// asar archive fails with ENOTDIR, so redirect to the app.asar.unpacked copy.
const AVF_BRIDGE = path.join(__dirname, 'avf_bridge')
  .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);

// ProRes codec FourCCs — Chromium <video> cannot decode these; need transcode or native player
const PRORES_CODECS = new Set(['apcn', 'apco', 'apcs', 'apch', 'ap4h', 'ap4x', 'apns']);

// Player sessions: playerId → { path, role, info, state, srcUrl }
const _sessions = new Map();
let _nextId     = 1;
let _companion  = null;

// ── Init ──────────────────────────────────────────────────────────────────────

function init(companionInstance) {
  _companion = companionInstance;
}

// ── pfx-media:// protocol ─────────────────────────────────────────────────────

/**
 * Register the pfx-media:// scheme as a privileged, streamable custom protocol.
 * MUST be called before app.whenReady() via protocol.registerSchemesAsPrivileged().
 * The actual handler is installed later via installProtocolHandler().
 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'pfx-media',
    // corsEnabled: required for the renderer to fetch() frames from this scheme
    // (cross-origin from the file:// page). Without it fetch fails "Failed to fetch".
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
  }]);
}

/**
 * Install the pfx-media:// request handler.
 * Call this after app.whenReady(), before loading any page.
 *
 * URL format: pfx-media://localfile/<encodeURIComponent(absolute-path)>
 * Supports Range requests so <video> can scrub natively.
 */
function installProtocolHandler() {
  protocol.handle('pfx-media', (request) => {
    let filePath;
    try {
      const url = new URL(request.url);
      if (url.hostname === 'localfile') {
        filePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
      } else if (url.hostname) {
        // Back-compat for older builds that emitted pfx-media:///Users/...
        // under a standard custom scheme. Chromium canonicalizes that as
        // pfx-media://users/... so reconstruct the absolute POSIX path.
        filePath = `/${decodeURIComponent(url.hostname)}${decodeURIComponent(url.pathname)}`;
      } else {
        filePath = decodeURIComponent(url.pathname);
      }
    } catch {
      return new Response(null, { status: 400 });
    }

    // Security: only allow absolute paths inside the filesystem, no path traversal
    filePath = path.normalize(filePath);
    if (!path.isAbsolute(filePath)) {
      return new Response(null, { status: 403 });
    }

    let stat;
    try { stat = fs.statSync(filePath); }
    catch { return new Response(null, { status: 404 }); }

    const mime        = _mimeForPath(filePath);
    const rangeHeader = request.headers.get('range');

    if (rangeHeader) {
      // Parse "bytes=start-end"
      const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      if (!m) return new Response(null, { status: 416 });

      const start  = parseInt(m[1], 10);
      const end    = m[2] ? parseInt(m[2], 10) : stat.size - 1;
      const length = end - start + 1;

      if (start >= stat.size || end >= stat.size || start > end) {
        return new Response(null, {
          status: 416,
          headers: { 'Content-Range': `bytes */${stat.size}` },
        });
      }

      // Stream the range — use Web ReadableStream for Electron 42 compatibility
      const nodeStream = fs.createReadStream(filePath, { start, end });
      const webStream  = Readable.toWeb(nodeStream);

      return new Response(webStream, {
        status: 206,
        headers: {
          'Content-Range':  `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges':  'bytes',
          'Content-Length': String(length),
          'Content-Type':   mime,
          // pfx-media:// is a distinct origin from the file:// renderer, so a
          // renderer fetch() of a frame is cross-origin. Without this header the
          // fetch is blocked ("Failed to fetch") and the blob would taint the
          // canvas (breaking scopes). Allow it — everything served is local.
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // Full file — stream it
    const nodeStream = fs.createReadStream(filePath);
    const webStream  = Readable.toWeb(nodeStream);

    return new Response(webStream, {
      status: 200,
      headers: {
        'Content-Length': String(stat.size),
        'Content-Type':   mime,
        'Accept-Ranges':  'bytes',
        'Access-Control-Allow-Origin': '*',   // allow renderer fetch() of frames (local only)
      },
    });
  });
}

function _mimeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.mov': 'video/quicktime',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mxf': 'video/x-mxf',
    '.r3d': 'video/x-red',
    '.ari': 'video/x-arri',
    '.mts': 'video/mp2t',
    '.m2ts': 'video/mp2t',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.exr': 'image/x-exr',
    '.dpx': 'image/x-dpx',
  };
  return map[ext] || 'application/octet-stream';
}

// ── avf_bridge runner ─────────────────────────────────────────────────────────

function _avfBridgeAvailable() {
  try { return fs.existsSync(AVF_BRIDGE) && fs.statSync(AVF_BRIDGE).size > 0; }
  catch { return false; }
}

function _runAvfBridge(command, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!_avfBridgeAvailable()) {
      return reject(new Error(`avf_bridge binary not found: ${AVF_BRIDGE}`));
    }

    const proc = spawn(AVF_BRIDGE, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Settle guard: once the timeout rejects, a subsequent 'close' (the killed
    // process exiting) must not also resolve/reject. Otherwise a partial-stdout
    // parse error could overwrite the clearer "timed out" rejection in logs.
    let settled = false;
    const done = (fn) => { if (!settled) { settled = true; fn(); } };

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      done(() => reject(new Error('avf_bridge timed out')));
    }, timeoutMs);

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', () => {
      clearTimeout(timer);
      if (stderr.trim()) {
        _logBridgeError('avf-bridge', stderr.trim());
      }
      done(() => {
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch (e) {
          reject(new Error(
            `avf_bridge parse error: ${e.message}. stdout: ${stdout.slice(0, 200)}`));
        }
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      done(() => reject(new Error(`avf_bridge spawn failed: ${err.message}`)));
    });

    proc.stdin.write(JSON.stringify(command));
    proc.stdin.end();
  });
}

function _logBridgeError(name, text) {
  try {
    const { app } = require('electron');
    const logDir  = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, `${name}.log`),
      `[${new Date().toISOString()}]\n${text}\n---\n`,
    );
  } catch {}
}

// ── Companion proxy ───────────────────────────────────────────────────────────

async function _viaCompanion(action, payload = {}, timeoutMs = 60000) {
  if (!_companion?.isReady) {
    throw Object.assign(new Error('Companion unavailable'), { code: 'COMPANION_UNAVAILABLE' });
  }
  const resp = await _companion.call({ action, ...payload }, timeoutMs);
  if (resp?.status === 'error' || resp?.error) {
    const e = resp.error || {};
    throw Object.assign(
      new Error(e.message || e.userMessage || 'Companion error'),
      { code: e.code || 'COMPANION_ERROR' },
    );
  }
  return resp?.data ?? resp ?? {};
}

// ── Session management ────────────────────────────────────────────────────────

function _makePlayerId() {
  return `pfx-player-${_nextId++}`;
}

function _buildSrcUrl(filePath, info) {
  const codec = (info?.codec || '').toLowerCase();
  // ProRes is never decodable by Chromium on any platform — route to native player.
  if (PRORES_CODECS.has(codec)) return null;
  return `pfx-media://localfile/${encodeURIComponent(filePath)}`;
}

async function ffprobeInfo({ path: filePath } = {}) {
  if (!filePath) throw new Error('path required');
  return new Promise((resolve, reject) => {
    const proc = spawn(FFPROBE, [
      '-v', 'error',
      '-show_streams',
      '-show_format',
      '-of', 'json',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const timer = setTimeout(() => { proc.kill('SIGTERM'); reject(new Error('ffprobe timed out')); }, 15000);
    let stdout = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const data    = JSON.parse(stdout.trim());
        const vStream = (data.streams || []).find(s => s.codec_type === 'video') || {};
        const codec_name       = vStream.codec_name       || '';
        const codec_tag_string = vStream.codec_tag_string || '';
        const container        = (data.format?.format_name || '').split(',')[0];
        const duration         = parseFloat(data.format?.duration) || 0;
        const fpsStr = vStream.r_frame_rate || vStream.avg_frame_rate || '';
        let fps = 0;
        if (fpsStr.includes('/')) {
          const [n, d] = fpsStr.split('/').map(Number);
          fps = d > 0 ? n / d : 0;
        } else {
          fps = parseFloat(fpsStr) || 0;
        }
        resolve({
          ok: true,
          codec_name,
          codec_tag_string,
          container,
          duration,
          fps,
          width:   vStream.width  || 0,
          height:  vStream.height || 0,
          streams: data.streams   || [],
          format:  data.format    || {},
        });
      } catch (e) {
        reject(new Error(`ffprobe parse error: ${e.message}`));
      }
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(new Error(`ffprobe spawn failed: ${err.message}`)); });
  });
}

// ── Media commands ────────────────────────────────────────────────────────────

async function open({ path: filePath, role = 'qtRef' } = {}) {
  if (!filePath) throw new Error('path required');

  let info = null;
  try {
    info = await getInfo({ path: filePath });
  } catch (e) {
    // avf_bridge / probe failed for this file — build a best-effort srcUrl anyway.
    // Works for H.264/HEVC/MOV. ProRes will be null (requiresTranscode=true path).
    console.warn('[media.open] getInfo failed, using fallback srcUrl:', e.message);
  }

  const playerId = _makePlayerId();
  // Use path.extname (not split('.')) so paths with a dotted directory and no file
  // extension — e.g. /Volumes/My.Footage/CLIP — aren't misread as extension "footage/clip".
  const ext      = path.extname(filePath).slice(1).toLowerCase();
  const h264Like = ['mp4', 'mov', 'mkv', 'm4v', 'hevc', 'h264', 'mts', 'm2ts'].includes(ext);
  const srcUrl   = info
    ? _buildSrcUrl(filePath, info)
    : (h264Like ? `pfx-media://localfile/${encodeURIComponent(filePath)}` : null);

  _sessions.set(playerId, {
    path:    filePath,
    role,
    info,
    srcUrl,
    state: { playing: false, frame: 0, rate: 1 },
  });

  return { ok: true, playerId, info, srcUrl, requiresTranscode: srcUrl === null };
}

async function close({ playerId } = {}) {
  _sessions.delete(playerId);
  return { ok: true };
}

async function getInfo({ path: filePath, playerId } = {}) {
  const fp = filePath || _sessions.get(playerId)?.path;
  if (!fp) throw new Error('path or playerId required');

  const r = await _runAvfBridge({ action: 'getInfo', path: fp }, 15000);
  if (!r.ok) throw new Error(r.error || 'getInfo failed');
  return r;
}

async function getStill({ playerId, path: filePath, frame, timecode, outputWidth = 960, quality = 0.88 } = {}) {
  const fp = filePath || _sessions.get(playerId)?.path;
  if (!fp) throw new Error('path or playerId required');

  const r = await _runAvfBridge({
    action: 'getStill',
    path: fp,
    frame,
    timecode,
    outputWidth,
    quality,
  }, 30000);

  if (!r.ok) throw new Error(r.error || 'getStill failed');
  return r;
}

async function getHeroFrames({ playerId, path: filePath, frames = [], outputWidth = 960, quality = 0.85 } = {}) {
  const fp = filePath || _sessions.get(playerId)?.path;
  if (!fp) throw new Error('path or playerId required');
  if (!frames.length) return { ok: true, frames: [], decoder: 'AVFoundation' };

  const r = await _runAvfBridge({
    action: 'getHeroFrames',
    path: fp,
    frames,
    outputWidth,
    quality,
  }, 120000);

  if (!r.ok) throw new Error(r.error || 'getHeroFrames failed');
  return r;
}

/**
 * Extract a still from OCF/camera-original footage.
 * Decoder priority:
 *   1. Resolve Engine (best for RAW — ARRI/RED/Sony)
 *   2. AVFoundation (ProRes OCF, HEVC, H.264 camera originals)
 *   3. FFmpeg via companion (last resort)
 */
async function getOcfStill({
  ocfPath,
  sourceTc,
  sourceStartTc = '',   // OCF embedded free-run start TC — seek RELATIVE to this
  fps = 0,
  sourceFrame,
  outputWidth = 960,
  colorPreviewMode = 'rec709',
} = {}) {
  if (!ocfPath) throw new Error('ocfPath required');

  // Tier 1: Resolve Engine (self-discovers the clip Start TC; sourceStartTc passed for parity)
  if (_companion?.isReady) {
    try {
      const r = await _viaCompanion('vfx.preview.resolveStill', {
        ocfPath, sourceTc, sourceStartTc, fps, sourceFrame, outputWidth, colorPreviewMode,
      }, 90000);
      if (r?.dataUrl || r?.imageDataUrl) {
        return { ok: true, decoder: 'Resolve Engine', extractor: 'resolve', ...r };
      }
    } catch (err) {
      if (err.code === 'COMPANION_UNAVAILABLE') { /* fall through */ }
    }
  }

  // Tier 2: AVFoundation (avf_bridge) — startTimecode lets the bridge seek to
  // (sourceTc − startTimecode) instead of the absolute-from-zero frame.
  if (_avfBridgeAvailable()) {
    try {
      const r = await _runAvfBridge({
        action: 'getStill',
        path: ocfPath,
        timecode: sourceTc,
        startTimecode: sourceStartTc,
        frame: sourceFrame,
        outputWidth,
        quality: 0.88,
      }, 30000);
      if (r?.ok && r?.dataUrl) {
        return { ok: true, decoder: 'AVFoundation', extractor: 'avf', ...r };
      }
    } catch { /* fall through */ }
  }

  // Tier 3: FFmpeg via companion (seeks relative to sourceStartTc)
  if (_companion?.isReady) {
    try {
      const r = await _viaCompanion('vfx.preview.avfStill', {
        ocfPath, sourceTc, sourceStartTc, fps, sourceFrame, outputWidth,
      }, 30000);
      if (r?.dataUrl || r?.imageDataUrl) {
        return { ok: true, decoder: 'FFmpeg', extractor: 'ffmpeg', ...r };
      }
    } catch {}
  }

  return { ok: false, error: 'All decoders failed for OCF still extraction', stage: 'all_failed' };
}

// Playback state commands — update session state.
// Actual <video> control stays in the renderer; these keep server-side state in sync.

async function play({ playerId } = {}) {
  const s = _sessions.get(playerId);
  if (s) s.state.playing = true;
  return { ok: true };
}

async function pause({ playerId } = {}) {
  const s = _sessions.get(playerId);
  if (s) s.state.playing = false;
  return { ok: true };
}

async function seek({ playerId, frame, timecode } = {}) {
  const s = _sessions.get(playerId);
  if (!s) return { ok: false, error: 'Unknown playerId' };

  if (timecode && s.info?.fps) {
    const [h, m, sec, f] = String(timecode).split(/[:;]/).map(Number);
    // Nominal (rounded) fps for HH:MM:SS:FF counting, not the exact NTSC rate —
    // see src/scripts/modules/utils_time.js's nominalBase() for the "two-rate contract".
    const nominalFps = Math.round(s.info.fps) || 24;
    s.state.frame = Math.round(((h * 3600 + m * 60 + sec) * nominalFps) + (f || 0));
  } else if (frame != null) {
    s.state.frame = frame;
  }
  return { ok: true, frame: s.state.frame };
}

async function stepFrame({ playerId, delta = 1 } = {}) {
  const s = _sessions.get(playerId);
  if (!s) return { ok: false, error: 'Unknown playerId' };
  s.state.frame = Math.max(0, (s.state.frame || 0) + delta);
  return { ok: true, frame: s.state.frame };
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

async function getDiagnostics() {
  const avfAvailable = _avfBridgeAvailable();
  const companionReady = !!_companion?.isReady;

  let resolveConnected = false;
  if (companionReady) {
    try {
      const r = await _viaCompanion('resolveStatus', {}, 8000);
      resolveConnected = !!r?.connected;
    } catch {}
  }

  // Check ffmpeg
  let ffmpegAvailable = false;
  try {
    const r = await new Promise((res) => {
      const p = spawn(FFPROBE, ['-version'], { stdio: 'pipe' });
      p.on('close', (c) => res(c === 0));
      p.on('error', () => res(false));
      setTimeout(() => { p.kill(); res(false); }, 3000);
    });
    ffmpegAvailable = r;
  } catch {}

  return {
    ok: true,
    avFoundationReady: avfAvailable,
    videoToolboxReady: avfAvailable,  // VideoToolbox is used by AVFoundation on macOS
    resolveConnected,
    ffmpegFallbackAvailable: ffmpegAvailable,
    companionReady,
    activeSessions: _sessions.size,
  };
}

// ── IMF audio extraction ──────────────────────────────────────────────────────
// Decode a reel's MXF audio essence to planar 32-bit-float PCM for the renderer's
// AudioContext-driven IMF player. Returns deinterleaved { left, right } Float32Arrays
// at the requested sample rate. Many IMF *video* MXF essences carry no audio (audio
// lives in a separate essence file), so we probe first and return { ok:false } when
// there is no audio stream — the renderer audio engine then silently stays muted.
//
// NOTE: this extracts from the single MXF path it is given. Full IMF playback with
// audio in a separate essence file would require resolving the CPL audio resource to
// its own MXF; that is out of scope here and would be a follow-up.
async function extractAudio({ mxfPath, sampleRate = 48000, channels = 2, maxSeconds = 300 } = {}) {
  if (!mxfPath || !fs.existsSync(mxfPath)) {
    return { ok: false, error: 'mxfPath not found' };
  }
  const ch = channels === 1 ? 1 : 2;
  const secs = Math.max(1, Math.min(3600, maxSeconds | 0 || 300));

  // 1. Probe for an audio stream — avoids spawning a doomed ffmpeg on video-only MXF.
  const hasAudio = await new Promise((res) => {
    const p = spawn(FFPROBE, [
      '-v', 'error', '-select_streams', 'a',
      '-show_entries', 'stream=index', '-of', 'csv=p=0', mxfPath,
    ], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d.toString(); });
    p.on('close', () => res(out.trim().length > 0));
    p.on('error', () => res(false));
    setTimeout(() => { try { p.kill(); } catch {} res(out.trim().length > 0); }, 8000);
  });
  if (!hasAudio) return { ok: false, error: 'no audio stream' };

  // 2. Decode → raw interleaved f32le at the target rate / channel count.
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-i', mxfPath,
      '-map', '0:a:0',
      '-t', String(secs),
      '-ac', String(ch),
      '-ar', String(sampleRate),
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      'pipe:1',
    ];
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let size = 0;
    const maxBytes = sampleRate * ch * 4 * secs + (1 << 20); // hard safety cap
    p.stdout.on('data', (d) => {
      chunks.push(d);
      size += d.length;
      if (size > maxBytes) { try { p.kill(); } catch {} }
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', () => {
      if (!chunks.length) return resolve({ ok: false, error: err.trim() || 'no pcm output' });
      const raw = Buffer.concat(chunks);
      // Copy to a fresh, 4-byte-aligned ArrayBuffer (Buffer pooling may hand us a
      // non-aligned byteOffset, which would make the Float32Array view throw).
      const usable = raw.length & ~3;
      const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + usable);
      const interleaved = new Float32Array(ab);
      const frames = Math.floor(interleaved.length / ch);
      const left = new Float32Array(frames);
      const right = new Float32Array(frames);
      if (ch === 1) {
        for (let i = 0; i < frames; i++) { left[i] = interleaved[i]; right[i] = interleaved[i]; }
      } else {
        for (let i = 0; i < frames; i++) { left[i] = interleaved[i * 2]; right[i] = interleaved[i * 2 + 1]; }
      }
      resolve({ ok: true, pcm: { left, right, sampleRate } });
    });
    setTimeout(() => { try { p.kill(); } catch {} }, Math.min(180000, secs * 1000 + 30000));
  });
}

// ── Main route dispatcher ─────────────────────────────────────────────────────

const HANDLED = new Set([
  'media.open', 'media.close',
  'media.play', 'media.pause', 'media.seek', 'media.stepFrame',
  'media.getInfo', 'media.getStill', 'media.getHeroFrames',
  'media.getOcfStill', 'media.diagnostics', 'media.ffprobeInfo',
]);

function handles(type) { return HANDLED.has(type); }

async function route({ type, payload = {} }) {
  switch (type) {
    case 'media.open':         return open(payload);
    case 'media.close':        return close(payload);
    case 'media.play':         return play(payload);
    case 'media.pause':        return pause(payload);
    case 'media.seek':         return seek(payload);
    case 'media.stepFrame':    return stepFrame(payload);
    case 'media.getInfo':      return getInfo(payload);
    case 'media.getStill':     return getStill(payload);
    case 'media.getHeroFrames':return getHeroFrames(payload);
    case 'media.getOcfStill':  return getOcfStill(payload);
    case 'media.diagnostics':  return getDiagnostics();
    case 'media.ffprobeInfo':  return ffprobeInfo(payload);
    default:                   throw new Error(`Unknown media action: ${type}`);
  }
}

module.exports = {
  init,
  registerScheme,
  installProtocolHandler,
  handles,
  route,
  // Direct exports for use without IPC dispatch
  open, close, play, pause, seek, stepFrame,
  getInfo, getStill, getHeroFrames, getOcfStill,
  getDiagnostics, ffprobeInfo, extractAudio,
};
