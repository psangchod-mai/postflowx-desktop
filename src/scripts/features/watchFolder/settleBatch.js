// scripts/features/watchFolder/settleBatch.js
//
// D1 watcher brain — debounce + ignore-filter for folder events.
// Dropping a camera roll fires hundreds of fs events and files appear while
// still being copied. Before proposing an action we must (a) ignore junk and
// in-progress/temp files and (b) wait for the burst to "settle" (no new event
// for `settleMs`). This module is the pure, testable core of that; the Electron
// `fs.watch` layer just calls add()/ready() and `now` is injected (no clock
// inside → deterministic in tests). Pair the settled batch with proposeAction().

const IGNORE_EXT = new Set([
  'tmp', 'temp', 'part', 'partial', 'download', 'crdownload', 'filepart', 'lock',
]);
const IGNORE_NAME = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

function _name(p) { return (String(p || '').split(/[\\/]/).pop() || ''); }
function _ext(name) { const d = name.lastIndexOf('.'); return d >= 0 ? name.slice(d + 1).toLowerCase() : ''; }

/** True for files a watch-folder should never propose on (junk / in-progress). */
export function isIgnorable(path) {
  const name = _name(path);
  if (!name) return true;
  const lower = name.toLowerCase();
  if (lower.startsWith('.')) return true;        // dotfiles (.DS_Store, .syncing, …)
  if (name.endsWith('~')) return true;           // editor/temp backups
  if (IGNORE_NAME.has(lower)) return true;
  if (IGNORE_EXT.has(_ext(name))) return true;   // .tmp/.part/.download/.lock …
  return false;
}

/**
 * Create a settle-batcher.
 * @param {object} [opts]
 * @param {number} [opts.settleMs=1500] quiet period (ms) before a batch is "ready"
 * @returns batcher with add/ready/pendingCount/clear
 */
export function createBatcher({ settleMs = 1500 } = {}) {
  const seen = new Map();   // path → lastSeenMs (most recent event)
  let lastEventAt = -Infinity;

  return {
    /** Record a filesystem event for `path` at time `nowMs`. Returns false if ignored. */
    add(path, nowMs) {
      if (!path || isIgnorable(path)) return false;
      seen.set(path, nowMs);
      lastEventAt = Math.max(lastEventAt, nowMs);
      return true;
    },

    /** Number of distinct non-ignored paths waiting. */
    pendingCount() { return seen.size; },

    /**
     * If the burst has settled (no event within settleMs) and files are pending,
     * return the batch of paths and RESET. Otherwise return null.
     */
    ready(nowMs) {
      if (seen.size === 0) return null;
      if (nowMs - lastEventAt < settleMs) return null;
      const paths = [...seen.keys()];
      seen.clear();
      lastEventAt = -Infinity;
      return paths;
    },

    /** Discard pending state (e.g. when the watch folder changes). */
    clear() { seen.clear(); lastEventAt = -Infinity; },
  };
}
