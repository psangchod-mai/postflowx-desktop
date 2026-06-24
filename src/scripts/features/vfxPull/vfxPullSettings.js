// vfxPullSettings.js — Smart VFX Pull Setup Panel
// Vanilla JS, no modules — loaded via <script defer>

(function () {
  'use strict';

  // ── Presets ──────────────────────────────────────────────────────────────────

  var VFX_PULL_PRESETS = {
    arri_aces: {
      label: 'ARRI ACES Pull',
      format: 'EXR', bitDepth: '16-bit Half Float',
      colorspace: 'ACES Linear AP0 / ACES2065-1',
      compression: 'PIZ', startFrame: 1001, framePadding: 4,
      handles: 16, namingTemplate: '{reel}_{shotName}_v001',
      framingMode: 'Full Resolution',
    },
    netflix_mps: {
      label: 'Netflix / MPS ACES EXR',
      format: 'EXR', bitDepth: '16-bit Half Float',
      colorspace: 'ACES Linear AP0 / ACES2065-1',
      compression: 'PIZ', startFrame: 1001, framePadding: 4,
      handles: 24, namingTemplate: '{shotName}_PL01_v001',
      framingMode: 'Full Resolution',
    },
    apple_hdr: {
      label: 'Apple TV+ HDR DPX',
      format: 'DPX', bitDepth: '12-bit',
      colorspace: 'P3-D65 / PQ', compression: 'None',
      startFrame: 1001, framePadding: 4, handles: 12,
      namingTemplate: '{shotName}_PLATE_v{version}',
      framingMode: 'Full Resolution',
    },
    internal_proxy: {
      label: 'Internal Proxy Review',
      format: 'ProRes4444', bitDepth: '10-bit',
      colorspace: 'Rec.709', compression: 'None',
      startFrame: 1001, framePadding: 4, handles: 8,
      namingTemplate: '{shotName}_PROXY_v001',
      framingMode: 'Reframe to Delivery',
    },
    dailies: {
      label: 'Dailies / Client Review',
      format: 'ProRes4444XQ', bitDepth: '10-bit',
      colorspace: 'Rec.709', compression: 'None',
      startFrame: 1001, framePadding: 4, handles: 2,
      namingTemplate: '{clipName}_DAILY_{date}',
      framingMode: 'Letterbox',
    },
  };

  var COMPRESSION_OPTS = {
    EXR: ['PIZ', 'ZIP', 'ZIPS', 'B44', 'None'],
    DPX: ['None'],
    TIFF: ['LZW', 'ZIP', 'None'],
    ProRes4444: ['N/A'],
    ProRes4444XQ: ['N/A'],
  };

  var BITDEPTH_OPTS = {
    EXR: ['16-bit Half Float', '32-bit Float'],
    DPX: ['10-bit', '12-bit', '16-bit'],
    TIFF: ['8-bit', '16-bit'],
    ProRes4444: ['10-bit'],
    ProRes4444XQ: ['12-bit'],
  };

  var COLORSPACES = [
    'ACES Linear AP0 / ACES2065-1', 'ACEScct', 'ACEScg',
    'P3-D65 / PQ', 'P3-D65 / HLG', 'Rec.2020 / PQ',
    'Rec.709', 'sRGB', 'Log3G10 / RWG', 'S-Log3 / S-Gamut3',
  ];

  var DEFAULTS = {
    version: 2,
    presetKey: 'netflix_mps',
    format: 'EXR',
    bitDepth: '16-bit Half Float',
    colorspace: 'ACES Linear AP0 / ACES2065-1',
    compression: 'PIZ',
    startFrame: 1001,
    framePadding: 4,
    handles: 24,
    namingTemplate: '{shotName}_PL01_v001',
    framingMode: 'Full Resolution',
    outputRootPath: '',
    outputStructure: 'shot_per_folder',
    includePatterns: '',
    excludePatterns: '',
    verificationGate: true,
    requireAllApproved: false,
    resolveEngineMode: 'auto',
    speedRampFallback: 'warn',
    reframeHandling: 'warn',
    smartWarnings: true,
  };

  // ── State ─────────────────────────────────────────────────────────────────────

  var _vs = {
    settings: null,
    tab: 'setup',
    open: false,
    dirty: false,
  };

  // ── Storage ───────────────────────────────────────────────────────────────────

  function _vsKey() {
    var pk = (window.__pfxGetProjectKey && window.__pfxGetProjectKey()) || 'default';
    return 'pfx.prepmark.' + pk + '.vfxPullSettings.v2';
  }

  function _vsLoad() {
    try {
      var raw = localStorage.getItem(_vsKey());
      if (raw) {
        var saved = JSON.parse(raw);
        _vs.settings = Object.assign({}, DEFAULTS, saved, { version: 2 });
      } else {
        _vs.settings = Object.assign({}, DEFAULTS);
      }
    } catch (e) {
      _vs.settings = Object.assign({}, DEFAULTS);
    }
  }

  function _vsSave() {
    try {
      localStorage.setItem(_vsKey(), JSON.stringify(_vs.settings));
      _vs.dirty = false;
    } catch (e) {}
  }

  // ── Open / Close ──────────────────────────────────────────────────────────────

  function _vsOpen() {
    // Only reload from storage when there are no unsaved in-memory edits
    if (!_vs.settings || !_vs.dirty) _vsLoad();
    _vs.tab = 'setup';
    _vs.open = true;
    var modal = document.getElementById('pfxVfxSettingsModal');
    if (modal) {
      modal.removeAttribute('hidden');
      _vsRender();
    }
  }

  function _vsClose() {
    // Persist any dirty changes so they survive close-without-save
    if (_vs.dirty) _vsSave();
    _vs.open = false;
    var modal = document.getElementById('pfxVfxSettingsModal');
    if (modal) modal.setAttribute('hidden', '');
  }

  // ── Render ────────────────────────────────────────────────────────────────────

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function _vsSwitchTab(tab) {
    _vs.tab = tab;
    var modal = document.getElementById('pfxVfxSettingsModal');
    if (!modal) return;
    modal.querySelectorAll('.pfx-vfxs-tab').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    _vsRenderBody();
  }

  function _vsRender() {
    var modal = document.getElementById('pfxVfxSettingsModal');
    if (!modal) return;
    modal.querySelectorAll('.pfx-vfxs-tab').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.tab === _vs.tab);
    });
    _vsRenderBody();
  }

  function _vsRenderBody() {
    var body = document.getElementById('pfxVfxSettingsBody');
    if (!body) return;
    if (_vs.tab === 'setup')  body.innerHTML = _vsRenderSetup();
    if (_vs.tab === 'verify') body.innerHTML = _vsRenderVerify();
    if (_vs.tab === 'export') body.innerHTML = _vsRenderExport();
    _vsBindBody();
  }

  // ── Setup Tab ─────────────────────────────────────────────────────────────────

  function _vsRenderSetup() {
    var st = _vs.settings;

    var shots = (window._pfxGetVfxShotList && window._pfxGetVfxShotList()) || [];
    var previewShots = shots.slice(0, 4);
    var namingPreviewRows = previewShots.length
      ? previewShots.map(function (s) {
          return '<code class="pfx-vfxs-name-sample">' + esc(_vsExpandNaming(st.namingTemplate, s)) + '</code>';
        }).join('')
      : '<code class="pfx-vfxs-name-sample pfx-vfxs-name-sample-dim">' + esc(_vsExpandNaming(st.namingTemplate, { shotName: 'DLS_101_020_COMP', clipName: 'CAM_A001', version: '001', plate: '01' })) + '</code>';

    var formatBtns = ['EXR', 'DPX', 'TIFF', 'ProRes4444', 'ProRes4444XQ'].map(function (f) {
      return '<button class="pfx-vfxs-chip' + (st.format === f ? ' active' : '') + '" data-action="format" data-val="' + f + '">' + f + '</button>';
    }).join('');

    var comps = COMPRESSION_OPTS[st.format] || ['None'];
    var compressionHtml = comps.length === 1
      ? '<span class="pfx-vfxs-val-static">' + comps[0] + '</span>'
      : '<select class="pfx-vfxs-select" data-field="compression">' +
        comps.map(function (c) { return '<option value="' + esc(c) + '"' + (st.compression === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
        '</select>';

    var bds = BITDEPTH_OPTS[st.format] || ['10-bit'];
    var bitDepthHtml = bds.length === 1
      ? '<span class="pfx-vfxs-val-static">' + bds[0] + '</span>'
      : '<select class="pfx-vfxs-select" data-field="bitDepth">' +
        bds.map(function (b) { return '<option value="' + esc(b) + '"' + (st.bitDepth === b ? ' selected' : '') + '>' + esc(b) + '</option>'; }).join('') +
        '</select>';

    var colorspaceSel = '<select class="pfx-vfxs-select pfx-vfxs-select-wide" data-field="colorspace">' +
      COLORSPACES.map(function (c) { return '<option value="' + esc(c) + '"' + (st.colorspace === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') +
      '</select>';

    var presetBtns = Object.entries(VFX_PULL_PRESETS).map(function (entry) {
      var k = entry[0]; var p = entry[1];
      return '<button class="pfx-vfxs-preset-btn' + (st.presetKey === k ? ' active' : '') + '" data-action="preset" data-val="' + k + '">' +
        '<span class="pfx-vfxs-preset-label">' + esc(p.label) + '</span>' +
        '<span class="pfx-vfxs-preset-desc">' + p.format + ' · ' + p.bitDepth + ' · ' + p.handles + 'f handles</span>' +
        '</button>';
    }).join('');

    var framingBtns = ['Full Resolution', 'Reframe to Delivery', 'Letterbox'].map(function (f) {
      return '<button class="pfx-vfxs-chip' + (st.framingMode === f ? ' active' : '') + '" data-action="framing" data-val="' + esc(f) + '">' + esc(f) + '</button>';
    }).join('');

    // Handles warning: check if any shot has srcIn less than handles frames from reel start
    // We flag retimed shots separately
    var retimedCount = shots.filter(function (s) { return s.hasSpeedChange; }).length;
    var reframeCount = shots.filter(function (s) { return s.hasReframe; }).length;

    return (
      '<div class="pfx-vfxs-section">' +
        '<div class="pfx-vfxs-section-title">Preset</div>' +
        '<div class="pfx-vfxs-preset-grid">' + presetBtns + '</div>' +
      '</div>' +

      '<div class="pfx-vfxs-section">' +
        '<div class="pfx-vfxs-section-title">Format Lock</div>' +
        '<div class="pfx-vfxs-row pfx-vfxs-row-wrap">' +
          '<div class="pfx-vfxs-field-group">' +
            '<label class="pfx-vfxs-field-label">Container</label>' +
            '<div class="pfx-vfxs-chip-row">' + formatBtns + '</div>' +
          '</div>' +
          '<div class="pfx-vfxs-field-group">' +
            '<label class="pfx-vfxs-field-label">Bit Depth</label>' + bitDepthHtml +
          '</div>' +
          '<div class="pfx-vfxs-field-group">' +
            '<label class="pfx-vfxs-field-label">Compression</label>' + compressionHtml +
          '</div>' +
        '</div>' +
        '<div class="pfx-vfxs-field-group" style="margin-top:10px;">' +
          '<label class="pfx-vfxs-field-label">Colorspace / Transfer</label>' + colorspaceSel +
        '</div>' +
      '</div>' +

      '<div class="pfx-vfxs-section">' +
        '<div class="pfx-vfxs-section-title">Frame Range</div>' +
        '<div class="pfx-vfxs-row">' +
          '<div class="pfx-vfxs-field-group">' +
            '<label class="pfx-vfxs-field-label">Start Frame</label>' +
            '<input class="pfx-vfxs-input pfx-vfxs-input-sm" type="number" data-field="startFrame" value="' + st.startFrame + '" min="0" max="9999">' +
          '</div>' +
          '<div class="pfx-vfxs-field-group">' +
            '<label class="pfx-vfxs-field-label">Frame # Padding</label>' +
            '<input class="pfx-vfxs-input pfx-vfxs-input-sm" type="number" data-field="framePadding" value="' + st.framePadding + '" min="1" max="8">' +
          '</div>' +
          '<div class="pfx-vfxs-field-group">' +
            '<label class="pfx-vfxs-field-label">Handles (frames)</label>' +
            '<input class="pfx-vfxs-input pfx-vfxs-input-sm" type="number" data-field="handles" value="' + st.handles + '" min="0" max="120">' +
          '</div>' +
        '</div>' +
        (retimedCount > 0 ? '<div class="pfx-vfxs-warn-inline">⚠ ' + retimedCount + ' retimed shot' + (retimedCount > 1 ? 's' : '') + ' — verify handles cover retime range</div>' : '') +
      '</div>' +

      '<div class="pfx-vfxs-section">' +
        '<div class="pfx-vfxs-section-title">Output Naming Template</div>' +
        '<div class="pfx-vfxs-field-group">' +
          '<div class="pfx-vfxs-row pfx-vfxs-row-nowrap">' +
            '<input class="pfx-vfxs-input pfx-vfxs-input-wide" type="text" data-field="namingTemplate" value="' + esc(st.namingTemplate) + '" placeholder="{shotName}_PL01_v001">' +
          '</div>' +
          '<div class="pfx-vfxs-token-hints">' +
            '<span class="pfx-vfxs-token-label">Insert:</span>' +
            '<span class="pfx-vfxs-token" title="Shot name from marker">{shotName}</span>' +
            '<span class="pfx-vfxs-token" title="Clip/reel name from EDL">{clipName}</span>' +
            '<span class="pfx-vfxs-token" title="Version number (e.g. 001)">{version}</span>' +
            '<span class="pfx-vfxs-token" title="Plate number (e.g. 01)">{plate}</span>' +
            '<span class="pfx-vfxs-token" title="Today\'s date YYYYMMDD">{date}</span>' +
          '</div>' +
          '<div class="pfx-vfxs-name-preview">' + namingPreviewRows + '</div>' +
        '</div>' +
      '</div>' +

      '<div class="pfx-vfxs-section">' +
        '<div class="pfx-vfxs-section-title">Framing Mode</div>' +
        '<div class="pfx-vfxs-chip-row">' + framingBtns + '</div>' +
        (reframeCount > 0 && st.framingMode === 'Full Resolution'
          ? '<div class="pfx-vfxs-warn-inline">⚠ ' + reframeCount + ' shot' + (reframeCount > 1 ? 's have' : ' has') + ' a reframe — Full Resolution may not match delivery spec</div>'
          : '') +
        (st.framingMode !== 'Full Resolution'
          ? '<div class="pfx-vfxs-info-inline">Reframe and letterbox require Resolve engine — confirm reformat dimensions in project settings</div>'
          : '') +
      '</div>'
    );
  }

  // ── Verify Tab ────────────────────────────────────────────────────────────────

  function _vsRenderVerify() {
    var st = _vs.settings;
    var shots = (window._pfxGetVfxShotList && window._pfxGetVfxShotList()) || [];
    var warnings = _vsGetWarnings(shots);

    // PFX_RESOLVE_STATUS is an object { state, label, sub, ... } — the connected
    // state lives on `.state`, not the value itself (was comparing object to strings,
    // which is always false → Verify tab always showed Resolve as not connected).
    var resolveOk = !!(window.PFX_RESOLVE_STATUS && window.PFX_RESOLVE_STATUS.state === 'connected');

    var total = shots.length;
    var approved = shots.filter(function (s) { return s.approved; }).length;
    var linked = shots.filter(function (s) { return s.ocfLinked; }).length;
    var withSpeed = shots.filter(function (s) { return s.hasSpeedChange; }).length;
    var withReframe = shots.filter(function (s) { return s.hasReframe; }).length;
    var pct = total > 0 ? Math.round((approved / total) * 100) : 0;
    var gateColor = pct === 100 ? '#4caf80' : pct >= 50 ? '#e8c040' : '#e06060';

    var shotRows = shots.length ? shots.map(function (s) {
      var ocfBadge = s.ocfLinked
        ? '<span class="pfx-vfxs-badge pfx-vfxs-badge-ok">OCF</span>'
        : '<span class="pfx-vfxs-badge pfx-vfxs-badge-err">NO OCF</span>';
      var approvedBadge = s.approved
        ? '<span class="pfx-vfxs-badge pfx-vfxs-badge-ok">✓</span>'
        : '<span class="pfx-vfxs-badge pfx-vfxs-badge-pending">—</span>';
      var flags = '';
      if (s.hasSpeedChange) flags += '<span class="pfx-vfxs-badge pfx-vfxs-badge-warn">RETIME</span>';
      if (s.hasReframe)     flags += '<span class="pfx-vfxs-badge pfx-vfxs-badge-warn">REFRAME</span>';
      var score = s.matchScore != null ? Math.round(s.matchScore * 100) + '%' : '—';
      return '<tr>' +
        '<td class="pfx-vfxs-vt-shot">' + esc(s.shotName || s.clipName || '—') + '</td>' +
        '<td>' + ocfBadge + '</td>' +
        '<td>' + approvedBadge + '</td>' +
        '<td>' + (flags || '<span class="pfx-vfxs-vt-none">—</span>') + '</td>' +
        '<td class="pfx-vfxs-vt-score">' + esc(score) + '</td>' +
        '</tr>';
    }).join('') : '<tr><td colspan="5" class="pfx-vfxs-empty">No VFX shots loaded — import an EDL with VFX markers</td></tr>';

    var warnHtml = warnings.length
      ? '<div class="pfx-vfxs-section">' +
          '<div class="pfx-vfxs-section-title">Smart Warnings <span class="pfx-vfxs-warn-count">' + warnings.length + '</span></div>' +
          '<div class="pfx-vfxs-warn-list">' +
          warnings.map(function (w) {
            return '<div class="pfx-vfxs-warn-item ' + w.level + '">' +
              '<span class="pfx-vfxs-warn-icon">' + (w.level === 'error' ? '✕' : '⚠') + '</span>' +
              '<span>' + esc(w.msg) + '</span>' +
              '</div>';
          }).join('') +
          '</div>' +
        '</div>'
      : '<div class="pfx-vfxs-section"><div class="pfx-vfxs-ok-banner">✓ No warnings — settings look good for this shot list</div></div>';

    return (
      '<div class="pfx-vfxs-section">' +
        '<div class="pfx-vfxs-section-title">Resolve Engine</div>' +
        '<div class="pfx-vfxs-resolve-row">' +
          '<span class="pfx-vfxs-resolve-dot ' + (resolveOk ? 'ok' : 'err') + '"></span>' +
          '<span class="pfx-vfxs-resolve-status">' + (resolveOk ? 'Connected' : 'Not Connected') + '</span>' +
          (!resolveOk ? '<span class="pfx-vfxs-resolve-hint">EXR / DPX pulls require Resolve — connect via the Resolve Engine panel first</span>' : '') +
        '</div>' +
      '</div>' +

      '<div class="pfx-vfxs-section">' +
        '<div class="pfx-vfxs-section-title">Verification Gate</div>' +
        '<div class="pfx-vfxs-gate-row">' +
          '<div class="pfx-vfxs-gate-bar-wrap">' +
            '<div class="pfx-vfxs-gate-bar" style="width:' + pct + '%;background:' + gateColor + ';"></div>' +
          '</div>' +
          '<span class="pfx-vfxs-gate-pct" style="color:' + gateColor + '">' + pct + '%</span>' +
          '<span class="pfx-vfxs-gate-label">' + approved + '/' + total + ' approved</span>' +
        '</div>' +
        '<div class="pfx-vfxs-gate-stats">' +
          '<span class="pfx-vfxs-stat"><span class="pfx-vfxs-stat-val" style="color:#4caf80">' + linked + '</span> OCF linked</span>' +
          '<span class="pfx-vfxs-stat"><span class="pfx-vfxs-stat-val" style="color:#e8c040">' + withSpeed + '</span> retimed</span>' +
          '<span class="pfx-vfxs-stat"><span class="pfx-vfxs-stat-val" style="color:#e8c040">' + withReframe + '</span> reframed</span>' +
        '</div>' +
      '</div>' +

      warnHtml +

      '<div class="pfx-vfxs-section">' +
        '<div class="pfx-vfxs-section-title">Shot Checklist <span class="pfx-vfxs-count-chip">' + total + '</span></div>' +
        '<div class="pfx-vfxs-vt-scroll">' +
          '<table class="pfx-vfxs-verify-table">' +
            '<thead><tr><th>Shot</th><th>OCF</th><th>Approved</th><th>Flags</th><th>Score</th></tr></thead>' +
            '<tbody>' + shotRows + '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>'
    );
  }

  // ── Export Tab ────────────────────────────────────────────────────────────────

  function _vsRenderExport() {
    var st = _vs.settings;
    var shots = (window._pfxGetVfxShotList && window._pfxGetVfxShotList()) || [];
    var warnings = _vsGetWarnings(shots);
    var errors = warnings.filter(function (w) { return w.level === 'error'; });
    // requireAllApproved is an independent hard gate regardless of verificationGate
    var unapprovedBlocking = st.requireAllApproved && shots.some(function (s) { return !s.approved; });
    var canExport = (!st.verificationGate || errors.length === 0) && !unapprovedBlocking;

    var ext = st.format.startsWith('ProRes') ? 'mov' : st.format.toLowerCase();
    var pad = String(st.startFrame).padStart(st.framePadding, '0');
    var root = (st.outputRootPath || '/path/to/output').replace(/\/+$/, '');

    var previewPaths = shots.slice(0, 5).map(function (s) {
      var base = _vsExpandNaming(st.namingTemplate, s);
      if (st.outputStructure === 'shot_per_folder') {
        return root + '/' + base + '/' + base + '.' + pad + '.' + ext;
      } else if (st.outputStructure === 'date_stamped') {
        var _d = new Date(); var _ds = String(_d.getFullYear()) + String(_d.getMonth()+1).padStart(2,'0') + String(_d.getDate()).padStart(2,'0');
        return root + '/' + _ds + '/' + base + '.' + pad + '.' + ext;
      }
      return root + '/' + base + '.' + pad + '.' + ext;
    });

    var structOpts = [
      { val: 'shot_per_folder', label: 'Shot per Folder', hint: 'output/ShotName/ShotName.1001.exr' },
      { val: 'flat',            label: 'Flat',            hint: 'output/ShotName.1001.exr' },
      { val: 'date_stamped',    label: 'Date Stamped',    hint: 'output/YYYYMMDD/ShotName.1001.exr' },
    ];

    var structBtns = structOpts.map(function (o) {
      return '<label class="pfx-vfxs-radio-label' + (st.outputStructure === o.val ? ' active' : '') + '">' +
        '<input type="radio" name="outputStructure" value="' + o.val + '"' + (st.outputStructure === o.val ? ' checked' : '') + '> ' +
        '<span><strong>' + o.label + '</strong><code class="pfx-vfxs-path-hint">' + esc(o.hint) + '</code></span>' +
        '</label>';
    }).join('');

    var gateBlock = (!canExport && st.verificationGate)
      ? '<div class="pfx-vfxs-gate-block">' +
          '<span class="pfx-vfxs-gate-block-icon">✕</span>' +
          '<strong>Export blocked</strong> — ' + errors.length + ' error' + (errors.length > 1 ? 's' : '') +
          ' must be resolved. Check the Verify tab.' +
        '</div>'
      : '';

    return (
      '<div class="pfx-vfxs-section">' +
        '<div class="pfx-vfxs-section-title">Output Root</div>' +
        '<div class="pfx-vfxs-row pfx-vfxs-row-nowrap">' +
          '<input class="pfx-vfxs-input pfx-vfxs-input-wide" type="text" id="pfxVfxStOutputPath" data-field="outputRootPath" value="' + esc(st.outputRootPath) + '" placeholder="/Volumes/Shared/VFXPulls/ProjectName">' +
          '<button class="pfx-vfxs-btn pfx-vfxs-btn-ghost" id="pfxVfxStPickFolder">Browse…</button>' +
        '</div>' +
      '</div>' +

      '<div class="pfx-vfxs-section">' +
        '<div class="pfx-vfxs-section-title">Output Structure</div>' +
        '<div class="pfx-vfxs-radio-group">' + structBtns + '</div>' +
      '</div>' +

      '<div class="pfx-vfxs-section">' +
        '<div class="pfx-vfxs-section-title">Filters <span class="pfx-vfxs-section-sub">(optional glob patterns)</span></div>' +
        '<div class="pfx-vfxs-row pfx-vfxs-row-wrap">' +
          '<div class="pfx-vfxs-field-group" style="flex:1;min-width:180px">' +
            '<label class="pfx-vfxs-field-label">Include (one per line)</label>' +
            '<textarea class="pfx-vfxs-textarea" data-field="includePatterns" rows="3" placeholder="DLS_*&#10;VFX_*">' + esc(st.includePatterns) + '</textarea>' +
          '</div>' +
          '<div class="pfx-vfxs-field-group" style="flex:1;min-width:180px">' +
            '<label class="pfx-vfxs-field-label">Exclude (one per line)</label>' +
            '<textarea class="pfx-vfxs-textarea" data-field="excludePatterns" rows="3" placeholder="*_PROXY*&#10;*_OLD*">' + esc(st.excludePatterns) + '</textarea>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div class="pfx-vfxs-section">' +
        '<div class="pfx-vfxs-section-title">Output Preview</div>' +
        '<div class="pfx-vfxs-path-preview">' +
          previewPaths.map(function (p) { return '<code class="pfx-vfxs-path-row">' + esc(p) + '</code>'; }).join('') +
          (shots.length > 5 ? '<span class="pfx-vfxs-path-more">+ ' + (shots.length - 5) + ' more shots…</span>' : '') +
          (!shots.length ? '<span class="pfx-vfxs-path-more">Load shots to preview output paths</span>' : '') +
        '</div>' +
      '</div>' +

      '<div class="pfx-vfxs-section">' +
        '<div class="pfx-vfxs-section-title">Gate Options</div>' +
        '<label class="pfx-vfxs-checkbox-row">' +
          '<input type="checkbox" data-field="verificationGate"' + (st.verificationGate ? ' checked' : '') + '>' +
          ' Block export when errors are detected' +
        '</label>' +
        '<label class="pfx-vfxs-checkbox-row">' +
          '<input type="checkbox" data-field="requireAllApproved"' + (st.requireAllApproved ? ' checked' : '') + '>' +
          ' Require all shots to be approved' +
        '</label>' +
      '</div>' +

      gateBlock
    );
  }

  // ── Smart Warnings ────────────────────────────────────────────────────────────

  function _vsGetWarnings(shots) {
    var st = _vs.settings;
    var w = [];

    var noOcf = shots.filter(function (s) { return !s.ocfLinked; });
    if (noOcf.length) {
      w.push({ level: 'error', msg: noOcf.length + ' shot' + (noOcf.length > 1 ? 's have' : ' has') + ' no OCF source linked: ' + noOcf.slice(0, 3).map(function (s) { return s.shotName || s.clipName; }).join(', ') + (noOcf.length > 3 ? '…' : '') });
    }
    var reviewOcf = shots.filter(function (s) { return s.ocfStatus === 'review'; });
    if (reviewOcf.length) {
      w.push({ level: 'error', msg: reviewOcf.length + ' shot' + (reviewOcf.length > 1 ? 's have' : ' has') + ' an OCF match that needs review — verify and approve before exporting: ' + reviewOcf.slice(0, 3).map(function (s) { return s.shotName || s.clipName; }).join(', ') + (reviewOcf.length > 3 ? '…' : '') });
    }

    if (st.requireAllApproved) {
      var unapproved = shots.filter(function (s) { return !s.approved; });
      if (unapproved.length) {
        w.push({ level: 'error', msg: unapproved.length + ' shot' + (unapproved.length > 1 ? 's' : '') + ' not yet approved — export gate is blocking' });
      }
    }

    if ((st.format === 'EXR' || st.format === 'DPX') &&
        !(window.PFX_RESOLVE_STATUS && window.PFX_RESOLVE_STATUS.state === 'connected')) {
      w.push({ level: 'error', msg: 'Format is ' + st.format + ' but Resolve engine is not connected — connect Resolve to enable EXR/DPX extraction' });
    }

    if (!st.namingTemplate ||
        (!st.namingTemplate.includes('{shotName}') && !st.namingTemplate.includes('{clipName}'))) {
      w.push({ level: 'warn', msg: 'Naming template does not include {shotName} or {clipName} — all output files will have the same base name' });
    }

    var speedShots = shots.filter(function (s) { return s.hasSpeedChange; });
    if (speedShots.length) {
      w.push({ level: 'warn', msg: speedShots.length + ' shot' + (speedShots.length > 1 ? 's have' : ' has') + ' a retime — verify handles and frame count cover the full speed-adjusted range' });
    }

    var reframeShots = shots.filter(function (s) { return s.hasReframe; });
    if (reframeShots.length && st.framingMode === 'Full Resolution') {
      w.push({ level: 'warn', msg: reframeShots.length + ' shot' + (reframeShots.length > 1 ? 's have' : ' has') + ' a reframe — current framing mode is Full Resolution, which may not match delivery spec' });
    }

    if (!st.outputRootPath) {
      w.push({ level: 'warn', msg: 'Output root path is empty — set it in the Export tab before running' });
    }

    return w;
  }

  // ── Naming helpers ────────────────────────────────────────────────────────────

  function _vsExpandNaming(template, shot) {
    var t = template || '{shotName}_v001';
    var d = new Date();
    var date = String(d.getFullYear()) +
      String(d.getMonth() + 1).padStart(2, '0') +
      String(d.getDate()).padStart(2, '0');
    return t
      .replace(/\{shotName\}/g, shot.shotName || shot.clipName || 'SHOT')
      .replace(/\{clipName\}/g, shot.clipName || shot.shotName || 'CLIP')
      .replace(/\{version\}/g, shot.version || '001')
      .replace(/\{plate\}/g, shot.plate || '01')
      .replace(/\{date\}/g, date);
  }

  function _vsUpdateNamingPreview() {
    var preview = document.querySelector('.pfx-vfxs-name-preview');
    if (!preview) return;
    var shots = (window._pfxGetVfxShotList && window._pfxGetVfxShotList()) || [];
    var tpl = _vs.settings.namingTemplate;
    var rows = shots.slice(0, 4);
    if (rows.length) {
      preview.innerHTML = rows.map(function (s) {
        return '<code class="pfx-vfxs-name-sample">' + esc(_vsExpandNaming(tpl, s)) + '</code>';
      }).join('');
    } else {
      preview.innerHTML = '<code class="pfx-vfxs-name-sample pfx-vfxs-name-sample-dim">' +
        esc(_vsExpandNaming(tpl, { shotName: 'DLS_101_020_COMP', clipName: 'CAM_A001' })) + '</code>';
    }
  }

  // ── Body bindings ─────────────────────────────────────────────────────────────

  function _vsBindBody() {
    var body = document.getElementById('pfxVfxSettingsBody');
    if (!body) return;

    body.querySelectorAll('[data-action="preset"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.dataset.val;
        if (VFX_PULL_PRESETS[key]) {
          var p = VFX_PULL_PRESETS[key];
          Object.assign(_vs.settings, {
            presetKey: key,
            format: p.format, bitDepth: p.bitDepth, colorspace: p.colorspace,
            compression: p.compression, startFrame: p.startFrame,
            framePadding: p.framePadding, handles: p.handles,
            namingTemplate: p.namingTemplate, framingMode: p.framingMode,
          });
          _vs.dirty = true;
          _vsRenderBody();
        }
      });
    });

    body.querySelectorAll('[data-action="format"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _vs.settings.format = btn.dataset.val;
        _vs.settings.presetKey = 'custom';
        // Snap bitDepth + compression to valid first option if they no longer apply
        var bds = BITDEPTH_OPTS[btn.dataset.val] || ['10-bit'];
        if (!bds.includes(_vs.settings.bitDepth)) _vs.settings.bitDepth = bds[0];
        var comps = COMPRESSION_OPTS[btn.dataset.val] || ['None'];
        if (!comps.includes(_vs.settings.compression)) _vs.settings.compression = comps[0];
        _vs.dirty = true;
        _vsRenderBody();
      });
    });

    body.querySelectorAll('[data-action="framing"]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _vs.settings.framingMode = btn.dataset.val;
        _vs.dirty = true;
        _vsRenderBody();
      });
    });

    body.querySelectorAll('[data-field]').forEach(function (el) {
      var field = el.dataset.field;
      if (!field) return;
      var evName = (el.tagName === 'INPUT' && el.type === 'checkbox') ? 'change' : 'input';
      el.addEventListener(evName, function () {
        if (el.type === 'checkbox') {
          _vs.settings[field] = el.checked;
        } else if (el.type === 'number') {
          var n = Number(el.value);
          if (!isNaN(n)) _vs.settings[field] = n;
        } else {
          _vs.settings[field] = el.value;
        }
        _vs.dirty = true;
        if (field === 'namingTemplate') _vsUpdateNamingPreview();
      });
    });

    body.querySelectorAll('input[name="outputStructure"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        if (radio.checked) {
          _vs.settings.outputStructure = radio.value;
          _vs.dirty = true;
          _vsRenderBody();
        }
      });
    });

    // Token hint click → append to naming template input
    body.querySelectorAll('.pfx-vfxs-token').forEach(function (tok) {
      tok.addEventListener('click', function () {
        var inp = body.querySelector('[data-field="namingTemplate"]');
        if (!inp) return;
        var pos = inp.selectionStart != null ? inp.selectionStart : inp.value.length;
        inp.value = inp.value.slice(0, pos) + tok.textContent + inp.value.slice(pos);
        _vs.settings.namingTemplate = inp.value;
        _vs.dirty = true;
        _vsUpdateNamingPreview();
        inp.focus();
        inp.setSelectionRange(pos + tok.textContent.length, pos + tok.textContent.length);
      });
    });

    // Browse output folder
    var pickBtn = body.querySelector('#pfxVfxStPickFolder');
    if (pickBtn) {
      pickBtn.addEventListener('click', function () {
        try {
          chrome.runtime.sendMessage(
            { type: 'IMF_COMPANION_CALL', payload: { action: 'pickFolder', title: 'Select VFX Pull Output Folder', mode: 'write' }, timeoutMs: 30000 },
            function (res) {
              void chrome.runtime.lastError;
              var path = res && res.ok && (res.response && (res.response.path || res.response.folder || (res.response.data && (res.response.data.path || res.response.data.folder))));
              if (path) {
                _vs.settings.outputRootPath = path;
                _vs.dirty = true;
                var inp = document.getElementById('pfxVfxStOutputPath');
                if (inp) inp.value = path;
              }
            }
          );
        } catch (e) {}
      });
    }
  }

  // ── Wire ──────────────────────────────────────────────────────────────────────

  function _vsWire() {
    var openBtn = document.getElementById('pfxVfxSettingsBtn');
    if (openBtn) openBtn.addEventListener('click', _vsOpen);

    var modal = document.getElementById('pfxVfxSettingsModal');
    if (!modal) return;

    var scrim = modal.querySelector('#pfxVfxSettingsScrim');
    if (scrim) scrim.addEventListener('click', _vsClose);

    var closeBtn = modal.querySelector('#pfxVfxSettingsClose');
    if (closeBtn) closeBtn.addEventListener('click', _vsClose);

    modal.querySelectorAll('.pfx-vfxs-tab').forEach(function (btn) {
      btn.addEventListener('click', function () { _vsSwitchTab(btn.dataset.tab); });
    });

    var cancelBtn = modal.querySelector('#pfxVfxSettingsCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', _vsClose);

    var updateBtn = modal.querySelector('#pfxVfxSettingsUpdate');
    if (updateBtn) {
      updateBtn.addEventListener('click', function () {
        _vsSave();
        _vsClose();
      });
    }

    var resetBtn = modal.querySelector('#pfxVfxSettingsReset');
    if (resetBtn) {
      resetBtn.addEventListener('click', function () {
        if (confirm('Reset all VFX Pull settings to defaults?')) {
          _vs.settings = Object.assign({}, DEFAULTS);
          _vs.dirty = true;
          _vsRenderBody();
        }
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && _vs.open) _vsClose();
    });
  }

  document.addEventListener('DOMContentLoaded', _vsWire);

  // Public API
  window._pfxVfxSettingsOpen  = _vsOpen;
  window._pfxVfxSettingsClose = _vsClose;
  window._pfxVfxSettingsGet   = function () { return Object.assign({}, _vs.settings || DEFAULTS); };

}());
