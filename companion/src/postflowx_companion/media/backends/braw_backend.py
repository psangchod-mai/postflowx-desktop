"""BRAW backend — Blackmagic RAW SDK via ctypes (Phase 3).

Uses the BlackmagicRawAPI.framework embedded in DaVinci Resolve (or the
standalone BRAW SDK if installed).  All SDK calls go through ctypes with
explicit vtable navigation so no compilation is required.

Capabilities:
  - open .braw files
  - read metadata (width, height, fps, frame count, timecode, color science)
  - still-frame decode → JPEG via BRAW SDK + Pillow
  - seek / frame step
  - reports sdk_missing when framework is not installed
"""
from __future__ import annotations

import ctypes
import hashlib
import os
import platform
import struct
import tempfile
import threading
from pathlib import Path
from typing import Any

from ..media_types import Backend, BackendStatus
from .base_backend import BaseMediaBackend

# ---------------------------------------------------------------------------
# SDK detection paths (macOS)
# ---------------------------------------------------------------------------
_SDK_PATHS_MACOS = [
    # Bundled inside DaVinci Resolve
    "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Frameworks/BlackmagicRawAPI.framework/BlackmagicRawAPI",
    # Standalone BRAW SDK installer
    "/Library/Application Support/Blackmagic Design/Blackmagic RAW/BlackmagicRawAPI.framework/BlackmagicRawAPI",
    "/Library/Frameworks/BlackmagicRawAPI.framework/BlackmagicRawAPI",
]
# Windows paths (Phase 3+)
_SDK_PATHS_WINDOWS = [
    r"C:\Program Files\Blackmagic Design\Blackmagic RAW\Blackmagic RAW SDK\Win\BlackmagicRawAPI.dll",
]

# HRESULT S_OK
_S_OK = 0x00000000

# ---------------------------------------------------------------------------
# vtable helpers
# ---------------------------------------------------------------------------

def _vtable(obj_ptr: int) -> ctypes.Array:
    """Return the vtable pointer array for a COM object."""
    vtptr = ctypes.cast(obj_ptr, ctypes.POINTER(ctypes.c_uint64))[0]
    return ctypes.cast(vtptr, ctypes.POINTER(ctypes.c_uint64))


def _call(obj_ptr: int, slot: int, restype, *argtypes_and_args):
    """Call vtable[slot] on obj_ptr with (obj_ptr, *args)."""
    # argtypes_and_args = interleaved (argtype, arg) pairs after restype
    it  = iter(argtypes_and_args)
    pairs = list(zip(it, it))
    argtypes = [ctypes.c_void_p] + [t for t, _ in pairs]
    args     = [obj_ptr]         + [a for _, a in pairs]
    vt = _vtable(obj_ptr)
    fn = ctypes.CFUNCTYPE(restype, *argtypes)(vt[slot])
    return fn(*args)


def _release(obj_ptr: int) -> None:
    """Release a COM object (vtable slot 2)."""
    if obj_ptr:
        try:
            _call(obj_ptr, 2, ctypes.c_uint32)
        except Exception:
            pass

# ---------------------------------------------------------------------------
# BRAW SDK vtable slot constants (from SDK documentation)
# ---------------------------------------------------------------------------
# IBlackmagicRawFactory
_FACTORY_CreateCodec    = 3   # (this, **IBlackmagicRaw) → HRESULT

# IBlackmagicRaw
_RAW_OpenClip           = 3   # (this, path_utf8, **IBlackmagicRawClip) → HRESULT
_RAW_SetCallback        = 4   # (this, *IBlackmagicRawCallback) → HRESULT
_RAW_FlushJobs          = 5   # (this) → void
_RAW_CreateJobReadFrame = 6   # (this, *clip, frameIdx, **job) → HRESULT

