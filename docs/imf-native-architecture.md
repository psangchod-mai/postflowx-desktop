# PostFlowX IMF Native Companion Architecture

## Goal

Make IMF playback and QC feel built into PostFlowX for non-technical users on macOS and Windows.

User experience target:

- Install `PostFlowX` once
- Click `Load IMF`
- Click `Play` / `Proxy QC`
- Never manually install `ffmpeg`, `IMFTool`, codecs, or native helpers

Related spec:

- [IMF Companion API Spec](./imf-companion-api-spec.md)

## Product Principle

The Chrome extension remains the main UI.

All difficult IMF work moves into a bundled native companion that is invisible to normal users.

## High-Level Architecture

```text
+----------------------+
| Chrome Extension UI  |
| PostFlowX tabs       |
+----------+-----------+
           |
           | Native messaging / localhost bridge
           v
+----------------------+
| PostFlowX Companion  |
| macOS / Windows app  |
| Local service layer  |
+----+------------+----+
     |            |
     |            |
     v            v
+---------+   +------------------+
| IMF Core|   | Media Toolchain  |
| package  |   | proxy / playback |
| parse/QC |   | transcode / logs |
+---------+   +------------------+
     |
     v
+----------------------+
| Optional IMF Engine  |
| IMFTool-based path   |
| or internal engine   |
+----------------------+
```

## Responsibilities

### 1. Chrome Extension

Owns:

- project UI
- IMF Validation screens
- playback controls
- timeline overlays
- QC result rendering
- project save/load state

Does not own:

- IMF demuxing
- hard codec handling
- IAB / Dolby Atmos decoding
- CPL-to-proxy rendering
- heavy package inspection

### 2. Native Companion

Owns:

- package discovery
- CPL / PKL / ASSETMAP indexing
- proxy generation
- playback session management
- QC job execution
- local cache
- engine capability detection
- logs / diagnostics

The companion should expose a stable local API so the extension does not care whether the underlying engine is:

- bundled ffmpeg
- bundled IMF engine
- IMFTool-backed implementation
- future internal renderer

### 3. IMF Engine Layer

This is the interchangeable backend.

Possible implementations:

- `Engine A`: current lightweight internal parser + media tools
- `Engine B`: IMFTool-backed path for difficult packages
- `Engine C`: future dedicated internal IMF engine

PostFlowX should route by capability, not by user choice when possible.

## Recommended Runtime Flow

### Load IMF

1. User clicks `Load IMF`
2. Extension asks companion to choose folder
3. Companion scans package and returns:
   - package summary
   - CPL list
   - playable status
   - audio type
   - Dolby Vision / IAB / ProRes flags
4. Extension renders the IMF UI

### Play IMF

1. Extension requests `startPlayback(cplId)`
2. Companion selects best playback path:
   - direct IMF playback if supported
   - full-CPL proxy render if required
3. Companion returns a local stream/session URL
4. Extension uses the existing shared viewer

### Proxy QC

1. Extension requests `buildProxy(cplId)`
2. Companion renders whole-CPL proxy
3. Extension polls session progress
4. Extension switches viewer mode to `Proxy`

### QC

1. Extension requests `runQc(cplId, checks)`
2. Companion runs package/media checks
3. Extension displays structured findings

## Capability Routing

The companion should auto-pick the engine using package traits.

### Use lightweight internal path when:

- standard JPEG2000 IMF
- no immersive audio dependency for playback
- no unsupported demux requirement
- basic proxy/QC is enough

### Use advanced engine path when:

- IAB / Dolby Atmos present
- ProRes IMF present
- IMF demuxer unavailable in bundled ffmpeg path
- Dolby Vision metadata path needs better support
- current internal fallback cannot guarantee full-CPL playback

## Core Companion API

Keep the API engine-agnostic.

### Session and package

- `ping()`
- `getVersion()`
- `getCapabilities()`
- `pickImfFolder()`
- `scanImfPackage(folderPath)`

### Playback

- `startImfPlayback(packageId, cplId, options)`
- `startProxyPlayback(packageId, cplId, options)`
- `stopPlayback(sessionId)`
- `getPlaybackStatus(sessionId)`

### Proxy / transcode

- `buildProxy(packageId, cplId, options)`
- `getJobStatus(jobId)`
- `cancelJob(jobId)`

### QC

- `runImfQc(packageId, cplId, checks)`
- `getQcStatus(jobId)`
- `getQcResults(jobId)`

### Diagnostics

- `getJobLog(jobId)`
- `getEngineInfo()`
- `getLastError()`

## Packaging Strategy

### macOS

Bundle:

- PostFlowX Companion.app
- native messaging host manifest
- IMF engine binaries/libraries
- bundled media tools

Needs:

- notarization
- code signing
- auto-updater

### Windows

Bundle:

- PostFlowX Companion
- native messaging host registration
- IMF engine binaries/libraries
- bundled media tools

Needs:

- signed installer
- native host registry setup
- auto-updater

## User Experience Rules

For non-technical users:

- never say `install ffmpeg`
- never say `install IMFTool`
- never expose codec names unless inside an advanced log view
- never require terminal steps
- always offer one-click recovery:
  - `Retry`
  - `Rebuild Proxy`
  - `Open Logs`

Good messages:

- `Loading IMF package…`
- `Preparing playback…`
- `Building proxy…`
- `Immersive audio not available in fast path, switching engine…`

Bad messages:

- `IMF demuxer missing`
- `ffmpeg not found`
- `TrackFileId`
- raw stderr dumps in the main UI

## IMFTool Fit

IMFTool is a strong candidate for the advanced engine path because it appears to support:

- IMF package browsing
- playback-oriented package handling
- Photon QC reports
- IAB / S-ADM / ADM support
- ProRes support
- macOS and Windows builds

But it should be treated as an engine implementation detail, not something users install themselves.

## Important Constraints

### Licensing

If IMFTool code or components are embedded directly, review GPL-3.0 implications before shipping.

### Engine abstraction

The extension must not depend on IMFTool-specific behavior.

### Full-CPL playback

The companion should think in terms of:

- package
- CPL
- whole timeline

Not:

- one MXF file
- one clip

## Suggested Delivery Phases

### Phase 1: Stabilize current helper

- full-CPL proxy fallback
- better package picker
- clearer errors
- preserve current extension UX

### Phase 2: Introduce companion API

- replace ad hoc helper commands with versioned local API
- add capability detection
- add structured job progress/log endpoints

### Phase 3: Bundle media stack

- ship ffmpeg/media tools with companion
- remove user dependency on external installs

### Phase 4: Advanced IMF engine

- integrate IMFTool-style advanced path
- route IAB / ProRes / hard IMF cases automatically

### Phase 5: Hide complexity completely

- one installer
- silent updates
- background health checks
- support bundle export for bug reports

## Recommended Immediate Next Build

Build toward this milestone:

`PostFlowX Companion v1`

Scope:

- packaged native companion for macOS first
- stable local API
- bundled media tools
- whole-CPL proxy generation
- shared viewer playback session
- structured QC job progress

Then port the same companion contract to Windows.
