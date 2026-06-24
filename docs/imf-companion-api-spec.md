# PostFlowX IMF Companion API Spec v1

## Purpose

> Note: source-media timecode / thumbnail / frame-step transport for the future native playback helper are tracked separately in `companion/protocol/native-helper-protocol-v1.json` and `companion/protocol/native-helper-protocol-v1.ts`.


Define the local API between the PostFlowX extension and the future native companion on macOS and Windows.

This spec is designed to:

- match the current PostFlowX helper patterns where possible
- support a bundled invisible companion app
- remain engine-agnostic
- support playback, proxy, and QC for full-CPL IMF workflows

## Design Goals

- stable contract across macOS and Windows
- clear separation between UI and media engine
- no raw engine details exposed to non-technical users
- support whole-CPL operations, not single-clip assumptions
- forward-compatible with IMFTool-backed or internal engines

## Transport Model

The companion uses two local channels:

### 1. Control Channel

Used for commands and metadata responses.

Preferred options:

- Chrome native messaging
- local loopback RPC wrapper if desktop app packaging later replaces native messaging

Data shape:

- JSON request
- JSON response

### 2. Session Channel

Used for streaming and progress polling.

Preferred options:

- local HTTP server on `127.0.0.1`

Used for:

- media stream URLs
- progress URLs
- Dolby Vision metadata URLs
- logs

## Versioning

Every control response should include:

- `apiVersion`
- `companionVersion`

Example:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0"
}
```

## ID Rules

- `packageId`: stable for the loaded package in the current session
- `cplId`: stable UUID or CPL identifier
- `sessionId`: playback session identifier
- `jobId`: long-running task identifier

IDs should be opaque to the extension.

## Common Response Envelope

All control-channel responses should follow this envelope:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {}
}
```

Error envelope:

```json
{
  "status": "error",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "error": {
    "code": "ENGINE_UNAVAILABLE",
    "message": "Playback engine unavailable",
    "userMessage": "Playback service is unavailable. Try again.",
    "retryable": true
  }
}
```

## Error Codes

Use stable machine-readable codes.

- `BAD_REQUEST`
- `NOT_FOUND`
- `CANCELLED`
- `ENGINE_UNAVAILABLE`
- `ENGINE_UNSUPPORTED`
- `PACKAGE_INVALID`
- `PACKAGE_UNREADABLE`
- `PLAYBACK_FAILED`
- `PROXY_FAILED`
- `QC_FAILED`
- `JOB_NOT_FOUND`
- `SESSION_NOT_FOUND`
- `TIMEOUT`
- `ACCESS_DENIED`

## Capability Model

The extension should ask for capabilities at startup.

### `getCapabilities`

Request:

```json
{
  "action": "getCapabilities"
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "platform": "macos",
    "engines": [
      {
        "id": "internal-fastpath",
        "label": "Internal Fast Path",
        "kinds": ["playback", "proxy", "qc"]
      },
      {
        "id": "advanced-imf",
        "label": "Advanced IMF Engine",
        "kinds": ["playback", "proxy", "qc", "immersiveAudio", "prores"]
      }
    ],
    "features": {
      "imfPlayback": true,
      "fullCplProxy": true,
      "dolbyVisionMetadata": true,
      "iabDecode": false,
      "admDecode": false,
      "proresImf": true,
      "photonQc": true
    }
  }
}
```

## Core Commands

### `ping`

Health check.

Request:

```json
{
  "action": "ping"
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "ready": true
  }
}
```

### `getVersion`

Request:

```json
{
  "action": "getVersion"
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "build": "2026.04.08",
    "platform": "windows"
  }
}
```

## Package Loading

### `pickImfFolder`

Opens a native folder picker.

Request:

```json
{
  "action": "pickImfFolder"
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "folderPath": "C:/Media/PackageA"
  }
}
```

Cancel response:

```json
{
  "status": "error",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "error": {
    "code": "CANCELLED",
    "message": "User cancelled folder picker",
    "userMessage": "Package selection cancelled.",
    "retryable": true
  }
}
```

### `scanImfPackage`

Scans a package and returns the IMF structure the extension needs to render UI.

Request:

