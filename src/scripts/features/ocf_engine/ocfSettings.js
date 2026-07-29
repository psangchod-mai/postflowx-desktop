'use strict';
/**
 * OCF Engine Settings Panel.
 *
 * Renders the "Settings > OCF Playback Engine" section into a provided container.
 * Shows SDK status rows, buttons for check/test/logs/repair.
 *
 * Usage:
 *   import { OcfSettingsPanel } from './ocf_engine/ocfSettings.js';
 *   const panel = new OcfSettingsPanel(containerEl);
 *   await panel.init();
 */

import { ocfEngineStatus, ocfRefreshEngines, ocfDecodeFrame, ocfShowLogs } from './ocfEngine.js';

const _CSS = `
.ocf-settings { display:flex; flex-direction:column; gap:14px; }

.ocf-settings-header { font-size:13px; font-weight:600; color:#c8d8ff; }
.ocf-settings-subhead { font-size:11.5px; color:#505870; margin-top:-8px; }

.ocf-status-table {
  width:100%; border-collapse:collapse;
  background:#0e1420; border:1px solid #1a2235; border-radius:8px; overflow:hidden;
}
.ocf-status-table th {
  text-align:left; padding:6px 12px; font-size:9.5px; font-weight:700;
  color:#404c66; text-transform:uppercase; letter-spacing:.07em;
  background:#0a0f1a; border-bottom:1px solid #1a2235;
}
.ocf-status-table td {
  padding:7px 12px; font-size:11.5px; color:#7888a8;
  border-bottom:1px solid #111825; vertical-align:middle;
}
.ocf-status-table tr:last-child td { border-bottom:none; }
.ocf-status-table .engine-name { color:#a8b8d8; font-weight:500; }
.ocf-status-dot {
  display:inline-block; width:7px; height:7px; border-radius:50%;
  margin-right:6px; flex-shrink:0;
}
.status-ready   .ocf-status-dot { background:#37b573; }
.status-missing .ocf-status-dot { background:#505870; }
.status-ready   .status-text { color:#37b573; }
.status-missing .status-text { color:#505870; }
.status-cell { display:flex; align-items:center; }

.ocf-settings-actions { display:flex; flex-wrap:wrap; gap:7px; }
.ocf-settings-btn {
  display:inline-flex; align-items:center; gap:5px;
  padding:7px 15px; border-radius:6px; font-size:12px; font-weight:500;
  cursor:pointer; border:1px solid #2a3550; background:#141c2e;
  color:#7888a8; transition:background .15s, border-color .15s, color .15s;
  white-space:nowrap;
}
.ocf-settings-btn:hover { background:#1a2440; border-color:#3a4a70; color:#c8d8ff; }
.ocf-settings-btn.primary { background:#1a2b1e; border-color:#37b573; color:#37b573; }
.ocf-settings-btn.primary:hover { background:#1e3322; border-color:#4fcf89; color:#e4ebff; }

.ocf-settings-log {
  background:#080c12; border:1px solid #1a2233; border-radius:6px;
  padding:10px; font-size:10.5px; color:#4a5a70;
  font-family:"SF Mono","Fira Mono",monospace;
  white-space:pre-wrap; max-height:240px; overflow-y:auto; line-height:1.6;
}
.ocf-test-result {
  background:#0a1222; border:1px solid #1a2a40; border-radius:6px;
  padding:10px 14px; font-size:11.5px; color:#6a8ab8; line-height:1.6;
}
.ocf-test-result.ok   { border-color:#1e3c28; color:#37b573; }
.ocf-test-result.fail { border-color:#3d1414; color:#e05050; }
`;

function _esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function _injectCss() {
  if (document.getElementById('ocf-settings-styles')) return;
  const s = document.createElement('style');
  s.id = 'ocf-settings-styles';
  s.textContent = _CSS;
  document.head.appendChild(s);
}

export class OcfSettingsPanel {
  constructor(container) {
    _injectCss();
    this._root      = container;
    this._rows      = [];
    this._logs      = '';
    this._testResult = null;
    this._loading   = false;
    // Bumped at the start of each _runDecodeTest() call; a call whose
    // await resolves after a newer call has started discards its result
    // instead of clobbering the newer call's (possibly already-settled) one.
    this._testSeq   = 0;
  }

  async init() {
    this._loading = true;
    this._render();
    try {
      const r = await ocfEngineStatus();
      this._rows = r?.rows ?? [];
    } catch (err) {
      this._rows = [];
    }
    this._loading = false;
    this._render();
  }

  _render() {
    this._root.innerHTML = this._buildHTML();
    this._attachHandlers();
  }

  _buildHTML() {
    return `<div class="ocf-settings">
      <div class="ocf-settings-header">OCF Playback Engine</div>
      <div class="ocf-settings-subhead">
        Decoder backends for Original Camera Files. Missing SDKs fall back to Resolve or Proxy.
      </div>

      ${this._loading
        ? `<div style="color:#404c66;font-size:12px;">Checking engines…</div>`
        : this._renderTable()}

      <div class="ocf-settings-actions">
        <button class="ocf-settings-btn primary" data-action="check-engines">Check OCF Engines</button>
        <button class="ocf-settings-btn" data-action="decode-test">Decode Test Frame</button>
        <button class="ocf-settings-btn" data-action="gen-test-proxy">Generate Test Proxy</button>
        <button class="ocf-settings-btn" data-action="show-logs">Show Logs</button>
        <button class="ocf-settings-btn" data-action="repair">Repair Engines</button>
      </div>

      ${this._testResult ? this._renderTestResult() : ''}
      ${this._logs       ? this._renderLogs()       : ''}
    </div>`;
  }

