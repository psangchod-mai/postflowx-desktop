#!/usr/bin/env node
// imf_rt_bench.mjs — sustained-throughput benchmark for the IMF Direct Engine's
// persistent decode pipeline (verifies P0-RT-REDUCED: the reduced-resolution
// ladder is what lets UHD/HD sustain real-time on CPU).
//
// WHAT IT MEASURES
//   The engine plays continuous IMF through ONE long-lived ffmpeg that muxes
//   `-f mpjpeg` to a pipe; the main process carves complete JPEGs out of that
//   byte stream with createMpjpegReassembler() (electron/imf/imf_direct_engine.js).
//   This tool spawns the SAME ffmpeg mpjpeg pipe and runs the frames through the
//   SAME reassembler, then reports sustained fps at Full / Half(lowres1) /
//   Quarter(lowres2).
//
// THREE MODES
//   1) Synthetic (default): no in-tree IMF asset exists, so we generate a clip
//      with the bundled ffmpeg (lavfi testsrc2) at HD (1280x720 / 1920x1080) and
//      a UHD variant (3840x2160). testsrc2 is a raw source (no J2K decoder), so
//      the reduce "ladder" is emulated by decode-side output scale to exercise
//      the mpjpeg reassembly + pipe throughput deterministically.
//   2) Synthetic-J2K (--j2k): encodes a representative jpeg2000 clip once, then
//      decodes it at the TRUE `-lowres 0|1|2` DWT reduce-level — the real reduced-
//      decode cost, with no external IMF asset required. This is the in-suite fps
//      proof for P0-RT-REDUCED (see tests-js/imfRtBenchJ2k.test.mjs):
//        node tools/imf_rt_bench.mjs --j2k --res hd
//        node tools/imf_rt_bench.mjs --j2k --res uhd --frames 96
//   3) Real IMF: point it at an actual package to measure the true J2K -lowres
//      decode cost on real content (the number that matters most for playback):
//        node tools/imf_rt_bench.mjs --imf /path/to/IMF_PACKAGE_FOLDER
//        node tools/imf_rt_bench.mjs --assetmap /path/ASSETMAP.xml --cpl /path/CPL_x.xml
//
// The heavy ffmpeg passes are the whole point of THIS tool, so it is NOT part of
// CI. CI covers the deterministic reassembly logic in
// tests-js/imfMpjpegReassembler.test.mjs (no ffmpeg). Run this manually:
//   node tools/imf_rt_bench.mjs
//   node tools/imf_rt_bench.mjs --res uhd --seconds 3
//   node tools/imf_rt_bench.mjs --imf /Volumes/MEDIA/MyIMP
//
// USAGE
//   --res hd|uhd     synthetic source resolution (default hd = 1920x1080)
//   --seconds N      synthetic clip duration per level (default 2)
//   --fps N          synthetic source fps (default 24)
//   --j2k            synthetic-J2K: encode jpeg2000 then measure true -lowres decode
//   --frames N       synthetic-J2K frame count (default 96)
//   --imf DIR        real IMF: package folder (auto-finds ASSETMAP + first CPL)
//   --assetmap FILE  real IMF: explicit ASSETMAP.xml
//   --cpl FILE       real IMF: explicit CPL.xml
//   --json           emit machine-readable JSON result

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dir  = path.dirname(fileURLToPath(import.meta.url));
const root   = path.resolve(__dir, '..');

