from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha1
from pathlib import Path
from typing import Any
import xml.etree.ElementTree as ET

from . import safe_xml


UL_TRANSFER = {
    "060e2b34.0401010d.04010101.01010000": "Gamma 2.2",
    "060e2b34.0401010d.04010101.01020000": "Gamma 2.8",
    "060e2b34.0401010d.04010101.01050000": "Rec.709",
    "060e2b34.0401010d.04010101.010a0000": "PQ / ST 2084 (HDR)",
    "060e2b34.0401010d.04010101.010e0000": "HLG",
    "060e2b34.0401010d.04010101.010f0000": "S-Log3",
}

UL_PRIMARIES = {
    "060e2b34.0401010d.04010101.03010000": "BT.709",
    "060e2b34.0401010d.04010101.03030000": "P3-D60",
    "060e2b34.0401010d.04010101.03040000": "P3-DCI",
    "060e2b34.0401010d.04010101.03060000": "P3-D65",
    "060e2b34.0401010d.04010101.03090000": "BT.2020",
}


def _lname(tag: str) -> str:
    return tag.split("}")[-1] if "}" in tag else tag


def _clean_uuid(value: str) -> str:
    return (value or "").strip().replace("urn:uuid:", "")


def _text(node: ET.Element | None, local_name: str) -> str:
    if node is None:
        return ""
    for child in node.iter():
        if _lname(child.tag) == local_name and child.text:
            return child.text.strip()
    return ""


def _child_text(node: ET.Element | None, local_name: str) -> str:
    if node is None:
        return ""
    for child in list(node):
        if _lname(child.tag) == local_name and child.text:
            return child.text.strip()
    return ""


def _find_all(root: ET.Element, local_name: str) -> list[ET.Element]:
    return [node for node in root.iter() if _lname(node.tag) == local_name]


def _find_first(root: ET.Element, local_name: str) -> ET.Element | None:
    for node in root.iter():
        if _lname(node.tag) == local_name:
            return node
    return None


def _read_xml(path: Path) -> tuple[str, ET.Element]:
    # XXE-hardened: rejects CPL/PKL/ASSETMAP carrying a DOCTYPE/ENTITY decl.
    return safe_xml.read_xml(path)


def _parse_rate(text: str, default: float = 24.0) -> float:
    try:
        parts = str(text or "").strip().split()
        if len(parts) >= 2 and float(parts[1]):
            return float(parts[0]) / float(parts[1])
        if len(parts) == 1 and float(parts[0]):
            return float(parts[0])
    except Exception:
        pass
    return default


def _ul_label(mapping: dict[str, str], urn: str) -> str:
    if not urn:
        return "–"
    key = urn.replace("urn:smpte:ul:", "").lower()
    if key in mapping:
        return mapping[key]
    last = (urn.split(".")[-1] if "." in urn else urn.split(":")[-1]).upper()
    return last.rstrip("0") or urn


def _to_rel(path: Path, base: Path) -> str:
    return path.resolve().relative_to(base.resolve()).as_posix()


def _norm_join(root: Path, rel: str) -> Path:
    return (root / str(rel or "").strip()).resolve()


def _candidate_xml_asset(asset: dict[str, Any]) -> bool:
    kind = str(asset.get("type") or "").lower()
    label = f"{asset.get('file') or ''} {asset.get('assetMapPath') or ''}".lower()
    return "xml" in kind or label.endswith(".xml")


def _detect_prores(root: ET.Element) -> bool:
    for node in root.iter():
        name = _lname(node.tag)
        text = (node.text or "").strip()
        if "ProRes" in name or "ProRes" in text:
            return True
        if name == "PictureEssenceCoding" and "prores" in text.lower():
            return True
    return False


def _parse_asset_map(assetmap_path: Path) -> dict[str, Any]:
    _, root = _read_xml(assetmap_path)
    assets: dict[str, Any] = {}
    for asset in _find_all(root, "Asset"):
        asset_id = _clean_uuid(_text(asset, "Id"))
        path = _text(asset, "Path") or _text(asset, "ChunkPath")
        is_pkl = _find_first(asset, "PackingList") is not None
        if asset_id:
            assets[asset_id] = {
                "id": asset_id,
                "path": path,
                "isPKL": is_pkl,
            }
    return {
        "id": _clean_uuid(_text(root, "Id")),
        "annotation": _text(root, "AnnotationText") or _text(root, "Annotation"),
        "issuer": _text(root, "Issuer"),
        "creator": _text(root, "Creator"),
        "issueDate": _text(root, "IssueDate"),
        "assets": assets,
    }


