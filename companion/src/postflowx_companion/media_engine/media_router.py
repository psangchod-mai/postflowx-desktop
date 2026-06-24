from __future__ import annotations

import sys
from .engine_status import find_ffmpeg, find_mpv


PRORES_CODECS = {"prores", "apcn", "apco", "apcs", "apch", "ap4h", "ap4x", "apns"}
DNX_CODECS    = {"dnxhd", "dnxhr", "dnxhd444"}
J2K_CODECS    = {"jpeg2000", "j2k", "htj2k", "jpeg2000_v2"}
RAW_CODECS    = {"redcode", "braw", "arriraw", "r3d"}
DARWIN        = sys.platform == "darwin"


def select_engine(
    container: str,
    codec: str,
    codec_tag: str = "",
    is_prores: bool = False,
    is_ocf: bool = False,
    is_browser_safe: bool = False,
    is_image_sequence: bool = False,
    is_imf_package: bool = False,
    user_override: str | None = None,
) -> tuple[str, list[str], str]:
    """
    Returns (selected_engine, fallback_engines, reason).
    Deterministic: same inputs → same output every time.
    """
    if user_override:
        return user_override, _fallbacks_for(user_override), "user_override"

    # IMF
    if is_imf_package or container == "imf":
        return "IMFEngine", ["FFmpegFrameServerEngine", "ProxyEngine"], "imf_package"

    # Image sequences
    if is_image_sequence or container == "image_sequence":
        return "FFmpegFrameServerEngine", ["ProxyEngine"], "image_sequence"

    # Camera RAW / OCF
    if is_ocf or codec in RAW_CODECS:
        return "ResolveEngine", ["ProxyEngine"], "camera_raw_ocf"

    # macOS native (ProRes, H264, HEVC in MOV/MP4)
    if DARWIN and container in ("mov", "mp4", "m4v"):
        if (is_prores or codec in PRORES_CODECS or
                codec in {"h264", "avc1", "hevc", "hvc1", "aac",
                           "pcm_s16le", "pcm_s24le", "pcm_s32le"}):
            return (
                "NativeAVFoundationEngine",
                ["MPVEngine", "FFmpegFrameServerEngine", "ProxyEngine"],
                "macos_native_mov_mp4",
            )

    # MXF containers
    if container == "mxf":
        if is_prores or codec in PRORES_CODECS or codec in DNX_CODECS:
            return "MPVEngine", ["FFmpegFrameServerEngine", "ProxyEngine"], "mxf_dnx_prores"
        if codec in J2K_CODECS:
            return "FFmpegFrameServerEngine", ["ProxyEngine"], "mxf_j2k_htj2k"

    # Browser-safe (H264 in mp4 etc.)
    if is_browser_safe:
        return "ChromiumVideoEngine", ["MPVEngine", "FFmpegFrameServerEngine", "ProxyEngine"], "browser_safe"

    # MPV broad fallback
    if find_mpv():
        return "MPVEngine", ["FFmpegFrameServerEngine", "ProxyEngine"], "mpv_fallback"

    # FFmpeg frame server fallback
    if find_ffmpeg():
        return "FFmpegFrameServerEngine", ["ProxyEngine"], "ffmpeg_frame_server_fallback"

    # Last resort
    return "ProxyEngine", [], "proxy_last_resort"


def _fallbacks_for(engine: str) -> list[str]:
    ORDER = [
        "NativeAVFoundationEngine", "MPVEngine", "FFmpegFrameServerEngine",
        "IMFEngine", "ResolveEngine", "ChromiumVideoEngine", "ProxyEngine",
    ]
    try:
        idx = ORDER.index(engine)
        return ORDER[idx + 1:]
    except ValueError:
        return ["ProxyEngine"]
