"""imf_qc.py — Photon JAR runner for IMF conformance validation.

Mirrors JAR-discovery and output-parsing logic from electron/imf/imf_photon.js
so the Python companion can run Photon without depending on the Electron layer.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from . import safe_xml
from . import imf_mic
from . import imf_conform
from . import imf_scan

# ── JAR / Java discovery ──────────────────────────────────────────────────────

_PHOTON_SEARCH_PATHS = [
    os.environ.get("PFX_PHOTON_JAR", ""),
    str(Path.home() / ".postflowx" / "photon.jar"),
    str(Path.home() / "Library" / "Application Support" / "PostFlowX" / "photon.jar"),
    "/usr/local/share/postflowx/photon.jar",
    "/opt/homebrew/share/postflowx/photon.jar",
]

_JAVA_FALLBACK_PATHS = [
    "/opt/homebrew/bin/java",
    "/usr/local/bin/java",
    "/usr/bin/java",
    "/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home/bin/java",
]


def find_photon_jar() -> str | None:
    for p in _PHOTON_SEARCH_PATHS:
        if p and Path(p).is_file():
            return str(Path(p))
    return None


def find_java() -> str | None:
    java_home = os.environ.get("JAVA_HOME", "")
    if java_home:
        candidate = Path(java_home) / "bin" / "java"
        if candidate.is_file():
            return str(candidate)
    found = shutil.which("java")
    if found:
        return found
    for p in _JAVA_FALLBACK_PATHS:
        if Path(p).is_file():
            return p
    return None


# ── Output parsing ────────────────────────────────────────────────────────────

def _parse_photon_output(raw: str) -> list[dict[str, Any]]:
    """Parse Photon --printResults output into structured finding dicts."""
    findings: list[dict[str, Any]] = []

    # XML format: <ErrorObject severity="..." errorcode="...">message</ErrorObject>
    if "<ErrorObject" in raw:
        try:
            root = safe_xml.fromstring(f"<root>{raw}</root>")
            for el in root.iter("ErrorObject"):
                sev  = (el.get("severity") or "ERROR").upper()
                code = el.get("errorcode") or el.get("code") or ""
                msg  = (el.text or "").strip() or el.get("message") or ""
                if msg:
                    findings.append({"severity": sev, "code": code, "message": msg})
            return findings
        except (ET.ParseError, safe_xml.UnsafeXMLError):
            pass  # fall through to plain-text parsing

    # Plain-text: "ERROR : code : message" or "ERROR: message"
    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        m = re.match(
            r"^(FATAL|ERROR|WARNING|WARN|INFO)\s*:?\s*(.+)$", line, re.IGNORECASE
        )
        if not m:
            continue
        sev_raw = m.group(1).upper()
        rest    = m.group(2).strip()
        parts   = [p.strip() for p in rest.split(" : ", 1)]
        if len(parts) == 2 and len(parts[0]) < 60:
            code, msg = parts
        else:
            code, msg = "", rest
        sev = (
            "ERROR"   if sev_raw in ("FATAL", "ERROR") else
            "WARNING" if sev_raw in ("WARNING", "WARN") else
            "INFO"
        )
        findings.append({"severity": sev, "code": code, "message": msg})

    return findings


# ── Plain-language summaries ──────────────────────────────────────────────────

_KNOWN_CODES: dict[str, str] = {
    "IMF_CORE_CONSTRAINTS_ERROR": (
        "This package violates a core IMF constraint required by all App profiles."
    ),
    "PKL_HASH_ERROR": (
        "A file's hash doesn't match the value stored in the Packing List. "
        "The file may be corrupt or was modified after delivery."
    ),
    "CPL_SEQUENCE_ERROR": (
        "The Composition Playlist contains an invalid sequence; "
        "playout order may be incorrect."
    ),
    "ASSET_NOT_FOUND": (
        "A file listed in the Packing List or Asset Map is missing from the package."
    ),
    "XML_PARSE_ERROR": (
        "An XML document (CPL, PKL, or Asset Map) is malformed or truncated."
    ),
    "HEADER_PARTITION_ERROR": (
        "An MXF file's header partition is invalid or unreadable."
    ),
    "INDEX_TABLE_ERROR": (
        "The MXF index table is corrupt; frame-accurate seeking may fail."
    ),
    "ESSENCE_DESCRIPTOR_ERROR": (
        "The MXF essence descriptor doesn't match the actual essence data."
    ),
    "TIMECODE_ERROR": (
        "The timecode in the MXF file is inconsistent with the CPL."
    ),
}


def _plain_language(finding: dict[str, Any]) -> str:
    code   = finding.get("code", "")
    msg    = finding.get("message", "")
    if code in _KNOWN_CODES:
        return _KNOWN_CODES[code]
    lowmsg = msg.lower()
    if "hash" in lowmsg or "checksum" in lowmsg:
        return "A file's checksum doesn't match. It may be corrupt or altered after packaging."
    if "missing" in lowmsg or "not found" in lowmsg:
        return "A file referenced in the package metadata is missing. Check that all essence files are present."
    if "mxf" in lowmsg and ("header" in lowmsg or "partition" in lowmsg):
        return "An MXF file's header or partition structure is invalid."
    if "xml" in lowmsg or "parse" in lowmsg:
        return "An XML metadata file is malformed."
    if "sequence" in lowmsg or "cpl" in lowmsg:
        return "The Composition Playlist structure has an error."
    return msg


# ── Embedded essence-hash (MIC) verification ────────────────────────────────────

def _find_mxf_files(folder_path: str, limit: int = 512) -> list[str]:
    """Return MXF track files inside an IMF package folder (bounded)."""
    root = Path(folder_path)
    if not root.is_dir():
        return []
    found: list[str] = []
    try:
        for p in sorted(root.rglob("*")):
            if p.is_file() and p.suffix.lower() == ".mxf":
                found.append(str(p))
                if len(found) >= limit:
                    break
    except OSError:
        pass
    return found


def verify_essence_mic(folder_path: str) -> dict[str, Any]:
    """Verify the embedded EssenceIntegrityPack (MIC) of every MXF in the package.

    This complements the PKL SHA hash checks (which compare each file against an
    *external* hash in the Packing List) by verifying the essence digest that is
    *embedded inside* the MXF itself. Gates cleanly (never raises) so a package
    without embedded MICs simply reports overallStatus="skip".
    """
    mxf_files = _find_mxf_files(folder_path)
    roll = imf_mic.verify_mic_for_assets(mxf_files)
    roll["mxfFileCount"] = len(mxf_files)
    if roll["failed"] > 0:
        roll["summary"] = (
            f"{roll['failed']} MXF essence integrity failure(s) "
            f"({roll['passed']} verified OK)."
        )
    elif roll["checked"] > 0:
        roll["summary"] = f"{roll['passed']} MXF essence MIC(s) verified OK."
    elif not mxf_files:
        roll["summary"] = "No MXF track files found — MIC check skipped."
    else:
        roll["summary"] = "No embedded essence MICs present — MIC check skipped."
    return roll


def _mic_findings(mic: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert a MIC rollup into Photon-style finding dicts (only failures)."""
    findings: list[dict[str, Any]] = []
    for res in mic.get("results", []):
        # Only failed, present MICs become ERROR findings; absent/unreadable are
        # not conformance errors here (external PKL hash covers presence/corruption).
        if res.get("present") and res.get("ok") is False:
            name = Path(str(res.get("path") or "")).name
            findings.append({
                "severity":    "ERROR",
                "code":        "ESSENCE_MIC_ERROR",
                "message":     f"{name}: {res.get('error') or 'essence integrity check failed'}",
                "userMessage": (
                    "An MXF file's embedded essence hash (MIC) does not match the "
                    "essence data. The file may be corrupt or was modified after "
                    "packaging."
                ),
            })
    return findings


