// scripts/features/home/setupWizard.js
// PostFlowX — First-run welcome + guided Setup Guide.
// Goal: give a non-technical user an in-app way to (a) understand what the app
// does, and (b) get every dependency green without reading a .txt file.
//
// Self-contained ES2022 module. Injects its own scoped CSS (prefix `pfxob-`)
// so it survives the dev linked-CSS cache and needs no build-step CSS copy.
// Reuses the SAME health signals as homeScreen.js so status is consistent.
// ─────────────────────────────────────────────────────────────────────────────

const ONBOARDING_DONE_KEY = 'pfx:onboarding:done:v1';
const STORAGE_KEY_RECENTS = 'recentProjects:pull_prep';
const STORAGE_KEY_CURRENT = 'currentProjectName:pull_prep';

// ── tiny chrome.storage helpers (guarded) ──────────────────────────────────────
function _get(keys) {
  return new Promise(resolve => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
      chrome.storage.local.get(keys, r => { void chrome.runtime?.lastError; resolve(r || {}); });
    } else {
      resolve({});
    }
  });
}
function _set(obj) {
  return new Promise(resolve => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.set) {
      chrome.storage.local.set(obj, () => { void chrome.runtime?.lastError; resolve(); });
    } else {
      resolve();
    }
  });
}

function _isMac() { return window.pfxPlatform?.isMacApp === true; }

