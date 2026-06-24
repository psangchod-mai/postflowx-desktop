from __future__ import annotations

import hashlib
import json
import os
import tempfile
import threading
import time
from pathlib import Path


_REG_LOCK = threading.Lock()
_REG_VERSION = 1


# Active media-root proxy directory — set by CompanionApi.setProxyRoot().
# When set, ALL proxy and temp files go under {_active_proxy_root}/proxy/
# instead of ~/.cache/postflowx/.  Falls back to the user cache if not set
# or if the target directory is not writable.
_active_proxy_root: Path | None = None


def set_proxy_root(media_root: str | Path | None) -> Path | None:
    """Set the global proxy root to {media_root}/proxy/.
    Returns the resolved path or None if media_root is invalid.
    """
    global _active_proxy_root
    if not media_root:
        _active_proxy_root = None
        return None
    try:
        p = Path(media_root).expanduser().resolve() / "proxy"
        p.mkdir(parents=True, exist_ok=True)
        probe = p / ".pfx_write_probe"
        probe.touch(); probe.unlink()
        _active_proxy_root = p
        return p
    except Exception:
        _active_proxy_root = None
        return None


def get_proxy_root() -> Path | None:
    return _active_proxy_root


def get_frame_cache_root() -> Path:
    """Return {proxy_root}/frames/ when a media root is active, else system temp."""
    if _active_proxy_root:
        try:
            p = _active_proxy_root / "frames"
            p.mkdir(parents=True, exist_ok=True)
            return p
        except Exception:
            pass
    return Path(tempfile.gettempdir()) / "pfx_media_frames"


def _default_proxy_cache_dir() -> Path:
    """Return the active proxy root's imf/ subdir, or ~/.cache/postflowx/proxies/ fallback."""
    if _active_proxy_root:
        try:
            d = _active_proxy_root / "imf"
            d.mkdir(parents=True, exist_ok=True)
            return d
        except Exception:
            pass
    try:
        d = Path.home() / ".cache" / "postflowx" / "proxies"
        d.mkdir(parents=True, exist_ok=True)
        _probe = d / ".pfx_write_probe"
        _probe.touch()
        _probe.unlink()
        return d
    except Exception:
        return Path(tempfile.gettempdir())


def _registry_path() -> Path:
    try:
        base = Path.home() / ".cache" / "postflowx"
        base.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass
    return Path.home() / ".cache" / "postflowx" / "proxy_registry.json"


def content_fingerprint(
    cpl_id: str,
    track_file_ids: list[str],
    total_frames: int | float,
    edit_rate: float | str,
) -> str:
    """Stable, path-independent content fingerprint for a CPL.

    Keyed on CPL UUID + sorted track-file UUIDs + total frames + normalised edit rate.
    Survives package folder moves and companion restarts — identical content always
    yields the same fingerprint regardless of where the package lives on disk.
    """
    cpl_norm = (cpl_id or "").lower().strip().replace("urn:uuid:", "")

    # Normalise edit rate to a stable 6-decimal float string so that "24 1" and
    # 24.0 (float from _parse_rate) produce identical fingerprint components.
    try:
        if isinstance(edit_rate, str):
            parts = edit_rate.strip().split()
            if len(parts) == 2 and float(parts[1]):
                er_float = float(parts[0]) / float(parts[1])
            elif parts:
                er_float = float(parts[0])
            else:
                er_float = 0.0
        else:
            er_float = float(edit_rate or 0)
    except Exception:
        er_float = 0.0

    er_norm = f"{er_float:.6f}"
    frames_norm = str(int(float(total_frames or 0)))
    tf_sorted = sorted(
        str(t or "").lower().strip().replace("urn:uuid:", "")
        for t in (track_file_ids or [])
        if t
    )

    payload = "|".join([cpl_norm] + tf_sorted + [frames_norm, er_norm])
    return hashlib.sha1(payload.encode("utf-8", "replace")).hexdigest()[:20]


# ── Internal helpers (caller must hold _REG_LOCK) ─────────────────────────────

def _load_raw() -> dict:
    try:
        with open(_registry_path(), "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict) or data.get("v") != _REG_VERSION:
            return {"v": _REG_VERSION, "entries": {}}
        data.setdefault("entries", {})
        if not isinstance(data["entries"], dict):
            data["entries"] = {}
        return data
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return {"v": _REG_VERSION, "entries": {}}


def _save_raw(registry: dict) -> None:
    path = _registry_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(registry, fh, indent=2)
        tmp.replace(path)
    except Exception:
        pass


# ── Public API ─────────────────────────────────────────────────────────────────

def lookup_proxy(fingerprint: str) -> dict | None:
    """Return registry entry for *fingerprint* if the proxy file is still valid.

    Automatically removes stale entries (file deleted or empty) and returns None.
    Thread-safe.
    """
    with _REG_LOCK:
        reg = _load_raw()
        entry = reg.get("entries", {}).get(fingerprint)
        if not entry:
            return None
        proxy_path = str(entry.get("proxyPath") or "")
        try:
            valid = bool(proxy_path and os.path.isfile(proxy_path) and os.path.getsize(proxy_path) > 0)
        except OSError:
            valid = False
        if not valid:
            reg["entries"].pop(fingerprint, None)
            _save_raw(reg)
            return None
        return dict(entry)


def register_proxy(
    fingerprint: str,
    proxy_path: str,
    *,
    proxy_name: str = "",
    audio_mode: str = "",
    audio_message: str = "",
    start_timecode: str = "",
    fps: float = 0.0,
    cpl_id: str = "",
    content_title: str = "",
    folder_path: str = "",
) -> None:
    """Register or refresh a proxy entry.  No-op when *proxy_path* is not a valid file."""
    safe = str(proxy_path or "")
    try:
        if not safe or not os.path.isfile(safe) or os.path.getsize(safe) == 0:
            return
        size = os.path.getsize(safe)
    except OSError:
        return
    with _REG_LOCK:
        reg = _load_raw()
        existing = reg["entries"].get(fingerprint, {})
        reg["entries"][fingerprint] = {
            "proxyPath": safe,
            "proxyName": proxy_name,
            "audioMode": audio_mode,
            "audioMessage": audio_message,
            "startTimecode": start_timecode,
            "fps": float(fps or 0),
            "cplId": cpl_id,
            "contentTitle": content_title,
            "folderPath": folder_path,
            "createdAt": existing.get("createdAt") or int(time.time()),
            "updatedAt": int(time.time()),
            "size": size,
        }
        _save_raw(reg)


def remove_entry(fingerprint: str) -> bool:
    """Remove a single registry entry by fingerprint. Returns True if found and removed."""
    with _REG_LOCK:
        reg = _load_raw()
        if fingerprint in reg["entries"]:
            del reg["entries"][fingerprint]
            _save_raw(reg)
            return True
        return False


def prune_registry() -> int:
    """Remove entries whose proxy file no longer exists.  Returns number removed."""
    with _REG_LOCK:
        reg = _load_raw()
        stale = []
        for key, entry in list(reg["entries"].items()):
            pp = str(entry.get("proxyPath") or "")
            try:
                if not pp or not os.path.isfile(pp) or os.path.getsize(pp) == 0:
                    stale.append(key)
            except OSError:
                stale.append(key)
        for key in stale:
            del reg["entries"][key]
        if stale:
            _save_raw(reg)
        return len(stale)
