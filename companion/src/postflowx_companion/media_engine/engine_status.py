from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

FFMPEG_SEARCH = [
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
    "/usr/bin/ffmpeg",
]
FFPROBE_SEARCH = [
    "/opt/homebrew/bin/ffprobe",
    "/usr/local/bin/ffprobe",
    "/usr/bin/ffprobe",
]
MPV_SEARCH = [
    "/opt/homebrew/bin/mpv",
    "/usr/local/bin/mpv",
    "/usr/bin/mpv",
]
OJPH_SEARCH = [
    "/opt/homebrew/bin/ojph_expand",
    "/usr/local/bin/ojph_expand",
]


def _which_first(candidates: list[str], name: str) -> str | None:
    for p in candidates:
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    found = shutil.which(name)
    return found or None


def _run_capture(cmd: list[str], timeout: int = 5) -> tuple[int, str, str]:
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.returncode, r.stdout, r.stderr
    except FileNotFoundError:
        return -1, "", "not found"
    except subprocess.TimeoutExpired:
        return -2, "", "timeout"
    except Exception as e:
        return -3, "", str(e)


def _bundled(name: str) -> str | None:
    """Bundled binary under .app/Contents/Resources/bin (Dev Brief P0#2).
    A GUI-launched companion has a stripped PATH and no /opt/homebrew, so this
    must win over the Homebrew-first FFMPEG_SEARCH/FFPROBE_SEARCH lists."""
    try:
        from ..proxy_service import _resource_bin
        return _resource_bin(name)
    except Exception:
        return None


def find_ffmpeg() -> str | None:
    return _bundled("ffmpeg") or _which_first(FFMPEG_SEARCH, "ffmpeg")


def find_ffprobe() -> str | None:
    return _bundled("ffprobe") or _which_first(FFPROBE_SEARCH, "ffprobe")


def find_mpv() -> str | None:
    return _which_first(MPV_SEARCH, "mpv")


def find_ojph() -> str | None:
    return _which_first(OJPH_SEARCH, "ojph_expand")


