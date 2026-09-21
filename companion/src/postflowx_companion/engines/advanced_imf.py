from __future__ import annotations

from .base import BaseEngine


class AdvancedImfEngine(BaseEngine):
    engine_id = "advanced-imf"
    label = "Advanced IMF Engine"
    kinds = ["playback", "proxy", "qc", "immersiveAudio", "prores"]

