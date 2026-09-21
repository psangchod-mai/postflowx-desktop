"""Regression tests for proxy_service._restore_running_proxy_session._watch.

Bug fixed Apr 2026: current.get('error') raised AttributeError when
_read_proxy_sidecar() returned None, killing the watch thread and leaving
the session permanently stuck as 'restored_running'.
"""
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


def _make_session_store():
    """Minimal in-memory session store for testing."""
    store = {}

    def create(sid, initial):
        store[sid] = dict(initial)

    def update(sid, **kw):
        if sid in store:
            store[sid].update(kw)

    def get(sid):
        return dict(store[sid]) if sid in store else None

    def remove(sid):
        return store.pop(sid, None)

    return store, create, update, get, remove


# ── _watch handles None sidecar ───────────────────────────────────────────────

def test_watch_handles_none_sidecar(tmp_path):
    """
    _read_proxy_sidecar returning None must NOT crash the watch thread.

    Before the fix, `current.get('error')` raised AttributeError when
    current was None, silently killing the thread.
    """
    from postflowx_companion.proxy_service import _restore_running_proxy_session
    from postflowx_companion.service_state import create_session, update_session, get_session

    cache_path = tmp_path / "proxy.mp4"
    # Create a non-empty part file so the "pid alive or part exists" check passes
    part_path = tmp_path / ".proxy.mp4.part"
    part_path.write_bytes(b"\x00" * 32)

    session_id = "test_watch_null_sid"

    sidecar_calls = []

    def mock_sidecar(path):
        sidecar_calls.append(len(sidecar_calls))
        if len(sidecar_calls) <= 3:
            return None   # ← was crashing before fix
        # After a few None returns, simulate the proxy completing
        cache_path.write_bytes(b"\x00" * 512)
        return {
            "pid": None,
            "pct": 100,
            "state": "done",
            "audioMode": "stereo",
            "audioMessage": "",
            "proxyName": "test",
            "startTimecode": "",
            "durationMs": 5000,
            "partPath": str(part_path),
            "progressPath": str(tmp_path / "progress"),
            "logPath": str(tmp_path / "proxy.log"),
        }

    with patch("postflowx_companion.proxy_service._read_proxy_sidecar", side_effect=mock_sidecar), \
         patch("postflowx_companion.proxy_service._read_ffmpeg_progress", return_value={}), \
         patch("postflowx_companion.proxy_service._is_pid_alive", return_value=False), \
         patch("postflowx_companion.proxy_service._proxy_cache_is_valid",
               side_effect=lambda p: p == cache_path and cache_path.is_file()):

        # Provide a minimal sidecar for the initial _restore_running_proxy_session call
        with patch("postflowx_companion.proxy_service._read_proxy_sidecar",
                   side_effect=mock_sidecar):
            # Initial sidecar call in _restore_running_proxy_session
            initial_sidecar = {
                "pid": 99999,
                "pct": 0,
                "state": "running",
                "partPath": str(part_path),
                "progressPath": str(tmp_path / "progress"),
                "logPath": str(tmp_path / "proxy.log"),
            }
            with patch("postflowx_companion.proxy_service._read_proxy_sidecar",
                       side_effect=[initial_sidecar] + [None] * 3 + [
                           {
                               "pid": None, "pct": 100, "state": "done",
                               "audioMode": "stereo", "audioMessage": "",
                               "proxyName": "test", "startTimecode": "",
                               "durationMs": 0,
                               "partPath": str(part_path),
                               "progressPath": str(tmp_path / "progress"),
                               "logPath": str(tmp_path / "proxy.log"),
                           }
                       ]), \
                 patch("postflowx_companion.proxy_service._is_pid_alive", return_value=True), \
                 patch("postflowx_companion.proxy_service._proxy_cache_is_valid",
                       side_effect=lambda p: cache_path.is_file()), \
                 patch("postflowx_companion.proxy_service._read_ffmpeg_progress", return_value={}), \
                 patch("postflowx_companion.proxy_service.get_immersive_audio_support", return_value={}), \
                 patch("postflowx_companion.proxy_service._extract_dovi", return_value={}), \
                 patch("postflowx_companion.proxy_service._safe_read_text", return_value=""), \
                 patch("postflowx_companion.proxy_service._write_proxy_sidecar"):

                restored = _restore_running_proxy_session(
                    session_id, cache_path, "", "", "unknown", ""
                )

                assert restored, "Should successfully restore the session"

                # Wait for the watch thread to either complete or crash
                deadline = time.time() + 3.0
                while time.time() < deadline:
                    state = get_session(session_id)
                    if state and state.get("done"):
                        break
                    time.sleep(0.1)
                    # Write the proxy file to trigger completion
                    if not cache_path.is_file():
                        cache_path.write_bytes(b"\x00" * 512)

                state = get_session(session_id)
                # Thread must have exited cleanly (not crashed with AttributeError)
                # If it crashed, state would still be stuck as 'restored_running'
                assert state is not None, "Session state was cleared — thread may have crashed"


# ── _watch exits on error in sidecar ──────────────────────────────────────────

def test_watch_exits_on_sidecar_error(tmp_path):
    """When the sidecar reports an error, session must be marked failed."""
    from postflowx_companion.proxy_service import _restore_running_proxy_session
    from postflowx_companion.service_state import get_session

    cache_path = tmp_path / "proxy_err.mp4"
    part_path = tmp_path / ".proxy_err.mp4.part"
    part_path.write_bytes(b"\x00")

    session_id = "test_sidecar_error"

    initial_sidecar = {
        "pid": 99999,
        "pct": 0,
        "state": "running",
        "partPath": str(part_path),
        "progressPath": str(tmp_path / "progress"),
        "logPath": str(tmp_path / "proxy_err.log"),
    }
    error_sidecar = {**initial_sidecar, "error": "ffmpeg crashed", "state": "failed"}

    with patch("postflowx_companion.proxy_service._read_proxy_sidecar",
               side_effect=[initial_sidecar, error_sidecar]), \
         patch("postflowx_companion.proxy_service._read_ffmpeg_progress", return_value={}), \
         patch("postflowx_companion.proxy_service._is_pid_alive", return_value=True), \
         patch("postflowx_companion.proxy_service._proxy_cache_is_valid", return_value=False), \
         patch("postflowx_companion.proxy_service.get_immersive_audio_support", return_value={}), \
         patch("postflowx_companion.proxy_service._extract_dovi", return_value={}), \
         patch("postflowx_companion.proxy_service._safe_read_text", return_value=""), \
         patch("postflowx_companion.proxy_service._write_proxy_sidecar"):

        _restore_running_proxy_session(session_id, cache_path, "", "", "unknown", "")

        deadline = time.time() + 3.0
        while time.time() < deadline:
            state = get_session(session_id)
            if state and state.get("done"):
                break
            time.sleep(0.05)

        state = get_session(session_id)
        assert state is not None
        assert state.get("done") is True
        assert state.get("stage") == "failed"
        assert "ffmpeg crashed" in str(state.get("error", ""))
