"""generate_proxy_async() mid-run progress persistence regression (Iteration 78).

`_run()` fetched a snapshot via `get_session()` (which returns a *copy* of the
stored session dict, by design) and called `.update(...)` on that local copy.
The mutated copy was discarded -- never passed to `update_session()`, which
wasn't even imported -- so the "transcoding / 5%" progress update never
reached the actual session store. Callers polling session status during a
transcode would see the job stuck at "queued / 0%" for the whole run.
"""
from __future__ import annotations

import threading

from postflowx_companion import service_state
from postflowx_companion.media_engine import proxy_engine


def test_transcoding_progress_is_visible_to_session_pollers(monkeypatch):
    session_id = "test-proxy-progress-session"
    reached_transcoding = threading.Event()
    release = threading.Event()

    def fake_generate_proxy(**kwargs):
        reached_transcoding.set()
        release.wait(timeout=5)
        return {"ok": True, "proxyPath": "/tmp/fake_proxy.mp4", "meta": {}}

    monkeypatch.setattr(proxy_engine, "generate_proxy", fake_generate_proxy)

    proxy_engine.generate_proxy_async(
        source_path="/tmp/fake_source.mov",
        output_dir="/tmp",
        session_id=session_id,
    )

    assert reached_transcoding.wait(timeout=5), "worker thread never called generate_proxy"

    state = service_state.get_session(session_id)
    assert state["stage"] == "transcoding"
    assert state["pct"] == 5

    release.set()
