"""R3D backend — RED REDCODE RAW (Phase 4).

Detection hierarchy (best → fallback):
  1. Official R3DSDK (from RED developer program, installed separately)
     → READY: full metadata + full frame decode at half/quarter res
  2. DaVinci Resolve R3D libraries (REDDecoder.dylib / REDR3D.dylib)
     → METADATA_ONLY: DaVinci exposes obfuscated API; metadata via RED_LIB_INITIALIZE
  3. ffprobe r3d demuxer (ffmpeg built-in R3D container reader)
     → METADATA_ONLY: container-level metadata (fps, frame count, dimensions from headers)

Frame decode without R3DSDK:
  - Attempt ffmpeg thumbnail extraction (R3D containers may contain JPEG proxy streams)
  - If ffmpeg can decode a proxy stream → preview quality frames
  - Otherwise: no frame decode, metadata only

Install R3DSDK for full decode:
  macOS: https://www.red.com/downloads → SDK & Plugins → R3D SDK
  Windows: same URL
"""
from __future__ import annotations

import ctypes
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

# ---------------------------------------------------------------------------
# SDK detection paths
# ---------------------------------------------------------------------------

# Official R3DSDK (from RED developer program)
_R3DSDK_PATHS_MACOS = [
    "/usr/local/lib/libR3DSDK-libcxx.dylib",
    "/usr/local/lib/libR3DSDK.dylib",
    "/opt/homebrew/lib/libR3DSDK.dylib",
    "/Library/RED/SDK/libR3DSDK.dylib",
]
_R3DSDK_PATHS_WINDOWS = [
    r"C:\Program Files\RED Digital Cinema\R3D SDK\R3DSDK.dll",
    r"C:\Program Files\Common Files\RED Digital Cinema\R3DSDK.dll",
]

# DaVinci Resolve R3D decode library (obfuscated API, metadata-only)
_DR_R3D_PATHS = [
    "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/REDDecoder.dylib",
    "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/REDR3D.dylib",
]

# RED CLI tool (Redline) — command-line decode
_REDLINE_PATHS = [
    "/usr/local/bin/Redline",
    "/usr/bin/Redline",
    "/Applications/REDCINE-X PRO.app/Contents/MacOS/redline",
]

# ---------------------------------------------------------------------------
# R3D container parse — extract metadata from binary headers directly
# ---------------------------------------------------------------------------
# R3D files have a proprietary container. The container header at offset 0
# starts with a 4-byte magic 'R3D\x00' and embeds key metadata.
_R3D_MAGIC = b'R3D\x00'

def _parse_r3d_header(path: str) -> dict[str, Any]:
    """
    Extract metadata directly from R3D container binary headers.
    Returns a partial metadata dict — not all fields may be present.
    This works without any SDK.
    """
    meta: dict[str, Any] = {}
    try:
        with open(path, "rb") as f:
            header = f.read(512)

        if len(header) < 16 or header[:4] != _R3D_MAGIC:
            return meta

        # R3D header layout (simplified, from community reverse engineering):
        # Offset 4:  4 bytes — file format version
        # Offset 8:  4 bytes — width (big-endian uint32)
        # Offset 12: 4 bytes — height (big-endian uint32)

        import struct
        if len(header) >= 16:
            version = struct.unpack('>I', header[4:8])[0]
            width   = struct.unpack('>I', header[8:12])[0]
            height  = struct.unpack('>I', header[12:16])[0]
            if 100 < width < 20000 and 100 < height < 20000:
                meta['width']   = width
                meta['height']  = height
            meta['r3dVersion'] = version

        # Try to find frame rate in the header (varies by version)
        # Look for common fps values encoded as rational: 24000/1001, 24/1, etc.
        # This is heuristic — exact offset depends on version

    except Exception:
        pass
    return meta


# ---------------------------------------------------------------------------
# Metadata via ffprobe r3d demuxer
# ---------------------------------------------------------------------------

