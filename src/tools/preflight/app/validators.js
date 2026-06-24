
// Lightweight validators that can run inside a browser context.
function makeFinding(reqId, checkId, check, extra={}){
  return {
    id: `${reqId}::${checkId}`,
    reqId,
    checkId,
    severity: check.severity,
    title: check.title,
    issue: check.issue,
    module: check.module,
    ...extra
  };
}

async function readBytes(file, start, length){
  const blob = file.slice(start, start + length);
  const buf = await blob.arrayBuffer();
  return new DataView(buf);
}

// Minimal WAV parser (PCM/BWAV) - reads RIFF header for format, channels, sample rate, bit depth, and duration.
async function parseWav(file){
  const dv = await readBytes(file, 0, Math.min(4096, file.size));
  const riff = String.fromCharCode(dv.getUint8(0),dv.getUint8(1),dv.getUint8(2),dv.getUint8(3));
  const wave = String.fromCharCode(dv.getUint8(8),dv.getUint8(9),dv.getUint8(10),dv.getUint8(11));
  const isRF64 = (riff === "RF64");
  if (riff !== "RIFF" && !isRF64) return { ok:false, reason:"not_wav" };
  if (wave !== "WAVE") return { ok:false, reason:"not_wav" };

  // RF64 (>4GB WAV): ds64 chunk at offset 12 holds the real 64-bit data size.
  let rf64DataSize = null;
  if (isRF64 && dv.byteLength >= 44) {
    const ds64Id = String.fromCharCode(dv.getUint8(12),dv.getUint8(13),dv.getUint8(14),dv.getUint8(15));
    if (ds64Id === "ds64") {
      const lo = dv.getUint32(28, true);
      const hi = dv.getUint32(32, true);
      rf64DataSize = hi * 0x100000000 + lo;
    }
  }

  let offset = 12;
  let fmt = null;
  let dataSize = null;
  while (offset + 8 <= dv.byteLength) {
    const id = String.fromCharCode(dv.getUint8(offset),dv.getUint8(offset+1),dv.getUint8(offset+2),dv.getUint8(offset+3));
    const size = dv.getUint32(offset+4, true);
    if (id === "fmt ") {
      const audioFormat = dv.getUint16(offset+8, true); // 1=PCM, 3=float, 65534=extensible
      const channels = dv.getUint16(offset+10, true);
      const sampleRate = dv.getUint32(offset+12, true);
      const bitsPerSample = (offset + 24 <= dv.byteLength) ? dv.getUint16(offset+22, true) : 0;
      fmt = { audioFormat, channels, sampleRate, bitsPerSample };
    }
    if (id === "data") {
      // RF64: data chunk size field is 0xFFFFFFFF — use the ds64 value instead
      if (isRF64 && size === 0xFFFFFFFF && rf64DataSize != null) {
        dataSize = rf64DataSize;
      } else {
        dataSize = (size > 0 && size < file.size) ? size : Math.max(0, file.size - offset - 8);
      }
    }
    if (fmt && dataSize !== null) break;
    // RIFF spec: odd-sized chunks have a silent pad byte that must be skipped.
    offset += 8 + size + (size & 1);
  }
  if (!fmt) return { ok:false, reason:"no_fmt" };

  const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
  const durationSec = (bytesPerSec > 0 && dataSize != null) ? dataSize / bytesPerSec : null;

  return { ok:true, ...fmt, dataSize, durationSec, isRF64 };
}

// Probe a MOV/QuickTime file for the ProRes codec 4CC without parsing the full atom tree.
// ProRes stores its 4CC in the stsd box; scanning the first 64KB is fast and reliable.
async function probeProResProfile(file){
  const buf = await file.slice(0, Math.min(65536, file.size)).arrayBuffer();
  const u8 = new Uint8Array(buf);
  const profiles = [
    { fourcc:"apch", name:"ProRes 422 HQ" },
    { fourcc:"ap4x", name:"ProRes 4444 XQ" },
    { fourcc:"ap4h", name:"ProRes 4444" },
    { fourcc:"apcn", name:"ProRes 422" },
    { fourcc:"apcs", name:"ProRes 422 LT" },
    { fourcc:"apco", name:"ProRes 422 Proxy" }
  ];
  for (const p of profiles) {
    const b0=p.fourcc.charCodeAt(0), b1=p.fourcc.charCodeAt(1), b2=p.fourcc.charCodeAt(2), b3=p.fourcc.charCodeAt(3);
    for (let i = 0; i < u8.length - 4; i++) {
      if (u8[i]===b0 && u8[i+1]===b1 && u8[i+2]===b2 && u8[i+3]===b3) {
        return { ok:true, fourcc:p.fourcc, name:p.name };
      }
    }
  }
  return { ok:false, reason:"no_prores_4cc" };
}

function detectIllegalNames(paths){
  const illegal = [];
  const okRe = /^[a-z0-9_\-./ ]+$/i;
  for (const p of paths) {
    // Keep it permissive but flag obvious offenders (control chars, quotes, pipes, etc.)
    if (!okRe.test(p) || /[<>:"|?*\u0000-\u001F]/.test(p)) illegal.push(p);
  }
  return illegal.slice(0, 20);
}


// ---------- IMF XML helpers (browser DOMParser) ----------
function parseXmlText(xmlText){
  const doc = new DOMParser().parseFromString(String(xmlText || ''), 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('Invalid XML');
  return doc;
}

function elChildren(node){
  return Array.from(node?.childNodes || []).filter(n => n.nodeType === 1);
}

function childByLocalName(node, localName){
  return elChildren(node).find(n => n.localName === localName) || null;
}

function childText(node, localName){
  const n = childByLocalName(node, localName);
  return n ? String(n.textContent || '').trim() : null;
}

function collectAssetIds(doc){
  const assets = Array.from(doc.getElementsByTagNameNS('*', 'Asset'));
  const ids = new Set();
  for (const a of assets) {
    const id = childText(a, 'Id');
    if (id) ids.add(id);
  }
  return ids;
}

function collectCplTrackFileMap(doc){
  const resources = Array.from(doc.getElementsByTagNameNS('*', 'Resource'));
  const map = new Map();
  for (const r of resources) {
    const tfid = childText(r, 'TrackFileId');
    if (!tfid) continue;
    const anno = childText(r, 'Annotation') || childText(r, 'AnnotationText') || '';
    if (!map.has(tfid)) map.set(tfid, anno);
  }
  return map;
}




function collectCplTrackHashMap(doc){
  const resources = Array.from(doc.getElementsByTagNameNS('*', 'Resource'));
  const map = new Map();
  for (const r of resources) {
    const tfidRaw = childText(r, 'TrackFileId');
    if (!tfidRaw) continue;
    const key = String(tfidRaw).trim().toLowerCase().replace(/^urn:uuid:/i, '');
    const anno = childText(r, 'Annotation') || childText(r, 'AnnotationText') || '';
    const hash = childText(r, 'Hash');
    const hashAlgoNode = childByLocalName(r, 'HashAlgorithm');
    const algo = (hashAlgoNode && (hashAlgoNode.getAttribute('Algorithm') || hashAlgoNode.getAttribute('algorithm'))) || null;

    let entry = map.get(key);
    if (!entry) {
      entry = {
        trackFileId: tfidRaw,
        annotations: new Set(),
        hashes: new Set(),
        algorithms: new Set(),
        totalResources: 0,
        missingHashResources: 0
      };
      map.set(key, entry);
    }

    entry.totalResources++;
    if (anno) entry.annotations.add(String(anno).trim());
    if (hash) entry.hashes.add(String(hash).trim());
    else entry.missingHashResources++;
    if (algo) entry.algorithms.add(String(algo).trim());
  }
  return map;
}

// ---------- IMF deep-check helpers ----------
function normalizePath(p){
  return String(p || '').replace(/\\/g,'/').replace(/^\.\//,'').replace(/^\/+/, '').trim();
}

function buildFilePathMap(fileList){
  const map = new Map();
  for (const f of (fileList || [])) {
    const raw = normalizePath((f && (f.__pfxRelPath || f.webkitRelativePath || f.name)) || '');
    if (!raw) continue;
    const lower = raw.toLowerCase();
    if (lower && !map.has(lower)) map.set(lower, f);

    // Also map without the leading top-level folder (common when selecting a folder)
    const parts = lower.split('/');
    if (parts.length > 1) {
      const stripped = parts.slice(1).join('/');
      if (stripped && !map.has(stripped)) map.set(stripped, f);
    }
  }
  return map;
}

function stripUrnUuid(id){
  const s = String(id || '').trim();
  return s.toLowerCase().startsWith('urn:uuid:') ? s.slice(9) : s;
}

function isUuid(id){
  const u = stripUrnUuid(id);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u);
}

function collectAssetIdList(doc){
  const assets = Array.from(doc.getElementsByTagNameNS('*', 'Asset'));
  const ids = [];
  for (const a of assets) {
    const id = childText(a, 'Id');
    if (id) ids.push(id);
  }
  return ids;
}

function collectAssetMapChunks(doc){
  const assets = Array.from(doc.getElementsByTagNameNS('*', 'Asset'));
  const out = [];
  for (const a of assets) {
    const id = childText(a, 'Id');
    const chunks = Array.from(a.getElementsByTagNameNS('*', 'Chunk'));
    if (!chunks.length) continue;
    const c = chunks[0];
    const path = childText(c, 'Path');
    const length = childText(c, 'Length');
    out.push({ id, path, length: length != null ? Number(length) : null });
  }
  return out;
}

function collectAssetMapIdToPath(doc){
  const out = new Map();
  for (const ch of collectAssetMapChunks(doc)) {
    if (ch.id && ch.path) out.set(ch.id, ch.path);
  }
  return out;
}

function collectPklAssets(doc){
  const assets = Array.from(doc.getElementsByTagNameNS('*', 'Asset'));
  const out = [];
  for (const a of assets) {
    const id = childText(a, 'Id');
    if (!id) continue;
    const sizeStr = childText(a, 'Size');
    const size = sizeStr != null ? Number(sizeStr) : null;
    const type = childText(a, 'Type');
    const anno = childText(a, 'AnnotationText') || '';
    const ofn = childText(a, 'OriginalFileName') || '';
    const hashNode = childByLocalName(a, 'Hash');
    const hash = hashNode ? String(hashNode.textContent || '').trim() : null;
    const hashAlgoNode = childByLocalName(a, 'HashAlgorithm');
    const algorithm = (hashAlgoNode && hashAlgoNode.getAttribute('Algorithm')) || (hashNode && hashNode.getAttribute && hashNode.getAttribute('Algorithm')) || null;
    out.push({ id, size, type, annotationText: anno, originalFileName: ofn, hash, algorithm });
  }
  return out;
}

function findDuplicateIds(ids){
  const counts = new Map();
  for (const id of (ids || [])) {
    const k = stripUrnUuid(id).toLowerCase();
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const dups = [];
  for (const [k, c] of counts.entries()) {
    if (c > 1) dups.push({ id: 'urn:uuid:' + k, count: c });
  }
  return dups;
}

function parseEditRateText(s){
  const t = String(s || '').trim();
  if (!t) return null;
  const parts = t.includes('/') ? t.split('/') : t.split(/\s+/);
  if (parts.length < 2) return null;
  const num = Number(parts[0]);
  const den = Number(parts[1]);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return { num, den };
}

function rateUnitsToSeconds(units, rate){
  if (!rate || !Number.isFinite(units)) return null;
  return (Number(units) * rate.den) / rate.num;
}

function safeInt(v, fallback = null){
  if (v == null) return fallback;
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}


// ---------- MXF helpers (partition pack parse; lightweight) ----------
function _u8ToUlDotted(u8){
  if (!u8 || u8.length < 16) return null;
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += u8[i].toString(16).padStart(2, '0');
    if ((i % 4) === 3 && i !== 15) out += ".";
  }
  return out;
}

async function readU8(file, start, length){
  const ab = await file.slice(start, start + length).arrayBuffer();
  return new Uint8Array(ab);
}

function _findBytes(hay, needle, limit){
  const n = needle.length;
  const L = Math.min(hay.length, (Number.isFinite(limit) ? limit : hay.length));
  for (let i = 0; i + n <= L; i++) {
    if (hay[i] !== needle[0]) continue;
    let ok = true;
    for (let j = 1; j < n; j++) {
      if (hay[i + j] !== needle[j]) { ok = false; break; }
    }
    if (ok) return i;
  }
  return -1;
}

function _readBerLength(dv, off){
  const b0 = dv.getUint8(off);
  if (b0 < 0x80) return { len: b0, bytes: 1 };
  if (b0 === 0x80) return { len: null, bytes: 1, indefinite: true };
  const n = b0 & 0x7f;
  if (n <= 0 || n > 8) return { len: null, bytes: 1, invalid: true };
  let v = 0n;
  for (let i = 0; i < n; i++) {
    v = (v << 8n) | BigInt(dv.getUint8(off + 1 + i));
  }
  const num = (v <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(v) : null;
  return { len: num, bytes: 1 + n, big: v };
}

function _getU64(dv, off){
  if (typeof dv.getBigUint64 === 'function') return dv.getBigUint64(off, false);
  const hi = dv.getUint32(off, false);
  const lo = dv.getUint32(off + 4, false);
  return (BigInt(hi) << 32n) | BigInt(lo);
}

const _MXF_PARTITION_KEYS = {
  header: new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x05,0x01,0x01,0x0d,0x01,0x02,0x01,0x01,0x02,0x04,0x00]),
  body:   new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x05,0x01,0x01,0x0d,0x01,0x02,0x01,0x01,0x03,0x04,0x00]),
  footer: new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x05,0x01,0x01,0x0d,0x01,0x02,0x01,0x01,0x04,0x04,0x00])
};

