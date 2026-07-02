"""
resolve_engine.py — PostFlowX DaVinci Resolve Studio Background Engine

Handles: detect, launch, connect, job execution, progress tracking,
debug logging, manual handoff creation.

All jobs run in background threads. Progress is tracked in the session
store (service_state) so callers can poll without blocking.
"""
from __future__ import annotations

import csv
import json
import os
import platform
import plistlib
import re
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..service_state import create_session, get_session, update_session, list_sessions, remove_sessions


# ── Module-level concurrency controls ────────────────────────────────────────

# Resolve's scripting bridge is not thread-safe. Only one job may hold the API
# at a time. Jobs that cannot acquire immediately fail fast with RESOLVE_BUSY so
# the user gets a clear message rather than a silent crash.
_RESOLVE_JOB_SEM = threading.Semaphore(1)

# Short-TTL cache for _resolve_is_running() — avoids spawning a subprocess on
# every job start check. State is refreshed after 4 s.
_resolve_running_cache: dict[str, Any] = {"result": None, "ts": 0.0}
_RESOLVE_RUNNING_CACHE_TTL = 4.0


# ── Constants ─────────────────────────────────────────────────────────────────

JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")

RESOLVE_PATHS_MAC = [
    "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/MacOS/Resolve",
]
RESOLVE_PATHS_WIN = [
    r"C:\Program Files\Blackmagic Design\DaVinci Resolve\Resolve.exe",
]
RESOLVE_PATHS_LINUX = [
    "/opt/resolve/bin/resolve",
    "/opt/DaVinciResolve/bin/resolve",
]

RESOLVE_SCRIPT_MODULE_PATHS_MAC = [
    "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules",
]
RESOLVE_SCRIPT_LIB_MAC = (
    "/Applications/DaVinci Resolve/DaVinci Resolve.app"
    "/Contents/Libraries/Fusion/fusionscript.so"
)

ALLOWED_JOB_TYPES = frozenset({
    "proxy_export",
    "batch_proxy_export",
    "metadata_probe",
    "trailer_conform_analyze",
    "trailer_conform_build",
    "timeline_import_test",
    "review_qt_export",
    "handoff_package",
    "plate_export_exr",
    "plate_export_dpx",
    "amf_export",
    "ai_transcription",
    "people_analysis",
    "smart_reframe",
})

AI_JOB_TYPES = frozenset({
    "ai_transcription",
    "people_analysis",
    "smart_reframe",
})

PROGRESS_STEPS = {
    "idle":             0,
    "validate_job":     5,
    "detect_resolve":  10,
    "launch_resolve":  20,
    "connect_api":     30,
    "create_project":  40,
    "import_media":    50,
    "create_timeline": 60,
    "configure_render":70,
    "render":          80,
    "verify_output":   90,
    "complete":       100,
}

# ── Path helpers ──────────────────────────────────────────────────────────────

def _candidate_paths() -> list[str]:
    sys_name = platform.system()
    if sys_name == "Darwin":
        return RESOLVE_PATHS_MAC
    if sys_name == "Windows":
        return RESOLVE_PATHS_WIN
    return RESOLVE_PATHS_LINUX


def _resolve_version(resolve_path: str) -> str:
    path = Path(resolve_path)
    try:
        if platform.system() == "Darwin":
            info_plist = path.parents[2] / "Contents" / "Info.plist"
            if info_plist.is_file():
                with open(info_plist, "rb") as fh:
                    info = plistlib.load(fh)
                version = str(
                    info.get("CFBundleShortVersionString")
                    or info.get("CFBundleVersion")
                    or ""
                ).strip()
                if version:
                    return version
    except Exception:
        pass
    return "unknown"


def _resolve_script_module_paths() -> list[str]:
    system = platform.system()
    if system == "Darwin":
        return RESOLVE_SCRIPT_MODULE_PATHS_MAC[:]
    if system == "Windows":
        return [
            r"C:\ProgramData\Blackmagic Design\DaVinci Resolve\Support\Developer\Scripting\Modules",
        ]
    return [
        "/opt/resolve/Developer/Scripting/Modules",
        "/opt/DaVinciResolve/Developer/Scripting/Modules",
    ]


def _resolve_script_lib_path() -> str:
    system = platform.system()
    if system == "Darwin":
        return RESOLVE_SCRIPT_LIB_MAC
    if system == "Windows":
        return r"C:\Program Files\Blackmagic Design\DaVinci Resolve\fusionscript.dll"
    return "/opt/resolve/libs/Fusion/fusionscript.so"


def detect_resolve() -> dict[str, Any]:
    """Find installed Resolve executables. Returns {ok, paths, selectedPath}."""
    found = [p for p in _candidate_paths() if Path(p).exists()]
    if not found:
        return {
            "ok": False,
            "found": False,
            "paths": [],
            "selectedPath": "",
            "resolvedPath": "",
            "path": "",
            "version": "unknown",
            "scriptingAvailable": False,
            "apiAvailable": False,
            "errorCode": "RESOLVE_NOT_FOUND",
            "message": "DaVinci Resolve was not found at any standard path.",
            "reason": "DaVinci Resolve was not found at any standard path.",
        }

    selected = found[0]
    script_paths = _resolve_script_module_paths()
    script_lib = _resolve_script_lib_path()
    scripting_available = any(Path(p).is_dir() for p in script_paths) and Path(script_lib).exists()
    api_available = _get_resolve_app(timeout=0) is not None if scripting_available else False
    return {
        "ok": True,
        "found": True,
        "paths": found,
        "selectedPath": selected,
        "resolvedPath": selected,
        "path": selected,
        "version": _resolve_version(selected),
        "scriptingAvailable": scripting_available,
        "apiAvailable": api_available,
        "scriptModulePaths": script_paths,
        "scriptLibPath": script_lib,
        "reason": "",
    }


def _setup_resolve_env() -> None:
    """Ensure RESOLVE_SCRIPT_API and sys.path are configured for the scripting module."""
    module_dirs = _resolve_script_module_paths()
    env_path = os.environ.get("RESOLVE_SCRIPT_API", "")
    if env_path:
        module_dirs.append(os.path.join(env_path, "Modules"))
    home = os.environ.get("HOME", "")
    if platform.system() == "Darwin" and home:
        module_dirs.append(
            os.path.join(home, "Library/Application Support/Blackmagic Design/"
                         "DaVinci Resolve/Developer/Scripting/Modules")
        )
    for d in module_dirs:
        if d and os.path.isdir(d) and d not in sys.path:
            sys.path.insert(0, d)
    # Set RESOLVE_SCRIPT_LIB if not set and the file exists
    if not os.environ.get("RESOLVE_SCRIPT_LIB"):
        script_lib = _resolve_script_lib_path()
        if Path(script_lib).exists():
            os.environ["RESOLVE_SCRIPT_LIB"] = script_lib


def _get_resolve_app(timeout: float = 0) -> Any | None:
    """
    Return the DaVinci Resolve scripting app, or None.
    If timeout > 0, wait up to that many seconds for Resolve to become scriptable.
    """
    _setup_resolve_env()
    try:
        import DaVinciResolveScript as dvr  # type: ignore
    except ImportError:
        return None

    app = dvr.scriptapp("Resolve")
    if app is not None:
        return app
    if timeout <= 0:
        return None

    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(1.0)
        app = dvr.scriptapp("Resolve")
        if app is not None:
            return app
    return None


