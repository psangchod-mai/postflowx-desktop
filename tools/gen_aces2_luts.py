#!/usr/bin/env python3
"""Generate ACES 2.0 output-transform LUTs for PostFlowX (Dev Brief — ACES 2.0).

Why pre-baked: the user chose the "bake LUT → apply with bundled ffmpeg" path, so
the *runtime* needs only ffmpeg (no OCIO/numpy bundled). This script runs at BUILD
time on a dev machine that has PyOpenColorIO (OCIO 2.5+ ships the ACES 2.0 built-in
config). It emits, into assets/aces2_luts/:

  shaper_sdr.cube / shaper_hdr.cube   per-range 1D shapers (linear → log, lg2,
                              no channel crosstalk; HDR uses a wider range + more
                              points — see SHAPERS below)
  aces2_<id>.cube             one 3D cube per output transform (shaped → display),
                              built by sampling OCIO directly so it matches OCIO.

Apply at runtime (see color/aces2_luts.py — each transform names its shaper):
  ffmpeg -vf "lut1d=shaper_<dr>.cube:interp=linear,lut3d=aces2_<id>.cube:interp=tetrahedral"

Why a shaper+cube PAIR and not one .csp: ffmpeg's lut3d IGNORES a .csp prelut, which
lifts shadows / crushes highlights badly (measured ~28 code-value error). The 1D
shaper applied as a separate ffmpeg lut1d filter restores exact agreement (≤1–3 codes
vs OCIO). The 3D cube is sampled in the SHAPED domain so ffmpeg's linear cube
indexing lands on the perceptually-even lattice.

Usage:  python3 tools/gen_aces2_luts.py [--cube-size 33] [--config <builtin name>]

NOTE: SDR transforms are exact (highlights ≥ scene-1.0 clip to display max, matching
OCIO). HDR (PQ/HLG) transforms need scene values > 1.0, so the shaper there uses a
wider linear domain — see HDR entries below; treat HDR LUTs as preview-grade.
"""
from __future__ import annotations
import argparse, math, sys
from pathlib import Path

BUILTIN_CONFIG = "studio-config-v4.0.0_aces-v2.0_ocio-v2.5"
INPUT_SPACE = "ACES2065-1"

# Shaper = per-channel lg2(linear)→[0,1] 1D LUT, emitted with an explicit linear
# DOMAIN [0, 2^HI]. Hard-won rules (each was a bug):
#   • DOMAIN_MAX MUST be 2^HI — else ffmpeg lut1d clamps scene>1.0 to 1.0 and all
#     highlights collapse (~46-code error at scene 4.0).
#   • LO=-12 → cube black corner = OCIO(2^-12) ≈ 0, so blacks don't lift.
#   • HI / N1 trade highlight reach vs shadow resolution (uniform linear domain):
#     SDR clips ~scene 32 so HI=5 + N1=8192 resolves the toe (33^3 → |Δ|≤1).
#     HDR (PQ/HLG) needs scene up to ~256 (HI=8) AND fine darks → N1=65536 + 49^3
#     (|Δ|≤2 except the deepest near-black ~0.02 nits where ≤7/1023, invisible).
SHAPERS = {
    "sdr": {"lo": -12.0, "hi": 5.0, "n": 8192,  "file": "shaper_sdr.cube"},
    "hdr": {"lo": -12.0, "hi": 8.0, "n": 65536, "file": "shaper_hdr.cube"},
}

# Curated "minimal set" of ACES 2.0 output transforms to pre-bake.
# id -> {display, view, dr (shaper key), cube size}.
TRANSFORMS = {
    "rec709_sdr":       {"display": "Rec.1886 Rec.709 - Display", "view": "ACES 2.0 - SDR 100 nits (Rec.709)", "dr": "sdr", "cube": 33},
    "srgb_sdr":         {"display": "sRGB - Display",             "view": "ACES 2.0 - SDR 100 nits (Rec.709)", "dr": "sdr", "cube": 33},
    "p3d65_sdr":        {"display": "P3-D65 - Display",           "view": "ACES 2.0 - SDR 100 nits (P3 D65)",  "dr": "sdr", "cube": 33},
    "rec2100_pq_1000":  {"display": "Rec.2100-PQ - Display",      "view": "ACES 2.0 - HDR 1000 nits (P3 D65)", "dr": "hdr", "cube": 49},
    "rec2100_hlg_1000": {"display": "Rec.2100-HLG - Display",     "view": "ACES 2.0 - HDR 1000 nits (P3 D65)", "dr": "hdr", "cube": 49},
}


