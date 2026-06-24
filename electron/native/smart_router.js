'use strict';

/**
 * smart_router.js — Electron-side Smart Media Playback Router
 *
 * Bridges pfx:smartMedia IPC channel to the Python companion HTTP API.
 * Routes:
 *   POST /api/media/probe
 *   POST /api/media/select-engine
 *   POST /api/media/decode-frame
 *   POST /api/media/status
 *   POST /api/media/show-logs
 *   POST /api/media/transcode-proxy
 *   POST /api/imf/open
 *   POST /api/imf/probe-cpl
 *   POST /api/imf/decode-test-frame
 *   POST /api/resolve/status
 */

const http = require('http');

let _port   = 47125;
let _token  = '';

function init(port, token) {
  _port  = port  || 47125;
  _token = token || '';
}

function _post(endpoint, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const raw     = JSON.stringify(body);
    const options = {
      hostname: '127.0.0.1',
      port:     _port,
      path:     endpoint,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(raw),
        'X-PFX-Token':    _token,
      },
    };

    // Settle guard: after a timeout rejection, the request's 'error' (from
    // destroy) or a late 'end' must not settle the promise again.
    let settled = false;
    const done = (fn) => { if (!settled) { settled = true; fn(); } };

    const timer = setTimeout(() => {
      try { req.destroy(); } catch { /* request may not be writable yet */ }
      done(() => reject(new Error(`Smart router timeout (${endpoint})`)));
    }, timeoutMs);

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        clearTimeout(timer);
        done(() => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`JSON parse error from ${endpoint}: ${data.slice(0, 200)}`));
          }
        });
      });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      done(() => reject(new Error(`HTTP ${endpoint}: ${err.message}`)));
    });

    req.write(raw);
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

async function probe(payload = {}) {
  return _post('/api/media/probe', payload);
}

async function selectEngine(payload = {}) {
  return _post('/api/media/select-engine', payload);
}

async function decodeFrame(payload = {}) {
  return _post('/api/media/decode-frame', payload, 120000);
}

async function mediaStatus() {
  return _post('/api/media/status', {});
}

async function showLogs(payload = {}) {
  return _post('/api/media/show-logs', payload);
}

async function transcodeProxy(payload = {}) {
  return _post('/api/media/transcode-proxy', payload, 300000);
}

async function imfOpen(payload = {}) {
  return _post('/api/imf/open', payload);
}

async function imfProbeCpl(payload = {}) {
  return _post('/api/imf/probe-cpl', payload, 90000);
}

async function imfDecodeTestFrame(payload = {}) {
  return _post('/api/imf/decode-test-frame', payload, 120000);
}

async function resolveStatus() {
  return _post('/api/resolve/status', {});
}

// ── IPC dispatcher ────────────────────────────────────────────────────────────

const ACTIONS = new Map([
  ['smartMedia.probe',             (p) => probe(p)],
  ['smartMedia.selectEngine',      (p) => selectEngine(p)],
  ['smartMedia.decodeFrame',       (p) => decodeFrame(p)],
  ['smartMedia.status',            ()  => mediaStatus()],
  ['smartMedia.showLogs',          (p) => showLogs(p)],
  ['smartMedia.transcodeProxy',    (p) => transcodeProxy(p)],
  ['smartMedia.imf.open',          (p) => imfOpen(p)],
  ['smartMedia.imf.probeCpl',      (p) => imfProbeCpl(p)],
  ['smartMedia.imf.decodeTestFrame',(p) => imfDecodeTestFrame(p)],
  ['smartMedia.resolve.status',    ()  => resolveStatus()],
]);

function handles(type) { return ACTIONS.has(type); }

async function route({ type, payload = {} }) {
  const fn = ACTIONS.get(type);
  if (!fn) throw new Error(`Unknown smartMedia action: ${type}`);
  return fn(payload);
}

module.exports = { init, handles, route,
  probe, selectEngine, decodeFrame, mediaStatus, showLogs, transcodeProxy,
  imfOpen, imfProbeCpl, imfDecodeTestFrame, resolveStatus };
