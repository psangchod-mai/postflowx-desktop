'use strict';
/**
 * OCF Viewer — self-contained panel that renders into a provided container element.
 *
 * Usage:
 *   import { OcfViewer } from './ocf_engine/ocfViewer.js';
 *   const viewer = new OcfViewer(containerEl);
 *   await viewer.openClip('/path/to/clip.mov');
 */

import {
  ocfProbe, ocfDecodeFrame, ocfOpen, ocfGenerateProxy, ocfProxyJobStatus,
  engineLabel, playbackModeLabel, clipSummary,
} from './ocfEngine.js';

// ── CSS ───────────────────────────────────────────────────────────────────────

const _CSS = `
.ocf-viewer { display:flex; flex-direction:column; gap:12px; font-family:inherit; }

.ocf-engine-badge {
  display:inline-flex; align-items:center; gap:7px;
  padding:4px 10px 4px 8px; border-radius:5px;
  background:#1a2235; border:1px solid #2a3550;
  font-size:11px; font-weight:600; color:#37b573;
  letter-spacing:.03em;
}
.ocf-engine-badge .badge-dot { width:6px; height:6px; border-radius:50%; background:#37b573; flex-shrink:0; }
.ocf-engine-badge.engine-proxy { color:#c8862a; border-color:#3d2e14; }
.ocf-engine-badge.engine-proxy .badge-dot { background:#c8862a; }
.ocf-engine-badge.engine-resolve { color:#7b9fff; border-color:#1e2c50; }
.ocf-engine-badge.engine-resolve .badge-dot { background:#7b9fff; }
.ocf-engine-badge.engine-error { color:#e05050; border-color:#3d1414; }
.ocf-engine-badge.engine-error .badge-dot { background:#e05050; }

.ocf-preview-box {
  position:relative; width:100%; background:#0d1117;
  border:1px solid #1e2533; border-radius:8px; overflow:hidden;
  min-height:180px; display:flex; align-items:center; justify-content:center;
}
.ocf-preview-box img { max-width:100%; max-height:480px; display:block; border-radius:4px; }
.ocf-preview-placeholder {
  display:flex; flex-direction:column; align-items:center; gap:8px;
  color:#3a4560; font-size:12px; padding:32px;
}
.ocf-preview-placeholder svg { opacity:.4; }
.ocf-color-badge {
  position:absolute; bottom:8px; left:8px;
  background:rgba(0,0,0,.75); border:1px solid rgba(255,255,255,.1);
  border-radius:4px; padding:3px 8px; font-size:10px; color:#c0c8e0;
  backdrop-filter:blur(4px);
}
.ocf-color-badge.technical { color:#e0a030; border-color:rgba(224,160,48,.3); }

.ocf-clip-info {
  display:grid; grid-template-columns:1fr 1fr; gap:4px 16px;
  background:#111724; border:1px solid #1e2533; border-radius:7px; padding:10px 14px;
}
.ocf-info-row { display:flex; flex-direction:column; gap:1px; }
.ocf-info-label { font-size:9.5px; font-weight:600; color:#404c66; text-transform:uppercase; letter-spacing:.06em; }
.ocf-info-value { font-size:11.5px; color:#a8b4d0; font-family:"SF Mono","Fira Mono",monospace; }

.ocf-actions { display:flex; flex-wrap:wrap; gap:6px; }
.ocf-btn {
  display:inline-flex; align-items:center; gap:5px;
  padding:6px 13px; border-radius:6px; font-size:11.5px; font-weight:500;
  cursor:pointer; border:1px solid #2a3550; background:#141c2e;
  color:#8899bb; transition:background .15s, border-color .15s, color .15s;
  white-space:nowrap;
}
.ocf-btn:hover { background:#1a2440; border-color:#3a4a70; color:#c8d8ff; }
.ocf-btn.primary { background:#1a2b1e; border-color:#37b573; color:#37b573; }
.ocf-btn.primary:hover { background:#1e3322; border-color:#4fcf89; color:#e4ebff; }
.ocf-btn:disabled { opacity:.4; cursor:not-allowed; pointer-events:none; }

.ocf-error-box {
  background:#1e1010; border:1px solid #3d1414; border-radius:7px;
  padding:12px 14px; font-size:11.5px; color:#e05050; line-height:1.5;
}
.ocf-error-box .error-actions { display:flex; gap:8px; margin-top:10px; }

.ocf-sdk-missing {
  background:#1a1710; border:1px solid #3d3010; border-radius:7px;
  padding:12px 14px; font-size:12px; color:#c0a030; line-height:1.5;
}
.ocf-sdk-missing .sdk-actions { display:flex; gap:8px; margin-top:10px; }

.ocf-logs-box {
  background:#080c12; border:1px solid #1a2233; border-radius:6px;
  padding:10px; font-size:10.5px; color:#5a6880; font-family:"SF Mono","Fira Mono",monospace;
  white-space:pre-wrap; max-height:200px; overflow-y:auto; line-height:1.6;
}
`;

function _injectCss() {
  if (document.getElementById('ocf-viewer-styles')) return;
  const s = document.createElement('style');
  s.id = 'ocf-viewer-styles';
  s.textContent = _CSS;
  document.head.appendChild(s);
}

