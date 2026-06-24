/**
 * exr_decode_worker.js — PostFlowX EXR frame decoder (Web Worker)
 *
 * Self-contained: no imports. Handles the EXR formats used in VFX pipelines:
 *   Compression : NO_COMPRESSION, RLE, ZIPS, ZIP, PIZ
 *   Pixel types : HALF (float16), FLOAT (float32)
 *   Layout      : scanline, channel-planar (BGR/RGBA)
 *
 * Protocol:
 *   Receive : { id, buffer: ArrayBuffer }       — one EXR frame
 *   Send    : { id, data: Float32Array, width, height }  — RGBA linear float
 *          or { id, error: string }
 */

// ── EXR constants ─────────────────────────────────────────────────────────────
const EXR_MAGIC        = 0x01312F76; // 20000630 LE
const NO_COMPRESSION   = 0;
const RLE_COMPRESSION  = 1;
const ZIPS_COMPRESSION = 2;
const ZIP_COMPRESSION  = 3;
const PIZ_COMPRESSION  = 4;
const PXR24_COMPRESSION= 5;
const UINT_TYPE  = 0;
const HALF_TYPE  = 1;
const FLOAT_TYPE = 2;

// ── Half-float → float32 ──────────────────────────────────────────────────────
function f16ToF32(h) {
  const s = h >> 15;
  const e = (h >> 10) & 0x1f;
  const m = h & 0x03ff;
  if (e === 0) {
    const v = m / 1024 * 5.9604644775390625e-8 * 16384; // = m/1024 * 2^-14
    return s ? -v : v;
  }
  if (e === 31) return m ? NaN : (s ? -Infinity : Infinity);
  const v = (1 + m / 1024) * Math.pow(2, e - 15);
  return s ? -v : v;
}

// ── EXR header parsing ────────────────────────────────────────────────────────
function readNullStr(u8, off) {
  let end = off;
  while (end < u8.length && u8[end] !== 0) end++;
  return { str: new TextDecoder().decode(u8.subarray(off, end)), next: end + 1 };
}

function parseHeader(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // Magic + version
  const magic = dv.getUint32(0, true);
  if (magic !== EXR_MAGIC) throw new Error('Not an EXR file');
  let off = 8; // skip magic + version (4+4)

  const attrs = {};
  // Parse attributes until double-null
  while (off < u8.length) {
    if (u8[off] === 0) { off++; break; } // end of header
    const name  = readNullStr(u8, off); off = name.next;
    const type  = readNullStr(u8, off); off = type.next;
    const size  = dv.getUint32(off, true); off += 4;
    const valU8 = u8.subarray(off, off + size);
    const valDv = new DataView(valU8.buffer, valU8.byteOffset, size);

    if (type.str === 'chlist') {
      const channels = [];
      let ci = 0;
      while (ci < size && valU8[ci] !== 0) {
        const cn = readNullStr(valU8, ci); ci = cn.next;
        const pixelType = valDv.getInt32(ci, true); ci += 4;
        ci += 4; // pLinear + 3 bytes padding
        const xSampling = valDv.getInt32(ci, true); ci += 4;
        const ySampling = valDv.getInt32(ci, true); ci += 4;
        channels.push({ name: cn.str, pixelType, xSampling, ySampling });
      }
      attrs.channels = channels;
    } else if (type.str === 'compression') {
      attrs.compression = valDv.getUint8(0);
    } else if (type.str === 'box2i') {
      attrs[name.str] = {
        xMin: valDv.getInt32(0, true), yMin: valDv.getInt32(4, true),
        xMax: valDv.getInt32(8, true), yMax: valDv.getInt32(12, true),
      };
    } else if (type.str === 'v2f') {
      attrs[name.str] = { x: valDv.getFloat32(0, true), y: valDv.getFloat32(4, true) };
    }
    off += size;
  }

  if (!attrs.channels) throw new Error('EXR: missing channels attribute');
  if (attrs.compression === undefined) throw new Error('EXR: missing compression attribute');
  if (!attrs.dataWindow) throw new Error('EXR: missing dataWindow attribute');

  return { attrs, headerEnd: off };
}

