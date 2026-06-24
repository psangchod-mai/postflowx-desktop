const $ = (s) => document.querySelector(s);

const DEFAULT_EXEC = 'https://script.google.com/macros/s/AKfycbx81hK2hQ-FOaygx6hvFN4AUI8jAvQzGUo_k0FpmbzUsUYBpCr1SLy74SPuMlnmfPti6Q/exec';

const DEFAULTS = {
  defaultMode: 'backlot',
  strictMode: false,
  webhookUrl: DEFAULT_EXEC,
  logEnabled: true,
  profileEmail: '',
  clientId: '',
  syncLabelsEnabled: true,
};

function setStatus(msg){ $('#status').textContent = msg || '—'; }

async function refreshState(){
  const local = await chrome.storage.local.get({
    lastLogOkAt: '', lastLogError: '', pendingLogs: [],
    lastLabelSyncAt: '', lastLabelSyncError: '', groupLabelsOverrideVersion: ''
  });

  const pending = Array.isArray(local.pendingLogs) ? local.pendingLogs.length : 0;
  $('#logState').textContent = `${local.lastLogOkAt ? 'Last OK: ' + local.lastLogOkAt : 'Last OK: —'} • Pending: ${pending} • ${local.lastLogError ? 'Last error: ' + local.lastLogError : 'Last error: —'}`;
  $('#syncState').textContent = `${local.lastLabelSyncAt ? 'Last sync: ' + local.lastLabelSyncAt : 'Last sync: —'} • ${local.groupLabelsOverrideVersion ? 'Version: ' + local.groupLabelsOverrideVersion : 'Version: —'} • ${local.lastLabelSyncError ? 'Last error: ' + local.lastLabelSyncError : 'Last error: —'}`;
}

async function load(){
  const stored = await chrome.storage.sync.get(DEFAULTS);
  $('#mode').value = stored.defaultMode;
  $('#strictMode').checked = !!stored.strictMode;

  $('#webhookUrl').value = stored.webhookUrl || DEFAULT_EXEC;
  $('#logEnabled').checked = stored.logEnabled !== false;
  $('#profileEmail').value = stored.profileEmail || '';
  $('#clientId').value = stored.clientId || '';

  setStatus('Loaded.');
  await refreshState();
}

async function save(){
  await chrome.storage.sync.set({
    defaultMode: $('#mode').value,
    strictMode: $('#strictMode').checked,
    webhookUrl: ($('#webhookUrl').value || '').trim(),
    logEnabled: $('#logEnabled').checked,
    profileEmail: ($('#profileEmail').value || '').trim(),
    syncLabelsEnabled: true,
  });
  setStatus('Saved.');
  await refreshState();
}

async function ping(){
  setStatus('Pinging…');
  await save();
  const res = await chrome.runtime.sendMessage({ type:'PING_WEBHOOK' });
  setStatus(res?.ok ? `Ping OK (HTTP ${res.status})` : `Ping failed: ${res?.error || 'Unknown'}`);
  await refreshState();
}

async function flush(){
  setStatus('Flushing…');
  await save();
  const res = await chrome.runtime.sendMessage({ type:'FLUSH_LOGS' });
  setStatus(res?.ok ? `Flushed ${res.flushed || 0}` : `Flush failed: ${res?.error || 'Unknown'}`);
  await refreshState();
}

async function syncLabels(){
  $('#syncStatus').textContent = 'Syncing…';
  await save();
  const res = await chrome.runtime.sendMessage({ type:'SYNC_LABELS' });
  $('#syncStatus').textContent = res?.ok ? 'Sync OK' : `Sync failed: ${res?.error || 'Unknown'}`;
  await refreshState();
}

$('#save').addEventListener('click', save);
$('#btnPing').addEventListener('click', ping);
$('#btnFlush').addEventListener('click', flush);
$('#btnSync').addEventListener('click', syncLabels);

load();
