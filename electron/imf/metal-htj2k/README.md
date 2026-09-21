# metal-htj2k — Milestone 1: native Apple-Metal HTJ2K block decoder

Smallest end-to-end, Bash-verifiable slice of a from-scratch native HTJ2K
decoder: decode ONE HTJ2K **cleanup-pass (CUP)** codeblock on the GPU (Metal
compute) and prove it **bit-exact** against the OpenJPH oracle. No GUI, no DWT,
no colour, no renderer — this isolates the hardest component (the MEL / VLC /
UVLC / MagSgn HT block decoder) before anything else.

Standalone: nothing here is wired into `package.json` / electron-builder yet.

## Toolchain reality (this box)
- **No `xcrun metal`, no offline `metallib`** (Command Line Tools only, no
  Xcode). MSL therefore **cannot be precompiled** — `cup_decode.metal` is loaded
  as a source string and compiled **at runtime** via
  `[MTLDevice newLibraryWithSource:options:error:]` inside `m1_block_decode.mm`.
- Harness is a standalone arm64 ObjC++ (`.mm`) executable; deploy target 13.0.
- OpenJPH 0.26.0 provides the oracle (`ojph_compress` / `ojph_expand` CLIs) and,
  via `libopenjph.dylib`, the exported **scalar reference decoder**
  `ojph::local::ojph_decode_codeblock32` plus its initialized VLC/UVLC tables.

## Files
| file | role |
|---|---|
| `make_vectors.sh` | **M0**: generates the oracle test vectors with `ojph_compress` and round-trip-verifies them with `ojph_expand`. |
| `m1_block_decode.mm` | **M1** harness: codestream marker + packet-header parser (CPU front-end), OpenJPH scalar reference decode, and the Metal driver. |
| `cup_decode.metal` | Runtime-compiled MSL port of the OpenJPH HT **cleanup-pass** decoder (step 1 = MEL+VLC+UVLC, step 2 = MagSgn). |
| `build.sh` | `clang++` invocation (arm64, `-framework Metal -framework Foundation`, `-lopenjph`). |
| `validate.sh` | Runs the harness on every vector; prints PASS/FAIL per stage + overall. |
| `vectors/` | Generated: `*.raw` (input samples), `*.j2c` (codestream), `*.rt.raw` (round-trip), `*.coeff` (expected coefficients). |

## Reproduce
```bash
cd electron/imf/metal-htj2k
./make_vectors.sh     # M0: build + verify oracle vectors
./build.sh            # compile the harness
./validate.sh         # M1: CPU + GPU decode, bit-exact check vs oracle
```

## M0 — oracle
Each vector is a single-component image compressed with **exactly one codeblock,
no wavelet transform**, so decoded coefficients equal the input samples:
```
ojph_compress -i <name>.raw -o <name>.j2c \
  -num_decomps 0 -reversible true -block_size {H,W} \
  -dims {W,H} -num_comps 1 -signed true -bit_depth 16 -downsamp {1,1}
ojph_expand   -i <name>.j2c -o <name>.rt.raw
cmp <name>.raw <name>.rt.raw     # must be identical
```
`-num_decomps 0` + reversible 5/3 ⇒ no DWT ⇒ coefficient == sample. All vectors
round-trip **EXACT**.

**Why SIGNED raw and not PGM:** JPEG2000 DC-level-shifts *unsigned* samples
(`s − 2^(B-1)`). At B=16 an unsigned 0 maps to the extreme coefficient `−2^15`,
which OpenJPH does **not** round-trip losslessly (it decodes back as 0 — verified
during bring-up). With signed input there is no level shift, the codeblock
coefficient **is** the sample, and a zero sample is a genuine zero (insignificant)
coefficient — exactly what exercises the MEL significance-run path. The single
unrepresentable value `−32768` is simply avoided by the generators.

Vectors: `cb{64,32}_grad` (gradient + spikes + zero blocks), `cb{64,32}_rand`
(full-range pseudo-random + scattered zeros), `cb{64,32}_sparse` (mostly zeros →
long MEL zero-runs). All are **CUP-only** (see below).

## M1 — what is verified

### CPU front-end (marker + packet-header parser) — VERIFIED
`m1_block_decode.mm` parses SOC/SIZ/CAP/COD/QCD/SOT/SOD, derives `K_max`
(reversible: `num_bits + guard_bits` = 14 + 1 = 15 here), then decodes the single
packet header (inclusion tag-tree collapses to 1 node, zero-bitplane run,
num-passes code, Lblock, length bits — mirrors OpenJPH `precinct::parse`) to
recover the codeblock descriptor: `missing_msbs=14`, `num_passes=1`,
`pass_length[0]`, codeblock byte range. This parser is validated **independently**
by feeding its output to the reference decoder and matching the oracle.

### CPU reference decode — VERIFIED bit-exact on all 6 vectors
The descriptor + codeblock bytes are handed to OpenJPH's exported scalar
`ojph_decode_codeblock32`; the result is dequantized with the reversible
sign-magnitude transform (`mag = (v & 0x7FFFFFFF) >> (31 − K_max)`, sign from bit
31 — a direct port of `gen_rev_tx_from_cb32`). Bit-exact vs oracle on every
vector. This proves the front-end parsing is correct.

