// Wraps Adobe Premiere Pro UXP host APIs.
// All Premiere-specific objects are confined here — engines and panel must not import host types.

import type {
  AdobePremiereAdapter,
  CreateMarkerInput,
  HostProjectRef,
  HostSequenceRef,
  PProMarker,
  PProProject,
  PProSequence,
  PProTrackItem,
  UpdateMarkerInput,
} from './hostTypes.js';
import type { TimelineSnapshot, ClipSnapshot, MarkerSnapshot, TrackSnapshot } from '../model/timeline.js';
import { deriveClipId, deriveTrackId, ObjectLookupCache } from './objectLookup.js';
import { encodeOwnerComment, decodeOwnerComment, isPostFlowXMarker } from './markerCodec.js';
import { nowIso } from '../utils/time.js';
import { generateRevisionToken } from '../core/revisionToken.js';

// UXP host module — resolved at runtime by Premiere
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const premierepro: any;

export class AdobePremiereAdapterImpl implements AdobePremiereAdapter {
  private _lookupCache = new ObjectLookupCache();

  async connect(): Promise<void> {
    // UXP connects automatically when the panel loads.
    // This method verifies host reachability.
    const app = premierepro.app;
    if (!app) throw new Error('Premiere Pro host not available');
  }

  async getActiveProject(): Promise<HostProjectRef | null> {
    try {
      const project: PProProject = await premierepro.app.getActiveProject();
      if (!project) return null;
      return {
        id: project.documentID,
        name: project.name,
        path: project.path,
      };
    } catch {
      return null;
    }
  }

  async getActiveSequence(): Promise<HostSequenceRef | null> {
    try {
      const project: PProProject = await premierepro.app.getActiveProject();
      if (!project) return null;
      const seq: PProSequence | null = project.activeSequence;
      if (!seq) return null;
      return { id: seq.id, name: seq.name };
    } catch {
      return null;
    }
  }

  async getSequenceSnapshot(sequenceId?: string): Promise<TimelineSnapshot | null> {
    try {
      const project: PProProject = await premierepro.app.getActiveProject();
      if (!project) return null;

      const seq = await this._resolveSequence(project, sequenceId);
      if (!seq) return null;

      const settings = await seq.getSettings();
      const fps = settings?.videoFrameRate?.value;

      const playheadPos = await seq.getPlayerPosition();
      const playheadTicks = playheadPos?.ticks;

      // Collect video tracks
      const tracks: TrackSnapshot[] = [];
      const videoTrackCount = seq.videoTracks.numTracks;
      for (let i = 0; i < videoTrackCount; i++) {
        const track = await seq.videoTracks.getTrack(i);
        const clips: ClipSnapshot[] = [];
        for (let j = 0; j < track.numItems; j++) {
          const item = await track.getItemAt(j);
          const clip = await this._normalizeClip(item, seq.id, 'video', i);
          clips.push(clip);
        }
        tracks.push({
          trackId: deriveTrackId({ sequenceId: seq.id, trackKind: 'video', trackIndex: i }),
          kind: 'video',
          index: i,
          name: track.name,
          clips,
        });
      }

      // Collect audio tracks
      const audioTrackCount = seq.audioTracks.numTracks;
      for (let i = 0; i < audioTrackCount; i++) {
        const track = await seq.audioTracks.getTrack(i);
        const clips: ClipSnapshot[] = [];
        for (let j = 0; j < track.numItems; j++) {
          const item = await track.getItemAt(j);
          const clip = await this._normalizeClip(item, seq.id, 'audio', i);
          clips.push(clip);
        }
        tracks.push({
          trackId: deriveTrackId({ sequenceId: seq.id, trackKind: 'audio', trackIndex: i }),
          kind: 'audio',
          index: i,
          name: track.name,
          clips,
        });
      }

      // Collect markers
      const markers: MarkerSnapshot[] = await this._collectMarkers(seq);

      const snapshot: TimelineSnapshot = {
        projectId: project.documentID,
        projectName: project.name,
        sequenceId: seq.id,
        sequenceName: seq.name,
        fps,
        capturedAtIso: nowIso(),
        playheadTicks,
        selectedClipIds: [],
        tracks,
        markers,
        revisionToken: '',
      };

      snapshot.revisionToken = generateRevisionToken(snapshot);
      return snapshot;
    } catch {
      return null;
    }
  }

