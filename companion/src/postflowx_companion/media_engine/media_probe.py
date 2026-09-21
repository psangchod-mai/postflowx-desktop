from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from .engine_status import find_ffmpeg, find_ffprobe
from .logs import write as _log

# ── Constants ─────────────────────────────────────────────────────────────────

OCF_EXTENSIONS = {
    ".r3d", ".ari", ".arx", ".arri",           # RED, ARRI
    ".braw",                                    # BRAW
    ".crm", ".cr2", ".cr3",                    # Canon
    ".nef", ".nrw",                             # Nikon
    ".orf",                                     # Olympus
    ".arw", ".srf", ".sr2",                    # Sony
    ".dng",                                     # DNG (generic RAW)
    ".cine", ".cin",                            # Phantom/Cine
    ".mxf",                                     # MXF *can* be OCF
}

BROWSER_SAFE_CONTAINERS = {"mp4", "webm", "ogg", "m4v"}
BROWSER_SAFE_CODECS = {"h264", "avc1", "vp8", "vp9", "av1", "hevc", "hvc1"}

IMAGE_SEQUENCE_EXTENSIONS = {".exr", ".dpx", ".tif", ".tiff", ".png", ".jpg", ".jpeg", ".tga"}

PRORES_TAGS = {"apcn", "apco", "apcs", "apch", "ap4h", "ap4x", "apns", "ap4c"}

CONTAINER_MAP = {
    "mov,mp4,m4a,3gp,3g2,mj2": "mov",
    "matroska,webm": "mkv",
    "mxf": "mxf",
    "image2": "image_sequence",
}


def _norm_container(fmt_name: str) -> str:
    for key, val in CONTAINER_MAP.items():
        if fmt_name in key.split(","):
            return val
    return fmt_name.split(",")[0]


def _fps_info(fps_str: str) -> dict:
    if not fps_str or fps_str == "0/0":
        return {"num": 0, "den": 1, "display": ""}
    if "/" in fps_str:
        parts = fps_str.split("/")
        try:
            n, d = int(parts[0]), int(parts[1])
            if d == 0:
                return {"num": 0, "den": 1, "display": ""}
            val = n / d
            display = f"{val:.3f}".rstrip("0").rstrip(".")
            return {"num": n, "den": d, "display": display}
        except (ValueError, ZeroDivisionError):
            return {"num": 0, "den": 1, "display": ""}
    try:
        val = float(fps_str)
        return {"num": int(val * 1000), "den": 1000, "display": str(val)}
    except ValueError:
        return {"num": 0, "den": 1, "display": ""}


def _find_timecode(fmt: dict, streams: list[dict]) -> dict:
    tc = ""
    source = "none"
    # 1. format tags
    for key in ("timecode", "com.apple.quicktime.creationdate",
                "time_code", "TIMECODE", "start_timecode"):
        v = (fmt.get("tags") or {}).get(key, "")
        if v and re.match(r"\d{2}:\d{2}:\d{2}[:;]\d{2}", v):
            tc = v
            source = "metadata"
            break
    # 2. streams
    if not tc:
        for s in streams:
            v = (s.get("tags") or {}).get("timecode", "")
            if v and re.match(r"\d{2}:\d{2}:\d{2}[:;]\d{2}", v):
                tc = v
                source = "tmcd" if s.get("codec_type") == "data" else "metadata"
                break
    drop = ";" in tc
    # Normalize drop-frame separator
    if drop:
        tc = tc.replace(";", ":")
    return {"start": tc, "source": source, "dropFrame": drop, "timecodeBase": 0}


def _classify_codec(codec_name: str, codec_tag: str) -> tuple[str, str, bool, bool]:
    tag = codec_tag.lower().strip("[ ]")
    name = codec_name.lower()
    is_prores = tag in PRORES_TAGS or name == "prores"
    is_raw = False
    profile = ""
    profiles = {
        "apco": "ProRes 422 Proxy",
        "apcs": "ProRes 422 LT",
        "apcn": "ProRes 422",
        "apch": "ProRes 422 HQ",
        "ap4h": "ProRes 4444",
        "ap4x": "ProRes 4444 XQ",
        "apns": "ProRes 422 Proxy (NS)",
    }
    if is_prores:
        profile = profiles.get(tag, "ProRes")
    return name, tag, is_prores, profile


