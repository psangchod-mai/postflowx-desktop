const APP_URL = chrome.runtime.getURL('app.html');

// ✅ Preconfigured Web App URL (your Apps Script /exec)
const DEFAULT_WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbx81hK2hQ-FOaygx6hvFN4AUI8jAvQzGUo_k0FpmbzUsUYBpCr1SLy74SPuMlnmfPti6Q/exec';

const CFG_DEFAULTS = {
  logEnabled: true,
  webhookUrl: DEFAULT_WEBHOOK_URL,
  profileEmail: '',
  clientId: '',
  heartbeatMinutes: 10,
  syncLabelsEnabled: true,
  labelsSyncMinutes: 60,
};

function nowIso(){ return new Date().toISOString(); }

function base64UrlEncode(str){
  try {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i=0; i<bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin);
    return b64.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  } catch {
    // fallback (ASCII only)
    return btoa(str).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
}

async function sendLogViaGet_(execUrl, logObj){
  const p = base64UrlEncode(JSON.stringify(logObj));
  const url = `${execUrl}?action=log&p=${encodeURIComponent(p)}`;
  const resp = await fetch(url, { method: 'GET', credentials: 'include', signal: AbortSignal.timeout(15000) });
  // Best-effort parse json; Apps Script may redirect but still returns JSON
  let data = null;
  try { data = await resp.json(); } catch { try { data = await resp.text(); } catch {} }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return data;
}


function randId(){
  try {
    const a = new Uint8Array(16);
    crypto.getRandomValues(a);
    return Array.from(a).map(b=>b.toString(16).padStart(2,'0')).join('');
  } catch {
    return String(Math.random()).slice(2) + String(Date.now());
  }
}

async function getCfg(){
  const cfg = await chrome.storage.sync.get(CFG_DEFAULTS);
  if (!cfg.webhookUrl) {
    cfg.webhookUrl = DEFAULT_WEBHOOK_URL;
    try { await chrome.storage.sync.set({ webhookUrl: DEFAULT_WEBHOOK_URL }); } catch {}
  }
  if (!cfg.clientId) {
    cfg.clientId = randId();
    await chrome.storage.sync.set({ clientId: cfg.clientId });
  }
  return cfg;
}

async function tryGetIdentityEmail(){
  try {
    const info = await chrome.identity.getProfileUserInfo({});
    return info?.email ? String(info.email) : '';
  } catch {
    return '';
  }
}

async function enqueue_(payload){
  const st = await chrome.storage.local.get({ pendingLogs: [] });
  const arr = Array.isArray(st.pendingLogs) ? st.pendingLogs : [];
  arr.push(payload);
  while (arr.length > 200) arr.shift();
  await chrome.storage.local.set({ pendingLogs: arr });
}

async function flushQueue_(cfg){
  const st = await chrome.storage.local.get({ pendingLogs: [] });
  const arr = Array.isArray(st.pendingLogs) ? st.pendingLogs : [];
  if (!arr.length) return { ok:true, flushed:0 };

  const url = normalizeExecUrl(cfg.webhookUrl);
  if (!url) return { ok:false, error:'Missing webhookUrl' };

  // Send in small batches to avoid URL length limits (GET with base64 payload)
  const batch = arr.slice(0, 10);
  let flushed = 0;
  try {
    for (const log of batch) {
      await sendLogViaGet_(url, log);
      flushed++;
    }
    const remain = arr.slice(flushed);
    await chrome.storage.local.set({ pendingLogs: remain, lastLogOkAt: nowIso(), lastLogError: '' });
    return { ok:true, flushed };
  } catch (e) {
    const msg = String(e && (e.message || e));
    await chrome.storage.local.set({ lastLogError: msg });
    return { ok:false, error: msg, flushed };
  }
}

