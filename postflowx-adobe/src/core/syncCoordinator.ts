import type { AdobePremiereAdapter } from '../adapter/hostTypes.js';
import type { TimelineSnapshot } from '../model/timeline.js';
import type { TimelineDiff } from '../model/diff.js';
import type { PullImpact } from '../model/pullImpact.js';
import type { SyncLogEntry, SyncLogCode } from '../model/log.js';
import { compareSnapshots } from './cutDiffEngine.js';
import { computePullImpacts } from './pullPrepEngine.js';
import { normalizeSnapshot } from './timelineNormalizer.js';
import { nowIso } from '../utils/time.js';
import { debounce } from '../utils/debounce.js';

export type SyncState = {
  latestSnapshot: TimelineSnapshot | null;
  baselineSnapshot: TimelineSnapshot | null;
  latestDiff: TimelineDiff | null;
  latestImpacts: PullImpact[];
  log: SyncLogEntry[];
};

export type WriteBackGuard = {
  operationId: string;
  kind: 'selection' | 'marker-create' | 'marker-update' | 'marker-delete' | 'playhead';
  expiresAt: number;
};

export type SyncCoordinatorOptions = {
  pollIntervalMs?: number;
  idlePollIntervalMs?: number;
  debounceMs?: number;
  onStateChange?: (state: SyncState) => void;
};

export class SyncCoordinator {
  private _adapter: AdobePremiereAdapter;
  private _state: SyncState = {
    latestSnapshot: null,
    baselineSnapshot: null,
    latestDiff: null,
    latestImpacts: [],
    log: [],
  };
  private _guards: WriteBackGuard[] = [];
  private _pollTimer: ReturnType<typeof setTimeout> | null = null;
  private _autoSync = false;
  private _pollIntervalMs: number;
  private _idlePollIntervalMs: number;
  private _onStateChange: ((state: SyncState) => void) | undefined;
  private _processDebounced: () => void;
  private _pendingSnapshot: TimelineSnapshot | null = null;

  constructor(adapter: AdobePremiereAdapter, opts: SyncCoordinatorOptions = {}) {
    this._adapter = adapter;
    this._pollIntervalMs = opts.pollIntervalMs ?? 1000;
    this._idlePollIntervalMs = opts.idlePollIntervalMs ?? 4000;
    this._onStateChange = opts.onStateChange;
    this._processDebounced = debounce(() => this._processSnapshot(), opts.debounceMs ?? 300);
  }

  get state(): SyncState {
    return this._state;
  }

  restoreBaseline(snapshot: TimelineSnapshot): void {
    this._state = { ...this._state, baselineSnapshot: snapshot };
  }

  setAutoSync(enabled: boolean): void {
    this._autoSync = enabled;
    if (enabled) {
      this._schedulePoll();
    } else {
      this._clearPoll();
    }
  }

  async syncNow(): Promise<void> {
    this._clearWritebackGuards();
    await this._fetchAndQueue();
  }

  setBaseline(): void {
    if (!this._state.latestSnapshot) return;
    this._state = {
      ...this._state,
      baselineSnapshot: this._state.latestSnapshot,
      latestDiff: null,
      latestImpacts: [],
    };
    this._log('info', 'BASELINE_SET', 'Baseline set from current snapshot');
    this._notify();
  }

  clearBaseline(): void {
    this._state = {
      ...this._state,
      baselineSnapshot: null,
      latestDiff: null,
      latestImpacts: [],
    };
    this._log('info', 'BASELINE_CLEARED', 'Baseline cleared');
    this._notify();
  }

  addWriteBackGuard(guard: Omit<WriteBackGuard, 'expiresAt'>): void {
    this._guards.push({ ...guard, expiresAt: Date.now() + 5000 });
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private _schedulePoll(): void {
    this._clearPoll();
    const interval = this._state.latestSnapshot ? this._pollIntervalMs : this._idlePollIntervalMs;
    this._pollTimer = setTimeout(async () => {
      if (this._autoSync) {
        try {
          await this._fetchAndQueue();
        } catch (e) {
          this._log('error', 'SNAPSHOT_FAILED', `Poll error: ${(e as Error)?.message ?? e}`);
        } finally {
          this._schedulePoll();
        }
      }
    }, interval);
  }

  private _clearPoll(): void {
    if (this._pollTimer !== null) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
  }

  private async _fetchAndQueue(): Promise<void> {
    const project = await this._adapter.getActiveProject();
    if (!project) {
      this._log('warn', 'CONNECT_NO_PROJECT', 'No active project');
      return;
    }

    const seq = await this._adapter.getActiveSequence();
    if (!seq) {
      this._log('warn', 'CONNECT_NO_SEQUENCE', 'No active sequence');
      return;
    }

    const raw = await this._adapter.getSequenceSnapshot(seq.id);
    if (!raw) {
      this._log('error', 'SNAPSHOT_FAILED' as SyncLogCode, 'Snapshot read failed');
      return;
    }

    const snapshot = normalizeSnapshot(raw);

    if (snapshot.revisionToken === this._state.latestSnapshot?.revisionToken) {
      this._log('debug', 'SNAPSHOT_UNCHANGED', 'No changes detected');
      return;
    }

    this._pendingSnapshot = snapshot;
    this._processDebounced();
  }

  private _processSnapshot(): void {
    const snapshot = this._pendingSnapshot;
    if (!snapshot) return;
    this._pendingSnapshot = null;

    // Check write-back guard — suppress noise from self-initiated changes
    this._purgeExpiredGuards();
    const isGuarded = this._guards.length > 0;
    if (isGuarded) {
      this._log('debug', 'GUARD_SUPPRESSED', 'Write-back guard active — skipping diff noise');
    }

    let diff: TimelineDiff | null = null;
    let impacts: PullImpact[] = [];

    if (this._state.baselineSnapshot && !isGuarded) {
      diff = compareSnapshots(this._state.baselineSnapshot, snapshot);
      impacts = computePullImpacts(diff);
      if (diff.hasChanges) {
        this._log('info', 'DIFF_FOUND', `${diff.clipDiffs.length} clip change(s) detected`);
      }
    }

    this._state = {
      ...this._state,
      latestSnapshot: snapshot,
      latestDiff: diff,
      latestImpacts: impacts,
    };

    this._log('info', 'SNAPSHOT_OK', `Snapshot captured — rev ${snapshot.revisionToken}`);
    this._notify();
  }

  private _clearWritebackGuards(): void {
    this._guards = [];
  }

  private _purgeExpiredGuards(): void {
    const now = Date.now();
    this._guards = this._guards.filter(g => g.expiresAt > now);
  }

  private _log(level: SyncLogEntry['level'], code: SyncLogCode, message: string, details?: Record<string, unknown>): void {
    const entry: SyncLogEntry = { timeIso: nowIso(), level, code, message, details };
    this._state = {
      ...this._state,
      log: [...this._state.log.slice(-199), entry],
    };
  }

  private _notify(): void {
    this._onStateChange?.(this._state);
  }
}
