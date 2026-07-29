"""export_nle_linked_aaf() MasterMob/CompositionMob StartPosition regression (Iteration 76).

The MasterMob's SourceClip already re-bases the SourceMob's file-relative
src_in offset to local frame 0 (its Sequence holds one component spanning
[0, src_dur)). The CompositionMob's SourceClip references that MasterMob and
must therefore start at local frame 0, not src_in again -- double-applying
src_in pushed every video event with a nonzero source in-point off its
MasterMob's valid [0, src_dur) range.
"""
from __future__ import annotations

import base64
import tempfile
from pathlib import Path

import pytest

from postflowx_companion.aaf_export import export_nle_linked_aaf, has_pyaaf2

pytestmark = pytest.mark.skipif(not has_pyaaf2(), reason="pyaaf2 not available")


def _build_payload(media_path):
    return {
        'fps': 25,
        'projectName': 'IterationSeventySix',
        'timelineStartFrame': 0,
        'events': [{
            'type': 'video',
            'reel': 'A001C002',
            'clipName': 'A001C002',
            'recIn': '00:00:00:00',
            'recOut': '00:00:04:00',
            'srcIn': '01:00:10:00',   # frame 90250 @ 25fps -- nonzero source in-point
            'srcOut': '01:00:14:00',  # frame 90350 -- src_dur = 100
            'assetPath': str(media_path),
        }],
        'options': {'mediaRoots': []},
    }


def test_composition_clip_starts_at_master_mob_local_zero(tmp_path):
    import aaf2

    media_path = tmp_path / 'A001C002.mov'
    media_path.write_bytes(b'\x00')  # only the path needs to resolve; not read

    result = export_nle_linked_aaf(_build_payload(media_path))
    assert result['status'] == 'ok', result

    raw = base64.b64decode(result['data']['bytesBase64'])
    with tempfile.NamedTemporaryFile(suffix='.aaf', delete=False) as tmp:
        tmp.write(raw)
        aaf_path = tmp.name

    try:
        with aaf2.open(aaf_path, 'r') as f:
            comp = next(m for m in f.content.mobs if m.name == 'IterationSeventySix')
            v1_seq = comp.slot_at(1).segment
            comp_clip = next(c for c in v1_seq.components if c.media_kind == 'Picture'
                              and c.mob is not None)

            # The regression: this used to be src_in (90250), which falls outside
            # the referenced MasterMob's valid local range [0, src_dur).
            assert comp_clip.start == 0

            mm = comp_clip.mob
            mm_clip = mm.slot_at(1).segment.components[0]
            # The MasterMob's own SourceClip is what carries the file-relative
            # src_in offset into the SourceMob -- that part was already correct.
            assert mm_clip.start == 90250
    finally:
        Path(aaf_path).unlink(missing_ok=True)
