# PostFlowX — Nightly Implementation Backlog & Progress Log

**Platform:** macOS only (Apple Silicon–first).
**Source root:** `/Users/psangchod/Documents/PostFlowX_2.5/PostFlowX_Desktop` (this folder — the real source tree, NOT `dist/`).
**Reference:** `PostFlowX_Technical_Strategy.md` (same folder).

> The codebase is more complete than the early scaffold suggested. Do NOT assume stubs — **inventory first** (see Night-1 task). Advance and harden what exists; fill genuine gaps.

## Repo layout (real)
- `src/scripts/features/` — feature modules incl. `vfxPull/`, `ocf_engine/`, `edl/`, `cutdiff2/`, `aceslook/`, `tl_convert/`.
- `src/scripts/parsers/` — `edl.js`, `fcpxml.js`, `otio.js`, `aaf_wasm.js`, `ale.js`, `prproj.js`.
- `src/sandbox/` — `j2k_decoder.{html,js}` (in-renderer J2K decode).
- `electron/native/` — `avf_bridge` (binary) + `avf_bridge.swift` (source), `media_engine.js`, `mpv_engine.js`, `native_router.js`, `smart_router.js`, `ffbins.js`, `resolve_bridge.py`.
- `electron/` — `main.js`, `preload.js`, `ipc.js`, `companion.js`.
- `companion/` — Python companion (`companion_server.py`, `src/postflowx_companion/`, `ocf_exr_handler.js`, `resolve_scripts/`).
- `test/` — node `--test` suites: `parsers/`, `pipeline/`, `color/`. `tests-js/` — ~30 `*.test.mjs`. `companion/tests/` — pytest.

## Build/test commands (real, from package.json)
- Build-verify (sandbox-safe): `npm run test:node` (node --test parsers/pipeline/color), `npm run test:js`, and `cd companion && python3 -m pytest -q`. Full: `npm test`.
- `node --check <file>` for changed JS; `python3 -m py_compile` for changed Python.
- macOS-only (NOT runnable in sandbox → delegate to Claude Code terminal on the Mac): `npm run build:avf` (swiftc), `npm run build:renderer`, `npm run build:mac` / `build:mac-dir` (electron-builder), sign/notarize.

---

## Working agreement for the nightly session
1. Read this file fully + `PostFlowX_Technical_Strategy.md`.
2. **No git here** — before edits, ensure a safety copy of files you'll change exists under `_cleanup_backup_<date>/` or note originals; keep changes reversible.
3. Edit REAL source. Never edit `dist/` (build output) or compiled `avf_bridge`. Native Swift goes in `avf_bridge.swift` (compiled on the Mac, not here).
4. Implement the next backlog item(s) that fit one session (priority A→B→C→D, plus nightly E build+audit).
5. Where a step needs swiftc/electron-builder/Kakadu/signing, write the JS/Python/Swift source + `# TODO(build-mac):` and leave it for the terminal build.
6. BUILD-VERIFY (Step 4 below). End the night green.
7. AUDIT (Step 5 below) → `PostFlowX_Audit_Report.md`.
8. Update this log + write `PostFlowX_Morning_Report.md`. Be concise.

### Build step (sandbox)
- `node --check` changed JS; `python3 -m py_compile` changed Python.
- Run `npm run test:node`, `npm run test:js`, `cd companion && python3 -m pytest -q`. Add tests for new code.
- Record the macOS native build as a terminal hand-off, never as "done" here.

### Audit step
- Review changed code: correctness, error handling (`userMessage`+`retryable`), input validation, no `dist/`/binary edits.
- Security (media tool): path traversal in folder walks/pickers, unsafe subprocess/`shell=True`, unvalidated paths from renderer/IPC, XML parsing of CPL/PKL/ASSETMAP (defuse XXE), temp files, secret/log leakage. `electron/preload.js` + `ipc.js` contextBridge surface.
- Rotate one existing area per night. Findings → `PostFlowX_Audit_Report.md` (severity, file:line, fix). Fix highs you touched; log rest under Epic E.

---

## Backlog (priority order — macOS only)

### Night 1 — INVENTORY (do this first, before other epics)
- [x] N1. Inventory done 2026-06-27 — see Progress Log for full WORKS/PARTIAL/MISSING map. Items below annotated to match reality.

### Epic A — IMF Validation
- [x] A1. WORKS — 70+ CPL/PKL/ASSETMAP rules, hash verify, edit-rate, Photon JAR runner, plain-language UI. XXE: **fully hardened 2026-06-27** via zero-dep `safe_xml.py` (rejects DOCTYPE/ENTITY) across ALL companion XML parse sites — `imf_scan.py`, `imf_qc.py`, `imf_package_resolver.py`, `proxy_service.py` (CPL/ASSETMAP + DoVi), `conform_engine.py` (FCPXML), `api.py` (ADM/IAB). 0 raw `ET.parse/fromstring` left.
- [x] A2. WORKS — validation surfaced via `pfxPlatform.imf.runPhoton`.

### Epic A-IAB — IAB (Dolby Atmos) immersive decode + Resolve-style display  *(NEW — user priority)*
> Goal: IAB tab must populate PROFILE/BEDS/OBJECTS/GROUPS and show an immersive track view (bed + Object 1..N) like DaVinci Resolve. Root cause confirmed below.
- [ ] A-IAB0 (ROOT CAUSE — partly confirmed 2026-06-28). `_inspect_iab_asset`→`_extract_embedded_adm_xml` (`companion/.../api.py:6591/6705`) only scans the MXF for **ADM XML** (`<ebuCoreMain>`/`<audioFormatExtended>`) = S-ADM (ST 2067-203). **Two IAB classes:** (a) IAB WITH embedded S-ADM (e.g. Meridian below — 294 `audioObject` in the tail) → existing scan *should* populate; if tab still empty, bug is asset-resolution/UI not parser; (b) pure IAB ST 2098-2 (no ADM XML, e.g. BLR23/SOSYALCLIM where A1 shows "PCM") → nothing to scan → needs the new bitstream parser.
- [x] A-IAB0b (BISECT — done 2026-06-28, sandbox). Ran the backward-scan on the Meridian fixture: **extraction WORKS** — 105 KB ADM XML, elements present (audioProgramme=1, audioContent=4, audioObject=49, audioPackFormat=49, audioTrackFormat=58). BUT name collection returned **[]**. Root cause #1 isolated: `_collect_named_nodes(root,"audioObject","audioObjectName")` searches for a CHILD element, but EBU ADM stores the name as an **attribute** on `<audioObject>` → `objectSummary.totalObjects = len(object_names) = 0` → IAB tab underpopulates even though 49 objects exist. (Earlier raw 294 count = byte grep over tail incl. start/end tags + index; true parsed count = 49.)
- [ ] A-IAB0c (QUICK FIX — ADM packages). Read `audioObjectName`/`audioContentName`/`audioPackFormatName` from element **attributes** (fallback to child element + `@*[local-name()=...]`); drive UI OBJECTS/BEDS/GROUPS from element counts (`admStats`) not just named lists. Derive bed layout from `audioPackFormat`/`typeLabel` (DirectSpeakers) vs objects (Objects). Add a test on the Meridian fixture asserting 49 objects surface. This makes the tab populate for ADM-bearing IAB (Meridian) immediately.
- [ ] A-IAB1. Implement an **ST 2098-2 IAB bitstream parser** (pure Python, NO Dolby license needed for metadata): demux IAB frames from the MXF essence, parse IAFrame header (sampleRate/bitDepth/frameRate) + sub-elements — `BedDefinition` (channel layout + speaker labels: 7.1.2/7.1.4/9.1.6), `ObjectDefinition` (object count, gain, x/y/z position, snap/zone), groups, bitstream profile/level. Return into the fields `_inspect_iab_asset` already shapes.
- [ ] A-IAB2. Carriage detection + routing: classify IAB vs S-ADM vs MGA (ST 2127) and route — IAB→new bitstream parser; S-ADM→existing XML path. Label correctly in UI (`imf_iab_labels.js` already has IAB/MGA labels).
- [ ] A-IAB3. **Resolve-style immersive track view** (renderer `imf_ui.js` IAB tab): expand the bed into its speaker channels + list Object 1..N rows using the existing TYPE/#/NAME/LAYOUT/CH/GAIN/RENDER TARGET/QC columns. Drive from A-IAB1 metadata.
- [ ] A-IAB4 (audio playback — needs decoder). Per-object/bed PCM for play/explode = Dolby IAB decoder/renderer or asdcplib **Dolby IAB fork** (`DolbyLaboratories-dolby/imf_iab_implementation`), or reuse the existing `_find_iab_decoder_adapter`/Resolve-engine path. Metadata display (A-IAB1..3) works WITHOUT this. `# TODO(native): bundle asdcplib Dolby IAB fork / Dolby decoder` `# TODO(build-mac)`.
- [ ] A-IAB5. Tests: IAB parser against the **Meridian fixture** — `/Users/psangchod/Movies/NMD/20230311_IMF Sample for Backlot New UI/3_audio supplemental/Meridian_tst_HD_23.976fps_HDRIAB_audio supplemental/IAB_c6faac8a-1ba5-4247-9db1-c79b251ac59f.mxf` (CPL declares IABEssenceDescriptor / ST 2067-201; tail has embedded S-ADM: ebuCoreMain + 294 audioObject). Use it for A-IAB0b bisect + golden tests (bed layout, object count, gains). ⚠ A pure-bitstream IAB sample (no ADM) is still needed to validate A-IAB1 — ask Mai for the BLR23/SOSYALCLIM package.

### Epic B — VFX Pull
- [x] B1. WORKS — OCF probe + tc/reel/clipname/duration conform, handles, source-TC map.
- [x] B2. WORKS — non-blocking EXR job, Resolve→OIIO→FFmpeg, ACES2065-1 + IDT, progress/QC.
- [x] B3. WORKS — pull manifest JSON + CSV/EDL/XLSX + sidecars (AMF/FDL/geometry).
- [x] B4. OCF still preview LIVE-VERIFIED 2026-06-27 (Resolve connected, drive mounted). Preload fix CONFIRMED working: companion `ok:true`+dataURL reaches renderer; QT REF strip decodes; OCF Resolve tier renders + black-frame rejection correctly catches black. **Root cause of black OCF = Resolve cannot decode/debayer the ARRIRAW**, NOT a PostFlowX bug: Resolve log `SyManager WARN Failed to <Read and convert frame 0:0 for mediapool clip>` + repeated `GPUDetect ERROR Failed to query IOKit monitor information`; ffprobe shows the 7.3GB MXF video essence = `codec_name=unknown`/`width=0` ("could not resolve file descriptor strong ref"). Improved the black-frame UI message to be RAW-decode-aware. ⚠ Still open: batch-render perf (planOcfBatchRender built+tested; companion `resolveStillBatch` action = live). Note: `PostFlowX_Preview_Temp` scratch project has 42 stale timelines — cleanup not firing; worth a sweep.

### Epic C — Playback engine routing  *(weakest epic — main remaining work)*
- [ ] C1. PARTIAL — ProRes→AVF and J2K/IMF 4-tier provider exist, but the codec→engine decision lives in the Python companion (`smart_router.js` only dispatches). Unify + document one routing protocol in native; verify the Python selection logic.
- [~] C2. Parity MODEL DONE 2026-06-27 — `electron/native/seekModel.js` (pure, CJS, 39 tests): `normalizeToFrame`, `frameToSeconds` (MID-frame `(f+0.5)/fps`), `secondsToFrame` (floor — tests caught a round-vs-floor off-by-one), `toEngineSeek` (mpv→seconds/avf→frame), `stepFrame`, `planStill` (thumbnail parity: avf→frame-native, mpv→ffmpeg at the SAME mid-frame time the seek lands → still matches displayed frame). Wired `media.mpv.seekFrame` into `mpv_engine.js`. ⚠ Remaining (needs live media): confirm landed frame on real playback; route `seekFrame`/`planStill` through the renderer player + wire mpv-still ffmpeg fallback.

