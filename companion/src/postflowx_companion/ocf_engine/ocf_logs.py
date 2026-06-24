from __future__ import annotations

import os
import threading
from datetime import datetime
from pathlib import Path

_LOG_DIR  = Path.home() / "Library" / "Application Support" / "PostFlowX" / "logs"
_LOG_FILE = _LOG_DIR / "ocf_engine.log"
_lock     = threading.Lock()


def _write(section: str, fields: dict) -> None:
    try:
        _LOG_DIR.mkdir(parents=True, exist_ok=True)
        lines = [f"\n[{section}] {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"]
        for k, v in fields.items():
            lines.append(f"  {k}={v}")
        payload = "\n".join(lines) + "\n"
        with _lock:
            with open(_LOG_FILE, "a", encoding="utf-8") as fh:
                fh.write(payload)
    except Exception:
        pass


def log_scan(root: str, clip_count: int, families: list[str], warnings: list[str]) -> None:
    _write("OCF Scan", {
        "root": root,
        "clipCount": clip_count,
        "cameraFamilies": ", ".join(sorted(set(families))) if families else "none",
        "warnings": "; ".join(warnings) if warnings else "",
    })


def log_probe(clip: str, container: str, codec: str, family: str,
              fps: str, timecode: str, reel: str, metadata: str) -> None:
    _write("OCF Probe", {
        "clip": clip,
        "container": container,
        "codec": codec,
        "cameraFamily": family,
        "fps": fps,
        "timecode": timecode,
        "reel": reel,
        "metadata": metadata,
    })


def log_router(selected: str, fallbacks: list[str], reason: str) -> None:
    _write("OCF Router", {
        "selectedEngine": selected,
        "fallbackEngines": ", ".join(fallbacks),
        "reason": reason,
    })


def log_decode(engine: str, frame_number: int, output_image: str,
               success: bool, error: str) -> None:
    _write("OCF Decode", {
        "engine": engine,
        "frameNumber": frame_number,
        "outputImage": output_image,
        "success": success,
        "error": error or "",
    })


def log_proxy(source: str, proxy: str, frame_count: int,
              timecode_start: str, success: bool) -> None:
    _write("OCF Proxy", {
        "source": source,
        "proxy": proxy,
        "frameCount": frame_count,
        "timecodeStart": timecode_start,
        "success": success,
    })


def read_logs(max_bytes: int = 65536) -> str:
    try:
        if not _LOG_FILE.exists():
            return ""
        size = _LOG_FILE.stat().st_size
        with open(_LOG_FILE, "r", encoding="utf-8", errors="replace") as fh:
            if size > max_bytes:
                fh.seek(size - max_bytes)
                fh.readline()
            return fh.read()
    except Exception as exc:
        return f"[log read error: {exc}]"
