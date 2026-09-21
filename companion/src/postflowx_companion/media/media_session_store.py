"""Thread-safe media session store for the companion."""
from __future__ import annotations

import threading
import time
import uuid
from typing import Any

_lock    = threading.Lock()
_sessions: dict[str, dict[str, Any]] = {}


def new_session_id() -> str:
    return f"ms_{uuid.uuid4().hex[:12]}"


def create_media_session(session_id: str, state: dict[str, Any]) -> None:
    with _lock:
        _sessions[session_id] = {
            "sessionId":    session_id,
            "filePath":     "",
            "fileType":     "",
            "backend":      "",
            "capabilities": {},
            "metadata":     {},
            "cacheState":   "pending",
            "openedAt":     time.time(),
            "lastError":    None,
            **state,
        }


def get_media_session(session_id: str) -> dict[str, Any] | None:
    with _lock:
        return dict(_sessions[session_id]) if session_id in _sessions else None


def update_media_session(session_id: str, delta: dict[str, Any]) -> bool:
    with _lock:
        if session_id not in _sessions:
            return False
        _sessions[session_id].update(delta)
        return True


def close_media_session(session_id: str) -> None:
    with _lock:
        _sessions.pop(session_id, None)


def list_media_sessions() -> list[dict[str, Any]]:
    with _lock:
        return [dict(s) for s in _sessions.values()]
