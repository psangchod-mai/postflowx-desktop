// scripts/app/core/iconButtons.js
// Shared SVG icon system + helpers for compact PostFlowX controls.

const _svg = (body, viewBox = '0 0 24 24') => {
  return `<svg viewBox="${viewBox}" aria-hidden="true" focusable="false">${body}</svg>`;
};

const esc = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Asset depth differs between dev (src/scripts/core → repo-root assets/) and the
// packaged build (dist/desktop/scripts/core → dist/desktop/assets/). Pick the right
// number of "../" from this module's own URL so icons resolve in both layouts.
const _ASSET_UPS = import.meta.url.includes('/dist/desktop/') ? '../../' : '../../../';
const _assetUrl = (rel) => new URL(_ASSET_UPS + rel, import.meta.url).href;
const FIT_TOGGLE_IMG = _assetUrl('assets/icons/fit.png');
const UNFIT_TOGGLE_IMG = _assetUrl('assets/icons/un_fit.png');
const APP_FOLDER_ICON_IMG = _assetUrl('assets/icons/app_icon_128.png');

// Minimal, stroke-based icons (crisp at small sizes).
// Styling is handled in CSS via currentColor.
const ICONS = {
  fit: _svg([
    '<polyline points="15 3 21 3 21 9" />',
    '<polyline points="9 21 3 21 3 15" />',
    '<line x1="21" y1="3" x2="14" y2="10" />',
    '<line x1="3" y1="21" x2="10" y2="14" />'
  ].join('')),

  fullscreen: _svg([
    '<polyline points="9 3 3 3 3 9" />',
    '<polyline points="15 3 21 3 21 9" />',
    '<polyline points="15 21 21 21 21 15" />',
    '<polyline points="9 21 3 21 3 15" />'
  ].join('')),

  home: _svg([
    '<line x1="6" y1="5" x2="6" y2="19" />',
    '<polyline points="18 20 10 12 18 4 18 20" />'
  ].join('')),

  end: _svg([
    '<polyline points="6 4 14 12 6 20 6 4" />',
    '<line x1="18" y1="5" x2="18" y2="19" />'
  ].join('')),

  prev: _svg('<polyline points="15 18 9 12 15 6" />'),
  next: _svg('<polyline points="9 18 15 12 9 6" />'),

  prevFrame: _svg([
    '<line x1="7" y1="6" x2="7" y2="18" />',
    '<polyline points="17 18 10 12 17 6" />'
  ].join('')),

  nextFrame: _svg([
    '<polyline points="7 6 14 12 7 18" />',
    '<line x1="17" y1="6" x2="17" y2="18" />'
  ].join('')),

  play: _svg('<polygon points="9,7 17,12 9,17" />'),
  pause: _svg([
    '<line x1="10" y1="7" x2="10" y2="17" />',
    '<line x1="14" y1="7" x2="14" y2="17" />'
  ].join('')),

  swap: _svg([
    '<polyline points="7 7 3 11 7 15" />',
    '<line x1="3" y1="11" x2="21" y2="11" />',
    '<polyline points="17 7 21 11 17 15" />'
  ].join('')),

  lock: _svg([
    '<rect x="5" y="11" width="14" height="10" rx="2" />',
    '<path d="M7 11V8a5 5 0 0 1 10 0v3" />'
  ].join('')),

  unlock: _svg([
    '<rect x="5" y="11" width="14" height="10" rx="2" />',
    '<path d="M9 11V8a4 4 0 0 1 8 0" />',
    '<path d="M9 8a4 4 0 0 0-4 4" />'
  ].join('')),

  timeline: _svg([
    '<line x1="4" y1="7" x2="20" y2="7" />',
    '<line x1="4" y1="17" x2="20" y2="17" />',
    '<line x1="9" y1="7" x2="9" y2="17" />',
    '<rect x="12" y="10" width="6" height="4" rx="1" />'
  ].join('')),
  timelineOff: _svg([
    '<line x1="4" y1="7" x2="20" y2="7" />',
    '<line x1="4" y1="17" x2="20" y2="17" />',
    '<line x1="9" y1="7" x2="9" y2="17" />',
    '<rect x="12" y="10" width="6" height="4" rx="1" />',
    '<line x1="4" y1="4" x2="20" y2="20" />'
  ].join('')),

  table: _svg([
    '<rect x="4" y="5" width="16" height="14" rx="2" />',
    '<line x1="4" y1="10" x2="20" y2="10" />',
    '<line x1="10" y1="5" x2="10" y2="19" />'
  ].join('')),
  tableOff: _svg([
    '<rect x="4" y="5" width="16" height="14" rx="2" />',
    '<line x1="4" y1="10" x2="20" y2="10" />',
    '<line x1="10" y1="5" x2="10" y2="19" />',
    '<line x1="4" y1="4" x2="20" y2="20" />'
  ].join('')),

  pullprep: _svg([
    '<path d="M4 7.5h16v8.5H4z" />',
    '<path d="M9 4.5h6" />',
    '<path d="M12 8.5v6" />',
    '<path d="M9.5 11.5 12 14l2.5-2.5" />'
  ].join('')),
  cutdiff: _svg([
    '<rect x="4" y="5" width="16" height="14" rx="2" />',
    '<path d="M12 5v14" />',
    '<path d="M7 9h2" />',
    '<path d="M15 15h2" />'
  ].join('')),
  marker: _svg([
    '<path d="M7 20V5" />',
    '<path d="M7 5h9l-2.3 3L16 11H7" />'
  ].join('')),
  link: _svg([
    '<path d="M10 8H8a4 4 0 0 0 0 8h2" />',
    '<path d="M14 8h2a4 4 0 0 1 0 8h-2" />',
    '<line x1="9" y1="12" x2="15" y2="12" />'
  ].join('')),
  qc: _svg([
    '<rect x="4" y="5" width="16" height="12" rx="2" />',
    '<path d="M10 19h4" />',
    '<path d="M7 11s2-3 5-3 5 3 5 3-2 3-5 3-5-3-5-3Z" />',
    '<circle cx="12" cy="11" r="1.5" />'
  ].join('')),
  settings: _svg([
    '<line x1="5" y1="7" x2="19" y2="7" />',
    '<circle cx="9" cy="7" r="2" />',
    '<line x1="5" y1="12" x2="19" y2="12" />',
    '<circle cx="15" cy="12" r="2" />',
    '<line x1="5" y1="17" x2="19" y2="17" />',
    '<circle cx="11" cy="17" r="2" />'
  ].join('')),

  burnin: _svg([
    '<rect x="4" y="5" width="16" height="14" rx="2" />',
    '<path d="M7 9h10" />',
    '<path d="M7 12h6" />',
    '<path d="M7 15h4" />'
  ].join('')),
  newFile: _svg([
    '<path d="M8 4h6l4 4v12H8z" />',
    '<path d="M14 4v4h4" />',
    '<path d="M12 11v6" />',
    '<path d="M9 14h6" />'
  ].join('')),
  save: _svg([
    '<path d="M6 4h10l2 2v14H6z" />',
    '<path d="M9 4v5h6V4" />',
    '<path d="M9 20v-6h6v6" />'
  ].join('')),
  saveAs: _svg([
    '<path d="M6 4h10l2 2v14H6z" />',
    '<path d="M9 4v5h6V4" />',
    '<path d="M9 20v-6h6v6" />',
    '<path d="M19 13v5" />',
    '<path d="M16.5 15.5H21.5" />'
  ].join('')),
  load: _svg([
    '<path d="M4 8h5l2 2h9v8H4z" />',
    '<path d="M12 14V7" />',
    '<path d="M9.5 9.5 12 7l2.5 2.5" />'
  ].join('')),
  folder: `<img src="${esc(APP_FOLDER_ICON_IMG)}" alt="">`,
  trash: _svg([
    '<path d="M5 7h14" />',
    '<path d="M9 7V5h6v2" />',
    '<rect x="7" y="7" width="10" height="12" rx="2" />',
    '<path d="M10 10v6" />',
    '<path d="M14 10v6" />'
  ].join('')),

  input: _svg([
    '<rect x="4" y="5" width="16" height="14" rx="2" />',
    '<path d="M12 8v7" />',
    '<path d="M9.5 12.5 12 15l2.5-2.5" />'
  ].join('')),
  inspector: _svg([
    '<rect x="4" y="5" width="16" height="14" rx="2" />',
    '<line x1="10" y1="5" x2="10" y2="19" />',
    '<path d="M13 9h4" />',
    '<path d="M13 12h3" />',
    '<path d="M13 15h4" />'
  ].join('')),
  exportOtio: _svg([
    '<path d="M8 4h6l4 4v12H8z" />',
    '<path d="M14 4v4h4" />',
    '<path d="M12 16V9" />',
    '<path d="M9.5 11.5 12 9l2.5 2.5" />'
  ].join('')),
  exportEdl: _svg([
    '<path d="M4 7h10" />',
    '<path d="M4 12h16" />',
    '<path d="M4 17h10" />',
    '<path d="M17 8v8" />',
    '<path d="M14.5 10.5 17 8l2.5 2.5" />'
  ].join('')),
  events: _svg([
    '<line x1="8" y1="7" x2="18" y2="7" />',
    '<line x1="8" y1="12" x2="18" y2="12" />',
    '<line x1="8" y1="17" x2="18" y2="17" />',
    '<circle cx="5" cy="7" r="1" />',
    '<circle cx="5" cy="12" r="1" />',
    '<circle cx="5" cy="17" r="1" />'
  ].join('')),
  reels: _svg([
    '<circle cx="12" cy="12" r="7" />',
    '<circle cx="9" cy="9" r="1.1" />',
    '<circle cx="15" cy="9" r="1.1" />',
    '<circle cx="9" cy="15" r="1.1" />',
    '<circle cx="15" cy="15" r="1.1" />'
  ].join('')),
  fps: _svg([
    '<path d="M12 6v6l4 2" />',
    '<circle cx="12" cy="12" r="7" />'
  ].join('')),
  storage: _svg([
    '<ellipse cx="12" cy="6" rx="6.5" ry="2.5" />',
    '<path d="M5.5 6v6c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V6" />',
    '<path d="M5.5 12v6c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-6" />'
  ].join('')),

  power: _svg([
    '<path d="M12 4v7" />',
    '<path d="M8 6.5a6 6 0 1 0 8 0" />'
  ].join('')),
  conform: _svg([
    '<circle cx="12" cy="12" r="7" />',
    '<path d="M9 12.5 11 14.5 15.5 10" />'
  ].join('')),
  rename: _svg([
    '<path d="M4 7h10" />',
    '<path d="M4 12h6" />',
    '<path d="M4 17h8" />',
    '<path d="M15.5 8.5 18 11l-6.5 6.5H9v-2.5Z" />'
  ].join('')),
  merge: _svg([
    '<path d="M6 8h6" />',
    '<path d="M6 16h6" />',
    '<path d="M12 8c3.5 0 6 1.5 6 4s-2.5 4-6 4" />',
    '<path d="M15 10.5 18 12l-3 1.5" />'
  ].join('')),
  flatten: _svg([
    '<rect x="6" y="6" width="12" height="4" rx="1" />',
    '<rect x="6" y="14" width="12" height="4" rx="1" />',
    '<path d="M9 12h6" />'
  ].join('')),
  decompose: _svg([
    '<rect x="5" y="6" width="6" height="12" rx="1" />',
    '<rect x="13" y="6" width="6" height="12" rx="1" />',
    '<path d="M11 12h2" />'
  ].join('')),
  metadata: _svg([
    '<circle cx="6" cy="7" r="1" />',
    '<circle cx="6" cy="12" r="1" />',
    '<circle cx="6" cy="17" r="1" />',
    '<path d="M9 7h9" />',
    '<path d="M9 12h7" />',
    '<path d="M9 17h8" />'
  ].join('')),
  autosplit: _svg([
    '<path d="M6 7h4" />',
    '<path d="M6 17h4" />',
    '<path d="M14 7h4" />',
    '<path d="M14 17h4" />',
    '<circle cx="11" cy="9" r="1.5" />',
    '<circle cx="13" cy="15" r="1.5" />',
    '<path d="M12 10.5l-1.8 2.2" />',
    '<path d="M12 13.5l1.8-2.2" />'
  ].join('')),
  dfNdf: _svg([
    '<circle cx="8" cy="12" r="4" />',
    '<circle cx="16" cy="12" r="4" />',
    '<path d="M8 10v2l1.4.9" />',
    '<path d="M16 10v2l1.4.9" />',
    '<path d="M10.5 6.5h4" />',
    '<path d="M13.2 4.5 15 6.5l-1.8 2" />'
  ].join('')),
  retime: _svg([
    '<path d="M6 8h5" />',
    '<path d="M6 16h5" />',
    '<path d="M13 12h5" />',
    '<path d="M16 9l3 3-3 3" />'
  ].join('')),

  wipe: _svg([
    '<rect x="5" y="6" width="14" height="12" rx="2" />',
    '<line x1="12" y1="6" x2="12" y2="18" />',
    '<path d="M9.5 12h5" />'
  ].join('')),
  split: _svg([
    '<rect x="5" y="6" width="14" height="12" rx="2" />',
    '<path d="M5 9.5h14" />',
    '<path d="M5 14.5h14" />'
  ].join('')),
  sideBySide: _svg([
    '<rect x="4" y="6" width="7" height="12" rx="1.5" />',
    '<rect x="13" y="6" width="7" height="12" rx="1.5" />'
  ].join('')),
  ab: _svg([
    '<circle cx="8" cy="12" r="3" />',
    '<circle cx="16" cy="12" r="3" />',
    '<path d="M11 9.5h2" />',
    '<path d="M11 14.5h2" />'
  ].join('')),
  diff: _svg([
    '<rect x="5" y="7" width="7" height="10" rx="1.5" />',
    '<rect x="12" y="7" width="7" height="10" rx="1.5" />',
    '<path d="M10.5 12h3" />'
  ].join('')),
  heat: _svg([
    '<path d="M12 5c1.7 2 2.8 3.5 2.8 5.4A2.8 2.8 0 1 1 9.2 11c0-1.2.6-2.2 1.5-3.5" />',
    '<path d="M12 12c1 1 .9 2.5 0 3.5a2 2 0 1 1-2.7-2.9" />'
  ].join('')),
  analyze: _svg([
    '<circle cx="11" cy="11" r="5" />',
    '<line x1="15" y1="15" x2="20" y2="20" />',
    '<path d="M9 11h4" />'
  ].join('')),
  clear: _svg([
    '<circle cx="12" cy="12" r="7" />',
    '<path d="M9.5 9.5 14.5 14.5" />',
    '<path d="M14.5 9.5 9.5 14.5" />'
  ].join('')),
  pdf: _svg([
    '<path d="M8 4h6l4 4v12H8z" />',
    '<path d="M14 4v4h4" />',
    '<path d="M10 14h4" />',
    '<path d="M10 17h5" />'
  ].join('')),
  eye: _svg([
    '<path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z" />',
    '<circle cx="12" cy="12" r="2" />'
  ].join('')),
  eyeOff: _svg([
    '<path d="M3 12s3.2-5 9-5 9 5 9 5-3.2 5-9 5-9-5-9-5Z" />',
    '<circle cx="12" cy="12" r="2" />',
    '<path d="M5 19 19 5" />'
  ].join('')),
  chain: _svg([
    '<path d="M10 8H8a4 4 0 0 0 0 8h2" />',
    '<path d="M14 8h2a4 4 0 0 1 0 8h-2" />',
    '<line x1="10" y1="12" x2="14" y2="12" />'
  ].join('')),
  loop: _svg([
    '<path d="M7 7h8a4 4 0 0 1 0 8H6" />',
    '<path d="M9 5 7 7l2 2" />',
    '<path d="M17 19l2-2-2-2" />'
  ].join('')),
  audio: _svg([
    '<path d="M7 10H4v4h3l4 3V7z" />',
    '<path d="M15 10.5a3 3 0 0 1 0 3" />',
    '<path d="M17.5 8a6 6 0 0 1 0 8" />'
  ].join('')),
  compare: _svg([
    '<rect x="4" y="6" width="16" height="12" rx="2" />',
    '<line x1="12" y1="6" x2="12" y2="18" />'
  ].join('')),
  newStatus: _svg([
    '<rect x="6" y="6" width="12" height="12" rx="2" />',
    '<path d="M12 8v8" />',
    '<path d="M8 12h8" />'
  ].join('')),
  oldStatus: _svg([
    '<rect x="6" y="6" width="12" height="12" rx="2" />',
    '<path d="M8 12h8" />'
  ].join('')),

  refresh: _svg([
    '<path d="M20 11a8 8 0 1 1-2.34-5.66" />',
    '<polyline points="20 4 20 10 14 10" />'
  ].join('')),
  keyboard: _svg([
    '<rect x="3" y="6" width="18" height="12" rx="2" />',
    '<path d="M6 10h1" /><path d="M9 10h1" /><path d="M12 10h1" /><path d="M15 10h1" /><path d="M18 10h0.5" />',
    '<path d="M6 13h8" /><path d="M16 13h2.5" />'
  ].join('')),
  camera: _svg([
    '<rect x="4" y="8" width="16" height="10" rx="2" />',
    '<path d="M8 8l1.4-2h5.2L16 8" />',
    '<circle cx="12" cy="13" r="3" />'
  ].join('')),
  note: _svg([
    '<path d="M7 4h10l3 3v13H7z" />',
    '<path d="M17 4v4h4" />',
    '<path d="M10 11h6" />',
    '<path d="M10 15h5" />'
  ].join('')),
  feedback: _svg([
    '<path d="M5 6h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H11l-4 3v-3H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z" />',
    '<path d="M8 11h8" />',
    '<path d="M8 14h5" />'
  ].join('')),
  copy: _svg([
    '<rect x="9" y="9" width="10" height="10" rx="2" />',
    '<rect x="5" y="5" width="10" height="10" rx="2" />'
  ].join('')),
  info: _svg([
    '<circle cx="12" cy="12" r="8" />',
    '<path d="M12 10v5" />',
    '<circle cx="12" cy="7.5" r="0.8" fill="currentColor" stroke="none" />'
  ].join('')),
  monitor: _svg([
    '<rect x="4" y="5" width="16" height="11" rx="2" />',
    '<path d="M9 19h6" />',
    '<path d="M12 16v3" />'
  ].join('')),
  sceneDetect: _svg([
    '<circle cx="6" cy="6" r="2" />',
    '<circle cx="6" cy="18" r="2" />',
    '<path d="M19 5 8 16" />',
    '<path d="M14 14l5 5" />',
    '<path d="M8 8l3 3" />'
  ].join('')),
  filmstrip: _svg([
    '<rect x="4" y="6" width="16" height="12" rx="2" />',
    '<path d="M8 6v12" />',
    '<path d="M16 6v12" />',
    '<path d="M4 10h4" />',
    '<path d="M16 10h4" />',
    '<path d="M4 14h4" />',
    '<path d="M16 14h4" />'
  ].join('')),
  bin: _svg([
    '<path d="M4 8h5l2 2h9v8H4z" />',
    '<path d="M8 6h4" />'
  ].join('')),
  oneView: _svg([
    '<rect x="4" y="6" width="16" height="12" rx="2" />'
  ].join('')),
  twoView: _svg([
    '<rect x="4" y="6" width="16" height="12" rx="2" />',
    '<path d="M12 6v12" />'
  ].join('')),

  json: _svg([
    '<path d="M8 4h6l4 4v12H8z" />',
    '<path d="M14 4v4h4" />',
    '<path d="M11 10 9.5 12 11 14" />',
    '<path d="M13 10 14.5 12 13 14" />'
  ].join('')),
  ae: _svg([
    '<rect x="5" y="7" width="10" height="10" rx="1.8" />',
    '<rect x="9" y="5" width="10" height="10" rx="1.8" />',
    '<path d="M11 13h6" />',
    '<path d="M14 10v6" />'
  ].join('')),
  script: _svg([
    '<path d="M8 4h6l4 4v12H8z" />',
    '<path d="M14 4v4h4" />',
    '<path d="M10 11h6" />',
    '<path d="M10 15h4" />',
    '<path d="M10 8.5h2" />'
  ].join('')),
  nuke: _svg([
    '<circle cx="7" cy="12" r="2" />',
    '<circle cx="17" cy="8" r="2" />',
    '<circle cx="17" cy="16" r="2" />',
    '<path d="M9 12h6" />',
    '<path d="M8.6 10.8 15.4 8.9" />',
    '<path d="M8.6 13.2 15.4 15.1" />'
  ].join('')),
  ready: _svg([
    '<circle cx="12" cy="12" r="7" />',
    '<path d="M9 12.5 11 14.5 15.5 10" />'
  ].join('')),
  missing: _svg([
    '<path d="M12 5 19 18H5L12 5Z" />',
    '<path d="M12 10v4" />',
    '<circle cx="12" cy="16" r="0.8" fill="currentColor" stroke="none" />'
  ].join('')),
  shotsList: _svg([
    '<rect x="5" y="5" width="14" height="14" rx="2" />',
    '<path d="M9 9h6" />',
    '<path d="M9 12h6" />',
    '<path d="M9 15h4" />',
    '<circle cx="7" cy="9" r="0.8" fill="currentColor" stroke="none" />',
    '<circle cx="7" cy="12" r="0.8" fill="currentColor" stroke="none" />',
    '<circle cx="7" cy="15" r="0.8" fill="currentColor" stroke="none" />'
  ].join('')),
  status: _svg([
    '<circle cx="8" cy="12" r="2" />',
    '<path d="M12 12h5" />',
    '<path d="M12 8h7" />',
    '<path d="M12 16h6" />'
  ].join('')),

  chevUp: _svg('<polyline points="18 15 12 9 6 15" />'),
  chevDown: _svg('<polyline points="6 9 12 15 18 9" />'),
};

