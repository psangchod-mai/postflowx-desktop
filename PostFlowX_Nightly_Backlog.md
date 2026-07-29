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

## 21:00 run — iteration 4 · plain language at the boundary (`9aa71c5`)

**This iteration exists because of the last one.** Making the banner visible for
the first time converted a latent problem into a user-facing one. Of the 70
`showError()` call sites, **17 pass `err?.message || String(err)` straight
through** — so the first thing a non-technical user now reads is

```
TypeError: cannot read properties of undefined (reading 'frames')
```

where they previously read nothing. Invisible bad wording became visible bad
wording, and shipping iteration 3 without this would have been shipping half a
fix.

**Where the rewrite goes matters more than that it happens.** `friendlyText()`
has existed since iteration 1. Applying it call site by call site fixes 17 places
and leaves the eighteenth — the next one someone writes — unprotected, and misses
`window.pfxShowErrorBanner` entirely. Applying it in `showErrorBanner()`, where
the text meets the screen, means nothing can reach the user unrewritten. The
53 sites that already say something useful are unaffected, because pass-through
is `friendlyText`'s conservative default.

**Two preconditions, both measured rather than assumed.**

1. *Idempotence.* Some callers humanize before calling — including an in-flight
   working-tree change to `showError` — and a rule's own output can re-match its
   own pattern: "The disk is full, so PostFlowX could not finish writing." still
   contains the literal "disk is full". I checked this over the errno set before
   writing the code, rather than after. It holds, and a test now pins it. Without
   it, those messages get their hint appended twice.
2. *Empty text must not be rewritten.* `friendlyText('')` returns "Something went
   wrong." — and an empty message is how every caller **hides** the banner. Left
   unguarded, clearing the banner would have printed an error into it. This is
   the trap of the iteration; four tests fail if the guard is removed.

**Also.** Dismissal timing now measures the rewritten text. A three-word errno
becomes two sentences, and timing the dismissal on the errno would pull the
message off screen before it could be read — the exact defect iteration 3 fixed,
reintroduced through the back door.

**Verification.** 24 tests (up from 17), negative-verified twice: dropping the
rewrite and applying it to empty text each fail four assertions. `test:js` 22/22,
`build-verify` 250 passed / 7 skipped with all gates clean, `build:renderer` 369
files. The `.app` was repackaged unsigned via `build:mac-dir` after iteration 3
and the banner is confirmed present in `app.asar`.

**Note on the working tree.** The committed `showError` is HEAD's body plus the
delegation only; the `window.pfxFriendlyText` line in the working-tree copy is
pre-existing uncommitted user work and was deliberately left unstaged. With the
rewrite now at the boundary, that line is redundant but harmless — idempotence is
what makes it so, and that is now a tested property rather than a hope.

## 21:00 run — iteration 5 · the language selector that stopped at the frame boundary (`f737a88`)

**The audit item was wrong, and the reachability check is what caught it.** The
open item read *"`src/tools/bwav/*` and `src/tools/preflight/*` do not load
`modules/i18n.js` at all — English in all 7 languages."* Both halves turned out
to be false in an interesting way. The panes are not un-internationalised; they
are **richly** internationalised, in systems of their own, and none of it can be
switched on.

| | translations present | how a user selects one |
|---|---|---|
| Host app | 7 languages, `modules/i18n.js` | title-bar flag selector |
| BWAV Inspector | ~92 keys × ja/ko/th/id | *nothing* — `navigator.language` only |
| Preflight Validator | 18 locale files, ~148K | *nothing* — hard-pinned to `en` |

**Both panes read a picker that has never existed.** `bwav/app.js:730` and
`preflight/app/app.js:502` each do `getElementById("localeSelect")`. Neither
`bwav/app.html` nor `preflight/app/index.html` contains that id, and
`git log --all -S'localeSelect'` on both files returns nothing — it was never
there to be deleted. Preflight goes further and builds a six-option flag menu
into the null element every startup.

This is the third phantom element in three iterations, and the second one found
by asking *"is this reachable?"* before *"is this correct?"*.

**Reachability first, again.** Before any of this was worth writing, the panes
themselves had to be reachable — they are, as full workspace panes at
`src/index.html:4895` and `:4905`. Had they been dead, the right answer was to
delete 148K of translations, not to wire them up.

**Why not just add the two missing pickers.** Because then a Thai user has three
language controls in one window and three ways for them to disagree, and they
have already said what they want once. The title-bar selector becomes
authoritative and its choice crosses the frame boundary:

- `core/paneLang.js` posts `{type:'pfx:lang', lang}` to same-origin iframes.
- `i18n.js` calls it from `applyI18n` — the single funnel both `setLang` and
  `initI18nUI` route through — placed **after** `resumeObserver()`, so a pane
  that throws cannot leave the host's MutationObserver paused and kill
  translation app-wide. A test pins that ordering.
- `bwav/app.js` reads `mps.lang` ahead of its own `bwav_locale` mirror, and
  listens for both the message and a `storage` event.

**The load race is the whole reason this is not a one-liner.** Both panes start
`display:none` and load lazily; `initI18nUI` runs at startup. Whichever happens
first, the pane must end up correct — so `broadcastLang` arms a one-time `load`
handler per frame that re-sends the *current* language, not the one it was armed
with. Two tests cover the ordering and a third pins that the handler is armed
once, since N handlers means N duplicate messages per reload.

**Cross-origin frames are skipped**, detected by `contentDocument` throwing. The
Fun Box pane can hold a YouTube embed; a language code is not something to post
at a third party just because it is cheap.

**Preflight was deliberately left out**, and this is the honest part of the
iteration. Its own locale handler ends in `location.reload()`. `state.run` is
persisted but `state.files` is not — so switching language mid-session would
silently discard a file list the user had assembled. That behaviour has never
run in front of a user (the picker was unreachable), so adopting it now would be
shipping a data-loss path that nobody has ever hit. It needs a reload-free
re-localisation, which is its own iteration.

**Verification.** 18 tests, negative-verified three ways — dropping the
broadcast fails 2, consulting the stale mirror first fails 1, removing the load
re-send fails 3. `test:js` 23 files, `build-verify` 250 passed / 7 skipped with
all three gates clean, `build:renderer` 370 files.

---

## Iteration 6 — the phantom-element sweep, and what it actually found

Iterations 3, 4 and 5 each tripped over the same bug independently: code that
looks up an element id nothing in the tree creates. `$("#errors")` in `ui.js`
(66 error messages, none displayed), `#localeSelect` in `bwav/app.js` (six
translations, none selectable), `#localeSelect` in `preflight/app.js` (eighteen
locale files, none selectable). Three discoveries, three files, none of which
threw. The iteration-5 audit called finding them by grep "the single
highest-value open item," so this iteration ran the sweep.

**The measurement corrected the framing.** 311 phantom ids across 440 lookup
sites — and of those 440: **0 crash, 6 deliberate `a || b` fallback, 434
silent.** Every desktop-facing case sampled by hand turned out to be a guarded
leftover sitting beside a working replacement. `#aboutVersion` is dead because
`versionBtn` already receives the version through `setBtn`. `#loadingMsg` is
dead because `_parseProgressShow` carries the progress. `src/index.html` defines
thirteen `main-*` panels and the code reads six others that do not exist —
`main-edl` seven times — all guarded. And `bwav/popup.js` labels its own
phantoms: `// (Mode UI removed)` sits directly beside `#modeSelect`.

So the deliverable changed. This is drift, not a backlog of 311 bugs, and
"fixing" it wholesale would be busywork with a real chance of breaking something
that works. **The value is in making 312 impossible**, and that is what shipped:
a shared extractor (`tests-js/lib/domIds.mjs`), a frozen baseline
(`tests-js/fixtures/phantom-ids.json`), and a contract test that fails on a new
phantom, on any unguarded dereference, and on a baseline entry that has since
been fixed. `test:js` globs `tests-js/*.test.mjs` and `build-verify` runs
`test:js`, so the guard landed inside the build gate with no wiring changes.

**Making the scan trustworthy was most of the work,** and two of the three
problems found had it silently under-reporting:

1. **Most of this renderer's markup is minted from template literals.**
   `grep 'id="eventScroll"' src/index.html` returns nothing, yet `#eventScroll`
   is a live element — `ui.js:6320` builds it inside a backtick string. A scan
   that read `.html` files alone would have reported hundreds of working
   elements as missing and the baseline would have been worthless. That
   `eventScroll` comes back *defined* is the proof the extractor works, and it
   is pinned as a test.

2. **A comment cannot create an element.** `errorBanner.js` opens by explaining
   that no element with `id="errors"` has ever existed — and that sentence,
   quoting the attribute verbatim, convinced the scan the element was there. The
   documentation of a bug registered as its fix. Three more ids were masked the
   same way. Lines that begin a comment are now skipped, and the `errors` case
   is a named regression test.

3. **A branch that passed its unit test and had never once run.** The two-line
   `const el = ...; el.foo = x` dereference anchored hard on `=`, so `before`
   had to end in `= ` — true for the repo's own `$("#x")` helper, false for
   `document.getElementById("x")`, where `before` ends in `document.`. Caught
   only by negative-verification against real source, not by the unit test that
   covered it.

**Verification.** Every gate was negative-verified by injecting the defect it
guards and confirming the failure: a new phantom id, an unguarded dereference, a
two-line dereference, a stale baseline entry, an unsorted baseline, and an
extractor that finds nothing. Six for six, then clean source re-measured at
crash=0. 11 tests. `build-verify` 250 passed / 7 skipped with all three gates
clean; `build:renderer` 370 files.

---

## Iteration 7 — 2026-07-26 16:30 +0700 — the download is 2.1 GB

**How this was found.** Iteration 7 opened as Preflight-localization research.
It became this instead because verifying that iterations 3–6 had actually
reached the packaged app meant looking at the package, and the package was
`app.asar` at **1,651,714,109 bytes**. The renderer that asar exists to carry
is 36 MB. Nobody had looked, because nothing was broken — the app ran fine.

**What was in there.**

| path | size | what it is |
|---|---|---|
| `electron/native/PFXNativeMediaEngine/.build` | 1.4 GB | Swift Package Manager scratch: `checkouts/`, `build.db`, `debug/`, `release/`, `MediaStoreCheck.dSYM`, `manifest.pif` |
| `electron/imf/metal-htj2k/vectors` | 169 MB | 100 HTJ2K conformance vectors (`.coeff`/`.j2c`/`.raw`/`.rt.raw`) |

Both arrived via the `electron/**/*` glob in `package.json` `build.files`. A
leading-dot directory is invisible in a casual `ls` of `electron/native/`, which
is most of why 1.4 GB sat there unremarked.

**Proving they are inert, rather than assuming it.** The tempting move is to
exclude anything that looks like scratch and see if the app still starts. That
tests one launch path, not the R3D decode path or the HTJ2K path, and those are
exactly the ones a media tool fails on three weeks later. So the load sites were
read instead:

- `electron/native/pfx_native_engine.js:15-16` — `BINARY_NAME =
  'pfx_native_media_engine'`, `BINARY_PATH = path.join(__dirname, BINARY_NAME)`.
  The engine is a *sibling* of `.build/`, not a product of it at runtime.
- `electron/imf/imf_metal_htj2k_backend.js:26-30` — every candidate path is
  built from `native/pfx_htj2k_metal/pfx_htj2k_metal`, outside the excluded tree
  in the dev, asar-unpacked, and `resourcesPath` variants alike.
- No `electron/**/*.js` mentions `.build` (`buildFromTemplate` and
  `buildReelList` are the only matches) or the vectors directory.
- The sole reference to `vectors/` anywhere is `validate_m6.sh`, a dev script
  resolving paths from the repo root. Excluding the directory from the
  *package* leaves that script working in the *source tree*. These are
  different questions and it is worth not conflating them.

**Result.** Two negations added to `build.files`. `app.asar` 1,651,714,109 →
**35,992,338** bytes; the `.app` ~2.1 GB → **488 MB**. Post-package verification
confirmed every `asarUnpack` target survived — `pfx_native_media_engine`
(1,186,072 B), `avf_bridge` (571,504 B), `pfx_r3d_decode` (137,056 B),
`r3d_libs` (3 files), `pfx_htj2k_metal` with `libopenjph.0.26.dylib` and both
`.metal` shaders, `native/*.py` — and that neither excluded path appears in the
asar or in `app.asar.unpacked`. `electron/{main,ipc,preload}.js` and
`dist/desktop/index.html` present; `extraResources` (assets, companion, bin,
authConfig.json) untouched. `build-verify` 250 passed / 7 skipped, three gates
clean; `build:renderer` 370 files; `build:mac-dir` exit 0, signing skipped as
expected for an unsigned local package.

**Why this belongs to the current objective and not to housekeeping.** The run's
stated goal is a tool that stays accessible to non-technical users across all
functionality. Everything else this run shipped — plain-language errors, the
title-bar language broadcast, the phantom-element contract — improves the app
once it is installed. This one is about whether it gets installed at all. A
2.1 GB download over a hotel connection, or onto a nearly-full laptop on set, is
a refusal that never reaches the UI. It cost one line of config and no code.

---

## Iteration 8 — Preflight speaks the app's language (2026-07-26 17:12)

**Shipped:** `4c63a5d` — `src/tools/preflight/app/locale.js` (new),
`src/tools/preflight/app/app.js`, `tests-js/preflightLocale.test.mjs`.

This was the top item on the measured backlog from iteration 5, and it is the
largest single piece of translated text in the app that nobody could reach.

### What was on disk versus what shipped

| Locale | `ui_strings` | `checks.i18n` | `requirements.i18n` | Reachable before |
|---|---|---|---|---|
| en | ✓ | ✓ | ✓ | yes |
| ja | ✓ | ✓ | ✓ | no |
| ko | ✓ | ✓ | ✓ | no |
| zh-TW | ✓ | ✓ | ✓ | no |
| th | ✓ | ✓ | ✓ | no |
| id | ✓ | ✓ | ✓ | no |
| fil | ✓ | ✓ | ✓ | no |

Twenty-one files, roughly 148K of translated check text and fix guidance. Six
of the seven language sets were being packaged into every build and rendered by
nobody.

### Why

`settings.locale` defaulted to `"en"`, and the only code that ever wrote it hung
off `qs("localeSelect")`. That id does not exist in `app/index.html`, and
`git log -S localeSelect` finds no commit on any ref that ever added one. The
listener was never attached. This is the third instance of the same species —
the one `tests-js/domContract.test.mjs` was written for in iteration 6 — and it
was already sitting in that test's own header comment as a known case.

An extra detail found while removing it: the dead picker offered six options and
Filipino was not among them. Even a repaired version of that control could not
have reached `fil`.

### The shape of the fix

Not a picker. The app has one language control, in the title bar, and a second
one inside a pane is a second way for them to disagree. `paneLang.js` has
broadcast `pfx:lang` across the iframe boundary since iteration 5; this wires up
the receiving end.

The interesting part is what replaces `location.reload()`. That call never ran,
but it is worth being precise about why it was the wrong shape anyway:

- `state.files` holds the `File` objects the user selected. It is deliberately
  not persisted, because File handles do not survive serialisation. A reload
  therefore discards the user's entire scope.
- What comes back after the reload is `pfx_last_run` — a *stored* run whose card
  titles were baked at scan time (`run.js:630`) in the previous language.

So the reload would have cost the user their files and still shown them stale
text. Re-localising in place wins on both: `ui.js` reads
`state.config.ui.labels` at render time in about twenty places, so swapping the
config and calling `render()` re-translates every piece of live chrome — and
because the files are still in memory, the completed run can actually be redone
in the new language, which `relocalize()` does, following the precedent already
set by `_onEpCountChange`.

### Two decisions inside `normalizeLocale`

The host and the pane offer the same seven languages, so this is close to an
identity map — and "close to identity" is exactly where the interesting failures
live.

- **`zh-CN` maps to English, not to `zh-TW`.** Only Traditional is translated.
  Serving Traditional to a Simplified reader looks like it worked; English does
  not pretend.
- **Nothing may return a locale with no files.** `loadConfig`'s `safeJson`
  swallows a 404 and returns an empty dictionary, so a wrong locale does not
  throw — it renders blank labels. That is the same silent-failure shape as the
  bug being fixed, and a property test asserts every possible return value is a
  locale with files behind it.

### Verification

`npm run build-verify` green (250 Python passed / 7 skipped, all JS suites, XSS
/ XXE / fail-open gates clean); `npm run build:renderer` green, 371 files,
`locale.js` present in `dist/desktop/`. Each of the seven gates in the new test
was negative-verified by injecting its specific defect and confirming that gate
and only that gate fired.

## Iteration 9 — one shared toast (2026-07-26 18:00) (`7d1295c`)

Six panes in this renderer show small transient messages. Three of them routed
through a global that nothing assigns, and a fourth wrote a CSS class that no
stylesheet defines. The messages were not wrong — they were absent, silently, in
the way that leaves a user pressing a button twice because the first press
appeared to do nothing.

### What was actually broken

`core/shotWorkItems.js` is the one that mattered. Both of its lookups —
`window.pfxToast?.show` and `window._showToast` — were phantoms, so
`_toast('VFX marker created: …')` fell through to `console.info`. Creating a VFX
marker produced no visible confirmation at all. `render_queue.js` and
`features/cutdiff/index.js` each had a working local fallback behind their
phantom, so they still spoke; their preferred path was dead code.
`modules/amf_convert.js` had the CSS-class version of the same bug: ten messages
appended unstyled text to the bottom of the page, permanently, because the
`.show` toggle drove no rule.

### The repair, not the rewrite

One implementation — `src/scripts/core/pfxToast.js`, 210 lines, plain non-module
IIFE — installed on **the two names the existing readers already look for**:
`window.pfxToast.show` and `window._pfxToast`. The three misspelled readers were
corrected to match. The four working local implementations
(`auth/login-ui.js`, `features/platelink2/index.js`, and two others) were left
exactly where they are.

That ordering is the design decision. Naming the new global something new would
have meant editing every reader anyway *and* leaving five phantom names in the
tree for the next person to find. Adopting the names already being read means the
diff at each call site is one word.

### What the non-technical user gets

Every choice below is downstream of "highly accessible across all functionalities
for non-technical users", not of tidiness:

- **Errors never auto-dismiss.** A message that vanishes after 3.5 seconds has
  not been reported to anyone who has to read it, decide what it means, and act.
  Errors and warnings carry a dismiss button labelled *"Dismiss this message"*.
- **Dwell scales with reading time** — 3.5s floor plus ~55ms per character,
  capped at 12s. A fixed timeout is either too short for the long message or too
  long for the short one.
- **Error and warning text is humanized** through `pfxFriendlyText` (iteration 4)
  before display, so a raw `ENOENT` never reaches the user.
- **13px at 1.45 line-height with real contrast**, replacing 10px nowrap in a
  corner. At 10px a message is technically present and practically unread.
- **Screen readers hear it**: the stack is `aria-live="polite"`, and each error
  additionally carries `role="alert"` so it interrupts rather than queues.
- **`prefers-reduced-motion` is honoured** — the transition is removed, not
  shortened.
- **Repeats collapse to a `×N` badge.** "Already queued: <clip>" fires once per
  click; four identical stacked toasts hide the one underneath that differs.
- **Four visible at once, oldest first out** — an unbounded stack is a wall.

### The bug the test caught before it shipped

The first draft of the stack trim was
`while (host.children.length > MAX_VISIBLE) dismiss(host.firstElementChild)`.
`dismiss()` is asynchronous by design — it starts the leave transition and
removes the node 220ms later — so the dismissed node is still a child on the next
check, the count never drops, and the loop never exits. **The fifth toast of a
session would have frozen the renderer.**

It was found by running the test, which produced no output until it was killed.
The fix counts only children not already marked `_pfxGone`. The test is written
so that if the defect returns it hangs rather than fails, and its comment says
so — see audit 9.3.

### Retracted

The carried claim that `setStatus` in `modules/amf_convert.js:4988`/`:5175` is
broken is a **false positive**, recorded in iteration 5 and repeated unchecked in
6, 7 and 8. Those lines are generated After Effects ExtendScript inside a
template literal; `STATE.statusText` is a real ScriptUI `statictext` widget
created at `:5109`/`:5311`, and setting `.text` on it is correct. Full write-up
and the generalisable lesson in audit 9.4.

### Verification

15/15 toast tests green. `npm run build-verify` exit 0 — 250 Python passed / 7
skipped, all JS suites, XSS / XXE / fail-open gates clean. `npm run
build:renderer` green, 372 files, all three new artifacts present in
`dist/desktop/`. Both new gates negative-verified against their own specific
injected defect, plus a comment-only control proving the global scanner does not
fire on prose.

Commit `7d1295c`, 8 files, +657 / −4. Five of the six tracked files carried
pre-existing foreign hunks; each was staged as a reconstructed blob so the commit
contains only this iteration's lines, and a post-commit diff confirmed every
foreign hunk survived untouched in the working tree.

---

## Iteration 10 — the inspector that was always empty (2026-07-26 18:50) (`602956a`)

### What was actually broken

Open CutDiff 2x, load two timelines, click any row in the diff. The inspector
slides open. The event number and the change type appear in its header. Every
other field — Reel, Clip, Src In, Src Out, Rec In, Rec Out, Duration, FPS,
Confidence, Reason, and the whole OLD Match block — stays `—`. Forever. Set the
status dropdown, type a note, press Save Note: nothing is stored. Press Seek VC:
nothing seeks.

Nothing throws. Nothing is logged. There is no error state, no spinner, no
"couldn't read this file". The panel simply looks like a row with no data in it,
which for someone who is not an engineer is indistinguishable from a bad EDL.
That is the same worst-case failure shape this project has now hit four times:
the UI is present, it looks enabled, and it does nothing.

### Why

`src/index.html` contained the inspector **twice**. The inspector had been moved
out of the video-compare pane into the right column, and the old copy was left
behind under this comment:

```html
<!-- Inspector moved to .cd2x-left-col — stub kept for legacy DOM refs -->
<div id="cd2x-inspector-stub" style="display:none">
```

Eighteen ids therefore existed twice. `document.getElementById` resolves
**first-in-document-order** — unconditionally, with no preference for a visible
element over a hidden one — and the stub came first. So all eighteen lookups in
`features/cutdiff2/index.js:297-314` bound to the invisible copy. The code then
worked perfectly, writing every value into a `display:none` subtree.

The three ids that were *not* duplicated — `cd2x-insp-close`, `-event`, `-type`
— resolved correctly. That is why the header populated and nothing else did, and
why the bug reads as "empty data" rather than "broken panel".

**A duplicate kept for compatibility does not add a fallback. It shadows the
real element.** The stub was written as a safety net and was itself the fault.

### The repair, not the rewrite

Delete the stub. Forty-eight lines out, six lines of comment in explaining why it
must not come back. No JavaScript changed at all — the code was already correct.

Deletion is lossless, and this was checked rather than assumed: `#cd2x-inspector`
carries 21 ids, a strict superset of the stub's 18; no JS anywhere references
`#cd2x-inspector-stub`; the CSS is class-based and already scoped to
`.cd2x-main-col .cd2x-inspector`; and the stub was not nested inside the real
panel.

### What the non-technical user gets

* The inspector shows the shot's data. That is the entire feature, and it has
  been off.
* Save Note saves. Seek VC seeks. The status dropdown sticks.
* No new setting, no new button, nothing to learn. A pane that looked broken
  stops looking broken.

### The gate

`tests-js/duplicateIds.test.mjs`, four tests, zero-tolerance:

* **the scan actually sees the markup** — ≥8 HTML files, >1000 elements carrying
  an id. A gate that passes by parsing nothing is the failure it exists to stop.
* **the detector reports a duplicate that is really there** — an in-test control
  document whose defect is exactly the shipped one (a hidden earlier copy of an
  id that also appears later), plus a clean document proving it does not invent
  duplicates.
* **no static html file defines an id twice** — the gate. Currently 0 across all
  11 checked-in HTML files.
* **every field the CutDiff 2x inspector reads is inside the visible panel** —
  the regression. It reads the 22 `cd2x-insp*` lookups straight out of
  `cutdiff2/index.js` and asserts each resolves inside `#cd2x-inspector`. It
  fails if a stub is re-added anywhere, and it fails if the panel is moved again
  and the fields are left behind.

Only static markup is scanned. An id minted at runtime from a template literal
may legitimately be produced once per row, so multiplicity there means nothing —
which is precisely what keeps this gate at zero tolerance instead of needing a
311-entry baseline like the phantom gate.

### Verification

Negative-verified against the markup that actually shipped, not a synthetic
defect: `git show HEAD:src/index.html` restored in place, both gates go red and
name all 18 ids by name; restored, both go green. `npm run build-verify` exit 0.
`npm run build:renderer` green, 372 files.

One rough edge found and fixed during that run: the regression test took **41
seconds** to fail, because `assert.equal(node, null)` makes Node render a diff of
a linkedom element — which renders its entire subtree. Comparing a boolean
instead brought it to 17ms. A gate nobody wants to run is a gate that gets
skipped.

### The mistake in this iteration's own process

The first commit attempt swept 19 foreign hunks — the user's uncommitted tab
tooltips and tab-group labels — into the commit, because `git commit --only`
stages from the working tree. Iteration 9 had already solved this and written it
down: stage a reconstructed blob. I did not do it, and only caught it by reading
`--stat` afterwards and finding 62 insertions where I had written 6.

Repaired: `git reset --soft HEAD~1 && git reset`, rebuild `src/index.html` as
HEAD plus only my splice, `git hash-object -w`, `git update-index --cacheinfo`,
commit the index. Confirmed afterwards that the staged diff is one hunk, that the
20 foreign hunks are uncommitted again, and that the working tree file is
byte-identical to what it was before the repair began.

The check that caught it is cheap and should be unconditional: **read
`git show --stat` after every commit and confirm the line counts are the ones you
wrote.**

## Iteration 11 — the controls that had no name (2026-07-26 19:32) (`0325865`)

### What was actually broken

Thirty-four interactive controls across six HTML files had no accessible name.
A screen reader announces such a control as its bare role and nothing more:
"slider", "pop-up button", "check box". Not what it does, not its current
value, not which of the seven sliders on this screen it is.

The list is not obscure corners of the app. It includes the main playback
scrubber (`#pmScrub`), the IMF viewer's scrubber and volume (`#imfSeek`,
`#imfVolSlider`), the annotation brush size (`#pmQaSize`), the video
brightness slider, the CPL / version / frame-rate pickers, the CutDiff
inspector's Status dropdown, the timeline-convert reel-name and filter
selects, and the shot-list select-all checkbox.

### The one worth reading twice

`#pl2SelectAll` looked labelled:

```html
<label class="pl2-sel-all-wrap" title="Select / deselect all shots">
  <input type="checkbox" id="pl2SelectAll">
</label>
```

A wrapping `<label>` does name its control without needing `for=` — but it
does so from its **text**, and this label has none. The description is in a
`title` on the *label*, and a title on an ancestor names nothing. So a sighted
user hovers and gets a helpful tooltip, and a screen-reader user gets
"check box". The markup that made it look handled is exactly what made it
easy to walk past.

`#folderPicker` and `#filePicker` in the preflight tool are positioned
off-screen at `opacity: 0`. That is not `display: none` — they remain
tabbable and remain in the accessibility tree. Visually hiding a control is
not an exemption from naming it; it only means the screen-reader user is the
*only* one who ever meets it.

### The repair, not the rewrite

Every fix is a single `aria-label` attribute. No markup restructured, no
handler touched, no behaviour changed — 34 changed lines across six files.

Where the control already sits next to visible text, the label reuses that
text (Status, Mix, FILTER → "Filter clips", REEL NAME → "Reel name source")
so the spoken name matches what is on screen. The Thai-language VisionScope
popup gets a Thai label; an English one there would be read out in the wrong
language by a Thai voice.

Two labels required reading the code rather than the markup to get right:
`#pmQaSize` is the annotation **brush size** (`_qaSize` feeds `size` on pen,
erase, text and shape records in `prep_mark.js`), not a UI scale; and
`#pfxTypeToggle` toggles Standalone ↔ Series, so it is named for its checked
state, "Series project (off = standalone)".

### What the non-technical user gets

Nothing changes on screen. What changes is that the app is now navigable by
someone who cannot see it, and — the wider case — that every control now
carries a machine-readable statement of its own purpose. Tooltips already
served the mouse user; this serves everyone else.

### The gate

`tests-js/accessibleNames.test.mjs`, four tests, 230 ms.

- **Zero tolerance, no baseline.** All 34 were fixed, so the gate can demand
  zero rather than "no worse than before".
- **Visibility is judged from the element's own inline style only.** Walking
  up to ancestors drops every control in an inactive tab panel — those are
  inline `display:none` until clicked, which is most of this app. The first
  version of the scan did walk ancestors and reported "82 controls" as
  "2 controls". A control one tab click away still needs a name.
- **Six naming routes accepted**, in spec order: `aria-label`,
  `aria-labelledby`, `label[for]`, a wrapping `<label>` **with text**, the
  button's own text, `title`, and `placeholder` last as a weak name.
- **Negative-verified against the real shipped defect**: restoring all six
  files from `HEAD` turns the gate red and enumerates all 34 by id and tag.
  The synthetic control stays in the test so the proof survives HEAD moving.

### Verification

`npm run build-verify` exit 0 (250 Python passed / 7 skipped; XSS, XXE and
fail-open gates clean; `accessibleNames` and `duplicateIds` both picked up
automatically). `npm run build:renderer` — 372 files, v2026.6.1.

Process check from audit 10.5 applied and passed: `src/index.html` was staged
as a blob reconstructed from `HEAD` plus only this iteration's 25 edits, and
`git show --stat` after the commit read 25/25 + 2/2 + 2/2 + 3/3 + 1/1 + 1/1 +
181 — exactly what was written. The ~689 pre-existing dirty files were
untouched, and `src/index.html`'s uncommitted work measured 56/21 both before
and after the commit.

---

## Iteration 12 — the tutorial button that answered the wrong question

The global **How to Use** button in the header is the single most important
control in the app for a non-technical user: it is what you press when you do
not know what you are looking at. On the Trailers Conform tab it opened the
**Settings** tutorial.

### What was wrong

`#btnTutorial` has **two** independent `click` listeners, registered from two
different places in `ui.js`, each carrying its own tab-key → modal-id table.
Both fire on every click. Where the tables agree, the second open is a
harmless repeat of the first. Where they disagree, the second one wins
visually — and nothing anywhere reports that they disagreed.

They disagreed about `trlconf`:

| table | value | what happened |
|---|---|---|
| A (`_tutModalMap`, ~11903) | `tconformTutorialModal` | no such element — `getElementById` → `null`, `if (!modal) return` |
| B (~23990) | `settingsTutorialModal` | opened, and was what the user saw |

`tconformTutorialModal` appeared **exactly once in the entire codebase**: as
that map value. No element, no runtime creation, not even a stale comment.

Meanwhile `#tlcTutorialModal` — a fully authored, seven-language Timeline
Convert tutorial, already in `index.html`, already carrying
`aria-label="Timeline Convert How to Use"` — was reachable from exactly one
place: `#tlcHelpBtn`, which lives *inside* the Timeline Convert modal. You had
to already be in the feature to find the help for the feature.

### The fix, and what was deliberately not done

Both tables now say `tlcTutorialModal`. Handler B **stays**. Its comment
justifies it as a fallback for when `wireEDLTimeline` exits early, and that
justification is stale — `_wirePfxTutorials()` is called on its own at 23980,
not from `wireEDLTimeline` — but it is still a real `try`/`catch` fallback,
and deleting ~30 lines to prove a point is a rewrite, not a repair. A
one-line "keep in sync" comment marks the coupling; consolidating the pair is
its own change.

Opening `#tlcTutorialModal` from the global button shows the static English
body rather than the user's stored tutorial language, because
`_renderTlcTutorial` is closure-private in `tl_convert/index.js` and that
module exports nothing on `window`. English help for the right feature beats
localised help for the wrong one; the language path is backlog, not blocker.

### Two more user-facing names

- `#imfFolderConfirm` and `#pmOtioModal` are `aria-modal="true"` dialogs with
  no accessible name — a screen reader announced "dialog" and stopped. Both
  had visible titles already; they are now wired via `aria-labelledby`
  (`#pmOtioTitle` had to be minted). `#imfFolderConfirm` also got
  `aria-describedby` pointing at its existing status line.