# ── Image sequence detection ──────────────────────────────────────────────────

_SEQ_RE = re.compile(r"^(.+?)([_.]?)(\d{3,8})(\.(?:exr|dpx|tif|tiff|png|jpg|jpeg|tga))$", re.IGNORECASE)


def detect_image_sequence(path: str) -> dict | None:
    p = Path(path)
    if p.is_file():
        m = _SEQ_RE.match(p.name)
        if m:
            parent = p.parent
            prefix, sep, num_str, ext = m.groups()
            pad = len(num_str)
            pattern_glob = f"{prefix}{sep}{'?' * pad}{ext}"
            all_files = sorted(parent.glob(pattern_glob))
            if len(all_files) > 1:
                nums = []
                for f in all_files:
                    mm = _SEQ_RE.match(f.name)
                    if mm:
                        nums.append(int(mm.group(3)))
                nums.sort()
                pattern_path = str(parent / f"{prefix}{sep}%0{pad}d{ext}")
                return {
                    "kind": "image_sequence",
                    "startFrame": nums[0],
                    "endFrame": nums[-1],
                    "frameCount": len(nums),
                    "pattern": pattern_path,
                    "extension": ext.lower().lstrip("."),
                }
    if p.is_dir():
        for ext in (".exr", ".dpx", ".tiff", ".tif", ".png"):
            files = sorted(p.glob(f"*{ext}"))
            if len(files) >= 2:
                first = files[0]
                m = _SEQ_RE.match(first.name)
                if m:
                    prefix, sep, num_str, file_ext = m.groups()
                    pad = len(num_str)
                    nums = []
                    for f in files:
                        mm = _SEQ_RE.match(f.name)
                        if mm:
                            nums.append(int(mm.group(3)))
                    nums.sort()
                    pattern_path = str(p / f"{prefix}{sep}%0{pad}d{file_ext}")
                    return {
                        "kind": "image_sequence",
                        "startFrame": nums[0],
                        "endFrame": nums[-1],
                        "frameCount": len(nums),
                        "pattern": pattern_path,
                        "extension": ext.lstrip("."),
                    }
    return None


# ── IMF package detection ─────────────────────────────────────────────────────

def detect_imf_package(path: str) -> dict | None:
    p = Path(path)
    search_dirs = [p] if p.is_dir() else [p.parent]
    # also check sub-folders one level deep
    if p.is_dir():
        for sub in p.iterdir():
            if sub.is_dir():
                search_dirs.append(sub)
    for d in search_dirs:
        assetmap = d / "ASSETMAP.xml"
        assetmap2 = d / "ASSETMAP"
        if assetmap.is_file() or assetmap2.is_file():
            am_path = str(assetmap if assetmap.is_file() else assetmap2)
            cpls = list(d.glob("*.xml"))
            return {
                "kind": "imf_package",
                "folder": str(d),
                "assetmap": am_path,
                "cplCount": len([f for f in cpls if "CPL" in f.name.upper()]),
            }
    return None


# ── Main probe ────────────────────────────────────────────────────────────────