def check_all() -> dict:
    results: dict[str, dict] = {}

    # AVFoundation — always present on macOS if avf_bridge exists
    avf_bridge = Path(__file__).parents[3] / "native" / "avf_bridge"
    if not avf_bridge.exists():
        # Try app.asar.unpacked path
        avf_bridge = Path(__file__).parents[5] / "app.asar.unpacked" / "electron" / "native" / "avf_bridge"
    avf_ok = avf_bridge.is_file() and os.access(str(avf_bridge), os.X_OK)
    results["AVFoundation"] = {
        "name": "AVFoundation",
        "label": "AVFoundation (macOS Native)",
        "available": avf_ok,
        "path": str(avf_bridge) if avf_ok else "",
        "detail": "Ready" if avf_ok else "avf_bridge binary not found",
    }

    results["VideoToolbox"] = {
        "name": "VideoToolbox",
        "label": "VideoToolbox (HW Decode)",
        "available": avf_ok,
        "path": "",
        "detail": "Ready (via AVFoundation)" if avf_ok else "Requires AVFoundation",
    }

    # FFmpeg
    ffmpeg_bin = find_ffmpeg()
    ffmpeg_ok = bool(ffmpeg_bin)
    ffmpeg_version = ""
    ffmpeg_buildconf = ""
    has_imf_demuxer = False
    has_libopenjpeg = False
    has_libxml2 = False
    if ffmpeg_ok:
        rc, out, err = _run_capture([ffmpeg_bin, "-hide_banner", "-version"])
        ffmpeg_version = (out or err or "").split("\n")[0]
        rc2, conf_out, _ = _run_capture([ffmpeg_bin, "-hide_banner", "-buildconf"])
        ffmpeg_buildconf = conf_out
        has_libxml2 = "--enable-libxml2" in ffmpeg_buildconf or "enable-libxml2" in ffmpeg_buildconf
        rc3, dem_out, _ = _run_capture([ffmpeg_bin, "-hide_banner", "-demuxers"])
        has_imf_demuxer = " imf " in dem_out or "\nimf\n" in dem_out or " imf\n" in dem_out
        rc4, dec_out, _ = _run_capture([ffmpeg_bin, "-hide_banner", "-decoders"])
        has_libopenjpeg = "libopenjpeg" in dec_out

    results["FFmpeg"] = {
        "name": "FFmpeg",
        "label": "FFmpeg",
        "available": ffmpeg_ok,
        "path": ffmpeg_bin or "",
        "version": ffmpeg_version,
        "detail": ffmpeg_version if ffmpeg_ok else "Not found. Install: brew install ffmpeg",
    }

    results["FFprobe"] = {
        "name": "FFprobe",
        "label": "FFprobe",
        "available": bool(find_ffprobe()),
        "path": find_ffprobe() or "",
        "detail": "Ready" if find_ffprobe() else "Not found",
    }

    results["IMFDemuxer"] = {
        "name": "IMFDemuxer",
        "label": "FFmpeg IMF demuxer (-f imf)",
        "available": has_imf_demuxer,
        "detail": "Ready" if has_imf_demuxer else (
            "Missing — ffmpeg built without --enable-libxml2" if ffmpeg_ok else "Requires FFmpeg"
        ),
    }

    results["libxml2"] = {
        "name": "libxml2",
        "label": "libxml2 (IMF/CPL parsing)",
        "available": has_libxml2,
        "detail": "Enabled in ffmpeg" if has_libxml2 else "Not in ffmpeg buildconf",
    }

    results["libopenjpeg"] = {
        "name": "libopenjpeg",
        "label": "libopenjpeg (J2K decoder)",
        "available": has_libopenjpeg,
        "detail": "Ready" if has_libopenjpeg else "Missing — brew install openjpeg, then rebuild ffmpeg",
    }

    # OpenJPH
    ojph_bin = find_ojph()
    ojph_ok = bool(ojph_bin)
    ojph_version = ""
    if ojph_ok:
        rc, out, err = _run_capture([ojph_bin, "--version"], timeout=3)
        ojph_version = (out or err or "").strip().split("\n")[0]

    results["OpenJPH"] = {
        "name": "OpenJPH",
        "label": "OpenJPH (HTJ2K decoder)",
        "available": ojph_ok,
        "path": ojph_bin or "",
        "version": ojph_version,
        "detail": ojph_version or "Ready" if ojph_ok else "Not found. Install: brew install openjph",
    }

    # MPV
    mpv_bin = find_mpv()
    mpv_ok = bool(mpv_bin)
    mpv_version = ""
    if mpv_ok:
        rc, out, err = _run_capture([mpv_bin, "--version"], timeout=3)
        mpv_version = (out or "").strip().split("\n")[0]

    results["MPV"] = {
        "name": "MPV",
        "label": "MPV (broad codec fallback)",
        "available": mpv_ok,
        "path": mpv_bin or "",
        "version": mpv_version,
        "detail": mpv_version or "Ready" if mpv_ok else "Not found. Install: brew install mpv",
    }

    # Grok JPEG2000
    grok_bin = shutil.which("grk_decompress") or shutil.which("grok")
    results["Grok"] = {
        "name": "Grok",
        "label": "Grok JPEG2000 (backup decoder)",
        "available": bool(grok_bin),
        "path": grok_bin or "",
        "detail": "Ready" if grok_bin else "Not found (optional)",
    }

    # Photon
    photon_bin = (shutil.which("photon") or
                  shutil.which("pfx-photon") or
                  str(Path.home() / "bin" / "photon") if (Path.home() / "bin" / "photon").exists() else None)
    results["Photon"] = {
        "name": "Photon",
        "label": "Photon (IMF reference validator)",
        "available": bool(photon_bin),
        "path": photon_bin or "",
        "detail": "Ready" if photon_bin else "Not found (optional)",
    }

    # Resolve
    resolve_app = Path("/Applications/DaVinci Resolve/DaVinci Resolve.app")
    resolve_ok = resolve_app.exists()
    results["Resolve"] = {
        "name": "Resolve",
        "label": "DaVinci Resolve Engine",
        "available": resolve_ok,
        "path": str(resolve_app) if resolve_ok else "",
        "detail": "Installed" if resolve_ok else "Not installed — required for OCF/RAW decode",
    }

    # Proxy engine is always available (uses FFmpeg)
    results["ProxyEngine"] = {
        "name": "ProxyEngine",
        "label": "Proxy Engine (FFmpeg transcode)",
        "available": ffmpeg_ok,
        "detail": "Ready" if ffmpeg_ok else "Requires FFmpeg",
    }

    return results


def engine_status_for_ui() -> list[dict]:
    statuses = check_all()
    order = [
        "AVFoundation", "VideoToolbox", "MPV",
        "FFmpeg", "FFprobe",
        "IMFDemuxer", "libxml2", "libopenjpeg", "OpenJPH", "Grok",
        "Photon", "Resolve", "ProxyEngine",
    ]
    rows = []
    for key in order:
        if key not in statuses:
            continue
        s = statuses[key]
        avail = s.get("available", False)
        rows.append({
            "id":     key,
            "label":  s.get("label", key),
            "status": "ready" if avail else "missing",
            "detail": s.get("detail", ""),
            "path":   s.get("path", ""),
            "version": s.get("version", ""),
        })
    return rows