export function iconSvg(name){
  return ICONS[name] || ICONS.fit;
}

export function setLabeledIcon(el, iconName, label, opts = {}){
  if (!el) return;
  const visibleLabel = opts.visibleLabel !== false;
  const hasBar = opts.keepBar === true || (opts.keepBar !== false && !!el.querySelector?.('.bar'));
  const trailingHtml = opts.trailingHtml || '';
  const iconOnly = opts.iconOnly || !visibleLabel;
  if (opts.resetClasses !== false){
    el.classList.remove('pfx-iconbtn');
  }
  el.classList.add('pfx-lblbtn');
  if (opts.variant) el.dataset.pfxVariant = opts.variant;
  if (opts.size) el.dataset.pfxSize = opts.size;
  if (opts.extraClass) el.classList.add(opts.extraClass);
  if (label){
    el.setAttribute('aria-label', label);
    if (!opts.keepTitle) el.title = label;
  }
  el.innerHTML = `${hasBar ? '<span class="bar"></span>' : ''}`
    + `<span class="pfx-lbl-ico" aria-hidden="true">${iconSvg(iconName)}</span>`
    + (visibleLabel
      ? `<span class="pfx-lbl-txt">${esc(label || '')}</span>`
      : `<span class="pfx-sr">${esc(label || '')}</span>`)
    + trailingHtml;
  if (iconOnly) el.classList.add('pfx-lblbtn--icononly');
  else el.classList.remove('pfx-lblbtn--icononly');
}

