import type { TimelineDiff, ClipDiff } from '../model/diff.js';
import type { PullImpact, PullImpactSeverity } from '../model/pullImpact.js';

export function computePullImpacts(diff: TimelineDiff): PullImpact[] {
  const impacts: PullImpact[] = [];

  for (const clipDiff of diff.clipDiffs) {
    const impact = clipDiffToImpact(clipDiff);
    if (impact) impacts.push(impact);
  }

  return impacts;
}

function clipDiffToImpact(diff: ClipDiff): PullImpact | null {
  const clip = diff.latest ?? diff.baseline;
  if (!clip) return null;

  let severity: PullImpactSeverity = 'info';
  let suggestedAction: PullImpact['suggestedAction'] = 'none';

  switch (diff.kind) {
    case 'added':
      severity = 'info';
      suggestedAction = 'review';
      break;
    case 'removed':
      severity = 'warning';
      suggestedAction = 'review';
      break;
    case 'moved':
      severity = 'warning';
      suggestedAction = 'recalculate-handles';
      break;
    case 'trimmed':
      severity = 'warning';
      suggestedAction = 'recalculate-handles';
      break;
    case 'relinked':
      severity = 'high';
      suggestedAction = 'repull';
      break;
    case 'renamed':
      severity = 'info';
      suggestedAction = 'review';
      break;
    default:
      return null;
  }

  return {
    shotId: clip.clipId,
    clipId: clip.clipId,
    startTicks: clip.startTicks,
    severity,
    reasons: [{ clipId: clip.clipId, kind: diff.kind, detail: diff.detail }],
    suggestedAction,
  };
}