  _renderTable() {
    if (!this._rows.length) {
      return `<div style="color:#404c66;font-size:12px;">No engine data. Click "Check OCF Engines".</div>`;
    }
    return `<table class="ocf-status-table">
      <thead>
        <tr>
          <th>Engine / SDK</th>
          <th>Status</th>
          <th>Detail</th>
        </tr>
      </thead>
      <tbody>
        ${this._rows.map(r => this._renderRow(r)).join('')}
      </tbody>
    </table>`;
  }

  _renderRow(row) {
    const statusClass = row.status === 'ready' ? 'status-ready' : 'status-missing';
    const statusText  = row.status === 'ready' ? 'Ready'        : 'Missing';
    return `<tr class="${statusClass}">
      <td class="engine-name">${_esc(row.label ?? row.id)}</td>
      <td>
        <div class="status-cell">
          <span class="ocf-status-dot"></span>
          <span class="status-text">${statusText}</span>
        </div>
      </td>
      <td style="color:#404c66;font-size:10.5px;">${_esc(row.detail ?? '')}</td>
    </tr>`;
  }

  _renderTestResult() {
    const r = this._testResult;
    if (r?.ok === null) {
      return `<div class="ocf-test-result">${_esc(r.message ?? 'Running…')}</div>`;
    }
    const cls = r?.ok ? 'ok' : 'fail';
    return `<div class="ocf-test-result ${cls}">
      ${r?.ok
        ? `Test frame decoded via <strong>${_esc(r.engine)}</strong>.`
        : `Test decode failed: ${(r?.errors ?? []).map(_esc).join('; ')}`}
    </div>`;
  }

  _renderLogs() {
    const escaped = this._logs.slice(-4096)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    return `<div class="ocf-settings-log">${escaped || '(no logs yet)'}</div>`;
  }

  _attachHandlers() {
    this._root.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        if (this._loading) return;
        this._handleAction(e.currentTarget.dataset.action);
      });
    });
  }

  async _handleAction(action) {
    switch (action) {
      case 'check-engines':
        this._loading = true;
        this._render();
        try {
          const r = await ocfRefreshEngines();
          this._rows = r?.rows ?? [];
        } catch (err) {
          console.warn('[OcfSettings] refresh failed:', err);
        }
        this._loading = false;
        this._render();
        break;

      case 'decode-test':
        await this._runDecodeTest();
        break;

      case 'gen-test-proxy':
        this._testResult = { ok: false, errors: ['Select a clip to generate a test proxy.'] };
        this._render();
        break;

      case 'show-logs':
        try {
          const r = await ocfShowLogs();
          this._logs = r?.logs ?? '';
        } catch (err) {
          this._logs = `Error loading logs: ${err}`;
        }
        this._render();
        break;

      case 'repair':
        await this._repair();
        break;
    }
  }

  async _runDecodeTest() {
    const seq = ++this._testSeq;
    // Find a Ready ffmpeg/AVF engine and try a minimal test
    const readyFFmpeg = this._rows.find(r => (r.id === 'FFmpegFrameServer' || r.id === 'FFmpeg') && r.status === 'ready');
    if (!readyFFmpeg) {
      this._testResult = { ok: false, errors: ['FFmpeg not found. Install with: brew install ffmpeg'] };
      this._render();
      return;
    }
    this._testResult = { ok: null, message: 'Running decode test…' };
    this._render();
    // Try decoding a color chart test pattern via ffmpeg
    try {
      const r = await ocfDecodeFrame('lavfi:testsrc=size=1920x1080:rate=24', {
        frameNumber: 0, scale: 320, engine: 'FFmpegFrameServer',
      });
      if (seq !== this._testSeq) return;
      this._testResult = r?.ok
        ? { ok: true, engine: r.engine }
        : { ok: false, errors: r?.errors ?? ['Unknown error'] };
    } catch (err) {
      if (seq !== this._testSeq) return;
      this._testResult = { ok: false, errors: [String(err?.message ?? err)] };
    }
    this._render();
  }

  async _repair() {
    // Suggest homebrew installs for missing engines
    const missing = this._rows.filter(r => r.status === 'missing');
    const hints = missing.map(r => {
      if (r.id === 'FFmpeg')  return 'brew install ffmpeg';
      if (r.id === 'MPV')     return 'brew install mpv';
      if (r.id === 'Resolve') return 'Download from: blackmagicdesign.com';
      if (r.id?.includes('SDK')) return `Install ${r.label ?? r.id} from the vendor`;
      return null;
    }).filter(Boolean);

    if (!hints.length) {
      this._testResult = { ok: true, engine: 'All engines present — nothing to repair.' };
    } else {
      this._testResult = { ok: false, errors: hints };
    }
    this._render();
  }
}
