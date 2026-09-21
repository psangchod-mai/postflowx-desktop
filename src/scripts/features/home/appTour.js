// scripts/features/home/appTour.js
// PostFlowX — SMART interactive spotlight tour ("How to use").
//
// Smart: inspects real app state (media-engine health, Resolve connection,
// whether a project is open, platform) and builds a PERSONALIZED walkthrough.
// Deep: NAVIGATES into every workspace tab and spotlights its primary control
// with tailored copy. Robust: a tab that's hidden/permission-gated is skipped;
// if a tab's anchor can't be found, it falls back to the whole pane, then to a
// centered card — it never breaks.
//
// Step shapes:
//   { center, title, body }                         — centered info card
//   { sel, pane?, title, body, action? }            — spotlight (sel may be an
//                                                     array of fallback selectors;
//                                                     pane = fallback container)
//   { nav, sel, pane, title, body }                 — switch to tab `nav` first
//   interactive:true + advanceWhen()                — clickable target, auto-advance
//
// Self-contained ES module with injected scoped CSS (prefix pfxtour-).
// ─────────────────────────────────────────────────────────────────────────────

const TOUR_DONE_KEY = 'pfx:tour:done:v1';
const STORAGE_KEY_RECENTS = 'recentProjects:pull_prep';
const STORAGE_KEY_CURRENT = 'currentProjectName:pull_prep';

function _get(keys) {
  return new Promise(resolve => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.get) {
      chrome.storage.local.get(keys, r => { void chrome.runtime?.lastError; resolve(r || {}); });
    } else { resolve({}); }
  });
}
function _set(obj) {
  return new Promise(resolve => {
    if (typeof chrome !== 'undefined' && chrome.storage?.local?.set) {
      chrome.storage.local.set(obj, () => { void chrome.runtime?.lastError; resolve(); });
    } else { resolve(); }
  });
}

function _tabVisible(key) {
  const el = document.querySelector(`.tab[data-main="${key}"]`);
  return _visible(el);
}
function _tabActive(key) {
  const el = document.querySelector(`.tab[data-main="${key}"]`);
  return !!el && el.classList.contains('active');
}
function _click(id) { const el = document.getElementById(id); if (el) el.click(); }

// ── Gather real app state so the tour can adapt ───────────────────────────────
async function _gatherState() {
  const isMac = window.pfxPlatform?.isMacApp === true;
  let mediaReady = !isMac, mediaFull = false;
  if (isMac && window.pfxPlatform?.media?.diagnostics) {
    try {
      const d = await window.pfxPlatform.media.diagnostics();
      mediaFull = !!d?.avfBridgeReady;
      mediaReady = !!(d?.avfBridgeReady || d?.ffmpegAvailable);
    } catch (_) {}
  }
  let resolveConnected = false, resolvePresent = false;
  const pill = document.getElementById('pfxResolvePill');
  if (pill) {
    resolvePresent = true;
    const t = (pill.textContent || '').toLowerCase(), c = pill.className || '';
    resolveConnected = c.includes('connected') || c.includes('ok') || t.includes('connect');
  }
  let projectCount = 0, currentName = '';
  try {
    const data = await _get([STORAGE_KEY_RECENTS, STORAGE_KEY_CURRENT]);
    projectCount = Array.isArray(data[STORAGE_KEY_RECENTS]) ? data[STORAGE_KEY_RECENTS].length : 0;
    currentName = data[STORAGE_KEY_CURRENT] || '';
  } catch (_) {}
  return { isMac, mediaReady, mediaFull, resolveConnected, resolvePresent, projectCount, currentName };
}

