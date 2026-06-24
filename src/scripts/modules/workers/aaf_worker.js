// scripts/modules/workers/aaf_worker.js
// build 2026-04-05-v19 — fix: followThruInternal param; only resolve Precompute chains in CompMob pass
// Pure-JS OLE2 + AAF binary parser (no WASM required).
//
// OLE2 sector offset: sector N is at (N+1)*sectorSize
//   v3 = 512-byte sectors, v4 = 4096-byte sectors
//
// AAF property stream format (Avid/SMPTE):
//   byte  byteOrder  (0x4C = LE)
//   byte  version
//   uint16 entryCount
//   entries × { uint16 pid, uint16 type, uint16 length }   ← 6 bytes each
//   concatenated values
//
// AAF property IDs (confirmed from file scan):
//   0x0201 DataDefinition (21-byte AUID)
//   0x0202 ComponentLength (int64)
//   0x1001 SeqComponents strong-ref vector → "Components-1001{k}"
//   0x1101 SrcRefSourceID (32-byte MobID)
//   0x1102 SrcRefSlotID (uint32)
//   0x1201 SrcClipStart (int64)
//   0x4402 MobName (UTF-16 string)
//   0x4401 MobID (32 bytes)
//   0x4403 MobSlots strong-ref vector → "Slots-4403{k}"
//   0x4701 EssenceDescription (strong-ref → marks SourceMob)
//   0x4803 MobSlotSegment strong-ref → "Segment-4803"
//   0x4B01 EditRate (rational: 2×int32 = num/den)
//   0x4B02 Origin (int64 frames)
//
// AAF child storage naming convention:
//   Single strong ref:  "BaseName-PIDHEX"          e.g. "Segment-4803"
//   Strong ref vector:  "BaseName-PIDHEX{hexKey}"  e.g. "Slots-4403{0}"
//   Index stream:       "BaseName-PIDHEX index"

"use strict";

const OLE2_MAGIC = [0xD0,0xCF,0x11,0xE0,0xA1,0xB1,0x1A,0xE1];

const PID = {
  DataDef:         0x0201,  // 21-byte WeakRef AUID: picture vs sound vs timecode
  CompLength:      0x0202,
  SeqComponents:   0x1001,  // standard AAF: "Components-1001{key}"
  AvidSeqComps:    0x0c01,  // Avid AAF: "Slots-c01{key}" (same semantic, different PID)
  SrcRefSourceID:  0x1101,
  SrcRefSlotID:    0x1102,  // uint32 — target slot ID inside referenced mob
  SrcClipStart:    0x1201,
  TimecodeStart:   0x1501,  // int64 — Timecode segment start (SMPTE / DaVinci)
  MobName:         0x4402,
  MobID:           0x4401,
  MobSlots:        0x4403,
  MobSlotID:       0x4801,  // uint32 — slot ID within the mob
  EssenceDesc:     0x4701,
  MobSlotSegment:  0x4803,
  PhysTrackNum:    0x4804,  // uint32 — physical track number
  EditRate:        0x4B01,
  Origin:          0x4B02,
};

// Base names for child storage lookup
const BASE = {
  [PID.MobSlots]:       "Slots",
  [PID.SeqComponents]:  "Components",  // Components-1001{key}
  [PID.AvidSeqComps]:   "Slots",       // Slots-c01{key}  (Avid-specific SeqComponents)
  [PID.MobSlotSegment]: "Segment",
};

// ── OLE2 parser ───────────────────────────────────────────────────────────────
function parseOLE2(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);

  for (let i = 0; i < 8; i++) {
    if (u8[i] !== OLE2_MAGIC[i]) throw new Error("Not an OLE2/AAF file");
  }

  const secPow  = dv.getUint16(30, true);
  const secSize = 1 << secPow;
  const miniSz  = 1 << dv.getUint16(32, true);
  const miniCut = dv.getUint32(56, true);
  const mfSec   = dv.getUint32(60, true);
  const nMfSec  = dv.getUint32(64, true);
  const difSec  = dv.getUint32(68, true);
  const nDif    = dv.getUint32(72, true);

  // Sector N starts at (N+1)*secSize
  const sOff = (n) => (n + 1) * secSize;

  // ── FAT sector locations (DIFAT) ──────────────────────────────────────────
  const fatSecs = [];
  for (let i = 0; i < 109; i++) {
    const s = dv.getUint32(76 + i * 4, true);
    if (s >= 0xFFFFFFFC) break;
    fatSecs.push(s);
  }
  let ds = difSec;
  for (let d = 0; d < nDif && ds < 0xFFFFFFFC; d++) {
    const base = sOff(ds);
    for (let i = 0; i < secSize / 4 - 1; i++) {
      const s = dv.getUint32(base + i * 4, true);
      if (s >= 0xFFFFFFFC) break;
      fatSecs.push(s);
    }
    ds = dv.getUint32(base + secSize - 4, true);
  }

  // ── Build FAT ─────────────────────────────────────────────────────────────
  const fat = new Int32Array(fatSecs.length * (secSize / 4));
  let fi = 0;
  for (const fs of fatSecs) {
    const base = sOff(fs);
    for (let i = 0; i < secSize / 4; i++) fat[fi++] = dv.getInt32(base + i * 4, true);
  }

  function readChain(startSec, maxBytes) {
    const parts = [];
    let sec = startSec, total = 0;
    const lim = maxBytes !== undefined ? maxBytes + secSize : Infinity;
    while (sec >= 0 && total < lim) {
      const base = sOff(sec);
      const end  = Math.min(base + secSize, buf.byteLength);
      parts.push(u8.subarray(base, end));
      total += end - base;
      sec = fat[sec];
      if (sec == null || sec <= -2) break;
    }
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return maxBytes !== undefined ? out.subarray(0, Math.min(maxBytes, out.length)) : out;
  }

  // ── Parse directory entries ───────────────────────────────────────────────
  const dirSec  = dv.getUint32(48, true);
  const dirData = readChain(dirSec);
  const nDir    = Math.floor(dirData.length / 128);
  const ddv     = new DataView(dirData.buffer, dirData.byteOffset, dirData.byteLength);
  const entries = [];
  for (let i = 0; i < nDir; i++) {
    const b   = i * 128;
    const nb  = ddv.getUint16(b + 64, true);
    const nch = nb > 2 ? (nb - 2) / 2 : 0;
    let name = "";
    for (let j = 0; j < nch && j < 31; j++) name += String.fromCharCode(ddv.getUint16(b + j * 2, true));
    entries.push({
      id:    i,
      name,
      type:  dirData[b + 66],
      left:  ddv.getInt32(b + 68, true),
      right: ddv.getInt32(b + 72, true),
      child: ddv.getInt32(b + 76, true),
      start: ddv.getInt32(b + 116, true),
      size:  ddv.getUint32(b + 120, true),
    });
  }

  // ── Mini-stream ───────────────────────────────────────────────────────────
  const root = entries[0];
  const miniData = (root && root.start >= 0 && root.size > 0)
    ? readChain(root.start, root.size) : null;

  let miniFat = null;
  if (mfSec < 0xFFFFFFFC && nMfSec > 0) {
    const mfd = readChain(mfSec);
    miniFat = new Int32Array(mfd.buffer, mfd.byteOffset, Math.floor(mfd.byteLength / 4));
  }

  function readMiniChain(startSec, size) {
    if (!miniData || !miniFat) return new Uint8Array(0);
    const parts = [];
    let sec = startSec;
    while (sec >= 0 && sec < miniFat.length) {
      parts.push(miniData.subarray(sec * miniSz, (sec + 1) * miniSz));
      sec = miniFat[sec];
      if (sec <= -2) break;
    }
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let pos = 0;
    for (const p of parts) { out.set(p, pos); pos += p.length; }
    return size ? out.subarray(0, Math.min(size, out.length)) : out;
  }

  function streamData(id) {
    const e = entries[id];
    if (!e || e.type !== 2 || e.start < 0) return new Uint8Array(0);
    if (e.size > 0 && e.size < miniCut && miniData) return readMiniChain(e.start, e.size);
    return readChain(e.start, e.size > 0 ? e.size : undefined);
  }

  // OLE2 red-black sibling traversal
  function childIdsOf(parentId) {
    const e = entries[parentId];
    if (!e || e.child < 0 || e.child >= entries.length) return [];
    const result = [], stack = [e.child], seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (id < 0 || id >= entries.length || seen.has(id)) continue;
      seen.add(id); result.push(id);
      const ce = entries[id];
      if (ce.left  >= 0) stack.push(ce.left);
      if (ce.right >= 0) stack.push(ce.right);
    }
    return result;
  }

  return { entries, childIdsOf, streamData };
}

