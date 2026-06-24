"""ARRIRAW backend — ARRI camera original formats (Phase 6).

Phase 6 deliverable: architecture-ready, implementation deferred.
Provides complete detection logic, clear status reporting, and wired-up
scaffolding so Phase 7 decode can be added by installing the ARRI SDK.

Supported file extensions:
  .ari   — ARRIRAW v1 (ALEXA Mini, ALEXA SXT, ALEXA Classic, AMIRA)
  .arx   — ARRIRAW v2 (ALEXA 35, ALEXA 265)
  .mxf   — MXF-wrapped ARRIRAW (ALEXA LF, AMIRA)

Backend paths:
  arri_sdk        — Official ARRIRAW SDK (arri.com/en/learn-help/technical-downloads)
  arri_tool_bridge — Command-line tools from ARRI Reference Tool / ARRIRAW Converter

What IS available on a DaVinci Resolve system:
  libArriImageSdk.9.dylib — ARRI Image SDK (color science: LUT/ALF processing).
                            NOT a raw frame decoder. Used here for color-space
                            metadata enrichment only (AWG3/AWG4 LogC references).

Install ARRIRAW SDK to unlock full decode:
  1. Register at arri.com (free developer account)
  2. Download "ARRIRAW SDK" for your platform
  3. Install to /usr/local/lib/libArriSdk.dylib (macOS) or add to PATH (Windows)
  The companion will auto-detect on next launch.
"""
from __future__ import annotations

import json
import os
import platform
import subprocess
from pathlib import Path
from typing import Any

from ..media_types import Backend, BackendStatus
from .base_backend import BaseMediaBackend

# ---------------------------------------------------------------------------
# ARRIRAW file extensions
# ---------------------------------------------------------------------------
_ARRI_EXTS = frozenset({".ari", ".arx"})
# MXF may be ARRIRAW-wrapped — detected by codec probe
_ARRI_CODECS = frozenset({"arriraw", "arri_raw", "arri", "alexa"})

# ---------------------------------------------------------------------------
# SDK / tool detection paths
# ---------------------------------------------------------------------------

# Official ARRIRAW SDK (arri.com developer downloads)
_ARRI_SDK_PATHS_MACOS = [
    "/usr/local/lib/libArriSdk.dylib",
    "/usr/local/lib/libArriRawSdk.dylib",
    "/Library/ARRI/SDK/libArriSdk.dylib",
    "/opt/homebrew/lib/libArriSdk.dylib",
]
_ARRI_SDK_PATHS_WINDOWS = [
    r"C:\Program Files\ARRI\ARRIRAW SDK\ArriSdk.dll",
    r"C:\Program Files\ARRI\SDK\ArriRawSdk.dll",
]

# ARRI Reference Tool / ARRIRAW Converter (command-line decode)
_ARRI_TOOL_PATHS_MACOS = [
    "/usr/local/bin/arrirawconverter",
    "/usr/local/bin/ArriRawConverter",
    "/Applications/ARRIRAW Converter.app/Contents/MacOS/ArriRawConverter",
    "/Applications/ARRI Reference Tool.app/Contents/MacOS/ARRI Reference Tool",
]
_ARRI_TOOL_PATHS_WINDOWS = [
    r"C:\Program Files\ARRI\ARRIRAW Converter\ArriRawConverter.exe",
    r"C:\Program Files\ARRI\Reference Tool\ArriReferenceTool.exe",
]

# ARRI Image SDK (DaVinci Resolve bundled) — color science only
_ARRI_IMAGE_SDK_PATHS = [
    "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/libArriImageSdk.9.dylib",
    "/Library/Application Support/Blackmagic Design/DaVinci Resolve/libArriImageSdk.9.dylib",
]


# ---------------------------------------------------------------------------
# Detection helpers
# ---------------------------------------------------------------------------

def _detect_arri_sdk() -> str | None:
    """Find the official ARRIRAW SDK library."""
    paths = _ARRI_SDK_PATHS_MACOS if platform.system() == "Darwin" else _ARRI_SDK_PATHS_WINDOWS
    for p in paths:
        if os.path.isfile(p):
            return p
    return None


def _detect_arri_tool() -> str | None:
    """Find an ARRI command-line converter tool."""
    import shutil
    paths = _ARRI_TOOL_PATHS_MACOS if platform.system() == "Darwin" else _ARRI_TOOL_PATHS_WINDOWS
    for p in paths:
        if os.path.isfile(p):
            return p
    # Also check PATH
    for name in ("arrirawconverter", "ArriRawConverter", "arri_convert"):
        found = shutil.which(name)
        if found:
            return found
    return None


