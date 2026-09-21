#!/usr/bin/env python3
"""
pfx_resolve_job_runner.py — PostFlowX standalone Resolve job runner.

Usage:
    python pfx_resolve_job_runner.py <job_json_path> <result_json_path>

Reads a PFX Resolve job from <job_json_path>, connects to the running
DaVinci Resolve Studio instance via the scripting API, executes the job,
and writes a result JSON to <result_json_path>.

Exit codes:
    0 — job completed (check result JSON "status" for ok/error)
    1 — fatal startup error (bad args, unreadable job file, no Resolve)
"""
from __future__ import annotations

import json
import os
import platform
import sys
import time
import traceback
from pathlib import Path
from typing import Any


# ── Resolve scripting env setup ───────────────────────────────────────────────

def _setup_resolve_env() -> None:
    system = platform.system()
    if system == "Darwin":
        module_path = (
            "/Library/Application Support/Blackmagic Design"
            "/DaVinci Resolve/Developer/Scripting/Modules"
        )
        lib_path = (
            "/Applications/DaVinci Resolve/DaVinci Resolve.app"
            "/Contents/Libraries/Fusion/fusionscript.so"
        )
        os.environ.setdefault("RESOLVE_SCRIPT_API", str(Path(module_path).parent))
        os.environ.setdefault("RESOLVE_SCRIPT_LIB", lib_path)
        if module_path not in sys.path:
            sys.path.insert(0, module_path)
    elif system == "Windows":
        module_path = (
            r"C:\ProgramData\Blackmagic Design\DaVinci Resolve"
            r"\Support\Developer\Scripting\Modules"
        )
        lib_path = (
            r"C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll"
        )
        os.environ.setdefault("RESOLVE_SCRIPT_API", str(Path(module_path).parent))
        os.environ.setdefault("RESOLVE_SCRIPT_LIB", lib_path)
        if module_path not in sys.path:
            sys.path.insert(0, module_path)
    else:
        module_path = "/opt/resolve/Developer/Scripting/Modules"
        lib_path = "/opt/resolve/libs/Fusion/fusionscript.so"
        os.environ.setdefault("RESOLVE_SCRIPT_API", str(Path(module_path).parent))
        os.environ.setdefault("RESOLVE_SCRIPT_LIB", lib_path)
        if module_path not in sys.path:
            sys.path.insert(0, module_path)


def _get_resolve_app(timeout: float = 5.0) -> Any | None:
    _setup_resolve_env()
    try:
        import DaVinciResolveScript as dvr  # type: ignore[import]
        deadline = time.time() + max(timeout, 0)
        while True:
            resolve = dvr.scriptapp("Resolve")
            if resolve is not None:
                return resolve
            if time.time() >= deadline:
                return None
            time.sleep(0.5)
    except Exception:
        return None


# ── Job execution ─────────────────────────────────────────────────────────────

def _error_result(code: str, message: str, job: dict | None = None) -> dict:
    return {
        "status": "error",
        "jobId": (job or {}).get("jobId", ""),
        "jobType": (job or {}).get("jobType", ""),
        "error": {"code": code, "message": message},
        "outputs": [],
        "progress": {"step": "failed", "percent": 0, "message": message},
    }


def _run_proxy_export(resolve, job: dict) -> dict:
    """Execute a proxy_export job against the connected Resolve instance."""
    media_files: list[str] = job.get("mediaFiles", [])
    output_dir: str = job.get("outputDir", "")
    job_id: str = job.get("jobId", "unknown")

    if not media_files:
        return _error_result("MEDIA_IMPORT_FAILED", "No mediaFiles in job", job)
    if not output_dir:
        return _error_result("OUTPUT_NOT_FOUND", "No outputDir in job", job)

    Path(output_dir).mkdir(parents=True, exist_ok=True)

    project_manager = resolve.GetProjectManager()
    if project_manager is None:
        return _error_result("RESOLVE_API_NOT_AVAILABLE", "GetProjectManager() returned None", job)

    # Create a temp project
    temp_name = f"PFX_proxy_{job_id}"
    project = project_manager.CreateProject(temp_name)
    if project is None:
        # Try to open it in case it already exists
        project = project_manager.LoadProject(temp_name)
    if project is None:
        return _error_result("TIMELINE_CREATE_FAILED", f"Could not create temp project '{temp_name}'", job)

    try:
        media_pool = project.GetMediaPool()
        if media_pool is None:
            return _error_result("RESOLVE_API_NOT_AVAILABLE", "GetMediaPool() returned None", job)

        # Import media
        imported = media_pool.ImportMedia(media_files)
        if not imported:
            return _error_result("MEDIA_IMPORT_FAILED", "MediaPool.ImportMedia() returned empty list", job)

        # Create timeline from clips
        timeline = media_pool.CreateTimelineFromClips(
            f"PFX_timeline_{job_id}", imported
        )
        if timeline is None:
            return _error_result("TIMELINE_CREATE_FAILED", "CreateTimelineFromClips() returned None", job)

        # Set render preset — try ProRes Proxy variants, fallback to H.264
        render_preset = None
        format_used = "unknown"
        codec_used = "unknown"
        warned_fallback = False
        for preset in ("ProRes Proxy", "Apple ProRes 422 Proxy", "ProRes 422 Proxy"):
            if project.SetCurrentRenderPreset(preset):
                render_preset = preset
                format_used = "mov"
                codec_used = "ProRes Proxy"
                break
        if render_preset is None:
            for h264_preset in ("H.264 Master", "YouTube - 1080p", "H.264"):
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
        options = job.get("options", {})
        if options.get("width"):
            settings["SetRenderResolutionToCustom"] = True
            settings["ResolutionWidth"] = options["width"]
        if options.get("height"):
            settings["SetRenderResolutionToCustom"] = True
            settings["ResolutionHeight"] = options["height"]

        project.SetRenderSettings(settings)
        job_ids = project.AddRenderJob()
        if not job_ids:
            return _error_result("RENDER_QUEUE_FAILED", "AddRenderJob() returned empty", job)

        project.StartRendering(job_ids)

        # Poll render progress
        timeout_secs = job.get("timeoutSeconds", 300)
        deadline = time.time() + timeout_secs
        while project.IsRenderingInProgress():
            if time.time() > deadline:
                project.StopRendering()
                return _error_result("RENDER_FAILED", f"Render timed out after {timeout_secs}s", job)
            time.sleep(1.0)

        # Collect outputs
        outputs = []
        status_list = project.GetRenderJobStatus(job_ids) or {}
        for jid, st in (status_list.items() if isinstance(status_list, dict) else []):
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
            # Scan output dir as fallback
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
            return _error_result("OUTPUT_NOT_FOUND", "Render finished but no output files found", job)

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
        # Clean up temp project
        try:
            project_manager.CloseProject(project)
            project_manager.DeleteProject(temp_name)
        except Exception:
            pass


