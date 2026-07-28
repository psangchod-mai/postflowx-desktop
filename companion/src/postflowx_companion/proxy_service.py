from __future__ import annotations

import hashlib
import json
from pathlib import Path
import os
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import uuid
import wave
import xml.etree.ElementTree as ET

from . import safe_xml
from typing import Callable

from .service_state import create_session, get_session, remove_session, update_session
from .imf_scan import _parse_cpl as _scan_cpl
from .proxy_registry import (
    _default_proxy_cache_dir,
    get_proxy_root,
    content_fingerprint,
    lookup_proxy as _registry_lookup,
    register_proxy as _registry_register,
)

_IAB_PROXY_AUDIO_VALIDATION_VERSION = 2


def _lname(tag: str) -> str:
    return tag.split("}")[-1] if "}" in tag else tag


def _text(node: ET.Element | None, local_name: str) -> str:
    if node is None:
        return ""
    for child in node.iter():
        if _lname(child.tag) == local_name and child.text:
            return child.text.strip()
    return ""


def _clean_uuid(value: str) -> str:
    return (value or "").strip().lower().replace("urn:uuid:", "")


def _parse_rate(text: str, default: float = 24.0) -> float:
    try:
        parts = str(text or "").strip().split()
        if len(parts) >= 2 and float(parts[1]):
            return float(parts[0]) / float(parts[1])
        if len(parts) == 1 and float(parts[0]):
            return float(parts[0])
    except Exception:
        pass
    return default




def _stable_proxy_cache_key(folder: Path, cpl_path: Path) -> str:
    """Stable cache key for a specific IMF package + CPL selection.

    Includes file size / mtime for the CPL so edits to the XML naturally bust the
    cache. This is intentionally conservative but keeps refresh / reopen restores
    fast for the same package.
    """
    try:
        stat = cpl_path.stat()
        payload = f"{folder.resolve()}|{cpl_path.resolve()}|{stat.st_size}|{getattr(stat, 'st_mtime_ns', int(stat.st_mtime * 1_000_000_000))}"
    except Exception:
        payload = f"{folder.resolve()}|{cpl_path.resolve()}"
    return hashlib.sha1(payload.encode('utf-8', 'replace')).hexdigest()[:20]


def _safe_filename_component(value: str, fallback: str = "proxy") -> str:
    raw = str(value or "").strip()
    cleaned = ''.join(ch if ch.isalnum() or ch in ('-', '_', '.') else '_' for ch in raw)
    cleaned = cleaned.strip(' ._')
    while '__' in cleaned:
        cleaned = cleaned.replace('__', '_')
    return cleaned[:180] or fallback


def _proxy_target_stem(cpl_path: Path, cpl_data: dict | None = None, main_path: Path | None = None) -> str:
    label = _proxy_display_name(cpl_path, cpl_data, main_path)
    safe = _safe_filename_component(label, 'proxy')
    return f"{safe}_proxy"


def _sidecar_matches_target(sidecar: dict | None, folder: Path, cpl_path: Path) -> bool:
    if not isinstance(sidecar, dict):
        return False
    payload_folder = str(sidecar.get('folderPath') or '').strip()
    payload_cpl = str(sidecar.get('cplPath') or '').strip()
    if not payload_folder or not payload_cpl:
        return False
    try:
        return Path(payload_folder).expanduser().resolve() == folder.expanduser().resolve() and Path(payload_cpl).expanduser().resolve() == cpl_path.expanduser().resolve()
    except Exception:
        return False


def _proxy_display_name(cpl_path: Path, cpl_data: dict | None = None, main_path: Path | None = None) -> str:
    if _is_quicktime_like(main_path):
        try:
            qt_name = str(main_path.stem or '').strip()
            if qt_name:
                return qt_name
        except Exception:
            pass
    data = cpl_data or {}
    title = str(data.get('contentTitle') or data.get('annotation') or '').strip()
    if not title:
        try:
            parsed = _scan_cpl(cpl_path)
            title = str(parsed.get('contentTitle') or parsed.get('annotation') or '').strip()
        except Exception:
            title = ''
    return title or cpl_path.stem or 'proxy'


def _cpl_content_fingerprint(cpl_data: dict) -> str:
    """Compute the content-addressable fingerprint for a scanned CPL dict."""
    cpl_id = str(cpl_data.get("id") or "")
    video_tfids = [str(r.get("trackFileId") or "") for r in (cpl_data.get("videoResources") or []) if r.get("trackFileId")]
    audio_tfids = [str(t.get("trackFileId") or "") for t in (cpl_data.get("audioTracks") or []) if t.get("trackFileId")]
    all_tfids = list(dict.fromkeys(video_tfids + audio_tfids))  # preserve insert order, dedup
    return content_fingerprint(cpl_id, all_tfids, cpl_data.get("totalFrames") or 0, cpl_data.get("editRate") or 0.0)


def _current_proxy_quality() -> str:
    # Default: 'turbo' (854×480, lowres=3) — fastest J2K decode path for QC review proxies.
    # Override with PFX_IMF_PROXY_QUALITY=balanced (720p) or full (1080p) for higher quality.
    raw = str(os.environ.get('PFX_IMF_PROXY_QUALITY') or 'turbo').strip().lower()
    if raw in {'full', '1080', '1080p', 'hq', 'high'}:
        return 'full'
    if raw in {'balanced', 'balance', '540', '540p', '720', '720p'}:
        return 'balanced'
    if raw in {'turbo', 'fast', '480', '480p'}:
        return 'turbo'
    return 'turbo'


def _proxy_cache_path(folder: Path, cpl_path: Path, out_dir: str | None = None, cpl_data: dict | None = None, main_path: Path | None = None) -> Path:
    root = Path(out_dir).expanduser().resolve() if out_dir and Path(out_dir).is_dir() else _default_proxy_cache_dir()
    stem = _proxy_target_stem(cpl_path, cpl_data, main_path)
    clean_target = root / f"{stem}.mp4"
    key = _stable_proxy_cache_key(folder, cpl_path)
    clean_sidecar = _read_proxy_sidecar(clean_target)
    # A missing/unreadable sidecar means the existing clean_target's identity is
    # unknown, not confirmed-safe -- two unrelated projects can share the same
    # display-name stem (see _proxy_target_stem), so treating "no sidecar" as a
    # match let one project's encode silently overwrite (or get served) another
    # project's proxy. Fall through to the folder+cpl-keyed path instead.
    if not clean_target.exists() or _sidecar_matches_target(clean_sidecar, folder, cpl_path):
        return clean_target
    return root / f"{stem}__{key}.mp4"


def _path_eq(a: Path | None, b: Path | None) -> bool:
    try:
        if not a or not b:
            return False
        return a.expanduser().resolve() == b.expanduser().resolve()
    except Exception:
        return False


def _adopt_named_proxy_cache(folder: Path, cpl_path: Path, cache_path: Path, *, out_dir: str | None = None, cpl_data: dict | None = None, main_path: Path | None = None, start_timecode: str = '') -> Path:
    """Migrate older cache filenames to the current naming rule.

    This lets existing proxies named like pfx_imf_<session>.mp4 (or other legacy names)
    be transparently renamed to either the CPL ContentTitle-based cache filename or the
    original QuickTime filename-based cache filename.
    """
    try:
        desired = cache_path.expanduser().resolve()
    except Exception:
        return cache_path
    if _proxy_cache_is_valid(desired):
        try:
            _write_proxy_sidecar(desired, folderPath=str(folder), cplPath=str(cpl_path), proxyName=_proxy_display_name(cpl_path, cpl_data, main_path), startTimecode=start_timecode)
        except Exception:
            pass
        return desired

    root = desired.parent
    if not root.is_dir():
        return desired

    target_proxy_name = _proxy_display_name(cpl_path, cpl_data, main_path)
    target_sidecar = _proxy_sidecar_path(desired)
    for sidecar in sorted(root.glob('*.json')):
        try:
            payload = _read_proxy_sidecar(sidecar.with_suffix('.mp4')) if sidecar == target_sidecar else json.loads(_safe_read_text(sidecar) or '{}')
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            continue
        try:
            payload_folder = str(payload.get('folderPath') or '').strip()
            payload_cpl = str(payload.get('cplPath') or '').strip()
        except Exception:
            payload_folder = ''
            payload_cpl = ''
        if payload_folder and payload_cpl:
            try:
                if Path(payload_folder).expanduser().resolve() != folder.expanduser().resolve() or Path(payload_cpl).expanduser().resolve() != cpl_path.expanduser().resolve():
                    continue
            except Exception:
                continue
        else:
            continue

        raw_output = str(payload.get('outputPath') or '').strip()
        old_mp4 = Path(raw_output).expanduser().resolve() if raw_output else sidecar.with_suffix('.mp4').expanduser().resolve()
        # Accept legacy-named sources — the whole point of adopt is to rename pfx_imf_*.mp4
        try:
            if not (old_mp4.is_file() and old_mp4.stat().st_size > 0):
                continue
        except Exception:
            continue
        if _path_eq(old_mp4, desired):
            try:
                _write_proxy_sidecar(desired, folderPath=str(folder), cplPath=str(cpl_path), proxyName=target_proxy_name, startTimecode=start_timecode or str(payload.get('startTimecode') or ''))
            except Exception:
                pass
            return desired

        try:
            desired.parent.mkdir(parents=True, exist_ok=True)
        except Exception:
            pass
        try:
            if desired.exists():
                return desired
            old_mp4.replace(desired)
        except Exception:
            try:
                shutil.copyfile(old_mp4, desired)
            except Exception:
                continue
        for key, suffix in ((str(payload.get('progressPath') or '').strip(), '.progress'), (str(payload.get('logPath') or '').strip(), '.log')):
            if not key:
                continue
            try:
                src = Path(key).expanduser().resolve()
            except Exception:
                continue
            dst = desired.with_suffix(suffix)
            if _path_eq(src, dst) or not src.exists() or dst.exists():
                continue
            try:
                src.replace(dst)
            except Exception:
                pass
        try:
            _write_proxy_sidecar(desired,
                state=str(payload.get('state') or 'done'),
                pct=int(payload.get('pct') or 100),
                stage=str(payload.get('stage') or 'complete'),
                message=str(payload.get('message') or 'Proxy ready (renamed)'),
                done=bool(payload.get('done', True)),
                error=payload.get('error'),
                folderPath=str(folder),
                cplPath=str(cpl_path),
                durationMs=payload.get('durationMs'),
                progressPath=str(desired.with_suffix('.progress')),
                logPath=str(desired.with_suffix('.log')),
                proxyName=target_proxy_name,
                startTimecode=start_timecode or str(payload.get('startTimecode') or ''),
                # Carry over IAB-related fields so that renaming a proxy does not strip
                # audioMode / iabDirectTried from the sidecar.  Without these the stale-cache
                # check in start_proxy_playback sees audioMode="" and iabDirectTried=False,
                # which triggers a spurious rebuild of any renamed IAB proxy on next load.
                audioMode=str(payload.get('audioMode') or ''),
                audioMessage=str(payload.get('audioMessage') or ''),
                iabDirectTried=bool(payload.get('iabDirectTried', False)),
            )
            if sidecar.exists() and not _path_eq(sidecar, target_sidecar):
                try:
                    sidecar.unlink()
                except Exception:
                    pass
        except Exception:
            pass
        return desired
    return desired


def migrate_named_proxy_cache(root_dir: str | Path | None) -> int:
    try:
        if root_dir:
            root = Path(root_dir).expanduser().resolve()
        else:
            # Use active proxy root when no explicit dir provided
            root = get_proxy_root() or _default_proxy_cache_dir()
    except Exception:
        root = _default_proxy_cache_dir()
    if not root.is_dir():
        return 0
    moved = 0
    for sidecar_path in sorted(root.glob('*.json')):
        try:
            sidecar = json.loads(_safe_read_text(sidecar_path) or '{}')
        except Exception:
            sidecar = {}
        if not isinstance(sidecar, dict):
            continue
        folder_raw = str(sidecar.get('folderPath') or '').strip()
        cpl_raw = str(sidecar.get('cplPath') or '').strip()
        if not folder_raw or not cpl_raw:
            continue
        try:
            folder = Path(folder_raw).expanduser().resolve()
            cpl = Path(cpl_raw).expanduser().resolve()
        except Exception:
            continue
        current_mp4 = Path(str(sidecar.get('outputPath') or sidecar_path.with_suffix('.mp4'))).expanduser().resolve()
        if not _proxy_cache_is_valid(current_mp4):
            continue
        cpl_data = {}
        try:
            cpl_data = _scan_cpl(cpl)
        except Exception:
            pass
        main_path = _resolve_main_media_from_cpl(cpl, folder)
        desired = _proxy_cache_path(folder, cpl, str(root), cpl_data, main_path)
        if _path_eq(current_mp4, desired):
            try:
                _write_proxy_sidecar(desired, folderPath=str(folder), cplPath=str(cpl), proxyName=_proxy_display_name(cpl, cpl_data, main_path), startTimecode=str(sidecar.get('startTimecode') or ''))
            except Exception:
                pass
            continue
        before = str(current_mp4)
        adopted = _adopt_named_proxy_cache(folder, cpl, desired, out_dir=str(root), cpl_data=cpl_data, main_path=main_path, start_timecode=str(sidecar.get('startTimecode') or ''))
        if _path_eq(adopted, desired) and str(adopted) != before and _proxy_cache_is_valid(adopted):
            moved += 1
    return moved



def _is_legacy_named_proxy(path: Path | None) -> bool:
    try:
        if not path:
            return False
        return bool(__import__('re').match(r'^pfx(?:_imf)?_[^\\/]+\.mp4$', path.name, __import__('re').IGNORECASE))
    except Exception:
        return False

def _proxy_cache_is_valid(path: Path) -> bool:
    try:
        if _is_legacy_named_proxy(path):
            return False
        if not (path.is_file() and path.stat().st_size > 0):
            return False
        sidecar = _read_proxy_sidecar(path)
        if str(sidecar.get('audioMode') or '').strip() == 'resolve_iab':
            # Rebuild older Resolve/IAB proxies.  Previous builds let ffmpeg guess
            # the 7.1.4 -> stereo fold-down, which could leave dialogue/object
            # audio too low or missing in browser playback.
            if int(sidecar.get('audioValidationVersion') or 0) < _IAB_PROXY_AUDIO_VALIDATION_VERSION:
                return False
        current_quality = _current_proxy_quality()
        cached_quality = str(sidecar.get('proxyQuality') or '').strip().lower() if sidecar else ''
        if cached_quality:
            return cached_quality == current_quality
        # Older sidecars predate the fast proxy profiles. Rebuild by default so a
        # slow 1080p proxy is not silently reused when the user expects turbo.
        return current_quality == 'full'
    except Exception:
        return False


def _proxy_progress_path(cache_path: Path) -> Path:
    return cache_path.with_suffix('.progress')


def _proxy_log_path(cache_path: Path) -> Path:
    return cache_path.with_suffix('.log')


def _proxy_sidecar_path(cache_path: Path) -> Path:
    return cache_path.with_suffix('.json')


def _safe_unlink(path: Path) -> None:
    try:
        path.unlink()
    except Exception:
        pass


def _safe_read_text(path: Path) -> str:
    try:
        return path.read_text(encoding='utf-8', errors='replace')
    except Exception:
        return ''


def _read_ffmpeg_progress(path: Path) -> dict[str, str]:
    payload: dict[str, str] = {}
    raw = _safe_read_text(path)
    for line in raw.splitlines():
        if '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = str(key or '').strip()
        if not key:
            continue
        payload[key] = str(value or '').strip()
    return payload


def _proxy_sidecar_payload(cache_path: Path, **updates: object) -> dict[str, object]:
    data: dict[str, object] = {}
    try:
        existing = json.loads(_safe_read_text(_proxy_sidecar_path(cache_path)) or '{}')
        if isinstance(existing, dict):
            data.update(existing)
    except Exception:
        pass
    data.update(updates)
    data['outputPath'] = str(cache_path)
    data.setdefault('progressPath', str(_proxy_progress_path(cache_path)))
    data.setdefault('logPath', str(_proxy_log_path(cache_path)))
    data.setdefault('proxyQuality', _current_proxy_quality())
    if str(data.get('audioMode') or '').strip() == 'resolve_iab':
        data.setdefault('audioValidationVersion', _IAB_PROXY_AUDIO_VALIDATION_VERSION)
    data.setdefault('updatedAt', int(time.time() * 1000))
    return data


def _write_proxy_sidecar(cache_path: Path, **updates: object) -> dict[str, object]:
    payload = _proxy_sidecar_payload(cache_path, **updates)
    try:
        _proxy_sidecar_path(cache_path).write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    except Exception:
        pass
    return payload


def _read_proxy_sidecar(cache_path: Path) -> dict[str, object]:
    try:
        raw = _safe_read_text(_proxy_sidecar_path(cache_path))
        data = json.loads(raw or '{}')
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _is_pid_alive(pid: int | str | None) -> bool:
    try:
        value = int(pid or 0)
    except Exception:
        return False
    if value <= 0:
        return False
    try:
        os.kill(value, 0)
        return True
    except Exception:
        return False


def _restore_running_proxy_session(session_id: str, cache_path: Path, folder_path: str = '', cpl_path: str = '', audio_mode: str = 'unknown', audio_message: str = '') -> bool:
    sidecar = _read_proxy_sidecar(cache_path)
    if not sidecar:
        return False
    pid = sidecar.get('pid')
    part_path = Path(str(sidecar.get('partPath') or cache_path.with_name(f'.{cache_path.name}.{session_id}.part')))
    progress_path = Path(str(sidecar.get('progressPath') or _proxy_progress_path(cache_path)))
    log_path = Path(str(sidecar.get('logPath') or _proxy_log_path(cache_path)))
    if not (_is_pid_alive(pid) or part_path.exists()):
        return False
    dovi = {}
    if folder_path and cpl_path:
        try:
            dovi = _extract_dovi(Path(cpl_path).expanduser().resolve(), Path(folder_path).expanduser().resolve())
        except Exception:
            dovi = {}
    create_session(session_id, {
        'kind': 'proxy',
        'path': str(cache_path),
        'done': False,
        'pct': int(sidecar.get('pct') or 0),
        'stage': str(sidecar.get('stage') or 'restored_running'),
        'message': str(sidecar.get('message') or 'Proxy restore reattached to running transcode'),
        'error': None,
        'dovi': dovi,
        'audioMode': str(sidecar.get('audioMode') or audio_mode or 'unknown'),
        'audioMessage': str(sidecar.get('audioMessage') or audio_message or ''),
        'immersive': get_immersive_audio_support(),
        'proxyName': str(sidecar.get('proxyName') or ''),
        'startTimecode': str(sidecar.get('startTimecode') or ''),
        '_log': _safe_read_text(log_path) or ('[companion] restored_running=1\n' + f'[companion] output_path={cache_path}'),
        'proc': None,
    })

    def _watch() -> None:
        last_pct = int(sidecar.get('pct') or 0)
        while True:
            current = _read_proxy_sidecar(cache_path)
            progress = _read_ffmpeg_progress(progress_path)
            if current:
                try:
                    last_pct = max(last_pct, int(current.get('pct') or 0))
                except Exception:
                    pass
            try:
                if progress.get('progress') == 'end':
                    last_pct = 100
                elif progress.get('out_time_ms'):
                    # ffmpeg labels this out_time_ms, but the value is microseconds.
                    ms = int(str(progress.get('out_time_ms') or '0').strip() or '0') / 1000.0
                    duration_ms = int(current.get('durationMs') or sidecar.get('durationMs') or 0)
                    if duration_ms > 0:
                        last_pct = max(last_pct, min(99, int(ms / max(1, duration_ms) * 100)))
            except Exception:
                pass
            if _proxy_cache_is_valid(cache_path):
                # Re-read the sidecar now that the proxy is complete.  The sidecar is written
                # with the definitive audioMode/audioMessage *before* the rename (see
                # _transcode_worker), so this fresh read captures the correct mode even when
                # the companion was restarted mid-transcode and the original worker's session
                # state is gone.
                _done_sidecar = _read_proxy_sidecar(cache_path)
                _done_mode = str((_done_sidecar.get('audioMode') if _done_sidecar else '') or (current.get('audioMode') if isinstance(current, dict) else '') or sidecar.get('audioMode') or 'unknown')
                _done_msg = str((_done_sidecar.get('audioMessage') if _done_sidecar else '') or (current.get('audioMessage') if isinstance(current, dict) else '') or sidecar.get('audioMessage') or '')
                update_session(session_id, done=True, pct=100, stage='complete', message='Proxy ready (restored)', path=str(cache_path), proxyName=str((current.get('proxyName') if isinstance(current, dict) else '') or sidecar.get('proxyName') or ''), startTimecode=str((current.get('startTimecode') if isinstance(current, dict) else '') or sidecar.get('startTimecode') or ''), audioMode=_done_mode, audioMessage=_done_msg, error=None, _log=_safe_read_text(log_path))
                _write_proxy_sidecar(cache_path, state='done', pct=100, stage='complete', message='Proxy ready (restored)', done=True, error=None, audioMode=_done_mode, audioMessage=_done_msg)
                return
            if current and current.get('error'):
                update_session(session_id, done=True, pct=max(0, min(99, last_pct)), stage='failed', message=str(current.get('error')), error=str(current.get('error')))
                return
            if not (_is_pid_alive((current.get('pid') if current else None) or pid) or part_path.exists()):
                update_session(session_id, done=True, pct=max(0, min(99, last_pct)), stage='failed', message='Proxy job was interrupted before cache finished', error='proxy_interrupted')
                _write_proxy_sidecar(cache_path, state='failed', pct=max(0, min(99, last_pct)), stage='failed', message='Proxy job was interrupted before cache finished', done=True, error='proxy_interrupted')
                return
            update_session(session_id, pct=max(0, min(99, last_pct)), stage='restored_running', message=f'Reattaching proxy transcode… {max(0, min(99, last_pct))}%')
            time.sleep(0.5)

    threading.Thread(target=_watch, daemon=True).start()
    return True

def _resource_bin(name: str) -> str | None:
    """Locate a helper binary (ffmpeg/ffprobe), preferring a binary BUNDLED in the
    .app over the dev machine's Homebrew/PATH copy (Dev Brief P0#2).

    Priority:
      1. PFX_<NAME>_BIN env override (explicit)
      2. A bundled binary under any ancestor's bin/ or Resources/bin/ — packaged
         layout is .app/Contents/Resources/bin/<name>; this file lives at
         .app/Contents/Resources/companion/src/postflowx_companion/proxy_service.py,
         so climbing parents finds Resources/bin/. Production must NOT depend on
         /opt/homebrew — a GUI-launched companion inherits a stripped PATH.
      3. PATH (shutil.which)
      4. Common Homebrew / local install locations (dev fallback)
    """
    env = str(os.environ.get(f"PFX_{name.upper()}_BIN") or "").strip()
    if env and os.path.isfile(env) and os.access(env, os.X_OK):
        return env
    here = Path(__file__).resolve()
    for parent in here.parents:
        for cand in (parent / "bin" / name, parent / "Resources" / "bin" / name):
            if cand.is_file() and os.access(str(cand), os.X_OK):
                return str(cand)
    on_path = shutil.which(name)
    if on_path:
        return on_path
    for p in (f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}", f"/usr/bin/{name}"):
        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def _find_ffmpeg() -> str | None:
    return _resource_bin("ffmpeg")


def _find_ffprobe(ffmpeg_path: str | None = None) -> str | None:
    # A sibling next to a resolved ffmpeg wins (keeps bundled ffmpeg + ffprobe paired).
    if ffmpeg_path:
        try:
            sib = Path(ffmpeg_path).with_name("ffprobe")
            if sib.is_file() and os.access(str(sib), os.X_OK):
                return str(sib)
        except Exception:
            pass
    return _resource_bin("ffprobe")


