import type { TimelineSnapshot, MarkerSnapshot } from '../model/timeline.js';

export type HostProjectRef = {
  id: string;
  name: string;
  path?: string;
};

export type HostSequenceRef = {
  id: string;
  name: string;
};

export type CreateMarkerInput = {
  name: string;
  startTicks: string;
  durationTicks?: string;
  comments?: string;
  colorIndex?: number;
  markerType?: string;
  owner: 'postflowx';
  ownerId: string;
  payloadJson?: string;
};

export type UpdateMarkerInput = Partial<{
  name: string;
  durationTicks: string;
  comments: string;
  colorIndex: number;
  markerType: string;
  payloadJson: string;
}>;

export interface AdobePremiereAdapter {
  connect(): Promise<void>;
  getActiveProject(): Promise<HostProjectRef | null>;
  getActiveSequence(): Promise<HostSequenceRef | null>;
  getSequenceSnapshot(sequenceId?: string): Promise<TimelineSnapshot | null>;
  getCurrentSelection(sequenceId?: string): Promise<string[]>;
  getPlayheadPosition(sequenceId?: string): Promise<string | null>;
  selectClip(clipId: string): Promise<boolean>;
  goToClip(clipId: string): Promise<boolean>;
  setPlayhead(ticks: string): Promise<boolean>;
  createMarker(input: CreateMarkerInput): Promise<string | null>;
  updateMarker(markerId: string, patch: UpdateMarkerInput): Promise<boolean>;
  deleteMarker(markerId: string): Promise<boolean>;
}

// Raw Premiere host objects — shapes documented in Adobe UXP TypeScript definitions.
// Keep these types isolated in the adapter layer only.
export type PProProject = {
  name: string;
  path: string;
  documentID: string;
  sequences: PProSequenceCollection;
  activeSequence: PProSequence | null;
};

export type PProSequenceCollection = {
  numSequences: number;
  getSequence(index: number): Promise<PProSequence>;
};

export type PProSequence = {
  id: string;
  name: string;
  videoTracks: PProTrackCollection;
  audioTracks: PProTrackCollection;
  markers: PProMarkerCollection;
  getPlayerPosition(): Promise<PProTickTime>;
  setPlayerPosition(ticks: string): Promise<void>;
  getSettings(): Promise<{ videoFrameRate?: { value?: number } }>;
};

export type PProTrackCollection = {
  numTracks: number;
  getTrack(index: number): Promise<PProTrack>;
};

export type PProTrack = {
  name: string;
  numItems: number;
  getItemAt(index: number): Promise<PProTrackItem>;
};

export type PProTrackItem = {
  type: number; // 1 = video clip, 2 = audio clip
  name: string;
  nodeId: string;
  start: PProTickTime;
  end: PProTickTime;
  inPoint: PProTickTime;
  outPoint: PProTickTime;
  duration: PProTickTime;
  disabled: boolean;
  mediaType: string;
  projectItem?: PProProjectItem;
  getLinkedItems(): Promise<PProTrackItem[]>;
};

export type PProProjectItem = {
  nodeId: string;
  name: string;
  treePath: string;
};

export type PProMarkerCollection = {
  numMarkers: number;
  getFirstMarker(): Promise<PProMarker | null>;
  getNextMarker(marker: PProMarker): Promise<PProMarker | null>;
  createMarker(time: string): Promise<PProMarker>;
  deleteMarker(marker: PProMarker): Promise<void>;
};

export type PProMarker = {
  guid: string;
  name: string;
  comments: string;
  start: PProTickTime;
  duration: PProTickTime;
  type: string;
  colorIndex: number;
};

export type PProTickTime = {
  ticks: string;
  seconds: number;
};

export type PProSelection = {
  getSelectedTrackItems(): Promise<PProTrackItem[]>;
  setSelectedTrackItems(items: PProTrackItem[]): Promise<void>;
};