- The permission-denied screen called the tab **"Timeline Conform"**. The tab
  button reads `TRAILERS CONFORM`, its tooltip says "Trailers Conform", the
  feedback form says "Trailers Conform". One string, in the one moment a user
  most needs to recognise the name of the thing they just clicked.

### The gate

`tests-js/modalIds.test.mjs`, four tests, 26 ms.

- **Rule:** every `*Modal` string literal in `src/**/*.js` must match either a
  static id in `src/**/*.html` **or** an `el.id = '...'` creation site in JS.
- **The second route is not a convenience.** Five of the six unresolved
  literals found during research are modals genuinely constructed at runtime.
  Without that clause the gate reports five false positives and gets
  disabled. It is the same principled-vs-convenient test as iteration 11: the
  narrowing has to distinguish *built later* from *does not exist*, which is
  the entire question being asked.
- **Zero tolerance, no baseline** — clean after the fix.
- **Negative-verified against the real shipped defect.** `git show
  HEAD:src/scripts/ui.js` restored in place turns the gate red and names
  `tconformTutorialModal — referenced at src/scripts/ui.js:11907`. A synthetic
  probe stays inside the test so the proof survives HEAD moving on.
- One extra assertion pins the specific regression: every `trlconf:` entry
  whose value is a modal id must be `tlcTutorialModal`, and that modal must
  still exist and still be about Timeline Convert. The first draft of this
  regex matched `trlconf: 'trl_conf'` from an unrelated project-scope map and
  failed on a non-defect — narrowed to `*Modal` values only.

### Verification

`npm run build-verify` exit 0 (250 Python passed / 7 skipped; XSS, XXE and
fail-open gates clean; `modalIds` picked up automatically).
`npm run build:renderer` — 372 files, v2026.6.1.

Audit 10.5's process check applied and passed: both `src/scripts/ui.js` and
`src/index.html` were already dirty with the user's own work, so both were
staged as blobs reconstructed from `HEAD` plus only this iteration's edits.
`git show --stat` after the commit read 13 / 6 / 162 — exactly what was
written. The working-tree diff for those two files shrank by exactly 13 and 6
lines, confirming nothing of the user's was swept in.

## Iteration 13 — the tutorial with no door

`#playerTransportTutorialModal` is 133 lines of finished, interactive help in
`src/index.html:599-731`: eight clickable `data-player-demo` transport buttons
under the heading "Interactive Player — Click To Try", plus prose explaining the
scrub bar, the nav pod, jump-to-start/end, play forward and play backward. It is
the richest tutorial in the app and the one most directly aimed at somebody
opening the player for the first time.

Nothing could open it.

Every mention of it in the codebase, traced:

| Site | What it is | Live? |
|---|---|---|
| `index.html:599` | the markup | — |
| `ui.js:9691` | `_wirePlayerTransportDeepDive()` looking itself up | only if called |
| `ui.js:11931` | `if (modalId === 'playerTransportTutorialModal') …` inside `_openTutorial` | **dead** |
| `ui.js:24004` | the same guard in the duplicate `#btnTutorial` handler | **dead** |
| `ui.js:11964` | close-button wiring in the fallback list | live, but only closes |

Both guards are unreachable. The two How-to-Use tables (`_tutModalMap`,
`_tutMap`) are keyed by tab, and `document.body.dataset.main` is one of twelve
values, none of them the player — the player is a *panel inside* a tab. So no
key can ever yield that id, `_wirePlayerTransportDeepDive` is called from
nowhere, and the content sits there.

### The fix

The door goes on the thing the tutorial is about. A `? Help` button at the end
of `.pm-controls` (`src/index.html`), immediately after `#pmAnnotateBtn`, in the
tutorial's own orange so the button and the panel read as one thing:

```html
<button id="pmTransportHelpBtn" class="pm-help-btn" type="button"
        title="How the player transport works — scrub bar, nav pod, play and jump"
        aria-label="How the player transport works">? Help</button>
```

It routes through `_openTutorial('player')` rather than showing the modal
itself, so it inherits the Esc handler, the backdrop click, the close button and
the "close whatever tutorial is already open" bookkeeping instead of
re-implementing four things. That required one new entry in `_tutModalMap`:

```js
    player:      'playerTransportTutorialModal',
```

`player` is deliberately not a tab name, and the comment above it says so — it
is a route key, not a tab key, and `#btnTutorial` can never dispatch it.

The opener is registered inside `_wirePfxTutorials()` because
`_wirePlayerTransportDeepDive` and `_openTutorial` are both closure-private to
that function; wiring from outside would have meant exporting one of them.

Word, not glyph: the bar already speaks in glyphs (`M`, `✏`, `◀ ● ▶`), so a bare
`?` would have been the consistent choice. "Help" is the discoverable one, and
for the audience this whole loop is aimed at, discoverable wins.

### The gate

`tests-js/reachableTutorials.test.mjs` (185 lines). Every id ending in
`TutorialModal` authored in a checked-in `.html` must appear as a value in one
of the two router tables in `ui.js`. Those tables are the only code in the app
that makes a tutorial visible, so a tutorial in neither is unreachable by
construction.

This is the reverse of iteration 12's question. `modalIds.test.mjs` asks *does
every id a router names exist?* This asks *does every element we authored have a
router that names it?* Same two sets, opposite direction, and the second
direction found what the first could not.

### Verification

- Negative-verified against the real shipped defect: `src/index.html` and
  `src/scripts/ui.js` restored from HEAD in place. Gate went red naming
  `playerTransportTutorialModal — authored in src/index.html, named by no router
  table`, and the specific regression test went red too. Both scan-sanity tests
  stayed **green**, which is what makes the failure a finding rather than a
  broken scan. Files restored; `diff` against the fixed copies reported
  identical.
- `npm run build-verify` exit 0 — 250 Python passed / 7 skipped, XSS / XXE /
  fail-open gates clean.
- `npm run build:renderer` — 372 files, v2026.6.1.
- `git show --stat c7b3c62` read `src/index.html | 5`, `src/scripts/ui.js | 17`,
  `src/styles/main.css | 4`, `tests-js/reachableTutorials.test.mjs | 185` — the
  counts written.
- Working-tree diff for the three source files shrank 82→77, 60→43, 631→627,
  with deletions unchanged at 356. Exactly the 5, 17 and 4 lines added; none of
  the user's in-flight work was swept in.

## Interruption — the login screen that locked everybody out

Not an iteration. The user sent a screenshot of the PostFlowX login card with a
red banner reading:

    PostFlowX access policy service is not configured for this build.

Sign-in was impossible. The cause was `npm run build:renderer` — the command
this loop runs every single iteration, and one of the two commands the loop is
required to end green on.

`build-renderer.js` resolved two credentials like this:

```js
const apiUrl = (process.env.POSTFLOWX_AUTH_API_URL || '').trim();
```

and then wrote the result straight over `authConfig.json`, which
electron-builder ships as `Resources/authConfig.json` — the only auth config the
packaged main process reads. So an absent env var did not mean *leave the
existing value alone*; it meant *delete the working URL that is already there*.
Nothing failed. The build printed success and the app launched, into a login
screen nobody could get past.

A second, independent defect made the first one fatal.
`_getPostflowxAuthApiUrl()` read exactly two sources — env, then
`Resources/authConfig.json` — while `_getGoogleClientId()` beside it has always
had four. One empty string was therefore enough to take access checking offline
with nothing behind it.

### The fix

- `tools/authConfigInherit.js` (new) — `resolveInherited()` takes the first
  source that actually holds a value: env, then the previous build's output,
  then the developer's local config. Only a value nobody has ever supplied
  resolves to empty.
- `build-renderer.js` — routes both credentials through it, and prints
  `✓ access policy service: configured` so a build that silently disarmed auth
  can no longer look identical to one that did not.
- `electron/ipc.js` — `_getPostflowxAuthApiUrl()` gains the same fallback chain
  `_getGoogleClientId()` already had.

`meechumClientSecret` was deliberately left out of the inheritance chain. The
comment in `build-renderer.js` is explicit that it is for local testing only and
must never be written into a file that ships inside the bundle; inheriting it
would have done exactly that.

### The gate

`tests-js/authConfigInherit.test.mjs` (182 lines). The rule it enforces is
narrow on purpose: **a build must not erase a credential that already exists.**
Absence is not the failure — erasure is. Phrased that way, a fresh clone with no
env and no prior build does not trip it, while the exact regression that locked
the user out does.

Two of the ten tests originally read code that is still uncommitted in the
user's tree and had to be rescoped before commit; a gate that depends on
untracked text is green for a reason that will not survive a clone.

### Verification

- Negative-verified on both defects: with the shipped `build-renderer.js` and
  `electron/ipc.js` restored, the gate went red on each independently, while the
  five access-policy tests stayed green throughout.
- `npm run build-verify` exit 0.
- `git show --stat 9a08615` read `build-renderer.js | 61`,
  `electron/ipc.js | 14`, `tests-js/authConfigInherit.test.mjs | 182`,
  `tools/authConfigInherit.js | 52` — 297 insertions, 12 deletions, every hunk
  this fix's own.
- Repackaged with `npm run build:mac-dir`.

Still open and flagged to the user: `GOOGLE_DESKTOP_CLIENT_ID` is empty in this
build, so Google sign-in stays disabled. That predates the loop and no value was
invented for it. The one step that cannot be verified from here is the user
relaunching the app and confirming sign-in works.

## Iteration 14 — the help button that did nothing

Twelve tabs carry `data-main`. `_tutModalMap` named a bespoke tutorial modal for
eight. The other four — HOME, BWAV INSPECTOR, PREFLIGHT, RENDER QUEUE — reached
this:

```js
const modalId = _tutModalMap[tabKey];
if (!modalId) return;          // <- one third of the app
```

Press How to Use on any of those four and nothing happens. No modal, no message,
no console warning, no throw, no visual acknowledgement that the click landed.

That is worse than having no help button. "No guide for this screen yet" is
information a user can act on. A button that visibly does nothing reads as *this
application is broken* — and it reads that way to precisely the non-technical
user who pressed it because they were already stuck.

Both existing gates were green the whole time:

| Gate | Question it asks | Saw this? |
|---|---|---|
| `modalIds.test.mjs` | does every id a router names exist? | no |
| `reachableTutorials.test.mjs` | does every authored tutorial have a router? | no |

Neither asks about tabs, and the tab is what the user is standing on.

### The fix

**HOME** does not get a modal. It routes to `window.pfxOpenSetupGuide` — the
Setup Guide is a real interactive walkthrough that inspects this machine and
offers to fix what it finds, and any modal written here would be a worse copy of
something better that already exists.

**BWAV, PREFLIGHT and RENDER QUEUE** get `#genericTutorialModal` (21 lines of
markup in `src/index.html`), filled at runtime from `_tutFallbackContent` — a
plain JS table of `{title, steps:[{t,p}], tip}`.

Content as data, not as markup, on purpose: the two routing tables in `ui.js`
have already drifted apart once, and each new hand-authored modal is another
copy of the same structure waiting to drift. `_fillFallbackTutorial` builds the
DOM with `createElement` and `textContent` — never `innerHTML` — so the new
content cannot become an argument with the XSS scanner pointed at that file.

`_openTutorial`'s head now reads:

```js
let modalId = _tutModalMap[tabKey];
if (!modalId) {
  if (tabKey === 'home' && typeof window.pfxOpenSetupGuide === 'function') {
    try { window.pfxOpenSetupGuide(); return; } catch (_) {}
  }
  modalId = _fillFallbackTutorial(tabKey) ? 'genericTutorialModal' : '';
}
if (!modalId) return;
```

### What the non-technical user gets

Three screens that answered a help request with silence now answer it with a
walkthrough, and the fourth opens the guide that was built for exactly that
moment. Nothing in the app now responds to How to Use by doing nothing.

### The gate

`tests-js/tutorialCoverage.test.mjs` (227 lines, 9 tests) asks the third
question in the set: **does every *tab* get an answer?** A tab passes only if it
has a `_tutModalMap` entry naming a modal that exists, or is `home` with a live
Setup Guide route, or has an entry in `_tutFallbackContent`.

`_fillFallbackTutorial` does have a generic "no walkthrough yet" branch for an
unknown key, and the gate deliberately does **not** accept it. A newly added tab
should make this gate fail, so that whoever adds the tab decides what its help
says. The net is there for the case nobody planned; it is not a plan.

`tests-js/reachableTutorials.test.mjs` was widened in the same commit. It went
red on `#genericTutorialModal` — correctly by its own reading, and wrongly in
fact, because a user can open that modal from three tabs. The rule was always
*reachable*, never *in a table*; the scan had quietly conflated the two. It now
also reads `_openTutorial`'s direct `modalId = '…TutorialModal'` assignment. The
tempting alternative was a fake table entry keyed to a tab that does not exist,
which would have turned a true gate into a decorative one.

### Verification

- Both tutorial gates green in the worktree: **13/13**.
- Negative-verified: with HEAD's `ui.js` and `index.html` restored in place,
  `tutorialCoverage.test.mjs` went 6 red / 3 green, naming exactly `bwav`,
  `preflight` and `renderq`; the separate Setup-Guide test covered `home`. The
  worktree was restored byte-identical (sha256 match, no mode change).
- The widened `reachableTutorials.test.mjs` was run against HEAD and stayed
  green — proof the widening did not loosen it into uselessness.
- Verified on a real `git archive HEAD` tree rather than by swapping blobs into
  the dirty worktree. An earlier in-place swap produced two `domContract`
  failures that were a mixed-state artifact, not a regression: HEAD's
  `index.html` meeting the user's uncommitted `prep_mark.js`. The decisive test
  is whether the failure set is identical with and without the patch — it was.
- `npm run build-verify` exit 0 — 250 Python passed / 7 skipped, XSS / XXE /
  fail-open gates clean.
- `npm run build:renderer` — `✓ access policy service: configured`, 372 files,
  v2026.6.1.
- `git show --stat ff1ec07` read `src/index.html | 21`,
  `src/scripts/ui.js | 131`, `tests-js/reachableTutorials.test.mjs | 53`,
  `tests-js/tutorialCoverage.test.mjs | 227` — 417 insertions, 15 deletions.
- Working-tree diff for the two source files shrank 98→77 and 174→43 — exactly
  the 21 and 131 lines added. Arithmetic exact, zero foreign hunks, none of the
  user's ~690 dirty entries disturbed.
- Packaged with `npm run build:mac-dir` (unsigned, identity explicitly null).
  The shipped `app.asar` was extracted and confirmed to contain
  `genericTutorialModal`, `_fillFallbackTutorial`, and the new
  `let modalId … if (!modalId) {` shape.

## Iteration 15 — the button that blamed your machine for its own typo

### The defect

`render_queue.js` lives in `src/scripts/`. The native helper lives one level
down, at `./modules/native_helper_client.js`. The file asked for
`./scripts/modules/native_helper_client.js` — one doubled path segment,
resolving to `src/scripts/scripts/modules/`, a directory that has never
existed in this repository.

The import sat inside `catch {}`:

    try { helper = await import('./scripts/modules/native_helper_client.js'); } catch {}

So the throw was discarded. `helper` was always `null`. `startFn` below it was
always `undefined`. And every press of **Start Resolve Engine** or **Fix &
Retry** fell into the same branch and produced the same toast:

    Native helper not available — start Resolve manually, then retry

That message is a diagnosis, and it was the wrong one. It told the user their
DaVinci Resolve integration was missing. No amount of installing Resolve
correctly, configuring it correctly, or restarting anything could change the
outcome, because nothing about the user's machine was ever consulted. The app
was reporting its own typo as the user's problem, and the empty catch is what
made that possible — the one line of evidence that would have identified the
real cause was thrown away at the moment it was produced.

This is the third iteration in a row to land on the same family: a control that
appears functional, does nothing, and says nothing about why.

### The fix

The path is corrected, and the catch now speaks:

    try { helper = await import('./modules/native_helper_client.js'); }
    catch (e) { _dbgRe('native_helper_client import failed', { message: e?.message }); }

`_dbgRe` is the file's existing debug channel (`render_queue.js:239`), gated on
`window.PFX_DEBUG_RESOLVE_ENGINE`, so this is quiet in normal use and
diagnosable when it is not. A silent catch is what let a wrong path masquerade
as a missing feature for this long; the next time this import fails it will
fail with a reason attached.

### What the non-technical user gets

A working button. "Start Resolve Engine" now reaches the code that starts
Resolve, and "Fix & Retry" can actually fix and retry. For anyone who took the
old toast at face value and went looking for a broken Resolve install, the
search is over — there was never anything to find.

### The gate

`tests-js/selfContained.test.mjs` — 11 tests, on the `domContract.test.mjs`
shrink-only-baseline model — plus the scan library `tests-js/lib/moduleGraph.mjs`,
mirroring the `lib/domIds.mjs` convention.

It resolves every relative import in the committed `src/` tree and sorts each
edge into `tracked` (a clone gets it), `untracked` (this disk only) or `absent`
(nowhere at all). Absent is a hard failure with a two-entry baseline. Untracked
and the 30 untracked test files are baselined debt with hard literal bounds,
because those files are somebody's uncommitted work and are not mine to commit;
what the gate can insist on is that the numbers stop going up.

The last test is specific and deliberate: *the render queue can still reach the
native helper*. The general rule would catch a regression of this bug, but a
named test says why the rule exists.

### The runner

`test:js` was `node "$f" || exit 1`, so one dead process ended the entire run.
Now it collects failures and exits non-zero at the end. Identical exit code, but
one crash costs one gate instead of seventy-one. **This is a better failure
mode, not a fix** — the modules are still missing and the gates still have
nothing to check on a clone; only the arithmetic changed.

### Verification

- New gate green: **11/11**.
- Five negative-verifications, each re-broken, each caught by the intended test,
  each restored to green: drop a baseline entry → `no committed file imports a
  module nobody committed`; leave a stale absent entry → `the baselines do not
  outlive what they describe`; add an untracked test file → `no new test file is
  left out of git`; re-break `render_queue.js` → `no import resolves to nothing
  at all` **and** the named render-queue test; push a baseline past its bound →
  `the baselines only ever shrink`.
- Runner fix proven with a deliberately crashing `aaCrash.test.mjs`: exit 1, 104
  files attempted, files after the crash still ran. Clean: exit 0, 103 files.
- `npm run build-verify` exit 0 — 250 Python passed / 7 skipped, XSS / XXE /
  fail-open gates clean.
- `npm run build:renderer` — 372 files, v2026.6.1,
  `✓ access policy service: configured`.
- Committed as `645d0e5`, seven files, 516 insertions / 2 deletions.
  `git show --numstat` filtered to anything outside those seven paths returned
  nothing. The user's own uncommitted `priority` clamp in the same file, and the
  worktree's `100644 → 100755` mode change, were both left in the working tree
  untouched — the blob was reconstructed from `HEAD` and patched with one hunk
  rather than staged from disk.
- Packaged with `npm run build:mac-dir` (unsigned, identity explicitly null).
  The shipped `app.asar` was extracted and proves the fix end to end: the
  packaged `render_queue.js:819` imports `./modules/native_helper_client.js`;
  that file is present at `/dist/desktop/scripts/modules/native_helper_client.js`;
  it exports both `nativeResolveStartEngine` and `nativeResolveStartBackground`,
  which is exactly what `startFn` reads; and `scripts/scripts/` appears nowhere
  in the archive.

## Iteration 16 — the app that spoke English to two of its six languages

PostFlowX ships a language switcher offering Korean, Japanese, Traditional
Chinese, Thai, Indonesian and Filipino. Pick Korean and roughly one label in
five stayed in English. Pick Japanese and it was closer to one in four.

Not a crash, not an error — just a Korean user reading `Export XLSX`,
`Frame Rate`, `Shot Marker` and 128 other strings in a language they may not
have. The switcher worked perfectly. There was simply nothing behind it for
those keys, and `t()` returns its argument when a lookup misses:

```js
const map = DICT[lang] || {};
return map[str] || str;
```

That fall-through is the right behaviour — an untranslated label beats a blank
one. It is also completely silent, which is why this survived every previous
iteration's gates.

### What was actually wrong

The merged dictionary holds **660 distinct keys** across four literal blocks
(`DICT`, `EXTRA_DICT`, `LOCALE_FULL_DICT`, `ERROR_DICT`), each folded in by its
own `Object.assign` loop. Coverage before this iteration:

| locale | entries | coverage |
|--------|---------|----------|
| zh-TW  | 651     | 98.6%    |
| th     | 638     | 96.7%    |
| id     | 622     | 94.2%    |
| fil    | 609     | 92.3%    |
| ko     | 510     | 77.3%    |
| ja     | 509     | 77.1%    |

The shape of the gap named its own cause. Korean and Japanese were each missing
**150 keys, 142 of them the same ones**, and all 142 were present in all four
other locales. The 303-key `LOCALE_FULL_DICT` block had been authored for
zh-TW / th / id / fil; ko and ja only ever received 157 of it. This was one
unfinished block, not 300 individual oversights.

### The rule that decided what to fill

An entry whose value equals its key changes nothing a user sees. Filipino
post-production says "Lens Flare"; Indonesian says "VFX Marker". A gate
demanding Tagalog for those would itself be wrong.

So: **only add an entry whose value differs from its key.** Where a locale
genuinely keeps a term in English, the honest state is no entry at all.

335 entries were added under that rule. Two of my own drafts violated it —
`"VFX Plate:"` for ko and ja, where I had written the English straight back —
and were removed rather than dressed up with a fullwidth colon to fake a
difference. Those two keys stay absent, deliberately, and are recorded as such.

A second inconsistency was mine rather than the locale's: I filled
`SETTINGS & FEEDBACK`, `Google Sheet Link`, `Stabilize` and `Integration` for
Indonesian and not for Filipino, despite my own existing `fil` entries
(`I-undo`, `I-export`, `Listahan ng VFX Shots`) already settling the pattern.
Filled, not baselined. `Config`, `Continuity` and `Vendor` stay English in
`fil` on purpose — those are what the industry says there.

### After

| locale | absent | identity | English shown | was |
|--------|--------|----------|---------------|-----|
| ko     | 1      | 3        | 4             | 131 |
| ja     | 1      | 13       | 14            | 142 |
| zh-TW  | 0      | 10       | 10            | 17  |
| th     | 5      | 37       | 42            | 58  |
| id     | 11     | 61       | 72            | 95  |
| fil    | 13     | 126      | 139           | 173 |

Absent pairs **366 → 31**. Total strings falling through to English
**616 → 281**. Key count unchanged at 660: nothing was invented, and no string
already authored was overwritten — the backfill is a gap-fill, guarded by
`if (!(k in target))` rather than `Object.assign`.

### The gate

`tests-js/i18nParity.test.mjs` — 11 tests on the shrink-only-baseline model,
plus `tests-js/lib/i18nDict.mjs`.

The library matters more than the tests. Re-deriving the merged dictionary by
parsing four merge loops would mean re-implementing them, and a gate that
re-implements the thing it measures drifts away from it. Instead it slices
`i18n.js` at the `// Build key set` boundary — everything above is dictionary
construction, everything below needs a browser — drops the one relative import,
appends an export, and imports the result from a base64 `data:` URL. No temp
file, no import cache to bust. The numbers come from the same objects `t()`
reads.

The bar for calling something a defect is **provably translatable**: a key
counts against locale L only if some *other* locale renders it as something
other than the English key. A human has already shown it can be said in another
language. That single filter is what keeps the gate from demanding Tagalog for
"Lens Flare".

### Verification

- New gate green: **11/11**.
- Mutation-tested rather than assumed. Deleting one real entry
  (`"Export XLSX": "XLSX 내보내기"`, occurrence-guarded to 1) made exactly two
  tests fail — `no locale newly falls through to English` and `Japanese and
  Korean got the block they were missing` — while the shrink and staleness gates
  correctly stayed green. Restored, `diff -q` byte-identical.
- The two fixtures were verified against measured ground truth before they
  entered the repo, four ways: NOT-ABSENT / IDENTITY / EMPTY / OVERRIDE. That
  check is what caught both of my own rule violations.
- `npm run build-verify` exit 0 — 104 gate files, 0 failures.
- `npm run build:renderer` — 372 files, v2026.6.1.
- Committed as `7915b2c`, five files, 1062 insertions / 0 deletions.
  `git show --numstat` filtered to anything outside those five paths returned
  nothing.
- Packaged with `npm run build:mac-dir` (unsigned, identity explicitly null).
  The shipped `app.asar` was extracted and proves the fix end to end: the
  packaged `i18n.js` is all 4423 lines, carries `PARITY_DICT`, carries the
  `if (!(k in target))` gap-fill guard, and contains both `XLSX 내보내기` and
  `Integrasyon`.

### What this does not fix

The 250 identity entries are not claimed as correct — they are *recorded*. Some
are right (a locale keeping a proper noun), some are almost certainly a
translator writing the English back. Telling those apart needs a native speaker,
not a script, and I stopped at the line where I would have been guessing.

## Iteration 17 — the strings the parity scan could not see

Iteration 16 fixed the inward half of i18n: of the keys the dictionary holds,
which locales are missing one. This iteration asked the outward question, which
is the one a user actually experiences: of the strings on screen, how many has
the dictionary never heard of at all?

The answer, measured against `src/index.html`: **1849 of 2076 prose strings.**

That failure is worse than a locale gap and much harder to notice. `applyI18n`
derives its lookup key from the rendered English wording, so a label with no key
falls through in ALL SIX locales at once. Nothing looks asymmetric — every
language is equally broken — so `i18nParity.test.mjs` reports a clean bill of
health while a Korean user reads English. A per-locale scan is structurally
incapable of seeing this.

### What shipped

**`FOLD_INDEX` (`src/scripts/modules/i18n.js`).** `_candKeys` folds the string
coming out of the DOM but never the dictionary keys, so markup written `"NAME"`
missed the existing key `"Name"` and 20 strings lost a translation that was
already sitting in the dictionary. The fold index is consulted only after an
exact match fails, and it holds only folds owned by exactly one key: `"PULL
PREP"` and `"Pull Prep"` are both real keys and may carry different
translations, so nothing can pick between them from the folded form. 15 such
collision groups exist (31 keys), and none of the 20 fixable strings falls in
one — checked before the fix, not assumed. 743 keys in, 712 folds out.

**`UI_DICT_ROWS`.** 83 keys the dictionary had never held, all of them strings
already on screen in English: all 69 aria-labels and 14 of the 16 placeholders,
× 6 locales = 486 translations. Gap-fill only, same contract as `PARITY_DICT`:
it never replaces a string somebody already authored. Three cells are
deliberately empty — `id` and `fil` keep "Mix", `id` keeps "Volume" — because an
honest hole beats a key→key pair that satisfies a presence check while changing
nothing a user reads.

**`tests-js/uiCoverage.test.mjs` + `tests-js/lib/uiStrings.mjs`.** 12 tests. The
library executes the app's real `toEnglishKey` and `KEY_SET` via a base64
`data:` module rather than re-implementing them, for the same reason
`i18nDict.mjs` does: a gate that re-implements the thing it measures drifts away
from it.

### What is gated, and what deliberately is not

aria-label and placeholder are hard-gated at **zero**. They are small, stable,
and they are exactly the strings a sighted mouse user never notices and a
screen-reader or keyboard user cannot avoid — least visible to whoever is
testing, most costly to whoever is affected.

Body text, title and `<option>` are **not** shrink-only. `src/index.html` is
edited daily; a tight bound over 1800 strings would turn every ordinary copy
edit into a red build, and a gate that cries wolf gets deleted rather than
obeyed. What guards them instead is a landslide bound (1900 against a measured
1744) that will not notice one new sentence and will notice the i18n path
breaking wholesale. That is a real weakening, and it is written into the test
header rather than hidden behind a number.

### Coverage after

| kind | before | after |
|---|---|---|
| aria-label | 69 missing | **0** |
| placeholder | 16 missing | **2** (both excluded, with reasons) |
| body text | 1490 | 1463 |
| title | 294 | 286 |
| `<option>` | 56 | 56 |
| **total** | **1849** | **1744** |

Dictionary keys 660 → 743. Parity absent 31 → 34, identity unchanged at 250.

### Two things this iteration got wrong first

**A test of mine was vacuous and a mutation caught it.** The collision guard was
asserted through `toEnglishKey('PULL PREP') === 'PULL PREP'`, which looks like
the stronger test and is actually the empty one: `_candKeys` already tries the
all-caps spelling, so for any collision group the exact-match loop wins and
`FOLD_INDEX` is never consulted no matter what it holds. Mutating the guard away
left all 12 tests green. The test now asserts against the index directly and
carries an anti-vacuity guard that fails if no two keys differ only by case —
because on that day the test proves nothing and should be deleted along with the
guard, not left standing as decoration. A gate that has never failed has not
been shown to work.

**linkedom drops a bare fragment silently.** `parseHTML("<body>…</body>")`
returns a document whose `body` is empty, with no error. The first detector
probe therefore reported zero problems and looked like a bug in the scanner.
`scanUI` now throws on an empty body: a detector that never fires is worse than
no detector, because it reports "fine".

Five mutations, each anchor-guarded, restored, and verified byte-identical with
`diff -q`. Four failed on the first pass; M4 is the one above.

### Still open

The **1744 remaining** body/title/option strings are now measured and bounded
rather than fixed — the largest open i18n item, and the honest description of it
is "we know the size of the debt now", not "we paid it". `src/index.html` still
carries **zero** `data-i18n` attributes, which is why all of this has to be
inferred from wording in the first place. The 41 wording-drift near-misses
(`"Pull Prep How to Use"` vs `"Pull Prep — How to Use"`) are moot for the 85
gated strings and still live for the rest.

**The 486 new translations are machine-authored.** They are present, which is
strictly better than English-in-every-locale, and presence is not quality. A
native speaker should read them. That is a review question, not a build one, and
no gate here should be read as claiming otherwise.

---

## Iteration 18 — the status line was still speaking in error codes

`errorBanner.js` (iteration 5) closed the banner path: `showError()` humanizes at
the display boundary, so nothing reaches the banner unrewritten. That fix was
narrower than it looked. It covered one surface. The panel status lines — the
row of text under the VFX Pull card, the one under the IMF validator — were
never covered, and fifteen call sites across three files build their text as:

```js
_setStatus(`Rescan failed: ${e?.message || e}`);
setStatus('error', 'Load failed: ' + err.message);
```

So an editor who points PostFlowX at a folder on a disconnected volume reads
`Rescan failed: ENOENT: no such file or directory, open /Volumes/OCF/A001.ari`.
Everything after the colon is addressed to a programmer.

### Why this is not a copy of errorBanner's fix

The obvious move is to reuse `humanize()` verbatim. It is wrong here, and the
reason is worth writing down because it will come up again on the next surface.

`friendlyText()` rewrites the WHOLE string. Feed it the status text above and it
returns "PostFlowX couldn't find that file. Check the drive is mounted…" — good
English, and `Rescan failed` is gone. A banner can afford to lose the prefix; it
has a title, an icon, a position on screen that says "this is an error". A
status line has none of that. It is one unlabelled row, and the prefix is the
only thing on it naming which operation broke. Humanizing naively would have
traded jargon for lost context and called it an improvement.

`friendlyStatus()` splits the difference: hold the label back, rewrite only the
tail, glue them together. The user learns both what broke and why.

### The load-bearing `\s`

```js
const m = s.match(/^([^:]{1,40}\s[^:]{0,40}):\s+([\s\S]+)$/);
```

The `\s` in the label group forces the label to be a PHRASE — "Rescan failed",
"Review proxy error (sh010)". Without it, `ENOENT: no such file…` parses as
label `ENOENT` + tail, the tail gets rewritten, and the exact jargon this exists
to remove ends up promoted to a heading. Single-token codes have to fall through
to the whole-string path. This is one character and it is the difference between
the fix working and the fix making the display worse.

### Wired at two boundaries, not fifteen call sites

| boundary | sites |
|---|---|
| `vfxPullPanel.js::_setStatus` | 9 |
| `imf_ui.js::setStatus` | 4 |
| `prep_mark.js` — NOT wired | 2 |

Same reasoning as `errorBanner`: fixing call sites one at a time leaves the next
one to be written unprotected.

`prep_mark.js` is deferred on purpose. It has six separate ad-hoc `setStatus`
closures and 824 lines of the user's in-flight uncommitted work; routing it
means touching all six or picking one arbitrarily. It is recorded in the gate's
`UNROUTED` list with that reason and bounded at 1, so it is debt with a name on
it rather than a silent omission.

