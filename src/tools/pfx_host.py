#!/usr/bin/env python3
"""
PostFlowX Native Messaging Host + Local HTTP Proxy Server
Transcodes Apple ProRes (and other unsupported codecs) to H.264
so Chrome can play them via a local HTTP stream.

Architecture:
  1. Chrome extension connects via Native Messaging (stdin/stdout JSON)
  2. This host starts a local HTTP server on a free port
  3. Extension sends { action:"serve", path:"/abs/path/to/file.mov" }
  4. Host spawns ffmpeg to transcode ProRes → H.264 and stream over HTTP
  5. Host replies { status:"ready", url:"http://127.0.0.1:PORT/stream/ID" }
  6. Extension sets video.src = url → plays in real-time

Requirements (macOS):
  - Python 3 (pre-installed)
  - ffmpeg  (brew install ffmpeg)
"""

import sys
import json
import secrets
import struct
import os
import threading
import subprocess
import uuid
import signal
import time
import shutil
import tempfile
import mimetypes
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

# ── Constants ────────────────────────────────────────────────────────────────
HOST_NAME = "com.postflowx.host"
HTTP_HOST = "127.0.0.1"
HTTP_PORT = 0          # 0 = OS picks a free port; actual port stored in _http_port
CHUNK = 65536          # 64 KB read chunks
MAX_SESSIONS = 20      # max concurrent transcode sessions

# ── Startup token ─────────────────────────────────────────────────────────────
# Generated once per process. Returned to the extension via native messaging
# (the only channel other processes cannot read) and required as X-PFX-Token
# on all HTTP requests except /ping.  Prevents other local processes from using
# /register/?path= to read arbitrary files via /stream/.
_http_token: str = secrets.token_hex(24)

# ── Global state ─────────────────────────────────────────────────────────────
_http_port = None
_sessions = {}         # id → { path, output_path, proc, pct, done, error, ... }
_sessions_lock = threading.Lock()


def _safe_unlink(path):
    try:
        if path and os.path.exists(path):
            os.unlink(path)
    except Exception:
        pass


def _update_session(session_id, **updates):
    with _sessions_lock:
        session = _sessions.get(session_id)
        if not session:
            return None
        session.update(updates)
        return dict(session)


def _get_session(session_id):
    with _sessions_lock:
        session = _sessions.get(session_id)
        return dict(session) if session else None