def verify_essence_conformance(folder_path: str) -> dict[str, Any]:
    """Compare each CPL's essence descriptor to the actual probed codestream.

    Complements the MIC/PKL hash checks by catching a descriptor that disagrees
    with the real J2K/MXF essence (wrong dimensions, frame rate, or codec family).
    Gates cleanly (never raises): if the essence can't be probed (e.g. no
    IMF-capable ffprobe), each CPL reports status="skip".
    """
    out: dict[str, Any] = {
        "overallStatus": "skip", "checked": 0, "passed": 0,
        "failed": 0, "skipped": 0, "results": [], "summary": "",
    }
    try:
        folder = Path(folder_path).expanduser()
        assetmaps = [str(p) for p in folder.rglob("*.xml")
                     if p.name.upper().startswith("ASSETMAP")]
        cpl_paths: list[Path] = []
        for p in folder.rglob("*.xml"):
            try:
                head = p.read_text(encoding="utf-8", errors="ignore")[:4096]
            except Exception:
                continue
            if "CompositionPlaylist" in head and "PackingList" not in head and "AssetMap" not in head:
                cpl_paths.append(p)
    except Exception as exc:
        out["reason"] = str(exc)
        return out

    for cpl_path in cpl_paths:
        try:
            cpl = imf_scan._parse_cpl(cpl_path)
        except Exception:
            continue
        try:
            res = imf_conform.check_cpl_conformance(cpl, str(cpl_path), assetmaps)
        except Exception as exc:
            res = {"status": "skip", "cplId": cpl.get("id", ""), "reason": str(exc), "findings": []}
        out["results"].append(res)
        status = res.get("overallStatus")
        if status == "fail":
            out["failed"] += 1; out["checked"] += 1
        elif status in ("pass", "warn"):
            out["passed"] += 1; out["checked"] += 1
        else:
            out["skipped"] += 1

    if out["failed"] > 0:
        out["overallStatus"] = "fail"
        out["summary"] = f"{out['failed']} CPL descriptor/codestream mismatch(es) ({out['passed']} conform)."
    elif out["checked"] > 0:
        out["overallStatus"] = "pass"
        out["summary"] = f"{out['checked']} CPL(s) conform to the probed essence."
    else:
        out["summary"] = "Essence could not be probed — conformance check skipped."
    return out