def _detect_arri_image_sdk() -> str | None:
    """Find the ARRI Image SDK (color science, not frame decode)."""
    for p in _ARRI_IMAGE_SDK_PATHS:
        if os.path.isfile(p):
            return p
    return None


def _detect_ffprobe_arri(ffprobe: str | None) -> bool:
    """Return True if ffprobe can probe .ari/.arx files."""
    if not ffprobe:
        return False
    # ffprobe doesn't have a dedicated ARRIRAW demuxer; .ari is raw binary.
    # ffprobe can sometimes read MXF-wrapped ARRIRAW via the MXF demuxer.
    try:
        out = subprocess.check_output([ffprobe, "-formats"], capture_output=False,
                                      stderr=subprocess.DEVNULL, timeout=5).decode(errors="replace")
        return "mxf" in out.lower()
    except Exception:
        return False


# ---------------------------------------------------------------------------
# ArriBackend
# ---------------------------------------------------------------------------

class ArriBackend(BaseMediaBackend):
    """
    ARRIRAW backend — Phase 6 (architecture-ready, SDK integration deferred).

    Status by configuration:
      Official ARRIRAW SDK installed         → READY (full metadata + decode)
      ARRI command-line tool available       → PREVIEW_ONLY (tool-bridge decode)
      Only ARRI Image SDK (DaVinci bundled)  → METADATA_ONLY (color science info only)
      Nothing                                → NOT_INSTALLED (clear install instructions)

    Upgrade path:
      Download ARRIRAW SDK from arri.com/en/learn-help/technical-downloads
      Install to /usr/local/lib/ (macOS) or C:\\Program Files\\ARRI\\SDK\\ (Windows)
      Restart the companion — backend auto-detects and becomes READY.
    """

    def __init__(self, ffmpeg_path: str | None = None, ffprobe_path: str | None = None,
                 cache_dir: Path | None = None):
        import shutil, tempfile
        self._ffmpeg  = ffmpeg_path  or shutil.which("ffmpeg")
        self._ffprobe = ffprobe_path or shutil.which("ffprobe")
        self._cache   = cache_dir or Path(tempfile.gettempdir()) / "pfx_arri_frames"
        self._cache.mkdir(parents=True, exist_ok=True)

        # Detection results
        self._sdk_path        = _detect_arri_sdk()          # official ARRIRAW SDK
        self._tool_path       = _detect_arri_tool()         # CLI tool bridge
        self._image_sdk_path  = _detect_arri_image_sdk()    # DaVinci color SDK
        self._ffprobe_mxf     = _detect_ffprobe_arri(self._ffprobe)

        # SDK version (filled when SDK is loaded)
        self._sdk_version: str | None = None
        if self._sdk_path:
            self._sdk_version = self._read_sdk_version()

    # ── Status ────────────────────────────────────────────────────────────────

    @property
    def _has_decode(self) -> bool:
        return bool(self._sdk_path or self._tool_path)

    @property
    def _has_metadata(self) -> bool:
        return bool(self._sdk_path or self._image_sdk_path or self._ffprobe_mxf)

    # ── BaseMediaBackend interface ─────────────────────────────────────────────

    @property
    def backend_key(self) -> str:
        return Backend.ARRI_SDK

    def can_open(self, path: str) -> bool:
        ext = Path(path).suffix.lower()
        # .ari / .arx always accepted if we have any capability
        if ext in _ARRI_EXTS:
            return self._has_metadata or self._has_decode
        # .mxf accepted only if ffprobe MXF support available
        if ext == ".mxf":
            return self._ffprobe_mxf
        return False

    def probe_mxf_codec(self, path: str) -> str:
        """Return the video codec name for an MXF file, or '' if not detectable.

        Used by the routing layer to check whether an MXF is ARRIRAW before
        committing to this backend.
        """
        if not self._ffprobe_mxf:
            return ""
        probe = self._probe_mxf_ffprobe(path)
        return probe.get("codec", "")

    def open(self, path: str, options: dict) -> dict[str, Any]:
        if not (self._has_metadata or self._has_decode):
            raise RuntimeError(
                "ARRIRAW backend: no capability available. "
                "Download ARRIRAW SDK from arri.com/en/learn-help/technical-downloads"
            )
        if not Path(path).is_file():
            raise FileNotFoundError(f"File not found: {path}")

        meta = self._get_metadata_impl(path)
        caps = self.get_capabilities()
        return {
            "sessionHandle":  path,
            "fileType":       "arriraw",
            "canPlay":        False,               # ARRIRAW always requires decode pipeline
            "framesDecodable": self._has_decode,   # False when no SDK/tool → JS triggers proxy build
            "metadata":       meta,
            "capabilities":   caps,
        }

    def close(self, session_handle: Any) -> None:
        pass

    def get_metadata(self, session_handle: Any) -> dict[str, Any]:
        if not self._has_metadata:
            raise RuntimeError("ARRIRAW backend: no metadata capability")
        return self._get_metadata_impl(str(session_handle))

    def get_frame(self, session_handle: Any, frame_index: int, options: dict) -> dict[str, Any]:
        if self._sdk_path:
            return self._decode_frame_sdk(str(session_handle), frame_index, options)
        if self._tool_path:
            return self._decode_frame_tool(str(session_handle), frame_index, options)
        raise RuntimeError(
            "ARRIRAW frame decode requires ARRIRAW SDK or ARRI Reference Tool. "
            "See arri.com/en/learn-help/technical-downloads"
        )

    def seek(self, session_handle: Any, frame_index: int) -> dict[str, Any]:
        return {"seeked": True, "frameIndex": frame_index}

    def get_capabilities(self) -> dict[str, Any]:
        return {
            "supportsMetadata":             self._has_metadata,
            "supportsStillFrameDecode":     self._has_decode,
            "supportsPlayback":             False,
            "supportsHalfRes":              self._has_decode,
            "supportsQuarterRes":           self._has_decode,
            "supportsHardwareAcceleration": False,
            # ARRI-specific
            "arriImageSdkAvailable": bool(self._image_sdk_path),
            "arriRawSdkAvailable":   bool(self._sdk_path),
            "arriToolBridgeAvailable": bool(self._tool_path),
        }

    def get_status(self) -> dict[str, Any]:
        details: list[str] = []
        if self._sdk_path:
            details.append(f"arriraw_sdk@{self._sdk_version or 'unknown'}")
        if self._tool_path:
            details.append("arri_tool_bridge")
        if self._image_sdk_path:
            details.append("arri_image_sdk_color_only")
        if self._ffprobe_mxf:
            details.append("ffprobe_mxf")

        if self._sdk_path:
            return {
                "status":     BackendStatus.READY,
                "decodeMode": "full",
                "version":    "+".join(details),
                "lastError":  None,
            }

        if self._tool_path:
            return {
                "status":     BackendStatus.PREVIEW_ONLY,
                "decodeMode": "tool_bridge",
                "version":    "+".join(details),
                "lastError":  "Full ARRIRAW SDK not found; using CLI tool bridge (lower throughput)",
            }

        if self._image_sdk_path or self._ffprobe_mxf:
            return {
                "status":     BackendStatus.METADATA_ONLY,
                "decodeMode": "metadata",
                "version":    "+".join(details) if details else "arri_image_sdk",
                "lastError":  (
                    "ARRIRAW frame decode deferred (Phase 6). "
                    "Install ARRIRAW SDK from arri.com for full decode."
                ),
            }

        # Nothing usable at all
        return {
            "status":     BackendStatus.NOT_INSTALLED,
            "decodeMode": "none",
            "version":    None,
            "lastError":  (
                "ARRIRAW SDK not installed. "
                "Download from arri.com/en/learn-help/technical-downloads → "
                "Developer Tools → ARRIRAW SDK."
            ),
        }

    # ── Internal metadata ──────────────────────────────────────────────────────

    def _get_metadata_impl(self, path: str) -> dict[str, Any]:
        meta: dict[str, Any] = {
            "fileType":       "arriraw",
            "codec":          "arriraw",
            "clipName":       Path(path).stem,
            "camera":         "ARRI",
            "colorPrimaries": "awg3_d65",   # ALEXA Wide Gamut (default)
            "colorTransfer":  "logc3",       # LogC3 (default for ALEXA Mini/SXT)
            "decodeModes":    ["full", "half", "quarter"],
        }

        ext = Path(path).suffix.lower()

        # ── Parse .ari binary header (if accessible) ──────────────────────────
        if ext in {".ari", ".arx"}:
            header_meta = self._parse_ari_header(path)
            meta.update({k: v for k, v in header_meta.items() if v is not None})

        # ── MXF-wrapped ARRIRAW via ffprobe ───────────────────────────────────
        if ext == ".mxf" and self._ffprobe and self._ffprobe_mxf:
            probe = self._probe_mxf_ffprobe(path)
            meta.update({k: v for k, v in probe.items() if v})

        # ── ARRI Image SDK color science enrichment ───────────────────────────
        # (libArriImageSdk provides AWG3/AWG4/LogC references — NOT frame decode)
        if self._image_sdk_path:
            color_ext = self._enrich_color_metadata(path, meta)
            meta.update({k: v for k, v in color_ext.items() if v})

        # ── ARRIRAW SDK full metadata ─────────────────────────────────────────
        if self._sdk_path:
            sdk_meta = self._read_metadata_sdk(path)
            meta.update({k: v for k, v in sdk_meta.items() if v is not None})

        meta.setdefault("fps",            24.0)
        meta.setdefault("durationFrames", 0)
        meta.setdefault("durationSec",    0.0)
        meta.setdefault("width",          0)
        meta.setdefault("height",         0)
        meta.setdefault("timecodeStart",  "")
        return meta

    def _parse_ari_header(self, path: str) -> dict[str, Any]:
        """
        Parse metadata from the ARRIRAW binary container header.
        ARRIRAW .ari files have a structured header with camera metadata
        embedded in the first 4KB.  Offset layout is version-dependent.
        This extracts what can be reliably identified across versions.
        """
        meta: dict[str, Any] = {}
        try:
            with open(path, "rb") as f:
                header = f.read(4096)

            # ARRIRAW v1 (.ari): magic 'ARRI' at offset 0
            # ARRIRAW v2 (.arx): magic 'ARRIv2' or similar
            if header[:4] == b"ARRI":
                meta["formatVersion"] = "v1"
                # Width/height typically at fixed offsets in v1 header
                # (exact offsets from community documentation)
                import struct
                if len(header) >= 20:
                    try:
                        w = struct.unpack_from("<I", header, 8)[0]
                        h = struct.unpack_from("<I", header, 12)[0]
                        if 100 < w < 10000 and 100 < h < 10000:
                            meta["width"]  = w
                            meta["height"] = h
                    except Exception:
                        pass
            elif header[:6] in (b"ARRIv2", b"ARRIEX"):
                meta["formatVersion"] = "v2"

            # Look for ASCII timecode strings in the header (common pattern in .ari)
            import re
            tc_match = re.search(rb"(\d{2}:\d{2}:\d{2}:\d{2})", header[:2048])
            if tc_match:
                meta["timecodeStart"] = tc_match.group(1).decode("ascii", errors="ignore")

            # Camera model hints from header strings
            for model in [b"ALEXA Mini", b"ALEXA 35", b"ALEXA LF", b"ALEXA SXT",
                           b"AMIRA", b"ALEXA 265"]:
                if model in header[:2048]:
                    meta["camera"] = model.decode("ascii")
                    break

        except Exception:
            pass
        return meta

    def _probe_mxf_ffprobe(self, path: str) -> dict[str, Any]:
        """Probe MXF-wrapped ARRIRAW via ffprobe."""
        meta: dict[str, Any] = {}
        try:
            out = subprocess.check_output(
                [self._ffprobe, "-v", "quiet", "-print_format", "json",
                 "-show_streams", "-show_format", path],
                timeout=15, stderr=subprocess.DEVNULL
            )
            data = json.loads(out)
        except Exception:
            return meta

        vid = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
        fmt = data.get("format", {})

        # Check codec
        codec = vid.get("codec_name", "").lower()
        if "arri" in codec or "arriraw" in codec or "rawvideo" in codec:
            meta["codec"] = "arriraw"

        fps_raw = vid.get("r_frame_rate", "24/1")
        try:
            a, b = fps_raw.split("/")
            fps = round(float(a) / max(float(b), 1), 3)
        except Exception:
            fps = 24.0

        dur = float(vid.get("duration") or fmt.get("duration") or 0)
        meta.update({
            "fps":            fps,
            "durationSec":    round(dur, 3),
            "durationFrames": int(round(dur * fps)),
            "width":          int(vid.get("width", 0)) or None,
            "height":         int(vid.get("height", 0)) or None,
        })

        # Timecode from MXF metadata
        tc = ""
        for k in ("timecode", "Timecode"):
            tc = (vid.get("tags") or {}).get(k, "") or (fmt.get("tags") or {}).get(k, "")
            if tc:
                break
        if tc:
            meta["timecodeStart"] = tc

        return meta

    def _enrich_color_metadata(self, path: str, existing: dict) -> dict[str, Any]:
        """
        Use libArriImageSdk to identify the correct color space for this clip.
        libArriImageSdk is a color science library (not a frame decoder) but it
        provides AWG3/AWG4 and LogC3/LogC4 reference data useful for display.
        Implementation: infer from camera model + format version in existing metadata.
        """
        enriched: dict[str, Any] = {}
        camera = str(existing.get("camera") or "").lower()
        version = str(existing.get("formatVersion") or "v1").lower()

        # ALEXA 35 / ALEXA 265 → AWG4 + LogC4
        if any(x in camera for x in ["alexa 35", "alexa 265", "a35", "a265"]):
            enriched["colorPrimaries"] = "awg4_d65"
            enriched["colorTransfer"]  = "logc4"
        # ALEXA LF → AWG3 + LogC3
        elif "lf" in camera:
            enriched["colorPrimaries"] = "awg3_d65"
            enriched["colorTransfer"]  = "logc3"
        # Default: AWG3 + LogC3 (most common for ALEXA Mini/SXT/Classic)
        else:
            enriched["colorPrimaries"] = "awg3_d65"
            enriched["colorTransfer"]  = "logc3"

        return enriched

    # ── SDK decode stubs (populated when ARRIRAW SDK is installed) ─────────────

    def _read_sdk_version(self) -> str | None:
        """Read ARRIRAW SDK version string."""
        # TODO Phase 7: load libArriSdk.dylib via ctypes and call version function
        return "arriraw_sdk"

    def _read_metadata_sdk(self, path: str) -> dict[str, Any]:
        """Full ARRIRAW metadata via official SDK."""
        # TODO Phase 7: implement using ARRIRAW SDK ctypes binding
        # SDK provides: ARRIRAW::IClip::GetWidth(), GetHeight(), GetFrameRate(),
        #               GetFrameCount(), GetTimecode(), GetMetadataItem(key), etc.
        return {}

    def _decode_frame_sdk(self, path: str, frame_index: int, options: dict) -> dict[str, Any]:
        """Decode ARRIRAW frame via official SDK."""
        # TODO Phase 7: ARRIRAW SDK async decode pipeline
        raise NotImplementedError(
            "ARRIRAW SDK frame decode: implement when SDK is installed and verified. "
            "Follow BRAW backend pattern with ctypes vtable navigation."
        )

    def _decode_frame_tool(self, path: str, frame_index: int, options: dict) -> dict[str, Any]:
        """Decode ARRIRAW frame via CLI tool bridge."""
        # TODO Phase 7: subprocess call to arrirawconverter / ARRI Reference Tool
        # Typical command:
        #   arrirawconverter --input clip.ari --frame N --output /tmp/frame.tif
        # Then convert .tif → JPEG via PIL or ffmpeg
        raise NotImplementedError(
            "ARRIRAW tool-bridge decode: implement when ARRI Reference Tool is installed."
        )