def probe(
    path: str,
    context: str = "",
    timeline_fps: str = "",
    timecode_base: int = 0,
) -> dict[str, Any]:
    p = Path(path)
    warnings: list[str] = []
    errors: list[str] = []

    # IMF package detection (folder or ASSETMAP.xml)
    if p.is_dir() or p.name.upper() in ("ASSETMAP.XML", "ASSETMAP"):
        imf = detect_imf_package(path)
        if imf:
            return {
                "ok": True,
                "path": path,
                "kind": "imf_package",
                "container": "imf",
                "codec": "jpeg2000",
                "codecTag": "",
                "profile": "",
                "width": 0, "height": 0,
                "fps": {"num": 0, "den": 1, "display": ""},
                "timecode": {"start": "", "source": "none", "dropFrame": False, "timecodeBase": 0},
                "durationFrames": 0, "durationSeconds": 0,
                "audioStreams": [], "subtitleStreams": [],
                "isBrowserSafe": False, "isCameraRaw": False,
                "isImageSequence": False, "isImfPackage": True,
                "imfPackageFolder": imf["folder"],
                "imfAssetmap": imf["assetmap"],
                "recommendedEngine": "IMFEngine",
                "fallbackEngines": ["FFmpegFrameServerEngine", "ProxyEngine"],
                "warnings": warnings, "errors": errors,
            }
        # Image sequence in folder?
        seq = detect_image_sequence(path)
        if seq:
            return _make_seq_result(path, seq, warnings, errors)

    # File-based media
    if not p.is_file():
        return {"ok": False, "path": path, "errors": [f"Path not found: {path}"], "warnings": []}

    ext = p.suffix.lower()

    # Image sequence (single file clicked)
    seq = detect_image_sequence(path)
    if seq:
        return _make_seq_result(path, seq, warnings, errors)

    # ffprobe
    ffprobe_bin = find_ffprobe()
    if not ffprobe_bin:
        # Fallback: basic extension sniffing
        return _sniff_by_extension(path, warnings, errors)

    rc, out, err = _run_ffprobe(ffprobe_bin, path)
    if rc != 0 or not out.strip():
        errors.append(f"ffprobe failed (exit {rc}): {err[:300]}")
        return _sniff_by_extension(path, warnings, errors)

    try:
        data = json.loads(out)
    except json.JSONDecodeError as e:
        errors.append(f"ffprobe JSON parse error: {e}")
        return _sniff_by_extension(path, warnings, errors)

    return _build_probe_result(path, data, context, warnings, errors)


def _run_ffprobe(ffprobe_bin: str, path: str) -> tuple[int, str, str]:
    try:
        r = subprocess.run(
            [ffprobe_bin, "-v", "error", "-show_format", "-show_streams",
             "-show_chapters", "-of", "json", path],
            capture_output=True, text=True, timeout=30,
        )
        return r.returncode, r.stdout, r.stderr
    except subprocess.TimeoutExpired:
        return -2, "", "ffprobe timeout"
    except Exception as e:
        return -3, "", str(e)


def _build_probe_result(path: str, data: dict, context: str, warnings: list, errors: list) -> dict:
    fmt = data.get("format", {})
    streams = data.get("streams", [])

    v_stream = next((s for s in streams if s.get("codec_type") == "video"), {})
    a_streams = [s for s in streams if s.get("codec_type") == "audio"]
    sub_streams = [s for s in streams if s.get("codec_type") == "subtitle"]

    codec_name = v_stream.get("codec_name", "")
    codec_tag = v_stream.get("codec_tag_string", "")
    codec_name, codec_tag, is_prores, profile = _classify_codec(codec_name, codec_tag)
    if not profile:
        profile = v_stream.get("profile", "")

    raw_container = fmt.get("format_name", "")
    container = _norm_container(raw_container)

    fps = _fps_info(v_stream.get("r_frame_rate") or v_stream.get("avg_frame_rate") or "")
    duration_secs = float(fmt.get("duration") or v_stream.get("duration") or 0)
    fps_val = fps["num"] / fps["den"] if fps["den"] else 0
    duration_frames = round(duration_secs * fps_val) if fps_val else 0

    tc_info = _find_timecode(fmt, streams)
    if tc_info["timecodeBase"] == 0 and fps_val > 0:
        tc_info["timecodeBase"] = round(fps_val)

    width = v_stream.get("width", 0) or fmt.get("width", 0)
    height = v_stream.get("height", 0) or fmt.get("height", 0)

    ext = Path(path).suffix.lower()
    is_ocf = ext in OCF_EXTENSIONS and codec_name not in {"prores", "h264", "hevc", "dnxhd", "dnxhr"}
    if ext == ".mxf":
        is_ocf = codec_name in {"jpeg2000", "j2k", "htj2k", "", "rawvideo"} and not is_prores

    is_browser_safe = (
        container in BROWSER_SAFE_CONTAINERS and
        codec_name in BROWSER_SAFE_CODECS and
        not is_prores
    )

    audio_list = [
        {
            "index": s.get("index"),
            "codec": s.get("codec_name", ""),
            "channels": s.get("channels", 0),
            "sampleRate": s.get("sample_rate", ""),
            "layout": s.get("channel_layout", ""),
        }
        for s in a_streams
    ]

    from .media_router import select_engine
    engine, fallbacks, reason = select_engine(
        container=container,
        codec=codec_name,
        codec_tag=codec_tag,
        is_prores=is_prores,
        is_ocf=is_ocf,
        is_browser_safe=is_browser_safe,
        is_image_sequence=False,
        is_imf_package=False,
    )

    result = {
        "ok": True,
        "path": path,
        "kind": "video" if v_stream else "audio" if a_streams else "unknown",
        "container": container,
        "codec": codec_name,
        "codecTag": codec_tag,
        "profile": profile,
        "width": width,
        "height": height,
        "fps": fps,
        "timecode": tc_info,
        "durationFrames": duration_frames,
        "durationSeconds": round(duration_secs, 6),
        "audioStreams": audio_list,
        "subtitleStreams": [{"index": s.get("index"), "codec": s.get("codec_name", "")} for s in sub_streams],
        "isBrowserSafe": is_browser_safe,
        "isCameraRaw": is_ocf,
        "isImageSequence": False,
        "isImfPackage": False,
        "recommendedEngine": engine,
        "fallbackEngines": fallbacks,
        "routingReason": reason,
        "warnings": warnings,
        "errors": errors,
    }

    _log("playback", {
        "Probe": {
            "path": path, "kind": result["kind"], "container": container,
            "codec": codec_name, "codecTag": codec_tag, "profile": profile,
            "fps": fps.get("display", ""), "timecode": tc_info.get("start", ""),
            "duration": f"{duration_secs:.3f}s / {duration_frames} frames",
        },
        "Router": {"selectedEngine": engine, "fallbackEngines": str(fallbacks), "reason": reason},
    })

    return result


