"""color_lut.py's _write_cube() nested its loops with Blue varying fastest
(for ri: for gi: for bi:) instead of the .cube format's Red-fastest
convention (Iteration 84).

The .cube spec (and ffmpeg's lut3d filter that consumes it) requires the 3D
lattice to be written with R varying fastest, then G, then B. The sibling
generator tools/gen_aces2_luts.py's write_cube() gets this right (validated
directly against OCIO) but color_lut.py's independent implementation had the
axes backwards, silently swapping red and blue in every IDT LUT used by the
VFX Pull / EXR render path (api.py's -vf lut3d=... filter chain).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from postflowx_companion.color_lut import _write_cube  # noqa: E402


def _identity(r, g, b):
    return r, g, b


def _read_data_rows(path):
    rows = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line[0].isalpha() or line[0] == "#":
                continue
            rows.append(tuple(float(x) for x in line.split()))
    return rows


def test_red_varies_fastest_in_written_cube(tmp_path):
    size = 3
    path = str(tmp_path / "identity.cube")
    _write_cube(path, "identity", _identity, size=size)
    rows = _read_data_rows(path)
    assert len(rows) == size ** 3

    # Row 0 is (r=0,g=0,b=0). Row 1 must differ only in R (fastest axis) --
    # if B were fastest instead, row 1 would be (0,0,0.5).
    assert rows[0] == (0.0, 0.0, 0.0)
    assert rows[1] == (0.5, 0.0, 0.0)
    assert rows[2] == (1.0, 0.0, 0.0)

    # After a full R cycle (3 rows), G should increment while R resets.
    assert rows[3] == (0.0, 0.5, 0.0)

    # After a full R*G cycle (9 rows), B should increment while R,G reset.
    assert rows[9] == (0.0, 0.0, 0.5)