### Metal GPU decode — VERIFIED bit-exact on all 6 vectors
`cup_decode.metal` is a faithful MSL port of the OpenJPH cleanup-pass decoder:
- **step 1** — MEL run decoder + reverse-growing VLC reader + context-modelled
  VLC (`vlc_tbl0/1`) and UVLC (`uvlc_tbl0/1`) → per-quad `{rho, u, e_1, e_k}`
  records in threadgroup scratch;
- **step 2** — forward-growing MagSgn reader → sign-magnitude coefficients,
  including the `emax`/`kappa` context for non-initial quad rows.

The MSL is **compiled at runtime** (confirmed working on Apple M4 Pro, 20-core
GPU). The exact `vlc_tbl0/1` / `uvlc_tbl0/1` tables are read from libopenjph and
uploaded as buffers, so the GPU uses tables bit-identical to the reference. For
M1 the kernel runs as a single thread in a single threadgroup
(**correctness first, not occupancy**). Output matches the oracle bit-exact.

### Actual result
```
OVERALL: PASS — CPU reference AND Metal GPU decoder are bit-exact vs the
OpenJPH oracle on all vectors.
```
(6/6: cb64/32 × grad/rand/sparse; each PASS on both `[CPU]` and `[GPU]`.)

## Honest status / limitations
- **CUP + SPP + MRP vector: NOT produced.** OpenJPH's `ojph_compress` emits a
  single HT cleanup pass per codeblock for **both** reversible and lossy settings
  (verified: `num_passes==1` in every case). The HT cleanup pass carries the full
  magnitude, so single-layer encoding never emits SigProp/MagRef passes, and the
  CLI exposes no quality-layer knob to force them. Consequently there is **no
  oracle** for the SPP/MRP paths with the available tooling. The exported CPU
  reference (`ojph_decode_codeblock32`) *does* contain SPP+MRP code, but the
  Metal kernel implements **CUP only** and SPP/MRP are **not** ported/tested.
- Single codeblock, single threadgroup, single thread — no parallelism yet.
- Reversible 5/3 only; no DWT/quantization/colour/multi-codeblock/tiling.
- The "CPU reference" is OpenJPH's own scalar function (linked), used to validate
  the front-end and cross-check the GPU. It is not an independent hand-rewrite;
  the Metal kernel is the from-scratch port (validated against it and the oracle).

## Next step (M2)
1. Parallelize the CUP kernel: split into `kCUP_S1` (MEL+VLC, inherently serial
   scan → keep on few lanes) and `kCUP_S2` (MagSgn, embarrassingly parallel per
   quad across a SIMD-group / threadgroup); many codeblocks → many threadgroups.
2. Port + test SPP/MRP — requires a non-OpenJPH oracle (e.g. Kakadu-encoded or a
   hand-built codestream) since `ojph_compress` won't emit multi-pass codeblocks.
3. Add the reversible 5/3 IDWT and multi-codeblock/subband assembly toward a full
   tile decode.

---

# Milestone 2 — decode a WHOLE frame on the GPU, bit-exact vs ojph_expand

M2 goes from one codeblock to a full multi-resolution frame: real multi-packet
parsing (tag-trees), parallel Metal block decode over all codeblocks, Metal
inverse 5/3 DWT, and Metal inverse RCT + DC shift.

## Files (M2)
| file | role |
|---|---|
| `make_vectors_m2.sh` | multi-decomposition oracle vectors (mono 512x512, non-power-of-2 640x360, 3-component RCT via 16-bit PPM, + a 9/7 lossy vector). |
| `m2_frame_decode.mm` | full-frame harness: parser, OpenJPH scalar block decode (CPU ref), **parallel Metal block decode**, CPU + **Metal** IDWT/colour, oracle compare. |
| `cup_decode_mt.metal` | parallel CUP block decoder — one threadgroup per codeblock, many threadgroups. |
| `idwt_color.metal` | Metal inverse 5/3 DWT (`kHorz`/`kVert`, bit-exact integer lifting) + inverse RCT/DC-shift (`kColor`). |
| `build_m2.sh`, `validate_m2.sh` | build + full-frame validation (CPU / GPU / GPU-FULL + falsification + M1 regression). |

## Reproduce (M2)
```bash
cd electron/imf/metal-htj2k
./make_vectors_m2.sh   # oracle vectors (round-trip EXACT for lossless)
./build_m2.sh
./validate_m2.sh       # full-frame PASS/FAIL, all modes + M1 regression
```

## Oracle (M2)
Multi-decomposition, many codeblocks across all subbands/levels, generated with
`ojph_compress -num_decomps 5 -reversible true` (default 64x64 codeblocks, HT).
For **lossless 5/3 the decoded frame == the input**, so the input file is the
full-frame oracle; `ojph_expand` round-trip (`cmp`) confirms each codestream is
valid (all M2 lossless vectors round-trip **EXACT**). The 3-component vector uses
a 16-bit PPM (`-colour_trans true`, RCT) because `ojph_compress` refuses colour
transform on raw/yuv input.

