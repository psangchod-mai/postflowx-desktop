from __future__ import annotations

import base64
import collections
import hashlib
import os
from pathlib import Path
import sys
from typing import Any
import platform
import subprocess
import threading
import time
import uuid
import xml.etree.ElementTree as ET

from . import safe_xml

from .config import CompanionConfig
from .engines import AdvancedImfEngine, InternalFastPathEngine
from .folder_picker import pick_folder, pick_file, pick_files
from .http_server import ensure_http_server, register_asset_file, deregister_asset_file, get_http_token
from .imf_scan import scan_imf_package
from .imf_qc import run_photon as _run_photon_qc
from .color_lut import get_idt_lut_path as _get_idt_lut_path
from .models import ErrorPayload, ResponseEnvelope
from .proxy_service import get_immersive_audio_support, start_iab_decode, start_proxy_playback, stop_session, _extract_dovi, _extract_dovi_from_xml_text, _proxy_cache_path, _restore_running_proxy_session, _read_proxy_sidecar, migrate_named_proxy_cache, _adopt_named_proxy_cache, _resolve_main_media_from_cpl, _proxy_display_name, _find_ffmpeg, _find_ffprobe, _find_art_cmd, _find_arc_cmd, _find_redline, _probe_asset, _timecode_to_seconds, _thumb_cache_dir, _fps_to_base, _seconds_to_timecode, build_preview_proxy, extract_waveform_peaks, extract_embedded_dovi_xml_from_mxf, extract_frame_interleaved_dovi_from_mxf
from .proxy_registry import content_fingerprint as _reg_fingerprint, lookup_proxy as _reg_lookup, prune_registry as _reg_prune
from .service_state import create_session, get_session
from .media import MediaRuntime
from .engines.resolve_engine import (
    detect_resolve,
    test_resolve_connection,
    start_resolve_job,
    cancel_resolve_job,
    resolve_engine_status,
    start_resolve_engine,
    stop_resolve_engine,
    list_resolve_jobs,
    clear_resolve_queue,
    get_resolve_engine_logs,
)
from .engines.conform_engine import (
    start_conform_analyze,
    start_conform_build,
    cancel_conform_job,
    get_conform_status,
    export_conform_results,
    run_conform_preflight,
)


# ── OCF capability detection helpers ─────────────────────────────────────────