### Validated before it was written

The prototype ran over a 29-string corpus harvested from the two target files
before any source was edited: **11 rewritten with the operation label intact, 18
success/progress lines byte-identical, empty string byte-identical.** `Ready`,
`Relinked: plate_sh010_v002.ari`, `Visual match: scanning 4/57…` and
`Blocked: QC error` all round-trip unchanged — the last three matter because
they DO have a colon, and a careless implementation mangles them.

### Still open on this front

Measured across `src/` this iteration, raw exception text reaching a user:

| surface | sites | covered? |
|---|---|---|
| `showError()` | 16 (all `ui.js`) | yes — `errorBanner.js` |
| `setStatus()` | 15 | 13 now, 2 recorded as debt |
| `alert()` | 12 across 5 files | **no** |
| `__toast()` | 1 (`modules/amf_convert.js:2068`) | **no** |

`alert()` is the next one and it is harder: a modal has no boundary function to
wrap, so it is twelve edits or a shared `pfxAlert()` helper. Five of the twelve
are in `src/tools/preflight/app/app.js`, which is a separate mini-app.

---

## Iteration 19 — Cancel means cancel

Scope changed deliberately at the start of this iteration. The pre-committed
plan was the 12 raw-exception `alert()` sites; while reading the save helpers to
confirm an unrelated hypothesis, the cancel defect surfaced. A Cancel button
that saves the file anyway is worth more to a non-technical user than better
wording on an error modal, so it took the slot and `alert()` moved to 20.

### What a user would have seen

Export review notes, or a visual-QC report. The Save dialog opens. Press Cancel.
A second Save dialog opens. Press Cancel again. The file is now in your
Downloads folder.

Three save routes each answered with a boolean, so "the user pressed Cancel" and
"this route is unavailable here" were the same `false`. Cancel read as a route
failure, and the last route in the cascade — an anchor click — has no dialog and
cannot be cancelled.

### Four changes, all required

`electron/ipc.js` now reports `{ ok: false, canceled: true }` when the native
dialog is dismissed. `electron/preload.js` translates that into real Chrome's
own `runtime.lastError = "USER_CANCELED"`, readable only inside the callback.
`src/scripts/electron_shim.js` re-installs the `lastError` accessor. A new
`src/scripts/core/saveOutcome.js` replaces the boolean with `SAVED` /
`CANCELLED` / `UNAVAILABLE` and a `runSaveCascade` runner that treats a cancel
as terminal.

### The one that nearly got missed

The shim built the renderer's `chrome` object with spreads. A spread reads a
getter once and copies the value, and preload defines `lastError` as a live
getter — so the renderer held a frozen `null` and **every
`if (chrome.runtime.lastError)` in the app was dead code in the desktop build.**

Three of the four links could have shipped fully green and changed nothing on
screen. Worth remembering as a shape: when a fix crosses a process boundary,
check what the boundary does to the value, not just what each side does with it.

### De-duplication, as a side effect rather than the goal

`reviews` and `visualQcModal` each had their own `downloadOrSaveText`, and both
had the same bug. Their tiers genuinely differ — data URL vs blob URL, a
`finally`-closed writable — so the tiers stayed put. Only the sequencing rule
moved into `runSaveCascade`, which is the part both copies had got wrong.

### Gate

`tests-js/saveOutcome.test.mjs`, 17 tests. The strongest executes the real shim
IIFE through `new Function('window', src)` rather than parsing it, so it cannot
drift from the thing it measures.

Mutation-tested at seven points. Six failed exactly the intended assertion. The
seventh survived: reverting a tier helper to `return !!downloadId;` passed a
gate that only banned the literals `true` and `false`. Repaired to enumerate
every return path and require an outcome on each. That is the second time this
run that a gate has looked green while checking the wrong thing, and both times
only the mutation run found it.

### Still open on this front

`pfxPlatform.saveFile` has the same cancel/failure collapse. Zero callers
repo-wide, so it is left alone and named rather than quietly skipped.

`friendlyError.js` has no rule for `AbortError` or for "not allowed by the user
agent or the platform in the current context" — both still surface raw if they
ever reach a user. Folded into iteration 20 with the 12 `alert()` sites.

## Iteration 20 — a dialog that says what you were doing

### What a user would have seen

Click **Export Notes (PDF)** in VFX Reviews, wait, and get a box containing
exactly:

```
Cannot read properties of undefined (reading 'getContext')
```

No title, no mention of PDF or notes, no indication of whether the markers are
still there. Four of the seven sites fixed here were that shape — a bare
`alert(err?.message || String(err))`. The other three at least named a feature
(`Proxy error:`, `Diagnostics error:`, `EXR export failed:`), but still put the
raw exception on screen underneath.

After: the label leads, the translated plain-language message follows, and the
advice sits in its own paragraph.

```
Test proxy generation failed

There isn't enough space on the disk.

Free up space on the destination drive and try again.
```

### Seven sites, four files

`reviews/index.js` (4), `vfxPullPanel.js` (1), `smart_engine_settings.js` (1),
`imf/imf_package_ui.js` (1). Each label names the *operation the user asked
for*, not the feature and not the error class — "Reviews CSV export failed",
not "Error".

### The new module, and why it doesn't reuse friendlyText

`src/scripts/core/friendlyAlert.js` composes from `friendlyError()`'s
structured parts rather than calling `friendlyText`. `friendlyText` joins
message and hint with a space, which is right for `errorBanner`, where
`textContent` with default `white-space` would collapse a newline anyway. An
`alert()` honours `\n` and has room for three paragraphs. Two surfaces, two
constraints — now expressed in code instead of by accident.

`friendlyError.js` gained one export, `_t as translate`, so the label can be
localised at the alert site without `friendlyAlert` importing i18n directly.

### The bug the test found on its way past

Writing the "path and advice don't share a line" test surfaced a real shipped
defect in `_path`: its `[^\s:'"]+` stopped at the first space, so

```
ENOENT: no such file or directory, open '/Volumes/SHOW DRIVE 01/a.ari'
```

became `/Volumes/SHOW` — a folder that doesn't exist, pointing the user
somewhere wrong. Post-house volumes have spaces in their names almost by
convention. Fixed with a quoted-path first pass; two regressions added to
`friendlyError.test.mjs` (23 → 25 tests).

### Preflight's five, deliberately left

`src/tools/preflight/app/app.js` has five more of these (lines 303, 346, 366,
762, 1092) and they are **not** converted. The tools panes are iframes that have
never imported from `src/scripts/`, and preflight already speaks seven languages
through its own `ui_strings.*.json` — which contains zero error sentences.
Importing an English helper across that boundary would be a regression wearing a
fix's clothes. The real work is ~42 translations and needs a translator.

### Gate

`tests-js/friendlyAlert.test.mjs`, 9 tests. Six exercise the module; three are
call-site gates that fail if a converted file loses its import, changes its call
count, gains a raw alert beside a fixed one, or carries a label that reads like
an error class rather than an operation. Mutation-tested at six points, all
caught, all eight files restored byte-identical.

### Process note

`git commit --only <paths>` re-reads the *working tree* for those paths and
throws away a carefully reconstructed index. It swept the user's 269/129 and 6/6
in-flight hunks into `b2360b7` despite a perfect index. Reset soft, re-staged,
committed with no pathspec → `1ffde29`. All earlier reconstructed-blob commits
in this run were audited and are clean. Full detail in audit 20.6.

### Still open on this front

Preflight's 5 sites (needs translations). `vfxPullPanel.js:8246`'s multi-shot
failure summary interpolates `r.error` per shot — N errors, not one exception,
so it needs its own shape. `errorBanner`'s hint glue needs CSS plus the join,
not the join alone. `runSaveCascade`'s `UNAVAILABLE` is still unsurfaced at all
seven call sites.

---

## Iteration 21 — an export that fails should say so

### What a user would have seen

Two very different endings, one indistinguishable result:

- you press Cancel in the Save dialog → nothing happens, no message
- every save route fails and no bytes are written → nothing happens, no message

Silence is an answer, and it is the wrong one. Clicking "Export CSV" and getting
neither a file nor a word about why is the least explainable thing an app can do
to someone who will not open a console to find out.

The Visual QC PDF button was worse than silent. It announced *"Ready. Use 'Save
as PDF' in the print dialog"* unconditionally — including when the popup had
been blocked and the HTML fallback had failed or been cancelled. It pointed at a
dialog that was not on screen.

### Seven sites, two files

`runSaveCascade` has always returned `SAVED`, `CANCELLED` or `UNAVAILABLE`. All
seven consumers threw it away: four in `features/reviews/index.js` (two export
menu items, two panel buttons) and three in `components/visualQcModal/index.js`
(JSON, CSV, PDF). All seven now branch on it.

### The new module, and the helper it deliberately does not have

`src/scripts/core/saveNotice.js` maps an outcome to `{ tone, text }`. No DOM, no
i18n import beyond the guarded shim, so it is importable in Node tests and in
both build targets.

There is no `show()` helper, because the two surfaces genuinely differ.
`visualQcModal` has a progress line, so it **should** report a cancel there —
the line is on screen and the user is looking at it. `reviews` has no status
surface at all (measured: grep for `setStatus|toast|setProgress` in that file
returns nothing), so its only channel is a modal, and it **must not** report a
cancel: nobody needs a popup confirming that their own Cancel button worked.
`isDialogWorthy()` is that asymmetry, written down.

### "Export finished." and not "Saved to disk."

No tier can prove the bytes landed. `chrome.downloads.download` resolves an id
when the download is *accepted*; the anchor tier is `downloadText(...); return
SAVED;` with no callback at all. A "Saved to disk" confirmation would have
swapped one unverified success claim for another. The shipped sentence describes
what the app actually knows — the export finished — and a test asserts the
stronger claim stays out.

### The print button now says one of three things

`openPrintReportHtml` returns `PRINTED`, the fallback save's real outcome, or
`UNAVAILABLE`, instead of a bare `true` for all three. Its caller says "use Save
as PDF in the print dialog" only when a print dialog exists, "report saved as
HTML, open it and print to PDF" when the popup was blocked but the file got
written, and the failure sentence otherwise.

### Gate

`tests-js/saveNotice.test.mjs`, 15 tests. Half module, half source gate over the
call sites — a module returning perfect sentences is worth nothing if a call
site goes back to discarding the outcome, and no unit test can see that. The
gate matches constructs, not literal wordings.

Seven mutations applied, seven caught. M5 failed to apply on the first attempt
(a `perl -0pi` pattern carrying the UI string's curly quotes matched nothing);
redone as an occurrence-guarded Node script it applied and was caught. Second
silent `perl` miss in two iterations — the Node form is the default now. All
three files restored byte-identical.

### A gate from iteration 20 had to move, and that is the gate working

`friendlyAlert.test.mjs` counts calls per converted file. `reviews` went 4 → 5
because `announceExport()` adds one. Raised with a comment saying why.

### Still open on this front

The three new sentences have no dictionary rows in the seven locales, so they
show in English until a native speaker adds them. The anchor tier's
evidence-free `return SAVED` is unchanged in both cascades — making it honest
needs a real completion signal from the platform layer. `PRINTED` means
`window.open` succeeded, not that a print dialog appeared. `pfxPlatform.saveFile`
still collapses cancel into failure; zero callers, still left alone.

## Iteration 22 — the advice glued to the end of a path

Two defects, both on the failure-message path, both closed. Commit `1b80df1`
(six files).

### What a user saw

Every `showError()` call site now reaches a visible banner, and `friendlyText()`
glued the hint onto the message with a space. Two rules end their message with a
filesystem path:

```
That file or folder couldn't be found:
/Volumes/SHOW DRIVE 01/reel3/A003C012.ari Check that it still exists and…
```

Post-house volume names have spaces. There is nothing in that line showing where
the path ends and the advice begins — and the path is the actionable part. Now
joined with a newline.

### The comment that said it couldn't be done

`friendlyAlert.js` had carried a paragraph since iteration 20 asserting the
banner rendered with default `white-space`, so a newline would collapse and
"fixing that one needs CSS, not a different join."

`.pfx-error-banner` has had `white-space: pre-wrap` since `d0ab098` — the commit
that created the banner. The comment had reasoned from `el.textContent = msg`
without ever opening the stylesheet, and had been telling the next reader not to
try, for two iterations. Corrected in place, not deleted; the correction is the
useful part.

**Carry this one:** a comment that reasons about a file it has not read can be
wrong in a way that outlives the person who wrote it. Grep before you assert.

### Three sentences no locale had

`saveNotice.js` (iteration 21) localises its three ending sentences through
`friendlyError`'s `translate` shim and shipped with **zero** `ERROR_DICT` rows in
all six locales. `errorI18n.test.mjs` — the gate whose whole job is catching
exactly that — scanned `friendlyError.js` only, so it never looked. It now scans
`saveNotice.js` through its own extractor, and the 18 rows are in.

**Carry this one too:** a gate that scans one file cannot notice a second file
borrowing the same shim. And the two edits were coupled — rows without a widened
scan trip the gate's own orphan test.

### Gates and mutations

`errorBanner.test.mjs` +93 lines (one raw string per rule, ≥14 must match a rule
with advice so the loop cannot pass vacuously; the three-line file-not-found
shape with a spacey volume; inline `pre-wrap`; a host `#errors` left alone; the
stylesheet rule). `errorI18n.test.mjs` +36 lines (the saveNotice scan, the
`>= 45` → `>= 48` threshold, a three-sentence spot-check).

7 mutations applied with the occurrence-guarded Node form, 7 caught, all files
restored byte-identical. Two reported `SETUP-FAIL` on the first pass — Korean
values written as `\uXXXX` in the harness where the file holds them literally.
That is the guard doing its job; a `perl -0pi` would have reported success.

`npm run build-verify` exit 0, `npm run build:renderer` exit 0 (375 files).

### Still open on this front

The 18 new translations are machine-authored and want a native-speaker pass —
same list as the 486 in `UI_DICT_ROWS`. The anchor tier's evidence-free
`return SAVED` is unchanged in both cascades. `PRINTED` still only means
`window.open` succeeded. `_path()` truncates an unquoted path at its first
space — latent, since every observed ENOENT string quotes it. The general sweep
for comments that assert things about files they never read has not been run.

## Iteration 23 — the repair screen

Fixed, in `src/scripts/modules/smart_engine_settings.js` (commit `0ee334d`):
Repair Engines was a silent no-op on three of the four log tabs and clobbered
the playback log on the fourth; seven status lines printed raw exception text
on the panel four `friendlyError` hints send users to; `friendlyStatus`'s
newline collapsed in the two `<div>`s it lands in; the brew instructions
assumed a reader who already knew what Homebrew was; `Proxy failed: unknown`;
and a header comment claiming the button opens a browser it has never opened.
Gate: `tests-js/smartEngineSettings.test.mjs`, 13 tests, 8 mutations caught.

New this iteration, still open: `init()` gates its auto-check on
`list.textContent.includes('Check Engines')` — presentation text as control
flow, safe only while that placeholder is not a dictionary key; fixing it means
editing `index.html`, which is the user's uncommitted work. Three extension-only
`alert()` calls (102, 158, 217) are unreachable in the desktop build.

`_path()`'s unquoted-path truncation was chased and **stays latent**: four
in-repo producers exist, but none of their wires reach `friendlyError` today.
`imf_ui.js:997` still prefers `result.code` over `result.error`, so users see
`FAILED · CPL_NOT_FOUND`; that file is the user's dirty work and cannot be
committed. The anchor tier's evidence-free `return SAVED` is unchanged in both
cascades. `PRINTED` still only means `window.open` succeeded. The general sweep
for comments asserting things about code or CSS they never read has still not
been run — iteration 22 found one, iteration 23 found another, in unrelated
files, which is the shape of a pattern rather than two accidents.

## Iteration 24 — the success returned before the attempt

Visual QC › Export PDF. `openPrintReportHtml` ended its print branch with

    setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 300);
    return PRINTED;

and the caller then said **"Ready. Use “Save as PDF” in the print dialog."**
The return happened 300 ms before anything was attempted, so a pop-up blocker
handing back a window it then closes, a user closing that window during the
layout delay, a `print()` that throws, and a window with no `print()` at all
were four distinct failures all reported as the one success — and the sentence
pointed at a dialog that was not on screen. That is the precise thing
`core/saveNotice.js` was built to stop the app doing; the earlier pass fixed
the fallback half of this same function and left the print half alone, which is
the more useful finding: a fix scoped to the branch that was reported, in a
function whose other branch had the same defect.

The same site had the last unverified disk claim in the app: the fallback said
"Report saved as HTML." It is the one export path that bypasses `saveNotice()`,
which is exactly why it was the one place still saying "saved".

**`src/scripts/core/printOutcome.js`** (new, 133 lines) mirrors the
`saveOutcome`/`saveNotice` split for printing: `PRINTED`/`OPENED`/`CLOSED`,
`tryAutoPrint(win, {delayMs, wait})` with an injectable clock so the delay is
testable, and `printNotice(outcome)` which owns every print ending and
*delegates* the save outcomes rather than re-wording them. `tryAutoPrint`
treats an unreadable `.closed` as gone, a blocked `focus()` as irrelevant, and
a missing or throwing `print()` as OPENED.

**Behavioural, not cosmetic:** `CLOSED` now falls through to the HTML file
save. A window that went away used to leave the user with no file and a pointer
at a dialog that did not exist; they now get the file.

18 `ERROR_DICT` rows for the three new sentences (3 × ko/ja/zh-TW/th/id/fil).
`errorI18n.test.mjs` gained a `SCANNED` table — one row per module that
localises through `translate()`, with the sentence count it should carry — so
the coupling is now enforceable in both directions: a fourth sentence without
rows fails, and rows added for a module nobody listed read as dead keys and
also fail.

**The lesson worth keeping.** Five of the new tests passed for the wrong
reason. `fakeWindow` overrode properties with
`Object.defineProperties(win, Object.getOwnPropertyDescriptors(over))` where
`over` was already a descriptor map, so each descriptor got wrapped in a second
one and `win.print` held the object `{value: fn}` instead of a function. "A
non-function `print` is OPENED" and "a truthy `closed` is CLOSED" are both true,
so the assertions passed while testing nothing they claimed to. No test failure
could have shown this; only the mutation harness did, by missing two mutations
it should have caught. The fixture now has a self-check test covering all five
descriptor shapes. **Fixtures need gates of their own.**

Still open after this iteration: the anchor tier in both save cascades still
returns `SAVED` with no evidence — this fixed the wording at one site, not the
tier. Three hardcoded English progress strings remain in `visualQcModal`
(`'Opening print dialog…'` 1868, `'Done. No events.'` 1609, `'Done.'` 1700).
`init()`'s `includes('Check Engines')` control flow, `imf_ui.js:997`'s code-over-
message, and `_path()`'s latent unquoted-path truncation are unchanged. The
general sweep for comments asserting behaviour they never verified has now
found a third instance, in a third unrelated file, and still has not been run
as a sweep.

## Iteration 25 — the error message nobody could read

**Research.** The Visual QC modal has exactly one place it reports a failure:
the progress strip under the buttons, `.pfx-qc-progressTxt`. There is no toast
behind it and no dialog, so whatever lands there is the whole message. Both of
its catch handlers put the exception's own text there —
`setProgress(0, err?.message || String(err))` at the Run button's `.catch` and
in the Export-PDF handler's `catch` — which means a colourist reads
`ENOENT: no such file or directory, open /Vol/Show_A/A001.mov` or a bare
`Failed to fetch`. Both of those already have a friendlyError rule carrying a
hint that names what to do. Nothing routed the text through `friendlyStatus`,
so neither rule was ever reached. The rules existed; the two call sites did not
use them.

**The thing that would have made it worse.** `friendlyStatus` returns
`message\nhint`, and `.pfx-qc-progressTxt` has exactly one rule in the whole
stylesheet — `main.css:11316`, `font-size:12px`. `white-space` is therefore
`normal`, the break collapses, and the hint would have arrived welded onto the
end of the message: *"…could not finish writing.Free up space or choose another
drive"*. Routing the two sites without fixing that would have shipped a line
worse than the raw exception. This is the same collapse iteration 22 removed
from the error banner and iteration 23 from the engine-settings status lines,
which is where the fix came from: `smart_engine_settings.js`'s `_setStatusText`
already does `el.style.whiteSpace = 'pre-wrap'` for exactly this reason, with a
comment saying so. `visualQcModal` was the one status surface that had not
gotten the same treatment. Set from the component rather than the stylesheet
because the element is built here and `main.css` is 301/326 lines of the user's
in-flight work.

**The third consumer.** `onStatus` is a callback into the caller's own status
element — a one-line strip in `reviews/index.js` whose CSS this component does
not own. Giving it the two-line text would collapse the break to *nothing*
there. It now gets the break replaced with a space on the way out, so the mirror
is correct regardless of how the caller styles it, and `reviews/index.js` — also
the user's in-flight work — did not have to be touched.

**Prefixes.** `friendlyStatus` only preserves an operation prefix its own regex
accepts: at most 40 characters before the colon, and containing a space. A
prefix that fails is not an error — it is silently dropped, taking the "which
operation" half of the message with it. `Visual QC scan failed` (21) and
`Exporting the PDF report failed` (31) were both run through the real function
before being trusted, and the gate re-runs that check against whatever prefixes
the source actually contains.

**Gate.** `tests-js/visualQcStatus.test.mjs`, 7 tests, checked against real
`friendlyStatus` output rather than a hand-written string that might have no
newline in it at all: a floor that the file still has ≥12 `setProgress` calls
and the import; no `setProgress` call may pass `err.message`/`String(err)`
unwrapped; both prefixes present and both surviving the prefix regex with their
tail rewritten; a floor that `friendlyStatus` still emits a newline; the element
preserving newlines from *either* CSS or the component, so moving the rule into
the stylesheet later is a refactor and not a failure; and the mirror's
replacement leaving no newline and welding no two sentences together.
**10 mutations applied (`/tmp/mut25.mjs`), 10 caught**, file byte-restored.

**Verified.** `npm run build-verify` exit 0 (after `git add` of the new test —
the untracked-gate caught it, as designed), `npm run build:renderer` exit 0 (376
files). Committed as `32271b4`, two files, no mode changes, no foreign hunks.

Still open after this iteration: an error with **no** friendlyError rule still
passes through verbatim after the prefix — `NotAllowedError: play() failed` is
the likely one for a media scan, and widening the rules table costs six locales
of dictionary. That is the obvious next target. The five hardcoded English
progress strings in `visualQcModal` are unchanged and deliberately out of scope
here. The anchor tier in both save cascades still returns `SAVED` with no
evidence.

## Iteration 26 — the DOM's own errors

Iteration 25 ended by naming its own successor: an error with no `friendlyError`
rule still reaches the user verbatim, and `NotAllowedError: play() failed` was
the guess for what a media scan would hit. This iteration measured the guess
instead of trusting it.

**Research.** Thirteen DOMException strings, each traced to the line of this
repo that can produce it — not invented for the corpus. `getImageData` in
`visualQcModal/index.js:425` and `imf_player.js:1530` (whose catch already
special-cases `SecurityError`); `getUserMedia` in `prep_mark.js:29280`;
`createMediaElementSource` in `imf_ui.js:594`; the eight
`setTimeout(() => ctrl.abort())` fetch timeouts; `.play()` in 38 places. Run
through the real function (`/tmp/probe26.mjs`): **13 of 13 unclassified**.

**Code.** Three rules added, two widened. `Not allowed`,
`Stopped before it finished`, `Could not read the video frame`;
`NotSupportedError` / `MEDIA_ELEMENT_ERROR` / "no supported sources" folded into
the existing decode rule and `InvalidStateError` / "Illegal invocation" into the
generic one. Widening an existing rule costs **zero** translation rows; a new
rule costs **eighteen** (3 strings × 6 locales). That arithmetic, not taste,
decided which of the five became a rule. 13 unmatched → 2.

**The one that changed its own wording.** The obvious title for `AbortError` is
"Cancelled". Grepping proved it false: three sites in this app check
`err.name === 'AbortError'` to mean a dismissed file picker, but eight arm a
`setTimeout` abort on a fetch, and the DOM gives both the identical sentence.
"You cancelled this" would be wrong for the majority case — a user whose
companion had gone quiet. Retitled `Stopped before it finished`, which is true
either way, and placed below the timeout rule so `AbortSignal.timeout()` keeps
the better hint. A test now pins the wording so it cannot drift back.

**Two deliberate non-fixes.** `QuotaExceededError` and `NotReadableError` are
still unclassified. prep_mark already catches the quota case with its own toast
at 4113, and NotReadableError only reaches the microphone path, which has its
own handler. Neither rule would ever fire. Documented rather than papered over.

**i18n.** 54 rows across ko/ja/zh-TW/th/id/fil via `/tmp/dict26.mjs`, anchored
on each locale's own text and verified to land exactly six times per key.
`errorI18n.test.mjs`'s extraction floor bumped 48 → 62 (the scan now finds 65).

**Gate.** `tests-js/friendlyErrorDomExceptions.test.mjs`, 21 tests: eleven
string→title pins, the four ordering collisions, the honest-wording constraint,
a jargon-leak and hint-length pass over the new set, a vacuity floor, and a
floor asserting the constructs in `src/` that produce these exceptions still
exist — a rule for an exception nothing can throw is dead weight that reads
like coverage. **11 mutations applied (`/tmp/mut26.mjs`), 11 caught**, file
byte-restored. Two initially escaped and the assertions were rewritten until
they didn't; the misses are recorded in the audit rather than smoothed away.

**Verified.** `npm run build-verify` exit 0, `npm run build:renderer` exit 0
(376 files). Committed as `2f3601e`, five files, no mode changes, dirty count
unchanged at 693.

Still open: the eight `setTimeout(() => ctrl.abort())` sites could abort with
`new DOMException('timed out', 'TimeoutError')` and route themselves to the
better hint — its own iteration. The five hardcoded English progress strings in
`visualQcModal`. The anchor tier in both save cascades still returns `SAVED`
with no evidence.

## Iteration 27 — the proxy failure that always blamed the codec

**Research.** Last iteration left a note: eight `setTimeout(() => ctrl.abort())`
sites present a hung request as a user cancelling. Chasing the first of them
into `proResProxy.js` turned up something worse than a vague message. The catch
that reports why a preview proxy failed was a three-branch ternary:

```js
const hint = msg.includes('ffmpeg_missing')
  ? `${label} — ffmpeg not found on this machine`
  : (msg.includes('host_unavailable') || msg.includes('host_timeout'))
    ? `${label} — native helper not available (Browser Mode only)`
    : `${label} — unsupported codec`;
```

Enumerating every way `getProxyStreamUrl` can reject — `host_unavailable` (:422),
`upload_failed_NNN` (:466), `transcode_timeout` (:477), `progress_fetch_failed`
(:494), `data.error` from the companion (:496), and the 10 s per-fetch abort —
that default is wrong **five times out of six**. A new species:
**misdiagnosis-as-fallback-branch**, a ternary whose *default* arm asserts a
specific cause. It is worse than saying nothing. "Unsupported codec" sends a
colourist off to re-transcode a plate that was never the problem while the
actual fault — restart the helper, remount the drive — goes unmentioned.

Reading `src/tools/pfx_host.py` for what the companion actually puts in
`data.error` found `ffmpeg_missing` (:159), `input_missing` (:162),
`ffmpeg_exit_{rc}` (:237), `forbidden` (:306), `file_not_found` (:327) and raw
`str(e)` (:242). `input_missing` is the one that stung: it means the plate moved
after the job was queued — the most actionable failure on the list, ten seconds
to fix — and it was landing in the catch-all as a codec complaint.

