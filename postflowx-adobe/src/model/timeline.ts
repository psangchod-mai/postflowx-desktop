export type TimelineSnapshot = {
  projectId: string;
  projectName: string;
  sequenceId: string;
  sequenceName: string;
  fps?: number;
  revisionToken: string;
  capturedAtIso: string;
  playheadTicks?: string;
  selectedClipIds: string[];
  tracks: TrackSnapshot[];
  markers: MarkerSnapshot[];
};

export type TrackSnapshot = {
  trackId: string;
  kind: 'video' | 'audio';
  index: number;
  name?: string;
  clips: ClipSnapshot[];
};

export type ClipSnapshot = {
  clipId: string;
  hostType: 'videoClipTrackItem' | 'audioClipTrackItem' | 'unknown';
  projectItemId?: string;
  name: string;
  sourcePath?: string;
  reel?: string;
  startTicks: string;
  endTicks: string;
  inTicks?: string;
  outTicks?: string;
  durationTicks?: string;
  disabled?: boolean;
  linkedGroupId?: string;
  metadata?: Record<string, string>;
};

export type MarkerSnapshot = {
  markerId: string;
  startTicks: string;
  durationTicks?: string;
  name: string;
  comments?: string;
  colorIndex?: number;
  markerType?: string;
  owner?: 'postflowx' | 'premiere' | 'unknown';
  ownerId?: string;
  payloadJson?: string;
};
