from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class ErrorPayload:
    code: str
    message: str
    userMessage: str
    retryable: bool = False


@dataclass
class ResponseEnvelope:
    status: str
    apiVersion: str
    companionVersion: str
    data: dict[str, Any] | None = None
    error: ErrorPayload | None = None

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        if self.data is None:
            payload.pop("data", None)
        if self.error is None:
            payload.pop("error", None)
        return payload


@dataclass
class EngineDescriptor:
    id: str
    label: str
    kinds: list[str] = field(default_factory=list)
    ready: bool = True