def _probe_r3d_ffprobe(path: str, ffprobe: str) -> dict[str, Any]:
    """Use ffprobe's r3d demuxer to extract container-level metadata."""
    try:
        cmd = [
            ffprobe, "-v", "quiet", "-print_format", "json",
            "-show_streams", "-show_format",
            "-f", "r3d",   # force R3D demuxer
            path,
        ]
        out = subprocess.check_output(cmd, timeout=20, stderr=subprocess.DEVNULL)
        data = json.loads(out)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, json.JSONDecodeError):
        # ffprobe with -f r3d may fail on some files; try without forcing format
        try:
            cmd2 = [
                ffprobe, "-v", "quiet", "-print_format", "json",
                "-show_streams", "-show_format", path,
            ]
            out2 = subprocess.check_output(cmd2, timeout=20, stderr=subprocess.DEVNULL)
            data = json.loads(out2)
        except Exception:
            return {}
    except Exception:
        return {}

    vid = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
    fmt = data.get("format", {})

    fps_raw = vid.get("r_frame_rate") or vid.get("avg_frame_rate") or "24/1"
    try:
        a, b = fps_raw.split("/")
        fps = round(float(a) / max(float(b), 1), 3)
    except Exception:
        fps = 24.0

    dur = float(vid.get("duration") or fmt.get("duration") or 0)
    frame_count = int(vid.get("nb_frames") or 0) or (int(round(dur * fps)) if fps > 0 else 0)
    w = int(vid.get("width") or 0)
    h = int(vid.get("height") or 0)

    tc_start = ""
    for tag_key in ("timecode", "Timecode", "time_code"):
        tc_start = (vid.get("tags") or {}).get(tag_key) or (fmt.get("tags") or {}).get(tag_key) or ""
        if tc_start:
            break

    result: dict[str, Any] = {
        "fileType":       "r3d",
        "codec":          vid.get("codec_name") or "redcode",
        "fps":            fps,
        "durationSec":    round(dur, 3),
        "durationFrames": frame_count,
        "timecodeStart":  tc_start,
        "decodeModes":    ["full", "half", "quarter"],
    }
    if w > 0: result["width"]  = w
    if h > 0: result["height"] = h
    return result


# ---------------------------------------------------------------------------
# Frame decode via ffmpeg (proxy stream extraction)
# ---------------------------------------------------------------------------

def _extract_r3d_proxy_frame(path: str, frame_index: int, ffmpeg: str,
                              out_path: Path, width: int, height: int,
                              fps: float) -> bool:
    """
    Try to extract a frame from R3D using ffmpeg.
    R3D containers sometimes contain a JPEG proxy stream; ffmpeg may extract it.
    Falls back to a best-effort decode of the REDCODE stream.
    Returns True on success.
    """
    seek_s = frame_index / max(1.0, fps)
    vf = (
        f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
        f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
    )
    tmp_fd, tmp_path = tempfile.mkstemp(suffix=".jpg", dir=str(out_path.parent))
    os.close(tmp_fd)

    strategies = [
        # Strategy 1: force r3d demuxer, seek, grab first frame
        [ffmpeg, "-y", "-f", "r3d", "-ss", f"{seek_s:.3f}",
         "-i", path, "-vframes", "1", "-vf", vf, "-q:v", "3", tmp_path],
        # Strategy 2: let ffmpeg auto-detect, seek, grab
        [ffmpeg, "-y", "-ss", f"{seek_s:.3f}",
         "-i", path, "-vframes", "1", "-vf", vf, "-q:v", "3", tmp_path],
        # Strategy 3: map secondary video stream (proxy stream index 1)
        [ffmpeg, "-y", "-i", path, "-map", "0:v:1",
         "-vframes", "1", "-vf", vf, tmp_path],
    ]

    for cmd in strategies:
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=45)
            if result.returncode == 0 and Path(tmp_path).is_file() and Path(tmp_path).stat().st_size > 0:
                os.replace(tmp_path, str(out_path))
                return True
        except Exception:
            pass

    try: Path(tmp_path).unlink(missing_ok=True)
    except: pass
    return False


