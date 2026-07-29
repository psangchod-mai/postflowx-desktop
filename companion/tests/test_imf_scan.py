"""Tests for imf_scan.py — IMF/SMPTE package XML parsing.

Covers:
- _parse_rate: edit-rate string → float fps
- _parse_cpl: CPL XML → parsed metadata dict
- _parse_asset_map: ASSETMAP XML → asset registry
- scan_imf_package: integration scan of a minimal synthetic package
"""
from __future__ import annotations

import json
import textwrap
import uuid
from pathlib import Path

import pytest

from postflowx_companion.imf_scan import (
    _parse_rate,
    _parse_cpl,
    _parse_asset_map,
    scan_imf_package,
)


# ── _parse_rate ───────────────────────────────────────────────────────────────

class TestParseRate:
    def test_nominal_24(self):
        assert _parse_rate("24 1") == pytest.approx(24.0)

    def test_fractional_24000_1001(self):
        assert _parse_rate("24000 1001") == pytest.approx(24000 / 1001, rel=1e-6)

    def test_25(self):
        assert _parse_rate("25 1") == pytest.approx(25.0)

    def test_30(self):
        assert _parse_rate("30 1") == pytest.approx(30.0)

    def test_30000_1001(self):
        assert _parse_rate("30000 1001") == pytest.approx(30000 / 1001, rel=1e-6)

    def test_48(self):
        assert _parse_rate("48 1") == pytest.approx(48.0)

    def test_single_number(self):
        assert _parse_rate("24") == pytest.approx(24.0)

    def test_empty_returns_default(self):
        assert _parse_rate("", default=24.0) == 24.0

    def test_none_returns_default(self):
        assert _parse_rate(None, default=25.0) == 25.0  # type: ignore

    def test_garbage_returns_default(self):
        assert _parse_rate("not a rate") == 24.0

    def test_zero_denominator_returns_default(self):
        assert _parse_rate("24 0") == 24.0


# ── minimal CPL XML fixtures ───────────────────────────────────────────────────

def _minimal_cpl(
    *,
    cpl_id: str = "",
    edit_rate: str = "24 1",
    total_frames: int = 48,
    extra: str = "",
) -> str:
    cpl_id = cpl_id or str(uuid.uuid4())
    return textwrap.dedent(f"""<?xml version="1.0" encoding="UTF-8"?>
    <CompositionPlaylist
        xmlns="http://www.smpte-ra.org/schemas/2067-3/2016"
        xmlns:cc="http://www.smpte-ra.org/schemas/2067-2/2016">
      <Id>urn:uuid:{cpl_id}</Id>
      <EditRate>{edit_rate}</EditRate>
      <TotalRunTime>00:00:02:00</TotalRunTime>
      <ContentTitle>Test Title</ContentTitle>
      <Issuer>Test Issuer</Issuer>
      <EssenceDescriptorList/>
      <ReelList>
        <Reel>
          <Id>urn:uuid:{uuid.uuid4()}</Id>
          <AssetList>
            <MainImageSequence>
              <Id>urn:uuid:{uuid.uuid4()}</Id>
              <TrackFileList>
                <TrackFile>
                  <Id>urn:uuid:{uuid.uuid4()}</Id>
                  <SourceEncoding>urn:uuid:{uuid.uuid4()}</SourceEncoding>
                  <EntryPoint>0</EntryPoint>
                  <Duration>{total_frames}</Duration>
                </TrackFile>
              </TrackFileList>
            </MainImageSequence>
          </AssetList>
        </Reel>
      </ReelList>
      {extra}
    </CompositionPlaylist>
    """)


# ── _parse_cpl ────────────────────────────────────────────────────────────────

