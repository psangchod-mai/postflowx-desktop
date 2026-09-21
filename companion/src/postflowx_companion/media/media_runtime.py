"""Companion-side shared media runtime.

This is the single entry-point for all media commands from the extension.
Tabs talk to the extension mediaRuntime.js → mediaBridge.js → companion → here.
"""
from __future__ import annotations

import platform
import tempfile
from pathlib import Path
from typing import Any

from .media_types import Backend, BackendStatus, ErrorCode, DecodeQuality
from .media_session_store import (
    new_session_id, create_media_session, get_media_session,
    update_media_session, close_media_session, list_media_sessions,
)
from .media_backend_registry import classify_path, select_backend, get_backend_statuses
from .media_diagnostics import build_diagnostics
from .frame_cache import FrameCache
from .ring_buffer import PrefetchScheduler
from .backends import StandardMediaBackend, ProResNativeBackend, ProResRawBackend, BrawBackend, R3dBackend, ArriBackend, ArriToolBridgeBackend

# Default cache limits
_CACHE_MAX_BYTES   = 512 * 1024 * 1024   # 512 MB
_CACHE_MAX_ENTRIES = 2000
_PREFETCH_COUNT    = 6   # frames to prefetch ahead of current position


class MediaRuntime:
    """
    Orchestrates backend selection, session lifecycle, and command dispatch.
    Phase 7: includes shared FrameCache (LRU disk cache) + PrefetchScheduler
             (background ring-buffer decode for smooth scrubbing/playback).
    """

    def __init__(self, ffmpeg_path: str | None, ffprobe_path: str | None,
                 companion_version: str = "unknown",
                 http_port: int | None = None,
                 register_asset_fn=None):
        self._version  = companion_version
        self._platform = platform.system().lower()
        self._http_port = http_port
        self._register_asset = register_asset_fn

        # Phase 7: shared LRU frame cache and prefetch scheduler
        # Use proxy_root/frames/ when a media root is active, else system temp.
        try:
            from ..proxy_registry import get_frame_cache_root
            cache_root = get_frame_cache_root()
        except Exception:
            cache_root = Path(tempfile.gettempdir()) / "pfx_media_frames"
        cache_root.mkdir(parents=True, exist_ok=True)
        self._cache = FrameCache(cache_root, max_bytes=_CACHE_MAX_BYTES,
                                  max_entries=_CACHE_MAX_ENTRIES)
        self._prefetch = PrefetchScheduler(worker_count=2, buffer_size=8)
        self._ffmpeg_path  = ffmpeg_path
        self._ffprobe_path = ffprobe_path

        self._init_backends(cache_root)

    def _init_backends(self, cache_root: Path) -> None:
        """Instantiate all decode backends using cache_root as the frame temp dir."""
        ffmpeg_path  = self._ffmpeg_path
        ffprobe_path = self._ffprobe_path
        cache_root.mkdir(parents=True, exist_ok=True)
        std  = StandardMediaBackend(ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path,
                                    thumb_cache_dir=cache_root)
        pro  = ProResNativeBackend(ffmpeg_path=ffmpeg_path, cache_dir=cache_root)
        praw = ProResRawBackend(ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path,
                               cache_dir=cache_root / "prores_raw")
        arri      = ArriBackend(ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path,
                               cache_dir=cache_root / "arri")
        arri_tool = ArriToolBridgeBackend(ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path,
                                          cache_dir=cache_root / "arri")
        braw = BrawBackend(cache_dir=cache_root / "braw")
        r3d  = R3dBackend(ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path,
                          cache_dir=cache_root / "r3d")

        self._backends: dict[str, Any] = {
            Backend.STANDARD_MEDIA:    std,
            Backend.PRORES_NATIVE:     pro,
            Backend.PRORES_RAW_NATIVE: praw,
            Backend.ARRI_SDK:          arri,
            Backend.ARRI_TOOL_BRIDGE:  arri_tool,
            Backend.BRAW_SDK:          braw,
            Backend.R3D_SDK:           r3d,
        }

    def update_frame_cache_root(self, new_root: Path) -> None:
        """Re-point all backend frame caches to new_root after proxy root changes."""
        try:
            new_root.mkdir(parents=True, exist_ok=True)
            self._cache = FrameCache(new_root, max_bytes=_CACHE_MAX_BYTES,
                                     max_entries=_CACHE_MAX_ENTRIES)
            self._init_backends(new_root)
        except Exception:
            pass  # keep existing backends if update fails

    # ── open_file ─────────────────────────────────────────────────────────────
    def open_file(self, path: str, options: dict) -> dict[str, Any]:
        if not path:
            return _err(ErrorCode.BAD_REQUEST, "path is required")
        p = Path(path).expanduser().resolve()
        if not p.is_file():
            return _err(ErrorCode.FILE_OPEN_FAILED, f"File not found: {p}")

        preferred = options.get("preferredBackend") or classify_path(str(p))

        # MXF files may be ARRIRAW-wrapped — probe codec before routing.
        # classify_path() maps .mxf → standard_media (generic), but ARRIRAW MXF
        # must go to ArriBackend because ffmpeg cannot decode the arriraw codec.
        if Path(str(p)).suffix.lower() == ".mxf" and preferred == Backend.STANDARD_MEDIA:
            arri_b = self._backends.get(Backend.ARRI_SDK)
            if arri_b is not None and hasattr(arri_b, "probe_mxf_codec"):
                try:
                    codec = arri_b.probe_mxf_codec(str(p))
                    if codec == "arriraw":
                        preferred = Backend.ARRI_SDK
                except Exception:
                    pass

        statuses  = get_backend_statuses(self._backends)
        chosen    = select_backend(str(p), preferred, statuses)

        backend = self._backends.get(chosen) or self._backends[Backend.STANDARD_MEDIA]
        if not backend.can_open(str(p)):
            backend = self._backends[Backend.STANDARD_MEDIA]

        try:
            result = backend.open(str(p), options)
        except Exception as exc:
            return _err(ErrorCode.FILE_OPEN_FAILED, f"{chosen} open failed: {exc}")

        session_id = new_session_id()
        can_play   = bool(result.get("canPlay", False))

        # Register the file with the HTTP server so tabs can stream it
        stream_url = ""
        if self._http_port and self._register_asset and can_play:
            try:
                self._register_asset(session_id, str(p))
                stream_url = f"http://127.0.0.1:{self._http_port}/file/{session_id}"
            except Exception:
                stream_url = ""

        create_media_session(session_id, {
            "filePath":     str(p),
            "fileType":     result.get("fileType", ""),
            "backend":      chosen,
            "canPlay":      can_play,
            "capabilities": result.get("capabilities", {}),
            "metadata":     result.get("metadata", {}),
            "cacheState":   "ready",
            "_handle":      result.get("sessionHandle"),
            "_streamUrl":   stream_url,
        })

        return {
            "ok":       True,
            "sessionId": session_id,
            "backend":   chosen,
            "fileType":  result.get("fileType", ""),
            "codec":     result.get("metadata", {}).get("codec", ""),
            "canPlay":   can_play,
            "streamUrl": stream_url,
            "metadata":  result.get("metadata", {}),
            "capabilities": result.get("capabilities", {}),
            # Compat: existing code that uses assetId
            "assetId":   session_id,
            "fps":           result.get("metadata", {}).get("fps"),
            "startTimecode": result.get("metadata", {}).get("timecodeStart", ""),
            "width":           result.get("metadata", {}).get("width", 0),
            "height":          result.get("metadata", {}).get("height", 0),
            "framesDecodable": result.get("framesDecodable", True),
        }

    # ── close_file ────────────────────────────────────────────────────────────
    def close_file(self, session_id: str) -> dict[str, Any]:
        s = get_media_session(session_id)
        if not s:
            return {"ok": True, "note": "session already closed"}
        backend = self._backends.get(s.get("backend") or "")
        if backend:
            try: backend.close(s.get("_handle"))
            except: pass
        # Phase 7: cancel prefetch and evict session frames from cache
        self._prefetch.cancel(session_id)
        self._cache.evict_session(session_id)
        close_media_session(session_id)
        return {"ok": True, "sessionId": session_id}

    # ── get_metadata ──────────────────────────────────────────────────────────
    def get_metadata(self, session_id: str) -> dict[str, Any]:
        s = get_media_session(session_id)
        if not s:
            return _err(ErrorCode.SESSION_NOT_FOUND, f"No session: {session_id}")
        if s.get("metadata"):
            return {"ok": True, "sessionId": session_id, **s["metadata"]}
        backend = self._backends.get(s.get("backend") or "")
        if not backend:
            return _err(ErrorCode.BACKEND_NOT_AVAILABLE, "Backend not found")
        try:
            meta = backend.get_metadata(s.get("_handle"))
            update_media_session(session_id, {"metadata": meta})
            return {"ok": True, "sessionId": session_id, **meta}
        except Exception as exc:
            return _err(ErrorCode.DECODE_FAILED, f"get_metadata failed: {exc}")

    # ── get_frame ─────────────────────────────────────────────────────────────
    def get_frame(self, session_id: str, frame_index: int, options: dict) -> dict[str, Any]:
        s = get_media_session(session_id)
        if not s:
            return _err(ErrorCode.SESSION_NOT_FOUND, f"No session: {session_id}")
        backend = self._backends.get(s.get("backend") or "")
        if not backend:
            return _err(ErrorCode.BACKEND_NOT_AVAILABLE, "Backend not found")

        # ── Phase 7: check shared LRU cache first ─────────────────────────────
        quality = options.get("quality", "half")
        width   = int(options.get("width",  1280))
        height  = int(options.get("height",  720))
        fmt     = options.get("format", "jpg")
        cache_key = self._cache.make_key(session_id, frame_index, quality, width, height, fmt)
        cached_path = self._cache.get(cache_key)
        if cached_path:
            import base64
            mime = "image/jpeg" if fmt == "jpg" else "image/png"
            with open(str(cached_path), "rb") as f:
                data_url = f"data:{mime};base64,{base64.b64encode(f.read()).decode()}"
            return {
                "ok": True, "sessionId": session_id,
                "previewImagePath": str(cached_path),
                "dataUrl":          data_url,
                "width":  width, "height": height,
                "frameIndex": frame_index,
                "backend":    s.get("backend", ""),
                "cacheHit":   True,
            }

        # ── Decode and store in cache ─────────────────────────────────────────
        try:
            result = backend.get_frame(s.get("_handle"), frame_index, options)
        except Exception as exc:
            return _err(ErrorCode.DECODE_FAILED, f"get_frame failed: {exc}")

        # Write result to shared cache
        data_url = result.get("dataUrl", "")
        if data_url and data_url.startswith("data:"):
            try:
                import base64 as _b64
                _, b64 = data_url.split(",", 1)
                data = _b64.b64decode(b64)
                self._cache.put(cache_key, data, session_id=session_id, fmt=fmt)
                result["cacheHit"] = False
            except Exception:
                pass

        # ── Phase 7: kick off prefetch for next N frames ──────────────────────
        try:
            self._prefetch.prefetch(
                session_id   = session_id,
                current_frame = frame_index,
                backend      = backend,
                cache        = self._cache,
                options      = {"quality": quality, "width": width, "height": height, "format": fmt},
                count        = _PREFETCH_COUNT,
                direction    = +1,
                handle       = s.get("_handle"),
            )
        except Exception:
            pass

        return {"ok": True, "sessionId": session_id, **result}

    # ── seek_frame ────────────────────────────────────────────────────────────
    def seek_frame(self, session_id: str, frame_index: int) -> dict[str, Any]:
        s = get_media_session(session_id)
        if not s:
            return _err(ErrorCode.SESSION_NOT_FOUND, f"No session: {session_id}")
        backend = self._backends.get(s.get("backend") or "")
        if not backend:
            return _err(ErrorCode.BACKEND_NOT_AVAILABLE, "Backend not found")
        try:
            result = backend.seek(s.get("_handle"), frame_index)
            return {"ok": True, "sessionId": session_id, **result}
        except Exception as exc:
            return _err(ErrorCode.DECODE_FAILED, f"seek failed: {exc}")

    # ── get_backend_status ────────────────────────────────────────────────────
    def get_backend_status(self) -> dict[str, Any]:
        statuses = get_backend_statuses(self._backends)
        diag     = build_diagnostics(statuses, self._version, self._platform)
        return {"ok": True, **diag}

    # ── prefetch_frames ────────────────────────────────────────────────────────
    def prefetch_frames(self, session_id: str, current_frame: int,
                        options: dict, count: int = _PREFETCH_COUNT,
                        direction: int = 1) -> dict[str, Any]:
        """
        Phase 7: kick off background decode of `count` frames starting at
        current_frame + direction.  Returns immediately; frames appear in cache
        as they are decoded.
        """
        s = get_media_session(session_id)
        if not s:
            return _err(ErrorCode.SESSION_NOT_FOUND, f"No session: {session_id}")
        backend = self._backends.get(s.get("backend") or "")
        if not backend:
            return _err(ErrorCode.BACKEND_NOT_AVAILABLE, "Backend not found")

        # Cancel stale prefetch first (direction change / big jump)
        self._prefetch.cancel(session_id)

        self._prefetch.prefetch(
            session_id    = session_id,
            current_frame = current_frame,
            backend       = backend,
            cache         = self._cache,
            options       = options,
            count         = count,
            direction     = direction,
            handle        = s.get("_handle"),
        )
        return {
            "ok":        True,
            "sessionId": session_id,
            "queued":    count,
            "direction": direction,
        }

    # ── cache_stats ────────────────────────────────────────────────────────────
    def cache_stats(self) -> dict[str, Any]:
        """Phase 7: return LRU cache and prefetch scheduler statistics."""
        return {
            "ok":      True,
            "cache":   self._cache.stats(),
            "prefetch": self._prefetch.stats(),
        }

    # ── clear_cache ────────────────────────────────────────────────────────────
    def clear_cache(self, session_id: str | None = None) -> dict[str, Any]:
        """Phase 7: evict cached frames for a session or all sessions."""
        if session_id:
            self._prefetch.cancel(session_id)
            removed = self._cache.evict_session(session_id)
        else:
            removed = self._cache.clear()
        return {"ok": True, "removed": removed}

    # ── list_sessions ─────────────────────────────────────────────────────────
    def list_sessions(self) -> dict[str, Any]:
        sessions = [
            {"sessionId": s["sessionId"], "filePath": s["filePath"],
             "backend": s["backend"], "cacheState": s["cacheState"]}
            for s in list_media_sessions()
        ]
        return {"ok": True, "sessions": sessions, "count": len(sessions)}


def _err(code: str, message: str) -> dict[str, Any]:
    return {"ok": False, "error": {"code": code, "message": message}}