def _find_art_cmd() -> str | None:
    """Find ARRI Reference Tool CMD (art_cmd) — free download from arri.com."""
    env_path = str(os.environ.get("PFX_ART_CMD") or "").strip()
    candidates = [
        env_path,
        # macOS app bundle (default install location)
        "/Applications/ARRI Reference Tool CMD.app/Contents/MacOS/art_cmd",
        "/Applications/ARRI Reference Tool.app/Contents/MacOS/art_cmd",
        shutil.which("art_cmd"),
        "/usr/local/bin/art_cmd",
        "/opt/homebrew/bin/art_cmd",
    ]
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def _find_arc_cmd() -> str | None:
    """Find legacy ARRIRAW Converter CMD (arc_cmd) — free download from arri.com."""
    env_path = str(os.environ.get("PFX_ARC_CMD") or "").strip()
    candidates = [
        env_path,
        # macOS app bundle locations (ARRIRAW Converter 4.x)
        "/Applications/ARRIRAW Converter CMD.app/Contents/MacOS/arc_cmd",
        "/Applications/ARC CMD.app/Contents/MacOS/arc_cmd",
        shutil.which("arc_cmd"),
        "/usr/local/bin/arc_cmd",
        "/opt/homebrew/bin/arc_cmd",
    ]
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def _find_redline() -> str | None:
    """Find REDline CLI — free download from red.com (REDCODE RAW decoder)."""
    env_path = str(os.environ.get("PFX_REDLINE") or "").strip()
    candidates = [
        env_path,
        "/Applications/REDline.app/Contents/MacOS/REDline",
        "/Applications/REDCINE-X PRO.app/Contents/MacOS/REDline",
        shutil.which("REDline"),
        "/usr/local/bin/REDline",
        "/opt/homebrew/bin/REDline",
    ]
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def _red_transcode_to_h264(
    media_path: str,
    output_mp4: str,
    ffmpeg_path: str | None,
    ffprobe_path: str | None,
    on_status: "Callable[[str], None] | None" = None,
) -> tuple[bool, str]:
    """Decode RED R3D → H.264 MP4 via REDline + ffmpeg.

    Returns (success: bool, error_message: str).
    """
    redline = _find_redline()
    if not redline:
        return False, "RED_NO_TOOL"
    if not ffmpeg_path:
        return False, "ffmpeg not found"

    path = Path(media_path)
    out_mp4 = Path(output_mp4)

    with tempfile.TemporaryDirectory(prefix="pfx_red_") as tmp_dir:
        tmp = Path(tmp_dir)
        prores_dir = tmp / "prores_out"
        prores_dir.mkdir()

        on_status and on_status("Decoding RED RAW via REDline…")

        # REDline exports to a directory — try double-dash flags first
        cmd1 = [
            redline,
            "--i", str(path),
            "--export",
            "--format", "qt",
            "--codec", "prores_proxy",
            "--dst", str(prores_dir),
        ]
        r1 = subprocess.run(cmd1, capture_output=True, timeout=600)
        prores_files = sorted(prores_dir.glob("*.mov")) + sorted(prores_dir.glob("*.MOV"))

        if r1.returncode != 0 or not prores_files:
            # Older REDline versions use single-dash flags
            cmd1_alt = [
                redline,
                "-i", str(path),
                "-export",
                "-format", "qt",
                "-codec", "prores_proxy",
                "-dst", str(prores_dir),
            ]
            r1 = subprocess.run(cmd1_alt, capture_output=True, timeout=600)
            prores_files = sorted(prores_dir.glob("*.mov")) + sorted(prores_dir.glob("*.MOV"))

        if not prores_files:
            stderr = (r1.stderr or b'')[-400:].decode('utf-8', errors='replace').strip()
            return False, f"REDline failed (exit {r1.returncode}): {stderr}"

        on_status and on_status("Encoding H.264 preview proxy…")
        tmp_mp4 = tmp / "out.mp4"
        vf = "scale='min(1280,iw)':-2:flags=lanczos,format=yuv420p"
        cmd2 = [
            ffmpeg_path, "-y",
            "-i", str(prores_files[0]),
            "-vf", vf,
            "-c:v", "libx264", "-preset", "fast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k", "-ac", "2",
            "-movflags", "+faststart",
            "-f", "mp4", str(tmp_mp4),
        ]
        r2 = subprocess.run(cmd2, capture_output=True, timeout=600)
        if r2.returncode != 0 or not tmp_mp4.is_file() or tmp_mp4.stat().st_size == 0:
            stderr = (r2.stderr or b'')[-400:].decode('utf-8', errors='replace').strip()
            return False, f"ffmpeg encode failed (exit {r2.returncode}): {stderr}"

        import shutil as _shutil
        _shutil.copy2(str(tmp_mp4), output_mp4)

    return True, ""


def _arriraw_transcode_to_h264(
    media_path: str,
    output_mp4: str,
    ffmpeg_path: str,
    ffprobe_path: str | None,
    on_status: "Callable[[str], None] | None" = None,
) -> tuple[bool, str]:
    """Decode ARRIRAW MXF → H.264 MP4 via ART CMD or arc_cmd + ffmpeg.

    Returns (success: bool, error_message: str).
    Uses a temp directory that is always cleaned up.
    """
    import tempfile, glob

    art_cmd = _find_art_cmd()
    arc_cmd = _find_arc_cmd()
    if not art_cmd and not arc_cmd:
        return False, (
            "No ARRIRAW decoder found. "
            "Download ARRI Reference Tool CMD (free) from arri.com "
            "or set the PFX_ART_CMD environment variable to its path."
        )

    path = Path(media_path)
    out_mp4 = Path(output_mp4)

    with tempfile.TemporaryDirectory(prefix="pfx_arriraw_") as tmp_dir:
        tmp = Path(tmp_dir)

        # ── Step 1: ARRIRAW → intermediate (ProRes .mov or EXR sequence) ──────
        if art_cmd:
            on_status and on_status("Decoding ARRIRAW via ART CMD…")
            prores_out = tmp / (path.stem + "_proxy.mov")
            cmd1 = [
                art_cmd, "process",
                "--input", str(path),
                "--output", str(prores_out),
                "--video-codec", "prores_proxy",
            ]
            r1 = subprocess.run(cmd1, capture_output=True, timeout=600)
            if r1.returncode != 0 or not prores_out.is_file() or prores_out.stat().st_size == 0:
                # ART CMD flags differ between versions — try alternate flag style
                cmd1_alt = [
                    art_cmd,
                    "-i", str(path),
                    "-o", str(prores_out),
                    "--format", "qt_prores",
                    "--prores-profile", "proxy",
                ]
                r1 = subprocess.run(cmd1_alt, capture_output=True, timeout=600)
            if r1.returncode != 0 or not prores_out.is_file() or prores_out.stat().st_size == 0:
                stderr = (r1.stderr or b'')[-400:].decode('utf-8', errors='replace').strip()
                return False, f"ART CMD failed (exit {r1.returncode}): {stderr}"
            intermediate = str(prores_out)
            use_sequence = False

        else:
            # arc_cmd (legacy) outputs EXR sequences using an XML settings file
            on_status and on_status("Decoding ARRIRAW via arc_cmd…")
            exr_dir = tmp / "exr"
            exr_dir.mkdir()
            settings_xml = tmp / "pfx_arc_settings.xml"
            settings_xml.write_text(
                f'<ArrirRawConverterSettings>'
                f'<Output Directory="{exr_dir}" Format="exr" Compression="piz"/>'
                f'</ArrirRawConverterSettings>',
                encoding="utf-8",
            )
            cmd1 = [arc_cmd, "-c", str(settings_xml), str(path)]
            r1 = subprocess.run(cmd1, capture_output=True, timeout=600)
            exr_files = sorted(glob.glob(str(exr_dir / "*.exr")))
            if r1.returncode != 0 or not exr_files:
                stderr = (r1.stderr or b'')[-400:].decode('utf-8', errors='replace').strip()
                return False, f"arc_cmd failed (exit {r1.returncode}): {stderr}"
            intermediate = str(exr_dir / "%06d.exr")
            use_sequence = True

        # ── Step 2: intermediate → H.264 MP4 via ffmpeg ───────────────────────
        on_status and on_status("Encoding H.264 preview proxy…")
        tmp_mp4 = tmp / "out.mp4"
        vf = "scale='min(1280,iw)':-2:flags=lanczos,format=yuv420p"
        if use_sequence:
            # Detect FPS from original file
            fps = "24"
            if ffprobe_path:
                try:
                    rp = subprocess.run(
                        [ffprobe_path, "-v", "quiet", "-select_streams", "v:0",
                         "-show_entries", "stream=r_frame_rate",
                         "-of", "csv=p=0", str(path)],
                        capture_output=True, timeout=15,
                    )
                    raw_fps = rp.stdout.decode().strip()
                    if "/" in raw_fps:
                        n, d = raw_fps.split("/")
                        fps = f"{int(n)/max(1,int(d)):.3f}"
                except Exception:
                    pass
            cmd2 = [
                ffmpeg_path, "-y",
                "-framerate", fps,
                "-i", intermediate,
                "-vf", vf,
                "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                "-movflags", "+faststart",
                "-f", "mp4", str(tmp_mp4),
            ]
        else:
            cmd2 = [
                ffmpeg_path, "-y",
                "-i", intermediate,
                "-vf", vf,
                "-c:v", "libx264", "-preset", "fast", "-crf", "23",
                "-c:a", "aac", "-b:a", "128k", "-ac", "2",
                "-movflags", "+faststart",
                "-f", "mp4", str(tmp_mp4),
            ]
        r2 = subprocess.run(cmd2, capture_output=True, timeout=600)
        if r2.returncode != 0 or not tmp_mp4.is_file() or tmp_mp4.stat().st_size == 0:
            stderr = (r2.stderr or b'')[-400:].decode('utf-8', errors='replace').strip()
            return False, f"ffmpeg H.264 encode failed (exit {r2.returncode}): {stderr}"

        # Move finished file out of the temp dir before cleanup
        import shutil as _shutil
        _shutil.copy2(str(tmp_mp4), output_mp4)

    return True, ""


def _find_avconvert() -> str | None:
    """Find macOS avconvert — standard system tool using AVFoundation.

    Decodes any format whose codec is installed system-wide: ARRIRAW (ARRI
    codec pack / Final Cut Pro), R3D (RED Plugin for Mac / REDCINE-X PRO),
    BRAW (Blackmagic Desktop Video), ProRes RAW, etc.  Available on macOS 10.7+.
    """
    candidates = ["/usr/bin/avconvert", shutil.which("avconvert")]
    for c in candidates:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def _avconvert_transcode_to_h264(
    media_path: str,
    output_mp4: str,
    ffmpeg_path: str | None,
    on_status: "Callable[[str], None] | None" = None,
) -> tuple[bool, str]:
    """Decode via macOS AVFoundation (avconvert) → H.264 MP4.

    Works for any codec that is installed in the macOS system (ARRIRAW, R3D,
    BRAW, ProRes RAW …) regardless of whether ffmpeg supports it.
    Returns (success, error_message).
    """
    avconvert = _find_avconvert()
    if not avconvert:
        return False, "avconvert not found (macOS only)"

    path = Path(media_path)

    with tempfile.TemporaryDirectory(prefix="pfx_avc_") as tmp_dir:
        tmp = Path(tmp_dir)
        tmp_mov = tmp / "out.mov"

        on_status and on_status("Decoding via system codec (AVFoundation)…")
        cmd = [
            avconvert,
            "--preset", "Preset1280x720",
            "--source", str(path),
            "--output", str(tmp_mov),
            "--replace",
        ]
        r = subprocess.run(cmd, capture_output=True, timeout=600)
        if r.returncode != 0 or not tmp_mov.is_file() or tmp_mov.stat().st_size == 0:
            stderr = (r.stderr or b'')[-400:].decode('utf-8', errors='replace').strip()
            return False, f"avconvert failed (exit {r.returncode}): {stderr}"

        on_status and on_status("Optimising for web streaming…")
        if ffmpeg_path:
            # Re-mux MOV→MP4 with faststart (container change only, no re-encode)
            tmp_mp4 = tmp / "final.mp4"
            r2 = subprocess.run(
                [ffmpeg_path, "-y", "-i", str(tmp_mov),
                 "-c", "copy", "-movflags", "+faststart",
                 "-f", "mp4", str(tmp_mp4)],
                capture_output=True, timeout=120,
            )
            if r2.returncode == 0 and tmp_mp4.is_file() and tmp_mp4.stat().st_size > 0:
                shutil.copy2(str(tmp_mp4), output_mp4)
                return True, ""
        # Fallback: serve the .mov directly (Chrome/Safari can play H.264 in .mov)
        shutil.copy2(str(tmp_mov), output_mp4)

    return True, ""


