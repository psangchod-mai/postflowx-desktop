"""
Minimal AAF write+read test for PostFlowX.
Writes aaf_export_test.aaf, reopens it, confirms validity.
Returns dict: {ok, path, error}
"""
from __future__ import annotations

import os
import sys
from pathlib import Path


def _vendor_path() -> str:
    """Return companion/src so bundled aaf2 is always found."""
    here = Path(__file__).resolve()
    return str(here.parent.parent.parent)  # companion/src/


def _ensure_aaf2():
    vp = _vendor_path()
    if vp not in sys.path:
        sys.path.insert(0, vp)
    import aaf2
    return aaf2


def test_write_aaf() -> dict:
    """Write a minimal valid AAF file, reopen it, return status."""
    log_lines = []

    def log(msg):
        log_lines.append(msg)

    try:
        aaf2 = _ensure_aaf2()
        log(f"pyaaf2 import OK  version={getattr(aaf2, '__version__', 'unknown')}")
    except ImportError as e:
        return {"ok": False, "error": f"pyaaf2 not found: {e}", "log": [str(e)]}

    # Output path
    support_dir = Path(os.path.expanduser(
        "~/Library/Application Support/PostFlowX/tests"
    ))
    support_dir.mkdir(parents=True, exist_ok=True)
    out_path = support_dir / "aaf_export_test.aaf"
    log(f"write path: {out_path}")

    # ── Write ────────────────────────────────────────────────────────────────
    try:
        with aaf2.open(str(out_path), "w") as f:
            storage = f.content

            # Composition mob
            comp_mob = f.create.MasterMob("PFX_Test_Composition")
            storage.mobs.append(comp_mob)

            # Timecode slot (24fps, 1 second)
            fps = 24
            timecode_slot = comp_mob.create_timeline_slot(edit_rate=fps)
            tc = f.create.Timecode(fps, drop=False)
            tc["Start"].value = 0
            tc["Length"].value = fps  # 1 second
            timecode_slot.segment = tc
            timecode_slot.name = "TC_Slot"
            log("timecode slot created")

            # Audio placeholder slot
            audio_slot = comp_mob.create_timeline_slot(edit_rate=fps)
            filler = f.create.Filler()
            filler.media_kind = "Sound"
            filler["Length"].value = fps
            audio_slot.segment = filler
            audio_slot.name = "Audio_Slot"
            log("audio filler slot created")

            # Source mob with one tape slot (referenced media)
            src_mob = f.create.SourceMob()
            src_mob.name = "PFX_Test_Source"
            tape_desc = f.create.TapeDescriptor()
            src_mob.descriptor = tape_desc
            storage.mobs.append(src_mob)
            log("source mob created")

        log(f"write OK: {out_path}")
    except Exception as e:
        return {"ok": False, "path": str(out_path), "error": f"write failed: {e}", "log": log_lines}

    # ── Reopen ───────────────────────────────────────────────────────────────
    try:
        with aaf2.open(str(out_path), "r") as f:
            mob_count = sum(1 for _ in f.content.mobs)
        log(f"reopen OK: {mob_count} mobs")
        if mob_count < 1:
            raise ValueError("No mobs found in reopened file")
    except Exception as e:
        return {"ok": False, "path": str(out_path), "error": f"reopen failed: {e}", "log": log_lines}

    return {
        "ok": True,
        "path": str(out_path),
        "mobCount": mob_count,
        "log": log_lines,
    }


if __name__ == "__main__":
    import json
    result = test_write_aaf()
    print(json.dumps(result, indent=2))
