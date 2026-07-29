from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

# ── Helpers ───────────────────────────────────────────────────────────────────

_PRORES_TAGS = {"apcn", "apco", "apcs", "apch", "ap4h", "ap4x", "apns", "ap4c"}

_CODEC_FORMAT_MAP = {
    "prores":    "ProRes",
    "h264":      "H264", "avc1": "H264",
    "hevc":      "HEVC", "hvc1": "HEVC",
    "dnxhd":     "DNxHD", "dnxhr": "DNxHR",
    "mjpeg":     "MJPEG",
    "jpeg2000":  "JPEG2000",
    "redcode":   "R3D",
    "braw":      "BRAW",
    "arriraw":   "ARRIRAW",
}

_PRORES_TAG_NAMES = {
    "apco": "ProRes 422 Proxy", "apcs": "ProRes 422 LT", "apcn": "ProRes 422",
    "apch": "ProRes 422 HQ",    "ap4h": "ProRes 4444",   "ap4x": "ProRes 4444 XQ",
    "apns": "ProRes 422 Proxy",
}

_TC_KEYS = [
    "timecode", "time_code", "TIMECODE", "TIME_CODE",
    "com.arri.camera.timecode", "ARRI:timecode",
    "start_timecode", "start_tc",
    "LTC_TC", "LtcTc",
    "braw_timecode",
    "material_package_uid_timecode",
]

_CONTAINER_MAP = {
    "mov,mp4,m4a,3gp,3g2,mj2": "mov",
    "matroska,webm": "mkv",
    "mxf": "mxf",
    "image2": "image_sequence",
}


def _norm_container(fmt_name: str) -> str:
    for key, val in _CONTAINER_MAP.items():
        if fmt_name in key.split(","):
            return val
    return fmt_name.split(",")[0]


def _fps_info(fps_str: str) -> dict:
    if not fps_str or fps_str in ("0/0", "0"):
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


def _tc_source(all_tags: dict) -> tuple[str, str]:
    for k in _TC_KEYS:
        v = str(all_tags.get(k, "") or "")
        if v and re.match(r"\d{2}:\d{2}:\d{2}[:;]\d{2}", v):
            return v.strip(), "embedded"
    return "", "unknown"


def _detect_family_from_tags(all_tags: dict, codec: str, ext: str) -> str:
    cam = str(all_tags.get("encoder") or all_tags.get("camera_model")
              or all_tags.get("CameraModel") or all_tags.get("make") or "").lower()
    company = str(all_tags.get("company_name") or "").lower()
    product = str(all_tags.get("product_name") or "").lower()
    codec_l = str(codec or "").lower()
    if "arri" in cam or ext in (".ari", ".arx", ".arriraw"):    return "ARRI"
    if "blackmagic" in cam or "braw" in codec_l or ext == ".braw": return "Blackmagic"
    if "red" in cam or "redcode" in codec_l or ext == ".r3d":      return "RED"
    if "sony" in cam:                                             return "Sony"
    # Sony X-OCN / RAW MXF: ffmpeg can't decode the essence (codec unknown / 0x0),
    # but the MXF carries Sony AXS authoring tags (company_name=Sony,
    # product_name=AXS…). Gate on RAW-ness so decodable Sony XAVC (h264/hevc/xavc)
    # stays on the fast ffmpeg path instead of being forced through Resolve.
    if "sony" in company and ("axs" in product or codec_l in ("", "unknown", "none", "mxf")):
        return "Sony"
    if "canon" in cam or ext in (".crm", ".rmf"):                return "Canon"
    return "Generic"


def _color_info(family: str, all_tags: dict) -> dict:
    color_space_map = {
        "ARRI":        ("ARRI Wide Gamut 4",           "LogC4"),
        "RED":         ("REDWideGamutRGB",              "Log3G10"),
        "Blackmagic":  ("Blackmagic Wide Gamut",        "BMD Film Gen 5"),
        "Sony":        ("Sony S-Gamut3.Cine",           "S-Log3"),
        "Canon":       ("Canon Cinema Gamut",           "Canon Log 2"),
        "Generic":     ("unknown",                      "unknown"),
    }
    cs, lc = color_space_map.get(family, ("unknown", "unknown"))
    # Override from tags if present
    cs = (all_tags.get("colorspace") or all_tags.get("ColorSpace")
          or all_tags.get("color_space") or cs)
    lc = (all_tags.get("color_transfer") or all_tags.get("ColorTransfer") or lc)
    return {
        "cameraColorSpace":  cs,
        "logCurve":          lc,
        "displayTransform":  "Rec709",
    }


