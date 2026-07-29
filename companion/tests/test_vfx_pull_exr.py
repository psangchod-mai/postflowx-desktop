"""Tests for VFX Pull EXR export — spec contracts on the companion side.

Covers:
  • _build_vf_chain — ffmpeg filter chain construction per spec #10
  • _ocf_run_export guards — RETIME_DYNAMIC_UNSUPPORTED / FREEZE_RETIME_UNSUPPORTED
  • Missing source returns a clean error
"""

from __future__ import annotations

import os
import json
import threading
import time

import pytest

from postflowx_companion.api import CompanionApi, _map_relative_source_index


# ── _map_relative_source_index — dynamic-ramp source selection (pure) ────────

def test_map_relative_source_index_ramp():
    # sourceFrames advance non-linearly (a speed ramp); offsets are relative to
    # the first entry (the pulled-window start).
    sfm = [{"sourceFrame": 1000}, {"sourceFrame": 1001}, {"sourceFrame": 1003},
           {"sourceFrame": 1006}, {"sourceFrame": 1010}]
    assert [_map_relative_source_index(i, sfm) for i in range(5)] == [0, 1, 3, 6, 10]


def test_map_relative_source_index_guards():
    assert _map_relative_source_index(0, None) is None
    assert _map_relative_source_index(0, []) is None
    assert _map_relative_source_index(9, [{"sourceFrame": 1000}]) is None   # out of range
    assert _map_relative_source_index(0, [{"speed": 100}]) is None          # no sourceFrame
    # Never returns a negative index even if the map briefly goes backwards.
    assert _map_relative_source_index(1, [{"sourceFrame": 1000}, {"sourceFrame": 990}]) == 0


# ── _build_vf_chain — pure helper, no I/O ────────────────────────────────────


def test_vf_chain_empty_when_no_retime_no_reframe():
    chain = CompanionApi._build_vf_chain(
        {"retime": {"mode": "source_frames_only", "hasSpeedChange": False},
         "reframe": {"mode": "none"}},
        24.0,
    )
    assert chain == ""


def test_vf_chain_constant_200pct_speed_plus_uhd_reframe():
    chain = CompanionApi._build_vf_chain(
        {
            "retime": {"mode": "bake_to_timeline", "hasSpeedChange": True, "speed": 2.0},
            "reframe": {
                "mode": "match_qt_ref_uhd",
                "cropBox": [10, 20, 1910, 1100],
                "targetWidth": 3840, "targetHeight": 2160,
            },
        },
        24.0,
    )
    # Spec example order: speed → crop → scale → pad
    assert chain.startswith("setpts=PTS/2.000000,")
    assert "crop=1900:1080:10:20" in chain
    assert "scale=3840:2160:force_original_aspect_ratio=increase" in chain
    assert "crop=3840:2160" in chain
    assert chain.endswith("setsar=1")


def test_vf_chain_reverse_only():
    chain = CompanionApi._build_vf_chain(
        {"retime": {"mode": "bake_to_timeline", "hasSpeedChange": True, "speed": 1.0, "reversed": True},
         "reframe": {"mode": "none"}},
        24.0,
    )
    # No setpts at speed=1.0; just the reverse filter.
    assert chain == "reverse"


def test_vf_chain_reframe_only_no_cropbox():
    chain = CompanionApi._build_vf_chain(
        {"retime": {"mode": "source_frames_only", "hasSpeedChange": False},
         "reframe": {"mode": "match_qt_ref_uhd",
                     "targetWidth": 3840, "targetHeight": 2160}},
        24.0,
    )
    assert "crop=3840:2160" in chain
    assert chain.endswith("setsar=1")
    # No active-area crop emitted when cropBox is absent.
    assert chain.count("crop=") == 1


def test_vf_chain_50pct_slow_mo_plus_cropbox():
    chain = CompanionApi._build_vf_chain(
        {"retime": {"mode": "bake_to_timeline", "hasSpeedChange": True, "speed": 0.5},
         "reframe": {"mode": "match_qt_ref_uhd",
                     "cropBox": [0, 100, 1920, 980],
                     "targetWidth": 3840, "targetHeight": 2160}},
        24.0,
    )
    assert chain.startswith("setpts=PTS/0.500000,")
    assert "crop=1920:880:0:100" in chain


