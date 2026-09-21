"""
conform_timeline.py — Resolve timeline builder for PFX Trailer Conform.

Used both as an importable module by conform_engine.py and as a standalone
script for debugging:
    python conform_timeline.py <match_list_json> <output_dir>
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any


# ── Timecode helpers ──────────────────────────────────────────────────────────

def _tc_to_frames(tc: str, fps: float) -> int:
    tc = tc.strip().replace(";", ":")
    parts = tc.split(":")
    if len(parts) != 4:
        return 0
    try:
        h, m, s, f = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
        return int(round(fps)) * (h * 3600 + m * 60 + s) + f
    except ValueError:
        return 0


def _frames_to_tc(frames: int, fps: float) -> str:
    ifps = max(1, int(round(fps)))
    f = frames % ifps
    total_secs = frames // ifps
    s = total_secs % 60
    m = (total_secs // 60) % 60
    h = total_secs // 3600
    return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"


def _setup_resolve_env() -> None:
    import platform
    if platform.system() == "Darwin":
        module_path = (
            "/Library/Application Support/Blackmagic Design"
            "/DaVinci Resolve/Developer/Scripting/Modules"
        )
        lib_path = (
            "/Applications/DaVinci Resolve/DaVinci Resolve.app"
            "/Contents/Libraries/Fusion/fusionscript.so"
        )
    elif platform.system() == "Windows":
        module_path = (
            r"C:\ProgramData\Blackmagic Design\DaVinci Resolve"
            r"\Support\Developer\Scripting\Modules"
        )
        lib_path = (
            r"C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll"
        )
    else:
        module_path = "/opt/resolve/Developer/Scripting/Modules"
        lib_path = "/opt/resolve/libs/Fusion/fusionscript.so"

    os.environ.setdefault("RESOLVE_SCRIPT_API", str(Path(module_path).parent))
    os.environ.setdefault("RESOLVE_SCRIPT_LIB", lib_path)
    if module_path not in sys.path:
        sys.path.insert(0, module_path)


def _get_resolve(timeout: float = 10.0) -> Any | None:
    _setup_resolve_env()
    try:
        import DaVinciResolveScript as dvr  # type: ignore[import]
    except ImportError:
        return None
    deadline = time.time() + timeout
    while True:
        app = dvr.scriptapp("Resolve")
        if app is not None:
            return app
        if time.time() >= deadline:
            return None
        time.sleep(1.0)


# ── Timeline builder ──────────────────────────────────────────────────────────

def build_conform_timeline(
    match_list: list[dict],
    output_dir: str,
    fps: float = 24.0,
    project_label: str = "Conform",
    render_review: bool = False,
    burn_in: bool = False,
    log_fn: Any = None,
) -> dict[str, Any]:
    """
    Build a Resolve conform timeline from an accepted match list.

    Each entry in match_list must have:
      acceptedSourceFile  — absolute path to source media
      acceptedSourceIn    — SMPTE TC string
      acceptedSourceOut   — SMPTE TC string
      eventIndex          — int (determines clip order)
      event               — dict with rec_in / rec_out (record-side timecodes)

    Returns result dict with projectName, timelineName, reviewQt, etc.
    """
    def _log(msg: str) -> None:
        if callable(log_fn):
            log_fn(msg)
        else:
            print(msg)

    _log("Connecting to DaVinci Resolve…")
    resolve = _get_resolve(timeout=15.0)
    if not resolve:
        return {"status": "error", "error": {"code": "RESOLVE_API_NOT_AVAILABLE",
                "message": "DaVinci Resolve is not running"}}

    pm = resolve.GetProjectManager()
    if not pm:
        return {"status": "error", "error": {"code": "RESOLVE_API_NOT_AVAILABLE",
                "message": "GetProjectManager returned None"}}

    import datetime
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    safe_label = re.sub(r"[^\w-]", "_", project_label)
    project_name = f"PFX_Conform_{safe_label}_{ts}"

    _log(f"Creating project '{project_name}'…")
    project = pm.CreateProject(project_name)
    if not project:
        return {"status": "error", "error": {"code": "TIMELINE_CREATE_FAILED",
                "message": f"Could not create project '{project_name}'"}}

    try:
        project.SetSetting("timelineFrameRate", str(int(round(fps))))
        media_pool = project.GetMediaPool()
        if not media_pool:
            raise RuntimeError("GetMediaPool returned None")

        # Collect unique source files
        source_files = sorted({
            m["acceptedSourceFile"]
            for m in match_list
            if m.get("acceptedSourceFile") and Path(m["acceptedSourceFile"]).exists()
        })
        _log(f"Importing {len(source_files)} source file(s)…")
        imported = media_pool.ImportMedia(source_files)
        if not imported:
            raise RuntimeError("ImportMedia returned empty — check file paths")

        # Map: normalized path → MediaPoolItem
        clip_map: dict[str, Any] = {}
        for clip in imported:
            props = clip.GetClipProperty() or {}
            fp = props.get("File Path", "")
            if fp:
                clip_map[os.path.normpath(fp)] = clip

        timeline_name = f"PFX_Conform_{safe_label}"
        _log(f"Creating timeline '{timeline_name}'…")
        tl = media_pool.CreateEmptyTimeline(timeline_name)
        if not tl:
            raise RuntimeError("CreateEmptyTimeline returned None")

        project.SetCurrentTimeline(tl)

        ordered = sorted(match_list, key=lambda m: m.get("eventIndex", 0))
        _log(f"Appending {len(ordered)} clip(s) to timeline…")
        placed = 0
        for match in ordered:
            src = match.get("acceptedSourceFile", "")
            clip = clip_map.get(os.path.normpath(src))
            if not clip:
                _log(f"  SKIP event {match.get('eventIndex')} — clip not imported: {src}")
                continue
            si = _tc_to_frames(str(match.get("acceptedSourceIn",  "00:00:00:00")), fps)
            so = _tc_to_frames(str(match.get("acceptedSourceOut", "00:00:00:00")), fps)
            if so <= si:
                _log(f"  SKIP event {match.get('eventIndex')} — invalid in/out {si}/{so}")
                continue
            ok = media_pool.AppendToTimeline([{
                "mediaPoolItem": clip,
                "startFrame": si,
                "endFrame": so,
            }])
            if ok:
                placed += 1
            else:
                _log(f"  WARN AppendToTimeline returned falsy for event {match.get('eventIndex')}")

        _log(f"Timeline built: {placed}/{len(ordered)} clips placed.")

        review_qt: str | None = None
        Path(output_dir).mkdir(parents=True, exist_ok=True)

        if render_review and placed > 0:
            _log("Rendering review QT…")
            review_stem = f"{safe_label}_review"
            for preset in ("H.264 Master", "YouTube - 1080p", "H.264"):
                if project.SetCurrentRenderPreset(preset):
                    break
            render_cfg: dict[str, Any] = {
                "SelectAllFrames": True,
                "TargetDir": output_dir,
                "CustomName": review_stem,
            }
            if burn_in:
                render_cfg["BurnInType"] = "Default"
            project.SetRenderSettings(render_cfg)
            rq = project.AddRenderJob()
            if rq:
                project.StartRendering(rq)
                deadline = time.time() + 3600
                while project.IsRenderingInProgress():
                    if time.time() > deadline:
                        project.StopRendering()
                        _log("Render timed out after 60 min")
                        break
                    time.sleep(2.0)
            # Locate output
            for f in Path(output_dir).iterdir():
                if review_stem in f.stem and f.suffix.lower() in (".mp4", ".mov"):
                    review_qt = str(f)
                    break
            _log(f"Review QT: {review_qt or 'not found'}")

        return {
            "status": "ok",
            "projectName": project_name,
            "timelineName": timeline_name,
            "clipsPlaced": placed,
            "reviewQt": review_qt,
        }

    except Exception as exc:
        _log(f"ERROR: {exc}")
        try:
            pm.CloseProject(project)
            pm.DeleteProject(project_name)
        except Exception:
            pass
        return {"status": "error", "error": {"code": "TIMELINE_CREATE_FAILED",
                "message": str(exc)}}


# ── Standalone entry point ─────────────────────────────────────────────────────

def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: conform_timeline.py <match_list.json> <output_dir>", file=sys.stderr)
        return 1
    match_json_path = sys.argv[1]
    output_dir = sys.argv[2]
    fps = float(sys.argv[3]) if len(sys.argv) > 3 else 24.0
    label = sys.argv[4] if len(sys.argv) > 4 else "Conform"
    render_review = "--render" in sys.argv
    burn_in = "--burnin" in sys.argv

    try:
        with open(match_json_path, "r", encoding="utf-8") as fh:
            match_list = json.load(fh)
    except Exception as e:
        print(f"ERROR reading {match_json_path}: {e}", file=sys.stderr)
        return 1

    result = build_conform_timeline(
        match_list, output_dir, fps, label, render_review, burn_in,
        log_fn=lambda m: print(m),
    )
    print(json.dumps(result, indent=2))
    return 0 if result.get("status") == "ok" else 1


if __name__ == "__main__":
    sys.exit(main())