def _find_iab_decoder_adapter() -> str | None:
    env_path = str(os.environ.get("PFX_IAB_DECODER") or "").strip()
    candidates = [
        env_path,
        "/usr/local/lib/postflowx/iab_decode_adapter",
        "/usr/local/bin/postflowx-iab-adapter",
        "/opt/homebrew/bin/postflowx-iab-adapter",
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def _probe_iab_decoder_adapter(adapter_path: str | None) -> dict:
    if not adapter_path:
        return {
            "configured": False,
            "ready": False,
            "engineId": "",
            "engineLabel": "",
            "userMessage": "",
            "blockers": [],
            "notes": [],
        }
    try:
        result = subprocess.run(
            [adapter_path, "--probe-json"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        payload = json.loads((result.stdout or "").strip() or "{}")
        ready = bool(payload.get("ready"))
        return {
            "configured": True,
            "ready": ready,
            "engineId": str(payload.get("engineId") or "external-iab-adapter"),
            "engineLabel": str(payload.get("engineLabel") or "External IAB decoder"),
            "userMessage": str(payload.get("userMessage") or ("External IAB decoder is ready." if ready else "External IAB decoder is installed but not ready.")),
            "blockers": [str(x) for x in (payload.get("blockers") or []) if str(x).strip()],
            "notes": [str(x) for x in (payload.get("notes") or []) if str(x).strip()],
        }
    except Exception as exc:
        return {
            "configured": True,
            "ready": False,
            "engineId": "external-iab-adapter",
            "engineLabel": "External IAB decoder",
            "userMessage": "External IAB decoder adapter is installed but did not respond.",
            "blockers": [f"Adapter probe failed: {exc}"],
            "notes": [f"Adapter path: {adapter_path}"],
        }


def _check_imf_demuxer(ffmpeg_path: str) -> bool:
    try:
        result = subprocess.run(
            [ffmpeg_path, "-formats", "-hide_banner"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return " imf " in f" {result.stdout.lower()} " or "\nimf" in result.stdout.lower()
    except Exception:
        return False


def _ffmpeg_list_supports(ffmpeg_path: str | None, flag: str, probes: tuple[str, ...]) -> bool:
    if not ffmpeg_path:
        return False
    try:
        result = subprocess.run(
            [ffmpeg_path, flag, "-hide_banner"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        haystack = f" {(result.stdout or '').lower()} {(result.stderr or '').lower()} "
        return any(probe.lower() in haystack for probe in probes)
    except Exception:
        return False


_immersive_support_cache: dict | None = None
_immersive_support_cache_ts: float = 0.0
_IMMERSIVE_SUPPORT_TTL = 60.0  # seconds


def invalidate_immersive_support_cache() -> None:
    global _immersive_support_cache, _immersive_support_cache_ts
    _immersive_support_cache = None
    _immersive_support_cache_ts = 0.0


def get_immersive_audio_support(ffmpeg_path: str | None = None) -> dict:
    global _immersive_support_cache, _immersive_support_cache_ts
    now = time.monotonic()
    if _immersive_support_cache is not None and (now - _immersive_support_cache_ts) < _IMMERSIVE_SUPPORT_TTL:
        return _immersive_support_cache
    try:
        result = _compute_immersive_audio_support(ffmpeg_path)
    except Exception as exc:
        result = {
            "ready": False,
            "iabDecode": False,
            "admDecode": False,
            "admExtract": True,
            "engineId": "",
            "engineLabel": "Unavailable",
            "ffmpegPath": "",
            "ffprobePath": "",
            "adapterPath": "",
            "adapterConfigured": False,
            "imfDemuxer": False,
            "userMessage": "Could not detect IAB decode capabilities.",
            "blockers": [f"Capability probe failed: {exc}"],
            "notes": ["Embedded ADM / AXML inspection still works inside PostFlowX"],
        }
    _immersive_support_cache = result
    _immersive_support_cache_ts = now
    return result


def _compute_immersive_audio_support(ffmpeg_path: str | None = None) -> dict:
    resolved_ffmpeg = ffmpeg_path or _find_ffmpeg()
    ffprobe_path = _find_ffprobe(resolved_ffmpeg) if resolved_ffmpeg else None
    imf_demuxer = _check_imf_demuxer(resolved_ffmpeg) if resolved_ffmpeg else False
    adapter_path = _find_iab_decoder_adapter()
    adapter = _probe_iab_decoder_adapter(adapter_path)
    resolve_ready = False
    try:
        from .engines.resolve_engine import resolve_engine_status
        _resolve_status = resolve_engine_status()
        resolve_ready = bool(_resolve_status.get("connected") and _resolve_status.get("apiAvailable"))
    except Exception:
        resolve_ready = False
    iab_decode = _ffmpeg_list_supports(
        resolved_ffmpeg,
        "-decoders",
        (" iab ", "\niab ", " dolby atmos ", " dolby_atmos ", " immersive audio bitstream "),
    )

    blockers: list[str] = []
    notes: list[str] = []
    if adapter.get("ready"):
        notes.append(f"Using external IAB decoder adapter: {adapter.get('engineLabel') or adapter.get('engineId')}")
    elif resolve_ready:
        notes.append("Using Resolve Engine for IMF/IAB proxy audio when available")
    elif adapter.get("configured"):
        blockers.extend(adapter.get("blockers") or [])
        notes.extend(adapter.get("notes") or [])

    if not resolved_ffmpeg:
        blockers.append("ffmpeg is not installed")
    else:
        if not iab_decode and not resolve_ready:
            blockers.append("Current ffmpeg build has no IAB / Dolby Atmos decoder")
        if not imf_demuxer:
            notes.append("IMF demuxer is missing, so PostFlowX falls back to full-CPL video assembly for proxy builds")
    notes.append("Embedded ADM / AXML inspection is available in PostFlowX")

    ready = bool(adapter.get("ready") or resolve_ready or (resolved_ffmpeg and iab_decode and imf_demuxer))
    effective_iab_decode = bool(adapter.get("ready") or resolve_ready or iab_decode)
    engine_id = str(adapter.get("engineId") or ("resolve-engine" if resolve_ready else "ffmpeg-immersive" if ready else ""))
    engine_label = str(adapter.get("engineLabel") or ("Resolve Engine" if resolve_ready else "ffmpeg immersive decode" if ready else "No local immersive decoder"))
    if adapter.get("ready"):
        user_message = str(adapter.get("userMessage") or "External IAB decoder is ready.")
    elif adapter.get("configured"):
        user_message = str(adapter.get("userMessage") or "External IAB decoder adapter is installed but not ready.")
    elif resolve_ready:
        user_message = "Resolve Engine is connected and will be used for IAB / Dolby Atmos proxy audio."
    elif ready:
        user_message = "IAB decode is ready via local ffmpeg."
    else:
        user_message = "No external IAB decoder adapter is configured, and local ffmpeg cannot decode IAB PCM."
    return {
        "ready": ready,
        "iabDecode": effective_iab_decode,
        # iabDecodeNative = True only when ffmpeg itself has an IAB decoder.
        # Unlike iabDecode, this is NOT set by Resolve or the adapter — it
        # indicates whether native ffmpeg can handle IAB directly in ffmpeg
        # commands (e.g. -map 1:a:0 on an IAB MXF).
        "iabDecodeNative": bool(iab_decode),
        "admDecode": False,
        "admExtract": True,
        "engineId": engine_id,
        "engineLabel": engine_label,
        "ffmpegPath": resolved_ffmpeg or "",
        "ffprobePath": ffprobe_path or "",
        "adapterPath": adapter_path or "",
        "adapterConfigured": bool(adapter.get("configured")),
        "imfDemuxer": bool(imf_demuxer),
        "userMessage": user_message,
        "blockers": blockers,
        "notes": notes,
    }


def _fast_move(src: Path, dst: Path) -> None:
    """Move src → dst using the fastest available method on the current filesystem.

    Priority: hardlink (instant, same-FS) → rename (atomic, same-FS) → copy+delete.
    Falls back gracefully so callers don't need to handle FS edge cases.
    """
    dst.parent.mkdir(parents=True, exist_ok=True)
    # 1. Try hardlink — zero-cost on same filesystem, preserves the original
    try:
        if dst.exists():
            dst.unlink()
        os.link(src, dst)
        return
    except OSError:
        pass
    # 2. Rename — atomic on same filesystem, slightly more expensive than link
    try:
        src.rename(dst)
        return
    except OSError:
        pass
    # 3. Copy+delete — cross-filesystem fallback
    shutil.copy2(str(src), str(dst))
    try:
        src.unlink()
    except OSError:
        pass


def _run_iab_adapter_decode(adapter_path: str, asset_path: Path, out_path: Path, logs: list[str]) -> tuple[bool, str]:
    cmd = [
        adapter_path,
        "decode",
        "--input",
        str(asset_path),
        "--output",
        str(out_path),
    ]
    logs.append(f"[companion] adapter_cmd={' '.join(cmd)}")
    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=1800,
    )
    if result.stdout:
        logs.extend(line.rstrip() for line in result.stdout.splitlines() if line.strip())
    if result.stderr:
        logs.extend(line.rstrip() for line in result.stderr.splitlines() if line.strip())
    if result.returncode == 0 and out_path.is_file() and out_path.stat().st_size > 0:
        return True, ""
    detail = " | ".join((result.stderr or result.stdout or "").strip().splitlines()[-8:]) or f"adapter exited with {result.returncode}"
    return False, detail[:320]


def _find_assetmaps(folder: Path) -> list[Path]:
    # SMPTE ST 0429-9 allows both ASSETMAP.xml and ASSETMAP (no extension).
    found: list[Path] = []
    for p in folder.rglob("*"):
        if p.is_file() and p.name.lower() in {"assetmap.xml", "assetmap"}:
            found.append(p)
    return sorted(found)


def _build_asset_path_map(folder: Path, *, include_siblings: bool = False) -> dict[str, Path]:
    """Build UUID → Path map from all ASETMAPs in folder.

    When include_siblings=True, also reads ASETMAPs in sibling directories (one
    level up from folder).  This resolves VF/supplemental packages that reference
    reels from an OV stored as a sibling UUID folder in the same IMF root.
    """
    # Collect all ASSETMAP files to parse: always include the selected folder.
    # When include_siblings=True, also parse sibling UUID-folder ASETMAPs so that
    # a VF package's CPL can find OV MXFs stored next to it.
    search_dirs: list[Path] = [folder]
    if include_siblings:
        try:
            for _sib in folder.parent.iterdir():
                if _sib.is_dir() and _sib != folder:
                    search_dirs.append(_sib)
        except Exception:
            pass

    id_to_path: dict[str, Path] = {}
    for search_dir in search_dirs:
        for assetmap_path in _find_assetmaps(search_dir):
            base_dir = assetmap_path.parent
            try:
                root = safe_xml.parse_path(assetmap_path).getroot()
            except Exception:
                continue
            for asset in root.iter():
                if _lname(asset.tag) != "Asset":
                    continue
                asset_id = ""
                asset_path: Path | None = None
                for child in list(asset):
                    name = _lname(child.tag)
                    if name == "Id" and child.text:
                        asset_id = _clean_uuid(child.text)
                    elif name == "ChunkList":
                        for chunk in list(child):
                            for part in list(chunk):
                                if _lname(part.tag) == "Path" and part.text:
                                    maybe = (base_dir / part.text.strip()).resolve()
                                    if maybe.is_file():
                                        asset_path = maybe
                    elif name == "Path" and child.text and asset_path is None:
                        maybe = (base_dir / child.text.strip()).resolve()
                        if maybe.is_file():
                            asset_path = maybe
                if asset_id and asset_path:
                    # Don't overwrite entries already found in the primary folder
                    if asset_id not in id_to_path:
                        id_to_path[asset_id] = asset_path
    return id_to_path


def _parse_cpl_video_segments(cpl_path: Path) -> list[dict[str, float | int | str]]:
    segments: list[dict[str, float | int | str]] = []
    root = safe_xml.parse_path(cpl_path).getroot()
    top_rate = _parse_rate(_text(root, "EditRate"), 24.0)
    for seq in root.iter():
        if _lname(seq.tag) not in ("MainImageSequence", "ImageSequence"):
            continue
        res_list = next((child for child in list(seq) if _lname(child.tag) == "ResourceList"), None) or seq
        for res in list(res_list):
            if _lname(res.tag) not in ("Resource", "TrackFileResource"):
                continue
            track_id = _clean_uuid(_text(res, "TrackFileId"))
            intrinsic = int(_text(res, "IntrinsicDuration") or "0")
            duration = int(_text(res, "SourceDuration") or str(intrinsic or 0))
            entry = int(_text(res, "EntryPoint") or "0")
            repeat = max(1, int(_text(res, "RepeatCount") or "1"))
            res_rate = _parse_rate(_text(res, "EditRate"), top_rate)
            if track_id and duration > 0:
                segments.append({
                    "track_id": track_id,
                    "entry": entry,
                    "duration": duration,
                    "repeat": repeat,
                    "rate": res_rate,
                })
    return segments


def _build_mxf_index(*search_roots: Path) -> dict[str, Path]:
    """Scan search_roots for .mxf files and return a dict keyed by lowercased stem.

    Also registers UUID-prefixed keys (first 5 hyphen-separated segments of the
    stem) so files whose full names differ from their UUID still match.
    This is used as a fallback when the ASSETMAP doesn't cover all reels —
    common for VF/supplemental packages whose OV MXFs live in sibling folders.
    """
    index: dict[str, Path] = {}
    for root in search_roots:
        try:
            for _p in root.rglob("*"):
                if _p.suffix.lower() != ".mxf" or not _p.is_file():
                    continue
                stem_lc = _p.stem.lower()
                if stem_lc not in index:
                    index[stem_lc] = _p
                # UUID prefix (handles renamed files whose name starts with UUID)
                parts = stem_lc.replace("_", "-").split("-")
                if len(parts) >= 5:
                    uuid_key = "-".join(parts[:5])
                    if uuid_key not in index:
                        index[uuid_key] = _p
        except Exception:
            pass
    return index


def _build_cpl_segment_inputs(cpl_path: Path, folder: Path) -> tuple[list[dict[str, float | int | str]], str | None]:
    # include_siblings=True so VF packages can find OV reels in sibling UUID folders
    asset_map = _build_asset_path_map(folder, include_siblings=True)
    segments = _parse_cpl_video_segments(cpl_path)
    if not segments:
        return [], "No video resources found in selected CPL"

    # MXF fallback index — handles VF/supplemental packages where some reels live in
    # a sibling OV folder.  We scan:
    #   1. The selected VF folder itself (catches reels stored alongside the CPL)
    #   2. Sibling UUID folders in the same parent dir (the typical OV layout:
    #      /IMF_ROOT/<ov_uuid>/   ← OV MXFs
    #      /IMF_ROOT/<vf_uuid>/   ← VF CPL + new reels  ← folder arg points here)
    _search_roots: list[Path] = [folder]
    try:
        parent = folder.parent
        for _sib in parent.iterdir():
            if _sib.is_dir() and _sib != folder:
                _search_roots.append(_sib)
    except Exception:
        pass
    # Also try the ASSETMAP-declared root paths in case the package spans volumes
    for _am_path in list(asset_map.values()):
        if _am_path and _am_path.parent not in _search_roots:
            _search_roots.append(_am_path.parent)
    _mxf_index = _build_mxf_index(*_search_roots)

    inputs: list[dict[str, float | int | str]] = []
    missing = 0
    missing_ids: list[str] = []
    for segment in segments:
        tid = str(segment["track_id"])
        mxf_path = asset_map.get(tid)
        if not mxf_path or not mxf_path.is_file():
            mxf_path = _mxf_index.get(tid.lower())
        if not mxf_path or not mxf_path.is_file():
            missing += 1
            missing_ids.append(tid[:8])
            continue
        inpoint = max(0.0, float(segment["entry"]) / float(segment["rate"]))
        duration_sec = max(0.0, float(segment["duration"]) / float(segment["rate"]))
        for _ in range(max(1, int(segment["repeat"]))):
            inputs.append({
                "path": str(mxf_path),
                "inpoint": inpoint,
                "duration": duration_sec,
            })

    if not inputs:
        _missing_hint = ""
        if missing_ids:
            _missing_hint = (
                f" — CPL references {len(segments)} video reel(s) but none were found on disk."
                f" Missing IDs: {', '.join(missing_ids[:4])}{'…' if len(missing_ids) > 4 else ''}."
                f" If this is a VF/supplemental package, ensure the OV package folder is"
                f" accessible in the same parent directory."
            )
        return [], f"No playable video MXFs resolved from selected CPL{_missing_hint}"

    note = f"CPL segment list built with {missing} missing reel(s) skipped" if missing else None
    return inputs, note


def _parse_cpl_audio_segments(cpl_path: Path, pcm_track_ids: set[str] | None = None) -> list[dict]:
    """Parse the first PCM audio sequence from a CPL.

    Returns a list of segment dicts (track_id, entry, duration, repeat, rate).
    Skips video/image sequences and IAB/immersive sequences.
    When pcm_track_ids is provided, only resources whose trackFileId is in the set
    are included (used to exclude IAB by track ID rather than sequence name).
    """
    root = safe_xml.parse_path(cpl_path).getroot()
    top_rate = _parse_rate(_text(root, "EditRate"), 24.0)

    _SKIP_IMAGE = {"MainImageSequence", "ImageSequence"}
    _SKIP_KEYWORDS = ("iab", "immersive", "atmos", "subtitle", "caption", "text", "sign")

    # Collect resources grouped by audio sequence type (preserving CPL document order)
    by_seq_type: dict[str, list[dict]] = {}
    for el in root.iter():
        seq_type = _lname(el.tag)
        if seq_type in _SKIP_IMAGE or "Image" in seq_type:
            continue
        if any(k in seq_type.lower() for k in _SKIP_KEYWORDS):
            continue
        res_list = next((c for c in list(el) if _lname(c.tag) == "ResourceList"), None)
        if res_list is None:
            continue
        for res in list(res_list):
            if _lname(res.tag) not in ("Resource", "TrackFileResource"):
                continue
            track_id = _clean_uuid(_text(res, "TrackFileId"))
            if not track_id:
                continue
            if pcm_track_ids is not None and track_id not in pcm_track_ids:
                continue
            intrinsic = int(_text(res, "IntrinsicDuration") or "0")
            duration = int(_text(res, "SourceDuration") or str(intrinsic or 0))
            entry = int(_text(res, "EntryPoint") or "0")
            repeat = max(1, int(_text(res, "RepeatCount") or "1"))
            res_rate = _parse_rate(_text(res, "EditRate"), top_rate)
            if duration > 0:
                by_seq_type.setdefault(seq_type, []).append({
                    "track_id": track_id,
                    "entry": entry,
                    "duration": duration,
                    "repeat": repeat,
                    "rate": res_rate,
                })

    # Return resources from the first valid audio sequence type found
    for entries in by_seq_type.values():
        if entries:
            return entries
    return []


def _build_cpl_audio_inputs(cpl_path: Path, folder: Path, pcm_track_ids: set[str] | None = None) -> tuple[list[dict], str | None]:
    """Resolve audio segment file paths for a multi-segment CPL.

    Returns (inputs, note) mirroring the shape of _build_cpl_segment_inputs.
    """
    asset_map = _build_asset_path_map(folder, include_siblings=True)
    segments = _parse_cpl_audio_segments(cpl_path, pcm_track_ids=pcm_track_ids)
    if not segments:
        return [], "No PCM audio resources found in selected CPL"

    inputs: list[dict] = []
    missing = 0
    for segment in segments:
        mxf_path = asset_map.get(str(segment["track_id"]))
        if not mxf_path or not mxf_path.is_file():
            missing += 1
            continue
        inpoint = max(0.0, float(segment["entry"]) / float(segment["rate"]))
        duration_sec = max(0.0, float(segment["duration"]) / float(segment["rate"]))
        for _ in range(max(1, int(segment["repeat"]))):
            inputs.append({
                "path": str(mxf_path),
                "inpoint": inpoint,
                "duration": duration_sec,
            })

    if not inputs:
        return [], "No playable audio MXFs resolved from selected CPL"

    note = f"Audio segment list built with {missing} missing reel(s) skipped" if missing else None
    return inputs, note


def _parse_cpl_iab_audio_segments(cpl_path: Path, iab_track_ids: set[str] | None = None) -> list[dict]:
    """Parse IAB/immersive audio sequences from a CPL.

    Returns a list of segment dicts (track_id, entry, duration, repeat, rate).

    When iab_track_ids is provided (preferred — from _scan_cpl audioTracks), any audio
    sequence resource whose trackFileId is in the set is included regardless of the
    sequence element name.  This handles CPLs that use generic names like
    MainAudioSequence for IAB tracks (identified only by their essence descriptor).

    When iab_track_ids is None (fallback), sequence-name keyword matching is used.
    """
    root = safe_xml.parse_path(cpl_path).getroot()
    top_rate = _parse_rate(_text(root, "EditRate"), 24.0)

    _SKIP_IMAGE = {"MainImageSequence", "ImageSequence"}
    _IAB_KEYWORDS = ("iab", "immersive", "atmos")

    by_seq_type: dict[str, list[dict]] = {}
    for el in root.iter():
        seq_type = _lname(el.tag)
        # Always skip image/video sequences
        if seq_type in _SKIP_IMAGE or "Image" in seq_type:
            continue
        res_list = next((c for c in list(el) if _lname(c.tag) == "ResourceList"), None)
        if res_list is None:
            continue
        for res in list(res_list):
            if _lname(res.tag) not in ("Resource", "TrackFileResource"):
                continue
            track_id = _clean_uuid(_text(res, "TrackFileId"))
            if not track_id:
                continue
            # Primary match: track file ID provided by _scan_cpl (reliable)
            if iab_track_ids is not None:
                if track_id not in iab_track_ids:
                    continue
            else:
                # Fallback: keyword in sequence element name
                if not any(k in seq_type.lower() for k in _IAB_KEYWORDS):
                    continue
            intrinsic = int(_text(res, "IntrinsicDuration") or "0")
            duration = int(_text(res, "SourceDuration") or str(intrinsic or 0))
            entry = int(_text(res, "EntryPoint") or "0")
            repeat = max(1, int(_text(res, "RepeatCount") or "1"))
            res_rate = _parse_rate(_text(res, "EditRate"), top_rate)
            if duration > 0:
                by_seq_type.setdefault(seq_type, []).append({
                    "track_id": track_id,
                    "entry": entry,
                    "duration": duration,
                    "repeat": repeat,
                    "rate": res_rate,
                })

    for entries in by_seq_type.values():
        if entries:
            return entries
    return []


def _build_cpl_iab_audio_inputs(cpl_path: Path, folder: Path, iab_track_ids: set[str] | None = None) -> tuple[list[dict], str | None]:
    """Resolve IAB audio segment file paths for a CPL.

    Returns (inputs, note) mirroring _build_cpl_audio_inputs.
    """
    asset_map = _build_asset_path_map(folder, include_siblings=True)
    segments = _parse_cpl_iab_audio_segments(cpl_path, iab_track_ids=iab_track_ids)
    if not segments:
        return [], "No IAB audio resources found in selected CPL"

    inputs: list[dict] = []
    missing = 0
    for segment in segments:
        mxf_path = asset_map.get(str(segment["track_id"]))
        if not mxf_path or not mxf_path.is_file():
            missing += 1
            continue
        inpoint = max(0.0, float(segment["entry"]) / float(segment["rate"]))
        duration_sec = max(0.0, float(segment["duration"]) / float(segment["rate"]))
        for _ in range(max(1, int(segment["repeat"]))):
            inputs.append({
                "path": str(mxf_path),
                "inpoint": inpoint,
                "duration": duration_sec,
            })

    if not inputs:
        return [], "No playable IAB MXFs resolved from selected CPL"

    note = f"IAB segment list built with {missing} missing reel(s) skipped" if missing else None
    return inputs, note


def _find_dovi_xml_path(folder: Path, include_siblings: bool = True) -> Path | None:
    """Search for a Dolby Vision CM XML sidecar in the IMF package folder.

    For VF/supplemental packages the Metafier XML typically lives in the OV
    (sibling UUID folder under the same IMF root).  Set include_siblings=True
    to also scan sibling directories, matching the behaviour of
    _build_asset_path_map(include_siblings=True).
    """
    skip = {"assetmap.xml", "packinglist.xml"}
    _DV_KEYWORDS = (
        "DolbyLabsMDF",            # CM XML root — all CM versions
        "DolbyVisionMetadata",     # CM v5.0 alternate root
        "ContentMappingData",      # CM v4.0 alternate
        "L1MaxPq", "MaxPQ",        # L1 analysis values
        "DolbyVision",             # general marker
        "DolbyVisionSubDescriptor",# MXF descriptor
        "DolbyVisionFrameInfo",    # frame-interleaved metadata
        "CMVersion", "cm_version", # version attribute in any CM format
        "TargetDisplay",           # L8 trim target
        "TrimSlope",               # L8 trim slope
        "Level1", "Level8",        # level elements
    )

    def _scan_dir(search_root: Path) -> Path | None:
        for root, dirs, files in os.walk(str(search_root)):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for fname in files:
                if not fname.lower().endswith(".xml"):
                    continue
                if fname.lower() in skip:
                    continue
                fpath = Path(root) / fname
                try:
                    text = fpath.read_text(encoding="utf-8", errors="ignore")[:4096]
                    if any(k in text for k in _DV_KEYWORDS):
                        if "CompositionPlaylist" not in text and "PackingList" not in text:
                            return fpath
                except Exception:
                    pass
        return None

    # 1. Search the provided folder first
    found = _scan_dir(folder)
    if found:
        return found

    # 2. Search sibling UUID folders (OV lives next to VF under the same IMF root)
    if include_siblings:
        try:
            for sib in folder.parent.iterdir():
                if sib.is_dir() and sib != folder and not sib.name.startswith("."):
                    found = _scan_dir(sib)
                    if found:
                        return found
        except Exception:
            pass

    return None


def _pq_to_nits(pq: int | None, max_pq: int = 4095) -> float:
    if not pq:
        return 0.0
    m1, m2 = 2610 / 16384, 2523 / 32
    c1, c2, c3 = 3424 / 4096, 2413 / 128, 2392 / 128
    v = float(pq) / float(max_pq or 4095)
    if v <= 0:
        return 0.0
    try:
        e = (max(v ** (1 / m2) - c1, 0) / (c2 - c3 * v ** (1 / m2))) ** (1 / m1)
        return round(e * 10000, 1)
    except Exception:
        return 0.0


def _el_child_text(el: ET.Element, *names: str) -> str | None:
    for child in el:
        if _lname(child.tag) in names:
            return (child.text or "").strip()
    return None


def _el_child_int(el: ET.Element, *names: str) -> int | None:
    t = _el_child_text(el, *names)
    if t is None:
        return None
    try:
        return int(t)
    except ValueError:
        return None


def _parse_dovi_l1(el: ET.Element) -> dict | None:
    max_pq = _el_child_int(el, "L1MaxPq", "MaxPq", "Max")
    if max_pq is None:
        return None
    min_pq = _el_child_int(el, "L1MinPq", "MinPq", "Min") or 0
    mid_pq = _el_child_int(el, "L1MidPq", "MidPq", "Mid", "AvgPq", "Avg") or 0
    return {
        "minPq": min_pq, "midPq": mid_pq, "maxPq": max_pq,
        "minNits": _pq_to_nits(min_pq),
        "midNits": _pq_to_nits(mid_pq),
        "maxNits": _pq_to_nits(max_pq),
    }


def _parse_dovi_l3(el: ET.Element) -> dict:
    return {
        "minPqOffset": _el_child_int(el, "L3MinPqOffset", "MinPqOffset"),
        "maxPqOffset": _el_child_int(el, "L3MaxPqOffset", "MaxPqOffset"),
        "avgPqOffset": _el_child_int(el, "L3AvgPqOffset", "AvgPqOffset"),
    }


def _parse_dovi_l5(el: ET.Element) -> dict:
    return {
        "activeAreaX": _el_child_int(el, "L5ActiveAreaX", "ActiveAreaX"),
        "activeAreaY": _el_child_int(el, "L5ActiveAreaY", "ActiveAreaY"),
        "activeAreaW": _el_child_int(el, "L5ActiveAreaW", "ActiveAreaW"),
        "activeAreaH": _el_child_int(el, "L5ActiveAreaH", "ActiveAreaH"),
    }


def _dv_l6_mast_nits(raw: int | None) -> float | None:
    """Convert DV CM v4.0 mastering luminance from 1/10000 cd/m² units to nits.
    CM v4.0 stores MaxDisplayMasteringLuminance in 1/10000 cd/m² (so 10,000,000 = 1,000 nits).
    CM v2.0.5 stores it directly in cd/m². Values > 10,000 are in the 1/10000 scale."""
    if raw is None:
        return None
    return raw / 10000.0 if raw > 10000 else float(raw)


def _parse_dovi_l6(el: ET.Element) -> dict:
    raw_max = _el_child_int(el, "L6MaxDisplayMasteringLuminance", "MaxDisplayMasteringLuminance", "MaxMLuminance")
    raw_min = _el_child_int(el, "L6MinDisplayMasteringLuminance", "MinDisplayMasteringLuminance", "MinMLuminance")
    return {
        "maxMasteringLuminance":     _dv_l6_mast_nits(raw_max),   # normalized to nits
        "minMasteringLuminance":     _dv_l6_mast_nits(raw_min),   # normalized to nits
        "maxContentLightLevel":      _el_child_int(el, "L6MaxContentLightLevel",         "MaxContentLightLevel",         "MaxCLL"),
        "maxFrameAverageLightLevel": _el_child_int(el, "L6MaxFrameAverageLightLevel",    "MaxFrameAverageLightLevel",    "MaxFALL"),
    }


def _parse_dovi_l8(el: ET.Element) -> dict:
    return {
        "targetDisplayIndex": _el_child_int(el, "L8TargetDisplayIndex", "TargetDisplayIndex"),
        "hueShift":           _el_child_int(el, "L8HueShift",           "HueShift"),
        "saturationGain":     _el_child_int(el, "L8SaturationGain",     "SaturationGain"),
        "trimSlope":          _el_child_int(el, "L8TrimSlope",          "TrimSlope"),
        "trimOffset":         _el_child_int(el, "L8TrimOffset",         "TrimOffset"),
        "trimPower":          _el_child_int(el, "L8TrimPower",          "TrimPower"),
        "chromaWeight":       _el_child_int(el, "L8ChromaWeight",       "ChromaWeight"),
    }


def _parse_dovi_l9(el: ET.Element) -> dict:
    return {"sourceColorPrimary": _el_child_text(el, "L9SourceColorPrimary", "SourceColorPrimary")}


def _parse_dovi_l11(el: ET.Element) -> dict:
    return {
        "contentType":           _el_child_text(el, "L11ContentType",           "ContentType"),
        "whitepointTemperature": _el_child_int(el,  "L11WhitepointTemperature", "WhitepointTemperature"),
        "referenceModeFlag":     _el_child_text(el, "L11ReferenceModeFlag",     "ReferenceModeFlag"),
    }


_DOVI_LEVEL_PARSERS: dict = {
    "Level1": _parse_dovi_l1, "L1": _parse_dovi_l1,
    "Level3": _parse_dovi_l3, "L3": _parse_dovi_l3,
    "Level5": _parse_dovi_l5, "L5": _parse_dovi_l5,
    "Level6": _parse_dovi_l6, "L6": _parse_dovi_l6,
    "Level8": _parse_dovi_l8, "L8": _parse_dovi_l8,
    "Level9": _parse_dovi_l9, "L9": _parse_dovi_l9,
    "Level11": _parse_dovi_l11, "L11": _parse_dovi_l11,
}
_DOVI_ARRAY_LEVELS = {"Level2", "L2", "Level8", "L8"}


def _level_key(tag: str) -> str:
    """'Level1' → 'l1', 'L6' → 'l6', 'Level11' → 'l11'"""
    import re
    return "l" + re.sub(r"^L(?:evel)?", "", tag)


def _dovi_parse_levels_into(el: ET.Element, shot: dict) -> None:
    for child in el:
        n = _lname(child.tag)
        parser = _DOVI_LEVEL_PARSERS.get(n)
        if not parser:
            continue
        parsed = parser(child)
        key = _level_key(n)
        if n in _DOVI_ARRAY_LEVELS:
            shot.setdefault(key, []).append(parsed)
        else:
            shot[key] = parsed


def _dovi_parse_plugin_node(node: ET.Element, shot: dict) -> None:
    for plugin in node:
        pn = _lname(plugin.tag)
        if pn in ("DVGlobalData", "DolbyLabsMDF", "GlobalData"):
            _dovi_parse_levels_into(plugin, shot)
        elif pn in ("DVTrimPass", "TrimPass"):
            for tp in plugin:
                tpn = _lname(tp.tag)
                if tpn in ("TrimPassData", "DVTrimPassData"):
                    target = tp.attrib.get("Target")
                    trim_data: dict = {
                        "target": int(target) if target else None,
                        "levels": {},
                    }
                    for child in tp:
                        cn = _lname(child.tag)
                        cp = _DOVI_LEVEL_PARSERS.get(cn)
                        if cp:
                            trim_data["levels"][_level_key(cn)] = cp(child)
                    shot.setdefault("trimPasses", []).append(trim_data)
        else:
            _dovi_parse_levels_into(plugin, shot)


def _dovi_parse_shot(shot_el: ET.Element) -> dict:
    shot: dict = {
        "uuid": None, "begin": 0, "end": 0,
        "l1": None, "l2": [], "l3": None, "l5": None,
        "l6": None, "l8": [], "l9": None, "l11": None,
        "trimPasses": [],
    }
    for child in shot_el:
        n = _lname(child.tag)
        if n == "UniqueID":
            shot["uuid"] = (child.text or "").strip()
        elif n == "Begin":
            try: shot["begin"] = int(child.text or 0)
            except ValueError: pass
        elif n == "End":
            try: shot["end"] = int(child.text or 0)
            except ValueError: pass
        elif n == "PluginNode":
            _dovi_parse_plugin_node(child, shot)
        else:
            parser = _DOVI_LEVEL_PARSERS.get(n)
            if parser:
                key = _level_key(n)
                if n in _DOVI_ARRAY_LEVELS:
                    shot.setdefault(key, []).append(parser(child))
                else:
                    shot[key] = parser(child)
    return shot


def _extract_dovi_from_xml_text(xml_text: str, source_path: str = '') -> dict:
    """Parse Dolby Vision CM XML from a string (e.g. embedded in MXF)."""
    try:
        root = safe_xml.fromstring(xml_text)
    except Exception as exc:
        return {"error": str(exc)}

    version: str | None = None
    title: str | None = None
    for child in root:
        n = _lname(child.tag)
        if n == "Version":
            version = (child.text or "").strip()
        elif n == "Title":
            title = (child.text or "").strip()

    shots = []
    for el in root.iter():
        if _lname(el.tag) in ("Shot", "shot"):
            shots.append(_dovi_parse_shot(el))

    for i, shot in enumerate(shots):
        prev = shots[i - 1] if i > 0 else None
        shot["index"] = i
        shot["durationFrames"] = shot["end"] - shot["begin"] + 1
        shot["gapBefore"] = max(0, shot["begin"] - (prev["end"] + 1)) if prev else 0
        shot["isCut"] = shot["gapBefore"] > 0
        l1 = shot.get("l1")
        if l1 is not None and l1.get("minPq", -1) == 0:
            shot["isTransition"] = True
            max_pq = l1.get("maxPq", 0)
            mid_pq = l1.get("midPq", 0)
            if max_pq == 0:
                shot["transitionType"] = "black"
            elif mid_pq < max_pq * 0.4:
                shot["transitionType"] = "fade"
            else:
                shot["transitionType"] = "dissolve"
        else:
            shot["isTransition"] = False
            shot["transitionType"] = None

    return {
        "shots": shots,
        "xmlPath": source_path,
        "shotCount": len(shots),
        "version": version,
        "title": title,
        "fromEmbeddedMxf": True,
    }


def _extract_dovi(cpl_path: Path, folder: Path) -> dict:
    """Parse the Dolby Vision CM XML sidecar and return fully structured shot data."""
    dovi_xml_path = _find_dovi_xml_path(folder)
    if not dovi_xml_path:
        return {}

    try:
        tree = safe_xml.parse_path(str(dovi_xml_path))
        root = tree.getroot()
    except Exception as exc:
        return {"error": str(exc)}

    version: str | None = None
    title: str | None = None
    for child in root:
        n = _lname(child.tag)
        if n == "Version":
            version = (child.text or "").strip()
        elif n == "Title":
            title = (child.text or "").strip()

    # Collect all <Shot> elements at any nesting depth
    shots = []
    for el in root.iter():
        if _lname(el.tag) in ("Shot", "shot"):
            shots.append(_dovi_parse_shot(el))

    # Annotate shots: gap detection, transition classification
    for i, shot in enumerate(shots):
        prev = shots[i - 1] if i > 0 else None
        shot["index"] = i
        shot["durationFrames"] = shot["end"] - shot["begin"] + 1
        shot["gapBefore"] = max(0, shot["begin"] - (prev["end"] + 1)) if prev else 0
        shot["isCut"] = shot["gapBefore"] > 0

        l1 = shot.get("l1")
        if l1 is not None and l1.get("minPq", -1) == 0:
            shot["isTransition"] = True
            max_pq = l1.get("maxPq", 0)
            mid_pq = l1.get("midPq", 0)
            if max_pq == 0:
                shot["transitionType"] = "black"
            elif mid_pq < max_pq * 0.4:
                shot["transitionType"] = "fade"
            else:
                shot["transitionType"] = "dissolve"
        else:
            shot["isTransition"] = False
            shot["transitionType"] = None

    return {
        "shots": shots,
        "xmlPath": str(dovi_xml_path),
        "shotCount": len(shots),
        "version": version,
        "title": title,
    }


def extract_embedded_dovi_xml_from_mxf(mxf_path: Path, head_mb: int = 64, tail_mb: int = 96) -> str | None:
    """Scan an MXF file's header + footer regions for an embedded Dolby Vision CM XML.

    Tries multiple CM root element names to cover CM v2.0.5, CM v4.0, and CM v5.0.
    Returns the XML text on success, None if not found.
    """
    _CHUNK    = 4 * 1024 * 1024   # 4 MB read chunks
    _OVERLAP  = 2048               # carry-over to bridge chunk boundaries
    _MAX_XML  = 80 * 1024 * 1024  # safety cap — real CM XML << this
    # Try each marker in order — first match wins
    _CANDIDATES = [
        (b'DolbyLabsMDF',      b'DolbyLabsMDF>'),       # CM v2.0.5 / v4.0 canonical
        (b'DolbyVisionMetadata', b'DolbyVisionMetadata>'),# CM v5.0 alternate root
        (b'ContentMappingData', b'ContentMappingData>'), # some CM v4.0 implementations
    ]
    _MARKER   = b'DolbyLabsMDF'
    _CLOSE    = b'DolbyLabsMDF>'  # suffix of </...DolbyLabsMDF>

    try:
        file_size = mxf_path.stat().st_size
    except Exception:
        return None

    head_bytes = head_mb * 1024 * 1024
    tail_bytes = tail_mb * 1024 * 1024

    ranges: list[tuple[int, int]] = [(0, min(file_size, head_bytes))]
    if file_size > head_bytes + tail_bytes:
        ranges.append((file_size - tail_bytes, file_size))
    elif file_size > head_bytes:
        ranges.append((head_bytes, file_size))

    def _scan_for_marker(marker: bytes, close: bytes) -> str | None:
        for range_start, range_end in ranges:
            try:
                carry      = b''
                collecting = False
                xml_bytes  = b''
                with open(mxf_path, 'rb') as fh:
                    pos = range_start
                    while pos < range_end:
                        fh.seek(pos)
                        chunk = fh.read(min(_CHUNK, range_end - pos))
                        if not chunk:
                            break
                        pos += len(chunk)
                        if not collecting:
                            hay = carry + chunk
                            idx = hay.find(marker)
                            if idx < 0:
                                carry = hay[-_OVERLAP:]
                                continue
                            lt = hay.rfind(b'<', 0, idx)
                            xml_bytes = hay[lt:] if lt >= 0 else hay[idx:]
                            collecting = True
                        else:
                            xml_bytes += chunk
                        end_idx = xml_bytes.find(close)
                        if end_idx >= 0:
                            return xml_bytes[:end_idx + len(close)].decode('utf-8', errors='replace')
                        if len(xml_bytes) > _MAX_XML:
                            break
            except Exception:
                continue
        return None

    # Try each CM root element in order — first match wins
    for _m, _c in _CANDIDATES:
        result = _scan_for_marker(_m, _c)
        if result:
            return result
    return None


def extract_frame_interleaved_dovi_from_mxf(mxf_path: Path) -> dict | None:
    """Extract Dolby Vision DM v4.1 frame-interleaved metadata from Video MXF.

    DaVinci Resolve (and some other tools) embed Dolby Vision metadata
    inside each video frame's KLV packet as <DolbyVisionFrameData> XML
    blocks — one block per frame, each carrying the shot's L1/L2/L8 data
    and a <Record><In>N</In><Duration>D</Duration></Record> that identifies
    which shot the frame belongs to.

    This function:
      1. Scans header + mid + tail of the file for unique <In> values.
      2. Extracts the <DolbyVisionGlobalData> from the footer (mastering
         display, target displays, Level6 MaxCLL/MaxFALL, CM version).
      3. Converts ImageCharacter "min avg max" [0,1] → PQ codes → nits.
      4. Converts L2/L8 trims to PostFlowX's internal shot structure.
      5. Returns { shots, version, title } compatible with _extract_dovi_from_xml_text.
    """
    import xml.etree.ElementTree as ET

    FRAME_OPEN  = b'<?xml'
    FRAME_CLOSE = b'</DolbyVisionFrameData>'
    GLOBAL_MARKER = b'DolbyVisionGlobalData'

    try:
        file_size = mxf_path.stat().st_size
    except Exception:
        return None

    CHUNK     = 32 * 1024 * 1024   # 32 MB read chunks
    HEAD_MB   = 64 * 1024 * 1024   # first 64 MB
    TAIL_MB   = 96 * 1024 * 1024   # last 96 MB
    SAMPLE_MB = 16 * 1024 * 1024   # 16 MB per interior sample window
    tail_start = max(0, file_size - TAIL_MB)

    # Build scan ranges: head + evenly spaced samples + tail.
    # For a 734 GB file this reads ~16*N + 64 + 96 MB where N = ~50 samples.
    # Each DolbyVisionFrameData shot boundary is ~500-2000 bytes, so 16 MB
    # windows capture many unique shots without reading the whole file.
    scan_ranges: list[tuple[int, int]] = [(0, min(file_size, HEAD_MB))]

    # Interior samples spaced every ~5 GB (max 60 samples)
    interior_start = HEAD_MB
    interior_end   = tail_start
    if interior_end > interior_start:
        total_interior = interior_end - interior_start
        N_SAMPLES = min(60, max(4, total_interior // (5 * 1024 * 1024 * 1024)))
        step = total_interior // max(1, N_SAMPLES)
        for k in range(N_SAMPLES):
            s = interior_start + k * step
            e = min(s + SAMPLE_MB, interior_end)
            if e > s:
                scan_ranges.append((s, e))

    scan_ranges.append((tail_start, file_size))

    shots_by_in: dict[int, dict] = {}   # in_frame → parsed shot
    global_xml: str | None = None

    def _parse_frame_block(xml_bytes: bytes) -> dict | None:
        try:
            xml_str = xml_bytes.decode('utf-8', errors='replace')
            if 'DolbyVisionFrameData' not in xml_str:
                return None
            # ElementTree needs a proper root
            if not xml_str.rstrip().endswith('>'):
                xml_str += '>'
            root = safe_xml.fromstring(xml_str)
            rec  = root.find('Record')
            if rec is None:
                return None
            in_val  = int((rec.findtext('In')       or '0').strip())
            dur_val = int((rec.findtext('Duration') or '0').strip())
            dyn  = root.find('.//DVDynamicData')
            if dyn is None:
                return None
            # L1 ImageCharacter: "minPq avgPq maxPq" normalised [0,1]
            l1_el = dyn.find('Level1')
            ic_text = (l1_el.findtext('ImageCharacter') or '').strip() if l1_el is not None else ''
            ic_vals = [float(v) for v in ic_text.split()] if ic_text else []
            # L2 trims: {TID: [9 floats]}
            l2_trims: dict[int, list[float]] = {}
            for l2 in dyn.findall('Level2'):
                tid_s  = l2.findtext('TID')
                trim_s = l2.findtext('Trim')
                if tid_s and trim_s:
                    try:
                        l2_trims[int(tid_s.strip())] = [float(v) for v in trim_s.split()]
                    except ValueError:
                        pass
            return {'in': in_val, 'dur': dur_val, 'ic': ic_vals, 'l2': l2_trims}
        except ET.ParseError:
            return None
        except Exception:
            return None

    # Use ONE file handle for all ranges — opening a 700 GB file 60+ times is very slow.
    try:
        with open(mxf_path, 'rb') as fh:
            for r_start, r_end in scan_ranges:
                if r_end <= r_start:
                    continue
                carry = b''
                pos   = r_start
                fh.seek(pos)
                while pos < r_end:
                    chunk = fh.read(min(CHUNK, r_end - pos))
                    if not chunk:
                        break
                    pos  += len(chunk)
                    data  = carry + chunk
                    carry = b''

                    # Extract DolbyVisionGlobalData (once)
                    if global_xml is None:
                        gi = data.find(GLOBAL_MARKER)
                        if gi >= 0:
                            lt = data.rfind(b'<?xml', 0, gi)
                            if lt >= 0:
                                ge = data.find(b'</DolbyVisionGlobalData>', gi)
                                if ge >= 0:
                                    global_xml = data[lt:ge + 24].decode('utf-8', errors='replace')

                    # Extract unique frame blocks
                    scan_pos = 0
                    while True:
                        xi = data.find(FRAME_OPEN, scan_pos)
                        if xi < 0:
                            carry = data[-512:] if len(data) > 512 else data
                            break
                        xe = data.find(FRAME_CLOSE, xi)
                        if xe < 0:
                            carry = data[xi:]
                            break
                        block = _parse_frame_block(data[xi:xe + len(FRAME_CLOSE)])
                        if block and block['in'] not in shots_by_in:
                            shots_by_in[block['in']] = block
                        scan_pos = xe + len(FRAME_CLOSE)
    except Exception:
        return None

    if not shots_by_in:
        return None

    # ── Parse global metadata ─────────────────────────────────────────────────
    cm_version = ''
    mastering_peak_nits: float = 0.0
    mastering_min_nits: float  = 0.0
    max_cll: int  = 0
    max_fall: int = 0
    target_displays: list[dict] = []

    if global_xml:
        try:
            gr = safe_xml.fromstring(global_xml)
            cm_v = gr.find('.//CMVersion')
            if cm_v is not None and cm_v.text:
                cm_version = cm_v.text.strip().replace(' ', '.')
            lv6 = gr.find('.//Level6')
            if lv6 is not None:
                max_cll  = int(lv6.findtext('MaxCLL')  or 0)
                max_fall = int(lv6.findtext('MaxFALL') or 0)
            md = gr.find('.//MasteringDisplay')
            if md is not None:
                mastering_peak_nits = float(md.findtext('PeakBrightness') or 0)
                mastering_min_nits  = float(md.findtext('MinimumBrightness') or 0)
            for td in gr.findall('.//TargetDisplay'):
                tid = int(td.findtext('ID') or 0)
                name = td.findtext('Name') or ''
                peak = float(td.findtext('PeakBrightness') or 0)
                target_displays.append({'id': tid, 'name': name, 'peak': peak})
        except Exception:
            pass

    # Convert mastering nits → PQ code for L6
    def _nits_to_pq(nits: float) -> int:
        if nits <= 0: return 0
        y = min(1.0, nits / 10000.0)
        m1, m2 = 2610 / 16384, 2523 / 32
        c1, c2, c3 = 3424 / 4096, 2413 / 128, 2392 / 128
        import math
        e = math.pow(y, m1)
        return round(math.pow((c1 + c2 * e) / (1 + c3 * e), m2) * 4095)

    l6_data = {
        'maxMasteringLuminance': mastering_peak_nits,  # already in nits
        'minMasteringLuminance': mastering_min_nits,
        'maxContentLightLevel': max_cll,
        'maxFrameAverageLightLevel': max_fall,
    }

    # ── Build shots from unique frame records ─────────────────────────────────
    ic_to_pq = lambda v: round(v * 4095)

    def _ic_to_nits(pq_code: int) -> float:
        if pq_code <= 0: return 0.0
        v = pq_code / 4095.0
        m1, m2 = 2610 / 16384, 2523 / 32
        c1, c2, c3 = 3424 / 4096, 2413 / 128, 2392 / 128
        import math
        p = math.pow(v, 1 / m2)
        num = max(p - c1, 0)
        den = c2 - c3 * p
        if den <= 0: return 0.0
        return round(math.pow(num / den, 1 / m1) * 10000, 1)

    # L2 trim float values [slope offset power cw_lo cw_hi sat ...]
    # These DM v4.1 float trims differ from CM v2.0.5 12-bit integers.
    # We map to approximate 12-bit values (neutral=2048) for display.
    # Note: this is an approximation — full DM v4.1 trim decoding requires Dolby SDK.
    def _l2_float_to_trim_passes(l2_dict: dict) -> list[dict]:
        passes = []
        for tid, vals in l2_dict.items():
            if len(vals) < 6: continue
            # vals[3] = chroma_weight_low, vals[4] = chroma_weight_hi, vals[5] = saturation_gain
            # Map float [−1,1] → 12-bit [0,4095] neutral=2048
            def _f_to_12bit(v: float) -> int:
                return max(0, min(4095, round(2048 + v * 2048)))
            passes.append({
                'target': tid,
                'levels': {
                    'l8': {
                        'targetDisplayIndex': tid,
                        'trimSlope':    2048,                   # neutral (DM v4.1 L2 slope at vals[0..2] is mostly 0)
                        'trimOffset':   2048,
                        'trimPower':    2048,
                        'saturationGain': _f_to_12bit(vals[5] if len(vals) > 5 else 0),
                        'chromaWeight': 2048,
                        'hueShift':     2048,
                    }
                }
            })
        return passes

    shots_list = []
    for in_frame, rec in sorted(shots_by_in.items()):
        ic = rec['ic']
        min_pq = ic_to_pq(ic[0]) if len(ic) > 0 else 0
        mid_pq = ic_to_pq(ic[1]) if len(ic) > 1 else 0
        max_pq = ic_to_pq(ic[2]) if len(ic) > 2 else 0
        end_frame = in_frame + rec['dur'] - 1
        trim_passes = _l2_float_to_trim_passes(rec['l2'])
        shot = {
            'uuid':  None,
            'begin': in_frame,
            'end':   end_frame,
            'l1': {
                'minPq': min_pq, 'midPq': mid_pq, 'maxPq': max_pq,
                'minNits': _ic_to_nits(min_pq),
                'midNits': _ic_to_nits(mid_pq),
                'maxNits': _ic_to_nits(max_pq),
            },
            'l2':    [],
            'l3':    None,
            'l5':    None,
            'l6':    l6_data if in_frame == min(shots_by_in.keys()) else None,
            'l8':    [],
            'l9':    None,
            'l11':   None,
            'trimPasses': trim_passes,
        }
        shots_list.append(shot)

    if not shots_list:
        return None

    return {
        'shots':     shots_list,
        'version':   cm_version or '4.1',
        'title':     '',
        'xmlPath':   str(mxf_path),
        'shotCount': len(shots_list),
        'fromFrameInterleaved': True,
    }


def _probe_duration_seconds(path: Path, ffprobe_path: str | None) -> float | None:
    if not ffprobe_path or not path.is_file():
        return None
    try:
        result = subprocess.run(
            [
                ffprobe_path,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return None
        value = (result.stdout or "").strip().splitlines()
        if not value:
            return None
        return float(value[0])
    except Exception:
        return None


def _is_quicktime_like(path: Path | None) -> bool:
    try:
        return str(path.suffix or '').lower() in {'.mov', '.mp4', '.m4v', '.qt'}
    except Exception:
        return False


def _probe_media_info(path: str, ffprobe_path: str | None) -> dict | None:
    """Return a dict of basic media metadata for *path* using ffprobe.

    Keys: startTimecode (str), duration (float|None), fps (float|None), codec (str).
    Returns None if the file cannot be probed.
    """
    if not path or not ffprobe_path:
        return None
    p = Path(path)
    if not p.is_file():
        return None
    try:
        result = subprocess.run(
            [
                ffprobe_path,
                '-v', 'error',
                '-show_entries',
                'format=duration:format_tags=timecode:'
                'stream=codec_name,r_frame_rate,codec_type:stream_tags=timecode',
                '-of', 'json',
                str(p),
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if result.returncode != 0:
            return None
        payload = json.loads((result.stdout or '').strip() or '{}')
        fmt = payload.get('format') or {}
        streams = payload.get('streams') or []

        # timecode: format tags first, then per-stream tags
        tc = str((fmt.get('tags') or {}).get('timecode') or '').strip()
        if not tc:
            for s in streams:
                tc = str((s.get('tags') or {}).get('timecode') or '').strip()
                if tc:
                    break

        # duration seconds
        dur: float | None = None
        try:
            dur = float(fmt.get('duration') or 0) or None
        except (TypeError, ValueError):
            pass

        # fps from first video stream r_frame_rate
        fps: float | None = None
        codec = ''
        for s in streams:
            if s.get('codec_type') == 'video':
                codec = str(s.get('codec_name') or '')
                rfr = s.get('r_frame_rate') or ''
                try:
                    parts = str(rfr).split('/')
                    if len(parts) == 2 and int(parts[1]) > 0:
                        fps = round(int(parts[0]) / int(parts[1]), 3)
                except (ValueError, ZeroDivisionError):
                    pass
                break

        return {'startTimecode': tc, 'duration': dur, 'fps': fps, 'codec': codec}
    except Exception:
        return None


def _probe_media_timecode(path: Path | None, ffprobe_path: str | None) -> str:
    if not path or not ffprobe_path or not path.is_file() or not _is_quicktime_like(path):
        return ''
    try:
        result = subprocess.run(
            [
                ffprobe_path,
                '-v', 'error',
                '-show_entries', 'format_tags=timecode:stream_tags=timecode',
                '-of', 'json',
                str(path),
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return ''
        payload = json.loads((result.stdout or '').strip() or '{}')
        tc = str((((payload.get('format') or {}).get('tags') or {}).get('timecode') or '')).strip()
        if tc:
            return tc
        for stream in (payload.get('streams') or []):
            tc = str(((stream.get('tags') or {}).get('timecode') or '')).strip()
            if tc:
                return tc
    except Exception:
        return ''
    return ''


def _timecode_to_seconds(tc: str, fps: float) -> float:
    """Convert an HH:MM:SS:FF (or HH:MM:SS;FF drop-frame) string to seconds."""
    try:
        # normalise drop-frame semicolon separator to colon before splitting
        normalised = tc.strip().replace(';', ':')
        parts = normalised.split(':')
        if len(parts) == 4:
            h, m, s, f = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
            return h * 3600 + m * 60 + s + f / max(1.0, fps)
        if len(parts) == 3:
            h, m, s = int(parts[0]), int(parts[1]), int(parts[2])
            return h * 3600 + m * 60 + s
    except Exception:
        pass
    return 0.0


_TC_BASES = (24, 25, 30, 48, 50, 60, 120)


def _fps_to_base(fps: float) -> int:
    """Round fps to the nearest standard timecode integer base."""
    return int(min(_TC_BASES, key=lambda b: abs(fps - b)))


def _is_drop_frame_rate(fps: float) -> bool:
    """True only for the 30-based NTSC rates (29.97/59.94) that have a drop-frame
    variant. 23.976 has no drop-frame form — it always uses non-drop timecode."""
    return abs(fps - 29.97) < 0.02 or abs(fps - 59.94) < 0.02


def _seconds_to_timecode(seconds: float, fps: float, drop_frame: bool = False) -> str:
    """Convert a duration in seconds to HH:MM:SS:FF (or HH:MM:SS;FF for DF)."""
    fps_base = _fps_to_base(fps)
    if fps_base <= 0:
        fps_base = 24
    total_frames = int(round(max(0.0, seconds) * fps))
    h = total_frames // (fps_base * 3600)
    remaining = total_frames - h * fps_base * 3600
    m = remaining // (fps_base * 60)
    remaining -= m * fps_base * 60
    s = remaining // fps_base
    f = remaining % fps_base
    sep = ';' if drop_frame else ':'
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{f:02d}"


def _thumb_cache_dir() -> Path:
    """Persistent directory for companion-generated thumbnail cache files.
    Uses {proxy_root}/thumbnails/ when a media root is set."""
    root = get_proxy_root()
    if root:
        try:
            p = root / 'thumbnails'
            p.mkdir(parents=True, exist_ok=True)
            return p
        except Exception:
            pass
    p = Path.home() / '.cache' / 'postflowx' / 'thumbnails'
    p.mkdir(parents=True, exist_ok=True)
    return p


def _preview_cache_dir() -> Path:
    """Cache directory for browser-preview H.264 proxies of standalone media files.
    Uses {proxy_root}/preview/ when a media root is set."""
    root = get_proxy_root()
    if root:
        try:
            p = root / 'preview'
            p.mkdir(parents=True, exist_ok=True)
            return p
        except Exception:
            pass
    p = Path.home() / '.cache' / 'postflowx' / 'preview_proxy'
    p.mkdir(parents=True, exist_ok=True)
    return p


def build_preview_proxy(session_id: str, media_path: str, ffmpeg_path: str,
                        output_path: str | None = None,
                        proxy_name: str = "",
                        cache_key: str = "",
                        force_ffmpeg: bool = False) -> None:
    """Transcode a standalone media file to a small H.264 MP4 for browser preview.

    Runs on a background thread.  Progress is tracked in session state so the
    JS can poll /progress/{session_id} and serve via /stream/{session_id}.
    """
    path = Path(media_path)
    try:
        mtime = str(path.stat().st_mtime)
    except Exception:
        mtime = "0"
    preview_cache_key = hashlib.sha256(f"preview_proxy:{media_path}:{mtime}".encode()).hexdigest()[:20]
    if output_path:
        cache_path = Path(output_path).expanduser().resolve()
        cache_path.parent.mkdir(parents=True, exist_ok=True)
    else:
        cache_dir = _preview_cache_dir()
        cache_path = cache_dir / f"pfx_prev_{preview_cache_key}.mp4"
    proxy_label = proxy_name or cache_path.stem
    ffprobe_path = _find_ffprobe(ffmpeg_path)
    _cached_tc_start = ''
    try:
        _cached_payload = json.loads(cache_path.with_suffix('.json').read_text(encoding='utf-8', errors='replace') or '{}')
        if isinstance(_cached_payload, dict):
            _cached_tc_start = str(_cached_payload.get('startTimecode') or '').strip()
    except Exception:
        _cached_tc_start = ''

    def _path_has_video_stream(candidate: Path) -> bool:
        if not candidate.is_file():
            return False
        if not ffprobe_path:
            return candidate.stat().st_size > 0
        try:
            probe = subprocess.run(
                [ffprobe_path, '-v', 'quiet', '-show_entries', 'stream=codec_type',
                 '-of', 'csv=p=0', str(candidate)],
                capture_output=True, timeout=15,
            )
            return b'video' in (probe.stdout or b'')
        except Exception:
            return candidate.stat().st_size > 0

    def _write_preview_sidecar(message: str, done: bool, error: str | None = None) -> None:
        if not cache_key and not proxy_name and not output_path:
            return
        _tc = ''
        try:
            _tc = str((get_session(session_id) or {}).get('startTimecode') or '').strip()
        except Exception:
            _tc = ''
        try:
            cache_path.with_suffix('.json').write_text(json.dumps({
                "cacheKey": cache_key,
                "outputPath": str(cache_path),
                "name": proxy_label,
                "startTimecode": _tc or _cached_tc_start,
                "message": message,
                "done": done,
                "error": error,
            }, ensure_ascii=False, indent=2), encoding='utf-8')
        except Exception:
            pass

    # Cache hit — proxy already exists. Reject stale audio-only files because
    # Chrome will load them but report videoWidth=0, which looks like a broken preview.
    if cache_path.is_file() and cache_path.stat().st_size > 0 and _path_has_video_stream(cache_path):
        if not _cached_tc_start and ffprobe_path:
            try:
                _cached_tc_start = str((_probe_media_info(str(cache_path), ffprobe_path) or {}).get('startTimecode') or '').strip()
            except Exception:
                _cached_tc_start = ''
        update_session(session_id, done=True, pct=100, stage='complete',
                       message='Preview ready (cached)', path=str(cache_path),
                       error=None, kind='preview', startTimecode=_cached_tc_start)
        _write_preview_sidecar('Preview ready (cached)', True, None)
        return
    if cache_path.is_file():
        try:
            cache_path.unlink(missing_ok=True)
        except Exception:
            pass
        try:
            cache_path.with_suffix('.json').unlink(missing_ok=True)
        except Exception:
            pass

    tmp_path = cache_path.with_suffix('.part')

    # ── Pre-probe: verify a decodable video stream exists ─────────────────────
    _has_decodable_video = False
    _probed_codec = ''   # codec_name as reported by ffprobe
    _file_ext = path.suffix.lower()
    _format_tags: dict[str, str] = {}

    # Codecs that ffprobe can identify but ffmpeg cannot decode natively.
    # NOTE: do NOT include '', 'unknown', or 'none' here — those just mean
    # ffprobe couldn't identify the codec confidently. ffmpeg can often still
    # open such files (MXF wrappers in particular), so let it try the normal
    # path first; if that fails, the post-check below routes to camera-RAW.
    _UNDECODABLE_CODECS = {'r3d', 'xocn', 'vc6', 'xavc_raw', 'braw_sdk', 'braw', 'arriraw'}

    if ffprobe_path:
        try:
            _probe_r = subprocess.run(
                [ffprobe_path, '-v', 'quiet', '-print_format', 'json',
                 '-show_streams', '-show_format', '-select_streams', 'v:0', str(path)],
                capture_output=True, timeout=30,
            )
            if _probe_r.returncode == 0:
                import json as _json
                _probe_data = _json.loads(_probe_r.stdout or b'{}')
                _vstreams = _probe_data.get('streams', [])
                _format_tags = {
                    str(k).lower(): str(v).strip().lower()
                    for k, v in ((_probe_data.get('format') or {}).get('tags') or {}).items()
                }
                if _vstreams:
                    _vs = _vstreams[0]
                    _probed_codec = str(_vs.get('codec_name') or '').lower()
                    _w = int(_vs.get('width') or 0)
                    _h = int(_vs.get('height') or 0)
                    _has_decodable_video = (
                        _probed_codec not in _UNDECODABLE_CODECS and _w > 0 and _h > 0
                    )
                # Expose timecodeStart via the /progress/ endpoint so trlconf can
                # compute the tape-TC→file-time offset for waveform seek correction.
                _vs_tags = (_vstreams[0].get('tags') if _vstreams else {}) or {}
                _tc_start = (
                    _vs_tags.get('timecode') or _vs_tags.get('Timecode') or
                    _vs_tags.get('time_code') or _format_tags.get('timecode') or ''
                )
                if _tc_start:
                    update_session(session_id, startTimecode=_tc_start)
        except Exception:
            pass
    else:
        # ffprobe unavailable — optimistic, let ffmpeg try
        _has_decodable_video = True

    # Camera-RAW classification — computed up front so both the undecodable-codec
    # fast path and the ffmpeg post-check (which can produce a 0-byte/no-video
    # output even on a "decodable" codec) can route to the right error code.
    _is_red      = (_file_ext == '.r3d'  or _probed_codec == 'r3d')
    _is_sony_raw = (
        _probed_codec in ('xocn', 'vc6', 'xavc_raw')
        or (
            _file_ext == '.mxf'
            and (
                'sony' in (_format_tags.get('company_name') or '')
                or 'axs' in (_format_tags.get('product_name') or '')
            )
        )
    )
    _is_braw     = (_file_ext == '.braw' or _probed_codec in ('braw_sdk', 'braw'))

    # force_ffmpeg=True bypasses all camera-RAW classification and runs ffmpeg
    # straight against the source — used by the UI's "Force ffmpeg" button as
    # both a diagnostic and an escape hatch when classification is over-eager.
    if force_ffmpeg:
        _has_decodable_video = True

    if not _has_decodable_video:

        def _cam_status(msg: str, pct: int = 15) -> None:
            update_session(session_id, done=False, pct=pct, stage='running',
                           message=msg, kind='preview', path=str(cache_path), error=None)

        def _cam_success() -> None:
            update_session(session_id, done=True, pct=100, stage='complete',
                           message='Preview ready', path=str(cache_path),
                           error=None, kind='preview')
            _write_preview_sidecar('Preview ready', True, None)

        def _try_avconvert(label: str) -> bool:
            """Attempt AVFoundation decode (macOS); return True on success."""
            _avc = _find_avconvert()
            if not _avc:
                return False
            _cam_status(f'Decoding {label} via system codec (AVFoundation)…', 20)
            _avc_ok, _ = _avconvert_transcode_to_h264(
                media_path=str(path),
                output_mp4=str(cache_path),
                ffmpeg_path=ffmpeg_path,
                on_status=lambda m: _cam_status(m, 60 if 'Optimising' in m else 20),
            )
            return _avc_ok and _path_has_video_stream(cache_path)

        def _try_ffmpeg_direct(label: str) -> bool:
            """Last-resort: run ffmpeg directly on the source even when the codec
            was classified undecodable. ffprobe's codec_name is sometimes empty
            or 'unknown' for files ffmpeg can in fact open (MXF wrappers, some
            XAVC variants). Cheap to try; bails on first error."""
            _cam_status(f'Trying ffmpeg direct for {label}…', 25)
            _vf = "scale='min(1280,iw)':-2:flags=lanczos,format=yuv420p"
            _tmp = cache_path.with_suffix('.part')
            _cmd = [
                ffmpeg_path, '-y',
                '-i', str(path),
                '-map', '0:v:0', '-an', '-vf', _vf,
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
                '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
                '-f', 'mp4', str(_tmp),
            ]
            try:
                _proc = subprocess.run(_cmd, capture_output=True, timeout=600)
                if _proc.returncode != 0 or not _tmp.is_file() or _tmp.stat().st_size == 0:
                    try: _tmp.unlink(missing_ok=True)
                    except Exception: pass
                    return False
                if not _path_has_video_stream(_tmp):
                    try: _tmp.unlink(missing_ok=True)
                    except Exception: pass
                    return False
                os.replace(str(_tmp), str(cache_path))
                return True
            except Exception:
                try: _tmp.unlink(missing_ok=True)
                except Exception: pass
                return False

        def _cam_error(err: str, emsg: str) -> None:
            update_session(session_id, done=True, pct=-1, stage='failed',
                           message=emsg, error=err, kind='preview')
            _write_preview_sidecar(emsg, True, err)

        # ── R3D (REDCODE RAW) ─────────────────────────────────────────────────
        if _is_red:
            if _find_redline():
                _cam_status('Opening RED camera file… this may take a minute', 10)
                def _red_status(msg: str) -> None:
                    _cam_status(msg, 50 if 'Encoding' in msg else 15)
                _red_ok, _ = _red_transcode_to_h264(
                    media_path=str(path), output_mp4=str(cache_path),
                    ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path,
                    on_status=_red_status,
                )
                if _red_ok and cache_path.is_file() and cache_path.stat().st_size > 0:
                    _cam_success(); return
            # REDline not found or failed — try macOS AVFoundation (RED Plugin)
            if _try_avconvert('RED RAW'):
                _cam_success(); return
            if _try_ffmpeg_direct('RED RAW'):
                _cam_success(); return
            _cam_error('RED_NO_TOOL',
                       'Preview failed: RED RAW file requires REDline (red.com) '
                       'or RED Plugin for Mac (install REDCINE-X PRO).')
            return

        # ── Sony RAW (X-OCN / VC6 / XAVC RAW) ───────────────────────────────
        if _is_sony_raw:
            if _try_avconvert('Sony RAW'):
                _cam_success(); return
            if _try_ffmpeg_direct('Sony MXF'):
                _cam_success(); return
            _cam_error('SONY_NO_TOOL',
                       'Preview failed: Sony RAW camera file requires Sony RAW Viewer.')
            return

        # ── Blackmagic RAW ────────────────────────────────────────────────────
        if _is_braw:
            if _try_avconvert('Blackmagic RAW'):
                _cam_success(); return
            if _try_ffmpeg_direct('Blackmagic RAW'):
                _cam_success(); return
            _cam_error('BRAW_NO_TOOL',
                       'Preview failed: Blackmagic RAW file requires DaVinci Resolve '
                       'or Blackmagic Desktop Video codec pack.')
            return

        # ── ARRIRAW / other camera RAW — try ARRI tools then AVFoundation ────
        _arri_tool = _find_art_cmd() or _find_arc_cmd()
        if _arri_tool:
            _cam_status('Opening camera file… this may take a minute', 10)
            def _arri_status(msg: str) -> None:
                _cam_status(msg, 50 if 'Encoding' in msg else 15)
            _arri_ok, _ = _arriraw_transcode_to_h264(
                media_path=str(path), output_mp4=str(cache_path),
                ffmpeg_path=ffmpeg_path, ffprobe_path=ffprobe_path,
                on_status=_arri_status,
            )
            if _arri_ok and cache_path.is_file() and cache_path.stat().st_size > 0:
                _cam_success(); return
        # ARRI tool not found or failed — try macOS AVFoundation (ARRI codec pack)
        if _try_avconvert('camera RAW'):
            _cam_success(); return
        if _try_ffmpeg_direct('camera RAW'):
            _cam_success(); return
        _cam_error('ARRIRAW_NO_TOOL',
                   'Preview failed: camera RAW file requires ARRI Reference Tool CMD '
                   '(arri.com) or install DaVinci Resolve to enable system codecs.')
        return

    # scale to max 1280 wide, preserve aspect, yuv420p for universal browser compat
    vf = "scale='min(1280,iw)':-2:flags=lanczos,format=yuv420p"

    cmd = [
        ffmpeg_path, '-y',
        '-i', str(path),
        '-map', '0:v:0',   # explicit first video stream; avoids "no output stream" on MXF
        '-an',             # no audio — preview proxy is video-only
        '-vf', vf,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-pix_fmt', 'yuv420p',   # force 8-bit YUV so all browsers can decode
        '-movflags', '+faststart',
        '-f', 'mp4',
        str(tmp_path),
    ]
    update_session(session_id, done=False, pct=5, stage='running',
                   message='Building preview proxy…', kind='preview',
                   path=str(cache_path), error=None)
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=600)
        if proc.returncode != 0 or not tmp_path.is_file() or tmp_path.stat().st_size == 0:
            stderr = (proc.stderr or b'')[-300:].decode('utf-8', errors='replace').strip()
            try: tmp_path.unlink(missing_ok=True)
            except Exception: pass
            # ffmpeg failed outright. If the file looks like camera-RAW
            # (extension or wrapper tags) try AVFoundation as a fallback before
            # surfacing the raw ffmpeg error — same recovery path the
            # undecodable-codec branch uses.
            if (_is_red or _is_sony_raw or _is_braw
                    or _file_ext in ('.ari', '.arx') or _probed_codec == 'arriraw'):
                _avc_ok, _ = _avconvert_transcode_to_h264(
                    media_path=str(path), output_mp4=str(cache_path),
                    ffmpeg_path=ffmpeg_path,
                )
                if _avc_ok and _path_has_video_stream(cache_path):
                    update_session(session_id, done=True, pct=100, stage='complete',
                                   message='Preview ready', path=str(cache_path),
                                   error=None, kind='preview')
                    _write_preview_sidecar('Preview ready', True, None)
                    return
                if _is_red:
                    _err, _emsg = 'RED_NO_TOOL', 'Preview failed: RED RAW file requires REDline or RED Plugin for Mac.'
                elif _is_sony_raw:
                    _err, _emsg = 'SONY_NO_TOOL', 'Preview failed: Sony RAW camera file requires Sony RAW Viewer.'
                elif _is_braw:
                    _err, _emsg = 'BRAW_NO_TOOL', 'Preview failed: Blackmagic RAW file requires DaVinci Resolve or Blackmagic codec pack.'
                else:
                    _err, _emsg = 'ARRIRAW_NO_TOOL', 'Preview failed: camera RAW file requires ARRI Reference Tool or DaVinci Resolve.'
                update_session(session_id, done=True, pct=-1, stage='failed',
                               message=_emsg, error=_err, kind='preview')
                _write_preview_sidecar(_emsg, True, _err)
                return
            update_session(session_id, done=True, pct=-1, stage='failed',
                           message=f'Preview failed: {stderr}',
                           error=f'ffmpeg exit {proc.returncode}: {stderr}', kind='preview')
            _write_preview_sidecar(f'Preview failed: {stderr}', True, f'ffmpeg exit {proc.returncode}: {stderr}')
            return
        # ── Post-check: make sure output actually contains a video stream ──────
        _has_output_video = _path_has_video_stream(tmp_path)
        if not _has_output_video:
            try:
                tmp_path.unlink(missing_ok=True)
            except Exception:
                pass
            # ffmpeg produced no video stream — try macOS AVFoundation before failing
            _avc2 = _find_avconvert()
            if _avc2:
                update_session(session_id, done=False, pct=20, stage='running',
                               message='Decoding via system codec (AVFoundation)…',
                               kind='preview', path=str(cache_path), error=None)
                _avc2_ok, _ = _avconvert_transcode_to_h264(
                    media_path=str(path), output_mp4=str(cache_path),
                    ffmpeg_path=ffmpeg_path,
                )
                if _avc2_ok and _path_has_video_stream(cache_path):
                    update_session(session_id, done=True, pct=100, stage='complete',
                                   message='Preview ready', path=str(cache_path),
                                   error=None, kind='preview')
                    _write_preview_sidecar('Preview ready', True, None)
                    return
            if _file_ext == '.r3d' or _probed_codec == 'r3d':
                _err = 'RED_NO_TOOL'
                _emsg = ('Preview failed: RED RAW file requires REDline (red.com) '
                         'or RED Plugin for Mac')
            elif _is_sony_raw:
                _err = 'SONY_NO_TOOL'
                _emsg = 'Preview failed: Sony RAW camera file requires Sony RAW Viewer'
            elif _file_ext == '.braw' or _probed_codec in ('braw_sdk', 'braw'):
                _err = 'BRAW_NO_TOOL'
                _emsg = ('Preview failed: Blackmagic RAW file requires DaVinci Resolve '
                         'or Blackmagic Desktop Video codec pack')
            elif _file_ext in ('.ari', '.arx') or _probed_codec == 'arriraw':
                _err = 'ARRIRAW_NO_TOOL'
                _emsg = ('Preview failed: ARRIRAW file requires ARRI Reference Tool CMD '
                         '(arri.com) or DaVinci Resolve')
            else:
                _err = 'ARRIRAW_NO_TOOL'
                _emsg = 'Preview failed: camera RAW file requires an external decoder'
            update_session(session_id, done=True, pct=-1, stage='failed',
                           message=_emsg, error=_err, kind='preview')
            _write_preview_sidecar(_emsg, True, _err)
            return
        os.replace(str(tmp_path), str(cache_path))
        update_session(session_id, done=True, pct=100, stage='complete',
                       message='Preview ready', path=str(cache_path), error=None, kind='preview')
        _write_preview_sidecar('Preview ready', True, None)
    except subprocess.TimeoutExpired:
        update_session(session_id, done=True, pct=-1, stage='failed',
                       message='Preview proxy timed out after 10 min', error='timeout', kind='preview')
        _write_preview_sidecar('Preview proxy timed out after 10 min', True, 'timeout')
    except Exception as exc:
        update_session(session_id, done=True, pct=-1, stage='failed',
                       message=f'Preview error: {exc}', error=str(exc), kind='preview')
        _write_preview_sidecar(f'Preview error: {exc}', True, str(exc))
    finally:
        try:
            Path(tmp_path).unlink(missing_ok=True)
        except Exception:
            pass


def _probe_asset(path: Path, ffprobe_path: str | None) -> dict:
    """Full ffprobe probe of a media file. Returns normalised asset metadata.

    Works for any container ffprobe can read (.mov ProRes, .mxf, .mp4, .r3d
    sidecar .mov, etc.).  The timecode probe covers both format-level tags
    (most .mov/.mp4 containers) and per-stream tags (QuickTime tmcd data
    track used by many camera-original ProRes files).
    """
    out: dict = {
        'fps': 24.0,
        'durationSec': 0.0,
        'frameCount': 0,
        'width': 0,
        'height': 0,
        'codec': '',
        'pixelFormat': '',
        'colorSpace': '',
        'colorTransfer': '',
        'startTimecode': '',
        'timecodeSource': 'unknown',
        # protocol v1 enriched fields
        'timecodeBase': 24,
        'dropFrame': False,
        'hasTimecodeTrack': False,
        'durationTimecode': '',
    }
    if not ffprobe_path:
        return out
    try:
        proc = subprocess.run(
            [ffprobe_path, '-v', 'error', '-print_format', 'json',
             '-show_streams', '-show_format', str(path)],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            return out
        data = json.loads((proc.stdout or '').strip() or '{}')
    except Exception:
        return out

    streams = data.get('streams') or []
    fmt = data.get('format') or {}
    fmt_tags = fmt.get('tags') or {}

    # --- video stream: pick the first one
    for s in streams:
        if s.get('codec_type') != 'video':
            continue
        # Frame rate — prefer r_frame_rate (exact) over avg_frame_rate (VFR avg)
        for rate_key in ('r_frame_rate', 'avg_frame_rate'):
            rate_str = str(s.get(rate_key) or '')
            if '/' in rate_str:
                try:
                    num, den = (int(x) for x in rate_str.split('/', 1))
                    if den > 0:
                        out['fps'] = round(num / den, 9)
                        break
                except Exception:
                    pass
        # Duration: stream value is more accurate than format for trimmed files
        dur_raw = s.get('duration') or fmt.get('duration') or '0'
        try:
            out['durationSec'] = float(dur_raw)
        except Exception:
            pass
        out['width'] = int(s.get('width') or 0)
        out['height'] = int(s.get('height') or 0)
        out['codec'] = str(s.get('codec_name') or '')
        out['pixelFormat'] = str(s.get('pix_fmt') or '')
        out['colorSpace'] = str(s.get('color_space') or '')
        out['colorTransfer'] = str(s.get('color_transfer') or '')
        break

    if out['durationSec'] > 0 and out['fps'] > 0:
        out['frameCount'] = int(round(out['durationSec'] * out['fps']))

    # --- timecode: format-level tags first (most reliable for .mov/.mp4),
    # then per-stream tags which catches the QuickTime tmcd data track that
    # camera-original ProRes files use.
    tc = str(fmt_tags.get('timecode') or '').strip()
    if tc:
        out['startTimecode'] = tc
        out['timecodeSource'] = 'embedded'
    else:
        for s in streams:
            stream_tc = str((s.get('tags') or {}).get('timecode') or '').strip()
            if stream_tc:
                out['startTimecode'] = stream_tc
                out['timecodeSource'] = 'embedded'
                break

    # --- protocol v1 enriched fields -------------------------------------------
    # dropFrame: semicolon separator before the frame count (SMPTE DF convention)
    out['dropFrame'] = ';' in out['startTimecode']

    # timecodeBase: nearest standard integer to the actual fps
    out['timecodeBase'] = _fps_to_base(out['fps'])

    # hasTimecodeTrack: dedicated tmcd data-track or any data stream with TC tag
    out['hasTimecodeTrack'] = any(
        str(s.get('codec_name') or '').lower() == 'tmcd'
        or (s.get('codec_type') == 'data' and (s.get('tags') or {}).get('timecode'))
        for s in streams
    )

    # durationTimecode: total duration expressed as a TC string
    if out['durationSec'] > 0 and out['fps'] > 0:
        out['durationTimecode'] = _seconds_to_timecode(
            out['durationSec'], out['fps'], out['dropFrame'],
        )

    return out


def _resolve_main_media_from_cpl(cpl_path: Path, folder: Path) -> Path | None:
    asset_map = _build_asset_path_map(folder, include_siblings=True)
    segments = _parse_cpl_video_segments(cpl_path)
    for segment in segments:
        try:
            candidate = asset_map.get(str(segment.get('track_id') or ''))
        except Exception:
            candidate = None
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    return None


def _resolve_segment_inputs_from_cpl(cpl_path: Path, folder: Path) -> list[dict[str, float | int | str]]:
    inputs, _ = _build_cpl_segment_inputs(cpl_path, folder)
    return inputs


def _build_audio_args(pcm_tracks: list[dict]) -> list[str] | None:
    """Build ffmpeg map/codec/metadata args for all PCM audio tracks.

    Returns None when there are no usable tracks (caller should use video-only args).
    Channel layout preservation: 6ch → 5.1 AAC (448 kbps), 2ch → stereo AAC (192 kbps).
    7.1 (8ch) and higher are preserved natively; mono/unknown-ch folds to stereo.
    """
    if not pcm_tracks:
        return None
    args: list[str] = ["-map", "0:v:0"]
    for i in range(len(pcm_tracks)):
        args += ["-map", f"0:a:{i}"]
    args += ["-c:a", "aac"]
    for i, track in enumerate(pcm_tracks):
        cc = int(track.get("channelCount") or 0)
        if cc <= 0:
            cc = 2  # default to stereo when unknown
        if cc == 6:
            bitrate, title = "448k", "Surround 5.1"
        elif cc == 8:
            bitrate, title = "640k", "Surround 7.1"
        elif cc == 2:
            bitrate, title = "192k", "Stereo 2.0"
        elif cc == 1:
            bitrate, title = "128k", "Mono"
        else:
            # Fold unknown channel counts down to stereo with proper ITU-R BS.775 downmix
            bitrate, title = "320k", f"{cc}ch Audio (stereo mix)"
            args += [f"-filter:a:{i}", "pan=stereo|FL<FL+0.707*FC+0.707*BL+0.707*SL|FR<FR+0.707*FC+0.707*BR+0.707*SR"]
            cc = 2
        args += [f"-b:a:{i}", bitrate, f"-ac:a:{i}", str(cc), f"-metadata:s:a:{i}", f"title={title}"]
    # Note: -progress/-nostats are NOT added here; this function is module-level and
    # has no access to the caller's progress_path.  The caller must append them.
    return args


def _audio_mode_from_tracks(pcm_tracks: list[dict], has_iab: bool, iab_decode_ready: bool) -> tuple[str, str]:
    """Return (audioMode, audioMessage) based on what tracks are present."""
    has_51  = any(int(t.get("channelCount") or 0) == 6 for t in pcm_tracks)
    has_71  = any(int(t.get("channelCount") or 0) == 8 for t in pcm_tracks)
    has_20  = any(int(t.get("channelCount") or 0) == 2 for t in pcm_tracks)
    has_other = any(int(t.get("channelCount") or 0) not in (2, 6, 8) for t in pcm_tracks)

    if has_71 and has_20:
        return "stereo_71", "Proxy audio: 7.1 AAC (640 kbps) + Stereo AAC (192 kbps)."
    if has_51 and has_20:
        return "stereo_51", "Proxy audio: 5.1 AAC (448 kbps) + Stereo AAC (192 kbps)."
    if has_71:
        return "surround_7_1", "Proxy audio: Surround 7.1 AAC (640 kbps)."
    if has_51:
        return "surround_5_1", "Proxy audio: Surround 5.1 AAC (448 kbps)."
    if has_20:
        return "stereo_2_0", "Proxy audio: Stereo 2.0 AAC (192 kbps)."
    if has_other and pcm_tracks:
        return "stereo_proxy", "Proxy audio was transcoded to stereo AAC."
    # IAB-only package
    if has_iab and iab_decode_ready:
        return "iab_stereo", "Proxy audio: IAB / Dolby Atmos decoded to stereo AAC."
    if has_iab:
        return "iab_direct", "Proxy audio: IAB stream — direct FFmpeg decode attempted."
    return "stereo_proxy", "Proxy audio was transcoded to stereo AAC."


def start_proxy_playback(
    session_id: str,
    folder_path: str,
    cpl_path: str,
    *,
    out_dir: str | None = None,
    force_resolve: bool = False,
) -> tuple[bool, str | None]:
    folder = Path(folder_path).expanduser().resolve()
    cpl = Path(cpl_path).expanduser().resolve()
    ffmpeg_path = _find_ffmpeg()
    if not ffmpeg_path:
        update_session(session_id, done=True, pct=-1, error="ffmpeg not found")
        return False, "ffmpeg not found"

    immersive = get_immersive_audio_support(ffmpeg_path)

    cpl_data: dict = {}
    try:
        cpl_data = _scan_cpl(cpl)
    except Exception:
        pass
    ffprobe_path = _find_ffprobe(ffmpeg_path)
    main_path = _resolve_main_media_from_cpl(cpl, folder)
    cache_path = _proxy_cache_path(folder, cpl, out_dir or "", cpl_data, main_path)
    proxy_name = _proxy_display_name(cpl, cpl_data, main_path)
    start_timecode = _probe_media_timecode(main_path, ffprobe_path)
    cache_path = _adopt_named_proxy_cache(folder, cpl, cache_path, out_dir=out_dir or "", cpl_data=cpl_data, main_path=main_path, start_timecode=start_timecode)

    # Content-addressable registry lookup — finds a valid proxy even when the package
    # was moved to a different folder or the companion was restarted (path-based cache
    # would miss in both cases, but the fingerprint stays the same).
    _cpl_fp = _cpl_content_fingerprint(cpl_data) if cpl_data else ""
    if _cpl_fp and not _proxy_cache_is_valid(cache_path):
        _reg_hit = _registry_lookup(_cpl_fp)
        if _reg_hit:
            _reg_path = Path(str(_reg_hit.get("proxyPath") or ""))
            if _proxy_cache_is_valid(_reg_path) and _reg_path != cache_path:
                cache_path = _reg_path
                proxy_name = str(_reg_hit.get("proxyName") or proxy_name)
                start_timecode = str(_reg_hit.get("startTimecode") or start_timecode)

    audio_tracks_list: list[dict] = cpl_data.get("audioTracks", [])
    pcm_tracks = [t for t in audio_tracks_list if not t.get("isIAB")]
    has_iab_audio = any(t.get("isIAB") for t in audio_tracks_list)
    if pcm_tracks or has_iab_audio:
        audio_mode, audio_message = _audio_mode_from_tracks(pcm_tracks, has_iab_audio, bool(immersive.get("iabDecode")))
    else:
        _iab_eng = str(immersive.get("engineId") or "")
        if not immersive.get("iabDecode"):
            audio_mode = "video_only"
            audio_message = "Proxy is video-only — no IAB/Dolby Atmos decoder available on this machine."
        elif _iab_eng == "resolve-engine":
            # Don't commit to "video_only" up-front — Resolve may succeed.
            # The actual render will overwrite audioMode via update_session().
            audio_mode = "unknown"
            audio_message = "Resolve Engine selected — rendering IAB/Dolby Atmos audio…"
        else:
            audio_mode = "video_only"
            audio_message = "Proxy is video-only in the current build."

    update_session(session_id, kind='proxy', path=str(cache_path), audioMode=audio_mode, audioMessage=audio_message, immersive=immersive, proxyName=proxy_name, startTimecode=start_timecode)

    if _proxy_cache_is_valid(cache_path):
        # For IAB packages: check whether the cached proxy is stale (built without audio
        # by an older code path that never attempted IAB → audio downmix).
        # Rules:
        #  • If a proper IAB decoder is now available and the cached proxy is video-only
        #    → stale: regenerate with the real decoder.
        #  • If no proper decoder but the cached proxy is video-only AND the new
        #    last-resort direct-FFmpeg path has NOT been tried yet (iabDirectTried absent)
        #    → stale: attempt the last-resort downmix exactly once.
        #  • If iabDirectTried is set → honour the cache regardless (regenerating again
        #    won't produce a better result for pure IAB bitstream packages).
        _cache_stale = False
        if has_iab_audio:
            _sidecar = _read_proxy_sidecar(cache_path)
            _cached_audio_mode = str(_sidecar.get("audioMode") or "")
            _iab_tried = bool(_sidecar.get("iabDirectTried"))
            if _cached_audio_mode in ("video_only", "unknown", ""):
                # Use live resolve_engine_status() — detect_resolve() only checks disk
                # and would invalidate cache whenever Resolve is installed but not running.
                _resolve_can_try = False
                try:
                    from .engines.resolve_engine import resolve_engine_status
                    _rs = resolve_engine_status()
                    _resolve_can_try = bool(_rs.get("connected") and _rs.get("apiAvailable"))
                except Exception:
                    _resolve_can_try = False
                if immersive.get("iabDecode") or _resolve_can_try or not _iab_tried:
                    _cache_stale = True
                    _safe_unlink(cache_path)
        if not _cache_stale:
            # Prefer the audioMode that was recorded in the sidecar when the proxy was
            # built — it reflects what actually got encoded.  The recomputed audio_mode
            # uses *current* immersive capabilities, which can differ from build time
            # (e.g. the IAB adapter was present at build time but is now removed).
            # Without this, a proxy built with iab_stereo audio would be labelled
            # 'stereo_proxy' until the next regeneration.
            _effective_mode = audio_mode
            _effective_message = audio_message
            if has_iab_audio:
                _sm = str(_sidecar.get("audioMode") or "")
                if _sm and _sm not in ("video_only", "unknown"):
                    # Sidecar records a real audio mode (iab_stereo, stereo_2_0, etc.) —
                    # use it to override the recomputed capabilities-based prediction.
                    _effective_mode = _sm
                    _effective_message = str(_sidecar.get("audioMessage") or "") or audio_message
                elif _sm in ("video_only", "unknown"):
                    # Sidecar says no audio was encoded.  Trust it — the recomputed
                    # audio_mode from _audio_mode_from_tracks returns "stereo_proxy" as a
                    # fallthrough when pcm_tracks=[] and iabDecode=False, even though no
                    # audio was actually built into the proxy.
                    _effective_mode = "video_only"
                    _effective_message = str(_sidecar.get("audioMessage") or "") or "Proxy has no audio track."
            update_session(
                session_id,
                kind="proxy",
                done=True,
                pct=100,
                stage="complete",
                message="Proxy ready (cached)",
                path=str(cache_path),
                dovi=_extract_dovi(cpl, folder),
                audioMode=_effective_mode,
                audioMessage=_effective_message,
                immersive=immersive,
                proxyName=proxy_name,
                startTimecode=start_timecode,
                error=None,
                _log=f"[companion] cache_hit=1\n[companion] cache_path={cache_path}",
                proc=None,
            )
            # Keep registry current so this proxy is found even if the package moves.
            if _cpl_fp:
                _fps = float(cpl_data.get("editRate") or 0) if cpl_data else 0.0
                _registry_register(
                    _cpl_fp, str(cache_path),
                    proxy_name=proxy_name, audio_mode=_effective_mode,
                    audio_message=_effective_message, start_timecode=start_timecode,
                    fps=_fps, cpl_id=str((cpl_data or {}).get("id") or ""),
                    content_title=str((cpl_data or {}).get("contentTitle") or proxy_name),
                    folder_path=str(folder),
                )
            return True, None

    threading.Thread(
        target=_transcode_worker,
        args=(session_id, folder, cpl, ffmpeg_path, out_dir or "", str(cache_path), force_resolve),
        daemon=True,
    ).start()
    return True, None


def start_iab_decode(
    session_id: str,
    asset_path: str,
    *,
    out_dir: str | None = None,
) -> tuple[bool, str | None]:
    source = Path(asset_path).expanduser().resolve()
    ffmpeg_path = _find_ffmpeg()
    if not ffmpeg_path:
        update_session(
            session_id,
            kind="iab_decode",
            done=True,
            pct=-1,
            stage="failed",
            message="ffmpeg is not installed",
            error="ffmpeg not found",
        )
        return False, "ffmpeg not found"

    threading.Thread(
        target=_decode_iab_worker,
        args=(session_id, source, ffmpeg_path, out_dir or ""),
        daemon=True,
    ).start()
    return True, None


def extract_waveform_peaks(
    wav_path: str,
    points_per_sec: int = 100,
    max_sec: float = 0,
) -> dict:
    """Read a WAV file and return per-channel min/max waveform peaks.

    Returns a dict with keys: channels, sampleRate, duration, pointsPerSec,
    peaks (list[list[list[float]]] — peaks[ch][0]=mins, peaks[ch][1]=maxs).
    """
    with wave.open(wav_path, "rb") as wf:
        n_channels  = wf.getnchannels()
        sample_rate = wf.getframerate()
        sampwidth   = wf.getsampwidth()   # bytes per sample
        n_frames    = wf.getnframes()
        duration    = n_frames / sample_rate if sample_rate else 0.0
        if max_sec > 0:
            n_frames = min(n_frames, int(max_sec * sample_rate))

        pts_per_sec = max(1, points_per_sec)
        frames_per_point = max(1, sample_rate // pts_per_sec)
        scale = {1: 128.0, 2: 32768.0, 3: 8388608.0, 4: 2147483648.0}.get(sampwidth, 32768.0)

        peaks: list[list[list[float]]] = [[[], []] for _ in range(n_channels)]
        bucket_min = [scale]  * n_channels
        bucket_max = [-scale] * n_channels
        count = 0

        raw = wf.readframes(n_frames)

    frame_bytes = sampwidth * n_channels
    for i in range(len(raw) // frame_bytes):
        off = i * frame_bytes
        for ch in range(n_channels):
            sb = raw[off + ch * sampwidth : off + (ch + 1) * sampwidth]
            if sampwidth == 1:
                v = float(sb[0]) - 128.0
            elif sampwidth == 2:
                v = float(struct.unpack_from("<h", sb)[0])
            elif sampwidth == 3:
                pad = b"\xff" if sb[2] & 0x80 else b"\x00"
                v = float(struct.unpack_from("<i", sb + pad)[0]) / 256.0
            else:
                v = float(struct.unpack_from("<i", sb)[0])
            if v < bucket_min[ch]:
                bucket_min[ch] = v
            if v > bucket_max[ch]:
                bucket_max[ch] = v
        count += 1
        if count >= frames_per_point:
            for ch in range(n_channels):
                peaks[ch][0].append(round(bucket_min[ch] / scale, 4))
                peaks[ch][1].append(round(bucket_max[ch] / scale, 4))
                bucket_min[ch] = scale
                bucket_max[ch] = -scale
            count = 0

    # Flush partial bucket
    if count > 0:
        for ch in range(n_channels):
            peaks[ch][0].append(round(bucket_min[ch] / scale, 4))
            peaks[ch][1].append(round(bucket_max[ch] / scale, 4))

    return {
        "channels":     n_channels,
        "sampleRate":   sample_rate,
        "duration":     round(duration, 3),
        "pointsPerSec": pts_per_sec,
        "peaks":        peaks,
    }


def _decode_iab_worker(session_id: str, source: Path, ffmpeg_path: str, out_dir: str) -> None:
    """Background thread: decode an IAB audio MXF to a WAV artifact.

    Tries the external IAB adapter first, then falls back to FFmpeg native
    IAB decoder (if available).  Updates the session state throughout.
    """
    logs: list[str] = []

    def _flush_log() -> None:
        try:
            update_session(session_id, _log="\n".join(logs))
        except Exception:
            pass

    work_dir = Path(out_dir).expanduser().resolve() if out_dir else source.parent
    out_wav = work_dir / f"{source.stem}_iab_decoded.wav"

    try:
        immersive = get_immersive_audio_support(ffmpeg_path)
        adapter_path: str = immersive.get("adapterPath") or ""
        iab_decode_native: bool = bool(immersive.get("iabDecode"))

        if not adapter_path and not iab_decode_native:
            update_session(
                session_id,
                done=True, pct=-1, stage="failed",
                message="No IAB decoder available (install adapter or FFmpeg with IAB support)",
                error="no_iab_decoder",
            )
            return

        update_session(session_id, pct=5, stage="decoding", message="Decoding IAB audio\u2026")
        _flush_log()

        ok = False
        detail = ""

        # Attempt 1: external IAB adapter
        if adapter_path:
            logs.append(f"[companion] Trying IAB adapter: {adapter_path}")
            _flush_log()
            ok, detail = _run_iab_adapter_decode(adapter_path, source, out_wav, logs)
            if ok:
                logs.append(f"[companion] Adapter decode OK \u2192 {out_wav}")

        # Attempt 2: FFmpeg native IAB decoder
        if not ok and iab_decode_native:
            logs.append("[companion] Trying FFmpeg native IAB decode")
            _flush_log()
            cmd = [
                ffmpeg_path, "-y",
                "-i", str(source),
                "-vn", "-c:a", "pcm_s24le",
                str(out_wav),
            ]
            logs.append(f"[companion] ffmpeg_cmd={' '.join(cmd)}")
            _flush_log()
            try:
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
                if result.stdout:
                    logs.extend(line.rstrip() for line in result.stdout.splitlines() if line.strip())
                if result.stderr:
                    logs.extend(line.rstrip() for line in result.stderr.splitlines() if line.strip())
                if result.returncode == 0 and out_wav.is_file() and out_wav.stat().st_size > 0:
                    ok = True
                    logs.append(f"[companion] FFmpeg native IAB decode OK \u2192 {out_wav}")
                else:
                    detail = (
                        " | ".join((result.stderr or result.stdout or "").strip().splitlines()[-8:])
                        or f"ffmpeg exited with {result.returncode}"
                    )
                    detail = detail[:320]
            except subprocess.TimeoutExpired:
                detail = "FFmpeg IAB decode timed out"
                logs.append(f"[companion] {detail}")
            except Exception as exc:
                detail = str(exc)[:200]
                logs.append(f"[companion] FFmpeg IAB decode error: {detail}")

        _flush_log()

        if ok and out_wav.is_file():
            update_session(
                session_id,
                done=True, pct=100, stage="done",
                message="IAB decode complete",
                artifactPath=str(out_wav),
                artifactType="wav",
                _log="\n".join(logs),
            )
        else:
            update_session(
                session_id,
                done=True, pct=-1, stage="failed",
                message=f"IAB decode failed: {detail}",
                error=detail or "iab_decode_failed",
                _log="\n".join(logs),
            )

    except Exception as exc:
        logs.append(f"[companion] _decode_iab_worker unhandled: {exc}")
        update_session(
            session_id,
            done=True, pct=-1, stage="failed",
            message=f"IAB decode error: {exc}",
            error=str(exc)[:200],
            _log="\n".join(logs),
        )


def _transcode_worker(session_id: str, folder: Path, cpl_path: Path, ffmpeg_path: str, out_dir: str, cache_path_str: str = "", force_resolve: bool = False) -> None:
    try:
        _transcode_worker_inner(session_id, folder, cpl_path, ffmpeg_path, out_dir, cache_path_str, force_resolve)
    except Exception as exc:
        # Last-resort guard: if any unhandled exception escapes the inner function
        # (e.g. path resolution failure before the first update_session call), the daemon
        # thread dies silently and the session is stuck as 'running' forever — clients
        # poll /progress indefinitely with no error response.
        try:
            update_session(session_id, done=True, error=f"Internal error: {exc}"[:300],
                           stage="failed", pct=-1)
        except Exception:
            pass


def _transcode_worker_inner(session_id: str, folder: Path, cpl_path: Path, ffmpeg_path: str, out_dir: str, cache_path_str: str = "", force_resolve: bool = False) -> None:
    immersive = get_immersive_audio_support(ffmpeg_path)
    # True when DaVinci Resolve Studio is running with its scripting API active.
    # When available, Resolve is always tried first — it applies proper DV color science,
    # decodes IAB/Atmos natively, and produces higher-quality proxies than ffmpeg alone.
    _resolve_is_available = str(immersive.get('engineId') or '') == 'resolve-engine'

    cpl_data: dict = {}
    try:
        cpl_data = _scan_cpl(cpl_path)
    except Exception:
        pass
    ffprobe_path = _find_ffprobe(ffmpeg_path)
    main_path = _resolve_main_media_from_cpl(cpl_path, folder)
    main_info = _probe_media_info(str(main_path), ffprobe_path) if main_path else None
    use_j2k_lowres = str((main_info or {}).get('codec') or '').lower() in {'jpeg2000', 'j2k'}
    # Default to a turbo review proxy. IMF JPEG2000/HTJ2K decode is the slow
    # part; lowres=3 is much faster and keeps timing/audio sync intact.
    # Override with PFX_IMF_PROXY_QUALITY=balanced for ~540p, or full for 1080p.
    proxy_quality = _current_proxy_quality()
    if proxy_quality == 'full':
        proxy_max_w, proxy_max_h = 1920, 1080
        proxy_video_bitrate, proxy_x264_crf, proxy_x264_preset = '8M', '22', 'fast'
        j2k_lowres_level = '1'
    elif proxy_quality == 'balanced':
        proxy_max_w, proxy_max_h = 1280, 720
        proxy_video_bitrate, proxy_x264_crf, proxy_x264_preset = '4M', '28', 'veryfast'
        j2k_lowres_level = '2'
    else:
        proxy_max_w, proxy_max_h = 854, 480
        proxy_video_bitrate, proxy_x264_crf, proxy_x264_preset = '3M', '30', 'ultrafast'
        j2k_lowres_level = '3'
    decoder_fast_args = ['-lowres', j2k_lowres_level] if use_j2k_lowres else []
    cache_path = Path(cache_path_str).expanduser().resolve() if cache_path_str else _proxy_cache_path(folder, cpl_path, out_dir, cpl_data, main_path)
    out_path = cache_path.with_name(f".{cache_path.name}.{session_id}.part")
    progress_path = _proxy_progress_path(cache_path)
    log_path = _proxy_log_path(cache_path)
    proxy_name = _proxy_display_name(cpl_path, cpl_data, main_path)
    start_timecode = _probe_media_timecode(main_path, ffprobe_path)
    update_session(session_id, immersive=immersive, path=str(cache_path), proxyName=proxy_name, startTimecode=start_timecode)
    audio_tracks_list: list[dict] = cpl_data.get("audioTracks", [])
    pcm_tracks = [t for t in audio_tracks_list if not t.get("isIAB")]
    has_iab_audio = any(t.get("isIAB") for t in audio_tracks_list)
    is_dolby_vision = bool(cpl_data.get('isDolbyVision'))
    expected_duration_ms = int(float(cpl_data.get('durationSec') or 0.0) * 1000)
    # Tracks whether the IAB external-adapter decoded successfully this run.
    # Declared here (not inside _try_segment_concat) so the final sidecar write
    # can read it after _try_segment_concat returns.
    _iab_adapter_decoded = False

    def _cleanup_output() -> None:
        for candidate in (out_path, progress_path):
            _safe_unlink(candidate)

    def _monitor_process(process: subprocess.Popen[bytes]) -> int:
        last_pct = 0
        _last_sidecar_pct = -1
        _sidecar_write_interval = 2.0   # write sidecar every 2 s or on meaningful pct change
        _last_sidecar_ts = time.monotonic()
        while process.poll() is None:
            progress = _read_ffmpeg_progress(progress_path)
            try:
                if progress.get('progress') == 'end':
                    last_pct = 100
                elif progress.get('out_time_ms') and expected_duration_ms > 0:
                    ms = int(str(progress.get('out_time_ms') or '0').strip() or '0') / 1000.0
                    last_pct = max(last_pct, min(99, int(ms / max(1, expected_duration_ms) * 100)))
            except Exception:
                pass
            safe_pct = max(0, min(99, last_pct))
            update_session(session_id, pct=safe_pct, stage='running',
                           message=f'Transcoding… {safe_pct}%')
            # Throttle sidecar writes: only when pct jumps ≥2 pp or every 2 s
            _now = time.monotonic()
            if abs(safe_pct - _last_sidecar_pct) >= 2 or (_now - _last_sidecar_ts) >= _sidecar_write_interval:
                state = get_session(session_id) or {}
                _write_proxy_sidecar(
                    cache_path,
                    proxyName=proxy_name, startTimecode=start_timecode,
                    state='running', pct=safe_pct, stage='running',
                    message=f'Transcoding… {safe_pct}%', done=False, error=None,
                    pid=process.pid, folderPath=str(folder), cplPath=str(cpl_path),
                    audioMode=state.get('audioMode', 'unknown'),
                    audioMessage=state.get('audioMessage', ''),
                    durationMs=expected_duration_ms, partPath=str(out_path),
                    progressPath=str(progress_path), logPath=str(log_path),
                )
                _last_sidecar_pct = safe_pct
                _last_sidecar_ts = _now
            time.sleep(1.0)   # 1 s poll — fast enough for UX, 4× fewer iterations than 0.25 s
        return process.wait()

    _smart_audio_args = _build_audio_args(pcm_tracks)
    if _smart_audio_args is not None:
        # _build_audio_args omits -progress/-nostats (it's module-level, no access to
        # progress_path).  Append them now so _monitor_process can read the .progress file.
        _smart_audio_args += ['-progress', str(progress_path), '-nostats']
    if _smart_audio_args is None and (has_iab_audio or not audio_tracks_list):
        _smart_audio_args = ['-map', '0:v:0', '-map', '0:a:0?', '-c:a', 'aac', '-b:a', '320k', '-ac', '2', '-progress', str(progress_path), '-nostats']
    audio_args = _smart_audio_args or ['-map', '0:v:0', '-map', '0:a:0?', '-c:a', 'aac', '-b:a', '320k', '-ac', '2', '-progress', str(progress_path), '-nostats']
    video_only_args = ['-map', '0:v:0', '-an', '-progress', str(progress_path), '-nostats']
    browser_scale_args = ['-vf', f"scale='min({proxy_max_w},iw)':'min({proxy_max_h},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2"]
    # CPU allocation: use all available cores for single-encoder path.
    # The parallel-decode path (below) splits cores across segment decoders.
    _cpu_count = os.cpu_count() or 4
    _enc_threads = ['-threads', str(_cpu_count)]
    codec_profiles = [
        # 1st: macOS VideoToolbox hardware H.264 — zero-CPU, fastest on Apple Silicon
        browser_scale_args + ['-c:v', 'h264_videotoolbox', '-b:v', proxy_video_bitrate,
                               '-allow_sw', '1', '-realtime', '0',
                               '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
        # 2nd: libx264 software — all CPU cores, quality-tuned
        browser_scale_args + ['-c:v', 'libx264', '-preset', proxy_x264_preset,
                               '-crf', proxy_x264_crf, '-pix_fmt', 'yuv420p',
                               *_enc_threads, '-movflags', '+faststart'],
        # 3rd: ultrafast libx264 — last resort
        browser_scale_args + ['-c:v', 'libx264', '-preset', 'ultrafast',
                               '-crf', '28', '-pix_fmt', 'yuv420p',
                               *_enc_threads, '-movflags', '+faststart'],
    ]

    # Dolby Vision sources are PQ-encoded HDR; apply a proper HDR→SDR tonemap via
    # ffmpeg when Resolve is unavailable.  Standard SDR content keeps the simple
    # format+setparams filter.  All rec709_frame_filter usages below share this value.
    if is_dolby_vision:
        # Determine source primaries from CPL metadata so we can declare them
        # explicitly to zscale — J2K/MXF streams are sometimes untagged or
        # incorrectly tagged by the decoder, so we never rely on metadata alone.
        _cpl_primaries = str(cpl_data.get('primaries') or '').lower()
        _primariesin = 'p3' if ('p3' in _cpl_primaries or 'display_p3' in _cpl_primaries or 'dci' in _cpl_primaries) else 'bt2020'
        # Correct HDR→SDR pipeline for DV IMF (SMPTE ST 2084 / BT.2020 or P3-D65):
        #
        # 1. zscale: PQ → linear, declare input colour space explicitly so the
        #    conversion is correct even when stream metadata is absent/wrong.
        #    npl=100 normalises output so 100 nits = 1.0 linear (SDR reference white).
        # 2. format=gbrpf32le: convert to 32-bit float GBR for accurate calculations.
        # 3. zscale=primaries=bt709: primaries conversion IN LINEAR LIGHT
        #    (BT.2020→BT.709 or P3-D65→BT.709). Must happen before tonemapping.
        # 4. tonemap=hable: Hable tone-map compresses the HDR signal to SDR range.
        #    desat=0 preserves saturation. peak=0 = auto-detect input peak.
        # 5. zscale: apply BT.709 OETF (gamma encode), set matrix and limited range.
        # 6. setparams: tag output so downstream muxer/decoder honours colour metadata.
        rec709_frame_filter = (
            f"zscale=transferin=smpte2084:primariesin={_primariesin}:matrixin=bt2020nc"
            f":transfer=linear:npl=100,"
            "format=gbrpf32le,"
            "zscale=primaries=bt709,"
            "tonemap=hable:desat=0:peak=0,"
            "zscale=transfer=bt709:matrix=bt709:range=tv,"
            "format=yuv420p,"
            "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"
        )
    else:
        rec709_frame_filter = "format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709"
    rec709_output_args = ['-color_primaries:v:0', 'bt709', '-color_trc:v:0', 'bt709', '-colorspace:v:0', 'bt709']
    container_meta_args = ['-map_metadata', '-1', '-map_chapters', '-1', *rec709_output_args, '-movflags', '+faststart+use_metadata_tags', '-metadata', f'title={proxy_name}', '-metadata:s:v:0', f'handler_name={proxy_name}']
    # Proxy jobs write to an atomic ".part" file first. Force the muxer because
    # ffmpeg cannot infer MP4 from that temporary extension.
    output_format_args = ['-f', 'mp4']
    if start_timecode:
        container_meta_args += ['-timecode', start_timecode]

    def _probe_audio_channel_count(path: Path) -> int:
        try:
            probe = subprocess.run(
                [ffprobe_path, '-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=channels', '-of', 'json', str(path)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                timeout=15,
            )
            if probe.returncode == 0:
                payload = json.loads(probe.stdout or '{}')
                streams = payload.get('streams') if isinstance(payload, dict) else None
                if isinstance(streams, list) and streams:
                    return max(0, int(streams[0].get('channels') or 0))
        except Exception:
            pass
        return 0

    def _dialogue_safe_stereo_filter(input_label: str, output_label: str, channels: int = 0) -> str:
        """Build a review-safe stereo fold-down for Resolve/IAB WAV output.

        Resolve's headless IAB render can expose a 7.1.4/Atmos bed whose channel
        order is not reliably understood by ffmpeg.  Referencing numeric channels
        avoids layout guessing, sums likely centre/surround/object positions into
        both ears, and normalises the result so dialogue is audible in Chrome.
        """
        ch = max(2, min(int(channels or 12), 16))
        left_terms: list[str] = []
        right_terms: list[str] = []
        for idx in range(ch):
            if idx == 0:
                left_terms.append('0.90*c0')
            elif idx == 1:
                right_terms.append('0.90*c1')
            elif idx in (2, 3):
                left_terms.append(f'0.70*c{idx}')
                right_terms.append(f'0.70*c{idx}')
            elif idx % 2 == 0:
                left_terms.append(f'0.45*c{idx}')
                right_terms.append(f'0.25*c{idx}')
            else:
                left_terms.append(f'0.25*c{idx}')
                right_terms.append(f'0.45*c{idx}')
        pan = f"pan=stereo|FL<{'+'.join(left_terms)}|FR<{'+'.join(right_terms)}"
        return f"{input_label}{pan},loudnorm=I=-16:LRA=11:TP=-1.5,aresample=48000{output_label}"

    def _run_one(base_inputs: list[str], codec_args: list[str], mux_args: list[str]) -> bool:
        # Extract -vf from codec_args and fold into filter_complex so it doesn't
        # conflict with -map.  Also add -fflags +genpts for MXF timestamp tolerance.
        _scale = ""
        _cargs: list[str] = []
        _skip = False
        for _i, _a in enumerate(codec_args):
            if _skip:
                _skip = False
                continue
            if _a == '-vf' and _i + 1 < len(codec_args):
                _scale = codec_args[_i + 1]
                _skip = True
            else:
                _cargs.append(_a)
        _fc = (f"[0:v:0]{_scale},{rec709_frame_filter}[vout]" if _scale
               else f"[0:v:0]{rec709_frame_filter}[vout]")
        # Rebuild mux_args: replace -map 0:v:0 with -map [vout] from filter_complex
        _mux: list[str] = []
        _skip_m = False
        for _i, _a in enumerate(mux_args):
            if _skip_m:
                _skip_m = False
                continue
            if _a == '-map' and _i + 1 < len(mux_args) and mux_args[_i + 1] == '0:v:0':
                _skip_m = True
                continue
            _mux.append(_a)
        cmd = ([ffmpeg_path, '-y',
                '-probesize', '5M', '-analyzeduration', '2M',
                '-fflags', '+genpts+discardcorrupt'] + base_inputs +
               ['-filter_complex', _fc, '-map', '[vout]'] + _cargs + _mux +
               container_meta_args + output_format_args + [str(out_path)])
        _cleanup_output()
        log_fp = open(log_path, 'a', encoding='utf-8', errors='replace')
        try:
            process = subprocess.Popen(cmd, stderr=log_fp, stdout=subprocess.DEVNULL, start_new_session=True)
            update_session(session_id, proc=process, path=str(cache_path), proxyName=proxy_name, startTimecode=start_timecode)
            _write_proxy_sidecar(cache_path, pid=process.pid, partPath=str(out_path), progressPath=str(progress_path), logPath=str(log_path), proxyName=proxy_name, startTimecode=start_timecode)
            rc = _monitor_process(process)
        finally:
            try:
                log_fp.close()
            except Exception:
                pass
        return rc == 0 and out_path.is_file() and out_path.stat().st_size > 0

    def _try_codecs(base_inputs: list[str], allow_audio: bool = True, expected_duration: float = 0.0, label: str = 'transcode') -> bool:
        mux_profiles = [audio_args, video_only_args] if allow_audio else [video_only_args]
        for mux_args in mux_profiles:
            for codec_args in codec_profiles:
                if _run_one(base_inputs, codec_args, mux_args):
                    actual_duration = _probe_duration_seconds(out_path, ffprobe_path)
                    if expected_duration > 10 and actual_duration is not None:
                        min_expected = max(expected_duration * 0.90, expected_duration - 3.0)
                        if actual_duration < min_expected:
                            _cleanup_output()
                            continue
                    if mux_args is video_only_args:
                        update_session(
                            session_id,
                            audioMode='video_only',
                            audioMessage=(
                                'Proxy is video-only because no local IAB / Dolby Atmos decoder is available.'
                                if not immersive.get('iabDecode') else 'Proxy is video-only in the current build.'
                            ),
                        )
                    else:
                        if pcm_tracks:
                            mode, msg = _audio_mode_from_tracks(pcm_tracks, has_iab_audio, bool(immersive.get('iabDecode')))
                        else:
                            # No PCM tracks from CPL; audio_args used the generic optional
                            # 0:a:0? mapping.  For a CPL-based IMF package the video MXF has
                            # no audio stream, so the proxy is effectively video-only.
                            # Reporting iab_stereo here would suppress the stale-cache check
                            # and permanently lock in the wrong mode.
                            mode, msg = 'video_only', 'Proxy is video-only (no PCM audio tracks resolved from CPL).'
                        update_session(session_id, audioMode=mode, audioMessage=msg)
                    return True
        return False

    def _try_segment_concat(segment_inputs: list[dict[str, float | int | str]], expected_duration: float = 0.0) -> bool:
        nonlocal _iab_adapter_decoded
        if not segment_inputs:
            return False

        n = len(segment_inputs)

        def _build_input_args(segs: list[dict], *, video: bool = False) -> list[str]:
            args: list[str] = []
            for seg in segs:
                inpoint = float(seg.get('inpoint') or 0.0)
                duration = float(seg.get('duration') or 0.0)
                if inpoint > 0:
                    args += ['-ss', f'{inpoint:.6f}']
                if duration > 0:
                    args += ['-t', f'{duration:.6f}']
                if video:
                    args += decoder_fast_args
                args += ['-i', str(seg['path'])]
            return args

        # Resolve PCM audio segments from CPL (skips IAB by track ID).
        # When audio_tracks_list is available (CPL was scanned) we use explicit set-based
        # filtering: an empty set() means "include nothing" — this is critical for IAB-only
        # packages where pcm_tracks=[] would otherwise yield `{} or None = None`, causing
        # _parse_cpl_audio_segments to fall back to keyword-only filtering and mistakenly
        # include IAB MXFs whose CPL sequence element is named MainAudioSequence (no keyword).
        try:
            # .lower() normalises UUIDs: imf_scan._clean_uuid does NOT lowercase, so
            # audio_tracks_list may carry mixed-case hex; proxy_service._clean_uuid
            # (used inside _parse_cpl_audio_segments) always lowercases. Without
            # .lower() here the set lookup would miss on uppercase CPL UUIDs.
            pcm_track_ids: set[str] | None = (
                {t['trackFileId'].lower() for t in pcm_tracks if not t.get('isIAB') and t.get('trackFileId')}
                if audio_tracks_list   # CPL scan data available — use explicit set (may be empty)
                else None              # no CPL scan data — fall back to keyword filter in parser
            )
            audio_segs, _ = _build_cpl_audio_inputs(cpl_path, folder, pcm_track_ids=pcm_track_ids)
            na = len(audio_segs)
        except Exception:
            audio_segs, na = [], 0

        # If no PCM audio found and the package has IAB tracks, attempt IAB decode
        _iab_tmpdir: "tempfile.TemporaryDirectory | None" = None
        if na == 0 and has_iab_audio:
            _adapter_path: str = immersive.get("adapterPath") or ""
            # Use iabDecodeNative (ffmpeg itself) not iabDecode (which may be True
            # only because Resolve is available).  Resolve does not participate in
            # direct ffmpeg -map 1:a:0 decode commands.
            _iab_native: bool = bool(immersive.get("iabDecodeNative") or immersive.get("iabDecode")) and \
                                 str(immersive.get("engineId") or "") not in ("resolve-engine",)
            # Keep empty set (not None) when CPL data is available.  None triggers
            # keyword fallback that misses IAB tracks named MainAudioSequence.
            _iab_track_ids: set[str] | None = (
                {t["trackFileId"].lower() for t in audio_tracks_list if t.get("isIAB") and t.get("trackFileId")}
                if audio_tracks_list else None
            )
            try:
                _iab_segs, _ = _build_cpl_iab_audio_inputs(cpl_path, folder, iab_track_ids=_iab_track_ids)
            except Exception:
                _iab_segs = []

            if _iab_segs and _adapter_path:
                # Decode all unique IAB MXFs in parallel (one thread per unique file).
                # Sequential decoding blocked the transcode start on multi-reel IAB packages;
                # parallel decode uses all cores simultaneously.
                import concurrent.futures as _iab_cf
                _iab_tmpdir = tempfile.TemporaryDirectory(prefix="pfx_iab_")
                _tmp_dir = Path(_iab_tmpdir.name)
                _unique_srcs = list(dict.fromkeys(s["path"] for s in _iab_segs))
                _decode_logs: list[str] = []

                def _decode_one_iab(src_str: str, idx: int) -> tuple[str, str]:
                    _src = Path(src_str)
                    _out = _tmp_dir / f"{_src.stem}_{idx}_decoded.wav"
                    _ok, _ = _run_iab_adapter_decode(_adapter_path, _src, _out, _decode_logs)
                    return src_str, str(_out) if _ok else ""

                _decoded_paths: dict[str, str] = {}
                with _iab_cf.ThreadPoolExecutor(max_workers=min(len(_unique_srcs), _cpu_count)) as _pool:
                    for _src_str, _wav_str in _pool.map(
                        lambda t: _decode_one_iab(t[1], t[0]),
                        enumerate(_unique_srcs)
                    ):
                        _decoded_paths[_src_str] = _wav_str
                _decoded_segs: list[dict] = []
                for _seg in _iab_segs:
                    _wav = _decoded_paths.get(_seg["path"], "")
                    if _wav and Path(_wav).is_file():
                        _decoded_segs.append({"path": _wav, "inpoint": _seg["inpoint"], "duration": _seg["duration"]})
                if _decoded_segs:
                    audio_segs = _decoded_segs
                    na = len(audio_segs)
                    _iab_adapter_decoded = True
                else:
                    # Adapter decode failed — clean up tmpdir and try FFmpeg native IAB
                    _iab_tmpdir.cleanup()
                    _iab_tmpdir = None
                    if _iab_native:
                        audio_segs = _iab_segs
                        na = len(audio_segs)
            elif _iab_segs and _iab_native:
                # No adapter — FFmpeg native IAB decoder handles MXF files directly
                audio_segs = _iab_segs
                na = len(audio_segs)
            elif _iab_segs and str(immersive.get("engineId") or "") == "resolve-engine":
                # Resolve Engine is available — attempt Resolve-assisted IAB → WAV decode
                # so ffmpeg can mux the decoded audio without needing a native IAB decoder.
                _resolve_iab_tmpdir = tempfile.TemporaryDirectory(prefix="pfx_resolve_iab_")
                _resolve_tmp = Path(_resolve_iab_tmpdir.name)
                _resolve_decoded_segs: list[dict] = []
                try:
                    from .engines.resolve_engine import _get_resolve_app, _RESOLVE_JOB_SEM, _setup_resolve_env
                    _setup_resolve_env()
                    _resolve_app = _get_resolve_app(timeout=8.0)
                    if _resolve_app is not None:
                        for _rseg in _iab_segs:
                            _rsrc = Path(_rseg["path"])
                            _rwav = _resolve_tmp / f"{_rsrc.stem}_resolve_decoded.wav"
                            # Use Resolve's ProjectManager to export IAB → WAV
                            # Simple scripting path: import media, export audio only
                            try:
                                _rpm = _resolve_app.GetProjectManager()
                                _rproj = _rpm.CreateProject(f"pfx_iab_decode_{_rwav.stem[:20]}")
                                if _rproj:
                                    _rpool = _rproj.GetMediaPool()
                                    if _rpool:
                                        _rclips = _rpool.ImportMedia([str(_rsrc)])
                                        if _rclips:
                                            _rtl = _rpool.CreateTimelineFromClips(
                                                f"tl_{_rwav.stem[:16]}", _rclips)
                                            if _rtl:
                                                _rproj.SetCurrentTimeline(_rtl)
                                                # Export audio using Deliver page.
                                                # Resolve's scripting API does not expose
                                                # GetCurrentRenderJob on all builds.
                                                _rproj.SetRenderSettings({
                                                    "SelectAllFrames": True,
                                                    "TargetDir": str(_resolve_tmp),
                                                    "CustomName": _rwav.stem,
                                                    "ExportVideo": False,
                                                    "ExportAudio": True,
                                                    "AudioCodec": "LinearPCM",
                                                    "AudioBitDepth": "24",
                                                    "AudioSampleRate": "48000",
                                                })
                                                _rproj.AddRenderJob()
                                                _rproj.StartRendering()
                                                # Wait up to 120s for audio-only render
                                                _rdl = time.monotonic() + 120
                                                while time.monotonic() < _rdl:
                                                    if not _rproj.IsRenderingInProgress():
                                                        break
                                                    time.sleep(1.0)
                                                _rproj.StopRendering()
                                            _rpm.DeleteProject(_rproj)
                            except Exception as _rex:
                                try:
                                    with open(log_path, 'a', encoding='utf-8', errors='replace') as _lf:
                                        _lf.write(f'[companion] Resolve IAB decode error: {_rex}\n')
                                except Exception:
                                    pass

                            # Check if render produced a WAV (may have .wav suffix)
                            _candidates = list(_resolve_tmp.glob(f"{_rwav.stem}*.wav")) + \
                                          list(_resolve_tmp.glob(f"{_rwav.stem}*.WAV"))
                            if _candidates:
                                _resolve_decoded_segs.append({
                                    "path": str(_candidates[0]),
                                    "inpoint": _rseg["inpoint"],
                                    "duration": _rseg["duration"],
                                })
                except Exception as _re:
                    try:
                        with open(log_path, 'a', encoding='utf-8', errors='replace') as _lf:
                            _lf.write(f'[companion] Resolve-assisted IAB decode failed: {_re}\n')
                    except Exception:
                        pass

                if _resolve_decoded_segs:
                    audio_segs = _resolve_decoded_segs
                    na = len(audio_segs)
                    _iab_adapter_decoded = True  # treat as "adapter decoded" for mode detection
                else:
                    # Resolve decode failed — fall through to last-resort ffmpeg direct
                    try: _resolve_iab_tmpdir.cleanup()
                    except Exception: pass
                    audio_segs = _iab_segs
                    na = len(audio_segs)
            elif _iab_segs:
                # Last resort — try direct ffmpeg even without a known IAB decoder.
                # Some MXFs contain PCM beds alongside the IAB bitstream; ffmpeg
                # extracts those.  If it can't decode the IAB stream, _run_ffmpeg
                # returns False and the video-only fallback runs.
                audio_segs = _iab_segs
                na = len(audio_segs)

        # Channel-aware audio encoding args
        first_pcm = next((t for t in pcm_tracks if not t.get('isIAB')), None)
        cc = int((first_pcm or {}).get('channelCount') or 0) or 2
        if cc not in (2, 6):
            cc = 2
        a_bitrate = '448k' if cc >= 6 else '192k'

        # Write a diagnostic header to the log so the exact command is visible
        def _log_cmd(cmd: list[str]) -> None:
            try:
                with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                    lf.write(f'\n[companion] v_segs={n} a_segs={na} cc={cc}\n')
                    lf.write(f'[companion] cmd: {" ".join(cmd)}\n\n')
            except Exception:
                pass

        def _run_ffmpeg(cmd: list[str], mode: str, msg: str) -> bool:
            """Shared run-monitor-check logic for both direct and concat paths."""
            _cleanup_output()
            _log_cmd(cmd)
            log_fp = open(log_path, 'a', encoding='utf-8', errors='replace')
            try:
                process = subprocess.Popen(cmd, stderr=log_fp, stdout=subprocess.DEVNULL, start_new_session=True)
                update_session(session_id, proc=process, path=str(cache_path),
                               audioMode=mode, audioMessage=msg,
                               proxyName=proxy_name, startTimecode=start_timecode)
                _write_proxy_sidecar(cache_path, pid=process.pid,
                                     partPath=str(out_path), progressPath=str(progress_path),
                                     logPath=str(log_path), audioMode=mode, audioMessage=msg,
                                     proxyName=proxy_name, startTimecode=start_timecode)
                rc = _monitor_process(process)
            finally:
                try:
                    log_fp.close()
                except Exception:
                    pass
            if rc == 0 and out_path.is_file() and out_path.stat().st_size > 0:
                actual_duration = _probe_duration_seconds(out_path, ffprobe_path)
                if expected_duration > 10 and actual_duration is not None:
                    if actual_duration < max(expected_duration * 0.90, expected_duration - 3.0):
                        _cleanup_output()
                        return False
                update_session(session_id, audioMode=mode, audioMessage=msg)
                _write_proxy_sidecar(cache_path, audioMode=mode, audioMessage=msg)
                return True
            return False

        def _try_resolve_iab_proxy() -> bool:
            """Render IMF proxy via Resolve Engine.

            Resolve is used for:
              • ANY content when Resolve is connected (_resolve_is_available=True) — "Resolve first"
              • DV content — correct L8 SDR trim and PQ color science
              • IAB/Atmos content — native immersive audio decode
              • force_resolve=True — explicit user request
            ffmpeg is the fallback when Resolve is unavailable or fails.
            """
            if not has_iab_audio and not is_dolby_vision and not force_resolve and not _resolve_is_available:
                return False
            try:
                from .engines.resolve_engine import _get_resolve_app, start_resolve_engine
                resolve_app = _get_resolve_app(timeout=2.0)
                if resolve_app is None:
                    update_session(session_id, stage='resolve_start', pct=1, message='Starting Resolve Engine for IAB audio…')
                    started = start_resolve_engine(launch_policy='auto', run_mode='headless', timeout_seconds=120)
                    try:
                        with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                            lf.write(
                                '\n[companion] resolve_engine_start '
                                f"connected={bool(started.get('connected'))} "
                                f"running={bool(started.get('running'))} "
                                f"code={started.get('code') or ''} "
                                f"message={started.get('message') or started.get('userMessage') or ''}\n"
                            )
                    except Exception:
                        pass
                    resolve_app = _get_resolve_app(timeout=8.0)
            except Exception as exc:
                try:
                    with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                        lf.write(f'\n[companion] resolve_engine_start_error={exc}\n')
                except Exception:
                    pass
                resolve_app = None
            if resolve_app is None:
                try:
                    with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                        lf.write('\n[companion] resolve_engine_skip=no_resolve_api\n')
                except Exception:
                    pass
                return False

            render_dir = cache_path.parent / f".resolve_proxy_{session_id}"
            render_dir.mkdir(parents=True, exist_ok=True)
            project_name = f"PFX_IMF_PROXY_{session_id}"
            render_name = "resolve_proxy"
            pm = None
            project = None
            try:
                update_session(session_id, stage='resolve', pct=1, message='Resolve Engine: creating proxy timeline…')
                pm = resolve_app.GetProjectManager()
                if not pm:
                    try:
                        with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                            lf.write('\n[companion] resolve_engine_skip=no_project_manager\n')
                    except Exception:
                        pass
                    return False
                try:
                    existing = pm.LoadProject(project_name)
                    if existing:
                        pm.DeleteProject(project_name)
                except Exception:
                    pass
                project = pm.CreateProject(project_name)
                if not project:
                    try:
                        with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                            lf.write('\n[companion] resolve_engine_skip=create_project_failed\n')
                    except Exception:
                        pass
                    return False
                media_pool = project.GetMediaPool()
                if not media_pool:
                    return False
                clips = media_pool.ImportMedia([str(folder)]) or []
                if not clips:
                    try:
                        with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                            lf.write(f'\n[companion] resolve_engine_skip=import_failed folder={folder}\n')
                    except Exception:
                        pass
                    return False

                def _clip_type(clip) -> str:
                    try:
                        return str(clip.GetClipProperty('Type') or '').lower()
                    except Exception:
                        return ''

                video_clip = next((clip for clip in clips if 'video' in _clip_type(clip)), None)
                audio_clip = next((clip for clip in clips if 'audio' in _clip_type(clip)), None)

                # ── Dolby Vision full proxy path ──────────────────────────────────
                # For DV mastered content Resolve must own the video render so it can
                # apply its DV→SDR color science and L8 trim pass.  We create a full
                # video+audio timeline, engage DaVinci Color Managed mode, set the
                # output to SDR Rec.709, and let Resolve produce the proxy MP4 directly
                # (no ffmpeg mux step — that would strip the colour transform).
                if is_dolby_vision:
                    if not video_clip:
                        try:
                            with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                                lf.write('\n[companion] resolve_dv_skip=no_video_clip\n')
                        except Exception:
                            pass
                        return False
                    update_session(session_id, stage='resolve_dv', pct=5,
                                   message='Resolve Engine: configuring Dolby Vision color science…')
                    try:
                        project.SetSetting("colorScienceMode", "davinciYRGBColorManagedv2")
                    except Exception:
                        pass
                    dv_clips = [video_clip] + ([audio_clip] if audio_clip else [])
                    dv_timeline = media_pool.CreateTimelineFromClips(
                        f"PFX_IMF_DV_PROXY_{session_id}", dv_clips)
                    if not dv_timeline:
                        try:
                            with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                                lf.write('\n[companion] resolve_dv_skip=create_timeline_failed\n')
                        except Exception:
                            pass
                        return False
                    project.SetCurrentTimeline(dv_timeline)
                    # Tell Resolve to output SDR Rec.709 — it applies the L8 trim pass
                    for _cs_key, _cs_val in [
                        ("colorSpaceTimeline", "Rec. 2020 ST2084 (PQ)"),
                        ("colorSpaceOutput",   "Rec. 709-A"),
                    ]:
                        try:
                            dv_timeline.SetSetting(_cs_key, _cs_val)
                        except Exception:
                            pass
                    # Set render format: H.264 MP4
                    _fmt_set = False
                    try:
                        _fmt_set = bool(project.SetCurrentRenderFormatAndCodec("mp4", "H264"))
                    except Exception:
                        pass
                    if not _fmt_set:
                        for _preset in ("H.264 Master", "H.264", "YouTube 1080p"):
                            try:
                                if project.LoadRenderPreset(_preset):
                                    break
                            except Exception:
                                pass
                    project.SetRenderSettings({
                        'TargetDir':            str(render_dir),
                        'CustomName':           render_name,
                        'UniqueFilenameStyle':  0,
                        'ExportVideo':          True,
                        'ExportAudio':          bool(audio_clip),
                        'FormatWidth':          proxy_max_w,
                        'FormatHeight':         proxy_max_h,
                    })
                    dv_job_id = project.AddRenderJob()
                    if not dv_job_id:
                        try:
                            with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                                lf.write('\n[companion] resolve_dv_skip=add_render_job_failed\n')
                        except Exception:
                            pass
                        return False
                    if not project.StartRendering(dv_job_id):
                        try:
                            with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                                lf.write('\n[companion] resolve_dv_skip=start_rendering_failed\n')
                        except Exception:
                            pass
                        return False
                    _dv_start = time.time()
                    _dv_timeout = max(900.0, float(cpl_data.get('durationSec') or 0.0) * 4.0)
                    _dv_last_pct = 0
                    while True:
                        _dv_status = project.GetRenderJobStatus(dv_job_id) or {}
                        _dv_job_status = str(_dv_status.get('JobStatus') or '')
                        try:
                            _dv_pct = int(float(_dv_status.get('CompletionPercentage') or 0))
                        except Exception:
                            _dv_pct = 0
                        _dv_last_pct = max(_dv_last_pct, _dv_pct)
                        update_session(
                            session_id,
                            stage='resolve_dv_render',
                            pct=min(99, max(5, int(5 + _dv_last_pct * 0.90))),
                            message=f'Resolve Engine rendering Dolby Vision proxy… {_dv_last_pct}%',
                        )
                        if _dv_job_status == 'Complete':
                            break
                        if _dv_job_status in ('Failed', 'Cancelled'):
                            try:
                                with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                                    lf.write(f'\n[companion] resolve_dv_render_failed status={_dv_status}\n')
                            except Exception:
                                pass
                            return False
                        if time.time() - _dv_start > _dv_timeout:
                            try:
                                project.StopRendering()
                            except Exception:
                                pass
                            return False
                        time.sleep(0.5)
                    _dv_outputs = sorted(
                        [p for p in render_dir.iterdir()
                         if p.suffix.lower() == '.mp4' and p.stat().st_size > 0],
                        key=lambda p: p.stat().st_mtime,
                        reverse=True,
                    )
                    if not _dv_outputs:
                        try:
                            with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                                lf.write('\n[companion] resolve_dv_failed=no_mp4_output\n')
                        except Exception:
                            pass
                        return False
                    _fast_move(_dv_outputs[0], out_path)
                    _dv_profile = str(cpl_data.get('dvProfile') or '')
                    _dv_label = f" Profile {_dv_profile}" if _dv_profile else ""
                    _dv_mode = 'resolve_dv'
                    _dv_msg = (
                        f'Proxy rendered by Resolve Engine with Dolby Vision{_dv_label} '
                        f'color science — SDR trim pass applied.'
                    )
                    update_session(session_id, audioMode=_dv_mode, audioMessage=_dv_msg)
                    try:
                        with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                            lf.write(
                                f'\n[companion] resolve_dv=1 project={project_name} '
                                f'source={_dv_outputs[0]} output={out_path}\n'
                            )
                    except Exception:
                        pass
                    return True

                # ── General Resolve proxy (force_resolve=True, non-DV, non-IAB) ──────────
                if force_resolve and not is_dolby_vision and not has_iab_audio:
                    all_clips = [c for c in [video_clip, audio_clip] if c is not None]
                    if not all_clips:
                        return False
                    update_session(session_id, stage='resolve_proxy', pct=10,
                                   message='Resolve Engine: creating video+audio proxy timeline…')
                    generic_tl = media_pool.CreateTimelineFromClips(
                        f'PFX_IMF_GENERIC_PROXY_{session_id}', all_clips)
                    if not generic_tl:
                        return False
                    project.SetCurrentTimeline(generic_tl)
                    _fmt_set = False
                    try:
                        _fmt_set = bool(project.SetCurrentRenderFormatAndCodec('mp4', 'H264'))
                    except Exception:
                        pass
                    if not _fmt_set:
                        for _p in ('H.264 Master', 'H.264', 'YouTube 1080p'):
                            try:
                                if project.LoadRenderPreset(_p):
                                    break
                            except Exception:
                                pass
                    project.SetRenderSettings({
                        'TargetDir':           str(render_dir),
                        'CustomName':          render_name,
                        'UniqueFilenameStyle': 0,
                        'ExportVideo':         True,
                        'ExportAudio':         bool(audio_clip),
                        'FormatWidth':         proxy_max_w,
                        'FormatHeight':        proxy_max_h,
                    })
                    _gen_job_id = project.AddRenderJob()
                    if not _gen_job_id:
                        return False
                    if not project.StartRendering(_gen_job_id):
                        return False
                    _gen_start = time.time()
                    _gen_timeout = max(900.0, float(cpl_data.get('durationSec') or 0.0) * 4.0)
                    _gen_last_pct = 0
                    while True:
                        _gen_status = project.GetRenderJobStatus(_gen_job_id) or {}
                        _gen_job_status = str(_gen_status.get('JobStatus') or '')
                        try:
                            _gen_pct = int(float(_gen_status.get('CompletionPercentage') or 0))
                        except Exception:
                            _gen_pct = 0
                        _gen_last_pct = max(_gen_last_pct, _gen_pct)
                        update_session(
                            session_id,
                            stage='resolve_render',
                            pct=min(99, max(10, int(10 + _gen_last_pct * 0.88))),
                            message=f'Resolve Engine rendering proxy… {_gen_last_pct}%',
                        )
                        if _gen_job_status == 'Complete':
                            break
                        if _gen_job_status in ('Failed', 'Cancelled'):
                            return False
                        if time.time() - _gen_start > _gen_timeout:
                            try:
                                project.StopRendering()
                            except Exception:
                                pass
                            return False
                        time.sleep(0.5)
                    _gen_outputs = sorted(
                        [p for p in render_dir.iterdir()
                         if p.suffix.lower() == '.mp4' and p.stat().st_size > 0],
                        key=lambda p: p.stat().st_mtime, reverse=True,
                    )
                    if not _gen_outputs:
                        return False
                    _fast_move(_gen_outputs[0], out_path)
                    _mode = 'resolve_proxy'
                    _msg = 'Proxy rendered by Resolve Engine — video + audio downmix included.'
                    if audio_clip:
                        _msg = 'Proxy rendered by Resolve Engine — IAB/Atmos decoded to stereo by Resolve.'
                    update_session(session_id, audioMode=_mode, audioMessage=_msg)
                    return True

                # ── IAB audio-only path (non-DV): both clips required ─────────────
                if not video_clip or not audio_clip:
                    try:
                        with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                            lf.write(f'\n[companion] resolve_engine_skip=missing_clips video={bool(video_clip)} audio={bool(audio_clip)}\n')
                    except Exception:
                        pass
                    return False
                # Resolve exports IAB/Atmos reliably when it owns the audio-only timeline.
                # Forcing recordFrame on an empty timeline can produce a one-frame WAV.
                timeline = media_pool.CreateTimelineFromClips(f"PFX_IMF_PROXY_AUDIO_{session_id}", [audio_clip])
                if not timeline:
                    try:
                        with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                            lf.write('\n[companion] resolve_engine_skip=create_audio_timeline_failed\n')
                    except Exception:
                        pass
                    return False
                project.SetCurrentTimeline(timeline)

                try:
                    project.LoadRenderPreset('Audio Only')
                except Exception:
                    pass
                project.SetRenderSettings({
                    'TargetDir': str(render_dir),
                    'CustomName': render_name,
                    'UniqueFilenameStyle': 0,
                    'ExportVideo': False,
                    'ExportAudio': True,
                })
                render_job_id = project.AddRenderJob()
                if not render_job_id:
                    return False
                if not project.StartRendering(render_job_id):
                    return False

                start_ts = time.time()
                timeout_s = max(900.0, float(expected_duration or 0.0) * 4.0)
                last_pct = 0
                while True:
                    status = project.GetRenderJobStatus(render_job_id) or {}
                    job_status = str(status.get('JobStatus') or '')
                    try:
                        render_pct = int(float(status.get('CompletionPercentage') or 0))
                    except Exception:
                        render_pct = 0
                    last_pct = max(last_pct, render_pct)
                    update_session(
                        session_id,
                        stage='resolve_render',
                        pct=min(99, max(5, int(5 + last_pct * 0.90))),
                        message=f'Resolve Engine rendering IAB audio… {last_pct}%',
                    )
                    if job_status == 'Complete':
                        break
                    if job_status in ('Failed', 'Cancelled'):
                        try:
                            with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                                lf.write(f'\n[companion] resolve_engine_audio_failed status={status}\n')
                        except Exception:
                            pass
                        return False
                    if time.time() - start_ts > timeout_s:
                        try:
                            project.StopRendering()
                        except Exception:
                            pass
                        return False
                    time.sleep(0.5)

                outputs = sorted(
                    [p for p in render_dir.iterdir() if p.suffix.lower() in ('.wav', '.aif', '.aiff')],
                    key=lambda p: p.stat().st_mtime,
                    reverse=True,
                )
                outputs = [p for p in outputs if p.stat().st_size > 0]
                if not outputs:
                    try:
                        with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                            lf.write('\n[companion] resolve_engine_audio_failed=no_audio_output\n')
                    except Exception:
                        pass
                    return False
                wav_path = outputs[0]
                wav_duration = _probe_duration_seconds(wav_path, ffprobe_path)
                if expected_duration > 10 and (wav_duration is None or wav_duration < max(expected_duration * 0.90, expected_duration - 3.0)):
                    try:
                        with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                            lf.write(f'\n[companion] resolve_engine_audio_failed=short_wav duration={wav_duration} expected={expected_duration} audio={wav_path}\n')
                    except Exception:
                        pass
                    return False
                mode = 'resolve_iab'
                msg = 'Proxy audio rendered by Resolve Engine from IAB / Dolby Atmos and downmixed to stereo.'
                wav_channels = _probe_audio_channel_count(wav_path)
                for codec_args in codec_profiles:
                    _scale = ""
                    _cargs: list[str] = []
                    _skip = False
                    for _ci, _ca in enumerate(codec_args):
                        if _skip:
                            _skip = False
                            continue
                        if _ca == '-vf' and _ci + 1 < len(codec_args):
                            _scale = codec_args[_ci + 1]
                            _skip = True
                        else:
                            _cargs.append(_ca)
                    _post = f"{_scale},{rec709_frame_filter}" if _scale else rec709_frame_filter
                    if n == 1:
                        _fg = f"[0:v:0]{_post}[vout]"
                    else:
                        _v_labels = ''.join(f'[{i}:v:0]' for i in range(n))
                        _fg = f"{_v_labels}concat=n={n}:v=1:a=0[concatv];[concatv]{_post}[vout]"
                    _audio_fg = _dialogue_safe_stereo_filter(f'[{n}:a:0]', '[aout]', wav_channels)
                    _fg = f"{_fg};{_audio_fg}"
                    cmd = [ffmpeg_path, '-y', '-fflags', '+genpts',
                           *_build_input_args(segment_inputs, video=True),
                           '-i', str(wav_path),
                           '-filter_complex', _fg,
                           '-map', '[vout]', *_cargs,
                           '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000',
                           '-progress', str(progress_path), '-nostats',
                           *container_meta_args, *output_format_args, str(out_path)]
                    if _run_ffmpeg(cmd, mode, msg):
                        try:
                            with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                                lf.write(f'\n[companion] resolve_engine=1 project={project_name} audio={wav_path} output={out_path}\n')
                        except Exception:
                            pass
                        return True
                try:
                    with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                        lf.write(f'\n[companion] resolve_engine_mux_failed=1 audio={wav_path}\n')
                except Exception:
                    pass
                return False
            except Exception as exc:
                try:
                    with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                        lf.write(f'\n[companion] resolve_engine_failed={exc}\n')
                except Exception:
                    pass
                return False
            finally:
                try:
                    if pm and project:
                        pm.CloseProject(project)
                except Exception:
                    pass

        # ── Resolve first, ffmpeg fallback ─────────────────────────────────────────
        # Try Resolve whenever it is connected (any content type) or explicitly forced.
        # On success: done — Resolve produced a high-quality proxy with correct DV color.
        # On failure:
        #   • force_resolve=True  → surface error to UI, do NOT fall through to ffmpeg.
        #   • Resolve just available → silently fall through to ffmpeg (graceful degradation).
        if _resolve_is_available or force_resolve:
            if _try_resolve_iab_proxy():
                return True
            try:
                with open(log_path, 'a', encoding='utf-8', errors='replace') as lf:
                    _why = 'force_resolve=True' if force_resolve else 'resolve_available_but_failed'
                    lf.write(f'\n[companion] resolve_attempt_done={_why}\n')
            except Exception:
                pass
            if force_resolve:
                # Explicit Resolve request failed — tell the user rather than silently downgrading.
                _resolve_fail_msg = (
                    'Resolve Engine could not render this proxy. '
                    'Ensure DaVinci Resolve Studio is running with scripting enabled, '
                    'or remove the "Resolve Proxy" request to fall back to ffmpeg.'
                )
                update_session(session_id, stage='resolve_failed', pct=0,
                               message=_resolve_fail_msg,
                               audioMode='video_only', audioMessage=_resolve_fail_msg)
                return True  # consumed — caller should stop
            # _resolve_is_available but not force_resolve → fall through to ffmpeg silently

        # ── n=1 path ──────────────────────────────────────────────────────────────
        if n == 1:
            v_args = _build_input_args(segment_inputs, video=True)
            if na >= 1:
                a_args = _build_input_args([audio_segs[0]])
                mode, msg = _audio_mode_from_tracks(pcm_tracks, has_iab_audio, bool(immersive.get('iabDecode')) or _iab_adapter_decoded)

                # Build a filter_complex that handles both video scale/format AND audio
                # normalisation in one graph.  Using filter_complex avoids the stream-
                # routing ambiguity that arises when -vf (simple graph) is combined
                # with multiple explicit -map statements in multi-input commands.
                # For IAB audio we also add aformat to normalise the decoded channel
                # layout (IAB decoders may output 9.1.6, 7.1.4, etc.) to stereo before
                # AAC encoding.
                _a_filter = (
                    f"[1:a:0]aformat=sample_rates=48000:channel_layouts=stereo[aout]"
                    if (has_iab_audio and not _iab_adapter_decoded)
                    else f"[1:a:0]anull[aout]"
                )

                for codec_args in codec_profiles:
                    # codec_args may contain a -vf; extract the scale part and fold it
                    # into filter_complex so we have one consistent graph per attempt.
                    _scale_part = ""
                    _codec_no_vf: list[str] = []
                    _skip_next = False
                    for _ci, _ca in enumerate(codec_args):
                        if _skip_next:
                            _skip_next = False
                            continue
                        if _ca == '-vf' and _ci + 1 < len(codec_args):
                            _scale_part = codec_args[_ci + 1]
                            _skip_next = True
                        else:
                            _codec_no_vf.append(_ca)
                    # Build video filter chain: scale (if present) then format conversion
                    _v_filter = (
                        f"[0:v:0]{_scale_part},{rec709_frame_filter}[vout]"
                        if _scale_part else
                        f"[0:v:0]{rec709_frame_filter}[vout]"
                    )
                    _fc = f"{_v_filter};{_a_filter}"
                    cmd = [ffmpeg_path, '-y', '-fflags', '+genpts',
                           *v_args, *a_args,
                           '-filter_complex', _fc,
                           '-map', '[vout]', *_codec_no_vf,
                           '-map', '[aout]',
                           '-c:a', 'aac', '-b:a', a_bitrate, '-ac', str(cc),
                           '-progress', str(progress_path), '-nostats',
                           *container_meta_args, *output_format_args, str(out_path)]
                    if _run_ffmpeg(cmd, mode, msg):
                        return True

            # video-only fallback for n=1
            _iab_engine = immersive.get("engineId") or ""
            if has_iab_audio:
                if _iab_engine == "resolve-engine":
                    vo_msg = (
                        'Proxy is video-only — IAB/Dolby Atmos audio could not be decoded. '
                        'Start the Resolve Engine in Settings and try again for audio.'
                    )
                elif immersive.get("iabDecode"):
                    vo_msg = (
                        'Proxy is video-only — IAB audio decode failed (ffmpeg could not decode '
                        'this IAB stream). Try upgrading ffmpeg: brew upgrade ffmpeg'
                    )
                else:
                    vo_msg = (
                        'Proxy is video-only — no IAB/Dolby Atmos decoder available. '
                        'Install the PostFlowX IAB adapter or upgrade ffmpeg for audio.'
                    )
            else:
                vo_msg = 'Proxy is video-only in the current build.'
            for codec_args in codec_profiles:
                _scale_part_vo = ""
                _codec_no_vf_vo: list[str] = []
                _skip_vo = False
                for _ci, _ca in enumerate(codec_args):
                    if _skip_vo:
                        _skip_vo = False
                        continue
                    if _ca == '-vf' and _ci + 1 < len(codec_args):
                        _scale_part_vo = codec_args[_ci + 1]
                        _skip_vo = True
                    else:
                        _codec_no_vf_vo.append(_ca)
                _fc_vo = (
                    f"[0:v:0]{_scale_part_vo},{rec709_frame_filter}[vout]"
                    if _scale_part_vo else
                    f"[0:v:0]{rec709_frame_filter}[vout]"
                )
                cmd = [ffmpeg_path, '-y', '-fflags', '+genpts',
                       *_build_input_args(segment_inputs, video=True),
                       '-filter_complex', _fc_vo,
                       '-map', '[vout]', *_codec_no_vf_vo, '-an',
                       '-progress', str(progress_path), '-nostats',
                       *container_meta_args, *output_format_args, str(out_path)]
                if _run_ffmpeg(cmd, 'video_only', vo_msg):
                    return True
            return False

        # ── n>1 path: concat filter ────────────────────────────────────────────
        v_labels = ''.join(f'[{i}:v:0]' for i in range(n))
        video_input_args = _build_input_args(segment_inputs, video=True)

        def _run_concat(concat_video_graph: str, all_inputs: list[str], audio_map_args: list[str], with_audio: bool) -> bool:
            """
            concat_video_graph produces [vout] from the video streams only.
            We fold the per-profile scale+format filter into the graph so we never
            mix -filter_complex and -vf in the same command (that is invalid when
            -map '[vout]' is already taken by filter_complex output).
            """
            if with_audio:
                mode, msg = _audio_mode_from_tracks(pcm_tracks, has_iab_audio, bool(immersive.get('iabDecode')) or _iab_adapter_decoded)
            else:
                mode, msg = 'video_only', 'Proxy is video-only in the current build.'
            for codec_args in codec_profiles:
                # Extract -vf (scale) from codec_args; fold into filter graph
                _scale = ""
                _cargs: list[str] = []
                _skip = False
                for _ci, _ca in enumerate(codec_args):
                    if _skip:
                        _skip = False
                        continue
                    if _ca == '-vf' and _ci + 1 < len(codec_args):
                        _scale = codec_args[_ci + 1]
                        _skip = True
                    else:
                        _cargs.append(_ca)
                # Replace the concat graph's [vout] with an extended chain that
                # includes scale (if any) and always force format=yuv420p.
                _post = f"{_scale},{rec709_frame_filter}" if _scale else rec709_frame_filter
                _fg = concat_video_graph.replace("[vout]", f"[concatv];[concatv]{_post}[vout]", 1)
                cmd = [
                    ffmpeg_path, '-y', '-fflags', '+genpts',
                    *all_inputs,
                    '-filter_complex', _fg,
                    '-map', '[vout]', *_cargs,
                    *audio_map_args,
                    '-progress', str(progress_path), '-nostats',
                    *container_meta_args, *output_format_args, str(out_path),
                ]
                if _run_ffmpeg(cmd, mode, msg):
                    return True
            return False

        # Attempt 1 — one audio input per video segment (typical IMF multi-reel)
        if na == n:
            a_labels = ''.join(f'[{n + i}:a:0]' for i in range(n))
            fg = f'{v_labels}concat=n={n}:v=1:a=0[vout];{a_labels}concat=n={n}:v=0:a=1[aout]'
            audio_map_args = ['-map', '[aout]', '-c:a', 'aac', '-b:a', a_bitrate, '-ac', str(cc)]
            if _run_concat(fg, video_input_args + _build_input_args(audio_segs), audio_map_args, True):
                return True

        # Attempt 2 — single audio file spanning all video segments
        elif na == 1:
            fg = f'{v_labels}concat=n={n}:v=1:a=0[vout]'
            audio_map_args = ['-map', f'{n}:a:0', '-c:a', 'aac', '-b:a', a_bitrate, '-ac', str(cc)]
            if _run_concat(fg, video_input_args + _build_input_args(audio_segs), audio_map_args, True):
                return True

        # Fallback — video-only concat
        fg = f'{v_labels}concat=n={n}:v=1:a=0[vout]'
        return _run_concat(fg, video_input_args, ['-an'], False)

    def _parallel_decode_and_concat(seg_inputs: list[dict], audio_segments: list[dict], exp_dur: float = 0.0) -> bool:
        """Decode all video reels in parallel (one ffmpeg per reel) then mux with -c copy.

        On a 14-core workstation with 5 reels:
          • Sequential (old): wall-clock ≈ sum of all reel decode times
          • Parallel (this):  wall-clock ≈ slowest single reel decode

        Phases:
          1. N parallel ffmpeg processes each decode one reel → temp MP4 (libx264 ultrafast)
          2. Single ffmpeg concat demuxer merges all temp MP4s with -c:v copy (no re-encode)
             + mux audio if available
        All cores split evenly across decoders so J2K wavelet decode is fully parallelised.
        """
        import concurrent.futures as _cf
        import tempfile as _tf

        n_segs = len(seg_inputs)
        if n_segs < 2:
            return False  # single reel — sequential path is fine

        threads_per_dec = max(2, _cpu_count // n_segs)
        tmp_dir = Path(_tf.mkdtemp(prefix='pfx_pdec_'))
        update_session(session_id, stage='parallel_decode', pct=3,
                       message=f'Parallel decode: 0 / {n_segs} reels…')

        # Build the per-segment ffmpeg command (decode + scale + rec709 filter, NO audio, NO re-encode)
        def _make_seg_cmd(idx: int, seg: dict, tmp_path: Path) -> list[str]:
            inpoint  = float(seg.get('inpoint') or 0.0)
            duration = float(seg.get('duration') or 0.0)
            in_args: list[str] = []
            if inpoint > 0:
                in_args += ['-ss', f'{inpoint:.6f}']
            if duration > 0:
                in_args += ['-t', f'{duration:.6f}']
            in_args += decoder_fast_args + ['-i', str(seg['path'])]
            # Scale + colour filter → same as proxy quality but output is libx264 ultrafast CRF-18
            # (visually lossless at 854×480; concat with -c:v copy in phase 2 avoids double-encode)
            _fc = f"[0:v:0]{browser_scale_args[-1]},{rec709_frame_filter}[vout]"
            return [
                ffmpeg_path, '-y',
                '-probesize', '5M', '-analyzeduration', '2M',
                '-fflags', '+genpts+discardcorrupt',
                *in_args,
                '-filter_complex', _fc,
                '-map', '[vout]',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
                '-threads', str(threads_per_dec),
                '-an',
                '-f', 'mp4', str(tmp_path),
            ]

        def _decode_seg(idx: int, seg: dict) -> tuple[int, Path | None]:
            tmp_path = tmp_dir / f'seg_{idx:04d}.mp4'
            cmd = _make_seg_cmd(idx, seg, tmp_path)
            try:
                r = subprocess.run(cmd, capture_output=True,
                                   timeout=max(600.0, exp_dur * 4))
                if r.returncode == 0 and tmp_path.is_file() and tmp_path.stat().st_size > 0:
                    return idx, tmp_path
            except Exception:
                pass
            return idx, None

        # Phase 1 — parallel decode
        seg_paths: list[Path | None] = [None] * n_segs
        n_done = 0
        with _cf.ThreadPoolExecutor(max_workers=n_segs) as pool:
            fmap = {pool.submit(_decode_seg, i, s): i for i, s in enumerate(seg_inputs)}
            for fut in _cf.as_completed(fmap):
                idx, result = fut.result()
                seg_paths[idx] = result
                n_done += 1
                pct = min(70, 3 + int(n_done / n_segs * 67))
                ok_str = '✓' if result else '✗'
                update_session(session_id, stage='parallel_decode', pct=pct,
                               message=f'Parallel decode: {n_done}/{n_segs} reels {ok_str}…')

        if any(p is None for p in seg_paths):
            # One or more segment decodes failed — fall back to sequential
            shutil.rmtree(str(tmp_dir), ignore_errors=True)
            return False

        # Phase 2 — concat without re-encode
        update_session(session_id, stage='parallel_mux', pct=75, message='Muxing proxy…')
        concat_txt = tmp_dir / 'concat.txt'
        with open(concat_txt, 'w', encoding='utf-8') as _cf_:
            for sp in seg_paths:
                _cf_.write(f"file '{sp}'\n")

        # Audio: use the first audio segment if available
        _a_inputs: list[str] = []
        _a_map:    list[str] = ['-an']
        _a_mode  = 'video_only'
        _a_msg   = 'Parallel decode (video only).'
        if audio_segments:
            _aseg = audio_segments[0]
            _a_ip = float(_aseg.get('inpoint') or 0.0)
            _a_dur = float(_aseg.get('duration') or 0.0)
            _a_in: list[str] = []
            if _a_ip > 0: _a_in += ['-ss', f'{_a_ip:.6f}']
            if _a_dur > 0: _a_in += ['-t', f'{_a_dur:.6f}']
            _a_in += ['-i', str(_aseg['path'])]
            _a_inputs = _a_in
            _a_map    = ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000']
            _a_mode   = 'stereo_proxy'
            _a_msg    = 'Parallel decode — stereo downmix.'

        mux_cmd = [
            ffmpeg_path, '-y',
            '-f', 'concat', '-safe', '0', '-i', str(concat_txt),
            *_a_inputs,
            '-c:v', 'copy',   # ← no re-encode: instant
            *_a_map,
            '-progress', str(progress_path), '-nostats',
            *container_meta_args, *output_format_args, str(out_path),
        ]
        log_fp = None
        try:
            log_fp = open(log_path, 'a', encoding='utf-8', errors='replace')
            proc = subprocess.Popen(mux_cmd, stderr=log_fp, stdout=subprocess.DEVNULL,
                                    start_new_session=True)
            update_session(session_id, proc=proc)
            rc = _monitor_process(proc)
        except Exception:
            rc = -1
        finally:
            # Close the log handle even if Popen/_monitor_process raised, otherwise
            # repeated failures leak file descriptors → "Too many open files".
            if log_fp is not None:
                try:
                    log_fp.close()
                except Exception:
                    pass
            shutil.rmtree(str(tmp_dir), ignore_errors=True)

        if rc == 0 and out_path.is_file() and out_path.stat().st_size > 0:
            update_session(session_id, audioMode=_a_mode, audioMessage=_a_msg)
            return True
        return False

    ok = False
    expected_duration = float(cpl_data.get('durationSec') or 0.0)
    # Try CPL-based segment transcode first: resolves separate audio MXFs for IMF packages
    # (both single-segment and multi-segment CPLs are handled here)
    segments, seg_note = _build_cpl_segment_inputs(cpl_path, folder)
    if segments:
        # Multi-reel: try parallel decode first (decodes all reels simultaneously,
        # then mux with -c:v copy — wall-clock ≈ slowest single reel on this machine).
        # Falls back to sequential _try_segment_concat on any failure.
        n_segs = len(segments)
        if n_segs > 1 and not has_iab_audio and not is_dolby_vision:
            # Resolve the audio segments once for the parallel path
            try:
                _par_pcm_ids: set[str] | None = (
                    {t['trackFileId'].lower() for t in pcm_tracks
                     if not t.get('isIAB') and t.get('trackFileId')}
                    if audio_tracks_list else None
                )
                _par_audio, _ = _build_cpl_audio_inputs(cpl_path, folder, pcm_track_ids=_par_pcm_ids)
            except Exception:
                _par_audio = []
            ok = _parallel_decode_and_concat(segments, _par_audio, expected_duration)
        if not ok:
            ok = _try_segment_concat(segments, expected_duration=expected_duration)
    else:
        # Log exactly why we couldn't find video MXFs — helps diagnose VF/OV splits
        try:
            with open(log_path, 'a', encoding='utf-8', errors='replace') as _lf:
                _lf.write(f'[companion] no_video_segments: {seg_note}\n')
                _lf.write(f'[companion] folder: {folder}\n')
                _lf.write(f'[companion] cpl: {cpl_path.name}\n')
                _cpl_segs = _parse_cpl_video_segments(cpl_path)
                _lf.write(f'[companion] cpl_video_reels: {len(_cpl_segs)}\n')
                _am = _build_asset_path_map(folder)
                _lf.write(f'[companion] assetmap_entries: {len(_am)}\n')
                # List the first few missing UUIDs
                for _s in _cpl_segs[:6]:
                    _tid = str(_s.get("track_id") or "")
                    _found = _tid in _am
                    _lf.write(f'[companion] reel_id={_tid[:8]}... assetmap_hit={_found}\n')
        except Exception:
            pass
    # Fall back to single-file transcode only for muxed masters or non-CPL packages.
    # If CPL segments were found, a single main_path fallback can silently transcode
    # the wrong OV source instead of the VF/supplemental timeline.
    if not ok and not segments:
        if main_path and main_path.is_file():
            ok = _try_codecs([*decoder_fast_args, '-i', str(main_path)], allow_audio=True, expected_duration=expected_duration, label='main_resource')
    if not ok:
        _fail_pct = max(0, (get_session(session_id) or {}).get('pct', 0))
        _fail_log = _safe_read_text(log_path)
        # Determine a specific error code and message rather than the generic sentinel
        _fail_error = 'proxy_failed'
        _fail_message = 'Could not build proxy'
        if not segments and not main_path:
            # No video MXFs at all — likely a VF/supplemental without OV, or path issue
            _cpl_count = len(_parse_cpl_video_segments(cpl_path))
            if _cpl_count > 0:
                _fail_error = 'NO_VIDEO_MXF_FOUND'
                _fail_message = (
                    f'Video MXFs not found in package folder — CPL references {_cpl_count} video reel(s) '
                    f'but none were found on disk. '
                    f'If this is a VF/supplemental package, ensure the OV package folder is also accessible, '
                    f'or drag-and-drop the full package root containing both OV and VF folders.'
                )
            else:
                _fail_error = 'NO_VIDEO_IN_CPL'
                _fail_message = 'CPL contains no video resources.'
        elif not segments:
            _fail_error = 'NO_VIDEO_MXF_FOUND'
            _fail_message = seg_note or 'No playable video MXFs found in package folder.'
        else:
            # ffmpeg ran but failed — extract first meaningful error line from log
            try:
                _SKIP_PREFIXES = ('[companion]', 'ffmpeg version', 'built with', 'configuration:', 'Input #', 'Output #', 'Stream mapping', 'Press ctrl', 'Duration:', 'Stream #', '  Metadata:')
                _PREFER_KW = ('Error', 'error', 'Invalid', 'invalid', 'failed', 'Failed', 'Cannot', 'cannot', 'Conversion', 'No such', 'Unknown', 'ffmpeg exited', 'Option', 'matches no')
                _first_any = None
                _first_pref = None
                for _line in _fail_log.splitlines():
                    _l = _line.strip()
                    if not _l or any(_l.startswith(_s) for _s in _SKIP_PREFIXES) or _l.startswith('lib'):
                        continue
                    if _first_any is None:
                        _first_any = _l
                    if any(_kw in _l for _kw in _PREFER_KW):
                        _first_pref = _l
                        break
                _best = _first_pref or _first_any
                if _best:
                    _fail_error = _best[:300]
                    _fail_message = f'Could not build proxy — {_best[:200]}'
            except Exception:
                pass
        update_session(session_id, done=True, pct=_fail_pct, stage='failed', message=_fail_message, error=_fail_error, proc=None, _log=_fail_log)
        _write_proxy_sidecar(cache_path, state='failed', pct=_fail_pct, stage='failed', message=_fail_message, done=True, error=_fail_error, folderPath=str(folder), cplPath=str(cpl_path), durationMs=expected_duration_ms, partPath=str(out_path), progressPath=str(progress_path), logPath=str(log_path), proxyName=proxy_name, startTimecode=start_timecode)
        _cleanup_output()
        return

    try:
        dovi = _extract_dovi(cpl_path, folder)
    except Exception:
        dovi = {}

    log_text = _safe_read_text(log_path)
    update_session(session_id, done=True, pct=100, stage='complete', message='Proxy ready', path=str(cache_path), dovi=dovi, proxyName=proxy_name, startTimecode=start_timecode, error=None, _log=log_text, proc=None)
    # Flush the definitive audioMode/audioMessage to the sidecar *before* renaming
    # out_path → cache_path.  This ensures that by the time _proxy_cache_is_valid returns
    # True (after the rename below), the sidecar already carries the correct audioMode.
    # Without this ordering, a _watch thread in any restored session that detects the valid
    # cache between the rename and the sidecar write would read a stale intermediate audioMode,
    # causing the next load's stale-cache check to see 'unknown' and trigger a spurious rebuild.
    _final_session = get_session(session_id) or {}
    _final_sidecar = _read_proxy_sidecar(cache_path)
    _final_audio_mode = str(_final_session.get('audioMode') or _final_sidecar.get('audioMode') or 'unknown')
    _final_audio_message = str(_final_session.get('audioMessage') or _final_sidecar.get('audioMessage') or '')
    if _final_audio_mode in ('unknown', '') and has_iab_audio and not immersive.get('iabDecode'):
        _final_audio_mode = 'video_only'
        _final_audio_message = 'Proxy is video-only because no local IAB / Dolby Atmos decoder is available.'
    # iabDirectTried prevents spurious stale-cache regeneration loops for IAB packages that
    # ended up video-only despite an IAB decode attempt.  Two scenarios need it:
    #   A) No dedicated decoder — last-resort direct FFmpeg on IAB MXF was the final attempt.
    #   B) Adapter decoded OK but all FFmpeg codec profiles still failed on the decoded WAV
    #      (corrupt output, unexpected channel layout, etc.): _iab_adapter_decoded is True but
    #      the proxy is still video_only.  Without iabDirectTried the stale check would
    #      regenerate on every load → infinite loop until the adapter is fixed/replaced.
    # iabDirectTried = True means we attempted every available IAB decode path
    # and the proxy is still video-only.  Setting this prevents infinite re-try
    # loops on subsequent loads when nothing has changed.
    #
    # Scenario A: No decoder at all — last-resort direct ffmpeg on IAB MXF failed.
    # Scenario B: Adapter decoded but ffmpeg codec profiles still failed.
    # Scenario C: iabDecode=True (e.g. resolve-engine marker) but audio is still
    #             missing — could mean Resolve wasn't running.  Do NOT set flag so
    #             the user can start Resolve and regenerate successfully.
    _resolve_engine_iab = str(immersive.get("engineId") or "") == "resolve-engine"
    _iab_decode_truly_unavailable = (
        not immersive.get("iabDecode")              # no decoder at all
        or (immersive.get("iabDecodeNative") and     # native ffmpeg tried and failed
            _final_audio_mode in ("video_only", "unknown"))
    )
    _iab_direct_tried_flag = bool(
        has_iab_audio
        and not _resolve_engine_iab                # don't lock out Resolve retry
        and (
            (_iab_decode_truly_unavailable and not _iab_adapter_decoded)   # scenario A / C
            or (_iab_adapter_decoded and _final_audio_mode in ("video_only", "unknown"))  # scenario B
        )
    )
    _write_proxy_sidecar(cache_path, state='done', pct=100, stage='complete', message='Proxy ready', done=True, error=None, folderPath=str(folder), cplPath=str(cpl_path), durationMs=expected_duration_ms, partPath=str(out_path), progressPath=str(progress_path), logPath=str(log_path), proxyName=proxy_name, startTimecode=start_timecode, proxyQuality=proxy_quality, proxyMaxWidth=proxy_max_w, proxyMaxHeight=proxy_max_h, proxyJ2kLowres=j2k_lowres_level if use_j2k_lowres else '', iabDirectTried=_iab_direct_tried_flag, audioMode=_final_audio_mode, audioMessage=_final_audio_message)
    # Rename the temp output to the final cache path now that the sidecar is committed.
    try:
        out_path.replace(cache_path)
    except Exception:
        _fast_move(out_path, cache_path)

    # Register in the content-addressable registry so subsequent opens of this
    # package (even from a different folder path) find the proxy immediately.
    try:
        _cpl_fp = _cpl_content_fingerprint(cpl_data) if cpl_data else ""
        if _cpl_fp and _proxy_cache_is_valid(cache_path):
            _fps = float(cpl_data.get("editRate") or 0) if cpl_data else 0.0
            _registry_register(
                _cpl_fp, str(cache_path),
                proxy_name=proxy_name,
                audio_mode=_final_audio_mode,
                audio_message=str(_final_session.get("audioMessage") or ""),
                start_timecode=start_timecode,
                fps=_fps,
                cpl_id=str(cpl_data.get("id") or ""),
                content_title=str(cpl_data.get("contentTitle") or proxy_name),
                folder_path=str(folder),
            )
    except Exception:
        pass

def stop_session(session_id: str) -> None:
    state = remove_session(session_id)
    if not state:
        return
    proc = state.get("proc")
    if proc:
        try:
            proc.kill()
        except Exception:
            pass
    kind = str(state.get("kind") or "")
    path = state.get("path")
    # Keep completed proxy cache files on disk so refresh / reopen can restore
    # instantly. Only transient / failed outputs should be removed here.
    if path and kind != "proxy":
        try:
            Path(path).unlink()
        except Exception:
            pass
    artifact_path = state.get("artifactPath")
    if artifact_path and artifact_path != path:
        try:
            Path(artifact_path).unlink()
        except Exception:
            pass
