"""IAB (Dolby Atmos) ADM inspect — golden test (Handoff FIX 1 acceptance).

The Meridian IAB package carries S-ADM with a 7.1.2 bed + 48 objects (49 total
audioObject). Asserts the inspector reports the right object count + bed layout,
driven by ADM element/type counts (not name heuristics). Skips if the fixture
isn't on this machine (it's a large local sample, not in CI).
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest

_FIXTURE = Path(
    "/Users/psangchod/Movies/NMD/20230311_IMF Sample for Backlot New UI/"
    "3_audio supplemental/Meridian_tst_HD_23.976fps_HDRIAB_audio supplemental/"
    "IAB_c6faac8a-1ba5-4247-9db1-c79b251ac59f.mxf"
)

pytestmark = pytest.mark.skipif(not _FIXTURE.is_file(),
                                reason="Meridian IAB fixture not present on this machine")


def _inspect():
    from postflowx_companion.api import _inspect_iab_asset
    return _inspect_iab_asset(_FIXTURE)


def test_meridian_object_count_and_bed_layout():
    r = _inspect()
    # 49 audioObject = 1 bed + 48 dynamic objects
    assert r["admStats"]["audioObject"] == 49
    assert r["objectSummary"]["totalObjects"] == 49
    assert r["objectSummary"]["bedObjects"] == 1
    assert r["objectSummary"]["dynamicObjects"] == 48
    # bed is a 7.1.2 DirectSpeakers pack (10 channels)
    assert r["bedLayout"] == "7.1.2"
    assert r["beds"][0]["channels"] == 10


def test_meridian_track_list():
    r = _inspect()
    tracks = r["tracks"]
    assert len(tracks) == 49
    beds = [t for t in tracks if t["type"] == "bed"]
    objs = [t for t in tracks if t["type"] == "object"]
    assert len(beds) == 1 and beds[0]["layout"] == "7.1.2"
    assert len(objs) == 48
    assert objs[0]["name"] == "Object 1"


def test_count_driven_not_name_heuristic():
    # totalObjects must come from the ADM count even though objects/bed naming
    # varies — guards against the old len(object_names) regression.
    r = _inspect()
    assert r["objectSummary"]["totalObjects"] == r["admStats"]["audioObject"]
