"""Shared enums and constants for the media runtime."""
from __future__ import annotations


class Backend:
    STANDARD_MEDIA    = "standard_media"
    PRORES_NATIVE     = "prores_native"
    PRORES_RAW_NATIVE = "prores_raw_native"
    BRAW_SDK          = "braw_sdk"
    R3D_SDK           = "r3d_sdk"
    ARRI_SDK          = "arri_sdk"
    ARRI_TOOL_BRIDGE  = "arri_tool_bridge"


class ErrorCode:
    HELPER_NOT_INSTALLED   = "helper_not_installed"
    BACKEND_NOT_AVAILABLE  = "backend_not_available"
    SDK_MISSING            = "sdk_missing"
    UNSUPPORTED_FORMAT     = "unsupported_format"
    FILE_OPEN_FAILED       = "file_open_failed"
    DECODE_FAILED          = "decode_failed"
    PERMISSION_DENIED      = "permission_denied"
    PLATFORM_NOT_SUPPORTED = "platform_not_supported"
    SESSION_NOT_FOUND      = "session_not_found"
    BAD_REQUEST            = "bad_request"


class BackendStatus:
    READY          = "ready"
    UNAVAILABLE    = "unavailable"
    SDK_MISSING    = "sdk_missing"
    PREVIEW_ONLY   = "preview_only"
    METADATA_ONLY  = "metadata_only"
    NOT_INSTALLED  = "not_installed"


class DecodeQuality:
    FULL    = "full"
    HALF    = "half"
    QUARTER = "quarter"


# File extension → preferred backend key
EXT_BACKEND_MAP: dict[str, str] = {
    ".mp4":  Backend.STANDARD_MEDIA,
    ".m4v":  Backend.STANDARD_MEDIA,
    ".webm": Backend.STANDARD_MEDIA,
    ".mkv":  Backend.STANDARD_MEDIA,
    ".mxf":  Backend.STANDARD_MEDIA,
    ".mov":  Backend.STANDARD_MEDIA,     # ProRes: try standard first
    ".braw": Backend.BRAW_SDK,
    ".r3d":  Backend.R3D_SDK,
    ".arx":  Backend.ARRI_SDK,
    ".ari":  Backend.ARRI_SDK,
}

# Backends requiring external SDKs (not always available)
SDK_DEPENDENT: frozenset[str] = frozenset({
    Backend.BRAW_SDK,
    Backend.R3D_SDK,
    Backend.ARRI_SDK,
    Backend.ARRI_TOOL_BRIDGE,
})