// Per-tab deep steps — navigate in, spotlight the primary control.
const TAB_STEPS = [
  { nav: 'prepmark',   sel: ['#pmImportEdlBtn', '#pmEventEmpty'], pane: '#main-prepmark',
    title: 'Pull Prep', body: 'Your main workspace. Import a timeline (EDL / FCPXML / OTIO / ALE), mark shots, then build and export VFX pulls.' },
  { nav: 'cutdiff2',   sel: ['#cd2x-table-empty'], pane: '#main-cutdiff2',
    title: 'Cut Diff', body: 'Load an OLD and a NEW timeline, then Analyze to see exactly what changed between cuts.' },
  { nav: 'platelink2', sel: ['#pl2ScanBtn', '#pl2SlEmpty'], pane: '#main-platelink2',
    title: 'Plate Link', body: 'Scan your VFX delivery folder to list every shot and verify each one is delivered and ready.' },
  { nav: 'reviews',    sel: ['#reviewsMount', '#reviewsCard'], pane: '#main-reviews',
    title: 'Visual QC', body: 'Drop MP4/MOV clips to review and mark issues frame-by-frame on a virtual timeline.' },
  { nav: 'trlconf',    sel: ['#trcEmptyState'], pane: '#main-trlconf',
    title: 'Trailers Conform', body: 'Convert & conform timeline formats, and AI-match source clips to a reference QuickTime.' },
  { nav: 'bwav',       sel: ['#bwavFrame'], pane: '#main-bwav',
    title: 'BWAV Inspector', body: 'Inspect broadcast-WAV audio metadata and embedded timecode.' },
  { nav: 'preflight',  sel: ['#preflightFrame'], pane: '#main-preflight',
    title: 'Preflight', body: 'Run pre-delivery checks to catch problems before you export.' },
  { nav: 'imf',        sel: ['#imfBrowseBtn', '#imfDropZone'], pane: '#main-imf',
    title: 'IMF Validation', body: 'Import an IMF package folder to validate it for compliance before delivery.' },
  { nav: 'aceslook',   sel: ['#al2-src-drop-label'], pane: '#main-aceslook',
    title: 'ACES Look', body: 'Set input/output color transforms and CDL, and export looks (AMF / CDL / CLF).' },
  { nav: 'renderq',    sel: [], pane: '#main-renderq',
    title: 'Render Queue', body: 'Monitor and manage your render and export jobs — pause, resume, retry.' },
  { nav: 'about',      sel: ['#mmCard', '#appTourCard'], pane: '#main-about',
    title: 'Settings', body: 'Set your Project Folder and Media Root, tune preferences, and replay this tour anytime.' },
];

// ── Build a personalized step list from state ─────────────────────────────────
function _buildSteps(s) {
  const steps = [];
  const hasProject = s.projectCount > 0 || !!s.currentName;

  steps.push({ center: true,
    title: hasProject ? 'Welcome back to PostFlowX' : 'Welcome to PostFlowX',
    body: hasProject
      ? `You have ${s.projectCount} recent project${s.projectCount === 1 ? '' : 's'}. Here's a quick tour of every workspace — about a minute.`
      : "Let's take a quick tour of every workspace so you know where everything is. You can skip anytime." });

  if (!s.mediaReady) {
    steps.push({ sel: '#hs-btn-setup-guide', title: 'Finish setup first',
      body: "PostFlowX's media helper isn't ready yet, so previews won't work. The Setup Guide walks you through it in one click.",
      action: { label: 'Open Setup Guide', run: () => { try { window.pfxOpenSetupGuide?.(); } catch (_) {} } } });
  }

  if (!hasProject) {
    steps.push({ sel: '#hs-quick-actions', title: 'Create your first project',
      body: 'Everything starts with a project — it keeps your timeline, shots, and output settings together.',
      action: { label: 'New Project', run: () => _click('projNew') } });
  } else {
    steps.push({ sel: document.getElementById('hs-recents-list') ? '#hs-recents-list' : '#hs-quick-actions',
      title: 'Pick up where you left off',
      body: 'Your recent projects live here — click one to reopen it, or start a new one from Quick Actions.' });
  }

  steps.push({ sel: '#hs-status-list',
    title: s.mediaReady ? 'System status' : 'System status — needs attention',
    body: s.mediaReady
      ? 'Green dots mean ready. If anything ever needs attention, a "Fix issues" button appears right here.'
      : 'A "Fix issues" button appears here when something needs setup — click it to jump straight to the fix.' });

  // Deep tour of every visible tab (adds resolve note inline where relevant).
  for (const t of TAB_STEPS) {
    if (!_tabVisible(t.nav)) continue;   // skip hidden / permission-gated tabs
    const step = { nav: t.nav, sel: t.sel, pane: t.pane, title: t.title, body: t.body };
    if (t.nav === 'about' && s.resolvePresent) {
      step.body += s.resolveConnected
        ? ' DaVinci Resolve is connected for extra decode/conform checks.'
        : ' (DaVinci Resolve is optional — set it up here if you want the extra checks.)';
    }
    steps.push(step);
  }

  steps.push({ center: true, nav: 'home', title: "You're all set",
    body: 'Replay this walkthrough anytime from the "How to Use" button on Home or Settings → App Tour.',
    action: { label: 'Open Setup Guide', run: () => { try { window.pfxOpenSetupGuide?.(); } catch (_) {} } } });

  return steps;
}

