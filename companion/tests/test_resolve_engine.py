"""Tests for the Resolve background engine helpers."""
from __future__ import annotations

from pathlib import Path

from postflowx_companion.engines import resolve_engine
from postflowx_companion.service_state import create_session, get_session, remove_session


def test_detect_resolve_not_found_shape(monkeypatch):
    monkeypatch.setattr(resolve_engine, "_candidate_paths", lambda: [])

    result = resolve_engine.detect_resolve()

    assert result["ok"] is False
    assert result["found"] is False
    assert result["errorCode"] == "RESOLVE_NOT_FOUND"
    assert "resolvedPath" in result
    assert "scriptingAvailable" in result


def test_normalize_job_accepts_legacy_proxy_schema(tmp_path):
    src = tmp_path / "clip.mov"
    src.write_bytes(b"mov")

    job = {
        "jobId": "proxy_0001",
        "jobType": "proxy_export",
        "mediaFiles": [str(src)],
        "outputDir": str(tmp_path / "out"),
        "options": {"width": 640, "height": 360},
    }

    normalized = resolve_engine.normalize_job(job, timeout_seconds=45, debug=True)

    assert normalized["type"] == "proxy_export"
    assert normalized["inputMedia"] == [str(src)]
    assert normalized["settings"]["resolution"] == "640x360"
    assert normalized["timeoutSeconds"] == 45
    assert normalized["debugMode"] is True


def test_cancel_resolve_job_persists_cancel_flag():
    session_id = "resolve_cancel_test"
    create_session(session_id, {"_cancel": False, "done": False})

    try:
        assert resolve_engine.cancel_resolve_job(session_id) is True
        state = get_session(session_id)
        assert state is not None
        assert state["_cancel"] is True
        assert state["message"] == "Cancellation requested…"
    finally:
        remove_session(session_id)


def test_resolve_lifecycle_actions_are_registered(monkeypatch):
    from postflowx_companion.api import CompanionApi

    monkeypatch.setattr(resolve_engine, "detect_resolve", lambda: {
        "ok": False,
        "found": False,
        "paths": [],
        "selectedPath": "",
        "resolvedPath": "",
        "path": "",
        "version": "unknown",
        "scriptingAvailable": False,
        "apiAvailable": False,
        "reason": "not found",
    })
    monkeypatch.setattr(resolve_engine, "_resolve_is_running", lambda *args, **kwargs: False)
    monkeypatch.setattr(resolve_engine, "_get_resolve_app", lambda *args, **kwargs: None)

    api = CompanionApi()
    for action in [
        "resolve.engineStatus",
        "resolve.startEngine",
        "resolve.stopEngine",
        "resolve.listJobs",
        "resolve.clearQueue",
        "resolve.getLogs",
    ]:
        response = api.handle({"action": action, "launchPolicy": "never", "timeoutSeconds": 1})
        assert response["status"] == "ok", action
        assert "Unknown action" not in str(response)


def test_run_resolve_job_releases_semaphore_when_api_unavailable(tmp_path, monkeypatch):
    """Regression: when the scripting API never comes up, run_resolve_job_async
    must release _RESOLVE_JOB_SEM on its early return — otherwise every future
    Resolve job fails forever with RESOLVE_BUSY."""
    src = tmp_path / "clip.mov"
    src.write_bytes(b"mov")
    fake_resolve = tmp_path / "Resolve"
    fake_resolve.write_text("x")
    out_dir = tmp_path / "out"

    job = {
        "jobId": "sem_leak_test",
        "type": "proxy_export",
        "inputMedia": [str(src)],
        "outputDir": str(out_dir),
        "options": {"width": 640, "height": 360},
    }

    # Resolve "already running" so we skip launch, but the API hands back None.
    monkeypatch.setattr(resolve_engine, "_resolve_is_running", lambda *a, **k: True)
    monkeypatch.setattr(resolve_engine, "_get_resolve_app", lambda timeout=0: None)

    session_id = "sem_leak_sess"
    create_session(session_id, {"done": False})
    try:
        # Semaphore must be free at the start of the test.
        assert resolve_engine._RESOLVE_JOB_SEM.acquire(blocking=False) is True
        resolve_engine._RESOLVE_JOB_SEM.release()

        resolve_engine.run_resolve_job_async(
            session_id, job, str(fake_resolve), timeout_seconds=45,
        )

        # The job failed (API unavailable) — but the semaphore must be released.
        state = get_session(session_id)
        assert state is not None
        assert state.get("errorCode") == "RESOLVE_API_NOT_AVAILABLE"

        reacquired = resolve_engine._RESOLVE_JOB_SEM.acquire(blocking=False)
        assert reacquired is True, "semaphore leaked — RESOLVE_BUSY would block all future jobs"
        resolve_engine._RESOLVE_JOB_SEM.release()
    finally:
        remove_session(session_id)
