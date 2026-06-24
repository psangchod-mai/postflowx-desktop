from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
import tempfile
import threading
import time
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .proxy_service import _find_ffmpeg, _find_ffprobe, _probe_media_info, build_preview_proxy, migrate_named_proxy_cache
from .service_state import create_session, get_session


def _find_proxy_file_on_disk(session_id: str) -> str | None:
    """Locate pfx_imf_{session_id}.mp4 — checks proxy root first, then system temp."""
    filename = f"pfx_imf_{session_id}.mp4"
    # 1. Check active proxy root (legacy/ subdir)
    try:
        from .proxy_registry import get_proxy_root
        root = get_proxy_root()
        if root:
            for subdir in (root / "legacy", root / "imf", root):
                p = subdir / filename
                if p.is_file() and p.stat().st_size > 0:
                    return str(p)
    except Exception:
        pass
    # 2. Fallback: system temp dir (legacy location)
    candidate = Path(tempfile.gettempdir()) / filename
    if candidate.is_file() and candidate.stat().st_size > 0:
        return str(candidate)
    return None


import secrets

CHUNK = 1024 * 1024
_server_thread: threading.Thread | None = None
_server_port: int | None = None
_server_lock = threading.Lock()

# One-time secret token generated at server startup.
# Returned to the extension via native messaging (the only trusted channel) and
# required as the X-PFX-Token header on every HTTP request.  This prevents any
# other local process from calling /register/?path=… to read arbitrary files via
# the /stream/ endpoint (local file disclosure via unauthenticated HTTP).
_server_token: str = secrets.token_hex(24)   # 48-char hex, generated once per run


def get_http_token() -> str:
    """Return the shared secret that the extension must include in all requests."""
    return _server_token


# Asset file registry — populated by api.py when openFile is called.
# Maps assetId → absolute file path so the /file/ route can stream it.
_file_registry: dict[str, str] = {}
_file_registry_lock = threading.Lock()


def register_asset_file(asset_id: str, path: str) -> None:
    with _file_registry_lock:
        _file_registry[asset_id] = path


def deregister_asset_file(asset_id: str) -> None:
    with _file_registry_lock:
        _file_registry.pop(asset_id, None)


def unregister_asset_file(asset_id: str) -> None:
    with _file_registry_lock:
        _file_registry.pop(asset_id, None)


def _safe_proxy_stem(name: str) -> str:
    stem = Path(str(name or "").strip()).stem or "proxy"
    safe = "".join(ch if ch.isalnum() or ch in ("-", "_", ".") else "_" for ch in stem)
    safe = safe.strip(" ._")
    while "__" in safe:
        safe = safe.replace("__", "_")
    return safe[:180] or "proxy"


def _preview_root(out_dir: str) -> Path | None:
    raw = str(out_dir or "").strip()
    if not raw:
        return None
    try:
        root = Path(raw).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        return root if root.is_dir() else None
    except Exception:
        return None


def _preview_proxy_path(out_dir: str, orig_name: str) -> str:
    root = _preview_root(out_dir)
    if root is None:
        return ""
    return str(root / f"{_safe_proxy_stem(orig_name)}_proxy.mp4")


def _preview_cache_entries(out_dir: str) -> dict[str, dict[str, str]]:
    root = _preview_root(out_dir)
    if root is None:
        return {}
    entries: dict[str, dict[str, str]] = {}
    for sidecar in root.glob("*.json"):
        try:
            payload = json.loads(sidecar.read_text(encoding="utf-8", errors="replace") or "{}")
        except Exception:
            continue
        if not isinstance(payload, dict):
            continue
        cache_key = str(payload.get("cacheKey") or "").strip()
        output_path = str(payload.get("outputPath") or "").strip()
        if not cache_key or not output_path:
            continue
        path = Path(output_path).expanduser()
        try:
            if not (path.is_file() and path.stat().st_size > 0):
                continue
        except Exception:
            continue
        entries[cache_key] = {
            "path": str(path.resolve()),
            "name": str(payload.get("name") or path.stem),
            "startTimecode": str(payload.get("startTimecode") or "").strip(),
        }
    return entries