// ── Styles ────────────────────────────────────────────────────────────────────
function _injectStyles() {
  if (document.getElementById('pfxtour-styles')) return;
  const css = `
  .pfxtour-root{position:fixed;inset:0;z-index:100000;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
  .pfxtour-catch{position:fixed;inset:0;pointer-events:none;}
  .pfxtour-panel{position:fixed;background:rgba(0,0,0,.62);pointer-events:auto;}
  .pfxtour-block{position:fixed;background:transparent;pointer-events:auto;}
  .pfxtour-spot{position:fixed;border-radius:8px;pointer-events:none;
    box-shadow:0 0 0 2px var(--pfx-accent,#2172E3) inset,0 0 0 3px rgba(33,114,227,.35);
    transition:left .22s ease,top .22s ease,width .22s ease,height .22s ease;}
  .pfxtour-spot.interactive{animation:pfxtour-pulse 1.4s ease-in-out infinite;}
  @keyframes pfxtour-pulse{0%,100%{box-shadow:0 0 0 2px var(--pfx-accent,#2172E3) inset,0 0 0 4px rgba(33,114,227,.30);}50%{box-shadow:0 0 0 2px var(--pfx-accent,#2172E3) inset,0 0 0 10px rgba(33,114,227,.10);}}
  .pfxtour-card{position:fixed;width:322px;max-width:calc(100vw - 32px);pointer-events:auto;
    background:var(--pfx-bg-card,#161616);color:var(--pfx-text-primary,rgba(255,255,255,.92));
    border:1px solid var(--pfx-border-default,rgba(255,255,255,.18));border-radius:11px;
    box-shadow:var(--hwk-shadow-high,0 12px 32px rgba(0,0,0,.55));padding:16px 16px 12px;transition:left .2s ease,top .2s ease;}
  .pfxtour-eyebrow{font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--pfx-accent,#2172E3);margin:0 0 5px;}
  .pfxtour-title{font-size:15px;font-weight:650;margin:0 0 5px;}
  .pfxtour-body{margin:0 0 10px;color:var(--pfx-text-secondary,rgba(255,255,255,.66));font-size:12.5px;}
  .pfxtour-hint{margin:0 0 10px;font-size:11.5px;font-weight:600;color:var(--pfx-accent,#2172E3);display:flex;align-items:center;gap:6px;}
  .pfxtour-hint::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--pfx-accent,#2172E3);animation:pfxtour-blink 1s infinite;}
  @keyframes pfxtour-blink{0%,100%{opacity:1}50%{opacity:.25}}
  .pfxtour-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;}
  .pfxtour-dots{display:flex;gap:4px;flex-wrap:wrap;max-width:140px;}
  .pfxtour-dot{width:5px;height:5px;border-radius:50%;background:rgba(255,255,255,.22);}
  .pfxtour-dot.on{background:var(--pfx-accent,#2172E3);}
  .pfxtour-btns{display:flex;gap:6px;align-items:center;}
  .pfxtour-skip{background:none;border:none;color:var(--pfx-text-secondary,rgba(255,255,255,.55));font-size:12px;cursor:pointer;padding:6px 4px;text-decoration:underline;text-underline-offset:2px;}
  .pfxtour-skip:hover{color:var(--pfx-text-primary,#fff);}
  .pfxtour-btn{border-radius:7px;padding:6px 13px;font-size:12.5px;font-weight:600;cursor:pointer;border:1px solid var(--pfx-border-default,rgba(255,255,255,.18));background:var(--pfx-btn-bg,#1f1f1f);color:var(--pfx-text-primary,#fff);}
  .pfxtour-btn:hover{border-color:var(--pfx-border-strong,rgba(255,255,255,.3));}
  .pfxtour-btn--primary{background:var(--pfx-accent,#2172E3);border-color:var(--pfx-accent,#2172E3);color:#fff;}
  .pfxtour-btn--primary:hover{filter:brightness(1.08);}
  `;
  const st = document.createElement('style'); st.id = 'pfxtour-styles'; st.textContent = css;
  document.head.appendChild(st);
}

let _root = null, _idx = 0, _order = [], _poll = null, _launching = false;