// ── scoped styles ───────────────────────────────────────────────────────────────
function _injectStyles() {
  if (document.getElementById('pfxob-styles')) return;
  const css = `
  .pfxob-overlay{position:fixed;inset:0;z-index:99999;display:flex;align-items:center;
    justify-content:center;background:rgba(0,0,0,.62);backdrop-filter:blur(3px);
    animation:pfxob-fade .16s ease-out;}
  @keyframes pfxob-fade{from{opacity:0}to{opacity:1}}
  .pfxob-card{width:min(560px,calc(100vw - 48px));max-height:calc(100vh - 64px);
    overflow:auto;background:var(--pfx-bg-card,#161616);color:var(--pfx-text-primary,rgba(255,255,255,.9));
    border:1px solid var(--pfx-border-default,rgba(255,255,255,.18));
    border-radius:12px;box-shadow:var(--hwk-shadow-high,0 12px 32px rgba(0,0,0,.55));
    padding:24px 24px 18px;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
  .pfxob-close{position:absolute;top:14px;right:16px;background:none;border:none;
    color:var(--pfx-text-secondary,rgba(255,255,255,.6));font-size:22px;line-height:1;
    cursor:pointer;padding:4px;border-radius:6px;}
  .pfxob-close:hover{color:var(--pfx-text-primary,#fff);background:rgba(255,255,255,.08);}
  .pfxob-eyebrow{font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;
    color:var(--pfx-accent,#2172E3);margin:0 0 6px;}
  .pfxob-title{font-size:20px;font-weight:650;margin:0 0 6px;}
  .pfxob-sub{margin:0 0 18px;color:var(--pfx-text-secondary,rgba(255,255,255,.6));font-size:13px;}
  .pfxob-steps{list-style:none;margin:0 0 18px;padding:0;display:flex;flex-direction:column;gap:10px;}
  .pfxob-step{display:flex;gap:12px;align-items:flex-start;padding:12px 14px;
    border:1px solid var(--pfx-border-subtle,rgba(255,255,255,.12));border-radius:9px;
    background:var(--pfx-bg-elevated,#1f1f1f);}
  .pfxob-badge{flex:0 0 auto;width:22px;height:22px;border-radius:50%;display:flex;
    align-items:center;justify-content:center;font-size:12px;font-weight:700;margin-top:1px;
    border:1.5px solid var(--pfx-text-secondary,rgba(255,255,255,.4));
    color:var(--pfx-text-secondary,rgba(255,255,255,.6));}
  .pfxob-step.ok    .pfxob-badge{background:var(--hwk-green,#0AA356);border-color:var(--hwk-green,#0AA356);color:#fff;}
  .pfxob-step.warn  .pfxob-badge{border-color:var(--hwk-yellow,#E0B341);color:var(--hwk-yellow,#E0B341);}
  .pfxob-step.error .pfxob-badge{border-color:var(--hwk-red,#E5484D);color:var(--hwk-red,#E5484D);}
  .pfxob-step.checking .pfxob-badge{border-color:var(--pfx-accent,#2172E3);color:var(--pfx-accent,#2172E3);
    animation:pfxob-spin 1s linear infinite;border-right-color:transparent;}
  @keyframes pfxob-spin{to{transform:rotate(360deg)}}
  .pfxob-step-body{flex:1 1 auto;min-width:0;}
  .pfxob-step-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}
  .pfxob-step-title{font-weight:600;font-size:13px;}
  .pfxob-opt{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;
    color:var(--pfx-text-secondary,rgba(255,255,255,.5));border:1px solid var(--pfx-border-subtle,rgba(255,255,255,.12));
    border-radius:100px;padding:1px 7px;}
  .pfxob-step-desc{margin:2px 0 0;color:var(--pfx-text-secondary,rgba(255,255,255,.6));font-size:12px;}
  .pfxob-step-status{margin:6px 0 0;font-size:12px;font-weight:600;}
  .pfxob-step.ok    .pfxob-step-status{color:var(--hwk-green,#0AA356);}
  .pfxob-step.warn  .pfxob-step-status{color:var(--hwk-yellow,#E0B341);}
  .pfxob-step.error .pfxob-step-status{color:var(--hwk-red,#E5484D);}
  .pfxob-step.checking .pfxob-step-status{color:var(--pfx-accent,#2172E3);}
  .pfxob-step-action{margin-top:8px;background:var(--pfx-btn-bg,#1f1f1f);
    color:var(--pfx-text-primary,#fff);border:1px solid var(--pfx-border-default,rgba(255,255,255,.18));
    border-radius:7px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;}
  .pfxob-step-action:hover{border-color:var(--pfx-accent,#2172E3);}
  .pfxob-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;
    padding-top:6px;border-top:1px solid var(--pfx-border-subtle,rgba(255,255,255,.1));margin-top:4px;}
  .pfxob-link{background:none;border:none;color:var(--pfx-text-secondary,rgba(255,255,255,.6));
    font-size:12px;cursor:pointer;padding:6px 4px;text-decoration:underline;text-underline-offset:2px;}
  .pfxob-link:hover{color:var(--pfx-text-primary,#fff);}
  .pfxob-foot-right{display:flex;gap:8px;}
  .pfxob-btn{border-radius:7px;padding:7px 16px;font-size:13px;font-weight:600;cursor:pointer;
    border:1px solid var(--pfx-border-default,rgba(255,255,255,.18));background:var(--pfx-btn-bg,#1f1f1f);
    color:var(--pfx-text-primary,#fff);}
  .pfxob-btn:hover{border-color:var(--pfx-border-strong,rgba(255,255,255,.28));}
  .pfxob-btn--primary{background:var(--pfx-accent,#2172E3);border-color:var(--pfx-accent,#2172E3);color:#fff;}
  .pfxob-btn--primary:hover{filter:brightness(1.08);}
  `;
  const style = document.createElement('style');
  style.id = 'pfxob-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

// ── step definitions ────────────────────────────────────────────────────────────
// Each step: {id, title, optional, desc, check() -> {state, status, action?}}
// state: 'ok' | 'warn' | 'error' | 'idle' | 'checking'
// action: {label, run()} — optional call-to-action button.

function _gotoSettings(afterMs, thenClickId) {
  try { if (typeof window.setMainTab === 'function') window.setMainTab('about'); } catch (_) {}
  if (thenClickId) {
    setTimeout(() => {
      const el = document.getElementById(thenClickId);
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.click(); }
    }, afterMs || 260);
  }
}

