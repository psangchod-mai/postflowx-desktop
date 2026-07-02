"""imf_conform.py — essence-descriptor ↔ codestream conformance checks.

Compares the metadata declared in the CPL / MXF essence descriptor (dimensions,
frame rate, codec) against what an actual probe of the essence reports, and flags
mismatches. This catches the common IMF authoring bug where the descriptor claims
one thing (e.g. 3840×2160 @ 24) but the wrapped codestream is another
(e.g. 1998×1080 @ 23.976), which many players silently mis-handle.

The probe side reuses the companion's existing ffprobe wrapper
(``media_engine.imf_engine.imf_probe.probe_cpl``) so we do not shell out to ffprobe
a second way. The whole comparison is pure once given the two dicts, so it is unit
testable with synthesized descriptor + probe dicts and no external media.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable


# ── codec normalisation ────────────────────────────────────────────────────────
# Map both CPL-side codec labels and ffprobe codec_name values to a canonical family
# so "JPEG 2000" (CPL) and "jpeg2000" (ffprobe) compare equal.

_CODEC_FAMILIES: dict[str, str] = {
    # JPEG 2000 / HTJ2K
    "jpeg 2000": "j2k",
    "jpeg2000": "j2k",
    "j2k": "j2k",
    "htj2k (jpeg 2000 part 15)": "j2k",
    "htj2k": "j2k",
    "ht_j2k": "j2k",
    # ProRes
    "prores": "prores",
    "apch": "prores",
    "apcn": "prores",
    "apcs": "prores",
    "apco": "prores",
    "ap4h": "prores",
    "ap4x": "prores",
    # Uncompressed / CDCI / RGBA
    "rgba (uncompressed)": "raw",
    "rawvideo": "raw",
    "cdci": "raw",
    "v210": "raw",
    "r210": "raw",
}


def canonical_codec(label: str) -> str:
    key = str(label or "").strip().lower()
    if not key:
        return ""
    if key in _CODEC_FAMILIES:
        return _CODEC_FAMILIES[key]
    # substring fallbacks
    for needle, fam in (
        ("prores", "prores"),
        ("jpeg 2000", "j2k"),
        ("jpeg2000", "j2k"),
        ("htj2k", "j2k"),
        ("j2k", "j2k"),
    ):
        if needle in key:
            return fam
    return key  # unknown → compare literally


def _to_int(value: Any) -> int | None:
    try:
        s = str(value).strip()
        if s in ("", "-", "–"):
            return None
        return int(float(s))
    except (TypeError, ValueError):
        return None


def _nonzero(value: int | None) -> int | None:
    return value if value else None


def _parse_fps(value: Any) -> float | None:
    """Accept a float, "24", "24/1", "24000/1001", or "24 1"."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if value else None
    s = str(value).strip()
    if not s or s in ("-", "–"):
        return None
    sep = "/" if "/" in s else (" " if " " in s else "")
    try:
        if sep:
            parts = s.split(sep)
            num = float(parts[0])
            den = float(parts[1]) if len(parts) > 1 else 1.0
            return num / den if den else None
        return float(s)
    except (ValueError, ZeroDivisionError):
        return None


# ── findings ────────────────────────────────────────────────────────────────

@dataclass
class ConformFinding:
    field_name: str
    severity: str          # "error" | "warning" | "info"
    declared: str
    actual: str
    message: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "field": self.field_name,
            "severity": self.severity,
            "declared": self.declared,
            "actual": self.actual,
            "message": self.message,
        }


@dataclass
class ConformResult:
    ok: bool = True
    checked: bool = True             # False when we could not probe the essence
    findings: list[ConformFinding] = field(default_factory=list)
    reason: str = ""                 # populated when checked=False

    def to_dict(self) -> dict[str, Any]:
        errors = [f for f in self.findings if f.severity == "error"]
        warnings = [f for f in self.findings if f.severity == "warning"]
        if not self.checked:
            status = "skip"
        elif errors:
            status = "fail"
        elif warnings:
            status = "warn"
        else:
            status = "pass"
        return {
            "ok": self.ok,
            "checked": self.checked,
            "reason": self.reason,
            "overallStatus": status,
            "errorCount": len(errors),
            "warningCount": len(warnings),
            "findings": [f.to_dict() for f in self.findings],
        }


# ── core comparison ─────────────────────────────────────────────────────────

