# PostFlowX — C-RT0 Audit: IMF Real-Time Playback Decode Path

**Date:** 2026-06-28 · **Scope:** Engineering-Handoff §3 action #1 (C-RT0, "do first")
**Question:** Does *continuous* IMF playback use reduced-resolution + HTJ2K decode, or only full-res? Measure J2K decode fps on Apple Silicon to size all real-time (C-RT) work.

**TL;DR:** Continuous playback decodes at **full resolution** — by deliberate choice, not omission. The reduced-level (DWT) capability exists in three places but is **disabled in the play path** due to an HTJ2K reduced-decode correctness bug ("dark/corrupt/oscillating frames"). Measured full-res J2K decode is **20.7 fps at HD** (misses 23.976 real-time) vs **149 fps reduced** (`-lowres 2`). Real-time UHD on CPU is therefore **impossible at full-res** and reduced-level decode is **mandatory**. A ready path exists: the bundled **ffmpeg J2K decoder supports `-lowres`** (reduce-level) on a **direct picture-MXF decode**. ⚠️ Note: the **IMF demuxer is absent** from both bundled and Homebrew ffmpeg, so the `imf_direct_engine.js` `-f imf` stream (Path A) is non-functional here — real playback is Path B (WASM), and the `-lowres` win must target a direct-MXF decode, not the IMF stream (see §3b).

---

## 1. How playback is wired (code findings)

There are two parallel renderer playback paths; **both decode at full resolution**:

**Path A — `imf_player_engine.js` → `electron/imf/imf_direct_engine.js` (MJPEG stream).**
Continuous play consumes an MJPEG stream produced by ffmpeg:
`_startFFmpegStream()` → `ffmpeg -i <imf> -vf scale=${outW}:-2 -c:v mjpeg` (`imf_direct_engine.js:779`).
This is a **full J2K decode then downscale** — the decoder does full-resolution work every frame; the `scale` is only an output resize. Scrub (`_extractSingleFrame`) is the same ffmpeg path (`:855`), with a native-decoder thumbnail fallback.

**Path B — `imf_player.js` → `imf_j2k.js` (WASM OpenJPH HTJ2K).**
The WASM decode is called with **full resolution, always** (`imf_player.js:3050-3055`):
```js
// Stability-first preview path: keep decoder at full resolution and apply
// timeline/view scaling in the renderer. Reduced decoder output proved unstable
// across HTJ2K preview modes and could oscillate between dark/corrupt frames.
const renderScale = 1; // stability-first … preview mode now affects scheduling only.
const decoded = await _decodeHTJ2K(bytes, { scale: 1, fastMode: !!S.isPlaying });
```
So `imf_player.js`'s realtime mode (`S.previewScale` = 1 / 0.5 / 0.25, with adaptive down/up at `:2537`/`:2545`) changes **scheduling only** — frame **stride/skip**, lane count, prefetch depth (`_getPlaybackStride`, `_getRealtimeStepFrames` `:2714-2733`). It does **not** lower decode resolution. "Realtime mode" today = **drop frames, decode survivors at full res.**

**The reduced-level capability exists but is unused by playback:**
- `imf_j2k.js:_reduceLevelFromScale(scale)` + `decoder.decodeSubResolution(reduceLevel)` (`:133-146`) — DWT reduce-level decode, keyed off `scale` (which play always passes as 1).
- `src/sandbox/j2k_decoder.js:256` `decoder.decodeSubResolution(reduce)` — same, in the sandbox decoder.
- `electron/imf/imf_frame_provider.js` caches "Preview (reduced-resolution) frames … separately" (`:76`) — reduced frames are a first-class concept in the 4-tier provider, but the renderer play paths above don't request them.

**Root cause:** not "not wired" — it's **wired and turned off**. Reduced-level HTJ2K output was unstable (dark/corrupt/oscillating frames), so `scale:1` was hard-coded as a stability workaround.

---

## 2. Measurements (Apple Silicon, bundled LGPL ffmpeg 8.1.2)

Real sample: `Meridian_tst_HD_23.976fps_HDRIAB` — JPEG2000, **1920×1080**, rgb48le, 23.976 fps.
Decode 48 frames → `-f null`:

