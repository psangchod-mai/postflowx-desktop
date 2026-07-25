"""S-ADM parsing for the IAB (Dolby Atmos) tab — runs on every machine.

`test_iab_inspect.py` asserts the same contract against the real Meridian MXF,
but that sample is a few hundred MB and lives only on one workstation, so it
skips in CI and on any fresh checkout — the logic was effectively uncovered.
These tests drive `_parse_adm_xml` directly with a synthetic ADM block shaped
like Meridian (7.1.2 DirectSpeakers bed + 48 dynamic objects), so the bed/object
model is locked down without the fixture.

Regression guard: EBU ADM stores `audioObjectName` as an ATTRIBUTE on
`<audioObject>`, not as a child element. Reading it as a child returned 0 names,
which made the IAB tab report 0 objects for a package that has 49.
"""
from __future__ import annotations

import pytest

from postflowx_companion.api import _parse_adm_xml

_NS = "urn:ebu:metadata-schema:ebuCore_2016"


def _adm_xml(*, n_objects: int = 48, bed_channels: int = 10,
             name_as_attribute: bool = True, object_name: str | None = None) -> str:
    """Build an ADM block: one DirectSpeakers bed pack + `n_objects` object packs.

    `name_as_attribute=False` reproduces the (invalid-for-EBU) child-element
    naming style, used to prove the counts no longer depend on names at all.
    `object_name` gives every object the SAME name — real packages do this
    (e.g. all objects called "Atmos"), and a deduping reader collapses them.
    """
    def obj(oid: str, name: str) -> str:
        if name_as_attribute:
            return f'<audioObject audioObjectID="{oid}" audioObjectName="{name}"/>'
        return f'<audioObject audioObjectID="{oid}"><audioObjectName>{name}</audioObjectName></audioObject>'

    objects = [obj("AO_1001", "Bed")]
    objects += [obj(f"AO_{1002 + i:04d}", object_name or f"Object {i + 1}")
                for i in range(n_objects)]

    chan_refs = "".join(
        f"<audioChannelFormatIDRef>AC_0001{i:04d}</audioChannelFormatIDRef>"
        for i in range(bed_channels)
    )
    bed_pack = (
        '<audioPackFormat audioPackFormatID="AP_00010001"'
        ' audioPackFormatName="7.1.2 Bed"'
        ' typeDefinition="DirectSpeakers" typeLabel="0001">'
        f"{chan_refs}</audioPackFormat>"
    )
    object_packs = "".join(
        f'<audioPackFormat audioPackFormatID="AP_0003{i:04d}"'
        f' audioPackFormatName="Object {i + 1}"'
        ' typeDefinition="Objects" typeLabel="0003"/>'
        for i in range(n_objects)
    )

    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<ebuCoreMain xmlns="{_NS}"><coreMetadata><format><audioFormatExtended>'
        '<audioProgramme audioProgrammeID="APR_1001" audioProgrammeName="Atmos Programme"/>'
        '<audioContent audioContentID="ACO_1001" audioContentName="Main"/>'
        f'{"".join(objects)}{bed_pack}{object_packs}'
        "</audioFormatExtended></format></coreMetadata></ebuCoreMain>"
    )


@pytest.fixture(scope="module")
def meridian_like() -> dict:
    return _parse_adm_xml(_adm_xml())


# ── The Meridian contract (mirrors test_iab_inspect.py, minus the fixture) ────

def test_object_count_and_bed_layout(meridian_like):
    r = meridian_like
    assert r["admStats"]["audioObject"] == 49       # 1 bed + 48 objects
    assert r["objectSummary"]["totalObjects"] == 49
    assert r["objectSummary"]["bedObjects"] == 1
    assert r["objectSummary"]["dynamicObjects"] == 48
    assert r["bedLayout"] == "7.1.2"
    assert r["beds"][0]["channels"] == 10


def test_track_list(meridian_like):
    tracks = meridian_like["tracks"]
    beds = [t for t in tracks if t["type"] == "bed"]
    objs = [t for t in tracks if t["type"] == "object"]
    assert len(tracks) == 49
    assert len(beds) == 1 and beds[0]["layout"] == "7.1.2"
    assert len(objs) == 48
    assert objs[0]["name"] == "Object 1"


def test_namespaced_tags_are_stripped(meridian_like):
    # The real ADM block is namespaced; every count above depends on _strip_ns.
    assert meridian_like["xmlRoot"] == "ebuCoreMain"
    assert meridian_like["admStats"]["audioPackFormat"] == 49


# ── Regression guards ─────────────────────────────────────────────────────────

def test_names_read_from_attributes_not_child_elements():
    # The original bug: names live in attributes, so a child-element read
    # returned [] and the tab showed 0 objects.
    r = _parse_adm_xml(_adm_xml())
    assert r["objectNames"][0] == "Bed"
    assert "Object 48" in r["objectNames"]
    assert len(r["objectNames"]) == 49


def test_counts_survive_missing_names():
    # Counts must come from ADM element/type counts, never len(names) — a
    # package whose objects carry no name attribute still reports 49 objects.
    r = _parse_adm_xml(_adm_xml(name_as_attribute=False))
    assert r["objectNames"] == []                    # no attribute names present
    assert r["admStats"]["audioObject"] == 49
    assert r["objectSummary"]["totalObjects"] == 49  # count-driven, not name-driven
    assert r["objectSummary"]["dynamicObjects"] == 48
    assert r["bedLayout"] == "7.1.2"


def test_track_view_survives_missing_names():
    # The track view is what the Resolve-style panel renders. It used to iterate
    # the deduped name list, so a package with no audioObjectName attributes drew
    # a bed-only view while the summary correctly said 49. Rows are count-driven
    # now; the labels are synthesized.
    r = _parse_adm_xml(_adm_xml(name_as_attribute=False))
    objs = [t for t in r["tracks"] if t["type"] == "object"]
    assert len(objs) == 48
    assert objs[0]["name"] == "Object 1"
    assert objs[47]["name"] == "Object 48"


def test_track_view_keeps_duplicate_named_objects():
    # Names may legitimately repeat. Deduping collapsed 48 objects into 1 row.
    r = _parse_adm_xml(_adm_xml(object_name="Atmos"))
    objs = [t for t in r["tracks"] if t["type"] == "object"]
    assert len(r["objectNames"]) == 2          # deduped: "Bed" + "Atmos"
    assert len(objs) == 48                     # …but every object still gets a row
    assert all(t["name"] == "Atmos" for t in objs)


@pytest.mark.parametrize("channels,layout", [
    (6, "5.1"), (8, "7.1"), (10, "7.1.2"), (12, "7.1.4"), (16, "9.1.6"),
])
def test_bed_layout_ladder(channels, layout):
    r = _parse_adm_xml(_adm_xml(n_objects=2, bed_channels=channels))
    assert r["bedLayout"] == layout
    assert r["beds"][0]["channels"] == channels


def test_unknown_bed_width_falls_back_to_channel_count():
    r = _parse_adm_xml(_adm_xml(n_objects=1, bed_channels=11))
    assert r["bedLayout"] == "11ch"


def test_xxe_is_refused():
    # ADM comes out of an untrusted package; safe_xml must reject DOCTYPE/ENTITY.
    from postflowx_companion.safe_xml import UnsafeXMLError
    hostile = (
        '<?xml version="1.0"?>'
        '<!DOCTYPE ebuCoreMain [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
        f'<ebuCoreMain xmlns="{_NS}"><coreMetadata/></ebuCoreMain>'
    )
    with pytest.raises(UnsafeXMLError):
        _parse_adm_xml(hostile)