## Parser (M2) — real vs assumptions
Handles: SIZ (multi-component, signed/unsigned, bit depth), COD (decomps, code-
block size, MCT flag), QCD (per-subband reversible exponents → per-subband
`K_max`), SOT/SOD; **all resolution levels** (r0 LL; HL/LH/HH per level) with
correct JPEG2000 subband geometry (including non-power-of-2, partial codeblocks);
**real quad tag-trees** for both the inclusion and zero-bit-plane decoding, ported
from OpenJPH `precinct::parse`; the num-passes / Lblock / length codes; and the
**RPCL packet order** (resolution → precinct → component → layer), tracking a byte
cursor across packets with 0xFF bit-unstuffing. No hardcoded offsets — geometry
and Kmax are computed from the markers.
Assumptions (true for the vectors, stated honestly): single tile; one (maximal)
precinct per resolution → subband/codeblock origins are 0; single quality layer.
Multi-tile, multi-precinct partitioning, and non-zero origins are not exercised.

## Kernels & dispatch (M2)
- **`kCUP_mt`** (block decode): one **threadgroup per codeblock**, `N` threadgroups
  dispatched at once (70 for 512x512 mono, 210 for the RCT frame) → genuinely
  parallel across codeblocks on the 20-core GPU. Within a codeblock the verified
  M1 CUP scan runs in thread 0. Coded bytes are concatenated (each codeblock gets
  its own 16-byte zero prefix + pad); a descriptor array carries per-cb params.
- **`kHorz` / `kVert`** (IDWT): per resolution level, one thread per row then one
  thread per column, bit-exact integer 5/3 lifting (HORIZONTAL-then-VERTICAL,
  matching OpenJPH `resolution::pull_line`).
- **`kColor`**: one thread per pixel, inverse RCT (`G=Y-((Cb+Cr)>>2); R=Cr+G;
  B=Cb+G`) + DC level shift.
All MSL compiled at **runtime** (`newLibraryWithSource:`); no offline metallib.

## Results (M2) — actual PASS/FAIL
Modes: **CPU** (OpenJPH scalar decode + CPU IDWT/colour), **GPU** (parallel Metal
block decode + CPU IDWT/colour), **GPU-FULL** (block decode + IDWT + colour all on
GPU). Every vector is **FULL-FRAME BIT-EXACT** vs the oracle in all three modes:

| vector | what | CPU | GPU | GPU-FULL |
|---|---|---|---|---|
| m2_tiny  | 16x16  decomp2 mono | PASS | PASS | PASS |
| m2_small | 64x64  decomp3 mono | PASS | PASS | PASS |
| m2_mono  | 512x512 decomp5 mono (70 cbs) | PASS | PASS | PASS |
| m2_np2   | 640x360 decomp5 mono (non-pow2) | PASS | PASS | PASS |
| m2_rct   | 512x512 decomp5 3-comp RCT (210 cbs) | PASS | PASS | PASS |

Falsification: flipping a byte in the codestream makes GPU-FULL **stop passing**
(and produces identical CPU/GPU diffs), confirming the comparison exercises the
real GPU output, not a shortcut. M1 single-codeblock vectors still PASS
(regression).

## Honest status (M2)
- **Verified-working (bit-exact):** multi-packet/tag-tree parser; parallel GPU
  block decode; GPU 5/3 IDWT; GPU inverse RCT + DC shift → whole 5/3 frame
  bit-exact for **mono, non-power-of-2, and 3-component/RCT**. This is the M2
  must-hit target, on the GPU.
- **dequant + scatter of decoded codeblocks into subband buffers:** was host code
  here — **now a GPU kernel (`kScatter`), resident on the GPU. See Milestone 5.**
- **Not intra-block parallel yet:** each codeblock is decoded by one active thread
  (the serial HT scan). The requested `kCUP_S2` MagSgn SIMD split (~2 cols/lane)
  is a perf refinement, not done — correctness/parallelism-across-blocks first.
- **9/7 (irreversible): NOT implemented.** A `m2_97` vector is generated but the
  decoder only does reversible 5/3 (integer IDWT, reversible dequant, RCT). 9/7
  needs QCD u16 expounded dequant, float 9/7 lifting, and ICT — deferred.
- Single tile / single precinct-per-resolution / single layer (see parser notes).

## Next step (M3)
Reduced-resolution decode (`-skip_res`) + performance: move dequant/scatter into a
kernel, split `kCUP_S2` across a SIMD-group (2 cols/lane), fuse IDWT levels /
tile with halos, and add the 9/7 float path (PSNR-validated).

---

# Milestone 3 — 9/7 irreversible, reduced-resolution, performance

M3 adds the real IMF/DCI path (9/7), the realtime lever (reduced-resolution), and
performance measurement. Same harness (`m2_frame_decode`), same runtime-compiled
MSL. Pass string is `FRAME PASS`.

## Files (M3)
| file | role |
|---|---|
| `make_vectors_m3.sh` | 9/7 vectors (mono raw + ICT PPM), 2K & UHD 5/3 perf vectors. |
| `m2_frame_decode.mm` | +9/7 QCD(u16 expounded) parse, float dequant, `isyn97`/`idwtComponent97`, ICT, float→int convert; `--skip N` reduced-res; `--bench K` timing. |
| `idwt_color.metal` | +`kHorz97`/`kVert97` (float 9/7 lifting, K-scale+4 steps) + `kICT`. |
| `validate_m3.sh` | 9/7 PSNR + reduced-res (vs `ojph_expand -skip_res`) validation. |