def test_vf_chain_invalid_cropbox_falls_through_silently():
    # cropBox of wrong length → ignored, but reframe still produces scale/pad.
    chain = CompanionApi._build_vf_chain(
        {"retime": {"mode": "source_frames_only", "hasSpeedChange": False},
         "reframe": {"mode": "match_qt_ref_uhd",
                     "cropBox": [10, 20],   # too short
                     "targetWidth": 3840, "targetHeight": 2160}},
        24.0,
    )
    assert "scale=3840:2160" in chain
    # The first/active-area crop must NOT be emitted from the bad cropBox.
    assert "crop=10:20" not in chain


# ── _build_vf_chain — new pipeline shape (geometryEngine.js strings) ─────────


def test_vf_chain_new_shape_crop_and_scale():
    """New-pipeline reframe: pre-built ffmpeg filter strings passed directly."""
    chain = CompanionApi._build_vf_chain(
        {
            "retime": {"mode": "source_frames_only", "hasSpeedChange": False},
            "reframe": {
                "crop":  "crop=1920:1080:0:0",
                "scale": "scale=3840:2160",
            },
        },
        24.0,
    )
    assert "crop=1920:1080:0:0" in chain
    assert "scale=3840:2160" in chain
    assert chain.endswith("setsar=1")


def test_vf_chain_new_shape_crop_only():
    """New-pipeline reframe with crop but no scale still emits setsar=1."""
    chain = CompanionApi._build_vf_chain(
        {
            "retime": {"mode": "source_frames_only", "hasSpeedChange": False},
            "reframe": {"crop": "crop=1920:1080:0:0", "scale": ""},
        },
        24.0,
    )
    assert "crop=1920:1080:0:0" in chain
    assert chain.endswith("setsar=1")
    assert "scale" not in chain


def test_vf_chain_new_shape_scale_only():
    """New-pipeline reframe with scale but no crop still emits setsar=1."""
    chain = CompanionApi._build_vf_chain(
        {
            "retime": {"mode": "source_frames_only", "hasSpeedChange": False},
            "reframe": {"crop": "", "scale": "scale=3840:2160"},
        },
        24.0,
    )
    assert "scale=3840:2160" in chain
    assert chain.endswith("setsar=1")
    assert "crop=" not in chain


def test_vf_chain_new_shape_with_speed_bake():
    """New-pipeline reframe combined with speed bake — order must be speed → crop → scale → setsar."""
    chain = CompanionApi._build_vf_chain(
        {
            "retime": {"mode": "bake_to_timeline", "hasSpeedChange": True, "speed": 2.0},
            "reframe": {
                "crop":  "crop=1920:1080:0:0",
                "scale": "scale=3840:2160",
            },
        },
        24.0,
    )
    assert chain.startswith("setpts=PTS/2.000000,")
    assert "crop=1920:1080:0:0" in chain
    assert "scale=3840:2160" in chain
    assert chain.endswith("setsar=1")
    # Speed must come before crop in the chain
    assert chain.index("setpts=") < chain.index("crop=")


def test_vf_chain_new_shape_null_reframe_is_empty():
    """New-pipeline null reframe (no geometry) produces an empty chain."""
    chain = CompanionApi._build_vf_chain(
        {
            "retime": {"mode": "source_frames_only", "hasSpeedChange": False},
            "reframe": None,
        },
        24.0,
    )
    assert chain == ""


# ── _ocf_run_export guards — clean errors before any ffmpeg work ─────────────


def _new_api() -> CompanionApi:
    """Build a CompanionApi instance with an empty job registry.

    The constructor signature in api.py expects a config kwarg; we pass an
    explicit object so the call works regardless of default-arg policy.
    """
    try:
        api = CompanionApi()
    except TypeError:
        # Fallback for builds that require explicit config — older versions
        # of CompanionApi accept (config=None) but some require a dict.
        from postflowx_companion.config import CompanionConfig
        api = CompanionApi(CompanionConfig())
    # Reset the job registry so test state doesn't leak.
    api._ocf_jobs = {}
    return api


