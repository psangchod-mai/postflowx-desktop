// scripts/features/home/homeScreen.js
// PostFlowX Entry / Home Screen — Electron macOS desktop app
// ES2022 module, no build step required.
// ─────────────────────────────────────────────────────────────────────────────

// ── Constants ─────────────────────────────────────────────────────────────────
const STORAGE_KEY_RECENTS = 'recentProjects:pull_prep';
const STORAGE_KEY_CURRENT = 'currentProjectName:pull_prep';
const MAX_RECENTS = 8;

// ── Workspace definitions ─────────────────────────────────────────────────────
const WORKSPACES = [
  {
    id:       'pull-prep',
    title:    'Pull Prep',
    subtitle: 'Build VFX pull packages from EDL/timeline',
    tabKey:   'prepmark',
    event:    null,
    icon:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1"/>
      <rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/>
      <path d="M14 17.5h7M17.5 14v7"/>
    </svg>`,
  },
  {
    id:       'vfx-pull',
    title:    'VFX Pull',
    subtitle: 'Workspace for reviewing and exporting OCF pulls',
    tabKey:   'prepmark',
    event:    'pfx:open-vfx-pull',
    icon:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="9"/>
      <path d="M12 8v4l3 3"/>
      <path d="M3.6 9h16.8M3.6 15h16.8"/>
    </svg>`,
  },
  {
    id:       'cut-diff',
    title:    'Cut Diff',
    subtitle: 'Compare timeline versions, detect changes',
    tabKey:   'cutdiff2',
    event:    null,
    icon:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M8 6h13M8 12h13M8 18h13"/>
      <path d="M3 6l1 1-1 1M3 12l1 1-1 1"/>
      <line x1="3" y1="18" x2="5" y2="18"/>
    </svg>`,
  },
  {
    id:       'imf',
    title:    'IMF Validation',
    subtitle: 'Validate IMF packages, compliance checks',
    tabKey:   'imf',
    event:    null,
    icon:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z"/>
      <path d="M2 17l10 5 10-5"/>
      <path d="M2 12l10 5 10-5"/>
    </svg>`,
  },
  {
    id:       'render-queue',
    title:    'Render Queue',
    subtitle: 'Manage and monitor render jobs',
    tabKey:   'renderq',
    event:    null,
    icon:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="7" width="20" height="4" rx="1"/>
      <rect x="2" y="13" width="20" height="4" rx="1"/>
      <path d="M6 7V5M18 7V5M6 17v2M18 17v2"/>
    </svg>`,
  },
  {
    id:       'settings',
    title:    'Settings',
    subtitle: 'App preferences, integrations, shortcuts',
    tabKey:   'about',
    event:    null,
    icon:     `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12"/>
    </svg>`,
  },
];

// ── HTML template ─────────────────────────────────────────────────────────────
function _buildHTML(version) {
  const workspaceCards = WORKSPACES.map(ws => `
    <button class="hs-card" data-ws-id="${ws.id}" title="${ws.title}">
      <span class="hs-card-icon">${ws.icon}</span>
      <span class="hs-card-title">${ws.title}</span>
      <span class="hs-card-sub">${ws.subtitle}</span>
    </button>
  `).join('');

  return `
<style>
  #hs-root {
    height: 100%;
    overflow-y: auto;
    background: #1a1a1a;
    color: #e4ebff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    box-sizing: border-box;
  }
  #hs-inner {
    display: flex;
    flex-direction: column;
    max-width: 1080px;
    margin: 0 auto;
    padding: 44px 52px 64px;
    gap: 36px;
    box-sizing: border-box;
  }

  /* ── Hero ── */
  #hs-hero {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  #hs-hero h1 {
    margin: 0;
    font-size: 26px;
    font-weight: 700;
    letter-spacing: -0.3px;
    color: #e4ebff;
  }
  #hs-hero p {
    margin: 0;
    font-size: 13.5px;
    color: #8a96b0;
  }
  #hs-hero .hs-version {
    margin-top: 4px;
    font-size: 11.5px;
    color: #4e5a72;
    letter-spacing: 0.3px;
  }

  /* ── Section headers ── */
  .hs-section-title {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.9px;
    text-transform: uppercase;
    color: #4e5a72;
    margin: 0 0 12px;
  }

  /* ── Quick actions ── */
  #hs-quick-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .hs-btn {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 7px 14px;
    background: #222;
    border: 1px solid #2e3447;
    border-radius: 6px;
    color: #c8d1e8;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s, color 0.15s;
    white-space: nowrap;
  }
  .hs-btn:hover {
    border-color: #37b573;
    background: #1e2b23;
    color: #e4ebff;
  }
  .hs-btn:active {
    background: #1a2620;
  }
  .hs-btn svg {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: #37b573;
  }

  /* ── Workspace grid ── */
  #hs-workspace-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
  }
  @media (max-width: 680px) {
    #hs-workspace-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }
  .hs-card {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 18px 18px 20px;
    background: #222;
    border: 1px solid #2a2e3d;
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    color: inherit;
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }
  .hs-card:hover {
    border-color: #37b573;
    background: #1e2b23;
    box-shadow: 0 0 0 1px #37b57330, 0 4px 16px #00000040;
  }
  .hs-card:active {
    background: #1a2620;
  }
  .hs-card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: #1a1a1a;
    border-radius: 6px;
    color: #37b573;
    margin-bottom: 2px;
  }
  .hs-card-icon svg {
    width: 18px;
    height: 18px;
  }
  .hs-card-title {
    font-size: 13.5px;
    font-weight: 600;
    color: #e4ebff;
    line-height: 1.2;
  }
  .hs-card-sub {
    font-size: 11.5px;
    color: #606880;
    line-height: 1.4;
  }

  /* ── Bottom two-column layout ── */
  #hs-bottom {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 40px;
    align-items: start;
  }
  @media (max-width: 680px) {
    #hs-bottom {
      grid-template-columns: 1fr;
    }
  }

  /* ── System status ── */
  #hs-status-list {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .hs-status-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
  }
  .hs-status-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
    background: #4e5a72;
  }
  .hs-status-dot.ok     { background: #37b573; }
  .hs-status-dot.warn   { background: #e8a940; }
  .hs-status-dot.error  { background: #e05252; }
  .hs-status-dot.idle   { background: #4e5a72; }
  .hs-status-label {
    color: #8a96b0;
    min-width: 120px;
    flex-shrink: 0;
  }
  .hs-status-value {
    color: #c8d1e8;
    font-variant-numeric: tabular-nums;
  }
  .hs-status-value.ok    { color: #37b573; }
  .hs-status-value.warn  { color: #e8a940; }
  .hs-status-value.error { color: #e05252; }

  /* ── Recent projects ── */
  #hs-recents-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 280px;
    overflow-y: auto;
    scrollbar-width: thin;
    scrollbar-color: #2e3447 transparent;
  }
  #hs-recents-list::-webkit-scrollbar { width: 5px; }
  #hs-recents-list::-webkit-scrollbar-track { background: transparent; }
  #hs-recents-list::-webkit-scrollbar-thumb { background: #2e3447; border-radius: 3px; }

  .hs-recent-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 8px;
    border-radius: 5px;
    cursor: pointer;
    transition: background 0.12s;
  }
  .hs-recent-row:hover {
    background: #242835;
  }
  .hs-recent-info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .hs-recent-name {
    font-size: 13px;
    font-weight: 500;
    color: #d4dcf2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hs-recent-meta {
    font-size: 11px;
    color: #4e5a72;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hs-recent-date {
    font-size: 11px;
    color: #4e5a72;
    flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  .hs-recent-open {
    flex-shrink: 0;
    padding: 3px 9px;
    font-size: 11.5px;
    font-weight: 500;
    background: transparent;
    border: 1px solid #2e3447;
    border-radius: 4px;
    color: #8a96b0;
    cursor: pointer;
    transition: border-color 0.12s, color 0.12s;
  }
  .hs-recent-open:hover {
    border-color: #37b573;
    color: #37b573;
  }
  .hs-empty-state {
    font-size: 12.5px;
    color: #4e5a72;
    padding: 10px 2px;
    line-height: 1.5;
  }
  #hs-build-stamp {
    font-size: 10px;
    color: #2e3a50;
    text-align: right;
    padding: 6px 2px 2px;
    letter-spacing: 0.02em;
  }

  /* ── PostFlowX Site card ── */
  #hs-site-card {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 18px 22px;
    background: #1f2533;
    border: 1px solid #2a3148;
    border-radius: 8px;
  }
  #hs-site-card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: #161d2b;
    border-radius: 7px;
    color: #37b573;
    flex-shrink: 0;
  }
  #hs-site-card-icon svg {
    width: 20px;
    height: 20px;
  }
  #hs-site-card-body {
    flex: 1;
    min-width: 0;
  }
  #hs-site-card-title {
    font-size: 13.5px;
    font-weight: 600;
    color: #e4ebff;
    margin: 0 0 2px;
  }
  #hs-site-card-desc {
    font-size: 11.5px;
    color: #606880;
    margin: 0 0 3px;
    line-height: 1.4;
  }
  #hs-site-card-url {
    font-size: 10.5px;
    color: #2e3a50;
    font-family: "SF Mono", "Fira Mono", monospace;
  }
  #hs-btn-open-site {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 15px;
    background: #1e2b23;
    border: 1px solid #37b573;
    border-radius: 6px;
    color: #37b573;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
    white-space: nowrap;
  }
  #hs-btn-open-site:hover {
    background: #223328;
    border-color: #4fcf89;
    color: #e4ebff;
  }
  #hs-btn-open-site:active {
    background: #1a2a1e;
  }
  #hs-btn-open-site svg {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
  }