class TestParseCPL:
    def test_edit_rate_24(self, tmp_path):
        cpl = tmp_path / "cpl.xml"
        cpl.write_text(_minimal_cpl(edit_rate="24 1"), encoding="utf-8")
        result = _parse_cpl(cpl)
        assert result["editRate"] == pytest.approx(24.0)

    def test_edit_rate_25(self, tmp_path):
        cpl = tmp_path / "cpl.xml"
        cpl.write_text(_minimal_cpl(edit_rate="25 1"), encoding="utf-8")
        result = _parse_cpl(cpl)
        assert result["editRate"] == pytest.approx(25.0)

    def test_edit_rate_fractional(self, tmp_path):
        cpl = tmp_path / "cpl.xml"
        cpl.write_text(_minimal_cpl(edit_rate="24000 1001"), encoding="utf-8")
        result = _parse_cpl(cpl)
        assert result["editRate"] == pytest.approx(24000 / 1001, rel=1e-5)

    def test_cpl_id_extracted(self, tmp_path):
        cpl_id = str(uuid.uuid4())
        cpl = tmp_path / "cpl.xml"
        cpl.write_text(_minimal_cpl(cpl_id=cpl_id), encoding="utf-8")
        result = _parse_cpl(cpl)
        assert result["id"].lower().replace("urn:uuid:", "") == cpl_id.lower()

    def test_content_title(self, tmp_path):
        cpl = tmp_path / "cpl.xml"
        cpl.write_text(_minimal_cpl(), encoding="utf-8")
        result = _parse_cpl(cpl)
        assert result.get("contentTitle") == "Test Title"

    def test_total_frames_is_integer(self, tmp_path):
        # Minimal CPL has no EssenceDescriptors — totalFrames stays 0.
        # Test that the key exists and is an int.
        cpl = tmp_path / "cpl.xml"
        cpl.write_text(_minimal_cpl(total_frames=96), encoding="utf-8")
        result = _parse_cpl(cpl)
        assert isinstance(result.get("totalFrames"), int)

    def test_segments_key_present(self, tmp_path):
        # _parse_cpl returns 'segments' (the parsed reel data), not 'reels'
        cpl = tmp_path / "cpl.xml"
        cpl.write_text(_minimal_cpl(), encoding="utf-8")
        result = _parse_cpl(cpl)
        assert "segments" in result

    def test_audio_tracks_list(self, tmp_path):
        cpl = tmp_path / "cpl.xml"
        cpl.write_text(_minimal_cpl(), encoding="utf-8")
        result = _parse_cpl(cpl)
        assert isinstance(result.get("audioTracks"), list)


# ── minimal ASSETMAP XML ───────────────────────────────────────────────────────

def _minimal_assetmap(assets: list[tuple[str, str, bool]]) -> str:
    """assets = [(id, path, is_pkl), ...]"""
    asset_xml = ""
    for aid, path, is_pkl in assets:
        pkl_tag = "<PackingList>true</PackingList>" if is_pkl else ""
        asset_xml += f"""
        <Asset>
          <Id>urn:uuid:{aid}</Id>
          <ChunkList>
            <Chunk>
              <Path>{path}</Path>
            </Chunk>
          </ChunkList>
          {pkl_tag}
        </Asset>"""
    return textwrap.dedent(f"""<?xml version="1.0" encoding="UTF-8"?>
    <AssetMap xmlns="http://www.smpte-ra.org/schemas/429-9/2007">
      <Id>urn:uuid:{uuid.uuid4()}</Id>
      <AssetList>{asset_xml}
      </AssetList>
    </AssetMap>
    """)


# ── _parse_asset_map ──────────────────────────────────────────────────────────

