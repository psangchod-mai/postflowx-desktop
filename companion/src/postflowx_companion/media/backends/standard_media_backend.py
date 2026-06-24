"""Standard media backend — uses ffprobe (metadata) + ffmpeg (frames).

Handles: MP4, MOV (including Apple ProRes via ffmpeg), MXF, WebM, MKV.
Apple ProRes: ffmpeg on macOS decodes ProRes natively via VideoToolbox.
This is the first-class ProRes path; prores_native_backend is the fallback.
"""
from __future__ import annotations

import hashlib
import os
import platform
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from ..media_types import Backend, BackendStatus, DecodeQuality
from .base_backend import BaseMediaBackend


_SUPPORTED_EXT = frozenset({
    ".mp4", ".m4v", ".mov", ".mxf", ".webm", ".mkv", ".avi",
})

# ProRes codec names as reported by ffprobe
_PRORES_CODECS = frozenset({
    "prores", "prores_ks", "prores_aw", "prores_lt", "prores_proxy",
})

# Codecs that ffprobe can identify but ffmpeg cannot decode to frames.
# These require native SDK backends (ArriBackend, BrawBackend, R3dBackend).
# StandardMediaBackend must reject get_frame for these rather than letting
# ffmpeg fail with "Output file does not contain any stream".
_FFMPEG_UNDECODABLE = frozenset({
    "arriraw",                         # ARRIRAW MXF — needs ArriBackend
    "braw", "blackmagic_raw",          # BRAW — needs BrawBackend
    "r3d", "redcode", "redcode_raw",   # RED R3D — needs R3dBackend
    "nred", "nred2",                   # Sony X-OCN variants
})

# On macOS, Chrome uses VideoToolbox which can decode ProRes natively in <video>
def _is_prores_native_playable(codec: str) -> bool:
    """True when the browser can decode this codec via VideoToolbox on macOS."""
    return codec.lower() in _PRORES_CODECS and platform.system() == "Darwin"

# Quality → scale filter
_QUALITY_SCALE = {
    DecodeQuality.FULL:    None,      # no scale
    DecodeQuality.HALF:    "iw/2:ih/2",
    DecodeQuality.QUARTER: "iw/4:ih/4",
}


