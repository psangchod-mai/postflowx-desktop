"""braw_backend's _save_frame() hardcoded PIL rawmode "RGBA" for BRAW frame
bytes (Iteration 81).

The BRAW SDK's IBlackmagicRawFrame::GetResourceType() call reports whether a
decoded frame is packed as RGBA or BGRA — this varies by platform/GPU. The
file already had a comment acknowledging this ("BRAW SDK returns BGRA or
RGBA depending on platform... Detect byte order: if it's BGRA swap R/B
channels") but the actual code unconditionally called
`Image.frombytes("RGBA", (w, h), data, "raw", "RGBA", bpr)`, silently
swapping red and blue channels on any platform/GPU where the SDK returns
BGRA. `_FRAME_GetResourceType` (vtable slot 6) was defined but never called
anywhere in the file, confirming the detection was never wired up.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.media.backends.braw_backend import (  # noqa: E402
    _raw_mode_for_resource_type,
    _BGRA_RESOURCE_TYPES,
)


def test_rgba_resource_type_uses_rgba_raw_mode():
    assert _raw_mode_for_resource_type(0) == "RGBA"


def test_bgra_resource_types_use_bgra_raw_mode():
    for resource_type in _BGRA_RESOURCE_TYPES:
        assert _raw_mode_for_resource_type(resource_type) == "BGRA"


def test_unknown_resource_type_defaults_to_rgba():
    assert _raw_mode_for_resource_type(999) == "RGBA"


def test_save_frame_picks_raw_mode_from_resource_type(tmp_path, monkeypatch):
    from postflowx_companion.media.backends import braw_backend as mod

    captured = {}

    class _FakeImage:
        @staticmethod
        def frombytes(mode, size, data, decoder, raw_mode, bpr):
            captured["raw_mode"] = raw_mode
            return _FakeImage()

        def resize(self, size, resample):
            return self

        def convert(self, mode):
            return self

        def save(self, path, fmt, **kwargs):
            with open(path, "wb") as f:
                f.write(b"fake")

        LANCZOS = 1

    monkeypatch.setitem(sys.modules, "PIL", type(sys)("PIL"))
    sys.modules["PIL"].Image = _FakeImage

    backend = mod.BrawBackend.__new__(mod.BrawBackend)
    w, h, bpr = 2, 2, 8
    data = bytes(range(16))
    out_path = tmp_path / "frame.jpg"

    bgra_type = next(iter(_BGRA_RESOURCE_TYPES))
    backend._save_frame((w, h, bpr, data, bgra_type), out_path, "jpg", w, h)
    assert captured["raw_mode"] == "BGRA"

    backend._save_frame((w, h, bpr, data, 0), out_path, "jpg", w, h)
    assert captured["raw_mode"] == "RGBA"
