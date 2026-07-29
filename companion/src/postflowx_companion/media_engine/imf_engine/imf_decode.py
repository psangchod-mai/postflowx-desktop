from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from ..engine_status import find_ffmpeg
from ..logs import write as _log

_FRAME_DIR = Path(tempfile.gettempdir()) / "postflowx_imf_frames"


def _ensure_frame_dir() -> Path:
    _FRAME_DIR.mkdir(parents=True, exist_ok=True)
    return _FRAME_DIR


def _find_ojph() -> str | None:
    for p in ("/opt/homebrew/bin/ojph_expand", "/usr/local/bin/ojph_expand"):
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return shutil.which("ojph_expand")


def decode_test_frame(
    cpl_path: str,
    assetmap_paths: list[str],
    frame_number: int = 0,
    scale: int = 960,
) -> dict:
    frame_dir = _ensure_frame_dir()
    cpl_hash = hashlib.sha1(cpl_path.encode("utf-8")).hexdigest()[:12]
    out_file = frame_dir / f"imf_frame_{cpl_hash}_{frame_number:07d}_s{scale}.png"

    ffmpeg_bin = find_ffmpeg()
    if not ffmpeg_bin:
        return {
            "ok": False, "error": "ffmpeg not found",
            "cplPath": cpl_path, "imagePath": "", "stderr": "",
            "decoderTried": "ffmpeg",
            "userMessage": "FFmpeg is not installed. Install: brew install ffmpeg",
        }

    assetmaps_str = ",".join(assetmap_paths)

    # Try 1: ffmpeg -f imf with libopenjpeg
    result = _try_ffmpeg_imf_demuxer(
        ffmpeg_bin, cpl_path, assetmaps_str, frame_number, scale, str(out_file)
    )
    if result["ok"]:
        return result

    imf_stderr = result.get("stderr", "")

    # Try 2: Direct MXF fallback — extract from first resolved MXF
    from .imf_package_resolver import build_global_asset_map, find_assetmaps_in_folder
    folders = [str(Path(am).parent) for am in assetmap_paths]
    global_map = build_global_asset_map(folders)

    # Find first video MXF (largest file heuristic)
    mxf_candidates = [
        p for p in global_map.values()
        if p.lower().endswith(".mxf") and os.path.isfile(p)
    ]
    mxf_candidates.sort(key=lambda f: os.path.getsize(f), reverse=True)

    if mxf_candidates:
        mxf_result = _try_direct_mxf(
            ffmpeg_bin, mxf_candidates[0], frame_number, scale, str(out_file)
        )
        if mxf_result["ok"]:
            mxf_result["fallbackReason"] = "imf_demuxer_unavailable"
            return mxf_result
        mxf_stderr = mxf_result.get("stderr", "")
    else:
        mxf_stderr = "No MXF files resolved from package"

    # Try 3: OpenJPH for HTJ2K
    ojph_bin = _find_ojph()
    if ojph_bin and mxf_candidates:
        ojph_result = _try_ojph(ojph_bin, mxf_candidates[0], str(out_file))
        if ojph_result["ok"]:
            ojph_result["fallbackReason"] = "ojph_htj2k"
            return ojph_result

    # All failed
    combined_error = (
        f"IMF decode failed — tried: ffmpeg -f imf, direct MXF, OpenJPH.\n"
        f"ffmpeg -f imf stderr: {imf_stderr[-300:]}\n"
        f"direct MXF stderr: {mxf_stderr[:200] if isinstance(mxf_stderr, str) else ''}"
    )
    _log("imf", {"Result": {"success": False, "error": combined_error[:400]}})
    return {
        "ok": False,
        "error": combined_error,
        "cplPath": cpl_path,
        "imagePath": "",
        "stderr": combined_error,
        "decoderTried": "ffmpeg_imf,direct_mxf,ojph",
        "userMessage": (
            "IMF decode failed. Possible causes:\n"
            "• ffmpeg was built without --enable-libxml2 (IMF demuxer unavailable)\n"
            "• libopenjpeg or OpenJPH not installed (HTJ2K decoder missing)\n"
            "• Asset map does not resolve all MXF files\n"
            "See logs for exact ffmpeg stderr."
        ),
    }