```json
{
  "action": "scanImfPackage",
  "folderPath": "/Volumes/Media/IMP_A"
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "packageId": "pkg_01HZX9A3Y7W8",
    "folderPath": "/Volumes/Media/IMP_A",
    "packageName": "Meridian_tst_HD_23.976fps_HDRIAB",
    "summary": {
      "packageCount": 1,
      "cplCount": 3,
      "playableCplCount": 2,
      "hasDolbyVision": true,
      "hasIAB": true,
      "hasProRes": false
    },
    "cpls": [
      {
        "cplId": "urn:uuid:1234",
        "label": "CPL 1 - Main",
        "relativePath": "CPLs/main/CPL_main.xml",
        "isSupplemental": false,
        "playable": true,
        "videoReelCount": 5,
        "audioKind": "IAB",
        "editRate": 23.976,
        "durationFrames": 7224,
        "contentTitle": "Meridian"
      }
    ],
    "assets": {
      "missingVideoRefs": 0,
      "missingAudioRefs": 0
    },
    "engineHints": {
      "preferredPlaybackEngine": "advanced-imf",
      "preferredProxyEngine": "internal-fastpath",
      "requiresAdvancedAudio": true
    }
  }
}
```

## Playback Commands

### `startImfPlayback`

Starts playback for a selected CPL using the best available engine.

Request:

```json
{
  "action": "startImfPlayback",
  "packageId": "pkg_01HZX9A3Y7W8",
  "cplId": "urn:uuid:1234",
  "options": {
    "preferAudio": true,
    "preferImmersive": true,
    "viewerMode": "imf"
  }
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "sessionId": "play_8f42dc91",
    "mode": "imf",
    "streamUrl": "http://127.0.0.1:47125/stream/play_8f42dc91",
    "metadataUrl": "http://127.0.0.1:47125/imf_dovi/play_8f42dc91",
    "statusUrl": "http://127.0.0.1:47125/playback/play_8f42dc91",
    "engineId": "advanced-imf",
    "audioMode": "immersive",
    "videoMode": "direct"
  }
}
```

### `startProxyPlayback`

Starts full-CPL proxy generation/playback for a selected CPL.

Request:

```json
{
  "action": "startProxyPlayback",
  "packageId": "pkg_01HZX9A3Y7W8",
  "cplId": "urn:uuid:1234",
  "options": {
    "outputPreset": "qc-hdr-hevc",
    "preferAudio": true
  }
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "jobId": "job_proxy_01",
    "sessionId": "proxy_01",
    "progressUrl": "http://127.0.0.1:47125/progress/job_proxy_01",
    "streamUrl": "http://127.0.0.1:47125/stream/proxy_01",
    "metadataUrl": "http://127.0.0.1:47125/imf_dovi/proxy_01",
    "logUrl": "http://127.0.0.1:47125/log/job_proxy_01",
    "engineId": "internal-fastpath"
  }
}
```

### `stopPlayback`

Request:

```json
{
  "action": "stopPlayback",
  "sessionId": "play_8f42dc91"
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "stopped": true
  }
}
```

### `getPlaybackStatus`

Request:

```json
{
  "action": "getPlaybackStatus",
  "sessionId": "play_8f42dc91"
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "sessionId": "play_8f42dc91",
    "state": "playing",
    "positionFrames": 322,
    "durationFrames": 7224,
    "audioMode": "immersive",
    "engineId": "advanced-imf"
  }
}
```

## Proxy and Job Commands

### `buildProxy`

Dedicated proxy build command when playback is not started immediately.

Request:

```json
{
  "action": "buildProxy",
  "packageId": "pkg_01HZX9A3Y7W8",
  "cplId": "urn:uuid:1234",
  "options": {
    "outputPreset": "qc-hdr-hevc",
    "destination": "cache"
  }
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "jobId": "job_proxy_01",
    "progressUrl": "http://127.0.0.1:47125/progress/job_proxy_01",
    "resultUrl": "http://127.0.0.1:47125/result/job_proxy_01",
    "logUrl": "http://127.0.0.1:47125/log/job_proxy_01"
  }
}
```

### `getJobStatus`

Request:

```json
{
  "action": "getJobStatus",
  "jobId": "job_proxy_01"
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "jobId": "job_proxy_01",
    "kind": "proxy",
    "state": "running",
    "pct": 42,
    "stage": "encoding",
    "message": "Building proxy…",
    "result": null
  }
}
```

