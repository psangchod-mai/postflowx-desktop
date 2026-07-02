from __future__ import annotations

import os
import sys
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

# ── SDK detection ─────────────────────────────────────────────────────────────

@dataclass
class SdkStatus:
    braw:   bool = False
    red:    bool = False
    arri:   bool = False
    canon:  bool = False
    avf:    bool = False
    mpv:    bool = False
    ffmpeg: bool = False
    resolve: bool = False

    braw_path:   str = ""
    red_path:    str = ""
    arri_path:   str = ""
    canon_path:  str = ""
    avf_path:    str = ""
    mpv_path:    str = ""
    ffmpeg_path: str = ""
    resolve_path: str = ""


@lru_cache(maxsize=1)
def sdk_status() -> SdkStatus:
    s = SdkStatus()
    s.avf, s.avf_path = _check_avf()
    # Bundled ffmpeg (Dev Brief P0#2) wins over Homebrew: a GUI-launched companion
    # has a stripped PATH and no /opt/homebrew, so a Homebrew-only check would wrongly
    # report ffmpeg unavailable in the packaged app.
    _ff_cands = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"]
    try:
        from ..proxy_service import _resource_bin
        _bundled_ff = _resource_bin("ffmpeg")
        if _bundled_ff:
            _ff_cands.insert(0, _bundled_ff)
    except Exception:
        pass
    s.ffmpeg, s.ffmpeg_path = _check_bin("ffmpeg", _ff_cands)
    s.mpv, s.mpv_path = _check_bin("mpv",
        ["/opt/homebrew/bin/mpv", "/usr/local/bin/mpv"])
    s.resolve, s.resolve_path = _check_resolve()
    s.braw,   s.braw_path  = _check_braw_sdk()
    s.red,    s.red_path   = _check_red_sdk()
    s.arri,   s.arri_path  = _check_arri_sdk()
    s.canon,  s.canon_path = _check_canon_sdk()
    return s


def refresh_sdk_status() -> SdkStatus:
    sdk_status.cache_clear()
    return sdk_status()


# ── SDK probe helpers ─────────────────────────────────────────────────────────

def _check_bin(name: str, candidates: list[str]) -> tuple[bool, str]:
    import shutil
    for p in candidates:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return True, p
    found = shutil.which(name)
    if found:
        return True, found
    return False, ""


def _check_avf() -> tuple[bool, str]:
    # avf_bridge binary shipped with the app
    candidates = [
        Path(__file__).parents[5] / "electron" / "native" / "avf_bridge",
        Path(__file__).parents[5] / "app.asar.unpacked" / "electron" / "native" / "avf_bridge",
    ]
    for p in candidates:
        if p.is_file() and os.access(str(p), os.X_OK):
            return True, str(p)
    return False, ""


def _check_resolve() -> tuple[bool, str]:
    app = Path("/Applications/DaVinci Resolve/DaVinci Resolve.app")
    return app.exists(), str(app) if app.exists() else ""


def _check_braw_sdk() -> tuple[bool, str]:
    candidates = [
        Path("/Library/Application Support/Blackmagic Design/Blackmagic RAW/BlackmagicRawAPI.framework"),
        Path("/Library/Frameworks/BlackmagicRawAPI.framework"),
    ]
    for p in candidates:
        if p.exists():
            return True, str(p)
    return False, ""


def _check_red_sdk() -> tuple[bool, str]:
    candidates = [
        Path("/Library/R3D SDK"),
        Path("/Applications/REDCINE-X PRO.app"),
        Path("/usr/local/lib/libR3DSDK.dylib"),
    ]
    for p in candidates:
        if p.exists():
            return True, str(p)
    return False, ""


def _check_arri_sdk() -> tuple[bool, str]:
    candidates = [
        Path("/Library/Application Support/ARRI/ArriRawSDK"),
        Path("/Library/Application Support/ARRI"),
        Path("/Applications/ARRI Meta Extract.app"),
    ]
    for p in candidates:
        if p.exists():
            return True, str(p)
    return False, ""


def _check_canon_sdk() -> tuple[bool, str]:
    candidates = [
        Path("/Library/Application Support/Canon/Cinema EOS RAW Development"),
        Path("/Applications/Canon Cinema RAW Development.app"),
        Path("/Library/Frameworks/CRMF.framework"),
    ]
    for p in candidates:
        if p.exists():
            return True, str(p)
    return False, ""


# ── Engine name constants ─────────────────────────────────────────────────────

