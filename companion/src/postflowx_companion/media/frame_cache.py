"""Disk-based LRU frame cache for the shared media runtime.

Replaces the per-backend ad-hoc SHA256 cache with a single managed store
that enforces size limits, tracks hit rates, and can be evicted per-session.

Layout:
  pfx_media_frames/
    cache/
      <sha256_hex>.jpg      ← decoded frame JPEG/PNG
    index.json              ← LRU metadata: {key: {path, size, atime, session_id}}
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from pathlib import Path
from typing import Any

# Default limits
_DEFAULT_MAX_BYTES   = 512 * 1024 * 1024   # 512 MB
_DEFAULT_MAX_ENTRIES = 2000
_INDEX_FILE          = "cache_index.json"
_FRAME_DIR           = "frames"


class FrameCache:
    """
    Thread-safe disk LRU cache for decoded media frames.

    Key = (session_id, frame_index, quality, width, height, format)
    Value = JPEG/PNG bytes written to disk; callers get back a Path.

    LRU eviction fires when total_bytes > max_bytes or count > max_entries.
    """

    def __init__(self, cache_root: Path,
                 max_bytes: int = _DEFAULT_MAX_BYTES,
                 max_entries: int = _DEFAULT_MAX_ENTRIES):
        self._root      = cache_root
        self._frames    = cache_root / _FRAME_DIR
        self._max_bytes = max_bytes
        self._max_ents  = max_entries
        self._lock      = threading.Lock()
        self._hits      = 0
        self._misses    = 0
        self._index: dict[str, dict[str, Any]] = {}

        self._frames.mkdir(parents=True, exist_ok=True)
        self._load_index()

    # ── Public API ────────────────────────────────────────────────────────────

    @staticmethod
    def make_key(session_id: str, frame_index: int,
                 quality: str = "half", width: int = 1280, height: int = 720,
                 fmt: str = "jpg") -> str:
        """Canonical cache key → SHA256 hex string."""
        raw = f"{session_id}:{frame_index}:{quality}:{width}:{height}:{fmt}"
        return hashlib.sha256(raw.encode()).hexdigest()

    def get(self, key: str) -> Path | None:
        """Return cached frame Path if it exists and is valid, else None."""
        with self._lock:
            entry = self._index.get(key)
            if not entry:
                self._misses += 1
                return None
            p = Path(entry["path"])
            if not p.is_file() or p.stat().st_size == 0:
                # Stale entry — remove from index
                self._index.pop(key, None)
                self._misses += 1
                return None
            # Touch atime for LRU ordering
            entry["atime"] = time.time()
            self._hits += 1
            return p

    def put(self, key: str, data: bytes, session_id: str = "",
            fmt: str = "jpg") -> Path:
        """Write frame bytes to disk and register in index. Returns Path."""
        out_path = self._frames / f"{key}.{fmt}"
        # Atomic write via temp file
        tmp_path = out_path.with_suffix(f".{fmt}.tmp")
        try:
            tmp_path.write_bytes(data)
            try:
                os.replace(str(tmp_path), str(out_path))
            except FileNotFoundError:
                # A concurrent put() for the same key already renamed the tmp file.
                # out_path exists with valid data — proceed to update the index.
                pass
        finally:
            try: tmp_path.unlink(missing_ok=True)
            except: pass

        with self._lock:
            self._index[key] = {
                "path":       str(out_path),
                "size":       len(data),
                "atime":      time.time(),
                "session_id": session_id,
                "fmt":        fmt,
            }
            self._maybe_evict()
            self._save_index_nolock()

        return out_path

    def put_file(self, key: str, src_path: Path, session_id: str = "",
                 fmt: str = "jpg") -> Path:
        """Register an already-written file into the cache index."""
        if not src_path.is_file():
            raise FileNotFoundError(str(src_path))
        dest = self._frames / f"{key}.{fmt}"
        if str(src_path) != str(dest):
            os.replace(str(src_path), str(dest))
        size = dest.stat().st_size
        with self._lock:
            self._index[key] = {
                "path":       str(dest),
                "size":       size,
                "atime":      time.time(),
                "session_id": session_id,
                "fmt":        fmt,
            }
            self._maybe_evict()
            self._save_index_nolock()
        return dest

    def evict_session(self, session_id: str) -> int:
        """Remove all cached frames for a session. Returns count removed."""
        removed = 0
        with self._lock:
            keys_to_remove = [k for k, v in self._index.items()
                               if v.get("session_id") == session_id]
            for k in keys_to_remove:
                self._delete_entry_nolock(k)
                removed += 1
            if removed:
                self._save_index_nolock()
        return removed

    def clear(self) -> int:
        """Remove all cached frames. Returns count removed."""
        with self._lock:
            count = len(self._index)
            for k in list(self._index.keys()):
                self._delete_entry_nolock(k)
            self._index.clear()
            self._save_index_nolock()
        return count

    def stats(self) -> dict[str, Any]:
        """Return cache statistics."""
        with self._lock:
            total_size  = sum(v["size"] for v in self._index.values())
            entry_count = len(self._index)
            hits, misses = self._hits, self._misses
        total_requests = hits + misses
        hit_rate = round(hits / total_requests * 100, 1) if total_requests else 0.0
        return {
            "entries":      entry_count,
            "totalBytes":   total_size,
            "totalMB":      round(total_size / 1024 / 1024, 2),
            "maxBytes":     self._max_bytes,
            "maxEntries":   self._max_ents,
            "hits":         hits,
            "misses":       misses,
            "hitRate":      hit_rate,
            "utilizationPct": round(total_size / self._max_bytes * 100, 1),
        }

    # ── Internal ──────────────────────────────────────────────────────────────

    def _maybe_evict(self) -> None:
        """LRU eviction — call while holding _lock."""
        total_size  = sum(v["size"] for v in self._index.values())
        over_bytes  = total_size  > self._max_bytes
        over_count  = len(self._index) > self._max_ents

        if not (over_bytes or over_count):
            return

        # Sort by atime ascending (oldest first)
        ordered = sorted(self._index.items(), key=lambda x: x[1]["atime"])
        while ordered and (
            sum(v["size"] for v in self._index.values()) > self._max_bytes * 0.85
            or len(self._index) > self._max_ents
        ):
            k, _ = ordered.pop(0)
            self._delete_entry_nolock(k)

    def _delete_entry_nolock(self, key: str) -> None:
        entry = self._index.pop(key, None)
        if entry:
            try: Path(entry["path"]).unlink(missing_ok=True)
            except: pass

    def _load_index(self) -> None:
        idx_path = self._root / _INDEX_FILE
        try:
            if idx_path.is_file():
                data = json.loads(idx_path.read_text())
                # Validate entries — drop stale paths
                self._index = {
                    k: v for k, v in data.items()
                    if Path(v.get("path", "")).is_file()
                }
        except Exception:
            self._index = {}

    def _save_index_nolock(self) -> None:
        idx_path = self._root / _INDEX_FILE
        try:
            tmp = idx_path.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self._index, indent=None))
            os.replace(str(tmp), str(idx_path))
        except Exception:
            pass
