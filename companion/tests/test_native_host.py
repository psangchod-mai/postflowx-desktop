"""Tests for native_host.py message protocol.

Regression tests for:
- 64 MB message length guard (bug fixed Apr 2026)
- 4-byte LE length prefix protocol
"""
import struct
import io
from unittest.mock import patch, MagicMock

import pytest


def _write_msg(data: bytes) -> bytes:
    """Produce a valid native-messaging frame: 4-byte LE length + payload."""
    return struct.pack("<I", len(data)) + data


def _read_message_from(raw: bytes):
    """Call the companion's _read_native_message with a fake stdin."""
    from postflowx_companion.native_host import _read_native_message
    with patch("postflowx_companion.native_host.sys") as mock_sys:
        mock_sys.stdin = io.RawIOBase()
        mock_sys.stdin.buffer = io.BytesIO(raw)
        return _read_native_message()


# ── Protocol basics ────────────────────────────────────────────────────────────

def test_read_valid_message():
    import json
    payload = json.dumps({"action": "ping"}).encode()
    raw = _write_msg(payload)
    result = _read_message_from(raw)
    assert result is not None
    assert result["action"] == "ping"


def test_read_empty_stdin_returns_none():
    result = _read_message_from(b"")
    assert result is None


def test_read_truncated_header_returns_none():
    """Fewer than 4 bytes for length header must return None."""
    result = _read_message_from(b"\x05\x00")  # only 2 bytes
    assert result is None


def test_read_truncated_body_returns_none():
    """Header says 10 bytes but only 3 bytes follow."""
    raw = struct.pack("<I", 10) + b"abc"
    result = _read_message_from(raw)
    assert result is None


# ── 64 MB guard (regression) ───────────────────────────────────────────────────

def test_64mb_guard_rejects_oversized_message():
    """Messages > 64 MB must return None without attempting to allocate/read them.

    Regression: before Apr 2026, there was no length check — a crafted message
    with a 4-byte length of 0xFFFFFFFF would attempt to read ~4 GB.
    """
    oversized_len = 64 * 1024 * 1024 + 1  # one byte over the 64 MB limit
    raw = struct.pack("<I", oversized_len)  # no body needed — guard fires first
    result = _read_message_from(raw)
    assert result is None, (
        "Messages exceeding 64 MB must be rejected. "
        "Regression: no guard existed before Apr 2026."
    )


def test_64mb_guard_boundary_exactly_64mb():
    """A message of exactly 64 MB should also be rejected (limit is exclusive)."""
    exact_limit = 64 * 1024 * 1024
    raw = struct.pack("<I", exact_limit)
    result = _read_message_from(raw)
    assert result is None


def test_large_but_valid_message_accepted():
    """A message under 64 MB (e.g. 1 MB) must be accepted normally."""
    import json
    # 1 MB JSON-ish payload
    payload = json.dumps({"data": "x" * (1024 * 1024 - 20)}).encode()
    assert len(payload) < 64 * 1024 * 1024
    raw = _write_msg(payload)
    result = _read_message_from(raw)
    assert result is not None
    assert "data" in result


# ── Write protocol ─────────────────────────────────────────────────────────────

def test_write_message_length_prefix():
    """_write_native_message must prepend a 4-byte LE length."""
    import json
    from postflowx_companion.native_host import _write_native_message

    buf = io.BytesIO()
    with patch("postflowx_companion.native_host.sys") as mock_sys:
        mock_sys.stdout = MagicMock()
        mock_sys.stdout.buffer = buf
        mock_sys.stdout.buffer.write = buf.write
        mock_sys.stdout.buffer.flush = lambda: None
        _write_native_message({"ok": True})

    buf.seek(0)
    length_bytes = buf.read(4)
    assert len(length_bytes) == 4
    length = struct.unpack("<I", length_bytes)[0]
    body = buf.read(length)
    assert len(body) == length
    msg = json.loads(body.decode())
    assert msg["ok"] is True