const STEPS = [
  {
    id: 'media',
    title: 'Media engine',
    optional: false,
    desc: 'Lets PostFlowX read and preview camera media, IMF packages, and video files.',
    async check() {
      if (!_isMac()) {
        return { state: 'warn', status: 'Browser mode — some decoding is limited' };
      }
      if (!window.pfxPlatform?.media?.diagnostics) {
        return {
          state: 'error', status: 'Not responding',
          action: { label: 'Get the installer', run: () => _gotoSettings(260, 'pfxReInstallBtn') },
        };
      }
      try {
        const d = await window.pfxPlatform.media.diagnostics();
        if (d?.avfBridgeReady) return { state: 'ok', status: 'Ready — full quality' };
        if (d?.ffmpegAvailable) return { state: 'warn', status: 'Working (basic decoding)' };
        return {
          state: 'error', status: 'Limited — please run the installer',
          action: { label: 'Get the installer', run: () => _gotoSettings(260, 'pfxReInstallBtn') },
        };
      } catch {
        return { state: 'error', status: 'Could not check' };
      }
    },
  },
  {
    id: 'project',
    title: 'Create or open a project',
    optional: false,
    desc: 'A project keeps your timeline, shots, and where finished pulls get saved together.',
    async check() {
      const data = await _get([STORAGE_KEY_RECENTS, STORAGE_KEY_CURRENT]);
      const recents = Array.isArray(data[STORAGE_KEY_RECENTS]) ? data[STORAGE_KEY_RECENTS] : [];
      const current = data[STORAGE_KEY_CURRENT];
      if (current || recents.length > 0) {
        return { state: 'ok', status: current ? `Open: ${String(current).slice(0, 40)}` : `${recents.length} recent project(s)` };
      }
      return {
        state: 'warn', status: 'No project yet',
        action: {
          label: 'New project',
          run: () => { const b = document.getElementById('projNew'); if (b) b.click(); },
        },
      };
    },
  },
  {
    id: 'resolve',
    title: 'DaVinci Resolve engine',
    optional: true,
    desc: 'Optional. Adds extra decode/conform confidence checks. IMF Validation and pulls work fine without it.',
    async check() {
      const pill = document.getElementById('pfxResolvePill');
      if (pill) {
        const t = (pill.textContent || '').toLowerCase();
        const c = pill.className || '';
        if (c.includes('connected') || c.includes('ok') || t.includes('connect')) {
          return { state: 'ok', status: 'Connected' };
        }
      }
      return {
        state: 'idle', status: 'Not connected (optional)',
        action: { label: 'Set up Resolve', run: () => _gotoSettings(320, 'pfxReTestBtn') },
      };
    },
  },
];

// ── overlay build + lifecycle ───────────────────────────────────────────────────
let _openEl = null;

function _closeOverlay() {
  if (_openEl && _openEl.parentNode) _openEl.parentNode.removeChild(_openEl);
  _openEl = null;
  document.removeEventListener('keydown', _onKey);
}
function _onKey(e) { if (e.key === 'Escape') _closeOverlay(); }

function _renderStepEl(step) {
  const li = document.createElement('li');
  li.className = 'pfxob-step checking';
  li.dataset.stepId = step.id;
  li.innerHTML = `
    <span class="pfxob-badge" aria-hidden="true">…</span>
    <div class="pfxob-step-body">
      <div class="pfxob-step-head">
        <span class="pfxob-step-title"></span>
        ${step.optional ? '<span class="pfxob-opt">Optional</span>' : ''}
      </div>
      <p class="pfxob-step-desc"></p>
      <p class="pfxob-step-status">Checking…</p>
    </div>`;
  li.querySelector('.pfxob-step-title').textContent = step.title;
  li.querySelector('.pfxob-step-desc').textContent = step.desc;
  return li;
}

async function _runStep(step, li) {
  li.className = 'pfxob-step checking';
  const badge = li.querySelector('.pfxob-badge');
  const statusEl = li.querySelector('.pfxob-step-status');
  badge.textContent = '…';
  statusEl.textContent = 'Checking…';
  // drop any prior action button
  li.querySelector('.pfxob-step-action')?.remove();

  let res;
  try { res = await step.check(); } catch { res = { state: 'error', status: 'Could not check' }; }

  li.className = `pfxob-step ${res.state}`;
  badge.textContent = res.state === 'ok' ? '✓' : (res.state === 'error' ? '!' : (res.state === 'warn' ? '!' : '•'));
  statusEl.textContent = res.status || '';

  if (res.action) {
    const btn = document.createElement('button');
    btn.className = 'pfxob-step-action';
    btn.type = 'button';
    btn.textContent = res.action.label;
    btn.addEventListener('click', () => { try { res.action.run(); } catch (_) {} _closeOverlay(); });
    li.querySelector('.pfxob-step-body').appendChild(btn);
  }
  return res.state;
}