def _shape(lin, lo, hi):
    if lin <= 0.0:
        return 0.0
    x = (math.log2(lin) - lo) / (hi - lo)
    return 0.0 if x < 0 else (1.0 if x > 1 else x)


def _unshape(x, lo, hi):
    return 2.0 ** (x * (hi - lo) + lo)


def write_shaper(out_dir: Path, sh: dict) -> Path:
    lo, hi, n = sh["lo"], sh["hi"], sh["n"]
    dmax = 2.0 ** hi
    p = out_dir / sh["file"]
    with p.open("w") as f:
        f.write(f"# PFX ACES2.0 shaper lg2[{lo},{hi}] linear->log, DOMAIN [0,{dmax:g}]\n")
        f.write(f"LUT_1D_SIZE {n}\n")
        f.write(f"DOMAIN_MIN 0 0 0\nDOMAIN_MAX {dmax:g} {dmax:g} {dmax:g}\n")
        for i in range(n):
            s = _shape(i / (n - 1) * dmax, lo, hi)
            f.write(f"{s:.6f} {s:.6f} {s:.6f}\n")
    return p


def write_cube(ocio, cfg, out_dir: Path, lut_id: str, t: dict) -> Path:
    sh = SHAPERS[t["dr"]]
    lo, hi, size = sh["lo"], sh["hi"], t["cube"]
    dvt = ocio.DisplayViewTransform(src=INPUT_SPACE, display=t["display"], view=t["view"])
    cpu = cfg.getProcessor(dvt).getDefaultCPUProcessor()
    p = out_dir / f"aces2_{lut_id}.cube"
    with p.open("w") as f:
        f.write(f"# PFX ACES 2.0 | {t['display']} | {t['view']} | shaped lg2[{lo},{hi}]\n")
        f.write(f"LUT_3D_SIZE {size}\n")
        for b in range(size):          # .cube order: red varies fastest
            for g in range(size):
                for r in range(size):
                    # CPUProcessor.applyRGB(list) RETURNS the transformed values —
                    # it does NOT mutate the list. Using the input list after the
                    # call yields an identity LUT (silent, dangerous).
                    rgb = cpu.applyRGB([_unshape(r / (size - 1), lo, hi),
                                        _unshape(g / (size - 1), lo, hi),
                                        _unshape(b / (size - 1), lo, hi)])
                    f.write("%.6f %.6f %.6f\n" % tuple(
                        0.0 if v < 0 else (1.0 if v > 1 else v) for v in rgb))
    return p


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=BUILTIN_CONFIG)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "assets" / "aces2_luts"))
    args = ap.parse_args()

    try:
        import PyOpenColorIO as ocio
    except Exception as exc:
        print(f"ERROR: PyOpenColorIO not available (build-time only dep): {exc}", file=sys.stderr)
        return 2

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    cfg = ocio.Config.CreateFromBuiltinConfig(args.config)

    for key, sh in SHAPERS.items():
        sp = write_shaper(out_dir, sh)
        print(f"shaper  -> {sp.name}  ({sh['n']} pts, lg2[{sh['lo']},{sh['hi']}], {key})")
    for lut_id, t in TRANSFORMS.items():
        cp = write_cube(ocio, cfg, out_dir, lut_id, t)
        print(f"cube    -> {cp.name}  [{t['dr']} {t['cube']}^3 | {t['view']}]")
    print(f"done: {out_dir}  (config: {args.config})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
