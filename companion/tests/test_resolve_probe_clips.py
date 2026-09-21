"""Gap 2: resolve.probeClips — read MediaPool clip metadata (Start TC / Reel /
File Path / FPS / duration) to enrich OCF matching for camera RAW."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.api import CompanionApi  # noqa: E402


class _FakeClip:
    def __init__(self, props):
        self._p = props

    def GetClipProperty(self, key):
        return self._p.get(key, "")

    def GetName(self):
        return self._p.get("_name", "")


def test_clip_metadata_computes_tc_range_and_identity():
    md = CompanionApi._resolve_clip_metadata(
        _FakeClip({
            "FPS": "23.976", "Start TC": "09:45:09:04", "Frames": "3737",
            "Reel Name": "A001", "Video Codec": "X-OCN", "Camera #": "A",
            "Resolution": "4096x2160",
        }),
        "/x/A001L008_250301E6.mxf",
    )
    assert md["tcIn"] == "09:45:09:04"
    assert md["tcOut"] == "09:47:44:20"          # tcIn + (3737-1) frames @ 23.976
    assert md["frameCount"] == 3737
    assert md["reel"] == "A001"
    assert md["fps"] == 23.976
    assert md["tcKnown"] is True
    assert md["decoder"] == "Resolve"
    assert md["name"] == "A001L008_250301E6.mxf"


def test_clip_metadata_handles_missing_props():
    md = CompanionApi._resolve_clip_metadata(_FakeClip({}), "/x/clip.mxf")
    assert md["tcIn"] is None
    assert md["tcKnown"] is False
    assert md["frameCount"] is None


# NOTE: these call _resolve_probe_clips directly rather than via api.handle(),
# because handle() is broken in this tree by a separate pre-existing bug (10
# orphaned _ocf_engine_* methods after the class → self._ocf_engine_scan missing).
def test_probe_clips_requires_paths():
    api = CompanionApi()
    resp = api._resolve_probe_clips({"paths": []})
    assert resp["status"] == "error"
    assert resp["error"]["code"] == "BAD_REQUEST"


def test_probe_clips_when_resolve_unavailable(monkeypatch):
    monkeypatch.setattr(CompanionApi, "_get_resolve_app", staticmethod(lambda: None))
    api = CompanionApi()
    resp = api._resolve_probe_clips({"paths": ["/x/a.mxf"]})
    assert resp["status"] == "error"
    assert resp["error"]["code"] == "RESOLVE_NOT_CONNECTED"
