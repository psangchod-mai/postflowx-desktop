import type { TimelineSnapshot } from '../model/timeline.js';
import { simpleHash } from '../utils/hash.js';

export function generateRevisionToken(snapshot: TimelineSnapshot): string {
  const parts: string[] = [
    snapshot.sequenceId,
    String(snapshot.tracks.length),
  ];

  for (const track of snapshot.tracks) {
    for (const clip of track.clips) {
      parts.push(`${clip.clipId}:${clip.startTicks}:${clip.endTicks}:${clip.inTicks ?? ''}:${clip.outTicks ?? ''}`);
    }
  }

  for (const marker of snapshot.markers) {
    parts.push(`${marker.markerId}:${marker.name}:${marker.startTicks}:${marker.durationTicks ?? ''}`);
  }

  parts.push(snapshot.selectedClipIds.join(','));
  if (snapshot.playheadTicks) parts.push(snapshot.playheadTicks);

  return simpleHash(parts.join('|'));
}
