"""ProRes RAW backend — Apple ProRes RAW / ProRes RAW HQ (Phase 5).

ProRes RAW is Apple's camera-raw codec embedded in a QuickTime .mov container.
Introduced in 2018, supported by:
  - macOS 10.13.6+ via VideoToolbox (AVFoundation / CoreMedia)
  - FFmpeg 4.0+ with built-in prores_raw decoder (software decode)
  - Final Cut Pro, DaVinci Resolve 17+

Detection hierarchy:
  1. ffmpeg prores_raw decoder (built-in, no install needed on modern macOS builds)
     → READY on macOS, PREVIEW_ONLY on other platforms with software decode
  2. VideoToolbox hardware acceleration (macOS only, better quality)
  3. Neither available → NOT_INSTALLED with clear message

Codec identification:
  - ffprobe reports codec_name = 'prores_raw' or 'prores_raw_hq' for the video stream
  - The mediaBackendRegistry routes .mov files here when codec hint is present
  - Can also be triggered by explicit preferredBackend='prores_raw_native'

Phase 5 deliverables (per handoff spec):
  ✓ Capability detection
  ✓ Metadata where possible
  ✓ Preview decode where supported
  ✓ Clear unsupported state if unavailable
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from ..media_types import Backend, BackendStatus
from .base_backend import BaseMediaBackend

# ProRes RAW codec names as reported by ffprobe
_PRORES_RAW_CODECS = frozenset({"prores_raw", "prores_raw_hq"})

# Minimum macOS version for full VideoToolbox ProRes RAW support
_MIN_MACOS_MAJOR = 10
_MIN_MACOS_MINOR = 13

# ---------------------------------------------------------------------------
# Capability probing (done once at init)
# ---------------------------------------------------------------------------

def _probe_capabilities(ffmpeg: str | None, ffprobe: str | None) -> dict[str, Any]:
    """Detect what ProRes RAW capabilities are available."""
    caps: dict[str, Any] = {
        "ffmpegProResRaw":  False,
        "videoToolbox":     False,
        "macos":            platform.system() == "Darwin",
        "macosVersion":     platform.mac_ver()[0] if platform.system() == "Darwin" else "",
        "macosVersionOk":   False,
        "ffmpegPath":       ffmpeg,
        "ffprobePath":      ffprobe,
    }

    # macOS version check
    if caps["macos"] and caps["macosVersion"]:
        try:
            parts = [int(x) for x in caps["macosVersion"].split(".")[:2]]
            major, minor = (parts + [0])[:2]
            caps["macosVersionOk"] = (major > _MIN_MACOS_MAJOR) or (
                major == _MIN_MACOS_MAJOR and minor >= _MIN_MACOS_MINOR
            )
        except Exception:
            caps["macosVersionOk"] = True  # assume OK on unknown version

    # ffmpeg prores_raw decoder check
    if ffmpeg:
        try:
            r = subprocess.run(
                [ffmpeg, "-decoders"],
                capture_output=True, text=True, timeout=5
            )
            caps["ffmpegProResRaw"] = "prores_raw" in r.stdout.lower()
        except Exception:
            pass

    # VideoToolbox availability check (macOS only)
    if caps["macos"] and ffmpeg:
        try:
            r = subprocess.run(
                [ffmpeg, "-hwaccels"],
                capture_output=True, text=True, timeout=5
            )
            caps["videoToolbox"] = "videotoolbox" in r.stdout.lower()
        except Exception:
            pass

    return caps


def _is_prores_raw_file(path: str, ffprobe: str | None) -> bool:
    """Return True when ffprobe identifies this file as ProRes RAW."""
    if not ffprobe or not Path(path).is_file():
        return False
    try:
        out = subprocess.check_output(
            [ffprobe, "-v", "quiet", "-print_format", "json", "-show_streams", path],
            timeout=10, stderr=subprocess.DEVNULL
        )
        data = json.loads(out)
        for stream in data.get("streams", []):
            if stream.get("codec_name", "").lower() in _PRORES_RAW_CODECS:
                return True
    except Exception:
        pass
    return False


# ---------------------------------------------------------------------------
# ProResRawBackend
# ---------------------------------------------------------------------------

class ProResRawBackend(BaseMediaBackend):
    """
    Apple ProRes RAW backend — Phase 5.

    Status by configuration:
      macOS + ffmpeg prores_raw decoder   → READY (full metadata + frame decode)
      Other platform + ffmpeg prores_raw  → PREVIEW_ONLY (software decode, lower quality)
      No ffmpeg prores_raw support        → NOT_INSTALLED (clear user message)
    """

    def __init__(self, ffmpeg_path: str | None = None, ffprobe_path: str | None = None,
                 cache_dir: Path | None = None):
        import shutil
        # Bundled ffmpeg/ffprobe (Dev Brief P0#2) win over PATH: a GUI-launched
        # companion has a stripped PATH and no /opt/homebrew.
        def _bin(n):
            try:
                from ...proxy_service import _resource_bin
                return _resource_bin(n) or shutil.which(n)
            except Exception:
                return shutil.which(n)
        self._ffmpeg  = ffmpeg_path  or _bin("ffmpeg")
        self._ffprobe = ffprobe_path or _bin("ffprobe")
        self._cache   = cache_dir or Path(tempfile.gettempdir()) / "pfx_prores_raw_frames"
        self._cache.mkdir(parents=True, exist_ok=True)
        self._caps    = _probe_capabilities(self._ffmpeg, self._ffprobe)

    # ── Properties ────────────────────────────────────────────────────────────

    @property
    def _decode_ready(self) -> bool:
        return self._caps["ffmpegProResRaw"]

    @property
    def _hw_accel(self) -> bool:
        return self._caps["videoToolbox"] and self._caps["macos"]

    # ── BaseMediaBackend interface ─────────────────────────────────────────────

    @property
    def backend_key(self) -> str:
        return Backend.PRORES_RAW_NATIVE

    def can_open(self, path: str) -> bool:
        ext = Path(path).suffix.lower()
        if ext != ".mov":
            return False
        if not self._caps["ffmpegProResRaw"]:
            return False
        # If ffprobe is available, verify the codec is actually ProRes RAW
        if self._ffprobe and Path(path).is_file():
            return _is_prores_raw_file(path, self._ffprobe)
        # Without ffprobe, accept .mov and let open() fail gracefully
        return True

    def open(self, path: str, options: dict) -> dict[str, Any]:
        if not self._decode_ready:
            raise RuntimeError(
                "ProRes RAW decode not available — "
                "install ffmpeg with prores_raw decoder or use macOS 10.13.6+"
            )
        if not Path(path).is_file():
            raise FileNotFoundError(f"File not found: {path}")

        meta = self._get_metadata_impl(path)
        codec = meta.get("codec", "")
        if self._ffprobe and codec and codec.lower() not in _PRORES_RAW_CODECS | {"unknown", ""}:
            # File is a .mov but not ProRes RAW — refuse gracefully
            raise ValueError(
                f"File codec is '{codec}', not ProRes RAW — "
                "route through standard_media or prores_native instead"
            )

        # On macOS: Chrome can play ProRes RAW natively via VideoToolbox in <video>
        # Report canPlay:True so the tab can stream without proxy transcode
        can_play = self._caps["macos"] and self._caps["macosVersionOk"]

        caps = self.get_capabilities()
        return {
            "sessionHandle": path,
            "fileType":      "prores_raw",
            "canPlay":       can_play,
            "metadata":      meta,
            "capabilities":  caps,
        }

    def close(self, session_handle: Any) -> None:
        pass  # stateless

    def get_metadata(self, session_handle: Any) -> dict[str, Any]:
        if not self._ffprobe and not self._ffmpeg:
            raise RuntimeError("ProRes RAW backend: no metadata capability")
        return self._get_metadata_impl(str(session_handle))

    def get_frame(self, session_handle: Any, frame_index: int, options: dict) -> dict[str, Any]:
        if not self._decode_ready:
            raise RuntimeError("ProRes RAW frame decode requires ffmpeg with prores_raw decoder")
        path   = str(session_handle)
        fmt    = options.get("format", "jpg")
        width  = int(options.get("width",  1920))
        height = int(options.get("height", 1080))

        meta  = self._get_metadata_impl(path)
        fps   = float(meta.get("fps", 24.0))
        seek_s = frame_index / max(1.0, fps)

        cache_key = hashlib.sha256(
            f"prores_raw:{path}:{frame_index}:{width}:{height}:{fmt}".encode()
        ).hexdigest()
        out_path = self._cache / f"{cache_key}.{fmt}"

        if not (out_path.is_file() and out_path.stat().st_size > 0):
            self._decode_frame(path, seek_s, out_path, fmt, width, height)

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
            "backend":          self.backend_key,
            "hwAccel":          self._hw_accel,
        }

    def seek(self, session_handle: Any, frame_index: int) -> dict[str, Any]:
        return {"seeked": True, "frameIndex": frame_index}

    def get_capabilities(self) -> dict[str, Any]:
        return {
            "supportsMetadata":             bool(self._ffprobe or self._ffmpeg),
            "supportsStillFrameDecode":     self._decode_ready,
            "supportsPlayback":             False,
            "supportsHalfRes":              self._decode_ready,
            "supportsQuarterRes":           self._decode_ready,
            "supportsHardwareAcceleration": self._hw_accel,
            # ProRes RAW specific
            "proResRawDecoder":   self._caps["ffmpegProResRaw"],
            "videoToolbox":       self._caps["videoToolbox"],
            "nativePlayback":     self._caps["macos"] and self._caps["macosVersionOk"],
        }

    def get_status(self) -> dict[str, Any]:
        if not self._caps["ffmpegProResRaw"]:
            if not self._caps["macos"]:
                msg = "ProRes RAW is macOS-only — not supported on this platform"
                status = BackendStatus.NOT_INSTALLED
            else:
                msg = "ffmpeg prores_raw decoder not available — install ffmpeg 4.0+"
                status = BackendStatus.SDK_MISSING
            return {"status": status, "decodeMode": "none", "version": None, "lastError": msg}

        version_parts = ["ffmpeg_prores_raw"]
        if self._hw_accel:
            version_parts.append("videotoolbox")
        if self._caps["macos"] and self._caps["macosVersionOk"]:
            status = BackendStatus.READY
            mode   = "full"
        elif self._decode_ready:
            status = BackendStatus.PREVIEW_ONLY
            mode   = "software"
        else:
            status = BackendStatus.UNAVAILABLE
            mode   = "none"

        return {
            "status":     status,
            "decodeMode": mode,
            "version":    "+".join(version_parts),
            "lastError":  None,
        }

    # ── Internal ──────────────────────────────────────────────────────────────

    def _get_metadata_impl(self, path: str) -> dict[str, Any]:
        """Read ProRes RAW metadata via ffprobe."""
        base: dict[str, Any] = {
            "fileType":       "prores_raw",
            "codec":          "prores_raw",
            "clipName":       Path(path).stem,
            "decodeModes":    ["full", "half", "quarter"],
            "colorPrimaries": "p3_d65",   # ProRes RAW default color space
            "colorTransfer":  "linear",
        }
        if not self._ffprobe:
            return base

        try:
            out = subprocess.check_output(
                [self._ffprobe, "-v", "quiet", "-print_format", "json",
                 "-show_streams", "-show_format", path],
                timeout=15, stderr=subprocess.DEVNULL
            )
            data = json.loads(out)
        except Exception:
            return base

        vid = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
        fmt = data.get("format", {})

        # Frame rate
        fps_raw = vid.get("r_frame_rate") or "24/1"
        try:
            a, b = fps_raw.split("/")
            fps = round(float(a) / max(float(b), 1), 3)
        except Exception:
            fps = 24.0

        dur = float(vid.get("duration") or fmt.get("duration") or 0)
        n   = int(vid.get("nb_frames") or 0) or int(round(dur * fps))

        # Timecode
        tc = ""
        for k in ("timecode", "Timecode", "time_code"):
            tc = (vid.get("tags") or {}).get(k, "") or (fmt.get("tags") or {}).get(k, "")
            if tc:
                break

        # Color info
        cp  = vid.get("color_primaries", "")
        ct  = vid.get("color_transfer",  "")
        cs  = vid.get("color_space",     "")
        pix = vid.get("pix_fmt",         "")

        base.update({
            "codec":          vid.get("codec_name", "prores_raw"),
            "width":          int(vid.get("width",  0)),
            "height":         int(vid.get("height", 0)),
            "fps":            fps,
            "durationFrames": n,
            "durationSec":    round(dur, 3),
            "timecodeStart":  tc,
            "colorPrimaries": cp or base["colorPrimaries"],
            "colorTransfer":  ct or base["colorTransfer"],
            "colorSpace":     cs,
            "pixFmt":         pix,
            "camera":         (fmt.get("tags") or {}).get("encoder", ""),
        })
        return base

    def _decode_frame(self, path: str, seek_s: float,
                      out_path: Path, fmt: str, width: int, height: int) -> None:
        """Decode a single ProRes RAW frame to JPEG/PNG via ffmpeg."""
        if not self._ffmpeg:
            raise RuntimeError("ffmpeg not available for ProRes RAW frame decode")

        vf = (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
        )
        img_fmt = "mjpeg" if fmt == "jpg" else "png"

        tmp_fd, tmp_path = tempfile.mkstemp(suffix=f".{fmt}", dir=str(self._cache))
        os.close(tmp_fd)
        try:
            cmd = [self._ffmpeg, "-y",
                   "-ss", f"{seek_s:.6f}",
                   "-i", path,
                   "-vframes", "1",
                   "-vf", vf,
                   "-f", img_fmt,
                   tmp_path]

            # Prefer VideoToolbox hardware decode on macOS for speed
            if self._hw_accel:
                cmd = [self._ffmpeg, "-y",
                       "-hwaccel", "videotoolbox",
                       "-ss", f"{seek_s:.6f}",
                       "-i", path,
                       "-vframes", "1",
                       "-vf", vf,
                       "-f", img_fmt,
                       tmp_path]

            result = subprocess.run(cmd, capture_output=True, timeout=60)
            if result.returncode != 0 or not Path(tmp_path).is_file() or Path(tmp_path).stat().st_size == 0:
                # Retry without VideoToolbox if hw decode failed
                if self._hw_accel:
                    cmd_sw = [self._ffmpeg, "-y",
                               "-ss", f"{seek_s:.6f}",
                               "-i", path,
                               "-vframes", "1", "-vf", vf, "-f", img_fmt, tmp_path]
                    result = subprocess.run(cmd_sw, capture_output=True, timeout=60)

            if result.returncode != 0 or not Path(tmp_path).is_file() or Path(tmp_path).stat().st_size == 0:
                raise RuntimeError(
                    f"ProRes RAW frame decode failed: {result.stderr[-256:].decode(errors='replace')}"
                )
            os.replace(tmp_path, str(out_path))
            tmp_path = None
        finally:
            if tmp_path:
                try: Path(tmp_path).unlink(missing_ok=True)
                except: pass
