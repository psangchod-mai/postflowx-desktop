"""Path-traversal hardening for EXR/AMF delivery writes (audit, area: path traversal).

Covers the helpers that confine renderer-supplied shotName / outputPattern to the
chosen output directory so a crafted '../' name cannot write outside the pull.
"""
import os
import pytest

from postflowx_companion.api import (
    _safe_name_component,
    _confined_join,
    _safe_output_pattern,
)


def test_safe_name_component_passes_legit_names():
    assert _safe_name_component("SH010_PL01_v003") == "SH010_PL01_v003"
    assert _safe_name_component("A001C002") == "A001C002"


def test_safe_name_component_neutralizes_traversal_and_separators():
    # '/' and '\' become '_'; leading/trailing dots stripped → no usable '..' or sep
    assert "/" not in _safe_name_component("../../etc/passwd")
    assert "\\" not in _safe_name_component("..\\..\\win")
    assert _safe_name_component("..") == "item"          # pure traversal → fallback
    assert _safe_name_component("") == "item"
    assert _safe_name_component("a/b/c") == "a_b_c"


def test_confined_join_allows_inside(tmp_path):
    out = _confined_join(str(tmp_path), "SH010", "EXR_Files", "SH010")
    assert out.startswith(os.path.realpath(str(tmp_path)) + os.sep)


def test_confined_join_blocks_dotdot(tmp_path):
    with pytest.raises(ValueError):
        _confined_join(str(tmp_path), "..", "..", "evil")


def test_confined_join_blocks_absolute(tmp_path):
    # An absolute segment must not let the write escape the base.
    with pytest.raises(ValueError):
        _confined_join(str(tmp_path), "/etc/cron.d/evil")


def test_safe_output_pattern():
    assert _safe_output_pattern("shot_%04d.exr") == "shot_%04d.exr"
    assert _safe_output_pattern("../../x_%04d.exr") == "%04d.exr"   # traversal → safe default
    assert _safe_output_pattern("/abs/x_%04d.exr") == "%04d.exr"
    assert _safe_output_pattern("sub/x_%04d.exr") == "%04d.exr"
    assert _safe_output_pattern("") == "%04d.exr"
