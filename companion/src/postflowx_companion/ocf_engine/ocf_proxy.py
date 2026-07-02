from __future__ import annotations

import os
import subprocess
import tempfile
import threading
from pathlib import Path
from typing import Any

from .ocf_router import sdk_status
from .ocf_logs import log_proxy

_OCF_PROXY_DIR = Path.home() / "Library" / "Application Support" / "PostFlowX" / "ocf_proxies"


def _ensure_proxy_dir() -> Path:
    _OCF_PROXY_DIR.mkdir(parents=True, exist_ok=True)
    return _OCF_PROXY_DIR


def generate_proxy(
    clip_path: str,
    scale: int = 1280,
    fps_override: float | None = None,
    timecode_start: str = "",
    output_dir: str | None = None,
    callback=None,
) -> dict[str, Any]:
    """
    Generate a frame-accurate ProRes Proxy (or H264 if ProRes unavailable) from an OCF clip.

    Uses ffmpeg. Source timecode is preserved via -timecode flag.
    callback(pct, msg) is called during encoding if provided.

    Returns:
      { ok, proxyPath, frameCount, timecodeStart, engine, codec, errors }
    """
    sdk = sdk_status()
    if not sdk.ffmpeg:
        return {"ok": False, "proxyPath": "", "frameCount": 0,
                "timecodeStart": timecode_start, "engine": "ProxyEngine",
                "codec": "", "errors": ["ffmpeg not found"]}

    ffmpeg = sdk.ffmpeg_path
    out_dir = Path(output_dir) if output_dir else _ensure_proxy_dir()
    stem    = _safe_stem(clip_path)
    out_path = str(out_dir / f"{stem}_proxy.mov")

    # ── Probe frame count and TC ───────────────────────────────────────────────
    ffprobe = _find_ffprobe(ffmpeg)
    frame_count = 0
    if not timecode_start:
        timecode_start = _probe_start_tc(clip_path, ffprobe)

    # ── Build ffmpeg command ───────────────────────────────────────────────────
    vf = f"scale={scale}:-2:force_original_aspect_ratio=decrease"
    cmd = [ffmpeg, "-y", "-i", clip_path]
    if timecode_start:
        cmd += ["-timecode", timecode_start]
    cmd += [
        "-vf", vf,
        "-c:v", "prores_ks", "-profile:v", "0",   # ProRes Proxy
        "-c:a", "pcm_s16le",
        "-movflags", "+write_tmcd",
        out_path,
    ]

    errors: list[str] = []
    try:
        proc = subprocess.Popen(
            cmd, stderr=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True
        )
        duration_s = _probe_duration(clip_path, ffprobe)
        for line in (proc.stderr or []):
            if callback and "time=" in line:
                pct = _parse_progress(line, duration_s)
                callback(pct, line.strip())
        proc.wait(timeout=600)
        frame_count = _probe_frame_count(out_path, ffprobe)

        if proc.returncode != 0:
            # Fallback to H264 if ProRes encoder missing
            cmd_h264 = [
                ffmpeg, "-y", "-i", clip_path,
                "-vf", vf,
                "-c:v", "libx264", "-crf", "18", "-preset", "fast",
                "-c:a", "aac",
                out_path,
            ]
            proc2 = subprocess.run(cmd_h264, capture_output=True, timeout=600)
            if proc2.returncode != 0:
                err = proc2.stderr.decode(errors="replace")[:500]
                log_proxy(clip_path, out_path, 0, timecode_start, False)
                return {"ok": False, "proxyPath": "", "frameCount": 0,
                        "timecodeStart": timecode_start, "engine": "ProxyEngine",
                        "codec": "h264_fallback", "errors": [err]}
            frame_count = _probe_frame_count(out_path, ffprobe)
            codec = "h264"
        else:
            codec = "prores_proxy"

        log_proxy(clip_path, out_path, frame_count, timecode_start, True)
        return {
            "ok": True,
            "proxyPath": out_path,
            "frameCount": frame_count,
            "timecodeStart": timecode_start,
            "engine": "ProxyEngine",
            "codec": codec,
            "errors": [],
        }
    except subprocess.TimeoutExpired:
        err = "ffmpeg proxy generation timed out (>10 min)"
        log_proxy(clip_path, out_path, 0, timecode_start, False)
        return {"ok": False, "proxyPath": "", "frameCount": 0,
                "timecodeStart": timecode_start, "engine": "ProxyEngine",
                "codec": "", "errors": [err]}
    except Exception as exc:
        log_proxy(clip_path, out_path, 0, timecode_start, False)
        return {"ok": False, "proxyPath": "", "frameCount": 0,
                "timecodeStart": timecode_start, "engine": "ProxyEngine",
                "codec": "", "errors": [str(exc)]}


