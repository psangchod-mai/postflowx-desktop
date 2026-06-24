"""color_lut.py — Camera log → ACES2065-1 IDT 3D LUT generator.

Generates .cube 3D LUT files for common camera log/gamut combinations.
LUTs are written to a cache directory on first use and reused afterwards.
ffmpeg's ``lut3d`` filter applies them at SIMD speed; Python only runs the
33^3 table walk once per camera family per session.

Mathematical sources:
  ARRI LogC3 EI800 : ARRI Document DS-11_2_E (White Paper)
  ARRI LogC4       : ARRI Alexa 35 Workflow Guide
  RED Log3G10/IPP2 : RED Log3G10 Technical Primer
  Sony S-Log3      : Sony Technical Summary for S-Gamut3.Cine/S-Log3
  Gamut matrices   : Academy ACES CLF / CTL IDT reference transforms
"""
from __future__ import annotations

import math
import os
from pathlib import Path
from typing import Callable, Optional

# ── Constants ─────────────────────────────────────────────────────────────────

LUT_SIZE = 33           # 33^3 = 35 937 entries; good balance of accuracy vs size
_CACHE: dict[str, str] = {}    # camera_family → resolved .cube path


# ── 3×3 matrix multiply ───────────────────────────────────────────────────────

def _mat3(m: list[list[float]], r: float, g: float, b: float) -> tuple[float, float, float]:
    return (
        m[0][0]*r + m[0][1]*g + m[0][2]*b,
        m[1][0]*r + m[1][1]*g + m[1][2]*b,
        m[2][0]*r + m[2][1]*g + m[2][2]*b,
    )


# ── ARRI LogC3 (Alexa, EI800) → scene linear → ACES2065-1 ───────────────────
# Encoding constants from ARRI DS-11_2_E LogC White Paper (Table 3, EI 800).

_LC3_CUT = 0.010591
_LC3_A   = 5.555556
_LC3_B   = 0.052272
_LC3_C   = 0.247190
_LC3_D   = 0.385537
_LC3_E   = 5.367655
_LC3_F   = 0.092809

def _logc3_to_lin(e: float) -> float:
    if e > _LC3_E * _LC3_CUT + _LC3_F:
        return (10.0 ** ((e - _LC3_D) / _LC3_C) - _LC3_B) / _LC3_A
    return (e - _LC3_F) / _LC3_E

# AWG3 → ACES AP0 matrix (Academy IDT.ARRI.Alexa-v3-LogC-EI800 CLF).
_AWG3_TO_AP0 = [
    [ 0.6954522414, 0.1406777469, 0.1638700117],
    [ 0.0447945639, 0.8596711490, 0.0955342871],
    [-0.0055258826, 0.0080477881, 0.9974780945],
]

def _logc3_to_aces(e: float, _: float, __: float) -> tuple[float, float, float]:
    """Apply LogC3 linearisation then AWG3→AP0 matrix (monochrome; caller loops per channel)."""
    lin = _logc3_to_lin(e)
    return lin, lin, lin   # matrix applied in the 3-channel path below


def _logc3_rgb_to_aces(er: float, eg: float, eb: float) -> tuple[float, float, float]:
    lr, lg, lb = _logc3_to_lin(er), _logc3_to_lin(eg), _logc3_to_lin(eb)
    return _mat3(_AWG3_TO_AP0, lr, lg, lb)


# ── ARRI LogC4 (Alexa 35) → scene linear → ACES2065-1 ───────────────────────
# Formula from ARRI Alexa 35 LogC4 Specification.
# Decode: x = (2^(e·18 − 4) − 2^−4) / (2^14 − 2^−4)

_LC4_B   = 2.0 ** -4          # 0.0625
_LC4_NUM = 2.0 ** 14 - _LC4_B  # ≈ 16383.9375

def _logc4_to_lin(e: float) -> float:
    return max(0.0, (2.0 ** (e * 18.0 - 4.0) - _LC4_B) / _LC4_NUM)

# AWG4 → ACES AP0 matrix (from ARRI Alexa 35 documentation, rev. 2023).
_AWG4_TO_AP0 = [
    [ 0.7509573628, 0.1444227866, 0.1046198506],
    [ 0.0212438586, 1.0056592934,-0.0269031520],
    [-0.0029050959, 0.0151796710, 0.9877254248],
]

def _logc4_rgb_to_aces(er: float, eg: float, eb: float) -> tuple[float, float, float]:
    lr, lg, lb = _logc4_to_lin(er), _logc4_to_lin(eg), _logc4_to_lin(eb)
    return _mat3(_AWG4_TO_AP0, lr, lg, lb)


