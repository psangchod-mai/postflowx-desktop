# PostFlowX Native Helper Protocol v1

This document describes the compact file-based native playback contract for the future
AVFoundation-backed helper used by PostFlowX.

Scope of this protocol:

- open local source media
- report trusted source timecode
- seek by timecode or frame
- step transport by frame
- generate thumbnails at exact or fast positions
- emit playhead and playback-state events

This protocol is separate from the current IMF companion API scaffold.

See also:

- `companion/protocol/native-helper-protocol-v1.json`
- `companion/protocol/native-helper-protocol-v1.ts`
- `docs/imf-companion-api-spec.md`