def _run_and_wait(api: CompanionApi, job: dict, timeout: float = 5.0) -> dict:
    """Drive _ocf_run_export synchronously by calling it on the current thread
    with a fresh job_id, then return the final state.

    Calling _ocf_run_export directly avoids the threading machinery so the
    test is deterministic and doesn't have to poll across thread boundaries.
    """
    job_id = "test_job"
    api._ocf_jobs[job_id] = {"state": "running", "progressPct": 0, "result": None, "error": None}
    api._ocf_run_export(job_id, job)
    return api._ocf_jobs[job_id]


def test_export_dynamic_retime_returns_clean_error():
    api = _new_api()
    state = _run_and_wait(api, {
        "sourcePath": "/nonexistent/source.mov",
        "outputDir":  "/tmp/pfx_test_dyn",
        "outputPattern": "test.%04d.exr",
        "exportIn":  "00:00:00:00",
        "exportOut": "00:00:01:00",
        "fps": 24,
        "frameStart": 1001,
        "expectedFrameCount": 24,
        "retime": {
            "mode": "bake_to_timeline",
            "hasSpeedChange": True,
            "isDynamic": True,
            "sourceFrameMap": None,        # ← unresolved → must fail clean
            "speedKeys": [{"tc": "00:00:00:00", "speed": 1},
                          {"tc": "00:00:00:12", "speed": 2}],
        },
    })
    assert state["state"] == "failed"
    assert "RETIME_DYNAMIC_UNSUPPORTED" in (state.get("error") or "")


def test_export_dynamic_retime_with_map_still_refused_on_ffmpeg():
    # The FFmpeg fallback bakes constant speed via setpts and cannot reproduce a
    # keyframed ramp frame-accurately — so it must refuse dynamic retimes EVEN
    # when the planner supplies a resolved sourceFrameMap (that map drives the
    # sidecar + resolve/oiio engines instead). Guards against a silent mis-bake.
    api = _new_api()
    state = _run_and_wait(api, {
        "sourcePath": "/nonexistent/source.mov",
        "outputDir":  "/tmp/pfx_test_dyn_map",
        "outputPattern": "test.%04d.exr",
        "exportIn":  "00:00:00:00",
        "exportOut": "00:00:01:00",
        "fps": 24,
        "frameStart": 1001,
        "expectedFrameCount": 24,
        "retime": {
            "mode": "bake_to_timeline",
            "hasSpeedChange": True,
            "isDynamic": True,
            # Resolved map present — must STILL refuse on the ffmpeg path.
            "sourceFrameMap": [
                {"sourceFrame": i, "sourceTC": "00:00:00:00", "speed": 100, "retimeType": "dynamic"}
                for i in range(24)
            ],
            "speedKeys": [{"tc": "00:00:00:00", "speed": 1},
                          {"tc": "00:00:00:12", "speed": 2}],
        },
    })
    assert state["state"] == "failed"
    assert "RETIME_DYNAMIC_UNSUPPORTED" in (state.get("error") or "")


