// scripts/modules/imf/imf_mxf.js
// MXF KLV scanner — reads Index Table Segment to build per-frame byte-offset index.
// Used by imf_player.js to seek to any frame in a large MXF file via File.slice().
// Supports CBR (IndexUnitSize > 0) and VBR (per-frame IndexEntries) layouts.
'use strict';

import { sniffCodestream } from './j2kCodestream.js';

console.log('[MXF] module build: 2026-04-07-v9');

// ── KLV well-known ULs (hex, first 13 bytes matched) ─────────────────────────
const UL = {
  HEADER_OPEN:    '060e2b3402050101 0d01020101020300',  // open header
  HEADER_CLOSED:  '060e2b3402050101 0d01020101020400',  // closed header
  BODY_PARTITION: '060e2b3402050101 0d01020101030',     // prefix match
  FOOTER_OPEN:    '060e2b3402050101 0d01020101040300',
  FOOTER_CLOSED:  '060e2b3402050101 0d01020101040400',
  INDEX_TABLE:    '060e2b3402530101 0d01020101100100',
  FILL:           '060e2b3401010101 03010210 01000000',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
async function readBytes(file, offset, length) {
  if (offset >= file.size) return null;
  const actual = Math.min(length, file.size - offset);
  try {
    const buf = await file.slice(offset, offset + actual).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    // DOMException — file no longer accessible or slice out of range; callers treat null as EOF
    return null;
  }
}

function hexKey(bytes) {
  return Array.from(bytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// BER-encoded length decoder; returns { length, bytesRead } or null
function parseBER(bytes, offset) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first < 0x80) return { length: first, bytesRead: 1 };
  const n = first & 0x7f;
  if (n === 0 || n > 8 || offset + n >= bytes.length) return null;
  let len = 0;
  for (let i = 0; i < n; i++) len = len * 256 + bytes[offset + 1 + i];
  return { length: len, bytesRead: 1 + n };
}

function findMarker(bytes, markerHi, markerLo, start = 0) {
  const lim = Math.max(0, bytes.length - 1);
  for (let i = Math.max(0, start); i < lim; i++) {
    if (bytes[i] === markerHi && bytes[i + 1] === markerLo) return i;
  }
  return -1;
}

// Image dimensions of the codestream starting at `soc`, or null if unknown.
//
// This was a private SIZ walk, near-identical to the one in imf_player.js and
// carrying the same defects: it reported Xsiz as the width (the image is
// Xsiz − XOsiz), it accepted `Lsiz >= 38` where no conforming SIZ is shorter
// than 41, and its marker walk was unbounded with no SOT/SOD stop. The last one
// bites hardest here, because the only caller is the truncation heuristic
// below — the input is a codestream already suspected of being cut short, which
// is precisely the case where the walk runs off the end of the main header and
// starts reading entropy-coded data as segment lengths.
function parseJ2KSIZ(bytes, soc = 0) {
  if (!bytes || bytes.length < soc + 6) return null;
  const info = sniffCodestream(soc ? bytes.subarray(soc) : bytes);
  return info.width != null ? { width: info.width, height: info.height } : null;
}

function isSuspiciousCodestream(bytes, soc = 0) {
  if (!bytes || bytes.length - soc < 1024) return true;
  const siz = parseJ2KSIZ(bytes, soc);
  if (!siz) return (bytes.length - soc) < 4096;
  const pixels = Math.max(1, Number(siz.width || 0) * Number(siz.height || 0));
  if (pixels >= 1920 * 1080 && (bytes.length - soc) < 8192) return true;
  if (pixels >= 3840 * 2160 && (bytes.length - soc) < 16384) return true;
  return false;
}

function trimCodestream(bytes) {
  if (!bytes || bytes.length < 2) return null;
  const soc = findMarker(bytes, 0xFF, 0x4F, 0);
  if (soc < 0) return null;
  const eoc = findMarker(bytes, 0xFF, 0xD9, soc + 2);
  const trimmed = eoc >= 0 ? bytes.slice(soc, eoc + 2) : bytes.slice(soc);
  return { soc, eoc, bytes: trimmed };
}

// Read one KLV at file position; returns { key16, keyHex, valueOffset, valueLength, totalSize }
async function readKLV(file, offset) {
  if (offset + 17 > file.size) return null;
  const hdr = await readBytes(file, offset, 32);
  if (!hdr || hdr.length < 17) return null;
  const keyHex = hexKey(hdr);
  const ber = parseBER(hdr, 16);
  if (!ber) return null;
  const valueOffset = offset + 16 + ber.bytesRead;
  return { keyHex, valueOffset, valueLength: ber.length,
           totalSize: 16 + ber.bytesRead + ber.length };
}

// Read a fixed number of bytes from the value of a KLV into a DataView
async function readValue(file, klv, maxBytes) {
  const len = Math.min(klv.valueLength, maxBytes);
  const bytes = await readBytes(file, klv.valueOffset, len);
  if (!bytes) return null;
  // Offset and length spelled out. readBytes() always allocates a fresh whole
  // buffer today, so `new DataView(bytes.buffer)` happened to be the same view
  // — but that is a property of the current reader, not of this function's
  // contract, and every caller below reads by absolute offset.
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

// ── Partition pack parser ─────────────────────────────────────────────────────
// Returns { majorVersion, minorVersion, kagSize, thisPartition, previousPartition,
//           footerPartition, headerByteCount, indexByteCount, indexSID,
//           bodyOffset, bodySID }
function parsePartitionPack(dv) {
  if (!dv || dv.byteLength < 88) return null;
  try {
    return {
      majorVersion:     dv.getUint16(0, false),
      minorVersion:     dv.getUint16(2, false),
      kagSize:          dv.getUint32(4, false),
      thisPartition:    Number(dv.getBigUint64(8,  false)),
      previousPartition:Number(dv.getBigUint64(16, false)),
      footerPartition:  Number(dv.getBigUint64(24, false)),
      headerByteCount:  Number(dv.getBigUint64(32, false)),
      indexByteCount:   Number(dv.getBigUint64(40, false)),
      indexSID:         dv.getUint32(48, false),
      bodyOffset:       Number(dv.getBigUint64(52, false)),
      bodySID:          dv.getUint32(60, false),
    };
  } catch { return null; }
}

// ── Index Table Segment parser ────────────────────────────────────────────────
// Returns { indexStartPos, indexDuration, editUnitByteCount, deltaEntries, indexEntries }
// editUnitByteCount > 0 → CBR  (all frames same size)
// editUnitByteCount = 0 → VBR  (use indexEntries[].streamOffset)
function parseIndexTable(bytes) {
  if (!bytes || bytes.length < 20) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  const result = { indexStartPos: 0, indexDuration: 0,
                   editUnitByteCount: 0, bodyOffset: 0, entries: [] };
  // Walk local tags (2-byte tag + 2-byte len + value)
  while (off + 4 <= bytes.length) {
    const tag = dv.getUint16(off, false);
    const len = dv.getUint16(off + 2, false);
    off += 4;
    if (off + len > bytes.length) break;
    try {
      switch (tag) {
        case 0x3f0b: result.indexEditRate     = `${dv.getInt32(off,false)}/${dv.getInt32(off+4,false)}`; break;
        case 0x3f0c: result.indexStartPos     = Number(dv.getBigInt64(off, false)); break;
        case 0x3f0d: result.indexDuration     = Number(dv.getBigInt64(off, false)); break;
        case 0x3f05: result.editUnitByteCount = dv.getUint32(off, false); break;
        case 0x3f06: result.bodyOffset        = Number(dv.getBigUint64(off, false)); break;
        case 0x3f08: { // DeltaEntryArray (skip count/4 bytes header)
          const n = dv.getUint32(off, false);
          const es= dv.getUint32(off+4, false);
          result.deltaEntries = n;
          break;
        }
        case 0x3f0a: { // IndexEntryArray
          const n  = dv.getUint32(off, false);
          const es = dv.getUint32(off + 4, false); // entry size (usually 11)
          let p    = off + 8;
          for (let i = 0; i < n && p + Math.max(11, es) <= bytes.length; i++) {
            const temporalOff = dv.getInt8(p);
            const keyFrameOff = dv.getInt8(p + 1);
            const flags       = dv.getUint8(p + 2);
            const streamOff   = Number(dv.getBigInt64(p + 3, false));
            result.entries.push({ temporalOff, keyFrameOff, flags, streamOff });
            p += Math.max(11, es);
          }
          break;
        }
      }
    } catch { /* skip malformed tag */ }
    off += len;
  }
  return result;
}

// ── Public: scan an MXF file and return a frame index ────────────────────────
// Progress callback: (phase, pct) where phase is 'header'|'index'|'done'
export async function scanMXF(file, onProgress) {
  const report = {
    headerParsed: false,
    partition: null,
    indexTables: [],       // array of parsed index table results
    frameCount: 0,
    editUnitByteCount: 0,  // > 0 = CBR
    bodyPartitionOffset: 0,// byte offset where essence begins
    essenceStartOffset: 0, // first KLV value offset of first frame
    frameOffsets: null,    // Float64Array of per-frame stream offsets (VBR only)
    avgFramePairBytes: 0,  // > 0 = extrapolation available beyond scanned range
    essenceValueOffset: 0, // value start of first essence KLV
    essenceValueLength: 0, // value size of first essence KLV
    wrappingKind: 'unknown', // 'frame' | 'clip' | 'unknown'
    error: null,
  };

  try {

  onProgress?.('header', 0);

  // ── Step 1: Read header partition pack ───────────────────────────────────
  const firstKLV = await readKLV(file, 0);
  if (!firstKLV) { report.error = 'Cannot read MXF header'; return report; }
  const partDV = await readValue(file, firstKLV, 512);
  report.partition = parsePartitionPack(partDV);
  if (!report.partition) { report.error = 'Cannot parse partition pack'; return report; }
  report.headerParsed = true;
  onProgress?.('header', 30);

  // ── Step 2: Walk header metadata to find Index Table Segment(s) ──────────
  // Index tables live in the header partition (headerByteCount bytes after the first KLV)
  const headerStart = firstKLV.totalSize;
  // Cap at 16MB; default 8MB when headerByteCount not set or 0
  const headerLen   = Math.min(report.partition.headerByteCount || 8 * 1024 * 1024, 16 * 1024 * 1024);
  let   scanOffset  = headerStart;
  const headerEnd   = headerStart + headerLen;
  let   indexFound  = false;

  while (scanOffset < headerEnd && scanOffset < file.size) {
    const klv = await readKLV(file, scanOffset);
    if (!klv) break;

    const k = klv.keyHex.replace(/\s/g, '');

    // Index Table Segment UL prefix: 060e2b3402530101 0d010201 01100100
    if (k.startsWith('060e2b340253010') || k.startsWith('060e2b3402530101')) {
      const maxRead = Math.min(klv.valueLength, 4 * 1024 * 1024); // up to 4MB (183k frames × 11B = ~2MB)
      const raw = await readBytes(file, klv.valueOffset, maxRead);
      if (raw) {
        const idx = parseIndexTable(raw);
        if (idx) {
          report.indexTables.push(idx);
          indexFound = true;
          console.log(`[MXF] Index Table at 0x${scanOffset.toString(16)}: dur=${idx.indexDuration}  eubc=${idx.editUnitByteCount}  entries=${idx.entries.length}`);
          onProgress?.('index', 60);
        }
      }
    }

    // Body Partition → essence starts here; record offset
    if (k.startsWith('060e2b34020501') && k.includes('030')) {
      if (!report.bodyPartitionOffset) {
        report.bodyPartitionOffset = scanOffset;
      }
    }

    if (klv.totalSize <= 0) break;
    scanOffset += klv.totalSize;

    // Once we've found at least one index table AND passed the header metadata,
    // we can stop scanning (the rest is essence)
    if (indexFound && scanOffset > headerEnd * 0.5) break;
  }

  // ── Step 3: If footer partition has a better index, read it ───────────────
  if (!indexFound && report.partition.footerPartition > 0 &&
      report.partition.footerPartition < file.size) {
    onProgress?.('footer', 70);
    const footOff = report.partition.footerPartition;
    const footKLV = await readKLV(file, footOff);
    if (footKLV) {
      // Walk up to 2MB of the footer looking for index tables
      let fp = footOff + footKLV.totalSize;
      const fpEnd = fp + 2 * 1024 * 1024;
      while (fp < fpEnd && fp < file.size) {
        const fklv = await readKLV(file, fp);
        if (!fklv) break;
        const fk = fklv.keyHex.replace(/\s/g, '');
        if (fk.startsWith('060e2b340253010')) {
          const raw = await readBytes(file, fklv.valueOffset, Math.min(fklv.valueLength, 4 * 1024 * 1024));
          if (raw) {
            const idx = parseIndexTable(raw);
            if (idx) { report.indexTables.push(idx); indexFound = true; }
          }
        }
        if (fklv.totalSize <= 0) break;
        fp += fklv.totalSize;
      }
    }
  }

  // ── Step 4: Find where the first essence KLV KEY starts ─────────────────
  // StreamOffset in Index Entries is measured from the first byte of the first
  // essence KLV KEY (not the value). Save `ep` (key position), not valueOffset.
  {
    let ep = report.bodyPartitionOffset || headerStart + headerLen;
    const epEnd = ep + 2 * 1024 * 1024;  // scan up to 2MB past body start
    while (ep < epEnd && ep < file.size) {
      const eklv = await readKLV(file, ep);
      if (!eklv) break;
      const ek = eklv.keyHex.replace(/\s/g, '');
      // Partition Pack ULs — skip over them (they have normal-sized values)
      // Header/Body/Footer: 060e2b3402050101 ...
      const isPartitionPack = ek.startsWith('060e2b340205');
      // Fill KLV: 060e2b3401010101 03010210...
      const isFill = ek.startsWith('060e2b340101');
      // Index Table Segment: 060e2b3402530101...
      const isIndex = ek.startsWith('060e2b340253');
      // Primer Pack: 060e2b340205...  (also a partition pack, covered above)

      // J2K Picture Essence:
      //   Frame-wrapped  060e2b3401020101 0d01030115010800
      //   Clip-wrapped   060e2b3401020101 0d01030115010900
      //   Also generic:  060e2b340101010x (some encoders)
      // Must use 8-byte prefix 060e2b3401020101; AUX/other start with 060e2b3401020105 etc.
      const isEssence = !isPartitionPack && !isFill && !isIndex &&
        (ek.startsWith('060e2b3401020101') ||
         ek.startsWith('060e2b34010101'));

      if (isEssence) {
        report.essenceStartOffset = ep;   // KEY position for frame-wrapped; anchor for streamOffset maths
        report.essenceValueOffset = eklv.valueOffset;
        report.essenceValueLength = eklv.valueLength;
        console.log(`[MXF] essence KLV at 0x${ep.toString(16)}  UL=${ek.slice(0,16)}… valueLen=${eklv.valueLength}`);
        break;
      }
      if (eklv.totalSize <= 0) break;
      ep += eklv.totalSize;
    }
  }

  // ── Step 5: Consolidate index info ───────────────────────────────────────
  if (report.indexTables.length > 0) {
    const first = report.indexTables[0];
    report.frameCount         = first.indexDuration || 0;
    report.editUnitByteCount  = first.editUnitByteCount || 0;

    if (first.entries.length > 0) {
      // VBR: build streamOffset array
      const arr = new Float64Array(first.entries.length);
      for (let i = 0; i < first.entries.length; i++) arr[i] = first.entries[i].streamOff;
      report.frameOffsets = arr;
      report.frameCount   = Math.max(report.frameCount, first.entries.length);
    }
  }

  // Determine likely wrapping mode for JPEG 2000 essence.
  // ST 422 allows both frame-wrapped and clip-wrapped mappings. If the first
  // essence KLV value is larger than the next stream offset, the stream offsets
  // are most likely inside a single clip-wrapped value rather than at KLV keys.
  if (report.essenceValueLength > 0 && report.frameOffsets && report.frameOffsets.length > 1) {
    const nextOff = report.frameOffsets[1];
    if (nextOff > 0 && report.essenceValueLength > nextOff) {
      report.wrappingKind = 'clip';
    } else {
      report.wrappingKind = 'frame';
    }
  } else if (report.essenceValueLength > 0 && report.editUnitByteCount > 0) {
    report.wrappingKind = (report.essenceValueLength > report.editUnitByteCount * 2) ? 'clip' : 'frame';
  }

  // ── Step 5b: No usable index — build frame index by walking body KLVs ────
  // Some MXF files (e.g. Netflix IMF) have empty index placeholder segments.
  // Walk the essence body, collect J2K KLV key positions, and compute avg
  // frame-pair size for extrapolation beyond the scanned window.
  if (!report.frameOffsets && report.editUnitByteCount === 0 &&
      report.essenceStartOffset > 0) {
    onProgress?.('walk', 70);
    const MAX_WALK_FRAMES = 1000;
    const walkOffsets = [];    // stream offsets relative to essenceStartOffset
    const pairSizes   = [];    // gap between consecutive J2K frame positions
    let wp    = report.essenceStartOffset;
    const wpEnd = wp + 6000 * 1024 * 1024; // scan up to 6 GB of essence (covers ~1500 4MB frames)

    while (wp < wpEnd && wp < file.size && walkOffsets.length < MAX_WALK_FRAMES) {
      const wklv = await readKLV(file, wp);
      if (!wklv || wklv.totalSize <= 0) break;
      const wk = wklv.keyHex.replace(/\s/g, '');

      // J2K picture essence: bytes 0-7 = 060e2b3401020101 (frame-wrapped & clip-wrapped).
      // AUX/other essence also starts with 060e2b340102 but byte 7 differs (01 vs 05 etc.)
      // Must match the full 8-byte registry prefix to exclude non-J2K essence.
      if (wk.startsWith('060e2b3401020101')) {
        let keep = wklv.valueLength >= 4096;
        if (!keep) {
          const probe = await readBytes(file, wklv.valueOffset, Math.min(wklv.valueLength, 32768));
          const trimmed = probe ? trimCodestream(probe) : null;
          keep = !!(trimmed && !isSuspiciousCodestream(trimmed.bytes, 0));
        }
        if (keep) {
          const relOff = wp - report.essenceStartOffset;
          if (walkOffsets.length > 0)
            pairSizes.push(relOff - walkOffsets[walkOffsets.length - 1]);
          walkOffsets.push(relOff);
          if (walkOffsets.length % 30 === 0)
            onProgress?.('walk', 70 + Math.round(walkOffsets.length / MAX_WALK_FRAMES * 25));
        }
      }

      // Guard against corrupt / runaway KLV sizes
      if (wklv.totalSize > 64 * 1024 * 1024) break;
      wp += wklv.totalSize;
    }

    if (walkOffsets.length > 0) {
      report.frameOffsets = new Float64Array(walkOffsets);
      // frameCount = exact scanned count; player shows these frames precisely.
      // avgFramePairBytes is left 0 — extrapolation disabled to avoid seek errors
      // caused by variable-size frames (tiny black frames skew the average).
      report.frameCount = walkOffsets.length;
      if (pairSizes.length > 0) {
        const MIN_PAIR = 1024 * 1024; // only count pairs >= 1MB as "normal content"
        const normalPairs = pairSizes.filter(s => s >= MIN_PAIR);
        if (normalPairs.length >= 5) {
          const avg = normalPairs.reduce((a, b) => a + b, 0) / normalPairs.length;
          // Only use avgFramePairBytes if it gives a plausible total (< 1M frames)
          const essenceBytes = file.size - report.essenceStartOffset;
          const estTotal = Math.round(essenceBytes / avg);
          if (estTotal > walkOffsets.length && estTotal < 1_000_000) {
            report.avgFramePairBytes = avg;
            report.frameCount = estTotal;
          }
        }
      }
      console.log(`[MXF] Body walk: ${walkOffsets.length} J2K frames scanned, frameCount=${report.frameCount}, avgPair=${Math.round(report.avgFramePairBytes / 1024)}KB`);
    }
  }

  onProgress?.('done', 100);
  return report;

  } catch (e) {
    report.error = e?.message || String(e);
    return report;
  }
}

// ── Public: read one frame's J2K bytes from an indexed MXF ───────────────────
// Returns Uint8Array of the J2K codestream, or null
export async function readMXFFrame(file, mxfIndex, frameNumber) {
  const { editUnitByteCount, frameOffsets, essenceStartOffset,
          essenceValueOffset, essenceValueLength, wrappingKind,
          frameCount, avgFramePairBytes } = mxfIndex;
  const expectedFrameCount = Number(mxfIndex.expectedFrameCount || 0);
  const maxFrameNumber = expectedFrameCount > 0 ? expectedFrameCount : frameCount;
  if (frameNumber < 0 || frameNumber >= maxFrameNumber) return null;

  const ESS_PREFIX = [0x06, 0x0e, 0x2b, 0x34, 0x01, 0x02, 0x01, 0x01];
  const isEss = (t) => !!t && (t.keyHex.replace(/\s/g, '').startsWith('060e2b3401020101') || t.keyHex.replace(/\s/g, '').startsWith('060e2b34010101'));

  async function readCandidateBytes(klv) {
    if (!klv || klv.valueLength <= 0) return null;
    const initialRead = Math.min(klv.valueLength, 16 * 1024 * 1024);
    let bytes = await readBytes(file, klv.valueOffset, initialRead);
    if (!bytes || bytes.length === 0) return null;

    let trimmed = trimCodestream(bytes);
    if (!trimmed) return null;

    if (trimmed.eoc < 0 && klv.valueLength > initialRead) {
      const expandedRead = Math.min(klv.valueLength, 64 * 1024 * 1024);
      if (expandedRead > initialRead) {
        const more = await readBytes(file, klv.valueOffset, expandedRead);
        if (more && more.length > bytes.length) {
          bytes = more;
          trimmed = trimCodestream(bytes) || trimmed;
        }
      }
    }

    if (trimmed && isSuspiciousCodestream(trimmed.bytes, 0)) {
      const expandedRead = Math.min(Math.max(klv.valueLength, bytes.length * 8), 64 * 1024 * 1024);
      if (expandedRead > bytes.length) {
        const more = await readBytes(file, klv.valueOffset, expandedRead);
        if (more && more.length > bytes.length) {
          bytes = more;
          trimmed = trimCodestream(bytes) || trimmed;
        }
      }
    }

    if (!trimmed) return null;
    if (trimmed.eoc < 0 && isSuspiciousCodestream(trimmed.bytes, 0)) return null;
    return trimmed.bytes;
  }

  async function findNearbyEssenceBytes(approxPos, scanRadius) {
    const scanStart = Math.max(essenceStartOffset, approxPos - scanRadius);
    const scanEnd = Math.min(file.size, approxPos + scanRadius);
    const span = scanEnd - scanStart;
    if (span <= 16) return null;
    const hay = await readBytes(file, scanStart, span);
    if (!hay || hay.length < ESS_PREFIX.length) return null;

    const candidates = [];
    for (let i = 0; i + ESS_PREFIX.length <= hay.length; i++) {
      let ok = true;
      for (let j = 0; j < ESS_PREFIX.length; j++) {
        if (hay[i + j] != ESS_PREFIX[j]) { ok = false; break; }
      }
      if (ok) candidates.push(scanStart + i);
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => Math.abs(a - approxPos) - Math.abs(b - approxPos));
    for (const pos of candidates.slice(0, 24)) {
      const klv = await readKLV(file, pos);
      if (!isEss(klv)) continue;
      const bytes = await readCandidateBytes(klv);
      if (bytes) return bytes;
    }
    return null;
  }

  // Clip-wrapped JPEG 2000: stream offsets point inside one long essence value.
  if (wrappingKind === 'clip' && essenceValueOffset > 0 && frameOffsets && frameOffsets.length > 0) {
    let relStart = 0;
    let relEnd = 0;
    if (frameNumber < frameOffsets.length) {
      relStart = frameOffsets[frameNumber];
      relEnd = (frameNumber + 1 < frameOffsets.length) ? frameOffsets[frameNumber + 1] : essenceValueLength;
    } else if (expectedFrameCount > 1 && essenceValueLength > 0) {
      relStart = Math.max(0, Math.floor((frameNumber / expectedFrameCount) * essenceValueLength));
      relEnd = Math.min(essenceValueLength, relStart + Math.max(8 * 1024 * 1024, Math.floor(essenceValueLength / expectedFrameCount) * 6));
    } else {
      relStart = frameOffsets[Math.min(frameNumber, frameOffsets.length - 1)];
      relEnd = essenceValueLength;
    }
    if (relEnd <= relStart) relEnd = Math.min(essenceValueLength, relStart + 8 * 1024 * 1024);
    let hintedRead = Math.max(relEnd - relStart, 0);
    if (hintedRead < 64 * 1024) {
      hintedRead = Math.max(8 * 1024 * 1024, hintedRead * 64);
    }
    let maxRead = Math.min(hintedRead, 64 * 1024 * 1024);
    if (essenceValueLength > 0) maxRead = Math.min(maxRead, Math.max(1, essenceValueLength - relStart));
    let bytes = await readBytes(file, essenceValueOffset + relStart, maxRead);
    if (!bytes || bytes.length === 0) return null;
    let trimmed = trimCodestream(bytes);
    if (!trimmed) return null;
    if (trimmed.eoc < 0 && essenceValueLength > 0) {
      const expandedRead = Math.min(Math.max(maxRead * 2, 16 * 1024 * 1024), Math.max(1, essenceValueLength - relStart), 64 * 1024 * 1024);
      if (expandedRead > bytes.length) {
        const more = await readBytes(file, essenceValueOffset + relStart, expandedRead);
        if (more && more.length > bytes.length) {
          bytes = more;
          trimmed = trimCodestream(bytes) || trimmed;
        }
      }
    }
    if (trimmed.eoc < 0 && isSuspiciousCodestream(trimmed.bytes, 0)) return null;
    return trimmed.bytes;
  }

  let frameStart = 0;
  if (frameOffsets && frameNumber < frameOffsets.length) {
    frameStart = essenceStartOffset + frameOffsets[frameNumber];
  } else if (frameOffsets && frameOffsets.length > 0) {
    const essenceBytes = Math.max(0, file.size - essenceStartOffset);
    let approxPos = 0;
    let scanRadius = 0;

    if (expectedFrameCount > frameOffsets.length && expectedFrameCount > 1) {
      const ratio = frameNumber / (expectedFrameCount - 1);
      approxPos = essenceStartOffset + Math.round(ratio * essenceBytes);
      const perFrame = Math.max(256 * 1024, Math.round(essenceBytes / expectedFrameCount));
      scanRadius = Math.min(128 * 1024 * 1024, Math.max(12 * 1024 * 1024, perFrame * 6));
    } else if (avgFramePairBytes > 0) {
      const lastIdx = frameOffsets.length - 1;
      const lastOff = frameOffsets[lastIdx];
      const extraFrames = frameNumber - lastIdx;
      const approxOff = lastOff + Math.round(extraFrames * avgFramePairBytes);
      approxPos = essenceStartOffset + approxOff;
      scanRadius = Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, Math.round(avgFramePairBytes * 3)));
    }

    if (approxPos > 0 && scanRadius > 0) {
      const nearby = await findNearbyEssenceBytes(approxPos, scanRadius);
      if (nearby) return nearby;
      return null;
    }
  } else if (editUnitByteCount > 0) {
    frameStart = essenceStartOffset + frameNumber * editUnitByteCount;
  } else {
    return null;
  }

  let klv = await readKLV(file, frameStart);
  if (!isEss(klv)) {
    const nearStart = Math.max(essenceStartOffset, frameStart - 2 * 1024 * 1024);
    const nearEnd   = Math.min(file.size, frameStart + 4 * 1024 * 1024);
    let p = nearStart;
    while (p < nearEnd) {
      const t = await readKLV(file, p);
      if (!t || t.totalSize <= 0) break;
      if (isEss(t)) { klv = t; break; }
      if (t.totalSize > 32 * 1024 * 1024) break;
      p += t.totalSize;
    }
  }
  if (!klv) return null;
  return await readCandidateBytes(klv);
}