ENGINE_AVF        = "NativeAVFoundationEngine"
ENGINE_BRAW_SDK   = "BRAWSDKEngine"
ENGINE_RED_SDK    = "REDSDKEngine"
ENGINE_ARRI_SDK   = "ARRISDKEngine"
ENGINE_CANON_SDK  = "CanonRawSDKEngine"
ENGINE_MPV        = "MPVEngine"
ENGINE_FFMPEG_FS  = "FFmpegFrameServer"
ENGINE_RESOLVE    = "ResolveEngine"
ENGINE_PROXY      = "ProxyEngine"

_ENGINE_ORDER = [
    ENGINE_AVF, ENGINE_BRAW_SDK, ENGINE_RED_SDK, ENGINE_ARRI_SDK,
    ENGINE_CANON_SDK, ENGINE_MPV, ENGINE_FFMPEG_FS, ENGINE_RESOLVE, ENGINE_PROXY,
]


def _fallbacks_for(engine: str) -> list[str]:
    try:
        idx = _ENGINE_ORDER.index(engine)
        return [e for e in _ENGINE_ORDER[idx + 1:] if e != engine]
    except ValueError:
        return [ENGINE_PROXY]


def select_ocf_engine(
    probe: dict[str, Any],
    force_engine: str | None = None,
) -> tuple[str, list[str], str]:
    """
    Returns (selected_engine, fallback_engines, reason).

    probe keys used:
      cameraFamily, container, codec, codecTag, kind, format (optional)
    """
    if force_engine:
        return force_engine, _fallbacks_for(force_engine), "user_override"

    sdk = sdk_status()

    family    = (probe.get("cameraFamily") or "").strip()
    container = (probe.get("container")    or "").lower().strip()
    codec     = (probe.get("codec")        or "").lower().strip()
    codec_tag = (probe.get("codecTag")     or "").lower().strip()
    kind      = (probe.get("kind")         or "ocf_file").lower().strip()

    _is_macos = sys.platform == "darwin"

    # ── Image sequences ───────────────────────────────────────────────────────
    if kind == "image_sequence" or container == "image_sequence":
        if sdk.ffmpeg:
            return ENGINE_FFMPEG_FS, [ENGINE_PROXY], "image_sequence_ffmpeg"
        return ENGINE_PROXY, [], "image_sequence_no_ffmpeg"

    # ── ProRes / H264 / HEVC in MOV (macOS native) ───────────────────────────
    _prores_codecs = {"prores", "apcn", "apco", "apcs", "apch", "ap4h", "ap4x", "apns", "ap4c"}
    _native_codecs = {"h264", "avc1", "hevc", "hvc1"} | _prores_codecs
    if _is_macos and container in ("mov", "mp4", "m4v") and (
            codec in _native_codecs or codec_tag in _prores_codecs):
        if sdk.avf:
            return ENGINE_AVF, [ENGINE_MPV, ENGINE_FFMPEG_FS, ENGINE_PROXY], "macos_avf_native"
        if sdk.mpv:
            return ENGINE_MPV, [ENGINE_FFMPEG_FS, ENGINE_PROXY], "mpv_prores_mov"
        if sdk.ffmpeg:
            return ENGINE_FFMPEG_FS, [ENGINE_PROXY], "ffmpeg_prores_mov"

    # ── ProRes / DNxHR in MXF ─────────────────────────────────────────────────
    _dnx_codecs = {"dnxhd", "dnxhr", "dnxhd444"}
    if container == "mxf" and (codec in _prores_codecs or codec in _dnx_codecs):
        if sdk.mpv:
            return ENGINE_MPV, [ENGINE_FFMPEG_FS, ENGINE_PROXY], "mxf_prores_dnx_mpv"
        if sdk.ffmpeg:
            return ENGINE_FFMPEG_FS, [ENGINE_PROXY], "mxf_prores_dnx_ffmpeg"

    # ── Blackmagic RAW ────────────────────────────────────────────────────────
    if family == "Blackmagic" or codec in ("braw",):
        if sdk.braw:
            return ENGINE_BRAW_SDK, [ENGINE_RESOLVE, ENGINE_PROXY], "braw_sdk"
        if sdk.resolve:
            return ENGINE_RESOLVE, [ENGINE_PROXY], "braw_resolve_fallback"
        return ENGINE_PROXY, [], "braw_proxy_fallback"

    # ── RED R3D ───────────────────────────────────────────────────────────────
    if family == "RED" or codec in ("redcode", "r3d"):
        if sdk.red:
            return ENGINE_RED_SDK, [ENGINE_RESOLVE, ENGINE_PROXY], "red_sdk"
        if sdk.resolve:
            return ENGINE_RESOLVE, [ENGINE_PROXY], "red_resolve_fallback"
        return ENGINE_PROXY, [], "red_proxy_fallback"

    # ── ARRI RAW ──────────────────────────────────────────────────────────────
    if family == "ARRI" or codec in ("arriraw",):
        if sdk.arri:
            return ENGINE_ARRI_SDK, [ENGINE_RESOLVE, ENGINE_PROXY], "arri_sdk"
        if sdk.resolve:
            return ENGINE_RESOLVE, [ENGINE_PROXY], "arri_resolve_fallback"
        return ENGINE_PROXY, [], "arri_proxy_fallback"

    # ── Canon Cinema RAW ──────────────────────────────────────────────────────
    if family == "Canon":
        if sdk.canon:
            return ENGINE_CANON_SDK, [ENGINE_RESOLVE, ENGINE_PROXY], "canon_sdk"
        if sdk.resolve:
            return ENGINE_RESOLVE, [ENGINE_PROXY], "canon_resolve_fallback"
        return ENGINE_PROXY, [], "canon_proxy_fallback"

    # ── Sony X-OCN / RAW MXF ──────────────────────────────────────────────────
    if family == "Sony":
        if sdk.resolve:
            return ENGINE_RESOLVE, [ENGINE_PROXY], "sony_resolve"
        return ENGINE_PROXY, [], "sony_proxy_fallback"

    # ── Generic MXF ──────────────────────────────────────────────────────────
    if container == "mxf":
        if sdk.ffmpeg:
            return ENGINE_FFMPEG_FS, [ENGINE_PROXY], "generic_mxf_ffmpeg"

    # ── Broad fallbacks ───────────────────────────────────────────────────────
    if sdk.resolve:
        return ENGINE_RESOLVE, [ENGINE_PROXY], "generic_resolve_fallback"
    if sdk.mpv:
        return ENGINE_MPV, [ENGINE_FFMPEG_FS, ENGINE_PROXY], "generic_mpv_fallback"
    if sdk.ffmpeg:
        return ENGINE_FFMPEG_FS, [ENGINE_PROXY], "generic_ffmpeg_fallback"

    return ENGINE_PROXY, [], "proxy_last_resort"


