"""Tests for imf_conform.py — essence-descriptor ↔ codestream conformance.

Pure comparison logic exercised with synthesized descriptor + probe dicts, plus a
mocked probe function for the check_cpl_conformance wiring — no external media.
"""
from __future__ import annotations

import pytest

from postflowx_companion.imf_conform import (
    canonical_codec,
    check_cpl_conformance,
    compare_descriptor_to_probe,
    _parse_fps,
)


# ── codec canonicalisation ─────────────────────────────────────────────────

class TestCanonicalCodec:
    def test_cpl_j2k_matches_ffprobe(self):
        assert canonical_codec("JPEG 2000") == canonical_codec("jpeg2000")

    def test_htj2k_is_j2k_family(self):
        assert canonical_codec("HTJ2K (JPEG 2000 Part 15)") == "j2k"

    def test_prores_variants(self):
        assert canonical_codec("ProRes") == "prores"
        assert canonical_codec("apch") == "prores"

    def test_unknown_passthrough(self):
        assert canonical_codec("h264") == "h264"

    def test_empty(self):
        assert canonical_codec("") == ""


# ── fps parsing ──────────────────────────────────────────────────────────────

class TestParseFps:
    def test_float(self):
        assert _parse_fps(24.0) == 24.0

    def test_rational_slash(self):
        assert _parse_fps("24000/1001") == pytest.approx(24000 / 1001)

    def test_space_separated(self):
        assert _parse_fps("24 1") == 24.0

    def test_plain_int_string(self):
        assert _parse_fps("25") == 25.0

    def test_none(self):
        assert _parse_fps(None) is None

    def test_dash(self):
        assert _parse_fps("–") is None


# ── comparison ───────────────────────────────────────────────────────────────

class TestCompare:
    def _descriptor(self, **kw):
        base = {"resolution": {"w": "3840", "h": "2160"}, "editRate": 24.0, "codec": "JPEG 2000"}
        base.update(kw)
        return base

    def _probe(self, **kw):
        base = {"ok": True, "width": 3840, "height": 2160, "editRate": "24/1", "pictureCodec": "jpeg2000"}
        base.update(kw)
        return base

    def test_all_match_passes(self):
        r = compare_descriptor_to_probe(self._descriptor(), self._probe())
        assert r.ok is True
        d = r.to_dict()
        assert d["overallStatus"] == "pass"
        assert d["errorCount"] == 0

    def test_width_mismatch(self):
        r = compare_descriptor_to_probe(self._descriptor(), self._probe(width=1998))
        assert r.ok is False
        errs = [f for f in r.findings if f.severity == "error"]
        assert any(f.field_name == "width" for f in errs)

    def test_height_mismatch(self):
        r = compare_descriptor_to_probe(self._descriptor(), self._probe(height=1080))
        assert r.ok is False
        assert any(f.field_name == "height" and f.severity == "error" for f in r.findings)

    def test_fps_mismatch(self):
        r = compare_descriptor_to_probe(self._descriptor(), self._probe(editRate="30/1"))
        assert r.ok is False
        assert any(f.field_name == "frameRate" and f.severity == "error" for f in r.findings)

    def test_fps_within_tolerance_passes(self):
        # 24 vs 23.976 — outside default tol → error; but 24 vs 24.001 within tol.
        r = compare_descriptor_to_probe(
            self._descriptor(editRate=24.0), self._probe(editRate="24001/1000")
        )
        assert not any(f.field_name == "frameRate" and f.severity == "error" for f in r.findings)

    def test_ntsc_fps_flagged_against_integer_rate(self):
        r = compare_descriptor_to_probe(
            self._descriptor(editRate=24.0), self._probe(editRate="24000/1001")
        )
        assert r.ok is False
        assert any(f.field_name == "frameRate" and f.severity == "error" for f in r.findings)

    def test_codec_mismatch(self):
        r = compare_descriptor_to_probe(
            self._descriptor(codec="ProRes"), self._probe(pictureCodec="jpeg2000")
        )
        assert r.ok is False
        assert any(f.field_name == "codec" and f.severity == "error" for f in r.findings)

    def test_codec_family_equivalent_passes(self):
        r = compare_descriptor_to_probe(
            self._descriptor(codec="HTJ2K (JPEG 2000 Part 15)"),
            self._probe(pictureCodec="jpeg2000"),
        )
        assert not any(f.field_name == "codec" and f.severity == "error" for f in r.findings)

    def test_missing_probe_value_is_info_not_error(self):
        r = compare_descriptor_to_probe(self._descriptor(), self._probe(width=0))
        # width unknown on probe side → info, not error
        w = next(f for f in r.findings if f.field_name == "width")
        assert w.severity == "info"
        assert r.ok is True

    def test_failed_probe_skips(self):
        r = compare_descriptor_to_probe(self._descriptor(), {"ok": False, "error": "no demuxer"})
        d = r.to_dict()
        assert d["checked"] is False
        assert d["overallStatus"] == "skip"
        assert "no demuxer" in d["reason"]


# ── check_cpl_conformance wiring ────────────────────────────────────────────

class TestCheckCplConformance:
    def test_uses_injected_probe(self):
        cpl = {
            "id": "abc",
            "contentTitle": "T",
            "resolution": {"w": "1920", "h": "1080"},
            "editRate": 25.0,
            "codec": "ProRes",
        }

        def fake_probe(cpl_path, assetmaps):
            assert cpl_path == "/x/cpl.xml"
            assert assetmaps == ["/x/ASSETMAP.xml"]
            return {"ok": True, "width": 1920, "height": 1080,
                    "editRate": "25/1", "pictureCodec": "apch"}

        out = check_cpl_conformance(cpl, "/x/cpl.xml", ["/x/ASSETMAP.xml"], probe_fn=fake_probe)
        assert out["overallStatus"] == "pass"
        assert out["cplId"] == "abc"

    def test_probe_exception_gates(self):
        cpl = {"id": "z", "resolution": {"w": "1920", "h": "1080"}, "editRate": 24.0, "codec": "JPEG 2000"}

        def boom(cpl_path, assetmaps):
            raise RuntimeError("ffprobe exploded")

        out = check_cpl_conformance(cpl, "/x/cpl.xml", [], probe_fn=boom)
        assert out["checked"] is False
        assert out["overallStatus"] == "skip"
        assert "exploded" in out["reason"]

    def test_mismatch_reported(self):
        cpl = {"id": "m", "resolution": {"w": "3840", "h": "2160"}, "editRate": 24.0, "codec": "JPEG 2000"}

        def fake_probe(cpl_path, assetmaps):
            return {"ok": True, "width": 1920, "height": 1080,
                    "editRate": "24/1", "pictureCodec": "jpeg2000"}

        out = check_cpl_conformance(cpl, "/x/cpl.xml", [], probe_fn=fake_probe)
        assert out["overallStatus"] == "fail"
        assert out["errorCount"] >= 2  # width + height