Reproduce: `./make_vectors_m3.sh && ./build_m2.sh && ./validate_m3.sh`

## Part 1 — 9/7 irreversible (PSNR vs `ojph_expand`)
Oracle = the `ojph_expand` DECODE (`.rt.raw`/`.rt.ppm`), since 9/7 is lossy.
Commands: `ojph_compress -reversible false -num_decomps 5 ...` (mono raw; ICT via
16-bit PPM `-colour_trans true`), then `ojph_expand`.

| vector | mode | GPU-FULL PSNR | note |
|---|---|---|---|
| m3_97_tiny | mono 32x32 | 999 dB (mse=0) | bit-identical |
| m3_97_mono | mono 512x512 | 999 dB (mse=0) | bit-identical |
| m3_97_ict  | ICT 512x512 RGB | 133.3 dB (mse=2e-4) | a few LSB (float ICT order) |

**Threshold justification (60 dB):** we implement the *same* 9/7 math OpenJPH uses
(identical ATK lifting constants + K, identical expounded step-size dequant,
identical `round(x·2^bd)` output), so mono is bit-identical and the only deviation
is float non-associativity in the inverse ICT matrix (a handful of ±1 LSB) → 133 dB.
60 dB is a very conservative floor (achieved ≥133); anything near it would signal a
real bug. Verified on CPU, GPU (parallel block decode + CPU IDWT), and GPU-FULL
(Metal `kHorz97`/`kVert97`/`kICT`).

## Part 2 — reduced-resolution (`--skip N` vs `ojph_expand -skip_res N,N`)
Bit-exact (5/3) / PSNR (9/7), GPU-FULL, N=1 and N=2:

| vector | skip1 | skip2 |
|---|---|---|
| m2_mono 5/3 | FRAME PASS (bit-exact) | FRAME PASS (bit-exact) |
| m3_97_mono 9/7 | 999 dB | 999 dB |

Work is genuinely skipped (evidence printed, e.g. `[skip ] decoding 22 of 70
codeblocks`). The decode dispatch and IDWT now only touch retained levels.

## Part 3 — performance (Apple M4 Pro, 20-core GPU; warm avg, MSL compiled once)
`--bench K` times the GPU pipeline only (never the CPU reference on large frames).
"total" = block-decode + IDWT/colour + buffer upload/readback + CPU dequant/scatter
glue. Baseline = before the reduced-res dispatch-skip; after = with it.

| case | ms/frame | fps | ≥24 fps? |
|---|---|---|---|
| 2K (2048x1080) full | 20.9 | 47.8 | yes |
| 2K skip1 | 10.6 | 94.8 | yes |
| 2K skip2 | 6.2 | 160 | yes |
| UHD (3840x2160) full | 47.3 | 21.1 | **no** (close) |
| UHD skip1 (baseline) | 32.2 | 31.1 | yes |
| UHD skip1 (after skip-dispatch) | 20.4 | 49.0 | yes |
| UHD skip2 (baseline) | 23.1 | 43.3 | yes |
| UHD skip2 (after skip-dispatch) | 8.6 | 116.8 | yes |

**Improvement landed:** reduced-res previously still *dispatched* every codeblock
(skip only happened at readback); now `decodeAllGPU` builds/dispatches only retained
levels → UHD skip1 31→49 fps, UHD skip2 43→117 fps. Full-res is unchanged (skip=0
dispatches all). Correctness re-validated after the change (M1/M2/M3 all PASS).

**Honest realtime status (as of M3 — SUPERSEDED; see Milestones 4 & 5 for current
numbers):** the M3 UHD figure of "21 fps" was later found to be measuring a **broken
IDWT kernel** (fixed-size thread arrays overflowed above 512 px — see M4). After the
M4 in-place IDWT fix and the M5 on-GPU dequant/scatter, **UHD full-res 5/3 is 29.9
fps** and 2K is 69 fps. Reduced-res is far above realtime.

## Status / next step (recorded at M3; see M4/M5 for updates)
- **Verified:** 9/7 mono bit-identical + ICT 133 dB (GPU-FULL); reduced-res N=1,2
  bit-exact(5/3)/999 dB(9/7) vs `-skip_res`; perf measured honestly; M1/M2 regressions PASS.
- **Since done:** on-GPU dequant/scatter **(landed in M5)**; large-frame IDWT
  correctness **(fixed in M4)**. Still open: `kCUP_S2` SIMD MagSgn split; 9/7 colour
  only via `-colour_trans` PPM (ICT), DCI XYZ / other NLTs untested; multi-tile /
  multi-precinct / multi-layer.
- **Next:** real IMF codestreams via an asdcplib front-end (MXF/JPEG2000 essence),
  and zero-copy IOSurface output for the renderer.

---

# Milestone 4 — UHD full-res performance (and a correctness bug it exposed)

Goal: UHD (3840x2160) full-res 5/3 decode to >=24 fps without breaking correctness.

## CRITICAL correctness fix (found while profiling)
The Metal inverse-DWT (`isyn53`/`isyn97`) used fixed thread-local arrays
`int L[512]` — but a 2K row is 1024 samples and a UHD row 1920 (half-widths
1024 / 1920 > 512). So **2K and UHD full-res GPU output was silently WRONG**
(millions of diffs); the M2/M3 validate scripts never caught it because they only
used <=640 px images (half-width <=320). Rewrote both `isyn53` and `isyn97` to lift
**in-place with no thread-local arrays** (updated low stored at even output
positions, read back for the predict step). This is correct for any size **and**
removes the 4 KB/thread copy, so it was also the biggest perf win. Added
2K + UHD full-res bit-exact checks to `validate_m3.sh` so this can't regress.

