/**
 * imf_package_ui.js — IMF Package Browser, CPL Selector, Validation Panel,
 *                      Player HUD, and Fallback UI for PostFlowX Desktop.
 *
 * Mounts a self-contained panel into any container element.
 *
 * Usage:
 *   import { mountIMFPackageUI } from './imf_package_ui.js';
 *   const ui = mountIMFPackageUI(containerEl);
 *   ui.dispose();
 *
 * The UI talks to imf_player_engine.js (IMFPlayer) and shows:
 *   - "Open IMF Package" entry point (folder/ASSETMAP/CPL picker)
 *   - CPL selector (if multiple CPLs found)
 *   - Validation panel with per-asset status rows
 *   - Canvas player with transport controls
 *   - Player HUD (engine, CPL, TC, codec, audio, status)
 *   - Fallback panel when direct playback is unavailable
 */

import { createIMFPlayer } from './imf_player_engine.js';

const _pfx = () => window.pfxPlatform;

// ── CSS (injected once) ────────────────────────────────────────────────────────

const CSS_ID = '__pfx-imf-ui-styles';
const CSS = `
.pfx-imf-panel {
  display: flex; flex-direction: column; gap: 0;
  background: #111; color: #e0e0e0;
  font: 12px/1.4 'SF Mono', 'Consolas', monospace;
  border-radius: 6px; overflow: hidden;
  min-width: 480px;
}
.pfx-imf-header {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; background: #1a1a1a; border-bottom: 1px solid #2a2a2a;
}
.pfx-imf-header h3 { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: .05em; color: #fff; flex: 1; }
.pfx-imf-btn {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 5px 10px; border-radius: 4px; border: 1px solid #3a3a3a;
  background: #252525; color: #ccc; font: inherit; cursor: pointer;
  transition: background 80ms;
}
.pfx-imf-btn:hover { background: #2f2f2f; color: #fff; }
.pfx-imf-btn.primary { background: #1a6edb; border-color: #1a6edb; color: #fff; }
.pfx-imf-btn.primary:hover { background: #2079ee; }
.pfx-imf-btn:disabled { opacity: .4; cursor: default; }

/* Drop zone / open prompt */
.pfx-imf-dropzone {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 40px 20px; gap: 10px;
  border: 2px dashed #2d2d2d; border-radius: 4px; margin: 16px;
  text-align: center; cursor: pointer; transition: border-color 120ms;
}
.pfx-imf-dropzone:hover, .pfx-imf-dropzone.drag-over { border-color: #1a6edb; }
.pfx-imf-dropzone .icon { font-size: 28px; }
.pfx-imf-dropzone .hint { font-size: 11px; color: #666; }

/* CPL selector */
.pfx-imf-cpl-row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 14px; background: #171717; border-bottom: 1px solid #222;
}
.pfx-imf-cpl-row label { color: #888; font-size: 11px; white-space: nowrap; }
.pfx-imf-cpl-select {
  flex: 1; background: #1e1e1e; border: 1px solid #333; border-radius: 3px;
  color: #e0e0e0; font: inherit; padding: 3px 6px;
}

/* Validation panel */
.pfx-imf-validation { padding: 0; }
.pfx-imf-val-row {
  display: flex; align-items: center; gap: 8px;
  padding: 5px 14px; border-bottom: 1px solid #1c1c1c; font-size: 11px;
}
.pfx-imf-val-row:last-child { border-bottom: none; }
.pfx-imf-val-dot {
  width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0;
}
.pfx-imf-val-dot.ok    { background: #22b36b; }
.pfx-imf-val-dot.warn  { background: #e09a20; }
.pfx-imf-val-dot.error { background: #e04040; }
.pfx-imf-val-dot.info  { background: #555; }
.pfx-imf-val-label { flex: 1; }
.pfx-imf-val-badge {
  font-size: 10px; padding: 1px 5px; border-radius: 3px;
  background: #222; color: #888; white-space: nowrap;
}
.pfx-imf-val-badge.ok    { background: #0d2e1c; color: #22b36b; }
.pfx-imf-val-badge.warn  { background: #2d2200; color: #e09a20; }
.pfx-imf-val-badge.error { background: #2d0d0d; color: #e04040; }

/* Player canvas area */
.pfx-imf-viewport {
  position: relative; background: #000; flex-shrink: 0;
}
.pfx-imf-canvas { display: block; width: 100%; height: auto; }
.pfx-imf-spinner {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,.6); font-size: 11px; color: #888;
}

/* HUD */
.pfx-imf-hud {
  display: flex; flex-wrap: wrap; gap: 4px 10px;
  padding: 6px 14px; background: #141414; border-top: 1px solid #222;
  font-size: 10px; color: #666;
}
.pfx-imf-hud span b { color: #aaa; font-weight: 400; }
.pfx-imf-hud-chip {
  background: #1e1e1e; border: 1px solid #2a2a2a; border-radius: 3px;
  padding: 1px 5px; font-size: 10px; color: #888;
}
.pfx-imf-hud-chip.engine { border-color: #1a6edb; color: #4da3f7; }
.pfx-imf-hud-chip.warn   { border-color: #5a3800; color: #e09a20; }

/* Transport controls */
.pfx-imf-transport {
  display: flex; align-items: center; gap: 6px;
  padding: 8px 14px; background: #161616; border-top: 1px solid #1f1f1f;
}
.pfx-imf-scrubber {
  flex: 1; accent-color: #1a6edb; height: 3px; cursor: pointer;
}
.pfx-imf-tc {
  font-size: 11px; color: #888; white-space: nowrap; min-width: 80px; text-align: right;
}
.pfx-imf-rate-select {
  background: #1e1e1e; border: 1px solid #333; border-radius: 3px;
  color: #aaa; font: inherit; font-size: 10px; padding: 2px 4px;
}

/* Fallback panel */
.pfx-imf-fallback {
  padding: 16px 14px; background: #151515;
}
.pfx-imf-fallback .title { font-size: 12px; color: #e04040; margin-bottom: 8px; }
.pfx-imf-fallback .msg   { font-size: 11px; color: #777; margin-bottom: 12px; line-height: 1.5; }
.pfx-imf-fallback-btns   { display: flex; gap: 8px; flex-wrap: wrap; }

/* Error / warning bars */
.pfx-imf-errors { padding: 4px 14px 0; }
.pfx-imf-error-msg {
  font-size: 11px; color: #e04040; padding: 4px 0; border-bottom: 1px solid #1e1e1e;
}
.pfx-imf-warn-msg {
  font-size: 11px; color: #e09a20; padding: 4px 0; border-bottom: 1px solid #1e1e1e;
}

/* Collapsible sections */
.pfx-imf-section-head {
  display: flex; align-items: center; gap: 6px;
  padding: 5px 14px; background: #181818; border-bottom: 1px solid #222;
  font-size: 11px; color: #777; cursor: pointer; user-select: none;
}
.pfx-imf-section-head:hover { color: #aaa; }
.pfx-imf-section-head .arrow { transition: transform 120ms; }
.pfx-imf-section-head.collapsed .arrow { transform: rotate(-90deg); }
.pfx-imf-section-body.collapsed { display: none; }
`;

