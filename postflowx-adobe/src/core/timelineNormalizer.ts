// Validates and normalizes raw snapshots coming from the adapter.
// Ensures all required fields are present and clip IDs are stable.

import type { TimelineSnapshot, ClipSnapshot, TrackSnapshot } from '../model/timeline.js';

export function normalizeSnapshot(raw: TimelineSnapshot): TimelineSnapshot {
  return {
    ...raw,
    tracks: raw.tracks.map(normalizeTrack),
    markers: raw.markers,
    selectedClipIds: raw.selectedClipIds ?? [],
  };
}

function normalizeTrack(track: TrackSnapshot): TrackSnapshot {
  return {
    ...track,
    clips: track.clips.map(normalizeClip),
  };
}

function normalizeClip(clip: ClipSnapshot): ClipSnapshot {
  return {
    ...clip,
    name: clip.name ?? '',
    disabled: clip.disabled ?? false,
  };
}

export function flattenClips(snapshot: TimelineSnapshot): Map<string, ClipSnapshot> {
  const map = new Map<string, ClipSnapshot>();
  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      map.set(clip.clipId, clip);
    }
  }
  return map;
}
