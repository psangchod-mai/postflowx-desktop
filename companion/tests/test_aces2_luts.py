"""ACES 2.0 output-transform LUT tests.

Two layers:
  • registry/selection (pure, always run)
  • numeric accuracy: apply the shipped shaper+cube via the *bundled* ffmpeg and
    compare to OCIO ground truth (skips unless both ffmpeg + PyOpenColorIO exist).
"""
from __future__ import annotations

import os
import struct
import subprocess

import pytest

from postflowx_companion.color import aces2_luts


# ── registry / selection (pure) ──────────────────────────────────────────────

def test_luts_present_and_listed():
    avail = aces2_luts.available()
    assert "rec709_sdr" in avail, f"expected baked LUTs, got {avail}"
    assert aces2_luts.shaper_path() is not None
    ids = {t["id"] for t in aces2_luts.list_output_transforms()}
    assert ids == set(avail)


def test_resolve_lut_id_aliases():
    assert aces2_luts.resolve_lut_id("Rec.709") == "rec709_sdr"
    assert aces2_luts.resolve_lut_id("Rec.709 100-nits") == "rec709_sdr"
    assert aces2_luts.resolve_lut_id("display p3") == "p3d65_sdr"
    assert aces2_luts.resolve_lut_id(None) == "rec709_sdr"          # default
    assert aces2_luts.resolve_lut_id("totally-unknown") == "rec709_sdr"  # default fallback


def test_ffmpeg_filter_has_both_stages():
    flt = aces2_luts.ffmpeg_video_filter("rec709_sdr")
    assert "lut1d=" in flt and "lut3d=" in flt
    assert "interp=tetrahedral" in flt


def test_missing_lut_raises():
    with pytest.raises(FileNotFoundError):
        aces2_luts.ffmpeg_video_filter("does_not_exist")


def test_companion_action_lists_transforms():
    from postflowx_companion.api import CompanionApi
    api = CompanionApi()
    resp = api._color_aces2_output_transforms({})
    transforms = resp["data"]["transforms"]
    ids = {t["id"] for t in transforms}
    assert "rec709_sdr" in ids
    assert all("ACES 2.0" in t["label"] for t in transforms)


def test_review_proxy_renders_from_exr(tmp_path):
    """End-to-end: AP0 EXR sequence → ACES 2.0 Rec.709 review movie."""
    import time, struct, subprocess
    ff = _find_ffmpeg()
    if not ff:
        pytest.skip("ffmpeg not available")
    # bundled (LGPL) ffmpeg uses h264_videotoolbox; skip if absent
    enc = subprocess.run([ff, "-hide_banner", "-encoders"], capture_output=True, text=True)
    if "h264_videotoolbox" not in enc.stdout:
        pytest.skip("h264_videotoolbox encoder not present")

    # synth a tiny AP0 EXR sequence (gbrpf32le → exr), mid-grey-ish ramp
    W = H = 16
    planar = (struct.pack(f"<{W*H}f", *([0.18] * (W * H))) * 3)
    for n in (1001, 1002):
        exr = tmp_path / f"shot.{n}.exr"
        r = subprocess.run([ff, "-y", "-f", "rawvideo", "-pix_fmt", "gbrpf32le",
                            "-s", f"{W}x{H}", "-i", "pipe:0",
                            "-c:v", "exr", "-pix_fmt", "gbrpf32le", "-format", "float", str(exr)],
                           input=planar, capture_output=True)
        if r.returncode != 0 or not exr.is_file():
            pytest.skip(f"ffmpeg build cannot write EXR: {r.stderr[:200]!r}")

    from postflowx_companion.api import CompanionApi
    api = CompanionApi()
    job = {"exrDir": str(tmp_path), "exrPattern": "shot.%04d.exr",
           "frameStart": 1001, "fps": 24, "codec": "h264",
           "colorPlan": {"odtId": "rec709_sdr"}, "shotId": "t"}
    jid = api._render_review_proxy_start({"job": job})["data"]["jobId"]
    for _ in range(100):
        st = api._render_pull_exr_status({"jobId": jid})["data"]
        if st["state"] in ("done", "failed"):
            break
        time.sleep(0.2)
    assert st["state"] == "done", st.get("error")
    out = st["result"]["output"]
    assert os.path.isfile(out) and os.path.getsize(out) > 0
    assert st["result"]["odtStandard"] == "ACES 2.0"


# ── numeric accuracy vs OCIO through the bundled ffmpeg ──────────────────────

def _find_ffmpeg():
    try:
        from postflowx_companion.proxy_service import _resource_bin
        return _resource_bin("ffmpeg")
    except Exception:
        import shutil
        return shutil.which("ffmpeg")


@pytest.mark.parametrize("lut_id,display,view", [
    ("rec709_sdr",       "Rec.1886 Rec.709 - Display", "ACES 2.0 - SDR 100 nits (Rec.709)"),
    ("p3d65_sdr",        "P3-D65 - Display",           "ACES 2.0 - SDR 100 nits (P3 D65)"),
    ("rec2100_pq_1000",  "Rec.2100-PQ - Display",      "ACES 2.0 - HDR 1000 nits (P3 D65)"),
    ("rec2100_hlg_1000", "Rec.2100-HLG - Display",     "ACES 2.0 - HDR 1000 nits (P3 D65)"),
])
def test_lut_matches_ocio(lut_id, display, view):
    ff = _find_ffmpeg()
    if not ff:
        pytest.skip("ffmpeg not available")
    try:
        import PyOpenColorIO as ocio
    except Exception:
        pytest.skip("PyOpenColorIO not available (build-time only)")

    cfg = ocio.Config.CreateFromBuiltinConfig("studio-config-v4.0.0_aces-v2.0_ocio-v2.5")
    dvt = ocio.DisplayViewTransform(src="ACES2065-1", display=display, view=view)
    cpu = cfg.getProcessor(dvt).getDefaultCPUProcessor()
    flt = aces2_luts.ffmpeg_video_filter(lut_id)

    worst = 0
    for v in (0.0, 0.02, 0.05, 0.18, 0.5, 1.0, 2.0):
        # applyRGB RETURNS the result (does not mutate the list)
        out = cpu.applyRGB([v, v, v])
        ocio_code = max(0, min(255, int(out[0] * 255 + 0.5)))
        # 1x1 gbrpf32le (planar G,B,R) → ffmpeg LUT chain → rgb24
        planar = struct.pack("<3f", v, v, v)
        p = subprocess.run(
            [ff, "-hide_banner", "-loglevel", "error",
             "-f", "rawvideo", "-pix_fmt", "gbrpf32le", "-s", "1x1", "-i", "pipe:0",
             "-vf", flt, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
            input=planar, capture_output=True)
        assert p.returncode == 0 and p.stdout, p.stderr[:300]
        ff_code = p.stdout[0]
        worst = max(worst, abs(ocio_code - ff_code))
    # ffmpeg LUT vs OCIO: within a few 8-bit code values.
    # Anti-identity guard: a real ACES 2.0 transform lifts mid-grey 0.18 well
    # above identity (SDR→0.385, PQ→0.33, HLG→0.297); identity would leave 0.18.
    mid = cpu.applyRGB([0.18, 0.18, 0.18])[0]
    assert mid > 0.25, f"{lut_id}: ACES 2.0 transform looks like identity (0.18→{mid:.3f})"
    assert worst <= 3, f"{lut_id}: worst |Δ| = {worst} code values vs OCIO"