function _visible(el) { if (!el) return false; const r = el.getBoundingClientRect(); return r.width > 1 && r.height > 1; }
function _resolveEl(sel) {
  if (!sel) return null;
  const list = Array.isArray(sel) ? sel : [sel];
  for (const s of list) { const el = document.querySelector(s); if (_visible(el)) return el; }
  return null;
}
function _clearPoll() { if (_poll) { clearInterval(_poll); _poll = null; } }

function _end() {
  _clearPoll();
  _launching = false;
  if (_root && _root.parentNode) _root.parentNode.removeChild(_root);
  _root = null;
  document.removeEventListener('keydown', _onKey, true);
  window.removeEventListener('resize', _reposition);
  markTourDone();
}
function _onKey(e) {
  if (!_root) return;
  if (e.key === 'Escape') { e.preventDefault(); _end(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); _go(1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); _go(-1); }
}
function _go(delta) {
  const next = _idx + delta;
  if (next < 0) return;
  if (next >= _order.length) { _end(); return; }
  _idx = next;
  _render();
}
function _reposition() { if (_root) _paint(_order[_idx], true); }

// Schedule: navigate the tab if needed, then paint after the pane mounts.
function _render() {
  _clearPoll();
  const step = _order[_idx];
  if (step.nav) {
    try { if (typeof window.setMainTab === 'function' && !_tabActive(step.nav)) window.setMainTab(step.nav); } catch (_) {}
    setTimeout(() => { if (_root && _order[_idx] === step) _paint(step, false); }, 340);
    return;
  }
  _paint(step, false);
}

// Build the dim/click layer. Interactive w/ target → 4 panels leaving a clickable hole.
function _layoutCatch(rect, interactive) {
  const catch_ = _root.querySelector('.pfxtour-catch');
  catch_.innerHTML = '';
  const vw = window.innerWidth, vh = window.innerHeight;
  const mk = (l, t, w, h) => { const p = document.createElement('div'); p.className = 'pfxtour-panel';
    p.style.left = Math.max(0, l) + 'px'; p.style.top = Math.max(0, t) + 'px';
    p.style.width = Math.max(0, w) + 'px'; p.style.height = Math.max(0, h) + 'px'; catch_.appendChild(p); };
  if (!rect) { mk(0, 0, vw, vh); return; }
  const pad = 6, L = rect.left - pad, T = rect.top - pad, R = rect.right + pad, B = rect.bottom + pad;
  // Dim only the SURROUNDINGS — the spotlighted region stays visible.
  mk(0, 0, vw, T); mk(0, B, vw, vh - B); mk(0, T, L, B - T); mk(R, T, vw - R, B - T);
  // For non-interactive steps, cover the hole with a TRANSPARENT click-blocker
  // (so the content is still visible but the user advances via Next).
  if (!interactive) {
    const b = document.createElement('div');
    b.className = 'pfxtour-block';
    b.style.left = L + 'px'; b.style.top = T + 'px';
    b.style.width = (R - L) + 'px'; b.style.height = (B - T) + 'px';
    catch_.appendChild(b);
  }
}

