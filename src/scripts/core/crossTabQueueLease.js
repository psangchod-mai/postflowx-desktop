// Cross-Tab Queue Lease — Phase 1.
// Uses BroadcastChannel + IDB heartbeat to elect a single leader tab for job submission.
// Only the leader tab may call renderWorkerClient.buildProxy().
(function () {
  'use strict';

  const DB_NAME   = 'pfx_queue_lease_v1';
  const DB_STORE  = 'leases';
  const LEASE_KEY = 'queue_leader';
  const LEASE_TTL = 15000;  // ms — leader must heartbeat within this window
  const HEARTBEAT = 5000;   // ms interval

  let _tabId = null;
  let _isLeader = false;
  let _heartbeatTimer = null;
  let _bc = null;

  // ── Tab ID ────────────────────────────────────────────────────────────────
  function _myTabId() {
    if (_tabId) return _tabId;
    _tabId = sessionStorage.getItem('pfx.tabId');
    if (!_tabId) {
      _tabId = `tab_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      sessionStorage.setItem('pfx.tabId', _tabId);
    }
    return _tabId;
  }

  // ── IDB lease store ───────────────────────────────────────────────────────
  let _db = null;
  let _dbPromise = null;
  function _openDB() {
    if (_db) return Promise.resolve(_db);
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE))
          req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess  = () => { _db = req.result; _dbPromise = null; resolve(_db); };
      req.onerror    = () => { _dbPromise = null; reject(req.error); };
    });
    return _dbPromise;
  }

  async function _getLease() {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get(LEASE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => reject(req.error);
    });
  }

  async function _setLease(lease) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      tx.objectStore(DB_STORE).put(lease, LEASE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
  }

  // ── Leader election ───────────────────────────────────────────────────────
  // acquireLease/releaseLease read-then-write the lease inside a *single* IDB
  // transaction (not via _getLease()+_setLease(), which are two separate
  // transactions with an await between them). IndexedDB serializes readwrite
  // transactions on the same store, so this closes the race where two tabs
  // both read a stale/absent lease before either write lands and both believe
  // they're leader.
  async function acquireLease() {
    const tabId = _myTabId();
    const now   = Date.now();
    const db = await _openDB();
    const took = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      const req = store.get(LEASE_KEY);
      let result = false;
      req.onsuccess = () => {
        const existing = req.result || null;
        // Take lease if none exists, or it's expired, or we already own it
        if (!existing || existing.leaseUntil < now || existing.queueLeaderTabId === tabId) {
          store.put({ queueLeaderTabId: tabId, leaseUntil: now + LEASE_TTL, heartbeat: now }, LEASE_KEY);
          result = true;
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror    = () => reject(tx.error);
    });
    if (took) {
      _isLeader = true;
      _startHeartbeat();
      _broadcast({ type: 'leader_elected', tabId });
    }
    return took;
  }

  async function releaseLease() {
    const tabId = _myTabId();
    const db = await _openDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      const req = store.get(LEASE_KEY);
      req.onsuccess = () => {
        const existing = req.result || null;
        if (existing?.queueLeaderTabId === tabId) {
          store.put({ queueLeaderTabId: '', leaseUntil: 0, heartbeat: 0 }, LEASE_KEY);
        }
      };
      tx.oncomplete = () => resolve();
      tx.onerror    = () => reject(tx.error);
    });
    _isLeader = false;
    _stopHeartbeat();
    _broadcast({ type: 'leader_released', tabId });
  }

  function isLeader() { return _isLeader; }

  async function checkLeadership() {
    const tabId = _myTabId();
    const lease = await _getLease();
    if (!lease) { _isLeader = false; return false; }
    const now = Date.now();
    if (lease.queueLeaderTabId === tabId && lease.leaseUntil > now) {
      _isLeader = true;
      return true;
    }
    _isLeader = false;
    return false;
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────
  function _startHeartbeat() {
    _stopHeartbeat();
    _heartbeatTimer = setInterval(async () => {
      try {
        const tabId = _myTabId();
        const now   = Date.now();
        // Read-then-write inside a single IDB transaction, same as
        // acquireLease/releaseLease above -- using _getLease()+_setLease()
        // here (two separate transactions with an await between them) would
        // reopen the exact race those functions were rewritten to close: a
        // throttled/delayed heartbeat could read a since-superseded lease and
        // overwrite another tab's fresh lease after it already took over.
        const db = await _openDB();
        const stillLeader = await new Promise((resolve, reject) => {
          const tx = db.transaction(DB_STORE, 'readwrite');
          const store = tx.objectStore(DB_STORE);
          const req = store.get(LEASE_KEY);
          let result = false;
          req.onsuccess = () => {
            const existing = req.result || null;
            if (existing?.queueLeaderTabId === tabId) {
              store.put({ queueLeaderTabId: tabId, leaseUntil: now + LEASE_TTL, heartbeat: now }, LEASE_KEY);
              result = true;
            }
          };
          tx.oncomplete = () => resolve(result);
          tx.onerror    = () => reject(tx.error);
        });
        if (!stillLeader) {
          // Lost leadership
          _isLeader = false;
          _stopHeartbeat();
        }
      } catch { }
    }, HEARTBEAT);
  }

  function _stopHeartbeat() {
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }
  }

  // ── BroadcastChannel for cross-tab messaging ──────────────────────────────
  try { _bc = new BroadcastChannel('pfx_queue_lease'); } catch { }
  function _broadcast(msg) { try { _bc?.postMessage(msg); } catch { } }
  if (_bc) {
    _bc.onmessage = async (ev) => {
      const msg = ev.data;
      if (msg?.type === 'leader_elected' && msg.tabId !== _myTabId()) {
        // Another tab became leader — we lose leadership
        _isLeader = false;
        _stopHeartbeat();
      }
      if (msg?.type === 'leader_released' && msg.tabId !== _myTabId()) {
        // Previous leader is gone — race to take over now instead of waiting the
        // full LEASE_TTL for the (possibly unwritten) IDB lease to expire.
        acquireLease().catch(() => {});
      }
      if (msg?.type === 'submit_jobs') {
        // Non-leader tabs receive this and do nothing — leader handles it
      }
    };
  }

  // ── Safe job submission gate ───────────────────────────────────────────────
  // Callers should use this instead of calling submitJobs directly.
  async function guardedSubmit(submitFn) {
    const leader = await checkLeadership() || await acquireLease();
    if (!leader) {
      return { ok: false, error: 'not_leader', message: 'Another tab is already submitting jobs.' };
    }
    try {
      return await submitFn();
    } finally {
      // Keep lease alive; don't release after each submit
    }
  }

  // ── Init on load ──────────────────────────────────────────────────────────
  // Try to acquire leadership immediately on script load (first tab wins).
  setTimeout(() => acquireLease().catch(() => {}), 100);

  // Release lease on tab close
  window.addEventListener('beforeunload', () => {
    // postMessage is synchronous and gets delivered even as this tab tears down,
    // so peers learn immediately. The async IDB write in releaseLease() usually
    // won't finish before unload, which is why we broadcast here directly.
    if (_isLeader) _broadcast({ type: 'leader_released', tabId: _myTabId() });
    releaseLease().catch(() => {});
    _stopHeartbeat();
  });

  // ── Public API ────────────────────────────────────────────────────────────
  window.PFX_QUEUE_LEASE = {
    acquireLease,
    releaseLease,
    isLeader,
    checkLeadership,
    guardedSubmit,
    getTabId: _myTabId,
  };

  console.info('[QUEUE_LEASE] Cross-tab queue lease module ready, tabId:', _myTabId());
})();
