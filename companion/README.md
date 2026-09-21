# PostFlowX Companion

The Python companion is PostFlowX's **media / OCF / color engine**. It owns all the
heavy media work — camera-RAW decode, FFmpeg probe/transcode, OCF→EXR VFX pulls,
DaVinci Resolve automation, AMF/OCIO color, and QC — so the Electron UI never has
to decode heavy footage itself.

> PostFlowX is a **macOS Electron app**, not a Chrome extension. The companion is
> driven by the Electron main process over IPC, not by a browser. (A Chrome
> extension build still exists for the lightweight cut/timeline tools, but it is
> not the path that uses this companion's media engine.)

## Architecture

```text
Electron Renderer / UI         Timeline, Visual QC, Cut Diff, VFX Pull, AMF, review
        │  (preload pfxPlatform / IPC)
Electron Main Process          file pickers, permissions, lifecycle, job orchestration
        │  (stdio / native-messaging transport — see native_host.py)
Python Companion (this folder) ── the media engine ──────────────────────────────
        ├─ FFmpeg / ffprobe         probe, transcode, proxy, EXR pull
        ├─ AVFoundation bridge      MOV/MP4/ProRes/H.264/HEVC preview (electron/native/avf_bridge)
        ├─ vendor RAW backends      BRAW / RED R3D / ARRI / ProRes RAW
        ├─ DaVinci Resolve bridge   camera-RAW decode + still/EXR render fallback
        └─ OIIO / OpenEXR / OCIO    plate + QC + color transforms
```

Core rule: **the UI must not decode heavy OCF directly.** It asks the companion for
metadata, a frame, a proxy, an EXR pull, or a QC result.

## Action groups (control-channel API)

Registered in `api.py` (dispatch map) and gated in `native_host.py`:

- `media.*` — `mediaOpenFile`, `mediaGetMetadata`, `mediaGetFrame`, `mediaPrefetch`,
  `mediaGetBackendStatus`, session/cache management
- `ocf.*` — `ocfScan`, `ocfProbeFile`/`ocfProbeFolder`, `ocfEngineProbe`,
  `ocfSelectEngine`, `ocfDecodeFrame`, `ocfGenerateProxy`, EXR export
- `vfx.preview.*` — `resolveStill`, `resolveStillBatch` (OCF strip), `avfStill`
- pull / QC — `renderPullExrStart`, `pull` status/cancel, `qcExrSequence`
- `resolve.*` — `resolveDetect`, `resolveStartBackground`, `resolveRunJob`,
  `resolveProbeClips`, `resolveStopEngine`
- interchange — `exportNLELinkedAAF`, `exportProToolsAAF`
- `helper.capabilities` — backend/SDK availability for the UI

## Backend routing

The media runtime (`media/media_runtime.py` + `media/media_backend_registry.py`)
picks a backend per format and reports a status the UI surfaces as a badge
(`READY` / `PREVIEW_ONLY` / `METADATA_ONLY` / `SDK_MISSING` / `UNAVAILABLE`):

| Media / OCF | Primary | Fallback |
|---|---|---|
| MOV/MP4 H.264/HEVC/ProRes | AVFoundation / FFmpeg | Proxy |
| MXF ProRes/DNxHR | FFmpeg | Resolve |
| BRAW | Blackmagic RAW SDK | Resolve |
| RED R3D | RED R3D SDK | REDline / Resolve |
| ARRIRAW / ARI / ARX | ARRI Image SDK / Reference Tool | Resolve |
| Sony X-OCN | Resolve | Proxy |
| EXR/DPX sequence | OpenImageIO / OpenEXR | FFmpeg (limited) |

Vendor RAW SDKs are **detected, not bundled** (license). `helper.capabilities` /
`ocfNativeSdks` report what's installed so the UI never implies final-quality
decode when an SDK is missing.

## Layout

```text
companion/
  manifests/                native-messaging manifest templates (macOS / Windows)
  scripts/                  install_dev_macos.sh, install_easy_macos.command, …
  protocol/                 native-helper protocol (json + ts)
  tests/                    pytest suite
  src/postflowx_companion/
    api.py                  action dispatch (the API surface)
    native_host.py          stdio transport + action allow-list
    http_server.py          local progress/log/stream endpoints
    proxy_service.py        FFmpeg discovery (_resource_bin) + proxy/EXR helpers
    media/                  media_runtime, backend_registry, frame cache, ring buffer
      backends/             standard, prores_native, prores_raw, braw, r3d, arri
    ocf_engine/             ocf_router, ocf_probe, ocf_decode, ocf_proxy, ocf_color,
                            ocf_scanner, ocf_resolve_bridge
    engines/                resolve_engine (background Resolve lifecycle)
    safe_xml.py             XXE-safe XML parsing (all companion XML routes here)
```

## Native binaries (ffmpeg / ffprobe)

Production must NOT rely on a dev machine's Homebrew — a Finder-launched app has a
stripped PATH. Discovery prefers a **bundled** binary at
`PostFlowX.app/Contents/Resources/bin/<name>` (via `proxy_service._resource_bin`;
the Electron side mirrors this in `electron/native/ffbins.js`). Drop real
`ffmpeg`/`ffprobe` into the repo `bin/` folder to have them packaged — see
`bin/README.md`. `PFX_FFMPEG_BIN` / `PFX_FFPROBE_BIN` override everything.

## Development

```bash
# run the test suite
cd companion && PYTHONPATH=src pytest -q
```

- **In the Electron app** the companion ships inside the bundle as `extraResources`
  (`PostFlowX.app/Contents/Resources/companion/`) and is launched by the Electron
  main process (`electron/companion.js`) — there is no separate install step.
- The `scripts/install_dev_macos.sh --extension-id <id>` script is for the **legacy
  Chrome-extension** native-messaging path only; it is NOT needed for the Electron app.
- The companion uses only the Python standard library at its core (vendor SDKs and
  OIIO/OCIO are optional, detected at runtime).
- XML parsing must go through `safe_xml.py` (enforced by the repo's XXE gate).