# ── RED Log3G10 / IPP2 → scene linear → ACES2065-1 ──────────────────────────
# From RED Log3G10 Technical Primer.
# Decode: lin = sign(e) · (10^(|e| / 0.224282) − 1) / 155.975327

_L3G10_DIV = math.log10(155.975327 + 1.0)   # ≈ 2.193

def _log3g10_to_lin(e: float) -> float:
    if e >= 0.0:
        return (10.0 ** (e / 0.224282) - 1.0) / 155.975327
    return -(10.0 ** (-e / 0.224282) - 1.0) / 155.975327

# RWG → ACES AP0 matrix (Academy ACES CLF IDT for RED IPP2).
_RWG_TO_AP0 = [
    [ 0.7350, 0.0681, 0.1969],
    [ 0.0291, 0.9456, 0.0253],
    [-0.0092,-0.0474, 1.0566],
]

def _log3g10_rgb_to_aces(er: float, eg: float, eb: float) -> tuple[float, float, float]:
    lr, lg, lb = _log3g10_to_lin(er), _log3g10_to_lin(eg), _log3g10_to_lin(eb)
    return _mat3(_RWG_TO_AP0, lr, lg, lb)


# ── Sony S-Log3 / S-Gamut3 → scene linear → ACES2065-1 ──────────────────────
# From Sony Technical Summary for S-Gamut3.Cine/S-Log3.

_SLOG3_CUT_ENC = 171.2102946929 / 1023.0  # ≈ 0.1674

def _slog3_to_lin(e: float) -> float:
    if e >= _SLOG3_CUT_ENC:
        return 10.0 ** ((e * 1023.0 - 420.0) / 261.5) * 0.19 - 0.01
    return (e * 1023.0 - 95.0) / (171.2102946929 - 95.0) * 0.01125

# S-Gamut3 → ACES AP0 matrix (Academy ACES CLF IDT.Sony.Slog3.Sgamut3).
_SGAMUT3_TO_AP0 = [
    [ 0.7529, 0.1447, 0.1024],
    [ 0.0218, 0.9798,-0.0016],
    [-0.0072, 0.0341, 0.9731],
]

def _slog3_rgb_to_aces(er: float, eg: float, eb: float) -> tuple[float, float, float]:
    lr, lg, lb = _slog3_to_lin(er), _slog3_to_lin(eg), _slog3_to_lin(eb)
    return _mat3(_SGAMUT3_TO_AP0, lr, lg, lb)


# ── Canon C-Log2 / C-Gamut → scene linear → ACES2065-1 ──────────────────────
# From Canon C-Log2 Conversion Characteristics white paper.

_CLOG2_CUT_DEC = -0.00218

def _clog2_to_lin(e: float) -> float:
    if e > _CLOG2_CUT_DEC:
        return (10.0 ** ((e - 0.092864125) / 0.24136) - 1.0) / 87.099375
    return -(10.0 ** ((-e + 0.092864125) / 0.24136) - 1.0) / 87.099375

# C-Gamut → ACES AP0 matrix (Academy ACES CLF IDT.Canon.CLog2.CGamut).
_CGAMUT_TO_AP0 = [
    [ 0.7637, 0.0453, 0.1910],
    [ 0.0072, 0.9699, 0.0229],
    [ 0.0003,-0.0194, 1.0191],
]

def _clog2_rgb_to_aces(er: float, eg: float, eb: float) -> tuple[float, float, float]:
    lr, lg, lb = _clog2_to_lin(er), _clog2_to_lin(eg), _clog2_to_lin(eb)
    return _mat3(_CGAMUT_TO_AP0, lr, lg, lb)


# ── Panasonic V-Log / V-Gamut → scene linear → ACES2065-1 ───────────────────
# From Panasonic V-Log/V-Gamut Encoding Characteristics white paper.

_VLOG_CUT1 = 0.01   # linear cut
_VLOG_CUT2 = 0.181  # encoded cut
_VLOG_B    = 0.00873
_VLOG_C    = 0.241514
_VLOG_D    = 0.598206

def _vlog_to_lin(e: float) -> float:
    if e >= _VLOG_CUT2:
        return 10.0 ** ((e - _VLOG_D) / _VLOG_C) - _VLOG_B
    return (e - 0.125) / 5.6