async function sendLog(activityType, meta = {}){
  const cfg = await getCfg();
  if (!cfg.logEnabled) return { ok:false, skipped:true };

  const url = (cfg.webhookUrl || '').trim();
  if (!url) {
    await chrome.storage.local.set({ lastLogError: 'Missing webhookUrl' });
    return { ok:false, error:'Missing webhookUrl' };
  }

  const idEmail = await tryGetIdentityEmail();
  const payload = {
    timestamp_iso: nowIso(),
    timestamp_local: new Date().toString(),
    profile_email: idEmail || cfg.profileEmail || '',
    activity_type: activityType,
    client_id: cfg.clientId || '',
    extension_version: chrome.runtime.getManifest().version,
    chrome_user_agent: (typeof navigator !== 'undefined' && navigator.userAgent) ? navigator.userAgent : '',
    notes: meta && Object.keys(meta).length ? JSON.stringify(meta) : '',
  };

  // Best-effort flush previous
  try { await flushQueue_(cfg); } catch {}

  try {
    await sendLogViaGet_(url, payload);
    await chrome.storage.local.set({ lastLogOkAt: nowIso(), lastLogError: '' });
    return { ok:true };
  } catch (e) {
    const msg = String(e?.message || e);
    await chrome.storage.local.set({ lastLogError: msg });
    await enqueue_(payload);
    return { ok:false, error: msg };
  }
}

async function syncGroupLabels(){
  const cfg = await getCfg();
  if (!cfg.syncLabelsEnabled) return { ok:false, skipped:true };
  const url = (cfg.webhookUrl || '').trim();
  if (!url) return { ok:false, error:'Missing webhookUrl' };

  try {
    const resp = await fetch(`${url}?action=getGroupLabels`, { method:'GET', credentials:'include', redirect:'follow', cache:'no-store', signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json || json.ok !== true) throw new Error(json?.error || 'Bad response');
    const groupLabels = json.groupLabels || null;
    if (!groupLabels || typeof groupLabels !== 'object') throw new Error('Missing groupLabels');

    await chrome.storage.local.set({
      groupLabelsOverride: groupLabels,
      groupLabelsOverrideVersion: json.version || nowIso(),
      lastLabelSyncAt: nowIso(),
      lastLabelSyncError: '',
    });
    return { ok:true };
  } catch (e) {
    const msg = String(e?.message || e);
    await chrome.storage.local.set({ lastLabelSyncError: msg });
    return { ok:false, error: msg };
  }
}

function scheduleAlarms(){
  chrome.alarms.create('bwav_heartbeat', { periodInMinutes: CFG_DEFAULTS.heartbeatMinutes });
  chrome.alarms.create('bwav_labels_sync', { periodInMinutes: CFG_DEFAULTS.labelsSyncMinutes });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'bwav_heartbeat') sendLog('Heartbeat').catch(()=>{});
  if (alarm.name === 'bwav_labels_sync') syncGroupLabels().catch(()=>{});
});

async function openOrFocusApp(){
  const tabs = await chrome.tabs.query({ url: APP_URL });
  if (tabs?.length) {
    const t = tabs[0];
    await chrome.tabs.update(t.id, { active: true });
    if (t.windowId) await chrome.windows.update(t.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: APP_URL });
}

chrome.action.onClicked.addListener(() => {
  openOrFocusApp().catch(()=>chrome.tabs.create({ url: APP_URL }));
  sendLog('Open App').catch(()=>{});
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleAlarms();
  sendLog('Installed').catch(()=>{});
  syncGroupLabels().catch(()=>{});
});

chrome.runtime.onStartup.addListener(() => {
  scheduleAlarms();
  sendLog('Startup').catch(()=>{});
  syncGroupLabels().catch(()=>{});
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'USERLOG') {
    sendLog(msg.activityType || msg.activity || 'Event', msg.meta || {}).then(r=>sendResponse(r));
    return true;
  }

  if (msg.type === 'SYNC_LABELS') {
    syncGroupLabels().then(r=>sendResponse(r));
    return true;
  }

  if (msg.type === 'FLUSH_LOGS') {
    getCfg().then(cfg=>flushQueue_(cfg)).then(r=>sendResponse(r));
    return true;
  }

  if (msg.type === 'PING_WEBHOOK') {
    (async () => {
      const cfg = await getCfg();
      const url = (cfg.webhookUrl || '').trim();
      if (!url) return sendResponse({ ok:false, error:'Missing webhookUrl' });
      try {
        const resp = await fetch(url, { method:'GET', credentials:'include', redirect:'follow', cache:'no-store', signal: AbortSignal.timeout(10000) });
        const txt = await resp.text();
        sendResponse({ ok: resp.ok, status: resp.status, body: txt.slice(0, 500) });
      } catch (e) {
        sendResponse({ ok:false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
});
