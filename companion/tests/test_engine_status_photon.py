"""check_all() Photon detection regression (Iteration 77).

Operator precedence bug: `A or B or C if cond else None` parses as
`(A or B or C) if cond else None` in Python, not `A or B or (C if cond
else None)`. That made the ~/bin/photon existence check gate the whole
PATH-based `shutil.which` fallback chain, so a Photon binary on PATH was
reported as "not found" whenever ~/bin/photon didn't happen to exist.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

from postflowx_companion.media_engine import engine_status


def test_photon_on_path_is_found_even_without_home_bin_fallback(tmp_path):
    fake_home = tmp_path / "home_without_bin_photon"
    fake_home.mkdir()

    def fake_which(name):
        return "/usr/local/bin/photon" if name == "photon" else None

    with patch.object(engine_status.shutil, "which", side_effect=fake_which), \
         patch.object(engine_status.Path, "home", return_value=fake_home):
        results = engine_status.check_all()

    assert results["Photon"]["available"] is True
    assert results["Photon"]["path"] == "/usr/local/bin/photon"


def test_photon_falls_back_to_home_bin_when_nothing_on_path(tmp_path):
    fake_home = tmp_path / "home_with_bin_photon"
    (fake_home / "bin").mkdir(parents=True)
    home_photon = fake_home / "bin" / "photon"
    home_photon.write_bytes(b"")

    with patch.object(engine_status.shutil, "which", return_value=None), \
         patch.object(engine_status.Path, "home", return_value=fake_home):
        results = engine_status.check_all()

    assert results["Photon"]["available"] is True
    assert results["Photon"]["path"] == str(home_photon)
