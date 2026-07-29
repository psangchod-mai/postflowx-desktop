from __future__ import annotations

import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from .ocf_router import (
    sdk_status, select_ocf_engine,
    ENGINE_AVF, ENGINE_BRAW_SDK, ENGINE_RED_SDK, ENGINE_ARRI_SDK,
    ENGINE_CANON_SDK, ENGINE_MPV, ENGINE_FFMPEG_FS, ENGINE_RESOLVE, ENGINE_PROXY,
)
from .ocf_logs import log_decode

_OCF_TMP = Path(tempfile.gettempdir()) / "postflowx_ocf"


def _ensure_tmp() -> Path:
    _OCF_TMP.mkdir(exist_ok=True)
    return _OCF_TMP


def decode_first_frame(
    clip_path: str,
    frame_number: int = 0,
    scale: int = 960,
    engine: str = "auto",
    probe: dict | None = None,
) -> dict[str, Any]:
    """
    Decode a single frame from an OCF clip.

    Resolution order:
      1. Engine selection (auto or forced)
      2. Try primary engine
      3. On failure, try fallbacks in order
      4. Never return silent black — always report error + tried engines

    Returns:
      { ok, imagePath, engine, frameNumber, timecode, colorPreview, stderr, errors }
    """
    if not os.path.isfile(clip_path) and not (probe or {}).get("kind") == "image_sequence":
        result = _error_result(engine, frame_number, f"File not found: {clip_path}")
        log_decode(engine, frame_number, "", False, result["errors"][0])
        return result

    probe = probe or {}
    if engine == "auto":
        sel_engine, fallbacks, _ = select_ocf_engine(probe)
    else:
        sel_engine = engine
        from .ocf_router import _fallbacks_for
        fallbacks = _fallbacks_for(engine)

    engines_to_try = [sel_engine] + [e for e in fallbacks if e != sel_engine]
    last_error = ""

    for eng in engines_to_try:
        result = _try_engine(eng, clip_path, frame_number, scale, probe)
        if result.get("ok") and result.get("imagePath"):
            log_decode(eng, frame_number, result["imagePath"], True, "")
            return result
        last_error = "; ".join(result.get("errors", [])) or result.get("stderr", "")

    # All engines failed
    err_result = _error_result(sel_engine, frame_number,
                               f"All engines failed. Last error: {last_error}")
    log_decode(sel_engine, frame_number, "", False, last_error)
    return err_result


def _try_engine(
    engine: str,
    clip_path: str,
    frame_number: int,
    scale: int,
    probe: dict,
) -> dict[str, Any]:
    try:
        if engine == ENGINE_AVF:
            return _decode_avf(clip_path, frame_number, scale)
        if engine == ENGINE_RESOLVE:
            return _decode_resolve(clip_path, frame_number, scale)
        if engine in (ENGINE_BRAW_SDK, ENGINE_RED_SDK, ENGINE_ARRI_SDK, ENGINE_CANON_SDK):
            return _decode_sdk(engine, clip_path, frame_number, scale)
        if engine in (ENGINE_MPV, ENGINE_FFMPEG_FS):
            return _decode_ffmpeg(clip_path, frame_number, scale)
        if engine == ENGINE_PROXY:
            return _decode_proxy_frame(clip_path, frame_number, scale)
    except Exception as exc:
        return _error_result(engine, frame_number, str(exc))
    return _error_result(engine, frame_number, f"Unknown engine: {engine}")


