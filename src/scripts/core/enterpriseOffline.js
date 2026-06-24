// Offline Enterprise Governance (Sprint F)
// - No server / no native host required
// - Identity (local)
// - Project write-lock via lock file in Documents/ast_project/_locks
// - Immutable audit ledger (.audit.jsonl) with SHA-256 hash chain
//
// Best-effort: works when all users point the extension to the SAME shared folder.
// (eg. a network share). Lock TTL prevents permanent lock if a browser crashes.

import { getAstProjectDirHandle, sanitizeFilename } from './projectFile.js';

const CFG_KEY = 'mps.enterprise.offline.cfg.v1';
const USER_KEY = 'mps.enterprise.offline.user.v1';
const MACHINE_KEY = 'mps.enterprise.machineId.v1';

// Default must match the UI expectation: OFF by default.
const DEFAULT_CFG = {
  enabled: false,
  strictNoNetwork: false,
  lockTtlMs: 45_000,
  heartbeatMs: 10_000,
};

// Read-only UX: mark write-actions visually disabled (JS still enforces).
const READONLY_BLOCKED_IDS = [
  'btnBrowseFiles','btnClear','qsAllOff',
  'btnExportEDL','btnExportOTIO','cutdiffExportBtn',
  'amfExportJson','amfExportAE','amfExportNukeNK','amfExportShotsCsv','amfShotsExportSheets','amfShotsExportPdf','amfShotsExportCsv',
  'smExportXlsxBtn','smExportPdfBtn','smExportCsvBtn','smExportMarkerXmlBtn',
  'projSave','projSaveAs',
  'amfChooseFolder','amfRescan','amfClear','amfGenerateAEP','amfFlowConnect',
  'mpsValidateFixAllBtn','mpsValidateProceedBtn',
  'smAddMarkerBtn','smCutDetectBtn','smCutAddBtn','smCutMergeBtn','smCutUndoBtn','smCutRedoBtn','smImportBtn',
  'cutdiffClearBtn','cutdiffAnalyzeBtn',
];

const READONLY_ALLOW_IDS = [
  'projEnterprise','projLoad','projNew','projectSelectGlobal','projectNameGlobal',
  'mpsAuditVerifyBtn','mpsAuditCopyBtn','mpsAuditCsvBtn','mpsAuditClearBtn',
  'smPlayBtn','smRewBtn','smFfBtn','smPrevFrameBtn','smNextFrameBtn','smFullBtn','smFitBtn','smTlFitBtn','smTlZoomInBtn','smTlZoomOutBtn','smTlZoomPctBtn','smHomeBtn','smEndBtn','smScrubRange',
  'smBrowseBtn','cutdiffOldBrowse','cutdiffNewBrowse','smImportTimeline','cutdiffOldFile','cutdiffNewFile',
];


function canForceTakeover(){
  const r = String(state.user?.role || '').toLowerCase();
  return /\b(sup|super|supervisor|lead|admin)\b/.test(r);
}

function _safeJson(raw, fb){
  try{ return JSON.parse(raw); }catch{ return fb; }
}

function loadCfg(){
  try{
    const raw = localStorage.getItem(CFG_KEY);
    const o = raw ? _safeJson(raw, null) : null;
    if (!o || typeof o !== 'object') return { ...DEFAULT_CFG };
    return {
      enabled: !!o.enabled,
      strictNoNetwork: (o.strictNoNetwork !== false),
      lockTtlMs: Math.max(10_000, Number(o.lockTtlMs || DEFAULT_CFG.lockTtlMs)),
      heartbeatMs: Math.max(2_000, Number(o.heartbeatMs || DEFAULT_CFG.heartbeatMs)),
    };
  }catch{
    return { ...DEFAULT_CFG };
  }
}

function saveCfg(cfg){
  const clean = {
    enabled: !!cfg.enabled,
    strictNoNetwork: (cfg.strictNoNetwork !== false),
    lockTtlMs: Math.max(10_000, Number(cfg.lockTtlMs || DEFAULT_CFG.lockTtlMs)),
    heartbeatMs: Math.max(2_000, Number(cfg.heartbeatMs || DEFAULT_CFG.heartbeatMs)),
  };
  try{ localStorage.setItem(CFG_KEY, JSON.stringify(clean)); }catch{}
  return clean;
}

function loadUser(){
  try{
    const raw = localStorage.getItem(USER_KEY);
    const o = raw ? _safeJson(raw, null) : null;
    if (!o || typeof o !== 'object') return { name: '', role: '', team: '' };
    return {
      name: String(o.name || ''),
      role: String(o.role || ''),
      team: String(o.team || ''),
    };
  }catch{
    return { name: '', role: '', team: '' };
  }
}

function saveUser(u){
  const clean = {
    name: String(u?.name || '').trim(),
    role: String(u?.role || '').trim(),
    team: String(u?.team || '').trim(),
  };
  try{ localStorage.setItem(USER_KEY, JSON.stringify(clean)); }catch{}
  return clean;
}

function ensureMachineId(){
  try{
    let id = String(localStorage.getItem(MACHINE_KEY) || '').trim();
    if (!id){
      id = (crypto?.randomUUID ? crypto.randomUUID() : ('m_' + Math.random().toString(16).slice(2)));
      localStorage.setItem(MACHINE_KEY, id);
    }
    return id;
  }catch{
    return (crypto?.randomUUID ? crypto.randomUUID() : ('m_' + Math.random().toString(16).slice(2)));
  }
}

function ensureProjectId(){
  try{
    let pid = String(window.__MPS_PROJECT_ID || '').trim();
    if (!pid){
      pid = (crypto?.randomUUID ? crypto.randomUUID() : ('p_' + Math.random().toString(16).slice(2)));
      window.__MPS_PROJECT_ID = pid;
    }
    return pid;
  }catch{
    return (crypto?.randomUUID ? crypto.randomUUID() : ('p_' + Math.random().toString(16).slice(2)));
  }
}

function ensureProjectSalt(){
  try{
    let salt = String(window.__MPS_PROJECT_SALT || '').trim();
    if (!salt){
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      salt = Array.from(b).map(x=>x.toString(16).padStart(2,'0')).join('');
      window.__MPS_PROJECT_SALT = salt;
    }
    return salt;
  }catch{
    return '';
  }
}

function resetProjectIdentity(){
  try{ window.__MPS_PROJECT_ID = ''; }catch{}
  try{ window.__MPS_PROJECT_SALT = ''; }catch{}
  ensureProjectId();
  ensureProjectSalt();
}

async function sha256Hex(text){
  const enc = new TextEncoder();
  const buf = enc.encode(String(text||''));
  const dig = await crypto.subtle.digest('SHA-256', buf);
  const arr = Array.from(new Uint8Array(dig));
  return arr.map(b=>b.toString(16).padStart(2,'0')).join('');
}

async function readHandleText(fh){
  const f = await fh.getFile();
  if (f.text) return await f.text();
  return await new Promise((resolve, reject)=>{
    const r = new FileReader();
    r.onerror = () => reject(r.error);
    r.onload = () => resolve(String(r.result||''));
    r.readAsText(f);
  });
}