def _probe_duration_seconds(path):
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        proc = subprocess.run(
            [
                ffprobe,
                "-v", "error",
                "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        if proc.returncode != 0:
            return None
        val = float((proc.stdout or "").strip() or 0)
        return val if val > 0 else None
    except Exception:
        return None


def _probe_timecode(path):
    """
    Extract the start timecode from a media file.
    Checks stream tags first (tmcd track), then format tags (global metadata).
    Returns a string like '01:00:00:00' or None.
    """
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        proc = subprocess.run(
            [
                ffprobe, "-v", "error",
                "-show_entries", "stream_tags=timecode:format_tags=timecode",
                "-of", "default=noprint_wrappers=1:nokey=1",
                path,
            ],
            capture_output=True, text=True, timeout=10, check=False,
        )
        if proc.returncode == 0:
            for line in (proc.stdout or "").splitlines():
                tc = line.strip()
                # Valid timecodes look like HH:MM:SS:FF or HH:MM:SS;FF
                if tc and len(tc) >= 11 and tc[2] == ":" and tc[5] == ":":
                    return tc
    except Exception:
        pass
    return None


def _make_output_path(input_path, out_dir=None, orig_name=None):
    preferred_name = str(orig_name or "").strip()
    stem_source = preferred_name or os.path.basename(input_path or "proxy")
    stem = os.path.splitext(stem_source)[0] or "proxy"
    safe_stem = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in stem).strip("_") or "proxy"
    if out_dir:
        try:
            os.makedirs(out_dir, exist_ok=True)
            return os.path.join(out_dir, f"{safe_stem}_proxy.mp4")
        except Exception:
            pass
    fd, out_path = tempfile.mkstemp(suffix=".mp4", prefix=f"{safe_stem}_")
    os.close(fd)
    return out_path


def _start_transcode_session(session_id):
    session = _get_session(session_id)
    if not session:
        return
    input_path = session.get("path")
    output_path = session.get("output_path")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        _update_session(session_id, status="error", done=True, error="ffmpeg_missing", pct=0)
        return
    if not input_path or not os.path.isfile(input_path):
        _update_session(session_id, status="error", done=True, error="input_missing", pct=0)
        return

    duration_sec = _probe_duration_seconds(input_path)
    start_tc     = _probe_timecode(input_path)   # e.g. '01:00:00:00' or None
    _update_session(session_id, status="running", pct=0, done=False, error=None,
                    duration_sec=duration_sec, timecode=start_tc)

    def worker():
        cmd = [
            ffmpeg, "-y",
            "-i", input_path,
            # Map video, all audio, and data streams (tmcd timecode track)
            "-map", "0:v:0",
            "-map", "0:a?",
            "-map", "0:d?",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "18",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "192k",
            "-c:d", "copy",          # copy tmcd timecode data track unchanged
            "-map_metadata", "0",    # copy all global metadata tags
        ]
        # Belt-and-suspenders: also embed timecode as an explicit metadata tag
        # so NLEs that read format tags (not just tmcd tracks) get it too.
        if start_tc:
            cmd += ["-metadata", f"timecode={start_tc}"]
        cmd += [
            "-movflags", "+faststart",
            "-progress", "pipe:2",
            "-nostats",
            output_path,
        ]
        proc = None
        try:
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                stdin=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
            _update_session(session_id, proc=proc, started_at=time.time())
            for raw in proc.stderr:
                line = (raw or "").strip()
                if not line:
                    continue
                if "=" not in line:
                    continue
                key, val = line.split("=", 1)
                key = key.strip()
                val = val.strip()
                if key in ("out_time_ms", "out_time_us"):
                    try:
                        out_sec = float(val) / (1000000.0 if key == "out_time_us" else 1000000.0)
                    except Exception:
                        out_sec = None
                    current = _get_session(session_id)
                    dur = current.get("duration_sec") if current else duration_sec
                    if out_sec is not None and dur and dur > 0:
                        pct = max(0, min(99, int((out_sec / dur) * 100)))
                        _update_session(session_id, pct=pct)
                elif key == "progress" and val == "end":
                    _update_session(session_id, pct=100)

            rc = proc.wait()
            final = _get_session(session_id)
            if not final:
                return
            if rc == 0 and os.path.exists(output_path):
                _update_session(session_id, status="done", done=True, pct=100, error=None, proc=None)
            else:
                err = final.get("error") or f"ffmpeg_exit_{rc}"
                _safe_unlink(output_path)
                _update_session(session_id, status="error", done=True, pct=0, error=err, proc=None)
        except Exception as e:
            _safe_unlink(output_path)
            _update_session(session_id, status="error", done=True, pct=0, error=str(e), proc=None)
        finally:
            try:
                if proc and proc.stderr:
                    proc.stderr.close()
            except Exception:
                pass

    thread = threading.Thread(target=worker, daemon=True)
    _update_session(session_id, thread=thread)
    thread.start()


# ── Native Messaging I/O (Chrome binary protocol) ────────────────────────────

def _read_message():
    """Read one JSON message from Chrome (4-byte LE length prefix)."""
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack("<I", raw)[0]
    # Chrome caps native messages at 1 MB; guard against corrupt/huge headers.
    if length > 64 * 1024 * 1024:
        return None
    data = sys.stdin.buffer.read(length)
    if len(data) < length:
        return None
    return json.loads(data.decode("utf-8"))


def _send_message(obj):
    """Send one JSON message to Chrome (4-byte LE length prefix)."""
    data = json.dumps(obj).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


# ── HTTP streaming handler ────────────────────────────────────────────────────

class ProxyHandler(BaseHTTPRequestHandler):
    """Serves transcoded video streams from active ffmpeg sessions."""

    def log_message(self, fmt, *args):
        pass  # silence access log

    def _check_token(self, path: str) -> bool:
        if path == "/ping":
            return True
        token = (
            self.headers.get("X-PFX-Token") or
            self.headers.get("x-pfx-token") or
            ""
        )
        return secrets.compare_digest(token, _http_token)

    def do_GET(self):
        parsed = urlparse(self.path)

        if not self._check_token(parsed.path):
            self.send_response(403)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "error", "error": "forbidden"}).encode())
            return

        # Health check
        if parsed.path == "/ping":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(b"pong")
            return

        if parsed.path.startswith("/register/"):
            session_id = parsed.path[len("/register/"):]
            query = parse_qs(parsed.query or "")
            file_path = str((query.get("path") or [""])[0] or "").strip()
            if not file_path or not os.path.isfile(file_path):
                self.send_response(404)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "error", "error": "file_not_found"}).encode())
                return
            with _sessions_lock:
                _sessions[session_id] = {
                    "path": None, "output_path": file_path,
                    "_tmp": False, "status": "done", "pct": 100,
                    "done": True, "error": None, "proc": None,
                    "thread": None, "out_dir": "",
                }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "ok", "sessionId": session_id}).encode())
            return

        if parsed.path.startswith("/cache/lookup/"):
            # Scan out_dir for a proxy whose sidecar matches the given cache key.
            # Falls back to the expected filename derived from orig_name when no sidecar is found.
            # Returns {found: true, outputPath, sessionId} on hit; {found: false} on miss.
            lookup_session_id = parsed.path[len("/cache/lookup/"):]
            query = parse_qs(parsed.query or "")
            lookup_key = str((query.get("key") or [""])[0] or "").strip()
            lookup_dir = str((query.get("dir") or [""])[0] or "").strip()
            lookup_orig = str((query.get("orig_name") or [""])[0] or "").strip()
            found_path = None
            if lookup_key and lookup_dir and os.path.isdir(lookup_dir):
                # 1. Scan sidecar JSON files for matching cache key
                try:
                    for fname in os.listdir(lookup_dir):
                        if not fname.endswith(".json"):
                            continue
                        sidecar_f = os.path.join(lookup_dir, fname)
                        try:
                            with open(sidecar_f, encoding="utf-8") as _f:
                                sc = json.load(_f)
                            if str(sc.get("cacheKey") or "") == lookup_key:
                                mp4 = str(sc.get("outputPath") or "").strip()
                                if mp4 and os.path.isfile(mp4) and os.path.getsize(mp4) > 0:
                                    found_path = mp4
                                    break
                        except Exception:
                            continue
                except Exception:
                    pass
                # 2. Fallback: try the deterministic filename from orig_name
                if not found_path and lookup_orig:
                    stem = os.path.splitext(lookup_orig)[0] or "proxy"
                    safe = "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in stem).strip("_") or "proxy"
                    candidate = os.path.join(lookup_dir, f"{safe}_proxy.mp4")
                    if os.path.isfile(candidate) and os.path.getsize(candidate) > 0:
                        found_path = candidate
            if found_path:
                with _sessions_lock:
                    _sessions[lookup_session_id] = {
                        "path": None, "output_path": found_path,
                        "_tmp": False, "status": "done", "pct": 100,
                        "done": True, "error": None, "proc": None,
                        "thread": None, "out_dir": lookup_dir,
                    }
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"found": True, "outputPath": found_path, "sessionId": lookup_session_id}).encode())
            else:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({"found": False}).encode())
            return

        if parsed.path.startswith("/progress/"):
            session_id = parsed.path[len("/progress/"):]
            session = _get_session(session_id)
            if not session:
                self.send_response(404)
                self.end_headers()
                return
            payload = {
                "status": session.get("status", "queued"),
                "pct": int(session.get("pct", 0) or 0),
                "done": bool(session.get("done")),
                "error": session.get("error"),
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(json.dumps(payload).encode("utf-8"))
            return

        # Stream endpoint: /stream/<session_id>
        if parsed.path.startswith("/stream/"):
            session_id = parsed.path[len("/stream/"):]
            session = _get_session(session_id)
            if not session:
                self.send_response(404)
                self.end_headers()
                return
            self._stream_session(session)
            return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        """Upload endpoint: POST /upload/<session_id>
        Receives raw video bytes from the extension (streamed from a blob URL),
        saves to a temp file, then registers a session so GET /stream/<id> works.
        """
        parsed = urlparse(self.path)
        if not self._check_token(parsed.path):
            self.send_response(403)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"status": "error", "error": "forbidden"}).encode())
            return
        if not parsed.path.startswith("/upload/"):
            self.send_response(404)
            self.end_headers()
            return

        session_id = parsed.path[len("/upload/"):]
        content_length = int(self.headers.get("Content-Length", 0) or 0)

        query = parse_qs(parsed.query or "")
        out_dir = ""
        try:
            out_dir = str((query.get("out_dir") or [""])[0] or "").strip()
        except Exception:
            out_dir = ""
        orig_name = ""
        try:
            orig_name = str((query.get("orig_name") or [""])[0] or "").strip()
        except Exception:
            orig_name = ""
        cache_key = ""
        try:
            cache_key = str((query.get("cache_key") or [""])[0] or "").strip()
        except Exception:
            cache_key = ""

        guessed_ext = mimetypes.guess_extension(self.headers.get("Content-Type", "").split(";")[0].strip() or "") or ".bin"

        # Write incoming bytes to a temp file
        try:
            tmp = tempfile.NamedTemporaryFile(suffix=guessed_ext, delete=False)
            remaining = content_length if content_length > 0 else None
            while True:
                to_read = CHUNK if remaining is None else min(CHUNK, remaining)
                chunk = self.rfile.read(to_read)
                if not chunk:
                    break
                tmp.write(chunk)
                if remaining is not None:
                    remaining -= len(chunk)
                    if remaining <= 0:
                        break
            tmp.flush()
            tmp_path = tmp.name
            tmp.close()
        except Exception as e:
            self.send_response(500)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(str(e).encode())
            return

        output_path = _make_output_path(tmp_path, out_dir, orig_name=orig_name)
        with _sessions_lock:
            if len(_sessions) >= MAX_SESSIONS:
                oldest = next(iter(_sessions))
                old = _sessions.pop(oldest, None)
                if old:
                    try:
                        if old.get("proc"):
                            old["proc"].kill()
                    except Exception:
                        pass
                    _safe_unlink(old.get("path"))
                    _safe_unlink(old.get("output_path"))
            _sessions[session_id] = {
                "path": tmp_path,
                "output_path": output_path,
                "_tmp": True,
                "status": "queued",
                "pct": 0,
                "done": False,
                "error": None,
                "proc": None,
                "thread": None,
                "out_dir": out_dir,
            }

        _start_transcode_session(session_id)

        # Write a sidecar JSON so /cache/lookup can find this proxy by cache key
        if out_dir and cache_key:
            try:
                sidecar_path = os.path.splitext(output_path)[0] + ".json"
                with open(sidecar_path, "w", encoding="utf-8") as _sf:
                    json.dump({"cacheKey": cache_key, "outputPath": output_path, "origName": orig_name}, _sf)
            except Exception:
                pass

        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps({"status": "ok", "sessionId": session_id, "outputPath": output_path}).encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Content-Length")
        self.end_headers()

    def _stream_session(self, session):
        output_path = session.get("output_path")
        status = session.get("status", "queued")
        if status != "done" or not output_path or not os.path.isfile(output_path):
            self.send_response(425 if status in ("queued", "running") else 404)
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-cache")
        try:
            self.send_header("Content-Length", str(os.path.getsize(output_path)))
        except Exception:
            pass
        self.end_headers()

        try:
            with open(output_path, "rb") as fh:
                while True:
                    chunk = fh.read(CHUNK)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass


