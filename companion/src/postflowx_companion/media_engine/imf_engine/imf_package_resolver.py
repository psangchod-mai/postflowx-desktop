from __future__ import annotations

import re
import xml.etree.ElementTree as ET
from pathlib import Path


_UUID_BARE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE
)
_UUID_URN = re.compile(
    r"^urn:uuid:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$", re.IGNORECASE
)
_UUID_BRACED = re.compile(
    r"^\{([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}$", re.IGNORECASE
)


def normalize_uuid(raw: str) -> str:
    raw = (raw or "").strip()
    m = _UUID_URN.match(raw)
    if m:
        return m.group(1).lower()
    m = _UUID_BRACED.match(raw)
    if m:
        return m.group(1).lower()
    if _UUID_BARE.match(raw):
        return raw.lower()
    return raw.lower()


def _ns_strip(tag: str) -> str:
    return tag.split("}")[-1] if "}" in tag else tag


def _parse_assetmap(xml_path: str) -> dict[str, str]:
    """Return {uuid → absolute_file_path} from a single ASSETMAP.xml."""
    p = Path(xml_path)
    folder = p.parent
    assets: dict[str, str] = {}
    try:
        tree = ET.parse(xml_path)
        root = tree.getroot()
    except Exception:
        return assets

    for asset_el in root.iter():
        if _ns_strip(asset_el.tag) != "Asset":
            continue
        uuid_el = None
        chunks_el = None
        for child in asset_el:
            tag = _ns_strip(child.tag)
            if tag == "Id":
                uuid_el = child
            elif tag == "ChunkList":
                chunks_el = child
        if uuid_el is None or chunks_el is None:
            continue
        raw_id = (uuid_el.text or "").strip()
        uid = normalize_uuid(raw_id)
        if not uid:
            continue
        for chunk in chunks_el:
            if _ns_strip(chunk.tag) != "Chunk":
                continue
            path_el = next(
                (c for c in chunk if _ns_strip(c.tag) == "Path"), None
            )
            if path_el is None:
                continue
            rel_path = (path_el.text or "").strip()
            abs_path = str((folder / rel_path).resolve())
            if Path(abs_path).is_file():
                assets[uid] = abs_path
    return assets


def build_global_asset_map(folders: list[str]) -> dict[str, str]:
    """
    Scan each folder for ASSETMAP.xml (or ASSETMAP), parse all, merge.
    Returns {normalized_uuid → absolute_file_path}.
    """
    global_map: dict[str, str] = {}
    for folder_str in folders:
        folder = Path(folder_str)
        for name in ("ASSETMAP.xml", "ASSETMAP"):
            am = folder / name
            if am.is_file():
                global_map.update(_parse_assetmap(str(am)))
                break
    return global_map


def find_assetmaps_in_folder(root: str) -> list[str]:
    """Find all ASSETMAP.xml files inside root and its first-level sub-folders."""
    result: list[str] = []
    root_p = Path(root)
    for name in ("ASSETMAP.xml", "ASSETMAP"):
        am = root_p / name
        if am.is_file():
            result.append(str(am))
            break
    for sub in root_p.iterdir():
        if not sub.is_dir():
            continue
        for name in ("ASSETMAP.xml", "ASSETMAP"):
            am = sub / name
            if am.is_file():
                result.append(str(am))
                break
    return result


def find_cpls(root: str, asset_map: dict[str, str] | None = None) -> list[str]:
    """Find all CPL XML files, cross-referencing the global asset map if given."""
    root_p = Path(root)
    cpls: list[str] = []
    for xml_file in root_p.rglob("*.xml"):
        try:
            tree = ET.parse(str(xml_file))
            r = tree.getroot()
            if "CompositionPlaylist" in _ns_strip(r.tag):
                cpls.append(str(xml_file))
        except Exception:
            continue
    # Also resolve from asset map (in case CPL is registered by UUID)
    if asset_map:
        for path in asset_map.values():
            if path not in cpls and path.lower().endswith(".xml"):
                try:
                    tree = ET.parse(path)
                    r = tree.getroot()
                    if "CompositionPlaylist" in _ns_strip(r.tag):
                        cpls.append(path)
                except Exception:
                    pass
    return list(dict.fromkeys(cpls))  # deduplicate, preserve order


def resolve_cpl_mxf_paths(
    cpl_path: str,
    global_asset_map: dict[str, str],
) -> list[dict]:
    """
    Parse CPL and return list of {trackFileId, mxfPath, resolved} per resource.
    """
    resources: list[dict] = []
    try:
        tree = ET.parse(cpl_path)
        root = tree.getroot()
    except Exception:
        return resources

    for el in root.iter():
        tag = _ns_strip(el.tag)
        if tag in ("TrackFileResourceType", "MainImageSequence",
                   "MainAudioSequence", "TrackFileId"):
            pass
        if tag == "TrackFileId":
            raw_id = (el.text or "").strip()
            uid = normalize_uuid(raw_id)
            mxf_path = global_asset_map.get(uid, "")
            resources.append({
                "trackFileId": uid,
                "rawId": raw_id,
                "mxfPath": mxf_path,
                "resolved": bool(mxf_path),
            })
    return resources


def open_package(folder_path: str) -> dict:
    """
    Full package open: find all ASSETMAP.xml, PKL.xml, CPL.xml files.
    Returns structured package info.
    """
    assetmaps = find_assetmaps_in_folder(folder_path)
    folders = [str(Path(am).parent) for am in assetmaps]
    global_map = build_global_asset_map(folders)

    cpls = find_cpls(folder_path, global_map)
    pkls: list[str] = []
    root_p = Path(folder_path)
    for xml_file in root_p.rglob("*.xml"):
        try:
            tree = ET.parse(str(xml_file))
            r = tree.getroot()
            if "PackingList" in _ns_strip(r.tag):
                pkls.append(str(xml_file))
        except Exception:
            pass

    unresolved_count = 0
    playable_reels = 0
    for cpl in cpls:
        refs = resolve_cpl_mxf_paths(cpl, global_map)
        resolved = [r for r in refs if r["resolved"]]
        unresolved = len(refs) - len(resolved)
        unresolved_count += unresolved
        if resolved:
            playable_reels += 1

    warnings: list[str] = []
    errors: list[str] = []
    if not assetmaps:
        errors.append("No ASSETMAP.xml found in package folder")
    if not cpls:
        errors.append("No CPL.xml found in package folder")
    if unresolved_count > 0:
        warnings.append(f"{unresolved_count} asset reference(s) could not be resolved to MXF files")

    return {
        "ok": len(errors) == 0,
        "folder": folder_path,
        "assetMaps": assetmaps,
        "pklList": pkls,
        "cplList": cpls,
        "globalAssetMapSize": len(global_map),
        "packageType": _infer_package_type(assetmaps),
        "playableReels": playable_reels,
        "warnings": warnings,
        "errors": errors,
    }


def _infer_package_type(assetmaps: list[str]) -> str:
    if len(assetmaps) == 0:
        return "unknown"
    if len(assetmaps) == 1:
        return "base"
    return "mixed"