# V-Gamut → ACES AP0 matrix (Academy ACES CLF IDT.Panasonic.VLog.VGamut).
_VGAMUT_TO_AP0 = [
    [ 0.7258, 0.1394, 0.1348],
    [ 0.0238, 0.9617, 0.0145],
    [-0.0094,-0.0420, 1.0514],
]

def _vlog_rgb_to_aces(er: float, eg: float, eb: float) -> tuple[float, float, float]:
    lr, lg, lb = _vlog_to_lin(er), _vlog_to_lin(eg), _vlog_to_lin(eb)
    return _mat3(_VGAMUT_TO_AP0, lr, lg, lb)


# ── Registry ──────────────────────────────────────────────────────────────────

# Maps camera family key → (title, rgb_to_aces_fn)
_TRANSFORMS: dict[str, tuple[str, Callable[[float, float, float], tuple[float, float, float]]]] = {
    "arri_logc3": ("ARRI LogC3 EI800 - AWG3 to ACES2065-1", _logc3_rgb_to_aces),
    "arri_logc4": ("ARRI LogC4 - AWG4 to ACES2065-1",       _logc4_rgb_to_aces),
    "red_log3g10": ("RED Log3G10 IPP2 - RWG to ACES2065-1",  _log3g10_rgb_to_aces),
    "sony_slog3":  ("Sony S-Log3 - S-Gamut3 to ACES2065-1",  _slog3_rgb_to_aces),
    "canon_clog2": ("Canon C-Log2 - C-Gamut to ACES2065-1",  _clog2_rgb_to_aces),
    "panasonic_vlog": ("Panasonic V-Log - V-Gamut to ACES2065-1", _vlog_rgb_to_aces),
}


# ── LUT file generation ───────────────────────────────────────────────────────

def _write_cube(path: str, title: str,
                fn: Callable[[float, float, float], tuple[float, float, float]],
                size: int = LUT_SIZE) -> None:
    """Write a .cube 3D LUT file applying ``fn`` at each lattice point."""
    step = 1.0 / (size - 1)
    lines = [
        f'TITLE "{title}"',
        f"LUT_3D_SIZE {size}",
        "DOMAIN_MIN 0.0 0.0 0.0",
        "DOMAIN_MAX 1.0 1.0 1.0",
        "",
    ]
    # .cube iteration order: B varies fastest, then G, then R.
    for ri in range(size):
        r = ri * step
        for gi in range(size):
            g = gi * step
            for bi in range(size):
                b = bi * step
                or_, og, ob = fn(r, g, b)
                lines.append(f"{or_:.6f} {og:.6f} {ob:.6f}")

    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


# ── Public API ────────────────────────────────────────────────────────────────

def camera_family_key(idtName: str) -> Optional[str]:
    """Map a colorPlanEngine idtName string to a registry key, or None."""
    name = (idtName or "").lower()
    if "logc4" in name or "log-c4" in name or "log c4" in name or "alexa 35" in name:
        return "arri_logc4"
    if "logc3" in name or "log-c3" in name or "log-c " in name or "logc " in name or "arri" in name or "alexa" in name:
        return "arri_logc3"
    if "log3g10" in name or "ipp2" in name or "red" in name or "rwg" in name:
        return "red_log3g10"
    if "s-log3" in name or "slog3" in name or "sony" in name or "s-gamut3" in name or "sgamut3" in name:
        return "sony_slog3"
    if "c-log2" in name or "clog2" in name or "canon" in name:
        return "canon_clog2"
    if "v-log" in name or "vlog" in name or "panasonic" in name or "v-gamut" in name:
        return "panasonic_vlog"
    return None


def get_idt_lut_path(idtName: str, lut_dir: str) -> Optional[str]:
    """
    Return the path to a cached .cube IDT LUT for the given idtName, generating
    it on first call. Returns None if no transform is known for idtName.

    Args:
        idtName:  The idtName string from colorPlanEngine (e.g. "ARRI LogC4").
        lut_dir:  Directory where .cube files are cached.

    Returns:
        Absolute path to the .cube file, or None.
    """
    key = camera_family_key(idtName)
    if key is None:
        return None
    if key in _CACHE:
        return _CACHE[key]
    entry = _TRANSFORMS.get(key)
    if entry is None:
        return None
    title, fn = entry
    os.makedirs(lut_dir, exist_ok=True)
    path = os.path.join(lut_dir, f"idt_{key}.cube")
    if not os.path.isfile(path):
        _write_cube(path, title, fn)
    _CACHE[key] = path
    return path


def supported_families() -> list[str]:
    """Return the list of camera family keys that have a known IDT transform."""
    return list(_TRANSFORMS.keys())