# ── HTTP server thread ────────────────────────────────────────────────────────

def _start_http_server():
    global _http_port
    server = HTTPServer((HTTP_HOST, HTTP_PORT), ProxyHandler)
    _http_port = server.server_address[1]
    server.serve_forever()


# ── Session management ────────────────────────────────────────────────────────

def _create_session(path):
    session_id = str(uuid.uuid4()).replace("-", "")[:16]
    output_path = _make_output_path(path)
    with _sessions_lock:
        # Evict oldest if over limit
        if len(_sessions) >= MAX_SESSIONS:
            oldest = next(iter(_sessions))
            old = _sessions.pop(oldest, None)
            if old:
                try:
                    if old.get("proc"):
                        old["proc"].kill()
                except Exception:
                    pass
                _safe_unlink(old.get("path") if old.get("_tmp") else None)
                _safe_unlink(old.get("output_path"))
        _sessions[session_id] = {
            "path": path,
            "output_path": output_path,
            "_tmp": False,
            "status": "queued",
            "pct": 0,
            "done": False,
            "error": None,
            "proc": None,
            "thread": None,
        }
    return session_id


def _stop_session(session_id):
    with _sessions_lock:
        session = _sessions.pop(session_id, None)
    if session:
        if session.get("proc"):
            try:
                session["proc"].kill()
            except Exception:
                pass
        if session.get("_tmp") and session.get("path"):
            _safe_unlink(session.get("path"))
        _safe_unlink(session.get("output_path"))


