"""Backend routing and registry for the companion media runtime.

Routing is centralized here. No other module makes backend decisions.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .media_types import Backend, BackendStatus, EXT_BACKEND_MAP, SDK_DEPENDENT


def classify_path(file_path: str) -> str:
    """Return the preferred backend key for a given file path."""
    ext = Path(file_path).suffix.lower()
    return EXT_BACKEND_MAP.get(ext, Backend.STANDARD_MEDIA)


def select_backend(file_path: str, preferred: str | None, available: dict[str, Any]) -> str:
    """
    Pick the best available backend for a file path.

    :param file_path:  path to media file
    :param preferred:  caller hint (may be overridden)
    :param available:  dict backendKey → {status, ...} from get_backend_statuses()
    :returns:  chosen backend key
    """
    ext = Path(file_path).suffix.lower()

    def _ready(key: str) -> bool:
        s = available.get(key) or {}
        return s.get("status") == BackendStatus.READY

    # ProRes RAW: native backend when ready, standard_media as fallback
    if preferred == Backend.PRORES_RAW_NATIVE:
        if _ready(Backend.PRORES_RAW_NATIVE):
            return Backend.PRORES_RAW_NATIVE
        # Fallback: standard_media may still decode ProRes RAW on macOS via VideoToolbox
        return Backend.STANDARD_MEDIA

    # MOV / ProRes: try standard first; fall back to prores_native
    if ext == ".mov":
        if _ready(Backend.STANDARD_MEDIA):
            return Backend.STANDARD_MEDIA
        if _ready(Backend.PRORES_NATIVE):
            return Backend.PRORES_NATIVE
        return Backend.STANDARD_MEDIA

    # ARRIRAW files: prefer arri_sdk, fall back to arri_tool_bridge, then metadata-only
    # Also handles MXF-wrapped ARRIRAW when the caller has already probed the codec
    # and overridden `preferred` to ARRI_SDK/ARRI_TOOL_BRIDGE.
    if ext in {".ari", ".arx"} or (ext == ".mxf" and preferred in (Backend.ARRI_SDK, Backend.ARRI_TOOL_BRIDGE)):
        if _ready(Backend.ARRI_SDK):
            return Backend.ARRI_SDK
        if available.get(Backend.ARRI_TOOL_BRIDGE, {}).get("status") in (
            BackendStatus.READY, BackendStatus.PREVIEW_ONLY
        ):
            return Backend.ARRI_TOOL_BRIDGE
        # Return arri_sdk even for metadata-only — it handles METADATA_ONLY status itself
        return Backend.ARRI_SDK

    # SDK-dependent formats — use SDK if ready, degrade to standard_media for metadata
    canon = EXT_BACKEND_MAP.get(ext, Backend.STANDARD_MEDIA)
    if canon in SDK_DEPENDENT:
        if _ready(canon):
            return canon
        # .braw is QuickTime-wrapped — standard_media can probe it via ffprobe
        if ext == ".braw" and _ready(Backend.STANDARD_MEDIA):
            return Backend.STANDARD_MEDIA
        # For R3D / ARRI / other proprietary RAW: always use the SDK backend even
        # at metadata_only status — it knows how to report framesDecodable correctly
        # and handles the no-SDK degraded path.  standard_media would reject the
        # extension entirely and return ok=False.
        sdk_status = (available.get(canon) or {}).get("status", "")
        if sdk_status in (BackendStatus.METADATA_ONLY, BackendStatus.PREVIEW_ONLY,
                          BackendStatus.READY, BackendStatus.SDK_MISSING):
            return canon
        return Backend.STANDARD_MEDIA

    # Fallback
    return Backend.STANDARD_MEDIA


def get_backend_statuses(backend_instances: dict) -> dict[str, Any]:
    """
    Ask each registered backend instance for its status.
    Returns {backendKey: {status, decodeMode, version, lastError}}.
    """
    result: dict[str, Any] = {}
    for key, backend in backend_instances.items():
        try:
            result[key] = backend.get_status()
        except Exception as exc:
            result[key] = {
                "status":     BackendStatus.UNAVAILABLE,
                "decodeMode": "none",
                "version":    None,
                "lastError":  str(exc),
            }
    return result