def generate_proxy_async(clip_path: str, **kwargs) -> dict[str, Any]:
    """Fire-and-forget wrapper. Returns jobId immediately."""
    import uuid
    job_id   = str(uuid.uuid4())[:8]
    _jobs[job_id] = {"state": "running", "pct": 0, "result": None}

    def _run():
        def _cb(pct, msg):
            _jobs[job_id]["pct"] = pct
        result = generate_proxy(clip_path, callback=_cb, **kwargs)
        _jobs[job_id] = {"state": "done", "pct": 100, "result": result}

    threading.Thread(target=_run, daemon=True).start()
    return {"jobId": job_id}


_jobs: dict[str, dict] = {}


def proxy_job_status(job_id: str) -> dict[str, Any]:
    job = _jobs.get(job_id)
    if not job:
        return {"ok": False, "errors": [f"Unknown job: {job_id}"]}
    return {"ok": True, **job}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _safe_stem(path: str) -> str:
    import re
    s = os.path.splitext(os.path.basename(path))[0]
    return re.sub(r"[^A-Za-z0-9_\-]", "_", s)


def _find_ffprobe(ffmpeg_bin: str) -> str | None:
    # Sibling next to the resolved ffmpeg first (keeps a bundled pair together),
    # then the shared bundled-first resolver (Dev Brief P0#2).
    sib = ffmpeg_bin.replace("ffmpeg", "ffprobe")
    if os.path.isfile(sib) and os.access(sib, os.X_OK):
        return sib
    try:
        from ..proxy_service import _resource_bin
        return _resource_bin("ffprobe")
    except Exception:
        import shutil
        return shutil.which("ffprobe")


def _probe_start_tc(clip_path: str, ffprobe: str | None) -> str:
    if not ffprobe:
        return ""
    try:
        import json
        r = subprocess.run(
            [ffprobe, "-v", "quiet", "-print_format", "json",
             "-show_format", "-show_streams", clip_path],
            capture_output=True, text=True, timeout=15,
        )
        if r.returncode != 0:
            return ""
        d    = json.loads(r.stdout)
        tags = {**d.get("format", {}).get("tags", {})}
        for s in d.get("streams", []):
            tags.update(s.get("tags", {}))
        for k in ("timecode", "time_code", "TIMECODE", "start_timecode"):
            v = tags.get(k, "")
            if v and ":" in v:
                return v.strip()
    except Exception:
        pass
    return ""


def _probe_duration(clip_path: str, ffprobe: str | None) -> float:
    if not ffprobe:
        return 0.0
    try:
        import json
        r = subprocess.run(
            [ffprobe, "-v", "quiet", "-print_format", "json", "-show_format", clip_path],
            capture_output=True, text=True, timeout=10,
        )
        d = json.loads(r.stdout)
        return float(d.get("format", {}).get("duration", 0))
    except Exception:
        return 0.0


def _probe_frame_count(path: str, ffprobe: str | None) -> int:
    if not ffprobe or not os.path.isfile(path):
        return 0
    try:
        import json
        r = subprocess.run(
            [ffprobe, "-v", "quiet", "-print_format", "json", "-show_streams", path],
            capture_output=True, text=True, timeout=10,
        )
        d = json.loads(r.stdout)
        for s in d.get("streams", []):
            if s.get("codec_type") == "video":
                nb = int(s.get("nb_frames") or 0)
                if nb:
                    return nb
    except Exception:
        pass
    return 0


def _parse_progress(line: str, duration_s: float) -> int:
    import re
    if not duration_s:
        return 0
    m = re.search(r"time=(\d+):(\d+):([\d.]+)", line)
    if not m:
        return 0
    elapsed = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return min(99, int(elapsed / duration_s * 100))