def _resolve_export_still(
    media_path: str,
    output_path: str,
    timecode: str = "",
    source_start_tc: str = "",
    fps: float = 24.0,
    drop_frame: bool = False,
) -> tuple[bool, str]:
    """Best-effort still export through DaVinci Resolve scripting.

    Used as a fallback when ffmpeg cannot decode camera-native media but Resolve
    on this machine can. Exports a single still image to output_path.
    """
    resolve_app = Path("/Applications/DaVinci Resolve/DaVinci Resolve.app")
    resolve_mod_dir = Path("/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules")
    resolve_lib = resolve_app / "Contents/Libraries/Fusion/fusionscript.so"
    if not resolve_app.exists() or not resolve_mod_dir.exists() or not resolve_lib.exists():
        return False, "Resolve scripting is not installed"

    os.environ.setdefault("RESOLVE_SCRIPT_API", str(resolve_mod_dir.parent))
    os.environ.setdefault("RESOLVE_SCRIPT_LIB", str(resolve_lib))
    if str(resolve_mod_dir) not in sys.path:
        sys.path.append(str(resolve_mod_dir))

    try:
        import DaVinciResolveScript as dvr  # type: ignore
    except Exception as exc:
        return False, f"Could not import Resolve scripting API: {exc}"

    resolve = dvr.scriptapp("Resolve")
    if not resolve:
        try:
            # -g: don't bring to foreground, -j: launch hidden. Resolve has no
            # headless mode, but this avoids stealing focus / popping its window.
            subprocess.run(["open", "-gj", str(resolve_app)], timeout=5, check=False)
        except Exception:
            pass
        deadline = time.time() + 45
        while time.time() < deadline and not resolve:
            time.sleep(1.0)
            resolve = dvr.scriptapp("Resolve")
    if not resolve:
        return False, "DaVinci Resolve did not become scriptable"

    pm = resolve.GetProjectManager()
    if not pm:
        return False, "Resolve project manager unavailable"
    project = pm.GetCurrentProject()
    created_project = None
    if not project:
        temp_project_name = f"PFX_OCF_PREVIEW_{uuid.uuid4().hex[:8]}"
        project = pm.CreateProject(temp_project_name)
        created_project = temp_project_name if project else None
    if not project:
        return False, "Resolve project unavailable"

    media_pool = project.GetMediaPool()
    if not media_pool:
        return False, "Resolve media pool unavailable"

    clips = []
    timeline = None
    try:
        clips = media_pool.ImportMedia([media_path]) or []
        if not clips:
            return False, "Resolve could not import the media file"
        timeline = media_pool.CreateTimelineFromClips(f"PFX_OCF_STILL_{uuid.uuid4().hex[:8]}", clips)
        if not timeline:
            return False, "Resolve could not create a preview timeline"
        project.SetCurrentTimeline(timeline)
        try:
            resolve.OpenPage("color")
        except Exception:
            pass
        time.sleep(1.5)
        if timecode:
            try:
                target_tc = timecode
                if source_start_tc:
                    timeline_start_tc = ""
                    try:
                        timeline_start_tc = str(timeline.GetCurrentTimecode() or "").strip()
                    except Exception:
                        timeline_start_tc = ""
                    if not timeline_start_tc:
                        timeline_start_tc = "01:00:00:00"
                    rel_sec = max(0.0, _timecode_to_seconds(timecode, fps) - _timecode_to_seconds(source_start_tc, fps))
                    timeline_start_sec = _timecode_to_seconds(timeline_start_tc, fps)
                    target_tc = _seconds_to_timecode(timeline_start_sec + rel_sec, fps, drop_frame)
                timeline.SetCurrentTimecode(target_tc)
            except Exception:
                pass
        out_path = Path(output_path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        ok = bool(project.ExportCurrentFrameAsStill(str(out_path)))
        if not ok or not out_path.is_file() or out_path.stat().st_size == 0:
            return False, "Resolve could not export a still frame"
        return True, ""
    except Exception as exc:
        return False, str(exc)
    finally:
        try:
            if timeline:
                media_pool.DeleteTimelines([timeline])
        except Exception:
            pass
        try:
            if clips:
                media_pool.DeleteClips(clips)
        except Exception:
            pass
        if created_project:
            try:
                pm.CloseProject(project)
            except Exception:
                pass
            try:
                pm.DeleteProject(created_project)
            except Exception:
                pass

def _detect_camera_sdks() -> dict:
    """Return availability map for camera-native decode tools."""
    import shutil
    art = _find_art_cmd()
    arc = _find_arc_cmd()
    red = _find_redline()
    return {
        "ffmpeg":    bool(shutil.which("ffmpeg")),
        "ffprobe":   bool(shutil.which("ffprobe")),
        "oiiotool":  bool(shutil.which("oiiotool")),
        "rawtoaces": bool(shutil.which("rawtoaces")),
        "braw_sdk":  False,  # BRAW SDK requires a registered installer; not shutil-detectable
        "art_cmd":   bool(art),   # ARRI Reference Tool CMD (free, arri.com)
        "arc_cmd":   bool(arc),   # ARRIRAW Converter CMD legacy (free, arri.com)
        "art_cmd_path": art or "",
        "arc_cmd_path": arc or "",
        "arriraw_decode": bool(art or arc),
        "REDline":   bool(red),   # RED REDline CLI (free, red.com)
        "REDline_path": red or "",
        "red_decode": bool(red),
        "sony_raw_decode": False,  # No free Sony RAW CLI available
    }


def _detect_color_pipeline() -> dict:
    """Return availability map for color-pipeline tools."""
    import shutil
    return {
        "ocio":      bool(shutil.which("ocioconvert") or os.environ.get("OCIO")),
        "oiio":      bool(shutil.which("oiiotool")),
        "nuke":      bool(shutil.which("Nuke") or shutil.which("nuke")),
        "resolve":   bool(shutil.which("DaVinci Resolve") or Path("/Applications/DaVinci Resolve/DaVinci Resolve.app").exists()),
        "aces":      bool(os.environ.get("OCIO", "").lower().find("aces") != -1),
    }


def _extensions_to_filetypes(extensions: Any) -> list[tuple[str, str]] | None:
    """Convert a JS-sent list of bare extensions into the (label, pattern)
    tuples expected by folder_picker.pick_file/pick_files.

    JS sends e.g. ["edl", "xml", "fcpxml", "otio"]; we turn that into
    [("Files", "*.edl *.xml *.fcpxml *.otio")] so the AppleScript picker can
    use `choose file of type {...}` and macOS only dims files outside the set.

    Returns None when extensions is missing/empty — pick_file then uses its
    own default (video file extensions). Returning [] would have the same
    effect as no filter, but we keep the existing default behaviour to avoid
    regressing other callers.
    """
    if not extensions:
        return None
    if not isinstance(extensions, (list, tuple)):
        return None
    norm: list[str] = []
    for raw in extensions:
        if not raw:
            continue
        ext = str(raw).strip().lstrip(".").lower()
        if not ext or ext in norm:
            continue
        norm.append(ext)
    if not norm:
        return None
    pattern = " ".join(f"*.{e}" for e in norm)
    return [("Files", pattern)]


def _map_relative_source_index(out_idx: int, source_frame_map: Any) -> int | None:
    """Frame-accurate source selection for a dynamic-retime EXR pull.

    The oiio path treats the source EXR list as the pulled window in order
    (src_files[0] == window start, i.e. map[0].sourceFrame). For output frame
    ``out_idx`` this returns the 0-based offset INTO that window, derived from
    the planner's sourceFrameMap, so a speed ramp pulls the right source frames
    instead of a flat 1:1 cadence. Returns None when there's no usable map, so
    the caller falls back to sequential 1:1.
    """
    if not isinstance(source_frame_map, list) or not source_frame_map:
        return None
    if out_idx < 0 or out_idx >= len(source_frame_map):
        return None
    base  = (source_frame_map[0] or {}).get("sourceFrame")
    entry = (source_frame_map[out_idx] or {}).get("sourceFrame")
    if not isinstance(base, (int, float)) or not isinstance(entry, (int, float)):
        return None
    return max(0, int(round(entry - base)))


class CompanionApi:
    def __init__(self, config: CompanionConfig | None = None) -> None:
        self.config = config or CompanionConfig()
        self.http_port = ensure_http_server(port=47125)
        self.engines = [
            InternalFastPathEngine(),
            AdvancedImfEngine(),
        ]
        self.package_registry: dict[str, dict[str, Any]] = {}
        # LRU cap: evict oldest entries beyond this limit so the registry never
        # grows unbounded across a long companion session with many openFile calls.
        self._ASSET_REGISTRY_MAX = 128
        self._asset_registry: collections.OrderedDict[str, dict[str, Any]] = collections.OrderedDict()
        # Pre-warm immersive-audio capability cache so getCapabilities responds instantly
        threading.Thread(target=get_immersive_audio_support, daemon=True).start()
        # OCF EXR export job registry — keyed by short UUID job ID
        self._ocf_jobs: dict[str, dict] = {}
        # Photon QC results cache — keyed by packageId
        self._qc_cache: dict[str, dict] = {}
        # Serialize Resolve scripting-API access — the API is NOT thread-safe, and
        # the still-extraction timeline cache below is shared. Without this, parallel
        # preview requests (e.g. OCF + QT fired together) corrupt Resolve's current
        # timeline / seek state and the cache dict.
        self._ocf_resolve_lock = threading.RLock()
        # Shared media runtime — initialized lazily on first use to avoid startup delay
        self._media_runtime: MediaRuntime | None = None

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        action = str(request.get("action") or "").strip()
        handlers = {
            "hello": self._hello,
            "healthCheck": self._health_check,
            "ping": self._ping,
            "getVersion": self._get_version,
            "getCapabilities": self._get_capabilities,
            "helper.capabilities": self._helper_capabilities,
            "pickImfFolder": self._pick_imf_folder,
            "pickFolder": self._pick_folder,
            "folder.pick": self._pick_folder,
            "pickMediaFile": self._pick_media_file,
            "pickMediaFiles": self._pick_media_files,
            "pick.mediaFiles": self._pick_media_files,
            "scanImfPackage": self._scan_imf_package,
            "inspectImmersiveAudio": self._inspect_immersive_audio,
            "openFile": self._open_file,
            "buildMediaProxy": self._build_media_proxy,
            "getTimecodeInfo": self._get_timecode_info,
            "getCurrentTimecode": self._not_implemented,
            "seekTimecode": self._not_implemented,
            "seekFrame": self._not_implemented,
            "stepFrame": self._not_implemented,
            "play": self._not_implemented,
            "pause": self._not_implemented,
            "grabThumbnailAtTimecode": self._grab_thumbnail_at_timecode,
            "grabThumbnailAtPlayhead": self._not_implemented,
            "grabThumbnailStrip": self._not_implemented,
            "timecodeToFrame": self._not_implemented,
            "frameToTimecode": self._not_implemented,
            "startImfPlayback": self._not_implemented,
            "startIabDecode": self._start_iab_decode,
            "startProxyPlayback": self._start_proxy_playback,
            "restoreProxyOutput": self._restore_proxy_output,
            "stopPlayback": self._stop_playback,
            "getPlaybackStatus": self._not_implemented,
            "buildProxy": self._start_proxy_playback,
            "getJobStatus": self._get_job_status,
            "cancelJob": self._cancel_job,
            "revealArtifact": self._reveal_artifact,
            "getDoviMetafier":      self._get_dovi_metafier,
            "detectMetafier":       self._detect_metafier,
            "extractDoviFromMxf":   self._extract_dovi_from_mxf,
            "getImfRealPath":       self._get_imf_real_path,
            "readExtractedXml":     self._read_extracted_xml,
            "runImfQc": self._run_imf_qc,
            "getQcResults": self._get_qc_results,
            "getJobLog": self._get_job_log,
            "getEngineInfo": self._get_engine_info,
            "extractWaveformPeaks": self._extract_waveform_peaks,
            "lookupProxy": self._lookup_proxy,
            "deleteProxy": self._delete_proxy,
            "pruneProxyRegistry": self._prune_proxy_registry,
            "getGpuUsage": self._get_gpu_usage,
            "createFolder": self._create_folder,
            # ── Shared media runtime (all tabs) ──────────────────────────────
            "mediaOpenFile":        self._media_open_file,
            "mediaCloseFile":       self._media_close_file,
            "mediaGetMetadata":     self._media_get_metadata,
            "mediaGetFrame":        self._media_get_frame,
            "mediaSeekFrame":       self._media_seek_frame,
            "mediaPlay":            self._media_play,
            "mediaPause":           self._media_pause,
            "mediaGetBackendStatus": self._media_get_backend_status,
            "mediaListSessions":    self._media_list_sessions,
            # Phase 7: cache + prefetch
            "mediaPrefetch":        self._media_prefetch,
            "mediaCacheStats":      self._media_cache_stats,
            "mediaClearCache":      self._media_clear_cache,
            # ── OCF → EXR Pull (PostFlowX 2.5+) ─────────────────────────────
            "ocfPickFolder":        self._ocf_pick_folder,
            "ocfProbeFolder":       self._ocf_probe_folder,
            "ocfProbeFile":         self._ocf_probe_file,
            "ocfExrExportStart":    self._ocf_exr_export_start,
            "ocfExrExportStatus":   self._ocf_exr_export_status,
            "ocfExrExportCancel":   self._ocf_exr_export_cancel,
            "ocfExtractFrame":      self._ocf_extract_frame,
            "ocfExtractFrameToFile": self._ocf_extract_frame_to_file,
            "ocfExtractProxyMov":   self._ocf_extract_proxy_mov,
            "ocfWriteFiles":        self._ocf_write_files,
            "ocfCopyExrDelivery":   self._ocf_copy_exr_delivery,
            # ── OCF Playback Engine (PostFlowX 3.0) ──────────────────────────
            "ocfScan":              self._ocf_engine_scan,
            "ocfEngineProbe":       self._ocf_engine_probe,
            "ocfSelectEngine":      self._ocf_engine_select,
            "ocfDecodeFrame":       self._ocf_engine_decode_frame,
            "ocfPlay":              self._ocf_engine_play,
            "ocfGenerateProxy":     self._ocf_engine_generate_proxy,
            "ocfProxyJobStatus":    self._ocf_proxy_job_status,
            "ocfEngineStatus":      self._ocf_engine_status,
            "ocfShowLogs":          self._ocf_engine_show_logs,
            "ocfRefreshEngines":    self._ocf_refresh_engines,
            # ── VFX Pull render engine (v3) ───────────────────────────────────
            "renderPullExrStart":   self._render_pull_exr_start,
            "renderPullExrStatus":  self._render_pull_exr_status,
            "renderPullExrCancel":  self._render_pull_exr_cancel,
            # Review proxy movie (Rec.709/P3 with ACES 2.0 ODT baked) from AP0 EXRs
            "renderReviewProxyStart":  self._render_review_proxy_start,
            "pull.renderReviewProxy":  self._render_review_proxy_start,
            "qcExrSequence":        self._qc_exr_sequence,
            "writePullSidecars":    self._write_pull_sidecars,
            "openFolder":           self._open_folder,
            # ── Proxy storage root ────────────────────────────────────────────
            "setProxyRoot":         self._set_proxy_root,
            "getProxyRoot":         self._get_proxy_root,
            # ── DaVinci Resolve sync ──────────────────────────────────────────
            "resolveStatus":           self._resolve_status,
            "resolveGetMarkers":       self._resolve_get_markers,
            "resolvePushMarkers":      self._resolve_push_markers,
            "resolve.getTimeline":     self._resolve_get_timeline,
            "resolveGetTimeline":      self._resolve_get_timeline,
            "resolve.reconnectOcf":    self._resolve_reconnect_ocf,
            "resolveReconnectOcf":     self._resolve_reconnect_ocf,
            "resolve.markVfxShots":    self._resolve_mark_vfx_shots,
            "resolveMarkVfxShots":     self._resolve_mark_vfx_shots,
            "resolve.validatePaths":   self._resolve_validate_paths,
            "resolveValidatePaths":    self._resolve_validate_paths,
            # ── DaVinci Resolve Background Engine ─────────────────────────────
            "resolveDetect":        self._resolve_detect_engine,
            "resolve.detect":       self._resolve_detect_engine,
            "resolveTest":          self._resolve_test_engine,
            "resolve.test":         self._resolve_test_engine,
            "resolveEngineStatus":  self._resolve_engine_status,
            "resolve.engineStatus": self._resolve_engine_status,
            "resolveStartEngine":   self._resolve_start_engine,
            "resolve.startEngine":  self._resolve_start_engine,
            "resolveStartBackground":  self._resolve_start_background,
            "resolve.startBackground": self._resolve_start_background,
            "resolveStopEngine":    self._resolve_stop_engine,
            "resolve.stopEngine":   self._resolve_stop_engine,
            "resolveRunJob":        self._resolve_run_job_engine,
            "resolve.runJob":       self._resolve_run_job_engine,
            "resolveCancelJob":     self._resolve_cancel_job_engine,
            "resolve.cancelJob":    self._resolve_cancel_job_engine,
            "resolveJobStatus":     self._resolve_job_status_engine,
            "resolve.jobStatus":    self._resolve_job_status_engine,
            "resolveManualHandoff": self._resolve_manual_handoff_engine,
            "resolve.manualHandoff": self._resolve_manual_handoff_engine,
            "resolveListJobs":     self._resolve_list_jobs_engine,
            "resolve.listJobs":    self._resolve_list_jobs_engine,
            "resolveProbeClips":   self._resolve_probe_clips,
            "resolve.probeClips":  self._resolve_probe_clips,
            "resolveClearQueue":   self._resolve_clear_queue_engine,
            "resolve.clearQueue":  self._resolve_clear_queue_engine,
            "resolveGetLogs":      self._resolve_get_logs_engine,
            "resolve.getLogs":     self._resolve_get_logs_engine,
            "resolveOpenLogs":     self._resolve_get_logs_engine,
            "resolve.openLogs":    self._resolve_get_logs_engine,
            # ── Trailer Conform Engine ─────────────────────────────────────────
            "conformPreflight":     self._conform_preflight,
            "conformAnalyze":       self._conform_analyze,
            "conformJobStatus":     self._conform_job_status,
            "conformBuildTimeline": self._conform_build_timeline,
            "conformCancelJob":     self._conform_cancel_job,
            "conformExport":        self._conform_export,
            # ── AAF export ────────────────────────────────────────────────────
            "aafCapabilities":      self._aaf_capabilities,
            "aafStatus":            self._aaf_status,
            "aafTestWrite":         self._aaf_test_write,
            "aafRepair":            self._aaf_repair,
            "exportNLELinkedAAF":   self._export_nle_linked_aaf,
            "exportProToolsAAF":    self._export_protools_aaf,
            # ── OCF per-decoder still endpoints (JS-orchestrated tiers) ─────────
            "vfxPreviewResolveStill":      self._vfx_preview_resolve_still,
            "vfx.preview.resolveStill":    self._vfx_preview_resolve_still,
            "vfxPreviewResolveStillBatch": self._vfx_preview_resolve_still_batch,
            "vfx.preview.resolveStillBatch": self._vfx_preview_resolve_still_batch,
            "resolve.previewFrameBatch":   self._vfx_preview_resolve_still_batch,
            "resolve.extractStillFrame":   self._vfx_preview_resolve_still,
            "resolve.previewFrame":        self._vfx_preview_resolve_still,
            "resolve.extract_still_frame": self._vfx_preview_resolve_still,
            "vfxPreviewAvfStill":        self._vfx_preview_avf_still,
            "vfx.preview.avfStill":      self._vfx_preview_avf_still,
            # ── Apple Vision OCR (macOS only) ─────────────────────────────────
            "ocrImage":             self._ocr_image,
            "ocrCapabilities":      self._ocr_capabilities,
            # ── IMF frame thumbnail (companion-mode preview) ───────────────────
            "getImfFrameThumb":     self._get_imf_frame_thumb,
            # ── ACES 2.0 output transforms (color) ─────────────────────────────
            "colorAces2OutputTransforms":   self._color_aces2_output_transforms,
            "color.aces2OutputTransforms":  self._color_aces2_output_transforms,
        }
        handler = handlers.get(action)
        if not handler:
            return self._error(
                "BAD_REQUEST",
                f"Unknown action: {action}",
                "That action is not supported by this build.",
            )
        return handler(request)

    def _ok(self, data: dict[str, Any]) -> dict[str, Any]:
        return ResponseEnvelope(
            status="ok",
            apiVersion=self.config.api_version,
            companionVersion=self.config.companion_version,
            data=data,
        ).to_dict()

    def _error(
        self,
        code: str,
        message: str,
        user_message: str,
        retryable: bool = False,
    ) -> dict[str, Any]:
        return ResponseEnvelope(
            status="error",
            apiVersion=self.config.api_version,
            companionVersion=self.config.companion_version,
            error=ErrorPayload(
                code=code,
                message=message,
                userMessage=user_message,
                retryable=retryable,
            ),
        ).to_dict()

    def _hello(self, _: dict[str, Any]) -> dict[str, Any]:
        return self._ok({
            "version": self.config.companion_version,
            "productName": self.config.product_name,
            "platform": platform.system().lower(),
            "ready": True,
        })

    def _health_check(self, _: dict[str, Any]) -> dict[str, Any]:
        return self._ok({
            "status": "healthy",
            "version": self.config.companion_version,
            "platform": platform.system().lower(),
            "httpPort": self.http_port,
        })

    def _create_folder(self, request: dict[str, Any]) -> dict[str, Any]:
        folder_path = str(request.get("path") or "").strip()
        if not folder_path:
            return self._error("BAD_REQUEST", "path is required", "No folder path provided.")
        try:
            Path(folder_path).mkdir(parents=True, exist_ok=True)
            return self._ok({"path": folder_path, "created": True})
        except Exception as exc:
            return self._error("IO_ERROR", f"Could not create folder: {exc}",
                               f"Failed to create folder at {folder_path}.")

    def _ping(self, _: dict[str, Any]) -> dict[str, Any]:
        return self._ok({"ready": True, "port": self.http_port, "httpToken": get_http_token()})

    def _get_version(self, _: dict[str, Any]) -> dict[str, Any]:
        return self._ok({
            "build": self.config.companion_version,
            "platform": platform.system().lower(),
            "productName": self.config.product_name,
        })

    def _get_capabilities(self, _: dict[str, Any]) -> dict[str, Any]:
        immersive = get_immersive_audio_support()
        ffmpeg_path = _find_ffmpeg()
        ffprobe_path = _find_ffprobe(ffmpeg_path) if ffmpeg_path else None
        backend_diag = {}
        try:
            backend_diag = self._get_media_runtime().get_backend_status()
        except Exception:
            backend_diag = {}
        return self._ok({
            "version": self.config.companion_version,
            "platform": platform.system().lower(),
            "engines": [engine.describe() for engine in self.engines],
            "backends": backend_diag.get("backends") or {},
            "features": {
                "imfPlayback": False,
                "fullCplProxy": self.http_port is not None,
                "dolbyVisionMetadata": True,
                "iabDecode": bool(immersive.get("iabDecode")),
                "admDecode": bool(immersive.get("admDecode")),
                "proresImf": False,
                "photonQc": False,
                "nativePlayback": False,
                "sourceTimecode": bool(ffprobe_path),
                "thumbnailGrab": bool(ffmpeg_path),
                "pickImfFolder": True,
                "scanImfPackage": True,
                # OCF → EXR Pull capabilities
                "ocfProbe":       bool(ffprobe_path),
                "ocfExrExport":   bool(ffmpeg_path),
                "ocfPickFolder":  True,
                "ocfNativeSdks":  _detect_camera_sdks(),
                "ocfColorPipeline": _detect_color_pipeline(),
            },
            "immersiveAudio": immersive,
            "httpToken": get_http_token(),
        })

    def _helper_capabilities(self, _: dict[str, Any]) -> dict[str, Any]:
        resolve_connected = self._get_resolve_app() is not None
        ffmpeg_path = _find_ffmpeg()
        return self._ok({
            "ok": True,
            "capabilities": {
                "resolveConnected":        resolve_connected,
                "resolveExtractStillFrame": True,
                "resolveStillBatch":       True,
                "ffmpegFallback":          bool(ffmpeg_path),
            },
            "actions": [
                "vfxPreviewResolveStill",
                "vfx.preview.resolveStill",
                "vfxPreviewResolveStillBatch",
                "vfx.preview.resolveStillBatch",
                "resolve.extractStillFrame",
                "resolve.previewFrame",
                "resolve.extract_still_frame",
                "vfxPreviewAvfStill",
                "vfx.preview.avfStill",
                "helper.capabilities",
            ],
        })

    def _get_engine_info(self, _: dict[str, Any]) -> dict[str, Any]:
        return self._ok({
            "activeEngine": None,
            "httpPort": self.http_port,
            "httpToken": get_http_token(),
            "engines": [engine.describe() for engine in self.engines],
        })

    def _pick_imf_folder(self, _: dict[str, Any]) -> dict[str, Any]:
        try:
            folder_path = pick_folder()
        except Exception as exc:
            return self._error(
                "ENGINE_UNSUPPORTED",
                f"Folder picker failed: {exc}",
                "Could not open the package picker on this system.",
            )
        if not folder_path:
            return self._error(
                "CANCELLED",
                "User cancelled folder picker",
                "Package selection cancelled.",
                retryable=True,
            )
        return self._ok({"folderPath": folder_path})

    def _pick_folder(self, request: dict[str, Any]) -> dict[str, Any]:
        title = str(request.get("title") or "Select folder").strip() or "Select folder"
        try:
            folder_path = pick_folder(title=title)
        except Exception as exc:
            return self._error(
                "ENGINE_UNSUPPORTED",
                f"Folder picker failed: {exc}",
                "Could not open the folder picker on this system.",
            )
        if not folder_path:
            return self._error(
                "CANCELLED",
                "User cancelled folder picker",
                "Folder selection cancelled.",
                retryable=True,
            )
        return self._ok({"folderPath": folder_path, "path": folder_path})

    def _pick_media_file(self, request: dict[str, Any]) -> dict[str, Any]:
        title = str(request.get("title") or "Select media file").strip() or "Select media file"
        filetypes = _extensions_to_filetypes(request.get("extensions"))
        try:
            file_path = pick_file(title=title, filetypes=filetypes)
        except Exception as exc:
            return self._error(
                "ENGINE_UNSUPPORTED",
                f"File picker failed: {exc}",
                "Could not open the file picker on this system.",
            )
        if not file_path:
            return self._error(
                "CANCELLED",
                "User cancelled file picker",
                "File selection cancelled.",
                retryable=True,
            )
        return self._ok({"filePath": file_path, "path": file_path})

    def _pick_media_files(self, request: dict[str, Any]) -> dict[str, Any]:
        title = str(request.get("title") or "Select media files").strip() or "Select media files"
        filetypes = _extensions_to_filetypes(request.get("extensions"))
        try:
            file_paths = pick_files(title=title, filetypes=filetypes)
        except Exception as exc:
            return self._error(
                "ENGINE_UNSUPPORTED",
                f"Multi-file picker failed: {exc}",
                "Could not open the file picker on this system.",
            )
        if not file_paths:
            return self._error(
                "CANCELLED",
                "User cancelled file picker",
                "File selection cancelled.",
                retryable=True,
            )
        return self._ok({"filePaths": file_paths, "paths": file_paths})

    def _scan_imf_package(self, request: dict[str, Any]) -> dict[str, Any]:
        folder_path = str(request.get("folderPath") or "").strip()
        if not folder_path:
            return self._error(
                "BAD_REQUEST",
                "folderPath is required",
                "No IMF package folder was provided.",
            )
        try:
            data = scan_imf_package(folder_path)
        except FileNotFoundError as exc:
            return self._error("NOT_FOUND", str(exc), "The selected IMF folder was not found.")
        except ValueError as exc:
            return self._error("PACKAGE_INVALID", str(exc), "No valid IMF package was found in that folder.")
        except Exception as exc:
            return self._error(
                "PACKAGE_UNREADABLE",
                f"scanImfPackage failed: {exc}",
                "Could not read the IMF package.",
            )
        self.package_registry[data["packageId"]] = {
            "folderPath": data["folderPath"],
            "packages": (data.get("snapshot") or {}).get("packages") or [],
            "cpls": {
                str(cpl["cplId"]): {
                    "relativePath": str(cpl["relativePath"]),
                    "absolutePath": str((Path(data["folderPath"]) / str(cpl["relativePath"])).resolve()),
                }
                for cpl in data.get("cpls", [])
            },
        }
        return self._ok(data)

    def _run_imf_qc(self, request: dict[str, Any]) -> dict[str, Any]:
        package_id = str(request.get("packageId") or "").strip()
        if not package_id:
            return self._error("BAD_REQUEST", "packageId is required", "No package ID was provided.")
        package = self.package_registry.get(package_id)
        if package is None:
            return self._error(
                "NOT_FOUND",
                f"Unknown packageId: {package_id}",
                "Run scanImfPackage first to register the package.",
            )
        folder_path = package.get("folderPath", "")
        result = _run_photon_qc(folder_path)
        result["packageId"] = package_id
        self._qc_cache[package_id] = result
        return self._ok(result)

    def _get_qc_results(self, request: dict[str, Any]) -> dict[str, Any]:
        package_id = str(request.get("packageId") or "").strip()
        if not package_id:
            return self._error("BAD_REQUEST", "packageId is required", "No package ID was provided.")
        cached = self._qc_cache.get(package_id)
        if cached is None:
            return self._error(
                "NOT_FOUND",
                f"No QC results for packageId: {package_id}",
                "Run runImfQc first.",
            )
        return self._ok(cached)

    def _inspect_immersive_audio(self, request: dict[str, Any]) -> dict[str, Any]:
        package_id = str(request.get("packageId") or "").strip()
        cpl_id = str(request.get("cplId") or "").strip()
        resolved, err = self._resolve_iab_asset(package_id, cpl_id)
        if err:
            return err
        if resolved is None:
            return self._error("INTERNAL_ERROR", "Failed to resolve IAB asset", "An unexpected error occurred.")
        path = resolved["path"]
        iab_resource = resolved["resource"]
        try:
            info = _inspect_iab_asset(path)
        except Exception as exc:
            return self._error(
                "IAB_READ_FAILED",
                f"inspectImmersiveAudio failed: {exc}",
                "Could not inspect the IAB asset.",
            )
        info.update({
            "assetName": path.name,
            "assetPath": str(path),
            "trackFileId": str(iab_resource.get("trackFileId") or ""),
            "source": "companion",
            "immersiveAudio": get_immersive_audio_support(),
        })
        return self._ok(info)

    def _start_iab_decode(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.http_port is None:
            return self._error(
                "ENGINE_UNAVAILABLE",
                "HTTP session server is unavailable",
                "The playback service is unavailable in this environment.",
            )
        package_id = str(request.get("packageId") or "").strip()
        cpl_id = str(request.get("cplId") or "").strip()
        options = request.get("options") or {}
        resolved, err = self._resolve_iab_asset(package_id, cpl_id)
        if err:
            return err
        if resolved is None:
            return self._error("INTERNAL_ERROR", "Failed to resolve IAB asset", "An unexpected error occurred.")
        path = resolved["path"]
        resource = resolved["resource"]
        session_id = uuid.uuid4().hex[:16]
        sidecar = _read_proxy_sidecar(path)
        create_session(session_id, {
            "kind": "iab_decode",
            "done": False,
            "pct": 0,
            "error": None,
            "stage": "queued",
            "message": f"Queued IAB decode for {path.name}",
            "artifactPath": "",
            "artifactType": "wav",
            "assetPath": str(path),
            "trackFileId": str(resource.get("trackFileId") or ""),
            "immersive": get_immersive_audio_support(),
            "_log": "",
            "proc": None,
        })
        ok, start_err = start_iab_decode(
            session_id,
            str(path),
            out_dir=str(options.get("outDir") or ""),
        )
        if not ok:
            stop_session(session_id)
            return self._error(
                "IAB_DECODE_FAILED",
                start_err or "Failed to start IAB decode",
                "Could not start IAB decode.",
            )
        return self._ok({
            "jobId": session_id,
            "kind": "iab_decode",
            "progressUrl": f"http://127.0.0.1:{self.http_port}/progress/{session_id}",
            "logUrl": f"http://127.0.0.1:{self.http_port}/log/{session_id}",
            "trackFileId": str(resource.get("trackFileId") or ""),
            "assetPath": str(path),
            "assetName": path.name,
            "artifactType": "wav",
            "immersiveAudio": get_immersive_audio_support(),
        })

    def _extract_waveform_peaks(self, request: dict[str, Any]) -> dict[str, Any]:
        wav_path       = str(request.get("wavPath") or "").strip()
        max_sec        = float(request.get("maxSec") or 0)
        points_per_sec = int(request.get("pointsPerSec") or 100)
        if not wav_path or not os.path.isfile(wav_path):
            return self._error("WAV_NOT_FOUND", f"WAV not found: {wav_path}", "Decoded WAV file not found.")
        try:
            data = extract_waveform_peaks(wav_path, points_per_sec=points_per_sec, max_sec=max_sec)
            return self._ok(data)
        except Exception as exc:
            return self._error("WAVEFORM_ERROR", str(exc), "Failed to extract waveform peaks.")

    def _lookup_proxy(self, request: dict[str, Any]) -> dict[str, Any]:
        """Check the content-addressable proxy registry.

        Accepts CPL metadata from the JS side, computes a stable fingerprint, and
        returns the cached proxy path + metadata if a valid proxy exists on disk.
        """
        cpl_id = str(request.get("cplId") or "").strip()
        track_file_ids = [str(t) for t in (request.get("trackFileIds") or []) if t]
        total_frames = int(float(str(request.get("totalFrames") or 0) or 0))
        edit_rate = request.get("editRate") or 0.0

        if not cpl_id:
            return self._ok({"found": False, "fingerprint": ""})

        fp = _reg_fingerprint(cpl_id, track_file_ids, total_frames, edit_rate)
        entry = _reg_lookup(fp)

        if not entry:
            return self._ok({"found": False, "fingerprint": fp})

        return self._ok({
            "found": True,
            "fingerprint": fp,
            "proxyPath": str(entry.get("proxyPath") or ""),
            "proxyName": str(entry.get("proxyName") or ""),
            "audioMode": str(entry.get("audioMode") or ""),
            "audioMessage": str(entry.get("audioMessage") or ""),
            "startTimecode": str(entry.get("startTimecode") or ""),
            "fps": float(entry.get("fps") or 0),
            "cplId": str(entry.get("cplId") or cpl_id),
            "contentTitle": str(entry.get("contentTitle") or ""),
            "folderPath": str(entry.get("folderPath") or ""),
            "createdAt": int(entry.get("createdAt") or 0),
            "updatedAt": int(entry.get("updatedAt") or 0),
        })

    def _delete_proxy(self, request: dict[str, Any]) -> dict[str, Any]:
        """Delete the cached proxy file (and sidecar/progress/log) for a given CPL fingerprint or path."""
        import os, glob as _glob
        proxy_path_str = str(request.get("proxyPath") or "").strip()
        fingerprint = str(request.get("fingerprint") or "").strip()
        deleted: list[str] = []
        errors: list[str] = []

        paths_to_remove: list[Path] = []
        if proxy_path_str:
            p = Path(proxy_path_str).expanduser().resolve()
            if p.suffix.lower() == ".mp4" and p.is_file():
                paths_to_remove.append(p)
                for ext in (".json", ".progress", ".log"):
                    sib = p.with_suffix(ext)
                    if sib.is_file():
                        paths_to_remove.append(sib)

        for p in paths_to_remove:
            try:
                p.unlink()
                deleted.append(str(p))
            except Exception as exc:
                errors.append(f"{p}: {exc}")

        # Also remove from registry
        if fingerprint:
            try:
                from .proxy_registry import remove_entry
                remove_entry(fingerprint)
            except Exception:
                pass

        if errors:
            return self._error("DELETE_FAILED", f"Could not delete: {'; '.join(errors)}", "Some proxy files could not be deleted.")
        return self._ok({"deleted": deleted, "count": len(deleted)})

    def _prune_proxy_registry(self, _: dict[str, Any]) -> dict[str, Any]:
        try:
            removed = _reg_prune()
            return self._ok({"removed": removed})
        except Exception as exc:
            return self._error("REGISTRY_ERROR", str(exc), "Failed to prune proxy registry.")

    def _restore_proxy_output(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.http_port is None:
            return self._error(
                "ENGINE_UNAVAILABLE",
                "HTTP session server is unavailable",
                "The playback service is unavailable in this environment.",
            )
        output_path = str(request.get("outputPath") or "").strip()
        folder_path = str(request.get("folderPath") or "").strip()
        cpl_path = str(request.get("cplPath") or "").strip()
        audio_mode = str(request.get("audioMode") or "unknown").strip() or "unknown"
        audio_message = str(request.get("audioMessage") or "").strip()
        if not output_path:
            return self._error("BAD_REQUEST", "outputPath is required", "No cached proxy path was provided.")
        path = Path(output_path).expanduser().resolve()
        path_exists = False
        try:
            path_exists = path.is_file() and path.stat().st_size > 0
        except Exception:
            path_exists = False

        # Rename legacy/misnamed proxy to the ContentTitle- or QT-filename-based name
        if folder_path and cpl_path:
            try:
                folder_p = Path(folder_path).expanduser().resolve()
                cpl_p = Path(cpl_path).expanduser().resolve()
                if folder_p.is_dir() and cpl_p.is_file():
                    from .imf_scan import _parse_cpl as _scan_cpl_local
                    cpl_data: dict = {}
                    try:
                        cpl_data = _scan_cpl_local(cpl_p)
                    except Exception:
                        pass
                    main_p = _resolve_main_media_from_cpl(cpl_p, folder_p)
                    out_dir_str = str(path.parent)
                    desired = _proxy_cache_path(folder_p, cpl_p, out_dir_str, cpl_data, main_p)
                    adopted = _adopt_named_proxy_cache(
                        folder_p, cpl_p, desired,
                        out_dir=out_dir_str, cpl_data=cpl_data, main_path=main_p,
                    )
                    if str(adopted) != str(path):
                        path = adopted
                        try:
                            path_exists = path.is_file() and path.stat().st_size > 0
                        except Exception:
                            path_exists = False
            except Exception:
                pass

        dovi = {}
        if folder_path and cpl_path:
            try:
                dovi = _extract_dovi(Path(cpl_path).expanduser().resolve(), Path(folder_path).expanduser().resolve())
            except Exception:
                dovi = {}

        session_id = uuid.uuid4().hex[:16]
        if not path_exists:
            restored = _restore_running_proxy_session(session_id, path, folder_path, cpl_path, audio_mode, audio_message)
            if not restored:
                return self._error("NOT_FOUND", f"Cached proxy missing: {path}", "The cached proxy file could not be found.")
            state = get_session(session_id) or {}
            return self._ok({
                "jobId": session_id,
                "sessionId": session_id,
                "kind": "proxy",
                "cached": False,
                "state": "running",
                "progressUrl": f"http://127.0.0.1:{self.http_port}/progress/{session_id}",
                "streamUrl": f"http://127.0.0.1:{self.http_port}/stream/{session_id}",
                "metadataUrl": f"http://127.0.0.1:{self.http_port}/imf_dovi/{session_id}",
                "logUrl": f"http://127.0.0.1:{self.http_port}/log/{session_id}",
                "engineId": "internal-fastpath",
                "audioMode": state.get("audioMode", audio_mode),
                "audioMessage": state.get("audioMessage", audio_message),
                "immersiveAudio": state.get("immersive") or get_immersive_audio_support(),
                "outputPath": str(path),
                "proxyName": str(state.get('proxyName') or path.stem),
                "startTimecode": str(state.get('startTimecode') or ''),
            })

        sidecar = _read_proxy_sidecar(path)
        # Prefer the audioMode/audioMessage recorded in the sidecar when the proxy was built.
        # The request carries the client's previously-known value which may be stale (e.g. an
        # older 'video_only' from before IAB decode was wired up).  Fall back to the request
        # value only when the sidecar has nothing useful — mirrors _restore_running_proxy_session
        # which already reads audioMode from the sidecar.
        _sidecar_mode = str(sidecar.get("audioMode") or "").strip()
        _sidecar_msg  = str(sidecar.get("audioMessage") or "").strip()
        _effective_mode = _sidecar_mode or audio_mode
        _effective_msg  = _sidecar_msg  or audio_message
        create_session(session_id, {
            "kind": "proxy",
            "path": str(path),
            "done": True,
            "pct": 100,
            "stage": "complete",
            "message": "Proxy ready (restored)",
            "error": None,
            "dovi": dovi,
            "audioMode": _effective_mode,
            "audioMessage": _effective_msg,
            "immersive": get_immersive_audio_support(),
            "proxyName": str(sidecar.get('proxyName') or path.stem),
            "startTimecode": str(sidecar.get('startTimecode') or ''),
            "_log": ("[companion] restored_from_output=1\n" + f"[companion] output_path={path}"),
            "proc": None,
        })
        return self._ok({
            "jobId": session_id,
            "sessionId": session_id,
            "kind": "proxy",
            "cached": True,
            "state": "done",
            "progressUrl": f"http://127.0.0.1:{self.http_port}/progress/{session_id}",
            "streamUrl": f"http://127.0.0.1:{self.http_port}/stream/{session_id}",
            "metadataUrl": f"http://127.0.0.1:{self.http_port}/imf_dovi/{session_id}",
            "logUrl": f"http://127.0.0.1:{self.http_port}/log/{session_id}",
            "engineId": "internal-fastpath",
            "audioMode": _effective_mode,
            "audioMessage": _effective_msg,
            "immersiveAudio": get_immersive_audio_support(),
            "outputPath": str(path),
            "proxyName": str(sidecar.get('proxyName') or path.stem),
            "startTimecode": str(sidecar.get('startTimecode') or ''),
        })

    def _start_proxy_playback(self, request: dict[str, Any]) -> dict[str, Any]:
        if self.http_port is None:
            return self._error(
                "ENGINE_UNAVAILABLE",
                "HTTP session server is unavailable",
                "The playback service is unavailable in this environment.",
            )
        package_id = str(request.get("packageId") or "").strip()
        cpl_id = str(request.get("cplId") or "").strip()
        options = request.get("options") or {}
        if not package_id or not cpl_id:
            return self._error(
                "BAD_REQUEST",
                "packageId and cplId are required",
                "No IMF package or CPL was selected.",
            )
        package = self.package_registry.get(package_id)
        if not package:
            return self._error(
                "NOT_FOUND",
                f"Unknown packageId: {package_id}",
                "The IMF package is no longer loaded in the companion.",
            )
        cpl_info = (package.get("cpls") or {}).get(cpl_id)
        if not cpl_info:
            return self._error(
                "NOT_FOUND",
                f"Unknown cplId: {cpl_id}",
                "The selected CPL is no longer available.",
            )
        try:
            migrate_named_proxy_cache(str(options.get("outDir") or ""))
        except Exception:
            pass
        session_id = uuid.uuid4().hex[:16]
        create_session(session_id, {
            "path": None,
            "done": False,
            "pct": 0,
            "error": None,
            "dovi": {},
            "audioMode": "unknown",
            "audioMessage": "",
            "immersive": get_immersive_audio_support(),
            "_log": "",
            "proc": None,
        })
        force_resolve  = bool(request.get("forceResolve") or False)
        proxy_quality  = str(request.get("proxyQuality") or "").strip().lower() or None
        # Override the env-var quality with the user's Settings preference if provided
        if proxy_quality and proxy_quality in ("turbo", "balanced", "full"):
            import os as _os
            _os.environ.setdefault("PFX_IMF_PROXY_QUALITY", proxy_quality)
            _os.environ["PFX_IMF_PROXY_QUALITY"] = proxy_quality
        ok, err = start_proxy_playback(
            session_id,
            str(package["folderPath"]),
            str(cpl_info["absolutePath"]),
            out_dir=str(options.get("outDir") or ""),
            force_resolve=force_resolve,
        )
        if not ok:
            stop_session(session_id)
            return self._error(
                "PROXY_FAILED",
                err or "Failed to start proxy playback",
                "Could not start IMF proxy playback.",
            )
        state = get_session(session_id) or {}
        cached = bool(state.get("done") and state.get("path") and not state.get("error"))
        return self._ok({
            "jobId": session_id,
            "sessionId": session_id,
            "kind": "proxy",
            "cached": cached,
            "progressUrl": f"http://127.0.0.1:{self.http_port}/progress/{session_id}",
            "streamUrl": f"http://127.0.0.1:{self.http_port}/stream/{session_id}",
            "metadataUrl": f"http://127.0.0.1:{self.http_port}/imf_dovi/{session_id}",
            "logUrl": f"http://127.0.0.1:{self.http_port}/log/{session_id}",
            "engineId": "internal-fastpath",
            "audioMode": state.get("audioMode", "unknown"),
            "audioMessage": state.get("audioMessage", ""),
            "immersiveAudio": state.get("immersive") or get_immersive_audio_support(),
            "outputPath": state.get("path") or "",
            "proxyName": state.get("proxyName") or str(cpl_info.get('contentTitle') or cpl_info.get('label') or Path(cpl_info.get('absolutePath') or '').stem),
            "startTimecode": str(state.get('startTimecode') or ''),
        })

    def _get_job_status(self, request: dict[str, Any]) -> dict[str, Any]:
        job_id = str(request.get("jobId") or "").strip()
        if not job_id:
            return self._error("BAD_REQUEST", "jobId is required", "No job was provided.")
        state = get_session(job_id)
        if not state:
            return self._error("JOB_NOT_FOUND", f"Unknown jobId: {job_id}", "That job was not found.")
        kind = str(state.get("kind") or "proxy")
        done = bool(state.get("done"))
        failed = bool(state.get("error"))
        result = None
        if done and not failed:
            if kind == "proxy":
                result = {
                    "sessionId": job_id,
                    "streamUrl": f"http://127.0.0.1:{self.http_port}/stream/{job_id}",
                    "metadataUrl": f"http://127.0.0.1:{self.http_port}/imf_dovi/{job_id}",
                }
            elif kind == "iab_decode":
                result = {
                    "artifactPath": state.get("artifactPath") or "",
                    "artifactType": state.get("artifactType") or "wav",
                    "assetPath": state.get("assetPath") or "",
                    "trackFileId": state.get("trackFileId") or "",
                }
        return self._ok({
            "jobId": job_id,
            "kind": kind,
            "state": "done" if done and not failed else "failed" if failed else "running",
            "pct": state.get("pct", 0),
            "stage": state.get("stage") or ("complete" if done and not failed else "running"),
            "message": state.get("message") or state.get("error") or ("Job ready" if done else "Working…"),
            "audioMode": state.get("audioMode", "unknown"),
            "audioMessage": state.get("audioMessage", ""),
            "artifactPath": state.get("artifactPath") or "",
            "artifactType": state.get("artifactType") or "",
            "assetPath": state.get("assetPath") or "",
            "trackFileId": state.get("trackFileId") or "",
            "immersiveAudio": state.get("immersive") or get_immersive_audio_support(),
            "proxyName": str(state.get('proxyName') or ''),
            "startTimecode": str(state.get('startTimecode') or ''),
            "result": result,
            "outputPath": state.get("path") or "",
        })

    def _get_job_log(self, request: dict[str, Any]) -> dict[str, Any]:
        job_id = str(request.get("jobId") or "").strip()
        if not job_id:
            return self._error("BAD_REQUEST", "jobId is required", "No job was provided.")
        state = get_session(job_id)
        if not state:
            return self._error("JOB_NOT_FOUND", f"Unknown jobId: {job_id}", "That job was not found.")
        return self._ok({
            "jobId": job_id,
            "log": state.get("_log", ""),
        })

    def _stop_playback(self, request: dict[str, Any]) -> dict[str, Any]:
        session_id = str(request.get("sessionId") or "").strip()
        if not session_id:
            return self._error("BAD_REQUEST", "sessionId is required", "No playback session was provided.")
        stop_session(session_id)
        return self._ok({"stopped": True})

    def _cancel_job(self, request: dict[str, Any]) -> dict[str, Any]:
        job_id = str(request.get("jobId") or "").strip()
        if not job_id:
            return self._error("BAD_REQUEST", "jobId is required", "No job ID was provided.")
        stop_session(job_id)
        return self._ok({"cancelled": True, "jobId": job_id})

    def _reveal_artifact(self, request: dict[str, Any]) -> dict[str, Any]:
        artifact_path = str(request.get("artifactPath") or "").strip()
        if not artifact_path:
            return self._error("BAD_REQUEST", "artifactPath is required", "No artifact path was provided.")
        path = Path(artifact_path)
        if not path.exists():
            return self._error("NOT_FOUND", f"Artifact not found: {artifact_path}", "The decoded artifact file no longer exists.")
        sys_name = platform.system()
        try:
            # Use subprocess.run() instead of Popen() — Popen without .wait() leaves
            # zombie processes in the process table for the lifetime of the companion.
            # These reveal commands (open -R, explorer /select, xdg-open) all exit
            # within milliseconds of launching Finder/Explorer, so the 5s timeout
            # never triggers in normal use.
            if sys_name == "Darwin":
                subprocess.run(["open", "-R", str(path)], timeout=5, check=False)
            elif sys_name == "Windows":
                subprocess.run(["explorer", f"/select,{path}"], timeout=5, check=False)
            else:
                subprocess.run(["xdg-open", str(path.parent)], timeout=5, check=False)
        except Exception as exc:
            return self._error("REVEAL_FAILED", f"Could not reveal artifact: {exc}", "Failed to open the artifact in Finder.")
        return self._ok({"revealed": True, "artifactPath": str(path)})

    def _get_dovi_metafier(self, request: dict[str, Any]) -> dict[str, Any]:
        import json as _json
        folder = str(request.get("folder") or "").strip()
        cpl_path_hint = str(request.get("cplPath") or "").strip()
        if not folder:
            return self._error("BAD_REQUEST", "folder is required", "No IMF folder path provided.")
        folder_path = Path(folder)
        if not folder_path.is_dir():
            return self._error("NOT_FOUND", f"Folder not found: {folder}", "IMF folder not found.")

        # Build a list of all directories to search: package folder + siblings (VF → OV)
        _search_dirs: list[Path] = [folder_path]
        try:
            for _sib in folder_path.parent.iterdir():
                if _sib.is_dir() and _sib != folder_path and not _sib.name.startswith("."):
                    _search_dirs.append(_sib)
        except Exception:
            pass

        # ── STEP 0: CPL XML scan — fastest, most reliable for HTJ2K IMF DV ──────
        # DV IMF packages embed DolbyVisionSubDescriptor in the CPL EssenceDescriptorList.
        # This appears as ASCII text in the CPL XML and is the canonical detection method
        # for JPEG 2000 / HTJ2K packages where the DV metadata is carried in the MXF as
        # a generic stream, not as ffprobe-detectable side data.
        _DV_CPL_MARKERS = (
            "DolbyVisionSubDescriptor", "DVImageDescriptor",
            "DolbyVisionMetadata", "DolbyVision",
        )
        # Check CPL path hint first (passed by the JS layer)
        if cpl_path_hint:
            try:
                _cpl_text = Path(cpl_path_hint).read_text(encoding="utf-8", errors="ignore")[:131072]
                if any(_k in _cpl_text for _k in _DV_CPL_MARKERS):
                    return self._ok({"shots": [], "fromMxfHeader": True,
                                     "xmlPath": cpl_path_hint, "detectedBy": "cpl_xml_hint"})
            except Exception:
                pass
        # Scan all CPL XML files in the search directories
        for _scan_dir in _search_dirs:
            for _xml in sorted(_scan_dir.rglob("*.xml"))[:40]:
                if _xml.name.lower() in {"assetmap.xml", "packinglist.xml"}:
                    continue
                try:
                    _txt = _xml.read_text(encoding="utf-8", errors="ignore")[:131072]
                    if "CompositionPlaylist" in _txt and any(_k in _txt for _k in _DV_CPL_MARKERS):
                        return self._ok({"shots": [], "fromMxfHeader": True,
                                         "xmlPath": str(_xml), "detectedBy": "cpl_xml_scan"})
                except Exception:
                    continue

        # ── STEP 1: Metafier XML scan — fastest, most complete (has per-shot data) ──
        try:
            data = _extract_dovi(folder_path, folder_path)
        except Exception:
            data = {}
        if data.get("shots"):
            return self._ok(data)

        # ── STEP 2: Binary MXF header scan + embedded CM XML extraction ─────────
        # DolbyVisionSubDescriptor appears as ASCII text in J2K MXF structural
        # metadata. HTJ2K MXF files with large structural metadata need a deeper
        # scan — read 512 KB to cover files with many essence descriptors.
        # Markers cover CM v2.0.5, CM v4.0, CM v5.0, and proprietary variants.
        _DV_BINARY_MARKERS = [
            b"DolbyVisionSubDescriptor",   # MXF EssenceDescriptor canonical name
            b"DolbyVisionFrameData",       # DM v4.1 frame-interleaved (DaVinci Resolve)
            b"DolbyVisionGlobalData",      # DM v4.1 global metadata block
            b"DVDynamicData",              # DM v4.1 per-frame dynamic data
            b"DolbyVisionFrameInfo",       # older frame-interleaved DV metadata
            b"DolbyLabsMDF",               # CM XML root element (all versions)
            b"DVImageDescriptor",          # alternate descriptor name
            b"DolbyVisionMetadata",        # CM v5.0 alternate
            b"ContentMappingData",         # some CM v4.0 implementations
            b"dolbyvision",                # lowercase variant in some tools
            b"DolbyVision",                # general ASCII marker
        ]
        for _scan_dir in _search_dirs:
            for _mxf in sorted(_scan_dir.rglob("*.mxf"))[:20]:
                try:
                    _header = _mxf.read_bytes()[:524288]  # 512 KB — covers large HTJ2K descriptors
                    if not any(_m in _header for _m in _DV_BINARY_MARKERS):
                        continue
                    # DV confirmed — try extraction in priority order:
                    # 1. Standard CM XML (DolbyLabsMDF / DolbyVisionMetadata)
                    # 2. DM v4.1 frame-interleaved (DolbyVisionFrameData — DaVinci Resolve)
                    try:
                        _xml_text = extract_embedded_dovi_xml_from_mxf(_mxf)
                        if _xml_text:
                            _embedded = _extract_dovi_from_xml_text(_xml_text, str(_mxf))
                            if _embedded.get("shots"):
                                _embedded["detectedBy"] = "cm_xml_embedded"
                                return self._ok(_embedded)
                    except Exception:
                        pass
                    # 2. Try DM v4.1 frame-interleaved extraction
                    try:
                        _fi_data = extract_frame_interleaved_dovi_from_mxf(_mxf)
                        if _fi_data and _fi_data.get("shots"):
                            _fi_data["detectedBy"] = "dm41_frame_interleaved"
                            return self._ok(_fi_data)
                    except Exception:
                        pass
                    # Nothing extractable — return confirmed-DV stub
                    return self._ok({
                        "shots": [],
                        "fromMxfHeader": True,
                        "xmlPath": str(_mxf),
                        "detectedBy": "binary_mxf_scan",
                    })
                except Exception:
                    continue

        # ── STEP 3: ffprobe — slowest, only for non-J2K streams ──────────────────
        # Cap to 1 MXF with a 5-second timeout so the total call stays well under
        # the 30-second JS timeout.  Probes for DV side-data and PQ transfer.
        try:
            from .proxy_service import _find_ffmpeg, _find_ffprobe
            _ffprobe = _find_ffprobe(_find_ffmpeg())
            if _ffprobe:
                _mxfs = [_m for _d in _search_dirs for _m in sorted(_d.rglob("*.mxf"))[:3]]
                for _mxf in _mxfs[:1]:  # probe at most 1 file
                    try:
                        _r = subprocess.run(
                            [_ffprobe, "-v", "error", "-show_streams",
                             "-show_entries", "stream=color_transfer,color_primaries:stream_side_data",
                             "-of", "json", str(_mxf)],
                            capture_output=True, text=True, timeout=5,
                        )
                        if _r.returncode == 0:
                            _pd = _json.loads((_r.stdout or "").strip() or "{}")
                            for _s in (_pd.get("streams") or []):
                                for _sd in (_s.get("side_data_list") or []):
                                    if "dolby" in str(_sd.get("side_data_type") or "").lower():
                                        return self._ok({"shots": [], "fromMxfHeader": True,
                                                         "xmlPath": str(_mxf), "detectedBy": "ffprobe_sidedata"})
                                _tc = str(_s.get("color_transfer") or "").lower()
                                if "smpte2084" in _tc:
                                    return self._ok({"shots": [], "fromMxfHeader": True,
                                                     "colorTransfer": _tc, "xmlPath": str(_mxf),
                                                     "detectedBy": "ffprobe_transfer"})
                    except Exception:
                        continue
        except Exception:
            pass

        return self._ok(data)  # no DV detected

    # ── Dolby Vision extractor helpers ────────────────────────────────────────

    _METAFIER_PATHS_MAC = [
        "/Applications/Dolby Vision Professional Tools/Metafier.app/Contents/MacOS/Metafier",
        "/Applications/Dolby Vision Professional Tools/Metafier.app/Contents/MacOS/metafier",
        "/Applications/DolbyVisionProfessionalTools/Metafier.app/Contents/MacOS/Metafier",
        "/usr/local/bin/metafier",
        "/opt/homebrew/bin/metafier",
    ]
    _METAFIER_PATHS_WIN = [
        r"C:\Program Files\Dolby\Dolby Vision Professional Tools\metafier.exe",
        r"C:\Program Files (x86)\Dolby\Dolby Vision Professional Tools\metafier.exe",
    ]

    def _find_metafier_exe(self, custom_path: str = "") -> str:
        """Return the path to Metafier executable, or empty string if not found."""
        import shutil
        candidates = []
        if custom_path:
            candidates.append(custom_path)
        env_path = str(os.environ.get("PFX_METAFIER_PATH") or "").strip()
        if env_path:
            candidates.append(env_path)
        if platform.system() == "Darwin":
            candidates.extend(self._METAFIER_PATHS_MAC)
        elif platform.system() == "Windows":
            candidates.extend(self._METAFIER_PATHS_WIN)
        for p in candidates:
            if p and Path(p).is_file():
                return p
        # Try PATH
        found = shutil.which("metafier") or shutil.which("Metafier")
        return found or ""

    def _detect_metafier(self, request: dict[str, Any]) -> dict[str, Any]:
        """Detect Dolby Metafier installation and return path + version."""
        custom = str(request.get("customPath") or "").strip()
        path = self._find_metafier_exe(custom)
        if not path:
            return self._ok({"found": False, "path": "", "version": "", "message": "Metafier not found in standard locations."})
        version = ""
        try:
            r = subprocess.run([path, "--version"], capture_output=True, timeout=8)
            raw = (r.stdout or b"").decode("utf-8", errors="replace").strip()
            if not raw:
                raw = (r.stderr or b"").decode("utf-8", errors="replace").strip()
            version = raw[:120]
        except Exception as e:
            version = f"(version check failed: {e})"
        return self._ok({"found": True, "path": path, "version": version, "message": ""})

    def _extract_dovi_from_mxf(self, request: dict[str, Any]) -> dict[str, Any]:
        """Run Metafier (or configured extractor) to extract DV CM XML from a Video MXF.

        The companion reads the MXF from disk — no MXF binary is sent through native messaging.
        """
        import tempfile, shlex
        package_root  = str(request.get("packageRootPath") or "").strip()
        mxf_relative  = str(request.get("mxfRelativePath") or "").strip()
        asset_id      = str(request.get("assetId") or "").strip()
        reel_id       = str(request.get("reelId") or "R?").strip()
        output_dir    = str(request.get("outputDir") or "").strip()
        metafier_path = str(request.get("metafierPath") or "").strip()
        cmd_template  = str(request.get("commandTemplate") or "").strip()
        timeout_s     = int(request.get("timeoutSeconds") or 120)

        if not package_root:
            return self._error("NO_REAL_PATH",
                "No IMF package root path provided. Use 'Relink IMF Root' to set the real filesystem path.",
                "")

        if not mxf_relative:
            return self._error("MXF_NOT_FOUND", "No MXF relative path specified.", "")

        # Resolve MXF absolute path
        mxf_path = Path(package_root).expanduser() / mxf_relative
        if not mxf_path.is_file():
            # Case-insensitive fallback search
            for candidate in Path(package_root).expanduser().rglob(Path(mxf_relative).name):
                if candidate.is_file():
                    mxf_path = candidate
                    break
            else:
                return self._error("MXF_NOT_FOUND", f"MXF not found: {mxf_relative}", "")

        # Resolve Metafier
        if not metafier_path:
            metafier_path = self._find_metafier_exe()
        if not metafier_path or not Path(metafier_path).is_file():
            return self._error("METAFIER_NOT_FOUND",
                "Dolby Metafier not found. Configure the extractor path in Settings > IMF / Dolby Vision.",
                "")

        # Output directory
        if not output_dir:
            output_dir = str(tempfile.mkdtemp(prefix="pfx_dovi_"))
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        safe_reel = "".join(c for c in reel_id if c.isalnum() or c in "-_") or "reel"
        output_xml = Path(output_dir) / f"dovi_{safe_reel}.xml"

        # Build command
        if cmd_template:
            cmd_str = (cmd_template
                       .replace("{metafier}", str(metafier_path))
                       .replace("{input}",    str(mxf_path))
                       .replace("{output}",   str(output_xml)))
            cmd: list[str] = shlex.split(cmd_str)
        else:
            # Default Metafier command form — most common across versions
            cmd = [str(metafier_path), "-e", str(output_xml), str(mxf_path)]

        # Log for debug
        try:
            with open(Path(output_dir) / "pfx_dovi_cmd.log", "w") as lf:
                lf.write(f"cmd: {' '.join(cmd)}\nmxf: {mxf_path}\nout: {output_xml}\n")
        except Exception:
            pass

        # Run extractor
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=timeout_s,
                                    cwd=str(mxf_path.parent))
        except subprocess.TimeoutExpired:
            return self._error("TIMEOUT", f"Metafier timed out after {timeout_s}s.", "")
        except FileNotFoundError as exc:
            return self._error("METAFIER_NOT_FOUND", str(exc), "")
        except Exception as exc:
            return self._error("EXTRACT_FAILED", str(exc), "")

        stdout = (result.stdout or b"").decode("utf-8", errors="replace")
        stderr = (result.stderr or b"").decode("utf-8", errors="replace")
        exit_code = result.returncode

        # Locate output XML (Metafier may use different naming)
        if not output_xml.is_file():
            found_xmls = sorted(Path(output_dir).glob("*.xml"), key=lambda p: p.stat().st_mtime, reverse=True)
            if found_xmls:
                output_xml = found_xmls[0]
            else:
                stderr_lower = stderr.lower()
                if any(k in stderr_lower for k in ("no dolby", "not found", "no metadata", "no dv")):
                    return self._error("NO_DOVI_METADATA",
                        "No Dolby Vision metadata found in this MXF.", stderr[:2000])
                if exit_code != 0:
                    return self._error("EXTRACT_FAILED",
                        f"Metafier exited {exit_code} — no XML output produced.", stderr[:2000])
                return self._error("NO_DOVI_METADATA",
                    "No XML output from extractor.", stderr[:2000])

        xml_text = output_xml.read_text(encoding="utf-8", errors="replace")
        xml_size = len(xml_text)
        _MAX_INLINE = 512 * 1024  # 512 KB inline limit

        return self._ok({
            "sourceType":    "embedded_video_mxf",
            "extractor":     "metafier",
            "assetId":       asset_id,
            "reelId":        reel_id,
            "mxfPath":       str(mxf_path),
            "outputXmlPath": str(output_xml),
            "xmlText":       xml_text if xml_size <= _MAX_INLINE else xml_text[:_MAX_INLINE],
            "xmlTruncated":  xml_size > _MAX_INLINE,
            "xmlSizeBytes":  xml_size,
            "stdout":        stdout[:2000],
            "stderr":        stderr[:2000],
            "exitCode":      exit_code,
            "warnings":      (["XML truncated — read full content from outputXmlPath"] if xml_size > _MAX_INLINE else []),
        })

    def _read_extracted_xml(self, request: dict[str, Any]) -> dict[str, Any]:
        """Read a large extracted Dolby Vision XML file from disk in chunks.

        Used when extractDoviFromMxf returns xmlTruncated=True.
        Returns the full XML text (up to 8 MB — real CM XMLs are well under this).
        """
        xml_path = str(request.get("xmlPath") or "").strip()
        if not xml_path:
            return self._error("BAD_REQUEST", "No xmlPath provided.", "")
        p = Path(xml_path).expanduser()
        if not p.is_file():
            return self._error("NOT_FOUND", f"XML file not found: {xml_path}", "")
        try:
            size = p.stat().st_size
            if size > 8 * 1024 * 1024:  # 8 MB safety cap
                return self._error("FILE_TOO_LARGE", f"XML file is {size // 1024} KB — exceeds 8 MB safety limit.", "")
            text = p.read_text(encoding="utf-8", errors="replace")
            return self._ok({"xmlText": text, "xmlPath": xml_path, "xmlSizeBytes": size})
        except Exception as exc:
            return self._error("READ_FAILED", str(exc), "")

    def _get_imf_real_path(self, request: dict[str, Any]) -> dict[str, Any]:
        """Resolve a relative IMF asset path to its absolute filesystem path."""
        package_root = str(request.get("packageRootPath") or "").strip()
        relative     = str(request.get("relativePath") or "").strip()
        if not package_root:
            return self._error("NO_REAL_PATH", "No packageRootPath provided.", "")
        if not relative:
            return self._error("BAD_REQUEST", "No relativePath provided.", "")
        abs_path = Path(package_root).expanduser() / relative
        exists = abs_path.is_file()
        return self._ok({"absolutePath": str(abs_path), "exists": exists})

    # ── Native media actions ──────────────────────────────────────────────────

    # Codecs Chrome can decode natively in an HTML5 <video> element.
    # ProRes, DNxHD, XDCAM, MPEG-2, etc. are intentionally excluded — these
    # always go through the companion's H.264 proxy pipeline (buildMediaProxy)
    # which transcodes them to a browser-compatible format and caches the result.
    _BROWSER_DECODABLE = frozenset({
        'h264', 'avc', 'avc1', 'hevc', 'h265', 'vp8', 'vp9', 'av1', 'mp4v',
        'theora', 'mpeg4',
    })

    def _open_file(self, request: dict[str, Any]) -> dict[str, Any]:
        path_str = str(request.get("path") or "").strip()
        if not path_str:
            return self._error("BAD_REQUEST", "path is required", "No file path was provided.")
        path = Path(path_str).expanduser().resolve()
        if not path.is_file():
            return self._error(
                "ASSET_NOT_FOUND",
                f"File not found: {path}",
                "The media file was not found on disk.",
            )
        ffmpeg_path = _find_ffmpeg()
        ffprobe_path = _find_ffprobe(ffmpeg_path) if ffmpeg_path else None
        probe = _probe_asset(path, ffprobe_path)
        display_name = path.name
        can_play = probe.get('codec', '').lower() in self._BROWSER_DECODABLE
        asset_id = uuid.uuid4().hex[:16]
        self._asset_registry[asset_id] = {
            "assetId": asset_id,
            "path": str(path),
            "displayName": display_name,
            "name": path.stem,
            "ext": path.suffix.lower(),
            "canPlay": can_play,
            **probe,
        }
        # LRU eviction: remove the oldest entry when the cap is exceeded so the
        # registry doesn't grow unbounded across long companion sessions.
        while len(self._asset_registry) > self._ASSET_REGISTRY_MAX:
            evicted_id, _ = self._asset_registry.popitem(last=False)
            deregister_asset_file(evicted_id)
        # Register path in the HTTP server's file registry so /file/{assetId} can stream it
        register_asset_file(asset_id, str(path))
        return self._ok({
            "assetId": asset_id,
            "displayName": display_name,
            "name": path.stem,
            "path": str(path),
            "ext": path.suffix.lower(),
            "canPlay": can_play,
            "streamUrl": f"http://127.0.0.1:{self.http_port}/file/{asset_id}" if self.http_port else "",
            **probe,
        })

    def _build_media_proxy(self, request: dict[str, Any]) -> dict[str, Any]:
        """Start an async H.264 proxy build for a previously opened media file.

        Returns immediately with a sessionId.  The caller polls
        GET /progress/{sessionId} (HTTP server) to track progress and then
        plays the proxy via GET /stream/{sessionId}.
        """
        asset_id = str(request.get("assetId") or "").strip()
        if not asset_id:
            return self._error("BAD_REQUEST", "assetId is required", "No asset ID was provided.")
        asset = self._asset_registry.get(asset_id)
        if not asset:
            return self._error(
                "ASSET_NOT_FOUND",
                f"Unknown assetId: {asset_id}",
                "Asset not loaded — call openFile first.",
            )
        media_path = str(asset.get("path") or "")
        if not media_path or not Path(media_path).is_file():
            return self._error("ASSET_NOT_FOUND", "Media file not found on disk.",
                               "The source media file cannot be found.")
        ffmpeg_path = _find_ffmpeg()
        if not ffmpeg_path:
            return self._error("THUMBNAIL_GENERATION_FAILED", "ffmpeg not found",
                               "ffmpeg must be installed to build a preview proxy.")
        session_id = uuid.uuid4().hex[:16]
        create_session(session_id, {
            "kind": "preview",
            "done": False,
            "pct": 0,
            "stage": "queued",
            "message": "Queued…",
            "path": "",
            "error": None,
        })
        force = bool(request.get("force") or False)
        threading.Thread(
            target=build_preview_proxy,
            args=(session_id, media_path, ffmpeg_path),
            kwargs={"force_ffmpeg": force},
            daemon=True,
        ).start()
        return self._ok({
            "sessionId": session_id,
            "progressUrl": f"http://127.0.0.1:{self.http_port}/progress/{session_id}" if self.http_port else "",
            "streamUrl": f"http://127.0.0.1:{self.http_port}/stream/{session_id}" if self.http_port else "",
        })

    def _get_timecode_info(self, request: dict[str, Any]) -> dict[str, Any]:
        asset_id = str(request.get("assetId") or "").strip()
        if not asset_id:
            return self._error("BAD_REQUEST", "assetId is required", "No asset ID was provided.")
        asset = self._asset_registry.get(asset_id)
        if not asset:
            return self._error(
                "ASSET_NOT_FOUND",
                f"Unknown assetId: {asset_id}",
                "Asset not loaded — call openFile first.",
            )
        return self._ok({
            "assetId": asset_id,
            "startTimecode": asset.get("startTimecode") or "",
            "timecodeSource": asset.get("timecodeSource") or "unknown",
            "timecodeBase": int(asset.get("timecodeBase") or 24),
            "dropFrame": bool(asset.get("dropFrame")),
            "durationTimecode": asset.get("durationTimecode") or "",
            "hasTimecodeTrack": bool(asset.get("hasTimecodeTrack")),
            "fps": asset.get("fps") or 24.0,
            "frameCount": asset.get("frameCount") or 0,
            "durationSec": asset.get("durationSec") or 0.0,
            "width": asset.get("width") or 0,
            "height": asset.get("height") or 0,
            "codec": asset.get("codec") or "",
            "colorSpace": asset.get("colorSpace") or "",
            "colorTransfer": asset.get("colorTransfer") or "",
        })

    def _grab_thumbnail_at_timecode(self, request: dict[str, Any]) -> dict[str, Any]:
        asset_id = str(request.get("assetId") or "").strip()
        timecode = str(request.get("timecode") or "").strip()
        width = max(1, int(request.get("width") or 320))
        height = max(1, int(request.get("height") or 180))
        fmt = str(request.get("format") or "jpg").lower()
        if fmt not in ("jpg", "png"):
            fmt = "jpg"
        mode = str(request.get("mode") or "fast").lower()
        include_data_url = request.get("includeDataUrl", True)
        if isinstance(include_data_url, str):
            include_data_url = include_data_url.strip().lower() not in ("0", "false", "no", "off")
        else:
            include_data_url = bool(include_data_url)

        if not asset_id:
            return self._error("BAD_REQUEST", "assetId is required", "No asset ID was provided.")
        if not timecode:
            return self._error("BAD_REQUEST", "timecode is required", "No timecode was provided.")

        asset = self._asset_registry.get(asset_id)
        if not asset:
            return self._error(
                "ASSET_NOT_FOUND",
                f"Unknown assetId: {asset_id}",
                "Asset not loaded — call openFile first.",
            )
        media_path = str(asset.get("path") or "")
        if not media_path or not Path(media_path).is_file():
            return self._error(
                "ASSET_NOT_FOUND",
                "Media file no longer available",
                "The source media file cannot be found on disk.",
            )

        ffmpeg_path = _find_ffmpeg()
        if not ffmpeg_path:
            return self._error(
                "THUMBNAIL_GENERATION_FAILED",
                "ffmpeg not found",
                "ffmpeg must be installed to generate thumbnails.",
            )

        fps = float(asset.get("fps") or 24.0)
        duration_sec = float(asset.get("durationSec") or 0.0)
        start_tc = str(asset.get("startTimecode") or "").strip()
        drop_frame = bool(asset.get("dropFrame"))
        seek_mode = str(request.get("seekMode") or "source_tc").lower()

        if seek_mode == "sequence_fallback":
            # The caller has no real source-clip TC (EDL had no srcIn).
            # The timecode is a sequence position that cannot be mapped to a
            # source frame without additional context.  Seek to frame 0 so the
            # user at least sees the first frame of the clip.
            seek_sec = 0.0
        else:
            # Default: 'source_tc' — convert the requested timecode to a
            # file-relative seek position.  The caller passes a source-clip TC
            # (e.g. "01:00:35:00") while ffmpeg seeks by PTS which starts at 0.
            # Subtract the file's embedded start timecode so the seek lands on
            # the correct frame.
            seek_abs = _timecode_to_seconds(timecode, fps)
            if start_tc:
                start_sec = _timecode_to_seconds(start_tc, fps)
                seek_sec = max(0.0, seek_abs - start_sec)
            else:
                seek_sec = max(0.0, seek_abs)
            # Clamp to file duration to prevent ffmpeg seeking past EOF when the
            # source TC is larger than the file length (e.g. no embedded TC and a
            # long sequence TC was passed).
            if duration_sec > 0 and seek_sec >= duration_sec:
                seek_sec = max(0.0, duration_sec - 1.0 / max(1.0, fps))

        frame_index = int(round(seek_sec * fps))

        # --- cache key: asset path + mtime + all grab parameters ---------------
        try:
            mtime = str(Path(media_path).stat().st_mtime)
        except Exception:
            mtime = "0"
        cache_key = hashlib.sha256(
            f"thumb_seek_v2:{media_path}:{mtime}:{timecode}:{width}:{height}:{fmt}:{mode}:{seek_mode}".encode()
        ).hexdigest()
        cache_dir = _thumb_cache_dir()
        cache_filename = f"{cache_key}.{fmt}"
        cache_path = cache_dir / cache_filename
        thumb_url = f"http://127.0.0.1:{self.http_port}/thumb/{cache_filename}" if self.http_port else ""

        mime_type = "image/jpeg" if fmt == "jpg" else "image/png"

        def _file_to_data_url(path: Path) -> str:
            if not include_data_url:
                return ""
            try:
                with open(str(path), "rb") as _f:
                    return f"data:{mime_type};base64,{base64.b64encode(_f.read()).decode()}"
            except Exception:
                return ""

        # --- cache hit -----------------------------------------------------------
        if cache_path.is_file() and cache_path.stat().st_size > 0:
            return self._ok({
                "timecode": timecode,
                "frameIndex": frame_index,
                "path": str(cache_path),
                "url": thumb_url,
                "dataUrl": _file_to_data_url(cache_path),
                "width": width,
                "height": height,
                "format": fmt,
                "cacheHit": True,
            })

        # --- generate thumbnail via ffmpeg ---------------------------------------
        # scale + letterbox/pillarbox to exact dimensions
        vf = (
            f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"
        )
        img_format = "mjpeg" if fmt == "jpg" else "png"

        # Write to a temp file first, then atomic-rename to cache path so a
        # partial write never leaves a corrupt cache entry.
        tmp_fd, tmp_path = None, None
        try:
            import tempfile as _tempfile
            tmp_fd, tmp_path = _tempfile.mkstemp(suffix=f".{fmt}", dir=str(cache_dir))
            os.close(tmp_fd)
            tmp_fd = None

            if mode == "fast":
                # pre-seek: ffmpeg jumps to the nearest keyframe before the point
                cmd = [
                    ffmpeg_path, "-y",
                    "-ss", f"{seek_sec:.6f}",
                    "-i", media_path,
                    "-vframes", "1",
                    "-vf", vf,
                    "-f", img_format,
                    tmp_path,
                ]
            else:
                # exact mode: decode from stream start to the requested position
                cmd = [
                    ffmpeg_path, "-y",
                    "-i", media_path,
                    "-ss", f"{seek_sec:.6f}",
                    "-vframes", "1",
                    "-vf", vf,
                    "-f", img_format,
                    tmp_path,
                ]

            result = subprocess.run(cmd, capture_output=True, timeout=60)
            if result.returncode != 0 or not Path(tmp_path).is_file() or Path(tmp_path).stat().st_size == 0:
                stderr_tail = (result.stderr or b"")[-256:].decode("utf-8", errors="replace").strip()
                resolve_ok, resolve_err = _resolve_export_still(
                    media_path,
                    tmp_path,
                    timecode,
                    source_start_tc=start_tc,
                    fps=fps,
                    drop_frame=drop_frame,
                )
                if not resolve_ok or not Path(tmp_path).is_file() or Path(tmp_path).stat().st_size == 0:
                    detail = resolve_err or f"ffmpeg exited {result.returncode}: {stderr_tail}"
                    return self._error(
                        "THUMBNAIL_GENERATION_FAILED",
                        detail,
                        "Could not extract a thumbnail frame from the media file.",
                    )

            # Atomic rename into cache
            os.replace(tmp_path, str(cache_path))
            tmp_path = None  # consumed — don't delete in finally

            return self._ok({
                "timecode": timecode,
                "frameIndex": frame_index,
                "path": str(cache_path),
                "url": thumb_url,
                "dataUrl": _file_to_data_url(cache_path),
                "width": width,
                "height": height,
                "format": fmt,
                "cacheHit": False,
            })

        except subprocess.TimeoutExpired:
            return self._error(
                "THUMBNAIL_GENERATION_FAILED",
                "ffmpeg timed out after 60 s",
                "Thumbnail generation timed out. The file may be too large or corrupted.",
            )
        except Exception as exc:
            return self._error(
                "THUMBNAIL_GENERATION_FAILED",
                f"Unexpected error: {exc}",
                "An unexpected error occurred during thumbnail generation.",
            )
        finally:
            if tmp_fd is not None:
                try:
                    os.close(tmp_fd)
                except Exception:
                    pass
            if tmp_path is not None:
                try:
                    Path(tmp_path).unlink(missing_ok=True)
                except Exception:
                    pass

    def _get_gpu_usage(self, _: dict[str, Any]) -> dict[str, Any]:
        """Return GPU device utilization % via ioreg (Apple Silicon / macOS only)."""
        import subprocess, re, sys
        if sys.platform != "darwin":
            return self._ok({"gpuPct": None, "platform": sys.platform})
        try:
            ioreg_cmd = "/usr/sbin/ioreg" if Path("/usr/sbin/ioreg").exists() else "ioreg"
            out = subprocess.check_output(
                [ioreg_cmd, "-c", "IOAccelerator"],
                timeout=2, stderr=subprocess.DEVNULL
            ).decode(errors="replace")
            m = re.search(r'"Device Utilization %"\s*=\s*(\d+)', out)
            if not m:
                m = re.search(r'"Renderer Utilization %"\s*=\s*(\d+)', out)
            pct = int(m.group(1)) if m else None
            return self._ok({"gpuPct": pct})
        except Exception as e:
            return self._ok({"gpuPct": None, "error": str(e)})

    # ── Shared media runtime ──────────────────────────────────────────────────

    def _get_media_runtime(self) -> MediaRuntime:
        """Lazy-initialize the shared media runtime on first use."""
        if self._media_runtime is None:
            ffmpeg_path  = _find_ffmpeg()
            ffprobe_path = _find_ffprobe(ffmpeg_path) if ffmpeg_path else None
            self._media_runtime = MediaRuntime(
                ffmpeg_path=ffmpeg_path,
                ffprobe_path=ffprobe_path,
                companion_version=self.config.companion_version,
                http_port=self.http_port,
                register_asset_fn=register_asset_file,
            )
        return self._media_runtime

    def _media_open_file(self, request: dict[str, Any]) -> dict[str, Any]:
        path    = str(request.get("path") or "").strip()
        options = {k: v for k, v in request.items() if k != "action"}
        result  = self._get_media_runtime().open_file(path, options)
        if not result.get("ok"):
            err = result.get("error", {})
            return self._error(err.get("code", "FILE_OPEN_FAILED"),
                               err.get("message", "open_file failed"),
                               "Could not open media file.")
        return self._ok(result)

    def _media_close_file(self, request: dict[str, Any]) -> dict[str, Any]:
        session_id = str(request.get("sessionId") or request.get("assetId") or "").strip()
        result = self._get_media_runtime().close_file(session_id)
        return self._ok(result)

    def _media_get_metadata(self, request: dict[str, Any]) -> dict[str, Any]:
        session_id = str(request.get("sessionId") or request.get("assetId") or "").strip()
        if not session_id:
            return self._error("BAD_REQUEST", "sessionId required", "No session ID provided.")
        result = self._get_media_runtime().get_metadata(session_id)
        if not result.get("ok"):
            err = result.get("error", {})
            return self._error(err.get("code", "DECODE_FAILED"),
                               err.get("message", "get_metadata failed"),
                               "Could not read media metadata.")
        return self._ok(result)

    def _media_get_frame(self, request: dict[str, Any]) -> dict[str, Any]:
        session_id  = str(request.get("sessionId") or request.get("assetId") or "").strip()
        frame_index = int(float(request.get("frameIndex") or 0))
        options     = {k: v for k, v in request.items() if k not in ("action", "sessionId", "assetId", "frameIndex")}
        if not session_id:
            return self._error("BAD_REQUEST", "sessionId required", "No session ID provided.")
        result = self._get_media_runtime().get_frame(session_id, frame_index, options)
        if not result.get("ok"):
            err = result.get("error", {})
            return self._error(err.get("code", "DECODE_FAILED"),
                               err.get("message", "get_frame failed"),
                               "Could not decode preview frame.")
        return self._ok(result)

    def _media_seek_frame(self, request: dict[str, Any]) -> dict[str, Any]:
        session_id  = str(request.get("sessionId") or request.get("assetId") or "").strip()
        frame_index = int(float(request.get("frameIndex") or 0))
        if not session_id:
            return self._error("BAD_REQUEST", "sessionId required", "No session ID provided.")
        result = self._get_media_runtime().seek_frame(session_id, frame_index)
        return self._ok(result)

    def _media_play(self, request: dict[str, Any]) -> dict[str, Any]:
        return self._ok({"playing": False, "note": "Full playback deferred to Phase 7"})

    def _media_pause(self, request: dict[str, Any]) -> dict[str, Any]:
        return self._ok({"paused": True})

    def _media_get_backend_status(self, _: dict[str, Any]) -> dict[str, Any]:
        result = self._get_media_runtime().get_backend_status()
        return self._ok(result)

    def _media_list_sessions(self, _: dict[str, Any]) -> dict[str, Any]:
        result = self._get_media_runtime().list_sessions()
        return self._ok(result)

    def _media_prefetch(self, request: dict[str, Any]) -> dict[str, Any]:
        session_id    = str(request.get("sessionId") or request.get("assetId") or "").strip()
        current_frame = int(float(request.get("currentFrame") or 0))
        count         = int(request.get("count") or 6)
        direction     = int(request.get("direction") or 1)
        options       = {k: v for k, v in request.items()
                         if k not in ("action", "sessionId", "assetId",
                                      "currentFrame", "count", "direction")}
        if not session_id:
            return self._error("BAD_REQUEST", "sessionId required", "No session ID provided.")
        result = self._get_media_runtime().prefetch_frames(
            session_id, current_frame, options, count=count, direction=direction)
        if not result.get("ok"):
            err = result.get("error", {})
            return self._error(err.get("code", "PREFETCH_FAILED"),
                               err.get("message", "prefetch failed"),
                               "Could not start frame prefetch.")
        return self._ok(result)

    def _media_cache_stats(self, _: dict[str, Any]) -> dict[str, Any]:
        result = self._get_media_runtime().cache_stats()
        return self._ok(result)

    def _media_clear_cache(self, request: dict[str, Any]) -> dict[str, Any]:
        session_id = str(request.get("sessionId") or "").strip() or None
        result = self._get_media_runtime().clear_cache(session_id)
        return self._ok(result)

    def _not_implemented(self, request: dict[str, Any]) -> dict[str, Any]:
        action = str(request.get("action") or "unknown")
        return self._error(
            "ENGINE_UNSUPPORTED",
            f"{action} is not implemented in the scaffold",
            "This companion feature is not implemented yet.",
        )

    # ── OCF → EXR Pull handlers ───────────────────────────────────────────────

    def _set_proxy_root(self, request: dict[str, Any]) -> dict[str, Any]:
        """Set the media-root proxy directory.  All proxy, temp, and frame cache
        files are written under {mediaRoot}/proxy/ so everything travels with the
        project media and is easy to locate or delete."""
        from .proxy_registry import set_proxy_root, get_frame_cache_root
        media_root = str(request.get("mediaRoot") or "").strip()
        resolved = set_proxy_root(media_root or None)
        if media_root and resolved is None:
            return self._error("INVALID_PATH",
                               f"Cannot write to {media_root}/proxy/",
                               "Proxy root directory is not writable.")
        # Update media runtime frame caches so backend decoders also use the new root
        if self._media_runtime is not None:
            try:
                self._media_runtime.update_frame_cache_root(get_frame_cache_root())
            except Exception:
                pass
        return self._ok({"proxyRoot": str(resolved) if resolved else None})

    def _get_proxy_root(self, _: dict[str, Any]) -> dict[str, Any]:
        """Return the currently active proxy root directory."""
        from .proxy_registry import get_proxy_root
        root = get_proxy_root()
        return self._ok({"proxyRoot": str(root) if root else None})

    def _ocf_pick_folder(self, request: dict[str, Any]) -> dict[str, Any]:
        """Show native folder picker and return selected path.

        Uses pick_folder() from folder_picker.py which uses osascript on macOS
        (no Tk window-server registration, works correctly from background threads).
        """
        from .folder_picker import pick_folder
        try:
            path = pick_folder("Select OCF Root Folder")
            return self._ok({"path": path or None})
        except Exception as exc:
            return self._error("FOLDER_PICKER_FAILED", str(exc), "Could not open folder picker.")

    def _ocf_probe_folder(self, request: dict[str, Any]) -> dict[str, Any]:
        """Walk a folder and probe all camera files."""
        import os
        folder_path = str(request.get("folderPath") or "").strip()
        if not folder_path or not os.path.isdir(folder_path):
            return self._error("INVALID_PATH", f"Not a directory: {folder_path}", "OCF folder path is invalid.")

        # Resolve ffprobe once for the whole scan — bare "ffprobe" silently fails
        # on systems where it's only at /opt/homebrew/bin or /usr/local/bin.
        ffmpeg_path = _find_ffmpeg()
        ffprobe_path = _find_ffprobe(ffmpeg_path)

        CAMERA_EXTS = {".r3d", ".ari", ".arx", ".braw", ".mxf", ".mov", ".dng", ".dpx", ".exr", ".tiff", ".tif"}
        ocf_files = []
        for root, dirs, files in os.walk(folder_path):
            # Skip hidden/system dirs
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for name in files:
                if name.startswith("."): continue
                ext = os.path.splitext(name)[1].lower()
                if ext not in CAMERA_EXTS: continue
                full_path = os.path.join(root, name)
                info = self._probe_ocf_file(full_path, name, ext, ffprobe_path)
                ocf_files.append(info)
        return self._ok(ocf_files)

    def _probe_ocf_file(self, path: str, name: str, ext: str, ffprobe_path: str | None = None) -> dict:
        """Extract rich metadata from a camera original file via ffprobe."""
        import subprocess, json as _json, os, re
        stem = os.path.splitext(name)[0]
        base = {"name": name, "path": path, "reel": stem, "camera": ext[1:].upper()}

        # ── Structured camera name parse (independent of ffprobe) ──────────────
        # Handles ARRI (A001C002/A001L002), RED (A001_C003), Sony, generic patterns.
        cam_m = re.match(r'^([A-Za-z])(\d{3,4})([A-Za-z])(\d{3,})', stem)
        if cam_m:
            base["cameraLetter"] = cam_m.group(1).upper()
            base["rollNum"]      = cam_m.group(2)
            base["clipLetter"]   = cam_m.group(3).upper()
            base["clipNum"]      = cam_m.group(4)
            base["rollId"]       = cam_m.group(1).upper() + cam_m.group(2)  # e.g. "A001"
            # Extract date suffix if present (YYMMDD or YYYYMMDD after first underscore)
            date_m = re.search(r'_(\d{6,8})', stem)
            if date_m:
                base["recordDate"] = date_m.group(1)[:6]  # normalise to YYMMDD
        else:
            # RED style: A001_C003 or A001_0001_C003
            red_m = re.match(r'^([A-Za-z])(\d{3,4})_(?:\d{4}_)?C(\d{3,})', stem)
            if red_m:
                base["cameraLetter"] = red_m.group(1).upper()
                base["rollNum"]      = red_m.group(2)
                base["clipLetter"]   = "C"
                base["clipNum"]      = red_m.group(3)
                base["rollId"]       = red_m.group(1).upper() + red_m.group(2)

        # Caller resolves the path; fall back to discovery if called standalone.
        _ffprobe = ffprobe_path or _find_ffprobe(_find_ffmpeg())
        if not _ffprobe:
            return {**base, "_warning": "ffprobe not found — install ffmpeg for OCF metadata"}

        try:
            result = subprocess.run(
                [_ffprobe, "-v", "quiet", "-print_format", "json",
                 "-show_streams", "-show_format", "-show_entries",
                 "stream_side_data", path],
                capture_output=True, text=True, timeout=30
            )
            if result.returncode != 0:
                return base
            probe  = _json.loads(result.stdout)
            stream = next((s for s in probe.get("streams", []) if s.get("codec_type") == "video"), {})
            fmt    = probe.get("format", {})
            # Merge all tag sources: format tags win over stream tags for reel/TC
            all_tags = {**stream.get("tags", {}), **fmt.get("tags", {})}

            # ── Reel name (try in priority order) ──────────────────────────────
            reel = (all_tags.get("reel_name")
                    or all_tags.get("Reel") or all_tags.get("REEL")
                    or all_tags.get("clip_name") or all_tags.get("ClipName")
                    or stem)
            # If MXF reel_name is just the roll+clip without date, keep filename stem
            # as well (the matcher prefers the longer/more-specific version)
            if reel and reel != stem and len(reel) < len(stem):
                base["reelShort"] = reel   # e.g. "A001L002" — useful for matching
            reel = reel or stem

            # ── FPS ────────────────────────────────────────────────────────────
            rfr = stream.get("r_frame_rate", "24/1").split("/")
            fps = round(int(rfr[0]) / max(1, int(rfr[1])), 3) if len(rfr) == 2 else 24

            # ── Timecode — try many tag keys (brand-specific) ──────────────────
            TC_KEYS = [
                "timecode", "time_code", "TIMECODE", "TIME_CODE",
                # ARRI
                "com.arri.camera.timecode", "ARRI:timecode",
                # RED
                "start_timecode", "start_tc",
                # Sony
                "LTC_TC", "LtcTc",
                # Blackmagic
                "braw_timecode",
                # Generic MXF
                "material_package_uid_timecode",
            ]
            tc_in = ""
            for k in TC_KEYS:
                v = all_tags.get(k, "")
                if v and ":" in str(v) and len(str(v)) >= 7:
                    tc_in = str(v).strip()
                    break
            tc_known = bool(tc_in) and tc_in != "00:00:00:00"
            if not tc_in:
                tc_in = "00:00:00:00"

            # ── Frame count ────────────────────────────────────────────────────
            nb_frames = int(stream.get("nb_frames") or 0)
            if not nb_frames:
                dur = float(fmt.get("duration") or 0)
                nb_frames = round(dur * fps) if dur > 0 else 0
            # Fallback via avg_frame_rate × duration
            if not nb_frames:
                try:
                    afr = stream.get("avg_frame_rate", "0/1").split("/")
                    afr_v = float(afr[0]) / max(1, float(afr[1]))
                    dur = float(stream.get("duration") or 0)
                    if afr_v > 0 and dur > 0:
                        nb_frames = round(afr_v * dur)
                except Exception:
                    pass

            # ── TC out ─────────────────────────────────────────────────────────
            tc_out = ""
            if tc_known and nb_frames:
                try:
                    def _tc2f(tc, f):
                        p = tc.replace(";", ":").split(":")
                        return sum(int(x)*m for x,m in zip(p,[f*3600,f*60,f,1]))
                    def _f2tc(n, f):
                        f = max(1, int(f))
                        return "{:02d}:{:02d}:{:02d}:{:02d}".format(
                            n//(f*3600), (n%(f*3600))//(f*60), (n//f)%60, n%f)
                    tc_out = _f2tc(_tc2f(tc_in, int(fps)) + nb_frames, int(fps))
                except Exception:
                    pass

            # ── Camera model from format/stream tags ───────────────────────────
            camera_model = (all_tags.get("encoder")
                            or all_tags.get("camera_model") or all_tags.get("CameraModel")
                            or all_tags.get("make") or "")
            # Normalize: "ARRI ALEXA Mini LF" → "ARRI"
            brand = ""
            for b in ("ARRI", "RED", "Sony", "Blackmagic", "Canon", "Nikon", "GoPro", "DJI"):
                if b.lower() in camera_model.lower():
                    brand = b; break

            # ── UMID (MXF Unique Material Identifier) ──────────────────────────
            umid = (all_tags.get("UMID") or all_tags.get("umid")
                    or all_tags.get("unique_material_id") or "")

            return {
                **base,
                "reel":        reel,
                "tcIn":        tc_in,
                "tcOut":       tc_out or "00:00:00:00",
                "tcKnown":     tc_known,        # False = ffprobe couldn't read TC
                "fps":         fps,
                "frameCount":  nb_frames,
                "resolution":  f"{stream.get('width',0)}x{stream.get('height',0)}",
                "format":      stream.get("codec_name", ext[1:]).upper(),
                "cameraModel": camera_model,
                "cameraBrand": brand,
                "umid":        umid,
            }
        except Exception as exc:
            return {**base, "_warning": str(exc)}

    def _ocf_probe_file(self, request: dict[str, Any]) -> dict[str, Any]:
        """Probe a single OCF file and return its metadata (TC, fps, reel, camera).

        Used by VFX Pull manual relink to score a user-picked file against an event.
        Request:  { filePath: "/abs/path/to/file.mxf" }
        Response: { path, name, ext, fps, durationFrames, startTimecode, reel,
                    cameraModel, colorSpace, resolution }
        """
        import os
        file_path = str(request.get("filePath") or request.get("path") or "").strip()
        if not file_path or not os.path.isfile(file_path):
            return self._error("INVALID_PATH", f"Not a file: {file_path}",
                               "OCF file path is invalid.")
        try:
            ffmpeg_path  = _find_ffmpeg()
            ffprobe_path = _find_ffprobe(ffmpeg_path)
            name = os.path.basename(file_path)
            ext  = os.path.splitext(name)[1].lower().lstrip(".")
            info = _probe_asset(file_path, ffprobe_path)
            fps_val = info.get("fps") or info.get("frameRate") or 24.0
            try:
                fps_val = float(fps_val)
            except Exception:
                fps_val = 24.0
            result = {
                "path":           file_path,
                "name":           name,
                "ext":            ext,
                "fps":            fps_val,
                "durationFrames": int(info.get("durationFrames") or info.get("frames") or 0),
                "startTimecode":  str(info.get("startTimecode") or info.get("timecode") or ""),
                "reel":           str(info.get("reel") or info.get("reelName") or ""),
                "cameraModel":    str(info.get("cameraModel") or info.get("camera") or ""),
                "colorSpace":     str(info.get("colorSpace") or ""),
                "resolution":     str(info.get("resolution") or ""),
            }
            return self._ok(result)
        except Exception as exc:
            return self._error("PROBE_ERROR", str(exc), "Failed to probe OCF file.")

    def _ocf_exr_export_start(self, request: dict[str, Any]) -> dict[str, Any]:
        """Start async EXR export. Returns jobId immediately."""
        job = request.get("job")
        if not job: return self._error("MISSING_JOB", "job field required", "No job payload provided.")
        job_id = str(uuid.uuid4())[:8]
        self._ocf_jobs[job_id] = {"state": "running", "progressPct": 0, "result": None, "error": None}
        thread = threading.Thread(target=self._ocf_run_export, args=(job_id, job), daemon=True)
        thread.start()
        return self._ok({"jobId": job_id})

    def _ocf_run_export(self, job_id: str, job: dict) -> None:
        """Background EXR export thread.

        Honours the spec's retime + reframe blocks on the job:
          • job.retime      → speed bake (setpts) / reverse / dynamic-ramp guard
          • job.reframe     → active-area crop + UHD scale + pad
          • job.colorPlan   → ACES IDT 3D LUT (lut3d) for known camera log formats
        See _build_vf_chain() for the spatial filter logic.
        See color_lut.py for the IDT transforms (ARRI LogC3/4, RED Log3G10,
        Sony S-Log3, Canon C-Log2, Panasonic V-Log).

        Limitations:
          • Dynamic speed ramps (job.retime.isDynamic) fail with a clean
            RETIME_DYNAMIC_UNSUPPORTED message; the JS side already gates
            those via the DYNAMIC_RETIME_UNSUPPORTED QC block.
        """
        import os, subprocess, shutil, tempfile
        from .proxy_service import (
            _find_ffmpeg, _find_ffprobe, _find_avconvert,
            _find_art_cmd, _find_arc_cmd, _find_redline,
            _avconvert_transcode_to_h264, _arriraw_transcode_to_h264,
        )
        state = self._ocf_jobs.get(job_id, {})
        _temp_intermediate: str = ""
        try:
            source     = job.get("sourcePath", "")
            output_dir = job.get("outputDir", "")
            pattern    = _safe_output_pattern(job.get("outputPattern", "%04d.exr"))
            export_in  = job.get("exportIn", "00:00:00:00")
            export_out = job.get("exportOut", "00:00:00:00")
            fps        = float(job.get("fps", 24))
            frame_start= int(job.get("frameStart", 1001))
            # Use the rendered count (post-speed-bake) when present — falls
            # back to the source-range count for back-compat with older jobs.
            exp_frames = int(job.get("expectedRenderedFrameCount",
                                     job.get("frameCount",
                                             job.get("expectedFrameCount", 1))))
            bit_depth  = str(job.get("exr", {}).get("bitDepth", "half") or "half").lower()
            # FFmpeg's EXR ENCODER only accepts 32-bit-float planar input
            # (gbrpf32le / gbrapf32le / grayf32le) — `gbrpf16le` is an INPUT-only
            # (decode) format and some ffmpeg builds reject it outright
            # ("Unknown pixel format requested: gbrpf16le"). Half vs float EXR is
            # selected by the encoder's own `-format half|float` option, NOT by the
            # input pix_fmt. So always feed gbrpf32le and pick depth via exr_format.
            pix_fmt    = "gbrpf32le"
            exr_format = "half" if bit_depth == "half" else "float"

            # ── Retime guards (spec #10) ──────────────────────────────────────
            # This FFmpeg fallback bakes constant speed via `setpts`, which
            # cannot reproduce an arbitrary keyframed ramp frame-accurately — so
            # dynamic ramps are refused here regardless of whether the planner
            # supplied a sourceFrameMap. The map still drives the frame-map
            # sidecar (Nuke/Resolve conform) and the resolve/oiio engines, which
            # extract per-frame from it. Freeze is handled by the two-stage
            # extract+loop path below (see _is_freeze_bake).
            retime = job.get("retime") or {}
            if retime.get("isDynamic"):
                raise RuntimeError(
                    "RETIME_DYNAMIC_UNSUPPORTED: dynamic speed ramp detected — "
                    "the FFmpeg fallback cannot bake ramps. Use the Resolve/OIIO "
                    "engine, or conform from the frame-map sidecar in Nuke."
                )
            _is_freeze_bake = bool(retime.get("freeze")) and retime.get("mode") == "bake_to_timeline"

            if not source or not os.path.exists(source):
                raise FileNotFoundError(f"Source not found: {source}")
            # If outputDir not specified, fall back to {proxy_root}/exr_tmp/{shotName}
            if not output_dir:
                from .proxy_registry import get_proxy_root
                pr = get_proxy_root()
                if pr:
                    shot = job.get("metadata", {}).get("shotName") or os.path.splitext(os.path.basename(source))[0]
                    output_dir = str(pr / "exr_tmp" / shot)
                else:
                    import tempfile
                    shot = job.get("metadata", {}).get("shotName") or os.path.splitext(os.path.basename(source))[0]
                    output_dir = os.path.join(tempfile.gettempdir(), "pfx_exr_tmp", shot)
            os.makedirs(output_dir, exist_ok=True)

            def tc_to_sec(tc: str) -> float:
                p = tc.replace(";", ":").split(":")
                if len(p) < 4: return 0.0
                return int(p[0])*3600 + int(p[1])*60 + int(p[2]) + int(p[3])/max(1, fps)

            start_sec = tc_to_sec(export_in)
            dur_sec   = max(0.1, tc_to_sec(export_out) - start_sec)
            out_pattern = os.path.join(output_dir, pattern.replace("%04d", f"%0{len(str(frame_start+exp_frames-1))}d"))
            # Renumber from frame_start
            out_pattern_abs = os.path.join(output_dir, f"_tmp_%06d.exr")

            # ── Camera-RAW pre-decode ─────────────────────────────────────────
            # ffmpeg's exr encoder needs a decoded video stream. Camera RAW
            # (Sony X-OCN, ARRIRAW, R3D, BRAW, MXF with vendor-only codecs)
            # cannot be opened by ffmpeg directly. Detect those and transcode
            # to a lossless intermediate first, then point ffmpeg at the temp.
            ffmpeg_path  = _find_ffmpeg() or "ffmpeg"
            ffprobe_path = _find_ffprobe(ffmpeg_path)
            decoded_source = source
            _used_intermediate = False

            _ext = os.path.splitext(source)[1].lower()
            _is_red      = _ext == ".r3d"
            _is_braw     = _ext == ".braw"
            _is_arriraw  = _ext in (".ari", ".arx")
            _is_sony_mxf = False
            _probed_codec = ""
            if ffprobe_path:
                try:
                    _pr = subprocess.run(
                        [ffprobe_path, "-v", "quiet", "-print_format", "json",
                         "-show_streams", "-show_format", "-select_streams", "v:0", source],
                        capture_output=True, timeout=30,
                    )
                    if _pr.returncode == 0:
                        import json as _json
                        _pd = _json.loads(_pr.stdout or b"{}")
                        _vs = (_pd.get("streams") or [{}])[0]
                        _probed_codec = str(_vs.get("codec_name") or "").lower()
                        _tags = {
                            str(k).lower(): str(v).strip().lower()
                            for k, v in ((_pd.get("format") or {}).get("tags") or {}).items()
                        }
                        if _ext == ".mxf" and (
                            "sony" in (_tags.get("company_name") or "")
                            or "axs"  in (_tags.get("product_name") or "")
                        ):
                            _is_sony_mxf = True
                        if _probed_codec in ("xocn", "vc6", "xavc_raw"):
                            _is_sony_mxf = True
                        if _probed_codec == "r3d":
                            _is_red = True
                        if _probed_codec == "arriraw":
                            _is_arriraw = True
                        if _probed_codec in ("braw", "braw_sdk"):
                            _is_braw = True
                except Exception:
                    pass

            _needs_pre_decode = _is_red or _is_braw or _is_arriraw or _is_sony_mxf

            if _needs_pre_decode:
                state["progressPct"] = 5
                _td = tempfile.mkdtemp(prefix="pfx_ocf_exr_pre_")
                _temp_intermediate = _td  # dir, deleted in finally
                _inter = os.path.join(_td, "intermediate.mov")
                _ok = False
                # 1) ARRIRAW → ART/ARC CMD (best fidelity)
                if _is_arriraw and (_find_art_cmd() or _find_arc_cmd()):
                    _ok2, _err = _arriraw_transcode_to_h264(
                        media_path=source, output_mp4=_inter,
                        ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path,
                    )
                    _ok = _ok2 and os.path.isfile(_inter) and os.path.getsize(_inter) > 0
                # 2) Generic camera-RAW → AVFoundation (macOS) for Sony/RED/BRAW
                if not _ok and _find_avconvert():
                    _ok2, _ = _avconvert_transcode_to_h264(
                        media_path=source, output_mp4=_inter,
                        ffmpeg_path=ffmpeg_path,
                    )
                    _ok = _ok2 and os.path.isfile(_inter) and os.path.getsize(_inter) > 0
                if not _ok:
                    _label = "Sony RAW" if _is_sony_mxf else "RED RAW" if _is_red else "Blackmagic RAW" if _is_braw else "ARRIRAW"
                    raise RuntimeError(
                        f"{_label} cannot be decoded — install camera tool "
                        f"(Sony Catalyst Browse / REDline / DaVinci Resolve / ARRI Reference Tool) "
                        f"and retry."
                    )
                decoded_source = _inter
                _used_intermediate = True

            # ── Filter chain (spec #10): speed → crop → scale → pad ──────────
            # _build_vf_chain returns a comma-joined ffmpeg -vf expression
            # honouring job.retime (speed factor + reverse) and job.reframe
            # (active-area crop + target UHD reformat). Empty string when no
            # filter work is needed (no speed change, no reframe).
            vf_chain = self._build_vf_chain(job, fps)

            # ── ACES IDT 3D LUT (camera log → ACES2065-1) ────────────────────
            # Resolve a per-camera .cube LUT on first use; subsequent jobs reuse
            # the cached file. The LUT is generated from published manufacturer
            # log/gamut specifications (see color_lut.py) and applied via ffmpeg's
            # lut3d filter, which uses trilinear interpolation at SIMD speed.
            _idt_name     = (job.get("colorPlan") or {}).get("idtName") or ""
            _lut_cache_dir = os.path.join(os.path.expanduser("~"), ".postflowx", "idt_luts")
            _idt_lut_path  = _get_idt_lut_path(_idt_name, _lut_cache_dir) if _idt_name else None
            if _idt_lut_path:
                # Escape colons and backslashes for the ffmpeg filter-graph syntax.
                _lut_arg = _idt_lut_path.replace("\\", "\\\\").replace(":", "\\:")
                _idt_filter = f"lut3d={_lut_arg}"
                vf_chain = (vf_chain + "," + _idt_filter) if vf_chain else _idt_filter

            if _is_freeze_bake:
                # ── Freeze-frame retime: two-stage pipeline ──────────────────
                # Stage A: extract a single source frame at the freeze position
                # to a lossless PNG. The freeze position can be specified in
                # frames (retime.freeze.frame, relative to source 0) — fall
                # back to the event srcIn when not set so a bare freeze:true
                # event still works.
                freeze_info  = retime.get("freeze") or {}
                freeze_frame = freeze_info.get("frame")
                if isinstance(freeze_frame, (int, float)) and freeze_frame >= 0:
                    freeze_sec = float(freeze_frame) / max(1.0, fps)
                else:
                    freeze_sec = start_sec   # default to the export-in TC
                freeze_png = os.path.join(output_dir, "_freeze_src.png")

                extract_cmd = [
                    ffmpeg_path, "-y",
                    "-ss", f"{freeze_sec:.6f}",
                    "-i", decoded_source,
                    "-frames:v", "1",
                    # Apply the spatial part of the filter chain (crop+scale+pad)
                    # to the single frame too so the freeze plate matches the
                    # rest of the package's reframe.
                ]
                # Build a spatial-only vf chain (no setpts / reverse). Reuse
                # _build_vf_chain with retime stripped for cleanliness.
                spatial_job = {**job, "retime": {"mode": "source_frames_only",
                                                 "hasSpeedChange": False}}
                spatial_chain = self._build_vf_chain(spatial_job, fps)
                if spatial_chain:
                    extract_cmd += ["-vf", spatial_chain]
                extract_cmd += [freeze_png]
                _ex = subprocess.run(extract_cmd, capture_output=True, timeout=120)
                if _ex.returncode != 0 or not os.path.isfile(freeze_png) or os.path.getsize(freeze_png) == 0:
                    raise RuntimeError(
                        f"FREEZE_EXTRACT_FAILED: could not pull freeze frame at "
                        f"{freeze_sec:.2f}s — {_ex.stderr.decode('utf-8', 'replace')[:400]}"
                    )

                # Stage B: loop the extracted PNG to produce the expected EXR
                # sequence length. -loop 1 + -t derives a constant-rate output
                # of duration `dur_sec` at `fps`, which yields exactly
                # round(dur_sec * fps) frames — matches expectedRenderedFrameCount.
                cmd = [
                    ffmpeg_path, "-y",
                    "-loop", "1", "-framerate", str(fps),
                    "-i", freeze_png,
                    "-t", str(dur_sec),
                ]
                if _idt_lut_path:
                    _lut_arg_f = _idt_lut_path.replace("\\", "\\\\").replace(":", "\\:")
                    cmd += ["-vf", f"lut3d={_lut_arg_f}"]
                cmd += ["-c:v", "exr", "-pix_fmt", pix_fmt, "-format", exr_format, out_pattern_abs]
                # Clean up the temp PNG after stage B exits — register the
                # path so the finally block can purge it.
                state["_freeze_temp_png"] = freeze_png
            else:
                cmd = [ffmpeg_path, "-y", "-ss", str(start_sec), "-t", str(dur_sec),
                       "-i", decoded_source]
                if vf_chain:
                    cmd += ["-vf", vf_chain]
                    # When speed is baked we must let ffmpeg compute output frame
                    # timing from the filtered PTS — pin the output rate to fps
                    # so the EXR sequence numbers map 1:1 to rendered frames.
                    cmd += ["-vsync", "cfr", "-r", str(fps)]
                cmd += ["-c:v", "exr", "-pix_fmt", pix_fmt, "-format", exr_format, out_pattern_abs]
            # Use a stderr buffer thread to prevent OS pipe buffer deadlock on verbose ffmpeg output.
            stderr_lines: list[str] = []

            def _drain_stderr(pipe):
                for line in pipe:
                    stderr_lines.append(line)

            proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, text=True)
            drain_thread = threading.Thread(target=_drain_stderr, args=(proc.stderr,), daemon=True)
            drain_thread.start()

            while proc.poll() is None:
                time.sleep(0.5)
                # Progress is best-effort — a transient listdir error (e.g. the
                # output dir momentarily unavailable) must NOT break the loop, or
                # we'd leave ffmpeg running orphaned. Keep polling until proc exits.
                try:
                    done = len([f for f in os.listdir(output_dir) if f.startswith("_tmp_") and f.endswith(".exr")])
                    state["progressPct"] = min(95, int(done * 100 / max(1, exp_frames)))
                except OSError:
                    pass

            drain_thread.join(timeout=5)
            if proc.returncode != 0:
                raise RuntimeError(f"ffmpeg failed: {''.join(stderr_lines[-20:])}")

            # Rename to final names
            tmp_files = sorted(f for f in os.listdir(output_dir) if f.startswith("_tmp_") and f.endswith(".exr"))
            for i, tmp in enumerate(tmp_files):
                final_name = pattern.replace("%04d", str(frame_start + i).zfill(4))
                os.rename(os.path.join(output_dir, tmp), os.path.join(output_dir, final_name))

            exported = len(tmp_files)
            aces_pipeline_used = bool(_idt_lut_path)
            _warnings = []
            if not aces_pipeline_used:
                if _used_intermediate:
                    _warnings.append("Decoded via camera-tool intermediate — verify color accuracy")
                elif exported:
                    _warnings.append("Used ffmpeg fallback decoder — verify color accuracy")
            # List the realised output file paths so the JS export queue can
            # populate exrResults[i].frames and the export log + Nuke handoff
            # can reference real on-disk paths (not just patterns).
            try:
                final_files = sorted(
                    os.path.join(output_dir, f)
                    for f in os.listdir(output_dir)
                    if f.endswith(".exr") and not f.startswith("_tmp_")
                )[: max(1, exported)]
            except OSError:
                final_files = []
            state.update({
                "state": "done", "progressPct": 100,
                "result": {
                    "status":           "success",
                    "shotId":           job.get("shotId", ""),
                    "framesExported":   exported,
                    "firstFrame":       frame_start,
                    "lastFrame":        frame_start + exported - 1,
                    "missingFrames":    [],
                    "warnings":         _warnings,
                    "errors":           [],
                    "acesPipeline":     aces_pipeline_used,
                    "filterChainUsed":  bool(vf_chain),
                    "outputFiles":      final_files,
                    "metadata": {"sourceTimecode": export_in, "fps": fps, "resolution": "", "reel": ""},
                },
            })
        except Exception as exc:
            state.update({"state": "failed", "error": str(exc)})
        finally:
            if _temp_intermediate:
                try: shutil.rmtree(_temp_intermediate, ignore_errors=True)
                except Exception: pass
            # Purge the freeze-frame extraction PNG (if any) so the output
            # folder only contains the final EXR sequence.
            _freeze_tmp = state.get("_freeze_temp_png") if isinstance(state, dict) else None
            if _freeze_tmp:
                try: os.remove(_freeze_tmp)
                except Exception: pass

    @staticmethod
    def _build_vf_chain(job: dict, fps: float) -> str:
        """Build the ffmpeg -vf chain for a VFX-Pull EXR export.

        Order matters: speed first (so we operate on real source frames),
        then crop (active-area from reframe), then scale + pad to target.
        Returns "" when no filter work is needed — caller then omits -vf
        entirely and gets the original "just decode + write EXR" path.

        Spec #10 contract:
          • job.retime.mode == 'bake_to_timeline' + retime.hasSpeedChange:
              constant speed → setpts=PTS/<speed>
              reversed       → ',reverse' suffix
            (Dynamic ramps + freeze are rejected earlier in _ocf_run_export.)
          • New pipeline shape (geometryEngine.js / pullJobModel.js):
              job.reframe.crop  — pre-built "crop=W:H:X:Y" string (or "")
              job.reframe.scale — pre-built "scale=W:H" string (or "")
          • Old pipeline shape (smartOcfPullController.js):
              job.reframe.mode != 'none' gate, then structured
              cropBox / targetWidth / targetHeight fields.
          Both shapes write setsar=1 at the end.
        """
        parts: list[str] = []

        # ── Speed bake ────────────────────────────────────────────────────
        retime = job.get("retime") or {}
        if retime.get("mode") == "bake_to_timeline" and retime.get("hasSpeedChange"):
            speed = retime.get("speed")
            if isinstance(speed, (int, float)) and speed > 0 and abs(speed - 1.0) > 1e-3:
                # setpts=PTS/<speed>: higher speed → smaller PTS → fewer
                # output frames per unit time. The -r and -vsync cfr flags
                # in the cmd builder pin the realised frame count.
                parts.append(f"setpts=PTS/{speed:.6f}")
            if retime.get("reversed"):
                parts.append("reverse")

        # ── Active-area crop + reframe to target ─────────────────────────
        reframe = job.get("reframe") or {}
        crop_str  = reframe.get("crop")  or ""   # new shape: "crop=W:H:X:Y"
        scale_str = reframe.get("scale") or ""   # new shape: "scale=W:H"

        if crop_str or scale_str:
            # New pipeline shape — filter strings built by geometryEngine.js
            if crop_str:
                parts.append(crop_str)
            if scale_str:
                parts.append(scale_str)
            parts.append("setsar=1")
        elif reframe.get("mode") and reframe["mode"] != "none":
            # Old pipeline shape — build filter from structured fields
            cb = reframe.get("cropBox")
            # cropBox = [x1, y1, x2, y2] — width = x2-x1, height = y2-y1.
            if isinstance(cb, (list, tuple)) and len(cb) == 4:
                try:
                    cx1, cy1, cx2, cy2 = [int(round(float(v))) for v in cb]
                    cw, ch = max(2, cx2 - cx1), max(2, cy2 - cy1)
                    parts.append(f"crop={cw}:{ch}:{cx1}:{cy1}")
                except (TypeError, ValueError):
                    pass
            tw = int(reframe.get("targetWidth")  or 3840)
            th = int(reframe.get("targetHeight") or 2160)
            # Scale to fit, then centre-crop the overshoot — preserves the
            # active image's aspect ratio while filling the target. setsar=1
            # so downstream tools don't see non-square pixels.
            parts.append(f"scale={tw}:{th}:force_original_aspect_ratio=increase")
            parts.append(f"crop={tw}:{th}")
            parts.append("setsar=1")

        return ",".join(parts)

    def _color_aces2_output_transforms(self, request: dict[str, Any]) -> dict[str, Any]:
        """List the ACES 2.0 output transforms available to the renderer (for the
        review-proxy ODT picker). Each entry has id/label/display/view/dynamicRange.
        Empty list means the baked LUTs aren't present (build with
        tools/gen_aces2_luts.py)."""
        try:
            from .color import aces2_luts
            return self._ok({"transforms": aces2_luts.list_output_transforms()})
        except Exception as exc:
            return self._ok({"transforms": [], "warning": f"ACES 2.0 LUTs unavailable: {exc}"})

    _OCF_JOBS_MAX = 64  # evict oldest terminal jobs beyond this cap

    def _ocf_exr_export_status(self, request: dict[str, Any]) -> dict[str, Any]:
        """Poll export job status."""
        job_id = str(request.get("jobId") or "").strip()
        state  = self._ocf_jobs.get(job_id)
        if not state: return self._ok({"state": "unknown", "progressPct": 0})
        resp = self._ok({
            "state": state["state"],
            "progressPct": state["progressPct"],
            **({"result": state["result"]} if state.get("result") else {}),
            **({"error": state["error"]}   if state.get("error")  else {}),
        })
        # Evict oldest terminal jobs to keep the registry bounded.
        if len(self._ocf_jobs) > self._OCF_JOBS_MAX:
            terminal = [jid for jid, s in self._ocf_jobs.items()
                        if s.get("state") in ("done", "failed", "cancelled") and jid != job_id]
            for jid in terminal[:max(1, len(terminal) - self._OCF_JOBS_MAX // 2)]:
                del self._ocf_jobs[jid]
        return resp

    def _ocf_exr_export_cancel(self, request: dict[str, Any]) -> dict[str, Any]:
        """Cancel a running export."""
        job_id = str(request.get("jobId") or "").strip()
        state  = self._ocf_jobs.get(job_id)
        if state and state["state"] == "running":
            state["state"] = "cancelled"
        return self._ok({"ok": True})

    def _ocf_extract_frame(self, request: dict[str, Any]) -> dict[str, Any]:
        """Extract a single OCF frame: Resolve Engine → native SDK → ffmpeg."""
        import os
        file_path    = str(request.get("filePath") or "").strip()
        timecode     = str(request.get("timecode") or "").strip()
        source_start_tc = str(request.get("sourceStartTc") or request.get("source_start_tc") or "").strip()
        fps_hint     = float(request.get("fps") or 0) or 0.0
        width        = int(request.get("width") or 640)
        height       = int(request.get("height") or 360)
        fmt          = str(request.get("format") or "jpg").lower().strip(".")
        force_ffmpeg = bool(request.get("forceFfmpeg"))

        if not file_path or not os.path.isfile(file_path):
            return self._error("INVALID_PATH", f"File not found: {file_path}", "OCF file path is invalid.")

        # Tier 1: DaVinci Resolve Engine — primary decoder for all camera originals.
        if not force_ffmpeg:
            resolve_available = self._get_resolve_app() is not None
            if resolve_available:
                r = self._ocf_extract_via_resolve(file_path, timecode, width, height, fmt)
                if r is not None:
                    return self._ok({**r, "extractor": "resolve",
                                     "requiresResolve": False, "resolveAvailable": True})

        # Tier 2: MediaRuntime native SDK backends (ARRI SDK, R3D SDK, BRAW SDK, ProRes).
        if not force_ffmpeg:
            r = self._ocf_extract_via_sdk(file_path, timecode, width, height, fmt)
            if r is not None:
                return self._ok({**r, "extractor": "sdk",
                                 "requiresResolve": False, "resolveAvailable": True})

        # Tier 3: ffmpeg — last resort, may fail for camera-native formats.
        import subprocess, tempfile, base64 as _b64
        ext_low     = os.path.splitext(file_path)[1].lower()
        is_cam_fmt  = ext_low in (".mxf", ".r3d", ".braw", ".ari", ".arx")
        resolve_available = not force_ffmpeg and self._get_resolve_app() is not None

        ffmpeg_path = _find_ffmpeg()
        if not ffmpeg_path:
            return self._ok({
                "dataUrl": None, "extractor": "ffmpeg",
                "requiresResolve": is_cam_fmt, "resolveAvailable": resolve_available,
                "error": "ffmpeg not found.",
            })

        ext  = "jpg" if fmt in ("jpg", "jpeg") else "png"
        mime = "image/jpeg" if ext == "jpg" else "image/png"
        tmp  = tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False)
        tmp.close()
        try:
            cmd = [ffmpeg_path, "-y"]
            if timecode:
                # ffmpeg -ss takes a duration in seconds, NOT a TC string. Camera OCF
                # runs free-run TC, so seek to (timecode − sourceStartTc) relative to
                # the file's first frame; without a start TC, fall back to absolute.
                seek_fps = fps_hint or 24.0
                off_sec = _timecode_to_seconds(timecode, seek_fps)
                if source_start_tc:
                    off_sec = max(0.0, off_sec - _timecode_to_seconds(source_start_tc, seek_fps))
                cmd += ["-ss", f"{off_sec:.3f}"]
            cmd += ["-i", file_path, "-vframes", "1"]
            if width > 0 and height > 0:
                cmd += ["-vf", f"scale={width}:{height}:force_original_aspect_ratio=decrease"]
            cmd.append(tmp.name)
            result = subprocess.run(cmd, capture_output=True, timeout=30)
            if result.returncode != 0 or not os.path.isfile(tmp.name) or os.path.getsize(tmp.name) == 0:
                return self._ok({
                    "dataUrl": None, "extractor": "ffmpeg",
                    "requiresResolve": is_cam_fmt, "resolveAvailable": resolve_available,
                    "error": result.stderr.decode(errors="replace")[:500],
                })
            with open(tmp.name, "rb") as fh:
                data_url = f"data:{mime};base64," + _b64.b64encode(fh.read()).decode()
            return self._ok({
                "dataUrl": data_url, "width": width, "height": height, "timecode": timecode,
                "extractor": "ffmpeg", "requiresResolve": False, "resolveAvailable": True,
            })
        except subprocess.TimeoutExpired:
            return self._error("TIMEOUT", "ffmpeg timed out", "Frame extraction timed out.")
        except Exception as exc:
            return self._error("EXTRACT_FAILED", str(exc), "Frame extraction failed.")
        finally:
            try: os.unlink(tmp.name)
            except Exception: pass

    def _ocf_extract_via_sdk(self, file_path: str, timecode: str, width: int, height: int, fmt: str):
        """Tier 2 helper: MediaRuntime native SDK (ARRI/R3D/BRAW/ProRes). Returns result dict or None."""
        try:
            rt      = self._get_media_runtime()
            open_r  = rt.open_file(file_path, {})
            if not open_r.get("ok"):
                return None
            session_id = open_r.get("sessionId") or ""
            backend    = open_r.get("backend") or ""
            if not open_r.get("framesDecodable", True):
                rt.close_file(session_id)
                return None
            fps       = float(open_r.get("fps") or 24)
            frame_idx = _tc_to_frames(timecode, fps) if timecode else 0
            frame_r   = rt.get_frame(session_id, frame_idx, {
                "width": width, "height": height, "format": fmt,
            })
            rt.close_file(session_id)
            if not frame_r.get("ok"):
                return None
            data_url = frame_r.get("dataUrl") or ""
            if not data_url:
                return None
            return {"dataUrl": data_url, "width": width, "height": height,
                    "timecode": timecode, "backend": backend}
        except Exception:
            return None

    def _ocf_extract_via_resolve(self, file_path: str, timecode: str, width: int, height: int, fmt: str,
                                 source_frame: Any | None = None) -> dict:
        """Single-frame still via DaVinci Resolve ExportCurrentFrameAsStill.
        Uses CreateTimelineFromClips + SetCurrentTimecode — mirrors the proven _resolve_export_still pattern.
        Falls back to render-queue (Format:JPEG then TIFF) if ExportCurrentFrameAsStill produces nothing.
        TIFF/DPX output is converted to JPEG via PIL or ffmpeg before base64 encoding.
        Always returns a dict {ok, stage, error?, dataUrl?, ...} — never None.
        """
        import tempfile, time, os, base64 as _b64, shutil, uuid, logging, subprocess

        log   = logging.getLogger("postflowx.resolve_still")
        stage = "init"
        clips: list = []
        timeline    = None
        orig_tl     = None
        project     = None
        pm          = None
        media_pool  = None
        created_proj: str | None = None
        keep_cached = False   # timeline is in the reuse cache → don't delete in finally
        reused      = False   # pulled an already-warmed timeline from the cache
        fps         = 24.0
        cm_saved    = None    # original color-management settings to restore in finally

        # Serialize all Resolve scripting-API work (not thread-safe; shared cache).
        self._ocf_resolve_lock.acquire()
        try:
            stage = "connect"
            app = self._get_resolve_app()
            if app is None:
                # Resolve may be relaunching (crash recovery, or just opened) and not
                # scriptable yet — even though PFX's cached "Resolve: Connected"
                # indicator is still green. Failing here gives the confusing
                # "connected but stage=connect" state the user saw. Instead, kick a
                # hidden background launch and wait briefly for it to become scriptable.
                try:
                    _rapp = "/Applications/DaVinci Resolve/DaVinci Resolve.app"
                    if os.path.isdir(_rapp):
                        subprocess.Popen(["open", "-gj", _rapp])
                except Exception:
                    pass
                for _ in range(24):          # up to ~12s
                    time.sleep(0.5)
                    app = self._get_resolve_app()
                    if app is not None:
                        break
            if app is None:
                return {"ok": False, "stage": stage,
                        "error": "Resolve is starting up — not scriptable yet. Retry in a moment.",
                        "resolveAvailable": False, "retryable": True}
            resolve_ver_inner = "unknown"
            try:
                resolve_ver_inner = str(app.GetVersion() or "unknown")
            except Exception:
                pass
            log.info("[Resolve Script Connect] ok=True resolveVersion=%s", resolve_ver_inner)

            stage = "project"
            pm = app.GetProjectManager()
            if not pm:
                # Resolve scriptapp is up but the app is still loading (splash /
                # "LOADING … PAGE") — the ProjectManager isn't ready yet. Wait.
                for _ in range(20):          # up to ~10s
                    time.sleep(0.5)
                    pm = app.GetProjectManager()
                    if pm:
                        break
            if not pm:
                return {"ok": False, "stage": stage, "error": "GetProjectManager() returned None.",
                        "resolveAvailable": True, "retryable": True}
            project = pm.GetCurrentProject()
            if not project:
                # Resolve is sitting at the Project Manager with nothing open (the
                # "New Project / 0 timelines" state seen after a relaunch). Open a
                # throwaway project so we have a media pool to work in.
                tmp_name = f"pfx_still_{uuid.uuid4().hex[:8]}"
                project  = pm.CreateProject(tmp_name)
                created_proj = tmp_name if project else None
            if not project:
                return {"ok": False, "stage": stage,
                        "error": "No active project in Resolve and CreateProject failed.",
                        "resolveAvailable": True, "retryable": True}

            stage      = "media_pool"
            media_pool = project.GetMediaPool()
            if not media_pool:
                return {"ok": False, "stage": stage, "error": "GetMediaPool() returned None."}

            # ── Timeline reuse cache (pro) ─────────────────────────────────────
            # The 7-frame strip extracts 7 stills from the SAME clip. Building (and
            # deleting) a fresh timeline per call is slow AND races Resolve's media
            # resolution — the first calls capture the red "Media Offline" card. So
            # build ONE warmed timeline per clip and reuse it for every position.
            tl_cache = getattr(self, "_ocf_tl_cache", None)
            if tl_cache is None:
                tl_cache = {}
                self._ocf_tl_cache = tl_cache

            # ── GC orphaned preview timelines ─────────────────────────────────
            # tl_cache is in-memory and empty at session start, so the eviction
            # loop below never cleans timelines left by a PRIOR session (or the
            # resolve_bridge path) — they accumulated (seen: 42 in the scratch
            # project). Sweep every preview-prefixed timeline that isn't a warm
            # cache entry or the current timeline. Cheap + idempotent + self-heals.
            try:
                _keep = set()
                for _v in tl_cache.values():
                    try: _keep.add(_v["timeline"].GetName())
                    except Exception: pass
                try:
                    _cur = project.GetCurrentTimeline()
                    if _cur and _cur.GetName(): _keep.add(_cur.GetName())
                except Exception: pass
                _stale = []
                _n = int(project.GetTimelineCount() or 0)
                for _i in range(1, _n + 1):
                    _t = project.GetTimelineByIndex(_i)
                    if not _t: continue
                    _nm = _t.GetName() or ""
                    if _is_preview_timeline_name(_nm) and _nm not in _keep:
                        _stale.append(_t)
                if _stale:
                    media_pool.DeleteTimelines(_stale)
                    log.info("[VFX Resolve Preview] GC: removed %d stale preview timeline(s)", len(_stale))
            except Exception as _gc_exc:
                log.info("[VFX Resolve Preview] timeline GC skipped: %s", _gc_exc)

            cached = tl_cache.get(file_path)
            if cached:
                try:
                    if cached["timeline"] and cached["timeline"].GetName():
                        timeline    = cached["timeline"]
                        clips       = cached["clips"]
                        fps         = cached["fps"]
                        reused      = True
                        keep_cached = True
                except Exception:
                    tl_cache.pop(file_path, None)

            if not reused:
                stage = "import_media"
                log.info("[Resolve Import OCF] ocfPath=%s exists=%s", file_path, os.path.isfile(file_path))
                clips = media_pool.ImportMedia([file_path]) or []
                if not clips:
                    resolve_ver = "unknown"
                    try:
                        resolve_ver = str(app.GetVersion() or "unknown")
                    except Exception:
                        pass
                    return {
                        "ok": False, "stage": stage,
                        "error": f"Resolve could not import this OCF file. ImportMedia returned empty — "
                                 f"the file format may not be supported or the file may be offline.",
                        "details": {
                            "ocfPath":       file_path,
                            "fileName":      os.path.basename(file_path),
                            "fileExtension": file_path.rsplit(".", 1)[-1].lower() if "." in file_path else "",
                            "fileExists":    os.path.isfile(file_path),
                            "resolveVersion": resolve_ver,
                        },
                    }
                log.info("[Resolve Import OCF] importedClipCount=%d clipName=%s",
                         len(clips), getattr(clips[0], "GetName", lambda: "?")())
                clip = clips[0]
                try:
                    fps = float(clip.GetClipProperty("FPS") or 24)
                except (TypeError, ValueError):
                    fps = 24.0

                stage    = "timeline_create"
                tl_name  = f"pfx_still_{uuid.uuid4().hex[:6]}"
                timeline = media_pool.CreateTimelineFromClips(tl_name, clips)
                if not timeline:
                    return {"ok": False, "stage": stage,
                            "error": "CreateTimelineFromClips() returned None."}

                # Evict any other clip's cached timeline (and its temp project, if we
                # created one) so projects/timelines don't accumulate across clips.
                for _k in list(tl_cache.keys()):
                    if _k != file_path:
                        _old = tl_cache.pop(_k)
                        try: media_pool.DeleteTimelines([_old["timeline"]])
                        except Exception: pass
                        try: media_pool.DeleteClips(_old["clips"])
                        except Exception: pass
                        _oldproj = _old.get("created_proj")
                        if _oldproj and pm:
                            try: pm.DeleteProject(_oldproj)
                            except Exception: pass
                tl_cache[file_path] = {"timeline": timeline, "clips": clips, "fps": fps,
                                       "created_proj": created_proj}
                keep_cached = True

            # clip is needed by the seek step (Start TC); set it for reused timelines too.
            clip = clips[0] if clips else None
            drop_frame = fps in (29.97, 59.94, 23.976)

            orig_tl = project.GetCurrentTimeline()
            project.SetCurrentTimeline(timeline)

            # ── Color management: convert camera log/RAW to Rec.709 for the preview ──
            # Sony X-OCN (S-Gamut3.Cine/S-Log3), ARRI LogC, etc. export FLAT/DARK when
            # the project is plain DaVinci YRGB with no input transform. Enable color
            # management (input = clip's detected color space → Rec.709 output) just for
            # this export, then RESTORE the project's original settings in `finally` so
            # the user's grade pipeline is never left altered. If the project is already
            # color-managed (or ACES), respect it and change nothing.
            try:
                _cur_science = str(project.GetSetting("colorScienceMode") or "davinciYRGB")
                if _cur_science == "davinciYRGB":
                    cm_saved = {
                        "colorScienceMode":   _cur_science,
                        "colorSpaceInput":    project.GetSetting("colorSpaceInput"),
                        "colorSpaceTimeline": project.GetSetting("colorSpaceTimeline"),
                        "colorSpaceOutput":   project.GetSetting("colorSpaceOutput"),
                    }
                    _clip_cs = ""
                    try:
                        _clip_cs = str(clip.GetClipProperty("Input Color Space") or "").strip()
                    except Exception:
                        pass
                    project.SetSetting("colorScienceMode", "davinciYRGBColorManagedv2")
                    if _clip_cs and _clip_cs.lower() not in ("", "-", "unknown", "bypass"):
                        project.SetSetting("colorSpaceInput", _clip_cs)
                    project.SetSetting("colorSpaceTimeline", "Rec.709 Gamma 2.4")
                    project.SetSetting("colorSpaceOutput", "Rec.709 Gamma 2.4")
                    log.info("[VFX Resolve Preview] color-managed export: input=%s → Rec.709 Gamma 2.4",
                             _clip_cs or "(auto-detect)")
                    # Let the color-science change propagate before seek/export, else a
                    # reused (warm) timeline can export one stale flat frame.
                    time.sleep(0.5)
            except Exception as cm_exc:
                log.warning("[VFX Resolve Preview] color-manage setup failed (non-fatal): %s", cm_exc)
                cm_saved = None

            # Settle ONLY for a freshly-built timeline so Resolve resolves the media
            # before the first export (avoids the "Media Offline" card). Reused
            # timelines are already warm → no wait → fast and race-free.
            #
            # Camera-RAW (Sony X-OCN) on a JUST-LAUNCHED / background Resolve needs
            # MORE than the old 1.2s: davinci_resolve.log shows the first frame decode
            # hitting "SendDataSync() timed out in 3000 ms → Failed to Read and convert
            # frame 0:0 ... after 0 retries" → a black preview. The Sony RAW decoder
            # warms up after the first access, so give the cold path a longer settle.
            if not reused:
                time.sleep(3.0)

            stage = "seek"
            # Timeline frame index of the seeked position (0 = timeline start).
            # Captured during seek so the render-queue fallback can render ONLY this
            # single frame (MarkIn/MarkOut) instead of the entire timeline.
            tl_mark_frame = 0
            if source_frame is not None:
                try:
                    frame_idx = max(0, int(float(source_frame)))
                    try:
                        _clip_frames = int(float(clip.GetClipProperty("Frames") or 0))
                    except (TypeError, ValueError):
                        _clip_frames = 0
                    if _clip_frames > 1:
                        frame_idx = min(frame_idx, _clip_frames - 1)
                    tl_mark_frame = frame_idx
                    rel_sec      = frame_idx / max(1.0, fps)
                    tl_start_tc  = str(timeline.GetCurrentTimecode() or "").strip() or "01:00:00:00"
                    tl_start_sec = _timecode_to_seconds(tl_start_tc, fps)
                    target_tl_tc = _seconds_to_timecode(tl_start_sec + rel_sec, fps, drop_frame)
                    log.info(
                        "[VFX Resolve Preview] seek by sourceFrame: frame=%s rel=%.3fs target=%s",
                        frame_idx, rel_sec, target_tl_tc,
                    )
                    timeline.SetCurrentTimecode(target_tl_tc)
                    landed = False
                    for _ in range(12):
                        time.sleep(0.1)
                        try:
                            if str(timeline.GetCurrentTimecode() or "").strip() == target_tl_tc:
                                landed = True
                                break
                        except Exception:
                            break
                    time.sleep(0.5 if reused else 0.25)
                    if not landed:
                        log.info("[VFX Resolve Preview] seek playhead did not confirm target=%s", target_tl_tc)
                except Exception as seek_exc:
                    log.warning("[VFX Resolve Preview] frame seek failed (non-fatal): %s", seek_exc)
            elif timecode:
                try:
                    # GetCurrentTimecode() returns the timeline's current position (its first frame).
                    # CreateTimelineFromClips preserves source timecode, so timeline start ≈ clip start.
                    tl_start_tc  = str(timeline.GetCurrentTimecode() or "").strip() or "01:00:00:00"
                    clip_start_tc = str(clip.GetClipProperty("Start TC") or tl_start_tc).strip()
                    rel_sec       = max(0.0, _timecode_to_seconds(timecode, fps)
                                           - _timecode_to_seconds(clip_start_tc, fps))
                    # Clamp to the clip's media range. A hero position whose source TC
                    # (e.g. Out + handle) runs past the OCF clip's last frame would
                    # otherwise seek beyond the timeline end and Resolve renders a pure
                    # BLACK still. Clamp to the last frame so we show the nearest real
                    # frame instead of black.
                    try:
                        _clip_frames = int(float(clip.GetClipProperty("Frames") or 0))
                    except (TypeError, ValueError):
                        _clip_frames = 0
                    if _clip_frames > 1 and fps > 0:
                        _max_rel = (_clip_frames - 1) / fps
                        if rel_sec > _max_rel:
                            log.info("[VFX Resolve Preview] seek clamp: rel=%.3fs > clip max=%.3fs → clamped to last frame",
                                     rel_sec, _max_rel)
                            rel_sec = _max_rel
                    tl_mark_frame = max(0, int(round(rel_sec * fps)))
                    tl_start_sec  = _timecode_to_seconds(tl_start_tc, fps)
                    target_tl_tc  = _seconds_to_timecode(tl_start_sec + rel_sec, fps, drop_frame)
                    log.info(
                        "[VFX Resolve Preview] seek: clip_start=%s tl_start=%s rel=%.3fs target=%s",
                        clip_start_tc, tl_start_tc, rel_sec, target_tl_tc,
                    )
                    # Diagnostic snapshot surfaced back to the renderer so we can see,
                    # live, whether the editorial requestedTc and the OCF's embedded
                    # clipStartTc share a clock (relFrames small = same clock; huge =
                    # different clock → the Resolve tier seeks to the wrong frame).
                    self._last_ocf_seek_diag = {
                        "requestedTc": timecode,
                        "clipStartTc": clip_start_tc,
                        "tlStartTc":   tl_start_tc,
                        "fps":         fps,
                        "relSec":      round(rel_sec, 3),
                        "relFrames":   int(round(rel_sec * fps)),
                        "targetTc":    target_tl_tc,
                    }
                    timeline.SetCurrentTimecode(target_tl_tc)
                    # Wait for the playhead to actually land — a reused (warm)
                    # timeline lags, and exporting too early grabs the previous
                    # frame or a black one (the "only the first strip frame shows"
                    # bug). Poll until the timecode matches, then give Resolve a
                    # moment to DECODE the ARRIRAW frame before the still export.
                    landed = False
                    for _ in range(12):                 # up to ~1.2s for the seek to land
                        time.sleep(0.1)
                        try:
                            if str(timeline.GetCurrentTimecode() or "").strip() == target_tl_tc:
                                landed = True
                                break
                        except Exception:
                            break
                    # Brief decode settle once the playhead has landed. Kept small so
                    # the 7-frame strip stays responsive; landing-confirm above is the
                    # real guard against grabbing the previous/black frame.
                    time.sleep(0.5 if reused else 0.25)
                    if not landed:
                        log.info("[VFX Resolve Preview] seek playhead did not confirm target=%s", target_tl_tc)
                except Exception as seek_exc:
                    log.warning("[VFX Resolve Preview] seek failed (non-fatal): %s", seek_exc)

            stage   = "export_still"
            tmp_dir = tempfile.mkdtemp(prefix="pfx_still_")
            try:
                # Export directly as JPEG — browser-displayable with no post-convert.
                # PIL isn't bundled and a GUI-launched companion has no ffmpeg on PATH,
                # so a .tif here falls through to a data:image/tiff URL the renderer's
                # <img> can't render — that's the "broken image" OCF preview bug.
                # Resolve honours the .jpg extension (verified on Resolve 21).
                still_path = os.path.join(tmp_dir, "pfx_frame.jpg")
                export_ok  = bool(project.ExportCurrentFrameAsStill(still_path))

                # ExportCurrentFrameAsStill may write a different extension — scan the dir.
                all_out = sorted(
                    f for f in os.listdir(tmp_dir)
                    if f.lower().endswith((".jpg", ".jpeg", ".png", ".tif", ".tiff", ".dpx", ".exr"))
                )
                log.info(
                    "[VFX Resolve Preview Render Output Check] export_ok=%s files=%s dir=%s",
                    export_ok, all_out, tmp_dir,
                )

                # ExportCurrentFrameAsStill grabs the timeline VIEWER frame, which is
                # often BLACK for camera-RAW (e.g. Sony X-OCN) when the companion runs
                # Resolve headless/background and the viewer hasn't decoded the frame.
                # The same clip renders fine via the render queue (a real render forces
                # a full decode). So if the still is black, discard it and fall through
                # to the render-queue path below. (PIL-free black check via ffmpeg.)
                if all_out:
                    try:
                        _ff_chk = None
                        try:
                            from .proxy_service import _find_ffmpeg as _ff_resolve0
                            _ff_chk = _ff_resolve0() or "ffmpeg"
                        except Exception:
                            _ff_chk = "ffmpeg"
                        _l0 = _still_avg_luma_ffmpeg(os.path.join(tmp_dir, all_out[0]), _ff_chk)
                        if _l0 is not None and _l0 < 6.0:
                            log.info("[VFX Resolve Preview] ExportCurrentFrameAsStill black (luma=%.1f) — using render-queue render instead", _l0)
                            for _f in all_out:
                                try: os.remove(os.path.join(tmp_dir, _f))
                                except Exception: pass
                            all_out = []
                    except Exception as _chk_exc:
                        log.info("[VFX Resolve Preview] black pre-check skipped: %s", _chk_exc)

                if not all_out:
                    # ExportCurrentFrameAsStill produced nothing (or was black) — render
                    # queue. A real render forces a full decode of camera-RAW (Sony
                    # X-OCN) that the headless/background viewer leaves black.
                    stage    = "render_queue"
                    height_q = height or int(width * 9 / 16)

                    # ── Render ONLY the seeked frame, not the whole timeline. ──
                    # The previous code set SelectAllFrames=True → Resolve rendered all
                    # 866 frames (a 121 MB H.264 of the entire clip, ~60-90 s). MarkIn ==
                    # MarkOut renders a single timeline frame instead → fast and small.
                    render_settings = {
                        "TargetDir":       tmp_dir,
                        "CustomName":      "pfx_still",
                        "ExportVideo":     True,
                        "ExportAudio":     False,
                        "SelectAllFrames": False,
                        "MarkIn":          int(tl_mark_frame),
                        "MarkOut":         int(tl_mark_frame),
                        "FormatWidth":     width,
                        "FormatHeight":    height_q,
                    }
                    project.SetRenderSettings(render_settings)

                    # ── Format/Codec must go through SetCurrentRenderFormatAndCodec. ──
                    # The "Format"/"Codec" KEYS inside SetRenderSettings are IGNORED by
                    # Resolve (the real root cause of the "renders an .mov but PFX shows
                    # nothing" bug — the job kept the leftover Custom Export H.264 preset
                    # and we scanned only for image files). Pick a still-image format
                    # from GetRenderFormats() so we get a single .tif/.jpg out.
                    still_format_set = False
                    try:
                        formats = project.GetRenderFormats() or {}   # {niceName: ext}
                        chosen_ext = None
                        for want in ("tif", "jpg", "jpeg", "png", "dpx"):
                            if want in (str(v).lower() for v in formats.values()):
                                chosen_ext = want
                                break
                        if chosen_ext:
                            codecs = project.GetRenderCodecs(chosen_ext) or {}   # {desc: token}
                            codec_token = next(iter(codecs.values()), "") if codecs else ""
                            still_format_set = bool(
                                project.SetCurrentRenderFormatAndCodec(chosen_ext, codec_token))
                            log.info("[VFX Resolve Preview] render format=%s codec=%s set=%s",
                                     chosen_ext, codec_token, still_format_set)
                    except Exception as _fmt_exc:
                        log.info("[VFX Resolve Preview] still-format select failed (will use current preset): %s", _fmt_exc)

                    # Resolve the ffmpeg binary once for the in-loop black check /
                    # video-frame extraction (GUI-launched companion has a stripped PATH).
                    try:
                        from .proxy_service import _find_ffmpeg as _ff_loop
                        _ff_bin = _ff_loop() or "ffmpeg"
                    except Exception:
                        _ff_bin = "ffmpeg"

                    # Render with a cold-decode retry. The FIRST render of a Sony X-OCN
                    # frame on a just-launched / background Resolve can come out BLACK
                    # ("SendDataSync timed out … Failed to Read and convert frame 0:0 …
                    # after 0 retries") because the RAW decoder isn't warm yet. The
                    # decoder warms after that first access, so a black render → wait →
                    # render again usually succeeds. Doing the retry HERE (inside one
                    # companion call) keeps Resolve warm and avoids the renderer
                    # relaunch-loop the user hit ("it always loop open resolve").
                    all_out = []
                    for _render_attempt in range(2):
                        job_id = project.AddRenderJob()
                        if not job_id:
                            return {"ok": False, "stage": stage,
                                    "error": "ExportCurrentFrameAsStill failed and AddRenderJob was rejected."}
                        log.info("[VFX Resolve Preview] render queue: job=%s markFrame=%s stillFormat=%s attempt=%d",
                                 job_id, tl_mark_frame, still_format_set, _render_attempt)
                        project.StartRendering([job_id])
                        _render_done = False
                        try:
                            for _ in range(180):   # up to 90s for a single frame
                                time.sleep(0.5)
                                st = project.GetRenderJobStatus(job_id) or {}
                                if st.get("JobStatus") in ("Complete", "Failed", "Cancelled"):
                                    log.info("[VFX Resolve Preview] render status: %s", st.get("JobStatus"))
                                    _render_done = True
                                    break
                        finally:
                            # Never leave an orphaned render job running in Resolve's queue.
                            if not _render_done:
                                try: project.StopRendering()
                                except Exception: pass
                            # Remove OUR render job so Resolve's queue doesn't accumulate
                            # one completed "pfx_still" job per preview frame. Delete only
                            # the job we added — never the whole queue (may be the user's).
                            try: project.DeleteRenderJob(job_id)
                            except Exception: pass

                        all_out = sorted(
                            f for f in os.listdir(tmp_dir)
                            if f.lower().endswith((".jpg", ".jpeg", ".png", ".tif", ".tiff"))
                        )
                        # Fallback: if the still-format select failed, the job rendered a
                        # video (.mov/.mp4) instead — extract its first frame with ffmpeg
                        # so PFX still gets an image. Guarantees "render → image in PFX"
                        # even when Resolve ignores the format set.
                        if not all_out:
                            vids = sorted(
                                f for f in os.listdir(tmp_dir)
                                if f.lower().endswith((".mov", ".mp4", ".mxf"))
                            )
                            if vids:
                                _vsrc = os.path.join(tmp_dir, vids[0])
                                _vjpg = os.path.join(tmp_dir, f"pfx_still_fromvid{_render_attempt}.jpg")
                                try:
                                    rr = subprocess.run(
                                        [_ff_bin, "-y", "-i", _vsrc, "-frames:v", "1",
                                         "-vf", f"scale={width}:-2", "-q:v", "2", _vjpg],
                                        capture_output=True, timeout=30,
                                    )
                                    if rr.returncode == 0 and os.path.isfile(_vjpg):
                                        all_out = [os.path.basename(_vjpg)]
                                        log.info("[VFX Resolve Preview] extracted still from rendered video %s", vids[0])
                                    else:
                                        log.warning("[VFX Resolve Preview] ffmpeg video-extract failed: %s",
                                                    rr.stderr.decode(errors="replace")[:300])
                                except Exception as _ve:
                                    log.warning("[VFX Resolve Preview] ffmpeg video-extract error: %s", _ve)
                                # Clear the source video so the next attempt's scan is clean.
                                try: os.remove(_vsrc)
                                except Exception: pass

                        # Cold-decode black check: if the rendered frame is black and we
                        # have a retry left, discard it, let the decoder warm, re-render.
                        if all_out and _render_attempt == 0:
                            _rl = None
                            try:
                                _rl = _still_avg_luma_ffmpeg(os.path.join(tmp_dir, all_out[0]), _ff_bin)
                            except Exception:
                                _rl = None
                            if _rl is not None and _rl < 6.0:
                                log.info("[VFX Resolve Preview] render frame black (luma=%.1f) — RAW decoder cold, retrying once", _rl)
                                for _f in all_out:
                                    try: os.remove(os.path.join(tmp_dir, _f))
                                    except Exception: pass
                                all_out = []
                                time.sleep(3.0)   # let the Sony RAW decoder warm up
                                continue
                        break

                    if not all_out:
                        return {"ok": False, "stage": stage,
                                "error": "Render queue completed but produced no image output."}

                found_path = os.path.join(tmp_dir, all_out[0])
                found_ext  = all_out[0].rsplit(".", 1)[-1].lower()
                found_size = os.path.getsize(found_path)
                log.info(
                    "[VFX Resolve Preview Render Output Check] exists=True sizeBytes=%d path=%s",
                    found_size, found_path,
                )
                if found_size == 0:
                    return {"ok": False, "stage": "output_check",
                            "error": "Output file exists but is 0 bytes."}

                # Convert TIFF / DPX / EXR → JPEG for browser display.
                if found_ext not in ("jpg", "jpeg", "png"):
                    jpeg_path = found_path.rsplit(".", 1)[0] + "_web.jpg"
                    converted = False
                    try:
                        from PIL import Image as _PIL  # type: ignore[import]
                        _PIL.open(found_path).convert("RGB").save(jpeg_path, "JPEG", quality=88)
                        found_path = jpeg_path
                        found_ext  = "jpg"
                        converted  = True
                        log.info("[VFX Resolve Preview] PIL %s→JPEG ok", all_out[0].rsplit(".",1)[-1])
                    except ImportError:
                        pass
                    if not converted:
                        try:
                            # Resolve absolute ffmpeg — a GUI-launched companion inherits
                            # the app's stripped PATH (no /opt/homebrew/bin), so bare
                            # "ffmpeg" would ENOENT and the still would stay a raw TIFF.
                            from .proxy_service import _find_ffmpeg as _ff_resolve
                            _ffmpeg_bin = _ff_resolve() or "ffmpeg"
                            r = subprocess.run(
                                [_ffmpeg_bin, "-y", "-i", found_path,
                                 "-vf", f"scale={width}:-2", "-q:v", "2", jpeg_path],
                                capture_output=True, timeout=30,
                            )
                            if r.returncode == 0 and os.path.isfile(jpeg_path):
                                found_path = jpeg_path
                                found_ext  = "jpg"
                                converted  = True
                                log.info("[VFX Resolve Preview] ffmpeg TIFF→JPEG ok")
                            else:
                                log.warning(
                                    "[VFX Resolve Preview] ffmpeg conversion failed: %s",
                                    r.stderr.decode(errors="replace")[:400],
                                )
                        except Exception as conv_exc:
                            log.warning("[VFX Resolve Preview] ffmpeg subprocess error: %s", conv_exc)

                # Downscale to the requested preview width. ExportCurrentFrameAsStill
                # exports at TIMELINE resolution (e.g. 1920×1080 ≈ 1 MB), ignoring
                # outputWidth — so without this the 7-frame strip ships ~7 MB of
                # base64 and renders slowly (looks like "0/7 / black" mid-gen).
                # `sips` is always present on macOS; PIL fallback if not.
                if width and found_ext in ("jpg", "jpeg", "png"):
                    try:
                        subprocess.run(["sips", "--resampleWidth", str(int(width)), found_path],
                                       timeout=10, check=False,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    except Exception:
                        try:
                            from PIL import Image as _PIL2
                            _im = _PIL2.open(found_path); _r = int(width) / max(1, _im.width)
                            _im.convert("RGB").resize((int(width), max(1, int(_im.height * _r)))).save(found_path, "JPEG", quality=85)
                        except Exception:
                            pass

                # Reject a near-black frame (Resolve's "Media Offline" card during
                # warmup, or a not-yet-resolved decode). Returning ok:False means the
                # app does NOT cache it and will retry once the engine is warm —
                # this is the "OCF strip stuck on black" fix. Genuine dark/night
                # frames are luma ~20+; the offline card / black render is ~0-3.
                _mluma = None
                try:
                    from PIL import Image as _PILk, ImageStat as _PILks
                    _mluma = _PILks.Stat(_PILk.open(found_path).convert("L")).mean[0]
                except Exception:
                    # PIL often absent in the companion's python → fall back to ffmpeg.
                    try:
                        from .proxy_service import _find_ffmpeg as _ff_resolve2
                        _mluma = _still_avg_luma_ffmpeg(found_path, _ff_resolve2() or "ffmpeg")
                    except Exception:
                        _mluma = None
                if _mluma is not None and _mluma < 6.0:
                    log.info("[VFX Resolve Preview] rejecting near-black frame (luma=%.1f) — likely media offline / decode not ready; will retry", _mluma)
                    return {"ok": False, "stage": "black_frame",
                            "error": "Decoded frame is black (media not ready) — retry.",
                            "resolveAvailable": True, "retryable": True}

                mime = ("image/jpeg" if found_ext in ("jpg", "jpeg") else
                        "image/png"  if found_ext == "png" else "image/tiff")
                with open(found_path, "rb") as fh:
                    data_url = f"data:{mime};base64," + _b64.b64encode(fh.read()).decode()

                return {"ok": True, "dataUrl": data_url, "width": width, "height": height,
                        "timecode": timecode, "stage": "complete"}
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)

        except Exception as exc:
            log.exception("[VFX Resolve Preview] Exception at stage '%s': %s", stage, exc)
            return {"ok": False, "stage": stage, "error": str(exc)}
        finally:
            # Restore the project's original color-management settings — never leave the
            # user's grade pipeline in the temporary Rec.709-preview state.
            if cm_saved and project:
                for _k, _v in cm_saved.items():
                    if _v is not None:
                        try: project.SetSetting(_k, _v)
                        except Exception: pass
            # Restore original timeline. KEEP the timeline/clips/project when they're
            # in the reuse cache (so the next strip position reuses the warm timeline);
            # eviction deletes old cached entries. Only tear down non-cached work.
            try:
                if orig_tl and project:
                    project.SetCurrentTimeline(orig_tl)
            except Exception:
                pass
            if not keep_cached:
                try:
                    if timeline and media_pool:
                        media_pool.DeleteTimelines([timeline])
                except Exception:
                    pass
                try:
                    if clips and media_pool:
                        media_pool.DeleteClips(clips)
                except Exception:
                    pass
                if created_proj and pm and project:
                    try:
                        pm.CloseProject(project)
                    except Exception:
                        pass
                    try:
                        pm.DeleteProject(created_proj)
                    except Exception:
                        pass
            try:
                self._ocf_resolve_lock.release()
            except Exception:
                pass

    def _vfx_preview_resolve_still_batch(self, request: dict[str, Any]) -> dict[str, Any]:
        """Batch OCF strip endpoint — renders the contiguous HdlSt→HdlEnd range ONCE
        and ffmpeg-extracts every requested position from that single render, instead
        of one Resolve render per frame (the 7× perf TODO). Mirrors the planner in
        scripts/features/vfxPull/ocfBatchPlan.js.

        request: { ocfPath, width?, picks:[{label, frame}] }
        returns: { ok, frames:[{label, frame, dataUrl}], stage } or {ok:false, error, stage}
                 Per-frame failures degrade gracefully (that pick is omitted); the JS
                 caller falls back to the single-frame path for any missing label.
        """
        import os, time, base64 as _b64, shutil, tempfile, subprocess, logging
        log = logging.getLogger("postflowx.resolve_still")

        ocf_path = str(request.get("ocfPath") or request.get("filePath") or "").strip()
        width    = int(request.get("outputWidth") or request.get("width") or 480)
        raw_picks = request.get("picks") or []
        # Keep label + EITHER an explicit timeline frame (library/by-frame path) OR a
        # source timecode (editorial path) — the timeline frame for a sourceTc pick is
        # resolved AFTER import from the clip's Start TC, exactly like the single-frame
        # endpoint, so batch and per-frame land on the same frame.
        picks = []
        for p in raw_picks:
            if not isinstance(p, dict):
                continue
            label = str(p.get("label") or "")
            f_raw = p.get("frame")
            tc    = str(p.get("sourceTc") or p.get("timecode") or "").strip()
            frame = None
            if f_raw is not None:
                try: frame = max(0, int(round(float(f_raw))))
                except (TypeError, ValueError): frame = None
            if frame is None and not tc:
                continue
            picks.append({"label": label or (str(frame) if frame is not None else tc),
                          "frame": frame, "sourceTc": tc})
        if not ocf_path or not os.path.isfile(ocf_path):
            return self._ok({"ok": False, "stage": "validation",
                             "error": "ocfPath missing or not found.", "resolveAvailable": False})
        if not picks:
            return self._ok({"ok": False, "stage": "validation", "error": "No picks provided."})

        app = self._get_resolve_app()
        if app is None:
            return self._ok({"ok": False, "stage": "connect",
                             "error": "Resolve Engine is not running.", "resolveAvailable": False})

        self._ocf_resolve_lock.acquire()
        cm_saved = None
        project = None
        orig_tl = None
        keep_cached = True
        timeline = None
        media_pool = None
        try:
            pm = app.GetProjectManager()
            if not pm:
                return self._ok({"ok": False, "stage": "project", "error": "No ProjectManager.",
                                 "resolveAvailable": True, "retryable": True})
            project = pm.GetCurrentProject()
            if not project:
                return self._ok({"ok": False, "stage": "project", "error": "No active project.",
                                 "resolveAvailable": True, "retryable": True})
            media_pool = project.GetMediaPool()
            if not media_pool:
                return self._ok({"ok": False, "stage": "media_pool", "error": "No MediaPool."})

            # Reuse the warm timeline cache built by the single-frame path (import once).
            tl_cache = getattr(self, "_ocf_tl_cache", None) or {}
            self._ocf_tl_cache = tl_cache
            cached = tl_cache.get(ocf_path)
            clips = []
            fps = 24.0
            if cached:
                try:
                    timeline = cached["timeline"]; clips = cached["clips"]; fps = cached["fps"]
                    _ = timeline.GetName()
                except Exception:
                    cached = None
            if not cached:
                clips = media_pool.ImportMedia([ocf_path]) or []
                if not clips:
                    return self._ok({"ok": False, "stage": "import_media",
                                     "error": "Resolve could not import the OCF file."})
                try: fps = float(clips[0].GetClipProperty("FPS") or 24)
                except (TypeError, ValueError): fps = 24.0
                import uuid as _uuid
                timeline = media_pool.CreateTimelineFromClips(f"pfx_still_{_uuid.uuid4().hex[:6]}", clips)
                if not timeline:
                    return self._ok({"ok": False, "stage": "timeline_create",
                                     "error": "CreateTimelineFromClips failed."})
                tl_cache[ocf_path] = {"timeline": timeline, "clips": clips, "fps": fps, "created_proj": None}

            orig_tl = project.GetCurrentTimeline()
            project.SetCurrentTimeline(timeline)

            # Color-manage camera log/RAW → Rec.709 for the preview (restore in finally).
            try:
                if str(project.GetSetting("colorScienceMode") or "davinciYRGB") == "davinciYRGB":
                    cm_saved = {k: project.GetSetting(k) for k in
                                ("colorScienceMode", "colorSpaceInput", "colorSpaceTimeline", "colorSpaceOutput")}
                    cm_saved["colorScienceMode"] = "davinciYRGB"
                    _cs = ""
                    try: _cs = str(clips[0].GetClipProperty("Input Color Space") or "").strip()
                    except Exception: pass
                    project.SetSetting("colorScienceMode", "davinciYRGBColorManagedv2")
                    if _cs and _cs.lower() not in ("", "-", "unknown", "bypass"):
                        project.SetSetting("colorSpaceInput", _cs)
                    project.SetSetting("colorSpaceTimeline", "Rec.709 Gamma 2.4")
                    project.SetSetting("colorSpaceOutput", "Rec.709 Gamma 2.4")
                    time.sleep(0.5)
            except Exception as _cm:
                log.warning("[VFX Batch] color-manage setup failed: %s", _cm)
                cm_saved = None

            if not cached:
                time.sleep(3.0)   # cold X-OCN decoder warm-up (see #4 in single-frame path)

            # Resolve each pick's TIMELINE frame. A by-frame pick is already a timeline
            # frame; a sourceTc pick maps via the clip's Start TC (same math as the
            # single-frame endpoint), clamped to the clip's media range.
            _clip_start_tc = ""
            _clip_frames = 0
            try: _clip_start_tc = str(clips[0].GetClipProperty("Start TC") or "").strip()
            except Exception: pass
            try: _clip_frames = int(float(clips[0].GetClipProperty("Frames") or 0))
            except (TypeError, ValueError): _clip_frames = 0
            _drop = fps in (29.97, 59.94, 23.976)
            for p in picks:
                if p["frame"] is None and p["sourceTc"]:
                    try:
                        rel = max(0.0, _timecode_to_seconds(p["sourceTc"], fps)
                                       - _timecode_to_seconds(_clip_start_tc or "00:00:00:00", fps))
                        p["frame"] = max(0, int(round(rel * fps)))
                    except Exception:
                        p["frame"] = 0
                if p["frame"] is None:
                    p["frame"] = 0
                if _clip_frames > 1:
                    p["frame"] = min(p["frame"], _clip_frames - 1)
            render_start = min(p["frame"] for p in picks)
            render_end   = max(p["frame"] for p in picks)

            tmp_dir = tempfile.mkdtemp(prefix="pfx_batch_")
            try:
                # ── ONE render of the whole HdlSt→HdlEnd range to a single mov. ──
                project.SetRenderSettings({
                    "TargetDir": tmp_dir, "CustomName": "pfx_batch",
                    "ExportVideo": True, "ExportAudio": False,
                    "SelectAllFrames": False, "MarkIn": int(render_start), "MarkOut": int(render_end),
                    "FormatWidth": width, "FormatHeight": int(width * 9 / 16),
                })
                job_id = project.AddRenderJob()
                if not job_id:
                    return self._ok({"ok": False, "stage": "render_queue", "error": "AddRenderJob rejected."})
                project.StartRendering([job_id])
                _done = False
                try:
                    for _ in range(360):     # up to 180s for the whole range
                        time.sleep(0.5)
                        st = project.GetRenderJobStatus(job_id) or {}
                        if st.get("JobStatus") in ("Complete", "Failed", "Cancelled"):
                            _done = True; break
                finally:
                    if not _done:
                        try: project.StopRendering()
                        except Exception: pass
                    try: project.DeleteRenderJob(job_id)
                    except Exception: pass

                vids = sorted(f for f in os.listdir(tmp_dir)
                              if f.lower().endswith((".mov", ".mp4", ".jpg", ".jpeg", ".png", ".tif", ".tiff")))
                if not vids:
                    return self._ok({"ok": False, "stage": "render_queue",
                                     "error": "Batch render produced no output."})
                src = os.path.join(tmp_dir, vids[0])

                try:
                    from .proxy_service import _find_ffmpeg as _ff
                    ffmpeg = _ff() or "ffmpeg"
                except Exception:
                    ffmpeg = "ffmpeg"

                frames_out = []
                for p in picks:
                    off = max(0, p["frame"] - render_start)
                    out_jpg = os.path.join(tmp_dir, f"pick_{off}.jpg")
                    try:
                        rr = subprocess.run(
                            [ffmpeg, "-y", "-i", src,
                             "-vf", f"select=eq(n\\,{off}),scale={width}:-2",
                             "-vsync", "0", "-frames:v", "1", "-q:v", "2", out_jpg],
                            capture_output=True, timeout=30,
                        )
                        if rr.returncode != 0 or not os.path.isfile(out_jpg):
                            # Range may be a single still image (mov select failed) — use it directly.
                            if src.lower().endswith((".jpg", ".jpeg", ".png")):
                                out_jpg = src
                            else:
                                continue
                        with open(out_jpg, "rb") as fh:
                            data_url = "data:image/jpeg;base64," + _b64.b64encode(fh.read()).decode()
                        frames_out.append({"label": p["label"], "frame": p["frame"], "dataUrl": data_url})
                    except Exception as _ex:
                        log.warning("[VFX Batch] extract pick %s failed: %s", p["label"], _ex)

                if not frames_out:
                    return self._ok({"ok": False, "stage": "extract",
                                     "error": "Batch render produced no extractable frames."})
                log.info("[VFX Batch] returned %d/%d frames (1 render, range %d-%d)",
                         len(frames_out), len(picks), render_start, render_end)
                return self._ok({"ok": True, "stage": "complete", "frames": frames_out,
                                 "decoder": "Resolve Engine", "resolveAvailable": True})
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)
        except Exception as exc:
            log.exception("[VFX Batch] exception: %s", exc)
            return self._ok({"ok": False, "stage": "exception", "error": str(exc)})
        finally:
            if cm_saved and project:
                for _k, _v in cm_saved.items():
                    if _v is not None:
                        try: project.SetSetting(_k, _v)
                        except Exception: pass
            try:
                if orig_tl and project: project.SetCurrentTimeline(orig_tl)
            except Exception: pass
            try: self._ocf_resolve_lock.release()
            except Exception: pass

    def _vfx_preview_resolve_still(self, request: dict[str, Any]) -> dict[str, Any]:
        """Dedicated Resolve Engine still endpoint — called by JS tier-1 orchestrator.
        Returns {ok, dataUrl, decoder, extractor, resolveAvailable} or {ok:false, error, stage, resolveAvailable}.
        """
        import os, logging
        log = logging.getLogger("postflowx.resolve_still")

        ocf_path  = str(request.get("ocfPath") or request.get("filePath") or "").strip()
        source_tc = str(request.get("sourceTc") or request.get("timecode") or "").strip()
        source_frame = request.get("sourceFrame")
        width     = int(request.get("outputWidth") or request.get("width") or 960)
        height    = int(request.get("outputHeight") or request.get("height") or 0)
        fmt       = str(request.get("format") or "jpg").lower().strip(".")

        if not ocf_path:
            return self._ok({"ok": False, "error": "ocfPath required.",
                             "stage": "validation", "resolveAvailable": False})
        if not os.path.isfile(ocf_path):
            return self._ok({"ok": False, "error": f"File not found: {ocf_path}",
                             "stage": "validation", "resolveAvailable": False})

        # Fast check: is Resolve's scripting API reachable?
        app = self._get_resolve_app()
        if app is None:
            return self._ok({
                "ok": False,
                "error": "Resolve Engine is not running.",
                "stage": "connect",
                "decoder": "Unsupported",
                "extractor": "resolve",
                "resolveAvailable": False,
            })

        resolve_ver = "unknown"
        try:
            resolve_ver = str(app.GetVersion() or "unknown")
        except Exception:
            pass
        log.info("[Resolve Script Connect] ok=True resolveVersion=%s", resolve_ver)
        log.info("[VFX Resolve Preview Request] ocfPath=%s sourceTc=%s width=%d", ocf_path, source_tc, width)

        r = self._ocf_extract_via_resolve(ocf_path, source_tc, width, height, fmt,
                                          source_frame=source_frame)

        log.info("[VFX Resolve Preview Native Response] ok=%s stage=%s error=%s",
                 r.get("ok"), r.get("stage"), r.get("error"))
        log.info("[VFX Resolve Preview Response] ok=%s stage=%s imageDataUrlLength=%d error=%s",
                 r.get("ok"), r.get("stage"),
                 len(r.get("dataUrl") or ""), r.get("error"))

        if not r.get("ok"):
            details = dict(r.get("details") or {})
            details.setdefault("resolveVersion", resolve_ver)
            details.setdefault("ocfPath", ocf_path)
            details.setdefault("fileExists", os.path.isfile(ocf_path))
            return self._ok({
                "ok":             False,
                "error":          r.get("error") or "Resolve could not extract a preview frame.",
                "stage":          r.get("stage") or "unknown",
                "decoder":        "Resolve Engine",
                "extractor":      "resolve",
                "resolveAvailable": True,
                "details":        details,
                "seekDiag":       getattr(self, "_last_ocf_seek_diag", None),
            })

        return self._ok({
            "ok":             True,
            "dataUrl":        r["dataUrl"],
            "decoder":        "Resolve Engine",
            "extractor":      "resolve",
            "resolveAvailable": True,
            "seekDiag":       getattr(self, "_last_ocf_seek_diag", None),
        })

    def _vfx_preview_avf_still(self, request: dict[str, Any]) -> dict[str, Any]:
        """macOS still-frame fallback for OCF preview (JS tier-2/3 orchestrator).

        When a sourceTc is requested, seek to the matched frame via ffmpeg
        (RELATIVE to the OCF free-run start TC). qlmanage's `-t` thumbnail only
        ever returns the clip POSTER/slate (it cannot seek), so it is used ONLY
        as a generic thumbnail when no timecode was requested. If a specific
        frame was requested but no decoder can reach it (camera RAW), report
        requiresResolve instead of a misleading slate.
        """
        import sys, os, subprocess, base64 as _b64, shutil, tempfile

        ocf_path  = str(request.get("ocfPath") or request.get("filePath") or "").strip()
        source_tc = str(request.get("sourceTc") or request.get("timecode") or "").strip()
        source_start_tc = str(request.get("sourceStartTc") or request.get("source_start_tc") or "").strip()
        fps_hint  = float(request.get("fps") or 0) or 0.0
        width     = int(request.get("outputWidth") or request.get("width") or 640)

        if not ocf_path or not os.path.isfile(ocf_path):
            return self._ok({"ok": False, "error": f"File not found: {ocf_path}"})

        # Frame-accurate path: a specific timecode was requested → ffmpeg seek
        # (relative to the OCF's own start TC). Reuses the fixed ffmpeg tier.
        if source_tc:
            r = self._ocf_extract_frame({
                "filePath": ocf_path, "timecode": source_tc,
                "sourceStartTc": source_start_tc, "fps": fps_hint,
                "width": width, "height": 0, "format": "jpg",
                "forceFfmpeg": True,
            })
            data = r.get("data", r) if isinstance(r, dict) else {}
            if data.get("dataUrl"):
                return self._ok({"ok": True, "dataUrl": data["dataUrl"],
                                 "decoder": "FFmpeg", "extractor": "ffmpeg"})
            # No decoder could reach the requested frame — almost always camera RAW.
            ext_low = os.path.splitext(ocf_path)[1].lower()
            return self._ok({
                "ok": False,
                "error": data.get("error") or "No decoder could extract the requested frame.",
                "requiresResolve": ext_low in (".mxf", ".r3d", ".braw", ".ari", ".arx"),
                "resolveAvailable": self._get_resolve_app() is not None,
            })

        # No timecode requested → generic poster thumbnail via qlmanage (macOS only).
        if not sys.platform.startswith("darwin"):
            return self._ok({"ok": False, "error": "AVFoundation only available on macOS."})

        tmp_dir = tempfile.mkdtemp(prefix="pfx_avf_")
        try:
            subprocess.run(
                ["/usr/bin/qlmanage", "-t", "-s", str(max(width, 320)), "-o", tmp_dir, ocf_path],
                capture_output=True, timeout=20,
            )
            output_files = sorted(
                f for f in os.listdir(tmp_dir)
                if f.lower().endswith((".png", ".jpg", ".jpeg"))
            )
            if not output_files:
                return self._ok({"ok": False, "error": "QuickLook generated no preview for this file."})

            out_path = os.path.join(tmp_dir, output_files[0])
            with open(out_path, "rb") as fh:
                raw = fh.read()

            ext  = output_files[0].rsplit(".", 1)[-1].lower()
            mime = "image/jpeg" if ext in ("jpg", "jpeg") else "image/png"
            return self._ok({
                "ok": True,
                "dataUrl": f"data:{mime};base64," + _b64.b64encode(raw).decode(),
                "decoder": "AVFoundation",
                "extractor": "avf",
                "posterFrame": True,
            })
        except subprocess.TimeoutExpired:
            return self._ok({"ok": False, "error": "QuickLook timed out."})
        except Exception as exc:
            return self._ok({"ok": False, "error": str(exc)})
        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

    def _ocf_extract_frame_to_file(self, request: dict[str, Any]) -> dict[str, Any]:
        """Extract a single frame from an OCF file and write it directly to disk."""
        import subprocess, os
        file_path   = str(request.get("filePath") or "").strip()
        timecode    = str(request.get("timecode") or "").strip()
        source_start_tc = str(request.get("sourceStartTc") or request.get("source_start_tc") or "").strip()
        fps_hint    = float(request.get("fps") or 0) or 0.0
        output_path = str(request.get("outputPath") or "").strip()
        width       = int(request.get("width") or 720)
        height      = int(request.get("height") or 404)
        fmt         = str(request.get("format") or "jpg").lower().strip(".")

        if not file_path or not os.path.isfile(file_path):
            return self._error("INVALID_PATH", f"File not found: {file_path}", "OCF file path is invalid.")
        if not output_path:
            return self._error("MISSING_OUTPUT", "outputPath required", "No output path specified.")
        ffmpeg_path = _find_ffmpeg()
        if not ffmpeg_path:
            return self._error("NO_FFMPEG", "ffmpeg not found", "Install ffmpeg to extract frames.")

        ext = "jpg" if fmt in ("jpg", "jpeg") else "png"
        try:
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            cmd = [ffmpeg_path, "-y"]
            if timecode:
                # -ss is seconds, not a TC string; seek relative to the OCF free-run start TC.
                seek_fps = fps_hint or 24.0
                off_sec = _timecode_to_seconds(timecode, seek_fps)
                if source_start_tc:
                    off_sec = max(0.0, off_sec - _timecode_to_seconds(source_start_tc, seek_fps))
                cmd += ["-ss", f"{off_sec:.3f}"]
            cmd += ["-i", file_path, "-vframes", "1"]
            if width > 0 and height > 0:
                cmd += ["-vf", f"scale={width}:{height}:force_original_aspect_ratio=decrease"]
            cmd.append(output_path)
            result = subprocess.run(cmd, capture_output=True, timeout=30)
            if result.returncode != 0 or not os.path.isfile(output_path) or os.path.getsize(output_path) == 0:
                return self._error("FFMPEG_FAILED", result.stderr.decode(errors="replace")[:500], "Frame extraction failed.")
            return self._ok({"outputPath": output_path, "width": width, "height": height, "timecode": timecode})
        except subprocess.TimeoutExpired:
            return self._error("TIMEOUT", "ffmpeg timed out", "Frame extraction timed out.")
        except Exception as exc:
            return self._error("EXTRACT_FAILED", str(exc), "Frame extraction failed.")

    def _ocf_extract_proxy_mov(self, request: dict[str, Any]) -> dict[str, Any]:
        """Transcode a range of an OCF file to a small H.264 proxy MOV."""
        import subprocess, os
        file_path   = str(request.get("filePath") or "").strip()
        tc_in       = str(request.get("tcIn") or "").strip()
        tc_out      = str(request.get("tcOut") or "").strip()
        output_path = str(request.get("outputPath") or "").strip()
        fps         = float(request.get("fps") or 24)
        width       = int(request.get("width") or 1280)
        height      = int(request.get("height") or 720)

        if not file_path or not os.path.isfile(file_path):
            return self._error("INVALID_PATH", f"File not found: {file_path}", "OCF file path is invalid.")
        if not output_path:
            return self._error("MISSING_OUTPUT", "outputPath required", "No output path specified.")
        ffmpeg_path = _find_ffmpeg()
        if not ffmpeg_path:
            return self._error("NO_FFMPEG", "ffmpeg not found", "Install ffmpeg to generate proxy MOV.")

        def _tc_to_sec(tc: str) -> float:
            p = tc.replace(";", ":").split(":")
            if len(p) == 4:
                return int(p[0]) * 3600 + int(p[1]) * 60 + int(p[2]) + int(p[3]) / max(1, fps)
            if len(p) == 3:
                return int(p[0]) * 3600 + int(p[1]) * 60 + float(p[2])
            return 0.0

        try:
            os.makedirs(os.path.dirname(output_path), exist_ok=True)
            cmd = [ffmpeg_path, "-y"]
            if tc_in:
                cmd += ["-ss", f"{_tc_to_sec(tc_in):.6f}"]
            cmd += ["-i", file_path]
            if tc_out and tc_in:
                dur = max(0.1, _tc_to_sec(tc_out) - _tc_to_sec(tc_in))
                cmd += ["-t", f"{dur:.6f}"]
            cmd += [
                "-vf", f"scale={width}:{height}:force_original_aspect_ratio=decrease,"
                       f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
                "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart",
                output_path,
            ]
            result = subprocess.run(cmd, capture_output=True, timeout=300)
            if result.returncode != 0 or not os.path.isfile(output_path) or os.path.getsize(output_path) == 0:
                return self._error("FFMPEG_FAILED", result.stderr.decode(errors="replace")[:500], "Proxy MOV generation failed.")
            return self._ok({"outputPath": output_path, "tcIn": tc_in, "tcOut": tc_out})
        except subprocess.TimeoutExpired:
            return self._error("TIMEOUT", "ffmpeg timed out after 5 min", "Proxy MOV generation timed out.")
        except Exception as exc:
            return self._error("MOV_FAILED", str(exc), "Proxy MOV generation failed.")

    def _ocf_write_files(self, request: dict[str, Any]) -> dict[str, Any]:
        """Write FDL/AMF/QC text files to an output directory.

        request.files is a list of { path: str (relative to outputDir), content: str }.
        Creates subdirectories as needed.
        """
        import os
        output_dir  = str(request.get("outputDir") or "").strip()
        files       = request.get("files") or []

        if not output_dir:
            return self._error("MISSING_DIR", "outputDir required", "No output directory specified.")
        if not isinstance(files, list):
            return self._error("BAD_REQUEST", "files must be a list", "Invalid files payload.")
        try:
            os.makedirs(output_dir, exist_ok=True)
        except Exception as exc:
            return self._error("MKDIR_FAILED", str(exc), f"Could not create output directory: {output_dir}")

        written = []
        errors  = []
        for item in files:
            rel_path = str(item.get("path") or "").strip()
            content  = item.get("content")
            if not rel_path or content is None:
                errors.append(f"Skipped invalid entry: {rel_path!r}")
                continue
            abs_path = os.path.normpath(os.path.join(output_dir, rel_path))
            # Security: reject paths that escape outputDir
            if not abs_path.startswith(os.path.normpath(output_dir)):
                errors.append(f"Rejected path outside outputDir: {rel_path!r}")
                continue
            try:
                os.makedirs(os.path.dirname(abs_path), exist_ok=True)
                mode = "wb" if isinstance(content, (bytes, bytearray)) else "w"
                with open(abs_path, mode, encoding=None if isinstance(content, (bytes, bytearray)) else "utf-8") as fh:
                    fh.write(content)
                written.append(abs_path)
            except Exception as exc:
                errors.append(f"{rel_path}: {exc}")

        return self._ok({"written": written, "errors": errors, "outputDir": output_dir})

    def _ocf_copy_exr_delivery(self, request: dict[str, Any]) -> dict[str, Any]:
        """Copy existing EXR delivery sequences + AMF look files to outputDir.

        request.shots — list of { shotName, exrFolder, amfPath (may be '') }
        Output structure: <outputDir>/<shotName>/EXR_Files/<shotName>/*.exr
                          <outputDir>/<shotName>/EXR_Files/Look_Files/<shotName>.amf
        """
        import os, shutil
        shots      = request.get("shots") or []
        output_dir = str(request.get("outputDir") or "").strip()
        if not output_dir:
            return self._error("MISSING_DIR", "outputDir required", "No output directory specified.")
        if not isinstance(shots, list) or not shots:
            return self._error("BAD_REQUEST", "shots must be a non-empty list", "Invalid shots payload.")

        results = []
        for shot in shots:
            shot_name  = str(shot.get("shotName") or "").strip()
            exr_folder = str(shot.get("exrFolder") or "").strip()
            amf_path   = str(shot.get("amfPath") or "").strip()
            if not shot_name or not exr_folder:
                results.append({"shotName": shot_name or "?", "ok": False, "error": "missing shotName or exrFolder"})
                continue
            # shotName is editorial-derived (EDL/FCPXML clip name) → untrusted.
            # Sanitize to a single safe segment AND confine the result under
            # output_dir so a crafted "../" name can't write outside the pull.
            safe_shot = _safe_name_component(shot_name, "shot")
            try:
                dst_exr     = _confined_join(output_dir, safe_shot, "EXR_Files", safe_shot)
                dst_amf_dir = _confined_join(output_dir, safe_shot, "EXR_Files", "Look_Files")
            except ValueError:
                results.append({"shotName": shot_name, "ok": False, "error": "unsafe shotName — path traversal blocked"})
                continue
            try:
                os.makedirs(dst_exr, exist_ok=True)
                copied = 0
                if os.path.isdir(exr_folder):
                    for fname in sorted(os.listdir(exr_folder)):
                        if fname.lower().endswith(".exr"):
                            shutil.copy2(os.path.join(exr_folder, fname), os.path.join(dst_exr, fname))
                            copied += 1
                amf_copied = False
                if amf_path and os.path.isfile(amf_path):
                    os.makedirs(dst_amf_dir, exist_ok=True)
                    shutil.copy2(amf_path, os.path.join(dst_amf_dir, f"{safe_shot}.amf"))
                    amf_copied = True
                results.append({"shotName": shot_name, "ok": True, "frames": copied, "amf": amf_copied, "exrDst": dst_exr})
            except Exception as exc:
                results.append({"shotName": shot_name, "ok": False, "error": str(exc)})

        failed = [r for r in results if not r.get("ok")]
        return self._ok({"results": results, "outputDir": output_dir, "failed": len(failed)})

    # ── VFX Pull render engine v3 ─────────────────────────────────────────────

    def _render_pull_exr_start(self, request: dict[str, Any]) -> dict[str, Any]:
        """Start an async VFX Pull render. Routes to Resolve → OIIO → FFmpeg.

        Routes based on job.colorPlan.engineHint:
          'resolve'        → DaVinci Resolve Studio (best for camera RAW + ACES IDT)
          'oiio'           → oiiotool (EXR→EXR with OCIO transforms)
          'ffmpeg_fallback' → existing ffmpeg path (_ocf_run_export)

        Returns { jobId } immediately; poll with renderPullExrStatus.
        """
        job = request.get("job")
        if not job:
            return self._error("MISSING_JOB", "job field required", "No job payload provided.")
        job_id = str(uuid.uuid4())[:8]
        self._ocf_jobs[job_id] = {"state": "running", "progressPct": 0, "result": None, "error": None}
        thread = threading.Thread(target=self._render_pull_exr_run, args=(job_id, job), daemon=True)
        thread.start()
        return self._ok({"jobId": job_id})

    def _render_pull_exr_run(self, job_id: str, job: dict) -> None:
        """Background render thread — route by engineHint."""
        import os
        state = self._ocf_jobs.get(job_id, {})
        engine = (job.get("colorPlan") or {}).get("engineHint", "ffmpeg_fallback")

        # ── Ensure package subdirs exist ─────────────────────────────────────
        pkg = job.get("package") or {}
        for subdir_key in ("exr", "metadata", "review", "nuke"):
            p = pkg.get(subdir_key, "")
            if p:
                try:
                    os.makedirs(p, exist_ok=True)
                except Exception:
                    pass

        # ── Engine routing ────────────────────────────────────────────────────
        try:
            if engine == "resolve":
                self._render_pull_exr_resolve(job_id, job, state)
            elif engine == "oiio":
                self._render_pull_exr_oiio(job_id, job, state)
            else:
                # ffmpeg_fallback — delegate to existing _ocf_run_export which
                # already handles speed bake, freeze, reframe, camera pre-decode.
                self._ocf_run_export(job_id, job)
        except Exception as exc:
            state.update({"state": "failed", "error": str(exc)})

    def _render_pull_exr_resolve(self, job_id: str, job: dict, state: dict) -> None:
        """Route render through DaVinci Resolve Engine if available.

        If Resolve scripting is not available, falls back to ffmpeg.
        """
        try:
            from .resolve_engine import start_resolve_job, get_session, is_engine_ready
        except ImportError:
            # Resolve engine module not installed — fallback to ffmpeg
            state.update({"_resolveUnavailable": True})
            self._ocf_run_export(job_id, job)
            return

        if not is_engine_ready():
            state.update({"_resolveUnavailable": True})
            self._ocf_run_export(job_id, job)
            return

        try:
            session_id = start_resolve_job(job, resolve_path="", timeout_seconds=7200, debug=False)
            # Poll until done or failed
            import time
            for _ in range(14400):   # max 4 hours
                sess = get_session(session_id) or {}
                pct = sess.get("progressPct") or 0
                st  = sess.get("state") or "running"
                state["progressPct"] = pct
                if st in ("done", "failed"):
                    if st == "done":
                        state.update({"state": "done", "progressPct": 100, "result": sess.get("result")})
                    else:
                        raise RuntimeError(sess.get("error") or "Resolve render failed")
                    return
                time.sleep(1)
            raise RuntimeError("Resolve render timed out after 4 hours")
        except Exception as exc:
            # Resolve failed — surface warning and fall back to ffmpeg
            state.update({"_resolveError": str(exc)})
            self._ocf_run_export(job_id, job)

    def _render_pull_exr_oiio(self, job_id: str, job: dict, state: dict) -> None:
        """Use oiiotool for EXR-to-EXR transforms with OCIO color management."""
        import os, subprocess, shutil
        from .proxy_service import _find_ffmpeg

        oiio = shutil.which("oiiotool")
        if not oiio:
            # oiiotool not installed — fall back to ffmpeg
            state.update({"_oiioUnavailable": True})
            self._ocf_run_export(job_id, job)
            return

        source      = job.get("sourcePath", "")
        output_dir  = (job.get("package") or {}).get("exr") or job.get("outputDir", "")
        pattern     = _safe_output_pattern(job.get("outputPattern", "%04d.exr"))
        frame_start = int(job.get("frameStart", 1001))
        color_plan  = job.get("colorPlan") or {}
        ocio_config = color_plan.get("ocioConfig") or ""
        idt         = color_plan.get("idtName") or ""
        out_space   = color_plan.get("outputSpace") or "ACES2065-1"
        exp_frames  = int(job.get("expectedRenderedFrameCount") or job.get("frameCount") or 1)

        if not source or not os.path.isfile(source) and not os.path.isdir(source):
            state.update({"state": "failed", "error": f"Source not found: {source}"})
            return

        os.makedirs(output_dir, exist_ok=True)

        # Build oiiotool color transform args
        color_args = []
        if ocio_config and os.path.isfile(ocio_config):
            color_args += ["--colorconfig", ocio_config]
        if idt and color_plan.get("applyIDT"):
            color_args += ["--colorconvert", idt, out_space]

        # Handle EXR sequence source
        src_files = []
        if os.path.isdir(source):
            src_files = sorted(f for f in os.listdir(source) if f.lower().endswith(".exr"))
        elif source.lower().endswith(".exr"):
            src_files = [os.path.basename(source)]
            source = os.path.dirname(source)

        # Dynamic retime: pull source frames per the ramp map instead of 1:1.
        retime = job.get("retime") or {}
        sfm = retime.get("sourceFrameMap")
        sfm = sfm if isinstance(sfm, list) and sfm else None
        out_count = len(sfm) if sfm else min(len(src_files), exp_frames)

        processed = 0
        for i in range(out_count):
            rel = _map_relative_source_index(i, sfm)
            src_idx = i if rel is None else rel
            if src_idx >= len(src_files):
                src_idx = len(src_files) - 1   # clamp ramps that run past the pulled window
            if src_idx < 0:
                continue
            fname = src_files[src_idx]
            src_path = os.path.join(source, fname) if os.path.isdir(source) else source
            out_name = pattern.replace("%04d", str(frame_start + i).zfill(4))
            out_path = os.path.join(output_dir, out_name)
            cmd = [oiio, src_path] + color_args + ["-o", out_path]
            try:
                r = subprocess.run(cmd, capture_output=True, timeout=120)
                if r.returncode == 0:
                    processed += 1
                    state["progressPct"] = min(95, int(processed * 100 / max(1, out_count)))
            except subprocess.TimeoutExpired:
                break

        state.update({
            "state": "done", "progressPct": 100,
            "result": {
                "status": "success",
                "shotId": job.get("shotId", ""),
                "framesExported": processed,
                "firstFrame": frame_start,
                "lastFrame": frame_start + processed - 1,
                "colorEngine": "oiio",
                "warnings": [] if color_plan.get("applyIDT") and idt else ["IDT not applied — verify color"],
            },
        })

    # ── Review proxy movie (ACES 2.0 ODT baked) ───────────────────────────────

    def _render_review_proxy_start(self, request: dict[str, Any]) -> dict[str, Any]:
        """Start an async review-proxy movie render from an AP0 EXR sequence.

        review_proxy = IDT (+look) already baked into the EXRs (ACES2065-1) → this
        bakes the ACES 2.0 ODT (display transform) and encodes a viewable movie.
        Reuses the EXR-pull job registry, so poll with renderPullExrStatus.

        job fields:
          exrDir | package.exr      directory of the AP0 EXR sequence
          exrPattern                e.g. "shot.%04d.exr" (default "%04d.exr")
          frameStart (1001), fps (24)
          colorPlan.odtId | odtId   ACES 2.0 transform id/name (default rec709_sdr)
          codec                     "h264" (default) | "prores"
          output | package.review   output movie path or dir
        """
        job = request.get("job") or request
        job_id = str(uuid.uuid4())[:8]
        self._ocf_jobs[job_id] = {"state": "running", "progressPct": 0, "result": None, "error": None}
        t = threading.Thread(target=self._render_review_proxy_run, args=(job_id, job), daemon=True)
        t.start()
        return self._ok({"jobId": job_id})

    def _render_review_proxy_run(self, job_id: str, job: dict) -> None:
        import os, subprocess, glob
        state = self._ocf_jobs.get(job_id, {})
        try:
            from .color import aces2_luts
            from .proxy_service import _find_ffmpeg

            ff = _find_ffmpeg()
            if not ff:
                raise RuntimeError("ffmpeg not available")

            pkg = job.get("package") or {}
            exr_dir = job.get("exrDir") or pkg.get("exr") or ""
            if not exr_dir or not os.path.isdir(exr_dir):
                raise RuntimeError(f"EXR directory not found: {exr_dir!r}")
            pattern = _safe_output_pattern(job.get("exrPattern"), "%04d.exr")
            frame_start = int(job.get("frameStart", 1001))
            fps = float(job.get("fps") or 24.0)

            # The pattern may be just "%04d.exr" or "name.%04d.exr"; if the exact
            # start frame isn't present, fall back to the first EXR on disk.
            in_path = os.path.join(exr_dir, pattern)
            if not os.path.isfile(in_path.replace("%04d", str(frame_start).zfill(4))):
                found = sorted(glob.glob(os.path.join(exr_dir, "*.exr")))
                if not found:
                    raise RuntimeError(f"No EXR frames in {exr_dir}")
                # derive start number from the first file when possible
                import re
                m = re.search(r"(\d+)\.exr$", os.path.basename(found[0]))
                if m:
                    frame_start = int(m.group(1))

            cp = job.get("colorPlan") or {}
            odt = job.get("odtId") or cp.get("odtId") or cp.get("odtName") or "rec709_sdr"
            lut_id = aces2_luts.resolve_lut_id(odt, default="rec709_sdr")
            if not lut_id:
                raise RuntimeError("ACES 2.0 ODT LUTs not available (build tools/gen_aces2_luts.py)")
            odt_vf = aces2_luts.ffmpeg_video_filter(lut_id)

            # Encoder + colour tagging depend on the transform's dynamic range.
            # The encoder's own -color_* flags aren't always honoured (e.g.
            # videotoolbox writes 'linear' trc), so stamp via setparams in the
            # filtergraph too. The bundled ffmpeg is LGPL → no libx264; use
            # videotoolbox (h264/hevc) or prores.
            reg = aces2_luts.REGISTRY.get(lut_id, {})
            is_hdr = reg.get("dynamicRange") == "HDR"
            if is_hdr:
                # PQ → smpte2084, HLG → arib-std-b67; both Rec.2020 primaries, 10-bit HEVC.
                trc = "arib-std-b67" if "HLG" in (reg.get("display", "")) else "smpte2084"
                prim, mtx = "bt2020", "bt2020nc"
                tag = f"setparams=color_primaries={prim}:color_trc={trc}:colorspace={mtx}"
                enc = ["-c:v", "hevc_videotoolbox", "-profile:v", "main10",
                       "-pix_fmt", "yuv420p10le", "-tag:v", "hvc1",
                       "-b:v", str(job.get("bitrate") or "30M")]
                vf = f"{odt_vf},format=yuv420p10le,{tag}"
                ext = ".mov"
                col = ["-colorspace", mtx, "-color_primaries", prim, "-color_trc", trc, "-color_range", "tv"]
            else:
                prim = mtx = trc = "bt709"
                tag = f"setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"
                codec = str(job.get("codec") or "h264").lower()
                if codec == "prores":
                    enc = ["-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"]
                    vf = f"{odt_vf},format=yuv422p10le,{tag}"
                    ext = ".mov"
                else:
                    enc = ["-c:v", "h264_videotoolbox", "-b:v", str(job.get("bitrate") or "12M")]
                    vf = f"{odt_vf},format=yuv420p,{tag}"
                    ext = ".mp4"
                col = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]
            codec = "hevc" if is_hdr else str(job.get("codec") or "h264").lower()

            out = job.get("output") or ""
            if not out:
                review_dir = pkg.get("review") or exr_dir
                os.makedirs(review_dir, exist_ok=True)
                name = job.get("shotId") or os.path.basename(os.path.normpath(exr_dir)) or "review"
                out = os.path.join(review_dir, f"{name}_aces2_{lut_id}{ext}")
            else:
                os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

            cmd = [ff, "-y", "-framerate", f"{fps:g}",
                   "-start_number", str(frame_start),
                   "-i", os.path.join(exr_dir, pattern),
                   "-vf", vf,
                   *enc,
                   *col,   # stream colour tags (SDR Rec.709 / HDR Rec.2020 PQ|HLG)
                   "-movflags", "+faststart" if ext == ".mp4" else "+write_colr",
                   out]
            state["progressPct"] = 10
            r = subprocess.run(cmd, capture_output=True, timeout=3600)
            if r.returncode != 0 or not (os.path.isfile(out) and os.path.getsize(out) > 0):
                raise RuntimeError("ffmpeg review render failed: "
                                   + r.stderr.decode("utf-8", "replace")[-400:])
            state.update({
                "state": "done", "progressPct": 100,
                "result": {
                    "status": "success",
                    "output": out,
                    "odtId": lut_id,
                    "odtStandard": "ACES 2.0",
                    "codec": codec,
                    "colorEngine": "ffmpeg+aces2_lut",
                },
            })
        except Exception as exc:
            state.update({"state": "failed", "error": str(exc)})

    def _render_pull_exr_status(self, request: dict[str, Any]) -> dict[str, Any]:
        job_id = str(request.get("jobId") or "")
        state  = self._ocf_jobs.get(job_id)
        if not state:
            return self._error("NOT_FOUND", f"Job {job_id} not found", "Unknown job ID.")
        return self._ok({
            "state":       state.get("state", "unknown"),
            "progressPct": state.get("progressPct", 0),
            "result":      state.get("result"),
            "error":       state.get("error"),
        })

    def _render_pull_exr_cancel(self, request: dict[str, Any]) -> dict[str, Any]:
        job_id = str(request.get("jobId") or "")
        state  = self._ocf_jobs.get(job_id)
        if state and state.get("state") == "running":
            state["state"] = "cancelled"
        return self._ok({"cancelled": bool(state)})

    def _qc_exr_sequence(self, request: dict[str, Any]) -> dict[str, Any]:
        """QC an exported EXR sequence.

        Checks: frame count, naming pattern, no missing frames, resolution,
        file size plausibility. Reads EXR header via oiiotool if available.
        """
        import os, re
        job        = request.get("job") or {}
        pkg        = job.get("package") or {}
        exr_folder = pkg.get("exr") or job.get("outputDir") or ""
        plate_name = job.get("plateName") or job.get("shotId") or ""
        pattern    = job.get("outputPattern") or ""
        frame_start = int(job.get("frameStart") or 1001)
        exp_frames  = int(job.get("expectedRenderedFrameCount") or job.get("frameCount") or 0)
        fps         = float(job.get("fps") or 24)

        warnings = []
        errors   = []

        if not exr_folder or not os.path.isdir(exr_folder):
            return self._ok({"pass": False, "errors": ["EXR folder not found"], "warnings": []})

        exr_files = sorted(f for f in os.listdir(exr_folder) if f.lower().endswith(".exr"))
        actual_count = len(exr_files)

        # Frame count check
        if exp_frames and actual_count != exp_frames:
            if actual_count == 0:
                errors.append(f"No EXR files found in {exr_folder}")
            elif actual_count < exp_frames:
                errors.append(f"Frame count: {actual_count} found, {exp_frames} expected ({exp_frames - actual_count} missing)")
            else:
                warnings.append(f"Frame count: {actual_count} found, {exp_frames} expected ({actual_count - exp_frames} extra)")

        # Naming check — pattern should be shot_PL##_v###.####.exr
        naming_ok = True
        if plate_name and exr_files:
            bad_names = [f for f in exr_files if not f.startswith(plate_name)]
            if bad_names:
                warnings.append(f"Naming: {len(bad_names)} file(s) don't match plate name '{plate_name}'")
                naming_ok = False

        # Start frame check
        if exr_files:
            # Extract frame number from first file
            first_file = exr_files[0]
            m = re.search(r'\.(\d{4,})\.exr$', first_file, re.I)
            if m:
                detected_start = int(m.group(1))
                if detected_start != frame_start:
                    warnings.append(f"Frame start: {detected_start} found, {frame_start} expected")

        # Sequence continuity (no gaps)
        if exr_files and len(exr_files) > 1:
            nums = []
            for f in exr_files:
                m = re.search(r'\.(\d+)\.exr$', f, re.I)
                if m:
                    nums.append(int(m.group(1)))
            if len(nums) == len(exr_files):
                nums.sort()
                gaps = [(nums[i], nums[i+1]) for i in range(len(nums)-1) if nums[i+1] - nums[i] > 1]
                if gaps:
                    errors.append(f"Missing frames: {len(gaps)} gap(s) detected")

        # AMF check
        amf_file = pkg.get("amfFile", "")
        if amf_file and not os.path.isfile(amf_file):
            warnings.append("AMF sidecar not found — color traceability incomplete")

        # Frame map check
        fm_file = pkg.get("frameMapFile", "")
        if fm_file and not os.path.isfile(fm_file):
            warnings.append("Frame map CSV not found")

        # Resolution check via oiiotool (non-blocking, best effort)
        oiio_resolution = ""
        import shutil
        oiio = shutil.which("oiiotool")
        if oiio and exr_files:
            try:
                import subprocess
                r = subprocess.run(
                    [oiio, "--info", os.path.join(exr_folder, exr_files[0])],
                    capture_output=True, text=True, timeout=15
                )
                if r.returncode == 0:
                    m = re.search(r'(\d+)\s*x\s*(\d+)', r.stdout)
                    if m:
                        oiio_resolution = f"{m.group(1)}x{m.group(2)}"
            except Exception:
                pass

        passed = len(errors) == 0
        return self._ok({
            "pass":       passed,
            "warnings":   warnings,
            "errors":     errors,
            "frameCount": actual_count,
            "firstFrame": frame_start,
            "lastFrame":  frame_start + actual_count - 1 if actual_count else frame_start,
            "resolution": oiio_resolution,
            "namingOk":   naming_ok,
        })

    def _write_pull_sidecars(self, request: dict[str, Any]) -> dict[str, Any]:
        """Write frame map CSV, geometry JSON, and pull report JSON to metadata/ folder."""
        import os, json
        job       = request.get("job") or {}
        qc_result = request.get("qcResult")
        pkg       = job.get("package") or {}
        meta_dir  = pkg.get("metadata", "")

        if not meta_dir:
            return self._error("MISSING_PKG", "job.package.metadata required", "No metadata dir specified.")

        os.makedirs(meta_dir, exist_ok=True)
        written = []
        errors  = []
        sidecars = job.get("sidecars") or {}

        # ── AMF sidecar ───────────────────────────────────────────────────────
        amf_path = pkg.get("amfFile", "")
        amf_xml = sidecars.get("amfXml") or job.get("amfXml") or ""
        if amf_path and amf_xml:
            try:
                os.makedirs(os.path.dirname(amf_path), exist_ok=True)
                with open(amf_path, "w", encoding="utf-8") as fh:
                    fh.write(str(amf_xml))
                    if not str(amf_xml).endswith("\n"):
                        fh.write("\n")
                written.append(amf_path)
            except Exception as exc:
                errors.append(f"amf: {exc}")

        # ── FDL JSON sidecar ──────────────────────────────────────────────────
        fdl_path = pkg.get("fdlFile", "")
        fdl_obj = sidecars.get("fdl") or job.get("fdl")
        if fdl_path and fdl_obj:
            try:
                os.makedirs(os.path.dirname(fdl_path), exist_ok=True)
                with open(fdl_path, "w", encoding="utf-8") as fh:
                    json.dump(fdl_obj, fh, indent=2)
                written.append(fdl_path)
            except Exception as exc:
                errors.append(f"fdl: {exc}")

        # ── Frame map CSV ─────────────────────────────────────────────────────
        fm_path = pkg.get("frameMapFile", "")
        if fm_path:
            try:
                csv_rows = ["timelineFrame,outputFrame,sourceFile,sourceFrame,sourceTC,speed,retimeType"]
                retime     = job.get("retime") or {}
                frame_start = int(job.get("frameStart") or 1001)
                fps         = float(job.get("fps") or 24)
                src_file    = (job.get("sourcePath") or "").split("/")[-1].split("\\")[-1]
                frame_count = int(job.get("expectedRenderedFrameCount") or job.get("frameCount") or 0)

                export_in = job.get("exportIn") or "00:00:00:00"
                p = export_in.replace(";", ":").split(":")
                src_start = (int(p[0])*3600 + int(p[1])*60 + int(p[2])) * fps + int(p[3]) if len(p) >= 4 else 0

                source_frame_map = retime.get("sourceFrameMap")
                source_span = int(job.get("expectedFrameCount") or frame_count or 0)
                for i in range(frame_count):
                    out_f = frame_start + i
                    if isinstance(source_frame_map, list) and i < len(source_frame_map):
                        entry = source_frame_map[i] or {}
                        src_f = int(entry.get("sourceFrame", src_start))
                        speed = entry.get("speed", retime.get("speedPercent") or 100)
                        rtype = entry.get("retimeType", "dynamic" if retime.get("isDynamic") else "mapped")
                    elif retime.get("freeze"):
                        src_f, speed, rtype = int(src_start), 0, "freeze"
                    elif retime.get("reversed"):
                        stride = retime.get("speed") if isinstance(retime.get("speed"), (int, float)) and retime.get("speed") > 0 else 1
                        src_f = int(round(src_start + max(0, source_span - 1) - i * stride))
                        speed = -(retime.get("speedPercent") or 100)
                        rtype = "reverse"
                    elif retime.get("hasSpeedChange") and (retime.get("speed") or 1) > 0:
                        src_f = int(round(src_start + i * (retime.get("speed") or 1)))
                        speed = retime.get("speedPercent") or 100
                        rtype = "dynamic" if retime.get("isDynamic") else "constant"
                    else:
                        src_f = int(src_start + i)
                        speed, rtype = 100, "normal"

                    sf = src_f / fps
                    h, m_, s = int(sf/3600), int((sf%3600)/60), int(sf%60)
                    f_ = round((sf % 1) * fps)
                    tc = f"{h:02d}:{m_:02d}:{s:02d}:{f_:02d}"
                    csv_rows.append(f"{out_f},{out_f},{src_file},{src_f},{tc},{speed},{rtype}")

                with open(fm_path, "w", encoding="utf-8") as fh:
                    fh.write("\n".join(csv_rows))
                written.append(fm_path)
            except Exception as exc:
                errors.append(f"frameMap: {exc}")

        # ── Geometry JSON ─────────────────────────────────────────────────────
        geo_path = pkg.get("geometryFile", "")
        if geo_path:
            try:
                geo = job.get("geometry") or {}
                with open(geo_path, "w", encoding="utf-8") as fh:
                    json.dump({
                        "shotName":           job.get("shotId",   ""),
                        "plateName":          job.get("plateName",""),
                        "sourceResolution":   geo.get("sourceResolution",   ""),
                        "timelineResolution": geo.get("timelineResolution",  ""),
                        "outputResolution":   geo.get("outputResolution",    ""),
                        "scale":              geo.get("scale",     1),
                        "positionX":          geo.get("positionX", 0),
                        "positionY":          geo.get("positionY", 0),
                        "rotation":           geo.get("rotation",  0),
                        "cropL":              geo.get("cropL", 0),
                        "cropR":              geo.get("cropR", 0),
                        "cropT":              geo.get("cropT", 0),
                        "cropB":              geo.get("cropB", 0),
                        "resizeMode":         geo.get("resizeMode", "scale_to_fit"),
                        "bakeMode":           geo.get("bakeMode",  "none"),
                        "matrix":             geo.get("matrix"),
                        "notes":              geo.get("notes", []),
                    }, fh, indent=2)
                written.append(geo_path)
            except Exception as exc:
                errors.append(f"geometry: {exc}")

        # ── Pull report JSON ──────────────────────────────────────────────────
        rpt_path = pkg.get("pullReportFile", "")
        if rpt_path:
            try:
                retime   = job.get("retime")   or {}
                geo      = job.get("geometry")  or {}
                cp       = job.get("colorPlan") or {}
                report = {
                    "schemaVersion": "2.0",
                    "generatedBy":   "PostFlowX",
                    "shotName":      job.get("shotId",    ""),
                    "plateName":     job.get("plateName", ""),
                    "ocfPath":       job.get("sourcePath",""),
                    "sourceIn":      job.get("exportIn",  ""),
                    "sourceOut":     job.get("exportOut", ""),
                    "fps":           job.get("fps", 24),
                    "handles":       job.get("handleFrames", 8),
                    "expectedFrames":job.get("expectedRenderedFrameCount") or job.get("frameCount", 0),
                    "frameStart":    job.get("frameStart", 1001),
                    "pullMode":      job.get("pullMode", ""),
                    "retime": {
                        "hasSpeedChange": retime.get("hasSpeedChange", False),
                        "speed":          retime.get("speedPercent",   100),
                        "type":           "dynamic"  if retime.get("isDynamic") else
                                          "freeze"   if retime.get("freeze")   else
                                          "reverse"  if retime.get("reversed") else "normal",
                        "originalSummary": retime.get("originalSummary", ""),
                    },
                    "geometry": {
                        "hasGeometry": geo.get("hasGeometry", False),
                        "bakeMode":    geo.get("bakeMode",    "none"),
                        "resizeMode":  geo.get("resizeMode",  "scale_to_fit"),
                        "notes":       geo.get("notes",       []),
                    },
                    "colorPlan": {
                        "pullMode":    cp.get("pullMode",   ""),
                        "idtName":     cp.get("idtName",    ""),
                        "applyIDT":    cp.get("applyIDT",   True),
                        "applyLook":   cp.get("applyLook",  False),
                        "applyODT":    cp.get("applyODT",   False),
                        "outputSpace": cp.get("outputSpace","ACES2065-1"),
                        "amfPath":     cp.get("amfPath",    ""),
                        "engineHint":  cp.get("engineHint", ""),
                        "warnings":    cp.get("warnings",   []),
                    },
                    "qtReference": sidecars.get("qtReference") or {},
                    "colorMatch":  (job.get("color") or {}).get("match") or {},
                    "frameMatch":  job.get("reframe") or {},
                    "output": {
                        "folder":    pkg.get("root",         ""),
                        "exrFolder": pkg.get("exr",          ""),
                        "pattern":   job.get("outputPattern",""),
                        "amf":       pkg.get("amfFile",      ""),
                        "frameMap":  pkg.get("frameMapFile", ""),
                        "geometry":  pkg.get("geometryFile", ""),
                    },
                    "matchConfidence": (job.get("metadata") or {}).get("matchConfidence", 0),
                    "matchStatus":     (job.get("metadata") or {}).get("matchStatus",     ""),
                    "qc":              qc_result,
                }
                with open(rpt_path, "w", encoding="utf-8") as fh:
                    json.dump(report, fh, indent=2)
                written.append(rpt_path)
            except Exception as exc:
                errors.append(f"pullReport: {exc}")

        # ── QC JSON ───────────────────────────────────────────────────────────
        qc_path = pkg.get("qcJsonFile", "") or pkg.get("qcFile", "")
        if qc_path and qc_result:
            try:
                with open(qc_path, "w", encoding="utf-8") as fh:
                    json.dump(qc_result, fh, indent=2)
                written.append(qc_path)
            except Exception as exc:
                errors.append(f"qcFile: {exc}")

        return self._ok({"written": written, "errors": errors, "metadataDir": meta_dir})

    def _open_folder(self, request: dict[str, Any]) -> dict[str, Any]:
        """Open a folder in Finder/Explorer."""
        import subprocess, sys, os
        path = str(request.get("path") or "").strip()
        if not path: return self._error("MISSING_PATH", "path required", "No path provided.")
        try:
            if sys.platform == "darwin": subprocess.Popen(["open", path])
            elif sys.platform == "win32": subprocess.Popen(["explorer", path])
            else: subprocess.Popen(["xdg-open", path])
            return self._ok({"ok": True})
        except Exception as exc:
            return self._error("OPEN_FAILED", str(exc), f"Could not open folder: {path}")

    def _resolve_iab_asset(self, package_id: str, cpl_id: str) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
        if not package_id or not cpl_id:
            return None, self._error(
                "BAD_REQUEST",
                "packageId and cplId are required",
                "No IMF package or CPL was selected.",
            )
        package = self.package_registry.get(package_id)
        if not package:
            return None, self._error(
                "NOT_FOUND",
                f"Unknown packageId: {package_id}",
                "The IMF package is no longer loaded in the companion.",
            )
        entry = _find_cpl_entry(package, cpl_id)
        if not entry:
            return None, self._error(
                "NOT_FOUND",
                f"Unknown cplId: {cpl_id}",
                "The selected CPL is no longer available.",
            )
        cpl = entry.get("cpl") or {}
        if not cpl.get("hasIAB"):
            return None, self._error(
                "NO_IAB",
                f"CPL {cpl_id} has no IAB track",
                "This CPL does not include an IAB / Dolby Atmos track.",
            )
        iab_resource = next(iter(cpl.get("iabResources") or []), None)
        if not iab_resource:
            return None, self._error(
                "NO_IAB",
                f"CPL {cpl_id} has no resolved IAB resource",
                "No IAB resource was found in the current CPL.",
            )
        track_id = str(iab_resource.get("trackFileId") or "")
        asset = ((entry.get("pkl") or {}).get("assets") or {}).get(track_id) or {}

        # --- Resolve absolute path ----------------------------------------
        # The snapshot stores only relative paths (file / assetMapPath) — never
        # absolutePath.  Build the absolute path by resolving relative to the
        # package folder, with fallback to sibling folders for VF/supplemental
        # packages whose IAB MXF lives in the OV directory.
        asset_path = str(asset.get("absolutePath") or "").strip()

        if not asset_path:
            folder_str = str(package.get("folderPath") or entry.get("root") or "").strip()
            folder = Path(folder_str).expanduser().resolve() if folder_str else None

            # Build candidate search roots: own folder + sibling UUID folders
            search_roots: list[Path] = []
            if folder and folder.is_dir():
                search_roots.append(folder)
                try:
                    for sib in folder.parent.iterdir():
                        if sib.is_dir() and sib != folder:
                            search_roots.append(sib)
                except Exception:
                    pass

            for root in search_roots:
                for rel_key in ("assetMapPath", "file"):
                    rel = str(asset.get(rel_key) or "").strip()
                    if rel:
                        candidate = (root / rel).expanduser().resolve()
                        if candidate.is_file():
                            asset_path = str(candidate)
                            break
                    # Also try just the basename (handles different subfolder layouts)
                    if rel:
                        basename = Path(rel).name
                        candidate = (root / basename).expanduser().resolve()
                        if candidate.is_file():
                            asset_path = str(candidate)
                            break
                if asset_path:
                    break

            # Last resort: scan folder tree for a file whose stem matches the UUID
            if not asset_path and folder and track_id:
                uid_lc = track_id.lower().replace("-", "")
                for root in search_roots:
                    try:
                        for p in root.rglob("*.mxf"):
                            if uid_lc in p.stem.lower().replace("-", ""):
                                asset_path = str(p)
                                break
                    except Exception:
                        pass
                    if asset_path:
                        break

        if not asset_path:
            return None, self._error(
                "NOT_FOUND",
                "IAB asset path is unavailable",
                "The IAB track file could not be resolved from the package.",
            )
        path = Path(asset_path).expanduser().resolve()
        if not path.is_file():
            return None, self._error(
                "NOT_FOUND",
                f"IAB asset not found: {path}",
                "The IAB track file was not found on disk.",
            )
        return {
            "entry": entry,
            "cpl": cpl,
            "resource": iab_resource,
            "path": path,
        }, None

    # ── DaVinci Resolve sync ──────────────────────────────────────────────────

    @staticmethod
    def _get_resolve_app():
        """Return the DaVinci Resolve scripting app object, or None if unavailable."""
        search_paths = [
            "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules",
            os.path.join(os.environ.get("RESOLVE_SCRIPT_API", ""), "Modules"),
            os.path.join(os.environ.get("HOME", ""), "Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules"),
        ]
        for p in search_paths:
            if p and os.path.isdir(p) and p not in sys.path:
                sys.path.insert(0, p)
        try:
            import DaVinciResolveScript as dvr  # type: ignore[import]
            app = dvr.scriptapp("Resolve")
            return app if app is not None else None
        except Exception:
            return None

    @staticmethod
    def _resolve_clip_metadata(clip: Any, path: str) -> dict[str, Any]:
        """Read one MediaPool clip's identity/timecode properties (Gap 2)."""
        def prop(name: str) -> str:
            try:
                return str(clip.GetClipProperty(name) or "").strip()
            except Exception:
                return ""
        try:
            fps = float(prop("FPS") or 0) or 0.0
        except ValueError:
            fps = 0.0
        tc_in = prop("Start TC")
        frames_raw = prop("Frames") or prop("Duration")
        frame_count = 0
        if frames_raw.isdigit():
            frame_count = int(frames_raw)
        elif frames_raw and fps:
            frame_count = _tc_to_frames(frames_raw, fps)
        tc_out = (
            _frames_to_tc(_tc_to_frames(tc_in, fps) + max(0, frame_count - 1), fps)
            if (tc_in and fps and frame_count) else ""
        )
        return {
            "path":       path,
            "name":       os.path.basename(path),
            "tcIn":       tc_in or None,
            "tcOut":      tc_out or None,
            "fps":        fps or None,
            "frameCount": frame_count or None,
            "reel":       prop("Reel Name") or prop("Scene") or None,
            "camera":     prop("Camera #") or prop("Camera Type") or None,
            "codec":      prop("Video Codec") or None,
            "resolution": prop("Resolution") or None,
            "tcKnown":    bool(tc_in and tc_in != "00:00:00:00"),
            "decoder":    "Resolve",
        }

    def _resolve_probe_clips(self, request: dict[str, Any]) -> dict[str, Any]:
        """Gap 2: read authoritative clip metadata (Start TC / Reel / File Path /
        FPS / duration) from DaVinci Resolve's MediaPool for a list of OCF paths.

        Enriches OCF matching for camera RAW (Sony X-OCN, ARRIRAW, RED…) whose
        container timecode/reel may be unreadable by ffprobe.

        request: { paths: [str] }
        returns: { clips: [...], unresolved: [str], resolveVersion }
        """
        paths = request.get("paths") or request.get("files") or request.get("ocfPaths") or []
        paths = [str(p) for p in paths if str(p or "").strip()]
        if not paths:
            return self._error("BAD_REQUEST", "paths is required",
                               "No OCF file paths were provided to probe.")

        app = self._get_resolve_app()
        if app is None:
            return self._error("RESOLVE_NOT_CONNECTED",
                               "DaVinci Resolve scripting API unavailable.",
                               "Start DaVinci Resolve (Background Auto), then try again.")
        pm = app.GetProjectManager()
        if not pm:
            return self._error("RESOLVE_API_ERROR", "GetProjectManager() returned None",
                               "Resolve API error while probing clips.")

        created_proj = None
        project = pm.GetCurrentProject()
        if not project:
            tmp_name = f"pfx_ocfmeta_{uuid.uuid4().hex[:8]}"
            project = pm.CreateProject(tmp_name)
            created_proj = tmp_name if project else None
        if not project:
            return self._error("RESOLVE_API_ERROR",
                               "No active project and CreateProject failed",
                               "Could not open a Resolve project to read clip metadata.")

        try:
            media_pool = project.GetMediaPool()
            if not media_pool:
                return self._error("RESOLVE_API_ERROR", "GetMediaPool() returned None",
                                   "Resolve API error while probing clips.")
            existing = [p for p in paths if os.path.isfile(p)]
            imported = (media_pool.ImportMedia(existing) if existing else []) or []

            by_base: dict[str, Any] = {}
            for clip in imported:
                try:
                    fp = str(clip.GetClipProperty("File Path") or "")
                except Exception:
                    fp = ""
                base = os.path.basename(fp).lower() if fp else ""
                if not base:
                    try:
                        base = str(clip.GetName() or "").lower()
                    except Exception:
                        base = ""
                if base:
                    by_base[base] = clip

            out_clips: list[dict[str, Any]] = []
            unresolved: list[str] = []
            for p in paths:
                clip = by_base.get(os.path.basename(p).lower())
                if clip is None:
                    unresolved.append(p)
                    continue
                out_clips.append(self._resolve_clip_metadata(clip, p))

            import logging
            logging.getLogger("postflowx.resolve").info(
                "[Resolve ProbeClips] requested=%d resolved=%d unresolved=%d",
                len(paths), len(out_clips), len(unresolved))
            return self._ok({
                "clips": out_clips,
                "unresolved": unresolved,
                "resolveVersion": str(getattr(app, "GetVersion", lambda: "")() or ""),
            })
        finally:
            if created_proj:
                try:
                    pm.DeleteProject(created_proj)
                except Exception:
                    pass

    def _resolve_status(self, _: dict[str, Any]) -> dict[str, Any]:
        app = self._get_resolve_app()
        if app is None:
            return self._ok({"connected": False, "error": "DaVinci Resolve not running or scripting API unavailable"})
        try:
            pm = app.GetProjectManager()
            project = pm.GetCurrentProject() if pm else None
            timeline = project.GetCurrentTimeline() if project else None
            if not timeline:
                return self._ok({"connected": False, "error": "No timeline open in Resolve"})
            fps_str = str(project.GetSetting("timelineFrameRate") or "24")
            try:
                fps = float(fps_str)
            except ValueError:
                fps = 24.0
            start_tc = str(timeline.GetStartTimecode() or "00:00:00:00")
            return self._ok({
                "connected": True,
                "fps": fps,
                "startTimecode": start_tc,
                "projectName": str(project.GetName() or ""),
                "timelineName": str(timeline.GetName() or ""),
            })
        except Exception as exc:
            return self._ok({"connected": False, "error": str(exc)})

    def _resolve_get_markers(self, _: dict[str, Any]) -> dict[str, Any]:
        app = self._get_resolve_app()
        if app is None:
            return self._error("RESOLVE_OFFLINE", "DaVinci Resolve not running", "Start DaVinci Resolve and open a project.")
        try:
            pm = app.GetProjectManager()
            project = pm.GetCurrentProject() if pm else None
            timeline = project.GetCurrentTimeline() if project else None
            if not timeline:
                return self._error("NO_TIMELINE", "No timeline open", "Open a timeline in DaVinci Resolve.")
            raw = timeline.GetMarkers() or {}
            markers = []
            for frame_id, info in raw.items():
                custom = str(info.get("customData") or "")
                pfx_id = None
                # PFX markers encode their UUID in customData as "pfxId=<uuid>"
                if custom.startswith("pfxId="):
                    pfx_id = custom[len("pfxId="):]
                markers.append({
                    "frameId": int(frame_id),
                    "color": str(info.get("color") or "Blue"),
                    "name": str(info.get("name") or ""),
                    "note": str(info.get("note") or ""),
                    "duration": int(info.get("duration") or 1),
                    "customData": custom,
                    "pfxId": pfx_id,
                })
            return self._ok({"markers": markers})
        except Exception as exc:
            return self._error("RESOLVE_ERROR", str(exc), "Failed to read markers from Resolve.")

    def _resolve_push_markers(self, request: dict[str, Any]) -> dict[str, Any]:
        app = self._get_resolve_app()
        if app is None:
            return self._error("RESOLVE_OFFLINE", "DaVinci Resolve not running", "Start DaVinci Resolve and open a project.")
        try:
            pm = app.GetProjectManager()
            project = pm.GetCurrentProject() if pm else None
            timeline = project.GetCurrentTimeline() if project else None
            if not timeline:
                return self._error("NO_TIMELINE", "No timeline open", "Open a timeline in DaVinci Resolve.")

            fps_str = str(project.GetSetting("timelineFrameRate") or "24")
            try:
                fps = float(fps_str)
            except ValueError:
                fps = 24.0

            start_tc = str(timeline.GetStartTimecode() or "00:00:00:00")
            start_frames = _tc_to_frames(start_tc, fps)

            replace_all = bool(request.get("replaceAll", False))
            pfx_markers = list(request.get("markers") or [])

            if replace_all:
                # Remove only PFX-tagged markers (leave native Resolve markers intact)
                existing = timeline.GetMarkers() or {}
                for frame_id, info in existing.items():
                    custom = str(info.get("customData") or "")
                    if custom.startswith("pfxId="):
                        timeline.DeleteMarkerAtFrame(int(frame_id))

            added = 0
            skipped = 0
            # Map Resolve color names (must match Resolve's accepted palette)
            valid_colors = {
                "Blue", "Cyan", "Green", "Yellow", "Red", "Pink",
                "Purple", "Fuchsia", "Rose", "Lavender", "Sky",
                "Mint", "Lemon", "Sand", "Cocoa", "Cream",
            }
            color_remap = {
                "Magenta": "Fuchsia",
                "Orange": "Sand",
                "White": "Cream",
                "Black": "Cocoa",
            }

            for mk in pfx_markers:
                rec_in = str(mk.get("recIn") or mk.get("tcIn") or "")
                if not rec_in:
                    skipped += 1
                    continue
                frame_abs = _tc_to_frames(rec_in, fps)
                # Convert absolute timeline TC to frame offset from timeline start
                frame_id = frame_abs - start_frames
                if frame_id < 0:
                    skipped += 1
                    continue

                color = str(mk.get("color") or "Blue")
                color = color_remap.get(color, color)
                if color not in valid_colors:
                    color = "Blue"

                shot = str(mk.get("shotName") or "")
                note_parts = []
                if mk.get("scopeOfWork"):
                    note_parts.append(str(mk["scopeOfWork"]))
                if mk.get("note"):
                    note_parts.append(str(mk["note"]))
                note = " | ".join(note_parts)

                mk_id = str(mk.get("id") or "")
                custom_data = f"pfxId={mk_id}" if mk_id else ""

                # Calculate duration in frames from recIn→recOut
                rec_out = str(mk.get("recOut") or mk.get("tcOut") or "")
                duration = 1
                if rec_out:
                    out_abs = _tc_to_frames(rec_out, fps)
                    dur_calc = out_abs - frame_abs
                    if dur_calc > 1:
                        duration = dur_calc

                ok = timeline.AddMarker(frame_id, color, shot, note, duration, custom_data)
                if ok:
                    added += 1
                else:
                    skipped += 1

            return self._ok({"added": added, "skipped": skipped})
        except Exception as exc:
            return self._error("RESOLVE_ERROR", str(exc), "Failed to push markers to Resolve.")

    def _resolve_get_timeline(self, _: dict[str, Any]) -> dict[str, Any]:
        """Read the current Resolve timeline and return events in PostFlowX event shape.

        Response data:
            fps, colorScience, timelineName, projectName,
            events: [{eventNumber, reel, clipName, srcIn, srcOut, recIn, recOut,
                      fps, durationFrames, speedFactor, sourcePath, _fromResolve}],
            markers: [{frameId, color, name, note, duration, recIn, recOut, pfxId}]
        """
        app = self._get_resolve_app()
        if app is None:
            return self._error("RESOLVE_OFFLINE", "DaVinci Resolve not running",
                               "Start DaVinci Resolve and open a project.")
        try:
            pm      = app.GetProjectManager()
            project = pm.GetCurrentProject() if pm else None
            timeline = project.GetCurrentTimeline() if project else None
            if not timeline:
                return self._error("NO_TIMELINE", "No timeline open",
                                   "Open a timeline in DaVinci Resolve.")

            fps_str = str(project.GetSetting("timelineFrameRate") or "24")
            try:
                fps = float(fps_str)
            except ValueError:
                fps = 24.0

            # Resolve sometimes returns fractional fps strings like "23.976"
            color_science = str(project.GetSetting("colorScienceMode") or "davinciYRGB")
            timeline_name = str(timeline.GetName() or "")
            project_name  = str(project.GetName() or "")
            start_tc      = str(timeline.GetStartTimecode() or "00:00:00:00")
            start_frames  = _tc_to_frames(start_tc, fps)

            # ── Read timeline clips (all video tracks) ────────────────────────
            events: list[dict[str, Any]] = []
            track_count = int(timeline.GetTrackCount("video") or 1)
            event_idx = 1
            # Deduplicate across tracks: the same source file can appear on V1
            # (editorial) and also on V2/V3 as a composite or grade reference.
            # VFX pull only needs one event per unique source position. V1 is
            # processed first so the lowest-track version always wins.
            _seen_source_pos: set[tuple[str, str]] = set()

            for track_num in range(1, track_count + 1):
                items = timeline.GetItemListInTrack("video", track_num) or []
                for item in items:
                    try:
                        rec_in_f  = int(item.GetStart() or 0)
                        rec_out_f = int(item.GetEnd()   or 0)
                        duration  = int(item.GetDuration() or max(0, rec_out_f - rec_in_f))
                        left_off  = int(item.GetLeftOffset() or 0)

                        # Record timecodes (absolute timeline position)
                        rec_in_tc  = _frames_to_tc(rec_in_f,  fps)
                        rec_out_tc = _frames_to_tc(rec_out_f, fps)

                        # Source timecodes from media pool item
                        media = None
                        try:
                            media = item.GetMediaPoolItem()
                        except Exception:
                            pass

                        media_start_tc   = "00:00:00:00"
                        reel             = ""
                        clip_name        = ""
                        source_path      = ""
                        camera_model     = ""
                        if media:
                            try:
                                media_start_tc = str(media.GetClipProperty("Start TC") or "00:00:00:00")
                                reel           = str(media.GetClipProperty("Reel Name") or
                                                     media.GetClipProperty("Scene")    or "")
                                clip_name      = str(media.GetName() or "")
                                # "File Path" may not be populated if the clip is offline;
                                # fall through to empty string gracefully.
                                source_path    = str(media.GetClipProperty("File Path") or "")
                                camera_model   = str(media.GetClipProperty("Camera #")  or
                                                     media.GetClipProperty("Camera Type") or "")
                            except Exception:
                                pass

                        media_start_f = _tc_to_frames(media_start_tc, fps)
                        src_in_f  = media_start_f + left_off
                        # Preliminary src_out (corrected below once speed is known)
                        src_out_f = src_in_f + duration
                        src_in_tc = _frames_to_tc(src_in_f, fps)

                        # Offline detection: media item exists but has no file path
                        # (Resolve marks the clip as offline / missing media).
                        is_offline = media is not None and not source_path

                        # Speed — Resolve returns it as a percentage (100 = 1×).
                        # When a clip has a dynamic (keyframed) ramp, Resolve returns 0
                        # rather than a constant percentage. We must check for None/empty
                        # before defaulting to 100 to avoid masking these ramps.
                        speed_pct        = 100.0
                        speed_factor     = 1.0
                        has_speed        = False
                        is_dynamic_speed = False
                        try:
                            raw_speed = item.GetClipProperty("Speed")
                            if raw_speed is not None:
                                raw_str = str(raw_speed).strip()
                                if raw_str not in ("", "None", "none"):
                                    parsed = float(raw_str)
                                    if parsed == 0.0 and duration > 0:
                                        # Resolve signals variable-speed ramp as 0%.
                                        is_dynamic_speed = True
                                        has_speed = True
                                    else:
                                        speed_pct    = parsed
                                        speed_factor = parsed / 100.0
                                        has_speed    = abs(speed_factor - 1.0) > 0.005
                        except Exception:
                            pass

                        # Correct src_out for constant-speed ramps.
                        # src_out_f = src_in_f + duration covers record frames,
                        # not source frames. For 50% slow-mo, 24 record frames
                        # consume 48 source frames. Dynamic ramps have no closed-
                        # form src_out — leave the record-duration approximation.
                        if has_speed and not is_dynamic_speed and speed_factor > 0.01:
                            src_out_f = src_in_f + int(round(duration / speed_factor))
                        src_out_tc = _frames_to_tc(src_out_f, fps)

                        # Clip spatial transform (pan / tilt / zoom / rotation).
                        # Only included when the clip has a non-identity transform so
                        # the reframe step can factor in NLE repositions.
                        transform = None
                        try:
                            pan    = float(item.GetProperty("Pan")           or 0.0)
                            tilt   = float(item.GetProperty("Tilt")          or 0.0)
                            zoom_x = float(item.GetProperty("ZoomX")         or 1.0)
                            zoom_y = float(item.GetProperty("ZoomY")         or 1.0)
                            rot    = float(item.GetProperty("RotationAngle") or 0.0)
                            if (abs(pan) > 0.5 or abs(tilt) > 0.5 or
                                    abs(zoom_x - 1.0) > 0.01 or abs(zoom_y - 1.0) > 0.01 or
                                    abs(rot) > 0.1):
                                transform = {
                                    "pan": pan, "tilt": tilt,
                                    "zoomX": zoom_x, "zoomY": zoom_y,
                                    "rotation": rot,
                                }
                        except Exception:
                            pass

                        # Deduplication: skip if this exact source position was
                        # already captured from a lower-numbered (higher-priority) track.
                        dedup_key = (source_path or clip_name, src_in_tc)
                        if dedup_key in _seen_source_pos:
                            continue
                        _seen_source_pos.add(dedup_key)

                        events.append({
                            "eventNumber":    event_idx,
                            "reel":           reel,
                            "clipName":       clip_name,
                            "srcIn":          src_in_tc,
                            "srcOut":         src_out_tc,
                            "recIn":          rec_in_tc,
                            "recOut":         rec_out_tc,
                            "fps":            fps,
                            "durationFrames": duration,
                            "speedFactor":    speed_factor if has_speed and not is_dynamic_speed else None,
                            "speedPercent":   speed_pct   if has_speed and not is_dynamic_speed else None,
                            "isDynamicSpeed": True if is_dynamic_speed else None,
                            "transform":      transform,
                            "isOffline":      True if is_offline else None,
                            "cameraModel":    camera_model,
                            "sourcePath":     source_path,
                            "_fromResolve":   True,
                            "_trackNum":      track_num,
                        })
                        event_idx += 1
                    except Exception:
                        continue

            # ── Read markers (VFX = Blue or pfxId-tagged) ─────────────────────
            raw_markers = timeline.GetMarkers() or {}
            markers: list[dict[str, Any]] = []
            for frame_offset, info in raw_markers.items():
                custom = str(info.get("customData") or "")
                color  = str(info.get("color") or "")
                # Include VFX (Blue) markers and any PostFlowX-tagged markers.
                if color == "Blue" or custom.startswith("pfxId="):
                    abs_frame  = start_frames + int(frame_offset)
                    dur_frames = int(info.get("duration") or 1)
                    markers.append({
                        "frameId":  abs_frame,
                        "color":    color,
                        "name":     str(info.get("name") or ""),
                        "note":     str(info.get("note") or ""),
                        "duration": dur_frames,
                        "recIn":    _frames_to_tc(abs_frame, fps),
                        "recOut":   _frames_to_tc(abs_frame + dur_frames, fps),
                        "pfxId":    custom[len("pfxId="):] if custom.startswith("pfxId=") else None,
                        "customData": custom,
                    })

            return self._ok({
                "fps":           fps,
                "colorScience":  color_science,
                "timelineName":  timeline_name,
                "projectName":   project_name,
                "startTimecode": start_tc,
                "trackCount":    track_count,
                "events":        events,
                "markers":       markers,
            })
        except Exception as exc:
            return self._error("RESOLVE_ERROR", str(exc), "Failed to read timeline from Resolve.")

    def _resolve_reconnect_ocf(self, request: dict[str, Any]) -> dict[str, Any]:
        """Relink matched OCF files in the Resolve media pool.

        Request: { matches: [{clipName, srcIn, newPath, mediaItemPath}] }
        Response: { relinked: [clipName, ...], failed: [{clipName, reason}, ...] }

        Uses MediaPoolItem.ReplaceClip() (Resolve 18+). Falls back to
        MediaPool.RelinkClips() for each item when ReplaceClip is unavailable.
        """
        matches = list(request.get("matches") or [])
        if not matches:
            return self._ok({"relinked": [], "failed": []})

        app = self._get_resolve_app()
        if app is None:
            return self._error("RESOLVE_OFFLINE", "DaVinci Resolve not running",
                               "Start DaVinci Resolve and open a project.")
        try:
            pm      = app.GetProjectManager()
            project = pm.GetCurrentProject() if pm else None
            if not project:
                return self._error("NO_PROJECT", "No project open in Resolve.",
                                   "Open a project in DaVinci Resolve.")
            media_pool  = project.GetMediaPool()
            root_folder = media_pool.GetRootFolder()

            # ── Build a flat index of all MediaPoolItems ──────────────────────
            # Key by both canonical file path and clip name for flexible lookup.
            def _collect_items(folder: Any) -> dict[str, Any]:
                index: dict[str, Any] = {}
                try:
                    for item in (folder.GetClipList() or []):
                        try:
                            path = str(item.GetClipProperty("File Path") or "")
                            name = str(item.GetName() or "")
                            if path:
                                index[path] = item
                            if name:
                                index.setdefault(name, item)
                        except Exception:
                            pass
                    for sub in (folder.GetSubFolderList() or []):
                        index.update(_collect_items(sub))
                except Exception:
                    pass
                return index

            items_index = _collect_items(root_folder)

            relinked: list[str] = []
            failed:   list[dict[str, Any]] = []

            for match in matches:
                new_path   = str(match.get("newPath") or "")
                old_path   = str(match.get("mediaItemPath") or match.get("sourcePath") or "")
                clip_name  = str(match.get("clipName") or "")

                if not new_path:
                    failed.append({"clipName": clip_name, "reason": "newPath missing"})
                    continue

                # Prefer lookup by original path; fall back to clip name.
                media_item = items_index.get(old_path) or items_index.get(clip_name)
                if media_item is None:
                    failed.append({"clipName": clip_name, "reason": "MediaPoolItem not found"})
                    continue

                # Try ReplaceClip (Resolve 18+), fall back to RelinkClips.
                try:
                    ok = media_item.ReplaceClip(new_path)
                    if ok:
                        relinked.append(clip_name)
                    else:
                        # RelinkClips fallback — needs the folder, not a specific file.
                        import os as _os
                        folder_path = str(_os.path.dirname(new_path))
                        rl_ok = media_pool.RelinkClips([media_item], folder_path)
                        if rl_ok:
                            relinked.append(clip_name)
                        else:
                            failed.append({"clipName": clip_name, "reason": "ReplaceClip and RelinkClips both returned False"})
                except AttributeError:
                    # ReplaceClip not available in this Resolve version — use RelinkClips.
                    import os as _os
                    folder_path = str(_os.path.dirname(new_path))
                    try:
                        rl_ok = media_pool.RelinkClips([media_item], folder_path)
                        if rl_ok:
                            relinked.append(clip_name)
                        else:
                            failed.append({"clipName": clip_name, "reason": "RelinkClips returned False"})
                    except Exception as exc2:
                        failed.append({"clipName": clip_name, "reason": str(exc2)})
                except Exception as exc:
                    failed.append({"clipName": clip_name, "reason": str(exc)})

            return self._ok({"relinked": relinked, "failed": failed})
        except Exception as exc:
            return self._error("RESOLVE_ERROR", str(exc), "Failed to reconnect OCF in Resolve.")

    def _resolve_validate_paths(self, request: dict[str, Any]) -> dict[str, Any]:
        """Check whether a list of file-system paths exist on this machine.

        Does not require Resolve to be running — pure filesystem stat.
        Request:  { paths: ["/path/to/file", ...] }
        Response: { results: [{path, exists}, ...] }
        """
        paths = list(request.get("paths") or [])
        results = [{"path": p, "exists": os.path.exists(p)} for p in paths if isinstance(p, str)]
        return self._ok({"results": results})

    def _resolve_mark_vfx_shots(self, request: dict[str, Any]) -> dict[str, Any]:
        """Push colour-coded VFX pull status markers back into the Resolve timeline.

        Clears any existing pfxPull= markers before writing so repeated analysis
        runs stay clean. Marker colour mapping:
          SAFE              → Green
          REVIEW_NEEDED     → Yellow
          NOT_RECOMMENDED   → Yellow
          MISSING           → Red

        Request: { shots: [{recIn, recOut, status, confidence, shotName}] }
        Response: { added: N, skipped: N, cleared: N }
        """
        shots = list(request.get("shots") or [])
        if not shots:
            return self._ok({"added": 0, "skipped": 0, "cleared": 0})

        app = self._get_resolve_app()
        if app is None:
            return self._error("RESOLVE_OFFLINE", "DaVinci Resolve not running",
                               "Start DaVinci Resolve and open a project.")
        try:
            pm      = app.GetProjectManager()
            project = pm.GetCurrentProject() if pm else None
            timeline = project.GetCurrentTimeline() if project else None
            if not timeline:
                return self._error("NO_TIMELINE", "No timeline open",
                                   "Open a timeline in DaVinci Resolve.")

            fps_str = str(project.GetSetting("timelineFrameRate") or "24")
            try:
                fps = float(fps_str)
            except ValueError:
                fps = 24.0

            start_tc = str(timeline.GetStartTimecode() or "00:00:00:00")
            start_frames = _tc_to_frames(start_tc, fps)

            # Clear existing pfxPull= markers only (leave editorial markers intact).
            cleared = 0
            existing = timeline.GetMarkers() or {}
            for frame_id, info in existing.items():
                custom = str(info.get("customData") or "")
                if custom.startswith("pfxPull="):
                    timeline.DeleteMarkerAtFrame(int(frame_id))
                    cleared += 1

            _STATUS_COLOR = {
                "SAFE":             "Green",
                "REVIEW_NEEDED":    "Yellow",
                "NOT_RECOMMENDED":  "Yellow",
                "MISSING":          "Red",
            }

            added   = 0
            skipped = 0

            for shot in shots:
                rec_in = str(shot.get("recIn") or "")
                if not rec_in:
                    skipped += 1
                    continue

                frame_abs = _tc_to_frames(rec_in, fps)
                frame_id  = frame_abs - start_frames
                if frame_id < 0:
                    skipped += 1
                    continue

                status_raw = str(shot.get("status") or "MISSING").upper()
                color      = _STATUS_COLOR.get(status_raw, "Red")

                shot_name   = str(shot.get("shotName") or "")
                confidence  = shot.get("confidence")
                note = f"VFX Pull: {status_raw}"
                if confidence is not None:
                    note += f" ({int(round(float(confidence)))}%)"

                rec_out = str(shot.get("recOut") or "")
                duration = 1
                if rec_out:
                    out_abs  = _tc_to_frames(rec_out, fps)
                    dur_calc = out_abs - frame_abs
                    if dur_calc > 1:
                        duration = dur_calc

                custom_data = f"pfxPull={status_raw}"
                ok = timeline.AddMarker(frame_id, color, shot_name, note, duration, custom_data)
                if ok:
                    added += 1
                else:
                    skipped += 1

            return self._ok({"added": added, "skipped": skipped, "cleared": cleared})
        except Exception as exc:
            return self._error("RESOLVE_ERROR", str(exc), "Failed to mark VFX shots in Resolve.")

    # ── Resolve Background Engine handlers ────────────────────────────────────

    def _resolve_detect_engine(self, _: dict[str, Any]) -> dict[str, Any]:
        """Detect DaVinci Resolve installation and scripting capability."""
        try:
            info = detect_resolve()
            return self._ok(info)
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Detection failed.")

    def _resolve_test_engine(self, request: dict[str, Any]) -> dict[str, Any]:
        """Test live scripting connection to a running Resolve instance."""
        resolve_path = str(request.get("resolvePath") or "")
        try:
            result = test_resolve_connection(resolve_path=resolve_path, timeout_seconds=60)
            return self._ok(result)
        except Exception as exc:
            return self._ok({
                "connected": False,
                "apiAvailable": False,
                "resolvePath": resolve_path,
                "error": str(exc),
                "message": str(exc),
                "logs": [],
                "warnings": [],
            })

    def _resolve_engine_status(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return lifecycle + queue status for Settings > Resolve Engine."""
        resolve_path = str(
            request.get("resolvePath")
            or request.get("resolveExecutablePath")
            or request.get("path")
            or ""
        )
        try:
            return self._ok(resolve_engine_status(resolve_path))
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Could not read Resolve Engine status.")

    def _resolve_start_engine(self, request: dict[str, Any]) -> dict[str, Any]:
        """Start or attach to the local Resolve Engine."""
        resolve_path = str(
            request.get("resolvePath")
            or request.get("resolveExecutablePath")
            or request.get("path")
            or ""
        )
        launch_policy = str(request.get("launchPolicy") or request.get("policy") or "manual")
        run_mode = str(request.get("runMode") or request.get("mode") or "headless")
        try:
            timeout_seconds = int(request.get("timeoutSeconds") or request.get("timeout") or 60)
        except Exception:
            timeout_seconds = 60
        try:
            data = start_resolve_engine(
                resolve_path=resolve_path,
                launch_policy=launch_policy,
                run_mode=run_mode,
                timeout_seconds=timeout_seconds,
            )
            # Return warnings as status ok so the UI can display the exact
            # engine state instead of collapsing to generic Native Host error.
            return self._ok(data)
        except Exception as exc:
            return self._error("RESOLVE_ENGINE_START_FAILED", str(exc), "Could not start Resolve Engine.")

    def _resolve_start_background(self, request: dict[str, Any]) -> dict[str, Any]:
        """Launch Resolve HIDDEN in the background and return IMMEDIATELY. The JS
        caller (_pmEnsureResolveConnected) polls for the connection itself, so we
        must NOT block here — delegating to _resolve_start_engine waits up to 60s
        and times out the companion call ("Companion error"). `open -gj` =
        don't-foreground + launch-hidden; Resolve has no headless mode but this
        avoids stealing focus."""
        import os, subprocess
        app = "/Applications/DaVinci Resolve/DaVinci Resolve.app"
        try:
            if not os.path.isdir(app):
                return self._ok({"ok": False, "installed": False, "launched": False, "state": "not_installed"})
            if self._get_resolve_app() is not None:
                return self._ok({"ok": True, "running": True, "launched": False, "state": "connected"})
            subprocess.Popen(["open", "-gj", app])   # non-blocking, hidden
            return self._ok({"ok": True, "installed": True, "launched": True, "state": "launching"})
        except Exception as exc:
            return self._error("RESOLVE_START_FAILED", str(exc), "Could not launch Resolve.")

    def _resolve_stop_engine(self, request: dict[str, Any]) -> dict[str, Any]:
        """Stop a companion-owned Resolve background process, if any."""
        force = bool(request.get("force") or False)
        try:
            return self._ok(stop_resolve_engine(force=force))
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Could not stop Resolve Engine.")

    def _resolve_run_job_engine(self, request: dict[str, Any]) -> dict[str, Any]:
        """Start a Resolve background job. Returns jobId immediately; poll resolveJobStatus."""
        job = request.get("job")
        if not isinstance(job, dict):
            return self._error("BAD_REQUEST", "Missing 'job' object in request.", "Invalid request.")
        resolve_path = str(request.get("resolvePath") or "")
        timeout_seconds = int(request.get("timeoutSeconds") or 300)
        debug = bool(request.get("debug") or False)
        try:
            session_id = start_resolve_job(job, resolve_path, timeout_seconds, debug)
            session = get_session(session_id) or {}
            return self._ok({
                "jobId": session_id,
                "status": "queued",
                "resultPath": session.get("resultPath") or "",
                "logs": [],
                "warnings": [],
            })
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Could not start Resolve job.")

    def _resolve_cancel_job_engine(self, request: dict[str, Any]) -> dict[str, Any]:
        """Request cancellation of a running Resolve job."""
        job_id = str(request.get("jobId") or "")
        if not job_id:
            return self._error("BAD_REQUEST", "Missing jobId.", "Provide a jobId to cancel.")
        try:
            cancelled = cancel_resolve_job(job_id)
            return self._ok({"cancelled": cancelled, "jobId": job_id})
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Could not cancel job.")

    def _resolve_job_status_engine(self, request: dict[str, Any]) -> dict[str, Any]:
        """Poll the status of a Resolve background job."""
        job_id = str(request.get("jobId") or "")
        if not job_id:
            return self._error("BAD_REQUEST", "Missing jobId.", "Provide a jobId to check.")
        session = get_session(job_id)
        if session is None:
            return self._error("JOB_NOT_FOUND", f"No job with id {job_id!r}.", "Job not found or already cleaned up.")
        state = dict(session)
        result = state.pop("_resolve_result", None)
        if result is None:
            result = state.pop("_result", None)
        cancel_requested = bool(state.pop("_cancel", False))
        response: dict[str, Any] = {
            "jobId": job_id,
            "step": state.get("step", "unknown"),
            "percent": state.get("pct", state.get("percent", 0)),
            "pct": state.get("pct", state.get("percent", 0)),
            "message": state.get("message", ""),
            "cancelRequested": cancel_requested,
            "resultPath": state.get("resultPath") or "",
        }
        if result is not None:
            response["done"] = True
            response["result"] = result
        else:
            response["done"] = False
        return self._ok(response)

    def _resolve_list_jobs_engine(self, request: dict[str, Any]) -> dict[str, Any]:
        """List Resolve jobs known by this companion process."""
        try:
            return self._ok(list_resolve_jobs())
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Could not list Resolve jobs.")

    def _resolve_clear_queue_engine(self, request: dict[str, Any]) -> dict[str, Any]:
        """Clear queued/completed Resolve jobs while preserving active work."""
        include_completed = bool(request.get("includeCompleted", True))
        try:
            return self._ok(clear_resolve_queue(include_completed=include_completed))
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Could not clear Resolve queue.")

    def _resolve_get_logs_engine(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return Resolve Engine logs and path. UI can display or reveal the folder."""
        try:
            max_lines = int(request.get("maxLines") or 200)
        except Exception:
            max_lines = 200
        try:
            data = get_resolve_engine_logs(max_lines=max_lines)
            action = str(request.get("action") or "")
            if action in {"resolveOpenLogs", "resolve.openLogs"} or bool(request.get("open") or request.get("reveal")):
                try:
                    folder = str(Path(data.get("logPath") or "").parent)
                    if platform.system() == "Darwin":
                        subprocess.Popen(["open", folder])
                    elif platform.system() == "Windows":
                        subprocess.Popen(["explorer", folder])
                    else:
                        subprocess.Popen(["xdg-open", folder])
                    data["opened"] = True
                except Exception as open_exc:
                    data["opened"] = False
                    data["openError"] = str(open_exc)
            return self._ok(data)
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Could not read Resolve Engine logs.")

    def _resolve_manual_handoff_engine(self, request: dict[str, Any]) -> dict[str, Any]:
        """Create a manual handoff package for a job that could not run automatically."""
        from .engines.resolve_engine import create_manual_handoff
        job = request.get("job")
        if not isinstance(job, dict):
            return self._error("BAD_REQUEST", "Missing 'job' object.", "Invalid request.")
        output_dir = str(request.get("outputDir") or "")
        if not output_dir:
            return self._error("BAD_REQUEST", "Missing 'outputDir'.", "Provide an output directory.")
        try:
            package_path = create_manual_handoff(job, output_dir)
            return self._ok({"packageDir": package_path})
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Could not create handoff package.")

    # ── IMF frame thumbnail ───────────────────────────────────────────────────

    def _get_imf_frame_thumb(self, request: dict[str, Any]) -> dict[str, Any]:
        """Extract a JPEG frame thumbnail from an IMF package video reel.

        Uses ffmpeg to seek to the requested frame in the first resolvable
        video MXF and return a base64 data URL.  Intended for companion-mode
        preview when the browser has no direct file access.
        """
        import base64
        import tempfile
        package_id   = str(request.get("packageId") or "").strip()
        cpl_id       = str(request.get("cplId") or "").strip()
        frame_num    = int(request.get("frame") or 0)
        width        = int(request.get("width") or 854)
        height       = int(request.get("height") or 480)
        preview_mode = str(request.get("previewMode") or "sdr").lower().strip()

        if not package_id or not cpl_id:
            return self._error("BAD_REQUEST", "Missing packageId or cplId.", "")

        package = self.package_registry.get(package_id)
        if not package:
            return self._error("NOT_FOUND", f"Unknown packageId: {package_id}", "")
        cpl_info = (package.get("cpls") or {}).get(cpl_id)
        if not cpl_info:
            return self._error("NOT_FOUND", f"Unknown cplId: {cpl_id}", "")

        folder_path = str(package.get("folderPath") or "")
        cpl_path    = str(cpl_info.get("absolutePath") or "")
        if not folder_path or not cpl_path:
            return self._error("BAD_REQUEST", "Package has no folder or CPL path.", "")

        folder  = Path(folder_path).expanduser().resolve()
        cpl     = Path(cpl_path).expanduser().resolve()

        from .proxy_service import (
            _build_cpl_segment_inputs, _find_ffmpeg, _find_ffprobe,
            _parse_cpl_video_segments,
        )
        ffmpeg_path  = _find_ffmpeg()
        ffprobe_path = _find_ffprobe(ffmpeg_path)
        if not ffmpeg_path:
            return self._error("FFMPEG_MISSING", "ffmpeg not found.", "")

        try:
            # Resolve segment inputs (uses sibling-folder ASSETMAP lookup for VFs)
            inputs, note = _build_cpl_segment_inputs(cpl, folder)
            if not inputs:
                return self._error("NO_VIDEO_MXF_FOUND", note or "No video MXF.", "")

            # Figure out edit rate for timecode calculation
            segs = _parse_cpl_video_segments(cpl)
            fps  = float(segs[0].get("rate") or 24) if segs else 24.0

            # Find which input contains the requested frame and compute time offset
            frames_so_far = 0
            target_input  = inputs[0]
            target_offset = 0.0
            for inp in inputs:
                seg_dur_frames = int(inp.get("duration", 0) * fps)
                if frames_so_far + seg_dur_frames > frame_num or inp is inputs[-1]:
                    local_frame = max(0, frame_num - frames_so_far)
                    target_offset = float(inp.get("inpoint") or 0.0) + local_frame / max(1.0, fps)
                    target_input  = inp
                    break
                frames_so_far += seg_dur_frames

            with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as tmp:
                tmp_path = tmp.name

            # Detect HDR/PQ content for tone mapping.
            # The cpl_info dict from the package registry may not always carry a "transfer"
            # field (depends on scan depth), so also check the isDolbyVision flag — DV is
            # always ST.2084 PQ and always needs tone mapping.
            cpl_info_data = cpl_info or {}
            _transfer = str(cpl_info_data.get("transfer") or cpl_info_data.get("colorTransfer") or "").upper()
            _is_dv  = bool(cpl_info_data.get("isDolbyVision"))
            _is_pq  = _is_dv or "2084" in _transfer or "PQ" in _transfer or "HDR" in _transfer

            # Build colour management filter chain for PQ/HDR content.
            # zscale + tonemap: proper PQ→Rec.709 conversion matching browser render worker.
            #   SDR  → Hable tone map, reference white 203 nits → ~80% SDR  (standard deliverable view)
            #   HDR  → linear boost: 203-nit diffuse white → ~70% SDR, preserves highlight structure
            #   TRIM → same as SDR (L8 trim is applied client-side; companion has no per-shot data)
            if _is_pq:
                if preview_mode == "full":   # HDR boost
                    _cm = (
                        "zscale=t=linear:npl=203:m=bt2020nc:p=bt2020,"
                        "format=gbrpf32le,"
                        "zscale=p=bt709:t=linear:m=bt709,"
                        "tonemap=linear:param=4.43:desat=0,"
                        "zscale=t=bt709,"
                    )
                else:                        # SDR (default) and TRIM
                    _cm = (
                        "zscale=t=linear:npl=100:m=bt2020nc:p=bt2020,"
                        "format=gbrpf32le,"
                        "zscale=p=bt709:t=linear:m=bt709,"
                        "tonemap=hable:desat=0,"
                        "zscale=t=bt709,"
                    )
            else:
                _cm = ""  # SDR content — no conversion needed

            scale_filter = (
                f"{_cm}"
                f"scale='min({width},iw)':'min({height},ih)':force_original_aspect_ratio=decrease,"
                f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=#080810,"
                f"format=yuv420p"
            )
            mxf_path_str = str(target_input["path"])

            # Fast path: input-side seek — works well for J2K/HTJ2K (all-intra).
            # -fflags +genpts fixes MXF timestamp gaps; -lowres 3 decodes at 1/8
            # resolution for a much faster thumbnail on large 4K J2K files.
            def _run_thumb(extra_input_flags: list[str], extra_decode_flags: list[str]) -> "subprocess.CompletedProcess[bytes]":
                return subprocess.run([
                    ffmpeg_path, "-y",
                    *extra_input_flags,
                    "-ss", f"{target_offset:.3f}",
                    "-i", mxf_path_str,
                    *extra_decode_flags,
                    "-frames:v", "1",
                    "-vf", scale_filter,
                    "-q:v", "3",
                    tmp_path,
                ], capture_output=True, timeout=30)

            # 1st attempt: fast lowres decode
            result = _run_thumb(
                ["-fflags", "+genpts+discardcorrupt"],
                ["-lowres", "3"],
            )
            # 2nd attempt: full-res if lowres unsupported by this ffmpeg build
            if result.returncode != 0:
                result = _run_thumb(
                    ["-fflags", "+genpts+discardcorrupt"],
                    [],
                )
            # 3rd attempt: output-side seek (accurate, slower — last resort)
            if result.returncode != 0 or not Path(tmp_path).is_file():
                result = subprocess.run([
                    ffmpeg_path, "-y",
                    "-fflags", "+genpts+discardcorrupt",
                    "-i", mxf_path_str,
                    "-ss", f"{target_offset:.3f}",
                    "-frames:v", "1",
                    "-vf", scale_filter,
                    "-q:v", "3",
                    tmp_path,
                ], capture_output=True, timeout=60)

            if result.returncode != 0 or not Path(tmp_path).is_file():
                return self._error("THUMB_FAILED",
                                   (result.stderr or b"")[-400:].decode("utf-8", errors="replace"),
                                   "Could not extract frame thumbnail.")

            jpeg_bytes = Path(tmp_path).read_bytes()
            Path(tmp_path).unlink(missing_ok=True)
            data_url = "data:image/jpeg;base64," + base64.b64encode(jpeg_bytes).decode()
            return self._ok({
                "dataUrl": data_url,
                "frame": frame_num,
                "fps": fps,
                "mxfPath": str(target_input["path"]),
            })
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Frame thumbnail failed.")

    # ── Apple Vision OCR handlers ─────────────────────────────────────────────

    def _ocr_capabilities(self, _: dict[str, Any]) -> dict[str, Any]:
        """Quick capability probe — JS uses this to decide whether to send images."""
        try:
            from .engines import vision_ocr  # type: ignore
            available = bool(vision_ocr.is_available())
        except Exception:
            available = False
        return self._ok({
            "engine": "apple-vision",
            "available": available,
            "platform": platform.system(),
        })

    def _ocr_image(self, request: dict[str, Any]) -> dict[str, Any]:
        """Recognise text in a PNG image via Apple Vision (macOS only).

        Request shape:
            { imageBase64, recognitionLevel?, languageList?, minimumTextHeight? }

        Response data shape (always _ok wrapper — errors return ok:false in data):
            { ok, engine, available, rawText, results: [{text, confidence, bbox}], error }
        """
        try:
            from .engines import vision_ocr  # type: ignore
        except Exception as exc:
            return self._ok({
                "ok": False,
                "engine": "apple-vision",
                "available": False,
                "rawText": "",
                "results": [],
                "error": f"vision_ocr module not importable: {exc}",
            })

        image_b64 = str(request.get("imageBase64") or "")
        if not image_b64:
            return self._ok({
                "ok": False,
                "engine": "apple-vision",
                "available": vision_ocr.is_available(),
                "rawText": "",
                "results": [],
                "error": "Missing imageBase64",
            })

        recognition_level = str(request.get("recognitionLevel") or "accurate")
        language_list = request.get("languageList") or None
        if language_list is not None and not isinstance(language_list, list):
            language_list = None
        minimum_text_height = float(request.get("minimumTextHeight") or 0.0)

        result = vision_ocr.recognize_text_b64(
            image_b64,
            recognition_level=recognition_level,
            language_list=language_list,
            minimum_text_height=minimum_text_height,
        )
        return self._ok(result)

    # ── Trailer Conform handlers ──────────────────────────────────────────────

    def _conform_preflight(self, request: dict[str, Any]) -> dict[str, Any]:
        """Fast sanity check before starting a real conform analyse job."""
        job = request.get("job")
        if not isinstance(job, dict):
            return self._error("BAD_REQUEST", "Missing 'job' object.", "Invalid request.")
        try:
            return self._ok(run_conform_preflight(job))
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Pre-flight check failed.")

    def _conform_analyze(self, request: dict[str, Any]) -> dict[str, Any]:
        """Start Phase 1 analysis: parse edit, render proxies, match."""
        job = request.get("job")
        if not isinstance(job, dict):
            return self._error("BAD_REQUEST", "Missing 'job' object.", "Invalid request.")
        try:
            session_id = start_conform_analyze(job)
            return self._ok({"jobId": session_id})
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Could not start conform analysis.")

    def _conform_job_status(self, request: dict[str, Any]) -> dict[str, Any]:
        """Poll conform job status (analyze or build)."""
        job_id = str(request.get("jobId") or "")
        if not job_id:
            return self._error("BAD_REQUEST", "Missing jobId.", "")
        state = get_conform_status(job_id)
        if state is None:
            return self._error("JOB_NOT_FOUND", f"No conform job '{job_id}'.", "")
        result = state.pop("_result", None)
        resp: dict[str, Any] = {
            "jobId": job_id,
            "step": state.get("step", "unknown"),
            "pct": state.get("pct", 0),
            "message": state.get("message", ""),
            "done": bool(state.get("done", False)),
        }
        # Forward live lists so UI can display them as they arrive
        for key in ("events", "proxies", "matches"):
            if key in state:
                resp[key] = state[key]
        if result is not None:
            resp["result"] = result
        return self._ok(resp)

    def _conform_build_timeline(self, request: dict[str, Any]) -> dict[str, Any]:
        """Start Phase 3: build Resolve timeline + render review QT."""
        job = request.get("job")
        if not isinstance(job, dict):
            return self._error("BAD_REQUEST", "Missing 'job' object.", "Invalid request.")
        try:
            session_id = start_conform_build(job)
            return self._ok({"jobId": session_id})
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Could not start conform build.")

    def _conform_cancel_job(self, request: dict[str, Any]) -> dict[str, Any]:
        job_id = str(request.get("jobId") or "")
        if not job_id:
            return self._error("BAD_REQUEST", "Missing jobId.", "")
        try:
            cancelled = cancel_conform_job(job_id)
            return self._ok({"cancelled": cancelled, "jobId": job_id})
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Cancel failed.")

    def _conform_export(self, request: dict[str, Any]) -> dict[str, Any]:
        """Export EDL/FCPXML/OTIO/CSV from a finalized match list."""
        match_list = list(request.get("matchList") or [])
        output_dir = str(request.get("outputDir") or "")
        fps = float(request.get("fps") or 24.0)
        label = str(request.get("label") or "Conform")
        formats = list(request.get("formats") or ["edl", "fcpxml", "csv"])
        if not match_list:
            return self._error("BAD_REQUEST", "Empty matchList.", "")
        if not output_dir:
            return self._error("BAD_REQUEST", "Missing outputDir.", "")
        try:
            paths = export_conform_results(match_list, output_dir, fps, label, formats)
            return self._ok({"exports": paths})
        except Exception as exc:
            return self._error("INTERNAL_ERROR", str(exc), "Export failed.")

    def _aaf_capabilities(self, request: dict[str, Any]) -> dict[str, Any]:
        import platform as _platform
        import sys
        from .aaf_export import _check_pyaaf2, find_ffmpeg, get_pyaaf2_version
        aaf2_mod = _check_pyaaf2()
        ffmpeg_path = find_ffmpeg()
        pyaaf2_ver = get_pyaaf2_version()
        return self._ok({
            'hostName': 'com.postflowx.companion',
            'version': self.config.companion_version,
            'platform': _platform.system().lower(),
            'python': sys.executable,
            'pythonVersion': sys.version,
            'nativePlayback': True,
            'aafWriter': aaf2_mod is not None,
            'aafWriterMode': 'pyaaf2' if aaf2_mod is not None else None,
            'pyaaf2': aaf2_mod is not None,
            'pyaaf2Version': pyaaf2_ver or '',
            'ffmpeg': ffmpeg_path is not None,
            'ffmpegPath': ffmpeg_path or '',
        })

    def _aaf_status(self, request: dict[str, Any]) -> dict[str, Any]:
        """Full AAF status including test write — used by Settings Repair flow."""
        import platform as _platform
        import sys
        from .aaf_export import _check_pyaaf2, find_ffmpeg, get_pyaaf2_version, _get_log_file
        from .aaf_exporter.test_write_aaf import test_write_aaf

        errors: list[str] = []
        aaf2_mod = _check_pyaaf2()
        ffmpeg_path = find_ffmpeg()
        pyaaf2_ver = get_pyaaf2_version()

        test_result = None
        test_write_ok = False
        test_write_path = ''
        if aaf2_mod is not None:
            try:
                test_result = test_write_aaf()
                test_write_ok = bool(test_result.get('ok'))
                test_write_path = test_result.get('path', '')
                if not test_write_ok:
                    errors.append(test_result.get('error', 'test write failed'))
            except Exception as e:
                errors.append(f'test write exception: {e}')

        return self._ok({
            'helperRunning': True,
            'python': sys.executable,
            'pythonVersion': sys.version,
            'platform': _platform.system().lower(),
            'pyaaf2Installed': aaf2_mod is not None,
            'pyaaf2Version': pyaaf2_ver or '',
            'aafExporterAvailable': aaf2_mod is not None,
            'ffmpeg': ffmpeg_path is not None,
            'ffmpegPath': ffmpeg_path or '',
            'testWriteOK': test_write_ok,
            'testWritePath': test_write_path,
            'logFile': str(_get_log_file()),
            'errors': errors,
        })

    def _aaf_test_write(self, request: dict[str, Any]) -> dict[str, Any]:
        """Run the AAF write test and return the result."""
        from .aaf_exporter.test_write_aaf import test_write_aaf
        try:
            result = test_write_aaf()
            if result.get('ok'):
                return self._ok(result)
            return self._error('AAF_TEST_FAILED', result.get('error', 'test write failed'), result.get('error', 'test write failed'))
        except Exception as e:
            return self._error('AAF_TEST_ERROR', str(e), f'AAF test write error: {e}')

    def _aaf_repair(self, request: dict[str, Any]) -> dict[str, Any]:
        """Install pyaaf2 from bundled vendor directory or PyPI, then verify."""
        import sys
        from pathlib import Path

        companion_src = Path(__file__).resolve().parent.parent  # companion/src/
        vendor_aaf2 = companion_src / 'aaf2'

        steps: list[str] = []

        # Check if already present (bundled)
        if vendor_aaf2.exists():
            steps.append('pyaaf2 already bundled in companion/src/aaf2 — no install needed')
        else:
            # Try pip install --target into companion/src
            steps.append('pyaaf2 not found — attempting pip install into companion src...')
            try:
                import subprocess
                result = subprocess.run(
                    [sys.executable, '-m', 'pip', 'install', '--target', str(companion_src), '--no-deps', 'pyaaf2'],
                    capture_output=True, text=True, timeout=120,
                )
                if result.returncode == 0:
                    steps.append('pip install succeeded')
                else:
                    steps.append(f'pip install failed: {result.stderr[:500]}')
                    return self._error('AAF_REPAIR_PIP_FAILED', result.stderr[:200], 'pip install pyaaf2 failed')
            except Exception as e:
                return self._error('AAF_REPAIR_ERROR', str(e), f'Repair failed: {e}')

        # Verify import
        from .aaf_export import _check_pyaaf2, get_pyaaf2_version, _get_log_file
        from .aaf_exporter.test_write_aaf import test_write_aaf

        aaf2_mod = _check_pyaaf2()
        if not aaf2_mod:
            return self._error('AAF_REPAIR_IMPORT_FAILED', 'aaf2 still not importable after install', 'pyaaf2 could not be imported after repair')

        steps.append(f'pyaaf2 import OK  version={get_pyaaf2_version()}')

        test_result = test_write_aaf()
        steps.append(f"test write: {'OK' if test_result.get('ok') else test_result.get('error','failed')}")

        return self._ok({
            'repaired': True,
            'pyaaf2Installed': True,
            'pyaaf2Version': get_pyaaf2_version() or '',
            'testWriteOK': test_result.get('ok', False),
            'testWritePath': test_result.get('path', ''),
            'logFile': str(_get_log_file()),
            'steps': steps,
        })

    def _export_nle_linked_aaf(self, request: dict[str, Any]) -> dict[str, Any]:
        from .aaf_export import export_nle_linked_aaf
        result = export_nle_linked_aaf(request)
        if result.get('status') == 'ok':
            return self._ok(result['data'])
        return self._error(
            result.get('code', 'AAF_EXPORT_FAILED'),
            result.get('userMessage', 'NLE Linked AAF export failed'),
            result.get('userMessage', 'NLE Linked AAF export failed'),
        )

    def _export_protools_aaf(self, request: dict[str, Any]) -> dict[str, Any]:
        from .aaf_export import export_protools_aaf
        result = export_protools_aaf(request)
        if result.get('status') == 'ok':
            return self._ok(result['data'])
        resp = self._error(
            result.get('code', 'AAF_EXPORT_FAILED'),
            result.get('userMessage', 'Pro Tools AAF export failed'),
            result.get('userMessage', 'Pro Tools AAF export failed'),
        )
        if result.get('data'):
            resp['data'] = result['data']
        return resp


    # ══════════════════════════════════════════════════════════════════════════
    # OCF Playback Engine  (PostFlowX 3.0)
    # ══════════════════════════════════════════════════════════════════════════

    def _ocf_engine_scan(self, request: dict[str, Any]) -> dict[str, Any]:
        """Scan a file, folder, or camera card root for OCF clips.

        Request: { path: "/abs/path" }
        Response: { ok, root, clips, warnings, errors }
        """
        from .ocf_engine import scan_ocf, log_scan
        path = str(request.get("path") or request.get("folderPath") or "").strip()
        if not path:
            return self._error("MISSING_PATH", "path required", "No path provided.")
        result = scan_ocf(path)
        families = list({c.get("cameraFamily", "") for c in result.get("clips", [])})
        log_scan(path, len(result.get("clips", [])), families, result.get("warnings", []))
        return self._ok(result) if result.get("ok") else self._error(
            "SCAN_FAILED", str(result.get("errors", [])), "OCF scan failed.")

    def _ocf_engine_probe(self, request: dict[str, Any]) -> dict[str, Any]:
        """Full metadata probe for a single OCF clip.

        Request: { clipPath: "/abs/path/to/file.mov" }
        Response: canonical OCF probe dict
        """
        from .ocf_engine import probe_ocf_clip, log_probe
        clip_path = str(request.get("clipPath") or request.get("filePath") or "").strip()
        if not clip_path:
            return self._error("MISSING_PATH", "clipPath required", "No clip path provided.")
        result = probe_ocf_clip(clip_path)
        log_probe(
            clip_path,
            result.get("container", ""),
            result.get("codec", ""),
            result.get("cameraFamily", ""),
            result.get("fps", {}).get("display", ""),
            result.get("timecode", {}).get("start", ""),
            result.get("reel", ""),
            str(result.get("cameraModel", "")),
        )
        return self._ok(result)

    def _ocf_engine_select(self, request: dict[str, Any]) -> dict[str, Any]:
        """Select the best OCF playback engine for a probed clip.

        Request: { probe: <probe_dict>, forceEngine: "..." (optional) }
        Response: { engine, fallbackEngines, reason, sdkStatus }
        """
        from .ocf_engine import select_ocf_engine, sdk_status, log_router
        probe        = request.get("probe") or {}
        force_engine = request.get("forceEngine") or None
        engine, fallbacks, reason = select_ocf_engine(probe, force_engine=force_engine)
        log_router(engine, fallbacks, reason)
        sdk = sdk_status()
        return self._ok({
            "engine":          engine,
            "fallbackEngines": fallbacks,
            "reason":          reason,
            "sdkStatus": {
                "avf":     sdk.avf,
                "ffmpeg":  sdk.ffmpeg,
                "mpv":     sdk.mpv,
                "resolve": sdk.resolve,
                "braw":    sdk.braw,
                "red":     sdk.red,
                "arri":    sdk.arri,
                "canon":   sdk.canon,
            },
        })

    def _ocf_engine_decode_frame(self, request: dict[str, Any]) -> dict[str, Any]:
        """Decode a single frame from an OCF clip.

        Request: { clipPath, frameNumber (default 0), scale (default 960), engine ("auto") }
        Response: { ok, imagePath, engine, frameNumber, timecode, colorPreview, stderr, errors }
        """
        from .ocf_engine import decode_first_frame
        clip_path    = str(request.get("clipPath") or request.get("filePath") or "").strip()
        frame_number = int(request.get("frameNumber") or 0)
        scale        = int(request.get("scale") or 960)
        engine       = str(request.get("engine") or "auto")
        probe        = request.get("probe") or {}

        if not clip_path:
            return self._error("MISSING_PATH", "clipPath required", "No clip path provided.")

        result = decode_first_frame(
            clip_path, frame_number=frame_number, scale=scale,
            engine=engine, probe=probe,
        )
        return self._ok(result)

    def _ocf_engine_play(self, request: dict[str, Any]) -> dict[str, Any]:
        """Initiate OCF playback. For v1, returns probe + engine selection.
        Full playback is handled client-side via the selected engine.

        Request: { clipPath, engine (optional), probe (optional) }
        Response: { ok, engine, probeResult, playbackMode, colorBadge }
        """
        from .ocf_engine import probe_ocf_clip, select_ocf_engine, color_badge
        clip_path = str(request.get("clipPath") or "").strip()
        if not clip_path:
            return self._error("MISSING_PATH", "clipPath required", "No clip path provided.")

        probe_result = request.get("probe") or probe_ocf_clip(clip_path)
        force_engine = request.get("engine") or None
        engine, fallbacks, reason = select_ocf_engine(probe_result, force_engine=force_engine)

        mode_map = {
            "NativeAVFoundationEngine": "direct",
            "MPVEngine":                "direct",
            "FFmpegFrameServer":        "frame_server",
            "BRAWSDKEngine":            "frame_server",
            "REDSDKEngine":             "frame_server",
            "ARRISDKEngine":            "frame_server",
            "CanonRawSDKEngine":        "frame_server",
            "ResolveEngine":            "resolve_assisted",
            "ProxyEngine":              "smart_proxy",
        }
        playback_mode = mode_map.get(engine, "smart_proxy")
        badge         = color_badge(probe_result, engine)

        return self._ok({
            "ok":            True,
            "engine":        engine,
            "fallbackEngines": fallbacks,
            "playbackMode":  playback_mode,
            "probeResult":   probe_result,
            "colorBadge":    badge,
        })

    def _ocf_engine_generate_proxy(self, request: dict[str, Any]) -> dict[str, Any]:
        """Start async OCF proxy generation.

        Request: { clipPath, scale (default 1280), timecodeStart (optional) }
        Response: { jobId } — poll with ocfProxyJobStatus
        """
        from .ocf_engine.ocf_proxy import generate_proxy_async
        clip_path  = str(request.get("clipPath") or request.get("filePath") or "").strip()
        if not clip_path:
            return self._error("MISSING_PATH", "clipPath required", "No clip path provided.")
        scale       = int(request.get("scale") or 1280)
        tc_start    = str(request.get("timecodeStart") or "")
        output_dir  = str(request.get("outputDir") or "") or None
        result      = generate_proxy_async(
            clip_path, scale=scale, timecode_start=tc_start, output_dir=output_dir
        )
        return self._ok(result)

    def _ocf_proxy_job_status(self, request: dict[str, Any]) -> dict[str, Any]:
        """Poll proxy generation job status.

        Request: { jobId }
        Response: { state, pct, result }
        """
        from .ocf_engine.ocf_proxy import proxy_job_status
        job_id = str(request.get("jobId") or "").strip()
        if not job_id:
            return self._error("MISSING_JOB_ID", "jobId required", "No jobId provided.")
        return self._ok(proxy_job_status(job_id))

    def _ocf_engine_status(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return OCF engine status rows for the Settings > OCF Engine panel.

        Response: { rows: [ { id, label, status, available, path, detail } ] }
        """
        from .ocf_engine.ocf_router import engine_status_rows
        return self._ok({"rows": engine_status_rows()})

    def _ocf_engine_show_logs(self, request: dict[str, Any]) -> dict[str, Any]:
        """Return recent OCF engine log content.

        Request: { maxBytes (default 65536) }
        Response: { logs: "..." }
        """
        from .ocf_engine.ocf_logs import read_logs
        max_bytes = int(request.get("maxBytes") or 65536)
        return self._ok({"logs": read_logs(max_bytes)})

    def _ocf_refresh_engines(self, request: dict[str, Any]) -> dict[str, Any]:
        """Force-refresh SDK detection cache and return updated status rows."""
        from .ocf_engine.ocf_router import refresh_sdk_status, engine_status_rows
        refresh_sdk_status()
        return self._ok({"rows": engine_status_rows()})



def _still_avg_luma_ffmpeg(path: str, ffmpeg: str) -> "float | None":
    """Average luma (0-255) of an image via ffmpeg — PIL-free (the companion's
    python often lacks Pillow). Scales the whole frame to 1×1 gray = the mean.
    Returns None if it can't be computed."""
    try:
        import subprocess as _sp
        r = _sp.run([ffmpeg, "-v", "error", "-i", path, "-vf", "scale=1:1",
                     "-f", "rawvideo", "-pix_fmt", "gray", "-"],
                    capture_output=True, timeout=10)
        if r.returncode == 0 and r.stdout:
            return float(r.stdout[0])
    except Exception:
        pass
    return None


def _is_preview_timeline_name(name: Any) -> bool:
    """True for a PostFlowX preview scratch timeline (`pfx_still_*` from the api
    path, `PFX_Preview_*`/`pfx_preview*` from the resolve_bridge path). These are
    throwaway — safe to garbage-collect when not the warm one in use."""
    n = str(name or "").lower()
    return n.startswith("pfx_still_") or n.startswith("pfx_preview")


def _safe_name_component(value: Any, fallback: str = "item") -> str:
    """One filesystem path SEGMENT with separators/traversal neutralized.
    '/' '\\' → '_', leading/trailing dots+underscores stripped, so '..' and
    'A001/C002' can never become path components. Mirrors proxy_service's
    _safe_filename_component. Legit names (e.g. 'SH010_PL01') pass unchanged."""
    raw = str(value or "").strip()
    cleaned = "".join(c if (c.isalnum() or c in ("-", "_", ".")) else "_" for c in raw)
    cleaned = cleaned.strip(" ._")
    while "__" in cleaned:
        cleaned = cleaned.replace("__", "_")
    return cleaned[:180] or fallback


def _confined_join(base: str, *parts: Any) -> str:
    """Join parts under `base` and verify the result stays inside it.
    Defends EXR/AMF writes against path traversal (../, absolute paths, symlink
    escapes) from renderer-supplied shotName / outputPattern. Raises ValueError
    on escape — callers return a clean error rather than writing outside base."""
    base_r = os.path.realpath(base)
    target = os.path.realpath(os.path.join(base, *[str(p) for p in parts]))
    if base_r != target and os.path.commonpath([base_r, target]) != base_r:
        raise ValueError(f"path escapes output directory: {parts!r}")
    return target


def _safe_output_pattern(pattern: Any, fallback: str = "%04d.exr") -> str:
    """Reject a renderer-supplied frame pattern that contains path separators or
    traversal — a malicious outputPattern must not write outside the output dir."""
    s = str(pattern or "").strip()
    if not s or "/" in s or "\\" in s or ".." in s or os.path.isabs(s):
        return fallback
    return s


def _tc_to_frames(tc: str, fps: float) -> int:
    """Convert HH:MM:SS:FF timecode string to absolute frame count."""
    try:
        parts = str(tc).strip().replace(";", ":").split(":")
        if len(parts) != 4:
            return 0
        h, m, s, f = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
        total_frames = int(round(fps)) * (h * 3600 + m * 60 + s) + f
        return total_frames
    except Exception:
        return 0


def _frames_to_tc(frames: int, fps: float) -> str:
    """Convert absolute frame count to HH:MM:SS:FF timecode string."""
    fps_int = max(1, int(round(fps)))
    frames  = max(0, int(frames))
    f = frames % fps_int
    s = (frames // fps_int) % 60
    m = (frames // (fps_int * 60)) % 60
    h = frames // (fps_int * 3600)
    return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"


def _strip_ns(tag: str) -> str:
    return tag.split("}")[-1] if "}" in tag else tag


def _find_cpl_entry(package: dict[str, Any], cpl_id: str) -> dict[str, Any] | None:
    clean_id = str(cpl_id or "").strip()
    for pkg in package.get("packages") or []:
        for entry in pkg.get("cpls") or []:
            cpl = entry.get("cpl") or {}
            if str(cpl.get("id") or "") == clean_id:
                return {
                    **entry,
                    "pkl": pkg.get("pkl") or {},
                    "packageName": pkg.get("packageName") or entry.get("packageName") or "Package",
                    "root": pkg.get("root") or entry.get("root") or "",
                }
    return None


def _extract_embedded_adm_xml(path: Path) -> str:
    """Extract the embedded ADM XML block from an IAB MXF file.

    Strategy: scan backward from EOF in 4 MB chunks (ADM XML is always near
    the end of IMF IAB MXF files), then fall back to a forward scan.
    This avoids reading the entire file sequentially for large MXFs.
    """
    _PRIMARY_START  = b"<ebuCoreMain"
    _PRIMARY_END    = b"</ebuCoreMain>"
    _FALLBACK_START = b"<audioFormatExtended"
    _FALLBACK_END   = b"</audioFormatExtended>"
    # Maximum XML size we'll try to collect (16 MB is generous)
    _MAX_XML = 16 * 1024 * 1024
    _SCAN_CHUNK = 4 * 1024 * 1024  # 4 MB per backward step
    _OVERLAP = 256

    file_size = path.stat().st_size

    # ── Pass 1: backward scan (fast path for IMF IAB) ────────────────────────
    with path.open("rb") as fh:
        offset = file_size
        carry = b""
        while offset > 0:
            read_start = max(0, offset - _SCAN_CHUNK)
            fh.seek(read_start)
            chunk = fh.read(offset - read_start)
            data = chunk + carry  # carry = first bytes of previous chunk

            for start_marker, end_marker, fallback in [
                (_PRIMARY_START,  _PRIMARY_END,  False),
                (_FALLBACK_START, _FALLBACK_END, True),
            ]:
                idx = data.rfind(start_marker)  # last occurrence in this window
                if idx < 0:
                    continue
                abs_start = read_start + idx
                # Read the full XML forward from that position
                fh.seek(abs_start)
                blob = fh.read(_MAX_XML)
                end_idx = blob.find(end_marker)
                if end_idx < 0:
                    continue
                xml = blob[: end_idx + len(end_marker)].decode("latin1", errors="ignore")
                # Strip any leading binary garbage before '<'
                lt = xml.find("<")
                if lt > 0:
                    xml = xml[lt:]
                if fallback:
                    xml = (
                        '<?xml version="1.0" encoding="UTF-8"?>'
                        "<ebuCoreMain><coreMetadata><format>"
                        + xml
                        + "</format></coreMetadata></ebuCoreMain>"
                    )
                return xml

            carry = data[:_OVERLAP]
            offset = read_start
            if offset == 0:
                break

    # ── Pass 2: forward scan fallback (non-IMF files) ────────────────────────
    tail = b""
    started = False
    using_fallback = False
    collected = bytearray()
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(2 * 1024 * 1024)
            if not chunk:
                break
            data = tail + chunk
            if not started:
                idx = data.find(_PRIMARY_START)
                if idx < 0:
                    idx = data.find(_FALLBACK_START)
                    if idx >= 0:
                        using_fallback = True
                if idx >= 0:
                    started = True
                    collected.extend(data[idx:])
                    end_token = _FALLBACK_END if using_fallback else _PRIMARY_END
                    end_idx = collected.find(end_token)
                    if end_idx >= 0:
                        xml = collected[: end_idx + len(end_token)].decode("latin1", errors="ignore")
                        if using_fallback:
                            xml = f'<?xml version="1.0" encoding="UTF-8"?><ebuCoreMain><coreMetadata><format>{xml}</format></coreMetadata></ebuCoreMain>'
                        return xml
                    tail = b""
                else:
                    tail = data[-_OVERLAP:]
            else:
                collected.extend(chunk)
                end_token = _FALLBACK_END if using_fallback else _PRIMARY_END
                end_idx = collected.find(end_token)
                if end_idx >= 0:
                    xml = collected[: end_idx + len(end_token)].decode("latin1", errors="ignore")
                    if using_fallback:
                        xml = f'<?xml version="1.0" encoding="UTF-8"?><ebuCoreMain><coreMetadata><format>{xml}</format></coreMetadata></ebuCoreMain>'
                    return xml
    raise ValueError("Embedded ADM XML not found in IAB asset")


def _collect_named_nodes(root: ET.Element, node_name: str, attr_name: str) -> list[str]:
    values: list[str] = []
    for node in root.iter():
        if _strip_ns(node.tag) != node_name:
            continue
        raw = (node.attrib.get(attr_name) or "").strip()
        if raw and raw not in values:
            values.append(raw)
    return values


# Speaker-channel-count → immersive bed layout (Dolby Atmos beds + common SDR).
_BED_LAYOUT_BY_CH = {
    1: "1.0", 2: "2.0", 6: "5.1", 7: "5.1.2", 8: "7.1",
    10: "7.1.2", 12: "7.1.4", 14: "9.1.4", 16: "9.1.6",
}


def _adm_bed_layout(pack: ET.Element) -> tuple[int, str]:
    """Channel count + layout label for a DirectSpeakers (bed) audioPackFormat.

    The bed's channel count = number of audioChannelFormatIDRef children (BS.2076
    ADM); 10 → 7.1.2, 12 → 7.1.4, 16 → 9.1.6, etc."""
    ch = sum(1 for c in pack.iter() if _strip_ns(c.tag) == "audioChannelFormatIDRef")
    return ch, _BED_LAYOUT_BY_CH.get(ch, f"{ch}ch")


def _inspect_iab_asset(path: Path) -> dict[str, Any]:
    xml_text = _extract_embedded_adm_xml(path)
    root = safe_xml.fromstring(xml_text)
    programme_names = _collect_named_nodes(root, "audioProgramme", "audioProgrammeName")
    content_names = _collect_named_nodes(root, "audioContent", "audioContentName")
    object_names = _collect_named_nodes(root, "audioObject", "audioObjectName")
    pack_names = _collect_named_nodes(root, "audioPackFormat", "audioPackFormatName")
    track_format_names = _collect_named_nodes(root, "audioTrackFormat", "audioTrackFormatName")

    # ── Type-based bed/object split (authoritative — not a name heuristic) ──────
    # ADM typeDefinition="DirectSpeakers" (typeLabel 0001) = a channel bed;
    # "Objects" (0003) = dynamic objects. Derive bed layout from the bed pack's
    # channel count.
    beds: list[dict[str, Any]] = []
    object_pack_count = 0
    for node in root.iter():
        if _strip_ns(node.tag) != "audioPackFormat":
            continue
        td = (node.attrib.get("typeDefinition") or "").strip()
        tl = (node.attrib.get("typeLabel") or "").strip()
        nm = (node.attrib.get("audioPackFormatName") or "").strip()
        if td == "DirectSpeakers" or tl == "0001":
            ch, layout = _adm_bed_layout(node)
            beds.append({"name": nm or "Bed", "channels": ch, "layout": layout})
        elif td == "Objects" or tl == "0003":
            object_pack_count += 1

    adm_stats = {
        "audioProgramme": sum(1 for node in root.iter() if _strip_ns(node.tag) == "audioProgramme"),
        "audioContent": sum(1 for node in root.iter() if _strip_ns(node.tag) == "audioContent"),
        "audioObject": sum(1 for node in root.iter() if _strip_ns(node.tag) == "audioObject"),
        "audioPackFormat": sum(1 for node in root.iter() if _strip_ns(node.tag) == "audioPackFormat"),
        "audioTrackFormat": sum(1 for node in root.iter() if _strip_ns(node.tag) == "audioTrackFormat"),
    }

    # Count-driven (robust when objects lack name attributes): prefer the ADM
    # element/type counts over named-list lengths.
    bed_count = len(beds)
    dynamic_objects = object_pack_count or max(0, adm_stats["audioObject"] - bed_count)
    total_objects = adm_stats["audioObject"] or len(object_names)
    numbered_objects = sum(1 for name in object_names if name.lower().startswith("object "))
    named_objects = [name for name in object_names
                     if name and not name.lower().startswith("object ") and "bed" not in name.lower()]
    bed_layout = beds[0]["layout"] if beds else ""

    # Structured track list for the Resolve-style track view (bed + Object 1..N).
    tracks: list[dict[str, Any]] = []
    for b in beds:
        tracks.append({"type": "bed", "name": b["name"], "layout": b["layout"], "channels": b["channels"]})
    for name in object_names:
        if "bed" in name.lower():
            continue
        tracks.append({"type": "object", "name": name, "layout": "Object", "channels": 1})

    return {
        "xmlRoot": _strip_ns(root.tag),
        "programmeNames": programme_names,
        "contentNames": content_names,
        "objectNames": object_names,
        "packNames": pack_names,
        "trackFormatNames": track_format_names,
        "admStats": adm_stats,
        "beds": beds,
        "bedLayout": bed_layout,
        "tracks": tracks,
        "objectSummary": {
            "totalObjects": total_objects,
            "bedObjects": bed_count,
            "dynamicObjects": dynamic_objects,
            "numberedObjects": numbered_objects,
            "namedObjects": len(named_objects),
            "sampleNamedObjects": named_objects[:12],
            "bedLayout": bed_layout,
        },
        "xmlSize": len(xml_text),
    }
