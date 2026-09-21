'use strict';
/**
 * mediaIndexer.js — bridges the OCF/media scanner to the native SQLite media DB
 * (PFXMAC Sprint 3). Maps a probed file object to a MediaRecord and bulk-upserts
 * via the native engine. Best-effort: never throws, so a DB hiccup can't break a
 * scan. Kept dependency-light (no Electron) so it's unit-testable in plain Node.
 */
const path = require('path');
const fs   = require('fs');

/**
 * Map one probed scanner file → the native MediaRecord shape.
 * `file` is the scanner object: { path, name?, size?, umid?, codec?, width?,
 * height?, fps?, frameCount? }. Returns null when there's no usable path.
 */
function recordFromOcfFile(file) {
  if (!file || !file.path) return null;
  let sizeBytes = Number(file.size) || 0;
  let modified  = 0;
  try {
    const st = fs.statSync(file.path);
    if (!sizeBytes) sizeBytes = st.size;
    modified = st.mtimeMs / 1000;
  } catch { /* file may be remote/unavailable — keep what the scanner gave us */ }

  // Reel/roll from the filename (ARRI A001C001… → A001 ; card A001_… → A001).
  const _fn = file.name || path.basename(file.path);
  let reel = file.reel || '';
  if (!reel) {
    const m = String(_fn).match(/^([A-Z][0-9]{3})[A-Z_]/) || String(_fn).match(/^([A-Z][0-9]{3,4})[-_]/);
    reel = m ? m[1] : '';
  }

  return {
    id:             file.umid || file.path,          // stable content key when available
    path:           file.path,
    filename:       _fn,
    format:         path.extname(file.path).slice(1).toLowerCase(),
    codec:          file.codec  || '',
    width:          Number(file.width)  || 0,
    height:         Number(file.height) || 0,
    fps:            Number(file.fps)    || 0,
    durationFrames: Number(file.frameCount) || 0,
    sizeBytes,
    modified,
    // Sprint 4: persist embedded timecode + reel so library matching uses
    // filename + timecode without re-probing on every load.
    tcIn:           file.tcIn  || '',
    tcOut:          file.tcOut || '',
    reel,
  };
}

/**
 * Upsert every scanned file into the native DB. `engine` is the
 * pfx_native_engine singleton (must expose `dbUpsert`). Returns the number
 * indexed. Per-file failures are swallowed (best-effort).
 */
async function indexFiles(files, engine) {
  if (!engine || typeof engine.dbUpsert !== 'function' || !Array.isArray(files)) return 0;
  let n = 0;
  for (const f of files) {
    const rec = recordFromOcfFile(f);
    if (!rec) continue;
    try { await engine.dbUpsert(rec); n++; } catch { /* best-effort */ }
  }
  return n;
}

module.exports = { recordFromOcfFile, indexFiles };