| Decode | Time | Throughput | Real-time @23.976? |
|---|---|---|---|
| **Full-res** (HD 1080p) | 2.31 s | **20.7 fps** | ❌ misses |
| **Reduced** `-lowres 2` (¼, → 480×270) | 0.32 s | **149 fps** | ✅ 6× headroom |

- Full-res J2K can't sustain real-time **even at HD** on this machine (20.7 < 23.976).
- Reduced decode is **~7× faster**.
- UHD (3840×2160) is ~4× the pixels → full-res ≈ **~5 fps** (unusable); a reduced level brings it back above real-time. This is the whole ballgame for UHD.

> Note: numbers are ffmpeg's CPU J2K decoder (Path A). The WASM OpenJPH decoder (Path B) has its own profile, but the conclusion — full-res can't hit real-time, reduced must be used — holds for both; that's exactly why reduce-level exists.

---

## 3. Conclusion (answers C-RT0)

1. **Continuous playback = full-resolution decode.** Confirmed in both paths (ffmpeg `scale=` downscale of a full decode; WASM `scale:1` hard-coded).
2. **Reduced-level (DWT) decode is implemented but disabled** in the play path because reduced **HTJ2K** output was visually unstable. The fix is a **correctness** problem, not a wiring one.
3. **Real-time UHD on CPU is impossible at full res; reduced-level decode is required.** Measured HD already misses real-time at full res.
4. There is a **low-risk alternative to the buggy WASM path: ffmpeg `-lowres N`** on the existing `imf_direct_engine.js` stream (it already drives playback via ffmpeg) — measured 149 fps at `-lowres 2`.

---

## 3b. Follow-up finding — IMF demuxer is ABSENT (changes the C-RT1a plan)

While prototyping the `-lowres` quick win, a blocker surfaced: **neither the bundled
LGPL ffmpeg nor the Homebrew ffmpeg on this machine has the IMF demuxer.**
`bin/ffmpeg -demuxers | grep imf` → empty; `-f imf -assetmaps … -i CPL` → *"Error
splitting the argument list: Option not found"*. So **Path A
(`imf_direct_engine.js` MJPEG stream) is non-functional with the available
ffmpeg** — it relies on `-f imf -assetmaps`. That implies real IMF playback today
goes through **Path B** (`imf_player.js`: direct MXF essence-walk via `S.mxfIndex`
+ per-frame raw J2K bytes → WASM OpenJPH), not Path A.

ffmpeg's IMF demuxer needs `--enable-demuxer=imf` **and** `--enable-libxml2`
(it parses CPL/ASSETMAP via libxml2); our portable LGPL build has neither.