// ── ZIP / ZIPS decompression ──────────────────────────────────────────────────
// EXR ZIP: deflate-raw + undo delta predictor + undo byte interleave
async function inflateRaw(compData) {
  const ds   = new DecompressionStream('deflate-raw');
  const src  = new Blob([compData]).stream().pipeThrough(ds);
  const ab   = await new Response(src).arrayBuffer();
  return new Uint8Array(ab);
}

function undoZipPredictor(data) {
  const len  = data.length;
  const half = Math.floor((len + 1) / 2);

  // Step 1: undo byte interleave — encoder put even-indexed bytes in first half,
  //         odd-indexed bytes in second half; reconstruct original sequential order.
  const tmp = new Uint8Array(len);
  let s1 = 0, s2 = half;
  for (let i = 0; i < len; i++) {
    if (i % 2 === 0) tmp[i] = data[s1++];
    else             tmp[i] = data[s2++];
  }

  // Step 2: undo delta predictor (OpenEXR ZIP uses +128 offset)
  for (let i = 1; i < len; i++) {
    tmp[i] = (tmp[i] + tmp[i - 1] - 128) & 0xff;
  }
  return tmp;
}

async function decompressZip(compData) {
  const raw = await inflateRaw(compData);
  return undoZipPredictor(raw);
}

// ── RLE decompression ─────────────────────────────────────────────────────────
// EXR RLE: signed run-length byte (treat Uint8 >= 128 as negative),
//   run < 0 → repeat next byte (1 − run) times
//   run ≥ 0 → copy next (run + 1) literal bytes
// Predictor: encoded[i] = original[i] − original[i−1], undo = cumulative add
function decompressRle(src, uncompSize) {
  const out = new Uint8Array(uncompSize);
  let si = 0, di = 0;
  while (si < src.length && di < uncompSize) {
    let run = src[si++];
    if (run > 127) run -= 256; // interpret as signed byte
    if (run < 0) {
      const count = 1 - run; // repeat next byte this many times
      const val   = src[si++];
      for (let i = 0; i < count && di < uncompSize; i++) out[di++] = val;
    } else {
      const count = run + 1; // copy this many literal bytes
      for (let i = 0; i < count && di < uncompSize; i++) out[di++] = src[si++];
    }
  }
  // Undo predictor: simple cumulative add (no -128 offset, no byte-interleave)
  for (let i = 1; i < out.length; i++) {
    out[i] = (out[i] + out[i - 1]) & 0xff;
  }
  return out;
}

// ── PIZ decompression ─────────────────────────────────────────────────────────
// Based on OpenEXR + three.js EXRLoader PIZ implementation
// WAV2 lifting wavelet + custom Huffman

const PIZ_USHORT_RANGE = 1 << 16;
const PIZ_BITMAP_SIZE  = PIZ_USHORT_RANGE >> 3;

// ── Full PIZ implementation ────────────────────────────────────────────────────
// Based on OpenEXR spec (ImfPizCompressor.cpp, ImfHuf.cpp, ImfWav.cpp)

