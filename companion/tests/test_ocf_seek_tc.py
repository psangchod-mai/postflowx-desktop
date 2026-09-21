"""OCF preview seek: timecode-domain diagnostic math.

Locks in the seek computation used by vfx.preview.resolveStill
(_ocf_extract_via_resolve): the Resolve tier seeks to
(requestedTc − clipStartTc) frames into the clip. When editorial requestedTc and
the OCF's embedded clipStartTc are on the SAME clock, the offset is a small in-range
frame; when they are on DIFFERENT clocks, the raw offset lands far past the clip
end (outOfRange) and the code clamps to the last frame — the "wrong later frame"
the user sees. These tests use the REAL production _timecode_to_seconds.
"""
from __future__ import annotations

from postflowx_companion.proxy_service import _timecode_to_seconds


def _seek_diag(requested_tc: str, clip_start_tc: str, clip_frames: int, fps: float = 24.0,
               passed_start_tc: str = "") -> dict:
    """Mirror the frame math + clamp/out-of-range detection in api.py's
    _ocf_extract_via_resolve so the behavior is unit-verifiable without Resolve.
    Mirrors the fix: prefer the caller-supplied start TC over the embedded one."""
    used_start = (passed_start_tc or "").strip() or clip_start_tc
    raw_rel = max(0.0, _timecode_to_seconds(requested_tc, fps) - _timecode_to_seconds(used_start, fps))
    out_of_range = False
    rel = raw_rel
    if clip_frames > 1 and fps > 0:
        max_rel = (clip_frames - 1) / fps
        if rel > max_rel:
            out_of_range = True
            rel = max_rel
    return {
        "rawRelFrames": int(round(raw_rel * fps)),
        "relFrames": int(round(rel * fps)),
        "clipFrames": clip_frames,
        "outOfRange": out_of_range,
    }


class TestSameClock:
    def test_in_range_seek_is_correct(self):
        # Editorial and OCF share a clock: srcIn 5s after the clip's start TC.
        d = _seek_diag("01:00:05:00", "01:00:00:00", clip_frames=866, fps=24.0)
        assert d["rawRelFrames"] == 120           # 5s * 24
        assert d["relFrames"] == 120
        assert d["outOfRange"] is False

    def test_head_of_clip(self):
        d = _seek_diag("01:00:00:00", "01:00:00:00", clip_frames=866, fps=24.0)
        assert d["relFrames"] == 0
        assert d["outOfRange"] is False


class TestDifferentClock:
    def test_editorial_vs_embedded_mismatch_is_detected(self):
        # The reported screenshot scenario: editorial 07:20:01:07 vs an OCF clock
        # at 01:00:03:14 — different clocks → offset far beyond the 866-frame clip.
        d = _seek_diag("07:20:01:07", "01:00:03:14", clip_frames=866, fps=24.0)
        assert d["outOfRange"] is True
        assert d["rawRelFrames"] > 500000         # ~6h20m of frames
        assert d["relFrames"] == 865              # clamped to last frame (866-1)

    def test_clamp_shows_last_frame_not_black(self):
        d = _seek_diag("10:00:00:00", "01:00:00:00", clip_frames=100, fps=24.0)
        assert d["outOfRange"] is True
        assert d["relFrames"] == 99               # last frame, not 0/black


class TestPreferPassedStartTc:
    """The fix: when the caller supplies the OCF's own start TC (matcher's clock,
    same as editorial), it is used instead of the embedded Start TC — so an
    editorial-vs-embedded clock split no longer clamps to the wrong frame."""

    def test_passed_start_overrides_wrong_embedded(self):
        # Embedded Start TC (01:00) is a DIFFERENT clock than editorial (07:20);
        # the matcher supplies 07:20:00:00 as the OCF start → offset is in range.
        d = _seek_diag("07:20:01:07", "01:00:03:14", clip_frames=866, fps=24.0,
                       passed_start_tc="07:20:00:00")
        assert d["outOfRange"] is False
        assert d["relFrames"] == 24 + 7           # 1s07f = 31 frames in

    def test_no_passed_start_falls_back_to_embedded(self):
        # Without a passed start, behavior is unchanged (embedded, may be out of range).
        d = _seek_diag("07:20:01:07", "01:00:03:14", clip_frames=866, fps=24.0,
                       passed_start_tc="")
        assert d["outOfRange"] is True
