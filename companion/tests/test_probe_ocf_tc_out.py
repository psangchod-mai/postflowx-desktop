"""_probe_ocf_file's TC-out math for fractional camera frame rates.

23.976/29.97/59.94fps are the most common professional cinema camera rates
(this app's primary OCF use case) and must use their nominal whole-frame base
(24/30/60) as the frame-counting divisor, not a truncated int(fps) — the same
"nominal base" convention already established by utils_time.js's nominalBase()
and by this file's own _tc_to_frames/_frames_to_tc (proven at fps=23.976 in
test_resolve_probe_clips.py). _probe_ocf_file used to reimplement this locally
with int(fps), truncating 23.976 to 23 and drifting tc_out by real seconds.
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.api import CompanionApi  # noqa: E402


class _FakeCompletedProcess:
    def __init__(self, stdout):
        self.returncode = 0
        self.stdout = stdout
        self.stderr = ""


def _probe_with_fake_ffprobe(monkeypatch, fps_num, fps_den, nb_frames, timecode):
    payload = {
        "streams": [{
            "codec_type": "video",
            "r_frame_rate": f"{fps_num}/{fps_den}",
            "nb_frames": str(nb_frames),
            "tags": {"timecode": timecode},
        }],
        "format": {"tags": {}},
    }

    def _fake_run(*args, **kwargs):
        return _FakeCompletedProcess(json.dumps(payload))

    monkeypatch.setattr("subprocess.run", _fake_run)
    api = CompanionApi.__new__(CompanionApi)
    return api._probe_ocf_file("/x/A001C001.mov", "A001C001.mov", ".mov", ffprobe_path="/usr/bin/ffprobe")


def test_tc_out_uses_nominal_base_at_23_976_fps(monkeypatch):
    info = _probe_with_fake_ffprobe(monkeypatch, 24000, 1001, nb_frames=1000, timecode="01:00:00:00")
    assert info["tcOut"] == "01:00:41:16"


def test_tc_out_uses_nominal_base_at_29_97_fps(monkeypatch):
    info = _probe_with_fake_ffprobe(monkeypatch, 30000, 1001, nb_frames=1000, timecode="01:00:00:00")
    assert info["tcOut"] == "01:00:33:10"


def test_tc_out_unaffected_at_integer_fps(monkeypatch):
    info = _probe_with_fake_ffprobe(monkeypatch, 24, 1, nb_frames=1000, timecode="01:00:00:00")
    assert info["tcOut"] == "01:00:41:16"
