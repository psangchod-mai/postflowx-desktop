/**
 * project_setup.js — PostFlowX Project Setup System
 *
 * Right-side slide panel with 7 sections:
 *   OCR Setup · Naming · Project Rules · Timeline · Markers · Export · Storage
 *
 * Storage: IndexedDB (primary) + chrome.storage.local (fallback)
 * Sync:    BroadcastChannel('pfx-project-setup-sync')
 * Compat:  Writes OCR + naming settings back to the same localStorage keys
 *          that prep_mark.js and naming_template.js already read.
 */

// ── Constants ─────────────────────────────────────────────────────────────────
const _PSS_IDB_NAME    = 'pfxProjectSetup';
const _PSS_IDB_STORE   = 'settings';
const _PSS_BC_NAME     = 'pfx-project-setup-sync';
const _PSS_AUTOSAVE_MS = 30_000;
const _PSS_MAX_HISTORY = 10;

// ── Default settings schema ───────────────────────────────────────────────────
function _pssDefaults() {
  return {
    _version: 1,
    _savedAt: null,
    _history: [],
    ocr: {
      enabled:             true,
      detectionMode:       'vfxShotName',   // 'vfxShotName' | 'anyText'
      defaultRegion:       'bottomCenter',  // preset key or 'manual'
      manualCrop:          null,            // {x,y,w,h} percentages
      confidenceThreshold: 0.65,
      normalizeIllegal:    true,
      replaceSpaces:       true,
      keepSpaces:          false,
      uppercase:           false,
      customRegex:         '',
      showOverlay:         true,
    },
    naming: {
      autoUpdate:  true,
      show:        '',
      ep:          '',
      seq:         '',
      scene:       '',
      vendor:      '',
      ver:         '',
      shotStart:   1,
      shotPad:     4,
      padOn:       true,
      separator:   '_',
    },
    rules: {
      autoApply:      true,
      keepOverrides:  true,
      syncTabs:       true,
      conflictMode:   'ask',    // 'ask' | 'keep' | 'overwrite'
    },
    timeline: {
      autoMatch:    true,
      formats: {
        edl:    true,
        fcpxml: true,
        otio:   true,
        aaf:    true,
        ale:    true,
      },
    },
    markers: {
      defaultColor:    '#f5c542',
      defaultPriority: 'medium',
      autoLabel:       true,
    },
    export: {
      exrNaming:   '{show}_{seq}_{shot}_v{ver}',
      amfExport:   false,
      fdlExport:   false,
      burninEnabled: false,
      outputFolder: '',
    },
    resolveEngine: {
      // background_auto: PostFlowX starts Resolve automatically in the background.
      // User never needs to open Resolve manually.
      enabled:               false,
      mode:                  'background_auto',
      autoLaunch:            true,
      minimizeOnLaunch:      true,
      reuseRunningResolve:   true,
      cleanupTempProjects:   true,
      quitAfterQueueComplete: false,
      runMode:               'background',
      launchPolicy:          'on_demand',
      resolvePath:           '',
      resolveExecutablePath: '',
      workspaceRoot:         '',
      debugMode:             false,
      timeoutSeconds:        60,
      useForProxy:           false,
      useForTrailerConform:  false,
      useForPlates:          false,
      useForAmf:             false,
      useForTimelineValidation: false,
      useForReferenceMovie:  false,
      aiFeatures: {
        transcription:  false,
        peopleAnalysis: false,
        smartReframe:   false,
      },
      advanced: {
        apiReadyTimeoutSeconds: 90,
        jobTimeoutSeconds:      300,
        debugMode:              false,
      },
    },
    trailerConform: {
      projectLabel:      'TrailerConform',
      timelineFps:       24,
      proxySize:         '640x360',
      outputFolderPath:  '',
      outputFolderLabel: '',
      outputFolderReady: false,
    },
    general: {
      frameRate:      23.976,
      frameRateExact: { numerator: 24000, denominator: 1001 },
      timecodeMode:   'auto',  // 'auto' | 'non-drop' | 'drop'
      dropFrame:      false,   // derived convenience flag
    },
  };
}

// ── Project key helpers ───────────────────────────────────────────────────────
function _pssProjectKey() {
  return window.__pfxGetProjectKey?.() || 'default';
}

function _pssLsPrefix() {
  return `pfx.prepmark.${_pssProjectKey()}.`;
}

// ── IndexedDB layer ───────────────────────────────────────────────────────────
let _pssDb = null;

async function _pssOpenDb() {
  if (_pssDb) return _pssDb;
  return new Promise((res, rej) => {
    const req = indexedDB.open(_PSS_IDB_NAME, 1);
    req.onupgradeneeded = e => {
      e.target.result.createObjectStore(_PSS_IDB_STORE);
    };
    req.onsuccess = e => { _pssDb = e.target.result; res(_pssDb); };
    req.onerror   = e => rej(e.target.error);
  });
}

async function _pssIdbGet(key) {
  try {
    const db = await _pssOpenDb();
    return new Promise((res, rej) => {
      const tx = db.transaction(_PSS_IDB_STORE, 'readonly');
      const req = tx.objectStore(_PSS_IDB_STORE).get(key);
      req.onsuccess = () => res(req.result ?? null);
      req.onerror   = e => rej(e.target.error);
    });
  } catch { return null; }
}