Consequence for the quick win: **`-lowres` can't be bolted onto the IMF stream**
(the stream doesn't run). Two viable real-time routes instead:

- **Route 1 — direct-MXF ffmpeg + `-lowres` (no IMF demux needed).** Decode the
  picture-track MXF directly: `ffmpeg -lowres N -i <picture.mxf> …`. Verified
  ladder on the real HD picture MXF: **lowres0 = 20.1 fps, lowres1 = 54.3 fps,
  lowres2 = 143.8 fps** — half-res already clears 23.976. Needs the picture-MXF
  path + frame→time mapping (Path B already resolves the picture MXF + frame
  offsets, so the plumbing exists).
- **Route 2 — fix the WASM reduce (C-RT1b).** Enable `decodeSubResolution` in
  `imf_j2k.js` for Path B and fix the dark/corrupt-frame instability. This is the
  in-engine path and avoids spawning ffmpeg per stream.
- **Route 0 (enabler, optional):** rebuild bundled ffmpeg with
  `--enable-libxml2 --enable-demuxer=imf` to make Path A work at all (then
  `-lowres` applies there too). Heavier — adds a libxml2 (static) dependency.

---

## 3c. DONE 2026-06-28 — Route 0 (IMF-capable ffmpeg) + C-RT1a engine wiring

- **Rebuilt the bundled ffmpeg with the IMF demuxer.** `DEV/ffmpeg-8.1.2` configured
  `… --enable-zlib --enable-videotoolbox --enable-audiotoolbox --enable-libxml2
  --enable-demuxer=imf` → arm64, LGPL, **portable** (`otool -L` = only `/usr/lib`
  [incl. system `/usr/lib/libxml2.2.dylib`] + system frameworks). Installed to
  `bin/ffmpeg`+`bin/ffprobe`. Drop-in superset: exr half-float, prores_ks,
  h264/hevc_videotoolbox, ACES2 LUT chain all intact; companion 160/160, tests-js 22/22.
  `bin/ffmpeg -demuxers | grep imf` → present. Verified via the IMF demuxer:
  full=14.7 / **lowres1=40.8** / lowres2=99.5 fps (HD).
- **Fixed bundled-ffmpeg discovery in the IMF engines.** `imf_direct_engine.js`,
  `imf_ffmpeg_backend.js`, `imf_htj2k_backend.js` resolved ffmpeg Homebrew-only
  → would never see the IMF-capable bundled binary (so IMF would break even in the
  packaged app). Now all use `../native/ffbins` (bundled → `PFX_*_BIN` → Homebrew).
- **C-RT1a wired into the engine.** `imf_direct_engine.js`: `session.lowres` +
  `_qualityToLowres(full|half|quarter|auto)`; `-lowres N` injected before `-i` in
  `_startFFmpegStream` (continuous play); scrub/pause stay full-res. Quality is
  settable via `?q=` on the stream URL, `startPlayback({quality})`, and a live
  `controlPlayback(… 'quality', value)` command (restarts the stream).
  **Verified end-to-end headless:** engine opens the real Meridian package and
  delivers JPEG frames through the rebuilt ffmpeg (previously "Option not found").
- **Renderer UI toggle — DONE (Path A).** `imf_player_engine.js`: `_quality`
  state (default 'auto'=half) + `setQuality()`/`getQuality()`; quality passed to
  `startPlayback` and applied live via `controlPlayback(sessionId,'quality',q)`.
  `imf_package_ui.js`: an **Auto/Full/Half/Quarter** `<select>` (#imf-quality-select)
  next to the rate control → `player.setQuality()`. Preload bridge passes `value`
  through (`preload.js:655`). build:renderer OK (shipped to dist), tests-js 22/22,
  companion 160/160. Full chain verified except the in-app visual (needs the
  running Electron app to confirm the half-res picture looks right + plays smooth).
- **C-RT1a is therefore complete for Path A** (IMF package UI).

## 3d. C-RT1b — WASM reduce ROOT-CAUSED + FIXED 2026-06-28 (headless)

The OpenJPH WASM runs under Node, so the "dark/corrupt/oscillating reduced frames"
bug was reproduced headless (encode a test frame via `HTJ2KEncoder`, decode via
`decodeSubResolution`). **Finding: OpenJPH is CORRECT** — level 1 → 128×128 with
the right brightness (mean ~127, not dark). The bug was in **our wrappers**:
`decodeSubResolution(N)` returns a REDUCED-size buffer, but `getFrameInfo()` still
reports the FULL dims — and `imf_j2k.js`/`j2k_decoder.js` returned the FULL
width/height with the REDUCED buffer (e.g. a 128×128 / 49 152-byte buffer labelled
256×256 / 196 608) → the renderer read 4× past the buffer → garbage/dark/oscillating.
Also `decodeSubResolution(level)` THROWS when `level ≥ getNumDecompositions()`.

**Fix:** both decoders now (a) clamp the reduce level to `getNumDecompositions()`,
and (b) take dims from `calculateSizeAtDecompositionLevel(level)` (returns
`fullWidth/fullHeight` too). With the dims bug gone, `imf_player.js:3054` was
flipped from hard-coded `scale:1` to `decodeScale = isPlaying ? (previewScale||1) : 1`
— reduced DWT decode during play, full-res on pause/scrub. Default `previewScale=1`
→ behaviour unchanged until the user/adaptive logic lowers it (safe-by-default).
Regression test `tests-js/imfReduceDecode.test.mjs` (runs the real WASM, asserts
reduced dims == reduced buffer). build:renderer OK, tests-js + companion green.

**Remaining:** in-app visual confirmation that the MAIN player (Path B) now plays
smoothly + correctly at Half/Quarter on real HTJ2K media (needs the running app;
the dims invariant + decode-rate are proven headless).

## 3e. C-RT1c (FFmpeg threading) is a NO-OP — measured 2026-06-28

Threading was floated as a real-time lever; measurement says it isn't, for the
path that matters. On the real HD J2K MXF (decode to null):

| | fps |
|---|---|
| `-threads 1` (single) | 3.1 |
| `-threads 0` (auto, default) | 19.8 |
| `-threads 8 -thread_type frame` | 18.1 |
| `-threads 8 -thread_type slice` | 3.1 |

- **No decode path forces `-threads`** — they all use ffmpeg's default (auto =
  multi-threaded). So there's no single-thread bug to fix; threading is already on.
- **Frame-threading only helps a continuous STREAM** (many frames in flight).
  J2K **slice-threading gives nothing** (3.1 fps). So the **per-frame "eCache"
  path (`-frames:v 1`) cannot be sped up by threading** — a lone frame can't
  frame-thread.
- **Single-frame decode cost (the per-frame path's reality):** full-res **838 ms**,
  `-lowres 2` **116 ms** — i.e. ~1.2 fps full / ~8.6 fps quarter, before the
  per-frame ffmpeg spawn overhead. **The per-frame architecture cannot reach
  real-time for J2K, period** — threading and lowres only soften it.

Conclusion: skip C-RT1c. The real-time path MUST be the persistent stream
(`imf_direct_engine`, frame-threaded, ~20 fps full / faster reduced) — already
enabled (Route 0 + C-RT1a). Per-frame decode stays for scrub/pause only.

## 4. Recommended next steps (re-scopes C-RT1)

1. **C-RT1a (quick win) — direct-MXF ffmpeg `-lowres`** (NOT the IMF stream; §3b: no IMF demuxer). Decode the picture-track MXF directly with `-lowres N` during play, `-lowres 0` on pause/scrub, N from a quality ladder. Measured real-time-capable (lowres1=54fps, lowres2=144fps). The picture MXF + frame offsets are already resolved by Path B. Verify landed frame on the running app.
2. **C-RT1b (the in-engine real fix):** debug the WASM OpenJPH `decodeSubResolution` instability (dark/corrupt/oscillating reduced frames) so Path B (`imf_player.js`) can reduce natively — preferred for HTJ2K Part-15 / no-ffmpeg-demux. Suspects: component bit-depth/sign handling at reduced levels, buffer stride at non-full resolutions, RPCL vs other progression order. Flip `imf_player.js:3054` `scale:1` → a `previewScale`-driven value once stable.
3. **C-RT1c:** resolution-level **policy + ladder** — reduced during play, full on pause; Auto adapts via `S.decodeAvgMs` (already tracked) + the existing `_setPreviewScale` adaptive logic.
4. **Route 0 (optional enabler):** rebuild bundled ffmpeg `--enable-libxml2 --enable-demuxer=imf` to make the IMF stream (Path A) functional at all; then `-lowres` works there too.
5. Keep the current frame-drop scheduler as the **fallback** when a reduced level still can't hit cadence.

**Files:** C-RT1a → `electron/imf/imf_frame_provider.js` / `imf_ffmpeg_backend.js` (direct-MXF decode args) + `imf_player.js`/`imf_player_engine.js` (quality toggle). C-RT1b → `src/scripts/modules/imf/imf_j2k.js`, `src/sandbox/j2k_decoder.js`. Route 0 → ffmpeg build (`DEV/ffmpeg-8.1.2.tar.xz`).

---
*Audit method: static trace of the play/scrub decode paths across `imf_player_engine.js`, `imf_player.js`, `imf_j2k.js`, `electron/imf/imf_direct_engine.js`, `imf_frame_provider.js`; fps measured by decoding 48 frames of a real HD IMF J2K MXF to null with the bundled ffmpeg, full-res vs `-lowres 2`.*