def test_write_pull_sidecars_persists_amf_fdl_and_frame_map(tmp_path):
    api = _new_api()
    pkg = {
        "metadata": str(tmp_path / "metadata"),
        "amfFile": str(tmp_path / "amf" / "SHOT_PL_v001.amf"),
        "fdlFile": str(tmp_path / "metadata" / "SHOT_PL_v001.fdl.json"),
        "frameMapFile": str(tmp_path / "metadata" / "SHOT_PL_v001_frame_map.csv"),
        "geometryFile": str(tmp_path / "metadata" / "SHOT_PL_v001_resize.json"),
        "pullReportFile": str(tmp_path / "metadata" / "SHOT_PL_v001_manifest.json"),
        "qcJsonFile": str(tmp_path / "metadata" / "SHOT_PL_v001_qc.json"),
    }
    job = {
        "package": pkg,
        "shotId": "SHOT_010",
        "plateName": "SHOT_PL_v001",
        "sourcePath": "/ocf/A001.mov",
        "exportIn": "01:00:00:00",
        "fps": 24,
        "frameStart": 1001,
        "expectedFrameCount": 8,
        "expectedRenderedFrameCount": 4,
        "retime": {
            "mode": "bake_to_timeline",
            "hasSpeedChange": True,
            "speed": 2,
            "speedPercent": 200,
            "sourceFrameMap": [
                {"sourceFrame": 86400, "sourceTC": "01:00:00:00", "speed": 200, "retimeType": "constant"},
                {"sourceFrame": 86402, "sourceTC": "01:00:00:02", "speed": 200, "retimeType": "constant"},
            ],
        },
        "geometry": {"hasGeometry": True, "bakeMode": "baked", "resizeMode": "scale_to_fit"},
        "color": {"match": {"confidence": 0.91}},
        "colorPlan": {"idtName": "ARRI LogC4", "outputSpace": "ACES2065-1"},
        "sidecars": {
            "amfXml": "<aces:acesMetadataFile/>",
            "fdl": {"schema": "postflowx.vfxpull.fdl.v1", "shotName": "SHOT_010"},
            "qtReference": {"path": "/ref/edit.mov", "tcIn": "00:00:10:00", "colorSpace": "Rec709"},
        },
    }

    res = api._write_pull_sidecars({"job": job, "qcResult": {"pass": True}})
    assert res["status"] == "ok"
    assert not res["data"]["errors"]
    assert os.path.isfile(pkg["amfFile"])
    assert os.path.isfile(pkg["fdlFile"])
    assert os.path.isfile(pkg["frameMapFile"])

    assert "<aces:acesMetadataFile/>" in open(pkg["amfFile"], encoding="utf-8").read()
    fdl = json.load(open(pkg["fdlFile"], encoding="utf-8"))
    assert fdl["shotName"] == "SHOT_010"
    frame_map = open(pkg["frameMapFile"], encoding="utf-8").read()
    assert "1001,1001,A001.mov,86400" in frame_map
    report = json.load(open(pkg["pullReportFile"], encoding="utf-8"))
    assert report["qtReference"]["path"] == "/ref/edit.mov"
    assert report["colorMatch"]["confidence"] == 0.91


# ── frameStart: 0 is a valid start frame, not "absent" ──────────────────────
# job.get("frameStart") or 1001 treats a legitimate 0 as falsy and silently
# substitutes 1001, both in the EXR-sequence QC's start-frame check and in the
# frame-map CSV writer's outputFrame column.


def test_write_pull_sidecars_frame_map_honors_zero_frame_start(tmp_path):
    api = _new_api()
    pkg = {
        "metadata": str(tmp_path / "metadata"),
        "frameMapFile": str(tmp_path / "metadata" / "SHOT_PL_v001_frame_map.csv"),
        "pullReportFile": str(tmp_path / "metadata" / "SHOT_PL_v001_manifest.json"),
    }
    job = {
        "package": pkg,
        "shotId": "SHOT_010",
        "plateName": "SHOT_PL_v001",
        "sourcePath": "/ocf/A001.mov",
        "exportIn": "01:00:00:00",
        "fps": 24,
        "frameStart": 0,
        "expectedFrameCount": 4,
        "expectedRenderedFrameCount": 4,
    }

    res = api._write_pull_sidecars({"job": job, "qcResult": {"pass": True}})
    assert res["status"] == "ok"
    assert not res["data"]["errors"]
    frame_map = open(pkg["frameMapFile"], encoding="utf-8").read()
    rows = [r for r in frame_map.splitlines() if r and not r.startswith("timelineFrame")]
    first_output_frame = int(rows[0].split(",")[1])
    assert first_output_frame == 0, \
        "frameStart: 0 must produce outputFrame starting at 0, not fall back to 1001"


def test_qc_exr_sequence_zero_frame_start_matches_detected_start(tmp_path):
    api = _new_api()
    exr_dir = tmp_path / "exr"
    exr_dir.mkdir()
    plate_name = "SHOT_PL_v001"
    for i in range(4):
        (exr_dir / f"{plate_name}.{i:04d}.exr").write_bytes(b"")

    result = api._qc_exr_sequence({
        "job": {
            "package": {"exr": str(exr_dir)},
            "plateName": plate_name,
            "frameStart": 0,
            "expectedRenderedFrameCount": 4,
        }
    })
    assert result["status"] == "ok"
    warnings = result["data"]["warnings"]
    assert not any("Frame start" in w for w in warnings), \
        f"frameStart: 0 must not be treated as absent and compared against a wrong 1001 fallback: {warnings}"


