"""Tests for imf_qc.py essence-descriptor conformance wiring.

Exercises verify_essence_conformance() discovery/gating and the run_photon()
folding of conformance mismatches into findings, forcing the Photon-unavailable
path so no external tools are required. The probe is injected via monkeypatch so
these run without an IMF-capable ffprobe.
"""
from __future__ import annotations

import pytest

from postflowx_companion import imf_qc


class TestConformFindings:
    def test_fail_maps_to_finding(self):
        conf = {
            "results": [{
                "overallStatus": "fail",
                "cplId": "urn:uuid:abc",
                "findings": [
                    {"severity": "error", "message": "width 1920 != probed 3840"},
                    {"severity": "warning", "message": "ignored"},
                ],
            }],
        }
        out = imf_qc._conform_findings(conf)
        assert len(out) == 1
        assert out[0]["code"] == "ESSENCE_DESCRIPTOR_MISMATCH"
        assert out[0]["severity"] == "ERROR"
        assert "urn:uuid:abc" in out[0]["message"]

    def test_pass_and_skip_yield_no_findings(self):
        conf = {"results": [
            {"overallStatus": "pass", "cplId": "a", "findings": []},
            {"overallStatus": "skip", "cplId": "b", "findings": []},
        ]}
        assert imf_qc._conform_findings(conf) == []


class TestVerifyEssenceConformance:
    def test_empty_folder_skips(self, tmp_path):
        out = imf_qc.verify_essence_conformance(str(tmp_path))
        assert out["overallStatus"] == "skip"
        assert out["checked"] == 0

    def test_detects_cpl_and_gates_on_probe(self, tmp_path, monkeypatch):
        # Minimal CPL so discovery picks it up; force the probe to report a mismatch.
        cpl = tmp_path / "CPL_test.xml"
        cpl.write_text(
            '<CompositionPlaylist xmlns="http://www.smpte-ra.org/schemas/2067-3/2016">'
            '<Id>urn:uuid:1111</Id><EditRate>24 1</EditRate>'
            '<EssenceDescriptor><Id>urn:uuid:2222</Id>'
            '<StoredWidth>1920</StoredWidth><StoredHeight>1080</StoredHeight>'
            '</EssenceDescriptor></CompositionPlaylist>'
        )
        (tmp_path / "ASSETMAP.xml").write_text(
            '<AssetMap xmlns="http://www.smpte-ra.org/schemas/429-9/2007/AM"></AssetMap>'
        )

        # Inject a probe (via the real conform fn) that reports a different
        # resolution → mismatch, so we don't need an IMF-capable ffprobe.
        real_check = imf_qc.imf_conform.check_cpl_conformance

        def fake_probe(cpl_path, assetmap_paths):
            return {"width": 3840, "height": 2160, "editRate": "24/1", "pictureCodec": "jpeg2000"}

        monkeypatch.setattr(
            imf_qc.imf_conform, "check_cpl_conformance",
            lambda cpl, cpl_path, assetmaps: real_check(cpl, cpl_path, assetmaps, probe_fn=fake_probe),
        )
        out = imf_qc.verify_essence_conformance(str(tmp_path))
        # The CPL was discovered and probed; a 1920×1080 descriptor vs a 3840×2160
        # probe is a mismatch → fail. (Never crashes regardless.)
        assert out["checked"] == 1
        assert out["overallStatus"] == "fail"


class TestRunPhotonFoldsConformance:
    def _no_photon(self, monkeypatch):
        monkeypatch.setattr(imf_qc, "find_java", lambda: "/usr/bin/java")
        monkeypatch.setattr(imf_qc, "find_photon_jar", lambda: None)

    def test_conformance_key_present(self, tmp_path, monkeypatch):
        self._no_photon(monkeypatch)
        result = imf_qc.run_photon(str(tmp_path))
        assert "conformance" in result
        assert result["conformance"]["overallStatus"] in ("skip", "pass", "fail")

    def test_conform_mismatch_surfaces_as_finding(self, tmp_path, monkeypatch):
        self._no_photon(monkeypatch)
        # Force a conformance failure and confirm it folds into findings.
        monkeypatch.setattr(imf_qc, "verify_essence_conformance", lambda folder: {
            "overallStatus": "fail", "checked": 1, "failed": 1, "passed": 0,
            "results": [{"overallStatus": "fail", "cplId": "urn:uuid:x", "findings": [
                {"severity": "error", "message": "codec jpeg2000 != prores"}]}],
        })
        result = imf_qc.run_photon(str(tmp_path))
        codes = {f["code"] for f in result["findings"]}
        assert "ESSENCE_DESCRIPTOR_MISMATCH" in codes