## Levers
1. **Cache IDWT pipelines** (was recompiling `idwt_color.metal` per frame): landed,
   correctness-neutral, ~0 ms gain (Metal already caches the compiled library).
2. **In-place IDWT rewrite** (above): landed — the decisive lever.
3. On-GPU dequant/scatter: **done in M5** (see below). SIMD-split `kCUP_S2`: still open.

## Perf at M4 (Apple M4 Pro, warm avg over 4 iters). Numbers are on the **corrected**
kernel (the prior M3 2K/UHD numbers measured the broken kernel and are void).
**NOTE: these were further improved in M5 (on-GPU dequant/scatter) — see the M5
table for current numbers (UHD full 29.9 fps, 2K full 69 fps).**

| case | ms/frame | fps | >=24? |
|---|---|---|---|
| 2K full | 16.9 | 59.3 | yes |
| UHD full | 41.1 | 24.3 | yes (thin margin — improved to 29.9 in M5) |
| UHD skip1 | 12.2 | 81.8 | yes |
| UHD skip2 | 5.0 | 198 | yes |

UHD full-res per-stage at M4: GPU block-decode 11.6 ms, IDWT/colour 20.1 ms,
dequant/scatter+buffers+readback ~9.4 ms. **The IDWT (not the block decode) is the
dominant cost.** M5 removed the ~9 ms CPU dequant/scatter round-trip (now a ~1.4 ms
GPU kernel); a coalesced/tiled vertical IDWT pass is the next lever.

## Honest status (at M4; superseded by M5)
- UHD full-res 5/3 met 24 fps at M4 (24.3, thin); **M5 raised it to 29.9 fps** with
  the on-GPU dequant/scatter. 2K = 69 fps. Reduced-res far above realtime.
- Correctness: M1, M2, M3 all OVERALL PASS, including 2K/UHD full-res bit-exact.
- Done since: on-GPU dequant/scatter (M5). Still open: `kCUP_S2` SIMD-group MagSgn
  split; coalesced/tiled vertical IDWT.
- **Next step:** tiled/coalesced IDWT for more headroom; then real IMF
  codestreams via an asdcplib front-end and zero-copy IOSurface output.

---

# Milestone 5 — on-GPU dequant/scatter (UHD full-res headroom)

Goal: give UHD full-res 5/3 comfortable margin over 24 fps by removing the
GPU→CPU→GPU round-trip between block-decode and IDWT.

## What landed
Added a Metal **dequant+scatter kernel** (`kScatter`, one threadgroup per
codeblock) that reads the block-decoder's sign-magnitude output and writes the
dequantized coefficients directly into a **GPU-resident** per-component subband
buffer (`gSubbandBuf`). The IDWT then reads those subbands in-place (via buffer
offsets) instead of the host uploading them. In `--gpu-full` mode the decoded
coefficients never leave the GPU; the previous CPU dequant/scatter (~6 ms) and the
subband re-upload are gone. `--gpu` (CPU-IDWT) mode still uses the CPU scatter,
unchanged.

Correctness preserved exactly: 5/3 stays bit-exact, 9/7 mono stays mse=0.

## Perf (Apple M4 Pro, warm avg of 4; total = full GPU pipeline)

| case | M4 (in-place IDWT) | M5 (+ on-GPU scatter) |
|---|---|---|
| 2K full | 16.9 ms / 59 fps | **14.5 ms / 69 fps** |
| UHD full | 41.1 ms / 24.3 fps | **33.4 ms / 29.9 fps** |
| UHD skip1 | 12.2 ms / 82 fps | 14.7 ms / 68 fps |
| UHD skip2 | 5.0 ms / 198 fps | 7.5 ms / 133 fps |

UHD full-res is now **29.9 fps — comfortably above 24** (was 24.3, thin). Per-stage
at UHD full: block-decode 11.0 ms, IDWT/colour 16.6 ms, GPU scatter ~1 ms (+ coded
buffer build/readback). The IDWT is still the largest stage; a coalesced/tiled
vertical pass is the next lever. (Reduced-res got marginally slower in absolute ms
because the resident buffer is allocated/zeroed for the full frame regardless of
skip; still far above realtime, so not worth special-casing yet.)

## Status / next step
- **Verified:** on-GPU dequant/scatter; M1/M2/M3 all OVERALL PASS (incl. 2K/UHD
  full-res bit-exact). UHD full-res 5/3 = 29.9 fps with margin; 2K = 69 fps.
- **Not done:** coalesced/tiled vertical IDWT (biggest remaining stage);
  `kCUP_S2` SIMD MagSgn split (decode is 11 ms, not the bottleneck — lower priority
  than the IDWT); allocate the resident buffer sized to retained levels for
  reduced-res.
- **Next (M6):** tiled/coalesced IDWT, then real IMF codestreams via an asdcplib
  front-end (MXF JPEG2000 essence) and zero-copy IOSurface output to the renderer.

---

# M5.1 — bug fix: reduced-resolution + reversible RCT colour