**Code.** A rule table of six patterns over thunks (`[re, () => translate('…')]`
— thunks so the language is read at call time, not at module load, and so
`errorI18n.test.mjs`'s literal-only scanner can still see the strings), falling
through to `friendlyError` and then to a statement with no cause attached at
all. `onProxyFail` has **7 external consumers** (`prep_mark`, `playableMedia`,
`aceslook`, `cutdiff`, `cutdiff2`, `platelink2`, `amf_convert`), so fixing the
one producer reached every surface without touching a single dirty file.

Two fixes came out of measuring rather than planning. The per-fetch abort now
carries `new DOMException('the media helper timed out', 'TimeoutError')` instead
of a bare `abort()`, whose rejection text is the same one the DOM gives for a
dismissed file picker. And `_proxyFailReason` reads `err.name`, not just
`err.message` — a DOMException keeps the useful half of its identity in `.name`,
so message-only matching was one reworded throw from silently breaking. That is
its own species: **identity-lost-by-reading-only-.message**.

**Audit.** New gate `tests-js/proResProxyFailure.test.mjs`, 18 assertions. Its
corpus is not invented — it reads the thrown tokens back out of the source and
the `_update_session(error=…)` tokens out of `pfx_host.py`, so a rejection
nobody classified fails the build rather than reaching a user as a guess.
**11 mutations applied (`/tmp/mut27.mjs`), 11 caught**, source byte-restored.
A twelfth was written and then withdrawn rather than forced — see the audit.

**Verified.** `npm run build-verify` exit 0 (the untracked-gate guard correctly
failed first on the new file, then passed once tracked — the guard works),
`npm run build:renderer` exit 0 (376 files). Committed as `483e2f5`, four files,
no mode changes.

Still open: `imf_ui.js:8895-8897` carries the **same** three-branch ternary shape
this iteration replaced, but that file holds the user's in-flight work and is
blocked. `playableMedia.js`'s own three `onProxyFail` literals (:308, :339, :443)
are still untranslated English. Seven `setTimeout(() => ctrl.abort())` sites
remain unnamed.

## Iteration 28 — the playback failure that guessed at your mpv install

**Target.** `src/scripts/core/playableMedia.js` — the other end of the surface
iteration 27 fixed. `proResProxy.js` says why a proxy *build* failed;
`playableMedia.js` says why *playback* failed, and both feed the same
`onProxyFail(hint)` status strips in seven modules.

**Found.** Three hints, each asserting more than the code had established.

1. `:308` — the mpv catch:
   `` `Direct ProRes playback failed (${err.message.includes('not found') ? 'mpv not installed' : err.message}). Create proxy fallback?` ``
   An English substring decided the diagnosis and the default handed the raw
   exception to a one-line strip. Measured against `mpv_engine.js`, the default
   is the common case: `_waitForSocket` rejects with
   `MPV socket not created at /var/folders/…/mpv-3.sock within 4000ms` — no
   "not found" in it. Someone whose mpv is installed but wedged read a temp
   socket path. And the true branch fires on any message mentioning something
   not found, so a missing plate became an mpv install problem.
2. `:339` — `could not decode with the native player`, printed whenever
   `_pfxNativeAttempted` was set. That flag is assigned at `:240`, the top of
   `_startNativeAVPath`, on entry. It proves the native path was tried and
   nothing about decoding.
3. `:443` — `could not create playback URL`. Jargon about our plumbing.

All three were untranslated English literals, invisible to `i18n.js`.

**Done.** A `_PLAYBACK_FAIL_REASONS` thunk table plus an exported
`_playbackFailReason(err)` that reads `err.name` before `err.message`, falls
through to `friendlyError`, and only then admits it does not know. Site 2 now
says both players had a turn and neither produced a picture; site 3 says
PostFlowX could not prepare the file for playback. 36 new `ERROR_DICT` rows
(6 keys x 6 locales).

**Gate.** `tests-js/playableMediaFailure.test.mjs`, 16 assertions, every corpus
entry cited to the line that throws it, plus floors that pin the wording of
those three throws in `mpv_engine.js`/`mpvPlayer.js` and a floor that fails if
`_pfxNativeAttempted` moves out of the top of `_startNativeAVPath` (at which
point the wording could honestly become specific again). Mutation-proven 11/11,
source restored byte-for-byte.

**Still open.** `imf_ui.js:8895-8897` carries the same three-branch ternary
shape iteration 27 replaced — blocked, dirty file. Seven
`setTimeout(() => ctrl.abort())` sites remain unnamed. Site 3 is also reached
when the load token moved on (the user picked another clip); that direct call
site is not behind the token-checking forwarder. Pre-existing, unchanged,
disclosed in the test.

Commits: `8717c1b`.

## Iteration 29 — the Visual QC progress strip, in six languages

**Found.** Eleven hardcoded English literals narrating the Visual QC scan. A
Visual QC scan is the longest-running operation in the app and the line under
the progress bar is the only evidence it has not hung — and it was the one
surface the translation work of the last ten iterations had never reached. It
could not: a literal inside a template is not a dictionary key, so `i18n.js`
never saw it, and the MutationObserver could not rescue it either, because
`setProgress` writes with `.textContent` and the observer only re-translates
text it holds a key for.

Two of the eleven were sharper. `friendlyStatus()` holds the `"<what failed>:"`
prefix back from `friendlyText` deliberately — its own doc says running the
whole string through would drop the prefix, the only thing on screen naming
which operation failed. That contract makes localising the label the *call
site's* job, which is why `friendlyError.js` exports `translate()`. Both call
sites had skipped it, so a Thai user read a fully translated error message with
`Visual QC scan failed:` welded to the front of it.

**Done.** Eleven `UI_DICT_ROWS` keys x six locales; both labels wrapped in
`translate()` at the call site; `translate` imported from `friendlyError.js`
(not `i18n.js` — the shim is guarded and does not drag the whole dictionary
into a component that needs eleven rows).

**And the fix broke Japanese.** See Audit 29 — this is the finding of the
iteration, not a footnote.

**Gate.** `tests-js/visualQcProgress.test.mjs` (new, 9 tests) and three edits to
`tests-js/visualQcStatus.test.mjs`, which went 7 -> 8. Mutation-proven 9/9
across both source files — the first multi-file harness of this run — plus both
Japanese spaces reverted individually and caught.

**Still open.** Every *other* `friendlyStatus` call site's label wants the same
unspaced-translation sweep; the new test only covers visualQcModal's two.
`seekTo` still rejects with a bare `'Seek failed'` / `'Seek timeout'`
(`visualQcModal/index.js:1470`, `:1477`), which reaches `friendlyStatus` and
falls to the catch-all — a two-row rule pair would fix it cheaply.

Commits: `fd7e241`.

---

## Iteration 30 — the Preflight pane speaks 7 languages about your delivery and English about itself

**Research.** The Preflight pane (`src/tools/preflight/`) is the most thoroughly
translated surface in PostFlowX: roughly 148K of check titles, severities and
"here is how to fix it" guidance across seven locales, with `locale.js` selecting
between them. Its renderer, `ui.js`, does the right thing at nineteen sites —
`state.config.ui.labels?.key || "English fallback"`. Its controller, `app.js`,
did not. Of the nine `alert()` calls in `app.js`, exactly one read a label; the
other eight were English literals, and five of those pasted an exception's own
text onto the end. Seven progress labels and four meta lines were literals too.

Exactly one call site following the pattern is the whole finding. It means
nobody decided the controller should speak English — the convention was known,
and it simply had not travelled the twenty lines from the renderer to the
controller.

**The user-facing shape of it.** A Thai producer reads the entire delivery spec
in Thai, presses Run, and gets `Preflight failed: Failed to fetch`. The label is
invisible to every dictionary in the build, and the tail is a browser string. Not
a sentence anybody outside this codebase can act on, in any language.

**Code.** New `src/tools/preflight/app/paneText.js`:

- `paneLabel(config, key, fallback)` reads the active locale LIVE rather than
  closing over `state.config.ui.labels`. `app.js` swaps locale in place when the
  language switcher fires; a captured `L` would keep serving the previous
  language until the next full render.
- `failureReason(config, err)` maps a failure to exactly one translated
  sentence — by DOMException `.name` first (6 entries) and message pattern
  second (5 rules), because a DOMException keeps the useful half of its identity
  in `.name` and loses it the moment the browser rewords the message. An
  unmatched error gets a vague-but-true sentence pointing at the console; a
  specific wrong answer ("the disk is full" to somebody with 4TB free) costs
  more than a vague right one.
- `failureAlert` joins the two halves with `\n\n`, because `alert()` honours
  newlines — unlike the one-line status strips everywhere else in PostFlowX,
  which is why those use `": "`.

`app.js`: 21 sites across 17 anchors, rewritten by an occurrence-guarded script
that counted every anchor before writing a byte (three anchors are deliberately
non-unique — the same rescan alert appears 3x, two `Importing files…` progress
lines 2x each).

**Two keys were read by code and absent from config.** `drop_hint`
(`ui.js:419`) was missing from all seven configs, and `views` (`app.js:411`) was
present only in `fil`. Both fell back to English in every language, including
English, where the fallback happened to be identical and so nothing looked
wrong. Both fixed.

**Translation.** 174 cells added — 25 keys x 7 locales, minus `fil`'s existing
`views`. Inserted textually with brace matching rather than by JSON round-trip;
see Audit 30 for why that distinction cost an hour and mattered.

**The technical detail is not lost.** Every site already called
`console.error(e)` on the line above the alert. Taking the exception out of the
dialog moves it to where a support engineer looks and away from where a producer
looks. That is the entire trade, and it is only defensible while the
`console.error` is there — so the gate now asserts each one still is.

**AbortError stays untranslated, deliberately.** Both folder pickers filter
`e?.name === "AbortError"` before reaching an alert, because that is the user
closing a dialog. `failureReason` does not give it a sentence; it falls to the
unknown one. Written into the header so the next reader sees a decision rather
than an oversight: if a guard is ever dropped, a vague sentence is a smaller lie
than a confident one about permissions.

**Gate.** `tests-js/preflightPaneVoice.test.mjs`, 17 tests. Mutation-proven
**16/16 caught**: a reverted alert, a failure dialog going back to pasting the
exception, a reverted progress label, a meta line losing its translation, a
deleted `console.error`, a deleted `AbortError` guard, a locale losing a key, a
translator pasting the English back, a dropped `{placeholder}`, the English
config drifting from the code fallback, a renderer-read key removed again,
`failureReason` flattened to one answer, the name/message tables swapped, the
exception appended "just for support", a blank cell beating the fallback, and
`paneText` ceasing to substitute. All 16 files restored byte-for-byte and
verified.

The gate's first three real catches were its own author's — see Audit 30.

**Still open.** The 174 new cells are machine-authored and want a native-speaker
pass, which brings this run's total to 829 machine-authored strings. Ten label
keys in the configs are read by nothing at all; five of those exist only in `en`
and `fil`. `src/tools/visionscope/*` has no i18n of any kind.

## Iteration 31 — `seekTo`'s bare `'Seek failed'` gets a rule and six translations

**Found.** Flagged as the cheapest remaining fix at the tail of Iteration 29
and again in Audit 30: `visualQcModal`'s three `seek()` implementations (scan,
thumbnail queue, PDF stills export) reject with a bare `'Seek failed'`,
`'Seek failed during thumbnail capture'`, or `'Seek failed during still
capture'` when the `<video>` element's `seeked`/`error` events never fire in
time. `'Seek timeout'` — the sibling string from the same call sites — already
had a rule in `friendlyError.js`'s generic timeout matcher; `'Seek failed'`
fell through it and reached the user as raw text.

**Done.** One new rule, `/\bseek (failed|error)\b/i`, placed below the timeout
rule so it only catches the non-timeout case rather than widening it — pinned
with an ordering test so a future reorder can't let the timeout rule's more
specific advice get swallowed. Three new `ERROR_DICT` cells (title, message,
hint) x six locales (ko, ja, zh-TW, th, id, fil), inserted textually ahead of
each locale's `"Unexpected response"` entry to keep dictionary order roughly
parallel to the RULES table, per this file's established i18n-editing
convention (see Audit 30 on why textual inserts, not JSON round-trips).

**Gate.** `tests-js/friendlyErrorRules.test.mjs`: 3 new `NEWLY_CLASSIFIED`
entries plus the seek-timeout-vs-seek-failed ordering pin, 27 tests total.
`tests-js/errorI18n.test.mjs` (the translation-coverage enforcer) needed no
changes — it already fails on any RULES string without matching `ERROR_DICT`
entries in all six locales, which is exactly what caught this rule's first cut
being English-only. Mutation-proven 3/3: reverting the rule's regex to a
non-matching pattern failed exactly the three new classification tests and
none of the timeout tests, confirming rule-ordering independence.

`npm run build-verify` exit 0. `npm run build:renderer` exit 0.

**Still open.** The 10 orphaned label keys, the 829 machine-authored strings
wanting a native pass, and `src/tools/visionscope/*`'s missing i18n all remain
exactly as reported in Iteration 30.

Commits: `4a6d778`.

## Iteration 32 — Project Manager's delete/rename/duplicate stop showing raw backend error strings

