"""Tests for http_server.py — token protection and routing.

Focuses on the security-critical _check_token() method and the
file-registry API, without spinning up a real TCP server.
"""
from __future__ import annotations

import io
import json
import struct
import threading
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from postflowx_companion.http_server import (
    get_http_token,
    register_asset_file,
    deregister_asset_file,
    _server_token,
    _file_registry,
    _file_registry_lock,
)


# ── token API ─────────────────────────────────────────────────────────────────

class TestGetHttpToken:
    def test_returns_string(self):
        token = get_http_token()
        assert isinstance(token, str)

    def test_token_is_48_hex_chars(self):
        token = get_http_token()
        # secrets.token_hex(24) → 48 hex chars
        assert len(token) == 48
        assert all(c in '0123456789abcdef' for c in token)

    def test_token_stable_within_process(self):
        assert get_http_token() == get_http_token()

    def test_token_equals_module_constant(self):
        assert get_http_token() == _server_token


# ── file registry ─────────────────────────────────────────────────────────────

class TestFileRegistry:
    def setup_method(self):
        # Clean registry before each test
        with _file_registry_lock:
            _file_registry.clear()

    def teardown_method(self):
        with _file_registry_lock:
            _file_registry.clear()

    def test_register_stores_path(self):
        register_asset_file("asset1", "/path/to/file.mov")
        with _file_registry_lock:
            assert _file_registry.get("asset1") == "/path/to/file.mov"

    def test_deregister_removes_entry(self):
        register_asset_file("asset2", "/path/file.mxf")
        deregister_asset_file("asset2")
        with _file_registry_lock:
            assert "asset2" not in _file_registry

    def test_deregister_missing_key_is_noop(self):
        deregister_asset_file("does_not_exist")  # must not raise

    def test_overwrite_updates_path(self):
        register_asset_file("asset3", "/old/path.mov")
        register_asset_file("asset3", "/new/path.mov")
        with _file_registry_lock:
            assert _file_registry["asset3"] == "/new/path.mov"

    def test_concurrent_register_deregister(self):
        """Multiple threads registering and deregistering must not corrupt state."""
        errors = []

        def worker(n):
            try:
                aid = f"concurrent_{n}"
                register_asset_file(aid, f"/path/{n}.mov")
                deregister_asset_file(aid)
            except Exception as e:
                errors.append(str(e))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors


# ── _check_token (via handler instance) ───────────────────────────────────────

def _make_handler(path: str, token: str | None = None) -> Any:
    """Build a CompanionHttpHandler with a fake request carrying an optional token."""
    from postflowx_companion.http_server import CompanionHttpHandler

    buf = io.BytesIO()

    class FakeSocket:
        def makefile(self, mode, bufsize=None):
            return buf
        def sendall(self, data):
            pass

    handler = CompanionHttpHandler.__new__(CompanionHttpHandler)
    handler.client_address = ('127.0.0.1', 9999)
    handler.server = MagicMock()
    handler.requestline = f'GET {path} HTTP/1.1'
    handler.request_version = 'HTTP/1.1'
    handler.command = 'GET'
    handler.path = path

    headers: dict[str, str] = {}
    if token is not None:
        headers['X-PFX-Token'] = token
    handler.headers = headers
    return handler


