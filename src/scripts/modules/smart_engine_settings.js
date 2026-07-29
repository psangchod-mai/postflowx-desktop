'use strict';

/**
 * smart_engine_settings.js — Smart Playback Engine settings panel controller
 *
 * Hooks up all buttons inside #smartEnginePanel:
 *   Check Engines    → pfxPlatform.smartMedia.status()
 *   Decode Test Frame → prompt for file, then decodeFrame(...)
 *   IMF Decode Test  → use currently loaded IMF package, or prompt
 *   Generate Test Proxy → prompt for file, kick off proxy generation
 *   Show Logs        → load all 4 log channels, tabbed display
 *   Repair Engines   → print the install instructions into the logs panel
 *
 * The Repair Engines line used to read "open brew install guide in external
 * browser". It has never opened a browser; it writes into the panel below.
 * Corrected in place rather than deleted — a comment that describes a
 * behaviour the function does not have is worth recording as its own defect.
 *
 * Failure text: every status line in this panel goes through friendlyStatus,
 * because four of friendlyError's sixteen hints send the user *here* to fix
 * something. Arriving at the repair screen and being handed a second raw
 * errno is the end of the trail for a non-technical reader. Each call passes
 * "<what was being done> failed: <raw>" — friendlyStatus keeps the prefix
 * (it needs a space before the colon to do so) and humanizes the tail.
 */

import { buildBadge, engineColor } from './smart_playback_engine.js';
import { friendlyAlert } from '../core/friendlyAlert.js';
import { friendlyStatus, translate } from '../core/friendlyError.js';

const STATUS_COLOR = {
  ready:   '#2ecc71',
  partial: '#e67e22',
  missing: '#e74c3c',
  unknown: '#7f8c8d',
};

function _q(id)   { return document.getElementById(id); }
function _pfx()   { return window.pfxPlatform?.smartMedia ?? null; }
function _isElectron() { return !!window.__PFX_IS_ELECTRON; }

// ── Render engine status rows ─────────────────────────────────────────────────

function _renderEngineRows(engines = []) {
  const list = _q('smartEngineStatusList');
  if (!list) return;
  if (!engines.length) {
    list.innerHTML = '<div style="font-size:9px;color:rgba(255,255,255,.35);">No engine data returned.</div>';
    return;
  }
  list.innerHTML = engines.map((e) => {
    const color   = STATUS_COLOR[e.status] || STATUS_COLOR.unknown;
    const dot     = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${color};flex-shrink:0;margin-top:1px;"></span>`;
    const detail  = e.detail  ? `<span style="color:rgba(255,255,255,.4);font-size:8px;margin-left:4px;">${_esc(e.detail)}</span>`  : '';
    const version = e.version ? `<span style="color:rgba(255,255,255,.35);font-size:8px;margin-left:4px;">${_esc(e.version)}</span>` : '';
    return `<div style="display:flex;align-items:flex-start;gap:6px;font-size:9px;line-height:1.4;">
      ${dot}
      <div style="flex:1;min-width:0;">
        <span style="color:rgba(255,255,255,.85);">${_esc(e.label)}</span>
        ${version}${detail}
      </div>
      <span style="font-size:8px;color:${color};flex-shrink:0;">${_esc(e.status)}</span>
    </div>`;
  }).join('');
}

