from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path
from typing import Any

# ── Extension tables ──────────────────────────────────────────────────────────

_ARRI_EXTS    = {".ari", ".arx", ".arri", ".arriraw"}
_RED_EXTS     = {".r3d"}
_BRAW_EXTS    = {".braw"}
_SONY_EXTS    = {".mxf"}          # disambiguated by folder structure / metadata
_CANON_EXTS   = {".crm", ".rmf"}
_MXF_EXTS     = {".mxf"}
_MOV_EXTS     = {".mov"}
_IMAGE_EXTS   = {".exr", ".dpx", ".tif", ".tiff", ".png", ".tga"}
_SIDECAR_EXTS = {".rmd", ".xml", ".csv", ".sidecar", ".cdl", ".cube",
                 ".ale", ".edl", ".bmd", ".aml"}
_AUDIO_EXTS   = {".wav", ".bwav", ".aiff", ".aif", ".mxf"}

_ALL_MEDIA = _ARRI_EXTS | _RED_EXTS | _BRAW_EXTS | _CANON_EXTS | _MXF_EXTS | _MOV_EXTS | _IMAGE_EXTS

# ── Camera card folder signatures ─────────────────────────────────────────────

_CARD_MARKERS = {
    "ARRI":        ["ARRIRAW", "ARRI", "A_META", "ARRI_ALEXA"],
    "RED":         ["RED", "REDCODE", "A001"],  # RED: A001/ B001/ etc. + .R3D
    "Blackmagic":  ["BRAW", "Blackmagic"],
    "Sony":        ["XDROOT", "CLIP", "GENERAL", "CAMERAINFO.XML"],
    "Canon":       ["DCIM", "MISC", "CRM"],
}

_SONY_CARD_FILES = {"camerainfo.xml", "mediapro.xml", "discinfo.xml"}
_XDCAM_ROOTS    = {"xdroot", "private"}


def _clip_id(path: str) -> str:
    stem = os.path.splitext(os.path.basename(path))[0]
    return re.sub(r"[^A-Za-z0-9_\-]", "_", stem)


def _camera_family_from_ext(ext: str) -> str:
    if ext in _ARRI_EXTS:   return "ARRI"
    if ext in _RED_EXTS:    return "RED"
    if ext in _BRAW_EXTS:   return "Blackmagic"
    if ext in _CANON_EXTS:  return "Canon"
    if ext in _IMAGE_EXTS:  return "Generic"
    return ""


def _detect_card_family(root: Path) -> str:
    names_lower = {p.name.lower() for p in root.iterdir() if root.is_dir()} if root.is_dir() else set()
    for family, markers in _CARD_MARKERS.items():
        for m in markers:
            if m.lower() in names_lower:
                return family
    if any(n in names_lower for n in _SONY_CARD_FILES) or any(n in names_lower for n in _XDCAM_ROOTS):
        return "Sony"
    return ""


def _format_from_ext_and_family(ext: str, family: str) -> str:
    mapping = {
        ".ari": "ARRIRAW", ".arx": "ARRIRAW", ".arriraw": "ARRIRAW",
        ".r3d": "R3D",
        ".braw": "BRAW",
        ".crm": "CinemaRAW", ".rmf": "CinemaRAW",
        ".exr": "EXR_Sequence", ".dpx": "DPX_Sequence",
        ".tif": "TIFF_Sequence", ".tiff": "TIFF_Sequence",
        ".png": "PNG_Sequence",
    }
    if ext in mapping:
        return mapping[ext]
    if ext == ".mxf":
        return "Sony_XOCN_MXF" if family == "Sony" else "MXF"
    if ext == ".mov":
        return "ProRes_MOV" if family in ("ARRI", "Generic", "") else f"{family}_MOV"
    return ext.lstrip(".").upper()


def _find_sidecars(media_path: Path, all_files: set[str]) -> list[str]:
    stem = media_path.stem.lower()
    parent = str(media_path.parent)
    return [
        f for f in all_files
        if os.path.dirname(f) == parent
        and os.path.splitext(os.path.basename(f))[0].lower() == stem
        and os.path.splitext(f)[1].lower() in _SIDECAR_EXTS
    ]