  async getCurrentSelection(_sequenceId?: string): Promise<string[]> {
    try {
      // Premiere UXP selection API: check docs/api-notes.md for confirmed approach.
      // Best current approach: enumerate track items and check selection state.
      const project: PProProject = await premierepro.app.getActiveProject();
      if (!project) return [];
      const seq = project.activeSequence;
      if (!seq) return [];

      const selected: string[] = [];
      const vCount = seq.videoTracks.numTracks;
      for (let i = 0; i < vCount; i++) {
        const track = await seq.videoTracks.getTrack(i);
        for (let j = 0; j < track.numItems; j++) {
          const item = await track.getItemAt(j);
          // UXP does not yet expose a direct isSelected property on TrackItems.
          // When Adobe exposes it, check item.isSelected here.
          // For now, selection is approximated via SequenceEditor if available.
          void item;
        }
      }
      return selected;
    } catch {
      return [];
    }
  }

  async getPlayheadPosition(_sequenceId?: string): Promise<string | null> {
    try {
      const project: PProProject = await premierepro.app.getActiveProject();
      if (!project) return null;
      const seq = project.activeSequence;
      if (!seq) return null;
      const pos = await seq.getPlayerPosition();
      return pos?.ticks ?? null;
    } catch {
      return null;
    }
  }

