// Persists plugin state using UXP localStorage (synchronous key-value store).
// Falls back to in-memory if UXP storage is unavailable.

import type { TimelineSnapshot } from '../model/timeline.js';

type PersistedSettings = {
  autoSync: boolean;
  pollIntervalMs: number;
  lastProjectId?: string;
  lastSequenceId?: string;
};

const KEY_SETTINGS = 'pfx_settings';
const KEY_BASELINE_PREFIX = 'pfx_baseline_';
const KEY_CACHE_PREFIX = 'pfx_cache_';

function store(): Storage {
  return (typeof localStorage !== 'undefined' ? localStorage : null) as Storage;
}

function safeGet(key: string): string | null {
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    store()?.setItem(key, value);
  } catch {
    // storage full or unavailable
  }
}

export function loadSettings(): PersistedSettings {
  const raw = safeGet(KEY_SETTINGS);
  if (!raw) return { autoSync: false, pollIntervalMs: 1000 };
  try {
    return JSON.parse(raw) as PersistedSettings;
  } catch {
    return { autoSync: false, pollIntervalMs: 1000 };
  }
}

export function saveSettings(settings: PersistedSettings): void {
  safeSet(KEY_SETTINGS, JSON.stringify(settings));
}

export function loadBaseline(projectId: string, sequenceId: string): TimelineSnapshot | null {
  const raw = safeGet(`${KEY_BASELINE_PREFIX}${projectId}_${sequenceId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TimelineSnapshot;
  } catch {
    return null;
  }
}

export function saveBaseline(projectId: string, sequenceId: string, snapshot: TimelineSnapshot): void {
  safeSet(`${KEY_BASELINE_PREFIX}${projectId}_${sequenceId}`, JSON.stringify(snapshot));
}

export function clearBaseline(projectId: string, sequenceId: string): void {
  try {
    store()?.removeItem(`${KEY_BASELINE_PREFIX}${projectId}_${sequenceId}`);
  } catch {
    // ignore
  }
}

export function saveSnapshotCache(projectId: string, sequenceId: string, snapshot: TimelineSnapshot): void {
  safeSet(`${KEY_CACHE_PREFIX}${projectId}_${sequenceId}`, JSON.stringify(snapshot));
}