async function parseMxfHeaderPartitionPack(file, opts = {}){
  const searchLimit = Number.isFinite(opts.searchLimit) ? opts.searchLimit : 4096;
  const probeLen = Math.min(file.size, searchLimit + 512);
  if (probeLen < 32) return { ok:false, error:'too_small', size:file.size };

  let probe;
  try {
    probe = await readU8(file, 0, probeLen);
  } catch (e) {
    return { ok:false, error:'read_error', detail:String(e && e.message ? e.message : e) };
  }

  // Find first partition pack (prefer earliest occurrence)
  const hits = [];
  for (const [kind, key] of Object.entries(_MXF_PARTITION_KEYS)) {
    const off = _findBytes(probe, key, searchLimit);
    if (off >= 0) hits.push({ kind, off });
  }
  if (!hits.length) return { ok:false, error:'partition_pack_not_found' };
  hits.sort((a,b)=>a.off-b.off);
  const first = hits[0];

  // Read enough bytes to cover the partition pack KLV.
  let readLen = Number.isFinite(opts.readLen) ? opts.readLen : 2048;
  readLen = Math.min(readLen, Math.max(256, file.size - first.off));
  let ab;
  try {
    ab = await file.slice(first.off, first.off + readLen).arrayBuffer();
  } catch (e) {
    return { ok:false, error:'read_error', detail:String(e && e.message ? e.message : e) };
  }
  let dv = new DataView(ab);
  if (dv.byteLength < 32) return { ok:false, error:'partition_pack_truncated', offset:first.off };

  const ber = _readBerLength(dv, 16);
  if (ber.indefinite) return { ok:false, error:'partition_pack_indefinite_len', offset:first.off };
  if (ber.invalid || ber.len == null) return { ok:false, error:'partition_pack_invalid_len', offset:first.off };
  const valueLen = ber.len;
  const valueOff = 16 + ber.bytes;
  const totalLen = valueOff + valueLen;

  if (totalLen > dv.byteLength) {
    // Re-read a larger window if needed.
    const need = Math.min(file.size - first.off, Math.max(totalLen + 32, 4096));
    try {
      ab = await file.slice(first.off, first.off + need).arrayBuffer();
      dv = new DataView(ab);
    } catch (e) {
      return { ok:false, error:'read_error', detail:String(e && e.message ? e.message : e) };
    }
    if (totalLen > dv.byteLength) return { ok:false, error:'partition_pack_truncated', offset:first.off, need: totalLen, have: dv.byteLength };
  }

  if (valueLen < 80) return { ok:false, error:'partition_pack_value_too_short', offset:first.off, valueLen };

  let p = valueOff;
  const major = dv.getUint16(p, false); p += 2;
  const minor = dv.getUint16(p, false); p += 2;
  const kagSize = dv.getUint32(p, false); p += 4;
  const thisPartition = _getU64(dv, p); p += 8;
  const prevPartition = _getU64(dv, p); p += 8;
  const footerPartition = _getU64(dv, p); p += 8;
  const headerByteCount = _getU64(dv, p); p += 8;
  const indexByteCount = _getU64(dv, p); p += 8;
  const indexSID = dv.getUint32(p, false); p += 4;
  const bodyOffset = _getU64(dv, p); p += 8;
  const bodySID = dv.getUint32(p, false); p += 4;

  const opPattern = new Uint8Array(ab.slice(p, p + 16));
  p += 16;

  let essenceContainers = [];
  if (p + 8 <= valueOff + valueLen) {
    const count = dv.getUint32(p, false); p += 4;
    const elemLen = dv.getUint32(p, false); p += 4;
    if (count > 0 && elemLen > 0 && (p + (count * elemLen)) <= (valueOff + valueLen)) {
      for (let i = 0; i < count; i++) {
        const start = p + i * elemLen;
        const ul = new Uint8Array(ab.slice(start, start + Math.min(16, elemLen)));
        if (ul.length === 16) essenceContainers.push(_u8ToUlDotted(ul));
      }
    }
  }


  const headerByteCountNum = (headerByteCount <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(headerByteCount) : null;
  const indexByteCountNum = (indexByteCount <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(indexByteCount) : null;
  const partitionPackKlvLen = totalLen;
  const partitionPackEnd = first.off + totalLen;

  return {
    ok: true,
    offset: first.off,
    packKind: first.kind,
    major,
    minor,
    kagSize,
    partitionPackKlvLen,
    partitionPackEnd,
    thisPartition: (thisPartition <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(thisPartition) : String(thisPartition),
    prevPartition: (prevPartition <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(prevPartition) : String(prevPartition),
    footerPartition: (footerPartition <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(footerPartition) : String(footerPartition),
    headerByteCount: headerByteCountNum != null ? headerByteCountNum : String(headerByteCount),
    headerByteCountNum,
    indexByteCount: indexByteCountNum != null ? indexByteCountNum : String(indexByteCount),
    indexByteCountNum,
    indexSID,
    bodyOffset: (bodyOffset <= BigInt(Number.MAX_SAFE_INTEGER)) ? Number(bodyOffset) : String(bodyOffset),
    bodySID,
    operationalPattern: _u8ToUlDotted(opPattern),
    essenceContainers: essenceContainers.filter(Boolean)
  
  };
}

// ---------- MXF header metadata (Primer Pack + descriptor readout; lightweight) ----------
const _MXF_KLV_FILL_KEY = new Uint8Array([0x06,0x0e,0x2b,0x34,0x01,0x01,0x01,0x02,0x03,0x01,0x02,0x10,0x01,0x00,0x00,0x00]);
const _MXF_PRIMER_KEY   = new Uint8Array([0x06,0x0e,0x2b,0x34,0x02,0x05,0x01,0x01,0x0d,0x01,0x02,0x01,0x01,0x05,0x01,0x00]);

function _u8Eq(a, b){
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function _ulLower(u8){
  const s = _u8ToUlDotted(u8);
  return s ? String(s).toLowerCase() : null;
}

// ULs for key descriptor items (from SMPTE ST 377-1 dictionaries)
const _MXF_ITEM_UL = {
  sampleRate:          '060e2b34.01010101.04060101.00000000', // FileDescriptor::SampleRate
  storedWidth:         '060e2b34.01010101.04010502.02000000',
  storedHeight:        '060e2b34.01010101.04010502.01000000',
  sampledWidth:        '060e2b34.01010101.04010501.07000000',
  sampledHeight:       '060e2b34.01010101.04010501.08000000',
  displayWidth:        '060e2b34.01010101.04010501.0c000000',
  displayHeight:       '060e2b34.01010101.04010501.0b000000',
  audioSamplingRate:   '060e2b34.01010105.04020301.01010000',
  channelCount:        '060e2b34.01010105.04020101.04000000',
  quantizationBits:    '060e2b34.01010104.04020303.04000000',
};

function _parsePrimerPack(dv, u8, valueOff, valueLen){
  // Primer Pack value: UInt32 count, UInt32 itemLen, then count entries of (UInt16 localTag + UL)
  if (valueLen < 8) return { ok:false, error:'primer_too_short' };
  const count = dv.getUint32(valueOff, false);
  const itemLen = dv.getUint32(valueOff + 4, false);
  if (!count || !itemLen) return { ok:false, error:'primer_invalid_header', count, itemLen };
  const need = 8 + (count * itemLen);
  if (need > valueLen) return { ok:false, error:'primer_truncated', need, have:valueLen, count, itemLen };

  const map = new Map();
  const entries = Math.min(count, 100000);
  let off = valueOff + 8;
  for (let i = 0; i < entries; i++) {
    if (off + itemLen > valueOff + valueLen) break;
    if (itemLen < 18) { off += itemLen; continue; }
    const tag = dv.getUint16(off, false);
    const ul = _ulLower(u8.slice(off + 2, off + 18));
    if (ul) map.set(tag, ul);
    off += itemLen;
  }

  return { ok:true, map, count: map.size, itemLen };
}

function _pushSetVal(out, key, val){
  if (val == null) return;
  if (!out[key]) out[key] = new Set();
  out[key].add(val);
}

function _finalizeSet(set){
  if (!set || !(set instanceof Set) || set.size === 0) return null;
  const arr = Array.from(set);
  return arr.length === 1 ? arr[0] : arr;
}

async function parseMxfHeaderMetadataBasics(file, opts = {}){
  const maxHeaderBytes = Number.isFinite(opts.maxHeaderBytes) ? opts.maxHeaderBytes : (4 * 1024 * 1024);

  let part;
  try {
    part = await parseMxfHeaderPartitionPack(file, { searchLimit: 4096, readLen: 4096 });
  } catch (e) {
    return { ok:false, error:'partition_pack_exception', detail:String(e && e.message ? e.message : e) };
  }
  if (!part || !part.ok) return { ok:false, error:'partition_pack_failed', detail: part?.error || null };

  const start = Number.isFinite(part.partitionPackEnd) ? part.partitionPackEnd : null;
  if (!Number.isFinite(start) || start < 0 || start >= file.size) {
    return { ok:false, error:'invalid_header_start', start, fileSize:file.size };
  }

  const headerByteCount = Number.isFinite(part.headerByteCountNum) ? part.headerByteCountNum : (typeof part.headerByteCount === 'number' ? part.headerByteCount : Number(String(part.headerByteCount || '0')));
  const expected = (Number.isFinite(headerByteCount) && headerByteCount > 0) ? headerByteCount : null;

  const readLen = Math.min(file.size - start, expected ? Math.min(expected, maxHeaderBytes) : Math.min(maxHeaderBytes, file.size - start));
  if (readLen < 64) return { ok:false, error:'header_region_too_small', readLen };

  let u8;
  try {
    u8 = await readU8(file, start, readLen);
  } catch (e) {
    return { ok:false, error:'read_error', detail:String(e && e.message ? e.message : e) };
  }

  const dv = new DataView(u8.buffer);
  let off = 0;
  let primer = null;
  let primerInfo = null;
  const found = {}; // key -> Set
  const warnings = [];

  // Iterate KLVs within the header metadata region we loaded.
  while (off + 17 <= u8.length) {
    const keyBytes = u8.slice(off, off + 16);
    const ber = _readBerLength(dv, off + 16);
    if (ber.invalid || ber.indefinite || ber.len == null) break;
    const valueOff = off + 16 + ber.bytes;
    const valueLen = ber.len;
    const next = valueOff + valueLen;
    if (next > u8.length) break;

    if (_u8Eq(keyBytes, _MXF_PRIMER_KEY)) {
      const pr = _parsePrimerPack(dv, u8, valueOff, valueLen);
      primerInfo = pr;
      if (pr.ok) primer = pr.map;
      else warnings.push({ kind:'primer_parse_failed', ...pr });
    } else if (primer && !_u8Eq(keyBytes, _MXF_KLV_FILL_KEY)) {
      // Best-effort parse as 2-byte length Local Set.
      let p = valueOff;
      const end = valueOff + valueLen;
      let safety = 0;
      while (p + 4 <= end && safety++ < 200000) {
        const tag = dv.getUint16(p, false);
        const len = dv.getUint16(p + 2, false);
        p += 4;
        if (len === 0) break; // getUint16 is always ≥ 0; guard against zero-len infinite loop
        if (p + len > end) break;
        const ul = primer.get(tag);
        if (ul) {
          if (ul === _MXF_ITEM_UL.storedWidth || ul === _MXF_ITEM_UL.storedHeight || ul === _MXF_ITEM_UL.sampledWidth || ul === _MXF_ITEM_UL.sampledHeight || ul === _MXF_ITEM_UL.displayWidth || ul === _MXF_ITEM_UL.displayHeight || ul === _MXF_ITEM_UL.channelCount || ul === _MXF_ITEM_UL.quantizationBits) {
            if (len === 4) {
              const v = dv.getUint32(p, false);
              if (ul === _MXF_ITEM_UL.storedWidth) _pushSetVal(found, 'storedWidth', v);
              else if (ul === _MXF_ITEM_UL.storedHeight) _pushSetVal(found, 'storedHeight', v);
              else if (ul === _MXF_ITEM_UL.sampledWidth) _pushSetVal(found, 'sampledWidth', v);
              else if (ul === _MXF_ITEM_UL.sampledHeight) _pushSetVal(found, 'sampledHeight', v);
              else if (ul === _MXF_ITEM_UL.displayWidth) _pushSetVal(found, 'displayWidth', v);
              else if (ul === _MXF_ITEM_UL.displayHeight) _pushSetVal(found, 'displayHeight', v);
              else if (ul === _MXF_ITEM_UL.channelCount) _pushSetVal(found, 'channelCount', v);
              else if (ul === _MXF_ITEM_UL.quantizationBits) _pushSetVal(found, 'quantizationBits', v);
            }
          } else if (ul === _MXF_ITEM_UL.sampleRate || ul === _MXF_ITEM_UL.audioSamplingRate) {
            if (len === 8) {
              const num = dv.getUint32(p, false);
              const den = dv.getUint32(p + 4, false);
              const s = `${num}/${den}`;
              if (ul === _MXF_ITEM_UL.sampleRate) _pushSetVal(found, 'sampleRate', s);
              else if (ul === _MXF_ITEM_UL.audioSamplingRate) _pushSetVal(found, 'audioSamplingRate', s);
            }
          }
        }
        p += len;
      }
    }

    off = next;
  }

  return {
    ok: true,
    partition: {
      packKind: part.packKind,
      operationalPattern: part.operationalPattern || null,
      essenceContainers: Array.isArray(part.essenceContainers) ? part.essenceContainers.slice(0, 12) : []
    },
    headerStart: start,
    headerByteCount: expected,
    headerBytesRead: readLen,
    headerTruncated: (expected != null && expected > readLen),
    primerCount: primerInfo?.count ?? null,
    primerItemLen: primerInfo?.itemLen ?? null,
    warnings: warnings.slice(0, 10),
    values: {
      storedWidth: _finalizeSet(found.storedWidth),
      storedHeight: _finalizeSet(found.storedHeight),
      sampledWidth: _finalizeSet(found.sampledWidth),
      sampledHeight: _finalizeSet(found.sampledHeight),
      displayWidth: _finalizeSet(found.displayWidth),
      displayHeight: _finalizeSet(found.displayHeight),
      sampleRate: _finalizeSet(found.sampleRate),
      audioSamplingRate: _finalizeSet(found.audioSamplingRate),
      channelCount: _finalizeSet(found.channelCount),
      quantizationBits: _finalizeSet(found.quantizationBits),
    }
  };
}

function collectCplTrackFileUsages(doc){
  const map = new Map();
  if (!doc) return map;
  const root = doc.documentElement;
  const segList = root ? childByLocalName(root, 'SegmentList') : null;
  const segments = segList ? elChildren(segList).filter(n => n.localName === 'Segment') : [];

  for (let sidx = 0; sidx < segments.length; sidx++) {
    const seg = segments[sidx];
    const segNum = sidx + 1;
    const seqList = childByLocalName(seg, 'SequenceList');
    const seqs = seqList ? elChildren(seqList) : [];
    for (const seq of seqs) {
      const seqType = seq.localName;
      const resList = childByLocalName(seq, 'ResourceList');
      const resources = resList ? elChildren(resList).filter(n => n.localName === 'Resource') : [];
      for (const r of resources) {
        const tfid = childText(r, 'TrackFileId');
        if (!tfid) continue;
        const key = stripUrnUuid(tfid).toLowerCase();
        const anno = childText(r, 'Annotation') || childText(r, 'AnnotationText') || '';
        const rid = childText(r, 'Id') || '';
        let entry = map.get(key);
        if (!entry) {
          entry = {
            trackFileId: tfid,
            annotations: new Set(),
            sequenceTypes: new Set(),
            usages: []
          };
          map.set(key, entry);
        }
        if (anno) entry.annotations.add(String(anno).trim());
        entry.sequenceTypes.add(seqType);
        entry.usages.push({ segment: segNum, sequence: seqType, resourceId: rid, annotation: anno });
      }
    }
  }

  return map;
}



// ---------- SHA-1 (incremental, browser-only) ----------
function _sha1Rotl(x, n){ return ((x << n) | (x >>> (32 - n))) >>> 0; }

class Sha1 {
  constructor(){
    this.h0 = 0x67452301;
    this.h1 = 0xEFCDAB89;
    this.h2 = 0x98BADCFE;
    this.h3 = 0x10325476;
    this.h4 = 0xC3D2E1F0;
    this._buf = new Uint8Array(0);
    this._len = 0n; // bytes
  }

  update(u8){
    if (!u8 || u8.length === 0) return this;
    if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);

    this._len += BigInt(u8.length);

    // Prepend leftover buffer if present
    if (this._buf.length) {
      const joined = new Uint8Array(this._buf.length + u8.length);
      joined.set(this._buf, 0);
      joined.set(u8, this._buf.length);
      u8 = joined;
      this._buf = new Uint8Array(0);
    }

    let off = 0;
    while (off + 64 <= u8.length) {
      this._processBlock(u8, off);
      off += 64;
    }

    this._buf = u8.slice(off);
    return this;
  }

  _processBlock(b, off){
    const w = new Uint32Array(80);
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = ((b[j] << 24) | (b[j + 1] << 16) | (b[j + 2] << 8) | (b[j + 3])) >>> 0;
    }
    for (let i = 16; i < 80; i++) {
      w[i] = _sha1Rotl((w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]) >>> 0, 1);
    }

    let a = this.h0;
    let b0 = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;

    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b0 & c) | ((~b0) & d); k = 0x5A827999; }
      else if (i < 40) { f = b0 ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b0 & c) | (b0 & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b0 ^ c ^ d; k = 0xCA62C1D6; }

      const temp = (_sha1Rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = _sha1Rotl(b0, 30);
      b0 = a;
      a = temp;
    }

    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b0) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
  }

  digestBytes(){
    // Final padding
    const bits = this._len * 8n;
    const buf = this._buf || new Uint8Array(0);
    const padLen = (64 - ((buf.length + 1 + 8) % 64)) % 64;
    const fin = new Uint8Array(buf.length + 1 + padLen + 8);
    fin.set(buf, 0);
    fin[buf.length] = 0x80;

    const hi = Number((bits >> 32n) & 0xffffffffn);
    const lo = Number(bits & 0xffffffffn);
    const p = fin.length - 8;
    fin[p + 0] = (hi >>> 24) & 0xff;
    fin[p + 1] = (hi >>> 16) & 0xff;
    fin[p + 2] = (hi >>> 8) & 0xff;
    fin[p + 3] = (hi >>> 0) & 0xff;
    fin[p + 4] = (lo >>> 24) & 0xff;
    fin[p + 5] = (lo >>> 16) & 0xff;
    fin[p + 6] = (lo >>> 8) & 0xff;
    fin[p + 7] = (lo >>> 0) & 0xff;

    // Process final blocks
    for (let off = 0; off < fin.length; off += 64) {
      this._processBlock(fin, off);
    }

    const out = new Uint8Array(20);
    const words = [this.h0, this.h1, this.h2, this.h3, this.h4];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      out[i * 4 + 0] = (w >>> 24) & 0xff;
      out[i * 4 + 1] = (w >>> 16) & 0xff;
      out[i * 4 + 2] = (w >>> 8) & 0xff;
      out[i * 4 + 3] = (w >>> 0) & 0xff;
    }
    return out;
  }
}