def _resolve_is_running_uncached() -> bool:
    sys_name = platform.system()
    try:
        if sys_name == "Darwin":
            out = subprocess.check_output(
                ["pgrep", "-x", "Resolve"], stderr=subprocess.DEVNULL
            )
            return bool(out.strip())
        if sys_name == "Windows":
            out = subprocess.check_output(
                ["tasklist", "/FI", "IMAGENAME eq Resolve.exe"],
                stderr=subprocess.DEVNULL
            )
            return b"Resolve.exe" in out
        out = subprocess.check_output(
            ["pgrep", "-f", "resolve"], stderr=subprocess.DEVNULL
        )
        return bool(out.strip())
    except Exception:
        return False


def _resolve_is_running(bust_cache: bool = False) -> bool:
    """Return True if Resolve is running. Result cached for 4 s to avoid subprocess spam."""
    now = time.time()
    cached = _resolve_running_cache
    if (
        not bust_cache
        and cached["result"] is not None
        and now - cached["ts"] < _RESOLVE_RUNNING_CACHE_TTL
    ):
        return cached["result"]  # type: ignore[return-value]
    result = _resolve_is_running_uncached()
    cached["result"] = result
    cached["ts"] = now
    return result


def launch_resolve(resolve_path: str) -> tuple[bool, str]:
    """Launch Resolve without blocking. Returns (ok, error_message)."""
    path = Path(resolve_path)
    if not path.exists():
        return False, f"Resolve executable not found: {resolve_path}"
    try:
        if platform.system() == "Darwin":
            app_bundle = str(path.parents[2])  # .../DaVinci Resolve.app
            # -g: don't bring to foreground, -j: launch hidden. Resolve has no
            # headless mode but this avoids stealing focus / popping its window.
            subprocess.Popen(["open", "-gj", app_bundle])
        else:
            subprocess.Popen([resolve_path])
        return True, ""
    except Exception as exc:
        return False, str(exc)


def test_resolve_connection(resolve_path: str = "", timeout_seconds: int = 60) -> dict[str, Any]:
    """Launch Resolve if needed and test whether the scripting API is reachable."""
    logs: list[str] = []
    warnings: list[str] = []
    detect_info = detect_resolve()
    effective_path = resolve_path or str(detect_info.get("selectedPath") or "")

    if not effective_path or not Path(effective_path).exists():
        return {
            "connected": False,
            "resolveLaunched": False,
            "resolveRunning": _resolve_is_running(),
            "apiAvailable": False,
            "resolvePath": effective_path,
            "version": "unknown",
            "logs": logs,
            "warnings": warnings,
            "errorCode": "RESOLVE_NOT_FOUND",
            "message": "DaVinci Resolve was not found.",
        }

    if not bool(detect_info.get("scriptingAvailable")):
        warnings.append(
            "Open Resolve once, go to Preferences > System > General, enable external scripting, restart Resolve, then click Test Connection again."
        )

    # Fully manual: Test Connection never launches Resolve. If Resolve isn't
    # already running, return a clear "not running" result so the user can
    # open it themselves.
    resolve_running = _resolve_is_running()
    resolve_launched = False
    if not resolve_running:
        return {
            "connected": False,
            "resolveLaunched": False,
            "resolveRunning": False,
            "apiAvailable": False,
            "resolvePath": effective_path,
            "version": _resolve_version(effective_path),
            "logs": logs,
            "warnings": warnings,
            "errorCode": "RESOLVE_NOT_RUNNING",
            "message": "DaVinci Resolve is not running. Open Resolve manually, then click Test Connection again.",
        }
    logs.append("Resolve already running")

    app = _get_resolve_app(timeout=float(max(1, timeout_seconds)))
    if app is None:
        warnings.append(
            "Open Resolve once, go to Preferences > System > General, enable external scripting, restart Resolve, then click Test Connection again."
        )
        return {
            "connected": False,
            "resolveLaunched": resolve_launched,
            "resolveRunning": True,
            "apiAvailable": False,
            "resolvePath": effective_path,
            "version": _resolve_version(effective_path),
            "logs": logs,
            "warnings": warnings,
            "errorCode": "RESOLVE_API_NOT_AVAILABLE",
            "message": "Resolve launched but the scripting API was not available.",
        }

    logs.append("Connected to Resolve API")
    pm = app.GetProjectManager()
    project = pm.GetCurrentProject() if pm else None
    current_project = str(project.GetName() or "") if project else ""
    if current_project:
        logs.append(f"Current project: {current_project}")

    return {
        "connected": True,
        "resolveLaunched": resolve_launched,
        "resolveRunning": True,
        "apiAvailable": True,
        "resolvePath": effective_path,
        "version": _resolve_version(effective_path),
        "currentProject": current_project or None,
        "logs": logs,
        "warnings": warnings,
    }


# ── Job validation ─────────────────────────────────────────────────────────────

def validate_job(job: dict) -> tuple[bool, str, str]:
    """
    Validate job dict. Returns (ok, error_code, error_message).
    """
    job_id = str(job.get("jobId") or "")
    if not job_id or not JOB_ID_RE.match(job_id):
        return False, "BAD_JOB_ID", "jobId must match ^[A-Za-z0-9_-]+$"

    job_type = str(job.get("type") or job.get("jobType") or "")
    if job_type not in ALLOWED_JOB_TYPES:
        return False, "BAD_JOB_TYPE", f"Unknown job type: {job_type}"

    output_dir = str(job.get("outputDir") or "")
    if not output_dir:
        return False, "MISSING_OUTPUT_DIR", "outputDir is required"

    try:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
    except Exception as exc:
        return False, "OUTPUT_DIR_NOT_WRITABLE", f"Cannot create outputDir: {exc}"

    if not os.access(output_dir, os.W_OK):
        return False, "OUTPUT_DIR_NOT_WRITABLE", f"outputDir is not writable: {output_dir}"

    # Validate input media paths
    media_list = job.get("inputMedia") or job.get("mediaFiles") or []
    for p in media_list:
        p = str(p)
        # Path traversal check
        abs_p = os.path.normpath(os.path.abspath(p))
        if not os.path.isfile(abs_p):
            return False, "MEDIA_NOT_FOUND", f"Input file not found: {p}"

    return True, "", ""


def normalize_job(
    job: dict[str, Any],
    timeout_seconds: int = 60,
    debug: bool = False,
) -> dict[str, Any]:
    """Normalize legacy and new Resolve job payloads to the current engine schema."""
    normalized = dict(job)
    job_id = str(normalized.get("jobId") or uuid.uuid4().hex[:12])
    job_type = str(normalized.get("type") or normalized.get("jobType") or "").strip()

    normalized["jobId"] = job_id
    normalized["type"] = job_type
    normalized.pop("jobType", None)

    input_media = normalized.get("inputMedia")
    if not isinstance(input_media, list):
        input_media = normalized.get("mediaFiles") or []
    normalized["inputMedia"] = [str(p) for p in input_media if str(p or "").strip()]

    settings = dict(normalized.get("settings") or {})
    options = dict(normalized.get("options") or {})
    if "resolution" not in settings and options.get("width") and options.get("height"):
        settings["resolution"] = f"{int(options['width'])}x{int(options['height'])}"
    if "cleanupTempProject" not in settings:
        settings["cleanupTempProject"] = bool(normalized.get("cleanupTempProject", False))
    normalized["settings"] = settings
    normalized["options"] = options
    normalized["timeoutSeconds"] = int(normalized.get("timeoutSeconds") or timeout_seconds)
    normalized["debugMode"] = bool(normalized.get("debugMode", debug))
    normalized.setdefault("projectName", f"PFX_{job_type}_{job_id}")
    return normalized