</style>

<div id="hs-root">
<div id="hs-inner">

  <!-- Hero -->
  <div id="hs-hero">
    <h1>PostFlowX</h1>
    <p>Smart post workflow for VFX pull, QC, timeline, and delivery.</p>
    <span class="hs-version">v${version}</span>
  </div>

  <!-- Quick actions -->
  <div>
    <p class="hs-section-title">Quick Actions</p>
    <div id="hs-quick-actions">
      <button class="hs-btn" id="hs-btn-new-project">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        New Project
      </button>
      <button class="hs-btn" id="hs-btn-open-project">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        Open Project
      </button>
      <button class="hs-btn" id="hs-btn-import-timeline">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
        Import Timeline
      </button>
      <button class="hs-btn" id="hs-btn-open-vfx-pull">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 3"/></svg>
        Open VFX Pull Workspace
      </button>
      <button class="hs-btn" id="hs-btn-tl-convert">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="3.5" rx="1"/><line x1="2" y1="10.5" x2="13" y2="10.5"/><line x1="2" y1="15.5" x2="11" y2="15.5"/><polyline points="15,13 18.5,16.5 22,13"/><line x1="18.5" y1="16.5" x2="18.5" y2="8"/></svg>
        TL Convert
      </button>
    </div>
  </div>

  <!-- Workspaces -->
  <div>
    <p class="hs-section-title">Workspaces</p>
    <div id="hs-workspace-grid">
      ${workspaceCards}
    </div>
  </div>

  <!-- PostFlowX Site -->
  <div>
    <p class="hs-section-title">Resources</p>
    <div id="hs-site-card">
      <div id="hs-site-card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/>
          <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
        </svg>
      </div>
      <div id="hs-site-card-body">
        <p id="hs-site-card-title">PostFlowX Home</p>
        <p id="hs-site-card-desc">Official documentation, updates, guides, and release notes.</p>
        <span id="hs-site-card-url">sites.google.com/netflix.com/postflowx/home</span>
      </div>
      <button id="hs-btn-open-site">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/>
          <line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
        Open PostFlowX Site
      </button>
    </div>
  </div>

  <!-- Bottom: status + recents -->
  <div id="hs-bottom">

    <!-- System Status -->
    <div>
      <p class="hs-section-title">System Status</p>
      <div id="hs-status-list">
        <div class="hs-status-row">
          <span class="hs-status-dot idle" id="hs-dot-resolve"></span>
          <span class="hs-status-label">Resolve Engine</span>
          <span class="hs-status-value" id="hs-val-resolve">Checking…</span>
        </div>
        <div class="hs-status-row">
          <span class="hs-status-dot idle" id="hs-dot-media"></span>
          <span class="hs-status-label">Media Engine</span>
          <span class="hs-status-value" id="hs-val-media">Checking…</span>
        </div>
        <div class="hs-status-row">
          <span class="hs-status-dot ok" id="hs-dot-helper"></span>
          <span class="hs-status-label">Native Helper</span>
          <span class="hs-status-value ok" id="hs-val-helper">Built-in</span>
        </div>
        <div class="hs-status-row">
          <span class="hs-status-dot idle" id="hs-dot-cache"></span>
          <span class="hs-status-label">Cache</span>
          <span class="hs-status-value" id="hs-val-cache">—</span>
        </div>
      </div>
    </div>

    <!-- Recent Projects -->
    <div>
      <p class="hs-section-title">Recent Projects</p>
      <div id="hs-recents-list">
        <p class="hs-empty-state">Loading…</p>
      </div>
    </div>

  </div>

  <!-- Build stamp -->
  <div id="hs-build-stamp"></div>