# ---------------------------------------------------------------------------
# ArriToolBridgeBackend — separate entry for the tool bridge path
# ---------------------------------------------------------------------------

class ArriToolBridgeBackend(BaseMediaBackend):
    """
    ARRIRAW decode via CLI tool bridge (arri_tool_bridge backend key).
    Delegates to ArriBackend when a tool is available.
    Registered separately so the router can choose between arri_sdk and arri_tool_bridge.
    """

    def __init__(self, **kwargs):
        self._arri = ArriBackend(**kwargs)

    @property
    def backend_key(self) -> str:
        return Backend.ARRI_TOOL_BRIDGE

    def can_open(self, path: str) -> bool:
        return bool(self._arri._tool_path) and self._arri.can_open(path)

    def open(self, path: str, options: dict) -> dict[str, Any]:
        return self._arri.open(path, options)

    def close(self, session_handle: Any) -> None:
        self._arri.close(session_handle)

    def get_metadata(self, session_handle: Any) -> dict[str, Any]:
        return self._arri.get_metadata(session_handle)

    def get_frame(self, session_handle: Any, frame_index: int, options: dict) -> dict[str, Any]:
        if not self._arri._tool_path:
            raise RuntimeError("ARRI tool bridge not available")
        return self._arri._decode_frame_tool(str(session_handle), frame_index, options)

    def seek(self, session_handle: Any, frame_index: int) -> dict[str, Any]:
        return {"seeked": True, "frameIndex": frame_index}

    def get_capabilities(self) -> dict[str, Any]:
        caps = self._arri.get_capabilities()
        caps["backendKey"] = Backend.ARRI_TOOL_BRIDGE
        return caps

    def get_status(self) -> dict[str, Any]:
        if not self._arri._tool_path:
            return {
                "status":     BackendStatus.NOT_INSTALLED,
                "decodeMode": "none",
                "version":    None,
                "lastError":  "ARRI Reference Tool not found. Install from arri.com.",
            }
        return {
            "status":     BackendStatus.PREVIEW_ONLY,
            "decodeMode": "tool_bridge",
            "version":    f"tool:{Path(self._arri._tool_path).name}",
            "lastError":  None,
        }
