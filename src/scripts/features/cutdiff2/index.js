// scripts/features/cutdiff2/index.js
// CUT DIFF 2.0 — Studio-grade diff tab with dual-track canvas, risk-stripe rows,
// inspector panel, video compare, and keyboard navigation.
// ─────────────────────────────────────────────────────────────────────────────

import { attachPlayableVideo, releasePlayableVideo, PLAYABLE_STATUS } from '../../core/playableMedia.js';

export function createCutDiff2Feature(deps = {}) {
  const {
    CutDiff,
    parseFromFiles,
    handleDroppedDataTransfer,
    pickTimelineFiles,
    stemNoExt,
    tcToFrames,
    esc: _escDep,
    on,
    showError,
    buildEDLFiles,
  } = deps;

  const esc = _escDep ?? ((s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'));

  // ── Diff module state ─────────────────────────────────────────────────────
  const _s = {
    oldRaw:       null,
    newRaw:       null,
    oldEvents:    [],
    newEvents:    [],
    diff:         [],
    oldName:      '',
    newName:      '',
    fps:          24,
    analyzed:     false,
    selectedIdx:  -1,
    filterType:   'ALL',
    filterRisk:   'all',
    statusMap:    new Map(),
    noteMap:      new Map(),
  };

  // ── Proxy ETA tracker factory ────────────────────────────────────────────
  function _makeProxyEta() {
    let _t0 = 0; // set on first non-zero pct; never reset by zeros
    return {
      update(pct) {
        if (pct <= 0) return ''; // skip zeros — do NOT reset _t0
        const now = Date.now();
        if (!_t0) { _t0 = now; return ''; } // first non-zero call: establish baseline
        const elapsedSec = (now - _t0) / 1000;
        if (elapsedSec < 0.3) return '';
        const rate = pct / elapsedSec;
        if (!rate || !isFinite(rate)) return '';
        const remSec = Math.max(0, (100 - pct) / rate);
        if (remSec < 5) return '';
        if (remSec < 60) return `~${Math.ceil(remSec)}s left`;
        const m = Math.floor(remSec / 60);
        const s = Math.round(remSec % 60);
        return s > 0 ? `~${m}m ${s}s left` : `~${m}m left`;
      },
      reset() { _t0 = 0; },
    };
  }
  const _proxyEta   = { old: null, new: null };
  const _proxyTimer = { old: null, new: null }; // setInterval handles for elapsed ticker
  const _proxyT0    = { old: 0,    new: 0    }; // wall-clock start per side

  // ── Video compare state ───────────────────────────────────────────────────
  const _vc = {
    mode:        'sbs',     // wipe | sbs | split | ab | diff | heat
    fit:         'contain', // contain | cover
    wipe:        0.5,       // 0–1
    chain:       true,
    loop:        false,
    audio:       false,
    showA:       true,      // for AB mode
    rate:        1,
    oldUrl:      null,
    newUrl:      null,
    oldName:     '',
    newName:     '',
    oldSize:     0,
    newSize:     0,
    _readyOld:   false,
    _readyNew:   false,
    _oldStartF:  0,
    _newStartF:  0,
    _chainOffF:  0,
    _loopRange:  null,
    _raf:        0,
    _scrubbing:  false,
    collapsed:   false,
  };

  const DIFF_COLOR = {
    NEW:       '#72e6ff',
    EXTENDED:  '#4caf80',
    CHANGED:   '#e5c07b',
    TRIMMED:   '#6868a0',
    UNCHANGED: '#252540',
  };
  const RISK_COLOR = { high: '#e06c75', med: '#e5c07b', low: '#4caf80' };

  // ── DOM refs ──────────────────────────────────────────────────────────────
  let _dom = {};

  // ── Canvas animation frame for timeline ───────────────────────────────────
  let _tlRaf = null;

  // ── Filmstrip thumbnail state ─────────────────────────────────────────────
  const _thumbCache     = new Map();   // 'old:recIn' | 'new:recIn' → ImageBitmap
  const _thumbBusySides = new Set();   // which sides are currently extracting
  const _thumbGen       = { old: 0, new: 0 }; // generation counter — increment to abort stale run
  let   _tlPlayheadF    = -1;          // NEW-side sequence frame for playhead
  let   _tlPlayheadOldF = -1;          // OLD-side sequence frame for playhead
  // Live-capture canvases: updated every RAF tick during playback so the filmstrip
  // shows the current video frame at the playhead clip instead of the static extract.
  let   _liveThumbOld   = null;        // HTMLCanvasElement | null
  let   _liveThumbNew   = null;        // HTMLCanvasElement | null

  // ── Content diff graph state ──────────────────────────────────────────────
  // Array of {frame, score} where score 0=identical … 1=completely different
  const _contentDiffMap  = [];
  let   _contentDiffBusy = false;

  // ── Timeline zoom / pan state ─────────────────────────────────────────────
  let _tlVisStart    = null;  // null = show full sequence
  let _tlVisEnd      = null;  // null = show full sequence
  let _tlPanOccurred = false; // suppress click after pan/drag

  // ── Smart layout mode ────────────────────────────────────────────────────────
  let _tlSmartMode = true;    // true = slot-aligned compare; false = sequence positions
  let _smartSlots  = [];      // slot array built in _drawTimelineSmart(); used for click hit-test
  let _smartSlotX  = [];      // left-px of each slot
  let _smartSlotW  = [];      // width-px of each slot

  // ── Media management state ────────────────────────────────────────────────
  let _autoRelinkFn = null;   // module-level ref so applySnapshot() can remove old listener
  let _vcRestoring  = false;  // concurrency guard for _vcRestoreFromIDB()
  // Generation token per side, guards against _vcBrowse()/_vcRestoreSilent()/_vcRestoreFromIDB()
  // racing each other via independent async IDB/permission chains that can resolve in any order —
  // the highest-generation caller to reach _vcLoad() wins; stale callers bail without touching state.
  const _vcLoadGen = { old: 0, new: 0 };

  // ── Video handle persistence (IDB) ───────────────────────────────────────
  // IMPORTANT: must be declared before the return statement to avoid TDZ errors
  const _VC_IDB_NAME  = 'pfx_cd2_vc';
  const _VC_IDB_STORE = 'handles';

  // ── Thumbnail IDB cache ───────────────────────────────────────────────────
  const _THUMB_IDB_NAME  = 'pfx_cd2_thumbs_v1';
  const _THUMB_IDB_STORE = 'thumbs';

  // ── Render Queue handler ──────────────────────────────────────────────────
  window.__rqExportHandlers = window.__rqExportHandlers || {};
  window.__rqExportHandlers['cd2'] = async (fmt) => {
    if (fmt === 'pulledl') await _exportPullEdl();
    else if (fmt === 'xls') await _exportXls();
  };

  // ── Public API ────────────────────────────────────────────────────────────
  return { mount, onTabActivated, clear, getSnapshot, applySnapshot };

  function clear() {
    // Cancel timeline RAF
    if (_tlRaf) { cancelAnimationFrame(_tlRaf); _tlRaf = null; }

    // Remove auto-relink document listener if still registered
    if (_autoRelinkFn) {
      document.removeEventListener('click',   _autoRelinkFn, true);
      document.removeEventListener('keydown', _autoRelinkFn, true);
      _autoRelinkFn = null;
    }

    // Reset filmstrip + content diff + zoom state
    for (const bmp of _thumbCache.values()) { try { bmp?.close?.(); } catch {} }
    _thumbCache.clear(); _thumbBusySides.clear(); _thumbGen.old++; _thumbGen.new++; _tlPlayheadF = -1;
    _contentDiffMap.length = 0; _contentDiffBusy = false;
    _tlVisStart = null; _tlVisEnd = null; _tlPanOccurred = false;
    // Clear overlay canvas
    try { const ov = _dom.tlOverlay; if (ov) { const ctx = ov.getContext('2d'); ctx?.clearRect(0, 0, ov.width, ov.height); } } catch {}

    // Revoke video blob URLs and release any proxy state
    if (_vc.oldUrl) { try { URL.revokeObjectURL(_vc.oldUrl); } catch {} _vc.oldUrl = null; }
    if (_vc.newUrl) { try { URL.revokeObjectURL(_vc.newUrl); } catch {} _vc.newUrl = null; }
    try { if (_dom?.vc?.vidOld) releasePlayableVideo(_dom.vc.vidOld); } catch {}
    try { if (_dom?.vc?.vidNew) releasePlayableVideo(_dom.vc.vidNew); } catch {}

    // Reset diff state
    Object.assign(_s, {
      oldRaw: null, newRaw: null, oldEvents: [], newEvents: [], diff: [],
      oldName: '', newName: '', fps: 24, analyzed: false,
      selectedIdx: -1, filterType: 'ALL', filterRisk: 'all',
    });
    _s.statusMap.clear();
    _s.noteMap.clear();

    // Reset video compare state
    Object.assign(_vc, {
      mode: 'sbs',  fit: 'contain', wipe: 0.5, chain: true, loop: false,
      audio: false, showA: true, rate: 1, oldName: '', newName: '',
      _readyOld: false, _readyNew: false, _oldStartF: 0, _newStartF: 0,
      _chainOffF: 0, _loopRange: null, _raf: 0, _scrubbing: false, collapsed: false,
    });

    // Reset DOM
    const OLD_HINT = 'Drop OLD timeline (EDL / FCPXML)';
    const NEW_HINT = 'Drop NEW timeline (EDL / FCPXML)';
    if (_dom.oldLabel) _dom.oldLabel.textContent = OLD_HINT;
    if (_dom.newLabel) _dom.newLabel.textContent = NEW_HINT;
    _dom.oldDrop?.classList.remove('cd2x-drop-loaded');
    _dom.newDrop?.classList.remove('cd2x-drop-loaded');
    _renderEmpty();
    if (_dom.inspector) _dom.inspector.classList.remove('cd2x-insp-open');

    // Reset KPI counters (all fields)
    ['kpiNew','kpiExt','kpiChg','kpiRem','kpiRisk'].forEach(k => {
      if (_dom[k]) _dom[k].textContent = '—';
    });
    if (_dom.kpiDurAdd)      _dom.kpiDurAdd.textContent      = '+0s';
    if (_dom.kpiDurRem)      _dom.kpiDurRem.textContent      = '-0s';
    if (_dom.kpiPctChg)      _dom.kpiPctChg.textContent      = '—';
    if (_dom.kpiTotal)       _dom.kpiTotal.textContent        = '';
    if (_dom.kpiProgress)    _dom.kpiProgress.textContent     = '0%';
    if (_dom.kpiProgressBar) _dom.kpiProgressBar.style.width  = '0%';

    // Clear inspector state
    if (_dom.inspector) {
      _dom.inspector.classList.remove('cd2x-insp-open');
      delete _dom.inspector.dataset.dtype;
    }

    // Clear video elements and VC canvas
    const oldVid = _dom.oldVideo || document.getElementById('cd2x-old-video');
    const newVid = _dom.newVideo || document.getElementById('cd2x-new-video');
    [oldVid, newVid].forEach(v => {
      if (!v) return;
      try { v.pause(); } catch {}
      v.removeAttribute('src');
      try { v.load(); } catch {}
    });
    // Clear VC canvas
    try {
      const vc = _dom.vc?.canvas;
      if (vc) { const ctx = vc.getContext('2d'); ctx?.clearRect(0, 0, vc.width, vc.height); }
    } catch {}
    // Reset VC name labels
    if (_dom.vc?.oldName) _dom.vc.oldName.textContent = '—';
    if (_dom.vc?.newName) _dom.vc.newName.textContent = '—';

    // Redraw timeline canvas (now empty)
    _smartSlots = []; _smartSlotX = []; _smartSlotW = [];
    _tlPlayheadF = -1; _tlPlayheadOldF = -1;
    _schedTlRedraw();
  }

  // ── mount() ───────────────────────────────────────────────────────────────
  function mount() {
    _dom = {
      pane:         document.getElementById('main-cutdiff2'),
      oldDrop:      document.getElementById('cd2x-old-drop'),
      newDrop:      document.getElementById('cd2x-new-drop'),
      oldLabel:     document.getElementById('cd2x-old-label'),
      newLabel:     document.getElementById('cd2x-new-label'),
      oldBrowse:    document.getElementById('cd2x-old-browse'),
      newBrowse:    document.getElementById('cd2x-new-browse'),
      oldFile:      document.getElementById('cd2x-old-file'),
      newFile:      document.getElementById('cd2x-new-file'),
      smartBtn:     document.getElementById('cd2x-smart-btn'),
      smartFile:    document.getElementById('cd2x-smart-file'),
      hdr:          document.getElementById('cd2x-hdr'),
      vcOldSlot:    document.getElementById('cd2x-vc-old-slot'),
      vcNewSlot:    document.getElementById('cd2x-vc-new-slot'),
      analyzeBtn:   document.getElementById('cd2x-analyze-btn'),
      exportBtn:    document.getElementById('cd2x-export-btn'),
      exportMenu:   document.getElementById('cd2x-export-menu'),
      kpiNew:       document.getElementById('cd2x-kpi-new'),
      kpiExt:       document.getElementById('cd2x-kpi-ext'),
      kpiChg:       document.getElementById('cd2x-kpi-chg'),
      kpiRem:       document.getElementById('cd2x-kpi-rem'),
      kpiRisk:      document.getElementById('cd2x-kpi-risk'),
      kpiTotal:     document.getElementById('cd2x-kpi-total'),
      kpiDurAdd:    document.getElementById('cd2x-kpi-dur-add'),
      kpiDurRem:    document.getElementById('cd2x-kpi-dur-rem'),
      kpiPctChg:    document.getElementById('cd2x-kpi-pct-changed'),
      kpiProgress:  document.getElementById('cd2x-kpi-progress'),
      kpiProgressBar: document.getElementById('cd2x-kpi-progress-bar'),
      filterBtns:   document.querySelectorAll('.cd2x-filter-btn'),
      riskBtns:     document.querySelectorAll('.cd2x-risk-btn'),
      tlCanvas:     document.getElementById('cd2x-tl-canvas'),
      tlOverlay:    document.getElementById('cd2x-tl-overlay'),
      tlModeBtn:    document.getElementById('cd2x-tl-mode-btn'),
      tlFitBtn:     document.getElementById('cd2x-tl-fit-btn'),
      tableBody:    document.getElementById('cd2x-tbody'),
      tableEmpty:   document.getElementById('cd2x-table-empty'),
      inspector:    document.getElementById('cd2x-inspector'),
      insp: {
        close:      document.getElementById('cd2x-insp-close'),
        event:      document.getElementById('cd2x-insp-event'),
        type:       document.getElementById('cd2x-insp-type'),
        reel:       document.getElementById('cd2x-insp-reel'),
        clip:       document.getElementById('cd2x-insp-clip'),
        srcIn:      document.getElementById('cd2x-insp-src-in'),
        srcOut:     document.getElementById('cd2x-insp-src-out'),
        recIn:      document.getElementById('cd2x-insp-rec-in'),
        recOut:     document.getElementById('cd2x-insp-rec-out'),
        duration:   document.getElementById('cd2x-insp-duration'),
        fps:        document.getElementById('cd2x-insp-fps'),
        scoreBar:   document.getElementById('cd2x-insp-score-bar'),
        scorePct:   document.getElementById('cd2x-insp-score-pct'),
        reason:     document.getElementById('cd2x-insp-reason'),
        oldClip:    document.getElementById('cd2x-insp-old-clip'),
        oldSrcIn:   document.getElementById('cd2x-insp-old-src-in'),
        oldRecIn:   document.getElementById('cd2x-insp-old-rec-in'),
        status:     document.getElementById('cd2x-insp-status'),
        note:       document.getElementById('cd2x-insp-note'),
        noteSave:   document.getElementById('cd2x-insp-note-save'),
        seekBtn:    document.getElementById('cd2x-insp-seek-btn'),
      },
      // Video compare DOM
      vc: {
        panel:      document.getElementById('cd2x-vc-panel'),
        body:       document.getElementById('cd2x-vc-body'),
        toggle:     document.getElementById('cd2x-vc-toggle'),
        vidOld:     document.getElementById('cd2x-vc-vid-old'),
        vidNew:     document.getElementById('cd2x-vc-vid-new'),
        canvas:     document.getElementById('cd2x-vc-canvas'),
        view:       document.getElementById('cd2x-vc-view'),
        wipe:       document.getElementById('cd2x-vc-wipe'),
        hud:        document.getElementById('cd2x-vc-hud'),
        scrub:      document.getElementById('cd2x-vc-scrub'),
        play:       document.getElementById('cd2x-vc-play'),
        prevF:      document.getElementById('cd2x-vc-prev-f'),
        nextF:      document.getElementById('cd2x-vc-next-f'),
        home:       document.getElementById('cd2x-vc-home'),
        end:        document.getElementById('cd2x-vc-end'),
        rate:       document.getElementById('cd2x-vc-rate'),
        tc:         document.getElementById('cd2x-vc-tc'),
        tcOld:      document.getElementById('cd2x-vc-tc-old'),
        tcNew:      document.getElementById('cd2x-vc-tc-new'),
        oldBrowse:  document.getElementById('cd2x-vc-old-browse'),
        newBrowse:  document.getElementById('cd2x-vc-new-browse'),
        oldFile:    document.getElementById('cd2x-vc-old-file'),
        newFile:    document.getElementById('cd2x-vc-new-file'),
        oldName:    document.getElementById('cd2x-vc-old-name'),
        newName:    document.getElementById('cd2x-vc-new-name'),
        chain:      document.getElementById('cd2x-vc-chain'),
        loop:       document.getElementById('cd2x-vc-loop'),
        audio:      document.getElementById('cd2x-vc-audio'),
        fit:        document.getElementById('cd2x-vc-fit'),
        full:       document.getElementById('cd2x-vc-full'),
        modes:      document.getElementById('cd2x-vc-modes'),
        setup:      document.getElementById('cd2x-vc-setup'),
        // Metadata bar
        metaOldName:  document.getElementById('cd2x-meta-old-name'),
        metaOldTc:    document.getElementById('cd2x-meta-old-tc'),
        metaOldFrame: document.getElementById('cd2x-meta-old-frame'),
        metaNewName:  document.getElementById('cd2x-meta-new-name'),
        metaNewTc:    document.getElementById('cd2x-meta-new-tc'),
        metaNewFrame: document.getElementById('cd2x-meta-new-frame'),
      },
    };

    if (!_dom.pane) return;

    // ── Register project-lifecycle hooks ──────────────────────────────────
    // projectFile.js reads window.__MPS_CD_SNAPSHOT at save time; the getter
    // always returns the current in-memory state so saves are never stale.
    try {
      Object.defineProperty(window, '__MPS_CD_SNAPSHOT', {
        get: () => getSnapshot(),
        configurable: true,
      });
    } catch {}
    window.MPS_applyCutDiffSnapshot = applySnapshot;

    _loadPersistedStatus();
    _wireDrop(_dom.oldDrop, 'old');
    _wireDrop(_dom.newDrop, 'new');
    _wireBrowse(_dom.oldBrowse, _dom.oldFile, 'old');
    _wireBrowse(_dom.newBrowse, _dom.newFile, 'new');
    _wireSmartImport();
    _wireFilters();
    _wireButtons();
    _wireKeyboard();
    _wireInspector();
    _wireCanvasClick();
    _wireCanvasZoom();
    _wireColResize();
    // Smart mode toggle button
    _dom.tlModeBtn?.addEventListener('click', () => {
      _tlSmartMode = !_tlSmartMode;
      _dom.tlModeBtn.innerHTML = _tlSmartMode
        ? '<svg width="9" height="13" viewBox="0 0 9 13" fill="none" style="flex-shrink:0"><polygon points="5.5,0 0,7.5 4,7.5 3.5,13 9,5.5 5,5.5" fill="white"/></svg> Smart'
        : '<svg width="11" height="11" viewBox="0 0 11 11" fill="none" style="flex-shrink:0"><circle cx="5.5" cy="5.5" r="4.5" stroke="#d0d8ff" stroke-width="1.5"/><line x1="5.5" y1="2.5" x2="5.5" y2="5.5" stroke="#d0d8ff" stroke-width="1.5" stroke-linecap="round"/><line x1="5.5" y1="5.5" x2="7.5" y2="7" stroke="#d0d8ff" stroke-width="1.5" stroke-linecap="round"/></svg> Sequence';
      _dom.tlModeBtn.classList.toggle('is-smart', _tlSmartMode);
      _dom.tlModeBtn.classList.toggle('is-seq', !_tlSmartMode);
      _tlVisStart = null; _tlVisEnd = null; // reset zoom on mode switch
      _schedTlRedraw();
    });
    // Fit-all button — reset zoom to show full sequence
    _dom.tlFitBtn?.addEventListener('click', () => {
      _tlVisStart = null; _tlVisEnd = null;
      _schedTlRedraw();
    });
    _wireThumbDrop();
    _renderEmpty();
    _vcInit();
  }

  function onTabActivated() {
    _schedTlRedraw();
    _vcRender();
    // Try silent restore — queryPermission only (no user-gesture prompt).
    // Handles the case where the handle was already granted this browser session.
    // If not silently restorable, the canvas will show a "click to re-link" prompt.
    if ((_vc.oldName && !_vc.oldUrl) || (_vc.newName && !_vc.newUrl)) {
      _vcRestoreSilent();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // VIDEO COMPARE ENGINE
  // ══════════════════════════════════════════════════════════════════════════

  function _vcInit() {
    const v = _dom.vc;
    if (!v.panel || !v.canvas) return;

    // Browse wiring — prefer showOpenFilePicker() so we get a FileSystemFileHandle
    // that can be saved to IDB and re-opened on next project load.
    async function _vcBrowse(which) {
      // Claim this side's generation before any await — any restore chain
      // (_vcRestoreSilent/_vcRestoreFromIDB) still in flight for `which` is now stale
      // and must lose to whichever attempt reaches _vcLoad() last, in generation order.
      const myGen = ++_vcLoadGen[which];

      // If a name is saved but video isn't loaded yet (project restore), try IDB handle first.
      // This click IS a user gesture so requestPermission() will work.
      const savedName     = which === 'old' ? _vc.oldName : _vc.newName;
      const alreadyLoaded = which === 'old' ? !!_vc.oldUrl : !!_vc.newUrl;
      if (savedName && !alreadyLoaded) {
        try {
          const handle = await _vcLoadHandle(which);
          if (handle) {
            // 1. Try getFile() directly — works if permission already active (same session)
            let file = null;
            try { file = await handle.getFile(); } catch {}
            if (!file && typeof handle.requestPermission === 'function') {
              // 2. Ask for permission (this click IS a user gesture)
              const perm = await handle.requestPermission({ mode: 'read' });
              if (perm === 'granted') file = await handle.getFile();
            }
            if (file) {
              if (_vcLoadGen[which] > myGen) return; // superseded while we awaited
              _vcLoadGen[which] = myGen;
              _vcLoad(which, file);
              return; // restored from IDB — no file picker needed
            }
          }
        } catch {}
        // Handle not in IDB or permission denied — fall through to file picker
      }

      if (typeof showOpenFilePicker === 'function') {
        try {
          const [handle] = await showOpenFilePicker({
            id: `cd2-vc-${which}`,
            types: [{ description: 'Video', accept: { 'video/*': ['.mp4', '.mov', '.mxf', '.avi', '.mkv', '.m4v', '.webm'] } }],
            multiple: false,
          });
          const file = await handle.getFile();
          await _vcSaveHandle(which, handle);
          _vcLoad(which, file);
          return;
        } catch (err) {
          if (err?.name === 'AbortError') return; // user cancelled
        }
      }
      // Fallback to hidden <input>
      if (which === 'old') v.oldFile?.click();
      else v.newFile?.click();
    }

    v.oldBrowse?.addEventListener('click', () => _vcBrowse('old'));
    v.newBrowse?.addEventListener('click', () => _vcBrowse('new'));
    v.oldFile?.addEventListener('change', async () => {
      const f = v.oldFile.files?.[0];
      if (f) _vcLoad('old', f);
      v.oldFile.value = '';
    });
    v.newFile?.addEventListener('change', async () => {
      const f = v.newFile.files?.[0];
      if (f) _vcLoad('new', f);
      v.newFile.value = '';
    });

    // Drop onto VC view — capture FileSystemFileHandle synchronously
    v.view?.addEventListener('dragover', e => e.preventDefault());
    v.view?.addEventListener('drop', async e => {
      e.preventDefault();
      const files = [...(e.dataTransfer.files || [])];
      if (!files.length) return;
      const side = e.shiftKey ? 'old' : 'new';
      // Capture handle before any await (item only valid during dispatch)
      const item = e.dataTransfer.items?.[0];
      const canGetHandle = item?.kind === 'file' && typeof item?.getAsFileSystemHandle === 'function';
      console.info(`[CD2-MEDIA] drop ${side}: getAsFileSystemHandle available=${canGetHandle}`);
      const handlePromise = canGetHandle
        ? item.getAsFileSystemHandle().catch(e => { console.warn('[CD2-MEDIA] getAsFileSystemHandle failed', e); return null; })
        : Promise.resolve(null);
      _vcLoad(side, files[0]);
      const handle = await handlePromise;
      console.info(`[CD2-MEDIA] drop ${side}: handle kind=${handle?.kind ?? 'null'}`);
      if (handle?.kind === 'file') _vcSaveHandle(side, handle);
      else console.warn(`[CD2-MEDIA] drop ${side}: no FileSystemFileHandle — IDB not updated, restore will fail`);
    });

    // Mode buttons
    v.modes?.querySelectorAll('[data-mode]').forEach(btn => {
      btn.addEventListener('click', () => {
        _vc.mode = btn.dataset.mode;
        v.modes.querySelectorAll('[data-mode]').forEach(b => b.classList.toggle('is-active', b === btn));
        if (_vc.mode === 'ab') { _vc.showA = true; }
        _vcRender();
      });
    });

    // Wipe slider
    v.wipe?.addEventListener('input', () => {
      _vc.wipe = (Number(v.wipe.value) || 50) / 100;
      _vcRender();
    });

    // Scrub
    v.scrub?.addEventListener('mousedown', () => { _vc._scrubbing = true; });
    v.scrub?.addEventListener('input', () => {
      if (!v.vidNew) return;
      const t = Number(v.scrub.value) || 0;
      v.vidNew.currentTime = t;
      _vcSyncOldToNew();
      _vcRender();
    });
    v.scrub?.addEventListener('mouseup', () => { _vc._scrubbing = false; });

    // Playback controls
    v.play?.addEventListener('click', _vcPlayPause);
    v.prevF?.addEventListener('click', () => _vcStepFrames(-1));
    v.nextF?.addEventListener('click', () => _vcStepFrames(1));
    v.home?.addEventListener('click', () => {
      if (_vc._loopRange) _vcSeekToFrame(_vc._loopRange.startF);
    });
    v.end?.addEventListener('click', () => {
      if (_vc._loopRange) _vcSeekToFrame(_vc._loopRange.endF);
    });

    v.rate?.addEventListener('change', () => {
      _vc.rate = Number(v.rate.value) || 1;
      _vcApplyRate();
    });

    v.tc?.addEventListener('change', () => {
      const fps = _s.fps || 24;
      const s = String(v.tc.value || '').trim();
      if (!s) return;
      const f = tcToFrames ? tcToFrames(s, fps) : 0;
      if (Number.isFinite(f)) _vcSeekToFrame(f);
    });

    // Icon buttons
    v.chain?.addEventListener('click', () => {
      _vc.chain = !_vc.chain;
      v.chain.classList.toggle('is-active', _vc.chain);
      v.chain.setAttribute('aria-pressed', _vc.chain ? 'true' : 'false');
    });
    v.loop?.addEventListener('click', () => {
      _vc.loop = !_vc.loop;
      v.loop.classList.toggle('is-active', _vc.loop);
      v.loop.setAttribute('aria-pressed', _vc.loop ? 'true' : 'false');
    });
    v.audio?.addEventListener('click', () => {
      _vc.audio = !_vc.audio;
      v.audio.classList.toggle('is-active', _vc.audio);
      if (v.vidNew) v.vidNew.muted = !_vc.audio;
    });
    v.fit?.addEventListener('click', () => {
      _vc.fit = _vc.fit === 'contain' ? 'cover' : 'contain';
      _vcRender();
    });
    v.full?.addEventListener('click', () => {
      try { v.view?.requestFullscreen?.(); } catch {}
    });

    // Canvas click: re-link prompt (when names known but not loaded) OR AB toggle
    v.canvas?.addEventListener('click', () => {
      // Re-link mode: names are known but videos not loaded — this click IS a user gesture
      if ((_vc.oldName && !_vc.oldUrl) || (_vc.newName && !_vc.newUrl)) {
        _vcRestoreFromIDB();
        return;
      }
      // AB mode: click canvas toggles A/B
      if (_vc.mode !== 'ab') return;
      _vc.showA = !_vc.showA;
      _vcRender();
    });

    // Video events
    const _onReady = (which) => () => {
      if (which === 'old') { _vc._readyOld = true; }
      else                  { _vc._readyNew = true; }
      if (v.vidNew && _vc._readyNew) {
        const dur = v.vidNew.duration || 0;
        if (v.scrub && dur) { v.scrub.max = String(dur); }
      }
      _vcUpdateStartFrames();
      _vcRender();
      // Kick off filmstrip thumbnail extraction for this side
      _extractAllThumbs(which);
      // Kick off content diff if both videos are now loaded and analysis exists
      if (_s.analyzed && _vc.oldUrl && _vc.newUrl) _extractContentDiff();
    };
    v.vidOld?.addEventListener('loadedmetadata', _onReady('old'));
    v.vidOld?.addEventListener('canplay', _onReady('old'));
    v.vidNew?.addEventListener('loadedmetadata', _onReady('new'));
    v.vidNew?.addEventListener('canplay', _onReady('new'));

    v.vidNew?.addEventListener('timeupdate', () => {
      if (!_vc._scrubbing && v.scrub) {
        try { v.scrub.value = String(v.vidNew?.currentTime || 0); } catch {}
      }
      _vcMaybeLoop();
      // Update timeline playhead + meta bar
      const fps  = _s.fps || 24;
      const newF = Math.round((v.vidNew?.currentTime || 0) * fps) + (_vc._newStartF || 0);
      const oldF = Math.round((v.vidOld?.currentTime || 0) * fps) + (_vc._oldStartF || 0);
      if (newF !== _tlPlayheadF || oldF !== _tlPlayheadOldF) {
        _tlPlayheadF = newF; _tlPlayheadOldF = oldF;
        _tlAutoTrack();
        _drawPlayheadOverlay();
      }
      // Meta bar TC display
      const _toTc = f => {
        const t  = Math.max(0, f / fps);
        const h  = Math.floor(t / 3600);
        const m  = Math.floor((t % 3600) / 60);
        const s  = Math.floor(t % 60);
        const fr = Math.floor(f % fps);
        return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}:${String(fr).padStart(2,'0')}`;
      };
      if (v.metaNewTc)    v.metaNewTc.textContent    = _toTc(newF);
      if (v.metaNewFrame) v.metaNewFrame.textContent  = newF;
      if (v.metaOldTc)    v.metaOldTc.textContent    = _toTc(oldF);
      if (v.metaOldFrame) v.metaOldFrame.textContent  = oldF;
    });
    v.vidOld?.addEventListener('ended', () => { if (!_vc.loop) _vcStopRaf(); });
    v.vidNew?.addEventListener('ended', () => {
      if (!_vc.loop) { _vcStopRaf(); _vcSetPlayIcon(); _vcRender(); }
    });

    // Initial state buttons
    v.chain?.classList.toggle('is-active', _vc.chain);
  }

  function _vcLoad(which, file) {
    if (!file) return;
    const v = _dom.vc;
    const vid = which === 'old' ? v.vidOld : v.vidNew;
    if (!vid) return;

    // Revoke previous raw blob URL (kept for thumbnail/diff extraction)
    try {
      const prev = which === 'old' ? _vc.oldUrl : _vc.newUrl;
      if (prev) URL.revokeObjectURL(prev);
    } catch {}

    // Release any previous proxy state on the video element
    releasePlayableVideo(vid);

    // Create a raw blob URL for thumbnail / content-diff extraction
    const url = URL.createObjectURL(file);
    if (which === 'old') { _vc.oldUrl = url; _vc.oldName = file.name || ''; _vc.oldSize = file.size || 0; _vc._readyOld = false; }
    else                  { _vc.newUrl = url; _vc.newName = file.name || ''; _vc.newSize = file.size || 0; _vc._readyNew = false; }

    if (which === 'old' && v.oldName)     v.oldName.textContent     = file.name || '';
    if (which === 'new' && v.newName)     v.newName.textContent     = file.name || '';
    if (which === 'old' && v.metaOldName) v.metaOldName.textContent = file.name || '';
    if (which === 'new' && v.metaNewName) v.metaNewName.textContent = file.name || '';
    if (which === 'old' && v.oldBrowse) v.oldBrowse.textContent = 'Import';
    if (which === 'new' && v.newBrowse) v.newBrowse.textContent = 'Import';

    // Show proxy preparation overlay for this side
    _vcProxyOvShow(which, file.name);

    // Attach with auto-proxy fallback (handles ProRes/MXF transcoding)
    attachPlayableVideo(vid, file, {
      onStatus: (label) => {
        if (label === PLAYABLE_STATUS.direct || label === PLAYABLE_STATUS.proxy) {
          _vcProxyOvHide(which);
          _vcSetHud('', '');
        } else if (label === PLAYABLE_STATUS.proxying) {
          _vcProxyOvMsg(which, 'Generating proxy…');
        } else if (label) {
          _vcProxyOvMsg(which, label);
        }
      },
      onProgress: (pct) => { _vcProxyOvProgress(which, pct); },
      onProxyFail: (hint) => { _vcProxyOvFail(which, hint); },
      onNoOutputDir: () => { _vcProxyOvFail(which, 'Set Media Root in Settings to enable ProRes proxy'); },
    });

    _vcSetHud('Loading…', '');
  }

  // ── Proxy overlay helpers ──────────────────────────────────────────────────

  function _vcProxyOvShow(which, fname) {
    const ov  = document.getElementById('cd2x-proxy-ov');
    const row = document.getElementById(`cd2x-proxy-row-${which}`);
    if (!ov || !row) return;
    const fnEl  = document.getElementById(`cd2x-proxy-fname-${which}`);
    const msgEl = document.getElementById(`cd2x-proxy-msg-${which}`);
    const barEl = document.getElementById(`cd2x-proxy-bar-${which}`);
    const etaEl = document.getElementById(`cd2x-proxy-eta-${which}`);
    const manEl = document.getElementById(`cd2x-proxy-manual-${which}`);
    if (fnEl)  fnEl.textContent  = fname || '';
    if (msgEl) msgEl.textContent = 'Preparing proxy…';
    if (barEl) { barEl.className = 'cd2x-proxy-shimmer'; barEl.style.cssText = 'height:100%;width:100%;border-radius:2px;'; }
    if (etaEl) { etaEl.dataset.hasEta = ''; etaEl.textContent = ''; etaEl.style.display = 'none'; }
    if (manEl) manEl.style.display = 'none';
    _proxyEta[which]   = _makeProxyEta();
    _proxyT0[which]    = Date.now();
    if (_proxyTimer[which]) clearInterval(_proxyTimer[which]);
    _proxyTimer[which] = setInterval(() => {
      const ov = document.getElementById('cd2x-proxy-ov');
      if (!ov || ov.style.display === 'none') { clearInterval(_proxyTimer[which]); _proxyTimer[which] = null; return; }
      if (document.hidden) return;
      const el = document.getElementById(`cd2x-proxy-eta-${which}`);
      if (!el || el.dataset.hasEta === 'true') return;
      const sec = Math.floor((Date.now() - _proxyT0[which]) / 1000);
      if (sec < 4) return;
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      el.textContent = m > 0 ? `${m}m ${s}s elapsed` : `${s}s elapsed`;
      el.style.display = 'block';
    }, 1000);
    row.style.display = 'flex';
    ov.style.display  = 'flex';
  }

  function _vcProxyOvHide(which) {
    const row = document.getElementById(`cd2x-proxy-row-${which}`);
    if (row) row.style.display = 'none';
    if (_proxyEta[which]) { _proxyEta[which].reset(); _proxyEta[which] = null; }
    if (_proxyTimer[which]) { clearInterval(_proxyTimer[which]); _proxyTimer[which] = null; }
    _proxyT0[which] = 0;
    const other    = which === 'old' ? 'new' : 'old';
    const otherRow = document.getElementById(`cd2x-proxy-row-${other}`);
    if (!otherRow || otherRow.style.display === 'none') {
      const ov = document.getElementById('cd2x-proxy-ov');
      if (ov) ov.style.display = 'none';
    }
  }

  function _vcProxyOvMsg(which, msg) {
    const el = document.getElementById(`cd2x-proxy-msg-${which}`);
    if (el) el.textContent = msg;
  }

  function _vcProxyOvProgress(which, pct) {
    const bar = document.getElementById(`cd2x-proxy-bar-${which}`);
    if (!bar) return;
    const msg = document.getElementById(`cd2x-proxy-msg-${which}`);
    const etaEl = document.getElementById(`cd2x-proxy-eta-${which}`);

    if (pct <= 0) return; // still indeterminate shimmer — leave as-is

    bar.className = '';
    bar.style.cssText = 'height:100%;border-radius:2px;background:#6366f1;transition:width .3s;';
    bar.style.width = `${Math.min(100, pct)}%`;

    if (pct >= 100) {
      if (msg) msg.textContent = 'Finalizing…';
      if (etaEl) { etaEl.dataset.hasEta = ''; etaEl.textContent = ''; etaEl.style.display = 'none'; }
    } else {
      if (msg) msg.textContent = `Generating proxy…  ${Math.round(pct)}%`;
      const eta = _proxyEta[which]?.update(pct) || '';
      if (etaEl) {
        if (eta) {
          etaEl.dataset.hasEta = 'true'; // suppress elapsed ticker
          etaEl.textContent = `⏱ ${eta}`;
          etaEl.style.display = 'block';
        } else {
          etaEl.dataset.hasEta = ''; // let elapsed ticker continue
        }
      }
    }
  }

  function _vcProxyOvFail(which, hint) {
    if (_proxyTimer[which]) { clearInterval(_proxyTimer[which]); _proxyTimer[which] = null; }
    const bar = document.getElementById(`cd2x-proxy-bar-${which}`);
    if (bar) { bar.className = ''; bar.style.cssText = 'height:100%;width:100%;border-radius:2px;background:#6b2525;'; }
    const msg = document.getElementById(`cd2x-proxy-msg-${which}`);
    if (msg) {
      const reason = hint ? (hint.includes(' — ') ? hint.slice(hint.indexOf(' — ') + 3) : hint) : 'Proxy unavailable.';
      const isNoHelper = /native helper|Browser Mode/i.test(reason);
      msg.textContent = isNoHelper
        ? 'Native helper not running — load a proxy manually.'
        : (reason || 'Proxy failed — load manually below.');
    }
    const manEl = document.getElementById(`cd2x-proxy-manual-${which}`);
    if (manEl) {
      manEl.style.display = 'flex';
      const inp = manEl.querySelector('input[type="file"]');
      if (inp && !inp._cd2xWired) {
        inp._cd2xWired = true;
        inp.onchange = (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          _vcProxyOvHide(which);
          const v   = _dom.vc;
          const vid = which === 'old' ? v.vidOld : v.vidNew;
          if (!vid) return;
          releasePlayableVideo(vid);
          const prevUrl = which === 'old' ? _vc.oldUrl : _vc.newUrl;
          try { if (prevUrl) URL.revokeObjectURL(prevUrl); } catch {}
          const manualUrl = URL.createObjectURL(f);
          if (which === 'old') { _vc.oldUrl = manualUrl; _vc._readyOld = false; }
          else                  { _vc.newUrl = manualUrl; _vc._readyNew = false; }
          vid.src = manualUrl;
          vid.load();
        };
      }
    }
  }

  function _vcResizeCanvas() {
    const v = _dom.vc;
    if (!v.view || !v.canvas) return;
    const r = v.view.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    const w = Math.max(2, Math.floor(r.width  * dpr));
    const h = Math.max(2, Math.floor(r.height * dpr));
    if (v.canvas.width  !== w) v.canvas.width  = w;
    if (v.canvas.height !== h) v.canvas.height = h;
  }

  function _vcFitRect(w, h) {
    const v = _dom.vc;
    const vid = v.vidNew || v.vidOld;
    const vw = Number(vid?.videoWidth  || 0);
    const vh = Number(vid?.videoHeight || 0);
    if (!vw || !vh) return { dx: 0, dy: 0, dw: w, dh: h };
    const vr = vw / vh;
    const cr = w / h;
    let dw, dh;
    if (_vc.fit === 'cover') {
      if (vr > cr) { dh = h; dw = h * vr; }
      else          { dw = w; dh = w / vr; }
    } else {
      if (vr > cr) { dw = w; dh = w / vr; }
      else          { dh = h; dw = h * vr; }
    }
    return { dx: (w - dw) / 2, dy: (h - dh) / 2, dw, dh };
  }

  function _vcHasBoth() {
    const v = _dom.vc;
    return !!(v.vidOld && v.vidNew && _vc._readyOld && _vc._readyNew);
  }

  function _vcIsPlaying() {
    const v = _dom.vc.vidNew;
    return !!(v && !v.paused && !v.ended);
  }

  function _vcSetPlayIcon() {
    const v = _dom.vc;
    const playing = _vcIsPlaying();
    v.play?.classList.toggle('is-active', playing);
    v.play?.setAttribute('aria-pressed', playing ? 'true' : 'false');
    if (v.play) v.play.title = playing ? 'Pause' : 'Play';
  }

  function _vcSetHud(line1, line2) {
    const v = _dom.vc;
    if (!v.hud) return;
    v.hud.innerHTML = line2
      ? `<span>${_escH(line1)}</span><span style="opacity:.55">${_escH(line2)}</span>`
      : `<span>${_escH(line1)}</span>`;
  }

  function _escH(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function _vcUpdateStartFrames() {
    const v = _dom.vc;
    const fps = _s.fps || 24;
    const a = (v.tcOld?.value || '00:00:00:00').trim();
    const b = (v.tcNew?.value || '00:00:00:00').trim();
    _vc._oldStartF = tcToFrames ? tcToFrames(a, fps) : 0;
    _vc._newStartF = tcToFrames ? tcToFrames(b, fps) : 0;
  }

  function _vcApplyRate() {
    const v = _dom.vc;
    const r = Math.max(0.1, Math.min(4, _vc.rate));
    try { if (v.vidOld) v.vidOld.playbackRate = r; } catch {}
    try { if (v.vidNew) v.vidNew.playbackRate = r; } catch {}
  }

  function _vcSyncOldToNew() {
    const v = _dom.vc;
    if (!_vcHasBoth()) return;
    const fps = _s.fps || 24;
    const off = (_vc.chain ? (_vc._chainOffF || 0) : 0) / fps;
    try { v.vidOld.currentTime = Math.max(0, (v.vidNew.currentTime || 0) + off); } catch {}
  }

  function _vcSeekToFrame(timelineF) {
    const v = _dom.vc;
    const hasOld = !!(v.vidOld && _vc._readyOld);
    const hasNew = !!(v.vidNew && _vc._readyNew);
    if (!hasOld && !hasNew) return;
    _vcUpdateStartFrames();
    const fps = _s.fps || 24;
    const f = Number(timelineF);
    if (!Number.isFinite(f)) return;
    const offF = _vc.chain ? (_vc._chainOffF || 0) : 0;

    // Auto-correct startF when TC inputs are at default 00:00:00:00 but the
    // sequence uses broadcast-style timecodes (01:00:00:00+).  Mirror the same
    // heuristic used in _extractAllThumbs: find the minimum recIn frame and
    // treat that as the video's first-frame offset.
    const _autoStart = (configuredStart, vid, events) => {
      if (!vid || !events.length) return configuredStart;
      const minF = events.reduce((mn, e) => {
        const ef = tcToFrames ? tcToFrames(e.recIn || '00:00:00:00', fps) : 0;
        return ef < mn ? ef : mn;
      }, Infinity);
      if (!isFinite(minF)) return configuredStart;
      const probeT = Math.max(0, (minF - configuredStart) / fps);
      if (vid.duration && probeT > vid.duration) return minF;
      return configuredStart;
    };

    const oldStart = _autoStart(_vc._oldStartF || 0, v.vidOld, _s.oldEvents);
    const newStart = _autoStart(_vc._newStartF || 0, v.vidNew, _s.newEvents);

    const oldT = Math.max(0, (f + offF - oldStart) / fps);
    const newT = Math.max(0, (f        - newStart) / fps);

    try { if (hasOld) { v.vidOld.pause(); v.vidOld.currentTime = oldT; } } catch {}
    try { if (hasNew) { v.vidNew.pause(); v.vidNew.currentTime = newT; } } catch {}
    _vcStopRaf();
    _vcRender();
  }

  function _vcApplySelectionToVC(ev) {
    const hasAny = !!(_vc._readyOld || _vc._readyNew);
    if (!ev || !hasAny) return;
    const fps = _s.fps || 24;
    const fIn  = tcToFrames ? tcToFrames(ev.recIn  || '00:00:00:00', fps) : 0;
    const fOut = tcToFrames ? tcToFrames(ev.recOut || '00:00:00:00', fps) : fIn + fps;
    _vc._loopRange = { startF: fIn, endF: Math.max(fIn, fOut) };

    // Chain offset: align OLD to matchOldRecIn if available
    _vc._chainOffF = 0;
    if (_vc.chain && ev.matchOldRecIn) {
      try {
        const mf = tcToFrames ? tcToFrames(ev.matchOldRecIn, fps) : NaN;
        if (Number.isFinite(mf)) _vc._chainOffF = mf - fIn;
      } catch {}
    }

    _dom.vc.loop?.classList.toggle('is-active', !!_vc.loop);
    _vcSeekToFrame(fIn);
  }

  function _vcStepFrames(delta) {
    const v = _dom.vc;
    if (!_vcHasBoth()) return;
    const fps = _s.fps || 24;
    const d = (Number(delta) || 0) / fps;
    try { v.vidOld.pause(); v.vidNew.pause(); } catch {}
    _vcStopRaf();
    try { v.vidNew.currentTime = Math.max(0, (v.vidNew.currentTime || 0) + d); } catch {}
    _vcSyncOldToNew();
    _vcSetPlayIcon();
    _vcRender();
  }

  function _vcPlayPause() {
    const v = _dom.vc;
    if (!_vcHasBoth()) return;
    if (_vcIsPlaying()) {
      try { v.vidOld.pause(); v.vidNew.pause(); } catch {}
      _vcStopRaf();
      _vcSetPlayIcon();
      _vcRender();
    } else {
      _vcSyncOldToNew();
      _vcApplyRate();
      try { v.vidOld.play(); } catch {}
      try { v.vidNew.play(); } catch {}
      _vcSetPlayIcon();
      _vcStartRaf();
    }
  }

  function _vcMaybeLoop() {
    const v = _dom.vc;
    if (!_vc.loop || !_vc._loopRange || !_vcHasBoth()) return;
    const fps = _s.fps || 24;
    const r = _vc._loopRange;
    const startT = Math.max(0, (r.startF - (_vc._newStartF || 0)) / fps);
    const endT   = Math.max(startT, (r.endF - (_vc._newStartF || 0)) / fps);
    if ((v.vidNew?.currentTime || 0) > endT + 1 / fps) {
      try { v.vidNew.currentTime = startT; } catch {}
      const offT = (_vc.chain ? (_vc._chainOffF || 0) : 0) / fps;
      try { v.vidOld.currentTime = Math.max(0, startT + offT); } catch {}
    }
  }

  function _vcStopRaf() {
    if (_vc._raf) { cancelAnimationFrame(_vc._raf); _vc._raf = 0; }
    // Clear live captures so filmstrip reverts to static pre-extracted thumbnails
    _liveThumbOld = null;
    _liveThumbNew = null;
    _schedTlRedraw();
  }

  // Capture a small canvas snapshot from a video element for live filmstrip display
  function _captureLiveThumb(vid) {
    if (!vid || vid.readyState < 2 || !vid.videoWidth) return null;
    try {
      const c = document.createElement('canvas');
      c.width = 160; c.height = 90;
      c.getContext('2d').drawImage(vid, 0, 0, 160, 90);
      return c;
    } catch { return null; }
  }

  function _vcStartRaf() {
    _vcStopRaf();
    let _lastLiveCaptureF = -1;
    const tick = () => {
      _vcRender();
      // Sync timeline playheads at 60fps
      const fps  = _s.fps || 24;
      const newF = Math.round((_dom.vc.vidNew?.currentTime || 0) * fps) + (_vc._newStartF || 0);
      const oldF = Math.round((_dom.vc.vidOld?.currentTime || 0) * fps) + (_vc._oldStartF || 0);
      if (newF !== _tlPlayheadF || oldF !== _tlPlayheadOldF) {
        _tlPlayheadF    = newF;
        _tlPlayheadOldF = oldF;
        _tlAutoTrack();
      }
      // Capture live frames for filmstrip (throttled to ~12fps to avoid perf hit)
      if (Math.abs(newF - _lastLiveCaptureF) >= Math.round(fps / 12)) {
        _liveThumbOld = _captureLiveThumb(_dom.vc.vidOld);
        _liveThumbNew = _captureLiveThumb(_dom.vc.vidNew);
        _lastLiveCaptureF = newF;
        _schedTlRedraw();
      }
      _drawPlayheadOverlay();
      if (_vcIsPlaying() && !document.hidden) _vc._raf = requestAnimationFrame(tick);
      else _vc._raf = 0;
    };
    _vc._raf = requestAnimationFrame(tick);
  }

  // Canvas rendering
  function _vcRender() {
    const v = _dom.vc;
    if (!v.canvas || _vc.collapsed) return;
    const ctx = v.canvas.getContext('2d');
    if (!ctx) return;
    _vcResizeCanvas();
    const w = v.canvas.width;
    const h = v.canvas.height;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;

    const hasOld = _vc._readyOld && !!v.vidOld;
    const hasNew = _vc._readyNew && !!v.vidNew;

    if (!hasOld && !hasNew) {
      const hasNames = _vc.oldName || _vc.newName;
      ctx.fillStyle = 'rgba(114,230,255,.04)';
      ctx.fillRect(0, 0, w, h);
      ctx.textAlign = 'center';
      if (hasNames) {
        // Saved video names are known but not loaded — guide user to Import buttons
        _vcSetHud('Videos need re-authorization — click Import or canvas', '');
        const baseSize = Math.round(w / 36);
        ctx.textAlign = 'center';
        ctx.font = `bold ${baseSize}px monospace`;
        ctx.fillStyle = 'rgba(245,197,66,.7)';
        ctx.fillText('\u26A0 Videos need re-authorization', w / 2, h / 2 - baseSize * 1.6);
        ctx.font = `${Math.round(w / 44)}px monospace`;
        ctx.fillStyle = 'rgba(245,197,66,.5)';
        ctx.fillText('Click this canvas  OR  use the Import buttons above', w / 2, h / 2 - baseSize * 0.3);
        ctx.font = `${Math.round(w / 58)}px monospace`;
        ctx.fillStyle = 'rgba(245,197,66,.25)';
        const oldLbl = _vc.oldName ? `OLD: ${_vc.oldName}` : '';
        const newLbl = _vc.newName ? `NEW: ${_vc.newName}` : '';
        ctx.fillText([oldLbl, newLbl].filter(Boolean).join('   \u2014   '), w / 2, h / 2 + baseSize * 1.1);
      } else {
        _vcSetHud('Drop OLD & NEW videos', '');
        ctx.font = `${Math.round(w / 40)}px monospace`;
        ctx.fillStyle = 'rgba(114,230,255,.2)';
        ctx.fillText('Drop video here (NEW) \u2014 Shift+Drop for OLD', w / 2, h / 2);
      }
      return;
    }
    if (!hasOld || !hasNew) {
      _vcSetHud(hasOld ? 'OLD ready — load NEW' : 'NEW ready — load OLD', '');
      ctx.fillStyle = 'rgba(255,255,255,.05)';
      ctx.fillRect(0, 0, w, h);
      if (hasNew) try { ctx.drawImage(v.vidNew, 0, 0, w, h); } catch {}
      else if (hasOld) try { ctx.drawImage(v.vidOld, 0, 0, w, h); } catch {}
      return;
    }

    const fps = _s.fps || 24;
    const t   = v.vidNew?.currentTime || 0;
    const fr  = Math.round(t * fps);
    const tc  = _framesToTc(fr + (_vc._newStartF || 0), fps);

    // Update TC display (only when not focused)
    try { if (v.tc && document.activeElement !== v.tc) v.tc.value = tc; } catch {}
    // Update scrub
    try { if (v.scrub && !_vc._scrubbing) v.scrub.value = String(t); } catch {}

    const fitR = _vcFitRect(w, h);

    if (_vc.mode === 'ab') {
      const vid = _vc.showA ? v.vidOld : v.vidNew;
      try { ctx.drawImage(vid, fitR.dx, fitR.dy, fitR.dw, fitR.dh); } catch {}
      _vcSetHud(_vc.showA ? 'A: OLD' : 'B: NEW', `TC ${tc}`);
      if (v.wipe) v.wipe.style.display = 'none';
      return;
    }

    if (_vc.mode === 'sbs') {
      const half = Math.floor(w / 2);
      const fitL = _vcFitRectFor(half, h, v.vidOld);
      const fitR2 = _vcFitRectFor(half, h, v.vidNew);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, half, h); ctx.clip();
      try { ctx.drawImage(v.vidOld, fitL.dx, fitL.dy, fitL.dw, fitL.dh); } catch {}
      ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(half, 0, half, h); ctx.clip();
      try { ctx.drawImage(v.vidNew, half + fitR2.dx, fitR2.dy, fitR2.dw, fitR2.dh); } catch {}
      ctx.restore();
      ctx.strokeStyle = 'rgba(114,230,255,.3)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(half, 0); ctx.lineTo(half, h); ctx.stroke();
      _vcSetHud('Side by side: OLD | NEW', `TC ${tc}`);
      if (v.wipe) v.wipe.style.display = 'none';
      return;
    }

    if (_vc.mode === 'split') {
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w/2, h); ctx.clip();
      try { ctx.drawImage(v.vidOld, fitR.dx, fitR.dy, fitR.dw, fitR.dh); } catch {}
      ctx.restore();
      ctx.save(); ctx.beginPath(); ctx.rect(w/2, 0, w/2, h); ctx.clip();
      try { ctx.drawImage(v.vidNew, fitR.dx, fitR.dy, fitR.dw, fitR.dh); } catch {}
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,255,255,.25)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(w/2, 0); ctx.lineTo(w/2, h); ctx.stroke();
      _vcSetHud('Split: OLD | NEW', `TC ${tc}`);
      if (v.wipe) v.wipe.style.display = 'none';
      return;
    }

    if (_vc.mode === 'diff' || _vc.mode === 'heat') {
      const diff = _vcComputeDiff(ctx, w, h, fitR, v);
      if (!diff) {
        _vcSetHud('Diff unavailable', `TC ${tc}`);
        return;
      }
      const pct = (diff.changed / Math.max(1, diff.px)) * 100;
      if (_vc.mode === 'diff') {
        const oCtx = diff.oC.getContext('2d');
        ctx.fillStyle = '#020208';
        ctx.fillRect(0, 0, w, h);
        oCtx.putImageData(diff.out, 0, 0);
        ctx.drawImage(diff.oC, 0, 0, diff.dw, diff.dh, fitR.dx, fitR.dy, fitR.dw, fitR.dh);
        _vcSetHud(`Diff ${pct.toFixed(1)}%`, `TC ${tc}`);
      } else {
        try { ctx.drawImage(v.vidNew, fitR.dx, fitR.dy, fitR.dw, fitR.dh); } catch {}
        const oCtx = diff.oC.getContext('2d');
        const O = diff.out.data;
        for (let i = 0; i < O.length; i += 4) {
          const val = O[i];
          if (val <= 0) { O[i+3] = 0; continue; }
          const n = Math.max(0, Math.min(1, val / 255));
          O[i]   = 255;
          O[i+1] = Math.round(180 * (1 - n));
          O[i+2] = 0;
          O[i+3] = Math.round(200 * n);
        }
        oCtx.putImageData(diff.out, 0, 0);
        ctx.drawImage(diff.oC, 0, 0, diff.dw, diff.dh, fitR.dx, fitR.dy, fitR.dw, fitR.dh);
        _vcSetHud(`Heat ${pct.toFixed(1)}%`, `TC ${tc}`);
      }
      if (v.wipe) v.wipe.style.display = 'none';
      return;
    }

    // Default: wipe
    const a = Math.max(0, Math.min(1, _vc.wipe));
    try { ctx.drawImage(v.vidOld, fitR.dx, fitR.dy, fitR.dw, fitR.dh); } catch {}
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, w * a, h);
    ctx.clip();
    try { ctx.drawImage(v.vidNew, fitR.dx, fitR.dy, fitR.dw, fitR.dh); } catch {}
    ctx.restore();
    ctx.strokeStyle = 'rgba(114,230,255,.55)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(w * a, 0); ctx.lineTo(w * a, h); ctx.stroke();
    _vcSetHud(`Wipe ${Math.round(a * 100)}%`, `TC ${tc}`);
    if (v.wipe) v.wipe.style.display = '';
  }

  function _vcFitRectFor(w, h, vid) {
    const vw = Number(vid?.videoWidth  || 0);
    const vh = Number(vid?.videoHeight || 0);
    if (!vw || !vh) return { dx: 0, dy: 0, dw: w, dh: h };
    const vr = vw / vh;
    const cr = w / h;
    let dw, dh;
    if (vr > cr) { dw = w; dh = w / vr; } else { dh = h; dw = h * vr; }
    return { dx: (w - dw) / 2, dy: (h - dh) / 2, dw, dh };
  }

  function _vcComputeDiff(ctx, w, h, fitR, v) {
    if (!v.vidOld || !v.vidNew) return null;
    const dw = Math.max(2, Math.min(320, Math.round(fitR.dw || w)));
    const dh = Math.max(2, Math.min(180, Math.round(fitR.dh || h)));
    const offC = new OffscreenCanvas(dw, dh);
    const oC   = new OffscreenCanvas(dw, dh);
    const offCtx = offC.getContext('2d');
    const oCtx  = oC.getContext('2d');
    try { offCtx.drawImage(v.vidOld, 0, 0, dw, dh); } catch { return null; }
    try { oCtx.drawImage(v.vidNew, 0, 0, dw, dh); } catch { return null; }
    let pixA, pixB;
    try {
      pixA = offCtx.getImageData(0, 0, dw, dh).data;
      pixB = oCtx.getImageData(0, 0, dw, dh).data;
    } catch { return null; }
    const out = oCtx.createImageData(dw, dh);
    const O = out.data;
    let changed = 0;
    for (let i = 0; i < pixA.length; i += 4) {
      const dr = Math.abs(pixA[i]   - pixB[i]);
      const dg = Math.abs(pixA[i+1] - pixB[i+1]);
      const db = Math.abs(pixA[i+2] - pixB[i+2]);
      const v2 = Math.round((dr * 0.299 + dg * 0.587 + db * 0.114));
      const amp = Math.min(255, v2 * 3);
      O[i] = O[i+1] = O[i+2] = amp;
      O[i+3] = 255;
      if (v2 > 12) changed++;
    }
    return { out, oC, dw, dh, changed, px: (pixA.length / 4) };
  }

  function _framesToTc(fr, fps) {
    const rate = Math.max(1, fps || 24);
    let v = Math.max(0, Math.round(fr));
    const ff = v % rate; v = Math.floor(v / rate);
    const ss = v % 60;   v = Math.floor(v / 60);
    const mm = v % 60;   v = Math.floor(v / 60);
    const hh = v;
    const pad = n => String(n).padStart(2, '0');
    return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // DIFF / TABLE ENGINE (unchanged from original)
  // ══════════════════════════════════════════════════════════════════════════

  function _wireDrop(zone, slot) {
    if (!zone) return;
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('cd2x-drop-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('cd2x-drop-over'));
    zone.addEventListener('drop', async e => {
      e.preventDefault();
      zone.classList.remove('cd2x-drop-over');
      try {
        let files = handleDroppedDataTransfer
          ? await handleDroppedDataTransfer(e.dataTransfer)
          : [...(e.dataTransfer.files || [])];
        if (files && files.length) await _loadSlot(slot, files);
      } catch (err) { showError?.(`Load error: ${err.message || err}`); }
    });
  }

  function _wireBrowse(btn, input, slot) {
    if (!btn || !input) return;
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const files = [...(input.files || [])];
      if (files.length) await _loadSlot(slot, files);
      input.value = '';
    });
  }

  // ── Smart Import ────────────────────────────────────────────────────────────
  function _wireSmartImport() {
    // Smart Import button → open multi-file picker
    _dom.smartBtn?.addEventListener('click', () => _dom.smartFile?.click());

    // Smart file input → route on change
    _dom.smartFile?.addEventListener('change', async () => {
      const files = [...(_dom.smartFile.files || [])];
      if (files.length) await _smartImport(files);
      _dom.smartFile.value = '';
    });

    // Slot click → browse that slot manually
    _dom.oldDrop?.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      _dom.oldFile?.click();
    });
    _dom.newDrop?.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      _dom.newFile?.click();
    });
    _dom.vcOldSlot?.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT') return; // let TC input handle its own clicks
      document.getElementById('cd2x-vc-old-browse')?.click();
    });
    _dom.vcNewSlot?.addEventListener('click', e => {
      if (e.target.tagName === 'INPUT') return;
      document.getElementById('cd2x-vc-new-browse')?.click();
    });

    // Drag-drop directly onto VID OLD / VID NEW header slots
    const _wireVidSlotDrop = (slot, which) => {
      if (!slot) return;
      let _depth = 0;
      slot.addEventListener('dragenter', e => {
        e.preventDefault(); e.stopPropagation();
        _depth++;
        slot.classList.add('cd2x-vc-slot-dragover');
      });
      slot.addEventListener('dragleave', () => {
        _depth--; if (_depth <= 0) { _depth = 0; slot.classList.remove('cd2x-vc-slot-dragover'); }
      });
      slot.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); });
      slot.addEventListener('drop', async e => {
        e.preventDefault(); e.stopPropagation();
        _depth = 0; slot.classList.remove('cd2x-vc-slot-dragover');
        const files = [...(e.dataTransfer.files || [])];
        if (!files.length) return;
        // Capture FileSystemFileHandle synchronously before any await
        const item = e.dataTransfer.items?.[0];
        const canGet = item?.kind === 'file' && typeof item?.getAsFileSystemHandle === 'function';
        const handlePromise = canGet ? item.getAsFileSystemHandle().catch(() => null) : Promise.resolve(null);
        _vcLoad(which, files[0]);
        const handle = await handlePromise;
        if (handle?.kind === 'file') _vcSaveHandle(which, handle);
      });
    };
    _wireVidSlotDrop(_dom.vcOldSlot, 'old');
    _wireVidSlotDrop(_dom.vcNewSlot, 'new');

    // Header-level drag-drop → smart routing (fires before individual slot drop zones)
    const hdr = _dom.hdr;
    if (hdr) {
      let _dragDepth = 0;
      hdr.addEventListener('dragenter', e => { e.preventDefault(); _dragDepth++; hdr.classList.add('cd2x-smart-dragover'); });
      hdr.addEventListener('dragleave', () => { _dragDepth--; if (_dragDepth <= 0) { _dragDepth = 0; hdr.classList.remove('cd2x-smart-dragover'); } });
      hdr.addEventListener('dragover',  e => e.preventDefault());
      hdr.addEventListener('drop', async e => {
        e.preventDefault(); _dragDepth = 0; hdr.classList.remove('cd2x-smart-dragover');
        try {
          // Capture handles BEFORE any await — DataTransfer.items become invalid after
          const VIDEO_EXT_SNIFF = /\.(mov|mp4|mxf|avi|r3d|mts|m2ts|m4v|webm|qt|dv)$/i;
          const _hpMap = new Map(); // name → Promise<FileSystemFileHandle|null>
          for (const item of (e.dataTransfer.items || [])) {
            if (item.kind !== 'file' || typeof item.getAsFileSystemHandle !== 'function') continue;
            const f = item.getAsFile?.();
            if (!f || !VIDEO_EXT_SNIFF.test(f.name)) continue;
            _hpMap.set(f.name, item.getAsFileSystemHandle().catch(() => null));
          }
          const files = handleDroppedDataTransfer
            ? await handleDroppedDataTransfer(e.dataTransfer)
            : [...(e.dataTransfer.files || [])];
          // Resolve handles now that we're past the await
          const handleMap = new Map();
          for (const [name, p] of _hpMap) {
            const h = await p;
            if (h?.kind === 'file') handleMap.set(name, h);
          }
          if (files?.length) await _smartImport(files, handleMap);
        } catch (err) { showError?.(`Smart import error: ${err.message || err}`); }
      });
    }
  }

  async function _smartImport(files, handleMap = new Map()) {
    const VIDEO_EXT = /\.(mov|mp4|mxf|avi|r3d|mts|m2ts|m4v|webm|qt|dv)$/i;
    const videos    = files.filter(f => VIDEO_EXT.test(f.name));
    const timelines = files.filter(f => !VIDEO_EXT.test(f.name));

    // Score: -1=OLD, +1=NEW, 0=neutral
    const _score = (f) => {
      const n = f.name.toLowerCase();
      if (/[_\-.]old[_\-.]|[_\-.]nc1[_\-.]|[_\-.]cut1[_\-.]|[_\-.]v1[_\-.]|\bold\b/.test(n)) return -1;
      if (/[_\-.]new[_\-.]|[_\-.]nc2[_\-.]|[_\-.]cut2[_\-.]|[_\-.]v2[_\-.]|\bnew\b/.test(n)) return  1;
      return 0;
    };
    const _byScore = (arr) => [...arr].sort((a, b) => {
      const sd = _score(a) - _score(b);
      return sd !== 0 ? sd : (a.lastModified || 0) - (b.lastModified || 0);
    });

    let tlOld = null, tlNew = null;
    const tls = _byScore(timelines);
    if (tls.length === 1) {
      if (!_s.oldEvents.length) tlOld = tls[0]; else tlNew = tls[0];
    } else if (tls.length >= 2) {
      tlOld = tls[0]; tlNew = tls[1];
    }

    let vidOld = null, vidNew = null;
    const vids = _byScore(videos);
    if (vids.length === 1) {
      if (!_vc.oldUrl) vidOld = vids[0]; else vidNew = vids[0];
    } else if (vids.length >= 2) {
      vidOld = vids[0]; vidNew = vids[1];
    }

    const assigned = [];
    if (tlOld)  { await _loadSlot('old', [tlOld]);  assigned.push(`OLD ← ${stemNoExt?.(tlOld.name) || tlOld.name}`); }
    if (tlNew)  { await _loadSlot('new', [tlNew]);  assigned.push(`NEW ← ${stemNoExt?.(tlNew.name) || tlNew.name}`); }
    if (vidOld) {
      _vcLoad('old', vidOld);
      const h = handleMap.get(vidOld.name);
      if (h) _vcSaveHandle('old', h);
      assigned.push(`VID OLD ← ${vidOld.name}`);
    }
    if (vidNew) {
      _vcLoad('new', vidNew);
      const h = handleMap.get(vidNew.name);
      if (h) _vcSaveHandle('new', h);
      assigned.push(`VID NEW ← ${vidNew.name}`);
    }

    if (assigned.length) _showSmartToast(assigned);

    // Auto-analyze if both timelines are now loaded
    if (_s.oldEvents.length && _s.newEvents.length && !_s.analyzed) {
      setTimeout(() => _analyze(), 120);
    }
  }

  function _showSmartToast(lines) {
    const existing = document.getElementById('cd2x-smart-toast');
    if (existing) existing.remove();
    const t = document.createElement('div');
    t.id = 'cd2x-smart-toast';
    t.className = 'cd2x-smart-toast';
    t.innerHTML = '<span class="cd2x-smart-toast-icon">&#9889;</span>' +
      lines.map(l => `<span>${esc(l)}</span>`).join('');
    (_dom.pane || document.body).appendChild(t);
    setTimeout(() => t.classList.add('cd2x-smart-toast-show'), 10);
    setTimeout(() => { t.classList.remove('cd2x-smart-toast-show'); setTimeout(() => t.remove(), 400); }, 3000);
  }

  async function _loadSlot(slot, files) {
    if (window.PFX_PERMISSIONS && !window.PFX_PERMISSIONS.canDoAction('import_timeline')) {
      window.PFX_GUARD?.deny?.('import_timeline');
      return;
    }
    let parsed = null;
    try {
      parsed = parseFromFiles ? await parseFromFiles(files) : null;
      if (!parsed) throw new Error('parseFromFiles not available');
    } catch (err) { showError?.(`Parse failed: ${err.message || err}`); return; }

    const events = parsed?.events || parsed?.raw?.events || [];
    const name   = stemNoExt?.(files[0]?.name || '') || files[0]?.name || slot.toUpperCase();
    const fps    = parsed?.fps || parsed?.raw?.fps || events[0]?.fps || 24;

    if (slot === 'old') {
      _s.oldRaw = parsed; _s.oldEvents = events; _s.oldName = name;
      if (_dom.oldLabel) _dom.oldLabel.textContent = name;
      _dom.oldDrop?.classList.add('cd2x-drop-loaded');
      _dom.oldDrop?.classList.remove('cd2x-auto-routed');
      requestAnimationFrame(() => _dom.oldDrop?.classList.add('cd2x-auto-routed'));
    } else {
      _s.newRaw = parsed; _s.newEvents = events; _s.newName = name; _s.fps = fps;
      if (_dom.newLabel) _dom.newLabel.textContent = name;
      _dom.newDrop?.classList.add('cd2x-drop-loaded');
      _dom.newDrop?.classList.remove('cd2x-auto-routed');
      requestAnimationFrame(() => _dom.newDrop?.classList.add('cd2x-auto-routed'));
    }

    _s.analyzed = false; _s.diff = []; _s.selectedIdx = -1;
    _renderKpi();
    _renderTable();
    try{ window.MPS_markProjectDirty?.('cut diff 2'); }catch{}
  }

  function _analyze() {
    if (!_s.oldEvents.length || !_s.newEvents.length) {
      showError?.('Load an OLD and NEW timeline first.'); return;
    }
    try {
      _s.diff = CutDiff.computeCutDiff(_s.oldEvents, _s.newEvents, { includeTrimmed: true, includeUnchanged: false });
    } catch (err) { showError?.(`Diff failed: ${err.message || err}`); return; }
    _s.analyzed = true; _s.selectedIdx = -1;
    try{ window.MPS_markProjectDirty?.('cut diff 2'); }catch{}
    _renderKpi(); _renderTable(); _schedTlRedraw(); _closeInspector();
    // Re-extract thumbnails and content diff now that events are available
    if (_vc.oldUrl) _extractAllThumbs('old');
    if (_vc.newUrl) _extractAllThumbs('new');
    if (_vc.oldUrl && _vc.newUrl) _extractContentDiff();
    // Smart auto-zoom: focus on changed events range
    _tlAutoZoom();
  }

  function _riskOf(ev) {
    const len = Number(ev.durationFrames || ev._lenFrames || 0);
    if (ev.diffType === 'NEW' || len > 240) return 'high';
    if (len > 48) return 'med';
    return 'low';
  }

  function _diffKey(ev) { return `${ev.reel || ''}|${ev.recIn || ''}|${ev.srcIn || ''}|${ev.diffType || ''}`; }

  function _filteredDiff() {
    return _s.diff.filter(ev => {
      if (_s.filterType !== 'ALL' && ev.diffType !== _s.filterType) return false;
      if (_s.filterRisk !== 'all' && _riskOf(ev) !== _s.filterRisk) return false;
      return true;
    });
  }

  function _renderKpi() {
    const counts = { NEW: 0, EXTENDED: 0, CHANGED: 0, TRIMMED: 0 };
    let highRisk = 0;
    let durAddFr = 0;   // frames added (NEW + EXTENDED)
    let durRemFr = 0;   // frames removed (TRIMMED)
    for (const ev of _s.diff) {
      const dt  = ev.diffType;
      const len = Number(ev.durationFrames || ev._lenFrames || 0);
      if (dt in counts) counts[dt]++;
      if (_riskOf(ev) === 'high') highRisk++;
      if (dt === 'NEW'      || dt === 'EXTENDED') { durAddFr += len; }
      if (dt === 'TRIMMED')                       { durRemFr += len; }
    }
    if (_dom.kpiNew)  _dom.kpiNew.textContent  = counts.NEW;
    if (_dom.kpiExt)  _dom.kpiExt.textContent  = counts.EXTENDED;
    if (_dom.kpiChg)  _dom.kpiChg.textContent  = counts.CHANGED;
    if (_dom.kpiRem)  _dom.kpiRem.textContent  = counts.TRIMMED;
    if (_dom.kpiRisk) _dom.kpiRisk.textContent = highRisk;

    // Duration impact
    const fps = _s.fps || 24;
    const _fr = fr => { const s = Math.round(fr / fps); return s < 60 ? `${s}s` : `${Math.floor(s/60)}m${s%60>0?` ${s%60}s`:''}`; };
    if (_dom.kpiDurAdd) _dom.kpiDurAdd.textContent = durAddFr > 0 ? `+${_fr(durAddFr)}` : '+0s';
    if (_dom.kpiDurRem) _dom.kpiDurRem.textContent = durRemFr > 0 ? `-${_fr(durRemFr)}` : '-0s';

    // % of cut changed — (non-UNCHANGED diff events) / total NEW events
    if (_dom.kpiPctChg) {
      const totalNew = _s.newEvents.length || _s.diff.length;
      const changedCount = _s.diff.filter(ev => ev.diffType !== 'UNCHANGED').length;
      // changedCount can include OLD-only (REMOVED/TRIMMED) events not present in
      // newEvents, so the raw ratio can exceed 100% — clamp the displayed value.
      _dom.kpiPctChg.textContent = totalNew > 0 ? `${Math.min(100, Math.round((changedCount / totalNew) * 100))}%` : '—';
    }

    // Total summary
    const totalNew = _s.newEvents.length || _s.diff.length;
    const diffShown = _s.diff.length;
    if (_dom.kpiTotal) {
      if (totalNew > 0) {
        const unchanged = _s.diff.filter(ev => ev.diffType === 'UNCHANGED').length;
        const changed   = diffShown - unchanged;
        const unshown   = totalNew - diffShown - unchanged; // fully matched, not shown
        _dom.kpiTotal.textContent = unchanged > 0
          ? `${changed} changed · ${unchanged} unchanged · ${totalNew} total`
          : `${changed} changed · ${unshown > 0 ? `${unshown} matched · ` : ''}${totalNew} total`;
      } else {
        _dom.kpiTotal.textContent = '';
      }
    }

    // Approved progress
    const okCount = [..._s.statusMap.values()].filter(v => v === 'ok').length;
    const pct = totalNew > 0 ? Math.round((okCount / totalNew) * 100) : 0;
    if (_dom.kpiProgress)    _dom.kpiProgress.textContent = `${pct}%`;
    if (_dom.kpiProgressBar) _dom.kpiProgressBar.style.width = `${pct}%`;
  }

  function _renderEmpty() {
    if (_dom.tableEmpty) _dom.tableEmpty.style.display = '';
    if (_dom.tableBody)  _dom.tableBody.innerHTML = '';
  }

  function _renderTable() {
    const rows = _filteredDiff();
    if (!rows.length) {
      if (_dom.tableEmpty) {
        _dom.tableEmpty.textContent = _s.analyzed ? 'No events match the current filter.' : 'Load OLD + NEW timelines then click Analyze.';
        _dom.tableEmpty.style.display = '';
      }
      if (_dom.tableBody) _dom.tableBody.innerHTML = '';
      return;
    }
    if (_dom.tableEmpty) _dom.tableEmpty.style.display = 'none';

    const html = rows.map((ev, idx) => {
      const risk    = _riskOf(ev);
      const key     = _diffKey(ev);
      const status  = _s.statusMap.get(key) || 'none';
      const dt      = ev.diffType || 'NEW';
      const dur     = Number(ev.durationFrames || ev._lenFrames || 0);
      const score   = ev.matchScore != null ? Math.round(ev.matchScore * 100) : null;
      const isActive = idx === _s.selectedIdx;
      const typeLabel = dt === 'EXTENDED' ? 'EXT' : dt === 'UNCHANGED' ? 'UNC' : dt.slice(0, 3);
      const scoreHtml = score != null
        ? `<span class="cd2x-conf"><span class="cd2x-conf-bar" style="width:${score}%;background:${score>=75?'#4caf80':score>=50?'#e5c07b':'#e06c75'}"></span></span>`
        : `<span class="cd2x-conf-na">—</span>`;
      const statusClass = { none:'cd2x-st-none', ok:'cd2x-st-ok', skip:'cd2x-st-skip', query:'cd2x-st-query' }[status] || 'cd2x-st-none';
      const statusLabel = { none:'—', ok:'✓', skip:'⊘', query:'?' }[status] || '—';
      return `<tr class="cd2x-row${isActive?' cd2x-row-active':''}" data-idx="${idx}" style="--risk-color:${RISK_COLOR[risk]}">
        <td class="cd2x-td-risk"><span class="cd2x-risk-pip" title="${risk.toUpperCase()} RISK"></span></td>
        <td class="cd2x-td-type"><span class="cd2x-type-badge cd2x-type-${dt.toLowerCase()}">${typeLabel}</span></td>
        <td class="cd2x-td-reel" title="${esc?.(ev.reel||'')||ev.reel||''}">${esc?.(ev.reel||'')||ev.reel||'—'}</td>
        <td class="cd2x-td-clip" title="${esc?.(ev.clipName||'')||ev.clipName||''}">${esc?.(ev.clipName||'')||ev.clipName||'—'}</td>
        <td class="cd2x-td-src">${ev.srcIn||'—'}</td>
        <td class="cd2x-td-dur">${dur}fr</td>
        <td class="cd2x-td-conf">${scoreHtml}</td>
        <td class="cd2x-td-status"><button class="cd2x-status-btn ${statusClass}" data-idx="${idx}">${statusLabel}</button></td>
      </tr>`;
    }).join('');

    if (_dom.tableBody) _dom.tableBody.innerHTML = html;
    _dom.tableBody?.querySelectorAll('.cd2x-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.cd2x-status-btn')) return;
        _selectRow(parseInt(row.dataset.idx, 10));
      });
    });
    _dom.tableBody?.querySelectorAll('.cd2x-status-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); _cycleStatus(parseInt(btn.dataset.idx, 10)); });
    });
  }

  function _selectRow(idx) {
    const rows = _filteredDiff();
    if (idx < 0 || idx >= rows.length) return;
    _s.selectedIdx = idx;
    _dom.tableBody?.querySelectorAll('.cd2x-row').forEach(r => r.classList.toggle('cd2x-row-active', parseInt(r.dataset.idx, 10) === idx));
    _dom.tableBody?.querySelector('.cd2x-row-active')?.scrollIntoView({ block: 'nearest' });
    const ev = rows[idx];
    _renderInspector(ev);
    _tlZoomToEvent(ev);           // zoom timeline to event + move playhead
    _vcApplySelectionToVC(ev);    // seek video to event recIn
  }

  function _closeInspector() {
    _s.selectedIdx = -1;
    if (_dom.inspector) {
      _dom.inspector.classList.remove('cd2x-insp-open');
      delete _dom.inspector.dataset.dtype;
    }
    _dom.tableBody?.querySelectorAll('.cd2x-row').forEach(r => r.classList.remove('cd2x-row-active'));
    _schedTlRedraw();
  }

  function _cycleStatus(idx) {
    const rows = _filteredDiff();
    const ev   = rows[idx];
    if (!ev) return;
    const key   = _diffKey(ev);
    const cycle = ['none', 'ok', 'skip', 'query'];
    const curr  = _s.statusMap.get(key) || 'none';
    const next  = cycle[(cycle.indexOf(curr) + 1) % cycle.length];
    _s.statusMap.set(key, next);
    _persistStatus();
    _renderKpi();
    const btn = _dom.tableBody?.querySelector(`.cd2x-status-btn[data-idx="${idx}"]`);
    if (btn) {
      btn.className = `cd2x-status-btn ${{ none:'cd2x-st-none', ok:'cd2x-st-ok', skip:'cd2x-st-skip', query:'cd2x-st-query' }[next]}`;
      btn.textContent = { none:'—', ok:'✓', skip:'⊘', query:'?' }[next];
    }
    if (_s.selectedIdx === idx && _dom.insp.status) _dom.insp.status.value = next;
  }

  function _renderInspector(ev) {
    if (!_dom.inspector) return;
    _dom.inspector.classList.add('cd2x-insp-open');
    const key    = _diffKey(ev);
    const status = _s.statusMap.get(key) || 'none';
    const note   = _s.noteMap.get(key) || '';
    const score  = ev.matchScore != null ? Math.round(ev.matchScore * 100) : null;
    const dur    = Number(ev.durationFrames || ev._lenFrames || 0);
    const dt     = ev.diffType || 'NEW';
    _dom.inspector.dataset.dtype = dt;
    const _set = (el, val) => {
      if (!el) return;
      const empty = !val || val === '—';
      el.textContent = empty ? '—' : val;
      el.closest('.cd2x-insp-row')?.toggleAttribute('data-empty', empty);
    };
    if (_dom.insp.event)    _dom.insp.event.textContent    = `Event ${_s.selectedIdx + 1} / ${_filteredDiff().length}`;
    if (_dom.insp.type)     { _dom.insp.type.textContent = dt; _dom.insp.type.style.color = DIFF_COLOR[dt] || '#fff'; }
    _set(_dom.insp.reel,    ev.reel);
    _set(_dom.insp.clip,    ev.clipName);
    _set(_dom.insp.srcIn,   ev.srcIn);
    _set(_dom.insp.srcOut,  ev.srcOut);
    _set(_dom.insp.recIn,   ev.recIn);
    _set(_dom.insp.recOut,  ev.recOut);
    if (_dom.insp.duration) _dom.insp.duration.textContent = `${dur} fr`;
    if (_dom.insp.fps)      _dom.insp.fps.textContent      = `${ev.fps || _s.fps} fps`;
    if (_dom.insp.scoreBar) {
      const pct = score ?? 0;
      _dom.insp.scoreBar.style.width = `${pct}%`;
      _dom.insp.scoreBar.style.background = score == null ? '#252540' : pct >= 75 ? '#4caf80' : pct >= 50 ? '#e5c07b' : '#e06c75';
    }
    if (_dom.insp.scorePct) _dom.insp.scorePct.textContent = score != null ? `${score}%` : 'N/A';
    _set(_dom.insp.reason,  ev.matchReason || (dt === 'NEW' ? 'No match in OLD' : null));
    _set(_dom.insp.oldClip, ev.matchOldClipName);
    _set(_dom.insp.oldSrcIn, ev.matchOldSrcIn);
    _set(_dom.insp.oldRecIn, ev.matchOldRecIn);
    if (_dom.insp.status)   _dom.insp.status.value = status;
    if (_dom.insp.note)     _dom.insp.note.value   = note;
  }

  function _wireInspector() {
    _dom.insp?.close?.addEventListener('click', _closeInspector);
    _dom.insp?.status?.addEventListener('change', () => {
      if (_s.selectedIdx < 0) return;
      const ev  = _filteredDiff()[_s.selectedIdx];
      if (!ev) return;
      const key = _diffKey(ev);
      _s.statusMap.set(key, _dom.insp.status.value);
      _persistStatus(); _renderKpi();
      const next = _dom.insp.status.value;
      const btn  = _dom.tableBody?.querySelector(`.cd2x-status-btn[data-idx="${_s.selectedIdx}"]`);
      if (btn) {
        btn.className   = `cd2x-status-btn ${{ none:'cd2x-st-none', ok:'cd2x-st-ok', skip:'cd2x-st-skip', query:'cd2x-st-query' }[next]}`;
        btn.textContent = { none:'—', ok:'✓', skip:'⊘', query:'?' }[next];
      }
    });
    _dom.insp?.noteSave?.addEventListener('click', () => {
      if (_s.selectedIdx < 0) return;
      const ev = _filteredDiff()[_s.selectedIdx];
      if (!ev) return;
      _s.noteMap.set(_diffKey(ev), _dom.insp.note?.value || '');
      _persistStatus();
    });
    _dom.insp?.seekBtn?.addEventListener('click', () => {
      if (_s.selectedIdx < 0) return;
      const ev = _filteredDiff()[_s.selectedIdx];
      if (ev) _vcApplySelectionToVC(ev);
    });
  }

  // Filmstrip thumbnail extractor — fast & abortable
  async function _extractAllThumbs(which) {
    // Bump generation: any running extraction for this side will see a stale gen and bail
    const gen = ++_thumbGen[which];
    _thumbBusySides.delete(which); // allow restart even if previous run was stuck

    const url    = which === 'old' ? _vc.oldUrl : _vc.newUrl;
    const events = which === 'old' ? _s.oldEvents : _s.newEvents;
    if (!url || !events.length) { _schedTlRedraw(); return; }

    _thumbBusySides.add(which);
    for (const [k, bmp] of _thumbCache.entries()) {
      if (k.startsWith(which + ':')) { try { bmp?.close?.(); } catch {} _thumbCache.delete(k); }
    }

    // Pre-load any previously cached thumbnails from IDB for this video.
    // This means on a project reload we often skip most (or all) extraction.
    const _vidName = which === 'old' ? _vc.oldName : _vc.newName;
    const _vidSize = which === 'old' ? (_vc.oldSize || 0) : (_vc.newSize || 0);
    if (_vidName && _vidSize) {
      const idbHits = await _thumbIdbPreload(which, _vidName, _vidSize);
      if (gen !== _thumbGen[which]) return; // aborted while loading IDB
      if (idbHits) _schedTlRedraw();
    }

    // Count how many events still need extraction after IDB fill
    const _uncached = events.filter(ev => !_thumbCache.has(`${which}:${ev.recIn}`));
    if (!_uncached.length) {
      _thumbBusySides.delete(which);
      _schedTlRedraw();
      return;
    }

    try {
      const vid       = document.createElement('video');
      vid.src         = url;
      vid.muted       = true;
      vid.preload     = 'auto';
      vid.playsInline = true;

      await new Promise((res, rej) => {
        vid.onloadedmetadata = res;
        vid.onerror = () => rej(new Error('load failed'));
        setTimeout(rej, 12000);
      });

      if (gen !== _thumbGen[which]) { vid.src = ''; return; }

      const fps = _s.fps || 24;
      let startF = which === 'old' ? (_vc._oldStartF || 0) : (_vc._newStartF || 0);

      // Auto-detect startF: if TC offset input left at default 00:00:00:00 but
      // EDL timecodes start at 01:00:00:00+, the first probe would overshoot
      // vid.duration — anchor from the minimum recIn frame instead.
      if (events.length && vid.duration) {
        const _toF = tc => (tcToFrames ? tcToFrames(tc || '00:00:00:00', fps) : 0);
        if (Math.max(0, (_toF(events[0].recIn) - startF) / fps) > vid.duration) {
          let minF = Infinity;
          for (const e of events) { const f = _toF(e.recIn); if (f < minF) minF = f; }
          if (isFinite(minF)) startF = minF;
        }
      }

      // Build job list — skip events outside video duration
      const jobs = [];
      for (const ev of events) {
        const inF  = tcToFrames ? tcToFrames(ev.recIn  || '00:00:00:00', fps) : 0;
        const outF = tcToFrames ? tcToFrames(ev.recOut || '00:00:00:00', fps) : 0;
        const t    = Math.max(0, ((inF + outF) / 2 - startF) / fps);
        if (!vid.duration || t <= vid.duration) jobs.push({ ev, t });
      }

      // Seek helper: fastSeek (key-frame accurate, much faster) with 150ms fallback
      const _seek = t => new Promise(r => {
        let done = false;
        const finish = () => { if (done) return; done = true; vid.removeEventListener('seeked', finish); r(); };
        vid.addEventListener('seeked', finish);
        if (typeof vid.fastSeek === 'function') vid.fastSeek(t);
        else vid.currentTime = t;
        setTimeout(finish, 150);
      });

      // Offscreen canvas fallback for browsers where createImageBitmap(video) is unsupported
      let _fbCanvas = null, _fbCtx = null;
      const _captureBitmap = async () => {
        try {
          // Direct path: createImageBitmap from video with built-in resize — no canvas needed
          return await createImageBitmap(vid, { resizeWidth: 120, resizeHeight: 68, resizeQuality: 'low' });
        } catch {
          // Fallback: draw to offscreen canvas first
          if (!_fbCanvas) {
            _fbCanvas = document.createElement('canvas');
            _fbCanvas.width = 120; _fbCanvas.height = 68;
            _fbCtx = _fbCanvas.getContext('2d');
          }
          _fbCtx.drawImage(vid, 0, 0, 120, 68);
          return createImageBitmap(_fbCanvas);
        }
      };

      for (let i = 0; i < jobs.length; i++) {
        if (gen !== _thumbGen[which]) break; // aborted by a newer call

        // Skip if IDB preload already filled this slot
        if (_thumbCache.has(`${which}:${jobs[i].ev.recIn}`)) continue;

        await _seek(jobs[i].t);
        if (gen !== _thumbGen[which]) break;

        try {
          const bmp = await _captureBitmap();
          _thumbCache.set(`${which}:${jobs[i].ev.recIn}`, bmp);
          // Persist to IDB asynchronously so it's available on next project load
          if (_vidName && _vidSize) _thumbIdbPut(_vidName, _vidSize, jobs[i].ev.recIn, bmp);
        } catch {}

        // Progressive redraw every 4 frames + yield to keep UI responsive
        if (i % 4 === 3) { _schedTlRedraw(); await new Promise(r => setTimeout(r, 0)); }
      }

      vid.src = '';
    } catch {}

    if (gen === _thumbGen[which]) _thumbBusySides.delete(which);
    _schedTlRedraw();
  }

  // Content diff graph extractor
  async function _extractContentDiff() {
    if (_contentDiffBusy || !_vc.oldUrl || !_vc.newUrl || !_s.diff.length) return;
    _contentDiffBusy = true;
    _contentDiffMap.length = 0;

    try {
      const fps  = _s.fps || 24;
      const _f   = tc => (tcToFrames ? tcToFrames(tc, fps) : 0);
      const oldSF = _vc._oldStartF || 0;
      const newSF = _vc._newStartF || 0;

      const vOld = document.createElement('video');
      const vNew = document.createElement('video');
      vOld.src = _vc.oldUrl; vOld.muted = true; vOld.preload = 'auto';
      vNew.src = _vc.newUrl; vNew.muted = true; vNew.preload = 'auto';

      await Promise.all([
        new Promise((r, rej) => { vOld.onloadedmetadata = r; vOld.onerror = rej; setTimeout(rej, 12000); }),
        new Promise((r, rej) => { vNew.onloadedmetadata = r; vNew.onerror = rej; setTimeout(rej, 12000); }),
      ]);

      // Small comparison canvas (fast pixel diff)
      const CW = 40, CH = 22;
      const off = document.createElement('canvas');
      off.width = CW; off.height = CH;
      const ctx2 = off.getContext('2d', { willReadFrequently: true });

      const _seekV = (vid, t) => new Promise(r => {
        let done = false;
        const finish = () => { if (done) return; done = true; vid.removeEventListener('seeked', finish); r(); };
        vid.addEventListener('seeked', finish);
        vid.currentTime = Math.max(0, t);
        setTimeout(finish, 500);
      });

      let batchCount = 0;
      for (let i = 0; i < _s.diff.length; i++) {
        const ev   = _s.diff[i];
        const inF  = _f(ev.recIn);
        const outF = _f(ev.recOut);
        const dur  = Math.max(1, outF - inF);

        // Only CHANGED / EXTENDED have matching footage to compare pixel-by-pixel.
        // NEW and TRIMMED have no old counterpart, so skip them — the DIFF zone
        // already colours those events; injecting score=1 here just paints the
        // entire graph red and hides real pixel-diff signal.
        if (ev.diffType !== 'CHANGED' && ev.diffType !== 'EXTENDED') continue;

        // CHANGED / EXTENDED: pixel-compare at multiple sample points
        const nSamples = Math.max(1, Math.min(5, Math.floor(dur / fps)));
        for (let s = 0; s < nSamples; s++) {
          const f   = inF + Math.round(dur * (s + 0.5) / nSamples);
          const tOl = (f - oldSF) / fps;
          const tNw = (f - newSF) / fps;
          if (tOl < 0 || tNw < 0 || tOl > vOld.duration || tNw > vNew.duration) continue;

          await Promise.all([_seekV(vOld, tOl), _seekV(vNew, tNw)]);

          let score = 0;
          try {
            ctx2.drawImage(vOld, 0, 0, CW, CH);
            const d1 = ctx2.getImageData(0, 0, CW, CH).data;
            ctx2.drawImage(vNew, 0, 0, CW, CH);
            const d2 = ctx2.getImageData(0, 0, CW, CH).data;
            let sum = 0;
            for (let px = 0; px < d1.length; px += 4) {
              sum += Math.abs(d1[px] - d2[px]) + Math.abs(d1[px+1] - d2[px+1]) + Math.abs(d1[px+2] - d2[px+2]);
            }
            score = Math.min(1, sum / (d1.length / 4 * 3 * 255));
          } catch {}

          _contentDiffMap.push({ frame: f, score });
          batchCount++;
          if (batchCount % 10 === 0) {
            await new Promise(r => setTimeout(r, 0));
            _schedTlRedraw(); // partial update as we go
          }
        }
      }

      vOld.src = ''; vNew.src = '';
    } catch {}

    _contentDiffBusy = false;
    _schedTlRedraw();
  }

  // Timeline zoom helpers
  function _tlSeqRange() {
    const fps = _s.fps || 24;
    const _f  = tc => (tcToFrames ? tcToFrames(tc, fps) : 0);
    let seqIn = Infinity, seqOut = -Infinity;
    for (const ev of [..._s.oldEvents, ..._s.newEvents]) {
      const rIn = _f(ev.recIn), rOut = _f(ev.recOut);
      if (rIn < seqIn)  seqIn  = rIn;
      if (rOut > seqOut) seqOut = rOut;
    }
    return (isFinite(seqIn) && seqIn < seqOut) ? { seqIn, seqOut } : null;
  }

  // Zoom timeline to show a single event in detail with context padding
  function _tlZoomToEvent(ev) {
    const rng = _tlSeqRange(); if (!rng) return;
    const { seqIn, seqOut } = rng;
    const fps  = _s.fps || 24;
    const fIn  = tcToFrames ? tcToFrames(ev.recIn  || '00:00:00:00', fps) : seqIn;
    const fOut = tcToFrames ? tcToFrames(ev.recOut || '00:00:00:00', fps) : fIn + fps;
    const evSpan = Math.max(1, fOut - fIn);

    // Show event padded by 2× its own duration on each side (min 3 s)
    const pad = Math.max(fps * 3, evSpan * 2);
    let vs = fIn - pad;
    let ve = fOut + pad;

    // Clamp to sequence
    if (vs < seqIn)  vs = seqIn;
    if (ve > seqOut) ve = seqOut;

    // Enforce minimum visible span (4× event or 4 s)
    const minSpan = Math.max(evSpan * 4, fps * 4);
    if (ve - vs < minSpan) {
      const mid = (fIn + fOut) / 2;
      vs = mid - minSpan / 2;
      ve = mid + minSpan / 2;
      if (vs < seqIn)  { vs = seqIn;  ve = seqIn + minSpan; }
      if (ve > seqOut) { ve = seqOut; vs = seqOut - minSpan; }
    }

    _tlVisStart  = vs;
    _tlVisEnd    = ve;
    _tlPlayheadF = fIn;
    _schedTlRedraw();
    _drawPlayheadOverlay();
  }

  function _tlAutoZoom() {
    const rng = _tlSeqRange();
    if (!rng) return;
    const { seqIn, seqOut } = rng;
    const fps = _s.fps || 24;
    const _f  = tc => (tcToFrames ? tcToFrames(tc, fps) : 0);
    let chgIn = Infinity, chgOut = -Infinity;
    for (const ev of _s.diff) {
      if (ev.diffType === 'UNCHANGED') continue;
      const inF = _f(ev.recIn), outF = _f(ev.recOut);
      if (inF < chgIn)  chgIn  = inF;
      if (outF > chgOut) chgOut = outF;
    }
    if (!isFinite(chgIn)) return;
    const chgSpan = chgOut - chgIn;
    const seqSpan = seqOut - seqIn;
    // Only zoom if the changed region is compact enough to be worth zooming
    if (chgSpan / seqSpan > 0.78) { _tlVisStart = null; _tlVisEnd = null; _schedTlRedraw(); return; }
    const pad = Math.max(fps * 2, chgSpan * 0.15);
    _tlVisStart = Math.max(seqIn, chgIn - pad);
    _tlVisEnd   = Math.min(seqOut, chgOut + pad);
    _schedTlRedraw();
  }

  function _wireCanvasZoom() {
    const canvas = _dom.tlCanvas;
    if (!canvas) return;

    // Mouse-wheel: zoom around cursor (vertical) or pan (horizontal / shift+wheel)
    canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rng = _tlSeqRange();
      if (!rng) return;
      const { seqIn, seqOut } = rng;
      const visS    = _tlVisStart ?? seqIn;
      const visE    = _tlVisEnd   ?? seqOut;
      const visSpan = visE - visS;
      const seqSpan = seqOut - seqIn;

      // Horizontal swipe (trackpad) or Shift+wheel → pan
      const isPan = Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey;
      if (isPan) {
        if (_tlVisStart === null) return; // at full zoom, nothing to pan
        const rect    = canvas.getBoundingClientRect();
        const delta   = (e.deltaX || (e.shiftKey ? e.deltaY : 0)) / rect.width * visSpan;
        let newS = Math.max(seqIn, Math.min(seqOut - visSpan, visS + delta));
        _tlVisStart = newS; _tlVisEnd = newS + visSpan;
        _tlPanOccurred = true;
        _schedTlRedraw();
        return;
      }

      // Vertical scroll or Ctrl+wheel (pinch gesture) → zoom around cursor
      const rect    = canvas.getBoundingClientRect();
      const xPct    = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const zoomPt  = visS + xPct * visSpan;
      const fps     = _s.fps || 24;
      const factor  = e.deltaY > 0 ? 1.3 : (1 / 1.3);
      const minSpan = fps * 8;
      let newSpan   = Math.max(minSpan, Math.min(seqSpan, visSpan * factor));
      let newS = zoomPt - xPct * newSpan;
      let newE = newS + newSpan;
      if (newS < seqIn)  { newS = seqIn;  newE = seqIn  + newSpan; }
      if (newE > seqOut) { newE = seqOut; newS = seqOut - newSpan; }
      if (newS < seqIn)    newS = seqIn;
      if (newSpan >= seqSpan * 0.98) { _tlVisStart = null; _tlVisEnd = null; }
      else                            { _tlVisStart = newS; _tlVisEnd = newE; }
      canvas.style.cursor = _tlVisStart !== null ? 'grab' : 'crosshair';
      _schedTlRedraw();
    }, { passive: false });

    // Drag to pan
    let _dragX = null, _dragVisS = null, _dragMoved = false, _wasDrag = false;
    canvas.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      const rng = _tlSeqRange();
      if (!rng) return;
      _dragX = e.clientX;
      _dragVisS = _tlVisStart ?? rng.seqIn;
      _dragMoved = false; _wasDrag = false;
      if (_tlVisStart !== null) canvas.style.cursor = 'grabbing';
    });
    canvas.addEventListener('mousemove', e => {
      if (_dragX === null || !e.buttons) return;
      const rng = _tlSeqRange();
      if (!rng) return;
      const { seqIn, seqOut } = rng;
      const dx = e.clientX - _dragX;
      if (Math.abs(dx) > 3) { _dragMoved = true; _wasDrag = true; }
      if (!_dragMoved || _tlVisStart === null) return;
      const rect    = canvas.getBoundingClientRect();
      const visS    = _tlVisStart;
      const visE    = _tlVisEnd;
      const visSpan = visE - visS;
      const delta   = -(dx / rect.width) * visSpan;
      let newS = Math.max(seqIn, Math.min(seqOut - visSpan, _dragVisS + delta));
      _tlVisStart = newS;
      _tlVisEnd   = newS + visSpan;
      _schedTlRedraw();
    });
    const _endDrag = () => {
      if (_dragMoved && _tlVisStart !== null) {
        _tlPanOccurred = true;
        canvas.style.cursor = 'grab';
      }
      _dragX = null; _dragVisS = null; _dragMoved = false;
    };
    canvas.addEventListener('mouseup',    _endDrag);
    canvas.addEventListener('mouseleave', _endDrag);
    document.addEventListener('mouseup', _endDrag);

    // Hover cursor: pointer when over a clickable event slot
    canvas.addEventListener('mousemove', e => {
      if (_dragX !== null) return; // dragging, skip
      if (_tlVisStart !== null) return; // grab cursor managed elsewhere
      const rect = canvas.getBoundingClientRect();
      const cx   = e.clientX - rect.left;
      const fps  = _s.fps || 24;
      const _f   = tc => (tcToFrames ? tcToFrames(tc, fps) : 0);
      let hit = false;
      if (_tlSmartMode) {
        for (let i = 0; i < _smartSlots.length; i++) {
          if (cx >= _smartSlotX[i] && cx < _smartSlotX[i] + _smartSlotW[i]) { hit = true; break; }
        }
      } else {
        const rng = _tlSeqRange();
        if (rng) {
          const visS = _tlVisStart ?? rng.seqIn, visE = _tlVisEnd ?? rng.seqOut;
          const clickF = visS + (cx / rect.width) * Math.max(1, visE - visS);
          for (const ev of _filteredDiff()) {
            const nin = _f(ev.recIn), nout = _f(ev.recOut);
            if (clickF >= nin && clickF <= nout) { hit = true; break; }
          }
        }
      }
      canvas.style.cursor = hit ? 'pointer' : 'crosshair';
    });

    // Click-to-select event
    canvas.addEventListener('click', e => {
      if (_wasDrag) { _wasDrag = false; return; }
      const rect = canvas.getBoundingClientRect();
      const cx   = e.clientX - rect.left;
      const fps  = _s.fps || 24;
      const _f   = tc => (tcToFrames ? tcToFrames(tc, fps) : 0);
      const filtered = _filteredDiff();
      if (!filtered.length) return;

      if (_tlSmartMode) {
        // Smart mode: hit-test slot X ranges
        for (let i = 0; i < _smartSlots.length; i++) {
          if (cx >= _smartSlotX[i] && cx < _smartSlotX[i] + _smartSlotW[i]) {
            const { ev } = _smartSlots[i];
            const fi = filtered.findIndex(fe => fe === ev);
            if (fi >= 0) _selectRow(fi);
            return;
          }
        }
        // No exact hit — find nearest slot center
        let bestI = -1, bestD = Infinity;
        for (let i = 0; i < _smartSlots.length; i++) {
          const center = _smartSlotX[i] + _smartSlotW[i] / 2;
          const d = Math.abs(cx - center);
          if (d < bestD) { bestD = d; bestI = i; }
        }
        if (bestI >= 0) {
          const fi = filtered.findIndex(fe => fe === _smartSlots[bestI].ev);
          if (fi >= 0) _selectRow(fi);
        }
      } else {
        // Sequence mode: convert click X → frame, find containing event
        const rng = _tlSeqRange(); if (!rng) return;
        const { seqIn, seqOut } = rng;
        const visS    = _tlVisStart ?? seqIn;
        const visE    = _tlVisEnd   ?? seqOut;
        const visSpan = Math.max(1, visE - visS);
        const clickF  = visS + (cx / rect.width) * visSpan;

        // Prefer exact containment on NEW track, then OLD track, then nearest
        let bestIdx = -1, bestDist = Infinity;
        for (let i = 0; i < filtered.length; i++) {
          const ev  = filtered[i];
          const nin = _f(ev.recIn), nout = _f(ev.recOut);
          if (clickF >= nin && clickF <= nout) { bestIdx = i; bestDist = 0; break; }
          const d = Math.min(Math.abs(clickF - nin), Math.abs(clickF - nout));
          if (d < bestDist) { bestDist = d; bestIdx = i; }
        }
        if (bestDist > 0) {
          // also check OLD track — exact hit wins
          for (let i = 0; i < filtered.length; i++) {
            const ev = filtered[i];
            if (!ev.matchOldRecIn) continue;
            const oin = _f(ev.matchOldRecIn);
            const oout = _f(ev.matchOldRecOut || ev.matchOldRecIn);
            if (clickF >= oin && clickF <= oout) { bestIdx = i; break; }
          }
        }
        if (bestIdx >= 0) _selectRow(bestIdx);
      }
    });

    // Double-click: reset zoom to full sequence
    canvas.addEventListener('dblclick', () => {
      _tlVisStart = null; _tlVisEnd = null;
      _tlPanOccurred = true;
      canvas.style.cursor = 'crosshair';
      _schedTlRedraw();
    });
  }

  // ── Playhead overlay (separate canvas, pointer-events:none) ─────────────────
  function _drawPlayheadOverlay() {
    const canvas = _dom.tlOverlay;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W   = canvas.clientWidth || 800;
    const H   = 280;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width  = W * dpr;
      canvas.height = H * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    if (_tlPlayheadF < 0 && _tlPlayheadOldF < 0) return;
    const rng = _tlSeqRange();
    if (!rng) return;
    const { seqIn, seqOut } = rng;
    const fps = _s.fps || 24;

    const _toTcStr = (f) => {
      const t  = Math.max(0, f / fps);
      const hh = Math.floor(t / 3600);
      const mm = Math.floor((t % 3600) / 60);
      const ss = Math.floor(t % 60);
      const fr = Math.floor(f % fps);
      return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}:${String(fr).padStart(2,'0')}`;
    };

    // Resolve playhead frame — falls back to seqIn+elapsed when startF is uncalibrated (=0)
    const _resolveFrame = (vid, startF) => {
      if (!vid || vid.readyState < 1) return -1;
      const elapsed = Math.round(vid.currentTime * fps);
      const raw = elapsed + (startF || 0);
      if (raw >= seqIn && raw <= seqOut + fps * 120) return raw;
      return seqIn + elapsed;
    };
    const v = _dom.vc;
    const oldPlayF = (v && v.vidOld) ? _resolveFrame(v.vidOld, _vc._oldStartF) : _tlPlayheadOldF;
    const newPlayF = (v && v.vidNew) ? _resolveFrame(v.vidNew, _vc._newStartF) : _tlPlayheadF;

    // Shared pixel-based draw used by both modes
    const _drawHeadPx = (px, y1, y2, color, tcLabel, tcY) => {
      ctx.save();
      ctx.shadowColor = color; ctx.shadowBlur = 6;
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(px, y1); ctx.lineTo(px, y2); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(px - 5, y1 - 6); ctx.lineTo(px + 5, y1 - 6); ctx.lineTo(px, y1); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(px - 5, y2 + 6); ctx.lineTo(px + 5, y2 + 6); ctx.lineTo(px, y2); ctx.closePath(); ctx.fill();
      if (tcLabel) {
        ctx.font = 'bold 8px monospace';
        const tw = ctx.measureText(tcLabel).width + 6;
        const lx = (px + tw + 8 < W) ? px + 4 : px - tw - 2;
        ctx.fillStyle = 'rgba(6,6,18,0.88)';
        ctx.fillRect(lx - 1, tcY, tw + 2, 12);
        ctx.fillStyle = color; ctx.textBaseline = 'top';
        ctx.fillText(tcLabel, lx + 2, tcY + 1);
      }
      ctx.restore();
    };

    // ── Smart mode: slot-aligned layout ──────────────────────────────────────
    if (_tlSmartMode) {
      if (!_smartSlots.length) return;
      // Constants must match _drawTimelineSmart()
      const RULER_H = 10;
      const OLD_Y = 12, OLD_H = 92;
      const CONN_Y = 106, CONN_H = 44;
      const NEW_Y = 152, NEW_H = 92;
      const _f = tc => (tcToFrames ? tcToFrames(tc, fps) : 0);

      // NEW playhead (amber) — find which slot's recIn/recOut contains newPlayF
      if (newPlayF >= 0) {
        for (let i = 0; i < _smartSlots.length; i++) {
          const { ev } = _smartSlots[i];
          const slotIn  = _f(ev.recIn);
          const slotOut = Math.max(slotIn + 1, _f(ev.recOut));
          if (newPlayF < slotIn || newPlayF > slotOut) continue;
          const ratio = Math.max(0, Math.min(1, (newPlayF - slotIn) / (slotOut - slotIn)));
          const px = Math.round(_smartSlotX[i] + ratio * _smartSlotW[i]);
          _drawHeadPx(px, CONN_Y, NEW_Y + NEW_H, '#f5c542', _toTcStr(newPlayF), CONN_Y + 2);
          break;
        }
      }

      // OLD playhead (cyan) — find which slot's matchOldRecIn/Out contains oldPlayF
      if (oldPlayF >= 0) {
        for (let i = 0; i < _smartSlots.length; i++) {
          const { ev } = _smartSlots[i];
          if (!ev.matchOldRecIn) continue;
          const slotIn  = _f(ev.matchOldRecIn);
          const slotOut = Math.max(slotIn + 1, _f(ev.matchOldRecOut || ev.matchOldRecIn));
          if (oldPlayF < slotIn || oldPlayF > slotOut) continue;
          const ratio = Math.max(0, Math.min(1, (oldPlayF - slotIn) / (slotOut - slotIn)));
          const px = Math.round(_smartSlotX[i] + ratio * _smartSlotW[i]);
          _drawHeadPx(px, RULER_H, OLD_Y + OLD_H, '#72e6ff', _toTcStr(oldPlayF), OLD_Y + 2);
          break;
        }
      }
      return;
    }

    // ── Sequence mode: position-based layout ─────────────────────────────────
    const visStart = _tlVisStart ?? seqIn;
    const visEnd   = _tlVisEnd   ?? seqOut;
    const visSpan  = Math.max(1, visEnd - visStart);

    // Layout constants — must match _drawTimeline()
    const RULER_H = 12;
    const OLD_Y   = 14, OLD_H  = 90;
    const CONN_Y  = 105;
    const NEW_Y   = 158, NEW_H  = 90;

    const _drawHead = (frameF, y1, y2, color, tcLabel, tcY) => {
      if (frameF < visStart || frameF > visEnd) return;
      _drawHeadPx(Math.round(((frameF - visStart) / visSpan) * (W - 1)), y1, y2, color, tcLabel, tcY);
    };

    if (oldPlayF >= 0) _drawHead(oldPlayF, RULER_H, OLD_Y + OLD_H, '#72e6ff', _toTcStr(oldPlayF), OLD_Y + 2);
    if (newPlayF >= 0) _drawHead(newPlayF, CONN_Y,  NEW_Y + NEW_H, '#f5c542', _toTcStr(newPlayF), CONN_Y + 2);
  }

  // Auto-pan visible window to keep playhead in view (sequence mode only, only when zoomed)
  function _tlAutoTrack() {
    if (_tlSmartMode) return; // Smart layout is slot-based — no sequence-range panning
    const rng = _tlSeqRange(); if (!rng) return;
    const { seqIn, seqOut } = rng;
    const seqSpan  = seqOut - seqIn;
    const visStart = _tlVisStart ?? seqIn;
    const visEnd   = _tlVisEnd   ?? seqOut;
    const visSpan  = visEnd - visStart;
    if (visSpan >= seqSpan * 0.98) return; // not zoomed — full sequence already visible

    // Use NEW playhead as primary tracking target; fall back to OLD
    const playF = (_tlPlayheadF > 0) ? _tlPlayheadF
                : (_tlPlayheadOldF > 0) ? _tlPlayheadOldF : -1;
    if (playF < 0) return;

    // Hard jump: playhead completely outside viewport — center on it immediately
    if (playF < visStart || playF > visEnd) {
      const half = visSpan / 2;
      let ns = playF - half;
      let ne = playF + half;
      if (ns < seqIn) { ns = seqIn; ne = Math.min(seqOut, ns + visSpan); }
      if (ne > seqOut) { ne = seqOut; ns = Math.max(seqIn, ne - visSpan); }
      _tlVisStart = ns;
      _tlVisEnd   = ne;
      _schedTlRedraw();
      return;
    }

    // Soft pan: approaching within 15% of either edge — scroll to keep ahead
    const lead = visSpan * 0.15;
    let changed = false;
    if (playF > visEnd - lead) {
      let ns = playF - visSpan * 0.15;
      let ne = ns + visSpan;
      if (ne > seqOut) { ne = seqOut; ns = ne - visSpan; }
      _tlVisStart = Math.max(seqIn, ns);
      _tlVisEnd   = _tlVisStart + visSpan;
      changed = true;
    } else if (playF < visStart + lead) {
      let ns = playF - visSpan * 0.85;
      let ne = ns + visSpan;
      if (ns < seqIn) { ns = seqIn; ne = ns + visSpan; }
      _tlVisStart = ns;
      _tlVisEnd   = Math.min(seqOut, ne);
      changed = true;
    }
    if (changed) _schedTlRedraw();
  }

  // Timeline canvas
  function _schedTlRedraw() {
    if (_tlRaf) cancelAnimationFrame(_tlRaf);
    _tlRaf = requestAnimationFrame(_drawTimeline);
  }

  // ── Smart aligned-pair timeline ───────────────────────────────────────────
  // Shows ONLY diff events (changed/new/trimmed/extended) — each as a paired
  // column where OLD clip sits directly above its NEW counterpart. Unchanged
  // clips are intentionally excluded to keep the view focused and uncluttered.
  function _drawTimelineSmart() {
    const canvas = _dom.tlCanvas;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W   = canvas.clientWidth || 800;
    const H   = 280;
    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width = W * dpr; canvas.height = H * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#07070e'; ctx.fillRect(0, 0, W, H);

    const fps = _s.fps || 24;
    const _f  = tc => (tcToFrames ? tcToFrames(tc, fps) : 0);

    const RULER_Y  = 0,   RULER_H  = 10;
    const OLD_Y    = 12,  OLD_H    = 92;
    const CONN_Y   = 106, CONN_H   = 44;
    const NEW_Y    = 152, NEW_H    = 92;
    const SUMM_Y   = 246, SUMM_H   = 4;
    const THUMB_PAD = 2;
    const SLOT_GAP  = 3;
    const MIN_SLOT  = 8;   // minimum px width per slot

    if (!_s.diff.length) {
      ctx.fillStyle = '#252540'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
      ctx.fillText(_s.oldEvents.length ? 'Press Analyze to compare' : 'Load OLD + NEW timelines', W / 2, H / 2 + 3);
      _drawPlayheadOverlay(); return;
    }

    const _selEv = _s.selectedIdx >= 0 ? (_filteredDiff()[_s.selectedIdx] ?? null) : null;

    // Build slots from DIFF EVENTS ONLY — unchanged clips are excluded (they are noise in a diff view)
    const sortedDiff = [..._s.diff].sort((a, b) => _f(a.recIn) - _f(b.recIn));
    const slots = sortedDiff.map(ev => {
      const newDur = Math.max(1, _f(ev.recOut) - _f(ev.recIn));
      const oldDur = (ev.matchOldRecIn && ev.matchOldRecOut)
        ? Math.max(1, _f(ev.matchOldRecOut) - _f(ev.matchOldRecIn)) : 0;
      return { ev, oldDur, newDur, durF: Math.max(newDur, oldDur, 1) };
    });

    // Compute pixel layout
    const totalFrames = slots.reduce((s, sl) => s + sl.durF, 0) || 1;
    const usableW     = W - (slots.length - 1) * SLOT_GAP;
    _smartSlots = slots;
    _smartSlotX = [];
    _smartSlotW = [];
    let cursor = 0;
    for (const slot of slots) {
      const pw = Math.max(MIN_SLOT, Math.round((slot.durF / totalFrames) * usableW));
      _smartSlotX.push(cursor);
      _smartSlotW.push(pw);
      cursor += pw + SLOT_GAP;
    }

    const _drawThumbFit = (bmp, rx, ry, rw, rh) => {
      if (!bmp || rw < 2 || rh < 2) return;
      const bAR = bmp.width / bmp.height, rAR = rw / rh;
      let bsx, bsy, bsw, bsh;
      if (rAR > bAR) { bsw = bmp.width;  bsh = bmp.width / rAR;   bsx = 0; bsy = (bmp.height - bsh) / 2; }
      else           { bsh = bmp.height; bsw = bmp.height * rAR; bsy = 0; bsx = (bmp.width  - bsw) / 2; }
      ctx.drawImage(bmp, bsx, bsy, bsw, bsh, rx, ry, rw, rh);
    };

    // ── Ruler — colored tick per event ───────────────────────────────────────
    ctx.fillStyle = '#080810'; ctx.fillRect(0, RULER_Y, W, RULER_H);
    for (let i = 0; i < slots.length; i++) {
      const { ev } = slots[i];
      const sx = _smartSlotX[i], sw = _smartSlotW[i];
      const col = DIFF_COLOR[ev.diffType] || '#6060a0';
      ctx.fillStyle = _hexRgba(col, 0.5);
      ctx.fillRect(sx, RULER_H - 2, sw, 2);
      if (sw >= 16) {
        ctx.font = '6px monospace'; ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(140,140,180,0.4)';
        ctx.fillText(String(i + 1), sx + sw / 2, RULER_Y + 7);
      }
    }
    ctx.font = '6px monospace'; ctx.fillStyle = 'rgba(100,100,160,0.55)'; ctx.textAlign = 'right';
    ctx.fillText(`${slots.length} changes · Smart Compare · click to select`, W - 4, RULER_Y + 7);
    ctx.textAlign = 'left';

    // ── OLD track ────────────────────────────────────────────────────────────
    ctx.fillStyle = '#080810'; ctx.fillRect(0, OLD_Y, W, OLD_H);

    for (let i = 0; i < slots.length; i++) {
      const { ev, oldDur, newDur, durF } = slots[i];
      const sx    = _smartSlotX[i], sw = _smartSlotW[i];
      const col   = DIFF_COLOR[ev.diffType] || '#6060a0';
      const isSel = ev === _selEv;
      const th    = OLD_H - 2 * THUMB_PAD;

      if (!ev.matchOldRecIn) {
        // NEW-only clip — no OLD counterpart
        ctx.fillStyle = 'rgba(20,20,40,0.6)'; ctx.fillRect(sx, OLD_Y + THUMB_PAD, sw, th);
        ctx.strokeStyle = 'rgba(114,230,255,0.15)'; ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        ctx.strokeRect(sx + 0.5, OLD_Y + THUMB_PAD + 0.5, sw - 1, th - 1);
        ctx.setLineDash([]);
        if (sw >= 20) {
          ctx.font = '7px monospace'; ctx.fillStyle = 'rgba(114,230,255,0.3)'; ctx.textAlign = 'center';
          ctx.fillText('—', sx + sw / 2, OLD_Y + OLD_H / 2 + 3);
          ctx.textAlign = 'left';
        }
      } else {
        const bmp = _thumbCache.get(`old:${ev.matchOldRecIn}`);
        if (bmp && sw >= 4) {
          _drawThumbFit(bmp, sx, OLD_Y + THUMB_PAD, sw, th);
          ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(sx, OLD_Y + THUMB_PAD, sw, th);
        } else {
          ctx.fillStyle = 'rgba(70,70,120,0.4)'; ctx.fillRect(sx, OLD_Y + THUMB_PAD, sw, th);
        }
        // Diff accent: 2px top bar
        ctx.fillStyle = _hexRgba(col, 0.7); ctx.fillRect(sx, OLD_Y + THUMB_PAD, sw, 2);

        // TC label (show when wide enough)
        if (sw >= 28) {
          const sec = Math.floor(_f(ev.matchOldRecIn) / fps);
          ctx.font = '7px monospace'; ctx.fillStyle = 'rgba(180,180,200,0.6)'; ctx.textAlign = 'left';
          ctx.fillText(`${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`, sx + 3, OLD_Y + OLD_H - 5);
        }
      }

      // Selected outline
      if (isSel) {
        ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 8;
        ctx.strokeStyle = col; ctx.lineWidth = 1.5;
        ctx.strokeRect(sx + 0.5, OLD_Y + 0.5, sw - 1, OLD_H - 1);
        ctx.restore();
      }

      // Slot divider
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, OLD_Y); ctx.lineTo(sx, OLD_Y + OLD_H); ctx.stroke();
    }

    // Track label
    ctx.font = 'bold 8px monospace'; ctx.fillStyle = 'rgba(120,120,160,0.4)'; ctx.textAlign = 'left';
    ctx.fillText('OLD', 3, OLD_Y + OLD_H / 2 + 3);
    ctx.strokeStyle = '#0c0c18'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, OLD_Y + OLD_H); ctx.lineTo(W, OLD_Y + OLD_H); ctx.stroke();

    // ── Connector zone — compact, clean color bands ───────────────────────────
    ctx.fillStyle = '#050508'; ctx.fillRect(0, CONN_Y, W, CONN_H);

    for (let i = 0; i < slots.length; i++) {
      const { ev, oldDur, newDur, durF } = slots[i];
      const sx    = _smartSlotX[i], sw = _smartSlotW[i];
      const col   = DIFF_COLOR[ev.diffType] || '#6060a0';
      const isSel = ev === _selEv;
      const alpha = isSel ? 0.60 : 0.22;

      ctx.fillStyle = _hexRgba(col, alpha);
      ctx.fillRect(sx, CONN_Y, sw, CONN_H);

      // Top/bottom 1px accent line
      ctx.fillStyle = _hexRgba(col, isSel ? 0.9 : 0.5);
      ctx.fillRect(sx, CONN_Y,              sw, 1);
      ctx.fillRect(sx, CONN_Y + CONN_H - 1, sw, 1);

      // Labels
      const midY = CONN_Y + CONN_H / 2;
      ctx.textAlign = 'center';

      if (sw >= 24) {
        ctx.font = 'bold 7px monospace'; ctx.fillStyle = _hexRgba(col, 0.9);
        ctx.fillText(ev.diffType, sx + sw / 2, midY - (sw >= 34 ? 7 : 3));
      }

      if (sw >= 34) {
        const deltF = newDur - oldDur;
        if (deltF !== 0) {
          const sign = deltF > 0 ? '+' : '';
          ctx.font = '7px monospace';
          ctx.fillStyle = deltF > 0 ? 'rgba(76,175,128,0.9)' : 'rgba(224,108,117,0.9)';
          ctx.fillText(`${sign}${(deltF / fps).toFixed(1)}s`, sx + sw / 2, midY + 6);
        }
      }
      ctx.textAlign = 'left';

      // Slot divider
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, CONN_Y); ctx.lineTo(sx, CONN_Y + CONN_H); ctx.stroke();
    }

    ctx.strokeStyle = '#0c0c18'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, CONN_Y);          ctx.lineTo(W, CONN_Y);          ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, CONN_Y + CONN_H); ctx.lineTo(W, CONN_Y + CONN_H); ctx.stroke();

    // ── NEW track ────────────────────────────────────────────────────────────
    ctx.fillStyle = '#080810'; ctx.fillRect(0, NEW_Y, W, NEW_H);

    for (let i = 0; i < slots.length; i++) {
      const { ev, oldDur, newDur, durF } = slots[i];
      const sx    = _smartSlotX[i], sw = _smartSlotW[i];
      const col   = DIFF_COLOR[ev.diffType] || '#6060a0';
      const isSel = ev === _selEv;
      const th    = NEW_H - 2 * THUMB_PAD;

      // Scale NEW clip width proportional to actual duration vs slot
      const newPxW = oldDur > 0 ? Math.max(4, Math.round((newDur / durF) * sw)) : sw;
      const bmp    = _thumbCache.get(`new:${ev.recIn}`);

      if (bmp && newPxW >= 4) {
        _drawThumbFit(bmp, sx, NEW_Y + THUMB_PAD, newPxW, th);
        ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(sx, NEW_Y + THUMB_PAD, newPxW, th);
      } else {
        ctx.fillStyle = 'rgba(50,50,90,0.45)'; ctx.fillRect(sx, NEW_Y + THUMB_PAD, newPxW, th);
      }

      // Bottom color bar + top 2px accent
      ctx.fillStyle = _hexRgba(col, 0.8); ctx.fillRect(sx, NEW_Y + NEW_H - 4, newPxW, 3);
      ctx.fillStyle = _hexRgba(col, 0.5); ctx.fillRect(sx, NEW_Y + THUMB_PAD, newPxW, 2);

      // Trimmed space (if NEW is shorter than OLD)
      if (newPxW < sw) {
        ctx.fillStyle = 'rgba(12,12,24,0.7)'; ctx.fillRect(sx + newPxW, NEW_Y + THUMB_PAD, sw - newPxW, th);
        ctx.setLineDash([2, 3]); ctx.strokeStyle = _hexRgba(col, 0.25); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(sx + newPxW, NEW_Y); ctx.lineTo(sx + newPxW, NEW_Y + NEW_H); ctx.stroke();
        ctx.setLineDash([]);
      }

      // TC label
      if (newPxW >= 28) {
        const sec = Math.floor(_f(ev.recIn) / fps);
        ctx.font = '7px monospace'; ctx.fillStyle = 'rgba(180,180,200,0.6)'; ctx.textAlign = 'left';
        ctx.fillText(`${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`, sx + 3, NEW_Y + NEW_H - 5);
      }

      // Selected outline
      if (isSel) {
        ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = 8;
        ctx.strokeStyle = col; ctx.lineWidth = 1.5;
        ctx.strokeRect(sx + 0.5, NEW_Y + 0.5, newPxW - 1, NEW_H - 1);
        ctx.restore();
      }

      // Slot divider
      ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(sx, NEW_Y); ctx.lineTo(sx, NEW_Y + NEW_H); ctx.stroke();
    }

    ctx.font = 'bold 8px monospace'; ctx.fillStyle = 'rgba(120,120,160,0.4)'; ctx.textAlign = 'left';
    ctx.fillText('NEW', 3, NEW_Y + NEW_H / 2 + 3);
    ctx.strokeStyle = '#0c0c18'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, NEW_Y + NEW_H); ctx.lineTo(W, NEW_Y + NEW_H); ctx.stroke();

    // ── Summary strip ─────────────────────────────────────────────────────────
    ctx.fillStyle = '#060609'; ctx.fillRect(0, SUMM_Y, W, SUMM_H);
    for (let i = 0; i < slots.length; i++) {
      const sx  = _smartSlotX[i], sw = _smartSlotW[i];
      const col = DIFF_COLOR[slots[i].ev.diffType];
      if (!col) continue;
      ctx.fillStyle = _hexRgba(col, 0.75);
      ctx.fillRect(sx, SUMM_Y, sw, SUMM_H);
    }

    _drawPlayheadOverlay();
  }

  function _drawTimeline() {
    _tlRaf = null;
    if (_tlSmartMode) { _drawTimelineSmart(); return; }
    const canvas = _dom.tlCanvas;
    if (!canvas) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const W   = canvas.clientWidth || 800;
    const H   = 280;

    if (canvas.width !== W * dpr || canvas.height !== H * dpr) {
      canvas.width  = W * dpr;
      canvas.height = H * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#06060f';
    ctx.fillRect(0, 0, W, H);

    const fps = _s.fps || 24;
    const _f  = tc => (tcToFrames ? tcToFrames(tc, fps) : 0);

    // Resolve selected index: _s.selectedIdx is into _filteredDiff(), but the
    // draw loops iterate _s.diff (full array). Map once here so every comparison
    // below uses the correct full-array position.
    const _selEv      = _s.selectedIdx >= 0 ? (_filteredDiff()[_s.selectedIdx] ?? null) : null;
    const _selFullIdx = _selEv ? _s.diff.indexOf(_selEv) : -1;

    // Sequence bounds
    const _rng = _tlSeqRange();
    if (!_rng) {
      ctx.fillStyle = '#252540'; ctx.font = '9px monospace'; ctx.textAlign = 'center';
      ctx.fillText('Load OLD + NEW timelines to view coverage', W / 2, H / 2 + 3);
      return;
    }
    const { seqIn, seqOut } = _rng;
    const seqSpan  = seqOut - seqIn;
    // Visible window (zoom / pan applied)
    const visStart = _tlVisStart ?? seqIn;
    const visEnd   = _tlVisEnd   ?? seqOut;
    const visSpan  = visEnd - visStart;
    const xOf      = f => Math.round(((f - visStart) / visSpan) * (W - 1));
    const totalSec = visSpan / fps;

    // Helper: draw a thumbnail bitmap fitted (cover) into a rect
    const _drawThumb = (bmp, rx, ry, rw, rh) => {
      if (!bmp || rw < 2 || rh < 2) return;
      const bAR = bmp.width / bmp.height;
      const rAR = rw / rh;
      let sx, sy, sw, sh;
      if (rAR > bAR) { sw = bmp.width;  sh = bmp.width  / rAR; sx = 0; sy = (bmp.height - sh) / 2; }
      else           { sh = bmp.height; sw = bmp.height * rAR;  sy = 0; sx = (bmp.width  - sw) / 2; }
      ctx.drawImage(bmp, sx, sy, sw, sh, rx, ry, rw, rh);
    };

    // Layout zones
    const RULER_Y  = 0,   RULER_H  = 12;
    const OLD_Y    = 14,  OLD_H    = 90;  // ends at 104
    const CONN_Y   = 105, CONN_H   = 52;  // connector zone (OLD→NEW bridges); ends at 157
    const NEW_Y    = 158, NEW_H    = 90;  // ends at 248
    const SUMM_Y   = 250, SUMM_H   = 5;  // summary strip; ends at 255
    const CDIFF_Y  = 257, CDIFF_H  = 18; // content diff graph; ends at 275
    const THUMB_PAD = 2;  // pixels inside track for thumbnail

    // ── TC Ruler ─────────────────────────────────────────────────────────────
    ctx.fillStyle = '#0b0b18';
    ctx.fillRect(0, RULER_Y, W, RULER_H);

    let tickSec = 5;
    if      (totalSec > 600) tickSec = 120;
    else if (totalSec > 300) tickSec = 60;
    else if (totalSec > 120) tickSec = 30;
    else if (totalSec > 60)  tickSec = 15;
    else if (totalSec > 30)  tickSec = 10;

    ctx.font = '7px monospace'; ctx.textAlign = 'left';

    const startMajor = Math.ceil((visStart / fps) / tickSec) * tickSec;
    for (let s = startMajor; s * fps < visEnd; s += tickSec) {
      const x   = xOf(s * fps);
      const m   = Math.floor(s / 60);
      const ss  = Math.floor(s % 60);
      const lbl = `${m}:${String(ss).padStart(2, '0')}`;
      ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, RULER_H - 3); ctx.lineTo(x, RULER_H); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.03)';
      ctx.beginPath(); ctx.moveTo(x, RULER_H); ctx.lineTo(x, CDIFF_Y + CDIFF_H); ctx.stroke();
      ctx.fillStyle = '#484870';
      ctx.fillText(lbl, Math.min(x + 2, W - 26), RULER_Y + 8);
    }
    const minorSec   = tickSec / 5;
    const startMinor = Math.ceil((visStart / fps) / minorSec) * minorSec;
    ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
    for (let s = startMinor; s * fps < visEnd; s += minorSec) {
      if (Math.abs(s % tickSec) < 0.001) continue;
      const x = xOf(s * fps);
      ctx.beginPath(); ctx.moveTo(x, RULER_H - 2); ctx.lineTo(x, RULER_H); ctx.stroke();
    }
    ctx.strokeStyle = '#181828'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, RULER_H); ctx.lineTo(W, RULER_H); ctx.stroke();

    // Zoom level badge (top-right of ruler when zoomed in)
    const _zoomRatio = seqSpan / visSpan;
    if (_zoomRatio > 1.05) {
      const zLabel = `${_zoomRatio.toFixed(1)}×  scroll/]/[ zoom  ⇧←→ pan  dbl-click/0 reset`;
      ctx.font = '6px monospace'; ctx.fillStyle = '#f5c542'; ctx.textAlign = 'right';
      ctx.fillText(zLabel, W - 4, RULER_Y + 8);
      ctx.textAlign = 'left';
      // Scroll position indicator — thin amber bar at ruler bottom
      const sbX = Math.round((visStart - seqIn) / seqSpan * W);
      const sbW = Math.max(4, Math.round(visSpan / seqSpan * W));
      ctx.fillStyle = 'rgba(245,197,66,0.25)';
      ctx.fillRect(sbX, RULER_H - 2, sbW, 2);
      ctx.fillStyle = 'rgba(245,197,66,0.65)';
      ctx.fillRect(sbX, RULER_H - 1, sbW, 1);
    }

    // ── Smart compare lookups ─────────────────────────────────────────────────
    // matchedOldSet: set of OLD recIn strings that have a diff event pointing to them
    const matchedOldSet    = new Set(_s.diff.map(e => e.matchOldRecIn).filter(Boolean));
    // diffByOldRecIn: matchOldRecIn → diff event (for OLD track coloring)
    const diffByOldRecIn   = new Map(_s.diff.filter(e => e.matchOldRecIn).map(e => [e.matchOldRecIn, e]));

    // ── OLD track ─────────────────────────────────────────────────────────────
    ctx.fillStyle = '#0a0a16';
    ctx.fillRect(0, OLD_Y, W, OLD_H);

    // Hint when no thumbnails present for OLD track
    const _hasOldThumbs = [..._thumbCache.keys()].some(k => k.startsWith('old:'));
    if (!_hasOldThumbs) {
      ctx.save();
      ctx.font = '8px sans-serif'; ctx.textAlign = 'center';
      if (_thumbBusySides.has('old')) {
        ctx.fillStyle = 'rgba(245,197,66,0.5)';
        ctx.fillText('Extracting thumbnails…', W / 2, OLD_Y + OLD_H / 2 + 3);
      } else {
        ctx.fillStyle = 'rgba(100,100,170,0.55)';
        ctx.fillText('▶ Drop OLD video onto track for thumbnails', W / 2, OLD_Y + OLD_H / 2 + 3);
      }
      ctx.restore();
    }

    // Track label (left edge, behind clips — rendered last so it overlays empty space)
    const _drawTrackLabel = (label, y, h) => {
      ctx.font = 'bold 9px monospace'; ctx.textAlign = 'left';
      ctx.fillStyle = '#2a2a56';
      ctx.fillText(label, 4, y + h / 2 + 4);
    };

    for (const ev of _s.oldEvents) {
      const x1  = xOf(_f(ev.recIn));
      const x2  = xOf(_f(ev.recOut));
      const w   = Math.max(1, x2 - x1);
      const th  = OLD_H - 2 * THUMB_PAD;
      const key = `old:${ev.recIn}`;
      // Use live capture for the clip currently at the playhead; static cache otherwise
      const evIn = _f(ev.recIn), evOut = _f(ev.recOut);
      const atHead = _liveThumbOld && _tlPlayheadF >= evIn && _tlPlayheadF < evOut;
      const bmp = atHead ? _liveThumbOld : _thumbCache.get(key);

      if (bmp && w >= 4) {
        _drawThumb(bmp, x1 + THUMB_PAD, OLD_Y + THUMB_PAD, w - 2 * THUMB_PAD, th);
        // Subtle dark overlay so labels remain readable
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.fillRect(x1 + THUMB_PAD, OLD_Y + THUMB_PAD, w - 2 * THUMB_PAD, th);
      } else {
        ctx.fillStyle = 'rgba(90,90,155,0.55)';
        ctx.fillRect(x1, OLD_Y + THUMB_PAD, w, th);
        ctx.fillStyle = 'rgba(140,140,210,0.3)';
        ctx.fillRect(x1, OLD_Y + THUMB_PAD, w, 1);
      }

      // Clip border line (separates adjacent clips)
      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x1, OLD_Y); ctx.lineTo(x1, OLD_Y + OLD_H); ctx.stroke();

      // TC label (recIn, shown if clip is wide enough)
      if (w >= 30) {
        const inF = _f(ev.recIn);
        const sec = Math.floor(inF / fps);
        const lbl = `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
        ctx.font = '8px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.82)'; ctx.textAlign = 'left';
        ctx.fillText(lbl, x1 + 4, OLD_Y + OLD_H - 6);
      }
    }

    // Selected event: amber glow on OLD track
    if (_selFullIdx >= 0 && _s.diff[_selFullIdx]) {
      const ev = _s.diff[_selFullIdx];
      const x1 = xOf(_f(ev.recIn)), x2 = xOf(_f(ev.recOut));
      const w  = Math.max(2, x2 - x1);
      ctx.save();
      ctx.shadowColor = '#f5c542'; ctx.shadowBlur = 8;
      ctx.strokeStyle = '#f5c542'; ctx.lineWidth = 1.5;
      ctx.strokeRect(x1 + 0.5, OLD_Y + 0.5, w - 1, OLD_H - 1);
      ctx.restore();
    }

    // OLD track diff overlays — accent bar on top of changed/trimmed/extended clips
    for (const oe of _s.oldEvents) {
      const de = diffByOldRecIn.get(oe.recIn);
      if (!de || de.diffType === 'UNCHANGED') continue;
      const ox1 = xOf(_f(oe.recIn)), ox2 = xOf(_f(oe.recOut));
      const ow  = Math.max(2, ox2 - ox1);
      const col = DIFF_COLOR[de.diffType] || '#9090c0';
      ctx.fillStyle = _hexRgba(col, 0.85);
      ctx.fillRect(ox1, OLD_Y + THUMB_PAD, ow, 3);
    }

    // REMOVED clips — in OLD but no match in diff
    for (const oe of _s.oldEvents) {
      if (matchedOldSet.has(oe.recIn)) continue;
      const ox1 = xOf(_f(oe.recIn)), ox2 = xOf(_f(oe.recOut));
      const ow  = Math.max(2, ox2 - ox1);
      ctx.fillStyle = 'rgba(224,108,117,0.22)';
      ctx.fillRect(ox1, OLD_Y + THUMB_PAD, ow, OLD_H - 2 * THUMB_PAD);
      ctx.fillStyle = 'rgba(224,108,117,0.9)';
      ctx.fillRect(ox1, OLD_Y + OLD_H - 5, ow, 4);
      if (ow >= 32) {
        ctx.font = 'bold 7px monospace'; ctx.fillStyle = 'rgba(255,160,160,0.85)'; ctx.textAlign = 'left';
        ctx.fillText('REMOVED', ox1 + 3, OLD_Y + OLD_H - 7);
      }
    }

    _drawTrackLabel('OLD', OLD_Y, OLD_H);
    ctx.strokeStyle = '#0e0e20'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, OLD_Y + OLD_H); ctx.lineTo(W, OLD_Y + OLD_H); ctx.stroke();

    // ── Connector zone (smart trapezoid bridges OLD → NEW) ────────────────────
    ctx.fillStyle = '#040408';
    ctx.fillRect(0, CONN_Y, W, CONN_H);

    // REMOVED clip funnels (OLD → nowhere in NEW)
    for (const oe of _s.oldEvents) {
      if (matchedOldSet.has(oe.recIn)) continue;
      const ox1 = xOf(_f(oe.recIn)), ox2 = xOf(_f(oe.recOut));
      const midX = (ox1 + ox2) / 2;
      ctx.fillStyle = 'rgba(224,108,117,0.30)';
      ctx.beginPath();
      ctx.moveTo(ox1, CONN_Y);
      ctx.lineTo(ox2, CONN_Y);
      ctx.lineTo(midX, CONN_Y + CONN_H * 0.7);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(224,108,117,0.65)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ox1, CONN_Y); ctx.lineTo(ox2, CONN_Y); ctx.stroke();
    }

    // Diff event trapezoid connectors (OLD top edge → NEW bottom edge)
    for (let i = 0; i < _s.diff.length; i++) {
      const ev    = _s.diff[i];
      const isSel = i === _selFullIdx;
      const col   = ev.diffType === 'UNCHANGED' ? '#3cb464' : (DIFF_COLOR[ev.diffType] || '#9090c0');
      const alpha = ev.diffType === 'UNCHANGED'
        ? (isSel ? 0.22 : 0.09)
        : (isSel ? 0.72 : 0.38);

      // NEW bottom edge
      const nx1 = xOf(_f(ev.recIn));
      const nx2 = xOf(_f(ev.recOut));

      // OLD top edge — use matchOldRecIn/matchOldRecOut if available
      let ox1, ox2;
      if (ev.matchOldRecIn) {
        ox1 = xOf(_f(ev.matchOldRecIn));
        ox2 = ev.matchOldRecOut ? xOf(_f(ev.matchOldRecOut)) : ox1 + Math.max(1, nx2 - nx1);
      } else {
        // NEW clip — funnel from a point at center top
        const midN = Math.round((nx1 + nx2) / 2);
        ox1 = midN; ox2 = midN;
      }

      // Trapezoid fill
      ctx.fillStyle = _hexRgba(col, alpha);
      ctx.beginPath();
      ctx.moveTo(ox1, CONN_Y);
      ctx.lineTo(ox2, CONN_Y);
      ctx.lineTo(nx2, CONN_Y + CONN_H);
      ctx.lineTo(nx1, CONN_Y + CONN_H);
      ctx.closePath();
      ctx.fill();

      // Top edge (OLD side) + Bottom edge (NEW side)
      ctx.strokeStyle = _hexRgba(col, 0.65); ctx.lineWidth = 1;
      if (ox2 > ox1) {
        ctx.beginPath(); ctx.moveTo(ox1, CONN_Y); ctx.lineTo(ox2, CONN_Y); ctx.stroke();
      }
      ctx.beginPath(); ctx.moveTo(nx1, CONN_Y + CONN_H); ctx.lineTo(nx2, CONN_Y + CONN_H); ctx.stroke();

      // Labels inside trapezoid (only for non-UNCHANGED events wide enough)
      if (ev.diffType !== 'UNCHANGED') {
        const midX  = (ox1 + ox2 + nx1 + nx2) / 4;
        const midY  = CONN_Y + CONN_H / 2;
        const maxW  = Math.max(Math.abs(ox2 - ox1), Math.abs(nx2 - nx1));
        ctx.textAlign = 'center';
        if (maxW >= 36) {
          ctx.font = 'bold 7px monospace';
          ctx.fillStyle = _hexRgba(col, 0.95);
          ctx.fillText(ev.diffType, midX, midY - 4);
        }
        if (maxW >= 46 && ev.matchScore != null) {
          ctx.font = '7px monospace';
          ctx.fillStyle = 'rgba(255,255,255,0.65)';
          ctx.fillText(`${Math.round(ev.matchScore * 100)}%`, midX, midY + 6);
        }
        ctx.textAlign = 'left';
      }
    }

    // Zone borders
    ctx.strokeStyle = '#14142a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, CONN_Y);          ctx.lineTo(W, CONN_Y);          ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, CONN_Y + CONN_H); ctx.lineTo(W, CONN_Y + CONN_H); ctx.stroke();

    // ── NEW track ─────────────────────────────────────────────────────────────
    ctx.fillStyle = '#0a0a16';
    ctx.fillRect(0, NEW_Y, W, NEW_H);

    // Hint when no thumbnails present for NEW track
    const _hasNewThumbs = [..._thumbCache.keys()].some(k => k.startsWith('new:'));
    if (!_hasNewThumbs) {
      ctx.save();
      ctx.font = '8px sans-serif'; ctx.textAlign = 'center';
      if (_thumbBusySides.has('new')) {
        ctx.fillStyle = 'rgba(245,197,66,0.5)';
        ctx.fillText('Extracting thumbnails…', W / 2, NEW_Y + NEW_H / 2 + 3);
      } else {
        ctx.fillStyle = 'rgba(100,100,170,0.55)';
        ctx.fillText('▶ Drop NEW video onto track for thumbnails', W / 2, NEW_Y + NEW_H / 2 + 3);
      }
      ctx.restore();
    }

    // NEW track: draw all event base fills first (unchanged / non-diff), then diff events
    for (const ev of _s.newEvents) {
      const x1 = xOf(_f(ev.recIn)), x2 = xOf(_f(ev.recOut));
      const w  = Math.max(1, x2 - x1);
      const th = NEW_H - 2 * THUMB_PAD;
      const key = `new:${ev.recIn}`;
      // Use live capture for the clip currently at the playhead; static cache otherwise
      const evIn = _f(ev.recIn), evOut = _f(ev.recOut);
      const atHead = _liveThumbNew && _tlPlayheadF >= evIn && _tlPlayheadF < evOut;
      const bmp = atHead ? _liveThumbNew : _thumbCache.get(key);

      if (bmp && w >= 4) {
        _drawThumb(bmp, x1 + THUMB_PAD, NEW_Y + THUMB_PAD, w - 2 * THUMB_PAD, th);
        ctx.fillStyle = 'rgba(0,0,0,0.28)';
        ctx.fillRect(x1 + THUMB_PAD, NEW_Y + THUMB_PAD, w - 2 * THUMB_PAD, th);
      } else {
        ctx.fillStyle = 'rgba(60,60,110,0.5)';
        ctx.fillRect(x1, NEW_Y + THUMB_PAD, w, th);
      }

      ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x1, NEW_Y); ctx.lineTo(x1, NEW_Y + NEW_H); ctx.stroke();
    }

    // Diff overlays on NEW track (color bar at bottom of each changed clip)
    for (let i = 0; i < _s.diff.length; i++) {
      const ev    = _s.diff[i];
      const x1    = xOf(_f(ev.recIn));
      const x2    = xOf(_f(ev.recOut));
      const w     = Math.max(2, x2 - x1);
      const col   = DIFF_COLOR[ev.diffType] || '#9090c0';
      const isSel = i === _selFullIdx;

      if (ev.diffType === 'UNCHANGED') continue;

      // Color bar: bottom 4px of clip, full-opacity diff color
      ctx.fillStyle = _hexRgba(col, 0.85);
      ctx.fillRect(x1, NEW_Y + NEW_H - 5, w, 4);

      // Top 2px accent line
      ctx.fillStyle = _hexRgba(col, 0.65);
      ctx.fillRect(x1, NEW_Y + THUMB_PAD, w, 2);

      // Selected: glow outline
      if (isSel) {
        ctx.save();
        ctx.shadowColor = col; ctx.shadowBlur = 8;
        ctx.strokeStyle = col; ctx.lineWidth  = 1.5;
        ctx.strokeRect(x1 + 0.5, NEW_Y + 0.5, w - 1, NEW_H - 1);
        ctx.restore();
      }

      // TC label
      if (w >= 30) {
        const inF = _f(ev.recIn);
        const sec = Math.floor(inF / fps);
        const lbl = `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`;
        ctx.font = '8px monospace'; ctx.fillStyle = 'rgba(255,255,255,0.82)'; ctx.textAlign = 'left';
        ctx.fillText(lbl, x1 + 4, NEW_Y + NEW_H - 7);
      }
    }

    // High-risk: 2px red top bar on each high-risk event
    for (let i = 0; i < _s.diff.length; i++) {
      const ev = _s.diff[i];
      if (_riskOf(ev) !== 'high') continue;
      const x1 = xOf(_f(ev.recIn)), x2 = xOf(_f(ev.recOut));
      ctx.fillStyle = 'rgba(224,108,117,0.95)';
      ctx.fillRect(x1, NEW_Y + THUMB_PAD, Math.max(2, x2 - x1), 2);
    }

    _drawTrackLabel('NEW', NEW_Y, NEW_H);
    ctx.strokeStyle = '#0e0e20'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, NEW_Y + NEW_H); ctx.lineTo(W, NEW_Y + NEW_H); ctx.stroke();

    // ── Diff-type summary strip ───────────────────────────────────────────────
    ctx.fillStyle = '#090912';
    ctx.fillRect(0, SUMM_Y, W, SUMM_H);
    for (let i = 0; i < _s.diff.length; i++) {
      const ev = _s.diff[i];
      if (ev.diffType === 'UNCHANGED') continue;
      const x1  = xOf(_f(ev.recIn));
      const x2  = xOf(_f(ev.recOut));
      const col = DIFF_COLOR[ev.diffType] || '#9090c0';
      ctx.fillStyle = _hexRgba(col, 0.8);
      ctx.fillRect(x1, SUMM_Y + 1, Math.max(1, x2 - x1), SUMM_H - 2);
    }
    ctx.strokeStyle = '#141424'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, SUMM_Y); ctx.lineTo(W, SUMM_Y); ctx.stroke();

    // ── Content diff graph ────────────────────────────────────────────────────
    ctx.fillStyle = '#040410';
    ctx.fillRect(0, CDIFF_Y, W, CDIFF_H);

    const _hasVideo = _vc._readyOld || _vc._readyNew;
    if (_contentDiffMap.length > 0 && _hasVideo) {
      // Sort by frame so we can draw span bars
      const sorted = [..._contentDiffMap].sort((a, b) => a.frame - b.frame);
      // Use absolute score (0–1) for colour so bars only go red when frames
      // genuinely differ a lot, not just because they differ the most in this cut.
      for (let i = 0; i < sorted.length; i++) {
        const { frame, score } = sorted[i];
        const x1   = xOf(frame);
        const x2   = i + 1 < sorted.length ? xOf(sorted[i + 1].frame) : x1 + 2;
        const barW = Math.max(1, x2 - x1);
        const norm = Math.min(1, score);               // absolute 0–1
        const barH = Math.max(1, Math.round(norm * (CDIFF_H - 4)));

        // Color: teal (0%) → amber (40%) → coral (100%)
        let r, g, b;
        if (norm < 0.4) {
          r = Math.round(76  + (norm / 0.4) * (229 - 76));
          g = Math.round(175 + (norm / 0.4) * (192 - 175));
          b = Math.round(128 - (norm / 0.4) * (128 - 123));
        } else {
          const t = (norm - 0.4) / 0.6;
          r = Math.round(229 + t * (224 - 229));
          g = Math.round(192 - t * (192 - 108));
          b = Math.round(123 - t * (123 - 117));
        }
        const alpha = 0.45 + norm * 0.55;
        ctx.fillStyle = `rgba(${r},${g},${b},${alpha})`;
        ctx.fillRect(x1, CDIFF_Y + CDIFF_H - barH - 2, barW, barH);
        // Bright top edge
        ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, alpha + 0.3)})`;
        ctx.fillRect(x1, CDIFF_Y + CDIFF_H - barH - 2, barW, 1);
      }
    } else if (_contentDiffBusy && _hasVideo) {
      // Show "analysing…" hint while extraction is running
      ctx.font = '7px monospace'; ctx.fillStyle = '#2c2c50'; ctx.textAlign = 'center';
      ctx.fillText('Analysing content…', W / 2, CDIFF_Y + CDIFF_H / 2 + 3);
      ctx.textAlign = 'left';
    } else if (!_hasVideo && _contentDiffMap.length > 0) {
      ctx.font = '7px monospace'; ctx.fillStyle = '#2c2c50'; ctx.textAlign = 'center';
      ctx.fillText('Load videos to see content diff', W / 2, CDIFF_Y + CDIFF_H / 2 + 3);
      ctx.textAlign = 'left';
    }

    // Label + border
    ctx.font = '6px monospace'; ctx.fillStyle = '#232342'; ctx.textAlign = 'left';
    ctx.fillText('CONTENT DIFF', 3, CDIFF_Y + 8);
    ctx.strokeStyle = '#101020'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, CDIFF_Y); ctx.lineTo(W, CDIFF_Y); ctx.stroke();

    // Playhead is drawn on overlay canvas (_drawPlayheadOverlay) — update it now
    _drawPlayheadOverlay();
  }

  function _hexRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function _wireCanvasClick() {
    const canvas = _dom.tlCanvas;
    if (!canvas) return;
    canvas.addEventListener('click', e => {
      if (_tlPanOccurred) { _tlPanOccurred = false; return; } // suppress after pan
      if (!_s.diff.length) return;

      // Smart mode: map click x → slot → select diff event
      if (_tlSmartMode) {
        const rect = canvas.getBoundingClientRect();
        const dpr  = Math.min(window.devicePixelRatio || 1, 2);
        const px   = (e.clientX - rect.left) * (canvas.width / dpr / rect.width);
        for (let i = 0; i < _smartSlots.length; i++) {
          if (px >= _smartSlotX[i] && px < _smartSlotX[i] + _smartSlotW[i]) {
            const slot = _smartSlots[i];
            const rows = _filteredDiff();
              const idx  = rows.indexOf(slot.ev);
              if (idx >= 0) _selectRow(idx);
            return;
          }
        }
        return;
      }

      const rng = _tlSeqRange();
      if (!rng) return;
      const { seqIn, seqOut } = rng;
      const rect = canvas.getBoundingClientRect();
      const xPct = (e.clientX - rect.left) / rect.width;
      const fps  = _s.fps || 24;
      const _f   = tc => (tcToFrames ? tcToFrames(tc, fps) : 0);
      // Map click to frame within VISIBLE range (respects zoom)
      const visS = _tlVisStart ?? seqIn;
      const visE = _tlVisEnd   ?? seqOut;
      const clickFrame = visS + xPct * (visE - visS);
      // Seek video to clicked position
      _vcSeekToFrame(clickFrame);
      _tlPlayheadF = Math.round(clickFrame);
      _drawPlayheadOverlay();
      _schedTlRedraw();
      // Select nearest diff event
      const rows = _filteredDiff();
      let bestIdx = -1, bestDist = Infinity;
      rows.forEach((ev, i) => {
        const mid  = (_f(ev.recIn) + _f(ev.recOut)) / 2;
        const dist = Math.abs(clickFrame - mid);
        if (dist < bestDist) { bestDist = dist; bestIdx = i; }
      });
      if (bestIdx >= 0) _selectRow(bestIdx);
    });
  }

  function _wireColResize() {
    const table = _dom.tableBody?.closest('table');
    if (!table) return;
    const thead = table.querySelector('thead');
    if (!thead) return;

    // Inject resizer handles into each th
    thead.querySelectorAll('th').forEach(th => {
      if (th.querySelector('.cd2x-th-resizer')) return; // already wired
      const handle = document.createElement('div');
      handle.className = 'cd2x-th-resizer';
      th.appendChild(handle);

      let startX = 0, startW = 0;
      const onMove = e => {
        const newW = Math.max(24, startW + (e.clientX - startX));
        th.style.width = newW + 'px';
        th.style.minWidth = newW + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
      handle.addEventListener('mousedown', e => {
        e.preventDefault(); e.stopPropagation();
        startX = e.clientX;
        startW = th.offsetWidth;
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  function _wireThumbDrop() {
    const canvas = _dom.tlCanvas;
    if (!canvas) return;

    canvas.addEventListener('dragover', e => {
      const hasVideo = [...(e.dataTransfer?.items || [])].some(i => i.kind === 'file' && i.type.startsWith('video/'));
      if (!hasVideo) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      canvas.style.outline = '2px solid #f5c542';
    });

    canvas.addEventListener('dragleave', () => {
      canvas.style.outline = '';
    });

    canvas.addEventListener('drop', e => {
      e.preventDefault();
      canvas.style.outline = '';
      const file = [...(e.dataTransfer?.files || [])].find(f => f.type.startsWith('video/'));
      if (!file) return;
      // Determine which track by Y position relative to canvas display height
      const rect   = canvas.getBoundingClientRect();
      const relY   = e.clientY - rect.top;
      const side   = relY < rect.height * 0.55 ? 'old' : 'new';
      _vcLoad(side, file);
    });
  }

  function _wireFilters() {
    _dom.filterBtns?.forEach(btn => {
      btn.addEventListener('click', () => {
        _dom.filterBtns.forEach(b => b.classList.remove('cd2x-filter-active'));
        btn.classList.add('cd2x-filter-active');
        _s.filterType = btn.dataset.type || 'ALL';
        _s.selectedIdx = -1;
        _renderTable(); _schedTlRedraw();
      });
    });
    _dom.riskBtns?.forEach(btn => {
      btn.addEventListener('click', () => {
        _dom.riskBtns.forEach(b => b.classList.remove('cd2x-risk-active'));
        btn.classList.add('cd2x-risk-active');
        _s.filterRisk  = btn.dataset.risk || 'all';
        _s.selectedIdx = -1;
        _renderTable(); _schedTlRedraw();
      });
    });
  }

  function _wireButtons() {
    _dom.analyzeBtn?.addEventListener('click', _analyze);

    // Export dropdown toggle
    _dom.exportBtn?.addEventListener('click', e => {
      e.stopPropagation();
      const m = _dom.exportMenu;
      if (!m) return;
      m.style.display = m.style.display === 'none' ? 'block' : 'none';
    });
    // Dispatch to export actions
    _dom.exportMenu?.addEventListener('click', e => {
      const btn = e.target.closest('button[data-act]');
      if (!btn) return;
      if (_dom.exportMenu) _dom.exportMenu.style.display = 'none';
      const act = btn.dataset.act;
      if (act === 'pdf') { _exportPdf(); return; }
      if (act === 'pulledl' || act === 'xls') {
        if (typeof window.__rqAddJob === 'function') {
          const stem   = (_s.newName || 'cutdiff2').replace(/\.[^.]+$/, '');
          const labels = { pulledl: 'Pull EDL', xls: 'Change List XLSX' };
          window.__rqAddJob(act, `${labels[act] || act} — ${stem}`, { fmt: act, stem, module: 'cd2' });
          try { window.setMainTab('renderq'); } catch {}
        } else {
          if (act === 'pulledl') _exportPullEdl();
          else _exportXls();
        }
      }
    });
    // Close menu on outside click
    document.addEventListener('click', () => {
      if (_dom.exportMenu) _dom.exportMenu.style.display = 'none';
    });
  }

  // Helper: zoom timeline by factor around its center
  function _tlZoomBy(factor) {
    const rng = _tlSeqRange(); if (!rng) return;
    const { seqIn, seqOut } = rng;
    const seqSpan = seqOut - seqIn;
    const visS    = _tlVisStart ?? seqIn;
    const visE    = _tlVisEnd   ?? seqOut;
    const visSpan = visE - visS;
    const center  = visS + visSpan / 2;
    const fps     = _s.fps || 24;
    const minSpan = fps * 8;
    let newSpan = Math.max(minSpan, Math.min(seqSpan, visSpan * factor));
    let newS    = center - newSpan / 2;
    let newE    = newS + newSpan;
    if (newS < seqIn)  { newS = seqIn;  newE = seqIn  + newSpan; }
    if (newE > seqOut) { newE = seqOut; newS = seqOut - newSpan; }
    if (newS < seqIn)    newS = seqIn;
    if (newSpan >= seqSpan * 0.98) { _tlVisStart = null; _tlVisEnd = null; }
    else                            { _tlVisStart = newS; _tlVisEnd = newE; }
    _schedTlRedraw();
  }

  // Helper: pan timeline by a fraction of visible span
  function _tlPanBy(frac) {
    const rng = _tlSeqRange(); if (!rng) return;
    if (_tlVisStart === null) return;
    const { seqIn, seqOut } = rng;
    const visSpan = _tlVisEnd - _tlVisStart;
    const delta   = frac * visSpan;
    let newS = Math.max(seqIn, Math.min(seqOut - visSpan, _tlVisStart + delta));
    _tlVisStart = newS; _tlVisEnd = newS + visSpan;
    _tlPanOccurred = true;
    _schedTlRedraw();
  }

  function _wireKeyboard() {
    document.addEventListener('keydown', e => {
      if (!_dom.pane?.classList.contains('active')) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
      const rows = _filteredDiff();
      const cur  = _s.selectedIdx;

      // ── Timeline controls ───────────────────────────────────────────────────
      if (e.key === '[' || e.key === '-') {
        e.preventDefault(); _tlZoomBy(1 / 0.7); return;  // zoom out
      } else if (e.key === ']' || e.key === '=') {
        e.preventDefault(); _tlZoomBy(0.7); return;       // zoom in
      } else if (e.key === '\\' || e.key === '0') {
        e.preventDefault();
        _tlVisStart = null; _tlVisEnd = null; _schedTlRedraw(); return; // reset zoom
      } else if (e.key === 'Home') {
        e.preventDefault();
        if (_tlVisStart !== null) { const span = _tlVisEnd - _tlVisStart; const rng = _tlSeqRange(); if (rng) { _tlVisStart = rng.seqIn; _tlVisEnd = rng.seqIn + span; _schedTlRedraw(); } } return;
      } else if (e.key === 'End') {
        e.preventDefault();
        if (_tlVisStart !== null) { const span = _tlVisEnd - _tlVisStart; const rng = _tlSeqRange(); if (rng) { _tlVisEnd = rng.seqOut; _tlVisStart = rng.seqOut - span; _schedTlRedraw(); } } return;
      } else if (e.key === 'ArrowLeft' && e.shiftKey) {
        e.preventDefault(); _tlPanBy(-0.25); return;
      } else if (e.key === 'ArrowRight' && e.shiftKey) {
        e.preventDefault(); _tlPanBy(0.25); return;
      }

      // ── Event list + video controls ─────────────────────────────────────────
      if (e.key === 'ArrowDown' || e.key === 'j' || e.key === 'J') {
        e.preventDefault(); _selectRow(Math.min(cur + 1, rows.length - 1));
      } else if (e.key === 'ArrowUp' || e.key === 'k' || e.key === 'K') {
        e.preventDefault(); _selectRow(Math.max(cur - 1, 0));
      } else if (e.key === 'Escape') {
        _closeInspector();
      } else if (e.key === 'Enter' && cur >= 0) {
        _cycleStatus(cur);
      } else if (e.key === ' ') {
        e.preventDefault(); _vcPlayPause();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault(); _vcStepFrames(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault(); _vcStepFrames(1);
      }
    });
  }

  // ── Pull EDL export ───────────────────────────────────────────────────────
  async function _exportPullEdl() {
    if (window.PFX_PERMISSIONS && !window.PFX_PERMISSIONS.canDoAction('export')) {
      window.PFX_GUARD?.deny?.('export'); return;
    }
    if (!_s.diff.length) { showError?.('Nothing to export — run Analyze first.'); return; }
    const PULL_TYPES = new Set(['NEW', 'CHANGED', 'EXTENDED']);
    const pullEvents = _s.diff.filter(ev => PULL_TYPES.has(ev.diffType));
    if (!pullEvents.length) { showError?.('No NEW / CHANGED / EXTENDED events to pull.'); return; }

    const edlEvents = pullEvents.map((ev, i) => ({
      event:      i + 1,
      clipName:   ev.clipName || ev.reel || 'UNKNOWN',
      reel:       ev.reel     || ev.clipName || 'UNKNOWN',
      srcIn:      ev.srcIn    || ev.recIn  || '00:00:00:00',
      srcOut:     ev.srcOut   || ev.recOut || '00:00:00:00',
      recIn:      ev.recIn    || '00:00:00:00',
      recOut:     ev.recOut   || '00:00:00:00',
      fps:        _s.fps || 24,
      track:      'V',
      transition: 'C',
    }));

    const ymd  = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const stem = (_s.newName || 'cutdiff2').replace(/\.[^.]+$/, '');
    try {
      const parts = buildEDLFiles(edlEvents, { projectName: stem, autosplit: true, maxEventsPerPart: 1500 });
      for (const { filename, content } of parts) {
        const blob = new Blob([content], { type: 'text/plain' });
        const fname = filename || `${stem}_PullEDL_${ymd}.edl`;
        if (typeof window.__pfxSaveBlob === 'function') {
          await window.__pfxSaveBlob(fname, blob);
        } else {
          const url = URL.createObjectURL(blob);
          const a = Object.assign(document.createElement('a'), { href: url, download: fname });
          document.body.appendChild(a); a.click(); document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
      }
    } catch(e) { showError?.('EDL export failed: ' + (e?.message || e)); }
  }

  // ── PDF smart change list ─────────────────────────────────────────────────
  function _exportPdf() {
    if (window.PFX_PERMISSIONS && !window.PFX_PERMISSIONS.canDoAction('export')) {
      window.PFX_GUARD?.deny?.('export'); return;
    }
    if (!_s.diff.length) { showError?.('Nothing to export — run Analyze first.'); return; }
    const ymd  = new Date().toISOString().slice(0, 10);
    const stem = (_s.newName || 'CUT DIFF 2.0').replace(/\.[^.]+$/, '');

    // ── Thumbnail helper: ImageBitmap → jpeg data URL via offscreen canvas ──
    const _tc = document.createElement('canvas');
    _tc.width = 180; _tc.height = 101;
    const _tctx = _tc.getContext('2d');
    const thumbUrl = (key) => {
      const bmp = _thumbCache.get(key);
      if (!bmp) return null;
      try { _tctx.clearRect(0,0,180,101); _tctx.drawImage(bmp,0,0,180,101); return _tc.toDataURL('image/jpeg',0.78); }
      catch { return null; }
    };

    // ── Compute REMOVED: OLD clips whose identity key never appears in newEvents ─
    const _normKey = ev => `${(ev.clipName||'').toLowerCase().trim()}|${(ev.reel||'').toLowerCase().trim()}`;
    const newKeySet = new Set(_s.newEvents.map(_normKey));
    const removed = (_s.oldEvents || [])
      .filter(ev => !newKeySet.has(_normKey(ev)))
      .map(ev => ({ ...ev, diffType: 'REMOVED' }));

    // ── Audio change heuristic ─────────────────────────────────────────────
    const AUDIO_RE = /\b(mx|sfx|dub|adr|nar|vo|audio|music|fx|ambience|amb|foley|dia|dialogue|narr|atmos)\b/i;
    const isAudioEv = ev => AUDIO_RE.test(ev.clipName||'') || AUDIO_RE.test(ev.reel||'');
    // All actionable changes affect audio — sort by RecIn for mixer/sound editor
    const audioList = [..._s.diff.filter(ev => ev.diffType !== 'UNCHANGED'), ...removed]
      .sort((a,b) => (a.recIn||'').localeCompare(b.recIn||''));

    // ── Group events by section (card layout) ──────────────────────────────
    // Light-mode palette: vivid accent on white cards
    const G = [
      { type:'NEW',      label:'NEW CLIPS',    color:'#0284c7', light:'#e0f2fe', events: _s.diff.filter(ev=>ev.diffType==='NEW') },
      { type:'EXTENDED', label:'EXTENDED',      color:'#059669', light:'#d1fae5', events: _s.diff.filter(ev=>ev.diffType==='EXTENDED') },
      { type:'CHANGED',  label:'CHANGED',       color:'#d97706', light:'#fef3c7', events: _s.diff.filter(ev=>ev.diffType==='CHANGED') },
      { type:'TRIMMED',  label:'TRIMMED',       color:'#7c3aed', light:'#ede9fe', events: _s.diff.filter(ev=>ev.diffType==='TRIMMED') },
      { type:'REMOVED',  label:'REMOVED CLIPS', color:'#dc2626', light:'#fee2e2', events: removed },
    ].filter(g=>g.events.length);

    // ── Render one event card ───────────────────────────────────────────────
    const RISK_C  = { high:'#dc2626', med:'#d97706', low:'#059669' };
    const RISK_BG = { high:'#fee2e2', med:'#fef3c7', low:'#d1fae5' };
    const card = (ev, idx, g) => {
      const key    = _diffKey(ev);
      const status = _s.statusMap.get(key) || '';
      const note   = _s.noteMap.get(key)   || '';
      const risk   = _riskOf(ev);
      const dur    = Number(ev.durationFrames || ev._lenFrames || 0);
      const score  = ev.matchScore != null ? Math.round(ev.matchScore*100)+'%' : '';
      const fps    = _s.fps || 24;

      const thumb = (g.type === 'REMOVED')
        ? (thumbUrl(`old:${ev.recIn}`) || null)
        : (thumbUrl(`new:${ev.recIn}`) || thumbUrl(`old:${ev.recIn}`) || null);
      const thumbHtml = thumb
        ? `<img src="${thumb}" style="width:176px;height:99px;object-fit:cover;border-radius:4px;flex-shrink:0;display:block;border:1px solid #e5e7eb">`
        : `<div style="width:176px;height:99px;background:#f3f4f6;border-radius:4px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#d1d5db;font-size:8px;letter-spacing:1px;border:1px dashed #d1d5db">NO FRAME</div>`;

      const typeBadge  = `<span style="color:${g.color};font-size:8px;font-weight:700;background:${g.light};padding:2px 8px;border-radius:12px;border:1px solid ${g.color}33;letter-spacing:0.3px">${ev.diffType||g.type}</span>`;
      const riskBadge  = `<span style="color:${RISK_C[risk]};font-size:8px;font-weight:600;background:${RISK_BG[risk]};padding:2px 8px;border-radius:12px">${risk.toUpperCase()}</span>`;
      const scoreBadge = score ? `<span style="color:#6b7280;font-size:8px;background:#f3f4f6;padding:2px 7px;border-radius:12px">${score}</span>` : '';
      const statBadge  = status ? `<span style="color:#374151;font-size:8px;background:#f9fafb;padding:2px 7px;border-radius:12px;border:1px solid #e5e7eb">${status.toUpperCase()}</span>` : '';
      const audioBadge = isAudioEv(ev) ? `<span style="color:#92400e;font-size:8px;background:#fef3c7;padding:2px 7px;border-radius:12px;border:1px solid #d9770640">&#9834; AUDIO</span>` : '';

      const mono = v => `<span style="font-family:monospace;font-size:9px;color:#374151">${v||'—'}</span>`;
      const kv   = (k,v) => `<div style="font-size:8px;color:#9ca3af;margin-bottom:1px">${k}&ensp;${mono(v)}</div>`;

      return `<div style="display:flex;gap:12px;background:#fff;border-radius:8px;padding:12px;border-left:4px solid ${g.color};margin-bottom:8px;page-break-inside:avoid;box-shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04)">
        ${thumbHtml}
        <div style="flex:1;min-width:0;overflow:hidden">
          <div style="display:flex;gap:5px;align-items:center;margin-bottom:7px;flex-wrap:wrap">
            <span style="font-size:8px;color:#d1d5db;font-family:monospace;font-weight:600">${String(idx+1).padStart(2,'0')}</span>
            ${typeBadge}${riskBadge}${scoreBadge}${statBadge}${audioBadge}
          </div>
          <div style="font-weight:700;font-size:13px;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:1px;letter-spacing:-0.2px">${ev.clipName||'—'}</div>
          <div style="font-size:9px;color:#9ca3af;margin-bottom:8px">Reel &ensp;<span style="color:#6b7280;font-family:monospace">${ev.reel||'—'}</span></div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:2px 20px;background:#f9fafb;border-radius:5px;padding:7px 10px">
            ${kv('Rec In', ev.recIn)}${kv('Rec Out', ev.recOut)}
            ${kv('Src In', ev.srcIn)}${kv('Src Out', ev.srcOut)}
            ${dur ? kv('Duration', dur+'\u202Ffr\u2002('+Math.round(dur/fps*10)/10+'s)') : ''}
          </div>
          ${note ? `<div style="margin-top:7px;font-size:9px;color:#6b7280;font-style:italic;padding:5px 8px;background:#fffbeb;border-left:2px solid #d97706;border-radius:0 4px 4px 0">${note}</div>` : ''}
        </div>
      </div>`;
    };

    // ── Render one section ──────────────────────────────────────────────────
    const section = (g) => `<div style="margin-bottom:24px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:10px">
        <div style="width:4px;height:20px;background:${g.color};border-radius:2px;flex-shrink:0"></div>
        <span style="color:#111827;font-size:12px;font-weight:800;letter-spacing:0.5px">${g.label}</span>
        <span style="color:${g.color};font-size:10px;font-weight:700;background:${g.light};padding:2px 10px;border-radius:12px">${g.events.length}</span>
      </div>
      ${g.events.map((ev,i)=>card(ev,i,g)).join('')}
    </div>`;

    // ── Summary / stats ─────────────────────────────────────────────────────
    const fps = _s.fps || 24;
    const frToTc = fr => {
      const s=Math.floor(fr/fps), f=fr%fps, m=Math.floor(s/60), sec=s%60, h=Math.floor(m/60), min=m%60;
      return `${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}:${String(f).padStart(2,'0')}`;
    };
    const addFr = _s.diff.filter(ev=>ev.diffType==='NEW'||ev.diffType==='EXTENDED').reduce((a,ev)=>a+Number(ev.durationFrames||ev._lenFrames||0),0);
    const remFr = _s.diff.filter(ev=>ev.diffType==='TRIMMED').reduce((a,ev)=>a+Number(ev.durationFrames||ev._lenFrames||0),0);
    const statChip = (label, val, color, bg) =>
      `<div style="background:${bg||'#f9fafb'};padding:10px 14px;border-radius:8px;border:1px solid #e5e7eb;min-width:80px;flex:1">
         <div style="font-size:7px;color:#9ca3af;letter-spacing:0.8px;text-transform:uppercase;margin-bottom:4px;font-weight:600">${label}</div>
         <div style="font-size:15px;color:${color||'#374151'};font-family:monospace;font-weight:800">${val}</div>
       </div>`;

    const summaryHtml = [
      statChip('New',       G.find(g=>g.type==='NEW')?.events.length||0,      '#0284c7','#f0f9ff'),
      statChip('Extended',  G.find(g=>g.type==='EXTENDED')?.events.length||0, '#059669','#f0fdf4'),
      statChip('Changed',   G.find(g=>g.type==='CHANGED')?.events.length||0,  '#d97706','#fffbeb'),
      statChip('Trimmed',   G.find(g=>g.type==='TRIMMED')?.events.length||0,  '#7c3aed','#f5f3ff'),
      statChip('Removed',   removed.length,    '#dc2626','#fff1f2'),
      statChip('Audio Refs',audioList.length,  '#92400e','#fef3c7'),
      statChip('+Duration', frToTc(addFr),     '#059669','#f0fdf4'),
      statChip('−Duration', frToTc(remFr),     '#dc2626','#fff1f2'),
    ].join('');

    // ── Audio change list rows ─────────────────────────────────────────────
    const TYPE_C  = { NEW:'#0284c7', EXTENDED:'#059669', CHANGED:'#d97706', TRIMMED:'#7c3aed', REMOVED:'#dc2626' };
    const TYPE_BG = { NEW:'#e0f2fe', EXTENDED:'#d1fae5', CHANGED:'#fef3c7', TRIMMED:'#ede9fe', REMOVED:'#fee2e2' };
    const audioRows = audioList.map((ev, i) => {
      const key    = _diffKey(ev);
      const status = _s.statusMap.get(key) || '';
      const note   = _s.noteMap.get(key)   || '';
      const dur    = Number(ev.durationFrames || ev._lenFrames || 0);
      const risk   = _riskOf(ev);
      const tc     = TYPE_C[ev.diffType]  || '#374151';
      const tbg    = TYPE_BG[ev.diffType] || '#f3f4f6';
      const rc     = RISK_C[risk]         || '#374151';
      const rbg    = RISK_BG[risk]        || '#f3f4f6';
      const audioBadge = isAudioEv(ev)
        ? `<span style="background:#fef3c7;color:#92400e;font-size:7px;padding:1px 5px;border-radius:8px;margin-left:4px;font-weight:600">&#9834;</span>` : '';
      return `<tr>
        <td style="color:#d1d5db;font-family:monospace;font-size:8px;padding:6px 10px;border-bottom:1px solid #f3f4f6;background:${i%2===0?'#fff':'#fafafa'};white-space:nowrap">${i+1}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;background:${i%2===0?'#fff':'#fafafa'};white-space:nowrap">
          <span style="color:${tc};font-weight:700;font-size:8px;background:${tbg};padding:2px 7px;border-radius:10px">${ev.diffType||''}</span>${audioBadge}
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;background:${i%2===0?'#fff':'#fafafa'};white-space:nowrap">
          <span style="color:${rc};font-size:8px;font-weight:600;background:${rbg};padding:2px 7px;border-radius:10px">${risk.toUpperCase()}</span>
        </td>
        <td style="padding:6px 10px;border-bottom:1px solid #f3f4f6;background:${i%2===0?'#fff':'#fafafa'};font-size:9px;font-weight:600;color:#111827;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ev.clipName||'—'}</td>
        <td style="color:#6b7280;padding:6px 10px;border-bottom:1px solid #f3f4f6;background:${i%2===0?'#fff':'#fafafa'};font-size:9px;font-family:monospace;white-space:nowrap">${ev.reel||'—'}</td>
        <td style="color:#374151;font-family:monospace;padding:6px 10px;border-bottom:1px solid #f3f4f6;background:${i%2===0?'#fff':'#fafafa'};font-size:9px;white-space:nowrap">${ev.recIn||'—'}</td>
        <td style="color:#374151;font-family:monospace;padding:6px 10px;border-bottom:1px solid #f3f4f6;background:${i%2===0?'#fff':'#fafafa'};font-size:9px;white-space:nowrap">${ev.recOut||'—'}</td>
        <td style="color:#6b7280;font-family:monospace;padding:6px 10px;border-bottom:1px solid #f3f4f6;background:${i%2===0?'#fff':'#fafafa'};font-size:9px;white-space:nowrap">${dur||'—'}</td>
        <td style="color:#374151;padding:6px 10px;border-bottom:1px solid #f3f4f6;background:${i%2===0?'#fff':'#fafafa'};font-size:8px;white-space:nowrap">${status}</td>
        <td style="color:#6b7280;font-style:italic;padding:6px 10px;border-bottom:1px solid #f3f4f6;background:${i%2===0?'#fff':'#fafafa'};font-size:8px">${note}</td>
      </tr>`;
    }).join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>${stem} — Change List ${ymd}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:10px;background:#f3f4f6;color:#111827;padding:24px}
  @media print{
    body{padding:10px;background:#fff!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}
    .no-print{display:none!important}
    @page{margin:12mm 14mm}
  }
</style></head><body>

<!-- ── Page header ── -->
<div style="background:#111827;border-radius:10px;padding:18px 22px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center">
  <div>
    <div style="font-size:9px;color:#6b7280;letter-spacing:1.5px;text-transform:uppercase;margin-bottom:4px;font-weight:600">Cut Change List</div>
    <div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:-0.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:560px">${stem}</div>
    <div style="font-size:9px;color:#4b5563;margin-top:5px;font-family:monospace">
      OLD&ensp;<span style="color:#9ca3af">${_s.oldName||'—'}</span>&emsp;NEW&ensp;<span style="color:#9ca3af">${_s.newName||'—'}</span>&emsp;${ymd}
    </div>
  </div>
  <button id="pfx-print-btn" class="no-print" style="background:#fff;color:#111827;border:none;padding:9px 18px;border-radius:6px;cursor:pointer;font-size:9px;font-family:inherit;font-weight:700;white-space:nowrap;flex-shrink:0;margin-left:16px">&#128462;&ensp;Print / Save PDF</button>
</div>

<!-- ── Summary stats ── -->
<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px">${summaryHtml}</div>

<!-- ── Change sections ── -->
<div style="background:#fff;border-radius:10px;padding:20px 22px;box-shadow:0 1px 3px rgba(0,0,0,.07)">
${G.map(section).join('')}

<!-- ── Audio Change List ── -->
<div style="margin-top:16px;padding-top:20px;border-top:2px solid #f3f4f6">
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
    <div style="width:4px;height:20px;background:#d97706;border-radius:2px;flex-shrink:0"></div>
    <span style="color:#111827;font-size:12px;font-weight:800;letter-spacing:0.5px">&#9834;&ensp;AUDIO CHANGE LIST</span>
    <span style="color:#92400e;font-size:10px;font-weight:700;background:#fef3c7;padding:2px 10px;border-radius:12px">${audioList.length}</span>
    <span style="color:#9ca3af;font-size:8px">all changes sorted by RecIn — for sound editor / mixer</span>
  </div>
  ${audioList.length ? `<div style="overflow-x:auto;border-radius:8px;border:1px solid #e5e7eb">
    <table style="border-collapse:collapse;width:100%;min-width:700px">
      <thead>
        <tr style="background:#f9fafb">
          <th style="color:#9ca3af;font-size:7px;text-transform:uppercase;letter-spacing:0.8px;padding:8px 10px;border-bottom:2px solid #e5e7eb;text-align:left;white-space:nowrap;font-weight:700">#</th>
          <th style="color:#9ca3af;font-size:7px;text-transform:uppercase;letter-spacing:0.8px;padding:8px 10px;border-bottom:2px solid #e5e7eb;text-align:left;white-space:nowrap;font-weight:700">Type</th>
          <th style="color:#9ca3af;font-size:7px;text-transform:uppercase;letter-spacing:0.8px;padding:8px 10px;border-bottom:2px solid #e5e7eb;text-align:left;white-space:nowrap;font-weight:700">Risk</th>
          <th style="color:#9ca3af;font-size:7px;text-transform:uppercase;letter-spacing:0.8px;padding:8px 10px;border-bottom:2px solid #e5e7eb;text-align:left;font-weight:700">Clip Name</th>
          <th style="color:#9ca3af;font-size:7px;text-transform:uppercase;letter-spacing:0.8px;padding:8px 10px;border-bottom:2px solid #e5e7eb;text-align:left;font-weight:700">Reel</th>
          <th style="color:#9ca3af;font-size:7px;text-transform:uppercase;letter-spacing:0.8px;padding:8px 10px;border-bottom:2px solid #e5e7eb;text-align:left;white-space:nowrap;font-weight:700">Rec In</th>
          <th style="color:#9ca3af;font-size:7px;text-transform:uppercase;letter-spacing:0.8px;padding:8px 10px;border-bottom:2px solid #e5e7eb;text-align:left;white-space:nowrap;font-weight:700">Rec Out</th>
          <th style="color:#9ca3af;font-size:7px;text-transform:uppercase;letter-spacing:0.8px;padding:8px 10px;border-bottom:2px solid #e5e7eb;text-align:left;white-space:nowrap;font-weight:700">Dur(fr)</th>
          <th style="color:#9ca3af;font-size:7px;text-transform:uppercase;letter-spacing:0.8px;padding:8px 10px;border-bottom:2px solid #e5e7eb;text-align:left;font-weight:700">Status</th>
          <th style="color:#9ca3af;font-size:7px;text-transform:uppercase;letter-spacing:0.8px;padding:8px 10px;border-bottom:2px solid #e5e7eb;text-align:left;font-weight:700">Note</th>
        </tr>
      </thead>
      <tbody>${audioRows}</tbody>
    </table>
  </div>` : `<div style="color:#9ca3af;font-size:9px;padding:14px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;text-align:center">No changes found.</div>`}
</div>
</div>

</body></html>`;

    try {
      const blob    = new Blob([html], { type: 'text/html;charset=utf-8' });
      const blobUrl = URL.createObjectURL(blob);
      const w = window.open(blobUrl, '_blank', 'width=1060,height=880');
      if (!w) { showError?.('Popup blocked — allow popups for this extension and try again.'); return; }

      // Wire print button from the opener (extension context) — bypasses blob CSP entirely
      w.addEventListener('load', () => {
        const btn = w.document.getElementById('pfx-print-btn');
        if (btn) btn.addEventListener('click', () => w.print());
      });
      setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
    } catch(e) { showError?.('PDF export failed: ' + (e?.message || e)); }
  }

  // ── XLSX Change List export — proper OOXML ZIP with embedded thumbnails ──
  async function _exportXls() {
    if (!_s.diff.length) { showError?.('Nothing to export — run Analyze first.'); return; }
    const ymd  = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const ymdH = new Date().toISOString().slice(0, 10);
    const stem = (_s.newName || 'cutdiff2').replace(/\.[^.]+$/, '');
    const fps  = _s.fps || 24;

    // ── Thumbnail → deduplicated JPEG Uint8Arrays ─────────────────────────
    const _tc = document.createElement('canvas');
    _tc.width = 120; _tc.height = 68;
    const _tctx = _tc.getContext('2d');
    const _toDataUrl = key => {
      const bmp = _thumbCache.get(key);
      if (!bmp) return null;
      try { _tctx.clearRect(0,0,120,68); _tctx.drawImage(bmp,0,0,120,68); return _tc.toDataURL('image/jpeg',0.72); }
      catch { return null; }
    };
    const _urlMap   = new Map(); // dataUrl → imgIdx
    const _imgBytes = [];        // Uint8Array[] — JPEG bytes per unique image
    const _evUrl = ev => ev.diffType === 'REMOVED'
      ? (_toDataUrl(`old:${ev.recIn}`) || null)
      : (_toDataUrl(`new:${ev.recIn}`) || _toDataUrl(`old:${ev.recIn}`) || null);
    const _getIdx = ev => {
      const url = _evUrl(ev);
      if (!url) return -1;
      if (_urlMap.has(url)) return _urlMap.get(url);
      const b64 = url.slice(url.indexOf(',') + 1);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      const idx = _imgBytes.length;
      _imgBytes.push(bytes);
      _urlMap.set(url, idx);
      return idx;
    };

    // ── Data ──────────────────────────────────────────────────────────────
    const changeEvs  = _s.diff.filter(ev => ev.diffType !== 'UNCHANGED');
    const chImgIdxs  = changeEvs.map(ev => _getIdx(ev)); // triggers image collection
    const _nk        = ev => `${(ev.clipName||'').toLowerCase().trim()}|${(ev.reel||'').toLowerCase().trim()}`;
    const _newKeys   = new Set((_s.newEvents||[]).map(_nk));
    const removed    = (_s.oldEvents||[]).filter(ev=>!_newKeys.has(_nk(ev))).map(ev=>({...ev,diffType:'REMOVED'}));
    const AUDIO_RE   = /\b(mx|sfx|dub|adr|nar|vo|audio|music|fx|ambience|amb|foley|dia|dialogue|narr|atmos)\b/i;
    const isAudio    = ev => AUDIO_RE.test(ev.clipName||'')||AUDIO_RE.test(ev.reel||'');
    const audioList  = [..._s.diff.filter(ev=>ev.diffType!=='UNCHANGED'),...removed]
      .sort((a,b)=>(a.recIn||'').localeCompare(b.recIn||''));
    const cnt = { NEW:0, EXTENDED:0, CHANGED:0, TRIMMED:0 };
    let addFr = 0, remFr = 0;
    for (const ev of _s.diff) {
      if (ev.diffType in cnt) cnt[ev.diffType]++;
      const fr = Number(ev.durationFrames||ev._lenFrames||0);
      if (ev.diffType==='NEW'||ev.diffType==='EXTENDED') addFr += fr;
      if (ev.diffType==='TRIMMED') remFr += fr;
    }
    const frTc = fr => {
      const s=Math.floor(fr/fps),f=fr%fps,m=Math.floor(s/60),sec=s%60,h=Math.floor(m/60),mn=m%60;
      return `${String(h).padStart(2,'0')}:${String(mn).padStart(2,'0')}:${String(sec).padStart(2,'0')}:${String(f).padStart(2,'0')}`;
    };

    // ── Minimal STORE-compression ZIP builder ─────────────────────────────
    function buildZip(files) {
      const enc = new TextEncoder();
      const T = new Uint32Array(256);
      for (let i=0;i<256;i++){let c=i;for(let j=0;j<8;j++)c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);T[i]=c;}
      const crc32 = b => { let c=0xFFFFFFFF; for(let i=0;i<b.length;i++) c=T[(c^b[i])&0xFF]^(c>>>8); return(c^0xFFFFFFFF)>>>0; };
      const u16 = v => new Uint8Array([v&255,(v>>8)&255]);
      const u32 = v => new Uint8Array([v&255,(v>>8)&255,(v>>16)&255,(v>>24)&255]);
      const cat = (...a) => { let n=0; for(const x of a) n+=x.length; const o=new Uint8Array(n); let p=0; for(const x of a){o.set(x,p);p+=x.length;} return o; };
      const locs=[], cds=[];
      let off = 0;
      for (const {n, d} of files) {
        const nb = enc.encode(n);
        const db = d instanceof Uint8Array ? d : enc.encode(d);
        const c = crc32(db), s = db.length;
        const loc = cat(new Uint8Array([0x50,0x4B,0x03,0x04]),u16(20),u16(0),u16(0),u16(0),u16(0),u32(c),u32(s),u32(s),u16(nb.length),u16(0),nb,db);
        locs.push(loc);
        cds.push(cat(new Uint8Array([0x50,0x4B,0x01,0x02]),u16(20),u16(20),u16(0),u16(0),u16(0),u16(0),u32(c),u32(s),u32(s),u16(nb.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(off),nb));
        off += loc.length;
      }
      const cd = cat(...cds);
      return cat(...locs, cd, cat(new Uint8Array([0x50,0x4B,0x05,0x06]),u16(0),u16(0),u16(files.length),u16(files.length),u32(cd.length),u32(off),u16(0)));
    }

    // ── XLSX cell / address helpers ───────────────────────────────────────
    const xe    = s => String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const col2l = i => { let s=''; do { s=String.fromCharCode(65+(i%26))+s; i=Math.floor(i/26)-1; } while(i>=0); return s; };
    const addr  = (c,r) => `${col2l(c)}${r}`;
    // s=string cell  n=number cell  (r=1-based row, c=0-based col, si=style index)
    const sc = (r,c,si,v) => v==null||v==='' ? `<c r="${addr(c,r)}" s="${si}"/>` : `<c r="${addr(c,r)}" s="${si}" t="inlineStr"><is><t>${xe(String(v))}</t></is></c>`;
    const nc = (r,c,si,v) => `<c r="${addr(c,r)}" s="${si}"><v>${Number(v)}</v></c>`;

    // Style index map:  0=default 1=hdr 2=NEW 3=EXT 4=CHG 5=TRM 6=REM 7=riskH 8=riskM 9=riskL 10=numR
    const TXF = { NEW:2, EXTENDED:3, CHANGED:4, TRIMMED:5, REMOVED:6, UNCHANGED:0 };
    const RXF = { high:7, med:8, low:9 };

    // ── styles.xml ────────────────────────────────────────────────────────
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <fonts count="3">
  <font><sz val="11"/><name val="Calibri"/></font>
  <font><sz val="10"/><b/><name val="Calibri"/></font>
  <font><sz val="10"/><b/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
 </fonts>
 <fills count="9">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFDBEAFE"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFD1FAE5"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFEDE9FE"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/></patternFill></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FF1E293B"/></patternFill></fill>
 </fills>
 <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
 <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
 <cellXfs count="11">
  <xf numFmtId="0" fontId="0" fillId="7" borderId="0" xfId="0"/>
  <xf numFmtId="0" fontId="2" fillId="8" borderId="0" xfId="0"><alignment horizontal="center" vertical="center"/></xf>
  <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0"><alignment vertical="center"/></xf>
  <xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0"><alignment vertical="center"/></xf>
  <xf numFmtId="0" fontId="1" fillId="4" borderId="0" xfId="0"><alignment vertical="center"/></xf>
  <xf numFmtId="0" fontId="1" fillId="5" borderId="0" xfId="0"><alignment vertical="center"/></xf>
  <xf numFmtId="0" fontId="1" fillId="6" borderId="0" xfId="0"><alignment vertical="center"/></xf>
  <xf numFmtId="0" fontId="1" fillId="6" borderId="0" xfId="0"><alignment vertical="center"/></xf>
  <xf numFmtId="0" fontId="1" fillId="4" borderId="0" xfId="0"><alignment vertical="center"/></xf>
  <xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0"><alignment vertical="center"/></xf>
  <xf numFmtId="0" fontId="0" fillId="7" borderId="0" xfId="0"><alignment horizontal="right" vertical="center"/></xf>
 </cellXfs>
 <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

    // ── Sheet 1: Change List ──────────────────────────────────────────────
    const CL_HDR = ['#','Type','Risk','Thumb','Reel','Clip Name','SrcIn','SrcOut','RecIn','RecOut','Dur(fr)','Match%','Status','Note'];
    const CL_W   = [5,10,8,18,12,24,11,11,11,11,8,8,10,30];
    const clCols = CL_W.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('');
    const clHdr  = `<row r="1" ht="20" customHeight="1">${CL_HDR.map((h,c)=>sc(1,c,1,h)).join('')}</row>`;
    const clRows = changeEvs.map((ev,i) => {
      const r = i+2, key = _diffKey(ev);
      const stat = _s.statusMap.get(key)||'', note = _s.noteMap.get(key)||'';
      const score = ev.matchScore!=null ? Math.round(ev.matchScore*100) : '';
      const risk = _riskOf(ev), dur = Number(ev.durationFrames||ev._lenFrames||0);
      const txf = TXF[ev.diffType||'UNCHANGED'], rxf = RXF[risk];
      return `<row r="${r}" ht="58" customHeight="1">`+
        nc(r,0,0,i+1)+sc(r,1,txf,ev.diffType||'')+sc(r,2,rxf,risk.toUpperCase())+
        `<c r="${addr(3,r)}" s="0"/>`+
        sc(r,4,0,ev.reel||'')+sc(r,5,0,ev.clipName||'')+
        sc(r,6,0,ev.srcIn||'')+sc(r,7,0,ev.srcOut||'')+
        sc(r,8,0,ev.recIn||'')+sc(r,9,0,ev.recOut||'')+
        (dur?nc(r,10,10,dur):sc(r,10,0,''))+(score!==''?nc(r,11,10,score):sc(r,11,0,''))+
        sc(r,12,0,stat)+sc(r,13,0,note)+`</row>`;
    }).join('');
    const hasImgs = _imgBytes.length > 0;
    const sheet1Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <sheetFormatPr defaultRowHeight="15"/>
 <cols>${clCols}</cols>
 <sheetData>${clHdr}${clRows}</sheetData>${hasImgs?'\n <drawing r:id="rId1"/>':''}
</worksheet>`;

    const sheet1RelsXml = !hasImgs ? null : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/>
</Relationships>`;

    // ── Drawing 1: TwoCellAnchor per thumbnail ────────────────────────────
    const anchors = changeEvs.map((ev,i) => {
      const imgIdx = chImgIdxs[i];
      if (imgIdx < 0) return '';
      const dr = i+1; // drawing row is 0-based; row 0=header, data starts at 1
      return `<xdr:twoCellAnchor editAs="oneCell">` +
        `<xdr:from><xdr:col>3</xdr:col><xdr:colOff>76200</xdr:colOff><xdr:row>${dr}</xdr:row><xdr:rowOff>76200</xdr:rowOff></xdr:from>` +
        `<xdr:to><xdr:col>4</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${dr+1}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>` +
        `<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i+2}" name="Img${i+1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>` +
        `<xdr:blipFill><a:blip r:embed="rId${imgIdx+1}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>` +
        `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1066800" cy="609600"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>` +
        `</xdr:pic><xdr:clientData/></xdr:twoCellAnchor>`;
    }).filter(Boolean).join('\n');

    const drawing1Xml = !hasImgs ? null : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
${anchors}
</xdr:wsDr>`;

    const drawing1RelsXml = !hasImgs ? null : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${_imgBytes.map((_,i)=>`<Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${i+1}.jpg"/>`).join('\n')}
</Relationships>`;

    // ── Sheet 2: Audio Ref ────────────────────────────────────────────────
    const AR_HDR = ['#','Type','Risk','Clip Name','Reel','RecIn','RecOut','Dur(fr)','Audio?','Status','Note'];
    const AR_W   = [5,10,8,24,12,11,11,8,6,10,30];
    const arCols = AR_W.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('');
    const arHdr  = `<row r="1" ht="20" customHeight="1">${AR_HDR.map((h,c)=>sc(1,c,1,h)).join('')}</row>`;
    const arRows = audioList.map((ev,i) => {
      const r = i+2, key = _diffKey(ev);
      const stat = _s.statusMap.get(key)||'', note = _s.noteMap.get(key)||'';
      const dur = Number(ev.durationFrames||ev._lenFrames||0);
      const txf = TXF[ev.diffType||'UNCHANGED'], rxf = RXF[_riskOf(ev)];
      return `<row r="${r}" ht="16">`+
        nc(r,0,0,i+1)+sc(r,1,txf,ev.diffType||'')+sc(r,2,rxf,_riskOf(ev).toUpperCase())+
        sc(r,3,0,ev.clipName||'')+sc(r,4,0,ev.reel||'')+
        sc(r,5,0,ev.recIn||'')+sc(r,6,0,ev.recOut||'')+
        (dur?nc(r,7,10,dur):sc(r,7,0,''))+sc(r,8,txf,isAudio(ev)?'Y':'')+
        sc(r,9,0,stat)+sc(r,10,0,note)+`</row>`;
    }).join('');
    const sheet2Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <sheetFormatPr defaultRowHeight="15"/><cols>${arCols}</cols>
 <sheetData>${arHdr}${arRows}</sheetData>
</worksheet>`;

    // ── Sheet 3: Removed Clips ────────────────────────────────────────────
    const RM_HDR = ['#','Clip Name','Reel','SrcIn','SrcOut','RecIn','RecOut','Dur(fr)'];
    const RM_W   = [5,24,12,11,11,11,11,8];
    const rmCols = RM_W.map((w,i)=>`<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('');
    const rmHdr  = `<row r="1" ht="20" customHeight="1">${RM_HDR.map((h,c)=>sc(1,c,1,h)).join('')}</row>`;
    const rmRows = removed.map((ev,i) => {
      const r = i+2, dur = Number(ev.durationFrames||ev._lenFrames||0);
      return `<row r="${r}" ht="16">`+
        nc(r,0,0,i+1)+sc(r,1,TXF.REMOVED,ev.clipName||'')+sc(r,2,0,ev.reel||'')+
        sc(r,3,0,ev.srcIn||'')+sc(r,4,0,ev.srcOut||'')+
        sc(r,5,0,ev.recIn||'')+sc(r,6,0,ev.recOut||'')+
        (dur?nc(r,7,10,dur):sc(r,7,0,''))+`</row>`;
    }).join('');
    const sheet3Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <sheetFormatPr defaultRowHeight="15"/><cols>${rmCols}</cols>
 <sheetData>${rmHdr}${rmRows}</sheetData>
</worksheet>`;

    // ── Sheet 4: Summary ──────────────────────────────────────────────────
    const sumPairs = [
      [stem,''],['OLD',_s.oldName||'—'],['NEW',_s.newName||'—'],['Date',ymdH],['',''],
      ['NEW',cnt.NEW],['EXTENDED',cnt.EXTENDED],['CHANGED',cnt.CHANGED],['TRIMMED',cnt.TRIMMED],
      ['REMOVED',removed.length],['AUDIO REFS',audioList.length],['+Duration',frTc(addFr)],['−Duration',frTc(remFr)],
    ];
    const smRows = sumPairs.map((p,i) => {
      const r=i+2;
      if (!p[0]) return `<row r="${r}" ht="8"/>`;
      const si = TXF[p[0]] ?? 0;
      return `<row r="${r}" ht="16">${sc(r,0,si||0,p[0])}${typeof p[1]==='number'?nc(r,1,10,p[1]):sc(r,1,0,p[1]??'')}</row>`;
    }).join('');
    const sheet4Xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
 <sheetFormatPr defaultRowHeight="15"/>
 <cols><col min="1" max="1" width="18" customWidth="1"/><col min="2" max="2" width="30" customWidth="1"/></cols>
 <sheetData><row r="1" ht="24">${sc(1,0,1,'CUT CHANGE LIST')}</row>${smRows}</sheetData>
</worksheet>`;

    // ── Workbook + relationships ───────────────────────────────────────────
    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
 <sheets>
  <sheet name="Change List" sheetId="1" r:id="rId1"/>
  <sheet name="Audio Ref"   sheetId="2" r:id="rId2"/>
  <sheet name="Removed"     sheetId="3" r:id="rId3"/>
  <sheet name="Summary"     sheetId="4" r:id="rId4"/>
 </sheets>
</workbook>`;

    const wbRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
 <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
 <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
 <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet4.xml"/>
 <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

    const rootRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

    const mediaOvr = _imgBytes.map((_,i)=>`  <Override PartName="/xl/media/image${i+1}.jpg" ContentType="image/jpeg"/>`).join('\n');
    const ctXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="xml" ContentType="application/xml"/>
 <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
 <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
 <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
 <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
 <Override PartName="/xl/worksheets/sheet4.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
 <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${hasImgs?`
 <Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`:``}
${mediaOvr}
</Types>`;

    // ── Assemble ZIP ──────────────────────────────────────────────────────
    const files = [
      { n:'[Content_Types].xml',               d: ctXml },
      { n:'_rels/.rels',                        d: rootRelsXml },
      { n:'xl/workbook.xml',                    d: workbookXml },
      { n:'xl/_rels/workbook.xml.rels',          d: wbRelsXml },
      { n:'xl/styles.xml',                      d: stylesXml },
      { n:'xl/worksheets/sheet1.xml',           d: sheet1Xml },
      { n:'xl/worksheets/sheet2.xml',           d: sheet2Xml },
      { n:'xl/worksheets/sheet3.xml',           d: sheet3Xml },
      { n:'xl/worksheets/sheet4.xml',           d: sheet4Xml },
      ...(hasImgs ? [
        { n:'xl/worksheets/_rels/sheet1.xml.rels', d: sheet1RelsXml },
        { n:'xl/drawings/drawing1.xml',            d: drawing1Xml },
        { n:'xl/drawings/_rels/drawing1.xml.rels', d: drawing1RelsXml },
        ..._imgBytes.map((bytes,i) => ({ n:`xl/media/image${i+1}.jpg`, d: bytes })),
      ] : []),
    ];

    const zipBytes = buildZip(files);
    const blob  = new Blob([zipBytes], { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const fname = `${stem}_ChangeList_${ymd}.xlsx`;
    if (typeof window.__pfxSaveBlob === 'function') {
      await window.__pfxSaveBlob(fname, blob);
    } else {
      const url = URL.createObjectURL(blob);
      const a = Object.assign(document.createElement('a'), { href: url, download: fname });
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }

  function _csvCell(v) {
    if (!v) return '';
    const s = String(v);
    return s.includes(',') ? `"${s.replace(/"/g,'""')}"` : s;
  }

  function _persistStatus() {
    try {
      const status = {}, notes = {};
      _s.statusMap.forEach((v, k) => { status[k] = v; });
      _s.noteMap.forEach((v, k) => { notes[k] = v; });
      localStorage.setItem('pfx.cutdiff2.status.v2', JSON.stringify({ status, notes }));
    } catch {}
  }

  function _loadPersistedStatus() {
    try {
      // Try v2 (status + notes) first, fall back to v1 (status only)
      const raw2 = localStorage.getItem('pfx.cutdiff2.status.v2');
      if (raw2) {
        const { status = {}, notes = {} } = JSON.parse(raw2);
        Object.entries(status).forEach(([k, v]) => _s.statusMap.set(k, v));
        Object.entries(notes).forEach(([k, v]) => _s.noteMap.set(k, v));
        return;
      }
      const raw1 = localStorage.getItem('pfx.cutdiff2.status.v1');
      if (raw1) Object.entries(JSON.parse(raw1)).forEach(([k, v]) => _s.statusMap.set(k, v));
    } catch {}
  }

  function _vcIdbOpen() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(_VC_IDB_NAME, 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore(_VC_IDB_STORE);
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
  }

  // ── Thumbnail IDB helpers ──────────────────────────────────────────────────

  function _thumbIdbOpen() {
    return new Promise((res, rej) => {
      const req = indexedDB.open(_THUMB_IDB_NAME, 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore(_THUMB_IDB_STORE);
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
  }

  // Pre-load all cached JPEG blobs for a video into _thumbCache as ImageBitmaps.
  // Returns the number of cache hits loaded.
  async function _thumbIdbPreload(which, videoName, videoSize) {
    try {
      const db     = await _thumbIdbOpen();
      const prefix = `${videoName}|${videoSize}|`;
      const hits   = await new Promise((res, rej) => {
        const results = [];
        const req = db.transaction(_THUMB_IDB_STORE, 'readonly')
                      .objectStore(_THUMB_IDB_STORE).openCursor();
        req.onsuccess = e => {
          const cursor = e.target.result;
          if (!cursor) { db.close(); res(results); return; }
          if (String(cursor.key).startsWith(prefix)) results.push({ key: String(cursor.key), blob: cursor.value });
          cursor.continue();
        };
        req.onerror = () => { db.close(); rej(req.error); };
      });
      for (const { key, blob } of hits) {
        const recIn    = key.slice(prefix.length);
        const cacheKey = `${which}:${recIn}`;
        if (!_thumbCache.has(cacheKey)) {
          try {
            const bmp = await createImageBitmap(blob);
            _thumbCache.set(cacheKey, bmp);
          } catch {}
        }
      }
      return hits.length;
    } catch(e) { console.warn('[CD2-THUMBS] IDB preload failed', e); return 0; }
  }

  // Persist a single thumbnail to IDB (fire-and-forget — never throws).
  async function _thumbIdbPut(videoName, videoSize, recIn, bitmap) {
    try {
      const c = document.createElement('canvas');
      c.width  = bitmap.width;
      c.height = bitmap.height;
      c.getContext('2d').drawImage(bitmap, 0, 0);
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.72));
      if (!blob) return;
      const db = await _thumbIdbOpen();
      const tx = db.transaction(_THUMB_IDB_STORE, 'readwrite');
      tx.objectStore(_THUMB_IDB_STORE).put(blob, `${videoName}|${videoSize}|${recIn}`);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      db.close();
    } catch { /* best-effort */ }
  }

  async function _vcSaveHandle(which, handle) {
    try {
      const db = await _vcIdbOpen();
      const tx = db.transaction(_VC_IDB_STORE, 'readwrite');
      tx.objectStore(_VC_IDB_STORE).put(handle, which);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      db.close();
      console.info(`[CD2-MEDIA] handle saved → IDB key="${which}" name="${handle?.name}"`);
    } catch(e) { console.warn(`[CD2-MEDIA] _vcSaveHandle(${which}) FAILED`, e); }
  }

  async function _vcLoadHandle(which) {
    try {
      const db = await _vcIdbOpen();
      const handle = await new Promise((res, rej) => {
        const req = db.transaction(_VC_IDB_STORE, 'readonly')
                      .objectStore(_VC_IDB_STORE).get(which);
        req.onsuccess = () => { db.close(); res(req.result || null); };
        req.onerror   = () => { db.close(); rej(req.error); };
      });
      console.info(`[CD2-MEDIA] _vcLoadHandle(${which}) → ${handle ? `found name="${handle.name}"` : 'null (not in IDB)'}`);
      return handle;
    } catch(e) { console.warn(`[CD2-MEDIA] _vcLoadHandle(${which}) IDB error`, e); return null; }
  }

  // Silent restore — attempts getFile() directly without any permission prompt.
  // Works when the FileSystemFileHandle permission is already active (same browser session).
  // On a new browser session getFile() throws NotAllowedError → canvas shows re-auth prompt.
  async function _vcRestoreSilent() {
    console.info(`[CD2-MEDIA] _vcRestoreSilent() old="${_vc.oldName}" new="${_vc.newName}"`);
    let loaded = false;
    for (const which of ['old', 'new']) {
      const savedName     = which === 'old' ? _vc.oldName : _vc.newName;
      const alreadyLoaded = which === 'old' ? !!_vc.oldUrl : !!_vc.newUrl;
      if (!savedName || alreadyLoaded) continue;
      const myGen = ++_vcLoadGen[which];
      try {
        const handle = await _vcLoadHandle(which);
        if (!handle) continue;
        // Skip queryPermission (throws in some Chrome extension contexts).
        // getFile() works silently if permission is active; throws if not.
        const file = await handle.getFile();
        console.info(`[CD2-MEDIA] _vcRestoreSilent: silent getFile() OK for ${which}`);
        if (_vcLoadGen[which] > myGen) continue; // a fresher browse/restore already won this side
        _vcLoadGen[which] = myGen;
        _vcLoad(which, file);
        loaded = true;
      } catch(e) {
        console.info(`[CD2-MEDIA] _vcRestoreSilent: ${which} getFile() failed (need user gesture) — ${e?.name}`);
      }
    }
    // Only re-render if we actually loaded something new (avoids redundant paint
    // when caller already called _vcRender() right before invoking us).
    if (loaded) _vcRender();
  }

  // Full restore — calls requestPermission() if needed.
  // MUST be called from a real user gesture (button/canvas click) so the browser will
  // show its "allow file access?" prompt.
  async function _vcRestoreFromIDB() {
    if (_vcRestoring) { console.info('[CD2-MEDIA] _vcRestoreFromIDB: already restoring, skip'); return; }
    console.info(`[CD2-MEDIA] _vcRestoreFromIDB() old="${_vc.oldName}" new="${_vc.newName}"`);
    _vcRestoring = true;
    try {
      for (const which of ['old', 'new']) {
        const savedName     = which === 'old' ? _vc.oldName : _vc.newName;
        const alreadyLoaded = which === 'old' ? !!_vc.oldUrl : !!_vc.newUrl;
        if (!savedName || alreadyLoaded) continue;
        const myGen = ++_vcLoadGen[which];
        try {
          const handle = await _vcLoadHandle(which);
          if (!handle) { console.warn(`[CD2-MEDIA] ${which}: no handle in IDB — user must browse manually`); continue; }
          // Try getFile() directly first (works if permission already active)
          let file = null;
          try { file = await handle.getFile(); console.info(`[CD2-MEDIA] ${which}: getFile() direct OK`); } catch(e) { console.info(`[CD2-MEDIA] ${which}: getFile() needs permission — ${e?.name}`); }
          if (!file && typeof handle.requestPermission === 'function') {
            const perm = await handle.requestPermission({ mode: 'read' });
            console.info(`[CD2-MEDIA] ${which}: requestPermission → ${perm}`);
            if (perm === 'granted') file = await handle.getFile();
          }
          if (file) {
            if (_vcLoadGen[which] > myGen) { console.info(`[CD2-MEDIA] ${which}: superseded by a fresher browse/restore, discarding`); continue; }
            _vcLoadGen[which] = myGen;
            console.info(`[CD2-MEDIA] ${which}: loading file "${file.name}"`);
            _vcLoad(which, file);
          }
          else { console.warn(`[CD2-MEDIA] ${which}: could not get file — permission denied?`); }
        } catch(e) { console.warn(`[CD2-MEDIA] ${which}: restore error`, e); }
      }
    } finally {
      _vcRestoring = false;
    }
  }

  // ── Snapshot serialisation / restore ──────────────────────────────────────
  function getSnapshot() {
    if (!_s.analyzed && !_s.oldName && !_s.newName) return null;
    const status = {}, notes = {};
    _s.statusMap.forEach((v, k) => { status[k] = v; });
    _s.noteMap.forEach((v, k) => { notes[k] = v; });
    return {
      v: 2,
      oldName:    _s.oldName,
      newName:    _s.newName,
      fps:        _s.fps,
      analyzed:   _s.analyzed,
      oldEvents:  _s.oldEvents,
      newEvents:  _s.newEvents,
      diff:       _s.diff,
      filterType: _s.filterType,
      filterRisk: _s.filterRisk,
      status,
      notes,
      vcOldName:  _vc.oldName,  // video file names (for IDB re-link on restore)
      vcNewName:  _vc.newName,
    };
  }

  function applySnapshot(snap) {
    if (!snap || snap.v !== 2) return;

    // Restore state
    _s.oldName    = snap.oldName    || '';
    _s.newName    = snap.newName    || '';
    _s.fps        = snap.fps        || 24;
    _s.analyzed   = !!snap.analyzed;
    _s.oldEvents  = snap.oldEvents  || [];
    _s.newEvents  = snap.newEvents  || [];
    _s.diff       = snap.diff       || [];
    _s.filterType = snap.filterType || 'ALL';
    _s.filterRisk = snap.filterRisk || 'all';
    _s.selectedIdx = -1;
    _s.statusMap.clear();
    _s.noteMap.clear();
    if (snap.status) Object.entries(snap.status).forEach(([k, v]) => _s.statusMap.set(k, v));
    if (snap.notes)  Object.entries(snap.notes).forEach(([k, v])  => _s.noteMap.set(k, v));

    // DOM not ready yet — bail; mount() will call _loadPersistedStatus anyway
    if (!_dom.pane) return;

    // Restore header slot labels + loaded state
    const OLD_HINT = 'Drop OLD timeline (EDL / FCPXML)';
    const NEW_HINT = 'Drop NEW timeline (EDL / FCPXML)';
    if (_dom.oldLabel) _dom.oldLabel.textContent = _s.oldName || OLD_HINT;
    if (_dom.newLabel) _dom.newLabel.textContent = _s.newName || NEW_HINT;
    _dom.oldDrop?.classList.toggle('cd2x-drop-loaded', !!_s.oldName);
    _dom.newDrop?.classList.toggle('cd2x-drop-loaded', !!_s.newName);

    // Restore video names in VC panel (shown while re-linking)
    _vc.oldName = snap.vcOldName || '';
    _vc.newName = snap.vcNewName || '';
    const vcv = _dom.vc;
    if (vcv?.oldName) vcv.oldName.textContent = _vc.oldName || '—';
    if (vcv?.newName) vcv.newName.textContent = _vc.newName || '—';
    // Update Import button labels to "Restore" so user knows clicking will re-link
    if (vcv?.oldBrowse && _vc.oldName) vcv.oldBrowse.textContent = 'Restore';
    if (vcv?.newBrowse && _vc.newName) vcv.newBrowse.textContent = 'Restore';

    // Sync filter buttons
    _dom.filterBtns?.forEach(b =>
      b.classList.toggle('cd2x-filter-active', (b.dataset.type || 'ALL') === _s.filterType)
    );
    _dom.riskBtns?.forEach(b =>
      b.classList.toggle('cd2x-risk-active', (b.dataset.risk || 'all') === _s.filterRisk)
    );

    // Re-render diff table + timeline
    _renderKpi();
    _renderTable();
    _schedTlRedraw();
    _closeInspector?.();

    // Try silent video restore first (works if handle permission already active this session).
    _vcRender();
    _vcRestoreSilent();

    // Auto-relink on first user interaction: register a one-shot capture-phase listener
    // so the very first click/keydown anywhere in the page acts as the user gesture needed
    // for requestPermission(). Removed immediately after firing.
    // Remove any previous listener first (guard against multiple applySnapshot() calls).
    if (_autoRelinkFn) {
      document.removeEventListener('click',   _autoRelinkFn, true);
      document.removeEventListener('keydown', _autoRelinkFn, true);
      _autoRelinkFn = null;
    }
    if (_vc.oldName || _vc.newName) {
      console.info(`[CD2-MEDIA] auto-relink listener registered — waiting for first user gesture`);
      _autoRelinkFn = () => {
        document.removeEventListener('click',   _autoRelinkFn, true);
        document.removeEventListener('keydown', _autoRelinkFn, true);
        _autoRelinkFn = null;
        console.info(`[CD2-MEDIA] auto-relink fired — oldUrl=${!!_vc.oldUrl} newUrl=${!!_vc.newUrl}`);
        if ((_vc.oldName && !_vc.oldUrl) || (_vc.newName && !_vc.newUrl)) {
          _vcRestoreFromIDB();
        }
      };
      document.addEventListener('click',   _autoRelinkFn, true);
      document.addEventListener('keydown', _autoRelinkFn, true);
    }
  }
}