def _decode_avf(clip_path: str, frame_number: int, scale: int) -> dict[str, Any]:
    """macOS AVFoundation via avf_bridge."""
    sdk = sdk_status()
    if not sdk.avf:
        return _error_result(ENGINE_AVF, frame_number, "avf_bridge not found")

    out_path = str(_ensure_tmp() / f"{_stem(clip_path)}_frame_{frame_number:06d}_s{scale}.png")
    cmd = [sdk.avf_path, "extract-frame",
           "--input", clip_path,
           "--frame", str(frame_number),
           "--scale", str(scale),
           "--output", out_path]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=30)
        if r.returncode == 0 and os.path.isfile(out_path) and os.path.getsize(out_path) > 0:
            return _ok_result(ENGINE_AVF, frame_number, out_path)
        return _error_result(ENGINE_AVF, frame_number,
                             r.stderr.decode(errors="replace")[:500])
    except subprocess.TimeoutExpired:
        return _error_result(ENGINE_AVF, frame_number, "avf_bridge timed out")


def _decode_resolve(clip_path: str, frame_number: int, scale: int) -> dict[str, Any]:
    from .ocf_resolve_bridge import resolve_decode_frame
    return resolve_decode_frame(
        clip_path, frame_number=frame_number, scale=scale,
        output_dir=str(_ensure_tmp()),
    )


def _decode_sdk(engine: str, clip_path: str, frame_number: int, scale: int) -> dict[str, Any]:
    """Placeholder for vendor SDK integration. Falls through to ffmpeg until SDK is linked."""
    return _error_result(engine, frame_number,
                         f"{engine} integration not yet linked — falling back")


def _decode_ffmpeg(clip_path: str, frame_number: int, scale: int) -> dict[str, Any]:
    sdk = sdk_status()
    ffmpeg = sdk.ffmpeg_path
    if not ffmpeg:
        return _error_result(ENGINE_FFMPEG_FS, frame_number, "ffmpeg not found")

    out_path = str(_ensure_tmp() / f"{_stem(clip_path)}_frame_{frame_number:06d}_s{scale}.png")
    cmd = [ffmpeg, "-y", "-i", clip_path,
           "-vf", f"select=eq(n\\,{frame_number}),scale={scale}:-1:force_original_aspect_ratio=decrease",
           "-vframes", "1", out_path]
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=60)
        if r.returncode == 0 and os.path.isfile(out_path) and os.path.getsize(out_path) > 0:
            return _ok_result(ENGINE_FFMPEG_FS, frame_number, out_path)
        stderr = r.stderr.decode(errors="replace")[:500]
        return _error_result(ENGINE_FFMPEG_FS, frame_number, stderr)
    except subprocess.TimeoutExpired:
        return _error_result(ENGINE_FFMPEG_FS, frame_number, "ffmpeg timed out")


def _decode_proxy_frame(clip_path: str, frame_number: int, scale: int) -> dict[str, Any]:
    """Last resort: use existing cached proxy if available, else error."""
    # Check for a previously generated proxy in our tmp dir
    stem = _stem(clip_path)
    for ext in (".png", ".jpg"):
        candidate = str(_OCF_TMP / f"{stem}_frame_{frame_number:06d}_s{scale}{ext}")
        if os.path.isfile(candidate):
            return _ok_result(ENGINE_PROXY, frame_number, candidate)
    return _error_result(ENGINE_PROXY, frame_number,
                         "No proxy available. Generate proxy first or install FFmpeg/Resolve.")


# ── Helpers ───────────────────────────────────────────────────────────────────

def _stem(path: str) -> str:
    import re
    s = os.path.splitext(os.path.basename(path))[0]
    return re.sub(r"[^A-Za-z0-9_\-]", "_", s)


def _ok_result(engine: str, frame_number: int, image_path: str) -> dict:
    return {
        "ok": True,
        "imagePath": image_path,
        "engine": engine,
        "frameNumber": frame_number,
        "timecode": "",
        "colorPreview": "Rec709",
        "stderr": "",
        "errors": [],
    }


def _error_result(engine: str, frame_number: int, error: str) -> dict:
    return {
        "ok": False,
        "imagePath": "",
        "engine": engine,
        "frameNumber": frame_number,
        "timecode": "",
        "colorPreview": "",
        "stderr": error,
        "errors": [error] if error else [],
    }
