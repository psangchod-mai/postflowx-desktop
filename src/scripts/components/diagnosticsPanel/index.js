'use strict';
/**
 * diagnosticsPanel/index.js — PFXNativeMediaEngine diagnostics panel.
 *
 * Call render(containerEl) to mount, startPolling(intervalMs) to begin
 * live updates. Uses pfxPlatform.nativeEngine + pfxPlatform.media.diagnostics.
 */

import { neDiagnostics, nativeEngineAvailable } from '../../media/nativeEngineClient.js';

const POLL_INTERVAL_MS = 2000;

let _container = null;
let _timer     = null;

// ── Public API ───────────────────────────────────────────────────────────────

export function render(containerEl) {
  _container = containerEl;
  _container.innerHTML = _skeleton();
  return _container;
}

export function startPolling(intervalMs = POLL_INTERVAL_MS) {
  stopPolling();
  _refresh();
  _timer = setInterval(_refresh, intervalMs);
}

export function stopPolling() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// ── Refresh ──────────────────────────────────────────────────────────────────

async function _refresh() {
  if (!_container) return;

  // Fetch native engine diagnostics
  let neDiag = null;
  try { neDiag = nativeEngineAvailable() ? await neDiagnostics() : null; }
  catch { /* engine not ready */ }

  // Fetch legacy companion/media diagnostics
  let mediaDiag = null;
  try {
    if (window.pfxPlatform?.media?.diagnostics) {
      mediaDiag = await window.pfxPlatform.media.diagnostics();
    }
  } catch { /* ignore */ }

  _update(neDiag, mediaDiag);
}

function _update(ne, media) {
  if (!_container) return;

  const engineRunning = ne?.engineRunning ?? false;
  const hwDecode      = ne?.hardwareDecode ?? 'unknown';
  const hwEncode      = ne?.hardwareEncode ?? 'unknown';
  const gpuName       = ne?.gpuName       ?? 'N/A';
  const decoderCount  = ne?.activeDecoderCount ?? 0;
  const playFPS       = (ne?.playbackFPS  ?? 0).toFixed(1);
  const dropped       = ne?.droppedFrames ?? 0;
  const memMB         = (ne?.memoryMB     ?? 0).toFixed(0);
  const vtReady       = ne?.videoToolboxReady ?? false;
  const metalReady    = ne?.metalReady    ?? false;
  const lastError     = ne?.lastError     ?? null;

  const resolveConn   = media?.resolveConnected ?? false;
  const ffmpegAvail   = media?.ffmpegFallbackAvailable ?? false;
  const companionOk   = media?.companionReady ?? false;

  _container.innerHTML = `
    <div class="diag-panel">
      <h3 class="diag-title">Media Engine Diagnostics</h3>

      <section class="diag-section">
        <h4>Native Engine (PFXNativeMediaEngine)</h4>
        <div class="diag-row">
          <span class="diag-label">Status</span>
          <span class="diag-value ${engineRunning ? 'ok' : 'err'}">
            ${engineRunning ? 'Running' : 'Offline'}
          </span>
        </div>
        <div class="diag-row">
          <span class="diag-label">HW Decode (VideoToolbox)</span>
          <span class="diag-value ${hwDecode === 'on' ? 'ok' : 'warn'}">${hwDecode}</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">HW Encode</span>
          <span class="diag-value ${hwEncode === 'on' ? 'ok' : 'warn'}">${hwEncode}</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">VideoToolbox</span>
          <span class="diag-value ${vtReady ? 'ok' : 'err'}">${vtReady ? 'Ready' : 'Unavailable'}</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">Metal GPU</span>
          <span class="diag-value ${metalReady ? 'ok' : 'warn'}">${metalReady ? gpuName : 'Unavailable'}</span>
        </div>
      </section>

      <section class="diag-section">
        <h4>Playback</h4>
        <div class="diag-row">
          <span class="diag-label">Active Decoders</span>
          <span class="diag-value">${decoderCount}</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">Playback FPS</span>
          <span class="diag-value">${playFPS}</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">Dropped Frames</span>
          <span class="diag-value ${dropped > 0 ? 'warn' : ''}">${dropped}</span>
        </div>
      </section>

      <section class="diag-section">
        <h4>System</h4>
        <div class="diag-row">
          <span class="diag-label">Engine Memory</span>
          <span class="diag-value">${memMB} MB</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">Resolve Connected</span>
          <span class="diag-value ${resolveConn ? 'ok' : 'warn'}">${resolveConn ? 'Yes' : 'No'}</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">FFmpeg Fallback</span>
          <span class="diag-value ${ffmpegAvail ? 'ok' : 'warn'}">${ffmpegAvail ? 'Available' : 'No'}</span>
        </div>
        <div class="diag-row">
          <span class="diag-label">Python Companion</span>
          <span class="diag-value ${companionOk ? 'ok' : 'warn'}">${companionOk ? 'Running' : 'Offline'}</span>
        </div>
      </section>

      ${lastError ? `
      <section class="diag-section diag-error">
        <h4>Last Error</h4>
        <pre class="diag-err-text">${_esc(String(lastError))}</pre>
      </section>` : ''}
    </div>
  `;
}

function _skeleton() {
  return '<div class="diag-panel diag-loading">Loading diagnostics…</div>';
}

function _esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