// ── Public: read PCM audio samples from an audio MXF file ────────────────────
// Walks audio essence KLVs (frame-wrapped or clip-wrapped).
// Handles:
//   · AES3 (SMPTE 382M) — 32-bit little-endian words, audio in bits[27:4]
//   · Raw PCM 24-bit big-endian interleaved
//   · Raw PCM 16-bit big-endian interleaved
// desc = { channels, sampleRate, quantBits, editRate }
// Returns { sampleRate, channels, pcmChannels: Float32Array[] } or null.
export async function readAudioMXF(file, desc = {}, maxSec = 10, onProgress = null) {
  const channels   = Math.max(1, (desc.channels | 0) || 2);
  const sampleRate = desc.sampleRate || 48000;
  const editRate   = desc.editRate   || 24;
  const maxSamples = Math.ceil(sampleRate * maxSec);

  // Walk the file to find the first audio essence KLV.
  // The header partition can be large; scan up to 50 MB.
  let ep = 0;
  let essStart = -1;
  const SCAN_LIMIT = Math.min(file.size, 50 * 1024 * 1024);

  while (ep < SCAN_LIMIT) {
    const klv = await readKLV(file, ep);
    if (!klv || klv.totalSize <= 0) break;
    const ek = klv.keyHex.replace(/\s/g, '');
    const isPartition = ek.startsWith('060e2b3402050101');
    const isFill      = ek.startsWith('060e2b340101010103010210');
    const isIndex     = ek.startsWith('060e2b340253');
    if (!isPartition && !isFill && !isIndex &&
        (ek.startsWith('060e2b3401020101') || ek.startsWith('060e2b34010101'))) {
      essStart = ep;
      break;
    }
    ep += klv.totalSize;
  }
  if (essStart < 0) return null;

  // ── Collect edit units up to maxSec ─────────────────────────────────────────
  // Auto-detect format from the bytes-per-sample-per-channel ratio of the
  // first edit unit:  ~4 = AES3,  ~3 = 24-bit raw PCM,  ~2 = 16-bit raw PCM
  const samplesPerFrame = Math.max(1, Math.round(sampleRate / editRate));
  let detectedFormat = null;  // 'aes3' | 'pcm24be' | 'pcm16be'
  const rawBuffers = [];
  let totalSamples = 0;
  let wp = essStart;

  while (wp < file.size && totalSamples < maxSamples) {
    const klv = await readKLV(file, wp);
    if (!klv || klv.totalSize <= 0) break;
    const ek = klv.keyHex.replace(/\s/g, '');
    const isEss = ek.startsWith('060e2b3401020101') || ek.startsWith('060e2b34010101');

    if (!isEss) {
      if (klv.totalSize > 256 * 1024 * 1024) break;  // safety against corrupt huge KLVs
      wp += klv.totalSize;
      continue;
    }

    if (!detectedFormat && klv.valueLength > 0) {
      const ratio = klv.valueLength / (samplesPerFrame * channels);
      if      (ratio >= 3.5) detectedFormat = 'aes3';
      else if (ratio >= 2.5) detectedFormat = 'pcm24be';
      else                   detectedFormat = 'pcm16be';
    }

    const bytesPerWord = detectedFormat === 'pcm16be' ? 2 : detectedFormat === 'pcm24be' ? 3 : 4;
    // Cap read at 8 MB per edit unit (handles both frame-wrapped and clip-wrapped)
    const readLen = Math.min(klv.valueLength, 8 * 1024 * 1024);
    const bytes = await readBytes(file, klv.valueOffset, readLen);
    if (bytes && bytes.length > 0) {
      rawBuffers.push(bytes);
      totalSamples += Math.floor(bytes.length / (channels * bytesPerWord));
      onProgress?.(Math.min(95, Math.round(totalSamples / maxSamples * 100)));
    }

    wp += klv.totalSize;
  }

  if (!rawBuffers.length || totalSamples === 0) return null;

  // ── Decode to Float32 per channel ───────────────────────────────────────────
  const clampedTotal = Math.min(totalSamples, maxSamples);
  const pcmChannels = Array.from({ length: channels }, () => new Float32Array(clampedTotal));
  let sampleIdx = 0;

  for (const bytes of rawBuffers) {
    if (sampleIdx >= clampedTotal) break;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (detectedFormat === 'aes3') {
      // SMPTE 382M: 32-bit LE words, audio in bits[27:4] (24-bit 2's-complement)
      const wordCount = Math.floor(bytes.length / 4);
      for (let i = 0; i < wordCount && sampleIdx < clampedTotal; i++) {
        const word = dv.getUint32(i * 4, true);   // little-endian
        const ch   = i % channels;
        const raw  = (word >>> 4) & 0xFFFFFF;
        pcmChannels[ch][sampleIdx] = ((raw & 0x800000) ? raw - 0x1000000 : raw) / 8388608.0;
        if (ch === channels - 1) sampleIdx++;
      }
    } else if (detectedFormat === 'pcm24be') {
      // 24-bit big-endian interleaved
      const n = Math.floor(bytes.length / 3);
      for (let i = 0; i < n && sampleIdx < clampedTotal; i++) {
        const ch  = i % channels;
        const off = i * 3;
        const raw = (bytes[off] << 16) | (bytes[off + 1] << 8) | bytes[off + 2];
        pcmChannels[ch][sampleIdx] = ((raw & 0x800000) ? raw - 0x1000000 : raw) / 8388608.0;
        if (ch === channels - 1) sampleIdx++;
      }
    } else {
      // 16-bit big-endian interleaved
      const n = Math.floor(bytes.length / 2);
      for (let i = 0; i < n && sampleIdx < clampedTotal; i++) {
        const ch = i % channels;
        pcmChannels[ch][sampleIdx] = dv.getInt16(i * 2, false) / 32768.0;
        if (ch === channels - 1) sampleIdx++;
      }
    }
  }

  onProgress?.(100);
  return { sampleRate, channels, pcmChannels: pcmChannels.map(c => c.subarray(0, sampleIdx)) };
}