# ── Message dispatch ──────────────────────────────────────────────────────────

def _handle(msg):
    action = msg.get("action", "")

    if action == "ping":
        _send_message({"status": "pong", "port": _http_port, "httpToken": _http_token})

    elif action == "serve":
        path = str(msg.get("path", "")).strip()
        if not path or not os.path.isfile(path):
            _send_message({"status": "error", "error": f"File not found: {path}"})
            return
        if not shutil.which("ffmpeg"):
            _send_message({
                "status": "error",
                "error": "ffmpeg not installed. Run: brew install ffmpeg",
                "hint": "brew install ffmpeg"
            })
            return
        session_id = _create_session(path)
        _start_transcode_session(session_id)
        url = f"http://{HTTP_HOST}:{_http_port}/stream/{session_id}"
        _send_message({"status": "ready", "url": url, "sessionId": session_id})

    elif action == "stop":
        session_id = str(msg.get("sessionId", ""))
        _stop_session(session_id)
        _send_message({"status": "stopped"})

    elif action == "check_ffmpeg":
        path = shutil.which("ffmpeg")
        _send_message({
            "status": "ok" if path else "missing",
            "path": path or "",
            "hint": "" if path else "brew install ffmpeg"
        })

    else:
        _send_message({"status": "error", "error": f"Unknown action: {action}"})


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    # Start HTTP server on background thread
    t = threading.Thread(target=_start_http_server, daemon=True)
    t.start()

    # Wait until port is assigned
    for _ in range(50):
        if _http_port is not None:
            break
        time.sleep(0.05)

    # Message loop
    while True:
        try:
            msg = _read_message()
            if msg is None:
                break
            _handle(msg)
        except Exception as e:
            try:
                _send_message({"status": "error", "error": str(e)})
            except Exception:
                break


if __name__ == "__main__":
    main()
