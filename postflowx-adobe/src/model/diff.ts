import type { ClipSnapshot, MarkerSnapshot } from './timeline.js';

export type ClipDiffKind =
  | 'added'
  | 'removed'
  | 'moved'
  | 'trimmed'
  | 'renamed'
  | 'relinked'
  | 'marker-added'
  | 'marker-removed'
  | 'marker-changed'
  | 'selection-changed'
  | 'playhead-moved';

export type ClipDiff = {
  kind: ClipDiffKind;
  clipId: string;
  baseline?: ClipSnapshot;
  latest?: ClipSnapshot;
  detail?: string;
};

export type MarkerDiff = {
  kind: 'marker-added' | 'marker-removed' | 'marker-changed';
  markerId: string;
  baseline?: MarkerSnapshot;
  latest?: MarkerSnapshot;
};

export type LiveStateDiff = {
  selectionChanged: boolean;
  previousSelectedClipIds: string[];
  currentSelectedClipIds: string[];
  playheadChanged: boolean;
  previousPlayheadTicks?: string;
  currentPlayheadTicks?: string;
};

export type TimelineDiff = {
  sequenceId: string;
  baselineRevisionToken: string;
  latestRevisionToken: string;
  clipDiffs: ClipDiff[];
  markerDiffs: MarkerDiff[];
  liveState: LiveStateDiff;
  hasChanges: boolean;
};
