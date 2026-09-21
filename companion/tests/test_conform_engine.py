"""Tests for Trailer Conform engine helpers."""
from __future__ import annotations

from pathlib import Path

from postflowx_companion.engines.conform_engine import (
    VIS_GRID,
    VIS_MAX_DISTANCE,
    ConformEvent,
    _event_ref_positions,
    _expand_source_inputs,
    _regional_distance,
    _regional_hash_from_gray,
    _tc_to_frames,
    _visual_score,
    _visual_status,
)


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


def test_regional_distance_discards_six_worst_cells():
    base = tuple(0 for _ in range(VIS_GRID * VIS_GRID))
    noisy = list(base)
    for i in range(6):
        noisy[i] = (1 << 64) - 1

    assert _regional_distance(base, tuple(noisy)) == 0


def test_visual_status_thresholds_match_v14():
    assert _visual_status(80) == "OK"
    assert _visual_status(81) == "REVIEW"
    assert _visual_status(200) == "REVIEW"
    assert _visual_status(201) == "NO_MATCH"
    assert _visual_score(0) == 1.0
    assert _visual_score(VIS_MAX_DISTANCE) == 0.0


def test_regional_hash_identical_frames_distance_zero():
    # VIS_SCALE_W x VIS_SCALE_H gradient; identical raw frames hash identically.
    from postflowx_companion.engines import conform_engine as ce

    raw = bytes((x % 256) for y in range(ce.VIS_SCALE_H) for x in range(ce.VIS_SCALE_W))
    h1 = _regional_hash_from_gray(raw)
    h2 = _regional_hash_from_gray(raw)

    assert h1 is not None
    assert h2 is not None
    assert _regional_distance(h1, h2) == 0


def test_event_ref_positions_subtract_first_record_tc_offset():
    fps = 24.0
    offset = _tc_to_frames("01:00:00:00", fps)
    event = ConformEvent(
        index=1,
        reel="AX",
        clip_name="shot",
        src_in="00:00:00:00",
        src_out="00:00:02:00",
        rec_in="01:00:10:00",
        rec_out="01:00:12:00",
        duration_frames=48,
        fps=fps,
        track="V",
        comment="",
    )

    assert _event_ref_positions(event, offset, 0, fps) == (240, 263, 287)
