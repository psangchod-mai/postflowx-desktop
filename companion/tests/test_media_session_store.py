"""Tests for media/media_session_store.py — thread-safe session store."""
import threading

from postflowx_companion.media.media_session_store import (
    create_media_session,
    get_media_session,
    update_media_session,
    close_media_session,
    list_media_sessions,
)


def _sid(n: int) -> str:
    return f"test_sess_{n}"


def test_create_and_get():
    sid = _sid(1)
    create_media_session(sid, {"filePath": "/a/b.mov", "backend": "standard"})
    s = get_media_session(sid)
    assert s is not None
    assert s["filePath"] == "/a/b.mov"
    assert s["backend"] == "standard"
    # Returned dict is a copy — mutations don't affect stored state
    s["filePath"] = "mutated"
    assert get_media_session(sid)["filePath"] == "/a/b.mov"
    close_media_session(sid)


def test_get_missing_returns_none():
    assert get_media_session("does_not_exist") is None


def test_update():
    sid = _sid(2)
    create_media_session(sid, {"cacheState": "pending"})
    update_media_session(sid, {"cacheState": "ready", "metadata": {"fps": 24}})
    s = get_media_session(sid)
    assert s["cacheState"] == "ready"
    assert s["metadata"] == {"fps": 24}
    close_media_session(sid)


def test_update_missing_session_returns_false():
    result = update_media_session("ghost", {"x": 1})
    assert result is False


def test_close_removes_session():
    sid = _sid(3)
    create_media_session(sid, {})
    assert get_media_session(sid) is not None
    close_media_session(sid)
    assert get_media_session(sid) is None


def test_close_missing_is_noop():
    close_media_session("no_such_session")  # must not raise


def test_list_sessions():
    sids = [_sid(10 + i) for i in range(3)]
    for s in sids:
        create_media_session(s, {"filePath": f"/f/{s}.mov"})

    listed = {s["sessionId"] for s in list_media_sessions()}
    assert set(sids).issubset(listed)

    for s in sids:
        close_media_session(s)


def test_concurrent_create_and_read():
    """Multiple threads creating/reading sessions must not corrupt each other."""
    errors = []
    created = []

    def worker(n):
        sid = f"concurrent_{n}"
        try:
            create_media_session(sid, {"n": n})
            s = get_media_session(sid)
            if s is None or s["n"] != n:
                errors.append(f"Data corruption for {sid}: got {s}")
            created.append(sid)
        except Exception as e:
            errors.append(str(e))

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    for sid in created:
        close_media_session(sid)

    assert not errors, f"Concurrent access errors: {errors}"


def test_default_fields_populated():
    """create_media_session must populate standard defaults."""
    sid = _sid(4)
    create_media_session(sid, {"filePath": "/test.mov"})
    s = get_media_session(sid)
    assert "sessionId" in s
    assert s["sessionId"] == sid
    assert "openedAt" in s
    assert "cacheState" in s
    close_media_session(sid)