function _esc(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Check Engines ─────────────────────────────────────────────────────────────

let _checkEnginesSeq = 0;

async function checkEngines() {
  const btn  = _q('smartEngineCheckBtn');
  const list = _q('smartEngineStatusList');
  if (!list) return;

  if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
  list.innerHTML = '<div style="font-size:9px;color:rgba(255,255,255,.35);">Scanning engines…</div>';

  const seq = ++_checkEnginesSeq;

  try {
    const api = _pfx();
    let engines = [];
    if (api) {
      const r = await api.status();
      engines = Array.isArray(r?.engines) ? r.engines : (Array.isArray(r) ? r : []);
    } else {
      // Chrome extension path via companion HTTP
      const { getCompanionUrl, getCompanionToken } = await _companionConfig();
      const resp = await fetch(`${getCompanionUrl}/api/media/status`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-PFX-Token': getCompanionToken },
        body: '{}',
      });
      const data = await resp.json();
      engines = Array.isArray(data?.engines) ? data.engines : [];
    }
    if (seq !== _checkEnginesSeq) return; // superseded by a newer check
    _renderEngineRows(engines);
  } catch (err) {
    if (seq !== _checkEnginesSeq) return; // superseded by a newer check
    const line = friendlyStatus(`${translate('Engine check failed')}: ${err.message}`);
    list.innerHTML = `<div style="font-size:9px;color:#e74c3c;white-space:pre-wrap;">${_esc(line)}</div>`;
  } finally {
    if (seq === _checkEnginesSeq && btn) { btn.disabled = false; btn.textContent = 'Check Engines'; }
  }
}

// friendlyStatus puts its advice on a line of its own, and the elements these
// failures land in are plain <div>s in index.html with default white-space,
// where a newline collapses straight back to a space — the same collapse
// iteration 22 removed from the error banner. The markup is not ours to change
// from here, so the property is set where the text is written, which is what
// errorBanner.js does for the same reason.
function _setStatusText(el, text) {
  if (!el) return;
  el.style.whiteSpace = 'pre-wrap';
  el.textContent = text;
}

// ── Decode Test Frame ─────────────────────────────────────────────────────────

// Decode Test Frame, IMF Decode Test and Generate Test Proxy all write their
// outcome into the same smartEngineDecodeResult/Label/Img elements. Each is
// its own async round trip kicked off by its own button, so clicking a second
// one before the first's file/folder picker + backend call resolves is not
// prevented — without a guard, whichever call's await resolves last wins the
// shared panel even if it started first and is now stale.
let _decodeResultSeq = 0;