async function _pssIdbSet(key, val) {
  // Do NOT catch here — let errors propagate so _pssSaveNow can detect IDB failures
  const db = await _pssOpenDb();
  return new Promise((res, rej) => {
    const tx = db.transaction(_PSS_IDB_STORE, 'readwrite');
    const req = tx.objectStore(_PSS_IDB_STORE).put(val, key);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

// ── chrome.storage.local fallback ─────────────────────────────────────────────
async function _pssCSGet(key) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.get) return null;
  return new Promise(res => {
    chrome.storage.local.get(`pfxSetup.${key}`, r => res(r[`pfxSetup.${key}`] ?? null));
  });
}

async function _pssCSSet(key, val) {
  if (typeof chrome === 'undefined' || !chrome.storage?.local?.set) return;
  return chrome.storage.local.set({ [`pfxSetup.${key}`]: val });
}

// ── Unified load / save ───────────────────────────────────────────────────────
let _pssSettings = null;
let _pssDirty    = false;
let _pssIdbOk    = false;
let _pssCsOk     = false;

async function _pssLoad() {
  const projKey = _pssProjectKey();
  let loaded = null;

  const idb = await _pssIdbGet(projKey);
  if (idb && typeof idb === 'object') { loaded = idb; _pssIdbOk = true; }

  if (!loaded) {
    const cs = await _pssCSGet(projKey);
    if (cs && typeof cs === 'object') { loaded = cs; _pssCsOk = true; }
  }

  const defaults = _pssDefaults();
  _pssSettings = loaded
    ? _pssMerge(defaults, loaded)
    : defaults;

  _pssDirty = false;
  return _pssSettings;
}

async function _pssSaveNow(silent = false) {
  if (!_pssSettings) return;
  const projKey = _pssProjectKey();
  const snap = { ..._pssSettings, _savedAt: new Date().toISOString() };

  // Prepend to history ring (max _PSS_MAX_HISTORY).
  // Strip _history from each stored snapshot so entries don't grow exponentially.
  const hist = Array.isArray(snap._history) ? [...snap._history] : [];
  if (hist.length >= _PSS_MAX_HISTORY) hist.pop();
  const snapFlat = { ...snap, _history: [] };
  hist.unshift({ _savedAt: snap._savedAt, _snap: JSON.stringify(snapFlat) });
  snap._history = hist;

  _pssSettings = snap;
  _pssDirty = false;

  // Try IDB first; fall back to chrome.storage if IDB fails.
  // Strip _history from the chrome.storage copy to stay within quota limits.
  const snapForCS = { ...snap, _history: [] };
  try { await _pssIdbSet(projKey, snap); _pssIdbOk = true; } catch { _pssIdbOk = false; }
  if (!_pssIdbOk) {
    try { await _pssCSSet(projKey, snapForCS); _pssCsOk = true; } catch { _pssCsOk = false; }
  } else {
    _pssCSSet(projKey, snapForCS).catch(() => {});
  }

  // Sync compatible keys for prep_mark.js and naming_template.js
  _pssBridgeToLs();

  // Broadcast to other tabs
  try { _pssBcSend({ type: 'saved', projKey, savedAt: snap._savedAt }); } catch {}

  if (!silent) _pssRefreshPersistenceSection();
  _pssUpdateStatusBar();
}

function _pssMerge(defaults, saved) {
  const out = { ...defaults };
  for (const k of Object.keys(defaults)) {
    if (saved[k] !== undefined && saved[k] !== null) {
      if (k.startsWith('_')) { out[k] = saved[k]; continue; }
      if (typeof defaults[k] === 'object' && !Array.isArray(defaults[k])) {
        out[k] = { ...defaults[k], ...saved[k] };
        // deep merge one more level for nested objects (timeline.formats etc.)
        for (const sk of Object.keys(defaults[k])) {
          if (saved[k][sk] !== undefined && typeof defaults[k][sk] === 'object' && !Array.isArray(defaults[k][sk])) {
            out[k][sk] = { ...defaults[k][sk], ...saved[k][sk] };
          }
        }
      } else {
        out[k] = saved[k];
      }
    }
  }
  return out;
}

// ── localStorage bridge (backward compat with prep_mark.js) ──────────────────
function _pssBridgeToLs() {
  if (!_pssSettings) return;
  const pfx = _pssLsPrefix();

  // OCR settings — prep_mark reads pfx.prepmark.{key}.ocrSettings.v1
  try {
    const o = _pssSettings.ocr;
    const ocrBlob = {
      enabled:             !!o.enabled,
      defaultRegion:       o.defaultRegion,
      confidenceThreshold: o.confidenceThreshold,
      normalizeIllegal:    o.normalizeIllegal,
      replaceSpaces:       o.replaceSpaces,
      keepSpaces:          o.keepSpaces,
      uppercase:           o.uppercase,
      customRegex:         o.customRegex || null,
      detectionMode:       o.detectionMode,
      manualCrop:          o.manualCrop || null,
      showOverlay:         o.showOverlay,
    };
    localStorage.setItem(`${pfx}ocrSettings.v1`, JSON.stringify(ocrBlob));
  } catch {}

  // General / frame rate — prep_mark.js reads pfx.prepmark.{key}.generalSettings.v1
  try {
    const g = _pssSettings.general;
    if (g) localStorage.setItem(`${pfx}generalSettings.v1`, JSON.stringify({
      frameRate:      g.frameRate,
      frameRateExact: g.frameRateExact,
      timecodeMode:   g.timecodeMode,
      dropFrame:      g.dropFrame,
    }));
  } catch {}

  // Naming settings — naming_template.js reads pfx_nt_* keys
  try {
    const n = _pssSettings.naming;
    const ntMap = { pfx_nt_show: n.show, pfx_nt_ep: n.ep, pfx_nt_seq: n.seq, pfx_nt_scene: n.scene, pfx_nt_vendor: n.vendor, pfx_nt_ver: n.ver };
    for (const [k, v] of Object.entries(ntMap)) {
      if (v !== undefined) localStorage.setItem(k, v || '');
    }
    if (n.shotStart !== undefined) localStorage.setItem('pfx_nt_start', String(n.shotStart));
    if (n.shotPad   !== undefined) localStorage.setItem('pfx_nt_pad',   String(n.shotPad));
    if (n.padOn     !== undefined) localStorage.setItem('pfx_nt_padOn',  n.padOn ? '1' : '0');
  } catch {}
}

// ── BroadcastChannel ──────────────────────────────────────────────────────────
let _pssBcInstance = null;

function _pssBcSend(msg) {
  try { _pssBcInstance?.postMessage(msg); } catch {}
}

function _pssInitBc() {
  if (!window.BroadcastChannel) return;
  try {
    _pssBcInstance = new BroadcastChannel(_PSS_BC_NAME);
    _pssBcInstance.onmessage = e => {
      const msg = e.data;
      if (!msg?.type) return;
      if (msg.type === 'saved' && msg.projKey === _pssProjectKey()) {
        // Another tab saved — reload our settings
        _pssLoad().then(() => {
          _pssRepaintActiveSection();
          _pssUpdateStatusBar();
        });
      }
      if (msg.type === 'open') {
        openProjectSetup(msg.tab || null);
      }
    };
  } catch {}
}

// ── Autosave ──────────────────────────────────────────────────────────────────
let _pssAutosaveTimer = null;

function _pssMarkDirty() {
  _pssDirty = true;
  if (_pssAutosaveTimer) clearTimeout(_pssAutosaveTimer);
  _pssAutosaveTimer = setTimeout(() => _pssSaveNow(true), _PSS_AUTOSAVE_MS);
  _pssUpdateStatusBar();
}

function _pssFlushAutosave() {
  if (_pssDirty) _pssSaveNow(true);
  if (_pssAutosaveTimer) { clearTimeout(_pssAutosaveTimer); _pssAutosaveTimer = null; }
}

// ── Panel state ───────────────────────────────────────────────────────────────
let _pssOpen      = false;
let _pssActiveTab = 'general';
let _pssEl        = null;   // the panel root element

// ── Status bar ────────────────────────────────────────────────────────────────
function _pssUpdateStatusBar() {
  const bar = document.getElementById('pfxSetupStatusBar');
  if (!bar) return;
  const s = _pssSettings;
  const dots = [
    { label: 'OCR',     ok: s?.ocr?.enabled,       ok_label: 'OCR Ready',        bad_label: 'OCR Off' },
    { label: 'Naming',  ok: true,                   ok_label: 'Naming Ready',     bad_label: 'Naming N/A' },
    { label: 'Save',    ok: !_pssDirty,             ok_label: 'Saved',            bad_label: 'Unsaved' },
    { label: 'Storage', ok: _pssIdbOk || _pssCsOk, ok_label: 'Storage OK',       bad_label: 'Storage Err' },
  ];
  bar.innerHTML = dots.map(d =>
    `<span class="pfx-setup-sdot ${d.ok ? 'pfx-setup-sdot--ok' : 'pfx-setup-sdot--warn'}" title="${d.ok ? d.ok_label : d.bad_label}"></span><span class="pfx-setup-sdot-lbl">${d.label}</span>`
  ).join('');
}

// Update the header-bar indicator button dot if panel is closed
function _pssUpdateHeaderDot() {
  const btn = document.getElementById('pfxSetupBtn');
  if (!btn) return;
  btn.classList.toggle('pfx-setup-btn--dirty', !!_pssDirty);
}

// ── Section HTML builders ─────────────────────────────────────────────────────

// ── FPS preset table (mirrors utils_time.js FPS_PRESETS) ─────────────────────
const _PSS_FPS_PRESETS = [
  { label: '23.976 fps', fps: 23.976, numerator: 24000, denominator: 1001, dfCapable: false },
  { label: '24 fps',     fps: 24,     numerator: 24,    denominator: 1,    dfCapable: false },
  { label: '25 fps',     fps: 25,     numerator: 25,    denominator: 1,    dfCapable: false },
  { label: '29.97 fps',  fps: 29.97,  numerator: 30000, denominator: 1001, dfCapable: true  },
  { label: '30 fps',     fps: 30,     numerator: 30,    denominator: 1,    dfCapable: false },
  { label: '50 fps',     fps: 50,     numerator: 50,    denominator: 1,    dfCapable: false },
  { label: '59.94 fps',  fps: 59.94,  numerator: 60000, denominator: 1001, dfCapable: true  },
  { label: '60 fps',     fps: 60,     numerator: 60,    denominator: 1,    dfCapable: false },
  { label: '120 fps',    fps: 120,    numerator: 120,   denominator: 1,    dfCapable: false },
];

function _pssFpsEntry(fps) {
  return _PSS_FPS_PRESETS.find(e => Math.abs(e.fps - fps) < 0.02) || null;
}

function _pssHtml_General(s) {
  const g   = s.general || {};
  const fps = g.frameRate || 23.976;
  const mode = g.timecodeMode || 'auto';
  const entry = _pssFpsEntry(fps);
  const dfCapable = !!(entry?.dfCapable);

  const fpsOpts = _PSS_FPS_PRESETS.map(e =>
    `<option value="${e.fps}" ${Math.abs(e.fps - fps) < 0.02 ? 'selected' : ''}>${e.label}</option>`
  ).join('');

  const modeOpts = [
    `<option value="auto"      ${mode === 'auto'      ? 'selected' : ''}>Auto</option>`,
    `<option value="non-drop"  ${mode === 'non-drop'  ? 'selected' : ''}>Non-drop frame</option>`,
    `<option value="drop" ${!dfCapable ? 'disabled' : ''} ${mode === 'drop' && dfCapable ? 'selected' : ''}>Drop frame</option>`,
  ].join('');

  const dfHint = (!dfCapable && mode === 'drop')
    ? `<span class="pfx-setup-hint pfx-setup-hint--warn">Drop-frame is only valid for 29.97/59.94.</span>`
    : (!dfCapable
      ? `<span class="pfx-setup-hint">Drop-frame is only valid for 29.97/59.94.</span>`
      : '');

  const exact = entry
    ? `${entry.numerator}/${entry.denominator}`
    : `${Math.round(fps * 1001)}/1001`;

  return `
<div class="pfx-setup-section" data-section="general">
  <div class="pfx-setup-group-head">Project Settings</div>
  <p class="pfx-setup-desc">Frame rate and timecode settings for the entire project. All timecode, marker, clip matching, and export calculations use these values.</p>

  <div class="pfx-setup-row">
    <label class="pfx-setup-label">
      Project Frame Rate
      <span class="pfx-setup-hint pfx-setup-hint--inline" title="Sets the nominal frame rate used for all timecode math, EDL/CSV export, and clip matching.">ⓘ</span>
    </label>
    <select class="pfx-setup-sel pfx-setup-sel--fps" data-pss="general.frameRate" data-pss-handler="frameRate">${fpsOpts}</select>
    <span class="pfx-setup-hint pfx-setup-hint--dim" id="pfxGenFpsExact">${exact}</span>
  </div>

  <div class="pfx-setup-row">
    <label class="pfx-setup-label">Timecode Mode</label>
    <select class="pfx-setup-sel" data-pss="general.timecodeMode" data-pss-handler="timecodeMode" id="pfxGenTcMode">${modeOpts}</select>
  </div>
  <div id="pfxGenDfHint">${dfHint}</div>
</div>`;
}

function _pssHtml_OCR(s) {
  const o = s.ocr;
  const regions = ['bottomCenter','bottomLeft','bottomRight','topLeft','topRight','fullFrame','manual'];
  const regionLabels = { bottomCenter:'Bottom Center', bottomLeft:'Bottom Left', bottomRight:'Bottom Right', topLeft:'Top Left', topRight:'Top Right', fullFrame:'Full Frame', manual:'Manual (Drawn)' };
  const regionOpts = regions.map(r => `<option value="${r}" ${o.defaultRegion===r?'selected':''}>${regionLabels[r]}</option>`).join('');
  const modeOpts = [
    `<option value="vfxShotName" ${o.detectionMode==='vfxShotName'?'selected':''}>VFX Shot Name</option>`,
    `<option value="anyText"     ${o.detectionMode==='anyText'    ?'selected':''}>Any Text</option>`,
  ].join('');
  const confPct = Math.round((o.confidenceThreshold ?? 0.65) * 100);
  return `
<div class="pfx-setup-section" data-section="ocr">
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Auto-OCR on mark
      <span class="pfx-setup-hint pfx-setup-hint--block">Runs OCR on the frame when you add a marker and applies the detected text to the template. Falls back to a confirmation modal only when confidence is low.</span>
    </label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="ocr.enabled" ${o.enabled?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>

  <div class="pfx-setup-group-head">Detection</div>
  <div class="pfx-setup-row">
    <label class="pfx-setup-label">Mode</label>
    <select class="pfx-setup-sel" data-pss="ocr.detectionMode">${modeOpts}</select>
  </div>
  <div class="pfx-setup-row">
    <label class="pfx-setup-label">Default Region</label>
    <select class="pfx-setup-sel" data-pss="ocr.defaultRegion">${regionOpts}</select>
  </div>
  <div class="pfx-setup-row pfx-setup-row--action">
    <label class="pfx-setup-label">Manual Area</label>
    <button class="pfx-setup-action-btn" id="pfxSetupDrawOcr" type="button">Draw Area on Video</button>
    ${o.manualCrop ? `<span class="pfx-setup-hint pfx-setup-hint--ok">Set ✓</span>` : `<span class="pfx-setup-hint">Not set</span>`}
  </div>

  <div class="pfx-setup-group-head">Confidence</div>
  <div class="pfx-setup-row pfx-setup-row--slider">
    <label class="pfx-setup-label">Threshold <span class="pfx-setup-val-lbl" id="pfxOcrConfLbl">${confPct}%</span></label>
    <input type="range" class="pfx-setup-slider" data-pss="ocr.confidenceThreshold" data-pss-scale="0.01" min="0" max="100" value="${confPct}" data-display="pfxOcrConfLbl" data-display-fmt="pct">
  </div>

  <div class="pfx-setup-group-head">Text Cleanup</div>
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Normalize illegal chars</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="ocr.normalizeIllegal" ${o.normalizeIllegal?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Replace spaces with _</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="ocr.replaceSpaces" ${o.replaceSpaces?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Keep spaces (any-text mode)</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="ocr.keepSpaces" ${o.keepSpaces?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Force uppercase</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="ocr.uppercase" ${o.uppercase?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Show OCR overlay</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="ocr.showOverlay" ${o.showOverlay?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>
  <div class="pfx-setup-row">
    <label class="pfx-setup-label">Custom regex filter</label>
    <input type="text" class="pfx-setup-inp" data-pss="ocr.customRegex" placeholder="e.g. ^[A-Z]{2,6}_" value="${_esc(o.customRegex||'')}">
  </div>
</div>`;
}

function _pssHtml_Naming(s) {
  const n = s.naming;
  const seps = [['_','Underscore (_)'],['.',  'Dot (.)'],   ['-','Dash (-)'],['','None']];
  const sepOpts = seps.map(([v,l]) => `<option value="${v}" ${n.separator===v?'selected':''}>${l}</option>`).join('');
  return `
<div class="pfx-setup-section" data-section="naming">
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Auto-update on import</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="naming.autoUpdate" ${n.autoUpdate?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>

  <div class="pfx-setup-group-head">Project Fields</div>
  ${[['show','Show'],['ep','Episode'],['seq','Sequence'],['scene','Scene'],['vendor','Vendor'],['ver','Version']].map(([k,l]) =>
    `<div class="pfx-setup-row">
       <label class="pfx-setup-label">${l}</label>
       <input type="text" class="pfx-setup-inp" data-pss="naming.${k}" placeholder="${l}…" value="${_esc(n[k]||'')}">
     </div>`).join('')}

  <div class="pfx-setup-group-head">Shot Numbering</div>
  <div class="pfx-setup-row">
    <label class="pfx-setup-label">Start number</label>
    <input type="number" class="pfx-setup-inp pfx-setup-inp--sm" data-pss="naming.shotStart" min="0" max="9999" step="1" value="${n.shotStart ?? 1}">
  </div>
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Pad shot numbers</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="naming.padOn" ${n.padOn?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>
  <div class="pfx-setup-row">
    <label class="pfx-setup-label">Pad width</label>
    <input type="number" class="pfx-setup-inp pfx-setup-inp--sm" data-pss="naming.shotPad" min="1" max="8" step="1" value="${n.shotPad ?? 4}">
  </div>

  <div class="pfx-setup-group-head">Format</div>
  <div class="pfx-setup-row">
    <label class="pfx-setup-label">Token separator</label>
    <select class="pfx-setup-sel" data-pss="naming.separator">${sepOpts}</select>
  </div>
</div>`;
}

function _pssHtml_Rules(s) {
  const r = s.rules;
  const conflictOpts = [
    ['ask','Ask each time'],['keep','Keep existing'],['overwrite','Overwrite always']
  ].map(([v,l]) => `<option value="${v}" ${r.conflictMode===v?'selected':''}>${l}</option>`).join('');
  return `
<div class="pfx-setup-section" data-section="rules">
  <div class="pfx-setup-group-head">Automation</div>
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Auto-apply naming on OCR</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="rules.autoApply" ${r.autoApply?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Protect manual overrides</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="rules.keepOverrides" ${r.keepOverrides?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Sync settings across tabs</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="rules.syncTabs" ${r.syncTabs?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>

  <div class="pfx-setup-group-head">Conflict Resolution</div>
  <div class="pfx-setup-row">
    <label class="pfx-setup-label">When shot name conflicts</label>
    <select class="pfx-setup-sel" data-pss="rules.conflictMode">${conflictOpts}</select>
  </div>
</div>`;
}

function _pssHtml_Timeline(s) {
  const t = s.timeline;
  const fmts = [['edl','EDL'],['fcpxml','FCPXML'],['otio','OTIO'],['aaf','AAF'],['ale','ALE']];
  return `
<div class="pfx-setup-section" data-section="timeline">
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Auto-match markers to events</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="timeline.autoMatch" ${t.autoMatch?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>

  <div class="pfx-setup-group-head">Accepted Import Formats</div>
  ${fmts.map(([k,l]) =>
    `<div class="pfx-setup-row pfx-setup-row--toggle">
       <label class="pfx-setup-label">${l}</label>
       <label class="pfx-setup-toggle"><input type="checkbox" data-pss="timeline.formats.${k}" ${t.formats[k]?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
     </div>`).join('')}
</div>`;
}

function _pssHtml_Markers(s) {
  const m = s.markers;
  const priorities = [['low','Low'],['medium','Medium'],['high','High'],['critical','Critical']];
  const prioOpts = priorities.map(([v,l]) => `<option value="${v}" ${m.defaultPriority===v?'selected':''}>${l}</option>`).join('');
  return `
<div class="pfx-setup-section" data-section="markers">
  <div class="pfx-setup-group-head">Defaults</div>
  <div class="pfx-setup-row">
    <label class="pfx-setup-label">Default color</label>
    <input type="color" class="pfx-setup-color" data-pss="markers.defaultColor" value="${_esc(m.defaultColor||'#f5c542')}">
    <span class="pfx-setup-hint">Used for new markers</span>
  </div>
  <div class="pfx-setup-row">
    <label class="pfx-setup-label">Default priority</label>
    <select class="pfx-setup-sel" data-pss="markers.defaultPriority">${prioOpts}</select>
  </div>
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Auto-label from OCR</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="markers.autoLabel" ${m.autoLabel?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>
</div>`;
}

function _pssHtml_Export(s) {
  const x = s.export;
  return `
<div class="pfx-setup-section" data-section="export">
  <div class="pfx-setup-group-head">EXR Naming</div>
  <div class="pfx-setup-row">
    <label class="pfx-setup-label">Template</label>
    <input type="text" class="pfx-setup-inp" data-pss="export.exrNaming" placeholder="{show}_{seq}_{shot}_v{ver}" value="${_esc(x.exrNaming||'')}">
  </div>
  <div class="pfx-setup-hint pfx-setup-hint--block">Tokens: {show} {seq} {shot} {ver} {plate} {scene}</div>

  <div class="pfx-setup-group-head">Output Options</div>
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">AMF export</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="export.amfExport" ${x.amfExport?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">FDL export</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="export.fdlExport" ${x.fdlExport?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>
  <div class="pfx-setup-row pfx-setup-row--toggle">
    <label class="pfx-setup-label">Burn-in enabled by default</label>
    <label class="pfx-setup-toggle"><input type="checkbox" data-pss="export.burninEnabled" ${x.burninEnabled?'checked':''}><span class="pfx-setup-toggle-track"></span></label>
  </div>

  <div class="pfx-setup-group-head">Output Folder</div>
  <div class="pfx-setup-row pfx-setup-row--action">
    <label class="pfx-setup-label">Folder</label>
    <input type="text" class="pfx-setup-inp pfx-setup-inp--path" data-pss="export.outputFolder" placeholder="Default (~/Downloads)" value="${_esc(x.outputFolder||'')}">
    <button class="pfx-setup-action-btn" id="pfxSetupPickFolder" type="button">Browse…</button>
  </div>
</div>`;
}

function _pssHtml_Storage(s) {
  const savedAt = s._savedAt ? new Date(s._savedAt).toLocaleString() : 'Never';
  const hist = Array.isArray(s._history) ? s._history : [];
  const histRows = hist.length
    ? hist.map((h, i) => {
        const dt = h._savedAt ? new Date(h._savedAt).toLocaleString() : '—';
        return `<div class="pfx-setup-hist-row">
          <span class="pfx-setup-hist-time">${dt}</span>
          <button class="pfx-setup-hist-restore" data-hist-idx="${i}" type="button">Restore</button>
        </div>`;
      }).join('')
    : '<div class="pfx-setup-hist-empty">No history yet</div>';

  return `
<div class="pfx-setup-section" data-section="storage">
  <div class="pfx-setup-group-head">Status</div>
  <div class="pfx-setup-kv">
    <span class="pfx-setup-kv-k">IndexedDB</span>
    <span class="pfx-setup-kv-v ${_pssIdbOk?'pfx-setup-kv-v--ok':'pfx-setup-kv-v--warn'}">${_pssIdbOk?'Active':'Unavailable'}</span>
  </div>
  <div class="pfx-setup-kv">
    <span class="pfx-setup-kv-k">chrome.storage</span>
    <span class="pfx-setup-kv-v pfx-setup-kv-v--ok">Fallback ready</span>
  </div>
  <div class="pfx-setup-kv">
    <span class="pfx-setup-kv-k">Last saved</span>
    <span class="pfx-setup-kv-v">${savedAt}</span>
  </div>
  <div class="pfx-setup-kv">
    <span class="pfx-setup-kv-k">Auto-save</span>
    <span class="pfx-setup-kv-v pfx-setup-kv-v--ok">Every 30 s</span>
  </div>

  <div class="pfx-setup-group-head">Version History</div>
  <div class="pfx-setup-hist-list" id="pfxSetupHistList">${histRows}</div>

  <div class="pfx-setup-group-head">Danger Zone</div>
  <div class="pfx-setup-row pfx-setup-row--action">
    <button class="pfx-setup-danger-btn" id="pfxSetupResetAll" type="button">Reset All Settings to Defaults</button>
  </div>
</div>`;
}

function _pssHtml_Resolve(s) {
  const r   = s.resolveEngine || {};
  const ai  = r.aiFeatures   || {};
  const adv = r.advanced      || {};

  // Normalize mode — support both new and legacy values
  const rawMode = r.mode || r.engineMode || '';
  let mode;
  if (rawMode === 'background_auto' || rawMode === 'background' || rawMode === 'auto' || r.launchPolicy === 'on_demand' || r.launchPolicy === 'onDemand') {
    mode = 'background_auto';
  } else if (rawMode === 'assisted' || rawMode === 'visible') {
    mode = 'assisted';
  } else if (rawMode === 'manual_handoff' || rawMode === 'handoff' || rawMode === 'manual' || r.launchPolicy === 'handoff') {
    mode = 'manual_handoff';
  } else if (rawMode === 'disabled' || r.launchPolicy === 'never') {
    mode = 'disabled';
  } else {
    mode = 'background_auto';
  }

  const path        = _esc(r.resolvePath || '');
  const timeout     = r.timeoutSeconds ?? 60;
  const apiTimeout  = adv.apiReadyTimeoutSeconds ?? 90;
  const jobTimeout  = adv.jobTimeoutSeconds ?? 300;

  return `
<div class="pfx-setup-section pfx-re-section" data-section="resolve">

  <div class="pfx-setup-group-head">Resolve Engine</div>
  <label class="pfx-setup-check-row">
    <input type="checkbox" data-pss="resolveEngine.enabled" ${r.enabled ? 'checked' : ''}>
    <span>Enable Resolve Engine automation</span>
  </label>
  <p class="pfx-re-intro-copy">When enabled, PostFlowX starts DaVinci Resolve automatically in the background for VFX Package, Proxy, and EXR exports. You do not need to open Resolve manually.</p>

  <div class="pfx-setup-group-head">Engine Status</div>
  <div class="pfx-re-status-card" id="pfxReStatusCard">
    <div class="pfx-re-status-dot pfx-re-status-dot--idle" id="pfxReStatusDot"></div>
    <div class="pfx-re-status-text">
      <span class="pfx-re-status-label" id="pfxReStatusLabel">${mode === 'background_auto' ? 'Resolve: Auto Mode' : 'Resolve: Not checked'}</span>
      <span class="pfx-re-status-sub"   id="pfxReStatusSub">${mode === 'background_auto' ? 'PostFlowX will start Resolve automatically when a job is queued. Click Check Setup to verify.' : 'Click Check Setup to verify the Resolve connection.'}</span>
    </div>
    <button class="pfx-setup-btn pfx-setup-btn--sm" id="pfxReTestBtn"  type="button">Check Setup</button>
    <button class="pfx-setup-btn pfx-setup-btn--sm" id="pfxReStartBtn" type="button">Start Now</button>
    <button class="pfx-setup-btn pfx-setup-btn--sm" id="pfxReStopBtn"  type="button">Stop</button>
  </div>
  <div class="pfx-re-actions-row">
    <button class="pfx-setup-btn pfx-setup-btn--sm" id="pfxReStatusBtn" type="button">Refresh Status</button>
    <button class="pfx-setup-btn pfx-setup-btn--sm" id="pfxReLogsBtn"   type="button">Show Logs</button>
    <button class="pfx-setup-btn pfx-setup-btn--sm" id="pfxReClearBtn"  type="button">Clear Jobs</button>
    <button class="pfx-setup-btn pfx-setup-btn--sm" id="pfxReInstallBtn" type="button">Get Helper Installer</button>
    <button class="pfx-setup-btn pfx-setup-btn--sm" id="pfxReCopyIdBtn" type="button">Copy Extension ID</button>
  </div>
  <div class="pfx-re-progress-wrap pfx-re-hidden" id="pfxReProgressWrap">
    <div class="pfx-re-progress-bar"><div class="pfx-re-progress-fill" id="pfxReProgressFill" style="width:0%"></div></div>
    <span class="pfx-re-progress-msg" id="pfxReProgressMsg"></span>
  </div>
  <div class="pfx-re-log-box pfx-re-hidden" id="pfxReLogBox"></div>

  <div class="pfx-setup-group-head">Resolve Path</div>
  <div class="pfx-setup-row">
    <input type="text" class="pfx-setup-input pfx-re-path-input" id="pfxRePathInput"
           data-pss="resolveEngine.resolvePath" value="${path}" placeholder="/Applications/DaVinci Resolve/DaVinci Resolve.app">
    <button class="pfx-setup-btn pfx-setup-btn--sm" id="pfxReBrowseBtn" type="button">Browse</button>
  </div>

  <div class="pfx-setup-group-head">Launch Mode</div>
  <div class="pfx-re-mode-group">

    <label class="pfx-re-mode-option${mode === 'background_auto' ? ' pfx-re-mode-option--active' : ''}">
      <input type="radio" name="pfxReEngineMode" value="background_auto" ${mode === 'background_auto' ? 'checked' : ''} data-pss="resolveEngine.mode">
      <span class="pfx-re-mode-label">Background Auto <span class="pfx-re-mode-badge">Recommended</span></span>
      <span class="pfx-re-mode-desc">PostFlowX starts Resolve automatically in the background when needed. Resolve window stays hidden. No manual steps required.</span>
    </label>

    <label class="pfx-re-mode-option${mode === 'assisted' ? ' pfx-re-mode-option--active' : ''}">
      <input type="radio" name="pfxReEngineMode" value="assisted" ${mode === 'assisted' ? 'checked' : ''} data-pss="resolveEngine.mode">
      <span class="pfx-re-mode-label">Assisted</span>
      <span class="pfx-re-mode-desc">PostFlowX opens Resolve visibly. You can see it running. Jobs start once the scripting API is ready.</span>
    </label>

    <label class="pfx-re-mode-option${mode === 'manual_handoff' ? ' pfx-re-mode-option--active' : ''}">
      <input type="radio" name="pfxReEngineMode" value="manual_handoff" ${mode === 'manual_handoff' ? 'checked' : ''} data-pss="resolveEngine.mode">
      <span class="pfx-re-mode-label">Manual Handoff</span>
      <span class="pfx-re-mode-desc">PostFlowX creates a handoff package. You open Resolve and render it yourself. No automation.</span>
    </label>

    <label class="pfx-re-mode-option${mode === 'disabled' ? ' pfx-re-mode-option--active' : ''}">
      <input type="radio" name="pfxReEngineMode" value="disabled" ${mode === 'disabled' ? 'checked' : ''} data-pss="resolveEngine.mode">
      <span class="pfx-re-mode-label">Disabled</span>
      <span class="pfx-re-mode-desc">Resolve Engine is off. Resolve-dependent jobs will be skipped or exported as metadata only.</span>
    </label>

  </div>

  <div class="pfx-setup-group-head pfx-re-bg-options-head" id="pfxReBgOptionsHead">Background Options</div>
  <div class="pfx-setup-check-group" id="pfxReBgOptions">
    <label class="pfx-setup-check-row">
      <input type="checkbox" data-pss="resolveEngine.minimizeOnLaunch" ${r.minimizeOnLaunch !== false ? 'checked' : ''}>
      <span>Minimize / hide Resolve window on launch</span>
    </label>
    <label class="pfx-setup-check-row">
      <input type="checkbox" data-pss="resolveEngine.reuseRunningResolve" ${r.reuseRunningResolve !== false ? 'checked' : ''}>
      <span>Reuse already-open Resolve session</span>
    </label>
    <label class="pfx-setup-check-row">
      <input type="checkbox" data-pss="resolveEngine.cleanupTempProjects" ${r.cleanupTempProjects !== false ? 'checked' : ''}>
      <span>Delete temporary Resolve projects after export</span>
    </label>
    <label class="pfx-setup-check-row">
      <input type="checkbox" data-pss="resolveEngine.quitAfterQueueComplete" ${r.quitAfterQueueComplete ? 'checked' : ''}>
      <span>Quit Resolve when render queue empties</span>
    </label>
  </div>

  <div class="pfx-setup-group-head">Use Resolve For</div>
  <div class="pfx-setup-check-group">
    <label class="pfx-setup-check-row">
      <input type="checkbox" data-pss="resolveEngine.useForProxy" ${r.useForProxy ? 'checked' : ''}>
      <span>ProRes / OCF proxy generation</span>
    </label>
    <label class="pfx-setup-check-row">
      <input type="checkbox" data-pss="resolveEngine.useForPlates" ${r.useForPlates ? 'checked' : ''}>
      <span>EXR / DPX plate export</span>
    </label>
    <label class="pfx-setup-check-row">
      <input type="checkbox" data-pss="resolveEngine.useForTrailerConform" ${r.useForTrailerConform ? 'checked' : ''}>
      <span>Trailer conform</span>
    </label>
    <label class="pfx-setup-check-row">
      <input type="checkbox" data-pss="resolveEngine.useForAmf" ${r.useForAmf ? 'checked' : ''}>
      <span>AMF sidecar export</span>
    </label>
    <label class="pfx-setup-check-row">
      <input type="checkbox" data-pss="resolveEngine.useForTimelineValidation" ${r.useForTimelineValidation ? 'checked' : ''}>
      <span>XML / EDL / AAF validation</span>
    </label>
    <label class="pfx-setup-check-row">
      <input type="checkbox" data-pss="resolveEngine.useForReferenceMovie" ${r.useForReferenceMovie ? 'checked' : ''}>
      <span>Reference movie export</span>
    </label>
  </div>

  <details class="pfx-re-advanced" id="pfxReAdvancedDetails">
  <summary>Advanced settings</summary>

  <div class="pfx-setup-kv">
    <span class="pfx-setup-kv-k">API ready timeout (s)</span>
    <input type="number" class="pfx-setup-input pfx-setup-input--sm" min="10" max="300" step="10"
           data-pss="resolveEngine.advanced.apiReadyTimeoutSeconds" value="${apiTimeout}">
    <span class="pfx-setup-kv-hint">How long to wait for Resolve scripting API after launch.</span>
  </div>
  <div class="pfx-setup-kv">
    <span class="pfx-setup-kv-k">Job timeout (s)</span>
    <input type="number" class="pfx-setup-input pfx-setup-input--sm" min="60" max="3600" step="30"
           data-pss="resolveEngine.advanced.jobTimeoutSeconds" value="${jobTimeout}">
  </div>
  <div class="pfx-setup-kv">
    <span class="pfx-setup-kv-k">Debug mode</span>
    <input type="checkbox" data-pss="resolveEngine.advanced.debugMode" ${adv.debugMode ? 'checked' : ''}>
    <span class="pfx-setup-kv-hint">Save helper logs and result JSON into each Resolve job folder.</span>
  </div>

  <div class="pfx-setup-group-head">AI Features (beta)</div>
  <div class="pfx-setup-check-group">
    <label class="pfx-setup-check-row">
      <input type="checkbox" data-pss="resolveEngine.aiFeatures.transcription" ${ai.transcription ? 'checked' : ''}>
      <span>AI Transcription</span>
    </label>
    <label class="pfx-setup-check-row">
      <input type="checkbox" data-pss="resolveEngine.aiFeatures.peopleAnalysis" ${ai.peopleAnalysis ? 'checked' : ''}>
      <span>People Analysis</span>
    </label>
    <label class="pfx-setup-check-row">
      <input type="checkbox" data-pss="resolveEngine.aiFeatures.smartReframe" ${ai.smartReframe ? 'checked' : ''}>
      <span>Smart Reframe</span>
    </label>
  </div>

  </details>

</div>`;
}

// ── Section tab definitions ───────────────────────────────────────────────────
const _PSS_TABS = [
  { id: 'general',   label: 'General',         icon: _svgGeneral() },
  { id: 'ocr',       label: 'OCR Setup',       icon: _svgOcr() },
  { id: 'naming',    label: 'Naming',          icon: _svgNaming() },
  { id: 'rules',     label: 'Project Rules',   icon: _svgRules() },
  { id: 'timeline',  label: 'Timeline',        icon: _svgTimeline() },
  { id: 'markers',   label: 'Markers',         icon: _svgMarkers() },
  { id: 'export',    label: 'Export',          icon: _svgExport() },
  { id: 'storage',   label: 'Storage',         icon: _svgStorage() },
  { id: 'resolve',   label: 'Resolve Engine',  icon: _svgResolve() },
];

function _svgGeneral()  { return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="7" cy="7" r="5"/><line x1="7" y1="5" x2="7" y2="7.5"/><circle cx="7" cy="9.5" r=".6" fill="currentColor" stroke="none"/></svg>`; }
function _svgOcr()      { return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1" y="2" width="12" height="10" rx="1.5"/><line x1="4" y1="6" x2="10" y2="6"/><line x1="4" y1="9" x2="7" y2="9"/></svg>`; }
function _svgNaming()   { return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 11l1.5-1.5L11 3 12 4 5.5 10.5z"/><line x1="2" y1="12" x2="5" y2="12"/></svg>`; }
function _svgRules()    { return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="7" cy="7" r="2"/><path d="M7 1v2M7 11v2M1 7h2M11 7h2M3.22 3.22l1.41 1.41M9.37 9.37l1.41 1.41M3.22 10.78l1.41-1.41M9.37 4.63l1.41-1.41"/></svg>`; }
function _svgTimeline() { return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1" y="4" width="12" height="6" rx="1"/><line x1="4" y1="4" x2="4" y2="10"/><line x1="8" y1="4" x2="8" y2="10"/></svg>`; }
function _svgMarkers()  { return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M7 2l1.5 3h3l-2.5 2 1 3L7 8.5 4 10l1-3L2.5 5h3z"/></svg>`; }
function _svgExport()   { return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M7 1v8M4 5l3-4 3 4"/><path d="M2 10v2h10v-2"/></svg>`; }
function _svgStorage()  { return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="1" y="2" width="12" height="4" rx="1"/><rect x="1" y="8" width="12" height="4" rx="1"/><circle cx="11" cy="4" r=".8" fill="currentColor" stroke="none"/><circle cx="11" cy="10" r=".8" fill="currentColor" stroke="none"/></svg>`; }
function _svgResolve()  { return `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="7" cy="7" r="5"/><path d="M5 5l4 2-4 2V5z" fill="currentColor" stroke="none"/></svg>`; }

// ── Panel HTML ────────────────────────────────────────────────────────────────
function _pssBuildPanel(s) {
  const tabsHtml = _PSS_TABS.map(t =>
    `<button class="pfx-setup-tab${_pssActiveTab===t.id?' pfx-setup-tab--active':''}" data-tab="${t.id}" type="button" title="${t.label}">
       <span class="pfx-setup-tab-icon">${t.icon}</span>
       <span class="pfx-setup-tab-lbl">${t.label}</span>
     </button>`
  ).join('');

  const sectionHtml = _pssRenderSection(_pssActiveTab, s);

  return `
<div class="pfx-setup-overlay" id="pfxSetupOverlay">
  <div class="pfx-setup-panel" id="pfxSetupPanel" role="dialog" aria-label="Project Setup">
    <div class="pfx-setup-head">
      <span class="pfx-setup-title">Project Setup</span>
      <div class="pfx-setup-statusbar" id="pfxSetupStatusBar"></div>
      <button class="pfx-setup-close" id="pfxSetupClose" type="button" aria-label="Close">&#x2715;</button>
    </div>
    <div class="pfx-setup-body">
      <nav class="pfx-setup-tabs">${tabsHtml}</nav>
      <div class="pfx-setup-content" id="pfxSetupContent">${sectionHtml}</div>
    </div>
    <div class="pfx-setup-foot">
      <button class="pfx-setup-foot-btn pfx-setup-foot-btn--ghost" id="pfxSetupCancel" type="button">Cancel</button>
      <button class="pfx-setup-foot-btn pfx-setup-foot-btn--sec"   id="pfxSetupApplyBtn" type="button">Apply to Markers</button>
      <button class="pfx-setup-foot-btn pfx-setup-foot-btn--pri"   id="pfxSetupSaveBtn" type="button">Save Settings</button>
    </div>
  </div>
</div>`;
}

function _pssRenderSection(tabId, s) {
  switch (tabId) {
    case 'general':  return _pssHtml_General(s);
    case 'ocr':      return _pssHtml_OCR(s);
    case 'naming':   return _pssHtml_Naming(s);
    case 'rules':    return _pssHtml_Rules(s);
    case 'timeline': return _pssHtml_Timeline(s);
    case 'markers':  return _pssHtml_Markers(s);
    case 'export':   return _pssHtml_Export(s);
    case 'storage':  return _pssHtml_Storage(s);
    case 'resolve':  return _pssHtml_Resolve(s);
    default: return '';
  }
}

function _pssRepaintActiveSection() {
  if (!_pssEl || !_pssSettings) return;
  const content = _pssEl.querySelector('#pfxSetupContent');
  if (content) content.innerHTML = _pssRenderSection(_pssActiveTab, _pssSettings);
  _pssWireSection(content);
}

function _pssRefreshPersistenceSection() {
  if (_pssActiveTab !== 'storage') return;
  _pssRepaintActiveSection();
}

// ── Utility ───────────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Set a nested property by dot-path ─────────────────────────────────────────
function _pssSetPath(obj, path, val) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

function _pssGetPath(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

// ── Frame rate / timecode mode helpers ────────────────────────────────────────
function _pssApplyFrameRateChange(fps) {
  if (!_pssSettings) return;
  if (!_pssSettings.general) _pssSettings.general = {};
  const entry = _PSS_FPS_PRESETS.find(e => Math.abs(e.fps - fps) < 0.02)
    || { fps, numerator: Math.round(fps * 1001), denominator: 1001, dfCapable: false };
  _pssSettings.general.frameRate      = entry.fps;
  _pssSettings.general.frameRateExact = { numerator: entry.numerator, denominator: entry.denominator };
  // If drop-frame mode was set but is no longer valid: reset to auto
  if (!entry.dfCapable && _pssSettings.general.timecodeMode === 'drop') {
    _pssSettings.general.timecodeMode = 'auto';
  }
  _pssSettings.general.dropFrame = entry.dfCapable && _pssSettings.general.timecodeMode === 'drop';
  _pssMarkDirty();
  _pssUpdateHeaderDot();
  _pssRepaintActiveSection();
  _pssBroadcastFpsChange();
}

function _pssApplyTimecodeModeChange(mode) {
  if (!_pssSettings) return;
  if (!_pssSettings.general) _pssSettings.general = {};
  const fps = _pssSettings.general.frameRate || 23.976;
  const dfCapable = _PSS_FPS_PRESETS.find(e => Math.abs(e.fps - fps) < 0.02)?.dfCapable || false;
  if (mode === 'drop' && !dfCapable) mode = 'auto'; // guard
  _pssSettings.general.timecodeMode = mode;
  _pssSettings.general.dropFrame    = dfCapable && mode === 'drop';
  _pssMarkDirty();
  _pssUpdateHeaderDot();
  _pssRepaintActiveSection();
  _pssBroadcastFpsChange();
}

function _pssBroadcastFpsChange() {
  try {
    window.dispatchEvent(new CustomEvent('pfx:projectFrameRateChanged', {
      detail: { settings: _pssSettings?.general }
    }));
  } catch {}
}

// ── Wire all [data-pss] inputs in a container ─────────────────────────────────
function _pssWireSection(container) {
  if (!container) return;

  // Checkboxes
  container.querySelectorAll('input[type=checkbox][data-pss]').forEach(el => {
    el.addEventListener('change', () => {
      _pssSetPath(_pssSettings, el.dataset.pss, el.checked);
      _pssMarkDirty();
      _pssUpdateStatusBar();
      _pssUpdateHeaderDot();
    });
  });

  // Text/number inputs
  container.querySelectorAll('input[type=text][data-pss], input[type=number][data-pss]').forEach(el => {
    el.addEventListener('input', () => {
      const raw = el.type === 'number' ? (parseFloat(el.value) || 0) : el.value;
      _pssSetPath(_pssSettings, el.dataset.pss, raw);
      _pssMarkDirty();
      _pssUpdateHeaderDot();
    });
  });

  // Color inputs
  container.querySelectorAll('input[type=color][data-pss]').forEach(el => {
    el.addEventListener('input', () => {
      _pssSetPath(_pssSettings, el.dataset.pss, el.value);
      _pssMarkDirty();
      _pssUpdateHeaderDot();
    });
  });

  // Selects
  container.querySelectorAll('select[data-pss]').forEach(el => {
    el.addEventListener('change', () => {
      const handler = el.dataset.pssHandler;
      if (handler === 'frameRate') {
        _pssApplyFrameRateChange(parseFloat(el.value) || 23.976);
        return;
      }
      if (handler === 'timecodeMode') {
        _pssApplyTimecodeModeChange(el.value);
        return;
      }
      _pssSetPath(_pssSettings, el.dataset.pss, el.value);
      _pssMarkDirty();
      _pssUpdateHeaderDot();
    });
  });

  // Range sliders
  container.querySelectorAll('input[type=range][data-pss]').forEach(el => {
    el.addEventListener('input', () => {
      const scale = parseFloat(el.dataset.pssScale ?? 1);
      const raw   = parseFloat(el.value) * scale;
      _pssSetPath(_pssSettings, el.dataset.pss, raw);
      // Update linked display label
      const lbl = el.dataset.display ? document.getElementById(el.dataset.display) : null;
      if (lbl) {
        const fmt = el.dataset.displayFmt;
        lbl.textContent = fmt === 'pct' ? `${Math.round(parseFloat(el.value))}%` : el.value;
      }
      _pssMarkDirty();
      _pssUpdateHeaderDot();
    });
  });

  // Action buttons
  const drawBtn = container.querySelector('#pfxSetupDrawOcr');
  if (drawBtn) {
    drawBtn.addEventListener('click', () => {
      // Delegate to prep_mark's OCR crop mode if available
      if (typeof window.__pfxEnterOcrCropMode === 'function') {
        closeProjectSetup();
        window.__pfxEnterOcrCropMode(null);
      } else {
        _pssToast('Open a video in Pull Prep first, then use "Set OCR Area" on a marker.');
      }
    });
  }

  const pickFolderBtn = container.querySelector('#pfxSetupPickFolder');
  if (pickFolderBtn) {
    pickFolderBtn.addEventListener('click', async () => {
      try {
        const { nativePickOcfFolder } = await import('./native_helper_client.js');
        const res = await nativePickOcfFolder();
        const folder = res?.path || res?.folder || '';
        if (folder) {
          _pssSettings.export.outputFolder = folder;
          const inp = container.querySelector('[data-pss="export.outputFolder"]');
          if (inp) inp.value = folder;
          _pssMarkDirty();
        }
      } catch { _pssToast('Native helper not available — type the path manually.'); }
    });
  }

  // History restore buttons
  container.querySelectorAll('[data-hist-idx]').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.histIdx, 10);
      const hist = _pssSettings._history || [];
      const entry = hist[idx];
      if (!entry?._snap) return;
      try {
        const snap = JSON.parse(entry._snap);
        _pssSettings = _pssMerge(_pssDefaults(), snap);
        _pssMarkDirty();
        _pssRepaintActiveSection();
        _pssToast('Settings restored from history.');
      } catch { _pssToast('Could not restore — snapshot corrupted.', true); }
    });
  });

  // Reset all
  const resetBtn = container.querySelector('#pfxSetupResetAll');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (!confirm('Reset ALL project settings to defaults? This cannot be undone.')) return;
      _pssSettings = _pssDefaults();
      _pssMarkDirty();
      _pssRepaintActiveSection();
      _pssToast('Settings reset to defaults.');
    });
  }

  // ── Resolve Engine section wiring ──────────────────────────────────────────
  const reSection = container.querySelector('[data-section="resolve"]');
  if (!reSection) return;

  function _reSetStatus(state, label, sub) {
    const dot = reSection.querySelector('#pfxReStatusDot');
    const lbl = reSection.querySelector('#pfxReStatusLabel');
    const subEl = reSection.querySelector('#pfxReStatusSub');
    if (dot) { dot.className = `pfx-re-status-dot pfx-re-status-dot--${state}`; }
    if (lbl) lbl.textContent = label;
    if (subEl) subEl.textContent = sub || '';
  }

  // Hydrate from cached auto-connect status if present.
  const cached = (typeof window !== 'undefined') ? window.PFX_RESOLVE_STATUS : null;
  if (cached && cached.state) {
    _reSetStatus(cached.state === 'checking' ? 'busy' : cached.state, cached.label || '', cached.sub || '');
  }

  // Subscribe to live status updates while this section is mounted.
  const _onResolveStatus = (e) => {
    const s = e?.detail; if (!s) return;
    _reSetStatus(s.state === 'checking' ? 'busy' : s.state, s.label || '', s.sub || '');
  };
  document.addEventListener('pfx:resolve-status', _onResolveStatus);
  reSection.addEventListener('pfx-detach', () => {
    document.removeEventListener('pfx:resolve-status', _onResolveStatus);
  }, { once: true });

  function _reSetProgress(pct, msg) {
    const wrap = reSection.querySelector('#pfxReProgressWrap');
    const fill = reSection.querySelector('#pfxReProgressFill');
    const msgEl = reSection.querySelector('#pfxReProgressMsg');
    if (!wrap) return;
    if (pct === null) { wrap.classList.add('pfx-re-hidden'); return; }
    wrap.classList.remove('pfx-re-hidden');
    if (fill) fill.style.width = `${pct}%`;
    if (msgEl) msgEl.textContent = msg || '';
  }

  function _reAppendLog(msg, isErr = false) {
    const box = reSection.querySelector('#pfxReLogBox');
    if (!box) return;
    box.classList.remove('pfx-re-hidden');
    const line = document.createElement('div');
    line.className = 'pfx-re-log-line' + (isErr ? ' pfx-re-log-line--err' : '');
    line.textContent = msg;
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  }

  function _reClearLog() {
    const box = reSection.querySelector('#pfxReLogBox');
    if (box) { box.innerHTML = ''; box.classList.add('pfx-re-hidden'); }
  }

  function _reSetSimpleMode({ toast = true } = {}) {
    _pssSettings.resolveEngine = {
      ...(_pssSettings.resolveEngine || {}),
      enabled: false,
      mode: 'disabled',
      launchPolicy: 'never',
      useForProxy: false,
      useForTrailerConform: false,
      useForPlates: false,
      useForAmf: false,
      useForTimelineValidation: false,
      useForReferenceMovie: false,
    };
    _reBroadcastStatus('idle', 'Simple Mode active', 'PostFlowX IMF Validation works without Resolve.');
    _reClearLog();
    _reAppendLog('Simple Mode is active. No Resolve setup is required for standard IMF Validation.');
    _reAppendLog('Get Easy Helper Installer only when you need automatic Resolve-assisted background jobs.');
    _pssMarkDirty();
    _pssUpdateHeaderDot();
    if (toast) _pssToast('Simple Mode enabled. Resolve automation is optional.');
  }

  async function _reDownloadOrShowInstaller() {
    try {
      const url = chrome.runtime.getURL('installer/Install_PostFlowX_Helper.command.template');
      let body = await fetch(url).then(r => r.text());
      const extId = chrome.runtime?.id || 'AUTO';
      body = body.replaceAll('__PFX_EXTENSION_ID__', extId);
      const blob = new Blob([body], { type: 'text/plain' });
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = 'Install_PostFlowX_Helper.command';
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { try { URL.revokeObjectURL(objectUrl); a.remove(); } catch {} }, 1000);
      _reClearLog();
      _reAppendLog('Installer downloaded to your Downloads folder.');
      _reAppendLog('Open Downloads, right-click Install_PostFlowX_Helper.command, choose Open, then wait for Installation complete.');
      _reAppendLog('Then reload PostFlowX in chrome://extensions and click Check Setup.');
      _pssToast('Helper installer downloaded.');
      return;
    } catch (err) {
      _reAppendLog('Could not download the helper installer from this build. Use Install_PostFlowX_Helper.command in the unzipped PostFlowX folder.', true);
    }

    const macBtn = document.getElementById('nhFullMacBtn');
    const winBtn = document.getElementById('nhFullWinBtn');
    const ua = String(navigator.userAgent || '').toLowerCase();
    const target = /windows|win32|win64/.test(ua) ? winBtn : macBtn;
    if (target) {
      target.click();
      _pssToast('Helper installer downloaded. Run it, quit Chrome completely, then reopen PostFlowX.');
      return;
    }
    _pssToast('Use Install_PostFlowX_Helper.command in the unzipped PostFlowX folder.', true);
  }

  const IS_DESKTOP = !!(window.__PFX_IS_ELECTRON || window.pfxPlatform?.isMacApp);

  const installBtn = reSection.querySelector('#pfxReInstallBtn');
  if (installBtn) {
    if (IS_DESKTOP) {
      installBtn.style.display = 'none';
    } else {
      installBtn.addEventListener('click', _reDownloadOrShowInstaller);
    }
  }

  const copyIdBtn = reSection.querySelector('#pfxReCopyIdBtn');
  if (copyIdBtn) {
    if (IS_DESKTOP) {
      copyIdBtn.style.display = 'none';
    } else {
      copyIdBtn.addEventListener('click', async () => {
        const id = (typeof chrome !== 'undefined' && chrome.runtime?.id) ? chrome.runtime.id : '';
        if (!id) { _pssToast('Extension ID is not available in this context.', true); return; }
        try {
          await navigator.clipboard.writeText(id);
          _pssToast('Extension ID copied.');
          _reAppendLog(`Extension ID: ${id}`);
        } catch {
          _reAppendLog(`Extension ID: ${id}`);
          _pssToast('Could not copy automatically. The ID is shown in the log.', true);
        }
      });
    }
  }

  // Show/hide Background Options based on selected mode
  function _reUpdateBgOptionsVisibility() {
    const checked = reSection.querySelector('input[name="pfxReEngineMode"]:checked');
    const m = checked ? checked.value : 'background_auto';
    const show = (m === 'background_auto' || m === 'assisted');
    const head = reSection.querySelector('#pfxReBgOptionsHead');
    const body = reSection.querySelector('#pfxReBgOptions');
    if (head) head.style.display = show ? '' : 'none';
    if (body) body.style.display = show ? '' : 'none';
    // Highlight active mode card
    reSection.querySelectorAll('.pfx-re-mode-option').forEach(opt => {
      const radio = opt.querySelector('input[type=radio]');
      opt.classList.toggle('pfx-re-mode-option--active', !!(radio && radio.checked));
    });
  }

  // Radio buttons for engine mode
  reSection.querySelectorAll('input[type=radio][data-pss]').forEach(el => {
    el.addEventListener('change', () => {
      if (el.checked) {
        _pssSetPath(_pssSettings, el.dataset.pss, el.value);
        _pssMarkDirty();
        _pssUpdateHeaderDot();
        _reUpdateBgOptionsVisibility();
      }
    });
  });

  // Set initial visibility on render
  _reUpdateBgOptionsVisibility();

  // Normalize _pssSettings.resolveEngine.mode to match what the HTML rendered.
  // The HTML renderer normalizes old values (e.g. 'background' → 'background_auto',
  // 'handoff' → 'manual_handoff') for display, but doesn't update the in-memory
  // object. Without this, render_queue.js reads the stale old mode value.
  (function _reNormalizeModeInMemory() {
    const checked = reSection.querySelector('input[name="pfxReEngineMode"]:checked');
    if (!checked) return;
    const displayed = checked.value;
    const stored    = _pssSettings.resolveEngine?.mode || '';
    if (stored !== displayed) {
      _pssSetPath(_pssSettings, 'resolveEngine.mode', displayed);
      _pssSetPath(_pssSettings, 'resolveEngine.launchPolicy',
        displayed === 'background_auto' ? 'on_demand' :
        displayed === 'disabled'        ? 'never'     :
        displayed === 'manual_handoff'  ? 'handoff'   : 'manual');
      _pssMarkDirty();
    }
  })();

  // Publish the resolved engine policy globally so job submitters
  // (native_helper_client → nativeResolveRunJob) can attach launchPolicy/runMode
  // to each job. This is what lets the companion auto-launch Resolve in the
  // background on demand (Gap 1) instead of failing when Resolve isn't open.
  _rePublishEngineConfig();

  // Auto Detect button removed — Resolve is fully manual. Use Browse Resolve
  // Path to pick the binary, then Test Connection (Resolve must be open).

  function _reIsOldHelperError(msg = '') {
    return /unknown action|not supported by this build|that action is not supported/i.test(String(msg || ''));
  }

  function _reFriendlySetupMessage(err) {
    const IS_DESKTOP_CTX = !!(window.__PFX_IS_ELECTRON || window.pfxPlatform?.isMacApp);
    const msg = String(err?.userMessage || err?.message || err || '');
    if (_reIsOldHelperError(msg)) {
      return IS_DESKTOP_CTX
        ? 'The Resolve scripting module is not available. Reinstall DaVinci Resolve to restore it.'
        : 'The PostFlowX Helper is installed but too old. Click Get Easy Helper Installer, run it, then quit and reopen Chrome.';
    }
    if (/host_unavailable|not installed|native host|specified native messaging host not found|companion host unavailable/i.test(msg)) {
      return IS_DESKTOP_CTX
        ? 'The PostFlowX companion is not running. Ensure the companion Python package is installed, then relaunch the app.'
        : 'The PostFlowX Helper is not installed yet. Click Get Easy Helper Installer, run it, then quit and reopen Chrome.';
    }
    if (/timeout/i.test(msg)) {
      return IS_DESKTOP_CTX
        ? 'The companion did not respond in time. Check that Python 3.10+ is installed, then relaunch PostFlowX.'
        : 'The Helper did not answer in time. Run the Easy Helper Installer again, then quit and reopen Chrome.';
    }
    return msg || 'Resolve Assist is optional. Standard IMF Validation can continue.';
  }

  // Check Setup button — passive, no Resolve launch, no GUI requirement.
  const testBtn = reSection.querySelector('#pfxReTestBtn');
  if (testBtn) {
    testBtn.addEventListener('click', async () => {
      _reClearLog();
      _reBroadcastStatus('checking', 'Checking setup…', 'Checking Helper and Resolve installation…');
      testBtn.disabled = true;
      try {
        const helper = await import('./native_helper_client.js');
        let info = {};
        try {
          const det = await helper.nativeResolveDetect();
          info = det?.result || det?.data || {};
        } catch (detErr) {
          const msg = _reFriendlySetupMessage(detErr);
          _reBroadcastStatus('idle', 'Simple Mode active', msg);
          _reAppendLog(msg, _reIsOldHelperError(msg));
          _reAppendLog('Standard IMF Validation does not need Resolve or the Helper.');
          return;
        }

        if (!info.found) {
          _reBroadcastStatus('idle', 'Resolve optional', 'DaVinci Resolve was not found. PostFlowX IMF Validation can continue.');
          _reAppendLog('DaVinci Resolve was not found. This is OK for normal IMF Validation.');
          _reAppendLog('Install Resolve only if you want optional Resolve-assisted playback/automation checks.');
          return;
        }

        if (info.resolvePath || info.resolvedPath || info.path) {
          const detectedPath = info.resolvePath || info.resolvedPath || info.path;
          _reAppendLog(`Resolve path: ${detectedPath}`);
          if (!_pssSettings.resolveEngine?.resolvePath) {
            _pssSetPath(_pssSettings, 'resolveEngine.resolvePath', detectedPath);
            const inp = reSection.querySelector('#pfxRePathInput');
            if (inp) inp.value = detectedPath;
            _pssMarkDirty();
          }
        }
        if (info.version) _reAppendLog(`Resolve version: ${info.version}`);
        _reAppendLog(`Scripting files: ${info.scriptingAvailable ? 'found' : 'not found'}`);

        if (!info.scriptingAvailable) {
          const isAuto = _reCurrentMode() === 'background_auto' || _reCurrentMode() === 'assisted';
          _reBroadcastStatus('warn', 'Scripting Not Available',
            isAuto ? 'Resolve is installed but scripting API files are missing — reinstall DaVinci Resolve to restore them.'
                   : 'Resolve is installed but scripting support is not available.');
          _reAppendLog('Resolve scripting API files not found.', true);
          _reAppendLog('Reinstall DaVinci Resolve (free) to restore the scripting module. Background Auto requires the scripting API.');
          return;
        }

        let status = {};
        try {
          const st = await helper.nativeResolveEngineStatus(info.resolvePath || info.resolvedPath || info.path || _rePathForEngine());
          status = st?.result || st?.data || {};
        } catch (statusErr) {
          const msg = _reFriendlySetupMessage(statusErr);
          _reBroadcastStatus('warn', 'Helper update needed', msg);
          _reAppendLog(msg, true);
          return;
        }

        if (status.connected || status.apiAvailable) {
          _reApplyEngineStatus(status);
          _reAppendLog('Resolve scripting API is connected and ready.');
        } else {
          const isAutoMode = _reCurrentMode() === 'background_auto' || _reCurrentMode() === 'assisted';
          _reApplyEngineStatus({ ...status, found: true, scriptingAvailable: true });
          if (isAutoMode) {
            _reAppendLog('Setup complete. PostFlowX will launch Resolve in the background automatically when a job is queued.');
            _reAppendLog('No manual steps required.');
          } else {
            _reAppendLog('Resolve is installed. Switch to Background Auto mode for fully automatic background launches.');
          }
        }
      } catch (e) {
        const msg = _reFriendlySetupMessage(e);
        _reBroadcastStatus('idle', 'Simple Mode active', msg);
        _reAppendLog(msg, _reIsOldHelperError(msg));
        _reAppendLog('Standard IMF Validation can continue without Resolve Assist.');
      } finally {
        testBtn.disabled = false;
      }
    });
  }


  function _reModeForEngine() {
    const raw = _pssSettings.resolveEngine?.mode || _pssSettings.resolveEngine?.runMode || '';
    if (raw === 'background_auto' || raw === 'background' || raw === 'auto') return 'background';
    if (raw === 'assisted'        || raw === 'visible')                       return 'attachVisible';
    if (raw === 'manual_handoff'  || raw === 'handoff' || raw === 'manual')   return 'handoff';
    if (raw === 'disabled')                                                   return 'disabled';
    return 'background';
  }

  function _rePathForEngine() {
    return _pssSettings.resolveEngine?.resolvePath || _pssSettings.resolveEngine?.resolveExecutablePath || '';
  }

  // Publish { mode, launchPolicy, runMode, path } to window.PFX_RESOLVE_ENGINE so
  // job submitters can stamp each Resolve job with the user's launch preference.
  function _rePublishEngineConfig() {
    try {
      const re = _pssSettings.resolveEngine || {};
      const mode = re.mode || re.runMode || 'background_auto';
      const launchPolicy = re.launchPolicy || (
        mode === 'manual_handoff' || mode === 'handoff' ? 'handoff' :
        mode === 'disabled'                             ? 'never'   : 'on_demand');
      const runMode =
        (mode === 'assisted' || mode === 'visible')          ? 'attachVisible' :
        (mode === 'manual_handoff' || mode === 'handoff')    ? 'handoff'       : 'background';
      window.PFX_RESOLVE_ENGINE = {
        mode, launchPolicy, runMode,
        path: re.resolvePath || re.resolveExecutablePath || '',
      };
    } catch (_) {}
  }

  function _reApplyEngineStatus(data = {}) {
    const connected  = !!(data.connected || data.apiAvailable);
    const compat     = !!data.compatMode || data.engineSupported === false;
    const found      = data.found !== false && !!(data.resolvePath || data.resolvedPath || data.version || connected);
    const curMode    = _reCurrentMode();
    const isAutoMode = curMode === 'background_auto' || curMode === 'assisted';
    const ver        = data.version ? `v${data.version}` : '';

    const state = connected ? 'connected' : (compat ? 'warn' : 'idle');
    const label = connected  ? 'Resolve: Connected'
                : compat     ? 'Helper needs update'
                : found && isAutoMode ? 'Resolve: Ready for Auto-Launch'
                : found      ? 'Resolve: Installed'
                :              'Resolve: Not Found';

    let sub;
    if (connected) {
      sub = `${ver}${ver ? ' · ' : ''}Connected${data.currentProject ? ` · ${data.currentProject}` : ''}`;
    } else if (compat) {
      sub = data.userMessage || data.message || 'Resolve found but helper is outdated — update the Helper.';
    } else if (found && isAutoMode) {
      sub = `${ver}${ver ? ' · ' : ''}Ready — PostFlowX will start Resolve automatically when a job is queued.`;
    } else if (found) {
      sub = `${ver}${ver ? ' · ' : ''}Resolve is installed. Switch to Background Auto mode for full automation.`;
    } else {
      sub = 'Resolve not found. Set the path in Resolve Path below.';
    }

    _reBroadcastStatus(state, label, sub, data);
    if (data.resolvePath || data.resolvedPath) _reAppendLog(`Path: ${data.resolvePath || data.resolvedPath}`);
    if (data.version)   _reAppendLog(`Version: ${data.version}`);
    if (typeof data.scriptingAvailable === 'boolean') _reAppendLog(`Scripting API files: ${data.scriptingAvailable ? 'found' : 'not found'}`);
    if (typeof data.running === 'boolean') _reAppendLog(`Resolve running: ${data.running ? 'Yes' : 'No'}`);
    if (found && !connected && isAutoMode) _reAppendLog('Background Auto mode: PostFlowX will launch Resolve automatically when a job needs it.');
    if (typeof data.queueDepth === 'number' && !compat) _reAppendLog(`Queue depth: ${data.queueDepth}`);
    if (compat) {
      const IS_DESKTOP_CTX = !!(window.__PFX_IS_ELECTRON || window.pfxPlatform?.isMacApp);
      _reAppendLog(IS_DESKTOP_CTX
        ? 'Resolve scripting module not available. Reinstall DaVinci Resolve to restore it.'
        : 'Helper is outdated. Run Get Helper Installer then quit and reopen Chrome.', true);
    }
  }

  const statusBtn = reSection.querySelector('#pfxReStatusBtn');
  if (statusBtn) {
    statusBtn.addEventListener('click', async () => {
      _reClearLog();
      _reBroadcastStatus('checking', 'Resolve: Checking…', 'Reading local engine status…');
      statusBtn.disabled = true;
      try {
        const { nativeResolveEngineStatus } = await import('./native_helper_client.js');
        const res = await nativeResolveEngineStatus(_rePathForEngine());
        _reApplyEngineStatus(res?.result || res?.data || {});
      } catch (e) {
        _reBroadcastStatus('error', 'Status failed', String(e?.userMessage || e?.message || e));
        _reAppendLog(String(e?.userMessage || e?.message || e), true);
      } finally {
        statusBtn.disabled = false;
      }
    });
  }

  const startBtn = reSection.querySelector('#pfxReStartBtn');
  if (startBtn) {
    startBtn.addEventListener('click', async () => {
      _reClearLog();
      const mode = _reCurrentMode();
      const isBackground = mode === 'background_auto';
      _reBroadcastStatus('checking', 'Resolve: Starting…',
        isBackground ? 'Starting Resolve in background…' : 'Starting Resolve Engine…');
      startBtn.disabled = true;
      try {
        const helper = await import('./native_helper_client.js');
        const r   = _pssSettings.resolveEngine || {};
        const adv = r.advanced || {};
        let res;
        if (isBackground && helper.nativeResolveStartBackground) {
          res = await helper.nativeResolveStartBackground({
            resolvePath:           _rePathForEngine(),
            minimize:              r.minimizeOnLaunch !== false,
            waitForReady:          true,
            apiReadyTimeoutSeconds: adv.apiReadyTimeoutSeconds || r.timeoutSeconds || 60,
            timeoutSeconds:        adv.apiReadyTimeoutSeconds || r.timeoutSeconds || 60,
          });
        } else {
          res = await helper.nativeResolveStartEngine({
            resolvePath:   _rePathForEngine(),
            launchPolicy:  isBackground ? 'background' : 'manual',
            runMode:       _reModeForEngine(),
            timeoutSeconds: adv.jobTimeoutSeconds || r.timeoutSeconds || 60,
          });
        }
        const data = res?.result || res?.data || {};
        _reApplyEngineStatus(data);
        if (data.connected || data.apiAvailable) {
          _reAppendLog('Resolve is running and scripting API is ready.');
        } else {
          _reAppendLog(isBackground
            ? 'Resolve did not connect in time. It may still be starting — queued jobs will retry automatically.'
            : (data.userMessage || data.message || 'Resolve did not connect.'), true);
        }
      } catch (e) {
        const msg = _reFriendlySetupMessage(e);
        _reBroadcastStatus('idle', isBackground ? 'Resolve: Installed — Auto Ready' : 'Simple Mode active', msg);
        _reAppendLog(msg, _reIsOldHelperError(msg));
      } finally {
        startBtn.disabled = false;
      }
    });
  }

  const stopBtn = reSection.querySelector('#pfxReStopBtn');
  if (stopBtn) {
    stopBtn.addEventListener('click', async () => {
      stopBtn.disabled = true;
      try {
        const { nativeResolveStopEngine } = await import('./native_helper_client.js');
        const res = await nativeResolveStopEngine(false);
        const data = res?.result || res?.data || {};
        _reAppendLog(data.message || (data.stopped ? 'Resolve Engine stopped.' : 'No companion-owned Resolve process to stop.'));
        _reBroadcastStatus(data.stopped ? 'idle' : 'idle', data.stopped ? 'Resolve: Stopped' : 'Resolve: Idle', data.message || '');
      } catch (e) {
        _reAppendLog(String(e?.userMessage || e?.message || e), true);
      } finally {
        stopBtn.disabled = false;
      }
    });
  }

  const logsBtn = reSection.querySelector('#pfxReLogsBtn');
  if (logsBtn) {
    logsBtn.addEventListener('click', async () => {
      try {
        const { nativeResolveGetLogs } = await import('./native_helper_client.js');
        const res = await nativeResolveGetLogs(200);
        const data = res?.result || res?.data || {};
        _reClearLog();
        if (data.logPath) _reAppendLog(`Log: ${data.logPath}`);
        (data.logs || data.lines || []).forEach(line => _reAppendLog(line));
        if (!(data.logs || data.lines || []).length) _reAppendLog('No Resolve Engine log entries yet.');
      } catch (e) {
        _reAppendLog(String(e?.userMessage || e?.message || e), true);
      }
    });
  }

  const clearBtn = reSection.querySelector('#pfxReClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      clearBtn.disabled = true;
      try {
        const { nativeResolveClearQueue } = await import('./native_helper_client.js');
        const res = await nativeResolveClearQueue(true);
        const data = res?.result || res?.data || {};
        _reAppendLog(`Queue cleared: ${data.cleared ?? data.removed ?? 0}`);
      } catch (e) {
        _reAppendLog(String(e?.userMessage || e?.message || e), true);
      } finally {
        clearBtn.disabled = false;
      }
    });
  }

  // Browse button
  const browseBtn = reSection.querySelector('#pfxReBrowseBtn');
  if (browseBtn) {
    browseBtn.addEventListener('click', async () => {
      try {
        const { nativePickMediaFile } = await import('./native_helper_client.js');
        const res = await nativePickMediaFile('Select DaVinci Resolve executable');
        const picked = res?.result?.path || res?.result?.filePath || '';
        if (picked) {
          _pssSetPath(_pssSettings, 'resolveEngine.resolvePath', picked);
          const inp = reSection.querySelector('#pfxRePathInput');
          if (inp) inp.value = picked;
          _pssMarkDirty();
        }
      } catch { _pssToast('Native helper not available — type the path manually.'); }
    });
  }
}

// ── Toast helper ─────────────────────────────────────────────────────────────
function _pssToast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'pfx-setup-toast' + (isError ? ' pfx-setup-toast--err' : '');
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('pfx-setup-toast--visible'));
  setTimeout(() => { el.classList.remove('pfx-setup-toast--visible'); setTimeout(() => el.remove(), 300); }, 2800);
}

// ── Resolve: auto-connect in background (never launches Resolve) ────────────
// On PFX open/refresh we automatically check whether Resolve is already
// running (the user's responsibility) and connect to its scripting API in
// the background — without raising the GUI. The companion-side detect path
// uses _get_resolve_app(timeout=0), which is purely passive: it asks the
// scripting API once and returns immediately. If Resolve isn't running we
// surface "Resolve: Installed" (not an error) and leave it to the user to
// start Resolve themselves. PFX never calls launch_resolve().

function _reBroadcastStatus(state, label, sub, extra = {}) {
  const status = { state, label, sub: sub || '', at: Date.now(), ...extra };
  try { window.PFX_RESOLVE_STATUS = status; } catch {}
  try { document.dispatchEvent(new CustomEvent('pfx:resolve-status', { detail: status })); } catch {}
  return status;
}

// Module-level mode helper — used by both the section init and autoConnectResolveOnBoot
function _reCurrentMode() {
  const raw = _pssSettings?.resolveEngine?.mode || _pssSettings?.resolveEngine?.engineMode || '';
  if (raw === 'background_auto' || raw === 'background' || raw === 'auto') return 'background_auto';
  if (raw === 'assisted'        || raw === 'visible')                       return 'assisted';
  if (raw === 'manual_handoff'  || raw === 'handoff' || raw === 'manual')   return 'manual_handoff';
  if (raw === 'disabled')                                                   return 'disabled';
  return 'background_auto';
}

let _reAutoConnectInFlight = null;

export function getResolveStatus() {
  return (typeof window !== 'undefined' && window.PFX_RESOLVE_STATUS) || null;
}

export async function autoConnectResolveOnBoot({ force = false } = {}) {
  if (_reAutoConnectInFlight && !force) return _reAutoConnectInFlight;

  _reAutoConnectInFlight = (async () => {
    try { if (!_pssSettings) await _pssLoad(); } catch {}
    _reBroadcastStatus('checking', 'Resolve: Checking…',
      'Background check — Resolve will not be launched.');

    let helper;
    try {
      helper = await import('./native_helper_client.js');
    } catch {
      _reBroadcastStatus('error', 'Resolve: Helper missing', 'Native helper module failed to load');
      return;
    }

    try {
      // Passive detect: returns { found, resolvedPath, scriptingAvailable,
      // apiAvailable }. The Python side uses _get_resolve_app(timeout=0)
      // for apiAvailable, which is a single zero-timeout probe — no launch,
      // no GUI raise, no waiting.
      const det = await helper.nativeResolveDetect();
      const info = det?.result || {};
      if (!det?.ok || !info.found) {
        _reBroadcastStatus('error', 'Resolve: Not found',
          info.reason || det?.error?.message || 'DaVinci Resolve not detected');
        return;
      }

      const detectedPath = info.resolvedPath || info.path || '';
      if (detectedPath && _pssSettings && !_pssSettings.resolveEngine?.resolvePath) {
        try {
          _pssSetPath(_pssSettings, 'resolveEngine.resolvePath', detectedPath);
          await _pssSaveNow(true);
        } catch {}
      }

      if (info.apiAvailable) {
        // Resolve is already running and the scripting API answered our
        // zero-timeout probe — connection is live in the background.
        _reBroadcastStatus('connected', 'Resolve: Connected',
          `v${info.version || '?'} · background scripting active`,
          { resolvePath: detectedPath, version: info.version || '' });
      } else if (info.scriptingAvailable) {
        // Resolve is installed with scripting available but not currently running.
        // In background_auto mode this is the normal ready state — we'll launch it.
        const autoMode   = _reCurrentMode() === 'background_auto' || _reCurrentMode() === 'assisted';
        const idleLabel  = autoMode ? 'Resolve: Ready for Auto-Launch' : 'Resolve: Installed';
        const idleSub    = autoMode
          ? `v${info.version || '?'} · Ready — PostFlowX will start Resolve automatically when a job is queued`
          : `v${info.version || '?'} · Installed — switch to Background Auto mode for full automation`;
        _reBroadcastStatus('idle', idleLabel, idleSub,
          { resolvePath: detectedPath, version: info.version || '' });
      } else {
        _reBroadcastStatus('error', 'Resolve: Scripting off',
          'Enable Preferences → System → General → External scripting.',
          { resolvePath: detectedPath });
      }
    } catch (e) {
      _reBroadcastStatus('error', 'Resolve: Check failed', String(e?.message || e));
    }
  })();

  try { return await _reAutoConnectInFlight; }
  finally { _reAutoConnectInFlight = null; }
}

// ── Live watcher: visibility + focus + heartbeat ──────────────────────────
// The boot-time autoConnect happens once. If you open Resolve AFTER opening
// PFX, the pill should still flip to "Connected" without you reloading. We
// re-run the same passive detect on:
//   • document visibility change (Cmd-Tab back to Chrome)
//   • window focus (clicked back into the PFX tab)
//   • every 30s while the tab is visible (heartbeat)
// All re-runs go through the same in-flight guard above and a short throttle
// (no more than once per 4s) so rapid tab-switching doesn't spam the companion.
let _reWatcherStarted = false;
let _reLastCheckAt = 0;
const _RE_MIN_INTERVAL_MS = 4000;
const _RE_HEARTBEAT_MS    = 30000;
let _reHeartbeatTimer = null;

function _reMaybeRecheck() {
  const now = Date.now();
  if (now - _reLastCheckAt < _RE_MIN_INTERVAL_MS) return;
  _reLastCheckAt = now;
  try { autoConnectResolveOnBoot({ force: false }).catch(() => {}); } catch {}
}

export function startResolveStatusWatcher() {
  if (_reWatcherStarted) return;
  _reWatcherStarted = true;

  const onVisibility = () => {
    if (document.visibilityState === 'visible') _reMaybeRecheck();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', () => _reMaybeRecheck());

  const startHeartbeat = () => {
    if (_reHeartbeatTimer) return;
    _reHeartbeatTimer = setInterval(() => {
      if (document.visibilityState === 'visible') _reMaybeRecheck();
    }, _RE_HEARTBEAT_MS);
  };
  const stopHeartbeat = () => {
    if (_reHeartbeatTimer) { clearInterval(_reHeartbeatTimer); _reHeartbeatTimer = null; }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startHeartbeat();
    else stopHeartbeat();
  });
  if (document.visibilityState === 'visible') startHeartbeat();
}

// ── Panel open / close ────────────────────────────────────────────────────────
export async function openProjectSetup(tabId = null) {
  try {
    if (tabId && _PSS_TABS.find(t => t.id === tabId)) _pssActiveTab = tabId;

    // Always reload from storage on open so page-reload and project-key
    // changes are reflected. _pssFlushAutosave() saves dirty state on close,
    // so reloading here always gives the last persisted values.
    await _pssLoad();

    // Remove stale panel if any
    const old = document.getElementById('pfxSetupOverlay');
    if (old) old.remove();

    // Build and attach
    const wrap = document.createElement('div');
    wrap.innerHTML = _pssBuildPanel(_pssSettings);
    _pssEl = wrap.firstElementChild;

    if (!_pssEl) {
      console.error('PFX Setup: _pssBuildPanel returned no element');
      return;
    }

    // Force inline styles — CSS-independent so the panel appears even if
    // stylesheet rules haven't applied yet (e.g. first load, cache miss).
    _pssEl.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:99999',
      'background:rgba(0,0,0,.45)',
      'opacity:0',
      'pointer-events:none',
      'transition:opacity .2s ease',
    ].join(';');

    const panel = _pssEl.querySelector('.pfx-setup-panel');
    if (panel) {
      panel.style.cssText = [
        'position:absolute',
        'top:0',
        'right:0',
        'bottom:0',
        'width:420px',
        'max-width:100vw',
        'display:flex',
        'flex-direction:column',
        'background:#18181e',
        'border-left:1px solid rgba(255,255,255,.07)',
        'box-shadow:-8px 0 40px rgba(0,0,0,.6)',
        'transform:translateX(100%)',
        'transition:transform .22s cubic-bezier(.22,.6,.36,1)',
      ].join(';');
    }

    document.body.appendChild(_pssEl);

    // Wire tabs
    _pssEl.querySelectorAll('.pfx-setup-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        _pssActiveTab = btn.dataset.tab;
        _pssEl.querySelectorAll('.pfx-setup-tab').forEach(b => b.classList.toggle('pfx-setup-tab--active', b.dataset.tab === _pssActiveTab));
        const content = _pssEl.querySelector('#pfxSetupContent');
        if (content) {
          content.innerHTML = _pssRenderSection(_pssActiveTab, _pssSettings);
          _pssWireSection(content);
        }
      });
    });

    // Wire section controls
    _pssWireSection(_pssEl.querySelector('#pfxSetupContent'));

    // Close button
    _pssEl.querySelector('#pfxSetupClose')?.addEventListener('click', closeProjectSetup);
    _pssEl.querySelector('#pfxSetupCancel')?.addEventListener('click', closeProjectSetup);

    // Overlay click-outside close
    _pssEl.addEventListener('pointerdown', e => {
      if (e.target === _pssEl) closeProjectSetup();
    });

    // Save button
    _pssEl.querySelector('#pfxSetupSaveBtn')?.addEventListener('click', async () => {
      const saveBtn = _pssEl?.querySelector('#pfxSetupSaveBtn');
      if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
      try {
        await _pssSaveNow(false);
        _pssToast('Settings saved.');
        _pssUpdateHeaderDot();
      } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Settings'; }
      }
      // Notify Render Queue to re-evaluate any blocked VFX Package jobs.
      try { document.dispatchEvent(new CustomEvent('pfx:resolve-settings-updated', { detail: { settings: _pssSettings?.resolveEngine } })); } catch {}
    });

    // Apply to markers
    _pssEl.querySelector('#pfxSetupApplyBtn')?.addEventListener('click', () => {
      _pssBridgeToLs();
      window.dispatchEvent(new CustomEvent('pfx:projectSettingsApplied', { detail: { settings: _pssSettings } }));
      _pssToast('Settings applied to all markers.');
    });

    // Double rAF: first frame paints the opacity:0 state, second fires the
    // transition so the browser sees a genuine before→after style change.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!_pssEl) return;
      _pssEl.style.opacity = '1';
      _pssEl.style.pointerEvents = 'auto';
      _pssEl.classList.add('pfx-setup-overlay--open');
      const p = _pssEl.querySelector('.pfx-setup-panel');
      if (p) p.style.transform = 'translateX(0)';
    }));

    _pssOpen = true;
    _pssUpdateStatusBar();

    document.addEventListener('keydown', _pssOnKeydown);
  } catch (err) {
    console.error('PFX Setup open failed:', err);
  }
}

export function closeProjectSetup() {
  if (!_pssEl) { _pssOpen = false; return; }
  const el = _pssEl;
  _pssEl = null;
  _pssOpen = false;

  // Animate out via inline styles (mirror of open — CSS-independent)
  el.style.opacity = '0';
  el.style.pointerEvents = 'none';
  el.classList.remove('pfx-setup-overlay--open');
  const panel = el.querySelector('.pfx-setup-panel');
  if (panel) panel.style.transform = 'translateX(100%)';

  setTimeout(() => el.remove(), 240);
  document.removeEventListener('keydown', _pssOnKeydown);
  _pssFlushAutosave();
  _pssUpdateHeaderDot();
}

function _pssOnKeydown(e) {
  if (e.key === 'Escape') closeProjectSetup();
}

// ── Project key change hook ────────────────────────────────────────────────────
function _pssOnProjectChanged() {
  _pssSettings = null;
  _pssDirty = false;
  // Always reload settings and broadcast fps so timeline/video adopts the new project's fps
  _pssLoad().then(() => {
    _pssBroadcastFpsChange();
    if (_pssOpen) {
      const old = document.getElementById('pfxSetupOverlay');
      if (old) {
        closeProjectSetup();
        openProjectSetup(_pssActiveTab);
      }
    }
  }).catch(() => {});
}

// ── Init ──────────────────────────────────────────────────────────────────────
// openProjectSetup / closeProjectSetup load settings lazily so the button
// click handler can be wired SYNCHRONOUSLY at module parse time — no async
// dependency on IndexedDB before the button becomes functional.

export async function initProjectSetup() {
  // Background load — populates _pssSettings so first open is instant.
  // After load completes, broadcast fps so prep_mark.js can correct _pmFps
  // before the user has to open Project Setup.
  _pssLoad().then(() => { _pssBroadcastFpsChange(); }).catch(() => {});
  _pssInitBc();
  window.addEventListener('beforeunload', _pssFlushAutosave);
  window.addEventListener('pfx:projectKeyChanged', _pssOnProjectChanged);
}

// Wire button synchronously — runs at module top-level so the button is
// responsive the instant the script tag is evaluated, no IDB await needed.
function _pssSyncBoot() {
  // Register global API immediately (openProjectSetup handles lazy load inside)
  window.__pfxProjectSetup = {
    open:        openProjectSetup,
    close:       closeProjectSetup,
    getSettings: () => _pssSettings,
    saveNow:     () => _pssSaveNow(false),
    isOpen:      () => _pssOpen,
    autoConnectResolve: autoConnectResolveOnBoot,
    getResolveStatus,
    startResolveStatusWatcher,
  };

  const btn = document.getElementById('pfxSetupBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      if (_pssOpen) closeProjectSetup(); else openProjectSetup();
    });
  }

  // Kick off background tasks
  initProjectSetup().catch(() => {});

  // Auto-connect to Resolve in the background on every open/refresh, and
  // keep tracking its state via the visibility/focus/heartbeat watcher.
  // Both are passive — they never launch Resolve.
  try { autoConnectResolveOnBoot({ force: false }).catch(() => {}); } catch {}
  try { startResolveStatusWatcher(); } catch {}
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _pssSyncBoot);
} else {
  _pssSyncBoot();
}
