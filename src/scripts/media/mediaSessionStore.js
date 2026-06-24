// scripts/media/mediaSessionStore.js
// Extension-side session bookkeeping for the shared media runtime.
// Sessions are module-scoped (survive tab navigation within the same extension context).
// Helper owns the actual open/decode state; this store caches extension-side metadata.

const _sessions = new Map(); // sessionId → SessionRecord
let _seq = 0;

/**
 * @typedef {Object} SessionRecord
 * @property {string}   sessionId
 * @property {string}   filePath
 * @property {string}   fileType      - FORMAT constant
 * @property {string}   backend       - BACKEND constant
 * @property {Object}   capabilities  - from getMediaCapabilities response
 * @property {Object}   metadata      - from getMediaMetadata response
 * @property {string}   cacheState    - 'pending'|'ready'|'error'|'closed'
 * @property {number}   openedAt      - Date.now()
 * @property {string}   lastError     - null or error message
 */

export function createSession(sessionId, record) {
  _sessions.set(sessionId, {
    sessionId,
    filePath:     '',
    fileType:     '',
    backend:      '',
    capabilities: {},
    metadata:     {},
    cacheState:   'pending',
    openedAt:     Date.now(),
    lastError:    null,
    ...record,
  });
}

export function getSession(sessionId) {
  return _sessions.get(sessionId) ?? null;
}

export function updateSession(sessionId, partial) {
  const s = _sessions.get(sessionId);
  if (!s) return false;
  Object.assign(s, partial);
  return true;
}

export function closeSession(sessionId) {
  const s = _sessions.get(sessionId);
  if (s) s.cacheState = 'closed';
  _sessions.delete(sessionId);
}

export function listSessions() {
  return [..._sessions.values()];
}

export function getSessionByPath(filePath) {
  for (const s of _sessions.values()) {
    if (s.filePath === filePath && s.cacheState !== 'closed') return s;
  }
  return null;
}

// Generates a short unique session ID for extension-side tracking
export function generateSessionId() {
  return `mss_${++_seq}_${Date.now().toString(36)}`;
}