function _paint(step, keepText) {
  _clearPoll();
  const spot = _root.querySelector('.pfxtour-spot');
  const card = _root.querySelector('.pfxtour-card');

  let rect = null;
  if (!step.center) {
    const el = _resolveEl(step.sel) || (step.pane ? _resolveEl(step.pane) : null);
    if (el) { try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {} rect = el.getBoundingClientRect(); }
  }

  _layoutCatch(rect, !!step.interactive);
  if (rect) {
    const pad = 6;
    spot.style.display = 'block';
    spot.className = 'pfxtour-spot' + (step.interactive ? ' interactive' : '');
    spot.style.left = (rect.left - pad) + 'px'; spot.style.top = (rect.top - pad) + 'px';
    spot.style.width = (rect.width + pad * 2) + 'px'; spot.style.height = (rect.height + pad * 2) + 'px';
  } else { spot.style.display = 'none'; }

  if (!keepText) {
    const isLast = _idx === _order.length - 1;
    const dots = _order.map((_, i) => `<span class="pfxtour-dot${i === _idx ? ' on' : ''}"></span>`).join('');
    card.innerHTML = `
      <p class="pfxtour-eyebrow">How to use · ${_idx + 1} of ${_order.length}</p>
      <h3 class="pfxtour-title"></h3>
      <p class="pfxtour-body"></p>
      ${step.interactive ? '<p class="pfxtour-hint">Click the highlighted item to continue</p>' : ''}
      <div class="pfxtour-foot">
        <div class="pfxtour-dots">${dots}</div>
        <div class="pfxtour-btns">
          ${_idx > 0 ? '<button class="pfxtour-btn" data-act="back">Back</button>' : '<button class="pfxtour-skip" data-act="skip">Skip</button>'}
          ${step.action ? `<button class="pfxtour-btn" data-act="action">${_esc(step.action.label)}</button>` : ''}
          <button class="pfxtour-btn pfxtour-btn--primary" data-act="next">${isLast ? 'Done' : (step.interactive ? 'Skip step' : 'Next')}</button>
        </div>
      </div>`;
    card.querySelector('.pfxtour-title').textContent = step.title;
    card.querySelector('.pfxtour-body').textContent = step.body;
    card.querySelector('[data-act="next"]').addEventListener('click', () => _go(1));
    card.querySelector('[data-act="back"]')?.addEventListener('click', () => _go(-1));
    card.querySelector('[data-act="skip"]')?.addEventListener('click', _end);
    card.querySelector('[data-act="action"]')?.addEventListener('click', () => { try { step.action.run(); } catch (_) {} setTimeout(() => _go(1), 350); });
  }

  if (step.interactive && typeof step.advanceWhen === 'function') {
    _poll = setInterval(() => { let d = false; try { d = !!step.advanceWhen(); } catch (_) {} if (d) { _clearPoll(); _go(1); } }, 250);
  }

  const cw = 322, ch = card.offsetHeight || 160, m = 12, vw = window.innerWidth, vh = window.innerHeight;
  if (rect) {
    let top = rect.bottom + m;
    if (top + ch > vh - 8) top = Math.max(8, rect.top - ch - m);
    let left = rect.left + rect.width / 2 - cw / 2;
    left = Math.max(12, Math.min(left, vw - cw - 12));
    card.style.left = left + 'px'; card.style.top = top + 'px';
  } else { card.style.left = (vw / 2 - cw / 2) + 'px'; card.style.top = (vh / 2 - ch / 2) + 'px'; }
}

function _esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c])); }

/** startTour() — gather state, build a personalized deep tour, and run it. */
async function startTour() {
  _injectStyles();
  if (_root || _launching) return;   // never run two tours at once
  _launching = true;
  try { if (typeof window.setMainTab === 'function') window.setMainTab('home'); } catch (_) {}
  let state = {};
  try { state = await _gatherState(); } catch (_) {}
  setTimeout(() => {
    _launching = false;
    if (_root) return;               // another instance beat us to it
    // Defensive: clear any orphaned overlay from a prior crash.
    document.querySelectorAll('.pfxtour-root').forEach(n => n.remove());
    const built = _buildSteps(state);
    // Keep center steps, nav steps whose tab is visible, and plain steps whose target resolves.
    _order = built.filter(s => s.center || (s.nav ? _tabVisible(s.nav) : !!_resolveEl(s.sel)));
    if (!_order.length) return;
    _idx = 0;
    _root = document.createElement('div');
    _root.className = 'pfxtour-root';
    _root.innerHTML = '<div class="pfxtour-catch"></div><div class="pfxtour-spot"></div><div class="pfxtour-card"></div>';
    document.body.appendChild(_root);
    document.addEventListener('keydown', _onKey, true);
    window.addEventListener('resize', _reposition);
    _render();
  }, 180);
}

function markTourDone() { _set({ [TOUR_DONE_KEY]: true }).catch(() => {}); }
async function _isTourDone() { const d = await _get([TOUR_DONE_KEY]); return d[TOUR_DONE_KEY] === true; }

async function initAppTour() {
  window.pfxStartTour = startTour;
  const wire = (id, fn) => { const el = document.getElementById(id); if (el && !el._pfxtourWired) { el._pfxtourWired = true; el.addEventListener('click', fn); } };
  wire('hs-btn-tour', startTour);
  wire('btnReplayTour', startTour);
  wire('btnOpenSetupGuideSettings', () => { try { window.pfxOpenSetupGuide?.(); } catch (_) {} });
  try { if (!(await _isTourDone())) { markTourDone(); setTimeout(startTour, 700); } } catch (_) {}
}

export { initAppTour, startTour, markTourDone };