// ── OcfViewer class ───────────────────────────────────────────────────────────

export class OcfViewer {
  constructor(container) {
    _injectCss();
    this._root    = container;
    this._probe   = null;
    this._engine  = null;
    this._fallbacks = [];
    this._colorBadge = null;
    this._imageUrl = null;
    this._error   = null;
    this._logsVisible = false;
    this._proxyJobId  = null;
    this._loadSeq = 0;
    this._render();
  }

  async openClip(clipPath) {
    this._reset();
    // A concurrent openClip() call (e.g. clicking a second clip before the
    // first finishes probing/decoding) can otherwise interleave writes to
    // these shared instance fields — _loadSeq lets a stale call detect it
    // was superseded and bail instead of rendering the wrong clip.
    const seq = ++this._loadSeq;
    this._showLoading('Probing clip…');
    try {
      const opened = await ocfOpen(clipPath);
      if (seq !== this._loadSeq) return;
      this._clipPath   = opened.clipPath;
      this._probe      = opened.probe;
      this._engine     = opened.engine;
      this._fallbacks  = opened.fallbacks;
      this._colorBadge = opened.colorBadge;
      this._render();

      // Decode first frame
      this._showLoading('Decoding first frame…');
      const decoded = await ocfDecodeFrame(clipPath, {
        frameNumber: 0,
        scale: 960,
        engine: this._engine,
        probe: this._probe,
      });
      if (seq !== this._loadSeq) return;

      if (decoded?.ok && decoded.imagePath) {
        this._imageUrl = 'pfx-file://' + decoded.imagePath;
      } else if (decoded?.ok && (decoded.imageDataUrl || decoded.dataUrl)) {
        this._imageUrl = decoded.imageDataUrl || decoded.dataUrl;
      } else if (decoded?.errors?.length) {
        this._error = {
          message: decoded.errors.join('\n'),
          engine:  decoded.engine,
          resolveAvailable: this._probe?.recommendedEngine === 'ResolveEngine',
        };
      }
      this._render();
    } catch (err) {
      if (seq !== this._loadSeq) return;
      this._error = { message: String(err?.message ?? err) };
      this._render();
    }
  }

  _reset() {
    this._clipPath = null;
    this._probe = null;
    this._engine = null;
    this._fallbacks = [];
    this._colorBadge = null;
    this._imageUrl = null;
    this._error = null;
    this._logsVisible = false;
    this._proxyJobId  = null;
  }

  _showLoading(msg) {
    const box = this._root.querySelector('.ocf-preview-placeholder');
    if (box) box.textContent = msg;
  }

  _render() {
    this._root.innerHTML = this._buildHTML();
    this._attachHandlers();
  }

  _buildHTML() {
    return `<div class="ocf-viewer">
      ${this._engine ? this._renderEngineBadge() : ''}
      ${this._renderPreview()}
      ${this._probe  ? this._renderClipInfo() : ''}
      ${this._error  ? this._renderError()    : ''}
      ${this._renderSDKWarning()}
      ${this._renderActions()}
      ${this._logsVisible ? `<div class="ocf-logs-box" id="ocf-logs-content">Loading logs…</div>` : ''}
    </div>`;
  }

  _renderEngineBadge() {
    const label    = engineLabel(this._engine);
    const cssClass = this._engine === 'ProxyEngine'   ? 'engine-proxy'
                   : this._engine === 'ResolveEngine'  ? 'engine-resolve'
                   : this._error                       ? 'engine-error'
                   : '';
    return `<div class="ocf-engine-badge ${cssClass}">
      <span class="badge-dot"></span>
      OCF Engine: ${label.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
    </div>`;
  }

  _renderPreview() {
    if (this._imageUrl) {
      const badge = this._colorBadge;
      const tech  = badge?.technical ? ' technical' : '';
      const label = badge?.label ?? '';
      return `<div class="ocf-preview-box">
        <img src="${this._imageUrl.replace(/"/g,'&quot;')}" alt="OCF frame" />
        ${label ? `<div class="ocf-color-badge${tech}">Color: ${label}</div>` : ''}
      </div>`;
    }
    return `<div class="ocf-preview-box">
      <div class="ocf-preview-placeholder">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2">
          <rect x="2" y="2" width="20" height="20" rx="2"/>
          <circle cx="8" cy="8" r="2"/>
          <path d="M21 15l-5-5L5 21"/>
        </svg>
        ${this._probe ? 'Decoding…' : 'No clip loaded'}
      </div>
    </div>`;
  }

  _renderClipInfo() {
    const p  = this._probe;
    const tc = p.timecode?.start || '';
    const rows = [
      ['Camera',      p.cameraFamily || '—'],
      ['Format',      p.format       || '—'],
      ['Resolution',  p.width && p.height ? `${p.width}×${p.height}` : '—'],
      ['FPS',         p.fps?.display || '—'],
      ['Source TC',   tc || '—'],
      ['Reel',        p.reel         || '—'],
      ['Clip',        p.clipName     || '—'],
      ['Color Mode',  p.color?.logCurve ? `${p.color.logCurve} → Rec709` : 'Unknown'],
    ];
    return `<div class="ocf-clip-info">
      ${rows.map(([label, val]) => `
        <div class="ocf-info-row">
          <span class="ocf-info-label">${label}</span>
          <span class="ocf-info-value">${val}</span>
        </div>
      `).join('')}
    </div>`;
  }

