"""Regression test for _is_drop_frame_rate / _seconds_to_timecode.

Bug: the OCF preview/seek and batch-pick paths in api.py used
`fps in (29.97, 59.94, 23.976)` to decide drop-frame timecode formatting.
23.976 has no drop-frame variant -- only the 30-based NTSC rates
(29.97/59.94) do -- so a 23.976fps clip's timeline TC was built with a
semicolon separator (e.g. "01:00:04;10") instead of the correct colon
("01:00:04:10"), which DaVinci Resolve's SetCurrentTimecode/
GetCurrentTimecode on a non-drop timeline will not round-trip.
"""
from postflowx_companion.proxy_service import _is_drop_frame_rate, _seconds_to_timecode


def test_23976_is_not_drop_frame():
    assert _is_drop_frame_rate(23.976) is False


def test_2997_and_5994_are_drop_frame():
    assert _is_drop_frame_rate(29.97) is True
    assert _is_drop_frame_rate(59.94) is True


def test_whole_number_rates_are_not_drop_frame():
    assert _is_drop_frame_rate(24) is False
    assert _is_drop_frame_rate(25) is False
    assert _is_drop_frame_rate(30) is False


def test_seconds_to_timecode_uses_colon_separator_at_23976():
    tc = _seconds_to_timecode(3604.4166, 23.976, _is_drop_frame_rate(23.976))
    assert ';' not in tc
    assert tc.count(':') == 3