# IBlackmagicRawClip
_CLIP_GetWidth          = 3   # (this, *uint32) → HRESULT
_CLIP_GetHeight         = 4   # (this, *uint32) → HRESULT
_CLIP_GetFrameRate      = 5   # (this, *float) → HRESULT
_CLIP_GetFrameCount     = 6   # (this, *uint64) → HRESULT
_CLIP_GetTimecodeForFrame = 7 # (this, uint64, **IBlackmagicRawTimecode) → HRESULT
_CLIP_GetMetadata       = 8   # (this, **IBlackmagicRawMetadataIterator) → HRESULT

# IBlackmagicRawJob
_JOB_Submit             = 3   # (this) → HRESULT

# IBlackmagicRawFrame
_FRAME_GetBytes         = 3   # (this, *uint32 w, *uint32 h, *uint32 bpr, **void data) → HRESULT
_FRAME_GetResourceType  = 6   # (this, *BMD_RESOURCE_TYPE) → HRESULT

# IBlackmagicRawTimecode
_TC_GetString           = 3   # (this, **const char) → HRESULT

# BRAW SDK resource-type codes (from _BlackmagicRawResourceFormat) whose pixel
# layout is BGRA rather than RGBA — the decoded byte order is platform/GPU
# dependent, so it must be read via GetResourceType() rather than assumed.
_BGRA_RESOURCE_TYPES = {1, 8}


def _raw_mode_for_resource_type(resource_type: int) -> str:
    """Map an IBlackmagicRawFrame::GetResourceType() code to a PIL raw mode."""
    return "BGRA" if resource_type in _BGRA_RESOURCE_TYPES else "RGBA"


# ---------------------------------------------------------------------------
# Callback shim
# ---------------------------------------------------------------------------

class _FrameCallback:
    """Minimal COM-style callback that captures decoded frame bytes."""

    def __init__(self):
        self.event  = threading.Event()
        self.result = None    # (width, height, bytes_per_row, raw_bytes, resource_type) or None
        self.error  = None    # HRESULT error code

        # Build a COM object in memory:
        # [vtable_ptr][_vtable_storage_ptr]
        # We need ReadComplete at vtable slot 5 (others are no-ops).
        N = 8  # vtable has 8 slots (0=QI, 1=AddRef, 2=Release, 3=ReadProgress,
                #                    4=ReadComplete, 5=DecodeComplete, 6=ProcessComplete, 7=TrimProgress)
        # Function type for ReadComplete:
        # ReadComplete(this, job, result, frame) → void
        ReadCompleteFn = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p,
                                          ctypes.c_uint32, ctypes.c_void_p)
        NoopFn = ctypes.CFUNCTYPE(None, ctypes.c_void_p)

        def _noop(this):
            pass
        def _noop2(this, a, b, c):
            pass
        def _read_complete(this, job, result, frame):
            if result == _S_OK and frame:
                try:
                    w, h, bpr = ctypes.c_uint32(), ctypes.c_uint32(), ctypes.c_uint32()
                    data_ptr  = ctypes.c_void_p()
                    hr = _call(frame, _FRAME_GetBytes, ctypes.c_uint32,
                               ctypes.POINTER(ctypes.c_uint32), ctypes.byref(w),
                               ctypes.POINTER(ctypes.c_uint32), ctypes.byref(h),
                               ctypes.POINTER(ctypes.c_uint32), ctypes.byref(bpr),
                               ctypes.POINTER(ctypes.c_void_p), ctypes.byref(data_ptr))
                    if hr == _S_OK and data_ptr.value:
                        n_bytes = h.value * bpr.value
                        raw = bytes(ctypes.cast(data_ptr.value, ctypes.POINTER(ctypes.c_ubyte * n_bytes))[0])

                        resource_type = ctypes.c_uint32(0)
                        rt_hr = _call(frame, _FRAME_GetResourceType, ctypes.c_uint32,
                                      ctypes.POINTER(ctypes.c_uint32), ctypes.byref(resource_type))
                        rt_val = resource_type.value if rt_hr == _S_OK else 0

                        self.result = (w.value, h.value, bpr.value, raw, rt_val)
                    else:
                        self.error = hr if hr != _S_OK else -1
                except Exception as e:
                    self.error = str(e)
            else:
                self.error = result if result != _S_OK else -1
            self.event.set()

        self._noop_fn    = NoopFn(_noop)
        self._noop2_fn   = ReadCompleteFn(_noop2)
        self._rc_fn      = ReadCompleteFn(_read_complete)

        self._vtable_arr = (ctypes.c_void_p * N)(
            ctypes.cast(self._noop_fn, ctypes.c_void_p).value,   # 0 QI
            ctypes.cast(self._noop_fn, ctypes.c_void_p).value,   # 1 AddRef
            ctypes.cast(self._noop_fn, ctypes.c_void_p).value,   # 2 Release
            ctypes.cast(self._noop2_fn, ctypes.c_void_p).value,  # 3 ReadProgress
            ctypes.cast(self._rc_fn, ctypes.c_void_p).value,     # 4 ReadComplete
            ctypes.cast(self._noop2_fn, ctypes.c_void_p).value,  # 5 DecodeComplete
            ctypes.cast(self._noop2_fn, ctypes.c_void_p).value,  # 6 ProcessComplete
            ctypes.cast(self._noop_fn, ctypes.c_void_p).value,   # 7 TrimProgress
        )
        self._vtable_ptr = ctypes.pointer(self._vtable_arr)
        # COM object: [ptr to vtable][reserved]
        self._obj = (ctypes.c_void_p * 2)(
            ctypes.cast(self._vtable_ptr, ctypes.c_void_p).value,
            0,
        )
        self.ptr = ctypes.cast(self._obj, ctypes.c_void_p).value

