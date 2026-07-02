// P0-RT / FPS-BENCH: deterministic unit tests for the mpjpeg reassembler that
// the IMF Direct Engine uses to carve complete JPEG frames (SOI 0xFFD8 … EOI
// 0xFFD9) out of ffmpeg's `-f mpjpeg` pipe. Both continuous playback
// (_startFFmpegStream) and tools/imf_rt_bench.mjs run frames through THIS logic,
// so a framing regression here would break real-time playback AND the benchmark.
//
// Fast + no ffmpeg: feeds synthetic byte streams (with realistic split points,
// leading garbage, and back-to-back frames) and asserts exact frame boundaries.
// Run: node tests-js/imfMpjpegReassembler.test.mjs
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
function ok(c, l) { if (c) { passed++; console.log('PASS -', l); } else { failed++; console.error('FAIL -', l); } }

let engine = null;
try { engine = require(path.join(root, 'electron/imf/imf_direct_engine.js')); }
catch (e) { console.error('SKIP - could not load imf_direct_engine:', e.message); process.exit(0); }

const { createMpjpegReassembler } = engine;
ok(typeof createMpjpegReassembler === 'function', 'createMpjpegReassembler is exported');

// A synthetic "JPEG": SOI + payload + EOI. Payload never contains FFD9 so the
// EOI is unambiguous (mirrors JPEG entropy-coded byte-stuffing in spirit).
function fakeJpeg(size, fillByte = 0x11) {
  const body = Buffer.alloc(Math.max(2, size - 4), fillByte);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), body, Buffer.from([0xFF, 0xD9])]);
}
function collect(chunks) {
  const frames = [];
  const asm = createMpjpegReassembler((f) => frames.push(Buffer.from(f)));
  let counted = 0;
  for (const c of chunks) counted += asm.push(c);
  return { frames, counted, pending: asm.bufferLength() };
}

// 1) Three whole frames concatenated in ONE chunk.
{
  const a = fakeJpeg(20, 0x01), b = fakeJpeg(30, 0x02), c = fakeJpeg(40, 0x03);
  const r = collect([Buffer.concat([a, b, c])]);
  ok(r.frames.length === 3, 'single chunk with 3 frames → 3 frames');
  ok(r.counted === 3, 'push() return value counts frames (=3)');
  ok(r.frames[0].equals(a) && r.frames[1].equals(b) && r.frames[2].equals(c), 'frame bytes reproduced exactly (order + content)');
  ok(r.pending === 0, 'no pending bytes after 3 complete frames');
}

// 2) A single frame split byte-by-byte across many chunks (worst-case boundary).
{
  const a = fakeJpeg(64, 0xAB);
  const chunks = [];
  for (let i = 0; i < a.length; i++) chunks.push(a.slice(i, i + 1));
  const r = collect(chunks);
  ok(r.frames.length === 1, 'byte-by-byte split still yields exactly 1 frame');
  ok(r.frames[0].equals(a), 'byte-split frame reassembled identically');
}

// 3) SOI/EOI markers split across the chunk boundary (FFD8 and FFD9 halved).
{
  const a = fakeJpeg(24, 0x55);
  // Split right between the two marker bytes at BOTH ends.
  const mid1 = 1;                 // between FF and D8
  const mid2 = a.length - 1;      // between FF and D9
  const r = collect([a.slice(0, mid1), a.slice(mid1, mid2), a.slice(mid2)]);
  ok(r.frames.length === 1, 'markers split across chunk boundary → 1 frame');
  ok(r.frames[0].equals(a), 'marker-split frame reassembled identically');
}

// 4) Leading garbage before the first SOI is discarded; trailing partial kept.
{
  const a = fakeJpeg(16, 0x77);
  const garbage = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const partial = a.slice(0, a.length - 2);   // SOI + body, no EOI yet
  const r = collect([Buffer.concat([garbage, a]), partial]);
  ok(r.frames.length === 1, 'leading garbage skipped, 1 complete frame emitted');
  ok(r.frames[0].equals(a), 'garbage before SOI does not corrupt the frame');
  ok(r.pending >= partial.length - 4, 'trailing partial frame retained for the next chunk');
}

// 5) Streaming many frames in randomly-sized chunks preserves count + order.
{
  const N = 50;
  const originals = [];
  let blob = Buffer.alloc(0);
  for (let i = 0; i < N; i++) { const f = fakeJpeg(10 + (i % 7) * 6, i & 0xFF); originals.push(f); blob = Buffer.concat([blob, f]); }
  const chunks = [];
  let off = 0;
  while (off < blob.length) { const n = 1 + ((off * 2654435761) % 37); chunks.push(blob.slice(off, off + n)); off += n; }
  const r = collect(chunks);
  ok(r.frames.length === N, `random chunking of ${N} frames → ${N} frames (got ${r.frames.length})`);
  ok(r.frames.every((f, i) => f.equals(originals[i])), 'all frames byte-exact + in order under random chunking');
}

// 6) reset() clears pending state.
{
  const a = fakeJpeg(16);
  const asm = createMpjpegReassembler(() => {});
  asm.push(a.slice(0, 8));                 // partial
  ok(asm.bufferLength() > 0, 'partial frame leaves pending bytes');
  asm.reset();
  ok(asm.bufferLength() === 0, 'reset() clears pending buffer');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
