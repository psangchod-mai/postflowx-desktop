"""color_lut.py's _logc4_to_lin() used fabricated constants (2^14, 2^-4,
e*18-4) instead of the official ARRI LogC4 decode formula (Iteration 85).

The real ARRI LogC4 Specification (1 May 2022, also matched by OpenColorIO's
arri.generate reference implementation) decodes with constants derived from
a=(2^18-16)/117.45, b=(1023-95)/1023, c=95/1023, plus a piecewise linear
extension below V=0. The old formula was off by ~1500x at LogC4's documented
18%-grey code value (0.28), silently wrecking exposure in every ARRI Alexa 35
IDT LUT used by the VFX Pull / EXR render path.
"""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.color_lut import _logc4_to_lin  # noqa: E402


def test_logc4_18_percent_grey_decodes_correctly():
    # ARRI's spec documents LogC4 code value 0.28 as 18% grey (~0.18 linear).
    assert math.isclose(_logc4_to_lin(0.28), 0.18361188651480678, rel_tol=1e-9)


def test_logc4_decode_continuous_at_zero():
    eps = 1e-9
    below = _logc4_to_lin(-eps)
    above = _logc4_to_lin(eps)
    assert math.isclose(below, above, abs_tol=1e-6)


def test_logc4_max_code_value_matches_spec():
    assert math.isclose(_logc4_to_lin(1.0), 469.8, rel_tol=1e-9)