async function _runAllSteps(listEl) {
  const items = Array.from(listEl.querySelectorAll('.pfxob-step'));
  await Promise.all(items.map(li => {
    const step = STEPS.find(s => s.id === li.dataset.stepId);
    return step ? _runStep(step, li) : Promise.resolve();
  }));
}

/**
 * openSetupGuide() — show the guided setup overlay and run all checks.
 * Safe to call anytime (e.g. from a "Setup Guide" button).
 */
function openSetupGuide() {
  _injectStyles();
  if (_openEl) return;  // already open

  const overlay = document.createElement('div');
  overlay.className = 'pfxob-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'PostFlowX setup guide');

  const card = document.createElement('div');
  card.className = 'pfxob-card';
  card.innerHTML = `
    <button class="pfxob-close" type="button" aria-label="Close">×</button>
    <p class="pfxob-eyebrow">Welcome to PostFlowX</p>
    <h2 class="pfxob-title">Let’s get you set up</h2>
    <p class="pfxob-sub">PostFlowX builds VFX pulls, checks IMF packages, compares cuts, and manages delivery.
      Here’s what to have ready — green means good to go.</p>
    <ul class="pfxob-steps"></ul>
    <div class="pfxob-foot">
      <button class="pfxob-link" type="button" data-act="recheck">Re-check</button>
      <div class="pfxob-foot-right">
        <button class="pfxob-btn" type="button" data-act="docs">Open help site</button>
        <button class="pfxob-btn pfxob-btn--primary" type="button" data-act="done">Get started</button>
      </div>
    </div>`;

  const list = card.querySelector('.pfxob-steps');
  STEPS.forEach(s => list.appendChild(_renderStepEl(s)));

  overlay.appendChild(card);
  overlay.addEventListener('click', e => { if (e.target === overlay) _closeOverlay(); });
  card.querySelector('.pfxob-close').addEventListener('click', _closeOverlay);
  card.querySelector('[data-act="recheck"]').addEventListener('click', () => _runAllSteps(list));
  card.querySelector('[data-act="done"]').addEventListener('click', () => { markOnboardingDone(); _closeOverlay(); });
  card.querySelector('[data-act="docs"]').addEventListener('click', () => {
    const url = 'https://sites.google.com/netflix.com/postflowx/home';
    if (window.pfxPlatform?.openExternalSafe) window.pfxPlatform.openExternalSafe(url).catch(() => {});
    else if (window.pfxPlatform?.openExternal) window.pfxPlatform.openExternal(url);
  });

  document.body.appendChild(overlay);
  _openEl = overlay;
  document.addEventListener('keydown', _onKey);

  _runAllSteps(list).catch(() => {});
}

function markOnboardingDone() { _set({ [ONBOARDING_DONE_KEY]: true }).catch(() => {}); }

/**
 * initOnboarding() — call once after the home screen mounts.
 * - exposes window.pfxOpenSetupGuide (so a button/menu can reopen it)
 * - shows the guide automatically on first run, then never auto-shows again
 */
async function initOnboarding() {
  window.pfxOpenSetupGuide = openSetupGuide;

  // Wire the home "Setup Guide" button if present.
  const btn = document.getElementById('hs-btn-setup-guide');
  if (btn && !btn._pfxobWired) { btn._pfxobWired = true; btn.addEventListener('click', openSetupGuide); }

  // Note: the Setup Guide no longer auto-opens on first run — the interactive
  // App Tour (appTour.js) is the first-run experience and its final step opens
  // this guide. The guide remains available via its button, the status-panel
  // "Fix issues" action, the empty-state link, and window.pfxOpenSetupGuide().
}

export { initOnboarding, openSetupGuide, markOnboardingDone };
