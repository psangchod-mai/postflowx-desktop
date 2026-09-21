from __future__ import annotations

from dataclasses import dataclass
import platform

from . import API_VERSION, COMPANION_VERSION


@dataclass(frozen=True)
class CompanionConfig:
    api_version: str = API_VERSION
    companion_version: str = COMPANION_VERSION
    product_name: str = "PostFlowX Companion"
    platform_name: str = platform.system().lower()

