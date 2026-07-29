"""Regression tests for conform_engine.parse_edl (CMX3600 EDL parsing)."""
from __future__ import annotations

from postflowx_companion.engines.conform_engine import _tc_to_frames, parse_edl


def test_parse_edl_keeps_dissolve_and_wipe_events():
    # A CMX3600 EDL with a cut, a dissolve (extra transition-duration token),
    # and a wipe. A regex hardcoded to literal "C" silently drops the last two.
    edl = "\n".join([
        "TITLE: TEST",
        "FCM: NON-DROP FRAME",
        "",
        "001  AX       V     C        00:00:00:00 00:00:05:18 01:00:00:00 01:00:05:18",
        "* FROM CLIP NAME: shot_01.mov",
        "002  AX       V     D  024   00:00:10:00 00:00:12:11 01:00:05:18 01:00:07:29",
        "* FROM CLIP NAME: shot_02.mov",
        "003  AX       V     W001    00:00:20:00 00:00:22:00 01:00:07:29 01:00:09:29",
        "* FROM CLIP NAME: shot_03.mov",
    ])
    events = parse_edl(edl, fps=24.0)
    assert len(events) == 3, "cut, dissolve, and wipe events all parsed"
    assert [e.index for e in events] == [1, 2, 3]
    assert events[1].clip_name == "shot_02.mov"
    assert events[2].clip_name == "shot_03.mov"


def test_parse_edl_duration_frames_from_record_span_not_source_span():
    # Source and record spans differ deliberately (retimed/re-cut source);
    # duration_frames must reflect the RECORD span (authoritative timeline
    # duration), not the source span.
    edl = "\n".join([
        "TITLE: TEST",
        "FCM: NON-DROP FRAME",
        "",
        "001  AX       V     C        00:00:00:00 00:00:02:00 01:00:00:00 01:00:04:00",
    ])
    events = parse_edl(edl, fps=24.0)
    assert len(events) == 1
    record_span = _tc_to_frames("01:00:04:00", 24.0) - _tc_to_frames("01:00:00:00", 24.0)
    source_span = _tc_to_frames("00:00:02:00", 24.0) - _tc_to_frames("00:00:00:00", 24.0)
    assert record_span == 96
    assert source_span == 48
    assert events[0].duration_frames == 96, "duration derived from record span, not source span"
