from __future__ import annotations

from .base import BaseEngine


class InternalFastPathEngine(BaseEngine):
    engine_id = "internal-fastpath"
    label = "Internal Fast Path"
    kinds = ["playback", "proxy", "qc"]

