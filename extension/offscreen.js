const IMF_COMPANION_HOST = 'com.postflowx.companion';
const state = { port: null, pending: new Map(), seq: 0 };
const debugState = { route: 'OFFSCREEN', lastEvent: 'BOOT', lastError: '', connected: false, lastAction: '', lastUpdated: 0, events: [] };

function recordDebug(event, extra = {}) {
  try {
    const stamp = new Date().toLocaleTimeString([], { hour12: false });
    debugState.lastEvent = String(event || '');
    debugState.lastUpdated = Date.now();
    if (typeof extra.connected === 'boolean') debugState.connected = extra.connected;
    if (typeof extra.lastAction === 'string') debugState.lastAction = extra.lastAction;
    if (typeof extra.lastError === 'string') debugState.lastError = extra.lastError;
    const detail = String(extra.detail || '').trim();
    const line = detail ? `${stamp} ${event} :: ${detail}` : `${stamp} ${event}`;
    debugState.events = [line, ...(debugState.events || [])].slice(0, 12);
  } catch (_) {}
}

function snapshotDebug() {
  return { ...debugState, events: Array.isArray(debugState.events) ? [...debugState.events] : [] };
}

function normalizeError(err) {
  return {
    code: String(err?.code || ''),
    message: String(err?.message || 'Companion host error'),
    userMessage: String(err?.userMessage || ''),
  };
}

function connectCompanion() {
  if (state.port) return state.port;
  try {
    const port = chrome.runtime.connectNative(IMF_COMPANION_HOST);
    state.port = port;
    recordDebug('CONNECT_OK', { connected: true, detail: IMF_COMPANION_HOST });

    port.onMessage.addListener((msg) => {
      const id = msg && typeof msg === 'object' ? msg._id : undefined;
      if (id === undefined || !state.pending.has(id)) return;
      const job = state.pending.get(id);
      state.pending.delete(id);
      try { clearTimeout(job.timer); } catch (_) {}
      if (msg?.status === 'error') {
        recordDebug('CALL_ERROR', { connected: true, lastAction: String(msg?.action || debugState.lastAction || ''), lastError: String(msg?.error?.message || msg?.error || '') });
        job.reject(normalizeError(msg?.error || {}));
      } else {
        recordDebug('CALL_OK', { connected: true, lastAction: String(msg?.action || debugState.lastAction || ''), detail: String(msg?.data?.sessionId || msg?.data?.streamUrl || msg?.status || 'ok') });
        job.resolve(msg);
      }
    });

    port.onDisconnect.addListener(() => {
      const lastErr = chrome.runtime.lastError?.message || '';
      recordDebug('DISCONNECT', { connected: false, lastError: lastErr || '' });
      const pending = Array.from(state.pending.values());
      state.pending.clear();
      state.port = null;
      for (const job of pending) {
        try { clearTimeout(job.timer); } catch (_) {}
        job.reject({
          code: 'HOST_DISCONNECTED',
          message: lastErr || 'Companion host disconnected',
          userMessage: lastErr || '',
        });
      }
    });

    return port;
  } catch (err) {
    state.port = null;
    recordDebug('CONNECT_FAIL', { connected: false, lastError: err?.message || String(err) });
    return null;
  }
}

function sendCompanion(payload, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const port = connectCompanion();
    if (!port) {
      recordDebug('CALL_NO_PORT', { connected: false, lastAction: String(payload?.action || '') });
      reject({ code: 'host_unavailable', message: 'Companion host unavailable', userMessage: '' });
      return;
    }
    const id = ++state.seq;
    recordDebug('CALL_BEGIN', { connected: true, lastAction: String(payload?.action || ''), detail: String(payload?.action || '') });
    const timer = setTimeout(() => {
      state.pending.delete(id);
      recordDebug('CALL_TIMEOUT', { connected: true, lastAction: String(payload?.action || ''), lastError: 'timeout' });
      reject({ code: 'host_timeout', message: 'Companion host timeout', userMessage: '' });
    }, Math.max(1000, Number(timeoutMs) || 20000));
    state.pending.set(id, { resolve, reject, timer });
    try {
      port.postMessage({ ...(payload || {}), _id: id });
    } catch (err) {
      state.pending.delete(id);
      try { clearTimeout(timer); } catch (_) {}
      recordDebug('CALL_POST_FAIL', { connected: true, lastAction: String(payload?.action || ''), lastError: err?.message || String(err) });
      reject({ code: 'POST_FAILED', message: err?.message || String(err), userMessage: '' });
    }
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return undefined;

  if (msg.type === 'IMF_OFFSCREEN_PING') {
    sendResponse({ ok: true, connected: !!state.port });
    return undefined;
  }

  if (msg.type === 'IMF_OFFSCREEN_DEBUG_GET') {
    sendResponse({ ok: true, debug: snapshotDebug() });
    return undefined;
  }

  if (msg.type === 'IMF_OFFSCREEN_CALL') {
    sendCompanion(msg.payload || {}, msg.timeoutMs || 20000)
      .then((response) => sendResponse({ ok: true, response }))
      .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
    return true;
  }

  return undefined;
});

connectCompanion();
