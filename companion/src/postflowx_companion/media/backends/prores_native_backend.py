"""Apple ProRes native backend — AVFoundation bridge (macOS only).

Fallback when standard_media ffmpeg path is insufficient.
Phase 1: metadata + still-frame decode via avfoundation through ffmpeg -hwaccel videotoolbox.
Phase 2: swap for native AVAssetReader C extension when needed.
"""
from __future__ import annotations

import platform
import subprocess
import tempfile
import os
from pathlib import Path
from typing import Any

from ..media_types import Backend, BackendStatus
from .base_backend import BaseMediaBackend


_PRORES_CODECS = frozenset({
    "prores", "prores_ks", "prores_aw", "apple prores",
})


class ProResNativeBackend(BaseMediaBackend):
    """
    macOS-only ProRes native decode via VideoToolbox (ffmpeg -hwaccel videotoolbox).
    On non-macOS or when ffmpeg is missing: reports sdk_missing status.
    """

    def __init__(self, ffmpeg_path: str | None = None, cache_dir: Path | None = None):
        self._ffmpeg = ffmpeg_path
        self._cache  = cache_dir or Path(tempfile.gettempdir()) / "pfx_prores_frames"
        self._cache.mkdir(parents=True, exist_ok=True)

    @property
    def backend_key(self) -> str:
        return Backend.PRORES_NATIVE

    def can_open(self, path: str) -> bool:
        ext = Path(path).suffix.lower()
        return ext == ".mov" and platform.system() == "Darwin" and bool(self._ffmpeg)

    def open(self, path: str, options: dict) -> dict[str, Any]:
        if not self.can_open(path):
            raise RuntimeError("ProRes native backend not available on this platform/config")
        caps = self.get_capabilities()
        return {
            "sessionHandle": path,
            "fileType":      "prores",
            "metadata":      {"codec": "prores", "path": path},
            "capabilities":  caps,
        }

    def close(self, session_handle: Any) -> None:
        pass  # stateless

    def get_metadata(self, session_handle: Any) -> dict[str, Any]:
        # Delegate to ffmpeg probe
        from .standard_media_backend import StandardMediaBackend
        _std = StandardMediaBackend(ffmpeg_path=self._ffmpeg)
        return _std._probe(str(session_handle))

    def get_frame(self, session_handle: Any, frame_index: int, options: dict) -> dict[str, Any]:
        if not self._ffmpeg or platform.system() != "Darwin":
            raise RuntimeError("ProRes native backend unavailable")
        path   = str(session_handle)
        fmt    = options.get("format", "jpg")
        width  = int(options.get("width",  1280))
        height = int(options.get("height",  720))

        from .standard_media_backend import StandardMediaBackend
        _std = StandardMediaBackend(ffmpeg_path=self._ffmpeg)
        meta = _std._probe(path)
        fps  = float(meta.get("fps", 24.0))
        seek_s = frame_index / max(1.0, fps)

        import hashlib, base64
        cache_key = hashlib.sha256(f"prores:{path}:{frame_index}:{width}:{height}:{fmt}".encode()).hexdigest()
        out_path  = self._cache / f"{cache_key}.{fmt}"

        if not (out_path.is_file() and out_path.stat().st_size > 0):
            vf = (
                f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
            )
            tmp_fd, tmp_path = tempfile.mkstemp(suffix=f".{fmt}", dir=str(self._cache))
            os.close(tmp_fd)
            try:
                cmd = [
                    self._ffmpeg, "-y",
                    "-hwaccel", "videotoolbox",    # macOS VideoToolbox acceleration
                    "-ss", f"{seek_s:.6f}",
                    "-i", path,
                    "-vframes", "1",
                    "-vf", vf,
                    "-f", "mjpeg" if fmt == "jpg" else "png",
                    tmp_path,
                ]
                result = subprocess.run(cmd, capture_output=True, timeout=60)
                if result.returncode != 0:
                    raise RuntimeError(f"VideoToolbox decode failed: {result.stderr[-256:].decode(errors='replace')}")
                os.replace(tmp_path, str(out_path))
                tmp_path = None
            finally:
                if tmp_path:
                    try: Path(tmp_path).unlink(missing_ok=True)
                    except: pass

        mime = "image/jpeg" if fmt == "jpg" else "image/png"
        with open(str(out_path), "rb") as f:
            data_url = f"data:{mime};base64,{base64.b64encode(f.read()).decode()}"

        return {
            "previewImagePath": str(out_path),
            "dataUrl":          data_url,
            "width":            width,
            "height":           height,
            "frameIndex":       frame_index,
            "backend":          self.backend_key,
        }

    def seek(self, session_handle: Any, frame_index: int) -> dict[str, Any]:
        return {"seeked": True, "frameIndex": frame_index}

    def get_capabilities(self) -> dict[str, Any]:
        ok = platform.system() == "Darwin" and bool(self._ffmpeg)
        return {
            "supportsMetadata":             ok,
            "supportsStillFrameDecode":     ok,
            "supportsPlayback":             False,
            "supportsHalfRes":              ok,
            "supportsQuarterRes":           ok,
            "supportsHardwareAcceleration": ok,
        }

    def get_status(self) -> dict[str, Any]:
        if platform.system() != "Darwin":
            return {"status": BackendStatus.NOT_INSTALLED, "decodeMode": "none",
                    "version": None, "lastError": "macOS only"}
        if not self._ffmpeg:
            return {"status": BackendStatus.SDK_MISSING, "decodeMode": "none",
                    "version": None, "lastError": "ffmpeg not found"}
        return {"status": BackendStatus.READY, "decodeMode": "full",
                "version": "videotoolbox", "lastError": None}
