// scripts/features/home/homeScreen.js
// PostFlowX Entry / Home Screen — Electron macOS desktop app
// ES2022 module, no build step required.
// ─────────────────────────────────────────────────────────────────────────────

import { initOnboarding, openSetupGuide } from "./setupWizard.js";
import { initAppTour, startTour } from "./appTour.js";

// ── Constants ─────────────────────────────────────────────────────────────────
const STORAGE_KEY_RECENTS = 'recentProjects:pull_prep';
const STORAGE_KEY_CURRENT = 'currentProjectName:pull_prep';
const MAX_RECENTS = 8;

// One-time guard for the live Resolve-status subscription (see onHomeScreenActivated).
let _hsResolveSub = false;
let _heroRecentProject = null;

// ── Workspace definitions ─────────────────────────────────────────────────────
const WORKSPACES = [
  {
    id:       'pull-prep',
    title:    'Pull Prep',
    subtitle: 'Build VFX pull packages from EDL/timeline',
    tag:      'VFX EDITOR',
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
    tag:      'OCF',
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
    tag:      'COMPARE',
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
    tag:      'DELIVERY',
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
    tag:      'OUTPUT',
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
    tag:      'SYSTEM',
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
      <span class="hs-card-top">
        <span class="hs-card-icon">${ws.icon}</span>
        <span class="hs-card-tag">${ws.tag}</span>
      </span>
      <span class="hs-card-title">${ws.title}</span>
      <span class="hs-card-sub">${ws.subtitle}</span>
      <span class="hs-card-open">Open workspace <span aria-hidden="true">&#8594;</span></span>
    </button>
  `).join('');

  return `
<style>
  #hs-root {
    height: 100%;
    overflow-y: auto;
    background: #000;
    color: #f5f5f1;
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
    color: #f5f5f1;
  }
  #hs-hero p {
    margin: 0;
    font-size: 13.5px;
    color: #b3b3b3;
  }
  #hs-hero .hs-version {
    margin-top: 4px;
    font-size: 11.5px;
    color: #737373;
    letter-spacing: 0.3px;
  }

  /* ── Section headers ── */
  .hs-section-title {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.9px;
    text-transform: uppercase;
    color: #737373;
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
    background: #181818;
    border: 1px solid rgba(255,255,255,.2);
    border-radius: 6px;
    color: #b3b3b3;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s, color 0.15s;
    white-space: nowrap;
  }
  .hs-btn:hover {
    border-color: #e50914;
    background: #2a1113;
    color: #f5f5f1;
  }
  .hs-btn:active {
    background: #220b0d;
  }
  .hs-btn svg {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: #f6121d;
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
    background: #141414;
    border: 1px solid rgba(255,255,255,.11);
    border-radius: 8px;
    cursor: pointer;
    text-align: left;
    color: inherit;
    transition: border-color 0.15s, box-shadow 0.15s, background 0.15s;
  }
  .hs-card:hover {
    border-color: #e50914;
    background: #211113;
    box-shadow: 0 0 0 1px rgba(229,9,20,.22), 0 4px 16px #00000055;
  }
  .hs-card:active {
    background: #220b0d;
  }
  .hs-card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    background: #181818;
    border-radius: 6px;
    color: #f6121d;
    margin-bottom: 2px;
  }
  .hs-card-icon svg {
    width: 18px;
    height: 18px;
  }
  .hs-card-title {
    font-size: 13.5px;
    font-weight: 600;
    color: #f5f5f1;
    line-height: 1.2;
  }
  .hs-card-sub {
    font-size: 11.5px;
    color: #737373;
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
  .hs-status-dot.ok     { background: #46d38f; }
  .hs-status-dot.warn   { background: #e2b656; }
  .hs-status-dot.error  { background: #ef6b72; }
  .hs-status-dot.idle   { background: #4e5a72; }
  .hs-status-label {
    color: #b3b3b3;
    min-width: 120px;
    flex-shrink: 0;
  }
  .hs-status-value {
    color: #f5f5f1;
    font-variant-numeric: tabular-nums;
  }
  .hs-status-value.ok    { color: #46d38f; }
  .hs-status-value.warn  { color: #e2b656; }
  .hs-status-value.error { color: #ef6b72; }

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
    background: #232323;
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
    color: #f5f5f1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hs-recent-meta {
    font-size: 11px;
    color: #737373;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hs-recent-date {
    font-size: 11px;
    color: #737373;
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
    color: #b3b3b3;
    cursor: pointer;
    transition: border-color 0.12s, color 0.12s;
  }
  .hs-recent-open:hover {
    border-color: #e50914;
    color: #f6121d;
  }
  .hs-empty-state {
    font-size: 12.5px;
    color: #737373;
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
    background: #141414;
    border: 1px solid rgba(255,255,255,.11);
    border-radius: 8px;
  }
  #hs-site-card-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    background: #211113;
    border-radius: 7px;
    color: #f6121d;
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
    color: #f5f5f1;
    margin: 0 0 2px;
  }
  #hs-site-card-desc {
    font-size: 11.5px;
    color: #737373;
    margin: 0 0 3px;
    line-height: 1.4;
  }
  #hs-site-card-url {
    font-size: 10.5px;
    color: #667482;
    font-family: "SF Mono", "Fira Mono", monospace;
  }
  #hs-btn-open-site {
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 15px;
    background: rgba(229,9,20,.14);
    border: 1px solid rgba(246,18,29,.5);
    border-radius: 6px;
    color: #ff8b91;
    font-size: 12.5px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
    white-space: nowrap;
  }
  #hs-btn-open-site:hover {
    background: #321013;
    border-color: #f6121d;
    color: #f5f5f1;
  }
  #hs-btn-open-site:active {
    background: #220b0d;
  }
  #hs-btn-open-site svg {
    width: 13px;
    height: 13px;
    flex-shrink: 0;
  }
  /* Netflix interaction accent must win older global icon-theme rules. */
  #hs-root .hs-btn svg,
  #hs-root .hs-card-icon,
  #hs-root #hs-site-card-icon {
    color: #f6121d !important;
  }
  #hs-root .hs-card-icon,
  #hs-root #hs-site-card-icon {
    background: #211113 !important;
  }

  /* ── Home 3.0 · Netflix command center ─────────────────────────────── */
  #hs-root {
    --hs-red: #e50914;
    --hs-red-bright: #ff2533;
    --hs-panel: rgba(20,20,20,.92);
    --hs-panel-2: rgba(28,28,28,.9);
    --hs-stroke: rgba(255,255,255,.11);
    --hs-muted: #9b9b9b;
    background:
      radial-gradient(circle at 86% 3%, rgba(229,9,20,.16), transparent 28%),
      radial-gradient(circle at 10% 82%, rgba(86,34,39,.10), transparent 32%),
      #080808;
  }
  #hs-inner {
    max-width: 1240px;
    padding: 28px 36px 42px;
    gap: 22px;
  }
  .hs-section-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 10px;
  }
  .hs-section-head .hs-section-title { margin: 0; }
  .hs-section-hint {
    color: #666;
    font-size: 10.5px;
  }

  /* Hero: one strong starting point, with a visual workflow map. */
  #hs-hero {
    position: relative;
    min-height: 208px;
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(310px, .65fr);
    align-items: stretch;
    gap: 26px;
    padding: 28px 30px;
    overflow: hidden;
    border: 1px solid rgba(255,255,255,.12);
    border-radius: 14px;
    background:
      linear-gradient(112deg, rgba(34,8,10,.96) 0%, rgba(18,18,18,.98) 48%, rgba(11,11,11,.98) 100%);
    box-shadow: 0 18px 55px rgba(0,0,0,.32);
  }
  #hs-hero::before {
    content: "";
    position: absolute;
    inset: 0;
    pointer-events: none;
    background:
      linear-gradient(90deg, rgba(229,9,20,.72) 0 3px, transparent 3px),
      radial-gradient(circle at 20% 10%, rgba(229,9,20,.14), transparent 42%);
  }
  #hs-hero-copy {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    min-width: 0;
  }
  .hs-eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    margin-bottom: 10px;
    color: #ff7078;
    font-size: 9.5px;
    font-weight: 800;
    letter-spacing: 1.55px;
    text-transform: uppercase;
  }
  .hs-eyebrow::before {
    content: "";
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--hs-red-bright);
    box-shadow: 0 0 14px rgba(229,9,20,.65);
  }
  #hs-hero h1 {
    max-width: 650px;
    font-size: clamp(27px, 3vw, 42px);
    line-height: 1.05;
    letter-spacing: -1.2px;
    font-weight: 760;
  }
  #hs-hero p {
    max-width: 630px;
    margin-top: 10px;
    color: #b8b8b8;
    font-size: 13.5px;
    line-height: 1.5;
  }
  #hs-hero .hs-version {
    position: absolute;
    top: 0;
    right: 0;
    margin: 0;
    color: #6d6d6d;
    font-size: 9.5px;
  }
  #hs-hero-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 18px;
  }
  .hs-hero-btn {
    min-height: 36px;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 16px;
    border: 1px solid rgba(255,255,255,.18);
    border-radius: 6px;
    color: #f5f5f1;
    background: rgba(255,255,255,.08);
    font-size: 12.5px;
    font-weight: 680;
    cursor: pointer;
    transition: transform .16s ease, background .16s ease, border-color .16s ease;
  }
  .hs-hero-btn svg { width: 16px; height: 16px; }
  .hs-hero-btn:hover { transform: translateY(-1px); border-color: rgba(255,255,255,.35); background: rgba(255,255,255,.13); }
  #hs-root #hs-btn-new-project {
    color: #fff;
    background: linear-gradient(135deg, #ff2533, var(--hs-red)) !important;
    background-color: var(--hs-red) !important;
    background-image: linear-gradient(135deg, #ff2533, var(--hs-red)) !important;
    border-color: #ff3440 !important;
    box-shadow: 0 8px 24px rgba(229,9,20,.22);
  }
  #hs-root #hs-btn-new-project svg { color: #fff !important; stroke: currentColor !important; }
  #hs-root #hs-btn-new-project:hover {
    background: linear-gradient(135deg, #ff4350, #f20d19) !important;
    background-color: #f20d19 !important;
    background-image: linear-gradient(135deg, #ff4350, #f20d19) !important;
    border-color: #ff6570 !important;
    box-shadow: 0 10px 30px rgba(229,9,20,.34);
  }
  #hs-btn-import-timeline {
    border-color: rgba(92,139,255,.32);
    background: linear-gradient(135deg, rgba(53,91,180,.20), rgba(255,255,255,.06));
  }
  #hs-btn-import-timeline svg { color: #7da2ff !important; }

  #hs-flow-visual {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 10px;
    padding: 18px;
    border: 1px solid rgba(255,255,255,.09);
    border-radius: 11px;
    background: rgba(0,0,0,.23);
  }
  .hs-flow-title {
    color: #737373;
    font-size: 9px;
    font-weight: 800;
    letter-spacing: 1.25px;
    text-transform: uppercase;
  }
  .hs-flow-row { display: flex; align-items: center; gap: 8px; }
  .hs-flow-step {
    flex: 1;
    min-width: 0;
    padding: 10px;
    border: 1px solid rgba(255,255,255,.09);
    border-radius: 7px;
    background: rgba(255,255,255,.035);
  }
  .hs-flow-step strong {
    display: block;
    color: #f5f5f1;
    font-size: 11.5px;
    line-height: 1.2;
  }
  .hs-flow-step small { display: block; margin-top: 3px; color: #686868; font-size: 9.5px; }
  .hs-flow-step.is-active { border-color: rgba(229,9,20,.55); background: rgba(229,9,20,.1); }
  .hs-flow-num {
    display: inline-grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-bottom: 7px;
    border-radius: 50%;
    color: #fff;
    background: #343434;
    font-size: 9px;
    font-weight: 800;
  }
  .hs-flow-step.is-active .hs-flow-num { background: var(--hs-red); }
  .hs-flow-step:nth-of-type(2) {
    border-color: rgba(35,194,255,.18);
    background: linear-gradient(145deg, rgba(35,194,255,.07), rgba(255,255,255,.025));
  }
  .hs-flow-step:nth-of-type(2) .hs-flow-num { background: #167da8; }
  .hs-flow-step:nth-of-type(3) {
    border-color: rgba(70,211,143,.18);
    background: linear-gradient(145deg, rgba(70,211,143,.07), rgba(255,255,255,.025));
  }
  .hs-flow-step:nth-of-type(3) .hs-flow-num { background: #168456; }
  .hs-flow-arrow { color: #414141; font-size: 12px; }
  .hs-flow-foot {
    display: flex;
    align-items: center;
    gap: 7px;
    color: #777;
    font-size: 10px;
  }
  .hs-flow-foot::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: #46d38f; }

  /* Secondary actions stay available without competing with the main CTA. */
  #hs-quick-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border: 1px solid var(--hs-stroke);
    border-radius: 9px;
    background: rgba(17,17,17,.78);
  }
  #hs-quick-bar .hs-section-title {
    flex: 0 0 auto;
    margin: 0 4px 0 2px;
    color: #868686;
  }
  #hs-quick-actions { flex: 1; flex-wrap: nowrap; gap: 4px; min-width: 0; }
  .hs-btn {
    min-height: 30px;
    padding: 0 10px;
    border-color: transparent;
    background: transparent;
    color: #a7a7a7;
    font-size: 11.5px;
  }
  .hs-btn:hover { border-color: rgba(229,9,20,.55); background: rgba(229,9,20,.10); color: #fff; }
  .hs-btn svg { width: 17px; height: 17px; }
  #hs-root #hs-btn-open-project svg { color: #ff4150 !important; stroke: #ff4150 !important; }
  #hs-root #hs-btn-open-vfx-pull svg { color: #31c9ff !important; stroke: #31c9ff !important; }
  #hs-root #hs-btn-tl-convert svg { color: #f7aa35 !important; stroke: #f7aa35 !important; }
  #hs-root #hs-btn-setup-guide svg { color: #b784ff !important; stroke: #b784ff !important; }
  #hs-root #hs-btn-tour svg { color: #50d89a !important; stroke: #50d89a !important; }
  #hs-btn-open-project:hover { border-color: rgba(255,65,80,.42); background: rgba(255,65,80,.09); }
  #hs-btn-open-vfx-pull:hover { border-color: rgba(49,201,255,.42); background: rgba(49,201,255,.09); }
  #hs-btn-tl-convert:hover { border-color: rgba(247,170,53,.42); background: rgba(247,170,53,.09); }
  #hs-btn-setup-guide:hover { border-color: rgba(183,132,255,.42); background: rgba(183,132,255,.09); }
  #hs-btn-tour:hover { border-color: rgba(80,216,154,.42); background: rgba(80,216,154,.09); }

  /* Workspace cards carry purpose, category and an explicit action. */
  #hs-workspace-grid { grid-template-columns: repeat(3, minmax(0,1fr)); gap: 9px; }
  .hs-card {
    --card-accent: #e50914;
    --card-rgb: 229,9,20;
    position: relative;
    min-height: 148px;
    gap: 5px;
    padding: 15px 16px 13px;
    overflow: hidden;
    background:
      linear-gradient(145deg, rgba(var(--card-rgb),.085), transparent 46%),
      linear-gradient(145deg, rgba(28,28,28,.96), rgba(17,17,17,.96));
    border-color: rgba(255,255,255,.10);
    border-radius: 9px;
    transition: transform .16s ease, border-color .16s ease, background .16s ease, box-shadow .16s ease;
  }
  .hs-card::before {
    content: "";
    position: absolute;
    inset: 0 0 auto;
    height: 2px;
    opacity: .72;
    background: linear-gradient(90deg, var(--card-accent), rgba(var(--card-rgb),.08) 72%, transparent);
  }
  .hs-card::after {
    content: "";
    position: absolute;
    inset: auto -26px -40px auto;
    width: 95px;
    height: 95px;
    border-radius: 50%;
    background: rgba(var(--card-rgb),.10);
    transition: transform .2s ease, background .2s ease;
  }
  .hs-card:hover {
    transform: translateY(-2px);
    border-color: var(--card-accent);
    background:
      linear-gradient(145deg, rgba(var(--card-rgb),.15), transparent 58%),
      linear-gradient(145deg, rgba(31,31,31,.98), rgba(18,18,18,.98));
    box-shadow: 0 10px 28px rgba(0,0,0,.30), 0 0 24px rgba(var(--card-rgb),.08);
  }
  .hs-card:hover::after { transform: scale(1.18); background: rgba(var(--card-rgb),.18); }
  .hs-card-top { width: 100%; display: flex; align-items: center; justify-content: space-between; margin-bottom: 3px; }
  .hs-card-icon {
    position: relative;
    width: 52px;
    height: 52px;
    margin: 0;
    overflow: hidden;
    border: 1px solid rgba(var(--card-rgb),.24);
    border-radius: 12px;
    color: var(--card-accent) !important;
    background: rgba(var(--card-rgb),.13) !important;
    box-shadow:
      inset 0 0 18px rgba(var(--card-rgb),.08),
      0 0 0 1px rgba(0,0,0,.28);
    transition: transform .2s ease, border-color .2s ease, box-shadow .2s ease, background .2s ease;
  }
  .hs-card-icon::after {
    content: "";
    position: absolute;
    inset: -35%;
    pointer-events: none;
    opacity: 0;
    background: linear-gradient(105deg, transparent 35%, rgba(255,255,255,.34) 50%, transparent 65%);
    transform: translateX(-120%) rotate(8deg);
  }
  .hs-card .hs-card-icon svg {
    position: relative;
    z-index: 1;
    width: 28px;
    height: 28px;
    color: var(--card-accent) !important;
    stroke: currentColor;
    filter: drop-shadow(0 0 5px rgba(var(--card-rgb),.24));
    transition: transform .2s ease, filter .2s ease;
  }
  .hs-card:hover .hs-card-icon,
  .hs-card:focus-visible .hs-card-icon {
    transform: translateY(-2px) scale(1.07);
    border-color: rgba(var(--card-rgb),.72);
    background: rgba(var(--card-rgb),.20) !important;
    box-shadow:
      inset 0 0 22px rgba(var(--card-rgb),.15),
      0 7px 18px rgba(var(--card-rgb),.18),
      0 0 0 1px rgba(var(--card-rgb),.14);
  }
  .hs-card:hover .hs-card-icon svg,
  .hs-card:focus-visible .hs-card-icon svg {
    transform: scale(1.08);
    filter: drop-shadow(0 0 8px rgba(var(--card-rgb),.52));
  }
  .hs-card:hover .hs-card-icon::after,
  .hs-card:focus-visible .hs-card-icon::after {
    animation: hs-icon-sweep .55s ease-out both;
  }
  @keyframes hs-icon-sweep {
    0% { opacity: 0; transform: translateX(-120%) rotate(8deg); }
    24% { opacity: .65; }
    100% { opacity: 0; transform: translateX(120%) rotate(8deg); }
  }
  .hs-card-tag {
    color: var(--card-accent);
    font-size: 8.5px;
    font-weight: 800;
    letter-spacing: 1px;
  }
  .hs-card-title { font-size: 14px; }
  .hs-card-sub { max-width: 86%; color: #818181; font-size: 10.7px; line-height: 1.35; }
  .hs-card-open {
    z-index: 1;
    margin-top: auto;
    color: #858585;
    font-size: 9.8px;
    font-weight: 650;
    opacity: .76;
  }
  .hs-card:hover .hs-card-open { color: var(--card-accent); opacity: 1; }

  /* Colour is functional: each workspace keeps one accent everywhere. */
  .hs-card[data-ws-id="pull-prep"]   { --card-accent: #ff3f5f; --card-rgb: 255,63,95; }
  .hs-card[data-ws-id="vfx-pull"]    { --card-accent: #32c9ff; --card-rgb: 50,201,255; }
  .hs-card[data-ws-id="cut-diff"]    { --card-accent: #ffb23e; --card-rgb: 255,178,62; }
  .hs-card[data-ws-id="imf"]         { --card-accent: #b987ff; --card-rgb: 185,135,255; }
  .hs-card[data-ws-id="render-queue"]{ --card-accent: #4edb96; --card-rgb: 78,219,150; }
  .hs-card[data-ws-id="settings"]    { --card-accent: #75a5ff; --card-rgb: 117,165,255; }

  /* Continue + health are the operational bottom of the dashboard. */
  #hs-bottom {
    grid-template-columns: minmax(0, 1.45fr) minmax(330px, .55fr);
    gap: 10px;
  }
  .hs-ops-card {
    min-height: 132px;
    padding: 15px 17px;
    border: 1px solid var(--hs-stroke);
    border-radius: 9px;
    background: rgba(18,18,18,.86);
  }
  .hs-ops-card .hs-section-title { margin-bottom: 10px; }
  #hs-recents-list { max-height: 104px; }
  .hs-recent-row { padding: 6px 7px; }
  .hs-empty-state { margin: 0; padding: 8px 1px; }
  .hs-empty-state a { color: #ff777f; text-decoration: none; }
  #hs-system-resource { display: grid; grid-template-columns: 1fr; gap: 8px; }
  #hs-hero > #hs-system-resource {
    position: relative;
    z-index: 1;
    align-self: stretch;
    min-height: 0;
  }
  #hs-bottom > #hs-flow-visual {
    min-height: 132px;
  }
  #hs-status-list { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px; }
  .hs-status-row { gap: 7px; font-size: 11px; min-width: 0; }
  .hs-status-label { min-width: 0; color: #777; }
  .hs-status-value { margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #hs-site-card {
    gap: 11px;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(24,24,24,.82);
  }
  #hs-site-card-icon { width: 30px; height: 30px; border-radius: 6px; }
  #hs-site-card-icon svg { width: 16px; height: 16px; }
  #hs-site-card-title { font-size: 11.5px; }
  #hs-site-card-desc { margin: 0; font-size: 9.7px; }
  #hs-site-card-url { display: none; }
  #hs-btn-open-site { min-height: 28px; padding: 0 10px; font-size: 10.5px; }
  #hs-build-stamp { color: #383838; padding-top: 0; }

  @media (max-width: 900px) {
    #hs-inner { padding: 22px 24px 34px; }
    #hs-hero { grid-template-columns: 1fr; }
    #hs-quick-actions { flex-wrap: wrap; }
    #hs-workspace-grid { grid-template-columns: repeat(2, minmax(0,1fr)); }
    #hs-bottom { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) {
    .hs-card, .hs-card::after, .hs-hero-btn { transition: none; }
    .hs-card-icon, .hs-card-icon::after, .hs-card-icon svg {
      transition: none !important;
      animation: none !important;
    }
  }
</style>

<div id="hs-root">
<div id="hs-inner">

  <!-- Hero -->
  <div id="hs-hero">
    <div id="hs-hero-copy">
      <span class="hs-eyebrow">PostFlowX command center</span>
      <h1>From locked cut to final delivery, in one flow.</h1>
      <p>Prepare VFX pulls, compare editorial changes, review source media, and deliver with confidence.</p>
      <span class="hs-version">v${version}</span>
      <div id="hs-hero-actions">
        <button class="hs-hero-btn hs-hero-btn-primary" id="hs-btn-new-project">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          <span id="hs-primary-action-label">Start a project</span>
        </button>
        <button class="hs-hero-btn" id="hs-btn-import-timeline">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
          Import a timeline
        </button>
      </div>
    </div>
    <div id="hs-system-resource" class="hs-ops-card">
      <div class="hs-section-head">
        <p class="hs-section-title">System health</p>
        <button id="hs-status-fix" type="button" hidden
          style="background:none;border:1px solid var(--pfx-accent,#2172E3);color:var(--pfx-accent,#2172E3);border-radius:100px;font-size:11px;font-weight:600;padding:2px 10px;cursor:pointer;">Fix issues</button>
      </div>
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

      <div id="hs-site-card">
        <div id="hs-site-card-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
          </svg>
        </div>
        <div id="hs-site-card-body">
          <p id="hs-site-card-title">Guides &amp; release notes</p>
          <p id="hs-site-card-desc">Open the official PostFlowX site.</p>
          <span id="hs-site-card-url">sites.google.com/netflix.com/postflowx/home</span>
        </div>
        <button id="hs-btn-open-site">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>
          Open site
        </button>
      </div>
    </div>
  </div>

  <!-- Secondary quick actions -->
  <div id="hs-quick-bar">
    <p class="hs-section-title">Quick tools</p>
    <div id="hs-quick-actions">
      <button class="hs-btn" id="hs-btn-new-project-secondary" hidden>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
        New Project
      </button>
      <button class="hs-btn" id="hs-btn-open-project">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        Open Project
      </button>
      <button class="hs-btn" id="hs-btn-open-vfx-pull">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4l3 3"/></svg>
        VFX Pull
      </button>
      <button class="hs-btn" id="hs-btn-tl-convert">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="3.5" rx="1"/><line x1="2" y1="10.5" x2="13" y2="10.5"/><line x1="2" y1="15.5" x2="11" y2="15.5"/><polyline points="15,13 18.5,16.5 22,13"/><line x1="18.5" y1="16.5" x2="18.5" y2="8"/></svg>
        TL Convert
      </button>
      <button class="hs-btn" id="hs-btn-setup-guide">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        Setup Guide
      </button>
      <button class="hs-btn" id="hs-btn-tour">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" stroke="none"/></svg>
        How to Use
      </button>
    </div>
  </div>

  <!-- Workspaces -->
  <div>
    <div class="hs-section-head">
      <p class="hs-section-title">Choose a workspace</p>
      <span class="hs-section-hint">Purpose-built tools for each stage of post</span>
    </div>
    <div id="hs-workspace-grid">
      ${workspaceCards}
    </div>
  </div>

  <!-- Bottom: continue working + workflow -->
  <div id="hs-bottom">

    <!-- Recent Projects -->
    <div class="hs-ops-card">
      <div class="hs-section-head">
        <p class="hs-section-title">Continue working</p>
        <span class="hs-section-hint">Recent projects</span>
      </div>
      <div id="hs-recents-list">
        <p class="hs-empty-state">Loading…</p>
      </div>
    </div>

    <!-- Workflow overview -->
    <div id="hs-flow-visual" class="hs-ops-card" aria-label="PostFlowX workflow: import, review, deliver">
      <span class="hs-flow-title">Your workflow</span>
      <div class="hs-flow-row">
        <div class="hs-flow-step is-active"><span class="hs-flow-num">1</span><strong>Import</strong><small>EDL · XML · OTIO</small></div>
        <span class="hs-flow-arrow" aria-hidden="true">&#8594;</span>
        <div class="hs-flow-step"><span class="hs-flow-num">2</span><strong>Review</strong><small>Picture · OCF · QC</small></div>
        <span class="hs-flow-arrow" aria-hidden="true">&#8594;</span>
        <div class="hs-flow-step"><span class="hs-flow-num">3</span><strong>Deliver</strong><small>Pulls · Reports · IMF</small></div>
      </div>
      <span class="hs-flow-foot">Native macOS media workflow ready</span>
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
function _setStatusRow(dotId, valId, state, label, title) {
  const dot = document.getElementById(dotId);
  const val = document.getElementById(valId);
  if (!dot || !val) return;

  // Clear old state classes
  dot.className = `hs-status-dot ${state}`;
  val.className = `hs-status-value ${state}`;
  val.textContent = label;
  if (title) { val.title = title; } else { val.removeAttribute('title'); }
  _updateFixButton();
}

// Show a "Fix issues" affordance whenever a real dependency error is present.
// Optional/idle states (e.g. Resolve not connected) don't count as broken.
function _updateFixButton() {
  const btn = document.getElementById('hs-status-fix');
  if (!btn) return;
  const list = document.getElementById('hs-status-list');
  const hasError = !!list?.querySelector('.hs-status-dot.error');
  btn.hidden = !hasError;
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
  // Prefer the authoritative status object; the pill DOM / companion check are
  // only fallbacks for when it has not been published yet.
  const rs = (typeof window !== 'undefined' && window.PFX_RESOLVE_STATUS) || null;
  if (rs && rs.state) {
    const map = {
      connected: ['ok',       'Connected'],
      checking:  ['checking', 'Checking…'],
      error:     ['error',    rs.label || 'Error'],
      warn:      ['warn',     rs.label || 'Warning'],
      idle:      ['idle',     rs.label || 'Not connected'],
    };
    const [st, lbl] = map[rs.state] || ['idle', rs.label || 'Not connected'];
    _setStatusRow('hs-dot-resolve', 'hs-val-resolve', st, lbl);
  } else {
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
  }

  // ── Media Engine ─────────────────────────────────────────────────────────
  if (window.pfxPlatform?.media?.diagnostics) {
    _setStatusRow('hs-dot-media', 'hs-val-media', 'idle', 'Checking…');
    try {
      const diag = await window.pfxPlatform.media.diagnostics();
      if (diag?.avfBridgeReady) {
        _setStatusRow('hs-dot-media', 'hs-val-media', 'ok', 'Ready — full quality');
      } else if (diag?.ffmpegAvailable) {
        _setStatusRow('hs-dot-media', 'hs-val-media', 'warn', 'Working (basic)', 'Full-quality decoding needs the helper — run the installer from Settings › Resolve Engine.');
      } else {
        _setStatusRow('hs-dot-media', 'hs-val-media', 'error', 'Needs setup', 'Run the installer from Settings › Resolve Engine to enable media decoding.');
      }
      // Cache path — show a plain label; keep the raw path as a hover tooltip.
      if (diag?.avfBridgePath) {
        const cachePath = diag.avfBridgePath.replace(/\/[^/]+$/, '') || diag.avfBridgePath;
        _setStatusRow('hs-dot-cache', 'hs-val-cache', 'ok', 'Ready', cachePath);
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

function _recentName(project, idx = 0) {
  if (typeof project === 'string') return project.trim() || `Project ${idx + 1}`;
  return String(project?.name || project?.projectName || `Project ${idx + 1}`);
}

function _setHeroProjectAction(project = null) {
  _heroRecentProject = project || null;
  const primary = document.getElementById('hs-btn-new-project');
  const label = document.getElementById('hs-primary-action-label');
  const newProject = document.getElementById('hs-btn-new-project-secondary');
  if (!primary || !label) return;

  if (!_heroRecentProject) {
    primary.dataset.action = 'new';
    primary.removeAttribute('title');
    primary.setAttribute('aria-label', 'Start a new project');
    label.textContent = 'Start a project';
    if (newProject) newProject.hidden = true;
    return;
  }

  const name = _recentName(_heroRecentProject);
  primary.dataset.action = 'continue';
  primary.title = `Continue ${name}`;
  primary.setAttribute('aria-label', `Continue ${name}`);
  label.textContent = `Continue ${name.length > 30 ? `${name.slice(0, 27)}…` : name}`;
  if (newProject) newProject.hidden = false;
}

function _openHeroProject() {
  if (!_heroRecentProject) {
    _dispatchFromMain('NEW_PROJECT');
    return;
  }
  if (typeof window.setMainTab === 'function') window.setMainTab('prepmark');
  window.dispatchEvent(new CustomEvent('pfx:load-recent-project', {
    detail: { project: _heroRecentProject, index: 0 },
    bubbles: true,
  }));
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
    _setHeroProjectAction(null);
    container.innerHTML = `<p class="hs-empty-state">No projects yet. Click <b>New Project</b> above to start — or open the <a href="#" id="hs-empty-setup-link">Setup Guide</a> for a quick walkthrough.</p>`;
    const link = container.querySelector('#hs-empty-setup-link');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); openSetupGuide(); });
    return;
  }

  const limited = recents.slice(0, MAX_RECENTS);
  _setHeroProjectAction(limited[0]);
  const rows = limited.map((proj, idx) => {
    const name = _recentName(proj, idx);
    const date = typeof proj === 'object' && proj
      ? _fmtDate(proj.lastOpened || proj.date || proj.updatedAt)
      : '';
    const path = typeof proj === 'object' && proj ? (proj.path || proj.folderPath || '') : '';
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
    btnNew.addEventListener('click', () => _openHeroProject());
  }

  const btnNewSecondary = document.getElementById('hs-btn-new-project-secondary');
  if (btnNewSecondary) {
    btnNewSecondary.addEventListener('click', () => _dispatchFromMain('NEW_PROJECT'));
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

  const btnSetupGuide = document.getElementById('hs-btn-setup-guide');
  if (btnSetupGuide) {
    btnSetupGuide.addEventListener('click', () => openSetupGuide());
  }

  const btnStatusFix = document.getElementById('hs-status-fix');
  if (btnStatusFix) {
    btnStatusFix.addEventListener('click', () => openSetupGuide());
  }

  const btnTour = document.getElementById('hs-btn-tour');
  if (btnTour) {
    btnTour.addEventListener('click', () => startTour());
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

  // Onboarding: the interactive tour is the first-run experience; the Setup Guide
  // is available on demand (its button + the tour's final CTA open it).
  try { initOnboarding(); } catch (e) { console.warn('[homeScreen] onboarding init failed', e); }
  try { initAppTour(); } catch (e) { console.warn('[homeScreen] app tour init failed', e); }
}

/**
 * onHomeScreenActivated()
 * Refreshes status chips and recent projects list.
 * Safe to call multiple times (idempotent).
 */
function onHomeScreenActivated() {
  // Live-update the Resolve row when status changes while Home is visible.
  // Bind once for the lifetime of the module.
  if (!_hsResolveSub) {
    _hsResolveSub = true;
    document.addEventListener('pfx:resolve-status', () => {
      // Only refresh when Home is actually mounted/visible — avoids a perpetual
      // wasted diagnostics IPC on every heartbeat while other tabs are active.
      const home = document.getElementById('main-home');
      if (!home || home.style.display === 'none' || !home.offsetParent) return;
      try { _refreshStatus(); } catch {}
    });
  }
  _refreshStatus().catch(err => {
    console.warn('[homeScreen] status refresh error', err);
  });
  _refreshRecents().catch(err => {
    console.warn('[homeScreen] recents refresh error', err);
  });
}

export { initHomeScreen, onHomeScreenActivated };
