"""Normalize backend/helper status for UI diagnostics."""
from __future__ import annotations

from typing import Any

from .media_types import Backend, BackendStatus


def build_diagnostics(backend_statuses: dict[str, Any], helper_version: str, platform: str) -> dict[str, Any]:
    """
    Build a unified diagnostics response for all tabs.

    :param backend_statuses: output of get_backend_statuses()
    :param helper_version:   companion version string
    :param platform:         'darwin'|'windows'|'linux'
    """
    def _label(key: str) -> str:
        labels = {
            Backend.STANDARD_MEDIA:    "Standard Media",
            Backend.PRORES_NATIVE:     "Apple ProRes",
            Backend.PRORES_RAW_NATIVE: "ProRes RAW",
            Backend.BRAW_SDK:          "Blackmagic RAW",
            Backend.R3D_SDK:           "RED R3D",
            Backend.ARRI_SDK:          "ARRI SDK",
            Backend.ARRI_TOOL_BRIDGE:  "ARRI Bridge",
        }
        return labels.get(key, key)

    backends_out = {}
    for key, s in backend_statuses.items():
        backends_out[key] = {
            "backend":    key,
            "label":      _label(key),
            "status":     s.get("status", BackendStatus.UNAVAILABLE),
            "decodeMode": s.get("decodeMode", "none"),
            "version":    s.get("version"),
            "lastError":  s.get("lastError"),
        }

    def _at_least(key: str) -> bool:
        """True when backend is READY or METADATA_ONLY (something works)."""
        st = backends_out.get(key, {}).get("status")
        return st in (BackendStatus.READY, BackendStatus.METADATA_ONLY, BackendStatus.PREVIEW_ONLY)

    prores_ok = (
        _at_least(Backend.STANDARD_MEDIA) or
        _at_least(Backend.PRORES_NATIVE)
    )

    r3d_st = backends_out.get(Backend.R3D_SDK, {}).get("status")
    praw_st = backends_out.get(Backend.PRORES_RAW_NATIVE, {}).get("status")
    arri_st = backends_out.get(Backend.ARRI_SDK, {}).get("status")
    return {
        "helperInstalled":        True,
        "helperVersion":          helper_version,
        "platform":               platform,
        "backends":               backends_out,
        "proResSupported":        prores_ok,
        "proResRawSupported":     _at_least(Backend.PRORES_RAW_NATIVE),
        "proResRawDecodeReady":   praw_st == BackendStatus.READY,
        "brawSupported":          backends_out.get(Backend.BRAW_SDK, {}).get("status") == BackendStatus.READY,
        "r3dSupported":           _at_least(Backend.R3D_SDK),
        "r3dFullDecodeReady":     r3d_st == BackendStatus.READY,
        # ARRIRAW: True when any ARRI capability (metadata or decode) is available
        "arriSupported":          _at_least(Backend.ARRI_SDK) or _at_least(Backend.ARRI_TOOL_BRIDGE),
        "arriDecodeReady":        arri_st == BackendStatus.READY,
        "lastError":              None,
    }