function _bytesToBase64(u8){
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

async function sha1FileBase64(file, opts = {}){
  const chunkSize = Number.isFinite(opts.chunkSize) ? opts.chunkSize : (8 * 1024 * 1024);
  const yieldEvery = Number.isFinite(opts.yieldEvery) ? opts.yieldEvery : 2;

  const sha = new Sha1();
  let offset = 0;
  let iter = 0;

  while (offset < file.size) {
    const end = Math.min(file.size, offset + chunkSize);
    const ab = await file.slice(offset, end).arrayBuffer();
    sha.update(new Uint8Array(ab));
    offset = end;
    iter++;
    if (yieldEvery > 0 && (iter % yieldEvery) === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  return _bytesToBase64(sha.digestBytes());
}

export async function analyzeFiles(config, reqList, files, filesByReq, prevManual = {}, prevChecklist = {}){
  const findingsByReq = {};
  const manualState = { ...(prevManual || {}) };     // findingId -> boolean (confirmed/ignored)
  const checklistState = { ...(prevChecklist || {}) };  // findingId -> { itemId: boolean }


  // Cache parsed IMF XMLs per requirement to avoid re-reading/parsing on multiple checks.
  const imfCtxCache = {};

  // Cache MXF partition pack parsing per requirement (lightweight header probe).
  const mxfPartitionCache = {};
  const mxfHeaderMetaCache = {};

  const getImfCtx = async (reqId, idxs) => {
    if (imfCtxCache[reqId]) return imfCtxCache[reqId];

    const p = (async () => {
      const getPath = (f) => (f && (f.__pfxRelPath || f.webkitRelativePath || f.name)) || "";
      const lower = (s) => String(s || "").toLowerCase();

      const reqFiles = (idxs || []).map(i => files[i]).filter(Boolean);
      const assetmapFile = reqFiles.find(f => /(^|\/)(assetmap)(\.xml)?$/.test(lower(getPath(f))));
      const pklFile = reqFiles.find(f => lower(getPath(f)).endsWith('.xml') && lower(getPath(f)).includes('pkl'));
      const cplFile =
        reqFiles.find(f => lower(getPath(f)).endsWith('.cpl.xml')) ||
        reqFiles.find(f => lower(getPath(f)).endsWith('.xml') && lower(getPath(f)).includes('cpl'));

      const fileMap = buildFilePathMap(reqFiles);

      const ctx = {
        ok: true,
        files: { assetmapFile, pklFile, cplFile, reqFiles },
        paths: {
          assetmapPath: assetmapFile ? getPath(assetmapFile) : null,
          pklPath: pklFile ? getPath(pklFile) : null,
          cplPath: cplFile ? getPath(cplFile) : null,
        },
        fileMap,
        assetMapXml: null,
        pklXml: null,
        cplXml: null,
        amDoc: null,
        pklDoc: null,
        cplDoc: null,
        amChunks: [],
        amIds: null,
        amIdToPath: new Map(),
        pklIds: null,
        pklAssets: [],
        cplTrackMap: new Map(),
        cplTrackHashMap: new Map(),
      };

      if (assetmapFile) {
        ctx.assetMapXml = await assetmapFile.text();
        ctx.amDoc = parseXmlText(ctx.assetMapXml);
        ctx.amChunks = collectAssetMapChunks(ctx.amDoc);
        ctx.amIds = collectAssetIds(ctx.amDoc);
        ctx.amIdToPath = collectAssetMapIdToPath(ctx.amDoc);
      }
      if (pklFile) {
        ctx.pklXml = await pklFile.text();
        ctx.pklDoc = parseXmlText(ctx.pklXml);
        ctx.pklIds = collectAssetIds(ctx.pklDoc);
        ctx.pklAssets = collectPklAssets(ctx.pklDoc);
      }
      if (cplFile) {
        ctx.cplXml = await cplFile.text();
        ctx.cplDoc = parseXmlText(ctx.cplXml);
        ctx.cplTrackMap = collectCplTrackFileMap(ctx.cplDoc);
        ctx.cplTrackHashMap = collectCplTrackHashMap(ctx.cplDoc);
      }

      return ctx;
    })().catch((e) => ({ ok: false, error: String((e && e.message) ? e.message : e) }));

    imfCtxCache[reqId] = p;
    return p;
  };

  const getMxfPartitionInfo = async (reqId, idxs, opts = {}) => {
    if (mxfPartitionCache[reqId]) return mxfPartitionCache[reqId];

    const p = (async () => {
      const ctx = await getImfCtx(reqId, idxs);
      if (!ctx?.ok) return { ok:false, error: ctx?.error || 'IMF context error' };

      const getPath = (f) => (f && (f.__pfxRelPath || f.webkitRelativePath || f.name)) || "";
      const lower = (s) => String(s || "").toLowerCase();

      const reqFiles = (ctx && ctx.files && ctx.files.reqFiles) ? ctx.files.reqFiles : (idxs || []).map(i => files[i]).filter(Boolean);
      const mxfFiles = reqFiles.filter(f => lower(getPath(f)).endsWith('.mxf'));

      const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : 200;
      const parsed = [];
      const errors = [];

      for (const f of mxfFiles.slice(0, maxFiles)) {
        const path = getPath(f);
        try {
          const info = await parseMxfHeaderPartitionPack(f, { searchLimit: 4096, readLen: 2048 });
          const row = { path, ...info };
          parsed.push(row);
          if (!info.ok) errors.push(row);
        } catch (e) {
          const err = String(e && e.message ? e.message : e);
          const row = { path, ok:false, error:'exception', detail: err };
          parsed.push(row);
          errors.push(row);
        }
      }

      // Build quick lookup by normalized path and by basename.
      const byPath = new Map();
      const byBase = new Map();
      for (const it of parsed) {
        const pth = normalizePath(it.path).toLowerCase();
        if (pth) byPath.set(pth, it);
        const base = pth.split('/').pop();
        if (base && !byBase.has(base)) byBase.set(base, it);
      }

      return {
        ok: true,
        totalMxfFiles: mxfFiles.length,
        checkedCount: parsed.length,
        parsed,
        errors,
        byPath,
        byBase
      };
    })();

    mxfPartitionCache[reqId] = p;
    return p;
  };

  const getMxfHeaderMetaInfo = async (reqId, idxs, opts = {}) => {
    if (mxfHeaderMetaCache[reqId]) return mxfHeaderMetaCache[reqId];

    const p = (async () => {
      const ctx = await getImfCtx(reqId, idxs);
      if (!ctx?.ok) return { ok:false, error: ctx?.error || 'IMF context error' };

      const getPath = (f) => (f && (f.__pfxRelPath || f.webkitRelativePath || f.name)) || "";
      const lower = (s) => String(s || "").toLowerCase();

      const reqFiles = (ctx && ctx.files && ctx.files.reqFiles) ? ctx.files.reqFiles : (idxs || []).map(i => files[i]).filter(Boolean);
      const mxfFiles = reqFiles.filter(f => lower(getPath(f)).endsWith('.mxf'));

      const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : 80;
      const maxHeaderBytes = Number.isFinite(opts.maxHeaderBytes) ? opts.maxHeaderBytes : (4 * 1024 * 1024);

      // Build normalized AssetMap id -> path (stripped urn:uuid)
      const amIdToPathNorm = new Map();
      for (const [id, pth] of (ctx.amIdToPath || new Map()).entries()) {
        const k = stripUrnUuid(id).toLowerCase();
        if (k && pth && !amIdToPathNorm.has(k)) amIdToPathNorm.set(k, pth);
      }

      // If we have CPL, only parse trackfiles referenced by CPL.
      const usageMap = ctx.cplDoc ? collectCplTrackFileUsages(ctx.cplDoc) : new Map();

      const targets = []; // { idKey, base, pathGuess }
      const seenBase = new Set();

      if (usageMap.size) {
        for (const [idKey, entry] of usageMap.entries()) {
          const tfid = entry?.trackFileId;
          const key = stripUrnUuid(tfid || idKey).toLowerCase();
          const amPath = amIdToPathNorm.get(key) || null;
          const annos = Array.from(entry?.annotations || []).filter(Boolean);
          const anno = annos.length ? String(annos[0]) : null;

          const guess = amPath || anno || null;
          const base = guess ? normalizePath(guess).split('/').pop() : null;
          if (!base) continue;
          const b = lower(base);
          if (seenBase.has(b)) continue;
          seenBase.add(b);
          targets.push({ idKey: key, base, pathGuess: guess, sequenceTypes: Array.from(entry?.sequenceTypes || []).slice(0, 8) });
        }
      } else {
        // Fall back to parsing MXFs in the selected folder.
        for (const f of mxfFiles.slice(0, maxFiles)) {
          const base = getPath(f).split('/').pop();
          const b = lower(base);
          if (seenBase.has(b)) continue;
          seenBase.add(b);
          targets.push({ idKey: null, base, pathGuess: getPath(f), sequenceTypes: [] });
        }
      }

      const fileMap = ctx.fileMap || new Map();
      const missingFiles = [];
      const parsed = [];
      const errors = [];

      for (const t of targets.slice(0, maxFiles)) {
        const baseLower = lower(t.base);
        let f = null;
        let usedPath = null;

        // Prefer AssetMap path for idKey.
        if (t.idKey) {
          const amPath = amIdToPathNorm.get(t.idKey);
          if (amPath) {
            const k = normalizePath(amPath).toLowerCase();
            if (fileMap.has(k)) { f = fileMap.get(k); usedPath = amPath; }
          }
        }

        // Fallback to guessing by path or basename.
        if (!f && t.pathGuess) {
          const k = normalizePath(t.pathGuess).toLowerCase();
          if (fileMap.has(k)) { f = fileMap.get(k); usedPath = t.pathGuess; }
        }
        if (!f) {
          // Try by basename (common case)
          for (const cand of mxfFiles) {
            const cb = lower(getPath(cand).split('/').pop());
            if (cb === baseLower) { f = cand; usedPath = getPath(cand); break; }
          }
        }

        if (!f) {
          missingFiles.push({ idKey: t.idKey, file: t.base, pathGuess: t.pathGuess, sequences: t.sequenceTypes });
          continue;
        }

        try {
          const meta = await parseMxfHeaderMetadataBasics(f, { maxHeaderBytes });
          const row = {
            idKey: t.idKey,
            file: t.base,
            path: usedPath || getPath(f),
            sequences: t.sequenceTypes,
            ok: !!meta?.ok,
            meta
          };
          parsed.push(row);
          if (!meta?.ok) errors.push({ file: t.base, path: row.path, error: meta?.error || 'parse_failed', detail: meta?.detail || null });
        } catch (e) {
          const err = String(e && e.message ? e.message : e);
          const row = { idKey: t.idKey, file: t.base, path: usedPath || getPath(f), sequences: t.sequenceTypes, ok:false, meta:{ ok:false, error:'exception', detail: err } };
          parsed.push(row);
          errors.push({ file: t.base, path: row.path, error:'exception', detail: err });
        }
      }

      const byBase = new Map();
      const byId = new Map();
      for (const row of parsed) {
        const b = lower(row.file);
        if (b && !byBase.has(b)) byBase.set(b, row);
        if (row.idKey && !byId.has(row.idKey)) byId.set(row.idKey, row);
      }

      return {
        ok: true,
        totalMxfFiles: mxfFiles.length,
        targetCount: targets.length,
        checkedCount: parsed.length,
        missingFiles,
        errors,
        parsed,
        byBase,
        byId
      };
    })();

    mxfHeaderMetaCache[reqId] = p;
    return p;
  };


  for (const req of reqList) {
    const reqId = req.id;
    const idxs = filesByReq[reqId] || [];
    findingsByReq[reqId] = [];

    // presence check
    if (idxs.length === 0) {
      // Use presence check only if it's part of checks for this requirement
      if (req.checks?.includes("FILES_PRESENT")) {
        const check = config.checks["FILES_PRESENT"];
        findingsByReq[reqId].push(makeFinding(reqId, "FILES_PRESENT", check));
      }
      continue;
    }

    for (const checkId of (req.checks || [])) {
      const check = config.checks[checkId];
      if (!check) continue;

      // Manual checklist
      if (check.module === "manual_check") {
        const finding = makeFinding(reqId, checkId, check, { checklist: check.checklist || [] });
        findingsByReq[reqId].push(finding);
        // keep previous state if any
        checklistState[finding.id] = checklistState[finding.id] || {};
        continue;
      }

      // Manual confirm
      if (check.module === "manual_confirm") {
        const finding = makeFinding(reqId, checkId, check);
        findingsByReq[reqId].push(finding);
        manualState[finding.id] = manualState[finding.id] || false;
        continue;
      }

      // Info only
      if (check.module === "info_only") {
        findingsByReq[reqId].push(makeFinding(reqId, checkId, check));
        continue;
      }

      // IMF parser (basic signature)
      if (check.module === "imf_parser") {
        const paths = idxs.map(i => (files[i].__pfxRelPath || files[i].webkitRelativePath || files[i].name).toLowerCase());
        const hasAssetmap = paths.some(p => /(^|\/)assetmap(\.xml)?$/.test(p));
        const hasPkl = paths.some(p => p.includes("pkl"));
        const cplCount = paths.filter(p => p.endsWith(".cpl.xml") || p.includes("cpl")).length;
        const mxfCount = paths.filter(p => p.endsWith(".mxf")).length;
        const ok = hasAssetmap && hasPkl && mxfCount > 0;
        if (!ok && checkId === "IMF_STRUCTURE_INTEGRITY") {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: { "imf.has_assetmap": hasAssetmap, "imf.has_pkl": hasPkl, "imf.cpl_count": cplCount, "imf.mxf_count": mxfCount }
          }));
        } else if (checkId === "IMF_LANGUAGE_CODE_MATCH") {
          // Try to extract language codes from CPL XML; fall back to manual confirm with evidence.
          const evidence = {};
          try {
            const ctx = await getImfCtx(reqId, idxs);
            if (ctx?.ok && ctx.cplDoc) {
              const langEls = Array.from(ctx.cplDoc.getElementsByTagNameNS('*', 'Language'));
              const langs = [...new Set(langEls.map(el => String(el.textContent || '').trim().toLowerCase()).filter(Boolean))];
              if (langs.length) evidence["imf.language_list"] = langs.join(", ");
            }
          } catch (_e) { /* best-effort */ }
          const pseudo = makeFinding(reqId, checkId, { ...check, module: "manual_confirm" }, { evidence });
          findingsByReq[reqId].push(pseudo);
          manualState[pseudo.id] = manualState[pseudo.id] || false;
        }
        continue;
      }


      // IMF: MXF signature sanity (fast check)
      if (check.module === "imf_mxf_signature") {
        const maxFiles = (check.params && Number.isFinite(check.params.max_files)) ? check.params.max_files : 200;
        const bad = [];
        let checked = 0;

        const getPath = (f) => (f && (f.__pfxRelPath || f.webkitRelativePath || f.name)) || "";
        const lower = (s) => String(s || "").toLowerCase();

        for (const i of idxs) {
          if (checked >= maxFiles) break;
          const f = files[i];
          if (!f) continue;
          const pth = lower(getPath(f));
          if (!pth.endsWith('.mxf')) continue;

          checked++;

          if (f.size < 64) {
            bad.push({ path: getPath(f), reason: "too_small", size: f.size });
            continue;
          }

          try {
            const dv = await readBytes(f, 0, 16);
            const b0 = dv.getUint8(0), b1 = dv.getUint8(1), b2 = dv.getUint8(2), b3 = dv.getUint8(3);
            const isUl = (b0 === 0x06 && b1 === 0x0e && b2 === 0x2b && b3 === 0x34);
            if (!isUl) {
              const hex = Array.from({ length: 16 }, (_, k) => dv.getUint8(k).toString(16).padStart(2, '0')).join('');
              bad.push({ path: getPath(f), reason: "bad_header_ul", header_hex: hex });
            }
          } catch (e) {
            bad.push({ path: getPath(f), reason: "read_error", error: String(e && e.message ? e.message : e) });
          }
        }

        if (bad.length) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.mxf_checked": checked,
              "imf.mxf_bad_files": bad.slice(0, 50)
            }
          }));
        }
        continue;
      }


      // IMF: MXF partition pack sanity (header partition pack parse)
      if (check.module === "imf_mxf_partition_pack") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }

        const maxFiles = (check.params && Number.isFinite(check.params.max_files)) ? check.params.max_files : 200;
        const info = await getMxfPartitionInfo(reqId, idxs, { maxFiles });
        if (!info?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: info?.error || "MXF parse error" } }));
          continue;
        }

        const severe = [];
        const summaries = [];
        for (const it of (info.parsed || [])) {
          if (!it) continue;
          summaries.push({
            path: it.path,
            ok: !!it.ok,
            packKind: it.packKind || null,
            offset: Number.isFinite(it.offset) ? it.offset : null,
            major: Number.isFinite(it.major) ? it.major : null,
            minor: Number.isFinite(it.minor) ? it.minor : null,
            kagSize: Number.isFinite(it.kagSize) ? it.kagSize : null,
            headerByteCount: it.headerByteCount ?? null,
            operationalPattern: it.operationalPattern || null,
            essenceContainers: Array.isArray(it.essenceContainers) ? it.essenceContainers.slice(0, 6) : []
          });

          if (!it.ok) {
            severe.push({ path: it.path, reason: it.error || 'parse_failed', detail: it.detail || null });
            continue;
          }
          if (it.packKind !== 'header') {
            severe.push({ path: it.path, reason: 'not_header_partition_pack', found: it.packKind });
          }
          const hbc = (typeof it.headerByteCount === 'number') ? it.headerByteCount : Number(String(it.headerByteCount || '0'));
          if (!Number.isFinite(hbc) || hbc <= 0) {
            severe.push({ path: it.path, reason: 'invalid_header_byte_count', value: it.headerByteCount });
          }
        }

        if (severe.length) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.mxf_total_files": info.totalMxfFiles,
              "imf.mxf_partition_checked": info.checkedCount,
              "imf.mxf_partition_errors": severe.slice(0, 50),
              "imf.mxf_partition_summary": summaries.slice(0, 30)
            }
          }));
        }
        continue;
      }


      // IMF: MXF essence container labels vs CPL sequence type (best-effort)
      if (check.module === "imf_mxf_essence_labels") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.cplDoc) continue; // let IMF_STRUCTURE_INTEGRITY handle missing XML

        const maxFiles = (check.params && Number.isFinite(check.params.max_files)) ? check.params.max_files : 200;
        const info = await getMxfPartitionInfo(reqId, idxs, { maxFiles });
        if (!info?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: info?.error || "MXF parse error" } }));
          continue;
        }

        // Known labels (best-effort): Generic Container, JPEG2000, IAB frame-wrapped container
        const UL_MXF_GC = '060e2b34.04010103.0d010301.027f0100';
        const UL_J2K = '060e2b34.04010107.0d010301.020b0100';
        const UL_IAB = '060e2b34.0401010d.0d010301.021d0102';

        const usageMap = collectCplTrackFileUsages(ctx.cplDoc);
        const mismatches = [];
        const missingFiles = [];
        const inspected = [];

        for (const entry of usageMap.values()) {
          if (!entry) continue;
          const seqTypes = Array.from(entry.sequenceTypes || []);
          const expectsJ2K = seqTypes.some(s => /ImageSequence/i.test(s));
          const expectsIAB = seqTypes.some(s => /IAB/i.test(s));
          if (!expectsJ2K && !expectsIAB) continue; // only validate known expectations

          const annos = Array.from(entry.annotations || []).filter(Boolean);
          const basename = (annos[0] || '').split('/').pop();
          if (!basename) continue;

          const parsed = info.byBase.get(normalizePath(basename).toLowerCase());
          if (!parsed) {
            missingFiles.push({ trackFileId: entry.trackFileId, file: basename, sequences: seqTypes.slice(0, 6) });
            continue;
          }
          if (!parsed.ok) continue; // partition pack sanity will flag

          const ecs = (parsed.essenceContainers || []).map(x => String(x || '').toLowerCase());
          const hasGc = ecs.includes(UL_MXF_GC);
          const hasJ2k = ecs.includes(UL_J2K);
          const hasIab = ecs.includes(UL_IAB);

          inspected.push({ file: basename, sequences: seqTypes.slice(0, 6), essenceContainers: (parsed.essenceContainers || []).slice(0, 6) });

          if (expectsJ2K && !hasJ2k) {
            mismatches.push({ file: basename, expected: 'JPEG2000', expectedUL: UL_J2K, found: (parsed.essenceContainers || []).slice(0, 6), sequences: seqTypes.slice(0, 6) });
          }
          if (expectsIAB && !hasIab) {
            mismatches.push({ file: basename, expected: 'IAB', expectedUL: UL_IAB, found: (parsed.essenceContainers || []).slice(0, 6), sequences: seqTypes.slice(0, 6) });
          }
          if ((expectsJ2K || expectsIAB) && !hasGc) {
            mismatches.push({ file: basename, expected: 'MXF Generic Container', expectedUL: UL_MXF_GC, found: (parsed.essenceContainers || []).slice(0, 6), sequences: seqTypes.slice(0, 6), hint: true });
          }
        }

        if (mismatches.length || missingFiles.length) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.cpl_path": ctx.paths?.cplPath,
              "imf.mxf_essence_label_checked": inspected.length,
              "imf.mxf_essence_label_missing_files": missingFiles.slice(0, 30),
              "imf.mxf_essence_label_mismatches": mismatches.slice(0, 50),
              "imf.mxf_essence_label_samples": inspected.slice(0, 20)
            }
          }));
        }
        continue;
      }


      // IMF: MXF header metadata readout — required descriptor fields (best-effort)
      if (check.module === "imf_mxf_descriptor_required") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.cplDoc) continue; // let IMF_STRUCTURE_INTEGRITY handle missing XML

        const info = await getMxfHeaderMetaInfo(reqId, idxs, { maxFiles: (check.params && check.params.max_files) || 80, maxHeaderBytes: (check.params && check.params.max_header_bytes) || (4 * 1024 * 1024) });
        if (!info?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: info?.error || "MXF metadata parse error" } }));
          continue;
        }

        const usageMap = collectCplTrackFileUsages(ctx.cplDoc);
        const missingFiles = [];
        const missingFields = [];
        const parseErrors = (info.errors || []).slice(0, 50);
        const truncated = [];

        const pickRow = (idKey, base) => {
          if (idKey && info.byId && info.byId.has(idKey)) return info.byId.get(idKey);
          const b = (base || '').toLowerCase();
          if (b && info.byBase && info.byBase.has(b)) return info.byBase.get(b);
          return null;
        };
        let checked = 0;
        for (const [idKey, entry] of usageMap.entries()) {
          const seqTypes = Array.from(entry.sequenceTypes || []);
          const isImage = seqTypes.some(s => /ImageSequence/i.test(s));
          const isIab = seqTypes.some(s => /IABSequence/i.test(s));
          const isAudio = !isIab && seqTypes.some(s => /AudioSequence|SoundSequence/i.test(s));
          if (!isImage && !isIab && !isAudio) continue;

          const annos = Array.from(entry.annotations || []).filter(Boolean);
          const base = annos.length ? String(annos[0]).split('/').pop() : null;
          const row = pickRow(idKey, base);
          if (!row) {
            missingFiles.push({ trackFileId: entry.trackFileId, file: base || null, sequences: seqTypes.slice(0, 8) });
            continue;
          }

          checked++;

          const meta = row.meta;
          if (!meta?.ok) continue; // parse error handled separately

          const v = meta.values || {};
          const miss = [];

          if (meta.headerTruncated) truncated.push({ file: row.file, bytesRead: meta.headerBytesRead, headerByteCount: meta.headerByteCount });

          if (isImage) {
            const w = v.storedWidth;
            const h = v.storedHeight;
            const okW = (typeof w === 'number' && w > 0) || (Array.isArray(w) && w.some(x => typeof x === 'number' && x > 0));
            const okH = (typeof h === 'number' && h > 0) || (Array.isArray(h) && h.some(x => typeof x === 'number' && x > 0));
            if (!okW) miss.push('StoredWidth');
            if (!okH) miss.push('StoredHeight');
          }

          if (isIab) {
            if (!v.audioSamplingRate) miss.push('AudioSamplingRate');
          } else if (isAudio) {
            if (!v.audioSamplingRate) miss.push('AudioSamplingRate');
            if (!v.channelCount) miss.push('ChannelCount');
          }

          if (miss.length) {
            missingFields.push({ file: row.file, sequences: seqTypes.slice(0, 8), missing: miss, values: {
              storedWidth: v.storedWidth ?? null,
              storedHeight: v.storedHeight ?? null,
              audioSamplingRate: v.audioSamplingRate ?? null,
              channelCount: v.channelCount ?? null,
              quantizationBits: v.quantizationBits ?? null,
              sampleRate: v.sampleRate ?? null,
            }});
          }
        }

        if (missingFiles.length || missingFields.length || parseErrors.length || truncated.length) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.mxf_descriptor_checked": checked,
              "imf.mxf_descriptor_missing_files": missingFiles.slice(0, 50),
              "imf.mxf_descriptor_missing_fields": missingFields.slice(0, 50),
              "imf.mxf_descriptor_parse_errors": parseErrors.slice(0, 50),
              "imf.mxf_descriptor_truncated_headers": truncated.slice(0, 30)
            }
          }));
        }
        continue;
      }


      // IMF: MXF picture resolution consistency across ImageSequence track files
      if (check.module === "imf_mxf_picture_resolution") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.cplDoc) continue;

        const info = await getMxfHeaderMetaInfo(reqId, idxs, { maxFiles: (check.params && check.params.max_files) || 80, maxHeaderBytes: (check.params && check.params.max_header_bytes) || (4 * 1024 * 1024) });
        if (!info?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: info?.error || "MXF metadata parse error" } }));
          continue;
        }

        const usageMap = collectCplTrackFileUsages(ctx.cplDoc);
        const resMap = new Map(); // res -> files
        const perFile = [];

        for (const [idKey, entry] of usageMap.entries()) {
          const seqTypes = Array.from(entry.sequenceTypes || []);
          const isImage = seqTypes.some(s => /ImageSequence/i.test(s));
          if (!isImage) continue;

          const row = (info.byId && info.byId.get(idKey)) || null;
          if (!row || !row.meta?.ok) continue;
          const v = row.meta.values || {};
          const w = v.storedWidth;
          const h = v.storedHeight;
          const wv = (typeof w === 'number') ? w : (Array.isArray(w) ? w.find(x => typeof x === 'number') : null);
          const hv = (typeof h === 'number') ? h : (Array.isArray(h) ? h.find(x => typeof x === 'number') : null);
          if (!wv || !hv) continue;
          const res = `${wv}x${hv}`;
          if (!resMap.has(res)) resMap.set(res, []);
          resMap.get(res).push(row.file);
          perFile.push({ file: row.file, resolution: res });
        }

        if (resMap.size > 1) {
          const variants = [];
          for (const [res, filesList] of resMap.entries()) {
            variants.push({ resolution: res, files: filesList.slice(0, 20), count: filesList.length });
          }
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.mxf_picture_resolution_variants": variants.slice(0, 10),
              "imf.mxf_picture_resolution_samples": perFile.slice(0, 30)
            }
          }));
        }
        continue;
      }


      // IMF: MXF audio sampling rate must be 48kHz (best-effort; GenericSoundEssenceDescriptor)
      if (check.module === "imf_mxf_audio_samplerate") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.cplDoc) continue;

        const info = await getMxfHeaderMetaInfo(reqId, idxs, { maxFiles: (check.params && check.params.max_files) || 80, maxHeaderBytes: (check.params && check.params.max_header_bytes) || (4 * 1024 * 1024) });
        if (!info?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: info?.error || "MXF metadata parse error" } }));
          continue;
        }

        const usageMap = collectCplTrackFileUsages(ctx.cplDoc);
        const mismatches = [];
        const missing = [];

        const parseRat = (s) => {
          const m = String(s||'').trim().match(/^(\d+)\/(\d+)$/);
          if (!m) return null;
          const num = Number(m[1]);
          const den = Number(m[2]);
          if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
          return { num, den };
        };

        for (const [idKey, entry] of usageMap.entries()) {
          const seqTypes = Array.from(entry.sequenceTypes || []);
          const isIab = seqTypes.some(s => /IABSequence/i.test(s));
          const isAudio = isIab || seqTypes.some(s => /AudioSequence|SoundSequence/i.test(s));
          if (!isAudio) continue;

          const row = (info.byId && info.byId.get(idKey)) || null;
          if (!row || !row.meta?.ok) continue;
          const v = row.meta.values || {};
          const r = v.audioSamplingRate;
          const rStr = Array.isArray(r) ? String(r[0] || '') : String(r || '');
          if (!rStr) {
            missing.push({ file: row.file, sequences: seqTypes.slice(0, 8) });
            continue;
          }

          const rat = parseRat(rStr);
          if (!rat) continue;
          const hz = rat.num / rat.den;
          if (Math.abs(hz - 48000) > 0.01) {
            mismatches.push({ file: row.file, audioSamplingRate: rStr, hz, sequences: seqTypes.slice(0, 8) });
          }
        }

        if (mismatches.length || missing.length) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.mxf_audio_sample_rate_mismatches": mismatches.slice(0, 50),
              "imf.mxf_audio_sample_rate_missing": missing.slice(0, 50)
            }
          }));
        }
        continue;
      }


      // IMF: MXF descriptor SampleRate must match CPL Resource EditRate (best-effort)
      if (check.module === "imf_mxf_samplerate_match_cpl") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.cplDoc) continue;

        const info = await getMxfHeaderMetaInfo(reqId, idxs, { maxFiles: (check.params && check.params.max_files) || 80, maxHeaderBytes: (check.params && check.params.max_header_bytes) || (4 * 1024 * 1024) });
        if (!info?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: info?.error || "MXF metadata parse error" } }));
          continue;
        }

        const expected = new Map();
        const resources = Array.from(ctx.cplDoc.getElementsByTagNameNS('*', 'Resource'));
        for (const r of resources) {
          const tfid = childText(r, 'TrackFileId');
          if (!tfid) continue;
          const key = stripUrnUuid(tfid).toLowerCase();
          const rateText = childText(r, 'EditRate');
          const rate = parseEditRateText(rateText);
          if (!rate) continue;
          const s = `${rate.num}/${rate.den}`;
          let set = expected.get(key);
          if (!set) { set = new Set(); expected.set(key, set); }
          set.add(s);
        }
        const parseRat = (s) => {
          const m = String(s||'').trim().match(/^(\d+)\/(\d+)$/);
          if (!m) return null;
          const n = Number(m[1]);
          const d = Number(m[2]);
          if (!Number.isFinite(n) || !Number.isFinite(d) || d === 0) return null;
          return { n, d };
        };

        const eqRat = (a, b) => {
          const ra = parseRat(a);
          const rb = parseRat(b);
          if (!ra || !rb) return false;
          try {
            return (BigInt(ra.n) * BigInt(rb.d)) === (BigInt(rb.n) * BigInt(ra.d));
          } catch (_) {
            return (ra.n / ra.d) === (rb.n / rb.d);
          }
        };

        const mismatches = [];
        const missing = [];

        for (const [idKey, row] of (info.byId || new Map()).entries()) {
          const expSet = expected.get(idKey);
          if (!expSet || expSet.size === 0) continue;

          if (!row?.meta?.ok) continue;
          const v = row.meta.values || {};
          const sr = v.sampleRate;
          const srList = Array.isArray(sr) ? sr : (sr ? [sr] : []);
          if (!srList.length) {
            missing.push({ file: row.file, expected: Array.from(expSet).slice(0, 6) });
            continue;
          }

          const exp = Array.from(expSet);
          let ok = false;
          for (const e of exp) {
            for (const f of srList) {
              if (eqRat(e, f)) { ok = true; break; }
            }
            if (ok) break;
          }

          if (!ok) {
            mismatches.push({ file: row.file, expected: exp.slice(0, 6), found: srList.slice(0, 6) });
          }
        }

        if (mismatches.length || missing.length) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.mxf_samplerate_mismatches": mismatches.slice(0, 50),
              "imf.mxf_samplerate_missing": missing.slice(0, 50)
            }
          }));
        }
        continue;
      }


      // IMF: ASSETMAP paths resolve (deep check)
      if (check.module === "imf_assetmap_paths") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.amDoc) continue; // let IMF_STRUCTURE_INTEGRITY handle missing XML

        const missing = [];
        const fileMap = ctx.fileMap || new Map();
        for (const ch of (ctx.amChunks || [])) {
          const p = normalizePath(ch.path).toLowerCase();
          if (!p) continue;
          if (!fileMap.has(p)) missing.push({ id: ch.id, path: ch.path });
        }

        if (missing.length) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.assetmap_path": ctx.paths?.assetmapPath,
              "imf.assetmap_total_assets": (ctx.amChunks || []).length,
              "imf.assetmap_missing_count": missing.length,
              "imf.assetmap_missing_paths": missing.slice(0, 50)
            }
          }));
        }
        continue;
      }

      // IMF: ASSETMAP length matches actual files (deep check)
      if (check.module === "imf_assetmap_length") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.amDoc) continue; // let IMF_STRUCTURE_INTEGRITY handle missing XML

        const fileMap = ctx.fileMap || new Map();
        const missingFiles = [];
        const lengthMismatches = [];

        for (const ch of (ctx.amChunks || [])) {
          const p = normalizePath(ch.path).toLowerCase();
          if (!p) continue;
          const f = fileMap.get(p);
          if (!f) {
            missingFiles.push({ id: ch.id, path: ch.path });
            continue;
          }
          if (Number.isFinite(ch.length) && ch.length != null) {
            if (f.size !== ch.length) {
              lengthMismatches.push({ id: ch.id, path: ch.path, expected: ch.length, actual: f.size });
            }
          }
        }

        if (missingFiles.length || lengthMismatches.length) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.assetmap_path": ctx.paths?.assetmapPath,
              "imf.assetmap_total_assets": (ctx.amChunks || []).length,
              "imf.assetmap_missing_files": missingFiles.slice(0, 50),
              "imf.assetmap_length_mismatches": lengthMismatches.slice(0, 50)
            }
          }));
        }
        continue;
      }


      // IMF: PKL size matches actual files (deep check)
      if (check.module === "imf_pkl_size") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.pklDoc) continue; // let IMF_STRUCTURE_INTEGRITY handle missing XML

        const idToPath = ctx.amIdToPath || new Map();
        const fileMap = ctx.fileMap || new Map();

        const missingInAssetmap = [];
        const missingFiles = [];
        const sizeMismatches = [];

        for (const a of (ctx.pklAssets || [])) {
          const candidates = [];
          const amPath = idToPath.get(a.id);
          if (amPath) candidates.push(amPath);
          if (a.originalFileName) candidates.push(a.originalFileName);
          if (a.annotationText) candidates.push(a.annotationText);

          if (!amPath) {
            missingInAssetmap.push({ id: a.id, name: a.originalFileName || a.annotationText || '' });
          }

          let foundFile = null;
          let used = null;
          for (const c of candidates) {
            const key = normalizePath(c).toLowerCase();
            if (fileMap.has(key)) { foundFile = fileMap.get(key); used = c; break; }
          }

          if (!foundFile) {
            const p = candidates[0] || '';
            missingFiles.push({ id: a.id, path: p });
            continue;
          }

          if (Number.isFinite(a.size) && a.size != null) {
            if (foundFile.size !== a.size) {
              sizeMismatches.push({
                id: a.id,
                path: used || amPath || a.originalFileName || a.annotationText || '',
                expected: a.size,
                actual: foundFile.size
              });
            }
          }
        }

        if (missingInAssetmap.length || missingFiles.length || sizeMismatches.length) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.assetmap_path": ctx.paths?.assetmapPath,
              "imf.pkl_path": ctx.paths?.pklPath,
              "imf.pkl_total_assets": (ctx.pklAssets || []).length,
              "imf.pkl_missing_in_assetmap": missingInAssetmap.slice(0, 50),
              "imf.pkl_missing_files": missingFiles.slice(0, 50),
              "imf.pkl_size_mismatches": sizeMismatches.slice(0, 50)
            }
          }));
        }
        continue;
      }

      

      // IMF: ASSETMAP ↔ PKL asset ID sync (manifest-only)
      if (check.module === "imf_assetmap_pkl_sync") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.amDoc || !ctx.pklDoc) continue; // let IMF_STRUCTURE_INTEGRITY handle missing XML

        const amIds = ctx.amIds || collectAssetIds(ctx.amDoc);
        const pklIds = ctx.pklIds || collectAssetIds(ctx.pklDoc);

        // Identify PKL asset(s) in ASSETMAP by path name, since PKL does not list itself.
        const assetmapPklIds = [];
        for (const ch of (ctx.amChunks || [])) {
          const p = String(ch.path || '').toLowerCase();
          if (p.includes('pkl') && p.endsWith('.xml') && ch.id) assetmapPklIds.push(ch.id);
        }
        const assetmapPklSet = new Set(assetmapPklIds.map(x => stripUrnUuid(x).toLowerCase()));

        const pklOnly = [];
        for (const id of pklIds) {
          const k = stripUrnUuid(id).toLowerCase();
          if (!amIds.has(id)) {
            // Also try matching by normalized form (case/prefix)
            const has = Array.from(amIds).some(amId => stripUrnUuid(amId).toLowerCase() == k);
            if (!has) pklOnly.push(id);
          }
        }

        const assetmapOnly = [];
        for (const id of amIds) {
          const k = stripUrnUuid(id).toLowerCase();
          if (assetmapPklSet.has(k)) continue; // allow PKL itself to exist only in ASSETMAP
          if (!pklIds.has(id)) {
            const has = Array.from(pklIds).some(pklId => stripUrnUuid(pklId).toLowerCase() == k);
            if (!has) assetmapOnly.push(id);
          }
        }

        if (pklOnly.length || assetmapOnly.length) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.assetmap_path": ctx.paths?.assetmapPath,
              "imf.pkl_path": ctx.paths?.pklPath,
              "imf.assetmap_asset_count": amIds.size,
              "imf.pkl_asset_count": pklIds.size,
              "imf.assetmap_pkl_asset_ids": assetmapPklIds.slice(0, 5),
              "imf.pkl_only_assets": pklOnly.slice(0, 50),
              "imf.assetmap_only_assets": assetmapOnly.slice(0, 50)
            }
          }));
        }
        continue;
      }

