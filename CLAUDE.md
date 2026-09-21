# PostFlowX

VFX post-production desktop app. Electron main process + a shared HTML/ES-module
renderer, plus a Python companion server for OCF/FFmpeg/delivery work and native
macOS bridges (AVFoundation, DaVinci Resolve).

See `PROJECT_MAP.md` for the full tree, runtime target differences, and platform guards.

## One source, two targets
`src/` is the single source of truth for the renderer. `build-renderer.js` copies it
into `dist/<target>/`:
- **Desktop app** (`electron/` + `dist/desktop/`) — Chrome APIs shimmed via
  `electron/preload.js` → `electron_shim.js`. Detect with `window.pfxPlatform?.isMacApp`.
- **Chrome extension** (`extension/` + `dist/extension/`) — native `chrome.*`.
  Detect with `window.__PFX_TARGET__ === 'extension'`.

## Common commands
- `npm run dev` — quick dev, loads `src/` directly (no build step)
- `npm run build:renderer` — rebuild desktop renderer (run after any UI change before packaging)
- `npm run build:mac-dir` — package an unsigned macOS .app locally
- `npm run build:mac` — full signed/notarized release build
- `npm run build:extension` — build + load `dist/extension/` as an unpacked extension

## Tests
- `npm test` — Node tests + `tests-js/*` + Python companion pytest
- `npm run test:node` — parser/pipeline/color tests only (`test/`)
- `npm run test:js` — `tests-js/*.test.mjs`

## Where things live
- Shared UI / features → `src/scripts/features/`, `src/scripts/modules/`
- EDL / FCPXML / OTIO parsers → `src/scripts/parsers/`
- Desktop-only native work → gate with `window.pfxPlatform?.isMacApp`; add IPC in
  `electron/ipc.js`, expose in `electron/preload.js`
- Python companion → `companion/companion_server.py`
- Native bridges → `electron/native/` (`avf_bridge.swift`, `resolve_bridge.py`, `media_engine.js`)

## Notes
- `dist/` is generated (git-ignored). Never edit `dist/**` or anything inside the
  packaged `dist/mac-arm64/PostFlowX.app` — change `src/`/`electron/` and rebuild.
- Build runbook: `BUILD_MAC_RUNBOOK.md`.
