"""ffmpeg_frame_server's decode_frame() derived its output cache filename only
from frame_number and output_format, never from the source clip path
(Iteration 82).

The companion HTTP server runs as a ThreadingHTTPServer, so concurrent
decode-frame requests for two different clips run in parallel threads. If
both requests target the same frame_number/format (a common case — e.g. two
panels both previewing frame 100), they computed the identical output path
and raced to write it, so one caller could silently receive a frame decoded
from the wrong clip.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.media_engine.ffmpeg_frame_server import (  # noqa: E402
    _frame_cache_key,
)


def test_different_paths_produce_different_cache_keys():
    key_a = _frame_cache_key("/media/clip_a.mov", 100, 960, "png")
    key_b = _frame_cache_key("/media/clip_b.mov", 100, 960, "png")
    assert key_a != key_b


def test_same_inputs_produce_same_cache_key():
    key_1 = _frame_cache_key("/media/clip_a.mov", 100, 960, "png")
    key_2 = _frame_cache_key("/media/clip_a.mov", 100, 960, "png")
    assert key_1 == key_2


def test_different_frame_number_or_scale_or_format_changes_key():
    base = _frame_cache_key("/media/clip_a.mov", 100, 960, "png")
    assert base != _frame_cache_key("/media/clip_a.mov", 101, 960, "png")
    assert base != _frame_cache_key("/media/clip_a.mov", 100, 1280, "png")
    assert base != _frame_cache_key("/media/clip_a.mov", 100, 960, "jpg")


def test_decode_frame_output_path_keys_on_source_clip(monkeypatch, tmp_path):
    from postflowx_companion.media_engine import ffmpeg_frame_server as mod

    monkeypatch.setattr(mod, "_FRAME_DIR", tmp_path)
    monkeypatch.setattr(mod, "find_ffmpeg", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(mod, "_log", lambda *a, **k: None)

    captured_paths = []

    class _FakeResult:
        returncode = 0
        stderr = ""

    def _fake_run(cmd, **kwargs):
        out_file = cmd[-1]
        captured_paths.append(out_file)
        with open(out_file, "wb") as f:
            f.write(b"fake")
        return _FakeResult()

    monkeypatch.setattr(mod.subprocess, "run", _fake_run)

    mod.decode_frame("/media/clip_a.mov", frame_number=100, output_format="png")
    mod.decode_frame("/media/clip_b.mov", frame_number=100, output_format="png")

    assert captured_paths[0] != captured_paths[1]
