// smartOcfPullController.js — PostFlowX OCF → EXR Pull UI controller
// Wires the #pmOcfCard UI to the smart modules and native helper.
// Import and call initOcfPullCard(getEvents, getProjectMeta) from prep_mark.js.

import { matchAllEvents, matchOcfToEvent, matchSummary, findUnmatchedOcf, MATCH_STATUS } from './smartOcfMatcher.js';
import { buildAllExrJobs } from './smartExrPullPlanner.js';
import { ExrExportQueue } from './smartExrExportQueue.js';
import { validateAll, qcSummary } from './smartExrQCValidator.js';
import {
  buildShotsCSV, buildJobsJSON, buildQCTextReport,
  buildResolveHandoffScript, buildNukeHandoffScript,
} from './smartExrReportExporter.js';
import {
  nativePickOcfFolder, nativeProbeOcfFolder, nativeExportEXR,
  nativeOpenOutputFolder, nativeSetProxyRoot,
} from '../modules/native_helper_client.js';
import { openMedia, getPreviewFrame, closeMedia } from '../media/mediaRuntime.js';

// ── Utilities ─────────────────────────────────────────────────────────────────
function _esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── State ─────────────────────────────────────────────────────────────────────
const _LS_KEY = 'pfx.prepmark.ocfPull.v1';

let _state = {
  folderPath: null,
  ocfFiles: [],
  matchResults: [],
  jobs: [],
  qcResults: [],
  queue: null,
  outputBasePath: '',
  _mockMode: false,
};

let _providers = {
  getEvents: null,
  getProjectMeta: null,
};

let _matchFilter = 'all';
let _assistUiWired = false;