def _conform_findings(conf: dict[str, Any]) -> list[dict[str, Any]]:
    """Convert a conformance rollup into Photon-style finding dicts (only mismatches)."""
    findings: list[dict[str, Any]] = []
    for res in conf.get("results", []):
        if res.get("overallStatus") != "fail":
            continue
        cid = res.get("cplId") or ""
        for f in res.get("findings", []):
            if f.get("severity") != "error":
                continue
            findings.append({
                "severity":    "ERROR",
                "code":        "ESSENCE_DESCRIPTOR_MISMATCH",
                "message":     f"{cid}: {f.get('message') or 'descriptor does not match codestream'}",
                "userMessage": (
                    "A CPL essence descriptor (dimensions, frame rate, or codec) does "
                    "not match the actual media. The descriptor may be wrong or the "
                    "essence was re-encoded after the CPL was authored."
                ),
            })
    return findings


# ── Main runner ───────────────────────────────────────────────────────────────

def run_photon(folder_path: str, timeout_s: int = 120) -> dict[str, Any]:
    """
    Run Netflix Photon against an IMF package folder.

    Returns a dict with keys:
        ok, javaAvailable, photonAvailable, findings, overallStatus, summary, rawOutput, error
    """
    java = find_java()
    jar  = find_photon_jar()

    # Embedded essence-hash (MIC) verification and essence-descriptor conformance
    # both run independently of Photon so they are always attempted, even when
    # Java / photon.jar are unavailable.
    mic  = verify_essence_mic(folder_path)
    conf = verify_essence_conformance(folder_path)

    base: dict[str, Any] = {
        "ok":              False,
        "javaAvailable":   java is not None,
        "photonAvailable": jar  is not None,
        "findings":        [],
        "overallStatus":   "fail",
        "summary":         "",
        "rawOutput":       "",
        "error":           None,
        "mic":             mic,
        "conformance":     conf,
    }

    # Surface embedded-MIC failures AND descriptor/codestream mismatches as
    # first-class findings regardless of Photon availability.
    mic_findings = _mic_findings(mic) + _conform_findings(conf)

    if not java:
        base["error"]   = "Java not found. Install a JRE (e.g. brew install openjdk)."
        base["summary"] = "Java runtime not available — Photon validation skipped."
        base["findings"] = mic_findings
        if mic.get("overallStatus") == "fail":
            base["summary"] += f" {mic.get('summary', '')}".rstrip()
        return base

    if not jar:
        base["error"]   = (
            "photon.jar not found. Place it at ~/.postflowx/photon.jar "
            "or set the PFX_PHOTON_JAR environment variable."
        )
        base["summary"] = "Photon JAR not found — validation skipped."
        base["findings"] = mic_findings
        if mic.get("overallStatus") == "fail":
            base["summary"] += f" {mic.get('summary', '')}".rstrip()
        return base

    try:
        proc = subprocess.run(
            [java, "-jar", jar, "-i", folder_path, "--printResults"],
            capture_output=True,
            text=True,
            timeout=timeout_s,
        )
        raw = (proc.stdout or "") + (proc.stderr or "")
    except subprocess.TimeoutExpired:
        base["error"]   = f"Photon timed out after {timeout_s}s."
        base["summary"] = "Photon validation timed out."
        base["findings"] = mic_findings
        return base
    except Exception as exc:
        base["error"]   = f"Photon failed to start: {exc}"
        base["summary"] = "Photon could not be launched."
        base["findings"] = mic_findings
        return base

    findings_raw = _parse_photon_output(raw)
    findings = [{**f, "userMessage": _plain_language(f)} for f in findings_raw]
    # Fold embedded-MIC findings into the same list so the UI shows one unified set.
    findings = findings + mic_findings

    errors   = [f for f in findings if f["severity"] in ("ERROR", "FATAL")]
    warnings = [f for f in findings if f["severity"] == "WARNING"]

    if errors:
        overall = "fail"
        summary = f"{len(errors)} error(s), {len(warnings)} warning(s)."
    elif warnings:
        overall = "warn"
        summary = f"No errors — {len(warnings)} warning(s)."
    else:
        overall = "pass"
        summary = "Package passed Photon conformance validation."

    return {
        **base,
        "ok":            True,
        "findings":      findings,
        "overallStatus": overall,
        "summary":       summary,
        "rawOutput":     raw,
        "error":         None,
    }
