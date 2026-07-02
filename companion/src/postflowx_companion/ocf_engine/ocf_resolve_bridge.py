from __future__ import annotations

import os
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any


def _get_resolve():
    """Connect to DaVinci Resolve scripting API. Returns app or None."""
    resolve_mod = Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules")
    resolve_lib = Path("/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fusionscript.so")
    if not resolve_mod.exists() or not resolve_lib.exists():
        return None
    os.environ.setdefault("RESOLVE_SCRIPT_API", str(resolve_mod.parent))
    os.environ.setdefault("RESOLVE_SCRIPT_LIB", str(resolve_lib))
    if str(resolve_mod) not in sys.path:
        sys.path.append(str(resolve_mod))
    try:
        import DaVinciResolveScript as dvr  # type: ignore
        return dvr.scriptapp("Resolve")
    except Exception:
        return None


def resolve_decode_frame(
    clip_path: str,
    frame_number: int = 0,
    scale: int = 960,
    output_dir: str | None = None,
) -> dict[str, Any]:
    """
    Use DaVinci Resolve scripting to decode a single frame from an OCF clip.

    Returns:
      { ok, imagePath, engine, frameNumber, timecode, stderr, errors }
    Never raises.
    """
    errors: list[str] = []

    app = _get_resolve()
    if app is None:
        return {
            "ok": False,
            "engine": "ResolveEngine",
            "frameNumber": frame_number,
            "imagePath": "",
            "timecode": "",
            "stderr": "",
            "errors": ["DaVinci Resolve scripting API unavailable."],
        }

    out_dir = output_dir or tempfile.gettempdir()
    stem    = os.path.splitext(os.path.basename(clip_path))[0]
    out_img = os.path.join(out_dir, f"pfx_ocf_{stem}_frame_{frame_number:06d}.png")

    try:
        pm      = app.GetProjectManager()
        project = pm.GetCurrentProject()
        created_proj: str | None = None
        if not project:
            tmp_name = f"pfx_ocf_{uuid.uuid4().hex[:8]}"
            project  = pm.CreateProject(tmp_name)
            created_proj = tmp_name

        if not project:
            return {
                "ok": False, "engine": "ResolveEngine", "frameNumber": frame_number,
                "imagePath": "", "timecode": "", "stderr": "",
                "errors": ["Resolve: no active project and CreateProject failed."],
            }

        media_pool = project.GetMediaPool()
        root_bin   = media_pool.GetRootFolder()
        clips      = media_pool.ImportMedia([clip_path])
        if not clips:
            _cleanup(pm, created_proj)
            return {
                "ok": False, "engine": "ResolveEngine", "frameNumber": frame_number,
                "imagePath": "", "timecode": "", "stderr": "",
                "errors": [f"Resolve: ImportMedia failed for {clip_path}"],
            }

        clip_item  = clips[0]
        # Derive the clip's real frame rate; hardcoding 24 mis-seeks 23.976/25/30 fps
        # OCF, exporting the wrong frame's still.
        try:
            fps_prop = clip_item.GetClipProperty("FPS")
            clip_fps = int(round(float(fps_prop))) if fps_prop else 24
            if clip_fps < 1:
                clip_fps = 24
        except Exception:
            clip_fps = 24
        tl         = media_pool.CreateTimelineFromClips(
            f"pfx_ocf_still_{uuid.uuid4().hex[:6]}", [clip_item]
        )
        if not tl:
            _cleanup(pm, created_proj)
            return {
                "ok": False, "engine": "ResolveEngine", "frameNumber": frame_number,
                "imagePath": "", "timecode": "", "stderr": "",
                "errors": ["Resolve: CreateTimelineFromClips failed."],
            }

        project.SetCurrentTimeline(tl)
        tl.SetCurrentTimecode(_frame_to_tc(frame_number, clip_fps))

        # Try ExportCurrentFrameAsStill
        if hasattr(project, "ExportCurrentFrameAsStill"):
            project.ExportCurrentFrameAsStill(out_img)
            time.sleep(0.5)

        # Fallback: render queue single frame
        if not os.path.isfile(out_img) or os.path.getsize(out_img) == 0:
            out_img = _render_queue_still(project, tl, frame_number, out_dir, stem)

        tc_out = _frame_to_tc(frame_number, clip_fps)
        _cleanup(pm, created_proj)

        if os.path.isfile(out_img) and os.path.getsize(out_img) > 0:
            return {
                "ok": True, "engine": "ResolveEngine", "frameNumber": frame_number,
                "imagePath": out_img, "timecode": tc_out,
                "colorPreview": "Rec709", "stderr": "", "errors": [],
            }
        return {
            "ok": False, "engine": "ResolveEngine", "frameNumber": frame_number,
            "imagePath": "", "timecode": tc_out, "stderr": "",
            "errors": ["Resolve: frame export produced no output file."],
        }

    except Exception as exc:
        return {
            "ok": False, "engine": "ResolveEngine", "frameNumber": frame_number,
            "imagePath": "", "timecode": "", "stderr": str(exc),
            "errors": [str(exc)],
        }


def _frame_to_tc(frame: int, fps: int = 24) -> str:
    fps = max(1, fps)
    h   = frame // (fps * 3600)
    m   = (frame % (fps * 3600)) // (fps * 60)
    s   = (frame % (fps * 60)) // fps
    f   = frame % fps
    return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"


def _render_queue_still(project, tl, frame_number: int, out_dir: str, stem: str) -> str:
    """Fallback: render a single-frame JPEG via the render queue."""
    try:
        out_name = f"pfx_ocf_{stem}_frame_{frame_number:06d}"
        project.SetRenderSettings({
            "SelectAllFrames": False,
            "MarkIn": frame_number,
            "MarkOut": frame_number,
            "TargetDir": out_dir,
            "CustomName": out_name,
            "FormatWidth": 1920,
            "FormatHeight": 1080,
        })
        project.AddRenderJob()
        project.StartRendering()
        deadline = time.time() + 30
        while project.IsRenderingInProgress() and time.time() < deadline:
            time.sleep(0.5)
        for ext in (".png", ".jpg", ".tif", ".tiff"):
            candidate = os.path.join(out_dir, out_name + ext)
            if os.path.isfile(candidate):
                return candidate
    except Exception:
        pass
    return ""


def _cleanup(pm, created_proj: str | None) -> None:
    if created_proj and pm:
        try:
            pm.DeleteProject(created_proj)
        except Exception:
            pass


def resolve_available() -> bool:
    return _get_resolve() is not None
