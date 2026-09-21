// dbLibrarySource.js — PFXMAC Sprint 4 (DB-powered linking).
//
// Seeds the VFX-Pull OCF candidate set from the native SQLite media library
// (populated by the media scanner in Sprint 3) so auto-linking can run against
// previously-scanned camera files WITHOUT re-picking and re-scanning a folder.
//
// The SQLite store keeps filename/path/format/codec/fps/durationFrames but NOT
// reel / timecode / camera, so we derive reel·rollId·camera from the filename
// (same conventions as ocfIndexStore.js) and mark tcKnown:false — the matcher
// then skips TC comparisons instead of penalising the candidate. Filename- and
// reel-based matches still surface for review; TC-exact SAFE tiers need a folder
// scan (which carries container timecode).
'use strict';

const KNOWN_OCF_EXTS = new Set(['.r3d', '.ari', '.arx', '.mxf', '.mov', '.braw', '.crm', '.cine']);

const EXT_CAMERA = {
  '.r3d': 'RED', '.ari': 'ARRI', '.arx': 'ARRI',
  '.braw': 'BRAW', '.crm': 'CANON', '.cine': 'PHANTOM',
};

function _ext(filename) {
  const i = String(filename || '').lastIndexOf('.');
  return i >= 0 ? String(filename).slice(i).toLowerCase() : '';
}

function _stem(filename) {
  const i = String(filename || '').lastIndexOf('.');
  return i > 0 ? String(filename).slice(0, i) : String(filename || '');
}

// ARRI: A001C001_... → reel A001 ; RED / card: A001_... → A001
function _reel(filename) {
  const m = String(filename || '').match(/^([A-Z][0-9]{3})[A-Z_]/);
  if (m) return m[1];
  const m2 = String(filename || '').match(/^([A-Z][0-9]{3,4})[-_]/);
  if (m2) return m2[1];
  return '';
}

function _camera(filename, path) {
  const ext = _ext(filename);
  if (EXT_CAMERA[ext]) return EXT_CAMERA[ext];
  const full = `${path || ''}/${filename || ''}`.toLowerCase();
  if (/arri|alexa|amira/.test(full)) return 'ARRI';
  if (/red|r3d|dsmc/.test(full))     return 'RED';
  if (/sony|venice|burano|fx[0-9]/.test(full)) return 'SONY';
  return 'UNKNOWN';
}

// Map one SQLite media row → the OCF-candidate shape matchOcfToEvent expects.
function _rowToOcfFile(row) {
  const filename = row.filename || String(row.path || '').split('/').pop() || '';
  const ext = _ext(filename);
  if (!KNOWN_OCF_EXTS.has(ext)) return null;            // skip proxies / non-camera media
  // Prefer reel/timecode persisted in the DB (Sprint 4 — written at scan time);
  // fall back to deriving reel from the filename.
  const reel  = row.reel || _reel(filename);
  const dbTc  = (typeof row.tcIn === 'string' && row.tcIn.includes(':')) ? row.tcIn : '';
  const dbTcOut = (typeof row.tcOut === 'string' && row.tcOut.includes(':')) ? row.tcOut : '';
  return {
    path:        row.path || '',
    name:        filename,
    fileStem:    _stem(filename),
    ext,
    extension:   ext,
    reel,
    rollId:      reel,
    reelShort:   reel,
    camera:      _camera(filename, row.path),
    fps:         Number(row.fps) || null,
    frameCount:  Number(row.durationFrames) || null,
    durationFrames: Number(row.durationFrames) || null,
    width:       Number(row.width)  || null,
    height:      Number(row.height) || null,
    codec:       row.codec || '',
    // Use persisted container timecode when available (no ffprobe needed);
    // otherwise the on-load enrichment fills it in.
    tcKnown:     !!dbTc,
    tcIn:        dbTc,
    tcOut:       dbTcOut,
    metadataSource: dbTc ? 'library+tc' : 'library',
    _fromLibrary: true,
  };
}

// ── Timecode helpers (frame ↔ HH:MM:SS:FF) ───────────────────────────────────
function _tcToFrames(tc, fps) {
  const p = String(tc || '').replace(';', ':').split(':').map(Number);
  if (p.length !== 4 || p.some(n => Number.isNaN(n))) return 0;
  return ((p[0] * 3600 + p[1] * 60 + p[2]) * Math.round(fps || 24)) + p[3];
}
function _framesToTc(f, fps) {
  const r = Math.round(fps || 24); let n = Math.max(0, f | 0);
  const z = x => String(x).padStart(2, '0');
  return `${z(Math.floor(n / (r * 3600)))}:${z(Math.floor(n / (r * 60)) % 60)}:${z(Math.floor(n / r) % 60)}:${z(n % r)}`;
}