function nowISO(){
  try{ return new Date().toISOString(); }catch{ return ''; }
}

const state = {
  cfg: loadCfg(),
  user: loadUser(),
  machineId: ensureMachineId(),
  projectName: '',
  projectId: '',
  lock: null,
  readonly: false,
  lockCountdownTimer: null,
  conflictOverlayTimer: null,
  lockStaleInMs: null,
  heartbeatTimer: null,
  lockWriteInFlight: false,
  ledger: {
    fh: null,
    appending: false,
    q: [],
    head: { seq: 0, hash: '' },
  },
};

function lockStaleInMs(lock){
  try{
    const hb = Date.parse(lock?.heartbeatAt || lock?.acquiredAt || '') || 0;
    const ttl = Number(lock?.ttlMs || state.cfg.lockTtlMs);
    if (!hb) return -1;
    return ttl - (Date.now() - hb);
  }catch{
    return -1;
  }
}

function fmtMs(ms){
  const s = Math.max(0, Math.ceil(Number(ms||0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s/60);
  const r = s % 60;
  return `${m}m ${String(r).padStart(2,'0')}s`;
}

function isEnabled(){ return !!state.cfg.enabled; }

function setEnabled(on){
  state.cfg = saveCfg({ ...state.cfg, enabled: !!on });
  try{ localStorage.setItem('mps.enterprise.offline.enabled.v1', on ? '1' : '0'); }catch{}
  try{ window.__MPS_ENTERPRISE_OFFLINE_ENABLED = !!on; }catch{}
  // Tell background to disable network features.
  try{ chrome?.storage?.local?.set?.({ mps_enterprise_offline: !!on }); }catch{}
  updatePill();
  if (!on){
    setReadonly(false, '');
    stopHeartbeat();
    // best-effort release lock
    releaseLock().catch(()=>{});
  } else {
    // ensure identity + lock
    ensureProjectId();
    ensureProjectSalt();
    maybeAcquireLockSoon('enable');
  }
}

function setReadonly(on, reason){
  state.readonly = !!on;
  try{ window.__MPS_ENTERPRISE_READONLY = !!on; }catch{}
  try{ window.__MPS_ENTERPRISE_READONLY_REASON = String(reason || ''); }catch{}
  try{ document.body.classList.toggle('mps-readonly', !!on); }catch{}
  try{ applyReadOnlyVisualState(); }catch{}
  if (on) startLockCountdown();
  else stopLockCountdown();
  if (!on) try{ closeLockConflictOverlay(); }catch{}
  updatePill();
  // Also nudge UI to stop autosave when readonly
  try{ if (on) window.__MPS_PROJECT_DIRTY = false; }catch{}
}

function applyReadOnlyVisualState(){
  try{
    // Clear prior markers that we applied
    document.querySelectorAll('[data-mps-ro="1"]').forEach(el=>{
      try{ el.classList.remove('mps-ro-disabled'); }catch{}
      try{ el.removeAttribute('aria-disabled'); }catch{}
      try{ delete el.dataset.mpsRo; }catch{}
    });

    if (!isEnabled() || !state.readonly) return;

    const allow = new Set(READONLY_ALLOW_IDS);

    // Mark known write-action buttons/inputs
    READONLY_BLOCKED_IDS.forEach(id=>{
      if (allow.has(id)) return;
      const el = document.getElementById(id);
      if (!el) return;
      try{ el.classList.add('mps-ro-disabled'); el.dataset.mpsRo = '1'; el.setAttribute('aria-disabled','true'); }catch{}
    });

    // Quick Settings toggles (EDL) + OTIO menu items
    document.querySelectorAll('#main-edl .qs-btn').forEach(el=>{
      try{ el.classList.add('mps-ro-disabled'); el.dataset.mpsRo = '1'; el.setAttribute('aria-disabled','true'); }catch{}
    });
    document.querySelectorAll('.otio-menu-item').forEach(el=>{
      try{ el.classList.add('mps-ro-disabled'); el.dataset.mpsRo = '1'; el.setAttribute('aria-disabled','true'); }catch{}
    });
  }catch{}
}

function updatePill(){
  const pill = document.getElementById('entLockStatus');
  if (!pill) return;

  if (!isEnabled()){
    pill.style.display = 'none';
    pill.textContent = 'Enterprise';
    pill.classList.remove('is-write','is-readonly','is-off');
    return;
  }

  pill.style.display = 'inline-flex';
  pill.classList.remove('is-write','is-readonly','is-off');

  if (!state.projectName){
    pill.textContent = 'Enterprise: On';
    pill.classList.add('is-off');
    pill.title = 'Enterprise Offline enabled (no project)';
    return;
  }

  if (state.readonly){
    pill.classList.add('is-readonly');
    const r = String(window.__MPS_ENTERPRISE_READONLY_REASON || 'Read-only');
    const ms = (state.lock && state.lock.owner?.machineId && state.lock.owner.machineId !== state.machineId)
      ? lockStaleInMs(state.lock)
      : null;

    let extra = '';
    if (ms != null){
      state.lockStaleInMs = ms;
      extra = (ms <= 0) ? 'STALE' : fmtMs(ms);
      pill.title = ms <= 0 ? `${r} • Lock is STALE (takeover available)` : `${r} • Stale in ${fmtMs(ms)}`;
    }else{
      pill.title = r;
    }

    // Render countdown visibly inside pill (compact)
    try{
      pill.textContent = '';
      pill.appendChild(document.createTextNode('🔒 Read-only'));
      if (extra){
        const sp = document.createElement('span');
        sp.className = 'mps-ent-ttl';
        sp.textContent = extra;
        pill.appendChild(sp);
      }
    }catch{
      pill.textContent = '🔒 Read-only' + (extra ? (' ' + extra) : '');
    }
    try{ applyReadOnlyVisualState(); }catch{}
    return;
  }

  if (state.lock && state.lock.owner?.machineId === state.machineId){
    pill.textContent = '🔒 Write lock';
    pill.classList.add('is-write');
    pill.title = `Write lock: you (${state.user.name || 'User'})`;
    return;
  }

  pill.textContent = 'Enterprise: On';
  pill.classList.add('is-off');
  pill.title = 'Enterprise Offline enabled';
}

function stopLockCountdown(){
  if (state.lockCountdownTimer){
    clearInterval(state.lockCountdownTimer);
    state.lockCountdownTimer = null;
  }
  state.lockStaleInMs = null;
}

function startLockCountdown(){
  stopLockCountdown();
  // Only useful when we're readonly due to a foreign lock.
  if (!isEnabled()) return;
  if (!state.readonly) return;
  if (!state.lock || !state.projectId) return;
  if (state.lock.owner?.machineId === state.machineId) return;

  state.lockCountdownTimer = setInterval(async ()=>{
    try{
      if (!isEnabled() || !state.readonly) return stopLockCountdown();
      const pid = String(state.projectId || '').trim();
      if (!pid) return;
      const r = await readLockFile(pid);
      if (r?.ok && r.lock){
        state.lock = r.lock;
      }
      const ms = lockStaleInMs(state.lock);
      state.lockStaleInMs = ms;
      updatePill();
    }catch{}
  }, 1200);
}


function closeLockConflictOverlay(){
  try{
    const el = document.getElementById('mpsLockConflictOverlay');
    if (el) el.remove();
  }catch{}
  try{
    if (state.conflictOverlayTimer){
      clearInterval(state.conflictOverlayTimer);
      state.conflictOverlayTimer = null;
    }
  }catch{}
}

function openLockConflictOverlay(){
  try{
    closeLockConflictOverlay();
    if (!isEnabled() || !state.readonly || !state.lock) return;

    const lock = state.lock;
    const by = lock.owner?.label || lock.owner?.name || '(unknown)';
    const hb = String(lock?.heartbeatAt || lock?.acquiredAt || '');
    const wrap = document.createElement('div');
    wrap.id = 'mpsLockConflictOverlay';
    wrap.className = 'mps-lock-overlay';

    const card = document.createElement('div');
    card.className = 'mps-lock-card';

    const title = document.createElement('div');
    title.className = 'mps-lock-title';
    title.textContent = 'Project Locked';

    const sub = document.createElement('div');
    sub.className = 'mps-lock-sub';
    sub.textContent = `Locked by: ${by}`;

    const meta = document.createElement('div');
    meta.className = 'mps-lock-meta';
    meta.textContent = hb ? `Last heartbeat: ${hb}` : 'Last heartbeat: —';

    const ttl = document.createElement('div');
    ttl.className = 'mps-lock-ttl';
    ttl.textContent = 'Status: —';

    const reasonRow = document.createElement('div');
    reasonRow.className = 'mps-lock-reason';

    const reason = document.createElement('input');
    reason.type = 'text';
    reason.placeholder = 'Reason for takeover (required)';
    reason.className = 'mps-lock-reason-input';

    const warn = document.createElement('div');
    warn.className = 'mps-lock-warn';

    const btnRow = document.createElement('div');
    btnRow.className = 'mps-lock-btnrow';

    const btnOpenRO = document.createElement('button');
    btnOpenRO.className = 'btn';
    btnOpenRO.textContent = 'Open Read-only';

    const btnSettings = document.createElement('button');
    btnSettings.className = 'btn';
    btnSettings.textContent = 'Enterprise Settings';

    const btnRefresh = document.createElement('button');
    btnRefresh.className = 'btn';
    btnRefresh.textContent = 'Refresh';

    const btnTake = document.createElement('button');
    btnTake.className = 'btn theme-danger';
    btnTake.textContent = 'Takeover';
    btnTake.disabled = false;

    const update = ()=>{
      const ms = lockStaleInMs(state.lock);
      const stale = (ms <= 0);
      ttl.textContent = stale ? 'Status: STALE • takeover available' : `Status: active • stale in ${fmtMs(ms)}`;
      btnTake.textContent = stale ? 'Takeover (stale)' : 'Force Takeover';
      btnTake.disabled = stale ? false : !canForceTakeover();
      btnTake.title = stale ? 'Take over stale lock' : (btnTake.disabled ? 'Requires role: Supervisor/Lead/Admin' : 'Force take over lock');
      reasonRow.style.display = stale || canForceTakeover() ? 'block' : 'none';
    };

    btnOpenRO.addEventListener('click', (e)=>{ e.preventDefault(); closeLockConflictOverlay(); });
    btnSettings.addEventListener('click', (e)=>{ e.preventDefault(); closeLockConflictOverlay(); openSettingsModal({}); });
    btnRefresh.addEventListener('click', async (e)=>{
      e.preventDefault();
      try{
        const r = await readLockFile(state.projectId);
        if (r?.ok && r.lock) state.lock = r.lock;
        update();
      }catch{}
    });

    btnTake.addEventListener('click', async (e)=>{
      e.preventDefault();
      const why = String(reason.value||'').trim();
      if (!why){
        warn.textContent = 'Reason is required.';
        return;
      }
      warn.textContent = '';
      btnTake.disabled = true;
      try{
        const ms = lockStaleInMs(state.lock);
        const stale = (ms <= 0);
        const pn = String(state.projectName || document.getElementById('projectNameGlobal')?.value || '').trim();
        if (!pn) throw new Error('No project name');
        const res = stale ? await takeoverStaleLock(pn, why) : await forceTakeoverLock(pn, why);
        if (res?.ok){
          closeLockConflictOverlay();
        }else{
          warn.textContent = res?.reason ? `Takeover failed: ${res.reason}` : 'Takeover failed';
          btnTake.disabled = false;
        }
      }catch(err){
        warn.textContent = `Takeover failed: ${String(err?.message||err)}`;
        btnTake.disabled = false;
      }
    });

    reasonRow.appendChild(reason);
    card.appendChild(title);
    card.appendChild(sub);
    card.appendChild(meta);
    card.appendChild(ttl);
    card.appendChild(reasonRow);
    card.appendChild(warn);

    btnRow.appendChild(btnOpenRO);
    btnRow.appendChild(btnSettings);
    btnRow.appendChild(btnRefresh);
    btnRow.appendChild(btnTake);

    card.appendChild(btnRow);
    wrap.appendChild(card);
    document.body.appendChild(wrap);

    update();

    state.conflictOverlayTimer = setInterval(async ()=>{
      try{
        if (!document.getElementById('mpsLockConflictOverlay')) return closeLockConflictOverlay();
        if (!isEnabled() || !state.readonly) return closeLockConflictOverlay();
        const r = await readLockFile(state.projectId);
        if (r?.ok && r.lock) state.lock = r.lock;
        update();
      }catch{}
    }, 1500);
  }catch{}
}

function fmtUser(u){
  const name = String(u?.name || '').trim();
  const role = String(u?.role || '').trim();
  const team = String(u?.team || '').trim();
  const bits = [name, role, team].filter(Boolean);
  return bits.join(' • ');
}

function ensureIdentityUI(){
  if (!isEnabled()) return true;
  if (String(state.user?.name || '').trim()) return true;
  openSettingsModal({ forceIdentity: true });
  return false;
}

async function getLocksDir(){
  const astDir = await getAstProjectDirHandle();
  if (!astDir) return null;
  try{ return await astDir.getDirectoryHandle('_locks', { create: true }); }
  catch{ return null; }
}

function lockFilename(projectId){
  return `${String(projectId||'').trim() || 'project'}.lock.json`;
}

function isLockStale(lock){
  try{
    const hb = Date.parse(lock?.heartbeatAt || lock?.acquiredAt || '') || 0;
    const ttl = Number(lock?.ttlMs || state.cfg.lockTtlMs);
    if (!hb) return true;
    return (Date.now() - hb) > ttl;
  }catch{ return true; }
}

async function readLockFile(projectId){
  const dir = await getLocksDir();
  if (!dir) return { ok:false, reason:'no_dir' };
  const name = lockFilename(projectId);
  try{
    const fh = await dir.getFileHandle(name, { create: false });
    const txt = await readHandleText(fh);
    const o = _safeJson(txt, null);
    return { ok:true, fh, lock: (o && typeof o === 'object') ? o : null };
  }catch{
    return { ok:true, fh: null, lock: null };
  }
}

async function writeLockFile(projectId, lockObj){
  const dir = await getLocksDir();
  if (!dir) return { ok:false, reason:'no_dir' };
  const name = lockFilename(projectId);
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(lockObj, null, 2));
  await w.close();
  return { ok:true, fh };
}

async function removeLockFile(projectId){
  const dir = await getLocksDir();
  if (!dir) return { ok:false, reason:'no_dir' };
  const name = lockFilename(projectId);
  try{ await dir.removeEntry(name); return { ok:true }; }
  catch{ return { ok:false, reason:'no_remove' }; }
}

async function acquireLock(projectName){
  if (!isEnabled()) return { ok:false, reason:'disabled' };
  if (!ensureIdentityUI()) return { ok:false, reason:'no_identity' };

  const pn = String(projectName || '').trim();
  if (!pn) return { ok:false, reason:'no_project' };

  const pid = ensureProjectId();
  ensureProjectSalt();

  state.projectName = pn;
  state.projectId = pid;

  const r = await readLockFile(pid);
  if (!r.ok) return r;

  const existing = r.lock;
  const mine = existing && existing.owner?.machineId === state.machineId;
  const stale = existing ? isLockStale(existing) : false;

  if (existing && !mine && !stale){
    const ownerLabel = existing.owner?.label || existing.owner?.name || '(unknown)';
    state.lock = existing;
    setReadonly(true, `Locked by ${ownerLabel}`);
    updatePill();
    stopHeartbeat();
    try{ openLockConflictOverlay(); }catch{}
    return { ok:false, reason:'locked', by: existing.owner };
  }

  // Take or renew lock (no confirm; TTL prevents permanent lock)
  const lock = {
    projectId: pid,
    projectName: sanitizeFilename(pn),
    acquiredAt: existing?.acquiredAt || nowISO(),
    heartbeatAt: nowISO(),
    ttlMs: state.cfg.lockTtlMs,
    owner: {
      machineId: state.machineId,
      name: state.user?.name || '',
      role: state.user?.role || '',
      team: state.user?.team || '',
      label: fmtUser(state.user),
    },
    takeover: (!!existing && !mine) ? {
      from: existing?.owner || null,
      at: nowISO(),
    } : null,
  };

  await writeLockFile(pid, lock);
  state.lock = lock;
  setReadonly(false, '');
  startHeartbeat();
  updatePill();

  // Keep enterprise meta in project file
  try{ window.__MPS_ENTERPRISE_OFFLINE_META = { enabled:true, projectId: pid, projectSalt: String(window.__MPS_PROJECT_SALT||''), auditHead: state.ledger.head }; }catch{}

  // ledger handle (best-effort)
  try{ await ensureLedgerHandle(); }catch{}

  return { ok:true, lock };
}

async function forceTakeoverLock(projectName, reason){
  if (!isEnabled()) return { ok:false, reason:'disabled' };
  if (!ensureIdentityUI()) return { ok:false, reason:'no_identity' };
  if (!canForceTakeover()) return { ok:false, reason:'not_allowed' };

  const pn = String(projectName || '').trim();
  if (!pn) return { ok:false, reason:'no_project' };

  const pid = ensureProjectId();
  ensureProjectSalt();

  state.projectName = pn;
  state.projectId = pid;

  const r = await readLockFile(pid);
  if (!r.ok) return r;
  const existing = r.lock;

  const lock = {
    projectId: pid,
    projectName: sanitizeFilename(pn),
    acquiredAt: nowISO(),
    heartbeatAt: nowISO(),
    ttlMs: state.cfg.lockTtlMs,
    owner: {
      machineId: state.machineId,
      name: state.user?.name || '',
      role: state.user?.role || '',
      team: state.user?.team || '',
      label: fmtUser(state.user),
    },
    takeover: {
      forced: true,
      reason: String(reason || '').trim(),
      from: existing?.owner || null,
      at: nowISO(),
    },
  };

  await writeLockFile(pid, lock);
  state.lock = lock;
  setReadonly(false, '');
  startHeartbeat();
  updatePill();

  // Append to immutable ledger
  try{
    queueLedgerAppend('LOCK_TAKEOVER', {
      forced: true,
      reason: String(reason || '').trim(),
      from: existing?.owner || null,
      to: lock.owner,
      projectId: pid,
      projectName: sanitizeFilename(pn),
    });
  }catch{}

  return { ok:true, lock };
}

async function takeoverStaleLock(projectName, reason){
  if (!isEnabled()) return { ok:false, reason:'disabled' };
  if (!ensureIdentityUI()) return { ok:false, reason:'no_identity' };

  const pn = String(projectName || '').trim();
  if (!pn) return { ok:false, reason:'no_project' };

  const pid = ensureProjectId();
  ensureProjectSalt();

  state.projectName = pn;
  state.projectId = pid;

  const r = await readLockFile(pid);
  if (!r.ok) return r;
  const existing = r.lock;
  if (!existing) return { ok:false, reason:'no_lock' };

  if (!isLockStale(existing)){
    const by = existing.owner?.label || existing.owner?.name || '(unknown)';
    state.lock = existing;
    setReadonly(true, `Locked by ${by}`);
    return { ok:false, reason:'not_stale' };
  }

  const lock = {
    projectId: pid,
    projectName: sanitizeFilename(pn),
    acquiredAt: nowISO(),
    heartbeatAt: nowISO(),
    ttlMs: state.cfg.lockTtlMs,
    owner: {
      machineId: state.machineId,
      name: state.user?.name || '',
      role: state.user?.role || '',
      team: state.user?.team || '',
      label: fmtUser(state.user),
    },
    takeover: {
      forced: false,
      stale: true,
      reason: String(reason || '').trim(),
      from: existing?.owner || null,
      at: nowISO(),
      staleHeartbeatAt: existing?.heartbeatAt || existing?.acquiredAt || null,
      ttlMs: Number(existing?.ttlMs || state.cfg.lockTtlMs),
    },
  };

  await writeLockFile(pid, lock);
  state.lock = lock;
  setReadonly(false, '');
  startHeartbeat();
  updatePill();

  try{
    queueLedgerAppend('LOCK_TAKEOVER', {
      forced: false,
      stale: true,
      reason: String(reason || '').trim(),
      from: existing?.owner || null,
      to: lock.owner,
      projectId: pid,
      projectName: sanitizeFilename(pn),
    });
  }catch{}

  return { ok:true, lock };
}

async function releaseLock(){
  if (!isEnabled()) return { ok:false, reason:'disabled' };
  const pid = String(state.projectId || window.__MPS_PROJECT_ID || '').trim();
  if (!pid) return { ok:false, reason:'no_project' };

  stopHeartbeat();

  const cur = state.lock;
  const mine = cur && cur.owner?.machineId === state.machineId;
  if (!mine) return { ok:false, reason:'not_owner' };

  // Best-effort remove
  await removeLockFile(pid);
  state.lock = null;
  updatePill();
  return { ok:true };
}

function stopHeartbeat(){
  if (state.heartbeatTimer){
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

function startHeartbeat(){
  stopHeartbeat();
  state.heartbeatTimer = setInterval(async () => {
    if (!isEnabled()) return;
    if (state.readonly) return;
    if (!state.lock) return;
    if (state.lock.owner?.machineId !== state.machineId) return;
    if (state.lockWriteInFlight) return;

    state.lockWriteInFlight = true;
    try{
      state.lock.heartbeatAt = nowISO();
      await writeLockFile(state.projectId, state.lock);
      updatePill();
    }catch{}
    state.lockWriteInFlight = false;
  }, state.cfg.heartbeatMs);
}

let __acqTimer = null;
function maybeAcquireLockSoon(reason){
  if (!isEnabled()) return;
  clearTimeout(__acqTimer);
  __acqTimer = setTimeout(() => {
    const name = String(document.getElementById('projectNameGlobal')?.value || window.__MPS_PROJECT_NAME || '').trim();
    if (!name) return;
    acquireLock(name).catch(()=>{});
  }, 250);
}

// ---------------- Ledger (.audit.jsonl) ----------------
async function ensureLedgerHandle(){
  if (!isEnabled()) return null;
  const astDir = await getAstProjectDirHandle();
  if (!astDir) return null;
  const pid = ensureProjectId();
  const base = sanitizeFilename(state.projectName || document.getElementById('projectNameGlobal')?.value || 'Project');
  // Stable filename includes projectId short to avoid collisions
  const fname = `${base}.${pid.slice(0,8)}.audit.jsonl`;
  const fh = await astDir.getFileHandle(fname, { create: true });
  state.ledger.fh = fh;

  // Load head (last line) best-effort
  try{
    const txt = await readHandleText(fh);
    const lines = String(txt||'').split(/\r?\n/).filter(Boolean);
    if (lines.length){
      const last = _safeJson(lines[lines.length-1], null);
      if (last && typeof last === 'object'){
        state.ledger.head = { seq: Number(last.seq||0), hash: String(last.hash||'') };
        try{ window.__MPS_ENTERPRISE_AUDIT_HEAD = state.ledger.head; }catch{}
      }
    }
  }catch{}

  return fh;
}

function queueLedgerAppend(type, payload){
  if (!isEnabled()) return;
  if (state.readonly) return;
  state.ledger.q.push({ type: String(type||'EVENT'), payload: payload || null, iso: nowISO() });
  flushLedgerQueue().catch(()=>{});
}

async function flushLedgerQueue(){
  if (state.ledger.appending) return;
  state.ledger.appending = true;

  try{
    if (!state.ledger.fh) await ensureLedgerHandle();
    const fh = state.ledger.fh;
    if (!fh){ state.ledger.q.length = 0; return; }

    while (state.ledger.q.length){
      // Peek — keep the item in the queue until the write confirms.
      // Shifting before the write completes loses the entry permanently if any
      // await below throws (sha256, createWritable, w.write, w.close).
      const item = state.ledger.q[0];
      const seq = Number(state.ledger.head.seq || 0) + 1;
      const prevHash = String(state.ledger.head.hash || '');
      const salt = ensureProjectSalt();
      const core = {
        seq,
        iso: item.iso,
        projectId: ensureProjectId(),
        project: String(state.projectName || '').trim(),
        type: String(item.type||'EVENT'),
        user: { ...state.user, machineId: state.machineId },
        payload: item.payload,
        prevHash,
      };

      const hash = await sha256Hex(`${seq}|${core.iso}|${core.type}|${prevHash}|${JSON.stringify(core.payload)}|${salt}`);
      const rec = { ...core, hash };

      // Append — abort the writable on any write error to avoid a partial/corrupted append.
      const file = await fh.getFile();
      const w = await fh.createWritable({ keepExistingData: true });
      try {
        await w.seek(file.size);
        await w.write(JSON.stringify(rec) + "\n");
        await w.close();
      } catch (writeErr) {
        try { await w.abort(); } catch {}
        throw writeErr; // re-throw so outer catch handles it; item stays in queue for next flush
      }

      // Write confirmed — now remove from queue and advance head.
      state.ledger.q.shift();
      state.ledger.head = { seq, hash };
      try{ window.__MPS_ENTERPRISE_AUDIT_HEAD = state.ledger.head; }catch{}
      try{ window.__MPS_ENTERPRISE_OFFLINE_META = { enabled:true, projectId: ensureProjectId(), projectSalt: String(window.__MPS_PROJECT_SALT||''), auditHead: state.ledger.head }; }catch{}
    }
  }catch{
    // swallow
  }

  state.ledger.appending = false;
}

async function verifyLedger(){
  try{
    if (!state.ledger.fh) await ensureLedgerHandle();
    const fh = state.ledger.fh;
    if (!fh) return { ok:false, error:'No ledger file (project folder not selected)' };

    const txt = await readHandleText(fh);
    const lines = String(txt||'').split(/\r?\n/).filter(Boolean);
    const salt = ensureProjectSalt();
    let prev = '';
    let expectSeq = 1;

    for (let i=0;i<lines.length;i++){
      const rec = _safeJson(lines[i], null);
      if (!rec || typeof rec !== 'object') return { ok:false, error:`Invalid JSON at line ${i+1}` };
      const seq = Number(rec.seq||0);
      if (seq !== expectSeq) return { ok:false, error:`Seq mismatch at line ${i+1} (got ${seq}, expected ${expectSeq})` };
      if (String(rec.prevHash||'') !== prev) return { ok:false, error:`Prev-hash mismatch at line ${i+1}` };
      const h = await sha256Hex(`${seq}|${String(rec.iso||'')}|${String(rec.type||'')}|${prev}|${JSON.stringify(rec.payload)}|${salt}`);
      if (String(rec.hash||'') !== h) return { ok:false, error:`Hash mismatch at line ${i+1}` };
      prev = h;
      expectSeq++;
    }

    return { ok:true, lines: lines.length, head: prev || '' };
  }catch(err){
    return { ok:false, error: String(err?.message||err) };
  }
}

// ---------------- UI / Wiring ----------------
function openSettingsModal({ forceIdentity=false }={}){
  // Basic modal (no external deps)
  const existing = document.getElementById('mpsEntModal');
  if (existing) existing.remove();

  const wrap = document.createElement('div');
  wrap.id = 'mpsEntModal';
  wrap.style.position = 'fixed';
  wrap.style.inset = '0';
  wrap.style.background = 'rgba(0,0,0,0.55)';
  wrap.style.display = 'flex';
  wrap.style.alignItems = 'center';
  wrap.style.justifyContent = 'center';
  wrap.style.zIndex = '9999';

  const card = document.createElement('div');
  card.style.width = '560px';
  card.style.maxWidth = '92vw';
  card.style.borderRadius = '14px';
  card.style.border = '1px solid rgba(255,255,255,0.14)';
  card.style.background = 'rgba(20,20,26,0.96)';
  card.style.boxShadow = '0 16px 55px rgba(0,0,0,0.45)';
  card.style.padding = '14px 14px 12px';
  card.style.color = 'rgba(255,255,255,0.92)';

  const title = document.createElement('div');
  title.textContent = 'Enterprise Offline';
  title.style.fontSize = '16px';
  title.style.fontWeight = '700';
  title.style.marginBottom = '10px';

  const row = (label, inputEl) => {
    const r = document.createElement('div');
    r.style.display = 'grid';
    r.style.gridTemplateColumns = '160px 1fr';
    r.style.gap = '10px';
    r.style.alignItems = 'center';
    r.style.margin = '8px 0';
    const l = document.createElement('div');
    l.textContent = label;
    l.style.opacity = '0.8';
    l.style.fontSize = '12px';
    r.appendChild(l);
    r.appendChild(inputEl);
    return r;
  };

  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = !!state.cfg.enabled;
  toggle.style.transform = 'scale(1.2)';

  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'Your name';
  name.value = state.user.name || '';
  name.style.width = '100%';
  name.style.height = '34px';
  name.style.borderRadius = '10px';
  name.style.border = '1px solid rgba(255,255,255,0.16)';
  name.style.background = 'rgba(0,0,0,0.25)';
  name.style.color = 'inherit';
  name.style.padding = '0 10px';

  const role = document.createElement('input');
  role.type = 'text';
  role.placeholder = 'Role (eg. Editorial / VFX Prod / Vendor)';
  role.value = state.user.role || '';
  role.style.cssText = name.style.cssText;

  const team = document.createElement('input');
  team.type = 'text';
  team.placeholder = 'Team / Site (optional)';
  team.value = state.user.team || '';
  team.style.cssText = name.style.cssText;

  const strict = document.createElement('input');
  strict.type = 'checkbox';
  strict.checked = !!state.cfg.strictNoNetwork;
  strict.style.transform = 'scale(1.2)';

  const note = document.createElement('div');
  note.style.fontSize = '12px';
  note.style.opacity = '0.75';
  note.style.margin = '10px 0 12px';
  note.textContent = 'Lock files + audit ledger are saved inside Documents/ast_project. All users must use the same shared folder for locking to work.';

  // If currently locked by someone else, allow supervisor takeover
  const lockedBox = document.createElement('div');
  lockedBox.style.margin = '10px 0 12px';
  lockedBox.style.padding = '10px';
  lockedBox.style.borderRadius = '12px';
  lockedBox.style.border = '1px solid rgba(255,255,255,0.14)';
  lockedBox.style.background = 'rgba(0,0,0,0.22)';

  const hasForeignLock = !!(state.readonly && state.lock && state.lock.owner?.machineId && state.lock.owner.machineId !== state.machineId);
  if (hasForeignLock){
    const by = state.lock.owner?.label || state.lock.owner?.name || '(unknown)';
    const msg = document.createElement('div');
    msg.style.fontSize = '12px';
    msg.style.opacity = '0.9';
    msg.textContent = `Currently locked by: ${by}`;
    lockedBox.appendChild(msg);

    const status = document.createElement('div');
    status.style.fontSize = '12px';
    status.style.opacity = '0.75';
    status.style.marginTop = '6px';
    status.textContent = 'Lock status: —';
    lockedBox.appendChild(status);

    const refreshStatus = ()=>{
      const ms = lockStaleInMs(state.lock);
      const stale = ms <= 0;
      const hb = String(state.lock?.heartbeatAt || state.lock?.acquiredAt || '');
      status.textContent = stale
        ? `Lock status: STALE • last heartbeat ${hb || '—'} • takeover available`
        : `Lock status: active • stale in ${fmtMs(ms)} • last heartbeat ${hb || '—'}`;
    };
    refreshStatus();

    const takeRow = document.createElement('div');
    takeRow.style.display = 'grid';
    takeRow.style.gridTemplateColumns = '1fr auto';
    takeRow.style.gap = '10px';
    takeRow.style.alignItems = 'center';
    takeRow.style.marginTop = '10px';

    const reason = document.createElement('input');
    reason.type = 'text';
    reason.placeholder = 'Reason for takeover (required)';
    reason.style.width = '100%';
    reason.style.height = '34px';
    reason.style.borderRadius = '10px';
    reason.style.border = '1px solid rgba(255,255,255,0.16)';
    reason.style.background = 'rgba(0,0,0,0.25)';
    reason.style.color = 'inherit';
    reason.style.padding = '0 10px';

    const btnTake = document.createElement('button');
    btnTake.className = 'btn theme-danger';
    const ms0 = lockStaleInMs(state.lock);
    const stale0 = ms0 <= 0;
    btnTake.textContent = stale0 ? 'Takeover (stale)' : 'Force Takeover';
    btnTake.disabled = stale0 ? false : !canForceTakeover();
    btnTake.title = stale0
      ? 'Takeover stale lock (requires reason; logged to ledger)'
      : (btnTake.disabled ? 'Requires role: Supervisor/Lead/Admin' : 'Force takeover write lock');

    takeRow.appendChild(reason);
    takeRow.appendChild(btnTake);
    lockedBox.appendChild(takeRow);

    btnTake.addEventListener('click', async (e)=>{
      e.preventDefault();
      const why = String(reason.value || '').trim();
      if (!why){
        warn.textContent = 'Takeover reason is required.';
        return;
      }
      warn.textContent = '';
      btnTake.disabled = true;
      try{
        const pn = String(document.getElementById('projectNameGlobal')?.value || state.projectName || window.__MPS_PROJECT_NAME || '').trim();
        const ms = lockStaleInMs(state.lock);
        const stale = ms <= 0;
        if (stale) await takeoverStaleLock(pn, why);
        else await forceTakeoverLock(pn, why);
        close();
      }catch(err){
        warn.textContent = String(err?.message || err || 'Takeover failed');
      }
      const ms2 = lockStaleInMs(state.lock);
      const stale2 = ms2 <= 0;
      btnTake.textContent = stale2 ? 'Takeover (stale)' : 'Force Takeover';
      btnTake.disabled = stale2 ? false : !canForceTakeover();
      refreshStatus();
    });

    // Live countdown while modal is open
    const tick = setInterval(()=>{
      try{
        if (!document.getElementById('mpsEntModal')){ clearInterval(tick); return; }
        refreshStatus();
        const ms = lockStaleInMs(state.lock);
        const stale = ms <= 0;
        btnTake.textContent = stale ? 'Takeover (stale)' : 'Force Takeover';
        btnTake.disabled = stale ? false : !canForceTakeover();
      }catch{}
    }, 1000);
  }

  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.justifyContent = 'flex-end';
  btnRow.style.gap = '10px';

  const btnCancel = document.createElement('button');
  btnCancel.textContent = forceIdentity ? 'Close' : 'Cancel';
  btnCancel.className = 'btn';

  const btnSave = document.createElement('button');
  btnSave.textContent = 'Save';
  btnSave.className = 'btn theme-amf';

  const warn = document.createElement('div');
  warn.style.fontSize = '12px';
  warn.style.color = 'rgba(255,120,120,.95)';
  warn.style.minHeight = '16px';

  btnRow.appendChild(btnCancel);
  btnRow.appendChild(btnSave);

  card.appendChild(title);
  card.appendChild(row('Enable', toggle));
  card.appendChild(row('Your name', name));
  card.appendChild(row('Role', role));
  card.appendChild(row('Team / Site', team));
  card.appendChild(row('Block network', strict));
  card.appendChild(note);
  if (hasForeignLock) card.appendChild(lockedBox);
  card.appendChild(warn);
  card.appendChild(btnRow);

  wrap.appendChild(card);
  document.body.appendChild(wrap);

  const close = () => { try{ wrap.remove(); }catch{} };

  btnCancel.addEventListener('click', (e)=>{
    e.preventDefault();
    close();
  });

  btnSave.addEventListener('click', async (e)=>{
    e.preventDefault();
    const nextUser = saveUser({ name: name.value, role: role.value, team: team.value });
    state.user = nextUser;

    const nextCfg = saveCfg({ ...state.cfg, enabled: !!toggle.checked, strictNoNetwork: !!strict.checked });
    state.cfg = nextCfg;

    if (toggle.checked && !String(nextUser.name||'').trim()){
      warn.textContent = 'Name is required for Enterprise Offline.';
      return;
    }

    setEnabled(!!toggle.checked);

    // Keep in window for other modules
    try{ window.__MPS_ENTERPRISE_OFFLINE_ENABLED = !!toggle.checked; }catch{}

    close();

    // Auto-acquire lock for current project
    if (toggle.checked){
      maybeAcquireLockSoon('settings');
    }
  });
}

function installReadOnlyGuards(showError){
  // Capture-click block for export/save actions while readonly
  const blockedIds = new Set([
    // EDL Converter (writes)
    'btnBrowseFiles','btnClear','qsAllOff',
    // Unified project
    'btnExportEDL','btnExportOTIO','cutdiffExportBtn',
    'amfExportJson','amfExportAE','amfExportNukeNK','amfExportShotsCsv','amfShotsExportSheets','amfShotsExportPdf','amfShotsExportCsv',
    'smExportXlsxBtn','smExportPdfBtn','smExportCsvBtn','smExportMarkerXmlBtn',
    'projSave','projSaveAs',
    // VFX Mapping (state-changing)
    'amfChooseFolder','amfRescan','amfClear','amfGenerateAEP','amfFlowConnect',
    // Validation fix actions (write)
    'mpsValidateFixAllBtn','mpsValidateProceedBtn',
    // write actions (Shot Marker)
    'smAddMarkerBtn','smCutDetectBtn','smCutAddBtn','smCutMergeBtn','smCutUndoBtn','smCutRedoBtn','smImportBtn',
    // write actions (Cut Diff)
    'cutdiffClearBtn','cutdiffAnalyzeBtn',
  ]);

  const allowControlIds = new Set([
    // navigation + enterprise
    'projEnterprise','projLoad','projNew','projectSelectGlobal','projectNameGlobal',
    // audit verify/copy
    'mpsAuditVerifyBtn','mpsAuditCopyBtn','mpsAuditCsvBtn','mpsAuditClearBtn',
    // shot marker playback/scrub should still work
    'smPlayBtn','smRewBtn','smFfBtn','smPrevFrameBtn','smNextFrameBtn','smFullBtn','smFitBtn','smTlFitBtn','smTlZoomInBtn','smTlZoomOutBtn','smTlZoomPctBtn','smHomeBtn','smEndBtn','smScrubRange',
    // browsing media is allowed (read-only still can load)
    'smBrowseBtn','cutdiffOldBrowse','cutdiffNewBrowse','smImportTimeline','cutdiffOldFile','cutdiffNewFile',
  ]);

  // Track pre-change values so we can revert when readonly
  document.addEventListener('focusin', (e)=>{
    if (!isEnabled() || !state.readonly) return;
    const el = e.target;
    if (!el) return;
    const id = el.id || '';
    if (allowControlIds.has(id)) return;
    if (el.matches?.('input,textarea,select')){
      try{ el.dataset.mpsPrev = (el.type === 'checkbox' ? (el.checked ? '1':'0') : String(el.value ?? '')); }catch{}
    }
    // Contenteditable
    try{
      const ce = el.closest?.('[contenteditable="true"], [contenteditable=""]');
      if (ce && ce.getAttribute('contenteditable') !== 'false'){
        ce.dataset.mpsPrevText = ce.textContent ?? '';
      }
    }catch{}
  }, true);

  // Prevent edits in contenteditable fields (used in Inspector + Shot Marker OCR cards)
  document.addEventListener('beforeinput', (e)=>{
    if (!isEnabled() || !state.readonly) return;
    const t = e.target;
    if (!t) return;
    const ce = t.closest?.('[contenteditable="true"], [contenteditable=""]');
    if (!ce) return;
    // Allow selection/copy only; block any mutation
    e.preventDefault();
    e.stopPropagation();
    try{ ce.textContent = String(ce.dataset.mpsPrevText ?? ce.textContent ?? ''); }catch{}
    try{ showError?.(String(window.__MPS_ENTERPRISE_READONLY_REASON || 'Read-only: project is locked')); }catch{}
  }, true);

  document.addEventListener('keydown', (e)=>{
    if (!isEnabled() || !state.readonly) return;
    const t = e.target;
    if (!t) return;
    const ce = t.closest?.('[contenteditable="true"], [contenteditable=""]');
    if (!ce) return;
    // Allow navigation keys + copy
    const k = e.key;
    const meta = e.metaKey || e.ctrlKey;
    const allow = meta && ['c','a','x','v','z','y'].includes(String(k||'').toLowerCase());
    const nav = ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Tab','Shift','Control','Meta','Alt','Escape','Enter'].includes(k);
    if (allow || nav) return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('input', (e)=>{
    if (!isEnabled()) return;
    if (!state.readonly) return;
    const el = e.target;
    if (!el) return;
    const id = el.id || '';
    if (allowControlIds.has(id)) return;
    if (!el.matches?.('input,textarea,select')) return;
    // File inputs: block entirely
    if (el.type === 'file'){
      e.preventDefault();
      e.stopPropagation();
      try{ el.value = ''; }catch{}
      try{ showError?.(String(window.__MPS_ENTERPRISE_READONLY_REASON || 'Read-only: project is locked')); }catch{}
      return;
    }
    // Revert
    try{
      if (el.type === 'checkbox') el.checked = (el.dataset.mpsPrev === '1');
      else el.value = String(el.dataset.mpsPrev ?? '');
    }catch{}
    e.preventDefault();
    e.stopPropagation();
    try{ showError?.(String(window.__MPS_ENTERPRISE_READONLY_REASON || 'Read-only: project is locked')); }catch{}
  }, true);

  document.addEventListener('change', (e)=>{
    if (!isEnabled()) return;
    if (!state.readonly) return;
    const el = e.target;
    if (!el) return;
    const id = el.id || '';
    if (allowControlIds.has(id)) return;
    if (!el.matches?.('input,textarea,select')) return;
    if (el.type === 'file'){
      try{ el.value = ''; }catch{}
      try{ showError?.(String(window.__MPS_ENTERPRISE_READONLY_REASON || 'Read-only: project is locked')); }catch{}
    }
    e.preventDefault();
    e.stopPropagation();
  }, true);

  document.addEventListener('click', (e)=>{
    if (!isEnabled()) return;
    if (!state.readonly) return;
    const t = e.target;
    if (!t) return;

    // Block Quick Settings toggles in EDL Converter (div buttons)
    const qs = t.closest?.('.qs-btn');
    if (qs && qs.closest?.('#main-edl')){
      e.preventDefault();
      e.stopPropagation();
      try{ showError?.(String(window.__MPS_ENTERPRISE_READONLY_REASON || 'Read-only: project is locked')); }catch{}
      return;
    }

    // Block OTIO menu items (they are buttons without ids)
    const otioItem = t.closest?.('.otio-menu-item');
    if (otioItem){
      e.preventDefault();
      e.stopPropagation();
      try{ showError?.(String(window.__MPS_ENTERPRISE_READONLY_REASON || 'Read-only: project is locked')); }catch{}
      return;
    }

    // allow clicks on approved controls
    const anyCtrl = t.closest?.('button,input,select,textarea,a');
    if (anyCtrl){
      const id = anyCtrl.id || '';
      if (allowControlIds.has(id)) return;
    }
    const btn = t.closest?.('button');
    if (!btn) return;
    const id = btn.id || '';
    if (!blockedIds.has(id)) return;

    e.preventDefault();
    e.stopPropagation();
    try{ showError?.(String(window.__MPS_ENTERPRISE_READONLY_REASON || 'Read-only: project is locked')); }catch{}
  }, true);

  // Block file drag-drop (EDL / CutDiff / ShotMarker imports) while readonly
  const blockFileDrop = (e) => {
    if (!isEnabled() || !state.readonly) return;
    const dt = e.dataTransfer;
    if (!dt) return;
    const hasFiles = (dt.files && dt.files.length) || (dt.items && Array.from(dt.items).some(it => it.kind === 'file'));
    if (!hasFiles) return;
    e.preventDefault();
    e.stopPropagation();
    try{ showError?.(String(window.__MPS_ENTERPRISE_READONLY_REASON || 'Read-only: project is locked')); }catch{}
  };
  document.addEventListener('drop', blockFileDrop, true);
  document.addEventListener('dragover', blockFileDrop, true);
}

function installAuditHook(){
  // Called from MPS_auditAdd
  try{
    window.MPS_enterpriseAppendAudit = (auditEntry) => {
      try{
        if (!isEnabled()) return;
        if (state.readonly) return;
        const e = auditEntry || null;
        queueLedgerAppend('EXPORT', e);
      }catch{}
    };
  }catch{}
}

function installProjectHooks(){
  // Called from UI when project name changes / load
  try{
    window.MPS_enterpriseOnProjectActivated = async (name) => {
      const pn = String(name||'').trim();
      if (!pn) return;
      // If project identity missing (new), ensure now
      ensureProjectId();
      ensureProjectSalt();
      await acquireLock(pn);
    };
    window.MPS_enterpriseOnProjectCleared = async () => {
      await releaseLock().catch(()=>{});
      state.projectName = '';
      state.projectId = '';
      state.lock = null;
      setReadonly(false, '');
      updatePill();
    };
    window.MPS_newProjectId = () => {
      resetProjectIdentity();
      // new lock file will be based on new id
      try{ state.ledger.fh = null; state.ledger.head = { seq: 0, hash: '' }; }catch{}
    };
  }catch{}

  // Listen to project load event
  window.addEventListener('mps:project-applied', (ev)=>{
    try{
      const d = ev?.detail || {};
      const meta = d.meta || {};
      const ent = d.enterprise || null;
      const pn = String(meta.projectName || window.__MPS_PROJECT_NAME || '').trim();
      if (ent?.projectId){
        try{ window.__MPS_PROJECT_ID = String(ent.projectId); }catch{}
      }
      if (ent?.projectSalt){
        try{ window.__MPS_PROJECT_SALT = String(ent.projectSalt); }catch{}
      }
      if (pn){
        state.projectName = pn;
        state.projectId = ensureProjectId();
        ensureProjectSalt();
        if (isEnabled()) acquireLock(pn).catch(()=>{});
      }
    }catch{}
  }, { passive: true });

  // Debounce acquire when user types project name
  const nameInput = document.getElementById('projectNameGlobal');
  if (nameInput){
    nameInput.addEventListener('input', ()=>{
      if (!isEnabled()) return;
      maybeAcquireLockSoon('name');
    }, { passive: true });
  }
}

function installVerifyButton(){
  const btn = document.getElementById('mpsAuditVerifyBtn');
  const sum = document.getElementById('mpsAuditSummary');
  if (!btn) return;

  btn.addEventListener('click', async (e)=>{
    e.preventDefault();
    btn.disabled = true;
    try{
      const r = await verifyLedger();
      if (sum){
        if (r.ok) sum.textContent = `Ledger OK ✓  (${r.lines} lines)`;
        else sum.textContent = `Ledger FAIL: ${r.error}`;
      }
    }catch(err){
      if (sum) sum.textContent = `Ledger FAIL: ${String(err?.message||err)}`;
    }
    btn.disabled = false;
  });
}

export function initEnterpriseOffline({ showError } = {}){
  state.cfg = loadCfg();
  state.user = loadUser();
  state.machineId = ensureMachineId();
  try{ window.__MPS_ENTERPRISE_OFFLINE_ENABLED = !!state.cfg.enabled; }catch{}

  // Keep a short flag that ui.js can read at boot.
  try{ localStorage.setItem('mps.enterprise.offline.enabled.v1', state.cfg.enabled ? '1' : '0'); }catch{}

  updatePill();
  installReadOnlyGuards(showError);
  installAuditHook();
  installProjectHooks();
  installVerifyButton();

  // Public helper for data-level guards in other modules.
  try{
    window.MPS_enterpriseCanWrite = () => {
      try{ return !(window.__MPS_ENTERPRISE_OFFLINE_ENABLED && window.__MPS_ENTERPRISE_READONLY); }catch{ return true; }
    };
  }catch{}

  // Wire Project Bar button
  const btn = document.getElementById('projEnterprise');
  if (btn){
    btn.addEventListener('click', (e)=>{
      e.preventDefault();
      openSettingsModal({});
    });
  }

  // Enable on boot if cfg says so
  if (state.cfg.enabled){
    setEnabled(true);
    maybeAcquireLockSoon('boot');
  }

  // Release lock best-effort
  window.addEventListener('beforeunload', () => {
    try{ stopHeartbeat(); }catch{}
    try{ releaseLock(); }catch{}
  });
}
