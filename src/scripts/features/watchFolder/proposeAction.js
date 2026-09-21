// scripts/features/watchFolder/proposeAction.js
//
// D1 — Watch-folder auto-detect → propose ONE action.
// Pure classification logic: given the files/folders that just appeared in a
// watched folder, decide the single most useful action to offer the user
// (e.g. "12 camera files detected → Link OCF"). No DOM, no fs — unit-testable.
// The Electron-side fs watcher + IPC + the one-click prompt UI sit on top of
// this and call `proposeAction(entries)`.

// ── Extension → kind classification ──────────────────────────────────────────
const TIMELINE_EXT = new Set([
  'edl', 'xml', 'fcpxml', 'fcpxmld', 'aaf', 'ale', 'otio', 'otioz', 'prproj',
]);
const OCF_EXT = new Set([
  'mxf', 'ari', 'arx', 'arri', 'r3d', 'braw', 'dpx', 'exr', 'dng', 'cine',
]);
const AUDIO_EXT = new Set(['wav', 'bwf', 'bwav', 'aif', 'aiff', 'broadcastwav']);
const VIDEO_EXT = new Set(['mov', 'mp4', 'm4v', 'mxf']);  // mov/mp4 = proxy/review; mxf also OCF (resolved below)
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'tif', 'tiff']);

function _ext(p) {
  const base = String(p || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}
function _base(p) {
  return (String(p || '').split(/[\\/]/).pop() || '').toLowerCase();
}

// An IMF package announces itself with ASSETMAP / CPL / PKL XML sidecars.
function _looksImf(name) {
  return /assetmap/.test(name) || /(^|[^a-z])cpl[_.-]/.test(name) || /(^|[^a-z])pkl[_.-]/.test(name);
}

/** Classify a single path into a domain kind. */
export function classifyFile(path) {
  const name = _base(path);
  if (!name) return 'other';
  if (_looksImf(name)) return 'imf';
  const ext = _ext(name);
  if (TIMELINE_EXT.has(ext)) return 'timeline';
  // Camera RAW / MXF / DPX / EXR → OCF. (.mov is review/proxy, handled as video.)
  if (OCF_EXT.has(ext)) return 'ocf';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (ext === 'mov' || ext === 'mp4' || ext === 'm4v') return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'other';
}

// Each kind maps to one concrete in-app action. Order = priority when several
// kinds appear at once: the most specific / highest-intent action wins so we
// still propose exactly ONE thing.
const ACTION_BY_KIND = {
  imf:      { action: 'imf.validate',  tab: 'imf',       verb: 'Validate IMF package' },
  timeline: { action: 'pull.import',   tab: 'prepmark',  verb: 'Import timeline for VFX Pull' },
  ocf:      { action: 'ocf.smartLink', tab: 'prepmark',  verb: 'Link OCF' },
  audio:    { action: 'bwav.open',     tab: 'bwav',      verb: 'Open in BWAV Inspector' },
  video:    { action: 'review.add',    tab: 'reviews',   verb: 'Add to Visual QC' },
  image:    { action: 'review.add',    tab: 'reviews',   verb: 'Add to Visual QC' },
};
const PRIORITY = ['imf', 'timeline', 'ocf', 'audio', 'video', 'image'];

/**
 * Decide the single action to propose for a set of newly-detected entries.
 * @param {Array<string|{path:string}>} entries — new files/folders in the watch folder
 * @returns {null | {action,tab,label,reason,kind,count,breakdown}}
 */
export function proposeAction(entries) {
  const paths = (entries || [])
    .map(e => (typeof e === 'string' ? e : e?.path))
    .filter(Boolean);
  if (!paths.length) return null;

  const breakdown = {};
  for (const p of paths) {
    const k = classifyFile(p);
    breakdown[k] = (breakdown[k] || 0) + 1;
  }

  const kind = PRIORITY.find(k => breakdown[k]);
  if (!kind) return null;  // only 'other' files → nothing actionable

  const def = ACTION_BY_KIND[kind];
  const count = breakdown[kind];
  const others = PRIORITY.filter(k => k !== kind && breakdown[k])
    .map(k => `${breakdown[k]} ${k}`);
  const reason = `${count} ${kind} file${count === 1 ? '' : 's'} detected`
    + (others.length ? ` (also ${others.join(', ')})` : '');

  return {
    action:   def.action,
    tab:      def.tab,
    label:    def.verb,
    reason,
    kind,
    count,
    breakdown,
  };
}
