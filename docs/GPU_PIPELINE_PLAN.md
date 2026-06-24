# PostFlowX — GPU / Hardware Acceleration Plan

Target hardware: **Apple M4 Pro** — 14 CPU cores (10P/4E), 20-core GPU, Metal 4, 48 GB unified memory, VideoToolbox.

Goal: maximise decode + display performance across all IMF/MXF essence types
(JPEG2000, ProRes, HTJ2K, H.264/HEVC) by moving work off the single-threaded CPU
path and onto VideoToolbox + Metal + multithreaded CPU.

---

## 1. Reality per codec (what hardware can actually do)

| Essence | HW decode on Apple Silicon? | Strategy |
|---|---|---|
| **ProRes** | ✅ VideoToolbox | Full hardware decode → IOSurface |
| **H.264 / HEVC** | ✅ VideoToolbox | Full hardware decode → IOSurface |
| **HTJ2K** | ⚠️ No HW block, but highly parallel | CPU multithread (OpenJPH) now; **Metal compute** decode later |
| **JPEG2000 (J2K)** | ❌ No HW decoder exists anywhere | Fast multithreaded CPU lib; GPU only for color/scale/HDR |

**Key constraint:** classic JPEG2000 EBCOT entropy decode is inherently serial per
code-block. There is no flag to "decode J2K on the GPU." The realistic win for J2K is
(a) a faster CPU library across P-cores and (b) moving the *color/scale/HDR* stage to
the GPU. HTJ2K (FBCOT) is far more parallel and is a genuine GPU-compute candidate.

For **every** codec, the color-management / HDR tone-map / scale / pixel-format stage
runs on the GPU (Metal / CoreImage). That alone is a large win since it is 100% CPU today.

---

## 2. Current state (what we found)

- `pfx_helper` (intended native IMF decoder: asdcplib + OpenJPEG + libplacebo GPU HDR)
  is **missing** from `electron/native/`. IMF falls back to slow ffmpeg/CLI.
  **Phase 0 finding (2026-06-24):** the `pfx_helper` C++ source under
  `electron/imf/pfx-helper/` was never compiled — it references APIs that do not
  exist: `libplacebo/metal/metal.h` (libplacebo has **no Metal backend**, only
  Vulkan/OpenGL), `OPJ_CODEC_HTJ2K` (absent in OpenJPEG 2.5), and AS-02 methods
  like `FillPictureDescriptor` that aren't in asdcplib 2.13. Rebuilding it is not
  a recompile but real development, and the libplacebo-Metal HDR premise is dead
  on arrival. **Decision:** defer pfx_helper to Phase 2 and implement native
  decode + GPU HDR in the Swift `PFXNativeMediaEngine` (which already links Metal +
  CoreImage + VideoToolbox + Accelerate) instead. In the meantime, asdcplib was
  built from source and `asdcp-test` + `opj_decompress` are installed, so the
  native **`asdcp+openjpeg` CLI decode path (Backend B) is now functional** —
  frame-accurate CPU J2K decode without ffmpeg.
- Bundled ffmpeg has the **software** `jpeg2000` decoder only — **no libopenjpeg, no IMF
  demuxer, no `-hwaccel`** in any command. IMF decode is fully CPU, single pipeline.
- VideoToolbox is only used on the AVFoundation "OCF still" path — never for IMF/MXF.
- Frames are delivered to the renderer as **PNG → base64 → IPC**, which burns CPU and
  memory and janks the main thread.
- Scrubbing fires unbounded concurrent decode processes with no cancel/cap (see freeze
  diagnosis) — this must be fixed first or no pipeline change will feel smooth.

---

## 3. Target architecture

A single **persistent native media service** (Swift — extend `PFXNativeMediaEngine`,
which already links Metal, VideoToolbox, CoreImage, Accelerate) owns decode + GPU
processing and hands the renderer ready-to-display frames.

```
 Renderer (Electron)
    │  open/seek/play/requestFrame  (IPC, latest-wins)
    ▼
 PFXNativeMediaEngine  (persistent, one session per clip)
    ├─ Decode layer
    │    ProRes / H264 / HEVC ─→ VideoToolbox ─→ CVPixelBuffer (IOSurface)
    │    JPEG2000             ─→ multithread CPU lib ─→ buffer ─→ Metal texture
    │    HTJ2K                ─→ OpenJPH CPU now / Metal compute later
    ├─ GPU process layer (Metal / CoreImage)
    │    color convert · HDR tone-map (PQ/HLG) · scale · pixel format
    ├─ Frame cache (LRU GPU textures) + read-ahead ring buffer
    └─ Delivery
         pfx-media:// streams JPEG/raw  (no PNG, no base64)
```