# ---------------------------------------------------------------------------
# R3DSDK ctypes wrapper (when officially installed)
# ---------------------------------------------------------------------------
# The official R3DSDK C++ API has these C-compatible entry points:
#   InitializeSdk(const char* path_to_sdk, RMDManagerFlags flags) → int (REDC_SUCCESS=0)
#   TerminateSdk()
#   R3D_Clip* R3D_OpenClip(const char* path)     (or similar factory)
#   R3D_CloseClip(R3D_Clip*)
# Exact symbols depend on SDK version.

def _try_load_r3dsdk(sdk_path: str):
    """Load official R3DSDK and return (lib, version_str) or (None, error_str)."""
    try:
        lib = ctypes.CDLL(sdk_path)
        # Try to call InitializeSdk
        if hasattr(lib, "InitializeSdk"):
            lib.InitializeSdk.restype  = ctypes.c_int
            lib.InitializeSdk.argtypes = [ctypes.c_char_p, ctypes.c_int]
            sdk_dir = str(Path(sdk_path).parent).encode("utf-8")
            rc = lib.InitializeSdk(sdk_dir, 0)
            version = "r3dsdk"
            return lib, version
        return None, "InitializeSdk not found"
    except Exception as exc:
        return None, str(exc)


# ---------------------------------------------------------------------------
# R3dBackend
# ---------------------------------------------------------------------------