// IMF: PKL hash matches actual files (SHA-1) — incremental (deep check)
      if (check.module === "imf_pkl_hash") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.pklDoc) continue; // let IMF_STRUCTURE_INTEGRITY handle missing XML

        const idToPath = ctx.amIdToPath || new Map();
        const fileMap = ctx.fileMap || new Map();

        const missingFiles = [];
        const unsupported = [];
        const mismatches = [];
        let checked = 0;

        const chunkSize = (check.params && Number.isFinite(check.params.chunk_size)) ? check.params.chunk_size : (8 * 1024 * 1024);
        const maxAssets = (check.params && Number.isFinite(check.params.max_assets)) ? check.params.max_assets : 50;

        for (const a of (ctx.pklAssets || [])) {
          if (checked >= maxAssets) break;
          if (!a || !a.hash) continue;

          const algo = String(a.algorithm || "").toLowerCase();
          const isSha1 = algo.includes("sha1") || String(a.algorithm || "").includes("xmldsig#sha1");
          if (!isSha1) {
            unsupported.push({ id: a.id, algorithm: a.algorithm || null, name: a.originalFileName || a.annotationText || "" });
            continue;
          }

          const candidates = [];
          const amPath = idToPath.get(a.id);
          if (amPath) candidates.push(amPath);
          if (a.originalFileName) candidates.push(a.originalFileName);
          if (a.annotationText) candidates.push(a.annotationText);

          let foundFile = null;
          let used = null;
          for (const c of candidates) {
            const key = normalizePath(c).toLowerCase();
            if (fileMap.has(key)) { foundFile = fileMap.get(key); used = c; break; }
          }

          if (!foundFile) {
            missingFiles.push({ id: a.id, path: amPath || a.originalFileName || a.annotationText || "" });
            continue;
          }

          const expected = String(a.hash || "").trim();

          // If size is already wrong, skip expensive hashing.
          if (Number.isFinite(a.size) && a.size != null && foundFile.size !== a.size) {
            mismatches.push({
              id: a.id,
              path: used || amPath || a.originalFileName || a.annotationText || "",
              expected,
              actual: null,
              reason: "size_mismatch"
            });
            checked++;
            continue;
          }

          try {
            const actual = await sha1FileBase64(foundFile, { chunkSize, yieldEvery: 2 });
            if (actual !== expected) {
              mismatches.push({
                id: a.id,
                path: used || amPath || a.originalFileName || a.annotationText || "",
                expected,
                actual
              });
            }
          } catch (e) {
            mismatches.push({
              id: a.id,
              path: used || amPath || a.originalFileName || a.annotationText || "",
              expected,
              actual: null,
              reason: "hash_error",
              error: String(e && e.message ? e.message : e)
            });
          }

          checked++;
        }

        if (missingFiles.length || unsupported.length || mismatches.length) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.pkl_path": ctx.paths?.pklPath,
              "imf.assetmap_path": ctx.paths?.assetmapPath,
              "imf.pkl_hash_checked": checked,
              "imf.pkl_hash_missing_files": missingFiles.slice(0, 50),
              "imf.pkl_hash_unsupported": unsupported.slice(0, 50),
              "imf.pkl_hash_mismatches": mismatches.slice(0, 50)
            }
          }));
        }
        continue;
      }



      // IMF: CPL hash ↔ PKL hash consistency (manifest-only)
      if (check.module === "imf_cpl_pkl_hash") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.pklDoc || !ctx.cplDoc) continue; // let IMF_STRUCTURE_INTEGRITY handle missing XML

        const pklById = new Map();
        for (const a of (ctx.pklAssets || [])) {
          if (!a?.id) continue;
          const key = stripUrnUuid(a.id).toLowerCase();
          pklById.set(key, {
            id: a.id,
            hash: a.hash ? String(a.hash).trim() : null,
            algorithm: a.algorithm || null,
            name: a.originalFileName || a.annotationText || ""
          });
        }

        const trackHashMap = ctx.cplTrackHashMap || collectCplTrackHashMap(ctx.cplDoc);

        const internalConflicts = [];
        const mismatches = [];
        const missingInPkl = [];
        const missingPklHash = [];
        const missingCplHash = [];
        const unsupported = [];

        const isSha1 = (algo) => {
          const s = String(algo || "").toLowerCase();
          return !s || s.includes('sha1') || s.includes('xmldsig#sha1');
        };

        for (const [key, info] of trackHashMap.entries()) {
          const tfid = info.trackFileId;
          const annos = Array.from(info.annotations || []).slice(0, 6);

          const hashes = Array.from(info.hashes || []);
          if (hashes.length > 1) {
            internalConflicts.push({ trackFileId: tfid, names: annos, hashes: hashes.slice(0, 6) });
          }

          const algos = Array.from(info.algorithms || []);
          for (const a of algos) {
            if (!isSha1(a)) unsupported.push({ trackFileId: tfid, name: annos[0] || "", algorithm: a });
          }

          const pkl = pklById.get(key);
          if (!pkl) {
            missingInPkl.push({ trackFileId: tfid, name: annos[0] || "" });
            continue;
          }

          if (pkl.algorithm && !isSha1(pkl.algorithm)) {
            unsupported.push({ trackFileId: tfid, name: pkl.name || annos[0] || "", algorithm: pkl.algorithm });
          }

          const cplHash = hashes.length ? String(hashes[0]).trim() : null;
          const pklHash = pkl.hash ? String(pkl.hash).trim() : null;

          if (!cplHash && pklHash) {
            missingCplHash.push({ trackFileId: tfid, name: annos[0] || pkl.name || "" });
            continue;
          }
          if (cplHash && !pklHash) {
            missingPklHash.push({ trackFileId: tfid, name: annos[0] || pkl.name || "" });
            continue;
          }

          if (cplHash && pklHash && cplHash !== pklHash) {
            mismatches.push({
              trackFileId: tfid,
              name: annos[0] || pkl.name || "",
              cplHash,
              pklHash
            });
          }
        }

        // Do not fail solely because hashes are missing in CPL (some tools omit them)
        const shouldFail = internalConflicts.length || mismatches.length || missingInPkl.length || missingPklHash.length || unsupported.length;

        if (shouldFail) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.cpl_path": ctx.paths?.cplPath,
              "imf.pkl_path": ctx.paths?.pklPath,
              "imf.cpl_hash_trackfile_count": trackHashMap.size,
              "imf.cpl_hash_internal_conflicts": internalConflicts.slice(0, 50),
              "imf.cpl_pkl_hash_mismatches": mismatches.slice(0, 50),
              "imf.cpl_pkl_missing_in_pkl": missingInPkl.slice(0, 50),
              "imf.cpl_pkl_missing_pkl_hash": missingPklHash.slice(0, 50),
              "imf.cpl_pkl_unsupported_algorithms": unsupported.slice(0, 50),
              "imf.cpl_pkl_missing_cpl_hash": missingCplHash.slice(0, 50)
            }
          }));
        }
        continue;
      }

