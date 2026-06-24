from __future__ import annotations

import os
import subprocess
import tempfile
import time
from pathlib import Path

from .engine_status import find_ffmpeg
from .logs import write as _log

_FRAME_DIR = Path(tempfile.gettempdir()) / "postflowx_frames"


def _ensure_frame_dir() -> Path:
    _FRAME_DIR.mkdir(parents=True, exist_ok=True)
    return _FRAME_DIR


def _tc_to_seconds(tc: str, fps: float) -> float:
    """Convert HH:MM:SS:FF timecode to seconds."""
    try:
        parts = tc.replace(";", ":").split(":")
        h, m, s, f = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
        return h * 3600 + m * 60 + s + (f / fps if fps > 0 else 0)
    except Exception:
        return 0.0


def _frame_to_seconds(frame: int, fps_str: str) -> float:
    try:
        if "/" in fps_str:
            n, d = fps_str.split("/")
            fps = int(n) / int(d)
        else:
            fps = float(fps_str)
        return frame / fps if fps > 0 else 0.0
    except Exception:
        return 0.0


def decode_frame(
    path: str,
    frame_number: int = 0,
    fps: str = "24000/1001",
    scale: int = 960,
    output_format: str = "png",
    sequence_info: dict | None = None,
) -> dict:
    ffmpeg_bin = find_ffmpeg()
    if not ffmpeg_bin:
        return {"ok": False, "engine": "FFmpegFrameServerEngine",
                "error": "ffmpeg not found", "stderr": ""}

    frame_dir = _ensure_frame_dir()
    out_file = frame_dir / f"frame_{frame_number:07d}.{output_format}"

    cmd = _build_decode_command(
        ffmpeg_bin=ffmpeg_bin,
        path=path,
        frame_number=frame_number,
        fps=fps,
        scale=scale,
        output_format=output_format,
        output_file=str(out_file),
        sequence_info=sequence_info,
    )

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return {"ok": False, "engine": "FFmpegFrameServerEngine",
                "error": "ffmpeg timeout", "command": " ".join(cmd), "stderr": ""}
    except Exception as e:
        return {"ok": False, "engine": "FFmpegFrameServerEngine",
                "error": str(e), "command": " ".join(cmd), "stderr": ""}

    ok = result.returncode == 0 and out_file.is_file() and out_file.stat().st_size > 0
    _log("playback", {
        "Engine": {"engine": "FFmpegFrameServerEngine", "status": "ok" if ok else "failed", "error": "" if ok else result.stderr[-300:]},
        "Command": {"command": " ".join(cmd), "exitCode": result.returncode},
        "Result": {"success": ok, "imagePath": str(out_file) if ok else ""},
    })

    if ok:
        return {
            "ok": True,
            "imagePath": str(out_file),
            "frameNumber": frame_number,
            "engine": "FFmpegFrameServerEngine",
            "command": " ".join(cmd),
            "stderr": result.stderr[-500:] if result.stderr else "",
        }
    return {
        "ok": False,
        "engine": "FFmpegFrameServerEngine",
        "error": f"ffmpeg failed (exit {result.returncode}): {result.stderr[-300:]}",
        "command": " ".join(cmd),
        "stderr": result.stderr,
        "imagePath": "",
    }


def _build_decode_command(
    ffmpeg_bin: str,
    path: str,
    frame_number: int,
    fps: str,
    scale: int,
    output_format: str,
    output_file: str,
    sequence_info: dict | None,
) -> list[str]:
    cmd = [ffmpeg_bin, "-hide_banner", "-y"]

    if sequence_info:
        start = sequence_info.get("startFrame", 0)
        pattern = sequence_info.get("pattern", path)
        cmd += ["-start_number", str(start), "-i", pattern]
        n = frame_number - start
        cmd += ["-vf", f"select=eq(n\\,{n}),scale={scale}:-2"]
        cmd += ["-frames:v", "1", "-vsync", "vfr", output_file]
    else:
        # Time-based seek for long files (faster), select-filter for short
        try:
            fps_val = float(fps.split("/")[0]) / float(fps.split("/")[1]) if "/" in fps else float(fps)
        except Exception:
            fps_val = 24.0
        secs = frame_number / fps_val if fps_val > 0 else 0

        # Use fast seek (-ss before -i) for files > 60s, select filter for short clips
        if secs > 2:
            cmd += ["-ss", f"{secs:.6f}", "-i", path]
            cmd += ["-frames:v", "1", "-vf", f"scale={scale}:-2", output_file]
        else:
            cmd += ["-i", path]
            cmd += ["-vf", f"select=eq(n\\,{frame_number}),scale={scale}:-2"]
            cmd += ["-frames:v", "1", "-vsync", "vfr", output_file]

    return cmd


def transcode_proxy(
    source_path: str,
    output_path: str,
    codec: str = "h264",
    scale: int = 1920,
    fps_str: str = "",
    timecode_start: str = "",
    crf: int = 20,
) -> dict:
    ffmpeg_bin = find_ffmpeg()
    if not ffmpeg_bin:
        return {"ok": False, "error": "ffmpeg not found"}

    Path(output_path).parent.mkdir(parents=True, exist_ok=True)

    vf_parts = [f"scale={scale}:-2"]
    cmd = [ffmpeg_bin, "-hide_banner", "-y", "-i", source_path]
    if fps_str:
        cmd += ["-r", fps_str]
    if timecode_start:
        cmd += ["-timecode", timecode_start]
    if codec == "prores":
        cmd += ["-vf", ",".join(vf_parts), "-c:v", "prores_ks", "-profile:v", "0",
                "-c:a", "pcm_s16le", output_path]
    else:
        cmd += ["-vf", ",".join(vf_parts), "-c:v", "libx264", "-preset", "veryfast",
                "-crf", str(crf), "-c:a", "aac", output_path]

    _log("proxy", {"Command": {"command": " ".join(cmd)}})
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
        ok = r.returncode == 0 and Path(output_path).is_file()
        _log("proxy", {"Result": {"success": ok, "proxyPath": output_path if ok else "", "exitCode": r.returncode}})
        return {"ok": ok, "proxyPath": output_path if ok else "", "stderr": r.stderr[-500:]}
    except Exception as e:
        return {"ok": False, "error": str(e)}
