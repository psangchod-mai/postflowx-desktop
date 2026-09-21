"""ACES 2.0 output transforms — runtime LUT selection + ffmpeg filter.

The LUTs are pre-baked at build time (see tools/gen_aces2_luts.py) from OCIO 2.5's
ACES 2.0 built-in config and shipped in assets/aces2_luts/. At runtime we only need
the bundled ffmpeg — NO OpenColorIO / numpy dependency.

Each output transform = a shared 1D shaper (linear→log) + a 3D cube (shaped→display).
They MUST be applied as two separate ffmpeg filters (lut1d then lut3d): ffmpeg's
lut3d ignores an embedded .csp prelut, which would lift shadows / crush highlights.

Typical use (review_proxy / display-referred output):
    flt = aces2_luts.ffmpeg_video_filter("rec709_sdr")
    cmd += ["-vf", flt, ...]
"""
from __future__ import annotations

import os
from pathlib import Path

# Each transform names its 1D shaper: SDR (lg2[-12,5], 33^3 cubes) and HDR
# (lg2[-12,8], 65536-pt shaper, 49^3 cubes) — see tools/gen_aces2_luts.py.
SHAPER_SDR = "shaper_sdr.cube"
SHAPER_HDR = "shaper_hdr.cube"

# id -> human label + the OCIO display/view it was baked from (for UI / provenance).
REGISTRY: dict[str, dict[str, str]] = {
    "rec709_sdr": {
        "label":   "ACES 2.0 — SDR Rec.709 (BT.1886) 100 nits",
        "display": "Rec.1886 Rec.709 - Display",
        "view":    "ACES 2.0 - SDR 100 nits (Rec.709)",
        "dynamicRange": "SDR", "shaper": SHAPER_SDR,
    },
    "srgb_sdr": {
        "label":   "ACES 2.0 — SDR sRGB 100 nits",
        "display": "sRGB - Display",
        "view":    "ACES 2.0 - SDR 100 nits (Rec.709)",
        "dynamicRange": "SDR", "shaper": SHAPER_SDR,
    },
    "p3d65_sdr": {
        "label":   "ACES 2.0 — SDR P3-D65 100 nits",
        "display": "P3-D65 - Display",
        "view":    "ACES 2.0 - SDR 100 nits (P3 D65)",
        "dynamicRange": "SDR", "shaper": SHAPER_SDR,
    },
    "rec2100_pq_1000": {
        "label":   "ACES 2.0 — HDR Rec.2100 PQ 1000 nits (P3-D65)",
        "display": "Rec.2100-PQ - Display",
        "view":    "ACES 2.0 - HDR 1000 nits (P3 D65)",
        "dynamicRange": "HDR", "shaper": SHAPER_HDR,
    },
    "rec2100_hlg_1000": {
        "label":   "ACES 2.0 — HDR Rec.2100 HLG 1000 nits (P3-D65)",
        "display": "Rec.2100-HLG - Display",
        "view":    "ACES 2.0 - HDR 1000 nits (P3 D65)",
        "dynamicRange": "HDR", "shaper": SHAPER_HDR,
    },
}

# Map common/legacy ODT names (from colorPlanEngine projectConfig.odtName etc.) to ids.
_ALIASES = {
    "rec.709": "rec709_sdr",
    "rec709": "rec709_sdr",
    "rec.709 100-nits": "rec709_sdr",
    "rec.1886 rec.709": "rec709_sdr",
    "bt.1886": "rec709_sdr",
    "srgb": "srgb_sdr",
    "p3": "p3d65_sdr",
    "p3-d65": "p3d65_sdr",
    "p3d65": "p3d65_sdr",
    "display p3": "p3d65_sdr",
}


def lut_dir() -> Path:
    """Locate assets/aces2_luts (dev: repo root, packaged: .app/Contents/Resources).

    PFX_ACES2_LUT_DIR overrides everything (dev/testing)."""
    env = str(os.environ.get("PFX_ACES2_LUT_DIR") or "").strip()
    if env:
        return Path(env)
    # this file: .../companion/src/postflowx_companion/color/aces2_luts.py
    # parents[4] == repo root (dev) / Resources (packaged); assets sits beside companion.
    return Path(__file__).resolve().parents[4] / "assets" / "aces2_luts"


def shaper_path(lut_id: str | None = None) -> Path | None:
    """Shaper LUT for a transform (SDR/HDR differ). With no id, returns the SDR
    shaper (back-compat)."""
    fname = REGISTRY.get(lut_id, {}).get("shaper", SHAPER_SDR) if lut_id else SHAPER_SDR
    p = lut_dir() / fname
    return p if p.is_file() else None


def cube_path(lut_id: str) -> Path | None:
    p = lut_dir() / f"aces2_{lut_id}.cube"
    return p if p.is_file() else None


def available() -> list[str]:
    """Output-transform ids whose shaper + cube are both present on disk."""
    return [k for k in REGISTRY if cube_path(k) and shaper_path(k)]


def list_output_transforms() -> list[dict]:
    """UI-facing list of available ACES 2.0 output transforms."""
    out = []
    for k in available():
        out.append({"id": k, **REGISTRY[k]})
    return out


def resolve_lut_id(name: str | None, default: str = "rec709_sdr") -> str | None:
    """Resolve a colorPlan odtName / free-text display name to a known LUT id."""
    if not name:
        return default if cube_path(default) else None
    key = str(name).strip().lower()
    if key in REGISTRY and cube_path(key):
        return key
    if key in _ALIASES and cube_path(_ALIASES[key]):
        return _ALIASES[key]
    # substring fallback (e.g. "Rec.709 (ACES 2.0)" -> rec709_sdr)
    for alias, lid in _ALIASES.items():
        if alias in key and cube_path(lid):
            return lid
    return default if cube_path(default) else None


def _escape(p: Path) -> str:
    """Escape a path for use inside an ffmpeg filtergraph argument."""
    s = str(p)
    # ffmpeg filtergraph: ':' and '\' are special inside option values.
    return s.replace("\\", "\\\\").replace(":", "\\:")


def ffmpeg_video_filter(lut_id: str,
                        lut1d_interp: str = "linear",
                        lut3d_interp: str = "tetrahedral") -> str:
    """Return the `-vf` chain that applies the ACES 2.0 output transform `lut_id`.

    Raises FileNotFoundError if the shaper or cube is missing (so callers fail loudly
    rather than silently shipping un-transformed pixels).
    """
    sp = shaper_path(lut_id)
    cp = cube_path(lut_id)
    if not sp:
        raise FileNotFoundError(f"ACES 2.0 shaper LUT missing for '{lut_id}': {lut_dir()}")
    if not cp:
        raise FileNotFoundError(f"ACES 2.0 cube missing for '{lut_id}': {lut_dir()}")
    return (f"lut1d={_escape(sp)}:interp={lut1d_interp},"
            f"lut3d={_escape(cp)}:interp={lut3d_interp}")