def _parse_pkl(pkl_path: Path, asset_map: dict[str, Any]) -> dict[str, Any]:
    _, root = _read_xml(pkl_path)
    assets: dict[str, Any] = {}
    asset_map_assets = asset_map.get("assets") or {}
    for asset in _find_all(root, "Asset"):
        asset_id = _clean_uuid(_text(asset, "Id"))
        if not asset_id:
            continue
        assets[asset_id] = {
            "id": asset_id,
            "size": int(_text(asset, "Size") or "0"),
            "hash": _text(asset, "Hash"),
            "type": _text(asset, "Type"),
            "file": _text(asset, "OriginalFileName") or _text(asset, "AnnotationText") or "",
            "assetMapPath": (asset_map_assets.get(asset_id) or {}).get("path", ""),
        }
    return {
        "id": _clean_uuid(_text(root, "Id")),
        "annotation": _text(root, "AnnotationText"),
        "issueDate": _text(root, "IssueDate"),
        "creator": _text(root, "Creator"),
        "assets": assets,
    }


def _parse_cpl(cpl_path: Path) -> dict[str, Any]:
    _, root = _read_xml(cpl_path)
    er_text = _text(root, "EditRate") or "24 1"
    edit_rate = _parse_rate(er_text, 24.0)

    descriptors: list[dict[str, Any]] = []
    for ed in _find_all(root, "EssenceDescriptor"):
        desc_id = _clean_uuid(_text(ed, "Id"))
        width = _text(ed, "StoredWidth") or _text(ed, "SampledWidth") or "–"
        height = _text(ed, "StoredHeight") or _text(ed, "SampledHeight") or "–"
        transfer = _ul_label(UL_TRANSFER, _text(ed, "TransferCharacteristic"))
        primaries = _ul_label(UL_PRIMARIES, _text(ed, "ColorPrimaries"))
        depth = _text(ed, "ComponentDepth")
        if not depth or not depth.isdigit():
            max_depth = 0
            for comp in _find_all(ed, "RGBAComponent"):
                try:
                    max_depth = max(max_depth, int(_text(comp, "ComponentDepth") or "0"))
                except Exception:
                    pass
            depth = str(max_depth) if max_depth > 0 else (_text(ed, "J2KComponentSizing") or "–")

        is_iab = _find_first(ed, "IABEssenceDescriptor") is not None or _find_first(ed, "IABSoundfieldLabelSubDescriptor") is not None
        channel_count = 0
        if not is_iab:
            cc_text = _text(ed, "ChannelCount") or _text(ed, "Channels")
            try:
                channel_count = int(cc_text or "0")
            except Exception:
                pass
        is_rgba = _find_first(ed, "RGBADescriptor") is not None
        is_cdci = _find_first(ed, "CDCIDescriptor") is not None
        is_j2k = (
            _find_first(ed, "JPEG2000SubDescriptor") is not None
            or _find_first(ed, "J2CLayout") is not None
            or _find_first(ed, "ContainerConstraintsSubDescriptor") is not None
        )
        pec_ul = _text(ed, "PictureEssenceCoding")
        is_htj2k = is_j2k or "0d01030c" in pec_ul or "04010202.03010000" in pec_ul
        is_picture = is_rgba or is_cdci or is_htj2k or (not is_iab and width != "–")
        is_dvision = _find_first(ed, "DolbyVisionFrameInfo") is not None or _find_first(ed, "DolbyVisionSubDescriptor") is not None
        dv_node = _find_first(ed, "DolbyVisionSubDescriptor") or _find_first(ed, "DolbyVisionFrameInfo")
        dv_profile = _text(dv_node, "DVProfile") or _text(dv_node, "Profile")
        dv_level = _text(dv_node, "DVLevel") or _text(dv_node, "Level")
        dv_trim_passes = len(_find_all(dv_node, "DolbyVisionTrimPass")) if dv_node is not None else 0
        frame_layout = _text(ed, "FrameLayout")
        is_interlaced = "separ" in frame_layout.lower() or "interlace" in frame_layout.lower()

        descriptors.append({
            "id": desc_id,
            "w": width,
            "h": height,
            "tc": transfer,
            "cp": primaries,
            "depth": depth,
            "isIAB": is_iab,
            "channelCount": channel_count,
            "isRGBA": is_rgba,
            "isCDCI": is_cdci,
            "isJ2K": is_j2k,
            "isHTJ2K": is_htj2k,
            "isDVision": is_dvision,
            "isPicture": is_picture,
            "dvProfile": dv_profile,
            "dvLevel": dv_level,
            "dvTrimPasses": dv_trim_passes,
            "frameLayout": "Interlaced" if is_interlaced else "Progressive",
            "pecUL": pec_ul,
        })

    segments: list[dict[str, Any]] = []
    total_frames = 0
    for seg in _find_all(root, "Segment"):
        resources: list[dict[str, Any]] = []
        sequences: list[dict[str, Any]] = []
        seq_container = _find_first(seg, "SequenceList") or seg
        for seq in list(seq_container):
            seq_type = _lname(seq.tag)
            if not seq_type or seq_type in {"Id", "TrackId"}:
                continue

            seq_id = _child_text(seq, "Id")
            track_id = _child_text(seq, "TrackId")
            seq_resources: list[dict[str, Any]] = []
            res_list = _find_first(seq, "ResourceList") or seq
            for res in list(res_list):
                if _lname(res.tag) not in {"Resource", "TrackFileResource"}:
                    continue
                res_er = _text(res, "EditRate") or er_text
                res_rate = _parse_rate(res_er, edit_rate)
                intrinsic = int(_text(res, "IntrinsicDuration") or "0")
                entry = int(_text(res, "EntryPoint") or "0")
                src_dur = int(_text(res, "SourceDuration") or str(intrinsic or 0))
                repeat = max(1, int(_text(res, "RepeatCount") or "1"))
                file_id = _clean_uuid(_text(res, "TrackFileId"))
                ess_desc_id = _clean_uuid(_text(res, "EssenceDescriptorId") or _text(res, "SourceEncoding"))

                parsed_res = {
                    "seqType": seq_type,
                    "seqId": _clean_uuid(seq_id),
                    "trackId": track_id,
                    "editRate": res_rate,
                    "intrinsicDuration": intrinsic,
                    "entryPoint": entry,
                    "sourceDuration": src_dur or intrinsic,
                    "repeatCount": repeat,
                    "trackFileId": file_id,
                    "essenceDescriptorId": ess_desc_id,
                }
                resources.append(parsed_res)
                seq_resources.append(parsed_res)
                if seq_type == "MainImageSequence" or "Image" in seq_type:
                    total_frames += (src_dur or intrinsic) * repeat

            if seq_resources:
                sequences.append({
                    "seqType": seq_type,
                    "seqId": _clean_uuid(seq_id),
                    "trackId": track_id,
                    "resources": seq_resources,
                })
        if resources:
            segments.append({
                "resources": resources,
                "sequences": sequences,
            })

    # Build descriptor lookup for channel count annotation.
    # Guard against empty-string keys: a descriptor with no Id element gets id="" from
    # _clean_uuid. Including "" in the lookup allows resources with no EssenceDescriptorId
    # (also "" after _clean_uuid) to accidentally match, corrupting channel-count and IAB
    # classification.
    desc_by_id: dict[str, dict[str, Any]] = {d["id"]: d for d in descriptors if d.get("id")}

    pic_desc = next((desc for desc in descriptors if desc.get("isPicture")), descriptors[0] if descriptors else {})
    iab_desc = next((desc for desc in descriptors if desc.get("isIAB")), None)
    # Only include non-empty IDs. If "" were included, any resource without an
    # EssenceDescriptorId would be falsely classified as IAB, turning PCM tracks into
    # isIAB=True entries in audioTracks and silently dropping the PCM audio from the proxy.
    iab_descriptor_ids = {desc["id"] for desc in descriptors if desc.get("isIAB") and desc.get("id")}
    if pic_desc.get("isHTJ2K"):
        codec = "HTJ2K (JPEG 2000 Part 15)"
    elif pic_desc.get("isJ2K"):
        codec = "JPEG 2000"
    elif pic_desc.get("isRGBA"):
        codec = "RGBA (Uncompressed)"
    elif pic_desc.get("isCDCI"):
        codec = "CDCI"
    elif _detect_prores(root):
        codec = "ProRes"
    else:
        codec = "–"

    all_ns = " ".join(attr for attr in root.attrib.values()).lower()
    app_id = _text(root, "ApplicationIdentification").lower()
    combined = f"{all_ns} {app_id}"
    if "2067-21" in combined or "app#2e" in combined or "2e " in combined:
        app_version = "App#2E (Netflix HDR)"
    elif "2067-20" in combined or "app#2" in combined:
        app_version = "App#2"
    elif "2067" in combined:
        app_version = "SMPTE ST 2067"
    else:
        app_version = "–"

    dv_desc_ids = [desc["id"] for desc in descriptors if desc.get("isDVision")]
    video_resources = [
        resource
        for segment in segments
        for resource in segment["resources"]
        if resource["seqType"] == "MainImageSequence" or "Image" in resource["seqType"]
    ]
    audio_resources = [
        resource
        for segment in segments
        for resource in segment["resources"]
        if resource["seqType"] != "MainImageSequence" and "Image" not in resource["seqType"]
    ]
    def _is_iab_resource(resource: dict[str, Any]) -> bool:
        _eid = str(resource.get("essenceDescriptorId") or "")
        return (
            "iab" in str(resource.get("seqType") or "").lower()
            # Guard: only do descriptor-set lookup when the resource actually has an ID;
            # an empty _eid must never match a stray "" in iab_descriptor_ids.
            or bool(_eid and _eid in iab_descriptor_ids)
        )
    iab_resources = [resource for resource in audio_resources if _is_iab_resource(resource)]
    pcm_audio_resources = [
        {**resource, "channelCount": desc_by_id.get(str(resource.get("essenceDescriptorId") or ""), {}).get("channelCount", 0)}
        for resource in audio_resources
        if not _is_iab_resource(resource)
    ]

    # Build audioTracks summary list (unique by trackFileId)
    seen_track_ids: set[str] = set()
    audio_tracks: list[dict[str, Any]] = []
    for resource in pcm_audio_resources:
        tid = str(resource.get("trackFileId") or "")
        if tid in seen_track_ids:
            continue
        seen_track_ids.add(tid)
        audio_tracks.append({
            "trackFileId": tid,
            "channelCount": resource.get("channelCount", 0),
            "isIAB": False,
            "seqType": resource.get("seqType", ""),
        })
    for resource in iab_resources:
        tid = str(resource.get("trackFileId") or "")
        if tid in seen_track_ids:
            continue
        seen_track_ids.add(tid)
        audio_tracks.append({
            "trackFileId": tid,
            "channelCount": 0,
            "isIAB": True,
            "seqType": resource.get("seqType", ""),
        })

    # Build human-readable audioLayout summary
    has_51 = any(t["channelCount"] == 6 for t in audio_tracks if not t["isIAB"])
    has_20 = any(t["channelCount"] == 2 for t in audio_tracks if not t["isIAB"])
    has_iab_track = any(t["isIAB"] for t in audio_tracks)
    if has_iab_track and has_51 and has_20:
        audio_layout = "IAB+5.1+2.0"
    elif has_iab_track and has_51:
        audio_layout = "IAB+5.1"
    elif has_iab_track and has_20:
        audio_layout = "IAB+2.0"
    elif has_iab_track:
        audio_layout = "IAB"
    elif has_51 and has_20:
        audio_layout = "5.1+2.0"
    elif has_51:
        audio_layout = "5.1"
    elif has_20:
        audio_layout = "2.0"
    elif audio_tracks:
        cc = audio_tracks[0].get("channelCount", 0)
        audio_layout = f"{cc}ch" if cc else "PCM"
    else:
        audio_layout = "none"
    video_sequences = [
        sequence
        for segment in segments
        for sequence in segment.get("sequences", [])
        if sequence["seqType"] == "MainImageSequence" or "Image" in sequence["seqType"]
    ]
    audio_sequences = [
        sequence
        for segment in segments
        for sequence in segment.get("sequences", [])
        if sequence["seqType"] != "MainImageSequence" and "Image" not in sequence["seqType"]
    ]
    iab_sequences = [
        sequence
        for sequence in audio_sequences
        if "iab" in str(sequence.get("seqType") or "").lower()
        or any(_is_iab_resource(resource) for resource in (sequence.get("resources") or []))
    ]
    pcm_audio_sequences = [sequence for sequence in audio_sequences if sequence not in iab_sequences]

    return {
        "id": _clean_uuid(_text(root, "Id")),
        "annotation": _text(root, "AnnotationText") or _text(root, "Annotation"),
        "contentTitle": _text(root, "ContentTitle"),
        "contentKind": _text(root, "ContentKind"),
        "issueDate": _text(root, "IssueDate"),
        "issuer": _text(root, "Issuer"),
        "creator": _text(root, "Creator"),
        "editRate": edit_rate,
        "totalFrames": total_frames,
        "durationSec": total_frames / (edit_rate or 24.0),
        "resolution": {"w": pic_desc.get("w", "–"), "h": pic_desc.get("h", "–")},
        "transfer": pic_desc.get("tc", "–"),
        "primaries": pic_desc.get("cp", "–"),
        "bitDepth": pic_desc.get("depth", "–"),
        "codec": codec,
        "appVersion": app_version,
        "isDolbyVision": any(desc.get("isDVision") for desc in descriptors),
        "hasIAB": bool(iab_desc) or any(desc.get("isIAB") for desc in descriptors),
        "dvProfile": next((desc.get("dvProfile") for desc in descriptors if desc.get("isDVision") and desc.get("dvProfile")), ""),
        "dvLevel": next((desc.get("dvLevel") for desc in descriptors if desc.get("isDVision") and desc.get("dvLevel")), ""),
        "dvTrimPasses": sum(int(desc.get("dvTrimPasses") or 0) for desc in descriptors),
        "descriptors": descriptors,
        "segments": segments,
        "videoResources": video_resources,
        "audioResources": audio_resources,
        "iabResources": iab_resources,
        "pcmAudioResources": pcm_audio_resources,
        "videoSequences": video_sequences,
        "audioSequences": audio_sequences,
        "iabSequences": iab_sequences,
        "pcmAudioSequences": pcm_audio_sequences,
        "dvDescriptorIds": dv_desc_ids,
        "audioTracks": audio_tracks,
        "audioLayout": audio_layout,
    }


