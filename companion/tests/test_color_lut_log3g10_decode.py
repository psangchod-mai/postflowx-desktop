"""color_lut.py's _log3g10_to_lin() used a made-up decode formula that
dropped RED's documented black-point offset entirely and mirrored the log
curve (with a sign flip) instead of using the documented linear extension
for negative values (Iteration 86).

RED's official white paper (915-0187 Rev-C, "White Paper on
REDWideGamutRGB and Log3G10") defines the decode as:
  V <  0: L = V/g - c
  V >= 0: L = (10^(V/a) - 1)/b - c
with a=0.224282, b=155.975327, c=0.01, g=15.1927. The old code omitted
"- c" in the positive branch and used -(10^(-V/a)-1)/b instead of V/g - c
for negative values, wrecking both midtone exposure and shadow/negative-log
handling in every RED Log3G10/IPP2 IDT LUT.
"""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.color_lut import _log3g10_to_lin  # noqa: E402


def test_log3g10_black_point_offset():
    # RED's spec defines V=0 as decoding to -c (the black-point offset),
    # not 0.0.
    assert math.isclose(_log3g10_to_lin(0.0), -0.01, rel_tol=1e-9)


def test_log3g10_eighteen_percent_grey():
    # RED's Log3G10 maps 18% grey to an encoded value of ~1/3.
    assert math.isclose(_log3g10_to_lin(1.0 / 3.0), 0.18000084954744758, rel_tol=1e-9)


def test_log3g10_negative_branch_uses_linear_extension():
    # Negative values decode via the linear extension L = V/g - c, not a
    # mirrored log curve.
    g, c = 15.1927, 0.01
    e = -0.05
    assert math.isclose(_log3g10_to_lin(e), e / g - c, rel_tol=1e-9)
