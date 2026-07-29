from __future__ import annotations

import json
import queue
import select
import struct
import sys
import threading
from typing import Any

from .api import CompanionApi


def _read_native_message() -> dict[str, Any] | None:
    raw_len = sys.stdin.buffer.read(4)
    if not raw_len:
        return None
    if len(raw_len) != 4:
        return None
    msg_len = struct.unpack("<I", raw_len)[0]
    # Chrome's native messaging protocol caps at 1 MB, but be defensive against
    # corrupt headers that encode a huge length (e.g. 0xFFFFFFFF = 4 GB), which
    # would attempt a multi-gigabyte read and crash or hang the companion process.
    if msg_len > 64 * 1024 * 1024:
        return None
    payload = sys.stdin.buffer.read(msg_len)
    if not payload or len(payload) != msg_len:
        return None
    try:
        return json.loads(payload.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def _write_native_message(message: dict[str, Any]) -> None:
    encoded = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def _normalize_request(message: dict[str, Any]) -> tuple[str | None, dict[str, Any], str]:
    """Support v1 (cmd/payload), compat (command/data), and legacy (action/flat) formats."""
    if "cmd" in message:
        action = str(message.get("cmd", "")).strip()
        payload = message.get("payload") or {}
        flat: dict[str, Any] = {"action": action}
        if isinstance(payload, dict):
            flat.update(payload)
        return message.get("id"), flat, "v1"
    if "command" in message:
        action = str(message.get("command", "")).strip()
        flat = {**message, "action": action}
        data = message.get("data")
        if isinstance(data, dict):
            flat.update(data)
        return message.get("id") or message.get("_id"), flat, "compat"
    request_id = message.get("id") or message.get("_id")
    return request_id, message, "legacy"


def _to_v1_response(request_id: Any, raw: dict[str, Any]) -> dict[str, Any]:
    resp: dict[str, Any] = {"id": request_id or "", "ok": raw.get("status") == "ok"}
    if resp["ok"]:
        # Preserve valid-but-falsy payloads (e.g. an empty list []); only substitute
        # {} when data is genuinely absent. `or {}` would wipe [], 0, False, "".
        data = raw.get("data")
        resp["result"] = data if data is not None else {}
    else:
        err = raw.get("error") or {}
        code = err.get("code", "INTERNAL_ERROR") if isinstance(err, dict) else "INTERNAL_ERROR"
        msg = (err.get("message") or err.get("userMessage", "")) if isinstance(err, dict) else str(err)
        resp["error"] = {"code": code, "message": msg or "An error occurred"}
    return resp


def _enrich_legacy_response(response: dict[str, Any], request_id: Any) -> dict[str, Any]:
    status = response.get("status", "")
    if status == "ok":
        response.setdefault("ok", True)
        response.setdefault("code", "OK")
        response.setdefault("message", "OK")
    elif status == "error":
        response.setdefault("ok", False)
        err = response.get("error", {})
        if isinstance(err, dict):
            response.setdefault("code", err.get("code", "ERROR"))
            response.setdefault("message", err.get("userMessage") or err.get("message", "An error occurred"))
        else:
            response.setdefault("code", "ERROR")
            response.setdefault("message", str(err))
    if request_id is not None:
        response["_id"] = request_id
        response["id"] = request_id
    return response


def _build_response(request_id: Any, fmt: str, raw: dict[str, Any]) -> dict[str, Any]:
    if fmt == "v1":
        return _to_v1_response(request_id, raw)
    return _enrich_legacy_response(raw, request_id)


# Actions that show UI dialogs or run long folder probes.
# These are dispatched to background threads so the main stdin loop
# stays responsive to pings, healthChecks, and other quick commands
# while the user is interacting with the dialog or waiting for the probe.
_ASYNC_ACTIONS = frozenset({
    "ocfPickFolder",
    "ocfProbeFolder",
    "ocfProbeFile",
    "pickFolder",
    "folder.pick",
    "pickImfFolder",
    "pickMediaFile",
    "pickMediaFiles",
    "pick.mediaFiles",
    "resolveStatus",
    "resolveGetMarkers",
    "resolvePushMarkers",
    "exportNLELinkedAAF",
    "exportProToolsAAF",
    # Resolve Background Engine — detect/test block briefly; runJob is fire-and-forget
    "resolveDetect",
    "resolve.detect",
    "resolveTest",
    "resolve.test",
    "resolveEngineStatus",
    "resolve.engineStatus",
    "resolveStartEngine",
    "resolve.startEngine",
    "resolveStopEngine",
    "resolve.stopEngine",
    "resolveRunJob",
    "resolve.runJob",
    "resolveCancelJob",
    "resolve.cancelJob",
    "resolve.jobStatus",
    "resolveListJobs",
    "resolve.listJobs",
    "resolveClearQueue",
    "resolve.clearQueue",
    "resolveGetLogs",
    "resolve.getLogs",
    "resolveOpenLogs",
    "resolve.openLogs",
    "resolveManualHandoff",
    "resolve.manualHandoff",
    # Trailer Conform — long-running analysis and build jobs
    "conformAnalyze",
    "conformBuildTimeline",
    "conformCancelJob",
    # IMF frame thumbnail — ffmpeg seek + JPEG extract (can take a few seconds)
    "getImfFrameThumb",
    # IMF QC — runs java -jar photon.jar, can take tens of seconds on large packages
    "runImfQc",
    # IMF IAB inspection — reads large MXF file; must not block main loop
    "inspectImmersiveAudio",
    "startIabDecode",
    # OCF Resolve still preview — imports OCF into Resolve and renders a frame (can take 30+ s)
    "ocfDecodeFrame",
    "vfxPreviewResolveStill",
    "vfx.preview.resolveStill",
    "vfxPreviewResolveStillBatch",
    "vfx.preview.resolveStillBatch",
    "resolve.previewFrameBatch",
    "resolve.extractStillFrame",
    "resolve.previewFrame",
    "resolve.extract_still_frame",
    # AVFoundation still preview — QuickLook decode, blocks for a few seconds
    "vfxPreviewAvfStill",
    "vfx.preview.avfStill",
})

# Responses from async handlers are placed here; the main loop drains
# this queue and writes them out before reading the next stdin message.
_async_out: queue.Queue[dict[str, Any]] = queue.Queue()

# Protects stdout against concurrent writes (main loop + async threads).
_stdout_lock = threading.Lock()


def _flush_async_responses() -> None:
    """Write any completed async responses to Chrome before blocking on stdin."""
    while True:
        try:
            msg = _async_out.get_nowait()
        except queue.Empty:
            break
        with _stdout_lock:
            _write_native_message(msg)


def _stdin_has_data(timeout: float = 0.05) -> bool:
    """Return True if stdin has data available within `timeout` seconds."""
    try:
        r, _, _ = select.select([sys.stdin.buffer], [], [], timeout)
        return bool(r)
    except (select.error, ValueError):
        return True  # can't select (e.g. on Windows) — assume data available


def run_native_host() -> int:
    api = CompanionApi()

    while True:
        # Drain any async responses first so Chrome doesn't timeout waiting.
        _flush_async_responses()

        # Use select() to avoid blocking forever on stdin when async responses
        # may arrive.  Poll every 50 ms so we can flush them promptly.
        if not _stdin_has_data(timeout=0.05):
            continue

        message = _read_native_message()
        if message is None:
            return 0

        request_id, normalized, fmt = _normalize_request(message)
        action = str(normalized.get("action", "")).strip()

        if action in _ASYNC_ACTIONS:
            # Dispatch to a background thread so dialog/probe doesn't freeze
            # the loop.  The thread posts its result to _async_out when done.
            def _run_async(req: dict = normalized, rid: Any = request_id, f: str = fmt) -> None:
                try:
                    raw = api.handle(req)
                except Exception as exc:
                    raw = {
                        "status": "error",
                        "error": {
                            "code": "INTERNAL_ERROR",
                            "message": f"Unhandled exception: {exc}",
                            "userMessage": "An unexpected error occurred in the companion.",
                        },
                    }
                _async_out.put(_build_response(rid, f, raw))

            threading.Thread(target=_run_async, daemon=True).start()
            # Don't write a response now — the thread will enqueue it.

        else:
            try:
                raw_response = api.handle(normalized)
            except Exception as exc:
                raw_response = {
                    "status": "error",
                    "error": {
                        "code": "INTERNAL_ERROR",
                        "message": f"Unhandled exception: {exc}",
                        "userMessage": "An unexpected error occurred in the companion.",
                    },
                }
            with _stdout_lock:
                _write_native_message(_build_response(request_id, fmt, raw_response))
