"""color_lut.py's _clog2_to_lin() dropped Canon Log 2's 0.9 scene-reflectance
scale factor entirely and used a wrong branch-cutoff constant (-0.00218
instead of the code value where L = 0, 0.092864125), which meant real-world
code values almost always took the "positive" branch regardless of intent
(Iteration 87).

Canon's Canon Log 2 decode (per the "Canon Log Gamma Curves" white paper,
cross-checked against the widely-used colour-science library's
log_decoding_CanonLog2 reference implementation, converted from its
full-range domain into the legal-range domain used here) is:
  V >  0.092864125: L = 0.9 * (10^((V-0.092864125)/0.24136) - 1) / 87.099375
  V <= 0.092864125: L = -0.9 * (10^((0.092864125-V)/0.24136) - 1) / 87.099375
The old code omitted the leading 0.9 factor in both branches (making every
decoded value ~11% too bright) and used -0.00218 as the branch cutoff
instead of 0.092864125 (the point where L = 0), so real code values almost
never hit the intended negative branch.
"""
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.color_lut import _clog2_to_lin  # noqa: E402


def test_clog2_eighteen_percent_grey():
    # 18% grey (reflection) encodes to code value ~0.397866 per Canon's spec.
    v = 0.39786577438259785
    assert math.isclose(_clog2_to_lin(v), 0.17929687995696894, rel_tol=1e-9)


def test_clog2_decode_continuous_at_cut():
    eps = 1e-9
    below = _clog2_to_lin(0.092864125 - eps)
    above = _clog2_to_lin(0.092864125 + eps)
    assert math.isclose(below, above, abs_tol=1e-6)


def test_clog2_zero_linear_at_cut():
    assert math.isclose(_clog2_to_lin(0.092864125 + 1e-15), 0.0, abs_tol=1e-9)
