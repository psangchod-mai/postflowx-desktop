// scripts/auth/project-lease.js — PostFlowX Project Edit Lease
// Ensures only one tab can edit a project at a time.
// Uses BroadcastChannel for cross-tab coordination.
// Exposed as window.PFX_LEASE

window.PFX_LEASE = (() => {
  'use strict';

  const CHANNEL_NAME   = 'pfx-project-lease';
  const HEARTBEAT_MS   = 10_000;
  const LEASE_STALE_MS = 28_000; // if no heartbeat in 28s, treat lease as expired

  let _ch        = null;           // BroadcastChannel
  let _tabId     = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let _project   = null;           // current project name
  let _owner     = null;           // { tabId, projectId, ts }
  let _hbTimer   = null;           // heartbeat interval
  let _staleTimer= null;           // stale-check timeout
  let _onChange  = null;           // (isReadOnly: bool, reason: string) => void

  function _canEdit() {
    return window.PFX_PERMISSIONS?.canDoAction?.('save_project') ?? true;
  }

  function _ownLease() { return _owner?.tabId === _tabId; }

  function _send(msg) {
    try { _ch?.postMessage(msg); } catch {}
  }

  function _claim() {
    _owner = { tabId: _tabId, projectId: _project, ts: Date.now() };
    _send({ type: 'CLAIM', ..._owner });
    _startHeartbeat();
    _resetStale();
  }

  function _release() {
    if (_ownLease()) _send({ type: 'RELEASE', tabId: _tabId, projectId: _project });
    _owner = null;
    clearInterval(_hbTimer);
    clearTimeout(_staleTimer);
  }

  function _startHeartbeat() {
    clearInterval(_hbTimer);
    _hbTimer = setInterval(() => {
      if (_ownLease()) _send({ type: 'HEARTBEAT', tabId: _tabId, projectId: _project, ts: Date.now() });
    }, HEARTBEAT_MS);
  }

  function _resetStale() {
    clearTimeout(_staleTimer);
    _staleTimer = setTimeout(() => {
      // Owner went stale — try to reclaim if we can edit
      if (!_ownLease() && _canEdit() && _project) {
        _claim();
        _onChange?.(false, '');
      }
    }, LEASE_STALE_MS);
  }

  function _onmessage(e) {
    const m = e.data;
    if (!m?.type || m.projectId !== _project) return;
    if (m.tabId === _tabId) return; // our own echo

    if (m.type === 'CLAIM' || m.type === 'HEARTBEAT') {
      if (!_ownLease()) {
        const prevOwner = _owner?.tabId;
        _owner = { tabId: m.tabId, projectId: m.projectId, ts: m.ts };
        _resetStale();
        // Only notify UI when the owning tab has actually changed
        if (prevOwner !== m.tabId) {
          _onChange?.(true, 'Another tab holds the edit lease');
        }
      }
    }

    if (m.type === 'RELEASE') {
      if (m.tabId === _owner?.tabId) {
        _owner = null;
        if (_canEdit() && _project) {
          _claim();
          _onChange?.(false, '');
        }
      }
    }

    if (m.type === 'PING') {
      _send({ type: 'PONG', tabId: _tabId, projectId: _project, ts: Date.now() });
    }

    if (m.type === 'PONG') {
      // Another tab is active — yield to it
      if (!_ownLease()) {
        _owner = { tabId: m.tabId, projectId: m.projectId, ts: m.ts };
        _resetStale();
        _onChange?.(true, 'Another tab holds the edit lease');
      }
    }
  }

  /** Call once on startup with a callback for read-only state changes. */
  function init(onReadOnlyChange) {
    _onChange = onReadOnlyChange;
    try {
      _ch = new BroadcastChannel(CHANNEL_NAME);
      _ch.onmessage = _onmessage;
    } catch (e) {
      console.warn('[PFX Lease] BroadcastChannel unavailable:', e.message);
    }
    window.addEventListener('beforeunload', _release);
  }

  /** Call when a project is opened. */
  function openProject(projectId) {
    _release();
    _project = projectId;

    if (!_canEdit()) {
      _onChange?.(true, 'No edit permission');
      return;
    }

    // Ping first — if another tab responds within 250ms we yield
    _send({ type: 'PING', tabId: _tabId, projectId });
    setTimeout(() => {
      if (!_owner || _ownLease()) {
        _claim();
        _onChange?.(false, '');
      }
    }, 250);
  }

  /** Call when the project is closed or tab navigates away. */
  function closeProject() {
    _release();
    _project = null;
  }

  function isLeaseholder() { return _ownLease(); }
  function getLeaseholder() { return _owner ? { ..._owner } : null; }

  return { init, openProject, closeProject, isLeaseholder, getLeaseholder };
})();
