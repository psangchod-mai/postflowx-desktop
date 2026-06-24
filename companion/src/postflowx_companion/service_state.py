from __future__ import annotations

from threading import RLock
from typing import Any


_lock = RLock()
_sessions: dict[str, dict[str, Any]] = {}


def create_session(session_id: str, initial: dict[str, Any]) -> None:
    with _lock:
        _sessions[session_id] = dict(initial)


def get_session(session_id: str) -> dict[str, Any] | None:
    with _lock:
        state = _sessions.get(session_id)
        return dict(state) if state else None


def update_session(session_id: str, **updates: Any) -> None:
    with _lock:
        if session_id in _sessions:
            _sessions[session_id].update(updates)


def remove_session(session_id: str) -> dict[str, Any] | None:
    with _lock:
        state = _sessions.pop(session_id, None)
        return dict(state) if state else None



def list_sessions() -> dict[str, dict[str, Any]]:
    """Return a shallow copy of all in-memory service sessions."""
    with _lock:
        return {sid: dict(state) for sid, state in _sessions.items()}


def remove_sessions(predicate) -> int:
    """Remove sessions for which predicate(session_id, state) returns True."""
    removed = 0
    with _lock:
        for sid, state in list(_sessions.items()):
            try:
                should_remove = bool(predicate(sid, dict(state)))
            except Exception:
                should_remove = False
            if should_remove:
                _sessions.pop(sid, None)
                removed += 1
    return removed
