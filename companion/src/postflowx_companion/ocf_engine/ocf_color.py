from __future__ import annotations

from typing import Any

# ── Color space / log-curve tables ────────────────────────────────────────────

_FAMILY_COLOR = {
    "ARRI":       ("ARRI Wide Gamut 4",         "LogC4",              "Rec709"),
    "RED":        ("REDWideGamutRGB",            "Log3G10",            "Rec709"),
    "Blackmagic": ("Blackmagic Wide Gamut",      "BMD Film Gen 5",     "Rec709"),
    "Sony":       ("Sony S-Gamut3.Cine",         "S-Log3",             "Rec709"),
    "Canon":      ("Canon Cinema Gamut",         "Canon Log 2",        "Rec709"),
    "Generic":    ("unknown",                    "unknown",            "Rec709"),
}

_ACCURATE_ENGINES = {
    "BRAWSDKEngine", "REDSDKEngine", "ARRISDKEngine",
    "CanonRawSDKEngine", "ResolveEngine",
}


def color_badge(probe: dict[str, Any], engine: str | None = None) -> dict[str, Any]:
    """
    Compute the color preview badge for a probed OCF clip.

    Returns:
      {
        "cameraColorSpace", "logCurve", "displayTransform",
        "label",          # human-readable badge label
        "technical",      # True if color accuracy is not guaranteed
        "mode",           # "native_log" | "rec709_preview" | "technical_preview"
      }
    """
    family = probe.get("cameraFamily", "Generic")
    color  = probe.get("color") or {}

    cs   = color.get("cameraColorSpace")  or _FAMILY_COLOR.get(family, ("unknown", "unknown", "Rec709"))[0]
    lc   = color.get("logCurve")          or _FAMILY_COLOR.get(family, ("unknown", "unknown", "Rec709"))[1]
    disp = color.get("displayTransform")  or "Rec709"

    is_accurate = engine in _ACCURATE_ENGINES if engine else False
    is_known    = family != "Generic" and cs != "unknown"

    if not is_known:
        mode  = "technical_preview"
        label = "Unknown / Technical Preview"
        technical = True
    elif is_accurate:
        mode  = "rec709_preview"
        label = f"{cs} → {lc} → {disp}"
        technical = False
    else:
        mode  = "rec709_preview"
        label = f"{family} {lc} → {disp} Preview"
        technical = True

    return {
        "cameraColorSpace": cs,
        "logCurve":         lc,
        "displayTransform": disp,
        "label":            label,
        "technical":        technical,
        "mode":             mode,
    }


def color_modes() -> list[dict]:
    """All available preview modes for the UI color mode selector."""
    return [
        {"id": "native_log",       "label": "Native Camera Log",    "desc": "Raw log output — no display transform"},
        {"id": "rec709_preview",   "label": "Rec709 Preview",        "desc": "Log → Rec709 (approximate)"},
        {"id": "aces_preview",     "label": "ACES Preview",          "desc": "IDT → ACEScct → Rec709"},
        {"id": "match_reference",  "label": "Match Reference QT",    "desc": "Visual match to reference proxy"},
        {"id": "lut_cdl",          "label": "Apply LUT / CDL",       "desc": "Show sidecar LUT or CDL if available"},
        {"id": "bypass",           "label": "Bypass Color",          "desc": "Raw pixel values, no transform"},
    ]