**Found.** `src/scripts/features/projectManager/projectManager.js`'s three
mutating actions — delete, rename, duplicate — each end on failure with
`window.alert(\`Could not <verb> "${proj.name}": ${r?.error || 'unknown
error'}\`)`. `r.error` is whatever the main-process IPC handler put in its
`{ ok:false, error }` reply, unfiltered — an `EACCES`, an `ENOENT` with a
`/Volumes/…` path, or similar. This is exactly the defect
`core/friendlyAlert.js` was written to remove (see that file's header), but
this call site predates the module and was never converted; `visionscope`
i18n and the 10-orphaned-label decision both stayed off the table per the
prior instruction to pick something smaller.

**Done.** Imported `friendlyAlert` from `../../core/friendlyAlert.js` and
replaced all three `window.alert(...)` calls. Following the existing
convention (`smart_engine_settings.js`, `imf_package_ui.js`,
`reviews/index.js`, `vfxPullPanel.js`): the label is a static operation phrase
("Deleting project failed", "Renaming project failed", "Duplicating project
failed") passed as a literal string, not an interpolated template — the
project name travels in the first (error) argument instead, as
`` `${proj.name}: ${r?.error || 'unknown error'}` ``, so `friendlyError()` still
gets first crack at recognising a filesystem path or errno inside it.

**Gate.** `tests-js/friendlyAlert.test.mjs`'s call-site table (`CONVERTED`)
gained a fourth entry, `projectManager.js` → 3 calls, and the labelled-call-site
count moved from 7 to 10. Mutation-proven: reverted the delete call site back
to the raw `window.alert` one-liner, confirmed the call-count assertion failed
(9 seen, 10 expected), restored, confirmed 9/9 tests green again. Full
`npm run build-verify` exit 0 (Node, JS, Python suites plus the innerHTML/XML/
fail-open scan gates). `npm run build:renderer` exit 0, 377 files.

**Still open.** The 10 orphaned label keys, the 829 machine-authored strings
wanting a native pass, and `src/tools/visionscope/*`'s missing i18n all remain
exactly as reported in Iteration 30 — none touched this iteration.

Commits: `8907cf0`.

## Iteration 33 — Nine friendlyAlert operation labels were shipping English-only to six locales, invisible to the test that exists to catch exactly this

**Found.** Iteration 32 (and the three before it) converted raw
`window.alert(err.message)` call sites to `friendlyAlert(err, 'label')` across
five files. `friendlyAlert.js`'s `composeAlert()` calls `translate(label)` on
that second argument, but `tests-js/errorI18n.test.mjs` — the file whose own
header comment says "any module that reaches for translate() has to be added
to SCANNED below, or it ships English to six locales and every test in this
file still passes" — only scans `translate('...')` literal calls inside
specific listed files. It had no mechanism for the friendlyAlert-label shape,
where the string to translate lives in the *caller* as a second argument, not
inside `friendlyError.js`/`friendlyAlert.js` themselves. Grepping confirmed
none of the 9 unique labels ("EXR export failed", "Reviews JSON/CSV/PDF
export failed", "Test proxy generation failed", "IMF diagnostics failed",
"Deleting/Renaming/Duplicating project failed") existed anywhere in
`ERROR_DICT` — a real English-only gap in ko/ja/zh-TW/th/id/fil, of the exact
class this test file's comments warn about, that had gone undetected across
four prior iterations that each added another labelled call site.

**Done.** Added all 9 labels to `ERROR_DICT` in `src/scripts/modules/i18n.js`
across all six locale blocks (ko, ja, zh-TW, th, id, fil) — 54 new key/value
rows total. Extended `tests-js/errorI18n.test.mjs` with a `friendlyAlertLabels()`
scanner (regex: `friendlyAlert(<arg>, '<literal>')`) and a `SCANNED_LABELS`
table listing the 5 caller files with their expected literal-label counts
(`vfxPullPanel.js`: 1, `reviews/index.js`: 3, `smart_engine_settings.js`: 1,
`imf_package_ui.js`: 1, `projectManager.js`: 3), folded into the existing
`STRINGS` coverage set so the file's per-locale coverage/no-copy/parity/no-orphan
tests automatically extend to the new strings. `reviews/index.js` has 5
`friendlyAlert(` calls total but one (`friendlyAlert(notice.text, label)`)
passes a variable, not a literal, and re-shows a status-strip notice through
the label it was already raised with — correctly excluded from the scan and
noted in a comment, since ERROR_DICT already covers whatever produced that
label.

**Gate.** `node --test tests-js/errorI18n.test.mjs`: 29 tests, all green (5 new
`SCANNED_LABELS` tests plus the existing per-locale tests now covering 9 more
strings). Mutation-proven 2/2: (1) deleted the ko row for "EXR export failed"
— failed `ko: every failure message is translated` and (as a knock-on)
`the six locales cover exactly the same keys`, restored, green again; (2) bumped
`smart_engine_settings.js`'s expected count from 1 to 2 — failed with `1 !== 2`
naming the file, restored, green again. Full `npm run build-verify` exit 0
(Node, JS, Python suites plus innerHTML/XML/fail-open scan gates).
`npm run build:renderer` exit 0, 377 files.

**Still open.** The 10 orphaned label keys, the 829 machine-authored strings
wanting a native pass, and `src/tools/visionscope/*`'s missing i18n all remain
exactly as reported in Iteration 30 — none touched this iteration.

Commits: `b92507e`.

## Iteration 34 — smart_engine_settings.js's own header comment documented a contract it only half-implemented

**Found.** `src/scripts/modules/smart_engine_settings.js`'s header comment
states the panel's failure-text contract: every status line goes through
`friendlyStatus()`, each call passes `'<what was being done> failed: <raw>'`,
and `friendlyStatus` deliberately holds the label back from translation
(confirmed by reading `friendlyError.js` lines 317-352) because it only
rewrites the tail — the caller is responsible for translating the label
itself via `` friendlyStatus(`${translate('label')}: ${err.message}`) ``, the
pattern already established correctly in `visualQcModal/index.js`. Grepping
the file's 7 `friendlyStatus(` call sites showed only the fix already applied
mid-flight last iteration (line 104, "Engine check failed") followed that
pattern; the other 6 (lines 165, 171, 224, 230, 278, 333, covering "Decode
test failed" ×2, "IMF decode test failed" ×2, "Test proxy failed", and
"Loading the engine logs failed") were still handing `friendlyStatus` a bare
English label — a real English-only gap in ko/ja/zh-TW/th/id/fil, invisible
to `tests-js/smartEngineSettings.test.mjs`'s existing prefix-format test,
which checks the label has a space and matches `/fail/i` but never checks
translation.

**Done.** Wrapped all 7 `friendlyStatus` call sites' labels in `translate(...)`
and added `translate` to the file's import from `friendlyError.js`. Added the
5 unique underlying strings ("Engine check failed", "Decode test failed",
"IMF decode test failed", "Test proxy failed", "Loading the engine logs
failed") to `ERROR_DICT` in `src/scripts/modules/i18n.js` across all six
locale blocks — 30 new key/value rows total. Added
`modules/smart_engine_settings.js` to `tests-js/errorI18n.test.mjs`'s
existing `SCANNED` array (the `translate('...')`-literal scanner, not the
`friendlyAlert`-label scanner already covering this same file's one
`friendlyAlert` label) with `expected: 5`, folded into the shared `STRINGS`
coverage set.

**Gate.** `node --test tests-js/errorI18n.test.mjs`: 30 tests, all green (1
new `SCANNED` test plus the existing per-locale tests now covering 5 more
strings). `node --test tests-js/smartEngineSettings.test.mjs`: 13 tests, all
green unmodified — the existing `` /friendlyStatus\(`([^`]*)`\)/g `` prefix
regex still matches with `${translate('...')}` embedded inside the backticks,
so no test edit was needed there. Mutation-proven 2/2: (1) deleted the ko row
for "Engine check failed" — failed `ko: every failure message is translated`
and (as a knock-on) `the six locales cover exactly the same keys`, restored,
green again; (2) bumped `smart_engine_settings.js`'s `SCANNED` expected count
from 5 to 4 — failed with `4 !== 5` naming the file, restored, green again.
Full `npm run build-verify` exit 0 (Node, JS, Python suites plus
innerHTML/XML/fail-open scan gates). `npm run build:renderer` exit 0, 377
files.

**Still open.** The 10 orphaned label keys, the 829 machine-authored strings
wanting a native pass, and `src/tools/visionscope/*`'s missing i18n all remain
exactly as reported in Iteration 30 — none touched this iteration.

Commits: `1be92f6`.

## Iteration 35 — a failed companion startup retry never cleaned up the orphaned subprocess

**Found.** `electron/companion.js`'s `CompanionBridge.start()` spawns the
Python companion subprocess, then probes readiness via `_waitReady()`
(which round-trips a `getCapabilities` call). If the first probe fails it
waits 3s and retries once. Reading the `catch (retryErr)` block that handles
a second consecutive failure (lines 93-96 before this fix) showed it only
logged the error and emitted `'unavailable'` — it never called
`this._proc.kill()` and never set `this._proc = null`. Two consequences
follow directly from `start()`'s own guard at its top,
`if (this._proc) return;`: (1) the spawned Python process is left running
unsupervised, with nothing left holding a reference to reap or message it,
and (2) every future call to `start()` (the only call site is
`electron/main.js:292`) silently no-ops forever, because `this._proc` is
still truthy. Confirmed there is no existing test coverage for
`CompanionBridge`'s lifecycle — `tests-js/companionAuth.test.mjs` is a
same-named-sounding but unrelated file testing
`src/scripts/modules/companionAuth.js`'s URL-token helpers, not this class.

**Done.** In the `catch (retryErr)` block, added `if (this._proc) { this._proc.kill('SIGTERM'); this._proc = null; }` before the `emit('unavailable', ...)` call, so a
double startup-probe failure now tears down the subprocess and leaves
`start()` able to respawn on a later call. Added
`tests-js/companionStartupRetry.test.mjs`, which requires `child_process`
and swaps its `spawn` for a fake before requiring `electron/companion.js`
(companion.js destructures `spawn` from the same cached module object at
its own require-time, so the fake binds cleanly with no mocking library
needed), stubs `_waitReady()` to always reject, and fast-forwards the
3-second inter-retry `setTimeout` by temporarily overriding the global.
Asserts that after both probe attempts fail the fake subprocess was
`kill()`ed, `this._proc` is `null`, `isReady` is `false`, and a subsequent
`start()` call actually spawns again rather than no-op'ing.

**Gate.** `node tests-js/companionStartupRetry.test.mjs`: 1 test, green.
Mutation-proven: reverted the fix (dropped the `kill`/null block back to
just the log-and-emit), reran — failed on
`the orphaned subprocess must be killed once both probe attempts fail`
(`false !== true`), restored, green again. Full `npm run build-verify` exit
0 (Node, JS, Python suites plus innerHTML/XML/fail-open scan gates,
including the self-containment gate that requires new test files be
`git add`ed before the suite is considered clean). `npm run build:renderer`
was not run — this is Electron main-process code under `electron/`, not
`src/`-facing renderer code, so no rebuild is needed per the project's
one-source-two-targets convention.

**Still open.** The 10 orphaned label keys, the 829 machine-authored strings
wanting a native pass, and `src/tools/visionscope/*`'s missing i18n all
remain exactly as reported in Iteration 30 — none touched this iteration.
`CompanionBridge` has other untested lifecycle paths (e.g. the first-attempt
success path, `stop()`, `_onData`'s frame desync recovery) that could use
dedicated coverage in a future iteration, but were out of scope for this
specific fix.

Commits: `3f5157c`.

## Iteration 36 — acquireLease()/releaseLease() had a TOCTOU race across tabs

**Found.** `src/scripts/core/crossTabQueueLease.js` elects one leader tab
(among possibly several open tabs of the app) to own job submission, using
an IndexedDB-backed lease record plus a BroadcastChannel for
notifications. Before this fix, `acquireLease()` and `releaseLease()` both
read the current lease via `_getLease()` and, after an `await`, wrote the
new lease via `_setLease()` — two separate IDB transactions with an async
gap between them. Because IndexedDB only serializes transactions against
each other, not the JS that decides what to write, two tabs racing on
startup (the common case: `setTimeout(() => acquireLease(), 100)` fires in
every tab shortly after script load) could both read the same
stale/absent lease during their respective read transactions, both
independently decide "no one owns this, I should win," and then both
write themselves in as leader — each ending up with `_isLeader = true` and
each starting its own heartbeat and calling
`renderWorkerClient.buildProxy()`, defeating the whole point of the lease.

**Done.** Rewrote `acquireLease()` and `releaseLease()` to do their
get-then-put entirely inside one `readwrite` IDB transaction (bypassing
the `_getLease()`/`_setLease()` helpers, which remain in place and
unchanged for the read-only `checkLeadership()` path and the heartbeat
interval, where the same class of race exists but is far lower severity
since the heartbeat only refreshes a lease that path already holds).
Because real IndexedDB serializes `readwrite` transactions against the
same object store, no other transaction's `get` can interleave between
this transaction's `get` and its `put`, closing the race entirely.

**Gate.** Added `tests-js/crossTabQueueLeaseRace.test.mjs`, which runs
`crossTabQueueLease.js` (a plain global-scope IIFE, not a module) inside
two separate `node:vm` contexts sharing one hand-rolled fake IndexedDB —
the fake serializes `readwrite` transactions on the same store via a
promise-chained write lock, mirroring the real spec's guarantee closely
enough to expose the pre-fix race and confirm the fix closes it. Fires
`acquireLease()` from both simulated tabs concurrently and asserts exactly
one wins and the two tabs disagree on `isLeader()`. Mutation-proven:
reverted to the old two-transaction `_getLease()`+`_setLease()` shape,
reran — failed with both tabs reporting `isLeader() === true` (or both
`wonA`/`wonB` true), confirming the test genuinely detects the race;
restored, green again. Full `npm run build-verify` exit 0 (Node/JS/Python
suites, innerHTML/rawXML/fail-open scan gates, and the self-containment
gate requiring the new test file be `git add`ed). `npm run build:renderer`
was run and succeeded, since this changes `src/`-facing renderer code that
ships into both `dist/desktop/` and `dist/extension/`.

**Still open.** The heartbeat interval's refresh (`_startHeartbeat()`'s
callback, still using the two-transaction `_getLease()`+`_setLease()`
pattern) has an analogous but self-correcting race — a lost race there
just means a slightly-early heartbeat write is superseded by another
tab's takeover, not a dual-leader state — left out of scope this
iteration. The 10 orphaned label keys, the 829 machine-authored strings
wanting a native pass, and `src/tools/visionscope/*`'s missing i18n all
remain exactly as reported in Iteration 30 — none touched this iteration.

Commits: `8362fd5`.

## Iteration 37 — a dead companion subprocess's stdin write could crash the whole Electron app

**Found.** `electron/companion.js`'s `CompanionBridge.start()` spawns the
Python companion subprocess with `stdio: ['pipe', 'pipe', 'pipe']` and
attaches listeners for `stdout`'s `'data'`, `stderr`'s `'data'`, and the
subprocess's own `'error'`/`'exit'` events — but never an `'error'`
listener on `this._proc.stdin`. `_sendRaw()` (used by every `call()`)
wraps its two `stdin.write()` calls in a `try/catch`, which only catches a
*synchronous* throw. If the subprocess has already died — crashed
externally, or killed in the narrow window before the async `'exit'`
handler fires and nulls `this._proc` — a write to its stdin pipe fails
with EPIPE, and Node surfaces that asynchronously as an `'error'` event on
the stream, not a throw from `write()`. An `EventEmitter` that emits
`'error'` with no listener attached throws by default, which is uncaught
here — crashing the entire Electron main process (every window) over what
should have been one failed companion call. `tests-js/
companionStartupRetry.test.mjs`'s fake process gave `stdin` as a plain
`{ write: () => {} }` object, not an `EventEmitter`, so it couldn't have
exercised this path even incidentally.

**Done.** Added `this._proc.stdin.on('error', (err) => console.warn(...))`
right after spawn, alongside the existing `stdout`/`stderr`/`process`
listeners. Also updated `companionStartupRetry.test.mjs`'s fake `stdin` to
a real `EventEmitter` with a `write` method, matching Node's actual stream
shape — the plain-object fake broke once the new `.on()` call was added,
since it has no `.on()` method.

**Gate.** Added `tests-js/companionStdinError.test.mjs`: mocks `spawn` to
return a fake process with an `EventEmitter`-based `stdin`, starts the
companion successfully, then does `spawnedProcs[0].stdin.emit('error', new
Error('EPIPE...'))` directly — mirroring Node's real
unhandled-stream-error-throws behavior with a plain `EventEmitter`, so if
`companion.js` fails to attach a listener the test itself throws and
fails, no real subprocess or IPC framework required. Mutation-proven:
removed the new listener, reran — failed with the `EPIPE` error itself
propagating out of the test (uncaught), confirming the test genuinely
detects a missing listener; restored, green again. Full `npm run
build-verify` exit 0 (log: `/tmp/gate37.log`). `npm run build:renderer`
was not run — `electron/companion.js` is Electron main-process code, not
`src/`-facing renderer code.

**Still open.** `CompanionBridge`'s other untested lifecycle paths flagged
in Iteration 35 (first-attempt startup success, `stop()`, `_onData`'s
`MAX_COMPANION_MSG_BYTES` frame-desync recovery) remain untouched. The
heartbeat-interval lease race from Iteration 36 and all i18n items from
Iteration 30 are unchanged.

Commits: `6b1dc0e`.

## Iteration 38 — storage.js's get() included missing keys as undefined instead of omitting them

**Found.** `electron/storage.js` is a file-based key-value store explicitly
documented as "replacing chrome.storage.local," with `get`/`set`/`remove`/
`clear` meant to mirror the real extension API. Real
`chrome.storage.local.get()` omits from its result any key that was never
set — it doesn't return `{ key: undefined }`. `storage.js`'s `get()` did
the opposite in both branches: `get('missing')` returned `{ missing:
undefined }` instead of `{}`, and `get(['foo', 'missing'])` returned
`{ foo: 'bar', missing: undefined }` instead of `{ foo: 'bar' }`. Any
caller using `'key' in result` or `Object.keys(result).length` for a
presence check — the idiomatic way to check chrome.storage results — gets
a wrong answer against this shim. `electron/ipc.js` wires `get()` straight
through to the `pfx:storage:get` IPC handler with no adaptation, so the
renderer's storage calls inherit this divergence transparently.

**Done.** Changed both branches of `get()` to only assign into the result
object when the key is actually present in `_cache` (`k in _cache`),
rather than assigning `_cache[k]` unconditionally. `get(null)` (get-all)
was already correct via `{ ..._cache }` and is unaffected.

**Gate.** Added `tests-js/storageGetOmitsMissingKeys.test.mjs`, covering:
a missing single key returns `{}`; a missing key inside a multi-key array
request is dropped while the present key survives; a present single key
still round-trips; `get(null)` still returns the full cache. The test
patches Node's own require cache for the `electron` module id (same
require-cache-patching trick as the companion tests use for
`child_process`) so `storage.js`'s `require('electron')` resolves to a
fake `{ app: { getPath: () => tmpDir } }` instead of the real Electron
binary path string that plain Node returns outside an Electron process.
Mutation-proven: reverted both branches back to unconditional assignment,
reran — two assertions failed showing the literal `undefined`-valued keys
in the actual output; restored, green again. Full `npm run build-verify`
exit 0 (log: `/tmp/gate38b.log`; Python suite 250 passed, 7 skipped).
`npm run build:renderer` was not run — `electron/storage.js` is Electron
main-process code, not `src/`-facing renderer code.

**Still open.** No other methods on `storage.js` were audited for
chrome.storage-parity gaps this iteration (e.g. `remove()`'s and `set()`'s
behavior on non-existent keys were not compared against the real API in
depth). The `folder_picker.py` AppleScript-injection surface flagged
during this iteration's scouting remains unverified and out of scope —
every current call site passes a hardcoded dialog title, so it isn't
known to be exploitable yet.

Commits: `dfd299b`.

## Iteration 39 — storage.js's get() threw on the chrome.storage defaults-object call form

**Found.** `electron/storage.js`'s `get()` handled only two of the three
call forms `chrome.storage.local.get()` supports: a single string key, an
array of keys, or `null`/omitted (get all). The third form — a plain
defaults object, `get({ key: defaultValue, ... })`, where Chrome returns
the stored value if present or the given default otherwise — was not
handled at all. `for (const k of keys)` on a plain object throws
`TypeError: keys is not iterable`. This isn't hypothetical: this exact
call form is used live in `src/tools/bwav/background.js`,
`src/tools/bwav/options.js`, and `src/tools/bwav/app.js`, all shipped into
the desktop app via `build-renderer.js`. Worse, the failure is silent in
practice — `electron/preload.js`'s storage shim wraps the IPC call in
`.catch(() => ({}))`, so the thrown error never surfaces; callers just
silently get `{}` instead of their configured defaults.

**Done.** Added a third branch to `get()`: when `keys` is a plain object
(not `null`, not a string, not an array), iterate `Object.keys(keys)` and
return the stored value for each key if present in `_cache`, else the
caller-supplied default from `keys[k]`.

**Gate.** Extended `tests-js/storageGetOmitsMissingKeys.test.mjs` (the
same file/harness from Iteration 38) with a new case: `get({ foo:
'fallback', missing: 'default' })` against a cache containing only `foo`
returns `{ foo: 'bar', missing: 'default' }`. Mutation-proven: reverted
`get()` back to the two-branch version, reran — the new test failed with
the exact `TypeError: keys is not iterable` reproduction; restored, green
again (5/5). Full `npm run build-verify` exit 0 on the first pass (log:
`/tmp/gate39.log`; Python suite 250 passed, 7 skipped) — no new test file
this time, so the selfContained.test.mjs staging gate that tripped up
Iterations 36 and 38 didn't apply. `npm run build:renderer` was not run —
`electron/storage.js` is Electron main-process code, not `src/`-facing
renderer code.

**Still open.** While auditing this file, `set()` and `remove()` were
re-checked against the real chrome.storage.local contract for
non-existent-key handling (a candidate deferred from Iteration 38) and
found to already match correctly — `remove()` on a missing key is a
harmless no-op via `delete`, and `set()` does a plain per-key merge. That
deferred item is now closed as verified-fine rather than a real gap. The
`folder_picker.py` AppleScript-injection surface remains unverified and
out of scope — every current call site still passes a hardcoded dialog
title.

Commits: `989f9c9`.

## Iteration 40 — pfx:download silently dropped conflictAction, always overwriting on silent writes

**Found.** `electron/preload.js`'s `chrome.downloads.download` shim
accepted a `conflictAction` argument but never forwarded it through
`invoke('pfx:download', ...)` — it was silently dropped at the shim
boundary. Even if it had been forwarded, `electron/ipc.js`'s
`pfx:download` handler's silent-write branch (`saveAs === false`, used
for `dataUrl`-based writes) called `fs.writeFileSync(defaultPath, ...)`
unconditionally, clobbering any existing file at that path regardless of
caller intent. This contradicts the real `chrome.downloads.download()`
API, which defaults `conflictAction` to `'uniquify'` (renaming to
`"name (1).ext"` on a collision) rather than overwriting. Callers in
`render_queue.js` and `visualQcModal/index.js` rely on the default
uniquify behavior to avoid clobbering prior exports; `projectFile.js`
explicitly requests `'overwrite'` for save-over-existing semantics — with
the old code both cases behaved identically (silent overwrite), so a
uniquify request was silently downgraded to overwrite with no error and
no way to detect data loss.

**Done.** Forwarded `conflictAction` through the `preload.js` shim.
Added a `_uniquifyPath()` helper in `ipc.js` that walks
`"name (1).ext"`, `"name (2).ext"`, ... until it finds a path that
doesn't exist, and used it for the silent-write `dataUrl` branch unless
`conflictAction === 'overwrite'` is explicitly passed.

**Gate.** New `tests-js/downloadConflictAction.test.mjs`, following the
same fake-`electron`-module require-cache-injection pattern as
`storageGetOmitsMissingKeys.test.mjs` and `companionStartupRetry`.
Two cases: (1) writing the same filename twice with default
`conflictAction` produces `note.txt` then `note (1).txt`, and both files'
original contents survive untouched; (2) writing the same filename twice
with `conflictAction: 'overwrite'` reuses the same path and the second
write's content wins. Mutation-proven: this segment discovered
`electron/preload.js` and `electron/ipc.js` also carry substantial
unrelated in-progress work (a Meechum/Edward enterprise OAuth flow, PFX
session-storage sync IPC, a window-reactivation guard refactor, OCF proxy
media calls) that predates this iteration and must not be attributed to
this commit — most of this iteration's time went into surgically
isolating the scoped fix from that WIP using `git hash-object -w` +
`git update-index --cacheinfo` (reconstructing "HEAD + only my edit" off
disk) rather than `git add`, which would have swept the whole
working-tree file into the commit. Full `npm run build-verify` exit 0
against the true full working-tree state (WIP + fix combined; log:
`/tmp/gate40c.log`; Python suite 250 passed, 7 skipped). `npm run
build:renderer` was not run — both files are Electron main-process code,
not `src/`-facing renderer code.

**Still open.** The `webContents.downloadURL(url)` path (used when no
`dataUrl` is supplied) still can't honor `conflictAction` at all — Electron's
native download manager doesn't expose a pre-write collision hook without
wiring up `session.on('will-download')`, which nothing in the codebase
currently does; this is unchanged and out of scope. The large in-progress
WIP discovered in `electron/preload.js`/`electron/ipc.js` this iteration
(Meechum/Edward OAuth, PFX session sync, `_activeWindow` guard, OCF proxy)
remains untouched, uncommitted, and out of scope — it's real, in-progress
work already relied upon by at least one existing test, not dead code.

Commits: `65e6e9a`.

## Iteration 41 — otio.js's getTimeWarpInfo() latched `reversed`, mis-signing stacked double-negative retimes

**Found.** `src/scripts/parsers/otio.js`'s `getTimeWarpInfo()` loops over
an OTIO clip's effects list accumulating `scalar *= Math.abs(ts)` for
each `LinearTimeWarp`, but set `reversed = true` unconditionally on any
negative `time_scalar` rather than toggling it. A clip with two stacked
`LinearTimeWarp` effects that are both negative (e.g. `-1.0` then `-2.0`
— a net-forward 2x retime, since two reversals cancel out) was reported
as reversed at 2x (`speedFactor: -200`) instead of forward at 2x
(`speedFactor: 200`), inverting the reported playback direction and sign
of the speed. Resolve and Avid can emit chained/stacked `LinearTimeWarp`
effects on nested or compound retimes, so this is reachable from real
NLE-exported OTIO, not a synthetic edge case.

**Done.** Changed `if (ts < 0) reversed = true;` to
`if (ts < 0) reversed = !reversed;` so each negative scalar flips the
sign rather than latching it permanently on.

**Gate.** New fixture `test/fixtures/resolve_double_reverse.otio`: one
clip with two `LinearTimeWarp` effects, `time_scalar` -1.0 then -2.0.
New case in `test/parsers/otio.test.mjs` asserting the single resulting
event has `speedFactor: 200` (forward 2x), not `-200`. Mutation-proven:
reverted to the unconditional-`true` version, reran — failed with
`-200 !== 200`, the exact bug reproduction; restored, green again (4/4
in `test/parsers/otio.test.mjs`). Full `npm run build-verify` exit 0
(log: `/tmp/gate41.log`; Python suite 250 passed, 7 skipped). Since this
touches `src/` renderer source, also ran `npm run build:renderer`
(exit 0, 377 files rebuilt into `dist/desktop/`) per CLAUDE.md.
Normalized `test/parsers/otio.test.mjs`'s file mode back to 644 before
committing — it had picked up an executable bit from the pre-existing
repo-wide ~576-file mode anomaly (Audit 32), unrelated to this fix, so
that bit was excluded from this commit's diff.

**Still open.** The `resolve_double_reverse.otio` case only covers two
stacked negatives; three or more stacked `LinearTimeWarp` effects (or a
mix of positive and negative scalars in longer chains) weren't
specifically tested, though the XOR fix generalizes correctly by
construction. The dedup-key gap flagged during this iteration's scouting
(`otio.js`'s final dedup step omitting `srcIn`/`srcOut` from its key,
around line 846) was not pursued — the surrounding comment states the
conservative dedup is intentional, so it needs a design decision rather
than a drive-by fix. A latch bug in `electron/native/pfx_native_engine.js`'s
`NativeEngineManager.start()`/`stop()` (`_startAttempted` never resets)
was also flagged but confirmed unreachable in the current call graph —
`stop()` is only invoked from `app.on('will-quit')` today — so it's
deferred as a real-but-dormant issue.

Commits: `f1709b3`.

## Iteration 42 — media_engine.js's seek() used the exact NTSC fps instead of the nominal rate for timecode-to-frame conversion

**Found.** `electron/native/media_engine.js`'s `seek()` converts an
`HH:MM:SS:FF` timecode to a frame count with
`(h*3600 + m*60 + sec) * s.info.fps + f`, using `s.info.fps` — the exact
probed frame rate (e.g. `23.976023976...` for NTSC footage) — directly.
HH:MM:SS:FF counting must use the *nominal* (rounded) rate for the
`H:M:S` portion, per the same "two-rate contract" documented in
`src/scripts/modules/utils_time.js`'s `nominalBase()` and fixed for
`otio.js` in Iteration 41. Seeking to `01:00:00:00` on 23.976fps footage
landed on frame 86314 instead of 86400 — an 86-frame-early seek.

**Done.** Rounded the fps at the call site:
`const nominalFps = Math.round(s.info.fps) || 24;`, then multiplied by
`nominalFps` instead of `s.info.fps`. `media_engine.js` is plain
CommonJS (Electron main process) and can't `require()` the ESM
`nominalBase()` from `utils_time.js`, so this inlines the same rounding
rule, matching the existing precedent in `electron/ipc.js`
(`const r = Math.round(fps);`).

**Gate.** New test `tests-js/mediaEngineSeekNominalFps.test.mjs`: injects
fake `electron` and `child_process` modules into Node's require cache
(same trick as `tests-js/downloadConflictAction.test.mjs`) so
`media_engine.js` loads outside Electron, with `child_process.spawn`
mocked to return a fake `avf_bridge` process reporting a canned
23.976023976023978fps. Opens a real session via the module's own
`open()`, then asserts `seek({ timecode: '01:00:00:00' })` returns frame
86400 (nominal 24fps), not 86314 (exact-rate bug). Mutation-proven:
reverted to `s.info.fps`, reran — failed with
`86314 !== 86400 seek must use nominal fps (24)...`, the exact bug
reproduction; restored, green again. Full `npm run build-verify` exit 0
(log: `/tmp/gate42.log`). Because `media_engine.js` is Electron
main-process code, not `src/`-facing renderer source, `build:renderer`
was not needed for this iteration.

**Still open.** `electron/native/media_engine.js`'s working tree contains
substantial pre-existing uncommitted WIP (`getOcfProxy()`/
`getOcfProxyStatus()` — a "Problem 2" full-range OCF proxy render
feature delegating to the companion, wired into `HANDLED`/`route()`/
`module.exports`) that predates this iteration and is unrelated to the
`seek()` fix; it was excluded from this commit via the same
git-surgery blob-reconstruction technique used in Iterations 39/40, and
remains untouched, uncommitted, and out of scope. The deferred `otio.js`
dedup-key gap and `pfx_native_engine.js` start/stop latch (Iteration 41)
are also unchanged.

Commits: `b60fd20`.

## Iteration 43 — companion `_ocf_write_files` path-traversal guard was a naive string prefix check

**Found.** `companion/src/postflowx_companion/api.py`'s `_ocf_write_files`
(the `ocfWriteFiles` handler that writes renderer-supplied FDL/AMF/QC text
files under an `outputDir`) rejected escaping paths with
`abs_path.startswith(os.path.normpath(output_dir))`. That's a character
prefix test, not a directory-boundary test: for `outputDir = "/out"`, the
sibling path `"/out-evil"` also satisfies `.startswith("/out")`. A
renderer-supplied `files[].path` of `"../out-evil/evil.txt"` — the same
untrusted editorial-derived-filename input class `_ocf_copy_exr_delivery`
already treats as untrusted — normalizes to exactly that sibling path and
sailed past the guard, writing arbitrary content outside the intended
delivery folder.

**Done.** Replaced the `startswith` check with `_confined_join` (already
defined in this file at module scope and already used by
`_ocf_copy_exr_delivery` for the identical threat model), which does a
real `os.path.commonpath` containment check on `os.path.realpath` results
instead of a raw string comparison.

**Gate.** New `companion/tests/test_ocf_write_files.py`: instantiates
`CompanionApi` via `__new__` (skips `__init__`'s HTTP server/thread
startup — the method under test only touches `self.config`) and calls
`_ocf_write_files` directly. One test asserts a `../ShowA-evil/evil.txt`
path is rejected and nothing is written to the sibling directory; a
second asserts a legitimate nested relative path (`QC/report.txt`) still
writes correctly. Mutation-proven: reverted to the `startswith` check,
reran — the traversal test failed by actually finding the file written at
`.../ShowA-evil/evil.txt` outside the tmp `outputDir`, the exact exploit
reproduced on disk; restored, both tests green again. Full
`npm run build-verify` exit 0 (log: `/tmp/gate43.log`), including all 259
companion pytest cases (252 passed, 7 skipped) and the XSS/XXE/fail-open
scan gates. `api.py` is Python companion-server code, not `src/`-facing
renderer source, so `build:renderer` was not needed for this iteration.

**Still open.** Three prior scouting rounds over `src/`'s JS renderer
code (`src/scripts/core/*`, `utils_time.js`, `imf_j2k.js`,
`projectFile.js`, `amf_convert.js`, `imf_player.js`, `i18n.js`,
`crossTabQueueLease.js`, `playbackRouter.js`, `timelineModel.js`,
`watchFolder/*`, `reviews/*`, `eventDuration.js`, `nuke_import_script.js`,
`smart_engine_settings.js`, `aaf_worker.js`, `j2kCodestream.js`) found
nothing further — that surface is now considered heavily picked-over.
This iteration pivoted to the previously-unexplored Python companion
package; `_ocf_write_files` was the one write path in `api.py`'s delivery
family using the broken check — the other OCF write/copy paths already
use `_confined_join`/`_safe_name_component` correctly. `api.py` is 7191
lines and was read in full by the scouting agent, but the rest of the
companion package (`companion/src/postflowx_companion/` beyond `api.py`,
`color/aces2_luts.py`) has not yet been swept. The deferred `otio.js`
dedup-key gap and `pfx_native_engine.js` start/stop latch (Iteration 41)
are also unchanged.

Commits: `9cc68e9`.

## Iteration 44 — cutdiff.js `tcToFrames` dropped every drop-frame timecode to 0

**Found.** `src/scripts/modules/cutdiff.js`'s own `tcToFrames` (the Cut
Diff engine's timecode-to-frames helper, used on `srcIn`/`srcOut`/
`recIn`/`recOut` inside `evFrames`) split the timecode string only on
`':'`. Every other timecode parser in this codebase (`utils_time.js`'s
canonical `tcToFrames`, `edl.js`, `xml.js`, `ale.js`) normalizes
drop-frame `';'` separators to `':'` first, since a drop-frame EDL leaves
fields like `"01:00:00;15"` in place. Splitting that string on `':'`
alone yields 3 parts instead of 4, tripping the `parts.length !== 4`
guard and silently returning 0 — for every in/out point on a DF clip.

**Done.** Added the same `.replace(/;/g, ':')` normalization already used
by `utils_time.js`'s implementation, before the `.split(':')` call.

**Gate.** New `tests-js/cutdiff_dropframe_tc.test.mjs` (the existing
`tests-js/cutdiff.test.mjs` is part of the large pre-existing uncommitted
WIP surface and is off-limits, so this iteration's regression test lives
in its own new file): asserts a `;`-separated DF timecode parses
identically to its `:`-separated NDF equivalent, on both the hour field
and a non-hour field; asserts empty/malformed timecodes still safely
return 0; and an end-to-end `computeCutDiff` case asserts a DF-timecoded
clip that grew in duration still classifies as `EXTENDED`, not
`UNCHANGED`. Mutation-proven: reverted the normalization, reran — 3 of 5
assertions failed (the DF-parsing pair and the end-to-end classification),
confirming the test actually exercises the bug; restored, all 5 green.
Full `npm run build-verify` exit 0 (log: `/tmp/gate44.log`), including all
259 companion pytest cases (unaffected, unchanged) and the XSS/XXE/
fail-open scan gates. This iteration touches `src/`-facing renderer code,
so `npm run build:renderer` was also run and succeeded (log:
`/tmp/buildrenderer44.log`, 377 files rebuilt into `dist/desktop/`).

**Still open.** The rest of the companion Python package beyond `api.py`
(`companion/src/postflowx_companion/` submodules, `color/aces2_luts.py`)
remains unswept, as flagged in Iteration 43. `cutdiff.js`'s sibling
`framesToTc` (the inverse conversion) was read but not found to have an
equivalent bug — it's fed exclusively by `tcToFrames`'s own numeric
output, not raw timecode strings, so the DF-separator class doesn't apply
to it. The deferred `otio.js` dedup-key gap and `pfx_native_engine.js`
start/stop latch (Iteration 41) are also unchanged.

Commits: `768c174`.

## Iteration 45 — filters.js tcToFrames dropped every drop-frame-timecoded event from the pipeline

**Found.** `src/scripts/modules/filters.js` has its own local `tcToFrames`,
written independently of `cutdiff.js`'s (just fixed in Iteration 44) and
the canonical one in `utils_time.js`. It parsed timecodes with a regex
matching only `:` separators, so a drop-frame EDL's `"HH:MM:SS;FF"` fields
(as `edl.js` correctly preserves them) never matched and silently returned
`0`. Every function in this file shares that one helper — `dedupeBySrcRange`,
`onlyVfxMarker`, `mergeOverlap`, `addExtraHandlesForFastClips`, and
`filterValidTimecode` — and `filterValidTimecode`'s zero-length check
(`soF <= siF || roF <= riF`) then treats the resulting `0/0` pair as an
invalid, zero-length event and drops it. Net effect: importing any
drop-frame source EDL silently discarded every one of its events from
`runPipeline()`'s output, with no error surfaced.

**Done.** Normalized `;` to `:` before the regex match in `tcToFrames`,
mirroring the pattern from `utils_time.js` and the Iteration 44 fix. New
dedicated test file `tests-js/filters_dropframe_tc.test.mjs` (the existing
`tests-js/filters.test.mjs` and `filtersVfxRename.test.mjs` are both
dirty/off-limits): 4 assertions — a valid DF-timecoded event survives
`filterValidTimecode`, the NDF equivalent still survives, a genuinely
zero-length DF event is still correctly dropped, and a malformed timecode
is still safely dropped rather than crashing. Mutation-proven: reverted the
normalization, reran — exactly 1 of 4 failed (the DF-survival case), the
other 3 correctly unaffected; restored, all 4 green.

**Gate.** Full `npm run build-verify` exit 0 on the first run (log:
`/tmp/gate45.log`), including all 259 companion pytest cases (unaffected)
and the XSS/XXE/fail-open scan gates. Since this touches `src/`-facing
renderer code, `npm run build:renderer` was also run and succeeded (log:
`/tmp/buildrenderer45.log`, 377 files rebuilt into `dist/desktop/`).

**Still open.** The rest of the companion Python package beyond `api.py`
remains unswept, as flagged in Iterations 43–44. This is now the second
independently-implemented `tcToFrames` found with this exact bug class in
two iterations — worth a future pass to check whether any other module in
`src/scripts/` (beyond the four already confirmed correct: `utils_time.js`,
`edl.js`, `xml.js`, `ale.js`, and now `cutdiff.js`/`filters.js` fixed) has
its own uncoordinated timecode parser. The deferred `otio.js` dedup-key gap
and `pfx_native_engine.js` start/stop latch (Iteration 41) are unchanged.

Commits: `b5db764`.

## Iteration 46 — amf_convert.js's three separate tcToFrames copies all dropped drop-frame timecodes to 0

**Found.** `src/scripts/modules/amf_convert.js` doesn't have one local
`tcToFrames` — it has three, independently written: one at module scope
(feeds the master-mode Nuke segment builder), one embedded in the returned
text of `__buildAEPCommonJSX` (feeds `addTimingMarkers` and a per-shot AE
segment builder), and one embedded in the generated `.jsx` text inside
`exportAEJSX` (feeds the same timing logic once it's actually running
inside After Effects/ExtendScript). All three used the same `:`-only regex
as the bugs fixed in Iterations 44–45. `edl.js`'s timecode regex
(`/\b\d{2}[:;]\d{2}[:;]\d{2}[:;]\d{2}\b/g`, confirmed by direct read this
iteration) accepts `;` in every field and hands `recIn`/`recOut` through
verbatim with no normalization, so a drop-frame EDL's hits carry
`"HH:MM:SS;FF"` straight into `amf_convert.js`. Every one of these three
`tcToFrames` copies then returned `0` for real DF timecodes, collapsing
VFX comp segments (master-mode Nuke export, ~line 6851) and After Effects
timing markers/segments (~line 4604 and ~line 4810) to zero-length or
zero-position — silently, with no error surfaced.

**Done.** Normalized `;` to `:` before the regex match in all three
`tcToFrames` definitions, including the one embedded in `exportAEJSX`'s
doubly-escaped (`\\d`) template-literal text, where the fix has to be
applied to the pre-unescape source form to survive being written out
as ExtendScript. New dedicated test file
`tests-js/amfConvert_dropframe_tc.test.mjs` (the module can't be
`import()`'d under Node — it calls `document.addEventListener` at module
scope — so each `tcToFrames` body is extracted as text and executed via
`new Function`, mirroring the existing pattern in `saveOutcome.test.mjs`):
10 assertions covering all three definitions × (NDF still works, DF now
converts instead of silently returning 0, malformed input still safely
returns 0). Mutation-proven: reverted all three normalizations, reran —
exactly 3 of 10 failed (one DF-specific assertion per definition, byte-
identical revert confirmed via `git diff --stat`), the other 7 correctly
unaffected; restored from backup, all 10 green again.

**Gate.** Full `npm run build-verify` exit 0 on the first run (log:
`/tmp/gate46.log`), including all 259 companion pytest cases (unaffected)
and the XSS/XXE/fail-open scan gates. Since this touches `src/`-facing
renderer code, `npm run build:renderer` was also run and succeeded (log:
`/tmp/buildrenderer46.log`, 377 files rebuilt into `dist/desktop/`).

**Still open.** This is now the THIRD consecutive iteration to find the
same drop-frame-separator bug class in a different, independently-written
`tcToFrames`/timecode parser (`cutdiff.js` in Iteration 44, `filters.js`
in Iteration 45, and three separate copies inside `amf_convert.js` this
iteration). That pattern is strong enough now to warrant a dedicated
sweep — rather than opportunistic discovery — of every remaining
timecode-parsing regex across `src/scripts/` and `postflowx-adobe/` in a
near-future iteration, specifically grepping for `\d+\):(\\+\d+):` or
similar `:`-only timecode-splitting patterns that haven't yet been cross-
checked against `utils_time.js`'s canonical normalize-then-split approach.
The rest of the companion Python package beyond `api.py` remains unswept,
as flagged in Iterations 43–45. The deferred `otio.js` dedup-key gap and
`pfx_native_engine.js` start/stop latch (Iteration 41) are unchanged.

Commits: `0854119`.

## Iteration 47 — timelineAutoInject.js's timecode regexes dropped drop-frame timecodes from the auto-injected timeline strip

**Found.** `src/scripts/features/edl/timelineAutoInject.js` auto-injects a
Timeline Strip UI above the EDL Converter Event Table. Its `TC_EXACT_RE`,
`TC_FIND_RE`, and `extractFirstTc()` all matched only `"HH:MM:SS:FF"`, and
a separate inline regex in `extractClips()`'s LOC-column fallback had the
same gap. `edl.js`'s own timecode regex
(`/\b\d{2}[:;]\d{2}[:;]\d{2}[:;]\d{2}\b/g`) accepts `;` in every field and
hands `recIn`/`recOut` through verbatim, so a drop-frame EDL's Event Table
cells read `"HH:MM:SS;FF"`. `extractFirstTc()` then found no match,
`tcToFrames()` returned `NaN`, and both `extractClips()` (which uses
`tcToFrames` on the Rec In/Out columns as its highest-priority timing
source, ~line 246-248) and `guessTimecodesFromRow()` (heuristic row
matching, lines 161-179) silently dropped or mis-positioned every DF row
from the injected timeline strip. This is the FOURTH consecutive
iteration to find the same drop-frame-separator bug class in a different,
independently-written timecode parser (`cutdiff.js` Iteration 44,
`filters.js` Iteration 45, `amf_convert.js`'s three copies Iteration 46,
now `timelineAutoInject.js`'s four spots this iteration).

**Done.** Widened all four regexes to accept `:` or `;` via `[:;]`
character classes (rather than a `.replace(/;/g, ':')` normalization
step, since these regexes serve dual purposes — both "does this look
like a timecode" detection and value extraction — making in-place
widening cleaner here than at `cutdiff.js`/`filters.js`/`amf_convert.js`'s
several call sites). New dedicated test file
`tests-js/timelineAutoInject_dropframe_tc.test.mjs`: the module imports
cleanly under Node (its `document`/`window` access is wrapped in
`try { boot(); } catch (e) {}`) but exposes zero exports, so
`tcToFrames`/`extractFirstTc`/`collectTcs` are extracted together as one
contiguous text block (they're mutually dependent) and evaluated via
`new Function`, mirroring the `amf_convert.js` test pattern. 5 assertions
covering NDF parity, DF conversion, malformed-input safety,
`extractFirstTc` on embedded text, and `collectTcs` finding all DF hits
in a row. Mutation-proven: reverted all four regexes to the original
`:`-only form (byte-identical revert confirmed via `git diff --stat`),
reran — exactly 3 of 5 failed (the DF-specific ones), the NDF-parity and
malformed-input assertions correctly unaffected; restored from backup,
5/5 green again.

**Gate.** Full `npm run build-verify` exit 0 (log: `/tmp/gate47.log`),
including all 259 companion pytest cases (unaffected; 252 passed, 7
skipped) and the XSS/XXE/fail-open scan gates. Since this touches
`src/`-facing renderer code, `npm run build:renderer` was also run and
succeeded (log: `/tmp/buildrenderer47.log`, 377 files rebuilt into
`dist/desktop/`).

**Still open.** Four consecutive iterations finding the same bug class
in four different, independently-written parsers is a strong enough
signal that a dedicated, exhaustive sweep (rather than continued
opportunistic discovery) of every remaining timecode-parsing regex
across `src/scripts/` and `postflowx-adobe/` is likely the highest-value
next iteration, specifically grepping for `:`-only timecode-splitting
patterns not yet cross-checked against `utils_time.js`'s canonical
normalize-then-split approach. Modules already confirmed correct:
`utils_time.js`, `edl.js`, `xml.js`, `ale.js`, `cutdiff.js`, `filters.js`,
`amf_convert.js`, and now `timelineAutoInject.js`. The rest of the
companion Python package beyond `api.py` remains unswept, as flagged in
Iterations 43–46. The deferred `otio.js` dedup-key gap and
`pfx_native_engine.js` start/stop latch (Iteration 41) are unchanged.

Commits: `8d1aefa`.

## Iteration 48 — _probe_ocf_file truncated fractional camera fps, drifting tc_out by real seconds

**Found.** `companion/src/postflowx_companion/api.py`'s `_probe_ocf_file`
(an ffprobe-based OCF metadata extractor used by the VFX Pull manual-relink
flow) computed its `tc_out` field with local `_tc2f`/`_f2tc` helper functions
that used `int(fps)` as the frame-counting divisor. For the most common
professional cinema camera rates — 23.976, 29.97, 59.94fps — `int()`
truncates to 23/29/59 instead of rounding to the nominal whole-frame base
(24/30/60), the long-established convention in this codebase. This is a
*different but related* bug class from Iterations 44-47's drop-frame
separator bugs: it's about the frame-rate divisor's rounding direction, not
timecode string parsing. `utils_time.js`'s `nominalBase()` documents a prior
real incident of this exact class: `tcToFrames('01:00:00:00', 23.976)`
returned `86313` instead of `86400` — a one-hour timecode coming back 87
frames (3.6 seconds) short of itself. Concrete drift verified for
`_probe_ocf_file`: `tc_in="01:00:00:00"`, `nb_frames=1000`, `fps=23.976` →
buggy `tc_out="01:00:43:11"` vs correct `"01:00:41:16"` (~2 seconds off) —
this app's primary use case is OCF (Original Camera Files), so this is not
an edge case.

**Done.** `api.py` already has correct, independently-tested module-level
`_tc_to_frames`/`_frames_to_tc` functions (used by `_resolve_clip_metadata`,
proven correct at `fps=23.976` by an existing passing test in
`test_resolve_probe_clips.py`) that round fps internally via
`int(round(fps))`. Rather than patch the local `_tc2f`/`_f2tc` reimplementation
in place, deleted it entirely and delegated to the existing correct
functions — fixing the bug at its root instead of leaving a second,
independently-maintained copy of the same logic in the file. New test:
`companion/tests/test_probe_ocf_tc_out.py`. `_probe_ocf_file` accepts an
explicit `ffprobe_path` override, so the test mocks `subprocess.run` to
return a synthetic ffprobe JSON payload (fractional `r_frame_rate`, a
`timecode` tag, `nb_frames`) and calls `_probe_ocf_file` directly via
`CompanionApi.__new__(CompanionApi)` (the method doesn't touch `self`, so
this avoids spinning up the real constructor's HTTP server/threads). Three
cases: 23.976fps and 29.97fps (must hit the fix) plus a plain 24fps control
(identical either way, confirms the fix is a no-op for integer rates).
Mutation-proven: reverted to the local `int(fps)` helpers, reran — both
fractional-fps cases failed with the exact drifted values shown above
(`01:00:43:11` / `01:00:34:14`), the integer-fps control still passed;
restored from backup (byte-identical via `diff`), 3/3 green again.

**Gate.** Full `npm run build-verify` exit 0 (log: `/tmp/gate48.log`),
including all 262 companion pytest cases (255 passed, 7 skipped) and the
XSS/XXE/fail-open scan gates. Python-only change — no `src/`-facing renderer
code touched — so `npm run build:renderer` was not run.

**Still open.** This is the first instance of the "nominal frame-rate base"
bug class found; unlike the drop-frame-separator class (Iterations 44-47,
now exhausted among git-clean files), it's unclear how many other spots in
the companion Python package or `src/scripts/` might independently
reimplement timecode-frame conversion with a truncating `int(fps)` instead
of a rounding one — worth a dedicated grep sweep next, specifically for
`int(fps)` / `int(some_fps_var)` patterns feeding frame-count arithmetic,
analogous to the sweep already done for `:`-only timecode regexes. The rest
of the companion Python package beyond `api.py` remains largely unswept
(flagged in Iterations 43-48). The deferred `otio.js` dedup-key gap and
`pfx_native_engine.js` start/stop latch (Iteration 41) are unchanged and
still off-limits (dirty file) for the latter.

Commits: `98e0dd2`.

## Iteration 49 — xml.js Scale X/Scale Y wrongly also set the uniform transform.scale

**Found.** `src/scripts/parsers/xml.js`'s `extractFxFromClipitem` parses a
clip's `Basic Motion` filter parameters into a `transform` object. Each
`<parameter>`'s lookup key is `parameterid` if present, else falls back to
the lowercased `<name>` text. The generic/uniform-scale branch guards
against double-handling axis-specific parameters via
`key.includes('scale') && !key.includes('scalex') && !key.includes('scaley')`
— but the axis-specific branches immediately below it recognize BOTH the
unspaced form (`'scalex'`/`'scaley'`, from a `<parameterid>` tag) and the
*spaced* form (`'scale x'`/`'scale y'`, from a `<name>Scale X</name>`/
`<name>Scale Y</name>` tag with no `<parameterid>`). `"scale x".includes('scalex')`
is `false` — there's no contiguous `"scalex"` substring across the space —
so the exclusion silently never fires for real-world XMEML files using the
spaced `<name>`-only form. A Scale X/Scale Y parameter then wrongly set
BOTH `transform.scaleX`/`scaleY` (correct, per-axis) AND `transform.scale`
(the uniform field, which should only ever come from a true `Scale`
parameter) — corrupting downstream consumers that read `transform.scale` as
"this clip is uniformly scaled."

**Done.** Added an explicit `key !== 'scale x' && key !== 'scale y'` clause
to the generic-scale branch's guard, so the spaced axis-specific keys are
excluded exactly like their unspaced counterparts already were. New test:
`test/parsers/xml_scale_axis.test.mjs`. `parseXMEML` is `xml.js`'s only
export, so the test builds a minimal synthetic XMEML string (one
`clipitem` with a `Basic Motion` filter and a single parameter) and asserts
through the real parser rather than calling the private, unexported
`extractFxFromClipitem` directly. Three cases: a `Scale X` parameter (must
set `scaleX` only), a `Scale Y` parameter (must set `scaleY` only), and a
plain `Scale` parameter as a control (must still set the uniform `scale`
field, confirming the fix didn't disable the intended generic case).
Mutation-proven: reverted to the original unguarded condition, reran — the
Scale X/Scale Y cases failed with `transform.scale` wrongly set (`150`/`75`
instead of `undefined`), the plain-`Scale` control still passed; restored
from backup (byte-identical via `diff`), 3/3 green again.

**Gate.** Full `npm run build-verify` exit 0 (log: `/tmp/gate49.log`),
including the new test's assertions and all pre-existing suites unaffected.
This is a `src/`-facing renderer change, so `npm run build:renderer` was
also run afterward to regenerate `dist/desktop/` (377 files, git-ignored,
not committed).

**Still open.** This same spaced-vs-unspaced substring mismatch pattern
(`<name>`-only fallback keys containing a space where the `parameterid`
form would not) may exist for other axis-pair parameters in `xml.js`
(e.g. Center/Position, Rotation, Crop) — not yet swept. The rest of the
companion Python package beyond `api.py` remains largely unswept (flagged
in Iterations 43-48). The "nominal frame-rate base" `int(fps)` grep sweep
flagged in Iteration 48 is still pending, and its two known instances
(`standard_media_backend.py`, `aaf_export.py`) remain off-limits (dirty
files). The deferred `otio.js` dedup-key gap and `pfx_native_engine.js`
start/stop latch (Iteration 41) are unchanged and still off-limits (dirty
file) for the latter.

Commits: `739ac3a`.

## Iteration 50 — filters.js frame math used raw fps instead of nominal base

**Found.** `src/scripts/modules/filters.js`'s internal `tcToFrames`/
`framesToTC` helpers (used throughout the file's exported pipeline —
`decomposeEvents`, `mergeOverlap`, `onlyVfxMarker`, `filterValidTimecode`,
etc.) divided by the raw event `fps` directly as the frame-counting base.
Every sibling timecode module already normalizes fractional camera frame
rates (23.976, 29.97, 59.94) to their nominal whole-frame base first via
`nominalBase()` (`utils_time.js`) — confirmed in `eventDuration.js`,
`edl_export.js`, `cutdiff.js`, and `utils_time.js` itself — but
`filters.js` was the one clean-file outlier still using raw `fps`. AAF
imports attach a raw fractional EditRate to each event (e.g.
`24000/1001 = 23.976023976023976...`), so `framesToTC(30,
23.976023976023976...)` computed `30 % 23.976023976023976... =
6.023976023976024`, producing the malformed timecode
`"00:00:01:6.023976024"` instead of `"00:00:01:06"`. Downstream,
`mergeOverlap` comparing a computed boundary against the next clip's
literal `recIn` failed to match, because `tcToFrames` can't parse the
malformed fractional frame field (its `\d+` group requires an integer) and
silently falls back to `0`.

**Done.** Added `import { nominalBase } from './utils_time.js';` and
applied `nominalBase(fps)` as the divisor/modulus base in both
`tcToFrames` and `framesToTC`, matching the sibling-module convention.
New test: `tests-js/filters_fractional_fps.test.mjs`. Two cases: (1)
`onlyVfxMarker` with a marker's `inFrames` offset (the AAF/FCPXML marker
timecode path, since `framesToTC` isn't exported directly) asserts the
resulting `recIn` is a well-formed 2-digit frame field at
`fps = 24000/1001`; (2) `mergeOverlap` takes the real `framesToTC`-computed
boundary from case (1)'s marker output and checks it still merges with a
literal, independently-written timecode for the same frame — this is
deliberately NOT two identical literal strings (an earlier draft that
compared `cur.recOut === next.recIn` as the same literal string passed
even on the buggy code, since both sides ran through the exact same
formula and landed on the same fractional value; only forcing one side
through the actual `framesToTC` computation exposes the malformed-string
mismatch).

**Gate.** Full `npm run build-verify` exit 0, including the new tests and
all pre-existing `test:node`/`test:js`/`test:py`/XSS/XXE/fail-open suites
unaffected. This is a `src/`-facing renderer change, so
`npm run build:renderer` was also run afterward to regenerate
`dist/desktop/` (377 files, git-ignored, not committed).

**Still open.** The scout report that surfaced this bug cited
`src/scripts/modules/workers/aaf_worker.js:559,785` and
`src/scripts/parsers/aaf_wasm.js:39,48,62` as computing/propagating the raw
fractional `fps`/`evFps` value (`er.n / er.d`) without rounding — this was
not independently re-verified this iteration (only `filters.js` itself
was) and should be confirmed before treating those line references as
authoritative. The "nominal frame-rate base" `int(fps)` grep sweep flagged
in Iteration 48 is still pending, with its two known Python instances
(`standard_media_backend.py`, `aaf_export.py`) remaining off-limits (dirty
files). Iteration 49's spaced-axis-key sweep (Center/Position, Rotation,
Crop in `xml.js`) is still unswept. The deferred `otio.js` dedup-key gap
and `pfx_native_engine.js` start/stop latch (Iteration 41) are unchanged
and still off-limits (dirty file) for the latter.

Commits: `f0bf7d7`.

## Iteration 51 — 23.976fps OCF clips got semicolon drop-frame timecode instead of colon non-drop

**Found.** `companion/src/postflowx_companion/api.py` had two call sites
that decided drop-frame timecode formatting via
`fps in (29.97, 59.94, 23.976)`. Drop-frame is a SMPTE convention that
only applies to the 30-based NTSC rates (29.97/59.94), where whole-frame
counting drifts from wall-clock time fast enough to require periodic
frame-number skipping — 23.976 has no drop-frame variant at all and
always uses non-drop (colon-delimited) timecode, per this project's own
`src/scripts/modules/utils_time.js` (`{ fps: 23.976, dfCapable: false }`
vs. `{ fps: 29.97, dfCapable: true }`). One site built the OCF preview/seek
timeline TC (`target_tl_tc = _seconds_to_timecode(tl_start_sec + rel_sec,
fps, drop_frame)`); the other set `_drop` in the batch-pick resolve path.
At 23.976fps both produced a malformed semicolon TC (e.g. `"01:00:00;19"`)
instead of the correct `"01:00:00:19"`, which DaVinci Resolve's
Set/GetCurrentTimecode on a non-drop timeline will not round-trip.

**Done.** Added a shared `_is_drop_frame_rate(fps)` helper to
`proxy_service.py`, using the same tolerance-based comparison
(`abs(fps - 29.97) < 0.02`, `abs(fps - 59.94) < 0.02`) already established
in `aaf_export.py` for exactly this reason (avoiding fragile exact-float
equality against literals like `29.97`). Updated both `api.py` call sites
(`drop_frame = ...`, `_drop = ...`) to use it instead of the inline
exact-set-membership check. New test: `companion/tests/test_drop_frame_rate.py`
— existing candidate test files (`test_ocf_seek_tc.py`, `test_tc_helpers.py`)
were pre-existing dirty/off-limits WIP, so a new file was created instead.

**Gate.** Full `npm run build-verify` exit 0: companion pytest 259
passed/7 skipped (up from 255/7, the 4 new tests), Node `test:node`/
`test:js` suites unaffected, all three security gates (XSS/XXE/fail-open)
clean. This is a companion-only (Python) change with no `src/` edits, so
`npm run build:renderer` was not required.

**Still open.** `_drop` in the batch-pick function (`api.py` around line
4057) appears to be assigned but never read afterward in that code path
(confirmed via grep — no further reference in the enclosing function);
this pre-existing oddity was left untouched as out of scope for this fix.
Iteration 48's `int(fps)` sweep, Iteration 49's spaced-axis-key sweep, the
`aaf_worker.js`/`aaf_wasm.js` raw-EditRate citations from Iteration 50, and
the deferred `otio.js`/`pfx_native_engine.js` items all remain pending.

Commits: `fc04c95`.

## Iteration 52 — bwav audio-scan reported clip/hit positions from the wrong window

**Found.** `runAudioScanQuick()` in `src/tools/bwav/app.js` bounds scan
time on large PCM WAV/BWF files by sampling only a bounded "start" window
and, for large files, a second physically disjoint "end" window near the
tail — skipping the middle entirely (`MAX_BYTES = 40 * 1024 * 1024`,
`half = Math.floor(MAX_BYTES / 2)`). A single `scannedFrames` counter,
incremented contiguously across both windows, was reused both as "total
frames sampled" (correct, feeds `scannedSeconds`) and as "absolute file
position" (wrong) for reported `clipRunStart`/`clipSegments`/
`hits.frame`/`hits.timeSec` — so a clip or digital hit found in the "end"
window was reported at a frame right after the "start" window instead of
its real position near the tail. `clipRuns[c]`/`clipRunStart[c]` also
survived the window boundary uninitialized, letting a run open at one
window's tail splice onto the next window's head into one bogus segment,
despite the windows being non-contiguous in the file.

**Done.** Computed each window's own frame offset
(`windowFrameOffset = Math.round((w.off - startOff) / frameSize)`) for
reporting `fileFrame`, leaving `scannedFrames`/`scannedSeconds` untouched.
Moved the clip-run flush-and-reset logic inside the per-window loop (run
once at the end of every window) instead of only after the whole scan, so
a run open at a window's tail is closed out there rather than merging
across the gap into the next window. New test:
`tests-js/bwavAudioScanQuick_windowOffset.test.mjs` — `app.js` is a plain
browser script with no ES module exports and DOM-dependent top-level
code, so the two pure functions under test (`runAudioScanQuick`,
`dbfsFromAmp`, plus its `channelLayoutGroups` dependency) are extracted
by name via brace-counting and evaluated with `new Function`, avoiding a
full DOM shim since none of this code touches the DOM.

**Gate.** Full `npm run build-verify` exit 0 after staging both changed
files (the new test file must be tracked in git or `selfContained.test.mjs`'s
own "no new test file is left out of git" gate fails — confirmed this
gate firing correctly before the `git add`). `npm run build:renderer` run
first (this fix lives under `src/tools/`, which `build-renderer.js`'s
`SHARED_ITEMS` list copies into `dist/desktop/`), producing 377 files
(git-ignored, not committed).

**Still open.** All items carried from Iteration 51 (`_drop` write-only
oddity in `api.py`, Iteration 48's `int(fps)` sweep, Iteration 49's
spaced-axis-key sweep, the `aaf_worker.js`/`aaf_wasm.js` raw-EditRate
citations, the deferred `otio.js`/`pfx_native_engine.js` items) remain
pending and unchanged.

Commits: `c94f9db`.

## Iteration 53 — amf_convert.js Nuke export used raw fractional fps as a timecode frame-base

**Found.** `amf_convert.js` defines `tcToFrames(tc, fps)` three separate
times in this file — a module-scope copy used directly by
`exportNukeNK()`'s master-mode segment/Root-range building, plus two more
embedded inside ExtendScript/JSX template-literal text generated for
After Effects (`__buildAEPCommonJSX()` and `exportAEJSX()`). The
module-scope copy multiplied the timecode's `HH:MM:SS` component directly
by `fps` — `base?.fps || DEFAULT_FPS`, the parser's raw fractional NTSC
rate (23.976/29.97/59.94) — instead of the nominal whole-frame base
(24/30/60) a timecode's `FF` field actually counts against. This is the
same bug species already fixed in `filters.js` (Iteration 50) and
`eventDuration.js`, just not yet converged into this file: a 23.976fps
EDL's `"00:00:05:00"` (5 real seconds) converted to `119.88` frames
instead of `120`, producing a non-integer `recInF`/`recOutF`/`durF` and a
non-integer `Root.last_frame` in the exported `.nk` script.

**Done.** Added the `nominalBase` import from `utils_time.js` and changed
the module-scope `tcToFrames`'s return statement to multiply by
`nominalBase(fps)` instead of raw `fps`. New test:
`tests-js/amfConvert_fractionalFpsTcToFrames.test.mjs` — extracts just the
module-scope definition as text (same `document`-at-module-scope
constraint as the existing `amfConvert_dropframe_tc.test.mjs`) and
evaluates it with `new Function`, asserting 23.976/29.97/59.94fps
timecodes now convert to whole-frame counts on their nominal base while
whole-number fps and drop-frame-semicolon handling are unaffected. Also
updated the pre-existing `amfConvert_dropframe_tc.test.mjs`, which
extracts and evaluates all three `tcToFrames` copies generically — its
harness now supplies a `nominalBase` stub to the evaluated function scope
so definition #1 (now referencing it) doesn't throw `ReferenceError`.

**Verification.** Mutation-tested by reverting `amf_convert.js` via
`git stash push -- <file>` and rerunning the new test: it failed exactly
as predicted (`119.88`/`107892`/`59.94` instead of `120`/`108000`/`60`);
restoring the fix (`git stash pop`) made it pass again.

**Gate.** `npm run build:renderer` run first (377 files, git-ignored).
Full `npm run build-verify` exit 0.

**Still open.** The two ExtendScript/JSX-embedded `tcToFrames` copies
(inside `__buildAEPCommonJSX()` and `exportAEJSX()`) share the same
fractional-fps-as-multiplier bug but execute as text inside Adobe After
Effects' ExtendScript engine, not as JS in this module — they can't
directly call `nominalBase()` and would instead need either a pre-rounded
fps value interpolated into the generated script text, or an equivalent
inline rounding helper embedded in the generated ExtendScript itself.
Left unfixed pending a decision on that approach. A fourth helper —
`tcToFramesLocal` (~line 1564, defaulting to `__QT_FPS`) inside a "QT
custom controls (24fps, 1-based frames)" section — was checked and ruled
out: `__QT_FPS` is a hardcoded `const __QT_FPS = 24` (line 1267), not a
parser-derived fractional rate, so this helper never sees a fractional
fps and is not an instance of this bug. All items carried from Iteration
52 remain pending and unchanged.

Commits: `aae10a9`.

## Iteration 54 — proxy_service.py silently reused another project's proxy cache when its sidecar was missing (new species: proxy-cache identity collision)

**Found.** `_proxy_cache_path(folder, cpl_path, ...)` computes a shared
"clean" cache filename (`<stem>.mp4`) from `_proxy_target_stem()`, which is
derived purely from the CPL's display title/filename (`_proxy_display_name`)
— not from any content-identity hash. Two entirely unrelated projects
(different watch folder, different CPL) can therefore land on the exact
same `clean_target` path if they happen to share a display title. The
reuse-vs-key-suffix decision was:
`if not clean_target.exists() or _sidecar_matches_target(...) or not clean_sidecar: return clean_target`.
That trailing `or not clean_sidecar` treated a missing/unreadable sidecar
JSON as *safe to reuse*, when it actually means the existing file's
identity is unknown. A sidecar can go missing from a completely normal
failure mode: `_write_proxy_sidecar` swallows every exception on its
`write_text` call, and it only runs *after* a proxy encode finishes — so a
crash, kill, or disk-full error mid-encode leaves a full-sized `.mp4` at
`clean_target` with no matching `.json`. The next unrelated project that
happens to share the same display-name stem would then be hard-coded onto
that same ambiguous path. Depending on `PFX_IMF_PROXY_QUALITY`
(`proxy_service.py`'s `_current_proxy_quality()`, default `'turbo'`), two
outcomes are both reachable: under the default quality, `_transcode_worker`
re-encodes onto that path and clobbers the other project's proxy file
outright; under a quality setting that makes `_proxy_cache_is_valid`'s
empty-`cached_quality` fallback pass, the code skips encoding and silently
serves the *other* project's video, then rewrites its sidecar to claim the
current folder/CPL identity and re-registers it in the content-addressable
fingerprint registry — propagating the mislabeling further. Notably, the
adjacent `_adopt_named_proxy_cache()`/`migrate_named_proxy_cache()` legacy
proxy-adoption code already checks sidecar `folderPath`/`cplPath` identity
before reusing a sidecar-less file — this same safeguard was simply absent
from `_proxy_cache_path`.

**Done.** Removed `or not clean_sidecar` from `_proxy_cache_path`'s
condition (`companion/src/postflowx_companion/proxy_service.py`). A missing
or non-matching sidecar now always falls through to the folder+CPL-keyed
path (`<stem>__<key>.mp4`, `key` a sha1 of folder+CPL path+size+mtime from
`_stable_proxy_cache_key`), which is unique per project regardless of
shared display names. New test:
`companion/tests/test_proxy_cache_path_identity.py` —
`test_missing_sidecar_does_not_reuse_foreign_clean_target` reproduces the
exact collision (two different folder/CPL pairs sharing a `contentTitle`,
first one's `.mp4` written with no sidecar) and asserts the second project
gets a distinct keyed path; `test_matching_sidecar_still_reuses_clean_target`
confirms the legitimate same-project reuse case (sidecar written and
matching) still returns the same clean path, unchanged.

**Verification.** Mutation-tested by reverting `proxy_service.py` via
`git stash push -- <file>` and rerunning the new test file: the collision
test failed exactly as predicted (`path_b == path_a`, both resolving to the
shared `Reel1_proxy.mp4`); the reuse test still passed unaffected;
restoring the fix (`git stash pop`) made both pass again.

**Gate.** Companion-only Python change — no `npm run build:renderer`
needed (consistent with Iteration 51's precedent for companion-only fixes).
Full `npm run build-verify` exit 0 (268 collected, 261 passed, 7 skipped).

**Still open.** All items carried from Iterations 52–53 remain pending and
unchanged. A related, lower-confidence item not pursued this iteration:
`_proxy_cache_is_valid()` itself never checks folder/CPL identity at all
(only legacy-name pattern, file size, IAB-audio-validation version, and
quality-string match) — it relies entirely on callers already having
resolved the correct path via `_proxy_cache_path`/`_adopt_named_proxy_cache`
first. With this iteration's fix that invariant now holds, so no separate
change was made there, but it's worth noting as the reason a narrower,
identity-check-only fix inside `_proxy_cache_is_valid` was not chosen
instead.

Commits: `2474017`.

## Iteration 55 — crossTabQueueLease.js leader election had a TOCTOU race in acquire/release *and* heartbeat renewal (new species: cross-tab concurrency race)

**Found.** `src/scripts/core/crossTabQueueLease.js` elects a single leader
tab (across browser tabs of the same app) to submit proxy-build jobs, using
an IndexedDB-backed lease (`{queueLeaderTabId, leaseUntil, heartbeat}`) plus
a `BroadcastChannel` for cross-tab notification. `acquireLease()`,
`releaseLease()`, and the periodic `_startHeartbeat()` renewal all used to
read the lease via `_getLease()` and write it back via `_setLease()` as two
*separate* IndexedDB transactions, with an `await` boundary between the
read and the write. IndexedDB only serializes transactions against each
other — it does nothing to stop two tabs from each reading a stale/absent
lease before either write lands, so both could believe they'd won
leadership, or a throttled/delayed heartbeat's stale read-then-write could
silently clobber another tab's legitimate takeover that happened in the
gap. This is a classic time-of-check-to-time-of-use race, not the fps/timecode/audio-position
species from Iterations 48–53 or the identity-collision species from
Iteration 54.

**Done.** In two passes: (1) `acquireLease()`/`releaseLease()` rewritten to
read-then-conditionally-write the lease inside a single `readwrite`
IndexedDB transaction (commit `8362fd5`), closing the race for initial
election and clean release. (2) `_startHeartbeat()`'s periodic renewal had
the identical bug — a throttled/backgrounded tab's heartbeat could read a
since-superseded lease and overwrite a peer's fresh takeover — fixed the
same way, merging its read+write into one atomic transaction (this
iteration's commit). Both fixes rely on the real guarantee that IndexedDB
serializes `readwrite` transactions against the same object store, so a
`get()` + conditional `put()` inside one transaction can't be interleaved
by another tab's transaction.

**Tests.** `tests-js/crossTabQueueLeaseRace.test.mjs` — a hand-rolled fake
IndexedDB (no `fake-indexeddb` package installed) running the module's
actual IIFE source inside a `node:vm` sandbox. The pre-existing test
(`'acquireLease() is atomic across two tabs racing on startup'`, added with
the acquire/release fix) stubs `setInterval` as a no-op, so it structurally
never exercises the heartbeat path. Added a second test for the heartbeat
specifically, using a new *gated* fake IndexedDB that queues transactions
instead of auto-running them (`pause()` / `runPendingAt(i)` / `getRaw()` /
`patchRaw()`) so the test can deterministically interleave a stale
heartbeat's read-then-write with a second tab's takeover write in a
specific, reproducible order, rather than relying on fragile microtask-count
racing. The scenario: tab A holds the lease and its heartbeat fires just as
the lease is patched to already-expired; concurrently tab B calls
`acquireLease()` (a legitimate takeover since the lease is expired). The
final assertion is invariant-based rather than winner-based — a tab's own
belief about winning must always match the actually-persisted store owner
(`bBelievesItWon === currentOwnerIsB`) — since forced transaction ordering
can legitimately let either side end up owning the lease; what must never
happen is a tab believing it won while the store says otherwise.

**Verification.** Mutation-tested by reverting only the heartbeat fix via
`git stash push -- src/scripts/core/crossTabQueueLease.js` and rerunning:
the new heartbeat test failed exactly as predicted (`tabB believes it
won=true but store owner is B=false` — A's stale heartbeat write clobbered
B's takeover), while the pre-existing acquire/release test still passed
unaffected (that fix wasn't reverted). Restoring the fix (`git stash pop`)
made both pass again. Full `npm run build-verify` exit 0 (Node/JS tests
green, 268 collected / 261 passed / 7 skipped in Python, security scan
gates clean).

**Gate.** Renderer-only change (`src/scripts/core/crossTabQueueLease.js` is
on the Iteration-55 clean-candidate whitelist, confirmed via `git status
--short` before editing) — no companion rebuild needed; a desktop/extension
`npm run build:renderer` / `build:extension` would pick this up on next
packaging.

**Still open.** All items carried from Iterations 52–54 remain pending and
unchanged.

Commits: `8362fd5`, `7e122bf`.

## Iteration 56 — cutdiff.js identity key never stripped angle/take suffixes

**Found.** `src/scripts/modules/cutdiff.js`'s `identityKey()` function has a
comment claiming it "strip[s] trailing counters / angle suffixes so that
`101-08-06/01_A` and `101-08-06/01_AB` still cluster together" — but the
function body never did any stripping, it just trimmed and concatenated
`reel`/`clipName` verbatim. Any clip whose angle/take suffix changed between
an OLD and NEW cut (a common re-label in editorial: `_A` → `_AB`, or vice
versa) produced a different `identityKey()` value on each side, so
`computeCutDiff()` found zero candidates in `oldIndex` for the NEW event and
classified it as `NEW` instead of matching it to its prior-cut counterpart
and correctly classifying it as UNCHANGED/EXTENDED/TRIMMED/CHANGED.

**Done.** Added `ANGLE_SUFFIX_RE = /_[A-Za-z]+\d*$/` (a trailing underscore
followed by at least one letter, optionally followed by digits) and applied
`.replace(ANGLE_SUFFIX_RE, '')` to the trimmed `clipName` before building the
key. The regex requires a letter immediately after the underscore, so
purely numeric trailing suffixes (`_010`, `_020` — shot/take counters) are
left untouched and continue to distinguish otherwise-identical clip names,
matching the existing `SHOT_010`-style test fixtures.

**Tests.** `tests-js/cutdiff.test.mjs` — three new assertions: (1) an angle
suffix change (`101-08-06/01_A` → `101-08-06/01_AB`), same reel, NEW longer
→ must classify EXTENDED (matched, not NEW); (2) an identical
angle-suffixed clip name (`SHOT_010_A`) on both sides → must classify
UNCHANGED, not NEW; (3) a negative-case guard — distinct numeric-suffixed
clip names (`SHOT_010` vs `SHOT_020`) must stay distinct identities → NEW,
confirming the fix doesn't over-strip and collapse genuinely different
clips. All 53 assertions (50 pre-existing + 3 new) pass against the fixed
code.

**Verification.** Mutation-tested by reverting only the fix via
`git stash push -- src/scripts/modules/cutdiff.js` and rerunning: the new
angle-suffix test failed exactly as predicted (`101-08-06/01_AB` classified
NEW instead of EXTENDED — 52 passed, 1 failed), while all other tests,
including the negative-case numeric-suffix guard, were unaffected. Restoring
the fix (`git stash pop`) made all 53 pass again.

**Gate.** Full `npm run build-verify` (`test:node && test:js && test:py &&
scan-innerhtml --gate && scan-rawxml --gate && scan-failopen --gate`): exit
0. Node/JS tests green, companion Python 261 passed / 7 skipped (268
collected, untouched by this change), all three security scan gates clean.
Renderer-only change (`src/scripts/modules/cutdiff.js` was confirmed clean
via `git status --short` before editing) — a desktop/extension
`npm run build:renderer` / `build:extension` would pick this up on next
packaging.

**Still open.** All items carried from Iterations 52–55 remain pending and
unchanged.

Commits: `05c6f0f`.

## Iteration 57 — ref-clip early-return skipped marker collection in fcpxml.js

**Found.** `src/scripts/parsers/fcpxml.js`'s `<ref-clip>` branch (a
compound-clip/multicam instance dropped on a timeline) resolves its
`<media>`/`<sequence>` target and recurses into it to produce output rows,
then returns before ever reaching this parser's own marker-collection
step. A `<marker>` placed directly on the `ref-clip` node itself (as
opposed to inside the referenced sequence) was silently dropped — it never
appeared on any output row. This was originally scouted against
`src/scripts/parsers/fcpxm.js` (missing the trailing "l"); verification
confirmed that file is dead code, never imported anywhere in the app, so
the finding was redirected to the live equivalent in `fcpxml.js` (confirmed
imported by `src/scripts/ui.js`, `src/scripts/prep_mark.js`, and
`src/scripts/features/reviews/index.js`) before being reported.

**Done.** The ref-clip branch now snapshots `out.length` before recursing
into the resolved sequence, then — after the recursion — collects and
attaches the ref-clip node's own direct markers to the first row the
recursion produced (`out[startLen]`), via a new shared
`collectClipMarkers(node, recInF, srcF, durF, fps)` helper extracted from
the parser's main per-clip marker-collection logic. The same helper is now
called from both the ref-clip branch and the original clip-scope marker
block, so the two paths can't drift apart again.

**Tests.** `test/parsers/fcpxml.test.mjs` — one new test,
`'a marker on a <ref-clip> node itself is not dropped'`: builds an inline
FCPXML with a `<media>`/`<sequence>` compound clip and a top-level
`<ref-clip>` timeline node carrying a direct `<marker>` child, and asserts
the marker surfaces on the first output row produced by the ref-clip's
resolved sequence. Getting this test running under Node surfaced a
pre-existing gap in `test/_setup.mjs`: it shimmed `DOMParser` and
`chrome.runtime.getURL` but not the browser `CSS` global, which the
ref-clip resolution branch needs (`` media[id="${CSS.escape(ref)}"]` ``) —
meaning ref-clip parsing had never actually been exercised by the Node
test suite before. Added a minimal test-only `CSS.escape` polyfill to
`test/_setup.mjs`, consistent with that file's stated "shim only what
parsers touch, never ship it" policy. All 7 tests in the file pass.

**Verification.** Mutation-tested via `git stash push --
src/scripts/parsers/fcpxml.js` (pathspec-scoped) and rerunning the test
file: the new test failed specifically (marker missing from the row),
while the other 6 tests were unaffected. `git stash pop` restored all 7 to
passing.

**Gate.** Full `npm run build-verify` (`test:node && test:js && test:py &&
scan-innerhtml --gate && scan-rawxml --gate && scan-failopen --gate`): exit
0. Node/JS tests green, companion Python 261 passed / 7 skipped, all three
security scan gates clean. Renderer-only change — a desktop/extension
`npm run build:renderer` / `build:extension` would pick this up on next
packaging.

**Still open.** All items carried from Iterations 52–56 remain pending and
unchanged. `src/scripts/parsers/fcpxm.js` (no trailing "l") is confirmed
dead code (unimported) and is permanently excluded from future scouting.

Commits: `514bd19`.

## Iteration 58 — Pass 7 TC-Out matching in smartOcfMatcher.js compared against the raw, retime-uncompensated srcOut

**Found.** `src/scripts/smart/smartOcfMatcher.js`'s `matchOcfToEvent` scoring
cascade computes `effectiveSrcOut` in Pass -1 for constant-speed retimed
events (the true native-source out point the OCF file's timecode covers,
distinct from `event.srcOut`, which is derived from the timeline-duration
and is only correct at 100% speed). That corrected value is already
threaded into Pass -1's own `inRangeHdl` check, but Pass 7 (the TC-Out
match bonus, `+8` when `_frameDelta(ocfFile.tcOut, ..., fps) <= 2`) still
compared directly against `event.srcOut`. For a retimed shot (e.g. 50%
slow-mo, where the OCF file's native duration is double the timeline
duration), this meant Pass 7's TC-Out delta was computed against the wrong
reference point and could fail to award its bonus even for an exact,
correct match — silently under-scoring genuinely correct retimed-shot
matches from SAFE down to REVIEW_NEEDED.

**Done.** Changed Pass 7's delta calculation from
`_frameDelta(ocfFile.tcOut, event.srcOut, fps)` to
`_frameDelta(ocfFile.tcOut, effectiveSrcOut || event.srcOut, fps)` —
reusing the same corrected value Pass -1 already computes, falling back to
the raw `event.srcOut` for non-retimed events where `effectiveSrcOut` is
undefined. This is the 9th distinct bug species found across this audit
series: partial propagation of a derived/corrected value across multiple
use sites within the same function — the fix for retime compensation was
only half-applied when it was originally written.

**Tests.** `tests-js/smartOcfMatcher_retimeTcOut.test.mjs` — one new
scenario: a 50%-speed retimed event (`speed: 50`, timeline-duration
`srcOut` of `01:00:02:00`) matched against an OCF file whose real TC-Out
(`01:00:04:00`) is double that, as the retime implies. Asserts the match
lands at `MATCH_STATUS.SAFE` with `confidence === 83` (exact, not just
"good enough") — pinning both the pass/fail threshold and the specific
score contribution of Pass 7's bonus. The scenario was deliberately
designed to avoid the `camNameHit && (tcExact || inRange) -> score =
max(score, 85)` floor override a few lines after Pass 7 (using a bare
`'A001'` reel that doesn't match the camera-name regex, omitting
`ocfFile.path` to skip the subfolder-match pass, and omitting
`ocfFile.fps` to skip the FPS-match pass) — that override would otherwise
force the score to ≥85 regardless of whether Pass 7's fix was present,
completely masking the very thing under test. An initial draft of this
test used a camera-style reel (`'A001C002'`) for both sides and passed
*even with the fix reverted* — caught only via mutation testing before any
commit — and had to be redesigned around the isolation constraints above.

**Verification.** Mutation-tested via `git stash push --
src/scripts/smart/smartOcfMatcher.js` (pathspec-scoped): with the fix
reverted, the test correctly failed (`confidence 75`, `REVIEW_NEEDED`);
`git stash pop` restored the fix and both assertions passed
(`confidence 83`, `SAFE`).

**Gate.** New test file was git-untracked when `npm run build-verify` was
first run, which fails
`tests-js/selfContained.test.mjs`'s `'no new test file is left out of
git'` integrity check — a reminder that any new `tests-js/*.test.mjs` file
must be `git add`-ed by explicit name before running the full gate, not
just written to disk. Staged both intended files
(`src/scripts/smart/smartOcfMatcher.js`,
`tests-js/smartOcfMatcher_retimeTcOut.test.mjs`) and reran: full `npm run
build-verify` (`test:node && test:js && test:py && scan-innerhtml --gate
&& scan-rawxml --gate && scan-failopen --gate`) exit 0. Companion Python
suite 261 passed / 7 skipped, all three security scan gates clean.

**Still open.** All items carried from Iterations 52–57 remain pending and
unchanged. `src/scripts/parsers/fcpxm.js` (no trailing "l") remains
permanently excluded as dead code.

Commits: `e94b10a`.

## Iteration 59 — computeReformatParams used the "contain" scale even for centerCrop in referenceMatchEngine.js

**Found.** `src/scripts/features/vfxPull/referenceMatchEngine.js`'s
`computeReformatParams` picks a `fit` mode (`'centerCrop'` when the OCF is
proportionally wider than the reference — e.g. a 2.39:1 anamorphic plate
matched to a 16:9 reference — `'fit'`/letterbox otherwise), but computed
`scale` as `Math.min(scaleW, scaleH)` unconditionally, regardless of which
`fit` mode was selected. `Math.min` is the correct "contain" factor (shrink
to fit entirely inside the target, leaving gaps) — a `'centerCrop'` result
needs the "cover" factor, `Math.max(scaleW, scaleH)` (grow until the target
is fully covered on both axes, cropping the excess). Whenever `fit`
resolved to `'centerCrop'`, the returned `scale` silently produced
letterbox/contain behavior instead — an unfilled gap on one axis — while
`fit` and the generated `notes` string both still claimed "center crop."

**Done.** Changed `scale` to branch on `fit`:
`fit === 'centerCrop' ? Math.max(scaleW, scaleH) : Math.min(scaleW, scaleH)`.
No other logic in the function needed to change — `fit`'s own
aspect-ratio-comparison selection logic was already correct, only the
scale computation was disconnected from it.

**Tests.** `tests-js/computeReformatParams.test.mjs` — two scenarios: (1)
a 2048×858 OCF matched to a 1920×1080 reference (OCF proportionally
wider) asserts `fit === 'centerCrop'`, that `scale` equals
`Math.max(scaleW, scaleH)` exactly, and that the scaled OCF height
actually reaches or exceeds the reference height (no letterbox gap); (2)
a 1000×1000 OCF matched to the same reference (OCF narrower) asserts
`fit === 'fit'` and `scale === Math.min(scaleW, scaleH)`.

**Verification.** Mutation-tested via `git stash push --
src/scripts/features/vfxPull/referenceMatchEngine.js` (pathspec-scoped):
with the fix reverted, the `centerCrop` scenario's two scale-related
assertions failed exactly as predicted (`scale 0.9375` instead of
`1.2587...`, height coverage assertion failed), while the `fit` scenario
was unaffected (`Math.min`/`Math.max` coincide with only two candidate
factors compared the same way in that branch... no — confirmed the `fit`
scenario passed because it never took the reverted `centerCrop` path).
`git stash pop` restored the fix; all 5 assertions passed.

**Gate.** New test file was staged (`git add`, by explicit name) before
running `npm run build-verify`, avoiding the untracked-test-file gate
failure hit in Iteration 58. Full gate (`test:node && test:js && test:py
&& scan-innerhtml --gate && scan-rawxml --gate && scan-failopen --gate`)
passed clean on the first run: companion Python suite 261 passed / 7
skipped, all three security scan gates clean.

**Still open.** All items carried from Iterations 52–58 remain pending
and unchanged. `src/scripts/parsers/fcpxm.js` (no trailing "l") remains
permanently excluded as dead code. Flagged but not yet investigated:
`detectSpeedChange()` in `src/scripts/modules/conform/audioMatcher.js`
(behavior with a negative `offsetFrames`, not currently reachable from
known call sites) and `estimateCDL()` in `referenceMatchEngine.js` (dense
median/patch-filtering SOP+power+saturation solve, worth a dedicated
audit pass).

Commits: `3e3a941`.

## Iteration 60 — ReviewPlayer._sameSource false-matched distinct clips via substring containment

**Found.** `src/scripts/features/reviews/player.js`'s `_sameSource(video,
url)` — the gate `ReviewPlayer` uses at 7 call sites to decide "seek in
place" vs. "load a new clip" — fell back to `cur.includes(want) ||
want.includes(cur)` when the URLs weren't an exact match. That falsely
returns `true` whenever one URL is a literal prefix of the other (e.g.
`"...?clip=clip1"` vs. `"...?clip=clip10"`), so the player silently kept
showing the old clip's frames instead of loading the new one — wrong
footage, no error.

**Done.** Replaced the substring fallback with an exact comparison of
resolved absolute URLs (`new URL(cur, document.baseURI).href === new
URL(want, document.baseURI).href`), keeping the existing exact-string
fast path and empty-input early return. All 7 call sites unchanged — the
method's boolean contract didn't change.

**Tests.** New `tests-js/reviewPlayerSameSource.test.mjs`, 9 assertions
via the `linkedom` DOM-shim pattern (per `pfxTransportDom.test.mjs`):
prefix-containment pairs (both directions) return `false`; exact matches
and relative/absolute forms of the same URL return `true`; empty/null/
undefined inputs and a `null` video return `false`.

**Verification.** Mutation-tested via `git stash push --
src/scripts/features/reviews/player.js`: exactly the 2
prefix-containment assertions failed with the fix reverted; `git stash
pop` restored the fix and all 9 passed again.

**Gate.** New test file staged by explicit `git add` before `npm run
build-verify` (per the Iteration 58 lesson). Full gate passed clean:
companion Python suite 261 passed / 7 skipped, all three security scan
gates clean.

**Still open.** All items carried from Iterations 52–59 remain pending
and unchanged. This iteration's original target
(`src/scripts/features/trlconf/index.js`, an fps/fpsExact timecode-base
bug) was found and fixed but **abandoned and fully reverted** — the file
is entangled in ~1500 lines of pre-existing uncommitted work not present
in `HEAD`, making a clean scoped commit impossible there. That
investigation also revealed the repo's pre-existing dirty-vs-`HEAD`
condition spans ~400+ files, not a small known set — going forward,
`git diff --stat -- <file>` against `HEAD` must be confirmed empty before
any file is chosen as a fix target.

Commits: `5d4e82a`.

## Iteration 61 — Canon C-Log2 footage misclassified as C-Log3 in ocfIdtResolver.js

**Found.** `src/scripts/features/aceslook/services/ocfIdtResolver.js`'s
`_findBySearchStr` returns the first `IDT_MAP` entry whose `match` array hits
a token in the combined metadata string. The Canon C-Log3 entry's match list
included a bare `'canon'` vendor token and sat *before* the C-Log2 entry, so
any Canon-tagged metadata (via `cameraFamily: 'Canon'`) short-circuited to
C-Log3 regardless of the actual log profile — misclassifying real C-Log2
footage, and even plain non-log Canon Rec.709 footage.

**Done.** Removed the bare `'canon'` token from the C-Log3 match array,
leaving log-specific tokens only (`['clog3', 'c-log3', 'cinema gamut']`).
Non-log Canon footage now correctly falls through to the existing Rec.709
fallback entry. Added a comment above the Canon section warning against
adding a bare vendor token ahead of more specific same-vendor entries.

**Tests.** New `tests-js/ocfIdtResolverCanonLog.test.mjs` (plain Node, 3
assertions): Canon C-Log2 → C-Log2 IDT, Canon C-Log3 → C-Log3 IDT (regression
guard), plain Canon Rec.709 → Rec.709 fallback (not swept into C-Log3).

**Verification.** Target file was untracked (new, no `HEAD` version), so
`git stash push -- <file>` mutation-testing doesn't apply — used a plain
`/tmp` file-copy backup/restore instead. With the bare `'canon'` token
reintroduced: 1 passed / 2 failed. With the fix restored: 3 passed / 0
failed.

**Gate.** `npm run build-verify` first failed on
`tests-js/selfContained.test.mjs`'s baseline-shrink check:
`tests-js/fixtures/untracked-imports.json` had 3 stale entries pointing at
`ocfIdtResolver.js` now that it's tracked. Removed exactly those 3 lines;
reran gate clean (Python suite 261 passed / 7 skipped, XSS/XXE/fail-open
gates clean).

**Still open.** No further fix needed. Worth a future pass auditing other
`IDT_MAP` vendor sections (RED, Sony, Blackmagic, DJI) for the same
bare-vendor-token-before-specific-token ordering risk, though none currently
exhibit it.

**Lessons learned.**
- `git diff --stat -- <file>` being empty does not distinguish "tracked and
  clean" from "untracked and new" — both look empty. Check `git status
  --porcelain -- <file>` for a `??` before assuming a git-stash-based
  mutation-testing workflow will work; untracked files need a plain file-copy
  backup/restore instead.
- Tracking a previously-untracked file for the first time can retire stale
  entries in `tests-js/fixtures/untracked-imports.json` — check for and
  remove them in the same change, or `build-verify` fails on the
  baselines-only-shrink check.

Commits: `26f460d`.

## Iteration 62 — mediaSearchBox debounce race: a slower earlier search can clobber a faster later one

**Found.** `src/scripts/features/mediaSearch/mediaSearchBox.js`'s debounced
search (`clearTimeout` + `setTimeout`) only cancels timers that haven't
fired yet — it does nothing once a `_search()` IPC call is already in
flight. Two searches fired from consecutive keystrokes can resolve
out-of-order; `render()` always applies whichever response arrives last,
so a slower earlier search can overwrite the dropdown (and `lastRows`,
used by click-to-pick) with stale results for a term the input no longer
shows — risking the wrong media file being linked via `onPick`.

**Done.** Added a monotonic sequence counter; each debounced search captures
its sequence number at schedule time and skips `render()` if a newer
keystroke has superseded it by the time the response arrives.

**Tests.** New `tests-js/mediaSearchBoxRace.test.mjs` (linkedom DOM harness):
mocks the native-engine `db.search` command with controllable resolution
order, resolves a faster "cats" search before a slower "cat" search, and
asserts the dropdown reflects "cats" — not the stale "cat" response.

**Verification.** File is untracked (no `HEAD` version) — used plain
file-copy backup/restore for mutation testing (git stash pathspec doesn't
apply to untracked files). Without the sequence guard: 0 passed / 1 failed.
With the fix: 1 passed / 0 failed.

**Gate.** `npm run build-verify` first failed on the same
`untracked-imports.json` baseline-shrink check as Iteration 61 — tracking
`mediaSearchBox.js` retired 2 stale entries (`vfxPullPanel.js`, `imf_ui.js`
importing it). Removed those 2 lines; reran gate clean.

**Still open.** None.

## Iteration 63 — GPU SDR-passthrough shader clips negative signed samples instead of wrapping them

**Found.** `src/scripts/modules/imf/imf_gl_present.js`'s WebGL2
SDR-passthrough branch (`u_colorMode == 0`) ports the CPU reference's
`px(v) = (v >> shift) & 0xff` from `imf_render_worker.js` into GLSL as
`clamp(floor(s / u_sdrDiv), 0.0, 255.0)`. `floor()` correctly replicates
the `>>` shift, but `clamp()` clips out-of-range values instead of wrapping
them the way `& 0xff` does — so any negative signed sample (e.g. a 12-bit
signed IMF source) gets clipped to black instead of the correct low-byte
value. Concrete failure: 12-bit signed `v = -100` — CPU gives 249, GPU gave
0.

**Done.** Replaced `clamp(...,0.0,255.0)` with `mod(...,256.0)`. GLSL's
`mod` is floor-based, so it reproduces two's-complement truncation for any
sign and is a no-op for the already-valid unsigned case.

**Tests.** New `tests-js/imfGlPresentSdrPassthrough.test.mjs` — no WebGL
harness exists in this repo, so the test extracts the real shipped GLSL
expression via regex and evaluates it numerically in JS with a small
GLSL-to-JS arithmetic translator, then compares against the CPU reference
for 8-bit/16-bit unsigned and 12-bit/16-bit negative-signed cases.

**Verification.** File is untracked — used plain file-copy backup/restore
for mutation testing. Reverting `mod` back to the buggy `clamp`: 2 passed /
2 failed (both negative-signed cases). With the fix: 4 passed / 0 failed.

**Gate.** `npm run build-verify` failed twice first: once because the new
test file wasn't staged ("no new test file is left out of git" check), and
once because tracking `imf_gl_present.js` retired a stale
`untracked-imports.json` entry (`imf_player.js -> imf_gl_present.js`).
Fixed both; reran gate clean (Python suite 261 passed / 7 skipped,
XSS/XXE/fail-open gates clean).

**Still open.** None.

Commits: `50e0be7`.

## Iteration 64 — XMEML normalize step silently deleted legitimate frame-0 clips

**Found.** `src/scripts/parsers/xml.js`'s post-parse "normalize" step
dropped any event whose `srcIn` was literally `"00:00:00:00"` as soon as
its source group (by `srcFile`/`reel`/`clipName`) contained another event
with a non-zero `srcIn` — treating a genuine zero in-point as a stub
sentinel. Two clips reusing the same camera master (one cut in from frame
0, one cut in later) silently lost the frame-0 clip from the parser's
output, with no error and no detectable gap (IDs are reassigned after
normalize).

**Done.** Restricted the drop to true literal duplicates: an event is only
dropped for `srcIn === "00:00:00:00"` if another event in the same group
also matches its `recIn`, `recOut`, and `srcOut` — the only condition under
which two rows could actually be redundant parses of the same edit.

**Tests.** New test in `test/parsers/xml.test.mjs` — the existing
`xmeml_basic.xml` fixture couldn't reproduce the bug (different `srcFile`
per clip, non-zero file-level timecode), so built an inline XML string with
`<timecode><frame>0</frame>` and two clips sharing one `srcFile` (one
`<in>0</in>`, one `<in>240</in>`), asserting both survive with correct
`srcIn` values.

**Verification.** File was tracked-and-clean — used plain file-copy
backup/restore for mutation testing. Reverting to the original grouped-drop
logic: new test failed (`1 !== 2`, frame-0 clip vanished). With the fix:
6/6 passing.

**Gate.** `npm run build-verify` passed clean on the first attempt — no
`untracked-imports.json` baseline issue this time, since both files were
already tracked before this iteration.

**Still open.** None.

Commits: `325445a`.

## Iteration 65 — companion HTTP server mis-served suffix byte-ranges

**Found.** `companion/src/postflowx_companion/http_server.py`'s
`_serve_file()` parsed `Range: bytes=-N` (an RFC 7233 suffix range meaning
"the last N bytes") as `start=0` because `"-N".partition("-")` yields an
empty "before" component, which the code treated as "start omitted" rather
than "this is the suffix form." Silently served the first N bytes of the
file with a `Content-Range` header claiming otherwise — a `206` success
status carrying wrong data. This is exactly the request shape media
clients use to fetch a trailing chunk (e.g. locating a `moov` atom in a
non-fast-start MP4).

**Done.** Added a branch that detects the suffix form (empty start, non-empty
end) and computes `start = max(0, size - N)`, `end = size - 1`; every other
range form is untouched.

**Tests.** New `test_suffix_range_serves_last_n_bytes` in
`companion/tests/test_http_server.py`'s `TestServeFileRange` class —
asserts on a 10-byte file that `Range: bytes=-4` returns `206`,
`Content-Range: bytes 6-9/10`, and the actual bytes written are `b"6789"`.

**Verification.** File was tracked — used plain file-copy backup/restore.
Reverting to the unconditional `start=0` path: new test failed
(`['bytes 0-4/10'] != ['bytes 6-9/10']`). With the fix: 23/23 passing.

**Gate.** `npm run build-verify` passed clean on the first attempt — both
files were already tracked, no `untracked-imports.json` baseline issue.
Python suite: 262 passed, 7 skipped.

**Still open.** None.

Commits: `621a708`.

Commits: `7be729e`.

## Iteration 66 — companion drop-frame timecode only changed the separator, not the frame count

**Found.** `companion/src/postflowx_companion/proxy_service.py`'s
`_seconds_to_timecode()` used `drop_frame` only to pick `;` vs `:` — the
frame-number arithmetic itself always ran plain non-drop math. A 29.97fps
drop-frame clip one minute and two frames in (`60.06s`) was labeled
`"00:01:00;00"` instead of the correct SMPTE drop-frame `"00:01:00;02"`,
off by up to 18 frames near a 10-minute boundary. Distinct from species 51
(which fixed *classifying* 23.976 as drop-frame) — this bug is in the
frame-count math itself, which had zero test coverage.

**Done.** Implemented the standard drop-frame compensation algorithm
(matches the codebase's own correct JS `_dfFramesToTC` in
`utils_time.js`): convert the real elapsed frame count into the equivalent
nominal-fps labeled count before dividing, only when `drop_frame` is set
and the rate is 29.97/59.94-based.

**Tests.** Three new tests in `companion/tests/test_drop_frame_rate.py`:
one-minute skip at 29.97 (`60.06s → "00:01:00;02"`), no skip at a
10-minute boundary (`600.0s → "00:10:00;00"`), and the four-frame skip at
59.94 (`60.06s → "00:01:00;04"`).

**Verification.** File was tracked — used plain file-copy backup/restore.
Disabling the new branch: all 3 new tests failed with the old wrong
values. With the fix: 7/7 passing.

**Gate.** `npm run build-verify` passed clean on the first attempt — both
files were already tracked, no `untracked-imports.json` baseline issue.
Python suite: 265 passed (262 + 3 new), 7 skipped.

**Still open.** None.

## Iteration 67 — MXF MIC verification aggregated the whole file instead of scoping per-partition

**Found.** `companion/src/postflowx_companion/imf_mic.py`'s
`verify_mxf_mic()` collected every essence element in the entire MXF file
into one flat list and kept overwriting `integrity_value` on each
`EssenceIntegrityPack` KLV found, so only the *last* pack ever got compared
— against a whole-file digest. SMPTE ST 429-6 scopes each pack to its own
partition's essence, so this produced false-positive "corrupt" reports on
valid multi-partition files, and could miss real corruption in an earlier
partition whose pack got silently discarded.

**Done.** Bucket essence elements per integrity pack instead of file-wide —
verify each pack against only the elements seen since the previous one,
then reset the bucket. `result.ok` is now `True` only if every pack in the
file matches.

**Tests.** New `TestMultiPartitionMic` class in
`companion/tests/test_imf_mic.py` with a `_build_multi_partition_mxf()`
fixture (the existing `build_mxf_with_mic()` only ever built single-pack
files — zero coverage for the multi-partition case). Covers: two valid
partitions pass; corruption in the second partition is caught; corruption
in the *first* partition is caught (the case the old whole-file/last-pack
logic missed).

**Verification.** Backed up the fix, reverted to the original whole-file
logic, reran: the two-valid-partitions test failed (`ok=False` on a
legitimately valid file). Restored the fix: all 36 tests in
`test_imf_mic.py` passed, plus all 7 in `test_imf_qc_mic.py` (downstream
consumer), confirming no shape regression for that caller.

**Gate.** `npm run build-verify` passed clean (exit 0); log grepped for
failure markers, all false positives.

**Still open.** None.

Commits: `8035764`.

Commits: `2823c48`.

---

## Iteration 68 — FCPXML fallback scanners hardcoded source-in trim to frame 0

**Found.** `buildFlatFCPXMLEvents` and `buildTopLevelFCPXMLEvents` — the two
fallback scanners `parseFCPXML` uses when its recursive `collect()` walker
finds zero events (e.g. a `<spine>` nested inside unrecognized wrapper
elements) — both hardcoded `srcIn` to frame 0 instead of reading the clip's
`start` attribute (the source-media trim-in point), discarding real trim
data on every event they produced.

**Done.** Both scanners now read `ratToFrames(node.getAttribute('start'),
fps)` and use it for `srcIn`/`srcOut`, matching `collect()`'s own
`ref-clip` reference pattern.

**Tests.** New test in `test/parsers/fcpxml.test.mjs` using a fixture with
`<spine>` nested two levels below `<sequence>` (`<outer><inner><spine>`) —
genuinely defeats `collect()`'s recursion while still being found by
`buildFlatFCPXMLEvents`'s subtree-wide scan. Asserts `res._fallback ===
'flat-sequence-scan'` and that `srcIn`/`srcOut` reflect the real
`start="480/24s"` trim point, not frame 0.

**Verification.** Reverted the fix in `buildFlatFCPXMLEvents`, reran: new
test failed with the expected wrong value (`00:00:00:00` instead of
`00:00:20:00`). Restored the fix: all 8 tests in `fcpxml.test.mjs` passed.
`buildTopLevelFCPXMLEvents`'s parallel fix verified by source read only —
not independently mutation-tested this pass.

**Gate.** `npm run test:node` passed clean: 72 tests, 71 pass, 1
pre-existing skip, 0 fail. Log grepped for failure markers, zero real
failures.

**Still open.** Construct a fixture defeating both `collect()` and
`buildFlatFCPXMLEvents` to mutation-test `buildTopLevelFCPXMLEvents`
independently.

Commits: `3881348`.

---

## Iteration 69 — Animated-transform keyframe times mis-parsed as bare numerator

**Found.** `readFCPTransform()` in `src/scripts/parsers/fcpxml.js` parsed
`<keyframe time="...">` with a ternary whose two branches computed the same
thing (`parseFloat` either way) — never actually handling FCPXML's rational
`"N/Ds"` time format. `parseFloat("12345/24000s")` returns `12345` instead
of `0.514375`, corrupting every animated-transform keyframe (pan/zoom/rotate
ramps) whose numerator isn't a whole number of seconds.

**Done.** Added `ratToSeconds(val)` (unrounded sibling of `ratToFrames`) and
used it for keyframe `time` parsing.

**Tests.** New test in `test/parsers/fcpxml.test.mjs`: a two-keyframe
position animation with `time="12345/24000s"` / `"24690/24000s"`, asserting
the parsed keyframe times equal the true fractions, not the bare numerators.

**Verification.** Reverted to the original ternary, reran: test failed with
`actual: 12345, expected: 0.514375`. Restored the fix: all 9 tests in
`fcpxml.test.mjs` passed.

**Gate.** `npm run test:node` passed clean: 73 tests, 72 pass, 1
pre-existing skip, 0 fail. Log grepped for failure markers, zero real
failures.

**Still open.** None for this fix.

Commits: `171d82e`.

---

## Iteration 70 — IMF CPL SourceDuration wrongly defaults to IntrinsicDuration, ignoring EntryPoint

**Found.** `_parse_cpl()` in `companion/src/postflowx_companion/imf_scan.py`
defaulted an omitted `<SourceDuration>` to `IntrinsicDuration` alone,
ignoring `EntryPoint`. Per SMPTE ST 2067-3 the correct default is
`IntrinsicDuration - EntryPoint`. Overcounts resource duration (and the
composition's `totalFrames`) by exactly `EntryPoint` whenever
`SourceDuration` is omitted and `EntryPoint` is nonzero.

**Done.** Computed the correct default explicitly (`max(0, intrinsic -
entry)`) and removed two redundant `or intrinsic` fallbacks that also
mishandled an explicit `SourceDuration == 0`.

**Tests.** New `TestSourceDurationDefaulting` class in
`companion/tests/test_imf_scan.py` with a new `_cpl_with_segment_resource()`
fixture (the existing `_minimal_cpl()` fixture uses the wrong CPL structure
and never reaches this code path). 3 tests: omitted+nonzero EntryPoint
(asserts `800` not `1000`), explicit SourceDuration used verbatim, omitted
SourceDuration with zero EntryPoint.

**Verification.** Reverted to the original three buggy lines, reran: the
key test failed with `assert 1000 == 800` as predicted. Restored the fix:
all 3 new tests and the full 32-test file passed.

**Gate.** `python3 -m pytest companion/tests/` — 269 passed, 7 skipped, 2
pre-existing unrelated failures (`test_conform_engine.py`, Python 3.10+
`int.bit_count()` API on this machine's 3.9.6 — confirmed pre-existing via
`git show HEAD` diff, part of existing uncommitted drift).

**Still open.** None for this fix.

Commits: `a8fdd73`.

---

## Iteration 71 — EXR sequence QC and frame-map CSV writer treat frameStart: 0 as absent

**Found.** `_qc_exr_sequence`'s start-frame check and
`_write_pull_sidecars`'s frame-map CSV writer in
`companion/src/postflowx_companion/api.py` both computed `frame_start =
int(job.get("frameStart") or 1001)`. A legitimate `frameStart: 0` is falsy
in Python, so `or` silently discarded it and substituted the VFX-convention
default of `1001` — same bug class as Iteration 70's IMF `SourceDuration`
fix, recurring independently in a different file/field. 4 other call sites
in the same file already use the correct `job.get("frameStart", 1001)`
idiom.

**Done.** Switched both sites to `job.get("frameStart", 1001)`, matching
the codebase's own already-correct idiom.

**Tests.** 2 new tests in `companion/tests/test_vfx_pull_exr.py`:
frame-map CSV's first `outputFrame` is `0` (not `1001`) for `frameStart:
0`; `_qc_exr_sequence` emits no `"Frame start"` warning for a real 4-file
`.exr` sequence starting at `0000` with `frameStart: 0`.

**Verification.** Reverted exactly the 2 fixed lines (by line number, to
avoid touching the 4 correct sites sharing the same post-fix text): both
new tests failed as predicted (`outputFrame == 1001`, spurious `"Frame
start: 0 found, 1001 expected"` warning). Restored the fix: both passed.

**Gate.** `python3 -m pytest companion/tests/` — 271 passed, 7 skipped, 2
pre-existing unrelated failures (`test_conform_engine.py`, same
`int.bit_count()` Python-version issue as Iteration 70).

**Still open.** None for this fix.

Commits: `08ed84b`.

---

## Iteration 72 — FCPXML conform parser used source span instead of record span for durationFrames

**Found.** `parseFcpXml` in `src/scripts/modules/conform/edlParser.js`
computed `durationFrames: Math.max(0, srcOut - srcIn)` (source `<in>`/
`<out>`) instead of the record `<start>`/`<end>` span, contradicting the
file's own documented policy and its sibling `parseEdl`'s correct
implementation. A retimed clip has a different source span than its
record span (e.g. 48 source frames vs 96 record frames for a half-speed
ramp), so this silently halved the reported timeline duration for any
FCPXML containing a retime.

**Done.** Changed `parseFcpXml` to `durationFrames: Math.max(0, recOut -
recIn)`, matching `parseEdl`'s existing correct pattern.

**Complication.** `edlParser.js` and its existing test file carry large
pre-existing *uncommitted* drift (drop-frame math rewrite, `parseEdl`
regex rewrite, FCM export logic — never committed, per `git log
--oneline -- <path>` showing only the original repo-init commit).
Isolated the fix into a hand-crafted patch staged via `git apply --cached`
so only the intended 4-line hunk was committed, leaving the drift
untouched in the working tree. Created a new dedicated test file instead
of committing the drift-laden existing one.

**Tests.** New file `tests-js/edlParserFcpXmlDuration.test.mjs`: FCPXML
clip with 48-frame source span but 96-frame record span; asserts
`durationFrames === 96`.

**Verification.** Failed as predicted against the buggy code
(`durationFrames === 48`); passed after the fix. Also verified in an
isolated scratch dir (extracted via `git show :<path>`) that the staged
commit passes independent of the unstaged drift.

**Gate.** `npm run test:js` — full green across all `tests-js/*.test.mjs`.

**Still open.** Pre-existing drift in `edlParser.js` /
`edlParserConform.test.mjs` remains uncommitted (out of scope, predates
this session). Scouting agent's other two candidates (audio correlation
in `conform_engine.py`; MIC check conflation in `imf_qc.py`) unaddressed.

Commits: `c9ee0d8`, `7c580a8`.

## Iteration 73 — Python `parse_edl` dropped dissolve/wipe events and used source span for duration_frames

**Found.** `parse_edl` in `companion/src/postflowx_companion/engines/conform_engine.py`
(the Python-side CMX3600 EDL parser, sibling to Iteration 72's JS fix)
had two bugs: (1) its event regex hardcoded literal `C` as the edit-type
token, so `D` (dissolve) and `W###` (wipe) lines never matched and were
silently dropped — could trigger `RESOLVE_SCRIPT_FAILED: No events found`
for transition-only EDLs; (2) `duration_frames` was computed from the
source TC span instead of the record TC span, same bug class as
Iteration 72 but in this file/function.

**Fix.** Broadened the regex to `([A-Z])\s*(?:\d+)?` (any transition
letter + optional duration token) and switched duration calc to use
`rec_in`/`rec_out`, mirroring `edlParser.js`'s already-correct `parseEdl()`.

**Tests.** New file `companion/tests/test_conform_engine_parse_edl.py`:
one test asserts a cut+dissolve+wipe EDL parses all 3 events; one asserts
duration comes from a 96-frame record span, not a 48-frame source span.

**Verification.** Confirmed both bugs against the old logic via
standalone regex/arithmetic snippets. Full suite:
`python3 -m pytest companion/tests/` — 273 passed, 7 skipped, 2 failed
(pre-existing Python-3.9 `bit_count()` gate, unrelated).

**Complication.** Both `conform_engine.py` and `test_conform_engine.py`
carry large pre-existing uncommitted "Picture Conform v1.4" drift.
Isolated the source fix via a hand-crafted `git apply --cached` patch
(first awk attempt used a wrong stop-pattern and grabbed ~400 extra
drift lines — caught by reviewing the patch before applying, fixed).
For the test file, followed the Iteration 72 precedent directly: put the
2 new tests in a brand-new dedicated file instead of touching the
drift-laden existing one.

**Gate.** `python3 -m pytest companion/tests/` — 273 passed, 7 skipped, 2
pre-existing-unrelated failed.

**Still open.** Both files' pre-existing v1.4 visual-matcher drift
remains untouched and uncommitted (predates this session, out of scope).

Commits: `f74f89b`.

## Iteration 74 — DoVi `isCut` mirrored `gapBefore`, undercounting real shot cuts

**Found.** `annotateShots()` in `imf_dovi_metafier.js` set
`isCut = gapBefore > 0`. DoVi CM XML Shot lists are inherently
scene-based (every listed Shot is a real cut), so well-formed gapless
content reported near-zero cuts in the IMF UI's "Cuts" counter — a
contiguous 3-shot sequence with 2 real cuts reported 0.

**Fix.** Redefined `isCut = prev != null` (every shot after the first is
a cut), independent of `gapBefore`, which keeps its separate meaning as
a frame-continuity anomaly signal. Updated 3 `imf_ui.js` consumer sites
(gap marker, tooltip, shot-list badge) that relied on `isCut` for
gap-only UI to check `gapBefore > 0` directly instead, and removed one
now-dead guard in the shot-boundary-separator loop.

**Tests.** New file `tests-js/imfDoviAnnotateShotsCuts.test.mjs`: a
contiguous 3-shot case (0 cuts → 2 cuts fixed) and a gapped-shot case
confirming `isCut`/`gapBefore` stay independently meaningful.

**Verification.** `node tests-js/imfDoviAnnotateShotsCuts.test.mjs` —
7/7 pass. Full `npm run test:js` — 0 failures.

**Complication.** `imf_ui.js` carries pre-existing drift at two unrelated
hunks (PLUGFEST `pkg.fileMap` fix, IAB group-label QC branch). Isolated
the 4 intended edits via a hand-crafted `git apply --cached` patch; a
first isolation attempt wrongly captured the drift hunks too — caught
before applying, fixed with an exact-header pattern-match.

**Gate.** `npm run test:js` — full suite passes, 0 failures.

**Still open.** `imf_ui.js`'s drift and `src/index.html`'s unrelated
drift (session-store script tag, tab tooltips/group-labels) remain
untouched and uncommitted (predate this session, out of scope).

Commits: `7e905a6`.

## Iteration 75 — IAB `isAtmos` ignored the name-matched bed fallback, misclassifying pure 5.1 tracks as Atmos

**Found.** `extractAdmProgrammeTreeFromCompanion()` in
`imf_iab_labels.js` derives bed counts two ways: the companion's
`objectSummary.bedObjects`, or a name-match fallback (`bed|5.1|7.1|...`).
`objectCount`/`bedCount`/`is51` all OR both signals, but `isAtmos` only
checked `bedFromSummary` — a pure 5.1-bed track (6 bed-named objects, no
`objectSummary.bedObjects`) was wrongly flagged as Atmos.

**Fix.** `isAtmos` now uses the same
`(bedFromSummary || bedObjects.length)` OR'd bed count as the other
three fields.

**Tests.** New file `tests-js/imfIabAtmosBedCount.test.mjs`: a pure
5.1-bed case (asserts `isAtmos === false`) and a bed+dynamic-object mix
case (asserts `isAtmos === true` still holds).

**Verification.** `node tests-js/imfIabAtmosBedCount.test.mjs` — 6/6
pass. Full `npm run test:js` — 0 failures.

**Complication.** `imf_iab_labels.js` carries pre-existing drift (3
unrelated `cat === 'object'` hunks + a mode-bit change). Isolated the
1-line fix via a hand-crafted `git apply --cached` patch matched to its
exact `@@` hunk header.

**Gate.** `npm run test:js` — full suite passes, 0 failures.

**Still open.** `imf_iab_labels.js`'s drift (`_fixForReject()`/
`inspectIabAdm()`/`inspectIabAdmFromNames()` `object`-category
additions) remains untouched and uncommitted (predates this session, out
of scope).

Commits: `5abf65a`.

## Iteration 76 — `aaf_export.py` AAF export was completely non-functional: 7 wrong-property/wrong-class defects

**Found.** Scouted bug (`comp_clip['StartPosition'].value = src_in`
double-offset) led to discovering `aaf_export.py`'s property vocabulary
doesn't match the vendored `pyaaf2` classdef dictionary at all — both
`export_nle_linked_aaf()` and `export_protools_aaf()` raised immediately
on any real payload.

**Fix.** 7 defects fixed together (each only surfaced once the prior was
fixed): (1) `Timecode(start=...)` invalid kwarg → construct bare +
`.start =`, (2) `ImportDescriptor` has no `SampleRate`/`Length` (video) →
swapped to `DataEssenceDescriptor`, (3) `TapeDescriptor['TapeName']`
doesn't exist → removed, (4) same `ImportDescriptor` bug in audio's
linked branch → swapped to `WAVEDescriptor`, (5) `.locators` (plural)
typo → `.locator`, (6) `['StartPosition']`/`['SourceSlotID']` don't
exist → `.start`/`.slot_id` (real props are `StartTime`/
`SourceMobSlotID`) across all 8 SourceClip sites, (7) the original
scouted double-offset → `comp_clip.start = 0`.

**Tests.** New `companion/tests/test_aaf_export_nle.py` drives
`export_nle_linked_aaf()` end-to-end and asserts CompositionMob
`SourceClip.start == 0` / MasterMob `SourceClip.start == 90250`. Manual
smoke test confirmed `export_protools_aaf()`'s linked-audio branch also
now succeeds.

**Verification.** `pytest tests/test_aaf_export_nle.py -v` — 1/1 pass.
Full `pytest -q` — 274 passed/7 skipped/2 pre-existing-unrelated failures
(Python 3.9 lacks `int.bit_count()`, nothing to do with AAF). `npm run
test:js` — 22/22 pass.

**Complication.** `aaf_export.py`'s pre-existing mode-bit drift
(100644→100755) isolated out via hand-crafted `git apply --cached`
patch, left unstaged.

**Gate.** Both test suites above pass cleanly.

**Still open.** Mode-bit drift untouched (predates session, out of
scope). `DataEssenceDescriptor` is a functionally-correct but
semantically loose descriptor choice for video (meant for non-AV data);
flagged for a future iteration if real frame-geometry data becomes
available and NLE relink behavior needs it — not fixed now since
inventing fake dimensions would be worse than a lightweight placeholder.

Commits: `0f67670`.

## Iteration 77 — Photon detection reported "not found" for an on-PATH binary

`engine_status.py`'s Photon lookup was written as
`shutil.which("photon") or shutil.which("pfx-photon") or str(p) if p.exists() else None`.
Python's `if/else` binds looser than `or`, so this parses as
`(A or B or C) if p.exists() else None` — the `~/bin/photon` existence
check gated the whole chain, so a Photon binary properly installed on
`PATH` was reported missing whenever `~/bin/photon` didn't exist.
Fixed by parenthesizing the fallback:
`shutil.which("photon") or shutil.which("pfx-photon") or (str(p) if p.exists() else None)`.
Added `test_engine_status_photon.py` (2 tests: PATH-only, home-bin-only);
confirmed the PATH-only case fails pre-fix via a stash/pop round-trip.
Full suite: 276 passed, 7 skipped, same 2 pre-existing Python-3.9
`bit_count()` failures from Iteration 76 (unrelated, out of scope).

Commits: `8cec8cc`.

## Iteration 78 — Proxy transcode progress never reached the session store

`generate_proxy_async()` in `proxy_engine.py` fetched the session via
`get_session()` (which returns a copy, by design) and called
`.update({"stage": "transcoding", ...})` on that copy — which was then
discarded. `update_session()`, the function that writes back to the
real store, wasn't even imported. Result: pollers watching a proxy
job's status saw it frozen at "queued / 0%" for the whole transcode,
then jump straight to complete/failed. Fixed by calling
`update_session(session_id, stage="transcoding", message="Transcoding…", pct=5)`
directly. Added `test_proxy_engine_async_progress.py`, which blocks a
faked transcode mid-flight and asserts the session store actually shows
"transcoding"/5% during that window; confirmed it fails pre-fix via a
stash/pop round-trip. Full suite: 277 passed, 7 skipped, same 2
pre-existing Python-3.9 `bit_count()` failures (unrelated, out of scope).

Commits: `177def9`.

## Iteration 79 — VFX Pull's pull report and manifest sidecars shared one filename

`packagePaths.js`'s `pullReportFile` was defined byte-identical to
`manifestFile` (both `${plateName}_manifest.json`) — a copy-paste
mistake. Both are written for the same plate in the same export run
(`_runExrExport` → `nativeWritePullSidecars` writes the Python pull
report first, then `_buildVfxPackageFiles` writes the JS naming
manifest to the same path), so every VFX Pull export silently
clobbered the pull report's retime/geometry/color-match/QC data with
the naming manifest. Fixed by giving `pullReportFile` its own
`_pull_report.json` suffix. Added
`tests-js/packagePaths_sidecarCollision.test.mjs`, which asserts no
two sidecar keys collide; confirmed it fails pre-fix (1/4) and passes
post-fix (4/4) via a stash/pop round-trip. Full suites: Python 277
passed/7 skipped (same 2 pre-existing Iteration-76 failures,
unrelated), JS 0 failures.

Commits: `060024c`.

## Iteration 80 — OCF probe floored NTSC-pulldown fps instead of rounding

`ocf_probe.py`'s `probe_ocf_clip()` computed
`tc_base = fps["num"] // fps["den"]` — floor division instead of
rounding — so 23.976/29.97/59.94 fps clips got `timecodeBase` 23/29/59
instead of the correct nominal 24/30/60. `media_probe.py`'s sibling
code already used `round(fps_val)`, confirming this was a genuine
divergence, not a design choice. Fixed by rounding instead of
flooring. Added `test_ocf_probe_tc_base.py` (4 tests, fake-ffprobe
pattern); confirmed the 3 fractional-rate cases fail pre-fix and pass
post-fix via a stash/pop round-trip. Full suite: 281 passed/7 skipped
(same 2 pre-existing Iteration-76 failures, unrelated).

Commits: `8378d50`.

## Iteration 81 — BRAW backend hardcoded RGBA decode despite acknowledging BGRA is platform-dependent

`braw_backend.py`'s `_save_frame()` had a comment ("BRAW SDK returns
BGRA or RGBA depending on platform... Detect byte order") but the code
unconditionally called
`Image.frombytes("RGBA", (w, h), data, "raw", "RGBA", bpr)` —
`_FRAME_GetResourceType` (vtable slot 6) was defined but had zero call
sites anywhere in the file, so the acknowledged detection was never
implemented. On any platform/GPU where the SDK returns BGRA-packed
frames, every BRAW preview/thumbnail/seek-frame silently had its red
and blue channels swapped. Fixed by calling
`IBlackmagicRawFrame::GetResourceType()` in `_FrameCallback._read_complete`,
threading the result through the decode call chain, and adding
`_raw_mode_for_resource_type()` to pick `"BGRA"` vs `"RGBA"` for both
the Pillow path and the ffmpeg fallback's `-pix_fmt`. Added
`test_braw_backend_bgra.py` (4 tests: helper direct + `_save_frame`
end-to-end via a fake `PIL.Image`); confirmed it fails to even collect
(`ImportError`) pre-fix and passes 4/4 post-fix via a stash/pop
round-trip. Full suite: 285 passed/7 skipped (same 2 pre-existing
Iteration-76 failures, unrelated).

Commits: `dd8c190`.

## Iteration 82 — FFmpeg frame server's cache filename ignored the source clip

`ffmpeg_frame_server.py`'s `decode_frame()` built its output cache
path from only `frame_number` and `output_format`, never from the
source clip `path`. Since the companion HTTP server runs as a
`ThreadingHTTPServer`, two different clips being previewed
concurrently and requesting the same frame number/format computed the
identical output path and raced to write it — one caller could
silently get a frame decoded from the wrong clip. Every sibling cache
in the codebase (`frame_cache.py`'s `make_key()`, the per-backend
cache-key builders) already keys on source path/session; this file was
the outlier. Fixed by adding `_frame_cache_key()`, a SHA256 hash over
`path:frame_number:scale:output_format`, and using it in the output
filename. Added `test_ffmpeg_frame_server_cache_key.py` (4 tests);
confirmed it fails to even collect (`ImportError`) pre-fix and passes
4/4 post-fix via a stash/pop round-trip. Full suite: 289 passed/7
skipped (same 2 pre-existing Iteration-76 failures, unrelated).

Commits: `21910a5`.

## Iteration 83 — `standard_media_backend.py`'s `_frames_to_tc()` used `int(fps)` (truncation) instead of rounding to the nominal whole-frame rate

`get_frame()`'s `"timecode"` field, computed via `_frames_to_tc()`, used
`int(fps)` as the frame-counting divisor. For NTSC-derived rates
(23.976, 29.97, etc. — near-universal in pro delivery), `int(23.976) ==
23` truncates instead of rounding to the nominal `24`, so every still-
frame preview/thumbnail/scrub request through this backend returned a
timecode that drifts further wrong as the frame index grows (whole
seconds off by `frame_index=10000`). This was explicitly flagged as a
known, deferred instance of the bug back in Iteration 49's "Still open"
note, but never revisited — `aaf_export.py`'s sibling instance got fixed
along the way (Iteration 76), this one didn't. Fixed by rounding fps to
its nominal whole-frame rate once (`fps_int = max(1, round(fps))`)
before using it in all four divisions, matching the convention already
used by `aaf_export.py`/`api.py`/`conform_engine.py`. Added
`test_standard_media_backend_ntsc_tc.py` (4 tests); confirmed 3/4 fail
against pre-fix code (whole-fps control case correctly unaffected) and
4/4 pass post-fix via a stash/pop round-trip. Full suite: 293 passed/7
skipped (same 2 pre-existing Iteration-76 failures, unrelated).

Commits: `3e954e2`.

## Iteration 84 — `color_lut.py`'s `_write_cube()` swapped the Red and Blue lattice axes in every IDT LUT

The `.cube` format requires R to vary fastest, then G, then B — but
`_write_cube()` nested its loops `for ri: for gi: for bi:` (B fastest),
with a comment wrongly claiming that was correct. Every camera-family
IDT LUT it generates (ARRI LogC3/LogC4, RED Log3G10, Sony S-Log3, Canon
C-Log2, Panasonic V-Log) is wired into ffmpeg's `-vf lut3d=...` filter
for VFX Pull/EXR renders via `api.py`, so any job with a known camera
IDT applied got its red and blue channels silently swapped. The sibling
generator `tools/gen_aces2_luts.py`'s `write_cube()` already implements
the correct R-fastest convention and is validated against OCIO, but
`color_lut.py`'s independent implementation had never been checked
against that convention. Fixed by swapping the loop nesting to put R
innermost (fastest) and B outermost, and correcting the comment. Added
`test_color_lut_cube_axis_order.py`, which writes a 3x3x3 identity-
transform `.cube` and asserts the lattice increments R first, then G,
then B; confirmed it fails against pre-fix code (row 1 shows B changed
instead of R) and passes post-fix via a stash/pop round-trip. Full
suite: 294 passed/7 skipped (same 2 pre-existing Iteration-76 failures,
unrelated).

Commits: `7b53433`.

## Iteration 85 — `color_lut.py`'s `_logc4_to_lin()` used fabricated ARRI LogC4 decode constants, ~1500x off at 18% grey

`_logc4_to_lin()` claimed to implement "ARRI Alexa 35 LogC4
Specification" but used fabricated constants that don't match ARRI's
real spec. At LogC4's documented 18%-grey code value (0.28), it decoded
to `0.0001217` instead of the correct `~0.1836` — roughly 1500x too
dark, crushing every Alexa 35 IDT LUT used by the VFX Pull/EXR render
path. Independently verified against ARRI's official LogC4
Specification PDF and OpenColorIO's `arri.generate` reference
implementation before fixing (both confirm the same piecewise formula
and constants). Fixed by replacing the constants/formula with the
spec-verified piecewise decode (`a=(2^18-16)/117.45`,
`b=(1023-95)/1023`, `c=95/1023`, plus derived `s`/`t`, branching at
`V=0`) and removing an incorrect `max(0.0, ...)` clamp (the spec's
linear branch can legitimately go slightly negative near code value 0,
matching `_logc3_to_lin()`'s existing unclamped convention). Added
`test_color_lut_logc4_decode.py` (3 tests: 18%-grey value, continuity
at `V=0`, max code value); confirmed 2/3 fail against pre-fix code and
3/3 pass post-fix via a stash/pop round-trip. Full suite: 297 passed/7
skipped (same 2 pre-existing Iteration-76 failures, unrelated).

Commits: `a6f3afc`.

`_log3g10_to_lin()` claimed to implement RED's "Log3G10 Technical
Primer" but used a symmetric, mirrored-log formula with no
black-point offset, instead of the spec's asymmetric decode. At `V=0`
it decoded to `0.0` instead of the correct `-0.01`; at 18%-grey's
encoded value (`1/3`) it decoded to `0.1900008...` instead of
`0.1800008...` — wrong black level and midtone exposure in every RED
Log3G10/IPP2 IDT LUT. Independently verified against RED's official
white paper (915-0187 Rev-C) and a community C reference
implementation before fixing (both confirm the same piecewise formula:
`V<0: L=V/g-c`; `V>=0: L=(10^(V/a)-1)/b-c`, `a=0.224282`,
`b=155.975327`, `c=0.01`, `g=15.1927`). Added
`test_color_lut_log3g10_decode.py` (3 tests: black-point offset,
18%-grey value, negative-branch linear extension); confirmed 3/3 fail
against pre-fix code and 3/3 pass post-fix via a stash/pop round-trip.
Full suite: 300 passed/7 skipped (same 2 pre-existing Iteration-76
failures, unrelated). Second consecutive iteration finding a
spec-mismatch bug in `color_lut.py` — LogC3, S-Log3, C-Log2, and V-Log
remain unaudited.

Commits: `3093eab`.

`_clog2_to_lin()` dropped Canon C-Log2's documented `0.9`
scene-reflectance scale factor entirely (making every decoded value
~11% too bright) and used a wrong branch-cutoff constant (`-0.00218`
instead of `0.092864125`, the code value where `L=0`), so real-world
code values almost never hit the intended negative branch. Canon's
white paper's formulas are embedded as un-extractable images (confirmed
via `pdftotext`), so independently verified instead against the
open-source `colour-science` library's `log_decoding_CanonLog2`
reference implementation, converted from its full-range domain into
this codebase's legal-range domain — confirmed the existing constants
(`0.24136`, `0.092864125`, `87.099375`) were already correct and only
the `0.9` factor and cutoff were wrong. Added
`test_color_lut_clog2_decode.py` (3 tests: 18%-grey value, continuity
at the cutoff, zero-linear at the cutoff); confirmed the 18%-grey test
fails against pre-fix code with the exact old-formula value
(`0.19921875550774326` instead of `0.17929687995696894`) via a
stash/pop round-trip, other 2 tests pass either way (old cutoff is far
from the region they probe). Full suite: 303 passed/7 skipped (same 2
pre-existing Iteration-76 failures, unrelated). Third consecutive
iteration finding a spec-mismatch bug in `color_lut.py` — LogC3,
S-Log3, and V-Log were reported clean by this iteration's scouting
agent but not independently re-verified.

Commits: `317d358`.

## Iteration 88 — `ocf_proxy.py`'s `generate_proxy()` keyed its output filename only on clip basename, causing cross-project proxy collisions

`generate_proxy()` wrote to a single shared `_OCF_PROXY_DIR` whenever
`output_dir` wasn't supplied — the always-taken path in practice, since
the real desktop-app caller (`ocfViewer.js`'s `_startProxy()` →
`ocfEngine.js`'s `ocfGenerateProxy()`) never passes `outputDir` — and
keyed the output filename only on `_safe_stem(clip_path)`, the
sanitized basename. Camera reel/card names commonly reset per shoot
day (e.g. `A001_C001_01.mov`), so two different projects' clips with
the same basename silently overwrite (or, since generation runs
async on a background thread, potentially corrupt via concurrent
writes) each other's proxy, with the QC panel then showing the wrong
project's footage. `proxy_service.py`'s `_stable_proxy_cache_key()`
already documents this exact bug class having been fixed there
previously for IMF proxies (SHA1 of folder+cpl_path+size+mtime) —
`ocf_proxy.py`'s parallel `generate_proxy()` never got the same
treatment. Fix: added `_source_identity_key()` (12-hex SHA1 of
resolved path+size+mtime, mirroring the established pattern) and
mixed it into the output filename. Added
`test_ocf_proxy_filename_identity.py` (3 tests, no prior test file
existed for this module); confirmed genuine via stash/pop — pre-fix
code fails test collection outright (`ImportError`, the helper doesn't
exist). Full suite: 306 passed/7 skipped (same 2 pre-existing
Iteration-76 failures, unrelated). Second instance of bug species #7
(cache/output filename omitting resource identity) — a follow-up
iteration should check other proxy/cache-writing code paths (e.g.
thumbnail/waveform caches) for the same gap.

Commits: `1b0ce99`.

## Iteration 89 — `media_engine/proxy_engine.py`'s `generate_proxy()` also keyed its output filename only on the source stem, colliding on the network-exposed transcode-proxy endpoint

`generate_proxy()` built its output path as `f"{stem}_proxy{ext}"` with no
folder/size/mtime/content-identity signal, where `stem` is just the source
file's basename stem. This module accepted a `source_hash` param that was
stored into sidecar JSON but never used to disambiguate the path, and
`generate_proxy_async()` — the only caller actually reachable from
`http_server.py`'s `/api/media/transcode-proxy` endpoint — doesn't even
forward `source_hash`, making it dead in the real call chain. That HTTP
endpoint reads `sourcePath`/`outputDir` directly from the untrusted request
body with no uniqueness guard, so two source clips sharing a filename stem
(e.g. a reused camera reel name) transcoded to the same `outputDir` collide
and silently overwrite each other's proxy + JSON sidecar. The one existing
related test (`test_proxy_engine_async_progress.py`, Iteration 78) mocks
out `generate_proxy` entirely and doesn't cover this at all. Fix: added
`_source_identity_key()` (12-hex SHA1 of resolved path+size+mtime, mirroring
`ocf_proxy.py`'s Iteration 88 fix and `proxy_service.py`'s original
precedent) and mixed it into the output filename. Added
`test_proxy_engine_filename_identity.py` (4 tests, including a direct
collision regression test that mocks `transcode_proxy` to capture output
paths); confirmed genuine via stash/pop — pre-fix code fails test
collection outright (`ImportError`). Full suite: 310 passed/7 skipped (same
2 pre-existing Iteration-76 failures, unrelated). Third instance of bug
species #7 — the proxy-writing subsystem is now well-covered; a follow-up
should either sweep remaining cache paths (thumbnail/waveform, still
unconfirmed) or pivot to other species/files.

Commits: `c915b4e`.

## Iteration 90 — `http_server.py`'s `_preview_proxy_path()` ignored the available `cache_key`, and its `/cache/lookup/` fallback trusted any file at the collided path with zero identity check

`_preview_proxy_path(out_dir, orig_name)` derived the browser-preview cache
path purely from the sanitized basename of `orig_name`, with no
`cache_key` folded in even though both call sites (`/cache/lookup/`'s
fallback and `/upload/`'s output-path construction) already had one in
scope. Worse than a simple overwrite: `/cache/lookup/`'s fallback (used
when the cacheKey-keyed JSON sidecar lookup misses) accepted any existing
file at that basename-derived path — checking only `is_file()` and
`size > 0`, zero identity check — and returned `{"found": True, ...}`
unconditionally. Two uploads sharing a basename (e.g. the same-named clip
re-uploaded from a different folder/camera card) under different
`cache_key`/session values collided on the identical path; a second
session's `/cache/lookup/` call could land on the fallback and get handed
back the first session's stale, unrelated proxy. No existing test
(`test_http_server.py` covers only token auth/range/path-traversal)
guarded any of this. Fix: added an optional `cache_key` parameter to
`_preview_proxy_path()`, sanitized and folded into the filename stem when
present (falls back to basename-only when empty), and updated both call
sites to pass their already-available `cache_key` through. Added
`test_http_server_preview_cache_identity.py` (3 tests, including the
direct same-basename/different-cache_key collision regression); confirmed
genuine via stash/pop — pre-fix code fails all 3 with `TypeError:
_preview_proxy_path() takes 2 positional arguments but 3 were given`. Full
suite: 313 passed/7 skipped (same 2 pre-existing Iteration-76 failures,
unrelated). Fourth instance of bug species #7 — now very well-covered
across cache/proxy subsystems broadly; a follow-up should strongly
consider pivoting to other species/files, or one final narrow check of
thumbnail/waveform caches if still unconfirmed.

Commits: `9177200`.

## Iteration 91 — `avf_bridge.swift`'s `batchExtract()` used a plain `CMTimeValue -> Int` map as a callback identity key, silently dropping frames when two requests clamp to the same timestamp

`batchExtract()` in `electron/native/avf_bridge.swift` (a standalone
Swift script, compiled via `swiftc`, invoked as a subprocess by
`media_engine.js` to serve `getStill`/`getStills`/`getHeroFrames`)
matched each `generateCGImagesAsynchronously(forTimes:)` completion
callback back to its request via `timeToIndex: [CMTimeValue: Int]`, built
with last-write-wins semantics. Multiple `FrameSpec`s in a batch routinely
clamp to the same frame number via `min(..., maxF)` (e.g. several
hero-frame offsets landing on `maxF` for a short clip), producing
identical `CMTime` values and thus identical dictionary keys. Apple's
generator still calls back once per element including duplicates, so
`remaining` reaches 0 and the continuation resolves normally with no
error — but both duplicate-time callbacks resolved to the same (higher)
index, one harmlessly overwriting the other, while the lower colliding
index's output slot was never written and stayed the empty placeholder
`{}` — no `ok`/`label`/`error`/`dataUrl` key at all. Any
`getHeroFrames`/`getStills` batch on a short clip where offsets clamp
together would return a `frames` array with correct length but bare `{}`
holes, breaking any consumer assuming every element has an `ok` key
(likely a silent blank thumbnail or a crash on `frame.error.*`). No
existing test/CI touches this file at all (`npm test` doesn't run it; no
Swift/XCTest harness exists in the repo). Fix: replaced the map with
`timeToIndices: [CMTimeValue: [Int]]`, a per-key queue of indices; each
callback invocation pops one index off its key's queue under the existing
`NSLock`, so every duplicated-time callback claims a distinct index
instead of colliding. Verified end-to-end with a synthetic 8-frame/8fps
ffmpeg test clip (`maxF=7`): a pre-fix binary compiled via `git
stash`-reverted source produced a bare `{}` for one of two colliding
requests (frames 20 and 999, both clamping to 7); the fixed binary
returned all 5 requested entries with `ok: true` and correctly matching
labels. `swiftc -typecheck`/full build clean both before and after.
Full companion suite unaffected: 313 passed/7 skipped (same 2
pre-existing Iteration-76 failures). Eleventh, genuinely new bug
species — "non-unique key used as an identity map" in batch async-callback
dispatch. No automated regression test added (no harness exists for this
file to hang one on); a follow-up could check whether the separate,
unexplored `electron/native/PFXNativeMediaEngine/` Swift package shares
this pattern if it's actively used.

Commits: `fe1d2c1`.

## Iteration 92 — `PFXNativeMediaEngine`'s `probeAsset()` truncated `duration * fps` instead of rounding, silently reporting one frame fewer than a clip actually has

Following up on Iteration 91's flag to check the separate, actively-used
`electron/native/PFXNativeMediaEngine/` Swift package (confirmed live via
`pfx_native_engine.js`/`ipc.js`/`preload.js`, not dead code), found
`probeAsset()` computing `frameCount` as `Int(durationSec * fps)` —
truncating rather than rounding a value that two independent
rational-to-double conversions (`CMTimeGetSeconds` on the asset's
duration, and the track's `nominalFrameRate`) routinely land a hair under
its true integer boundary (e.g. `119.99999999999999` instead of `120.0`)
for non-integer timebases like `30000/1001` (29.97fps). Sibling function
`tcToFrame()` already correctly uses `Int(fps.rounded())`, confirming this
was an inconsistency rather than intentional. `frameCount` is used
downstream as a seek-clamp upper bound
(`min(f, s.info.frameCount - 1)`), so an off-by-one-low value makes a
clip's true last frame permanently unreachable via seek/thumbnail/
playback. Fix: `Int((durationSec * fps).rounded())`. Verified end-to-end
against the package's HTTP server: built a real 120-frame,
64x64, 29.97fps `.mov` via `ffmpeg` (confirmed via `ffprobe`:
`duration=4.004000, nb_frames=120`); pre-fix binary (`git stash` on just
`MediaEngine.swift`) returned `frameCount: 119` for a `media.probe`
request against this clip; post-fix binary returned `frameCount: 120`,
with `fps`/`duration` unchanged. `swift build -c release` clean both
before and after (pre-existing warnings only). Full companion suite
unaffected: 313 passed/7 skipped (same 2 pre-existing Iteration-76
failures). This is a new instance of bug species #8 (truncation instead
of rounding on an fps-derived value), in a different conversion context
(`duration * fps -> frameCount`) than its earlier instances. No automated
regression test added — this package has no XCTest target (Command Line
Tools only; only a plain-executable check harness exists, aimed at the
SQLite `PFXMediaCore` library, not `MediaEngine`). Several other files in
this package (`ThumbnailGenerator.swift`, `WaveformGenerator.swift`,
`ProxyCreator.swift`, `RenderEngine.swift`, `HTTPServer.swift`,
`IMFEngine.swift`) remain unexamined for these bug species — worth a
follow-up scouting pass.

Commits: `9a40200`.

## Iteration 93 — `imf_frame_provider.js`'s `decodeFrame()` keyed its preview cache on raw `displayMode`, ignoring `lowres` — letting a low-res scrub request silently return a stale/mismatched full-res frame

`decodeFrame()`'s cache-read and cache-write both keyed on plain
`displayMode` (e.g. `"sdr"`), dropping the `lowres` level that the
peer decode path (`requestFrame()`/`_cacheHit()`, same file) already
folds in via a local `_cacheMode(displayMode, lowres)` helper — and that
`imf_cache.js`'s `_safeVariant()` was explicitly built to carry (its
comment names `"sdr.lr2"` as a legitimate variant key). Effect: a
full-res decode caches at `"sdr"`; a later low-res scrub-preview request
for the same frame reads that same key and gets served the full-res
image as if it were the low-res one, and vice versa for whichever variant
writes first. Fix: `decodeFrame()` now computes `const cmode =
_cacheMode(displayMode, lowres)` once and uses it at both the read and
write sites, matching `_cacheHit()`'s existing pattern exactly.

Verified with a standalone Node harness driving the real module directly
against a synthetic package/CPL and pre-populated cache. First harness
attempt gave a false pass in both directions — two bugs in the harness
itself: a non-existent fake `cplPath` tripped an earlier `CPL_NOT_FOUND`
gate before the cache-check code ever ran, and the project's own
installed `node_modules/electron` (a plain string, not `{app}`) always
wins module resolution over an `NODE_PATH` stub, so `app.getPath`
throws and the cache silently falls back to bare `os.tmpdir()` — not the
directory the harness pre-populated. Fixed both, then confirmed
genuinely: pre-fix code returned `fromCache: true` for the low-res
request (bug reproduced against a real synthetic cache collision);
post-fix code correctly missed the full-res-only entry. Full regression
clean: `npm run test:node` 72/73 (1 pre-existing skip), `npm run test:js`
47/47.

Still open: the renderer's playback-time persist path
(`_persistFrameToCache()` in `imf_player.js`) also writes this cache
using raw `displayMode`, with no discriminator for its own continuous
`decodeScale` reduction — a related but architecturally distinct risk,
deliberately scoped out of this fix and flagged for a follow-up.

Commits: `11b64c5`.

## Iteration 94 — `IMFEngine.swift`'s `seekFrame()`/`stepFrame()`/`grabThumbnail()` built their pfx-helper scratch-file path from only `packageId`+`frame`, letting two concurrent requests for the same frame clobber or delete each other's temp file

Following up on Iteration 92's flag to check the remaining unexamined
`PFXNativeMediaEngine` files, found all three of `IMFEngine.swift`'s
frame-extraction entry points constructing their temp JPEG output path
(handed to the separate `pfx-helper` child process, then read back and
deleted) from only `packageId` and the frame number — e.g.
`pfx_native_\(packageId)_\(frame).jpg`. Two concurrent requests for the
same package/frame (a routine scrub-and-thumbnail overlap) collide on
this identical path: whichever request's helper writes second clobbers
the first's file mid-read, and whichever request cleans up first
deletes the file out from under the other, so a caller can silently
receive the wrong frame's image data or an outright read failure.
Confirmed reachable in production: `CommandRouter.swift` routes
`imf.seekFrame`/`imf.stepFrame`/`imf.grabThumbnail` straight to these
methods as live HTTP command targets, not dormant code. This is a new
instance of bug species #7 (a discriminating identity key silently
dropped across "the same resource"'s call sites) — here applied to a
temp-file naming scheme rather than an in-memory/on-disk cache key, as
in Iteration 93. Fix: append `_\(UUID().uuidString)` to all three tmp
path constructions so concurrent requests never share a path.

Full end-to-end verification (opening a real IMF session against the
external `pfx-helper` binary and a real MXF package) is infeasible in
this sandbox — no such fixture exists and building one is out of scope
for a temp-filename defect. Instead, extracted the exact vulnerable
path-construction logic (pre-fix and post-fix forms) verbatim into a
standalone Swift script that models the real race directly: two
concurrent "requests" write their own frame data to their tmp path,
then read-and-delete in the order the real race would produce.
Pre-fix construction reproduced both real failure modes in one
deterministic run — the first request read back the second request's
data (wrong frame silently served), and the second request's own file
had already vanished under it (`<missing>`). Post-fix construction
gave each request back exactly its own data, uncorrupted. `swift build
-c release` clean before and after (pre-existing warnings only). No
automated regression test added — this package still has no XCTest
target (Command Line Tools only). Full regression clean: `npm run
test:node` 72/73 (1 pre-existing skip), `npm run test:js` all suites
passed, `python3 -m pytest -q` 313 passed/7 skipped (same 2
pre-existing Iteration-76 failures).

Still open: this closes out Iteration 92's flagged list of unexamined
`PFXNativeMediaEngine` files. Iteration 93's `_persistFrameToCache()`
follow-up (raw `displayMode` cache key, no `decodeScale` discriminator)
remains open for a future iteration.

Commits: `1fd7c04`.

## Iteration 95 — `imf_frame_provider.js`'s `decodeFrame()` built its own ffmpeg scratch-file path from only `packageHash`+`frameNumber`, letting two concurrent requests for the same frame clobber or delete each other's temp file

Following up on Iteration 94's fix (same defect shape, different
subsystem), found `decodeFrame()`'s own ffmpeg output path — `outPath`,
used for the ffmpeg write, the cache-copy read, and the cleanup
unlink — built from only `packageHash`+`frameNumber`
(`pfx_imf_${packageHash}_fr${frameNumber}.png`), even though the same
function already computes a proper `cmode = _cacheMode(displayMode,
lowres)` for its cache read/write (Iteration 93's fix). Two concurrent
decode requests for the same frame at different resolutions/modes
collide on this shared temp path: the loser's `copyFileSync` can read
back the winner's data, and both requests race to `unlinkSync` it,
so the loser can find its own file already deleted.

Fixed by suffixing `outPath` with `require('crypto').randomUUID()`,
mirroring Iteration 94's Swift `UUID().uuidString` fix and the
established `crypto.randomUUID()` idiom already used elsewhere in this
codebase (`prep_mark.js`, `fdlGenerator.js`, `shotWorkItems.js`).
One-line change; `cmode`'s cache-key logic was already correct and
untouched.

No real ffmpeg/IMF fixture exists to drive `decodeFrame()` end-to-end,
so verified by extracting the exact pre-fix/post-fix path-construction
and copy-then-unlink logic into a standalone Node script simulating two
concurrent requests. Pre-fix: request A read back request B's data,
request B's own file was missing after the cleanup race — exit 1, both
failure modes reproduced. Post-fix: both requests read back only their
own data — exit 0. Fix isolated via `git add -p` from an unrelated
pre-existing uncommitted Metal HTJ2K WIP block already present in the
same file — left completely untouched. Full regression clean: `npm run
test:node` 72/73 (1 pre-existing skip), `npm run test:js` all suites
passed, `python3 -m pytest -q` 313 passed/7 skipped (same 2
pre-existing Iteration-76 failures).

Still open: third instance of the same identity/cache-key-drop species,
now confirmed across three subsystems of the IMF frame pipeline
(Iteration 93's cache key, Iteration 94's Swift temp path, this
iteration's JS temp path). Iteration 93's `_persistFrameToCache()`
follow-up remains open.

Commits: `2cd24af`.

## Iteration 96 — OCF decode/resolve-bridge temp filenames ignored `scale`

`ocf_decode.py`'s `_decode_avf`/`_decode_ffmpeg`/`_decode_proxy_frame` and
`ocf_resolve_bridge.py`'s `resolve_decode_frame()` all built their
scratch/lookup filename from only `clip_path`+`frame_number`, dropping the
`scale` parameter each function actually receives. A low-res scrub
thumbnail request and a full-res export-check request for the same frame
collide on the same on-disk filename; `_decode_proxy_frame`'s lookup side
made it worse by returning any previously cached file at that key
regardless of the scale that produced it. Fifth confirmed instance of the
species #7 pattern (Iterations 93-95 were the IMF pipeline; this is the
sibling OCF pipeline). Fixed by adding a `_s{scale}` suffix to the key in
all four call sites. `_render_queue_still()`'s separate hardcoded-1920x1080
fallback (which has no `scale` param at all) is a distinct bug, left open.
`python3 -m pytest -q`: 313 passed/7 skipped, same 2 pre-existing failures
as baseline.

Commits: `8846ceb`.

## Iteration 97 — decodeTestFrame's ffmpeg output PNG used a static filename

`electron/ipc.js`'s `pfx:imf:decodeTestFrame` handler (both the MXF-fallback
and primary IMF-demuxer branches) wrote its debug decode output to a
hardcoded `postflowx_imf_frame_000000.png` — no `frameNumber`, `cplPath`, or
call-scoping at all, unlike prior instances that at least dropped one
dimension of the key. Concurrent clicks of the "Decode Test Frame" button
(or two windows both exercising it) race on the same file: one call's
`ffmpeg -y` overwrite can clobber another's in-flight read, or silently hand
back the wrong call's frame image. Sixth confirmed instance of species #7,
first found outside the IMF-frame-provider/OCF pipelines. Fixed by keying
the filename on `process.pid`+`frameNumber`+timestamp in both branches.
`electron/ipc.js` had substantial unrelated pre-existing WIP; isolated the
two intended hunks via `git add -p`. `npm run test:node` (72/1/73) and
`npm run test:js` (25 passed) both match baseline.

Commits: `527a6b8`.