// Read a file's embedded start timecode via ffprobe (no decode needed — works
// even for ARRIRAW that ffmpeg can't decode) and stamp tcIn/tcOut/fps so the
// matcher scores on BOTH filename AND timecode, not filename alone.
async function _enrichTimecode(file) {
  const probe = (typeof window !== 'undefined') ? window.pfxPlatform?.media?.ffprobeInfo : null;
  if (typeof probe !== 'function' || !file?.path) return;
  try {
    const r   = await probe({ path: file.path });
    const fmt = r?.format || r?.data?.format || {};
    const tc  = (fmt.tags && (fmt.tags.timecode || fmt.tags.TimeCode)) || r?.timecode || '';
    if (tc && tc.includes(':')) {
      const fps = Number(file.fps) || Number(r?.fps) || 24;
      file.tcIn     = tc;
      file.tcKnown  = true;
      file.fps      = file.fps || (Number(r?.fps) || 24);
      const df = Number(file.durationFrames || file.frameCount || 0);
      file.tcOut = df > 0 ? _framesToTc(_tcToFrames(tc, fps) + df, fps) : tc;
      file.metadataSource = 'library+tc';
    }
  } catch { /* keep filename-only matching for this file */ }
}

/**
 * Load OCF candidates from the SQLite media library.
 * @param {object} [opts]
 * @param {string} [opts.term='']   filename/path filter (empty = whole library)
 * @param {number} [opts.limit=20000]
 * @param {boolean} [opts.withTimecode=true]  probe each file's embedded TC (ffprobe)
 * @returns {Promise<{ok:boolean, files:object[], total:number, error?:string}>}
 */
export async function loadOcfFilesFromLibrary({ term = '', limit = 20000, withTimecode = true } = {}) {
  const eng = (typeof window !== 'undefined') ? window.pfxPlatform?.nativeEngine : null;
  if (!eng || typeof eng.command !== 'function') {
    return { ok: false, files: [], total: 0, error: 'Media database unavailable (native engine not running).' };
  }
  let rows = [];
  try {
    const r = await eng.command('db.search', { term, limit });
    rows = Array.isArray(r) ? r : [];
  } catch (e) {
    return { ok: false, files: [], total: 0, error: e?.message || 'Library query failed' };
  }
  const files = [];
  const seen = new Set();
  for (const row of rows) {
    const f = _rowToOcfFile(row);
    if (!f || !f.path || seen.has(f.path)) continue;
    seen.add(f.path);
    files.push(f);
  }

  // Stamp embedded timecode (ffprobe) so linking matches on filename AND timecode.
  // ONLY for files whose TC isn't already persisted in the DB (Sprint 4) — so a
  // re-scanned library is instant. Newly-probed TC is written back to the DB so
  // the next load skips ffprobe entirely. Capped + batched for responsiveness.
  if (withTimecode && files.length) {
    const needProbe = files.filter(f => !f.tcKnown).slice(0, 400);
    const BATCH = 6;
    for (let i = 0; i < needProbe.length; i += BATCH) {
      await Promise.all(needProbe.slice(i, i + BATCH).map(async f => {
        await _enrichTimecode(f);
        if (f.tcKnown) await _persistTcToDb(f, rows);   // cache for next time
      }));
    }
  }

  return { ok: true, files, total: rows.length };
}

// Write a freshly-probed timecode/reel back into the SQLite row (db.upsert) so
// subsequent library loads read it instantly instead of re-running ffprobe.
async function _persistTcToDb(file, rows) {
  const eng = (typeof window !== 'undefined') ? window.pfxPlatform?.nativeEngine : null;
  if (!eng || typeof eng.command !== 'function' || !file?.tcIn) return;
  const row = (rows || []).find(r => r.path === file.path);
  if (!row || !row.id) return;
  try {
    await eng.command('db.upsert', {
      ...row,
      tcIn:  file.tcIn,
      tcOut: file.tcOut || '',
      reel:  file.reel  || row.reel || '',
    });
  } catch { /* best-effort cache; matching still works from the in-memory tc */ }
}

/** Quick availability check — how many media rows the library holds. */
export async function libraryCount() {
  const eng = (typeof window !== 'undefined') ? window.pfxPlatform?.nativeEngine : null;
  if (!eng || typeof eng.command !== 'function') return 0;
  try {
    const n = await eng.command('db.count', {});
    if (typeof n === 'number') return n;
    if (n && typeof n.count === 'number') return n.count;
    return 0;
  } catch { return 0; }
}
