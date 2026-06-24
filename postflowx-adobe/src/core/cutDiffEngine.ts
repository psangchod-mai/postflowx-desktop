import type { TimelineSnapshot, ClipSnapshot, MarkerSnapshot } from '../model/timeline.js';
import type { TimelineDiff, ClipDiff, MarkerDiff } from '../model/diff.js';
import { flattenClips } from './timelineNormalizer.js';

export function compareSnapshots(
  baseline: TimelineSnapshot,
  latest: TimelineSnapshot
): TimelineDiff {
  const baselineClips = flattenClips(baseline);
  const latestClips = flattenClips(latest);

  const clipDiffs: ClipDiff[] = [];

  // Added clips
  for (const [id, clip] of latestClips) {
    if (!baselineClips.has(id)) {
      clipDiffs.push({ kind: 'added', clipId: id, latest: clip });
    }
  }

  // Removed clips
  for (const [id, clip] of baselineClips) {
    if (!latestClips.has(id)) {
      clipDiffs.push({ kind: 'removed', clipId: id, baseline: clip });
    }
  }

  // Changed clips — check move, trim, rename, relink
  for (const [id, baseClip] of baselineClips) {
    const latestClip = latestClips.get(id);
    if (!latestClip) continue;
    detectClipChanges(baseClip, latestClip, clipDiffs);
  }

  // Marker diffs
  const markerDiffs = compareMarkers(baseline.markers, latest.markers);

  // Live state diff
  const prevSelected = new Set(baseline.selectedClipIds);
  const currSelected = new Set(latest.selectedClipIds);
  const selectionChanged =
    prevSelected.size !== currSelected.size ||
    [...prevSelected].some(id => !currSelected.has(id));

  const playheadChanged = baseline.playheadTicks !== latest.playheadTicks;

  return {
    sequenceId: latest.sequenceId,
    baselineRevisionToken: baseline.revisionToken,
    latestRevisionToken: latest.revisionToken,
    clipDiffs,
    markerDiffs,
    liveState: {
      selectionChanged,
      previousSelectedClipIds: baseline.selectedClipIds,
      currentSelectedClipIds: latest.selectedClipIds,
      playheadChanged,
      previousPlayheadTicks: baseline.playheadTicks,
      currentPlayheadTicks: latest.playheadTicks,
    },
    hasChanges: clipDiffs.length > 0 || markerDiffs.length > 0,
  };
}

function detectClipChanges(
  base: ClipSnapshot,
  latest: ClipSnapshot,
  diffs: ClipDiff[]
): void {
  if (base.startTicks !== latest.startTicks) {
    diffs.push({ kind: 'moved', clipId: base.clipId, baseline: base, latest });
  }

  if (
    base.inTicks !== latest.inTicks ||
    base.outTicks !== latest.outTicks ||
    base.endTicks !== latest.endTicks
  ) {
    diffs.push({ kind: 'trimmed', clipId: base.clipId, baseline: base, latest });
  }

  if (base.name !== latest.name) {
    diffs.push({ kind: 'renamed', clipId: base.clipId, baseline: base, latest });
  }

  if (
    base.sourcePath !== latest.sourcePath ||
    base.projectItemId !== latest.projectItemId
  ) {
    diffs.push({ kind: 'relinked', clipId: base.clipId, baseline: base, latest,
      detail: `${base.sourcePath ?? ''} -> ${latest.sourcePath ?? ''}` });
  }
}

function compareMarkers(
  baseline: MarkerSnapshot[],
  latest: MarkerSnapshot[]
): MarkerDiff[] {
  const diffs: MarkerDiff[] = [];
  const baseMap = new Map(baseline.map(m => [m.markerId, m]));
  const latestMap = new Map(latest.map(m => [m.markerId, m]));

  for (const [id, m] of latestMap) {
    if (!baseMap.has(id)) {
      diffs.push({ kind: 'marker-added', markerId: id, latest: m });
    }
  }

  for (const [id, m] of baseMap) {
    if (!latestMap.has(id)) {
      diffs.push({ kind: 'marker-removed', markerId: id, baseline: m });
    } else {
      const latestM = latestMap.get(id)!;
      if (
        m.name !== latestM.name ||
        m.startTicks !== latestM.startTicks ||
        m.durationTicks !== latestM.durationTicks ||
        m.comments !== latestM.comments
      ) {
        diffs.push({ kind: 'marker-changed', markerId: id, baseline: m, latest: latestM });
      }
    }
  }

  return diffs;
}
