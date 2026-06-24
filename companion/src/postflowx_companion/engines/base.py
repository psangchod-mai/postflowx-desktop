from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass
class EngineContext:
    package_id: str | None = None
    cpl_id: str | None = None
    folder_path: str | None = None
    options: dict[str, Any] = field(default_factory=dict)


@dataclass
class EngineResult:
    ok: bool
    data: dict[str, Any] = field(default_factory=dict)
    error_code: str | None = None
    error_message: str | None = None
    user_message: str | None = None


class BaseEngine:
    engine_id = "base"
    label = "Base Engine"
    kinds: list[str] = []

    def describe(self) -> dict[str, Any]:
        return {
            "id": self.engine_id,
            "label": self.label,
            "kinds": list(self.kinds),
            "ready": self.is_ready(),
        }

    def is_ready(self) -> bool:
        return True

    def scan_package(self, context: EngineContext) -> EngineResult:
        return EngineResult(
            ok=False,
            error_code="ENGINE_UNSUPPORTED",
            error_message="scan_package not implemented",
            user_message="Package scanning is not available yet.",
        )

    def start_proxy_playback(self, context: EngineContext) -> EngineResult:
        return EngineResult(
            ok=False,
            error_code="ENGINE_UNSUPPORTED",
            error_message="start_proxy_playback not implemented",
            user_message="Proxy playback is not available yet.",
        )

