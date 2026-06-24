"""
conform_engine.py — PostFlowX Trailer Conform Engine

Phase 1: Resolve generates analysis proxies + WAV; Python matches events to sources.
Phase 3: Resolve builds conformed timeline; renders review QT; PFX exports EDL/FCPXML/OTIO/CSV.

Session state keys written throughout:
  step, pct, message, events (list), proxies (list), matches (list),
  _result (final), done (bool), error (str)
"""
from __future__ import annotations

import csv
import io
import json
import math
import os
import re
import struct
import sys
import tempfile
import threading
import time
import traceback
import unicodedata
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..service_state import create_session, get_session, update_session


# ── Progress steps ─────────────────────────────────────────────────────────────
ANALYZE_STEPS = {
    "idle":              0,
    "parse_edit":       10,
    "render_proxies":   20,   # 20→65 while rendering
    "correlate":        68,
    "score":            85,
    "complete":        100,
}
BUILD_STEPS = {
    "idle":              0,
    "validate":         10,
    "connect":          20,
    "create_project":   30,
    "import_media":     45,
    "build_timeline":   60,
    "render_review":    75,   # 75→92 during render
    "export":           93,
    "complete":        100,
}

SUPPORTED_SOURCE_EXTENSIONS = frozenset({
    ".mov", ".mp4", ".mxf", ".avi", ".mkv", ".m4v",
    ".r3d", ".arx", ".braw", ".dng", ".ari", ".crm",
})


# ── Session helpers ────────────────────────────────────────────────────────────

def _upd(session_id: str, step: str, pct: int, msg: str, **extra: Any) -> None:
    update_session(session_id, step=step, pct=min(100, max(0, pct)), message=msg, **extra)


def _finish(session_id: str, result: dict) -> None:
    update_session(
        session_id,
        done=True,
        _result=result,
        pct=100 if result.get("status") == "ok" else 0,
    )


def _fail_session(session_id: str, code: str, msg: str) -> dict:
    result = {"status": "error", "error": {"code": code, "message": msg}}
    _finish(session_id, result)
    return result


# ══════════════════════════════════════════════════════════════════════════════
# EDIT FILE PARSERS
# ══════════════════════════════════════════════════════════════════════════════

class ConformEvent:
    __slots__ = ("index", "reel", "clip_name", "src_in", "src_out", "rec_in", "rec_out",
                 "duration_frames", "fps", "track", "comment")

    def __init__(self, **kw: Any) -> None:
        for k, v in kw.items():
            setattr(self, k, v)

    def to_dict(self) -> dict:
        return {s: getattr(self, s, None) for s in self.__slots__}


def _tc_to_frames(tc: str, fps: float) -> int:
    """Convert SMPTE timecode to absolute frame count."""
    tc = tc.strip().replace(";", ":")
    parts = tc.split(":")
    if len(parts) != 4:
        return 0
    try:
        h, m, s, f = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
        return int(round(fps)) * (h * 3600 + m * 60 + s) + f
    except ValueError:
        return 0


