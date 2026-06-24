# Native Helper Protocol v1

This folder contains the transport-first contract for the future AVFoundation-backed
native playback helper used by PostFlowX for:

- source timecode inspection
- seek / frame-step transport
- thumbnail extraction
- playhead status reporting

These files are intentionally separate from the existing IMF companion API spec.

- `../docs/imf-companion-api-spec.md` describes the current companion scaffold used for IMF package scanning, proxy generation, and QC orchestration.
- `native-helper-protocol-v1.json` describes the future request / response / event envelope for file-based native playback.
- `native-helper-protocol-v1.ts` provides TypeScript typings for the extension side.

The protocol is designed to work over the same Chrome native messaging bridge already used by PostFlowX.