**Bug (HIGH, pre-existing):** `--rct --skip N` (3-component reversible RCT at reduced
resolution) decoded WRONG (~2.5% of pixels; e.g. first diff exp=0 got=-1944). CPU,
`--gpu`, and `--gpu-full` all failed identically → shared logic, not the GPU path.

**Root cause:** the reversible output path (`m2_frame_decode.mm` main, after inverse
RCT + DC level shift) never **clamped** samples to the component's representable
range. OpenJPH's file writers do (`ojph_img_io.cpp`: ppm/pgm clamp to `[0,2^bd-1]`,
raw-signed to `[-2^(bd-1),2^(bd-1)-1]`). At **full-res the reconstruction is lossless
so values are always in range** (clamp is a no-op — which is why it passed); at
**reduced-res the low-pass reconstruction, especially after inverse RCT, can exceed
range**, so the missing clamp produced negative/overflowed samples where OpenJPH
clamped. Mono-skip passed only because those values happened to stay in range and the
9/7 path already clamps in its float→int convert.

**Fix:** clamp every reconstructed component to `[0,2^bd-1]` (unsigned) /
`[-2^(bd-1),2^(bd-1)-1]` (signed) after reconstruction — covers CPU and GPU-full,
no-op at full-res / for 9/7. Now `--rct --skip 1/2` is **bit-exact** vs
`ojph_expand -skip_res N,N` (CPU and GPU-full).

**Coverage added** (this bug hid because reduced-res tests were mono-only):
`validate_m3.sh` Part 2 now also checks **3-component reversible RCT + skip 1/2
(bit-exact)** and **9/7 ICT + skip 1/2 (PSNR)**.

---

# Milestone 5 (real) — real IMF codestream structure (tile-parts / precincts / CPRL)

Extends the parser to handle the structure of REAL IMF codestreams (validated
against a Netflix "Meridian" HD frame), and proves the new paths decode
end-to-end on structure-matched HTJ2K vectors.

## Files
- `make_vectors_m5.sh` — mints HTJ2K vectors mirroring Meridian structure (CPRL,
  explicit precincts 128/256, 3 tile-parts, 5 decomps, 32x32 cb, 12-bit 3-comp
  colour) at 512x512 and 1920x1080, for both 5/3 RCT and 9/7 ICT.
- `validate_m5.sh` — (A) structural parse of a real Meridian frame; (B) end-to-end
  decode of the structure-matched vectors, full-res and reduced-res.
- `m2_frame_decode.mm` — parser rewrite (below) + `--parse-only` structural dump.

## Parser extensions (all three implemented, verified through full decode)
1. **Multi-tile-part concatenation** — enumerates ALL SOT/SOD segments (TNsot
   parts), concatenates each tile-part's post-SOD packet body into one logical
   stream, and parses packets across tile-part boundaries. (Meridian and the
   structure-matched vectors have 3 tile-parts.) **Working.**
2. **Explicit-precinct packet parsing** — reads Scod bit0 + SPcod PrecinctSize[]
   exponents, computes the precinct partition per resolution, and emits one packet
   per precinct with per-precinct inclusion + zero-bitplane tag-trees and a
   codeblock grid clipped to precinct∩subband (port of OpenJPH
   `subband::get_cb_indices`). **Working** (res5 of a 1080p frame = 40 precincts).
3. **Progression-order packet iteration** — reads the SGcod progression byte and
   iterates packets in the signalled order via OpenJPH's greedy "next precinct with
   smallest (y,x) image position" rule. **CPRL and RPCL fully working**; LRCP/RLCP
   and PCRL implemented the same way (RPCL/CPRL are the ones exercised + verified).
   Multi-layer not implemented (all test streams + Meridian are 1 layer).

## A. Real Meridian structural parse (`--parse-only`)
`ffmpeg -c:v copy -f image2` extracts a frame (`FF4F FF51 … FFD9`). Our parser
reports, all cross-checked against a manual marker walk and the scout's spec:

| field | parsed | matches |
|---|---|---|
| dims | 1920x1080 | yes |
| components / depth | 3 / 12-bit | yes |
| transform | 9/7 irrev, **CAP=no → Part-1 MQ** | yes |
| colour | ICT | yes |
| decomp levels | 5 | yes |
| codeblock | 32x32 | yes |
| tile-parts | 3 | yes |
| progression | CPRL | yes |
| precincts | res0 128x128, res1-5 256x256 | yes |
| per-res precinct counts | res3=2x2=4, res4=4x3=12, res5=8x5=40 | yes |

**Meridian PIXELS ARE NOT DECODED.** It is Part-1 MQ/EBCOT (no CAP marker); our
decoder is HTJ2K-only. This is *structural* validation of the parser only — the
`--parse-only` mode explicitly stops before packet-body parsing for such streams.

## B. Structure-matched HTJ2K end-to-end (these DO decode)
`ojph_compress -prog_order CPRL -precincts {128,128},{256,256}x5 -num_decomps 5
-block_size {32,32} -tileparts C -colour_trans true` on 12-bit 3-comp images.
All **FRAME PASS**, GPU-FULL, full-res AND reduced-res (skip 1/2):

