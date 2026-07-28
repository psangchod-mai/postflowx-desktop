"""Regression test for proxy_service._proxy_cache_path identity collision.

Bug: _proxy_cache_path's clean_target reuse condition included
`or not clean_sidecar`, treating "no sidecar on disk" as safe-to-reuse. But
_proxy_target_stem is derived only from the CPL's display name/title, not from
any content-identity hash, so two entirely different projects (different
folder + different CPL) can produce the same stem and therefore the same
clean_target path. If that path already held a file from another project
whose sidecar was missing/unreadable (crash mid-encode, disk-full sidecar
write, or a legacy proxy that predates sidecars), the old code handed back
that same shared path for the new project too -- letting one project's encode
silently overwrite another project's proxy file, or (depending on
_proxy_cache_is_valid's quality check) silently serve someone else's video.

Fixed by dropping `or not clean_sidecar`: a missing/unreadable sidecar now
means "identity unknown", so the code falls through to the folder+cpl-keyed
path instead of reusing the ambiguous clean_target.
"""
from pathlib import Path


def test_missing_sidecar_does_not_reuse_foreign_clean_target(tmp_path):
    from postflowx_companion.proxy_service import _proxy_cache_path

    cpl_data = {"contentTitle": "Reel1"}

    folder_a = tmp_path / "project_a"
    folder_a.mkdir()
    cpl_a = folder_a / "cpl.xml"
    cpl_a.write_text("<CompositionPlaylist/>", encoding="utf-8")

    folder_b = tmp_path / "project_b"
    folder_b.mkdir()
    cpl_b = folder_b / "cpl.xml"
    cpl_b.write_text("<CompositionPlaylist/>", encoding="utf-8")

    out_dir = tmp_path / "proxy_cache"
    out_dir.mkdir()

    # Project A's first call: clean_target doesn't exist yet, so it is granted
    # the shared display-name path.
    path_a = _proxy_cache_path(folder_a, cpl_a, out_dir=str(out_dir), cpl_data=cpl_data)
    assert path_a == out_dir / "Reel1_proxy.mp4"

    # Simulate project A's encode leaving a file behind with no sidecar (e.g.
    # the process crashed before _write_proxy_sidecar ran).
    path_a.write_bytes(b"\x00" * 32)
    assert not (out_dir / "Reel1_proxy.json").exists()

    # Project B has a different folder + CPL but happens to share the same
    # display title, so it produces the same stem/clean_target.
    path_b = _proxy_cache_path(folder_b, cpl_b, out_dir=str(out_dir), cpl_data=cpl_data)

    # Must NOT be handed project A's ambiguous file -- it should get its own
    # folder+cpl-keyed path instead.
    assert path_b != path_a
    assert path_b.name.startswith("Reel1_proxy__")


def test_matching_sidecar_still_reuses_clean_target(tmp_path):
    """Confirms the fix doesn't regress the legitimate same-project reuse case."""
    from postflowx_companion.proxy_service import _proxy_cache_path, _write_proxy_sidecar

    cpl_data = {"contentTitle": "Reel1"}
    folder = tmp_path / "project_a"
    folder.mkdir()
    cpl = folder / "cpl.xml"
    cpl.write_text("<CompositionPlaylist/>", encoding="utf-8")

    out_dir = tmp_path / "proxy_cache"
    out_dir.mkdir()

    path_first = _proxy_cache_path(folder, cpl, out_dir=str(out_dir), cpl_data=cpl_data)
    path_first.write_bytes(b"\x00" * 32)
    _write_proxy_sidecar(path_first, folderPath=str(folder), cplPath=str(cpl))

    path_again = _proxy_cache_path(folder, cpl, out_dir=str(out_dir), cpl_data=cpl_data)
    assert path_again == path_first