// Reuse the ACTUAL runtime reassembler + ffmpeg resolution so the benchmark and
// production carve frames identically.
const { createMpjpegReassembler } = require(path.join(root, 'electron/imf/imf_direct_engine.js'));
let FFMPEG = 'ffmpeg';
try { ({ FFMPEG } = require(path.join(root, 'electron/native/ffbins'))); }
catch {
  for (const c of [path.join(root, 'bin/ffmpeg'), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    if (fs.existsSync(c)) { FFMPEG = c; break; }
  }
}

// ── arg parsing ────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { res: 'hd', seconds: 2, fps: 24, frames: 96, imf: null, assetmap: null, cpl: null, j2k: false, json: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--res')       a.res = argv[++i];
    else if (t === '--seconds') a.seconds = Number(argv[++i]) || 2;
    else if (t === '--fps')  a.fps = Number(argv[++i]) || 24;
    else if (t === '--frames') a.frames = Number(argv[++i]) || 96;
    else if (t === '--j2k')  a.j2k = true;
    else if (t === '--imf')  a.imf = argv[++i];
    else if (t === '--assetmap') a.assetmap = argv[++i];
    else if (t === '--cpl')  a.cpl = argv[++i];
    else if (t === '--json') a.json = true;
    else if (t === '--help' || t === '-h') { printHelp(); process.exit(0); }
  }
  return a;
}
function printHelp() {
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(lines.slice(1, 54).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
}

// ── ffmpeg arg builders ─────────────────────────────────────────────────────────
// Synthetic: emulate the reduce ladder with an output scale divisor so the pipe
// throughput + reassembly are exercised at three frame sizes.
function syntheticArgs({ w, h, fps, seconds, divisor }) {
  const ow = Math.max(2, Math.round(w / divisor) & ~1);
  const oh = Math.max(2, Math.round(h / divisor) & ~1);
  return [
    '-v', 'error',
    '-f', 'lavfi',
    '-i', `testsrc2=size=${w}x${h}:rate=${fps}:duration=${seconds}`,
    '-an',
    '-vf', `scale=${ow}:${oh}`,
    '-c:v', 'mjpeg', '-q:v', '5',
    '-f', 'mpjpeg', 'pipe:1',
  ];
}
// Synthetic-J2K: encode a representative JPEG 2000 clip once, so we can measure the
// TRUE `-lowres` DWT reduce-level decode cost without needing an external IMF asset.
// Returns the clip path, or null if the ffmpeg build can't encode jpeg2000.
function encodeSyntheticJ2K({ w, h, fps, frames, dir }) {
  const out = path.join(dir, `j2k_${w}x${h}.mov`);
  const r = spawnSync(FFMPEG, [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=${fps}`,
    '-frames:v', String(frames),
    '-c:v', 'jpeg2000', '-pix_fmt', 'yuv422p',
    '-y', out,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0 || !fs.existsSync(out)) {
    return { ok: false, error: (r.stderr && r.stderr.toString().slice(-200)) || `encode exit ${r.status}` };
  }
  return { ok: true, path: out };
}
// Decode a real J2K clip at the given DWT reduce-level (`-lowres`, a decoder option
// → must precede -i), re-muxing to the same mpjpeg pipe the runtime uses.
function j2kArgs({ file, lowres, outW }) {
  const args = ['-v', 'error'];
  if (lowres > 0) args.push('-lowres', String(lowres));
  args.push('-i', file, '-an', '-vf', `scale=${outW}:-2`, '-c:v', 'mjpeg', '-q:v', '5', '-f', 'mpjpeg', 'pipe:1');
  return args;
}
// Real IMF: the genuine J2K DWT reduce-level via `-lowres` (decoder option → must
// precede -i), matching _startFFmpegStream in the engine.
function imfArgs({ assetmap, cpl, lowres, outW }) {
  const args = ['-v', 'error', '-f', 'imf', '-assetmaps', assetmap];
  if (lowres > 0) args.push('-lowres', String(lowres));
  args.push('-i', cpl, '-an', '-vf', `scale=${outW}:-2`, '-c:v', 'mjpeg', '-q:v', '5', '-f', 'mpjpeg', 'pipe:1');
  return args;
}

// Run one ffmpeg mpjpeg pass through the shared reassembler; return timing.
function runPass(args) {
  return new Promise((resolve) => {
    let frames = 0;
    const asm = createMpjpegReassembler(() => { frames++; });
    const t0 = process.hrtime.bigint();
    const p = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    p.stdout.on('data', (chunk) => asm.push(chunk));
    p.stderr.on('data', (d) => { stderr += d.toString(); });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => {
      const secs = Number(process.hrtime.bigint() - t0) / 1e9;
      resolve({ ok: code === 0 && frames > 0, frames, seconds: secs, fps: secs > 0 ? frames / secs : 0, code, stderr: stderr.slice(-300) });
    });
  });
}

function findAssetmapCpl(dir) {
  const files = fs.readdirSync(dir);
  const am = files.find(f => /^ASSETMAP(\.xml)?$/i.test(f)) || files.find(f => /assetmap/i.test(f) && /\.xml$/i.test(f));
  const cpl = files.find(f => /^CPL/i.test(f) && /\.xml$/i.test(f))
    || files.find(f => /\.xml$/i.test(f) && !/assetmap|^pkl|packing/i.test(f));
  return {
    assetmap: am ? path.join(dir, am) : null,
    cpl:      cpl ? path.join(dir, cpl) : null,
  };
}

const LEVELS = [
  { name: 'Full',            key: 'full',    divisor: 1, lowres: 0 },
  { name: 'Half (lowres1)',  key: 'half',    divisor: 2, lowres: 1 },
  { name: 'Quarter (lowres2)', key: 'quarter', divisor: 4, lowres: 2 },
];

async function main() {
  const a = parseArgs(process.argv);
  const realMode = !!(a.imf || (a.assetmap && a.cpl));
  let assetmap = a.assetmap, cpl = a.cpl;
  if (a.imf) { ({ assetmap, cpl } = findAssetmapCpl(a.imf)); }

  const out = { mode: realMode ? 'real-imf' : (a.j2k ? 'synthetic-j2k' : 'synthetic'), ffmpeg: FFMPEG, results: [] };

  if (!realMode && a.j2k) {
    // Synthetic-J2K: encode once, then measure TRUE -lowres decode cost per level.
    const dim = a.res === 'uhd' ? { w: 3840, h: 2160 } : { w: 1920, h: 1080 };
    out.source = { ...dim, fps: a.fps, frames: a.frames };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfx-j2k-bench-'));
    try {
      const enc = encodeSyntheticJ2K({ ...dim, fps: a.fps, frames: a.frames, dir });
      if (!enc.ok) {
        out.error = `jpeg2000 encode unavailable: ${enc.error}`;
        if (a.json) { console.log(JSON.stringify(out, null, 2)); return; }
        console.error(out.error, '\n  (this ffmpeg build lacks a usable jpeg2000 encoder)');
        process.exit(3);
      }
      if (!a.json) {
        console.log(`IMF synthetic-J2K benchmark (TRUE -lowres DWT reduce-level decode)`);
        console.log(`  source: jpeg2000 ${dim.w}x${dim.h} ${a.frames} frames   ffmpeg: ${FFMPEG}\n`);
      }
      for (const lvl of LEVELS) {
        const r = await runPass(j2kArgs({ file: enc.path, lowres: lvl.lowres, outW: 1920 }));
        out.results.push({ level: lvl.name, lowres: lvl.lowres, ...r });
        if (!a.json) reportLine(lvl.name, r);
      }
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  } else if (realMode) {
    if (!assetmap || !cpl || !fs.existsSync(assetmap) || !fs.existsSync(cpl)) {
      console.error('Could not resolve ASSETMAP + CPL. Pass --assetmap and --cpl explicitly.');
      process.exit(2);
    }
    out.assetmap = assetmap; out.cpl = cpl;
    if (!a.json) console.log(`IMF real-mode benchmark\n  ASSETMAP: ${assetmap}\n  CPL:      ${cpl}\n`);
    for (const lvl of LEVELS) {
      const r = await runPass(imfArgs({ assetmap, cpl, lowres: lvl.lowres, outW: 1920 }));
      out.results.push({ level: lvl.name, ...r });
      if (!a.json) reportLine(lvl.name, r);
    }
  } else {
    const dim = a.res === 'uhd' ? { w: 3840, h: 2160 } : { w: 1920, h: 1080 };
    out.source = { ...dim, fps: a.fps, seconds: a.seconds };
    if (!a.json) {
      console.log(`IMF synthetic benchmark (mpjpeg reassembly + pipe throughput)`);
      console.log(`  source: testsrc2 ${dim.w}x${dim.h}@${a.fps}fps ${a.seconds}s   ffmpeg: ${FFMPEG}`);
      console.log(`  NOTE: synthetic mode emulates the reduce ladder with output scale (no J2K decoder).`);
      console.log(`        Use --imf <folder> for the true -lowres J2K decode cost.\n`);
    }
    for (const lvl of LEVELS) {
      const r = await runPass(syntheticArgs({ ...dim, fps: a.fps, seconds: a.seconds, divisor: lvl.divisor }));
      out.results.push({ level: lvl.name, divisor: lvl.divisor, ...r });
      if (!a.json) reportLine(lvl.name, r);
    }
  }

  if (a.json) { console.log(JSON.stringify(out, null, 2)); return; }

  // Real-time verdict against a 24fps cadence for the reduced levels.
  console.log('\nReal-time cadence (target 23.976/24 fps):');
  for (const r of out.results) {
    if (!r.ok) continue;
    const verdict = r.fps >= 23.976 ? 'CLEARS' : 'MISSES';
    console.log(`  ${r.level.padEnd(20)} ${r.fps.toFixed(1).padStart(7)} fps  ${verdict}`);
  }
}

function reportLine(name, r) {
  if (!r.ok) { console.log(`  ${name.padEnd(20)} FAILED (exit ${r.code}) ${r.error || r.stderr || ''}`); return; }
  console.log(`  ${name.padEnd(20)} ${r.frames} frames in ${r.seconds.toFixed(2)}s → ${r.fps.toFixed(1)} fps`);
}

main().catch((e) => { console.error(e); process.exit(1); });
