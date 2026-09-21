"""Abstract base class for all media backends."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BaseMediaBackend(ABC):
    """
    Shared interface all backends must implement.
    See handoff spec section 7.
    """

    @property
    @abstractmethod
    def backend_key(self) -> str:
        """Backend identifier (e.g. 'standard_media')."""

    @abstractmethod
    def can_open(self, path: str) -> bool:
        """Return True if this backend can attempt to open the file."""

    @abstractmethod
    def open(self, path: str, options: dict) -> dict[str, Any]:
        """
        Open the file. Returns session handle dict:
        { sessionHandle, fileType, metadata, capabilities }
        Raises RuntimeError on failure.
        """

    @abstractmethod
    def close(self, session_handle: Any) -> None:
        """Release resources for a session handle."""

    @abstractmethod
    def get_metadata(self, session_handle: Any) -> dict[str, Any]:
        """Return file metadata (dimensions, fps, timecode, codec, etc.)."""

    @abstractmethod
    def get_frame(self, session_handle: Any, frame_index: int, options: dict) -> dict[str, Any]:
        """
        Decode a frame.
        Returns { previewImagePath, dataUrl, width, height, timecode, frameIndex }
        """

    @abstractmethod
    def seek(self, session_handle: Any, frame_index: int) -> dict[str, Any]:
        """Seek to frame_index without decoding."""

    def play(self, session_handle: Any, options: dict) -> dict[str, Any]:
        """Start playback. Override in backends that support it."""
        return {"playing": False, "note": "playback not supported by this backend"}

    def pause(self, session_handle: Any) -> dict[str, Any]:
        """Pause playback. Override in backends that support it."""
        return {"paused": True}

    @abstractmethod
    def get_capabilities(self) -> dict[str, Any]:
        """
        Return static capabilities dict:
        { supportsMetadata, supportsStillFrameDecode, supportsPlayback,
          supportsHalfRes, supportsQuarterRes, supportsHardwareAcceleration }
        """

    @abstractmethod
    def get_status(self) -> dict[str, Any]:
        """
        Return live status:
        { status: BackendStatus, decodeMode, version, lastError }
        """