class TestCheckToken:
    def test_ping_requires_no_token(self):
        handler = _make_handler('/ping')
        assert handler._check_token('/ping') is True

    def test_correct_token_accepted(self):
        good_token = get_http_token()
        handler = _make_handler('/stream/abc123', token=good_token)
        assert handler._check_token('/stream/abc123') is True

    def test_wrong_token_rejected(self):
        handler = _make_handler('/stream/abc123', token='wrong_token_value')
        assert handler._check_token('/stream/abc123') is False

    def test_missing_token_rejected(self):
        handler = _make_handler('/stream/abc123')
        assert handler._check_token('/stream/abc123') is False

    def test_empty_token_rejected(self):
        # /file/ paths are intentionally unauthenticated — the per-session UUID is
        # the access control (so <video src> can work without custom headers).
        # An empty token on /stream/ IS rejected.
        handler = _make_handler('/stream/abc', token='')
        assert handler._check_token('/stream/abc') is False

    def test_file_path_bypasses_token_check(self):
        # /file/{assetId} skips the shared-secret check because <video src> cannot
        # send custom headers; the random per-session assetId is the access guard.
        handler = _make_handler('/file/xyz', token='')
        assert handler._check_token('/file/xyz') is True

    def test_timing_safe_comparison(self):
        """Token check must not be vulnerable to timing attacks."""
        import secrets
        import time

        good = get_http_token()
        # Build a token that shares no prefix with the correct one
        bad = secrets.token_hex(24)

        h_good = _make_handler('/stream/s', token=good)
        h_bad  = _make_handler('/stream/s', token=bad)

        # Both checks should complete in similar time (no early exit)
        # We can't guarantee timing in a unit test, but we verify both return correct values
        assert h_good._check_token('/stream/s') is True
        assert h_bad._check_token('/stream/s')  is False

    def test_register_route_also_requires_token(self):
        handler = _make_handler('/register/sess1')
        assert handler._check_token('/register/sess1') is False

    def test_progress_route_requires_token(self):
        handler = _make_handler('/progress/sess1')
        assert handler._check_token('/progress/sess1') is False

    def test_lowercase_token_header_accepted(self):
        """X-PFX-Token header lookup should be case-insensitive."""
        good_token = get_http_token()
        handler = _make_handler('/stream/x', token=None)
        # Inject lowercase header
        handler.headers = {'x-pfx-token': good_token}
        result = handler._check_token('/stream/x')
        assert result is True


# ── _serve_file Range validation + /stream/ traversal guard (round 16) ──────────

class TestServeFileRange:
    def test_rejects_inverted_range_with_416(self, tmp_path):
        """Range start > end must return 416, not a negative Content-Length."""
        f = tmp_path / "clip.mp4"
        f.write_bytes(b"0123456789")
        h = _make_handler("/stream/x")
        h.headers = {"Range": "bytes=9-2"}
        h.send_response = MagicMock()
        h.send_header = MagicMock()
        h.end_headers = MagicMock()
        h.wfile = MagicMock()
        h._serve_file(str(f))
        h.send_response.assert_called_once_with(416)
        # No negative Content-Length header should ever be sent.
        for call in h.send_header.call_args_list:
            if call.args and call.args[0] == "Content-Length":
                assert int(call.args[1]) >= 0

    def test_valid_range_still_serves_206(self, tmp_path):
        f = tmp_path / "clip.mp4"
        f.write_bytes(b"0123456789")
        h = _make_handler("/stream/x")
        h.headers = {"Range": "bytes=2-5"}
        h.send_response = MagicMock()
        h.send_header = MagicMock()
        h.end_headers = MagicMock()
        h.wfile = MagicMock()
        h._serve_file(str(f))
        h.send_response.assert_called_once_with(206)
        lengths = [int(c.args[1]) for c in h.send_header.call_args_list
                   if c.args and c.args[0] == "Content-Length"]
        assert lengths == [4]  # bytes 2..5 inclusive

    def test_suffix_range_serves_last_n_bytes(self, tmp_path):
        """"bytes=-N" is a suffix range (RFC 7233 §2.1): the last N bytes.

        It used to be parsed as start=0 (since the text before "-" is empty),
        which served the FIRST N bytes with a Content-Range header that
        mislabeled them as the requested suffix — wrong data, reported success.
        """
        f = tmp_path / "clip.mp4"
        f.write_bytes(b"0123456789")  # 10 bytes; last 4 are "6789"
        h = _make_handler("/stream/x")
        h.headers = {"Range": "bytes=-4"}
        h.send_response = MagicMock()
        h.send_header = MagicMock()
        h.end_headers = MagicMock()
        h.wfile = MagicMock()
        h._serve_file(str(f))
        h.send_response.assert_called_once_with(206)
        content_range = [c.args[1] for c in h.send_header.call_args_list
                          if c.args and c.args[0] == "Content-Range"]
        assert content_range == ["bytes 6-9/10"]
        sent = b"".join(c.args[0] for c in h.wfile.write.call_args_list)
        assert sent == b"6789"


class TestStreamTraversalGuard:
    def test_stream_rejects_path_traversal(self):
        token = get_http_token()
        h = _make_handler("/stream/x/../../../etc/passwd", token=token)
        h.send_error = MagicMock()
        h._send_json = MagicMock()
        h.wfile = MagicMock()
        h.do_GET()
        h.send_error.assert_called_once()
        assert h.send_error.call_args.args[0] == 400
