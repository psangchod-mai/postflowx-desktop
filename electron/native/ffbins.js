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
const path = require('path');

// Bundled binaries (Dev Brief P0#2) ship at .app/Contents/Resources/bin/<name>.
// Prefer them over Homebrew so the PRODUCTION app never depends on /opt/homebrew
// (a Finder-launched app has a stripped PATH and no Homebrew). process.resourcesPath
// points at .app/Contents/Resources in a packaged build; in dev it points into the
// Electron framework, where bin/ simply won't exist → harmless miss.
function _bundledCandidates(name) {
  const out = [];
  // Packaged: .app/Contents/Resources/bin/<name>.
  try { if (process.resourcesPath) out.push(path.join(process.resourcesPath, 'bin', name)); } catch {}
  // Dev (npm run dev): process.resourcesPath points into the Electron framework,
  // NOT the repo, so the line above misses the repo's bin/. This file lives at
  // electron/native/ffbins.js → repo root is two dirs up → repo/bin/<name>.
  // Without this, dev falls back to Homebrew ffmpeg which LACKS the IMF demuxer
  // (built only into the bundled binary) → IMF playback shows no decoded pixels.
  try { out.push(path.join(__dirname, '..', '..', 'bin', name)); } catch {}
  const env = process.env[`PFX_${name.toUpperCase()}_BIN`];
  if (env) out.unshift(env);   // explicit override wins
  return out;
}

function _resolveBin(name, candidates) {
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return name; // bare name → rely on PATH (works in dev / terminal launches)
}

const FFMPEG  = _resolveBin('ffmpeg',  [..._bundledCandidates('ffmpeg'),  '/opt/homebrew/bin/ffmpeg',  '/usr/local/bin/ffmpeg',  '/usr/bin/ffmpeg']);
const FFPROBE = _resolveBin('ffprobe', [..._bundledCandidates('ffprobe'), '/opt/homebrew/bin/ffprobe', '/usr/local/bin/ffprobe', '/usr/bin/ffprobe']);

// Bare string fallback means the binary was not found at any known absolute path.
const FFMPEG_MISSING  = FFMPEG  === 'ffmpeg';
const FFPROBE_MISSING = FFPROBE === 'ffprobe';

module.exports = { FFMPEG, FFPROBE, FFMPEG_MISSING, FFPROBE_MISSING };
