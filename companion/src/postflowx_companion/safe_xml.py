"""safe_xml.py — XXE-hardened XML parsing for untrusted IMF packages.

SMPTE IMF XML (CPL / PKL / ASSETMAP) never legitimately contains a DOCTYPE or
entity declaration. So we reject any document that does, BEFORE handing it to the
stdlib parser. Rejecting the DTD/entity declaration at the source blocks both:

  * external-entity injection (classic XXE — file/network read via `&xxe;`), and
  * internal entity-expansion ("billion laughs" / quadratic-blowup DoS),

because both attacks require a `<!DOCTYPE>` / `<!ENTITY>` declaration to exist.
This needs NO third-party dependency (the companion runs on the user's system
python3, where defusedxml may be absent). If defusedxml *is* installed we layer
it on for defence-in-depth.

Use `fromstring()` / `read_xml()` / `parse_path()` instead of calling
`xml.etree.ElementTree` directly anywhere untrusted XML is parsed.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as _ET
from pathlib import Path

# Strip comments first so a harmless "<!-- <!DOCTYPE ... -->" doesn't trip the
# guard. CDATA-wrapped declarations are vanishingly rare in IMF XML and a
# fail-closed rejection there is acceptable (security > a weird valid file).
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)
_DOCTYPE_RE = re.compile(r"<!DOCTYPE", re.IGNORECASE)
_ENTITY_RE = re.compile(r"<!ENTITY", re.IGNORECASE)

# Best-effort defence-in-depth if the package happens to ship defusedxml.
try:  # pragma: no cover - depends on the host environment
    from defusedxml.ElementTree import fromstring as _defused_fromstring  # type: ignore
except Exception:  # pragma: no cover
    _defused_fromstring = None


class UnsafeXMLError(ValueError):
    """Raised when XML carries a DOCTYPE/ENTITY declaration (potential XXE)."""


def _guard(text: str) -> None:
    scan = _COMMENT_RE.sub("", text)
    if _DOCTYPE_RE.search(scan) or _ENTITY_RE.search(scan):
        raise UnsafeXMLError(
            "XML contains a DOCTYPE/ENTITY declaration and was refused "
            "(XXE / entity-expansion protection)."
        )


def fromstring(text: str) -> _ET.Element:
    """Parse XML from a string after rejecting any DTD/entity declaration."""
    _guard(text)
    if _defused_fromstring is not None:
        return _defused_fromstring(text)
    return _ET.fromstring(text)


def read_xml(path: str | Path) -> tuple[str, _ET.Element]:
    """Read a file and return (raw_text, root_element), XXE-guarded."""
    text = Path(path).read_text(encoding="utf-8", errors="ignore")
    return text, fromstring(text)


def parse_path(path: str | Path) -> _ET.ElementTree:
    """Drop-in for ET.parse(path) that is XXE-guarded."""
    _, root = read_xml(path)
    return _ET.ElementTree(root)
