import type { SyncState } from '../core/syncCoordinator.js';

export type PanelStatus = 'disconnected' | 'connecting' | 'ready' | 'error';

export type PanelStore = {
  status: PanelStatus;
  statusMessage: string;
  projectName: string;
  sequenceName: string;
  autoSync: boolean;
  hasBaseline: boolean;
  syncState: SyncState | null;
};

type Listener = (store: PanelStore) => void;

const _listeners: Set<Listener> = new Set();
let _store: PanelStore = {
  status: 'disconnected',
  statusMessage: 'Not connected',
  projectName: '—',
  sequenceName: '—',
  autoSync: false,
  hasBaseline: false,
  syncState: null,
};

export function getStore(): PanelStore {
  return _store;
}

export function updateStore(patch: Partial<PanelStore>): void {
  _store = { ..._store, ...patch };
  _listeners.forEach(fn => fn(_store));
}

export function subscribe(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

export function applySync(state: SyncState): void {
  const latest = state.latestSnapshot;
  updateStore({
    syncState: state,
    projectName: latest?.projectName ?? '—',
    sequenceName: latest?.sequenceName ?? '—',
    hasBaseline: state.baselineSnapshot !== null,
    status: 'ready',
    statusMessage: 'Ready',
  });
}