  _renderError() {
    const e = this._error;
    return `<div class="ocf-error-box">
      <strong>Decode failed</strong><br/>
      ${e.message.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/\n/g,'<br/>')}
      <div class="error-actions">
        ${e.resolveAvailable
          ? `<button class="ocf-btn primary" data-action="open-resolve">Open in Resolve Engine</button>`
          : ''}
        <button class="ocf-btn" data-action="generate-proxy">Generate Proxy</button>
        <button class="ocf-btn" data-action="show-logs">Show Logs</button>
      </div>
    </div>`;
  }

  _renderSDKWarning() {
    if (!this._probe || !this._engine) return '';
    const sdkEngines = ['BRAWSDKEngine','REDSDKEngine','ARRISDKEngine','CanonRawSDKEngine'];
    const wantsSdk  = sdkEngines.includes(this._probe.recommendedEngine);
    const isUsingFallback = this._engine !== this._probe.recommendedEngine;
    if (!wantsSdk || !isUsingFallback) return '';
    return `<div class="ocf-sdk-missing">
      Native OCF decoder missing for this camera format (${this._probe.cameraFamily}).
      Using ${engineLabel(this._engine)} as fallback.
      <div class="sdk-actions">
        <button class="ocf-btn" data-action="open-resolve">Use Resolve Engine</button>
        <button class="ocf-btn" data-action="generate-proxy">Generate Proxy</button>
        <button class="ocf-btn" data-action="show-setup">Show Setup</button>
      </div>
    </div>`;
  }

  _renderActions() {
    const hasClip = !!this._probe;
    return `<div class="ocf-actions">
      <button class="ocf-btn primary" data-action="decode-frame" ${hasClip ? '' : 'disabled'}>Decode First Frame</button>
      <button class="ocf-btn" data-action="generate-proxy"  ${hasClip ? '' : 'disabled'}>Generate Proxy</button>
      <button class="ocf-btn" data-action="open-resolve"    ${hasClip ? '' : 'disabled'}>Open in Resolve</button>
      <button class="ocf-btn" data-action="show-metadata"   ${hasClip ? '' : 'disabled'}>Show Metadata</button>
      <button class="ocf-btn" data-action="show-logs">Show Logs</button>
    </div>`;
  }

  _attachHandlers() {
    this._root.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => this._handleAction(e.currentTarget.dataset.action));
    });
  }

  async _handleAction(action) {
    const clip = this._probe?.clipName ?? '';
    switch (action) {
      case 'decode-frame':
        if (this._probe && this._clipPath) {
          this._imageUrl = null;
          this._error    = null;
          this._render();
          await this.openClip(this._clipPath);
        }
        break;
      case 'generate-proxy':
        await this._startProxy();
        break;
      case 'open-resolve':
        if (this._probe && this._clipPath) {
          await ocfDecodeFrame(this._clipPath, { engine: 'ResolveEngine', probe: this._probe });
        }
        break;
      case 'show-metadata':
        if (this._probe) {
          alert(JSON.stringify(this._probe, null, 2));
        }
        break;
      case 'show-logs':
        this._logsVisible = !this._logsVisible;
        this._render();
        if (this._logsVisible) this._loadLogs();
        break;
      case 'show-setup':
        window.dispatchEvent(new CustomEvent('pfx:open-settings', { detail: { tab: 'ocf-engine' } }));
        break;
    }
  }

  async _startProxy() {
    if (!this._probe) return;
    const clipPath = this._clipPath || '';
    if (!clipPath) return;
    try {
      const r = await ocfGenerateProxy(clipPath, {
        scale: 1280,
        timecodeStart: this._probe.timecode?.start ?? '',
      });
      if (r?.jobId) {
        this._proxyJobId = r.jobId;
        this._pollProxy().catch(err => console.warn('[OcfViewer] proxy poll error:', err));
      }
    } catch (err) {
      console.warn('[OcfViewer] proxy start failed:', err);
    }
  }

  async _pollProxy() {
    if (!this._proxyJobId) return;
    const status = await ocfProxyJobStatus(this._proxyJobId);
    if (status?.state === 'done') {
      this._proxyJobId = null;
      if (status.result?.ok) {
        console.log('[OcfViewer] proxy done:', status.result.proxyPath);
      }
    } else {
      setTimeout(() => this._pollProxy(), 1500);
    }
  }

  async _loadLogs() {
    try {
      const { ocfShowLogs } = await import('./ocfEngine.js');
      const r = await ocfShowLogs();
      const box = this._root.querySelector('#ocf-logs-content');
      if (box) box.textContent = r?.logs || '(no logs yet)';
    } catch (err) {
      const box = this._root.querySelector('#ocf-logs-content');
      if (box) box.textContent = `Error loading logs: ${err}`;
    }
  }
}