def _detect_image_sequence(folder: Path) -> list[dict]:
    """Detect image sequence groups within a folder."""
    seq_map: dict[str, list[Path]] = {}
    for f in folder.iterdir():
        if not f.is_file():
            continue
        ext = f.suffix.lower()
        if ext not in _IMAGE_EXTS:
            continue
        stem = f.stem
        m = re.match(r"^(.+?)[\._\-]?(\d{4,8})$", stem)
        if m:
            base_key = m.group(1)
        else:
            base_key = re.sub(r"\d+$", "", stem) or stem
        key = f"{base_key}{ext}"
        seq_map.setdefault(key, []).append(f)
    clips = []
    for key, files in seq_map.items():
        if len(files) < 2:
            continue
        files.sort()
        representative = str(files[0])
        stem_base = os.path.splitext(key)[0]
        ext = Path(key).suffix
        clips.append({
            "clipId":       _clip_id(representative) + "_seq",
            "path":         representative,
            "sequenceRoot": str(folder),
            "frameCount":   len(files),
            "cameraFamily": "Generic",
            "format":       _format_from_ext_and_family(ext, "Generic"),
            "kind":         "image_sequence",
            "sidecars":     [],
            "audioFiles":   [],
            "metadataFiles": [],
            "confidence":   90,
        })
    return clips


def scan_ocf(path: str) -> dict[str, Any]:
    """
    Scan a file, folder, or camera card root for OCF clips.

    Returns:
      { ok, root, clips, warnings, errors }
    Each clip: { clipId, path, cameraFamily, format, kind, sidecars,
                 audioFiles, metadataFiles, confidence }
    """
    root_path = Path(path)
    clips: list[dict] = []
    warnings: list[str] = []
    errors: list[str] = []

    # ── Single file ───────────────────────────────────────────────────────────
    if root_path.is_file():
        ext = root_path.suffix.lower()
        family = _camera_family_from_ext(ext)
        fmt    = _format_from_ext_and_family(ext, family)
        clip = {
            "clipId":        _clip_id(str(root_path)),
            "path":          str(root_path),
            "cameraFamily":  family or "Generic",
            "format":        fmt,
            "kind":          "single_file",
            "sidecars":      [],
            "audioFiles":    [],
            "metadataFiles": [],
            "confidence":    80,
        }
        clips.append(clip)
        return {"ok": True, "root": str(root_path), "clips": clips,
                "warnings": warnings, "errors": errors}

    if not root_path.is_dir():
        return {"ok": False, "root": path, "clips": [],
                "warnings": [], "errors": [f"Path not found: {path}"]}

    # ── Camera card detection ─────────────────────────────────────────────────
    card_family = _detect_card_family(root_path)

    # ── Collect all files for sidecar lookup ──────────────────────────────────
    all_file_paths: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(str(root_path)):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for fname in filenames:
            if not fname.startswith("."):
                all_file_paths.add(os.path.join(dirpath, fname))

    # ── Walk for media files ──────────────────────────────────────────────────
    image_seq_dirs: set[str] = set()

    for file_str in sorted(all_file_paths):
        fpath = Path(file_str)
        ext   = fpath.suffix.lower()

        if ext not in _ALL_MEDIA:
            continue

        # Image sequences: group by parent dir, process once
        if ext in _IMAGE_EXTS:
            parent_str = str(fpath.parent)
            if parent_str not in image_seq_dirs:
                image_seq_dirs.add(parent_str)
                seq_clips = _detect_image_sequence(fpath.parent)
                clips.extend(seq_clips)
            continue

        # Determine camera family
        family = _camera_family_from_ext(ext)
        if not family:
            if ext == ".mxf":
                family = card_family if card_family in ("Sony", "ARRI") else "Generic"
            elif ext == ".mov":
                family = card_family or "Generic"
            else:
                family = card_family or "Generic"

        fmt       = _format_from_ext_and_family(ext, family)
        sidecars  = _find_sidecars(fpath, all_file_paths)
        audio     = [
            f for f in all_file_paths
            if (os.path.dirname(f) == str(fpath.parent)
                and os.path.splitext(os.path.basename(f))[0].lower() == fpath.stem.lower()
                and os.path.splitext(f)[1].lower() in _AUDIO_EXTS
                and f != file_str)
        ]

        clips.append({
            "clipId":        _clip_id(file_str),
            "path":          file_str,
            "cameraFamily":  family,
            "format":        fmt,
            "kind":          "ocf_file",
            "sidecars":      sidecars,
            "audioFiles":    audio,
            "metadataFiles": [s for s in sidecars if Path(s).suffix.lower() in {".xml", ".ale"}],
            "confidence":    95 if family != "Generic" else 70,
        })

    if not clips:
        warnings.append("No OCF files found in the selected path.")

    return {
        "ok":       True,
        "root":     str(root_path),
        "clips":    clips,
        "warnings": warnings,
        "errors":   errors,
    }