// ── Embedded Dolby Vision CM XML extractor ──────────────────────────────────────
// Some IMF deliverables carry the Dolby Vision composition-metadata (CM) XML
// inside the picture MXF as a generic-stream/AXML partition instead of (or in
// addition to) a sidecar .xml. This pulls that XML back out so it can be fed to
// the existing metafier (parseDoviXml + annotateShots → cuts/shots).
//
// IMPORTANT: picture MXF files can be hundreds of GB, so we NEVER scan linearly.
// An embedded CM XML generic stream lives in a small partition that is, in
// practice, always within the file's header or footer region — so we scan only
// those bounded windows (a few tens of MB each).
async function _scanRangeForDoviXml(file, start, end) {
  const decoder   = new TextDecoder('latin1');
  const chunkSize = 4 * 1024 * 1024;
  const overlap   = 1024;
  const MAX_XML   = 80 * 1024 * 1024; // safety cap; real CM XML is well under this
  const CLOSE     = 'DolbyLabsMDF>';  // tail of </…DolbyLabsMDF> (prefix-tolerant)
  let carry = '';
  let collecting = false;
  let xml = '';
  for (let offset = start; offset < end; offset += chunkSize) {
    const buf = await readBytes(file, offset, Math.min(chunkSize, end - offset));
    if (!buf) break;
    const text = decoder.decode(buf);
    if (!collecting) {
      const hay = carry + text;
      const m = hay.indexOf('DolbyLabsMDF'); // root element name (namespace-agnostic)
      if (m < 0) { carry = hay.slice(-overlap); continue; }
      const lt = hay.lastIndexOf('<', m);    // back up to the opening '<'
      collecting = true;
      xml = lt >= 0 ? hay.slice(lt) : hay.slice(m);
    } else {
      xml += text;
    }
    const e = xml.indexOf(CLOSE);
    if (e >= 0) return xml.slice(0, e + CLOSE.length);
    if (xml.length > MAX_XML) break; // runaway guard
  }
  return null;
}

/**
 * Scan an MXF's header + footer regions for an embedded Dolby Vision CM XML.
 * @param {File|Blob} file
 * @param {{headBytes?:number, tailBytes?:number}} [opts]
 * @returns {Promise<string|null>} the CM XML text (<…DolbyLabsMDF>…</…DolbyLabsMDF>) or null
 */
export async function extractEmbeddedDoviXml(file, opts = {}) {
  if (!file || !file.size) return null;
  const headBytes = opts.headBytes ?? 64 * 1024 * 1024;  // first 64 MB
  const tailBytes = opts.tailBytes ?? 96 * 1024 * 1024;  // last 96 MB
  const ranges = [{ start: 0, end: Math.min(file.size, headBytes) }];
  if (file.size > headBytes + tailBytes) {
    ranges.push({ start: file.size - tailBytes, end: file.size });
  } else if (file.size > headBytes) {
    ranges.push({ start: headBytes, end: file.size });
  }
  for (const r of ranges) {
    try {
      const xml = await _scanRangeForDoviXml(file, r.start, r.end);
      if (xml) return xml;
    } catch (e) {
      console.warn('[MXF] DoVi XML scan failed for range', r, e);
    }
  }
  return null;
}
