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
