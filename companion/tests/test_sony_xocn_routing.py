"""Sony X-OCN detection + routing.

A standalone X-OCN MXF has no Sony card folder and ffmpeg can't decode its
essence (codec 'unknown', 0x0), so the old tag detector mislabeled it 'Generic'
→ ffmpeg (which fails). It must be recognized as Sony via the MXF AXS authoring
tags and routed to Resolve. Decodable Sony XAVC must stay on the ffmpeg path.
"""
from __future__ import annotations

from postflowx_companion.ocf_engine import ocf_probe, ocf_router


def test_xocn_axs_tags_detected_as_sony():
    # Real Venice X-OCN signature: company_name=Sony, product_name="AXS ", essence undecodable.
    fam = ocf_probe._detect_family_from_tags(
        {"company_name": "Sony", "product_name": "AXS ", "product_version": "2.0"},
        codec="unknown", ext=".mxf")
    assert fam == "Sony"


def test_xocn_unknown_codec_sony_company_detected():
    fam = ocf_probe._detect_family_from_tags(
        {"company_name": "Sony"}, codec="mxf", ext=".mxf")
    assert fam == "Sony"


def test_sony_xavc_stays_generic():
    # Decodable Sony XAVC (h264) must NOT be forced to Sony/Resolve.
    fam = ocf_probe._detect_family_from_tags(
        {"company_name": "Sony", "product_name": "XAVC"}, codec="h264", ext=".mxf")
    assert fam == "Generic"


def test_non_sony_mxf_stays_generic():
    fam = ocf_probe._detect_family_from_tags({}, codec="mxf", ext=".mxf")
    assert fam == "Generic"


def test_sony_routes_to_resolve_then_proxy():
    eng, fallbacks, reason = ocf_router.select_ocf_engine({"cameraFamily": "Sony"})
    # Sony X-OCN decode is Resolve's job (native X-OCN support), proxy as fallback.
    assert "Resolve" in eng or "Proxy" in eng
    assert reason in ("sony_resolve", "sony_proxy_fallback")
