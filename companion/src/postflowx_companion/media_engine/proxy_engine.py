from __future__ import annotations

import os
import threading
import time
from pathlib import Path

from .ffmpeg_frame_server import transcode_proxy
from .logs import write as _log


def generate_proxy(
    source_path: str,
    output_dir: str,
    codec: str = "h264",
    scale: int = 1920,
    fps_str: str = "",
    timecode_start: str = "",
    source_hash: str = "",
    on_progress: object = None,
) -> dict:
    """
    Background proxy generation. Returns metadata dict.
    Never overwrites originals — writes to output_dir/proxies/.
    """
    src = Path(source_path)
    out_dir = Path(output_dir) / "proxies"
    out_dir.mkdir(parents=True, exist_ok=True)

    stem = src.stem
    ext = ".mp4" if codec == "h264" else ".mov"
    out_file = out_dir / f"{stem}_proxy{ext}"

    _log("proxy", {
        "Probe": {
            "sourcePath": source_path,
            "proxyPath": str(out_file),
            "codec": codec,
            "scale": scale,
        }
    })

    result = transcode_proxy(
        source_path=source_path,
        output_path=str(out_file),
        codec=codec,
        scale=scale,
        fps_str=fps_str,
        timecode_start=timecode_start,
    )

    if result["ok"]:
        meta = {
            "sourcePath": source_path,
            "proxyPath": str(out_file),
            "sourceHash": source_hash,
            "engineUsed": "FFmpeg",
            "scale": scale,
            "fps": fps_str,
            "timecodeStart": timecode_start,
            "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        # Write sidecar JSON
        sidecar = out_file.with_suffix(".json")
        try:
            import json
            sidecar.write_text(json.dumps(meta, indent=2))
        except Exception:
            pass
        return {"ok": True, "proxyPath": str(out_file), "meta": meta}

    return {"ok": False, "error": result.get("error", "transcode failed"),
            "stderr": result.get("stderr", "")}


def generate_proxy_async(
    source_path: str,
    output_dir: str,
    session_id: str,
    codec: str = "h264",
    scale: int = 1920,
    fps_str: str = "",
    timecode_start: str = "",
) -> None:
    """Fire-and-forget async proxy generation. Updates service_state session."""
    from ..service_state import create_session, update_session

    create_session(session_id, {
        "kind": "proxy",
        "done": False,
        "pct": 0,
        "stage": "queued",
        "message": "Queued proxy generation…",
        "path": "",
        "error": None,
    })

    def _run() -> None:
        try:
            update_session(session_id, stage="transcoding", message="Transcoding…", pct=5)
            result = generate_proxy(
                source_path=source_path,
                output_dir=output_dir,
                codec=codec,
                scale=scale,
                fps_str=fps_str,
                timecode_start=timecode_start,
            )
            if result["ok"]:
                create_session(session_id, {
                    "kind": "proxy", "done": True, "pct": 100,
                    "stage": "complete", "message": "Proxy ready",
                    "path": result["proxyPath"], "error": None,
                    "artifactPath": result["proxyPath"],
                    "artifactType": "proxy",
                })
            else:
                create_session(session_id, {
                    "kind": "proxy", "done": True, "pct": 0,
                    "stage": "failed", "message": result.get("error", "failed"),
                    "path": "", "error": result.get("error", "transcode failed"),
                })
        except Exception as e:
            create_session(session_id, {
                "kind": "proxy", "done": True, "pct": 0,
                "stage": "failed", "message": str(e),
                "path": "", "error": str(e),
            })

    threading.Thread(target=_run, daemon=True).start()
