export type SyncLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type SyncLogCode =
  | 'CONNECT_OK'
  | 'CONNECT_NO_PROJECT'
  | 'CONNECT_NO_SEQUENCE'
  | 'SNAPSHOT_OK'
  | 'SNAPSHOT_UNCHANGED'
  | 'SNAPSHOT_FAILED'
  | 'DIFF_FOUND'
  | 'WRITEBACK_SELECTION_OK'
  | 'WRITEBACK_PLAYHEAD_OK'
  | 'WRITEBACK_MARKER_OK'
  | 'WRITEBACK_FAILED'
  | 'CACHE_INVALIDATED'
  | 'BASELINE_SET'
  | 'BASELINE_CLEARED'
  | 'GUARD_SUPPRESSED';

export type SyncLogEntry = {
  timeIso: string;
  level: SyncLogLevel;
  code: SyncLogCode;
  message: string;
  details?: Record<string, unknown>;
};