</div>
</div>
  `.trim();
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _nav(tabKey, eventName) {
  if (tabKey && typeof window.setMainTab === 'function') {
    window.setMainTab(tabKey);
  }
  if (eventName) {
    window.dispatchEvent(new CustomEvent(eventName, { bubbles: true }));
  }
}

function _dispatchFromMain(type, detail = {}) {
  // In Electron: trigger the same buttons the project bar uses, so project state is wired correctly.
  // Fall back to dispatching a window event that the app's chrome.runtime.onMessage listeners can pick up.
  if (type === 'NEW_PROJECT') {
    const btn = document.getElementById('projNew');
    if (btn) { btn.click(); return; }
  }
  if (type === 'OPEN_PROJECT') {
    const btn = document.getElementById('projLoad');
    if (btn) { btn.click(); return; }
  }
  // Generic fallback: forward to chrome.runtime listeners via ipcRenderer path (Electron menu handler)
  try { window.__pfxChrome?.runtime?.sendMessage?.({ type, ...detail }); } catch(_) {}
}

function _fmtDate(val) {
  if (!val) return '';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val).slice(0, 10);
    return d.toISOString().slice(0, 10);
  } catch {
    return String(val).slice(0, 10);
  }
}

function _storageGet(keys) {
  return new Promise(resolve => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
      chrome.storage.local.get(keys, result => {
        void chrome.runtime?.lastError;
        resolve(result || {});
      });
    } else {
      resolve({});
    }
  });
}

// ── Status refresh ────────────────────────────────────────────────────────────
function _setStatusRow(dotId, valId, state, label) {
  const dot = document.getElementById(dotId);
  const val = document.getElementById(valId);
  if (!dot || !val) return;

  // Clear old state classes
  dot.className = `hs-status-dot ${state}`;
  val.className = `hs-status-value ${state}`;
  val.textContent = label;
}

async function _refreshStatus() {
  const isMac = window.pfxPlatform?.isMacApp === true;

  // ── Native helper ─────────────────────────────────────────────────────────
  if (isMac) {
    _setStatusRow('hs-dot-helper', 'hs-val-helper', 'ok', 'Built-in');
  } else {
    _setStatusRow('hs-dot-helper', 'hs-val-helper', 'idle', 'N/A (extension)');
  }

  // ── Resolve Engine ────────────────────────────────────────────────────────
  // First try reading the existing pill DOM element
  const pill = document.getElementById('pfxResolvePill');
  let resolveState = 'idle';
  let resolveLabel = 'Not connected';

  if (pill) {
    const pillText  = pill.textContent?.trim() || '';
    const pillClass = pill.className || '';
    if (pillClass.includes('connected') || pillClass.includes('ok') || pillText.toLowerCase().includes('connect')) {
      resolveState = 'ok';
      resolveLabel = 'Connected';
    } else if (pillClass.includes('warn') || pillText.toLowerCase().includes('warn')) {
      resolveState = 'warn';
      resolveLabel = pillText || 'Warning';
    } else if (pillClass.includes('error') || pillText.toLowerCase().includes('error')) {
      resolveState = 'error';
      resolveLabel = 'Error';
    } else if (pillText) {
      resolveLabel = pillText;
    }
    _setStatusRow('hs-dot-resolve', 'hs-val-resolve', resolveState, resolveLabel);
  } else {
    // Fall back to companion check
    _setStatusRow('hs-dot-resolve', 'hs-val-resolve', 'idle', 'Checking…');
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: 'COMPANION_CHECK' }, result => {
          void chrome.runtime?.lastError;
          if (result?.resolveConnected) {
            _setStatusRow('hs-dot-resolve', 'hs-val-resolve', 'ok', 'Connected');
          } else if (result?.ok) {
            _setStatusRow('hs-dot-resolve', 'hs-val-resolve', 'warn', 'Companion ready');
          } else {
            _setStatusRow('hs-dot-resolve', 'hs-val-resolve', 'idle', 'Not connected');
          }
        });
      } else {
        _setStatusRow('hs-dot-resolve', 'hs-val-resolve', 'idle', 'Not connected');
      }
    } catch {
      _setStatusRow('hs-dot-resolve', 'hs-val-resolve', 'idle', 'Not connected');
    }
  }

  // ── Media Engine ─────────────────────────────────────────────────────────
  if (window.pfxPlatform?.media?.diagnostics) {
    _setStatusRow('hs-dot-media', 'hs-val-media', 'idle', 'Checking…');
    try {
      const diag = await window.pfxPlatform.media.diagnostics();
      if (diag?.avfBridgeReady) {
        _setStatusRow('hs-dot-media', 'hs-val-media', 'ok', 'Ready');
      } else if (diag?.ffmpegAvailable) {
        _setStatusRow('hs-dot-media', 'hs-val-media', 'warn', 'FFmpeg only');
      } else {
        _setStatusRow('hs-dot-media', 'hs-val-media', 'warn', 'Limited');
      }
      // Cache path
      if (diag?.avfBridgePath) {
        const cachePath = diag.avfBridgePath.replace(/\/[^/]+$/, '') || diag.avfBridgePath;
        _setStatusRow('hs-dot-cache', 'hs-val-cache', 'ok', cachePath);
      } else {
        _setStatusRow('hs-dot-cache', 'hs-val-cache', 'idle', isMac ? '~/Library/Application Support/PostFlowX' : '—');
      }
    } catch {
      _setStatusRow('hs-dot-media', 'hs-val-media', 'error', 'Error');
    }
  } else if (isMac) {
    _setStatusRow('hs-dot-media', 'hs-val-media', 'idle', 'Unavailable');
    _setStatusRow('hs-dot-cache', 'hs-val-cache', 'idle', '~/Library/Application Support/PostFlowX');
  } else {
    _setStatusRow('hs-dot-media', 'hs-val-media', 'idle', 'N/A (extension)');
    _setStatusRow('hs-dot-cache', 'hs-val-cache', 'idle', '—');
  }
}

// ── Recent projects ───────────────────────────────────────────────────────────
function _esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function _refreshRecents() {
  const container = document.getElementById('hs-recents-list');
  if (!container) return;

  container.innerHTML = '<p class="hs-empty-state">Loading…</p>';

  let recents = [];
  try {
    const data = await _storageGet([STORAGE_KEY_RECENTS, STORAGE_KEY_CURRENT]);
    const raw = data[STORAGE_KEY_RECENTS];
    recents = Array.isArray(raw) ? raw : [];
  } catch {
    recents = [];
  }

  if (recents.length === 0) {
    container.innerHTML = `<p class="hs-empty-state">Start by creating a project or opening an existing project.</p>`;
    return;
  }

  const limited = recents.slice(0, MAX_RECENTS);
  const rows = limited.map((proj, idx) => {
    const name = proj.name || proj.projectName || `Project ${idx + 1}`;
    const date = _fmtDate(proj.lastOpened || proj.date || proj.updatedAt);
    const path = proj.path || proj.folderPath || '';
    const pathDisplay = path ? path.replace(/^.*\/([^/]+)$/, (_, tail) => `…/${tail}`) : '';

    return `
      <div class="hs-recent-row" data-recent-idx="${idx}" tabindex="0" role="button" aria-label="Open ${_esc(name)}">
        <div class="hs-recent-info">
          <span class="hs-recent-name" title="${_esc(name)}">${_esc(name)}</span>
          ${pathDisplay ? `<span class="hs-recent-meta" title="${_esc(path)}">${_esc(pathDisplay)}</span>` : ''}
        </div>
        ${date ? `<span class="hs-recent-date">${date}</span>` : ''}
        <button class="hs-recent-open" data-recent-idx="${idx}" tabindex="-1">Open</button>
      </div>
    `;
  });

  container.innerHTML = rows.join('');

  // Attach click handlers — store project data on element for handler lookup
  container.querySelectorAll('.hs-recent-row, .hs-recent-open').forEach(el => {
    const idx = parseInt(el.dataset.recentIdx, 10);
    const proj = limited[idx];
    const _openRecent = () => {
      // Navigate to Pull Prep first so the project bar scope is correct
      if (typeof window.setMainTab === 'function') window.setMainTab('prepmark');
      window.dispatchEvent(new CustomEvent('pfx:load-recent-project', {
        detail: { project: proj, index: idx },
        bubbles: true,
      }));
    };
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      _openRecent();
    });
    // Keyboard: Enter/Space on row
    if (el.classList.contains('hs-recent-row')) {
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          _openRecent();
        }
      });
    }
  });
}

// ── Click handlers ────────────────────────────────────────────────────────────
function _attachHandlers() {
  // Quick action buttons
  const btnNew = document.getElementById('hs-btn-new-project');
  if (btnNew) {
    btnNew.addEventListener('click', () => _dispatchFromMain('NEW_PROJECT'));
  }

  const btnOpen = document.getElementById('hs-btn-open-project');
  if (btnOpen) {
    btnOpen.addEventListener('click', () => _dispatchFromMain('OPEN_PROJECT'));
  }

  // Refresh the recents list whenever a project is created, saved, or deleted
  // Use named handlers so duplicate registrations can be avoided if _attachHandlers is called again.
  if (!_attachHandlers._recentsListening) {
    _attachHandlers._recentsListening = true;
    window.addEventListener('pfx:project-created', () => _refreshRecents().catch(() => {}));
    window.addEventListener('pfx:project-saved',   () => _refreshRecents().catch(() => {}));
    window.addEventListener('pfx:project-deleted', () => _refreshRecents().catch(() => {}));
  }

  const btnImport = document.getElementById('hs-btn-import-timeline');
  if (btnImport) {
    btnImport.addEventListener('click', () => _nav('prepmark', null));
  }

  const btnVfx = document.getElementById('hs-btn-open-vfx-pull');
  if (btnVfx) {
    btnVfx.addEventListener('click', () => _nav('prepmark', 'pfx:open-vfx-pull'));
  }

  const btnTlConvert = document.getElementById('hs-btn-tl-convert');
  if (btnTlConvert) {
    btnTlConvert.addEventListener('click', () =>
      window.dispatchEvent(new CustomEvent('pfx:open-tl-convert'))
    );
  }

  // PostFlowX Site button
  const btnSite = document.getElementById('hs-btn-open-site');
  if (btnSite) {
    const SITE_URL = 'https://sites.google.com/netflix.com/postflowx/home';
    btnSite.addEventListener('click', () => {
      if (window.pfxPlatform?.openExternalSafe) {
        window.pfxPlatform.openExternalSafe(SITE_URL).catch(err => {
          console.warn('[homeScreen] openExternalSafe failed:', err.message);
        });
      } else if (window.pfxPlatform?.openExternal) {
        window.pfxPlatform.openExternal(SITE_URL);
      } else {
        alert('PostFlowX Site opens in your browser.\n\n' + SITE_URL);
      }
    });
  }

  // Workspace cards
  const grid = document.getElementById('hs-workspace-grid');
  if (grid) {
    grid.addEventListener('click', (e) => {
      const card = e.target.closest('.hs-card[data-ws-id]');
      if (!card) return;
      const wsId = card.dataset.wsId;
      const ws = WORKSPACES.find(w => w.id === wsId);
      if (ws) _nav(ws.tabKey, ws.event);
    });
    // Keyboard navigation on cards
    grid.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const card = e.target.closest('.hs-card[data-ws-id]');
      if (!card) return;
      e.preventDefault();
      const ws = WORKSPACES.find(w => w.id === card.dataset.wsId);
      if (ws) _nav(ws.tabKey, ws.event);
    });
    // Make cards keyboard-focusable
    grid.querySelectorAll('.hs-card').forEach(c => {
      if (!c.getAttribute('tabindex')) c.setAttribute('tabindex', '0');
    });
  }
}

// ── Build stamp ───────────────────────────────────────────────────────────────

function _renderBuildStamp() {
  const el = document.getElementById('hs-build-stamp');
  if (!el) return;
  const target  = window.__PFX_TARGET__        || (window.pfxPlatform?.isMacApp ? 'desktop' : 'extension');
  const builtAt = window.__PFX_BUILD_TIME__    || '—';
  const ver     = window.__PFX_BUILD_VERSION__ || window.chrome?.runtime?.getManifest?.()?.version || '—';
  const label   = target === 'desktop' ? 'Desktop' : 'Extension';
  el.textContent = `Build Target: ${label}  ·  v${ver}  ·  ${builtAt}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * initHomeScreen()
 * Renders the home screen HTML into #main-home, wires up handlers,
 * and calls onHomeScreenActivated() for the initial data load.
 */
function initHomeScreen() {
  const root = document.getElementById('main-home');
  if (!root) {
    console.warn('[homeScreen] #main-home not found — cannot mount home screen');
    return;
  }

  // Resolve app version
  let version = '—';
  try {
    version = chrome?.runtime?.getManifest?.()?.version ?? '—';
  } catch {
    version = '—';
  }

  root.innerHTML = _buildHTML(version);
  _attachHandlers();
  _renderBuildStamp();
  onHomeScreenActivated();
}

/**
 * onHomeScreenActivated()
 * Refreshes status chips and recent projects list.
 * Safe to call multiple times (idempotent).
 */
function onHomeScreenActivated() {
  _refreshStatus().catch(err => {
    console.warn('[homeScreen] status refresh error', err);
  });
  _refreshRecents().catch(err => {
    console.warn('[homeScreen] recents refresh error', err);
  });
}

export { initHomeScreen, onHomeScreenActivated };
