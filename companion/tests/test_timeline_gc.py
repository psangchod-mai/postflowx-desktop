"""Tests for the preview-timeline GC predicate (scratch-project cleanup).

Locks which Resolve timeline names are treated as throwaway PostFlowX preview
scratch timelines (safe to garbage-collect), so the sweep never deletes a real
user timeline.
"""
from postflowx_companion.api import _is_preview_timeline_name


def test_flags_preview_scratch_timelines():
    assert _is_preview_timeline_name("pfx_still_a1b2c3")          # api path
    assert _is_preview_timeline_name("PFX_Preview_1719500000")    # resolve_bridge path
    assert _is_preview_timeline_name("pfx_preview_123")
    assert _is_preview_timeline_name("PFX_STILL_XYZ")             # case-insensitive


def test_never_flags_user_timelines():
    for nm in ["Timeline 1", "BLR23 Main", "A001L001 conform", "Master",
               "pfxellowstone", "my_pfx_still_notes", "", None]:
        assert not _is_preview_timeline_name(nm), nm