class StandardMediaBackend(BaseMediaBackend):
    """ffprobe + ffmpeg backend — the default path for all common formats."""

    def __init__(self, ffmpeg_path: str | None = None, ffprobe_path: str | None = None,
                 thumb_cache_dir: Path | None = None):
        self._ffmpeg  = ffmpeg_path
        self._ffprobe = ffprobe_path
        self._cache   = thumb_cache_dir or Path(tempfile.gettempdir()) / "pfx_media_frames"
        self._cache.mkdir(parents=True, exist_ok=True)

    @property
    def backend_key(self) -> str:
        return Backend.STANDARD_MEDIA

    def can_open(self, path: str) -> bool:
        return Path(path).suffix.lower() in _SUPPORTED_EXT

    def open(self, path: str, options: dict) -> dict[str, Any]:
        if not Path(path).is_file():
            raise FileNotFoundError(f"File not found: {path}")
        if not self.can_open(path):
            raise ValueError(f"Unsupported extension: {Path(path).suffix}")
        meta = self._probe(path)
        caps = self.get_capabilities()
        codec   = meta.get("codec", "unknown").lower()
        pix_fmt = meta.get("pixFmt", "")
        is_mxf  = Path(path).suffix.lower() == ".mxf"

        # High-bit-depth pixel formats Chrome cannot decode in <video> even for H.264/HEVC
        _HIGH_BIT = {
            "yuv420p10le","yuv420p10be","yuv420p12le",
            "yuv422p10le","yuv422p10be","yuv422p12le",
            "yuv444p10le","yuv444p10be","yuv444p12le","yuv444p12be",
            "gbrp10le","gbrp12le","gbrp14le",
        }
        high_bit    = pix_fmt in _HIGH_BIT
        is_h264_avc = codec in {"h264", "avc", "avc1", "hevc", "h265"}

        # canPlay rules:
        #  • MXF container → never browser-playable (Content-Type: application/mxf)
        #  • ProRes in MOV → VideoToolbox on macOS (all variants incl. 4444 XQ)
        #  • H.264/HEVC 8-bit → browser H/W decode
        #  • H.264/HEVC 10-bit → not browser-decodable (Chrome only supports 8-bit)
        #  • VP8/VP9/AV1 → browser decode
        can_play = (
            not is_mxf
            and (
                _is_prores_native_playable(codec)
                or (is_h264_avc and not high_bit)
                or codec in {"vp8", "vp9", "av1", "mp4v"}
            )
        )

        # framesDecodable: ffmpeg can extract still frames when codec is recognised
        # and is not a native-SDK-only codec (arriraw, braw, r3d, etc.)
        frames_decodable = codec not in ("unknown", "none", "") and codec not in _FFMPEG_UNDECODABLE

        return {
            "sessionHandle":   path,
            "fileType":        meta.get("codec", "unknown"),
            "canPlay":         can_play,
            "framesDecodable": frames_decodable,
            "metadata":        meta,
            "capabilities":    caps,
        }

    def close(self, session_handle: Any) -> None:
        pass  # stateless — nothing to release

    def get_metadata(self, session_handle: Any) -> dict[str, Any]:
        return self._probe(str(session_handle))

    def get_frame(self, session_handle: Any, frame_index: int, options: dict) -> dict[str, Any]:
        if not self._ffmpeg:
            raise RuntimeError("ffmpeg not available")
        path = str(session_handle)
        if not path:
            raise ValueError("get_frame: inputPath (session_handle) is empty — cannot decode")

        quality = options.get("quality", DecodeQuality.HALF)
        fmt     = options.get("format", "jpg")
        width   = int(options.get("width",  1280))
        height  = int(options.get("height",  720))

        meta    = self._probe(path)
        fps     = float(meta.get("fps", 24.0))

        # Reject codecs that ffmpeg cannot decode — these require native SDK backends.
        codec = meta.get("codec", "").lower()
        if codec in _FFMPEG_UNDECODABLE:
            raise RuntimeError(
                f"codec '{codec}' cannot be decoded by ffmpeg — "
                f"use a native SDK backend (ArriBackend / BrawBackend / R3dBackend)"
            )
        if codec in ("unknown", "none", "") or not meta.get("width"):
            raise RuntimeError(
                f"no decodable video stream found in '{Path(path).name}' "
                f"(codec='{codec}') — cannot extract frames"
            )
        seek_s  = frame_index / max(1.0, fps)

        # Cache key
        cache_key = hashlib.sha256(
            f"{path}:{frame_index}:{quality}:{width}:{height}:{fmt}".encode()
        ).hexdigest()
        out_path  = self._cache / f"{cache_key}.{fmt}"

        if not (out_path.is_file() and out_path.stat().st_size > 0):
            scale_filter = _QUALITY_SCALE.get(quality, None)
            vf_parts = [
                f"scale={width}:{height}:force_original_aspect_ratio=decrease",
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
            ]
            if scale_filter:
                vf_parts.insert(0, f"scale={scale_filter}")
            vf = ",".join(vf_parts)

            tmp_fd, tmp_path = tempfile.mkstemp(suffix=f".{fmt}", dir=str(self._cache))
            os.close(tmp_fd)
            try:
                cmd = [
                    self._ffmpeg, "-y",
                    "-ss", f"{seek_s:.6f}",
                    "-i", path,
                    "-vframes", "1",
                    "-vf", vf,
                    "-f", "mjpeg" if fmt == "jpg" else "png",
                    tmp_path,
                ]
                result = subprocess.run(cmd, capture_output=True, timeout=60)
                if result.returncode != 0:
                    raise RuntimeError(f"ffmpeg error: {result.stderr[-256:].decode(errors='replace')}")
                os.replace(tmp_path, str(out_path))
                tmp_path = None
            finally:
                if tmp_path:
                    try: Path(tmp_path).unlink(missing_ok=True)
                    except: pass

        import base64
        mime = "image/jpeg" if fmt == "jpg" else "image/png"
        with open(str(out_path), "rb") as f:
            data_url = f"data:{mime};base64,{base64.b64encode(f.read()).decode()}"

        return {
            "previewImagePath": str(out_path),
            "dataUrl":          data_url,
            "width":            width,
            "height":           height,
            "frameIndex":       frame_index,
            "timecode":         _frames_to_tc(frame_index, fps),
            "backend":          self.backend_key,
            "cacheHit":         False,
        }

    def seek(self, session_handle: Any, frame_index: int) -> dict[str, Any]:
        # Stateless backend — seek is a no-op; frame is fetched on get_frame
        return {"seeked": True, "frameIndex": frame_index}

    def get_capabilities(self) -> dict[str, Any]:
        return {
            "supportsMetadata":             bool(self._ffprobe),
            "supportsStillFrameDecode":     bool(self._ffmpeg),
            "supportsPlayback":             False,
            "supportsHalfRes":              True,
            "supportsQuarterRes":           True,
            "supportsHardwareAcceleration": platform.system() == "Darwin",
        }

    def get_status(self) -> dict[str, Any]:
        if self._ffmpeg and self._ffprobe:
            status = BackendStatus.READY
            mode   = "full"
        elif self._ffprobe:
            status = BackendStatus.METADATA_ONLY
            mode   = "metadata"
        elif self._ffmpeg:
            status = BackendStatus.PREVIEW_ONLY
            mode   = "preview"
        else:
            status = BackendStatus.UNAVAILABLE
            mode   = "none"
        return {"status": status, "decodeMode": mode, "version": None, "lastError": None}

    # ── internal ─────────────────────────────────────────────────────────────
    def _probe(self, path: str) -> dict[str, Any]:
        if not self._ffprobe:
            return {"codec": "unknown", "fps": 24.0}
        try:
            import json as _json
            cmd = [
                self._ffprobe, "-v", "quiet", "-print_format", "json",
                "-show_streams", "-show_format", path,
            ]
            out = subprocess.check_output(cmd, timeout=15, stderr=subprocess.DEVNULL)
            data = _json.loads(out)
        except Exception:
            return {"codec": "unknown", "fps": 24.0, "path": path}

        vid = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
        fmt = data.get("format", {})

        # FPS
        fps_raw = vid.get("r_frame_rate", "24/1")
        try:
            a, b = fps_raw.split("/")
            fps = float(a) / float(b) if float(b) else 24.0
        except Exception:
            fps = 24.0

        # Duration
        dur = float(vid.get("duration") or fmt.get("duration") or 0)
        frame_count = int(vid.get("nb_frames") or 0) or int(round(dur * fps))

        # Start timecode — check video stream tags, then format tags, then tmcd track.
        # QuickTime/ProRes MOVs store timecode in a separate tmcd data stream, not in
        # the video stream's tags. ffprobe exposes it under that stream's tags.
        tc_start = ""
        for tag_key in ("timecode", "Timecode", "time_code"):
            tc_start = vid.get("tags", {}).get(tag_key) or fmt.get("tags", {}).get(tag_key) or ""
            if tc_start:
                break
        if not tc_start:
            for s in data.get("streams", []):
                if s.get("codec_tag_string") == "tmcd" or s.get("codec_name") == "tmcd":
                    for tag_key in ("timecode", "Timecode", "time_code"):
                        tc_start = s.get("tags", {}).get(tag_key, "")
                        if tc_start:
                            break
                if tc_start:
                    break

        codec = vid.get("codec_name", "unknown")
        pix_fmt = vid.get("pix_fmt", "")

        return {
            "fileType":       codec,
            "codec":          codec,
            "pixFmt":         pix_fmt,
            "width":          int(vid.get("width", 0)),
            "height":         int(vid.get("height", 0)),
            "fps":            round(fps, 3),
            "durationFrames": frame_count,
            "durationSec":    round(dur, 3),
            "timecodeStart":  tc_start,
            "clipName":       Path(path).stem,
            "camera":         vid.get("tags", {}).get("encoder", ""),
            "decodeModes":    ["full", "half", "quarter"],
            "colorSpace":     vid.get("color_space", ""),
            "colorTransfer":  vid.get("color_transfer", ""),
        }


def _frames_to_tc(frames: int, fps: float) -> str:
    fps = max(1.0, fps)
    ff  = frames % int(fps)
    s   = (frames // int(fps)) % 60
    m   = (frames // int(fps) // 60) % 60
    h   = frames // int(fps) // 3600
    return f"{h:02d}:{m:02d}:{s:02d}:{ff:02d}"