def compare_descriptor_to_probe(
    descriptor: dict[str, Any],
    probe: dict[str, Any],
    *,
    fps_tolerance: float = 0.02,
) -> ConformResult:
    """Compare a CPL essence descriptor against an essence probe.

    ``descriptor`` uses the keys produced by imf_scan._parse_cpl:
        resolution={"w","h"}, editRate (float or str), codec (str).
    Also accepts flat keys width/height/frameRate for direct callers.

    ``probe`` uses the keys produced by imf_probe.probe_cpl:
        width, height, editRate (str "n/d"), pictureCodec.

    A missing / unknown value on either side is reported as an *info* finding (we
    cannot conform what we cannot read) rather than an error, so gaps never produce
    false failures.
    """
    result = ConformResult()

    # If the probe itself failed, we cannot conform anything.
    if not probe or probe.get("ok") is False:
        result.checked = False
        result.reason = str((probe or {}).get("error") or "essence probe unavailable")
        return result

    # ── dimensions ──
    res = descriptor.get("resolution") or {}
    # A dimension of 0 means "unknown" (ffprobe emits 0 for a stream it could not
    # size); treat it as missing so it becomes an info finding, not a false mismatch.
    decl_w = _nonzero(_to_int(descriptor.get("width", res.get("w"))))
    decl_h = _nonzero(_to_int(descriptor.get("height", res.get("h"))))
    act_w = _nonzero(_to_int(probe.get("width")))
    act_h = _nonzero(_to_int(probe.get("height")))

    _compare_int(result, "width", decl_w, act_w)
    _compare_int(result, "height", decl_h, act_h)

    # ── frame rate ──
    decl_fps = _parse_fps(descriptor.get("frameRate", descriptor.get("editRate")))
    act_fps = _parse_fps(probe.get("editRate", probe.get("frameRate")))
    _compare_fps(result, decl_fps, act_fps, fps_tolerance)

    # ── codec family ──
    decl_codec = canonical_codec(descriptor.get("codec", ""))
    act_codec = canonical_codec(probe.get("pictureCodec", probe.get("codec", "")))
    _compare_codec(result, decl_codec, act_codec,
                   str(descriptor.get("codec", "")), str(probe.get("pictureCodec", "")))

    result.ok = not any(f.severity == "error" for f in result.findings)
    return result


def _compare_int(result: ConformResult, name: str, decl: int | None, act: int | None) -> None:
    if decl is None or act is None:
        result.findings.append(ConformFinding(
            field_name=name, severity="info",
            declared="?" if decl is None else str(decl),
            actual="?" if act is None else str(act),
            message=f"{name} not available on both sides — not compared.",
        ))
        return
    if decl != act:
        result.findings.append(ConformFinding(
            field_name=name, severity="error",
            declared=str(decl), actual=str(act),
            message=(
                f"{name} mismatch: descriptor declares {decl}, "
                f"codestream reports {act}."
            ),
        ))


def _compare_fps(result: ConformResult, decl: float | None, act: float | None,
                 tol: float) -> None:
    if decl is None or act is None:
        result.findings.append(ConformFinding(
            field_name="frameRate", severity="info",
            declared="?" if decl is None else f"{decl:.3f}",
            actual="?" if act is None else f"{act:.3f}",
            message="frame rate not available on both sides — not compared.",
        ))
        return
    if abs(decl - act) > tol:
        result.findings.append(ConformFinding(
            field_name="frameRate", severity="error",
            declared=f"{decl:.3f}", actual=f"{act:.3f}",
            message=(
                f"frame-rate mismatch: descriptor declares {decl:.3f} fps, "
                f"codestream reports {act:.3f} fps."
            ),
        ))


def _compare_codec(result: ConformResult, decl_fam: str, act_fam: str,
                   decl_raw: str, act_raw: str) -> None:
    if not decl_fam or not act_fam:
        result.findings.append(ConformFinding(
            field_name="codec", severity="info",
            declared=decl_raw or "?", actual=act_raw or "?",
            message="codec not available on both sides — not compared.",
        ))
        return
    if decl_fam != act_fam:
        result.findings.append(ConformFinding(
            field_name="codec", severity="error",
            declared=decl_raw or decl_fam, actual=act_raw or act_fam,
            message=(
                f"codec mismatch: descriptor declares '{decl_raw or decl_fam}', "
                f"codestream is '{act_raw or act_fam}'."
            ),
        ))


# ── convenience wiring ───────────────────────────────────────────────────────

def check_cpl_conformance(
    cpl: dict[str, Any],
    cpl_path: str,
    assetmap_paths: list[str],
    *,
    probe_fn: Callable[[str, list[str]], dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Probe a CPL's picture essence and compare it to the CPL descriptor.

    ``cpl`` is the dict produced by imf_scan._parse_cpl. ``probe_fn`` defaults to
    imf_probe.probe_cpl (injectable for tests). Returns ConformResult.to_dict()
    with the cpl id/label attached. Never raises for missing tools — gates cleanly.
    """
    if probe_fn is None:
        try:
            from .media_engine.imf_engine.imf_probe import probe_cpl as probe_fn  # type: ignore
        except Exception as exc:  # pragma: no cover - import guard
            res = ConformResult(checked=False, reason=f"probe import failed: {exc}")
            out = res.to_dict()
            out["cplId"] = cpl.get("id", "")
            return out

    try:
        probe = probe_fn(cpl_path, assetmap_paths)
    except Exception as exc:
        res = ConformResult(checked=False, reason=f"probe raised: {exc}")
        out = res.to_dict()
        out["cplId"] = cpl.get("id", "")
        return out

    descriptor = {
        "resolution": cpl.get("resolution", {}),
        "editRate": cpl.get("editRate"),
        "codec": cpl.get("codec", ""),
    }
    result = compare_descriptor_to_probe(descriptor, probe)
    out = result.to_dict()
    out["cplId"] = cpl.get("id", "")
    out["contentTitle"] = cpl.get("contentTitle", "")
    return out
