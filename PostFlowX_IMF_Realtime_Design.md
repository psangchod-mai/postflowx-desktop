# PostFlowX — Real-Time IMF Playback Without Resolve (Design Note)

**Date:** 2026-06-28 · **Platform:** macOS / Apple Silicon · **Backlog:** Epic C-RT.

## TL;DR
PostFlowX already plays IMF without DaVinci Resolve. The engine selector
(`companion/.../media_engine/media_router.py → select_engine`) routes IMF to
`IMFEngine → FFmpegFrameServerEngine → ProxyEngine`; `ResolveEngine` is reserved for
camera RAW/OCF only. The open problem is not *Resolve-free playback* — it's **sustaining
package fps at UHD on a CPU-only J2K decode** (Apple Silicon has no GPU J2K decode; VideoToolbox
doesn't decode J2K). This note records the current pipeline and the levers to reach real-time.

## Current Resolve-free pipeline (as built)
1. **Demux** MXF essence (J2K codestreams + PCM).
   - Renderer: `src/scripts/modules/imf/imf_mxf.js`.
   - Companion: `imf_engine/imf_decode.py` — ffmpeg `-f imf` (libopenjpeg) with direct-MXF fallback; detects `ojph_expand` (OpenJPH HTJ2K CLI).
2. **Decode J2K** (the bottleneck).
   - Renderer WASM: `src/sandbox/j2k_decoder.js` — **two backends**: OpenJPH (HTJ2K, `assets/imf/openjphjs.wasm`) and classic OpenJPEG (`openjpeg_port.js`) + pure-JS fallback.
   - **Reduce-level (DWT) decode EXISTS**: `decodeHTBytes(bytes, reduceLevel)` → `decoder.decodeSubResolution(reduce)`; `decodeClassicBytes(bytes, reduceLevel)` passes reduce; `_reduceLevelFromScale(scale)` currently maps only `scale≤0.25 → reduce 2` (else ~full).
   - **Parallel pool**: `imf_j2k.js` runs sandbox lanes sized to `navigator.hardwareConcurrency` (≤4 lanes at 16+ cores); desktop can init WASM directly (no sandbox eval limit).
3. **Render**: `imf_player_engine.js` consumes an MJPEG stream and paints `ImageBitmap`s to `<canvas>` via rAF; single-frame scrub via `/imf/frame/{sessionId}/{frame}`.

## The key unknown (audit C-RT0 answers this)
There appear to be **two decode paths**: continuous playback via the companion **MJPEG stream**
(ffmpeg) vs scrub/single-frame via the **WASM sandbox pool** (which has reduce-level). We must
confirm, for *continuous playback*: (a) is a reduced resolution level used, or full-res? (b) is
HTJ2K (OpenJPH/`ojph`) preferred over classic libopenjpeg for HT codestreams? (c) actual fps at
2K and UHD. The answer sets how much of C-RT1..4 is needed.

## Levers to reach/hold real-time (priority order)
1. **Resolution-level playback (biggest free win).** Decode a lower DWT level during play
   (half/quarter), full-res on pause. 4–16× decode speedup, native to J2K. → C-RT1.
2. **Prefer HTJ2K via OpenJPH** for High-Throughput packages (ST 2067-21 App 2E) — several × faster
   than classic Part-1. Backend already bundled; confirm routing. → C-RT2.
3. **Native NEON multithreaded decoder** instead of WASM for the hot path (~2–3× over WASM). → C-RT4.
4. **Decode-ahead buffer + pool tuning** to hide decode latency behind playback. → C-RT3.
5. **Kakadu** as optional paid engine — only guaranteed real-time UHD classic-J2K (what Resolve uses).
6. **A/V clock + audio sync** so continuous play stays locked. → C-RT5.

## Non-levers (don't chase on Mac)
- GPU J2K decode: nvJPEG2000/CUDA/Fastvideo are NVIDIA-only; not available on Apple Silicon.
- VideoToolbox: no J2K support. (It is the right path for ProRes/HEVC/H.264 — already used via `avf_bridge`.)