def _run_metadata_probe(resolve, job: dict) -> dict:
    """Probe media metadata via Resolve MediaPool."""
    media_files: list[str] = job.get("mediaFiles", [])
    job_id: str = job.get("jobId", "unknown")

    if not media_files:
        return _error_result("MEDIA_IMPORT_FAILED", "No mediaFiles in job", job)

    project_manager = resolve.GetProjectManager()
    if project_manager is None:
        return _error_result("RESOLVE_API_NOT_AVAILABLE", "GetProjectManager() returned None", job)

    temp_name = f"PFX_probe_{job_id}"
    project = project_manager.CreateProject(temp_name)
    if project is None:
        project = project_manager.LoadProject(temp_name)
    if project is None:
        return _error_result("TIMELINE_CREATE_FAILED", f"Could not create temp project '{temp_name}'", job)

    try:
        media_pool = project.GetMediaPool()
        if media_pool is None:
            return _error_result("RESOLVE_API_NOT_AVAILABLE", "GetMediaPool() returned None", job)

        imported = media_pool.ImportMedia(media_files)
        if not imported:
            return _error_result("MEDIA_IMPORT_FAILED", "MediaPool.ImportMedia() returned empty list", job)

        outputs = []
        for clip in imported:
            try:
                props = clip.GetClipProperty() or {}
                outputs.append({
                    "inputFile": props.get("File Path", ""),
                    "metadata": {
                        "duration": props.get("Duration", ""),
                        "fps": props.get("FPS", ""),
                        "resolution": props.get("Resolution", ""),
                        "codec": props.get("Video Codec", ""),
                        "audioChannels": props.get("Audio Ch", ""),
                        "startTimecode": props.get("Start TC", ""),
                        "clipName": props.get("Clip Name", ""),
                    },
                })
            except Exception as e:
                outputs.append({"inputFile": "", "error": str(e)})

        return {
            "status": "ok",
            "jobId": job_id,
            "jobType": "metadata_probe",
            "outputs": outputs,
            "progress": {"step": "complete", "percent": 100, "message": "Probe complete"},
        }

    finally:
        try:
            project_manager.CloseProject(project)
            project_manager.DeleteProject(temp_name)
        except Exception:
            pass


def run_job(job: dict) -> dict:
    job_type = job.get("jobType", "")

    resolve = _get_resolve_app(timeout=10.0)
    if resolve is None:
        return _error_result("RESOLVE_API_NOT_AVAILABLE", "Could not connect to DaVinci Resolve scripting API", job)

    if job_type in ("proxy_export", "batch_proxy_export", "review_qt_export"):
        return _run_proxy_export(resolve, job)
    elif job_type == "metadata_probe":
        return _run_metadata_probe(resolve, job)
    else:
        return _error_result(
            "RESOLVE_SCRIPT_FAILED",
            f"Unsupported job type for standalone runner: {job_type!r}",
            job,
        )


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> int:
    if len(sys.argv) < 3:
        print(
            "Usage: pfx_resolve_job_runner.py <job_json_path> <result_json_path>",
            file=sys.stderr,
        )
        return 1

    job_path = sys.argv[1]
    result_path = sys.argv[2]

    try:
        with open(job_path, "r", encoding="utf-8") as fh:
            job = json.load(fh)
    except Exception as e:
        result = _error_result("RESOLVE_SCRIPT_FAILED", f"Cannot read job file: {e}")
        try:
            with open(result_path, "w", encoding="utf-8") as fh:
                json.dump(result, fh, indent=2)
        except Exception:
            pass
        return 1

    try:
        result = run_job(job)
    except Exception as e:
        result = _error_result(
            "RESOLVE_SCRIPT_FAILED",
            f"Unhandled exception: {e}\n{traceback.format_exc()}",
            job,
        )

    try:
        Path(result_path).parent.mkdir(parents=True, exist_ok=True)
        with open(result_path, "w", encoding="utf-8") as fh:
            json.dump(result, fh, indent=2)
    except Exception as e:
        print(f"ERROR: Cannot write result file: {e}", file=sys.stderr)
        return 1

    return 0 if result.get("status") == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