# ---------------------------------------------------------------------------
# BrawBackend
# ---------------------------------------------------------------------------

class BrawBackend(BaseMediaBackend):
    """
    Blackmagic RAW backend using the BRAW SDK via ctypes.

    Supports: open, metadata (width/height/fps/frameCount/timecode),
              still-frame decode → JPEG, seek.
    """

    def __init__(self, cache_dir: Path | None = None):
        self._sdk_path  = self._detect_sdk()
        self._lib       = None
        self._factory   = None  # int (ptr)
        self._codec     = None  # int (ptr)
        self._cache     = cache_dir or Path(tempfile.gettempdir()) / "pfx_braw_frames"
        self._lock      = threading.Lock()
        self._last_error: str | None = None

        if self._sdk_path:
            self._try_init_sdk()

    # ── SDK detection ─────────────────────────────────────────────────────────
    def _detect_sdk(self) -> str | None:
        paths = _SDK_PATHS_MACOS if platform.system() == "Darwin" else _SDK_PATHS_WINDOWS
        for p in paths:
            if os.path.isfile(p):
                return p
        return None

    def _try_init_sdk(self) -> bool:
        try:
            self._lib = ctypes.CDLL(self._sdk_path)
            self._lib.CreateBlackmagicRawFactoryInstance.restype  = ctypes.c_void_p
            self._lib.CreateBlackmagicRawFactoryInstance.argtypes = []
            factory = self._lib.CreateBlackmagicRawFactoryInstance()
            if not factory:
                self._last_error = "CreateBlackmagicRawFactoryInstance returned NULL"
                return False
            self._factory = factory

            # Create codec (IBlackmagicRaw)
            codec_ptr = ctypes.c_void_p()
            hr = _call(factory, _FACTORY_CreateCodec, ctypes.c_uint32,
                       ctypes.POINTER(ctypes.c_void_p), ctypes.byref(codec_ptr))
            if hr != _S_OK or not codec_ptr.value:
                self._last_error = f"CreateCodec failed: {hex(hr)}"
                return False
            self._codec = codec_ptr.value
            self._cache.mkdir(parents=True, exist_ok=True)
            return True
        except Exception as exc:
            self._last_error = str(exc)
            return False

    @property
    def _sdk_ready(self) -> bool:
        return bool(self._codec)

    # ── BaseMediaBackend interface ─────────────────────────────────────────────

    @property
    def backend_key(self) -> str:
        return Backend.BRAW_SDK

    def can_open(self, path: str) -> bool:
        return Path(path).suffix.lower() == ".braw" and self._sdk_ready

    def open(self, path: str, options: dict) -> dict[str, Any]:
        if not self._sdk_ready:
            raise RuntimeError(f"BRAW SDK not ready: {self._last_error}")
        if not Path(path).is_file():
            raise FileNotFoundError(f"File not found: {path}")

        clip_ptr = self._open_clip(path)
        if not clip_ptr:
            raise RuntimeError(f"BRAW OpenClip failed: {path}")

        meta = self._read_clip_metadata(clip_ptr, path)
        _release(clip_ptr)

        caps = self.get_capabilities()
        return {
            "sessionHandle": path,   # stateless — path is sufficient
            "fileType":      "braw",
            "canPlay":       False,  # direct stream not supported; use getFrame for preview
            "metadata":      meta,
            "capabilities":  caps,
        }

    def close(self, session_handle: Any) -> None:
        pass  # stateless

    def get_metadata(self, session_handle: Any) -> dict[str, Any]:
        if not self._sdk_ready:
            raise RuntimeError("BRAW SDK not ready")
        clip_ptr = self._open_clip(str(session_handle))
        if not clip_ptr:
            raise RuntimeError(f"Could not open BRAW clip: {session_handle}")
        meta = self._read_clip_metadata(clip_ptr, str(session_handle))
        _release(clip_ptr)
        return meta

    def get_frame(self, session_handle: Any, frame_index: int, options: dict) -> dict[str, Any]:
        if not self._sdk_ready:
            raise RuntimeError("BRAW SDK not ready")
        path    = str(session_handle)
        fmt     = options.get("format", "jpg")
        width   = int(options.get("width",  1920))
        height  = int(options.get("height", 1080))
        quality = options.get("quality", "half")

        # Cache key
        cache_key = hashlib.sha256(
            f"braw:{path}:{frame_index}:{quality}:{width}:{height}:{fmt}".encode()
        ).hexdigest()
        out_path = self._cache / f"{cache_key}.{fmt}"

        if not (out_path.is_file() and out_path.stat().st_size > 0):
            raw_rgba = self._decode_frame_rgba(path, frame_index)
            if raw_rgba is None:
                raise RuntimeError(f"BRAW frame decode failed for frame {frame_index}")
            self._save_frame(raw_rgba, out_path, fmt, width, height)

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
            "cacheHit":         False,
        }

    def seek(self, session_handle: Any, frame_index: int) -> dict[str, Any]:
        return {"seeked": True, "frameIndex": frame_index}

    def get_capabilities(self) -> dict[str, Any]:
        ok = self._sdk_ready
        return {
            "supportsMetadata":             ok,
            "supportsStillFrameDecode":     ok,
            "supportsPlayback":             False,
            "supportsHalfRes":              ok,
            "supportsQuarterRes":           ok,
            "supportsHardwareAcceleration": False,
        }

    def get_status(self) -> dict[str, Any]:
        if not self._sdk_path:
            return {
                "status":     BackendStatus.SDK_MISSING,
                "decodeMode": "none",
                "version":    None,
                "lastError":  "BRAW SDK not found — install DaVinci Resolve or standalone BRAW SDK",
            }
        if not self._sdk_ready:
            return {
                "status":     BackendStatus.SDK_MISSING,
                "decodeMode": "none",
                "version":    None,
                "lastError":  self._last_error or "SDK load failed",
            }
        return {
            "status":     BackendStatus.READY,
            "decodeMode": "full",
            "version":    "blackmagicraw_sdk",
            "lastError":  None,
        }

    # ── Internal SDK helpers ──────────────────────────────────────────────────

    def _open_clip(self, path: str) -> int | None:
        """Open a BRAW clip and return IBlackmagicRawClip pointer, or None on failure."""
        path_bytes = path.encode("utf-8") + b"\x00"
        clip_ptr = ctypes.c_void_p()
        try:
            hr = _call(self._codec, _RAW_OpenClip, ctypes.c_uint32,
                       ctypes.c_char_p, path_bytes,
                       ctypes.POINTER(ctypes.c_void_p), ctypes.byref(clip_ptr))
            if hr != _S_OK or not clip_ptr.value:
                return None
            return clip_ptr.value
        except Exception:
            return None

    def _read_clip_metadata(self, clip_ptr: int, path: str) -> dict[str, Any]:
        """Read metadata from an open IBlackmagicRawClip."""
        meta: dict[str, Any] = {
            "fileType": "braw",
            "codec":    "braw",
            "path":     path,
            "clipName": Path(path).stem,
            "decodeModes": ["full", "half", "quarter"],
        }
        try:
            w = ctypes.c_uint32()
            h = ctypes.c_uint32()
            fps_f = ctypes.c_float()
            n_frames = ctypes.c_uint64()

            _call(clip_ptr, _CLIP_GetWidth,      ctypes.c_uint32,
                  ctypes.POINTER(ctypes.c_uint32), ctypes.byref(w))
            _call(clip_ptr, _CLIP_GetHeight,     ctypes.c_uint32,
                  ctypes.POINTER(ctypes.c_uint32), ctypes.byref(h))
            _call(clip_ptr, _CLIP_GetFrameRate,  ctypes.c_uint32,
                  ctypes.POINTER(ctypes.c_float),  ctypes.byref(fps_f))
            _call(clip_ptr, _CLIP_GetFrameCount, ctypes.c_uint32,
                  ctypes.POINTER(ctypes.c_uint64), ctypes.byref(n_frames))

            fps = round(float(fps_f.value), 3)
            meta.update({
                "width":          int(w.value),
                "height":         int(h.value),
                "fps":            fps,
                "durationFrames": int(n_frames.value),
                "durationSec":    round(n_frames.value / fps, 3) if fps > 0 else 0.0,
            })

            # Timecode for frame 0
            tc_ptr = ctypes.c_void_p()
            hr = _call(clip_ptr, _CLIP_GetTimecodeForFrame, ctypes.c_uint32,
                       ctypes.c_uint64, ctypes.c_uint64(0),
                       ctypes.POINTER(ctypes.c_void_p), ctypes.byref(tc_ptr))
            if hr == _S_OK and tc_ptr.value:
                try:
                    tc_str_ptr = ctypes.c_char_p()
                    _call(tc_ptr.value, _TC_GetString, ctypes.c_uint32,
                          ctypes.POINTER(ctypes.c_char_p), ctypes.byref(tc_str_ptr))
                    if tc_str_ptr.value:
                        meta["timecodeStart"] = tc_str_ptr.value.decode("utf-8", errors="replace")
                except Exception:
                    pass
                finally:
                    _release(tc_ptr.value)

        except Exception as exc:
            meta["metaError"] = str(exc)

        return meta

    def _decode_frame_rgba(self, path: str, frame_index: int) -> tuple[int, int, int, bytes, int] | None:
        """
        Decode one frame to raw pixel bytes using the BRAW SDK async pipeline.
        Returns (width, height, bytes_per_row, raw_bytes, resource_type) or None on failure.
        """
        # _codec.SetCallback + FlushJobs is not reentrant — serialize all SDK calls.
        with self._lock:
            return self._decode_frame_rgba_locked(path, frame_index)

    def _decode_frame_rgba_locked(self, path: str, frame_index: int) -> tuple[int, int, int, bytes, int] | None:
        clip_ptr = self._open_clip(path)
        if not clip_ptr:
            return None

        cb = _FrameCallback()
        try:
            # Set callback on the codec
            hr = _call(self._codec, _RAW_SetCallback, ctypes.c_uint32,
                       ctypes.c_void_p, ctypes.c_void_p(cb.ptr))
            if hr != _S_OK:
                return None

            # Create and submit a read-frame job
            job_ptr = ctypes.c_void_p()
            hr = _call(self._codec, _RAW_CreateJobReadFrame, ctypes.c_uint32,
                       ctypes.c_void_p, ctypes.c_void_p(clip_ptr),
                       ctypes.c_uint64, ctypes.c_uint64(frame_index),
                       ctypes.POINTER(ctypes.c_void_p), ctypes.byref(job_ptr))
            if hr != _S_OK or not job_ptr.value:
                return None

            hr = _call(job_ptr.value, _JOB_Submit, ctypes.c_uint32)
            _release(job_ptr.value)
            if hr != _S_OK:
                return None

            # Process jobs synchronously (FlushJobs blocks until callback fires)
            vt = _vtable(self._codec)
            flush_fn = ctypes.CFUNCTYPE(None, ctypes.c_void_p)(vt[_RAW_FlushJobs])
            flush_fn(self._codec)

            # Wait for callback (should already be done after FlushJobs, but be safe)
            cb.event.wait(timeout=30)

            return cb.result  # (w, h, bpr, raw_bytes, resource_type) or None

        except Exception:
            return None
        finally:
            _release(clip_ptr)

    def _save_frame(self, raw_rgba: tuple, out_path: Path, fmt: str, target_w: int, target_h: int) -> None:
        """Convert raw pixel bytes → scaled JPEG/PNG saved to out_path."""
        w, h, bpr, data, resource_type = raw_rgba
        try:
            from PIL import Image
            import io
            # BRAW SDK returns BGRA or RGBA depending on platform/GPU — read the
            # actual byte order from GetResourceType() instead of assuming RGBA.
            raw_mode = _raw_mode_for_resource_type(resource_type)
            img = Image.frombytes("RGBA", (w, h), data, "raw", raw_mode, bpr)
            img = img.resize((target_w, target_h), Image.LANCZOS)
            tmp_fd, tmp_path = tempfile.mkstemp(suffix=f".{fmt}", dir=str(out_path.parent))
            os.close(tmp_fd)
            try:
                if fmt == "jpg":
                    img.convert("RGB").save(tmp_path, "JPEG", quality=88)
                else:
                    img.save(tmp_path, "PNG")
                os.replace(tmp_path, str(out_path))
            finally:
                try: Path(tmp_path).unlink(missing_ok=True)
                except: pass
        except ImportError:
            # Pillow not available — write raw pixels as PPM fallback, convert with ffmpeg
            self._save_frame_via_ffmpeg(w, h, bpr, data, resource_type, out_path, fmt, target_w, target_h)

    def _save_frame_via_ffmpeg(self, w, h, bpr, data, resource_type, out_path, fmt, target_w, target_h):
        """Fallback: write raw pixels then convert with ffmpeg."""
        import subprocess
        ffmpeg = _find_ffmpeg_cached()
        if not ffmpeg:
            raise RuntimeError("Neither Pillow nor ffmpeg available for frame save")
        raw_path = out_path.with_suffix(".raw")
        raw_path.write_bytes(data)
        pix_fmt = "bgra" if resource_type in _BGRA_RESOURCE_TYPES else "rgba"
        tmp_fd, tmp_path = tempfile.mkstemp(suffix=f".{fmt}", dir=str(out_path.parent))
        os.close(tmp_fd)
        try:
            cmd = [
                ffmpeg, "-y",
                "-f", "rawvideo", "-pix_fmt", pix_fmt,
                "-video_size", f"{w}x{h}",
                "-i", str(raw_path),
                "-vf", f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease",
                "-frames:v", "1",
                tmp_path,
            ]
            subprocess.run(cmd, capture_output=True, timeout=30, check=True)
            os.replace(tmp_path, str(out_path))
        finally:
            try: raw_path.unlink(missing_ok=True)
            except: pass
            try: Path(tmp_path).unlink(missing_ok=True)
            except: pass


def _find_ffmpeg_cached():
    """Try to find ffmpeg — used only as Pillow fallback."""
    from ...proxy_service import _find_ffmpeg as ff
    return ff()
