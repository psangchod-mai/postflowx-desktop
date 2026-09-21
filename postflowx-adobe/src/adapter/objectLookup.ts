// Single source of truth for deriving stable clip IDs from Premiere host objects.
// Use nodeId when available; fall back to a deterministic composite key.

import { simpleHash } from '../utils/hash.js';

export type ClipLookupKey = {
  sequenceId: string;
  trackKind: 'video' | 'audio';
  trackIndex: number;
  startTicks: string;
  endTicks: string;
  projectItemId?: string;
};

export function deriveClipId(key: ClipLookupKey): string {
  const parts = [
    key.sequenceId,
    key.trackKind,
    String(key.trackIndex),
    key.startTicks,
    key.endTicks,
    key.projectItemId ?? '',
  ];
  return `pfx_clip_${simpleHash(parts.join('|'))}`;
}

export type TrackLookupKey = {
  sequenceId: string;
  trackKind: 'video' | 'audio';
  trackIndex: number;
};

export function deriveTrackId(key: TrackLookupKey): string {
  return `pfx_track_${simpleHash([key.sequenceId, key.trackKind, String(key.trackIndex)].join('|'))}`;
}

// In-memory lookup cache: clipId -> hint object for fast re-lookup during write-back
export type ClipLookupHint = {
  trackKind: 'video' | 'audio';
  trackIndex: number;
  startTicks: string;
};

export class ObjectLookupCache {
  private _clips = new Map<string, ClipLookupHint>();

  set(clipId: string, hint: ClipLookupHint): void {
    this._clips.set(clipId, hint);
  }

  get(clipId: string): ClipLookupHint | undefined {
    return this._clips.get(clipId);
  }

  clear(): void {
    this._clips.clear();
  }
}
