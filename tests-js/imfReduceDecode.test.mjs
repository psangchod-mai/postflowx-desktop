// C-RT1b regression: OpenJPH reduced-resolution (DWT) decode must report dims
// that MATCH its reduced output buffer. The original bug returned getFrameInfo()
// FULL dims with a reduced buffer → renderer read garbage (dark/corrupt frames),
// which forced full-res-only playback. The fix uses
// calculateSizeAtDecompositionLevel(level) for the dims (imf_j2k.js / j2k_decoder.js).
import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let factory = null;
try { factory = require(path.join(root, 'assets/imf/openjphjs.js')); } catch { /* asset missing → skip */ }

test('OpenJPH reduced decode: reported dims match the decoded buffer', { skip: !factory ? 'openjphjs asset unavailable' : false }, async () => {
  const m = await factory();
  const W = 256, H = 256, C = 3;
  const px = new Uint8Array(W * H * C);
  for (let i = 0; i < px.length; i++) px[i] = (i / C) % 256;
  const fi = { width: W, height: H, bitsPerSample: 8, componentCount: C, isSigned: false, isUsingColorTransform: true };
  const enc = new m.HTJ2KEncoder();
  enc.getDecodedBuffer(fi).set(px);
  enc.setDecompositions(5);
  enc.encode();
  const eb = Uint8Array.from(enc.getEncodedBuffer());

  // Mimic the FIXED decode-dims logic.
  function decode(level) {
    const d = new m.HTJ2KDecoder();
    d.getEncodedBuffer(eb.length).set(eb);
    d.readHeader();
    const nd = d.getNumDecompositions() | 0;
    let rl = level; if (nd > 0 && rl > nd) rl = nd;
    d.decodeSubResolution(rl);
    const info = d.getFrameInfo();
    const raw = d.getDecodedBuffer();
    let w = info.width, h = info.height;
    if (rl > 0) { const dm = d.calculateSizeAtDecompositionLevel(rl); w = dm.width; h = dm.height; }
    return { w, h, fullW: info.width, buf: raw.byteLength, expect: w * h * C * (info.bitsPerSample > 8 ? 2 : 1) };
  }

  const full = decode(0);
  assert.strictEqual(full.buf, full.expect, 'full-res dims must match buffer');
  assert.strictEqual(full.w, 256);

  const half = decode(1);
  assert.strictEqual(half.w, 128, 'level 1 → 128 wide');
  assert.strictEqual(half.buf, half.expect, 'reduced dims MUST match reduced buffer (the C-RT1b bug)');
  assert.notStrictEqual(half.buf, half.fullW * half.fullW * C, 'reduced buffer is NOT full size');

  const quarter = decode(2);
  assert.strictEqual(quarter.w, 64);
  assert.strictEqual(quarter.buf, quarter.expect);
});