def _result_json_path(output_dir: str) -> str:
    if not output_dir:
        return ""
    return str(Path(output_dir) / "debug" / "job.result.json")


# ── Debug helpers ──────────────────────────────────────────────────────────────

class _JobDebugLogger:
    def __init__(self, output_dir: str, job_id: str, debug: bool):
        self.debug = debug
        self.lines: list[str] = []
        self.steps: list[dict] = []
        self._step_start: dict[str, float] = {}
        if output_dir:
            self.debug_dir = Path(output_dir) / "debug"
            self.debug_dir.mkdir(parents=True, exist_ok=True)
        else:
            self.debug_dir = None

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).astimezone().isoformat()

    def log(self, step: str, msg: str, status: str = "info") -> None:
        ts = self._now_iso()
        line = f"[{ts}] {step} {status} {msg}"
        self.lines.append(line)
        if self.debug_dir:
            try:
                with open(self.debug_dir / "native-helper.log", "a", encoding="utf-8") as f:
                    f.write(line + "\n")
            except Exception:
                pass

    def step_start(self, step: str) -> None:
        self._step_start[step] = time.time()
        self.log(step, "starting", "info")

    def step_done(self, step: str, status: str = "success", msg: str = "") -> None:
        elapsed_ms = int((time.time() - self._step_start.get(step, time.time())) * 1000)
        self.steps.append({
            "step": step,
            "status": status,
            "time": self._now_iso(),
            "durationMs": elapsed_ms,
            **({"message": msg} if msg else {}),
        })
        self.log(step, msg or status, status)
        if self.debug_dir:
            try:
                with open(self.debug_dir / "steps.json", "w", encoding="utf-8") as f:
                    json.dump(self.steps, f, indent=2)
            except Exception:
                pass

    def save_job_input(self, job: dict) -> None:
        if not self.debug or not self.debug_dir:
            return
        try:
            with open(self.debug_dir / "job.input.json", "w", encoding="utf-8") as f:
                json.dump(job, f, indent=2)
        except Exception:
            pass

    def save_result(self, result: dict) -> None:
        if not self.debug_dir:
            return
        try:
            with open(self.debug_dir / "job.result.json", "w", encoding="utf-8") as f:
                json.dump(result, f, indent=2)
        except Exception:
            pass

    def save_error(self, err: str) -> None:
        if not self.debug_dir:
            return
        try:
            with open(self.debug_dir / "error.txt", "w", encoding="utf-8") as f:
                f.write(err)
        except Exception:
            pass

    def save_env(self) -> None:
        if not self.debug or not self.debug_dir:
            return
        env_info = {
            "RESOLVE_SCRIPT_API": os.environ.get("RESOLVE_SCRIPT_API", ""),
            "RESOLVE_SCRIPT_LIB": os.environ.get("RESOLVE_SCRIPT_LIB", ""),
            "sys_path": sys.path[:],
            "platform": platform.system(),
            "python": sys.version,
        }
        try:
            with open(self.debug_dir / "environment.json", "w", encoding="utf-8") as f:
                json.dump(env_info, f, indent=2)
        except Exception:
            pass


# ── Manual handoff ─────────────────────────────────────────────────────────────

