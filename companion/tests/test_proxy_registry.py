"""Tests for proxy_registry.py — content-addressable proxy cache registry."""
import json
import time
from pathlib import Path

import pytest

from postflowx_companion.proxy_registry import (
    content_fingerprint,
    lookup_proxy,
    register_proxy,
    prune_registry,
)


# ── content_fingerprint ────────────────────────────────────────────────────────

def test_fingerprint_is_stable():
    fp1 = content_fingerprint("uuid-abc", ["track-1", "track-2"], 2400, 24.0)
    fp2 = content_fingerprint("uuid-abc", ["track-1", "track-2"], 2400, 24.0)
    assert fp1 == fp2


def test_fingerprint_insensitive_to_track_order():
    fp1 = content_fingerprint("id", ["a", "b", "c"], 100, 24.0)
    fp2 = content_fingerprint("id", ["c", "a", "b"], 100, 24.0)
    assert fp1 == fp2, "Track order should not change the fingerprint"


def test_fingerprint_differs_on_different_cpl():
    fp1 = content_fingerprint("uuid-1", ["t"], 100, 24.0)
    fp2 = content_fingerprint("uuid-2", ["t"], 100, 24.0)
    assert fp1 != fp2


def test_fingerprint_normalises_edit_rate_string():
    fp_float = content_fingerprint("x", [], 0, 24.0)
    fp_str   = content_fingerprint("x", [], 0, "24 1")
    assert fp_float == fp_str, "Edit rate '24 1' and 24.0 should yield same fingerprint"


def test_fingerprint_strips_urn_prefix():
    fp1 = content_fingerprint("urn:uuid:abc-123", [], 0, 25.0)
    fp2 = content_fingerprint("abc-123", [], 0, 25.0)
    assert fp1 == fp2


def test_fingerprint_length():
    fp = content_fingerprint("id", [], 0, 24.0)
    assert len(fp) == 20


# ── register_proxy / lookup_proxy ─────────────────────────────────────────────

def test_register_and_lookup(tmp_path, monkeypatch):
    proxy_file = tmp_path / "proxy.mp4"
    proxy_file.write_bytes(b"\x00" * 1024)

    # Redirect registry to tmp dir
    monkeypatch.setattr(
        "postflowx_companion.proxy_registry._registry_path",
        lambda: tmp_path / "proxy_registry.json",
    )

    fp = content_fingerprint("cpl-test", ["tf-1"], 500, 24.0)
    register_proxy(fp, str(proxy_file), proxy_name="test_proxy", fps=24.0)

    entry = lookup_proxy(fp)
    assert entry is not None
    assert entry["proxyPath"] == str(proxy_file)
    assert entry["proxyName"] == "test_proxy"


def test_lookup_returns_none_for_unknown(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "postflowx_companion.proxy_registry._registry_path",
        lambda: tmp_path / "proxy_registry.json",
    )
    assert lookup_proxy("nonexistent_fp") is None


def test_lookup_removes_stale_entry(tmp_path, monkeypatch):
    proxy_file = tmp_path / "proxy.mp4"
    proxy_file.write_bytes(b"\x00" * 512)

    monkeypatch.setattr(
        "postflowx_companion.proxy_registry._registry_path",
        lambda: tmp_path / "proxy_registry.json",
    )

    fp = content_fingerprint("stale", [], 100, 24.0)
    register_proxy(fp, str(proxy_file))

    # Delete the proxy file to make it stale
    proxy_file.unlink()

    assert lookup_proxy(fp) is None, "Stale entry (deleted file) should return None"

    # Entry should be removed from registry
    reg_path = tmp_path / "proxy_registry.json"
    data = json.loads(reg_path.read_text())
    assert fp not in data.get("entries", {})


def test_register_noop_for_empty_file(tmp_path, monkeypatch):
    empty_file = tmp_path / "empty.mp4"
    empty_file.write_bytes(b"")

    monkeypatch.setattr(
        "postflowx_companion.proxy_registry._registry_path",
        lambda: tmp_path / "proxy_registry.json",
    )

    fp = content_fingerprint("empty", [], 0, 24.0)
    register_proxy(fp, str(empty_file))

    assert lookup_proxy(fp) is None, "Empty file should not be registered"


# ── prune_registry ─────────────────────────────────────────────────────────────

def test_prune_removes_missing_files(tmp_path, monkeypatch):
    p1 = tmp_path / "live.mp4"
    p1.write_bytes(b"\x00" * 512)
    p2 = tmp_path / "gone.mp4"
    p2.write_bytes(b"\x00" * 512)

    monkeypatch.setattr(
        "postflowx_companion.proxy_registry._registry_path",
        lambda: tmp_path / "proxy_registry.json",
    )

    fp1 = content_fingerprint("live", [], 0, 24.0)
    fp2 = content_fingerprint("gone", [], 0, 24.0)
    register_proxy(fp1, str(p1))
    register_proxy(fp2, str(p2))

    p2.unlink()
    removed = prune_registry()

    assert removed == 1
    assert lookup_proxy(fp1) is not None
    assert lookup_proxy(fp2) is None