async function decodeTestFrame() {
  const btn = _q('smartEngineDecodeTestBtn');
  if (!_isElectron()) {
    alert('Decode Test Frame requires the PostFlowX Desktop app.');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Picking…'; }
  const seq = ++_decodeResultSeq;

  try {
    const filePath = await window.pfxPlatform.pickFile({
      title:   'Pick a media file to decode test frame',
      filters: [{ name: 'Media', extensions: ['mov','mp4','mxf','dpx','exr','r3d','ari','braw','j2c'] }],
    });
    if (!filePath) return;

    if (btn) btn.textContent = 'Decoding…';

    const api = _pfx();
    let r;
    if (api) {
      r = await api.decodeFrame({ path: filePath, frameNumber: 0, fps: 24 });
    } else {
      throw new Error('pfxPlatform.smartMedia unavailable');
    }

    if (seq !== _decodeResultSeq) return; // superseded by a newer decode/proxy/IMF call

    const resultEl = _q('smartEngineDecodeResult');
    const labelEl  = _q('smartEngineDecodeLabel');
    const imgEl    = _q('smartEngineDecodeImg');
    if (!resultEl || !labelEl || !imgEl) return;

    if (r?.ok && r?.imageDataUrl) {
      labelEl.textContent = `Engine: ${r.engine || '?'}  ·  Frame: ${r.frameNumber ?? 0}  ·  ${filePath.split('/').pop()}`;
      imgEl.src = r.imageDataUrl;
      resultEl.style.display = '';
    } else if (r?.ok && r?.imagePath) {
      labelEl.textContent = `Engine: ${r.engine || '?'}  ·  Frame: ${r.frameNumber ?? 0}  ·  ${r.imagePath}`;
      imgEl.src = `file://${r.imagePath}`;
      resultEl.style.display = '';
    } else {
      const msg = r?.error || r?.stderr?.slice(0, 200) || 'no reason was reported';
      _setStatusText(labelEl, friendlyStatus(`${translate('Decode test failed')}: ${msg}`));
      imgEl.src = '';
      resultEl.style.display = '';
    }
  } catch (err) {
    if (seq !== _decodeResultSeq) return;
    const labelEl = _q('smartEngineDecodeLabel');
    _setStatusText(labelEl, friendlyStatus(`${translate('Decode test failed')}: ${err.message}`));
    const resultEl = _q('smartEngineDecodeResult');
    if (resultEl) resultEl.style.display = '';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Decode Test Frame'; }
  }
}

// ── IMF Decode Test ───────────────────────────────────────────────────────────

async function imfDecodeTest() {
  const btn = _q('smartEngineImfDecodeBtn');
  if (!_isElectron()) {
    alert('IMF Decode Test requires the PostFlowX Desktop app.');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Picking IMF…'; }
  const seq = ++_decodeResultSeq;

  try {
    const folderPath = await window.pfxPlatform.pickFolder({ title: 'Select IMF Package Folder' });
    if (!folderPath) return;

    if (btn) btn.textContent = 'Opening…';
    const api = _pfx();
    if (!api) throw new Error('pfxPlatform.smartMedia unavailable');

    const openResult = await api.imfOpen({ folderPath });
    if (!openResult?.ok) {
      throw new Error(openResult?.errors?.[0] || openResult?.error || 'Failed to open IMF package');
    }

    const reels       = openResult.playableReels || [];
    const firstReel   = reels[0];
    if (!firstReel) throw new Error('No playable reels found in this IMF package');

    const cplPath      = firstReel.cplPath || firstReel.cpl;
    const assetMaps    = openResult.assetMaps || openResult.assetMapPaths || [];
    if (!cplPath) throw new Error('Could not determine CPL path from package');

    if (btn) btn.textContent = 'Decoding…';
    const decodeResult = await api.imfDecodeTestFrame({ cplPath, assetMapPaths: assetMaps, frameNumber: 0 });

    if (seq !== _decodeResultSeq) return; // superseded by a newer decode/proxy/IMF call

    const resultEl = _q('smartEngineDecodeResult');
    const labelEl  = _q('smartEngineDecodeLabel');
    const imgEl    = _q('smartEngineDecodeImg');
    if (!resultEl || !labelEl || !imgEl) return;

    if (decodeResult?.ok && decodeResult?.imageDataUrl) {
      labelEl.textContent = `IMF · Engine: ${decodeResult.engine || decodeResult.backend || '?'}  ·  Codec: ${decodeResult.codec || '?'}  ·  ${cplPath.split('/').pop()}`;
      imgEl.src = decodeResult.imageDataUrl;
      resultEl.style.display = '';
    } else {
      const msg = (decodeResult?.errors || []).join('; ') || decodeResult?.error || 'no reason was reported';
      _setStatusText(labelEl, friendlyStatus(`${translate('IMF decode test failed')}: ${msg}`));
      imgEl.src = '';
      resultEl.style.display = '';
    }
  } catch (err) {
    if (seq !== _decodeResultSeq) return;
    const labelEl = _q('smartEngineDecodeLabel');
    _setStatusText(labelEl, friendlyStatus(`${translate('IMF decode test failed')}: ${err.message}`));
    const resultEl = _q('smartEngineDecodeResult');
    if (resultEl) resultEl.style.display = '';
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'IMF Decode Test'; }
  }
}

// ── Generate Test Proxy ───────────────────────────────────────────────────────

async function generateTestProxy() {
  const btn = _q('smartEngineProxyTestBtn');
  if (!_isElectron()) {
    alert('Proxy generation requires the PostFlowX Desktop app.');
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Picking…'; }
  const seq = ++_decodeResultSeq;

  try {
    const filePath = await window.pfxPlatform.pickFile({
      title:   'Pick a media file to proxy',
      filters: [{ name: 'Media', extensions: ['mov','mp4','mxf','r3d','braw','ari'] }],
    });
    if (!filePath) return;

    const outputDir = await window.pfxPlatform.pickFolder({ title: 'Select output folder for proxy' });
    if (!outputDir) return;

    if (btn) btn.textContent = 'Generating…';
    const api = _pfx();
    if (!api) throw new Error('pfxPlatform.smartMedia unavailable');

    const sessionId = `proxy_test_${Date.now()}`;
    const r = await api.transcodeProxy({
      sourcePath: filePath,
      outputDir,
      sessionId,
      codec: 'h264',
      scale: 1920,
    });

    if (seq !== _decodeResultSeq) return; // superseded by a newer decode/proxy/IMF call

    const labelEl = _q('smartEngineDecodeLabel');
    const resultEl = _q('smartEngineDecodeResult');
    if (labelEl) {
      labelEl.textContent = r?.ok
        ? `Proxy queued (session: ${sessionId}). Check proxy folder: ${outputDir}/proxies/`
        // 'unknown' was the previous fallback, and it read as if the app knew
        // something it would not say. It does not know; say that instead.
        : friendlyStatus(`${translate('Test proxy failed')}: ${r?.error || 'no reason was reported'}`);
    }
    if (resultEl) {
      resultEl.style.display = '';
      const imgEl = _q('smartEngineDecodeImg');
      if (imgEl) imgEl.src = '';
    }
  } catch (err) {
    // "Proxy error: <errno>" named the feature but not the operation, and left
    // the errno on screen. The button says Generate Test Proxy; so does this.
    friendlyAlert(err, 'Test proxy generation failed');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Generate Test Proxy'; }
  }
}

// ── Show Logs ─────────────────────────────────────────────────────────────────

let _logsData = {};

async function showLogs() {
  const btn    = _q('smartEngineShowLogsBtn');
  const panel  = _q('smartEngineLogsPanel');
  const content = _q('smartEngineLogsContent');
  if (!panel || !content) return;

  if (panel.style.display !== 'none') {
    panel.style.display = 'none';
    if (btn) btn.textContent = 'Show Logs';
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

  try {
    const api = _pfx();
    let logs = {};
    if (api) {
      const r = await api.showLogs({ lines: 200 });
      logs = r?.logs ?? r ?? {};
    } else {
      const { getCompanionUrl, getCompanionToken } = await _companionConfig();
      const resp = await fetch(`${getCompanionUrl}/api/media/show-logs`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'X-PFX-Token': getCompanionToken },
        body: JSON.stringify({ lines: 200 }),
      });
      const data = await resp.json();
      logs = data?.logs ?? data ?? {};
    }
    _logsData = logs;
    _renderActiveLogTab();
    panel.style.display = '';
    if (btn) btn.textContent = 'Hide Logs';
  } catch (err) {
    _setStatusText(content, friendlyStatus(`${translate('Loading the engine logs failed')}: ${err.message}`));
    panel.style.display = '';
    if (btn) btn.textContent = 'Hide Logs';
  } finally {
    if (btn) btn.disabled = false;
  }
}

function _renderActiveLogTab() {
  const content = _q('smartEngineLogsContent');
  if (!content) return;
  const activeTab = document.querySelector('#smartEngineLogsTabs .smart-log-tab.is-active');
  const channel   = activeTab?.dataset?.log || 'playback';
  const text      = _logsData[channel] || '(no log data)';
  content.textContent = text;
  content.scrollTop   = content.scrollHeight;
}

// ── Repair Engines ────────────────────────────────────────────────────────────

function repairEngines() {
  // The button is called Repair Engines, so a reader expects the app to do the
  // repairing. It cannot — these are system-wide packages and installing them
  // needs an admin password in a terminal. What the button can honestly do is
  // hand over instructions somebody who has never opened Terminal can follow,
  // which means saying what the engines are, what the steps are, and what a
  // prompt for a password means. The bare `brew install` list this used to
  // print assumed all of that.
  const instructions = [
    'Repair engines',
    '',
    'PostFlowX decodes and plays media using a few free helper programs, called',
    'engines. They are not part of PostFlowX and it cannot install them for you,',
    'so anything Check Engines listed as missing has to be installed on this Mac',
    'once. This is a copy-and-paste job — you are not writing any code.',
    '',
    '  1. Open the Terminal app (press Command + Space, type Terminal, Return).',
    '  2. Copy one line below, paste it into Terminal, press Return, and let it',
    '     finish before you paste the next one.',
    '  3. When they are all done, come back here and click Check Engines.',
    '',
    'The lines use Homebrew, the usual way to install tools like these on macOS.',
    'If Terminal answers "command not found: brew", install Homebrew first from',
    'https://brew.sh and then start again at step 1. You may be asked for your',
    'Mac password; nothing appears on screen while you type it, which is normal.',
    '',
    'For normal playback:',
    '',
    '    brew install ffmpeg',
    '    brew install mpv',
    '',
    'For IMF packages (the second line rebuilds ffmpeg and can take a while):',
    '',
    '    brew install libxml2',
    '    brew reinstall ffmpeg',
    '',
    'For JPEG 2000 and HTJ2K material:',
    '',
    '    brew install openjpeg',
    '    brew install libopenjph',
    '',
    'None of this touches your footage or your projects. If a line fails, the',
    'text Terminal prints back is the useful thing to send to support.',
  ].join('\n');

  if (_isElectron()) {
    // Printed straight into the panel's content element, NOT through
    // _logsData/_renderActiveLogTab. That pair was the defect: the write went
    // to the fixed 'playback' key while the render reads whichever tab carries
    // .is-active, so with IMF, Proxy or Resolve selected the instructions
    // landed in a channel nobody was looking at and the button did visibly
    // nothing. On the Playback tab it did show them — by destroying the log
    // that had just been fetched, until the next Show Logs. Writing to the
    // element covers both: the text always appears, no log is overwritten, and
    // clicking any tab calls _renderActiveLogTab() and hands the panel back.
    const content = _q('smartEngineLogsContent');
    const panel   = _q('smartEngineLogsPanel');
    if (content && panel) {
      content.textContent = instructions;
      content.scrollTop   = 0;   // instructions are read from the top; logs from the bottom
      panel.style.display = '';
    }
  } else {
    alert(instructions);
  }
}

// ── Companion config helper (for Chrome extension path) ──────────────────────

async function _companionConfig() {
  const stored = (typeof pfxStorage !== 'undefined' && pfxStorage?.get)
    ? await pfxStorage.get(['companionUrl', 'companionToken'])
    : {};
  return {
    getCompanionUrl:   stored.companionUrl   || 'http://127.0.0.1:47125',
    getCompanionToken: stored.companionToken || '',
  };
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function init() {
  const checkBtn    = _q('smartEngineCheckBtn');
  const decodeBtn   = _q('smartEngineDecodeTestBtn');
  const imfBtn      = _q('smartEngineImfDecodeBtn');
  const proxyBtn    = _q('smartEngineProxyTestBtn');
  const logsBtn     = _q('smartEngineShowLogsBtn');
  const repairBtn   = _q('smartEngineRepairBtn');
  const logsTabs    = document.getElementById('smartEngineLogsTabs');

  if (checkBtn)  checkBtn.addEventListener('click',  () => checkEngines());
  if (decodeBtn) decodeBtn.addEventListener('click', () => decodeTestFrame());
  if (imfBtn)    imfBtn.addEventListener('click',    () => imfDecodeTest());
  if (proxyBtn)  proxyBtn.addEventListener('click',  () => generateTestProxy());
  if (logsBtn)   logsBtn.addEventListener('click',   () => showLogs());
  if (repairBtn) repairBtn.addEventListener('click', () => repairEngines());

  if (logsTabs) {
    logsTabs.addEventListener('click', (e) => {
      const tab = e.target.closest('.smart-log-tab');
      if (!tab) return;
      logsTabs.querySelectorAll('.smart-log-tab').forEach((t) => t.classList.remove('is-active'));
      tab.classList.add('is-active');
      _renderActiveLogTab();
    });
  }

  // Auto-check engines when the Settings ltab is opened
  document.getElementById('imfTabSettings')?.addEventListener('click', () => {
    const list = _q('smartEngineStatusList');
    if (list && list.textContent.includes('Check Engines')) {
      checkEngines();
    }
  });
}