def engine_status_rows() -> list[dict]:
    """Return OCF engine status rows for the Settings > OCF Engine panel."""
    sdk = sdk_status()
    rows = [
        {"id": "AVFoundation",  "label": "AVFoundation (macOS Native)",   "available": sdk.avf,     "path": sdk.avf_path,     "detail": "Ready" if sdk.avf else "avf_bridge missing"},
        {"id": "MPV",           "label": "MPV/libmpv",                    "available": sdk.mpv,     "path": sdk.mpv_path,     "detail": "Ready" if sdk.mpv else "brew install mpv"},
        {"id": "FFmpeg",        "label": "FFmpeg / ffprobe",              "available": sdk.ffmpeg,  "path": sdk.ffmpeg_path,  "detail": "Ready" if sdk.ffmpeg else "brew install ffmpeg"},
        {"id": "Resolve",       "label": "DaVinci Resolve Engine",        "available": sdk.resolve, "path": sdk.resolve_path, "detail": "Installed" if sdk.resolve else "Not installed"},
        {"id": "ARRI_SDK",      "label": "ARRI Image SDK",                "available": sdk.arri,    "path": sdk.arri_path,    "detail": "Ready" if sdk.arri else "SDK not found"},
        {"id": "RED_SDK",       "label": "RED R3D SDK / REDCINE-X",       "available": sdk.red,     "path": sdk.red_path,     "detail": "Ready" if sdk.red else "SDK not found"},
        {"id": "BRAW_SDK",      "label": "Blackmagic RAW SDK",            "available": sdk.braw,    "path": sdk.braw_path,    "detail": "Ready" if sdk.braw else "SDK not found"},
        {"id": "Canon_SDK",     "label": "Canon Cinema RAW SDK",          "available": sdk.canon,   "path": sdk.canon_path,   "detail": "Ready" if sdk.canon else "SDK not found"},
        {"id": "Sony_XOCN",     "label": "Sony X-OCN / RAW",             "available": sdk.resolve, "path": "",               "detail": "Via Resolve" if sdk.resolve else "Needs Resolve or external tool"},
        {"id": "ProxyEngine",   "label": "Proxy Engine (always available)","available": sdk.ffmpeg, "path": "",               "detail": "Ready" if sdk.ffmpeg else "Needs FFmpeg"},
    ]
    for r in rows:
        r["status"] = "ready" if r["available"] else "missing"
    return rows
