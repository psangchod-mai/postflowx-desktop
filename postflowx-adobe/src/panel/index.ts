import { AdobePremiereAdapterImpl } from '../adapter/adobePremiereAdapter.js';
import { SyncCoordinator } from '../core/syncCoordinator.js';
import { getStore, updateStore, subscribe, applySync } from './store.js';
import { loadSettings, saveSettings, loadBaseline, saveBaseline, clearBaseline, saveSnapshotCache } from '../persistence/stateRepository.js';
import type { CreateMarkerInput } from '../adapter/hostTypes.js';
import type { PullImpact } from '../model/pullImpact.js';

const adapter = new AdobePremiereAdapterImpl();
const coordinator = new SyncCoordinator(adapter, {
  pollIntervalMs: 1000,
  idlePollIntervalMs: 4000,
  debounceMs: 300,
  onStateChange(state) {
    applySync(state);
    if (state.latestSnapshot) {
      saveSnapshotCache(
        state.latestSnapshot.projectId,
        state.latestSnapshot.sequenceId,
        state.latestSnapshot
      );
    }
    renderUI();
  },
});

// ── DOM refs ─────────────────────────────────────────────────────────────────

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const statusDot = () => el<HTMLElement>('status-dot');
const statusText = () => el<HTMLElement>('status-text');
const projectLabel = () => el<HTMLElement>('project-name');
const sequenceLabel = () => el<HTMLElement>('sequence-name');
const changedClipsList = () => el<HTMLElement>('changed-clips-list');
const affectedPullsList = () => el<HTMLElement>('affected-pulls-list');
const syncLogEl = () => el<HTMLElement>('sync-log');

// ── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const settings = loadSettings();

  updateStore({ status: 'connecting', statusMessage: 'Connecting…' });

  try {
    await adapter.connect();
    updateStore({ status: 'ready', statusMessage: 'Ready' });
  } catch (e) {
    updateStore({ status: 'error', statusMessage: 'Host not available' });
    return;
  }

  // Try restore baseline from last known project/sequence
  if (settings.lastProjectId && settings.lastSequenceId) {
    const baseline = loadBaseline(settings.lastProjectId, settings.lastSequenceId);
    if (baseline) coordinator.restoreBaseline(baseline);
  }

  coordinator.setAutoSync(false);
  await coordinator.syncNow();

  wireEvents();
  renderUI();
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireEvents(): void {
  el('btn-sync-now').addEventListener('click', () => coordinator.syncNow());

  el('btn-set-baseline').addEventListener('click', () => {
    coordinator.setBaseline();
    const snap = coordinator.state.latestSnapshot;
    if (snap) saveBaseline(snap.projectId, snap.sequenceId, snap);
  });

  el('btn-clear-baseline').addEventListener('click', () => {
    const snap = coordinator.state.latestSnapshot;
    coordinator.clearBaseline();
    if (snap) clearBaseline(snap.projectId, snap.sequenceId);
  });

  el('btn-add-issue-marker').addEventListener('click', () => addMarkerForSelected('issue'));
  el('btn-add-repull-marker').addEventListener('click', () => addMarkerForSelected('repull'));
}

// ── Render ────────────────────────────────────────────────────────────────────

function renderUI(): void {
  const store = getStore();

  // Status
  statusDot().className = `status-dot status-dot--${store.status}`;
  statusText().textContent = store.statusMessage;
  projectLabel().textContent = store.projectName;
  sequenceLabel().textContent = store.sequenceName;

  // Baseline indicator
  el('baseline-status').textContent = store.hasBaseline ? 'Baseline set' : 'No baseline';

  const state = store.syncState;

  // Changed clips
  const diff = state?.latestDiff;
  const clipsList = changedClipsList();
  clipsList.innerHTML = '';
  if (diff?.clipDiffs.length) {
    for (const d of diff.clipDiffs) {
      const row = document.createElement('div');
      row.className = 'list-row';
      row.dataset['clipId'] = d.clipId;
      const clip = d.latest ?? d.baseline;
      row.innerHTML = `<span class="badge badge--${d.kind}">${d.kind}</span> <span class="clip-name">${esc(clip?.name ?? d.clipId)}</span>`;
      row.addEventListener('click', () => revealClip(d.clipId));
      clipsList.appendChild(row);
    }
  } else {
    clipsList.innerHTML = '<div class="empty-state">No changes</div>';
  }

  // Affected pulls
  const pullsList = affectedPullsList();
  pullsList.innerHTML = '';
  const impacts = state?.latestImpacts ?? [];
  if (impacts.length) {
    for (const impact of impacts) {
      const row = document.createElement('div');
      row.className = `list-row list-row--${impact.severity}`;
      row.dataset['clipId'] = impact.clipId;
      row.innerHTML = `<span class="badge badge--${impact.severity}">${impact.severity}</span> <span class="clip-name">${esc(impact.shotId)}</span> <span class="action-hint">${impact.suggestedAction}</span>`;
      row.addEventListener('click', () => addRepullMarker(impact));
      pullsList.appendChild(row);
    }
  } else {
    pullsList.innerHTML = '<div class="empty-state">No affected pulls</div>';
  }

  // Sync log (last 30 entries)
  const logEl = syncLogEl();
  const entries = (state?.log ?? []).slice(-30).reverse();
  logEl.innerHTML = entries
    .map(e => `<div class="log-entry log-entry--${e.level}"><span class="log-time">${e.timeIso.slice(11, 19)}</span> <span class="log-code">${e.code}</span> ${e.message}</div>`)
    .join('');
}

// ── Actions ───────────────────────────────────────────────────────────────────

async function revealClip(clipId: string): Promise<void> {
  coordinator.addWriteBackGuard({ operationId: crypto.randomUUID(), kind: 'selection' });
  const ok = await adapter.selectClip(clipId);
  if (!ok) await adapter.goToClip(clipId);
}

async function addMarkerForSelected(kind: 'issue' | 'repull'): Promise<void> {
  const snap = coordinator.state.latestSnapshot;
  if (!snap) return;

  const ticks = snap.playheadTicks ?? '0';
  const ownerId = crypto.randomUUID();
  const input: CreateMarkerInput = {
    name: `[PFX][${kind.toUpperCase()}] Manual`,
    startTicks: ticks,
    owner: 'postflowx',
    ownerId,
    markerType: 'Comment',
    colorIndex: kind === 'repull' ? 2 : 1,
  };

  coordinator.addWriteBackGuard({ operationId: ownerId, kind: 'marker-create' });
  await adapter.createMarker(input);
}

async function addRepullMarker(impact: PullImpact): Promise<void> {
  const ownerId = crypto.randomUUID();
  const input: CreateMarkerInput = {
    name: `[PFX][REPULL] ${impact.shotId}`,
    startTicks: impact.startTicks,
    owner: 'postflowx',
    ownerId,
    markerType: 'Comment',
    colorIndex: 2,
    payloadJson: JSON.stringify({
      owner: 'postflowx',
      ownerId,
      kind: 'repull',
      shotId: impact.shotId,
      rev: coordinator.state.latestSnapshot?.revisionToken ?? '',
    }),
  };

  coordinator.addWriteBackGuard({ operationId: ownerId, kind: 'marker-create' });
  const markerId = await adapter.createMarker(input);
  if (!markerId) console.warn('[PFX] createMarker failed for repull impact', impact.shotId);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

subscribe(renderUI);
document.addEventListener('DOMContentLoaded', () => { void init(); });