def probe_ocf_clip(
    clip_path: str,
    ffprobe_bin: str | None = None,
    sidecar_paths: list[str] | None = None,
) -> dict[str, Any]:
    """
    Full OCF metadata probe for a single clip.

    Returns the canonical OCF probe dict used by router, decode, UI badge.
    Never raises — errors are returned in probe["errors"].
    """
    from ..media_engine.engine_status import find_ffprobe, find_ffmpeg

    path = Path(clip_path)
    ext  = path.suffix.lower()
    stem = path.stem
    errors: list[str] = []
    warnings: list[str] = []

    # ── ffprobe ───────────────────────────────────────────────────────────────
    if not ffprobe_bin:
        ffprobe_bin = find_ffprobe() or find_ffprobe()

    raw: dict = {}
    if ffprobe_bin and path.is_file():
        try:
            result = subprocess.run(
                [ffprobe_bin, "-v", "quiet", "-print_format", "json",
                 "-show_streams", "-show_format", clip_path],
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode == 0:
                raw = json.loads(result.stdout)
        except Exception as exc:
            warnings.append(f"ffprobe error: {exc}")
    elif not path.is_file():
        errors.append(f"File not found: {clip_path}")

    fmt_dict   = raw.get("format", {})
    streams    = raw.get("streams", [])
    vid_stream = next((s for s in streams if s.get("codec_type") == "video"), {})
    aud_streams = [s for s in streams if s.get("codec_type") == "audio"]

    all_tags = {**vid_stream.get("tags", {}), **fmt_dict.get("tags", {})}

    # ── Container / codec ─────────────────────────────────────────────────────
    container   = _norm_container(fmt_dict.get("format_name", ext.lstrip(".")))
    codec_raw   = vid_stream.get("codec_name", ext.lstrip(".")).lower()
    codec_tag   = (vid_stream.get("codec_tag_string") or "").lower()
    codec       = codec_raw
    fmt_label   = _CODEC_FORMAT_MAP.get(codec_raw, codec_raw.upper())
    if codec_tag in _PRORES_TAG_NAMES:
        fmt_label = _PRORES_TAG_NAMES[codec_tag]

    # ── Resolution ────────────────────────────────────────────────────────────
    width  = int(vid_stream.get("width")  or 0)
    height = int(vid_stream.get("height") or 0)

    # ── FPS ───────────────────────────────────────────────────────────────────
    fps = _fps_info(vid_stream.get("r_frame_rate", "24/1"))

    # ── Timecode ──────────────────────────────────────────────────────────────
    tc_val, tc_source = _tc_source(all_tags)
    drop_frame = ";" in tc_val
    tc_base    = round(fps["num"] / fps["den"]) if fps["den"] else 24
    timecode   = {
        "start":         tc_val or "00:00:00:00",
        "source":        tc_source,
        "dropFrame":     drop_frame,
        "timecodeBase":  tc_base,
    }

    # ── Reel / camera ─────────────────────────────────────────────────────────
    reel = (all_tags.get("reel_name") or all_tags.get("Reel") or all_tags.get("REEL")
            or all_tags.get("clip_name") or stem)
    camera_model = (all_tags.get("encoder") or all_tags.get("camera_model")
                    or all_tags.get("CameraModel") or "")

    # ── Camera family ─────────────────────────────────────────────────────────
    family = _detect_family_from_tags(all_tags, codec, ext)

    # ── Color ─────────────────────────────────────────────────────────────────
    color = _color_info(family, all_tags)

    # ── Audio streams ─────────────────────────────────────────────────────────
    audio = [
        {
            "index":      s.get("index"),
            "codec":      s.get("codec_name", ""),
            "channels":   s.get("channels", 0),
            "sampleRate": s.get("sample_rate", ""),
            "layout":     s.get("channel_layout", ""),
        }
        for s in aud_streams
    ]

    # ── Engine recommendation (fast path — full router not needed here) ────────
    from .ocf_router import select_ocf_engine
    engine_rec, fallbacks, reason = select_ocf_engine({
        "cameraFamily": family,
        "container":    container,
        "codec":        codec,
        "codecTag":     codec_tag,
        "kind":         "image_sequence" if container == "image_sequence" else "ocf_file",
    })

    return {
        "ok":               True,
        "clipId":           _clip_id_from_path(clip_path),
        "cameraFamily":     family,
        "format":           fmt_label,
        "container":        container,
        "codec":            codec,
        "codecTag":         codec_tag,
        "width":            width,
        "height":           height,
        "fps":              fps,
        "timecode":         timecode,
        "reel":             reel,
        "cameraName":       _guess_camera_name(all_tags, stem),
        "clipName":         stem,
        "cameraModel":      camera_model,
        "color":            color,
        "audio":            audio,
        "recommendedEngine":  engine_rec,
        "fallbackEngines":    fallbacks,
        "warnings":         warnings,
        "errors":           errors,
    }


def _clip_id_from_path(path: str) -> str:
    stem = os.path.splitext(os.path.basename(path))[0]
    return re.sub(r"[^A-Za-z0-9_\-]", "_", stem)


def _guess_camera_name(tags: dict, stem: str) -> str:
    m = re.match(r"^([A-Za-z])(\d{3,4})", stem)
    if m:
        letter = m.group(1).upper()
        names = {"A": "A Cam", "B": "B Cam", "C": "C Cam", "D": "D Cam"}
        return names.get(letter, f"{letter} Cam")
    return ""