def test_export_freeze_bake_no_longer_blocks():
    """Freeze-frame retime is now supported via two-stage extract+loop.

    With a non-existent source the export still fails — but for the right
    reason (FileNotFoundError at the source check), NOT for the legacy
    FREEZE_RETIME_UNSUPPORTED guard. This proves the guard is gone and
    freeze jobs are accepted into the export path.
    """
    api = _new_api()
    state = _run_and_wait(api, {
        "sourcePath": "/nonexistent/source.mov",
        "outputDir":  "/tmp/pfx_test_freeze",
        "outputPattern": "test.%04d.exr",
        "exportIn":  "00:00:00:00",
        "exportOut": "00:00:01:00",
        "fps": 24, "frameStart": 1001, "expectedFrameCount": 24,
        "retime": {
            "mode": "bake_to_timeline",
            "hasSpeedChange": True,
            "freeze": {"frame": 12},
        },
    })
    err = state.get("error") or ""
    assert state["state"] == "failed"
    # The legacy guard must be gone — freeze is supported now.
    assert "FREEZE_RETIME_UNSUPPORTED" not in err
    # Failure should be the missing source, surfaced cleanly.
    assert ("not found" in err.lower()) or ("filenotfound" in err.lower())


def test_export_freeze_bake_produces_sequence_with_real_source(tmp_path):
    """End-to-end freeze bake against a synthetic 5-frame ffmpeg-generated mp4.

    Skipped when ffmpeg isn't on PATH — the existing pure-helper coverage
    above still exercises the guard / chain logic.
    """
    import shutil, subprocess
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("ffmpeg not available on PATH")

    source = tmp_path / "src.mp4"
    # 1 second of colour bars at 24 fps. testsrc2 has different content
    # per frame, so picking frame 12 vs 0 should produce distinct output —
    # gives the freeze a meaningful target.
    gen = subprocess.run(
        [ffmpeg, "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24",
         "-t", "1", "-pix_fmt", "yuv420p", str(source)],
        capture_output=True, timeout=30,
    )
    if gen.returncode != 0 or not source.exists():
        pytest.skip(f"ffmpeg could not generate fixture: {gen.stderr[:200]!r}")

    out_dir = tmp_path / "out"
    api = _new_api()
    state = _run_and_wait(api, {
        "sourcePath":    str(source),
        "outputDir":     str(out_dir),
        "outputPattern": "freeze.%04d.exr",
        "exportIn":  "00:00:00:00",
        "exportOut": "00:00:00:10",        # 10/24s ≈ 10 frames target
        "fps": 24, "frameStart": 1001,
        "expectedRenderedFrameCount": 10,
        "retime": {
            "mode": "bake_to_timeline",
            "hasSpeedChange": True,
            "freeze": {"frame": 12},
        },
        "reframe": {"mode": "none"},
        "exr": {"bitDepth": "half"},
    }, timeout=30.0)

    err = state.get("error") or ""
    # If the platform's ffmpeg doesn't support EXR encoding, accept that as a
    # skip — the freeze guard is the thing we care about.
    if state["state"] == "failed" and ("Unknown encoder" in err or "Encoder" in err):
        pytest.skip(f"ffmpeg build lacks EXR encoder: {err[:200]!r}")

    assert state["state"] == "done", f"freeze export failed: {err}"
    result = state.get("result") or {}
    assert result.get("status") == "success"
    # Realised frame count should be ≥ 1 — the exact count depends on ffmpeg
    # rounding behaviour at the requested duration.
    assert (result.get("framesExported") or 0) >= 1
    assert (result.get("filterChainUsed") in (True, False))
    # Output folder contains the EXR sequence with the configured prefix.
    files = sorted(p.name for p in out_dir.glob("freeze.*.exr"))
    assert len(files) >= 1
    # Temp PNG must be purged.
    assert not (out_dir / "_freeze_src.png").exists()


def test_export_missing_source_returns_clean_error():
    api = _new_api()
    state = _run_and_wait(api, {
        "sourcePath": "/definitely/not/here.mov",
        "outputDir":  "/tmp/pfx_test_missing",
        "outputPattern": "test.%04d.exr",
        "exportIn":  "00:00:00:00",
        "exportOut": "00:00:01:00",
        "fps": 24, "frameStart": 1001, "expectedFrameCount": 24,
        "retime": {"mode": "source_frames_only", "hasSpeedChange": False},
        "reframe": {"mode": "none"},
    })
    assert state["state"] == "failed"
    msg = (state.get("error") or "")
    assert "not found" in msg.lower() or "filenotfound" in msg.lower()
