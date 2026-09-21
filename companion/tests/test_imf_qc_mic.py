"""Tests for imf_qc.py MIC integration — embedded essence-hash wired into QC flow.

Exercises verify_essence_mic() and the run_photon() folding of MIC results, using
synthesized MXF fixtures and forcing the Photon-unavailable path (no Java/JAR) so
no external tools are required.
"""
from __future__ import annotations

import pytest

from postflowx_companion import imf_qc
from postflowx_companion.imf_mic import build_mxf_with_mic


def _make_mxf(path, chunks, **kw):
    path.write_bytes(build_mxf_with_mic(chunks, **kw))


class TestVerifyEssenceMic:
    def test_finds_and_passes(self, tmp_path):
        _make_mxf(tmp_path / "video.mxf", [b"aaa", b"bbb"])
        _make_mxf(tmp_path / "audio.mxf", [b"ccc"])
        roll = imf_qc.verify_essence_mic(str(tmp_path))
        assert roll["mxfFileCount"] == 2
        assert roll["passed"] == 2
        assert roll["overallStatus"] == "pass"

    def test_detects_corruption(self, tmp_path):
        _make_mxf(tmp_path / "video.mxf", [b"aaa"], corrupt_digest=True)
        roll = imf_qc.verify_essence_mic(str(tmp_path))
        assert roll["failed"] == 1
        assert roll["overallStatus"] == "fail"
        assert "failure" in roll["summary"]

    def test_no_mxf_skips(self, tmp_path):
        roll = imf_qc.verify_essence_mic(str(tmp_path))
        assert roll["mxfFileCount"] == 0
        assert roll["overallStatus"] == "skip"
        assert "No MXF" in roll["summary"]

    def test_recurses_subfolders(self, tmp_path):
        sub = tmp_path / "ASSETS"
        sub.mkdir()
        _make_mxf(sub / "video.mxf", [b"x"])
        roll = imf_qc.verify_essence_mic(str(tmp_path))
        assert roll["mxfFileCount"] == 1


class TestRunPhotonMicFolding:
    def _no_photon(self, monkeypatch):
        # Force the "photon.jar not found" path but Java present, so run_photon
        # returns early yet still carries MIC results + findings.
        monkeypatch.setattr(imf_qc, "find_java", lambda: "/usr/bin/java")
        monkeypatch.setattr(imf_qc, "find_photon_jar", lambda: None)

    def test_mic_attached_when_photon_absent(self, tmp_path, monkeypatch):
        self._no_photon(monkeypatch)
        _make_mxf(tmp_path / "video.mxf", [b"ok"])
        res = imf_qc.run_photon(str(tmp_path))
        assert "mic" in res
        assert res["mic"]["overallStatus"] == "pass"

    def test_mic_failure_surfaces_as_finding(self, tmp_path, monkeypatch):
        self._no_photon(monkeypatch)
        _make_mxf(tmp_path / "video.mxf", [b"bad"], corrupt_digest=True)
        res = imf_qc.run_photon(str(tmp_path))
        codes = [f.get("code") for f in res["findings"]]
        assert "ESSENCE_MIC_ERROR" in codes
        # The MIC failure summary should be appended.
        assert "failure" in res["summary"]

    def test_no_java_still_runs_mic(self, tmp_path, monkeypatch):
        monkeypatch.setattr(imf_qc, "find_java", lambda: None)
        monkeypatch.setattr(imf_qc, "find_photon_jar", lambda: None)
        _make_mxf(tmp_path / "video.mxf", [b"bad"], corrupt_digest=True)
        res = imf_qc.run_photon(str(tmp_path))
        assert "mic" in res
        codes = [f.get("code") for f in res["findings"]]
        assert "ESSENCE_MIC_ERROR" in codes
