// ShotWorkItem — Phase 1 core data model for VFX Marker → OCF Proxy QC workflow.
// Every VFX marker maps to exactly one ShotWorkItem.
// IDB-backed; survives tab close and service-worker termination.
(function () {
  'use strict';

  const DB_NAME  = 'pfx_swi_v1';
  const DB_STORE = 'shot_work_items';
  const SCHEMA_VERSION = 'marker-proxy-qc-v1';

  // ── IDB singleton ─────────────────────────────────────────────────────────
  let _db = null;
  let _dbPromise = null;
  function _openDB() {
    if (_db) return Promise.resolve(_db);
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          const store = db.createObjectStore(DB_STORE, { keyPath: 'shotWorkId' });
          store.createIndex('markerId',  'markerId',  { unique: false });
          store.createIndex('shotName',  'shotName',  { unique: false });
          store.createIndex('state',     'state',     { unique: false });
          store.createIndex('projectId', 'projectId', { unique: false });
        }
      };
      req.onsuccess  = () => { _db = req.result; _dbPromise = null; resolve(_db); };
      req.onerror    = () => { _dbPromise = null; reject(req.error); };
    });
    return _dbPromise;
  }

  async function _tx(mode, fn) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, mode);
      const store = tx.objectStore(DB_STORE);
      let result;
      try { result = fn(store); } catch (e) { reject(e); return; }
      if (result && typeof result.onsuccess !== 'undefined') {
        result.onsuccess = () => resolve(result.result);
        result.onerror   = () => reject(result.error);
      } else {
        tx.oncomplete = () => resolve(result);
        tx.onerror    = () => reject(tx.error);
      }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _now() { return new Date().toISOString(); }
  function _uid() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? `swi_${crypto.randomUUID()}`
      : `swi_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function _projectId() {
    try { return String(window.__MPS_PROJECT_ID || '').trim() || 'default'; } catch { return 'default'; }
  }

  // ── Factory ───────────────────────────────────────────────────────────────
  function createFromMarker(marker, ev, evIdx) {
    const fps = (typeof window._pmFps === 'number' && window._pmFps > 0)
      ? window._pmFps : 24;

    const srcIn  = marker.tcIn  || marker.recIn  || '00:00:00:00';
    const srcOut = marker.tcOut || marker.recOut || '00:00:00:00';

    // Compute duration frames from src TC
    let durationFrames = 0;
    if (typeof window.tcToFrames === 'function') {
      const fIn  = window.tcToFrames(srcIn,  fps);
      const fOut = window.tcToFrames(srcOut, fps);
      if (Number.isFinite(fIn) && Number.isFinite(fOut) && fOut > fIn) {
        durationFrames = fOut - fIn;
      }
    }
    if (!durationFrames && ev?.durationFrames) durationFrames = Number(ev.durationFrames) || 0;

    // Detect camera family from file extension / clip name
    const clipName = marker.clipName || ev?.clipName || ev?.clip || '';
    const ext = clipName.includes('.') ? clipName.split('.').pop().toLowerCase() : '';
    let camera = 'UNKNOWN';
    if (['.r3d', 'r3d'].includes(ext) || /red|r3d/i.test(clipName)) camera = 'RED';
    else if (['.ari', '.arx', 'ari', 'arx'].includes(ext) || /arri|alexa/i.test(clipName)) camera = 'ARRI';
    else if (/sony|venice|burano|fx[0-9]/i.test(clipName)) camera = 'SONY';
    else if (['.mxf', 'mxf'].includes(ext)) camera = 'ARRI'; // conservative guess for bare .mxf; upgraded by index

    const swi = {
      shotWorkId: _uid(),
      markerId:   marker.id,
      markerType: 'VFX',
      enabled:    true,
      projectId:  _projectId(),

      shotName:          marker.shotName  || '',
      plateName:         marker.shotName  || '',
      timelineClipId:    String(evIdx >= 0 ? evIdx : (marker._eventIdx ?? '')),
      editorialClipName: clipName,
      sourceClipName:    clipName,
      reel:              marker.reel  || ev?.reel || '',
      camera,

      srcTcIn:        srcIn,
      srcTcOut:       srcOut,
      recTcIn:        marker.recIn  || '00:00:00:00',
      recTcOut:       marker.recOut || '00:00:00:00',
      fps,
      durationFrames,
      handles:        8,  // default; configurable in settings

      ocfStatus:   'missing',
      colorStatus: 'missing',
      proxyStatus: 'blocked',
      qcStatus:    'blocked',
      state:       'marker_created',

      ocf:   null,
      color: null,
      proxy: null,
      qc:    null,

      proxyFingerprint: null,
      proxyIsStale:     false,

      createdAt: _now(),
      updatedAt: _now(),
    };
    return swi;
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────
  async function save(swi) {
    swi.updatedAt = _now();
    await _tx('readwrite', store => store.put(swi));
    _broadcast({ type: 'swi_updated', shotWorkId: swi.shotWorkId });
    return swi;
  }

  async function getById(shotWorkId) {
    return _tx('readonly', store => store.get(shotWorkId));
  }

  async function getByMarkerId(markerId) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const idx = tx.objectStore(DB_STORE).index('markerId');
      const req = idx.getAll(IDBKeyRange.only(markerId));
      req.onsuccess = () => resolve(req.result[0] || null);
      req.onerror   = () => reject(req.error);
    });
  }

  async function getAll(projectId) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readonly');
      const store = tx.objectStore(DB_STORE);
      const req = projectId
        ? store.index('projectId').getAll(IDBKeyRange.only(projectId))
        : store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  async function remove(shotWorkId) {
    await _tx('readwrite', store => store.delete(shotWorkId));
    _broadcast({ type: 'swi_removed', shotWorkId });
  }

  // update() reads-then-writes inside a *single* IDB transaction (not via
  // getById()+save(), which are two separate transactions with no lock
  // between them). IndexedDB serializes readwrite transactions on the same
  // store, so this closes the race where two independently-triggered update()
  // calls for the same shotWorkId (e.g. a proxy-poll progress tick and a cut
  // diff's TC-range update) both read the same stale record before either
  // write lands, silently dropping one call's patch.
  async function update(shotWorkId, patch) {
    const db = await _openDB();
    const updated = await new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      const req = store.get(shotWorkId);
      let result = null;
      req.onsuccess = () => {
        const existing = req.result;
        if (!existing) return;
        result = { ...existing, ...patch, shotWorkId, updatedAt: _now() };
        store.put(result);
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror    = () => reject(tx.error);
    });
    if (updated) _broadcast({ type: 'swi_updated', shotWorkId });
    return updated;
  }

  async function renameByMarkerIds(markerIds, shotName, meta = {}) {
    const text = String(shotName || '').trim();
    if (!text) return [];
    const ids = Array.isArray(markerIds) ? markerIds : [markerIds];
    const seen = new Set();
    const renamed = [];
    for (const markerId of ids) {
      if (markerId == null) continue;
      const key = String(markerId);
      if (seen.has(key)) continue;
      seen.add(key);
      const swi = await getByMarkerId(markerId);
      if (!swi?.shotWorkId) continue;
      const patch = {
        shotName: text,
        plateName: text,
      };
      if (meta && Object.keys(meta).length) patch.renameMeta = { ...(swi.renameMeta || {}), ...meta, renamedAt: _now() };
      renamed.push(await update(swi.shotWorkId, patch));
    }
    return renamed.filter(Boolean);
  }

  // ── Marker hook: called by prep_mark.js after a marker is finalized ───────
  async function onMarkerCreated(marker, ev, evIdx) {
    if (!marker?.id) return;
    // Only create ShotWorkItems when in VFX marker mode
    const isVfxMode = (typeof window._pmQs === 'function' && window._pmQs('vfxmarker'))
      || (typeof window._pmImportMode === 'string' && window._pmImportMode === 'vfxmarker');
    if (!isVfxMode) return;

    // Check for existing SWI for this marker
    const existing = await getByMarkerId(marker.id);
    if (existing) return;

    const swi = createFromMarker(marker, ev, evIdx);
    await save(swi);

    // Fire OCF relink if index exists
    if (window.PFX_OCF_RELINK?.relinkOne) {
      try {
        const result = await window.PFX_OCF_RELINK.relinkOne(swi);
        if (result) await update(swi.shotWorkId, result);
      } catch (e) {
        console.warn('[SWI] OCF relink failed for', swi.shotWorkId, e);
      }
    }

    // Refresh badges
    _refreshBadges();

    // Toast feedback
    _toast(`VFX marker created: ${swi.shotName || swi.shotWorkId.slice(0,12)}`);
    return swi;
  }

  async function onMarkerDeleted(markerId) {
    const swi = await getByMarkerId(markerId);
    if (swi) {
      await update(swi.shotWorkId, { enabled: false, state: 'marker_deleted' });
    }
  }

  async function onMarkerRangeChanged(markerId, newIn, newOut) {
    const swi = await getByMarkerId(markerId);
    if (!swi) return;
    await update(swi.shotWorkId, {
      srcTcIn:      newIn,
      srcTcOut:     newOut,
      proxyIsStale: true,
      proxyStatus:  swi.proxyStatus === 'ready' ? 'stale' : swi.proxyStatus,
      state:        'ocf_searching',
    });
  }

  // ── Export / import for project save ─────────────────────────────────────
  async function exportState() {
    const all = await getAll(_projectId());
    return { schemaVersion: SCHEMA_VERSION, shotWorkItems: all };
  }

  async function importState(data) {
    if (!data?.shotWorkItems || !Array.isArray(data.shotWorkItems)) return;
    for (const swi of data.shotWorkItems) {
      if (swi?.shotWorkId) await save(swi);
    }
  }

  // ── Cross-tab broadcast ───────────────────────────────────────────────────
  let _bc = null;
  let _bcCompat = null;
  try { _bc = new BroadcastChannel('pfx_swi'); } catch { /* Safari < 15.4 */ }
  try { _bcCompat = new BroadcastChannel('pfx_swi_updates'); } catch { /* Safari < 15.4 */ }
  function _broadcast(msg) {
    try { _bc?.postMessage(msg); } catch { }
    try { _bcCompat?.postMessage(msg); } catch { }
  }

  // ── Badge rendering ───────────────────────────────────────────────────────
  function _refreshBadges() {
    try {
      if (typeof window._pmRenderEventTable === 'function') window._pmRenderEventTable();
    } catch { }
  }

  // ── Toast ─────────────────────────────────────────────────────────────────
  function _toast(msg, type) {
    try {
      if (typeof window.pfxToast?.show === 'function') { window.pfxToast.show(msg, type || 'info'); return; }
      // Second line used to read `window._showToast`, which is function-scoped
      // inside three different IIFEs and global in none of them. Both branches
      // were phantoms, so "VFX marker created" only ever reached the console —
      // the user pressed a button and the app said nothing.
      if (typeof window._pfxToast === 'function') { window._pfxToast(msg, type || 'info'); return; }
      console.info('[SWI]', msg);
    } catch { }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.PFX_SWI = {
    // CRUD
    createFromMarker,
    save,
    getById,
    getByMarkerId,
    getAll,
    update,
    remove,
    renameByMarkerIds,
    // Hooks
    onMarkerCreated,
    onMarkerDeleted,
    onMarkerRangeChanged,
    // Persistence
    exportState,
    importState,
    // Utils
    getProjectId: _projectId,
  };

  console.info('[SWI] ShotWorkItems module ready');
})();
