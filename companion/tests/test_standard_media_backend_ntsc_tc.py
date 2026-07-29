"""standard_media_backend's _frames_to_tc() truncated fps via int(fps)
instead of rounding to the nominal whole-frame rate (Iteration 83).

For NTSC-derived rates (23.976, 29.97, 59.94 fps -- near-universal in
professional cinema/broadcast delivery), int(fps) drops a whole frame per
second (int(23.976) == 23), so timecodes computed from get_frame()'s
"timecode" field drift further wrong the later the frame index is. This
was flagged as a known-but-deferred instance of the "nominal frame-rate
base" bug back in Iteration 49 (which fixed the same class of bug in
_probe_ocf_file) but never actually fixed here.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.media.backends.standard_media_backend import (  # noqa: E402
    _frames_to_tc,
)


def test_ntsc_2398_rate_uses_nominal_24_not_truncated_23():
    # frame 100 at 23.976fps: correct nominal-24fps timecode is 00:00:04:04.
    # Truncating to int(23.976) == 23 wrongly yields 00:00:04:08.
    assert _frames_to_tc(100, 23.976) == "00:00:04:04"


def test_ntsc_2997_rate_uses_nominal_30_not_truncated_29():
    assert _frames_to_tc(300, 29.97) == "00:00:10:00"


def test_whole_number_fps_unaffected():
    assert _frames_to_tc(100, 24.0) == "00:00:04:04"
    assert _frames_to_tc(48, 24.0) == "00:00:02:00"


def test_drift_grows_with_frame_index_for_truncated_rate():
    # Sanity check that the bug (if reintroduced) would compound: at frame
    # 10000, truncated-23 and nominal-24 disagree by whole seconds, not
    # just a frame or two, confirming this isn't a one-off rounding nit.
    correct = _frames_to_tc(10000, 23.976)
    h, m, s, f = (int(x) for x in correct.split(":"))
    assert h == 0 and m == 6 and s == 56 and f == 16