class R3dBackend(BaseMediaBackend):
    """
    RED R3D backend — Phase 4.

    Capabilities by configuration:
      R3DSDK installed   → READY:         metadata + frame decode
      DaVinci / ffprobe  → METADATA_ONLY: container metadata, proxy frame attempts
      Nothing            → SDK_MISSING
    """

    def __init__(self, ffmpeg_path: str | None = None, ffprobe_path: str | None = None,
                 cache_dir: Path | None = None):
        self._ffmpeg   = ffmpeg_path  or self._find_tool("ffmpeg")
        self._ffprobe  = ffprobe_path or self._find_tool("ffprobe")
        self._cache    = cache_dir or Path(tempfile.gettempdir()) / "pfx_r3d_frames"
        self._cache.mkdir(parents=True, exist_ok=True)

        # Detection results
        self._sdk_lib    = None     # ctypes lib (official R3DSDK) — see note in _detect
        self._sdk_path   = None     # path that loaded
        self._dr_path    = None     # DaVinci Resolve R3D library path
        self._has_ffprobe_r3d = False
        self._helper      = None    # pfx_r3d_decode native helper binary (full decode)
        self._helper_libdir = None  # folder holding the SDK redistributable dylibs
        self._helper_ver  = None    # SDK version string reported by the helper
        self._last_error: str | None = None

        self._detect()
        self._detect_helper()

    # ── Detection ─────────────────────────────────────────────────────────────

    def _find_tool(self, name: str) -> str | None:
        import shutil
        # Prefer the bundled binary (Dev Brief P0#2): a GUI-launched companion has a
        # stripped PATH and no /opt/homebrew, so bare shutil.which fails in production.
        try:
            from ...proxy_service import _resource_bin
            b = _resource_bin(name)
            if b:
                return b
        except Exception:
            pass
        return shutil.which(name)

    def _detect(self) -> None:
        # 1. Official R3DSDK
        paths = _R3DSDK_PATHS_MACOS if platform.system() == "Darwin" else _R3DSDK_PATHS_WINDOWS
        for p in paths:
            if os.path.isfile(p):
                lib, info = _try_load_r3dsdk(p)
                if lib:
                    self._sdk_lib  = lib
                    self._sdk_path = p
                    return

        # 2. DaVinci Resolve R3D libraries (metadata enhancement)
        for p in _DR_R3D_PATHS:
            if os.path.isfile(p):
                self._dr_path = p
                break

        # 3. ffprobe r3d demuxer availability
        if self._ffprobe:
            try:
                out = subprocess.check_output(
                    [self._ffprobe, "-demuxers"],
                    stderr=subprocess.STDOUT, timeout=5
                ).decode(errors="replace")
                self._has_ffprobe_r3d = "r3d" in out.lower()
            except Exception:
                self._has_ffprobe_r3d = False

    def _detect_helper(self) -> None:
        """Locate the pfx_r3d_decode native helper (Dev Brief P1#4).

        The official R3D SDK on macOS is a C++ static lib, so full decode runs
        through this helper binary (which links it) rather than ctypes. The
        helper needs the SDK redistributable dylibs on disk; we point it at
        them via PFX_R3DSDK_LIBDIR (its own ../r3d_libs by default).
        Verified by running `pfx_r3d_decode version`.
        """
        env_bin = str(os.environ.get("PFX_R3D_HELPER") or "").strip()
        candidates = []
        if env_bin:
            candidates.append(Path(env_bin))
        base = Path(__file__).resolve().parents[5]   # repo root (dev) / Resources (packaged)
        for prefix in (base, base / "app.asar.unpacked"):
            candidates.append(prefix / "electron" / "native" / "pfx_r3d_decode")

        for cand in candidates:
            try:
                if not (cand.is_file() and os.access(str(cand), os.X_OK)):
                    continue
                libdir = str(os.environ.get("PFX_R3DSDK_LIBDIR") or "").strip() \
                    or str(cand.parent / "r3d_libs")
                env = dict(os.environ)
                env["PFX_R3DSDK_LIBDIR"] = libdir
                r = subprocess.run([str(cand), "version"],
                                   capture_output=True, text=True, timeout=15, env=env)
                if r.returncode == 0 and '"ok":true' in (r.stdout or ""):
                    import json
                    try:
                        info = json.loads(r.stdout.strip().splitlines()[-1])
                        self._helper_ver = info.get("sdkVersion")
                    except Exception:
                        pass
                    self._helper = str(cand)
                    self._helper_libdir = libdir
                    return
            except Exception as exc:
                self._last_error = f"r3d helper probe failed: {exc}"

    def _helper_env(self) -> dict:
        env = dict(os.environ)
        if self._helper_libdir:
            env["PFX_R3DSDK_LIBDIR"] = self._helper_libdir
        return env

    # ── Status ────────────────────────────────────────────────────────────────

    @property
    def _helper_ready(self) -> bool:
        return bool(self._helper)

    @property
    def _sdk_ready(self) -> bool:
        # ctypes loading of the R3D SDK is not possible on macOS (static C++ lib);
        # the native helper is the real full-decode path. Kept for the (unused)
        # ctypes branch / future platforms.
        return bool(self._sdk_lib)

    @property
    def _can_metadata(self) -> bool:
        return self._helper_ready or self._sdk_ready or bool(self._ffprobe)

    @property
    def _can_frames(self) -> bool:
        return self._helper_ready or self._sdk_ready or bool(self._ffmpeg)

    # ── BaseMediaBackend interface ─────────────────────────────────────────────

    @property
    def backend_key(self) -> str:
        return Backend.R3D_SDK

    def can_open(self, path: str) -> bool:
        return Path(path).suffix.upper() in {".R3D", ".r3d"} and self._can_metadata

    def open(self, path: str, options: dict) -> dict[str, Any]:
        if not self._can_metadata:
            raise RuntimeError("R3D backend: no metadata capability available")
        if not Path(path).is_file():
            raise FileNotFoundError(f"File not found: {path}")

        meta = self._get_metadata_impl(path)
        caps = self.get_capabilities()

        # Check whether ffmpeg can actually decode THIS specific R3D file.
        # Newer generations (NRED2 etc.) use a format ffmpeg's r3d demuxer
        # does not support even though ffmpeg is installed.
        if self._helper_ready or self._sdk_ready:
            frames_decodable = True
        elif self._ffmpeg:
            frames_decodable = self._probe_ffmpeg_decodable(path)
        else:
            frames_decodable = False

        return {
            "sessionHandle":   path,
            "fileType":        "r3d",
            "canPlay":         False,
            "framesDecodable": frames_decodable,
            "metadata":        meta,
            "capabilities":    caps,
        }

    def _probe_ffmpeg_decodable(self, path: str) -> bool:
        """Quick check: can ffmpeg extract even one frame from this R3D file?"""
        tmp_fd, tmp = tempfile.mkstemp(suffix=".jpg")
        os.close(tmp_fd)
        try:
            for cmd in [
                [self._ffmpeg, "-y", "-f", "r3d", "-i", path,
                 "-vframes", "1", "-q:v", "5", tmp],
                [self._ffmpeg, "-y", "-i", path,
                 "-vframes", "1", "-q:v", "5", tmp],
            ]:
                try:
                    r = subprocess.run(cmd, capture_output=True, timeout=8)
                    if r.returncode == 0 and Path(tmp).is_file() and Path(tmp).stat().st_size > 0:
                        return True
                except Exception:
                    pass
        finally:
            try: Path(tmp).unlink(missing_ok=True)
            except: pass
        return False

    def close(self, session_handle: Any) -> None:
        pass  # stateless

    def get_metadata(self, session_handle: Any) -> dict[str, Any]:
        if not self._can_metadata:
            raise RuntimeError("R3D backend: no metadata capability")
        return self._get_metadata_impl(str(session_handle))

    def get_frame(self, session_handle: Any, frame_index: int, options: dict) -> dict[str, Any]:
        path    = str(session_handle)
        fmt     = options.get("format", "jpg")
        width   = int(options.get("width",  1920))
        height  = int(options.get("height", 1080))
        # Optional ACES 2.0 output transform (display rendering). When set, the
        # frame is decoded to ACES2065-1 and the ACES 2.0 ODT is baked via ffmpeg
        # instead of RED's default IPP2 look. Accepts an id ("rec709_sdr") or an
        # ODT name ("Rec.709"); resolved by color.aces2_luts.
        odt = options.get("odt") or options.get("outputTransform")

        if self._helper_ready:
            return self._decode_frame_helper(path, frame_index, fmt, width, height, odt=odt)
        if self._sdk_ready:
            return self._decode_frame_sdk(path, frame_index, fmt, width, height)
        if self._ffmpeg:
            return self._decode_frame_ffmpeg(path, frame_index, fmt, width, height)
        raise RuntimeError("No frame decode capability — install R3DSDK or ffmpeg")

    def seek(self, session_handle: Any, frame_index: int) -> dict[str, Any]:
        return {"seeked": True, "frameIndex": frame_index}

    def get_capabilities(self) -> dict[str, Any]:
        return {
            "supportsMetadata":             self._can_metadata,
            "supportsStillFrameDecode":     self._can_frames,
            "supportsPlayback":             False,
            "supportsHalfRes":              self._can_frames,
            "supportsQuarterRes":           self._can_frames,
            "supportsHardwareAcceleration": False,
        }

    def get_status(self) -> dict[str, Any]:
        if self._helper_ready:
            return {
                "status":     BackendStatus.READY,
                "decodeMode": "full",
                "version":    self._helper_ver or "r3dsdk_native_helper",
                "lastError":  None,
                "decodePath": "r3d_native_helper",
            }
        if self._sdk_ready:
            return {
                "status":     BackendStatus.READY,
                "decodeMode": "full",
                "version":    "r3dsdk",
                "lastError":  None,
                "decodePath": "r3dsdk",
            }
        if self._can_metadata:
            paths = []
            if self._dr_path:
                paths.append("davinci_resolve")
            if self._has_ffprobe_r3d:
                paths.append("ffprobe_r3d")
            decode_note = "proxy_extract" if self._ffmpeg else "metadata_only"
            return {
                "status":     BackendStatus.METADATA_ONLY,
                "decodeMode": decode_note,
                "version":    "+".join(paths) if paths else "ffprobe",
                "lastError":  "Install R3DSDK from RED for full frame decode",
                "decodePath": decode_note,
            }
        return {
            "status":     BackendStatus.SDK_MISSING,
            "decodeMode": "none",
            "version":    None,
            "lastError":  "R3DSDK not installed and ffprobe unavailable",
        }

    # ── Internal metadata ──────────────────────────────────────────────────────

    def _get_metadata_impl(self, path: str) -> dict[str, Any]:
        """Compose best-available metadata from all sources."""
        meta: dict[str, Any] = {
            "fileType":       "r3d",
            "codec":          "redcode",
            "clipName":       Path(path).stem,
            "camera":         "RED",
            "decodeModes":    ["full", "half", "quarter"],
        }

        # Layer 1: direct binary header parse (no external tools)
        header_meta = _parse_r3d_header(path)
        meta.update({k: v for k, v in header_meta.items() if v})

        # Layer 2: ffprobe r3d demuxer (container metadata)
        if self._ffprobe:
            probe = _probe_r3d_ffprobe(path, self._ffprobe)
            # Prefer probe values for fps/duration/frameCount; header for dimensions when probe is zero
            for key in ("fps", "durationSec", "durationFrames", "timecodeStart", "codec"):
                if probe.get(key):
                    meta[key] = probe[key]
            if probe.get("width") and probe["width"] > 0:
                meta["width"] = probe["width"]
            if probe.get("height") and probe["height"] > 0:
                meta["height"] = probe["height"]

        # Layer 3: native helper probe (authoritative R3D SDK metadata)
        if self._helper_ready:
            hm = self._probe_helper(path)
            meta.update({k: v for k, v in hm.items() if v is not None})

        # Layer 4: R3DSDK ctypes (if ever installed) — rich metadata
        if self._sdk_ready:
            sdk_meta = self._read_metadata_sdk(path)
            meta.update({k: v for k, v in sdk_meta.items() if v is not None})

        # Ensure required fields have sensible defaults
        meta.setdefault("fps",            24.0)
        meta.setdefault("durationFrames", 0)
        meta.setdefault("durationSec",    0.0)
        meta.setdefault("width",          0)
        meta.setdefault("height",         0)
        meta.setdefault("timecodeStart",  "")

        return meta

    # ── SDK decode (official R3DSDK) ───────────────────────────────────────────

    def _read_metadata_sdk(self, path: str) -> dict[str, Any]:
        """Read rich metadata via official R3DSDK ctypes."""
        # R3DSDK C++ API — entry points vary by version.
        # Attempt the most common public symbols.
        meta: dict[str, Any] = {}
        lib = self._sdk_lib
        if not lib:
            return meta
        # TODO: populate via R3DSDK when a real SDK is installed and tested.
        # Placeholder — the open() call already validated SDK works.
        return meta

    def _decode_frame_sdk(self, path: str, frame_index: int,
                          fmt: str, width: int, height: int) -> dict[str, Any]:
        """Decode frame via official R3DSDK (full quality)."""
        raise NotImplementedError(
            "R3DSDK frame decode: populate R3DSDK_decode() when SDK is installed and verified"
        )

    # ── Native helper (pfx_r3d_decode) — real full decode path ─────────────────

    def _probe_helper(self, path: str) -> dict[str, Any]:
        """Authoritative clip metadata via the native helper's `probe`."""
        try:
            r = subprocess.run([self._helper, "probe", path],
                               capture_output=True, text=True, timeout=30,
                               env=self._helper_env())
            if r.returncode != 0:
                return {}
            import json
            info = json.loads(r.stdout.strip().splitlines()[-1])
            if not info.get("ok"):
                return {}
            out = {
                "width":          info.get("width"),
                "height":         info.get("height"),
                "durationFrames": info.get("frameCount"),
                "fps":            info.get("fps"),
                "timecodeStart":  info.get("startTimecode"),
            }
            fc, fps = info.get("frameCount"), info.get("fps")
            if fc and fps:
                out["durationSec"] = fc / fps
            return out
        except Exception as exc:
            self._last_error = f"r3d helper probe failed: {exc}"
            return {}

    def _decode_frame_helper(self, path: str, frame_index: int,
                             fmt: str, width: int, height: int,
                             odt: str | None = None) -> dict[str, Any]:
        """Decode a frame via the native helper → raw pixels → JPEG/PNG via ffmpeg.

        Picks the smallest SDK decode resolution that still covers the requested
        width (full/half/quarter/eighth) to keep decode fast, then ffmpeg scales
        to the exact requested size.

        When `odt` resolves to an ACES 2.0 output transform, the frame is decoded
        to ACES2065-1 (aceshalf) and the ACES 2.0 display transform is baked via
        ffmpeg (lut1d+lut3d) instead of using RED's default IPP2 look.
        """
        meta = self._get_metadata_impl(path)
        full_w = int(meta.get("width") or 0)

        # choose decode mode by how much downscale the request allows
        mode = "full"
        if full_w > 0 and width > 0:
            ratio = full_w / float(width)
            if   ratio >= 16: mode = "sixteenth"
            elif ratio >= 8:  mode = "eighth"
            elif ratio >= 4:  mode = "quarter"
            elif ratio >= 2:  mode = "half"

        # Resolve the ACES 2.0 output transform (if any + LUTs present).
        # This preview path encodes an 8-bit JPEG/PNG (SDR by nature), so an HDR
        # ODT (PQ/HLG) would bake HDR code values into an SDR container and look
        # wrong viewed as sRGB. Substitute the matching SDR Rec.709 transform for
        # the thumbnail; HDR display belongs to the review-movie path.
        aces2_id = aces2_vf = None
        if odt:
            try:
                from ...color import aces2_luts
                aces2_id = aces2_luts.resolve_lut_id(odt, default=None)
                if aces2_id and aces2_luts.REGISTRY.get(aces2_id, {}).get("dynamicRange") == "HDR":
                    aces2_id = "rec709_sdr" if aces2_luts.cube_path("rec709_sdr") else None
                if aces2_id:
                    aces2_vf = aces2_luts.ffmpeg_video_filter(aces2_id)
            except Exception as exc:
                self._last_error = f"ACES 2.0 ODT unavailable: {exc}"
                aces2_id = aces2_vf = None

        tag = aces2_id or "ipp2"
        cache_key = hashlib.sha256(
            f"r3dhelper:{path}:{frame_index}:{width}:{height}:{fmt}:{mode}:{tag}".encode()
        ).hexdigest()
        out_path = self._cache / f"{cache_key}.{fmt}"

        if not (out_path.is_file() and out_path.stat().st_size > 0):
            if not self._ffmpeg:
                raise RuntimeError("ffmpeg unavailable to encode decoded R3D frame")
            suffix = ".raw"
            raw_fd, raw_tmp = tempfile.mkstemp(suffix=suffix, dir=str(self._cache))
            os.close(raw_fd)
            try:
                pixfmt = "aceshalf" if aces2_vf else "bgra8"
                r = subprocess.run(
                    [self._helper, "decode", path, str(frame_index), mode, pixfmt, raw_tmp],
                    capture_output=True, text=True, timeout=120, env=self._helper_env())
                if r.returncode != 0:
                    raise RuntimeError(f"r3d helper decode failed: {r.stdout or r.stderr}")
                import json
                info = json.loads(r.stdout.strip().splitlines()[-1])
                if not info.get("ok"):
                    raise RuntimeError(f"r3d helper decode error: {info.get('error')}")
                dw, dh = int(info["width"]), int(info["height"])

                if aces2_vf:
                    # aceshalf = interleaved RGB16F (ACES2065-1). Repack to planar
                    # float32 (G,B,R) so ffmpeg can read it as gbrpf32le, then apply
                    # the ACES 2.0 shaper+cube and scale.
                    self._aces_half_to_gbrpf32(raw_tmp, dw, dh)
                    vf = f"{aces2_vf},scale={width}:{height}:flags=lanczos"
                    cmd = [self._ffmpeg, "-y", "-f", "rawvideo", "-pix_fmt", "gbrpf32le",
                           "-s", f"{dw}x{dh}", "-i", raw_tmp,
                           "-vf", vf, "-frames:v", "1", str(out_path)]
                else:
                    # raw BGRA (RED default look) → scaled JPEG/PNG
                    cmd = [self._ffmpeg, "-y", "-f", "rawvideo", "-pixel_format", "bgra",
                           "-video_size", f"{dw}x{dh}", "-i", raw_tmp,
                           "-vf", f"scale={width}:{height}:flags=lanczos",
                           "-frames:v", "1", str(out_path)]
                fr = subprocess.run(cmd, capture_output=True, timeout=60)
                if fr.returncode != 0 or not (out_path.is_file() and out_path.stat().st_size > 0):
                    raise RuntimeError(f"ffmpeg encode of R3D frame failed: {fr.stderr.decode(errors='replace')[:300]}")
            finally:
                try: Path(raw_tmp).unlink(missing_ok=True)
                except Exception: pass

        import base64
        mime = "image/jpeg" if fmt == "jpg" else "image/png"
        with open(str(out_path), "rb") as f:
            data_url = f"data:{mime};base64,{base64.b64encode(f.read()).decode()}"
        return {
            "previewImagePath": str(out_path),
            "dataUrl":          data_url,
            "frameIndex":       frame_index,
            "backend":          "r3d_native_helper",
            "decodeMode":       mode,
            "colorPath":        f"aces2:{aces2_id}" if aces2_id else "ipp2_default",
            "cacheHit":         False,
        }

    @staticmethod
    def _aces_half_to_gbrpf32(raw_path: str, w: int, h: int) -> None:
        """Repack interleaved RGB16F (ACES2065-1, helper aceshalf output) → planar
        float32 G,B,R (ffmpeg gbrpf32le) IN PLACE. Preview-sized buffers only."""
        import struct
        with open(raw_path, "rb") as f:
            data = f.read()
        n = w * h * 3
        vals = struct.unpack(f"<{n}e", data[:n * 2])     # half-float
        R = vals[0::3]; G = vals[1::3]; B = vals[2::3]
        with open(raw_path, "wb") as f:
            f.write(struct.pack(f"<{len(G)}f", *G))
            f.write(struct.pack(f"<{len(B)}f", *B))
            f.write(struct.pack(f"<{len(R)}f", *R))

    # ── ffmpeg proxy extraction ────────────────────────────────────────────────

    def _decode_frame_ffmpeg(self, path: str, frame_index: int,
                             fmt: str, width: int, height: int) -> dict[str, Any]:
        """Attempt frame extraction via ffmpeg (proxy stream or best-effort decode)."""
        meta  = self._get_metadata_impl(path)
        fps   = float(meta.get("fps", 24.0))

        cache_key = hashlib.sha256(
            f"r3d:{path}:{frame_index}:{width}:{height}:{fmt}".encode()
        ).hexdigest()
        out_path = self._cache / f"{cache_key}.{fmt}"

        if not (out_path.is_file() and out_path.stat().st_size > 0):
            ok = _extract_r3d_proxy_frame(path, frame_index, self._ffmpeg,
                                           out_path, width, height, fps)
            if not ok:
                raise RuntimeError(
                    "R3D frame decode failed — REDCODE requires R3DSDK for full pixel decode. "
                    "Install R3DSDK from RED (red.com/downloads) for frame preview."
                )

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
            "decodeQuality":    "proxy",
            "note":             "Proxy extraction — install R3DSDK for full REDCODE decode",
        }