// ── AAF property stream parser ────────────────────────────────────────────────
// Format: byte byteOrder + byte version + uint16 count
//         + count × { uint16 pid, uint16 type, uint16 length }  (6 bytes/entry)
//         + concatenated values
function parseProps(data) {
  if (!data || data.length < 4) return {};
  const dv    = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // byte[0]=byteOrder, byte[1]=version, uint16 LE count at offset 2
  const count = dv.getUint16(2, true);
  if (!count || count > 10000) return {};
  const hdrEnd = 4 + count * 6;
  if (hdrEnd > data.length) return {};
  const props = {};
  let off = hdrEnd;
  for (let i = 0; i < count; i++) {
    const base = 4 + i * 6;
    const pid  = dv.getUint16(base,     true);
    const type = dv.getUint16(base + 2, true);
    const len  = dv.getUint16(base + 4, true);
    if (off + len > data.length) break;
    props[pid] = { type, value: data.subarray(off, off + len) };
    off += len;
  }
  return props;
}

// ── Property value readers ────────────────────────────────────────────────────
function readUTF16(data) {
  if (!data || data.length < 2) return "";
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let s = "";
  for (let i = 0; i < data.length / 2; i++) {
    const c = dv.getUint16(i * 2, true);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}
function readRational(data) {
  if (!data || data.length < 8) return { n: 24, d: 1 };
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return { n: dv.getInt32(0, true), d: dv.getInt32(4, true) };
}
function readInt64(data) {
  if (!data || data.length < 4) return 0;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  // Some implementations (DaVinci Resolve) store ComponentLength as Int32 (4 bytes).
  // Fall back gracefully so we don't return 0 and skip all CompMob clips.
  if (data.length < 8) return dv.getInt32(0, true);
  const lo = dv.getUint32(0, true);
  const hi = dv.getInt32(4, true);
  return hi * 0x100000000 + lo;
}
function readMobID(data) {
  if (!data || data.length < 32) return null;
  // Return as hex string for Map key
  let s = "";
  for (let i = 0; i < 32; i++) s += data[i].toString(16).padStart(2,'0');
  return s;
}
function toTC(frames, fps) {
  const f = Math.max(0, Math.round(isFinite(frames) ? frames : 0));
  const r = Math.max(1, Math.round(isFinite(fps) ? fps : 24));
  return `${p2(Math.floor(f/r/3600))}:${p2(Math.floor(f/r/60)%60)}:${p2(Math.floor(f/r)%60)}:${p2(f%r)}`;
}
function p2(n) { return String(n).padStart(2,'0'); }
function tcToFrames(tc, fps) {
  const m = String(tc || '').match(/^(\d{1,4}):(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const r = Math.max(1, Math.round(isFinite(fps) ? fps : 24));
  return (+m[1]) * 3600 * r + (+m[2]) * 60 * r + (+m[3]) * r + (+m[4]);
}
function readUint32(data) {
  if (!data || data.length < 4) return 0;
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true);
}
// Strip Avid version suffixes like ".new.01", ".new.2" appended to clip names
function stripAvidSuffix(name) {
  return String(name || '').replace(/\.new\.\d+$/i, '');
}

// DataDefinition AUID check — SMPTE 377M
//
// In Avid AAF files DataDef (PID 0x0201) is stored as a 21-byte WeakReference:
//   byte[0..4]  = 03 00 01 1b 10   (reference header)
//   byte[5..20] = 16-byte packed-GUID AUID
//
// Relevant packed-GUID AUIDs (confirmed from binary scan of TOASTER__DI_20250408.aaf):
//   Picture  {01030202-0100-0000-060E-2B3404010101}: 02 02 03 01  00 01  00 00  06 0E 2B 34 …
//   Sound    {01030202-0200-0000-060E-2B3404010101}: 02 02 03 01  00 02  00 00  06 0E 2B 34 …
//   Timecode {01030201-0100-0000-060E-2B3404010101}: 01 02 03 01  00 01  00 00  06 0E 2B 34 …
//
// Also handles legacy 16-byte raw UL format (06 0E 2B 34 … byte[12] = kind).
// Returns 'picture' | 'sound' | 'timecode' | 'unknown'
function readDataDefKind(data) {
  if (!data || data.length < 16) return 'unknown';

  // Strip the 5-byte WeakRef header if present (21-byte Avid format)
  const d = (data.length >= 21 && data[0] === 0x03 && data[1] === 0x00)
    ? data.subarray(5) : data;

  // Format A: Raw Universal Label — 06 0E 2B 34 … byte[12] = kind
  if (d[0] === 0x06 && d[1] === 0x0E && d[2] === 0x2B && d[3] === 0x34) {
    if (d[12] === 0x01) return 'picture';
    if (d[12] === 0x02) return 'sound';
    return 'timecode';
  }

  // Format B: Packed-GUID AUID — SMPTE DataDef class AUIDs
  // All share d[2]=0x03, d[3]=0x01, d[8..11]=06 0E 2B 34
  if (d[2] === 0x03 && d[3] === 0x01 &&
      d[8] === 0x06 && d[9] === 0x0E && d[10] === 0x2B && d[11] === 0x34) {
    if (d[0] === 0x02 && d[1] === 0x02) {
      // DataDef_Picture (d[5]=0x01), DataDef_Sound (d[5]=0x02), other (timecode/data)
      if (d[5] === 0x01) return 'picture';
      if (d[5] === 0x02) return 'sound';
      return 'timecode';
    }
    return 'timecode'; // DataDef_Timecode or Descriptive
  }

  return 'unknown';
}

// Check if a MobSlot carries picture data.
// DataDef is on the SEGMENT (not the slot itself) in Avid AAF.
// Returns false for sound/timecode slots; true only for confirmed picture.
// Unknown DataDef → false (safe default: exclude rather than misclassify audio as video).
function slotIsPicture(slot, objects, ole2) {
  function checkObj(obj) {
    if (!obj || !obj.props[PID.DataDef]) return null;
    const kind = readDataDefKind(obj.props[PID.DataDef].value);
    if (kind === 'unknown') return null;
    return kind === 'picture';
  }

  // 1. Slot itself (rare in Avid — DataDef usually lives on the segment)
  const r1 = checkObj(slot);
  if (r1 !== null) return r1;

  // 2. Segment (Sequence / Filler / SourceClip) — primary location in Avid AAF
  const seg = getRef(slot, PID.MobSlotSegment, objects);
  const r2 = checkObj(seg);
  if (r2 !== null) return r2;

  // 3. First few components of a Sequence
  if (seg && hasComponents(seg)) {
    const comps = getComponents(seg, objects, ole2);
    for (const comp of comps.slice(0, 4)) {
      const r = checkObj(comp);
      if (r !== null) return r;
    }
  }

  // No DataDef found — exclude to avoid misclassifying audio as video
  return false;
}

// Permissive version for the CompMob pass: exclude ONLY confirmed-sound slots.
// Avid top-level CompMob slots often store DataDef in non-standard formats so
// picture slots may read as "timecode" or "unknown". Only audio is safe to exclude.
function isSlotExplicitlySound(slot, objects, ole2) {
  function checkSound(obj) {
    if (!obj || !obj.props[PID.DataDef]) return false;
    return readDataDefKind(obj.props[PID.DataDef].value) === 'sound';
  }
  if (checkSound(slot)) return true;
  const seg = getRef(slot, PID.MobSlotSegment, objects);
  if (checkSound(seg)) return true;
  if (seg && hasComponents(seg)) {
    for (const comp of getComponents(seg, objects, ole2).slice(0, 4)) {
      if (checkSound(comp)) return true;
    }
  }
  return false;
}

// ── Build AAF object tree ─────────────────────────────────────────────────────
// Only visits Content storages (skips MetaDictionary to save time/memory)
function buildObjectTree(ole2) {
  const { entries, childIdsOf, streamData } = ole2;
  const objects = new Map(); // id → { id, name, props, byName }

  function visit(id) {
    const e = entries[id];
    if (!e || e.type !== 1) return;
    if (objects.has(id)) return;

    const kids   = childIdsOf(id);
    const byName = new Map();
    for (const cid of kids) {
      const ce = entries[cid];
      if (ce) byName.set(ce.name, cid);
    }
    let props = {};
    const pId = byName.get('properties');
    if (pId != null) {
      const pe = entries[pId];
      if (pe && pe.type === 2) props = parseProps(streamData(pId));
    }
    objects.set(id, { id, name: e.name, props, byName });

    for (const cid of kids) {
      const ce = entries[cid];
      if (ce && ce.type === 1) visit(cid);
    }
  }

  // Root → Header-2 → Content-3b03 → Mobs
  // Also visit root itself for the property stream
  const rootKids = childIdsOf(0);
  for (const cid of rootKids) {
    const ce = entries[cid];
    if (!ce || ce.type !== 1) continue;
    // Only visit Header subtree (skip MetaDictionary for performance)
    if (ce.name === 'Header-2') {
      visit(cid);
      break;
    }
  }
  // If no Header-2 found, fall back to visiting all top-level storages
  if (objects.size === 0) {
    for (const cid of rootKids) {
      const ce = entries[cid];
      if (ce && ce.type === 1) visit(cid);
    }
  }

  return objects;
}

// ── Structural type detection (no ObjClass property in Avid AAF) ─────────────

// SourceMob: has "EssenceDescription-" child storage
function isSourceMob(obj) {
  for (const name of obj.byName.keys()) {
    if (name.startsWith('EssenceDescription-')) return true;
  }
  return false;
}

// Sequence: Segment has "Components-1001{key}" (standard) or "Slots-c01{key}" (Avid) children
function hasComponents(obj) {
  for (const name of obj.byName.keys()) {
    if (name.includes('{')) {
      if (name.startsWith('Components-')) return true;
      // Avid stores SeqComponents at PID 0x0c01 → "Slots-c01{key}"
      // Exclude "Slots-4403" which are MobSlots, not sequence components
      if (name.startsWith('Slots-') && !name.startsWith('Slots-4403')) return true;
    }
  }
  return false;
}


// ── Strong reference helpers ──────────────────────────────────────────────────

// Return sequence components — standard AAF uses PID 0x1001 ("Components-1001{key}")
// Avid AAF uses PID 0x0c01 ("Slots-c01{key}") for the same property.
function getComponents(obj, objects, ole2) {
  const c = getVec(obj, PID.SeqComponents, objects, ole2);
  return c.length > 0 ? c : getVec(obj, PID.AvidSeqComps, objects, ole2);
}

function getRef(obj, pid, objects) {
  const base = BASE[pid];
  if (!base) return null;
  const prefix = base + "-";
  for (const [name, cid] of obj.byName) {
    if (name.startsWith(prefix) && !name.includes('{') && !name.endsWith(' index')) {
      return objects.get(cid) ?? null;
    }
  }
  return null;
}

function getVec(obj, pid, objects, ole2) {
  const base = BASE[pid];
  if (!base) return [];
  const prefix = base + "-";

  // Find full property prefix (e.g. "Slots-4403")
  let fullPrefix = null;
  for (const name of obj.byName.keys()) {
    if (name.startsWith(prefix) && (name.endsWith(' index') || name.includes('{'))) {
      fullPrefix = name.endsWith(' index')
        ? name.slice(0, -' index'.length)
        : name.slice(0, name.lastIndexOf('{'));
      break;
    }
  }
  if (!fullPrefix) return [];

  // Try ordered index stream first
  // Index stream format in this file seems non-standard; fallback usually works
  const indexId = obj.byName.get(fullPrefix + ' index');
  if (indexId != null) {
    const idxData = ole2.streamData(indexId);
    if (idxData.length >= 8) {
      const idxDV  = new DataView(idxData.buffer, idxData.byteOffset, idxData.byteLength);
      const count  = idxDV.getUint32(0, true);
      if (count > 0 && count < 100000) {
        const result = [];
        // Try standard 20-byte entries: localKey(4) + key[16]
        for (let i = 0; i < count; i++) {
          const off = 8 + i * 20;
          if (off + 4 > idxData.length) break;
          const lk  = idxDV.getUint32(off, true);
          const key = lk.toString(16);
          const cid = obj.byName.get(fullPrefix + '{' + key + '}');
          if (cid != null) {
            const child = objects.get(cid);
            if (child) result.push(child);
          }
        }
        if (result.length > 0) return result;
      }
    }
  }

  // Fallback: collect all "{key}" children, sort numerically by key
  const fb = [];
  for (const [name, cid] of obj.byName) {
    if (name.startsWith(fullPrefix + '{') && name.endsWith('}')) {
      const child = objects.get(cid);
      if (child) {
        const key = name.slice(fullPrefix.length + 1, -1);
        fb.push({ child, key: parseInt(key, 16) });
      }
    }
  }
  fb.sort((a, b) => a.key - b.key);
  return fb.map(f => f.child);
}

// ── Source timecode resolution ────────────────────────────────────────────────
// Follows SrcRefSourceID chain (up to maxDepth hops) to find the
// SourceMob that has a real tape/media timecode.
// Returns { srcStart, fps } or null.
function resolveSource(srcMobHex, clipOffset, objects, byMobID, ole2, maxDepth) {
  if (!srcMobHex || maxDepth <= 0) return null;

  const mob = byMobID.get(srcMobHex);
  if (!mob) return null;

  // SourceMob: has EssenceDescription child
  if (isSourceMob(mob)) {
    // Capture SourceMob name — this is the physical tape/reel/OCF identifier
    const srcMobName = mob.props[PID.MobName] ? readUTF16(mob.props[PID.MobName].value) : '';
    for (const slot of getVec(mob, PID.MobSlots, objects, ole2)) {
      const er  = slot.props[PID.EditRate] ? readRational(slot.props[PID.EditRate].value) : { n:24, d:1 };
      const fps = er.d > 0 ? er.n / er.d : 24;
      const seg = getRef(slot, PID.MobSlotSegment, objects);
      if (!seg) continue;
      // SMPTE/DaVinci Timecode segment (PID 0x1501 = Timecode_Start)
      if (seg.props[PID.TimecodeStart]) {
        return { srcStart: readInt64(seg.props[PID.TimecodeStart].value) + clipOffset, fps, sourceReelName: srcMobName };
      }
      // Avid-style: SourceClip with SrcClipStart (PID 0x1201)
      if (seg.props[PID.SrcClipStart]) {
        return { srcStart: readInt64(seg.props[PID.SrcClipStart].value) + clipOffset, fps, sourceReelName: srcMobName };
      }
      // Sequence wrapping Timecode/SourceClip
      if (hasComponents(seg)) {
        for (const comp of getComponents(seg, objects, ole2)) {
          if (comp.props[PID.TimecodeStart]) {
            return { srcStart: readInt64(comp.props[PID.TimecodeStart].value) + clipOffset, fps, sourceReelName: srcMobName };
          }
          if (comp.props[PID.SrcClipStart]) {
            return { srcStart: readInt64(comp.props[PID.SrcClipStart].value) + clipOffset, fps, sourceReelName: srcMobName };
          }
        }
      }
    }
    return null;
  }

  // Non-SourceMob (MasterMob): follow its slot's SourceClip one level deeper.
  // Capture the current mob's name (= camera filename) so walkSeg can use it
  // as a fallback when the direct byMobID lookup from the CompMob level fails.
  const curName = mob.props[PID.MobName] ? readUTF16(mob.props[PID.MobName].value) : '';

  // Try all slots — skip null refs and failed chains rather than returning null early.
  for (const slot of getVec(mob, PID.MobSlots, objects, ole2)) {
    const seg = getRef(slot, PID.MobSlotSegment, objects);
    if (!seg) continue;
    const sProps = seg.props;

    // Direct SourceClip
    if (sProps[PID.SrcRefSourceID]) {
      const nextMobHex = readMobID(sProps[PID.SrcRefSourceID].value);
      if (!nextMobHex || /^0+$/.test(nextMobHex)) continue; // null ref
      const nextOffset = sProps[PID.SrcClipStart] ? readInt64(sProps[PID.SrcClipStart].value) : 0;
      const r = resolveSource(nextMobHex, clipOffset + nextOffset, objects, byMobID, ole2, maxDepth - 1);
      if (r) {
        if (!r.mobName && curName) r.mobName = curName; // propagate MasterMob name upward
        return r;
      }
      continue;
    }

    // Sequence wrapping SourceClips
    if (hasComponents(seg)) {
      for (const comp of getComponents(seg, objects, ole2)) {
        const cProps = comp.props;
        if (!cProps[PID.SrcRefSourceID]) continue;
        const nextMobHex = readMobID(cProps[PID.SrcRefSourceID].value);
        if (!nextMobHex || /^0+$/.test(nextMobHex)) continue;
        const nextOffset = cProps[PID.SrcClipStart] ? readInt64(cProps[PID.SrcClipStart].value) : 0;
        const r = resolveSource(nextMobHex, clipOffset + nextOffset, objects, byMobID, ole2, maxDepth - 1);
        if (r) {
          if (!r.mobName && curName) r.mobName = curName;
          return r;
        }
      }
    }
  }
  return null;
}

// Avid-internal mob name patterns (module-scope so walkSeg can also use it).
// Precompute/intermediate mobs appear in DI workflows and should be skipped.
const AVID_INTERNAL = /^(?:[a-z]{2,4}[A-Z]{2,}|Precompute\s)/;

// ── Timeline event extraction ─────────────────────────────────────────────────
function extractEvents(objects, ole2) {
  // Build MobID → object map
  const byMobID = new Map();
  for (const [, obj] of objects) {
    const p = obj.props[PID.MobID];
    if (p) {
      const hex = readMobID(p.value);
      if (hex) byMobID.set(hex, obj);
    }
  }

  // ── Separate CompMobs from MasterMobs ────────────────────────────────────
  // A mob that is referenced by another mob's SourceClip is a MasterMob (or sub-mob).
  // The top-level CompositionMob is never referenced — that is the true timeline.
  // We prefer the CompMob because it carries real record TC and track assignments.
  // If CompMob produces no events (e.g. parse failure), fall back to MasterMobs.
  const referencedMobIDs = new Set();
  for (const [, obj] of objects) {
    if (obj.props[PID.SrcRefSourceID]) {
      const hex = readMobID(obj.props[PID.SrcRefSourceID].value);
      if (hex && !/^0+$/.test(hex)) referencedMobIDs.add(hex);
    }
  }
  // The first pass already catches all direct SrcRefSourceID on both parent
  // and leaf objects (since buildObjectTree visits everything recursively).
  // No second pass needed.

  const topLevelCompMobs = [];   // true CompositionMobs (not referenced by anyone)
  const masterMobs       = [];   // MasterMobs and sub-sequences (referenced)

  for (const [, obj] of objects) {
    if (isSourceMob(obj)) continue;
    const mobIdProp = obj.props[PID.MobID];
    const hex = mobIdProp ? readMobID(mobIdProp.value) : null;
    // Only real mobs have a MobID — skip sequences, source clips, filler, etc.
    if (!hex) continue;
    if (referencedMobIDs.has(hex)) {
      masterMobs.push(obj);
    } else {
      topLevelCompMobs.push(obj);
    }
  }


  // Sort CompMobs: the true timeline mob (most non-sound VID-slot components) first.
  // This ensures we pick "1.Exported.01" ahead of any spurious unreferenced mobs.
  topLevelCompMobs.sort((a, b) => {
    const countCmps = (mob) => {
      let c = 0;
      for (const sl of getVec(mob, PID.MobSlots, objects, ole2)) {
        if (isSlotExplicitlySound(sl, objects, ole2)) continue;
        const sg = getRef(sl, PID.MobSlotSegment, objects);
        if (sg && hasComponents(sg)) c += getComponents(sg, objects, ole2).length;
      }
      return c;
    };
    return countCmps(b) - countCmps(a);
  });

  // Priority: unreferenced CompMobs (with permissive slot filter) → MasterMob fallback
  const mobSets = [topLevelCompMobs, masterMobs];

  const events = [];
  let gFps = 24;
  let _fromCompMob = false;  // true when events came from a real CompMob sequence
  let _usedMasterFallback = false; // true when we had to build timeline from MasterMobs only
  const _dbgSlots = [];     // slot diagnostics for main-thread logging

  for (const mobSet of mobSets) {
    if (mobSet === masterMobs) _usedMasterFallback = true;
    // Only skip MasterMob fallback if CompMob produced events that survive the
    // AVID_INTERNAL filter. If all CompMob events reference Precompute/internal
    // mobs they'll be filtered away — let MasterMob fallback run instead.
    if (events.some(ev => !AVID_INTERNAL.test(ev.reel||'') && !AVID_INTERNAL.test(ev.clipName||''))) break;

    const isCompPass = (mobSet === topLevelCompMobs);

  for (const mob of mobSet) {
    const slots = getVec(mob, PID.MobSlots, objects, ole2);
    if (slots.length === 0) continue;

    const mobName = mob.props[PID.MobName] ? readUTF16(mob.props[PID.MobName].value) : '';

    // ── Collect usable picture slots for this mob ───────────────────────────
    // The previous logic picked only the single “best” slot, which removed real
    // editorial secondary layers (for example V2 with a small number of clips).
    // Here we keep every slot that can actually resolve SourceClip chains, while
    // still excluding obvious non-picture / timecode / empty wrapper slots.
    const _picOk = isCompPass
      ? (sl) => !isSlotExplicitlySound(sl, objects, ole2)
      : (sl) => slotIsPicture(sl, objects, ole2);

    function _countSourceRefs(obj, depth = 0, seen = null) {
      if (!obj || depth > 12) return 0;
      if (!seen) seen = new Set();
      if (seen.has(obj.id)) return 0;
      seen.add(obj.id);
      if (obj.props?.[PID.SrcRefSourceID]) return 1;
      let total = 0;
      if (hasComponents(obj)) {
        for (const comp of getComponents(obj, objects, ole2)) {
          total += _countSourceRefs(comp, depth + 1, seen);
        }
      }
      if (obj.byName) {
        for (const [childName, cid] of obj.byName) {
          if (childName === 'Rendering-b05') continue;
          if (childName === 'properties' || childName.endsWith(' index')) continue;
          if (childName.startsWith('Parameters-') || childName.startsWith('Componen-uteList-')) continue;
          const child = objects.get(cid);
          if (child) total += _countSourceRefs(child, depth + 1, seen);
        }
      }
      return total;
    }

    const candidateSlots = [];
    for (const sl of slots) {
      if (!_picOk(sl)) continue;
      const sg = getRef(sl, PID.MobSlotSegment, objects)
              || (hasComponents(sl) || sl.props[PID.SrcRefSourceID] ? sl : null);
      if (!sg) continue;
      const trkN = readUint32(sl.props[PID.PhysTrackNum]?.value);
      if (trkN === 5) continue; // Avid timecode track convention
      const cnt = _countSourceRefs(sg, 0, new Set());
      if (cnt <= 0) continue;
      candidateSlots.push({ sl, sg, trkN, cnt });
    }

    if (!candidateSlots.length) continue;

    candidateSlots.sort((a, b) => {
      const at = Number.isFinite(a.trkN) ? a.trkN : 9999;
      const bt = Number.isFinite(b.trkN) ? b.trkN : 9999;
      if (at !== bt) return at - bt;
      return b.cnt - a.cnt;
    });

    const mobEventsBefore = events.length;
    for (const cand of candidateSlots) {
      const { sl, sg, trkN, cnt } = cand;

      if (_dbgSlots.length < 40) {
        const _ddData = (sl.props[PID.DataDef]?.value) ||
                        (sg?.props[PID.DataDef]?.value) || null;
        const _ddKind = _ddData ? readDataDefKind(_ddData) : 'NONE';
        const _ddHex  = _ddData ? Array.from(_ddData.slice(0,8))
                          .map(b => b.toString(16).padStart(2,'0')).join(' ') : 'N/A';
        _dbgSlots.push(`PT${trkN} VID dd=${_ddKind} hex=[${_ddHex}] cmp=${cnt} ${mobName.slice(0,24)}`);
      }

      const er   = sl.props[PID.EditRate] ? readRational(sl.props[PID.EditRate].value) : { n:24, d:1 };
      const fps  = er.d > 0 ? er.n / er.d : 24;
      const orig = sl.props[PID.Origin] ? readInt64(sl.props[PID.Origin].value) : 0;
      const evsBefore = events.length;
      walkSeg(sg, fps, orig, mob, mobName, 0, events, objects, ole2, byMobID, trkN, isCompPass);
      if (events.length > evsBefore) gFps = fps;
    }

    if (isCompPass && events.length > mobEventsBefore) {
      const produced = events.slice(mobEventsBefore);
      const useful = produced.filter(ev => !AVID_INTERNAL.test(ev?.reel || '') && !AVID_INTERNAL.test(ev?.clipName || ''));
      if (useful.length) {
        _fromCompMob = true;
        console.log('[AAF] CompPass: kept ' + candidateSlots.length + ' slot(s) -> ' + useful.length + ' useful events');
      } else {
        console.log('[AAF] CompPass: produced only internal/precompute refs; falling back to MasterMobs');
      }
    }
    // CompMob pass: stop at the first mob that produces events — it is the timeline.
    // Without this, every spurious unreferenced mob accumulates events.
    if (isCompPass && events.length > mobEventsBefore) break;
  }  // end inner mob loop
  }  // end mobSets loop

  // Deduplicate: same reel + srcIn + track → keep first occurrence.
  // Include track in the key so the same clip used on V1 and V2 both survive.
  // Filter out Avid/Resolve internal mob references that appear when secondary
  // MasterMob slots are traversed.  Patterns seen in the wild:
  //   mamMMOB.299, msmMMOB.5, mamPCM.3, msmPCM.7, Precompute Source Mob
  // Convention: 3 lowercase letters followed by 2+ uppercase letters (MMOB / PCM / WAV …)
  // (AVID_INTERNAL defined above, before the mobSets loop)
  const seen = new Set();
  const deduped = events.filter(ev => {
    if (AVID_INTERNAL.test(ev.reel) || AVID_INTERNAL.test(ev.clipName)) return false;
    const key = `${ev.reel}|${ev.srcIn}|${ev.track}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  // ── Fix overlapping record TCs ────────────────────────────────────────────
  // Events sourced from MasterMob slots (not a true CompMob sequence) all get
  // recIn=00:00:00:00 because each MasterMob starts at offset 0.  When every
  // clip on a track has the same recIn the timeline renderer draws them all
  // on top of each other.  Detect this per-track and rewrite recIn/recOut
  // sequentially (sorted by srcIn) so the visual layout is non-overlapping.
  // Skip this step for CompMob-sourced events: CompMob provides real record TCs
  // (including gaps / filler) which must be preserved.
  (function fixTrackOverlaps() {
    // CompMob provides real editorial record time. MasterMob fallback is handled
    // separately below with a custom normaliser that preserves sample-style AAF
    // timelines more faithfully.
    if (_fromCompMob || _usedMasterFallback) return;
    const trackEvs = new Map();
    for (const ev of deduped) {
      if (!trackEvs.has(ev.track)) trackEvs.set(ev.track, []);
      trackEvs.get(ev.track).push(ev);
    }
    for (const [, evs] of trackEvs) {
      const recIns = new Set(evs.map(ev => ev.recIn));
      if (recIns.size > 1) continue;
      let cursor = 0;
      for (const ev of evs) {
        const fps2 = ev.fps || gFps || 24;
        const sIn  = tcToFrames(ev.srcIn,  fps2) || 0;
        const sOut = tcToFrames(ev.srcOut, fps2) || 0;
        const dur  = Math.max(1, sOut - sIn);
        ev.recIn  = toTC(cursor,        fps2);
        ev.recOut = toTC(cursor + dur,  fps2);
        cursor += dur;
      }
    }
  })();

  // ── MasterMob fallback normalisation ─────────────────────────────────────
  // If the real top-level CompositionMob could not be reconstructed, we fall back
  // to traversing MasterMobs. In that mode the AAF does not provide reliable
  // editorial record track/timing for this UI, so expose a simple single-lane
  // sequential cut list in the same order as the extracted events. This matches
  // how the pull-prep timeline is expected to read: editorial order first, not
  // overlapping source-mob layers.
  if (!_fromCompMob && _usedMasterFallback && deduped.length) {
    // MasterMob fallback does not carry trustworthy editorial record lanes.
    // The sample AAFs used by PostFlowX read best as a single editorial lane,
    // with at most a very small number of sparse overlay clips on V2.
    const secondaryRuns = [];
    let runStart = -1;
    for (let i = 0; i < deduped.length; i++) {
      const isSecondary = (Number(deduped[i].track) || 0) > 0;
      if (isSecondary && runStart < 0) runStart = i;
      if ((!isSecondary || i === deduped.length - 1) && runStart >= 0) {
        const runEnd = isSecondary && i === deduped.length - 1 ? i : (i - 1);
        secondaryRuns.push({ start: runStart, end: runEnd, len: (runEnd - runStart + 1) });
        runStart = -1;
      }
    }

    const hasNoisySecondary = secondaryRuns.length > 4 || deduped.filter(ev => (Number(ev.track) || 0) > 0).length > 8;
    const overlayKeep = new Set();

    if (hasNoisySecondary) {
      for (let ri = 0; ri < secondaryRuns.length; ri++) {
        const run = secondaryRuns[ri];
        const prevGap = (ri === 0) ? run.start : (run.start - secondaryRuns[ri - 1].end - 1);
        const nextGap = (ri === secondaryRuns.length - 1) ? (deduped.length - 1 - run.end) : (secondaryRuns[ri + 1].start - run.end - 1);
        if (run.len === 1 && (prevGap >= 100 || nextGap >= 100)) {
          overlayKeep.add(run.start);
          if (overlayKeep.size >= 2) break;
        }
      }
    }

    let cursor = 0;
    for (let i = 0; i < deduped.length; i++) {
      const ev = deduped[i];
      const evFps = ev.fps || gFps || 24;
      const sIn = tcToFrames(ev.srcIn, evFps) || 0;
      const sOut = tcToFrames(ev.srcOut, evFps) || 0;
      const dur = Math.max(1, sOut - sIn);
      const keepAsOverlay = overlayKeep.has(i);
      ev._origTrack = ev.track;
      ev.track = keepAsOverlay ? 1 : 0;
      ev.recIn = toTC(cursor, evFps);
      ev.recOut = toTC(cursor + dur, evFps);
      if (!keepAsOverlay) cursor += dur;
    }
  }

  // Re-number
  deduped.forEach((ev, i) => { ev.event = i + 1; });

  // Get project name from first top-level CompMob (or any non-SourceMob) that has a name
  let projName = '';
  for (const mob of [...topLevelCompMobs, ...masterMobs]) {
    const n = mob.props[PID.MobName] ? readUTF16(mob.props[PID.MobName].value) : '';
    if (n) { projName = n; break; }
  }

  // Track distribution diagnostic
  const trkCount = {};
  for (const ev of deduped) trkCount[ev.track] = (trkCount[ev.track]||0)+1;
  const v1s = deduped.filter(e => e.track===0).slice(0,3);
  const v2s = deduped.filter(e => e.track===1).slice(0,3);
  console.log('[AAF] fromComp:', _fromCompMob, '| tracks:', JSON.stringify(trkCount),
    '| V1 sample:', v1s.map(e=>`${e.reel}@${e.recIn}`).join(' '),
    '| V2 sample:', v2s.map(e=>`${e.reel}@${e.recIn}`).join(' '));

  // CompMob diagnostic — why did the CompMob pass produce 0 events?
  const _compDbg = topLevelCompMobs.map(m => {
    const nm   = m.props[PID.MobName] ? readUTF16(m.props[PID.MobName].value) : '(no name)';
    const slt  = getVec(m, PID.MobSlots, objects, ole2);
    const slotInfo = slt.map(slot => {
      const trkN = readUint32(slot.props[PID.PhysTrackNum]?.value);
      const isPicStrict  = slotIsPicture(slot, objects, ole2);
      const isPicPermiss = !isSlotExplicitlySound(slot, objects, ole2);
      const seg   = getRef(slot, PID.MobSlotSegment, objects);
      const hasCmp = seg ? hasComponents(seg) : false;
      const cmpCnt = hasCmp ? getComponents(seg, objects, ole2).length : 0;
      // Dump segment child names + prop PIDs for any slot with a segment but 0 components
      const segDbg = (seg && cmpCnt === 0) ? {
        childKeys: [...seg.byName.keys()].slice(0, 20),
        propPids:  Object.keys(seg.props).map(p => '0x' + (+p).toString(16)),
      } : null;
      return `PT${trkN}:${isPicStrict?'VID':isPicPermiss?'PERM':'---'} seg=${!!seg} cmp=${cmpCnt}${segDbg ? ' segDbg='+JSON.stringify(segDbg) : ''}`;
    });
    return { name: nm.slice(0,40), slots: slotInfo };
  });

  return { events: deduped, fps: gFps, projectName: projName,
           _dbg: { fromComp: _fromCompMob, usedMasterFallback: _usedMasterFallback, trkCount,
                   compMobCount: topLevelCompMobs.length,
                   masterMobCount: masterMobs.length,
                   compMobs: _compDbg,
                   slots: _dbgSlots } };
}

// followThruInternal: when true (CompMob pass only), follow through Avid Precompute/internal
// mobs in the mob-name resolution loop to find the underlying real camera MasterMob name.
// Must be false for MasterMob fallback — otherwise AVID_INTERNAL mobs that should be
// deduped away get resolved to real camera names and inflate the event count.
function walkSeg(seg, fps, orig, parentMob, parentName, recOff, events, objects, ole2, byMobID, trackNum, followThruInternal) {
  const props = seg.props;

  // Sequence: recurse into components
  if (hasComponents(seg)) {
    let compOff = 0;
    for (const comp of getComponents(seg, objects, ole2)) {
      const compLen = comp.props[PID.CompLength] ? readInt64(comp.props[PID.CompLength].value) : 0;
      walkSeg(comp, fps, orig, parentMob, parentName, recOff + compOff, events, objects, ole2, byMobID, trackNum, followThruInternal);
      if (compLen > 0 && compLen < 1e12) compOff += compLen;
    }
    return;
  }

  // SourceClip: has SrcRefSourceID
  if (!props[PID.SrcRefSourceID]) {
    // Avid wrapper nodes frequently place the real editorial SourceClips inside
    // one or more named child storages (for example InputSegment-*, InputSegments-*
    // or nested selector/operation children). The earlier implementation returned
    // after the first usable child, which caused the CompMob pass to keep only a
    // single internal/precompute branch and miss the real editorial children.
    // Walk every eligible child instead.
    let walkedAny = false;
    for (const [childName, cid] of seg.byName) {
      if (childName === 'Rendering-b05') continue;
      if (childName === 'properties' || childName.endsWith(' index')) continue;
      if (childName.startsWith('Parameters-') || childName.startsWith('Componen-uteList-')) continue;
      const child = objects.get(cid);
      if (!child) continue;
      walkedAny = true;
      walkSeg(child, fps, orig, parentMob, parentName, recOff, events, objects, ole2, byMobID, trackNum, followThruInternal);
    }
    if (!walkedAny) {
      console.log('[WS] no SrcRef (no usable child), name:', seg.name, 'props:', Object.keys(props).map(p=>'0x'+Number(p).toString(16)));
    }
    return;
  }

  const srcMobHex = readMobID(props[PID.SrcRefSourceID].value);
  // Null reference (all zeros) = origin/filler
  if (!srcMobHex || /^0+$/.test(srcMobHex)) { console.log('[WS] null SrcRef'); return; }

  const clipStart = props[PID.SrcClipStart] ? readInt64(props[PID.SrcClipStart].value) : 0;
  const compLenProp = props[PID.CompLength];
  let clipLen   = compLenProp ? readInt64(compLenProp.value) : 0;
  console.log('[WS] SourceClip srcMob=' + srcMobHex.slice(0,12) + ' clipLen=' + clipLen + ' track=' + trackNum);
  if (clipLen <= 0 || clipLen >= 1e12) {
    // Avid CompMob SourceClips often omit ComponentLength.
    // Fallback: derive duration from the referenced mob's own slot segment length.
    const refMobForLen = byMobID.get(srcMobHex);
    if (refMobForLen) {
      outer: for (const refSlot of getVec(refMobForLen, PID.MobSlots, objects, ole2)) {
        const refSeg = getRef(refSlot, PID.MobSlotSegment, objects);
        if (!refSeg) continue;
        const refLen = refSeg.props[PID.CompLength] ? readInt64(refSeg.props[PID.CompLength].value) : 0;
        if (refLen > 0 && refLen < 1e12) { clipLen = refLen; break outer; }
        if (hasComponents(refSeg)) {
          for (const comp of getComponents(refSeg, objects, ole2)) {
            const cLen = comp.props[PID.CompLength] ? readInt64(comp.props[PID.CompLength].value) : 0;
            if (cLen > 0 && cLen < 1e12) { clipLen = cLen; break outer; }
          }
        }
      }
    }
    if (clipLen <= 0 || clipLen >= 1e12) {
      console.log('[WS] SKIP clipLen invalid (no fallback):', clipLen);
      return;
    }
    console.log('[WS] clipLen from refMob fallback:', clipLen);
  }

  // Resolve source timecode by following the mob chain
  const resolved = resolveSource(srcMobHex, clipStart, objects, byMobID, ole2, 5);
  if (!resolved) { console.log('[WS] resolveSource null for srcMob=' + srcMobHex.slice(0,12)); return; }

  const { srcStart, fps: resolvedFps } = resolved;
  const useFps = resolvedFps || fps;

  // Get clip/reel name from the referenced MasterMob (camera filename).
  // The SrcRefSourceID in a CompMob SourceClip points to a MasterMob whose
  // PID.MobName holds the original camera filename (e.g. "B_0032C015_241215_...").
  const refMob = byMobID.get(srcMobHex);
  let clipName = '';

  let cur = refMob;
  let depth = 0;
  while (cur && depth < 6) {
    const n = cur.props[PID.MobName] ? readUTF16(cur.props[PID.MobName].value) : '';
    // In CompMob pass (followThruInternal=true): skip AVID_INTERNAL names and keep
    // following the chain to find the real camera MasterMob underneath Precompute mobs.
    // In MasterMob pass: accept any non-empty name so AVID_INTERNAL mobs remain
    // identifiable and get filtered by the dedup step.
    if (n && (followThruInternal ? !AVID_INTERNAL.test(n) : true)) { clipName = n; break; }
    // Follow one hop deeper via picture-slot SourceClip
    let foundNext = false;
    for (const slot of getVec(cur, PID.MobSlots, objects, ole2)) {
      if (isSlotExplicitlySound(slot, objects, ole2)) continue;
      const s = getRef(slot, PID.MobSlotSegment, objects);
      if (!s) continue;
      const srcProp = s.props[PID.SrcRefSourceID]
        || (hasComponents(s) ? (getComponents(s, objects, ole2).find(c => c.props[PID.SrcRefSourceID])?.props[PID.SrcRefSourceID]) : null);
      if (srcProp) {
        const nextHex = readMobID(srcProp.value);
        if (nextHex && !/^0+$/.test(nextHex)) {
          cur = byMobID.get(nextHex) ?? null;
          foundNext = !!cur;
          break;
        }
      }
    }
    if (!foundNext) break;
    depth++;
  }

  // In CompMob pass: use resolved.mobName (Camera MasterMob name) if the loop above
  // still hasn't found a non-internal name (e.g. when the Precompute mob's slot
  // walk fails but resolveSource correctly traversed the chain).
  if (followThruInternal && (!clipName || AVID_INTERNAL.test(clipName)) && resolved.mobName && !AVID_INTERNAL.test(resolved.mobName))
    clipName = resolved.mobName;
  // General fallback (both passes)
  if (!clipName && resolved.mobName) clipName = resolved.mobName;
  if (!clipName) clipName = parentName || 'UNKNOWN';

  // Strip Avid version suffix (.new.01) to get the clean camera clip name
  const masterMobName = stripAvidSuffix(clipName);

  // SourceMob name (tape / OCF identifier) takes priority as the reel.
  // MasterMob name is the editor's clip label — use it as clipName only.
  // If SourceMob has no name (common in Avid), fall back to MasterMob name.
  const srcReel = resolved.sourceReelName ? stripAvidSuffix(resolved.sourceReelName) : '';
  const reelName = srcReel || masterMobName;

  const recIn  = Math.max(0, recOff - orig);
  const recOut = recIn + clipLen;

  // ── Sub-CompMob track detection ───────────────────────────────────────────
  // When a CompMob slot has unreliable DataDef (e.g. "timecode" instead of "picture"),
  // all its SourceClips are processed under the same trackNum (e.g. PT1=V1).
  // But some of those SourceClips may reference sub-CompMobs whose VID slot is on
  // PT2 (V2). Detect this: if refMob is a sub-CompMob (its VID slot targets a
  // non-SourceMob / MasterMob), use the sub-CompMob's slot PT for track assignment.
  let effectiveTrackNum = trackNum;
  if (refMob && !isSourceMob(refMob)) {
    for (const refSlot of getVec(refMob, PID.MobSlots, objects, ole2)) {
      const refTrkN = readUint32(refSlot.props[PID.PhysTrackNum]?.value);
      if (!refTrkN || refTrkN === 5) continue; // skip PT0 and standard Avid TC slot
      const refSeg = getRef(refSlot, PID.MobSlotSegment, objects);
      if (!refSeg || !refSeg.props[PID.SrcRefSourceID]) continue;
      const nextHex = readMobID(refSeg.props[PID.SrcRefSourceID].value);
      if (!nextHex || /^0+$/.test(nextHex)) continue;
      const nextMob = byMobID.get(nextHex);
      if (nextMob && !isSourceMob(nextMob)) {
        // refMob is a sub-CompMob: its VID slot points to a MasterMob, not a SourceMob.
        // Use the sub-CompMob's slot PT to correctly assign V1 vs V2.
        effectiveTrackNum = refTrkN;
      }
      // Whether sub-CompMob or MasterMob, first non-TC slot is the primary picture track.
      break;
    }
  }

  console.log('[WS] PUSH reel=' + reelName + ' track=' + Math.max(0,(effectiveTrackNum||1)-1) + ' srcIn=' + toTC(srcStart, useFps));
  events.push({
    event:      0, // re-numbered later
    reel:       reelName,
    clipName:   masterMobName,   // editor's clip label
    sourceFile: reelName,        // enables OCF detection downstream
    track:      Math.max(0, (effectiveTrackNum || 1) - 1),  // convert Avid 1-indexed → 0-indexed
    srcIn:      toTC(srcStart,           useFps),
    srcOut:     toTC(srcStart + clipLen, useFps),
    recIn:      toTC(recIn,  useFps),
    recOut:     toTC(recOut, useFps),
    fps:        useFps,
  });
}

// ── Worker entry point ────────────────────────────────────────────────────────
self.onmessage = function(e) {
  console.log('[AAF] worker build: 2026-04-06-v21');
  const buf = e.data?.arrayBuffer;
  try {
    if (!buf) throw new Error("No arrayBuffer received");
    const ole2    = parseOLE2(buf);
    const objects = buildObjectTree(ole2);
    const result  = extractEvents(objects, ole2);
    self.postMessage({ ok: true, data: result });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};