def _build_uploaded_preview(session_id: str, source_path: str, ffmpeg_path: str,
                            output_path: str, proxy_name: str, cache_key: str) -> None:
    try:
        build_preview_proxy(
            session_id,
            source_path,
            ffmpeg_path,
            output_path=output_path or None,
            proxy_name=proxy_name,
            cache_key=cache_key,
        )
    finally:
        try:
            Path(source_path).unlink(missing_ok=True)
        except Exception:
            pass


class CompanionHttpHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:
        return

    def _send_json(self, status_code: int, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(raw)

    def _check_token(self, parsed_path: str) -> bool:
        """Return True if request carries the correct shared secret.

        /ping is intentionally unauthenticated so the extension can discover
        whether the companion is running before it has received the token via
        native messaging.  All other routes require the token to prevent any
        other local process from exploiting /register + /stream to read arbitrary
        files (local file disclosure).

        Token accepted via:
        - X-PFX-Token request header (fetch/XHR)
        - ?token= query parameter (<video src=...> cannot set custom headers)
        """
        if parsed_path in ("/ping", "/health"):
            return True
        # /file/{assetId} — the assetId is a random UUID generated per-session.
        # Only files explicitly registered by the companion are accessible here,
        # so the assetId itself provides per-resource access control.
        # An additional shared-secret header would block <video src=...> which
        # cannot send custom request headers.
        if parsed_path.startswith("/file/"):
            return True
        # 1. Header (fetch / XHR)
        token = (
            self.headers.get("X-PFX-Token") or
            self.headers.get("x-pfx-token") or
            ""
        )
        if token and secrets.compare_digest(token, _server_token):
            return True
        # 2. Query-string (?token=…) — used by <video src> which cannot send headers
        try:
            q = parse_qs(urlparse(self.path).query)
            q_token = (q.get("token") or [""])[0]
            if q_token and secrets.compare_digest(q_token, _server_token):
                return True
        except Exception:
            pass
        return False

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range, Content-Type, Content-Length, X-PFX-Token")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if not self._check_token(path):
            self._send_json(403, {"status": "error", "error": "forbidden"})
            return
        query = parse_qs(parsed.query or "")
        if path == "/ping":
            self._send_json(200, {"status": "ok"})
            return
        if path == "/health":
            self._send_json(200, {"status": "ok", "service": "postflowx-companion"})
            return
        if path == "/resolve_path":
            name = str((query.get("name") or [""])[0] or "").strip()
            if not name or "/" in name or "\\" in name or ".." in name:
                self._send_json(400, {"error": "invalid name"})
                return
            home = Path.home()
            search_roots = [
                home, home / "Documents", home / "Desktop", home / "Movies",
                home / "Downloads", home / "Pictures", home / "Music",
                Path("/Volumes"),
            ]
            found = ""
            for root in search_roots:
                try:
                    # Check root itself
                    candidate = root / name
                    if candidate.is_dir():
                        found = str(candidate)
                        break
                    # Check one level deep
                    for child in root.iterdir():
                        if child.is_dir() and (child / name).is_dir():
                            found = str(child / name)
                            break
                    if found:
                        break
                except (PermissionError, OSError):
                    continue
            if found:
                self._send_json(200, {"folderPath": found})
            else:
                self._send_json(404, {"error": "not found"})
            return
        if path.startswith("/progress/"):
            session_id = path[len("/progress/"):]
            state = get_session(session_id)
            if not state:
                self._send_json(404, {"status": "error", "error": "not found"})
                return
            self._send_json(200, {
                "jobId": session_id,
                "kind": state.get("kind") or "proxy",
                "state": "done" if state.get("done") and not state.get("error") else "failed" if state.get("error") else "running",
                "pct": state.get("pct", 0),
                "done": bool(state.get("done")),
                "error": state.get("error"),
                "stage": state.get("stage") or ("complete" if state.get("done") and not state.get("error") else "running"),
                "message": state.get("message") or ("Proxy ready" if state.get("done") and not state.get("error") else state.get("error") or "Building proxy…"),
                "audioMode": state.get("audioMode", "unknown"),
                "audioMessage": state.get("audioMessage", ""),
                "artifactPath": state.get("artifactPath") or "",
                "artifactType": state.get("artifactType") or "",
                "assetPath": state.get("assetPath") or "",
                "trackFileId": state.get("trackFileId") or "",
                "immersiveAudio": state.get("immersive") or {},
                "outputPath": state.get("path") or "",
                "proxyName": state.get("proxyName") or "",
                "startTimecode": state.get("startTimecode") or "",
            })
            return
        if path.startswith("/log/"):
            session_id = path[len("/log/"):]
            state = get_session(session_id)
            raw = (state or {}).get("_log", "no log").encode("utf-8", "replace")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(raw)
            return
        if path.startswith("/imf_dovi/"):
            session_id = path[len("/imf_dovi/"):]
            state = get_session(session_id)
            self._send_json(200, (state or {}).get("dovi") or {})
            return
        if path.startswith("/register/"):
            session_id = path[len("/register/"):].strip()
            file_path = str((query.get("path") or [""])[0] or "").strip()
            start_timecode = str((query.get("start_timecode") or [""])[0] or "").strip()
            if not session_id or not file_path:
                self._send_json(404, {"status": "error", "error": "not found"})
                return
            try:
                resolved = Path(file_path).expanduser().resolve()
            except Exception:
                self._send_json(404, {"status": "error", "error": "not found"})
                return
            if not resolved.is_file():
                self._send_json(404, {"status": "error", "error": "file_not_found"})
                return
            create_session(session_id, {
                "kind": "preview",
                "done": True,
                "pct": 100,
                "stage": "complete",
                "message": "Preview ready (restored)",
                "path": str(resolved),
                "error": None,
                "proxyName": resolved.stem,
                "startTimecode": start_timecode,
            })
            self._send_json(200, {"status": "ok", "sessionId": session_id})
            return
        if path.startswith("/cache/lookup/"):
            session_id = path[len("/cache/lookup/"):].strip()
            cache_key = str((query.get("key") or [""])[0] or "").strip()
            out_dir = str((query.get("dir") or [""])[0] or "").strip()
            orig_name = str((query.get("orig_name") or [""])[0] or "").strip()
            entry = _preview_cache_entries(out_dir).get(cache_key) if cache_key and out_dir else None
            if not entry and out_dir and orig_name:
                candidate = _preview_proxy_path(out_dir, orig_name)
                if candidate:
                    cpath = Path(candidate)
                    try:
                        if cpath.is_file() and cpath.stat().st_size > 0:
                            fallback_tc = ""
                            try:
                                payload = json.loads(cpath.with_suffix(".json").read_text(encoding="utf-8", errors="replace") or "{}")
                                if isinstance(payload, dict):
                                    fallback_tc = str(payload.get("startTimecode") or "").strip()
                            except Exception:
                                fallback_tc = ""
                            entry = {
                                "path": str(cpath.resolve()),
                                "name": cpath.stem,
                                "startTimecode": fallback_tc,
                            }
                    except Exception:
                        entry = None
            if not entry:
                self._send_json(200, {"found": False})
                return
            if not str(entry.get("startTimecode") or "").strip():
                try:
                    ffmpeg_path = _find_ffmpeg() or ""
                    ffprobe_path = _find_ffprobe(ffmpeg_path) if ffmpeg_path else None
                    if ffprobe_path:
                        probed = _probe_media_info(str(entry["path"]), ffprobe_path) or {}
                        entry["startTimecode"] = str(probed.get("startTimecode") or "").strip()
                except Exception:
                    pass
            if session_id:
                create_session(session_id, {
                    "kind": "preview",
                    "done": True,
                    "pct": 100,
                    "stage": "complete",
                    "message": "Preview ready (cached)",
                    "path": entry["path"],
                    "error": None,
                    "proxyName": entry.get("name") or Path(entry["path"]).stem,
                    "startTimecode": entry.get("startTimecode") or "",
                })
            self._send_json(200, {
                "found": True,
                "sessionId": session_id,
                "outputPath": entry["path"],
                "name": entry.get("name") or "",
                "startTimecode": entry.get("startTimecode") or "",
            })
            return
        if path == "/cache/migrate":
            out_dir = str((query.get("dir") or [""])[0] or "").strip()
            renamed = 0
            if out_dir:
                try:
                    renamed = int(migrate_named_proxy_cache(out_dir))
                except Exception:
                    renamed = 0
            self._send_json(200, {"status": "ok", "renamed": renamed})
            return
        if path == "/cache/list":
            out_dir = str((query.get("dir") or [""])[0] or "").strip()
            self._send_json(200, {"entries": _preview_cache_entries(out_dir)})
            return
        if path.startswith("/file/"):
            asset_id = path[len("/file/"):]
            with _file_registry_lock:
                file_path = _file_registry.get(asset_id, "")
            if not file_path or not os.path.isfile(file_path):
                self._send_json(404, {"status": "error", "error": "asset not found"})
                return
            self._serve_file(file_path)
            return
        if path.startswith("/thumb/"):
            filename = path[len("/thumb/"):]
            # Reject path traversal or empty names
            if not filename or "/" in filename or "\\" in filename or ".." in filename:
                self.send_error(400, "bad filename")
                return
            from .proxy_service import _thumb_cache_dir
            thumb_dir = _thumb_cache_dir()
            thumb_file = thumb_dir / filename
            if not thumb_file.is_file():
                self.send_error(404, "not found")
                return
            self._serve_image(str(thumb_file))
            return
        if path.startswith("/wav/"):
            session_id = path[len("/wav/"):]
            state = get_session(session_id)
            if not state:
                self._send_json(404, {"status": "error", "error": "not found"})
                return
            wav_path = state.get("artifactPath") or ""
            if not wav_path or not os.path.isfile(wav_path):
                self.send_error(404, "wav not ready")
                return
            self._serve_file(wav_path)
            return
        if path.startswith("/stream/"):
            session_id = path[len("/stream/"):]
            # Reject path traversal — session_id is used to build an on-disk
            # proxy filename in _find_proxy_file_on_disk (same guard as /thumb/).
            if not session_id or "/" in session_id or "\\" in session_id or ".." in session_id:
                self.send_error(400, "bad session id")
                return
            deadline = time.time() + 600
            file_path: str | None = None
            state: dict | None = None
            while True:
                state = get_session(session_id)
                if not state:
                    # Session not in memory — companion may have restarted.
                    # Try to serve the proxy file directly from disk.
                    file_path = _find_proxy_file_on_disk(session_id)
                    if file_path:
                        break
                    self._send_json(404, {"status": "error", "error": "not found"})
                    return
                if state.get("done"):
                    file_path = state.get("path")
                    break
                if time.time() > deadline:
                    self.send_error(503, "timeout")
                    return
                time.sleep(0.3)
            if state and (state.get("error") or not file_path):
                self.send_error(503, state.get("error") or "proxy failed")
                return
            if not file_path:
                self.send_error(503, "proxy file not found")
                return
            self._serve_file(file_path)
            return
        self._send_json(404, {"status": "error", "error": "not found"})

    def _read_json_body(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", 0) or 0)
            if length <= 0:
                return {}
            raw = self.rfile.read(length)
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return {}

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if not self._check_token(path):
            self._send_json(403, {"status": "error", "error": "forbidden"})
            return

        # ── Smart Media Engine API ────────────────────────────────────────────
        if path == "/api/media/probe":
            body = self._read_json_body()
            try:
                from .media_engine import probe
                result = probe(
                    path=str(body.get("path") or ""),
                    context=str(body.get("context") or ""),
                    timeline_fps=str(body.get("timelineFps") or ""),
                    timecode_base=int(body.get("timecodeBase") or 0),
                )
                self._send_json(200, result)
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if path == "/api/media/select-engine":
            body = self._read_json_body()
            try:
                from .media_engine import select_engine
                engine, fallbacks, reason = select_engine(
                    container=str(body.get("container") or ""),
                    codec=str(body.get("codec") or ""),
                    codec_tag=str(body.get("codecTag") or ""),
                    is_prores=bool(body.get("isProRes")),
                    is_ocf=bool(body.get("isCameraRaw")),
                    is_browser_safe=bool(body.get("isBrowserSafe")),
                    is_image_sequence=bool(body.get("isImageSequence")),
                    is_imf_package=bool(body.get("isImfPackage")),
                    user_override=body.get("userOverride"),
                )
                self._send_json(200, {"ok": True, "engine": engine, "fallbacks": fallbacks, "reason": reason})
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if path == "/api/media/decode-frame":
            body = self._read_json_body()
            try:
                from .media_engine import decode_frame
                result = decode_frame(
                    path=str(body.get("path") or ""),
                    frame_number=int(body.get("frameNumber") or 0),
                    fps=str(body.get("fps") or "24000/1001"),
                    scale=int(body.get("scale") or 960),
                    output_format=str(body.get("format") or "png"),
                    sequence_info=body.get("sequenceInfo"),
                )
                self._send_json(200, result)
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if path == "/api/media/status":
            try:
                from .media_engine import engine_status_for_ui
                rows = engine_status_for_ui()
                self._send_json(200, {"ok": True, "engines": rows})
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc), "engines": []})
            return

        if path == "/api/media/show-logs":
            body = self._read_json_body()
            try:
                from .media_engine import read_all_logs
                logs = read_all_logs()
                channel = str(body.get("channel") or "")
                if channel and channel in logs:
                    self._send_json(200, {"ok": True, "log": logs[channel], "channel": channel})
                else:
                    self._send_json(200, {"ok": True, "logs": logs})
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if path == "/api/media/transcode-proxy":
            body = self._read_json_body()
            try:
                import uuid as _uuid
                from .media_engine import generate_proxy_async
                session_id = str(body.get("sessionId") or _uuid.uuid4().hex)
                generate_proxy_async(
                    source_path=str(body.get("sourcePath") or ""),
                    output_dir=str(body.get("outputDir") or ""),
                    session_id=session_id,
                    codec=str(body.get("codec") or "h264"),
                    scale=int(body.get("scale") or 1920),
                    fps_str=str(body.get("fps") or ""),
                    timecode_start=str(body.get("timecodeStart") or ""),
                )
                self._send_json(200, {"ok": True, "sessionId": session_id})
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        # ── IMF Engine API ────────────────────────────────────────────────────
        if path == "/api/imf/open":
            body = self._read_json_body()
            try:
                from .media_engine import open_package
                result = open_package(str(body.get("path") or ""))
                self._send_json(200, result)
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if path == "/api/imf/probe-cpl":
            body = self._read_json_body()
            try:
                from .media_engine import probe_cpl
                cpl_path = str(body.get("cplPath") or "")
                assetmaps = list(body.get("assetMaps") or [])
                result = probe_cpl(cpl_path, assetmaps)
                self._send_json(200, result)
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        if path == "/api/imf/decode-test-frame":
            body = self._read_json_body()
            try:
                from .media_engine import decode_test_frame
                result = decode_test_frame(
                    cpl_path=str(body.get("cplPath") or ""),
                    assetmap_paths=list(body.get("assetMaps") or []),
                    frame_number=int(body.get("frameNumber") or 0),
                    scale=int(body.get("scale") or 960),
                )
                self._send_json(200, result)
            except Exception as exc:
                self._send_json(500, {"ok": False, "error": str(exc)})
            return

        # ── Resolve Engine status ─────────────────────────────────────────────
        if path == "/api/resolve/status":
            try:
                from .engines.resolve_engine import resolve_engine_status
                status = resolve_engine_status()
                self._send_json(200, {"ok": True, **status})
            except Exception as exc:
                self._send_json(200, {"ok": True, "resolveInstalled": False,
                                      "resolveRunning": False, "available": False,
                                      "error": str(exc)})
            return

        if not path.startswith("/upload/"):
            self._send_json(404, {"status": "error", "error": "not found"})
            return

        session_id = path[len("/upload/"):].strip()
        query = parse_qs(parsed.query or "")
        out_dir = str((query.get("out_dir") or [""])[0] or "").strip()
        cache_key = str((query.get("cache_key") or [""])[0] or "").strip()
        orig_name = str((query.get("orig_name") or [""])[0] or "").strip()
        output_path = _preview_proxy_path(out_dir, orig_name)
        proxy_name = Path(output_path).stem if output_path else _safe_proxy_stem(orig_name)

        ffmpeg_path = _find_ffmpeg()
        if not ffmpeg_path:
            self._send_json(503, {"status": "error", "error": "ffmpeg not found"})
            return

        content_length = int(self.headers.get("Content-Length", 0) or 0)
        content_type = self.headers.get("Content-Type", "").split(";")[0].strip()
        suffix = Path(orig_name).suffix or mimetypes.guess_extension(content_type or "") or ".mov"
        upload_root = _preview_root(out_dir)
        tmp_file = None
        try:
            tmp_file = tempfile.NamedTemporaryFile(
                suffix=suffix,
                dir=str(upload_root) if upload_root else None,
                delete=False,
            )
            remaining = content_length if content_length > 0 else None
            while True:
                to_read = CHUNK if remaining is None else min(CHUNK, remaining)
                chunk = self.rfile.read(to_read)
                if not chunk:
                    break
                tmp_file.write(chunk)
                if remaining is not None:
                    remaining -= len(chunk)
                    if remaining <= 0:
                        break
            tmp_file.flush()
            source_path = tmp_file.name
            tmp_file.close()
        except Exception as exc:
            if tmp_file and not tmp_file.closed:
                tmp_file.close()
            # delete=False means the OS won't auto-remove it on close — unlink
            # the partial upload so failed uploads don't accumulate on disk.
            if tmp_file is not None:
                try:
                    os.unlink(tmp_file.name)
                except OSError:
                    pass
            self._send_json(500, {"status": "error", "error": str(exc)})
            return

        create_session(session_id, {
            "kind": "preview",
            "done": False,
            "pct": 0,
            "stage": "queued",
            "message": "Queued preview proxy…",
            "path": output_path,
            "error": None,
            "proxyName": proxy_name,
        })
        threading.Thread(
            target=_build_uploaded_preview,
            args=(session_id, source_path, ffmpeg_path, output_path, proxy_name, cache_key),
            daemon=True,
        ).start()
        self._send_json(200, {
            "status": "ok",
            "sessionId": session_id,
            "outputPath": output_path,
        })

    def _serve_image(self, path: str) -> None:
        if not os.path.isfile(path):
            self.send_error(404, "not found")
            return
        size = os.path.getsize(path)
        mime = "image/png" if path.endswith(".png") else "image/jpeg"
        try:
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", str(size))
            self.send_header("Cache-Control", "public, max-age=86400")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            with open(path, "rb") as handle:
                while True:
                    chunk = handle.read(CHUNK)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    @staticmethod
    def _mime_for_path(path: str) -> str:
        lower = path.lower()
        if lower.endswith(".mp4") or lower.endswith(".m4v"):
            return "video/mp4"
        if lower.endswith(".mov"):
            return "video/quicktime"
        if lower.endswith(".webm"):
            return "video/webm"
        if lower.endswith(".mxf"):
            return "application/mxf"
        if lower.endswith(".wav"):
            return "audio/wav"
        return "video/mp4"

    def _serve_file(self, path: str) -> None:
        if not os.path.isfile(path):
            self.send_error(404, "not found")
            return
        size = os.path.getsize(path)
        mime = self._mime_for_path(path)
        range_hdr = self.headers.get("Range", "")
        try:
            if range_hdr.startswith("bytes="):
                start_s, _, end_s = range_hdr[6:].partition("-")
                start = int(start_s) if start_s else 0
                end = int(end_s) if end_s else size - 1
                end = min(end, size - 1)
                # Reject unsatisfiable/inverted ranges — otherwise length goes
                # negative and we'd send a bogus negative Content-Length.
                if start < 0 or start > end or start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                length = end - start + 1
                self.send_response(206)
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Content-Length", str(length))
                self.send_header("Content-Type", mime)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                with open(path, "rb") as handle:
                    handle.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = handle.read(min(CHUNK, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            else:
                self.send_response(200)
                self.send_header("Content-Length", str(size))
                self.send_header("Content-Type", mime)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                with open(path, "rb") as handle:
                    while True:
                        chunk = handle.read(CHUNK)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass


def run_http_server(host: str = "127.0.0.1", port: int = 47125) -> None:
    server = ThreadingHTTPServer((host, port), CompanionHttpHandler)
    server.serve_forever()


def ensure_http_server(host: str = "127.0.0.1", port: int = 47125) -> int | None:
    global _server_thread, _server_port
    with _server_lock:
        if _server_thread and _server_thread.is_alive() and _server_port:
            return _server_port
        # Try the preferred fixed port first, then fall back to OS-assigned
        server = None
        for try_port in ([port] if port else []) + [0]:
            try:
                server = ThreadingHTTPServer((host, try_port), CompanionHttpHandler)
                break
            except OSError:
                server = None
        if server is None:
            return None
        _server_port = int(server.server_address[1])

        def _run() -> None:
            server.serve_forever()

        _server_thread = threading.Thread(target=_run, daemon=True)
        _server_thread.start()
        return _server_port
