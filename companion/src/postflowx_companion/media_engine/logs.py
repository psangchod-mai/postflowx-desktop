from __future__ import annotations

import os
import threading
from pathlib import Path
from datetime import datetime

_lock = threading.Lock()

LOG_FILES = {
    "playback": "playback_engine.log",
    "imf":      "imf_engine.log",
    "proxy":    "proxy_engine.log",
    "resolve":  "resolve_engine.log",
}

def _log_dir() -> Path:
    base = os.environ.get("PFX_LOG_DIR") or str(
        Path.home() / "Library" / "Application Support" / "PostFlowX" / "logs"
    )
    p = Path(base)
    p.mkdir(parents=True, exist_ok=True)
    return p


def write(channel: str, sections: dict) -> None:
    filename = LOG_FILES.get(channel, f"{channel}.log")
    log_path = _log_dir() / filename
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]
    lines = [f"\n[{ts}]"]
    for section, data in sections.items():
        lines.append(f"[{section}]")
        if isinstance(data, dict):
            for k, v in data.items():
                lines.append(f"{k}={v}")
        else:
            lines.append(str(data))
    text = "\n".join(lines) + "\n"
    with _lock:
        try:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(text)
        except Exception:
            pass


def read_tail(channel: str, lines: int = 200) -> str:
    filename = LOG_FILES.get(channel, f"{channel}.log")
    log_path = _log_dir() / filename
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
        parts = text.splitlines()
        return "\n".join(parts[-lines:])
    except Exception:
        return f"(no log at {log_path})"


def read_all_logs() -> dict[str, str]:
    return {ch: read_tail(ch) for ch in LOG_FILES}