def _frames_to_tc(frames: int, fps: float) -> str:
    ifps = max(1, int(round(fps)))
    f = frames % ifps
    total_secs = frames // ifps
    s = total_secs % 60
    m = (total_secs // 60) % 60
    h = total_secs // 3600
    return f"{h:02d}:{m:02d}:{s:02d}:{f:02d}"


def parse_edl(text: str, fps: float = 24.0) -> list[ConformEvent]:
    """Parse a CMX3600 EDL into ConformEvent list."""
    events: list[ConformEvent] = []
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        # Event line: "001  REEL  V  C  <src_in> <src_out> <rec_in> <rec_out>"
        m = re.match(
            r"^(\d{3,4})\s+(\S+)\s+\S+\s+C\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)",
            line,
        )
        if m:
            idx = int(m.group(1))
            reel = m.group(2)
            src_in = m.group(3)
            src_out = m.group(4)
            rec_in = m.group(5)
            rec_out = m.group(6)
            fi = _tc_to_frames(src_in, fps)
            fo = _tc_to_frames(src_out, fps)
            # Look ahead for * FROM CLIP NAME: ...
            clip_name = reel
            j = i + 1
            while j < len(lines) and j < i + 5:
                nxt = lines[j].strip()
                cm = re.match(r"^\*\s+FROM CLIP NAME:\s+(.+)", nxt, re.IGNORECASE)
                if cm:
                    clip_name = cm.group(1).strip()
                    break
                j += 1
            events.append(ConformEvent(
                index=idx, reel=reel, clip_name=clip_name,
                src_in=src_in, src_out=src_out,
                rec_in=rec_in, rec_out=rec_out,
                duration_frames=max(0, fo - fi),
                fps=fps, track="V", comment="",
            ))
        i += 1
    return events


def parse_fcpxml(text: str) -> list[ConformEvent]:
    """Parse FCP 7 XML or FCPXML sequence into ConformEvent list."""
    events: list[ConformEvent] = []
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return events

    # Try FCP 7 style (<sequence>/<media>/<video>/<track>/<clipitem>)
    ns = {"": ""}
    idx = 1
    for clipitem in root.iter("clipitem"):
        name_el = clipitem.find("name")
        file_el = clipitem.find("file")
        in_el  = clipitem.find("in")
        out_el = clipitem.find("out")
        st_el  = clipitem.find("start")
        end_el = clipitem.find("end")
        rate_el = clipitem.find(".//rate/timebase")
        fps = float(rate_el.text) if rate_el is not None and rate_el.text else 24.0
        clip_name = name_el.text if name_el is not None and name_el.text else f"clip_{idx}"
        reel = clip_name
        if file_el is not None:
            fn_el = file_el.find("name")
            if fn_el is not None and fn_el.text:
                reel = fn_el.text
        try:
            src_in = int(in_el.text) if in_el is not None and in_el.text else 0
            src_out = int(out_el.text) if out_el is not None and out_el.text else 0
            rec_in = int(st_el.text) if st_el is not None and st_el.text else 0
            rec_out = int(end_el.text) if end_el is not None and end_el.text else 0
        except (ValueError, TypeError):
            idx += 1
            continue
        events.append(ConformEvent(
            index=idx, reel=reel, clip_name=clip_name,
            src_in=_frames_to_tc(src_in, fps), src_out=_frames_to_tc(src_out, fps),
            rec_in=_frames_to_tc(rec_in, fps), rec_out=_frames_to_tc(rec_out, fps),
            duration_frames=max(0, src_out - src_in),
            fps=fps, track="V", comment="",
        ))
        idx += 1
    return events


def parse_otio(text: str) -> list[ConformEvent]:
    """Parse OpenTimelineIO JSON into ConformEvent list."""
    events: list[ConformEvent] = []
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return events
    idx = 1
    tracks = []
    # OTIO: {"OTIO_SCHEMA":"Timeline.1","tracks":{"children":[...]}}
    tracks_node = data.get("tracks") or {}
    for track_node in (tracks_node.get("children") or []):
        if track_node.get("OTIO_SCHEMA", "").startswith("Track"):
            for child in (track_node.get("children") or []):
                schema = child.get("OTIO_SCHEMA", "")
                if not schema.startswith("Clip"):
                    continue
                name = child.get("name") or f"clip_{idx}"
                src_range = child.get("source_range") or {}
                try:
                    fps = float(
                        src_range.get("start_time", {}).get("rate", 24)
                        or src_range.get("duration", {}).get("rate", 24)
                    )
                    si = float(src_range.get("start_time", {}).get("value", 0))
                    dur = float(src_range.get("duration", {}).get("value", 0))
                except (TypeError, ValueError):
                    fps, si, dur = 24.0, 0.0, 0.0
                events.append(ConformEvent(
                    index=idx, reel=name, clip_name=name,
                    src_in=_frames_to_tc(int(si), fps),
                    src_out=_frames_to_tc(int(si + dur), fps),
                    rec_in="", rec_out="",
                    duration_frames=int(dur),
                    fps=fps, track="V", comment="",
                ))
                idx += 1
    return events


def parse_edit_file(path: str, fmt: str | None = None, fps: float = 24.0) -> list[ConformEvent]:
    """Auto-detect and parse an edit file. Returns list of ConformEvent."""
    p = Path(path)
    text = p.read_text(encoding="utf-8", errors="replace")
    if fmt is None:
        ext = p.suffix.lower()
        if ext in (".edl",):
            fmt = "edl"
        elif ext in (".xml", ".fcpxml"):
            fmt = "fcpxml"
        elif ext in (".json", ".otio"):
            fmt = "otio"
        else:
            # Sniff
            stripped = text.lstrip()
            if stripped.startswith("<"):
                fmt = "fcpxml"
            elif stripped.startswith("{"):
                fmt = "otio"
            else:
                fmt = "edl"
    if fmt == "edl":
        return parse_edl(text, fps)
    if fmt == "fcpxml":
        return parse_fcpxml(text)
    if fmt == "otio":
        return parse_otio(text)
    return []


def _expand_source_inputs(source_files: list[str], source_folder: str) -> list[str]:
    files: list[str] = []
    seen: set[str] = set()

    for raw in source_files:
        path = str(raw or "").strip()
        if not path:
            continue
        resolved = str(Path(path).expanduser().resolve())
        if resolved not in seen:
            seen.add(resolved)
            files.append(resolved)

    folder = str(source_folder or "").strip()
    if folder:
        root = Path(folder).expanduser().resolve()
        if root.is_dir():
            for current_root, _dirs, names in os.walk(root):
                for name in sorted(names):
                    candidate = Path(current_root) / name
                    if candidate.suffix.lower() not in SUPPORTED_SOURCE_EXTENSIONS:
                        continue
                    resolved = str(candidate.resolve())
                    if resolved in seen:
                        continue
                    seen.add(resolved)
                    files.append(resolved)

    return files


# ══════════════════════════════════════════════════════════════════════════════
# AUDIO CORRELATION
# ══════════════════════════════════════════════════════════════════════════════

def _read_wav_envelope(wav_path: str, frame_sec: float = 1.0) -> tuple[list[float], float]:
    """
    Read a WAV file and return (rms_envelope, fps_of_envelope).
    Returns per-second RMS values.
    """
    try:
        data = Path(wav_path).read_bytes()
    except OSError:
        return [], 0.0

    # Parse WAV header
    if data[:4] != b"RIFF" or data[8:12] != b"WAVE":
        return [], 0.0
    pos = 12
    sample_rate, channels, bits = 44100, 1, 16
    audio_data = b""
    while pos + 8 <= len(data):
        chunk_id = data[pos:pos+4]
        chunk_size = struct.unpack_from("<I", data, pos+4)[0]
        pos += 8
        if chunk_id == b"fmt ":
            if chunk_size >= 16:
                _, channels, sample_rate = struct.unpack_from("<HHI", data, pos)[:3]
                bits = struct.unpack_from("<H", data, pos + 14)[0]
        elif chunk_id == b"data":
            audio_data = data[pos:pos + chunk_size]
        pos += chunk_size
        if pos % 2 == 1:
            pos += 1  # word-align

    if not audio_data or sample_rate == 0:
        return [], 0.0

    frame_samples = max(1, int(sample_rate * frame_sec)) * channels
    bytes_per_sample = max(1, bits // 8)
    frame_bytes = frame_samples * bytes_per_sample
    n_frames = len(audio_data) // frame_bytes

    envelope: list[float] = []
    fmt_char = "h" if bits == 16 else ("b" if bits == 8 else "i")
    divisor = 32767.0 if bits == 16 else (127.0 if bits == 8 else 2147483647.0)

    for i in range(n_frames):
        offset = i * frame_bytes
        chunk = audio_data[offset:offset + frame_bytes]
        if len(chunk) < frame_bytes:
            break
        try:
            samples = struct.unpack_from(f"<{frame_samples}{fmt_char}", chunk)
            rms = math.sqrt(sum(s * s for s in samples) / len(samples)) / divisor
        except struct.error:
            rms = 0.0
        envelope.append(rms)

    return envelope, 1.0 / frame_sec  # envelope FPS


def _pearson(a: list[float], b: list[float]) -> float:
    """Pearson correlation coefficient between two equal-length sequences."""
    n = len(a)
    if n < 2 or len(b) != n:
        # Truncated end-windows can be shorter than the reference; correlating
        # mismatched lengths gives a meaningless score (mean_b would divide by the
        # wrong count), so treat it as no correlation.
        return 0.0
    mean_a = sum(a) / n
    mean_b = sum(b) / n
    num = sum((a[i] - mean_a) * (b[i] - mean_b) for i in range(n))
    den_a = math.sqrt(sum((x - mean_a) ** 2 for x in a))
    den_b = math.sqrt(sum((x - mean_b) ** 2 for x in b))
    if den_a < 1e-9 or den_b < 1e-9:
        return 0.0
    return max(-1.0, min(1.0, num / (den_a * den_b)))


def _audio_match_score(
    ref_env: list[float],
    ref_start_sec: float,
    ref_dur_sec: float,
    src_env: list[float],
) -> tuple[float, int]:
    """
    Slide a window of ref_dur_sec across src_env and find best correlation.
    Returns (score 0-1, best_offset_sec).
    """
    start_frame = int(ref_start_sec)
    dur_frames = max(1, int(ref_dur_sec))
    ref_window = ref_env[start_frame:start_frame + dur_frames]
    if len(ref_window) < 2 or len(src_env) < dur_frames:
        return 0.0, 0

    best_score = -1.0
    best_offset = 0
    stride = max(1, dur_frames // 20)  # coarse scan first
    for offset in range(0, len(src_env) - dur_frames + 1, stride):
        window = src_env[offset:offset + dur_frames]
        s = _pearson(ref_window, window)
        if s > best_score:
            best_score = s
            best_offset = offset

    # Refine around best_offset ±2 strides
    lo = max(0, best_offset - 2 * stride)
    hi = min(len(src_env) - dur_frames, best_offset + 2 * stride)
    for offset in range(lo, hi + 1):
        window = src_env[offset:offset + dur_frames]
        s = _pearson(ref_window, window)
        if s > best_score:
            best_score = s
            best_offset = offset

    return max(0.0, best_score), best_offset


# ══════════════════════════════════════════════════════════════════════════════
# FILENAME SCORING
# ══════════════════════════════════════════════════════════════════════════════

def _normalize_name(s: str) -> str:
    s = unicodedata.normalize("NFD", s)
    s = re.sub(r"[^\w]", " ", s, flags=re.ASCII)
    return s.lower().strip()


def _name_tokens(s: str) -> set[str]:
    return {t for t in _normalize_name(s).split() if len(t) > 1}


def _extract_episode_tokens(s: str) -> set[str]:
    """Find episode codes in a name. Returns a normalised set of tokens.

    For any episode reference we emit BOTH the season+episode form ("s01e03")
    AND the bare 3-digit code ("103") so a source named "Show_103_Master.mov"
    matches an event referenced as "S01E03" and vice versa.

    Examples
    --------
    >>> _extract_episode_tokens("BLVRS2_S01E03_Karma")
    {'s01e03', '103'}
    >>> _extract_episode_tokens("BLVRS2_201_Master")
    {'s02e01', '201'}
    >>> _extract_episode_tokens("Ep07_Pickup")
    {'ep07', 'e07', '007'}
    """
    if not s:
        return set()
    out: set[str] = set()
    # Normalise punctuation to a single separator class and use explicit
    # boundary character classes (NOT \b — re's word boundary treats `_` as a
    # word character, so `\bS01E03\b` does not match in "BLVRS2_S01E03_Karma").
    norm = re.sub(r"[^\w]", "_", s).lower()
    SEP = r"(?:^|_|\s|-|\.)"          # left-boundary: start or separator
    END = r"(?=$|_|\s|-|\.)"           # right-boundary: end or separator (lookahead)

    # 1) S##E## / s##_e## / season01episode03 — standard scripted-TV notation.
    pat_sxxeyy = re.compile(
        rf"{SEP}(?:s|season)_?(\d{{1,2}})_?(?:e|ep|episode)_?(\d{{1,3}}){END}",
        re.IGNORECASE,
    )
    for m in pat_sxxeyy.finditer(norm):
        season = int(m.group(1))
        episode = int(m.group(2))
        if 1 <= season <= 99 and 1 <= episode <= 999:
            out.add(f"s{season:02d}e{episode:02d}")
            if season <= 9 and episode <= 99:
                out.add(f"{season}{episode:02d}")      # "103"
                out.add(f"{season:02d}{episode:02d}")  # "0103"

    # 2) Bare 3-digit code (101 = S01E01, 211 = S02E11). Only between
    # separators so "C001" stays a camera id and "v003" stays a version.
    pat_3d = re.compile(rf"{SEP}(\d)(\d{{2}}){END}")
    for m in pat_3d.finditer(norm):
        season = int(m.group(1))
        episode = int(m.group(2))
        if 1 <= season <= 9 and 1 <= episode <= 99:
            out.add(f"{season}{episode:02d}")
            out.add(f"s{season:02d}e{episode:02d}")

    # 3) 4-digit code (1001 = S10E01, 0103 = S01E03)
    pat_4d = re.compile(rf"{SEP}(\d{{2}})(\d{{2}}){END}")
    for m in pat_4d.finditer(norm):
        season = int(m.group(1))
        episode = int(m.group(2))
        if 1 <= season <= 99 and 1 <= episode <= 99:
            out.add(f"{season:02d}{episode:02d}")
            out.add(f"s{season:02d}e{episode:02d}")

    # 4) Ep## / E## / Episode## form (no season — emit padded 3-digit too).
    pat_epyy = re.compile(
        rf"{SEP}(?:e|ep|episode)_?(\d{{1,3}}){END}",
        re.IGNORECASE,
    )
    for m in pat_epyy.finditer(norm):
        episode = int(m.group(1))
        if 1 <= episode <= 999:
            out.add(f"e{episode:02d}")
            out.add(f"ep{episode:02d}")
            out.add(f"{episode:03d}")

    return out


def _filename_score(reel: str, clip_name: str, src_path: str) -> float:
    """Score how well a source file name matches an EDL reel/clip name.

    Episode tokens get an explicit boost: if both sides share a recognised
    episode code (S01E03 / 103 / Ep03 / etc.), the score climbs even when
    other tokens (show name, version suffix) don't overlap. This handles the
    common workflow where trailer XML reels read "S01E03_Karma_R01" and the
    screening master is named "BLVRS2_103_BroadcastMaster.mov".
    """
    src_stem = Path(src_path).stem
    reel_tokens = _name_tokens(reel) | _name_tokens(clip_name)
    src_tokens = _name_tokens(src_stem)
    if not reel_tokens or not src_tokens:
        return 0.0

    # Exact stem match short-circuits to perfect score.
    if _normalize_name(src_stem) == _normalize_name(reel):
        return 1.0

    # Episode-token agreement — checked even when general token overlap is empty.
    event_eps = _extract_episode_tokens(reel) | _extract_episode_tokens(clip_name)
    src_eps   = _extract_episode_tokens(src_stem)
    has_episode_match = bool(event_eps & src_eps)

    overlap = reel_tokens & src_tokens
    if not overlap and not has_episode_match:
        return 0.0

    # Base score: Jaccard over general tokens (same as before).
    if reel_tokens | src_tokens:
        jaccard = len(overlap) / len(reel_tokens | src_tokens)
    else:
        jaccard = 0.0
    score = jaccard * 1.5

    # Episode match bonus — strong: an episode code is the strongest possible
    # filename signal short of an exact stem match.
    if has_episode_match:
        score = max(score, 0.60) + 0.20

    return round(min(1.0, score), 3)


# Minimum number of sources to keep after pre-filtering, even when their
# filename overlap is zero. Guards against starving the matcher in edge cases
# where reel names are cryptic and don't share any token with source files.
_PREFILTER_SAFETY_FLOOR = 4


def _prefilter_sources_by_filename(
    src_files: list[str],
    events: list,
) -> dict:
    """Drop sources whose filename shares nothing with any event reel/clip.

    Resolve's proxy rendering dominates conform runtime (~30s per source).
    A trailer often pulls from 3-5 of 10-50 candidate sources, so dropping
    the obviously irrelevant ones before proxy render saves the bulk of the
    work. Returns a dict with the kept list and counts so the analyse runner
    can surface the reduction in the UI log.

    Safety: never returns fewer than _PREFILTER_SAFETY_FLOOR sources even
    when no overlap is detected (so a cryptic-naming project still gets a
    fair shot at matching). When the input is already small, no filtering
    is applied.
    """
    n_input = len(src_files)
    if n_input <= _PREFILTER_SAFETY_FLOOR or not events:
        return {"kept": list(src_files), "kept_count": n_input, "dropped_count": 0}

    # Union of every event's filename signals.
    event_tokens: set[str] = set()
    event_eps: set[str] = set()
    for e in events:
        reel = str(getattr(e, "reel", "") or "")
        clip = str(getattr(e, "clip_name", "") or "")
        event_tokens |= _name_tokens(reel) | _name_tokens(clip)
        event_eps   |= _extract_episode_tokens(reel) | _extract_episode_tokens(clip)

    # Score each source against the unified signal set.
    scored: list[tuple[float, str]] = []
    for path in src_files:
        stem = Path(path).stem
        toks = _name_tokens(stem)
        eps  = _extract_episode_tokens(stem)
        overlap = len(event_tokens & toks)
        ep_hit  = bool(event_eps & eps)
        # Score = token overlap count + strong bonus for episode match.
        score = overlap + (5.0 if ep_hit else 0.0)
        scored.append((score, path))

    # Keep anything with score > 0; if nothing scores, fall back to keeping all.
    kept = [p for sc, p in scored if sc > 0]
    if not kept:
        return {"kept": list(src_files), "kept_count": n_input, "dropped_count": 0}

    # Safety floor: if we dropped too aggressively, add back the top-scoring
    # zero-score sources so the matcher has at least N candidates to consider.
    if len(kept) < _PREFILTER_SAFETY_FLOOR:
        scored.sort(key=lambda sp: sp[0], reverse=True)
        kept_set = set(kept)
        for sc, p in scored:
            if len(kept) >= _PREFILTER_SAFETY_FLOOR:
                break
            if p not in kept_set:
                kept.append(p); kept_set.add(p)

    # Preserve original input order among the kept set.
    kept_set = set(kept)
    ordered = [p for p in src_files if p in kept_set]
    return {
        "kept": ordered,
        "kept_count": len(ordered),
        "dropped_count": n_input - len(ordered),
    }


def _duration_score(event_frames: int, src_duration_frames: int, fps: float = 24.0) -> float:
    """Score based on how well event duration fits within source duration."""
    if event_frames <= 0 or src_duration_frames <= 0:
        return 0.0
    if event_frames > src_duration_frames + int(fps * 2):  # event longer than src + 2s
        return 0.0
    ratio = event_frames / src_duration_frames
    if ratio > 1.0:
        ratio = 1.0 / ratio
    return round(ratio, 3)


# ══════════════════════════════════════════════════════════════════════════════
# RESOLVE PROXY / WAV GENERATION
# ══════════════════════════════════════════════════════════════════════════════

# ═══════════════════════════════════════════════════════════════════════════
# PERSISTENT PROXY CACHE
# ═══════════════════════════════════════════════════════════════════════════
# Proxy rendering through Resolve is by far the slowest step of a conform
# (~30s per source file). Sources rarely change between runs — a screening
# masters folder is essentially stable. Caching the per-source proxy + WAV
# keyed by (absPath, mtime, size, proxy resolution) lets repeat conforms on
# the same folder skip the render step entirely.
#
# Cache lives at ~/Library/Caches/PostFlowX/trailer_conform/proxies/ on
# macOS, $XDG_CACHE_HOME equivalent on Linux. Bounded by total bytes; on
# overflow the oldest entries are evicted.

_PROXY_CACHE_MAX_BYTES = 5 * 1024 * 1024 * 1024  # 5 GB ceiling


def _proxy_cache_dir() -> Path:
    """Return the persistent proxy cache root, creating it if necessary."""
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
        root = base / "PostFlowX" / "Cache" / "trailer_conform" / "proxies"
    elif sys.platform == "darwin":
        root = Path.home() / "Library" / "Caches" / "PostFlowX" / "trailer_conform" / "proxies"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
        root = base / "postflowx" / "trailer_conform" / "proxies"
    root.mkdir(parents=True, exist_ok=True)
    return root


def _proxy_cache_key(src_path: str, proxy_w: int, proxy_h: int) -> str:
    """Cache key derived from the source's identity AND requested proxy size."""
    import hashlib
    p = Path(src_path)
    try:
        st = p.stat()
        sig = f"{p.resolve()}\0{st.st_size}\0{int(st.st_mtime)}\0{proxy_w}x{proxy_h}"
    except OSError:
        sig = f"{src_path}\0?\0?\0{proxy_w}x{proxy_h}"
    return hashlib.sha1(sig.encode("utf-8")).hexdigest()[:20]


def _proxy_cache_lookup(
    src_path: str, output_dir: str, proxy_w: int, proxy_h: int,
) -> dict | None:
    """Return a render-result dict from the cache, or None on miss.

    On hit: copies the cached proxy + WAV into output_dir so downstream code
    (which expects files in the job folder) finds them at the standard paths.
    """
    import shutil
    key = _proxy_cache_key(src_path, proxy_w, proxy_h)
    cache_dir = _proxy_cache_dir()
    meta_path = cache_dir / f"{key}.json"
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    cached_proxy = cache_dir / f"{key}_proxy.mp4"
    cached_wav   = cache_dir / f"{key}_audio.wav"
    if not (cached_proxy.exists() and cached_wav.exists()):
        # Partial cache — treat as miss; the matching .json will be overwritten on next store.
        return None

    stem = re.sub(r"[^\w-]", "_", Path(src_path).stem)
    dest_proxy = Path(output_dir) / f"{stem}_proxy.mp4"
    dest_wav   = Path(output_dir) / f"{stem}_audio.wav"
    try:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
        if not dest_proxy.exists():
            shutil.copy2(str(cached_proxy), str(dest_proxy))
        if not dest_wav.exists():
            shutil.copy2(str(cached_wav), str(dest_wav))
    except OSError:
        return None

    # Touch the meta file so LRU eviction sees this as a recent hit.
    try:
        os.utime(meta_path, None)
    except OSError:
        pass

    return {
        "inputFile": src_path,
        "proxyFile": str(dest_proxy),
        "wavFile":   str(dest_wav),
        "durationFrames": int(meta.get("durationFrames") or 0),
        "fps": float(meta.get("fps") or 24.0),
        "cached": True,
    }


def _proxy_cache_store(
    src_path: str, proxy_path: str | None, wav_path: str | None,
    duration_frames: int, fps: float, proxy_w: int, proxy_h: int,
) -> None:
    """Persist a rendered proxy + WAV into the cache. Silent on any error —
    cache writes are best-effort and shouldn't fail the conform job."""
    import shutil
    if not proxy_path or not wav_path:
        return
    if not (Path(proxy_path).exists() and Path(wav_path).exists()):
        return
    try:
        key = _proxy_cache_key(src_path, proxy_w, proxy_h)
        cache_dir = _proxy_cache_dir()
        cached_proxy = cache_dir / f"{key}_proxy.mp4"
        cached_wav   = cache_dir / f"{key}_audio.wav"
        meta_path    = cache_dir / f"{key}.json"
        shutil.copy2(proxy_path, cached_proxy)
        shutil.copy2(wav_path,   cached_wav)
        meta = {
            "inputFile": src_path,
            "durationFrames": int(duration_frames),
            "fps": float(fps),
            "proxyW": int(proxy_w),
            "proxyH": int(proxy_h),
            "cachedAt": time.time(),
        }
        meta_path.write_text(json.dumps(meta), encoding="utf-8")
    except (OSError, shutil.Error):
        pass


def _proxy_cache_prune(max_bytes: int = _PROXY_CACHE_MAX_BYTES) -> None:
    """Trim the cache to ≤ max_bytes by evicting oldest (LRU by mtime)."""
    try:
        cache_dir = _proxy_cache_dir()
        # Group files by key so we evict (proxy + wav + json) together.
        keys: dict[str, dict] = {}
        for f in cache_dir.iterdir():
            if not f.is_file():
                continue
            base = f.stem
            # Strip "_proxy" / "_audio" suffix to recover the key.
            for suffix in ("_proxy", "_audio"):
                if base.endswith(suffix):
                    base = base[: -len(suffix)]; break
            key = base
            entry = keys.setdefault(key, {"size": 0, "mtime": 0.0, "files": []})
            try:
                st = f.stat()
                entry["size"] += st.st_size
                entry["mtime"] = max(entry["mtime"], st.st_mtime)
                entry["files"].append(f)
            except OSError:
                continue
        total = sum(e["size"] for e in keys.values())
        if total <= max_bytes:
            return
        # Oldest first
        sorted_keys = sorted(keys.items(), key=lambda kv: kv[1]["mtime"])
        for _, entry in sorted_keys:
            if total <= max_bytes:
                break
            for f in entry["files"]:
                try: f.unlink()
                except OSError: pass
            total -= entry["size"]
    except OSError:
        pass


def _render_analysis_proxies(
    resolve_app: Any,
    files: list[str],
    output_dir: str,
    session_id: str,
    proxy_w: int = 640,
    proxy_h: int = 360,
) -> list[dict]:
    """
    Use Resolve to render low-res analysis proxy + WAV for each input file.
    Returns list of {inputFile, proxyFile, wavFile, durationFrames, fps}.
    """
    pm = resolve_app.GetProjectManager()
    if not pm:
        raise RuntimeError("RESOLVE_API_NOT_AVAILABLE: GetProjectManager returned None")

    job_id = f"PFX_CONFORM_ANALYZE_{uuid.uuid4().hex[:8]}"
    project = pm.CreateProject(job_id)
    if not project:
        project = pm.LoadProject(job_id)
    if not project:
        raise RuntimeError("TIMELINE_CREATE_FAILED: Could not create analysis project")

    results: list[dict] = []
    total = len(files)

    try:
        media_pool = project.GetMediaPool()
        if not media_pool:
            raise RuntimeError("RESOLVE_API_NOT_AVAILABLE: GetMediaPool returned None")

        for i, src_path in enumerate(files):
            pct_base = ANALYZE_STEPS["render_proxies"] + int(
                (ANALYZE_STEPS["correlate"] - ANALYZE_STEPS["render_proxies"]) * i / max(1, total)
            )

            # Cache lookup: skip Resolve render when we've already rendered
            # this exact source at this exact proxy size and the file hasn't
            # changed since.
            cached = _proxy_cache_lookup(src_path, output_dir, proxy_w, proxy_h)
            if cached is not None:
                _upd(session_id, "render_proxies", pct_base,
                     f"Reusing cached proxy {i+1}/{total}: {Path(src_path).name}")
                results.append(cached)
                continue

            _upd(session_id, "render_proxies", pct_base,
                 f"Rendering analysis proxy {i+1}/{total}: {Path(src_path).name}…")

            # Import single clip
            imported = media_pool.ImportMedia([src_path])
            if not imported:
                results.append({"inputFile": src_path, "proxyFile": None, "wavFile": None,
                                 "error": "Import failed", "durationFrames": 0, "fps": 24.0})
                continue

            clip = imported[0]
            props = clip.GetClipProperty() or {}
            try:
                fps = float(str(props.get("FPS") or "24").split()[0])
            except (ValueError, TypeError):
                fps = 24.0
            try:
                dur_str = str(props.get("Frames") or "0")
                dur_frames = int(float(dur_str))
            except (ValueError, TypeError):
                dur_frames = 0

            # Create a single-clip timeline
            tl = media_pool.CreateTimelineFromClips(f"PFX_TL_{i:03d}", imported)
            if not tl:
                results.append({"inputFile": src_path, "proxyFile": None, "wavFile": None,
                                 "error": "Timeline create failed", "durationFrames": dur_frames, "fps": fps})
                continue

            stem = re.sub(r"[^\w-]", "_", Path(src_path).stem)
            proxy_path = str(Path(output_dir) / f"{stem}_proxy.mp4")
            wav_path   = str(Path(output_dir) / f"{stem}_audio.wav")

            # Render video proxy
            _preset_ok = any(
                project.SetCurrentRenderPreset(p)
                for p in ("H.264 Master", "YouTube - 1080p", "H.264", "H.265 Master")
            )
            project.SetRenderSettings({
                "SelectAllFrames": True,
                "TargetDir": output_dir,
                "CustomName": f"{stem}_proxy",
                "ResolutionWidth": proxy_w,
                "ResolutionHeight": proxy_h,
                "SetRenderResolutionToCustom": True,
            })
            rq_ids_v = project.AddRenderJob()
            if rq_ids_v:
                project.StartRendering(rq_ids_v)
                _wait_render(project, timeout_sec=300)

            # Render WAV audio
            _wav_preset = any(
                project.SetCurrentRenderPreset(p)
                for p in ("Audio Only", "WAV", "AIFF")
            )
            if _wav_preset:
                project.SetRenderSettings({
                    "SelectAllFrames": True,
                    "TargetDir": output_dir,
                    "CustomName": f"{stem}_audio",
                    "AudioSampleRate": 8000,
                    "AudioBitDepth": 16,
                })
                rq_ids_a = project.AddRenderJob()
                if rq_ids_a:
                    project.StartRendering(rq_ids_a)
                    _wait_render(project, timeout_sec=120)

            actual_proxy = proxy_path if Path(proxy_path).exists() else None
            actual_wav   = wav_path   if Path(wav_path).exists() else None

            # Fallback: scan output dir for new file matching stem
            if not actual_proxy:
                for f in Path(output_dir).iterdir():
                    if stem in f.stem and f.suffix.lower() in (".mp4", ".mov") and f.stat().st_size > 0:
                        actual_proxy = str(f)
                        break
            if not actual_wav:
                for f in Path(output_dir).iterdir():
                    if stem in f.stem and f.suffix.lower() in (".wav", ".aiff") and f.stat().st_size > 0:
                        actual_wav = str(f)
                        break

            results.append({
                "inputFile": src_path,
                "proxyFile": actual_proxy,
                "wavFile": actual_wav,
                "durationFrames": dur_frames,
                "fps": fps,
            })

            # Persist to cache so subsequent runs on the same source skip the
            # render. Best-effort; cache failures don't affect the current job.
            _proxy_cache_store(
                src_path, actual_proxy, actual_wav,
                dur_frames, fps, proxy_w, proxy_h,
            )

    finally:
        try:
            pm.CloseProject(project)
            pm.DeleteProject(job_id)
        except Exception:
            pass

    # Trim the cache once per job — cheap stat-based pass.
    _proxy_cache_prune()
    return results


def _wait_render(project: Any, timeout_sec: int = 300) -> None:
    deadline = time.time() + timeout_sec
    while project.IsRenderingInProgress():
        if time.time() > deadline:
            project.StopRendering()
            return
        time.sleep(1.0)


# ══════════════════════════════════════════════════════════════════════════════
# MATCHING
# ══════════════════════════════════════════════════════════════════════════════

def _match_events(
    events: list[ConformEvent],
    proxy_info: list[dict],
    ref_proxy: dict,
    session_id: str,
) -> list[dict]:
    """
    Match each EDL event to the best source candidate.
    Returns list of match dicts with confidence breakdown.
    """
    _upd(session_id, "correlate", ANALYZE_STEPS["correlate"], "Loading audio envelopes…")

    # Load reference WAV envelope
    ref_env: list[float] = []
    if ref_proxy.get("wavFile") and Path(ref_proxy["wavFile"]).exists():
        ref_env, _ = _read_wav_envelope(ref_proxy["wavFile"], frame_sec=1.0)

    # Load source WAV envelopes
    src_envelopes: list[list[float]] = []
    for px in proxy_info:
        env: list[float] = []
        if px.get("wavFile") and Path(px["wavFile"]).exists():
            env, _ = _read_wav_envelope(px["wavFile"], frame_sec=1.0)
        src_envelopes.append(env)

    matches: list[dict] = []
    total = len(events)

    for ei, event in enumerate(events):
        pct = ANALYZE_STEPS["correlate"] + int(
            (ANALYZE_STEPS["score"] - ANALYZE_STEPS["correlate"]) * ei / max(1, total)
        )
        _upd(session_id, "correlate", pct,
             f"Matching event {ei+1}/{total}: {event.clip_name}…")

        candidates: list[dict] = []
        for si, px in enumerate(proxy_info):
            fn_score = _filename_score(event.reel, event.clip_name, px["inputFile"])
            dur_score = _duration_score(event.duration_frames, px.get("durationFrames", 0), event.fps)

            # Audio correlation
            audio_score = 0.0
            audio_offset_sec = 0
            if ref_env and src_envelopes[si]:
                # Compute event's position in reference WAV
                ref_fps = ref_proxy.get("fps", event.fps)
                ref_start_sec = 0.0
                if event.rec_in:
                    ref_start_sec = _tc_to_frames(event.rec_in, event.fps) / max(1.0, event.fps)
                dur_sec = event.duration_frames / max(1.0, event.fps)
                audio_score, audio_offset_sec = _audio_match_score(
                    ref_env, ref_start_sec, dur_sec, src_envelopes[si]
                )

            # Weighted confidence
            if ref_env and src_envelopes[si]:
                confidence = (fn_score * 0.35 + dur_score * 0.25 + audio_score * 0.40)
            else:
                confidence = (fn_score * 0.55 + dur_score * 0.45)

            candidates.append({
                "sourceIndex": si,
                "sourceFile": px["inputFile"],
                "confidence": round(confidence, 3),
                "breakdown": {
                    "filename": round(fn_score, 3),
                    "duration": round(dur_score, 3),
                    "audio": round(audio_score, 3),
                },
                "suggestedSourceIn": _frames_to_tc(audio_offset_sec, event.fps),
                "sourceDurationFrames": px.get("durationFrames", 0),
            })

        candidates.sort(key=lambda c: c["confidence"], reverse=True)
        top = candidates[:5]  # keep top 5 for review UI

        # Auto-accept if top candidate is unambiguous
        auto_accept = len(top) > 0 and top[0]["confidence"] >= 0.75
        if len(top) > 1:
            auto_accept = auto_accept and (top[0]["confidence"] - top[1]["confidence"] >= 0.15)

        matches.append({
            "eventIndex": event.index,
            "event": event.to_dict(),
            "candidates": top,
            "accepted": auto_accept,
            "acceptedSourceIndex": top[0]["sourceIndex"] if auto_accept and top else None,
            "status": "auto" if auto_accept else ("manual" if top else "no_match"),
        })

    return matches


# ══════════════════════════════════════════════════════════════════════════════
# PHASE 1: ANALYZE JOB
# ══════════════════════════════════════════════════════════════════════════════

def run_conform_analyze_async(session_id: str, job: dict) -> None:
    """
    Phase 1 async runner:
    1. Parse edit file → events
    2. Render analysis proxies + WAV via Resolve (or ffmpeg fallback)
    3. Audio + filename + duration matching
    4. Write results to session
    """
    from .resolve_engine import _get_resolve_app, _setup_resolve_env

    edit_file   = str(job.get("editFile") or "")
    edit_fmt    = job.get("editFormat") or None
    ref_file    = str(job.get("referenceFile") or "")
    src_files   = list(job.get("sourceFiles") or [])
    src_folder  = str(job.get("sourceFolder") or "")
    output_dir  = str(job.get("outputDir") or "")
    fps         = float(job.get("fps") or 24.0)
    proxy_w     = int(job.get("proxyWidth") or 640)
    proxy_h     = int(job.get("proxyHeight") or 360)

    Path(output_dir).mkdir(parents=True, exist_ok=True)

    try:
        # Step 1: parse edit
        _upd(session_id, "parse_edit", ANALYZE_STEPS["parse_edit"], "Parsing edit file…")
        if not edit_file or not Path(edit_file).exists():
            _fail_session(session_id, "MEDIA_IMPORT_FAILED", f"Edit file not found: {edit_file!r}")
            return
        if not ref_file or not Path(ref_file).exists():
            _fail_session(session_id, "MEDIA_IMPORT_FAILED", f"Reference file not found: {ref_file!r}")
            return
        src_files = _expand_source_inputs(src_files, src_folder)
        if not src_files:
            _fail_session(session_id, "MEDIA_IMPORT_FAILED", "No source files found.")
            return
        events = parse_edit_file(edit_file, edit_fmt, fps)
        if not events:
            _fail_session(session_id, "RESOLVE_SCRIPT_FAILED", "No events found in edit file.")
            return
        _upd(session_id, "parse_edit", ANALYZE_STEPS["parse_edit"],
             f"Parsed {len(events)} events.", events=[e.to_dict() for e in events])

        # Step 1.5: pre-filter sources by filename relevance.
        # Resolve proxy rendering is the longest step (~30s per file). Sources
        # whose filenames share no token with ANY event's reel/clip are very
        # unlikely to be matched — drop them before spending render time.
        # Keep a small safety floor so the matcher always has something.
        pre = _prefilter_sources_by_filename(src_files, events)
        if pre.get("kept_count", len(src_files)) < len(src_files):
            _upd(session_id, "parse_edit", ANALYZE_STEPS["parse_edit"],
                 f"Pre-filtered {len(src_files)} → {pre['kept_count']} sources "
                 f"(dropped {pre['dropped_count']} with no name overlap).")
            src_files = pre["kept"]

        # Step 2: connect to Resolve
        _upd(session_id, "render_proxies", ANALYZE_STEPS["render_proxies"],
             "Connecting to DaVinci Resolve…")
        _setup_resolve_env()
        resolve_app = _get_resolve_app(timeout=15.0)
        if not resolve_app:
            _fail_session(session_id, "RESOLVE_API_NOT_AVAILABLE",
                          "DaVinci Resolve is not running or scripting API unavailable.")
            return

        # Step 3: render proxies for reference + all sources
        all_files = ([ref_file] if ref_file else []) + src_files
        _upd(session_id, "render_proxies", ANALYZE_STEPS["render_proxies"],
             f"Rendering {len(all_files)} analysis proxies via Resolve…")
        all_proxies = _render_analysis_proxies(
            resolve_app, all_files, output_dir, session_id, proxy_w, proxy_h
        )

        ref_proxy_info: dict = {}
        src_proxy_info: list[dict] = []
        if ref_file and all_proxies:
            ref_proxy_info = all_proxies[0]
            src_proxy_info = all_proxies[1:]
        else:
            src_proxy_info = all_proxies

        _upd(session_id, "render_proxies", ANALYZE_STEPS["correlate"] - 1,
             f"Proxies ready. Running matching…",
             proxies=[{k: v for k, v in p.items() if k != "error"} for p in all_proxies])

        # Step 4: match
        if not src_proxy_info:
            _fail_session(session_id, "MEDIA_IMPORT_FAILED",
                          "No source proxy info — import failed for all sources.")
            return
        matches = _match_events(events, src_proxy_info, ref_proxy_info, session_id)

        # Done
        result = {
            "status": "ok",
            "jobId": str(job.get("jobId") or session_id),
            "editEvents": [e.to_dict() for e in events],
            "proxies": [{k: v for k, v in p.items() if k != "error"} for p in src_proxy_info],
            "refProxy": {k: v for k, v in ref_proxy_info.items() if k != "error"} if ref_proxy_info else {},
            "matches": matches,
        }
        _upd(session_id, "complete", ANALYZE_STEPS["complete"],
             f"Analysis complete. {len(matches)} events matched.")
        _finish(session_id, result)

    except Exception as exc:
        tb = traceback.format_exc()
        _fail_session(session_id, "RESOLVE_SCRIPT_FAILED",
                      f"Conform analysis failed: {exc}\n{tb}")


def start_conform_analyze(job: dict) -> str:
    """Start Phase 1 analysis in a background thread. Returns session_id."""
    session_id = str(uuid.uuid4())
    create_session(session_id, {
        "type": "conform_analyze",
        "step": "idle", "pct": 0, "message": "Starting…",
        "done": False, "events": [], "proxies": [], "matches": [],
    })
    t = threading.Thread(target=run_conform_analyze_async, args=(session_id, job), daemon=True)
    t.start()
    return session_id


def run_conform_preflight(job: dict) -> dict:
    """Fast synchronous sanity check before kicking off a real analyse job.

    Verifies the edit file parses, the reference QT exists, and the source
    folder has at least one matching file. Computes the pre-filter outcome
    so the user can see how many sources will actually be proxy-rendered
    before paying the ~30s/file cost. Returns warnings (non-blocking) for
    soft issues like sparse source pools or duration mismatches.

    Designed to return in ~100ms so the UI can call it on every Analyze
    click without blocking the user. Never touches Resolve, never renders.
    """
    edit_file  = str(job.get("editFile") or "")
    edit_fmt   = job.get("editFormat") or None
    ref_file   = str(job.get("referenceFile") or "")
    src_files  = list(job.get("sourceFiles") or [])
    src_folder = str(job.get("sourceFolder") or "")
    fps        = float(job.get("fps") or 24.0)

    errors: list[str] = []
    warnings: list[str] = []

    # ── Edit file ─────────────────────────────────────────────────────────
    edit_events = 0
    edit_total_frames = 0
    if not edit_file:
        errors.append("Missing edit file path.")
    elif not Path(edit_file).exists():
        errors.append(f"Edit file not found: {edit_file}")
    else:
        try:
            events = parse_edit_file(edit_file, edit_fmt, fps)
            edit_events = len(events)
            edit_total_frames = sum(int(getattr(e, "duration_frames", 0) or 0) for e in events)
            if not events:
                errors.append("Edit file parsed but contains no events.")
        except Exception as exc:
            errors.append(f"Edit file failed to parse: {exc}")

    # ── Reference QT ──────────────────────────────────────────────────────
    ref_size = 0
    if not ref_file:
        errors.append("Missing reference QT path.")
    elif not Path(ref_file).exists():
        errors.append(f"Reference QT not found: {ref_file}")
    else:
        try:
            ref_size = Path(ref_file).stat().st_size
            if ref_size < 1024:
                warnings.append(f"Reference QT is tiny ({ref_size} bytes) — likely corrupt.")
        except OSError as exc:
            warnings.append(f"Could not stat reference QT: {exc}")

    # ── Source pool ───────────────────────────────────────────────────────
    expanded: list[str] = []
    try:
        expanded = _expand_source_inputs(src_files, src_folder)
    except Exception as exc:
        errors.append(f"Source expansion failed: {exc}")

    source_total = len(expanded)
    if not expanded:
        errors.append(
            "No source media found. Check that the source folder exists and "
            "contains files with extensions: " + ", ".join(sorted(SUPPORTED_SOURCE_EXTENSIONS))
        )

    # Pre-filter preview (only when we have events to score against)
    kept_count = source_total
    dropped_count = 0
    if expanded and edit_events:
        try:
            events_for_filter = parse_edit_file(edit_file, edit_fmt, fps)
            pre = _prefilter_sources_by_filename(expanded, events_for_filter)
            kept_count = pre["kept_count"]
            dropped_count = pre["dropped_count"]
            if kept_count == 0:
                warnings.append(
                    "Pre-filter produced 0 sources; analysis will fall back to the full pool."
                )
        except Exception as exc:
            warnings.append(f"Pre-filter preview failed: {exc}")

    if kept_count and edit_events and kept_count < edit_events / 10:
        # 1 source per 10 events would be unusually sparse for a normal trailer.
        # Warn but don't block.
        warnings.append(
            f"Only {kept_count} source(s) for {edit_events} event(s) — matching may be incomplete."
        )

    estimated_proxy_seconds = kept_count * 30  # ballpark from observed timings
    return {
        "ok": not errors,
        "errors": errors,
        "warnings": warnings,
        "editEventsCount": edit_events,
        "editTotalFrames": edit_total_frames,
        "editDurationSeconds": round(edit_total_frames / max(1.0, fps), 2),
        "referenceFileBytes": ref_size,
        "sourceFileCount": source_total,
        "sourceAfterPrefilter": kept_count,
        "sourceDropped": dropped_count,
        "estimatedProxySeconds": estimated_proxy_seconds,
    }


# ══════════════════════════════════════════════════════════════════════════════
# PHASE 3: TIMELINE BUILD + RENDER
# ══════════════════════════════════════════════════════════════════════════════

def _build_conform_timeline(
    resolve_app: Any,
    match_list: list[dict],
    job: dict,
    session_id: str,
) -> dict:
    """
    Build a conformed timeline in Resolve from accepted match list.
    Returns result dict with timelineName, projectName.
    """
    from .resolve_engine import _wait_render as _wr

    output_dir = str(job.get("outputDir") or "")
    project_label = re.sub(r"[^\w-]", "_", str(job.get("projectLabel") or "Conform"))
    fps = float(job.get("fps") or 24.0)
    render_review = bool(job.get("renderReview") or False)
    burn_in = bool(job.get("burnIn") or False)

    pm = resolve_app.GetProjectManager()
    if not pm:
        raise RuntimeError("RESOLVE_API_NOT_AVAILABLE")

    _upd(session_id, "create_project", BUILD_STEPS["create_project"], "Creating Resolve project…")
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    project_name = f"PFX_Conform_{project_label}_{ts}"
    project = pm.CreateProject(project_name)
    if not project:
        raise RuntimeError(f"TIMELINE_CREATE_FAILED: Could not create '{project_name}'")

    try:
        project.SetSetting("timelineFrameRate", str(int(round(fps))))
        media_pool = project.GetMediaPool()
        if not media_pool:
            raise RuntimeError("RESOLVE_API_NOT_AVAILABLE: GetMediaPool returned None")

        # Collect unique source files
        source_files = list({
            m["acceptedSourceFile"]
            for m in match_list
            if m.get("acceptedSourceFile")
        })
        _upd(session_id, "import_media", BUILD_STEPS["import_media"],
             f"Importing {len(source_files)} source files…")
        imported_clips = media_pool.ImportMedia(source_files)
        if not imported_clips:
            raise RuntimeError("MEDIA_IMPORT_FAILED: No clips imported")

        # Build clip map: path → MediaPoolItem
        clip_map: dict[str, Any] = {}
        for clip in imported_clips:
            props = clip.GetClipProperty() or {}
            fp = props.get("File Path", "")
            if fp:
                clip_map[fp] = clip

        _upd(session_id, "build_timeline", BUILD_STEPS["build_timeline"],
             f"Building conform timeline ({len(match_list)} events)…")

        # Create empty timeline
        timeline_name = f"PFX_Conform_{project_label}"
        media_pool.SetCurrentFolder(media_pool.GetRootFolder())
        tl = media_pool.CreateEmptyTimeline(timeline_name)
        if not tl:
            raise RuntimeError("TIMELINE_CREATE_FAILED: CreateEmptyTimeline returned None")

        project.SetCurrentTimeline(tl)

        # Append clips in event order
        for match in sorted(match_list, key=lambda m: m.get("eventIndex", 0)):
            src_file = match.get("acceptedSourceFile")
            if not src_file:
                continue
            clip = clip_map.get(src_file)
            if not clip:
                continue
            src_in_tc  = str(match.get("acceptedSourceIn")  or "00:00:00:00")
            src_out_tc = str(match.get("acceptedSourceOut") or "00:00:00:00")

            try:
                in_frames  = _tc_to_frames(src_in_tc, fps)
                out_frames = _tc_to_frames(src_out_tc, fps)
            except Exception:
                continue

            media_pool.AppendToTimeline([{
                "mediaPoolItem": clip,
                "startFrame": in_frames,
                "endFrame": out_frames,
            }])

        outputs: dict[str, str] = {}
        Path(output_dir).mkdir(parents=True, exist_ok=True)

        if render_review:
            _upd(session_id, "render_review", BUILD_STEPS["render_review"],
                 "Rendering review QT…")
            review_name = f"{project_label}_review"
            for preset in ("H.264 Master", "YouTube - 1080p", "H.264"):
                if project.SetCurrentRenderPreset(preset):
                    break
            render_cfg: dict[str, Any] = {
                "SelectAllFrames": True,
                "TargetDir": output_dir,
                "CustomName": review_name,
            }
            if burn_in:
                render_cfg["BurnInType"] = "Default"
            project.SetRenderSettings(render_cfg)
            rq_ids = project.AddRenderJob()
            if rq_ids:
                project.StartRendering(rq_ids)
                deadline = time.time() + 1800
                while project.IsRenderingInProgress():
                    if time.time() > deadline:
                        project.StopRendering()
                        break
                    elapsed = time.time() - (deadline - 1800)
                    pct = BUILD_STEPS["render_review"] + int(
                        (BUILD_STEPS["export"] - BUILD_STEPS["render_review"])
                        * min(1.0, elapsed / 600)
                    )
                    _upd(session_id, "render_review", pct, "Rendering review QT…")
                    time.sleep(2.0)
                # Find rendered file
                for f in Path(output_dir).iterdir():
                    if review_name in f.stem and f.suffix.lower() in (".mp4", ".mov"):
                        outputs["reviewQt"] = str(f)
                        break

        return {
            "projectName": project_name,
            "timelineName": timeline_name,
            "outputs": outputs,
        }

    except Exception:
        try:
            pm.CloseProject(project)
            pm.DeleteProject(project_name)
        except Exception:
            pass
        raise


# ══════════════════════════════════════════════════════════════════════════════
# EXPORT: EDL / FCPXML / OTIO / CSV
# ══════════════════════════════════════════════════════════════════════════════

def _export_edl(match_list: list[dict], fps: float) -> str:
    lines = ["TITLE: PFX Conform Export", f"FCM: NON-DROP FRAME", ""]
    for m in sorted(match_list, key=lambda x: x.get("eventIndex", 0)):
        idx = m.get("eventIndex", 1)
        src_file = m.get("acceptedSourceFile", "")
        reel = re.sub(r"[^\w-]", "_", Path(src_file).stem[:8]) if src_file else "BL"
        src_in  = m.get("acceptedSourceIn",  "00:00:00:00")
        src_out = m.get("acceptedSourceOut", "00:00:00:00")
        rec_in  = m.get("event", {}).get("rec_in",  "00:00:00:00") or "00:00:00:00"
        rec_out = m.get("event", {}).get("rec_out", "00:00:00:00") or "00:00:00:00"
        lines.append(f"{idx:03d}  {reel:<8}  V  C  {src_in} {src_out} {rec_in} {rec_out}")
        if src_file:
            lines.append(f"* FROM CLIP NAME: {Path(src_file).name}")
        lines.append("")
    return "\n".join(lines)


def _export_fcpxml(match_list: list[dict], fps: float, label: str) -> str:
    ifps = int(round(fps))
    events_xml = []
    for m in sorted(match_list, key=lambda x: x.get("eventIndex", 0)):
        src_file = m.get("acceptedSourceFile", "")
        clip_name = Path(src_file).name if src_file else f"clip_{m.get('eventIndex', 0)}"
        ev = m.get("event", {})
        rec_in = ev.get("rec_in", "00:00:00:00") or "00:00:00:00"
        src_in = m.get("acceptedSourceIn", "00:00:00:00")
        src_out = m.get("acceptedSourceOut", "00:00:00:00")
        dur_f = ev.get("duration_frames", 0) or 0
        events_xml.append(
            f'  <clip name="{clip_name}" start="{_tc_to_frames(src_in, fps)}/{ifps}s"'
            f' duration="{dur_f}/{ifps}s" offset="{_tc_to_frames(rec_in, fps)}/{ifps}s">'
            f'<video ref="r{m.get("eventIndex",1)}"/></clip>'
        )
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<fcpxml version="1.9">\n'
        '  <library>\n'
        f'    <event name="{label}">\n'
        f'      <project name="{label}">\n'
        '        <sequence>\n'
        '          <spine>\n'
        + "\n".join(events_xml) + "\n"
        '          </spine>\n'
        '        </sequence>\n'
        '      </project>\n'
        '    </event>\n'
        '  </library>\n'
        '</fcpxml>'
    )


def _export_otio(match_list: list[dict], fps: float, label: str) -> str:
    clips = []
    for m in sorted(match_list, key=lambda x: x.get("eventIndex", 0)):
        ev = m.get("event", {})
        dur = ev.get("duration_frames", 0) or 0
        src_in = _tc_to_frames(m.get("acceptedSourceIn", "00:00:00:00"), fps)
        clips.append({
            "OTIO_SCHEMA": "Clip.1",
            "name": Path(m.get("acceptedSourceFile", "clip")).stem,
            "source_range": {
                "OTIO_SCHEMA": "TimeRange.1",
                "start_time": {"OTIO_SCHEMA": "RationalTime.1", "value": src_in, "rate": fps},
                "duration":   {"OTIO_SCHEMA": "RationalTime.1", "value": dur,    "rate": fps},
            },
        })
    tl = {
        "OTIO_SCHEMA": "Timeline.1",
        "name": label,
        "tracks": {
            "OTIO_SCHEMA": "Stack.1",
            "children": [{
                "OTIO_SCHEMA": "Track.1",
                "kind": "Video",
                "children": clips,
            }],
        },
    }
    return json.dumps(tl, indent=2)


def _export_csv(match_list: list[dict]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow([
        "EventIndex", "ClipName", "Reel", "RecIn", "RecOut",
        "SourceFile", "SourceIn", "SourceOut", "Confidence", "Status",
    ])
    for m in sorted(match_list, key=lambda x: x.get("eventIndex", 0)):
        ev = m.get("event", {})
        cands = m.get("candidates", [])
        conf = cands[0]["confidence"] if cands else 0
        writer.writerow([
            m.get("eventIndex", ""),
            ev.get("clip_name", ""),
            ev.get("reel", ""),
            ev.get("rec_in", ""),
            ev.get("rec_out", ""),
            m.get("acceptedSourceFile", ""),
            m.get("acceptedSourceIn", ""),
            m.get("acceptedSourceOut", ""),
            f"{conf:.3f}",
            m.get("status", ""),
        ])
    return buf.getvalue()


def export_conform_results(match_list: list[dict], output_dir: str,
                           fps: float, label: str, formats: list[str]) -> dict[str, str]:
    """Write EDL/FCPXML/OTIO/CSV to output_dir. Returns {format: filepath}."""
    Path(output_dir).mkdir(parents=True, exist_ok=True)
    outputs: dict[str, str] = {}

    if "edl" in formats:
        p = str(Path(output_dir) / f"{label}_conform.edl")
        Path(p).write_text(_export_edl(match_list, fps), encoding="utf-8")
        outputs["edl"] = p

    if "fcpxml" in formats:
        p = str(Path(output_dir) / f"{label}_conform.fcpxml")
        Path(p).write_text(_export_fcpxml(match_list, fps, label), encoding="utf-8")
        outputs["fcpxml"] = p

    if "otio" in formats:
        p = str(Path(output_dir) / f"{label}_conform.otio")
        Path(p).write_text(_export_otio(match_list, fps, label), encoding="utf-8")
        outputs["otio"] = p

    if "csv" in formats:
        p = str(Path(output_dir) / f"{label}_conform.csv")
        Path(p).write_text(_export_csv(match_list), encoding="utf-8")
        outputs["csv"] = p

    return outputs


# ══════════════════════════════════════════════════════════════════════════════
# PHASE 3 ASYNC RUNNER
# ══════════════════════════════════════════════════════════════════════════════

def run_conform_build_async(session_id: str, job: dict) -> None:
    """Phase 3: build timeline, render review QT, export."""
    from .resolve_engine import _get_resolve_app, _setup_resolve_env

    match_list  = list(job.get("matchList") or [])
    output_dir  = str(job.get("outputDir") or "")
    fps         = float(job.get("fps") or 24.0)
    label       = re.sub(r"[^\w-]", "_", str(job.get("label") or "Conform"))
    export_fmts = list(job.get("exportFormats") or ["edl", "fcpxml", "csv"])

    Path(output_dir).mkdir(parents=True, exist_ok=True)

    try:
        accepted = [m for m in match_list if m.get("accepted") and m.get("acceptedSourceFile")]
        if not accepted:
            _fail_session(session_id, "RESOLVE_SCRIPT_FAILED",
                          "No accepted matches in match list.")
            return

        _upd(session_id, "connect", BUILD_STEPS["connect"], "Connecting to DaVinci Resolve…")
        _setup_resolve_env()
        resolve_app = _get_resolve_app(timeout=15.0)
        if not resolve_app:
            _fail_session(session_id, "RESOLVE_API_NOT_AVAILABLE",
                          "DaVinci Resolve is not running or scripting API unavailable.")
            return

        build_result = _build_conform_timeline(resolve_app, accepted, job, session_id)

        _upd(session_id, "export", BUILD_STEPS["export"], "Exporting reports…")
        export_paths = export_conform_results(accepted, output_dir, fps, label, export_fmts)

        result = {
            "status": "ok",
            "jobId": str(job.get("jobId") or session_id),
            "projectName": build_result.get("projectName", ""),
            "timelineName": build_result.get("timelineName", ""),
            "reviewQt": build_result.get("outputs", {}).get("reviewQt"),
            "exports": export_paths,
            "matchCount": len(accepted),
        }
        _upd(session_id, "complete", BUILD_STEPS["complete"],
             f"Conform complete. {len(accepted)} clips placed.")
        _finish(session_id, result)

    except Exception as exc:
        tb = traceback.format_exc()
        _fail_session(session_id, "RESOLVE_SCRIPT_FAILED",
                      f"Conform build failed: {exc}\n{tb}")


def start_conform_build(job: dict) -> str:
    """Start Phase 3 build in a background thread. Returns session_id."""
    session_id = str(uuid.uuid4())
    create_session(session_id, {
        "type": "conform_build",
        "step": "idle", "pct": 0, "message": "Starting…",
        "done": False,
    })
    t = threading.Thread(target=run_conform_build_async, args=(session_id, job), daemon=True)
    t.start()
    return session_id


def cancel_conform_job(session_id: str) -> bool:
    sess = get_session(session_id)
    if not sess:
        return False
    update_session(session_id, _cancel=True, message="Cancellation requested…")
    return True


def get_conform_status(session_id: str) -> dict | None:
    sess = get_session(session_id)
    if not sess:
        return None
    return dict(sess)