// IMF: UUID format / duplicate IDs
      if (check.module === "imf_uuid") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }

        const evidence = {};
        let bad = false;

        if (ctx.amDoc) {
          const ids = collectAssetIdList(ctx.amDoc);
          const invalid = ids.filter(id => !isUuid(id));
          const dups = findDuplicateIds(ids);
          if (invalid.length) { bad = true; evidence["imf.assetmap_invalid_ids"] = invalid.slice(0, 50); }
          if (dups.length) { bad = true; evidence["imf.assetmap_duplicate_ids"] = dups.slice(0, 50); }
        }

        if (ctx.pklDoc) {
          const ids = collectAssetIdList(ctx.pklDoc);
          const invalid = ids.filter(id => !isUuid(id));
          const dups = findDuplicateIds(ids);
          if (invalid.length) { bad = true; evidence["imf.pkl_invalid_ids"] = invalid.slice(0, 50); }
          if (dups.length) { bad = true; evidence["imf.pkl_duplicate_ids"] = dups.slice(0, 50); }
        }

        if (ctx.cplDoc) {
          const tfids = Array.from((ctx.cplTrackMap || new Map()).keys());
          const invalid = tfids.filter(id => !isUuid(id));
          if (invalid.length) { bad = true; evidence["imf.cpl_invalid_trackfile_ids"] = invalid.slice(0, 50); }
        }

        if (bad) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence }));
        }
        continue;
      }

      // IMF CPL ↔ PKL/ASSETMAP manifest consistency (deep check)
      if (check.module === "imf_cpl_manifest") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }

        // If required XMLs are missing, let IMF_STRUCTURE_INTEGRITY handle it.
        if (!ctx.amDoc || !ctx.pklDoc || !ctx.cplDoc) continue;

        try {
          const amIds = ctx.amIds || collectAssetIds(ctx.amDoc);
          const pklIds = ctx.pklIds || collectAssetIds(ctx.pklDoc);
          const cplMap = ctx.cplTrackMap || collectCplTrackFileMap(ctx.cplDoc);

          // Normalize to lowercase bare UUIDs to handle tools that write uppercase IDs
          const pklNorm = new Set(Array.from(pklIds).map(id => stripUrnUuid(id).toLowerCase()));
          const amNorm = new Set(Array.from(amIds).map(id => stripUrnUuid(id).toLowerCase()));

          const missing = [];
          for (const [tfid, name] of cplMap.entries()) {
            const k = stripUrnUuid(tfid).toLowerCase();
            const inPkl = pklNorm.has(k);
            const inAm = amNorm.has(k);
            if (!inPkl || !inAm) {
              missing.push({
                trackFileId: tfid,
                name,
                missingIn: { pkl: !inPkl, assetmap: !inAm }
              });
            }
          }

          if (missing.length) {
            findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
              evidence: {
                "imf.assetmap_path": ctx.paths?.assetmapPath,
                "imf.pkl_path": ctx.paths?.pklPath,
                "imf.cpl_path": ctx.paths?.cplPath,
                "imf.trackfile_total": cplMap.size,
                "imf.missing_count": missing.length,
                "imf.missing_assets": missing.slice(0, 50)
              }
            }));
          }
        } catch (e) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: { error: String(e && e.message ? e.message : e) }
          }));
        }
        continue;
      }

      // IMF: CPL timeline integrity (XML-only)
      if (check.module === "imf_cpl_timeline") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.cplDoc) continue; // let IMF_STRUCTURE_INTEGRITY handle missing XML

        const segments = Array.from(ctx.cplDoc.getElementsByTagNameNS('*', 'Segment'));
        const resourceIssues = [];
        const durationMismatches = [];
        let foundAnyMainImage = false;

        const seqDurationSeconds = (seq, segmentNumber) => {
          const resList = childByLocalName(seq, 'ResourceList');
          if (!resList) return { ok: false, reason: 'no_resourcelist' };

          const resources = elChildren(resList).filter(n => n.localName === 'Resource');
          if (!resources.length) return { ok: false, reason: 'no_resources' };

          let rateText = null;
          let rate = null;
          let units = 0;
          let editRateMismatch = false;

          for (const r of resources) {
            const rid = childText(r, 'Id') || '';
            const er = childText(r, 'EditRate');
            const entry = safeInt(childText(r, 'EntryPoint'), null);
            const dur = safeInt(childText(r, 'SourceDuration'), null);
            const intrinsic = safeInt(childText(r, 'IntrinsicDuration'), null);
            const repeat = Math.max(1, safeInt(childText(r, 'RepeatCount'), 1));

            if (!er) {
              resourceIssues.push({ type: 'missing_edit_rate', segment: segmentNumber, sequence: seq.localName, resourceId: rid });
            } else {
              const normalized = String(er).trim().replace(/\s+/g,' ');
              if (!rateText) {
                rateText = normalized;
                rate = parseEditRateText(normalized);
              } else if (normalized !== rateText) {
                editRateMismatch = true;
              }
            }

            if (dur == null || dur <= 0) {
              resourceIssues.push({ type: 'invalid_source_duration', segment: segmentNumber, sequence: seq.localName, resourceId: rid, value: dur });
            }
            if (entry != null && entry < 0) {
              resourceIssues.push({ type: 'invalid_entry_point', segment: segmentNumber, sequence: seq.localName, resourceId: rid, value: entry });
            }
            if (intrinsic != null && dur != null && entry != null) {
              if ((entry + dur) > intrinsic) {
                resourceIssues.push({
                  type: 'resource_out_of_bounds',
                  segment: segmentNumber,
                  sequence: seq.localName,
                  resourceId: rid,
                  entryPoint: entry,
                  sourceDuration: dur,
                  intrinsicDuration: intrinsic
                });
              }
            }

            if (dur != null && dur > 0) {
              units += dur * repeat;
            }
          }

          if (editRateMismatch) {
            resourceIssues.push({ type: 'sequence_edit_rate_mismatch', segment: segmentNumber, sequence: seq.localName });
            return { ok: false, reason: 'edit_rate_mismatch', units, rateText };
          }
          if (!rate) {
            return { ok: false, reason: 'no_edit_rate', units, rateText };
          }

          const seconds = rateUnitsToSeconds(units, rate);
          return { ok: true, seconds, rate, rateText, units };
        };

        for (let sidx = 0; sidx < segments.length; sidx++) {
          const seg = segments[sidx];
          const segNum = sidx + 1;
          const seqList = childByLocalName(seg, 'SequenceList');
          if (!seqList) {
            resourceIssues.push({ type: 'missing_sequence_list', segment: segNum });
            continue;
          }

          const seqs = elChildren(seqList);
          if (!seqs.length) {
            resourceIssues.push({ type: 'empty_sequence_list', segment: segNum });
            continue;
          }

          const seqInfo = [];
          for (const seq of seqs) {
            const info = seqDurationSeconds(seq, segNum);
            seqInfo.push({ type: seq.localName, ...info });
            if (!info.ok) {
              resourceIssues.push({ type: 'sequence_issue', segment: segNum, sequence: seq.localName, reason: info.reason, rateText: info.rateText || null });
            }
          }

          const img = seqInfo.find(x => x.type === 'MainImageSequence') || seqInfo.find(x => /ImageSequence$/i.test(String(x.type || '')));
          if (img && img.ok) {
            foundAnyMainImage = true;
            const tol = (img.rate && img.rate.num) ? (2 * (img.rate.den / img.rate.num)) : 0.1; // ~2 frames
            for (const si of seqInfo) {
              if (!si || !si.ok) continue;
              if (si.type === img.type) continue;
              const diff = Math.abs(si.seconds - img.seconds);
              if (diff > tol) {
                durationMismatches.push({
                  segment: segNum,
                  base: img.type,
                  baseSeconds: img.seconds,
                  compare: si.type,
                  compareSeconds: si.seconds,
                  diffSeconds: diff,
                  toleranceSeconds: tol
                });
              }
            }
          }
        }

        if (!segments.length) resourceIssues.push({ type: 'no_segments' });
        if (!foundAnyMainImage) resourceIssues.push({ type: 'missing_main_image_sequence' });

        if (resourceIssues.length || durationMismatches.length) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.cpl_path": ctx.paths?.cplPath,
              "imf.cpl_segment_count": segments.length,
              "imf.cpl_resource_issues": resourceIssues.slice(0, 80),
              "imf.cpl_duration_mismatches": durationMismatches.slice(0, 50)
            }
          }));
        }
        continue;
      }

      // IMF: CPL structural sanity (XML-only)
      if (check.module === "imf_cpl_structural") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.cplDoc) continue; // let IMF_STRUCTURE_INTEGRITY handle missing XML

        const root = ctx.cplDoc.documentElement;
        const issues = [];
        const badResources = [];
        const editRateMismatches = [];
        const dupTrackIds = [];
        const dupSeqIds = [];
        const missingTrackIdSeqs = [];

        if (!root || root.localName !== 'CompositionPlaylist') {
          issues.push({ type: 'bad_root', found: root ? root.localName : null });
        }

        const cplId = root ? (childText(root, 'Id') || null) : null;
        if (!cplId) issues.push({ type: 'missing_cpl_id' });
        else if (!isUuid(cplId)) issues.push({ type: 'invalid_cpl_id', id: cplId });

        const rootEditRate = root ? (childText(root, 'EditRate') || null) : null;
        const rootRateText = rootEditRate ? String(rootEditRate).trim().replace(/\s+/g, ' ') : null;
        const rootRate = parseEditRateText(rootRateText);
        if (!rootRate) issues.push({ type: 'invalid_cpl_edit_rate', value: rootEditRate });

        const segList = root ? childByLocalName(root, 'SegmentList') : null;
        const segments = segList ? elChildren(segList).filter(n => n.localName === 'Segment') : [];
        if (!segList) issues.push({ type: 'missing_segment_list' });
        if (!segments.length) issues.push({ type: 'no_segments' });

        let mainImageCount = 0;
        const trackIdSeen = new Set();
        const seqIdSeen = new Set();

        for (let sidx = 0; sidx < segments.length; sidx++) {
          const seg = segments[sidx];
          const segNum = sidx + 1;

          const segId = childText(seg, 'Id');
          if (!segId) issues.push({ type: 'missing_segment_id', segment: segNum });
          else if (!isUuid(segId)) issues.push({ type: 'invalid_segment_id', segment: segNum, id: segId });

          const seqList = childByLocalName(seg, 'SequenceList');
          if (!seqList) {
            issues.push({ type: 'missing_sequence_list', segment: segNum });
            continue;
          }

          const seqs = elChildren(seqList);
          if (!seqs.length) {
            issues.push({ type: 'empty_sequence_list', segment: segNum });
            continue;
          }

          for (const seq of seqs) {
            const seqType = seq.localName;
            if (seqType === 'MainImageSequence' || /ImageSequence$/i.test(seqType)) mainImageCount++;

            const seqId = childText(seq, 'Id');
            if (!seqId) issues.push({ type: 'missing_sequence_id', segment: segNum, sequence: seqType });
            else {
              if (!isUuid(seqId)) issues.push({ type: 'invalid_sequence_id', segment: segNum, sequence: seqType, id: seqId });
              const k = stripUrnUuid(seqId).toLowerCase();
              if (seqIdSeen.has(k)) dupSeqIds.push({ segment: segNum, sequence: seqType, id: seqId });
              else seqIdSeen.add(k);
            }

            const trackId = childText(seq, 'TrackId');
            if (!trackId) {
              missingTrackIdSeqs.push({ segment: segNum, sequence: seqType });
            } else {
              if (!isUuid(trackId)) issues.push({ type: 'invalid_track_id', segment: segNum, sequence: seqType, id: trackId });
              const k = stripUrnUuid(trackId).toLowerCase();
              if (trackIdSeen.has(k)) dupTrackIds.push({ segment: segNum, sequence: seqType, id: trackId });
              else trackIdSeen.add(k);
            }

            const resList = childByLocalName(seq, 'ResourceList');
            if (!resList) {
              issues.push({ type: 'missing_resourcelist', segment: segNum, sequence: seqType });
              continue;
            }
            const resources = elChildren(resList).filter(n => n.localName === 'Resource');
            if (!resources.length) {
              issues.push({ type: 'no_resources', segment: segNum, sequence: seqType });
              continue;
            }

            for (const r of resources) {
              const rid = childText(r, 'Id') || '';
              const tfid = childText(r, 'TrackFileId');
              const anno = childText(r, 'Annotation') || childText(r, 'AnnotationText') || '';
              const er = childText(r, 'EditRate');
              const dur = safeInt(childText(r, 'SourceDuration'), null);
              const entry = safeInt(childText(r, 'EntryPoint'), 0);
              const intrinsic = safeInt(childText(r, 'IntrinsicDuration'), null);

              if (!tfid) {
                badResources.push({ type: 'missing_trackfile_id', segment: segNum, sequence: seqType, resourceId: rid, name: anno });
              } else if (!isUuid(tfid)) {
                badResources.push({ type: 'invalid_trackfile_id', segment: segNum, sequence: seqType, resourceId: rid, name: anno, trackFileId: tfid });
              }

              if (!er) {
                badResources.push({ type: 'missing_edit_rate', segment: segNum, sequence: seqType, resourceId: rid, name: anno });
              } else if (rootRateText) {
                const nrm = String(er).trim().replace(/\s+/g, ' ');
                if (nrm !== rootRateText) {
                  editRateMismatches.push({ segment: segNum, sequence: seqType, resourceId: rid, name: anno, expected: rootRateText, actual: nrm });
                }
              }

              if (dur == null || dur <= 0) {
                badResources.push({ type: 'invalid_source_duration', segment: segNum, sequence: seqType, resourceId: rid, name: anno, value: dur });
              }

              if (entry != null && entry < 0) {
                badResources.push({ type: 'invalid_entry_point', segment: segNum, sequence: seqType, resourceId: rid, name: anno, value: entry });
              }

              if (intrinsic != null && intrinsic <= 0) {
                badResources.push({ type: 'invalid_intrinsic_duration', segment: segNum, sequence: seqType, resourceId: rid, name: anno, value: intrinsic });
              }
            }
          }
        }

        if (mainImageCount === 0) issues.push({ type: 'missing_main_image_sequence' });
        if (missingTrackIdSeqs.length) issues.push({ type: 'missing_track_id', sequences: missingTrackIdSeqs.slice(0, 20) });
        if (dupSeqIds.length) issues.push({ type: 'duplicate_sequence_ids', count: dupSeqIds.length });
        if (dupTrackIds.length) issues.push({ type: 'duplicate_track_ids', count: dupTrackIds.length });

        const shouldFail = issues.length || badResources.length || editRateMismatches.length || dupTrackIds.length || dupSeqIds.length;
        if (shouldFail) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "imf.cpl_path": ctx.paths?.cplPath,
              "imf.cpl_root_edit_rate": rootRateText,
              "imf.cpl_segment_count": segments.length,
              "imf.cpl_main_image_sequence_count": mainImageCount,
              "imf.cpl_structure_issues": issues.slice(0, 80),
              "imf.cpl_bad_resources": badResources.slice(0, 80),
              "imf.cpl_editrate_mismatches": editRateMismatches.slice(0, 50),
              "imf.cpl_duplicate_track_ids": dupTrackIds.slice(0, 50),
              "imf.cpl_duplicate_sequence_ids": dupSeqIds.slice(0, 50)
            }
          }));
        }
        continue;
      }

      // IMF: CPL composition timecode sanity (XML-only, warning)
      if (check.module === "imf_cpl_timecode") {
        const ctx = await getImfCtx(reqId, idxs);
        if (!ctx?.ok) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { error: ctx?.error || "IMF context error" } }));
          continue;
        }
        if (!ctx.cplDoc) continue; // let IMF_STRUCTURE_INTEGRITY handle missing XML

        const root = ctx.cplDoc.documentElement;
        const evidence = { "imf.cpl_path": ctx.paths?.cplPath };
        const issues = [];

        const rootEditRate = root ? (childText(root, 'EditRate') || null) : null;
        const rootRateText = rootEditRate ? String(rootEditRate).trim().replace(/\s+/g, ' ') : null;
        const rootRate = parseEditRateText(rootRateText);

        const tc = root ? Array.from(root.getElementsByTagNameNS('*', 'CompositionTimecode'))[0] : null;
        if (!tc) {
          issues.push({ type: 'missing_composition_timecode' });
        } else {
          const df = childText(tc, 'TimecodeDropFrame');
          const rateStr = childText(tc, 'TimecodeRate');
          const start = childText(tc, 'TimecodeStartAddress');

          evidence["imf.cpl_timecode_drop_frame"] = df;
          evidence["imf.cpl_timecode_rate"] = rateStr;
          evidence["imf.cpl_timecode_start"] = start;

          const rate = safeInt(rateStr, null);
          if (!rate || rate <= 0) issues.push({ type: 'invalid_timecode_rate', value: rateStr });

          const okStart = start ? /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/.test(String(start).trim()) : false;
          if (!okStart) issues.push({ type: 'invalid_timecode_start', value: start });

          if (rate && rootRate) {
            // Compare nominal timecode rate (e.g., 24000/1001 ≈ 24)
            const nominal = Math.round(rootRate.num / rootRate.den);
            if (nominal && nominal !== rate) {
              issues.push({ type: 'timecode_rate_mismatch', timecodeRate: rate, nominalEditRate: nominal, editRate: rootRateText });
            }
          }
        }

        if (issues.length) {
          evidence["imf.cpl_timecode_issues"] = issues;
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence }));
        }
        continue;
      }

      // Dolby Vision metadata sidecar (XML) parser — best-effort
      if (check.module === "dv_xml_parser") {
        const ctx = await getImfCtx(reqId, idxs);
        const getPath = (f) => (f && (f.__pfxRelPath || f.webkitRelativePath || f.name)) || "";
        const lower = (s) => String(s || "").toLowerCase();

        const reqFiles = (ctx && ctx.files && ctx.files.reqFiles) ? ctx.files.reqFiles : (idxs || []).map(i => files[i]).filter(Boolean);

        const candidates = reqFiles.filter(f => {
          const pth = lower(getPath(f));
          if (!pth.endsWith('.xml')) return false;
          if (/(^|\/)assetmap(\.xml)?$/.test(pth)) return false;
          if (pth.includes('pkl')) return false;
          if (pth.includes('cpl')) return false;
          return true;
        });

        let chosen = null;
        let chosenText = null;
        let chosenScore = -1;
        const scored = [];

        for (const f of candidates.slice(0, 60)) {
          const pth = lower(getPath(f));
          let score = 0;

          // filename hints
          if (pth.includes('dolby')) score += 6;
          if (pth.includes('vision')) score += 2;
          if (pth.includes('dovi')) score += 4;
          if (pth.includes('rpu')) score += 3;
          if (pth.includes('dv_') || pth.includes('_dv') || /(^|\/)dv[^a-z0-9]/.test(pth)) score += 3;

          let text = null;
          try { text = await f.text(); } catch(_e) { text = null; }

          if (text) {
            const tl = text.toLowerCase();
            if (tl.includes('cmversion')) score += 4;
            if (tl.includes('dolby')) score += 2;
            if (tl.includes('vision')) score += 1;
          }

          scored.push({ path: getPath(f), score });

          if (text && score > chosenScore) {
            chosen = f;
            chosenText = text;
            chosenScore = score;
          }
        }

        const evidence = {
          "dv.xml_present": !!chosen,
          "dv.xml_candidate_count": candidates.length,
          "dv.xml_candidates": scored.sort((a,b)=>b.score-a.score).slice(0, 10)
        };

        // If we can't locate a DV XML confidently, keep as manual confirm so user can override (embedded DV workflows exist).
        if (!chosen) {
          const finding = makeFinding(reqId, checkId, { ...check, module:"manual_confirm" }, { evidence });
          findingsByReq[reqId].push(finding);
          manualState[finding.id] = manualState[finding.id] || false;
          continue;
        }

        evidence["dv.xml_path"] = getPath(chosen);

        try {
          const doc = parseXmlText(chosenText);

          const pickText = (names) => {
            for (const nm of names) {
              const el = doc.getElementsByTagNameNS('*', nm)[0];
              if (el) {
                const v = String(el.textContent || '').trim();
                if (v) return v;
              }
            }
            return null;
          };

          const root = doc.documentElement;
          const pickAttr = (names) => {
            for (const nm of names) {
              const v = root && root.getAttribute ? root.getAttribute(nm) : null;
              if (v && String(v).trim()) return String(v).trim();
            }
            return null;
          };

          let cmv = pickText(['CMVersion','cmVersion','cmversion']) || pickAttr(['CMVersion','cmVersion','cmversion']);
          if (!cmv) {
            const m = String(chosenText).match(/CMVersion[^0-9]*([0-9]+(?:\.[0-9]+)*)/i);
            if (m) cmv = m[1];
          }

          let profile =
            pickText(['Profile','profile','DVProfile','DolbyVisionProfile']) ||
            pickAttr(['Profile','profile','DVProfile','DolbyVisionProfile']);

          if (!profile) {
            const m = String(chosenText).match(/profile[^0-9]*([0-9]+(?:\.[0-9]+)*)/i);
            if (m) profile = m[1];
          }

          evidence["dv.cmversion"] = cmv;
          evidence["dv.profile"] = profile;

          const issues = [];
          if (!cmv) issues.push({ type: "missing_cmversion" });
          else {
            const major = parseInt(String(cmv).split('.')[0], 10);
            if (!Number.isFinite(major) || major < 1 || major > 10) issues.push({ type: "abnormal_cmversion", value: cmv });
          }

          // If we detected a problem, show it as a resolvable manual warning.
          if (issues.length) {
            evidence["dv.issues"] = issues;
            const finding = makeFinding(reqId, checkId, { ...check, module:"manual_confirm" }, { evidence });
            findingsByReq[reqId].push(finding);
            manualState[finding.id] = manualState[finding.id] || false;
          }

        } catch (e) {
          evidence["dv.parse_error"] = String(e && e.message ? e.message : e);
          const finding = makeFinding(reqId, checkId, { ...check, module:"manual_confirm" }, { evidence });
          findingsByReq[reqId].push(finding);
          manualState[finding.id] = manualState[finding.id] || false;
        }

        continue;
      }

      // WAV parser
      if (check.module === "wav_parser") {
        const perFileChecks = ["AUDIO_PCM_WAV_ONLY","AUDIO_SAMPLE_RATE_48K","AUDIO_CHANNEL_LAYOUT_EXPECTED","AUDIO_BIT_DEPTH_24"];

        if (perFileChecks.includes(checkId)) {
          let anyFail = false;
          let evidence = {};
          for (const i of idxs) {
            const f = files[i];
            const ext = (f.name.split(".").pop() || "").toLowerCase();
            if (ext !== "wav" && ext !== "bwf") continue;
            const meta = await parseWav(f);
            if (!meta.ok) {
              anyFail = true;
              evidence = { file: f.name, reason: meta.reason };
              break;
            }
            if (checkId === "AUDIO_PCM_WAV_ONLY") {
              const isPcmish = (meta.audioFormat === 1 || meta.audioFormat === 3 || meta.audioFormat === 65534);
              if (!isPcmish) { anyFail = true; evidence = { file: f.name, audioFormat: meta.audioFormat }; break; }
            }
            if (checkId === "AUDIO_SAMPLE_RATE_48K") {
              if (meta.sampleRate !== 48000) { anyFail = true; evidence = { file: f.name, sampleRate: meta.sampleRate }; break; }
            }
            if (checkId === "AUDIO_CHANNEL_LAYOUT_EXPECTED") {
              const expected = req.expected?.layout;
              if (expected === "stereo" && meta.channels !== 2) { anyFail = true; evidence = { file: f.name, channels: meta.channels, expected }; break; }
              if (expected === "5.1" && meta.channels < 6) { anyFail = true; evidence = { file: f.name, channels: meta.channels, expected }; break; }
            }
            if (checkId === "AUDIO_BIT_DEPTH_24") {
              if (meta.bitsPerSample !== 24) { anyFail = true; evidence = { file: f.name, bitsPerSample: meta.bitsPerSample, expected: 24 }; break; }
            }
          }
          if (anyFail) findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence }));
        }

        // Duration consistency: parse all WAVs once, flag if spread > 0.5s
        if (checkId === "AUDIO_STEM_DURATION_CONSISTENCY") {
          const durations = [];
          for (const i of idxs) {
            const f = files[i];
            const ext = (f.name.split(".").pop() || "").toLowerCase();
            if (ext !== "wav" && ext !== "bwf") continue;
            try {
              const meta = await parseWav(f);
              if (meta.ok && meta.durationSec != null) durations.push({ file: f.name, sec: meta.durationSec });
            } catch (_e) { /* skip unreadable */ }
          }
          if (durations.length >= 2) {
            const secs = durations.map(d => d.sec);
            const drift = Math.max(...secs) - Math.min(...secs);
            if (drift > 0.5) {
              const summary = durations.map(d => `${d.file}: ${d.sec.toFixed(2)}s`).join(", ");
              findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
                evidence: { "audio.durations": summary, "audio.max_drift_sec": drift.toFixed(3) }
              }));
            }
          }
        }
        continue;
      }

      // Filesystem validators
      if (check.module === "filesystem") {
        const paths = idxs.map(i => (files[i].__pfxRelPath || files[i].webkitRelativePath || files[i].name));
        if (checkId === "ZERO_BYTE_FILES") {
          const zeroFiles = idxs
            .map(i => files[i])
            .filter(f => f && f.size === 0)
            .map(f => f.name)
            .slice(0, 10);
          if (zeroFiles.length) {
            findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
              evidence: { "fs.zero_byte_files": zeroFiles, "fs.zero_byte_count": zeroFiles.length }
            }));
          }
          continue;
        }
        if (checkId === "NAM_CHECKSUM_PRESENT") {
          const present = paths.some(p => p.toLowerCase().endsWith("checksum.txt"));
          if (!present) findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { "nam.checksum_present": present } }));
        }
        if (checkId === "NAM_PATH_LENGTH_LIMIT") {
          const maxLen = Math.max(...paths.map(p => p.length));
          if (maxLen > 256) findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { "nam.max_path_length": maxLen } }));
        }
        if (checkId === "NAM_ILLEGAL_CHARS") {
          const illegal = detectIllegalNames(paths);
          if (illegal.length) findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { "nam.illegal_names": illegal } }));
        }
        if (checkId === "NAM_NO_ZIP_WARNING" || checkId === "ZIP_NOT_RECOMMENDED") {
          const zipDetected = paths.some(p => p.toLowerCase().endsWith(".zip"));
          if (zipDetected) findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { "fs.zip_detected": true, "nam.zip_detected": true } }));
        }
        if (checkId === "FOLDER_STRUCTURE_SHOT_BASED") {
          const score = paths.reduce((s,p) => s + (/\b\d{3}[_-]\d{3}\b/.test(p) ? 1 : 0), 0);
          if (score === 0) findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { "fs.structure_score": score } }));
        }
        if (checkId === "AUDIO_DUPLICATE_FILENAMES") {
          const seen = new Map();
          for (const i of idxs) {
            const name = (files[i].name || "").toLowerCase();
            seen.set(name, (seen.get(name) || 0) + 1);
          }
          const dups = [...seen.entries()].filter(([,c]) => c > 1).map(([n,c]) => `${n} ×${c}`).slice(0, 10);
          if (dups.length) findingsByReq[reqId].push(makeFinding(reqId, checkId, check, { evidence: { "fs.duplicate_names": dups.join(", ") } }));
        }
        continue;
      }

      // ProRes profile probe: scan all MOV files and collect failures
      if (check.module === "prores_parser") {
        const REQUIRED_FOURCC = "apch"; // ProRes 422 HQ
        const badFiles = [];
        let checkedCount = 0;
        for (const i of idxs) {
          const f = files[i];
          const ext = (f.name.split(".").pop() || "").toLowerCase();
          if (ext !== "mov" && ext !== "mp4") continue;
          checkedCount++;
          try {
            const probe = await probeProResProfile(f);
            if (!probe.ok) {
              badFiles.push({ file: f.name, fourcc: "not detected", profile: "unknown — confirm manually" });
            } else if (probe.fourcc !== REQUIRED_FOURCC) {
              badFiles.push({ file: f.name, fourcc: probe.fourcc, profile: probe.name, required: "apch (ProRes 422 HQ)" });
            }
          } catch (_e) {
            badFiles.push({ file: f.name, error: "read failed" });
          }
        }
        if (badFiles.length) {
          findingsByReq[reqId].push(makeFinding(reqId, checkId, check, {
            evidence: {
              "prores.bad_count": badFiles.length,
              "prores.checked_count": checkedCount,
              "prores.bad_files": badFiles.slice(0, 20)
            }
          }));
        }
        continue;
      }

      // Presence module check (covered earlier)
      if (check.module === "presence") continue;

      // Unknown module — surface as FYI so the gap is visible
      if (!["manual_confirm","manual_check","info_only","imf_parser","imf_cpl_manifest",
            "imf_mxf_descriptor","imf_mxf_samplerate_match_cpl","dv_xml_parser","ep_consistency"].includes(check.module)) {
        findingsByReq[reqId].push(makeFinding(reqId, checkId, {
          severity: "FYI",
          title: `Check not automated: ${checkId}`,
          issue: { what: `Module "${check.module}" has no automated handler.`, why: "This check is defined but not implemented.", fix: "Review manually or implement the check handler." },
          module: "info_only"
        }, {}));
      }
    }
  }

  return { findingsByReq, manualState, checklistState };
}