Decoded frames live as IOSurface-backed Metal textures. Delivery options, simplest first:
1. GPU-encode a JPEG (CoreImage/ImageIO) and serve over `pfx-media://`. ← start here
2. Serve raw RGBA over `pfx-media://` to a WebGL/WebGPU canvas.
3. Zero-copy IOSurface share to the renderer GPU process (hardest; later).

---

## 4. Phased roadmap

### Phase 0 — Foundation (prerequisite, ~days) — ✅ DONE (2026-06-24)
Without this, nothing downstream feels fast.
- ✅ **Scrub-storm guard** — global concurrency cap + per-frame dedup + bounded
  backlog in `imf_frame_provider.js` (replaces the unbounded spawn that froze the
  machine). Verified: 40-request burst held to ~7 concurrent helpers, 0 errors.
  Renderer treats `SUPERSEDED` as a benign skip.
- ✅ **Probe caching** — `probeStream` + `probeImfPackage` cached; `-f imf` probe
  skipped entirely when the demuxer isn't built in (kills the 8.5 MB log storm).
- ✅ **pfx_helper** — uncompilable prototype → deferred to Phase 2; built asdcplib
  + enabled native `asdcp+openjpeg` CLI J2K decode (Backend B) instead.
- ✅ **pfx-media:// frame delivery** — persistent cache frames return a
  `pfx-media://` URL; renderer loads via `fetch → Blob → createImageBitmap`
  (taint-free, scopes intact). Eliminates the base64-over-IPC per frame.
  Requires THREE things, all now in place: CSP `connect-src pfx-media:`,
  scheme privilege `corsEnabled: true`, and an `Access-Control-Allow-Origin: *`
  response header.
  **Regression + fix (2026-06-24):** the first cut shipped without `corsEnabled`
  / ACAO, so the renderer `fetch()` (cross-origin from the file:// page) failed
  with "Failed to fetch" → preview broke for ALL imageUrl frames ("still not
  work"). Root cause: the initial "verification" only checked the provider
  RETURNS a URL + the file exists; it never tested the renderer actually
  fetching it. Now verified end-to-end with a headless BrowserWindow:
  `fetch(pfx-media://…)` → 200, decodes, `getImageData` succeeds (canvas not
  tainted). LESSON: verify the consuming side, not just the producing side.
- ✅ **arm64-native** — confirmed, no Rosetta.

### Phase 1 — VideoToolbox path for ProRes / H.264 / HEVC (~1 wk)
- Persistent decode session in the native engine → `CVPixelBuffer`.
- Metal/CoreImage color + scale + HDR tone-map.
- Frame cache + read-ahead ring buffer for smooth scrub/playback.
- Covers ProRes + H.264/HEVC fully on hardware.

### Phase 2a — Reduced-resolution J2K preview — ✅ DONE (2026-06-24)
The biggest J2K-speed win that needs no new library or licensing. JPEG2000 is
wavelet multi-resolution, so `-lowres N` decodes only the top levels.
- Measured on a real 1920×1080 J2K HDR MXF: full = 2.46 s/frame, lowres 1 =
  0.67 s (3.7×), lowres 2 = 0.22 s (11×), lowres 3 = 0.12 s (20×).
- `imf_ffmpeg_backend.extractFrame` accepts `{ lowres }` (clamped 0–3, full-res
  fallback if a file has fewer wavelet levels).
- `requestFrame` / `decodeFrame` thread `lowres` through; the on-disk cache is
  keyed by resolution (`<mode>.lr<N>`) so preview and full-res never collide;
  dedup key includes lowres.
- Renderer (`imf_player.js`): "Balanced" profile — `_previewLowres()` returns
  lowres 2 while playing or actively scrubbing, 0 when settled; a settle timer
  and pause handler call `_refineCurrentFrameFullRes()` to re-decode the held
  frame at full resolution. Verified end-to-end at the `requestFrame` level
  (preview 460 KB/0.4 s vs full 6.4 MB/2.5 s, separate cache entries). Renderer
  scrub/playback smoothness + refine-on-settle need a visual pass.

### Phase 2b — JPEG frame output for SDR — ✅ DONE (2026-06-24)
Profiling showed the J2K full-res cost was dominated by **PNG encoding**, not
decode: decode-only 0.79 s, +PNG encode → 2.4 s, +JPEG encode → 1.2 s. Threading
the decoder barely helped. So SDR (tone-mapped, 8-bit) frames now output JPEG
(`-q:v 2 -pix_fmt yuvj444p`), hdr/raw keep 16-bit PNG.
- SDR full-res snap: 2.43 s/6.4 MB → **1.41 s/279 KB** (1.7× faster, 23× smaller).
- 23–65× smaller payload also speeds the `pfx-media://` fetch + renderer decode.
- `imf_cache` is extension-agnostic on read (jpg or png); `framePath` takes an ext.
- 4:4:4 chroma preserved for the vectorscope; verified HDR still emits 16-bit PNG.

### Phase 2 — Faster full-res J2K decode (library decision) (~1–2 wk)

**Benchmark (2026-06-24, same 1920×1080 J2K codestream, pure decode→raw):**
| Decoder | Time | Notes |
|---|---|---|
| OpenJPEG `opj_decompress` | 0.49 s (0.32 s w/ 10 threads) | BSD, free, slow |
| ffmpeg `jpeg2000` | 0.39 s | built-in, single-threaded |
| **Grok `grk_decompress`** | **0.051 s** (~8×) | **AGPL-3.0** (or commercial dual-license) |
| Grok `-r 2` (quarter-res) | 0.028 s | reduced-resolution path |

Conclusion: full-res J2K speed is purely a library choice. Grok/Kakadu give ~8×
(≈50 ms decode). Decision is licensing, not engineering:
- **OpenJPEG** — free, but no faster than ffmpeg. Not worth switching.
- **Grok** — fastest measured, but AGPL-3.0 is viral; shipping in a commercial
  app needs Grok's **commercial license** (subprocess use is still legally
  fraught under AGPL — don't bundle on AGPL terms).
- **Kakadu** — industry standard, ~Grok-class speed, straightforward commercial
  license ($). Lowest legal risk for a paid product.

**Implemented (2026-06-24) — gated, OFF by default:** `electron/imf/imf_fast_j2k.js`
+ integration in `imf_ffmpeg_backend.extractFrame`. Enable per-decoder via env:
`PFX_FAST_J2K=grok` (grk_decompress) or `PFX_FAST_J2K=kakadu` (kdu_expand).
- Measured through extractFrame on the HDR clip: full-res 1202 ms → **183 ms
  (~6.6×)**; lowres 2: 197 ms → 99 ms. Output is an equivalent valid JPEG.
- Pipeline: ffmpeg `-c:v copy` (extract codestream) → fast decoder → 8-bit BMP →
  ffmpeg encode. Honours `lowres` via `-r`/`-reduce`. Falls back to the normal
  ffmpeg decode on any failure (`_noFast` retry) — enabling the flag can never
  break decoding, only speed it up.
- **Gated to non-tonemap output only** (8-bit BMP can't carry >8-bit HDR
  tonemap). On builds *with* zscale + HDR source, the fast path is skipped to
  preserve 16-bit tonemap quality.
- Ships nothing: no Grok/Kakadu binary is bundled or enabled by default, so the
  committed code carries no AGPL/commercial obligation until an operator opts in
  with a separately-licensed decoder.

**HDR tonemap — FIXED (2026-06-24):** homebrew-core ffmpeg dropped `zimg`, so the
PQ/HLG→SDR tonemap silently failed and HDR was shown raw/washed-out. Rebuilt
ffmpeg from the `homebrew-ffmpeg` tap with `--with-zimg --with-libplacebo
--with-openjpeg` (needed an Xcode-27 Command Line Tools update first). Now:
- `zscale` present → PQ→SDR tonemap works (verified: `tonemapApplied=YES`,
  `rawHDR=false`). `extractFrame` prefers libplacebo (GPU) when usable, else
  zscale, else raw — with a runtime fallback chain.
- **libplacebo GPU tonemap — installed & working, but OPT-IN (slower per-frame).**
  Installed `molten-vk` (+ `vulkan-loader`) so the libplacebo Vulkan path runs on
  this Mac (ICD at `/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json`). Verified
  end-to-end (`backend=ffmpeg+libplacebo`). BUT benchmark: per-frame it's SLOWER
  than zscale because each ffmpeg spawn re-inits Vulkan — full-res 1.25 s vs
  1.17 s; lowres2 0.34 s vs 0.20 s. So it's gated behind `PFX_GPU_TONEMAP=1`
  (default = zscale CPU). `_GPU_TONEMAP` + `_ffEnv()` inject the ICD only when
  opted in; `_libplaceboUsable()` probes once. **GPU tonemap only pays off with a
  persistent decode process** — revisit when Phase 2/3 lands one. Quality upside:
  BT.2390 + CPU offload.
- `libopenjpeg` adds only a J2K *encoder*, not a faster decoder (modern ffmpeg
  uses its native jpeg2000 decoder) — no decode speedup from it.
- Note: with tonemap now active, the Grok fast path is (correctly) skipped for
  HDR→SDR (8-bit BMP can't carry the >8-bit tonemap); it still accelerates SDR
  sources. HDR scrub stays fast via the lowres preview.

**Integration design (same shape for Grok-commercial or Kakadu):**
1. New optional backend in the J2K chain, ahead of ffmpeg, gated on (a) the
   binary being present and (b) a config flag acknowledging the license.
2. Per frame: extract the codestream from the MXF (reuse
   `imf_htj2k_backend.extractRawCodestream` / `ffmpeg -c:v copy`, demux-only,
   fast) → `grk_decompress`/`kdu_expand` to a temp PPM/TIFF → encode JPEG (SDR)
   or keep 16-bit (HDR). Net full-res ≈ 50 ms decode + ~0.4 s encode → well under
   today's 1.4 s; or have the fast decoder write the final image directly.
3. Honours the existing `lowres` arg via `-r N` (Grok) / `-reduce N` (Kakadu) —
   composes with the Phase 2a preview path.
4. Cache + pfx-media:// delivery unchanged.

### Phase 3 — GPU decode (Metal compute) — research, weeks
J2K entropy decode (EBCOT, arithmetic, per-code-block-serial) does not map to GPU
well; the realistic GPU wins are:
- **HTJ2K** (FBCOT, block-parallel) — a genuine Metal-compute decode candidate;
  this is where GPU J2K efforts in the industry concentrate.
- **IDWT + dequant + color/tonemap** for classic J2K — move these stages to Metal
  while entropy decode stays on CPU (ideally a fast lib from Phase 2).
- End-to-end GPU textures + zero-copy IOSurface delivery to the renderer.
Highest ceiling, lowest ROI per week. Only justified for sustained 4K+ J2K
throughput. Prerequisite: land Phase 2 (fast CPU decode) first and measure whether
GPU is still needed.
- Replace ffmpeg J2K with a fast multithreaded CPU decoder (OpenJPEG → evaluate Grok;
  OpenJPH for HTJ2K). Spread code-block decode across P-cores.
- Upload to Metal; run the same GPU color/scale/HDR stage as Phase 1.
- Covers J2K + HTJ2K with GPU doing everything except entropy decode.

### Phase 3 — GPU-compute decode (stretch / research)
- Metal-compute HTJ2K block decode (FBCOT parallelises well).
- GPU IDWT + dequant for J2K (entropy stays on CPU).
- End-to-end GPU textures, zero-copy delivery.

---

## 5. Decisions needed before Phase 2

- **J2K library + license**: OpenJPEG (BSD, slow) vs Grok (**AGPL** — viral, risky for a
  shipping product) vs Kakadu (commercial, fastest). HTJ2K: OpenJPH (BSD).
- **Delivery format**: JPEG-over-protocol (simple) vs raw RGBA to WebGPU (faster, more work).
- **HDR target**: tone-map to SDR for display, or drive an EDR/HDR canvas.

---

## 6. Honest expectations

- ProRes / H.264 / HEVC: large win, hardware decode + GPU color. Smooth scrub/playback.
- J2K: meaningful win from multithread CPU + GPU color, but bounded by CPU entropy decode.
  GPU cannot remove that. Manage expectations on 4K+ J2K real-time playback.
- HTJ2K: good CPU win now, large win if/when GPU-compute decode lands in Phase 3.
