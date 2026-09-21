"""Property/fuzz tests for the companion timecode helpers (api._tc_to_frames / _frames_to_tc).

Both use a nominal integer base (round(fps)) so frame↔TC must round-trip EXACTLY at
every rate, including fractional (23.976 / 29.97 / 59.94). Mirrors the JS
tests-js/timecodeFuzz.test.mjs. Seeded → reproducible.
"""
import random

from postflowx_companion.api import _tc_to_frames, _frames_to_tc

RATES = [24, 25, 30, 50, 60, 23.976, 29.97, 59.94]


def test_frame_tc_roundtrip_all_rates():
    rng = random.Random(0xC0FFEE)
    for fps in RATES:
        for _ in range(3000):
            f = rng.randint(0, 30 * 3600 * 60)  # up to 30h @60
            tc = _frames_to_tc(f, fps)
            assert _tc_to_frames(tc, fps) == f, f"roundtrip @ {fps}: f={f} tc={tc}"


def test_frames_to_tc_format():
    assert _frames_to_tc(0, 24) == "00:00:00:00"
    assert _frames_to_tc(24, 24) == "00:00:01:00"
    assert _frames_to_tc(24 * 3600, 24) == "01:00:00:00"
    # fractional rate uses nominal 24 base
    assert _frames_to_tc(24, 23.976) == "00:00:01:00"


def test_tc_to_frames_parsing():
    assert _tc_to_frames("01:00:00:00", 24) == 86400
    assert _tc_to_frames("00:00:00:12", 24) == 12
    # drop-frame ';' separator accepted (treated on nominal base)
    assert _tc_to_frames("01;00;00;00", 30) == 108000
    # malformed → 0, never raises
    assert _tc_to_frames("garbage", 24) == 0
    assert _tc_to_frames("", 24) == 0


def test_negative_and_clamps():
    assert _frames_to_tc(-5, 24) == "00:00:00:00"   # clamps to 0
