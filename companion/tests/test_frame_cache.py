"""Tests for media/frame_cache.py — LRU disk cache."""
import os
import tempfile
import threading
from pathlib import Path

import pytest

from postflowx_companion.media.frame_cache import FrameCache


@pytest.fixture
def cache(tmp_path):
    return FrameCache(tmp_path, max_bytes=10 * 1024 * 1024, max_entries=10)


def test_put_and_get(cache):
    key = FrameCache.make_key("s1", 0)
    data = b"\xff\xd8\xff" + b"\x00" * 100
    path = cache.put(key, data, session_id="s1", fmt="jpg")

    assert path.is_file()
    result = cache.get(key)
    assert result is not None
    assert result == path


def test_cache_miss_returns_none(cache):
    key = FrameCache.make_key("missing", 99)
    assert cache.get(key) is None


def test_stale_entry_removed_on_get(cache, tmp_path):
    key = FrameCache.make_key("s1", 5)
    data = b"\x00" * 50
    path = cache.put(key, data, session_id="s1")
    # Manually delete the file to simulate stale entry
    path.unlink()
    assert cache.get(key) is None
    assert key not in cache._index


def test_evict_session(cache):
    for i in range(5):
        k = FrameCache.make_key("sess_a", i)
        cache.put(k, b"\x00" * 64, session_id="sess_a")
    for i in range(3):
        k = FrameCache.make_key("sess_b", i)
        cache.put(k, b"\x00" * 64, session_id="sess_b")

    removed = cache.evict_session("sess_a")
    assert removed == 5
    for i in range(5):
        assert cache.get(FrameCache.make_key("sess_a", i)) is None
    for i in range(3):
        assert cache.get(FrameCache.make_key("sess_b", i)) is not None


def test_max_entries_eviction(cache):
    # Fill cache beyond max_entries (10)
    for i in range(15):
        k = FrameCache.make_key("s", i)
        cache.put(k, b"\x00" * 64, session_id="s")
    assert len(cache._index) <= 10


def test_concurrent_puts_no_crash(cache):
    """Two threads writing the same key must not raise — at worst one misses cache."""
    key = FrameCache.make_key("s", 42)
    data = b"\x00" * 128
    errors = []

    def writer():
        try:
            cache.put(key, data, session_id="s")
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=writer) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Should not crash; file should exist
    assert not errors
    result = cache.get(key)
    assert result is not None


def test_atomic_write_no_partial_file(cache):
    """put() uses atomic rename — no partial .tmp file left on success."""
    key = FrameCache.make_key("s", 1)
    data = b"\x00" * 256
    cache.put(key, data, session_id="s", fmt="jpg")

    tmp = cache._frames / f"{key}.jpg.tmp"
    assert not tmp.exists(), "Temp file should be cleaned up after successful put"


def test_index_persisted_and_reloaded(tmp_path):
    c1 = FrameCache(tmp_path)
    k = FrameCache.make_key("persist", 0)
    c1.put(k, b"\x00" * 32, session_id="persist")

    # New cache instance at same root should reload the index
    c2 = FrameCache(tmp_path)
    assert c2.get(k) is not None
