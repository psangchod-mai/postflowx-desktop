// scripts/auth/pfx-session-store.js — PFX Desktop Session Store
//
// The desktop session (role, permissions, session token) used to live in
// plaintext localStorage (`pfx_desktop_session.v1`), forgeable/readable by
// anything running in the renderer. This wraps it behind Electron safeStorage
// via window.pfxPlatform.session (sync IPC — see boot-guard.js for why this
// must stay synchronous), migrating any pre-existing plaintext copy on first
// read. Falls back to localStorage when the IPC store isn't available (older
// preload, or the Chrome-extension target, which doesn't use this key anyway).
(function () {
  'use strict';

  const LEGACY_KEY = 'pfx_desktop_session.v1';

  function _hasIpcStore() {
    return !!(window.pfxPlatform?.session?.load && window.pfxPlatform?.session?.save);
  }

  function load() {
    if (_hasIpcStore()) {
      let fromStore = null;
      try { fromStore = window.pfxPlatform.session.load(); } catch {}
      if (fromStore) return fromStore;
      // One-time migration off the legacy plaintext key, if one exists.
      try {
        const legacy = JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null');
        if (legacy) {
          window.pfxPlatform.session.save(legacy);
          localStorage.removeItem(LEGACY_KEY);
          return legacy;
        }
      } catch {}
      return null;
    }
    try { return JSON.parse(localStorage.getItem(LEGACY_KEY) || 'null'); }
    catch { return null; }
  }

  function save(session) {
    if (_hasIpcStore()) {
      try { window.pfxPlatform.session.save(session); return; } catch {}
    }
    try { localStorage.setItem(LEGACY_KEY, JSON.stringify(session)); } catch {}
  }

  function clear() {
    if (_hasIpcStore()) { try { window.pfxPlatform.session.clear(); } catch {} }
    try { localStorage.removeItem(LEGACY_KEY); } catch {}
  }

  window.PFX_SESSION_STORE = { load, save, clear };
})();
