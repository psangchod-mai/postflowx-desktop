# PostFlowX — Engineering Handoff

**App:** PostFlowX 2026.6.1 · macOS only (Apple Silicon–first)
**Date:** 2026-06-28
**Source root:** `/Users/psangchod/Documents/PostFlowX_2.5/PostFlowX_Desktop` (edit `src/`, `electron/`, `companion/` — never `dist/`)
**Goal:** Make PostFlowX rival DVS Clipster / DaVinci Resolve on three pillars — **VFX pull**, **IMF validation + real-time playback**, and **automation for non-technical users**.

This package bundles everything the coding team needs to take it forward: current state, what's done vs. remaining, prioritized next actions, build/verify instructions, and the supporting design docs.

---

## 1. Architecture (one source, native bridges, Python companion)
- **Renderer** (`src/`) — shared ES-module UI for two targets (desktop Electron + Chrome extension). Build copies `src/` → `dist/<target>/`.
- **Electron main** (`electron/`) — `main.js`, `ipc.js`, `preload.js` (contextBridge → `pfxPlatform`), `companion.js` (spawns the Python server).
- **Native bridges** (`electron/native/`) — `avf_bridge` (AVFoundation, built from `avf_bridge.swift`), `mpv_engine.js`, `media_engine.js`, `native_router.js`, `smart_router.js`, `resolve_bridge.py`, `seekModel.js`.
- **Python companion** (`companion/`) — OCF/FFmpeg/IMF/delivery work; `media_engine/` (router, IMF decode), `media/backends/` (ARRI/RED/BRAW/ProRes-RAW), `api.py`.
- **IMF subsystem** (`src/scripts/modules/imf/`) — validator, parser, MXF, J2K bridge, player engine; WASM J2K decode in `src/sandbox/j2k_decoder.js` (OpenJPH HTJ2K + classic OpenJPEG).
- **Platform detection:** desktop = `window.pfxPlatform?.isMacApp`; extension = `window.__PFX_TARGET__ === 'extension'`.

> Reference: `PROJECT_MAP.md` (tree + runtime differences), `PostFlowX_Technical_Strategy.md` (full rationale + macOS constraints).

---

## 2. Current state — done vs. remaining

### Pillar 1 — IMF Validation ✅ (essentially complete) + IAB gap ⚠️
- 70+ rules over CPL/PKL/ASSETMAP (`src/scripts/modules/imf/imf_validator.js`), SHA-1/256 hash verify, 12-entry SMPTE edit-rate set, Netflix **Photon** JAR runner (`electron/imf/imf_photon.js`), plain-language `{sev,code,msg,detail}` colored UI surfaced via `pfxPlatform.imf.runPhoton`.
- **Security:** companion XML fully XXE-hardened via a zero-dep `safe_xml.py` (rejects DOCTYPE/ENTITY) across all parse sites; 0 raw `ET.parse/fromstring` left.
- **IAB (Dolby Atmos) tab is empty — diagnosed, see `PostFlowX_IAB_Handoff.md`.** Root cause #1 (ADM packages like Meridian): `_collect_named_nodes` reads `audioObjectName` as a child element but EBU ADM stores it as an **attribute** → 49 objects parse but report 0. Root cause #2 (pure-IAB ST 2098-2, no ADM XML): nothing for the XML scan to find → needs a bitstream parser. **Quick win (FIX 1):** read names from attributes + drive UI from element counts → tab populates for Meridian immediately. Per-object audio (FIX 3) needs a Dolby decoder / asdcplib IAB fork (native).

### Pillar 2 — VFX Pull ✅ (working; one perf follow-up)
- OCF probe + conform (TC/reel/clipname/duration match, handles, source-TC map) — `api.py:2099+`.
- Non-blocking EXR export job, Resolve→OIIO→FFmpeg, ACES2065-1 + auto-IDT, progress/QC — `api.py:3693+`.
- Pull manifest JSON + CSV/EDL/XLSX + sidecars (AMF / ASC FDL v2.0 / geometry).
- OCF still preview live-verified (3-tier). **Remaining:** batch-render perf (collapse 7 stills → one handle-range render; `planOcfBatchRender` + companion `resolveStillBatch` exist) and a scratch-project cleanup sweep.
- **Note:** Resolve is used *only* for camera-RAW/OCF debayer here — not for IMF.

### Pillar 3 — Automation ✅ (mostly done; live-wire remaining)
- Shareable `.pfxpreset` import/export + bundled starter library (6 presets: ARRI/Sony/RED→ACES, HDR PQ, SDR 709) — done, 59 tests.
- Guided error recovery (`userMessage`/`retryable`/next-step) and plain-language job queue (ETA, retry, history) — working.
- **Remaining:** watch-folder auto-detect "brain" is built + tested (63 tests across `proposeAction`/`settleBatch`/`watchController`); only the **~20-line live-wire** is left (Electron `fs.watch` → controller → one-click prompt). Needs the running app.

### Pillar 2.5 — Playback engine routing ⚠️ (THE remaining epic)
- **C1 routing — PARTIAL:** ProRes→AVFoundation and the J2K/IMF 4-tier provider exist, but the codec→engine *decision* lives in the Python companion; `smart_router.js` only dispatches. Needs a unified, documented routing protocol + verification of the Python selection logic.
- **C2 frame parity — PARTIAL:** pure seek model done (`electron/native/seekModel.js`, 39 tests: mid-frame seek, floor-based frame mapping, per-engine args, thumbnail parity). mpv frame-seek wired. **Remaining (needs live media):** confirm landed frame on real playback; route `seekFrame`/`planStill` through the renderer player; mpv-still ffmpeg fallback.

