"""Tests for Trailer Conform engine helpers."""
from __future__ import annotations

from pathlib import Path

from postflowx_companion.engines.conform_engine import _expand_source_inputs


def test_expand_source_inputs_collects_supported_media(tmp_path):
    folder = tmp_path / "src"
    folder.mkdir()
    clip_a = folder / "A.mov"
    clip_b = folder / "B.r3d"
    ignored = folder / "notes.txt"
    nested = folder / "nested"
    nested.mkdir()
    clip_c = nested / "C.mxf"

    for path in (clip_a, clip_b, clip_c, ignored):
        path.write_bytes(b"x")

    result = _expand_source_inputs([str(clip_a)], str(folder))

    assert str(clip_a.resolve()) in result
    assert str(clip_b.resolve()) in result
    assert str(clip_c.resolve()) in result
    assert str(ignored.resolve()) not in result
