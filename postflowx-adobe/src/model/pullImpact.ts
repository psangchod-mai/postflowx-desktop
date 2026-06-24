import type { ClipDiffKind } from './diff.js';

export type PullImpactSeverity = 'info' | 'warning' | 'high';

export type PullImpactReason = {
  clipId: string;
  kind: ClipDiffKind;
  detail?: string;
};

export type PullImpact = {
  shotId: string;
  clipId: string;
  startTicks: string;
  severity: PullImpactSeverity;
  reasons: PullImpactReason[];
  suggestedAction: 'none' | 'review' | 'repull' | 'recalculate-handles';
};