  async selectClip(clipId: string): Promise<boolean> {
    try {
      const hint = this._lookupCache.get(clipId);
      if (!hint) return false;

      const project: PProProject = await premierepro.app.getActiveProject();
      if (!project) return false;
      const seq = project.activeSequence;
      if (!seq) return false;

      const tracks = hint.trackKind === 'video' ? seq.videoTracks : seq.audioTracks;
      const track = await tracks.getTrack(hint.trackIndex);
      for (let j = 0; j < track.numItems; j++) {
        const item = await track.getItemAt(j);
        if (item.start.ticks === hint.startTicks) {
          // Attempt selection via SequenceEditor if available.
          // See docs/api-notes.md for confirmed API surface.
          try {
            const editor = await premierepro.SequenceEditor.getEditor(seq);
            if (editor?.setSelection) {
              await editor.setSelection([item]);
              return true;
            }
          } catch {
            // Fall back to playhead navigation
          }
          await seq.setPlayerPosition(hint.startTicks);
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async goToClip(clipId: string): Promise<boolean> {
    const hint = this._lookupCache.get(clipId);
    if (!hint) return false;
    return this.setPlayhead(hint.startTicks);
  }

  async setPlayhead(ticks: string): Promise<boolean> {
    try {
      const project: PProProject = await premierepro.app.getActiveProject();
      if (!project) return false;
      const seq = project.activeSequence;
      if (!seq) return false;
      await seq.setPlayerPosition(ticks);
      return true;
    } catch {
      return false;
    }
  }

  async createMarker(input: CreateMarkerInput): Promise<string | null> {
    try {
      const project: PProProject = await premierepro.app.getActiveProject();
      if (!project) return null;
      const seq = project.activeSequence;
      if (!seq) return null;

      const marker: PProMarker = await seq.markers.createMarker(input.startTicks);

      const comments = encodeOwnerComment({
        owner: 'postflowx',
        ownerId: input.ownerId,
        kind: input.markerType ?? 'info',
        payloadJson: input.payloadJson,
      });

      // Batch update marker fields
      try {
        const action = premierepro.CompoundAction?.createAction?.();
        if (action) {
          action.addAction(() => { marker.name = input.name; });
          action.addAction(() => { marker.comments = comments; });
          if (input.colorIndex !== undefined) action.addAction(() => { marker.colorIndex = input.colorIndex!; });
          if (input.durationTicks) action.addAction(() => { marker.duration = { ticks: input.durationTicks!, seconds: 0 }; });
          await action.execute();
        } else {
          marker.name = input.name;
          marker.comments = comments;
          if (input.colorIndex !== undefined) marker.colorIndex = input.colorIndex;
        }
      } catch {
        marker.name = input.name;
        marker.comments = comments;
      }

      return marker.guid;
    } catch {
      return null;
    }
  }

  async updateMarker(markerId: string, patch: UpdateMarkerInput): Promise<boolean> {
    try {
      const marker = await this._findMarkerById(markerId);
      if (!marker) return false;

      if (!isPostFlowXMarker(marker.comments)) return false;

      if (patch.name !== undefined) marker.name = patch.name;
      if (patch.colorIndex !== undefined) marker.colorIndex = patch.colorIndex;

      if (patch.comments !== undefined || patch.payloadJson !== undefined) {
        const existing = decodeOwnerComment(marker.comments);
        if (existing) {
          marker.comments = encodeOwnerComment({
            ...existing,
            payloadJson: patch.payloadJson ?? existing.payloadJson,
          });
        }
      }

      return true;
    } catch {
      return false;
    }
  }

  async deleteMarker(markerId: string): Promise<boolean> {
    try {
      const project: PProProject = await premierepro.app.getActiveProject();
      if (!project) return false;
      const seq = project.activeSequence;
      if (!seq) return false;

      let marker = await seq.markers.getFirstMarker();
      while (marker) {
        if (marker.guid === markerId) {
          if (!isPostFlowXMarker(marker.comments)) return false;
          await seq.markers.deleteMarker(marker);
          return true;
        }
        marker = await seq.markers.getNextMarker(marker);
      }
      return false;
    } catch {
      return false;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async _resolveSequence(
    project: PProProject,
    sequenceId?: string
  ): Promise<PProSequence | null> {
    if (!sequenceId) return project.activeSequence;
    if (project.activeSequence?.id === sequenceId) return project.activeSequence;

    const count = project.sequences.numSequences;
    for (let i = 0; i < count; i++) {
      const seq = await project.sequences.getSequence(i);
      if (seq.id === sequenceId) return seq;
    }
    return null;
  }

  private async _normalizeClip(
    item: PProTrackItem,
    sequenceId: string,
    trackKind: 'video' | 'audio',
    trackIndex: number
  ): Promise<ClipSnapshot> {
    const projectItemId = item.projectItem?.nodeId;
    const clipId =
      item.nodeId ||
      deriveClipId({
        sequenceId,
        trackKind,
        trackIndex,
        startTicks: item.start.ticks,
        endTicks: item.end.ticks,
        projectItemId,
      });

    this._lookupCache.set(clipId, {
      trackKind,
      trackIndex,
      startTicks: item.start.ticks,
    });

    const hostType = trackKind === 'video' ? 'videoClipTrackItem' : 'audioClipTrackItem';

    return {
      clipId,
      hostType,
      projectItemId,
      name: item.name,
      sourcePath: item.projectItem?.treePath,
      startTicks: item.start.ticks,
      endTicks: item.end.ticks,
      inTicks: item.inPoint?.ticks,
      outTicks: item.outPoint?.ticks,
      durationTicks: item.duration?.ticks,
      disabled: item.disabled,
    };
  }

  private async _collectMarkers(seq: PProSequence): Promise<MarkerSnapshot[]> {
    const markers: MarkerSnapshot[] = [];
    let marker = await seq.markers.getFirstMarker();
    while (marker) {
      const meta = decodeOwnerComment(marker.comments);
      markers.push({
        markerId: marker.guid,
        startTicks: marker.start.ticks,
        durationTicks: marker.duration?.ticks,
        name: marker.name,
        comments: marker.comments,
        colorIndex: marker.colorIndex,
        markerType: marker.type,
        owner: meta ? 'postflowx' : 'premiere',
        ownerId: meta?.ownerId,
        payloadJson: meta?.payloadJson,
      });
      marker = await seq.markers.getNextMarker(marker);
    }
    return markers;
  }

  private async _findMarkerById(markerId: string): Promise<PProMarker | null> {
    try {
      const project: PProProject = await premierepro.app.getActiveProject();
      if (!project) return null;
      const seq = project.activeSequence;
      if (!seq) return null;
      let marker = await seq.markers.getFirstMarker();
      while (marker) {
        if (marker.guid === markerId) return marker;
        marker = await seq.markers.getNextMarker(marker);
      }
      return null;
    } catch {
      return null;
    }
  }
}
