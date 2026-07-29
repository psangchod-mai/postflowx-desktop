"""probe_ocf_clip()'s timecodeBase math for fractional camera frame rates (Iteration 80).

23.976/29.97/59.94fps are the most common professional cinema camera rates
and must round to their nominal whole-frame base (24/30/60), not floor via
integer division — the same "nominal base" convention already established
elsewhere in this codebase (see test_probe_ocf_tc_out.py, utils_time.js's
nominalBase()). ocf_probe.py's probe_ocf_clip() computed
`tc_base = fps["num"] // fps["den"]`, which floors 24000/1001 to 23 instead
of rounding to 24 (and 30000/1001 to 29, 60000/1001 to 59).
"""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.ocf_engine.ocf_probe import probe_ocf_clip  # noqa: E402


class _FakeCompletedProcess:
    def __init__(self, stdout):
        self.returncode = 0
        self.stdout = stdout
        self.stderr = ""


def _probe_with_fake_ffprobe(monkeypatch, tmp_path, r_frame_rate):
    payload = {
        "streams": [{
            "codec_type": "video",
            "r_frame_rate": r_frame_rate,
            "tags": {},
        }],
        "format": {"tags": {}},
    }

    def _fake_run(*args, **kwargs):
        return _FakeCompletedProcess(json.dumps(payload))

    monkeypatch.setattr("subprocess.run", _fake_run)
    clip = tmp_path / "A001C001.mov"
    clip.write_bytes(b"")
    return probe_ocf_clip(str(clip), ffprobe_bin="/usr/bin/ffprobe")


def test_timecode_base_rounds_at_23_976_fps(monkeypatch, tmp_path):
    probe = _probe_with_fake_ffprobe(monkeypatch, tmp_path, "24000/1001")
    assert probe["timecode"]["timecodeBase"] == 24


def test_timecode_base_rounds_at_29_97_fps(monkeypatch, tmp_path):
    probe = _probe_with_fake_ffprobe(monkeypatch, tmp_path, "30000/1001")
    assert probe["timecode"]["timecodeBase"] == 30


def test_timecode_base_rounds_at_59_94_fps(monkeypatch, tmp_path):
    probe = _probe_with_fake_ffprobe(monkeypatch, tmp_path, "60000/1001")
    assert probe["timecode"]["timecodeBase"] == 60


def test_timecode_base_unaffected_at_integer_fps(monkeypatch, tmp_path):
    probe = _probe_with_fake_ffprobe(monkeypatch, tmp_path, "25/1")
    assert probe["timecode"]["timecodeBase"] == 25