function _isAbsolutePath(path) {
  const v = String(path || '').trim();
  return !!v && (/^\//.test(v) || /^[A-Za-z]:[\\/]/.test(v));
}

function _folderLabel(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || String(path || '');
}

function _savedMediaRoot() {
  try { return String(localStorage.getItem('pfx_media_root_path') || '').trim(); }
  catch { return ''; }
}

function _normaliseFolderPath(path) {
  const raw = String(path || '').trim();
  if (!raw) return '';
  if (_isAbsolutePath(raw)) return raw;

  const mediaRoot = _savedMediaRoot();
  if (!_isAbsolutePath(mediaRoot)) return raw;

  const cleanRaw = raw.replace(/\\/g, '/').replace(/^\.?\/*/, '');
  if (!cleanRaw) return raw;

  const base = mediaRoot.replace(/\/+$/, '');
  const baseName = base.split('/').filter(Boolean).pop() || '';
  if (!baseName) return `${base}/${cleanRaw}`;
  if (cleanRaw === baseName) return base;
  if (cleanRaw.startsWith(`${baseName}/`)) {
    const parent = base.split('/').slice(0, -1).join('/') || '/';
    return `${parent.replace(/\/+$/, '')}/${cleanRaw}`;
  }
  return `${base}/${cleanRaw}`;
}

function _setFolderPath(path) {
  const normalised = _normaliseFolderPath(path);
  _state.folderPath = normalised || String(path || '').trim() || null;
  const pathEl = _el('pmOcfFolderPath');
  if (pathEl && _state.folderPath) {
    pathEl.textContent = _folderLabel(_state.folderPath);
    pathEl.classList.add('has-path');
  }
  return _state.folderPath;
}

function _persistState() {
  try {
    localStorage.setItem(_LS_KEY, JSON.stringify({
      folderPath:     _state.folderPath,
      outputBasePath: _state.outputBasePath,
      settings: {
        handleFrames: _el('pmOcfHandles')?.value,
        frameStart:   _el('pmOcfFrameStart')?.value,
        bitDepth:     _el('pmOcfBitDepth')?.value,
        compression:  _el('pmOcfCompression')?.value,
        colorMode:    _el('pmOcfColorMode')?.value,
        resolution:   _el('pmOcfResolution')?.value,
        outputPath:   _el('pmOcfOutputPath')?.value,
      },
    }));
  } catch {}
}

function _restoreState() {
  try {
    const saved = JSON.parse(localStorage.getItem(_LS_KEY) || '{}');
    if (saved.folderPath) {
      const restoredPath = _setFolderPath(saved.folderPath);
      if (restoredPath && restoredPath !== saved.folderPath) {
        // Heal older sessions that persisted only the folder label (e.g. "BBL")
        // instead of the absolute folder path required by the native probe.
        try { localStorage.setItem(_LS_KEY, JSON.stringify({ ...saved, folderPath: restoredPath })); } catch {}
      }
      _setEnabled('pmOcfAnalyzeBtn', true);
    }
    if (saved.outputBasePath) {
      _state.outputBasePath = saved.outputBasePath;
      const outEl = _el('pmOcfOutputPath');
      if (outEl) outEl.value = saved.outputBasePath;
    }
    if (saved.settings) {
      const s = saved.settings;
      if (s.handleFrames  != null && _el('pmOcfHandles'))     _el('pmOcfHandles').value     = s.handleFrames;
      if (s.frameStart    != null && _el('pmOcfFrameStart'))  _el('pmOcfFrameStart').value  = s.frameStart;
      if (s.bitDepth      && _el('pmOcfBitDepth'))    _el('pmOcfBitDepth').value    = s.bitDepth;
      if (s.compression   && _el('pmOcfCompression')) _el('pmOcfCompression').value = s.compression;
      if (s.colorMode     && _el('pmOcfColorMode'))   _el('pmOcfColorMode').value   = s.colorMode;
      if (s.resolution    && _el('pmOcfResolution'))  _el('pmOcfResolution').value  = s.resolution;
      if (s.outputPath    && _el('pmOcfOutputPath'))  _el('pmOcfOutputPath').value  = s.outputPath;
    }
  } catch {}
}

// ── Smart output path helper ───────────────────────────────────────────────────
function _suggestOutputPath() {
  // 1. Existing user value
  const existing = _el('pmOcfOutputPath')?.value?.trim();
  if (existing) return existing;
  // 2. Project name from EDL
  const proj = window.__MPS_EDL_RAW?.projectName?.replace(/[^A-Za-z0-9_\-]/g,'_');
  // 3. Working folder from Sources section
  const wfVal = document.getElementById('pmSlySrcFolVal')?.textContent?.trim();
  const wfPath = wfVal && wfVal !== 'NMO' && wfVal.startsWith('/') ? wfVal : null;
  if (wfPath && proj) return `${wfPath}/${proj}_EXR_Pull`;
  if (proj) return `/tmp/${proj}_EXR_Pull`;
  return '/tmp/PostFlowX_EXR_Pull';
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _el(id) { return document.getElementById(id); }

function _setBadge(text, variant = '') {
  const b = _el('pmOcfStatusBadge');
  if (!b) return;
  b.textContent = text;
  b.className = 'pm-ocf-status-badge' + (variant ? ` is-${variant}` : '');
}

function _setEnabled(id, enabled) {
  const el = _el(id);
  if (el) el.disabled = !enabled;
}

function _log(msg) {
  const box = _el('pmOcfLog');
  if (!box) return;
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function _getEventsNow() {
  try { return _providers.getEvents?.() || []; }
  catch { return []; }
}

function _getProjectMetaNow() {
  try { return _providers.getProjectMeta?.() || {}; }
  catch { return {}; }
}

function _tcToFramesSafe(tc, fps = 24) {
  const parts = String(tc || '').replace(/[;,]/g, ':').split(':');
  if (parts.length < 4) return NaN;
  const [h, m, s, f] = parts.map(Number);
  if ([h, m, s, f].some(n => !Number.isFinite(n))) return NaN;
  return ((h * 3600 + m * 60 + s) * fps) + f;
}

function _estimateEventFrames(event, fps = 24) {
  const inF = _tcToFramesSafe(event?.srcIn || event?.recIn, fps);
  const outF = _tcToFramesSafe(event?.srcOut || event?.recOut || event?.srcIn || event?.recIn, fps);
  const explicit = Number(event?.durationFrames || 0);
  if (Number.isFinite(outF) && Number.isFinite(inF) && outF >= inF) {
    return Math.max(1, outF - inF + 1, explicit || 0);
  }
  return Math.max(1, explicit || 1);
}

function _mean(nums = []) {
  if (!nums.length) return 0;
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}

function _percent(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

function _ensureSmartAssistUi() {
  const card = _el('pmOcfCard');
  if (!card) return null;

  if (!_el('pmOcfAssistStyle')) {
    const style = document.createElement('style');
    style.id = 'pmOcfAssistStyle';
    style.textContent = `
      .pm-ocf-assist {
        margin: 12px 0;
        padding: 14px;
        border-radius: 14px;
        border: 1px solid rgba(99, 142, 255, 0.24);
        background:
          radial-gradient(circle at top right, rgba(99,142,255,0.18), transparent 36%),
          linear-gradient(180deg, rgba(15,22,38,0.96), rgba(10,16,28,0.96));
        box-shadow: 0 14px 34px rgba(0,0,0,0.22);
      }
      .pm-ocf-assist-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }
      .pm-ocf-assist-title {
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #b8c7ff;
      }
      .pm-ocf-assist-score {
        padding: 4px 9px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 700;
        background: rgba(255,255,255,0.08);
        color: #e8eeff;
      }
      .pm-ocf-assist-score.is-ok { background: rgba(55, 181, 115, 0.18); color: #91f0bb; }
      .pm-ocf-assist-score.is-warn { background: rgba(255, 185, 74, 0.18); color: #ffd589; }
      .pm-ocf-assist-score.is-error { background: rgba(255, 93, 109, 0.18); color: #ffb4bd; }
      .pm-ocf-assist-headline {
        font-size: 15px;
        font-weight: 700;
        color: #f5f8ff;
        margin-bottom: 4px;
      }
      .pm-ocf-assist-sub {
        font-size: 12px;
        line-height: 1.45;
        color: rgba(228, 235, 255, 0.76);
        margin-bottom: 10px;
      }
      .pm-ocf-assist-metrics,
      .pm-ocf-assist-risks,
      .pm-ocf-assist-filters,
      .pm-ocf-assist-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      .pm-ocf-assist-metrics { margin-bottom: 10px; }
      .pm-ocf-assist-riskline {
        flex: 1 1 220px;
        min-width: 0;
        padding: 9px 11px;
        border-radius: 11px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.04);
        color: #d7e0ff;
        font-size: 12px;
      }
      .pm-ocf-assist-riskline.is-ok { border-color: rgba(55, 181, 115, 0.3); color: #9ef0bf; }
      .pm-ocf-assist-riskline.is-warn { border-color: rgba(255, 185, 74, 0.3); color: #ffd48c; }
      .pm-ocf-assist-riskline.is-error { border-color: rgba(255, 93, 109, 0.34); color: #ffb8bf; }
      .pm-ocf-assist-pill {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 7px 10px;
        border-radius: 11px;
        border: 1px solid rgba(255,255,255,0.08);
        background: rgba(255,255,255,0.05);
        color: #edf2ff;
        font-size: 12px;
      }
      .pm-ocf-assist-pill.is-ok { border-color: rgba(55, 181, 115, 0.24); color: #baf3ce; }
      .pm-ocf-assist-pill.is-warn { border-color: rgba(255, 185, 74, 0.24); color: #ffe0a8; }
      .pm-ocf-assist-pill.is-error { border-color: rgba(255, 93, 109, 0.28); color: #ffc6cb; }
      .pm-ocf-assist-pill b {
        font-size: 13px;
        color: #ffffff;
      }
      .pm-ocf-assist-actions {
        margin: 10px 0 8px;
      }
      .pm-ocf-assist-btn {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.06);
        color: #eef2ff;
        border-radius: 11px;
        padding: 8px 11px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .pm-ocf-assist-btn:hover { background: rgba(255,255,255,0.1); }
      .pm-ocf-assist-btn.is-primary {
        border-color: rgba(99, 142, 255, 0.45);
        background: linear-gradient(180deg, rgba(103, 146, 255, 0.32), rgba(66, 100, 198, 0.36));
      }
      .pm-ocf-assist-btn.is-ghost {
        background: transparent;
      }
      .pm-ocf-assist-btn.is-active {
        border-color: rgba(99, 142, 255, 0.45);
        background: rgba(99, 142, 255, 0.18);
      }
      .pm-ocf-hidden {
        display: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  let wrap = _el('pmOcfAssist');
  if (!wrap) {
    wrap = document.createElement('section');
    wrap.id = 'pmOcfAssist';
    wrap.className = 'pm-ocf-assist';
    wrap.innerHTML = `
      <div class="pm-ocf-assist-head">
        <div class="pm-ocf-assist-title">Smart Pull Assist</div>
        <div class="pm-ocf-assist-score" id="pmOcfAssistScore">Idle</div>
      </div>
      <div class="pm-ocf-assist-headline" id="pmOcfAssistHeadline">Load a timeline to begin.</div>
      <div class="pm-ocf-assist-sub" id="pmOcfAssistSub">This panel keeps the next best action, major risks, and recommended pull settings in one place.</div>
      <div class="pm-ocf-assist-metrics" id="pmOcfAssistMetrics"></div>
      <div class="pm-ocf-assist-actions">
        <button class="pm-ocf-assist-btn is-primary" id="pmOcfAssistPrimaryBtn" type="button">Pick OCF Folder</button>
        <button class="pm-ocf-assist-btn" id="pmOcfAssistApplyBtn" type="button">Apply Smart Settings</button>
      </div>
      <div class="pm-ocf-assist-filters" id="pmOcfAssistFilters">
        <button class="pm-ocf-assist-btn is-ghost" data-ocf-filter="all" type="button">All matches</button>
        <button class="pm-ocf-assist-btn is-ghost" data-ocf-filter="review" type="button">Needs review</button>
        <button class="pm-ocf-assist-btn is-ghost" data-ocf-filter="missing" type="button">Missing</button>
      </div>
      <div class="pm-ocf-assist-risks" id="pmOcfAssistRisks"></div>
    `;
    const anchor = _el('pmOcfMatchWrap') || card.lastElementChild;
    card.insertBefore(wrap, anchor || null);
  }

  if (!_assistUiWired) {
    _assistUiWired = true;
    _el('pmOcfAssistPrimaryBtn')?.addEventListener('click', () => {
      const action = _el('pmOcfAssistPrimaryBtn')?.dataset.action || '';
      _runAssistAction(action);
    });
    _el('pmOcfAssistApplyBtn')?.addEventListener('click', () => _applySmartSettings());
    _el('pmOcfAssistFilters')?.addEventListener('click', evt => {
      const btn = evt.target.closest?.('[data-ocf-filter]');
      if (!btn) return;
      _applyMatchFilter(btn.dataset.ocfFilter || 'all');
    });
  }

  return wrap;
}

function _buildSmartInsights() {
  const events = _getEventsNow();
  const totalEvents = events.length;
  const summary = matchSummary(_state.matchResults || []);
  const safe = summary.SAFE || 0;
  const review = summary.REVIEW_NEEDED || 0;
  const weak = summary.NOT_RECOMMENDED || 0;
  const missing = summary.MISSING || 0;
  const linked = _state.matchResults.filter(r => !!r?.match?.matchedPath).length;
  const manualLinks = _state.matchResults.filter(r => !!r?.match?._manualLink).length;
  const unmatchedOcf = findUnmatchedOcf(_state.matchResults || [], _state.ocfFiles || []).length;
  const handles = parseInt(_el('pmOcfHandles')?.value || '16', 10) || 16;
  const durations = (_state.matchResults || []).map(r => _estimateEventFrames(r?.event, Number(r?.event?.fps || 24))).filter(Boolean);
  const shortShots = (_state.matchResults || []).filter(r => _estimateEventFrames(r?.event, Number(r?.event?.fps || 24)) <= Math.max(24, handles * 2)).length;
  const retimes = (_state.matchResults || []).filter(r => {
    const sp = Number(r?.event?.speedPercent || r?.event?.speed || 100);
    return Number.isFinite(sp) && Math.abs(sp - 100) > 0.5;
  }).length;
  const readyJobs = _state.jobs.length;
  const qc = qcSummary(_state.qcResults || []);
  const outputPath = (_el('pmOcfOutputPath')?.value || _state.outputBasePath || '').trim();
  const suggestedOutputPath = outputPath || _suggestOutputPath();
  const shortRatio = linked ? (shortShots / linked) : 0;
  const avgFrames = Math.round(_mean(durations));

  let recommendedHandles = handles;
  let smartSettingNote = `Keep ${handles}f handles`;
  if (retimes > 0) {
    recommendedHandles = Math.max(handles, 16);
    smartSettingNote = `Keep ${recommendedHandles}f handles for retimed shots`;
  } else if (shortRatio >= 0.4 && handles > 12) {
    recommendedHandles = 12;
    smartSettingNote = `Suggest 12f handles because ${shortShots} shot(s) are short`;
  } else if (!outputPath) {
    smartSettingNote = 'Set the output path before export';
  }

  const linkagePct = totalEvents ? _percent(linked, totalEvents) : 0;
  const prepPctBase = [
    totalEvents > 0,
    !!_state.folderPath,
    _state.ocfFiles.length > 0,
    _state.matchResults.length > 0,
    readyJobs > 0,
    (qc.total || 0) > 0,
  ].filter(Boolean).length;
  let readiness = Math.round((prepPctBase / 6) * 100);
  if (missing > 0) readiness = Math.max(15, readiness - 20);
  else if (review + weak > 0) readiness = Math.max(25, readiness - 10);
  readiness = Math.max(0, Math.min(100, readiness));

  let headline = 'Load a timeline to begin pull prep.';
  let subline = 'Once the timeline and OCF folder are loaded, Smart Pull Assist will guide the next step.';
  let status = 'idle';
  let primaryAction = 'pick_folder';
  let primaryLabel = 'Pick OCF Folder';

  if (!totalEvents) {
    primaryAction = '';
    primaryLabel = 'Load timeline first';
  } else if (!_state.folderPath) {
    headline = `Timeline loaded. Pick the OCF folder for ${totalEvents} event${totalEvents === 1 ? '' : 's'}.`;
    subline = 'The folder index unlocks matching, preview, relink, and pull planning.';
    status = 'warn';
  } else if (!_state.ocfFiles.length) {
    headline = 'OCF folder selected. Analyze it to build the source index.';
    subline = 'This scans camera originals, reads source metadata, and prepares Smart Match.';
    primaryAction = 'analyze';
    primaryLabel = 'Analyze OCF';
    status = 'warn';
  } else if (!_state.matchResults.length) {
    headline = `${_state.ocfFiles.length} OCF file${_state.ocfFiles.length === 1 ? '' : 's'} indexed. Match them to the timeline.`;
    subline = 'Smart Match uses reel, clip name, timecode, ALE, and folder context to link the strongest source.';
    primaryAction = 'match';
    primaryLabel = 'Run Match';
    status = 'warn';
  } else if (missing > 0) {
    headline = `${missing} shot${missing === 1 ? '' : 's'} still have no OCF match.`;
    subline = `Linked ${linked}/${totalEvents} events so far. Focus the missing rows and manual-link the holdouts before prep.`;
    primaryAction = 'focus_missing';
    primaryLabel = 'Focus Missing';
    status = 'error';
  } else if (review + weak > 0) {
    headline = `${review + weak} shot${review + weak === 1 ? '' : 's'} need review before export.`;
    subline = `${safe} clean link${safe === 1 ? '' : 's'} are ready. Review rows usually need a compare pass, TC sanity check, or manual override.`;
    primaryAction = 'focus_review';
    primaryLabel = 'Focus Review';
    status = 'warn';
  } else if (!readyJobs) {
    headline = `${safe} shot${safe === 1 ? '' : 's'} linked cleanly and ready for prep.`;
    subline = `Recommended next step: prepare the pull jobs${outputPath ? '' : ` and write them to ${suggestedOutputPath}`}.`;
    primaryAction = 'prepare';
    primaryLabel = 'Prepare Pull';
    status = 'ok';
  } else if (!(qc.total > 0)) {
    headline = `${readyJobs} pull job${readyJobs === 1 ? '' : 's'} ready to export.`;
    subline = `Average source duration is about ${avgFrames || 0} frame${avgFrames === 1 ? '' : 's'} before handles. Export when you are happy with the prep.`;
    primaryAction = 'export';
    primaryLabel = 'Start Export';
    status = 'ok';
  } else if (qc.failed > 0) {
    headline = `${qc.failed} QC failure${qc.failed === 1 ? '' : 's'} need attention.`;
    subline = `QC finished with ${qc.warned} warning${qc.warned === 1 ? '' : 's'} and ${qc.failed} failure${qc.failed === 1 ? '' : 's'}. Review the issue list before packaging.`;
    primaryAction = 'show_all';
    primaryLabel = 'Review Results';
    status = 'error';
  } else if (qc.warned > 0) {
    headline = `Export finished with ${qc.warned} warning${qc.warned === 1 ? '' : 's'}.`;
    subline = 'Nothing is blocked, but it is worth checking the QC notes before handing the package off.';
    primaryAction = 'show_all';
    primaryLabel = 'Review Results';
    status = 'warn';
  } else {
    headline = 'Export and QC look clean.';
    subline = `Package is ready${_state.outputBasePath ? ` in ${_folderLabel(_state.outputBasePath)}` : ''}.`;
    primaryAction = 'open_output';
    primaryLabel = 'Open Output';
    status = 'ok';
  }

  const metrics = [
    { label: 'Linked', value: `${linked}/${totalEvents || 0}`, tone: linked === totalEvents && totalEvents ? 'ok' : (linked ? 'warn' : '') },
    { label: 'Clean', value: `${safe}`, tone: safe ? 'ok' : '' },
    { label: 'Review', value: `${review + weak}`, tone: (review + weak) ? 'warn' : 'ok' },
    { label: 'Missing', value: `${missing}`, tone: missing ? 'error' : 'ok' },
    { label: 'Retimes', value: `${retimes}`, tone: retimes ? 'warn' : '' },
    { label: 'Output', value: outputPath ? _folderLabel(outputPath) : 'Auto path', tone: outputPath ? 'ok' : 'warn' },
  ];

  const risks = [];
  if (!totalEvents) {
    risks.push({ tone: 'warn', text: 'Load a timeline first. Smart matching only runs against current timeline events.' });
  }
  if (missing > 0) {
    risks.push({ tone: 'error', text: `${missing} event${missing === 1 ? '' : 's'} have no OCF match. Use Missing filter and + Link to fix them fast.` });
  }
  if (review + weak > 0) {
    risks.push({ tone: 'warn', text: `${review + weak} event${review + weak === 1 ? '' : 's'} are not fully trusted yet. Review TC alignment or compare with proxy before export.` });
  }
  if (shortShots > 0) {
    risks.push({ tone: shortRatio >= 0.4 ? 'warn' : 'ok', text: `${shortShots} shot${shortShots === 1 ? '' : 's'} are short relative to current handles. ${smartSettingNote}.` });
  }
  if (retimes > 0) {
    risks.push({ tone: 'warn', text: `${retimes} shot${retimes === 1 ? '' : 's'} have speed changes. Keep retime mode explicit before export.` });
  }
  if (manualLinks > 0) {
    risks.push({ tone: 'warn', text: `${manualLinks} manual override${manualLinks === 1 ? '' : 's'} are in the pull. They are safe to continue, but worth double-checking once.` });
  }
  if (unmatchedOcf > 0) {
    risks.push({ tone: 'ok', text: `${unmatchedOcf} extra OCF file${unmatchedOcf === 1 ? '' : 's'} are indexed but unused. This is normal when the folder contains more than the cut.` });
  }
  if (!risks.length) {
    risks.push({ tone: 'ok', text: 'No obvious blockers right now. Match quality, prep state, and QC all look healthy.' });
  }

  return {
    totalEvents,
    linked,
    readiness,
    linkagePct,
    headline,
    subline,
    status,
    primaryAction,
    primaryLabel,
    recommendedHandles,
    smartSettingNote,
    suggestedOutputPath,
    metrics,
    risks,
  };
}

function _renderSmartAssist() {
  const wrap = _ensureSmartAssistUi();
  if (!wrap) return;

  const info = _buildSmartInsights();
  const score = _el('pmOcfAssistScore');
  const head = _el('pmOcfAssistHeadline');
  const sub = _el('pmOcfAssistSub');
  const metrics = _el('pmOcfAssistMetrics');
  const risks = _el('pmOcfAssistRisks');
  const primaryBtn = _el('pmOcfAssistPrimaryBtn');
  const applyBtn = _el('pmOcfAssistApplyBtn');

  if (score) {
    score.textContent = info.totalEvents ? `${info.readiness}% ready` : 'Idle';
    score.className = `pm-ocf-assist-score${info.status === 'ok' ? ' is-ok' : info.status === 'warn' ? ' is-warn' : info.status === 'error' ? ' is-error' : ''}`;
  }
  if (head) head.textContent = info.headline;
  if (sub) sub.textContent = info.subline;

  if (metrics) {
    metrics.innerHTML = info.metrics.map(metric => `
      <span class="pm-ocf-assist-pill${metric.tone ? ` is-${metric.tone}` : ''}">
        <b>${metric.value}</b> ${metric.label}
      </span>`).join('');
  }

  if (risks) {
    risks.innerHTML = info.risks.map(item => `
      <div class="pm-ocf-assist-riskline${item.tone ? ` is-${item.tone}` : ''}">${item.text}</div>`).join('');
  }

  if (primaryBtn) {
    primaryBtn.textContent = info.primaryLabel;
    primaryBtn.dataset.action = info.primaryAction || '';
    primaryBtn.disabled = !info.primaryAction;
  }

  if (applyBtn) {
    const currentHandles = parseInt(_el('pmOcfHandles')?.value || '16', 10) || 16;
    const outputPath = (_el('pmOcfOutputPath')?.value || _state.outputBasePath || '').trim();
    const willChange = currentHandles !== info.recommendedHandles || (!outputPath && !!info.suggestedOutputPath);
    applyBtn.disabled = !willChange;
    applyBtn.textContent = willChange
      ? `Apply Smart Settings${currentHandles !== info.recommendedHandles ? ` (${info.recommendedHandles}f)` : ''}`
      : 'Smart Settings Applied';
    applyBtn.title = info.smartSettingNote;
  }

  for (const btn of wrap.querySelectorAll('[data-ocf-filter]')) {
    btn.classList.toggle('is-active', btn.dataset.ocfFilter === _matchFilter);
  }
}

function _applyMatchFilter(filter = 'all') {
  _matchFilter = filter || 'all';
  const list = _el('pmOcfMatchList');
  if (!list) {
    _renderSmartAssist();
    return;
  }

  for (const row of list.children) {
    const kind = row.dataset.matchKind || 'all';
    let show = true;
    if (_matchFilter === 'review') show = kind === 'review' || kind === 'bad';
    else if (_matchFilter === 'missing') show = kind === 'miss';
    row.classList.toggle('pm-ocf-hidden', !show);
  }

  _renderSmartAssist();
}

function _applySmartSettings() {
  const info = _buildSmartInsights();
  const changes = [];

  const handleEl = _el('pmOcfHandles');
  if (handleEl) {
    const currentHandles = parseInt(handleEl.value || '16', 10) || 16;
    if (info.recommendedHandles !== currentHandles) {
      handleEl.value = String(info.recommendedHandles);
      changes.push(`handles ${currentHandles}f → ${info.recommendedHandles}f`);
    }
  }

  const outEl = _el('pmOcfOutputPath');
  if (outEl && !outEl.value.trim() && info.suggestedOutputPath) {
    outEl.value = info.suggestedOutputPath;
    _state.outputBasePath = info.suggestedOutputPath;
    changes.push(`output → ${_folderLabel(info.suggestedOutputPath)}`);
  }

  if (!changes.length) {
    _log('Smart settings already applied');
    _renderSmartAssist();
    return;
  }

  _persistState();
  _renderSmartAssist();
  _log(`Smart settings applied: ${changes.join(' · ')}`);
  try { window._pmSlyToast?.(`Smart settings applied: ${changes.join(' · ')}`); } catch {}
}

function _runAssistAction(action) {
  if (!action) return;
  if (action === 'pick_folder') _el('pmOcfLoadFolderBtn')?.click();
  else if (action === 'analyze') _el('pmOcfAnalyzeBtn')?.click();
  else if (action === 'match') _el('pmOcfMatchBtn')?.click();
  else if (action === 'prepare') _el('pmOcfPrepBtn')?.click();
  else if (action === 'export') _el('pmOcfExportBtn')?.click();
  else if (action === 'open_output') _el('pmOcfOpenOutBtn')?.click();
  else if (action === 'focus_missing') _applyMatchFilter('missing');
  else if (action === 'focus_review') _applyMatchFilter('review');
  else if (action === 'show_all') _applyMatchFilter('all');
}

async function _probeOcfFolderWithRetry(folderPath, { attempts = 3, delayMs = 1200 } = {}) {
  const resolvedPath = _normaliseFolderPath(folderPath);
  if (!resolvedPath) return [];
  if (resolvedPath !== folderPath) {
    _state.folderPath = resolvedPath;
    _persistState();
  }
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const probe = _state._mockMode
        ? await _mockNativeProbeFolder(resolvedPath)
        : await nativeProbeOcfFolder(resolvedPath);
      const files = Array.isArray(probe) ? probe : (Array.isArray(probe?.data) ? probe.data : (probe?.files || []));
      if (files.length) return files;
    } catch (err) {
      lastErr = err;
    }
    if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  if (lastErr) throw lastErr;
  return [];
}

function _matchCls(status) {
  if (status === MATCH_STATUS.SAFE) return 'safe';
  if (status === MATCH_STATUS.REVIEW_NEEDED) return 'review';
  if (status === MATCH_STATUS.NOT_RECOMMENDED) return 'bad';
  return 'miss';
}
function _matchLabel(status) {
  if (status === MATCH_STATUS.SAFE) return 'Safe';
  if (status === MATCH_STATUS.REVIEW_NEEDED) return 'Review';
  if (status === MATCH_STATUS.NOT_RECOMMENDED) return 'Weak';
  return 'Missing';
}

function _updateMatchList(results) {
  const list   = _el('pmOcfMatchList');
  const counts = _el('pmOcfMatchCounts');
  if (!list) return;

  const summary = matchSummary(results);
  if (counts) {
    const parts = [];
    if (summary.SAFE)            parts.push(`<span class="pm-ocf-cnt-safe">${summary.SAFE} ✓ Safe</span>`);
    if (summary.REVIEW_NEEDED)   parts.push(`<span class="pm-ocf-cnt-review">${summary.REVIEW_NEEDED} △ Review</span>`);
    if (summary.NOT_RECOMMENDED) parts.push(`<span class="pm-ocf-cnt-bad">${summary.NOT_RECOMMENDED} Weak</span>`);
    if (summary.MISSING)         parts.push(`<span class="pm-ocf-cnt-miss">${summary.MISSING} ✗ Missing</span>`);
    // Unmatched OCF count
    const unmatched = findUnmatchedOcf(results, _state.ocfFiles);
    if (unmatched.length) parts.push(`<span class="pm-ocf-cnt-extra" title="${unmatched.map(f => f.name || f.path?.split('/').pop()).join('\n')}">${unmatched.length} extra OCF</span>`);
    counts.innerHTML = parts.join(' · ');
  }

  list.innerHTML = '';
  if (!results.length) {
    const empty = document.createElement('div');
    empty.className = 'pm-ocf-match-empty';
    empty.textContent = 'No matches found.';
    list.appendChild(empty);
  }
  for (const r of results) {
    const m = r.match || {};
    const status = m.status || MATCH_STATUS.MISSING;
    const cls    = _matchCls(status);
    const label  = _matchLabel(status);
    const eventName = r.event?.reel || r.event?.clipName || r.event?.name || `Event ${r.event?.eventNumber || '?'}`;
    const conf   = m.confidence ?? 0;
    const cutFlag = r.event?._cutDiffFlag;
    const cutCls  = cutFlag === 'NEW_SOURCE' ? 'pm-ocf-cut-new'
                  : cutFlag === 'TRIM_CHANGE' ? 'pm-ocf-cut-trim'
                  : cutFlag === 'SPEED_CHANGE' ? 'pm-ocf-cut-speed' : '';

    // Speed change / retime badge
    const hasRetime = r.event?.speedPercent && Math.abs(r.event.speedPercent - 100) > 0.5;
    const retimeBadge = hasRetime
      ? `<span class="pm-ocf-cut-badge pm-ocf-cut-speed" title="Speed: ${r.event.speedPercent}%">⟳${Math.round(r.event.speedPercent)}%</span>`
      : '';

    // Matched filename (short)
    const matchedFile = m.matchedPath ? m.matchedPath.split('/').pop().slice(0, 20) : '';

    // Conflict flag (TC overlap with another event on same OCF)
    const isTcConflict = !!m._tcConflict;
    const conflictBadge = isTcConflict
      ? `<span class="pm-ocf-cut-badge pm-ocf-cut-speed" title="TC conflict: overlapping source range">TC!</span>` : '';

    // Top match reason for inline display (most informative reason, ≤22 chars)
    const topReason = (() => {
      const r0 = (m.reasons || [])[0] || '';
      if (!r0) return '';
      // Prefer short reasons; if the first is long, abbreviate
      if (r0.length <= 24) return r0;
      if (r0.includes('Camera name exact')) return 'Camera name ✓';
      if (r0.includes('Reel exact + TC'))   return 'Reel+TC exact ✓';
      if (r0.includes('Reel exact'))        return 'Reel exact';
      if (r0.includes('srcIn within'))      return 'TC in roll range';
      if (r0.includes('Subfolder'))         return r0.replace('Subfolder ', '').slice(0, 22);
      if (r0.includes('ALE'))              return 'ALE match';
      return r0.slice(0, 22);
    })();

    const row = document.createElement('div');
    row.className = `pm-ocf-match-row is-${cls}${isTcConflict ? ' is-dup' : ''}`;
    row.dataset.matchKind = cls;
    row.title = (m.reasons || []).join('; ')
              + (m.warnings?.length ? '\n⚠ ' + m.warnings.join('; ') : '')
              + (cutFlag ? `\n↕ ${r.event?._cutDiffNote || cutFlag}` : '')
              + (matchedFile ? `\n→ ${m.matchedPath}` : '');
    const hasPreview = !!(m.matchedPath && status !== MATCH_STATUS.MISSING);
    const needsReview = status === MATCH_STATUS.REVIEW_NEEDED;
    const isMissing   = status === MATCH_STATUS.MISSING;

    row.innerHTML = `
      <div class="pm-ocf-match-main">
        <span class="pm-ocf-match-name">${_esc(eventName)}${cutFlag ? `<span class="pm-ocf-cut-badge ${cutCls}" title="${_esc(r.event?._cutDiffNote || cutFlag)}">↕</span>` : ''}${retimeBadge}${conflictBadge}</span>
        <span class="pm-ocf-match-conf is-${cls}">${conf}%</span>
        <span class="pm-ocf-match-status is-${cls}">${label}</span>
        ${hasPreview ? `<button class="pm-ocf-preview-btn" title="Preview OCF at srcIn frame">▶</button>` : ''}
        ${needsReview ? `<button class="pm-ocf-cmp-btn-inline" title="Compare with reference proxy">⇄</button>` : ''}
        <button class="pm-ocf-relink-btn" title="${isMissing ? 'Pick OCF file manually' : 'Override OCF match'}">${isMissing ? '+ Link' : '…'}</button>
      </div>`;

    // Matched file + inline top reason
    if (matchedFile && status !== MATCH_STATUS.MISSING) {
      const fileRow = document.createElement('div');
      fileRow.className = 'pm-ocf-match-file';
      fileRow.innerHTML = `→ ${_esc(matchedFile)}${topReason ? ` <span class="pm-ocf-reason">${_esc(topReason)}</span>` : ''}`;
      row.appendChild(fileRow);
    } else if (isMissing) {
      const missRow = document.createElement('div');
      missRow.className = 'pm-ocf-match-file pm-ocf-miss-hint';
      missRow.textContent = 'No OCF matched — use + Link to pick manually';
      row.appendChild(missRow);
    }

    // Preview at srcIn frame
    if (hasPreview) {
      row.querySelector('.pm-ocf-preview-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        _showOcfPreview(m.matchedPath, eventName, r.event?.srcIn, r.event?.fps);
      });
    }

    // Inline compare button for REVIEW_NEEDED
    if (needsReview) {
      row.querySelector('.pm-ocf-cmp-btn-inline')?.addEventListener('click', e => {
        e.stopPropagation();
        try {
          const evIdx = (window._pmEvents || []).findIndex(ev =>
            ev && (ev.reel === r.event?.reel || ev.recIn === r.event?.recIn)
          );
          if (evIdx >= 0) window._pmToggleOcfCmp?.(evIdx);
        } catch {}
      });
    }

    // Manual override / re-link button
    row.querySelector('.pm-ocf-relink-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      _manualRelinkRow(r);
    });

    list.appendChild(row);
  }

  const wrap = _el('pmOcfMatchWrap');
  if (wrap) wrap.style.display = 'block';
  _applyMatchFilter(_matchFilter);
}

// ── OCF frame preview ─────────────────────────────────────────────────────────
// Shows a single decoded frame from the matched OCF file in a floating overlay.
// Uses mediaRuntime (openMedia + getPreviewFrame) — requires companion running.
let _previewSession = null;

function _ocfMetaForPath(path) {
  if (!path) return null;
  return (_state.ocfFiles || []).find(f => f && (f.path === path || f.name === path)) || null;
}

function _ocfTcIn(meta) {
  return String(meta?.tcIn || meta?.timecodeStart || meta?.startTimecode || '00:00:00:00');
}

function _ocfFrameFromSrcIn(srcInTc, fps, meta, totalFrames = 0) {
  const _tcToF = (tc, rate) => {
    const p = String(tc).replace(/[;,]/g, ':').split(':');
    if (p.length < 4) return NaN;
    return ((+p[0] * 3600 + +p[1] * 60 + +p[2]) * Math.round(rate || 24)) + +p[3];
  };

  const srcF = _tcToF(srcInTc, fps || 24);
  const tcInF = _tcToF(_ocfTcIn(meta), fps || 24);
  let frame = Number.isFinite(srcF) && Number.isFinite(tcInF)
    ? (srcF - tcInF)
    : (Number.isFinite(totalFrames) && totalFrames > 0 ? Math.floor(totalFrames / 2) : 0);

  if (Number.isFinite(totalFrames) && totalFrames > 0) {
    frame = Math.max(0, Math.min(totalFrames - 1, frame));
  }
  return Math.max(0, Math.floor(frame));
}

async function _showOcfPreview(ocfPath, eventName, srcInTc, fps) {
  // Create or reuse overlay
  let overlay = document.getElementById('pmOcfPreviewOverlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'pmOcfPreviewOverlay';
    overlay.className = 'pm-ocf-preview-overlay';
    overlay.innerHTML = `
      <div class="pm-ocf-preview-inner">
        <div class="pm-ocf-preview-hdr">
          <span class="pm-ocf-preview-title" id="pmOcfPreviewTitle"></span>
          <button class="pm-ocf-preview-close" id="pmOcfPreviewClose">✕</button>
        </div>
        <div class="pm-ocf-preview-img-wrap">
          <img class="pm-ocf-preview-img" id="pmOcfPreviewImg" src="" alt="OCF frame" />
          <div class="pm-ocf-preview-loading" id="pmOcfPreviewLoading">Decoding frame…</div>
        </div>
        <div class="pm-ocf-preview-meta" id="pmOcfPreviewMeta"></div>
      </div>`;
    document.body.appendChild(overlay);
    document.getElementById('pmOcfPreviewClose')?.addEventListener('click', _closeOcfPreview);
    overlay.addEventListener('click', e => { if (e.target === overlay) _closeOcfPreview(); });
  }

  // Reset state
  const titleEl   = document.getElementById('pmOcfPreviewTitle');
  const imgEl     = document.getElementById('pmOcfPreviewImg');
  const loadingEl = document.getElementById('pmOcfPreviewLoading');
  const metaEl    = document.getElementById('pmOcfPreviewMeta');
  if (titleEl)   titleEl.textContent   = eventName || ocfPath.split('/').pop();
  if (imgEl)     imgEl.src = '';
  if (loadingEl) loadingEl.style.display = 'flex';
  if (metaEl)    metaEl.textContent    = '';
  overlay.style.display = 'flex';

  try {
    // Close previous session to free memory
    if (_previewSession) { try { await closeMedia(_previewSession); } catch {} _previewSession = null; }

    const session = await openMedia(ocfPath, { quality: 'half', reuseSession: true });
    _previewSession = session.sessionId;

    // Use srcIn frame if available — shows the actual edit frame, not mid-roll
    const totalFrames = session.metadata?.totalFrames ?? session.metadata?.frameCount ?? 1;
    const targetFrame = _ocfFrameFromSrcIn(
      srcInTc,
      fps || 24,
      _ocfMetaForPath(ocfPath) || session.metadata || {},
      totalFrames,
    );

    const result = await getPreviewFrame(session.sessionId, targetFrame, {
      width: 1280, height: 720, quality: 'half', format: 'jpg',
    });

    if (result?.dataUrl) {
      if (imgEl)     { imgEl.src = result.dataUrl; imgEl.style.display = 'block'; }
      if (loadingEl) loadingEl.style.display = 'none';
      // Show metadata
      const md = session.metadata || {};
      const parts = [];
      if (md.width && md.height) parts.push(`${md.width}×${md.height}`);
      if (md.frameRate)          parts.push(`${md.frameRate} fps`);
      if (md.codec || md.format) parts.push(md.codec || md.format);
      if (md.colorSpace)         parts.push(md.colorSpace);
      if (md.camera) parts.push(md.camera);
      parts.push(srcInTc ? `@ ${srcInTc} (srcIn)` : `frame ${targetFrame} / ${totalFrames}`);
      if (metaEl) metaEl.textContent = parts.join('  ·  ');
    } else {
      if (loadingEl) loadingEl.textContent = 'No frame data returned';
    }
  } catch (err) {
    if (loadingEl) {
      loadingEl.textContent = `Preview failed: ${err?.message || 'companion not running?'}`;
    }
  }
}

async function _closeOcfPreview() {
  const overlay = document.getElementById('pmOcfPreviewOverlay');
  if (overlay) overlay.style.display = 'none';
  if (_previewSession) { try { await closeMedia(_previewSession); } catch {} _previewSession = null; }
}

// ── Manual re-link: let user pick an OCF file for a specific event ────────────
async function _manualRelinkRow(result) {
  let fileHandle, file;
  try {
    // Use File System Access API picker
    [fileHandle] = await window.showOpenFilePicker({
      types: [{ description: 'Camera Originals', accept: {
        'video/*': ['.mxf', '.mov', '.mp4', '.r3d', '.braw', '.ari', '.mkv', '.m4v'],
        'application/octet-stream': ['.r3d', '.braw', '.ari'],
      }}],
      multiple: false,
    });
    file = await fileHandle.getFile();
  } catch {
    return; // user cancelled
  }

  const path = fileHandle?.name || file.name;
  const eventReel = result.event?.reel || result.event?.clipName || '';
  const eventIdx  = (_state.matchResults || []).indexOf(result);

  // Inject a high-confidence manual override into matchResults
  if (eventIdx >= 0) {
    _state.matchResults[eventIdx] = {
      ...result,
      match: {
        status:      MATCH_STATUS.SAFE,
        confidence:  100,
        matchedPath: path,
        reasons:     ['Manual override by user'],
        warnings:    [],
        _manualLink: true,
      },
      ocf: { name: file.name, path, _fileHandle: fileHandle, _file: file },
    };

    // Store in OCF link map so compare view can use it
    try {
      const evIdx = (window._pmEvents || []).findIndex(ev =>
        ev && (ev.reel === result.event?.reel || ev.recIn === result.event?.recIn)
      );
      const linkedMks = (window._pmClipMarkers || []).filter(mk =>
        (window._pmLinkMap?.get(mk.id) ?? mk._eventIdx ?? -1) === evIdx
      );
      for (const mk of linkedMks) {
        window._pmOcfLinkMap?.set(mk.id, { file, name: file.name });
        mk._ocfLinked = file.name;
        mk.ocfPath    = path;  // required by _pmResolveVfxOcfState for 'linked' status
      }
    } catch (err) { console.debug('[OCF] manual link marker sync skipped:', err?.message || err); }

    _updateMatchList(_state.matchResults);
    _persistState();
    _renderSmartAssist();
    try { window._pmSlyToast?.(`✓ Manual link: ${file.name} → ${eventReel}`); } catch {}
  }
}

// ── Completion toast ──────────────────────────────────────────────────────────
function _showCompletionToast(summary, status) {
  try { window._pmSlyToast?.(`OCF Pull ${status} — ${summary.passed} passed · ${summary.warned} warnings · ${summary.failed} failed`); } catch {}
  // Also try PostFlowX global toast
  try {
    if (typeof window.PFX_GUARD?.toast === 'function') {
      const msg = `EXR Pull: ${status} — ✓${summary.passed} △${summary.warned} ✗${summary.failed}`;
      const type = summary.failed > 0 ? 'error' : summary.warned > 0 ? 'warn' : 'info';
      window.PFX_GUARD.toast(msg, type);
    }
  } catch {}
}

// ── QC Details card ───────────────────────────────────────────────────────────
function _renderQcDetailsCard(qcResults) {
  const card = _el('pmOcfQcDetailsCard');
  const list = _el('pmOcfQcDetailList');
  const badge = _el('pmOcfQcDetailsBadge');
  if (!card || !list) return;

  card.style.display = 'block';
  list.innerHTML = '';

  const { passed, warned, failed, total } = qcSummary(qcResults);
  if (badge) {
    badge.textContent = failed ? `${failed} Failed` : warned ? `${warned} Warning` : 'All Passed';
    badge.className = 'pm-ocf-status-badge ' + (failed ? 'is-error' : warned ? 'is-warn' : 'is-ok');
  }

  for (const r of qcResults) {
    const hasIssues = r.issues?.some(i => i.severity !== 'INFO');
    const block = document.createElement('details');
    block.className = `pm-ocf-qc-block ${r.qcStatus === 'QC_PASSED' ? 'is-ok' : r.qcStatus === 'QC_WARNING' ? 'is-warn' : 'is-err'}`;
    block.open = hasIssues; // auto-expand warnings/errors
    const icon = r.qcStatus === 'QC_PASSED' ? '✓' : r.qcStatus === 'QC_WARNING' ? '△' : '✗';
    block.innerHTML = `<summary class="pm-ocf-qc-block-sum">${icon} ${r.plateName || r.shotId || '?'} <span class="pm-ocf-qc-frames">${r.framesExported ?? 0}f</span></summary>`;
    const issueList = document.createElement('div');
    issueList.className = 'pm-ocf-qc-issue-list';
    for (const iss of (r.issues || [])) {
      const line = document.createElement('div');
      line.className = `pm-ocf-qc-issue-line is-${iss.severity.toLowerCase()}`;
      line.textContent = `${iss.severity === 'ERROR' ? '✗' : iss.severity === 'WARNING' ? '△' : '•'} ${iss.message}${iss.detail ? ` — ${iss.detail}` : ''}`;
      issueList.appendChild(line);
    }
    block.appendChild(issueList);
    list.appendChild(block);
  }
}

// Job status view — shown during/after export instead of match list
function _renderJobStatusList(jobs) {
  const list = _el('pmOcfMatchList');
  if (!list) return;
  list.innerHTML = '';

  const STATUS_CLS = {
    'Waiting': 'wait', 'Ready': 'wait', 'Matching': 'wait',
    'Exporting': 'busy', 'QC Running': 'busy',
    'QC Passed': 'safe', 'QC Warning': 'review',
    'QC Failed': 'bad', 'Failed': 'bad', 'Cancelled': 'bad',
    'Missing OCF': 'miss', 'Review Needed': 'review', 'Paused': 'wait',
  };
  const ICONS = {
    'Exporting': '⟳', 'QC Running': '⟳', 'QC Passed': '✓',
    'QC Warning': '△', 'QC Failed': '✗', 'Failed': '✗',
    'Missing OCF': '?', 'Cancelled': '—', 'Paused': '‖',
    'Ready': '·', 'Waiting': '·',
  };

  for (const j of jobs) {
    const st  = j.status || 'Waiting';
    const cls = STATUS_CLS[st] || 'wait';
    const ic  = ICONS[st] || '·';
    const name = j.job?.plateName || j.id || '?';
    const pct  = j.progress ?? 0;
    const qcIssues = j.qc?.issues?.filter(i => i.severity !== 'INFO') || [];

    const row = document.createElement('div');
    row.className = `pm-ocf-match-row is-${cls}`;
    row.dataset.matchKind = cls;
    row.title = qcIssues.map(i => `[${i.severity}] ${i.message}`).join('\n') || st;
    row.innerHTML = `
      <span class="pm-ocf-match-name">${name}</span>
      ${st === 'Exporting' ? `<span class="pm-ocf-match-conf is-${cls}">${pct}%</span>` : `<span class="pm-ocf-match-conf is-${cls}">${ic}</span>`}
      <span class="pm-ocf-match-status is-${cls}">${st}</span>`;
    if (qcIssues.length) {
      const detail = document.createElement('div');
      detail.className = 'pm-ocf-job-issues';
      detail.textContent = qcIssues.slice(0, 2).map(i => `${i.severity === 'ERROR' ? '✗' : '△'} ${i.message}`).join('  ');
      row.appendChild(detail);
    }
    list.appendChild(row);
  }
  _applyMatchFilter('all');
}

function _updateProgress(pct, label) {
  const wrap = _el('pmOcfProgressWrap');
  const fill = _el('pmOcfProgressFill');
  const lbl  = _el('pmOcfProgressLabel');
  if (pct === null || pct === undefined) {
    if (wrap) wrap.style.display = 'none';
    return;
  }
  if (wrap) wrap.style.display = 'block';
  if (fill) fill.style.width = `${pct}%`;
  if (lbl)  lbl.textContent = label || `${pct}%`;
}

function _updateQcRow(summary) {
  const row = _el('pmOcfQcRow');
  if (row) row.style.display = 'flex';
  const p = _el('pmOcfQcPassed'), w = _el('pmOcfQcWarned'), f = _el('pmOcfQcFailed');
  if (p) p.textContent = `${summary.passed} Passed`;
  if (w) w.textContent = `${summary.warned} Warning`;
  if (f) f.textContent = `${summary.failed} Failed`;
  _renderSmartAssist();
}

// ── Settings helpers ──────────────────────────────────────────────────────────

function _readSettings() {
  return {
    outputBasePath: _el('pmOcfOutputPath')?.value.trim() || _state.outputBasePath || '',
    handleFrames:   parseInt(_el('pmOcfHandles')?.value || '16', 10) || 16,
    frameStart:     parseInt(_el('pmOcfFrameStart')?.value || '1001', 10) || 1001,
    resolution:     _el('pmOcfResolution')?.value || 'camera_native',
    exr: {
      bitDepth:    _el('pmOcfBitDepth')?.value || 'half',
      compression: _el('pmOcfCompression')?.value || 'zip',
      channels:    'rgb',
    },
    color: {
      mode: _el('pmOcfColorMode')?.value || 'aces',   // Netflix: ACES 2065-1 default
    },
  };
}

// ── Cut Diff integration ──────────────────────────────────────────────────────
// Call this with the Cut Diff result to flag events that need re-pull.
export function applyCutDiffToPullJobs(cutDiffResult = []) {
  if (!_state.jobs.length) return 0;
  let flagged = 0;
  for (const diff of cutDiffResult) {
    // Find matching job by event number or reel
    const job = _state.jobs.find(j =>
      j.eventNumber === String(diff.eventNumber || '').padStart(3, '0') ||
      j.metadata?.sourceReel === (diff.reel || diff.srcReel)
    );
    if (!job) continue;
    if (diff.type === 'source_change' || diff.type === 'reel_change') {
      job._cutDiffFlag = 'NEW_SOURCE';
      job._cutDiffNote = `Source changed: ${diff.from || ''} → ${diff.to || ''}`;
      flagged++;
    } else if (diff.type === 'trim_change' || diff.type === 'extend') {
      job._cutDiffFlag = 'TRIM_CHANGE';
      job._cutDiffNote = `Duration changed — re-pull may be required`;
      flagged++;
    } else if (diff.type === 'speed_change') {
      job._cutDiffFlag = 'SPEED_CHANGE';
      job._cutDiffNote = `Speed changed — ${diff.from || ''}% → ${diff.to || ''}%`;
      flagged++;
    }
  }
  if (flagged > 0) {
    _setBadge(`${flagged} Re-pull Required`, 'warn');
    _log(`Cut Diff: ${flagged} shot(s) need re-pull`);
  }
  _renderSmartAssist();
  return flagged;
}

// ── Main init ─────────────────────────────────────────────────────────────────

// Silently re-probe the saved OCF folder on app startup.
// Delayed by 2.5 s to let the companion native host finish its startup connection.
// Retries up to 3 times with 3 s back-off if the first probe fails.
async function _autoIndexOnStartup(getEvents) {
  if (!_state.folderPath || _state.ocfFiles?.length) return;

  // Wait for companion to be ready before probing (shorter delay — companion
  // is usually ready within 500 ms of the extension loading)
  await new Promise(res => setTimeout(res, 800));
  if (_state.ocfFiles?.length) return; // another path populated it already

  // Re-apply proxy root only if Media Root is not set (OCF folder = fallback only)
  const _mr = (localStorage.getItem('pfx_media_root_path') || '').trim();
  if (!_mr) nativeSetProxyRoot(_state.folderPath).catch(() => {});

  let files = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      _setBadge('Indexing…', 'busy');
      const probe = _state._mockMode
        ? await _mockNativeProbeFolder(_state.folderPath)
        : await nativeProbeOcfFolder(_state.folderPath);
      files = Array.isArray(probe) ? probe : (Array.isArray(probe?.data) ? probe.data : (probe?.files || []));
      if (files.length) break; // success
    } catch (e) {
      console.debug(`[OCF] startup probe attempt ${attempt + 1} failed:`, e?.message || e);
      if (attempt < 2) await new Promise(res => setTimeout(res, 3000));
    }
  }

  if (!files.length) {
    _setBadge('', '');
    _renderSmartAssist();
    return; // folder unavailable — stay quiet, user can pick again
  }

  _state.ocfFiles = files;
  const countEl = _el('pmOcfFileCount');
  if (countEl) countEl.textContent = files.length;
  const indexRow = _el('pmOcfIndexRow');
  if (indexRow) indexRow.style.display = 'flex';
  _setEnabled('pmOcfMatchBtn', true);
  _log(`Startup: indexed ${files.length} OCF file(s)`);

  // Auto-match against any events already loaded
  const evs = getEvents?.() || [];
  if (evs.length) {
    const aleMap = (() => {
      try { return window.__pmGetAleMap?.() || window._pmAleMap || null; } catch { return null; }
    })();
    const handleFrames = parseInt(_el('pmOcfHandles')?.value || '16', 10) || 16;
    _state.matchResults = matchAllEvents(evs, files, { aleMap, handleFrames, deduplicate: true });
    _updateMatchList(_state.matchResults);
    const s = matchSummary(_state.matchResults);
    _setBadge(`${s.SAFE + s.REVIEW_NEEDED}/${evs.length} linked`, s.MISSING === 0 ? 'ok' : 'warn');
    _log(`Startup auto-match: ${s.SAFE} safe, ${s.REVIEW_NEEDED} review, ${s.MISSING} missing`);
    _setEnabled('pmOcfPrepBtn', _state.matchResults.length > 0);
  } else {
    _setBadge(`${files.length} files`, 'ok');
  }
  try { window.dispatchEvent(new CustomEvent('mps:ocf-state-changed')); } catch {}
  _renderSmartAssist();
}

let _cardWired = false;
export function initOcfPullCard(getEvents, getProjectMeta) {
  const card = _el('pmOcfCard');
  if (!card) return;

  _providers.getEvents = getEvents;
  _providers.getProjectMeta = getProjectMeta;
  if (_cardWired) { _restoreState(); _renderSmartAssist(); return; }
  _cardWired = true;

  // Restore persisted state on init
  _restoreState();
  _ensureSmartAssistUi();
  _renderSmartAssist();

  // Auto-index the saved OCF folder on startup so ocfFiles is populated
  // without the user having to pick the folder again every session.
  if (_state.folderPath && !_state.ocfFiles?.length) {
    _autoIndexOnStartup(getEvents);
  }
  // Auto-suggest output path if empty
  const outInp = _el('pmOcfOutputPath');
  if (outInp && !outInp.value) outInp.placeholder = _suggestOutputPath();
  // Persist settings on any settings field change
  ['pmOcfHandles','pmOcfFrameStart','pmOcfBitDepth','pmOcfCompression','pmOcfColorMode','pmOcfResolution','pmOcfOutputPath'].forEach(id => {
    _el(id)?.addEventListener('change', () => {
      _persistState();
      _renderSmartAssist();
    });
  });

  // ── QC details download ──────────────────────────────────────────────────
  _el('pmOcfQcDownloadBtn')?.addEventListener('click', () => {
    const txt = buildQCTextReport(_state.qcResults);
    const blob = new Blob([txt], { type: 'text/plain' });
    const url  = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = `OCF_QC_${Date.now()}.txt`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });

  // ── Smart Link & Proxy — one-click: Analyze → Match → Prepare → Proxy ──────
  const _smartSetProgress = (pct, label) => {
    const wrap  = _el('pmOcfSmartProgress');
    const fill  = _el('pmOcfSmartFill');
    const lbl   = _el('pmOcfSmartLabel');
    if (wrap)  wrap.style.display  = pct !== null ? '' : 'none';
    if (fill)  fill.style.width    = `${pct ?? 0}%`;
    if (lbl)   lbl.textContent     = label || '';
  };

  const _runSmartLink = async () => {
    const events = getEvents?.() || [];
    let built = 0;
    let skippedNoTool = 0;
    // Allow path override from Smart Import (no native picker needed)
    if (!_state.folderPath && window.__pfxOcfFolderOverride) {
      _setFolderPath(window.__pfxOcfFolderOverride);
      window.__pfxOcfFolderOverride = null;
      _persistState();
    }
    if (!_state.folderPath) {
      // Auto-open the native OCF folder picker the first time the user runs
      // Smart Link without a folder set. Avoids the silent no-op + makes the
      // import path discoverable from the top-right Smart button.
      _setBadge('Pick OCF folder…', 'busy');
      try {
        const pick = await nativePickOcfFolder();
        if (!pick?.path) { _setBadge('Ready', ''); _log('OCF folder pick cancelled'); return; }
        _setFolderPath(pick.path);
        _setEnabled('pmOcfAnalyzeBtn', true);
        _setEnabled('pmOcfSmartBtn', true);
        _persistState();
        _log(`OCF folder selected: ${_state.folderPath}`);
      } catch (e) {
        _setBadge('Error', 'error');
        _log(`OCF folder pick failed: ${e.message || e}`);
        return;
      }
    }
    _setEnabled('pmOcfSmartBtn', false);
    _setBadge('Smart linking…', 'busy');

    try {
      // Step 1: Analyze
      _smartSetProgress(5, 'Scanning OCF folder…');
      _log('Smart Link: Analyzing…');
      let probeResult;
      if (_state._mockMode) {
        probeResult = await _mockNativeProbeFolder(_state.folderPath);
      } else {
        const res = await nativeProbeOcfFolder(_state.folderPath);
        if (res?.error?.code === 'OCF_UNSUPPORTED') {
          _setBadge('Unsupported', 'error');
          _smartSetProgress(null);
          _setEnabled('pmOcfSmartBtn', true);
          return;
        }
        probeResult = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : (res?.files || []));
      }
      _state.ocfFiles = probeResult;
      const countEl = _el('pmOcfFileCount');
      if (countEl) countEl.textContent = probeResult.length;
      const typeEl = _el('pmOcfCameraTypes');
      if (typeEl) {
        const types = [...new Set(probeResult.map(f => f.camera || f.format || ''))].filter(Boolean);
        typeEl.textContent = types.join(', ') || 'Unknown format';
      }
      const indexRow = _el('pmOcfIndexRow');
      if (indexRow) indexRow.style.display = 'flex';
      _log(`Found ${probeResult.length} OCF file(s)`);
      _setEnabled('pmOcfAnalyzeBtn', true);
      _setEnabled('pmOcfMatchBtn', true);

      // Step 2: Match — pass ALE tape data + handle size for smarter conforming
      _smartSetProgress(30, `Matching ${events.length} events → ${probeResult.length} files…`);
      _log('Smart Link: Matching…');
      if (!events.length) throw new Error('No timeline events — load a timeline first');

      // Build ALE map from prep_mark's _pmAleMap if available
      const aleMap = (() => {
        try { return window.__pmGetAleMap?.() || window._pmAleMap || null; } catch { return null; }
      })();
      const handleFrames = parseInt(_el('pmOcfHandles')?.value || '16', 10) || 16;
      const matchOpts = { aleMap, handleFrames, deduplicate: true };

      _state.matchResults = matchAllEvents(events, _state.ocfFiles, matchOpts);
      _updateMatchList(_state.matchResults);
      const s = matchSummary(_state.matchResults);
      _log(`Matched: ${s.SAFE} safe, ${s.REVIEW_NEEDED} review, ${s.MISSING} missing`);
      _setEnabled('pmOcfPrepBtn', true);

      // Step 3: Prepare pull jobs
      _smartSetProgress(55, 'Preparing pull jobs…');
      const meta = getProjectMeta?.() || {};
      const cfg  = _readSettings();
      cfg.outputBasePath = cfg.outputBasePath || meta.outputPath || _suggestOutputPath();
      _state.outputBasePath = cfg.outputBasePath;
      _state.jobs = buildAllExrJobs(_state.matchResults, cfg, meta);
      _setEnabled('pmOcfExportBtn', true);
      _log(`Prepared ${_state.jobs.length} pull job(s)`);

      // Step 4: Auto-build proxies for non-browser-playable files
      const nonPlayable = _state.matchResults.filter(r => {
        const p = r.match?.matchedPath || '';
        const ext = p.toLowerCase().match(/\.[^.]+$/)?.[0] ?? '';
        return p && !['.mp4','.m4v','.webm','.mov','.mkv','.mts','.m2ts'].includes(ext);
      });

      if (nonPlayable.length > 0) {
        _smartSetProgress(60, `Building ${nonPlayable.length} proxy file${nonPlayable.length > 1 ? 's' : ''}…`);
        _log(`Smart Link: Building ${nonPlayable.length} proxy file(s)…`);

        for (const r of nonPlayable) {
          const ocfPath  = r.match.matchedPath;
          const fileName = ocfPath.split('/').pop();
          try {
            const pct = 60 + Math.round((built / nonPlayable.length) * 35);
            _smartSetProgress(pct, `Proxy ${built + 1}/${nonPlayable.length}: ${fileName}…`);

            // Get HTTP token
            const pingData  = await _companionCall({ action: 'ping' }, 8_000);
            const httpPort  = pingData?.port || 47125;
            const httpToken = pingData?.httpToken || '';

            // Open in asset registry
            const openData  = await _companionCall({ action: 'openFile', path: ocfPath });
            const assetId   = openData?.assetId;
            if (!assetId) throw new Error('no assetId');

            // Start proxy build
            const buildData  = await _companionCall({ action: 'buildMediaProxy', assetId });
            const sessionId  = buildData?.sessionId;
            const streamUrl  = buildData?.streamUrl;
            if (!sessionId) throw new Error('no sessionId');

            // Poll until done
            await new Promise((resolve, reject) => {
              const poll = async () => {
                try {
                  const resp = await fetch(`http://127.0.0.1:${httpPort}/progress/${sessionId}`,
                    { headers: { 'X-PFX-Token': httpToken } });
                  if (resp.ok) {
                    const prog = await resp.json();
                    if (prog.error) { reject(new Error(prog.error)); return; }
                    if (prog.done)  { resolve(streamUrl); return; }
                  }
                } catch {}
                setTimeout(poll, 1000);
              };
              poll();
              setTimeout(() => reject(new Error('timeout')), 600_000);
            });

            // Store proxy URL on match result for compare view
            r.match._proxyStreamUrl  = `${streamUrl}?token=${encodeURIComponent(httpToken)}`;
            r.match._proxyHttpToken  = httpToken;
            r.match._proxyHttpPort   = httpPort;
            built++;
            _log(`Proxy built: ${fileName}`);
          } catch (proxyErr) {
            const errCode = proxyErr.message || String(proxyErr);
            const _NO_TOOL = new Set(['ARRIRAW_NO_TOOL', 'RED_NO_TOOL', 'SONY_NO_TOOL', 'BRAW_NO_TOOL']);
            if (_NO_TOOL.has(errCode)) {
              _log(`Proxy skipped (no decoder): ${fileName} — ${errCode}`);
              skippedNoTool++;
            } else {
              _log(`Proxy failed for ${fileName}: ${errCode}`);
            }
          }
        }
        _log(`Smart Link: ${built}/${nonPlayable.length} proxies built${skippedNoTool ? `, ${skippedNoTool} need decoder` : ''}`);
      }

      // Done
      const matchedCount = _state.matchResults.filter(r => r.match?.matchedPath).length;
      const proxyLabel = nonPlayable.length
        ? (skippedNoTool ? `${built} proxies · ${skippedNoTool} need decoder` : `${nonPlayable.length} proxies`)
        : 'no proxies needed';
      _smartSetProgress(100, `✓ ${matchedCount} linked · ${proxyLabel}`);
      _setBadge(`✓ ${matchedCount} linked`, 'ok');
      _log('Smart Link complete');
      _renderSmartAssist();
      setTimeout(() => _smartSetProgress(null), 3000);
    } catch (e) {
      _setBadge('Error', 'error');
      _smartSetProgress(null);
      _log(`Smart Link failed: ${e.message || e}`);
      _renderSmartAssist();
    } finally {
      _setEnabled('pmOcfSmartBtn', true);
    }
  };

  // Companion call helper (shared with proxy overlay in compare view)
  const _companionCall = (payload, timeout = 60_000) => new Promise((resolve, reject) => {
    const tid = setTimeout(() => reject(new Error(`timeout: ${payload.action}`)), timeout);
    chrome.runtime.sendMessage({ type: 'IMF_COMPANION_CALL', payload, timeoutMs: timeout }, res => {
      clearTimeout(tid); void chrome.runtime.lastError;
      if (res?.ok) resolve(res.response?.data ?? res.response ?? {});
      else reject(new Error(res?.error?.message || `${payload.action} failed`));
    });
  });

  _el('pmOcfSmartBtn')?.addEventListener('click', _runSmartLink);

  // ── Load OCF Folder ──────────────────────────────────────────────────────
  _el('pmOcfLoadFolderBtn')?.addEventListener('click', async () => {
    try {
      _setBadge('Loading…', 'busy');
      const res = await nativePickOcfFolder();
      if (!res?.path) { _setBadge('Ready'); return; }
      _setFolderPath(res.path);
      _setEnabled('pmOcfAnalyzeBtn', true);
      _setEnabled('pmOcfSmartBtn', true);
      _log(`Folder selected: ${_state.folderPath}`);
      const outEl = _el('pmOcfOutputPath');
      if (outEl && !outEl.value) outEl.placeholder = _suggestOutputPath();

      // Use OCF folder as proxy root ONLY when no Media Root is configured in Settings.
      // Media Root (Settings tab) always takes priority — it's the canonical proxy location.
      const _savedMediaRoot = (localStorage.getItem('pfx_media_root_path') || '').trim();
      if (!_savedMediaRoot) {
        nativeSetProxyRoot(_state.folderPath).then(r => {
          if (r?.proxyRoot) _log(`Proxy root (OCF fallback): ${r.proxyRoot}`);
        }).catch(() => {});
      }

      // Auto-analyze right after the picker returns. Probing the folder up
      // front populates `_state.ocfFiles` so per-row Relink works instantly
      // without needing the user to click Smart Link first.
      _setBadge('Indexing OCF…', 'busy');
      try {
        let probeResult;
        if (_state._mockMode) {
          probeResult = await _mockNativeProbeFolder(_state.folderPath);
        } else {
          const probe = await nativeProbeOcfFolder(_state.folderPath);
          if (probe?.error?.code === 'OCF_UNSUPPORTED') {
            _setBadge('Unsupported', 'error'); _persistState(); return;
          }
          probeResult = Array.isArray(probe) ? probe : (Array.isArray(probe?.data) ? probe.data : (probe?.files || []));
        }
        _state.ocfFiles = probeResult;
        const countEl = _el('pmOcfFileCount');
        if (countEl) countEl.textContent = probeResult.length;
        const indexRow = _el('pmOcfIndexRow');
        if (indexRow) indexRow.style.display = 'flex';
        _setEnabled('pmOcfMatchBtn', true);
        _log(`Indexed ${probeResult.length} OCF file(s)`);

        // Auto-match right after probe if a timeline is already loaded — this
        // populates `_state.matchResults` so the LINK column shows OCF
        // filenames immediately, with no second click required.
        const evs = getEvents?.() || [];
        if (evs.length && probeResult.length) {
          const aleMap = (() => {
            try { return window.__pmGetAleMap?.() || window._pmAleMap || null; } catch { return null; }
          })();
          const handleFrames = parseInt(_el('pmOcfHandles')?.value || '16', 10) || 16;
          _state.matchResults = matchAllEvents(evs, probeResult, { aleMap, handleFrames, deduplicate: true });
          _updateMatchList(_state.matchResults);
          const s = matchSummary(_state.matchResults);
          _setBadge(`${s.SAFE + s.REVIEW_NEEDED}/${evs.length} matched`, 'ok');
          _log(`Auto-match: ${s.SAFE} safe, ${s.REVIEW_NEEDED} review, ${s.MISSING} missing`);
          _setEnabled('pmOcfPrepBtn', true);
        } else {
          _setBadge(`${probeResult.length} files`, 'ok');
        }
        try { window.dispatchEvent(new CustomEvent('mps:ocf-state-changed')); } catch {}
        _renderSmartAssist();
      } catch (probeErr) {
        _setBadge('Probe failed', 'error');
        _log(`Auto-index failed: ${probeErr.message || probeErr}`);
        _renderSmartAssist();
      }
      _persistState();
    } catch (e) {
      _setBadge('Error', 'error');
      _log(`Load folder failed: ${e.message || e}`);
      _renderSmartAssist();
    }
  });

  // ── Analyze OCF ──────────────────────────────────────────────────────────
  _el('pmOcfAnalyzeBtn')?.addEventListener('click', async () => {
    if (!_state.folderPath) return;
    _setBadge('Analyzing…', 'busy');
    _setEnabled('pmOcfAnalyzeBtn', false);
    _log('Analyzing OCF folder…');
    try {
      let probeResult;
      if (_state._mockMode) {
        probeResult = await _mockNativeProbeFolder(_state.folderPath);
      } else {
        const res = await nativeProbeOcfFolder(_state.folderPath);
        // Handle OCF_UNSUPPORTED — show fallback panel
        if (res?.error?.code === 'OCF_UNSUPPORTED') {
          const fb = _el('pmOcfFallback');
          if (fb) { fb.style.display = 'block'; _el('pmOcfFallbackMsg').textContent = res.error.userMessage || 'Native Helper does not support OCF decode.'; }
          _setEnabled('pmOcfAnalyzeBtn', true); _setBadge('Unsupported', 'error'); return;
        }
        probeResult = Array.isArray(res) ? res : (Array.isArray(res?.data) ? res.data : (res?.files || []));
      }
      _state.ocfFiles = probeResult;
      const countEl = _el('pmOcfFileCount');
      if (countEl) countEl.textContent = _state.ocfFiles.length;
      const typeEl = _el('pmOcfCameraTypes');
      if (typeEl) {
        const types = [...new Set(_state.ocfFiles.map(f => f.camera || f.format || ''))].filter(Boolean);
        typeEl.textContent = types.join(', ') || 'Unknown format';
      }
      const indexRow = _el('pmOcfIndexRow');
      if (indexRow) indexRow.style.display = 'flex';
      _setEnabled('pmOcfAnalyzeBtn', true);
      _setEnabled('pmOcfMatchBtn', true);
      _setBadge(`${_state.ocfFiles.length} files`, '');
      _log(`Found ${_state.ocfFiles.length} OCF file(s)`);
      _renderSmartAssist();
    } catch (e) {
      _setEnabled('pmOcfAnalyzeBtn', true);
      _setBadge('Error', 'error');
      _log(`Analyze failed: ${e.message || e}`);
      // Show fallback panel if native can't decode
      const fb = _el('pmOcfFallback');
      if (fb) { fb.style.display = 'block'; _el('pmOcfFallbackMsg').textContent = `Cannot decode OCF directly: ${e.message || e}\nRecommended options:`; }
      _renderSmartAssist();
    }
  });

  // ── Auto Match ───────────────────────────────────────────────────────────
  _el('pmOcfMatchBtn')?.addEventListener('click', () => {
    const events = getEvents?.() || [];
    if (!events.length) { _log('No timeline events loaded'); return; }
    _setBadge('Matching…', 'busy');
    _log(`Matching ${events.length} events against ${_state.ocfFiles.length} OCF files…`);
    try {
      _state.matchResults = matchAllEvents(events, _state.ocfFiles);
      _updateMatchList(_state.matchResults);
      const s = matchSummary(_state.matchResults);
      const allOk = s.REVIEW_NEEDED === 0 && s.NOT_RECOMMENDED === 0 && s.MISSING === 0;
      _setBadge(allOk ? 'Matched' : `${s.REVIEW_NEEDED + s.MISSING} Need Review`, allOk ? 'ok' : 'warn');
      _setEnabled('pmOcfPrepBtn', true);

      // Show retime warning if any event has speed change
      const hasRetime = events.some(e => e.speedPercent && Math.abs(e.speedPercent - 100) > 0.5);
      const retimeWarn = _el('pmOcfRetimeWarn');
      if (retimeWarn) retimeWarn.style.display = hasRetime ? 'flex' : 'none';
      if (hasRetime) {
        const rtText = _el('pmOcfRetimeText');
        if (rtText) rtText.textContent = `${events.filter(e => e.speedPercent && Math.abs(e.speedPercent - 100) > 0.5).length} shot(s) have speed changes — choose export mode`;
      }
      _log(`Match complete: ${s.SAFE} safe, ${s.REVIEW_NEEDED} review, ${s.MISSING} missing`);
      _renderSmartAssist();
    } catch (e) {
      _setBadge('Error', 'error');
      _log(`Match failed: ${e.message || e}`);
      _renderSmartAssist();
    }
  });

  // ── Browse Output Folder ─────────────────────────────────────────────────
  _el('pmOcfBrowseOutput')?.addEventListener('click', async () => {
    try {
      const { nativePickOcfFolder } = await import('../modules/native_helper_client.js');
      const res = await nativePickOcfFolder();
      if (res?.path) {
        const inp = _el('pmOcfOutputPath');
        if (inp) inp.value = res.path;
        _state.outputBasePath = res.path;
        _log(`Output folder: ${res.path}`);
        _persistState();
        _renderSmartAssist();
      }
    } catch (e) { _log(`Browse failed: ${e.message || e}`); }
  });

  // ── Sources section OCF button ────────────────────────────────────────────
  _el('pmSlySrcOcfBtn')?.addEventListener('click', () => {
    _el('pmOcfLoadFolderBtn')?.click();
  });

  // ── Prepare EXR Pull ─────────────────────────────────────────────────────
  _el('pmOcfPrepBtn')?.addEventListener('click', () => {
    const meta = getProjectMeta?.() || {};
    const cfg  = _readSettings();
    const retimeMode = document.querySelector('input[name="pmOcfRetimeMode"]:checked')?.value || 'source_frames_only';
    cfg.retime = { mode: retimeMode };
    _state.outputBasePath = cfg.outputBasePath || meta.outputPath || _suggestOutputPath();
    cfg.outputBasePath = _state.outputBasePath;
    // Set the output path field if it was empty
    const outEl2 = _el('pmOcfOutputPath');
    if (outEl2 && !outEl2.value) outEl2.value = _state.outputBasePath;
    _state.jobs = buildAllExrJobs(_state.matchResults, cfg, meta);
    _persistState();
    _setEnabled('pmOcfExportBtn', true);
    _setEnabled('pmOcfQcBtn', false);
    _setEnabled('pmOcfPkgBtn', false);
    _setBadge(`${_state.jobs.length} jobs ready`, 'ok');
    _log(`Prepared ${_state.jobs.length} job(s) — handles:${cfg.handleFrames} start:${cfg.frameStart} depth:${cfg.exr.bitDepth}`);
    // Apply any pending Cut Diff flags
    try {
      const diff = window.__PFX_LAST_CUTDIFF;
      if (Array.isArray(diff) && diff.length) applyCutDiffToPullJobs(diff);
    } catch {}
    _renderSmartAssist();
  });

  // ── Export EXR ───────────────────────────────────────────────────────────
  _el('pmOcfExportBtn')?.addEventListener('click', async () => {
    if (!_state.jobs.length) return;
    _setEnabled('pmOcfExportBtn', false);
    _setBadge('Exporting…', 'busy');
    _updateProgress(0, `0 / ${_state.jobs.length} shots`);

    _state.queue = new ExrExportQueue({
      onStatusChange: (jobId, jobs, pct) => {
        const done = jobs.filter(j => ['QC Passed','QC Warning','QC Failed','Failed','Cancelled'].includes(j.status)).length;
        _updateProgress(pct, `${done} / ${jobs.length} shots`);
        _renderJobStatusList(jobs);
      },
      onLog: (jobId, msg) => _log(jobId ? `[${jobId}] ${msg}` : msg),
    });
    _state.queue.setNativeDispatch(
      _state._mockMode
        ? _mockNativeDispatch
        : async (job, onProgress) => nativeExportEXR(job, onProgress)
    );
    _state.queue.addJobs(_state.jobs);

    try {
      await _state.queue.start();
      const jobs = _state.queue.getJobs();
      const pairs = jobs.map(j => ({ job: j.job, result: j.result || {} }));
      _state.qcResults = validateAll(pairs);
      const summary = qcSummary(_state.qcResults);
      _updateQcRow(summary);
      const status = summary.failed > 0 ? 'QC Failed' : summary.warned > 0 ? 'QC Warning' : 'QC Passed';
      const variant = summary.failed > 0 ? 'error' : summary.warned > 0 ? 'warn' : 'ok';
      _setBadge(status, variant);
      _setEnabled('pmOcfQcBtn', true);
      _setEnabled('pmOcfPkgBtn', true);
      _setEnabled('pmOcfOpenOutBtn', !!_state.outputBasePath);
      _log(`Export complete — ${status}`);
      _renderQcDetailsCard(_state.qcResults);
      _persistState();
      // Completion toast
      _showCompletionToast(summary, status);
      _renderSmartAssist();
    } catch (e) {
      _setBadge('Export Failed', 'error');
      _log(`Export error: ${e.message || e}`);
      _setEnabled('pmOcfExportBtn', true);
      _renderSmartAssist();
    }
  });

  // ── QC Export ────────────────────────────────────────────────────────────
  _el('pmOcfQcBtn')?.addEventListener('click', () => {
    const report = buildQCTextReport(_state.qcResults);
    const blob = new Blob([report], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `PFX_QC_Report_${Date.now()}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    _log('QC report downloaded');
  });

  // ── Export Package ───────────────────────────────────────────────────────
  _el('pmOcfPkgBtn')?.addEventListener('click', async () => {
    _setBadge('Packaging…', 'busy');
    try {
      const { buildShotsCSV: bCSV, buildJobsJSON: bJSON, buildQCTextReport: bQC,
              buildResolveHandoffScript: bRes, buildNukeHandoffScript: bNuke,
              buildOcfPullEDL: bEDL } = await import('../smart/smartExrReportExporter.js');
      const ts = new Date().toISOString().slice(0,10);
      const downloads = [
        { name: `OCF_PullList_${ts}.csv`,       content: bCSV(_state.jobs),              type: 'text/csv' },
        { name: `OCF_Jobs_${ts}.json`,           content: bJSON(_state.jobs,_state.qcResults), type: 'application/json' },
        { name: `OCF_QC_${ts}.txt`,              content: bQC(_state.qcResults),          type: 'text/plain' },
        { name: `OCF_Pull_${ts}.edl`,            content: bEDL(_state.jobs),              type: 'text/plain' },
        { name: `OCF_Resolve_${ts}.py`,          content: bRes(_state.jobs),              type: 'text/plain' },
        { name: `OCF_Nuke_${ts}.nk`,             content: bNuke(_state.jobs),             type: 'text/plain' },
      ];
      let delay = 0;
      for (const { name, content, type } of downloads) {
        if (!content?.trim()) continue;
        setTimeout(() => {
          const blob = new Blob([content], { type });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a'); a.href = url; a.download = name; a.click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }, delay);
        delay += 200;
      }
      _setBadge('Package ready', 'ok');
      _log(`Package: ${downloads.length} files exported`);
    } catch(e) { _setBadge('Error', 'error'); _log(`Package failed: ${e.message || e}`); }
  });

  // ── Resolve / Nuke handoff ───────────────────────────────────────────────
  _el('pmOcfResolveBtn')?.addEventListener('click', () => {
    const script = buildResolveHandoffScript(_state.jobs);
    const blob = new Blob([script], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'pfx_resolve_pull.py'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    _log('Resolve handoff script downloaded');
  });
  _el('pmOcfNukeBtn')?.addEventListener('click', () => {
    const script = buildNukeHandoffScript(_state.jobs);
    const blob = new Blob([script], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'pfx_nuke_pull.nk'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    _log('Nuke handoff script downloaded');
  });

  // ── Open Output Folder ───────────────────────────────────────────────────
  _el('pmOcfOpenOutBtn')?.addEventListener('click', async () => {
    if (!_state.outputBasePath) return;
    try { await nativeOpenOutputFolder(_state.outputBasePath); }
    catch (e) { _log(`Cannot open folder: ${e.message || e}`); }
  });

  _log('OCF → EXR Pull ready');
  _renderSmartAssist();
}

// Public: refresh card when project state changes (called from _pmSlyRefresh).
export function refreshOcfPullCard(events = [], projectMeta = {}) {
  const hasEvents = events.length > 0;
  const hasOcf    = _state.ocfFiles.length > 0;
  _setEnabled('pmOcfAnalyzeBtn', !!_state.folderPath);
  _setEnabled('pmOcfMatchBtn',   hasOcf && hasEvents);
  _setEnabled('pmOcfPrepBtn',    _state.matchResults.length > 0);
  _setEnabled('pmOcfExportBtn',  _state.jobs.length > 0);

  // Update Sources section OCF row
  const srcVal = _el('pmSlySrcOcfVal');
  const srcBtn = _el('pmSlySrcOcfBtn');
  if (srcVal) {
    srcVal.textContent = hasOcf
      ? `${_state.ocfFiles.length} files linked`
      : (_state.folderPath ? 'Analyzing…' : 'Not linked');
  }
  if (srcBtn) srcBtn.textContent = hasOcf ? 'Relink' : 'Link';
  _renderSmartAssist();
}

// Public: get current OCF state for external use (Cut Diff, Visual QC, etc.)
export function getOcfPullState() { return { ..._state }; }

// Public: get QC results for Visual QC integration
export function getOcfQcResults() { return _state.qcResults; }

// Identity check robust to re-parsed event objects (EDL uses _edlEvent, AAF uses event int)
function _sameEvent(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  // EDL: include recIn to disambiguate multi-track EDLs with duplicate event numbers
  if (a._edlEvent != null && b._edlEvent != null)
    return String(a._edlEvent) === String(b._edlEvent) && a.recIn === b.recIn;
  // AAF: 1-indexed integer unique per-session
  if (typeof a.event === 'number' && typeof b.event === 'number') return a.event === b.event;
  // Fallback: TC + reel
  return a.recIn === b.recIn && a.srcIn === b.srcIn && (a.reel || a.clipName) === (b.reel || b.clipName);
}

// Public: get match result for a specific event index (used by event table)
export function getOcfMatchForEvent(event) {
  if (!_state.matchResults.length) return null;
  return _state.matchResults.find(r => _sameEvent(r.event, event))?.match || null;
}

// Public: re-run the matcher for a single event against the loaded OCF files.
// Auto-probes the folder if `_state.ocfFiles` hasn't been populated yet.
// Returns { ok, match, reason }.
export async function relinkOcfForEvent(event) {
  if (!event) return { ok: false, reason: 'No event' };
  if (!_state.ocfFiles || !_state.ocfFiles.length) {
    if (!_state.folderPath) return { ok: false, reason: 'No OCF folder set — pick a folder first' };
    try {
      const files = await _probeOcfFolderWithRetry(_state.folderPath);
      if (!files.length) return { ok: false, reason: 'No video files found in OCF folder' };
      _state.ocfFiles = files;
      const countEl = _el('pmOcfFileCount');
      if (countEl) countEl.textContent = files.length;
    } catch (e) {
      return { ok: false, reason: `Probe failed: ${e.message || e}` };
    }
  }
  const aleMap = (() => {
    try { return window.__pmGetAleMap?.() || window._pmAleMap || null; } catch { return null; }
  })();
  const handleFrames = parseInt(_el('pmOcfHandles')?.value || '16', 10) || 16;
  const opts = { aleMap, handleFrames };

  // Pass 1: collect candidates that score above the matcher's matchedPath threshold
  let best = null;
  for (const ocfFile of _state.ocfFiles) {
    const m = matchOcfToEvent(ocfFile, event, opts);
    if (!m) continue;
    if (m.matchedPath && (!best || m.confidence > best.confidence)) {
      best = { ...m };
    }
  }

  // Pass 2: filename-only fallback. The matcher's score threshold (>=40) can
  // reject correct matches when TC metadata is missing or when the event has
  // a heavy retime (speedPercent !== 100). When the OTIO clip name equals an
  // OCF file name, force-link it even if the score was below the threshold.
  if (!best) {
    const evFile = String(event.srcFile || event.clipName || event.name || '').trim().toLowerCase();
    if (evFile) {
      const hit = _state.ocfFiles.find(f => {
        const n = String(f.name || (f.path || '').split('/').pop() || '').trim().toLowerCase();
        return n && n === evFile;
      });
      if (hit) {
        best = {
          status:      MATCH_STATUS.REVIEW_NEEDED,
          confidence:  50,
          matchedPath: hit.path || hit.name,
          reasons:     ['Filename exact (manual relink fallback)'],
          warnings:    ['Force-linked by filename — verify TC alignment'],
        };
      }
    }
  }

  const finalMatch = best || { status: MATCH_STATUS.MISSING, confidence: 0, matchedPath: null,
                               reasons: [], warnings: ['No matching OCF found'] };
  const idx = _state.matchResults.findIndex(r => _sameEvent(r.event, event));
  if (idx >= 0) _state.matchResults[idx] = { event, match: finalMatch };
  else _state.matchResults.push({ event, match: finalMatch });
  _updateMatchList(_state.matchResults);
  _persistState();
  _renderSmartAssist();
  try { window.dispatchEvent(new CustomEvent('mps:ocf-state-changed')); } catch {}
  return { ok: !!finalMatch.matchedPath, match: finalMatch };
}

// Public: re-run the full match for ALL events against loaded OCF files.
// Auto-probes the folder if needed. Used by prep_mark when EDL changes.
// Returns { safe, review, missing, total }.
export async function relinkAllOcfEvents(events, extraOpts = {}) {
  if (!events?.length) return { safe: 0, review: 0, missing: 0, total: 0 };

  // Ensure OCF files are indexed
  if (!_state.ocfFiles?.length) {
    if (!_state.folderPath) return { safe: 0, review: 0, missing: events.length, total: events.length };
    try {
      const files = await _probeOcfFolderWithRetry(_state.folderPath);
      if (!files.length) return { safe: 0, review: 0, missing: events.length, total: events.length };
      _state.ocfFiles = files;
      const countEl = _el('pmOcfFileCount');
      if (countEl) countEl.textContent = files.length;
    } catch (e) {
      // Probe can fail if path is stale/unmounted — log quietly, don't surface to error console.
      console.debug('[OCF] relinkAll probe skipped (path unavailable):', e?.message || e);
      return { safe: 0, review: 0, missing: events.length, total: events.length };
    }
  }

  const aleMap = (() => {
    try { return window.__pmGetAleMap?.() || window._pmAleMap || null; } catch { return null; }
  })();
  const handleFrames = parseInt(_el('pmOcfHandles')?.value || '16', 10) || 16;
  const opts = { aleMap, handleFrames, deduplicate: true, ...extraOpts };

  _state.matchResults = matchAllEvents(events, _state.ocfFiles, opts);
  _updateMatchList(_state.matchResults);
  _persistState();
  _renderSmartAssist();

  const s = matchSummary(_state.matchResults);
  const badge = `${s.SAFE + s.REVIEW_NEEDED}/${events.length} linked`;
  _setBadge(badge, s.MISSING === 0 ? 'ok' : 'warn');
  _log(`Relink all: ${s.SAFE} safe, ${s.REVIEW_NEEDED} review, ${s.MISSING} missing`);

  try { window.dispatchEvent(new CustomEvent('mps:ocf-state-changed')); } catch {}
  return { safe: s.SAFE, review: s.REVIEW_NEEDED, missing: s.MISSING, total: events.length };
}

// ── Mock/debug dispatch — use when native helper not available ─────────────────
// Call setMockMode(true) from DevTools console to test the full pipeline locally.
export function setMockMode(enabled) {
  if (!enabled) { _state._mockMode = false; return; }
  _state._mockMode = true;
  _log('⚡ Mock mode enabled — no native helper required');
}

async function _mockNativeDispatch(job, onProgress) {
  _log(`[MOCK] Exporting ${job.plateName}…`);
  const frames = job.expectedFrameCount || 24;
  for (let i = 0; i <= 10; i++) {
    await new Promise(r => setTimeout(r, 50));
    try { onProgress?.(i * 10); } catch {}
  }
  return {
    status: 'success',
    shotId: job.shotId,
    framesExported: frames,
    firstFrame: job.frameStart,
    lastFrame: job.frameStart + frames - 1,
    missingFrames: [],
    warnings: frames < 10 ? ['Short clip — verify handles'] : [],
    errors: [],
    metadata: { fps: job.fps, resolution: '4096x2160', camera: 'MOCK', reel: job.metadata?.sourceReel || '' },
  };
}

async function _mockNativeProbeFolder(folderPath) {
  await new Promise(r => setTimeout(r, 300));
  return [
    { name: 'A001C003_240101_R3D.R3D', path: `${folderPath}/A001/A001C003_240101_R3D.R3D`, reel: 'A001C003', tcIn: '01:12:10:00', tcOut: '01:12:14:00', fps: 24, frameCount: 96, camera: 'RED', format: 'R3D' },
    { name: 'A001C004_240101_R3D.R3D', path: `${folderPath}/A001/A001C004_240101_R3D.R3D`, reel: 'A001C004', tcIn: '01:14:00:00', tcOut: '01:14:08:00', fps: 24, frameCount: 192, camera: 'RED', format: 'R3D' },
    { name: 'B002C001_240101.ari',      path: `${folderPath}/B002/B002C001_240101.ari`,      reel: 'B002C001', tcIn: '09:00:10:00', tcOut: '09:00:18:00', fps: 24, frameCount: 192, camera: 'ARRI', format: 'ARRIRAW' },
  ];
}
