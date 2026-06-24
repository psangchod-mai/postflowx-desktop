"""Tests for media/ring_buffer.py — PrefetchScheduler.

Regression test for: _do_decode passed None as handle (bug fixed Apr 2026).
"""
import threading
import time
from unittest.mock import MagicMock, call

import pytest

from postflowx_companion.media.ring_buffer import PrefetchScheduler


def _make_cache(hits=None):
    """Minimal cache mock — get() returns None (cache miss) by default."""
    cache = MagicMock()
    cache.make_key.side_effect = lambda sid, fi, *a, **kw: f"{sid}:{fi}"
    cache.get.return_value = hits  # None = miss
    return cache


def _make_backend():
    backend = MagicMock()
    backend.get_frame.return_value = {"dataUrl": "data:image/jpeg;base64,/9j/AA=="}
    return backend


# ── handle is passed through to get_frame ─────────────────────────────────────

def test_handle_passed_to_get_frame():
    """The handle from prefetch() must reach backend.get_frame(), not None."""
    scheduler = PrefetchScheduler(worker_count=1, buffer_size=8)
    backend = _make_backend()
    cache = _make_cache()
    sentinel_handle = "/path/to/file.mov"

    scheduler.prefetch(
        session_id="s1",
        current_frame=0,
        backend=backend,
        cache=cache,
        options={"quality": "half", "width": 1280, "height": 720, "format": "jpg"},
        count=1,
        direction=1,
        handle=sentinel_handle,
    )
    # Give the worker time to process
    time.sleep(0.3)
    scheduler.cancel_all()

    assert backend.get_frame.called, "get_frame should have been called"
    actual_handle = backend.get_frame.call_args[0][0]
    assert actual_handle == sentinel_handle, (
        f"Expected handle={sentinel_handle!r}, got {actual_handle!r}. "
        "Regression: handle was None before Apr 2026 fix."
    )


def test_none_handle_still_calls_get_frame():
    """When handle=None, get_frame is still called (may fail, but not silently dropped)."""
    scheduler = PrefetchScheduler(worker_count=1, buffer_size=8)
    backend = _make_backend()
    cache = _make_cache()

    scheduler.prefetch(
        session_id="s2",
        current_frame=0,
        backend=backend,
        cache=cache,
        options={},
        count=1,
        direction=1,
        handle=None,
    )
    time.sleep(0.3)
    scheduler.cancel_all()

    # get_frame called with None handle — backend may succeed or fail,
    # but the call is not silently dropped
    assert backend.get_frame.called


# ── cancellation ──────────────────────────────────────────────────────────────

def test_cancel_discards_pending_jobs():
    """Jobs enqueued for a session are discarded after cancel()."""
    slow_backend = MagicMock()
    event = threading.Event()

    def slow_get_frame(handle, frame_index, options):
        event.wait(timeout=5)
        return {"dataUrl": "data:image/jpeg;base64,AA=="}

    slow_backend.get_frame.side_effect = slow_get_frame
    cache = _make_cache()

    scheduler = PrefetchScheduler(worker_count=1, buffer_size=8)
    scheduler.prefetch(
        session_id="sess",
        current_frame=0,
        backend=slow_backend,
        cache=cache,
        options={},
        count=3,
        direction=1,
        handle="/f.mov",
    )
    time.sleep(0.05)
    scheduler.cancel("sess")
    event.set()  # unblock worker
    time.sleep(0.2)
    scheduler.cancel_all()

    # After cancel, inflight for that session should be empty
    with scheduler._lock:
        assert scheduler._inflight.get("sess", set()) == set()


def test_already_cached_frames_skipped():
    """Frames already in cache are not submitted as prefetch jobs."""
    backend = _make_backend()
    cache = _make_cache()
    # Simulate frame 1 already cached
    cache.get.side_effect = lambda key: "cached" if ":1" in key else None

    scheduler = PrefetchScheduler(worker_count=1, buffer_size=8)
    scheduler.prefetch(
        session_id="s",
        current_frame=0,
        backend=backend,
        cache=cache,
        options={},
        count=2,   # would try frames 1 and 2
        direction=1,
        handle="/f.mov",
    )
    time.sleep(0.3)
    scheduler.cancel_all()

    # Frame 1 was in cache — get_frame should only have been called for frame 2
    called_frames = [c[0][1] for c in backend.get_frame.call_args_list]
    assert 1 not in called_frames, "Cached frame 1 should not trigger a decode"


# ── stats ──────────────────────────────────────────────────────────────────────

def test_stats_reported():
    scheduler = PrefetchScheduler(worker_count=1, buffer_size=8)
    backend = _make_backend()
    cache = _make_cache()

    scheduler.prefetch("s", 0, backend, cache, {}, count=2, handle="/f")
    time.sleep(0.3)
    scheduler.cancel_all()

    stats = scheduler.stats()
    assert "submitted" in stats
    assert "completed" in stats
    assert stats["submitted"] >= 0
