from __future__ import annotations

import json
import subprocess
from pathlib import Path

from ..engine_status import find_ffprobe
from ..logs import write as _log


def probe_cpl(cpl_path: str, assetmap_paths: list[str]) -> dict:
    ffprobe_bin = find_ffprobe()
    if not ffprobe_bin:
        return {
            "ok": False,
            "error": "ffprobe not found",
            "cplPath": cpl_path,
            "stderr": "",
        }

    assetmaps_str = ",".join(assetmap_paths)
    cmd = [
        ffprobe_bin, "-hide_banner",
        "-f", "imf",
        "-assetmaps", assetmaps_str,
        "-show_format", "-show_streams",
        "-of", "json",
        cpl_path,
    ]

    _log("imf", {"Command": {"command": " ".join(cmd)}})

    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "ffprobe timeout", "cplPath": cpl_path, "stderr": ""}
    except Exception as e:
        return {"ok": False, "error": str(e), "cplPath": cpl_path, "stderr": ""}

    stderr = r.stderr or ""
    if r.returncode != 0:
        _log("imf", {"Result": {"success": False, "exitCode": r.returncode, "error": stderr[-300:]}})
        return {
            "ok": False,
            "error": f"ffprobe -f imf failed (exit {r.returncode})",
            "cplPath": cpl_path,
            "command": " ".join(cmd),
            "stderr": stderr,
            "hasDemuxer": False,
        }

    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        return {
            "ok": False, "error": f"JSON parse: {e}",
            "cplPath": cpl_path, "stderr": stderr,
        }

    fmt = data.get("format", {})
    streams = data.get("streams", [])
    v_stream = next((s for s in streams if s.get("codec_type") == "video"), {})

    codec_name = v_stream.get("codec_name", "")
    width = v_stream.get("width", 0)
    height = v_stream.get("height", 0)
    fps_raw = v_stream.get("r_frame_rate") or v_stream.get("avg_frame_rate") or ""
    duration = float(fmt.get("duration") or v_stream.get("duration") or 0)
    fps_val = 0.0
    if "/" in fps_raw:
        try:
            n, d = fps_raw.split("/")
            fps_val = int(n) / int(d)
        except Exception:
            fps_val = 0.0
    duration_frames = round(duration * fps_val) if fps_val else 0

    result = {
        "ok": True,
        "cplPath": cpl_path,
        "pictureCodec": codec_name,
        "width": width,
        "height": height,
        "editRate": fps_raw,
        "durationFrames": duration_frames,
        "durationSeconds": duration,
        "streams": streams,
        "command": " ".join(cmd),
        "stderr": stderr[-500:] if stderr else "",
        "hasDemuxer": True,
    }
    _log("imf", {"Result": {"success": True, "codec": codec_name, "frames": duration_frames}})
    return result