Completed response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "jobId": "job_proxy_01",
    "kind": "proxy",
    "state": "done",
    "pct": 100,
    "stage": "complete",
    "message": "Proxy ready",
    "result": {
      "sessionId": "proxy_01",
      "streamUrl": "http://127.0.0.1:47125/stream/proxy_01",
      "metadataUrl": "http://127.0.0.1:47125/imf_dovi/proxy_01"
    }
  }
}
```

### `cancelJob`

Request:

```json
{
  "action": "cancelJob",
  "jobId": "job_proxy_01"
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "cancelled": true
  }
}
```

## QC Commands

### `runImfQc`

Runs package/media checks for a selected CPL.

Request:

```json
{
  "action": "runImfQc",
  "packageId": "pkg_01HZX9A3Y7W8",
  "cplId": "urn:uuid:1234",
  "checks": [
    "structure",
    "playability",
    "dolbyVision",
    "immersiveAudio"
  ]
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "jobId": "job_qc_01",
    "progressUrl": "http://127.0.0.1:47125/progress/job_qc_01",
    "resultsUrl": "http://127.0.0.1:47125/qc/job_qc_01",
    "logUrl": "http://127.0.0.1:47125/log/job_qc_01"
  }
}
```

### `getQcResults`

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "jobId": "job_qc_01",
    "summary": {
      "pass": 14,
      "warn": 3,
      "fail": 0,
      "info": 6
    },
    "findings": [
      {
        "severity": "warn",
        "code": "AUD001",
        "title": "Immersive audio sequence detected",
        "message": "IAB / Atmos path present in selected CPL",
        "section": "audio"
      }
    ]
  }
}
```

## Diagnostics Commands

### `getJobLog`

Request:

```json
{
  "action": "getJobLog",
  "jobId": "job_proxy_01"
}
```

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "jobId": "job_proxy_01",
    "log": "[engine] starting proxy build"
  }
}
```

### `getEngineInfo`

Response:

```json
{
  "status": "ok",
  "apiVersion": "1.0",
  "companionVersion": "1.0.0",
  "data": {
    "activeEngine": "advanced-imf",
    "engines": [
      {
        "id": "internal-fastpath",
        "version": "1.0",
        "ready": true
      },
      {
        "id": "advanced-imf",
        "version": "1.9.8",
        "ready": true
      }
    ]
  }
}
```

## HTTP Session Endpoints

These are returned by control-channel commands.

- `GET /stream/:sessionId`
- `GET /progress/:jobId`
- `GET /playback/:sessionId`
- `GET /imf_dovi/:sessionId`
- `GET /log/:jobId`
- `GET /qc/:jobId`
- `GET /result/:jobId`

### `GET /progress/:jobId`

Response:

```json
{
  "jobId": "job_proxy_01",
  "state": "running",
  "pct": 58,
  "stage": "encoding",
  "message": "Building proxy…",
  "error": null
}
```

### `GET /imf_dovi/:sessionId`

Response:

```json
{
  "__static": {
    "profile": 8,
    "level": 7
  },
  "00:00:13:09": {
    "maxCLL": 698,
    "maxFALL": 223
  }
}
```

## UI Mapping Guidance

Extension labels should map from stable backend data:

- `state: queued` -> `Preparing…`
- `state: running` -> `Building proxy…`
- `state: done` -> `Ready`
- `state: failed` -> `Couldn’t prepare playback`

Use `userMessage` first for the main UI.

Expose raw `message` or logs only in advanced views.

## Compatibility With Current PostFlowX Helper

Current helper concepts already present:

- `pick_imf_folder`
- `process_imf_cpl`
- `/progress/:id`
- `/stream/:id`
- `/imf_dovi/:id`
- `/imf_log/:id`

This v1 spec keeps those ideas but normalizes them into:

- package-based commands
- job-based progress
- session-based playback
- structured error envelopes

## Migration Plan

### Stage 1

Wrap current helper behavior behind the new names:

- `pickImfFolder`
- `startProxyPlayback`
- `getJobStatus`
- `getJobLog`

### Stage 2

Add package scanning and stable `packageId` / `cplId`.

### Stage 3

Move playback/proxy/QC routing into the companion engine layer.

### Stage 4

Bundle all dependencies and remove any user-visible setup requirements.

## Recommended First Implementation Slice

Implement these first:

- `ping`
- `getVersion`
- `getCapabilities`
- `pickImfFolder`
- `scanImfPackage`
- `startProxyPlayback`
- `getJobStatus`
- `getJobLog`
- `stopPlayback`

That gives PostFlowX enough to:

- load a package
- pick a CPL
- build whole-CPL proxy playback
- show progress
- show logs

without waiting for the complete advanced engine stack.