def _resolve_asset_path(package_root: Path, asset: dict[str, Any]) -> Path | None:
    """Resolve an asset to an absolute Path, or return None.

    Primary: resolve assetMapPath / file relative to package_root.
    Fallback: search sibling UUID-folders in the same IMF root — common for
    VF/supplemental packages that reference OV media (video reels, audio MXFs)
    stored in a sibling directory.
    """
    for raw in [asset.get("assetMapPath"), asset.get("file")]:
        if not raw:
            continue
        candidate = _norm_join(package_root, str(raw))
        if candidate.is_file():
            return candidate

    # Sibling-folder fallback: try the bare filename in adjacent UUID-folders.
    basename = Path(str(asset.get("file") or asset.get("assetMapPath") or "")).name
    if basename:
        try:
            for sib in package_root.parent.iterdir():
                if sib.is_dir() and sib != package_root:
                    candidate = sib / basename
                    if candidate.is_file():
                        return candidate
        except Exception:
            pass

    return None


def _discover_packages(folder: Path) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    assetmap_files = sorted(
        path for path in folder.rglob("*")
        if path.is_file() and path.name.lower() in {"assetmap", "assetmap.xml"}
    )
    if not assetmap_files:
        raise ValueError("No IMF ASSETMAP.xml found in selected folder")

    packages: list[dict[str, Any]] = []
    cpl_summaries: list[dict[str, Any]] = []

    for assetmap_path in assetmap_files:
        package_root = assetmap_path.parent.resolve()
        root_rel = "" if package_root == folder else _to_rel(package_root, folder)
        asset_map = _parse_asset_map(assetmap_path)
        pkl_asset = next((asset for asset in (asset_map.get("assets") or {}).values() if asset.get("isPKL")), None)
        pkl_path = None
        if pkl_asset and pkl_asset.get("path"):
            candidate = _norm_join(package_root, pkl_asset["path"])
            if candidate.is_file():
                pkl_path = candidate
        if pkl_path is None:
            for candidate in sorted(package_root.glob("*.xml")):
                low = candidate.name.lower()
                if "pkl" in low or "packing" in low:
                    pkl_path = candidate.resolve()
                    break
        if pkl_path is None:
            continue

        pkl = _parse_pkl(pkl_path, asset_map)
        resolved_asset_ids: list[str] = []
        cpl_entries: list[dict[str, Any]] = []

        for asset_id, asset in (pkl.get("assets") or {}).items():
            resolved = _resolve_asset_path(package_root, asset)
            if resolved is not None:
                resolved_asset_ids.append(asset_id)
                asset["absolutePath"] = str(resolved)

        package_name = (package_root.name or pkl.get("annotation") or asset_map.get("annotation") or "Package").strip()
        resolved_set = set(resolved_asset_ids)

        for asset in (pkl.get("assets") or {}).values():
            if not _candidate_xml_asset(asset):
                continue
            cpl_path = _resolve_asset_path(package_root, asset)
            if cpl_path is None or not cpl_path.is_file():
                continue
            try:
                head = cpl_path.read_text(encoding="utf-8", errors="ignore")[:65536]
            except Exception:
                continue
            if "CompositionPlaylist" not in head:
                continue

            cpl = _parse_cpl(cpl_path)
            missing_video_refs = sum(1 for res in cpl["videoResources"] if res.get("trackFileId") and res["trackFileId"] not in pkl["assets"])
            missing_audio_refs = sum(1 for res in cpl["audioResources"] if res.get("trackFileId") and res["trackFileId"] not in pkl["assets"])
            playable_reels = sum(1 for res in cpl["videoResources"] if res.get("trackFileId") in resolved_set)
            short_label = (cpl.get("contentTitle") or cpl.get("annotation") or cpl.get("id") or cpl_path.stem).strip()
            content_kind = str(cpl.get("contentKind") or "").lower()
            is_supplemental = (
                (missing_video_refs + missing_audio_refs) > 0
                or "supp" in content_kind
                or "supplemental" in content_kind
                or "supplemental" in package_name.lower()
                or "supplemental" in cpl_path.as_posix().lower()
            )

            entry = {
                "key": f"{root_rel or '.'}::{cpl['id'] or cpl_path.stem}",
                "root": root_rel,
                "packageName": package_name,
                "cpl": cpl,
                "isSupplemental": is_supplemental,
                "missingVideoRefs": missing_video_refs,
                "missingAudioRefs": missing_audio_refs,
                "playableReels": playable_reels,
                "shortLabel": short_label,
            }
            cpl_entries.append(entry)
            cpl_summaries.append({
                "cplId": cpl["id"] or cpl_path.stem,
                "label": short_label,
                "relativePath": _to_rel(cpl_path, folder),
                "isSupplemental": is_supplemental,
                "playable": playable_reels > 0,
                "playableReels": playable_reels,
                "videoReelCount": len(cpl["videoResources"]),
                "missingVideoRefs": missing_video_refs,
                "missingAudioRefs": missing_audio_refs,
                "audioKind": "IAB" if cpl.get("hasIAB") else ("PCM" if cpl.get("audioResources") else "None"),
                "editRate": cpl.get("editRate", 24.0),
                "durationFrames": cpl.get("totalFrames", 0),
                "contentTitle": cpl.get("contentTitle") or short_label,
                "hasDolbyVision": bool(cpl.get("isDolbyVision")),
                "hasIAB": bool(cpl.get("hasIAB")),
                "hasProRes": "ProRes" in str(cpl.get("codec") or ""),
            })

        if cpl_entries:
            packages.append({
                "root": root_rel,
                "packageName": package_name,
                "assetMap": asset_map,
                "pkl": pkl,
                "cpls": cpl_entries,
                "resolvedAssetIds": resolved_asset_ids,
            })

    if not packages:
        raise ValueError("No CompositionPlaylist XML found in selected folder")

    cpl_summaries.sort(key=lambda item: (0 if item["playable"] else 1, 0 if not item["isSupplemental"] else 1, item["relativePath"].lower()))
    return packages, cpl_summaries