def _try_ffmpeg_imf_demuxer(
    ffmpeg_bin: str, cpl_path: str, assetmaps_str: str,
    frame_number: int, scale: int, out_file: str,
) -> dict:
    cmd = [
        ffmpeg_bin, "-hide_banner", "-y",
        "-f", "imf",
        "-assetmaps", assetmaps_str,
        "-i", cpl_path,
        "-map", "0:v:0",
        "-frames:v", "1",
    ]
    if frame_number > 0:
        cmd += ["-vf", f"select=eq(n\\,{frame_number}),scale={scale}:-2", "-vsync", "vfr"]
    else:
        cmd += ["-vf", f"scale={scale}:-2"]
    cmd.append(out_file)

    _log("imf", {"Command": {"command": " ".join(cmd)}})
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "ffmpeg IMF timeout", "stderr": "timeout"}
    except Exception as e:
        return {"ok": False, "error": str(e), "stderr": ""}

    ok = r.returncode == 0 and Path(out_file).is_file() and Path(out_file).stat().st_size > 0
    if ok:
        _log("imf", {"Result": {"success": True, "imagePath": out_file, "decoder": "ffmpeg_imf"}})
    return {
        "ok": ok,
        "imagePath": out_file if ok else "",
        "cplPath": cpl_path,
        "frameNumber": frame_number,
        "engine": "IMFEngine",
        "decoder": "ffmpeg_imf",
        "command": " ".join(cmd),
        "stderr": r.stderr[-1000:] if r.stderr else "",
        "userMessage": "" if ok else f"ffmpeg -f imf failed: {r.stderr[-200:]}",
    }


def _try_direct_mxf(
    ffmpeg_bin: str, mxf_path: str,
    frame_number: int, scale: int, out_file: str,
) -> dict:
    cmd = [
        ffmpeg_bin, "-hide_banner", "-y",
        "-i", mxf_path,
        "-map", "0:v:0",
    ]
    if frame_number > 0:
        cmd += ["-vf", f"select=eq(n\\,{frame_number}),scale={scale}:-2", "-vsync", "vfr", "-frames:v", "1"]
    else:
        cmd += ["-vframes", "1", "-vf", f"scale={scale}:-2"]
    cmd.append(out_file)

    _log("imf", {"Command": {"command": " ".join(cmd), "note": "direct_mxf_fallback"}})
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except Exception as e:
        return {"ok": False, "error": str(e), "stderr": ""}

    ok = r.returncode == 0 and Path(out_file).is_file() and Path(out_file).stat().st_size > 0
    if ok:
        _log("imf", {"Result": {"success": True, "imagePath": out_file, "decoder": "direct_mxf"}})
    return {
        "ok": ok,
        "imagePath": out_file if ok else "",
        "mxfPath": mxf_path,
        "frameNumber": frame_number,
        "engine": "IMFEngine",
        "decoder": "direct_mxf",
        "command": " ".join(cmd),
        "stderr": r.stderr[-500:] if r.stderr else "",
        "userMessage": "" if ok else f"Direct MXF decode failed: {r.stderr[-200:]}",
    }


def _try_ojph(ojph_bin: str, mxf_path: str, out_file: str) -> dict:
    # ojph_expand works on raw J2K/HTJ2K; extract first frame via MXF unpacking is complex
    # For now we attempt it directly and let ojph fail gracefully
    cmd = [ojph_bin, "-i", mxf_path, "-o", out_file]
    _log("imf", {"Command": {"command": " ".join(cmd), "note": "ojph_htj2k"}})
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    except Exception as e:
        return {"ok": False, "error": str(e), "stderr": ""}

    ok = r.returncode == 0 and Path(out_file).is_file() and Path(out_file).stat().st_size > 0
    return {
        "ok": ok,
        "imagePath": out_file if ok else "",
        "engine": "IMFEngine",
        "decoder": "ojph",
        "command": " ".join(cmd),
        "stderr": r.stderr[-300:] if r.stderr else "",
    }
