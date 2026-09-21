# PostFlowX Adobe Premiere UXP — API Notes

This file documents findings from verifying the UXP API against the live Adobe docs and TypeScript definitions. Update this file during implementation as questions are resolved.

## Open questions (from spec §22)

### 1. Enumerate all timeline track items in active sequence
- **Current approach**: iterate `seq.videoTracks.numTracks` / `seq.audioTracks.numTracks`, then `getTrack(i)`, then `track.numItems` / `getItemAt(j)`.
- **Verify**: confirm `numItems` and `getItemAt` are stable on `Track` class in latest TS defs.
- **Reference**: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/sequence/

### 2. Fetch and update current selection
- **Status**: UXP does not expose a direct `.isSelected` property on `VideoClipTrackItem` / `AudioClipTrackItem` as of initial research.
- **Best current approach**: use `SequenceEditor.getEditor(seq)` then `editor.setSelection([item])` for write. For read — check latest TS defs for `TrackItemSelection` class.
- **Reference**: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/sequenceeditor/

### 3. Move playhead in active sequence
- **Current approach**: `seq.setPlayerPosition(ticks: string)`.
- **Verify**: confirm tick string format (e.g. `"254016000000"` for 1 second at standard rate).
- **Reference**: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/sequence/

### 4. Reveal in sequence
- **Status**: No dedicated "reveal in sequence" API found. Approximated via `selectClip` + `setPlayerPosition`.
- **Action**: Check if `SequenceEditor` exposes a scroll/reveal method.

### 5. Marker ownership field
- **Decision**: Store ownership metadata in `marker.comments` field using `[PFX]` tag format (see `markerCodec.ts`).
- **Note**: `marker.guid` is used as the stable marker ID. Verify `guid` is stable across save/reload.
- **Reference**: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/marker/

### 6. Action batching / undo grouping
- **Current approach**: `premierepro.CompoundAction.createAction()` with `.addAction()` / `.execute()`.
- **Verify**: confirm `CompoundAction` is available in the runtime version targeted (25.6+).
- **Fallback**: if unavailable, apply fields directly — correctness over batching per spec.
- **Reference**: https://developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/compoundaction/

### 7. Host lifecycle hooks / event subscriptions
- **Status**: polling-first per spec §9.1. Investigate whether `app.onActiveSequenceChanged` or similar events are available in current API surface.
- **Action**: Check latest UXP event docs and TypeScript definitions before adding event subscriptions.

## Tick rate

Adobe Premiere ticks: **254,016,000,000 ticks per second** (confirmed from Premiere SDK documentation).

All tick math in `src/utils/time.ts` uses this constant.

## Minimum Premiere version

Targeting **Premiere Pro 25.6+** per spec §6.3. Verify before packaging that this is still current.
