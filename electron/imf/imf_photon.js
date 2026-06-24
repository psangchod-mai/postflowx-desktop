'use strict';
// imf_photon.js — Photon JAR validator runner + open-source engine status
// Photon: Netflix open-source IMF validator (https://github.com/Netflix/photon)
// Usage:  java -jar photon.jar -i /path/to/package/

const { execFile, execFileSync } = require('child_process');
const path  = require('path');
const fs    = require('fs');
const os    = require('os');

// ── Photon JAR discovery ──────────────────────────────────────────────────────
// Search order: env var → user config → app bundle → common paths
const PHOTON_ENV_VAR = 'PFX_PHOTON_JAR';

function findPhotonJar() {
  if (process.env[PHOTON_ENV_VAR]) {
    const p = process.env[PHOTON_ENV_VAR];
    if (fs.existsSync(p)) return p;
  }
  const candidates = [
    path.join(os.homedir(), '.postflowx', 'photon.jar'),
    path.join(os.homedir(), 'Library', 'Application Support', 'PostFlowX', 'photon.jar'),
    '/usr/local/share/postflowx/photon.jar',
    '/opt/homebrew/share/postflowx/photon.jar',
    // App bundle resources (packaged)
    path.join(__dirname, '..', '..', 'resources', 'photon.jar'),
    path.join(__dirname, '..', '..', '..', 'Resources', 'photon.jar'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Java discovery ────────────────────────────────────────────────────────────
function findJava() {
  // Try JAVA_HOME first
  if (process.env.JAVA_HOME) {
    const p = path.join(process.env.JAVA_HOME, 'bin', 'java');
    if (fs.existsSync(p)) return p;
  }
  // Common macOS paths
  const candidates = [
    '/usr/bin/java',
    '/usr/local/bin/java',
    '/opt/homebrew/bin/java',
    '/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home/bin/java',
    '/Library/Java/JavaVirtualMachines/openjdk-21.jdk/Contents/Home/bin/java',
    '/Library/Java/JavaVirtualMachines/openjdk.jdk/Contents/Home/bin/java',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  // Last resort: rely on PATH
  return 'java';
}

// ── Run Photon against an IMF package ────────────────────────────────────────
// Returns: { ok, results[], summary, rawOutput, error? }
//   results: [{ id, severity, message, code? }]
//   severity: 'ERROR' | 'WARNING' | 'INFO' | 'PASS'
async function runPhoton(packagePath, { timeoutMs = 90000 } = {}) {
  const jarPath = findPhotonJar();
  if (!jarPath) {
    return {
      ok: false,
      results: [],
      summary: 'Photon JAR not found',
      rawOutput: '',
      error: `photon.jar not found. Install it to: ${path.join(os.homedir(), '.postflowx', 'photon.jar')} or set ${PHOTON_ENV_VAR} env var.`,
    };
  }

  const javaPath = findJava();
  let javaVersion = null;
  try {
    // java -version writes to stderr, not stdout; capture both to handle either JDK variant.
    let vOut = '';
    try { vOut = execFileSync(javaPath, ['-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e2) {
      // execFileSync throws when exit != 0, but java -version may exit 0 with output on stderr.
      // The thrown error object has a .stderr property when stdio captures it.
      vOut = (e2 && e2.stderr) ? String(e2.stderr) : '';
    }
    const m = (vOut + '').match(/version "([^"]+)"/);
    if (m) javaVersion = m[1];
    if (!javaVersion) {
      // Modern JDKs write 'openjdk 21 2023-...' (no quotes) — accept any non-empty output.
      javaVersion = vOut.trim() ? 'detected' : null;
    }
  } catch {
    javaVersion = null;
  }
  if (!javaVersion) {
    return {
      ok: false,
      results: [],
      summary: 'Java not available',
      rawOutput: '',
      error: 'Java runtime not found. Install Java 11+ (Temurin or OpenJDK) to use Photon validation.',
    };
  }

  const assetMapPath = _findAssetMap(packagePath);
  const targetPath = assetMapPath ? path.dirname(assetMapPath) : packagePath;

  return new Promise((resolve) => {
    const args = ['-jar', jarPath, '-i', targetPath, '--printResults'];
    const child = execFile(javaPath, args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = (stdout || '') + (stderr || '');
      if (err && !raw.trim()) {
        resolve({ ok: false, results: [], summary: 'Photon failed to run', rawOutput: raw, error: err.message });
        return;
      }
      const parsed = _parsePhotonOutput(raw);
      resolve({ ok: true, ...parsed, rawOutput: raw });
    });
    void child;
  });
}

function _findAssetMap(dir) {
  if (!dir || !fs.existsSync(dir)) return null;
  const entries = fs.readdirSync(dir);
  const am = entries.find(e => e.toUpperCase() === 'ASSETMAP.xml' || e.toUpperCase() === 'ASSETMAP');
  return am ? path.join(dir, am) : null;
}

// Parse Photon stdout — supports both plain text and XML output modes
function _parsePhotonOutput(raw) {
  const results = [];
  const lines = raw.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // XML format: <ErrorObject>
    const xmlMatch = trimmed.match(/<ErrorObject.*?severity="([^"]+)".*?>(.*?)<\/ErrorObject>/s);
    if (xmlMatch) {
      results.push({ id: '', severity: xmlMatch[1].toUpperCase(), message: xmlMatch[2].replace(/<[^>]+>/g, '').trim(), code: '' });
      continue;
    }

    // Plain text: ERROR | WARNING | INFO prefixed lines
    const textMatch = trimmed.match(/^(ERROR|WARNING|WARN|INFO|PASS|FATAL)\s*[:\-\|]?\s*(.+)$/i);
    if (textMatch) {
      const sev = textMatch[1].toUpperCase().replace('WARN', 'WARNING');
      results.push({ id: '', severity: sev, message: textMatch[2].trim(), code: '' });
      continue;
    }

    // Photon --printResults format: "Severity : Code : Message"
    const colonMatch = trimmed.match(/^(ERROR|WARNING|WARN|INFO|PASS|FATAL)\s*:\s*([^:]+?)\s*:\s*(.+)$/i);
    if (colonMatch) {
      const sev = colonMatch[1].toUpperCase().replace('WARN', 'WARNING');
      results.push({ id: '', severity: sev, code: colonMatch[2].trim(), message: colonMatch[3].trim() });
      continue;
    }
  }

  const errors   = results.filter(r => r.severity === 'ERROR' || r.severity === 'FATAL').length;
  const warnings = results.filter(r => r.severity === 'WARNING').length;
  const passes   = results.filter(r => r.severity === 'PASS' || r.severity === 'INFO').length;
  const summary  = errors > 0
    ? `${errors} error(s), ${warnings} warning(s)`
    : warnings > 0
      ? `${warnings} warning(s) — ${passes} checks passed`
      : `All ${results.length || 'N/A'} checks passed`;

  return { results, summary };
}

// ── Engine status: check all open-source IMF tools ────────────────────────────
// Returns { engines: [{ id, label, status, detail }] }
// status: 'ready' | 'missing' | 'partial'
async function engineStatus() {
  const engines = await Promise.all([
    _checkPhoton(),
    _checkFfmpegImfDemux(),
    _checkOpenJpeg(),
    _checkOpenJph(),
    _checkImscJs(),
    _checkAsdcplib(),
  ]);
  return { engines };
}

async function _checkPhoton() {
  const jarPath = findPhotonJar();
  if (!jarPath) {
    return { id: 'photon', label: 'Photon IMF Validator', status: 'missing', detail: `JAR not found. Copy to ${path.join(os.homedir(), '.postflowx', 'photon.jar')} or set ${PHOTON_ENV_VAR}.` };
  }
  const javaPath = findJava();
  let hasJava = false;
  try {
    execFileSync(javaPath, ['-version'], { stdio: 'ignore', timeout: 4000 });
    hasJava = true;
  } catch { hasJava = false; }
  if (!hasJava) {
    return { id: 'photon', label: 'Photon IMF Validator', status: 'partial', detail: `JAR found at ${path.basename(jarPath)} but Java runtime not available` };
  }
  return { id: 'photon', label: 'Photon IMF Validator', status: 'ready', detail: `JAR: ${path.basename(jarPath)}` };
}

async function _checkFfmpegImfDemux() {
  const ffmpegPath = _findFfmpeg();
  if (!ffmpegPath) {
    return { id: 'ffmpeg-imf', label: 'FFmpeg IMF Demuxer (-f imf)', status: 'missing', detail: 'FFmpeg not found. Install via Homebrew: brew install ffmpeg' };
  }
  let detail = `ffmpeg: ${path.basename(ffmpegPath)}`;
  try {
    const out = execFileSync(ffmpegPath, ['-demuxers'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore','pipe','pipe'] });
    const hasImf = (out || '').toLowerCase().includes(' imf ');
    if (hasImf) {
      return { id: 'ffmpeg-imf', label: 'FFmpeg IMF Demuxer (-f imf)', status: 'ready', detail };
    }
    return { id: 'ffmpeg-imf', label: 'FFmpeg IMF Demuxer (-f imf)', status: 'missing', detail: 'FFmpeg found but IMF demuxer not compiled in' };
  } catch {
    return { id: 'ffmpeg-imf', label: 'FFmpeg IMF Demuxer (-f imf)', status: 'partial', detail: `${detail} — could not query demuxers` };
  }
}

async function _checkOpenJpeg() {
  const ffmpegPath = _findFfmpeg();
  if (!ffmpegPath) {
    return { id: 'openjpeg', label: 'OpenJPEG J2K Decoder', status: 'missing', detail: 'FFmpeg not available' };
  }
  try {
    const out = execFileSync(ffmpegPath, ['-codecs'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore','pipe','pipe'] });
    const hasOpenjpeg = (out || '').includes('libopenjpeg') || (out || '').includes('openjpeg');
    const hasJ2k = (out || '').includes('jpeg2000');
    if (hasOpenjpeg) {
      return { id: 'openjpeg', label: 'OpenJPEG J2K Decoder', status: 'ready', detail: 'libopenjpeg linked in FFmpeg' };
    } else if (hasJ2k) {
      return { id: 'openjpeg', label: 'OpenJPEG J2K Decoder', status: 'partial', detail: 'JPEG 2000 codec present but not libopenjpeg — IMF J2K may be limited' };
    }
    return { id: 'openjpeg', label: 'OpenJPEG J2K Decoder', status: 'missing', detail: 'No JPEG 2000 codec found in FFmpeg. brew install ffmpeg' };
  } catch {
    return { id: 'openjpeg', label: 'OpenJPEG J2K Decoder', status: 'missing', detail: 'Could not query FFmpeg codecs' };
  }
}

async function _checkOpenJph() {
  // OpenJPH (openjph) enables HTJ2K (JPEG 2000 Part 15) in FFmpeg.
  // Standard Homebrew FFmpeg does NOT include openjph.
  const ffmpegPath = _findFfmpeg();
  if (!ffmpegPath) {
    return { id: 'openjph', label: 'OpenJPH / Grok HTJ2K', status: 'missing', detail: 'FFmpeg not available' };
  }
  try {
    const out = execFileSync(ffmpegPath, ['-codecs'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore','pipe','pipe'] });
    const hasOpenjph = (out || '').includes('libopenjph') || (out || '').includes('openjph');
    const hasGrok    = (out || '').includes('libgrok')    || (out || '').includes('grok');
    if (hasOpenjph) {
      return { id: 'openjph', label: 'OpenJPH / Grok HTJ2K', status: 'ready', detail: 'libopenjph linked in FFmpeg — HTJ2K decode supported' };
    } else if (hasGrok) {
      return { id: 'openjph', label: 'OpenJPH / Grok HTJ2K', status: 'ready', detail: 'libgrok linked in FFmpeg — HTJ2K decode supported' };
    }
    // Check if ojph_expand tool is available (standalone)
    let ojphBin = null;
    for (const p of ['/usr/local/bin/ojph_expand', '/opt/homebrew/bin/ojph_expand']) {
      if (fs.existsSync(p)) { ojphBin = p; break; }
    }
    if (ojphBin) {
      return { id: 'openjph', label: 'OpenJPH / Grok HTJ2K', status: 'partial', detail: 'ojph_expand available but FFmpeg lacks libopenjph — HTJ2K via FFmpeg IMF demuxer not supported' };
    }
    return { id: 'openjph', label: 'OpenJPH / Grok HTJ2K', status: 'missing', detail: 'HTJ2K not available. Build FFmpeg with --enable-libopenjph or --enable-libgrok' };
  } catch {
    return { id: 'openjph', label: 'OpenJPH / Grok HTJ2K', status: 'missing', detail: 'Could not query FFmpeg codecs' };
  }
}

async function _checkImscJs() {
  // imscJS is a browser-side library (https://github.com/sandflow/imscJS)
  // It is not a native binary — check if it's bundled in the app source
  const candidates = [
    path.join(__dirname, '..', '..', 'src', 'scripts', 'vendor', 'imsc.all.min.js'),
    path.join(__dirname, '..', '..', 'node_modules', 'imsc', 'dist', 'imsc.all.min.js'),
    path.join(__dirname, '..', '..', 'dist', 'desktop', 'imsc.all.min.js'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return { id: 'imscjs', label: 'imscJS IMSC Subtitle', status: 'ready', detail: `imsc.js found at ${path.relative(path.join(__dirname,'..','..'), p)}` };
    }
  }
  return { id: 'imscjs', label: 'imscJS IMSC Subtitle', status: 'missing', detail: 'imscJS not bundled. npm install imsc or add to src/scripts/vendor/' };
}

async function _checkAsdcplib() {
  // ASDCPlib — check for asdcp-info or asdcp-wrap binaries
  const candidates = [
    '/usr/local/bin/asdcp-info',
    '/opt/homebrew/bin/asdcp-info',
    path.join(os.homedir(), '.postflowx', 'bin', 'asdcp-info'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return { id: 'asdcplib', label: 'ASDCPlib MXF Fallback', status: 'ready', detail: `asdcp-info at ${p}` };
    }
  }
  return { id: 'asdcplib', label: 'ASDCPlib MXF Fallback', status: 'missing', detail: 'asdcp-info not found. Build from https://github.com/cinecert/asdcplib' };
}

function _findFfmpeg() {
  const fromEnv = process.env.PFX_FFMPEG_PATH || process.env.FFMPEG_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const p of ['/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

module.exports = { findPhotonJar, runPhoton, engineStatus };