class TestParseAssetMap:
    def test_assets_extracted(self, tmp_path):
        aid1 = str(uuid.uuid4())
        aid2 = str(uuid.uuid4())
        am = tmp_path / "ASSETMAP.xml"
        am.write_text(_minimal_assetmap([
            (aid1, "video.mxf", False),
            (aid2, "pkl.xml", True),
        ]), encoding="utf-8")
        result = _parse_asset_map(am)
        assert aid1 in result["assets"]
        assert aid2 in result["assets"]

    def test_pkl_flag_set(self, tmp_path):
        pkl_id = str(uuid.uuid4())
        am = tmp_path / "ASSETMAP.xml"
        am.write_text(_minimal_assetmap([(pkl_id, "pkl.xml", True)]), encoding="utf-8")
        result = _parse_asset_map(am)
        assert result["assets"][pkl_id]["isPKL"] is True

    def test_non_pkl_flag_false(self, tmp_path):
        vid_id = str(uuid.uuid4())
        am = tmp_path / "ASSETMAP.xml"
        am.write_text(_minimal_assetmap([(vid_id, "video.mxf", False)]), encoding="utf-8")
        result = _parse_asset_map(am)
        assert result["assets"][vid_id]["isPKL"] is False

    def test_asset_path_captured(self, tmp_path):
        aid = str(uuid.uuid4())
        am = tmp_path / "ASSETMAP.xml"
        am.write_text(_minimal_assetmap([(aid, "my_video.mxf", False)]), encoding="utf-8")
        result = _parse_asset_map(am)
        assert "my_video.mxf" in (result["assets"][aid]["path"] or "")

    def test_empty_assetlist(self, tmp_path):
        am = tmp_path / "ASSETMAP.xml"
        am.write_text(textwrap.dedent("""<?xml version="1.0"?>
        <AssetMap xmlns="http://www.smpte-ra.org/schemas/429-9/2007">
          <Id>urn:uuid:00000000-0000-0000-0000-000000000001</Id>
          <AssetList/>
        </AssetMap>
        """), encoding="utf-8")
        result = _parse_asset_map(am)
        assert result["assets"] == {}


# ── SourceDuration / EntryPoint defaulting (ST 2067-3 §6.6) ────────────────────
# A <Resource> with no explicit <SourceDuration> must default to
# IntrinsicDuration - EntryPoint, not to IntrinsicDuration alone — a resource
# can validly skip its first EntryPoint frames without ever stating
# SourceDuration explicitly.

def _cpl_with_segment_resource(*, intrinsic: int, entry: int, source_duration: str | None) -> str:
    cpl_id = str(uuid.uuid4())
    sd_tag = f"<SourceDuration>{source_duration}</SourceDuration>" if source_duration is not None else ""
    return textwrap.dedent(f"""<?xml version="1.0" encoding="UTF-8"?>
    <CompositionPlaylist
        xmlns="http://www.smpte-ra.org/schemas/2067-3/2016">
      <Id>urn:uuid:{cpl_id}</Id>
      <EditRate>24 1</EditRate>
      <ContentTitle>Test Title</ContentTitle>
      <SegmentList>
        <Segment>
          <Id>urn:uuid:{uuid.uuid4()}</Id>
          <SequenceList>
            <MainImageSequence>
              <Id>urn:uuid:{uuid.uuid4()}</Id>
              <TrackId>urn:uuid:{uuid.uuid4()}</TrackId>
              <ResourceList>
                <Resource>
                  <Id>urn:uuid:{uuid.uuid4()}</Id>
                  <TrackFileId>urn:uuid:{uuid.uuid4()}</TrackFileId>
                  <EditRate>24 1</EditRate>
                  <IntrinsicDuration>{intrinsic}</IntrinsicDuration>
                  <EntryPoint>{entry}</EntryPoint>
                  {sd_tag}
                </Resource>
              </ResourceList>
            </MainImageSequence>
          </SequenceList>
        </Segment>
      </SegmentList>
    </CompositionPlaylist>
    """)


