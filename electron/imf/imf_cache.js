'use strict';

/**
 * imf_cache.js — Persistent disk cache for IMF decoded preview frames.
 *
 * Cache layout:
 *   <userData>/PostFlowXCache/IMFPreview/<packageHash>/<cplId>/<frame>_<variant>.png
 *
 * Cache keys include:
 *   - packageHash  (from ASSETMAP mtime)
 *   - cplId        (CPL UUID)
 *   - frame        (absolute MXF frame = entryPoint + reelLocalFrame)
 *   - variant      (e.g. "sdr", "hdr", "raw") for different display transforms
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CACHE_ROOT_NAME = 'IMFPreview';

class IMFPreviewCache {
  constructor() {
    this._baseDir = null;
    this._ready   = false;
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  /**
   * Initialise the cache directory.
   * @param {string} userDataPath — Electron app.getPath('userData')
   */
  init(userDataPath) {
    try {
      this._baseDir = path.join(userDataPath, 'PostFlowXCache', CACHE_ROOT_NAME);
      fs.mkdirSync(this._baseDir, { recursive: true });
      this._ready = true;
    } catch (e) {
      console.warn('[IMFCache] init failed:', e.message);
      // Fall back to temp dir so the rest still works
      this._baseDir = path.join(os.tmpdir(), 'pfx-imf-cache');
      try { fs.mkdirSync(this._baseDir, { recursive: true }); this._ready = true; }
      catch { this._ready = false; }
    }
    return this;
  }

  // ── Key → path ─────────────────────────────────────────────────────────────

  /**
   * Return the absolute cache path for a given frame.
   * Does NOT check if the file exists.
   */
  framePath(packageHash, cplId, mxfFrame, variant = 'sdr', ext = 'png') {
    if (!this._ready) return null;
    const safeHash  = _safe(packageHash);
    const safeCpl   = _safe(cplId);
    const dir = path.join(this._baseDir, safeHash, safeCpl);
    return path.join(dir, `${mxfFrame}_${variant}.${ext}`);
  }

  // ── Read / Write ───────────────────────────────────────────────────────────

  /**
   * Check if a cached frame exists and return its path; null if not cached.
   * Extension-agnostic: a frame may be cached as JPEG (fast SDR preview) or PNG
   * (16-bit HDR/raw), so check both and return whichever exists.
   */
  get(packageHash, cplId, mxfFrame, variant = 'sdr') {
    for (const ext of ['jpg', 'png']) {
      const fp = this.framePath(packageHash, cplId, mxfFrame, variant, ext);
      if (fp && fs.existsSync(fp)) return fp;
    }
    return null;
  }

  /**
   * Ensure the cache directory for this package/cpl exists.
   * Call before writing a new frame.
   */
  ensureDir(packageHash, cplId) {
    if (!this._ready) return null;
    const dir = path.join(this._baseDir, _safe(packageHash), _safe(cplId));
    try { fs.mkdirSync(dir, { recursive: true }); return dir; }
    catch { return null; }
  }

  // ── Housekeeping ───────────────────────────────────────────────────────────

  /**
   * Remove all cached frames for a specific package.
   */
  clearPackage(packageHash) {
    if (!this._ready) return;
    const dir = path.join(this._baseDir, _safe(packageHash));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }

  /**
   * Remove all IMF preview cache entries.
   */
  clearAll() {
    if (!this._ready || !this._baseDir) return;
    try { fs.rmSync(this._baseDir, { recursive: true, force: true }); } catch {}
    try { fs.mkdirSync(this._baseDir, { recursive: true }); } catch {}
  }

  /**
   * Return total cache size in bytes (approximate).
   */
  sizeBytes() {
    if (!this._ready || !this._baseDir) return 0;
    return _dirSize(this._baseDir);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _safe(s) {
  return (s || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function _dirSize(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) total += _dirSize(p);
      else { try { total += fs.statSync(p).size; } catch {} }
    }
  } catch {}
  return total;
}

module.exports = { IMFPreviewCache };