def create_manual_handoff(job: dict, output_dir: str) -> str:
    """Create a manual handoff package. Returns the handoff folder path."""
    handoff_dir = Path(output_dir) / "manual_handoff"
    handoff_dir.mkdir(parents=True, exist_ok=True)

    # job.input.json
    try:
        with open(handoff_dir / "job.input.json", "w", encoding="utf-8") as f:
            json.dump(job, f, indent=2)
    except Exception:
        pass

    # media_list.csv
    media = job.get("inputMedia") or []
    try:
        with open(handoff_dir / "media_list.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["#", "Path", "Filename"])
            for i, p in enumerate(media, 1):
                w.writerow([i, p, Path(p).name])
    except Exception:
        pass

    # expected_outputs.txt
    settings = job.get("settings") or {}
    codec = settings.get("codec", "ProRes Proxy")
    container = settings.get("container", "mov")
    try:
        with open(handoff_dir / "expected_outputs.txt", "w", encoding="utf-8") as f:
            f.write(f"Job type: {job.get('type', '')}\n")
            f.write(f"Output dir: {job.get('outputDir', '')}\n")
            f.write(f"Codec: {codec}\n")
            f.write(f"Container: {container}\n\n")
            f.write("Expected output files:\n")
            for p in media:
                stem = Path(p).stem
                f.write(f"  {stem}_proxy.{container}\n")
    except Exception:
        pass

    # README
    readme = f"""This package was created because PFX could not run Resolve automatically.
Open DaVinci Resolve Studio manually and follow these steps:

1. Create a new project (suggested name: {job.get('projectName', 'PFX_TEMP_PROJECT')}).
2. Import the files listed in media_list.csv into the Media Pool.
3. Create a new timeline from the imported clips.
4. Set the render preset to: {codec}
5. Set the output directory to: {job.get('outputDir', '')}
6. Start rendering.
7. Return to PFX and click "Import Resolve Output".

Job ID:  {job.get('jobId', '')}
Job type: {job.get('type', '')}
Settings: see job.input.json for full details.
"""
    try:
        with open(handoff_dir / "README_MANUAL_RESOLVE_STEPS.txt", "w", encoding="utf-8") as f:
            f.write(readme)
    except Exception:
        pass

    return str(handoff_dir)


# ── Resolve proxy export logic ─────────────────────────────────────────────────

def _run_proxy_export(
    resolve_app: Any,
    job: dict,
    logger: _JobDebugLogger,
    session_id: str,
) -> dict:
    """Execute a proxy_export job against a live Resolve scripting API."""
    settings = job.get("settings") or {}
    input_media = job.get("inputMedia") or []
    output_dir = str(job.get("outputDir") or "")
    job_id = str(job.get("jobId") or "unknown")

    preserve_tc = bool(settings.get("preserveTimecode", True))
    use_orig_name = bool(settings.get("useOriginalFilename", True))
    codec = str(settings.get("codec") or "ProRes Proxy")
    resolution = str(settings.get("resolution") or "1920x1080")
    cleanup = bool(settings.get("cleanupTempProject", False))

    try:
        w, h = (int(x) for x in resolution.lower().split("x"))
    except Exception:
        w, h = 1920, 1080

    warnings: list[str] = []
    logs = list(logger.lines)

    # ── Project manager ───────────────────────────────────────────────────────
    logger.step_start("create_project")
    _update_session(session_id, "create_project", PROGRESS_STEPS["create_project"],
                    "Creating Resolve project…")

    pm = resolve_app.GetProjectManager()
    if not pm:
        raise RuntimeError("RESOLVE_API_NOT_AVAILABLE: GetProjectManager() returned None")

    safe_name = re.sub(r"[^A-Za-z0-9_-]", "_", job.get("projectName") or f"PFX_TEMP_{job_id}")
    project_name = f"PFX_{safe_name}"

    # Avoid overwriting an existing project
    if pm.LoadProject(project_name):
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        project_name = f"{project_name}_{timestamp}"
        pm.CloseProject(pm.GetCurrentProject())

    project = pm.CreateProject(project_name)
    if not project:
        raise RuntimeError(f"TIMELINE_CREATE_FAILED: Could not create Resolve project '{project_name}'")

    logger.step_done("create_project", "success", f"project={project_name}")
    created_project_name = project_name

    try:
        media_pool = project.GetMediaPool()
        if not media_pool:
            raise RuntimeError("RESOLVE_API_NOT_AVAILABLE: GetMediaPool() returned None")

        # ── Import media ──────────────────────────────────────────────────────
        logger.step_start("import_media")
        _update_session(session_id, "import_media", PROGRESS_STEPS["import_media"],
                        f"Importing {len(input_media)} file(s)…")

        clips = media_pool.ImportMedia(input_media) or []
        if not clips:
            raise RuntimeError(f"MEDIA_IMPORT_FAILED: Resolve could not import: {input_media}")

        logger.step_done("import_media", "success", f"count={len(clips)}")

        # ── Create timeline ───────────────────────────────────────────────────
        logger.step_start("create_timeline")
        _update_session(session_id, "create_timeline", PROGRESS_STEPS["create_timeline"],
                        "Creating timeline…")

        tl_name = f"PFX_TL_{job_id}"
        timeline = media_pool.CreateTimelineFromClips(tl_name, clips)
        if not timeline:
            raise RuntimeError("TIMELINE_CREATE_FAILED: CreateTimelineFromClips returned None")

        project.SetCurrentTimeline(timeline)
        logger.step_done("create_timeline", "success")

        # ── Configure render ──────────────────────────────────────────────────
        logger.step_start("configure_render")
        _update_session(session_id, "configure_render", PROGRESS_STEPS["configure_render"],
                        "Configuring render settings…")

        # Try ProRes presets first
        prores_presets = ["ProRes Proxy", "Apple ProRes 422 Proxy", "ProRes 422 Proxy"]
        preset_set = False

        if "prores" in codec.lower():
            for pname in prores_presets:
                try:
                    if project.SetCurrentRenderPreset(pname):
                        preset_set = True
                        logger.log("configure_render", f"Using render preset: {pname}")
                        break
                except Exception:
                    pass

        if not preset_set:
            # H.264 fallback
            for h264_preset in ["H.264 Master", "H.264", "YouTube 1080p"]:
                try:
                    if project.SetCurrentRenderPreset(h264_preset):
                        preset_set = True
                        warnings.append(
                            "ProRes Proxy preset not available. Used H.264 fallback."
                        )
                        logger.log("configure_render", f"Fallback preset: {h264_preset}")
                        break
                except Exception:
                    pass

        # Set output directory and dimensions
        render_settings: dict[str, Any] = {
            "TargetDir": output_dir,
            "UniqueFilenameStyle": 0,
            "ExportVideo": True,
            "ExportAudio": False,
        }
        if w > 0 and h > 0:
            render_settings["FormatWidth"] = w
            render_settings["FormatHeight"] = h

        # Build per-clip output filenames
        # Resolve API: set CustomName per job, not per clip
        # For single-file jobs we use the source filename
        if len(input_media) == 1 and use_orig_name:
            stem = Path(input_media[0]).stem
            render_settings["CustomName"] = f"{stem}_proxy"

        project.SetRenderSettings(render_settings)
        logger.step_done("configure_render", "success")

        # ── Add and start render ──────────────────────────────────────────────
        logger.step_start("render")
        _update_session(session_id, "render", PROGRESS_STEPS["render"],
                        "Rendering…")

        render_job_id = project.AddRenderJob()
        if not render_job_id:
            raise RuntimeError("RENDER_QUEUE_FAILED: AddRenderJob() returned None/empty")

        if not project.StartRendering(render_job_id):
            raise RuntimeError("RENDER_FAILED: StartRendering() returned False")

        # Poll until complete — adaptive interval: 0.5 s at start, ramps to 3 s
        # over the first 30 s so short renders feel responsive and long renders
        # don't hammer the Resolve scripting bridge.
        poll_start = time.time()
        poll_sleep = 0.5
        last_pct = -1
        stall_since = time.time()
        _STALL_WARN_S = 60  # surface a warning if render makes no progress for this long
        while True:
            status_dict = project.GetRenderJobStatus(render_job_id) or {}
            job_status = str(status_dict.get("JobStatus") or "")
            pct_raw = status_dict.get("CompletionPercentage", 0)
            try:
                pct = int(float(pct_raw))
            except Exception:
                pct = 0

            # Track progress advancement for stall detection
            if pct != last_pct:
                last_pct = pct
                stall_since = time.time()

            render_pct = PROGRESS_STEPS["render"] + int(
                (PROGRESS_STEPS["verify_output"] - PROGRESS_STEPS["render"]) * pct / 100
            )
            stalled = (time.time() - stall_since) > _STALL_WARN_S and pct < 100
            status_msg = f"Rendering {pct}%… (may be stalled — check Resolve)" if stalled else f"Rendering {pct}%…"
            _update_session(session_id, "render", render_pct, status_msg)

            if job_status == "Complete":
                break
            if job_status in ("Failed", "Cancelled"):
                raise RuntimeError(f"RENDER_FAILED: Resolve render {job_status}")

            # Check session cancellation
            sess = get_session(session_id) or {}
            if sess.get("_cancel"):
                project.StopRendering()
                raise RuntimeError("JOB_CANCELLED: Cancelled by user")

            # Timeout guard (seconds are user-configurable per job)
            elapsed = time.time() - poll_start
            if elapsed > max(60, int(job.get("timeoutSeconds") or 60)):
                project.StopRendering()
                raise RuntimeError("RESOLVE_TIMEOUT: Render exceeded the configured timeout")

            # Back off from 0.5 s → 3.0 s over the first 30 s of render time
            poll_sleep = min(3.0, 0.5 + elapsed / 30.0)
            time.sleep(poll_sleep)

        logger.step_done("render", "success", f"render_pct=100")

        # ── Verify output ─────────────────────────────────────────────────────
        logger.step_start("verify_output")
        _update_session(session_id, "verify_output", PROGRESS_STEPS["verify_output"],
                        "Verifying output…")

        output_files = [
            str(f) for f in Path(output_dir).iterdir()
            if f.suffix.lower() in (".mov", ".mp4", ".mxf")
        ]
        if not output_files:
            raise RuntimeError("OUTPUT_NOT_FOUND: No output files found in outputDir")

        logger.step_done("verify_output", "success", f"count={len(output_files)}")

        outputs = [{"type": "proxy", "path": p} for p in sorted(output_files)]

        return {
            "jobId": job_id,
            "type": job.get("type", "proxy_export"),
            "status": "success",
            "outputs": outputs,
            "metadata": {
                "inputCount": len(input_media),
                "outputCount": len(output_files),
                "resolveProject": created_project_name,
            },
            "logs": list(logger.lines),
            "warnings": warnings,
            "errors": [],
        }

    finally:
        if cleanup and created_project_name:
            try:
                pm.CloseProject(project)
                pm.DeleteProject(created_project_name)
            except Exception:
                pass


def _run_metadata_probe(
    resolve_app: Any,
    job: dict,
    logger: _JobDebugLogger,
    session_id: str,
) -> dict:
    """Probe media metadata via Resolve."""
    input_media = job.get("inputMedia") or []
    job_id = str(job.get("jobId") or "unknown")
    job_type = str(job.get("type") or "metadata_probe")

    pm = resolve_app.GetProjectManager()
    if not pm:
        raise RuntimeError("RESOLVE_API_NOT_AVAILABLE")

    project_name = f"PFX_PROBE_{job_id}"
    project = pm.CreateProject(project_name)
    if not project:
        raise RuntimeError("TIMELINE_CREATE_FAILED: Could not create probe project")

    metadata: list[dict] = []
    try:
        media_pool = project.GetMediaPool()
        clips = media_pool.ImportMedia(input_media) or []
        for clip in clips:
            props = {}
            try:
                props = {
                    "name": clip.GetName() or "",
                    "duration": clip.GetClipProperty("Duration") or "",
                    "fps": clip.GetClipProperty("FPS") or "",
                    "resolution": clip.GetClipProperty("Resolution") or "",
                    "codec": clip.GetClipProperty("Video Codec") or "",
                    "startTC": clip.GetClipProperty("Start TC") or "",
                }
            except Exception:
                pass
            metadata.append(props)
    finally:
        try:
            pm.CloseProject(project)
            pm.DeleteProject(project_name)
        except Exception:
            pass

    return {
        "jobId": job_id,
        "type": job_type,
        "status": "success",
        "outputs": [],
        "metadata": {"clips": metadata, "inputCount": len(input_media)},
        "logs": list(logger.lines),
        "warnings": [],
        "errors": [],
    }


# ── Session helpers ────────────────────────────────────────────────────────────

def _update_session(session_id: str, step: str, pct: int, msg: str) -> None:
    update_session(
        session_id,
        stage=step,
        pct=min(100, max(0, pct)),
        message=msg,
        step=step,
        _resolve_step=step,
    )


# ── Main async job runner ─────────────────────────────────────────────────────

def run_resolve_job_async(
    session_id: str,
    job: dict,
    resolve_path: str,
    timeout_seconds: int = 60,
    debug: bool = False,
) -> None:
    """
    Run a Resolve job in a background thread.
    Updates session state throughout. Called from api.py in a daemon thread.
    """
    job_id = str(job.get("jobId") or session_id)
    output_dir = str(job.get("outputDir") or "")
    job_type = str(job.get("type") or "")

    logger = _JobDebugLogger(output_dir, job_id, debug)
    logger.save_job_input(job)
    logger.save_env()

    def _fail(error_code: str, msg: str, user_msg: str = "", fallback_path: str = "") -> None:
        logger.log("fail", f"{error_code}: {msg}", "error")
        logger.save_error(f"{error_code}\n{msg}\n{traceback.format_exc()}")

        fallback: dict = {}
        if fallback_path:
            fallback = {"type": "manual_handoff", "path": fallback_path}

        result = {
            "jobId": job_id,
            "type": job_type,
            "status": "failed",
            "errorCode": error_code,
            "message": msg,
            "outputs": [],
            "logs": list(logger.lines),
            "warnings": [],
            "errors": [f"{error_code}: {msg}"],
            "fallback": fallback,
        }
        logger.save_result(result)

        update_session(
            session_id,
            done=True,
            error=user_msg or msg,
            errorCode=error_code,
            pct=0,
            stage="failed",
            message=user_msg or msg,
            _resolve_result=result,
            _log="\n".join(logger.lines),
            resultPath=_result_json_path(output_dir),
        )

    # ── Step 1: validate ──────────────────────────────────────────────────────
    logger.step_start("validate_job")
    _update_session(session_id, "validate_job", PROGRESS_STEPS["validate_job"],
                    "Validating job…")

    ok, err_code, err_msg = validate_job(job)
    if not ok:
        logger.step_done("validate_job", "failed", err_msg)
        _fail(err_code, err_msg)
        return
    logger.step_done("validate_job", "success")

    # AI beta feature gate
    if job_type in AI_JOB_TYPES:
        logger.step_done("validate_job", "failed", "AI not scriptable")
        _fail(
            "RESOLVE_AI_NOT_SCRIPTABLE",
            "This Resolve AI feature is not available in background mode on this installation.",
            "Use visible Resolve fallback.",
        )
        return

    # ── Step 2: detect Resolve ────────────────────────────────────────────────
    logger.step_start("detect_resolve")
    _update_session(session_id, "detect_resolve", PROGRESS_STEPS["detect_resolve"],
                    "Detecting Resolve…")

    effective_path = resolve_path or (detect_resolve().get("selectedPath") or "")
    if not effective_path or not Path(effective_path).exists():
        logger.step_done("detect_resolve", "failed")
        handoff = create_manual_handoff(job, output_dir)
        _fail("RESOLVE_NOT_FOUND",
              f"Resolve executable not found: {effective_path}",
              "DaVinci Resolve was not found. Check the Resolve Engine path in Project Setup.",
              handoff)
        return

    logger.step_done("detect_resolve", "success", f"path={effective_path}")

    # ── Step 3: ensure Resolve is running (on-demand background auto-launch) ──
    # If Resolve is already up we attach to it. Otherwise we honour the job's
    # launch policy: with Background Auto (launchPolicy on_demand/background) we
    # start Resolve in the background and wait for its scripting API — this is the
    # behaviour the "Resolve: Ready for Auto-Launch" UI promises. Only when the
    # user opted out (manual / handoff / never) do we fall back to a handoff.
    logger.step_start("launch_resolve")
    _update_session(session_id, "launch_resolve", PROGRESS_STEPS["launch_resolve"],
                    "Checking Resolve…")

    resolve_was_running = _resolve_is_running()
    resolve_launched_by_pfx = False

    if not resolve_was_running:
        launch_policy = str(job.get("launchPolicy") or job.get("policy") or "on_demand").strip().lower()
        run_mode = str(job.get("runMode") or job.get("mode") or "background").strip().lower()
        no_launch = {"manual", "never", "disabled", "handoff", "manual_handoff", "manualhandoff"}

        if launch_policy in no_launch or run_mode in {"handoff", "manual_handoff", "manualhandoff"}:
            logger.step_done("launch_resolve", "failed", f"not_running policy={launch_policy}")
            handoff = create_manual_handoff(job, output_dir)
            _fail(
                "RESOLVE_NOT_RUNNING",
                "DaVinci Resolve is not running and auto-launch is disabled.",
                "Open DaVinci Resolve manually (or switch the Resolve Engine to "
                "Background Auto in Project Setup), then run again. A manual handoff "
                "package has been generated as a fallback.",
                handoff,
            )
            return

        # Auto-launch in the background and wait for the scripting API to come up.
        _update_session(session_id, "launch_resolve", PROGRESS_STEPS["launch_resolve"],
                        "Starting DaVinci Resolve in the background…")
        logger.log("launch_resolve", f"auto-launch (policy={launch_policy}, mode={run_mode})")
        launch_timeout = max(45, int(job.get("launchTimeoutSeconds") or 90))
        try:
            start_res = start_resolve_engine(
                effective_path,
                launch_policy=launch_policy,
                run_mode=run_mode,
                timeout_seconds=launch_timeout,
            )
        except Exception as exc:  # pragma: no cover - defensive
            start_res = {"connected": False, "code": "RESOLVE_AUTOLAUNCH_EXCEPTION",
                         "message": str(exc)}

        if not start_res.get("connected"):
            logger.step_done("launch_resolve", "failed", start_res.get("code") or "autolaunch_failed")
            handoff = create_manual_handoff(job, output_dir)
            _fail(
                start_res.get("code") or "RESOLVE_AUTOLAUNCH_FAILED",
                start_res.get("message") or "Could not start DaVinci Resolve automatically.",
                start_res.get("userMessage") or (
                    "PostFlowX tried to start Resolve in the background, but its scripting "
                    "API did not become available in time. Open Resolve manually, or use the "
                    "manual handoff package."
                ),
                handoff,
            )
            return

        resolve_launched_by_pfx = True
        logger.step_done("launch_resolve", "success", f"auto_launched mode={run_mode}")
    else:
        logger.step_done("launch_resolve", "success", "already_running")

    # Record launch provenance so the UI/telemetry can show whether PFX started Resolve.
    update_session(
        session_id,
        resolveWasAlreadyRunning=resolve_was_running,
        resolveLaunchedByPfx=resolve_launched_by_pfx,
    )

    # ── Step 4: connect to API ────────────────────────────────────────────────
    # Acquire the Resolve API semaphore before touching the scripting bridge.
    # Resolve's scripting API is not thread-safe — only one job may use it at
    # a time. Fail fast (non-blocking acquire) so the user gets a clear message
    # rather than silent corruption.
    if not _RESOLVE_JOB_SEM.acquire(blocking=False):
        handoff = create_manual_handoff(job, output_dir)
        _fail(
            "RESOLVE_BUSY",
            "Another Resolve job is already in progress.",
            "A Resolve job is already running. Wait for it to finish, then try again.",
            handoff,
        )
        return

    try:
        logger.step_start("connect_api")
        _update_session(session_id, "connect_api", PROGRESS_STEPS["connect_api"],
                        "Connecting to Resolve scripting API…")

        # Resolve is running but the scripting interface may still be initialising —
        # give it up to 8 s to become scriptable before falling back to handoff.
        resolve_app = _get_resolve_app(timeout=8.0)

        if resolve_app is None:
            logger.step_done("connect_api", "failed")
            handoff = create_manual_handoff(job, output_dir)
            _fail(
                "RESOLVE_API_NOT_AVAILABLE",
                "Resolve launched but the scripting API was not available within the timeout.",
                "Resolve was found but scripting is not available. Open Resolve once, go to "
                "Preferences > System > General, and enable external scripting. Then restart "
                "Resolve and click Test Connection again.",
                handoff,
            )
            # The scripting API never came up — release the semaphore on this
            # early return, otherwise it stays held forever and every future
            # Resolve job fails with RESOLVE_BUSY.
            _RESOLVE_JOB_SEM.release()
            return

        logger.step_done("connect_api", "success")

    except Exception:
        _RESOLVE_JOB_SEM.release()
        raise

    # ── Step 5: run the job ───────────────────────────────────────────────────
    # Semaphore is held from Step 4; always release when the job finishes.
    try:
        try:
            if job_type in ("proxy_export", "batch_proxy_export", "review_qt_export"):
                result = _run_proxy_export(resolve_app, job, logger, session_id)
            elif job_type == "metadata_probe":
                result = _run_metadata_probe(resolve_app, job, logger, session_id)
            elif job_type == "handoff_package":
                handoff_path = create_manual_handoff(job, output_dir)
                result = {
                    "jobId": job_id,
                    "type": job_type,
                    "status": "success",
                    "outputs": [{"type": "handoff", "path": handoff_path}],
                    "metadata": {},
                    "logs": list(logger.lines),
                    "warnings": ["Manual handoff package created — Resolve was not used."],
                    "errors": [],
                }
            else:
                # Other types return stub for now
                result = {
                    "jobId": job_id,
                    "type": job_type,
                    "status": "success",
                    "outputs": [],
                    "metadata": {},
                    "logs": list(logger.lines),
                    "warnings": [f"Job type '{job_type}' is not yet fully implemented."],
                    "errors": [],
                }

        except Exception as exc:
            tb = traceback.format_exc()
            err_str = str(exc)

            # Parse error code from exception message if present
            err_code = "RESOLVE_SCRIPT_FAILED"
            for code in (
                "RESOLVE_NOT_FOUND", "RESOLVE_LAUNCH_FAILED", "RESOLVE_TIMEOUT",
                "RESOLVE_API_NOT_AVAILABLE", "RESOLVE_SCRIPT_FAILED",
                "MEDIA_IMPORT_FAILED", "TIMELINE_CREATE_FAILED",
                "RENDER_PRESET_FAILED", "RENDER_QUEUE_FAILED", "RENDER_FAILED",
                "OUTPUT_NOT_FOUND", "JOB_CANCELLED",
            ):
                if code in err_str:
                    err_code = code
                    err_str = err_str.replace(f"{code}: ", "")
                    break

            logger.log("job", err_str, "error")
            logger.save_error(f"{err_code}\n{err_str}\n{tb}")

            if err_code == "JOB_CANCELLED":
                result = {
                    "jobId": job_id,
                    "type": job_type,
                    "status": "cancelled",
                    "outputs": [],
                    "logs": list(logger.lines),
                    "warnings": [],
                    "errors": [err_str],
                }
            else:
                handoff = create_manual_handoff(job, output_dir)
                result = {
                    "jobId": job_id,
                    "type": job_type,
                    "status": "failed",
                    "errorCode": err_code,
                    "message": err_str,
                    "outputs": [],
                    "logs": list(logger.lines),
                    "warnings": [],
                    "errors": [err_str],
                    "fallback": {"type": "manual_handoff", "path": handoff},
                }

        logger.save_result(result)

        # Store final result in session
        status = result.get("status", "failed")
        update_session(
            session_id,
            done=True,
            error=result.get("message") if status == "failed" else None,
            errorCode=result.get("errorCode", ""),
            pct=100 if status == "success" else 0,
            stage=status,
            message="Resolve job completed." if status == "success" else result.get("message", ""),
            _resolve_result=result,
            _log="\n".join(logger.lines),
            resolveWasAlreadyRunning=resolve_was_running,
            resolveLaunchedByPfx=resolve_launched_by_pfx,
            resultPath=_result_json_path(output_dir),
        )

    finally:
        _RESOLVE_JOB_SEM.release()


# ── Resolve Engine lifecycle / compatibility API ───────────────────────────
# These helpers back the Settings > Resolve Engine UI.  They deliberately keep
# state in the companion/native host process so multiple PostFlowX tabs talk to
# one coordinator instead of each tab trying to own Resolve.

_ENGINE_LOCK = threading.RLock()
_ENGINE_PROC: subprocess.Popen | None = None
_ENGINE_LAUNCHED_BY_PFX = False
_ENGINE_STARTED_AT: float | None = None
_ENGINE_RUN_MODE = ""
_ENGINE_LOG_LINES: list[str] = []
_ENGINE_LOG_MAX = 500


def _engine_log_dir() -> Path:
    root = os.environ.get("POSTFLOWX_COMPANION_LOG_DIR")
    if root:
        base = Path(root)
    elif platform.system() == "Darwin":
        base = Path.home() / "Library" / "Logs" / "PostFlowX"
    elif platform.system() == "Windows":
        base = Path(os.environ.get("LOCALAPPDATA") or str(Path.home())) / "PostFlowX" / "Logs"
    else:
        base = Path.home() / ".cache" / "postflowx" / "logs"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _engine_log_path() -> Path:
    return _engine_log_dir() / "resolve_engine.log"


def _engine_log(message: str) -> None:
    stamp = datetime.now(timezone.utc).isoformat()
    line = f"{stamp} {message}"
    with _ENGINE_LOCK:
        _ENGINE_LOG_LINES.append(line)
        if len(_ENGINE_LOG_LINES) > _ENGINE_LOG_MAX:
            del _ENGINE_LOG_LINES[: len(_ENGINE_LOG_LINES) - _ENGINE_LOG_MAX]
    try:
        with open(_engine_log_path(), "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def _effective_resolve_path(resolve_path: str = "") -> tuple[str, dict[str, Any]]:
    info = detect_resolve()
    path = str(resolve_path or info.get("resolvedPath") or info.get("selectedPath") or info.get("path") or "")
    return path, info


def _engine_process_alive() -> bool:
    with _ENGINE_LOCK:
        return _ENGINE_PROC is not None and _ENGINE_PROC.poll() is None


def _launch_resolve_background(resolve_path: str, run_mode: str = "headless") -> tuple[bool, str, int | None]:
    """Start Resolve in the least-intrusive mode available for this platform."""
    global _ENGINE_PROC, _ENGINE_LAUNCHED_BY_PFX, _ENGINE_STARTED_AT, _ENGINE_RUN_MODE
    path = Path(resolve_path)
    if not path.exists():
        return False, f"Resolve executable not found: {resolve_path}", None
    try:
        mode = (run_mode or "headless").strip().lower()
        if mode in {"headless", "background", "nogui", "localengine", "local_engine"}:
            # Resolve Studio accepts -nogui on supported installations.  If an
            # older workstation does not support it, the follow-up API probe will
            # time out and return a structured RESOLVE_HEADLESS_UNAVAILABLE.
            cmd = [str(path), "-nogui"]
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        elif platform.system() == "Darwin":
            app_bundle = str(path.parents[2])
            # -g avoids stealing focus as much as possible; this is still a GUI
            # attach fallback, not a true headless engine.
            proc = subprocess.Popen(["open", "-gj", "-a", app_bundle], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        else:
            proc = subprocess.Popen([str(path)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        with _ENGINE_LOCK:
            _ENGINE_PROC = proc
            _ENGINE_LAUNCHED_BY_PFX = True
            _ENGINE_STARTED_AT = time.time()
            _ENGINE_RUN_MODE = run_mode or "headless"
        return True, "", getattr(proc, "pid", None)
    except Exception as exc:
        return False, str(exc), None


def _queued_resolve_jobs() -> list[dict[str, Any]]:
    jobs: list[dict[str, Any]] = []
    try:
        sessions = list_sessions()
    except Exception:
        sessions = {}
    for sid, state in sessions.items():
        if state.get("kind") != "resolve_job":
            continue
        result = state.get("_resolve_result") or state.get("_result")
        done = bool(state.get("done") or result is not None)
        status = "completed" if done and not state.get("error") else ("failed" if done else str(state.get("stage") or state.get("step") or "queued"))
        jobs.append({
            "jobId": sid,
            "clientJobId": state.get("jobId") or sid,
            "type": state.get("jobType") or "",
            "status": status,
            "step": state.get("step") or state.get("stage") or "",
            "progress": state.get("pct", state.get("percent", 0)),
            "percent": state.get("pct", state.get("percent", 0)),
            "message": state.get("message") or "",
            "done": done,
            "resultPath": state.get("resultPath") or "",
            "error": state.get("error") or "",
            "errorCode": state.get("errorCode") or "",
        })
    return jobs


def resolve_engine_status(resolve_path: str = "") -> dict[str, Any]:
    """Return a stable status object for Settings/IMF Validation."""
    path, info = _effective_resolve_path(resolve_path)
    running = _resolve_is_running()
    api_available = False
    current_project = None
    app = None
    if info.get("scriptingAvailable"):
        app = _get_resolve_app(timeout=0)
        api_available = app is not None
    if app is not None:
        try:
            pm = app.GetProjectManager()
            project = pm.GetCurrentProject() if pm else None
            current_project = str(project.GetName() or "") if project else None
        except Exception:
            current_project = None
    with _ENGINE_LOCK:
        launched = bool(_ENGINE_LAUNCHED_BY_PFX)
        started_at = _ENGINE_STARTED_AT
        run_mode = _ENGINE_RUN_MODE or ""
    return {
        "found": bool(info.get("found")),
        "resolvePath": path,
        "resolvedPath": path,
        "version": info.get("version") or "unknown",
        "scriptingAvailable": bool(info.get("scriptingAvailable")),
        "apiAvailable": api_available,
        "running": running,
        "connected": api_available,
        "state": "running" if api_available else ("installed" if info.get("found") else "not_found"),
        "status": "running" if api_available else ("installed" if info.get("found") else "not_found"),
        "currentProject": current_project,
        "launchedByPostFlowX": launched,
        "engineProcessAlive": _engine_process_alive(),
        "startedAt": started_at,
        "runMode": run_mode,
        "jobs": _queued_resolve_jobs(),
        "queueDepth": len([j for j in _queued_resolve_jobs() if not j.get("done")]),
        "logPath": str(_engine_log_path()),
        "logs": list(_ENGINE_LOG_LINES[-50:]),
    }


def start_resolve_engine(
    resolve_path: str = "",
    launch_policy: str = "manual",
    run_mode: str = "headless",
    timeout_seconds: int = 60,
) -> dict[str, Any]:
    """Start/attach the Resolve engine and wait for scripting availability."""
    path, info = _effective_resolve_path(resolve_path)
    if not path or not Path(path).exists():
        _engine_log("startEngine failed: Resolve not found")
        return {
            "started": False,
            "connected": False,
            "running": False,
            "status": "error",
            "code": "RESOLVE_NOT_FOUND",
            "message": "DaVinci Resolve was not found.",
            "userMessage": "Set the Resolve executable path in Settings, then try again.",
            "resolvePath": path,
        }

    if not bool(info.get("scriptingAvailable")):
        _engine_log("startEngine failed: scripting unavailable")
        return {
            "started": False,
            "connected": False,
            "running": _resolve_is_running(),
            "status": "error",
            "code": "RESOLVE_SCRIPTING_UNAVAILABLE",
            "message": "Resolve scripting module/library was not found.",
            "userMessage": "Enable Resolve external scripting and install a Resolve Studio build with scripting support.",
            "resolvePath": path,
            "version": info.get("version") or "unknown",
        }

    if _get_resolve_app(timeout=0) is not None:
        _engine_log("startEngine attached to already-running Resolve")
        status = resolve_engine_status(path)
        status.update({"started": False, "attached": True, "status": "running", "code": "OK"})
        return status

    policy = (launch_policy or "manual").strip().lower()
    mode = (run_mode or "headless").strip().lower()
    if policy in {"never", "disabled"}:
        _engine_log("startEngine blocked by launch policy")
        return {
            "started": False,
            "connected": False,
            "running": _resolve_is_running(bust_cache=True),
            "status": "waiting",
            "code": "RESOLVE_NOT_RUNNING",
            "message": "Resolve is not running and launch policy is disabled.",
            "userMessage": "Open Resolve manually or change Launch Policy to On Demand.",
            "resolvePath": path,
            "version": info.get("version") or "unknown",
        }

    if mode in {"handoff", "manualhandoff", "manual_handoff"}:
        _engine_log("startEngine skipped in manual handoff mode")
        return {
            "started": False,
            "connected": False,
            "running": False,
            "status": "handoff",
            "code": "RESOLVE_HANDOFF_MODE",
            "message": "Manual handoff mode does not start Resolve.",
            "userMessage": "Use Manual Handoff or switch to Local Resolve Engine.",
            "resolvePath": path,
            "version": info.get("version") or "unknown",
        }

    ok, err, pid = _launch_resolve_background(path, mode)
    if not ok:
        _engine_log(f"startEngine launch failed: {err}")
        return {
            "started": False,
            "connected": False,
            "running": False,
            "status": "error",
            "code": "RESOLVE_ENGINE_START_FAILED",
            "message": err,
            "userMessage": "Could not start DaVinci Resolve background engine. Use Manual Handoff or open Resolve manually.",
            "resolvePath": path,
            "version": info.get("version") or "unknown",
        }

    _engine_log(f"startEngine launched Resolve pid={pid} mode={mode}")
    app = _get_resolve_app(timeout=float(max(1, timeout_seconds)))
    if app is None:
        running = _resolve_is_running(bust_cache=True)
        code = "RESOLVE_HEADLESS_UNAVAILABLE" if mode in {"headless", "background", "nogui"} else "RESOLVE_ENGINE_TIMEOUT"
        _engine_log(f"startEngine API unavailable after launch code={code}")
        return {
            "started": True,
            "connected": False,
            "running": running,
            "status": "warn",
            "code": code,
            "message": "Resolve started, but scripting API did not become available before timeout.",
            "userMessage": "Resolve was found, but headless/background launch was not available on this workstation. Use Manual Handoff or open Resolve and use Attach Visible mode.",
            "resolvePath": path,
            "version": info.get("version") or "unknown",
            "pid": pid,
        }

    _engine_log("startEngine connected to Resolve scripting API")
    status = resolve_engine_status(path)
    status.update({
        "started": True,
        "connected": True,
        "running": True,
        "status": "running",
        "state": "running",
        "code": "OK",
        "pid": pid,
    })
    return status


def stop_resolve_engine(force: bool = False) -> dict[str, Any]:
    """Stop only a Resolve process launched by PostFlowX companion."""
    global _ENGINE_PROC, _ENGINE_LAUNCHED_BY_PFX, _ENGINE_STARTED_AT, _ENGINE_RUN_MODE
    with _ENGINE_LOCK:
        proc = _ENGINE_PROC
        launched = _ENGINE_LAUNCHED_BY_PFX
    if not proc or proc.poll() is not None:
        _engine_log("stopEngine: no companion-owned Resolve process")
        return {"stopped": False, "status": "idle", "message": "No companion-owned Resolve process is running."}
    if not launched and not force:
        return {
            "stopped": False,
            "status": "blocked",
            "code": "NOT_LAUNCHED_BY_POSTFLOWX",
            "message": "Refusing to stop a user-owned Resolve process.",
            "userMessage": "PostFlowX will only stop Resolve processes it launched.",
        }
    try:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            if force:
                proc.kill()
                proc.wait(timeout=5)
        with _ENGINE_LOCK:
            _ENGINE_PROC = None
            _ENGINE_LAUNCHED_BY_PFX = False
            _ENGINE_STARTED_AT = None
            _ENGINE_RUN_MODE = ""
        _engine_log("stopEngine: stopped companion-owned Resolve process")
        return {"stopped": True, "status": "stopped"}
    except Exception as exc:
        _engine_log(f"stopEngine failed: {exc}")
        return {"stopped": False, "status": "error", "code": "RESOLVE_STOP_FAILED", "message": str(exc)}


def list_resolve_jobs() -> dict[str, Any]:
    jobs = _queued_resolve_jobs()
    for idx, job in enumerate([j for j in jobs if not j.get("done")], start=1):
        job["queuePosition"] = idx
    return {"jobs": jobs, "count": len(jobs), "queueDepth": len([j for j in jobs if not j.get("done")])}


def clear_resolve_queue(include_completed: bool = True) -> dict[str, Any]:
    """Clear queued/completed resolve sessions. Running jobs are preserved."""
    def _should_remove(_sid: str, state: dict[str, Any]) -> bool:
        if state.get("kind") != "resolve_job":
            return False
        result = state.get("_resolve_result") or state.get("_result")
        done = bool(state.get("done") or result is not None)
        stage = str(state.get("stage") or state.get("step") or "").lower()
        if done:
            return include_completed
        return stage in {"queued", "cancelled", "failed", "expired"}
    removed = remove_sessions(_should_remove)
    _engine_log(f"clearQueue removed={removed}")
    return {"cleared": removed, "removed": removed, **list_resolve_jobs()}


def get_resolve_engine_logs(max_lines: int = 200) -> dict[str, Any]:
    lines: list[str] = []
    path = _engine_log_path()
    try:
        if path.is_file():
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                lines = fh.readlines()[-max(1, max_lines):]
            lines = [line.rstrip("\n") for line in lines]
        else:
            lines = list(_ENGINE_LOG_LINES[-max(1, max_lines):])
    except Exception:
        lines = list(_ENGINE_LOG_LINES[-max(1, max_lines):])
    return {"logPath": str(path), "logs": lines, "lines": lines}

def start_resolve_job(
    job: dict,
    resolve_path: str,
    timeout_seconds: int = 60,
    debug: bool = False,
) -> str:
    """
    Create a session, spawn the job thread, return the session_id.
    Called from api.py _resolve_run_job_engine().
    """
    normalized_job = normalize_job(job, timeout_seconds=timeout_seconds, debug=debug)
    session_id = uuid.uuid4().hex[:16]
    job_id = str(normalized_job.get("jobId") or session_id)
    result_path = _result_json_path(str(normalized_job.get("outputDir") or ""))

    create_session(session_id, {
        "kind": "resolve_job",
        "jobId": job_id,
        "jobType": str(normalized_job.get("type") or ""),
        "done": False,
        "pct": 0,
        "stage": "queued",
        "step": "queued",
        "message": "Queued…",
        "error": None,
        "errorCode": "",
        "_cancel": False,
        "_resolve_result": None,
        "_log": "",
        "resolveWasAlreadyRunning": None,
        "resolveLaunchedByPfx": None,
        "resultPath": result_path,
    })

    t = threading.Thread(
        target=run_resolve_job_async,
        args=(session_id, normalized_job, resolve_path),
        kwargs={"timeout_seconds": timeout_seconds, "debug": debug},
        daemon=True,
    )
    t.start()
    return session_id


def cancel_resolve_job(session_id: str) -> bool:
    """Signal a running Resolve job to cancel."""
    sess = get_session(session_id)
    if not sess:
        return False
    update_session(session_id, _cancel=True, message="Cancellation requested…")
    return True