def _make_seq_result(path: str, seq: dict, warnings: list, errors: list) -> dict:
    from .media_router import select_engine
    engine, fallbacks, reason = select_engine(
        container="image_sequence", codec=seq.get("extension", "exr"),
        is_prores=False, is_ocf=False, is_browser_safe=False,
        is_image_sequence=True, is_imf_package=False,
        codec_tag="", # unused
    )
    return {
        "ok": True,
        "path": path,
        "kind": "image_sequence",
        "container": "image_sequence",
        "codec": seq.get("extension", "exr"),
        "codecTag": "",
        "profile": "",
        "width": 0, "height": 0,
        "fps": {"num": 0, "den": 1, "display": ""},
        "timecode": {"start": "", "source": "none", "dropFrame": False, "timecodeBase": 0},
        "durationFrames": seq.get("frameCount", 0),
        "durationSeconds": 0,
        "audioStreams": [], "subtitleStreams": [],
        "isBrowserSafe": False, "isCameraRaw": False,
        "isImageSequence": True, "isImfPackage": False,
        "sequenceInfo": seq,
        "recommendedEngine": engine,
        "fallbackEngines": fallbacks,
        "routingReason": reason,
        "warnings": warnings, "errors": errors,
    }


def _sniff_by_extension(path: str, warnings: list, errors: list) -> dict:
    from .media_router import select_engine
    ext = Path(path).suffix.lower()
    is_prores = ext == ".mov"
    is_ocf = ext in OCF_EXTENSIONS
    container = {
        ".mov": "mov", ".mp4": "mp4", ".m4v": "mp4", ".mxf": "mxf",
        ".mkv": "mkv", ".avi": "avi",
    }.get(ext, ext.lstrip("."))
    codec = {".r3d": "redcode", ".braw": "braw", ".ari": "arriraw"}.get(ext, "unknown")
    engine, fallbacks, reason = select_engine(
        container=container, codec=codec, codec_tag="",
        is_prores=is_prores, is_ocf=is_ocf, is_browser_safe=False,
        is_image_sequence=False, is_imf_package=False,
    )
    warnings.append("ffprobe unavailable — engine selected by extension only")
    return {
        "ok": True,
        "path": path,
        "kind": "video",
        "container": container,
        "codec": codec,
        "codecTag": "",
        "profile": "",
        "width": 0, "height": 0,
        "fps": {"num": 0, "den": 1, "display": ""},
        "timecode": {"start": "", "source": "none", "dropFrame": False, "timecodeBase": 0},
        "durationFrames": 0, "durationSeconds": 0,
        "audioStreams": [], "subtitleStreams": [],
        "isBrowserSafe": False,
        "isCameraRaw": is_ocf,
        "isImageSequence": False, "isImfPackage": False,
        "recommendedEngine": engine,
        "fallbackEngines": fallbacks,
        "routingReason": reason,
        "warnings": warnings, "errors": errors,
    }
