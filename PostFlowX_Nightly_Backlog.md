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
- [ ] N1. Map actual implementation state vs the three goals. For VFX pull (`features/vfxPull`, `ocf_engine`, `ocf_exr_handler.js`), IMF validation/playback (`imfValidator`/`imfXml` tests, `j2k_decoder`, `mpv_engine.js`, `media_engine.js`, `native_router/smart_router`), and automation: record what WORKS, what's PARTIAL, what's MISSING. Rewrite the A/B/C/D items below to match reality, then proceed.

### Epic A — IMF Validation
- [ ] A1. Confirm/extend IMF validation coverage (CPL/PKL/ASSETMAP, essence hashes, edit-rate); align with Netflix Photon checks. Plain-language pass/warn/fail with `userMessage`+`howToFix`.
- [ ] A2. Wire/verify validation surfacing into UI via native command + a JSON fixture.

### Epic B — VFX Pull
- [ ] B1. Strengthen OCF probe + conform (EDL/FCPXML/OTIO → per-shot pulls, operator handles, source TC).
- [ ] B2. EXR export job: OpenEXR seq, ACES2065-1 target, OCIO transform; non-blocking job + status.
- [ ] B3. Pull manifest (shot, reel, TC in/out, handles, color xform, paths) JSON + human-readable.

### Epic C — Playback engine routing
- [ ] C1. Verify/extend engine routing: ProRes/HEVC/H.264/proxy → AVFoundation (`avf_bridge`/`media_engine.js`); J2K/IMF → mpv/J2K path (`mpv_engine.js`/`j2k_decoder`). One protocol via `native_router`/`smart_router`.
- [ ] C2. Frame-accurate seek/step/thumbnail parity across both engines.

### Epic D — Automation for non-tech users
- [ ] D1. Watch-folder auto-detect → propose one action.
- [ ] D2. Shareable JSON presets (IMF QC / ARRI ACES pull 8f / ProRes proxy).
- [ ] D3. Guided error recovery everywhere (`userMessage`+`retryable`+one next step).
- [ ] D4. Plain-language job queue/progress.

### Epic E — Build & Audit (every night)
- [ ] E1. `npm run build-verify` style script wrapping the sandbox-safe checks above.
- [ ] E2. Tests for new modules.
- [ ] E3. Security hardening pass (defused XML, subprocess, IPC/path validation).
- [ ] E4. Maintain `BUILD_MAC_RUNBOOK.md` — the Mac-side build/sign/notarize steps for the Claude Code terminal.
- [ ] E_rolling. Rotating audit of one existing area per night.

---

## Progress Log
_(Newest on top. First nightly run starts here.)_

<!-- TEMPLATE
### YYYY-MM-DD (night run)
- Items done: N1
- Files changed: src/scripts/features/vfxPull/..., companion/...
- Build: PASS (node --test X passed, pytest Y passed, node --check clean) | FAIL + what
- Audit: 0 high / 1 med / 2 low; rotating area: electron/preload.js
- Blocked: macOS native build/sign = terminal hand-off (see BUILD_MAC_RUNBOOK.md)
- Next: A1
-->