function _injectCSS() {
  if (document.getElementById(CSS_ID)) return;
  const style = document.createElement('style');
  style.id = CSS_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ── mountIMFPackageUI ─────────────────────────────────────────────────────────

export function mountIMFPackageUI(container, opts = {}) {
  _injectCSS();

  // ── DOM scaffold ──────────────────────────────────────────────────────────

  const root = document.createElement('div');
  root.className = 'pfx-imf-panel';

  root.innerHTML = `
    <div class="pfx-imf-header">
      <h3>IMF Package Player</h3>
      <button class="pfx-imf-btn" id="imf-open-btn">Open Package&hellip;</button>
      <button class="pfx-imf-btn" id="imf-diag-btn" title="Diagnostics">&#9432;</button>
    </div>

    <!-- Drop zone (shown when no package loaded) -->
    <div class="pfx-imf-dropzone" id="imf-dropzone">
      <div class="icon">&#127916;</div>
      <div>Drop IMF package folder, ASSETMAP.xml, or CPL.xml here</div>
      <div class="hint">or click "Open Package" above</div>
    </div>

    <!-- CPL selector (hidden until package loaded) -->
    <div class="pfx-imf-cpl-row" id="imf-cpl-row" style="display:none">
      <label>Composition:</label>
      <select class="pfx-imf-cpl-select" id="imf-cpl-select"></select>
      <button class="pfx-imf-btn" id="imf-validate-btn">Validate</button>
    </div>

    <!-- Errors/warnings bar -->
    <div class="pfx-imf-errors" id="imf-errors" style="display:none"></div>

    <!-- Validation panel (collapsible) -->
    <div id="imf-val-section" style="display:none">
      <div class="pfx-imf-section-head" id="imf-val-head">
        <span class="arrow">&#9660;</span>
        <span>Validation</span>
        <span id="imf-val-summary" style="margin-left:auto;font-size:10px;"></span>
      </div>
      <div class="pfx-imf-section-body" id="imf-val-body">
        <div class="pfx-imf-validation" id="imf-val-rows"></div>
      </div>
    </div>

    <!-- Player viewport -->
    <div class="pfx-imf-viewport" id="imf-viewport" style="display:none">
      <canvas class="pfx-imf-canvas" id="imf-canvas" width="1920" height="1080"></canvas>
      <div class="pfx-imf-spinner" id="imf-spinner" style="display:none">Buffering&hellip;</div>
    </div>

    <!-- Transport controls -->
    <div class="pfx-imf-transport" id="imf-transport" style="display:none">
      <button class="pfx-imf-btn" id="imf-play-btn" title="Play/Pause">&#9654;</button>
      <button class="pfx-imf-btn" id="imf-stop-btn" title="Stop">&#9632;</button>
      <button class="pfx-imf-btn" id="imf-prev-btn" title="Step back">&larr;</button>
      <button class="pfx-imf-btn" id="imf-next-btn" title="Step forward">&rarr;</button>
      <input type="range" class="pfx-imf-scrubber" id="imf-scrubber" min="0" max="100" value="0">
      <span class="pfx-imf-tc" id="imf-tc-display">00:00:00:00</span>
      <select class="pfx-imf-rate-select" id="imf-rate-select">
        <option value="0.25">x0.25</option>
        <option value="0.5">x0.5</option>
        <option value="1" selected>x1</option>
        <option value="2">x2</option>
        <option value="4">x4</option>
      </select>
      <select class="pfx-imf-rate-select" id="imf-quality-select" title="Playback quality — reduced J2K decode level sustains real-time on CPU; full-res may stutter at HD/UHD">
        <option value="auto" selected>Auto</option>
        <option value="full">Full</option>
        <option value="half">Half</option>
        <option value="quarter">Quarter</option>
      </select>
    </div>

    <!-- HUD -->
    <div class="pfx-imf-hud" id="imf-hud" style="display:none"></div>

    <!-- Fallback panel -->
    <div class="pfx-imf-fallback" id="imf-fallback" style="display:none">
      <div class="title">Direct IMF playback failed.</div>
      <div class="msg" id="imf-fallback-msg"></div>
      <div class="pfx-imf-fallback-btns">
        <button class="pfx-imf-btn primary" id="imf-fb-proxy">Create Preview Proxy</button>
        <button class="pfx-imf-btn" id="imf-fb-resolve">Open in Resolve Engine</button>
        <button class="pfx-imf-btn" id="imf-fb-external">Open in External Player</button>
      </div>
    </div>
  `;

  container.appendChild(root);

  // ── Element refs ──────────────────────────────────────────────────────────

  const $ = (id) => root.querySelector('#' + id);

  const els = {
    openBtn:      $('imf-open-btn'),
    diagBtn:      $('imf-diag-btn'),
    dropzone:     $('imf-dropzone'),
    cplRow:       $('imf-cpl-row'),
    cplSelect:    $('imf-cpl-select'),
    validateBtn:  $('imf-validate-btn'),
    errorsBar:    $('imf-errors'),
    valSection:   $('imf-val-section'),
    valHead:      $('imf-val-head'),
    valBody:      $('imf-val-body'),
    valRows:      $('imf-val-rows'),
    valSummary:   $('imf-val-summary'),
    viewport:     $('imf-viewport'),
    canvas:       $('imf-canvas'),
    spinner:      $('imf-spinner'),
    transport:    $('imf-transport'),
    playBtn:      $('imf-play-btn'),
    stopBtn:      $('imf-stop-btn'),
    prevBtn:      $('imf-prev-btn'),
    nextBtn:      $('imf-next-btn'),
    scrubber:     $('imf-scrubber'),
    tcDisplay:    $('imf-tc-display'),
    rateSelect:   $('imf-rate-select'),
    qualitySelect:$('imf-quality-select'),
    hud:          $('imf-hud'),
    fallback:     $('imf-fallback'),
    fallbackMsg:  $('imf-fallback-msg'),
    fbProxy:      $('imf-fb-proxy'),
    fbResolve:    $('imf-fb-resolve'),
    fbExternal:   $('imf-fb-external'),
  };

  // ── Player instance ───────────────────────────────────────────────────────

  const player = createIMFPlayer(els.canvas, { outputWidth: 1920 });
  let _packageData = null;
  let _scrubbing   = false;

  // ── Player events ─────────────────────────────────────────────────────────

  player.on('packageLoaded', ({ packageData: pkg }) => {
    _packageData = pkg || player.packageData;
    _renderCPLSelector();
    _showPackageUI();
  });

  player.on('state', ({ state }) => {
    _updatePlayButton(state);
    if (state === 'playing') {
      els.spinner.style.display = 'none';
    } else if (state === 'error') {
      // fallback shown by 'error' event
    }
  });

  player.on('frame', ({ frame, totalFrames, tc }) => {
    if (!_scrubbing) {
      els.scrubber.max   = String(Math.max(totalFrames - 1, 1));
      els.scrubber.value = String(frame);
    }
    els.tcDisplay.textContent = tc;
  });

  player.on('hud', (hudData) => {
    _renderHUD(hudData);
  });

  player.on('validation', ({ validation }) => {
    _renderValidation(validation);
  });

  player.on('error', ({ code, message, fallback }) => {
    _showFallback(message, fallback);
  });

  // ── Open package ──────────────────────────────────────────────────────────

  async function _openPackage(inputPath) {
    if (!inputPath) {
      // Show file/folder picker
      let picked = null;
      try {
        // Try picking a file first (ASSETMAP.xml or CPL.xml)
        picked = await _pfx().pickFile({
          title:   'Open IMF Package',
          filters: [
            { name: 'IMF Package', extensions: ['xml', 'mxf'] },
            { name: 'All Files',   extensions: ['*'] },
          ],
        });
      } catch {}

      if (!picked) {
        // Fall back to folder pick
        try {
          picked = await _pfx().pickFolder({ title: 'Open IMF Package Folder' });
        } catch {}
      }
      if (!picked) return;
      inputPath = picked;
    }

    _showSpinner('Opening package…');
    _clearErrors();
    _hideFallback();

    const r = await player.openPackage(inputPath);
    _hideSpinner();

    if (!r.ok) {
      _showErrors([r.error || 'Failed to open IMF package'], []);
      return;
    }

    _packageData = r.package;

    // Auto-validate on open
    await _doValidate();
  }

  // ── CPL selector ──────────────────────────────────────────────────────────

  function _renderCPLSelector() {
    const pkg  = player.packageData;
    const cpls = pkg?.cpls || [];
    els.cplSelect.innerHTML = '';

    for (const cpl of cpls) {
      const opt = document.createElement('option');
      opt.value = cpl.id;
      const fname = cpl.cplPath ? cpl.cplPath.split('/').pop() : cpl.id.slice(0, 8) + '…';
      const res   = cpl.resolution ? `${cpl.resolution.w}×${cpl.resolution.h}` : '';
      const fps   = cpl.editRate   ? (cpl.editRate[0] / cpl.editRate[1]).toFixed(2) : '';
      const supp  = cpl.isSupplemental ? ' [Supplemental]' : '';
      opt.textContent = `${fname}${supp}  ${res} ${fps}fps  ${_framesToTC(cpl.totalFrames || 0, cpl.editRate ? cpl.editRate[0]/cpl.editRate[1] : 24)}${cpl.codec ? '  ' + cpl.codec : ''}`;
      els.cplSelect.appendChild(opt);
    }

    // Select the active CPL
    if (pkg?.activeCplId) els.cplSelect.value = pkg.activeCplId;
  }

  function _onCPLChange() {
    player.selectCPL(els.cplSelect.value);
    _hideFallback();
    _doValidate();
  }

  // ── Validation panel ──────────────────────────────────────────────────────

  async function _doValidate() {
    els.validateBtn.disabled = true;
    els.validateBtn.textContent = 'Validating…';

    const cplId = els.cplSelect.value || null;
    const r     = await player.validatePackage(cplId);

    els.validateBtn.disabled = false;
    els.validateBtn.textContent = 'Validate';

    if (!r.ok) {
      _showErrors([r.error || 'Validation error'], []);
      return;
    }

    _renderValidation(r.validation);

    // If validation shows the package can play, enable transport
    if (r.validation.canPlay) {
      _showTransport();
    }
  }

  function _renderValidation(v) {
    const rows = [];

    rows.push(_valRow(v.assetmapFound ? 'ok' : 'error', 'ASSETMAP.xml', v.assetmapFound ? 'Found' : 'Missing'));
    rows.push(_valRow(v.pklFound ? 'ok' : 'warn', 'Packing List (PKL)', v.pklFound ? 'Found' : 'Not found — checksums unavailable'));
    rows.push(_valRow(v.cplCount > 0 ? 'ok' : 'error', `${v.cplCount} Composition${v.cplCount !== 1 ? 's' : ''} (CPL)`, v.cplCount > 0 ? `${v.cplCount} found` : 'No CPL found'));
    rows.push(_valRow('info', 'Picture tracks', `${v.pictureTrackCount}`));
    rows.push(_valRow('info', 'Audio tracks', `${v.audioTrackCount}`));

    if (v.missingMXFs.length > 0) {
      for (const m of v.missingMXFs) {
        rows.push(_valRow('error', m.friendlyName, m.uuid.slice(0, 8) + '…'));
      }
    } else {
      rows.push(_valRow('ok', 'All MXF assets', 'Resolved'));
    }

    if (v.encryptedAssets.length > 0) {
      for (const e of v.encryptedAssets) {
        rows.push(_valRow('error', 'Encryption', e));
      }
    }

    for (const w of (v.codecWarnings || [])) {
      rows.push(_valRow('warn', 'Codec', w));
    }

    if (v.ffprobeResult?.ok) {
      const p = v.ffprobeResult;
      rows.push(_valRow('ok', 'FFmpeg IMF demuxer', 'Available'));
      if (p.video) {
        rows.push(_valRow('info', `Video: ${p.video.codec}`, `${p.video.width}×${p.video.height} · ${p.video.pix_fmt}`));
      }
      if (p.audio) {
        rows.push(_valRow('info', `Audio: ${p.audio.codec}`, `${p.audio.channels}ch · ${p.audio.sample_rate}Hz`));
      }
    } else if (v.ffprobeResult && !v.ffprobeResult.ok) {
      rows.push(_valRow('warn', 'FFmpeg IMF demux', v.ffprobeResult.supportsIMFDemux === false ? 'Not supported' : (v.ffprobeResult.error || 'Failed')));
    }

    if (v.photonResult) {
      const ph = v.photonResult;
      if (ph.errors?.length > 0) {
        rows.push(_valRow('error', `Photon: ${ph.errors.length} error${ph.errors.length !== 1 ? 's' : ''}`, ph.errors[0]));
      } else if (ph.warnings?.length > 0) {
        rows.push(_valRow('warn', `Photon: ${ph.warnings.length} warning${ph.warnings.length !== 1 ? 's' : ''}`, ph.warnings[0]));
      } else {
        rows.push(_valRow('ok', 'Photon', 'No errors'));
      }
    }

    // Render errors/warnings from index scan
    const allErrors = [...(v.errors || [])];
    const allWarns  = [...(v.warnings || [])];

    els.valRows.innerHTML = rows.join('');
    els.valSection.style.display = '';

    // Summary chip
    const errCount  = (v.errors?.length ?? 0) + (v.missingMXFs?.length ?? 0) + (v.encryptedAssets?.length ?? 0);
    const warnCount = (v.warnings?.length ?? 0) + (v.codecWarnings?.length ?? 0);
    els.valSummary.textContent = errCount > 0
      ? `${errCount} error${errCount !== 1 ? 's' : ''}`
      : warnCount > 0
        ? `${warnCount} warning${warnCount !== 1 ? 's' : ''}`
        : 'Pass';
    els.valSummary.style.color = errCount > 0 ? '#e04040' : warnCount > 0 ? '#e09a20' : '#22b36b';

    _showErrors(allErrors, allWarns);
  }

  function _valRow(level, label, badge) {
    return `<div class="pfx-imf-val-row">
      <div class="pfx-imf-val-dot ${level}"></div>
      <div class="pfx-imf-val-label">${_esc(label)}</div>
      <div class="pfx-imf-val-badge ${level}">${_esc(badge)}</div>
    </div>`;
  }

  // ── HUD ───────────────────────────────────────────────────────────────────

  function _renderHUD(h) {
    els.hud.style.display = '';
    els.hud.innerHTML = [
      `<span class="pfx-imf-hud-chip engine">&#9654; ${_esc(h.engine)}</span>`,
      `<span class="pfx-imf-hud-chip">${_esc(h.cplName || h.cplId || '–')}</span>`,
      h.resolution ? `<span><b>Res</b> ${_esc(h.resolution)}</span>` : '',
      `<span><b>Codec</b> ${_esc(h.codec)}</span>`,
      `<span><b>TC</b> ${_esc(h.tc)}</span>`,
      `<span><b>Dur</b> ${_esc(h.duration)}</span>`,
      h.transfer !== '–' ? `<span><b>TF</b> ${_esc(h.transfer)}</span>` : '',
      h.audioLayout !== '—' ? `<span><b>Audio</b> ${_esc(h.audioLayout)}</span>` : '',
      ...(h.limitations || []).map(l => `<span class="pfx-imf-hud-chip warn">${_esc(l)}</span>`),
    ].filter(Boolean).join('');
  }

  // ── Transport controls ────────────────────────────────────────────────────

  async function _onPlayPause() {
    if (player.state === 'playing') {
      player.pause();
    } else {
      els.spinner.style.display = 'flex';
      await player.startPlayback({ outputWidth: 1920 });
    }
  }

  function _onStop() { player.stop(); }

  function _onPrev()  { player.stepBack(); }
  function _onNext()  { player.stepForward(); }

  function _onScrubStart() { _scrubbing = true; }
  function _onScrubEnd()   {
    _scrubbing = false;
    player.seek(parseInt(els.scrubber.value, 10));
  }
  function _onScrubInput() {
    if (_scrubbing) {
      const frame = parseInt(els.scrubber.value, 10);
      els.tcDisplay.textContent = _framesToTC(frame, player.fps);
    }
  }

  function _onRateChange() {
    player.setRate(parseFloat(els.rateSelect.value));
  }

  function _updatePlayButton(state) {
    els.playBtn.innerHTML = state === 'playing' ? '&#9646;&#9646;' : '&#9654;';
    els.playBtn.title = state === 'playing' ? 'Pause' : 'Play';
  }

  // ── Fallback panel ────────────────────────────────────────────────────────

  function _showFallback(message, fallbackType) {
    els.fallback.style.display  = '';
    els.viewport.style.display  = 'none';
    els.transport.style.display = 'none';
    els.fallbackMsg.textContent = message ||
      'PostFlowX can create a preview proxy for this package.';

    // Highlight the relevant fallback button
    els.fbProxy.style.display    = '';
    els.fbResolve.style.display  = '';
    els.fbExternal.style.display = '';
    if (fallbackType === 'proxy')    els.fbProxy.className    = 'pfx-imf-btn primary';
    if (fallbackType === 'resolve')  els.fbResolve.className  = 'pfx-imf-btn primary';
    if (fallbackType === 'external') els.fbExternal.className = 'pfx-imf-btn primary';
  }

  function _hideFallback() {
    els.fallback.style.display = 'none';
    els.fbProxy.className    = 'pfx-imf-btn';
    els.fbResolve.className  = 'pfx-imf-btn';
    els.fbExternal.className = 'pfx-imf-btn';
  }

  // ── Diagnostics overlay ───────────────────────────────────────────────────

  async function _showDiagnostics() {
    const pfx = _pfx();
    if (!pfx?.imfEngine) { alert('IMF Engine Diagnostics\n\nEngine bridge not available.'); return; }
    const r = await pfx.imfEngine.diagnostics();
    const lines = [
      `FFmpeg: ${r.ffmpegAvailable ? '✓' : '✗'}`,
      `IMF demuxer: ${r.imfDemuxAvailable ? '✓' : '✗ (install FFmpeg ≥5.1 with IMF support)'}`,
      `Photon: ${r.photonAvailable ? r.photonPath : '✗ (java not found or photon.jar missing)'}`,
      `HTTP port: ${r.httpPort || 'not started'}`,
      `Active sessions: ${r.activeSessions}`,
      `Loaded packages: ${r.loadedPackages}`,
    ];
    // Simple alert for now; could be upgraded to a modal.
    alert('IMF Engine Diagnostics\n\n' + lines.join('\n'));
  }

  // ── UI visibility helpers ─────────────────────────────────────────────────

  function _showPackageUI() {
    els.dropzone.style.display = 'none';
    els.cplRow.style.display   = '';
  }

  function _showTransport() {
    els.viewport.style.display  = '';
    els.transport.style.display = '';
  }

  function _showSpinner(msg) {
    els.spinner.textContent    = msg || 'Loading…';
    els.spinner.style.display  = 'flex';
  }
  function _hideSpinner() {
    els.spinner.style.display = 'none';
  }

  function _showErrors(errors, warnings) {
    if (!errors.length && !warnings.length) {
      els.errorsBar.style.display = 'none';
      els.errorsBar.innerHTML = '';
      return;
    }
    els.errorsBar.style.display = '';
    els.errorsBar.innerHTML = [
      ...errors.map(e => `<div class="pfx-imf-error-msg">${_esc(e)}</div>`),
      ...warnings.map(w => `<div class="pfx-imf-warn-msg">${_esc(w)}</div>`),
    ].join('');
  }

  function _clearErrors() {
    els.errorsBar.style.display = 'none';
    els.errorsBar.innerHTML = '';
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────

  function _onDragOver(e) { e.preventDefault(); els.dropzone.classList.add('drag-over'); }
  function _onDragLeave() { els.dropzone.classList.remove('drag-over'); }
  function _onDrop(e) {
    e.preventDefault();
    els.dropzone.classList.remove('drag-over');
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length > 0) {
      const f = files[0];
      const p = f.path || (f.name); // Electron exposes f.path
      if (p) _openPackage(p);
    }
  }

  // ── Collapsible section ───────────────────────────────────────────────────

  function _toggleSection(head, body) {
    const collapsed = head.classList.toggle('collapsed');
    body.classList.toggle('collapsed', collapsed);
  }

  // ── Wire events ───────────────────────────────────────────────────────────

  els.openBtn.addEventListener('click', () => _openPackage(null));
  els.diagBtn.addEventListener('click', () => _showDiagnostics().catch(err => alert('Diagnostics error: ' + err.message)));
  els.dropzone.addEventListener('click', () => _openPackage(null));
  els.dropzone.addEventListener('dragover', _onDragOver);
  els.dropzone.addEventListener('dragleave', _onDragLeave);
  els.dropzone.addEventListener('drop', _onDrop);

  els.cplSelect.addEventListener('change', _onCPLChange);
  els.validateBtn.addEventListener('click', _doValidate);

  els.valHead.addEventListener('click', () => _toggleSection(els.valHead, els.valBody));

  els.playBtn.addEventListener('click', _onPlayPause);
  els.stopBtn.addEventListener('click', _onStop);
  els.prevBtn.addEventListener('click', _onPrev);
  els.nextBtn.addEventListener('click', _onNext);

  els.scrubber.addEventListener('mousedown', _onScrubStart);
  els.scrubber.addEventListener('touchstart', _onScrubStart);
  els.scrubber.addEventListener('change', _onScrubEnd);
  els.scrubber.addEventListener('input', _onScrubInput);

  els.rateSelect.addEventListener('change', _onRateChange);

  if (els.qualitySelect) {
    els.qualitySelect.addEventListener('change', () => {
      // C-RT1: set reduced J2K decode level for real-time continuous playback.
      if (player && typeof player.setQuality === 'function') player.setQuality(els.qualitySelect.value);
    });
  }

  // Fallback actions (emit events for the host to handle)
  els.fbProxy.addEventListener('click', () => {
    container.dispatchEvent(new CustomEvent('pfx-imf-fallback', {
      bubbles: true, detail: { action: 'proxy', packageId: player.packageId, cplId: els.cplSelect.value }
    }));
  });
  els.fbResolve.addEventListener('click', () => {
    container.dispatchEvent(new CustomEvent('pfx-imf-fallback', {
      bubbles: true, detail: { action: 'resolve', packageId: player.packageId, cplId: els.cplSelect.value }
    }));
  });
  els.fbExternal.addEventListener('click', () => {
    // Try to open the package folder in Finder
    const pkg = player.packageData;
    if (pkg?.folderPath) _pfx()?.revealInFinder(pkg.folderPath).catch(() => {});
    container.dispatchEvent(new CustomEvent('pfx-imf-fallback', {
      bubbles: true, detail: { action: 'external', packageId: player.packageId }
    }));
  });

  // Keyboard shortcuts (only when focused within the panel)
  function _onKey(e) {
    if (!root.contains(document.activeElement) && document.activeElement !== document.body) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    switch (e.key) {
      case ' ':     e.preventDefault(); _onPlayPause(); break;
      case 'k':     _onPlayPause(); break;
      case 'l':     _onStop(); break;
      case 'ArrowLeft':  e.preventDefault(); player.stepBack(); break;
      case 'ArrowRight': e.preventDefault(); player.stepForward(); break;
      case 'ArrowUp':    e.preventDefault(); player.setRate(Math.min(4, player._rate * 2)); break;
      case 'ArrowDown':  e.preventDefault(); player.setRate(Math.max(0.25, player._rate / 2)); break;
    }
  }
  document.addEventListener('keydown', _onKey);

  // ── dispose ───────────────────────────────────────────────────────────────

  function dispose() {
    document.removeEventListener('keydown', _onKey);
    player.dispose();
    root.remove();
  }

  return {
    dispose,
    openPackage: _openPackage,
    player,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function _esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _framesToTC(frame, fps) {
  fps = fps || 24;
  const totalSec = frame / fps;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const f = Math.floor(frame % fps);
  return [h, m, s, f].map(n => String(n).padStart(2, '0')).join(':');
}