### IMF real-time playback (no Resolve) — Epic C-RT 🆕 (root cause found)
See **`PostFlowX_IMF_Realtime_Design.md`**. PostFlowX already plays IMF without Resolve via `electron/imf/imf_direct_engine.js` (FFmpeg `-f imf` → MJPEG → canvas). **Reduced-resolution playback is already built** (`_qualityToLowres`: full=0/half=1/quarter=2/auto=1; `?q=` param; live stream-restart on change). In-code measurements: half ≈ 40 fps HD (clears 23.976); full = "may drop below realtime". **Root cause: the default playback quality is `full` (lowres 0)** — so it decodes full-res on CPU and stutters. Not a missing feature; a default. **Quick win (C-RT1a):** default playback to `auto`/`half`, full only on pause/scrub-stop, with an Auto/Full/Half/Quarter toggle. Then: adaptive auto (C-RT1b), FFmpeg threading (C-RT1c), HTJ2K streaming via `imf_htj2k_backend.js` (C-RT1d), and fix the misleading "Decode: Hardware (VideoToolbox)" HUD for J2K (C-RT1e).

---

## 3. Prioritized next actions (what the team should pick up)
1. **Real-time playback quick win (C-RT1a):** flip the default playback quality from `full` to `auto`/`half` (full only on pause/scrub-stop) + add an Auto/Full/Half/Quarter toggle. Near-trivial; gives ~40 fps HD immediately using existing machinery.
2. **IAB tab quick win (FIX 1):** read ADM names from attributes + drive OBJECTS/BEDS from element counts → tab populates for Meridian-class packages. See `PostFlowX_IAB_Handoff.md`.
3. **Real-time follow-ups:** adaptive `auto` (C-RT1b), FFmpeg threading (C-RT1c), HTJ2K continuous streaming (C-RT1d), fix VideoToolbox HUD label (C-RT1e).
4. **IAB pure-bitstream (FIX 2):** ST 2098-2 parser for packages with no ADM XML (BLR23/SOSYALCLIM). Needs that sample + asdcplib Dolby IAB fork (native).
5. **C1/C2 finish:** unify the engine-routing protocol in native JS; route `seekFrame`/`planStill` through the renderer player; confirm frame-accurate landing on live media.
6. **D1 live-wire (~20 lines):** connect the watch-folder controller to Electron `fs.watch` + the one-click proposal prompt.
7. **VFX pull perf:** collapse per-still OCF renders into one handle-range batch render.
8. **Perf (later):** native arm64 NEON OpenJPH decoder for full-res UHD real-time; Kakadu as the optional paid engine.

---

## 4. Build, verify & test
**Sandbox-safe verification (CI / any machine):**
```bash
npm run build-verify       # = test:node && test:js && (cd companion && pytest)
# current baseline: node 0 fail · ~39 js files · pytest green
node --check <file>        # changed JS
python3 -m py_compile <f>  # changed Python
```
**macOS native build (Mac with Xcode only — see `BUILD_MAC_RUNBOOK.md`):**
```bash
npm run build:avf          # swiftc → electron/native/avf_bridge (universal)
npm run build:renderer     # src/ → dist/desktop/
npm run build:mac-dir      # unsigned local .app
npm run build:mac          # signed/notarized release (needs Developer ID + Apple creds)
```
> Rule: never edit `dist/**` or compiled binaries — change `src/`/`electron/`/`companion/` and rebuild.

---

## 5. Conventions & guardrails
- **No git in this working copy** — keep changes reversible; back up under `_cleanup_backup_<date>/` before large edits.
- **Errors** must carry `{code, message, userMessage, retryable}` and a single next step (non-tech UX).
- **Security:** defused XML everywhere (`safe_xml.py`); confine all file paths from renderer/IPC (`_confined_join`); escape file/error-derived `innerHTML` (`_escHtml`). Open audit follow-ups tracked in `PostFlowX_Audit_Report.md` (notably: sweep remaining `innerHTML` sinks, scope `readFile/writeFile` to roots, confirm renderer CSP).
- **macOS reality:** J2K has no GPU decode on Apple Silicon — CPU (OpenJPH/OpenJPEG) or licensed Kakadu only. ProRes/HEVC/H.264 → AVFoundation; HDR render → Metal (libplacebo/MoltenVK).

---

## 6. Supporting documents (in source root)
- `PostFlowX_Technical_Strategy.md` — full competitive + technical strategy (macOS-only).
- `PostFlowX_IMF_Realtime_Design.md` — real-time IMF decode design + Epic C-RT.
- `PostFlowX_IAB_Handoff.md` — IAB (Dolby Atmos) decode/display ticket: diagnosis + three-fix plan + fixtures.
- `PostFlowX_Nightly_Backlog.md` — full backlog + progress log (per-item status).
- `PostFlowX_Audit_Report.md` — security audit findings + open follow-ups.
- `BUILD_MAC_RUNBOOK.md` — Mac-side build/sign/notarize steps.
- `PROJECT_MAP.md` — repo tree and runtime-target differences.