| vector | full-res | reduced-res |
|---|---|---|
| m5_rct 512 5/3 RCT | bit-exact | bit-exact (skip1/2) |
| m5_ict 512 9/7 ICT | 114.5 dB | ~115 dB (skip1/2) |
| m5_hd_rct 1920x1080 5/3 RCT | bit-exact | bit-exact (skip1/2) |
| m5_hd_ict 1920x1080 9/7 ICT | 114.5 dB | (available) |

The 1080p vectors exercise the exact Meridian precinct layout (40 precincts at
res5) through the full parse→decode→IDWT→colour pipeline. This proves tile-parts +
explicit precincts + CPRL work end-to-end, not just structurally.

## Status / next step
- **Verified:** multi-tile-part, explicit precincts, CPRL/RPCL — end-to-end
  bit-exact(5/3)/PSNR(9/7), full + reduced-res; real-Meridian structure parsed
  correctly. M1–M4 regressions all still OVERALL PASS.
- **Not done / honest:** Meridian pixels (needs a Part-1 MQ/EBCOT block decoder —
  a separate large effort); multi-layer progression; multi-tile (Meridian is single
  tile with 3 tile-parts, which IS handled); PCRL/LRCP/RLCP implemented but only
  RPCL+CPRL are test-exercised.
- **Next (M6):** either a Part-1 MQ decoder to decode Meridian's actual pixels, or
  zero-copy IOSurface output + app wiring for the HTJ2K path.

---

# Milestone 6a — wire into the PostFlowX app (feature flag, default OFF)

First milestone touching production app code. The native Metal HTJ2K decoder is
wired behind the `PFX_IMF_METAL_HTJ2K` env flag (default OFF ⇒ playback
byte-identical to before), routed through the existing UNSUPPORTED_HTJ2K seam.

## Files
- Harness `m2_frame_decode.mm`: added `--version`, `--ipc` persistent stdio mode
  (newline JSON, id-correlated: `ping`, `decode`), sample serialization (planar →
  interleaved integer at source bit depth, matching imf_j2k.js WASM shape:
  `pixelsType` u8/u16/i16, `sampleLayout:'interleaved'`), and an executable-dir /
  `$PFX_MSL_DIR` MSL path resolver (was cwd-dependent → broke packaged). CLI +
  validate modes unchanged.
- `build_native.sh` (new): builds the packaged helper to
  `electron/native/pfx_htj2k_metal/` (arm64, min 13.0), bundles libopenjph with an
  `@executable_path` rpath fix, ships the `.metal` kernels, ad-hoc re-signs.
- `electron/imf/imf_metal_htj2k_backend.js` (new): main-process bridge — persistent
  `--ipc` session, `checkAvailability`, `decodeCodestream(j2cPath)` (temp-file pixel
  channel → Buffer); CAP-absent ⇒ `NOT_HTJ2K`.
- `electron/imf/imf_frame_provider.js`: flagged sub-branch in the HTJ2K path (before
  the essence/WASM fallback) — extract `.j2c` → native decode → attach `samplesB64`
  + `metalFrameInfo` to the UNSUPPORTED_HTJ2K response. Any error/unavailable/
  CAP-absent ⇒ falls through unchanged.
- `src/scripts/modules/imf/imf_player.js`: in the UNSUPPORTED_HTJ2K handler, present
  `result.samplesB64`+`metalFrameInfo` directly via `_presentDecodedFrameGL`
  (skipping WASM); on any failure falls through to the existing WASM path.
- `package.json`: `build:metal-htj2k` script chained into `build:mac`/`build:mac-dir`;
  `electron/native/pfx_htj2k_metal/**` added to `asarUnpack`.

## IPC protocol + serialization (cross-checked vs WASM shape)
`ping → {id,ok,version,metal}`;
`decode{id,j2cPath,skip?} → {id,ok,width,height,componentCount,bitsPerSample,
isSigned,pixelsType,sampleLayout:'interleaved',path,byteLength}` or
`{id,ok:false,code:'NOT_HTJ2K'|'DECODE_FAILED'}`. Samples are interleaved integers
at the source bit depth (u16/i16 little-endian, or u8) — the exact contract
`imf_gl_present.js` requires and the shape `imf_j2k.js` produces. Verified
**bit-exact** vs `ojph_expand` (5/3 RCT, interleaved u16).

## Packaging proof
`otool -L` of the packaged helper shows **no `/opt/homebrew`** dependency
(libopenjph → `@executable_path`, rest system frameworks). It runs from a clean
env (`env -i PATH=/usr/bin:/bin`) with no Homebrew and no `DYLD_LIBRARY_PATH`,
resolving MSL via its executable dir. (See `validate_m6.sh`.)

## Verification (headless, up to the renderer boundary)
- **Flag OFF = byte-identical:** the provider branch is `process.env
  .PFX_IMF_METAL_HTJ2K`-gated and only `require()`s the backend inside that branch;
  the renderer branch requires `samplesB64` (never set when OFF). Static-proven.
- **Helper `--ipc` decode:** bit-exact vs `ojph_expand`.
- **Backend module (Node):** `checkAvailability` finds the packaged binary;
  `decodeCodestream` returns bit-exact interleaved samples.
- **Part-1 fallback:** the real Meridian frame → `NOT_HTJ2K` (routes to existing
  path), confirmed via the backend.
- **Harness M1–M5 + M6 all OVERALL PASS.**

