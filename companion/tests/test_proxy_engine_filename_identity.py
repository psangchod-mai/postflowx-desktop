"""media_engine/proxy_engine.py's generate_proxy() derived its output filename
purely from src.stem, with no folder path, size, mtime, or content-identity
signal mixed in (Iteration 89) -- the same bug class already fixed in
ocf_engine/ocf_proxy.py (Iteration 88) and originally established by
proxy_service.py's _stable_proxy_cache_key().

This module is the one wired to the real, network-exposed HTTP endpoint
(/api/media/transcode-proxy in http_server.py), which reads sourcePath and
outputDir directly from the untrusted request body with no uniqueness guard.
Two different source clips sharing a filename stem (e.g. a reused camera reel
name across folders/projects) transcoded to the same outputDir would collide
at outputDir/proxies/{stem}_proxy.{mp4|mov}, silently overwriting the first
job's proxy and sidecar JSON.

The function also accepted a source_hash parameter that was stored into the
sidecar JSON metadata but never used to disambiguate the output path -- and
generate_proxy_async() (the only caller actually reachable from the HTTP API)
doesn't even forward source_hash, making it dead in the real call chain.

The fix adds _source_identity_key() (mirroring ocf_proxy.py's helper of the
same name / intent) and mixes it into the output filename.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.media_engine.proxy_engine import (  # noqa: E402
    _source_identity_key,
    generate_proxy,
)


def test_same_stem_different_content_gets_different_identity_key(tmp_path):
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
    key = _source_identity_key(str(missing))
    assert isinstance(key, str) and key


def test_same_stem_different_sources_do_not_collide_on_output_path(tmp_path, monkeypatch):
    # Two different source clips sharing a stem, transcoded to the same
    # outputDir (the real /api/media/transcode-proxy scenario), must not
    # produce the same proxy filename.
    project_a = tmp_path / "project_a"
    project_b = tmp_path / "project_b"
    project_a.mkdir()
    project_b.mkdir()
    clip_a = project_a / "A001_C001_01.mov"
    clip_b = project_b / "A001_C001_01.mov"
    clip_a.write_bytes(b"project a footage")
    clip_b.write_bytes(b"project b footage, different size")

    shared_output_dir = tmp_path / "shared_output"

    captured_paths = []

    def fake_transcode_proxy(**kwargs):
        captured_paths.append(kwargs["output_path"])
        return {"ok": True}

    monkeypatch.setattr(
        "postflowx_companion.media_engine.proxy_engine.transcode_proxy",
        fake_transcode_proxy,
    )

    generate_proxy(source_path=str(clip_a), output_dir=str(shared_output_dir))
    generate_proxy(source_path=str(clip_b), output_dir=str(shared_output_dir))

    assert captured_paths[0] != captured_paths[1]
