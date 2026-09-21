// scripts/media/mediaFrameCache.js
// Extension-side in-memory LRU frame cache.
// Holds recently decoded frames (as data URLs) so repeated seeks to the
// same position are instant without a companion round-trip.
//
// Phase 7 improvement: the companion has a disk LRU cache (512 MB).
// This JS cache adds a second, faster layer: RAM cache for the last N frames
// per session, deduplicated across the current browser session.

const _MAX_FRAMES_PER_SESSION = 48;
const _MAX_SESSIONS           = 8;

// Store: Map<sessionId, Map<frameKey, {dataUrl, width, height, ts}>>
const _store = new Map();

/**
 * Generate a canonical frame key.
 * @param {number} frameIndex
 * @param {string} quality
 * @param {number} width
 * @param {number} height
 * @param {string} format
 */
function frameKey(frameIndex, quality = 'half', width = 1280, height = 720, format = 'jpg') {
  return `${frameIndex}:${quality}:${width}:${height}:${format}`;
}

/**
 * Look up a cached frame.
 * @returns {{ dataUrl, width, height, frameIndex } | null}
 */
export function cacheGet(sessionId, frameIndex, quality = 'half', width = 1280, height = 720, format = 'jpg') {
  const session = _store.get(sessionId);
  if (!session) return null;
  const key  = frameKey(frameIndex, quality, width, height, format);
  const entry = session.get(key);
  if (!entry) return null;
  // Touch for LRU
  entry.ts = Date.now();
  return entry;
}

/**
 * Store a decoded frame result in the cache.
 * @param {string} sessionId
 * @param {number} frameIndex
 * @param {{ dataUrl, width, height }} result
 * @param {Object} [opts]
 */
export function cachePut(sessionId, frameIndex, result, opts = {}) {
  const { quality = 'half', width = 1280, height = 720, format = 'jpg' } = opts;
  if (!result?.dataUrl) return;

  if (!_store.has(sessionId)) {
    // Evict oldest session if at limit
    if (_store.size >= _MAX_SESSIONS) {
      const oldest = [..._store.entries()].sort((a, b) => {
        const aOld = Math.min(...[...a[1].values()].map(e => e.ts));
        const bOld = Math.min(...[...b[1].values()].map(e => e.ts));
        return aOld - bOld;
      })[0];
      if (oldest) _store.delete(oldest[0]);
    }
    _store.set(sessionId, new Map());
  }

  const session = _store.get(sessionId);
  const key = frameKey(frameIndex, quality, width, height, format);

  session.set(key, {
    dataUrl:    result.dataUrl,
    width:      result.width  ?? width,
    height:     result.height ?? height,
    frameIndex,
    ts:         Date.now(),
  });

  // LRU eviction within session
  if (session.size > _MAX_FRAMES_PER_SESSION) {
    const sortedKeys = [...session.entries()].sort((a, b) => a[1].ts - b[1].ts);
    const toRemove = sortedKeys.slice(0, session.size - _MAX_FRAMES_PER_SESSION);
    for (const [k] of toRemove) session.delete(k);
  }
}

/**
 * Evict all frames for a session (call on closeMedia).
 */
export function cacheEvictSession(sessionId) {
  _store.delete(sessionId);
}

/**
 * Return stats for diagnostics.
 */
export function cacheStats() {
  let totalFrames = 0;
  const sessions = [];
  for (const [sid, sess] of _store) {
    totalFrames += sess.size;
    sessions.push({ sessionId: sid, frames: sess.size });
  }
  return { sessions: _store.size, totalFrames, maxPerSession: _MAX_FRAMES_PER_SESSION };
}
