"""ocf_engine/ocf_proxy.py's generate_proxy() derived its output filename
purely from the sanitized basename of clip_path (_safe_stem), with no
folder path, size, mtime, or content-identity signal mixed in (Iteration 88).

Camera OCF reel/card names commonly reset per shoot day or card format
(e.g. "A001_C001_01.mov"). When two different projects each contain a clip
with the same reel name and the caller doesn't supply outputDir (the normal
UI path -- see ocfViewer.js's _startProxy(), which never passes outputDir),
both proxies land in the same shared _OCF_PROXY_DIR under the identical
filename, so the second generation silently overwrites the first project's
proxy. proxy_service.py's _stable_proxy_cache_key() already guards against
this exact class of bug for IMF proxies by keying on folder+cpl+size+mtime;
ocf_proxy.py had no equivalent for OCF clip proxies.

The fix mixes a source-identity hash (resolved path + size + mtime,
mirroring _stable_proxy_cache_key) into the output filename so same-named
clips from different sources/content never collide.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.ocf_engine.ocf_proxy import _source_identity_key  # noqa: E402


def test_same_basename_different_content_gets_different_identity_key(tmp_path):
    # Two different source files that happen to share a camera reel name.
    project_a = tmp_path / "project_a"
    project_b = tmp_path / "project_b"
    project_a.mkdir()
    project_b.mkdir()
    clip_a = project_a / "A001_C001_01.mov"
    clip_b = project_b / "A001_C001_01.mov"
    clip_a.write_bytes(b"project a footage")
    clip_b.write_bytes(b"project b footage, different size")

    key_a = _source_identity_key(str(clip_a))
    key_b = _source_identity_key(str(clip_b))
    assert key_a != key_b


def test_same_file_gets_stable_identity_key(tmp_path):
    clip = tmp_path / "A001_C001_01.mov"
    clip.write_bytes(b"same footage")
    assert _source_identity_key(str(clip)) == _source_identity_key(str(clip))


def test_missing_file_does_not_raise(tmp_path):
    missing = tmp_path / "does_not_exist.mov"
    # Should fall back gracefully (e.g. a path-only key) rather than crash.
    key = _source_identity_key(str(missing))
    assert isinstance(key, str) and key
