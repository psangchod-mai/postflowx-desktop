"""
Apple Vision OCR engine — uses macOS's built-in VNRecognizeTextRequest.

VNRecognizeTextRequest is dramatically more accurate than Tesseract on small,
low-contrast slate burn-ins (the failure case for VFX shot-name OCR). It runs
fully on-device, requires no API key, and has no per-call cost.

Public API
==========

recognize_text(png_bytes, *, recognition_level="accurate", language_list=None,
               minimum_text_height=0.0) -> dict

    Returns a JSON-serialisable dict:
        {
          "ok":          bool,
          "engine":      "apple-vision",
          "available":   bool,     # False on non-macOS or when PyObjC missing
          "rawText":     str,      # newline-joined text from all observations
          "results":     [ {text, confidence, bbox: [x, y, w, h]} ],
          "error":       str | None,
        }

On non-macOS hosts or when PyObjC isn't installed, returns available=False
without raising so the JS side can fall through to Tesseract.
"""

from __future__ import annotations

import base64
import platform
from typing import Any


def _is_macos() -> bool:
    return platform.system() == "Darwin"


def _load_vision():
    """Import the Vision framework lazily. Returns (Vision, Quartz, CoreGraphics) or None."""
    try:
        import Vision  # type: ignore
        import Quartz  # type: ignore
        import CoreGraphics  # type: ignore  # noqa: F401
        return Vision, Quartz
    except Exception:
        return None


def is_available() -> bool:
    """Quick capability probe — used by callers to decide whether to bother."""
    if not _is_macos():
        return False
    return _load_vision() is not None


def recognize_text(
    png_bytes: bytes,
    *,
    recognition_level: str = "accurate",
    language_list: list[str] | None = None,
    minimum_text_height: float = 0.0,
) -> dict[str, Any]:
    """Run Apple Vision text recognition on a PNG image buffer.

    Args:
        png_bytes:           Raw PNG file bytes.
        recognition_level:   "accurate" (slower, default) or "fast".
        language_list:       Optional list of BCP-47 codes (e.g. ["en-US"]).
                             Default lets Vision auto-detect.
        minimum_text_height: 0–1, fraction of image height. Filters out
                             unreasonably small detections. 0 = no filter.
    """
    if not png_bytes:
        return {
            "ok": False,
            "engine": "apple-vision",
            "available": _is_macos() and _load_vision() is not None,
            "rawText": "",
            "results": [],
            "error": "Empty image buffer",
        }

    if not _is_macos():
        return {
            "ok": False,
            "engine": "apple-vision",
            "available": False,
            "rawText": "",
            "results": [],
            "error": "Apple Vision is only available on macOS",
        }

    loaded = _load_vision()
    if loaded is None:
        return {
            "ok": False,
            "engine": "apple-vision",
            "available": False,
            "rawText": "",
            "results": [],
            "error": "PyObjC Vision/Quartz bindings not installed",
        }
    Vision, Quartz = loaded

    try:
        # Build a CGImageRef from the PNG bytes via CGImageSourceCreateWithData.
        # NSData wraps the bytes without copying; CGImageSourceCreateWithData is
        # the canonical zero-allocation path for raw image buffers.
        try:
            from Foundation import NSData  # type: ignore
        except Exception as exc:
            return {
                "ok": False,
                "engine": "apple-vision",
                "available": False,
                "rawText": "",
                "results": [],
                "error": f"Foundation/NSData unavailable: {exc}",
            }

        nsdata = NSData.dataWithBytes_length_(png_bytes, len(png_bytes))
        source = Quartz.CGImageSourceCreateWithData(nsdata, None)
        if source is None:
            return {
                "ok": True,
                "engine": "apple-vision",
                "available": True,
                "rawText": "",
                "results": [],
                "error": "CGImageSourceCreateWithData returned None — invalid PNG?",
            }
        cg_image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None)
        if cg_image is None:
            return {
                "ok": True,
                "engine": "apple-vision",
                "available": True,
                "rawText": "",
                "results": [],
                "error": "CGImageSourceCreateImageAtIndex returned None",
            }

        # Build and configure the recognition request
        request = Vision.VNRecognizeTextRequest.alloc().init()
        # Recognition level: 1 = accurate, 0 = fast (constants are sometimes named
        # VNRequestTextRecognitionLevelAccurate but the int values are stable)
        level_int = 1 if recognition_level == "accurate" else 0
        try:
            request.setRecognitionLevel_(level_int)
        except Exception:
            pass
        # Enable language correction — Vision applies a small NLP correction pass
        try:
            request.setUsesLanguageCorrection_(True)
        except Exception:
            pass
        if language_list:
            try:
                request.setRecognitionLanguages_(list(language_list))
            except Exception:
                pass
        if minimum_text_height and minimum_text_height > 0:
            try:
                request.setMinimumTextHeight_(float(minimum_text_height))
            except Exception:
                pass

        # Run the request through an image handler
        handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
            cg_image, None
        )
        success, err = handler.performRequests_error_([request], None)
        if not success:
            return {
                "ok": False,
                "engine": "apple-vision",
                "available": True,
                "rawText": "",
                "results": [],
                "error": f"performRequests failed: {err}",
            }

        observations = list(request.results() or [])
        out_results: list[dict[str, Any]] = []
        lines: list[str] = []
        for obs in observations:
            try:
                top_candidate = obs.topCandidates_(1)
                if not top_candidate or top_candidate.count() == 0:
                    continue
                cand = top_candidate.objectAtIndex_(0)
                text = str(cand.string() or "")
                if not text:
                    continue
                try:
                    confidence = float(cand.confidence())
                except Exception:
                    confidence = 0.0
                # Normalized bounding box in Vision's coordinate system
                # (origin bottom-left, 0–1 range). Convert to top-left origin
                # to match the rest of PFX's image conventions.
                try:
                    bbox = obs.boundingBox()
                    bx = float(bbox.origin.x)
                    by = float(bbox.origin.y)
                    bw = float(bbox.size.width)
                    bh = float(bbox.size.height)
                    # Flip Y to top-left origin
                    by_top = max(0.0, 1.0 - by - bh)
                    bbox_out = [bx, by_top, bw, bh]
                except Exception:
                    bbox_out = [0.0, 0.0, 1.0, 1.0]

                out_results.append({
                    "text": text,
                    "confidence": confidence,
                    "bbox": bbox_out,
                })
                lines.append(text)
            except Exception:
                # Skip individual observation failures; keep processing the rest
                continue

        return {
            "ok": True,
            "engine": "apple-vision",
            "available": True,
            "rawText": "\n".join(lines),
            "results": out_results,
            "error": None,
        }

    except Exception as exc:
        return {
            "ok": False,
            "engine": "apple-vision",
            "available": True,
            "rawText": "",
            "results": [],
            "error": str(exc),
        }


def recognize_text_b64(image_base64: str, **kwargs: Any) -> dict[str, Any]:
    """Convenience: decode a base64 PNG (with or without data URL prefix) and call recognize_text."""
    if not image_base64:
        return recognize_text(b"", **kwargs)
    # Strip data URL prefix if present
    if "," in image_base64 and image_base64.lstrip().startswith("data:"):
        image_base64 = image_base64.split(",", 1)[1]
    try:
        png_bytes = base64.b64decode(image_base64)
    except Exception as exc:
        return {
            "ok": False,
            "engine": "apple-vision",
            "available": True,
            "rawText": "",
            "results": [],
            "error": f"Invalid base64 image: {exc}",
        }
    return recognize_text(png_bytes, **kwargs)
