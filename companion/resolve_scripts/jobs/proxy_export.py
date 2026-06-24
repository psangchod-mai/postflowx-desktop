"""
proxy_export.py — Resolve proxy export job implementation.

This module is imported by the main engine. The logic here mirrors
pfx_resolve_job_runner._run_proxy_export but operates inside the
companion's in-process Resolve connection (no subprocess).
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Any


PRORES_PRESETS = ("ProRes Proxy", "Apple ProRes 422 Proxy", "ProRes 422 Proxy")
H264_PRESETS = ("H.264 Master", "YouTube - 1080p", "H.264")


def run(
    project_manager: Any,
    job: dict[str, Any],
    on_progress: Any = None,
    cancel_flag: Any = None,
) -> dict[str, Any]:
    """
    Run a proxy_export job using an already-open project_manager.

    Args:
        project_manager: Resolve ProjectManager instance.
        job: PFX job dict.
        on_progress: Optional callable(step, pct, msg) for progress events.
        cancel_flag: Optional threading.Event; if set() the render is aborted.

    Returns:
        PFX result dict with status/outputs/warnings.
    """
    media_files: list[str] = job.get("mediaFiles", [])
    output_dir: str = job.get("outputDir", "")
    job_id: str = job.get("jobId", "unknown")
    options: dict = job.get("options", {})
    timeout_secs: int = job.get("timeoutSeconds", 300)

    def _err(code: str, msg: str) -> dict[str, Any]:
        return {
            "status": "error",
            "jobId": job_id,
            "jobType": job.get("jobType", "proxy_export"),
            "error": {"code": code, "message": msg},
            "outputs": [],
            "progress": {"step": "failed", "percent": 0, "message": msg},
        }

    def _progress(step: str, pct: int, msg: str) -> None:
        if callable(on_progress):
            on_progress(step, pct, msg)

    if not media_files:
        return _err("MEDIA_IMPORT_FAILED", "No mediaFiles in job")
    if not output_dir:
        return _err("OUTPUT_NOT_FOUND", "No outputDir in job")

    Path(output_dir).mkdir(parents=True, exist_ok=True)

    _progress("create_project", 10, "Creating temp Resolve project…")
    temp_name = f"PFX_proxy_{job_id}"
    project = project_manager.CreateProject(temp_name)
    if project is None:
        project = project_manager.LoadProject(temp_name)
    if project is None:
        return _err("TIMELINE_CREATE_FAILED", f"Could not create temp project '{temp_name}'")

    try:
        media_pool = project.GetMediaPool()
        if media_pool is None:
            return _err("RESOLVE_API_NOT_AVAILABLE", "GetMediaPool() returned None")

        _progress("import_media", 25, f"Importing {len(media_files)} file(s)…")
        imported = media_pool.ImportMedia(media_files)
        if not imported:
            return _err("MEDIA_IMPORT_FAILED", "MediaPool.ImportMedia() returned empty list")

        _progress("create_timeline", 35, "Creating timeline…")
        timeline = media_pool.CreateTimelineFromClips(f"PFX_tl_{job_id}", imported)
        if timeline is None:
            return _err("TIMELINE_CREATE_FAILED", "CreateTimelineFromClips() returned None")

        _progress("configure_render", 45, "Configuring render preset…")
        render_preset = None
        format_used = "unknown"
        codec_used = "unknown"
        warned_fallback = False

        for preset in PRORES_PRESETS:
            if project.SetCurrentRenderPreset(preset):
                render_preset = preset
                format_used = "mov"
                codec_used = "ProRes Proxy"
                break

        if render_preset is None:
            for h264_preset in H264_PRESETS:
                if project.SetCurrentRenderPreset(h264_preset):
                    render_preset = h264_preset
                    format_used = "mp4"
                    codec_used = "H.264"
                    warned_fallback = True
                    break

        settings: dict[str, Any] = {
            "SelectAllFrames": True,
            "TargetDir": output_dir,
            "CustomName": "",
        }
        if options.get("width"):
            settings["SetRenderResolutionToCustom"] = True
            settings["ResolutionWidth"] = int(options["width"])
        if options.get("height"):
            settings["SetRenderResolutionToCustom"] = True
            settings["ResolutionHeight"] = int(options["height"])

        project.SetRenderSettings(settings)

        _progress("render_queue", 50, "Adding job to render queue…")
        rq_job_ids = project.AddRenderJob()
        if not rq_job_ids:
            return _err("RENDER_QUEUE_FAILED", "AddRenderJob() returned empty")

        _progress("rendering", 55, "Rendering…")
        project.StartRendering(rq_job_ids)

        deadline = time.time() + timeout_secs
        while project.IsRenderingInProgress():
            if cancel_flag is not None and cancel_flag.is_set():
                project.StopRendering()
                return _err("JOB_CANCELLED", "Job was cancelled by user")
            if time.time() > deadline:
                project.StopRendering()
                return _err("RENDER_FAILED", f"Render timed out after {timeout_secs}s")
            time.sleep(1.0)

        _progress("verify_output", 90, "Verifying outputs…")
        outputs: list[dict[str, Any]] = []
        status_map = project.GetRenderJobStatus(rq_job_ids) or {}
        if isinstance(status_map, dict):
            for _jid, st in status_map.items():
                out_path = st.get("OutputFilename", "")
                if out_path and Path(out_path).exists():
                    stat = Path(out_path).stat()
                    outputs.append({
                        "inputFile": media_files[0] if len(media_files) == 1 else "",
                        "outputFile": out_path,
                        "codec": codec_used,
                        "format": format_used,
                        "fileSizeBytes": stat.st_size,
                    })

        if not outputs:
            for f in Path(output_dir).iterdir():
                if f.suffix.lower() in (".mov", ".mp4", ".mxf") and f.stat().st_size > 0:
                    outputs.append({
                        "inputFile": "",
                        "outputFile": str(f),
                        "codec": codec_used,
                        "format": format_used,
                        "fileSizeBytes": f.stat().st_size,
                    })

        if not outputs:
            return _err("OUTPUT_NOT_FOUND", "Render finished but no output files found")

        result: dict[str, Any] = {
            "status": "ok",
            "jobId": job_id,
            "jobType": job.get("jobType", "proxy_export"),
            "outputs": outputs,
            "progress": {"step": "complete", "percent": 100, "message": "Render complete"},
        }
        if warned_fallback:
            result["warnings"] = [
                {
                    "code": "PRORES_NOT_AVAILABLE",
                    "message": "ProRes preset not found; rendered H.264 instead.",
                }
            ]
        return result

    finally:
        try:
            project_manager.CloseProject(project)
            project_manager.DeleteProject(temp_name)
        except Exception:
            pass