## Honest status / limits
- **In-app GUI playback is UNVERIFIED** — cannot drive the Electron GUI headlessly.
  Everything up to the renderer boundary (provider response shape, sample contract,
  presenter inputs) is verified; the actual on-screen frame must be user-tested
  (set `PFX_IMF_METAL_HTJ2K=1`, open a real HTJ2K IMF).
- **Self-wrapped HTJ2K MXF NOT produced:** `asdcp-wrap` on this machine fails
  "Filename not found" even on a valid Part-1 opj codestream (tool/build issue, not
  HTJ2K-specific), so a HTJ2K IMF MXF couldn't be minted here. The extract→decode
  chain is otherwise verified: bundled ffmpeg `-c:v copy` extraction proven on the
  real Meridian MXF, and the backend decodes a real ojph HTJ2K `.j2c` bit-exact —
  only the ffmpeg-demux-of-HTJ2K-MXF link is unproven for lack of such an asset.
- Pixel channel is a temp file (M6b = shared-memory ring).
- **Next (M6b):** shared-memory ring pixel channel; then real HTJ2K IMF asset test
  + in-app GUI verification.

---

# Milestone 6b — shared-memory ring pixel channel (flag OFF default)

Replaces M6a's per-frame temp file with a reusable mmap'd ring, removing per-frame
file create/write/read/unlink churn and providing the infrastructure for
decode-ahead. Flag stays default OFF; M6a guarantees preserved.

## Ring mechanism chosen (and why)
A **reusable mmap'd temp file** (`/tmp/pfx_htj2k_ring_<pid>_<gen>.bin`), N=4 slots,
`MAP_SHARED`. NOT POSIX `shm_open` because: macOS has no `/dev/shm` path (Node
cannot mmap a shm_open name without a native addon) and orphaned shm segments are a
known macOS leak. A plain mmap'd file is coherent across the helper (mmap-writes)
and Node (`fs.readSync` of the same file) via the unified buffer cache, needs no
native addon, and on crash leaves only a sweepable `/tmp` file — no persistent
segment leak.

**Torn-frame prevention:** each slot is `[u64 seq][u64 byteLength][payload]`. The
helper writes payload + byteLength, issues a memory barrier, then writes `seq`
**last** (another barrier). The reader checks `seq` (and byteLength) against the
value in the JSON reply before trusting the payload; a half-written slot has a
stale/mismatched seq and is rejected. In the current synchronous request/reply
path the JSON reply itself already implies the slot is complete; the seq check is
belt-and-suspenders for the async decode-ahead path.
**Resize race fix:** when the frame size grows the ring is recreated under a NEW
generation filename, so the Node reader (which keys its cached fd on the path)
always reopens the resized file and never reads a stale unlinked inode.

## Decode-ahead — STAGED (not landed)
The ring supports it (N slots, per-slot ready-seq, round-robin), but true
decode-ahead requires the app/provider to extract + submit the next K frames'
codestreams ahead of consumption (the helper only sees one `.j2c` path per
command). That is provider-level scheduling; deferred to keep M6b low-risk. When
landed it will be bounded by ring size (N=4) with back-pressure when full.

## Throughput (honest)
Backend decode loop, 1920×1080 5/3, 40 warm iters (Apple M4 Pro):
- ring:      ~30.7 fps  (1302 ms / 40)
- temp file: ~28.9 fps  (1384 ms / 40)
≈ **+6%**. The delta is modest because the dominant cost is the GPU decode itself
(~33 ms/frame) plus the base64 encode still required to cross the main→renderer IPC
(unchanged here — that's M6c/IOSurface territory). The ring removes per-frame file
lifecycle syscalls + fd/inode churn; the larger structural value is enabling
decode-ahead, not single-frame latency.

## Reduced-res wiring
The renderer preview-scale ladder (`_previewLowres()` → `lowres` reduce-level 0/1/2,
`_PREVIEW_LOWRES=2`) is now mapped to the decoder `--skip` level in the provider
metal branch. Verified bit-exact vs `ojph_expand -skip_res N,N` through the ring
backend: skip1 → 256×256, skip2 → 128×128 (5/3).

## Verification (headless; see `validate_m6.sh`)
- ring pixel channel **bit-exact** (5/3) and byte-identical to temp-file mode (9/7);
- torn-frame hammer: 40 rapid decodes, **0 torn**;
- reduced-res via ring **bit-exact vs -skip_res** (N=1,2);
- leak: ring **CLEANED** on graceful close (SIGTERM handler), and **SWEPT** after
  SIGKILL by the next helper start's stale-ring sweep (no lingering segments/files);
- flag OFF byte-identical; Part-1 (Meridian) → NOT_HTJ2K fallback intact;
- packaging still self-contained (`otool -L` no /opt/homebrew);
- harness M1–M5 + M6 all OVERALL PASS.

## Honest status / next
- Verified up to the renderer boundary. **In-app GUI playback remains
  user-verify-only** (cannot drive Electron GUI headlessly).
- Decode-ahead staged (ring-ready, scheduling deferred).
- **Next (M6c):** true zero-copy IOSurface output (removes the main→renderer base64
  copy — the remaining per-frame cost), and/or provider-level decode-ahead; plus a
  real HTJ2K IMF asset for end-to-end GUI verification.