@dataclass
class CplScanResult:
    cpl_id: str
    label: str
    relative_path: str
    is_supplemental: bool
    playable: bool
    playable_reels: int
    video_reel_count: int
    missing_video_refs: int
    missing_audio_refs: int
    audio_kind: str
    edit_rate: float
    duration_frames: int
    content_title: str
    has_dolby_vision: bool
    has_iab: bool
    has_prores: bool

    def to_dict(self) -> dict[str, Any]:
        return {
            "cplId": self.cpl_id,
            "label": self.label,
            "relativePath": self.relative_path,
            "isSupplemental": self.is_supplemental,
            "playable": self.playable,
            "playableReels": self.playable_reels,
            "videoReelCount": self.video_reel_count,
            "missingVideoRefs": self.missing_video_refs,
            "missingAudioRefs": self.missing_audio_refs,
            "audioKind": self.audio_kind,
            "editRate": self.edit_rate,
            "durationFrames": self.duration_frames,
            "contentTitle": self.content_title,
            "hasDolbyVision": self.has_dolby_vision,
            "hasIAB": self.has_iab,
            "hasProRes": self.has_prores,
        }


def scan_imf_package(folder_path: str) -> dict[str, Any]:
    folder = Path(folder_path).expanduser().resolve()
    if not folder.is_dir():
        raise FileNotFoundError(f"IMF folder not found: {folder}")

    packages, cpl_summary_rows = _discover_packages(folder)
    cpls = [CplScanResult(
        cpl_id=item["cplId"],
        label=item["label"],
        relative_path=item["relativePath"],
        is_supplemental=item["isSupplemental"],
        playable=item["playable"],
        playable_reels=item["playableReels"],
        video_reel_count=item["videoReelCount"],
        missing_video_refs=item["missingVideoRefs"],
        missing_audio_refs=item["missingAudioRefs"],
        audio_kind=item["audioKind"],
        edit_rate=item["editRate"],
        duration_frames=item["durationFrames"],
        content_title=item["contentTitle"],
        has_dolby_vision=item["hasDolbyVision"],
        has_iab=item["hasIAB"],
        has_prores=item["hasProRes"],
    ) for item in cpl_summary_rows]

    has_dolby_vision = any(cpl.has_dolby_vision for cpl in cpls)
    has_iab = any(cpl.has_iab for cpl in cpls)
    has_prores = any(cpl.has_prores for cpl in cpls)
    playable_cpls = [cpl for cpl in cpls if cpl.playable]

    package_id = "pkg_" + sha1(str(folder).encode("utf-8")).hexdigest()[:16]
    preferred_engine = "advanced-imf" if (has_iab or has_prores) else "internal-fastpath"
    flat_entries = [entry for pkg in packages for entry in pkg.get("cpls", [])]
    default_base = next((entry for entry in flat_entries if not entry.get("isSupplemental")), flat_entries[0])
    default_current = next((entry for entry in flat_entries if entry.get("isSupplemental")), default_base)

    return {
        "packageId": package_id,
        "folderPath": str(folder),
        "packageName": folder.name,
        "summary": {
            "packageCount": len(packages),
            "cplCount": len(cpls),
            "playableCplCount": len(playable_cpls),
            "hasDolbyVision": has_dolby_vision,
            "hasIAB": has_iab,
            "hasProRes": has_prores,
        },
        "cpls": [cpl.to_dict() for cpl in cpls],
        "assets": {
            "assetMapCount": len(packages),
            "resolvedAssetCount": sum(len(pkg.get("resolvedAssetIds", [])) for pkg in packages),
            "missingVideoRefs": sum(cpl.missing_video_refs for cpl in cpls),
            "missingAudioRefs": sum(cpl.missing_audio_refs for cpl in cpls),
        },
        "engineHints": {
            "preferredPlaybackEngine": preferred_engine,
            "preferredProxyEngine": "internal-fastpath",
            "requiresAdvancedAudio": has_iab,
        },
        "snapshot": {
            "packages": packages,
            "currentCplKey": default_current["key"],
            "baseCplKey": default_base["key"],
            "showBaseOverlay": False,
            "activeLeftTab": "validation",
            "source": {
                "folderName": folder.name,
                "folderPath": str(folder),
                "backend": "companion",
            },
        },
    }