function decompressPizFull(compressedData, width, channels, numLines) {
  /**
   * Full PIZ decompression based on OpenEXR specification.
   * References: IlmImf/ImfPizCompressor.cpp, ImfHuf.cpp, ImfWav.cpp
   */
  const src = compressedData;
  const dv  = new DataView(src.buffer, src.byteOffset);
  let p = 0;

  // Read the bitmap header
  const minNonZero = dv.getUint16(p, true); p += 2;
  const maxNonZero = dv.getUint16(p, true); p += 2;

  const bitmap = new Uint8Array(PIZ_BITMAP_SIZE);
  if (maxNonZero >= minNonZero) {
    const bitmapLen = maxNonZero - minNonZero + 1;
    bitmap.set(src.subarray(p, p + bitmapLen), minNonZero);
    p += bitmapLen;
  }

  // Build forward and reverse lookup tables
  const forwardLutSize = PIZ_USHORT_RANGE;
  const forwardLut = new Uint16Array(forwardLutSize);
  let k = 0;
  for (let i = 0; i < forwardLutSize; i++) {
    if ((bitmap[i >> 3] >> (i & 7)) & 1) forwardLut[k++] = i;
  }
  const lutSize = k;

  // Output buffer
  const totalHalfWords = channels.reduce((acc, ch) => {
    const bytesPerPixelPerLine = (ch.pixelType === HALF_TYPE ? 2 : 4);
    return acc + width * bytesPerPixelPerLine / 2;
  }, 0) * numLines;

  const outBuf = new Uint16Array(totalHalfWords);

  // Read huffman encoded data
  const huffCompressedLen = dv.getUint32(p, true); p += 4;
  const huffData = src.subarray(p, p + huffCompressedLen);
  p += huffCompressedLen;

  // Decode huffman → raw symbols
  hufDecode_PIZ(huffData, outBuf, totalHalfWords);

  // Remap through forward LUT
  for (let i = 0; i < totalHalfWords; i++) {
    const idx = outBuf[i];
    outBuf[i] = idx < lutSize ? forwardLut[idx] : 0;
  }

  // Inverse WAV2 for each channel
  let chanStart = 0;
  for (const ch of channels) {
    const chWidth  = width; // xSampling=1 assumed
    const chHeight = numLines;
    const nWords   = chWidth * chHeight;
    wav2DInverse(outBuf, chanStart, chWidth, chHeight);
    chanStart += nWords;
  }

  return new Uint8Array(outBuf.buffer, outBuf.byteOffset, outBuf.byteLength);
}

// ── PIZ Huffman decoder (canonical) ──────────────────────────────────────────
const HUF_DECBITS = 14;
const HUF_DECSIZE = 1 << HUF_DECBITS;
const HUF_DECMASK = HUF_DECSIZE - 1;