### Epic C-RT — IMF real-time decode (NO Resolve) — see `PostFlowX_IMF_Realtime_Design.md`
> Goal: sustain package fps at UHD on Apple Silicon CPU (no GPU J2K). Reduce-level decode + HTJ2K already EXIST in the WASM path — the work is making *continuous playback* use them and adding a native fast path. Audit C-RT0 FIRST — it decides how far we are.
- [x] C-RT0 (AUDIT — done 2026-06-28). Continuous playback = `electron/imf/imf_direct_engine.js`: single FFmpeg `-f imf` → MJPEG → canvas. **Reduced-res playback ALREADY built** (`_qualityToLowres`: full=0/half=1/quarter=2/auto=1; `?q=` param; stream-restart on change). In-code measurements: half ≈ 40fps HD (clears 23.976); full = "may drop below realtime". **ROOT CAUSE: default quality = 'full' (lowres 0)** — player sends `quality: this._quality`, engine falls back to 'full'. So it decodes full-res on CPU → not real-time. HTJ2K (`imf_htj2k_backend.js`/OpenJPH) is used for scrub, NOT for the continuous stream (that's FFmpeg/libopenjpeg).
- [ ] C-RT1a (QUICK WIN). Default playback to `auto`/`half` (full only on pause/scrub-stop). Add Auto/Full/Half/Quarter toggle in the IMF Playback tab (default Auto). Machinery exists — this is the immediate real-time fix.
- [ ] C-RT1b. Make `auto` adaptive (not a half alias): start half, measure sustained fps vs package fps, step reduce-level to hold real-time, snap to full on pause. UHD likely needs quarter.
- [ ] C-RT1c. Add FFmpeg threading to the `-f imf` decode (`-threads`, frame/slice threading) — biggest CPU lever after reduce-level.
- [ ] C-RT1d. HTJ2K fast path for continuous play: for HT codestreams feed OpenJPH (`imf_htj2k_backend.js`) frames into the MJPEG sink instead of FFmpeg/libopenjpeg.
- [ ] C-RT1e. Fix misleading HUD: "Decode: Hardware (VideoToolbox)" shown for J2K/IMF — VT can't decode J2K; label CPU/OpenJPH for IMF.
- [ ] C-RT0-old (superseded by C-RT0 above). Determine which decode path *continuous playback* uses: the companion MJPEG stream (`imf_direct_engine`/ffmpeg) or the WASM sandbox pool (`imf_j2k.js`). For each, record: (a) is a reduced resolution level requested during play (vs full-res)? (b) is HTJ2K/OpenJPH (`ojph`) preferred over classic libopenjpeg when the codestream is HT? (c) measured fps at 2K and UHD on this machine. Write findings to the design note + Progress Log. This determines C-RT1..4 scope.
- [ ] C-RT1. Resolution-level playback policy: during playback request reduce level (e.g. half/quarter) for real-time, full-res on pause/scrub-stop. Extend `_reduceLevelFromScale` (currently only scale≤0.25→reduce2) to a proper level ladder (0.5→1, 0.25→2, 0.125→3) and make the player pass a playback `scale`. Expose a quality toggle (Auto/Full/Half/Quarter).
- [ ] C-RT2. HTJ2K routing: confirm HT codestreams always hit OpenJPH (`decodeHTBytes`/`ojph_expand`), classic only for Part-1. Add a probe + log which backend served each frame; surface in HUD.
- [ ] C-RT3. Decode-ahead buffer: prefetch N frames during playback sized to the decoder pool + fps; tune lane count to P-cores. Verify no main-thread decode.
- [ ] C-RT4. Native NEON decoder (perf): scaffold a companion/native arm64 OpenJPH/OpenJPEG (NEON SIMD + threads) as a faster alternative to WASM for UHD. `# TODO(build-mac): native decoder build`. Keep Kakadu as the optional paid "guaranteed real-time UHD" engine behind the engine abstraction.
- [ ] C-RT5. Audio sync + A/V clock for continuous playback (PCM from MXF) so real-time play stays locked, not just frame stepping.

### Epic D — Automation for non-tech users
- [~] D1. Brain DONE 2026-06-27 (63 tests) — `proposeAction.js` (classify→ONE action, 25) + `settleBatch.js` (debounce + ignore-filter, 22) + `watchController.js` (orchestration: events→batch→settle→propose→sink, all deps injected, 16). ⚠ Remaining = ONLY the ~20-line live-wire (needs running app): Electron `fs.watch` → `ctl.onFsEvent(path)`; `ctl.start()`; `onProposal` → one-click prompt that switches to `proposal.tab`. Adapter sketch is in `watchController.js` header.
- [x] D2. DONE 2026-06-27 — Shareable `.pfxpreset` import/export (`serializePresets`/`parsePresetsFile`/`exportPreset`/`exportAllPresets`/`importPresets`, versioned + whitelist sanitizer + collision skip/overwrite) **and** a bundled starter library (`defaultPresets.js`: 6 presets — ARRI/Sony/RED→ACES pulls, HDR P3-D65 PQ1000, HDR Rec.2100 PQ, SDR Rec.709; `seedDefaultPresets()` idempotent). `PresetSaveModal` gets Starter/Import…/Export-all buttons. 59 unit tests incl. validity of every bundled preset against the real transform registry + mode defaults. ⚠ Remaining (lower value): parity for non-aceslook presets (burn-in, shortcuts).
- [x] D3. WORKS — `userMessage`+`retryable`+next-step widely deployed (companion `ErrorPayload`, `render_queue._parseError`, readiness checks).
- [x] D4. WORKS — plain-language job queue/progress (ETA, retry≤3, history, system stats).

### Epic E — Build & Audit (every night)
- [x] E1. DONE 2026-06-27 — `npm run build-verify` = `test:node && test:js && (cd companion && pytest)`. Running it caught a pre-existing red: `test/color/fdl.test.mjs` imported `vfxPull/ascFdl.js` (archived deadcode 2026-06-26; live FDL uses `fdlGenerator.js`'s different API). Moved the obsolete test → `_deadcode_archive_2026-06-26/`. build-verify now green (node 0 fail · 39 js files · pytest 126). ⚠ Follow-up (E2): `fdlGenerator.js` has NO golden/pixel-accuracy tests — the archived ascFdl test's coverage was lost; port equivalent golden tests to the live generator.
- [ ] E2. Tests for new modules.
- [ ] E3. Security hardening pass (defused XML, subprocess, IPC/path validation).
- [ ] E4. Maintain `BUILD_MAC_RUNBOOK.md` — the Mac-side build/sign/notarize steps for the Claude Code terminal.
- [~] E_rolling. First pass DONE 2026-06-27 → `PostFlowX_Audit_Report.md`. Area: Electron IPC/preload + subprocess/path. Clean: no shell injection, `deleteProject` confined, `openExternal` http(s)-only. Medium finding: inconsistent `innerHTML` escaping (DOM-XSS via maliciously-named files, elevated by unconfined `readFile`/`writeFile`). Fixed 3 file/error-derived sinks in `prep_mark.js` via new `_escHtml` (+ `tests-js/escHtml.test.mjs`, 8 tests). Open follow-ups logged in the report: triage `ui.js:3690`/`cutdiff:4165`/`vfxPullPanel:355`, sweep all 575 innerHTML sinks, scope readFile/writeFile to roots, confirm renderer CSP.

---

## Progress Log
_(Newest on top. First nightly run starts here.)_

### 2026-06-27 — Night-1 INVENTORY + OCF preview fixes
**Method:** read-only fan-out across each epic (src/ + companion/ + electron/, ignoring dist/). Headline: the codebase is **far more complete than this backlog's empty log implied** — most of A/B/D is already built. The real remaining work is C (playback parity), XXE hardening, and a few polish gaps.

**Inventory verdicts (WORKS / PARTIAL / MISSING):**
- **A1** IMF validation — **WORKS.** 70+ rules over CPL/PKL/ASSETMAP (`src/scripts/modules/imf/imf_validator.js`), SHA-1/256 hash verify, 12 SMPTE edit-rate set, Photon JAR runner (`electron/imf/imf_photon.js`), plain-language `{sev,code,msg,detail}` + colored UI. **Gap: Python companion XML is not XXE-hardened** (`imf_scan.py` uses raw `ET.fromstring`).
- **A2** validation → UI via native cmd — **WORKS** (`imf_ui.js` ↔ `pfxPlatform.imf.runPhoton`).
- **B1** OCF probe + conform — **WORKS** (`api.py:2099+` ffprobe TC/reel/fps/camera; tc/reel/clipname/duration match; handles; source-TC map).
- **B2** EXR export job — **WORKS** (`api.py:3693+` non-blocking job, Resolve→OIIO→FFmpeg, ACES2065-1 + IDT, progress poll, QC).
- **B3** pull manifest — **WORKS** (`smartExrReportExporter.js` JSON + CSV/EDL/XLSX; `pullJobModel.js` frame map; `_write_pull_sidecars` AMF/FDL/geometry).
- **B-preview** OCF still preview — **FUNCTIONAL** (3-tier). Two open items: (1) live-verify end-to-end with Resolve connected + OCF drive mounted; (2) batch-render perf (7 separate stills → one handle-range render). See [[postflowx-ocf-preview-perf]].
- **C1** engine routing — **PARTIAL.** ProRes→AVF, J2K/IMF→4-tier provider exist (`media_engine.js`, `imf_frame_provider.js`), but the actual codec→engine *decision* is delegated to the Python companion (`smart_router.js` only dispatches) and isn't unified/documented in native JS.
- **C2** frame-accurate seek/step/thumbnail parity — **MISSING/PARTIAL** (the weakest epic). `media_engine.seek/stepFrame` are state-only; mpv `seek` takes seconds not frames; mpv has step but no thumbnail; AVF has thumbnail but no native step. No single unified frame API across engines.
- **D1** watch-folder auto-detect — **PARTIAL** (exists in After Effects scripts `amf_convert.js:5002+`; no Desktop/extension watch UI).
- **D2** shareable JSON presets — **PARTIAL** (aceslook `presetService.js` saves to localStorage only; no `.pfxpreset` file import/export; no bundled IMF-QC/ARRI/ProRes library).
- **D3** guided error recovery — **WORKS** (companion `ErrorPayload{code,message,userMessage,retryable}`; `render_queue.js:_parseError` recovery hints + readiness `{ready,reason,action}`; widely used).
- **D4** plain-language job queue/progress — **WORKS** (`render_queue.js` persistent jobs, ETA, retry≤3, history, system stats).
- **E1** build-verify wrapper — **PARTIAL** (chain exists via `npm test` = node+js+pytest+adobe; no single `build-verify` script).
- **E2** tests — **WORKS** (36 `tests-js/*`, `test/{parsers,pipeline,color}`, 16 companion pytest entries).
- **E3** security hardening — **PARTIAL** (JS DOMParser XXE-safe; **Python XML not defused** — 5 files raw `ET.fromstring`).
- **E4** BUILD_MAC_RUNBOOK.md — **WORKS** (present).
- **E_rolling** rotating audit — **MISSING** (no `PostFlowX_Audit_Report.md` yet).

**Rough per-epic completion:** A ~90% · B ~90% (preview perf/verify open) · C ~50% (real parity gaps) · D ~75% · E ~65%.

**This session's actual code work (VFX Pull / Epic B + D3):**
- Fixed a critical bug: desktop `chrome.runtime.sendMessage` shim (`electron/preload.js`) returned `undefined`, so vfxPull's OCF-preview companion tiers never received responses → bogus `companion_error`. Now returns a Promise (MV3 semantics). This is what made the Resolve/AVF/FFmpeg preview tiers work at all.
- Hardened OCF preview error reporting (D3): real stage classification (`render_timeout`/`companion_down`/`companion_error` vs the old generic `resolve_failed`) + JSON-serialized renderer logs (were `[object Object]`).
- UI polish (off-roadmap): de-colored all tabs to a muted palette, removed the SHOT LIST drop-zone, balanced the top bar.
- Build: renderer rebuilt + arm64-only repackage each change (verified sealed in app.asar). `node --check` clean. Native builds = arm64-only path per [[postflowx-arm64-build]].

**Top of next backlog (priority):** C2 frame-accurate seek/step parity → B live-verify + batch-render perf → D1 watcher+UI wiring (proposal core done) → E_rolling audit cadence. (D2 incl. bundled library, all XXE hardening, E1 build-verify all DONE; D1 proposal core DONE — see cont. entries below.) **All cleanly headless-verifiable backlog items are now complete; the rest need a live app (running UI + media + Resolve).**

### 2026-06-27 (cont. 6) — E1 build-verify + pre-existing red fixed
- Added `npm run build-verify` (sandbox-safe chain: node tests + js suite + companion pytest).
- It surfaced a pre-existing failure: `test/color/fdl.test.mjs` → `import ... ascFdl.js` (archived 2026-06-26, 0 live importers; product uses `fdlGenerator.js`). Moved the obsolete test into the deadcode archive.
- `npm run build-verify` now exits 0 (node 0 fail · 39 js files · pytest 126 passed). No repackage (dev script + test move only).
- NEW follow-up logged: live `fdlGenerator.js` lacks the golden/pixel-accuracy coverage the archived test had → port it (E2).

### 2026-06-27 (cont. 7) — FDL generator test coverage (E2)
- Found the archived `ascFdl.js` (framing-geometry FDL) and the live `fdlGenerator.js` (pull-plan FDL: frame ranges, reformat scale, color) are DIFFERENT features — so this is NEW coverage for the live module, not a 1:1 port.
- Added `tests-js/fdlGenerator.test.mjs` — 32 golden assertions: scale math (`min(refW/srcW,refH/srcH)` 4dp, incl. 4608x3164→3840x2160=0.6827), frame-range (start+frames-1), aces→`ACES2065-1 AP0`, AMF precedence, explicit reformat crop/cropBox passthrough, JSON round-trip, CSV header+comma-escaping, TXT block, sparse defaults. Avoids the only non-deterministic field (`meta.generatedAt`).
- `npm run build-verify` green (40 js files · node 0 fail · pytest 126). Test-only, no repackage.
- The live `fdlGenerator` now has coverage; the archived ascFdl's framing-geometry math (anamorphic squeeze, 2.39 scope pixel-accuracy) remains uncovered because that code is no longer in the product — restore only if framing-geometry FDL is re-introduced.

### 2026-06-27 (cont. 11) — audit area 2: path traversal + XSS sweep
- XSS sweep (renderer-wide): fixed 3 more untrusted innerHTML sinks (`imf_ui.js` ×2 IAB QC, `markerProxySettings.js` ×1 media-root path); confirmed cutdiff/vfxPullPanel safe (literals). 7 sinks fixed total across the audit.
- **Path traversal (Medium) found + fixed:** companion EXR/AMF delivery wrote to `os.path.join(output_dir, shotName, …)` and used renderer `outputPattern` unsanitized → `../` escapes. Added `_safe_name_component` + `_confined_join` (realpath/commonpath) + `_safe_output_pattern`; applied in `_ocf_copy_exr_delivery` + both render `outputPattern` reads. No archive extraction anywhere (zip-slip not a vector). `companion/tests/test_path_confinement.py` (6 tests) → suite 132 passed. Both audit areas documented in `PostFlowX_Audit_Report.md`. Repackaged + verified sealed.

### 2026-06-27 (cont. 13) — C2 frame-accurate seek model + mpv frame-seek
- `electron/native/seekModel.js` (pure CJS): canonical frame normalization + per-engine seek args. mpv had no frame-seek; the fix is a MID-frame absolute time `(frame+0.5)/fps` that lands inside the target frame (AVF is frame-native). `secondsToFrame` uses floor (frame N = `[N/fps,(N+1)/fps)`); the test suite caught my initial `round` which broke the round-trip at the half-frame boundary.
- `tests-js/seekModel.test.mjs`: 31 assertions incl. mid-frame round-trip across 24/23.976/25/29.97/30/59.94, TC-relative-to-startTC, per-engine args, step clamping.
- Wired `media.mpv.seekFrame` into `mpv_engine.js` (require seekModel; HANDLED + route). Verified it loads/handles. Repackaged + sealed (electron is asar-packed).
- Remaining is live-only: confirm the landed frame on real playback + AVF thumbnail-by-frame parity + renderer player routing. This is the first real dent in C2 (the ~50% epic).

### 2026-06-27 (cont. 21) — OCF→IDT auto-detect + ASC FDL v2.0 (ocf_vfxpull_aceslook prompt)
- Executed `/Users/psangchod/Documents/Cowork/ocf_vfxpull_aceslook_prompt.md`, adapted to PostFlowX reality (prompt assumed dist/ edits + CommonJS + electron/ocf SDK; actual: edit src/ + ESM + ocf_engine at features/ocf_engine).
- **Phase 1** `features/aceslook/services/ocfIdtResolver.js` (new, ESM): `resolveIdtFromOCFMeta`/`resolveIdtFromProbe`/`resolveIdtFromFilePath`/`listSupportedIdts` — IDT_MAP covering ARRI/RED/Sony/Panasonic/Canon/Blackmagic/DJI/Rec.709; trusts `defaultAcesIdt` URN first, else searches colorSpace/codec/camera; Rec.709 fallback + warning, never throws.
- **Phase 2** `colorPlanEngine.buildColorPlan` patched: when `job.ocfMeta` present and no user override, auto-fills `idtName`/`idtUrn` + new `idtAutoDetected`/`idtWarning`. Priority: user override > OCF > heuristic profile (guardrail honored).
- **Phase 3** `amfBuilder.buildAmf` patched: when IDT is unresolved/AUTO and `state.ocfMeta` present, emits the OCF-resolved IDT URN + label in `<aces:inputTransform>`. `acesLookValidation` now accepts `AUTO` when `ocfMeta` present.
- **Phase 4** `fdlGenerator.generateASCFDLv2()` (new export): standards `https://www.ascfdl.org/schema/v2.0/fdl.json` (version 2.0, uuid via crypto.randomUUID, canvases[], framingDecisions[]), embeds OCF IDT label. Old `buildFDL` (proprietary v1) kept.
- **Verify:** `tests-js/ocfIdtResolver.test.mjs` (31 assertions, all phases) + dist smoke 6/6 cameras. `build-verify` 49 js · pytest 132. Built + repackaged + sealed.
- **Deviations from prompt:** Phase 5 IPC handlers SKIPPED — resolver + VFX Pull UI are both renderer-side, so the UI imports the resolver directly (no IPC/CJS-main bridge needed). Phase 7 asar-pack replaced by standard electron-builder arm64.
- **Phase 6 UI badge DONE (cont. 22):** `vfxPullPanel` IDT badge now shows `🎬` + green `.pm-vfx-pull-badge--auto` when `colorPlan.idtAutoDetected`, with the auto/warning surfaced in the tooltip; detail Camera/Color row appends `· 🎬 Auto (OCF)`. Syntax-checked, build-verify green (pytest 132), repackaged + sealed (4 refs in asar). Visual render needs the live app to confirm.

### 2026-06-27 (cont. 39) — fix: black OCF preview for camera-RAW (X-OCN) — render-queue fallback
- LIVE TEST proved the X-OCN file plays fine in Resolve directly → black preview = PFX companion bug, not Resolve/file.
- Root cause: `_ocf_extract_via_resolve` uses `project.ExportCurrentFrameAsStill` (grabs the timeline VIEWER frame), which is BLACK for camera-RAW when Resolve runs headless/background and the viewer hasn't decoded the frame. The render-queue fallback (a real render = forces full decode) only fired when NO file was produced — a black file slipped through. Also: companion python = `/opt/homebrew/bin/python3` which LACKS PIL, so every PIL-based black check was a silent no-op (black shipped; only the renderer's canvas check caught it).
- Fix: (a) `_still_avg_luma_ffmpeg()` — PIL-free luma via ffmpeg `scale=1:1 → gray`; (b) after `ExportCurrentFrameAsStill`, if the still is black, discard it and fall through to the render-queue render; (c) final black check now uses ffmpeg when PIL is absent (so a still-black result reports `black_frame` retryable correctly).
- compiles; build-verify 145 pytest green; repackaged + sealed. **Awaiting live re-test** (reload app → preview an X-OCN shot → should now render via the queue instead of black).

### 2026-06-27 (cont. 38) — fix: scratch-project preview-timeline GC (the 42-timeline leak)
- Root cause: `_ocf_extract_via_resolve` keeps a warm timeline per clip in `self._ocf_tl_cache` (in-memory) and only evicts OTHER clips' timelines. Cache is empty at session start, so timelines left by prior sessions (and the resolve_bridge `PFX_Preview_*` path) were never evicted → accumulated (42 in `PostFlowX_Preview_Temp`).
- Fix: added a GC sweep at the top of each extraction — enumerates `project.GetTimelineByIndex`, deletes every `_is_preview_timeline_name()` timeline (`pfx_still_*`/`pfx_preview*`) that isn't a warm-cache entry or the current timeline. Cheap, idempotent, self-healing across sessions/both paths. Never touches user timelines.
- `_is_preview_timeline_name` is a pure, tested predicate (`tests/test_timeline_gc.py`, 2 tests — flags scratch names, never flags user names). build-verify 145 pytest green; repackaged + sealed (companion extraResources). Live-verify next: reload app, preview a few clips, confirm scratch timelines stop growing (and bulk-clears existing orphans).

### 2026-06-27 (cont. 37) — LIVE verification of OCF preview (Resolve connected)
- User opened the app with Resolve connected + Extreme SSD mounted → first true live verify of the OCF preview chain.
- ✅ Confirmed working: preload transport fix (renderer.log `[VFX Pull Preview Result] {"ok":true,"decoder":"Resolve Engine","imageUrl":"[dataUrl present]"}`), QT REF 7-frame strip decodes real frames, OCF Resolve tier renders end-to-end, black-frame rejection correctly fires (`rejected near-black frame from Resolve Engine`).
- ❌ OCF preview is BLACK because **Resolve can't decode the ARRIRAW**: davinci_resolve.log `Failed to <Read and convert frame 0:0 for mediapool clip>` + `GPUDetect ERROR Failed to query IOKit monitor information`; ffprobe → video essence `unknown`/0×0, "could not resolve file descriptor strong ref". Environmental (Resolve/GPU/this file), not a PFX code bug.
- Fix shipped: black-frame UI message now names the likely cause (Resolve RAW debayer failure / verify file plays in Resolve / offline / seek) instead of guessing "Media Offline". build-verify 143 pytest green; repackaged + sealed.
- Follow-ups: (a) sweep the `PostFlowX_Preview_Temp` scratch project (42 stale timelines — cleanup not firing); (b) user should confirm the .mxf plays in Resolve directly (if black there too → media/GPU, not PFX).

### 2026-06-27 (cont. 36) — companion-side test coverage (tc fuzz + safe_xml guard)
- `companion/tests/test_tc_helpers.py`: fuzz `_tc_to_frames`/`_frames_to_tc` round-trip (seeded) — 8 rates × 3000 samples (~24k), exact at all rates incl. 23.976/29.97/59.94 (both use nominal round(fps) base); + format/parsing/clamp checks. Were untested.
- `companion/tests/test_safe_xml.py`: permanent regression lock for the XXE guard — external-entity XXE + billion-laughs + bare DOCTYPE rejected, legit XML + comment-DOCTYPE parse, `read_xml`/`parse_path` (incl. file-based XXE rejection). Previously only verified via a one-off inline run.
- Companion pytest 132→**143**. `build-verify` green (XSS + XXE gates clean). No bugs surfaced — companion TC math verified robust.

### 2026-06-27 (cont. 35) — property/fuzz tests for core frame↔TC + seek math
- `tests-js/timecodeFuzz.test.mjs` (deterministic mulberry32 seed → reproducible): 23 property checks × 4000 samples each (~92k round-trips). NDF round-trip (`timecodeToFrames`/`framesToTimecode`) @ 24/25/30/50/60/23.976/29.97/59.94; **drop-frame round-trip @ 29.97 & 59.94** (the buggiest arithmetic); bare `tcToFrames`/`framesToTC` @ integer rates; seekModel `frameToSeconds`→`secondsToFrame` @ 8 rates. All pass → core timecode + seek math verified robust across the full input space (incl. DF). Explores boundaries golden tests miss (a golden test already caught seekModel's round/floor bug).
- `build-verify` 57 js · pytest 132 · both gates clean.

### 2026-06-27 (cont. 34) — security gates made testable + meta-tested (test-the-tests)
- Refactored `tools/scan-innerhtml.mjs` + `scan-rawxml.mjs`: extracted the gate predicates (`isGatedXssSink`, `isRawXmlParse`, `stripPy`) as exports and guarded the CLI run behind a `process.argv[1]` check so they're importable without side effects. CLI gates still run clean.
- `tests-js/securityGates.test.mjs`: 28 assertions locking the detection logic — XSS gate flags `${r.error}`/`${ev.clipName}` but not escaped/call/constant/numeric; XXE gate flags `ET.fromstring`/`minidom`/`lxml`/`xml.sax` but not `safe_xml.*`/`_ET`/json; `stripPy` removes comments/docstrings but keeps real code. Prevents silent gate rot.
- `build-verify` green: 56 js files · pytest 132 · XSS clean · XXE clean.

### 2026-06-27 (cont. 33) — PROJECT_MAP refreshed for the session's additions
- Added `build-verify`/`scan:xss` to the commands table and a new "Quality gates & tests" section: documents the build-verify chain (node+js+pytest+XSS gate+XXE gate), the extract-to-testable-leaf pattern (idtBadge/ocfErrorPane/ocfBatchPlan/seekModel/watchFolder), and the security-helper rules (escaper for innerHTML, safe_xml for companion XML). Corrected seekModel path (electron/native) + test count. Keeps the map navigable after ~30 changes this session.

### 2026-06-27 (cont. 32) — XXE regression GATE wired into build-verify (E3)
- `tools/scan-rawxml.mjs` (`--gate`): fails if any companion .py parses XML with a raw entrypoint (`ET.fromstring`/`ET.parse`/`minidom.parse`/`lxml`/`xml.sax`/`etree.parse`) bypassing `safe_xml`. Strips comments/docstrings; allowlists `safe_xml.py` itself.
- Verified: clean now (exit 0), catches a planted raw `ET.fromstring` (exit 1), clears on removal. Wired into `build-verify`.
- **`build-verify` now runs both security gates** (XSS + XXE) alongside node/js/pytest — the two vuln classes fixed this session are now both regression-locked. Full chain green: pytest 132 · 55 js · XSS clean · XXE clean.

### 2026-06-27 (cont. 31) — XSS regression GATE wired into build-verify (E3)
- Upgraded `tools/scan-innerhtml.mjs` with a precise `--gate` mode: flags only DIRECT untrusted-data interpolation into innerHTML (`${x.error}`, `${ev.clipName}`, …), skipping function-call wrappers (escaping is the callee's job), constant labels, and manual/`escapeHTML`/`_esc` escaping. Exits non-zero on any finding.
- Verified: gate is CLEAN on current code (exit 0); catches a planted `${r.error}` sink (exit 1); clears when removed. Then **wired `node tools/scan-innerhtml.mjs --gate` into `build-verify`** — the whole XSS class is now regression-locked at build time.
- `build-verify` green incl. gate (pytest 132, gate clean). This converts the one-off XSS audit into a permanent guardrail (Guardrail/E3).

### 2026-06-27 (cont. 30) — OCF preview batch-render planner (B perf) + XSS scan clean
- Verified (targeted scan): NO untrusted-data → innerHTML sinks remain anywhere in the renderer after all hardening + extractions. Verify panel `set()` uses textContent; `_set` innerHTML helper only gets numbers/escaped values.
- Built `features/vfxPull/ocfBatchPlan.js` (`planOcfBatchRender`, `batchRenderSavings`) — the testable core of the OCF preview perf fix (memory: 7 separate Resolve renders → 1). Collapses the 7 strip positions into one HdlSt→HdlEnd render + per-position frame offsets; clamps pre-clip handles to renderStart 0. `tests-js/ocfBatchPlan.test.mjs` 20 assertions. ⚠ Remaining (live): companion `resolveStillBatch` action + rewire the strip generator to one render. `build-verify` 55 js · pytest 132.

### 2026-06-27 (cont. 29) — OCF "engine-required" pane extracted + tested
- Extracted the "✓ linked correctly / Connect Resolve" RAW pane from `prep_mark` into `ocfErrorPane.buildOcfEngineRequiredHtml({rawLabel,isRaw})` (dead rawLabel/isRaw inline removed; prep_mark imports it). `ocfErrorPane.test.mjs` now 26 assertions (added 7: linked message, rawLabel render, start-resolve/retry buttons, camera-RAW hides "Try FFmpeg anyway" / non-RAW shows it, export-anyway hint, rawLabel escaping). ocfErrorPane leaf now holds 3 tested builders. build-verify 54 js · pytest 132. Sealed.
- **4 extract-and-test passes total** (idtBadge, ocf error pane, ocf strip cell, ocf engine-required) — escaping-carrying UI markup pulled out of prep_mark/vfxPullPanel into regression-locked leaves.

### 2026-06-27 (cont. 28) — OCF strip-cell HTML extracted + tested
- Extracted the failed strip-cell markup (label + stage/error) from `prep_mark` into `ocfErrorPane.buildOcfStripCellHtml({label,stage,error})`; prep_mark imports it (dead `stageLabel` var removed). `ocfErrorPane.test.mjs` now 19 assertions (added 6: label/stage/error rendering, unknown/empty → "decode error", full escaping of label+stage+error). build-verify 54 js · pytest 132. Sealed (2 builders in asar).

### 2026-06-27 (cont. 27) — OCF error-pane HTML extracted + tested
- Extracted the OCF preview "cannot be decoded" pane markup from `prep_mark` into testable leaf `features/vfxPull/ocfErrorPane.js` (`buildOcfErrorPaneHtml({stage, resolveConnected})`); prep_mark imports + uses it.
- `tests-js/ocfErrorPane.test.mjs`: 13 assertions — connected (stage shown + Test-Resolve button) vs disconnected (generic msg, no diag button), retry/ffmpeg always present, empty-stage handling, and **stage HTML-escaping** (malicious stage can't inject markup). `build-verify` 54 js · pytest 132. Built + repackaged + sealed.

### 2026-06-27 (cont. 26) — IDT badge extracted + tested (converts live-pending → verified)
- Extracted the OCF auto-IDT badge HTML builder out of `vfxPullPanel` into testable leaf `features/vfxPull/idtBadge.js` (`buildIdtBadgeHtml`, `idtShortToken`); vfxPullPanel now imports it (dead `idt` var removed).
- `tests-js/idtBadge.test.mjs`: 16 assertions — 🎬 + `--auto` class + OCF tooltip when auto-detected, plain badge otherwise, warning surfaced, **XSS escaping of a malicious idtName**, empty/null → ''. The badge logic (previously "needs live app to confirm") is now unit-verified; only the on-screen pixels remain live.
- `build-verify` 53 js · pytest 132. Built + repackaged + sealed.

### 2026-06-27 (cont. 25) — proResProxy cache-key coverage (E2) — pure-module coverage sweep COMPLETE
- `modules/proResProxy.js` `getProxyCacheKey`/`getCachedProxyForFile` (was untested) → `tests-js/proResProxy.test.mjs`: 9 assertions — key = `name(lc)|size|lastModified|`, cross-session stability (same file diff MIME → same key, the documented guarantee), size/name uniqueness, fileName alias + defaults, uncached→null.
- **Milestone:** every low-DOM, multi-export pure module in modules/ + core/ + parsers/ now has test coverage. `build-verify` 52 js · pytest 132. Remaining untested code is DOM/async-heavy UI (proResProxy DOM paths, amf_convert, project_setup, enterpriseOffline, big panels) — needs a DOM harness or the live app; low value-per-effort headless.

### 2026-06-27 (cont. 24) — shortcuts test coverage (E2)
- `core/shortcuts.js` (`isTypingTarget`, `captureComboFromEvent`, `eventComboVariants`, `comboToDisplay`, `resolveShortcutAction`, `computeCustomCount`; was untested) → `tests-js/shortcuts.test.mjs`: 31 assertions — typing-target detection, MOD/CTRL/SHIFT combo capture (macOS path via navigator polyfill), explicit+aliased variants, display formatting (Key/Digit/Numpad/Comma/Equal), action resolution (enabled/disabled/allowDisabled/unmapped), and custom-count diffing vs defaults. `navigator` defined via Object.defineProperty (read-only getter in Node 25); localStorage polyfilled. `build-verify` 51 js · pytest 132. Test-only.

### 2026-06-27 (cont. 23) — playbackRouter test coverage (C1 / E2)
- `core/playbackRouter.js` (`isProResCodec`, `proResDisplayName`, `selectPlaybackEngine`; was untested) → `tests-js/playbackRouter.test.mjs`: 20 assertions — ProRes detection (codec_name/codec_tag_string/PRORES_CODECS, case-insensitive), non-ProRes→chromium, and the full macOS engine ladder (nativeEngine > avfoundation > mpv) + off-macOS→proxy. `window.pfxPlatform` polyfilled per case. Advances C1 (routing decision now has verified coverage). `build-verify` 50 js · pytest 132. Test-only.

### 2026-06-27 (cont. 20) — mediaCache test coverage (E2)
- `core/mediaCache.js` (blob-URL reuse + refcount; was untested) now has `tests-js/mediaCache.test.mjs`: 20 assertions — `pfxFileSig` format/uniqueness, acquire dedup by signature (one createObjectURL per sig), refcount hold/release, unknown-url direct revoke, clear revokes all, and `pfxGetHandleFile` caches `handle.getFile()` (once, then cached; `force` refetches). URL.createObjectURL/revokeObjectURL polyfilled in-test. `build-verify` 48 js files · pytest 132. Test-only.

### 2026-06-27 (cont. 19) — markerClipMatcher test coverage (E2)
- `markerClipMatcher.js` (`buildClipsFromEvents`, `matchMarkersToTimelineClips`; was untested) now has `tests-js/markerClipMatcher.test.mjs`: 26 assertions — clip build (TC→frames, zero-length +1, reel fallback), and all match tiers: exact containment=100, half-open boundary (recOut→next clip), orphan=0, overlap-only=80, multi_match=50 with preferTrack(V1) winning over list order, and independent per-marker eval (dup ranges don't conflict). `build-verify` 47 js files · pytest 132. Test-only.

### 2026-06-27 (cont. 18) — OTIO export coverage + builder↔parser roundtrip (E2)
- `otio_export.js` (`buildOTIOJSON`; was untested) now has `tests-js/otioExport.test.mjs`: 31 assertions — Timeline/Stack/Track/Clip schema, TC→frame source/record ranges, ExternalReference target_url, embedded marker (offset = mkTC−srcIn, color map, metadata), vfxrename `_pmShot` naming, AND a full **roundtrip** (`buildOTIOJSON` → `parseOTIO` → identical clipName/srcIn/srcOut/projectName/fps, object + JSON-string input). Proves export↔import compatibility. `build-verify` 46 js files · pytest 132. Test-only.

### 2026-06-27 (cont. 17) — geometryEngine test coverage (E2)
- `geometryEngine.js` (VFX Pull framing/reframe — `extractGeometry`, `buildGeometrySidecar`; was untested) now has `tests-js/geometryEngine.test.mjs`: 32 golden assertions — crop math `crop=(W-L-R):(H-T-B):L:T`, scale-about-centre matrix (`scale=2 → [2,0,-2048,0,2,-1080,0,0,1]`), resolution-parse variants (string / {w,h} / fallbacks), NLE field aliases (zoomX/offsetX/crop l-r-t-b), resize-mode mapping, anamorphic PAR, sidecar defaults. All golden values correct first run. `build-verify` 45 js files · pytest 132. Test-only, no repackage.

### 2026-06-27 (cont. 16) — audit area 4: companion HTTP server → CLEAN
- Reviewed the localhost media HTTP server (:47125). Bind 127.0.0.1 (both modes), random per-run token + constant-time compare, path-traversal guards on every route, `/file/{assetId}` capability-URL (unguessable UUID, registered files only). Well-hardened — no fix. Note: don't leak `/file/` URLs externally. Audit now spans 4 areas (3 vuln classes fixed, 2 areas clean) + scan:xss tool. Review-only, no repackage.

### 2026-06-27 (cont. 15) — XSS scanner tool + 8th sink found/fixed
- `tools/scan-innerhtml.mjs` (`npm run scan:xss`): heuristic scanner for `innerHTML` interpolations not wrapped in an escaper (escaper-call-anywhere = safe; skips literals/numerics/data-URLs/icons). Durable regression aid.
- It found a sink my keyword grep missed: `aceslook/cards/SourceDetectionCard.js:15` interpolated the dropped **file name** unescaped → fixed (added local `_esc`). 8 XSS sinks fixed total.
- Remaining ~313 flagged candidates spot-checked safe-by-construction (escaped table fragments, numeric labels, app-constant ternaries). `build-verify` green (pytest 132). Repackaged + sealed.

### 2026-06-27 (cont. 14) — C2 thumbnail parity planner
- Added `planStill(req, fps, startTc)` to `seekModel.js`: avf engine → `{extractor:'avf', frame}` (native), mpv/unknown → `{extractor:'ffmpeg', frame, seconds:midFrame}`. Closes the "mpv has no getStill" gap at the logic level; the ffmpeg time is the SAME mid-frame landing as the seek, so a still and the seeked playhead show the same frame (parity guarantee, asserted in tests).
- `seekModel.test.mjs` 31→39 assertions. `build-verify` green (44 js · pytest 132). Repackaged + sealed.
- C2 logic core now complete (seek + step + still planning, all frame-accurate + tested); only live wiring + on-screen confirmation remain.

### 2026-06-27 (cont. 12) — audit area 3: companion IPC read/delete/copy paths → CLEAN
- Reviewed every companion read-to-dataURL, unlink/rmtree, and copy-source path. All file reads/deletes operate on internally-generated cache/temp/job-state paths (not raw renderer input); copy sources are user-initiated first-party reads into the now-confined delivery. No arbitrary read-and-return or arbitrary-delete primitive. Negative result recorded in audit report. **Security audit now spans 3 areas (IPC/XSS, path-traversal, IPC read/delete) — 2 real findings fixed, 1 clean.** No code change this pass (review only).

### 2026-06-27 (cont. 8) — D1 watcher brain (settle/debounce + ignore filter)
- `features/watchFolder/settleBatch.js`: `isIgnorable()` (dotfiles/.DS_Store/Thumbs.db/.tmp/.part/.download/.lock/backup~) + `createBatcher({settleMs})` with `add(path,now)`/`ready(now)`/`pendingCount`/`clear`. `now` injected → deterministic, no internal clock. Dedups repeated events; only returns a batch once the burst has been quiet for `settleMs`.
- `tests-js/watchFolderSettle.test.mjs`: 22 assertions incl. settle-window timing, dedup, junk/partial filtering, and end-to-end `settled batch → proposeAction → {kind:'ocf', count:3}`.
- D1 logic (classify + debounce) now fully built & tested; only the fs.watch/IPC/DOM I/O layer is left (live-verify). `build-verify` green (41 js files · pytest 126). Renderer synced; no repackage (not yet UI-wired).

### 2026-06-27 (cont. 9) — D1 orchestration controller
- `features/watchFolder/watchController.js`: `createWatchController({settleMs,pollMs,now,onProposal})` → `onFsEvent(path)` / `start(scheduler?)` / `stop(clearer?)` / `tick()`. All externals injected (clock, scheduler, event source, sink) so the full pipeline is deterministic in tests. A failing sink can't kill the watcher (try/catch). Events before start()/after stop() are ignored.
- `tests-js/watchController.test.mjs`: 16 assertions — burst-then-settle timing with a fake clock, junk/.part filtering mid-stream, exactly-once proposal per settled batch, junk-only burst → no proposal, idle ticks, start/stop gating.
- **D1 brain complete: 63 tests across classify+settle+orchestrate.** Remaining is purely the Electron fs.watch adapter + DOM prompt (≈20 lines, live-verify only) — sketched in the controller header. `build-verify` green (42 js files · pytest 126).

### 2026-06-27 (cont. 10) — E_rolling security audit + XSS hardening
- First rotating audit → `PostFlowX_Audit_Report.md`. IPC/preload surface reviewed (44 handlers): no shell injection; `deleteProject` well-confined; `openExternal` http(s)-only; `readFile`/`writeFile` unconfined-by-design (documented as XSS impact-multiplier).
- Medium finding: inconsistent HTML-escaping → DOM-XSS via maliciously-named files reaching `innerHTML` error/label sinks. Most modules already escape (`_esc`/`escapeHtml`); fixed the 3 unescaped file/error-derived sinks in `prep_mark.js` with a new `_escHtml` (strip error cell, relink error, stage msg). 8-assertion escaping test added. Repackaged + verified sealed (5 `_escHtml` refs in asar).
- `build-verify` green (43 js files · pytest 126). Open sinks + sweep + CSP + readFile/writeFile scoping logged in the report for follow-up.

### 2026-06-27 (cont. 5) — D2 bundled starter library
- `aceslook/services/defaultPresets.js`: 6 starter presets (ARRI LogC4 / Sony S-Log3 / RED Log3G10 → ACES pulls; HDR Dailies P3-D65 PQ1000; HDR Review Rec.2100 PQ; SDR QT in HDR Show Rec.709) using only valid enum values.
- `presetService.js`: `getDefaultPresets()` + `seedDefaultPresets({overwrite})` (idempotent; skips existing). `PresetSaveModal` adds a "Starter presets" button.
- Tests extended to 59 assertions: every bundled preset's `mode`/`inputTransform`/`workingLocation`/`outputTransform` validated against the live `transformRegistry` + `MODE_DEFAULTS`; seed idempotency. Full `test:js` green (39 files). Renderer rebuilt + arm64 repackaged + verified sealed.

### 2026-06-27 (cont. 4) — D1 watch-folder proposal core
- `features/watchFolder/proposeAction.js`: pure classifier (`classifyFile`) + `proposeAction(entries)` → single prioritized action `{action,tab,label,reason,kind,count,breakdown}`. Priority imf>timeline>ocf>audio>video>image so exactly ONE action is proposed even with mixed drops; reports a breakdown of the rest.
- Tests: `tests-js/watchFolderPropose.test.mjs` — 25 assertions (per-ext classification, single/mixed/empty/only-other, priority, object-entry inputs). Full `test:js` green (39 files, exit 0). Module synced to dist/desktop.
- NOT yet wired (needs running app to verify): Electron main `fs.watch` + debounce + IPC, and the one-click "N OCF detected → Link OCF" prompt that routes to `action.tab`. No repackage this step (no UI change yet).

### 2026-06-27 (cont. 3) — D2 shareable presets (.pfxpreset)
- `aceslook/services/presetService.js`: added pure `serializePresets`/`parsePresetsFile` (versioned `postflowx.acesLook.preset` v1, whitelist sanitizer that strips non-portable keys) + localStorage wrappers `exportPreset`/`exportAllPresets`/`importPresets` (collisions skipped unless `{overwrite:true}`).
- `aceslook/modals/PresetSaveModal.js`: Import… (file picker) + Export-all (download) buttons with inline status; refreshes caller on import.
- Tests: `tests-js/acesLookPreset.test.mjs` — 18 assertions (round-trip, collision, single export, bad-JSON/wrong-format/newer-version rejection, junk-key stripping, legacy bare-map). Full `test:js` suite green (38 files, exit 0). Renderer rebuilt + arm64 repackaged + verified sealed in asar.

### 2026-06-27 (cont.) — XXE hardening (Epic A1 / E3 security)
- Added `companion/src/postflowx_companion/safe_xml.py` — zero-dependency XXE/entity-expansion guard (rejects any DOCTYPE/ENTITY decl; IMF SMPTE XML never has one). Uses defusedxml too if present.
- Routed the untrusted IMF package surface through it: `imf_scan.py` (`_read_xml`), `imf_qc.py` (Photon output), `imf_package_resolver.py` (5 `ET.parse` → `safe_xml.parse_path`).
- Verified: external-entity XXE + billion-laughs both rejected; legit IMF XML + comment false-positive both pass; `py_compile` clean; **companion pytest 126/126 pass** (29 imf_scan tests included).
- Remaining sites (follow-up): `proxy_service.py` CPL/ASSETMAP + DoVi, `conform_engine.py`, `api.py:6046`. JS side (DOMParser) already XXE-safe.

### 2026-06-27 (cont. 2) — XXE hardening COMPLETE (all companion parse sites)
- Extended `safe_xml` to the remaining sites: `proxy_service.py` (4 CPL/ASSETMAP `ET.parse` + DoVi `ET.parse`/3× `ET.fromstring`), `conform_engine.py` (FCPXML, `except` now also catches `UnsafeXMLError` → graceful `[]`), `api.py` (ADM/IAB `ET.fromstring`).
- **0 raw `ET.parse`/`ET.fromstring`** remain in any of the 6 IMF/media XML files.
- Verified: legit FCPXML parses; XXE FCPXML → graceful `[]` (no file read); DoVi XXE → refused with error msg; `py_compile` clean; **companion pytest 126/126**.
- A1/E3 XXE item is now closed. Shipped in packaged app (companion is `extraResources`, repackaged + verified).


<!-- TEMPLATE
### YYYY-MM-DD (night run)
- Items done: N1
- Files changed: src/scripts/features/vfxPull/..., companion/...
- Build: PASS (node --test X passed, pytest Y passed, node --check clean) | FAIL + what
- Audit: 0 high / 1 med / 2 low; rotating area: electron/preload.js
- Blocked: macOS native build/sign = terminal hand-off (see BUILD_MAC_RUNBOOK.md)
- Next: A1
-->

### 2026-07-26 (night run, iteration 1) — quality gate repair + IAB/S-ADM test coverage & track-view fix

**Research first — the backlog was lying.** Verified before implementing anything; these items are marked open but are already shipped, so nothing was re-done:
- **A-IAB0c** — attribute-based name reads, count-driven `admStats`, bed/object typing, structured track list: DONE in `api.py`.
- **C-RT1e** — honest decode HUD: DONE, `imf_ui.js:9089` derives the label from the CPL codec (`CPU · HTJ2K (OpenJPH / FFmpeg)`) instead of hardcoding VideoToolbox.
- **C-RT1a / C-RT1b** — adaptive quality ladder (`S.previewScale` 1 / 0.5 / 0.25, `playbackMode === 'auto'`, `_setPreviewScale`, `_predictInitialPlaybackScale`) and the reduce-level decode fix: DONE in `imf_player.js` / `imf_j2k.js`.

**1. The quality gate was silently partial (HIGH).** `build-verify` ran `(cd companion && python3 -m pytest -q)`. There is no pytest in the macOS CLT python3, no Homebrew pytest, and no venv anywhere in the tree — so **the entire 250-test Python suite was being skipped and `build-verify` still printed a pass.** Every "build-verify green" claim in this log since the script was written covered JS only.
- Added `tools/run-pytest.mjs` — resolves an interpreter in priority order (`companion/.venv` → `$PFX_PYTHON` → PATH), *proves* `import pytest` works before running, and **exits 1 with the venv-creation command** if none qualifies. It can no longer fail open.
- Rewired `test:py`, `build-verify`, and `test` to it; created `companion/.venv` (pytest 9.1.1); gitignored it.

**2. IAB (Dolby Atmos) S-ADM parsing had zero real coverage.** `test_iab_inspect.py` asserts the contract against a ~hundreds-of-MB Meridian MXF that exists on exactly one workstation — `pytestmark = skipif(not _FIXTURE.is_file())`, so all 3 tests skip everywhere, including here.
- Split the pure parser `_parse_adm_xml(xml_text)` out of `_inspect_iab_asset(path)` (which is now a two-line wrapper) so the logic is drivable from a string.
- `companion/tests/test_adm_parse.py`: 14 tests over a synthetic Meridian-shaped ADM block (7.1.2 DirectSpeakers bed + 48 Objects packs, namespaced `ebuCoreMain`) — counts, bed-layout ladder (6/8/10/12/16 → 5.1…9.1.6), unknown-width fallback, namespace stripping, attribute-vs-child name reads, and XXE refusal.
- **Proven non-vacuous by mutation:** reverting the attribute read to a child-element read → 2 failures (`assert 1 == 49`, IndexError). Restored, 14 green.

**3. Real latent bug found by that work, and fixed — the Resolve-style track view.** The summary is count-driven (A-IAB0c) but `tracks` was still built by iterating `object_names`, which `_collect_named_nodes` **dedupes**. Two silent failure modes: a package whose objects carry no `audioObjectName` rendered a **bed-only** track view while `objectSummary.totalObjects` correctly said 49; and objects sharing a name (common — e.g. every object called "Atmos") **collapsed into a single row**.
- `tracks` now emits exactly `dynamic_objects` rows, taking labels in document order from the `audioObject` elements themselves (no dedupe) and synthesizing `Object N` where the name is empty. Meridian behaviour is unchanged byte-for-byte (48 labels → 48 rows, `objs[0] == "Object 1"`).
- Two new tests cover the unnamed and duplicate-named cases; mutation-tested (reverting → `assert 1 == 48`).

- **Build:** `build-verify` PASS — and for the first time genuinely: node `--test` 55 pass/1 skip, `test:js` 82 files exit 0, **pytest 250 passed / 7 skipped**, XSS gate clean, XXE gate clean. `build:renderer` PASS (366 files).
- **Files:** `tools/run-pytest.mjs` (new), `package.json`, `.gitignore`, `companion/src/postflowx_companion/api.py`, `companion/tests/test_adm_parse.py` (new).
- **Next:** the 7 remaining skips are all fixture-gated like `test_iab_inspect` — worth auditing whether any can be made fixture-free the same way.

### 2026-07-26 (night run, iteration 2) — the same fail-open class in the JS suite, and a gate to end it

**Research — two leads killed before writing code.**
- *"Audit whether any of the 7 remaining pytest skips can be made fixture-free"* (iteration 1's Next). No: 4 are `PyOpenColorIO`, a build-time-only dependency, and the other 3 are the Meridian MXF tests already superseded by `test_adm_parse.py`. Nothing to harvest — closing this lead.
- **E1's follow-up is stale** ("`fdlGenerator.js` has NO golden/pixel-accuracy tests"). `tests-js/fdlGenerator.test.mjs` exists and is thorough: schema tag, frame-range math, the reformat-scale formula against a non-trivial 4608x3164 → 3840x2160 case (0.6827), AMF precedence, CSV escaping, TXT block, sparse defaults. That is the sixth backlog item found already-shipped; the backlog is a lead list, not a truth source.

**1. Iteration 1's lesson applied to the JS suite — same defect, four more sites (MEDIUM).** `test:js` was audited on the assumption it fails loudly. Four files wrapped `require('electron/imf/imf_direct_engine.js')` in `catch (e) { console.log('SKIP…'); process.exit(0) }` (and one in a bare `return` from an async helper). `imf_direct_engine.js` is **first-party and always present** — a load failure there is a bug, never an optional dependency. A syntax error in the engine would have deleted **76 assertions** across `imfDirectEngineRealtime`, `imfEngineProgressCancel`, `imfMpjpegReassembler`, and `imfEngineUiWiring` while `test:js` still exited 0 and printed green. Latent, not live — all four currently pass — but it is exactly how iteration 1's pytest hole stayed invisible for months. All four now `console.error('FAIL …')` + `process.exit(1)`.

**2. New gate so the class cannot come back — `tools/scan-failopen.mjs`.** Follows the `scan-rawxml` convention (pure exported predicate + `--gate` → exit 1). Flags, across `tests-js/` and `test/`:
- a `catch` body containing `process.exit(0)`;
- a `catch` body that logs `SKIP` and bare-`return`s (a plain `return null` fallback is *not* flagged — that would be noise);
- npm scripts that discard their own exit code (`|| true`, `; true`, `|| exit 0`).
Genuinely-optional dependencies stay expressible via `// fail-open-ok: <reason>` on or above the catch — the point is that a skip is a reviewed decision, not an accident. node:test's `{ skip: reason }` is preferred and never flagged, since it still reports.
- **Mutation-verified:** reintroducing the exact pre-fix catch into `imfMpjpegReassembler.test.mjs` → gate exits 1 naming `:26`. Restored → clean.
- A design flaw surfaced *from* its own tests: folding the two preceding source lines into the catch body let one catch's `process.exit(0)` condemn the next catch. `catchBlocks` now returns `{ line, body, annotation }` with the annotation checked separately.
- 13 new assertions in `tests-js/securityGates.test.mjs` (40 total, was 27).

- **Build:** `build-verify` PASS — node `--test` 55 pass/1 skip, `test:js` 82 files exit 0, pytest 250 passed / 7 skipped, XSS + XXE + **fail-open** gates clean. `build:renderer` PASS (366 files).
- **Files:** `tools/scan-failopen.mjs` (new), `package.json`, `tests-js/securityGates.test.mjs`, `tests-js/imfDirectEngineRealtime.test.mjs`, `tests-js/imfEngineProgressCancel.test.mjs`, `tests-js/imfMpjpegReassembler.test.mjs`, `tests-js/imfEngineUiWiring.test.mjs`.
- **Next:** the verification-integrity seam is now closed on both suites; move to product substance — C-RT1c (FFmpeg `-threads`/frame-slice threading on the `-f imf` decode, the biggest CPU lever left) or C1 (unify the codec→engine routing decision currently split between the companion and `smart_router.js`).

### 2026-07-26 (night run, iteration 3) — C1: the ProRes engine the app chose and then threw away

**Research.** Two leads were killed before any code was written.

- **C-RT1c (IMF decode threading) — not verifiable here, deferred.** `ffmpeg -demuxers | grep -i imf` returns nothing on this machine (build has no libxml2), and there is no `libopenjpeg` decoder — only native `jpeg2000`. The `-f imf` path cannot be exercised or benchmarked locally, so any `-threads` change would ship an unmeasured perf claim. Left open.
- **C1's stated premise was wrong.** The backlog says routing is "split between the companion and `smart_router.js`". `electron/native/smart_router.js` is a pure HTTP proxy to `127.0.0.1:47125` — it holds no codec decision at all. The premise is the **seventh** stale/incorrect backlog entry (after A-IAB0c, C-RT1a, C-RT1b, C-RT1e, E1-FDL, and C1's own wording).

But chasing that premise found the real split, and a live bug inside it.

**The two decisions that actually exist.**
1. `companion/.../media_engine/media_router.py::select_engine` — 9 inputs → `(engine, fallbacks, reason)`, vocabulary `NativeAVFoundationEngine | MPVEngine | FFmpegFrameServerEngine | IMFEngine | ResolveEngine | ChromiumVideoEngine | ProxyEngine`. Reached via `smartMedia.selectEngine` → `POST /api/media/select-engine`.
2. `src/scripts/core/playbackRouter.js::selectEngine` — the renderer's own ProRes probe, vocabulary `PFXNativeEngine | NativeAVPlayerEngine | MPVPlayerEngine | ChromiumVideo`. Reached from `playableMedia.js` on every local `.mov` open.

They serve different layers (companion decode service vs. renderer player choice), so merging them is not obviously right and was **not** attempted tonight. What was wrong is inside (2).

**The bug.** `playableMedia.js` dispatched on the router's answer with a hand-written chain:

```js
if (engine === ENGINE.NATIVE_AV)      { …canvas… }
else if (engine === ENGINE.MPV)       { …mpv… }
else                                  { _startChromiumPath(…) }   // ← everything else
```

`ENGINE.NATIVE_ENGINE` (`'PFXNativeEngine'`) — the *preferred* ProRes path, documented at the top of the router as "persistent session, ~5ms/frame" — matched neither arm and fell into the Chromium branch. And it is not a rare value: `electron/preload.js:467` exposes `nativeEngine` as an unconditional object literal, so `window.pfxPlatform?.nativeEngine` is **always truthy** in the desktop app and the router returns `PFXNativeEngine` for *every* ProRes file on *every* desktop build. The `_startNativeAVPath` call at the top of that chain was unreachable code in the shipped app.

The router had already set `htmlVideoBlocked: true` on that same return. The app decided Chromium could not play the file and then handed the file to Chromium.

**Why it looked like it worked.** `_startChromiumPath` has a black-frame heuristic — after 2500 ms with `videoWidth === 0` it calls `goNative()` and lands on the canvas engine anyway. So ProRes usually did play, just after a wasted decode attempt and a ≥2.5 s stall. The exception is the cross-tab proxy-reuse branch (`4b`), which commits to a cached transcoded proxy and `return`s before any of that: a ProRes clip with a cached proxy played the degraded proxy permanently and never reached the native path at all.

**Fix.**
- `playbackRouter.js` — added `PLAYBACK_PATH` + `pathForEngine(engine)`, one exhaustive map from engine value → path. Unknown engine returns `null` (loud) rather than defaulting to Chromium. Both native values share `canvas-native`, which is correct: `NativeAVPlayerEngine.open()` already tries `pfxPlatform.nativeEngine` first and self-heals to `avf_bridge`.
- `playableMedia.js` — dispatches through `pathForEngine`, warns on an unrecognised engine.
- `playbackRouter.js` — the two `window.pfxPlatform?.nativeEngine` truthiness checks now go through `_nativeEngineAvailable()`, which reads the documented `isReady` capability flag and treats only an explicit `false` as unavailable. **Behaviourally identical today** (`isReady` is hardcoded `true`), but it points the ladder at the intended signal, so the `avf_bridge` and MPV rungs become reachable the moment that flag is made honest instead of being dead by construction.

**Testing.** `tests-js/playbackRouter.test.mjs` 20 → 42 assertions. The old file tested `selectPlaybackEngine` exhaustively — a function with **zero production callers** — while the async `selectEngine` the app actually runs had none. That is how this shipped. Added: exhaustiveness over every `ENGINE` value, the full `selectEngine` matrix (ProRes/h264/off-desktop/`isReady:false` rungs), and a source-level assertion that `playableMedia` dispatches via `pathForEngine` and contains no `engine === ENGINE.*` chain.

Mutation-verified twice: deleting the `NATIVE_ENGINE` case → 3 failures; reintroducing an `=== ENGINE.` chain in the consumer → 1 failure.

- **Build:** `build-verify` PASS (pytest 250 passed / 7 skipped; XSS + XXE + fail-open gates clean). `build:renderer` PASS (366 files, v2026.6.1).
- **Files:** `src/scripts/core/playbackRouter.js`, `src/scripts/core/playableMedia.js`, `tests-js/playbackRouter.test.mjs`.
- **Next:** C-RT2 (HUD showing which backend served each frame — would have made this visible immediately), or D1's remaining `fs.watch` → `ctl.onFsEvent` live-wire.

### 2026-07-26 (night run, iteration 4) — C-RT2: the same question answered three times, three different ways

**Picked over D1.** D1's remainder is the Electron `fs.watch` → `ctl.onFsEvent` adapter plus a DOM prompt — roughly 20 lines that can only be confirmed by running the packaged app. This loop's standard is that every iteration ends green on a headless gate, so an item that can't be verified headlessly isn't the highest-value item available at 03:00. C-RT2 ("surface which backend served each frame") turned out to be the right call for a second reason: the instrumentation it asks for is exactly what was missing.

**The finding.** Whether a JPEG 2000 codestream is HTJ2K (Part 15) or classic (Part 1) is decided in three places, and they disagree:

| Where | What it does |
|---|---|
| `src/sandbox/j2k_decoder.js::sniffCodestream` | Walks to SIZ, tests `Rsiz & 0x4000`, routes HT → OpenJPH / classic → OpenJPEG. **Correct.** |
| `imf_j2k.js::decodeHTJ2K` | **No sniff at all.** Accepted `0xFF4F` *or* `0xFF50` and handed everything to OpenJPH. |
| `imf_player.js::parseJ2KHeader` | Walks the marker segments properly and captures `rsiz` — then never tests the bit. The value is only displayed. |

So the codebase already extracted the deciding value twice and routed on it exactly zero times outside the sandbox.

Two things were wrong in `decodeHTJ2K`. The `0xFF50` arm was justified in a comment as an "HTJ2K SOC" — there is no such marker. Every J2K codestream, Part 1 and Part 15, starts `0xFF4F`; `0xFF50` is CAP, a main-header segment that can never sit at offset 0. That branch was unreachable. The real defect is what the missing sniff caused: `_directHTDisabled = !_isDesktopApp`, so on desktop the direct OpenJPH path is tried **first, for every frame**, and OpenJPH is HT-only. For a classic Part 1 IMF package — the majority of real deliverables — every single frame paid a full copy of the codestream into the WASM heap (`getEncodedBuffer` + `buf.set`, megabytes per UHD frame), a thrown exception, and a `console.warn`, before falling through to the sandbox that would have decoded it correctly. And the failure is never sticky: nothing disables the direct path after it fails, so the cost repeats frame after frame for the whole clip.

`imf_player.js` calls `_decodeHTJ2K(...)` for *every* frame of any IMF MXF essence regardless of profile, so nothing upstream filtered this either.

**Fix.**
- **New `src/scripts/modules/imf/j2kCodestream.js`** — the one classifier. Exports `MARKER`, `RSIZ_CAP_BIT`, `sniffCodestream(bytes)` → `{kind, rsiz, markerOffset, hasCap}`, and `isHTJ2KCodestream(bytes)`. A length-walk from SOC to SIZ, with a bounded byte scan as recovery when a segment length is malformed. `kind: 'unknown'` means "not a codestream — do not guess a decoder".
- **`imf_j2k.js`** — sniffs first; rejects non-codestreams outright; gates the direct OpenJPH path on `sniff.kind === 'htj2k'`. Classic streams now go straight to the sandbox, which routes them to OpenJPEG.
- **`src/sandbox/j2k_decoder.js`** — its local `sniffCodestream` deleted in favour of the shared import, so the two can't drift apart again.
- **Route accounting (the actual C-RT2 deliverable)** — `getDecodeRouteStats()` / `resetDecodeRouteStats()` in `imf_j2k.js` count decodes by the backend that served them (`direct-openjph`, `sandbox:<decoderKind>`), plus `directFailures`, `rejected`, `failed`, and `last`. This is the number whose absence let the defect hide: a HUD reading "sandbox:openjpeg — 1 direct failure per frame" would have said it out loud on the first classic IMF open.

**Deliberately conservative.** `rsiz & 0x4000` is kept as the predicate — exactly what the sandbox has always used — rather than a stricter Pcap test the decoders were never validated against; `hasCap` is reported separately as corroboration. And a valid SOC whose SIZ can't be read resolves to `'j2k'`, never `'htj2k'`: the classic path has a pure-JS fallback behind it, the HT path has nothing.

**Testing.** New `tests-js/j2kCodestream.test.mjs`, 36 assertions: synthesised Part 1 / Part 15 / CAP-bearing headers, eight broadcast-profile Rsiz values that must not read as HT, JP2 container and `0xFF50`-leading buffers that must resolve `'unknown'`, degenerate headers that must resolve to classic, and source-level assertions that both consumers import the shared module and that the sandbox no longer defines its own.

Mutation-verified four times: dropping the `htj2k` gate → 2 failures; wrong capability bit → 6; unsafe `'htj2k'` default on an unreadable SIZ → 1; sandbox redefining its own sniff → 1.

Worth recording: the capability-bit mutation **initially survived**, because the test built its HT fixtures from `RSIZ_CAP_BIT` — so flipping the constant moved the fixture and the assertion together. Fixtures are now written as literals with `eq(RSIZ_CAP_BIT, 0x4000)` pinning the constant separately. A test that derives its input from the value under test is testing nothing. This is the same failure mode as iteration 3's tests-on-the-unused-twin, one level down.

- **Build:** `build-verify` PASS (pytest 250 passed / 7 skipped; XSS + XXE + fail-open gates clean). `build:renderer` PASS (367 files, v2026.6.1). Cross-directory import verified to resolve in **both** built targets (`dist/desktop/`, `dist/extension/`).
- **Files:** `src/scripts/modules/imf/j2kCodestream.js` (new), `src/scripts/modules/imf/imf_j2k.js`, `src/sandbox/j2k_decoder.js`, `tests-js/j2kCodestream.test.mjs`.
- **Next:** wire `getDecodeRouteStats()` into a visible HUD readout (the counters exist but nothing displays them yet), or `imf_player.js::parseJ2KHeader` → replace its third private parse with the shared module.

---

### 2026-07-26 (night run, iteration 5) — C-RT2 (part 2): the counters nobody could see

Iteration 4 left `getDecodeRouteStats()` exported and unread. That is not instrumentation, it is dead code with good intentions — and it is precisely the shape of the defect the same iteration had just fixed (a correct value computed and then discarded by its consumer). This closes it.

**What an operator can now answer.** `imf_player.js` already draws a real-time HUD behind the `H` key (`S.showRtHud`, ~line 1178) showing fps, preview scale, dropped frames and decode-ms. It said nothing about *which decoder produced the pixels* — and the four rungs of the ladder look identical on screen. "Why is this reel 6 fps" was unanswerable without opening a console.

The HUD line now ends with the dominant backend by operator-meaningful name — **OpenJPH** / **OpenJPEG** / **JS fallback**, i.e. the library, not the transport, since `direct-openjph` and `sandbox:htj2k-openjph` are the same decoder to the person watching. A share percentage appears only when routing is actually mixed, and `⚠N% wasted` only when thrown-away direct attempts cross 10% of decoded frames — below that they are startup warm-up, above it they are the iteration-4 defect recurring, per frame, in the open.

**Colour outranks cadence.** The HUD tinted itself green whenever cadence held. Hitting 24 fps on the pure-JS baseline decoder is still a finding, so `route.degraded` now takes precedence over `cadenceOk` in the fill colour. Degraded means either the JS fallback is dominant — a correctness net, never a playback path — or the wasted-attempt rate is over threshold.

**Two smaller decisions.** The summariser returns `null` rather than a zero-valued object before the first frame, because a HUD reading `OpenJPH 0%` is worse than a blank one. And the route counters reset per reel alongside `S.droppedFrames`, so the previous reel's backend cannot colour this one. The player binds all three functions through null-object defaults, so the HUD still draws normally if the J2K module never loads.

**Testing.** New `tests-js/decodeRoute.test.mjs`, 36 assertions: empty/null/zero-total inputs, each backend's label, dominance vs. a handful of stray fallback frames, deterministic tie-breaking, the 9%/10% threshold boundary from both sides, unknown backends falling through to their raw key rather than to silence, snapshot immutability, and source-level assertions that the player actually binds, computes, pushes and colours — inside the toggled block, not burned onto every capture.

Threshold fixtures are written as literals with `eq(WASTED_ATTEMPT_WARN_PCT, 10)` pinning the constant separately — iteration 4's surviving mutation taught that lesson once and it does not need teaching twice.

Mutation-verified four times: inclusive threshold → exclusive → 1 failure; tie-break `>` → `>=` → 1; JS fallback removed from the degraded set → 1; degraded colour dropped from the HUD ternary → 1.

- **Build:** `build-verify` PASS (pytest 250 passed / 7 skipped; XSS + XXE + fail-open gates clean). `build:renderer` PASS (367 files, v2026.6.1).
- **Files:** `src/scripts/modules/imf/imf_j2k.js`, `src/scripts/modules/imf/imf_player.js`, `tests-js/decodeRoute.test.mjs`.
- **Next:** `imf_player.js::parseJ2KHeader` — the third private header parse, still un-converged onto `j2kCodestream.js`. Or: nothing disables the direct HT path after repeated failures, so a misrouted clip pays the cost for its whole length; a strike-count latch would make the ⚠ readout self-correcting instead of merely honest.

---

### 2026-07-26 (night run, iteration 6) — C-RT2 (part 3): stop the waste, don't just report it

Iteration 5 made per-frame decoder waste visible. Visible is not fixed. This latches it off.

**The remaining hole.** The sniff added in iteration 4 stops *classic* essence from reaching the direct OpenJPH path. It does nothing for an HT stream that this build's OpenJPH cannot decode — an unsupported subprofile, a bit depth it wasn't compiled for, a main-page WASM heap that won't allocate. That stream still paid a full codestream copy into the WASM heap plus a thrown exception **on every frame**, wrote a `console.warn` with an Error object each time, and then fell through to the sandbox that decodes it correctly. At 24 fps for a ten-minute reel: 14,400 wasted attempts and 14,400 console entries, which with devtools open is itself a measurable cost.

**Consecutive, not cumulative.** Three consecutive direct-HT failures now latch the fast path off for the rest of the reel; any success resets the run. That distinction is the whole design. A cumulative counter would disable the fast path after three scattered bad frames spread across a two-hour reel — a worse outcome than the waste it exists to prevent. A permanently unavailable module (`_loadDirectHTModule` memoises its own failure) trips the latch immediately rather than being re-checked forever.

**Logging drops from per-frame to per-reel.** `fail()` returns true only on the call that trips the latch, so the caller logs once. The first failure still gets its warning — a single "falling back to sandbox" line is useful; 14,400 of them bury the log they are trying to write.

**A latch is reported but is deliberately not `degraded`.** The HUD gains `(HT off)`, plain, no ⚠. The latch is what *stopped* the waste. It usually coincides with a genuinely bad backend, and that backend is flagged on its own merits — but the direct path can fail for reasons local to the main-page WASM heap while the sandbox's separate heap decodes at full speed, and colouring that reel red would cry wolf. Note that the player needed no change at all: iteration 5's HUD reads `route.text`, so the new state surfaced for free.

**Testing.** `tests-js/decodeRoute.test.mjs` grows to 77 assertions. The latch is an exported dependency-free factory (`createStrikeLatch`) precisely so the tripping rule is testable without a DOM, a WASM module, or a decode — consecutive-vs-cumulative, trip-announces-once, reset, degenerate limits, plus source-level guards that the hot path checks the latch, resets on success, gates its warn on `fail()`, and clears with the counters.

Mutation-verified eight times: cumulative instead of consecutive → 3 failures; re-announcing every frame → 2; off-by-one trip → 6; latch wrongly implying degraded → 1; hot path ignoring the latch → 1; reset leaving it stuck → 1; latch starting closed → 17; never tripping → 5.

**One mutation survived, and the code lost a line because of it.** `createStrikeLatch` originally clamped its limit with `Math.max(1, limit | 0)`. Removing the clamp changed nothing any test could see — and on inspection, nothing *anything* could see: every degenerate value (`0`, negative, `NaN`, `undefined`, fractional) coerces to a max the first strike already exceeds, so the latch trips on failure 1 with or without it. The clamp was deleted rather than tested. The test was reworded from a claim about a mechanism to a claim about the outcome, and now runs over five degenerate inputs. Iteration 4's lesson was *don't derive the fixture from the value under test*; this is its sibling — **a test labelled for a mechanism it cannot detect is worse than no test, because it reports the mechanism as covered.**

- **Build:** `build-verify` PASS (pytest 250 passed / 7 skipped; XSS + XXE + fail-open gates clean). `build:renderer` PASS (367 files, v2026.6.1).
- **Files:** `src/scripts/modules/imf/imf_j2k.js`, `tests-js/decodeRoute.test.mjs`.
- **Next:** `imf_player.js::parseJ2KHeader` is still the third private header parse, un-converged onto `j2kCodestream.js` — the one item left from area 8 and the smallest remaining piece of C-RT2. After that the J2K decode path is exhausted as an audit area and the loop should move on.

---

### 2026-07-26 (night run, iteration 7) — every classic JPEG 2000 package was labelled HTJ2K

**Re-prioritised away from the planned item, on evidence.** Iteration 6 named `parseJ2KHeader` as next. RESEARCH found something strictly larger one file over, so that item is deferred again — deliberately, and it is still open below.

**The defect.** `imf_parser.js` computed the picture-coding flags as:

```js
const isHTJ2K = isJ2K || (pecUL.includes('0d01030c') || pecUL.includes('04010202.03010000'));
```

`isJ2K` is true for anything carrying a `JPEG2000SubDescriptor`. So `isHTJ2K` was true for **every JPEG 2000 IMP that has ever been opened in this app**, classic SMPTE Part 1 included. Part 15 is a positive finding about a stream; "it is JPEG 2000" is not evidence for it. The three-way ladder immediately below it — `isHTJ2K → 'HTJ2K (JPEG 2000 Part 15)'`, `isJ2K → 'JPEG 2000'` — could only ever take its first branch.

**What the operator was told.** Four consequences, all provable from the code's own structure rather than inferred:

1. The status bar's decoder line read **`CPU · HTJ2K (OpenJPH / FFmpeg)`** for classic essence — naming a decoder that, by this codebase's own routing (`src/sandbox/j2k_decoder.js`, and iteration 4's sniff), cannot decode that stream at all. The single line an operator reads to answer "what is playing this?" named the wrong one on every classic delivery.
2. PIC004 returned `INFO` with *"HTJ2K declared — decoder compatibility should still be verified at track level"* on every classic J2K delivery. The `SEV.PASS` arm written for plain J2K was unreachable. A caveat that fires on every package is indistinguishable from no caveat: it trains the operator to skim past the line that will one day be true.
3. The `imf-rt-codec-j2k` badge in `imf_ui.js` was dead CSS.
4. `d.isJ2K ? 'JPEG 2000'` in the validator's descriptor table, likewise.

**And a second, opposite error in the same expression.** `ContainerConstraintsSubDescriptor` counted as evidence *of JPEG 2000*. That is ST 379-2 generic-container constraints — sound essence carries it too. So an audio descriptor could satisfy `isJ2K`, and through `isPicture` compete to be the primary **picture** descriptor. Removed.

**Two coupling traps, both of which would have turned the fix into a regression.**

- `isPicture` was `isRGBA || isCDCI || isHTJ2K || …`. The bug was *load-bearing*: because HT was true for all J2K, that clause was doing duty as the J2K clause. Narrowing HT without switching this line to `isJ2K` would have dropped a J2K descriptor whose `StoredWidth` did not parse out of the running for primary picture descriptor entirely — trading a wrong label for a missing one. The line now reads `isJ2K`.
- `picDesc` was resolved in `parseCPL`, used locally, and **never returned**. Five call sites read `cpl.picDesc?.…` — the status bar's decoder line, the engine's HTJ2K status suffix, its limitations list, and two backfills for a missing bitDepth/resolution — and every one of them has read `undefined` since the field was first referenced. Fixing that had to come *after* the classification fix, not before: exporting `picDesc` while `isHTJ2K` was still true-for-everything would have propagated the wrong label to five fresh consumers in one commit.

**Convergence, and the restraint that goes with it.** The descriptor answer now lives in `j2kCodestream.js` beside the codestream answer, as `classifyJ2KDescriptor()`. Holding the declaration in one file and the truth in another is exactly how the codebase came to carry two definitions of "HTJ2K". `J2KExtendedCapabilities` presence is the strong signal — the element exists to carry the CAP segment's Pcap/Ccap, which a Part 1 stream has no marker for. **No Pcap bit is decoded**, on purpose: `tests-js/j2kCodestream.test.mjs:52` already contains a fixture commented "Part 15 sets Pcap bit 15" with a value that would be `1 << 17` under ISO's MSB-first numbering, and which nothing reads. The convention could not be settled from the repo, so the classifier does not depend on it. `04010202.03010000` was removed from the HT UL set with a stated reason (it is the *generic* JPEG 2000 coding label, which classic essence is entitled to declare). `0d01030c` is inherited and unverified against RP 224, so it was **kept but demoted**: it reports `htEvidence: 'pec-ul'`, and PIC004 says so — *"declared by PictureEssenceCoding UL alone — confirm against the codestream before routing to an HT-only decoder."* Deleting a check on a hunch is the same unfounded move as adding one; the honest option was to grade the evidence and let the operator judge.

**The validator stopped reading a display string.** PIC004 previously derived its own severity with `cpl.codec.includes('HTJ2K')`. Re-wording a UI label silently changed validation severity — and the parse could only ever repeat what the parser had already decided, wrongly. It now reads `cpl.isHTJ2K` / `cpl.isJ2K`.

**Testing.** `tests-js/j2kDescriptor.test.mjs`, 43 assertions — nothing in `tests-js/` mentioned HTJ2K before this file, which is why the bug survived every gate. Covers the core rule (J2K is not evidence of Part 15), evidence grading and precedence, case-folding, the generic-UL false positive, five degenerate inputs, the invariant `isHTJ2K === (htEvidence !== null)`, and source-level guards on all four wiring changes.

Mutation-verified eight times: HT evidence no longer implying J2K → 1 failure; the original `isJ2K ||` bug reintroduced → 3; the generic UL re-added → 3; UL case-folding dropped → 1; evidence precedence inverted → 1; `isPicture` back onto the HT flag → 1; `picDesc` dropped from the return → 1; validator back to substring-matching → 2. None survived.

- **Build:** `build-verify` PASS (pytest 250 passed / 7 skipped; XSS + XXE + fail-open gates clean; all `tests-js` suites green). `build:renderer` PASS (367 files, v2026.6.1).
- **Files:** `src/scripts/modules/imf/j2kCodestream.js`, `src/scripts/modules/imf/imf_parser.js`, `src/scripts/modules/imf/imf_validator.js`, `tests-js/j2kDescriptor.test.mjs`.
- **Next:** `imf_player.js::parseJ2KHeader` — still the third private header parse, now twice deferred. Beyond the convergence it has two concrete hazards found while reading it this iteration: `new DataView(bytes.buffer, bytes.byteOffset)` is constructed with **no length**, so on a subarray view its reads run into neighbouring frame bytes; and the marker walk has no SOT/SOD stop and no byte bound, so a truncated header walks garbage segment lengths across the entire frame. Its only consumer is the centre-screen `W × H` readout, which bounds the blast radius to a wrong number on screen — but the unbounded view is the kind of thing that stops being harmless the moment someone reuses the function.

### Iteration 8 — the last two private SIZ parsers, and what they had been getting wrong

**Research.** Four places in this codebase walked a JPEG 2000 SIZ segment. Two of them went through `j2kCodestream.js` (`src/sandbox/j2k_decoder.js`, `imf_j2k.js`) and were correct. Two were private near-duplicates, both deferred twice by earlier iterations: `imf_player.js::parseJ2KHeader`, feeding the centre-screen `W × H` readout, and `imf_mxf.js::parseJ2KSIZ`, feeding `isSuspiciousCodestream()` — the truncated-frame heuristic. They were not merely duplicated. They were duplicated *and wrong*, in four ways each:

1. **The width was Xsiz.** The image is `Xsiz − XOsiz`, `Ysiz − YOsiz` (ISO/IEC 15444-1, Table A.9). Both copies returned the reference-grid extent and labelled it the image size. This is right only because IMF App#2E pins the image offset to zero — and neither parser said it depended on that, so nothing would have caught the day it stopped being true.
2. **`Lsiz >= 38` was accepted.** `Lsiz = 38 + 3·Csiz`, so a conforming SIZ with even one component is **41** bytes or longer; 38 is a length no SIZ can have. A too-loose gate on a marker match matters only when the match is spurious — which is exactly the situation the gate exists for. `FF51` occurs in entropy-coded packet data.
3. **The marker walk had no byte bound and no SOT/SOD stop.** A truncated header was walked to the end of the buffer with entropy-coded bytes read as segment lengths. This bites hardest in `imf_mxf.js`, because `parseJ2KSIZ`'s only caller is the *truncation heuristic* — the input is a codestream already suspected of being cut short.
4. **(Player only.) A DataView built with no length.** `new DataView(bytes.buffer, bytes.byteOffset)` spans to the end of the underlying `ArrayBuffer`, not to the frame. For a frame sliced out of a larger read buffer that is the *next frame's* bytes.

**What was and was not actually broken.** Worth separating, because overstating it would be the same failure as the code's. Every read in the player's parser was hand-guarded against `bytes.length`, so nothing read out of bounds *today* — the DataView defect is latent, not live. The safety lived in five separate hand-written comparisons rather than in the view; one more read would have been one too many. Likewise `imf_mxf.js:112`'s `return new DataView(bytes.buffer)`: `readBytes()` always allocates a fresh whole buffer, so that view was already the right one. Both are fixed as contract defects, and the tests that pin them say "latent" in as many words.

**Code.** Both private copies now delegate to `sniffCodestream()`, which grew `width`/`height`/`xsiz`/`ysiz`/`xosiz`/`yosiz`. Three deliberate choices in the shared implementation:

- `u32` multiplies by `0x1000000` rather than shifting by 24. `Xsiz` is an unsigned 32-bit field and `<< 24` sign-flips anything at or above 2^31 into a negative width.
- Dimensions are **`null`, never zero**, when SIZ was absent, short, or truncated — and the JSDoc says null means "not known". The player's readout is guarded on `j2k?.width && j2k?.height`, which a test now pins, so a missing SIZ prints nothing rather than `null × null`.
- Classification is deliberately **independent of dimensions**. A stream whose SIZ is too short to yield a size still routes on Rsiz exactly as before; withholding the size must not change which decoder gets the frame.

**Testing.** `tests-js/j2kSizDims.test.mjs`, 45 assertions — nothing in `tests-js/` had ever read a width out of a codestream. Nine mutations, all caught.

One of them **survived the first sweep**, and the reason is the interesting part of this iteration. The test for the end-of-segment bound clipped a frame to 12 bytes, so `Xsiz` was inside the view and `Ysiz` was not. Because the shared module indexes the `Uint8Array` directly, a past-end read is `undefined & 0xff === 0` — so the mutant produced width 2048, **height 0**, and was rejected by the *degenerate-image* guard `!(height > 0)`. The assertion passed; the bound it was named for never ran. Recut to a 16-byte clip over a codestream with origin `(64, 20)`: now `Xsiz` and `Ysiz` are in view and `XOsiz`/`YOsiz` are not, so dropping the bound yields a perfectly plausible **1920 × 1080** instead of the correct 1856 × 1060. Three assertions fail. The block's comment was also rewritten — it had claimed the bound stops reads reaching the neighbouring frame, which is false: the typed-array indexing does that, and the bound's real job is to report *unknown* rather than a number assembled from missing fields read as zero.

A second false positive, earlier in the same iteration: the source guard `!/new DataView\(x\.buffer, x\.byteOffset\)/` fired on my own comment above `parseJ2KHeader`, which quotes the defect verbatim. Narrowed to the assignment form. Chasing it surfaced the genuine (latent) length-less view at `imf_mxf.js:112`.

- **Build:** `build-verify` PASS (pytest 250 passed / 7 skipped; XSS + XXE + fail-open gates clean). `build:renderer` PASS (367 files, v2026.6.1). The staged tree was materialised to a scratch directory with `git checkout-index` and tested there, so the four sibling J2K suites (36 + 77 + 43 + 10 assertions) are green against exactly what was committed, not against the worktree.
- **Files:** `src/scripts/modules/imf/j2kCodestream.js`, `src/scripts/modules/imf/imf_player.js`, `src/scripts/modules/imf/imf_mxf.js`, `tests-js/j2kSizDims.test.mjs`. `imf_mxf.js` carried a pre-existing 644→755 mode flip that is **not** mine; the content hunks were staged via `git apply --cached` with the mode lines stripped, leaving the flip in the worktree.

### Iteration 9 — the ALE importer, and a format the app claims to read

**Research.** Every previous iteration this run has been inside the IMF/J2K stack. This one moved to `src/scripts/parsers/`, on the reasoning that a delivery-format reader with no tests is worth more attention than a ninth pass over one that now has plenty. `src/scripts/parsers/ale.js` — Avid Log Exchange, 243 lines, reachable from two places in `ui.js` — had **no test file anywhere in the repo**.

Reading it turned up one line worth stopping on:

```js
const m = s.match(/^(\d+):(\d+):(\d+):(\d+)$/);
```

No `;`. NTSC drop-frame timecode is written with semicolons, and Avid — the tool whose format this is — most commonly writes the mixed form `01:00:00;00`, semicolon on the last separator only. A runtime probe against the real parser rather than a reading of it:

| Input | Events | Result |
|---|---|---|
| `01:00:00:00` (non-drop) | 1 | `srcIn = 01:00:00:00` |
| `01;00;00;00` (drop-frame) | **0** | silently dropped |
| `01:00:00;00` (Avid's usual form) | **0** | silently dropped |
| `01:00:00:00.5` (Resolve 21 subframe) | **0** | silently dropped |
| `00:00:00:00120` (5-digit frames) | 1 | `00:00:00:20` — wrong |

**Why rejection deleted the row.** `parseTC` returning null is not confined to one field. All four timecode columns of a drop-frame row fail together, so `buildEventFromRow` reaches `if (!srcIn && !srcOut && !recIn && !recOut) return null;` and the row is discarded. **Every row of an NTSC drop-frame ALE, so the whole file imports as an empty timeline.**

And nothing says so. `ui.js:13648` is `if (parsed?.events?.length) break;` — a zero-event parse simply doesn't stop the file loop. `ui.js:17397` is `if (!parsed?.events?.length) continue;` — the match-back modal skips the file with no entry in `_mbFileMeta`. No error, no warning, no console line. The operator sees an import that did nothing.

**Code.** The separator class becomes `[:;]` in all three positions and a trailing `(?:\.\d+)?` strips the Resolve subframe suffix. Drop-frame is normalised to colons and thereafter treated as non-drop — which is **lossy**, and chosen anyway: `utils_time.js::tcToFrames` says "DF treated as NDF" in its own signature, `xml.js:652` strips `;` before calling it, `edl.js:45` matches `/[:;]/` and reads the frame field straight. `ale.js` was the one parser in the codebase that disagreed with that convention, and it disagreed by *discarding data* rather than by counting it differently. A ninth reading of drop-frame invented inside one importer would be a worse outcome than a known-lossy one shared by all of them.

The `ffInt % 100` on the frame field is deleted. This file's own header has always advertised `HH:MM:SS:FFFFF`, and the modulo silently rewrote `00120` as `20` — wrong, plausible, and unannounced. Passing the digits through to `tcToFrames` is not a guess about what a five-digit field means; it is the absence of one.

**Testing.** `tests-js/aleParser.test.mjs`, 37 assertions, all through the public `parseALE` — `parseTC` is private, and the event-drop is the part that actually hurt, so the entry point is also the right observation point. 11 mutations, all caught.

Two things went wrong first, both familiar:

- The source guard `!/ffInt % 100/` **fired on my own comment in `ale.js`**, which names the modulo while explaining its removal. Iteration 8 hit this exact shape and narrowed the pattern; here it recurred anyway, so the guards now strip comments before matching rather than being hand-narrowed each time.
- A mutation **survived**: changing `let fps = 24` in `detectFPSFromHeading`. The suite had an assertion labelled "the documented 24 fps default" — but it tested `parseALE('')`, which returns early with its *own* hardcoded 24 and never calls `detectFPSFromHeading`. Two copies of one constant, one of them untested, and a test whose name covered both while its mechanism covered one. Fixed on both sides: `DEFAULT_FPS` is now a single constant, and a new case exercises a heading with no `FPS` line.

- **Build:** `build-verify` PASS (pytest 250 passed / 7 skipped; XSS + XXE + fail-open gates clean). `npm run test:js` exit 0 across all suites. `build:renderer` PASS (367 files, v2026.6.1).
- **Files:** `src/scripts/parsers/ale.js`, `tests-js/aleParser.test.mjs`. Both clean of pre-existing changes; no mode flips.
- **Next:** the zero-event silence itself is untouched and is now the more interesting defect — with drop-frame fixed, an empty ALE import means something genuinely went wrong, and both call sites still say nothing. Logged as area 13 finding #4. Also noted: `src/scripts/parsers/fcpxm.js` (23.7K) has **no importers** — it is the dead twin of the live `fcpxml.js` and must not be tested or "fixed" as though it were live (iteration 3's lesson).

---

## Iteration 10 — 2026-07-26 06:00–06:45 — The whole-frame timecode base

**Started somewhere else.** The logged lead was area 13's finding #2: a zero-event ALE import reported nowhere. Ten minutes in, that finding turned out to be half wrong — `handleFiles` does call `showError("No valid events.")` immediately after `parseFromFiles`; I had traced the control flow to the end of one function and stopped at the function boundary instead of following the value into its caller. Only `_mbLoadFiles`, the match-back modal, is genuinely silent. Retraction written into the audit report rather than the finding quietly rewritten.

What was left of the lead was a wording improvement to one toast, which is not worth an iteration. So I widened to the timecode layer underneath it and found something considerably larger.

**The defect.** `src/scripts/modules/utils_time.js`'s exported `tcToFrames`/`framesToTC` — the lowest-level timecode conversion in the app, **607 call sites** — multiplied and divided by the *fractional* frame rate. Timecode does not work that way: it counts on a whole-frame base, 24 frame fields per timecode second at 23.976, 30 at 29.97 non-drop. Runtime probe, not a reading:

| Call | Returned | Correct | Error |
|---|---|---|---|
| `tcToFrames('00:00:01:00', 23.976)` | 23 | 24 | −1 |
| `tcToFrames('01:00:00:00', 23.976)` | 86313 | 86400 | **−87 (3.6 s)** |
| `tcToFrames('01:00:00:00', 29.97)` | 107892 | 108000 | −108 |
| `framesToTC(86400, 23.976)` | `01:00:03:14` | `01:00:00:00` | drifts |
| round-trip `01:00:00:00` @23.976 | `00:59:59:23` | itself | **lossy** |

A five-second span measured **119 frames instead of 120** — a VFX pull one frame short. And `getProjectFrameRate` **defaults to 23.976**, the exact rate it got wrong.

**Why it lasted.** Three places already had the rule right and each worked around the bare pair *on the way in* instead of fixing it. `timecodeToFrames`, the wrapper directly above, calls `tcToFrames(tc, Math.round(fps))` and spends three comment lines explaining that the fractional fps "breaks frame↔TC round-trips". `xml.js::normFps` rounds before every conversion, with the same explanation. And `timecodeFuzz.test.mjs` names the pair's contract "nominal-base" while fuzzing it at `[24, 25, 30, 50, 60]` — exactly the set of rates on which the broken code is correct. **The test's exclusion list was the bug report.** The general form, added to the running list: *a wrapper that defends itself against its own callee hides the callee's defect from every other caller* — and it looks like diligence, because the defence and the documentation are the same three lines.

**Load-bearing check first** (iteration 7's lesson), before touching 607 call sites: `t × 23.976` divides back to correct *seconds*, so seek/duration code doing `frames / fps` could have been depending on the wrong count. The only such arithmetic in the pull/export/timeline modules is `edl_export.js:116`, inside that file's own local `framesToTC`, which never sees the import. No existing assertion pinned the old values. So the fix is a **no-op for every integer-rate caller**.

**Code.** Private `nominalBase(fps)` — `Math.round`, with a finite/positive guard — used by both functions; `| 0` replaced with `Math.round` (on an integer base the truncation did nothing but impose a silent wrap at 2^31 frames).

**Testing, and the part that mattered.** I extended the fuzz suite to all eight supported rates — 26 checks × 4000 samples, green. That was not sufficient evidence, and the mutation sweep is what showed it: the property `tcToFrames(framesToTC(f, fps), fps) === f` holds for any **self-consistent** base, so flooring 23.976 to 23 round-trips perfectly. Invertibility cannot tell base 24 from base 23. Only absolute frame counts can, so `timecode.test.mjs` gained 13 assertions pinned to what timecode itself says (1h @23.976 = 86400) plus fractional-vs-integer agreement checks. `Math.round`→`Math.floor` was caught **only** by those, never by the fuzz. Fourth instance this run of *a green suite tells you the assertions passed, not that they ran against the thing their names claim* — and the first where the inadequate assertion was a property test, the kind usually trusted most.

Sweep: **10 mutants, 8 caught, 2 provably equivalent** (`ceil`≡`round` since all three fractional presets sit below the .5 boundary; `trunc`≡`round` on an integer operand). One mutant initially **survived** — deleting `framesToTC`'s negative clamp, after which `framesToTC(-5, 24)` returns `"-1:59:59:19"`, a string that re-parses as a *positive* time and would read as a real handle. Closed with 3 assertions.

- **Build:** `build-verify` PASS (250 passed / 7 skipped; XSS + XXE + fail-open gates clean). `npm run test:js` exit 0, zero failures across 85 suites — including `aleParser.test.mjs`, whose cross-parser assertion is relative and moved 107892→108000 on both sides. `timecode.test.mjs` 33/0, `timecodeFuzz.test.mjs` 26/0. `build:renderer` PASS (367 files).
- **Files committed:** `src/scripts/modules/utils_time.js`, `tests-js/timecode.test.mjs`, and these two documents. `timecode.test.mjs` carries a foreign `644→755` mode flip; 45 files in `tests-js/` have the same `-rwx------` mode, some untouched since June, so it is a property of the working tree and **not** committed (staged content only, index mode held at 644).
- **`tests-js/timecodeFuzz.test.mjs` is deliberately NOT committed**, though I edited it and it is the file that first exposed the defect. It is untracked, and staging it revealed why that matters: it imports `electron/native/seekModel.js`, which is **also untracked**. Verifying the staged tree with `git checkout-index -a --prefix=` — tests run against exactly what will be committed — the fuzz suite died with `ERR_MODULE_NOT_FOUND`. Committing it would have put a test in `tests-js/*.test.mjs` that cannot resolve its own import at HEAD, so `npm run test:js` — which does `|| exit 1` on the first failure — would fail for anyone who cloned the repo. Landing that while reporting the iteration green would have been worse than the bug this iteration fixed. Both files stay in the pre-existing untracked set; pairing them is a scoped follow-up, not a 06:50 decision about authorship of a file I did not write. **The staged-tree check earned its place here: nothing in the worktree run could have caught this.**
- **Logged, not fixed** — three more private timecode readings, deliberately left for a scoped pass rather than fanned out at 06:40: `fcpxml.js:336` (colon-only, `\d{2}`-only, **returns 0** on no match); `prproj.js:465` (`split(':')`, no `[:;]`, no subframe strip); and `edl_export.js` ~105/~113, whose **local copies shadow the file's own imports** and whose `frames % fps` produces a fractional frame field at fractional rates. *(Correction, iteration 11: the "shadow the file's own imports" clause is **wrong** — `edl_export.js` had no imports at all. They were private copies with nothing to shadow. The `frames % fps` half was right, and worse than stated; fixed in iteration 11.)* That is now four-to-six competing implementations of one conversion; converging them is the natural next piece of work.

---

## Iteration 11 — 2026-07-26 ~06:30–07:15 · The EDL exporter's private timecode copy: every REC column zeroed at every fractional rate

**Followed the loose thread I logged and refused to chase at 06:50.** Iteration 10 ended by listing three more private timecode readings and calling convergence "the natural next piece of work". This is that piece — for one of the three, `edl_export.js`, chosen because it is the only one of the three that writes a **delivery artifact** rather than reading one.

**The defect, and it is worse than "duplicate logic".** `buildEDLFiles` emitted an EDL in which **every REC IN and REC OUT column was `00:00:00:00`** — an entire record timeline of zero-duration events — at 23.976, 29.97 and 59.94. Every integer rate was correct. Runtime probe against the real module, two events, `recStartAtZero`:

| fps | REC columns emitted |
|---|---|
| 24, 25, 30, 60 | `00:00:00:00 00:00:05:00` / `00:00:05:00 00:00:15:00` ✅ |
| **23.976, 29.97, 59.94** | `00:00:00:00 00:00:00:00` / `00:00:00:00 00:00:00:00` ❌ |

Mechanism, traced value by value: `dur = 119.88000000000466` → the private `framesToTC` does `frames % fps` on a **fractional** rate, producing a fractional frame *field* → `"00:00:05:0.12000000000000455"` → that hits `safeTC`, fails its `\d{2}` regex, goes through `Number()` to `NaN`, and comes back **`"00:00:00:00"`**.

**And fractional fps genuinely reaches it.** Not hypothetical: `parseALE` on a header reading `FPS 23.976` sets `parsed.fps = 23.976` (`ale.js:60`) and stamps `ev.fps = 23.976` on every event (`:173`); `buildEDLFiles` reads `Number(events[0]?.fps)` at line 807. An ALE from a real dailies house is the ordinary input.

**The new general lesson — a sanitizer can conceal the defect it catches.** `safeTC` exists to stop malformed timecode reaching the file. It succeeded, and that is the problem: it converted a string any conforming CMX3600 reader would **reject loudly** into a well-formed `00:00:00:00` every reader **accepts silently**. Without `safeTC` this would have been a parse error in an editor on the first fractional-rate export and someone would have filed it years ago. Added to the running list: *a wrapper that defends itself against its own callee turns a loud failure into a quiet one and hides the callee's defect from every other caller.* This is the second form of iteration 10's lesson and the more dangerous one.

Also why my **first probe came back clean**: I tested the pass-through export path, where `safeTC` short-circuits already-well-formed TC strings and never computes anything. The defect only fires where a frame count crosses into the timecode grid — chiefly `rebuildRecFromZero`.

**Convergence was deliberately partial, and measuring first is why.** Iteration 4's heuristic says converge N disagreeing derivations onto the exported one. I measured the exported one before trusting it: `utils_time.tcToFrames('01:00:00', 24)` → **`NaN`**, and `('garbage', 24)` → **`NaN`**, where `edl_export`'s strict regex-gated parser returns `0`. A wholesale swap would have fixed the frame-rate bug and introduced `NaN` into a delivery-artifact writer. So **only `nominalBase` is shared**; the stricter local parser stays, with a comment saying why it stays. *Converging duplicated logic without diffing the behaviours first is how the next defect gets introduced.*

**Testing — and the mutant that exposed the same blind spot a third time.** Seven new tests in `tests-js/edlExport.test.mjs` (24 total): the zeroed-REC regression, byte-identical output for 23.976≡24 / 29.97≡30 / 59.94≡60, a no-malformed-timecode-anywhere sweep across 8 rates × 3 option sets, and a 120-frames-in-five-seconds check. First mutation sweep: **4 of 6 caught** — and `nominalBase: round→floor` **survived all six of my new assertions**. Because frames never escape the timecode domain inside this file, a consistently-wrong base cancels out even in the *cross-rate equality* tests: floor 23.976 to 23, count five seconds as 115 frames, format back on base 23, and the EDL text is byte-identical. The base is observable only where an **absolute frame count crosses into the timecode grid**, and this file has exactly one such door — the `ev.durFrames` fallback in `rebuildRecFromZero`. One test through that door (`durFrames: 120 @23.976 → REC OUT 00:00:05:00`; base 23 gives `00:00:05:05`) closed it. Second sweep: **5 caught, 1 provably equivalent** (`ceil`≡`round` for every rate in `FPS_PRESETS`).

- **Build:** `build-verify` PASS (250 passed / 7 skipped; XSS + XXE + fail-open gates clean). `npm run test:js` exit 0 across 87 suites. `edlExport.test.mjs` 24/24. `build:renderer` PASS (367 files, v2026.6.1).
- **Files committed:** `src/scripts/modules/utils_time.js` (one word — `nominalBase` exported), `src/scripts/modules/edl_export.js` (19 insertions / 3 deletions), `tests-js/edlExport.test.mjs`, and these two documents.
- **`edl_export.js` was already dirty before I touched it, and this nearly repeated the iteration-5 contamination.** `git diff` showed 40 changed lines where mine were ~22. The extra hunks are the user's **pre-existing uncommitted drop-frame work**: `[:;]` separator regexes in `tcToFrames` and `safeTC`, `buildHeader(..., isDropFrame)` emitting `FCM: DROP FRAME`, and an `isDF` detection block in `buildPartEDL`. `git add -p` is interactive and unavailable here, so I backed the worktree file up (`/tmp/edl_worktree_BACKUP.js`, sha recorded), restored it from HEAD, re-applied only my three edits, verified the diff was 19/3, committed, and **restored the backup byte-for-byte afterwards**. The user's drop-frame work remains uncommitted and unchanged, which is where they left it.
- **Corrected a claim I committed in iteration 10.** Area-14 finding #8 and the `8bb0ed6` commit message both say the local copies "shadow the file's own imports from `utils_time.js`, making those imports dead." **False** — `edl_export.js` had *no imports at all*. Private copies with nothing to shadow. The severity was also understated: Medium, when the actual consequence was a corrupt REC timeline in a delivered EDL. Both documents now carry the correction; the commit message cannot be amended without rewriting history and is noted in the morning report instead.
- **Logged, not fixed:** `utils_time.js::tcToFrames` returns `NaN` for short or garbage input (area-15 finding #5) — the reason convergence was partial, and worth its own scoped pass. `fcpxml.js:336` and `prproj.js:465` remain from iteration 10's list, both read-side.

---

## Iteration 12 — 2026-07-26 ~06:58–07:05 · The follow-up I logged was wrong, and finding out why exposed a dead fallback chain

**No source changed. This iteration retracts one of my own logged items and replaces it with four evidenced findings.** Full detail in the audit report, 16th area.

**What I set out to fix.** Iteration 11 ended by logging: *"`utils_time.js::tcToFrames` returns `NaN` for short or garbage input — worth its own scoped pass."* A `NaN` leaking out of a parser looks like an obvious defect, and it was the natural next item.

**Load-bearing check first** (iteration 7's lesson) — and it stopped the change cold. About twenty call sites, including `ui.js:362`, `:394`, `:398` and `shotWorkItems.js:77`, wrap the result in `Number.isFinite(...)` and use a false result to mean *"this timecode is unusable — skip it, or try the next strategy."* The `NaN` **is** that signal. Making `tcToFrames('01:00:00')` return a number would have converted twenty loud skips into twenty silent wrong values. **The item is retracted, not deferred.**

**And `ui.js` is the proof, because it already made that exact mistake.** `ui.js:273` holds a **fourth** private `tcToFrames` (after `utils_time`, `edl_export`, `fcpxml`, `prproj`). It returns **`0`** on a non-match instead of `NaN`. Consequence, measured against an exact transcription of `durFramesFor` (`ui.js:389-400`):

| Event — all are genuine 5-second events with valid REC timecode | duration @24 |
|---|---|
| src + rec both valid | 120 ✅ |
| src absent / empty / malformed / **drop-frame `01:00:00;00`** / 3-part | **0** ❌ |

`Number.isFinite(tcToFrames(t))` is `true` for `null`, `''`, `'garbage'`, `'01:00:00;00'`, `'1:2:3'` — every input. So the guard at `ui.js:394` is a **tautology**, malformed src gives `0 >= 0`, the branch returns 0, and **the rec-duration fallback at `ui.js:397-399` is unreachable dead code** — dead in precisely the cases it was written to handle. The `Number.isFinite` check at `ui.js:362` is likewise a branch that can never be taken.

**The lesson, added to the running list:** *a sentinel that passes the caller's validity check is worse than a value that fails it.* This is iteration 11's `safeTC` lesson in a second costume — there a sanitizer replaced a rejectable timecode with an acceptable one; here a parser replaces an unusable frame count with a usable-looking one. Both turn a loud failure quiet, and both read as defensive programming. I walked into the same trap from the other side by proposing to *remove* the `NaN`.

**Also found:** `ui.js:273`/`:279` carry the identical fractional-rate defect fixed in `edl_export.js` an hour earlier (`*fps`, `fr % fps`) — `tcToFrames('01:00:00:00', 23.976)` → `86313.6`, `framesToTC(120, 23.976)` → `"00:00:05:0.12000000000000455"` — and this file has **no `safeTC`**, so the malformed string reaches the UI verbatim rather than being zeroed. `normalizeFpsNominal` (`ui.js:294`) exists to prevent exactly this and is the **fifth** caller-side workaround for a callee defect found this run, but `ui.js:6344` and `:19205` read `view[0].fps` raw — which `parseALE` sets to `23.976` on the ordinary dailies path.

**Why nothing shipped.** `durFramesFor`/`computeEdlRecMap` are private to `ui.js` — unreachable from `tests-js/`, so any test would have to transcribe them, which iteration 3 established is not coverage. `src/scripts/ui.js` is already dirty with 32 insertions / 7 deletions of pre-existing work, needing the same backup-restore-reapply manoeuvre `edl_export.js` needed this morning — a risk worth taking only behind a verified change. And `ui.js` is the DOM-coupled renderer entry point: `node` cannot load it and `build:renderer` only copies files, so a broken edit yields a **green build and a broken app**. There was about an hour left on the clock; I stopped anyway, because the extra time does not create a way to verify the edit.

**The scoped daytime pass this hands over:** lift `durFramesFor` into `src/scripts/modules/` as an exported helper, point `ui.js` at it, test it directly, and converge `ui.js:273`/`:279` onto `nominalBase` exactly as `edl_export.js` was converged. Probes are already written — `/tmp/probe12b.mjs` reproduces the dead fallback in isolation.

- **Files committed:** `PostFlowX_Audit_Report.md`, `PostFlowX_Nightly_Backlog.md`. No source, so `build-verify` and `build:renderer` are unchanged from iteration 11 — both green (250 passed / 7 skipped; 367 files).

---

## Iteration 13 — 08:13-08:25 · the handover item, shipped · commit `64b2848`

The overnight pass ended by writing this exact task down: *"lift `durFramesFor` into `src/scripts/modules/` as an exported helper, point `ui.js` at it, test it directly, and converge `ui.js:273`/`:279` onto `nominalBase`."* Done, with two things the note did not anticipate.

**The first: there are two chains, not one.** `computeEdlRecMap`'s `durFramesFor` was the known site. The Inspector has its own hand-inlined copy at `ui.js:12971-12986` — same three steps, same `Number.isFinite` guard on a parser that returns `0`, same unreachable third step. It renders to a user-visible label (`insDuration`), so a malformed or drop-frame source timecode printed **`00:00:00:00 / 0 fr`** while the event's own record columns said four seconds.

**The second: `0` and NaN are both right answers, to different callers.** The record map sums durations across a timeline — one NaN there poisons every row after it, so it needs `0`. The Inspector displays a single duration and already had a `"—"` for unknown — giving it `0` would have replaced an honest "unknown" with a confident false zero. So the module exports both: `measuredDurationFrames` (NaN when the event says nothing readable) and `durationFramesFor` (folds that to 0 for callers that add). Collapsing them would have quietly downgraded the Inspector.

**What shipped**
- `src/scripts/modules/eventDuration.js` (new) — `parseTimecodeFrames` answers **NaN**, counts on `nominalBase`, accepts `;` and Resolve's subframe suffix; the two duration entry points above.
- `src/scripts/ui.js` — both chains call it. The private `tcToFrames`/`framesToTC` pair **keeps its `0` sentinel** (thirty call sites in that file add its result into a running total) but both now use `nominalBase`, closing the fractional-rate defect that produced `"00:00:05:0.12000000000000455"`.
- `tests-js/eventDuration.test.mjs` — 54 assertions, picked up automatically by `build-verify`.

**Verified, not assumed.** `/tmp/probe13.mjs` runs the pre-fix chain transcribed verbatim from `ui.js` beside the new module on the same inputs. Empty, absent, malformed, three-part and drop-frame source timecodes each measured **0** and now measure the record span (96, 96, 60, 96, 120); a four-second span at 23.976 measured **95.904** and now measures **96**. Every `(was 0)` in the test names is a number that probe printed, not a label I chose.

**On overnight's third reason for not shipping** — *"`ui.js` cannot be exercised at all in this environment"* — that is still true of `ui.js` and is why the logic left the file. What remains in `ui.js` is three call-through lines and a two-line change to each private helper; the staged version was extracted with `git show :` and parsed clean as ESM. The logic itself now has real assertions behind it for the first time.

**Commit hygiene.** `ui.js` still carries 32 insertions / 7 deletions of pre-existing work (friendly error text; Fun-box iframe lifecycle). Rather than the backup-restore-reapply dance, I split the diff by hunk — `git diff` → drop the four foreign hunks → `git apply --cached --recount` — then confirmed the worktree residual was exactly the original 32/7 and that the staged file contains none of the user's identifiers. This is the manoeuvre `6e14ec6` needed and did not get.

- **Build:** `build-verify` green (250 passed / 7 skipped; all `tests-js` green, exit 0). `build:renderer` → 368 files (was 367 — the new module).

---

## Iteration 14 — 08:56-09:21 · the timecode base convergence, and the bug hiding underneath it · commits `7372184`, `1feb2f6`, `347d276`

Iteration 13 handed over a list: eight live files still counting timecode on the playback rate. Three of them are now converged, and the third turned out not to be the bug I went looking for.

### `7372184` — `features/reviews/store.js`

Marker source timecode rendered **`01:00:09:23.616000000003282`** at 23.976. `padStart` does not round, so the fractional frame field was stringified whole into a user-visible label. `tests-js/reviewsStoreTimecode.test.mjs`, 111 assertions.

### `1feb2f6` — `modules/cutdiff.js`

A four-second clip measured **`_pullLenFrames: 95.90400000000955`**. That number is the length of a VFX pull, and it leaves the module. Now 96. `tests-js/cutdiff.test.mjs` 13 → 50 assertions.

The file's `framesToTc` had the mirror defect and I fixed it too — but its four call sites are all `ev.X || framesToTc(nf.XF, fps)` where `nf.XF` is `tcToFrames(ev.X)`, so when the fallback fires `ev.X` was falsy, the parse returned 0, and the only reachable output is `"00:00:00:00"`. **Unreachable.** Said so in the source comment, the test comment and the commit message rather than banking it as an observable fix.

### `347d276` — `parsers/fcpxml.js`, and the inverse bug class

The other seven files make labels *malformed*. This one made positions *drift*.

Every FCPXML time attribute is a rational number of **real** seconds, and the frame it denotes is `value / frameDuration`. `fcpxml.js` rounded the rate **at the source** — `Math.round(den/num)` in both the formats map and `readFPS` — so `ratToFrames` multiplied real seconds by 24 where it should have multiplied by 23.976. Positions are absolute, so the error grows with position down the reel: **86 frames (3.6s) late at the hour mark, 172 at two hours.** 23.976 is the default rate in film and episodic post. This was the main path, not an edge case.

Probe before: `_seqBaseFrames=86486` (want 86400), `recIn=01:00:03:14` (want `01:00:00:00`). After: exact at all six broadcast rates, integer rates bit-identical.

**The fix keeps two rates in one file, deliberately.** The internally-threaded `fps` is now exact so `ratToFrames` is right; `nominalBase()` is applied at the two places a whole number is required (the `framesToTC`/`tcToFrames` pair) and at every place a rate leaves the module (`res.fps` ×4, `event.fps` ×3, `srcFps`). `res.fps` still reports **24** for a 23.976 sequence, so the public contract is unchanged and **zero downstream work was required**. A header comment states the split so the next reader does not "simplify" it back into one rate.

**One deliberate behaviour change, asserted rather than hidden.** A bare `tcStart="3600s"` now reads as 3600 *real* seconds — `00:59:56:10` at 23.976 — where it used to answer `01:00:00:00`. That is the spec answer, and no conforming NTSC exporter writes that form (a whole second is not a frame boundary at 24000/1001). Encoded as a test with the reasoning attached so it cannot be rediscovered as a regression.

New fixture `test/fixtures/fcpx_ntsc.fcpxml` plus four tests: the golden, an exact-resolution sweep over 24 / 23.976 / 25 / 29.97 / 30 / 59.94, a two-hours-deep drift check, and the bare-seconds case.

### The sibling-parser scan came back clean

`xml.js` already splits `tcBase` from `playbackFps`. `prproj.js` computes `actualFps = ntsc ? nominal*1000/1001 : nominal` and uses it for `ticksPerFrame` (ticks are a real-time unit, so that is correct) while returning `nominalFps` for display. `otio.js` normalises exact→nominal through an explicit table. `ale.js` and `edl.js` have no rate arithmetic. **`fcpxml.js` was the only parser that collapsed the two rates.** Recorded, not churned.

- **Build:** `build-verify` exit 0 (250 passed / 7 skipped; XSS/XXE/fail-open gates clean), `build:renderer` → 368 files. Grepped the suite output for `fcpx_ntsc.fcpxml` to confirm the new tests ran *inside* the suite, not just standalone.
- **Commit hygiene:** `store.js` was already dirty — the CSV formula-injection guard, 2 ins / 1 del, not mine. Caught by filtering the diff for lines I did not write, split by hunk, residual verified intact afterwards. A 644→755 mode flip on the new test file was caught by `git diff --cached --summary | grep -i mode` and cleared before committing.

---

## Iteration 15 — `7791423` — the two-rate contract

The last five iterations each fixed one file that had guessed wrong about what `fps` meant. This one removes the reason there was anything to guess.

### RESEARCH — `fps` had no single meaning, and that *is* the bug class

Surveying all six live parsers for what they actually put in the `fps` field:

| parser | what `fps` was | for a 23.976 show |
|---|---|---|
| `fcpxml.js` | nominal whole base | `24` |
| `prproj.js` | nominal whole base | `24` |
| `otio.js` | nominal whole base | `24` |
| `xml.js` | **true playback rate** | `23.976023976…` |
| `edl.js` | **whatever the header said** | `23.976` (from `FRAME_RATE:`) |
| `ale.js` | **whatever the header said** | `23.976` (from `FPS\t`) |

Three different answers under one name. Every downstream module had to guess which it had been handed — and **the workarounds are a census of the defect**: `prep_mark` learned to reach past `fps` for `timecodeBase`; `trlconf` did not, and ran whole NTSC conforms on fractional frame counts.

**This corrects iteration 14's sibling scan**, which recorded that "`ale.js` and `edl.js` have no rate arithmetic." They have no rate *arithmetic*, which was true and beside the point — they `parseFloat` a header rate directly into `fps` and stamp every event with it. A fractional rate reaching `fps` is the same defect whether it was computed or copied. The scan asked the wrong question.

### CODE — both rates, named

Every parser now exports:

- **`fps`** — the whole-frame timecode base: how many frame fields fit in a timecode second. Always an integer. What TC↔frames math must use.
- **`fpsExact`** — the true playback rate. What real-time math must use: seconds↔frames, an A/V clock, an AE comp's frame rate.

0.1% apart on every NTSC rate — 3.6 seconds per hour. Small enough to look like nothing in a unit test, large enough to lose sync.

`nominalBase()` from `utils_time.js` (leaf module, zero imports) is the shared derivation. `edl.js` and `ale.js` previously had *zero* imports; before adding one I verified both are real ES modules and checked every load site, including the `await import(...)` and `chrome.runtime.getURL` paths a static grep does not see.

### The finding that changed the shape of the fix

Mid-iteration, tracing who consumes `xml.js`'s rate turned up `_pmFpsToRational` (`prep_mark.js:77`). It matches 23.976 → `24000/1001`, but **falls through to `{num: Math.round(fps), den: 1}`**.

So the FrameClock was right for XMEML and quietly wrong for everything else: an NTSC **FCPXML** reported `24`, matched no NTSC entry, and ran the A/V clock at `24/1` — **0.1% fast, 3.6s of drift per hour against the media.** XMEML was the only source that got the rational right, and it got it right *because of the very line that broke trlconf's conform math*.

That settled the design. Under a one-rate contract the two consumers **could not both be correct** — so the split is the fix, not a tidy-up. Making `xml.js` merely match its siblings would have fixed trlconf and broken the clock for all six sources. `prep_mark` now reads `fpsExact` first, so every source feeds the clock the true rational rate.

### AUDIT

Same show, same `01:00:00:00`, downstream `_tcToFrames(tc, result.fps)` in trlconf's shape:

| | before | after |
|---|---|---|
| XMEML | **86313.68631368632** | **86400** ✓ |
| FCPXML | 86400 ✓ | 86400 ✓ |

Enforced centrally in `test/_contract.mjs` — `fps` integer, `fpsExact` positive, `round(fpsExact) === fps` — rather than per-parser, because per-parser assertions are exactly how the three answers diverged in the first place. All five existing parser test files are subject to it.

**`xml.js` had five call sites and no test file at all.** Added `test/parsers/xml.test.mjs` (5 tests) with NDF and NTSC fixtures, a six-rate sweep, an error-path shape check, and a regression that runs a downstream conform and asserts it reaches 86400 *whole* frames.

**A first draft of the fixtures was wrong and got caught by looking at the output before writing assertions.** I had set each clipitem's `<file><timecode><frame>` equal to its own `<in>`, so a 4-second in-point step produced an 8-second `srcIn` step. The parser was correct — XMEML `<in>` is an offset *into* the media and `srcIn = fileTC + in`, so my fixture double-counted. Asserting the observed numbers would have baked my own fixture error into the suite as expected parser behaviour.

**Two ALE assertions failed, correctly.** `tests-js/aleParser.test.mjs` asserted `fps === 29.97` and `fps === 23.976` — the old single-rate contract. Updated to assert *both* halves, which is stronger than before: the header rate is still read verbatim (now `fpsExact`), and the derived base is checked too. The fact the old tests protected is not lost, it is checked in the right place.

- **Build:** `build-verify` exit 0 (250 pytest passed / 7 skipped; XSS/XXE/fail-open gates clean), `build:renderer` → 368 files.
- **Commit hygiene — two catches.** `prep_mark.js` was dirty with ~60 foreign hunks (835 ins / 138 del) against my 11 lines; `edl.js` carried a foreign `isVideoTrack` hunk. Both split out by patch surgery and verified absent from the staged diff. Then `git update-index --chmod=-x` **silently re-registered the whole working-tree file**, putting all 973 lines back into the index — caught only because the staged stat was re-read after the chmod rather than assumed. Restaged from the isolated patch. Final commit: 346 insertions across 12 files, no mode flips.

**Heuristic for the file:** `git update-index --chmod` is not a mode-only operation — it re-stages content. Never run it on a file that is partially staged, and always re-read `git diff --cached --stat` afterwards.

---

## Iteration 16 — the consumer side of the two-rate contract (`580acb0`)

**Item picked:** finish what iteration 15 started. It15 fixed six *producers* so `fps` and `fpsExact` mean one thing each. `trlconf/index.js` is the consumer that most needed them and had not been threaded — it ran ~20 frames↔seconds conversions on `state.fps`, and every one of them feeds real media time.

**Owning the regression.** Before it15 the XMEML path reported `fps = 23.976`, so the seeks in this engine were right and `_tcToFrames` was wrong. After it15 `state.fps` is always the whole base, so the conform math became right everywhere and the seeks became *consistently* wrong on every NTSC show. That is a regression I introduced, not a defect I discovered. This iteration closes it.

**What changed.** `fpsExact` threaded through the reference seek, the master hint, the AI and hash search calls, the seconds→frames result coming back out of a seek, the verify panel, the wave-offset readout, timeline load (both sites), session save/restore, and reset. Timecode arithmetic — `_tcToFrames`, `_framesToTC`, `_eventFrameMetrics`, sample offsets — deliberately stays on the base. `ai_matcher.js` takes the matching parameter rename and docblock.

Backward compatible by construction: `fpsExact = fps` as a defaulted parameter and `state.fpsExact || state.fps` at every read, so any untouched caller or pre-existing saved session keeps exactly today's behaviour instead of silently changing rate.

**Left alone on purpose.** `_refineSourceOut`, `_detectShotsFromVideo`, `_assertDecodable`, `_retimeDescriptor`, `_withNativePaths`, `_fpsIsDrop`, the `regionalHash`/wideSearch branch, and three further `_matchEventByVisualWave` call sites (working-tree ~3351/~3423/~3632) **do not exist in HEAD** — all verified at zero occurrences in `git show HEAD:…`. They are in-flight work in the tree and inherit today's behaviour through the default.

- **Build:** `build-verify` exit 0 (250 pytest passed / 7 skipped), `build:renderer` exit 0 (368 files). Both green — and both blind to this change, see the audit report.
- **Commit:** `580acb0`, exactly 2 files, 95 insertions / 20 deletions, no mode flips, no foreign hunks.

### Commit hygiene — the technique had to change

`index.js` is the single dirtiest file in the tree: **155 `-U0` hunks** against HEAD. I had verified that every line I edited was byte-identical to HEAD and concluded the hunks would therefore be isolable. They were not. `git diff -U0` merges a changed line with any foreign changed line *contiguous* with it, so **5 of 24 hunks came back mixed** — the worst being `@@ -723 +872,80 @@`, where 80 lines of the user's `_assertDecodable` / `_refineSourceOut` / `_retimeDescriptor` sit immediately above my `_matchEventByVisualWave` signature.

Pivoted to reconstructing the staged content instead: `git show HEAD:…` to a pristine baseline (sha256 pinned and re-verified after every run), a scripted apply of all 22 edits with per-edit occurrence assertions, then `git hash-object -w` + `git update-index --cacheinfo` to stage that blob directly. The working tree was never written to — the user's in-flight work stays modified-but-uncommitted, confirmed after the commit.

## Iteration 17 — a survey that retired more backlog than it added (no code change)

**Item picked:** the carried "still open" list itself. Before spending an iteration fixing the next rate defect, check that the items are still true. Four were surveyed; **three turned out not to be fixable defects at all.**

| Carried item | Reality |
|---|---|
| `features/edl/filters.js` unsurveyed | **The file does not exist.** Stale path. The real files are `modules/filters.js` (live, reached via `await import` from `ui.js:114`), `modules/filters_common.js`, `modules/filters_vfxRename.js`. |
| `filters_common.js` `tc()` | Carries the two-rate defect exactly, but its **only consumer repo-wide is `tests-js/filtersVfxRename.test.mjs:8`**. Production-dead. Documentation-only. |
| `timelineAutoInject.js:53` private `tcToFrames` | **Zero importers repo-wide.** So is the component it pulls in: `components/timeline/index.js` is imported by exactly two files — the dead injector, and `cutdiff/index.js:7`, which imports `createTimeline` and never calls it. ~1,000 lines reachable by nobody. |
| `aceslook` TC overlay (new this iteration) | Two different defects, only one reachable — see the audit report. |

**No source was changed.** Nothing here was both reachable and fixable inside the time left, and manufacturing a change to a dead file to keep a streak would be the opposite of the point. Build state is unchanged from `580acb0` — last verified green there.

- **Docs commit:** this section plus the audit-report section, 2 files.
- **Packaging:** the one-time repackage ran at 14:19 (`build:renderer` + `build:mac-dir`, exit 0). Because iteration 17 changed no source, that build is the final artefact and rule (5)'s "once" is satisfied exactly.

---

## 21:00 run — iteration 1 · plain-language failures (`887b161`)

**Objective shift.** Runs 1–2 chased timecode correctness. This run's brief is
different: *a professional, user-friendly tool that stays accessible to
non-technical users.* So iteration 1 went after the moment a non-technical user
is least served — the moment something fails and the app answers with
`ENOENT: no such file, open /Volumes/…`.

**What actually happened is the finding.** I began by designing a new shared
error explainer (`modules/errorExplain.js`, 257 lines, 31 tests, all green) off a
survey of `render_queue.js`'s private `_parseError` and three `_showToast`
implementations. Then I found `src/scripts/core/friendlyError.js` in the working
tree: untracked, already written, already wired into `index.html:13`,
`ui.js:3284` `showError()`, and all three toasts — with its own test file. I had
built a duplicate of something that already shipped, and shipping mine would
have produced two modules doing one job with one of them unwired: exactly the
dead code iteration 17 spent itself retiring.

Deleted my module and its tests. Folded the value into theirs instead.

> **Heuristic (new).** *A claim about what the app lacks rots exactly like a
> claim about what it contains.* Iteration 17 learned that carried backlog items
> go stale; this is the mirror image. Worse, an untracked file is invisible to
> every HEAD-based check — `git log`, `git grep`, `git show` all agree it isn't
> there. Grep the working tree, not the index.

**Method.** Rather than judging gaps by eye, ran `friendlyError()` over a
23-string corpus of error text this app genuinely emits and read off which fell
through to raw. Six did. Five were fixed:

| Fell through as | Now reads |
|---|---|
| `EBUSY: resource busy, unlink` | File is in use — *close it in the other app, often Resolve or Premiere* |
| `moov atom not found` | Could not decode media |
| `Failed to mux output stream` | Export could not be written — *check the output folder* |
| `RuntimeError: memory access out of bounds` | Ran out of memory — *close the other tabs* |
| `fetch failed` / `getaddrinfo ENOTFOUND` | Network problem |
| `{}` → `[object Object]` | Something went wrong. |

**The sixth was withdrawn, and that is the more useful entry.** I added a
`/Volumes/` rule reading "Drive not connected", then found
`tests-js/friendlyError.test.mjs:9-10` asserts an ENOENT under `/Volumes/X/a.mxf`
says "found" *and* preserves the full path. Those are deliberate assertions. My
rule truncated the path to the volume root and changed the wording, so it broke
both. Removed it rather than overriding the author's intent — and their existing
ENOENT hint ("Check that it still exists and the drive is connected.") already
covers the drive case without losing the filename an assistant needs.

**Kept their design, not mine.** My module always overrode; theirs passes
unmatched text through untouched. Theirs is the better call: at all four wired
call sites the app already writes good messages ("Scan a VFX folder first."),
and an always-override humanizer would degrade them. A test now pins that.

**Verify.** 46 tests (23 theirs + 23 new). `npm run test:js` exit 0 across all
90 files; `build-verify` 250 passed / 7 skipped + three security gates clean;
`build:renderer` 368 files.

**Commit hygiene.** All three files were untracked, so the commit is purely
additive — no reconstructed-blob staging needed and no risk of sweeping foreign
hunks. Staged via `hash-object` + `--cacheinfo 100644` because two of them carry
a stray `0700` from the editor and neither has a shebang.

**Flagged for the user:** `friendlyError.js` and `friendlyError.test.mjs` were
your in-flight, uncommitted work. Committing the module I edited meant committing
them; both dirs are mode-mixed so 100644 was a judgement call, not a convention.
Say the word and I'll `git rm --cached` them back out.

**Next:** the three `_showToast` implementations now all call `pfxFriendlyText`,
so the only remaining duplication is the toast plumbing itself — a candidate for
one shared notifier.

### 21:00 run — iteration 2 · error messages in the user's own language (`1b2fdf1`)

**Why this over the carried item.** The backlog's next entry was consolidating
the three `_showToast` implementations. Under the new objective — accessibility
for non-technical users — that is internal hygiene: it changes no pixel and no
word. The app ships in 7 languages to an audience that is largely not
native-English, so a failure message the user cannot read is the more expensive
defect, and it is measurable rather than a matter of taste.

**The measurement.** Ran all 50 user-facing strings from `friendlyError.js`
against the 3,678-line dictionary in `scripts/modules/i18n.js`. **0 of 50** were
present. Every error in the app was English-only regardless of the chosen
language.

**The trap this nearly walked into.** The obvious fix is to add 50 dictionary
entries and let the existing MutationObserver apply them. Reading the observer
first showed it would not work: the observer only ever sees what `friendlyText()`
produces, which is `message + ' ' + hint` glued into one string, and that
concatenation is not a dictionary key. 300 translations would have been dead
data, and every error would have stayed English with a green test suite. This is
the same shape as iteration 1's miss — *check what the code actually does before
building against what it appears to do* — and it cost one file read to avoid.

**What shipped.**
- `friendlyError.js` gained a `_t()` helper that goes through `window.PFX_t`
  (already exposed at `i18n.js:3676`, the same global-hook pattern as
  `window.pfxFriendlyText`). It deliberately does **not** import `i18n.js`: the
  module is loaded directly by Node tests where there is no `window`, and
  English is correct there. Translation happens on the three parts while they
  are still separate.
- The ENOENT message appends the path *after* the translated sentence instead of
  interpolating it, so no locale carries a placeholder and the filename an
  assistant actually needs is never reworded.
- `ERROR_DICT` in `i18n.js`, 50 strings × 6 languages, merged **before**
  `KEY_SET`/`REVERSE` are built so the entries are indexed for language
  switching.
- `tests-js/errorI18n.test.mjs` — 19 tests, the durable part (see audit report).

**Vocabulary decisions, made by checking the existing dict rather than by ear.**
`"Settings"` is already translated (설정 / 設定 / 設定 / ตั้งค่า / Pengaturan /
Settings) but `"Resolve Engine"`, `"Simple Mode"` and `"IMF Validation"` are in
no dict at all — the UI shows them in English. So `"Settings › Resolve Engine"`
renders with the translated word and the untranslated product name, which is
what is actually on the user's screen. macOS ships no Indonesian or Filipino
localisation, so those two locales keep `"System Settings › Privacy & Security"`
verbatim while ko/ja/zh-TW/th use the localised pane names.

**Verification.** Simulated the browser path with a fake `window.PFX_t` per
locale and read the output for four representative failures in th/ko/fil, plus
the no-`window` case to confirm Node still gets English. The `/Volumes/` path
came through byte-identical in all three. `test:js` 91 files exit 0 (46 existing
friendlyError tests unchanged), `build-verify` 250 passed / 7 skipped with
XSS/XXE/fail-open gates clean, `build:renderer` 368 files.

**Left for later (measured, not guessed).** The app's own hand-written messages
that `friendlyError` passes through untouched — `"Scan a VFX folder first."`,
`"Open the Cut Diff tab, then retry"` and their kind — are also absent from the
dictionary. Those live at call sites across the app rather than in one table, so
they are a separate sweep, not a rider on this one.

## 21:00 run — iteration 3 · the error banner that was never there (`d0ab098`)

**How this was found.** I set out to do the sweep iteration 2 left open: translate
the app's own hand-written messages. Before writing a single dictionary entry I
built a reachability table for the 48 genuinely user-facing prose strings — the
i18n MutationObserver only translates text that reaches the DOM, so a string that
never gets there cannot be fixed by a dictionary. That table is what turned up the
real problem. Checking whether `showError()`'s output reaches the observer meant
first checking whether it reaches the *screen*.

It does not, and never has.

```js
function showError(msg){
  const el = $("#errors");
  if (!el) return;          // ← always taken
  ...
}
```

**No element with `id="errors"` exists.** Verified six ways, because a claim this
large deserves it: absent from `src/index.html` (the only occurrence of the word
"errors" in that file is an unrelated HTML comment at line 5190); absent from the
built `dist/desktop/index.html`; no `.id = "errors"` or `getElementById('errors')`
assignment anywhere in the tree; no `innerHTML`/`insertAdjacentHTML` injection (the
grep hits were an unrelated `errors` array in `vfxPullPanel.js` and a different
`errorsBar` in `imf_package_ui.js`); exactly one definition of `showError`; and
`git log --oneline --all -S'id="errors"'` returns nothing at all, so it was never
present in any commit on any ref. `$` is plainly `document.querySelector`.

**All 66 call sites have been silent since the initial commit `b173ee8`.** Every
export guard, every validation refusal, "Scan a VFX folder first.", "Native VFX
Root is required." A non-technical user clicks Export, the app refuses, and
nothing whatsoever appears. There is no way to distinguish a refused action from a
frozen app — which is the single worst thing this objective could leave standing,
and it outranked the translation sweep by a wide margin.

**What shipped.** `src/scripts/core/errorBanner.js` — a banner that mounts itself
on first use. Markup in `index.html` was the obvious fix and the wrong one:
`index.html` is not shared by the extension target, nor by the `src/tools/bwav/*`
and `src/tools/preflight/*` pages, so a div would have fixed one host and left the
others exactly as broken. A host-supplied `#errors` still wins where one exists,
so this can never displace a page that has its own slot.

Not merely restored — built for the reader the objective names:

| | before | now |
|---|---|---|
| shown at all | no | yes |
| dismissal | flat 4s | `max(4s, min(15s, 3.5s + 55ms/char))` |
| screen reader | — | `role="alert"`, `aria-live="assertive"` |
| dismiss early | — | click |
| long path in message | `nowrap`, pushed off-screen | `pre-wrap`, own line |
| rendering | `textContent` | `textContent` (kept — catch-block text) |

The flat 4s was the quiet one. Iteration 2's `friendlyError` output is a sentence
plus a next step; four seconds is not enough to read that, and a message that
vanishes before it is read is barely better than none.

**Also fixed.** `ui.js:17140` — the tab-reset path wrote to the same phantom
element. It now calls `hideErrorBanner()`, so a stale failure does not survive a
reset.

**Caught before shipping.** An empty banner with `padding: 10px 20px` at
`opacity: 0` is still an invisible ~40×29px box at the bottom of the screen
swallowing clicks. `pointer-events: none` on the base rule, `auto` only on `--on`.

**Verification.** 17 tests in `tests-js/errorBanner.test.mjs`, negative-verified
three ways — dropping the `appendChild`, switching to `innerHTML`, and restoring
the flat 4s each fail exactly the assertion that guards them (3, 1 and 1 failures
respectively). One test scans `ui.js` itself, because a unit test of the module
alone passes perfectly well with the caller disconnected, and that is precisely
the shape of the bug being fixed. `npm run test:js` 22/22 files, `build-verify`
250 passed / 7 skipped with all three security gates clean, `build:renderer` 369
files.
