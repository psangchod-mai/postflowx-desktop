"""_ocf_write_files must confine renderer-supplied paths to outputDir.

request.files[].path comes from renderer-derived FDL/AMF/QC filenames (built
from shot/EDL/AAF-derived names) — the same untrusted-input class the sibling
_ocf_copy_exr_delivery treats via _safe_name_component/_confined_join. The
original guard here was a plain str.startswith(outputDir) check, which is not
a directory-boundary check: "/out-evil".startswith("/out") is True, so a path
like "../out-evil/x" resolves outside outputDir but still passes. Locks in the
fix (_confined_join, a real os.path.commonpath containment check).
"""
from __future__ import annotations

import os

from postflowx_companion.api import CompanionApi
from postflowx_companion.config import CompanionConfig


def _api() -> CompanionApi:
    # Bypass CompanionApi.__init__ (spins up an HTTP server + threads) — the
    # method under test only touches self.config via _ok()/_error().
    api = CompanionApi.__new__(CompanionApi)
    api.config = CompanionConfig()
    return api


def test_sibling_directory_traversal_is_rejected(tmp_path):
    output_dir = tmp_path / "ShowA"
    output_dir.mkdir()
    sibling_target = tmp_path / "ShowA-evil" / "evil.txt"

    result = _api()._ocf_write_files({
        "outputDir": str(output_dir),
        "files": [{"path": "../ShowA-evil/evil.txt", "content": "pwned"}],
    })

    assert result["data"]["written"] == []
    assert len(result["data"]["errors"]) == 1
    assert not sibling_target.exists()


def test_legitimate_relative_path_is_written(tmp_path):
    output_dir = tmp_path / "ShowA"
    output_dir.mkdir()

    result = _api()._ocf_write_files({
        "outputDir": str(output_dir),
        "files": [{"path": "QC/report.txt", "content": "hello"}],
    })

    assert result["data"]["errors"] == []
    written_path = output_dir / "QC" / "report.txt"
    assert written_path.exists()
    assert os.path.normpath(result["data"]["written"][0]) == os.path.normpath(str(written_path))
    assert written_path.read_text() == "hello"
