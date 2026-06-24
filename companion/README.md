# PostFlowX Companion

This folder scaffolds the future bundled native companion for IMF playback,
proxy generation, and QC on macOS and Windows.

The goal is:

- keep the Chrome extension as the UI
- move IMF/media complexity into a local bundled companion
- support multiple backend engines behind one stable API
- hide setup complexity from non-technical users

## Status

This is a scaffold, not a production-ready companion.

Included here:

- Python package layout for the companion service
- control-channel action router
- capability model
- native messaging stub
- engine abstraction layer
- platform manifest templates
- installer script placeholders

Not implemented yet:

- full IMF playback engine
- QC jobs
- installer packaging and signing

## Implemented in this scaffold

Working now:

- `ping`
- `getVersion`
- `getCapabilities`
- `getEngineInfo`
- `pickImfFolder`
- `scanImfPackage`
- `startProxyPlayback`
- `buildProxy`
- `getJobStatus`
- `getJobLog`
- local HTTP progress/log/stream endpoints

Still placeholder:

- `startImfPlayback`
- `runImfQc`
- advanced playback/QC engine routing

## Layout

```text
companion/
  manifests/
    macos/
    windows/
  scripts/
  src/
    postflowx_companion/
      engines/
```

## Development Notes

- The API contract lives in `docs/imf-companion-api-spec.md`.
- The future native playback contract lives in `companion/protocol/native-helper-protocol-v1.json` and `companion/protocol/native-helper-protocol-v1.ts`.
- The high-level architecture lives in `docs/imf-native-architecture.md`.
- The scaffold uses only the Python standard library so it is easy to evolve.
- For a local macOS dev install, use:
  `bash companion/scripts/install_dev_macos.sh --extension-id <chrome_extension_id>`

## Suggested Next Implementation Slice

1. Implement `startImfPlayback`
2. Add real Dolby Vision metadata extraction
3. Add QC job execution
4. Add companion installer/registration flow
5. Replace the legacy `tools/pfx_host.py` path with this companion