export function setPlayPauseIconButton(btn, playLabel = 'Play / Pause'){
  if (!btn) return;
  btn.classList.add('pfx-playbtn');
  btn.setAttribute('aria-label', playLabel);
  btn.title = playLabel;
  btn.innerHTML = `<span class="pfx-playico cd-icon-play pfx-playico-play" aria-hidden="true">${iconSvg('play')}</span>`
    + `<span class="pfx-playico cd-icon-pause pfx-playico-pause" aria-hidden="true">${iconSvg('pause')}</span>`
    + `<span class="pfx-sr">${esc(playLabel)}</span>`;
}

export function setIconButton(btn, iconName, label){
  if (!btn) return;

  // Preserve theme bar if present.
  const hasBar = !!btn.querySelector?.('.bar');
  btn.classList.remove('pfx-lblbtn', 'pfx-lblbtn--icononly');
  btn.classList.add('pfx-iconbtn');
  if (label){
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }

  btn.innerHTML = `${hasBar ? '<span class="bar"></span>' : ''}`
    + `<span class="pfx-ib-ico" aria-hidden="true">${iconSvg(iconName)}</span>`
    + `<span class="pfx-sr">${esc(label || '')}</span>`;
}

export function setTimelineFitToggleButton(btn, isFitted = false, opts = {}){
  if (!btn) return;

  const hasBar = !!btn.querySelector?.('.bar');
  const fitted = !!isFitted;
  const fitLabel = String(opts.fitLabel || 'Fit timeline to view');
  const unfitLabel = String(opts.unfitLabel || 'Unfit timeline');
  const label = fitted ? unfitLabel : fitLabel;
  const iconSrc = fitted ? UNFIT_TOGGLE_IMG : FIT_TOGGLE_IMG;

  btn.classList.remove('pfx-lblbtn', 'pfx-lblbtn--icononly');
  btn.classList.add('pfx-iconbtn', 'pfx-fit-toggle-btn');
  btn.classList.toggle('is-active', fitted);
  btn.dataset.fitState = fitted ? 'fitted' : 'free';
  btn.setAttribute('aria-pressed', fitted ? 'true' : 'false');
  btn.setAttribute('aria-label', label);
  btn.title = label;

  btn.innerHTML = `${hasBar ? '<span class="bar"></span>' : ''}`
    + `<span class="pfx-ib-ico" aria-hidden="true"><img src="${esc(iconSrc)}" alt=""></span>`
    + `<span class="pfx-sr">${esc(label)}</span>`;
}

// For buttons that already have an icon + text (e.g., Marker cut actions),
// hide the visible label while keeping the tooltip/ARIA label.
export function makeIconOnly(btn, label){
  if (!btn) return;
  btn.classList.add('pfx-icononly');
  if (label){
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
}
