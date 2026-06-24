# PostFlowX — Performance/Preview Work — Session Handoff (2026-06-24)

Resume point after laptop restart. Full design detail in `GPU_PIPELINE_PLAN.md`.

## ⭐ DO THIS FIRST next session (the one open bug)
**Black preview / "CPL path not resolved — package may still be indexing… Trying
per-MXF decode"** — intermittent (real frames showed in some clips, black in
others). Same package. Smells like a package-indexing race: decode attempted
before `cplPath`/`mxfPath` resolve in the renderer.

A renderer log is now captured on EVERY launch:
`~/Library/Application Support/PostFlowX/logs/renderer.log`
→ Reproduce the black state, then read that file. Look for `[IMF]` lines:
whether `_tryElectronImfDecode` has a `cplPath`, whether it falls to
`_tryElectronFrameBackend` with an `mxfPath`, and what `requestFrame`/`decodeFrame`
return. The decode itself is proven working when given a path (`requestFrame`
returns ok + a valid frame), so this is purely path-resolution/timing in the
renderer (`_imfElectronCplPath` / `_imfElectronMxfPaths` in `src/.../imf_ui.js`).

## ✅ Fixed & verified this session
1. **Laptop freeze (original issue)** — unbounded decode-process spawn. Added a
   global concurrency cap + per-frame dedup + bounded backlog in
   `imf_frame_provider.js`. Verified: 40-request burst held to ~7 procs.
2. **Per-frame `ffprobe` storm** — cached `probeStream`/`probeImfPackage`; skip
   `-f imf` when the demuxer isn't built in (was an 8.5 MB log of retries).
3. **Timeline blink / "Cannot read MXF header" spam (~3,800×/session)** — in
   companion mode the package `file` is an unreadable handle; now `S.mxfFile` is
   nulled in companion mode so `scanMXF` never runs on it. Verified: log shows 0
   occurrences after the fix; timeline frame intact.
4. **HDR tonemap was silently broken** — homebrew-core ffmpeg dropped `zimg`.
   Rebuilt ffmpeg with zimg → PQ→SDR tonemap works (`tonemapApplied=YES`).
5. **`lumaStats` parse bug** — modern ffmpeg `signalstats` uses `YAVG=` not
   `YAVG:`; fixed (restores poster-frame auto-pick).
6. **`pfx-media://` fetch "Failed to fetch"** — scheme needed `corsEnabled:true`
   + `Access-Control-Allow-Origin` header + CSP `connect-src pfx-media:`. All in.

## ✅ Built but OFF by default (opt-in)
- **Reduced-res J2K preview (lowres)** — ~8× scrub. On by default in renderer via
  `_previewLowres()` (lowres 2 while playing/scrubbing, full res on settle).
- **JPEG frame output for SDR** — full-res 2.4 s/6.4 MB → 1.4 s/279 KB.
- **Fast J2K decoder (Grok/Kakadu)** — `electron/imf/imf_fast_j2k.js`. Enable:
  `PFX_FAST_J2K=grok` or `=kakadu`. Measured ~6.6× full-res. ⚠ Grok is AGPL —
  needs a commercial license to ship; Kakadu is commercial. **DECISION NEEDED.**
- **GPU tonemap (libplacebo+MoltenVK)** — works but per-frame slower (Vulkan
  re-init each spawn). Enable: `PFX_GPU_TONEMAP=1`. Only worth it with a
  persistent decode process (future).

## ⚠️ Open / to decide later
1. Black preview / CPL-path race (see top) — **primary open bug**.
2. HDR look: scopes showed "Over-sat / Black+White clip" — confirm tonemap output
   looks right on HDR content (zscale chain is `hable`; could tune).
3. Confirm timeline blink is fully gone in normal use.
4. J2K library licensing (Grok vs Kakadu) to turn on `PFX_FAST_J2K`.
5. Phase 1 (VideoToolbox) is already present in the Swift engine for
   ProRes/H.264/HEVC; J2K can't use it.
6. Phase 3 GPU J2K decode — research-grade, weeks.
7. Consider whether to keep `pfx-media://` delivery or revert to base64+JPEG
   (base64 of a 280 KB JPEG is small and was the proven-stable path).
8. `pfx_helper` C++ (`electron/imf/pfx-helper/`) is uncompilable prototype
   (references non-existent libplacebo-Metal / OPJ_CODEC_HTJ2K / AS-02 APIs) —
   deferred; do native decode in the Swift engine instead.
9. Before shipping: gate or remove the always-on renderer→file logging in
   `electron/main.js` (currently writes `logs/renderer.log` every launch).

## Environment changes made (system-level)
- **ffmpeg replaced**: now `homebrew-ffmpeg/ffmpeg/ffmpeg` built `--with-zimg
  --with-libplacebo --with-openjpeg` (core ffmpeg was uninstalled). Required an
  Xcode-27 Command Line Tools update (done). `brew install ffmpeg` would revert
  it to the zimg-less core build — don't.
- Installed: `cmake`, `pkg-config`, `libplacebo`, `molten-vk`, `vulkan-loader`,
  `grokj2k`; `asdcplib` built from source into `/opt/homebrew` (+`asdcp-test`).
- MoltenVK Vulkan ICD: `/opt/homebrew/etc/vulkan/icd.d/MoltenVK_icd.json`.

## Rebuild the packaged app (after any source change)
```
cd PostFlowX_Desktop
node build-renderer.js --target desktop            # renderer (src/ → dist/desktop)
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir \
  -c.mac.identity=null -c.mac.notarize=false        # repackage dist/mac-arm64/PostFlowX.app
```
Native binaries are reused (unchanged); no Swift recompile needed.
Dev (runs from source, no repackage): `npm run dev`.
IMPORTANT: the packaged `.app` does NOT reflect source edits until rebuilt — the
user runs the packaged app, so rebuild after every change.

## Files changed this session
- electron/imf/imf_frame_provider.js, imf_ffmpeg_backend.js, imf_cache.js
- electron/imf/imf_fast_j2k.js (NEW)
- electron/native/media_engine.js
- electron/main.js
- src/scripts/modules/imf/imf_player.js, imf_ui.js
- docs/GPU_PIPELINE_PLAN.md, docs/SESSION_HANDOFF.md (this file)
