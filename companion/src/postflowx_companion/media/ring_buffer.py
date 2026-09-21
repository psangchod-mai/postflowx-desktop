"""Background frame prefetch ring buffer for the shared media runtime.

The ring buffer runs a small thread pool that decodes frames N positions
ahead of the current playback position.  When the tab requests a frame
that's already been prefetched, it's served from cache instantly.

Architecture:
  - One PrefetchScheduler per MediaRuntime instance
  - Tabs call MediaRuntime.prefetch_frames(session_id, start, count, direction)
  - Scheduler queues decode jobs into a priority queue (urgent = near current pos)
  - Worker threads pull jobs and call backend.get_frame()
  - Results are written into FrameCache
  - On seek/cancel, pending jobs for that session are discarded

Ring buffer size: tunable, defaults 8 frames per session.
Thread pool: 2 workers (avoids overwhelming ffmpeg / SDK with concurrent calls).
"""
from __future__ import annotations

import queue
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

_DEFAULT_BUFFER_SIZE    = 8    # frames to keep ahead
_DEFAULT_WORKER_COUNT   = 2    # parallel decode threads
_DEFAULT_PREFETCH_AHEAD = 6    # frames to request ahead of playhead
_JOB_TIMEOUT_SEC        = 60   # max time per frame decode


@dataclass(order=True)
class _PrefetchJob:
    """A queued decode request. Lower priority = more urgent."""
    priority:    int
    session_id:  str   = field(compare=False)
    frame_index: int   = field(compare=False)
    options:     dict  = field(compare=False, default_factory=dict)
    generation:  int   = field(compare=False, default=0)  # incremented on cancel
    callback:    Callable | None = field(compare=False, default=None)


class PrefetchScheduler:
    """
    Background frame prefetch manager.

    Usage:
        scheduler.prefetch(session_id, current_frame, fps, backend, cache)
        scheduler.cancel(session_id)        # on seek / close
        scheduler.cancel_all()              # on runtime shutdown
    """

    def __init__(self, worker_count: int = _DEFAULT_WORKER_COUNT,
                 buffer_size: int = _DEFAULT_BUFFER_SIZE):
        self._buffer_size  = buffer_size
        self._queue: queue.PriorityQueue = queue.PriorityQueue()
        self._lock         = threading.Lock()
        self._generations: dict[str, int] = {}   # session_id → cancel generation
        self._inflight:    dict[str, set] = {}   # session_id → {frame_index, ...}
        self._stats        = {"submitted": 0, "completed": 0, "cancelled": 0, "errors": 0}
        self._shutdown     = False

        self._workers = [
            threading.Thread(target=self._worker_loop, daemon=True, name=f"pfx-prefetch-{i}")
            for i in range(worker_count)
        ]
        for w in self._workers:
            w.start()

    # ── Public API ─────────────────────────────────────────────────────────────

    def prefetch(self, session_id: str, current_frame: int,
                 backend: Any, cache: Any, options: dict,
                 count: int = _DEFAULT_PREFETCH_AHEAD,
                 direction: int = 1,
                 handle: Any = None) -> None:
        """
        Queue up to `count` frames starting from current_frame + direction.
        Lower frame-distance = higher priority (lower numeric priority value).
        direction: +1 for forward, -1 for reverse.
        handle: the backend session handle (file path) — must be provided for decoding.
        """
        if self._shutdown:
            return

        with self._lock:
            gen = self._generations.get(session_id, 0)

        for i in range(1, count + 1):
            target = current_frame + i * direction
            if target < 0:
                continue

            # Skip if already cached
            key = cache.make_key(
                session_id, target,
                options.get("quality", "half"),
                options.get("width",  1280),
                options.get("height",  720),
                options.get("format", "jpg"),
            )
            if cache.get(key) is not None:
                continue

            # Skip if already in-flight for this session
            with self._lock:
                if target in self._inflight.get(session_id, set()):
                    continue
                self._inflight.setdefault(session_id, set()).add(target)
                self._stats["submitted"] += 1

            job = _PrefetchJob(
                priority    = i,           # distance from current position
                session_id  = session_id,
                frame_index = target,
                options     = {**options},
                generation  = gen,
                callback    = lambda sid=session_id, fi=target, b=backend, c=cache, o=options, h=handle: (
                    self._do_decode(sid, fi, b, c, o, h)
                ),
            )
            self._queue.put(job)

    def cancel(self, session_id: str) -> None:
        """Cancel all pending prefetch jobs for a session (on seek or close)."""
        with self._lock:
            self._generations[session_id] = self._generations.get(session_id, 0) + 1
            self._inflight.pop(session_id, None)
            self._stats["cancelled"] += 1

    def cancel_all(self) -> None:
        """Shutdown the scheduler cleanly."""
        self._shutdown = True
        # Drain queue
        while not self._queue.empty():
            try: self._queue.get_nowait()
            except: pass
        # Poison-pill each worker
        for _ in self._workers:
            self._queue.put(_PrefetchJob(priority=999999, session_id="__stop__",
                                         frame_index=-1))

    def stats(self) -> dict[str, Any]:
        with self._lock:
            return {**self._stats, "queueDepth": self._queue.qsize()}

    # ── Worker ────────────────────────────────────────────────────────────────

    def _worker_loop(self) -> None:
        while not self._shutdown:
            try:
                job = self._queue.get(timeout=1.0)
            except queue.Empty:
                continue

            if job.session_id == "__stop__":
                break

            # Check if cancelled (generation mismatch)
            with self._lock:
                current_gen = self._generations.get(job.session_id, 0)

            if job.generation != current_gen:
                with self._lock:
                    self._inflight.get(job.session_id, set()).discard(job.frame_index)
                self._queue.task_done()
                continue

            # Execute the decode
            try:
                if job.callback:
                    job.callback()
                with self._lock:
                    self._stats["completed"] += 1
                    self._inflight.get(job.session_id, set()).discard(job.frame_index)
            except Exception:
                with self._lock:
                    self._stats["errors"] += 1
                    self._inflight.get(job.session_id, set()).discard(job.frame_index)
            finally:
                self._queue.task_done()

    def _do_decode(self, session_id: str, frame_index: int,
                   backend: Any, cache: Any, options: dict,
                   handle: Any = None) -> None:
        """Decode one frame and write to cache (called from worker thread)."""
        key = cache.make_key(
            session_id, frame_index,
            options.get("quality", "half"),
            options.get("width",  1280),
            options.get("height",  720),
            options.get("format", "jpg"),
        )
        # Double-check — may have been cached by another path since we queued
        if cache.get(key) is not None:
            return

        try:
            result = backend.get_frame(handle, frame_index, options)
            data_url = result.get("dataUrl", "")
            if data_url and data_url.startswith("data:"):
                # Extract bytes from data URL for cache storage
                import base64
                _, b64 = data_url.split(",", 1)
                data = base64.b64decode(b64)
                fmt = options.get("format", "jpg")
                cache.put(key, data, session_id=session_id, fmt=fmt)
        except Exception:
            pass
