'use strict';

/**
 * ffbins.js — Absolute ffmpeg/ffprobe path resolution.
 *
 * Electron apps launched from Finder/Dock inherit a stripped macOS PATH
 * (/usr/bin:/bin:/usr/sbin:/sbin) with NO /opt/homebrew/bin. A bare
 * spawn('ffprobe') therefore fails with ENOENT only in the packaged app —
 * never when launched from a terminal — which masks the bug in dev.
 *
 * Resolve the absolute path once at module load so every spawn site agrees.
 * Falls back to the bare name (PATH lookup) if no known location exists, so
 * a properly-configured PATH still works.
 *
 * Mirrors the _resolveBin pattern already used in imf/imf_ffmpeg_backend.js
 * and ipc.js — centralised here so media_engine.js and native_router.js
 * don't each re-implement (and forget) it.
 */

const fs = require('fs');

function _resolveBin(name, candidates) {
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return name; // bare name → rely on PATH (works in dev / terminal launches)
}

const FFMPEG  = _resolveBin('ffmpeg',  ['/opt/homebrew/bin/ffmpeg',  '/usr/local/bin/ffmpeg',  '/usr/bin/ffmpeg']);
const FFPROBE = _resolveBin('ffprobe', ['/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe']);

// Bare string fallback means the binary was not found at any known absolute path.
const FFMPEG_MISSING  = FFMPEG  === 'ffmpeg';
const FFPROBE_MISSING = FFPROBE === 'ffprobe';

module.exports = { FFMPEG, FFPROBE, FFMPEG_MISSING, FFPROBE_MISSING };
