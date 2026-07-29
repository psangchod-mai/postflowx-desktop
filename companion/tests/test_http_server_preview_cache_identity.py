"""http_server.py's _preview_proxy_path() derived the preview-proxy cache
path purely from the sanitized basename of orig_name, with no cache_key
folded in even though every call site had one available (Iteration 90).

Two uploads that merely share a basename -- e.g. the same-named clip
re-uploaded from a different folder/camera card, under a different
cache_key/session -- collided on the exact same
{out_dir}/{stem}_proxy.mp4 path. This was worse than a simple overwrite:
the /cache/lookup/ handler's fallback (when the cacheKey-keyed JSON
sidecar lookup misses) accepts any existing file at that basename-derived
path and reports {"found": True, ...}, handing back a stale, unrelated
source's proxy to a session that never rendered one.

The fix mixes a sanitized cache_key into the stem, matching the identity
signal already used to key the JSON sidecar map in
_preview_cache_entries().
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.http_server import _preview_proxy_path  # noqa: E402


def test_same_basename_different_cache_key_gets_different_path(tmp_path):
    out_dir = str(tmp_path)
    path_a = _preview_proxy_path(out_dir, "interview.mov", "session-a-key")
    path_b = _preview_proxy_path(out_dir, "interview.mov", "session-b-key")
    assert path_a != path_b


def test_same_cache_key_gets_stable_path(tmp_path):
    out_dir = str(tmp_path)
    path_1 = _preview_proxy_path(out_dir, "interview.mov", "same-key")
    path_2 = _preview_proxy_path(out_dir, "interview.mov", "same-key")
    assert path_1 == path_2


def test_missing_cache_key_falls_back_to_basename_only(tmp_path):
    out_dir = str(tmp_path)
    path = _preview_proxy_path(out_dir, "interview.mov", "")
    assert path.endswith("interview_proxy.mp4")