class TestSourceDurationDefaulting:
    def test_omitted_source_duration_defaults_to_intrinsic_minus_entry_point(self, tmp_path):
        cpl = tmp_path / "cpl.xml"
        cpl.write_text(
            _cpl_with_segment_resource(intrinsic=1000, entry=200, source_duration=None),
            encoding="utf-8",
        )
        result = _parse_cpl(cpl)
        resource = result["segments"][0]["resources"][0]
        assert resource["sourceDuration"] == 800, \
            "omitted SourceDuration must default to IntrinsicDuration - EntryPoint (1000-200), not IntrinsicDuration alone"
        assert result["totalFrames"] == 800

    def test_explicit_source_duration_is_used_verbatim(self, tmp_path):
        cpl = tmp_path / "cpl.xml"
        cpl.write_text(
            _cpl_with_segment_resource(intrinsic=1000, entry=200, source_duration="500"),
            encoding="utf-8",
        )
        result = _parse_cpl(cpl)
        resource = result["segments"][0]["resources"][0]
        assert resource["sourceDuration"] == 500
        assert result["totalFrames"] == 500

    def test_zero_entry_point_omitted_source_duration_equals_intrinsic(self, tmp_path):
        cpl = tmp_path / "cpl.xml"
        cpl.write_text(
            _cpl_with_segment_resource(intrinsic=1000, entry=0, source_duration=None),
            encoding="utf-8",
        )
        result = _parse_cpl(cpl)
        resource = result["segments"][0]["resources"][0]
        assert resource["sourceDuration"] == 1000


# ── scan_imf_package integration ───────────────────────────────────────────────

def _write_minimal_package(root: Path) -> tuple[str, str]:
    """Write the smallest valid IMF package structure. Returns (cpl_id, assetmap_path)."""
    cpl_id = str(uuid.uuid4())
    pkl_id = str(uuid.uuid4())
    am_id  = str(uuid.uuid4())
    cpl_uuid_file = f"CPL_{cpl_id}.xml"
    pkl_uuid_file = f"PKL_{pkl_id}.xml"

    # CPL
    cpl_path = root / cpl_uuid_file
    cpl_path.write_text(_minimal_cpl(cpl_id=cpl_id), encoding="utf-8")

    # PKL (minimal)
    pkl_path = root / pkl_uuid_file
    pkl_path.write_text(textwrap.dedent(f"""<?xml version="1.0"?>
    <PackingList xmlns="http://www.smpte-ra.org/schemas/2067-2/2016">
      <Id>urn:uuid:{pkl_id}</Id>
      <AssetList>
        <Asset>
          <Id>urn:uuid:{cpl_id}</Id>
          <Hash>AAAA</Hash>
          <Size>1000</Size>
          <Type>text/xml</Type>
          <OriginalFileName>{cpl_uuid_file}</OriginalFileName>
        </Asset>
      </AssetList>
    </PackingList>
    """), encoding="utf-8")

    # ASSETMAP
    am_path = root / "ASSETMAP.xml"
    am_path.write_text(_minimal_assetmap([
        (pkl_id, pkl_uuid_file, True),
        (cpl_id, cpl_uuid_file, False),
    ]), encoding="utf-8")

    return cpl_id, str(am_path)


class TestScanImfPackage:
    def test_scan_returns_dict(self, tmp_path):
        _write_minimal_package(tmp_path)
        result = scan_imf_package(str(tmp_path))
        assert isinstance(result, dict)

    def test_scan_finds_cpl(self, tmp_path):
        cpl_id, _ = _write_minimal_package(tmp_path)
        result = scan_imf_package(str(tmp_path))
        # cpls contains CplScanResult.to_dict() entries — key is 'cplId'
        cpls = result.get("cpls") or []
        ids = [str(c.get("cplId") or c.get("id") or "").lower() for c in cpls]
        assert any(cpl_id.lower() in i for i in ids), \
            f"CPL {cpl_id} not found in scanned CPLs: {ids}"

    def test_scan_has_folder_path(self, tmp_path):
        _write_minimal_package(tmp_path)
        result = scan_imf_package(str(tmp_path))
        assert str(tmp_path) in (result.get("folderPath") or "")

    def test_scan_nonexistent_folder_raises(self):
        # scan_imf_package raises FileNotFoundError on missing folder
        with pytest.raises(FileNotFoundError):
            scan_imf_package("/tmp/does_not_exist_pfx_test_12345")

    def test_scan_empty_folder_raises(self, tmp_path):
        # scan_imf_package raises ValueError when no ASSETMAP.xml is found
        with pytest.raises(ValueError, match="ASSETMAP"):
            scan_imf_package(str(tmp_path))