function hufDecode_PIZ(src, dst, nDst) {
  const srcDv = new DataView(src.buffer, src.byteOffset);
  let p = 0;

  // Read Huffman table header (OpenEXR ImfHuf.cpp format):
  //   uint32 im    — min symbol value (inclusive)
  //   uint32 iM    — max symbol value (inclusive)
  //   uint32 skip  — packed-table byte count (not needed; we scan by 6-bit groups)
  const im = srcDv.getUint32(p, true); p += 4;
  const iM = srcDv.getUint32(p, true); p += 4;
  p += 4; // skip packed-table byte count

  const hlen  = new Uint8Array(iM - im + 1);
  const hdec  = new Array(HUF_DECSIZE);
  for (let i = 0; i < HUF_DECSIZE; i++) hdec[i] = { len: 0, lit: 0, p: null };

  // Unpack code lengths from source
  p += unpackHufTable(src, p, im, iM, hlen);

  // Build canonical Huffman decode table
  const hcode = buildCanonicalHuf(hlen, im, iM, hdec);

  // Decode the bit stream
  let bitBuf = 0;
  let bitCount = 0;
  let di = 0;

  function refill() {
    if (p < src.length) {
      bitBuf = (bitBuf << 8) | src[p++];
      bitCount += 8;
    }
  }

  // Prime the bit buffer
  for (let i = 0; i < 4 && p < src.length; i++) {
    bitBuf = (bitBuf << 8) | src[p++];
    bitCount += 8;
  }

  while (di < nDst) {
    // Look up in decode table
    const fastIdx = (bitBuf >> (bitCount - HUF_DECBITS)) & HUF_DECMASK;
    const hd = hdec[fastIdx];
    if (!hd || hd.len === 0) {
      // Slow path
      let code = bitBuf >> (bitCount - 15);
      let found = false;
      for (let l = 15; l >= 1; l--) {
        const c = code >> (15 - l);
        for (let s = im; s <= iM; s++) {
          if (hcode[s - im] && hcode[s - im].len === l && hcode[s - im].code === c) {
            bitCount -= l;
            dst[di++] = s;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) break;
    } else {
      bitCount -= hd.len;
      if (hd.p !== null) {
        // Long code
        let sym = 0;
        // decode remaining bits
        const remaining = hd.lit - HUF_DECBITS;
        while (bitCount < remaining) refill();
        const extra = (bitBuf >> (bitCount - remaining)) & ((1 << remaining) - 1);
        bitCount -= remaining;
        sym = hd.p[extra] || 0;
        dst[di++] = sym;
      } else {
        dst[di++] = hd.lit;
      }
    }

    while (bitCount < HUF_DECBITS + 1 && p < src.length) refill();
    if (bitCount < 0) break;
  }
}

function unpackHufTable(src, start, im, iM, hlen) {
  const dv = new DataView(src.buffer, src.byteOffset);
  let  p   = start;
  let  c   = 0, lc = 0;
  let  n   = 0;

  const LONG_ZEROCODE_RUN  = 59;
  const SHORT_ZEROCODE_RUN = 58;
  const SHORTEST_LONG_RUN  = 2 + SHORT_ZEROCODE_RUN - LONG_ZEROCODE_RUN;

  function readBits6(cnt) {
    while (lc < cnt) {
      c = (c << 8) | (src[p++] || 0);
      lc += 8;
    }
    lc -= cnt;
    return (c >> lc) & ((1 << cnt) - 1);
  }

  for (let i = 0; i <= (iM - im);) {
    const l = readBits6(6);
    if (l === LONG_ZEROCODE_RUN) {
      const zerun = readBits6(8) + SHORTEST_LONG_RUN;
      for (let k = 0; k < zerun && i <= (iM - im); k++, i++) hlen[i] = 0;
    } else if (l === SHORT_ZEROCODE_RUN) {
      const zerun = readBits6(2) + 2;
      for (let k = 0; k < zerun && i <= (iM - im); k++, i++) hlen[i] = 0;
    } else {
      hlen[i++] = l;
    }
  }
  return p - start;
}

function buildCanonicalHuf(hlen, im, iM, hdec) {
  const n = iM - im + 1;
  const hcode = new Array(n);

  // Count codes per length
  const lenCount = new Array(65).fill(0);
  for (let i = 0; i < n; i++) if (hlen[i]) lenCount[hlen[i]]++;

  // First code for each length
  const firstCode = new Array(65).fill(0);
  for (let l = 1; l <= 64; l++) firstCode[l] = (firstCode[l - 1] + lenCount[l - 1]) << 1;

  const currCode = [...firstCode];
  for (let i = 0; i < n; i++) {
    const l = hlen[i];
    if (!l) continue;
    hcode[i] = { len: l, code: currCode[l], sym: im + i };
    currCode[l]++;

    if (l <= HUF_DECBITS) {
      // Fill fast decode table
      const pad = HUF_DECBITS - l;
      const base = hcode[i].code << pad;
      for (let k = 0; k < (1 << pad); k++) {
        hdec[base | k] = { len: l, lit: im + i, p: null };
      }
    }
  }
  return hcode;
}

// ── WAV2 inverse (2-D integer wavelet) ───────────────────────────────────────
function wav1Inverse(buf, offset, n, stride) {
  // In-place 1-D inverse integer lifting wavelet
  let p = n;
  let p1 = (n + 1) >> 1;

  for (let l = p1; l < p; ) {
    const i1 = offset + (l - p1) * stride;
    const i2 = offset + l        * stride;
    const nEven = p1;
    const nOdd  = p - p1;

    if (nOdd < nEven) {
      buf[i1] = (buf[i1] + ((buf[i2] + 1) >> 1)) & 0xffff;
    }

    for (let k = 0; k + 1 < nOdd; k++) {
      const ai  = offset + (l - p1 + k) * stride;
      const ai1 = offset + (l - p1 + k + 1) * stride;
      const bi  = offset + (l + k) * stride;
      const bi1 = offset + (l + k + 1) * stride;

      buf[ai1] = (buf[ai1] + ((buf[bi] + buf[bi1] + 2) >> 2)) & 0xffff;
      buf[bi]  = (buf[bi]  - buf[ai]) & 0xffff;
    }

    if (nOdd >= nEven) {
      const ai = offset + (l - 1) * stride;
      const bi = offset + (p - 1) * stride;
      buf[ai] = (buf[ai] + ((buf[bi] + 1) >> 1)) & 0xffff;
    }

    l  = p1;
    p  = p1;
    p1 = (p + 1) >> 1;
  }
}

function wav2DInverse(buf, offset, width, height) {
  // Vertical passes (along columns)
  for (let x = 0; x < width; x++) {
    wav1Inverse(buf, offset + x, height, width);
  }
  // Horizontal passes (along rows)
  for (let y = 0; y < height; y++) {
    wav1Inverse(buf, offset + y * width, width, 1);
  }
}

// ── Scanline block reader ─────────────────────────────────────────────────────
// Returns a channel-planar Uint8Array for this block
async function readScanlineBlock(u8, dv, blockOffset, width, channels, compression, linesInBlock) {
  let p = blockOffset;
  const firstY  = dv.getInt32(p, true);  p += 4;
  const dataLen = dv.getUint32(p, true); p += 4;

  const compData = u8.subarray(p, p + dataLen);

  const pixTypeSize = ch => ch.pixelType === HALF_TYPE ? 2 : ch.pixelType === FLOAT_TYPE ? 4 : 4;
  const lineBytes   = channels.reduce((s, ch) => s + width * pixTypeSize(ch), 0);
  const uncompSize  = lineBytes * linesInBlock;

  switch (compression) {
    case NO_COMPRESSION: {
      // Already in planar layout, just copy
      const out = new Uint8Array(uncompSize);
      out.set(compData.subarray(0, uncompSize));
      return { firstY, data: out };
    }
    case ZIPS_COMPRESSION:
    case ZIP_COMPRESSION: {
      const dec = await decompressZip(compData);
      return { firstY, data: dec };
    }
    case RLE_COMPRESSION: {
      const dec = decompressRle(compData, uncompSize);
      return { firstY, data: dec };
    }
    case PIZ_COMPRESSION: {
      const dec = decompressPizFull(compData, width, channels, linesInBlock);
      return { firstY, data: dec };
    }
    default:
      throw new Error(`EXR: unsupported compression type ${compression} (only NO/RLE/ZIPS/ZIP/PIZ supported)`);
  }
}

// ── Pixel extraction ─────────────────────────────────────────────────────────
// Convert channel-planar block data → Float32Array RGBA with optional downscale.
// dstW/dstH define the output dimensions (nearest-neighbour, written directly —
// no full-resolution intermediate buffer needed).
function extractPixels(blockData, firstY, linesInBlock, srcWidth, channels,
                       outputRgba, totalHeight, dstW, dstH) {
  if (!dstW) dstW = srcWidth;
  if (!dstH) dstH = totalHeight;
  const xScale = dstW / srcWidth;
  const yScale = dstH / totalHeight;

  const getSemanticIdx = name => {
    const n = name.toLowerCase();
    if (n === 'r' || n === 'red')   return 0;
    if (n === 'g' || n === 'green') return 1;
    if (n === 'b' || n === 'blue')  return 2;
    if (n === 'a' || n === 'alpha') return 3;
    if (n === 'y')                  return 0; // luminance → R channel
    return -1;
  };

  const dv = new DataView(blockData.buffer, blockData.byteOffset);
  const pixTypeSize = ch => ch.pixelType === HALF_TYPE ? 2 : ch.pixelType === FLOAT_TYPE ? 4 : 4;

  // Pre-compute each channel's byte start offset (channel-major)
  const chanByteStart = [];
  let cumOff = 0;
  for (const ch of channels) {
    chanByteStart.push(cumOff);
    cumOff += linesInBlock * srcWidth * pixTypeSize(ch);
  }

  for (let ci = 0; ci < channels.length; ci++) {
    const ch  = channels[ci];
    const sz  = pixTypeSize(ch);
    const idx = getSemanticIdx(ch.name);
    if (idx < 0) continue;

    const chStart = chanByteStart[ci];
    for (let line = 0; line < linesInBlock; line++) {
      const srcY = firstY + line;
      if (srcY >= totalHeight) continue;
      const dstY = Math.floor(srcY * yScale);
      if (dstY >= dstH) continue;

      for (let x = 0; x < srcWidth; x++) {
        const dstX = Math.floor(x * xScale);
        // Nearest-neighbour: only write the first source pixel that maps to each dst column
        if (x > 0 && Math.floor((x - 1) * xScale) === dstX) continue;

        const srcOff = chStart + (line * srcWidth + x) * sz;
        let val;
        if (ch.pixelType === HALF_TYPE) {
          val = f16ToF32(dv.getUint16(srcOff, true));
        } else if (ch.pixelType === FLOAT_TYPE) {
          val = dv.getFloat32(srcOff, true);
        } else {
          val = dv.getUint32(srcOff, true) / 0xffffffff;
        }
        outputRgba[(dstY * dstW + dstX) * 4 + idx] = val;
      }
    }
  }
}

// Max long-edge pixels for decoded preview — keeps memory and texture-upload
// cost reasonable regardless of source plate resolution (4K, 6K, 8K…).
const MAX_PREVIEW_SIDE = 1280;

// ── Main decode function ──────────────────────────────────────────────────────
async function decodeEXR(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  const { attrs, headerEnd } = parseHeader(u8);

  const { xMin, yMin, xMax, yMax } = attrs.dataWindow;
  const width       = xMax - xMin + 1;
  const height      = yMax - yMin + 1;
  const compression = attrs.compression;
  const channels    = attrs.channels;

  // Compute preview scale so the longest edge ≤ MAX_PREVIEW_SIDE
  const scale = Math.min(1.0, MAX_PREVIEW_SIDE / Math.max(width, height));
  const dstW  = Math.max(1, Math.round(width  * scale));
  const dstH  = Math.max(1, Math.round(height * scale));

  // Block height depends on compression
  const blockH = (compression === PIZ_COMPRESSION) ? 32
               : (compression === ZIP_COMPRESSION) ? 16
               : 1;
  const nBlocks = Math.ceil(height / blockH);

  // Read offset table (uint64 per block)
  let offTablePos = headerEnd;
  const blockOffsets = [];
  for (let i = 0; i < nBlocks; i++) {
    // Read as two uint32s (JS can't handle uint64 precisely for very large files)
    const lo = dv.getUint32(offTablePos, true);
    const hi = dv.getUint32(offTablePos + 4, true);
    blockOffsets.push(hi === 0 ? lo : lo + hi * 0x100000000);
    offTablePos += 8;
  }

  // Allocate output at PREVIEW size — no full-resolution intermediate buffer
  const rgba = new Float32Array(dstW * dstH * 4);
  // Default alpha = 1
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 1.0;

  // Decode each scanline block, writing directly to scaled output
  for (let bi = 0; bi < nBlocks; bi++) {
    const bOff = blockOffsets[bi];
    const linesThisBlock = Math.min(blockH, height - bi * blockH);
    try {
      const { firstY, data } = await readScanlineBlock(u8, dv, bOff, width, channels, compression, linesThisBlock);
      extractPixels(data, firstY, linesThisBlock, width, channels, rgba, height, dstW, dstH);
    } catch(e) {
      console.warn('[EXR worker] block', bi, 'failed:', e.message);
    }
  }

  return { data: rgba, width: dstW, height: dstH };
}

// ── Worker message handler ────────────────────────────────────────────────────
self.addEventListener('message', async ({ data }) => {
  const { id, buffer } = data;
  try {
    const result = await decodeEXR(buffer);
    self.postMessage({ id, data: result.data, width: result.width, height: result.height },
      [result.data.buffer]);
  } catch(e) {
    self.postMessage({ id, error: e.message });
  }
});
