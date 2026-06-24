// OCF Index Store — Phase 1.
// Scans OCF roots, caches entries in IDB, provides search for OCF relink.
(function () {
  'use strict';

  const DB_NAME  = 'pfx_ocf_index_v1';
  const DB_STORE = 'ocf_entries';

  const KNOWN_OCF_EXTS = new Set(['.r3d', '.ari', '.arx', '.mxf', '.mov', '.braw', '.crm', '.cine']);

  // Camera detection by extension + path patterns
  const EXT_CAMERA = {
    '.r3d':  'RED',
    '.ari':  'ARRI',
    '.arx':  'ARRI',
    '.braw': 'BRAW',
    '.crm':  'CANON',
    '.cine': 'PHANTOM',
  };

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
          const store = db.createObjectStore(DB_STORE, { keyPath: 'ocfId' });
          store.createIndex('fileStem',  'fileStem',  { unique: false });
          store.createIndex('reel',      'reel',      { unique: false });
          store.createIndex('camera',    'camera',    { unique: false });
          store.createIndex('extension', 'extension', { unique: false });
          store.createIndex('projectId', 'projectId', { unique: false });
        }
      };
      req.onsuccess  = () => { _db = req.result; _dbPromise = null; resolve(_db); };
      req.onerror    = () => { _dbPromise = null; reject(req.error); };
    });
    return _dbPromise;
  }

  async function _getAll(projectId) {
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

  async function _putAll(entries) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const store = tx.objectStore(DB_STORE);
      entries.forEach(e => store.put(e));
      tx.oncomplete = () => resolve(entries.length);
      tx.onerror    = () => reject(tx.error);
    });
  }

  async function _clearForProject(projectId) {
    const db = await _openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(DB_STORE, 'readwrite');
      const idx = tx.objectStore(DB_STORE).index('projectId');
      const req = idx.openCursor(IDBKeyRange.only(projectId));
      let count = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) { cursor.delete(); count++; cursor.continue(); }
      };
      tx.oncomplete = () => resolve(count);
      tx.onerror    = () => reject(tx.error);
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function _now() { return new Date().toISOString(); }
  function _uid() {
    return (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? `ocf_${crypto.randomUUID()}`
      : `ocf_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function _projectId() {
    try { return String(window.__MPS_PROJECT_ID || '').trim() || 'default'; } catch { return 'default'; }
  }

  function _detectCamera(fileName, path) {
    const ext = ('.' + fileName.split('.').pop()).toLowerCase();
    if (EXT_CAMERA[ext]) return EXT_CAMERA[ext];
    const full = (path + '/' + fileName).toLowerCase();
    if (/arri|alexa|amira/i.test(full)) return 'ARRI';
    if (/red|r3d|dsmc/i.test(full)) return 'RED';
    if (/sony|venice|burano|fx[0-9]/i.test(full)) return 'SONY';
    if (ext === '.mov') return 'UNKNOWN';
    return 'UNKNOWN';
  }

  function _extractReel(fileName) {
    // ARRI reel pattern: A001C001_... → A001
    const m = fileName.match(/^([A-Z][0-9]{3})[A-Z_]/);
    if (m) return m[1];
    // RED reel: A001_... or card prefix
    const m2 = fileName.match(/^([A-Z][0-9]{3,4})[-_]/);
    if (m2) return m2[1];
    return '';
  }

  function _extractFileStem(fileName) {
    const dotIdx = fileName.lastIndexOf('.');
    return dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
  }

  // ── Build entry from File System Access API FileEntry ─────────────────────
  function _entryFromFile(file, path, projectId) {
    const fileName = file.name;
    const ext = '.' + fileName.split('.').pop().toLowerCase();
    if (!KNOWN_OCF_EXTS.has(ext)) return null;

    return {
      ocfId:           _uid(),
      clipKey:         _extractFileStem(fileName).toLowerCase(),
      camera:          _detectCamera(fileName, path),
      path:            path + '/' + fileName,
      fileName,
      fileStem:        _extractFileStem(fileName),
      extension:       ext,
      reel:            _extractReel(fileName),
      card:            '',
      startTc:         '',
      endTc:           '',
      fps:             null,
      durationFrames:  null,
      width:           null,
      height:          null,
      codec:           '',
      size:            file.size || 0,
      mtime:           file.lastModified || 0,
      metadataQuality: 'filesystem_only',
      indexedAt:       _now(),
      projectId,
    };
  }

  // ── Recursive scan using File System Access API ───────────────────────────
  async function _scanDir(dirHandle, basePath, entries, maxDepth) {
    if (maxDepth <= 0) return;
    try {
      for await (const [name, handle] of dirHandle.entries()) {
        if (handle.kind === 'file') {
          const file = await handle.getFile();
          const entry = _entryFromFile(file, basePath, _projectId());
          if (entry) entries.push(entry);
        } else if (handle.kind === 'directory') {
          await _scanDir(handle, basePath + '/' + name, entries, maxDepth - 1);
        }
      }
    } catch (e) {
      console.warn('[OCF] scan error at', basePath, e);
    }
  }

  // ── OCF Roots management (stored in localStorage) ─────────────────────────
  const LS_KEY_ROOTS = 'pfx.ocf.roots';

  function getRoots() {
    try {
      const raw = localStorage.getItem(LS_KEY_ROOTS);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  }

  // Stored root: { label, path, dirHandleKey } — dirHandleKey points to IDB handle
  async function addRoot(label, dirHandle) {
    const roots = getRoots();
    // Persist handle in IDB via projectFile helper if available
    let handleKey = `ocf_root_${Date.now()}`;
    try {
      if (typeof window.pfxIdbSet === 'function') {
        await window.pfxIdbSet(handleKey, dirHandle);
      }
    } catch { handleKey = ''; }
    const path = dirHandle.name || label;
    roots.push({ label: label || path, path, dirHandleKey: handleKey, addedAt: _now() });
    localStorage.setItem(LS_KEY_ROOTS, JSON.stringify(roots));
    return roots;
  }

  function removeRoot(idx) {
    const roots = getRoots();
    roots.splice(idx, 1);
    localStorage.setItem(LS_KEY_ROOTS, JSON.stringify(roots));
    return roots;
  }

  // ── Public scan: user picks a folder or we reuse stored handles ───────────
  async function scanNewRoot(label) {
    if (!window.showDirectoryPicker) {
      return { ok: false, error: 'File System Access API not supported' };
    }
    let dirHandle;
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    } catch (e) {
      return { ok: false, error: e.message || 'User cancelled' };
    }
    await addRoot(label || dirHandle.name, dirHandle);
    return rebuildIndex([dirHandle]);
  }

  async function rebuildIndex(dirHandles) {
    const projectId = _projectId();
    await _clearForProject(projectId);

    const entries = [];
    const handles = dirHandles || [];
    // Also try to restore handles from IDB for stored roots
    if (!handles.length) {
      const roots = getRoots();
      for (const root of roots) {
        if (root.dirHandleKey) {
          try {
            const h = typeof window.pfxIdbGet === 'function'
              ? await window.pfxIdbGet(root.dirHandleKey) : null;
            if (h) {
              const perm = await h.queryPermission({ mode: 'read' });
              if (perm !== 'granted') {
                await h.requestPermission({ mode: 'read' });
              }
              handles.push(h);
            }
          } catch { /* handle stale */ }
        }
      }
    }

    for (const h of handles) {
      await _scanDir(h, h.name || 'OCF', entries, 8);
    }

    if (entries.length) await _putAll(entries);
    localStorage.setItem('pfx.ocf.indexedAt', _now());
    localStorage.setItem('pfx.ocf.count', String(entries.length));

    return { ok: true, count: entries.length, entries };
  }

  // ── Search ────────────────────────────────────────────────────────────────
  async function search(query) {
    const all = await _getAll(_projectId());
    if (!query) return all;
    const { fileStem, reel, startTc, fps, camera, extension } = query;
    return all.filter(e => {
      if (fileStem && e.fileStem && !e.fileStem.toLowerCase().includes(fileStem.toLowerCase())) return false;
      if (reel && e.reel && e.reel !== reel) return false;
      if (camera && camera !== 'UNKNOWN' && e.camera !== camera) return false;
      if (extension && e.extension !== extension) return false;
      return true;
    });
  }

  async function getAll() {
    return _getAll(_projectId());
  }

  async function getCount() {
    const all = await _getAll(_projectId());
    return all.length;
  }

  // ── Export / import for project save ─────────────────────────────────────
  async function exportState() {
    const entries = await _getAll(_projectId());
    return {
      ocfRoots:    getRoots(),
      ocfIndex:    entries,
      indexedAt:   localStorage.getItem('pfx.ocf.indexedAt') || '',
    };
  }

  async function importState(data) {
    if (!data) return;
    if (data.ocfRoots) localStorage.setItem(LS_KEY_ROOTS, JSON.stringify(data.ocfRoots));
    if (Array.isArray(data.ocfIndex) && data.ocfIndex.length) {
      await _clearForProject(_projectId());
      await _putAll(data.ocfIndex);
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────
  window.PFX_OCF_INDEX = {
    scanNewRoot,
    rebuildIndex,
    search,
    getAll,
    getCount,
    getRoots,
    addRoot,
    removeRoot,
    exportState,
    importState,
  };

  console.info('[OCF_INDEX] OCF Index Store ready');
})();
